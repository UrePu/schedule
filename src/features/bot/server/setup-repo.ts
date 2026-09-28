import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 웹(세션 인증) 쪽 봇 설정 — **내 신원 + 내 파티**, 그게 전부다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 봇 엔드포인트는 런너 토큰 + 서명으로 인증하지만, **이 파일이 지원하는 경로는 세션으로**
 * 인증한다(`readSession()`). 연결 코드를 발급하는 행위가 곧 "이 사람이 나다"를 증명하는
 * 유일한 출발점이라, 세션 밖에서 발급되면 `!연결` 이 아무 의미가 없어진다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2026-09-28: **파티 ↔ 방 바인딩이 사라졌다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 파일의 절반은 `setPartyChannel()` 이었다 — `parties.bot_channel_id` 를 채워 "이 파티의
 * 알림이 갈 방"을 정하는 일이고, 그 값을 읽는 것은 아웃박스 적재뿐이었다. 알림이 사라졌으니
 * 목적지도 사라진다. 컬럼(`parties.bot_channel_id`)은 **남겨 둔다**(발주 결정: 표·컬럼은
 * 지우지 않는다) — 아무도 읽지 않는 값이다.
 *
 * 남은 일은 하나다: **내가 방에서 `!연결` 을 했는지** 를 웹 화면에 알려 주는 것.
 */

import { getAdminDb } from "@/lib/supabase/admin-db";
import type { BotBoundParty, BotIdentitySummary, BotSetupState } from "../types";

import { unwrap } from "./shared";

/**
 * 내 봇 신원 + 내 파티.
 *
 * ⚠️ 돌려주는 필드 이름이 `channels` 인 것은 **호환 때문이다**(`types.ts` 주석). 내용은
 *    방이 아니라 신원이다.
 */
export async function fetchBotSetup(userId: string): Promise<BotSetupState> {
  const db = getAdminDb();

  const [identities, participantRows] = await Promise.all([
    (async () =>
      unwrap(
        await db
          .from("bot_identities")
          .select("id,platform,display_name,linked_at,last_seen_at")
          .eq("user_id", userId)
          .order("linked_at", { ascending: true }),
        "내 봇 신원 조회",
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

  /*
    ★ **`sender_id` 를 싣지 않는다.** 카톡에서 그 값은 `kakao:<닉네임>` 이고, 표시에는
      `display_name` 으로 충분하다. 식별자 원문을 브라우저까지 내보낼 이유가 없다.
  */
  const channels: BotIdentitySummary[] = identities.map((row) => ({
    identityId: row.id,
    platform: row.platform,
    displayName: row.display_name,
    linked: true,
    linkedAt: row.linked_at,
    lastSeenAt: row.last_seen_at,
  }));

  const partyIds = [...new Set(participantRows.map((row) => row.party_id))];
  const parties: BotBoundParty[] =
    partyIds.length === 0
      ? []
      : unwrap(
          await db
            .from("parties")
            .select("id,name")
            .in("id", partyIds)
            .is("archived_at", null)
            .order("created_at", { ascending: true }),
          "내 파티 목록 조회",
        ).map((row) => ({ partyId: row.id, name: row.name }));

  return { channels, parties };
}
