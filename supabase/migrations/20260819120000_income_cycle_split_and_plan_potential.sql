-- =============================================================================
-- M_Schedule · 27. 결정석 수익의 **주간/월간 분리** + **이론상 최대치**
-- =============================================================================
-- 발주자 지시(2026-08-19):
--   · *"주간 월간은 따로놔야지"*
--   · 결정석 수익 카드에 **이론상 최대치**를 표시한다(선택지 중 명시적으로 고름).
--
-- ── 무엇이 문제였나 ─────────────────────────────────────────────────────────
-- 대시보드 카드가 `주간 보스 40 / 84건` 과 `주간+월간 41건` 을 나란히 그리고 있었다.
-- **12개 상한은 주간에만 걸린다**(§1). 월간을 같은 칸에 섞으면 분모가 뜻을 잃고, 실제로
-- 그 화면은 "84칸 중 41칸을 썼다"로 읽혔다 — 월간 1건은 그 84칸을 한 칸도 먹지 않는다.
-- 그런데 뷰에는 주기별로 **금액을 가른 컬럼이 아예 없었다.** 건수만 갈라져 있고
-- `crystal_income_meso` 는 주간+월간(+과거의 일간)을 뭉쳐 놓은 한 값이었다.
--
-- 그래서 이 마이그레이션은 **주기(cycle)를 1차 집계의 축으로 끌어올린다.**
--
--     boss_clears
--       └▶ v_weekly_crystal_income_by_character_cycle   ← ★ 새 기준 뷰 (캐릭터 × 주차 × 주기)
--            └▶ v_weekly_crystal_income_by_character    (주기를 접어 예전 모양 그대로)
--                 └▶ v_weekly_crystal_income            (+ 주기별 금액 컬럼 추가)
--                      └▶ v_weekly_income               (+ 주기별 금액·월간 건수 추가)
--
-- 기존 세 뷰는 **컬럼을 하나도 잃지 않는다.** 읽는 쪽(dashboard-repo · income-repo ·
-- crystal-scope)이 명시적 select 목록을 쓰므로 컬럼 추가는 안전하고, 기존 컬럼의 타입도
-- 예전과 같은 캐스팅을 그대로 유지했다(bigint ↔ numeric 이 바뀌면 PostgREST 가 숫자를
-- 문자열로 바꿔 보내기 시작한다).
--
-- ── ★ 같이 고치는 결함: 12개 절삭 순위가 **일간·월간 행에 잠식당하고 있었다** ────
-- 예전 `v_weekly_crystal_income_by_character` 의 순위식은 이랬다:
--
--     case when c.cycle = 'weekly' then
--       row_number() over (partition by user_id, character_id, week_key
--                          order by crystal_share_meso desc nulls last, id)
--     end as weekly_rank
--
-- `row_number()` 는 **파티션 전체**(주간+월간+일간)에 번호를 매기고, `case` 는 그중
-- 주간 행의 번호만 꺼내 쓴다. 즉 **월간 클리어 한 건이 주간 순위 한 칸을 먹는다.**
-- 월간 결정석이 비싸서 1번을 가져가면 그 캐릭터의 12번째 주간 보스가 13번이 되어
-- `weekly_over_limit_count` 로 잡히고 금액에서 **빠진다**.
-- 적용 시점 실측으로는 12개를 채운 캐릭터가 없어 증상이 드러나지 않았지만(전부 0건),
-- 계획 기준으로는 이미 재현된다 — 계획 12 + 월간 1 인 캐릭터에서 `max(rank) = 13`.
-- 새 뷰는 `partition by … , cycle` 로 **주기 안에서만** 번호를 매겨 이것을 고친다.
-- (§0.2-1 "같은 결함이 사는 자리를 함께 고친다" — 아래 계획 뷰도 같은 식을 쓴다.)
--
-- ── 이론상 최대치란 무엇인가 ────────────────────────────────────────────────
-- **이번 주 계획(`character_boss_plans` 의 켜진 보스)을 전부 클리어했을 때의 수령액 합.**
--   · 인원은 계획의 `default_party_size` 로 나눈다 — `floor(가격 / 인원)` (§1).
--     이 컬럼은 마이그레이션 25 로 **NOT NULL DEFAULT 1** 이다. null 분기는 없다.
--   · **캐릭터당 주간 12개 상한**을 그대로 적용한다(가격 내림차순 12개까지).
--   · **가격 미확인(`crystal_price is null`, 벨로나 3난이도 — §1.3 D4)은 합계에서 빠지고
--     건수로만 보고된다.** 0 으로 더하면 최대치가 과소평가되고, D4 가 금지한 것이다.
--   · **일간 보스는 들어가지 않는다**(2026-08-18 발주자 결정). 실제 수익 집계와 범위가
--     같아야 `현재 / 최대` 비율이 뜻을 갖는다.
--   · **추적 중인 캐릭터만** 센다(§2.1.1). 추적 해제한 캐릭터의 계획 행은 남아 있지만
--     동기화도 클리어도 일어나지 않으므로 분모에 넣으면 최대치가 영원히 안 닿는 값이 된다.
--
-- ⚠️ **이 값은 목표가 아니라 상한이다.** 실제로 갈 생각이 없는 보스도 계획에 켜져 있으면
--    분모가 커진다. 화면은 그 뜻을 문장으로 함께 말한다(`crystal-income-summary.tsx`).
--
-- ⚠️ **주차 축이 없다.** 계획은 "매주 이 보스를 돈다"는 현재 상태이고 과거 주차의 계획
--    스냅샷은 어디에도 남지 않는다. 그래서 최대치는 **이번 주에만** 뜻이 있고, 화면도
--    이번 주 카드에서만 그린다. 과거 주차 내역에는 최대치를 붙이지 않는다.
--
-- 넥슨 API 호출 없음. 재실행 안전(idempotent) — 전부 drop → create 다.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 27-0. 의존 순서대로 내린다
-- -----------------------------------------------------------------------------
-- 실측한 의존 관계(pg_depend):
--   v_weekly_income → v_weekly_crystal_income → v_weekly_crystal_income_by_character
--   v_weekly_income → v_weekly_drop_income (이 마이그레이션은 건드리지 않는다)
-- 그래서 위에서부터 내리면 cascade 가 남의 뷰를 데려가지 않는다.
drop view if exists public.v_weekly_income cascade;
drop view if exists public.v_weekly_crystal_income cascade;
drop view if exists public.v_weekly_crystal_income_by_character cascade;
drop view if exists public.v_weekly_crystal_income_by_character_cycle cascade;
drop view if exists public.v_weekly_plan_potential cascade;
drop view if exists public.v_weekly_plan_potential_by_character cascade;


-- -----------------------------------------------------------------------------
-- 27-1. v_weekly_crystal_income_by_character_cycle — 새 1차 집계 (캐릭터 × 주차 × 주기)
-- -----------------------------------------------------------------------------
-- 계산 규칙은 예전 뷰와 **한 글자도 다르지 않다**. 바뀐 것은 둘뿐이다.
--   (a) 그룹 축에 `cycle` 이 들어갔다 — 금액을 주기별로 가를 수 있게 됐다.
--   (b) 순위 파티션에 `cycle` 이 들어갔다 — 위 머리말의 결함을 고친다.
--
-- `cycle is distinct from 'weekly'` 로 쓰는 이유: `effective_cleared` 인 행은 CHECK 상
-- `cycle` 이 not null 이지만, `<>` 는 null 에서 null 을 내 **그 행의 금액이 조용히 합계에서
-- 빠진다.** 방어적으로 3값 논리를 피한다.
create view public.v_weekly_crystal_income_by_character_cycle
with (security_invoker = true) as
with ranked as (
  select
    c.user_id,
    c.character_id,
    c.week_key,
    c.cycle,
    c.crystal_share_meso,
    row_number() over (
      partition by c.user_id, c.character_id, c.week_key, c.cycle
      order by c.crystal_share_meso desc nulls last, c.id
    ) as cycle_rank
  from public.boss_clears c
  where c.effective_cleared
)
select
  user_id,
  character_id,
  week_key,
  cycle,
  count(*)::bigint                                              as clear_count,
  count(*) filter (where crystal_share_meso is null)::bigint     as unknown_price_count,
  count(*) filter (
    where cycle = 'weekly'::public.boss_cycle
      and cycle_rank > public.weekly_crystal_sell_limit()
  )::bigint                                                      as over_limit_count,
  public.weekly_crystal_sell_limit()                             as weekly_sell_limit,
  coalesce(sum(crystal_share_meso) filter (
    where cycle is distinct from 'weekly'::public.boss_cycle
       or cycle_rank <= public.weekly_crystal_sell_limit()
  ), 0)::bigint                                                  as income_meso
from ranked
group by user_id, character_id, week_key, cycle;

comment on view public.v_weekly_crystal_income_by_character_cycle is
  '캐릭터 × 주차 × 주기 결정석 수익. 12개 절삭 순위를 주기 안에서만 매겨(월간이 주간 칸을 먹지 않게) 계산한다. 상위 집계 뷰 전부의 기준.';


-- -----------------------------------------------------------------------------
-- 27-2. v_weekly_crystal_income_by_character — 주기를 접어 **예전 모양 그대로**
-- -----------------------------------------------------------------------------
-- 컬럼 이름·타입·의미가 전부 예전과 같다. `count(*)` 이던 자리는 `sum(...)::bigint` 이므로
-- PostgREST 가 내보내는 JSON 모양(숫자)도 그대로다.
create view public.v_weekly_crystal_income_by_character
with (security_invoker = true) as
select
  user_id,
  character_id,
  week_key,
  sum(clear_count)::bigint                                                        as clear_count,
  coalesce(sum(clear_count) filter (where cycle = 'weekly'::public.boss_cycle), 0)::bigint  as weekly_clear_count,
  coalesce(sum(clear_count) filter (where cycle = 'daily'::public.boss_cycle), 0)::bigint   as daily_clear_count,
  coalesce(sum(clear_count) filter (where cycle = 'monthly'::public.boss_cycle), 0)::bigint as monthly_clear_count,
  sum(unknown_price_count)::bigint                                                as unknown_price_count,
  sum(over_limit_count)::bigint                                                   as weekly_over_limit_count,
  max(weekly_sell_limit)::integer                                                 as weekly_sell_limit,
  sum(income_meso)::bigint                                                        as income_meso
from public.v_weekly_crystal_income_by_character_cycle
group by user_id, character_id, week_key;

comment on view public.v_weekly_crystal_income_by_character is
  '캐릭터 × 주차 결정석 수익(1차 집계). 주간 결정 12개 한도가 캐릭터 단위이므로 여기가 기준 단위다. 절삭은 방어 로직이며 순위는 주기 안에서만 매긴다.';


-- -----------------------------------------------------------------------------
-- 27-3. v_weekly_crystal_income — 사용자 × 주차 (+ 주기별 금액 컬럼 추가)
-- -----------------------------------------------------------------------------
-- ★ 기존 컬럼은 그대로 두고 `weekly_income_meso` · `monthly_income_meso` ·
--   `daily_income_meso` 셋을 더한다. 셋을 더하면 `income_meso` 와 정확히 같다.
--   그래서 화면은 **뺄셈을 하지 않고** 필요한 주기의 값을 그대로 읽으면 된다.
--
-- ⚠️ `character_count` 는 예전에 `count(*)`(캐릭터별 행 수)였다. 기준 뷰가 주기까지
--    갈라진 지금은 같은 캐릭터가 여러 행이므로 `count(distinct character_id)` 로 쓴다.
--    캐릭터 미지정(`character_id is null`) 묶음이 하나 있으면 예전에는 1로 셌고 지금은
--    빠지는데, 이 컬럼은 저장소 어디에서도 읽히지 않는다(실측 0건).
create view public.v_weekly_crystal_income
with (security_invoker = true) as
select
  user_id,
  week_key,
  sum(income_meso)::bigint                                                          as income_meso,
  sum(clear_count)                                                                  as clear_count,
  coalesce(sum(clear_count) filter (where cycle = 'weekly'::public.boss_cycle), 0)  as weekly_clear_count,
  coalesce(sum(clear_count) filter (where cycle = 'daily'::public.boss_cycle), 0)   as daily_clear_count,
  coalesce(sum(clear_count) filter (where cycle = 'monthly'::public.boss_cycle), 0) as monthly_clear_count,
  sum(unknown_price_count)                                                          as unknown_price_count,
  sum(over_limit_count)                                                             as weekly_over_limit_count,
  count(distinct character_id)                                                      as character_count,
  -- ★ 27 추가: 주기별 금액. `주간 + 월간 + 일간 = income_meso` 가 항등식이다.
  coalesce(sum(income_meso) filter (where cycle = 'weekly'::public.boss_cycle), 0)::bigint  as weekly_income_meso,
  coalesce(sum(income_meso) filter (where cycle = 'monthly'::public.boss_cycle), 0)::bigint as monthly_income_meso,
  coalesce(sum(income_meso) filter (where cycle = 'daily'::public.boss_cycle), 0)::bigint   as daily_income_meso,
  coalesce(sum(unknown_price_count) filter (where cycle = 'weekly'::public.boss_cycle), 0)  as weekly_unknown_price_count,
  coalesce(sum(unknown_price_count) filter (where cycle = 'monthly'::public.boss_cycle), 0) as monthly_unknown_price_count
from public.v_weekly_crystal_income_by_character_cycle
group by user_id, week_key;

comment on view public.v_weekly_crystal_income is
  '사용자 × 주차 결정석 수익(2차 집계). 27 부터 주기별 금액·미확인 건수를 함께 낸다 — 12개 상한은 주간에만 걸리므로 화면이 주간/월간을 섞으면 분모가 뜻을 잃는다.';


-- -----------------------------------------------------------------------------
-- 27-4. v_weekly_income — 주간 총수익 (+ 주기별 결정석 금액·월간 건수 추가)
-- -----------------------------------------------------------------------------
-- 14-8 원문에 컬럼만 더한 것이다. 기존 컬럼은 이름·순서·`coalesce` 규칙까지 그대로다.
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
  (coalesce(c.income_meso, 0) + coalesce(d.drop_income_meso, 0))::bigint as total_income_meso,
  -- ★ 27 추가 — 주간/월간을 섞지 않기 위한 최소 집합.
  --   일간은 범위 밖이라(2026-08-18 발주자 지시) 금액만 검산용으로 싣고 건수는 싣지 않는다.
  coalesce(c.monthly_clear_count, 0)          as monthly_clear_count,
  coalesce(c.weekly_income_meso, 0)::bigint   as weekly_crystal_income_meso,
  coalesce(c.monthly_income_meso, 0)::bigint  as monthly_crystal_income_meso,
  coalesce(c.daily_income_meso, 0)::bigint    as daily_crystal_income_meso,
  coalesce(c.weekly_unknown_price_count, 0)   as weekly_unknown_price_count,
  coalesce(c.monthly_unknown_price_count, 0)  as monthly_unknown_price_count
from keys k
left join public.v_weekly_crystal_income c on c.user_id = k.user_id and c.week_key = k.week_key
left join public.v_weekly_drop_income    d on d.user_id = k.user_id and d.week_key = k.week_key
left join public.v_weekly_unsold_drops   u on u.user_id = k.user_id and u.week_key = k.week_key;

comment on view public.v_weekly_income is
  '주간 총수익 = 결정석 분배 몫 + 드랍 분배 몫. 두 계통을 분리해 보여준다(12개 한도는 결정석 주간에만 적용). 27 부터 결정석 금액을 주간/월간/일간으로 갈라 함께 낸다. 미판매 드랍은 금액이 아니라 건수로 보고한다.';


-- -----------------------------------------------------------------------------
-- 27-5. v_weekly_plan_potential_by_character — 이론상 최대치 (캐릭터 × 주기)
-- -----------------------------------------------------------------------------
-- "이번 주 계획을 전부 클리어하면 얼마인가". 실제 수익 뷰와 **같은 절삭 규칙**을 쓰므로
-- `현재 / 최대` 비율이 같은 잣대 위에 놓인다.
--
-- ★ 가격은 `current_crystal_price(boss, now())` 다. 클리어 스냅샷이 아니라 **지금 시세**를
--   보는 것이 맞다 — 아직 일어나지 않은 클리어의 예상액이기 때문이다.
-- ★ `share_meso` 가 null 인 행(가격 미확인)도 **순위는 차지한다.** 인게임에서도 그 보스를
--   돌면 12칸 중 한 칸을 실제로 쓰기 때문이다. 다만 `nulls last` 라 아는 값이 먼저 들어간다.
create view public.v_weekly_plan_potential_by_character
with (security_invoker = true) as
with planned as (
  select
    p.user_id,
    p.character_id,
    bd.cycle,
    p.boss_difficulty_id,
    p.default_party_size,
    cp.price_meso as base_price_meso,
    -- bigint / integer 는 0 방향 절삭이고 가격은 음수가 될 수 없으므로 floor 와 같다.
    -- (트리거 `boss_clears_apply_state()` 의 1/n 식과 **문자 그대로 같은 연산**이다.)
    case when cp.price_meso is null then null
         else (cp.price_meso / p.default_party_size)::bigint
    end as share_meso
  from public.character_boss_plans p
  join public.characters ch
    on ch.id = p.character_id
   and ch.is_tracked                                    -- 추적 중인 캐릭터만 (§2.1.1)
  join public.boss_difficulties bd on bd.id = p.boss_difficulty_id
  left join lateral public.current_crystal_price(bd.id, now()) cp on true
  where p.is_active
    and bd.cycle <> 'daily'::public.boss_cycle          -- 일간은 범위 밖 (2026-08-18)
),
ranked as (
  select
    planned.*,
    row_number() over (
      partition by user_id, character_id, cycle
      order by share_meso desc nulls last, boss_difficulty_id
    ) as cycle_rank
  from planned
)
select
  user_id,
  character_id,
  cycle,
  count(*)::bigint                                                   as planned_count,
  count(*) filter (
    where cycle is distinct from 'weekly'::public.boss_cycle
       or cycle_rank <= public.weekly_crystal_sell_limit()
  )::bigint                                                          as counted_count,
  count(*) filter (
    where cycle = 'weekly'::public.boss_cycle
      and cycle_rank > public.weekly_crystal_sell_limit()
  )::bigint                                                          as over_limit_count,
  count(*) filter (where share_meso is null)::bigint                 as unknown_price_count,
  public.weekly_crystal_sell_limit()                                 as weekly_sell_limit,
  coalesce(sum(share_meso) filter (
    where cycle is distinct from 'weekly'::public.boss_cycle
       or cycle_rank <= public.weekly_crystal_sell_limit()
  ), 0)::bigint                                                      as potential_meso
from ranked
group by user_id, character_id, cycle;

comment on view public.v_weekly_plan_potential_by_character is
  '캐릭터 × 주기 이론상 최대 결정석 수익 = 켜진 계획을 전부 클리어했을 때. floor(현재가/default_party_size) 합이며 주간은 12개까지만 센다. 가격 미확인은 합계에서 빠지고 건수로만 보고된다(§1.3 D4). 추적 캐릭터·비일간만.';


-- -----------------------------------------------------------------------------
-- 27-6. v_weekly_plan_potential — 사용자 × 주기
-- -----------------------------------------------------------------------------
create view public.v_weekly_plan_potential
with (security_invoker = true) as
select
  user_id,
  cycle,
  count(*)::bigint                 as character_count,
  sum(planned_count)::bigint       as planned_count,
  sum(counted_count)::bigint       as counted_count,
  sum(over_limit_count)::bigint    as over_limit_count,
  sum(unknown_price_count)::bigint as unknown_price_count,
  max(weekly_sell_limit)::integer  as weekly_sell_limit,
  sum(potential_meso)::bigint      as potential_meso
from public.v_weekly_plan_potential_by_character
group by user_id, cycle;

comment on view public.v_weekly_plan_potential is
  '사용자 × 주기 이론상 최대 결정석 수익. 주차 축이 없다 — 계획은 현재 상태이고 과거 주차의 계획 스냅샷은 남지 않으므로 이번 주에만 뜻이 있다.';


-- -----------------------------------------------------------------------------
-- 27-7. 권한 — 뷰는 재생성하면 GRANT 가 초기화된다. 반드시 다시 잠근다
-- -----------------------------------------------------------------------------
-- 전부 `%meso%` 컬럼을 갖고 있어 anon/authenticated 에 한 칸도 열려 있으면 안 된다
-- (`assert_no_public_sensitive_columns()` 가 아래에서 확인한다).
-- 뷰는 `security_invoker = true` 라 기반 테이블(`boss_clears`·`character_boss_plans`·
-- `characters`)의 RLS 가 호출자 기준으로 그대로 걸린다 — 뷰 자체에 정책을 붙일 수는 없고,
-- 붙일 필요도 없다. 실제 읽기는 service_role(Route Handler + 세션 검증)만 한다.
revoke all on table public.v_weekly_crystal_income_by_character_cycle from anon, authenticated;
revoke all on table public.v_weekly_crystal_income_by_character       from anon, authenticated;
revoke all on table public.v_weekly_crystal_income                    from anon, authenticated;
revoke all on table public.v_weekly_income                            from anon, authenticated;
revoke all on table public.v_weekly_plan_potential_by_character       from anon, authenticated;
revoke all on table public.v_weekly_plan_potential                    from anon, authenticated;

grant all on table public.v_weekly_crystal_income_by_character_cycle to service_role;
grant all on table public.v_weekly_crystal_income_by_character       to service_role;
grant all on table public.v_weekly_crystal_income                    to service_role;
grant all on table public.v_weekly_income                            to service_role;
grant all on table public.v_weekly_plan_potential_by_character       to service_role;
grant all on table public.v_weekly_plan_potential                    to service_role;


-- -----------------------------------------------------------------------------
-- 자기검증 — 어긋나면 마이그레이션이 실패한다
-- -----------------------------------------------------------------------------
do $$
declare
  v_user    uuid;
  v_char    uuid;
  v_wk      timestamptz;
  v_week    text;
  v_n       bigint;
  v_meso    bigint;
  v_weekly  bigint;
  v_monthly bigint;
  r         record;
begin
  insert into public.app_users (display_name) values ('__cycle_split_selftest__')
  returning id into v_user;

  insert into public.characters
    (user_id, character_name, world_name, character_level, is_tracked)
  values (v_user, '__cycle_split_selftest_char__', '스카니아', 285, true)
  returning id into v_char;

  v_wk   := public.next_week_reset(now()) - interval '1 second';
  v_week := public.week_key(v_wk);

  -- (1) 주간 1건 + 월간 1건을 넣는다. 둘 다 가격이 있는 보스로 고른다.
  insert into public.boss_clears
    (user_id, character_id, boss_difficulty_id, manual_cleared, manual_set_at, week_key, source)
  values
    (v_user, v_char, 'lotus_hard',           true, v_wk, v_week, 'manual'),
    (v_user, v_char, 'black_mage_extreme',   true, v_wk, v_week, 'manual');

  -- (2) 주기별로 갈렸는가
  select clear_count into v_n
    from public.v_weekly_crystal_income_by_character_cycle
   where user_id = v_user and week_key = v_week and cycle = 'weekly';
  if v_n <> 1 then
    raise exception '주기별 뷰의 주간 건수가 1 이 아닙니다 (%).', v_n;
  end if;

  -- (3) 접은 뷰가 예전 모양 그대로인가 (전체 = 주간 + 월간)
  select clear_count, weekly_clear_count, monthly_clear_count
    into v_n, v_weekly, v_monthly
    from public.v_weekly_crystal_income_by_character
   where user_id = v_user and week_key = v_week;
  if v_n <> 2 or v_weekly <> 1 or v_monthly <> 1 then
    raise exception '캐릭터별 뷰 건수가 어긋납니다 (전체 % / 주간 % / 월간 %).', v_n, v_weekly, v_monthly;
  end if;

  -- (4) 주기별 금액의 합이 총액과 같은가 — 이 항등식이 깨지면 화면이 두 숫자를 말한다
  select crystal_income_meso, weekly_crystal_income_meso,
         monthly_crystal_income_meso, daily_crystal_income_meso
    into v_meso, v_weekly, v_monthly, v_n
    from public.v_weekly_income
   where user_id = v_user and week_key = v_week;
  if v_meso is distinct from (v_weekly + v_monthly + v_n) then
    raise exception '주기별 금액 합(%)이 총액(%)과 다릅니다.', v_weekly + v_monthly + v_n, v_meso;
  end if;
  if v_weekly <= 0 or v_monthly <= 0 then
    raise exception '주간(%) 또는 월간(%) 금액이 0 입니다 — 시드 가격이 사라졌거나 분리가 깨졌습니다.', v_weekly, v_monthly;
  end if;

  -- (5) ★ 12개 절삭 순위가 **주기 안에서만** 매겨지는가 (이번에 고친 결함)
  --     월간 1건이 주간 순위를 먹으면 아래 주간 행의 rank 가 2가 되어야 하는데,
  --     주기별 파티션에서는 1 이어야 한다. 절삭 경계(12)까지 채워 직접 확인한다.
  for r in
    select id from public.boss_difficulties
     where cycle = 'weekly'::public.boss_cycle
       and id <> 'lotus_hard'
       and exists (select 1 from public.boss_crystal_prices p
                    where p.boss_difficulty_id = boss_difficulties.id
                      and p.price_meso is not null)
     order by id
     limit 11
  loop
    insert into public.boss_clears
      (user_id, character_id, boss_difficulty_id, manual_cleared, manual_set_at, week_key, source)
    values (v_user, v_char, r.id, true, v_wk, v_week, 'manual');
  end loop;

  -- 주간 12건 + 월간 1건. 순위가 주기 안에서만 매겨지면 초과는 **0건**이다.
  select weekly_clear_count, weekly_over_limit_count
    into v_weekly, v_n
    from public.v_weekly_crystal_income_by_character
   where user_id = v_user and week_key = v_week;
  if v_weekly <> 12 then
    raise exception '주간 12건을 만들지 못했습니다 (%). 시드 보스 수를 확인하세요.', v_weekly;
  end if;
  if v_n <> 0 then
    raise exception '주간 12건인데 초과가 %건으로 잡혔습니다 — 월간이 주간 순위를 먹고 있습니다.', v_n;
  end if;

  -- (6) 이론상 최대치 — 계획을 켜면 값이 잡히고, 인원을 늘리면 그만큼 줄어든다
  perform public.set_character_boss_plan(v_char, 'lotus_hard', true);
  select potential_meso, planned_count into v_meso, v_n
    from public.v_weekly_plan_potential
   where user_id = v_user and cycle = 'weekly';
  if v_n <> 1 or v_meso <= 0 then
    raise exception '계획 최대치가 잡히지 않았습니다 (건수 % / 금액 %).', v_n, v_meso;
  end if;

  perform public.set_character_boss_plan_party_size(v_char, 'lotus_hard', 2);
  select potential_meso into v_weekly
    from public.v_weekly_plan_potential
   where user_id = v_user and cycle = 'weekly';
  if v_weekly <> v_meso / 2 then
    raise exception '2인 분할 최대치(%)가 floor(1인/2)=% 와 다릅니다.', v_weekly, v_meso / 2;
  end if;

  -- (7) 추적 해제한 캐릭터는 최대치에서 빠진다
  update public.characters set is_tracked = false where id = v_char;
  if exists (select 1 from public.v_weekly_plan_potential where user_id = v_user) then
    raise exception '추적 해제한 캐릭터의 계획이 최대치에 남아 있습니다.';
  end if;

  delete from public.app_users where id = v_user;

  raise notice '27. 주기 분리 · 이론상 최대치 자기검증 7항목 전부 통과';
end
$$;


-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
-- 새 뷰 셋 모두 `%meso%` 컬럼을 갖는다. 뷰를 재생성하면 GRANT 가 초기화되므로 위
-- 27-7 의 revoke 를 빼먹으면 정확히 여기서 터진다 — share_bp 가 샜던 그 경로다.
select public.assert_no_public_sensitive_columns();
