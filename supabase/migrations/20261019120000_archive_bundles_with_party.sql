-- ═══════════════════════════════════════════════════════════════════════════
-- 보관된 파티의 **묶음도 보관**한다 — 2026-10-17 파티원 신고의 데이터 정리
-- ═══════════════════════════════════════════════════════════════════════════
--
-- 신고(2026-10-17, 풍무고불빠따 → 발주자):
--   *"맨위에있는거 파티터저서 삭제했는데 그대로 남아있어요"*
--
-- 라이브 실측: **보관된 파티 36개가 전부 활성 묶음을 들고 있다.**
--
-- ── 왜 이 상태가 만들어졌나 ───────────────────────────────────────────────────
-- 1단계 이행(`20261016140000_party_bundles.sql`)은 `archived_at` 을 파티→묶음으로
-- **일부러 복사하지 않았다**(그 파일 7-1 머리말, 그리고 단정 5-c 가 복사를 금지했다).
-- 그때는 옳은 판단이었다:
--   · 보관 상태의 소유자는 `parties.archived_at` **하나**였고 모든 읽기 경로가 그것을
--     걸러 주었다;
--   · 묶음까지 보관하면 `loadPartyBossRows`(= `archived_at is null` 인 묶음 하나)가
--     보관된 파티의 보스 목록을 **빈 배열로** 떨어뜨려, 1단계의 조건인 "화면 한 픽셀도
--     안 바뀐다" 를 깼다.
--
-- 2단계(파티 하나에 묶음 여러 개)에서 **묶음이 목록의 주인**이 되면서 그 결정이 거꾸로
-- 샜다. 묶음은 이제 그 자체로 "고를 수 있는 조합"이고, 보관된 파티의 묶음이 활성으로
-- 남아 있는 것은 **"이 조합으로 아직 돈다"** 는 거짓말이다. (지금은 `fetchMyBundles` 가
-- `fetchParties` 를 거쳐 걸러져 화면에는 안 보이지만, 묶음을 파티를 거치지 않고 읽는
-- 경로가 하나 생기는 날 전부 되살아난다.)
--
-- ── 이 마이그레이션이 하는 일과 하지 않는 일 ────────────────────────────────────
-- 하는 일:   보관된 파티의 **활성 묶음**에 `archived_at` 을 채운다.
-- 하지 않는 일:
--   ⚠️ **아무 행도 지우지 않는다.** `party_runs.bundle_id` 가 이 행들을 가리키고,
--      정산 뷰(`v_run_share_weights`)가 그 묶음의 `share_mode` · `crystal_follows_share`
--      를 읽어 **지난 런의 분배를 설명**한다. FK 가 `on delete set null` 이라 지워도
--      금액은 살아남지만(뷰가 파티 값으로 떨어진다) "이 돈이 왜 이렇게 나뉘었나" 의
--      근거가 사라진다. 그래서 보관이고, 삭제가 아니다.
--   ⚠️ **활성 파티의 묶음은 건드리지 않는다.**
--   ⚠️ **과거 수익·클리어는 한 푼도 움직이지 않는다.** 이 파일이 쓰는 컬럼은
--      `party_bundles.archived_at` 하나이고, 금액을 내는 어떤 뷰도 그 컬럼을 읽지 않는다
--      (정산은 `share_mode` · `crystal_follows_share` · `party_bundle_shares` 를 읽는다).
--
-- ★ **보관 시각은 파티의 것을 쓴다.** `now()` 로 찍으면 "파티는 8월에 터졌는데 묶음은
--   10월에 보관됨" 이라는, 나중에 아무도 설명할 수 없는 기록이 남는다.
-- ★ **재실행 가능하다.** `archived_at is null` 만 고르므로 두 번 돌려도 둘째 번은 0건이고
--   이미 채워진 시각을 덮지 않는다.
-- ★ 앞으로 생기는 것은 앱이 막는다 — `schedule-repo.archiveParty()` 가 파티를 보관한
--   직후 같은 갱신을 한다(그 머리말). 이 파일은 **이미 쌓인 것**을 한 번 정리한다.
-- ═══════════════════════════════════════════════════════════════════════════

-- 0. 표가 없으면 할 일이 없다. 묶음 마이그레이션이 적용되지 않은 DB(로컬 하네스 등)에서
--    이 파일이 실패하면 뒤따르는 마이그레이션 전부가 막힌다.
do $$
begin
  if to_regclass('public.party_bundles') is null then
    raise notice 'party_bundles 가 없습니다 — 정리할 것이 없어 건너뜁니다.';
    return;
  end if;

  -- ── 1. 정리 전 상태를 **먼저 말한다** ────────────────────────────────────────
  declare
    v_before integer;
    v_after  integer;
    v_runs   integer;
    v_rows   integer;
  begin
    select count(*) into v_before
      from public.party_bundles b
      join public.parties p on p.id = b.party_id
     where p.archived_at is not null
       and b.archived_at is null;
    raise notice '보관된 파티의 활성 묶음 % 건을 정리합니다.', v_before;

    -- 이 묶음들을 가리키는 런 수. **지우지 않는다는 사실**을 숫자로 못박는다.
    select count(*) into v_runs
      from public.party_runs r
      join public.party_bundles b on b.id = r.bundle_id
      join public.parties p on p.id = b.party_id
     where p.archived_at is not null;
    raise notice '그 묶음들을 가리키는 런 % 건 — 보관이므로 전부 그대로 남습니다.', v_runs;

    -- ── 2. 정리 ──────────────────────────────────────────────────────────────
    update public.party_bundles b
       set archived_at = p.archived_at
      from public.parties p
     where p.id = b.party_id
       and p.archived_at is not null
       and b.archived_at is null;
    get diagnostics v_rows = row_count;
    raise notice '묶음 % 건을 보관했습니다(시각은 파티의 archived_at).', v_rows;

    -- ── 3. 단정 — 남은 것이 0 이어야 한다 ────────────────────────────────────
    select count(*) into v_after
      from public.party_bundles b
      join public.parties p on p.id = b.party_id
     where p.archived_at is not null
       and b.archived_at is null;
    if v_after > 0 then
      raise exception
        '보관된 파티의 활성 묶음이 아직 % 건 남았습니다.', v_after;
    end if;

    -- 런이 한 건도 사라지지 않았는가. 보관은 삭제가 아니다.
    select count(*) into v_rows
      from public.party_runs r
      join public.party_bundles b on b.id = r.bundle_id
      join public.parties p on p.id = b.party_id
     where p.archived_at is not null;
    if v_rows <> v_runs then
      raise exception
        '보관된 파티의 런이 % → % 로 변했습니다 — 묶음이 지워졌습니다.', v_runs, v_rows;
    end if;

    -- 활성 파티의 묶음을 잘못 건드리지 않았는가.
    select count(*) into v_rows
      from public.party_bundles b
      join public.parties p on p.id = b.party_id
     where p.archived_at is null
       and b.archived_at is not null
       -- 사용자가 직접 보관한 묶음은 정상이다. 이 마이그레이션이 찍었다면 시각이
       -- 파티의 `archived_at` 과 같을 수밖에 없고, 그 파티는 archived_at 이 null 이다.
       and b.archived_at = p.archived_at;
    if v_rows > 0 then
      raise exception
        '활성 파티의 묶음 % 건이 이 마이그레이션에 의해 보관됐습니다.', v_rows;
    end if;
  end;
end
$$;

-- ⚠️ 민감 컬럼 가드 — CLAUDE.md §0.3. 이 파일은 컬럼을 추가하지도 GRANT 를 바꾸지도
--    않지만, **호출을 생략하는 것이 규칙 위반**이다(생략으로 통과한 전례가 share_bp 유출).
select public.assert_no_public_sensitive_columns();
