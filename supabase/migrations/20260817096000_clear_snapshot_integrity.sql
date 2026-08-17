-- ============================================================================
-- 20260817096000_clear_snapshot_integrity.sql
--
-- 목적 두 가지.
--
--  (1) 클리어 기록의 **스냅샷 무결성** 복구.
--      `boss_clears_apply_state()` 는 `price_snapshotted_at is null` 일 때 금액을 다시
--      찍는데, 그 블록이 `new.cycle := <보스 마스터의 현재 cycle>` 로 주기까지 **재스탬프**
--      한다. 인원 수정은 `party_size` 와 함께 `price_snapshotted_at = null` 을 넘겨 바로
--      그 블록을 태우는 방식이라, **과거 기록의 인원을 고치면 주기가 현재 값으로 덮인다.**
--
--      보스 주기는 패치로 바뀐다. 실제로 2026-06-18 패치에서 하드 힐라 · 카오스 핑크빈 ·
--      노멀 시그너스가 주간 → 일간으로 원복됐다. 그 뒤 과거 기록의 인원을 고치면 당시
--      **주간이었던 클리어가 일간으로 바뀌고**, 주당 12개 카운터 집계가 통째로 틀어진다.
--      CLAUDE.md §1 의 "클리어 시점 값을 스냅샷해 나중 패치가 과거 기록을 다시 쓰지 못하게
--      한다"를 정면으로 위반한다.
--
--      ★ 근본 원인은 **시세와 주기의 비대칭**이다.
--        - 시세는 `boss_crystal_prices(boss_difficulty_id, effective_from)` 라는 **이력 테이블**을
--          갖고, `current_crystal_price(boss, cleared_at)` 가 클리어 시각 기준으로 조회한다.
--          그래서 재조회해도 같은 행이 나온다(나중 패치는 `effective_from > cleared_at` 이라
--          애초에 선택되지 않는다). 즉 시세는 **구조적으로 이미 안전**했다.
--        - 주기는 `boss_difficulties.cycle` **단일 현재값**이고 이력이 없다. 시각 기준으로
--          조회할 방법 자체가 없다. 그래서 재조회 = 과거 덮어쓰기다.
--        보존 외에 다른 해법이 없는 이유가 이것이다.
--
--  (2) "인원 미확인" 판정을 **추론에서 저장된 사실로** 승격.
--      지금 UI 는 `source='nexon_api' and run_id is null and party_size = 1` 이라는 추론으로
--      "확인 필요"를 띄운다(`src/features/income/server/income-repo.ts`
--      `isPartySizeUnconfirmed()`). 진짜로 솔로였던 API 클리어는 사용자가 몇 번을 확인해도
--      값이 1 이라 **영원히 "확인 필요"로 남는다.** 저장할 자리가 없어서 생긴 오탐이다.
--
-- 넥슨 API 호출 없음. 시드 데이터의 값 변경 없음(새 컬럼 백필만).
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 1) `party_size_confirmed` — 인원이 "사람이 확인한 값"인가
-- ────────────────────────────────────────────────────────────────────────────
-- 넥슨 API 에는 파티 정보가 **아예 없다**(§1.1 확정). 그래서 관측만으로 만들어진 행의
-- `party_size = 1` 은 사실 주장이 아니라 그냥 DB 기본값이다. 그 구분을 값이 아니라
-- **별도 비트**로 들면, 사용자가 "맞아요 솔로였어요"라고 확인한 1 과 아무도 안 본 1 이
-- 비로소 구별된다.
--
-- 기본값이 false 인 이유(안전한 쪽이 어느 쪽인가):
--   - 거짓 "확인됨" → 경고가 안 뜬다 → 6인 보스가 조용히 6배로 잡힌다.
--   - 거짓 "미확인" → 이미 맞는 값에 확인 요청이 한 번 더 뜬다.
-- 손해가 압도적으로 비대칭이라 **모르면 미확인**이 맞다. 스케줄링에서 "거짓 available 보다
-- 거짓 unavailable 이 낫다"고 정한 것과 같은 기조다(CLAUDE.md §1.4).
-- `if not exists` — 이 저장소의 모든 마이그레이션은 재실행 안전이 불변식이다(연속 2회 적용 검증됨).
alter table public.boss_clears
  add column if not exists party_size_confirmed boolean not null default false;

comment on column public.boss_clears.party_size_confirmed is
  '이 기록의 party_size 를 사람이 확인했는가. false = 아무도 확인한 적 없음(넥슨 관측 기본값 1 일 가능성). '
  'INSERT 시 트리거가 유도하고, set_clear_party_size() 가 true 로 올린다. '
  '넥슨 API 에는 파티 정보가 없으므로(§1.1) source=nexon_api 이고 런 미연결이면 false 다.';

-- 백필 — INSERT 트리거가 쓸 규칙과 **완전히 같은 식**을 기존 행에 적용한다.
-- 규칙을 두 벌 만들지 않는 것이 요점이다. 오늘의 화면 판정(`isPartySizeUnconfirmed`)에서
-- 오탐 조항인 `party_size = 1` 만 뺀 것과 정확히 같은 식이기도 해서, 이 백필로 **기존 행의
-- 의미는 하나도 바뀌지 않는다.**
--   - 시드 12행은 전부 `source='manual'` → 전부 확인됨. 사람이 넣은 값이니 자연스럽다.
--   - 런에 걸린 행은 그 런의 입장 인원에서 왔으므로 확인된 값으로 본다.
update public.boss_clears
   set party_size_confirmed = true
 where party_size_confirmed = false          -- 재실행 시 무동작
   and (source <> 'nexon_api' or run_id is not null);


-- ────────────────────────────────────────────────────────────────────────────
-- 2) 트리거 교체 — 재스냅샷 시 **관측값은 보존하고 파생값만 다시 계산**한다
-- ────────────────────────────────────────────────────────────────────────────
-- 우회(전용 함수만 추가)가 아니라 트리거를 고치는 쪽을 골랐다. 근거:
--
--   ① `price_snapshotted_at = null` 로 재스냅샷을 유도하는 경로가 이미 **세 곳**이다
--      (`income-repo.ts` 845 / 868 / 1066행 — 단건 인원 수정, 런 전체 인원 수정,
--      런 클리어 표시 시 인원 채택). 전용 함수만 만들면 나머지 두 곳은 계속 주기를 덮는다.
--   ② 셋 다 "이미 클리어로 스냅샷된 행을 다시 계산"이라는 **같은 성격**의 UPDATE 다.
--      개별 호출자마다 조심하게 만드는 것보다 불변식을 트리거에 두는 쪽이 맞다.
--   ③ 어떤 경로도 "과거 기록의 주기를 마스터 현재값으로 되살리고 싶다"고 요구하지 않는다.
--      그런 일이 필요하다면 그건 의도적인 데이터 마이그레이션이지, 인원 수정의 부작용으로
--      일어날 일이 아니다.
--
-- 영향 범위는 `boss_clears` 에 쓰는 전 경로를 훑어 확인했다:
--   - 트리거: `boss_clears_apply_state`(BEFORE INS/UPD), `boss_clears_set_updated_at` 둘뿐.
--   - `boss_clears` 를 UPDATE 하는 함수: `recompute_run_crystal_shares()` 하나이며
--     `share_bp` / `crystal_share_meso` 만 건드리고 `price_snapshotted_at` 은 손대지 않는다
--     → 재스냅샷 블록에 들어가지 않으므로 영향 없음.
--   - `boss_clears` 를 읽는 뷰 5개(`v_character_boss_plan_status`, `v_run_crystal_settlement`,
--     `v_weekly_crystal_income_by_character`, `v_weekly_crystal_pending`,
--     `v_weekly_crystal_world_usage`)는 컬럼 정의가 그대로라 재정의 불필요.
--
-- 행동 변화는 **정확히 한 가지**다: `old.price_snapshotted_at is not null and
-- old.effective_cleared` 인 UPDATE(= 재스냅샷)에서 `cycle` 과 시세 스냅샷이 보존된다.
-- INSERT, 그리고 미클리어 → 클리어 전이는 종전과 완전히 동일하게 새로 스탬프한다.
create or replace function public.boss_clears_apply_state()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_winner   text;
  v_cycle    public.boss_cycle;
  v_price_id uuid;
  v_base     bigint;
  v_pot      bigint;
  v_bp       integer;
  v_amount   bigint;

  -- 재스냅샷 판정 + 보존할 이전 관측값.
  -- ★ INSERT 에서는 `old` 가 배정되지 않아 참조 자체가 에러다. 그리고 plpgsql 의 조건식은
  --   SQL 식으로 평가되어 `and` 의 단축 평가가 보장되지 않는다. 그래서 `old` 접근은
  --   반드시 `tg_op = 'UPDATE'` **블록 안에서만** 한다.
  v_resnap       boolean := false;
  v_old_cycle    public.boss_cycle;
  v_old_price_id uuid;
  v_old_base     bigint;
  v_old_manual   bigint;
  v_old_at       timestamptz;
begin
  -- 0) 보스 엔트리 확인 (max_party 는 소프트 상한이라 검증하지 않는다 — CLAUDE.md §1.3 D5)
  select bd.cycle into v_cycle
    from public.boss_difficulties bd
   where bd.id = new.boss_difficulty_id;

  if not found then
    raise exception '알 수 없는 보스 엔트리입니다: %', new.boss_difficulty_id
      using errcode = 'foreign_key_violation';
  end if;

  -- 0 으로 나누는 사고 방지. CHECK 는 BEFORE 트리거보다 나중에 평가되므로 여기서 먼저 막는다.
  if new.party_size is null or new.party_size < 1 then
    raise exception '파티 인원(party_size)은 1 이상이어야 합니다 (입력: %).', new.party_size
      using errcode = 'check_violation';
  end if;

  if new.world_name is null and new.character_id is not null then
    select ch.world_name into new.world_name
      from public.characters ch where ch.id = new.character_id;
  end if;

  -- 0-b) 인원 확인 비트 — INSERT 에서만 유도한다.
  --      UPDATE 에서 건드리지 않는 이유: 한번 확인된 값을 트리거가 다시 미확인으로 되돌리면
  --      사용자가 방금 한 확인이 조용히 취소된다. 이 비트를 올리는 주체는
  --      `set_clear_party_size()` 와 명시적으로 값을 넘기는 INSERT 뿐이다.
  --      명시적으로 true 를 넘긴 INSERT 는 그대로 존중한다(`or` 의 첫 항).
  if tg_op = 'INSERT' then
    new.party_size_confirmed :=
         coalesce(new.party_size_confirmed, false)
      or new.source <> 'nexon_api'   -- 사람/봇이 만든 행은 인원을 알고 만든다
      or new.run_id is not null;     -- 런에 걸렸으면 그 입장의 인원을 안다
  end if;

  -- 0-c) 이 UPDATE 가 "이미 스냅샷된 클리어의 재계산"인가.
  --      보스 엔트리가 바뀌었다면 다른 보스이므로 보존 대상이 아니다(새로 스탬프).
  if tg_op = 'UPDATE' then
    if old.price_snapshotted_at is not null
       and old.effective_cleared
       and new.boss_difficulty_id = old.boss_difficulty_id then
      v_resnap       := true;
      v_old_cycle    := old.cycle;
      v_old_price_id := old.crystal_price_id;
      v_old_base     := old.base_price_meso;
      v_old_manual   := old.manual_base_price_meso;
      v_old_at       := old.cleared_at;
    end if;
  end if;

  -- 1) 승자 판정 (관측 시각이 더 최신인 쪽. 동률이면 사람이 이긴다)
  if new.manual_cleared is null and new.api_cleared is null then
    v_winner := 'none';
  elsif new.manual_cleared is null then
    v_winner := 'api';
  elsif new.api_cleared is null then
    v_winner := 'manual';
  elsif coalesce(new.manual_set_at, '-infinity'::timestamptz)
        >= coalesce(new.api_observed_at, '-infinity'::timestamptz) then
    v_winner := 'manual';
  else
    v_winner := 'api';
  end if;

  new.effective_cleared := case v_winner
    when 'manual' then coalesce(new.manual_cleared, false)
    when 'api'    then coalesce(new.api_cleared, false)
    else false
  end;

  -- 2) 충돌 보존
  new.has_conflict := (
    new.manual_cleared is not null
    and new.api_cleared is not null
    and new.manual_cleared is distinct from new.api_cleared
  );

  -- 3) 클리어 시각 / 금액 스냅샷
  if new.effective_cleared then
    if new.cleared_at is null then
      new.cleared_at := coalesce(
        case v_winner when 'manual' then new.manual_set_at else new.api_observed_at end,
        now()
      );
    end if;

    if new.price_snapshotted_at is null then
      -- ★★ 주기는 **관측 스냅샷**이다. 절대 재조회하지 않는다. ★★
      --    `boss_difficulties.cycle` 은 이력 없는 단일 현재값이라, 여기서 다시 읽으면
      --    패치로 주기가 바뀐 뒤 과거 기록이 조용히 덮인다(2026-06-18 주간→일간 원복).
      if v_resnap then
        new.cycle := v_old_cycle;
      else
        new.cycle := v_cycle;
      end if;

      if v_resnap
         and new.manual_base_price_meso is not distinct from v_old_manual
         and new.cleared_at              is not distinct from v_old_at then
        -- 가격 입력(수동가 · 클리어 시각)이 그대로다 → 당시 시세 행을 그대로 유지한다.
        -- `current_crystal_price()` 가 시각 기준이라 재조회해도 같은 값이 나오지만,
        -- "같은 값이 나올 것"에 기대지 않고 **명시적으로 보존**한다. 시세 이력에 소급
        -- 정정 행이 들어오더라도 과거 기록이 흔들리지 않는다.
        v_price_id := v_old_price_id;
        v_base     := v_old_base;
      elsif new.manual_base_price_meso is not null then
        v_base := new.manual_base_price_meso;
        v_price_id := null;
      else
        select cp.price_id, cp.price_meso
          into v_price_id, v_base
          from public.current_crystal_price(new.boss_difficulty_id, new.cleared_at) cp;
      end if;

      new.crystal_price_id := v_price_id;
      new.base_price_meso  := v_base;

      if v_base is null then
        -- 가격 미확인. 0 으로 채우지 않는다.
        new.pot_meso           := null;
        new.share_bp           := null;
        new.crystal_share_meso := null;
      else
        -- 게임 규칙: 파티 전체가 받는 총액
        v_pot := new.party_size * (v_base / new.party_size);
        new.pot_meso := v_pot;

        -- 우리 모델: 그 총액을 파티원끼리 어떻게 나눴는가
        select p.share_bp, p.amount
          into v_bp, v_amount
          from public.resolve_crystal_payout(new.run_id, new.user_id, v_pot, new.party_size) p;

        new.share_bp           := v_bp;
        new.crystal_share_meso := v_amount;
      end if;

      new.price_snapshotted_at := now();
    end if;
  else
    new.cleared_at           := null;
    new.crystal_price_id     := null;
    new.base_price_meso      := null;
    new.pot_meso             := null;
    new.share_bp             := null;
    new.crystal_share_meso   := null;
    new.price_snapshotted_at := null;
    -- 클리어가 아닌 행은 지킬 스냅샷이 없다. 다시 켤 때 그 시점 주기로 새로 찍힌다.
    new.cycle                := v_cycle;
  end if;

  -- 4) 주차 버킷
  if new.cleared_at is not null then
    new.week_key := public.week_key(new.cleared_at);
  else
    new.week_key := coalesce(
      nullif(new.week_key, ''),
      public.week_key(coalesce(new.created_at, now()))
    );
  end if;

  return new;
end;
$function$;

comment on function public.boss_clears_apply_state() is
  'boss_clears BEFORE INSERT/UPDATE — 승자 판정 · 충돌 플래그 · 금액 스냅샷 · 주차 버킷을 한 패스에서 처리. '
  '이미 스냅샷된 클리어를 다시 계산할 때(price_snapshotted_at 을 null 로 넘기는 재스냅샷) '
  'cycle 과 시세 스냅샷은 보존하고 pot/share 만 다시 만든다 — 보스 주기는 패치로 바뀌는데 '
  'boss_difficulties.cycle 에는 이력이 없어 재조회가 곧 과거 덮어쓰기이기 때문이다(CLAUDE.md §1).';


-- ────────────────────────────────────────────────────────────────────────────
-- 3) `set_clear_party_size()` — 인원 수정의 정식 입구
-- ────────────────────────────────────────────────────────────────────────────
-- §1.3 D3: "party_size 는 실제로 몇 명이 입장했는가이며 사용자가 고칠 수 있어야 한다."
--
-- 금액(`pot_meso` · `share_bp` · `crystal_share_meso`)은 다시 계산하고,
-- `cycle` 과 `crystal_price_id`(당시 시세)는 건드리지 않는다. 후자는 위 트리거가 보장하므로
-- 이 함수는 공식을 한 줄도 갖지 않는다 — pot 계산식이 DB 안에서도 두 벌이 되지 않게 한다.
--
-- `price_snapshotted_at` 은 **재계산 시각으로 갱신한다**(트리거가 `now()` 로 찍는다). 근거:
--   - 이 컬럼의 역할은 "이 행의 금액은 확정되었다"는 **완료 표식**이다(가격이 정당히 null 일
--     수 있어 금액 컬럼의 null 여부로는 판정할 수 없어서 따로 둔 것). 금액을 다시 확정했으면
--     표식도 그때를 가리키는 것이 맞다.
--   - "어느 시세 행을 썼는가"라는 **출처**는 `crystal_price_id` / `base_price_meso` 가 따로
--     들고 있고 그쪽은 보존된다. 그래서 이 타임스탬프를 옮겨도 감사 정보가 사라지지 않는다.
--
-- ⚠️ 소유권 검사는 하지 않는다. service_role 전용이고, 호출자(Route Handler)가 세션의
--    user_id 로 대상 기록을 먼저 확인한다. `recompute_run_crystal_shares()` 와 같은 규약이다.
create or replace function public.set_clear_party_size(
  p_clear_id   uuid,
  p_party_size integer
)
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
         price_snapshotted_at = null
   where run_id = v_run_id;

  -- 분배 몫이 새 pot 과 맞는지 DB 가 마무리한다. 트리거가 이미 맞춰 뒀다면 0건이다.
  perform public.recompute_run_crystal_shares(v_run_id);
end;
$function$;

comment on function public.set_clear_party_size(uuid, integer) is
  '클리어 기록의 party_size 를 고치고 금액을 다시 계산한다(§1.3 D3). '
  'cycle 과 crystal_price_id 는 클리어 시점 스냅샷이라 보존된다. party_size_confirmed 를 true 로 올린다. '
  '런에 걸린 기록이면 party_runs.entry_party_size 와 그 런의 모든 클리어를 함께 고친다. '
  '소유권 검사는 호출자 책임(service_role 전용).';

-- 권한 — 기존 정산 계열 함수와 동일하게 service_role 전용.
-- anon/authenticated 가 남의 클리어 금액을 다시 쓰게 둘 수 없다.
revoke all on function public.set_clear_party_size(uuid, integer) from public;
revoke all on function public.set_clear_party_size(uuid, integer) from anon;
revoke all on function public.set_clear_party_size(uuid, integer) from authenticated;
grant execute on function public.set_clear_party_size(uuid, integer) to service_role;


-- ────────────────────────────────────────────────────────────────────────────
-- 4) 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- ────────────────────────────────────────────────────────────────────────────
-- `boss_clears` 에는 anon/authenticated GRANT 자체가 없어 새 컬럼이 노출될 경로가 없다.
-- 그래도 호출은 생략하지 않는다 — 생략이 바로 share_bp 가 한번 샜던 경로다.
select public.assert_no_public_sensitive_columns();
