/**
 * `src/app/globals.css` 에서 색 토큰과 타이포 토큰을 뽑아낸다.
 *
 * ★ **토큰 표를 손으로 옮겨 적지 않는다.** CLAUDE.md §4 의 사고("토큰 표를 보고 판정해서
 *   통과가 났는데 화면은 안 읽혔다")를 되풀이하지 않으려면, 감사기가 읽는 값과 브라우저가
 *   쓰는 값이 **같은 파일 하나**에서 나와야 한다. 여기 하드코딩된 색은 하나도 없다.
 *
 * 파일 구조(§2-3 in Claude/DARK-PALETTE.md):
 *   @theme { --color-*: <라이트 값> }                     ← 라이트 팔레트
 *   :root { --dk-*: <다크 값> }                            ← 다크 값의 유일한 정의처
 *   @media (prefers-color-scheme: dark) :root:not([data-theme="light"]) {
 *     --color-x: var(--dk-x);                              ← 적용 매핑
 *   }
 */

import { readFileSync } from "node:fs";

export type ThemeName = "light" | "dark";

export interface TypographyToken {
  name: string;
  /** clamp 의 하한(=가장 좁은 뷰포트). 대비 임계값 판정은 **가장 작은 크기**로 한다. */
  minPx: number;
  /** clamp 의 상한(=데스크톱). */
  maxPx: number;
  fontWeight: number;
}

export interface TokenTable {
  /** 테마별 `--color-*` 최종 값. 키에서 `--color-` 접두사는 뗀다. */
  colors: Record<ThemeName, Map<string, string>>;
  typography: Map<string, TypographyToken>;
}

/** `@theme { ... }` 처럼 중괄호가 중첩될 수 있는 블록을 균형 맞춰 잘라낸다. */
function sliceBlock(source: string, startIndex: number): string {
  const open = source.indexOf("{", startIndex);
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

function collectDeclarations(block: string): Map<string, string> {
  const out = new Map<string, string>();
  // 주석을 먼저 지운다. 주석 안에 예시 hex 가 잔뜩 들어 있어 그대로 두면 토큰으로 잡힌다.
  const stripped = block.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /(--[a-z0-9-]+)\s*:\s*([^;}]+)[;}]/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

const CLAMP = /clamp\(\s*([^,]+),[^,]+,\s*([^)]+)\)/;

function parsePx(raw: string): number {
  return Number.parseFloat(raw.trim().replace("px", ""));
}

export function loadTokens(globalsCssPath: string): TokenTable {
  const css = readFileSync(globalsCssPath, "utf8");

  const themeIndex = css.indexOf("@theme");
  if (themeIndex === -1) {
    throw new Error(`@theme 블록을 찾지 못했다: ${globalsCssPath}`);
  }
  const themeDecls = collectDeclarations(sliceBlock(css, themeIndex));

  // 다크 값(`--dk-*`)의 정의처 — `@theme` 바깥의 최상위 `:root { }`.
  const rootIndex = css.indexOf(":root {", themeIndex);
  const rootDecls =
    rootIndex === -1
      ? new Map<string, string>()
      : collectDeclarations(sliceBlock(css, rootIndex));

  // 적용 매핑 — `--color-x: var(--dk-x)`.
  const darkRuleIndex = css.indexOf('data-theme="dark"');
  const darkMapping =
    darkRuleIndex === -1
      ? new Map<string, string>()
      : collectDeclarations(sliceBlock(css, darkRuleIndex));

  const light = new Map<string, string>();
  const dark = new Map<string, string>();

  for (const [name, value] of themeDecls) {
    if (!name.startsWith("--color-")) continue;
    const key = name.slice("--color-".length);
    light.set(key, value);
    dark.set(key, value); // 매핑이 없으면 라이트 값을 그대로 쓴다(테마 무관 토큰).
  }

  for (const [name, value] of darkMapping) {
    if (!name.startsWith("--color-")) continue;
    const key = name.slice("--color-".length);
    const ref = /^var\(\s*(--[a-z0-9-]+)\s*\)$/i.exec(value);
    const resolved = ref ? rootDecls.get(ref[1]) : value;
    if (resolved === undefined) {
      throw new Error(
        `다크 매핑 --color-${key} 가 참조하는 ${value} 의 값을 찾지 못했다`,
      );
    }
    dark.set(key, resolved);
  }

  const typography = new Map<string, TypographyToken>();
  for (const [name, value] of themeDecls) {
    if (!name.startsWith("--text-") || name.includes("--", 2)) continue;
    const key = name.slice("--text-".length);
    const clamped = CLAMP.exec(value);
    const minPx = clamped ? parsePx(clamped[1]) : parsePx(value);
    const maxPx = clamped ? parsePx(clamped[2]) : parsePx(value);
    const weightRaw = themeDecls.get(`--text-${key}--font-weight`);
    typography.set(key, {
      name: key,
      minPx,
      maxPx,
      fontWeight: weightRaw ? Number.parseInt(weightRaw, 10) : 400,
    });
  }

  return { colors: { light, dark }, typography };
}
