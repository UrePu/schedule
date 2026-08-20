-- =============================================================================
-- 35. 달력을 **뺄셈에서 선택으로** — "그날 가능한 시간을 고른다"
-- =============================================================================
--
-- 발주자(2026-08-20): *"가능시간선택으로 바꿔"*
--   바로 앞 대화: *"근무시간이 가능시간에서 빠지는거면 자는시간은 선택을 못해?"*
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 왜 뒤집는가
-- ─────────────────────────────────────────────────────────────────────────────
-- 마이그레이션 33 은 근무 배정을 **뺄셈**으로 모델링했다(패턴 − 예외 − 근무). 그런데 교대는
-- 근무만 도는 게 아니라 **자는 시간도 같이 돈다.** 야간 근무 다음 날 오전은 근무가 아니지만
-- 자고 있어서 못 한다. 뺄셈 모델에서 그 시간을 막으려면 사용자가 "근무 22:00~06:00 + 수면
-- 06:00~15:00" 처럼 **자기 하루를 통째로 설명해야** 한다. 발주자가 막힌 지점이 정확히 거기고,
-- 하나라도 빠뜨리면 자고 있는 시간이 "가능" 으로 남는다 — §1.4 가 가장 비싸다고 못박은
-- 거짓 "가능" 이다.
--
-- 선택 모델은 그 설명을 요구하지 않는다. **"이 날은 20시~24시 가능"** 한 마디면 끝이고,
-- 근무도 수면도 말할 필요가 없다. 말하지 않은 시간은 그냥 가능하지 않다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 새 규칙 — 배정된 날은 **그 날의 패턴을 대체한다**
-- ─────────────────────────────────────────────────────────────────────────────
--   · 배정 없는 날            → 예전 그대로 패턴(요일 또는 주기)
--   · 배정 + 시간대 묶음      → **그 날은 묶음의 시간만** 가능 (패턴 무시)
--   · 배정 + preset_id NULL   → **그 날은 종일 불가**
--   · 예외(제외)는 그 위에서 마지막으로 빠진다 — 뺄셈은 언제나 마지막이다.
--
-- ★ **대체는 벽시계 순간 단위다.** 배정된 날 D 에서 지우는 것은 "D 에 걸린 패턴 행" 이 아니라
--   **D(KST) 에 속한 모든 순간**이다. 전날 22:00~02:00 패턴이 D 새벽으로 흘러든 것도 함께
--   지운다 — 그러지 않으면 야간 근무 날 새벽 1시에 예약 가능한 사람으로 남는다.
--   이것은 §1.4 가 예외에 적용한 규칙과 **같은 규칙**이다.
-- ★ 반대로 **묶음 자신이 자정을 넘기는 것은 그대로 둔다.** 비번 날 "22:00~익일 02:00 가능"
--   은 사용자가 직접 한 말이므로 다음 날로 흘러도 유효하다.
--
-- ⚠️ **CLAUDE.md §1.4 의 "패턴에 없는 시간을 추가하는 기능은 넣지 않는다" 를 이 마이그레이션이
--    뒤집는다.** 발주자 결정(2026-08-20)이며 CLAUDE.md 에도 같은 날짜로 기록했다. 다만 그
--    규칙이 지키려던 것 — 거짓 "가능" 을 만들지 않는 것 — 은 위 벽시계 대체 규칙이 그대로
--    이어받는다.

-- -----------------------------------------------------------------------------
-- 35-1. 종일 불가를 표현할 수 있게 한다
-- -----------------------------------------------------------------------------
-- 세 상태를 한 표로 말할 수 있어야 달력이 자기완결이 된다:
--   행 없음 = 평소대로 · preset 있음 = 그 시간만 · preset NULL = 종일 불가.
alter table public.shift_assignments
  alter column preset_id drop not null;

comment on column public.shift_assignments.preset_id is
  '그 날 가능한 시간대 묶음. NULL 이면 **종일 불가**다(행이 아예 없는 것과 다르다 — 그건 평소 패턴이다).';

comment on table public.shift_assignments is
  '날짜별 가능 시간 지정. 하루 하나. 지정된 날은 그 날의 패턴을 대체한다(preset=NULL 이면 종일 불가). 행이 없는 날은 평소 패턴 그대로.';

comment on table public.shift_presets is
  '가능 시간대 묶음(주간근무날·야간근무날·비번 등). 여기 적힌 구간은 **가능한 시간**이며, 달력에서 찍은 날의 가능 시간이 된다.';
comment on column public.shift_presets.start_minute is
  '가능 시작(KST 분). 33 에서는 근무 시작이었으나 35 에서 뜻이 뒤집혔다.';
comment on column public.shift_presets.end_minute is
  '가능 끝. 1440 초과 = 자정 넘김(22:00~익일 02:00 = 1320~1560). 이 넘김은 사용자가 직접 말한 것이므로 다음 날에서도 유효하다.';

-- 소유자 가드는 preset 이 있을 때만 본다.
create or replace function public.shift_assignment_owner_matches_preset()
returns trigger
language plpgsql
as $func$
declare
  v_user  uuid;
  v_guest uuid;
begin
  if new.preset_id is null then
    return new;  -- 종일 불가. 남의 것을 참조할 여지가 없다.
  end if;

  select user_id, guest_id into v_user, v_guest
    from public.shift_presets where id = new.preset_id;

  if v_user is distinct from new.user_id or v_guest is distinct from new.guest_id then
    raise exception '가능 시간 지정의 주인과 시간대 묶음의 주인이 다릅니다 (preset=%).', new.preset_id
      using errcode = 'check_violation';
  end if;

  return new;
end
$func$;

-- -----------------------------------------------------------------------------
-- 35-2. 해석기
-- -----------------------------------------------------------------------------
-- 실효 가능시간
--   = ( 패턴 − 지정된 날 전체 + 지정된 날의 묶음 시간 ) − 예외
--
-- ★ 사람 목록을 **먼저 펼친다.** 33 까지는 `pattern_ranges` 에서 출발해서, 패턴이 한 줄도
--   없고 달력만 찍은 사람은 결과에 아예 나오지 않았다. 선택 모델에서는 그런 사람이 정상이다.
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
  persons as (
    select distinct pid as person_id from unnest(p_person_ids) as pid
  ),
  days as (
    select (b.d0 + g)::date as kst_date
    from bounds b, generate_series(0, (b.d1 - b.d0)) as g
  ),
  -- 패턴이 만드는 가능 구간 (요일축 또는 주기축)
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
            when c.id is null then p.weekday = extract(isodow from d.kst_date)::smallint
            else p.cycle_day = (
                   ((d.kst_date - c.anchor_date) % c.cycle_days + c.cycle_days) % c.cycle_days
                 )::smallint
          end
    group by 1
  ),
  -- 지정된 날 **전체**(00:00~24:00). 그 날의 패턴은 통째로 대체된다.
  assigned_days as (
    select coalesce(a.user_id, a.guest_id) as person_id,
           range_agg(tstzrange(
             public.kst_moment(a.work_date, 0),
             public.kst_moment(a.work_date, 1440),
             '[)'
           )) as covered
    from public.shift_assignments a, bounds b
    where (a.user_id = any(p_person_ids) or a.guest_id = any(p_person_ids))
      and a.work_date between b.d0 and b.d1
    group by 1
  ),
  -- 지정된 날이 실제로 여는 시간. preset 이 NULL 인 날(종일 불가)은 아무것도 열지 않는다.
  selected_ranges as (
    select coalesce(a.user_id, a.guest_id) as person_id,
           range_agg(tstzrange(
             public.kst_moment(a.work_date, s.start_minute),
             public.kst_moment(a.work_date, s.end_minute),
             '[)'
           )) as available
    from public.shift_assignments a
    join public.shift_presets s on s.id = a.preset_id
    cross join bounds b
    where (a.user_id = any(p_person_ids) or a.guest_id = any(p_person_ids))
      and a.work_date between b.d0 and b.d1
    group by 1
  ),
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
  '실효 가능시간 = (패턴 − 지정된 날 전체 + 지정된 날의 가능 시간) − 예외. 지정된 날은 벽시계 순간 단위로 패턴을 대체한다. 웹·봇이 공유하는 유일한 구현.';

-- -----------------------------------------------------------------------------
-- 35-3. 자기검증 — 뒤집힌 뜻을 **실제로 돌려서** 확인한다
-- -----------------------------------------------------------------------------
do $$
declare
  v_user  uuid;
  v_ok    uuid;
  v_txt   text;
  v_cnt   integer;
begin
  insert into public.app_users (display_name, friend_discoverable)
  values ('__mig35_check__', false) returning id into v_user;

  -- 평소: 목요일 20:00~24:00, 그리고 수요일 22:00~익일 02:00(목요일 새벽으로 흘러든다)
  insert into public.availability_patterns (user_id, weekday, start_minute, end_minute)
  values (v_user, 4, 1200, 1440), (v_user, 3, 1320, 1560);

  -- 2026-08-20 은 목요일이다. 배정 없이 보면 새벽 00:00~02:00 과 20:00~24:00 두 구간.
  select count(*) into v_cnt from public.resolve_availability(
    array[v_user], timestamptz '2026-08-20 00:00+09', timestamptz '2026-08-21 00:00+09');
  if v_cnt <> 2 then
    raise exception '35-①: 배정 전 구간이 %개입니다(2여야 함).', v_cnt;
  end if;

  -- 그 날에 "16:00~21:00 가능" 을 고른다 → 패턴은 통째로 대체된다.
  --   ★ 전날에서 흘러든 00:00~02:00 도 사라져야 한다. 이게 이 마이그레이션의 핵심이다.
  insert into public.shift_presets (user_id, name, start_minute, end_minute)
  values (v_user, '야간근무날', 960, 1260) returning id into v_ok;
  insert into public.shift_assignments (user_id, work_date, preset_id)
  values (v_user, date '2026-08-20', v_ok);

  select string_agg(
           to_char(starts_at at time zone 'Asia/Seoul', 'HH24:MI') || '-' ||
           to_char(ends_at   at time zone 'Asia/Seoul', 'HH24:MI'), ',' order by starts_at)
    into v_txt
    from public.resolve_availability(
      array[v_user], timestamptz '2026-08-20 00:00+09', timestamptz '2026-08-21 00:00+09');
  if v_txt is distinct from '16:00-21:00' then
    raise exception '35-②: 대체 결과가 % 입니다(16:00-21:00 이어야 함).', coalesce(v_txt, '없음');
  end if;

  -- 종일 불가(preset NULL) → 그 날은 아무것도 남지 않는다.
  update public.shift_assignments set preset_id = null
   where user_id = v_user and work_date = date '2026-08-20';
  select count(*) into v_cnt from public.resolve_availability(
    array[v_user], timestamptz '2026-08-20 00:00+09', timestamptz '2026-08-21 00:00+09');
  if v_cnt <> 0 then
    raise exception '35-③: 종일 불가인데 %개 구간이 남았습니다.', v_cnt;
  end if;

  -- 지정을 지우면 평소 패턴으로 돌아온다.
  delete from public.shift_assignments where user_id = v_user;
  select count(*) into v_cnt from public.resolve_availability(
    array[v_user], timestamptz '2026-08-20 00:00+09', timestamptz '2026-08-21 00:00+09');
  if v_cnt <> 2 then
    raise exception '35-④: 지정 해제 후 구간이 %개입니다(2여야 함).', v_cnt;
  end if;

  -- 패턴이 **하나도 없는** 사람도 달력만으로 가능 시간을 가질 수 있어야 한다.
  delete from public.availability_patterns where user_id = v_user;
  insert into public.shift_assignments (user_id, work_date, preset_id)
  values (v_user, date '2026-08-20', v_ok);
  select count(*) into v_cnt from public.resolve_availability(
    array[v_user], timestamptz '2026-08-20 00:00+09', timestamptz '2026-08-21 00:00+09');
  if v_cnt <> 1 then
    raise exception '35-⑤: 패턴 없는 사람의 구간이 %개입니다(1이어야 함).', v_cnt;
  end if;

  delete from public.app_users where id = v_user;
end
$$;

select public.assert_no_public_sensitive_columns();
