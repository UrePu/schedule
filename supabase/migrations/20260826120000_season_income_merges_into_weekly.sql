-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 시즌 **수익**은 주간에 합친다 (계획·체크리스트는 그대로 셋)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-08-26): *"시즌 수익은 주간에 합쳐"*
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 앞 지시와 모순이 아니다 — **축이 또 갈린다**
-- ───────────────────────────────────────────────────────────────────────────────
-- 바로 앞이 *"주간, 월간, 시즌보스 이렇게 세가지로 나눠"* 였다. 둘 다 참이다:
--   · **계획·체크리스트**는 셋으로 나뉜다 — "이번 주에 뭘 돌아야 하나"의 답이 갈린다.
--   · **수익**은 둘이면 된다 — 결정석은 결정석이고, 시즌이라고 지갑이 따로 있지 않다.
-- 그래서 `boss_difficulties.cycle` 은 셋으로 두고, **수익 집계의 그룹 키에서만**
-- season → weekly 로 접는다.
--
-- ⚠️ 접는 것은 **금액**이고 12칸 판정은 그대로다. `counts_limit` 은 여전히
--    `cycle='weekly' AND 플래그` 라, 시즌 클리어는 순위 컷(12위)에 들어가지 않고
--    `over_limit_count` 도 올리지 않는다.
--    실측(2026-08-26): 주간 24.9억 + 시즌 6억 = 30.9억으로 합쳐지고 초과 경고 0.
-- ⚠️ 합치면 **안 보이게 되는 것**이 생기므로 `season_clear_count` / `season_income_meso`
--    / `season_unknown_price_count` 를 함께 내보낸다. **"합쳤다"와 "지웠다"는 다르다.**
--    (`create or replace view` 가 컬럼 삭제를 막는 덕분에 이 원칙이 강제되기도 했다.)

create or replace view public.v_weekly_plan_potential_by_character as
 WITH planned AS (
         SELECT p.user_id, p.character_id, bd.cycle, p.boss_difficulty_id, p.default_party_size,
            bd.cycle = 'weekly'::boss_cycle AND bd.counts_toward_weekly_limit AS counts_limit,
            cp.price_meso AS base_price_meso,
                CASE WHEN cp.price_meso IS NULL THEN NULL::bigint
                     ELSE cp.price_meso / p.default_party_size END AS share_meso
           FROM character_boss_plans p
             JOIN characters ch ON ch.id = p.character_id AND ch.is_tracked
             JOIN boss_difficulties bd ON bd.id = p.boss_difficulty_id
             LEFT JOIN LATERAL current_crystal_price(bd.id, now()) cp(price_id, price_meso) ON true
          WHERE p.is_active AND bd.cycle <> 'daily'::boss_cycle
        ), ranked AS (
         SELECT planned.user_id, planned.character_id, planned.cycle, planned.boss_difficulty_id,
            planned.default_party_size, planned.counts_limit, planned.base_price_meso, planned.share_meso,
            row_number() OVER (PARTITION BY planned.user_id, planned.character_id, planned.cycle, planned.counts_limit ORDER BY planned.share_meso DESC NULLS LAST, planned.boss_difficulty_id) AS cycle_rank
           FROM planned
        )
 SELECT user_id, character_id,
        CASE WHEN cycle = 'season'::boss_cycle THEN 'weekly'::boss_cycle ELSE cycle END AS cycle,
    count(*) AS planned_count,
    count(*) FILTER (WHERE NOT counts_limit OR cycle_rank <= weekly_crystal_sell_limit()) AS counted_count,
    count(*) FILTER (WHERE counts_limit AND cycle_rank > weekly_crystal_sell_limit()) AS over_limit_count,
    count(*) FILTER (WHERE share_meso IS NULL) AS unknown_price_count,
    weekly_crystal_sell_limit() AS weekly_sell_limit,
    COALESCE(sum(share_meso) FILTER (WHERE NOT counts_limit OR cycle_rank <= weekly_crystal_sell_limit()), 0::numeric)::bigint AS potential_meso
   FROM ranked
  GROUP BY user_id, character_id, (CASE WHEN cycle = 'season'::boss_cycle THEN 'weekly'::boss_cycle ELSE cycle END);

create or replace view public.v_weekly_crystal_income_by_character_cycle as
 WITH ranked AS (
         SELECT c.user_id, c.character_id, c.week_key,
                CASE WHEN c.cycle = 'season'::boss_cycle THEN 'weekly'::boss_cycle ELSE c.cycle END AS cycle,
            c.cycle AS real_cycle,
            c.crystal_share_meso,
            c.cycle = 'weekly'::boss_cycle AND COALESCE(bd.counts_toward_weekly_limit, true) AS counts_limit,
            row_number() OVER (PARTITION BY c.user_id, c.character_id, c.week_key, c.cycle, (c.cycle = 'weekly'::boss_cycle AND COALESCE(bd.counts_toward_weekly_limit, true)) ORDER BY c.crystal_share_meso DESC NULLS LAST, c.id) AS cycle_rank
           FROM boss_clears c
             LEFT JOIN boss_difficulties bd ON bd.id = c.boss_difficulty_id
          WHERE c.effective_cleared
        )
 SELECT user_id, character_id, week_key, cycle,
    count(*) AS clear_count,
    count(*) FILTER (WHERE crystal_share_meso IS NULL) AS unknown_price_count,
    count(*) FILTER (WHERE counts_limit AND cycle_rank > weekly_crystal_sell_limit()) AS over_limit_count,
    weekly_crystal_sell_limit() AS weekly_sell_limit,
    COALESCE(sum(crystal_share_meso) FILTER (WHERE NOT counts_limit OR cycle_rank <= weekly_crystal_sell_limit()), 0::numeric)::bigint AS income_meso,
    count(*) FILTER (WHERE real_cycle = 'season'::boss_cycle) AS season_clear_count,
    COALESCE(sum(crystal_share_meso) FILTER (WHERE real_cycle = 'season'::boss_cycle), 0::numeric)::bigint AS season_income_meso,
    count(*) FILTER (WHERE real_cycle = 'season'::boss_cycle AND crystal_share_meso IS NULL) AS season_unknown_price_count
   FROM ranked
  GROUP BY user_id, character_id, week_key, cycle;

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
    COALESCE(sum(season_clear_count), 0::numeric) AS season_clear_count,
    COALESCE(sum(season_income_meso), 0::numeric)::bigint AS season_income_meso,
    COALESCE(sum(season_unknown_price_count), 0::numeric) AS season_unknown_price_count
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
    COALESCE(sum(season_clear_count), 0::numeric)::bigint AS season_clear_count
   FROM v_weekly_crystal_income_by_character_cycle
  GROUP BY user_id, character_id, week_key;

-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare v_rows integer;
begin
  select count(*) into v_rows from public.v_weekly_crystal_income_by_character_cycle
   where cycle = 'season'::boss_cycle;
  if v_rows > 0 then
    raise exception '수익 집계에 season 버킷이 남아 있습니다 — 주간에 합쳐지지 않았습니다.';
  end if;

  select count(*) into v_rows from public.v_weekly_plan_potential_by_character
   where cycle = 'season'::boss_cycle;
  if v_rows > 0 then
    raise exception '최대치 집계에 season 버킷이 남아 있습니다.';
  end if;

  raise notice '시즌 수익을 주간에 합쳤다 — 건수·금액은 season_* 로 따로 볼 수 있다';
end $$;

select public.assert_no_public_sensitive_columns();
