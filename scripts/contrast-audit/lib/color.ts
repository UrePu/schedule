/**
 * 색 계산 — WCAG 2.1 상대휘도 · 대비비 · 알파 합성.
 *
 * 여기 있는 수식은 전부 WCAG 2.1 정의를 그대로 옮긴 것이다.
 * - 상대휘도: https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 * - 대비비:   https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 *
 * ★ 알파 합성을 **sRGB 감마 공간에서** 한다. 브라우저의 소스-오버 합성이
 *   실제로 감마 공간에서 일어나기 때문이다(선형 공간에서 섞으면 화면과 다른 값이 나온다).
 *   `text-ink/50`, `bg-primary/25` 같은 토큰은 합성 후에 휘도를 재야 의미가 있다.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
  /** 0..1. 불투명이면 1. */
  a: number;
}

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;
const HEX6 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX8 = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
/** `rgb(24 24 27 / .5)` · `rgb(24, 24, 27)` · `rgba(...)` 를 모두 받는다. */
const RGB_FN = /^rgba?\(\s*([^)]+)\)$/i;

/**
 * CSS 색 문자열을 파싱한다. 해석할 수 없으면 `null`.
 *
 * 지원: `#rgb` · `#rrggbb` · `#rrggbbaa` · `rgb()` · `rgba()` · `transparent`.
 * 이 저장소의 토큰은 전부 이 범위 안에 있다. 범위를 넘는 값(예: `oklch()`)이
 * 들어오면 **조용히 건너뛰지 말고** 호출부가 "수동 확인 필요"로 보고해야 한다.
 */
export function parseColor(input: string): Rgb | null {
  const value = input.trim();
  if (value === "transparent") return { r: 0, g: 0, b: 0, a: 0 };

  const m3 = HEX3.exec(value);
  if (m3) {
    return {
      r: parseInt(m3[1] + m3[1], 16),
      g: parseInt(m3[2] + m3[2], 16),
      b: parseInt(m3[3] + m3[3], 16),
      a: 1,
    };
  }

  const m8 = HEX8.exec(value);
  if (m8) {
    return {
      r: parseInt(m8[1], 16),
      g: parseInt(m8[2], 16),
      b: parseInt(m8[3], 16),
      a: parseInt(m8[4], 16) / 255,
    };
  }

  const m6 = HEX6.exec(value);
  if (m6) {
    return {
      r: parseInt(m6[1], 16),
      g: parseInt(m6[2], 16),
      b: parseInt(m6[3], 16),
      a: 1,
    };
  }

  const fn = RGB_FN.exec(value);
  if (fn) {
    // `24 24 27 / .5` 와 `24, 24, 27, .5` 두 표기를 같은 배열로 정규화한다.
    const [rgbPart, alphaPart] = fn[1].split("/");
    const parts = rgbPart
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (parts.length < 3) return null;
    const channel = (raw: string): number => {
      if (raw.endsWith("%")) return (Number.parseFloat(raw) / 100) * 255;
      return Number.parseFloat(raw);
    };
    const alphaRaw = alphaPart ?? parts[3];
    const alpha = alphaRaw === undefined ? 1 : parseAlpha(alphaRaw);
    const r = channel(parts[0]);
    const g = channel(parts[1]);
    const b = channel(parts[2]);
    if ([r, g, b, alpha].some((n) => Number.isNaN(n))) return null;
    return { r, g, b, a: alpha };
  }

  return null;
}

function parseAlpha(raw: string): number {
  const trimmed = raw.trim();
  if (trimmed.endsWith("%")) return Number.parseFloat(trimmed) / 100;
  return Number.parseFloat(trimmed);
}

/** 알파를 덮어쓴 사본. Tailwind 의 `/NN` 불투명도 수식어를 표현한다. */
export function withAlpha(color: Rgb, alpha: number): Rgb {
  return { ...color, a: alpha };
}

/**
 * `fg` 를 `bg` 위에 source-over 합성한다. 결과는 항상 불투명(`a: 1`).
 *
 * `bg` 자체가 반투명이면 그 알파는 이미 상위 면에서 해소됐다고 본다 —
 * 호출부가 배경 스택을 아래에서 위로 순서대로 합성해 넘겨야 한다.
 */
export function composite(fg: Rgb, bg: Rgb): Rgb {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1,
  };
}

function channelLuminance(value255: number): number {
  const c = value255 / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 상대휘도 (0..1). 입력은 불투명해야 한다. */
export function relativeLuminance(color: Rgb): number {
  return (
    0.2126 * channelLuminance(color.r) +
    0.7152 * channelLuminance(color.g) +
    0.0722 * channelLuminance(color.b)
  );
}

/** WCAG 2.1 대비비 (1..21). 두 색 모두 불투명해야 한다. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** 표시용 hex. 합성 결과의 소수 채널을 반올림한다. */
export function toHex(color: Rgb): string {
  const part = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${part(color.r)}${part(color.g)}${part(color.b)}`;
}

/** 소수 둘째 자리까지. 표에서 자릿수가 흔들리지 않도록 항상 고정 폭. */
export function formatRatio(ratio: number): string {
  return ratio.toFixed(2);
}
