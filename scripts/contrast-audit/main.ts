/**
 * 대비 감사기 — `pnpm contrast`
 *
 * 무엇을 하나
 *   1. `src/app/globals.css` 에서 라이트·다크 색 토큰과 타이포 토큰을 **직접 읽는다.**
 *   2. `src/**` 의 JSX 트리를 걸으며 (전경색, 조상 배경, 글자 크기) 조합을 모은다.
 *   3. WCAG 2.1 로 **양쪽 테마** 대비비를 내고 미달을 출력한다.
 *
 * 왜 이렇게까지 하나 (CLAUDE.md §4)
 *   과거에 "토큰 표를 `surface` 하나에만 맞춰 검사"해서 통과 판정이 났는데, 실제 글자는
 *   `hover-surface` 위 11~12px 에 있어 화면이 읽히지 않았다. 그래서 이 도구는 토큰 표가
 *   아니라 **화면에서 실제로 만나는 색 쌍**을 본다.
 *
 * 기준
 *   - 본문 문장            4.5:1
 *   - 큰 텍스트(24px+ 또는 18.66px+ bold)  3:1
 *   - 장식 아이콘·UI 경계   3:1
 *   글자 크기는 clamp 의 **하한(모바일)** 으로 판정한다 — 가장 불리한 쪽이 실제로 존재한다.
 *
 * 종료 코드: 미달이 하나라도 있으면 1.
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  composite,
  contrastRatio,
  formatRatio,
  parseColor,
  toHex,
  withAlpha,
  type Rgb,
} from "./lib/color";
import { loadTokens, type ThemeName, type TokenTable } from "./lib/tokens";
import {
  ROOT_BACKGROUND,
  scanRepo,
  type BackgroundLayer,
  type FgUsage,
} from "./lib/scan";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const SRC = join(REPO_ROOT, "src");
const GLOBALS = join(SRC, "app", "globals.css");

/**
 * 배경이 확정되지 않은(=변형 맵 안에 홀로 있는) 전경색을 검사할 면들.
 * 디자인 시스템 컴포넌트는 앱 어디에나 놓이므로 흔한 면 **전부**에서 읽혀야 한다.
 */
const COMMON_SURFACES = [
  "background",
  "surface",
  "hover-surface",
  "neutral-100",
];

const THEMES: ThemeName[] = ["light", "dark"];

interface Finding {
  usage: FgUsage;
  theme: ThemeName;
  bgLabel: string;
  fgHex: string;
  bgHex: string;
  ratio: number;
  required: number;
  sizePx: number;
  weight: number;
}

function resolveColor(
  tokens: TokenTable,
  theme: ThemeName,
  token: string,
): Rgb | null {
  const raw = tokens.colors[theme].get(token);
  if (raw === undefined) return null;
  return parseColor(raw);
}

/** 배경 스택을 아래에서 위로 합성해 불투명한 한 색으로 만든다. */
function flattenBackground(
  tokens: TokenTable,
  theme: ThemeName,
  layer: BackgroundLayer,
): { color: Rgb; label: string } | null {
  let base = resolveColor(tokens, theme, ROOT_BACKGROUND);
  if (!base) return null;
  const names: string[] = [];
  for (const entry of layer.stack) {
    const c = resolveColor(tokens, theme, entry.token);
    if (!c) return null;
    base = composite(entry.alpha === null ? c : withAlpha(c, entry.alpha), base);
    names.push(entry.alpha === null ? entry.token : `${entry.token}/${Math.round(entry.alpha * 100)}`);
  }
  const label = names.join(" › ") + (layer.variant ? ` (${layer.variant})` : "");
  return { color: base, label };
}

function requiredRatio(sizePx: number, weight: number, decorative: boolean): number {
  if (decorative) return 3;
  // WCAG 2.1: 18pt(24px) 이상, 또는 14pt(18.66px) 이상 bold 는 "큰 텍스트".
  // bold 는 700 이상으로 본다 — 600 을 큰 텍스트로 쳐 주면 실제보다 후하게 통과한다.
  if (sizePx >= 24) return 3;
  if (sizePx >= 18.66 && weight >= 700) return 3;
  return 4.5;
}

/**
 * `pnpm contrast --pair <전경토큰> <배경토큰> [...]` — 한 쌍을 직접 재 본다.
 * 리뷰에서 "그래서 이 조합이 지금 몇 대 일이냐"를 묻는 순간이 반드시 오는데,
 * 그때 계산기를 새로 짜게 만들지 않으려고 도구에 넣어 둔다.
 */
function printPairs(tokens: TokenTable, args: string[]): void {
  for (let i = 0; i + 1 < args.length; i += 2) {
    const fgName = args[i].replace(/^text-/, "");
    const bgName = args[i + 1].replace(/^bg-/, "");
    const row: string[] = [];
    for (const theme of THEMES) {
      const fg = resolveColor(tokens, theme, fgName);
      const bg = resolveColor(tokens, theme, bgName);
      if (!fg || !bg) {
        row.push(`${theme}: 토큰 없음`);
        continue;
      }
      const flat = composite(fg, bg);
      row.push(
        `${theme} ${formatRatio(contrastRatio(flat, bg))}:1 (${toHex(fg)} / ${toHex(bg)})`,
      );
    }
    console.log(`text-${fgName} / bg-${bgName}  →  ${row.join("   ·   ")}`);
  }
}

function main(): void {
  const tokens = loadTokens(GLOBALS);
  const argv = process.argv.slice(2);
  if (argv[0] === "--pair") {
    printPairs(tokens, argv.slice(1));
    return;
  }
  const colorTokens = new Set(tokens.colors.light.keys());
  const sizeTokens = new Set(tokens.typography.keys());

  const { usages, manual, smallSentences } = scanRepo(
    SRC,
    REPO_ROOT,
    colorTokens,
    sizeTokens,
  );

  const findings: Finding[] = [];
  const unresolvedTokens = new Set<string>();

  for (const usage of usages) {
    const typo =
      tokens.typography.get(usage.context.sizeToken) ??
      tokens.typography.get("body");
    if (!typo) continue;
    const sizePx = typo.minPx;
    const weight = usage.context.weightOverride ?? typo.fontWeight;
    const required = requiredRatio(sizePx, weight, usage.decorative);

    const layers: BackgroundLayer[] =
      usage.context.backgrounds.length > 0
        ? usage.context.backgrounds
        : COMMON_SURFACES.map((token) => ({
            stack: [{ token, alpha: null }],
            variant: null,
            guards: new Map<string, boolean>(),
          }));

    for (const theme of THEMES) {
      const fgBase = resolveColor(tokens, theme, usage.fgToken);
      if (!fgBase) {
        unresolvedTokens.add(usage.fgToken);
        continue;
      }
      for (const layer of layers) {
        const bg = flattenBackground(tokens, theme, layer);
        if (!bg) {
          unresolvedTokens.add(layer.stack.map((s) => s.token).join("+"));
          continue;
        }
        const fg =
          usage.fgAlpha === null
            ? fgBase
            : composite(withAlpha(fgBase, usage.fgAlpha), bg.color);
        const ratio = contrastRatio(fg, bg.color);
        if (ratio + 1e-9 < required) {
          findings.push({
            usage,
            theme,
            bgLabel: bg.label,
            fgHex: toHex(fg),
            bgHex: toHex(bg.color),
            ratio,
            required,
            sizePx,
            weight,
          });
        }
      }
    }
  }

  // 같은 (파일:줄, 전경, 배경, 테마) 는 한 번만 보고한다.
  const seen = new Set<string>();
  const unique = findings.filter((f) => {
    const key = [
      f.usage.file,
      f.usage.line,
      f.usage.fgToken,
      f.usage.fgAlpha ?? "",
      f.bgLabel,
      f.theme,
    ].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  unique.sort((a, b) => a.ratio - b.ratio);

  console.log("═".repeat(88));
  console.log("대비 감사 (WCAG 2.1) — 라이트 · 다크 양쪽");
  console.log(`토큰 출처: src/app/globals.css · 검사 대상: src/**/*.tsx`);
  console.log("═".repeat(88));
  console.log(
    `수집한 (전경, 배경, 크기) 조합 ${usages.length}건 · 색 토큰 ${colorTokens.size}개 · 타이포 토큰 ${sizeTokens.size}개`,
  );
  console.log("");

  const printRows = (rows: Finding[]): void => {
    if (rows.length === 0) {
      console.log("   (없음)");
      return;
    }
    for (const f of rows) {
      const alpha =
        f.usage.fgAlpha === null ? "" : `/${Math.round(f.usage.fgAlpha * 100)}`;
      const variant = f.usage.fgVariant ? `${f.usage.fgVariant}:` : "";
      console.log(
        `   ${formatRatio(f.ratio).padStart(5)} : 1  (필요 ${f.required})  ` +
          `${variant}text-${f.usage.fgToken}${alpha} ${f.fgHex} / ${f.bgLabel} ${f.bgHex}  ` +
          `${f.sizePx}px ${f.weight}`,
      );
      console.log(
        `           ${f.usage.file}:${f.usage.line}  <${f.usage.owner}>` +
          (f.usage.kind === "detached" ? "  [배경 미확정 — 흔한 면 전부 검사]" : ""),
      );
    }
  };

  // 글자(4.5:1 / 큰 텍스트 3:1) · 장식 아이콘(3:1) · 규격 면제를 나눠 낸다.
  // 섞어 두면 아이콘 수십 건에 밀려 정작 읽어야 할 문장의 미달이 보이지 않는다.
  const exemptRows = unique.filter((f) => f.usage.exempt);
  const textRows = unique.filter((f) => !f.usage.exempt && !f.usage.decorative);
  const iconRows = unique.filter((f) => !f.usage.exempt && f.usage.decorative);

  for (const theme of THEMES) {
    const rows = textRows.filter((f) => f.theme === theme);
    console.log(
      `── [글자] ${theme.toUpperCase()} 미달 ${rows.length}건 ` + "─".repeat(44),
    );
    printRows(rows);
    console.log("");
  }
  for (const theme of THEMES) {
    const rows = iconRows.filter((f) => f.theme === theme);
    console.log(
      `── [장식·아이콘 3:1] ${theme.toUpperCase()} 미달 ${rows.length}건 ` +
        "─".repeat(34),
    );
    printRows(rows);
    console.log("");
  }

  console.log(
    `── [규격 면제] ${exemptRows.length}건 ` + "─".repeat(52),
  );
  console.log(
    "   WCAG 1.4.3 은 비활성 컨트롤 텍스트를, 1.4.11 은 장식 그래픽을 제외한다.",
  );
  console.log(
    "   §4 는 `ink-placeholder` 를 자리표시자·장식 아이콘·비활성 어포던스 전용으로 규정한다.",
  );
  console.log("   면제라도 숨기지 않고 세어 둔다 — 용도가 바뀌면 다시 판정해야 한다.");
  printRows(exemptRows);
  console.log("");

  // 14px 미만 문장 규칙 (§4)
  const smallish = smallSentences
    .map((s) => ({ ...s, px: tokens.typography.get(s.sizeToken)?.minPx ?? 0 }))
    .filter((s) => s.px > 0 && s.px < 14 && isSentence(s.sample));
  console.log(
    `── 14px 미만인데 문장으로 보이는 곳 ${smallish.length}건 ` + "─".repeat(30),
  );
  if (smallish.length === 0) console.log("   (없음)");
  for (const s of smallish) {
    console.log(
      `   ${s.px}px text-${s.sizeToken}  ${s.file}:${s.line} <${s.owner}>  "${s.sample}"`,
    );
  }
  console.log("");

  const manualDedup = [...new Map(manual.map((m) => [`${m.file}:${m.line}:${m.detail}`, m])).values()];
  console.log(`── 수동 확인 필요 ${manualDedup.length + unresolvedTokens.size}건 ` + "─".repeat(42));
  if (manualDedup.length === 0 && unresolvedTokens.size === 0) {
    console.log("   (없음)");
  }
  for (const m of manualDedup) {
    console.log(`   ${m.file}:${m.line}  ${m.reason} — ${m.detail}`);
    }
  for (const t of unresolvedTokens) {
    console.log(`   토큰 값을 해석하지 못함: ${t}`);
  }
  console.log("");

  const count = (rows: Finding[], theme: ThemeName): number =>
    rows.filter((f) => f.theme === theme).length;
  console.log("═".repeat(88));
  console.log(
    `결과 · 글자      라이트 ${count(textRows, "light")}건 · 다크 ${count(textRows, "dark")}건 미달`,
  );
  console.log(
    `결과 · 장식아이콘 라이트 ${count(iconRows, "light")}건 · 다크 ${count(iconRows, "dark")}건 미달`,
  );
  console.log(`규격 면제: ${exemptRows.length}건 (위 목록 참조 — 실패로 세지 않는다)`);
  console.log("═".repeat(88));

  // 게이트는 **글자와 의미 있는 아이콘**만 본다. 면제 항목까지 실패로 세면
  // 이 명령이 늘 빨간불이 되고, 그러면 아무도 보지 않게 된다.
  if (textRows.length + iconRows.length > 0) process.exitCode = 1;
}

/** 배지·숫자 조각이 아니라 "읽으라고 만든 문장"인지 거칠게 가른다. */
function isSentence(sample: string): boolean {
  const t = sample.trim();
  if (t.length < 12) return false;
  // 공백이 둘 이상이면 단어가 여럿 = 문장에 가깝다.
  return (t.match(/\s/g) ?? []).length >= 2;
}

main();
