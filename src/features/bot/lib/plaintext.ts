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
 * ═════════════════════════════════════════════════════════════════════════════
 * **번호를 가리지 않고** 목록을 말풍선에 나눠 담는다 (2026-10-16)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `clipList` 는 "다 보여 줄 수 없다"를 **정직하게** 처리하는 수단이다 — 그런데 줄 번호가
 * **명령의 인자**일 때는 정직만으로 부족하다. `!파티` 의 N 번은 `!보스 19시20분 N` 의 N
 * 이고, 잘린 뒤의 파티는 **번호가 화면에 없을 뿐 멀쩡히 잡힌다.** 그래서 사용자는 있는
 * 줄도 모르고 웹으로 간다(실측: 파티 17개인 계정에서 5개가 그 상태였다).
 *
 * 그 자리에서는 **자르는 대신 나눈다.** 이 함수가 하는 일은 그것뿐이다:
 *   ① 첫 풍선에 `head` + 들어가는 만큼의 `items` + `tail`
 *   ② 남으면 `continuationHead` 를 머리로 둔 풍선을 더 만들어 `extra` 로 돌려준다
 *
 * ★ **번호는 포장 전에 이미 박혀 있다.** 부르는 쪽이 `items` 에 `"3. …"` 까지 만들어
 *   넘기므로, 몇 개로 갈리든 **같은 파티가 같은 번호**다. 번호를 여기서 세지 않는 이유가
 *   그것이다 — 포장이 번호를 만들면 풍선 경계가 번호를 바꿀 수 있다.
 *
 * ★ **두 예산이 다른 것은 라우트가 그렇게 돌리기 때문이다**(`api/bot/command/route.ts`):
 *   `reply` 는 `long` 플래그에 따라 `LONG_REPLY_BUDGET` 으로 한 번 더 통과하고,
 *   `extra` 의 각 조각은 **항상 기본 예산**으로 통과한다. 여기서 그보다 크게 담으면
 *   거기서 `…` 로 잘린다 — 하필 번호가 잘려 나간다. 그래서 첫 풍선은 긴 예산,
 *   이어지는 풍선은 기본 예산으로 센다.
 *   ⚠️ 이 함수를 쓴 답장은 **`long: true` 를 함께 켜야 한다.** 끄면 첫 풍선이 라우트에서
 *      350자로 다시 잘린다(`longLines` 주석의 그 함정과 같은 자리).
 *
 * ★ 첫 풍선에서 `DIFFERENTIATE_MARGIN` 만큼을 **비워 둔다.** 같은 답장을 60초 안에 두 번
 *   치면 `differentiate()` 가 끝에 `· 21:04` 를 붙이고 그 상태로 예산을 다시 적용한다.
 *   꽉 채워 두면 그 한 조각 때문에 맨 끝 줄이 잘린다(2026-09-07 에 `!숙제` 에서 실제로
 *   일어난 일이다).
 */
export interface PackedBubbles {
  /** 첫 말풍선. `CommandOutcome.reply` 로 그대로 넘긴다. */
  readonly reply: string;
  /** 이어지는 말풍선들. 비어 있으면 `extra` 를 아예 싣지 않는다. */
  readonly extra: readonly string[];
}

/** `differentiate()` 가 붙일 수 있는 `\n· HH:mm` 의 자리. */
const DIFFERENTIATE_MARGIN: ReplyBudget = { chars: 8, lines: 1 };

/** `null` 줄을 걷어낸 고정 줄들. */
function compactLines(
  parts: readonly (string | null | undefined)[],
): readonly string[] {
  return parts.filter((part): part is string => typeof part === "string");
}

/**
 * `start` 부터 몇 줄이 예산 안에 들어가는가. 고정 줄(`head`·`tail`)은 먼저 자리를 뺀다.
 *
 * 글자 수는 **줄바꿈으로 이은 뒤의 길이**로 센다 — 줄마다 구분자 1자가 붙으므로
 * 줄 길이 합만 세면 20줄에서 19자를 놓친다.
 */
function countThatFit(
  head: readonly string[],
  tail: readonly string[],
  items: readonly string[],
  start: number,
  budget: ReplyBudget,
): number {
  const fixedLineCount = head.length + tail.length;
  let chars = [...head, ...tail].reduce((sum, line) => sum + line.length, 0);
  let taken = 0;
  for (let index = start; index < items.length; index += 1) {
    const line = items[index] ?? "";
    const lineCount = fixedLineCount + taken + 1;
    const nextChars = chars + line.length;
    if (lineCount > budget.lines) break;
    if (nextChars + (lineCount - 1) > budget.chars) break;
    taken += 1;
    chars = nextChars;
  }
  return taken;
}

export function packBubbles(input: {
  readonly head: readonly (string | null | undefined)[];
  readonly items: readonly string[];
  readonly tail: readonly (string | null | undefined)[];
  /** 이어지는 풍선의 머리 줄. 번호만 덜렁 오면 무슨 목록인지 알 수 없다. */
  readonly continuationHead: string;
}): PackedBubbles {
  const head = compactLines(input.head);
  const tail = compactLines(input.tail);
  const firstBudget: ReplyBudget = {
    chars: LONG_REPLY_BUDGET.chars - DIFFERENTIATE_MARGIN.chars,
    lines: LONG_REPLY_BUDGET.lines - DIFFERENTIATE_MARGIN.lines,
  };
  /*
    ★ 최소 1줄은 담는다. 한 줄이 통째로 예산보다 긴 병적인 경우에 `0` 을 돌려받으면
      아래 루프가 영원히 돌고, 그건 잘리는 것보다 나쁘다.
  */
  const firstCount = Math.max(
    1,
    countThatFit(head, tail, input.items, 0, firstBudget),
  );
  const reply = toPlaintext(
    [...head, ...input.items.slice(0, firstCount), ...tail].join("\n"),
    LONG_REPLY_BUDGET,
  );

  const continuation = [input.continuationHead];
  const extra: string[] = [];
  let cursor = firstCount;
  while (cursor < input.items.length) {
    const count = Math.max(
      1,
      countThatFit(
        continuation,
        [],
        input.items,
        cursor,
        DEFAULT_REPLY_BUDGET,
      ),
    );
    extra.push(
      toPlaintext(
        [
          ...continuation,
          ...input.items.slice(cursor, cursor + count),
        ].join("\n"),
      ),
    );
    cursor += count;
  }

  return { reply, extra };
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
 *
 * ⚠️ **예산을 인자로 받는다(2026-09-07).** 위 `longLines` 주석이 *"둘 중 하나만 하면 도로
 *    잘린다"* 고 경고하는 함정이 **바로 이 함수였다.** 라우트가 `LONG_REPLY_BUDGET` 으로
 *    조립해 준 긴 답장을 여기서 기본 예산(350자)으로 다시 통과시켰고, 그래서 같은
 *    방에서 `!숙제` 를 60초 안에 두 번 치면 **맨 끝 꼬리말이 잘렸다** — 하필 `…외 N건` ·
 *    `2억 이하 결정석 N건`, 즉 *자른 사실을 숨기지 않으려고* 넣은 바로 그 줄들이다.
 *    실측(2026-09-07): 인자 없는 `!숙제` 답장이 사용자별 363~415자로 8명 중 6명이 350자를
 *    넘는다 — 이 경로는 예외가 아니라 **평상시**였다.
 *    기본값은 예전 그대로라 예산을 넘기지 않는 호출처는 한 줄도 바뀌지 않는다.
 */
export function differentiate(
  reply: string,
  previousDigest: string | null,
  digestOf: (value: string) => string,
  now: Date,
  budget: ReplyBudget = DEFAULT_REPLY_BUDGET,
): string {
  if (previousDigest === null) return reply;
  if (digestOf(reply) !== previousDigest) return reply;
  return toPlaintext(`${reply}\n· ${formatKst(now, "HH:mm")}`, budget);
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
