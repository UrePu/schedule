import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 명령 감사 로그 = **리플레이 방지 + 레이트리밋 + 도배 방지**의 단일 근거
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `bot_command_log` 는 감사용으로 만들어졌지만 `(channel_id, nonce)` 유니크 제약을
 * 갖고 있어 **리플레이 방지 테이블 역할을 그대로 한다.** 별도 캐시를 두지 않는 이유:
 * 서버 인스턴스가 여러 개면 프로세스 메모리 캐시는 방어가 되지 않는다. DB 유니크는
 * 인스턴스 수와 무관하게 정확하다.
 *
 * ★ **삽입이 곧 획득(claim)이다.** 명령을 처리하기 **전에** 넣는다. 뒤에 넣으면 같은
 *   nonce 두 개가 동시에 들어와 둘 다 처리된 뒤에야 하나가 거절된다.
 *
 * ⚠️ 프라이버시(§R5): **`!` 로 시작하는 명령 원문만** 저장한다. 컬럼 CHECK 도 그렇게
 *    걸려 있다(`command like '!%'`). 일반 대화는 서버에 도달하지도 않는다.
 *
 * ⚠️ **답장 원문은 저장하지 않는다.** `result` 에는 `ok:<명령>#<digest8>` 만 남긴다.
 *    digest 는 "직전과 같은 답장인가"만 판정하면 되므로 8자면 충분하고, 방에서 오간
 *    내용이 우리 DB 에 쌓이지 않는다.
 */

import { createHash } from "node:crypto";

import { ApiError } from "@/features/auth/server/http";
import type { AdminDb } from "@/lib/supabase/admin-db";

import { ignoreError, unwrap } from "./shared";

/** 레이트리밋 창(초). */
const RATE_WINDOW_SECONDS = 60;

/** 방 하나가 1분에 칠 수 있는 명령 수. */
const ROOM_LIMIT_PER_MINUTE = 20;

/** 한 사람이 1분에 칠 수 있는 명령 수. */
const SENDER_LIMIT_PER_MINUTE = 6;

/** Postgres 유니크 위반. */
const UNIQUE_VIOLATION = "23505";

export interface ClaimedCommand {
  readonly logId: string;
  /** 직전 답장의 digest. 같은 문자열을 연속으로 내보내지 않기 위한 것(도배 방지). */
  readonly previousReplyDigest: string | null;
}

/** 답장 문자열 → 8자 digest. 저장되는 것은 이 값뿐이다. */
export function replyDigest(reply: string): string {
  return createHash("sha256").update(reply, "utf8").digest("hex").slice(0, 8);
}

/**
 * nonce 를 획득하고, 같은 창의 최근 명령으로 레이트리밋을 판정한다.
 *
 * 실패는 던진다:
 *   - 같은 nonce → `bot_replay` (409)
 *   - 방/발신자 한도 초과 → `bot_rate_limited` (429)
 *
 * ★ 한도 초과여도 **행은 남는다.** 남기지 않으면 초과분이 카운트에서 빠져 다음 요청이
 *   다시 통과하고, 한도가 사실상 두 배가 된다.
 */
export async function claimCommand(
  db: AdminDb,
  input: {
    readonly channelId: string;
    readonly nonce: string;
    readonly senderId: string;
    readonly command: string;
  },
  now: Date,
): Promise<ClaimedCommand> {
  const inserted = await db
    .from("bot_command_log")
    .insert({
      channel_id: input.channelId,
      nonce: input.nonce,
      sender_id: input.senderId,
      command: input.command,
    })
    .select("id")
    .maybeSingle();

  if (inserted.error !== null) {
    if (inserted.error.code === UNIQUE_VIOLATION) throw ApiError.botReplay();
    console.error(`[bot] 명령 로그 적재 실패: ${inserted.error.message}`);
    throw ApiError.internal();
  }
  if (inserted.data === null) {
    console.error("[bot] 명령 로그 적재가 행을 돌려주지 않았습니다.");
    throw ApiError.internal();
  }
  const logId = inserted.data.id;

  const since = new Date(now.getTime() - RATE_WINDOW_SECONDS * 1000).toISOString();
  const recent = unwrap(
    await db
      .from("bot_command_log")
      .select("id,sender_id,result,created_at")
      .eq("channel_id", input.channelId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(ROOM_LIMIT_PER_MINUTE * 3),
    "최근 명령 조회",
  );

  const senderCount = recent.filter((row) => row.sender_id === input.senderId).length;
  if (recent.length > ROOM_LIMIT_PER_MINUTE || senderCount > SENDER_LIMIT_PER_MINUTE) {
    throw ApiError.botRateLimited();
  }

  /*
    직전 답장 digest — 방금 넣은 우리 행(아직 result 가 null)은 건너뛴다.
    `result` 는 `ok:<명령>#<digest8>` 또는 `err:<kind>` 형태다.
  */
  const previous = recent.find(
    (row) => row.id !== logId && typeof row.result === "string" && row.result.includes("#"),
  );
  const previousReplyDigest =
    previous?.result?.split("#")[1] ?? null;

  return { logId, previousReplyDigest };
}

/** 처리 결과를 같은 행에 되쓴다. 실패해도 요청을 깨지 않는다(감사 목적이다). */
export async function finalizeCommandLog(
  db: AdminDb,
  logId: string,
  patch: {
    readonly result: string;
    readonly statusCode: number;
    readonly durationMs: number;
    readonly userId?: string | null;
  },
): Promise<void> {
  ignoreError(
    await db
      .from("bot_command_log")
      .update({
        result: patch.result,
        status_code: patch.statusCode,
        duration_ms: Math.max(0, Math.round(patch.durationMs)),
        user_id: patch.userId ?? null,
      })
      .eq("id", logId),
    "명령 로그 마감",
  );
}
