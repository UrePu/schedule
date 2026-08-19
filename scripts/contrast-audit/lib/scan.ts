/**
 * 저장소를 훑어 **실제로 화면에서 만나는** (전경색, 배경색, 글자크기) 조합을 모은다.
 *
 * ★ 왜 데카르트 곱이 아닌가 (CLAUDE.md §4 가독성 규칙)
 *   토큰 × 토큰 전부를 계산하면 존재하지도 않는 조합 수백 개가 나와 진짜 미달이 묻힌다.
 *   반대로 "토큰 표만 보고" 판정하면 `hover-surface` 위 11px 처럼 **실제로 렌더되는 쌍**을
 *   놓친다. 그래서 JSX 트리를 실제로 걸어 **조상의 배경**을 물려받으며 짝을 짓는다.
 *
 * 두 종류의 조합을 낸다.
 *
 *  A. `jsx` — JSX 트리에서 배경 조상이 확정된 조합. 가장 신뢰도가 높다.
 *  B. `detached` — 변형 맵(`const TONE_CLASS = { accent: "text-secondary" }`)처럼
 *     JSX 밖 문자열에 있는 전경색. 이런 클래스는 **호출부가 정하는 면 위에 얹힌다.**
 *     `src/components/**` 의 디자인 시스템 컴포넌트는 앱 어디에나 놓이므로,
 *     "흔한 면" 전부에 대해 검사한다. (MesoAmount 의 `accent` 가 정확히 이 경우다.)
 *
 * 한계는 숨기지 않는다. 해석할 수 없는 배경(임의값·그라디언트·미등록 컴포넌트)은
 * `manual` 목록으로 **따로 출력**한다 — 조용히 건너뛰지 않는다.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";

export interface ClassContext {
  /** 이 요소가 놓인 배경 후보들. `hover:` 로 바뀌는 면도 후보에 들어간다. */
  backgrounds: BackgroundLayer[];
  sizeToken: string;
  /** 명시적 `font-*` 로 덮어썼을 때만 값이 있다. 없으면 크기 토큰의 기본 굵기. */
  weightOverride: number | null;
  /**
   * 같은 부모 아래 형제 중 배경을 칠하는 요소가 있는가.
   * 절대 위치 요소가 그 형제 **위에** 놓일 수 있어, 조상 면으로 계산하면 틀린다.
   */
  siblingDeclaresBg: boolean;
}

/**
 * 조건 분기 기록 — `조건식 원문 → 어느 갈래를 탔는가`.
 *
 * ★ 이게 없으면 **부모의 분기와 자식의 분기가 서로 엮여** 유령 조합이 생긴다.
 *   실제 사례(`run-composer.tsx`):
 *     부모 `<label>` : checked ? "bg-primary-subtle" : "hover:bg-hover-strong"
 *     자식 `<span>`  : checked ? "text-primary"      : "text-ink"
 *   두 분기는 **같은 변수**가 지배하므로 `text-primary` 는 `hover-strong` 위에
 *   절대 오지 않는다. 그런데 조건을 기억하지 않으면 4.27:1 짜리 없는 미달이 보고된다.
 *   조건식의 **소스 텍스트**를 키로 삼아 같은 조건은 같은 값으로 묶는다.
 */
export type Guard = ReadonlyMap<string, boolean>;

/** 두 분기 기록이 양립하는가 — 같은 조건에 서로 다른 값이 있으면 불가능한 조합이다. */
export function guardsCompatible(a: Guard, b: Guard): boolean {
  for (const [k, v] of a) {
    const other = b.get(k);
    if (other !== undefined && other !== v) return false;
  }
  return true;
}

function mergeGuards(a: Guard, b: Guard): Guard | null {
  if (!guardsCompatible(a, b)) return null;
  const out = new Map(a);
  for (const [k, v] of b) out.set(k, v);
  return out;
}

export interface BackgroundLayer {
  /** 아래에서 위 순서로 쌓인 면. 반투명 면을 정확히 합성하기 위해 스택으로 둔다. */
  stack: { token: string; alpha: number | null }[];
  /** `hover:` 등 변형으로만 나타나는 면인지. 보고에서 구분해 표시한다. */
  variant: string | null;
  /** 이 면이 나타나기 위해 성립해야 하는 조건들. */
  guards: Guard;
}

export interface FgUsage {
  kind: "jsx" | "detached";
  file: string;
  line: number;
  fgToken: string;
  fgAlpha: number | null;
  /** 변형 접두사(`hover:` `disabled:` …). 없으면 null. */
  fgVariant: string | null;
  context: ClassContext;
  /** JSX 요소 이름 또는 문자열이 속한 심볼 이름 — 보고에서 위치를 알려준다. */
  owner: string;
  /**
   * 장식 요소인가 — 아이콘 컴포넌트이거나 `aria-hidden` 이 붙은 것.
   * §4 가 `ink-placeholder` 를 "장식 아이콘·비활성 어포던스 전용"으로 허용하므로,
   * 이 둘은 본문 4.5:1 이 아니라 UI 경계 기준 3:1 을 받는다.
   */
  decorative: boolean;
  /**
   * WCAG / §4 가 **명시적으로 면제한** 자리인가.
   *  - `disabled:` — WCAG 1.4.3 은 비활성 컨트롤의 텍스트를 대비 요건에서 제외한다.
   *  - `placeholder:` — §4 가 `ink-placeholder` 를 "입력 자리표시자 전용"으로 규정한다.
   * 면제라고 해서 지우지는 않는다. **따로 세어 보여 준다** — 숨기면 다음 사람이
   * 같은 계산을 처음부터 다시 하게 된다.
   */
  exempt: boolean;
}

export interface ManualNote {
  file: string;
  line: number;
  reason: string;
  detail: string;
}

export interface SmallSentenceNote {
  file: string;
  line: number;
  sizeToken: string;
  px: number;
  owner: string;
  /** 그 요소에 들어 있던 클래스 원문(판단 근거). */
  classes: string;
  /** 그 요소 안의 실제 문구 표본 — "문장인가 배지인가"를 사람이 판단할 근거. */
  sample: string;
}

export interface ScanResult {
  usages: FgUsage[];
  manual: ManualNote[];
}

/**
 * 알려진 컴포넌트가 자식에게 물려주는 배경.
 * 값은 각 컴포넌트 소스의 루트 `bg-*` 와 일치해야 한다 — 어긋나면 여기를 고친다.
 */
export const COMPONENT_BACKGROUND: Record<string, string> = {
  Card: "surface",
  CardHeader: "surface",
  CardBody: "surface",
  CardFooter: "surface",
  Dialog: "surface",
  DialogHeader: "surface",
  DialogBody: "surface",
  DialogFooter: "surface",
  EmptyState: "surface",
  ErrorState: "chip-failed-bg",
  Tooltip: "ink",
  Skeleton: "neutral-200",
};

/** 문서 최하단 면. `body { background: var(--color-background) }` 와 같아야 한다. */
export const ROOT_BACKGROUND = "background";

const VARIANT_PREFIX = /^([a-z0-9-]+(?::[a-z0-9-]+)*):(?=(?:bg|text|font)-)/;

/** `disabled:` · `placeholder:` 변형은 대비 요건에서 면제된다(FgUsage.exempt 주석 참조). */
function isExemptVariant(variant: string | null): boolean {
  if (!variant) return false;
  return /(^|:)(disabled|placeholder)(:|$)/.test(variant);
}

/**
 * 이 쓰임이 규격 면제인가.
 *
 * 변형 면제에 더해, **순수 장식 아이콘의 `ink-placeholder`** 도 면제다.
 * §4 가 이 토큰을 "입력 자리표시자·**장식 아이콘**·비활성 어포던스 전용"으로
 * 명시했고, WCAG 1.4.11 은 내용 이해에 필요하지 않은 장식 그래픽을 대상에서
 * 제외한다. 빈 상태 삽화·검색 아이콘이 여기 해당한다.
 * **의미를 지는 아이콘**(경고 삼각형 등)은 이 토큰을 쓰지 않으므로 여기 걸리지 않는다.
 */
function isExemptUsage(
  variant: string | null,
  token: string,
  decorative: boolean,
): boolean {
  return (
    isExemptVariant(variant) || (decorative && token === "ink-placeholder")
  );
}

const WEIGHT_CLASS: Record<string, number> = {
  "font-normal": 400,
  "font-medium": 500,
  "font-semibold": 600,
  "font-bold": 700,
  "font-extrabold": 800,
};

export interface ClassBits {
  bg: { token: string; alpha: number | null; variant: string | null }[];
  fg: { token: string; alpha: number | null; variant: string | null }[];
  size: string | null;
  weight: number | null;
  /** 해석 실패한 색 관련 클래스(임의값·그라디언트 등). */
  unresolved: string[];
  raw: string[];
}

/**
 * 클래스 문자열 묶음에서 색·크기 정보를 뽑는다.
 * `colorTokens` / `sizeTokens` 는 globals.css 에서 온 실제 토큰 이름 집합이다 —
 * `text-primary`(색)와 `text-caption`(크기)를 이걸로 갈라낸다.
 */
export function parseClasses(
  classes: string[],
  colorTokens: Set<string>,
  sizeTokens: Set<string>,
): ClassBits {
  const bits: ClassBits = {
    bg: [],
    fg: [],
    size: null,
    weight: null,
    unresolved: [],
    raw: classes,
  };

  for (const rawClass of classes) {
    let cls = rawClass;
    let variant: string | null = null;
    const vm = VARIANT_PREFIX.exec(cls);
    if (vm) {
      variant = vm[1];
      cls = cls.slice(vm[0].length);
    }

    if (cls in WEIGHT_CLASS && variant === null) {
      bits.weight = WEIGHT_CLASS[cls];
      continue;
    }

    const isBg = cls.startsWith("bg-");
    const isText = cls.startsWith("text-");
    if (!isBg && !isText) continue;

    const body = cls.slice(isBg ? 3 : 5);
    // Tailwind 불투명도 수식어: `ink/50`, `primary/25`.
    const slash = body.lastIndexOf("/");
    const token = slash === -1 ? body : body.slice(0, slash);
    const alphaRaw = slash === -1 ? null : body.slice(slash + 1);
    const alpha =
      alphaRaw === null ? null : Number.parseFloat(alphaRaw) / 100;

    if (isText && slash === -1 && sizeTokens.has(token)) {
      if (variant === null) bits.size = token;
      continue;
    }

    if (token.startsWith("[") || token.includes("(")) {
      bits.unresolved.push(rawClass);
      continue;
    }
    if (!colorTokens.has(token)) {
      // `bg-transparent` `text-current` `bg-clip-text` 같은 비토큰 유틸리티.
      if (isBg && (token === "transparent" || token === "current")) {
        continue;
      }
      if (
        isBg &&
        /^(gradient|clip|origin|repeat|size|position|no|cover|contain|center|fixed|local|scroll|top|bottom|left|right|blend|linear|radial|conic)/.test(
          token,
        )
      ) {
        bits.unresolved.push(rawClass);
        continue;
      }
      if (
        isText &&
        /^(left|right|center|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|current|inherit|transparent)$/.test(
          token,
        )
      ) {
        continue;
      }
      bits.unresolved.push(rawClass);
      continue;
    }

    if (isBg) bits.bg.push({ token, alpha, variant });
    else bits.fg.push({ token, alpha, variant });
  }

  return bits;
}

function splitClassString(value: string): string[] {
  return value.split(/\s+/).filter(Boolean);
}

const MAX_ALTERNATIVES = 64;

/**
 * `className` 식을 **서로 배타적인 클래스 조합들**로 펼친다.
 *
 * ★ 이게 없으면 조건부 분기가 섞여 존재하지 않는 쌍이 만들어진다. 실제로 있었던 예:
 *   `cn(selected ? "bg-primary text-surface" : "bg-surface text-ink-label")`
 *   → 문자열을 전부 합치면 `text-surface / bg-surface`(1.0:1) 라는 유령 조합이 나온다.
 *   화면에는 절대 나타나지 않는 조합이고, 이런 게 쌓이면 진짜 미달이 묻힌다.
 *
 * 삼항·`&&`·객체 리터럴을 분기로 보고 데카르트 곱을 만든다. 조합 수가 폭발하면
 * (`MAX_ALTERNATIVES` 초과) 전부 합친 하나로 되돌린다 — 그때는 유령 조합이 생길 수
 * 있으므로 보수적으로 넘어가는 쪽이다.
 */
export interface Alternative {
  classes: string[];
  guards: Guard;
}

function expandClassAlternatives(node: ts.Node): Alternative[] {
  const EMPTY: Alternative[] = [{ classes: [], guards: new Map() }];

  const combine = (a: Alternative[], b: Alternative[]): Alternative[] => {
    const out: Alternative[] = [];
    for (const x of a) {
      for (const y of b) {
        const guards = mergeGuards(x.guards, y.guards);
        if (!guards) continue; // 서로 모순되는 분기 — 화면에 나타날 수 없다
        out.push({ classes: [...x.classes, ...y.classes], guards });
      }
    }
    return out.length > MAX_ALTERNATIVES ? [flatten(out)] : out;
  };
  const union = (a: Alternative[], b: Alternative[]): Alternative[] => {
    const out = [...a, ...b];
    return out.length > MAX_ALTERNATIVES ? [flatten(out)] : out;
  };
  const flatten = (alts: Alternative[]): Alternative => ({
    classes: alts.flatMap((x) => x.classes),
    guards: new Map(),
  });
  const literal = (text: string): Alternative[] => [
    { classes: text.split(/\s+/).filter(Boolean), guards: new Map() },
  ];
  const guarded = (
    alts: Alternative[],
    cond: NormalizedCondition,
    value: boolean,
  ): Alternative[] =>
    alts.flatMap((alt) => {
      const actual = cond.negated ? !value : value;
      const guards = mergeGuards(alt.guards, new Map([[cond.key, actual]]));
      return guards ? [{ classes: alt.classes, guards }] : [];
    });

  const walk = (n: ts.Node): Alternative[] => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      return literal(n.text);
    }
    if (ts.isTemplateExpression(n)) {
      let acc = literal(n.head.text);
      for (const span of n.templateSpans) {
        acc = combine(acc, walk(span.expression));
        acc = combine(acc, literal(span.literal.text));
      }
      return acc;
    }
    if (ts.isJsxExpression(n) || ts.isParenthesizedExpression(n)) {
      return n.expression ? walk(n.expression) : EMPTY;
    }
    if (ts.isConditionalExpression(n)) {
      const cond = normalizeCondition(n.condition);
      return union(
        guarded(walk(n.whenTrue), cond, true),
        guarded(walk(n.whenFalse), cond, false),
      );
    }
    if (ts.isBinaryExpression(n)) {
      const op = n.operatorToken.kind;
      if (
        op === ts.SyntaxKind.AmpersandAmpersandToken ||
        op === ts.SyntaxKind.QuestionQuestionToken ||
        op === ts.SyntaxKind.BarBarToken
      ) {
        // 조건이 거짓이면 아무 클래스도 붙지 않는다 → 빈 조합도 후보다.
        const cond = normalizeCondition(n.left);
        return union(
          guarded(walk(n.right), cond, true),
          guarded(EMPTY, cond, false),
        );
      }
      if (op === ts.SyntaxKind.PlusToken) {
        return combine(walk(n.left), walk(n.right));
      }
      return EMPTY;
    }
    if (ts.isCallExpression(n)) {
      // `cn(a, b, c)` — 인자들은 함께 붙는다.
      let acc: Alternative[] = EMPTY;
      for (const arg of n.arguments) acc = combine(acc, walk(arg));
      return acc;
    }
    if (ts.isArrayLiteralExpression(n)) {
      let acc: Alternative[] = EMPTY;
      for (const el of n.elements) acc = combine(acc, walk(el));
      return acc;
    }
    if (ts.isObjectLiteralExpression(n)) {
      // clsx 스타일 `{ "text-error": invalid }` — 키가 클래스이고 켜질 수도 꺼질 수도 있다.
      let acc: Alternative[] = EMPTY;
      for (const p of n.properties) {
        if (ts.isPropertyAssignment(p)) {
          const key = ts.isStringLiteralLike(p.name)
            ? p.name.text
            : p.name.getText();
          const cond = normalizeCondition(p.initializer);
          acc = combine(
            acc,
            union(guarded(literal(key), cond, true), guarded(EMPTY, cond, false)),
          );
        }
      }
      return acc;
    }
    // 식별자·프로퍼티 접근(`TONE_CLASS[tone]`)은 값을 알 수 없다.
    // 그 문자열들은 detached 경로가 따로 검사한다.
    return EMPTY;
  };

  return walk(node);
}

interface NormalizedCondition {
  key: string;
  negated: boolean;
}

/**
 * 조건식을 키로 정규화한다. `!x` 는 `x` 의 반대이므로 **부정을 벗겨 같은 키로 모은다**
 * — 그래야 `checked ? A : B` 와 `!checked && C` 가 서로 엮인다.
 * 부정 여부는 값(true/false)을 뒤집어 표현한다.
 */
function normalizeCondition(node: ts.Node): NormalizedCondition {
  let n = node;
  let negations = 0;
  while (
    ts.isPrefixUnaryExpression(n) &&
    n.operator === ts.SyntaxKind.ExclamationToken
  ) {
    n = n.operand;
    negations += 1;
  }
  return {
    key: n.getText().replace(/\s+/g, " "),
    negated: negations % 2 === 1,
  };
}

/**
 * 이 요소가 **아이콘만** 담고 있는가 — 읽을 문구가 하나도 없는가.
 *
 * `<span className="text-tertiary"><TriangleAlert aria-hidden/><span class="sr-only">…</span></span>`
 * 같은 모양이 실제로 있다. 색은 아이콘이 지고 있으므로 본문 4.5:1 이 아니라
 * UI 경계 3:1 을 받아야 하는데, 요소 이름만 보면 `<span>` 이라 글자로 오판한다.
 */
function holdsOnlyIcons(node: ts.Node, iconNames: ReadonlySet<string>): boolean {
  let sawIcon = false;
  let sawText = false;
  const walk = (n: ts.Node): void => {
    if (sawText) return;
    if (ts.isJsxText(n)) {
      if (n.text.trim()) sawText = true;
      return;
    }
    if (ts.isJsxExpression(n)) {
      // `{value}` 는 무엇이 나올지 알 수 없다 → 글자로 본다(보수적).
      if (n.expression) sawText = true;
      return;
    }
    const open = ts.isJsxElement(n)
      ? n.openingElement
      : ts.isJsxSelfClosingElement(n)
        ? n
        : null;
    if (open) {
      const name = elementName(open);
      const attr = findClassNameAttr(open.attributes);
      const srOnly =
        attr?.initializer !== undefined &&
        /\bsr-only\b/.test(attr.initializer.getText());
      if (srOnly) return; // 화면에 보이지 않는다
      if (iconNames.has(name)) {
        sawIcon = true;
        return;
      }
    }
    n.forEachChild(walk);
  };
  node.forEachChild(walk);
  return sawIcon && !sawText;
}

/** JSX 요소 안의 눈에 보이는 문구를 모은다 — 배지인지 문장인지 사람이 판단할 표본. */
function collectVisibleText(node: ts.Node): string {
  const parts: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isJsxText(n)) {
      const t = n.text.trim();
      if (t) parts.push(t);
      return;
    }
    if (ts.isJsxAttribute(n)) return; // className·title 등 속성은 화면 문구가 아니다
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      const t = n.text.trim();
      // 클래스 문자열이 문구로 섞이지 않게 거른다.
      if (t && !/(^|\s)(bg|text|flex|px|py|gap|rounded)-/.test(t)) parts.push(t);
      return;
    }
    n.forEachChild(walk);
  };
  node.forEachChild(walk);
  return parts.join(" ").slice(0, 80);
}

/** 직계 JSX 자식들 중 배경을 칠하는 요소가 있는지 - 절대 위치 겹침 판정에 쓴다. */
function childrenDeclareBg(
  node: ts.Node,
  colorTokens: Set<string>,
  sizeTokens: Set<string>,
): boolean {
  let found = false;
  // `{cond ? <div className="bg-x"/> : null}` 처럼 감싼 식 안에 있는 형제도 세야 한다.
  // 그래서 JSX 요소를 만날 때까지만 내려간다 — 손자까지 들어가지는 않는다.
  const scan = (child: ts.Node): void => {
    if (found) return;
    const open = ts.isJsxElement(child)
      ? child.openingElement
      : ts.isJsxSelfClosingElement(child)
        ? child
        : null;
    if (!open) {
      if (!ts.isJsxText(child)) child.forEachChild(scan);
      return;
    }
    const attr = findClassNameAttr(open.attributes);
    if (!attr?.initializer) return;
    for (const alt of expandClassAlternatives(attr.initializer)) {
      if (parseClasses(alt.classes, colorTokens, sizeTokens).bg.length > 0) {
        found = true;
        return;
      }
    }
  };
  node.forEachChild(scan);
  return found;
}

function elementName(
  node: ts.JsxOpeningElement | ts.JsxSelfClosingElement,
): string {
  return node.tagName.getText();
}

function findClassNameAttr(
  attrs: ts.JsxAttributes,
): ts.JsxAttribute | undefined {
  return attrs.properties.find(
    (p): p is ts.JsxAttribute =>
      ts.isJsxAttribute(p) &&
      ts.isIdentifier(p.name) &&
      (p.name.text === "className" || p.name.text === "class"),
  );
}

function dedupeLayers(layers: BackgroundLayer[]): BackgroundLayer[] {
  const seen = new Set<string>();
  const out: BackgroundLayer[] = [];
  for (const l of layers) {
    const key =
      l.stack.map((s) => `${s.token}/${s.alpha ?? ""}`).join(">") +
      `|${l.variant ?? ""}|` +
      [...l.guards].map(([k, v]) => `${k}=${String(v)}`).join(",");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

function pushLayer(
  base: BackgroundLayer[],
  bg: { token: string; alpha: number | null; variant: string | null },
  guards: Guard,
): BackgroundLayer[] {
  // 불투명 면은 아래를 전부 가린다. 반투명 면만 스택을 쌓는다.
  const inherited = base[0]?.stack ?? [];
  const stack =
    bg.alpha === null || bg.alpha >= 1
      ? [{ token: bg.token, alpha: null }]
      : [...inherited, { token: bg.token, alpha: bg.alpha }];
  const merged = mergeGuards(base[0]?.guards ?? new Map(), guards);
  return [{ stack, variant: bg.variant, guards: merged ?? guards }];
}

export function scanRepo(
  srcDir: string,
  repoRoot: string,
  colorTokens: Set<string>,
  sizeTokens: Set<string>,
): ScanResult & { smallSentences: SmallSentenceNote[] } {
  const usages: FgUsage[] = [];
  const manual: ManualNote[] = [];
  const smallSentences: SmallSentenceNote[] = [];

  for (const file of walkFiles(srcDir)) {
    if (!file.endsWith(".tsx") && !file.endsWith(".ts")) continue;
    const rel = relative(repoRoot, file).split(sep).join("/");
    const text = readFileSync(file, "utf8");
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );

    const lineOf = (node: ts.Node): number =>
      source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

    const seenJsxAttrs = new Set<ts.Node>();

    // lucide-react 에서 가져온 이름은 전부 아이콘이다 — 장식 판정의 근거.
    const iconNames = new Set<string>();
    for (const stmt of source.statements) {
      if (
        !ts.isImportDeclaration(stmt) ||
        !ts.isStringLiteral(stmt.moduleSpecifier) ||
        stmt.moduleSpecifier.text !== "lucide-react"
      ) {
        continue;
      }
      const bindings = stmt.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) iconNames.add(el.name.text);
      }
    }

    const visitJsx = (node: ts.Node, ctx: ClassContext, owner: string): void => {
      let nextCtx = ctx;
      let nextOwner = owner;

      const opening = ts.isJsxElement(node)
        ? node.openingElement
        : ts.isJsxSelfClosingElement(node)
          ? node
          : null;

      if (opening) {
        nextOwner = elementName(opening);
        const attr = findClassNameAttr(opening.attributes);
        let alternatives: { bits: ClassBits; guards: Guard }[] = [];
        if (attr?.initializer) {
          seenJsxAttrs.add(attr);
          alternatives = expandClassAlternatives(attr.initializer).map((alt) => ({
            bits: parseClasses(alt.classes, colorTokens, sizeTokens),
            guards: alt.guards,
          }));
        }

        // 미등록 컴포넌트가 배경을 바꿀 수도 있으나 알 길이 없다 → 물려받은 면을 유지한다.
        const componentBg = COMPONENT_BACKGROUND[nextOwner];
        const inherited: BackgroundLayer[] = componentBg
          ? [
              {
                stack: [{ token: componentBg, alpha: null }],
                variant: null,
                guards: new Map(),
              },
            ]
          : ctx.backgrounds;

        if (alternatives.length > 0) {
          const hidden = opening.attributes.properties.some(
            (p) =>
              ts.isJsxAttribute(p) &&
              ts.isIdentifier(p.name) &&
              p.name.text === "aria-hidden",
          );
          const decorative =
            iconNames.has(nextOwner) ||
            hidden ||
            holdsOnlyIcons(node, iconNames);

          const mergedBackgrounds: BackgroundLayer[] = [];
          let mergedSize: string | null = null;
          let mergedWeight: number | null = null;

          for (const { bits, guards } of alternatives) {
            for (const u of bits.unresolved) {
              manual.push({
                file: rel,
                line: lineOf(opening),
                reason: "해석 불가 색 클래스",
                detail: `<${nextOwner}> ${u}`,
              });
            }

            // 물려받은 면 중 **이 분기와 양립하는 것만** 남긴다 (Guard 주석 참조).
            const compatible = inherited.filter((l) =>
              guardsCompatible(l.guards, guards),
            );
            // 이 분기에서 이 요소가 실제로 앉는 면들.
            const baseBg = bits.bg.find((b) => b.variant === null);
            let here = baseBg
              ? pushLayer(compatible, baseBg, guards)
              : compatible;
            const variantBgs = bits.bg.filter((b) => b.variant !== null);
            if (variantBgs.length > 0) {
              // hover 등으로 바뀌는 면도 **같은 글자가 실제로 놓이는 면**이다.
              here = [
                ...here,
                ...variantBgs.flatMap((b) => pushLayer(here, b, guards)),
              ];
            }
            mergedBackgrounds.push(...here);
            if (bits.size) mergedSize = bits.size;
            if (bits.weight !== null) mergedWeight = bits.weight;

            const size = bits.size ?? ctx.sizeToken;
            const weight =
              bits.weight ?? (bits.size ? null : ctx.weightOverride);
            const localCtx: ClassContext = {
              backgrounds: here,
              sizeToken: size,
              weightOverride: weight,
              siblingDeclaresBg: false,
            };

            if (bits.raw.includes("sr-only")) continue;
            /*
             * 절대 위치 요소는 **형제 위에** 얹힐 수 있다. 체크박스의 체크 표식이
             * 그렇다 - 배경을 지는 것은 조상이 아니라 `peer` 인 <input> 이다.
             * 조상 면으로 계산하면 "흰 글자 / 흰 배경"이라는 없는 미달이 나오므로,
             * 이 경우는 판정하지 않고 **수동 확인 목록으로 넘긴다.**
             */
            if (
              (bits.raw.includes("absolute") || bits.raw.includes("fixed")) &&
              bits.bg.length === 0 &&
              ctx.siblingDeclaresBg
            ) {
              for (const fg of bits.fg) {
                manual.push({
                  file: rel,
                  line: lineOf(opening),
                  reason: "형제 요소 위에 얹힌 절대 위치 - 배경 확정 불가",
                  detail: `<${nextOwner}> text-${fg.token}`,
                });
              }
              continue;
            }
            for (const fg of bits.fg) {
              usages.push({
                kind: "jsx",
                file: rel,
                line: lineOf(opening),
                fgToken: fg.token,
                fgAlpha: fg.alpha,
                fgVariant: fg.variant,
                context: localCtx,
                owner: nextOwner,
                decorative,
                exempt: isExemptUsage(fg.variant, fg.token, decorative),
              });
            }

            if (bits.size) {
              smallSentences.push({
                file: rel,
                line: lineOf(opening),
                sizeToken: bits.size,
                px: 0, // 호출부에서 채운다.
                owner: nextOwner,
                classes: bits.raw.join(" "),
                sample: collectVisibleText(node),
              });
            }
          }

          nextCtx = {
            backgrounds: dedupeLayers(mergedBackgrounds),
            sizeToken: mergedSize ?? ctx.sizeToken,
            weightOverride:
              mergedWeight ?? (mergedSize ? null : ctx.weightOverride),
            siblingDeclaresBg: false,
          };
        } else {
          nextCtx = { ...ctx, backgrounds: inherited, siblingDeclaresBg: false };
        }
      }

      // JSX 요소가 아닌 마디(`{...}` · 삼항)는 형제 관계를 끊지 않는다 — 여기서
      // 플래그를 초기화하면 `{cond ? <Check/> : ...}` 안의 아이콘이 형제 배경을
      // 잃어버린다(체크박스의 체크 표식이 정확히 이 모양이다).
      const ownChildBg = childrenDeclareBg(node, colorTokens, sizeTokens);
      const childCtx: ClassContext = {
        ...nextCtx,
        siblingDeclaresBg: opening
          ? ownChildBg
          : ownChildBg || ctx.siblingDeclaresBg,
      };
      node.forEachChild((child) => visitJsx(child, childCtx, nextOwner));
    };

    const rootCtx: ClassContext = {
      backgrounds: [
        {
          stack: [{ token: ROOT_BACKGROUND, alpha: null }],
          variant: null,
          guards: new Map(),
        },
      ],
      sizeToken: "body",
      weightOverride: null,
      siblingDeclaresBg: false,
    };
    visitJsx(source, rootCtx, "root");

    // B. JSX 밖 문자열 — 변형 맵·헬퍼가 만드는 클래스.
    const visitDetached = (node: ts.Node, owner: string): void => {
      let nextOwner = owner;
      if (
        (ts.isVariableDeclaration(node) || ts.isPropertyAssignment(node)) &&
        node.name
      ) {
        nextOwner = node.name.getText();
      }
      if (
        (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
        /(^|\s)(bg|text)-/.test(node.text)
      ) {
        let insideJsxAttr = false;
        for (let p: ts.Node | undefined = node; p; p = p.parent) {
          if (seenJsxAttrs.has(p)) {
            insideJsxAttr = true;
            break;
          }
        }
        if (!insideJsxAttr) {
          const bits = parseClasses(
            splitClassString(node.text),
            colorTokens,
            sizeTokens,
          );
          for (const fg of bits.fg) {
            const localBg = bits.bg.find((b) => b.variant === null);
            usages.push({
              kind: localBg ? "jsx" : "detached",
              file: rel,
              line: lineOf(node),
              fgToken: fg.token,
              fgAlpha: fg.alpha,
              fgVariant: fg.variant,
              context: {
                // 같은 문자열이 배경도 정하면 그 면이 확정이다(칩·배지가 이 형태).
                backgrounds: localBg
                  ? pushLayer(
                      [
                        {
                          stack: [{ token: ROOT_BACKGROUND, alpha: null }],
                          variant: null,
                          guards: new Map(),
                        },
                      ],
                      localBg,
                      new Map(),
                    )
                  : [],
                sizeToken: bits.size ?? "body",
                weightOverride: bits.weight,
                siblingDeclaresBg: false,
              },
              owner: nextOwner,
              decorative: false,
              exempt: isExemptUsage(fg.variant, fg.token, false),
            });
          }
          for (const u of bits.unresolved) {
            manual.push({
              file: rel,
              line: lineOf(node),
              reason: "해석 불가 색 클래스",
              detail: `${nextOwner}: ${u}`,
            });
          }
          if (bits.size) {
            smallSentences.push({
              file: rel,
              line: lineOf(node),
              sizeToken: bits.size,
              px: 0,
              owner: nextOwner,
              classes: node.text,
              sample: "",
            });
          }
        }
      }
      node.forEachChild((child) => visitDetached(child, nextOwner));
    };
    visitDetached(source, "module");
  }

  return { usages, manual, smallSentences };
}

function* walkFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walkFiles(full);
    } else {
      yield full;
    }
  }
}
