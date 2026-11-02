import { after } from "next/server";
import { z } from "zod";

import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import { commandFailureReply } from "@/features/bot/lib/command-failure";
import type { ParsedCommand } from "@/features/bot/lib/command-parse";
import {
  UNEXECUTED_RESULT,
  claimCommand,
  finalizeCommandLog,
  replyDigest,
  type ClaimedCommand,
} from "@/features/bot/server/command-log";
import {
  isAnsweredCommand,
  parseIncoming,
  runCommand,
} from "@/features/bot/server/commands";
import {
  canonicalize,
  sha256Hex,
  signatureBase,
  verifyRunnerSignature,
} from "@/features/bot/server/signature";
import {
  LONG_REPLY_BUDGET,
  differentiate,
  toPlaintext,
} from "@/features/bot/lib/plaintext";
import { getAdminDb, type AdminDb } from "@/lib/supabase/admin-db";
import { formatKst } from "@/lib/time/week";
import { DEFAULT_BOT_PLATFORM, type BotCommandResponse } from "@/features/bot/types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST /api/bot/command` — **요구사항의 90%가 이 하나다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 요청  `{ platform?, sender:{id,name}, message, timestamp, nonce, signature }`
 * 응답  `{ reply: string | null, extra?: string[] }`
 *
 * 클라이언트는 돌려받은 `reply` 를 **그대로 방에 출력한다.** 렌더링·포맷·분기 판단이
 * 클라이언트에 하나도 없다는 것이 이 계약의 요점이고, 그래서 클라이언트를 갈아 끼워도
 * 서버가 0줄 바뀌지 않는다(CLAUDE.md §2.2 "runner-agnostic").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ 2026-09-28: `room` 이 사라지고 인증이 **설치 토큰 하나**가 됐다 ★★
 * ─────────────────────────────────────────────────────────────────────────────
 * 방을 식별할 방법이 원리적으로 없다는 것이 실측으로 확정됐다(`features/bot/types.ts`
 * 머리말). 그래서 방별 시크릿·페어링·회전이 전부 내려가고, 서명 키는 환경변수
 * `BOT_RUNNER_TOKEN` 하나가 됐다(`server/signature.ts`).
 *
 * ⚠️ **서명 자체는 그대로 남는다.** 토큰만 확인하면 요청 한 번을 캡처한 쪽이 그것을
 *    영구히 재생할 수 있다. 서명 + 타임스탬프 창(±300초) + nonce 1회성이 그 창을
 *    "300초 안에 한 번"으로 줄이고, 그 한 번도 아래 nonce 획득이 막는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 처리 순서 — **이 순서가 곧 방어선이다**
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. 본문 형식        → 400
 *   2. 타임스탬프·서명  → 401
 *   3. `!` 접두어 확인  → 아니면 **기록 없이** 200 `{reply:null}` (프라이버시 §R5)
 *   4. nonce 획득       → 409 (같은 nonce 재사용 = 리플레이)
 *   5. 레이트리밋       → 429 (발신자 6/분)
 *   6. 명령 처리 → 7. 로그 마감 → 200
 *   (4~7 은 POST 시작 기준 10초 상한과 경주한다 — `COMMAND_REPLY_LIMIT_MS`.)
 *
 * ★ **명령 응답은 재시도 큐에 넣지 않는다.** 사람이 명령을 친 맥락은 수십 초면 사라진다.
 *   실패하면 그냥 포기하는 것이 맞고, 그래서 이 경로에는 아웃박스가 끼지 않는다.
 *
 * ⚠️ 이 파일은 **시크릿·코드 원문을 절대 로그에 남기지 않는다.**
 *    `features/auth/server/http.ts` 가 선언한 "마지막 관문" 성질을 봇 경로에도 그대로 적용한다.
 */

/**
 * 응답 뒤에 이어 도는 갱신(`features/bot/server/refresh-on-command.ts`)이 쓰는 수명.
 *
 * `after()` 는 라우트의 최대 실행 시간까지만 산다(`next/dist/docs/.../after.md`). 플랫폼 기본값에
 * 맡기면 넥슨이 느린 날 중간에 잘리고, 그 뒤 캐릭터는 다음 크론까지 그대로다. 크론 라우트와
 * 같은 값이다 — 갱신의 새 출발 한도(`START_BUDGET_MS` 40초)가 이 안쪽에 있다.
 */
export const maxDuration = 60;

/**
 * 서명을 통과한 명령이 답을 내야 하는 상한 — `POST` 시작 기준 10초.
 *
 * 발주 지시(2026-11-02): *"DB가 멈춰서 이슈가 생기면. 오류생겼다고 답장을 대신해"*.
 * 런너는 12초(`COMMAND_TIMEOUT`)를 넘기면 답을 버리고 방에 아무 말도 하지 않는다. 그래서 12초에서
 * 네트워크 · 함수 부팅 몫 2초를 뺀 값이고, 넘기면 그 시점에 오류 답장을 보낸다(`commandFailureReply`).
 *
 * ★ 평소 침묵하는 **미인식 입력은 오류 답장도 없다**(`failureReplyFor`). 장애 때 방 전체 잡담에
 *   답하는 것이 더 큰 사고다.
 * ★ **쓰는 중인 것은 끊지 않고, 아직 안 쓴 것은 쓰지 않는다.** 핸들러는 `after()` 로 끝까지 돌게 두고
 *   답장만 먼저 보낸다. 늦게 끝난 결과는 로그에만 남는다. 다만 오류 답장이 나간 뒤에는 시작 전
 *   핸들러를 시작하지 않고, 쓰기 함수도 부르지 않는다(`CommandContext.replyAbandoned`).
 *   사람은 오류를 보고 다시 치는데, 뒤늦게 쓰면 두 번 기록되고 `!드랍 취소` 는 정상 기록까지 지운다.
 * ⚠️ **뒤늦게 기록될 수 있는 경우가 하나 남는다 — 쓰기 문장 자체가 멈춘 경우다.** 그래서 문구가 "처리됐을 수도
 *    있으니 확인"이다. 여러 문장을 쓰는 명령(`createPartyRuns`)은 첫 문장 직전까지만 막아 준다.
 *
 * ⚠️ 막아 주는 것은 **서버 안에서 멈춘 경우뿐**이다. 함수 부팅은 이 시계가 돌기 전이고, 서버가 응답을
 *    못 하면(부팅 · 네트워크 · 플랫폼) 런너가 12초 뒤 조용히 포기한다. 그쪽 침묵은 런너에서만 없앨 수 있다.
 */
const COMMAND_REPLY_LIMIT_MS = 10_000;

/**
 * 답이 준비된 뒤 로그 마감을 기다리는 시간. 넘기면 답장을 먼저 보내고 로그는 `after()` 로 넘긴다.
 * 로그가 멈췄다고 다 된 명령에 오류 답장을 하면 안 된다. **상한까지 남은 시간이 더 짧으면 그만큼만**
 * 기다린다 — 그래야 응답이 상한을 넘지 않는다.
 */
const LOG_CLOSE_WAIT_MS = 1_000;

const senderSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().max(100).default(""),
});

const bodySchema = z.object({
  /*
    ★ **선택 필드이고 기본값이 있다.** 신원의 유일성이 `(platform, sender.id)` 라 값 자체는
      반드시 있어야 하지만, 옛 클라이언트가 안 보낸다고 거절할 이유는 없다.
    ⚠️ 서명 대상에는 **보낸 그대로** 들어간다(zod 기본값이 아니라 원본 객체로 서명을
      계산하므로). 즉 보내는 쪽이 한 번 정하면 계속 같게 보내야 한다.
  */
  platform: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_-]{1,29}$/u, "platform 형식이 올바르지 않습니다.")
    .optional(),
  sender: senderSchema,
  message: z.string().min(1).max(1000),
  timestamp: z.number().int(),
  nonce: z.string().trim().min(8).max(200),
  signature: z.string().trim().min(4).max(300),
});

/**
 * 사용자가 브라우저로 열 수 있는 **공개 주소**.
 *
 * `request.url` 은 프록시 뒤에서 내부 호스트일 수 있으므로 `x-forwarded-*` 를 먼저 본다.
 * 환경변수를 두지 않는 이유는 `CommandContext.siteOrigin` 주석에 있다 — 배포 주소가 바뀌면
 * 조용히 낡는다.
 */
function publicOrigin(request: Request, url: URL): string {
  const host = request.headers.get("x-forwarded-host") ?? url.host;
  const proto = request.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "");
  return `${proto}://${host}`;
}

/*
  ★ ═══════════════════════════════════════════════════════════════════════════
    **거절은 반드시 한 줄을 남긴다** (2026-10-13)
    ═══════════════════════════════════════════════════════════════════════════
  `handleRouteError` 는 `ApiError` 를 그대로 응답으로 바꾸고 **아무것도 기록하지
  않는다**. 그래서 400·401 은 DB 에도 플랫폼 로그에도 흔적이 없었다 — 런너는 침묵이
  정상 경로라(401 이면 방에 한 마디도 안 한다) 사용자에게는 "봇이 죽었다"로 보이고,
  우리 쪽에는 **그 요청이 온 적이 있다는 증거 자체가 없다.**

  2026-10-12 신고를 조사할 때 이것이 그대로 함정이 됐다: `bot_command_log` 가 전부
  200 이라 "서버는 아무것도 막지 않았다"로 읽혔는데, 사실은 **막은 것이 기록될 자리가
  없었다**. 400·401 은 서명 검증 **전**이라 DB 에 쓸 수 없다(아무나 보낸 요청으로
  행을 만들면 그 자체가 쓰기 증폭 경로다). 그래서 플랫폼 로그로 보낸다.
  409·429 는 서명을 통과한 뒤이므로 `server/command-log.ts` 가 DB 쪽에서 맡는다.

  ⚠️ 남기는 것은 **상태·종류·어디까지 갔는지**뿐이다. 서명값·명령 원문·닉네임은 남기지
     않는다(이 파일 머리말의 규칙 그대로). nonce 앞 8자는 DB 행을 찾는 열쇠라 남긴다.
*/
const REJECT_LOG_PREFIX = "[api/bot/command#POST] 거절";

/** 명령 처리 결과. 로그 쓰기와 응답은 이것을 받은 쪽이 한다. */
interface HandledCommand {
  readonly logId: string;
  /** `ok:<명령>` · `err:<kind>` — digest 없는 앞부분. */
  readonly result: string;
  readonly statusCode: number;
  readonly userId: string | null;
  readonly reply: string | null;
  readonly extra: readonly string[] | undefined;
}

/** 경주 중에 라우트와 핸들러가 함께 보는 상태. */
interface CommandProgress {
  /** 답장 때 직전 digest 를 쓰려고 들고 있는다. 아직 못 얻었으면 `null`. */
  claim: ClaimedCommand | null;
  /** 상한을 넘겨 오류 답장을 이미 보냈다. 이후 시작하는 핸들러는 없다. */
  abandoned: boolean;
}

/**
 * 실패할 때 방에 보낼 문구. 평소 답이 없는 미인식 입력은 `null` — 평소와 같은 침묵이다.
 * 기준은 `features/bot/lib/command-failure.ts` 머리말.
 */
function failureReplyFor(command: ParsedCommand): string | null {
  return isAnsweredCommand(command.name) ? commandFailureReply(command.name) : null;
}

/** nonce 획득 → 명령 실행 → 답장 조립. 서명을 통과한 뒤에만 부른다. 409 · 429 는 던진다. */
async function handleSignedCommand(
  input: {
    readonly db: AdminDb;
    readonly platform: string;
    readonly sender: { readonly id: string; readonly name: string };
    readonly nonce: string;
    readonly command: ParsedCommand;
    readonly now: Date;
    readonly siteOrigin: string;
  },
  progress: CommandProgress,
): Promise<HandledCommand> {
  const { db, platform, sender, nonce, command, now, siteOrigin } = input;

  const claim = await claimCommand(
    db,
    {
      nonce,
      senderId: sender.id,
      command: command.raw.slice(0, 500),
    },
    now,
  );
  progress.claim = claim;

  if (progress.abandoned) {
    return {
      logId: claim.logId,
      result: UNEXECUTED_RESULT,
      statusCode: 504,
      userId: null,
      reply: null,
      extra: undefined,
    };
  }

  /*
    ★ ═══════════════════════════════════════════════════════════════════════
      **명령 처리 실패는 HTTP 오류가 아니라 답장으로 나간다.**
      ═══════════════════════════════════════════════════════════════════════
      클라이언트는 `reply` 문자열만 방에 출력한다. 그러니 4xx 를 돌려주면 사용자
      눈에는 **아무 일도 일어나지 않은 것**으로 보인다. 실제로 검증 중에
      `!클리어` 가 "이 일정에 데려갈 캐릭터를 먼저 지정해 주세요" 를 400 으로 냈고,
      방에서는 침묵으로 나타났다 — 사용자가 고칠 수 있는 문제인데 고칠 방법을
      말해 주지 못한 것이다.

      그래서 `runCommand` 안에서 난 실패는 200 + 평문 안내로 접는다.
        - 4xx(우리 문구가 이미 사용자용 한국어다) → 그 문구를 그대로 안내한다.
        - 5xx(내부 사정)             → **내부 정보 없이** 오류 답장만 낸다.
      진짜 상태 코드와 종류는 `bot_command_log` 에 남으므로 진단은 그대로 가능하다.

      ⚠️ 서명·재생·레이트리밋 실패는 여기 오지 않는다. 그것들은 **명령을 실행하기
         전에** 걸러지고, 그때는 방에 아무 말도 하지 않는 것이 맞다(경고 문구조차
         도배가 되고, 두드리는 쪽에는 응답 자체가 정보다).

      ⚠️ **`!연결` 의 선점 거부는 다르다.** 그것은 여기까지 와서 200 + 안내 문구로
         나간다 — 코드를 찍어 보는 쪽이 아니라 정상 코드를 쓴 사람이고, 할 수 있는
         일(`!연결해제`)이 있기 때문이다(`server/commands.ts` handleLink).
  */
  let reply: string | null;
  let extra: readonly string[] | undefined;
  /*
    사람이 길이를 직접 요구한 답장은 **긴 예산**을 쓴다(`!결정석 20`).
    기본값은 꺼진 상태다 — 오류 경로까지 길어지면 방이 시끄러워진다.
  */
  let long = false;
  let result: string;
  let statusCode = 200;
  let userId: string | null = null;

  try {
    const outcome = await runCommand(
      {
        db,
        platform,
        senderId: sender.id,
        senderName: sender.name === "" ? "이름없음" : sender.name,
        now,
        siteOrigin,
        replyAbandoned: () => progress.abandoned,
      },
      command,
    );
    reply = outcome.reply;
    // 이어지는 말풍선도 **같은 평문 규칙**을 통과시킨다 — 두 번째 풍선만 마크다운이
    // 살아 있으면 방에 별표가 그대로 찍힌다.
    extra = outcome.extra?.map((part) => toPlaintext(part));
    long = outcome.long === true;
    result = `ok:${outcome.tag}`;
    userId = outcome.userId;
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) {
      reply = `⚠️ ${error.message}`;
      result = `err:${error.kind}`;
      statusCode = error.status;
    } else {
      console.error(
        "[api/bot/command#POST] 명령 처리 실패:",
        error instanceof Error ? `${error.name}: ${error.message}` : error,
      );
      reply = commandFailureText(command, claim, now);
      result = `err:${error instanceof ApiError ? error.kind : "internal"}`;
      statusCode = error instanceof ApiError ? error.status : 500;
    }
  }

  const finalReply =
    reply === null
      ? null
      : differentiate(
          toPlaintext(reply, long ? LONG_REPLY_BUDGET : undefined),
          claim.previousReplyDigest,
          replyDigest,
          now,
          /*
            ⚠️ **같은 예산을 넘겨야 한다**(2026-09-07). 도배 방지 접미사를 붙이는 쪽도
               평문 규칙을 다시 돌리므로, 여기서 예산을 빼먹으면 바로 윗줄에서 늘려 준
               것이 그 안에서 도로 잘린다 — 잘리는 자리가 하필 목록 맨 끝 꼬리말이라
               "왜 어떤 때만 `…외 N건` 이 사라지지?" 로 보였다.
          */
          long ? LONG_REPLY_BUDGET : undefined,
        );

  return { logId: claim.logId, result, statusCode, userId, reply: finalReply, extra };
}

/** 로그 마감. **던지지 않는다** — 기록이 실패했다고 답장이 막히면 안 된다. */
async function closeCommandLog(
  db: AdminDb,
  logId: string,
  patch: Parameters<typeof finalizeCommandLog>[2],
): Promise<void> {
  try {
    await finalizeCommandLog(db, logId, patch);
  } catch (error) {
    console.warn(
      "[api/bot/command#POST] 로그 마감 실패:",
      error instanceof Error ? error.message : error,
    );
  }
}

/** `ms` 안에 끝나면 그 결과를, 아니면 `{ timedOut: true }` 를 준다. `work` 를 끊지는 않는다. */
function settleWithin<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ readonly timedOut: true } | { readonly timedOut: false; readonly value: T }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({ timedOut: true });
    }, Math.max(ms, 0));
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve({ timedOut: false, value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** 응답이 나간 뒤에도 `work` 가 끝까지 돌게 한다. 등록에 실패해도 답장은 나간다. */
function keepAlive(work: Promise<unknown>): void {
  try {
    after(() => work);
  } catch (error) {
    console.warn(
      "[api/bot/command#POST] after 등록 실패:",
      error instanceof Error ? error.message : error,
    );
  }
}

/**
 * 오류 답장. **언제나 200** 이다 — 런너는 200 일 때만 `reply` 를 방에 찍고 그 밖에는 침묵한다
 * (`scripts/OpenchatbotR.js` `postCommand`).
 *
 * ★ **직전 답장을 모르면 언제나 시각을 붙인다.** 글자까지 같은 답장은 카톡 도배 방지에 먹혀 침묵이 된다
 *   (`command-log.ts` `RECENT_SCAN_ROWS` 실측). 장애 중 접수부터 멈추면 digest 를 못 읽고, 접수가 돼도 앞
 *   명령이 마감 전이면 digest 가 더 오래된 답장의 것이다. 사람은 그 사이 몇 초 간격으로 다시 치므로
 *   `differentiate` 의 분 단위로는 겹쳐서 초까지 적는다.
 */
function commandFailureText(
  command: ParsedCommand,
  claim: ClaimedCommand | null,
  now: Date,
): string | null {
  const text = failureReplyFor(command);
  if (text === null) return null;
  if (claim === null || !claim.previousReplyKnown) {
    return toPlaintext(`${text}\n· ${formatKst(now, "HH:mm:ss")}`);
  }
  return differentiate(
    toPlaintext(text),
    claim.previousReplyDigest,
    replyDigest,
    now,
  );
}

/** 응답도 캐시하지 않는다(`jsonOk` 가 `no-store` 를 건다). */
export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const now = new Date();
  /** 거절 로그에 실을 "어디까지 갔는지". 단계마다 덮어쓴다. */
  let stage = "본문 읽기";

  try {
    /*
      ⚠️ zod 결과가 아니라 **원본 객체**로 서명을 계산한다. zod 는 모르는 키를 떨어뜨리므로,
         클라이언트가 필드를 하나 더 실었을 때 서명이 어긋난다. 서명은 클라이언트가 보낸
         바이트의 의미에 걸려야 한다.
    */
    let raw: unknown;
    try {
      raw = (await request.json()) as unknown;
    } catch {
      throw ApiError.badRequest("요청 본문이 JSON 이 아닙니다.");
    }

    stage = "본문 형식";
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) throw ApiError.badRequest("요청 형식이 올바르지 않습니다.");
    const body = parsed.data;
    stage = `서명 검증 nonce=${body.nonce.slice(0, 8)}…`;

    const signedPayload = { ...(raw as Record<string, unknown>) };
    delete signedPayload.signature;

    const db = getAdminDb();

    const url = new URL(request.url);
    const base = signatureBase({
      timestamp: body.timestamp,
      nonce: body.nonce,
      method: "POST",
      path: url.pathname,
      bodyHash: sha256Hex(canonicalize(signedPayload)),
    });
    if (!verifyRunnerSignature(base, body.signature, body.timestamp, now)) {
      throw ApiError.botUnauthorized(401);
    }

    const platform = body.platform ?? DEFAULT_BOT_PLATFORM;

    const command = parseIncoming(body.message);
    if (command === null) {
      // 접두어 없는 메시지는 **아무것도 남기지 않고** 침묵한다.
      return jsonOk<BotCommandResponse>({ reply: null });
    }

    stage = `nonce 획득 nonce=${body.nonce.slice(0, 8)}…`;

    /*
      ★ ═══════════════════════════════════════════════════════════════════════
        **여기부터 DB 를 만지는 일 전부가 상한과 경주한다**
        ═══════════════════════════════════════════════════════════════════════
      서명을 통과한 요청에만 오류 답장을 준다. 위쪽 400 · 401 에는 내용을 바꾸지 않는다.
    */
    const progress: CommandProgress = { claim: null, abandoned: false };
    const handling = handleSignedCommand(
      {
        db,
        platform,
        sender: body.sender,
        nonce: body.nonce,
        command,
        now,
        siteOrigin: publicOrigin(request, url),
      },
      progress,
    );

    let settled: Awaited<ReturnType<typeof settleWithin<HandledCommand>>>;
    try {
      settled = await settleWithin(
        handling,
        startedAt + COMMAND_REPLY_LIMIT_MS - Date.now(),
      );
    } catch (error) {
      // 409 · 429 는 거절이지 오류가 아니다. 지금까지처럼 침묵한다(아래 바깥 catch).
      if (error instanceof ApiError && error.status < 500) throw error;
      console.error(
        "[api/bot/command#POST] 명령 접수 실패:",
        error instanceof Error ? `${error.name}: ${error.message}` : error,
      );
      return jsonOk<BotCommandResponse>({
        reply: commandFailureText(command, progress.claim, now),
      });
    }

    if (settled.timedOut) {
      progress.abandoned = true;
      const failureText = commandFailureText(command, progress.claim, now);
      /*
        DB 에 못 쓰는 상황일 수 있으므로 플랫폼 로그에 먼저 남긴다. 명령 원문·닉네임은 남기지 않는다.
      */
      console.warn(
        `[api/bot/command#POST] 상한 ${String(COMMAND_REPLY_LIMIT_MS)}ms 초과 nonce=${body.nonce.slice(0, 8)}… ` +
          `(접수 ${progress.claim === null ? "전" : "후"})`,
      );
      /*
        ★ 행은 핸들러가 끝날 때 **한 번만** 쓴다. `err:bot_timeout(<실제 결과>)#<보낸 오류 답장 digest>` ·
          504 — 쓰기 명령이 실제로 처리됐는지를 여기서 읽는다. digest 가 보낸 답장의 것이어야 다음
          명령의 도배 방지가 맞는다. 보낸 답장이 없으면(미인식) digest 도 없다. 함수 수명(`maxDuration`)
          안에 안 끝나면 행은 비어 있고 위 줄만 남는다.
      */
      const sentDigest = failureText === null ? "" : `#${replyDigest(failureText)}`;
      keepAlive(
        handling.then(
          (handled) =>
            closeCommandLog(db, handled.logId, {
              result: `err:bot_timeout(${handled.result})${sentDigest}`,
              statusCode: 504,
              durationMs: Date.now() - startedAt,
              userId: handled.userId,
            }),
          (error: unknown) => {
            console.warn(
              "[api/bot/command#POST] 상한 뒤 처리 실패:",
              error instanceof Error ? `${error.name}: ${error.message}` : error,
            );
          },
        ),
      );
      return jsonOk<BotCommandResponse>({ reply: failureText });
    }

    const handled = settled.value;
    const logClosing = closeCommandLog(db, handled.logId, {
      result:
        handled.reply === null
          ? handled.result
          : `${handled.result}#${replyDigest(handled.reply)}`,
      statusCode: handled.statusCode,
      durationMs: Date.now() - startedAt,
      userId: handled.userId,
    });
    const logState = await settleWithin(
      logClosing,
      Math.min(LOG_CLOSE_WAIT_MS, startedAt + COMMAND_REPLY_LIMIT_MS - Date.now()),
    );
    if (logState.timedOut) keepAlive(logClosing);

    /*
      `extra` 는 **`reply` 가 살아 있을 때만** 내보낸다. 본문 없이 이어지는 풍선만 가면
      클라이언트가 맥락 없는 조각을 방에 뿌리게 된다.
    */
    return jsonOk<BotCommandResponse>({
      reply: handled.reply,
      ...(handled.reply !== null && handled.extra !== undefined && handled.extra.length > 0
        ? { extra: handled.extra }
        : {}),
    });
  } catch (error) {
    /*
      5xx 는 `handleRouteError` 가 이미 자세히 남긴다. 여기서 보태는 것은 **조용히
      거절되던 4xx** 뿐이다(위 ★ 블록).
    */
    if (error instanceof ApiError && error.status < 500) {
      console.warn(
        `${REJECT_LOG_PREFIX} ${String(error.status)} ${error.kind} (${stage}, ${String(
          Date.now() - startedAt,
        )}ms)`,
      );
    }
    return handleRouteError(error, "api/bot/command#POST");
  }
}
