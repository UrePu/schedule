/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 카카오톡 **평문** 출력 규칙 — 여기가 유일한 소유자
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 봇의 답장은 그냥 채팅 메시지다. 따라서 (research-KAKAO-BOT §1.4):
 *
 * | 제약 | 규칙 |
 * |---|---|
 * | 마크다운·HTML 미지원 | `**굵게**` · `#제목` · `\|표\|` 가 리터럴로 그대로 보인다. **쓰지 않는다.** |
 * | 가변폭 폰트 | 공백으로 열을 맞춘 표는 반드시 어긋난다. **공백 패딩 정렬 금지.** |
 * | 줄바꿈 | `\n` 만. 연속 빈 줄은 **1줄까지**로 접는다. |
 * | 길이 | 500자를 넘으면 카톡이 '전체보기'로 접는다 → **350자 · 12줄 예산.** |
 * | 이모지 | 상태 인코딩에 쓰되 줄당 1~2개. |
 *
 * ★ **임박은 빨강이 아니라 주황이다**(CLAUDE.md §4). 평문에는 색이 없으므로 `⏰` 를
 *   쓰고, 🔴 계열은 실패·취소에만 남긴다.
 *
 * ★ **동일 응답 연속 전송 방어가 서버에 있는 이유**: 여러 런너가 "직전과 같은 내용"의
 *   연속 전송을 도배로 보고 막는다. 런너 설정으로 끌 수도 있지만, **서버 쪽 방어를
 *   기본으로 둬야 런너가 바뀌어도 안전하다.** `differentiate()` 가 그 자리다.
 */

import { formatKst } from "@/lib/time/week";

/** 한 말풍선 예산. 넘으면 잘라내고 뒤를 `…` 로 접는다. */
export const REPLY_CHAR_BUDGET = 350;

/**
 * 한 말풍선 줄 수 예산.
 *
 * 12 → 20 (2026-08-19). 12 는 우리가 보수적으로 잡은 값이었고 **카카오의 실제 제약이
 * 아니다** — 접힘 기준은 글자 수(약 500자, research-KAKAO-BOT §1.4)이고 우리는 거기에
 * 350자로 여유를 두고 있다. 발주자가 보스 줄을 두 줄로 나누고 사이에 빈 줄을 넣는
 * 레이아웃을 지정하면서 12줄로는 4보스 한 묶음도 못 담게 되어 올렸다.
 *
 * ⚠️ 글자 예산은 그대로다. 20줄이라도 350자를 넘으면 잘린다 — 실제로 먼저 걸리는 쪽은
 *    여전히 글자 수이고, 그게 맞는 방어선이다.
 */
export const REPLY_LINE_BUDGET = 20;

/** 구분선. 3~10자 이내로 짧게(가변폭 폰트라 길면 폭이 들쭉날쭉해 보인다). */
export const DIVIDER = "───────────────";

/*
  묶음 안쪽 구분선(`···············`)은 **뺐다**(2026-08-19). 글꼴에 따라 따옴표 여러 개로
  보여 발주자가 지적했고, 묶음 사이 빈 줄만으로도 경계는 충분히 읽힌다. 구분선은 답장의
  바깥 테두리(`DIVIDER`) 하나로 족하다.
*/

/**
 * 평문 규칙을 강제한다. **모든 답장은 마지막에 이 함수를 통과한다.**
 *
 * - CRLF/CR → LF
 * - 줄 끝 공백 제거(가변폭에서 보이지 않는 어긋남의 원인)
 * - 연속 빈 줄 1줄로 접기
 * - 줄 수 예산 초과 시 잘라내고 `…` 한 줄
 * - 글자 예산 초과 시 잘라내고 `…`
 */
export interface ReplyBudget {
  readonly chars: number;
  readonly lines: number;
}

/** 평소 예산. 위 표의 근거 그대로다. */
export const DEFAULT_REPLY_BUDGET: ReplyBudget = {
  chars: REPLY_CHAR_BUDGET,
  lines: REPLY_LINE_BUDGET,
};

/**
 * **사용자가 길이를 직접 요구한 답장** 전용 예산 (2026-09-02).
 *
 * 발주 지시: *"접히든가 말던가 1개로 보내고"*. `!결정석 20` 처럼 사람이 개수를 적어 부른
 * 목록은 350자에 들어가지 않는다. 지금까지의 답은 **말풍선을 나누는 것**이었는데, 열 줄이
 * 9 + 1 로 갈리는 모양이 나오면서 발주자가 한 덩이를 택했다.
 *
 * ★ 접히는 것은 **잘리는 것이 아니다.** 카톡은 500자쯤에서 '전체보기'로 접을 뿐 내용은
 *   그대로 있고, 펼치면 전부 보인다. 반대로 `…` 로 잘리면 그 줄들은 영영 사라진다.
 *   둘 중 하나를 골라야 한다면 접히는 쪽이 언제나 낫다.
 * ★ 그래도 상한을 둔다. 30건 × 25자 + 머리말 ≈ 850자라 1,200자면 잘릴 일이 없고,
 *   무한대로 두면 언젠가 방에 소설이 올라간다.
 * ★ **평소 답장에는 쓰지 않는다.** 부르지 않은 길이를 내미는 것은 그냥 도배다.
 */
export const LONG_REPLY_BUDGET: ReplyBudget = { chars: 1200, lines: 40 };

export function toPlaintext(
  raw: string,
  budget: ReplyBudget = DEFAULT_REPLY_BUDGET,
): string {
  const normalized = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");

  const lines = normalized.split("\n");
  const clippedLines =
    lines.length > budget.lines
      ? [...lines.slice(0, budget.lines - 1), "…"]
      : lines;

  const joined = clippedLines.join("\n");
  if (joined.length <= budget.chars) return joined;
  return `${joined.slice(0, budget.chars - 1).replace(/\s+$/, "")}…`;
}

/** `null` 을 걸러 낸 원문. 예산 적용 **전** 단계라 예산이 다른 조립기들이 함께 쓴다. */
function joinParts(parts: readonly (string | null | undefined)[]): string {
  return parts
    .filter((part): part is string => typeof part === "string")
    .join("\n");
}

/** 줄 배열 → 평문 한 덩이. `null` 줄은 조건부 줄을 지우는 용도로 허용한다. */
export function lines(...parts: readonly (string | null | undefined)[]): string {
  return toPlaintext(joinParts(parts));
}

/**
 * 제목 + 구분선 + 본문. 우리 답장의 기본 골격이다.
 *
 * 제목에 이모지 1개까지, 본문 줄에도 1~2개까지. 그 이상은 방에서 시끄럽다.
 */
export function block(
  title: string,
  body: readonly (string | null | undefined)[],
): string {
  return lines(title, DIVIDER, ...body);
}

/**
 * `lines` 와 같되 **긴 예산**을 쓴다(`LONG_REPLY_BUDGET`).
 *
 * ★ `block` 처럼 제목 밑에 구분선을 **자동으로 넣지 않는다.** 목록 답장에서는 제목 바로
 *   아래 줄이 이미 요약(`남은 31건 · …`)이라 그 사이의 선이 자리만 먹는다
 *   (발주 지시 2026-09-02: *"맨위에 ------------ 한줄 없애고"*). 구분선이 필요하면
 *   부르는 쪽이 원하는 자리에 `DIVIDER` 를 직접 넣는다.
 * ⚠️ 이걸 쓴 답장은 `CommandOutcome.long` 도 함께 켜야 한다. 라우트가 마지막에 한 번 더
 *    `toPlaintext` 를 통과시키므로(평문 규칙은 한 곳에서 강제한다), 거기서 기본 예산이
 *    적용되면 여기서 늘려 둔 것이 도로 잘린다.
 */
export function longLines(
  ...parts: readonly (string | null | undefined)[]
): string {
  return toPlaintext(joinParts(parts), LONG_REPLY_BUDGET);
}

/**
 * 목록을 예산 안으로 접는다. `…외 N건` 은 **잘라냈다는 사실을 숨기지 않기 위한 것**이다.
 * 조용히 3건만 보여 주면 사용자는 그게 전부라고 믿는다.
 */
export function clipList(
  items: readonly string[],
  max: number,
): readonly string[] {
  if (items.length <= max) return items;
  return [...items.slice(0, max), `…외 ${String(items.length - max)}건`];
}

/**
 * **직전과 똑같은 답장이 되지 않게** 끝에 시각 조각을 붙인다.
 *
 * 런너의 도배 방지에 막히면 사용자 눈에는 "봇이 죽었다"로 보인다. 붙이는 것은 시각
 * 한 조각(`· 21:04`)뿐이라 내용이 바뀌지 않고, 붙일 필요가 없으면 원문 그대로 둔다.
 */
export function differentiate(
  reply: string,
  previousDigest: string | null,
  digestOf: (value: string) => string,
  now: Date,
): string {
  if (previousDigest === null) return reply;
  if (digestOf(reply) !== previousDigest) return reply;
  return toPlaintext(`${reply}\n· ${formatKst(now, "HH:mm")}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 공용 문구 — 여러 명령이 같은 상황을 만나므로 한 곳에 둔다
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 미연결 발신자 안내.
 *
 * ★ 닉네임은 키가 아니다(§2.3). 연결 전에는 "누구인지" 자체를 우리가 모르므로,
 *   추측해서 답하지 않고 **연결로 가는 길**만 말한다.
 */
export function needsLinkReply(): string {
  return lines(
    "🔒 먼저 계정을 연결해 주세요.",
    "웹에서 연결 코드를 받아 아래처럼 입력하면 됩니다.",
    "!연결 A7K2Q9",
  );
}

/** 내부 사정은 절대 말하지 않는다. 사용자가 할 수 있는 일만 말한다. */
export function genericFailureReply(): string {
  return "⚠️ 잠시 문제가 생겼어요. 곧 다시 시도해 주세요.";
}
