-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 시즌 보스를 **별도 주기**로 — 2/2: 메이린 이관 + 집계 분리
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-08-26): *"시즌보스는 주간과 관련없어. 주간, 월간, 시즌보스 이렇게
-- 세가지로 나눠"* · *"하지만 시즌보스는 주간마다 초기화돼"*
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 두 문장이 **둘 다 참이다** — 묶는 축과 초기화 축이 다르다
-- ───────────────────────────────────────────────────────────────────────────────
-- 시즌 보스는 **집계에서는 주간과 무관**하지만 **초기화는 주간과 같다.** 이 둘을 한
-- 값으로 표현할 수 있는 이유는 `v_character_boss_plan_status` 의 초기화 판정이
--
--     CASE bd.cycle WHEN 'monthly' THEN 달 WHEN 'daily' THEN 날 ELSE 주차 END
--
-- 이기 때문이다. `season` 은 **ELSE 로 떨어져 주차 초기화**를 그대로 받는다.
-- 새 값을 넣으면서 이 CASE 를 손대지 않은 것이 요점이고, 자기 검증이 그것을 확인한다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 `counts_toward_weekly_limit` 만으로는 부족한가
-- ───────────────────────────────────────────────────────────────────────────────
-- 그 플래그는 **12칸을 먹는가**만 답한다. 그것만으로 화면을 셋으로 가르면 "주간이면서
-- 12칸을 안 먹는 것 = 시즌"이라는 **정의를 새로 만드는** 셈이다. 둘은 별개 사실이다 —
-- 12칸 밖인 주간 보스가 시즌이 아닐 수도 있고 그 반대도 가능하다.
-- 그래서 주기를 진짜로 가르고 플래그는 **그대로 둔다.** 지금 메이린에서는 중복이지만,
-- 다음에 "주간인데 12칸 면제"가 생기면 그때 필요한 것은 플래그 쪽이다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 무엇이 저절로 맞았고 무엇을 고쳤나
-- ───────────────────────────────────────────────────────────────────────────────
-- 저절로 맞은 것 — `cycle = 'weekly'` 로 세던 자리는 **전부** 시즌을 빼게 됐다:
--   · 12칸 카운터(`counts_toward_weekly_limit` = `cycle='weekly' AND 플래그`)
--   · 최대 수익의 12위 컷(`v_weekly_plan_potential_by_character`)
--   · 실제 수익의 주간 버킷(`v_weekly_crystal_income_by_character_cycle`)
--   · 계획 조회의 `cycle <> 'daily'` 는 시즌을 **포함**한다 — 수익 대상이므로 맞다.
-- 고친 것 — 시즌을 **볼 수 있게** 버킷을 하나씩 더했다(아래).

-- ★ `update ... from (values ...)` 형태인 것은 **상수 생성기가 읽는 앵커**이기 때문이다
--   (`scripts/gen-boss-master`). 조건절로 쓰면 생성기가 어느 id 가 바뀌었는지 알 수 없다.
update public.boss_difficulties cy
   set cycle = v.cycle::boss_cycle
  from (values
    ('meilin_normal', 'season'),
    ('meilin_hard',   'season')
  ) as v(id, cycle)
 where cy.id = v.id;

create or replace view public.v_character_weekly_boss_progress as
 SELECT user_id, character_id, character_name, world_name, week_key,
    count(*) FILTER (WHERE is_active) AS planned_total,
    count(*) FILTER (WHERE is_active AND counts_toward_weekly_limit) AS planned_weekly,
    count(*) FILTER (WHERE is_active AND cycle = 'daily'::boss_cycle) AS planned_daily,
    count(*) FILTER (WHERE is_active AND cycle = 'monthly'::boss_cycle) AS planned_monthly,
    count(*) FILTER (WHERE is_active AND is_cleared) AS cleared_total,
    count(*) FILTER (WHERE is_active AND counts_toward_weekly_limit AND is_cleared) AS cleared_weekly,
    count(*) FILTER (WHERE is_active AND NOT is_cleared) AS remaining_total,
    count(*) FILTER (WHERE is_active AND counts_toward_weekly_limit AND NOT is_cleared) AS remaining_weekly,
    count(*) FILTER (WHERE NOT is_active) AS inactive_total,
    count(*) FILTER (WHERE has_conflict) AS conflict_count,
    weekly_crystal_sell_limit() AS weekly_limit,
    count(*) FILTER (WHERE is_active AND counts_toward_weekly_limit) > weekly_crystal_sell_limit() AS weekly_over_limit,
    GREATEST(weekly_crystal_sell_limit() - count(*) FILTER (WHERE is_active AND counts_toward_weekly_limit), 0::bigint) AS weekly_slots_remaining,
    -- 열 **이름은 그대로** 두고 기준만 주기로 옮긴다. 소비자(체크리스트)가 이미 이 이름을 쓴다.
    count(*) FILTER (WHERE is_active AND cycle = 'season'::boss_cycle) AS planned_weekly_exempt,
    count(*) FILTER (WHERE is_active AND cycle = 'season'::boss_cycle AND is_cleared) AS cleared_weekly_exempt
   FROM v_character_boss_plan_status s
  GROUP BY user_id, character_id, character_name, world_name, week_key;

create or replace view public.v_weekly_crystal_income as
 SELECT user_id, week_key,
    sum(income_meso)::bigint AS income_meso,
    sum(clear_count) AS clear_count,
    COALESCE(sum(clear_count) FILTER (WHERE cycle = 'weekly'::boss_cycle), 0::numeric) AS weekly_clear_count,
    COALESCE(sum(clear_count) FILTER (WHERE cycle = 'daily'::boss_cycle), 0::numeric) AS daily_clear_count,
    COALESCE(sum(clear_count) FILTER (WHERE cycle = 'monthly'::boss_cycle), 0::numeric) AS monthly_clear_count,
    sum(unknown_price_count) AS unknown_price_count,
    sum(over_limit_count) AS weekly_over_limit_count,
    count(DISTINCT character_id) AS character_count,
    COALESCE(sum(income_meso) FILTER (WHERE cycle = 'weekly'::boss_cycle), 0::numeric)::bigint AS weekly_income_meso,
    COALESCE(sum(income_meso) FILTER (WHERE cycle = 'monthly'::boss_cycle), 0::numeric)::bigint AS monthly_income_meso,
    COALESCE(sum(income_meso) FILTER (WHERE cycle = 'daily'::boss_cycle), 0::numeric)::bigint AS daily_income_meso,
    COALESCE(sum(unknown_price_count) FILTER (WHERE cycle = 'weekly'::boss_cycle), 0::numeric) AS weekly_unknown_price_count,
    COALESCE(sum(unknown_price_count) FILTER (WHERE cycle = 'monthly'::boss_cycle), 0::numeric) AS monthly_unknown_price_count,
    COALESCE(sum(clear_count) FILTER (WHERE cycle = 'season'::boss_cycle), 0::numeric) AS season_clear_count,
    COALESCE(sum(income_meso) FILTER (WHERE cycle = 'season'::boss_cycle), 0::numeric)::bigint AS season_income_meso,
    COALESCE(sum(unknown_price_count) FILTER (WHERE cycle = 'season'::boss_cycle), 0::numeric) AS season_unknown_price_count
   FROM v_weekly_crystal_income_by_character_cycle
  GROUP BY user_id, week_key;

create or replace view public.v_weekly_crystal_income_by_character as
 SELECT user_id, character_id, week_key,
    sum(clear_count)::bigint AS clear_count,
    COALESCE(sum(clear_count) FILTER (WHERE cycle = 'weekly'::boss_cycle), 0::numeric)::bigint AS weekly_clear_count,
    COALESCE(sum(clear_count) FILTER (WHERE cycle = 'daily'::boss_cycle), 0::numeric)::bigint AS daily_clear_count,
    COALESCE(sum(clear_count) FILTER (WHERE cycle = 'monthly'::boss_cycle), 0::numeric)::bigint AS monthly_clear_count,
    sum(unknown_price_count)::bigint AS unknown_price_count,
    sum(over_limit_count)::bigint AS weekly_over_limit_count,
    max(weekly_sell_limit) AS weekly_sell_limit,
    sum(income_meso)::bigint AS income_meso,
    COALESCE(sum(clear_count) FILTER (WHERE cycle = 'season'::boss_cycle), 0::numeric)::bigint AS season_clear_count
   FROM v_weekly_crystal_income_by_character_cycle
  GROUP BY user_id, character_id, week_key;

create or replace view public.v_weekly_crystal_world_usage as
 SELECT user_id, world_name, week_key,
    -- 총합은 **전부**를 센다. 90개 계정 상한(§1.3 D2)은 주기를 가리지 않는다.
    count(*) AS crystal_count,
    count(*) FILTER (WHERE cycle = 'daily'::boss_cycle) AS daily_crystal_count,
    count(*) FILTER (WHERE cycle = 'weekly'::boss_cycle) AS weekly_crystal_count,
    count(*) FILTER (WHERE cycle = 'monthly'::boss_cycle) AS monthly_crystal_count,
    world_crystal_sell_limit() AS world_sell_limit,
    GREATEST(world_crystal_sell_limit() - count(*), 0::bigint) AS remaining_slots,
    count(*) > world_crystal_sell_limit() AS over_limit,
    count(*) FILTER (WHERE cycle = 'season'::boss_cycle) AS season_crystal_count
   FROM boss_clears c
  WHERE effective_cleared AND world_name IS NOT NULL
  GROUP BY user_id, world_name, week_key;

-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare
  v_meilin integer;
  v_reset  integer;
begin
  select count(*) into v_meilin from public.boss_difficulties
   where boss_id = 'meilin' and cycle = 'season';
  if v_meilin <> 2 then
    raise exception '메이린 주기가 season 인 행이 %건입니다(2건이어야 함).', v_meilin;
  end if;

  -- 새 주기가 다른 보스로 번지면 그쪽 초기화·집계가 조용히 바뀐다.
  if exists (select 1 from public.boss_difficulties
              where cycle = 'season' and boss_id <> 'meilin') then
    raise exception 'season 주기가 메이린 밖으로 번졌습니다.';
  end if;

  /*
    ★ **초기화가 주간 그대로인지**가 이 마이그레이션의 핵심 주장이다.
      `v_character_boss_plan_status` 의 CASE 가 season 을 ELSE(주차)로 떨어뜨리므로
      이번 주차 행이 보여야 한다. 안 보이면 시즌 보스가 초기화 축에서 사라진 것이다.
  */
  select count(*) into v_reset from public.v_character_boss_plan_status
   where boss_difficulty_id like 'meilin%' and week_key = public.week_key(now());
  if v_reset = 0 then
    raise exception '시즌 보스가 주간 초기화 범위에서 사라졌습니다 — CASE 의 ELSE 가 안 걸렸습니다.';
  end if;

  raise notice '시즌 주기 분리 완료 — 초기화는 주간 그대로';
end $$;

select public.assert_no_public_sensitive_columns();
