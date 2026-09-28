import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 연결 코드와 신원 — **닉네임이 유일한 단서다. 그래서 선점 규칙이 있다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 방에서 얻을 수 있는 발신자 정보는 **닉네임뿐**이고(카톡 런너가 안정적인 발신자 id 를
 * 주지 않는다), 신원의 유일한 근거는 `!연결 <코드>` 로 맺어진
 * `bot_identities(platform, sender_id) → app_users.id` 매핑이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ 2026-09-28: 축이 `(방, 발신자)` 에서 `(플랫폼, 발신자)` 로 내려왔다 ★★
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지시: *"닉네임으로 판별하여 연결하는거만 가능 !연결 ~~ 만 남기기."*
 *
 * 예전 매핑은 `bot_channel_members(channel_id, sender_id)` 였고, 카톡 방 하나가 말한
 * 사람 수만큼 다른 채널로 갈라지는 바람에 **이미 연결을 마친 사람이 "연결이 필요합니다"
 * 를 받았다.** 2026-09-23 에 "같은 주인의 파티방들"까지 넓혀 읽는 폴백으로 메웠지만,
 * 그것은 식별할 수 없는 값을 추측으로 메우는 일이었다. 지금은 방을 아예 보지 않는다.
 *
 * ⚠️ **그 대가가 선점 규칙이다.** 범위를 사람 단위로 넓히면 `sender_id` 는 사실상
 *    닉네임이고 닉네임은 전 세계에서 유일하지 않다. 그래서 `!연결` 은 **이미 다른 계정에
 *    물려 있는 발신자를 거부한다** — 덮어쓰지 않는다. 덮어쓰기를 허용하면 오픈챗에서 남의
 *    닉네임을 쓰고 자기 코드로 `!연결` 하는 것만으로 그 사람의 자리를 가로챌 수 있다.
 *    (예전 규칙은 "코드가 소유를 증명하므로 덮어쓴다"였다. 그 말은 여전히 맞지만,
 *     증명된 것은 *그 코드의 주인이 나*이지 *이 닉네임이 내 것*이 아니다 — 방 단위였을
 *     때는 방 주인이 구성원을 통제해서 그 차이가 드러나지 않았을 뿐이다.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ 선점 규칙이 막지 **못하는** 것 — 사실대로 적는다 (2026-09-28 교차 검증) ★★
 * ─────────────────────────────────────────────────────────────────────────────
 * 선점 규칙(과 `bot_identities_sender_uniq`)이 막는 것은 **연결, 즉 쓰기 하나뿐이다.**
 *   - 막는다: 남의 닉네임으로 `!연결 <내 코드>` 를 쳐서 그 닉네임을 **내 계정에 물리는** 것.
 *   - **막지 못한다: 사칭, 즉 읽기.** 이미 연결을 마친 피해자와 **같은 닉네임으로 이름을
 *     바꾸고** `!결정석` `!숙제` `!일정` 을 치면, `resolveMember` 는 `kakao:<닉네임>` 만
 *     보므로 **피해자 계정으로 해석하고 피해자 데이터를 그대로 답장한다.** `!보스` 처럼
 *     쓰는 명령도 같은 경로로 통한다. 연결이 아예 필요 없는 공격이라 유니크 인덱스가
 *     닿지 않는다.
 *
 * 그리고 그 사칭의 **범위가 방을 걷어내면서 넓어졌다.** 예전 축은
 * `bot_channel_members(channel_id, sender_id)` 라 사칭도 *그 방 안*에서만 통했고, 방 주인이
 * 구성원을 통제했다. 지금은 축이 `(platform, sender_id)` 하나이므로 **런너가 붙어 있는
 * 아무 방에서나** 피해자 닉네임을 쓰면 통한다. 오픈챗이면 초대도 필요 없다.
 *
 * ⚠️ 이것은 **발주 결정의 대가이지 버그가 아니다.** 카톡 런너가 안정적인 발신자 id 를 주지
 *    않는 한 고칠 수단이 없고(§2.2 — 방이 주는 것은 닉네임뿐), 발주는 그 대가를 알고
 *    "닉네임으로 판별" 을 택했다. 고칠 수 없는 것을 감추지만 않으면 된다 —
 *    **막힌다고 적힌 주석이 결함이다.** 지금 이 문단이 그 자리를 대신한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 코드 취급 — **원문은 DB 에 없다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `guest_profiles.claim_token_hash`(초대 링크) · `user_credentials.api_key_hash`
 * (넥슨 키)와 **같은 기조**다:
 *   - 발급: 원문은 **발급 응답 1회만** 나가고, 저장은 SHA-256 hex.
 *   - 검증: 받은 원문을 해시해 대조한다. 역방향은 존재하지 않는다.
 *   - 소모: `consumed_at` 을 채워 **한 번만** 쓸 수 있게 한다.
 *   - 재발급: 이전 미사용 코드를 `revoked_at` 으로 죽인다(사용자당 동시 1개).
 *
 * ⚠️ **코드별 시도 횟수(`attempt_count`)로는 무차별 대입을 막을 수 없다.** 틀린 코드는
 *    어떤 행에도 해시가 맞지 않아 셀 대상 자체가 없기 때문이다. 그래서 실제 방어는
 *    (a) 짧은 TTL 10분, (b) 32글자 알파벳 6자리(≈10억 가지), (c) 아래
 *    **발신자별 실패 제한**이다. `attempt_count` 는 "코드는 맞았는데 소모에 실패한"
 *    경우에만 오르며, 그 값이 한도를 넘으면 코드를 폐기한다.
 */

import { createHash, randomInt } from "node:crypto";

import { ApiError } from "@/features/auth/server/http";
import type { AdminDb } from "@/lib/supabase/admin-db";
import type { BotLinkCode, BotLinkCodeKind } from "../types";

import { ignoreError, unwrap } from "./shared";

/** 코드 수명. 방에서 바로 치는 값이므로 길 이유가 없다. */
const CODE_TTL_MINUTES = 10;

/**
 * 헷갈리는 글자를 뺀 알파벳: `I` `O` `0` `1` 없음. 32글자 · 6자리 ≈ 10.7억 가지.
 * 사람이 방에서 손으로 옮겨 적는 값이라 **오독을 줄이는 것이 보안만큼 중요하다.**
 */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

export function generateCode(): string {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

export function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** 방에서 친 값은 공백·하이픈이 섞이기 쉽다. 형식이 아니면 DB 를 때리지 않는다. */
export function normalizeCode(raw: string): string | null {
  const code = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== CODE_LENGTH) return null;
  for (const char of code) {
    if (!CODE_ALPHABET.includes(char)) return null;
  }
  return code;
}

// ─────────────────────────────────────────────────────────────────────────────
// 발급 (웹 · 세션 인증)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 코드를 발급한다. **기존 미사용 코드는 즉시 죽는다**(동시 1개).
 *
 * 두 장을 동시에 살려 두면 "아까 받은 코드"와 "방금 받은 코드"가 둘 다 통해서,
 * 어느 것이 유효한지 사용자도 우리도 말할 수 없게 된다.
 *
 * ⚠️ 종류가 `member_link` 하나뿐이지만 `kind` 를 그대로 남긴다 — DB enum 에 과거 값
 *    (`channel_pair` · `direct_pair`)이 남아 있어 조회에 반드시 조건이 붙어야 한다.
 */
export async function issueLinkCode(
  db: AdminDb,
  input: { readonly kind: BotLinkCodeKind; readonly userId: string },
  now: Date,
): Promise<BotLinkCode> {
  ignoreError(
    await db
      .from("bot_link_codes")
      .update({ revoked_at: now.toISOString() })
      .eq("user_id", input.userId)
      .eq("kind", input.kind)
      .is("consumed_at", null)
      .is("revoked_at", null),
    "기존 연결 코드 폐기",
  );

  const expiresAt = new Date(now.getTime() + CODE_TTL_MINUTES * 60_000);

  /*
    `code_hash` 는 전역 유니크다. 10억 분의 1 충돌이라도 사용자에게 500 을 주지 않도록
    몇 번 다시 뽑는다. 실패가 계속되면 그건 우리 쪽 사고이므로 500 이 맞다.
  */
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateCode();
    const result = await db
      .from("bot_link_codes")
      .insert({
        kind: input.kind,
        code_hash: hashCode(code),
        user_id: input.userId,
        expires_at: expiresAt.toISOString(),
      })
      .select("id")
      .maybeSingle();

    if (result.error === null) {
      return { kind: input.kind, code, expiresAt: expiresAt.toISOString() };
    }
    if (result.error.code !== "23505") {
      console.error(`[bot] 연결 코드 발급 실패: ${result.error.message}`);
      throw ApiError.internal();
    }
  }

  console.error("[bot] 연결 코드 해시 충돌이 반복됩니다.");
  throw ApiError.internal();
}

// ─────────────────────────────────────────────────────────────────────────────
// 소모
// ─────────────────────────────────────────────────────────────────────────────

interface LinkCodeRow {
  readonly id: string;
  readonly kind: BotLinkCodeKind;
  readonly user_id: string | null;
  readonly attempt_count: number;
  readonly max_attempts: number;
}

/**
 * 쓸 수 없는 코드는 **원인을 나누지 않는다.**
 *
 * "없는 코드"와 "만료된 코드"를 구분해 주면 훑어서 살아 있는 코드를 찾을 수 있다
 * (초대 토큰이 같은 이유로 원인을 접는다). 대신 사용자가 **할 수 있는 일**을 말한다.
 */
export function codeUnusableReply(): string {
  return [
    "❌ 코드가 맞지 않거나 만료됐어요.",
    "웹에서 새 코드를 받아 다시 입력해 주세요.",
  ].join("\n");
}

async function findUsableCode(
  db: AdminDb,
  code: string,
  kind: BotLinkCodeKind,
): Promise<LinkCodeRow | null> {
  const rows = unwrap(
    await db
      .from("bot_link_codes")
      .select("id,kind,user_id,attempt_count,max_attempts")
      .eq("code_hash", hashCode(code))
      .eq("kind", kind)
      .is("consumed_at", null)
      .is("revoked_at", null)
      /*
        ★ 만료 비교는 **DB 시각**으로 한다. `expires_at` 을 우리가 채우긴 하지만, 두
          시계가 어긋나면 이미 죽은 코드가 그 차이만큼 더 살아 있게 된다(이 저장소의
          개발 머신은 Supabase 보다 7.6초 느렸다). PostgREST 의 `now` 는 Postgres 가
          `timestamptz 'now'` 로 캐스팅해 트랜잭션 시각으로 비교한다.
      */
      .gt("expires_at", "now")
      .limit(1),
    "연결 코드 조회",
  );
  const row = rows[0] as LinkCodeRow | undefined;
  if (row === undefined) return null;
  if (row.attempt_count >= row.max_attempts) return null;
  return row;
}

/** 코드는 맞았지만 소모에 실패한 경우. 한도를 넘으면 그 코드를 죽인다. */
async function noteCodeAttempt(db: AdminDb, row: LinkCodeRow, now: Date): Promise<void> {
  const next = row.attempt_count + 1;
  ignoreError(
    await db
      .from("bot_link_codes")
      .update(
        next >= row.max_attempts
          ? { attempt_count: next, revoked_at: now.toISOString() }
          : { attempt_count: next },
      )
      .eq("id", row.id),
    "연결 코드 시도 횟수 갱신",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 발신자별 실패 제한 — **프로세스 내 최선 노력**
// ─────────────────────────────────────────────────────────────────────────────
/*
  담을 테이블이 없고 실패한 코드는 어떤 행에도 매달 수 없다. 인스턴스가 여러 개면 한도가
  인스턴스 수만큼 늘어난다는 뜻이므로 **이것만 믿지 않는다** — 진짜 방어는 10분 TTL 과
  10억 가지 코드 공간이다. 이 맵은 한 방에서 사람이 코드를 연타로 찍어 보는 흔한 경우를
  끊는 용도다.

  ⚠️ 키가 `channelId:senderId` 에서 **`platform:senderId`** 로 바뀌었다. 방이 없어졌으니
     방마다 한도가 따로 생기는 일도 없어진다 — 예전에는 방을 옮겨 가며 찍으면 한도가
     방 수만큼 늘어났다.
*/
const FAILURE_LIMIT = 5;
const FAILURE_WINDOW_MS = 10 * 60_000;
const failures = new Map<string, { count: number; resetAt: number }>();

function failureKey(platform: string, senderId: string): string {
  return `${platform}:${senderId}`;
}

export function tooManyLinkFailures(
  platform: string,
  senderId: string,
  now: Date,
): boolean {
  const entry = failures.get(failureKey(platform, senderId));
  if (entry === undefined) return false;
  if (entry.resetAt <= now.getTime()) return false;
  return entry.count >= FAILURE_LIMIT;
}

export function noteLinkFailure(platform: string, senderId: string, now: Date): void {
  const key = failureKey(platform, senderId);
  const entry = failures.get(key);
  if (entry === undefined || entry.resetAt <= now.getTime()) {
    failures.set(key, { count: 1, resetAt: now.getTime() + FAILURE_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function clearLinkFailures(platform: string, senderId: string): void {
  failures.delete(failureKey(platform, senderId));
}

// ─────────────────────────────────────────────────────────────────────────────
// `!연결` — 발신자 ↔ 계정 매핑
// ─────────────────────────────────────────────────────────────────────────────

export interface LinkedMember {
  readonly userId: string;
  readonly displayName: string | null;
}

/**
 * `!연결` 의 결과.
 *
 * ★ `taken` 이 **별도 결과인 것이 요점이다.** "코드가 틀렸다"와 "이 닉네임은 남의 것이다"
 *   는 사용자가 할 일이 완전히 다르다 — 앞은 코드를 다시 받는 것이고, 뒤는 웹에서 내
 *   신원 목록을 확인하는 것이다. 둘을 같은 문구로 접으면 진짜 본인이 영원히 막힌다.
 *
 * ★ `codeSpent` 는 **답장이 거짓말을 하지 않게 하는 칸이다**(2026-09-28). `taken` 에는 두
 *   경로가 있다:
 *     - 사전 SELECT 에서 걸린 경우 → 코드는 **멀쩡하다.** 원인만 풀면 그대로 다시 쓴다.
 *     - 소모 뒤 INSERT 가 23505 로 진 경합 → 코드는 **이미 죽었다.** 그때 "다시
 *       시도하세요" 라고만 답하면 그 코드로는 불가능한 일을 시키는 셈이다.
 *   그래서 결과가 그 차이를 들고 나가고, 문구는 `commands.ts` 가 나눈다.
 */
export type MemberLinkResult =
  | { readonly status: "linked"; readonly member: LinkedMember }
  | { readonly status: "taken"; readonly codeSpent: boolean }
  | { readonly status: "unusable" };

/**
 * 코드로 이 발신자를 계정에 붙인다.
 *
 * ★ **선점 규칙**(파일 머리말). 같은 `(platform, sender_id)` 가 **다른** 계정에 물려
 *   있으면 `taken` 이고 코드는 **소모하지 않는다** — 진짜 주인이 그 코드를 그대로 쓸 수
 *   있어야 한다. 같은 계정이면 멱등하게 스냅샷만 새로 쓴다(닉네임 표시가 갱신된다).
 *
 * ⚠️ ═══════════════════════════════════════════════════════════════════════════
 *    **`upsert` 를 쓰면 안 된다 — `ON CONFLICT DO UPDATE` 라서 아무것도 막지 못한다**
 *    ═══════════════════════════════════════════════════════════════════════════
 *    2026-09-28 교차 검증에서 잡힌 실제 결함이다. 여기에는
 *    `.upsert({...}, { onConflict: "platform,sender_id" })` 가 있었고, supabase-js 는 그것을
 *    `insert ... on conflict (platform, sender_id) do update set ...` 으로 보낸다. 그러면
 *      1. **유니크 위반(23505)이 영원히 나지 않는다** — 아래 `23505 → taken` 분기는 도달
 *         불가능한 죽은 코드였다.
 *      2. 충돌한 행의 `user_id` 를 **조용히 덮어쓴다.** 즉 사전 SELECT 와 이 쓰기 사이의
 *         경합에서 **나중 사람이 먼저 연결한 사람을 밀어낸다** — 선점 규칙이 지키려던 바로
 *         그 일이 일어난다. 머리말의 *"유니크가 마지막으로 막는다"* 는 문장은 그동안 거짓이었다.
 *
 *    그래서 쓰기를 **두 경로로 쪼갠다.** 남의 행에 닿는 경로가 하나도 남으면 안 된다:
 *      - 내 행이 이미 있다(멱등 재연결) → `UPDATE ... WHERE (platform, sender_id) AND
 *        user_id = 나`. `user_id` 조건이 붙어 있으므로 그 사이 주인이 바뀌었으면 **0행이
 *        갱신되고**, 그것을 `taken` 으로 읽는다. 남의 행은 절대 건드리지 않는다.
 *      - 행이 없다 → 평범한 `INSERT`. 경합하면 `bot_identities_sender_uniq` 가 **진짜로**
 *        23505 를 던지고, 그때 `taken` 이 된다 — 그 순간 남이 먼저 가져간 것이니 사실 그대로다.
 *    이 두 갈래 덕분에 머리말의 "유니크가 마지막으로 막는다" 가 이제 참이다.
 *    (막는 것은 **연결뿐이고 사칭은 아니다** — 그 한계도 머리말에 적혀 있다.)
 */
export async function consumeMemberLinkCode(
  db: AdminDb,
  input: {
    readonly code: string;
    readonly platform: string;
    readonly senderId: string;
    readonly displayName: string;
  },
  now: Date,
): Promise<MemberLinkResult> {
  const row = await findUsableCode(db, input.code, "member_link");
  if (row === null) return { status: "unusable" };
  if (row.user_id === null) {
    await noteCodeAttempt(db, row, now);
    return { status: "unusable" };
  }
  const userId = row.user_id;

  const existing = unwrap(
    await db
      .from("bot_identities")
      .select("id,user_id")
      .eq("platform", input.platform)
      .eq("sender_id", input.senderId)
      .limit(1),
    "기존 신원 조회",
  );
  const claimed = existing[0];
  if (claimed !== undefined && claimed.user_id !== userId) {
    console.warn(
      `[bot] 선점된 발신자에 연결 시도: platform=${input.platform} identity=${claimed.id}`,
    );
    // 코드는 멀쩡하다 — 소모 이전에 걸렀다.
    return { status: "taken", codeSpent: false };
  }

  /*
    ★ **소모가 신원 쓰기보다 먼저다.** 뒤집고 싶은 유혹이 있다(경합에 지면 코드가 죽으므로).
      그런데 뒤집으면 유출된 코드 하나로 **두 발신자가 모두 신원을 얻는다** — 코드는
      한 계정을 가리키므로 두 쪽 다 INSERT 에 성공하고(서로 다른 `sender_id` 다), 뒤늦게
      소모가 0행이어도 이미 쓴 행을 되돌릴 방법이 없다. 단 한 번만 쓰이는 성질이 코드의
      전부이므로 순서를 지키고, 대신 죽은 코드를 `codeSpent` 로 답장에 알린다(④).
  */
  const consumed = unwrap(
    await db
      .from("bot_link_codes")
      .update({ consumed_at: now.toISOString() })
      .eq("id", row.id)
      // 경합 방어: 그 사이 누가 썼다면 아무 행도 갱신되지 않는다.
      .is("consumed_at", null)
      .select("id"),
    "연결 코드 소모",
  );
  if (consumed.length === 0) return { status: "unusable" };

  const snapshot = {
    display_name: input.displayName,
    last_seen_at: now.toISOString(),
  };

  if (claimed !== undefined) {
    /*
      멱등 재연결(같은 사람이 같은 닉네임으로 코드를 다시 썼다). `linked_at` 은 **건드리지
      않는다** — 처음 연결한 시각이 기록이고, 다시 눌렀다고 앞당기거나 미룰 이유가 없다.
      ⚠️ `user_id` 조건이 이 쿼리의 안전장치다. 빼면 남의 행을 덮어쓰는 경로가 다시 생긴다.
    */
    const updated = await db
      .from("bot_identities")
      .update(snapshot)
      .eq("platform", input.platform)
      .eq("sender_id", input.senderId)
      .eq("user_id", userId)
      .select("id");

    if (updated.error !== null) {
      console.error(`[bot] 신원 갱신 실패: ${updated.error.message}`);
      throw ApiError.internal();
    }
    // 0행 = 그 사이 주인이 바뀌었다(해제 후 남이 선점). 덮어쓰지 않고 사실대로 답한다.
    if (updated.data === null || updated.data.length === 0) {
      return { status: "taken", codeSpent: true };
    }
    return { status: "linked", member: { userId, displayName: input.displayName } };
  }

  const inserted = await db
    .from("bot_identities")
    .insert({
      platform: input.platform,
      sender_id: input.senderId,
      user_id: userId,
      linked_at: now.toISOString(),
      ...snapshot,
    })
    .select("id");

  if (inserted.error !== null) {
    // 유니크 위반 = 그 사이 남이 먼저 가져갔다. 코드는 이미 소모됐으므로 그 사실을 말해 준다.
    if (inserted.error.code === "23505") return { status: "taken", codeSpent: true };
    console.error(`[bot] 신원 저장 실패: ${inserted.error.message}`);
    throw ApiError.internal();
  }

  return { status: "linked", member: { userId, displayName: input.displayName } };
}

/**
 * 매핑을 지운다. 지운 것이 있으면 `true`.
 *
 * ★ **이제 범위가 하나다.** 예전에는 방마다 행이 있어 "이 방에서만 푼다"와 "전부 푼다"가
 *   갈렸고, 한 방에서 푼 것이 형제 방 폴백으로 되살아나는 알려진 결함이 있었다. 행이
 *   하나뿐이므로 그 비대칭도, 되살아남도 사라졌다.
 *
 * ⚠️ **알려진 한계 — 이 명령이 선점 규칙을 우회시킨다**(2026-09-28 교차 검증).
 *    지우는 조건은 `(platform, sender_id)` 뿐이고 **누가 소유한 행인지 묻지 않는다.** 그래서
 *    피해자 닉네임으로 이름을 바꾼 사람이 `!연결해제` → `!연결 <자기 코드>` 를 치면 그
 *    닉네임을 가져간다.
 *    ★ **소유자 검사를 붙여도 막히지 않는다.** 검사의 근거가 될 신원 자체가 같은
 *      `sender_id` 로 해석되므로, 사칭자는 언제나 "본인" 으로 통과한다. 애초에 사칭
 *      자체를 막을 수단이 없다(머리말). 그래서 여기서는 조건을 늘리지 않는다 — 막지 못하는
 *      검사를 넣으면 막힌다고 **착각**하게 만들 뿐이고, 그것이 이번에 고친 결함의 본체였다.
 *    ★ 할 수 있는 것은 하나뿐이고 이미 했다: `!연결` 의 `taken` 안내가 **이 우회 경로를
 *      읊지 않는다**(`commands.ts` — "그 계정에서 !연결해제" 라고 알려 주던 문구를 걷었다).
 *    ⇒ 근본 해결은 런너가 닉네임이 아닌 **안정적 발신자 id** 를 싣고 오는 날에만 가능하다.
 */
export async function unlinkMember(
  db: AdminDb,
  platform: string,
  senderId: string,
): Promise<boolean> {
  const removed = unwrap(
    await db
      .from("bot_identities")
      .delete()
      .eq("platform", platform)
      .eq("sender_id", senderId)
      .select("id"),
    "신원 해제",
  );
  return removed.length > 0;
}

/**
 * 발신자 → 계정. **이것이 신원 해석의 유일한 경로다.**
 *
 * 닉네임 스냅샷은 표시용으로만 갱신한다 — 이름이 바뀌면 `sender_id` 자체가 달라지므로
 * (카톡에서는 `kakao:<닉네임>`) 이 갱신이 잡는 것은 대소문자·공백 같은 표기 차이뿐이다.
 *
 * ⚠️ **사칭이 통과하는 지점이 정확히 여기다.** 선점 규칙도 `bot_identities_sender_uniq` 도
 *    이 조회에는 관여하지 않는다 — 피해자와 같은 닉네임이면 같은 행이 나오고, 호출자는
 *    피해자 계정을 받는다. 읽기(`!결정석` `!숙제` `!일정`)도 쓰기(`!보스` `!드랍`)도 같다.
 *    고칠 수단이 없는 대가이지 버그가 아니다(머리말). **여기에 방어가 있다고 적지 마라.**
 */
export async function resolveMember(
  db: AdminDb,
  platform: string,
  senderId: string,
  displayName: string,
  now: Date,
): Promise<LinkedMember | null> {
  const rows = unwrap(
    await db
      .from("bot_identities")
      .select("user_id,display_name")
      .eq("platform", platform)
      .eq("sender_id", senderId)
      .limit(1),
    "발신자 계정 조회",
  );
  const row = rows[0];
  if (row === undefined) return null;

  if (row.display_name !== displayName) {
    ignoreError(
      await db
        .from("bot_identities")
        .update({ display_name: displayName, last_seen_at: now.toISOString() })
        .eq("platform", platform)
        .eq("sender_id", senderId),
      "발신자 표시 이름 갱신",
    );
  }

  return { userId: row.user_id, displayName: row.display_name };
}
