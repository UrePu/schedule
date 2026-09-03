import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge 는 기본 Tailwind 테마만 알고 있어서, `@theme` 로 추가한 PipelinePro
 * 토큰을 엉뚱한 클래스 그룹으로 분류한다. 실제로 다음이 조용히 깨졌다:
 *
 * - `text-body-sm` + `text-surface` → 둘 다 "텍스트 색"으로 보고 뒤엣것만 남긴다.
 *   Primary 버튼의 흰 글씨가 사라졌다.
 * - `p-pad-lg` + `p-0`  → 서로 다른 그룹으로 봐서 둘 다 남고, 어느 쪽이 이길지는 CSS 순서 운.
 *
 * 그래서 커스텀 토큰 목록을 tailwind-merge 에 그대로 등록한다.
 * **globals.css 의 `@theme` 에 토큰을 추가하면 여기에도 반드시 추가해야 한다.**
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      // --text-*
      text: [
        "display",
        "headline",
        "subhead",
        "body-lg",
        "body",
        "body-sm",
        "caption",
        "overline",
        "code",
        "label",
      ],
      // --color-* (기본 팔레트에 없는 이름만)
      color: [
        "primary",
        "primary-hover",
        "primary-active",
        "primary-subtle",
        "secondary",
        "tertiary",
        "background",
        "surface",
        "success",
        "warning",
        "error",
        "error-hover",
        "info",
        "border",
        "border-strong",
        "ink",
        "ink-label",
        "ink-muted",
        "ink-placeholder",
        "hover-surface",
        "focus-ring",
        "chip-done-bg",
        "chip-done-fg",
        "chip-done-border",
        "chip-soon-bg",
        "chip-soon-fg",
        "chip-soon-border",
        "chip-failed-bg",
        "chip-failed-fg",
        "chip-failed-border",
        // 겹쳐보기 의미 토큰 (테마별로 값이 바뀐다)
        "overlap-1",
        "overlap-2",
        "overlap-3",
        "overlap-4",
        "overlap-5",
        "overlap-1-fg",
        "overlap-2-fg",
        "overlap-3-fg",
        "overlap-4-fg",
        "overlap-5-fg",
        "available",
        "excluded",
        "scrim",
      ],
      // --spacing-*
      spacing: [
        "pad-sm",
        "pad-md",
        "pad-lg",
        "btn-x",
        "section-mobile",
        "section-tablet",
        "section-desktop",
        "control-sm",
        "control-md",
        "control-lg",
        "chip",
        "list-item",
        "nav-mobile",
      ],
      // --radius-*
      radius: ["tooltip"],
      // --shadow-*
      shadow: ["subtle", "medium", "large", "overlay", "drag"],
      // --font-*
      font: ["headline", "sans", "mono"],
    },
  },
});

/** Tailwind 클래스 병합 헬퍼. 뒤에 오는 클래스가 앞의 충돌 클래스를 덮는다. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** 메소 금액 표기는 항상 ko-KR 로케일 포맷을 쓴다 (PipelinePro 규칙). */
export function formatMeso(amount: number): string {
  return new Intl.NumberFormat("ko-KR").format(amount);
}

/**
 * 큰 메소 금액을 한국식으로 축약한다. 예) 324_000_000 → "3억 2,400만"
 *
 * 규칙:
 * - 조/억/만 중 가장 큰 단위 하나와 그 바로 아래 단위 하나까지만 노출한다.
 *   (세 단위를 모두 쓰면 카드 한 줄에 들어가지 않는다)
 * - 남는 자리가 0 이면 아래 단위를 생략한다. 예) 100_000_000 → "1억"
 * - 10,000 미만은 축약하지 않고 ko-KR 천단위 구분만 적용한다.
 * - 숫자 자체의 천단위 구분은 항상 `Intl.NumberFormat("ko-KR")` 을 경유한다.
 *
 * 정확한 값이 필요한 곳에서는 이 함수가 아니라 `formatMeso` 를 함께 노출할 것.
 */
/**
 * **아주 좁은 자리 전용** 축약 — 가장 큰 단위 하나만 남긴다. `316억 7,175만` → `316억`.
 *
 * 수익 달력의 폰 화면(칸 폭 50px 안팎)을 위해 만들었다(2026-08-25). 거기서는
 * `formatMesoCompact` 가 두 줄로 접히고, 접히는 순간 날짜별 금액을 눈으로 비교할 수
 * 없게 된다 — 이 화면의 목적이 그 비교다.
 *
 * ★ **버림이다(내림).** 남은 자리를 반올림하면 화면이 실제보다 큰 금액을 말할 수 있다.
 *   돈을 다루는 화면에서 과대 표기는 과소 표기보다 훨씬 비싸다.
 * ⚠️ 정확한 값은 반드시 **다른 경로로 남긴다**(호출부가 `title` 로 붙인다). 이 문자열만
 *    보고 금액을 옮겨 적으면 틀린다.
 */
export function formatMesoShort(amount: number): string {
  if (!Number.isFinite(amount)) return formatMeso(amount);
  return formatMesoCompact(amount).split(" ")[0];
}

export function formatMesoCompact(amount: number): string {
  if (!Number.isFinite(amount)) {
    return formatMeso(amount);
  }

  const sign = amount < 0 ? "-" : "";
  const abs = Math.abs(Math.trunc(amount));

  /** 큰 단위부터. 마지막 [1, ""] 은 "만" 아래 남는 일의 자리를 받아 준다. */
  const UNITS: ReadonlyArray<readonly [number, string]> = [
    [1e12, "조"],
    [1e8, "억"],
    [1e4, "만"],
    [1, ""],
  ];

  const headIndex = UNITS.findIndex(([size]) => size > 1 && abs >= size);
  if (headIndex === -1) {
    return formatMeso(amount);
  }

  const [headSize, headLabel] = UNITS[headIndex];
  const [tailSize, tailLabel] = UNITS[headIndex + 1];

  const head = Math.floor(abs / headSize);
  const remainder = abs % headSize;
  const tail = Math.floor(remainder / tailSize);

  const parts = [`${formatMeso(head)}${headLabel}`];
  if (tail > 0) {
    parts.push(`${formatMeso(tail)}${tailLabel}`);
  }

  return `${sign}${parts.join(" ")}`;
}
