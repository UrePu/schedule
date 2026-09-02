import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 명령 디스패처
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이번에 만든 것과 **남긴 것 · 그 근거**
 * ─────────────────────────────────────────────────────────────────────────────
 * 만든 것: `!도움말` · `!연결` · `!연결해제` · `!일정[ 오늘|내일|요일]` · `!결정석`
 *          · `!파티` · `!파티연결` · `!파티해제` (2026-08-19) · `!숙제` (2026-08-19)
 *
 * 남긴 것과 이유:
 *
 * - ~~**`!클리어 <보스>`**~~ — 2026-08-20 에 **뺐다**(발주 지시: *"카톡 봇에서 클리어
 *   이력남기는건 필요없잖아"*). 만들 때는 이것이 §1.3 D3 의 6배 과대 계상을 피하는 유일한
 *   경로라고 봤는데, **동기화가 이미 같은 일을 한다.** `sync-scheduler.recordApiClears()`
 *   는 넥슨 `complete_flag` 로 만든 클리어에 `run_id` 를 붙이고 `party_size` 와
 *   `cleared_at` 까지 그 일정에서 가져온다 — 즉 손으로 친 `!클리어` 와 **같은 품질의 행**이
 *   나온다. 남는 차이는 넥슨 데이터의 ~15분 지연뿐이고, 결정석 수익은 주간 합계라 그
 *   지연에 의미가 없다. 게다가 방에서 쓰려면 파티원이 **각자** 한 줄씩 쳐야 해서, 자동으로
 *   되는 일을 사람 수만큼 반복시키는 명령이었다.
 *   ⚠️ 되살릴 이유가 생긴다면 그건 "지연이 문제"가 아니라 **동기화가 런에 못 붙는 경우**가
 *   발견됐을 때다. 그때는 `recordApiClears` 의 `loadRunLinks` 를 먼저 의심할 것.
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
 * - ~~**`!숙제`(필수 숙제 O/X)**~~ — 2026-08-19 에 붙였다가 **2026-09-02 에 방에서
 *   내려갔다**(발주 지시: *"!숙제에 대한것을 전부 삭제"*). 사라진 것은 **방에서 부르는
 *   길**뿐이다 — 판정(`lib/domain/chore-status.ts`) · 조회(`bot-repo.fetchChoreBoard`) ·
 *   웹 `/chores` 화면은 그대로 살아 있다. 그 이름은 이제 **남은 보스 목록**이 가져갔다
 *   (`handleHomework`): 방에서 "이번 주 숙제"가 뜻하는 것은 결정석 도는 일이고,
 *   일퀘·몬파는 물어볼 것도 없이 매일 하는 것이라 목록이 필요 없다.
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
import { formatKstShort, kstWeekdayKo } from "@/components/domain/kst-format";
import {
  computeDropSplit,
  formatEok,
  parseEok,
  parseFeeRate,
} from "@/lib/domain/drop-split";
import { kstDayKey } from "@/lib/time/kst-wallclock";
import { formatKst, getNextReset } from "@/lib/time/week";
import { formatMesoCompact } from "@/lib/utils";

import {
  formatClockMinute,
  parseClockMinute,
  parseCommand,
  parseDateToken,
  parseDayScope,
  type ParsedCommand,
} from "../lib/command-parse";
import {
  DIVIDER,
  block,
  clipList,
  lines,
  longLines,
  needsLinkReply,
} from "../lib/plaintext";
import {
  deleteMyLatestDrop,
  fetchCrystalSummary,
  fetchMyRuns,
  fetchRemainingBosses,
  type RemainingBoss,
  type RemainingSummary,
  type MyRun,
  weekAnchor,
  groupRuns,
  fetchChannelDigestMinutes,
  fetchNotificationPrefs,
  findDropTargetRun,
  isDirectGranted,
  listBotParties,
  loadBotAccount,
  recordDrop,
  saveNotificationPrefs,
  setChannelDigestMinutes,
  setPartyReminders,
  type BotAccount,
  type BotPartyRow,
  type NotificationPrefs,
  type RunGroup,
} from "./bot-repo";
import {
  createMyAvailabilityException,
  deleteMyAvailabilityExceptionsOn,
  findMyAvailabilityExceptionsOn,
} from "@/features/schedule/server/schedule-repo";

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
  /**
   * 이 요청이 도착한 **공개 주소**(`https://…`). `!웹` 이 돌려줄 링크다.
   *
   * 환경변수로 두지 않은 이유: 배포 주소가 바뀌면 조용히 옛 주소를 뿌리게 된다. 요청이
   * 실제로 들어온 곳이 곧 사용자가 열 수 있는 곳이므로, **그 요청에서 뽑는 편이 항상 맞다.**
   */
  readonly siteOrigin: string;
}

export interface CommandOutcome {
  /** 방에 출력할 평문. `null` 이면 클라이언트는 아무것도 보내지 않는다. */
  readonly reply: string | null;
  /**
   * 이어지는 말풍선. 계약의 선택 필드이며 **미지원 클라이언트는 무시해도 동작한다**
   * (`types.ts` BotCommandResponse).
   *
   * ★ 2026-08-19 에 필수 숙제 목록이 이걸 쓰기 시작했고, **2026-09-02 현재 쓰는 곳이
   *   없다** — 그 명령이 내려가면서 유일한 생산자가 사라졌다. 그 자리를 받은 남은 보스
   *   목록은 나누는 대신 **한 풍선 + 긴 예산**을 골랐다(아래 `long`, 발주 지시:
   *   *"접히든가 말던가 1개로 보내고"*).
   * ★ 필드를 지우지 않는 이유는 **계약이기 때문**이다(`types.ts` BotCommandResponse).
   *   런너가 이미 지원하고, 다음에 긴 목록이 생기면 그 자리에 다시 쓴다.
   */
  readonly extra?: readonly string[];
  /**
   * **긴 예산으로 조립한 답장인가**(`LONG_REPLY_BUDGET`). `!숙제` 처럼 **길어야 말이
   * 되는** 목록 답장에만 켠다.
   *
   * ⚠️ 라우트가 마지막에 `toPlaintext` 를 한 번 더 통과시킨다(평문 규칙은 한 곳에서
   *    강제한다). 이 플래그가 꺼져 있으면 거기서 기본 예산(350자)이 적용돼 **늘려 둔 것이
   *    도로 잘린다.** 조립기(`longLines`)와 항상 짝으로 쓴다.
   */
  readonly long?: boolean;
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
  "연결",
  "연결해제",
  "파티",
  "파티연결",
  "파티해제",
  "숙제",
  "웹",
  "사이트",
  "제외",
  "제외해제",
  "알림",
  "알리미",
  "드랍",
  "드롭",
  "분배",
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
      return {
        reply: helpReply(context.channel.kind),
        tag: "도움말",
        userId: account?.userId ?? null,
      };

    case "연결":
      return handleLink(context, parsed);

    case "연결해제":
      return handleUnlink(context, account);

    case "일정":
      return handleSchedule(context, parsed, account);

    case "결정석":
      return handleCrystal(context, parsed, account);

    case "숙제":
      return handleHomework(context, account);

    /*
      ★ **`!드랍` 은 기록하고 `!분배` 는 계산만 한다** (발주 지시 2026-08-20:
        *"!드랍 은 저장 기능을 부여하고 !분배 는 저장을 빼"*).

        하루 전만 해도 둘은 같은 명령이었다. 갈라진 이유는 방에서 쓰는 결이 다르기
        때문이다 — "얼마씩 올리지?" 는 **묻는 말**이라 원장에 남을 이유가 없고, 실제로
        판 뒤에 남기는 것은 `!드랍` 이다. 계산기로 물어본 것이 조용히 수익으로 잡히면
        그 주 정산이 사실과 어긋난다.
      ★ 계산·문구는 **한 함수**가 그대로 갖는다. 기록 여부만 인자로 가른다 — 두 벌로
        나누면 방에 나가는 숫자가 언젠가 갈라진다.
    */
    case "드랍":
    case "드롭":
      return handleDropSplit(context, parsed, account, { record: true });

    case "분배":
      return handleDropSplit(context, parsed, account, { record: false });

    case "알림":
    case "알리미":
      return handleReminders(context, parsed, account);

    case "제외":
      return handleExclude(context, parsed, account, true);

    case "제외해제":
      return handleExclude(context, parsed, account, false);

    case "웹":
    case "사이트":
      /*
        링크 한 줄이라 DB 를 건드리지 않는다. 카카오톡이 URL 을 자동으로 링크로 만들므로
        마크다운을 쓸 이유도 없다(research-KAKAO-BOT §1.4).
      */
      return {
        reply: lines("🔗 대시보드", context.siteOrigin),
        tag: "웹",
        userId: account?.userId ?? null,
      };

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

function helpReply(kind: BotChannelRow["kind"]): string {
  /*
    ★ **개인톡 도움말은 다르다**(2026-08-31). 파티방 전용 명령(`!파티연결` 처럼 방에
      파티를 묶는 것)은 개인톡에서 할 일이 없고, 반대로 `!알림` 은 여기서만 요약·임박을
      뜻한다. 한 벌로 합치면 어느 쪽에서든 절반이 쓸모없는 목록이 되고, 평문 예산
      (350자·20줄)도 넘긴다.
  */
  if (kind === "direct") {
    return block("[M_Schedule] 개인톡 명령어", [
      "!일정        이번 주 내 일정",
      "!일정 오늘   오늘 일정만",
      "!결정석      이번 주 결정석 수익",
      "!숙제        남은 보스 20개",
      "!제외 0820   그날 통째로 빼기",
      DIVIDER,
      "!알림            현재 알림 설정",
      "!알림 요약 9시   그 시각에 오늘 일정",
      "!알림 임박 30분  일정 전에 한 번",
      "!알림 끄기 / 켜기",
      DIVIDER,
      "!웹          대시보드 주소",
      "!연결 <코드> 웹 계정 연결",
    ]);
  }

  return block("[M_Schedule] 명령어", [
    "!일정        이번 주 방 일정",
    "!일정 오늘   오늘 일정만",
    "!결정석      이번 주 결정석 수익",
    "!파티           내 파티 목록",
    "!파티연결 <번호>  이 방에 연결",
    "!숙제           남은 보스 20개",
    "!일정 다음주   다음 주 일정",
    "!제외 0820     그날 통째로 빼기",
    "!알림 09시/끄기 방 정기 알림 설정",
    /*
      두 줄로 갈랐다 — 이름이 다르면 하는 일도 다르다는 것이 도움말에서 먼저 보여야 한다
      (발주 지시 2026-08-20). 한 줄로 `!드랍(=!분배)` 라고 적어 두면 계산만 하려던 사람이
      원장에 기록을 남기게 된다.
    */
    "!분배 950 3 3%   계산만",
    "!드랍 950 3 3%   계산 + 기록",
    "!웹             대시보드 주소",
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
      /*
        개인톡은 **주인만** 연결할 수 있다. 파티방은 제한이 없다 — 여럿이 연결하는 것이
        그 방의 목적이다(§2.3 신원 해석은 `bot_channel_members` 뿐이다).
      */
      onlyUserId:
        context.channel.kind === "direct" ? context.channel.owner_user_id : undefined,
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
      "이제 !일정 !결정석 !숙제 를 쓸 수 있어요.",
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
  /*
    ★ **`!일정` 은 방이 아니라 사람을 본다** (발주 지시 2026-08-19):
      *"내 정보만 딱딱 깔끔하게 뜨는거지 파티방과 상관없이."*
      그래서 계정 연결이 **전제**다 — 누가 물었는지 모르면 보여 줄 것이 없다.
      방↔파티 바인딩은 이제 `!일정` 이 아니라 **알리미의 목적지**로만 쓰인다(§2.3).
  */
  if (account === null) {
    return { reply: needsLinkReply(), tag: "일정:미연결", userId: null };
  }

  const scope = parseDayScope(parsed.args[0]);
  if (scope === null) {
    return {
      reply: lines("언제인지 알아듣지 못했어요.", "!일정 · !일정 오늘 · !일정 목"),
      tag: "일정:범위불명",
      userId: account.userId,
    };
  }

  /*
    ★ **날짜를 언제나 적는다** — 주 단위 목록에서 `21:40` 만으로는 어느 날인지 알 수 없다.
      하루가 이미 제목에 있는 `!일정 오늘` / `!일정 내일` 만 시각으로 접는다.
  */
  const reference = scope.kind === "week" ? null : context.now;

  const all = await fetchMyRuns(context.db, account.userId, scope, context.now);
  /*
    ★ **이미 잡은 런은 뺀다** (발주 지시 2026-08-21: *"클리어된것도 보여줄필욘 없지"*).
      §1.1.1 이 못박은 원칙과 같다 — *"할 일 목록이지 트로피 진열장이 아니다."*
      카톡 평문에서는 더 그렇다. 줄마다 폭을 먹는데 다 잡은 줄은 읽는 사람이 할 일이 없다.
    ★ 거르는 것은 **여기**다. 조회는 표시만 하고 판단을 하지 않는다 — 전부 잡은 경우와
      애초에 일정이 없는 경우를 아래에서 다른 문구로 갈라야 하기 때문이다.
  */
  const runs = all.filter((run) => !run.cleared);
  const clearedRuns = all.filter((run) => run.cleared);
  /*
    제목의 리셋 시각도 **보고 있는 주차**를 따라가야 한다. `!일정 다음주` 인데 이번 주
    목요일이 적혀 있으면 이미 지난 경계를 가리키게 된다.
  */
  const title = `📅 ${scopeLabel(scope)} 일정 (${resetLabel(weekAnchor(scope, context.now))})`;

  if (runs.length === 0) {
    /*
      **"다 돌았다"와 "잡힌 게 없다"는 다른 사실이다.** 둘을 같은 문구로 접으면, 방금
      보스를 다 돈 사람이 "일정이 사라졌다"고 읽는다.
    */
    return clearedRuns.length > 0
      ? {
          reply: lines(
            title,
            DIVIDER,
            "남은 일정이 없습니다.",
            clearedSummary(clearedRuns, reference),
          ),
          tag: "일정:완료",
          userId: account.userId,
        }
      : {
          reply: lines(
            title,
            DIVIDER,
            "잡힌 일정이 없어요.",
            "웹에서 참가 등록을 하면 여기에 보입니다.",
          ),
          tag: "일정:빈",
          userId: account.userId,
        };
  }

  /*
    발주자가 그려 준 모양 그대로다.

      ⏰ 8/19(수) 21:40 ~ 22:40 · 1파티
      ···············
      익세 하대 하카 : 무르겨르
      노유 : 더저
      ───────────────

    한 캐릭터가 연달아 도는 보스를 **한 줄로** 접는 것이 요점이다 — 보스마다 캐릭터
    이름을 되풀이하면 실제로 다른 부분(보스)이 묻힌다.
  */
  const rendered = groupRuns(runs, reference).flatMap((group, index) => [
    // 묶음 사이는 빈 줄 하나로 가른다. 헤더 아래 점선은 뺐다 — 글꼴에 따라 따옴표처럼
    // 보이고(발주 지적 2026-08-19), 빈 줄만으로도 묶음 경계는 충분히 읽힌다.
    ...(index === 0 ? [] : [""]),
    groupHeader(group, context.now),
    ...group.lines,
  ]);

  /*
    숨긴 게 있으면 **한 줄로 밝힌다.** 안 적으면 목록이 짧아진 이유를 알 수 없어
    "왜 안 보이지"가 된다 — 숨기는 것 자체보다 말없이 숨기는 것이 문제다.
  */
  const footer =
    clearedRuns.length === 0 ? [] : [clearedSummary(clearedRuns, reference)];

  return {
    reply: lines(title, DIVIDER, ...clipList(rendered, 15), DIVIDER, ...footer),
    tag: "일정",
    userId: account.userId,
  };
}

/**
 * `⏰ 21:00 ~ 22:00 · 익검팟` — 시각·파티는 묶음마다 **한 번만** 적는다.
 *
 * ⚠️ 예전에는 **번호**(`1파티`)를 적었다. 그런데 번호는 방+주차 안에서만 유일해서 파티가
 *    하나뿐인 방에서는 모든 줄이 `1파티` 로 똑같이 찍혔다 — 발주 지적(2026-08-21):
 *    *"파티명을 알려주는게 나아보임 1파티 1파티 이렇게 나오는데"*. 번호는
 *    `!파티연결 <번호>` 처럼 **사람이 치는 입력**에 쓰이는 값이고, 읽는 사람에게 어느
 *    파티인지 알려 주는 것은 이름이다. 번호가 필요하면 `!파티` 가 목록으로 준다.
 */
function groupHeader(group: RunGroup, now: Date): string {
  const party = group.partyName === "" ? "" : ` · ${group.partyName}`;

  // 임박 표시는 시각이 있을 때만. 평문에는 색이 없으므로 `⏰` 가 그 역할을 한다.
  const soon =
    group.startAt !== null &&
    group.startAt.getTime() - now.getTime() <= SOON_MS &&
    group.startAt.getTime() >= now.getTime();

  return `${soon ? "⏰ " : "· "}${group.range}${party}`;
}

/**
 * `클리어한 일정 3개 - 보스 7개` — 숨긴 것을 **두 단위로** 센다.
 *
 * 발주 지시(2026-08-22): *"잡은 7건 숨김 보다 / 클리어한 일정2개 - 보스 7개 / 이렇게 해라"*.
 *
 * 두 숫자가 필요한 이유: 이 앱에서 **"일정"과 "보스"는 다른 단위**다. 이어 도는 보스 셋은
 * 한 번 모이는 **하나의 약속**이고(그래서 목록도 한 묶음으로 접는다), 결정석 12칸을
 * 소모하는 것은 **보스 하나하나**다. `7건` 처럼 한 숫자만 적으면 그 둘 중 어느 쪽인지
 * 알 수 없다.
 *
 * ★ 묶음 수는 **목록을 그리는 것과 같은 함수**(`groupRuns`)로 센다. 따로 세면 화면에
 *   보이던 묶음 수와 요약의 숫자가 갈라진다.
 */
function clearedSummary(
  cleared: readonly MyRun[],
  reference: Date | null,
): string {
  const groups = groupRuns(cleared, reference).length;
  return `클리어한 일정 ${String(groups)}개 - 보스 ${String(cleared.length)}개`;
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
      // 오프셋이 늘어나도 문구가 따라오게 계산으로 낸다 — 표를 두 벌 관리하지 않는다.
      if (scope.weekOffset === 0) return "이번 주";
      if (scope.weekOffset === 1) return "다음 주";
      return `${String(scope.weekOffset)}주 뒤`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// !드랍 / !분배 — 경매장 수수료를 두 번 내는 구조를 풀어 준다
// ─────────────────────────────────────────────────────────────────────────────
//
// 계산과 그 근거는 `lib/domain/drop-split.ts` 머리말에 있다. 여기서는 **읽고 그리기만** 한다.
//
// ★ **두 명령의 차이는 기록 여부 하나뿐이다** (발주 지시 2026-08-20:
//   *"!드랍 은 저장 기능을 부여하고 !분배 는 저장을 빼"*).
//     · `!드랍` — 계산 + 원장 기록(`run_drops`). 실제로 판 뒤에 남기는 말이다.
//     · `!분배` — **계산만.** "얼마씩 올리지?" 는 묻는 말이라 원장에 남을 이유가 없다.
//       계산기로 물어본 것이 조용히 수익으로 잡히면 그 주 정산이 사실과 어긋난다.
//   숫자와 문구는 이 한 함수가 그대로 갖는다. 두 벌로 나누면 방에 나가는 답이 갈라진다.

interface DropSplitMode {
  /** 원장(`run_drops`)에 남길 것인가. `!분배` 는 `false` 다. */
  readonly record: boolean;
}

async function handleDropSplit(
  context: CommandContext,
  parsed: ParsedCommand,
  account: BotAccount | null,
  mode: DropSplitMode,
): Promise<CommandOutcome> {
  /*
    사용법은 **사용자가 친 이름 그대로** 돌려준다. `!분배` 를 쳤는데 `!드랍 …` 사용법이
    나오면 방금 친 명령이 틀린 것으로 읽힌다.
  */
  const name = mode.record ? "!드랍" : "!분배";
  const usage = lines(
    `${name} <판매액> <인원> [수수료]`,
    `${name} <보스> <판매액> <인원> [수수료]`,
    `예: ${name} 950 3 3%  ·  ${name} 하카 955.5 2`,
    "금액은 억 단위, 소수도 됩니다. 수수료 생략 시 3%.",
    mode.record
      ? "기록까지 남깁니다. 계산만 보려면 !분배 를 쓰세요."
      : "계산만 합니다. 수익으로 기록하려면 !드랍 을 쓰세요.",
  );

  if (parsed.args[0] === "취소" || parsed.args[0] === "삭제") {
    /*
      `!분배` 는 애초에 남기는 것이 없으므로 지울 것도 없다. 여기서 `handleDropCancel`
      을 그대로 부르면 **`!드랍` 으로 남긴 기록이 지워진다** — 계산만 하는 명령이 원장을
      건드리는 셈이라, 그게 이번 분리에서 가장 조심해야 할 자리다.
    */
    if (!mode.record) {
      return {
        reply: lines(
          "!분배 는 계산만 해서 취소할 것이 없어요.",
          "기록을 지우려면 !드랍 취소 를 쓰세요.",
        ),
        tag: "분배:취소없음",
        userId: account?.userId ?? null,
      };
    }
    return handleDropCancel(context, account);
  }

  /*
    첫 토막이 금액이면 보스 생략, 아니면 보스 이름이다. 방에서 `!드랍 하카 950 3` 과
    `!드랍 950 3` 을 둘 다 자연스럽게 치기 때문에 앞에서 갈라 준다.
  */
  const bossToken = parseEok(parsed.args[0]) === null ? parsed.args[0] : undefined;
  const rest = bossToken === undefined ? parsed.args : parsed.args.slice(1);

  const grossMeso = parseEok(rest[0]);
  const people = Number.parseInt(rest[1] ?? "", 10);
  // 경매장 수수료는 3% 가 기본값이다. 매번 적게 하면 그게 곧 안 쓰는 이유가 된다.
  const feeRate = rest[2] === undefined ? 0.03 : parseFeeRate(rest[2]);

  if (grossMeso === null || !Number.isInteger(people) || people < 1 || feeRate === null) {
    return { reply: usage, tag: "드랍:사용법", userId: account?.userId ?? null };
  }
  if (people > 12) {
    return {
      reply: lines("인원이 너무 많아요(최대 12).", "!드랍 950 3 3%"),
      tag: "드랍:인원과다",
      userId: account?.userId ?? null,
    };
  }

  const split = computeDropSplit({ grossMeso, people, feeRate });
  const feeText = `${String(Math.round(feeRate * 1000) / 10)}%`;
  const head = `💰 ${formatEok(grossMeso)} · ${String(people)}인 · 수수료 ${feeText}`;

  if (people === 1) {
    return {
      reply: lines(head, DIVIDER, `실수령 ${formatEok(split.leaderReceivesMeso)}`, DIVIDER),
      tag: "드랍:단독",
      userId: account?.userId ?? null,
    };
  }

  const calc = [
    head,
    DIVIDER,
    `판매자 실수령 ${formatEok(split.leaderReceivesMeso)}`,
    "",
    "파티원 각자 올릴 금액",
    `  ${formatEok(split.listPriceMeso)}`,
    /*
      메소 원값은 괄호도 쉼표도 없이 한 줄을 통째로 쓴다(발주 지시 2026-08-19) — 읽으라고
      있는 것이 아니라 **게임에 그대로 붙여 넣으라고** 있다.
    */
    `  ${String(split.listPriceMeso)}`,
    "",
    `→ ${String(people)}명 모두 ${formatEok(split.eachFinalMeso)}`,
  ];

  /*
    여기서 멈추는 경우가 둘이다.
      · `!분배` — **기록하지 않는 명령**이다(위 머리말). 계정이 연결돼 있어도 계산만 한다.
      · 계정 미연결 — 누구 수익인지 모르는 채로 원장에 남길 수 없다.
    답장은 같은 계산 블록을 그대로 쓴다. 다른 것은 아래 `📒` 기록 줄이 붙느냐뿐이다.
  */
  if (!mode.record) {
    return {
      reply: lines(...calc, DIVIDER),
      tag: "분배:계산만",
      userId: account?.userId ?? null,
    };
  }
  if (account === null) {
    return { reply: lines(...calc, DIVIDER), tag: "드랍:계산만", userId: null };
  }

  /*
    ★ **여기서부터가 원장이다.** 런 하나가 (파티 · 날짜 · 보스)를 전부 들고 있으므로
      드랍은 런만 가리키면 된다(발주 설명 2026-08-19).
  */
  const target = await findDropTargetRun(
    context.db,
    context.channel.id,
    account.userId,
    bossToken,
    context.now,
  );
  if (target === null) {
    return {
      reply: lines(
        ...calc,
        DIVIDER,
        // **왜** 못 붙였는지 말한다. "기록 실패" 만으로는 사용자가 할 수 있는 일이 없다.
        "기록은 못 했어요 — 아직 시작한 판이 없습니다.",
        "이미 돈 판이 있으면 !드랍 하카 950 3 처럼 보스를 적어 주세요.",
      ),
      tag: "드랍:런없음",
      userId: account.userId,
    };
  }

  /*
    ★ **원장에 넣는 금액은 "각자 실제로 손에 쥐는 것의 합"** 이다. 총 판매액이 아니다 —
      수수료를 두 번 떼고 나면 파티에 실제로 들어오는 돈은 그보다 적고, 총액을 그대로
      쌓으면 대시보드가 있지도 않은 수익을 보여 준다.
    ⚠️ 분배는 **런의 going 인원**으로 나뉜다. 사용자가 적은 인원과 다르면 금액이 달라지므로
      그 사실을 답장에 적는다 — 조용히 한쪽을 고르지 않는다.
  */
  const recipients = target.goingCount > 0 ? target.goingCount : people;
  const potMeso = split.eachFinalMeso * recipients;
  const dropId = await recordDrop(
    context.db,
    {
      runId: target.runId,
      participantId: target.participantId,
      // 판의 보스 조합이 그대로 기록 이름이 된다 — 원장을 봐도 어느 판인지 읽힌다.
      itemName: `${target.bossName} 드랍`,
      potMeso,
      note: `판매 ${formatEok(grossMeso)} · ${String(people)}인 · 수수료 ${feeText}`,
    },
    context.now,
  );
  if (dropId === null) {
    return {
      reply: lines(...calc, DIVIDER, "계산은 됐지만 기록에 실패했어요."),
      tag: "드랍:기록실패",
      userId: account.userId,
    };
  }

  const when =
    target.scheduledAt === null ? "시간미정" : formatDayKeyKo(kstDayKey(target.scheduledAt));

  return {
    reply: lines(
      ...calc,
      DIVIDER,
      `📒 ${target.partyName} · ${when} ${target.bossName}`,
      `수익 ${formatEok(potMeso)} 을 ${String(recipients)}명에게 기록했어요.`,
      recipients === people
        ? null
        : `⚠️ 적어 주신 ${String(people)}인과 일정 참가 ${String(recipients)}명이 달라요.`,
      "되돌리려면 !드랍 취소",
      DIVIDER,
    ),
    tag: "드랍:기록",
    userId: account.userId,
  };
}

/**
 * `!드랍 취소` — 내가 방금 기록한 드랍을 지운다.
 *
 * 웹 삭제는 이번 범위 밖이라(발주 지시), 방에서 되돌릴 길이 없으면 오타 한 번이 영구
 * 기록이 된다. 그래서 최소한의 취소를 함께 연다. **내가 기록한 것만** 지워진다.
 */
async function handleDropCancel(
  context: CommandContext,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  if (account === null) {
    return { reply: needsLinkReply(), tag: "드랍취소:미연결", userId: null };
  }
  const removed = await deleteMyLatestDrop(
    context.db,
    context.channel.id,
    account.userId,
    context.now,
  );
  return {
    reply:
      removed === null
        ? lines("이번 주에 기록한 드랍이 없어요.")
        : lines(
            `🗑 ${removed.itemName} 기록을 지웠어요.`,
            removed.potMeso === null ? null : `(${formatEok(removed.potMeso)})`,
          ),
    tag: removed === null ? "드랍취소:없음" : "드랍취소",
    userId: account.userId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// !알림 — 파티별 "몇 분 전 · 몇 회"
// ─────────────────────────────────────────────────────────────────────────────
//
// 발주 지시(2026-08-19): *"알리미 있어야지 (…) 파티별로?"* — 파티별이 맞다. 한 방에 파티가
// 여럿일 수 있고(`party_room_numbers` 가 `1파티`·`2파티` 를 주는 이유), 사람 구성이 다르면
// 알림 시점도 다를 수 있다.
//
// ★ 값 검증은 DB CHECK(`valid_reminder_minutes`)이 갖는다 — 최대 5회 · 1~1440분 · 중복 없음.
//   여기서는 **숫자로 읽히는지**만 보고 나머지는 DB 가 거절하게 둔다. 규칙을 두 곳에 적으면
//   웹에서 고칠 때 한쪽만 고치는 사고가 난다.

/**
 * `"30분 · 10분 전"` · 꺼져 있으면 `"없음"`.
 *
 * ★ **접미사 `전` 은 이 함수가 붙인다.** 호출부에서 `${remindersText(...)} 전` 처럼
 *   밖에서 붙이면 끄어 둔 파티가 **"없음 전"** 으로 나온다(발주 보고 2026-08-31).
 *   접미사는 값에 딸린 것이니 값을 정하는 자리에서 같이 정해야 세 호출부가 갈라지지 않는다.
 *   개인톡 쪽 `directPrefLines` 도 이미 같은 규칙을 따른다(`"없음"` vs `"30분 전"`).
 */
function remindersText(minutes: readonly number[]): string {
  if (minutes.length === 0) return "없음";
  // 큰 값이 먼저 오는 것이 시간 순서다(60분 전 → 10분 전).
  return `${[...minutes]
    .sort((a, b) => b - a)
    .map((m) => `${String(m)}분`)
    .join(" · ")} 전`;
}

async function handleReminders(
  context: CommandContext,
  parsed: ParsedCommand,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  if (account === null) {
    return { reply: needsLinkReply(), tag: "알림:미연결", userId: null };
  }

  /*
    ★ ═══════════════════════════════════════════════════════════════════════════
      **개인톡에서는 같은 명령이 다른 것을 뜻한다** (발주 지시 2026-08-31)
      ═══════════════════════════════════════════════════════════════════════════
      *"!알림으로 설정가능하도록. 내 캐릭터 파티 상관없이 모든 일정을 전부"*

      파티방의 `!알림` 은 **방**을 설정한다(이 방 정기 시각 · 이 방 파티별 오프셋).
      개인톡의 `!알림` 은 **사람**을 설정한다(내 모든 일정의 요약 시각 · 임박 리드타임).
      이름이 같은 것이 맞다 — 사람이 알고 싶은 것("나한테 언제 알려 줄래")은 하나이고,
      방의 성격이 그 답을 정한다. `!개인알림` 같은 두 번째 이름을 만들면 어느 방에서
      무엇을 쳐야 하는지 사람이 외워야 한다.
  */
  if (context.channel.kind === "direct") {
    return handleDirectAlerts(context, parsed, account);
  }

  /*
    ★ **두 축이 한 명령에 산다.**
        `!알림 09시 18시`   → 이 **방**의 정기 알림 시각 (그날 일정을 그때 한 번)
        `!알림 1 30 10`     → **파티** 1 의 런 오프셋 (런마다 30분·10분 전)
      토큰 모양으로 가른다 — 시각은 `시` 나 `:` 를 달고 있고 오프셋은 맨 숫자다.
      `30` 이 "30분 전"인지 "30시"인지 헷갈릴 일이 없어야 하므로 시각 표기를 강제한다
      (`lib/command-parse.ts` 의 `parseClockMinute` 머리말).
  */
  const clockMinutes = parsed.args.map((token) => parseClockMinute(token));
  const allClock = parsed.args.length > 0 && clockMinutes.every((m) => m !== null);
  /*
    ★ **끄는 길이 이름을 가져야 한다** (발주 보고 2026-08-31: *"정기 알림 끄는방법이 없어"*).
      예전에는 `!알림 시각 끄기` 만 받았는데, 그 두 단어 조합은 **어느 화면에도 적혀 있지
      않았다.** 사람이 자연스럽게 치는 `!알림 끄기` 는 이름으로 파티를 찾다 실패해
      "그 번호의 파티를 찾지 못했어요" 로 떨어졌다 — 끄겠다는 의도가 없는 명령이 아니라
      받아 주지 않은 것이다.
      방에서 맨몸 `끄기` 가 가리킬 수 있는 것은 **방 설정인 정기 알림** 뿐이다. 파티별
      오프셋은 저마다 번호가 있고(`!알림 1 끄기`), 번호 없이 전부 끄는 해석은 한 줄로
      여러 사람의 설정을 날리므로 위험하다. 그래서 정기만 끄고, 파티 알림은 그대로라고
      **답장에서 명시한다.**
  */
  const offToken = (token: string | undefined): boolean =>
    token === "끄기" || token === "없음" || token === "off";
  const clearDigest =
    (parsed.args.length === 1 && offToken(parsed.args[0])) ||
    (parsed.args.length === 2 &&
      (parsed.args[0] === "시각" || parsed.args[0] === "시간") &&
      offToken(parsed.args[1]));

  if (allClock || clearDigest) {
    const minutes = clearDigest
      ? []
      : [...new Set(clockMinutes.filter((m): m is number => m !== null))];
    await setChannelDigestMinutes(context.db, context.channel.id, minutes);
    return {
      reply: lines(
        minutes.length === 0
          ? "🔕 이 방의 정기 알림을 껐어요."
          : `🔔 이 방에 매일 ${minutes
              .slice()
              .sort((a, b) => a - b)
              .map(formatClockMinute)
              .join(" · ")} 에 그날 일정을 보낼게요.`,
        // 그날 일정이 없으면 아예 보내지 않는다는 사실을 미리 말해 둔다.
        minutes.length === 0
          ? "파티별 런 알림은 그대로예요. (!알림 1 끄기)"
          : "일정이 없는 날은 보내지 않아요.",
      ),
      tag: minutes.length === 0 ? "알림:정기끄기" : "알림:정기설정",
      userId: account.userId,
    };
  }

  /*
    ★ `끄기` 를 안내했으면 `켜기` 도 받아야 한다 — 단, 몇 시인지 모르면 켜줄 수가 없다.
      예전 시각을 기억해 두었다가 되살리는 방법도 있지만, 방 설정은 여러 사람이 건드리므로
      "누가 언제 둔 값"이 되살아나는 편이 더 놓친다. 그래서 되묻는다.
  */
  if (parsed.args.length === 1 && (parsed.args[0] === "켜기" || parsed.args[0] === "on")) {
    return {
      reply: lines("몇 시에 보낼까요?", "예: !알림 18시 · !알림 09시 18시"),
      tag: "알림:정기켜기문의",
      userId: account.userId,
    };
  }

  const [parties, digestMinutes] = await Promise.all([
    listBotParties(context.db, account.userId, context.channel.id, context.now),
    fetchChannelDigestMinutes(context.db, context.channel.id),
  ]);
  const digestText =
    digestMinutes.length === 0
      ? "없음"
      : digestMinutes.slice().sort((a, b) => a - b).map(formatClockMinute).join(" · ");

  /*
    ★ **방 명령은 그 방 것만 보여 준다** (발주 지시 2026-08-31:
      *"너무 쓸때없이 많은 정보를 알려줌. 이방 설정만 알려주면 될듯"*).
      예전에는 내가 낀 파티를 전부 세우고 대부분에 `(방 미연결)` 을 달았는데, 그
      줄들은 **여기서 할 수 있는 일이 아니다** — 이 방으로 알림이 나가지도 않고,
      방을 옮기는 것은 `!파티연결` 의 일이다. 열 줄 중 아홉 줄이 "여기 것 아님"이면
      정작 읽혀야 할 한 줄이 묻힌다.
      전체 목록이 필요한 자리는 `!파티` 가 이미 갖고 있다 — 거기서는 미연결이 **정보**다
      (연결하려고 보는 화면이니까). 그래서 `!파티` 는 그대로 둔다.
  */
  const roomParties = parties.filter((party) => party.boundHere);

  // 인자가 없으면 현재 설정을 보여 준다.
  if (parsed.args.length === 0) {
    if (roomParties.length === 0) {
      return {
        reply: block("🔔 알림 설정", [
          `이 방 정기 — ${digestText}`,
          DIVIDER,
          "이 방에 연결된 파티가 없어요.",
          ...partyUsage(),
          DIVIDER,
          "!알림 09시 18시 → 그 시각에 그날 일정",
          digestMinutes.length === 0 ? null : "!알림 끄기      → 이 방 정기 알림 없음",
        ]),
        tag: "알림:빈",
        userId: account.userId,
      };
    }
    const rendered = roomParties.map(
      (party, index) =>
        `${String(index + 1)}. ${party.name} — ${remindersText(party.reminderMinutes)}`,
    );
    return {
      reply: block("🔔 알림 설정", [
        `이 방 정기 — ${digestText}`,
        DIVIDER,
        /*
          ★ **7 → 6.** 안내 한 줄이 늘면서 최악의 경우(파티 7개 · 오프셋 2개씩)가
            351자가 되어 350자 예산을 넘기면서 **마지막 안내 줄이 잘렸다**(실측).
            하필 방금 추가한 "끄는 방법"이 잘리는 자리라 목록을 한 줄 줄였다 —
            잘린 줄은 `…외 N건` 으로 살아 있지만 안내는 사라지면 복구할 길이 없다.
        */
        ...clipList(rendered, 6),
        DIVIDER,
        "!알림 09시 18시 → 그 시각에 그날 일정",
        digestMinutes.length === 0 ? null : "!알림 끄기      → 이 방 정기 알림 없음",
        "!알림 1 30 10   → 런 30분·10분 전",
        "!알림 1 끄기    → 그 파티 알림 없음",
      ]),
      tag: "알림",
      userId: account.userId,
    };
  }

  /*
    ★ **번호는 위 목록의 번호다.** 화면에 없는 줄에 번호가 붙어 있으면 `!알림 3` 이
      보이지도 않는 파티를 건드린다. 반면 **이름**은 방 밖까지 허용한다 — 이름을 정확히
      친 사람은 그 파티를 지목한 것이고, 알림 회차는 방이 아니라 **파티**의 설정이기 때문이다
      (미연결 경고는 아래 응답에 그대로 붙는다).
  */
  const pickToken = parsed.args[0] ?? "";
  const target =
    pickParty(roomParties, pickToken) ??
    (/^\d+$/u.test(pickToken.trim()) ? null : pickParty(parties, pickToken));
  if (target === null) {
    return {
      reply: lines("그 번호(또는 이름)의 파티를 찾지 못했어요.", "!알림 으로 번호를 확인해 주세요."),
      tag: "알림:미발견",
      userId: account.userId,
    };
  }

  const rest = parsed.args.slice(1);
  if (rest.length === 0) {
    return {
      reply: lines(
        `${target.name} — 현재 ${remindersText(target.reminderMinutes)}`,
        "!알림 1 30 10 처럼 분을 적어 주세요. (끄려면 끄기)",
      ),
      tag: "알림:조회",
      userId: account.userId,
    };
  }

  const off = rest.some((token) => token === "끄기" || token === "없음" || token === "off");
  let minutes: number[] = [];
  if (!off) {
    for (const token of rest) {
      const value = Number.parseInt(token.replace(/분$/u, ""), 10);
      if (!Number.isFinite(value)) {
        return {
          reply: lines(`"${token}" 을(를) 분으로 읽지 못했어요.`, "예: !알림 1 30 10"),
          tag: "알림:값불명",
          userId: account.userId,
        };
      }
      minutes.push(value);
    }
    minutes = [...new Set(minutes)];
  }

  const saved = await setPartyReminders(
    context.db,
    account.userId,
    target.partyId,
    minutes,
  );
  if (!saved) {
    return {
      reply: lines("그 파티의 구성원이 아니에요."),
      tag: "알림:권한없음",
      userId: account.userId,
    };
  }

  return {
    reply: lines(
      `${minutes.length === 0 ? "🔕" : "🔔"} ${target.name} — ${remindersText(minutes)}`,
      target.boundHere || target.boundElsewhere
        ? null
        : "⚠️ 이 파티는 방에 연결돼 있지 않아 알림이 나가지 않아요. !파티연결 로 연결해 주세요.",
    ),
    tag: "알림:설정",
    userId: account.userId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// `!알림` — 개인톡판. **내 모든 일정**의 요약·임박 설정
// ─────────────────────────────────────────────────────────────────────────────
//
// 발주 지시(2026-08-31): *"내가 등록한 모든 일정에 대한 알림. 오늘 몇건 오늘 몇시 둘다.
// 직접지정"* · *"!알림으로 설정가능하도록"*
//
// 문법:
//   !알림                 현재 설정
//   !알림 켜기 / 끄기      전체 스위치
//   !알림 요약 9시         오늘 요약 시각 (오전9시 · 오후9시 · 09:00 · 21시 전부 됨)
//   !알림 요약 끄기        요약만 끄기
//   !알림 임박 30분        임박 리드타임
//   !알림 임박 끄기        임박만 끄기
//
// ★ **끄기가 두 층이다.** 전체 스위치(`enabled`)는 시각 설정을 **지우지 않으므로**,
//   여행 갔다 와서 `!알림 켜기` 만 치면 예전 설정이 그대로 돌아온다. 항목별 끄기는
//   그 항목만 `null` 로 만든다. 하나로 합치면 "잠깐 꺼 두기"를 할 수 없다.
// ★ 파싱은 **관대하게, 답장은 되읽어서**(§2.2 · `command-parse.ts` 머리말). 무엇으로
//   알아들었는지 매번 다시 적어 주므로 오해가 그 자리에서 잡힌다.

/** 항목을 끄는 말들. 사람마다 다르게 치므로 넓게 받는다. */
const OFF_TOKENS = new Set(["끄기", "끔", "off", "없음", "안함", "해제", "중지"]);
/** 항목을 켜는 말들. */
const ON_TOKENS = new Set(["켜기", "켬", "on", "시작", "다시"]);

async function handleDirectAlerts(
  context: CommandContext,
  parsed: ParsedCommand,
  account: BotAccount,
): Promise<CommandOutcome> {
  const arg0 = (parsed.args[0] ?? "").toLowerCase();
  /*
    ★ **값은 남은 토막을 전부 이어 붙인 것**이다. `!알림 요약 오전 9시` 처럼 사람이 띄어
      쓰면 `parseCommand` 가 `["요약","오전","9시"]` 로 잘라 놓는데, 두 번째 토막만 보면
      `오전` 을 시각으로 읽으려다 실패한다. 붙여 놓으면 `오전9시` 가 되고, 파서는 어차피
      공백을 제거하고 비교하므로 붙인 형태가 정답이다.
      (`!알림 임박 30 분` → `30분` 도 같은 이유로 통과한다.)
  */
  const value = parsed.args.slice(1).join("");
  const arg1 = value.toLowerCase();

  // 인자가 없으면 현재 설정을 보여 준다.
  if (parsed.args.length === 0) {
    const [prefs, granted] = await Promise.all([
      fetchNotificationPrefs(context.db, account.userId),
      isDirectGranted(context.db, account.userId),
    ]);
    return {
      reply: block("🔔 개인 알림", [
        ...directPrefLines(prefs),
        /*
          명단에서 빠졌는데 방은 남아 있는 상태. 알림은 이미 멈춰 있으므로 **왜 안 오는지**
          를 말해 주지 않으면 사용자는 봇이 고장 났다고 읽는다.
        */
        granted ? null : "⚠️ 개인톡 알림 사용 권한이 없어 지금은 나가지 않아요.",
        DIVIDER,
        "!알림 요약 9시   그 시각에 오늘 일정",
        "!알림 임박 30분  일정 전에 한 번",
        "!알림 끄기       잠시 전부 끄기",
      ]),
      tag: "알림:개인",
      userId: account.userId,
    };
  }

  // !알림 켜기 / !알림 끄기 — 전체 스위치
  if (ON_TOKENS.has(arg0) || OFF_TOKENS.has(arg0)) {
    const enabled = ON_TOKENS.has(arg0);
    const prefs = await saveNotificationPrefs(context.db, account.userId, { enabled });
    return {
      reply: lines(
        enabled ? "🔔 개인 알림을 켰어요." : "🔕 개인 알림을 껐어요.",
        // 껐다고 시각을 지우지 않는다는 사실을 말해 준다 — 다시 켤 때 안심할 수 있게.
        enabled ? directPrefLines(prefs).join("\n") : "설정은 그대로 두었어요. !알림 켜기 로 되돌립니다.",
      ),
      tag: enabled ? "알림:개인켜기" : "알림:개인끄기",
      userId: account.userId,
    };
  }

  // !알림 요약 …
  if (arg0 === "요약" || arg0 === "오늘" || arg0 === "다이제스트") {
    if (arg1 === "") {
      return {
        reply: lines("요약을 몇 시에 보낼까요?", "예: !알림 요약 9시 · !알림 요약 오후9시 · !알림 요약 끄기"),
        tag: "알림:개인요약불명",
        userId: account.userId,
      };
    }
    if (OFF_TOKENS.has(arg1)) {
      await saveNotificationPrefs(context.db, account.userId, { digestAtMinutes: null });
      return {
        reply: lines("🔕 오늘 요약을 껐어요.", "임박 알림은 그대로예요."),
        tag: "알림:개인요약끄기",
        userId: account.userId,
      };
    }
    const minute = parseClockMinute(value);
    if (minute === null) {
      return {
        reply: lines(
          `"${parsed.args.slice(1).join(" ")}" 을(를) 시각으로 읽지 못했어요.`,
          "9시 · 09:00 · 오전9시 · 오후9시 · 21시 처럼 적어 주세요.",
        ),
        tag: "알림:개인요약불명",
        userId: account.userId,
      };
    }
    await saveNotificationPrefs(context.db, account.userId, { digestAtMinutes: minute });
    return {
      reply: lines(
        `🔔 매일 ${formatClockMinute(minute)} 에 그날 남은 일정을 보낼게요.`,
        // 조용한 날 아무 말도 없는 것이 고장이 아니라는 것을 미리 말해 둔다.
        "일정이 없는 날은 보내지 않아요.",
      ),
      tag: "알림:개인요약설정",
      userId: account.userId,
    };
  }

  // !알림 임박 …
  if (arg0 === "임박" || arg0 === "리드" || arg0 === "미리" || arg0 === "전") {
    if (arg1 === "") {
      return {
        reply: lines("일정 몇 분 전에 알릴까요?", "예: !알림 임박 30분 · !알림 임박 끄기"),
        tag: "알림:개인임박불명",
        userId: account.userId,
      };
    }
    if (OFF_TOKENS.has(arg1)) {
      await saveNotificationPrefs(context.db, account.userId, { leadMinutes: null });
      return {
        reply: lines("🔕 임박 알림을 껐어요.", "오늘 요약은 그대로예요."),
        tag: "알림:개인임박끄기",
        userId: account.userId,
      };
    }
    const minutes = parseLeadMinutes(value);
    if (minutes === null) {
      return {
        reply: lines(
          `"${parsed.args.slice(1).join(" ")}" 을(를) 분으로 읽지 못했어요.`,
          "1~1440 사이로 적어 주세요. 예: !알림 임박 30분",
        ),
        tag: "알림:개인임박불명",
        userId: account.userId,
      };
    }
    await saveNotificationPrefs(context.db, account.userId, { leadMinutes: minutes });
    return {
      reply: lines(
        `🔔 일정 ${String(minutes)}분 전에 알릴게요.`,
        /*
          ⚠️ **과장하지 않는다.** 크론이 10분 주기라 실제로는 그 사이 어딘가에 온다.
             "정확히 30분 전"이라고 적으면 매번 틀린 말이 되고, 사용자는 알림이 고장
             났다고 읽는다.
        */
        "확인 주기가 10분이라 조금 이르게 올 수 있어요.",
      ),
      tag: "알림:개인임박설정",
      userId: account.userId,
    };
  }

  // 알아듣지 못한 인자. **조용히 무시하지 않고** 쓸 수 있는 문법을 보여 준다.
  return {
    reply: block("🔔 개인 알림", [
      `"${parsed.args.join(" ")}" 은(는) 알아듣지 못했어요.`,
      DIVIDER,
      "!알림           현재 설정",
      "!알림 요약 9시   그 시각에 오늘 일정",
      "!알림 임박 30분  일정 전에 한 번",
      "!알림 끄기 / 켜기",
    ]),
    tag: "알림:개인불명",
    userId: account.userId,
  };
}

/** 현재 설정 두 줄. 켜짐/꺼짐과 두 항목을 **매번 같은 모양**으로 되읽어 준다. */
function directPrefLines(prefs: NotificationPrefs): readonly string[] {
  if (!prefs.enabled) {
    return ["전체 — 꺼짐 (!알림 켜기 로 다시 켜요)"];
  }
  return [
    `오늘 요약 — ${
      prefs.digestAtMinutes === null ? "없음" : formatClockMinute(prefs.digestAtMinutes)
    }`,
    `임박 알림 — ${prefs.leadMinutes === null ? "없음" : `${String(prefs.leadMinutes)}분 전`}`,
  ];
}

/**
 * `30` · `30분` → 30. 범위 밖이나 숫자가 아니면 `null`.
 *
 * ⚠️ 시각(`parseClockMinute`)과 달리 **맨 숫자를 받는다.** 여기서는 `임박` 이라는
 *    앞 토막이 이미 뜻을 정해 놓았으므로 `30` 이 "30시"로 읽힐 여지가 없다.
 */
function parseLeadMinutes(token: string | undefined): number | null {
  if (token === undefined) return null;
  const value = Number.parseInt(token.replace(/분\s*(전)?$/u, ""), 10);
  if (!Number.isFinite(value)) return null;
  if (value < 1 || value > 1440) return null;
  return value;
}

// ─────────────────────────────────────────────────────────────────────────────
// !제외 · !제외해제
// ─────────────────────────────────────────────────────────────────────────────
//
// 발주 지시(2026-08-19): *"!제외 0820 하면 그날에 제외사항 만들어주도록해"*
//
// ★ **뺄셈 전용이고 그게 전부다**(§1.4). 사유도, "대신 이 시간엔 됨"도 없다. 하루 전체를
//   빼는 것만 받는다 — 시간대 지정은 웹에서 한다.
// ★ 저장은 웹과 **같은 함수**(`createMyAvailabilityException`)가 한다. 하루 전체를
//   `0 ~ 1440` 한 가지로만 적는 규칙이 거기 있고, 여기서 다시 적으면 표현이 둘이 된다.
// ★ 되돌리는 길을 같이 연다. 방에서 날짜를 잘못 치는 일은 반드시 일어나는데, 지울 방법이
//   웹밖에 없으면 그 순간 "웹 왔다갔다"가 다시 시작된다.

async function handleExclude(
  context: CommandContext,
  parsed: ParsedCommand,
  account: BotAccount | null,
  add: boolean,
): Promise<CommandOutcome> {
  const label = add ? "제외" : "제외해제";
  if (account === null) {
    return { reply: needsLinkReply(), tag: `${label}:미연결`, userId: null };
  }

  const dayKey = parseDateToken(parsed.args[0], context.now);
  if (dayKey === null) {
    return {
      reply: lines(
        "날짜를 알아듣지 못했어요.",
        `!${label} 0820  ·  !${label} 8/20  ·  !${label} 2026-08-20`,
      ),
      tag: `${label}:날짜불명`,
      userId: account.userId,
    };
  }

  const pretty = formatDayKeyKo(dayKey);
  const existing = await findMyAvailabilityExceptionsOn(account.userId, dayKey);

  if (!add) {
    const removed = await deleteMyAvailabilityExceptionsOn(account.userId, dayKey);
    return {
      reply: lines(
        removed === 0
          ? `${pretty} 에는 제외가 없었어요.`
          : `${pretty} 제외를 풀었어요.`,
      ),
      tag: removed === 0 ? "제외해제:없음" : "제외해제",
      userId: account.userId,
    };
  }

  // 같은 뜻의 행을 두 번 쌓지 않는다.
  if (existing.length > 0) {
    return {
      reply: lines(
        `${pretty} 은(는) 이미 제외돼 있어요.`,
        `풀려면 !제외해제 ${parsed.args[0] ?? dayKey}`,
      ),
      tag: "제외:이미",
      userId: account.userId,
    };
  }

  // `startMinute`/`endMinute` 을 비우면 하루 전체(0~1440)다.
  await createMyAvailabilityException(account.userId, {
    dayKey,
    startMinute: null,
    endMinute: null,
  });

  return {
    reply: lines(
      `🚫 ${pretty} 하루를 제외했어요.`,
      "이 날은 겹쳐보기에서 빠집니다.",
    ),
    tag: "제외",
    userId: account.userId,
  };
}

/** `2026-08-20` → `8/20(목)`. 되읽어 확인시키는 용도라 연도는 접는다. */
function formatDayKeyKo(dayKey: string): string {
  const at = new Date(`${dayKey}T12:00:00+09:00`);
  return `${formatKst(at, "M/d")}(${kstWeekdayKo(at)})`;
}

// ─────────────────────────────────────────────────────────────────────────────
// !숙제 — 이번 주에 **아직 안 잡은 보스**
// ─────────────────────────────────────────────────────────────────────────────
//
// 발주 지시(2026-09-02): *"!결정석 20의 기능을 !숙제로 옮기고 !숙제에 대한것을 전부 삭제.
// 그냥 무조건 20개 있는만큼 보여줘."*
//
// ── 예전 `!숙제` 는 어디로 갔나 ──────────────────────────────────────────────
// 일퀘 · 몬파 · 수로 · 에픽 O/X 였다. **판정과 웹 화면은 그대로 살아 있다**
// (`lib/domain/chore-status.ts` · `bot-repo.fetchChoreBoard` · `/chores`). 사라진 것은
// **방에서 부르는 길**뿐이다 — `!숙제` 라는 이름이 이 목록으로 넘어왔다.
//
// 이름이 이렇게 정해진 이유는 방에서 "이번 주 숙제"가 뜻하는 것이 결정석 도는 일이기
// 때문이다. 일퀘·몬파는 매일 하는 것이라 목록으로 물어볼 일이 없고, 수로·에픽 체크는
// 웹에서 누르는 편이 방에서 `!숙제 수로 <캐릭터>` 를 치는 것보다 언제나 빠르다.
//
// ★ **인자를 받지 않는다.** 예전 `!결정석 N` 은 개수를 받았지만 실제로 쓰는 값이 하나뿐
//   이었고(*"그냥 무조건 20개"*), 그 자리를 잠깐 닉네임이 받았다가 같은 날 그것도 뺐다
//   (*"!숙제 (닉네임) 은 삭제하고"*). 한 화면에 열다섯 줄이 캐릭터 이름까지 달고 나가므로
//   한 명만 보려고 다시 치는 것보다 그 목록에서 눈으로 찾는 편이 빠르다. 명령은 인자가
//   없을수록 좋다 — 외울 것이 줄고, 오타로 빈 답이 오는 길도 함께 사라진다.

/**
 * 한 번에 보여 줄 최대 줄 수 — **15** (발주 지시 2026-09-02: *"15개 정도에서 끊고"*).
 *
 * 20 에서 내렸다. 같은 날 월간을 목록에 넣었기 때문이기도 하다 — 줄이 늘어난 만큼
 * 상한을 그대로 두면 한 풍선이 600자를 넘기고, 그러면 '전체보기'로 접힐 부분이
 * 절반을 넘게 된다. 15줄이면 머리말까지 400자 남진이다.
 */
const HOMEWORK_LIST_MAX = 15;

/**
 * 목록에 **줄을 내줄 최소 금액** — 2억 (발주 지시 2026-09-02: *"기준을 2억으로 가자"*.
 * 같은 날 3억으로 먼저 잡았다가 내렸다).
 *
 * 실측(2026-09-02, 한 계정의 남은 31건)에서 하위 절반은 개인 수령액 1억 이하였다 —
 * 하진 1억 600만 · 하듄 9,440만 · 하윌 7,710만 · 카더 6,980만 · 하루 6,290만 …
 * 이런 줄이 목록의 절반을 먹으면 **"이번 주에 어디부터 돌지"** 라는 질문의 답이 묻힌다.
 * 한 줄이 곧 "가 볼 만하다"는 뜻이어야 목록이 일한다.
 *
 * ★ **3억 → 2억으로 내린 이유**는 문턱과 시세표 사이에 낀 보스들이다. 노세(노멀 세렌)
 *   2억 3,900만 · 하세(하드 세렌) 3억 5,600만처럼 실제로 도는 보스가 3억 근처에 몰려
 *   있어, 3억이면 노세가 통째로 빠지고 하세도 2인부터 빠졌다.
 * ★ **합계에서 빼지 않는다.** `남은 N건 · 총액` 은 여전히 전부를 말하고, 걸러진 것은
 *   `N억 이하 결정석 M건` 이 받는다 — 자른 사실을 숨기지 않는다.
 * ★ 기준은 **개인 수령액**(`floor(솔로가/인원)`)이다. 솔로가로 재면 2인으로 도는 보스가
 *   기준을 통과했다가 정작 손에 쥐는 것은 절반이 된다(§1 · D3).
 */
const HOMEWORK_MIN_MESO = 200_000_000;

/** 그 문턱을 사람 말로. 문구와 값이 갈라지지 않게 한 곳에서 만든다. */
const HOMEWORK_MIN_LABEL = formatMesoCompact(HOMEWORK_MIN_MESO);

/** 문턱을 넘는 것만. 정렬은 이미 되어 있으므로 순서를 건드리지 않는다. */
function worthListing(
  items: readonly RemainingBoss[],
): readonly RemainingBoss[] {
  return items.filter((item) => item.shareMeso >= HOMEWORK_MIN_MESO);
}

/**
 * 목록 한 줄. 시즌 표시는 12칸을 안 먹는다는 사실을 목록에서도 보이게 한다.
 *
 * ★ **한 캐릭터만 보는 중이면 이름을 빼운다.** 제목이 이미 그 이름을 말하고 있어서,
 *   줄마다 반복하면 같은 이름이 스무 번 서고 정작 보스와 금액이 밀린다(파티 드롭다운에서
 *   구성원 줄을 걷어낸 것과 같은 이유, 2026-09-02).
 */
function remainingRow(item: RemainingBoss, index: number): string {
  /*
    ★ 주간이 아닌 것은 **주기를 적는다.** 시즌은 12칸을 안 먹고, 월간은 이번 주 목요일에
      사라지지 않는다. 둘 다 사람이 그 줄을 어떻게 다룰지를 바꾸는 사실이라, 안 적으면
      한 목록 안에서 시계가 다른 줄이 구분되지 않는다(2026-09-02 월간 편입).
  */
  const cycle =
    item.cycle === "season"
      ? "(시즌)"
      : item.cycle === "monthly"
        ? "(월간)"
        : "";
  const who = ` ${item.characterName}`;
  return `${String(index + 1)}. ${item.shortName}${cycle}${who} ${formatMesoCompact(item.shareMeso)}`;
}

/**
 * `!숙제` — 남은 보스를 값 큰 순서로. **인자는 받지 않는다.**
 *
 * ★ `!숙제 <닉네임>`(캐릭터 필터)은 하루 만에 **뺐다**(발주 지시 2026-09-02).
 *   한 화면에 열다섯 줄이 캐릭터 이름까지 달고 나가므로, 한 명만 보려고 다시 치는 것보다
 *   그 목록에서 눈으로 찾는 편이 빠르다 — 명령이 늘면 외울 것도 는다.
 *
 * ★ 순서·범위·금액 규칙은 `fetchRemainingBosses` 가 이미 소유한다(개인 수령액 내림차순 ·
 *   주간+시즌 · 가격 미확인 제외). 여기서 다시 정렬하지 않는다.
 * ★ **한 풍선으로 보낸다**(발주 지시: *"접히든가 말던가 1개로 보내고"*). 접히는 것은
 *   잘리는 것이 아니다 — 카톡은 500자쯤에서 '전체보기'로 접을 뿐 펼치면 전부 있고,
 *   `…` 로 잘리면 그 줄들은 영영 사라진다. 그래서 예산을 키운 `longLines` 를 쓰고,
 *   라우트가 마지막에 한 번 더 통과시킬 때도 같은 예산이 쓰이도록 `long` 을 켠다.
 *   둘 중 하나만 하면 도로 잘린다.
 * ★ **제목 밑 구분선은 없다**(발주 지시: *"맨위에 ------------ 한줄 없애고"*).
 *   바로 아랫줄이 이미 요약이라 그 사이의 선은 자리만 먹었다.
 */
async function handleHomework(
  context: CommandContext,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  if (account === null) {
    return { reply: needsLinkReply(), tag: "숙제:미연결", userId: null };
  }

  /*
    ★ **월간까지 담는다**(발주 지시 2026-09-02: *"월간도 보여주게 바꿔봐"*).
      `!결정석` 의 상위 3개는 여전히 주간+시즌만 본다 — 근거는 `RemainingBossOptions` 머리말.
      요지는 **길이가 다르면 답도 다르다**는 것이다: 3줄에서는 87억짜리 익검이 다른 것을
      밀어내지만 15줄에서는 그렇지 않고, 오히려 빼면 가장 큰 할 일이 화면에서 사라진다.
  */
  const remaining = await fetchRemainingBosses(context.db, account.userId, {
    includeMonthly: true,
  });

  /*
    ★ 제목에서 **"이번 주"를 지웠다**(2026-09-02). 월간이 섞이면서 그 말이 거짓이 됐다 —
      검은 마법사는 목요일에 초기화되지 않는다. 괄호의 목요일 시각은 남긴다: 목록의
      대부분은 그때 사라지는 것이 맞고, 예외는 줄마다 `(월간)` 으로 적힌다.
  */
  const title = `💎 남은 보스 (주간 ${resetLabel(context.now)})`;

  if (remaining.items.length === 0) {
    return {
      reply: block(title, [
        "남은 보스 없음 👏",
        remaining.unknownCount > 0
          ? `가격 미확인 ${String(remaining.unknownCount)}건은 세지 않았어요.`
          : null,
      ]),
      tag: "숙제:빈",
      userId: account.userId,
    };
  }

  const eligible = worthListing(remaining.items);
  const shown = eligible.slice(0, HOMEWORK_LIST_MAX);
  const belowCount = remaining.items.length - eligible.length;
  const cutCount = eligible.length - shown.length;

  const summaryLine = `남은 ${String(remaining.items.length)}건 · ${formatMesoCompact(remaining.totalMeso)}`;

  if (shown.length === 0) {
    /*
      전부 문턱 아래일 수 있다. 그때 목록 없이 꼬리말만 남기면 화면이 고장 난 것처럼
      보이므로 **왜 비었는지**를 말한다. "남은 게 없다"와 "갈 만한 게 없다"는 다른 말이다.
    */
    return {
      reply: block(title, [
        summaryLine,
        `${HOMEWORK_MIN_LABEL} 넘는 보스는 없어요.`,
      ]),
      tag: "숙제:문턱",
      userId: account.userId,
    };
  }

  /*
    ── 꼬리말은 **빠진 이유별로 갈라 적는다** ─────────────────────
    발주 지시(2026-09-02): *"밑에 3억이하 결정석 14건 정도로 해"*.
    둘을 한 줄로 합치면 **조치가 다른 둘이 같은 말로 보인다** — 문턱 아래는 "그만한
    가치가 없다"라 할 일이 없고, 15줄에 잘린 것은 "그다음에 돈다"다.
  */
  const tailNotes = [
    cutCount > 0 ? `…외 ${String(cutCount)}건` : null,
    belowCount > 0
      ? `${HOMEWORK_MIN_LABEL} 이하 결정석 ${String(belowCount)}건`
      : null,
    remaining.unknownCount > 0
      ? `가격 미확인 ${String(remaining.unknownCount)}건 제외`
      : null,
  ];

  return {
    reply: longLines(
      title,
      summaryLine,
      DIVIDER,
      ...shown.map((item, index) => remainingRow(item, index)),
      ...tailNotes,
    ),
    long: true,
    tag: "숙제",
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

/** 목록에 보일 개수. 카톡 한 화면을 넘기지 않는 선(발주 지시: 상위 3개). */
const REMAINING_TOP_N = 3;

/**
 * 남은 보스 줄. 하나도 없으면 **"다 돌았다"** 를 말한다 — 빈 자리는 아무 말도 하지 않아
 * "조회가 안 됐나"로 읽힌다.
 */
function remainingLines(remaining: RemainingSummary): readonly string[] {
  if (remaining.items.length === 0) {
    return remaining.unknownCount > 0 ? [] : ["이번 주 남은 보스 없음 👏"];
  }

  /*
    ★ **`!숙제` 와 같은 문턱을 쓴다**(§`HOMEWORK_MIN_MESO`, §0.2-1 동일 적용). 목록이
      둘인데 기준이 다르면 `!결정석` 에 보이던 줄이 `!숙제` 에서 사라진다.
      상위 3개는 실측상 언제나 문턱 위라 평소에는 아무것도 달라지지 않는다 — 달라지는
      경우는 정확히 "이번 주에 갈 만한 게 없는" 주이고, 그때는 그렇게 말하는 편이 맞다.
  */
  const eligible = worthListing(remaining.items);
  if (eligible.length === 0) {
    return [
      `이번 주 남은 ${String(remaining.items.length)}건 · ${formatMesoCompact(remaining.totalMeso)}`,
      `${HOMEWORK_MIN_LABEL} 넘는 보스는 없어요.`,
    ];
  }

  const top = eligible.slice(0, REMAINING_TOP_N);
  const rest = remaining.items.length - top.length;

  return [
    /*
      범위를 밝힌다 — 위 묶음이 주기별로 갈라 말했으므로, 안 밝히면 전부를 합친 값으로
      읽힌다. 여기 담긴 것은 **이번 주에 초기화되는 것**(주간 + 시즌)이고 월간은 뺐다
      (`fetchRemainingBosses` 머리말).
    */
    `이번 주 남은 ${String(remaining.items.length)}건 · ${formatMesoCompact(remaining.totalMeso)}`,
    // 줄 모양의 주인은 `remainingRow` 하나다 — 두 목록이 다른 모양이면 같은 보스가
    // 명령에 따라 다르게 보인다.
    ...top.map((item, index) => remainingRow(item, index)),
    // 잘린 만큼을 적는다(위 ★). 0 이면 줄 자체가 없다.
    rest > 0 ? `…외 ${String(rest)}건` : null,
  ].flatMap((line) => (line === null ? [] : [line]));
}

async function handleCrystal(
  context: CommandContext,
  parsed: ParsedCommand,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  if (account === null) {
    return { reply: needsLinkReply(), tag: "결정석:미연결", userId: null };
  }

  /*
    ★ **목록은 `!숙제` 로 옮겨갔다**(발주 지시 2026-09-02). 여기서 `!결정석 20` 을
      치던 사람이 있으므로 조용히 무시하지 않고 **간 곳을 말해 준다.** 인자를 무시하고
      요약을 보내면 "숫자가 안 먹네"로 읽히고, 그 후로는 아무도 목록을 못 찾는다.
  */
  if (parsed.args.length > 0) {
    return {
      reply: lines(
        "남은 보스 목록은 !숙제 로 옮겨졌어요.",
        "인자 없이 !숙제 만 치면 돼요.",
      ),
      tag: "결정석:이사",
      userId: account.userId,
    };
  }

  /*
    남은 것 목록은 **합계와 함께 한 번에** 가져온다. 방 응답 하나에 왕복을 늘리지 않으려는
    것이고, 둘은 서로를 기다릴 이유가 없어 나란히 올린다.
  */
  const [summary, remaining] = await Promise.all([
    fetchCrystalSummary(account.userId, context.now),
    fetchRemainingBosses(context.db, account.userId),
  ]);
  const title = `💎 이번 주 결정석 (${resetLabel(context.now)})`;

  if (summary === null) {
    return {
      /*
        ★ 사람이 **할 일이 없다는 것**을 말해 준다. 예전에는 "일정을 클리어로 체크하면
          여기에 쌓입니다"라고 했는데, `!클리어` 를 뺀 지금 그건 방에서 할 수 없는 일을
          시키는 문장이다. 클리어는 넥슨 동기화가 알아서 집어 오고 데이터가 ~15분 늦을
          뿐이므로, 기다리라고 말하는 편이 정확하다.
      */
      reply: block(title, [
        "아직 이번 주 기록이 없어요.",
        "보스를 잡으면 자동으로 쌓입니다(넥슨 반영까지 15분쯤).",
      ]),
      tag: "결정석:빈",
      userId: account.userId,
    };
  }

  /*
    ★ **주간과 월간을 가른다** (발주 지시 2026-08-20). 예전에는 합친 총액 한 줄이었는데,
      그때 이미 웹 카드는 둘을 갈라 놓고 있었다 — 봇만 합쳐 말하는 상태였다.
      가르는 것이 맞는 이유는 §1 이다: **12개 상한은 주간에만 걸린다.** 합쳐 놓으면
      "주간을 다 돌고 월간을 안 간 주"와 그 반대가 같은 숫자로 보인다.
    ★ 분모는 **지어내지 않는다.** 주간은 `추적 캐릭터 × 캐릭터당 상한`, 월간은 `계획에
      켜진 월간 보스 수`이고, 둘 다 모를 수 있다. 그때는 건수만 쓴다.
    ★ 값은 전부 웹 카드와 **같은 조립기**에서 온다(`fetchCrystalSummary` 머리말).
  */
  const { potential } = summary;

  /*
    ★ **한 주기를 두 줄로 접는다** (발주 지적 2026-08-20: *"너무 길어"*).
      처음 만든 것은 주기마다 세 줄(`클리어 …` · `주간 결정석 …` · `주간 최대 …`)이라
      구분선까지 12줄이었다. 길이의 대부분은 **반복되는 라벨과 `메소`** 였다 —
      `주간` 이 세 번, `메소` 가 다섯 번 나온다. 금액 표기(`428억 3,941만`) 자체는
      발주자가 편하다고 한 그대로 둔다.
    ★ `현재 / 최대` 한 줄은 **웹 카드의 새 머리말과 같은 모양**이다. 두 화면이 같은
      숫자를 같은 배치로 말하면 사람이 옮겨 읽을 때 헷갈리지 않는다.
    ★ `메소` 는 **합계에만** 남긴다. 단위를 매 줄에 반복해도 새 정보가 없고, 한 번은
      있어야 무슨 숫자인지가 분명하다.
  */
  const amount = (value: number | null) =>
    value === null ? "미확인" : formatMesoCompact(value);

  const cycleLines = (
    label: string,
    tally: { readonly clearCount: number; readonly incomeMeso: number | null },
    total: number | null,
    potentialMeso: number | null,
  ): readonly string[] => [
    total === null
      ? `${label} ${String(tally.clearCount)}건`
      : `${label} ${String(tally.clearCount)}건 / ${String(total)}건`,
    potentialMeso === null
      ? amount(tally.incomeMeso)
      : `${amount(tally.incomeMeso)} / 최대 ${amount(potentialMeso)}`,
  ];

  return {
    reply: block(title, [
      ...cycleLines(
        "주간",
        summary.weekly,
        summary.slots.limitTotal,
        potential?.weekly.potentialMeso ?? null,
      ),
      // 구분선 대신 빈 줄. 두 묶음을 가르는 데는 이걸로 충분하고 한 줄이 덜 든다.
      "",
      ...cycleLines(
        "월간",
        summary.monthly,
        potential === null ? null : potential.monthly.plannedCount,
        potential?.monthly.potentialMeso ?? null,
      ),
      DIVIDER,
      summary.dropCount > 0 ? `드랍 ${amount(summary.dropIncomeMeso)}` : null,
      /*
        ── 합계 대신 **남은 것** ──────────────────────────────────────────────
        발주 지시(2026-08-25): *"!결정석에 합계 빼고 남은거 상위 3개 보여줘"*.

        합계는 이미 끝난 일이고, 방에서 이 명령을 치는 사람이 알고 싶은 것은 **아직 할
        일**이다. "140억치나 남았다"는 그 자체로 행동을 부르지만 "428억 벌었다"는 부르지
        않는다. 그래서 `합계` 줄을 빼고 그 자리를 이 목록이 받는다.

        ★ 머리줄은 **전부**를 말하고 목록은 3개만 보인다. 자른 사실을 숨기면 "이게 다인가"
          로 읽혀, 정작 남은 큰 보스를 놓친다.
        ★ 금액은 개인 수령액(1/n)이다 — 솔로가를 쓰면 3인 파티에서 3배 부푼다(§1 · D3).
      */
      ...remainingLines(remaining),
      // 미확인 가격을 0 으로 더하지 않았다는 사실을 **숨기지 않는다**(§1.3 D4).
      summary.unknownPriceCount > 0
        ? `가격 미확인 ${String(summary.unknownPriceCount)}건`
        : null,
      summary.unsoldDropCount > 0
        ? `아직 안 판 드랍 ${String(summary.unsoldDropCount)}건`
        : null,
      /*
        ── 맨 밑 한 줄로 **옆 명령이 뭘 주는지** 말한다 (발주 지시 2026-09-02) ──────
        이 답장의 목록은 상위 3개뿐이라 "이게 전부인가"로 읽히기 쉽고, 더 보는 길이
        있다는 사실은 어디에도 적혀 있지 않았다. `!도움말` 은 명령 이름만 나열하므로
        **무엇을 주는지**까지는 말하지 않는다 — 그 한 줄이 여기 있어야 하는 이유다.
        범위(월간 포함)를 밝히는 것이 핵심이다: 이 목록에는 월간이 없어서, 안 적으면
        두 답이 왜 다른지 알 수 없다.
      */
      `!숙제 — 남은 보스 ${String(HOMEWORK_LIST_MAX)}개 (월간 포함)`,
    ]),
    tag: "결정석",
    userId: account.userId,
  };
}

/** 라우트가 원문 메시지를 넘기면 파싱까지 여기서 끝낸다. `!` 가 아니면 `null`. */
export function parseIncoming(message: string): ParsedCommand | null {
  return parseCommand(message);
}
