-- ═══════════════════════════════════════════════════════════════════════════════
-- M_Schedule · 계획 인원수를 고치면 **그 주 클리어도 따라온다**
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 발주 지시(2026-08-25): *"실제 클리어를 니가어떻게 알아; 캐릭별 보스관리 여기서 확인해야지"*
-- → C안(현재 값 정정 + 재발 방지) 채택.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 증상: 실제 수익이 "이론상 최대치"를 넘어섰다
-- ───────────────────────────────────────────────────────────────────────────────
-- `!결정석` 이 `주간 369억 / 최대 354억` 을 냈다. 실제가 최대를 넘는 것은 정의상 불가능하다.
--
-- 원인은 **같은 인원수를 두 곳이 서로 다른 시점에 읽는다**는 것이었다.
--   · 최대치(`v_weekly_plan_potential`) → `character_boss_plans.default_party_size` 를 **지금** 읽는다.
--   · 실제(`boss_clears.crystal_share_meso`) → 클리어를 **만들 때** 복사해 둔 `party_size` 로 굳는다.
-- 그래서 계획을 나중에 고치면 최대치만 움직이고 이미 박힌 클리어는 옛 값에 남는다.
-- 실측(2026-08-25): 킴잔섀도어의 계획을 1인 → 2인으로 고쳤는데 8/24 에 만들어진 클리어 4건은
-- 1인 그대로였고, 그 4건이 최대치보다 33억 더 큰 값을 내고 있었다.
--
-- ⚠️ 넥슨은 **인원수를 알려주지 않는다.** 그러므로 `party_size = 1` 은 관측이 아니라 기본값이며,
--    이 값의 출처는 오직 사람이 적어 둔 계획(캐릭별 보스 관리)뿐이다. 발주자 지적의 요지다.
--
-- ───────────────────────────────────────────────────────────────────────────────
-- 왜 `party_size_confirmed` 로는 못 가르는가 → 새 칸이 필요하다
-- ───────────────────────────────────────────────────────────────────────────────
-- R5-A(2026-08-19, *"그냥 1인을 기본으로 잡아"*) 이후 동기화가 만든 클리어는 **전부**
-- `party_size_confirmed = true` 다. 수익 화면의 "확인 필요" 배지를 없애려던 결정이었고 그건
-- 그대로 옳다. 다만 그 결과 **"사람이 확인한 2인"과 "기본값이 들어간 1인"이 같은 표시**가 됐다.
-- `updated_at` 도 못 쓴다 — 가격 재스냅샷 트리거가 매번 건드려서 실측 17건이 전부
-- `updated_at > created_at` 이었다.
--
-- 그래서 **사람이 직접 정했는가**만 담는 칸을 따로 둔다. 기존 열의 뜻을 바꾸지 않는다.

alter table public.boss_clears
  add column if not exists party_size_manual boolean not null default false;

comment on column public.boss_clears.party_size_manual is
  '사람이 이 기록의 인원수를 직접 정했는가. true 면 계획 변경이 덮지 않는다. '
  '`party_size_confirmed` 와 다르다 — 그쪽은 동기화가 만든 행에도 true 로 붙는다(R5-A).';

-- ── 1. 사람이 고치는 경로에는 표시를 남긴다 ──────────────────────────────────
-- 기존 동작은 그대로다. `party_size_manual := true` 한 줄만 더한다.
create or replace function public.set_clear_party_size(p_clear_id uuid, p_party_size integer)
returns void
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_run_id uuid;
begin
  -- `boss_clears_party_size_check` 와 같은 범위. max_party 는 막지 않는다(§1.3 D5) —
  -- 대부분 세대 규칙에서 유도된 값이라 실제 파티를 거부하면 사용자가 앱을 못 쓴다.
  if p_party_size is null or p_party_size < 1 or p_party_size > 24 then
    raise exception '파티 인원은 1명 이상 24명 이하여야 합니다 (입력: %).', p_party_size
      using errcode = 'check_violation';
  end if;

  select bc.run_id into v_run_id
    from public.boss_clears bc
   where bc.id = p_clear_id
   for update;

  if not found then
    raise exception '클리어 기록을 찾을 수 없습니다: %', p_clear_id
      using errcode = 'no_data_found';
  end if;

  -- 값이 이미 같아도 그냥 지나치지 않는다. "인원이 2명 맞다"는 **확인 행위 자체가 결과**이고,
  -- 그래야 party_size_confirmed 가 올라간다. 재계산은 멱등이라 손해가 없다.
  if v_run_id is null then
    update public.boss_clears
       set party_size           = p_party_size,
           party_size_confirmed = true,
           -- ★ 여기서부터는 계획이 바뀌어도 이 값을 지킨다.
           party_size_manual    = true,
           price_snapshotted_at = null   -- 트리거 재계산 유도(주기·시세는 트리거가 보존)
     where id = p_clear_id;
    return;
  end if;

  -- 런에 걸린 기록은 **그 런 전체를 함께 고친다.**
  -- "몇 명이 입장했는가"는 개인이 아니라 그 입장 자체의 사실이다. 내 행만 고치면 같은 런의
  -- 참가자들이 서로 다른 pot 을 갖게 되고 `v_run_crystal_settlement`(합계 = pot 검증)이 깨진다.
  update public.party_runs
     set entry_party_size = p_party_size
   where id = v_run_id;

  update public.boss_clears
     set party_size           = p_party_size,
         party_size_confirmed = true,
         party_size_manual    = true,
         price_snapshotted_at = null
   where run_id = v_run_id;

  -- 분배 몫이 새 pot 과 맞는지 DB 가 마무리한다. 트리거가 이미 맞춰 뒀다면 0건이다.
  perform public.recompute_run_crystal_shares(v_run_id);
end;
$function$;

-- ── 2. 계획을 고치면 **이번 주** 클리어가 따라온다 ───────────────────────────
create or replace function public.set_character_boss_plan_party_size(
  p_character_id uuid,
  p_boss_difficulty_id text,
  p_party_size integer
)
returns uuid
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_id   uuid;
  v_size integer;
begin
  v_size := coalesce(p_party_size, 1);

  if v_size < 1 or v_size > 24 then
    raise exception '파티 인원은 1명 이상 24명 이하여야 합니다 (입력: %).', p_party_size
      using errcode = 'check_violation';
  end if;

  update public.character_boss_plans
     set default_party_size = v_size
   where character_id       = p_character_id
     and boss_difficulty_id = p_boss_difficulty_id
  returning id into v_id;

  if v_id is null then
    raise exception '계획에 없는 보스입니다: % (캐릭터 %). 먼저 목록에 추가해 주세요.',
      p_boss_difficulty_id, p_character_id
      using errcode = 'no_data_found';
  end if;

  /*
    ═════════════════════════════════════════════════════════════════════════════
    계획이 곧 인원수의 출처다 — 그러니 **이미 박힌 이번 주 기록도 따라와야 한다**
    ═════════════════════════════════════════════════════════════════════════════
    범위를 좁게 잡는 세 조건에 각각 이유가 있다.

    · `week_key = 이번 주`  — 지난 주 기록은 **그때의 사실**이다. 오늘 계획을 바꿨다고
      지난 주 수익이 움직이면 원장이 원장이 아니게 된다.
    · `run_id is null`      — 런에 걸린 기록의 인원수는 그 **입장의 사실**이고 `going` 신청
      수에서 나온다. 계획은 그보다 약한 근거라 덮으면 안 된다(§1.3 D3).
    · `not party_size_manual` — 사람이 직접 정한 값은 계획보다 세다. 방금 손으로 3인이라고
      적었는데 계획 저장이 그것을 1인으로 되돌리면 고친 것이 고쳐 보이지 않는다.

    `price_snapshotted_at := null` 로 트리거 재계산을 유도한다. 금액·pot·분배는 전부
    `boss_clears_apply_state()` 가 다시 낸다 — 여기서 메소를 직접 계산하지 않는다.
  */
  update public.boss_clears bc
     set party_size           = v_size,
         price_snapshotted_at = null
   where bc.character_id       = p_character_id
     and bc.boss_difficulty_id = p_boss_difficulty_id
     and bc.week_key           = public.week_key(now())
     and bc.run_id is null
     and not bc.party_size_manual
     and bc.party_size is distinct from v_size;

  return v_id;
end;
$function$;

-- ── 3. 이미 어긋난 이번 주 기록을 계획에 맞춘다 (B안) ────────────────────────
-- 위 함수와 **같은 조건**이다. 조건이 갈라지면 한 번 맞춰 놓고 다음에 또 어긋난다.
do $$
declare
  v_fixed integer;
begin
  update public.boss_clears bc
     set party_size           = p.default_party_size,
         price_snapshotted_at = null
    from public.character_boss_plans p
   where p.character_id       = bc.character_id
     and p.boss_difficulty_id = bc.boss_difficulty_id
     and p.is_active
     and bc.week_key = public.week_key(now())
     and bc.run_id is null
     and not bc.party_size_manual
     and bc.party_size is distinct from p.default_party_size;

  get diagnostics v_fixed = row_count;
  raise notice '계획에 맞춰 정정한 이번 주 클리어: %건', v_fixed;
end $$;

-- ── 자기 검증 ─────────────────────────────────────────────────────────────────
do $$
declare
  v_left integer;
  v_over integer;
begin
  select count(*) into v_left
    from public.boss_clears bc
    join public.character_boss_plans p
      on p.character_id = bc.character_id
     and p.boss_difficulty_id = bc.boss_difficulty_id
     and p.is_active
   where bc.week_key = public.week_key(now())
     and bc.run_id is null
     and not bc.party_size_manual
     and bc.party_size is distinct from p.default_party_size;

  if v_left > 0 then
    raise exception '계획과 어긋난 이번 주 클리어가 %건 남았습니다.', v_left;
  end if;

  -- 실제가 최대치를 넘는 사용자가 남아 있으면 안 된다(이 마이그레이션의 존재 이유).
  select count(*) into v_over
    from (
      select bc.user_id,
             sum(bc.crystal_share_meso) as actual
        from public.boss_clears bc
       where bc.week_key = public.week_key(now())
         and bc.effective_cleared
         and bc.cycle = 'weekly'
       group by bc.user_id
    ) a
    join public.v_weekly_plan_potential p
      on p.user_id = a.user_id and p.cycle = 'weekly'
   where a.actual > p.potential_meso;

  if v_over > 0 then
    -- 막지는 않는다. 계획에 **없는** 보스를 잡은 경우는 이 마이그레이션의 범위 밖이고
    -- (최대치 계산이 계획 밖 클리어를 세지 않는 별개 결함), 그건 다음 작업에서 다룬다.
    raise notice '주의: 실제 > 최대치인 사용자가 아직 %명 있습니다(계획 밖 보스 클리어 건).', v_over;
  end if;

  raise notice '계획 인원수 → 이번 주 클리어 연동 완료';
end $$;

select public.assert_no_public_sensitive_columns();
