import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 명령 감사 로그 = **리플레이 방지 + 레이트리밋 + 도배 방지**의 단일 근거
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `bot_command_log` 에 걸린 **nonce 유니크 제약**이 리플레이 방지 테이블 역할을 그대로
 * 한다. 별도 캐시를 두지 않는 이유: 서버 인스턴스가 여러 개면 프로세스 메모리 캐시는
 * 방어가 되지 않는다. DB 유니크는 인스턴스 수와 무관하게 정확하다.
 *
 * ★ **삽입이 곧 획득(claim)이다.** 명령을 처리하기 **전에** 넣는다. 뒤에 넣으면 같은
 *   nonce 두 개가 동시에 들어와 둘 다 처리된 뒤에야 하나가 거절된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ 2026-09-28: 방이 사라져 **두 축이 함께 내려왔다** ★★
 * ─────────────────────────────────────────────────────────────────────────────
 *  · 유니크 제약  `(channel_id, nonce)` → **`nonce` 단독**(`channel_id is null` 부분 인덱스).
 *    ⚠️ 이것을 빼먹으면 방어가 **조용히 사라진다.** Postgres 의 유니크 인덱스에서 NULL 은
 *       서로 다른 값이라, `channel_id` 에 null 을 넣는 순간 기존 `(channel_id, nonce)`
 *       유니크는 아무것도 막지 못한다. 마이그레이션
 *       `20260928120000_bot_identities_drop_rooms.sql` 이 그 인덱스를 만든다.
 *  · 레이트리밋  방 20/분 + 발신자 6/분 → **발신자 6/분 하나.** 셀 방이 없다.
 *    방 한도가 하던 일(한 방이 통째로 시끄러워지는 것 막기)은 이제 사람 수만큼의 개별
 *    한도가 대신한다. 한 사람이 6번을 넘겨 치는 경우가 실제 도배의 모양이었다.
 *  · 직전 답장 digest 도 **발신자 기준**이다. 방 기준이던 예전에는 A 와 B 가 같은 명령을
 *    연달아 쳤을 때 뒤엣사람이 `· HH:mm` 이 붙은 답을 받았다. 지금은 각자 자기 직전만 본다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ 2026-10-13: **거절이 보이게 됐고, 도배 방지가 60초 밖에서도 돈다** ★★
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 신고 *"계속 !숙제 !결정석 다른류를 쳐야 인식하는데"* 를 조사하면서 이 파일에서
 * 두 가지가 나왔다. 둘 다 "로그만 보면 전부 200 이라 아무 문제가 없어 보인다"에
 * 기여하고 있었다.
 *   · **직전 답장 digest 가 레이트리밋 창(60초)을 같이 쓰고 있었다** → 1분 넘겨 같은
 *     명령을 치면 글자 하나까지 같은 답장이 나가고, 런너/카톡 도배 방지에 먹혔다.
 *     → `RECENT_SCAN_ROWS` 로 분리(아래).
 *   · **429·409 가 상태 코드를 남기지 않았다** → `status_code = 429` 로 세면 0건,
 *     409 는 행 자체가 생길 수 없다. "서버는 아무것도 막지 않았다"는 오독의 출처다.
 *     → 429 는 행을 마감하고, 409 는 플랫폼 로그에 한 줄 남긴다(아래 각 자리).
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

/** 한 사람이 1분에 칠 수 있는 명령 수. */
const SENDER_LIMIT_PER_MINUTE = 6;

/**
 * 한 발신자의 최근 행을 몇 줄까지 읽는가.
 *
 * ★ ═══════════════════════════════════════════════════════════════════════════
 *   **이 수가 레이트리밋 창과 분리된 이유** (2026-10-13)
 *   ═══════════════════════════════════════════════════════════════════════════
 * 예전에는 이 조회에 `created_at >= now-60s` 가 걸려 있었고, **레이트리밋과 직전 답장
 * digest 가 그 한 창을 같이 썼다.** 레이트리밋에는 맞는 창이지만 도배 방지에는 전혀
 * 맞지 않는다 — `differentiate()` 가 막으려는 것은 **봇이 직전과 똑같은 문자열을 또
 * 내보내는 것**이고, 거기에는 60초라는 경계가 없다. 그래서 같은 명령을 1분 넘겨 다시
 * 치면 `previousReplyDigest` 가 `null` 로 떨어지고, 글자 하나까지 같은 답장이 그대로
 * 나가 **런너/카톡 쪽 도배 방지에 먹혔다**(사용자 눈에는 "봇이 반응을 안 한다").
 *
 * 실측(`bot_command_log` 550건, 2026-08-19~10-12): 같은 사람이 같은 명령을 연달아 친
 * 178건 중 **60초 안 52건은 전부 digest 가 갈렸고**(방어가 돌았다), **60초 넘은 126건
 * 중 32건이 직전과 완전히 같은 digest** 였다 — `!결정석` 12 · `!숙제` 10 ·
 * `!!환산`(고정 문구인 오타 제안) 5 · 그 밖 5. 발주 신고에 등장한 바로 그 두 명령이다.
 *
 * 그래서 창을 **행 수**로 바꿨다. 레이트리밋은 아래에서 `created_at` 을 직접 보고
 * 세므로 판정이 전과 같고, digest 는 나이와 무관하게 **바로 앞 답장**을 본다.
 *
 * ⚠️ 왕복을 늘리지 않는 것이 조건이었다. 응답 시간이 이 신고의 다른 절반이기 때문이다
 *    (런너 예산 3초 — `scripts/OpenchatbotR.js` `COMMAND_TIMEOUT`). 그래서 조회를
 *    쪼개지 않고 한 번에 읽는다. `bot_command_log_sender_idx`
 *    (`sender_id, created_at desc`)가 있으므로 `limit` 에서 멈춘다.
 * ⚠️ 18줄이면 레이트리밋 판정에 충분하다 — 한도가 6이라 창 안에 7줄만 보이면 초과가
 *    확정되고, 그 7줄은 언제나 이 18줄 안에 있다(최신순이므로).
 */
const RECENT_SCAN_ROWS = SENDER_LIMIT_PER_MINUTE * 3;

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
 *   - 발신자 한도 초과 → `bot_rate_limited` (429)
 *
 * ★ 한도 초과여도 **행은 남는다.** 남기지 않으면 초과분이 카운트에서 빠져 다음 요청이
 *   다시 통과하고, 한도가 사실상 두 배가 된다.
 */
export async function claimCommand(
  db: AdminDb,
  input: {
    readonly nonce: string;
    readonly senderId: string;
    readonly command: string;
  },
  now: Date,
): Promise<ClaimedCommand> {
  const inserted = await db
    .from("bot_command_log")
    .insert({
      // 방 개념이 없다. 과거 행과 섞이지 않게 **언제나 null** 이다.
      channel_id: null,
      nonce: input.nonce,
      sender_id: input.senderId,
      command: input.command,
    })
    .select("id")
    .maybeSingle();

  if (inserted.error !== null) {
    if (inserted.error.code === UNIQUE_VIOLATION) {
      /*
        ★ ═══════════════════════════════════════════════════════════════════════
          **리플레이는 DB 에 행을 남길 수 없다 — 그래서 플랫폼 로그에 남긴다** (2026-10-13)
          ═══════════════════════════════════════════════════════════════════════
        막아 주는 장치가 **nonce 유니크 인덱스 그 자체**이므로, 거절된 요청은 정의상
        행을 만들 수 없다(이미 있는 행은 **첫 번째** 요청의 것이다). 즉
        `bot_command_log` 에 409 가 0건인 것은 "리플레이가 없었다"는 증거가 아니라
        **구조상 셀 수 없다**는 뜻이다. 조사할 때 이것을 모르면 "서버는 아무것도
        막지 않았다"로 읽힌다 — 실제로 그렇게 읽혔다.
        → 한 줄 남긴다. nonce 는 비밀이 아니고(서명 대상이지 키가 아니다) 앞 8자면
          원래 행을 찾기에 충분하다. 닉네임은 남기지 않는다(§R5 와 같은 기준).
      */
      console.warn(
        `[bot] 거절 409 bot_replay nonce=${input.nonce.slice(0, 8)}… (같은 nonce 로 두 번 왔습니다)`,
      );
      throw ApiError.botReplay();
    }
    console.error(`[bot] 명령 로그 적재 실패: ${inserted.error.message}`);
    throw ApiError.internal();
  }
  if (inserted.data === null) {
    console.error("[bot] 명령 로그 적재가 행을 돌려주지 않았습니다.");
    throw ApiError.internal();
  }
  const logId = inserted.data.id;

  const recent = unwrap(
    await db
      .from("bot_command_log")
      .select("id,result,created_at")
      .eq("sender_id", input.senderId)
      /*
        ⚠️ **시각 필터를 걸지 않는다.** 한 조회가 두 가지(레이트리밋·직전 답장 digest)에
           쓰이고 두 쪽이 요구하는 창이 다르다 — 위 `RECENT_SCAN_ROWS` 주석이 근거다.
           레이트리밋 창은 아래에서 `created_at` 으로 직접 자른다.
      */
      .order("created_at", { ascending: false })
      .limit(RECENT_SCAN_ROWS),
    "최근 명령 조회",
  );

  const windowStart = now.getTime() - RATE_WINDOW_SECONDS * 1000;
  const inWindow = recent.filter(
    (row) => Date.parse(row.created_at) >= windowStart,
  );
  if (inWindow.length > SENDER_LIMIT_PER_MINUTE) {
    /*
      ★ ═══════════════════════════════════════════════════════════════════════
        **거절도 상태 코드를 남긴다** (2026-10-13)
        ═══════════════════════════════════════════════════════════════════════
      행은 전부터 남았지만 `status_code` 가 **null 로 남았다** — 라우트의
      `finalizeCommandLog` 까지 가지 못하고 여기서 던졌기 때문이다. 그래서
      "거절된 요청이 있었는가"를 `status_code = 429` 로 세면 **언제나 0 이 나왔고**,
      실제로 이 신고를 조사하면서 "서버는 아무것도 막지 않았다"는 잘못된 전제가
      거기서 나왔다. 실제로는 2026-10-04 11:05 에 `kakao:죠린` 이 60초에 7번째
      명령을 쳐서 막혔고, 그 행의 `status_code` 는 null 이었다.
      ⚠️ 한도 초과여도 **행은 그대로 남긴다**(아래 원래 주석). 지우면 초과분이
         카운트에서 빠져 한도가 사실상 두 배가 된다.
    */
    await finalizeCommandLog(db, logId, {
      result: "err:bot_rate_limited",
      statusCode: 429,
      durationMs: 0,
    });
    throw ApiError.botRateLimited();
  }

  /*
    직전 답장 digest — 방금 넣은 우리 행(아직 result 가 null)은 건너뛴다.
    `result` 는 `ok:<명령>#<digest8>` 또는 `err:<kind>` 형태다.

    ★ **나이를 보지 않는다**(2026-10-13). 여기서 찾는 것은 "이 발신자에게 **마지막으로**
      보낸 답장"이고, 그것이 1분 전인지 어제인지는 도배 방지와 아무 상관이 없다.
      근거와 실측은 위 `RECENT_SCAN_ROWS` 주석에 있다.
  */
  const previous = recent.find(
    (row) => row.id !== logId && typeof row.result === "string" && row.result.includes("#"),
  );
  const previousReplyDigest = previous?.result?.split("#")[1] ?? null;

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
