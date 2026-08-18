import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 웹(세션 인증) 쪽 봇 설정 — 코드 발급 · 내 방 · 파티 ↔ 방 바인딩
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 봇 엔드포인트는 채널 서명으로 인증하지만, **이 파일이 지원하는 경로는 세션으로**
 * 인증한다(`readSession()`). 연결 코드를 발급하는 행위가 곧 "이 사람이 나다"를 증명하는
 * 유일한 출발점이라, 세션 밖에서 발급되면 `!연결` 이 아무 의미가 없어진다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 파티 ↔ 방 바인딩이 여기 있는가
 * ─────────────────────────────────────────────────────────────────────────────
 * `parties.bot_channel_id` 는 마이그레이션 13 에서 만들어졌지만 **그 값을 채우는 코드가
 * 저장소에 하나도 없었다.** 그래서 `enqueue_run_notice()` 도, 방 기준 `!일정` 도 언제나
 * 빈 결과였다 — 기능이 아니라 배선이 빠져 있었던 것이다. 그 배선이 이 파일이다.
 *
 * ⚠️ **어느 방에 속하는지는 사적 정보다**(마이그레이션 13-7). `parties.bot_channel_id` 는
 *    anon/authenticated 에 컬럼 GRANT 자체가 없고, 공개 시간표로 새지 않는다. 이 파일은
 *    service_role 로 읽되 **자기 파티·자기 방만** 다룬다.
 */

import { ApiError } from "@/features/auth/server/http";
import { getAdminDb } from "@/lib/supabase/admin-db";
import type { BotBoundParty, BotChannelSummary, BotSetupState } from "../types";

import { unwrap } from "./shared";

/**
 * 내가 관여하는 방 + 내 파티의 바인딩 상태.
 *
 * `room`(불투명 ID)은 **내가 페어링한 방에만** 싣는다. 클라이언트 설정에 필요한 값이
 * 방 주인에게만 필요하고, 방에 얹혀 있는 사람에게까지 줄 이유가 없다.
 */
export async function fetchBotSetup(userId: string): Promise<BotSetupState> {
  const db = getAdminDb();

  const [memberships, owned, participantRows] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("bot_channel_members")
          .select("channel_id,display_name,linked_at")
          .eq("user_id", userId),
        "내 방 매핑 조회",
      ))(),
    (async () =>
      unwrap(
        await db
          .from("bot_channels")
          .select("id,room,platform,status")
          .eq("owner_user_id", userId),
        "내가 만든 방 조회",
      ))(),
    (async () =>
      unwrap(
        await db
          .from("party_participants")
          .select("party_id")
          .eq("user_id", userId)
          .is("left_at", null),
        "내 파티 조회",
      ))(),
  ]);

  const memberChannelIds = memberships.map((row) => row.channel_id);
  const ownedById = new Map(owned.map((row) => [row.id, row]));

  const extraIds = memberChannelIds.filter((id) => !ownedById.has(id));
  const extra =
    extraIds.length === 0
      ? []
      : unwrap(
          await db
            .from("bot_channels")
            .select("id,room,platform,status")
            .in("id", extraIds),
          "연결된 방 조회",
        );

  const membershipById = new Map(memberships.map((row) => [row.channel_id, row]));
  const channels: BotChannelSummary[] = [...owned, ...extra].map((row) => {
    const membership = membershipById.get(row.id);
    const isOwner = ownedById.has(row.id);
    return {
      channelId: row.id,
      room: isOwner ? row.room : null,
      platform: row.platform,
      status: row.status,
      owner: isOwner,
      linked: membership !== undefined,
      displayName: membership?.display_name ?? null,
      linkedAt: membership?.linked_at ?? null,
    };
  });

  const partyIds = [...new Set(participantRows.map((row) => row.party_id))];
  const parties: BotBoundParty[] =
    partyIds.length === 0
      ? []
      : unwrap(
          await db
            .from("parties")
            .select("id,name,bot_channel_id")
            .in("id", partyIds)
            .is("archived_at", null)
            .order("created_at", { ascending: true }),
          "파티 바인딩 조회",
        ).map((row) => ({
          partyId: row.id,
          name: row.name,
          channelId: row.bot_channel_id,
        }));

  return { channels, parties };
}

/**
 * 파티 알림이 갈 방을 정한다. `channelId = null` 이면 **푸시 없음**(정상 상태).
 *
 * 자격:
 *   - 그 파티의 **현재 구성원**이어야 한다(일정 편집과 같은 눈높이).
 *   - 붙이려는 방에 **내가 연결돼 있거나 내가 만든 방**이어야 한다. 아니면 남의 방에
 *     내 파티 알림을 밀어 넣을 수 있게 된다.
 */
export async function setPartyChannel(
  userId: string,
  partyId: string,
  channelId: string | null,
): Promise<BotBoundParty> {
  const db = getAdminDb();

  const membership = unwrap(
    await db
      .from("party_participants")
      .select("id")
      .eq("party_id", partyId)
      .eq("user_id", userId)
      .is("left_at", null)
      .limit(1),
    "파티 구성원 확인",
  );
  if (membership.length === 0) {
    // 없는 파티와 남의 파티를 같은 답으로 접는다(schedule-repo 와 같은 규칙).
    throw new ApiError("bad_request", "파티를 찾을 수 없습니다.", 404);
  }

  if (channelId !== null) {
    const [linked, owned] = await Promise.all([
      (async () =>
        unwrap(
          await db
            .from("bot_channel_members")
            .select("id")
            .eq("channel_id", channelId)
            .eq("user_id", userId)
            .limit(1),
          "방 연결 확인",
        ))(),
      (async () =>
        unwrap(
          await db
            .from("bot_channels")
            .select("id")
            .eq("id", channelId)
            .eq("owner_user_id", userId)
            .limit(1),
          "방 소유 확인",
        ))(),
    ]);
    if (linked.length === 0 && owned.length === 0) {
      throw new ApiError(
        "bad_request",
        "연결되지 않은 방입니다. 방에서 `!연결` 로 계정을 먼저 연결해 주세요.",
        403,
      );
    }
  }

  const updated = unwrap(
    await db
      .from("parties")
      .update({ bot_channel_id: channelId })
      .eq("id", partyId)
      .select("id,name,bot_channel_id"),
    "파티 방 바인딩 저장",
  );
  const row = updated[0];
  if (row === undefined) throw ApiError.internal();

  return { partyId: row.id, name: row.name, channelId: row.bot_channel_id };
}
