-- =============================================================================
-- M_Schedule · 14. 관리 번호 정리 — 파티원 번호 / 일정 번호
-- =============================================================================
-- 화면 작업에서 드러난 결함 2건을 고친다.
--
--   결함 2: `party_runs` 에 일정 번호가 없다. §1.4 는 등록한 일정이 "번호와 함께 쌓임"을 요구한다.
--   결함 3: 참가자 번호(`seat_no`)가 **런 단위**라 사람 호칭으로 못 쓴다.
--           "3번"이 런마다 달라지면 사람은 이해하지 못한다.
--
-- ── 통합 검토 결과: seat_no 를 **폐기하고 파티 단위 하나로 통일한다** ────────
-- 먼저 "두 번호를 하나로 합칠 수 있는가"를 검토했고, **합칠 수 있다.**
--   * 런 참가자는 언제나 파티 참가자의 부분집합이다. 런 단위로 1..n 을 다시 매기면
--     같은 사람이 런마다 다른 번호를 갖게 되는데, 이게 정확히 결함 3이다.
--   * `!분배 1번 33` 의 "1번"은 **사람**을 가리킨다. 분배 자체는 런 단위가 맞지만
--     (실제 들어간 사람이 나눔), 호칭은 파티 단위여야 한다.
--   * 균등 분배의 결정론적 순서, 알림 문구의 이름 나열 순서도 파티 단위 번호로 충분하다.
-- → `run_signups.seat_no` 를 **제거**하고 `party_participants.member_no` 하나만 남긴다.
--   컬럼·트리거·제약이 줄어든다.
--
-- ── 남는 세 번호는 축이 서로 다르다 (역할이 겹치지 않는다) ──────────────────
--   party_room_numbers.party_no  : 방 안의 **파티**를 가리킴    · 스코프 (방, 주차)
--   party_runs.run_no            : 파티 안의 **일정**을 가리킴  · 스코프 (파티)
--   party_participants.member_no : 파티 안의 **사람**을 가리킴  · 스코프 (파티)
-- 셋 다 §1.4 의 공통 규칙을 따른다: **재배열 금지, 빈 번호 재사용 금지, 신규는 max+1.**
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 14-1. party_participants.member_no — 파티 안에서 사람을 부르는 번호
-- -----------------------------------------------------------------------------
alter table public.party_participants
  add column if not exists member_no smallint;

-- 기존 행 백필(가입 순서). 이미 번호가 있으면 건드리지 않고 그 뒤에 이어 붙인다.
update public.party_participants pp
   set member_no = x.new_no
  from (
    select p.id,
           (coalesce(m.max_no, 0)
            + row_number() over (partition by p.party_id order by p.joined_at, p.id))::smallint as new_no
    from public.party_participants p
    left join (
      select party_id, max(member_no) as max_no
      from public.party_participants
      where member_no is not null
      group by party_id
    ) m on m.party_id = p.party_id
    where p.member_no is null
  ) x
 where pp.id = x.id and pp.member_no is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'party_participants_member_no_positive') then
    alter table public.party_participants
      add constraint party_participants_member_no_positive check (member_no is null or member_no >= 1);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'party_participants_member_no_uniq') then
    alter table public.party_participants
      add constraint party_participants_member_no_uniq unique (party_id, member_no);
  end if;

  if exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'party_participants'
           and column_name = 'member_no' and is_nullable = 'YES'
      )
     and not exists (select 1 from public.party_participants where member_no is null) then
    alter table public.party_participants alter column member_no set not null;
  end if;
end
$$;

comment on column public.party_participants.member_no is
  '파티 안에서 사람을 부르는 번호(1부터). 봇의 `!분배 1번 33` 이 가리키는 대상. **재배열/재사용 금지** — 대화 중 지칭이 어긋나면 안 된다.';

-- seat_no 와 같은 이유로 트리거에 둔다: 참가자를 만드는 경로가 웹·봇·초대 링크로 여럿이라
-- 앱에 두면 한 곳만 빠뜨려도 번호가 겹치거나 빈다. 경쟁 조건은 advisory lock + unique 로 막는다.
create or replace function public.party_participants_assign_member_no()
returns trigger
language plpgsql
as $func$
declare
  v_next smallint;
begin
  if new.member_no is not null then
    return new;   -- 명시 지정(복원·이관)은 존중한다
  end if;

  perform pg_advisory_xact_lock(hashtextextended('party_member:' || new.party_id::text, 0));

  select (coalesce(max(member_no), 0) + 1)::smallint
    into v_next
    from public.party_participants
   where party_id = new.party_id;

  new.member_no := v_next;
  return new;
end;
$func$;

drop trigger if exists party_participants_assign_member_no on public.party_participants;
create trigger party_participants_assign_member_no
  before insert on public.party_participants
  for each row execute function public.party_participants_assign_member_no();

-- -----------------------------------------------------------------------------
-- 14-2. party_runs.run_no — 파티 안에서 일정을 부르는 번호
-- -----------------------------------------------------------------------------
-- **스코프를 (파티)로 잡고 주차를 넣지 않은 이유**:
--   1) 번호는 관리 식별자다. 주차를 넣으면 런을 다음 주로 옮길 때 번호가 바뀌거나
--      새 주차에서 충돌한다. **일정 하나를 미뤘다고 번호가 달라지면 안 된다.**
--   2) §1.4 의 오른쪽 패널은 "이 파티에 등록된 일정 목록"이고, 번호는 그 목록의 영구 ID 다.
--   3) 방 안의 파티를 구분하는 `party_no` 가 이미 (방, 주차) 축을 담당한다.
--      같은 축을 두 번 쓰면 "이번 주 2번"이 파티인지 일정인지 모호해진다.
alter table public.party_runs
  add column if not exists run_no smallint;

update public.party_runs r
   set run_no = x.new_no
  from (
    select pr.id,
           (coalesce(m.max_no, 0)
            + row_number() over (partition by pr.party_id order by pr.created_at, pr.id))::smallint as new_no
    from public.party_runs pr
    left join (
      select party_id, max(run_no) as max_no
      from public.party_runs
      where run_no is not null
      group by party_id
    ) m on m.party_id = pr.party_id
    where pr.run_no is null
  ) x
 where r.id = x.id and r.run_no is null;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'party_runs_run_no_positive') then
    alter table public.party_runs
      add constraint party_runs_run_no_positive check (run_no is null or run_no >= 1);
  end if;

  if not exists (select 1 from pg_constraint where conname = 'party_runs_run_no_uniq') then
    alter table public.party_runs
      add constraint party_runs_run_no_uniq unique (party_id, run_no);
  end if;

  if exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'party_runs'
           and column_name = 'run_no' and is_nullable = 'YES'
      )
     and not exists (select 1 from public.party_runs where run_no is null) then
    alter table public.party_runs alter column run_no set not null;
  end if;
end
$$;

comment on column public.party_runs.run_no is
  '파티 안에서 일정을 부르는 번호(1부터). 주차를 넣지 않아 일정을 미뤄도 번호가 변하지 않는다. **재배열/재사용 금지.**';

create or replace function public.party_runs_assign_run_no()
returns trigger
language plpgsql
as $func$
declare
  v_next smallint;
begin
  if new.run_no is not null then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('party_run:' || new.party_id::text, 0));

  select (coalesce(max(run_no), 0) + 1)::smallint
    into v_next
    from public.party_runs
   where party_id = new.party_id;

  new.run_no := v_next;
  return new;
end;
$func$;

drop trigger if exists party_runs_assign_run_no on public.party_runs;
create trigger party_runs_assign_run_no
  before insert on public.party_runs
  for each row execute function public.party_runs_assign_run_no();

-- -----------------------------------------------------------------------------
-- 14-3. seat_no 를 쓰던 곳을 member_no 로 옮긴다
-- -----------------------------------------------------------------------------

-- (a) 분배 가중치 뷰
drop view if exists public.v_run_share_weights cascade;
create view public.v_run_share_weights
with (security_invoker = true) as
select
  s.run_id,
  s.participant_id,
  pp.member_no,
  pp.user_id,
  pp.guest_id,
  pp.display_name,
  s.share_bp,
  case
    when r.share_mode = 'auto_equal' then 1
    when coalesce(sum(s.share_bp) over (partition by s.run_id), 0) = 0 then 1
    else s.share_bp
  end as weight
from public.run_signups s
join public.party_runs r          on r.id = s.run_id
join public.party_participants pp on pp.id = s.participant_id
where s.status = 'going';

comment on view public.v_run_share_weights is
  '런별 분배 가중치. 균등 모드는 1(정확한 1/n), 사용자 지정 모드는 share_bp. 게스트도 포함된다.';

-- v_run_share_weights 를 참조하던 뷰들을 다시 만든다(cascade 로 함께 내려갔다).
drop view if exists public.v_run_crystal_settlement;
create view public.v_run_crystal_settlement
with (security_invoker = true) as
with run_pot as (
  select bc.run_id,
         max(bc.pot_meso)   as pot_meso,
         max(bc.party_size) as party_size,
         min(bc.week_key)   as week_key
  from public.boss_clears bc
  where bc.run_id is not null
    and bc.effective_cleared
    and bc.pot_meso is not null
  group by bc.run_id
),
agg as (
  select w.run_id,
         array_agg(w.participant_id order by w.participant_id) as keys,
         array_agg(w.weight order by w.participant_id)         as weights
  from public.v_run_share_weights w
  group by w.run_id
)
select
  p.run_id,
  p.week_key,
  p.pot_meso,
  p.party_size,
  d.key    as participant_id,
  w.member_no,
  w.user_id,
  w.display_name,
  w.share_bp,
  d.amount as amount_meso
from run_pot p
join agg a on a.run_id = p.run_id
cross join lateral public.distribute_meso(p.pot_meso, a.keys, a.weights) d
join public.v_run_share_weights w
  on w.run_id = p.run_id and w.participant_id = d.key;

comment on view public.v_run_crystal_settlement is
  '결정석 pot 의 참가자별 정산 결과. 게스트 포함 전원이 대상이라 amount_meso 합계가 pot 과 정확히 일치한다.';

drop view if exists public.v_run_drop_recipients cascade;
create view public.v_run_drop_recipients
with (security_invoker = true) as
select d.id as drop_id, w.participant_id, w.weight
from public.run_drops d
join public.v_run_share_weights w on w.run_id = d.run_id
where d.share_mode = 'party_default'
union all
select d.id, s.participant_id, s.share_bp
from public.run_drops d
join public.run_drop_shares s on s.drop_id = d.id
where d.share_mode = 'custom'
  and s.share_bp > 0
union all
select d.id, d.solo_participant_id, 1
from public.run_drops d
where d.share_mode = 'solo'
  and d.solo_participant_id is not null;

comment on view public.v_run_drop_recipients is
  '드랍 건별 수령자와 가중치. party_default/custom/solo 세 방식을 하나로 해석한다.';

drop view if exists public.v_run_drop_settlement;
create view public.v_run_drop_settlement
with (security_invoker = true) as
with agg as (
  select rc.drop_id,
         array_agg(rc.participant_id order by rc.participant_id) as keys,
         array_agg(rc.weight order by rc.participant_id)         as weights
  from public.v_run_drop_recipients rc
  group by rc.drop_id
)
select
  d.id       as drop_id,
  d.run_id,
  d.week_key,
  d.item_name,
  d.share_mode,
  d.sale_amount_meso,
  x.key      as participant_id,
  pp.member_no,
  pp.user_id,
  pp.display_name,
  x.amount   as amount_meso
from public.run_drops d
join agg a on a.drop_id = d.id
cross join lateral public.distribute_meso(d.sale_amount_meso, a.keys, a.weights) x
join public.party_participants pp on pp.id = x.key
where d.sale_amount_meso is not null;

comment on view public.v_run_drop_settlement is
  '드랍 건별 참가자 정산. 미판매(금액 null)는 제외되며 합계는 판매 금액과 정확히 일치한다.';

drop view if exists public.v_weekly_drop_income cascade;
create view public.v_weekly_drop_income
with (security_invoker = true) as
select
  s.user_id,
  s.week_key,
  sum(s.amount_meso)::bigint  as drop_income_meso,
  count(*)                    as drop_share_count,
  count(distinct s.drop_id)   as drop_count
from public.v_run_drop_settlement s
where s.user_id is not null
group by s.user_id, s.week_key;

comment on view public.v_weekly_drop_income is
  '사용자 × 주차 기타 드랍 수익. 결정석 12개 한도와 무관한 별도 계통이다.';

drop view if exists public.v_weekly_income;
create view public.v_weekly_income
with (security_invoker = true) as
with keys as (
  select user_id, week_key from public.v_weekly_crystal_income
  union
  select user_id, week_key from public.v_weekly_drop_income
  union
  select user_id, week_key from public.v_weekly_unsold_drops
)
select
  k.user_id,
  k.week_key,
  coalesce(c.income_meso, 0)             as crystal_income_meso,
  coalesce(c.clear_count, 0)             as clear_count,
  coalesce(c.weekly_clear_count, 0)      as weekly_clear_count,
  coalesce(c.unknown_price_count, 0)     as unknown_price_count,
  coalesce(c.weekly_over_limit_count, 0) as weekly_over_limit_count,
  coalesce(d.drop_income_meso, 0)        as drop_income_meso,
  coalesce(d.drop_count, 0)              as drop_count,
  coalesce(u.unsold_drop_count, 0)       as unsold_drop_count,
  (coalesce(c.income_meso, 0) + coalesce(d.drop_income_meso, 0))::bigint as total_income_meso
from keys k
left join public.v_weekly_crystal_income c on c.user_id = k.user_id and c.week_key = k.week_key
left join public.v_weekly_drop_income    d on d.user_id = k.user_id and d.week_key = k.week_key
left join public.v_weekly_unsold_drops   u on u.user_id = k.user_id and u.week_key = k.week_key;

comment on view public.v_weekly_income is
  '주간 총수익 = 결정석 분배 몫 + 드랍 분배 몫. 두 계통을 분리해 보여준다(12개 한도는 결정석에만 적용). 미판매 드랍은 금액이 아니라 건수로 보고한다.';

-- (b) 균등 분배의 결정론적 순서
create or replace function public.rebalance_run_shares(p_run_id uuid)
returns integer
language plpgsql
as $func$
declare
  v_mode  public.run_share_mode;
  v_n     integer;
  v_total integer;
  v_rows  integer := 0;
begin
  select r.share_mode into v_mode from public.party_runs r where r.id = p_run_id;
  if not found then
    return 0;
  end if;

  update public.run_signups
     set share_bp = 0
   where run_id = p_run_id and status <> 'going' and share_bp <> 0;

  select count(*), coalesce(sum(share_bp), 0)
    into v_n, v_total
    from public.run_signups
   where run_id = p_run_id and status = 'going';

  if v_n = 0 then
    return 0;
  end if;

  if v_mode = 'manual' and v_total = 10000 then
    return 0;
  end if;

  if v_mode = 'auto_equal' or v_total = 0 then
    -- 균등 분배. 나머지는 **파티원 번호 순**으로 앞에서부터 1씩. 완전 결정론적이다.
    with ordered as (
      select s.id, row_number() over (order by pp.member_no) as rn
        from public.run_signups s
        join public.party_participants pp on pp.id = s.participant_id
       where s.run_id = p_run_id and s.status = 'going'
    )
    update public.run_signups s
       set share_bp = (10000 / v_n) + case when o.rn <= (10000 % v_n) then 1 else 0 end
      from ordered o
     where s.id = o.id
       and s.share_bp is distinct from
           ((10000 / v_n) + case when o.rn <= (10000 % v_n) then 1 else 0 end);
    get diagnostics v_rows = row_count;
  else
    with recipients as (
      select id, share_bp
        from public.run_signups
       where run_id = p_run_id and status = 'going'
    ),
    agg as (
      select array_agg(id order by id) as keys,
             array_agg(share_bp order by id) as weights
      from recipients
    ),
    dist as (
      select d.key, d.amount
      from agg, public.distribute_meso(10000, agg.keys, agg.weights) d
    )
    update public.run_signups s
       set share_bp = dist.amount::integer
      from dist
     where s.id = dist.key
       and s.share_bp is distinct from dist.amount::integer;
    get diagnostics v_rows = row_count;
  end if;

  return v_rows;
end;
$func$;

-- (c) 알림 문구의 이름 나열 순서
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

  -- 이름은 display_name 스냅샷만 쓰고, 순서는 파티원 번호를 따른다.
  select array_agg(pp.display_name order by pp.member_no), count(*)
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

  v_line := v_when || ' '
         || case when v_no is not null then v_no::text || '파티 ' else '' end
         || v_boss
         || ' (' || v_names_s || ')';

  v_line := case p_kind
    when 'created' then '📌 ' || v_line
    when 'remind'  then '⏰ 30분 전' || chr(10) || v_line
    else v_line
  end;

  if length(v_line) > 350 then
    v_line := left(v_line, 347) || '...';
  end if;

  return v_line;
end;
$func$;

-- (d) seat_no 제거 — 트리거 → 함수 → 컬럼 순
drop trigger if exists run_signups_assign_seat_no on public.run_signups;
drop function if exists public.run_signups_assign_seat_no();

alter table public.run_signups drop column if exists seat_no cascade;

-- -----------------------------------------------------------------------------
-- 14-4. 공개 컬럼 권한 재정리
-- -----------------------------------------------------------------------------
-- member_no / run_no 는 seat_no 와 같은 성격의 **관리 번호**다. 금전 정보가 아니고,
-- 공개 시간표에서 "1번 우레푸", "#2 하드 스우"로 표시하는 데 쓴다(§1.4).
revoke all on table public.party_participants from anon;
revoke all on table public.party_participants from authenticated;
grant select (
  id, party_id, display_name, role, member_no, joined_at, left_at, created_at, updated_at
) on table public.party_participants to anon, authenticated;

revoke all on table public.party_runs from anon;
revoke all on table public.party_runs from authenticated;
grant select (
  id, party_id, boss_difficulty_id, scheduled_at, duration_minutes, status,
  capacity, entry_party_size, week_key, run_no, note, created_at, updated_at, cancelled_at
) on table public.party_runs to anon, authenticated;

-- seat_no 가 사라졌으므로 run_signups 권한도 다시 명시한다.
revoke all on table public.run_signups from anon;
revoke all on table public.run_signups from authenticated;
grant select (
  id, run_id, participant_id, status, created_at, updated_at
) on table public.run_signups to anon, authenticated;

-- cascade 로 다시 만든 뷰들의 권한을 복구한다.
do $$
declare
  v text;
  private_views text[] := array[
    'v_run_share_weights',
    'v_run_crystal_settlement',
    'v_run_drop_recipients',
    'v_run_drop_settlement',
    'v_weekly_drop_income',
    'v_weekly_income'
  ];
begin
  foreach v in array private_views loop
    execute format('revoke all on table public.%I from anon', v);
    execute format('revoke all on table public.%I from authenticated', v);
    execute format('grant all on table public.%I to service_role', v);
  end loop;
end
$$;

-- -----------------------------------------------------------------------------
-- 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_missing text;
  v_rls_off text;
begin
  perform public.assert_no_public_sensitive_columns();

  -- seat_no 가 실제로 사라졌는가
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='run_signups' and column_name='seat_no') then
    raise exception 'run_signups.seat_no 가 아직 남아 있습니다.';
  end if;

  -- 새 번호가 공개 시간표에서 읽히는가(표시용이므로 열려 있어야 한다)
  if not has_column_privilege('anon', 'public.party_participants', 'member_no', 'SELECT')
     or not has_column_privilege('anon', 'public.party_runs', 'run_no', 'SELECT') then
    raise exception '관리 번호가 공개 시간표에서 읽히지 않습니다.';
  end if;

  -- 방 바인딩은 여전히 비공개여야 한다
  if has_column_privilege('anon', 'public.parties', 'bot_channel_id', 'SELECT') then
    raise exception 'parties.bot_channel_id 가 anon 에게 노출되어 있습니다.';
  end if;

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

  select string_agg(distinct table_name, ', ') into v_missing
  from information_schema.role_table_grants
  where table_schema = 'public'
    and grantee in ('anon', 'authenticated')
    and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER');
  if v_missing is not null then
    raise exception 'anon/authenticated 에 쓰기 권한이 남아 있는 객체: %', v_missing;
  end if;
end
$$;

select public.assert_no_public_sensitive_columns();
