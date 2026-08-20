-- =============================================================================
-- 벨로나 결정석 가격 확정 — §1.3 D4 가 닫힌다
-- =============================================================================
--
-- 발주자(2026-08-20): *"벨로나 결정 가져왔어 위에부터 하드 노말 이지 순임"*
--   하드 2,950,000,000 · 노말 850,000,000 · 이지 440,000,000
--
-- 시드(마이그레이션 17-3)는 벨로나 3종을 **가격 null(미확인)** 로 넣어 두었다. 이유가
-- 난이도마다 달랐다:
--   · 이지·하드 — 출처가 하나뿐이라 확정 불가
--   · 노멀     — 850,000,000 vs 890,000,000 **출처 충돌**
-- 이제 발주자가 인게임에서 직접 확인한 값이 왔고, 노멀은 **850,000,000 쪽으로 확정**된다.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- null 행을 고치지 않고 **새 행을 얹는다**
-- ─────────────────────────────────────────────────────────────────────────────
-- `boss_crystal_prices` 는 `effective_from` 으로 이력을 갖는 표이고,
-- `current_crystal_price(보스, 시각)` 이 그 시각에 유효한 행을 고른다. 옛 행을 UPDATE 하면
-- **"출시 전에는 몰랐다"는 사실 자체가 지워지고**, 그 시절에 찍힌 스냅샷을 나중에 설명할 수
-- 없게 된다(R3 — 과거 기록을 소급해 바꾸지 않는다).
--
-- 효력 시작은 **출시일 2026-08-20 00:00 KST** 다. 그 전에는 입장 자체가 불가능했으므로
-- 이 경계 이전의 클리어는 존재할 수 없고, 존재하더라도 예전처럼 "미확인" 으로 남는다.
--
-- ⚠️ `released` 플래그는 **건드리지 않는다.** 가격을 알게 된 것과 라이브 출시 여부는 다른
--    사실이고, 화면은 미출시 배지만 그릴 뿐 등록을 막지 않는다(`boss-master/index.ts`).
--    출시 확정은 별도 지시로 처리한다.
-- ⚠️ 이 표에 DML 을 거는 마이그레이션은 **생성기 매니페스트에 등록해야 한다.**
--    `scripts/gen-boss-master/lib/parse.ts` 의 `MANIFEST_FILES` 에 이 파일을 넣고
--    `pnpm boss-master` 로 상수를 다시 만들었다 — 그러지 않으면 DB 와 코드 상수가 조용히
--    갈라지고, `prebuild` 의 `boss-master:check` 가 그것을 빌드 실패로 잡는다.

insert into public.boss_crystal_prices (boss_difficulty_id, price_meso, effective_from, patch_label, note)
values
  ('bellona_hard',   2950000000, timestamptz '2026-08-20 00:00+09', '벨로나 출시 (2026-08-20)', '발주자 인게임 확인 2026-08-20'),
  ('bellona_normal',  850000000, timestamptz '2026-08-20 00:00+09', '벨로나 출시 (2026-08-20)', '발주자 인게임 확인 2026-08-20 — 시드의 850,000,000 vs 890,000,000 충돌을 850,000,000 으로 확정'),
  ('bellona_easy',    440000000, timestamptz '2026-08-20 00:00+09', '벨로나 출시 (2026-08-20)', '발주자 인게임 확인 2026-08-20');

-- -----------------------------------------------------------------------------
-- 자기검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_hard   bigint;
  v_normal bigint;
  v_easy   bigint;
  v_before bigint;
begin
  select price_meso into v_hard
    from public.current_crystal_price('bellona_hard',   timestamptz '2026-08-20 12:00+09');
  select price_meso into v_normal
    from public.current_crystal_price('bellona_normal', timestamptz '2026-08-20 12:00+09');
  select price_meso into v_easy
    from public.current_crystal_price('bellona_easy',   timestamptz '2026-08-20 12:00+09');

  if v_hard is distinct from 2950000000 then
    raise exception '31: 하드 벨로나 가격이 % 입니다.', v_hard;
  end if;
  if v_normal is distinct from 850000000 then
    raise exception '31: 노말 벨로나 가격이 % 입니다.', v_normal;
  end if;
  if v_easy is distinct from 440000000 then
    raise exception '31: 이지 벨로나 가격이 % 입니다.', v_easy;
  end if;

  -- ★ **출시 전은 여전히 미확인이어야 한다.** 새 행이 과거까지 소급하면 R3 위반이다.
  select price_meso into v_before
    from public.current_crystal_price('bellona_hard', timestamptz '2026-08-01 12:00+09');
  if v_before is not null then
    raise exception '31: 출시 전 가격이 소급 적용됐습니다(%).', v_before;
  end if;
end
$$;

-- 컬럼 유출 가드(§0.3). 이 마이그레이션은 객체를 만들지 않지만, 규칙은 "모든 마이그레이션"
-- 이다 — 예외를 한 번 두면 다음 사람이 그 예외를 근거로 삼는다.
select public.assert_no_public_sensitive_columns();
