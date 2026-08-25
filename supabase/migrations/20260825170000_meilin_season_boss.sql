-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 시즌 보스 **메이린을 기록한다** — 12칸은 먹지 않는 주간 보스
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-08-25): *"메이린도 기록 해 시즌이지만 도는 보스잖아."*
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 무엇을 뒤집는가
-- ───────────────────────────────────────────────────────────────────────────────
-- 시드(17)는 메이린을 `nexon_unmapped_contents.resolution = 'intentionally_excluded'`
-- 로 **일부러 뺐다.** 근거는 "챌린저스 월드 전용 이벤트 보스이고 결정석 수익 계산 대상이
-- 아니다" 였다. 발주자가 그 판단을 뒤집었다 — 실제로 도는 보스이므로 화면에 나와야 한다.
-- 실측으로도 확인된다: 킴잔델의 최신 스냅샷에 `하드 메이린 registered=true` 가 있다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- ★ 핵심 — **주간 보스지만 12칸을 먹지 않는다**
-- ───────────────────────────────────────────────────────────────────────────────
-- 넥슨은 메이린을 `cycle = bossWeekly` 로 준다. 그런데 주간 결정석 12칸에는 포함되지
-- 않는다(`Claude/research-BOSS-DATA.md` L164). 실측이 이를 뒷받침한다 —
--
--   킴잔델: weekly_boss_clear_count 12 / limit 12. 그런데 하드 메이린은 registered=true.
--
-- 12칸이 찬 뒤에도 등록이 살아 있다는 것은 **그 12에 포함되지 않는다**는 뜻이다
-- (2025-08-21 패치 이후 13번째 주간 보스는 입장 자체가 막힌다 · §1).
--
-- 그래서 `cycle = 'weekly'` 로 넣되 **`counts_toward_weekly_limit = false`** 를 함께 준다.
-- 이 구분이 없으면 메이린 하나 때문에:
--   · 체크리스트가 13/12 를 띄우고 "하나 꺼 주세요" 라는 틀린 안내를 하고,
--   · 밤 동기화가 그 캐릭터를 "다 찼다"로 보고 **건너뛰어 메이린 클리어를 영영 못 받는다.**
-- 두 번째가 특히 나쁘다 — 기록하라고 넣은 보스가 기록되지 않는다.
--
-- 열 이름은 새로 만든 것이 아니다. `v_character_boss_plan_status` 가 이미
-- `bd.cycle = 'weekly' AS counts_toward_weekly_limit` 이라는 **파생 값**으로 이 개념을
-- 갖고 있었다. 이제 그것을 진짜 열로 승격하고 뷰가 그 열을 읽게 한다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 모르는 값은 모른다고 적는다
-- ───────────────────────────────────────────────────────────────────────────────
-- · **결정석 시세: 알 수 없음(null).** 공개 가격표에 메이린이 없다
--   (`Claude/review-BOSS-DATA.md` L96). §1.3 D4 에 따라 null 은 0 이 아니라 **미상**이며
--   수익 합계에서 제외되고 "가격 미상 N건" 으로 따로 세어진다. 행을 아예 안 만들지 않고
--   **null 행을 명시적으로 남기는** 이유는 벨로나 때와 같다(R3) — 시세표는 역사이고,
--   "그때 우리는 몰랐다"가 기록으로 남아야 나중 스냅샷을 설명할 수 있다.
-- · **max_party 3 은 추정이다.** modern 세대 보스가 전부 3이라 맞춘 값이고 개별 출처는
--   없다(§1.3 D5). 경고용 soft bound 라 실제 파티를 막지는 않는다. 확인되면 고칠 것.
-- · **2026-09-16(수) 23:59 입장 종료.** 그날이 지나면 넥슨이 목록에서 빼므로 계획도
--   자연히 갱신된다. 별도의 만료 장치는 두지 않는다 — 쓰지 않을 기계를 미리 만드는 값보다
--   그날 한 번 손보는 값이 싸다.

-- ── 1. 12칸을 먹는지 여부를 진짜 열로 ────────────────────────────────────────
alter table public.boss_difficulties
  add column if not exists counts_toward_weekly_limit boolean not null default true;

comment on column public.boss_difficulties.counts_toward_weekly_limit is
  '이 보스가 주간 결정석 12칸을 소비하는가. 이벤트/시즌 보스는 cycle=weekly 이면서도 false 다. '
  'false 인 보스는 12칸 계산·초과 경고·밤 동기화 건너뛰기 판정에서 모두 빠진다.';

-- ── 2. 보스 마스터 ───────────────────────────────────────────────────────────
insert into public.bosses (id, korean_name, generation, nexon_content_name, nexon_name_verified, sort_order)
values
  ('meilin', '메이린', 'modern', '시즌 보스 메이린', true, 900)
on conflict (id) do update set
  korean_name         = excluded.korean_name,
  generation          = excluded.generation,
  nexon_content_name  = excluded.nexon_content_name,
  nexon_name_verified = excluded.nexon_name_verified,
  sort_order          = excluded.sort_order;

insert into public.boss_difficulties
  (id, boss_id, korean_name, difficulty, cycle, max_party, entry_level, released, nexon_difficulty, sort_order)
values
  ('meilin_normal', 'meilin', '노멀 메이린', 'normal', 'weekly', 3, 260, true, 'normal', 900),
  ('meilin_hard',   'meilin', '하드 메이린', 'hard',   'weekly', 3, 260, true, 'hard',   910)
on conflict (id) do update set
  boss_id          = excluded.boss_id,
  korean_name      = excluded.korean_name,
  difficulty       = excluded.difficulty,
  cycle            = excluded.cycle,
  max_party        = excluded.max_party,
  entry_level      = excluded.entry_level,
  released         = excluded.released,
  nexon_difficulty = excluded.nexon_difficulty,
  sort_order       = excluded.sort_order;

-- 12칸 면제. 이 형태(update ... from (values ...))는 생성기가 읽는 앵커이기도 하다.
update public.boss_difficulties wl
   set counts_toward_weekly_limit = v.counts
  from (values
    ('meilin_normal', false),
    ('meilin_hard',   false)
  ) as v(id, counts)
 where wl.id = v.id;

-- 줄임말. 카톡 평문에서 하메린 으로 부를 수 있어야 한다.
update public.boss_difficulties sn
   set short_name = v.short_name
  from (values
    ('meilin_normal', '노메린'),
    ('meilin_hard',   '하메린')
  ) as v(id, short_name)
 where sn.id = v.id;

-- 시세는 **미상**이다. 0 이 아니라 null (§1.3 D4).
insert into public.boss_crystal_prices (boss_difficulty_id, price_meso, effective_from, patch_label, note)
values
  ('meilin_normal', null, timestamptz '2026-08-25 00:00+09', '2026 OVERDRIVE',
   '시세 미상. 공개 가격표에 없음 — 확인되면 새 행으로 추가할 것.'),
  ('meilin_hard',   null, timestamptz '2026-08-25 00:00+09', '2026 OVERDRIVE',
   '시세 미상. 공개 가격표에 없음 — 확인되면 새 행으로 추가할 것.');

insert into public.boss_aliases (boss_id, boss_difficulty_id, alias, normalized_alias, source)
select v.boss_id, v.entry_id, v.alias, lower(btrim(replace(v.alias, ' ', ''))), 'owner:2026-08-25'
from (values
  ('meilin', null,            '메이린'),
  ('meilin', null,            '메린'),
  ('meilin', 'meilin_normal', '노메린'),
  ('meilin', 'meilin_hard',   '하메린')
) as v(boss_id, entry_id, alias)
on conflict do nothing;

-- ── 3. 더 이상 "의도적 제외" 가 아니다 ───────────────────────────────────────
-- 남겨 두면 매핑이 되는데도 제외 표시가 남아, 다음 사람이 이 결정을 거꾸로 읽는다.
delete from public.nexon_unmapped_contents where content_name = '시즌 보스 메이린';

-- ── 4. 뷰가 파생 대신 **열**을 읽게 한다 ─────────────────────────────────────
create or replace view public.v_character_boss_plan_status as
 SELECT p.id AS plan_id, p.user_id, p.character_id, ch.character_name, ch.world_name,
    p.boss_difficulty_id, bd.boss_id, bd.korean_name AS boss_display_name, bd.difficulty,
    bd.cycle, bd.max_party, bd.released, b.sort_order AS boss_sort_order,
    bd.sort_order AS difficulty_sort_order, p.is_active, p.manual_active, p.api_registered,
    p.api_observed_at, p.has_conflict, p.default_party_size,
        CASE
            WHEN p.manual_active IS NOT NULL AND p.api_registered IS NOT NULL THEN 'both'::text
            WHEN p.manual_active IS NOT NULL THEN 'manual'::text
            ELSE 'nexon_api'::text
        END AS origin,
    -- ★ 예전에는 bd.cycle = 'weekly' 라는 파생이었다. 이제 열이 답한다.
    (bd.cycle = 'weekly'::boss_cycle AND bd.counts_toward_weekly_limit) AS counts_toward_weekly_limit,
    week_key(now()) AS week_key,
    COALESCE(bc.effective_cleared, false) AS is_cleared,
    bc.id AS clear_id, bc.cleared_at, bc.has_conflict AS clear_has_conflict,
    p.note, p.created_at, p.updated_at
   FROM character_boss_plans p
     JOIN characters ch ON ch.id = p.character_id
     JOIN boss_difficulties bd ON bd.id = p.boss_difficulty_id
     JOIN bosses b ON b.id = bd.boss_id
     LEFT JOIN LATERAL ( SELECT c.* FROM boss_clears c
          WHERE c.character_id = p.character_id AND c.boss_difficulty_id = p.boss_difficulty_id AND
                CASE bd.cycle
                    WHEN 'monthly'::boss_cycle THEN date_trunc('month'::text, kst_date(c.cleared_at)::timestamp with time zone) = date_trunc('month'::text, kst_date(now())::timestamp with time zone)
                    WHEN 'daily'::boss_cycle THEN kst_date(c.cleared_at) = kst_date(now())
                    ELSE c.week_key = week_key(now())
                END
          ORDER BY c.effective_cleared DESC, c.cleared_at DESC NULLS LAST
         LIMIT 1) bc ON true;

/*
  주간 카운터의 뜻을 **"12칸을 먹는 것"** 으로 좁힌다.

  planned_weekly 는 화면에서 N / 12 의 N 으로 쓰이는 값이다. 그러니 세는 대상이
  12칸을 먹는 보스여야 말이 된다. 면제 보스는 새 열 두 개로 따로 보이게 두어
  "안 세는 것"과 "없는 것"이 구분되게 한다.
*/
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
    -- 새 열: 주간이지만 12칸을 안 먹는 것(메이린 같은 시즌 보스).
    count(*) FILTER (WHERE is_active AND cycle = 'weekly'::boss_cycle AND NOT counts_toward_weekly_limit) AS planned_weekly_exempt,
    count(*) FILTER (WHERE is_active AND cycle = 'weekly'::boss_cycle AND NOT counts_toward_weekly_limit AND is_cleared) AS cleared_weekly_exempt
   FROM v_character_boss_plan_status s
  GROUP BY user_id, character_id, character_name, world_name, week_key;

/*
  최대 수익 — 면제 보스는 **순위 경쟁에서 빼서** 12위 밖으로 밀려나지 않게 한다.
  counts_limit 을 partition 에 넣으면 면제 보스끼리 따로 1위부터 매겨져
  cycle_rank <= 12 가 언제나 참이 된다. 필터를 특별 케이스로 어지럽히지 않는 방법이다.
  (메이린은 시세가 null 이라 합계에는 어차피 0 을 더한다 — 그래도 "12위 밖"으로 세어
   경고를 띄우는 것은 틀렸다.)
*/
create or replace view public.v_weekly_plan_potential_by_character as
 WITH planned AS (
         SELECT p.user_id, p.character_id, bd.cycle, p.boss_difficulty_id, p.default_party_size,
            (bd.cycle = 'weekly'::boss_cycle AND bd.counts_toward_weekly_limit) AS counts_limit,
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
            row_number() OVER (PARTITION BY planned.user_id, planned.character_id, planned.cycle, planned.counts_limit
                               ORDER BY planned.share_meso DESC NULLS LAST, planned.boss_difficulty_id) AS cycle_rank
           FROM planned
        )
 SELECT user_id, character_id, cycle,
    count(*) AS planned_count,
    count(*) FILTER (WHERE NOT counts_limit OR cycle_rank <= weekly_crystal_sell_limit()) AS counted_count,
    count(*) FILTER (WHERE counts_limit AND cycle_rank > weekly_crystal_sell_limit()) AS over_limit_count,
    count(*) FILTER (WHERE share_meso IS NULL) AS unknown_price_count,
    weekly_crystal_sell_limit() AS weekly_sell_limit,
    COALESCE(sum(share_meso) FILTER (WHERE NOT counts_limit OR cycle_rank <= weekly_crystal_sell_limit()), 0::numeric)::bigint AS potential_meso
   FROM ranked
  GROUP BY user_id, character_id, cycle;

/* 실제 수익도 같은 규칙. 여기는 클리어를 세므로 난이도 표를 조인해 면제 여부를 읽는다. */
create or replace view public.v_weekly_crystal_income_by_character_cycle as
 WITH ranked AS (
         SELECT c.user_id, c.character_id, c.week_key, c.cycle, c.crystal_share_meso,
            (c.cycle = 'weekly'::boss_cycle AND COALESCE(bd.counts_toward_weekly_limit, true)) AS counts_limit,
            row_number() OVER (PARTITION BY c.user_id, c.character_id, c.week_key, c.cycle,
                                            (c.cycle = 'weekly'::boss_cycle AND COALESCE(bd.counts_toward_weekly_limit, true))
                               ORDER BY c.crystal_share_meso DESC NULLS LAST, c.id) AS cycle_rank
           FROM boss_clears c
           LEFT JOIN boss_difficulties bd ON bd.id = c.boss_difficulty_id
          WHERE c.effective_cleared
        )
 SELECT user_id, character_id, week_key, cycle,
    count(*) AS clear_count,
    count(*) FILTER (WHERE crystal_share_meso IS NULL) AS unknown_price_count,
    count(*) FILTER (WHERE counts_limit AND cycle_rank > weekly_crystal_sell_limit()) AS over_limit_count,
    weekly_crystal_sell_limit() AS weekly_sell_limit,
    COALESCE(sum(crystal_share_meso) FILTER (WHERE NOT counts_limit OR cycle_rank <= weekly_crystal_sell_limit()), 0::numeric)::bigint AS income_meso
   FROM ranked
  GROUP BY user_id, character_id, week_key, cycle;

-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare
  v_id     text;
  v_exempt integer;
  v_over   integer;
  v_price  integer;
begin
  -- 넥슨이 주는 그대로가 매핑되어야 한다. 이게 이 마이그레이션의 존재 이유다.
  select public.nexon_resolve_boss_difficulty('시즌 보스 메이린', 'hard', 'bossWeekly') into v_id;
  if v_id is distinct from 'meilin_hard' then
    raise exception '하드 메이린 매핑 실패: %', coalesce(v_id, '(null)');
  end if;
  select public.nexon_resolve_boss_difficulty('시즌 보스 메이린', 'normal', 'bossWeekly') into v_id;
  if v_id is distinct from 'meilin_normal' then
    raise exception '노멀 메이린 매핑 실패: %', coalesce(v_id, '(null)');
  end if;

  -- 매핑이 되면 미매핑 표에 다시 쌓이지 않아야 한다.
  if exists (select 1 from public.nexon_unmapped_contents where content_name = '시즌 보스 메이린') then
    raise exception '메이린이 아직 미매핑 표에 남아 있습니다.';
  end if;

  -- 12칸 면제가 실제로 걸렸는가.
  select count(*) into v_exempt from public.boss_difficulties
   where id in ('meilin_normal','meilin_hard') and not counts_toward_weekly_limit;
  if v_exempt <> 2 then
    raise exception '메이린 12칸 면제가 %건입니다(2건이어야 함).', v_exempt;
  end if;

  -- 실수로 넓게 걸었는지 확인 — 메이린 외에는 면제가 없어야 한다.
  select count(*) into v_over from public.boss_difficulties
   where not counts_toward_weekly_limit and boss_id <> 'meilin';
  if v_over > 0 then
    raise exception '메이린 외 %건이 12칸 면제로 표시됐습니다.', v_over;
  end if;

  -- 시세는 **미상**이어야 한다. 0 이 들어가면 수익이 조용히 0 으로 합산된다(D4).
  select count(*) into v_price from public.boss_crystal_prices
   where boss_difficulty_id in ('meilin_normal','meilin_hard') and price_meso is not null;
  if v_price > 0 then
    raise exception '메이린 시세에 null 이 아닌 값이 %건 있습니다 — 출처 없이 넣지 마세요.', v_price;
  end if;

  raise notice '메이린 등록 완료 — 주간 보스, 12칸 면제, 시세 미상';
end $$;

select public.assert_no_public_sensitive_columns();
