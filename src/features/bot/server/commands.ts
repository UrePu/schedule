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
 * - **`!숙제`** — §1.2 우선순위 최하. 표시 전용이라 언제 붙여도 비용이 같다.
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
import { getNextReset } from "@/lib/time/week";
import { formatMesoCompact } from "@/lib/utils";

import {
  parseCommand,
  parseDayScope,
  resolveBoss,
  type ParsedCommand,
} from "../lib/command-parse";
import {
  block,
  clipList,
  genericFailureReply,
  lines,
  needsLinkReply,
} from "../lib/plaintext";
import {
  fetchCrystalSummary,
  fetchRoomRuns,
  findClearCandidates,
  loadBotAccount,
  markCleared,
  type BotAccount,
} from "./bot-repo";
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

  const runs = await fetchRoomRuns(context.db, context.channel.id, scope, context.now);
  const title = `📅 ${scopeLabel(scope)} 일정 (${resetLabel(context.now)})`;

  if (runs.length === 0) {
    return {
      reply: block(title, [
        "잡힌 일정이 없어요.",
        "웹에서 파티를 이 방에 연결하면 여기에 보입니다.",
      ]),
      tag: "일정:빈",
      userId: account?.userId ?? null,
    };
  }

  const rendered = runs.map((run) => {
    const soon =
      run.scheduledAt !== null &&
      run.scheduledAt.getTime() - context.now.getTime() <= SOON_MS &&
      run.scheduledAt.getTime() >= context.now.getTime();
    return `${soon ? "⏰ " : "· "}${run.line}`;
  });

  return {
    reply: block(title, clipList(rendered, 6)),
    tag: "일정",
    userId: account?.userId ?? null,
  };
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
