-- =============================================================================
-- 36. 가능시간 방식은 **배타 선택**이다 — 요일 반복 vs 교대·달력
-- =============================================================================
--
-- 발주자(2026-09-03): *"요일별 / 교대 * 달력 둘중 하나만 쓰도록 하는거임. 막 겹쳐져서
--   써지는게 아니고 가능시간 설정시 요일별 반복 or 교대 달력을 선택하는 모달이 먼저 나오고
--   선택했을때 다른것들은 없어지게 설정."*
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 무엇이 잘못돼 있었나
-- ─────────────────────────────────────────────────────────────────────────────
-- 35 까지의 실효 가능시간은
--     실효 = ( 패턴[요일축 or 주기축] − 지정된 날 전체 + 지정된 날의 시간대 ) − 예외
-- 였다. 여기서 "요일 반복을 쓰는가, 교대·달력을 쓰는가" 를 가르는 것처럼 보이는 유일한
-- 스위치는 `availability_cycles` 행의 유무인데, 그건 **패턴의 축(요일이냐 주기냐)만** 가른다.
-- `shift_assignments`(날짜별 지정)는 주기가 꺼져 있어도 **언제나 그 위에 얹혔다.**
--
-- 실측(2026-09-03, 발주자 계정 `더저`): 요일 패턴 7줄 · 주기 없음 · 달력 지정 6일.
-- 2026-09-05(토)에 요일 패턴 14:00~23:30 이 통째로 지워지고 달력의 15:00~24:00 이 대신
-- 적용되고 있었다. 두 방식이 **소리 없이 섞였고**, 어느 쪽이 이겼는지 화면 어디에도 없다.
-- §1.4 의 기준으로 보면 이건 거짓 "불가"(요일 패턴이 사라짐)와 거짓 "가능"(달력이 열림)을
-- 한 번에 만드는 상태다. 사용자가 예측할 수 없는 것이 가장 나쁘다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 새 규칙 — 사람마다 방식은 하나. 고르지 않은 쪽은 **계산에서 통째로 빠진다**
-- ─────────────────────────────────────────────────────────────────────────────
--   · mode = 'weekly' → 요일축 패턴만. `shift_assignments` 를 **아예 읽지 않는다.**
--   · mode = 'shift'  → 주기축 패턴(주기가 있을 때만) − 지정된 날 전체 + 지정된 날의 시간대.
--                       요일축 패턴을 **아예 읽지 않는다.**
--   · 예외(`availability_exceptions`)는 두 모드 공통이며 **언제나 마지막 뺄셈**이다.
--
-- ★ 교대 모드 **안에서는** 주기 격자와 달력이 둘 다 유효하다. 35 의 설계를 그대로 둔다 —
--   교대 근무자에게 그 둘은 같은 이야기의 앞뒤(정규 로테이션 + 그 달의 실제 근무표)다.
-- ★ **반대쪽 데이터는 절대 지우지 않는다.** 무시할 뿐이고, 방식을 되돌리면 그대로 다시
--   쓰인다. 이건 33 이 주기에 대해 이미 정한 규칙("지우지는 않는다")을 방식 전체로 넓힌
--   것이다. 데이터를 태우면 사람이 방식을 시험해 보지 못한다.
-- ★ **모드 행이 없는 기존 사용자는 전원 `weekly`** 로 동작한다. 백필하지 않는다 —
--   해석기가 `coalesce(..., 'weekly')` 로 읽으므로 행이 없는 것과 'weekly' 행이 있는 것이
--   정확히 같은 뜻이고, 뜻이 같은 상태를 굳이 행으로 만들면 나중에 둘이 갈라진다.
--   ⚠️ 결과적으로 달력만 찍어 두고 주기가 없던 사람(= 발주자 계정)은 이 마이그레이션
--      직후 요일 패턴대로 돌아간다. 의도된 변화이며, 위 실측이 바로 그 상태다.

-- -----------------------------------------------------------------------------
-- 36-1. 방식 열거형
-- -----------------------------------------------------------------------------
-- 불리언(`use_shift`)이 아니라 열거형인 이유: 방식이 셋째로 늘어날 여지가 실제로 있고
-- (예: 날짜 없이 "이번 주만" 같은 임시 축), 불리언은 그때 이름부터 거짓말이 된다.
do $$
begin
  create type public.availability_mode as enum ('weekly', 'shift');
exception
  when duplicate_object then null;
end
$$;

-- -----------------------------------------------------------------------------
-- 36-2. availability_modes — 사람당 최대 하나
-- -----------------------------------------------------------------------------
create table if not exists public.availability_modes (
  id         uuid primary key default gen_random_uuid(),

  -- 가용시간 표들과 동일한 널러블 FK 방식. 게스트도 방식을 고른다.
  user_id    uuid references public.app_users(id)      on delete cascade,
  guest_id   uuid references public.guest_profiles(id) on delete cascade,

  mode       public.availability_mode not null default 'weekly',

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint availability_modes_one_owner check (num_nonnulls(user_id, guest_id) = 1)
);

comment on table public.availability_modes is
  '사람이 고른 가능시간 방식. 행이 없으면 weekly 로 본다(백필하지 않는다). 고르지 않은 쪽의 데이터는 보존되며 계산에서 무시될 뿐이라, 방식을 되돌리면 그대로 다시 쓰인다.';
comment on column public.availability_modes.mode is
  'weekly = 요일축 패턴만 사용하고 shift_assignments 를 읽지 않는다. shift = 주기축 패턴 + 달력 지정만 사용하고 요일축 패턴을 읽지 않는다. 예외는 두 모드 공통이다.';

-- ★ **부분 인덱스가 아니라 전체 인덱스**다. 마이그레이션 34 의 교훈 — PostgREST 의
--   `upsert(onConflict:)` 는 컬럼 목록만 보내므로 `where ... is not null` 부분 인덱스는
--   `ON CONFLICT` 중재자로 뽑히지 않고 500 이 된다. 유니크 인덱스는 기본이 NULLS DISTINCT
--   라 전체 인덱스여도 "계정마다 하나" 라는 뜻은 그대로다.
create unique index if not exists availability_modes_user_uniq
  on public.availability_modes (user_id);
create unique index if not exists availability_modes_guest_uniq
  on public.availability_modes (guest_id);

drop trigger if exists availability_modes_set_updated_at on public.availability_modes;
create trigger availability_modes_set_updated_at
  before update on public.availability_modes
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- 36-3. RLS — 앱은 service_role 로만 접근한다(가용시간 표들과 동일 규칙)
-- -----------------------------------------------------------------------------
alter table public.availability_modes enable row level security;

revoke all on table public.availability_modes from anon, authenticated;

grant all on table public.availability_modes to service_role;

drop policy if exists availability_modes_no_public_access on public.availability_modes;
create policy availability_modes_no_public_access on public.availability_modes
  as permissive for all to anon, authenticated using (false) with check (false);
drop policy if exists availability_modes_service_role_all on public.availability_modes;
create policy availability_modes_service_role_all on public.availability_modes
  as permissive for all to service_role using (true) with check (true);

-- -----------------------------------------------------------------------------
-- 36-4. 해석기 — 모드에 따라 **배타적으로** 갈라진다
-- -----------------------------------------------------------------------------
-- 시그니처·반환 컬럼(`person_id, starts_at, ends_at`)·`stable parallel safe`·search_path 는
-- 35 와 한 글자도 다르지 않다. 앱이 `db.rpc("resolve_availability", ...)` 로 부르므로
-- 시그니처가 바뀌면 런타임에서 깨진다. 바뀐 것은 **본문의 분기**뿐이다.
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
set search_path to 'public', 'pg_temp'
as $func$
  with bounds as (
    -- 전날의 자정 넘김 구간(22:00~02:00)이 오늘 범위로 넘어올 수 있으므로 하루 앞에서 시작한다.
    select public.kst_date(p_from) - 1 as d0,
           public.kst_date(p_to)       as d1
  ),
  persons as (
    select distinct pid as person_id from unnest(p_person_ids) as pid
  ),
  -- 사람마다 방식을 **먼저** 확정한다. 이게 이 마이그레이션의 전부다.
  -- ★ 상관 서브쿼리인 이유: `left join ... on m.user_id = pe.person_id or m.guest_id = pe.person_id`
  --   은 OR 조인이라 이론상 사람 하나가 두 행에 걸릴 수 있고, 그러면 아래 CTE 들이 조용히
  --   행을 불린다. 서브쿼리는 사람당 정확히 한 값을 보장한다.
  -- ★ 행이 없으면 'weekly'. 기존 사용자를 백필하지 않기 위한 유일한 장치다.
  person_modes as (
    select pe.person_id,
           coalesce(
             (select m.mode
                from public.availability_modes m
               where m.user_id = pe.person_id
                  or m.guest_id = pe.person_id
               limit 1),
             'weekly'::public.availability_mode
           ) as mode
    from persons pe
  ),
  days as (
    select (b.d0 + g)::date as kst_date
    from bounds b, generate_series(0, (b.d1 - b.d0)) as g
  ),
  -- 패턴이 만드는 가능 구간. 축은 **모드가** 고른다(주기 유무가 아니다).
  --   · weekly → 요일축만. 주기 행이 남아 있어도 보지 않는다.
  --   · shift  → 주기축만. 주기가 없으면 **구간이 0개**다(달력만 쓰는 사람이 정확히 이 모양).
  --     그 사람의 요일 행은 지워지지 않고 그대로 보존되며, weekly 로 되돌리면 살아난다.
  pattern_ranges as (
    select coalesce(p.user_id, p.guest_id) as person_id,
           range_agg(tstzrange(
             public.kst_moment(d.kst_date, p.start_minute),
             public.kst_moment(d.kst_date, p.end_minute),
             '[)'
           )) as available
    from days d
    cross join public.availability_patterns p
    join person_modes pm
      on pm.person_id = coalesce(p.user_id, p.guest_id)
    left join public.availability_cycles c
      on c.user_id is not distinct from p.user_id
     and c.guest_id is not distinct from p.guest_id
    where (p.user_id = any(p_person_ids) or p.guest_id = any(p_person_ids))
      and case
            when pm.mode = 'weekly'
              then p.weekday = extract(isodow from d.kst_date)::smallint
            when c.id is not null
              then p.cycle_day = (
                     ((d.kst_date - c.anchor_date) % c.cycle_days + c.cycle_days) % c.cycle_days
                   )::smallint
            -- shift 인데 주기가 없다 → 패턴 축이 아예 없다. 달력만이 그 사람의 가능시간이다.
            else false
          end
    group by 1
  ),
  -- 지정된 날 **전체**(00:00~24:00). 그 날의 패턴은 통째로 대체된다.
  -- ★ shift 모드인 사람에게만 행을 만든다. weekly 인 사람은 달력 지정이 남아 있어도
  --   결과에 아무 영향이 없어야 한다 — 이게 발주자가 본 "섞임" 의 정확한 지점이다.
  assigned_days as (
    select coalesce(a.user_id, a.guest_id) as person_id,
           range_agg(tstzrange(
             public.kst_moment(a.work_date, 0),
             public.kst_moment(a.work_date, 1440),
             '[)'
           )) as covered
    from public.shift_assignments a
    join person_modes pm
      on pm.person_id = coalesce(a.user_id, a.guest_id)
     and pm.mode = 'shift'
    cross join bounds b
    where (a.user_id = any(p_person_ids) or a.guest_id = any(p_person_ids))
      and a.work_date between b.d0 and b.d1
    group by 1
  ),
  -- 지정된 날이 실제로 여는 시간. preset 이 NULL 인 날(종일 불가)은 아무것도 열지 않는다.
  -- 여기도 shift 모드 한정이다 — 위 assigned_days 와 짝이 맞아야 뺀 만큼만 다시 열린다.
  selected_ranges as (
    select coalesce(a.user_id, a.guest_id) as person_id,
           range_agg(tstzrange(
             public.kst_moment(a.work_date, s.start_minute),
             public.kst_moment(a.work_date, s.end_minute),
             '[)'
           )) as available
    from public.shift_assignments a
    join public.shift_presets s on s.id = a.preset_id
    join person_modes pm
      on pm.person_id = coalesce(a.user_id, a.guest_id)
     and pm.mode = 'shift'
    cross join bounds b
    where (a.user_id = any(p_person_ids) or a.guest_id = any(p_person_ids))
      and a.work_date between b.d0 and b.d1
    group by 1
  ),
  -- 예외는 **두 모드 공통**이다. "이 날은 안 된다" 는 어느 방식을 쓰든 같은 말이고,
  -- 뺄셈은 언제나 마지막이다(§1.4 — 거짓 "가능" 이 가장 비싸다).
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
  -- 집합 연산 순서는 35 그대로: ((패턴 − 지정된 날) + 선택 시간) − 예외.
  -- weekly 인 사람은 가운데 두 항이 공집합이라 식이 저절로 (패턴 − 예외) 로 접힌다.
  effective as (
    select pe.person_id,
           unnest(
             (
               ( coalesce(pr.available, '{}'::tstzmultirange)
                 - coalesce(ad.covered, '{}'::tstzmultirange) )
               + coalesce(sr.available, '{}'::tstzmultirange)
             )
             - coalesce(er.blocked, '{}'::tstzmultirange)
           ) as r
    from persons pe
    left join pattern_ranges   pr on pr.person_id = pe.person_id
    left join assigned_days    ad on ad.person_id = pe.person_id
    left join selected_ranges  sr on sr.person_id = pe.person_id
    left join exception_ranges er on er.person_id = pe.person_id
  )
  select e.person_id,
         greatest(lower(e.r), p_from) as starts_at,
         least(upper(e.r), p_to)      as ends_at
  from effective e
  where lower(e.r) < p_to
    and upper(e.r) > p_from;
$func$;

comment on function public.resolve_availability(uuid[], timestamptz, timestamptz) is
  '실효 가능시간. 방식은 availability_modes 가 배타적으로 고른다(행이 없으면 weekly). weekly = 요일 패턴 − 예외. shift = (주기 패턴 − 지정된 날 전체 + 지정된 날의 가능 시간) − 예외. 고르지 않은 쪽 데이터는 보존되며 읽히지 않는다. 웹·봇이 공유하는 유일한 구현.';

-- -----------------------------------------------------------------------------
-- 36-5. 자기검증 — 두 모드를 **실제로 돌려서** 확인한다
-- -----------------------------------------------------------------------------
-- 카탈로그 확인으로는 이 버그를 다시 못 잡는다. 실패한 것은 "두 방식이 섞인 결과값" 이므로
-- 검증도 결과값이어야 한다. 2026-09-05 는 토요일(ISO 6)이며, 발주자 계정에서 실제로 섞임이
-- 관측된 바로 그 날짜다.
do $$
declare
  v_user   uuid;
  v_preset uuid;
  v_txt    text;
  v_cnt    integer;
  v_mode   public.availability_mode;
begin
  insert into public.app_users (display_name, friend_discoverable)
  values ('__mig36_check__', false) returning id into v_user;

  -- 요일 패턴: 토요일 14:00~23:30 (840~1410)
  insert into public.availability_patterns (user_id, weekday, start_minute, end_minute)
  values (v_user, 6, 840, 1410);

  -- 달력 쪽: 15:00~24:00 (900~1440) 묶음을 그 토요일에 찍는다.
  insert into public.shift_presets (user_id, name, start_minute, end_minute)
  values (v_user, '주간', 900, 1440) returning id into v_preset;
  insert into public.shift_assignments (user_id, work_date, preset_id)
  values (v_user, date '2026-09-05', v_preset);

  -- ① 모드 행이 **없다** → weekly 로 봐야 한다. 달력이 섞이면 실패.
  select string_agg(
           to_char(starts_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI') || '~' ||
           to_char(ends_at   at time zone 'Asia/Seoul', 'MM-DD HH24:MI'), ',' order by starts_at)
    into v_txt
    from public.resolve_availability(
      array[v_user], timestamptz '2026-09-05 00:00+09', timestamptz '2026-09-06 00:00+09');
  if v_txt is distinct from '09-05 14:00~09-05 23:30' then
    raise exception '36-①: 모드 행이 없을 때 결과가 % 입니다(09-05 14:00~09-05 23:30 이어야 함).',
      coalesce(v_txt, '없음');
  end if;

  -- ② shift 로 전환 → 달력의 15:00~24:00 만 남고 요일 패턴은 사라져야 한다.
  --    주기가 없으므로 패턴 구간은 0개이며, 달력이 그 사람의 가능시간 전부다.
  --    upsert 를 **두 번** 실행해 ON CONFLICT 중재자가 실제로 동작하는지도 함께 본다(34의 교훈).
  insert into public.availability_modes (user_id, mode) values (v_user, 'shift')
  on conflict (user_id) do update set mode = excluded.mode;
  insert into public.availability_modes (user_id, mode) values (v_user, 'shift')
  on conflict (user_id) do update set mode = excluded.mode;

  select count(*) into v_cnt from public.availability_modes where user_id = v_user;
  if v_cnt <> 1 then
    raise exception '36-②: 모드 행이 %건이 됐습니다(1이어야 함 — ON CONFLICT 중재자 실패).', v_cnt;
  end if;

  select string_agg(
           to_char(starts_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI') || '~' ||
           to_char(ends_at   at time zone 'Asia/Seoul', 'MM-DD HH24:MI'), ',' order by starts_at)
    into v_txt
    from public.resolve_availability(
      array[v_user], timestamptz '2026-09-05 00:00+09', timestamptz '2026-09-06 00:00+09');
  if v_txt is distinct from '09-05 15:00~09-06 00:00' then
    raise exception '36-②: shift 모드 결과가 % 입니다(09-05 15:00~09-06 00:00 이어야 함).',
      coalesce(v_txt, '없음');
  end if;

  -- ③ weekly 로 되돌리면 요일 패턴이 그대로 살아나야 한다 — 보존 규칙의 핵심.
  insert into public.availability_modes (user_id, mode) values (v_user, 'weekly')
  on conflict (user_id) do update set mode = excluded.mode;

  select mode into v_mode from public.availability_modes where user_id = v_user;
  if v_mode <> 'weekly' then
    raise exception '36-③: 되돌린 모드가 % 입니다(weekly 여야 함).', v_mode;
  end if;

  select string_agg(
           to_char(starts_at at time zone 'Asia/Seoul', 'MM-DD HH24:MI') || '~' ||
           to_char(ends_at   at time zone 'Asia/Seoul', 'MM-DD HH24:MI'), ',' order by starts_at)
    into v_txt
    from public.resolve_availability(
      array[v_user], timestamptz '2026-09-05 00:00+09', timestamptz '2026-09-06 00:00+09');
  if v_txt is distinct from '09-05 14:00~09-05 23:30' then
    raise exception '36-③: weekly 복귀 결과가 % 입니다(09-05 14:00~09-05 23:30 이어야 함).',
      coalesce(v_txt, '없음');
  end if;

  -- ④ 반대쪽 데이터는 **지워지지 않았어야** 한다. 무시했을 뿐이다.
  select count(*) into v_cnt from public.shift_presets where user_id = v_user;
  if v_cnt <> 1 then
    raise exception '36-④: 시간대 묶음이 %건입니다(1이어야 함 — 반대쪽 데이터를 태웠습니다).', v_cnt;
  end if;
  select count(*) into v_cnt from public.shift_assignments where user_id = v_user;
  if v_cnt <> 1 then
    raise exception '36-④: 달력 지정이 %건입니다(1이어야 함 — 반대쪽 데이터를 태웠습니다).', v_cnt;
  end if;
  select count(*) into v_cnt from public.availability_patterns where user_id = v_user;
  if v_cnt <> 1 then
    raise exception '36-④: 요일 패턴이 %건입니다(1이어야 함).', v_cnt;
  end if;

  -- ⑤ RLS 와 공개 권한.
  if not (select coalesce(c.relrowsecurity, false)
            from pg_class c join pg_namespace n on n.oid = c.relnamespace
           where n.nspname = 'public' and c.relname = 'availability_modes') then
    raise exception '36-⑤: availability_modes 에 RLS 가 꺼져 있습니다.';
  end if;
  if (select bool_or(has_table_privilege(r, 'public.availability_modes', 'select'))
        from unnest(array['anon', 'authenticated']) as r) then
    raise exception '36-⑤: availability_modes 가 anon/authenticated 에 열려 있습니다.';
  end if;

  -- 정리 — app_users 하나만 지워도 cascade 로 전부 사라져야 한다.
  delete from public.app_users where id = v_user;

  select count(*) into v_cnt from public.availability_modes where user_id = v_user;
  if v_cnt <> 0 then
    raise exception '36-⑥: 계정 삭제 후 모드 행이 %건 남았습니다(cascade 실패).', v_cnt;
  end if;
end
$$;

select public.assert_no_public_sensitive_columns();
