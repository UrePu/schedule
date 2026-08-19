-- =============================================================================
-- M_Schedule · 26. `apply_plan_party_sizes_to_clears()` 를 **사용 중단으로 표시**한다
-- =============================================================================
-- 발주자 지시(2026-08-19): *"개별수정 가능하도록해"*
--
-- ── 무엇이 일어났는가 ───────────────────────────────────────────────────────
-- 마이그레이션 21 은 "이미 쌓인 미확인 클리어에 계획의 기본 인원수를 일괄 소급"하는
-- 함수 `public.apply_plan_party_sizes_to_clears(uuid, boolean)` 을 만들었다. 대상 조건은
--
--     boss_clears.party_size_confirmed = false  and  run_id is null
--
-- 그런데 마이그레이션 25 가 `character_boss_plans.default_party_size` 를
-- `NOT NULL DEFAULT 1` 로 확정하면서 **"미설정"이라는 상태가 사라졌고**, 넥슨 관측
-- 클리어를 만드는 유일한 경로(`sync-scheduler.ts`)가 이제 `party_size_confirmed = true`
-- 를 명시로 싣는다. 25-3 백필이 과거 행까지 올렸다.
--
-- 결과: **대상이 언제나 0건이다.** 적용 시점 실측 —
--
--     select count(*) total,
--            count(*) filter (where party_size_confirmed = false) unconfirmed
--       from public.boss_clears;
--     → total = 48, unconfirmed = 0   (2026-08-19)
--
-- ── 그래서 무엇을 했는가 ────────────────────────────────────────────────────
-- 웹 UI 의 `쌓인 클리어에 인원수 적용` 버튼 · 확인창 · `POST /api/boss-plans/party-size`
-- · 서버 래퍼 `applyPlanPartySizesToClears()` 를 **전부 걷어냈다.** 눌러도 0건이라 아무
-- 일이 일어나지 않는 버튼은, 사용자에게 "이 기능은 고장났다"로 읽힌다 — 없는 버튼보다 나쁘다.
-- 이미 쌓인 클리어의 인원은 이제 **한 건씩 개별 수정**한다(`set_clear_party_size()`).
--
-- ── 왜 함수를 DROP 하지 않는가 ──────────────────────────────────────────────
--   1. 되돌리기 어렵다. 함수 본문·권한·자기검증이 마이그레이션 21 에 묶여 있어, 지운 뒤
--      되살리려면 그 파일을 다시 읽어 옮겨 적어야 한다.
--   2. **되살릴 여지가 실재한다.** 대상 조건을 `party_size_confirmed = false` 대신
--      "계획 인원 ≠ 클리어 인원"으로 바꾸면 이 함수는 다시 의미가 생긴다 — 그때는
--      1인으로 앉은 파티 보스 클리어를 계획대로 밀어 올리는 도구가 된다(§1.3 D3).
--   3. 호출자가 이미 없으므로 남겨 두어도 사고가 나지 않는다. 실행권은 여전히
--      `service_role` 에만 있다(마이그레이션 21 의 revoke/grant 가 그대로 유효).
--
-- 그래서 이 마이그레이션은 **COMMENT 만 갱신한다.** DDL 도, 데이터 변경도 없다.
--
-- 넥슨 API 호출 없음. 재실행 안전(idempotent) — `comment on` 은 본디 멱등이다.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- 26-1. 소급 적용 함수에 "현재 호출되지 않음" 사실을 새긴다
-- -----------------------------------------------------------------------------
-- 다음에 이 함수를 보는 사람이 가장 먼저 알아야 할 것은 **왜 아무 일도 안 하는가**다.
-- 시그니처가 마이그레이션 21 과 정확히 같아야 대상 함수가 잡힌다(uuid, boolean).
comment on function public.apply_plan_party_sizes_to_clears(uuid, boolean) is
  '⚠️ [2026-08-19 사용 중단] 현재 웹 UI 에서 호출하지 않는다. '
  '대상 조건이 boss_clears.party_size_confirmed = false 인데, 마이그레이션 25 가 '
  'default_party_size 를 NOT NULL DEFAULT 1 로 확정하고 동기화 경로가 confirmed = true 를 '
  '명시로 싣게 되면서 대상이 항상 0건이다(적용 시점 실측 0/48). 그래서 버튼·API·서버 래퍼를 '
  '제거했고, 이미 쌓인 클리어의 인원은 set_clear_party_size() 로 한 건씩 개별 수정한다. '
  '함수는 되살릴 여지가 있어 남겨 둔다 — 대상 조건을 "계획 인원 <> 클리어 인원"으로 바꾸면 '
  '다시 의미가 생긴다. 실행권은 service_role 전용 그대로. '
  '(원래 동작) 이 캐릭터의 미확인 클리어(run 미연결)에 계획의 기본 인원수를 적용하고 건수를 '
  '돌려준다. p_dry_run = true 면 세기만 한다. 수정은 반드시 set_clear_party_size() 를 통과하므로 '
  '금액 재계산·주기 보존 규약이 그대로 지켜진다.';


-- -----------------------------------------------------------------------------
-- 26-2. 인원수 **설정** 함수의 COMMENT 에서 낡은 안내를 걷어낸다
-- -----------------------------------------------------------------------------
-- ⚠️ 이 함수는 **그대로 살아 있다.** 지운 것은 소급 적용 갈래뿐이고, "이 보스는 N인으로
--    돈다"를 정하는 경로(PUT /api/boss-plans/party-size → 이 함수)는 손대지 않았다.
--    바꾸는 것은 마지막 문장뿐 — 예전 COMMENT 는 소급을 하려면
--    apply_plan_party_sizes_to_clears() 를 부르라고 안내했는데, 이제 그 경로가 없다.
comment on function public.set_character_boss_plan_party_size(uuid, text, integer) is
  '계획 행의 기본 파티 인원수를 정한다. null 을 넘기면 **기본값 1로 되돌린다**(2026-08-19 — '
  '예전에는 "미설정으로 해제"였고, 이제 미설정이라는 상태가 없다). '
  'default_party_size 한 컬럼만 갱신하며 켜기/끄기·넥슨 값에 손대지 않는다. 계획에 없는 보스면 no_data_found. '
  '이미 쌓인 클리어는 바뀌지 않는다 — 그쪽은 set_clear_party_size() 로 한 건씩 개별 수정한다 '
  '(일괄 소급 경로는 2026-08-19 에 제거, 마이그레이션 26 참조).';


-- -----------------------------------------------------------------------------
-- 26-3. 자기검증 — 함수가 **여전히 존재하고** COMMENT 가 붙었는지 확인한다
-- -----------------------------------------------------------------------------
-- 이 마이그레이션의 유일한 실패 모드는 "실수로 DROP 했다"이다. 그것을 직접 막는다.
do $$
declare
  v_oid oid;
  v_comment text;
begin
  select p.oid into v_oid
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'apply_plan_party_sizes_to_clears';

  if v_oid is null then
    raise exception 'apply_plan_party_sizes_to_clears() 가 사라졌습니다. 이 마이그레이션은 DROP 하지 않습니다.';
  end if;

  v_comment := obj_description(v_oid, 'pg_proc');
  if v_comment is null or v_comment not like '%사용 중단%' then
    raise exception '사용 중단 COMMENT 가 붙지 않았습니다.';
  end if;

  -- 인원수 **설정** 함수도 살아 있어야 한다 (지운 것은 소급 갈래뿐이다).
  if not exists (
    select 1
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname = 'set_character_boss_plan_party_size'
  ) then
    raise exception 'set_character_boss_plan_party_size() 가 사라졌습니다. 설정 경로는 유지되어야 합니다.';
  end if;

  raise notice '26. 소급 적용 함수 사용 중단 표시 완료 — 함수는 보존, 설정 경로 유지';
end
$$;


-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
-- 컬럼을 새로 만들지 않았고 GRANT 도 건드리지 않았지만, 이 호출을 생략하지 않는 것이
-- 규약이다 — 테이블 단위 GRANT 가 조용히 넓어지지 않았는지 매 마이그레이션이 확인한다.
select public.assert_no_public_sensitive_columns();
