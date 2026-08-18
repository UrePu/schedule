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

/** 한 말풍선 줄 수 예산. 방이 지저분해지는 것을 막는다. */
export const REPLY_LINE_BUDGET = 12;

/** 구분선. 3~10자 이내로 짧게(가변폭 폰트라 길면 폭이 들쭉날쭉해 보인다). */
export const DIVIDER = "───────────────";

/**
 * 평문 규칙을 강제한다. **모든 답장은 마지막에 이 함수를 통과한다.**
 *
 * - CRLF/CR → LF
 * - 줄 끝 공백 제거(가변폭에서 보이지 않는 어긋남의 원인)
 * - 연속 빈 줄 1줄로 접기
 * - 줄 수 예산 초과 시 잘라내고 `…` 한 줄
 * - 글자 예산 초과 시 잘라내고 `…`
 */
export function toPlaintext(raw: string): string {
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
    lines.length > REPLY_LINE_BUDGET
      ? [...lines.slice(0, REPLY_LINE_BUDGET - 1), "…"]
      : lines;

  const joined = clippedLines.join("\n");
  if (joined.length <= REPLY_CHAR_BUDGET) return joined;
  return `${joined.slice(0, REPLY_CHAR_BUDGET - 1).replace(/\s+$/, "")}…`;
}

/** 줄 배열 → 평문 한 덩이. `null` 줄은 조건부 줄을 지우는 용도로 허용한다. */
export function lines(...parts: readonly (string | null | undefined)[]): string {
  return toPlaintext(parts.filter((part): part is string => typeof part === "string").join("\n"));
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
