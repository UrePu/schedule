-- =============================================================================
-- 클리어 판정을 **보스의 주기에 맞춘다** — 월간은 이번 달, 일간은 오늘
-- =============================================================================
--
-- 발주 지시(2026-08-20): *"익스트림 검은마법사. 하드검은마법사 월간은 태그를 이번주 완료가
-- 아니라 이번달 완료로 변경해야."*
--
-- 화면 문구를 고치러 갔다가 **더 깊은 결함**이 드러났다. `v_character_boss_plan_status` 의
-- 클리어 조인이 주기와 무관하게 `bc.week_key = week_key(now())` 하나였다. 그래서 월간
-- 보스(검은 마법사)는 잡은 그 주에만 "완료"로 보이고, **목요일이 지나면 다시 "안 잡음"으로
-- 돌아왔다.** 체크리스트는 한 달에 한 번 가는 보스를 매주 가라고 말하고 있었던 셈이다.
-- 문구만 `이번 달 완료` 로 바꾸면 그 거짓말이 더 그럴듯해질 뿐이라 판정을 함께 고친다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 무엇이 바뀌고 무엇이 그대로인가
-- ─────────────────────────────────────────────────────────────────────────────
--   · **주간** — 그대로 `week_key`(목 00:00 KST 리셋). 12개 상한이 걸리는 유일한 주기이며
--     그 경계는 §1 이 정한 대로다.
--   · **월간** — `kst_date(cleared_at)` 의 달이 이번 달과 같은가. 인게임 월간 초기화가
--     달력 1일이므로 KST 달력 달이 맞는 기준이다.
--   · **일간** — 같은 KST 날짜. 일간 보스는 추적 범위 밖이지만(§1, 2026-08-18 발주자)
--     주기 값 자체는 존재하므로 `case` 를 비워 두지 않는다. 비워 두면 어느 날 일간이
--     범위 안으로 돌아왔을 때 조용히 주간 규칙을 타게 된다.
--
-- `cleared_at` 이 `null` 인 행은 월간·일간 분기에서 조인되지 않는다. 그건 정확하다 —
-- 클리어된 행은 DB CHECK 상 `cleared_at` 이 반드시 있고(`boss_clears_cleared_needs_snapshot`),
-- 없는 행은 애초에 "안 잡음"이다.
--
-- ⚠️ 이 뷰 위에 두 뷰가 얹혀 있어 `cascade` 로 함께 지워진다. 두 뷰는 **원문 그대로**
--    복원하고 권한도 다시 잠근다 — cascade 로 지웠다 만든 뷰는 GRANT 가 초기화되고,
--    그 자리가 이 저장소가 `share_bp` 로 한 번 데인 경로다.
-- ⚠️ 집계 뷰의 `cleared_weekly` / `remaining_weekly` 는 `cycle = 'weekly'` 로 필터하므로
--    이 변경의 영향을 받지 않는다. 움직이는 것은 `cleared_total` / `remaining_total` 이며,
--    그건 **원래 그래야 했던 값**이다(이번 달에 이미 잡은 월간 보스는 남은 목록에서 빠진다).

-- -----------------------------------------------------------------------------
-- 29-1. 계획 + 클리어 상태 (주기별 판정)
-- -----------------------------------------------------------------------------
drop view if exists public.v_character_boss_plan_status cascade;
create view public.v_character_boss_plan_status
with (security_invoker = true) as
select
  p.id                                  as plan_id,
  p.user_id,
  p.character_id,
  ch.character_name,
  ch.world_name,

  p.boss_difficulty_id,
  bd.boss_id,
  bd.korean_name                        as boss_display_name,
  bd.difficulty,
  bd.cycle,
  bd.max_party,
  bd.released,
  b.sort_order                          as boss_sort_order,
  bd.sort_order                         as difficulty_sort_order,

  p.is_active,
  p.manual_active,
  p.api_registered,
  p.api_observed_at,
  p.has_conflict,
  -- ★ 21 에서 추가. **null 은 0 이 아니라 "미설정"이다** — 화면이 1 로 접으면 안 된다.
  p.default_party_size,
  -- 어느 출처에서 온 행인지 UI 가 그대로 쓸 수 있는 라벨
  case
    when p.manual_active is not null and p.api_registered is not null then 'both'
    when p.manual_active is not null                                  then 'manual'
    else 'nexon_api'
  end                                   as origin,

  -- ★ 12개 카운터에 들어가는지 여부. 일간·월간은 false (§1).
  (bd.cycle = 'weekly'::public.boss_cycle) as counts_toward_weekly_limit,

  public.week_key(now())                as week_key,
  coalesce(bc.effective_cleared, false) as is_cleared,
  bc.id                                 as clear_id,
  bc.cleared_at,
  bc.has_conflict                       as clear_has_conflict,
  p.note,
  p.created_at,
  p.updated_at
from public.character_boss_plans p
join public.characters        ch on ch.id = p.character_id
join public.boss_difficulties bd on bd.id = p.boss_difficulty_id
join public.bosses            b  on b.id  = bd.boss_id
-- ★ 29-1 의 변경점. 평범한 left join 이 아니라 **lateral + limit 1** 이다.
--
--   주간 판정은 `(user_id, character_id, boss_difficulty_id, week_key)` 유니크 제약이
--   1행을 보장했다. 월간으로 넓히면 그 보장이 사라진다 — 한 달 안에 주차가 다른 클리어가
--   여러 개 있을 수 있고(적용 시점 실데이터에 이미 있다: 한 캐릭터의 익스트림 검은 마법사가
--   2026-W33 · 2026-W34 두 건), 그대로 조인하면 **계획 한 줄이 두 줄로 복제된다.**
--   그러면 체크리스트에 같은 보스가 두 번 뜨고, 위에 얹힌 집계 뷰의 `planned_total` 이
--   행 수를 세므로 계획 개수까지 부풀어 오른다.
--
--   골라 오는 순서: **클리어된 행 우선**(안 잡힌 행이 잡힌 행을 가리면 안 된다),
--   그다음 최근 클리어. `clear_id` · `cleared_at` 이 그 행의 것으로 실려 나간다.
left join lateral (
  select c.*
    from public.boss_clears c
   where c.character_id       = p.character_id
     and c.boss_difficulty_id = p.boss_difficulty_id
     and case bd.cycle
           when 'monthly'::public.boss_cycle then
             date_trunc('month', public.kst_date(c.cleared_at))
               = date_trunc('month', public.kst_date(now()))
           when 'daily'::public.boss_cycle then
             public.kst_date(c.cleared_at) = public.kst_date(now())
           else
             c.week_key = public.week_key(now())
         end
   order by c.effective_cleared desc, c.cleared_at desc nulls last
   limit 1
) bc on true;

-- -----------------------------------------------------------------------------
-- 29-2. 얹혀 있던 집계 뷰 2종 — **원문 그대로** 복원한다
-- -----------------------------------------------------------------------------
drop view if exists public.v_character_weekly_boss_progress cascade;
create view public.v_character_weekly_boss_progress
with (security_invoker = true) as
select
  s.user_id,
  s.character_id,
  s.character_name,
  s.world_name,
  s.week_key,

  count(*) filter (where s.is_active)                                              as planned_total,
  count(*) filter (where s.is_active and s.cycle = 'weekly')                       as planned_weekly,
  count(*) filter (where s.is_active and s.cycle = 'daily')                        as planned_daily,
  count(*) filter (where s.is_active and s.cycle = 'monthly')                      as planned_monthly,

  count(*) filter (where s.is_active and s.is_cleared)                             as cleared_total,
  count(*) filter (where s.is_active and s.cycle = 'weekly' and s.is_cleared)      as cleared_weekly,
  count(*) filter (where s.is_active and not s.is_cleared)                         as remaining_total,
  count(*) filter (where s.is_active and s.cycle = 'weekly' and not s.is_cleared)  as remaining_weekly,

  count(*) filter (where not s.is_active)                                          as inactive_total,
  count(*) filter (where s.has_conflict)                                           as conflict_count,

  public.weekly_crystal_sell_limit()                                               as weekly_limit,
  (count(*) filter (where s.is_active and s.cycle = 'weekly'))
    > public.weekly_crystal_sell_limit()                                           as weekly_over_limit,
  greatest(
    public.weekly_crystal_sell_limit()
      - (count(*) filter (where s.is_active and s.cycle = 'weekly')),
    0
  )                                                                                as weekly_slots_remaining
from public.v_character_boss_plan_status s
group by s.user_id, s.character_id, s.character_name, s.world_name, s.week_key;

comment on view public.v_character_weekly_boss_progress is
  '캐릭터 × 이번 주 진행 상황. 계획 N개 중 클리어 M개. weekly_over_limit 은 경고일 뿐 DB 는 막지 않는다.';

drop view if exists public.v_user_weekly_boss_progress;
create view public.v_user_weekly_boss_progress
with (security_invoker = true) as
select
  g.user_id,
  g.week_key,
  count(*)                                     as character_count,
  sum(g.planned_total)                         as planned_total,
  sum(g.planned_weekly)                        as planned_weekly,
  sum(g.planned_daily)                         as planned_daily,
  sum(g.planned_monthly)                       as planned_monthly,
  sum(g.cleared_total)                         as cleared_total,
  sum(g.cleared_weekly)                        as cleared_weekly,
  sum(g.remaining_total)                       as remaining_total,
  sum(g.remaining_weekly)                      as remaining_weekly,
  sum(g.inactive_total)                        as inactive_total,
  sum(g.conflict_count)                        as conflict_count,
  count(*) filter (where g.weekly_over_limit)  as over_limit_character_count
from public.v_character_weekly_boss_progress g
group by g.user_id, g.week_key;

comment on view public.v_user_weekly_boss_progress is
  '사용자 × 이번 주 합계. 12개 상한은 캐릭터당이므로 여기서는 초과 캐릭터 수만 센다.';
comment on view public.v_character_boss_plan_status is
  '캐릭터 보스 계획 + 그 보스의 주기 기준 클리어 여부(주간=목요일 리셋 주차 · 월간=KST 달력 달 · 일간=KST 날짜) + 기본 파티 인원수. 남은 목록 = where is_active and not is_cleared.';

-- -----------------------------------------------------------------------------
-- 29-3. 권한 — cascade 로 다시 만든 뷰 3종은 **권한이 초기화된다**
-- -----------------------------------------------------------------------------
revoke all on table public.v_character_boss_plan_status       from anon, authenticated;
revoke all on table public.v_character_weekly_boss_progress   from anon, authenticated;
revoke all on table public.v_user_weekly_boss_progress        from anon, authenticated;
grant all  on table public.v_character_boss_plan_status       to service_role;
grant all  on table public.v_character_weekly_boss_progress   to service_role;
grant all  on table public.v_user_weekly_boss_progress        to service_role;

-- -----------------------------------------------------------------------------
-- 29-4. 자기검증 — 적용과 동시에 판정이 맞는지 DB 가 직접 확인한다
-- -----------------------------------------------------------------------------
do $$
declare
  v_month_start timestamptz;
  v_this_week   text;
  v_plans       bigint;
  v_rows        bigint;
begin
  -- 이번 달 1일 00:00 KST 를 절대 시각으로. (KST = UTC+9, 서머타임 없음)
  v_month_start := (date_trunc('month', public.kst_date(now()))::timestamp
                     - interval '9 hours') at time zone 'UTC';
  v_this_week := public.week_key(now());

  -- ⓪ **계획 한 줄 = 뷰 한 줄.** 월간으로 넓히면 한 달에 클리어 행이 여러 개일 수 있어
  --    조인이 계획을 복제할 수 있다(적용 시점 실데이터에 이미 그 조합이 있었다).
  --    lateral + limit 1 이 그것을 막는데, 막았는지를 **DB 가 직접 센다.**
  select count(*) into v_plans from public.character_boss_plans;
  select count(*) into v_rows  from public.v_character_boss_plan_status;
  if v_plans <> v_rows then
    raise exception '29-4: 계획 %건인데 뷰가 %행입니다(복제).', v_plans, v_rows;
  end if;

  -- ① 이번 달에 잡은 월간 보스는 **반드시** 완료여야 한다(주차와 무관하게).
  if exists (
    select 1
      from public.boss_clears bc
      join public.boss_difficulties bd on bd.id = bc.boss_difficulty_id
      join public.character_boss_plans p
        on p.character_id = bc.character_id
       and p.boss_difficulty_id = bc.boss_difficulty_id
      join public.v_character_boss_plan_status s on s.plan_id = p.id
     where bd.cycle = 'monthly'::public.boss_cycle
       and bc.effective_cleared
       and bc.cleared_at >= v_month_start
       and not s.is_cleared
  ) then
    raise exception '29-4: 이번 달에 잡은 월간 보스가 완료로 잡히지 않았습니다.';
  end if;

  -- ② 반대 방향. 이번 달에 잡은 적이 없는데 완료로 잡히면 안 된다.
  if exists (
    select 1
      from public.v_character_boss_plan_status s
     where s.cycle = 'monthly'::public.boss_cycle
       and s.is_cleared
       and not exists (
         select 1
           from public.boss_clears bc
          where bc.character_id = s.character_id
            and bc.boss_difficulty_id = s.boss_difficulty_id
            and bc.effective_cleared
            and bc.cleared_at >= v_month_start
       )
  ) then
    raise exception '29-4: 이번 달에 없는 월간 클리어가 완료로 잡혔습니다.';
  end if;

  -- ③ 주간은 건드리지 않았다. 주차가 다른 주간 클리어가 완료로 새어 들어오면 안 된다.
  if exists (
    select 1
      from public.v_character_boss_plan_status s
     where s.cycle = 'weekly'::public.boss_cycle
       and s.is_cleared
       and not exists (
         select 1
           from public.boss_clears bc
          where bc.character_id = s.character_id
            and bc.boss_difficulty_id = s.boss_difficulty_id
            and bc.week_key = v_this_week
       )
  ) then
    raise exception '29-4: 주간 판정이 이번 주 밖의 클리어를 물었습니다.';
  end if;
end
$$;

-- 컬럼 유출 가드. 새 객체가 아니라 **다시 만든 객체**라 더 필요하다 — cascade 는 권한을
-- 초기화하고, 그 상태로 지나가면 정산 컬럼이 공개면으로 열린 채 남는다.
select public.assert_no_public_sensitive_columns();
