import {
  BOSS_DIFFICULTY_BG,
  BOSS_DIFFICULTY_BORDER,
  BOSS_DIFFICULTY_LABEL,
} from "@/components/domain";
import { cn } from "@/lib/utils";
import type { BossDifficultyTier } from "@/types/domain";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 난이도 색 칩 — 수정 모달의 조밀한 매트릭스에서 한 눈에 난이도를 가른다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 색 매핑은 여기 없다 — `@/components/domain` 의 `boss-difficulty` 를 쓴다
 * ─────────────────────────────────────────────────────────────────────────────
 * 예전에는 이 파일이 `border-*` / `bg-*` 맵을 **값만 같게 복제**하고 있었다.
 * (당시 `boss-card.tsx` 가 좌측 보더 맵과 라벨만 export 했기 때문이다.)
 * 지금은 네 가지 채널 맵이 전부 한 모듈에서 나오므로 복제가 없다 —
 * 난이도 색을 바꿀 일이 생기면 `boss-difficulty.ts` 한 곳만 고치면 된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 글자는 **잉크**, 색은 **점과 테두리**가 진다 (§4)
 * ─────────────────────────────────────────────────────────────────────────────
 * 레퍼런스 계산기는 난이도 칩을 색 배경 + 색 글자로 그리지만, 그대로 옮기면 읽히지 않는다.
 * §4 의 경고 문구 규칙("주황은 배경과 아이콘이 지고 글자는 잉크가 진다")과 같은 해법을 쓴다:
 *   - 라벨 글자 = `text-ink` — 라이트 17.72:1 · 다크 16.09:1 (실측)
 *   - 색 채널 = 1px 테두리 + 지름 8px 점 (`difficulty-*` 램프, 양쪽 테마 전 표면 3:1 이상)
 *
 * ★ 색은 **보조 채널**이다. 이 칩은 항상 난이도 이름을 글자로 함께 싣는다.
 * ★ **익스트림은 붉은색이 아니다.** 레퍼런스는 익스트림을 빨강으로 쓰지만 §4 는 red 를
 *   실패·취소 전용으로 못 박았다. 익스트림에 red 를 쓰면 "취소된 판"과 구분되지 않는다.
 */

export interface DifficultyChipProps {
  readonly difficulty: BossDifficultyTier;
  readonly className?: string;
}

export function DifficultyChip({ difficulty, className }: DifficultyChipProps) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border bg-surface px-2 py-0.5",
        "text-caption text-ink",
        BOSS_DIFFICULTY_BORDER[difficulty],
        className,
      )}
    >
      {/*
        점은 8px 이다. 1px 테두리만으로는 색 면적이 너무 작아 다섯 단계의 명도 차이가
        눈에 들어오지 않는다. 의미는 옆 글자가 확실히 전달한다.
      */}
      <span
        aria-hidden
        className={cn(
          "size-2 shrink-0 rounded-full",
          BOSS_DIFFICULTY_BG[difficulty],
        )}
      />
      {BOSS_DIFFICULTY_LABEL[difficulty]}
    </span>
  );
}

/*
 * ═════════════════════════════════════════════════════════════════════════════
 * `BossIconSlot` 은 여기 없다 — `@/components/domain` 의 `BossIcon` 으로 옮겼다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 예전 이 파일의 `BossIconSlot` 은 "보스 썸네일이 생기면 여기를 `<Image>` 로 바꾸면
 * 된다"는 자리 표시자였다. 실제로 에셋(`public/bosses/*.png`)이 생겼는데, 같은 성격의
 * 자리 표시자가 주간 체크리스트와 계획 화면에도 각각 `Swords` 아이콘으로 따로
 * 있었다 — 세 곳을 따로 고쳐야 하는 상태였다.
 *
 * 그래서 도메인 컴포넌트로 승격시켰다. 파일 경로 규칙(`public/bosses/{id}.png`)과
 * 폴백 처리가 한 곳에만 있어야 갈라지지 않는다. 난이도 색 매핑을
 * `boss-difficulty.ts` 로 모은 것과 정확히 같은 이유다.
 */
