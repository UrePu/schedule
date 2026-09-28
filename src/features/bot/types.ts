/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 봇 연동의 **계약** — 서버와 브라우저가 같은 파일을 본다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ **런너 비종속(CLAUDE.md §2.2 · research-KAKAO-BOT §3.6).**
 *    이 파일에는 카카오톡을 아는 이름이 하나도 없어야 한다. 유일한 예외가
 *    `DEFAULT_BOT_PLATFORM` 이고, 그것은 **값을 안 보내는 클라이언트의 기본값**일 뿐
 *    분기 로직이 아니다(`bot_channels.platform` 이 이미 같은 방식이었다).
 *
 * ⚠️ **우리는 서버만 만든다.** 러너 코드·스크립트·설치 안내는 이 저장소에 존재하지
 *    않으며 앞으로도 넣지 않는다(카카오 운영정책상 봇 프로그램의 개발·유포 금지 조항).
 *    여기 적힌 것은 "이 계약을 만족하는 클라이언트가 붙을 수 있다"는 사실뿐이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ 2026-09-28: **방(채널) 개념이 계약에서 사라졌다** ★★
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지시: *"카톡의 방의 개념을 삭제. 닉네임으로 판별하여 연결하는거만 가능
 * !연결 ~~ 만 남기기. !페어링 필요 x. 그거에따른 리마인더 삭제. 알림 삭제."*
 *
 * 근거는 실측이다. 카톡 런너가 방을 가리켜 주는 값은 **방 이름 문자열**뿐이고
 * (API1·API2 양쪽 메시지 객체에 방 고유 번호가 없다), 실기 폰에서는 그 자리에 **말한
 * 사람의 닉네임**이 실려 왔다. 즉 방을 안정적으로 식별할 방법이 원리적으로 없다.
 * 그래서 방을 포기하고, 신원의 축을 **`(platform, sender.id)`** 로 내린다.
 *
 * 사라진 것: `BotPairRequest` · `BotPairResponse` · `BotRotateResponse` ·
 * `BotOutbox*` · `BotCommandRequest.room` · `BotLinkCodeKind` 의 방 종류 둘.
 * 남은 것: **명령 → 답장** 하나뿐이다. 봇이 먼저 말을 거는 경로는 없다.
 *
 * 타입만 있으므로 클라이언트 번들에 안전하게 들어간다.
 */

/**
 * `platform` 을 안 보내는 클라이언트의 기본값.
 *
 * 신원의 유일성이 `(platform, sender_id)` 라서 이 값이 필요하다 — 텔레그램 런너가 붙는 날
 * `kakao:더저` 와 `telegram:더저` 가 같은 사람으로 취급되면 안 된다. 런너는 자기 값을
 * **명시해서 보내는 편이 옳고**, 이 기본값은 옛 클라이언트를 위한 자리다.
 */
export const DEFAULT_BOT_PLATFORM = "kakao";

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bot/command — **이제 봇 API 의 전부다**
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 명령 요청 본문.
 *
 * ★ `signature` · `nonce` · `timestamp` 가 **헤더가 아니라 본문 필드**인 것은 의도다.
 *   클라이언트에 따라 커스텀 헤더를 붙이지 못하는 경우가 있어, 가장 낮은 공통분모를
 *   기준으로 잡았다(research-KAKAO-BOT §3.4).
 *
 * ★ **서명은 남는다.** 방이 없어졌으니 인증은 설치 토큰(`BOT_RUNNER_TOKEN`) 하나인데,
 *   토큰만 확인하고 서명을 없애면 **캡처 한 번이 영구 유효해진다.** 토큰은 키이고
 *   서명은 그 키로 "이 요청 하나"를 묶는 장치라, 둘은 서로를 대신하지 못한다.
 */
export interface BotCommandRequest {
  /**
   * 메신저 종류. 생략하면 `DEFAULT_BOT_PLATFORM`.
   * **서명 대상에 포함된다** — 보낼 때와 안 보낼 때 서명이 달라지므로 한쪽으로 정해서 쓴다.
   */
  readonly platform?: string;
  readonly sender: {
    /**
     * 클라이언트가 고른 **안정적 발신자 식별자**(불투명). 서버는 뜻을 해석하지 않는다.
     *
     * ⚠️ 카톡에서는 이것이 사실상 **닉네임**이다(`kakao:<닉네임>`). 그래서 `!연결` 에
     *    **선점 규칙**이 있다 — 이미 다른 계정에 물려 있는 발신자는 거부한다.
     * ⚠️ **선점 규칙이 막는 것은 연결(쓰기)뿐이고, 사칭(읽기)은 막지 못한다.** 피해자와
     *    같은 닉네임으로 이름을 바꾸면 `resolveMember` 가 피해자 계정으로 해석하므로
     *    오픈챗에서 남의 닉네임을 그대로 쓰는 것만으로 그 사람 데이터가 읽힌다. 런너가
     *    안정적 발신자 id 를 주지 않는 한 고칠 수단이 없다 — 근거와 범위는
     *    `server/link.ts` 머리말에 적어 두었다. **여기에 방어가 있다고 적지 마라.**
     */
    readonly id: string;
    /** 표시용 닉네임. **식별에 쓰지 않는다** — 표시 스냅샷일 뿐이다. */
    readonly name: string;
  };
  /** 원문 메시지. `!` 로 시작하는 것만 보낸다(프라이버시 — 일반 대화는 서버에 오지 않는다). */
  readonly message: string;
  /** Unix epoch **초**. */
  readonly timestamp: number;
  /** `v1=` + HMAC-SHA256 hex. 키는 `BOT_RUNNER_TOKEN`. */
  readonly signature: string;
  /** 요청마다 유일. 재사용은 409. */
  readonly nonce: string;
}

/**
 * 명령 응답.
 *
 * `reply` 는 **카카오톡 평문 문자열 하나**다. 마크다운·HTML 금지.
 * `null` 이면 클라이언트는 **아무것도 보내지 않는다**(미인식 명령 · 레이트리밋 드롭).
 * `extra` 는 무시해도 동작하는 선택 필드 — 하위호환을 깨지 않는 유일한 확장 방식이다.
 */
export interface BotCommandResponse {
  readonly reply: string | null;
  readonly extra?: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// 웹(세션 인증) — 연결 코드 발급 · 내 신원 목록
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 연결 코드 종류.
 *
 * ★ **한 가지만 남았다**(2026-09-28). 예전에는 `channel_pair`(파티방 붙이기) ·
 *   `direct_pair`(개인톡 붙이기)가 있었고 그것들이 `!페어링` 의 재료였다. 방 개념이
 *   사라지면서 둘 다 발급할 이유가 없어졌다.
 * ⚠️ DB 의 `bot_link_code_kind` enum 에는 그 값들이 **그대로 남아 있다**(과거 행의
 *    기록이다). 발급·소모 경로만 `member_link` 로 좁혔다.
 */
export type BotLinkCodeKind = "member_link";

export interface BotLinkCode {
  readonly kind: BotLinkCodeKind;
  /** ⚠️ 원문 코드는 **발급 응답에만** 존재한다. 서버는 SHA-256 해시만 갖는다. */
  readonly code: string;
  /** ISO. 기본 10분. */
  readonly expiresAt: string;
}

/**
 * `!연결` 로 맺어진 내 신원 하나.
 *
 * 방이 아니라 **발신자**다. 한 사람이 여러 메신저·여러 닉네임으로 연결할 수 있으므로
 * 목록이다(같은 닉네임을 두 계정이 나눠 가질 수는 없다 — 선점 규칙).
 */
export interface BotIdentitySummary {
  readonly identityId: string;
  readonly platform: string;
  /** 방에서 나를 부르는 이름(표시용 스냅샷). */
  readonly displayName: string | null;
  /**
   * 언제나 `true`.
   *
   * ⚠️ **왜 항상 참인 칸을 남겼는가.** `features/guide` 의 설정 안내 화면이
   *    `channels.filter((c) => c.linked)` 로 "연결 끝난 단계"를 판정한다. 그 화면은 지금
   *    다른 작업 단위가 들고 있어 이번에 손댈 수 없으므로, **필드를 유지해 컴파일과
   *    화면 판정을 동시에 지킨다.** 예전에는 "방은 붙었지만 계정은 안 붙은" 상태가 있어
   *    이 칸이 의미를 가졌고, 지금은 행이 있다는 것 자체가 곧 연결이다.
   *    → 정리 대상: 가이드 화면이 자유로워지면 이 칸과 아래 `channels` 이름을 함께 없앤다.
   */
  readonly linked: true;
  readonly linkedAt: string | null;
  readonly lastSeenAt: string | null;
}

/** 내 파티 한 줄. 알림이 사라졌으므로 **목적지 칸이 없다.** */
export interface BotBoundParty {
  readonly partyId: string;
  readonly name: string;
}

export interface BotSetupState {
  /**
   * 내 봇 신원 목록.
   *
   * ⚠️ 이름이 `identities` 가 아니라 `channels` 인 것은 **호환 때문이다** — 위
   *    `BotIdentitySummary.linked` 주석과 같은 이유(`features/guide` 소유권).
   *    내용은 방이 아니라 신원이다.
   */
  readonly channels: readonly BotIdentitySummary[];
  readonly parties: readonly BotBoundParty[];
}
