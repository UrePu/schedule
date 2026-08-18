import type { BossDifficultyTier } from "@/types/domain";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 보스 난이도 → 시각 표현. **이 파일이 유일한 정의처다.**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 순수 상수만 있고 JSX·훅·서버 전용 API 가 없으므로 **서버 컴포넌트와 클라이언트
 * 컴포넌트 양쪽에서 import 할 수 있다.** (`boss-card.tsx` 안에 두면 카드 컴포넌트를
 * 끌고 들어오게 되어 이 성질이 깨진다 — 그래서 별도 모듈로 뺐다.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 한 곳에 모았는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 이전에는 `boss-card.tsx` 가 `BORDER` 와 `LABEL` 만 export 하고 텍스트 색 맵은
 * 파일 내부에 숨어 있었다. 그래서 칩(`features/income/.../difficulty-chip.tsx`)이
 * `border-*` 와 `bg-*` 를 **값만 같게 복제**해야 했다. 같은 매핑이 두 벌이 되면
 * 반드시 갈라진다 — 실제로 이번 라이트 모드 대비 수정에서 한 곳만 고쳤다면
 * 칩과 카드의 난이도 색이 서로 달라졌을 것이다.
 *
 * ★ **문자열을 조합해서 만들지 않는다.** Tailwind 는 소스를 정적 스캔해 클래스를
 *   수집하므로 `` `border-${x}` `` 같은 런타임 조합은 빌드 결과에서 사라진다.
 *   그래서 완성된 클래스 문자열을 그대로 나열한다. 장황해 보여도 이것이 유일한
 *   안전한 방법이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 색 채널이 두 벌인 이유 — `difficulty-*` 와 `difficulty-*-ink`
 * ─────────────────────────────────────────────────────────────────────────────
 * 두 채널은 **요구 대비가 다르다.**
 *   - 면·경계(`border-l-*` `border-*` `bg-*`) → WCAG 1.4.11 **3:1**.
 *     역할은 "다섯 단계를 한눈에 가르는 것"이라 **인접 단계 간 명도차**를 최대로 벌린다.
 *   - 글자(`text-*`) → 본문 **4.5:1**. 난이도 오버라인은 11px/700 이라 WCAG 의
 *     "큰 텍스트"(18.66px bold)에 못 미쳐 3:1 이 아니라 4.5:1 을 받는다.
 *     역할은 "읽히는 것"이고, 단계 구분은 **글자 내용 자체**가 이미 한다.
 *
 * 한 램프로 둘 다 만족시키려 해 봤지만(전 구간 4.5:1 앵커) 다크에서 인접 쌍이
 * 1.03:1 까지 무너졌다 — 4.5:1 하한이 램프의 아래쪽을 밀어 올리는 만큼 위쪽 여유가
 * 사라지기 때문이다. 그래서 **역할별로 램프를 나눴다.** 값과 실측표는
 * `Claude/DARK-PALETTE.md` §6-3 에 있다.
 *
 * ★ **색은 언제나 보조 채널이다.** 난이도 이름(`BOSS_DIFFICULTY_LABEL`)을 반드시
 *   함께 싣는다. 색만으로 난이도를 전달하는 UI 를 새로 만들지 말 것.
 * ★ **익스트림은 red 가 아니다.** CLAUDE.md §4 가 red 를 실패·취소 전용으로 못 박았다.
 *   익스트림에 red 를 쓰면 "취소된 판"과 구분되지 않는다. 주황 계열을 유지한다.
 */

/**
 * 메이플스토리 보스 난이도 등급(낮음 → 높음).
 *
 * `satisfies` 로 DB enum(`boss_difficulty_tier`)에 묶어 두었다. 등급이 추가되면
 * 여기서 먼저 타입 에러가 나고, 아래 `Record` 맵들이 전부 미완성으로 잡힌다.
 */
export const BOSS_DIFFICULTIES = [
  "easy",
  "normal",
  "hard",
  "chaos",
  "extreme",
] as const satisfies readonly BossDifficultyTier[];

export type BossDifficulty = (typeof BOSS_DIFFICULTIES)[number];

export const BOSS_DIFFICULTY_LABEL: Record<BossDifficulty, string> = {
  easy: "이지",
  normal: "노멀",
  hard: "하드",
  chaos: "카오스",
  extreme: "익스트림",
};

/**
 * 카드·행의 **좌측 4px 보더**. §4 가 정한 난이도의 주 채널이다(면적이 가장 크다).
 *
 * 주의: 좌측 보더는 **난이도 전용 채널**이다. 임박/실패 같은 상태는 StatusChip 과
 * TimeUntil 이 담당하며 보더 색을 덮어쓰지 않는다. 채널을 섞으면 둘 다 못 읽는다.
 */
export const BOSS_DIFFICULTY_BORDER_L: Record<BossDifficulty, string> = {
  easy: "border-l-difficulty-easy",
  normal: "border-l-difficulty-normal",
  hard: "border-l-difficulty-hard",
  chaos: "border-l-difficulty-chaos",
  extreme: "border-l-difficulty-extreme",
};

/**
 * 카드 **상단 4px 보더**. 세로형 카드(주간 체크리스트의 12칸 그리드)가 쓴다.
 *
 * ★ 좌측 보더(`BOSS_DIFFICULTY_BORDER_L`)와 **같은 램프이고 같은 뜻**이다 — 자리만
 *   옮겼다. 가로 행에서는 좌측이 가장 넓은 면이지만, 폭이 100px 남짓인 세로 카드에서는
 *   좌측 4px 이 아이콘 옆에 눌려 거의 읽히지 않는다. 상단은 카드 폭 전체를 쓰므로 같은
 *   4px 로도 눈에 잡히는 면적이 훨씬 크다.
 *
 * ★ 여기서도 색은 **보조 채널**이다. 보스 표시명(`boss_difficulties.korean_name`)이
 *   이미 `하드 최초의 대적자` 처럼 난이도를 글자로 싣고 있어야 한다.
 */
export const BOSS_DIFFICULTY_BORDER_T: Record<BossDifficulty, string> = {
  easy: "border-t-difficulty-easy",
  normal: "border-t-difficulty-normal",
  hard: "border-t-difficulty-hard",
  chaos: "border-t-difficulty-chaos",
  extreme: "border-t-difficulty-extreme",
};

/** 칩·아이콘 슬롯의 **사방 1px 테두리**. 좌측 보더와 같은 램프다. */
export const BOSS_DIFFICULTY_BORDER: Record<BossDifficulty, string> = {
  easy: "border-difficulty-easy",
  normal: "border-difficulty-normal",
  hard: "border-difficulty-hard",
  chaos: "border-difficulty-chaos",
  extreme: "border-difficulty-extreme",
};

/** 점·막대 등 **색으로 채우는 면**. 좌측 보더와 같은 램프다. */
export const BOSS_DIFFICULTY_BG: Record<BossDifficulty, string> = {
  easy: "bg-difficulty-easy",
  normal: "bg-difficulty-normal",
  hard: "bg-difficulty-hard",
  chaos: "bg-difficulty-chaos",
  extreme: "bg-difficulty-extreme",
};

/**
 * **읽는 글자**에 쓰는 색. 잉크 램프(`difficulty-*-ink`)를 가리킨다.
 *
 * 면 램프(`difficulty-*`)를 글자에 쓰면 안 된다 — 3:1 기준으로 잡은 값이라
 * 본문 4.5:1 에 미달한다. (`ink-placeholder` 와 같은 함정이다. §4 가독성 규칙 참고.)
 * 이 맵의 다섯 값은 **양쪽 테마의 모든 표면**(surface / background / hover-surface)에서
 * 4.5:1 이상을 실측으로 확인했다.
 */
export const BOSS_DIFFICULTY_TEXT: Record<BossDifficulty, string> = {
  easy: "text-difficulty-easy-ink",
  normal: "text-difficulty-normal-ink",
  hard: "text-difficulty-hard-ink",
  chaos: "text-difficulty-chaos-ink",
  extreme: "text-difficulty-extreme-ink",
};
