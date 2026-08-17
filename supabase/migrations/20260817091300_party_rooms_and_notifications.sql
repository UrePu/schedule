-- =============================================================================
-- M_Schedule · 13. 파티 ↔ 카톡방 바인딩 + 알림 라우팅
-- =============================================================================
-- 발주자 원문:
--   "알리미를 생각하면 보스 파티의 생성자도 필요할 거 같음. 그 사람이 존재하는 카톡방
--    (카톡방에서 `!보스등록 더저` 하면 등록되고 그 사람에게 알림 가도록).
--    그럼 생성자 = 카톡 등록된 사람일 때 그 카톡방에다가
--    `19시 1파티 보스 (파티원1, 2 3 4)` 이런 식으로 알림 가게 할 것임"
--
-- ── 핵심 결정: 알림은 **사람**이 아니라 **파티에 바인딩된 방**을 따라간다 ───────
-- 발주자는 "생성자가 존재하는 카톡방"이라고 했지만, 사람 기준으로 라우팅하면
-- **한 사람이 여러 방에 있을 때 전 방에 도배된다.** 생성자는 "누가 만들었나"를 기록할 뿐이고,
-- 알림의 목적지는 그 파티가 태어난(또는 사용자가 고른) **방 하나**다. (CLAUDE.md §2.3)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 13-1. 파티 ↔ 방 바인딩
-- -----------------------------------------------------------------------------
-- **1:1 (nullable FK)** 로 둔다.
--   * 방에서 `!보스등록` 으로 만든 파티 → 그 방에 바인딩
--   * 웹에서 만든 파티 → 사용자가 자기가 연결된 방 중 하나를 고르거나, **아무 방도 아님**(푸시 없음)
--   * null 이 정상 상태다. 웹 전용 파티는 알림을 보내지 않는다.
--
-- ── 한 파티가 여러 방에 보내야 할 수도 있는가? ──────────────────────────────
-- 지금은 아니다. 같은 파티 공지가 두 방에 뜨면 참가 응답이 갈라지고, 어느 방에서 온 `!등록`인지
-- 추적해야 하는 문제가 새로 생긴다. **기본 1:1 로 확정한다.**
-- 다만 확장 비용을 0으로 만들어 둔다: 호출부는 절대 `parties.bot_channel_id` 를 직접 읽지 않고
-- **`party_notify_channel_ids(party_id)` 함수**(0..N 행 반환)를 통해서만 목적지를 얻는다.
-- 나중에 다중 방이 필요해지면 링크 테이블을 만들고 이 함수 하나만 고치면 되며,
-- 알림 적재 로직·서버 코드는 한 줄도 바뀌지 않는다.
alter table public.parties
  add column if not exists bot_channel_id uuid
    references public.bot_channels(id) on delete set null;

comment on column public.parties.bot_channel_id is
  '알림이 갈 카톡방. null = 웹 전용 파티(푸시 없음). **어느 방인지는 사적 정보라 공개 시간표에 절대 노출하지 않는다.**';

-- 방별 파티 목록 조회 (봇이 `!일정` 처리할 때)
create index if not exists parties_channel_idx
  on public.parties (bot_channel_id) where bot_channel_id is not null;

-- 목적지 해석의 유일한 진입점. 오늘은 0..1행, 나중에 다중 방이면 여기만 고친다.
create or replace function public.party_notify_channel_ids(p_party_id uuid)
returns setof uuid
language sql
stable
parallel safe
as $func$
  select p.bot_channel_id
  from public.parties p
  where p.id = p_party_id
    and p.bot_channel_id is not null;
$func$;

comment on function public.party_notify_channel_ids(uuid) is
  '파티 알림 목적지 채널 목록(현재 0..1행). 다중 방 확장 시 이 함수만 교체하면 호출부는 그대로다.';

-- -----------------------------------------------------------------------------
-- 13-2. 생성자 — 이미 있는 것으로 충분하다
-- -----------------------------------------------------------------------------
-- `parties.owner_user_id`      : **파티 생성자.** 알림 책임자이자 파티 설정의 주인.
--                                `not null references app_users` 이므로 **게스트는 파티를 만들 수 없다.**
-- `party_runs.created_by_participant_id` : 그 **일정 항목**을 만든 사람(참가자 단위, 게스트 가능).
--                                파티는 우레푸가 만들었지만 이번 주 하드 스우 런은 라이언이 잡을 수 있다.
-- 두 컬럼은 역할이 다르며 둘 다 필요하다. 새로 만들 것이 없다.
--
-- ★ 게스트는 파티를 만들 수 없다 — 이미 스키마가 강제하고 있고, 그게 옳다.
--   방에서 `!연결` 없이 `!보스등록` 을 치면 알림 대상(어느 계정에게?)과 분배 주체(누가 owner?)가
--   불명확해진다. 봇은 research-KAKAO-BOT §2.4 의 🔒 안내를 돌려주고 연결을 요구해야 한다.

-- -----------------------------------------------------------------------------
-- 13-3. 파티 번호 — 방 + 주차 범위
-- -----------------------------------------------------------------------------
-- 평문 한 줄에서 파티를 가리키려면 번호가 필요하다. `19시 **1파티** 스우 (...)`.
--
-- **범위를 (방, 주차)로 잡은 이유**: `parties` 는 여러 주에 걸쳐 지속되는 사람 묶음이라
-- 파티 테이블의 컬럼 하나로는 "이번 주 1파티"를 표현할 수 없다. 그래서 별도 테이블이다.
-- 방마다 매주 1번부터 다시 시작하므로 번호가 무한정 커지지 않고, 활동을 멈춘 파티가
-- 번호를 영구 점유하지도 않는다.
--
-- ★ seat_no 와 같은 규칙: **한 주 안에서 번호는 재배열하지 않는다.**
--   2파티가 취소돼도 3파티가 2파티가 되지 않는다. 방에서 진행 중이던 대화가 어긋나기 때문이다.
--   빈 번호는 그 주 내내 비워 둔다.
create table if not exists public.party_room_numbers (
  id          uuid primary key default gen_random_uuid(),
  channel_id  uuid not null references public.bot_channels(id) on delete cascade,
  week_key    text not null check (week_key ~ '^[0-9]{4}-W[0-9]{2}$'),
  party_id    uuid not null references public.parties(id) on delete cascade,

  party_no    smallint not null check (party_no >= 1),
  assigned_at timestamptz not null default now(),

  constraint party_room_numbers_no_uniq    unique (channel_id, week_key, party_no),
  constraint party_room_numbers_party_uniq unique (channel_id, week_key, party_id)
);

comment on table public.party_room_numbers is
  '방 × 주차 범위의 파티 번호(1파티, 2파티). 한 주 안에서 재배열하지 않으며 빈 번호를 재사용하지 않는다.';

create index if not exists party_room_numbers_party_idx
  on public.party_room_numbers (party_id, week_key);

-- 번호 부여. 이미 있으면 그대로 돌려준다(멱등).
--
-- **주 사이 안정성**: 지난주에 쓰던 번호가 이번 주에 비어 있으면 **그 번호를 다시 준다.**
-- 그래야 "1파티는 계속 1파티"라는 방 사람들의 기대가 유지된다. 비어 있지 않으면 max+1.
--
-- **경쟁 조건**: seat_no 와 같은 이유로 (방, 주차) 단위 advisory lock 으로 직렬화하고,
-- unique 제약을 backstop 으로 둔다.
create or replace function public.assign_party_number(
  p_party_id uuid,
  p_week_key text
)
returns smallint
language plpgsql
as $func$
declare
  v_channel uuid;
  v_no      smallint;
  v_prev    smallint;
begin
  select p.bot_channel_id into v_channel
    from public.parties p where p.id = p_party_id;

  -- 방에 바인딩되지 않은 파티(웹 전용)는 번호가 없다. 정상이다.
  if v_channel is null then
    return null;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('party_no:' || v_channel::text || ':' || p_week_key, 0)
  );

  select party_no into v_no
    from public.party_room_numbers
   where channel_id = v_channel and week_key = p_week_key and party_id = p_party_id;
  if found then
    return v_no;
  end if;

  -- 지난 주차들에서 이 파티가 쓰던 가장 최근 번호
  select n.party_no into v_prev
    from public.party_room_numbers n
   where n.channel_id = v_channel
     and n.party_id = p_party_id
     and n.week_key < p_week_key
   order by n.week_key desc
   limit 1;

  if v_prev is not null and not exists (
       select 1 from public.party_room_numbers
        where channel_id = v_channel and week_key = p_week_key and party_no = v_prev
     ) then
    v_no := v_prev;
  else
    select coalesce(max(party_no), 0) + 1 into v_no
      from public.party_room_numbers
     where channel_id = v_channel and week_key = p_week_key;
  end if;

  insert into public.party_room_numbers (channel_id, week_key, party_id, party_no)
  values (v_channel, p_week_key, p_party_id, v_no);

  return v_no;
end;
$func$;

comment on function public.assign_party_number(uuid, text) is
  '방×주차 파티 번호를 멱등하게 부여한다. 지난주 번호가 비어 있으면 재사용해 "1파티는 계속 1파티"를 유지한다.';

-- 런이 생기면 그 주차의 파티 번호를 확보해 둔다(알림 문구가 바로 번호를 쓸 수 있게).
create or replace function public.party_runs_ensure_party_number()
returns trigger
language plpgsql
as $func$
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  perform public.assign_party_number(new.party_id, new.week_key);
  return null;
end;
$func$;

drop trigger if exists party_runs_ensure_party_number on public.party_runs;
create trigger party_runs_ensure_party_number
  after insert or update of party_id, scheduled_at on public.party_runs
  for each row execute function public.party_runs_ensure_party_number();

-- -----------------------------------------------------------------------------
-- 13-4. 알림 문구 생성 — DB 단일 구현
-- -----------------------------------------------------------------------------
-- distribute_meso / resolve_availability 와 같은 이유로 DB 에 둔다:
-- **웹 미리보기와 봇 실제 발송이 갈라지면 안 된다.**
--
-- 카카오톡 평문 제약(research-KAKAO-BOT §1.4):
--   마크다운·HTML 금지 / **가변폭 폰트라 공백 정렬 금지** / 350자 예산 / 이모지 절제(줄당 1~2개)

-- KST 시각 표기. 같은 날이면 '19시', 다른 날이면 '8/20(목) 19시'.
create or replace function public.format_kst_when(p_at timestamptz, p_ref timestamptz)
returns text
language sql
immutable
parallel safe
as $func$
  with v as (
    select public.kst_date(p_at) as d,
           (floor((extract(epoch from (p_at - to_timestamp(0))) + 32400) / 60)::bigint % 1440) as mod
  )
  select case
           when p_ref is not null and v.d = public.kst_date(p_ref) then ''
           else extract(month from v.d)::int::text || '/'
             || extract(day   from v.d)::int::text || '('
             || (array['월','화','수','목','금','토','일'])[extract(isodow from v.d)::int] || ') '
         end
      || (v.mod / 60)::int::text || '시'
      || case when (v.mod % 60) <> 0 then (v.mod % 60)::int::text || '분' else '' end
  from v;
$func$;

comment on function public.format_kst_when(timestamptz, timestamptz) is
  'KST 시각 표기. 기준일과 같은 날이면 시각만, 다르면 날짜(요일)까지 붙인다.';

-- 알림 문구. 발주자 예시 형태: `19시 1파티 스우 (우레푸, 라이언, 어피치, 프로도)`
--   p_kind = 'plain'   → 그 줄만
--            'created' → 📌 + 그 줄
--            'remind'  → ⏰ 30분 전 + 줄바꿈 + 그 줄
create or replace function public.format_run_notice(
  p_run_id    uuid,
  p_kind      text default 'plain',
  p_now       timestamptz default now(),
  p_max_names integer default 4
)
returns text
language plpgsql
stable
as $func$
declare
  v_boss    text;
  v_sched   timestamptz;
  v_week    text;
  v_party   uuid;
  v_when    text;
  v_no      smallint;
  v_names   text[];
  v_total   integer;
  v_names_s text;
  v_line    text;
begin
  select bd.korean_name, r.scheduled_at, r.week_key, r.party_id
    into v_boss, v_sched, v_week, v_party
    from public.party_runs r
    join public.boss_difficulties bd on bd.id = r.boss_difficulty_id
   where r.id = p_run_id;

  if not found then
    return null;
  end if;

  v_when := case
    when v_sched is null then '시간미정'
    else public.format_kst_when(v_sched, p_now)
  end;

  select n.party_no into v_no
    from public.party_room_numbers n
   where n.party_id = v_party and n.week_key = v_week;

  -- 이름은 **display_name 스냅샷**만 쓴다. 계정 UUID·닉네임 조인으로 개인정보가 새지 않게.
  select array_agg(pp.display_name order by s.seat_no), count(*)
    into v_names, v_total
    from public.run_signups s
    join public.party_participants pp on pp.id = s.participant_id
   where s.run_id = p_run_id and s.status = 'going';

  v_total := coalesce(v_total, 0);

  if v_total = 0 then
    v_names_s := '모집중';
  elsif v_total > p_max_names then
    v_names_s := array_to_string(v_names[1:p_max_names], ', ')
              || ' …외 ' || (v_total - p_max_names)::text || '명';
  else
    v_names_s := array_to_string(v_names, ', ');
  end if;

  -- 공백 정렬 없이 단순 연결한다(가변폭 폰트에서 표는 반드시 어긋난다).
  v_line := v_when || ' '
         || case when v_no is not null then v_no::text || '파티 ' else '' end
         || v_boss
         || ' (' || v_names_s || ')';

  v_line := case p_kind
    when 'created' then '📌 ' || v_line
    when 'remind'  then '⏰ 30분 전' || chr(10) || v_line
    else v_line
  end;

  -- 350자 예산. 넘으면 잘라낸다(카톡이 '전체보기'로 접는 것을 피한다).
  if length(v_line) > 350 then
    v_line := left(v_line, 347) || '...';
  end if;

  return v_line;
end;
$func$;

comment on function public.format_run_notice(uuid, text, timestamptz, integer) is
  '카톡 평문 알림 문구. 발주자 예시 형태 `19시 1파티 스우 (우레푸, ...)`. 웹 미리보기와 봇 발송이 같은 값을 쓴다.';

-- -----------------------------------------------------------------------------
-- 13-5. 아웃박스 적재
-- -----------------------------------------------------------------------------
-- ── 무엇을 언제 적재하는가 ─────────────────────────────────────────────────
--   run_created : 파티(런) 생성 알림. **명령 처리가 끝난 뒤 서버가 1회 적재.**
--   run_remind  : 시작 30분 전 리마인더. **서버 스케줄러가 주기적으로 적재.**
--
-- ── 왜 트리거가 아니라 서버인가 ────────────────────────────────────────────
--   1) `bot_outbox` 는 **문자열을 얼려서** 담는 구조다. 즉 "문구를 언제 만드느냐"가 곧 내용이다.
--      생성 트리거는 참가자가 다 들어오기 전에 발화하므로 `(모집중)` 만 담긴 알림이 나간다.
--      `!보스등록` 명령은 파티·런·참가자를 함께 만들므로, 그 처리가 **끝난 뒤** 적재해야
--      발주자가 원한 `(우레푸, 라이언, 어피치, 프로도)` 형태가 나온다.
--   2) "30분 전"은 **시간 기반**이라 애초에 트리거로 표현할 수 없다. 아무 행도 바뀌지 않아도
--      시간이 흐르면 발화해야 한다. → 주기 잡이 유일한 방법이다.
--   → **DB 는 규칙(dedupe 규약·TTL·문구)을 소유하고, 서버는 타이밍만 소유한다.**
--      규칙이 DB 에 있으므로 웹·봇·스케줄러가 같은 문구와 같은 중복 방지를 공유한다.
--
-- ── dedupe_key 규약 ────────────────────────────────────────────────────────
--   `{목적}:{엔티티ID}:{시점}`
--     run_created:<run_id>
--     run_remind:<run_id>:T-30
--     weekly_summary:<week_key>        ← 주차 표기는 **반드시 week_key(KST 목 00:00 경계)**
--   ⚠️ ISO 주차를 쓰면 수·목 알림이 두 주에 걸쳐 중복 생성된다. week_key 만 쓴다.
create or replace function public.enqueue_run_notice(
  p_run_id uuid,
  p_kind   text default 'created',
  p_now    timestamptz default now()
)
returns integer
language plpgsql
as $func$
declare
  v_channel  uuid;
  v_party    uuid;
  v_sched    timestamptz;
  v_reply    text;
  v_key      text;
  v_expires  timestamptz;
  v_inserted integer := 0;
  v_hit      integer;
begin
  select r.party_id, r.scheduled_at
    into v_party, v_sched
    from public.party_runs r
   where r.id = p_run_id;

  if not found then
    return 0;
  end if;

  v_reply := public.format_run_notice(p_run_id, p_kind, p_now);
  if v_reply is null then
    return 0;
  end if;

  if p_kind = 'remind' then
    v_key := 'run_remind:' || p_run_id::text || ':T-30';
    -- 지난 알림은 가치가 음수다. 보스 시각 + 15분이면 폐기한다.
    v_expires := coalesce(v_sched, p_now) + interval '15 minutes';
  else
    v_key := 'run_created:' || p_run_id::text;
    v_expires := p_now + interval '2 hours';
  end if;

  -- 목적지는 함수를 통해서만 얻는다(다중 방 확장 시 여기 코드는 그대로).
  for v_channel in select * from public.party_notify_channel_ids(v_party) loop
    insert into public.bot_outbox (channel_id, dedupe_key, reply, expires_at, visible_after)
    values (v_channel, v_key, v_reply, v_expires, p_now)
    on conflict (channel_id, dedupe_key) do nothing;

    get diagnostics v_hit = row_count;
    v_inserted := v_inserted + v_hit;
  end loop;

  return v_inserted;   -- 0 이면 목적지가 없거나 이미 적재됨(중복)
end;
$func$;

comment on function public.enqueue_run_notice(uuid, text, timestamptz) is
  '런 알림을 아웃박스에 적재한다. dedupe_key 로 중복을 막고 TTL 을 규약대로 건다. 반환값 0 = 목적지 없음 또는 이미 적재됨.';

-- 스케줄러가 "지금 30분 전 알림을 적재해야 할 런" 목록을 얻는 곳.
-- 서버는 이 뷰를 읽고 각 행에 대해 enqueue_run_notice(run_id, 'remind') 를 호출하면 된다.
drop view if exists public.v_pending_run_reminders;
create view public.v_pending_run_reminders
with (security_invoker = true) as
select
  r.id                                   as run_id,
  r.party_id,
  p.bot_channel_id,
  r.week_key,
  r.scheduled_at,
  r.scheduled_at - interval '30 minutes' as remind_at
from public.party_runs r
join public.parties p on p.id = r.party_id
where p.bot_channel_id is not null
  and r.scheduled_at is not null
  and r.status in ('proposed', 'confirmed')
  and r.cancelled_at is null
  and not exists (
    select 1 from public.bot_outbox o
    where o.channel_id = p.bot_channel_id
      and o.dedupe_key = 'run_remind:' || r.id::text || ':T-30'
  );

comment on view public.v_pending_run_reminders is
  '30분 전 리마인더를 아직 적재하지 않은 런. 스케줄러가 remind_at <= now() < scheduled_at 조건으로 걸러 적재한다.';

-- -----------------------------------------------------------------------------
-- 13-6. `!보스등록 <보스>` 경로 점검 결과
-- -----------------------------------------------------------------------------
-- 이 명령 하나로 파티+런이 만들어지려면 필요한 것들:
--   ✅ 발신자 → bot_channel_members → app_users        (마이그레이션 06, 이미 있음)
--   ✅ 보스 별칭 해석 → boss_aliases                   (마이그레이션 02, **시드는 아직 없음**)
--   ✅ 파티 생성자                → parties.owner_user_id (게스트 불가, 이미 강제됨)
--   ✅ 방 바인딩                  → parties.bot_channel_id (이 마이그레이션)
--   ✅ 파티 번호                  → party_room_numbers     (이 마이그레이션)
--   ✅ 알림 문구·적재             → format_run_notice / enqueue_run_notice (이 마이그레이션)
--
-- 시간 미지정(`!보스등록 더저` 처럼 시각이 없을 때):
--   `party_runs.scheduled_at` 이 **nullable** 이므로 시각 없이도 런을 만들 수 있다.
--   그 경우 문구는 `시간미정 1파티 ...` 이 되고, `v_pending_run_reminders` 는
--   `scheduled_at is not null` 조건 때문에 **리마인더를 만들지 않는다**(보낼 시각이 없으므로).
--   봇은 research-KAKAO-BOT §2.4 대로 되묻는 것을 우선하고, 사용자가 생략을 고집하면
--   시각 없는 런으로 만든 뒤 나중에 `!등록 <보스> <시간>` 으로 채우게 한다.
--   → 스키마 변경 없이 성립한다.

-- -----------------------------------------------------------------------------
-- 13-7. RLS — 신규 테이블
-- -----------------------------------------------------------------------------
-- ★ 어느 카톡방인지는 **사적 정보**다. 공개 시간표로 절대 새면 안 된다.
--   `parties.bot_channel_id` 는 11 마이그레이션의 **컬럼 단위 GRANT** 덕분에
--   자동으로 제외된다(새 컬럼은 기본이 닫힘). 아래 자기검증에서 실제로 확인한다.
do $$
declare
  t text;
  private_tables text[] := array['party_room_numbers'];
begin
  foreach t in array private_tables loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon', t);
    execute format('revoke all on table public.%I from authenticated', t);
    execute format('grant all on table public.%I to service_role', t);

    execute format('drop policy if exists %I on public.%I', t || '_no_public_access', t);
    execute format(
      $p$create policy %I on public.%I as permissive for all
         to anon, authenticated using (false) with check (false)$p$,
      t || '_no_public_access', t
    );

    execute format('drop policy if exists %I on public.%I', t || '_service_role_all', t);
    execute format(
      $p$create policy %I on public.%I as permissive for all
         to service_role using (true) with check (true)$p$,
      t || '_service_role_all', t
    );
  end loop;
end
$$;

revoke all on table public.v_pending_run_reminders from anon;
revoke all on table public.v_pending_run_reminders from authenticated;
grant all on table public.v_pending_run_reminders to service_role;

-- 알림 적재·번호 부여는 서버만 한다.
revoke all on function public.enqueue_run_notice(uuid, text, timestamptz) from public;
revoke all on function public.enqueue_run_notice(uuid, text, timestamptz) from anon;
revoke all on function public.enqueue_run_notice(uuid, text, timestamptz) from authenticated;
grant execute on function public.enqueue_run_notice(uuid, text, timestamptz) to service_role;

revoke all on function public.assign_party_number(uuid, text) from public;
revoke all on function public.assign_party_number(uuid, text) from anon;
revoke all on function public.assign_party_number(uuid, text) from authenticated;
grant execute on function public.assign_party_number(uuid, text) to service_role;

-- 문구 생성은 참가자 이름을 읽으므로 서버 전용으로 잠근다.
revoke all on function public.format_run_notice(uuid, text, timestamptz, integer) from public;
revoke all on function public.format_run_notice(uuid, text, timestamptz, integer) from anon;
revoke all on function public.format_run_notice(uuid, text, timestamptz, integer) from authenticated;
grant execute on function public.format_run_notice(uuid, text, timestamptz, integer) to service_role;

revoke all on function public.party_notify_channel_ids(uuid) from public;
revoke all on function public.party_notify_channel_ids(uuid) from anon;
revoke all on function public.party_notify_channel_ids(uuid) from authenticated;
grant execute on function public.party_notify_channel_ids(uuid) to service_role;

-- -----------------------------------------------------------------------------
-- 13-8. 민감 컬럼 가드 확장 — 방/채널 참조도 잡는다
-- -----------------------------------------------------------------------------
-- `bot_channel_id` 는 기존 패턴(share/meso/_bp/secret/hash/token/api_key) 중 어디에도 걸리지 않는다.
-- 어느 방에 속하는지는 사적 정보이므로 **`%channel%` 과 `%room%` 을 패턴에 추가**한다.
create or replace function public.assert_no_public_sensitive_columns()
returns void
language plpgsql
as $func$
declare
  v_bad text;
begin
  select string_agg(x.ref, ', ' order by x.ref) into v_bad
  from (
    select format('%s.%s', c.table_name, c.column_name) as ref
    from information_schema.columns c
    where c.table_schema = 'public'
      and (
             c.column_name ilike '%share%'
          or c.column_name ilike '%meso%'
          or c.column_name ilike '%\_bp'    escape '\'
          or c.column_name ilike '%secret%'
          or c.column_name ilike '%hash%'
          or c.column_name ilike '%token%'
          or c.column_name ilike '%api\_key%' escape '\'
          -- 13 추가: 어느 카톡방/채널에 속하는지는 사적 정보다.
          or c.column_name ilike '%channel%'
          or c.column_name ilike '%room%'
      )
      and (
             has_column_privilege('anon',          format('public.%I', c.table_name), c.column_name, 'SELECT')
          or has_column_privilege('authenticated', format('public.%I', c.table_name), c.column_name, 'SELECT')
      )
      and format('%s.%s', c.table_name, c.column_name) not in (
        -- ★★ 의도적 공개 화이트리스트 ★★
        -- 여기에 넣는다는 것은 "비로그인 전체에게 보여도 된다"고 판단했다는 뜻이다.
        -- 반드시 근거를 함께 남길 것.

        -- 공개(visibility='public') 파티의 짧은 URL 조각. RLS 가 공개 파티 행만 노출하므로
        -- 슬러그가 비밀인 visibility='link' 파티는 애초에 이 경로로 나오지 않는다.
        'parties.share_slug',
        'v_public_party_board.share_slug',
        'v_public_party_runs.share_slug',

        -- 결정석 시세는 게임 공개 정보이며 비로그인 등록 화면이 필요로 한다.
        -- 개인 수익이 아니라 만인이 아는 상수표다.
        'boss_crystal_prices.price_meso',
        'v_boss_catalog.crystal_price_meso'
      )
  ) x;

  if v_bad is not null then
    raise exception
      '민감 패턴 컬럼이 anon/authenticated 에 노출되었습니다: %. 의도한 공개라면 assert_no_public_sensitive_columns() 의 화이트리스트에 근거와 함께 명시하세요.',
      v_bad
      using errcode = 'insufficient_privilege';
  end if;
end;
$func$;

-- -----------------------------------------------------------------------------
-- 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_rls_off text;
begin
  -- (1) 민감 컬럼 가드 (CLAUDE.md §0.3 — 새 마이그레이션 필수 호출)
  perform public.assert_no_public_sensitive_columns();

  -- (2) 방 바인딩이 공개 시간표로 새지 않는가
  if has_column_privilege('anon', 'public.parties', 'bot_channel_id', 'SELECT') then
    raise exception 'parties.bot_channel_id 가 anon 에게 노출되어 있습니다. 어느 카톡방인지는 사적 정보입니다.';
  end if;

  -- (3) RLS / 정책 누락
  select string_agg(c.relname, ', ' order by c.relname) into v_rls_off
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;
  if v_rls_off is not null then
    raise exception 'RLS 가 비활성화된 테이블이 있습니다: %', v_rls_off;
  end if;

  select string_agg(c.relname, ', ' order by c.relname) into v_missing
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r'
    and not exists (select 1 from pg_policy p where p.polrelid = c.oid);
  if v_missing is not null then
    raise exception 'RLS 정책이 없는 테이블이 있습니다: %', v_missing;
  end if;

  -- (4) 공개 역할 쓰기 권한
  select string_agg(distinct table_name, ', ') into v_missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');
  if v_missing is not null then
    raise exception 'anon/authenticated 에 쓰기 권한이 남아 있는 객체: %', v_missing;
  end if;

  -- (5) 시각 표기 규칙
  if public.format_kst_when(timestamptz '2026-08-20 19:00+09', timestamptz '2026-08-20 12:00+09') <> '19시' then
    raise exception '같은 날 시각 표기 오류: %',
      public.format_kst_when(timestamptz '2026-08-20 19:00+09', timestamptz '2026-08-20 12:00+09');
  end if;
  if public.format_kst_when(timestamptz '2026-08-20 19:30+09', timestamptz '2026-08-17 12:00+09') <> '8/20(목) 19시30분' then
    raise exception '다른 날 시각 표기 오류: %',
      public.format_kst_when(timestamptz '2026-08-20 19:30+09', timestamptz '2026-08-17 12:00+09');
  end if;
end
$$;

select public.assert_no_public_sensitive_columns();
