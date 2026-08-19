-- =============================================================================
-- 정정: 수로·에픽던전도 넥슨으로 판정된다 (`nowCount > 0` = 이번 주에 했다)
-- =============================================================================
--
-- 직전 마이그레이션(`20260819140000`)은 라이브 스냅샷 집계만 보고
-- `nexon_completable = false` 로 박아 두었다. 근거는 이랬다:
--
--   수로     `nowCount 193963 / maxCount 0`  → 상한이 없어 비교 불가
--   에픽던전 `nowCount 5 / maxCount 0`       → 상한이 0 이라 비교 불가
--
-- **그 추론이 틀렸다.** 발주자가 게임 규칙을 알려 줬다(2026-08-19):
--   *"지하수로는 0점이면 안친거고 점수가 있으면 친거잖아."*
--
-- 주간 컨텐츠 카운터는 **KST 목요일 리셋으로 0 이 된다.** 그러므로 상한과 비교할 이유가
-- 애초에 없었고, 값이 0 이 아니라는 사실 자체가 이번 주 수행 기록이다. `maxCount` 를
-- 완료 판정의 필수 재료로 가정한 것이 실수였다.
--
-- 남는 교훈: **데이터 모양만 보고 "판정 불가"를 선언하지 않는다.** 도메인 규칙을 아는
-- 사람에게 한 번 묻는 편이 빠르다. 그 사이 사용자에게는 `?` 가 네 칸 떠 있었다.
--
-- 수동 체크(`chore_completions.manual_done`)는 **지우지 않는다.** 넥슨 데이터가 ~15분
-- 늦으므로(§1.1) 방금 깬 것을 바로 O 로 만들 경로가 여전히 필요하고, 앱은 수동 값이
-- 있으면 그것을 우선한다.
-- =============================================================================

update public.chore_definitions
   set nexon_completable = true
 where slug in ('daily-quest', 'monster-park', 'underground-waterway', 'epic-dungeon');

comment on column public.chore_definitions.nexon_completable is
  '넥슨 스케줄러 응답만으로 완료 여부를 판정할 수 있는가. 필수 4종은 전부 true — '
  '일퀘는 quest_state=2, 몬파는 now>=max, 수로·에픽던전은 주간 카운터가 리셋되므로 '
  'now>0 이면 이번 주 수행으로 읽는다(발주자 확인, 2026-08-19).';

do $$
declare
  v_api integer;
begin
  select count(*) into v_api
    from public.chore_definitions
   where is_active and nexon_completable
     and slug in ('daily-quest', 'monster-park', 'underground-waterway', 'epic-dungeon');
  if v_api <> 4 then
    raise exception '필수 4종이 모두 nexon_completable 이어야 합니다(현재 %)', v_api;
  end if;
end;
$$;

-- -----------------------------------------------------------------------------
-- 컬럼 권한 회귀 방지 (CLAUDE.md §0.3)
-- -----------------------------------------------------------------------------
select public.assert_no_public_sensitive_columns();
