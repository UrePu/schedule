import { z } from "zod";

import {
  ApiError,
  handleRouteError,
  jsonOk,
} from "@/features/auth/server/http";
import { authenticateHeaderRequest } from "@/features/bot/server/request-auth";
import { unwrap } from "@/features/bot/server/shared";
import {
  deriveChannelSecret,
  findGeneration,
  hashSecret,
  MAX_GENERATION,
} from "@/features/bot/server/signature";
import { getAdminDb } from "@/lib/supabase/admin-db";
import type { BotRotateResponse } from "@/features/bot/types";

/**
 * `POST /api/bot/rotate` — 채널 시크릿 회전. **서명이 필요하다.**
 *
 * 새 시크릿을 즉시 발급하고 **구 시크릿을 24시간 병행 검증**한다. 유예가 없으면 회전
 * 순간 방의 봇이 조용히 죽는다 — 클라이언트가 새 값을 반영하기까지 시차가 있기 때문이다.
 *
 * ⚠️ 원문 시크릿은 이 응답에만 나온다. 서버는 해시만 보관한다.
 * ⚠️ 세대 상한(`MAX_GENERATION`)을 넘기면 회전할 수 없다. 그때는 방을 다시 페어링한다.
 */

const bodySchema = z.object({
  room: z.string().trim().min(1).max(64),
});

const GRACE_HOURS = 24;

export async function POST(request: Request): Promise<Response> {
  const now = new Date();
  try {
    let raw: unknown;
    try {
      raw = (await request.json()) as unknown;
    } catch {
      throw ApiError.badRequest("요청 본문이 JSON 이 아닙니다.");
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) throw ApiError.badRequest("요청 형식이 올바르지 않습니다.");

    const db = getAdminDb();
    const channel = await authenticateHeaderRequest({
      db,
      request,
      room: parsed.data.room,
      body: raw,
      now,
    });

    const generation = findGeneration(channel.id, channel.secret_hash);
    if (generation === null || generation >= MAX_GENERATION) {
      console.warn(`[bot] 회전 불가(세대 상한/불일치): channel=${channel.id}`);
      throw ApiError.badRequest(
        "이 채널은 더 이상 회전할 수 없습니다. 방을 다시 연결해 주세요.",
      );
    }

    const next = deriveChannelSecret(channel.id, generation + 1);
    const previousExpiresAt = new Date(now.getTime() + GRACE_HOURS * 3600_000);

    unwrap(
      await db
        .from("bot_channels")
        .update({
          secret_hash: hashSecret(next),
          secret_rotated_at: now.toISOString(),
          previous_secret_hash: channel.secret_hash,
          previous_secret_expires_at: previousExpiresAt.toISOString(),
        })
        .eq("id", channel.id)
        .select("id"),
      "채널 시크릿 회전",
    );

    return jsonOk<BotRotateResponse>({
      room: channel.room,
      secret: next,
      previousSecretExpiresAt: previousExpiresAt.toISOString(),
    });
  } catch (error) {
    return handleRouteError(error, "api/bot/rotate#POST");
  }
}
