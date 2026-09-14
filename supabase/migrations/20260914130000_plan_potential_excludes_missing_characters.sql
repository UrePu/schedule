-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 최대치 뷰도 **사라진 캐릭터**를 빼야 한다 (`missing_since`)
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 2026-09-14, 교차 검증에서 나온 결함. 같은 날 TypeScript 쪽에서 "넥슨 목록에서 사라진
-- 캐릭터는 현황·선택 조회에서 뺀다"를 적용했는데, **SQL 뷰 하나가 빠졌다.**
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 증상 — `/boss-status` 카드 **한 장이 두 모집단**을 말한다
-- ───────────────────────────────────────────────────────────────────────────────
-- · 카드 목록과 `추적 × 12` 분모 → `fetchTrackedChecklistCharacters` 가 유령을 뺀다.
-- · 같은 카드의 **`최대` 금액** → 이 뷰가 `ch.is_tracked` 만 보므로 유령을 계속 센다.
--
-- 그런데 이 화면의 핵심 질문은 **"얼마가 남았나 = 최대 − 현재"** 다(CLAUDE.md §1.1.1).
-- 분자만 유령을 세면 남은 금액이 그대로 부풀려진다. 실측(발주 계정, 챌린저스3 2명을
-- 유령으로 가정):
--
--     주간 최대  54,432,033,332 (계획 103 · 캐릭터 9)
--             →  50,304,433,332 (계획  83 · 캐릭터 7)   = 41.3억 과다
--     월간 최대  36,353,333,333 (캐릭터 8)
--             →  35,688,333,333 (캐릭터 7)              =  6.65억 과다
--   다른 계정에서는 최대 98.2억까지 부풀려졌다.
--
-- 발주자가 2026-08-27 에 신고한 *"한 카드 안에서 두 줄이 다른 범위를 센다"* 와 같은 결함이다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 여기서 고치는가 — **최대치는 DB 뷰가 소유한다** (§1.1.1)
-- ───────────────────────────────────────────────────────────────────────────────
-- 소비처가 셋이다:
--   · `features/income/server/crystal-summary.ts`
--   · `features/dashboard/server/dashboard-repo.ts`
--   · 봇 `features/bot/server/bot-repo.ts` (`!숙제 <닉>` 의 `최대`)
-- 셋 다 같은 값을 읽으므로 **뷰 한 곳만 고친다.** TS 에서 한 번 더 빼면 웹과 방이
-- 다른 숫자를 말하기 시작하고, 그것이 12칸 정렬·초과 제외를 SQL 에 둔 이유 전부를 무너뜨린다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 `create or replace` 인가 (`drop … cascade` 가 아니라)
-- ───────────────────────────────────────────────────────────────────────────────
-- 1. **컬럼 목록이 그대로다.** 조건 한 줄만 는다 → `create or replace` 가 허용하는 변경이다.
-- 2. **의존 뷰가 정확히 하나**(`v_weekly_plan_potential`, 이 뷰를 그냥 합산할 뿐이다.
--    실측: `pg_depend` 조회 결과 이것 하나). `drop … cascade` 로 가면 그 뷰가 함께
--    날아가고 **GRANT 와 `security_invoker=true` 까지 초기화된다** — 되살리는 과정에서
--    권한을 한 줄이라도 빠뜨리면 그게 곧 노출이다. 바꿀 이유가 없는 것은 건드리지 않는다.
-- 3. `create or replace` 는 GRANT 를 보존하므로 이 파일에는 권한 재설정이 없다
--    (실측 현재 권한: `postgres` · `service_role` 뿐, `anon`/`authenticated` 는 0건).
--
-- ⚠️ **`with (...)` 를 일부러 쓰지 않는다.** `CREATE OR REPLACE VIEW` 는 명시하지 않은
--    reloptions 를 **덮어쓴다.** 이 뷰의 현재 reloptions 는 `null` 이며(실측 —
--    `20260826120000` 가 `with` 없이 replace 하면서 `security_invoker` 가 이미 떨어졌다),
--    여기서 되살리면 이번 변경에 **무관한 동작 변경**이 섞인다. 그 뷰는 `anon`/
--    `authenticated` 에 GRANT 가 없어 지금은 무해하므로, 되살리는 일은 별건으로 남긴다.
--
-- ⚠️ 형제 뷰 `v_weekly_plan_potential` 은 **손대지 않는다.** `characters` 를 스스로 조인하지
--    않고 이 뷰를 `group by user_id, cycle` 로 합산할 뿐이라, 여기만 고치면 함께 맞는다.
--
-- ⚠️ `is_tracked` 는 여전히 **끄지 않는다.** `missing_since` 는 리프·삭제·키 회수를 구분하지
--    못하고 그중 키 회수는 복구 가능하다 — 구분 못 하는 신호로 사용자의 선택을 되돌릴 수
--    없게 고쳐 쓰지 않는다. **보이는 데서 빼는 것**이 전부다.
--    (`20260914120000_character_missing_since.sql` 머리말과 같은 근거.)
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace view public.v_weekly_plan_potential_by_character as
 WITH planned AS (
         SELECT p.user_id, p.character_id, bd.cycle, p.boss_difficulty_id, p.default_party_size,
            bd.cycle = 'weekly'::boss_cycle AND bd.counts_toward_weekly_limit AS counts_limit,
            cp.price_meso AS base_price_meso,
                CASE WHEN cp.price_meso IS NULL THEN NULL::bigint
                     ELSE cp.price_meso / p.default_party_size END AS share_meso
           FROM character_boss_plans p
             -- ★ 여기가 이 마이그레이션의 전부다. `is_tracked` 는 **사용자의 선택**이고
             --   `missing_since is null` 은 **관측된 사실**이라, 둘을 함께 걸어야 "지금
             --   실제로 돌 수 있는 캐릭터"가 된다. 웹 체크리스트(`boss-plan-repo`)와
             --   봇 숙제판(`bot-repo`)이 쓰는 조건과 **글자 그대로 같아야** 한다.
             JOIN characters ch ON ch.id = p.character_id
                               AND ch.is_tracked
                               AND ch.missing_since IS NULL
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

comment on view public.v_weekly_plan_potential_by_character is
  '캐릭터 × 주기 이론상 최대 결정석 수익. 모집단은 **추적 중이고 넥슨 목록에 살아 있는** 캐릭터(is_tracked AND missing_since IS NULL) — 웹 체크리스트·봇 숙제판과 같은 조건이라 한 카드가 두 모집단을 말하지 않는다. 시즌은 금액 집계에서만 weekly 로 접힌다.';


-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare
  v_rows integer;
  v_ghost_rows integer;
begin
  -- 1. 시즌 버킷은 여전히 주간에 접혀 있어야 한다(20260826120000 이 세운 불변식).
  select count(*) into v_rows from public.v_weekly_plan_potential_by_character
   where cycle = 'season'::boss_cycle;
  if v_rows > 0 then
    raise exception '최대치 집계에 season 버킷이 남아 있습니다 — 주간에 합쳐지지 않았습니다.';
  end if;

  -- 2. ★ 이 파일의 본론. 사라진 캐릭터가 최대치에 **한 행도** 남아 있으면 안 된다.
  --    현재 데이터는 `missing_since` 가 전부 null 이라 이 검사는 0을 확인할 뿐이지만,
  --    조인 조건을 나중에 누가 지우면 그때 바로 터진다 — 그게 이 블록의 목적이다.
  select count(*) into v_ghost_rows
    from public.v_weekly_plan_potential_by_character v
    join public.characters ch on ch.id = v.character_id
   where ch.missing_since is not null;
  if v_ghost_rows > 0 then
    raise exception
      '최대치 뷰가 사라진 캐릭터를 %건 세고 있습니다 — `/boss-status` 의 "남은 금액"이 부풀려집니다.',
      v_ghost_rows;
  end if;

  -- 3. 형제 뷰는 이 뷰를 합산할 뿐이므로 함께 맞아야 한다. 캐릭터 수로 대조한다.
  select count(*) into v_rows
    from public.v_weekly_plan_potential p
   where p.character_count <> (
           select count(distinct b.character_id)
             from public.v_weekly_plan_potential_by_character b
            where b.user_id = p.user_id and b.cycle = p.cycle
         );
  if v_rows > 0 then
    raise exception 'v_weekly_plan_potential 의 character_count 가 기반 뷰와 어긋납니다(%건).', v_rows;
  end if;

  raise notice '최대치 뷰에서 사라진 캐릭터를 제외했다 — 카드의 목록·분모·최대가 같은 모집단을 센다';
end $$;

-- ⚠️ 모든 마이그레이션의 마지막 줄 (CLAUDE.md §0.3). 이 파일은 컬럼을 추가하지 않지만,
--    뷰 재생성은 GRANT 를 되살릴 수 있는 연산이라 확인은 그대로 돌린다.
select public.assert_no_public_sensitive_columns();
