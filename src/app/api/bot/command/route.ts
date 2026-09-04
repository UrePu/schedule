import { z } from "zod";

import { ApiError, handleRouteError, jsonOk } from "@/features/auth/server/http";
import {
  assertChannelUsable,
  loadChannelByRoom,
  verifyChannelSignature,
} from "@/features/bot/server/channel";
import {
  claimCommand,
  finalizeCommandLog,
  replyDigest,
} from "@/features/bot/server/command-log";
import { parseIncoming, runCommand } from "@/features/bot/server/commands";
import { canonicalize, sha256Hex, signatureBase } from "@/features/bot/server/signature";
import {
  LONG_REPLY_BUDGET,
  differentiate,
  genericFailureReply,
  toPlaintext,
} from "@/features/bot/lib/plaintext";
import { getAdminDb } from "@/lib/supabase/admin-db";
import type { BotCommandResponse } from "@/features/bot/types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST /api/bot/command` — **요구사항의 90%가 이 하나다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 요청  `{ room, sender:{id,name}, message, timestamp, nonce, signature }`
 * 응답  `{ reply: string | null, extra?: string[] }`
 *
 * 클라이언트는 돌려받은 `reply` 를 **그대로 방에 출력한다.** 렌더링·포맷·분기 판단이
 * 클라이언트에 하나도 없다는 것이 이 계약의 요점이고, 그래서 클라이언트를 갈아 끼워도
 * 서버가 0줄 바뀌지 않는다(CLAUDE.md §2.2 "runner-agnostic").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 처리 순서 — **이 순서가 곧 방어선이다**
 * ─────────────────────────────────────────────────────────────────────────────
 *   1. 본문 형식        → 400
 *   2. 채널 조회        → 404 (없는 방과 서명 실패를 같은 `kind` 로 접는다)
 *   3. 상태/정지 확인   → 403
 *   4. 타임스탬프·서명  → 401 (+ 실패 카운트, 임계 초과 시 채널 임시 정지)
 *   5. `!` 접두어 확인  → 아니면 **기록 없이** 200 `{reply:null}` (프라이버시 §R5)
 *   6. nonce 획득       → 409 (같은 nonce 재사용 = 리플레이)
 *   7. 레이트리밋       → 429 (방 20/분 · 발신자 6/분)
 *   8. 명령 처리 → 9. 로그 마감 → 200
 *
 * ★ **명령 응답은 재시도 큐에 넣지 않는다.** 사람이 명령을 친 맥락은 수십 초면 사라진다.
 *   실패하면 그냥 포기하는 것이 맞고, 그래서 이 경로에는 아웃박스가 끼지 않는다.
 *
 * ⚠️ 이 파일은 **시크릿·코드 원문을 절대 로그에 남기지 않는다.**
 *    `features/auth/server/http.ts` 가 선언한 "마지막 관문" 성질을 봇 경로에도 그대로 적용한다.
 */

const senderSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().max(100).default(""),
});

const bodySchema = z.object({
  room: z.string().trim().min(1).max(64),
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

/** 응답도 캐시하지 않는다(`jsonOk` 가 `no-store` 를 건다). */
export async function POST(request: Request): Promise<Response> {
  const startedAt = Date.now();
  const now = new Date();

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

    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) throw ApiError.badRequest("요청 형식이 올바르지 않습니다.");
    const body = parsed.data;

    const signedPayload = { ...(raw as Record<string, unknown>) };
    delete signedPayload.signature;

    const db = getAdminDb();
    const channel = await loadChannelByRoom(db, body.room);
    if (channel === null) throw ApiError.botUnauthorized(404);
    assertChannelUsable(channel, now);

    const url = new URL(request.url);
    const base = signatureBase({
      timestamp: body.timestamp,
      nonce: body.nonce,
      method: "POST",
      path: url.pathname,
      bodyHash: sha256Hex(canonicalize(signedPayload)),
    });
    await verifyChannelSignature(db, channel, base, body.signature, body.timestamp, now);

    const command = parseIncoming(body.message);
    if (command === null) {
      // 접두어 없는 메시지는 **아무것도 남기지 않고** 침묵한다.
      return jsonOk<BotCommandResponse>({ reply: null });
    }

    const claim = await claimCommand(
      db,
      {
        channelId: channel.id,
        nonce: body.nonce,
        senderId: body.sender.id,
        command: command.raw.slice(0, 500),
      },
      now,
    );

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
          - 5xx(내부 사정)             → **내부 정보 없이** 일반 문구만 낸다.
        진짜 상태 코드와 종류는 `bot_command_log` 에 남으므로 진단은 그대로 가능하다.

        ⚠️ 서명·재생·레이트리밋 실패는 여기 오지 않는다. 그것들은 **명령을 실행하기
           전에** 걸러지고, 그때는 방에 아무 말도 하지 않는 것이 맞다(경고 문구조차
           도배가 되고, 두드리는 쪽에는 응답 자체가 정보다).
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
          channel,
          senderId: body.sender.id,
          senderName: body.sender.name === "" ? "이름없음" : body.sender.name,
          now,
          siteOrigin: publicOrigin(request, url),
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
        reply = genericFailureReply();
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
          );

    await finalizeCommandLog(db, claim.logId, {
      result:
        finalReply === null ? result : `${result}#${replyDigest(finalReply)}`,
      statusCode,
      durationMs: Date.now() - startedAt,
      userId,
    });

    /*
      `extra` 는 **`reply` 가 살아 있을 때만** 내보낸다. 본문 없이 이어지는 풍선만 가면
      클라이언트가 맥락 없는 조각을 방에 뿌리게 된다.
    */
    return jsonOk<BotCommandResponse>({
      reply: finalReply,
      ...(finalReply !== null && extra !== undefined && extra.length > 0
        ? { extra }
        : {}),
    });
  } catch (error) {
    return handleRouteError(error, "api/bot/command#POST");
  }
}
