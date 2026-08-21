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
import { formatKstShort, kstWeekdayKo } from "@/components/domain/kst-format";
import type { ChoreStatus } from "@/lib/domain/chore-status";
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
  genericFailureReply,
  lines,
  needsLinkReply,
} from "../lib/plaintext";
import {
  CHORE_ALIASES,
  deleteMyLatestDrop,
  fetchChoreBoard,
  fetchCrystalSummary,
  fetchMyRuns,
  type MyRun,
  weekAnchor,
  groupRuns,
  fetchChannelDigestMinutes,
  findDropTargetRun,
  listBotParties,
  loadBotAccount,
  recordDrop,
  setChannelDigestMinutes,
  setPartyReminders,
  setChoreManualDone,
  type BotAccount,
  type BotPartyRow,
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
      return { reply: helpReply(), tag: "도움말", userId: account?.userId ?? null };

    case "연결":
      return handleLink(context, parsed);

    case "연결해제":
      return handleUnlink(context, account);

    case "일정":
      return handleSchedule(context, parsed, account);

    case "결정석":
      return handleCrystal(context, account);

    case "숙제":
      return handleChores(context, parsed, account);

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

function helpReply(): string {
  return block("[M_Schedule] 명령어", [
    "!일정        이번 주 방 일정",
    "!일정 오늘   오늘 일정만",
    "!결정석      이번 주 결정석 수익",
    "!파티           내 파티 목록",
    "!파티연결 <번호>  이 방에 연결",
    "!숙제           필수 숙제 O/X",
    "!일정 다음주   다음 주 일정",
    "!제외 0820     그날 통째로 빼기",
    "!알림 09시     그 시각에 그날 일정",
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

function remindersText(minutes: readonly number[]): string {
  if (minutes.length === 0) return "없음";
  // 큰 값이 먼저 오는 것이 시간 순서다(60분 전 → 10분 전).
  return [...minutes]
    .sort((a, b) => b - a)
    .map((m) => `${String(m)}분`)
    .join(" · ");
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
    ★ **두 축이 한 명령에 산다.**
        `!알림 09시 18시`   → 이 **방**의 정기 알림 시각 (그날 일정을 그때 한 번)
        `!알림 1 30 10`     → **파티** 1 의 런 오프셋 (런마다 30분·10분 전)
      토큰 모양으로 가른다 — 시각은 `시` 나 `:` 를 달고 있고 오프셋은 맨 숫자다.
      `30` 이 "30분 전"인지 "30시"인지 헷갈릴 일이 없어야 하므로 시각 표기를 강제한다
      (`lib/command-parse.ts` 의 `parseClockMinute` 머리말).
  */
  const clockMinutes = parsed.args.map((token) => parseClockMinute(token));
  const allClock = parsed.args.length > 0 && clockMinutes.every((m) => m !== null);
  const clearDigest =
    parsed.args.length === 2 &&
    (parsed.args[0] === "시각" || parsed.args[0] === "시간") &&
    (parsed.args[1] === "끄기" || parsed.args[1] === "없음");

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
        minutes.length === 0 ? null : "일정이 없는 날은 보내지 않아요.",
      ),
      tag: minutes.length === 0 ? "알림:정기끄기" : "알림:정기설정",
      userId: account.userId,
    };
  }

  const [parties, digestMinutes] = await Promise.all([
    listBotParties(context.db, account.userId, context.channel.id, context.now),
    fetchChannelDigestMinutes(context.db, context.channel.id),
  ]);
  if (parties.length === 0) {
    return {
      reply: block("🔔 알림 설정", [
        `이 방 정기 알림 — ${
          digestMinutes.length === 0
            ? "없음"
            : digestMinutes.slice().sort((a, b) => a - b).map(formatClockMinute).join(" · ")
        }`,
        "참여 중인 파티가 없어요.",
      ]),
      tag: "알림:빈",
      userId: account.userId,
    };
  }

  // 인자가 없으면 현재 설정을 보여 준다.
  if (parsed.args.length === 0) {
    const rendered = parties.map((party, index) => {
      const where = party.boundHere
        ? ""
        : party.boundElsewhere
          ? " (다른 방)"
          : " (방 미연결)";
      return `${String(index + 1)}. ${party.name}${where} — ${remindersText(party.reminderMinutes)} 전`;
    });
    return {
      reply: block("🔔 알림 설정", [
        `이 방 정기 — ${
          digestMinutes.length === 0
            ? "없음"
            : digestMinutes.slice().sort((a, b) => a - b).map(formatClockMinute).join(" · ")
        }`,
        DIVIDER,
        ...clipList(rendered, 7),
        DIVIDER,
        "!알림 09시 18시 → 그 시각에 그날 일정",
        "!알림 1 30 10   → 런 30분·10분 전",
        "!알림 1 끄기    → 그 파티 알림 없음",
      ]),
      tag: "알림",
      userId: account.userId,
    };
  }

  const target = pickParty(parties, parsed.args[0] ?? "");
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
        `${target.name} — 현재 ${remindersText(target.reminderMinutes)} 전`,
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
      `🔔 ${target.name} — ${remindersText(minutes)} 전`,
      target.boundHere || target.boundElsewhere
        ? null
        : "⚠️ 이 파티는 방에 연결돼 있지 않아 알림이 나가지 않아요. !파티연결 로 연결해 주세요.",
    ),
    tag: "알림:설정",
    userId: account.userId,
  };
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
 * `일퀘` · `몬파3/7` — **남은 항목만** 그리므로 O/X 를 붙이지 않는다.
 *
 * 예전에는 `일퀘X` 처럼 판정을 함께 찍었는데, 줄에 적히는 것이 곧 "안 한 것"이 된
 * 지금은 `X` 가 모든 칸에 붙는 상수여서 폭만 먹는다(아래 `handleChores` 머리말).
 *
 * **몬파만 횟수**를 유지한다 — 남은 입장 횟수가 곧 할 일의 양이라 접으면 정보가
 * 사라진다(발주 정정 2026-08-19: *"그래서 몬파는 횟수. 일퀘는 O or X"*). 그 예외는
 * `detail` 이 있는지로 갈린다 — 여기서 항목 이름을 다시 분기하면 규칙이 두 곳에 생긴다.
 *
 * 라벨과 값 사이를 띄우지 않는다. 카카오톡은 가변폭이라 띄어쓰기로 열을 맞출 수 없고
 * (§1.4), 그렇다면 폭을 아끼는 쪽이 낫다.
 */
function choreCell(status: ChoreStatus): string {
  return `${status.label}${status.detail ?? ""}`;
}

/** 한 캐릭터가 어떤 줄로 나가는가. */
type ChoreRowKind = "todo" | "done" | "none" | "unsynced";

interface ChoreRow {
  readonly name: string;
  readonly kind: ChoreRowKind;
  /** `kind === "todo"` 일 때만 채워진다. */
  readonly todo: readonly string[];
}

/**
 * 줄들을 말풍선에 **글자 수 기준**으로 담는다.
 *
 * ★ 예전에는 줄 개수(첫 풍선 8줄, 이후 10줄)로 갈랐다. 그건 줄 길이가 고르다는 가정인데,
 *   숙제 줄은 남은 항목 수에 따라 길이가 3배 넘게 차이 난다. 개수로 자르면 어떤 날은 첫
 *   풍선이 예산(350자)을 넘고, 그때 `toPlaintext` 가 **조용히 `…` 로 잘라낸다** — 잘렸다는
 *   사실이 눈에 띄지 않아 "왜 캐릭터가 다 안 나오지"가 다시 반복된다. 그래서 실제로 먼저
 *   걸리는 제약(글자 수)으로 나눈다.
 * ★ 한 줄이 통째로 예산을 넘으면 그 줄만 담아 보낸다 — 무한 루프를 막고, 잘림 판단은
 *   `toPlaintext` 한 곳에 맡긴다.
 */
function packBubbles(
  rows: readonly string[],
  firstBudget: number,
  restBudget: number,
): readonly string[] {
  const bubbles: string[] = [];
  let current: string[] = [];
  let used = 0;
  let budget = firstBudget;

  for (const row of rows) {
    const cost = row.length + 1; // 줄바꿈 한 글자
    if (current.length > 0 && used + cost > budget) {
      bubbles.push(current.join("\n"));
      current = [];
      used = 0;
      budget = restBudget;
    }
    current.push(row);
    used += cost;
  }
  if (current.length > 0) bubbles.push(current.join("\n"));
  return bubbles;
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
    ★ **적힌 것이 곧 남은 것이다** (발주 지적 2026-08-20: *"너무 못생겼는데"*).
      예전 줄은 `더저* 일퀘X 몬파0/7 수로X 에픽X` 였다. 못생긴 이유가 취향이 아니라
      구조에 있었다:
        · 다 한 항목과 안 한 항목을 **똑같은 비중**으로 찍어서, 정작 할 일을 찾으려면
          사람이 `X` 를 눈으로 골라내야 했다.
        · `X` 는 안 한 칸마다 붙는 상수라 정보가 0인데 폭은 먹는다.
        · 캐릭터마다 칸 수가 달라(등록 안 한 항목은 빠진다) 오른쪽 끝이 들쭉날쭉했고,
          가변폭 글꼴이라 그걸 공백으로 맞출 수도 없다(§1.4).
      그래서 **안 한 것만 적는다.** 이것은 새로 만든 규칙이 아니라 이 앱이 이미 쓰는
      규칙이다 — CLAUDE.md §1.1.1 이 대시보드에 대해 *"할 일 목록이지 트로피 진열장이
      아니다"* 라고 못박아 두었다. 같은 원칙을 숙제에도 적용한다.
    ★ **남은 게 많은 순으로 정렬한다.** 긴 줄이 위, 짧은 줄이 아래로 모여 들쭉날쭉하던
      오른쪽 끝이 의도한 모양이 된다. 급한 캐릭터가 위로 오는 부수 효과도 있다.
    ★ 다 한 캐릭터·등록 없는 캐릭터는 **한 줄로 접어 아래로 보낸다.** 이름만 필요한
      정보에 줄 하나씩을 내주면 목록이 다시 부풀기 때문이다.
  */
  const entries: readonly ChoreRow[] = board.map((character) => {
    // 본캐 표시는 `*` → `⭐`. 이름 뒤의 `*` 는 오타처럼 보이고 범례가 한 줄 더 필요했다.
    const name = `${character.isMain ? "⭐" : ""}${character.characterName}`;
    const all = [...character.daily, ...character.weekly];
    if (all.length === 0) {
      // 스냅샷이 없는 것과 "등록한 필수 숙제가 없는 것"을 구분해 말한다.
      return {
        name,
        kind: character.syncedAt === null ? "unsynced" : "none",
        todo: [],
      };
    }
    const todo = all.filter((status) => status.state === "todo").map(choreCell);
    return { name, kind: todo.length === 0 ? "done" : "todo", todo };
  });

  const namesOf = (kind: ChoreRowKind): readonly string[] =>
    entries.filter((entry) => entry.kind === kind).map((entry) => entry.name);

  const todoRows = entries
    .filter((entry) => entry.kind === "todo")
    .slice()
    .sort((a, b) => b.todo.length - a.todo.length)
    .map((entry) => `${entry.name} ${entry.todo.join("·")}`);

  const doneNames = namesOf("done");
  const noneNames = namesOf("none");
  const unsyncedNames = namesOf("unsynced");

  const footer = [
    doneNames.length > 0 ? `✅ 다 함  ${doneNames.join(", ")}` : null,
    noneNames.length > 0 ? `➖ 등록 없음  ${noneNames.join(", ")}` : null,
    unsyncedNames.length > 0 ? `⏳ 동기화 안 됨  ${unsyncedNames.join(", ")}` : null,
  ].filter((line): line is string => line !== null);

  if (todoRows.length === 0) {
    return {
      reply: block(`📋 필수 숙제 (${resetLabel(context.now)})`, [
        "✅ 이번 주 필수 숙제를 전부 끝냈어요.",
        ...footer.filter((line) => !line.startsWith("✅")),
      ]),
      tag: "숙제",
      userId: account.userId,
    };
  }

  /*
    말풍선 나누기. 첫 풍선은 제목·구분선·꼬리말이 자리를 먹으므로 본문 예산을 줄여 잡는다.
    숫자는 `REPLY_CHAR_BUDGET`(350)에서 그 부속들을 뺀 대략값이다 — 정확할 필요는 없고,
    **넘치기 전에 나누기만 하면** 잘림이 생기지 않는다.
  */
  const bubbles = packBubbles(todoRows, 200, 320);
  const head = bubbles[0] ?? "";
  const tail = bubbles.slice(1);

  return {
    reply: block(`📋 필수 숙제 (${resetLabel(context.now)})`, [
      head,
      DIVIDER,
      ...footer,
      // 적힌 것이 남은 것이라는 규칙은 **말해 줘야 한다.** 빈 줄은 다 했다는 뜻이 된다.
      "적힌 것이 남은 숙제예요.",
      "수로·에픽은 !숙제 수로 <캐릭터> 로 체크",
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

/** 라우트가 원문 메시지를 넘기면 파싱까지 여기서 끝낸다. `!` 가 아니면 `null`. */
export function parseIncoming(message: string): ParsedCommand | null {
  return parseCommand(message);
}
