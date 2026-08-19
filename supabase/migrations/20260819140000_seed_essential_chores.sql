-- =============================================================================
-- 필수 숙제 4종 시드 — 일퀘 · 몬파 / 수로 · 에픽던전
-- =============================================================================
--
-- 발주 요구(원문, 2026-08-19):
--   "매일 필수적으로 해야되는게 일퀘 몬파 / 주간 필수적으로 해야되는게 수로 에픽던전
--    캐릭터별로 (…) !숙제 하면 저걸 추적하는 모든 캐릭으로 보여주면될듯?"
--
-- 마이그레이션 04 가 만든 `chore_definitions` 는 *"시드 없음. 넥슨 daily_contents /
-- weekly_contents 의 content_name 목록은 실호출로 수집해야 하는 미확인 항목이다"* 라는
-- 주석과 함께 비어 있었다. 그 실호출은 끝났고(`Claude/NEXON-API-OBSERVED.md`, 2026-08-17
-- 실측 daily 18종 / weekly 22종), 스냅샷에도 같은 문자열이 쌓여 있다. 이제 채운다.
--
-- -----------------------------------------------------------------------------
-- ⚠️ 넥슨이 완료 여부를 주는 항목은 4개 중 **2개뿐**이다
-- -----------------------------------------------------------------------------
-- 라이브 스냅샷을 항목별로 집계해 확인한 것(2026-08-19):
--
--   | 항목       | type       | 넥슨이 주는 값        | 완료 판정                |
--   |------------|------------|-----------------------|--------------------------|
--   | 일퀘       | `quest`    | `questState` 0/1/2    | ✅ `2` = 완료            |
--   | 몬파       | `contents` | `nowCount 7 / max 14` | ✅ `now >= max`          |
--   | 수로       | `contents` | `nowCount 193963 / max 0` | ❌ 길드 **점수**이고 상한이 없다 |
--   | 에픽던전   | `contents` | `nowCount 5 / max 0`  | ❌ 상한이 0 이라 비교 불가 |
--
-- 그래서 수로·에픽던전은 `max_count = 0` 을 "완료"로 읽으면 **항상 O 가 되어 거짓말을
-- 한다.** 이 둘은 `chore_completions.manual_done` 으로 사람이 체크한다 — 그 표가 애초에
-- `manual_done` / `api_done` / `effective_done` 을 따로 들고 있는 이유가 이것이다.
-- `nexon_completable` 이 그 사실을 데이터로 들고 있으므로, 판정 로직이 이름 문자열을
-- 다시 훑지 않아도 된다.
--
-- -----------------------------------------------------------------------------
-- `nexon_content_name` 을 비워 두는 항목이 있는 이유
-- -----------------------------------------------------------------------------
-- 일퀘와 에픽던전은 **하나의 이름이 아니라 계열**이다. 실측에서 일퀘는 17종(`[일일 퀘스트]
-- …`), 에픽던전은 3종(`에픽 던전 : 하이마운틴 / 앵글러 컴퍼니 / 악몽선경`)이고 패치마다
-- 늘어난다. 이름 하나를 박아 두면 다음 던전이 추가된 날 조용히 빠진다.
-- 그래서 계열 매칭은 `src/features/boss-plans/lib/essential-chores.ts` 의 접두어 패턴이
-- 계속 소유하고, 여기에는 **단일 이름이 확정된 것만** 적는다.
-- =============================================================================

insert into public.chore_definitions
  (scope, slug, name, nexon_content_name, sort_order, is_active, is_builtin, owner_user_id)
values
  -- 일간 --------------------------------------------------------------------
  ('daily',  'daily-quest',  '일일퀘스트', null,        10, true, true, null),
  ('daily',  'monster-park', '몬스터파크', '몬스터파크', 20, true, true, null),
  -- 주간 --------------------------------------------------------------------
  ('weekly', 'underground-waterway', '지하수로', '[길드] 지하 수로', 10, true, true, null),
  ('weekly', 'epic-dungeon',         '에픽던전', null,               20, true, true, null)
on conflict (slug) do update
  set scope              = excluded.scope,
      name               = excluded.name,
      nexon_content_name = excluded.nexon_content_name,
      sort_order         = excluded.sort_order,
      is_active          = excluded.is_active;

-- -----------------------------------------------------------------------------
-- 넥슨이 완료를 판정해 줄 수 있는 항목인가
-- -----------------------------------------------------------------------------
-- 표시 코드가 "이 항목은 API 로 알 수 있나"를 **이름으로 다시 판단하지 않게** 컬럼으로
-- 들고 있는다. 이름 기반 분기는 패치로 이름이 바뀌는 순간 조용히 틀린다.
alter table public.chore_definitions
  add column if not exists nexon_completable boolean not null default false;

comment on column public.chore_definitions.nexon_completable is
  '넥슨 스케줄러 응답만으로 완료 여부를 판정할 수 있는가. false 면 사람이 체크한다'
  '(수로=길드 점수, 에픽던전=max_count 0 이라 판정 불가 — 2026-08-19 라이브 스냅샷 집계).';

update public.chore_definitions
   set nexon_completable = (slug in ('daily-quest', 'monster-park'))
 where slug in ('daily-quest', 'monster-park', 'underground-waterway', 'epic-dungeon');

-- -----------------------------------------------------------------------------
-- 자체 검증
-- -----------------------------------------------------------------------------
do $$
declare
  v_daily   integer;
  v_weekly  integer;
  v_api     integer;
begin
  select count(*) into v_daily  from public.chore_definitions where scope = 'daily'  and is_active;
  select count(*) into v_weekly from public.chore_definitions where scope = 'weekly' and is_active;
  select count(*) into v_api    from public.chore_definitions where nexon_completable;

  if v_daily < 2 then
    raise exception '일간 필수 숙제가 2건이어야 합니다(현재 %)', v_daily;
  end if;
  if v_weekly < 2 then
    raise exception '주간 필수 숙제가 2건이어야 합니다(현재 %)', v_weekly;
  end if;
  -- 넥슨이 판정 가능한 것은 일퀘·몬파 **둘뿐**이다. 이 수가 늘었다면 근거를 먼저 남길 것.
  if v_api <> 2 then
    raise exception 'nexon_completable 이 2건이어야 합니다(현재 %)', v_api;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
-- 이번에 `chore_definitions` 에 컬럼을 **추가**했다. 표 단위 GRANT 가 걸려 있었다면 새
-- 컬럼이 조용히 딸려 나가는데, 그 경로가 정확히 share_bp 가 샜던 방식이다.
select public.assert_no_public_sensitive_columns();
