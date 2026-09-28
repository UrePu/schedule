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
 *          · `!파티` · `!숙제` (2026-08-19) · `!환산 <닉네임>` (2026-09-03)
 *          · `!결정패치` (2026-09-14) · `!보스 <시각> <파티번호>` (2026-09-28)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-28: **`!제외` · `!제외해제` 를 삭제했다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 가용시간(겹쳐보기) 기능이 제품에서 통째로 빠졌다. 두 명령은 `availability_exceptions`
 * 에 하루짜리 뺄셈 행을 쓰는 일이었고, 답장은 *"이 날은 겹쳐보기에서 빠집니다"* 라며
 * **이제 존재하지 않는 화면**을 가리켰다. 쓰는 곳이 없는 데이터를 쓰면서 없는 화면을
 * 약속하는 명령이라, 남겨 두는 쪽이 침묵보다 나빴다. 저장 함수 자체는
 * `features/schedule` 에 그대로 있다 — 이 파일이 그것을 **부르지 않게** 됐을 뿐이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ 2026-09-28: **방(채널) 개념이 사라졌다** ★★
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지시: *"카톡의 방의 개념을 삭제. 닉네임으로 판별하여 연결하는거만 가능
 * !연결 ~~ 만 남기기. !페어링 필요 x. 그거에따른 리마인더 삭제. 알림 삭제."*
 *
 * 내려간 명령 셋과 그 이유:
 *  · **`!알림` / `!알리미`** — 설정할 대상이 없어졌다. 파티방판은 *이 방*의 정기 시각과
 *    *이 방* 파티의 오프셋을 정했고, 개인톡판은 그 사람의 개인톡 방으로 나갈 요약·임박을
 *    정했다. 보내는 경로(아웃박스·개인톡 푸시)가 통째로 사라졌으므로 남겨 두면 **아무
 *    일도 일어나지 않는 설정 화면**이 된다 — 그게 침묵보다 나쁘다.
 *  · **`!파티연결` / `!파티해제`** — `parties.bot_channel_id` 를 채우는 명령이었고, 그
 *    값을 읽던 곳은 알림 적재뿐이었다. 붙일 방도, 그 값을 볼 사람도 없다.
 *  · **`!페어링` / `!별칭` / `!방정보`** — 런너 로컬 명령이라 애초에 서버에 오지 않았다.
 *    런너 스크립트에서 함께 걷어냈다(`scripts/OpenchatbotR.js`).
 *
 * 그 결과 **이 파일에는 방이 한 번도 나오지 않는다.** 신원은 `(platform, sender.id)` →
 * `bot_identities` 하나로 풀리고(`server/link.ts`), `!드랍` 의 대상 런은 "이 방에 묶인
 * 파티" 대신 **"내가 낀 파티"** 에서 고른다(`bot-repo.findDropTargetRun` 머리말).
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
 * - ~~**`!등록 <보스> <시간>` (일정 생성)**~~ — **2026-09-28 에 `!보스` 로 열렸다.**
 *   미뤄 둔 이유는 *"런은 캐릭터 단위인데(§1) 방에서 친 한 줄에는 어느 캐릭터인지가 없고,
 *   되물으면 대화가 3턴이 된다"* 였다. 그 막힘을 푼 것은 되묻기가 아니라 **파티**다 —
 *   `party_participants.character_id` 가 이미 "이 파티엔 이 캐릭터로 간다"를 들고 있고,
 *   비어 있으면 본캐로 떨어진다(`fetchMyRunCharacters` 가 본캐를 맨 앞에 둔다). 그래서
 *   한 줄에 필요한 것은 **시각과 파티 번호뿐**이고 나머지는 전부 파티에서 끌어온다:
 *   갈 보스도(`fetchPartyBosses`), 참여자도(`fetchPartyMembers`), 1/n 분모도.
 *   이름이 `!등록` 이 아니라 `!보스` 인 것은 방에서 "등록"이 `!연결` 과 헷갈리기 때문이다.
 *   시각 파서(`parseClockMinute`)도 이 명령과 함께 살아났다.
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
 * - 신원은 **`bot_identities` 로만** 해석한다. `sender.id` 가 열쇠이고 `sender.name` 은
 *   표시용이다. 그 열쇠가 사실상 닉네임이라 `!연결` 에 **선점 규칙**이 붙는다(`link.ts`).
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
import { kstDayKey, kstMoment } from "@/lib/time/kst-wallclock";
import { formatKst, getNextReset } from "@/lib/time/week";
import { formatMesoCompact } from "@/lib/utils";

import {
  formatClockMinute,
  parseClockMinute,
  parseCommand,
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
  fetchCharacterPlanPotential,
  fetchCrystalSummary,
  fetchPlanPotentialAt,
  fetchScheduledCrystalPricePatch,
  fetchMyRuns,
  fetchRemainingBosses,
  resolveMyCharacter,
  type CharacterLookupMiss,
  type RemainingBoss,
  type RemainingBossScope,
  type RemainingSummary,
  type MyRun,
  type PatchCycle,
  type PlanPotentialAt,
  type ScheduledPricePatch,
  weekAnchor,
  groupRuns,
  findDropTargetRun,
  findPartyRunConflict,
  listBotParties,
  loadBotAccount,
  recordDrop,
  type BotAccount,
  type RunGroup,
} from "./bot-repo";
/*
  ★ **일정 생성은 웹 시간표 등록 창과 같은 함수를 부른다**(발주 지시 2026-09-28).
    `createPartyRuns` 는 순차 배치(`시작 + 20분 × i`) · `run_no` 부여 · 캐릭터 소유 검증 ·
    참가자 펼치기를 전부 갖고 있다. 봇용 저장 경로를 따로 내면 그 넷이 두 벌이 되고,
    두 벌이 된 것은 반드시 갈라진다(§0.2 — 같은 수정은 한 곳에).
  ★ 보스·구성원·캐릭터 후보도 웹이 읽는 그 함수들이다. `!보스` 가 만드는 런은 사람이
    시간표 빈 칸을 눌러 만든 런과 **한 글자도 다르지 않아야** 한다.
  ⚠️ ═══════════════════════════════════════════════════════════════════════════
     **그 선언이 지금은 참이 아니다 — 겹침 검사 한 가지가 봇에만 있다**
     ═══════════════════════════════════════════════════════════════════════════
     2026-09-28 교차 검증: `handleBoss` 는 `findPartyRunConflict`(`bot-repo.ts`)로 같은
     파티의 구간 겹침을 보고 거부하는데, **웹의 등록 창에는 그 검사가 없다.** 즉 같은 파티
     같은 시간을 방에서 잡으면 막히고 웹에서 잡으면 그대로 두 벌이 만들어진다 — 저장 경로
     (`createPartyRuns`)는 하나인데 **검사가 그 위에 얹혀 있어서** 갈라졌다.
     웹 쪽에 같은 검사를 넣는 일은 다른 담당이 진행 중이다.
     ⇒ **웹에 검사가 들어가면 이 ⚠️ 블록을 지워라.** 그때 위의 "한 글자도 다르지 않아야"
       가 다시 참이 된다. 남겨 두면 다음 사람이 이미 해결된 차이를 다시 조사한다.
  ⚠️ 2026-09-28 에 `createMyAvailabilityException` · `find…` · `delete…` 세 개가 이
     import 에서 빠졌다. `!제외` · `!제외해제` 가 내려갔기 때문이다(아래 디스패처 주석).
*/
import {
  createPartyRuns,
  fetchMyRunCharacters,
  fetchPartyBosses,
  fetchPartyMembers,
} from "@/features/schedule/server/schedule-repo";
import { DEFAULT_DURATION_MINUTES } from "@/features/schedule/lib/run-defaults";

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
  /**
   * 메신저 종류. 신원의 유일성이 `(platform, senderId)` 라 **모든 신원 질의가 이 값을
   * 함께 쓴다**(`server/link.ts`). 방(채널)을 대신하는 자리가 아니다 — 방은 사람마다
   * 다르게 실려 왔고, 이 값은 런너 하나당 하나다.
   */
  readonly platform: string;
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

/**
 * 환산 스펙 페이지(`!환산`)의 기본 주소. **여기 한 곳에만 적는다** — 주소가 바뀌면
 * 고칠 곳도 한 곳이어야 한다.
 */
const SCOUTER_BASE = "https://maplescouter.com/ko/info?name=";

/**
 * 링크로 만들어 줄 만한 **메이플 닉네임**인가. 한글·영문·숫자 2~12자.
 *
 * ★ 모듈 상수인 이유는 `handleScouter` 가 이걸 **두 갈래에서 쓰기 때문**이다 —
 *   사람이 친 닉네임과, 인자를 안 줬을 때 쓰는 본캐 닉네임. 정규식을 복사해 두면
 *   한쪽만 고쳐지는 날이 온다.
 * ⚠️ `g` 플래그를 붙이지 말 것. `lastIndex` 가 남아 같은 입력이 한 번 걸러 통과한다.
 */
const SCOUTER_NICKNAME = /^[0-9A-Za-z가-힣]{2,12}$/u;

/** 닉네임 → 답장 한 줄. 인코딩 규칙이 갈라지지 않게 **여기 한 곳**에서만 조립한다. */
function scouterLink(nickname: string): string {
  return `${SCOUTER_BASE}${encodeURIComponent(nickname)}`;
}

const KNOWN_COMMANDS = [
  "도움말",
  "명령어",
  "help",
  "일정",
  "결정석",
  "연결",
  "연결해제",
  "파티",
  "숙제",
  "검마",
  "웹",
  "사이트",
  "드랍",
  "드롭",
  "분배",
  /*
    ★ **맨 뒤여야 한다.** `suggestion()` 은 `find`(선착순)이고 `editDistanceWithin1` 은
      점수 없이 boolean 만 돌려주므로 **동점이면 배열 순서가 이긴다.** `환산` 을 중간에
      끼웠더니 `!제산`→`!제외` · `!알산`→`!알림` · `!드산`→`!드랍` · `!분산`→`!분배` 네 건이
      전부 `!환산` 으로 뒤집혔다(전수 대입 확인, 2026-09-03). 첫 글자가 맞는 쪽이 언제나
      더 그럴듯한 제안이므로, 새 명령은 기존 명령 뒤에 붙인다.
      ⚠️ 2026-09-28 에 `알림` 이 목록에서 빠졌으므로 `!알산` 은 이제 **아무 제안도 받지
         않는다**(편집거리 1 안에 남은 후보가 없다). 그게 맞다 — 없는 명령을 제안하면
         사용자가 그것을 치고 다시 침묵을 받는다.
  */
  "환산",
  /*
    ★ 위 경고와 같은 이유로 **`환산` 보다도 뒤**다(2026-09-14). `결정패치` 는 `결정석` 과
      편집거리 3 이라 서로를 가로채지 않지만, 규칙은 "새 명령은 맨 뒤"이고 예외를 한 번
      두면 다음 사람이 그 예외를 근거로 중간에 끼운다. **맨 뒤에 붙이는 한 기존 제안은
      바뀔 수가 없다** — `find` 는 선착순이라 새 마지막 원소는 앞이 전부 빗나갔을 때만
      이긴다. 증명이지 실측이 아니다.
  */
  "결정패치",
  /*
    ★ 같은 이유로 **맨 뒤**다(2026-09-28). 덧붙여 `보스` 는 기존 두 글자 명령 어느 것과도
      편집거리 2 이상이라(`숙제`·`파티`·`분배`·`드랍`·`환산`·`검마`·`일정`·`연결` 전부
      두 글자가 모두 다르다) 앞의 제안을 가로챌 수가 없다.
    ⚠️ 같은 날 `제외` · `제외해제` 가 목록에서 **빠졌다**(가용시간 기능이 제품에서 제거됨).
       그 결과 `!제산` 의 제안이 `!제외` → `!환산` 으로 넘어간다 — 없어진 명령을 제안하느니
       살아 있는 명령을 제안하는 편이 낫다.
  */
  "보스",
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
        reply: helpReply(),
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

    case "결정패치":
      return handleCrystalPatch(context, account);

    case "검마":
    case "검은마법사":
      return handleRemaining(context, parsed, account, "monthly");

    case "숙제":
      return handleRemaining(context, parsed, account, "weekly");

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

    case "보스":
      return handleBossSchedule(context, parsed, account);

    case "환산":
      return handleScouter(parsed, account);

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
    context.platform,
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

/**
 * ★ **한 벌이다.** 예전에는 파티방판과 개인톡판이 따로 있었다 — 파티방에는 `!파티연결`
 *   같은 방 전용 명령이, 개인톡에는 개인 알림 설정이 있어서 한 벌로 합치면 어느 쪽에서든
 *   절반이 쓸모없는 목록이 됐다. 2026-09-28 에 **방과 알림이 함께 사라지면서** 두 목록의
 *   차이도 사라졌다. 어디서 쳐도 할 수 있는 일이 같으므로 도움말도 하나다.
 *
 * ⚠️ **350자 예산을 지킨다.** 라우트가 마지막에 `differentiate()` 로 `· HH:mm` 8자를
 *    덧붙일 수 있으므로(연속 같은 답장 방지) 실제 상한은 **342자**다. 넘으면
 *    `toPlaintext` 가 마지막 줄(`!연결해제`)을 `…` 로 잘라 먹는다.
 *    ⚠️ **실측 336자 · 17줄 — 남은 여유가 6자뿐이다**(2026-09-28, `!보스` 를 넣고 `!제외`
 *       를 뺀 뒤). 명령 한 줄을 더할 사람은 **반드시 기존 줄을 먼저 줄이세요.** 여유가
 *       없다는 사실이 여기 적혀 있지 않으면 다음 사람은 한 줄을 그냥 더하고, 그 대가는
 *       엉뚱하게도 마지막 줄이 사라지는 것으로 나타난다.
 */
function helpReply(): string {
  return block("[M_Schedule] 명령어", [
    "!일정        이번 주 내 일정",
    "!일정 오늘   오늘 일정만",
    "!일정 다음주 다음 주 일정",
    "!결정석      이번 주 결정석 수익",
    "!결정패치    시세 패치 전후 최대",
    // 대괄호 = 선택. 닉네임을 붙이면 그 캐릭터 하나만 본다(2026-09-04).
    "!숙제 [닉] · !검마 남은 주간 · 월간",
    "!파티        내 파티 목록",
    // 번호는 바로 윗줄 `!파티` 목록의 순번이다 — 그래서 두 줄이 붙어 있다.
    "!보스 19시20분 3  3번 파티로 잡기",
    DIVIDER,
    "!분배 950 3 3%   계산만",
    "!드랍 950 3 3%   계산 + 기록",
    // 대괄호는 인자가 **선택**이라는 뜻이다(`<코드>` 는 필수).
    "!환산 [메검메]   환산 스펙 링크",
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
// !환산
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 메이플 닉네임 하나를 **환산 스펙 페이지 링크 한 줄**로 바꾼다(발주 지시 2026-09-03).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⛔ **스탯까지 뽑는 판을 만들었다가 약관 확인 후 걷어냈다**(2026-09-04). 다시 만들지 말 것
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-03 에 이 핸들러는 헤드리스 크롬으로 maplescouter 페이지를 열어 환산·헥사환산·
 * 어센틱심볼까지 긁어 `extra` 말풍선으로 붙였다(`server/scouter.ts`, `scouter_stat_cache`).
 * 하루 만에 통째로 걷어냈다 — **동작이 아니라 약관이 이유다.** maplescouter 이용약관
 * (2026-07-11 시행)에 우리 구현이 여섯 조항으로 걸렸다:
 *   · 제15조 1호 — 자동화된 수단(봇·스크립트·크롤러·스크래퍼·**헤드리스 브라우저**·MCP 등)
 *                  으로 서비스에 접근하는 행위. 우리가 쓴 수단이 조문에 **그대로 적혀 있다.**
 *   · 제15조 2호 — 그 서비스의 계산·환산 기능을 **타 서비스의 백엔드/데이터 소스로 사용**.
 *                  카톡 봇 답장에 스탯을 실은 것이 정확히 이것이다.
 *   · 제15조 4호 — 인증 등 접근제어·기술적 보호조치 우회.
 *   · 제15조 3호·7호 — 엔드포인트 무단 추출 · 리버스 엔지니어링.
 *   · 제14조 2항 — 운영자 동의 없이 가공 데이터를 복제·전송(캐시 표가 여기 걸렸다).
 * 제17조는 이런 경우 **사전 통지 없이 차단**할 수 있다고 정한다.
 * 발주자 결정(2026-09-04): *"ㅇㅇ 카드로 변경해라."*
 *
 * ★ **링크 한 줄은 금지행위가 아니다.** 15조가 막는 것은 자동화 접근과 데이터 전용이고,
 *   링크는 오히려 그쪽으로 트래픽을 보내는 일이다. 그래서 카드만 남겼다 —
 *   **카드가 곧 답장이다.**
 * ⚠️ "HTML 만 파싱하면 되지 않나" 도 답이 아니다. 그 페이지는 껍데기만 서버 렌더라
 *    HTML 에는 값이 없고(실측), 그래서 헤드리스가 **유일한 길**이었다. 즉 스탯을 가져오는
 *    모든 경로가 15조 1호에 걸린다. 재시도할 여지가 없다 — 자세한 실측은
 *    `Claude/research-KAKAO-BOT.md` §2.8.1 에 남겼다.
 *
 * ★ **계정 연결을 요구하지 않는다.** 닉네임만 있으면 답이 나오는 순수 문자열 변환이라,
 *   아직 `!연결` 을 하지 않은 사람도 방에서 그대로 쓸 수 있다.
 *   ⚠️ 단, **닉네임을 생략하면** 연결된 계정의 본캐로 답한다(2026-09-04). 그때도 조회는
 *      늘지 않는다 — 아래 본문 주석 참조. 핸들러가 **추가로 하는
 *   조회는 0회**다 — `!웹` 과 같은 결이다.
 *   ⚠️ "DB 를 한 번도 읽지 않는다"는 아니다. `runCommand` 가 `switch` 에 들어가기 **전에**
 *      항상 `resolveAccount()` 를 돌려 `bot_identities` 를 읽으므로(표시 이름이 바뀌었으면
 *      UPDATE 까지), 그 한 번은 모든 명령이 공통으로 낸다. `account` 는 감사 로그의
 *      `user_id` 로만 쓴다.
 * ★ **한글을 반드시 퍼센트인코딩한다**(`encodeURIComponent`). 발주자 실기 확인
 *   2026-09-03: *"퍼센트 인코딩 해줘야 카드로 뜸."*
 *   ⚠️ 처음에는 반대로 갔다 — "링크를 여는 것은 브라우저이고 브라우저가 알아서
 *      인코딩하니 짧은 원문을 쓰자"고 판단했다. **그 판단은 링크를 누르는 경우만 봤다.**
 *      카드를 그리는 주체는 브라우저가 아니라 **카카오의 스크랩 크롤러**이고, 그쪽은
 *      한글이 섞인 URL 을 URL 로 집어내지 못해 카드 자체를 만들지 않는다. 길이(한 글자당
 *      9자)는 대가로 치른다 — 어차피 답장이 URL 한 줄뿐이라 350자 예산에 여유가 크다.
 *   ★ 그래도 아래 검증 정규식은 남긴다. 인코딩이 URL 을 지키더라도, **애초에 닉네임이
 *     아닌 것을 링크로 만들어 주지 않는 것**은 별개의 일이다.
 * ★ **`/ko` 를 붙인다.** `/info?name=…` 은 307 로 `/ko/info` 로 리다이렉트한다(실측
 *   2026-09-03). 어차피 갈 곳이면 처음부터 그 주소를 주는 편이 한 번 덜 튄다.
 * ★ 공백은 **전부 지운다.** 메이플 닉네임에는 공백이 없으므로 `!환산 메 검 메` 는
 *   오타이지 다른 닉네임이 아니다 — 파서 철학대로 관대하게 받아 준다
 *   (`lib/command-parse.ts` 머리말).
 */
function handleScouter(
  parsed: ParsedCommand,
  account: BotAccount | null,
): CommandOutcome {
  const userId = account?.userId ?? null;
  const nickname = parsed.rest.replace(/\s+/gu, "");

  /*
    ───────────────────────────────────────────────────────────────────────────
    인자를 안 줬으면 **연결된 계정의 본캐**로 답한다 (발주 지시 2026-09-04:
    *"!환산 뒤에 닉네임 안붙이면 계정 등록한 사람의 닉네임으로 검색되게 ㄱㄴ?
    지금 각 톡방에서 본인 연결을 했잖아."*)
    ───────────────────────────────────────────────────────────────────────────
    ★ **`account.label` 이 아니라 `account.mainCharacterName` 을 읽는다.** 이게 이 변경의
      전부이자 유일한 함정이다. `label` 은 `main_character_name ?? display_name` 이라
      (`bot-repo.loadBotAccount`) 본캐가 없는 계정에서는 **계정 표시명**으로 떨어진다.
      그 값을 URL 에 실으면 **존재하지 않는 캐릭터의 링크**가 방에 나가고, 카드 제목의
      이름 칸이 엉뚱한 이름으로 뜬다 — 틀린 답을 자신 있게 내놓는 최악의 실패다.
      `mainCharacterName` 은 `null` 을 `null` 로 들고 오므로, 없으면 없다고 말할 수 있다.
    ★ 여기서도 **추가 조회는 0회**다. `runCommand` 가 `switch` 전에 이미 돌린
      `resolveAccount()` 의 결과를 읽을 뿐이라, 이 명령은 여전히 `!웹` 과 같은 결이다.
    ★ 되읽기(`🔍 더저 로 찾았어요`)는 **넣지 않았다.** 두 가지 이유가 겹친다 —
      (1) 카드 제목이 이미 `<닉네임> | 환산주스탯` 이라 문자열이 통째로 중복이고,
      (2) 텍스트를 같은 말풍선에 섞으면 카카오 미리보기 카드가 아예 안 뜬다(발주자 실기
      확인). `extra` 로 따로 보내는 길도 있지만, 중복인 줄을 말풍선 하나 더 써서 보내는
      셈이라 도배만 는다. **틀린 이름을 되읽어 줄 위험 자체를 `mainCharacterName` 이
      없앴으므로** 되읽기의 본래 목적(잘못 해석했을 때 즉시 보이게)도 사라졌다.
  */
  if (nickname === "") {
    const main = account?.mainCharacterName ?? null;

    /*
      ★ **침묵하지 않는다.** 명령 자체는 정확히 쳤고 인자만 빠진 상태다. 여기서 아무 말도
        안 하면 사람은 봇이 죽은 줄 안다.
      ★ 미연결이면 **`!연결` 로 가는 길까지** 알려 준다. "닉네임을 붙이라"만 말하면
        인자 없이 쓰는 길이 있다는 사실 자체를 영영 모른다.
    */
    if (account === null) {
      return {
        reply: lines(
          "!환산 메검메  처럼 닉네임을 붙여 주세요.",
          "!연결 <코드> 로 계정을 연결하면 !환산 만 쳐도 돼요.",
        ),
        tag: "환산:미연결",
        userId,
      };
    }
    if (main === null) {
      return {
        reply: lines("!환산 메검메  처럼 닉네임을 붙여 주세요."),
        tag: "환산:본캐없음",
        userId,
      };
    }
    /*
      본캐 이름이 검증을 못 넘는 경우(공백·특수문자·13자 이상). 실측상 지금은 한 명도
      없지만, 이름은 넥슨에서 오는 값이라 우리가 보증할 수 없다. 통과 못 하면 **조용히
      링크를 만들지 않고** 닉네임을 달라고 한다 — 아래 형식 안내와 같은 답이다.
    */
    if (!SCOUTER_NICKNAME.test(main)) {
      return {
        reply: lines("!환산 메검메  처럼 닉네임을 붙여 주세요."),
        tag: "환산:본캐형식",
        userId,
      };
    }
    return { reply: lines(scouterLink(main)), tag: "환산:본캐", userId };
  }

  /*
    ★ 닉네임이 아닌 것을 링크로 만들어 주지 않는다. 한글·영문·숫자 2~12자만 통과한다.
      (URL 안전성 자체는 `encodeURIComponent` 가 맡는다 — 이 검사는 그 앞단이다.)
  */
  if (!SCOUTER_NICKNAME.test(nickname)) {
    return {
      reply: lines("닉네임만 적어 주세요. (한글·영문·숫자 2~12자)"),
      tag: "환산:형식",
      userId,
    };
  }

  /*
    ★ **URL 한 줄만 보낸다**(발주 확인 2026-09-03). 처음에는 `🔍 <닉네임> 환산` 을
      앞줄에 붙였는데, 카카오가 그 링크를 긁어 만드는 미리보기 카드가 이미
      `더저 | 환산주스탯` 이라 **그 줄이 통째로 중복**이다. 게다가 카드는 URL 만 든
      메시지에서 가장 확실히 뜬다 — 텍스트가 섞이면 생략되는 경우가 있다.
      카드가 곧 답장이므로 우리가 덧붙일 말이 없다.
    ★ maplescouter 는 **닉네임별 OG 태그를 서버에서 내려준다**(실측 2026-09-03:
      `og:title` = `더저 | 환산주스탯`). 이름 없는 URL 은 `" | 환산주스탯"` 이 되므로,
      **카드 제목의 이름 칸이 비어 보이면 그건 이름이 URL 에 안 실렸다는 신호**다.
    ⚠️ 직전과 똑같은 `!환산` 을 연달아 치면 `differentiate()` 가 `· HH:mm` 을 붙여
       URL 단독이 아니게 되고, 그때는 카드가 안 뜰 수 있다. 도배 방지가 우선이라
       그대로 둔다 — 같은 닉네임을 연속으로 두 번 치는 일 자체가 드물다.
  */
  return {
    reply: lines(scouterLink(nickname)),
    tag: "환산",
    userId,
  };
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
  if (tooManyLinkFailures(context.platform, context.senderId, context.now)) {
    return { reply: null, tag: "연결:차단", userId: null };
  }

  const code = normalizeCode(raw);
  if (code === null) {
    noteLinkFailure(context.platform, context.senderId, context.now);
    return { reply: codeUnusableReply(), tag: "연결:형식", userId: null };
  }

  const result = await consumeMemberLinkCode(
    context.db,
    {
      code,
      platform: context.platform,
      senderId: context.senderId,
      displayName: context.senderName,
    },
    context.now,
  );

  /*
    ★ ═══════════════════════════════════════════════════════════════════════════
      **선점은 "코드가 틀렸다"와 다른 답이다** (2026-09-28)
      ═══════════════════════════════════════════════════════════════════════════
    신원의 축이 사람 단위로 내려오면서 `sender.id` 가 사실상 닉네임이 됐다. 그래서 이미
    다른 계정에 물려 있는 발신자는 **거부한다**(`link.ts` 머리말). 그때 `codeUnusableReply()`
    로 접으면 진짜 본인이 "코드를 새로 받아라"만 되풀이하다 영원히 막힌다 — 코드는 멀쩡한데
    코드를 다시 받으라고 시키는 셈이다.

    ★ **실패 카운터를 올리지 않는다.** 이건 코드를 찍어 본 것이 아니라 정상 코드를 쓴
      결과이고, 세면 본인이 재시도하다 스스로 잠긴다.
    ★ 어느 계정인지는 **말하지 않는다** — 닉네임으로 남의 계정 이름을 캐낼 수 있게 된다.

    ⚠️ **우회 경로를 읊지 않는다**(2026-09-28 교차 검증에서 고침). 예전 문구는
       *"본인이면 그 계정에서 !연결해제 후 다시 시도하세요"* 였는데, `unlinkMember` 는
       행의 소유자를 묻지 않으므로(`link.ts`) 그 두 줄이 곧 **선점을 푸는 방법 안내**였다.
       남의 닉네임을 쓴 사람에게 "이렇게 하면 가져갈 수 있다" 를 알려 주는 셈이다.
       그래서 방에서는 **웹으로 보낸다** — 웹은 세션이 있어 진짜 본인만 들어온다.
       (사칭 자체를 막지는 못한다. 안내를 걷는 것이 여기서 할 수 있는 전부다.)
    ⚠️ 코드가 **이미 죽었는지**를 갈라 말한다(`codeSpent`). 사전 검사에서 걸린 경우는 코드가
       멀쩡하지만, 경합에 져서 온 `taken` 은 코드가 소모된 뒤다 — 그때 "다시 시도" 만
       말하면 그 코드로는 불가능한 일을 시키는 것이 된다.
  */
  if (result.status === "taken") {
    return {
      reply: lines(
        "⚠️ 이 닉네임은 이미 다른 계정에 연결돼 있습니다.",
        result.codeSpent ? "이 코드는 사용됐어요. 웹에서 새 코드를 받아 주세요." : null,
        "본인 계정인지는 웹의 연결 목록에서 확인할 수 있어요.",
      ),
      tag: "연결:선점",
      userId: null,
    };
  }

  if (result.status === "unusable") {
    noteLinkFailure(context.platform, context.senderId, context.now);
    return { reply: codeUnusableReply(), tag: "연결:실패", userId: null };
  }

  clearLinkFailures(context.platform, context.senderId);
  const account = await loadBotAccount(context.db, result.member.userId);

  return {
    reply: lines(
      "✅ 연결 완료",
      account === null ? null : `${account.label} 계정으로 확인했어요.`,
      "이제 !일정 !결정석 !숙제 를 쓸 수 있어요.",
    ),
    tag: "연결:성공",
    userId: result.member.userId,
  };
}

/**
 * `!연결해제` — 이 발신자의 매핑을 지운다.
 *
 * ★ **선점을 푸는 유일한 길이기도 하다.** 닉네임을 물려받은 사람(또는 계정을 바꾼 본인)이
 *   방에서 스스로 풀 수 있는 수단은 이것뿐이므로, 여기서 조용히 실패하면 그 사람이 갈 곳이
 *   없어진다. 그래서 지운 것이 없을 때도 **무엇이 없었는지** 말한다.
 *
 * ⚠️ **`!연결` 의 선점 안내는 더 이상 이 명령을 가리키지 않는다**(2026-09-28). 소유자를
 *    묻지 않고 지우므로 이 명령이 곧 선점 우회 경로이고(`link.ts` 의 한계 주석), 안내가
 *    그것을 읊고 있었다. 명령 자체는 남긴다 — 본인이 방에서 풀 길까지 막으면 닉네임이
 *    영구히 잠기는 쪽이 더 나쁘다. 우회를 실제로 닫으려면 런너가 안정적 발신자 id 를
 *    실어 와야 한다.
 */
async function handleUnlink(
  context: CommandContext,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  const removed = await unlinkMember(
    context.db,
    context.platform,
    context.senderId,
  );

  /*
    ⚠️ `account` 가 `null` 인데 행은 있을 수 있다 — 정지·삭제된 계정에 물린 경우다
      (`resolveAccount` 가 그것을 미연결과 같게 접는다). 그때 "연결된 계정이 없어요" 라고만
      답하고 지우지 않으면, 그 닉네임은 **아무도 쓸 수 없는 상태로 영구히 잠긴다.**
      그래서 지우기를 먼저 하고 답을 그 결과로 정한다.
  */
  if (!removed) {
    return { reply: "연결된 계정이 없어요.", tag: "연결해제:없음", userId: null };
  }
  return {
    reply: lines("🔓 연결을 끊었어요.", "다시 쓰려면 !연결 <코드> 로 연결해 주세요."),
    tag: "연결해제",
    userId: account?.userId ?? null,
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
      ★ 2026-09-28 에 방 개념이 사라지면서 이 선택이 **유일한 선택**이 됐다. 방을 보는
        길 자체가 없다.
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
 * 절반을 넘게 된다. 15줄이면 머리말까지 400자 남짓이다.
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
 * ★ **한 캐릭터만 보는 중이면 이름을 뺀다**(`showCharacter = false`). 제목이 이미 그 이름을
 *   말하고 있어서, 줄마다 반복하면 같은 이름이 열두 번 서고 정작 보스와 금액이 밀린다
 *   (파티 드롭다운에서 구성원 줄을 걷어낸 것과 같은 이유, 2026-09-02).
 *   2026-09-04 에 `!숙제 <닉네임>` 이 생기면서 이 주석이 드디어 코드가 됐다 — 그전까지는
 *   이름을 붙이는 화면 하나뿐이라 인자로 가를 것이 없었다.
 */
function remainingRow(
  item: RemainingBoss,
  index: number,
  showCharacter: boolean,
): string {
  /*
    ★ **시즌만 적는다.** 시즌은 12칸을 안 먹는데 **주간 목록에 섞여 들어오므로**, 안 적으면
      같은 목록 안에서 성질이 다른 줄이 구분되지 않는다.
    ★ `(월간)` 은 **뺐다**(2026-09-07). 월간은 `!검마` 라는 **자기 목록**에만 나오고 그
      제목이 이미 `(매월 1일 초기화)` 라고 말한다 — `1. 익검(월간) 43억` 은 같은 사실을 두
      번 적는 것이었다. 바로 아래 `handleRemaining` 의 제목 주석이 *"한 목록에 한 시계만
      있으므로 줄마다 (월간) 을 적을 필요가 없다"* 고 이미 선언해 놓고 코드만 반대였다.
      주석이 아니라 코드를 고친 이유는 그 주석이 맞는 말이기 때문이다.
      ⚠️ 월간이 다시 주간과 **한 목록에 섞이는 날**에는 이 표기가 되살아나야 한다.
  */
  const cycle = item.cycle === "season" ? "(시즌)" : "";
  const who = showCharacter ? ` ${item.characterName}` : "";
  return `${String(index + 1)}. ${item.shortName}${cycle}${who} ${formatMesoCompact(item.shareMeso)}`;
}

/**
 * `!숙제` — 남은 보스를 값 큰 순서로. 닉네임을 붙이면 **그 캐릭터 하나**만 본다.
 *
 * ★ `!숙제 <닉네임>`(캐릭터 필터)은 하루 만에 **뺐다**(발주 지시 2026-09-02).
 *   한 화면에 열다섯 줄이 캐릭터 이름까지 달고 나가므로, 한 명만 보려고 다시 치는 것보다
 *   그 목록에서 눈으로 찾는 편이 빠르다 — 명령이 늘면 외울 것도 는다.
 *
 * ★ **그리고 2026-09-04 에 다시 들어왔다.** 발주 지시: *"어차피 캐릭당 제한은 뻔하니
 *   !숙제 닉네임하면 그 캐릭터 만 하라고. 그 캐릭터 남은 몇개 남은메소 얼마 최대 얼마
 *   그 밑에 보스 목록."* 위에서 뺀 것과 **같은 것이 아니다.** 그때 뺀 것은 *같은 목록을
 *   이름으로 거른 것*이라 정말로 눈으로 찾는 편이 빨랐다. 이번 것은 그 목록에 없는 값이
 *   머리에 붙는 **다른 화면**이다 — `남은 개수 · 남은 메소 / 최대(이번 주 계획 전액)`.
 *   "최대"는 전체 목록이 답할 수 없는 질문(*이 캐릭 하나를 다 돌면 얼마인가*)이고,
 *   `v_weekly_plan_potential_by_character` 를 읽어야 나온다. 그래서 되돌린 것이 아니라
 *   더한 것이다. 기록을 지우지 말 것 — 지우면 다음 사람이 "왜 뺐다가 넣었지"를 모른다.
 * ★ **금액 문턱(`HOMEWORK_MIN_MESO`)은 캐릭터 화면에 적용하지 않는다.** 지시가
 *   *"안한거 다 보여주는"* 이고, 한 캐릭터는 많아야 12~13줄이라 접을 이유가 없다.
 *   인자 없는 전체 목록에는 문턱이 **그대로 살아 있다** — 45캐릭터를 한 화면에 놓는
 *   그쪽은 접지 않으면 읽을 수가 없다.
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
async function handleRemaining(
  context: CommandContext,
  parsed: ParsedCommand,
  account: BotAccount | null,
  scope: RemainingBossScope,
): Promise<CommandOutcome> {
  const tag = scope === "monthly" ? "검마" : "숙제";
  if (account === null) {
    return { reply: needsLinkReply(), tag: `${tag}:미연결`, userId: null };
  }

  /*
    ★ **`!검마 <닉네임>` 도 같은 길로 간다.** 한 함수가 두 명령을 모는데 한쪽만 인자를
      받으면 그 자체가 다음 버그다. 월간은 사실상 검은 마법사 하나뿐이라 목록은 한 줄로
      끝나지만, `남은 / 최대` 요약은 그 한 줄에서도 뜻이 있다(안 돌았으면 87.4억 / 87.4억).
  */
  const nickname = parsed.rest.trim();
  if (nickname !== "") {
    return handleRemainingForCharacter(context, account, scope, nickname, tag);
  }

  /*
    ★ **주기를 섞지 않는다**(발주 지시 2026-09-02: *"!숙제 이거 검마 월간 제외해서
      !검마 이걸로 전부 이동. !숙제는 주간만"*). 같은 날 오전에 한 목록으로 합쳤다가
      되돌린 것이고, 근거는 `RemainingBossScope` 머리말에 있다 — 요지는 금액 한 축으로
      줄을 세우면 **두 종류의 급함이 섞이고 언제나 월간이 이긴다**는 것이다.
  */
  const remaining = await fetchRemainingBosses(context.db, account.userId, {
    scope,
  });

  /*
    ★ 제목이 **초기화 시계를 말한다.** 주간은 목요일 00:00, 월간은 달이 바뀔 때다.
      한 목록에 한 시계만 있으므로 줄마다 `(월간)` 을 적을 필요가 없어졌다 — 그건
      섞여 있을 때만 필요한 표시였다(`remainingRow` 는 시즌만 계속 표시한다).
  */
  const title =
    scope === "monthly"
      ? "💎 남은 월간 보스 (매월 1일 초기화)"
      : `💎 남은 주간 보스 (${resetLabel(context.now)})`;

  if (remaining.items.length === 0) {
    return {
      reply: block(title, [
        "남은 보스 없음 👏",
        remaining.unknownCount > 0
          ? `가격 미확인 ${String(remaining.unknownCount)}건은 세지 않았어요.`
          : null,
      ]),
      tag: `${tag}:빈`,
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
      tag: `${tag}:문턱`,
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
      ...shown.map((item, index) => remainingRow(item, index, true)),
      ...tailNotes,
    ),
    long: true,
    tag,
    userId: account.userId,
  };
}

/** 이름을 몇 개까지 늘어놓나. 그 이상은 평문 한 줄에서 읽히지 않는다. */
const CHARACTER_NAME_CLIP = 4;

/**
 * 닉네임을 못 풀었을 때의 답장. **원인 셋을 한 문장으로 접지 않는다**(CLAUDE.md §2.1.2 —
 * *"어느 원인인지와 무엇을 하면 되는지를 말할 것"*).
 *
 * 셋을 "못 찾았어요"로 합쳐 두었더니(2026-09-04 최초 구현) 이런 일이 벌어졌다.
 * · `!숙제 더` — 실제로는 `더저`·`더줘마` **둘을 찾았는데** 못 찾았다고 답했다. 사용자는
 *   오타로 읽고 **같은 것을 다시 친다.** 필요한 행동(더 길게 치기)이 문장에 없었다.
 * · `!숙제 <실존하지만 추적 안 하는 캐릭>` — 할 일은 이름 고치기가 아니라 **웹에서 추적에
 *   추가하기**다. 캐릭터 304개 중 9개만 추적하는 계정이 있어 이쪽이 훨씬 흔하다.
 * 그래서 `reason` 별로 **문장과 `tag` 를 함께** 가른다. 태그가 같으면 로그에서도 셋이
 * 구분되지 않아 "얼마나 자주 헛치는가"를 영영 못 센다.
 */
function characterMissReply(
  miss: CharacterLookupMiss,
  nickname: string,
  tag: string,
  userId: string,
): CommandOutcome {
  /*
    조사(는/은) 때문에 이름을 문장 가운데 넣지 않는다. `'더저레테' 캐릭터는` 처럼 **고정된
    낱말 뒤에 조사를 붙이면** 어떤 이름이 와도 문장이 깨지지 않는다.
  */
  const joined = clipList(miss.names, CHARACTER_NAME_CLIP).join(" · ");
  const firstName = miss.names[0] ?? nickname;

  if (miss.reason === "ambiguous") {
    return {
      reply: block(`🔍 '${nickname}' 에 걸리는 캐릭터가 여럿이에요.`, [
        `후보: ${joined}`,
        `!${tag} ${firstName} 처럼 더 길게 입력해 주세요.`,
      ]),
      tag: `${tag}:캐릭모호`,
      userId,
    };
  }

  if (miss.reason === "untracked") {
    return {
      reply: block(`🔍 '${firstName}' 캐릭터는 추적 목록에 없어요.`, [
        "웹의 [기타] 화면에서 추적 캐릭터로 추가하면 여기서도 보여요.",
        `!${tag} 는 추적 중인 캐릭터만 셉니다.`,
      ]),
      tag: `${tag}:캐릭비추적`,
      userId,
    };
  }

  /*
    추적은 켜져 있는데 넥슨 목록에서 사라진 캐릭터(월드 리프 · 삭제). 할 일이 또 다르다 —
    이름을 고칠 일도, 추적에 **추가**할 일도 아니고 **추적을 해제**하는 것이다.

    ⚠️ **"자동으로 돌아옵니다"라고 쓰면 거짓말이 된다** (교차 검증 2026-09-14). 시킨 대로
       해제하면 `is_tracked = false` 가 되고, 나중에 그 캐릭터가 다시 보여도
       `syncCredentialInventory` 는 `missing_since` 만 풀고 **`is_tracked` 는 일부러 덮지
       않는다**(`auth/server/account.ts` — 그건 사용자의 선택이라서). 즉 자동으로 돌아오는
       것은 **선택 목록**이지 **추적**이 아니다. 두 문장을 이어 읽으면 지키지 못할 약속이
       되므로, 돌아오는 것이 무엇인지 정확히 가리키고 마지막 한 걸음은 사용자 몫으로 남긴다.
    ⚠️ 리프는 편도라 "기다리면 돌아온다"고도 말하지 않는다(발주 2026-09-14 — 챌린저스는
       시즌이 끝나면 그 캐릭터가 아예 없어진다). 다만 원인이 키 회수일 수도 있어
       "다시 보이면" 이라는 가정형까지만 쓴다.
  */
  if (miss.reason === "missing") {
    return {
      reply: block(`🔍 '${firstName}' 캐릭터는 넥슨 목록에서 사라졌어요.`, [
        "월드 이동이나 삭제로 더는 조회되지 않습니다. 기록은 그대로 남아 있어요.",
        "웹의 [기타] 화면에서 추적을 해제해 주세요.",
        "다시 보이면 선택 목록에 나타나니, 그때 추적을 다시 켜 주시면 됩니다.",
      ]),
      tag: `${tag}:캐릭사라짐`,
      userId,
    };
  }

  return {
    reply: block(`🔍 '${nickname}' 캐릭터를 못 찾았어요.`, [
      miss.names.length > 0
        ? `내 캐릭터: ${joined}`
        : "추적 중인 캐릭터가 없어요.",
      miss.names.length > 0
        ? `!${tag} ${firstName} 처럼 입력해 주세요.`
        : "웹의 [기타] 화면에서 캐릭터를 먼저 선택해 주세요.",
    ]),
    tag: `${tag}:캐릭없음`,
    userId,
  };
}

/**
 * `!숙제 <닉네임>` · `!검마 <닉네임>` — **한 캐릭터짜리 화면**.
 *
 * 답장 모양(발주 지시 2026-09-04의 순서 그대로):
 * ```
 * 📋 핏자 (~09/11 00:00)
 * 남은 12개 · 45억 7,000만 / 최대 45억 7,000만
 * ───────────────
 * 1. 하세 3억 5,600만
 * ```
 * ★ **줄마다 캐릭터 이름을 반복하지 않는다** — 제목이 이미 그 이름이다(`remainingRow`).
 * ★ **`최대` 는 DB 뷰가 소유한다**(`fetchCharacterPlanPotential`). 여기서 계획 행을 더해
 *   최대치를 만들면 웹 수익 화면과 방이 다른 숫자를 말하게 된다.
 * ★ `남은` 과 `최대` 는 **같은 범위**여야 한다. 뷰의 `cycle` 이 시즌을 주간에 합쳐 놓았기
 *   때문에 `scope` 하나로 둘이 맞는다(그 함수 머리말). 어긋나면 "남은 게 최대보다 크다"가
 *   화면에 그대로 나온다.
 * ★ 목록을 자르지 않는다 — 한 캐릭터의 상한이 12~13줄이라 `longLines` 예산(40줄·1,200자)
 *   안에 넉넉히 들어간다. 그래도 `long: true` 는 켠다. 라우트가 마지막에 한 번 더 평문
 *   규칙을 적용하므로 하나만 켜면 도로 잘린다.
 */
async function handleRemainingForCharacter(
  context: CommandContext,
  account: BotAccount,
  scope: RemainingBossScope,
  nickname: string,
  tag: string,
): Promise<CommandOutcome> {
  const found = await resolveMyCharacter(context.db, account.userId, nickname);

  if (!found.found) {
    return characterMissReply(found, nickname, tag, account.userId);
  }

  const [remaining, potential] = await Promise.all([
    fetchRemainingBosses(context.db, account.userId, {
      scope,
      characterId: found.characterId,
    }),
    fetchCharacterPlanPotential(
      context.db,
      account.userId,
      found.characterId,
      scope,
    ),
  ]);

  const title =
    scope === "monthly"
      ? `📋 ${found.characterName} (매월 1일 초기화)`
      : `📋 ${found.characterName} (${resetLabel(context.now)})`;

  /*
    계획이 하나도 없으면 뷰에 행이 없다(`null`). 그때 `최대 0` 이라고 적으면 "0원이 상한"
    이라는 **사실 주장**이 되므로 그 조각을 통째로 뺀다 — 모른다와 0 은 다른 말이다.
  */
  const summaryLine = [
    `남은 ${String(remaining.items.length)}개 · ${formatMesoCompact(remaining.totalMeso)}`,
    potential === null
      ? null
      : `최대 ${formatMesoCompact(potential.potentialMeso)}`,
  ]
    .filter((part): part is string => part !== null)
    .join(" / ");

  /*
    ⚠️ **최대치는 12칸을 넘는 계획을 뺀 값**이다(`over_limit_count`). 13개를 걸어 놓고
       하나도 안 돈 캐릭터라면 남은 합이 최대보다 커 보일 수 있으므로, 그 이유를 말한다.
       숫자가 어긋난 채 침묵하면 사용자는 우리 계산이 틀렸다고 읽는다.
  */
  const tailNotes = [
    remaining.unknownCount > 0
      ? `가격 미확인 ${String(remaining.unknownCount)}건 제외`
      : null,
    potential !== null && potential.overLimitCount > 0
      ? `12칸 초과 ${String(potential.overLimitCount)}건은 최대에서 뺐어요`
      : null,
  ];

  if (remaining.items.length === 0) {
    /*
      ★ **요약줄을 내지 않는다**(2026-09-07). `formatMesoCompact(0)` 은 단위 없는 맨 `"0"`
        이라 `남은 0개 · 0 / 최대 87억 4,000만` 이라는 줄이 나갔다 — 읽는 사람 눈에는
        금액이 잘린 것처럼 보이고, 옆의 "최대"는 *아직 벌 수 있는 돈*으로 읽힌다.
        실제로는 정반대(다 돌았다)이므로 그 줄은 틀린 인상을 준다.
      ★ 형제 경로(인자 없는 `!숙제` 의 빈 응답)가 이미 이 답을 갖고 있다 — 제목 + 한 줄.
        같은 상황에 두 화면이 다른 말을 하지 않게 **문구까지 같은 것을 쓴다.**
      ★ 드문 예외가 아니다: 추적×범위 94조합 중 **18조합(19%)** 이 이 경로이고,
        `!검마 <닉>` 은 검마를 한 번 잡은 달 내내 여기로 온다.
      ★ 최대치는 여기서 뜻이 없어 뺐다. "이번 주 계획을 다 돌면 얼마"라는 질문은
        **아직 남은 것이 있을 때만** 행동을 바꾼다.
    */
    return {
      reply: block(title, [
        "남은 보스 없음 👏",
        remaining.unknownCount > 0
          ? `가격 미확인 ${String(remaining.unknownCount)}건은 세지 않았어요.`
          : null,
      ]),
      tag: `${tag}:캐릭빈`,
      userId: account.userId,
    };
  }

  return {
    reply: longLines(
      title,
      summaryLine,
      DIVIDER,
      ...remaining.items.map((item, index) =>
        remainingRow(item, index, false),
      ),
      ...tailNotes,
    ),
    long: true,
    tag: `${tag}:캐릭`,
    userId: account.userId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// !파티 — **목록뿐이다**
// ─────────────────────────────────────────────────────────────────────────────
//
// ★ 2026-09-28 에 `!파티연결` · `!파티해제` 가 내려갔다. 그 둘은 `parties.bot_channel_id`
//   를 채워 "이 파티의 알림이 갈 방"을 정하는 명령이었고, 그 값을 읽던 곳은 알림 적재
//   하나뿐이었다. 방도 알림도 없으므로 정할 것이 없다.
//
// ★ **그래서 목록은 남긴다.** 번호가 가리킬 명령이 없어졌으니 목록도 필요 없다고 볼 수
//   있는데, 이 답장은 번호를 주기 전부터 "내가 지금 어느 파티에 껴 있나"에 답하고 있었다.
//   `!일정` 은 잡힌 일정만 보여 주므로 일정이 하나도 없는 주에는 그 질문에 답할 수 없다.
//   줄에서 사라진 것은 방 꼬리표(`✅ 이 방` · `(다른 방)`)와 맨 아래 사용법 두 줄이다.
//
// ★ ═══════════════════════════════════════════════════════════════════════════
//   **같은 날 번호가 다시 입력이 됐다** — `!보스 19시20분 3` 의 `3` 이 이 줄 번호다.
//   ═══════════════════════════════════════════════════════════════════════════
//   그래서 목록을 자르면 **칠 수 있는 번호를 가리게 된다.** 잘린 뒤의 파티는 화면에
//   번호가 없을 뿐 `!보스 ... 9` 로 멀쩡히 잡히므로, 사용자는 있는 줄 모르고 웹으로 간다.
//   상한을 8 → 12 로 올린 근거는 실측이다(2026-09-28, 파티가 가장 많은 실제 계정 11개):
//   11줄을 전부 펼치고 맨 아래 사용법까지 붙여 **288자 · 15줄**, 답장 예산(342자 · 20줄) 안이다.
//   ⚠️ 바인딩하는 것은 줄 수가 아니라 **글자 수**다. 12 를 더 올리려면 줄 수가 아니라
//      `REPLY_CHAR_BUDGET` 을 먼저 계산할 것 — 넘으면 `…외 N건` 줄부터 잘려 나가고,
//      그것이 하필 "잘렸다는 사실"을 숨기지 않으려고 넣은 줄이다.

/** 한 답장에 펼칠 파티 줄 수. 근거는 바로 위 ★ 블록(실측 288자 · 15줄). */
const PARTY_LIST_MAX = 12;

async function handleParties(
  context: CommandContext,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  if (account === null) {
    return { reply: needsLinkReply(), tag: "파티:미연결", userId: null };
  }

  const parties = await listBotParties(context.db, account.userId, context.now);

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

  const rendered = parties.map(
    (party, index) =>
      `${String(index + 1)}. ${party.name} · 런 ${String(party.runCount)}`,
  );

  return {
    reply: block("👥 내 파티", [
      ...clipList(rendered, PARTY_LIST_MAX),
      DIVIDER,
      // 번호가 무엇에 쓰이는지 여기서 말해 주지 않으면 `!보스` 를 아무도 못 찾는다.
      "!보스 19시20분 3  ← 3번 파티에 잡기",
    ]),
    tag: "파티",
    userId: account.userId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// !보스 — 한 줄로 일정 잡기
// ─────────────────────────────────────────────────────────────────────────────
//
// 발주 지시(2026-09-28): *"기존에 파티를 생성할때 보스 선택하는것을 이용하여
// `!보스 19시20분 3` 같은 명령어를 치면 3파티의 19시 20분에 보스가 잡히게되고 답변으로
// 가는 보스, 가는 파티원의 닉네임을 출력하게 바꿔봐"*
//
// ★ ═══════════════════════════════════════════════════════════════════════════
//   **명령에서 고르는 것은 시각과 파티뿐이다.** 나머지는 전부 파티가 이미 안다.
//   ═══════════════════════════════════════════════════════════════════════════
//   갈 보스는 `party_bosses`(웹 파티 만들기 3단계에서 고른 그 목록), 참여자는 그 파티의
//   구성원 전원, 1/n 분모는 그 인원 수, 내 캐릭터는 파티에 지정해 둔 캐릭터다. 방에서
//   치는 한 줄에 그것들을 다시 담게 하면 명령이 문장이 되고, 문장은 아무도 안 친다.
//
// ★ **저장은 웹 시간표와 같은 `createPartyRuns` 하나다.** 순차 배치(`시작 + 20분 × i`) ·
//   `run_no` 부여 · 캐릭터 소유/추적 검증 · 참가자 펼치기가 전부 그 안에 있다. 여기서
//   INSERT 를 새로 쓰면 그 넷이 두 벌이 되고, 두 벌이 된 것은 반드시 갈라진다.
//
// ★ **실패는 HTTP 오류가 아니라 답장이다**(라우트 머리말). `createPartyRuns` 가 던지는
//   4xx 는 라우트가 평문으로 접어 주므로, 여기서는 *사람이 고칠 수 있는 말*을 우리가
//   먼저 만들 수 있는 경우(번호 범위 · 보스 없음 · 겹침)만 직접 답한다.

/** 파티 번호 토막. `3` · `3번` 둘 다 받는다. 두 자리까지 — 파티가 100개인 사람은 없다. */
const PARTY_NO_TOKEN = /^(\d{1,2})번?$/u;

/** 한 답장에 늘어놓을 최대 줄 수. 넘으면 `clipList` 가 `…외 N건` 으로 접는다. */
const BOSS_LINE_MAX = 8;
const MEMBER_NAME_MAX = 10;

function bossUsageReply(): string {
  return lines(
    "시각과 파티 번호를 같이 적어 주세요.",
    "!보스 19시20분 3  ·  !보스 21시 1  ·  !보스 오후9시 2",
    "번호는 !파티 목록의 순번이에요.",
  );
}

async function handleBossSchedule(
  context: CommandContext,
  parsed: ParsedCommand,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  if (account === null) {
    return { reply: needsLinkReply(), tag: "보스:미연결", userId: null };
  }

  /*
    ★ **순서를 강제하지 않는다.** 시각은 반드시 `시` 나 `:` 를 달고 있고(파서 규약,
      `parseClockMinute` 주석) 파티 번호는 맨 숫자이므로, 두 토막은 **모양만으로** 갈린다.
      그래서 `!보스 3 19시20분` 도 그대로 통한다 — 방에서 순서를 외우게 할 이유가 없다.
  */
  let startMinute: number | null = null;
  let partyNo: number | null = null;
  for (const token of parsed.args) {
    if (startMinute === null) {
      const minute = parseClockMinute(token);
      if (minute !== null) {
        startMinute = minute;
        continue;
      }
    }
    if (partyNo === null) {
      const matched = PARTY_NO_TOKEN.exec(token);
      if (matched !== null) partyNo = Number(matched[1]);
    }
  }

  if (startMinute === null || partyNo === null) {
    return {
      reply: bossUsageReply(),
      tag: "보스:형식불명",
      userId: account.userId,
    };
  }

  /*
    ★ **`!파티` 와 같은 함수를 부른다.** 사람은 `!파티` 로 본 번호를 그대로 치므로, 목록을
      여기서 다시 만들면 눈에 보이는 번호와 실제로 잡히는 파티가 조용히 달라진다
      (`listBotParties` 머리말).
  */
  const parties = await listBotParties(context.db, account.userId, context.now);
  if (parties.length === 0) {
    return {
      reply: lines(
        "참여 중인 파티가 없어요.",
        "웹에서 파티를 만들면 번호가 생깁니다.",
      ),
      tag: "보스:파티없음",
      userId: account.userId,
    };
  }

  const party = parties[partyNo - 1];
  if (party === undefined) {
    return {
      reply: lines(
        `${String(partyNo)}번 파티가 없어요.`,
        `지금 번호는 1~${String(parties.length)} 이에요. !파티 로 확인해 주세요.`,
      ),
      tag: "보스:번호범위밖",
      userId: account.userId,
    };
  }

  const [bosses, members] = await Promise.all([
    fetchPartyBosses(account.userId, party.partyId),
    fetchPartyMembers(account.userId, party.partyId),
  ]);

  if (bosses.length === 0) {
    return {
      reply: lines(
        `'${party.name}' 에 갈 보스가 정해져 있지 않아요.`,
        "웹 파티 관리에서 보스를 먼저 고르면 이 명령이 그대로 통합니다.",
      ),
      tag: "보스:보스없음",
      userId: account.userId,
    };
  }
  if (members.length === 0) {
    return {
      reply: lines(`'${party.name}' 에 파티원이 없어요.`),
      tag: "보스:파티원없음",
      userId: account.userId,
    };
  }

  /*
    ★ **날짜는 오늘(KST) 고정이다**(발주 지시 2026-09-28). 이미 지난 시각이어도 내일로
      밀지 않는다 — 밀면 `!보스 19시 1` 을 19시 5분에 친 사람이 **내일 일정을 만든 줄
      모르고** 방을 기다린다. 오늘로 잡고 그 사실을 한 줄로 알리는 쪽이 예측 가능하다.
    ★ `kstMoment` 가 KST 달력 날짜 + 자정 기준 분 → 실제 시각을 만든다. 직접 UTC 로
      계산하지 않는다(§1 — 주 경계 계산은 전부 KST).
  */
  const startsAt = kstMoment(kstDayKey(context.now), startMinute);
  const spanMinutes = bosses.length * DEFAULT_DURATION_MINUTES;
  const endsAt = new Date(startsAt.getTime() + spanMinutes * 60_000);

  const conflict = await findPartyRunConflict(
    context.db,
    party.partyId,
    startsAt,
    endsAt,
  );
  if (conflict !== null) {
    return {
      reply: lines(
        `'${party.name}' 은(는) 그 시간에 이미 일정이 있어요.`,
        `${formatKst(conflict, "M/d HH:mm")} 시작 — 다른 시각으로 잡거나 웹에서 고쳐 주세요.`,
      ),
      tag: "보스:겹침",
      userId: account.userId,
    };
  }

  /*
    ★ 캐릭터 우선순위는 **① 이 파티에 지정한 캐릭터 → ② 본캐**다. 시간표 등록 창
      (`timetable-run-dialog`)이 쓰는 순서를 그대로 옮겼다 — 같은 파티에 웹으로 잡든
      방에서 잡든 같은 캐릭터가 붙어야 결정석 12칸이 한 캐릭터에 모인다.
    ★ 두 단계 모두 `fetchMyRunCharacters` 안에서 다시 찾는다. 추적을 끊었거나 넥슨 목록에서
      사라진 캐릭터가 `party_participants` 에 남아 있을 수 있고, 그 id 를 그대로 보내면
      `createPartyRuns` 가 거절한다.
  */
  const characters = await fetchMyRunCharacters(account.userId);
  const myPartyCharacterId =
    members.find((member) => member.personId === account.userId)?.characterId ??
    null;
  const character =
    characters.find((entry) => entry.characterId === myPartyCharacterId) ??
    characters[0] ??
    null;
  if (character === null) {
    return {
      reply: lines(
        "일정에 데려갈 캐릭터가 없어요.",
        "웹에서 추적할 캐릭터를 먼저 골라 주세요.",
      ),
      tag: "보스:캐릭터없음",
      userId: account.userId,
    };
  }

  await createPartyRuns(account.userId, {
    partyId: party.partyId,
    // 순서가 곧 배치 순서다(`sortOrder` 오름차순으로 이미 정렬돼 온다).
    bossDifficultyIds: bosses.map((boss) => boss.bossDifficultyId),
    scheduledAt: startsAt,
    durationMinutes: DEFAULT_DURATION_MINUTES,
    // 1/n 의 분모(§1.3 D3). 기본값은 등록된 참여자 수이고, 웹에서 고칠 수 있다.
    entryPartySize: members.length,
    participantPersonIds: members.map((member) => member.personId),
    characterId: character.characterId,
    note: null,
  });

  /*
    ★ **가는 보스와 시각을 한 줄씩** 적는다. 여러 보스면 시작 시각이 20분씩 밀리는데,
      그것이 이 명령의 결과에서 사람이 가장 모르는 부분이다 — "19시20분이라 했는데 왜
      20시야"가 나오지 않게 계산 결과를 그대로 보여 준다.
    ★ 참여자는 **닉네임**이다(발주 지시). `displayName` 은 게스트도 갖고 있어 빈 칸이 없다.
  */
  const bossLines = bosses.map((boss, index) => {
    const at = new Date(startsAt.getTime() + index * DEFAULT_DURATION_MINUTES * 60_000);
    return `${formatKst(at, "HH:mm")}  ${boss.shortName}`;
  });
  const names = clipList(
    members.map((member) => member.displayName),
    MEMBER_NAME_MAX,
  );

  return {
    reply: block(
      `🗓 ${party.name} (${String(partyNo)}번) · ${formatDayKeyKo(kstDayKey(startsAt))} ${formatClockMinute(startMinute)}`,
      [
        ...clipList(bossLines, BOSS_LINE_MAX),
        DIVIDER,
        `참여 ${String(members.length)}명 · ${names.join(", ")}`,
        `내 캐릭터 · ${character.name}`,
        // 지난 시각을 조용히 넘기지 않는다 — 사용자가 오타를 바로 알아챌 유일한 단서다.
        startsAt.getTime() < context.now.getTime()
          ? "⏰ 이미 지난 시각이라 오늘 그대로 잡았어요."
          : null,
      ],
    ),
    tag: "보스",
    userId: account.userId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// !결정석
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 남은 보스 **한 줄**. 하나도 없으면 "다 돌았다"를 말한다 — 빈 자리는 아무 말도 하지 않아
 * "조회가 안 됐나"로 읽힌다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 상위 3개 목록은 **뺐다** (발주 지시 2026-09-02 — 원하는 답장 모양을 그대로 붙여 줌)
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-08-25 에 이 자리를 목록이 받은 이유는 *"합계는 이미 끝난 일이고 알고 싶은 것은
 * 아직 할 일"* 이었다. 그 이유는 지금도 맞지만 **답하는 곳이 바뀌었다** — 같은 날
 * `!숙제` 가 15줄짜리 목록을 통째로 가져갔다(월간까지). 그렇다면 여기 3줄은 그 목록의
 * 잘린 앞부분일 뿐이고, 두 명령이 같은 것을 다른 길이로 말하면 어느 쪽이 전부인지가
 * 흐려진다. 여기는 **얼마나 남았는지 한 줄**만 말하고, 무엇이 남았는지는 아래
 * `!숙제 —` 안내가 넘긴다.
 *
 * ⚠️ 그래서 이 줄은 **문턱(2억)을 보지 않는다.** 세는 것이 "갈 만한 것"이 아니라
 *    "남은 전부"이기 때문이다. 문턱은 목록에 줄을 내줄지 정하는 규칙이고 목록은 여기 없다.
 */
function remainingLines(remaining: RemainingSummary): readonly string[] {
  if (remaining.items.length === 0) {
    return remaining.unknownCount > 0 ? [] : ["이번 주 남은 보스 없음 👏"];
  }

  /*
    범위를 밝힌다 — 위 묶음이 주기별로 갈라 말했으므로, 안 밝히면 전부를 합친 값으로
    읽힌다. 여기 담긴 것은 **이번 주에 초기화되는 것**(주간 + 시즌)이고 월간은 빠져 있다
    (`fetchRemainingBosses` 머리말). 월간까지 세는 것은 `!숙제` 다.
  */
  return [
    `이번 주 남은 ${String(remaining.items.length)}건 · ${formatMesoCompact(remaining.totalMeso)}`,
  ];
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
        "남은 보스 목록은 !숙제(주간) · !검마(월간) 로 옮겨졌어요.",
        "인자 없이 치면 돼요.",
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
        않는다. 그래서 `합계` 줄을 빼고 그 자리를 남은 것이 받는다.

        ⚠️ **상위 3개 목록은 2026-09-02 에 빠졌다** — 같은 날 `!숙제` 가 15줄짜리 목록을
           가져갔고, 여기 3줄은 그 목록의 잘린 앞부분일 뿐이었다(근거는 `remainingLines`).
           남은 것은 **한 줄**이고 금액은 개인 수령액(1/n)이다(§1 · D3).
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
        이 답장은 "얼마나 남았나"까지만 말한다. **무엇이 남았는지**는 여기에 없고, 그
        길이 있다는 사실도 어디에도 적혀 있지 않았다. `!도움말` 은 명령 이름만 나열하므로
        무엇을 주는지까지는 말하지 않는다 — 그 한 줄이 여기 있어야 하는 이유다.
        범위(월간 포함)를 밝히는 것이 핵심이다: 위 `남은 N건` 에는 월간이 빠져 있어서,
        안 적으면 두 답의 숫자가 왜 다른지 알 수 없다.

        ★ **개수는 적지 않는다**(발주 지시 2026-09-02: *"몇개 말고 그냥 남은보스목록"*).
          상한은 오늘만 20 → 15 로 한 번 바뀌었고, 바뀔 때마다 이 줄이 같이 낡는다.
          게다가 읽는 사람에게 필요한 것은 "15"가 아니라 **그런 목록이 있다는 사실과 그
          범위**다. 몇 줄이 나오는지는 쳐 보면 바로 보인다.
        ★ 앞의 빈 줄은 **묶음을 가르는 표시**다. 바로 위는 이 계정의 숫자이고 이 줄은
          다른 명령 안내라, 붙여 두면 안내가 숫자의 일부로 읽힌다.
      */
      "",
      "!숙제 — 남은 주간 보스 · !검마 — 월간",
    ]),
    tag: "결정석",
    userId: account.userId,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// !결정패치
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 답장에 나가는 주기와 그 라벨. **순서가 곧 답장의 순서**다(주간 먼저 — `!결정석` 과 같다).
 */
const PATCH_CYCLES: ReadonlyArray<readonly [PatchCycle, string]> = [
  ["weekly", "주간"],
  ["monthly", "월간"],
];

/**
 * 한 주기의 세 줄. 그 주기에 예정 변경이 없거나 켜 둔 계획이 없으면 `null` — **줄을
 * 만들지 않는다.**
 *
 * ★ 계획이 0건인 주기에 `0원 → 0원` 을 찍지 않는 이유는 §1.3 D4 와 같다. 그건 "안 바뀐다"가
 *   아니라 "셀 것이 없다"이고, 두 문장은 사람이 할 일이 다르다.
 */
function crystalPatchLines(
  cycle: PatchCycle,
  label: string,
  patch: ScheduledPricePatch,
  before: ReadonlyMap<PatchCycle, PlanPotentialAt>,
  after: ReadonlyMap<PatchCycle, PlanPotentialAt>,
): readonly string[] | null {
  const changeAt = patch.firstChangeAt[cycle];
  if (changeAt === undefined) return null;

  const now = before.get(cycle);
  const then = after.get(cycle);
  if (now === undefined || then === undefined) return null;

  const delta = then.potentialMeso - now.potentialMeso;
  /*
    금액은 `formatMesoCompact` 그대로다(새 포맷터를 만들지 않는다 — `!결정석` 과 같은
    숫자를 다른 모양으로 쓰면 두 답장을 나란히 놓고 읽을 수 없다). 음수는 이 함수가
    `-47억 8,240만` 으로 부호를 붙여 주지만 **양수에는 안 붙는다.** 시세는 오르기도 하므로
    `+` 를 직접 붙인다 — 부호 없는 증가분은 "얼마로 바뀐다"로 잘못 읽힌다.
  */
  const signed = `${delta > 0 ? "+" : ""}${formatMesoCompact(delta)}`;
  /*
    비율은 **현재값이 0 보다 클 때만.** 0 으로 나눈 `Infinity%` 를 방에 내보내느니 금액만
    말하는 편이 낫다.
  */
  const ratio =
    now.potentialMeso > 0
      ? ` · ${delta > 0 ? "+" : ""}${((delta / now.potentialMeso) * 100).toFixed(1)}%`
      : "";

  return [
    /*
      ★ **주기마다 자기 날짜를 찍는다.** 주간은 9/17 10시(목요일 점검 종료), 월간은
        10/1 0시(월간 리셋 경계)로 서로 다르다 — 한 날짜를 양쪽에 쓰면 거짓이다.
        날짜 자체는 `boss_crystal_prices.effective_from` 에서 온다(코드에 박지 않는다).
    */
    `${label} (${formatKst(changeAt, "M/d H시")})`,
    `${formatMesoCompact(now.potentialMeso)} → ${formatMesoCompact(then.potentialMeso)}`,
    delta === 0 ? "변동 없음" : `${signed}${ratio}`,
  ];
}

/**
 * 다가오는 결정석 시세 패치가 **내 최대 수익**을 얼마에서 얼마로 바꾸는가.
 *
 * 발주 지시(2026-09-14): *"!결정석이랑 비슷한거임. 그냥 전체 얼마 -> 얼마로 패치된건지
 * 주간 월간 둘다 내꺼 보여주면됨."* + *"친 사람꺼"* — 그래서 범위는 `!결정석` 과 같은
 * **발신자 계정**이고, 미연결·정지 계정 처리도 같다(`resolveAccount` 가 이미 접어 준다).
 *
 * ★ **날짜를 코드에 박지 않는다**(`fetchScheduledCrystalPricePatch` 머리말). 패치가
 *   전부 발효되면 이 명령은 스스로 "예정된 시세 변경이 없어요"가 된다 — 낡아서 거짓말을
 *   하는 대신 조용해지는 쪽이다.
 * ★ **인자를 받지 않는다.** 받을 것이 없다(대상은 언제나 친 사람 본인). `!결정석` 처럼
 *   옛 인자를 안내할 이력도 없으므로, 붙여 친 인자는 그냥 무시한다.
 */
async function handleCrystalPatch(
  context: CommandContext,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  if (account === null) {
    return { reply: needsLinkReply(), tag: "결정패치:미연결", userId: null };
  }

  const title = "💎 결정석 시세 패치";

  const patch = await fetchScheduledCrystalPricePatch(context.db, context.now);
  if (patch === null) {
    /*
      **정상 종료다.** 오류처럼 보이게 쓰지 않는다 — 예정된 패치가 없는 기간이 평소이고,
      이 명령이 낡지 않는다는 사실 자체가 설계의 핵심이다.
    */
    return {
      reply: block(title, ["예정된 시세 변경이 없어요."]),
      tag: "결정패치:없음",
      userId: account.userId,
    };
  }

  /*
    "지금"과 "패치 후" 두 시점을 나란히 묻는다. 서로를 기다릴 이유가 없고, 같은 DB 함수라
    두 번째 호출이 첫 번째보다 비싸지도 않다.
    ★ 기준 시각은 **예정 변경 중 가장 늦은 것**이다 — 그래야 주간(9/17)과 월간(10/1)이
      둘 다 반영된 최종 상태가 나온다(`ScheduledPricePatch.appliedAt`).
  */
  const [before, after] = await Promise.all([
    fetchPlanPotentialAt(context.db, account.userId, context.now),
    fetchPlanPotentialAt(context.db, account.userId, patch.appliedAt),
  ]);

  const blocks = PATCH_CYCLES.flatMap(([cycle, label]) => {
    const rows = crystalPatchLines(cycle, label, patch, before, after);
    return rows === null ? [] : [rows];
  });

  if (blocks.length === 0) {
    return {
      reply: block(title, [
        "바뀌는 주기에 켜 둔 계획이 없어요.",
        "캐릭별 보스 관리에서 계획을 켜면 여기에 뜹니다.",
      ]),
      tag: "결정패치:계획없음",
      userId: account.userId,
    };
  }

  /*
    묶음 사이는 **빈 줄 하나**. `!결정석` 이 주간/월간을 가르는 방식과 같다 — 구분선을
    또 넣으면 세 줄짜리 묶음 둘에 테두리가 세 개가 된다.
  */
  return {
    reply: block(
      title,
      blocks.flatMap((rows, index) => (index === 0 ? [...rows] : ["", ...rows])),
    ),
    tag: "결정패치",
    userId: account.userId,
  };
}

/** 라우트가 원문 메시지를 넘기면 파싱까지 여기서 끝낸다. `!` 가 아니면 `null`. */
export function parseIncoming(message: string): ParsedCommand | null {
  return parseCommand(message);
}
