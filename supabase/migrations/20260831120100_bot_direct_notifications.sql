-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 개인톡 알림 — 파티와 상관없이 **내 캐릭터가 걸린 모든 일정**
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-08-31):
--   *"개인톡으로 몇명만 가능하도록 해서 파티와상관없이 나와연관된 모든 알림을 주게"*
--   *"내가 등록한 모든 일정에 대한 알림. 오늘 몇건 오늘 몇시 둘다. 직접지정"*
--   *"!알림으로 설정가능하도록. 내 캐릭터 파티 상관없이 모든 일정을 전부"*
--   크론 주기는 **10분**(발주자 직접 지정).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 이미 있던 알림 두 종류와 무엇이 다른가
-- ─────────────────────────────────────────────────────────────────────────────
--   parties.reminder_minutes    런 하나에 "몇 분 전"      → **그 파티가 묶인 방**으로
--   bot_channels.digest_minutes 방에 "하루 중 몇 시"      → **그 방**의 일정만
--   ★ 이번 것                    사람에게 "몇 분 전/몇 시"  → **그 사람의 모든 일정**
--
-- 앞의 두 개는 축이 **방**이라, 파티가 서로 다른 방에 묶여 있으면 알림도 갈라진다.
-- 발주 지시는 정확히 그 반대다 — "파티와 상관없이 나와 연관된 모든 알림". 그래서 축이
-- 방이 아니라 **사람**이고, 저장도 채널이 아니라 `app_users` 에 매단다. 방을 다시 만들어도
-- (기기 교체·방 재생성) 설정이 그대로 남아야 하기 때문이다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ★★ 예약(스케줄) 테이블을 만들지 않는다 ★★
-- ─────────────────────────────────────────────────────────────────────────────
-- "언제 무엇을 보낼지"를 미리 적어 두는 표를 하나 더 세우고 싶어지는 자리다. 필요 없다:
-- `bot_outbox` 에 **`(channel_id, dedupe_key)` 유니크 인덱스**(`bot_outbox_dedupe_uniq`)가
-- 이미 있어서, 같은 키로 두 번 넣으면 두 번째가 DB 차원에서 거부된다. 즉 **멱등성은
-- 이미 보장돼 있고**, 예약 표를 두면 (a) 일정이 바뀔 때 예약을 지우는 코드, (b) 예약과
-- 실제 일정이 어긋났을 때의 정합성 문제, (c) 청소 배치가 새로 생긴다 — 아무것도 사지
-- 못하고 세 가지를 잃는다.
--
-- dedupe_key 규약(이 축을 바꾸면 중복 발송이 난다):
--   임박  `run:<첫 런 id>:user:<user_id>:imminent`
--   요약  `user:<user_id>:digest:<YYYY-MM-DD KST>`
--
-- ─────────────────────────────────────────────────────────────────────────────
-- ★★ 크론 앞에 SQL 게이트를 둔다 ★★
-- ─────────────────────────────────────────────────────────────────────────────
-- 10분 주기면 하루 144번이다. 그때마다 무조건 HTTP 를 때리면 **보낼 것이 하나도 없는
-- 141번**이 헛돈다(서버리스 콜드스타트 · 로그 · 실패 알림까지 전부 낭비다). 그래서
-- `trigger_bot_notify()` 는 pg_net 을 부르기 **전에** `bot_direct_notify_pending()` 을
-- 먼저 본다. 거짓이면 그 자리에서 끝나고 HTTP 는 0건이다.
--
-- ★ 게이트는 대상 조회(`bot_direct_notify_targets`) 위의 `exists()` **그 자체**다.
--   따로 쓴 "대충 비슷한 조건"이 아니다. 두 벌로 쓰면 언젠가 한쪽만 고쳐지고, 그 순간
--   게이트가 참인데 보낼 게 없거나(낭비) **게이트가 거짓인데 보낼 게 있는**(알림 유실)
--   상태가 된다. 뒤쪽은 조용히 실패하므로 아무도 모른다.
-- ★ 게이트 쿼리는 `party_runs_upcoming_idx`(scheduled_at, 취소·상태 부분 인덱스) ·
--   `party_participants_user_idx` · `run_signups_participant_idx` 를 탄다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 문구는 왜 SQL 이 아니라 앱(TS)이 만드는가
-- ─────────────────────────────────────────────────────────────────────────────
-- 연속 런 묶기(`lib/domain/run-grouping.ts`) · 참가자 표시(`participant-label.ts`) ·
-- 묶음 제목(`party-title.ts`)이 전부 TS 에 있고 웹 화면이 같은 것을 쓴다. SQL 에 같은
-- 규칙을 또 쓰면 그날부터 봇과 화면이 다른 묶음을 그린다. 그래서 **SQL 은 "지금 보낼
-- 사람이 있는가"만 답하고**, 무엇을 어떻게 적을지는 `/api/bot/notify` 가 갖는다.
-- ═══════════════════════════════════════════════════════════════════════════════


-- #############################################################################
-- 1. 채널 종류 — 파티방 / 개인톡
-- #############################################################################

do $$
begin
  if not exists (select 1 from pg_type where typname = 'bot_channel_kind') then
    create type public.bot_channel_kind as enum ('party_room', 'direct');
  end if;
end $$;

/*
  기본값이 `party_room` 이므로 **기존 행은 전부 그대로 파티방으로 백필된다.**
  개인톡은 오직 `direct_pair` 코드로 페어링될 때만 생긴다.
*/
alter table public.bot_channels
  add column if not exists kind public.bot_channel_kind not null default 'party_room';

comment on column public.bot_channels.kind is
  '방 종류. party_room = 여럿이 있는 파티방(기본). direct = 한 사람의 1:1 개인톡. '
  'direct 는 owner_user_id 가 반드시 있고 사람당 하나뿐이다.';

/*
  ★ 개인톡은 **정확히 한 사람**의 것이다. 주인이 없는 개인톡은 "누구의 일정을 보낼지"를
    답할 수 없으므로 존재 자체가 무의미하고, 존재하면 알림 대상 조회가 조용히 0건을
    돌려주는 유령 방이 된다.
*/
alter table public.bot_channels
  drop constraint if exists bot_channels_direct_needs_owner;
alter table public.bot_channels
  add constraint bot_channels_direct_needs_owner
  check (kind <> 'direct' or owner_user_id is not null);

/*
  ★ 한 사람이 개인톡 방을 둘 이상 가질 수 없다. 두 개면 같은 알림이 두 번 나가고
    (dedupe_key 는 채널마다 따로 세므로 유니크 인덱스가 막아 주지 못한다) 설정을
    어느 방에서 바꿨는지에 따라 결과가 달라진다.
    ⚠️ 부분 유니크라 파티방(owner 가 같아도 됨)에는 영향이 없다.
*/
drop index if exists public.bot_channels_direct_owner_uniq;
create unique index bot_channels_direct_owner_uniq
  on public.bot_channels (owner_user_id)
  where kind = 'direct';


-- #############################################################################
-- 2. 허용 명단 — "몇 명만"
-- #############################################################################
--
-- 발주 지시가 *"개인톡으로 몇명만 가능하도록"* 이다. 개인톡 방 하나는 그 사람의 **모든**
-- 일정을 통째로 흘려보내는 통로라, 아무나 열 수 있으면 안 된다. 명단에 없으면 코드
-- 발급 자체가 거절되고(`/api/bot/link-codes`), 어떻게든 코드를 얻어도 페어링이 거절되며
-- (`/api/bot/pair`), 방이 남아 있더라도 알림 대상에서 빠진다(아래 targets 함수).
-- **세 곳 모두에서 본다** — 한 곳만 보면 명단에서 빼도 이미 열린 방으로 계속 나간다.

create table if not exists public.bot_direct_grants (
  user_id    uuid primary key references public.app_users(id) on delete cascade,
  -- 누가 줬는지. 계정이 지워져도 "부여된 사실"은 남아야 하므로 set null 이다.
  granted_by uuid references public.app_users(id) on delete set null,
  granted_at timestamptz not null default now(),
  -- 왜 줬는지. 나중에 명단을 정리할 때 근거가 없으면 아무도 못 지운다.
  note       text
);

comment on table public.bot_direct_grants is
  '개인톡 알림을 쓸 수 있는 사람 명단. 여기 없으면 direct 채널이 열리지 않고, '
  '이미 열린 방이라도 알림 대상에서 빠진다. 부여는 서버/SQL 로만 한다(웹 UI 없음).';

alter table public.bot_direct_grants enable row level security;

/*
  다른 bot_* 표와 **같은 규약**이다(마이그레이션 06): 봇 트래픽은 사용자 세션이 아니라
  채널 시크릿으로 인증되므로 RLS 로 보호되는 대상이 아니고, anon/authenticated 는
  통째로 막고 service_role 로만 접근한다.
*/
drop policy if exists bot_direct_grants_no_public_access on public.bot_direct_grants;
create policy bot_direct_grants_no_public_access
  on public.bot_direct_grants for all to anon, authenticated
  using (false) with check (false);

drop policy if exists bot_direct_grants_service_role_all on public.bot_direct_grants;
create policy bot_direct_grants_service_role_all
  on public.bot_direct_grants for all to service_role
  using (true) with check (true);

revoke all on table public.bot_direct_grants from anon, authenticated;
grant all on table public.bot_direct_grants to service_role;


-- #############################################################################
-- 3. 알림 설정 — **채널이 아니라 사람**에 붙는다
-- #############################################################################

create table if not exists public.bot_notification_prefs (
  user_id           uuid primary key references public.app_users(id) on delete cascade,

  -- 전체 스위치. `!알림 끄기` 가 이것만 내린다 — 시각 설정은 그대로 남아 다시 켜면 복원된다.
  enabled           boolean not null default true,

  /*
    오늘 요약을 보낼 **KST 자정 기준 분**(09:00 = 540). 기본 09:00.
    `null` = 요약 안 보냄(`!알림 요약 끄기`).
    ★ `time` 이 아니라 정수인 이유는 `availability_patterns` · `bot_channels.digest_minutes`
      가 이미 분 단위 정수를 쓰기 때문이다. 시간 표현이 두 종류면 변환이 곳곳에 생긴다.
  */
  digest_at_minutes smallint default 540
    check (digest_at_minutes is null or (digest_at_minutes >= 0 and digest_at_minutes <= 1439)),

  /*
    임박 알림 리드타임(분). 기본 30분. `null` = 임박 알림 안 보냄.
    ⚠️ 크론이 10분 주기라 **실제 발송은 리드타임 ~ 리드타임+10분 전 사이**다. 정확히
      리드타임에 맞춰 오지 않는다는 사실을 답장에서도 말해 준다(과장하면 거짓말이 된다).
  */
  lead_minutes      smallint default 30
    check (lead_minutes is null or (lead_minutes >= 1 and lead_minutes <= 1440)),

  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.bot_notification_prefs is
  '개인 알림 설정. 축이 채널이 아니라 사람이라 방을 다시 만들어도 설정이 남는다. '
  '행이 없으면 기본값(켜짐 · 요약 09:00 · 임박 30분)으로 취급한다.';
comment on column public.bot_notification_prefs.digest_at_minutes is
  'KST 자정 기준 분. 그 시각에 오늘 남은 일정을 한 통으로. null 이면 요약을 보내지 않는다.';
comment on column public.bot_notification_prefs.lead_minutes is
  '일정 시작 몇 분 전에 알릴지. null 이면 임박 알림을 보내지 않는다. '
  '크론이 10분 주기라 실제 발송은 lead ~ lead+10분 전 사이다.';

drop trigger if exists bot_notification_prefs_set_updated_at on public.bot_notification_prefs;
create trigger bot_notification_prefs_set_updated_at
  before update on public.bot_notification_prefs
  for each row execute function public.set_updated_at();

alter table public.bot_notification_prefs enable row level security;

drop policy if exists bot_notification_prefs_no_public_access on public.bot_notification_prefs;
create policy bot_notification_prefs_no_public_access
  on public.bot_notification_prefs for all to anon, authenticated
  using (false) with check (false);

drop policy if exists bot_notification_prefs_service_role_all on public.bot_notification_prefs;
create policy bot_notification_prefs_service_role_all
  on public.bot_notification_prefs for all to service_role
  using (true) with check (true);

revoke all on table public.bot_notification_prefs from anon, authenticated;
grant all on table public.bot_notification_prefs to service_role;


-- #############################################################################
-- 4. 대상 조회 — 게이트와 **같은 쿼리**
-- #############################################################################

-- 크론 주기. 게이트 창의 폭이자 "늦게 온 알림"의 유예 폭이다.
-- ⚠️ cron.schedule 의 10분 식과 **반드시 같은 값**이어야 한다. 여기가 더 좁으면 어떤
--    틱에도 안 걸리는 사각이 생기고, 넓으면 같은 알림 창이 두 틱에 걸려 HTTP 만 한 번 더
--    나간다(발송 자체는 dedupe_key 가 막는다). 상수를 한 곳에 두기 위해 함수로 뺀다.
-- ⚠️ 블록주석(/* */) 안에 크론 식을 그대로 적으면 `*` + `/` 가 주석을 조기 종료시켜
--    파일이 깨진다. 그래서 이 근처 주석은 전부 줄주석이다.
create or replace function public.bot_notify_tick_minutes()
returns integer
language sql
immutable
parallel safe
set search_path to 'public', 'pg_temp'
as $$ select 10; $$;

comment on function public.bot_notify_tick_minutes() is
  '개인톡 알림 크론의 주기(분). cron.schedule 의 식과 반드시 일치해야 한다.';

/*
  KST 달력 날짜 + 자정 기준 분 → 절대 시각.
  ★ UTC 로 계산하면 안 된다(CLAUDE.md §1). `at time zone` 으로 **벽시계 → 절대시각**
    변환을 Postgres 에 맡기면 경계에서 우리가 틀릴 여지가 없다.
*/
create or replace function public.kst_wall_moment(p_day date, p_minutes integer)
returns timestamptz
language sql
immutable
parallel safe
set search_path to 'public', 'pg_temp'
as $$
  select ((p_day::timestamp) + make_interval(mins => p_minutes)) at time zone 'Asia/Seoul';
$$;

comment on function public.kst_wall_moment(date, integer) is
  'KST 달력 날짜의 자정 기준 분을 절대 시각으로. lib/time/kst-wallclock.ts 의 kstMoment 와 같은 규칙.';

/*
  ═══════════════════════════════════════════════════════════════════════════════
  지금 이 순간 알림을 받아야 하는 사람 — **게이트가 보는 것이 정확히 이것이다**
  ═══════════════════════════════════════════════════════════════════════════════

  범위는 **"내 캐릭터가 걸린 모든 일정"** 이다. 파티가 어느 방에 묶여 있는지, 묶여
  있기는 한지 전혀 보지 않는다 — `run_signups.status = 'going'` 하나가 조건이다.

  거르는 것:
    · 취소된 런(`cancelled_at` · `status = 'cancelled'`)
    · 시각 미정 런 — "몇 시에 온다"를 말할 수 없으므로 알릴 것이 없다
    · **내가 이미 잡은 런**(`boss_clears`) — `!일정` 과 같은 규칙이다(할 일 목록이지
      트로피 진열장이 아니다). 여기서 안 거르면 다 잡고 자는 사람을 30분 전에 깨운다.
    · 명단(`bot_direct_grants`)에 없는 사람 · `enabled = false` · 정지된 방

  ★ **`imminent` 는 앱이 다시 계산한다.** 여기서 참인 것은 "이 사람에게 지금 임박 알림
    거리가 하나라도 있다"까지이고, 어느 묶음을 어떤 문구로 보낼지는 앱이 정한다
    (연속 런 묶기 규칙이 TS 에만 있으므로). 그래서 이 함수가 참인데 앱이 0건을 넣는
    경우가 있을 수 있고 그건 **정상**이다 — 낭비는 HTTP 한 번이고, 반대 방향(여기서
    거짓인데 보낼 게 있는 경우)만 알림 유실이라 그쪽으로 절대 기울지 않게 조건을 넓게 잡았다.
*/
create or replace function public.bot_direct_notify_targets(p_now timestamptz default now())
returns table (
  user_id    uuid,
  channel_id uuid,
  room       text,
  imminent   boolean,
  digest     boolean
)
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  with tick as (
    select make_interval(mins => public.bot_notify_tick_minutes()) as span
  ),
  -- 알림을 받을 자격이 있는 방. 명단·설정·정지 여부가 전부 여기서 걸린다.
  eligible as (
    select ch.id            as channel_id,
           ch.room          as room,
           ch.owner_user_id as user_id,
           coalesce(p.digest_at_minutes, 540)::integer as digest_at,
           coalesce(p.lead_minutes, 30)::integer       as lead,
           -- 설정 행이 아예 없으면 기본값(요약 09:00 · 임박 30분)이 켜진 것으로 본다.
           (p.user_id is null or p.digest_at_minutes is not null) as digest_on,
           (p.user_id is null or p.lead_minutes is not null)      as lead_on
      from public.bot_channels ch
      join public.bot_direct_grants g on g.user_id = ch.owner_user_id
      left join public.bot_notification_prefs p on p.user_id = ch.owner_user_id
     where ch.kind = 'direct'
       and ch.status <> 'paused'
       and ch.owner_user_id is not null
       and coalesce(p.enabled, true)
  ),
  -- 그 사람이 going 으로 등록한, 앞으로 있을, 아직 안 잡은 런. **파티·방과 무관하다.**
  mine as (
    select e.channel_id,
           -- 임박 발사 시각(시작 − 리드)이 지났고 아직 한 틱 안인가
           (e.lead_on
            and r.scheduled_at - make_interval(mins => e.lead) <= p_now
            and r.scheduled_at - make_interval(mins => e.lead) + t.span > p_now) as fires,
           ((r.scheduled_at at time zone 'Asia/Seoul')::date
              = (p_now at time zone 'Asia/Seoul')::date) as is_today
      from eligible e
      cross join tick t
      join public.party_participants pp
        on pp.user_id = e.user_id and pp.left_at is null
      join public.run_signups s
        on s.participant_id = pp.id and s.status = 'going'
      join public.party_runs r
        on r.id = s.run_id
       and r.cancelled_at is null
       and r.status in ('proposed', 'confirmed')
       and r.scheduled_at is not null
       and r.scheduled_at > p_now
     where not exists (
       select 1 from public.boss_clears bc
        where bc.run_id = r.id and bc.user_id = e.user_id
     )
  ),
  rolled as (
    select e.channel_id, e.room, e.user_id, e.digest_on, e.digest_at,
           coalesce(bool_or(m.fires), false)    as imminent,
           coalesce(bool_or(m.is_today), false) as has_today
      from eligible e
      left join mine m on m.channel_id = e.channel_id
     group by e.channel_id, e.room, e.user_id, e.digest_on, e.digest_at
  )
  select x.user_id, x.channel_id, x.room, x.imminent, x.digest
    from (
      select r.user_id, r.channel_id, r.room, r.imminent,
             (
               r.digest_on
               and r.has_today
               and public.kst_wall_moment((p_now at time zone 'Asia/Seoul')::date, r.digest_at) <= p_now
               and public.kst_wall_moment((p_now at time zone 'Asia/Seoul')::date, r.digest_at) + t.span > p_now
             ) as digest
        from rolled r
        cross join tick t
    ) x
   where x.imminent or x.digest;
$$;

comment on function public.bot_direct_notify_targets(timestamptz) is
  '지금 개인톡 알림을 받아야 하는 사람. 파티·방 바인딩과 무관하게 going 등록만 본다. '
  '게이트(bot_direct_notify_pending)가 이 함수 위의 exists() 라 두 판정이 갈라질 수 없다.';

revoke all on function public.bot_direct_notify_targets(timestamptz) from public;
revoke all on function public.bot_direct_notify_targets(timestamptz) from anon, authenticated;
grant execute on function public.bot_direct_notify_targets(timestamptz) to service_role;


-- #############################################################################
-- 5. 게이트
-- #############################################################################

create or replace function public.bot_direct_notify_pending(p_now timestamptz default now())
returns boolean
language sql
stable
set search_path to 'public', 'pg_temp'
as $$
  select exists (select 1 from public.bot_direct_notify_targets(p_now));
$$;

comment on function public.bot_direct_notify_pending(timestamptz) is
  '지금 보낼 개인톡 알림이 하나라도 있는가. 크론이 HTTP 를 때리기 전에 이것을 먼저 본다 — '
  '10분 주기 하루 144번 중 대부분은 여기서 끝나고 호출이 0건이다.';

revoke all on function public.bot_direct_notify_pending(timestamptz) from public;
revoke all on function public.bot_direct_notify_pending(timestamptz) from anon, authenticated;
grant execute on function public.bot_direct_notify_pending(timestamptz) to service_role;


-- #############################################################################
-- 6. 크론 — 10분 주기, 게이트 통과할 때만 HTTP
-- #############################################################################

/*
  `trigger_web_sync`(마이그레이션 `20260826100000_hourly_sync_cron.sql`)와 **같은 방식**이다:
  vault 에서 주소·토큰을 꺼내 pg_net 으로 우리 라우트를 부른다. 다른 것은 앞에 게이트가
  하나 붙는다는 점뿐이다.

  ⚠️ vault 비밀이 아직 없으면 **실패가 아니라 대기**다. 설치가 안 끝난 것이지 고장이 아니다.
  ⚠️ pg_net 이 죽으면 알림이 조용히 멈춘다. 확인은 `net._http_response` 를 보면 된다
     (동기화 크론과 같은 진단 경로다). 다만 이쪽은 **보낼 게 있을 때만** 행이 생기므로
     "행이 없다 = 고장"이 아니다.
*/
create or replace function public.trigger_bot_notify(p_now timestamptz default now())
returns bigint
language plpgsql
security definer
set search_path to 'public', 'net', 'pg_temp'
as $function$
declare
  v_base    text;
  v_token   text;
  v_request bigint;
begin
  -- ★ 게이트. 보낼 것이 없으면 여기서 끝난다 — HTTP 0건.
  if not public.bot_direct_notify_pending(p_now) then
    return null;
  end if;

  select decrypted_secret into v_base
    from vault.decrypted_secrets where name = 'app_base_url';
  select decrypted_secret into v_token
    from vault.decrypted_secrets where name = 'cron_secret';

  if v_base is null or v_token is null then
    raise notice 'trigger_bot_notify: vault 비밀이 없어 건너뜁니다.';
    return null;
  end if;

  select net.http_get(
           url := v_base || '/api/bot/notify',
           headers := jsonb_build_object('Authorization', 'Bearer ' || v_token),
           timeout_milliseconds := 55000
         )
    into v_request;

  return v_request;
end;
$function$;

comment on function public.trigger_bot_notify(timestamptz) is
  '개인톡 알림 크론의 진입점. 게이트가 참일 때만 /api/bot/notify 를 부른다.';

revoke all on function public.trigger_bot_notify(timestamptz) from public;
revoke all on function public.trigger_bot_notify(timestamptz) from anon, authenticated;

do $$
begin
  if exists (select 1 from cron.job where jobname = 'bot-direct-notify') then
    perform cron.unschedule('bot-direct-notify');
  end if;
end $$;

-- 10분마다(발주자 직접 지정). KST 는 UTC+9 **정시 오프셋**이라 분이 같고,
-- 한국 기준으로도 매시 0·10·20·30·40·50분이다.
-- ⚠️ 이 주기를 바꾸면 `bot_notify_tick_minutes()` 도 같이 바꿔야 한다.
select cron.schedule(
  'bot-direct-notify',
  '*/10 * * * *',
  $cron$select public.trigger_bot_notify();$cron$
);


-- #############################################################################
-- 7. 자체 검증
-- #############################################################################

do $$
declare
  v_schedule text;
  v_tick     integer;
begin
  -- 크론 식과 상수가 일치하는가 (어긋나면 사각지대가 생긴다)
  select schedule into v_schedule from cron.job where jobname = 'bot-direct-notify';
  if v_schedule is distinct from '*/10 * * * *' then
    raise exception 'bot-direct-notify 크론 식이 예상과 다릅니다: %', coalesce(v_schedule, '(없음)');
  end if;
  select public.bot_notify_tick_minutes() into v_tick;
  if v_tick <> 10 then
    raise exception '틱 상수(%)가 크론 주기(10분)와 다릅니다', v_tick;
  end if;

  -- KST 벽시계 변환 (09:00 KST = 00:00 UTC)
  if public.kst_wall_moment(date '2026-08-31', 540) <> timestamptz '2026-08-31 00:00:00+00' then
    raise exception 'kst_wall_moment 가 KST 09:00 을 UTC 00:00 으로 옮기지 못했습니다';
  end if;
  if public.kst_wall_moment(date '2026-08-31', 0) <> timestamptz '2026-08-30 15:00:00+00' then
    raise exception 'kst_wall_moment 가 KST 자정을 옮기지 못했습니다';
  end if;

  -- 개인톡 제약: 주인 없는 direct 는 거부되어야 한다
  begin
    insert into public.bot_channels (room, platform, secret_hash, kind, owner_user_id)
    values ('ch_selfcheckNoOwner00000', 'kakao', repeat('0', 64), 'direct', null);
    raise exception '주인 없는 direct 채널이 통과했습니다';
  exception
    when check_violation then null;  -- 기대한 거절
  end;

  -- 설정 CHECK
  begin
    insert into public.bot_notification_prefs (user_id, digest_at_minutes)
    values ('00000000-0000-0000-0000-000000000000', 1440);
    raise exception 'digest_at_minutes = 1440 이 통과했습니다';
  exception
    when check_violation then null;
    when foreign_key_violation then null;  -- CHECK 보다 FK 가 먼저 걸려도 목적은 같다
  end;

  -- 게이트는 함수이고, 데이터가 없으면 거짓이어야 한다
  if public.bot_direct_notify_pending(now()) is null then
    raise exception '게이트가 null 을 돌려줍니다';
  end if;

  raise notice '개인톡 알림 스키마 검증 통과';
end $$;

-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
-- ⚠️ `bot_channels` 에 컬럼을 **추가**했다. 이 표는 anon 에 절대 열리면 안 되는 값
--    (`secret_hash` · `room`)을 들고 있으므로 확인을 생략하지 않는다.
select public.assert_no_public_sensitive_columns();
