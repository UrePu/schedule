export {
  AccountCrystalCapCard,
  type AccountCrystalCapCardProps,
} from "./account-cap-card";
/*
 * ⚠️ `CharacterIncomeCard` 는 **삭제됐다** (2026-08-19 발주자: *"수익 탭은 캐릭터별
 *    클리어 필요없고"*). 기능이 사라진 것이 아니라 자리를 옮겼다:
 *      · 캐릭터별 소계 · 12개 상한 경고 → `IncomeEditDialog` (상한이 캐릭터당이라 그
 *        층은 남아야 한다, §1)
 *      · 개별 클리어 수정              → `LedgerClearDialog` (달력의 날짜 · 주차 내역)
 *      · 클리어 한 줄 읽기 표시        → `WeekLedgerList` 의 펼침 목록(`ClearRecordRow`)
 */
export { CharacterSelect, type CharacterSelectProps } from "./character-select";
export {
  CrystalIncomeSummaryPanel,
  type CrystalIncomeSummaryPanelProps,
} from "./crystal-income-summary";
export {
  CLEAR_EDIT_GRID,
  ClearEditRow,
  type ClearEditRowProps,
} from "./clear-edit-row";
export { ClearRecordRow, type ClearRecordRowProps } from "./clear-record-row";
export { DifficultyChip, type DifficultyChipProps } from "./difficulty-chip";
export { IncomeCalendar, type IncomeCalendarProps } from "./income-calendar";
export {
  IncomeEditDialog,
  type IncomeEditDialogProps,
} from "./income-edit-dialog";
export {
  IncomeWorkspace,
  type IncomeWorkspaceProps,
} from "./income-workspace";
export {
  LedgerClearDialog,
  type LedgerClearDialogProps,
} from "./ledger-clear-dialog";
/*
 * `PARTY_SIZE_MIN` / `PARTY_SIZE_MAX` 는 일부러 배럴에 올리지 않는다. 같은 이름이
 * `server/income-repo.ts` 에도 있고(둘 다 DB CHECK 범위 1~24 의 사본), 배럴에서
 * 만나면 어느 쪽을 import 했는지 호출부가 헷갈린다.
 */
export { PartySizeField, type PartySizeFieldProps } from "./party-size-field";
/*
 * ⚠️ `RunClearList` 는 **삭제됐다** (2026-08-19 발주자: *"수익칸에서 이것좀 없애도될듯
 *    필요없어"* · *"드랍은 그냥 네비게이션쪽에 !드랍 과 비슷한 동작을 하는 버튼을 만들고
 *    빼버리셈"*). 기능이 없어진 것이 아니라 자리를 옮겼다:
 *      · 클리어 체크 → 인게임 스케줄러 동기화가 자동으로 넣는다(`sync-scheduler`).
 *        인원은 등록해 둔 일정이나 계획값(`character_boss_plans.default_party_size`)에서
 *        오고, 동기화 전에 즉시 반영하려면 카톡 `!클리어` 를 쓴다.
 *      · 드랍 기록 → 상단 바의 `QuickDropButton`(카톡 `!드랍` 의 웹 판).
 */
export { DropRecordForm, type DropRecordFormProps } from "./drop-record-form";
export { QuickDropButton, type QuickDropButtonProps } from "./quick-drop-button";
export { RunDropDialog, type RunDropDialogProps } from "./run-drop-dialog";
export { WarningNote } from "./warning-note";
export {
  WeekLedgerList,
  type WeekLedgerListProps,
} from "./week-ledger-list";
