import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 명령 디스패처
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이번에 만든 것과 **남긴 것 · 그 근거**
 * ─────────────────────────────────────────────────────────────────────────────
 * 만든 것: `!도움말` · `!연결` · `!연결해제` · `!일정[ 오늘|내일|요일]` · `!결정석` · `!클리어`
 *          · `!파티` · `!파티연결` · `!파티해제` (2026-08-19) · `!숙제` (2026-08-19)
 *
 * 남긴 것과 이유:
 *
 * - **`!등록 <보스> <시간>` (일정 생성)** — 이 앱에서 **런은 캐릭터 단위**다(§1).
 *   12개 주간 상한이 캐릭터당이라, 어느 캐릭터로 가는지 모르는 등록은 수익을 엉뚱한
 *   캐릭터에 쌓는다. 방에서 친 한 줄에는 그 정보가 없고, 되물으면 대화가 3턴이 된다.
 *   등록 경로(`createPartyRuns`)도 `partyId` + 참가자 + `characterId` 를 요구하므로
 *   "이 방의 파티"만으로는 채워지지 않는다. → **캐릭터 기본값을 사람마다 정할 수 있게
 *   된 뒤에** 여는 것이 맞다. 시각 파서(`21시` / `오후9시`)도 이 명령과 함께 미룬다 —
 *   쓰는 곳이 없는 파서를 미리 넣으면 다음 사람이 검증된 경로로 오해한다.
 * - **`!취소`** — 같은 이유(대상 특정)에 더해, 방에서 오타 한 번에 남의 파티가 날아가는
 *   경로다. 2단계 확인까지 포함한 설계가 필요하고, 그건 등록과 함께 오는 것이 맞다.
 * - **`!분배 1번 33`** — 분배는 `distribute_meso` / `run_drops` 위에서 도는 정산이고,
 *   방에서 즉시 확정되면 되돌리기가 어렵다. 다만 **번호는 지금부터 안정적이다**(§1.4):
 *   `member_no` · `party_no` 는 어디서도 재배열하지 않으며, `!일정` 답장이 그 번호를
 *   그대로 되읽어 준다. 그래서 이 명령이 나중에 붙을 때 방에서 오간 "1번"이 그대로 통한다.
 * - ~~**`!숙제`**~~ — 2026-08-19 에 발주 지시로 붙였다(일퀘·몬파 / 수로·에픽던전).
 *   첫 구현은 수로·에픽던전을 "넥슨이 판정 못 함(`?`)"으로 뒀는데, 발주자가 게임 규칙을
 *   알려 주며 정정했다 — **주간 카운터는 주간 리셋으로 0 이 되므로 `nowCount > 0` 자체가
 *   "이번 주에 했다"** 이다. 그래서 네 항목 모두 넥슨으로 판정되고 `?` 는 사라졌다.
 *   수동 체크는 정정용 우선 경로로만 남는다. 근거는 `lib/domain/chore-status.ts` 머리말.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 공통 규칙
 * ─────────────────────────────────────────────────────────────────────────────
 * - **미인식 명령은 침묵한다.** `알 수 없는 명령입니다` 를 남발하는 봇은 방에서 쫓겨난다.
 *   오타로 보이는 것(편집거리 1)만 한 줄 제안한다.
 * - 신원은 **`bot_channel_members` 로만** 해석한다. 닉네임은 표시용이다(§2.3).
 * - 모든 답장은 `toPlaintext()` 를 통과한다 — 마크다운·공백 정렬 금지, 350자·12줄 예산.
 */

import type { AdminDb } from "@/lib/supabase/admin-db";
import { formatKstShort } from "@/components/domain/kst-format";
import { choreMark, type ChoreStatus } from "@/lib/domain/chore-status";
import { getNextReset } from "@/lib/time/week";
import { formatMesoCompact } from "@/lib/utils";

import {
  parseCommand,
  parseDayScope,
  resolveBoss,
  type ParsedCommand,
} from "../lib/command-parse";
import {
  DIVIDER,
  SUB_DIVIDER,
  block,
  clipList,
  genericFailureReply,
  lines,
  needsLinkReply,
} from "../lib/plaintext";
import {
  CHORE_ALIASES,
  fetchChoreBoard,
  fetchCrystalSummary,
  fetchOtherRuns,
  fetchRoomRuns,
  formatOtherRuns,
  findClearCandidates,
  groupRuns,
  listBotParties,
  loadBotAccount,
  markCleared,
  setChoreManualDone,
  type BotAccount,
  type BotPartyRow,
  type RunGroup,
} from "./bot-repo";
import { setPartyChannel } from "./setup-repo";
import type { BotChannelRow } from "./channel";
import {
  clearLinkFailures,
  codeUnusableReply,
  consumeMemberLinkCode,
  noteLinkFailure,
  normalizeCode,
  resolveMember,
  tooManyLinkFailures,
  unlinkMember,
} from "./link";

export interface CommandContext {
  readonly db: AdminDb;
  readonly channel: BotChannelRow;
  readonly senderId: string;
  readonly senderName: string;
  readonly now: Date;
}

export interface CommandOutcome {
  /** 방에 출력할 평문. `null` 이면 클라이언트는 아무것도 보내지 않는다. */
  readonly reply: string | null;
  /**
   * 이어지는 말풍선. 계약의 선택 필드이며 **미지원 클라이언트는 무시해도 동작한다**
   * (`types.ts` BotCommandResponse).
   *
   * ★ 이걸 실제로 쓰기 시작한 이유(2026-08-19): `!숙제` 가 추적 캐릭터 11명을 보여줘야
   *   하는데 평문 예산이 350자·12줄이라 목록이 `…외 N건` 으로 잘렸고, 발주자가
   *   *"이거왜 다 못주고 주다말지?"* 라고 지적했다. 한 말풍선을 늘리는 것은 카카오가
   *   접어 버리므로 답이 아니고, **말풍선을 나누는 것**이 계약이 원래 준비해 둔 답이다.
   */
  readonly extra?: readonly string[];
  /** 감사 로그의 `result` 앞부분. 답장 원문은 남기지 않는다. */
  readonly tag: string;
  /** 해석된 계정. 로그의 `user_id` 에 남는다. */
  readonly userId: string | null;
}

/** 24시간 이내 = 임박. 평문에는 색이 없으므로 `⏰` 로 표시한다(빨강은 실패·취소 전용). */
const SOON_MS = 24 * 60 * 60 * 1000;

const KNOWN_COMMANDS = [
  "도움말",
  "명령어",
  "help",
  "일정",
  "결정석",
  "클리어",
  "연결",
  "연결해제",
  "파티",
  "파티연결",
  "파티해제",
  "숙제",
] as const;

// ─────────────────────────────────────────────────────────────────────────────
// 진입점
// ─────────────────────────────────────────────────────────────────────────────

export async function runCommand(
  context: CommandContext,
  parsed: ParsedCommand,
): Promise<CommandOutcome> {
  const account = await resolveAccount(context);

  switch (parsed.name) {
    case "도움말":
    case "명령어":
    case "help":
      return { reply: helpReply(), tag: "도움말", userId: account?.userId ?? null };

    case "연결":
      return handleLink(context, parsed);

    case "연결해제":
      return handleUnlink(context, account);

    case "일정":
      return handleSchedule(context, parsed, account);

    case "결정석":
      return handleCrystal(context, account);

    case "클리어":
      return handleClear(context, parsed, account);

    case "숙제":
      return handleChores(context, parsed, account);

    case "파티":
      return handleParties(context, account);

    case "파티연결":
      return handlePartyBind(context, parsed, account, true);

    case "파티해제":
      return handlePartyBind(context, parsed, account, false);

    default:
      return {
        reply: suggestion(parsed.name),
        tag: "미인식",
        userId: account?.userId ?? null,
      };
  }
}

/**
 * 발신자 → 계정. **정지·삭제 계정은 미연결과 같게 취급한다.**
 *
 * 매핑 자체를 지우지는 않는다 — 계정이 복구되면 다시 통해야 하고, 지워 버리면 사용자가
 * 이유를 모른 채 재연결부터 해야 한다.
 */
async function resolveAccount(context: CommandContext): Promise<BotAccount | null> {
  const member = await resolveMember(
    context.db,
    context.channel.id,
    context.senderId,
    context.senderName,
    context.now,
  );
  if (member === null) return null;

  const account = await loadBotAccount(context.db, member.userId);
  if (account === null || !account.usable) return null;
  return account;
}

// ─────────────────────────────────────────────────────────────────────────────
// !도움말
// ─────────────────────────────────────────────────────────────────────────────

function helpReply(): string {
  return block("[M_Schedule] 명령어", [
    "!일정        이번 주 방 일정",
    "!일정 오늘   오늘 일정만",
    "!결정석      이번 주 결정석 수익",
    "!클리어 <보스>  클리어 체크",
    "!파티           내 파티 목록",
    "!파티연결 <번호>  이 방에 연결",
    "!숙제           필수 숙제 O/X",
    "!연결 <코드>    웹 계정 연결",
    "!연결해제       연결 끊기",
  ]);
}

/** 편집거리 1 이내면 오타로 보고 한 줄 제안한다. 그 밖에는 **침묵**이다. */
function suggestion(name: string): string | null {
  const candidate = KNOWN_COMMANDS.find((known) => editDistanceWithin1(known, name));
  if (candidate === undefined) return null;
  return `!${candidate} 을(를) 말씀하신 건가요?`;
}

function editDistanceWithin1(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;

  let i = 0;
  let j = 0;
  let diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      continue;
    }
    diff += 1;
    if (diff > 1) return false;
    if (a.length > b.length) i += 1;
    else if (a.length < b.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// !연결 / !연결해제
// ─────────────────────────────────────────────────────────────────────────────

async function handleLink(
  context: CommandContext,
  parsed: ParsedCommand,
): Promise<CommandOutcome> {
  const raw = parsed.args[0];
  if (raw === undefined) {
    return {
      reply: lines(
        "웹에서 받은 6자리 코드를 함께 적어 주세요.",
        "!연결 A7K2Q9",
      ),
      tag: "연결:사용법",
      userId: null,
    };
  }

  /*
    실패가 쌓인 발신자에게는 **아무 답도 하지 않는다.** 실패 안내조차 방에서는 도배가
    되고, 코드를 찍어 보는 쪽에는 응답 자체가 정보다.
  */
  if (tooManyLinkFailures(context.channel.id, context.senderId, context.now)) {
    return { reply: null, tag: "연결:차단", userId: null };
  }

  const code = normalizeCode(raw);
  if (code === null) {
    noteLinkFailure(context.channel.id, context.senderId, context.now);
    return { reply: codeUnusableReply(), tag: "연결:형식", userId: null };
  }

  const linked = await consumeMemberLinkCode(
    context.db,
    {
      code,
      channelId: context.channel.id,
      senderId: context.senderId,
      displayName: context.senderName,
    },
    context.now,
  );
  if (linked === null) {
    noteLinkFailure(context.channel.id, context.senderId, context.now);
    return { reply: codeUnusableReply(), tag: "연결:실패", userId: null };
  }

  clearLinkFailures(context.channel.id, context.senderId);
  const account = await loadBotAccount(context.db, linked.userId);

  return {
    reply: lines(
      "✅ 연결 완료",
      account === null ? null : `${account.label} 계정으로 확인했어요.`,
      "이제 !결정석 !클리어 를 쓸 수 있어요.",
    ),
    tag: "연결:성공",
    userId: linked.userId,
  };
}

async function handleUnlink(
  context: CommandContext,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  if (account === null) {
    return { reply: "연결된 계정이 없어요.", tag: "연결해제:없음", userId: null };
  }
  const removed = await unlinkMember(context.db, context.channel.id, context.senderId);
  return {
    reply: removed
      ? lines("🔓 연결을 끊었어요.", "다시 쓰려면 !연결 <코드> 로 연결해 주세요.")
      : "연결된 계정이 없어요.",
    tag: "연결해제",
    userId: account.userId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// !일정
// ─────────────────────────────────────────────────────────────────────────────

function resetLabel(now: Date): string {
  return `~${formatKstShort(getNextReset(now))}`;
}

async function handleSchedule(
  context: CommandContext,
  parsed: ParsedCommand,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  const scope = parseDayScope(parsed.args[0]);
  if (scope === null) {
    return {
      reply: lines("언제인지 알아듣지 못했어요.", "!일정 · !일정 오늘 · !일정 목"),
      tag: "일정:범위불명",
      userId: account?.userId ?? null,
    };
  }

  /*
    ★ **날짜를 언제나 적는다** — 주 단위 목록에서 `21:40` 만으로는 어느 날인지 알 수 없다.
      발주자 지적: *"이번주 일정인데 날짜/요일이 없다"*. 하루가 이미 제목에 있는
      `!일정 오늘` / `!일정 내일` 만 시각으로 접는다.
  */
  const reference = scope.kind === "week" ? null : context.now;

  /*
    ★ **두 층으로 답한다** (발주 지시 2026-08-19):
      *"해당 방에서 진행하는 보스는 닉네임을 적어주고 이방이 아니면 그냥 있는거만"*
      - 이 방 파티      → 보스 + 참가자 이름
      - 그 밖의 내 파티 → 보스와 시각만. 다른 방 사람들의 이름을 이 방에 뿌리지 않는다.
    두 조회는 서로를 기다릴 이유가 없다.
  */
  const [runs, otherRuns] = await Promise.all([
    fetchRoomRuns(context.db, context.channel.id, scope, context.now),
    account === null
      ? Promise.resolve([])
      : fetchOtherRuns(context.db, context.channel.id, account.userId, scope, context.now),
  ]);
  const title = `📅 ${scopeLabel(scope)} 일정 (${resetLabel(context.now)})`;

  if (runs.length === 0 && otherRuns.length === 0) {
    return {
      reply: block(title, [
        "잡힌 일정이 없어요.",
        // 웹으로 보내던 안내였다. 이제 방에서 끝나므로 **여기서 칠 수 있는 명령**을 준다.
        "!파티 로 이 방에 파티를 연결해 보세요.",
      ]),
      tag: "일정:빈",
      userId: account?.userId ?? null,
    };
  }

  /*
    ★ **연속한 런은 한 묶음으로 그린다.**
      요구 원문: "4개 보스를 선택하면 4개를 묶어서 하나의 보스 일정으로 바꿔줘
      21:00 ~ 22:00". 이전에는 줄마다 `21시 1파티 <보스> (명단)` 이 통째로 반복돼,
      네 줄 중 실제로 다른 부분은 보스 이름뿐인데도 시각·파티·명단이 세 번 더 적혔다.
      헤더로 올리면 눈이 보스 이름만 훑으면 된다.

      ⚠️ 헤더의 끝 시각은 **마지막 런의 시작 시각**이다(끝나는 시각이 아니다).
        요구에 적힌 예가 `21:00 ~ 22:00` 인데 마지막 런이 22:00 **시작**이라 그렇다.
        마지막 런의 종료(22:20)를 쓰면 더 정확하지만, 발주자가 쓴 표기와 달라진다.
  */
  /*
    ★ **발주자가 그려 준 모양 그대로다** (2026-08-19). 이전에는 보스와 명단이 한 줄에
      붙어 있었는데, 가변폭 글꼴에서는 `보스 : 이름, 이름` 의 경계가 눈에 안 잡힌다.

        ⏰ 8/19(수) 21:40 ~ 22:40 · 1파티
        ···············
        익스트림 선택받은 세렌 :
        더저(무르겨르), 라온내일
        (빈 줄)
        하드 최초의 대적자 :
        …

      줄을 나누면 왼쪽 끝이 **보스 이름으로 정렬**돼 훑기가 쉬워진다. 두 줄로 만드는 것은
      DB(`format_run_entry(p_multiline => true)`)가 하고, 여기서는 **묶음 사이 빈 줄만**
      넣는다 — 문자열 조립은 계속 DB 소유다.
    ⚠️ 빈 줄이 들어가므로 줄 수가 늘어난다. 그래서 `REPLY_LINE_BUDGET` 을 12 → 20 으로
       올렸다. 글자 예산(350)은 그대로이고, 실제로 먼저 걸리는 쪽은 여전히 글자 수다.
  */
  const groups = groupRuns(runs, reference);
  const rendered = groups.flatMap((group, groupIndex) => [
    // 묶음 사이를 빈 줄로 띄운다. 첫 묶음 앞에는 이미 구분선이 있다.
    ...(groupIndex === 0 ? [] : [""]),
    groupHeader(group, context.now),
    SUB_DIVIDER,
    ...group.entries.flatMap((entry, entryIndex) =>
      entryIndex === 0 ? [entry] : ["", entry],
    ),
  ]);

  // 이 방 것이 먼저다. 다른 방 것은 참고 정보이므로 구분선 아래로 내린다.
  const others =
    otherRuns.length === 0
      ? []
      : [
          DIVIDER,
          "다른 파티 (이름 생략)",
          ...clipList(
            formatOtherRuns(otherRuns, reference).map((line) => `· ${line}`),
            4,
          ),
        ];

  return {
    reply: lines(
      title,
      "",
      DIVIDER,
      "",
      ...clipList(rendered, 14),
      ...others,
      DIVIDER,
    ),
    tag: otherRuns.length === 0 ? "일정" : "일정:다른파티포함",
    userId: account?.userId ?? null,
  };
}

/** `⏰ 21:00 ~ 22:00 · 1파티` — 시각·파티번호는 묶음마다 **한 번만** 적는다. */
function groupHeader(group: RunGroup, now: Date): string {
  const party = group.partyNo === null ? "" : ` · ${String(group.partyNo)}파티`;

  // 임박 표시는 시각이 있을 때만. 평문에는 색이 없으므로 `⏰` 가 그 역할을 한다.
  const soon =
    group.startAt !== null &&
    group.startAt.getTime() - now.getTime() <= SOON_MS &&
    group.startAt.getTime() >= now.getTime();

  return `${soon ? "⏰ " : "· "}${group.range}${party}`;
}

function scopeLabel(scope: ReturnType<typeof parseDayScope>): string {
  if (scope === null) return "이번 주";
  switch (scope.kind) {
    case "today":
      return "오늘";
    case "tomorrow":
      return "내일";
    case "weekday":
      return `${["월", "화", "수", "목", "금", "토", "일"][scope.isoWeekday - 1] ?? ""}요일`;
    default:
      return "이번 주";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// !숙제
// ─────────────────────────────────────────────────────────────────────────────
//
// 발주 요구(2026-08-19): *"매일 필수적으로 해야되는게 일퀘 몬파 / 주간 필수적으로
// 해야되는게 수로 에픽던전 (…) !숙제 하면 저걸 추적하는 모든 캐릭으로 보여주면될듯?"*
//
// ★ 판정은 `lib/domain/chore-status.ts` 가 소유한다. 여기서는 **그리기만** 한다.
// ★ `?` 가 나오는 자리가 있다 — 넥슨이 완료를 알려 주지 않는 항목이고, 그때는 X 로
//   뭉개지 않고 `?` 로 둔다. 아무것도 안 한 캐릭터에 O 를 찍는 쪽이 훨씬 나쁘다.

/**
 * `일퀘O` · `몬파3/7` — 발주 정정(2026-08-19).
 *
 * 대부분은 O/X 만 낸다(*"o x 로만 표시하고 횟수는 그냥 치워"*). **몬파만 횟수**인데,
 * 남은 입장 횟수가 곧 할 일의 양이라 O/X 로 접으면 정보가 사라지기 때문이다
 * (*"그래서 몬파는 횟수. 일퀘는 O or X"*). 그 예외는 `detail` 이 있는지로 갈린다 —
 * 여기서 항목 이름을 다시 분기하면 규칙이 두 곳에 생긴다.
 *
 * 라벨과 값 사이를 띄우지 않는다. 11명 × 최대 4항목이 한 화면에 들어가야 하고,
 * 카카오톡은 가변폭이라 띄어쓰기로 열을 맞출 수도 없다(§1.4) — 폭을 아끼는 쪽이 낫다.
 */
function choreCell(status: ChoreStatus): string {
  return `${status.label}${status.detail ?? choreMark(status.state)}`;
}

async function handleChores(
  context: CommandContext,
  parsed: ParsedCommand,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  if (account === null) {
    return { reply: needsLinkReply(), tag: "숙제:미연결", userId: null };
  }

  // 인자가 있으면 체크/해제다. `!숙제 수로 무르겨르` · `!숙제 해제 수로 무르겨르`
  if (parsed.args.length > 0) {
    return handleChoreCheck(context, parsed, account);
  }

  const board = await fetchChoreBoard(context.db, account.userId, context.now);
  if (board.length === 0) {
    return {
      reply: block("📋 필수 숙제", [
        "추적 중인 캐릭터가 없어요.",
        "웹에서 추적 캐릭터를 먼저 골라 주세요.",
      ]),
      tag: "숙제:빈",
      userId: account.userId,
    };
  }

  /*
    ★ **캐릭터 한 명이 한 줄이다.** 처음에는 이름/일간/주간 3줄이었는데, 추적 캐릭터가
      11명이면 33줄이라 평문 예산(350자·12줄)에서 잘렸고 발주자가 그 잘림을 지적했다.
      한 줄로 접으면 11줄이라 대부분 한 말풍선에 들어가고, 넘치면 아래에서 나눈다.
    ★ 등록하지 않은 항목은 애초에 배열에 없다(`chore-status`). 그래서 캐릭터마다 칸 수가
      다를 수 있고, 그게 의도다 — 안 하기로 한 숙제에 자리를 내주지 않는다.
  */
  const rows = board.map((character) => {
    const cells = [...character.daily, ...character.weekly].map(choreCell);
    const name = `${character.characterName}${character.isMain ? "*" : ""}`;
    if (cells.length === 0) {
      // 스냅샷이 없는 것과 "등록한 필수 숙제가 없는 것"을 구분해 말한다.
      return `${name} ${character.syncedAt === null ? "동기화 안 됨" : "등록 없음"}`;
    }
    return `${name} ${cells.join(" ")}`;
  });

  /*
    말풍선 나누기. 첫 풍선은 제목·구분선·안내가 들어가 본문 여유가 적으므로 더 적게 담는다.
    `toPlaintext` 가 풍선마다 예산을 다시 재므로 여기서 글자 수를 계산할 필요는 없다.
  */
  const FIRST = 8;
  const REST = 10;
  const head = rows.slice(0, FIRST);
  const tail: string[] = [];
  for (let i = FIRST; i < rows.length; i += REST) {
    tail.push(lines(...rows.slice(i, i + REST)));
  }

  return {
    reply: block(`📋 필수 숙제 (${resetLabel(context.now)})`, [
      ...head,
      DIVIDER,
      "* = 본캐 · !숙제 수로 <캐릭터> 로 직접 체크",
    ]),
    extra: tail.length > 0 ? tail : undefined,
    tag: "숙제",
    userId: account.userId,
  };
}

/**
 * `!숙제 수로 무르겨르` — 주간 항목을 사람이 체크한다.
 *
 * 넥슨이 수로·에픽던전의 완료를 주지 않으므로(§chore-status) 이 경로가 **그 둘의 유일한
 * 판정 근거**다. 일퀘·몬파는 넥슨이 답하므로 손으로 덮지 않는다 — 덮게 두면 게임과 다른
 * 값이 화면에 남고, 어느 쪽이 맞는지 아무도 모르게 된다.
 */
async function handleChoreCheck(
  context: CommandContext,
  parsed: ParsedCommand,
  account: BotAccount,
): Promise<CommandOutcome> {
  const tokens = [...parsed.args];
  // `해제` / `취소` 가 어디에 오든 받는다 — 방에서 어순은 사람마다 다르다.
  const undoIndex = tokens.findIndex((t) => t === "해제" || t === "취소");
  const undo = undoIndex >= 0;
  if (undo) tokens.splice(undoIndex, 1);

  const slug = CHORE_ALIASES[tokens[0] ?? ""];
  if (slug === undefined) {
    return {
      reply: lines(
        "체크할 수 있는 주간 항목은 수로 · 에픽던전 입니다.",
        "일퀘와 몬파는 인게임 정보로 자동 판정돼요.",
        "예: !숙제 수로 무르겨르",
      ),
      tag: "숙제:항목불명",
      userId: account.userId,
    };
  }

  const board = await fetchChoreBoard(context.db, account.userId, context.now);
  const nameToken = tokens[1];
  const target =
    nameToken === undefined
      ? board.length === 1
        ? board[0]
        : undefined
      : board.find((c) => c.characterName === nameToken);

  if (target === undefined) {
    return {
      reply: lines(
        nameToken === undefined
          ? "어느 캐릭터인지 함께 적어 주세요."
          : `추적 캐릭터 중에 ${nameToken} 이(가) 없어요.`,
        "!숙제 로 캐릭터 이름을 확인할 수 있어요.",
      ),
      tag: "숙제:캐릭불명",
      userId: account.userId,
    };
  }

  const saved = await setChoreManualDone(
    context.db,
    {
      userId: account.userId,
      characterId: target.characterId,
      slug,
      done: !undo,
    },
    context.now,
  );
  if (!saved) {
    return {
      reply: genericFailureReply(),
      tag: "숙제:정의없음",
      userId: account.userId,
    };
  }

  const label = slug === "epic-dungeon" ? "에픽던전" : "지하수로";
  return {
    reply: lines(
      undo
        ? `${target.characterName} · ${label} 체크를 지웠어요.`
        : `✅ ${target.characterName} · ${label} 완료로 표시했어요.`,
    ),
    tag: undo ? "숙제:해제" : "숙제:체크",
    userId: account.userId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// !파티 · !파티연결 · !파티해제
// ─────────────────────────────────────────────────────────────────────────────
//
// ★ **왜 방에서 바인딩까지 하는가.**
//   원래 파티↔방 연결은 웹 모달의 드롭다운 하나뿐이었다. 그런데 방을 연결하러 온 사람은
//   이미 방에 있고, 거기서 웹으로 건너갔다 오라는 요구는 그 자체가 이탈 지점이다. 실제로
//   "너무 복잡하다"는 지적이 나왔다. 권한 판정은 `setPartyChannel` 이 그대로 소유하므로
//   (구성원 여부 + 방 연결 여부), 여기서 여는 것은 **입구 하나이지 새 권한이 아니다.**
//
// ★ 웹 드롭다운은 그대로 둔다. 방에 없는 파티를 정리하거나 여러 방을 한눈에 보는 일은
//   여전히 화면이 낫다. 두 입구가 같은 함수를 부르므로 규칙이 갈라지지 않는다.

function partyUsage(): readonly string[] {
  return ["!파티 로 번호를 확인한 뒤", "!파티연결 <번호> 를 입력해 주세요."];
}

async function handleParties(
  context: CommandContext,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  if (account === null) {
    return { reply: needsLinkReply(), tag: "파티:미연결", userId: null };
  }

  const parties = await listBotParties(
    context.db,
    account.userId,
    context.channel.id,
    context.now,
  );

  if (parties.length === 0) {
    return {
      reply: block("👥 내 파티", [
        "참여 중인 파티가 없어요.",
        "웹에서 파티를 만들면 여기에 나옵니다.",
      ]),
      tag: "파티:빈",
      userId: account.userId,
    };
  }

  const rendered = parties.map((party, index) => {
    // 상태는 **한 칸에 하나만** 붙인다. 평문에서 꼬리표가 둘 이상 붙으면 줄이 읽히지 않는다.
    const mark = party.boundHere ? " ✅ 이 방" : party.boundElsewhere ? " (다른 방)" : "";
    return `${String(index + 1)}. ${party.name} · 런 ${String(party.runCount)}${mark}`;
  });

  return {
    reply: block("👥 내 파티", [
      ...clipList(rendered, 8),
      DIVIDER,
      "!파티연결 <번호> · !파티해제 <번호>",
    ]),
    tag: "파티",
    userId: account.userId,
  };
}

/**
 * 번호 또는 **이름**으로 고른다.
 *
 * 번호만 받으면 목록을 못 본 사람이 매번 `!파티` 를 먼저 쳐야 하고, 이름만 받으면
 * `림흉발벨3인` 을 정확히 타이핑해야 한다. 둘 다 받는 비용이 거의 없다.
 */
function pickParty(
  parties: readonly BotPartyRow[],
  token: string,
): BotPartyRow | null {
  const index = Number.parseInt(token, 10);
  if (Number.isFinite(index) && String(index) === token.trim()) {
    return parties[index - 1] ?? null;
  }
  const needle = token.replace(/\s+/g, "").toLowerCase();
  if (needle === "") return null;
  return (
    parties.find((party) => party.name.replace(/\s+/g, "").toLowerCase() === needle) ?? null
  );
}

async function handlePartyBind(
  context: CommandContext,
  parsed: ParsedCommand,
  account: BotAccount | null,
  bind: boolean,
): Promise<CommandOutcome> {
  const label = bind ? "파티연결" : "파티해제";
  if (account === null) {
    return { reply: needsLinkReply(), tag: `${label}:미연결`, userId: null };
  }

  if (parsed.rest === "") {
    return {
      reply: lines(`어느 파티인지 알려 주세요.`, ...partyUsage()),
      tag: `${label}:인자없음`,
      userId: account.userId,
    };
  }

  const parties = await listBotParties(
    context.db,
    account.userId,
    context.channel.id,
    context.now,
  );
  const target = pickParty(parties, parsed.rest);
  if (target === null) {
    return {
      reply: lines("그 번호(또는 이름)의 파티를 찾지 못했어요.", ...partyUsage()),
      tag: `${label}:미발견`,
      userId: account.userId,
    };
  }

  // 이미 그 상태면 **쓰지 않고** 그렇다고만 말한다. 같은 명령을 두 번 쳐도 놀랄 일이 없다.
  if (bind && target.boundHere) {
    return {
      reply: lines(`✅ ${target.name} 은(는) 이미 이 방에 연결돼 있어요.`),
      tag: "파티연결:이미",
      userId: account.userId,
    };
  }
  if (!bind && !target.boundHere) {
    return {
      reply: lines(`${target.name} 은(는) 이 방에 연결돼 있지 않아요.`),
      tag: "파티해제:이미",
      userId: account.userId,
    };
  }

  // 권한 판정(구성원 여부 · 방 연결 여부)은 웹과 **같은 함수**가 소유한다.
  // 실패는 ApiError 로 올라가고, 라우트가 그 문구를 그대로 방에 안내한다.
  await setPartyChannel(account.userId, target.partyId, bind ? context.channel.id : null);

  if (!bind) {
    return {
      reply: lines(`🔌 ${target.name} 의 이 방 알림을 껐어요.`),
      tag: "파티해제",
      userId: account.userId,
    };
  }

  return {
    reply: lines(
      `✅ ${target.name} 을(를) 이 방에 연결했어요.`,
      // 옮겨온 경우 그 사실을 숨기지 않는다 — 저쪽 방에서는 알림이 조용히 끊긴다.
      target.boundElsewhere ? "다른 방에 있던 것을 옮겨왔어요." : null,
      "이제 !일정 에 이 파티 일정이 나옵니다.",
    ),
    tag: "파티연결",
    userId: account.userId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// !결정석
// ─────────────────────────────────────────────────────────────────────────────

/** `null` 은 **0 이 아니라 "모름"** 이다(§1.3 D4). 문구도 그렇게 갈라 쓴다. */
function mesoText(value: number | null): string {
  return value === null ? "미확인" : `${formatMesoCompact(value)} 메소`;
}

async function handleCrystal(
  context: CommandContext,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  if (account === null) {
    return { reply: needsLinkReply(), tag: "결정석:미연결", userId: null };
  }

  const summary = await fetchCrystalSummary(account.userId, context.now);
  const title = `💎 이번 주 결정석 (${resetLabel(context.now)})`;

  if (summary === null) {
    return {
      reply: block(title, [
        "아직 이번 주 기록이 없어요.",
        "일정을 클리어로 체크하면 여기에 쌓입니다.",
      ]),
      tag: "결정석:빈",
      userId: account.userId,
    };
  }

  return {
    reply: block(title, [
      `클리어 ${String(summary.clearCount)}건 (주간 ${String(summary.weeklyClearCount)}건)`,
      `결정석 ${mesoText(summary.crystalIncomeMeso)}`,
      summary.dropCount > 0 ? `드랍 ${mesoText(summary.dropIncomeMeso)}` : null,
      `합계 ${mesoText(summary.totalIncomeMeso)}`,
      // 미확인 가격을 0 으로 더하지 않았다는 사실을 **숨기지 않는다**(§1.3 D4).
      summary.unknownPriceCount > 0
        ? `가격 미확인 ${String(summary.unknownPriceCount)}건은 합계에서 빠져 있어요.`
        : null,
      summary.unsoldDropCount > 0
        ? `아직 안 판 드랍 ${String(summary.unsoldDropCount)}건`
        : null,
    ]),
    tag: "결정석",
    userId: account.userId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// !클리어
// ─────────────────────────────────────────────────────────────────────────────

async function handleClear(
  context: CommandContext,
  parsed: ParsedCommand,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  if (parsed.rest === "") {
    return {
      reply: lines("어느 보스인지 함께 적어 주세요.", "!클리어 하드스우"),
      tag: "클리어:사용법",
      userId: account?.userId ?? null,
    };
  }
  if (account === null) {
    return { reply: needsLinkReply(), tag: "클리어:미연결", userId: null };
  }

  const lookup = resolveBoss(parsed.rest, context.now);
  if (lookup.kind === "none") {
    return {
      reply: lines(
        `❓ '${parsed.rest}' 가 어느 보스인지 모르겠어요.`,
        "주간·월간 보스만 다룹니다. 예: !클리어 하드스우",
      ),
      tag: "클리어:보스불명",
      userId: account.userId,
    };
  }
  if (lookup.kind === "ambiguous") {
    return {
      reply: lines(
        `❓ '${parsed.rest}' 는 난이도가 여러 개예요.`,
        ...clipList(
          lookup.candidates.map((entry) => `!클리어 ${entry.koreanName.replace(/\s+/g, "")}`),
          4,
        ),
      ),
      tag: "클리어:모호",
      userId: account.userId,
    };
  }

  const entry = lookup.entry;
  const candidates = await findClearCandidates(
    context.db,
    account.userId,
    entry,
    context.now,
  );

  if (candidates.length === 0) {
    return {
      reply: lines(
        `이번 주 ${entry.koreanName} 일정에 참여 등록이 없어요.`,
        "웹에서 일정을 만들고 참여로 등록한 뒤 다시 시도해 주세요.",
      ),
      tag: "클리어:후보없음",
      userId: account.userId,
    };
  }
  if (candidates.length > 1) {
    /*
      골라 주지 않는다. 같은 주에 같은 보스 일정이 둘이면 어느 쪽을 깼는지는 우리가
      알 수 없고, 잘못 고르면 **남의 수익 원장에 붙는다.** 드문 경우이므로 웹으로 보낸다.
    */
    return {
      reply: lines(
        `${entry.koreanName} 일정이 이번 주에 ${String(candidates.length)}개 있어요.`,
        "어느 것인지 알 수 없어 웹에서 체크해 주세요.",
      ),
      tag: "클리어:다중",
      userId: account.userId,
    };
  }

  const target = candidates[0];
  if (target === undefined) return { reply: genericFailureReply(), tag: "클리어:오류", userId: account.userId };
  if (target.alreadyCleared) {
    return {
      reply: lines("ℹ️ 이미 클리어로 체크된 일정이에요.", entry.koreanName),
      tag: "클리어:중복",
      userId: account.userId,
    };
  }

  await markCleared(account.userId, target.runId);
  const summary = await fetchCrystalSummary(account.userId, context.now);

  return {
    reply: lines(
      "✅ 클리어 처리",
      entry.koreanName,
      summary === null
        ? null
        : `이번 주 누적 ${mesoText(summary.totalIncomeMeso)} (${String(summary.clearCount)}건)`,
    ),
    tag: "클리어",
    userId: account.userId,
  };
}

/** 라우트가 원문 메시지를 넘기면 파싱까지 여기서 끝낸다. `!` 가 아니면 `null`. */
export function parseIncoming(message: string): ParsedCommand | null {
  return parseCommand(message);
}
