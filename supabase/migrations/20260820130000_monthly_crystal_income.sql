-- =============================================================================
-- 월간 보스 수익을 **달 단위로** 집계한다
-- =============================================================================
--
-- 발주자(2026-08-20): *"이거 월간은 그래도 월간으로 조회해야지. 저번주에 월간 잡은걸
-- 안보여주면 어떡함"*
--
-- 수익 요약의 모든 숫자가 `v_weekly_income`(주차 버킷)에서 나왔다. 그래서 8/17(W33)에 잡은
-- 검은 마법사가 목요일 리셋을 넘기는 순간 화면에서 **0 이 됐다.** 인게임 월간 초기화는
-- 달력 1일이므로 그건 사실과 다르다 — 그 달 안에서는 계속 "잡았다"가 맞다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- 주간 집계를 고치지 않고 **옆에 하나 더 만든다**
-- ─────────────────────────────────────────────────────────────────────────────
-- `v_weekly_income` 은 원장의 주차 진실이고, 12개 상한·드랍·총액이 전부 그 위에 얹혀 있다.
-- 거기에 달 개념을 섞으면 "이번 주 총 수익"이 무엇인지가 무너진다. 그래서 **월간 보스만**
-- 달 단위로 세는 뷰를 따로 두고, 화면이 두 값을 각자의 이름으로 그린다.
--
-- ★ 12개 절삭이 없다. 그 상한은 **주간 보스 전용**이며(§1) 월간은 애초에 칸을 쓰지 않는다.
--   그래서 이 뷰는 `crystal_share_meso` 를 그대로 더한다.
-- ★ `month_key` 는 **KST 달력 달**이다(`kst_date`). 인게임 월간 초기화가 달력 1일이므로
--   그 경계가 맞고, UTC 로 자르면 매달 1일 오전 9시 이전이 지난달로 샌다.
-- ⚠️ 금액 컬럼이라 **anon/authenticated 에 열지 않는다.** `%meso%` 는
--    `assert_no_public_sensitive_columns()` 가 감시하는 이름이며, 뷰라고 예외가 아니다.

create or replace view public.v_monthly_crystal_income
with (security_invoker = true) as
select
  bc.user_id,
  to_char(date_trunc('month', public.kst_date(bc.cleared_at)), 'YYYY-MM') as month_key,
  count(*)::bigint                                               as clear_count,
  count(*) filter (where bc.crystal_share_meso is null)::bigint   as unknown_price_count,
  -- 가격 미확인은 **0 이 아니라 모름**이라 합계에서 빠지고 위 건수로만 센다 (§1.3 D4).
  coalesce(sum(bc.crystal_share_meso), 0)::bigint                 as income_meso
from public.boss_clears bc
join public.boss_difficulties bd on bd.id = bc.boss_difficulty_id
where bc.effective_cleared
  and bc.cleared_at is not null
  and bd.cycle = 'monthly'::public.boss_cycle
group by bc.user_id, to_char(date_trunc('month', public.kst_date(bc.cleared_at)), 'YYYY-MM');

comment on view public.v_monthly_crystal_income is
  '사용자 × KST 달력 달의 월간 보스 결정석 수익. 주차 버킷(v_weekly_income)과 별개이며 12개 절삭이 없다(월간은 주간 칸을 쓰지 않는다).';

revoke all on table public.v_monthly_crystal_income from anon, authenticated;
grant all  on table public.v_monthly_crystal_income to service_role;

-- -----------------------------------------------------------------------------
-- 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_month      text := to_char(date_trunc('month', public.kst_date(now())), 'YYYY-MM');
  v_view_count bigint;
  v_raw_count  bigint;
begin
  select coalesce(sum(clear_count), 0) into v_view_count
    from public.v_monthly_crystal_income where month_key = v_month;

  select count(*) into v_raw_count
    from public.boss_clears bc
    join public.boss_difficulties bd on bd.id = bc.boss_difficulty_id
   where bc.effective_cleared
     and bd.cycle = 'monthly'::public.boss_cycle
     and date_trunc('month', public.kst_date(bc.cleared_at))
         = date_trunc('month', public.kst_date(now()));

  if v_view_count <> v_raw_count then
    raise exception '32: 뷰가 %건인데 원장은 %건입니다.', v_view_count, v_raw_count;
  end if;

  -- 주차 경계를 넘어도 같은 달이면 함께 세어야 한다 — 이 마이그레이션의 존재 이유다.
  if exists (
    select 1
      from public.boss_clears bc
      join public.boss_difficulties bd on bd.id = bc.boss_difficulty_id
     where bc.effective_cleared
       and bd.cycle = 'monthly'::public.boss_cycle
       and bc.week_key <> public.week_key(now())
       and date_trunc('month', public.kst_date(bc.cleared_at))
           = date_trunc('month', public.kst_date(now()))
       and not exists (
         select 1 from public.v_monthly_crystal_income v
          where v.user_id = bc.user_id and v.month_key = v_month
       )
  ) then
    raise exception '32: 지난 주차의 이번 달 월간 클리어가 집계에서 빠졌습니다.';
  end if;
end
$$;

select public.assert_no_public_sensitive_columns();
