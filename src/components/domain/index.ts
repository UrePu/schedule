export { BossCard, type BossCardProps } from "./boss-card";
/**
 * 난이도 → 시각 표현. `boss-difficulty.ts` 가 **유일한 정의처다.**
 * 새 화면에서 난이도 색이 필요하면 여기서 가져다 쓰고, 절대 다시 정의하지 말 것.
 */
export {
  BOSS_DIFFICULTIES,
  BOSS_DIFFICULTY_BG,
  BOSS_DIFFICULTY_BORDER,
  BOSS_DIFFICULTY_BORDER_L,
  BOSS_DIFFICULTY_BORDER_T,
  BOSS_DIFFICULTY_LABEL,
  BOSS_DIFFICULTY_TEXT,
  type BossDifficulty,
} from "./boss-difficulty";
/**
 * 보스 아이콘. **경로 규칙(`public/bosses/{boss_difficulties.id}.png`)은 여기에만 있다.**
 * 새 화면에서 보스 썸네일이 필요하면 `BossIcon` 을 쓰고, `/bosses/...` 문자열을 직접
 * 조립하지 말 것 — 복제되는 순간 파일명 규칙이 갈라진다.
 */
export { BossIcon, type BossIconProps, type BossIconSize } from "./boss-icon";
export {
  BOSS_ICON_IDS,
  bossIconSrc,
  hasBossIcon,
} from "./boss-icon-manifest";
export {
  formatKstDayKey,
  formatKstFull,
  formatKstShort,
  kstWeekdayKo,
} from "./kst-format";
export { MesoAmount, type MesoAmountProps, type MesoTone } from "./meso-amount";
/**
 * 등폭 숫자. 메이플스토리체에는 `tnum` 이 없어 `tabular-nums` 가 무효다
 * (`Claude/FONT-NOTES.md` §6-1 · §9). **돈 · 상한 카운터 · 시각**에만 쓴다.
 */
export { Numeric, NumericText } from "./numeric";
export {
  SeatNumber,
  type SeatNumberProps,
  type SeatNumberSize,
  type SeatNumberTone,
} from "./seat-number";
export {
  DEFAULT_IMMINENT_MS,
  TimeUntil,
  getTimeUntilState,
  type TimeUntilProps,
  type TimeUntilState,
} from "./time-until";
export { WeekLabel, type WeekLabelProps } from "./week-label";
