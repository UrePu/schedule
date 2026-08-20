-- =============================================================================
-- 33. 교대 근무 — N일 주기 패턴(A) + 근무 프리셋·달력 배정(B)
-- =============================================================================
--
-- 발주자(2026-08-20): *"내 가능시간에 2교대 3교대 하는사람도 등록할수있게"* → A + B 둘 다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 왜 요일 패턴으로는 안 되는가
-- ─────────────────────────────────────────────────────────────────────────────
-- `availability_patterns` 는 ISO 요일 1~7 반복이다. 그런데 교대는 **요일이 아니라 N일
-- 주기**로 돈다 — 주주야야비비면 6일, 4조 3교대면 8일이라 요일과 영영 맞물리지 않는다.
-- 2교대 주 단위 로테이션(이번 주 주간·다음 주 야간)조차 "화요일 = 항상 이 시간" 으로는
-- 쓸 수 없다.
--
-- 우회로(넓은 합집합 패턴 + 근무시간 예외 빼기)는 예외를 **하나라도 빠뜨리면 근무 중인
-- 시간이 "가능" 으로 남는다.** §1.4 가 못박은 대로 거짓 "가능" 은 못 오는 사람을 파티에
-- 앉히는, 가장 비싼 실패다. 그래서 구조로 푼다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A · 주기를 요일이 아니라 **N일**로 일반화한다
-- ─────────────────────────────────────────────────────────────────────────────
-- 지금의 요일 패턴은 **cycle_days = 7 인 특수 케이스**다. 그래서 새 축을 하나 더 만드는
-- 대신, 사람마다 주기를 갖게 하고 패턴 행이 둘 중 한 축에만 붙게 한다.
--   · 주기가 없는 사람(대부분) → 지금과 **한 글자도 다르지 않게** 요일축으로 돈다.
--   · 주기가 있는 사람 → cycle_day 축(0 … cycle_days-1)으로 돈다.
-- ★ 주기를 켜면 그 사람의 **요일 행은 무시된다. 지우지는 않는다** — 되돌리면 그대로
--   살아난다. 데이터를 태우지 않고 모드를 오갈 수 있어야 사람이 실험을 해 본다.
-- ⚠️ 주기를 켠 직후에는 cycle_day 행이 없어 **가용시간이 빈다.** 의도된 방향이다 —
--    거짓 "불가" 는 슬롯 하나를 놓치지만 거짓 "가능" 은 사람을 잘못 앉힌다(§1.4).
--
-- ─────────────────────────────────────────────────────────────────────────────
-- B · 근무표가 불규칙한 사람을 위한 **프리셋 + 달력 배정**
-- ─────────────────────────────────────────────────────────────────────────────
-- 병원·공장처럼 근무표가 매달 따로 나오면 주기로 표현할 수 없다. 그래서 주간/오후/야간을
-- **프리셋**으로 정의해 두고 달력에 날짜별로 찍는다. 찍힌 근무시간은 가용시간에서 빠진다.
--
-- ★ **배정은 예외 행을 만들지 않는다.** 배정에서 예외를 자동 생성하면 같은 사실이 두 곳에
--   저장되고(배정 + 생성된 예외) 반드시 갈라진다. 대신 해석기가 **뺄셈 항을 하나 더** 갖는다:
--   실효 가능시간 = 패턴 − 예외 − 근무배정. 구현은 여전히 DB 한 곳뿐이라 웹·봇이 못 갈라진다.
-- ★ 하루에 근무는 **하나**다(유니크). 맞교대로 두 번 뛰는 날은 그 구간을 덮는 프리셋을 하나
--   만들어 쓴다 — 표현이 하나여야 "같은 뜻인데 저장 형태가 둘" 이 안 생긴다.

-- -----------------------------------------------------------------------------
-- 33-1. availability_cycles — 사람당 최대 하나
-- -----------------------------------------------------------------------------
create table if not exists public.availability_cycles (
  id          uuid primary key default gen_random_uuid(),

  -- availability_patterns 와 동일한 널러블 FK 방식. 게스트도 교대 근무를 한다.
  user_id     uuid references public.app_users(id) on delete cascade,
  guest_id    uuid references public.guest_profiles(id) on delete cascade,

  -- 2 미만은 두지 않는다. "매일 같음" 은 요일 7칸을 같게 칠하면 되고, 1을 허용하면
  -- 같은 뜻의 저장 형태가 둘이 된다. 28일이면 4조 3교대(8일)·주주야야비비(6일)·
  -- 격주(14일)를 전부 덮는다.
  cycle_days  smallint not null check (cycle_days between 2 and 28),

  -- 주기의 **0번 칸에 해당하는 KST 날짜**. 화면은 "이 날이 1번" 으로 보여 준다.
  anchor_date date not null,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint availability_cycles_one_owner check (num_nonnulls(user_id, guest_id) = 1)
);

comment on table public.availability_cycles is
  '사람의 교대 주기(N일). 없으면 요일(7일) 패턴으로 돈다. 있으면 availability_patterns.cycle_day 축만 유효하다.';
comment on column public.availability_cycles.anchor_date is
  '주기 0번 칸의 KST 날짜. 칸 번호 = ((대상날짜 - anchor_date) mod cycle_days) 이며 음수는 보정한다.';

create unique index if not exists availability_cycles_user_uniq
  on public.availability_cycles (user_id) where user_id is not null;
create unique index if not exists availability_cycles_guest_uniq
  on public.availability_cycles (guest_id) where guest_id is not null;

drop trigger if exists availability_cycles_set_updated_at on public.availability_cycles;
create trigger availability_cycles_set_updated_at
  before update on public.availability_cycles
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 33-2. availability_patterns 에 주기축을 붙인다
-- -----------------------------------------------------------------------------
alter table public.availability_patterns
  add column if not exists cycle_day smallint;

alter table public.availability_patterns
  alter column weekday drop not null;

comment on column public.availability_patterns.weekday is
  'ISO 요일 1=월 … 7=일. 주기(availability_cycles)를 쓰지 않는 사람의 축이다. cycle_day 와 정확히 하나만 채운다.';
comment on column public.availability_patterns.cycle_day is
  '교대 주기 칸 번호(0 … cycle_days-1). 주기를 쓰는 사람의 축이다. weekday 와 정확히 하나만 채운다.';

alter table public.availability_patterns
  drop constraint if exists availability_patterns_one_axis;
alter table public.availability_patterns
  add constraint availability_patterns_one_axis
  check (num_nonnulls(weekday, cycle_day) = 1);

alter table public.availability_patterns
  drop constraint if exists availability_patterns_cycle_day_range;
alter table public.availability_patterns
  add constraint availability_patterns_cycle_day_range
  check (cycle_day is null or cycle_day between 0 and 27);

create index if not exists availability_patterns_user_cycle_idx
  on public.availability_patterns (user_id, cycle_day)
  where user_id is not null and cycle_day is not null;
create index if not exists availability_patterns_guest_cycle_idx
  on public.availability_patterns (guest_id, cycle_day)
  where guest_id is not null and cycle_day is not null;

-- -----------------------------------------------------------------------------
-- 33-3. shift_presets — 근무 한 종류(주간·오후·야간…)
-- -----------------------------------------------------------------------------
-- ★ 여기 적히는 시간은 **가능시간이 아니라 근무시간**이다. 해석기가 이걸 빼낸다.
--   자정 넘김은 패턴과 같은 규칙(end_minute > 1440)으로 한 행에 담는다 — 야간 22:00~06:00
--   은 1320~1800 이고, 쪼개면 "밤 10시부터 아침 6시까지" 라는 한 덩어리 의도가 사라진다.
create table if not exists public.shift_presets (
  id           uuid primary key default gen_random_uuid(),

  user_id      uuid references public.app_users(id) on delete cascade,
  guest_id     uuid references public.guest_profiles(id) on delete cascade,

  name         text not null check (length(btrim(name)) between 1 and 12),
  start_minute integer not null check (start_minute between 0 and 1439),
  end_minute   integer not null check (end_minute between 1 and 2880),
  sort_order   smallint not null default 0,

  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint shift_presets_one_owner check (num_nonnulls(user_id, guest_id) = 1),
  constraint shift_presets_range     check (end_minute > start_minute),
  constraint shift_presets_max_span  check (end_minute - start_minute <= 1440)
);

comment on table public.shift_presets is
  '근무 프리셋(주간·오후·야간 등). 여기 적힌 구간은 근무시간이며 실효 가능시간에서 빠진다.';
comment on column public.shift_presets.end_minute is
  '1440 초과 = 자정 넘김. 야간 22:00~06:00 은 1320~1800 한 행이다(쪼개지 않는다).';

create unique index if not exists shift_presets_user_name_uniq
  on public.shift_presets (user_id, name) where user_id is not null;
create unique index if not exists shift_presets_guest_name_uniq
  on public.shift_presets (guest_id, name) where guest_id is not null;

drop trigger if exists shift_presets_set_updated_at on public.shift_presets;
create trigger shift_presets_set_updated_at
  before update on public.shift_presets
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 33-4. shift_assignments — 어느 날 어느 근무인가
-- -----------------------------------------------------------------------------
-- 행이 없는 날 = 근무 없음(비번·휴무). 별도 종류를 두지 않는다 — 뺄셈 관점에서 "안 뺀다"
-- 로 완전히 같은 말이고, 표현이 둘이면 어느 쪽이 진짜인지 아무도 모르게 된다.
create table if not exists public.shift_assignments (
  id         uuid primary key default gen_random_uuid(),

  user_id    uuid references public.app_users(id) on delete cascade,
  guest_id   uuid references public.guest_profiles(id) on delete cascade,

  -- KST 달력 날짜. 순간이 아니라 근무 날짜이므로 date 가 정확한 타입이다.
  work_date  date not null,
  preset_id  uuid not null references public.shift_presets(id) on delete cascade,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint shift_assignments_one_owner check (num_nonnulls(user_id, guest_id) = 1)
);

comment on table public.shift_assignments is
  '날짜별 근무 배정. 하루 하나. 행이 없는 날은 근무 없음(비번)이다. 배정된 근무시간은 실효 가능시간에서 빠진다.';

create unique index if not exists shift_assignments_user_day_uniq
  on public.shift_assignments (user_id, work_date) where user_id is not null;
create unique index if not exists shift_assignments_guest_day_uniq
  on public.shift_assignments (guest_id, work_date) where guest_id is not null;

drop trigger if exists shift_assignments_set_updated_at on public.shift_assignments;
create trigger shift_assignments_set_updated_at
  before update on public.shift_assignments
  for each row execute function public.set_updated_at();

-- ★ 프리셋의 주인과 배정의 주인이 같아야 한다. 복합 FK 로는 걸 수 없어(널러블 소유 컬럼
--   두 개 + 부분 유니크) 트리거로 막는다. 앱 코드의 버그가 남의 근무표를 내 달력에 붙이는
--   일을 DB 가 직접 거부해야 한다.
create or replace function public.shift_assignment_owner_matches_preset()
returns trigger
language plpgsql
as $func$
declare
  v_user  uuid;
  v_guest uuid;
begin
  select user_id, guest_id into v_user, v_guest
    from public.shift_presets where id = new.preset_id;

  if v_user is distinct from new.user_id or v_guest is distinct from new.guest_id then
    raise exception '근무 배정의 주인과 프리셋의 주인이 다릅니다 (preset=%).', new.preset_id
      using errcode = 'check_violation';
  end if;

  return new;
end
$func$;

drop trigger if exists shift_assignments_owner_guard on public.shift_assignments;
create trigger shift_assignments_owner_guard
  before insert or update on public.shift_assignments
  for each row execute function public.shift_assignment_owner_matches_preset();

-- -----------------------------------------------------------------------------
-- 33-5. 해석기 — 패턴(요일 또는 주기) − 예외 − 근무배정
-- -----------------------------------------------------------------------------
-- 바뀐 곳은 둘뿐이다.
--   ① 패턴 조인이 사람의 주기 유무를 본다(주기가 없으면 예전과 완전히 같은 조건).
--   ② 뺄셈 항에 근무 배정이 더해진다. multirange 합집합이라 겹쳐도 무해하다.
-- 자정 넘김은 여전히 절대 시각 위에서 계산되므로 특별 취급이 없다.
create or replace function public.resolve_availability(
  p_person_ids uuid[],
  p_from       timestamptz,
  p_to         timestamptz
)
returns table (
  person_id uuid,
  starts_at timestamptz,
  ends_at   timestamptz
)
language sql
stable
parallel safe
as $func$
  with bounds as (
    -- 전날의 자정 넘김 구간(22:00~02:00)이 오늘 범위로 넘어올 수 있으므로 하루 앞에서 시작한다.
    select public.kst_date(p_from) - 1 as d0,
           public.kst_date(p_to)       as d1
  ),
  days as (
    select (b.d0 + g)::date as kst_date
    from bounds b, generate_series(0, (b.d1 - b.d0)) as g
  ),
  -- 패턴이 만드는 가능 구간 (사람별로 합집합)
  pattern_ranges as (
    select coalesce(p.user_id, p.guest_id) as person_id,
           range_agg(tstzrange(
             public.kst_moment(d.kst_date, p.start_minute),
             public.kst_moment(d.kst_date, p.end_minute),
             '[)'
           )) as available
    from days d
    cross join public.availability_patterns p
    left join public.availability_cycles c
      on c.user_id is not distinct from p.user_id
     and c.guest_id is not distinct from p.guest_id
    where (p.user_id = any(p_person_ids) or p.guest_id = any(p_person_ids))
      and case
            -- 주기가 없는 사람: 예전 그대로 요일축.
            when c.id is null then p.weekday = extract(isodow from d.kst_date)::smallint
            -- 주기가 있는 사람: 주기축만 본다. 남아 있는 요일 행은 조용히 무시된다.
            else p.cycle_day = (
                   ((d.kst_date - c.anchor_date) % c.cycle_days + c.cycle_days) % c.cycle_days
                 )::smallint
          end
    group by 1
  ),
  -- 예외가 빼앗는 구간 (사람별로 합집합)
  exception_ranges as (
    select coalesce(e.user_id, e.guest_id) as person_id,
           range_agg(tstzrange(
             public.kst_moment(e.exception_date, e.start_minute),
             public.kst_moment(e.exception_date, e.end_minute),
             '[)'
           )) as blocked
    from public.availability_exceptions e, bounds b
    where (e.user_id = any(p_person_ids) or e.guest_id = any(p_person_ids))
      and e.exception_date between b.d0 and b.d1
    group by 1
  ),
  -- 배정된 근무가 빼앗는 구간 (사람별로 합집합)
  shift_ranges as (
    select coalesce(a.user_id, a.guest_id) as person_id,
           range_agg(tstzrange(
             public.kst_moment(a.work_date, s.start_minute),
             public.kst_moment(a.work_date, s.end_minute),
             '[)'
           )) as blocked
    from public.shift_assignments a
    join public.shift_presets s on s.id = a.preset_id
    cross join bounds b
    where (a.user_id = any(p_person_ids) or a.guest_id = any(p_person_ids))
      and a.work_date between b.d0 and b.d1
    group by 1
  ),
  effective as (
    select pr.person_id,
           unnest(
             pr.available
             - ( coalesce(er.blocked, '{}'::tstzmultirange)
               + coalesce(sr.blocked, '{}'::tstzmultirange) )
           ) as r
    from pattern_ranges pr
    left join exception_ranges er on er.person_id = pr.person_id
    left join shift_ranges     sr on sr.person_id = pr.person_id
  )
  select e.person_id,
         greatest(lower(e.r), p_from) as starts_at,
         least(upper(e.r), p_to)      as ends_at
  from effective e
  where lower(e.r) < p_to
    and upper(e.r) > p_from;
$func$;

comment on function public.resolve_availability(uuid[], timestamptz, timestamptz) is
  '실효 가능시간 = 패턴(요일 또는 N일 주기) − 예외 − 배정된 근무. multirange 뺄셈이라 자정 넘김도 특별 취급이 없다. 웹·봇이 공유하는 유일한 구현.';

-- -----------------------------------------------------------------------------
-- 33-6. RLS — 앱은 service_role 로만 접근한다(가용시간 두 표와 동일 규칙)
-- -----------------------------------------------------------------------------
alter table public.availability_cycles  enable row level security;
alter table public.shift_presets        enable row level security;
alter table public.shift_assignments    enable row level security;

revoke all on table public.availability_cycles from anon, authenticated;
revoke all on table public.shift_presets       from anon, authenticated;
revoke all on table public.shift_assignments   from anon, authenticated;

grant all on table public.availability_cycles to service_role;
grant all on table public.shift_presets       to service_role;
grant all on table public.shift_assignments   to service_role;

drop policy if exists availability_cycles_no_public_access on public.availability_cycles;
create policy availability_cycles_no_public_access on public.availability_cycles
  as permissive for all to anon, authenticated using (false) with check (false);
drop policy if exists availability_cycles_service_role_all on public.availability_cycles;
create policy availability_cycles_service_role_all on public.availability_cycles
  as permissive for all to service_role using (true) with check (true);

drop policy if exists shift_presets_no_public_access on public.shift_presets;
create policy shift_presets_no_public_access on public.shift_presets
  as permissive for all to anon, authenticated using (false) with check (false);
drop policy if exists shift_presets_service_role_all on public.shift_presets;
create policy shift_presets_service_role_all on public.shift_presets
  as permissive for all to service_role using (true) with check (true);

drop policy if exists shift_assignments_no_public_access on public.shift_assignments;
create policy shift_assignments_no_public_access on public.shift_assignments
  as permissive for all to anon, authenticated using (false) with check (false);
drop policy if exists shift_assignments_service_role_all on public.shift_assignments;
create policy shift_assignments_service_role_all on public.shift_assignments
  as permissive for all to service_role using (true) with check (true);

-- -----------------------------------------------------------------------------
-- 33-7. 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_count integer;
  v_def   text;
  v_rls   boolean;
  v_priv  boolean;
  t       text;
begin
  -- ⓪ 기존 패턴은 전부 요일축이어야 한다. 하나라도 축이 비면 새 CHECK 가 이미 막았겠지만,
  --    "마이그레이션이 통과했다" 와 "데이터가 옳다" 는 다른 말이다.
  select count(*) into v_count
    from public.availability_patterns where weekday is null;
  if v_count <> 0 then
    raise exception '33: 요일이 빈 기존 패턴이 %건 있습니다.', v_count;
  end if;

  -- ① 아직 주기·배정이 하나도 없다 = 이 마이그레이션은 기존 사용자의 가용시간을
  --    한 글자도 바꾸지 않는다(해석기의 두 새 항이 모두 공집합이다).
  select count(*) into v_count from public.availability_cycles;
  if v_count <> 0 then
    raise exception '33: 새 표에 주기가 %건 들어 있습니다.', v_count;
  end if;
  select count(*) into v_count from public.shift_assignments;
  if v_count <> 0 then
    raise exception '33: 새 표에 근무 배정이 %건 들어 있습니다.', v_count;
  end if;

  -- ② 해석기가 실제로 두 새 항을 갖고 있는가. 함수를 갈아 끼운 것이 이 파일의 핵심이라
  --    "만들어 두고 연결을 잊는" 실패를 여기서 잡는다.
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'resolve_availability';
  if v_def not like '%shift_assignments%' then
    raise exception '33: resolve_availability 가 근무 배정을 빼지 않습니다.';
  end if;
  if v_def not like '%availability_cycles%' then
    raise exception '33: resolve_availability 가 주기를 보지 않습니다.';
  end if;

  -- ③ RLS 와 공개 권한.
  foreach t in array array['availability_cycles', 'shift_presets', 'shift_assignments'] loop
    select c.relrowsecurity into v_rls
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = t;
    if not coalesce(v_rls, false) then
      raise exception '33: % 에 RLS 가 꺼져 있습니다.', t;
    end if;

    select bool_or(has_table_privilege(r, 'public.' || t, 'select'))
      into v_priv
      from unnest(array['anon', 'authenticated']) as r;
    if coalesce(v_priv, false) then
      raise exception '33: % 가 anon/authenticated 에 열려 있습니다.', t;
    end if;
  end loop;
end
$$;

select public.assert_no_public_sensitive_columns();
