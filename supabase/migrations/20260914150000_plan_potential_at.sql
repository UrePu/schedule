-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · `plan_potential_at(user, at)` — **시각을 인자로 받는** 최대치
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-09-14): 카톡 봇 `!결정패치` — *"!결정석이랑 비슷한거임. 그냥 전체
-- 얼마 -> 얼마로 패치된건지 주간 월간 둘다 내꺼 보여주면됨."*
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 뷰로는 못 하는가 — `now()` 가 뷰 본문에 박혀 있다
-- ───────────────────────────────────────────────────────────────────────────────
-- `v_weekly_plan_potential_by_character` 는 가격을 `current_crystal_price(bd.id, now())`
-- 로 집는다. 즉 **"지금 시세의 최대치"** 하나만 낼 수 있고, `boss_crystal_prices` 에
-- 이미 들어와 있는 **미래 효력 행**(2026-09-17 10:00 주간 22종 · 2026-10-01 00:00
-- 검은 마법사 2종, 마이그레이션 `20260914140000`)은 영원히 보이지 않는다.
-- "패치되면 얼마가 되나"는 그래서 뷰로 답할 수 없다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 TypeScript 로 다시 계산하지 않는가 (§1.1.1 · `20260914130000` 머리말)
-- ───────────────────────────────────────────────────────────────────────────────
-- 최대치 산수는 **DB 가 소유한다.** 12칸 랭킹(가격 내림차순 상위 12) · 시즌→주간 접기 ·
-- `is_tracked AND missing_since IS NULL` 모집단 — 이 셋이 한 벌 더 생기면 웹 카드와
-- 방 답장이 서로 다른 금액을 말하기 시작한다. 그래서 **뷰 본문을 그대로 옮기고 `now()`
-- 자리만 `p_at` 으로 바꾼 함수**를 둔다. 로직의 출처는 여전히 한 곳이다.
--
-- ⚠️ 뷰는 **건드리지 않는다.** 소비처가 셋(`income/server/crystal-summary.ts` ·
--    `dashboard/server/dashboard-repo.ts` · `bot/server/bot-repo.ts`)이고 전부 "지금"만
--    묻는다. 뷰를 함수 호출로 바꾸면 세 화면이 한꺼번에 위험해지는데 얻는 것이 없다.
--    ⇒ **이 함수의 유일한 호출자는 `!결정패치` 다.** 아래 자기검증이 두 경로가 같은
--    시각에서 같은 값을 낸다는 것을 못박으므로, 갈라지면 그때 바로 터진다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 사용자 × 주기로 **접어서** 돌려준다 (캐릭터별이 아니다)
-- ───────────────────────────────────────────────────────────────────────────────
-- `!결정패치` 의 답장은 주간 한 줄 · 월간 한 줄이다. 캐릭터별 행을 돌려주면 호출부가
-- 다시 합산해야 하고, 그 합산이 곧 `v_weekly_plan_potential` 의 복제본이 된다.
-- 형제 뷰가 `sum(...)` 으로 접는 것과 **같은 결과**임을 자기검증이 전 사용자 대조로 확인한다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 규약 — 이 저장소의 기존 함수를 따랐다
-- ───────────────────────────────────────────────────────────────────────────────
-- · `security definer` 를 **쓰지 않는다.** `current_crystal_price` · `weekly_crystal_sell_limit`
--   과 같은 순수 조회 함수이고, 호출자는 service_role 하나뿐이라 권한을 올릴 이유가 없다.
--   definer 로 두면 RLS 를 우회하는 조회 창구가 하나 더 생길 뿐이다.
-- · `stable` · `parallel safe` — 읽기 전용이며 같은 인자면 같은 답이다(`current_crystal_price`
--   와 같은 표기).
-- · `set search_path to 'public', 'pg_temp'` — 함수에 search_path 를 고정하는 것이
--   `sync_character_boss_plans` 이후 이 저장소의 표준이다(Supabase 린트도 같은 요구).
-- · GRANT 는 `set_run_shares` · `claim_guest_profile` 과 같은 모양 —
--   public/anon/authenticated 에서 전부 회수하고 service_role 에만 execute.
--   돌려주는 것이 `%meso%` 값이므로 이건 선택이 아니다.
--
-- ⚠️ 본문에서 컬럼을 **전부 테이블 별칭으로 한정**한다. `returns table (...)` 의 출력
--    이름(`cycle` 등)은 함수 안에서 파라미터처럼 보이므로, 한정하지 않은 `cycle` 한 글자가
--    나중에 모호성 오류로 터진다. `raw_cycle` / `fold_cycle` 로 이름을 갈라 둔 것도 같은 이유다.
-- ═══════════════════════════════════════════════════════════════════════════════

create or replace function public.plan_potential_at(
  p_user_id uuid,
  p_at      timestamptz default now()
)
returns table (
  cycle          boss_cycle,
  potential_meso bigint,
  planned_count  bigint
)
language sql
stable
parallel safe
set search_path to 'public', 'pg_temp'
as $func$
  with planned as (
    select
      p.character_id,
      -- 랭킹은 **접기 전** 주기로 나눈다. 시즌 보스(메이린)는 12칸을 먹지 않으므로
      -- 주간과 같은 파티션에 넣으면 12위 밖으로 밀려 사라진다(§1 · `20260826120000`).
      bd.cycle                                                        as raw_cycle,
      case when bd.cycle = 'season'::boss_cycle then 'weekly'::boss_cycle
           else bd.cycle end                                          as fold_cycle,
      p.boss_difficulty_id,
      (bd.cycle = 'weekly'::boss_cycle and bd.counts_toward_weekly_limit) as counts_limit,
      -- 미확인 가격은 **0 이 아니라 null** 이다(§1.3 D4). 합계에서 빠진다.
      case when cp.price_meso is null then null::bigint
           else cp.price_meso / p.default_party_size end              as share_meso
    from public.character_boss_plans p
    -- 모집단은 뷰와 **글자 그대로 같다**: 추적 중이고 넥슨 목록에 살아 있는 캐릭터.
    join public.characters ch
      on ch.id = p.character_id
     and ch.is_tracked
     and ch.missing_since is null
    join public.boss_difficulties bd on bd.id = p.boss_difficulty_id
    -- ★ 여기가 뷰와 다른 **유일한** 지점이다: `now()` → `p_at`.
    left join lateral public.current_crystal_price(bd.id, p_at) cp(price_id, price_meso)
      on true
    where p.is_active
      and bd.cycle <> 'daily'::boss_cycle
      and p.user_id = p_user_id
  ),
  ranked as (
    select
      pl.character_id,
      pl.raw_cycle,
      pl.fold_cycle,
      pl.counts_limit,
      pl.share_meso,
      row_number() over (
        partition by pl.character_id, pl.raw_cycle, pl.counts_limit
        order by pl.share_meso desc nulls last, pl.boss_difficulty_id
      ) as cycle_rank
    from planned pl
  )
  select
    r.fold_cycle,
    coalesce(
      sum(r.share_meso) filter (
        where not r.counts_limit or r.cycle_rank <= public.weekly_crystal_sell_limit()
      ),
      0::numeric
    )::bigint,
    count(*)::bigint
  from ranked r
  group by r.fold_cycle;
$func$;

comment on function public.plan_potential_at(uuid, timestamptz) is
  '사용자 × 주기 이론상 최대 결정석 수익을 **임의 시각의 시세**로 낸다. v_weekly_plan_potential 과 같은 산수이며 now() 자리만 p_at 이다 — 미래 효력 가격(boss_crystal_prices.effective_from)이 반영되므로 "패치되면 얼마가 되나"를 답할 수 있다. 봇 !결정패치 전용.';

-- -----------------------------------------------------------------------------
-- 권한 — 금액을 돌려주므로 service_role 밖으로 나가면 안 된다
-- -----------------------------------------------------------------------------
revoke all on function public.plan_potential_at(uuid, timestamptz) from public;
revoke all on function public.plan_potential_at(uuid, timestamptz) from anon;
revoke all on function public.plan_potential_at(uuid, timestamptz) from authenticated;
grant execute on function public.plan_potential_at(uuid, timestamptz) to service_role;


-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare
  v_mismatch integer;
  v_rows     integer;
begin
  -- 1. ★ 본론. `p_at = now()` 이면 함수와 뷰가 **전 사용자에서 한 건도 다르지 않아야**
  --    한다. 이 검사가 곧 "산수를 두 벌로 만들지 않았다"는 증명이다. full outer join
  --    이라 한쪽에만 있는 (사용자, 주기) 조합도 불일치로 잡힌다.
  select count(*) into v_mismatch
    from (
      select f.potential_meso as fp, v.potential_meso as vp,
             f.planned_count  as fc, v.planned_count  as vc
        from public.app_users u
        cross join lateral public.plan_potential_at(u.id, now()) f
        full outer join public.v_weekly_plan_potential v
          on v.user_id = u.id and v.cycle = f.cycle
    ) t
   where t.fp is distinct from t.vp
      or t.fc is distinct from t.vc;
  if v_mismatch > 0 then
    raise exception
      'plan_potential_at(now()) 이 v_weekly_plan_potential 과 %건 어긋납니다 — 웹과 봇이 다른 금액을 말하게 됩니다.',
      v_mismatch;
  end if;

  -- 뷰에만 있고 함수에는 없는 행도 잡는다(위 lateral 은 app_users 를 돌므로 삭제된
  -- 사용자의 계획이 뷰에 남아 있으면 여기서 드러난다).
  select count(*) into v_mismatch
    from public.v_weekly_plan_potential v
   where not exists (
     select 1 from public.plan_potential_at(v.user_id, now()) f where f.cycle = v.cycle
   );
  if v_mismatch > 0 then
    raise exception '뷰에는 있는데 함수가 내지 않는 (사용자, 주기) 조합이 %건 있습니다.', v_mismatch;
  end if;

  -- 2. 시즌 버킷은 접혀 있어야 한다 — 뷰가 지키는 불변식을 함수도 지킨다.
  select count(*) into v_rows
    from public.app_users u
    cross join lateral public.plan_potential_at(u.id, now()) f
   where f.cycle = 'season'::boss_cycle;
  if v_rows > 0 then
    raise exception 'plan_potential_at 결과에 season 버킷이 남아 있습니다 — 주간에 접히지 않았습니다.';
  end if;

  -- 3. 일간은 애초에 범위 밖이다(발주자 결정 2026-08-18).
  select count(*) into v_rows
    from public.app_users u
    cross join lateral public.plan_potential_at(u.id, now()) f
   where f.cycle = 'daily'::boss_cycle;
  if v_rows > 0 then
    raise exception 'plan_potential_at 결과에 daily 버킷이 있습니다 — 12칸/90개 집계가 어긋납니다.';
  end if;

  -- 4. ★ 미래 시세가 실제로 **다른 답**을 내는가. 이게 안 되면 함수를 만든 이유가 없다.
  --    예정 변경이 하나라도 있는 동안에만 뜻이 있는 검사라, 없으면 조용히 건너뛴다
  --    (패치가 전부 발효된 뒤에 이 파일을 다시 돌려도 실패하지 않아야 한다).
  if exists (select 1 from public.boss_crystal_prices where effective_from > now()) then
    select count(*) into v_rows
      from (
        select u.id as user_id from public.app_users u
      ) a
      cross join lateral (
        select f.cycle, f.potential_meso from public.plan_potential_at(a.user_id, now()) f
      ) cur
      join lateral (
        select g.cycle, g.potential_meso
          from public.plan_potential_at(
                 a.user_id,
                 (select max(effective_from) from public.boss_crystal_prices where effective_from > now())
               ) g
      ) fut on fut.cycle = cur.cycle
     where fut.potential_meso is distinct from cur.potential_meso;
    if v_rows = 0 then
      raise exception
        '예정된 시세 변경이 있는데 패치 후 최대치가 한 건도 달라지지 않았습니다 — p_at 이 가격 조회에 닿지 않고 있습니다.';
    end if;
    raise notice '패치 후 최대치가 달라지는 (사용자, 주기) 조합 %건을 확인했다', v_rows;
  else
    raise notice '예정된 시세 변경이 없어 미래 시각 검사는 건너뛴다';
  end if;

  raise notice 'plan_potential_at 이 뷰와 같은 값을 낸다 — 최대치 산수는 여전히 한 곳이 소유한다';
end $$;

-- ⚠️ 모든 마이그레이션의 마지막 줄 (CLAUDE.md §0.3). 이 파일은 컬럼을 추가하지 않지만,
--    규칙에 예외를 한 번 두면 다음 사람이 그 예외를 근거로 삼는다.
select public.assert_no_public_sensitive_columns();
