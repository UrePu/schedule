import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
  readJsonBody,
} from "@/features/auth/server/http";
import { generateRoomId } from "@/features/bot/server/channel";
import {
  findPairCode,
  markPairCodeConsumed,
  normalizeCode,
} from "@/features/bot/server/link";
import { deriveChannelSecret, hashSecret } from "@/features/bot/server/signature";
import { unwrap } from "@/features/bot/server/shared";
import { getAdminDb } from "@/lib/supabase/admin-db";
import type { BotPairResponse } from "@/features/bot/types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `POST /api/bot/pair` — 방 최초 연결
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * **부트스트랩 구간이라 여기만 무서명이다.** 아직 시크릿이 없으니 서명할 수가 없다.
 * 그래서 방어를 따로 건다:
 *   - 6자리 코드(32글자 알파벳 ≈ 10.7억) · TTL 10분 · **1회용**
 *   - 코드는 웹에서 **로그인한 사람만** 발급한다 → 방의 주인이 누구인지가 정해진다
 *   - IP 당 분당 5회 (아래 주석 참고)
 *
 * ⚠️ **원문 시크릿은 이 응답이 유일한 출구다.** 서버는 `sha256(secret)` 만 보관하며,
 *    원문은 요청 시각에 마스터키에서 다시 파생해 만든다(`server/signature.ts` 머리말).
 *    로그에도 남기지 않는다.
 *
 * ⚠️ 우리는 **서버만 제공한다.** 이 계약을 만족하는 클라이언트는 무엇이든 붙을 수 있고,
 *    이 저장소는 그런 클라이언트를 만들거나 배포하지 않는다.
 */

const bodySchema = z.object({
  code: z.string().trim().min(1).max(32),
  /** 로그·통계 전용. **분기 로직에 쓰지 않는다**(§3.6). */
  runner: z.string().trim().max(60).optional(),
  roomFingerprint: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/, "방 지문 형식이 올바르지 않습니다.")
    .optional(),
});

/** 폴링 권장 간격. 클라이언트가 이 값을 지키면 방당 부하가 예측 가능해진다. */
const POLL_INTERVAL_SEC = 30;

/*
  IP 레이트리밋 — **프로세스 내 최선 노력**이다.
  담을 테이블이 없고(이번 작업은 새 마이그레이션 금지) 인스턴스가 여러 개면 한도가 그만큼
  늘어난다. 진짜 방어는 위의 코드 공간·TTL·1회용이며, 이 맵은 한 대에서 코드를 연타로
  긁는 흔한 경우를 끊는 용도다.
*/
const PAIR_LIMIT = 5;
const PAIR_WINDOW_MS = 60_000;
const pairAttempts = new Map<string, { count: number; resetAt: number }>();

function tooManyPairAttempts(ip: string, now: Date): boolean {
  const entry = pairAttempts.get(ip);
  if (entry === undefined || entry.resetAt <= now.getTime()) {
    pairAttempts.set(ip, { count: 1, resetAt: now.getTime() + PAIR_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  return entry.count > PAIR_LIMIT;
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded !== null && forwarded !== "") {
    return (forwarded.split(",")[0] ?? "").trim() || "unknown";
  }
  return request.headers.get("x-real-ip") ?? "unknown";
}

export async function POST(request: Request): Promise<Response> {
  const now = new Date();
  try {
    if (tooManyPairAttempts(clientIp(request), now)) {
      throw ApiError.botRateLimited();
    }

    const body = await readJsonBody(request, bodySchema);
    const code = normalizeCode(body.code);
    // 형식 오류와 없는 코드를 같은 답으로 접는다 — 살아 있는 코드를 훑을 수 없게.
    if (code === null) throw ApiError.botUnauthorized(404);

    const db = getAdminDb();
    const pairCode = await findPairCode(db, code);
    if (pairCode === null) throw ApiError.botUnauthorized(404);

    /*
      ★ **개인톡은 허용 명단을 여기서 다시 본다**(2026-08-31). 코드 발급 때 이미 봤지만
        (`/api/bot/link-codes`), 코드는 10분을 살고 그 사이에 명단에서 빠질 수 있다.
        더 중요한 이유는 **발급과 소모가 다른 요청**이라는 것이다 — 앞의 검사를 통과한
        코드가 남아 있다는 사실만으로 방이 열리면, 명단은 "한때 통과했는가"를 뜻하게 된다.
      ★ 거절은 다른 실패와 **같은 404** 다. "권한이 없습니다"라고 알려 주면 코드를
        찍어 보는 쪽에 어느 코드가 살아 있는지를 알려 주는 신호가 된다.
    */
    if (pairCode.channelKind === "direct") {
      const granted = unwrap(
        await db
          .from("bot_direct_grants")
          .select("user_id")
          .eq("user_id", pairCode.userId)
          .limit(1),
        "개인톡 허용 명단 조회",
      );
      if (granted.length === 0) {
        console.warn("[bot] 명단에 없는 계정의 개인톡 페어링 시도");
        throw ApiError.botUnauthorized(404);
      }

      /*
        ★ **개인톡은 사람당 하나**라(부분 유니크 인덱스) 이미 있으면 새로 만들 수 없다.
          그래서 **옛 방을 걷어내고 새 방으로 바꾼다.**

          왜 거절이 아니라 교체인가: 이 요청은 그 사람이 웹에서 새 코드를 직접 받아
          방에 붙인 것이고, 개인톡 방을 새로 붙이는 이유는 실질적으로 하나뿐이다 —
          **기기를 바꿨거나 방을 다시 만들었다.** 거절하면 옛 방(이미 죽은 단말)을
          지울 방법이 없어 그 사람은 영영 개인톡을 못 쓰게 된다. `!연결` 이 같은 상황에서
          덮어쓰기를 택한 것과 **같은 판단**이다(`server/link.ts` 머리말).

          잃는 것은 옛 방에 쌓여 있던 미발송 알림뿐이고, 그것은 어차피 배달할 곳이
          없어진 것들이다. 파티방은 이 경로를 타지 않는다 — 종류가 `direct` 일 때만이다.
      */
      const replaced = unwrap(
        await db
          .from("bot_channels")
          .delete()
          .eq("owner_user_id", pairCode.userId)
          .eq("kind", "direct")
          .select("id"),
        "기존 개인톡 방 정리",
      );
      if (replaced.length > 0) {
        console.info(`[bot] 개인톡 방 교체: 옛 방 ${String(replaced.length)}건 제거`);
      }
    }

    const room = generateRoomId();
    const inserted = unwrap(
      await db
        .from("bot_channels")
        .insert({
          room,
          platform: "kakao",
          /*
            방 종류는 **코드가 정한다**. 나중에 바꿀 수 있게 두면 파티방이 조용히
            개인톡이 되어 그 방의 모두가 한 사람의 전체 일정을 보게 된다.
            `direct` 는 `owner_user_id` 가 반드시 있어야 하고(CHECK) 사람당 하나뿐이다
            (부분 유니크 인덱스) — 아래에서 그 둘을 함께 채운다.
          */
          kind: pairCode.channelKind,
          // 세대 0. 회전할 때마다 1씩 오른다(`server/signature.ts`).
          secret_hash: "0".repeat(64),
          owner_user_id: pairCode.userId,
          // **서명 없는 채널은 만들지 않는다**(`server/channel.ts` 머리말의 근거).
          signed: true,
          runner: body.runner ?? null,
          room_fingerprint: body.roomFingerprint ?? null,
          last_seen_at: now.toISOString(),
        })
        .select("id"),
      "채널 생성",
    );
    const channelId = inserted[0]?.id;
    if (channelId === undefined) throw ApiError.internal();

    /*
      시크릿은 **채널 id 에서 파생**되므로 행을 만든 뒤에야 계산할 수 있다.
      그래서 두 단계다: 자리표시자 해시로 삽입 → 진짜 해시로 갱신.
      중간 상태의 해시는 어떤 시크릿과도 대응하지 않으므로 그 사이에는 아무도 통과하지 못한다.
    */
    const secret = deriveChannelSecret(channelId, 0);
    unwrap(
      await db
        .from("bot_channels")
        .update({ secret_hash: hashSecret(secret) })
        .eq("id", channelId)
        .select("id"),
      "채널 시크릿 확정",
    );

    const consumed = await markPairCodeConsumed(db, pairCode.codeId, channelId, now);
    if (!consumed) {
      // 경합에서 졌다면 방금 만든 채널은 주인이 없다. 남겨 두면 유령 채널이 된다.
      unwrap(
        await db.from("bot_channels").delete().eq("id", channelId).select("id"),
        "경합 채널 회수",
      );
      throw ApiError.botUnauthorized(404);
    }

    return jsonOk<BotPairResponse>(
      { room, secret, pollIntervalSec: POLL_INTERVAL_SEC },
      201,
    );
  } catch (error) {
    return handleRouteError(error, "api/bot/pair#POST");
  }
}
