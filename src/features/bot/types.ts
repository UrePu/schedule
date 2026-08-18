/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 봇 연동의 **계약** — 서버와 브라우저가 같은 파일을 본다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ⚠️ **런너 비종속(CLAUDE.md §2.2 · research-KAKAO-BOT §3.6).**
 *    이 파일에는 카카오톡을 아는 이름이 하나도 없어야 한다. `room` 은 **우리가 발급한
 *    불투명 ID** 이고, 실제 방(카톡 방 이름 · chat_id · 텔레그램 chat id …)과의 매핑은
 *    **런너가 자기 로컬에 보관한다.** 그 한 줄 덕분에 런너를 갈아 끼워도 서버는 0줄
 *    바뀌지 않는다.
 *
 * ⚠️ **우리는 서버만 만든다.** 러너 코드·스크립트·설치 안내는 이 저장소에 존재하지
 *    않으며 앞으로도 넣지 않는다(카카오 운영정책상 봇 프로그램의 개발·유포 금지 조항).
 *    여기 적힌 것은 "이 계약을 만족하는 클라이언트가 붙을 수 있다"는 사실뿐이다.
 *
 * 타입만 있으므로 클라이언트 번들에 안전하게 들어간다.
 */

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/bot/command
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 명령 요청 본문.
 *
 * ★ `signature` · `nonce` · `timestamp` 가 **헤더가 아니라 본문 필드**인 것은 의도다.
 *   클라이언트에 따라 커스텀 헤더를 붙이지 못하는 경우가 있어, 가장 낮은 공통분모를
 *   기준으로 잡았다(research-KAKAO-BOT §3.4). 다른 엔드포인트는 헤더를 쓴다.
 */
export interface BotCommandRequest {
  /** 우리가 발급한 불투명 채널 ID (`ch_...`). */
  readonly room: string;
  readonly sender: {
    /** 클라이언트가 고른 **안정적 발신자 식별자**(불투명). 서버는 의미를 해석하지 않는다. */
    readonly id: string;
    /** 표시용 닉네임. **식별에 쓰지 않는다** — 닉네임은 언제든 바뀐다. */
    readonly name: string;
  };
  /** 원문 메시지. `!` 로 시작하는 것만 보낸다(프라이버시 — 일반 대화는 서버에 오지 않는다). */
  readonly message: string;
  /** Unix epoch **초**. */
  readonly timestamp: number;
  /** `v1=` + HMAC-SHA256 hex. */
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
// POST /api/bot/pair — 방 최초 연결 (부트스트랩 구간이라 **여기만 무서명**)
// ─────────────────────────────────────────────────────────────────────────────

export interface BotPairRequest {
  /** 웹에서 발급받은 6자리 코드. */
  readonly code: string;
  /** 클라이언트 식별 문자열. **로그·통계 전용이며 분기 로직에 쓰지 않는다**(§3.6). */
  readonly runner?: string;
  /** 클라이언트가 계산한 방 지문 해시(64 hex). **방 이름 원문은 보내지 않는다.** */
  readonly roomFingerprint?: string;
}

export interface BotPairResponse {
  readonly room: string;
  /** ⚠️ 원문 시크릿은 **이 응답에서 단 한 번만** 나온다. 서버는 해시만 보관한다. */
  readonly secret: string;
  readonly pollIntervalSec: number;
}

/** 시크릿 회전. 서명이 필요하다. 구 시크릿은 24시간 병행 검증된다. */
export interface BotRotateResponse {
  readonly room: string;
  readonly secret: string;
  /** 구 시크릿이 죽는 시각(ISO). */
  readonly previousSecretExpiresAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/bot/outbox · POST /api/bot/outbox/ack — 선제 알림(부)
// ─────────────────────────────────────────────────────────────────────────────

export interface BotOutboxMessage {
  readonly id: string;
  /**
   * 필드명을 명령 응답과 **일부러 같게** 맞췄다. 클라이언트는 "어디서 왔든 `reply`
   * 문자열을 방에 뿌린다"는 규칙 하나만 구현하면 된다.
   */
  readonly reply: string;
  readonly extra?: readonly string[];
  /** epoch 초. 지난 알림은 가치가 음수라 클라이언트도 버려야 한다. */
  readonly expiresAt: number;
}

export interface BotOutboxResponse {
  readonly serverTime: number;
  readonly messages: readonly BotOutboxMessage[];
  /**
   * 다음 폴링까지 쉬어야 할 초. **서버는 롱폴링(`wait`)을 지원하지 않으므로** 이 값이
   * 없으면 클라이언트가 빈 응답을 받고 즉시 다시 부르는 열린 루프가 된다.
   */
  readonly pollIntervalSec: number;
}

/** ack 결과 한 건. `error` 는 진단용이며 서버는 재시도 여부 판정에만 쓴다. */
export interface BotOutboxAckResult {
  readonly id: string;
  readonly status: "sent" | "failed";
  readonly error?: string;
}

export interface BotOutboxAckRequest {
  readonly room: string;
  readonly results: readonly BotOutboxAckResult[];
}

export interface BotOutboxAckResponse {
  /** 상태가 실제로 바뀐 건수. 이미 `sent` 인 id 를 다시 ack 하면 0 이다(멱등). */
  readonly applied: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// 웹(세션 인증) — 코드 발급 · 내 방 목록 · 파티 바인딩
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `channel_pair` = 방 하나를 우리 서버에 처음 붙일 때.
 * `member_link`  = 방에서 `!연결 <코드>` 로 **내가 나임을 밝힐 때**.
 */
export type BotLinkCodeKind = "channel_pair" | "member_link";

export interface BotLinkCode {
  readonly kind: BotLinkCodeKind;
  /** ⚠️ 원문 코드는 **발급 응답에만** 존재한다. 서버는 SHA-256 해시만 갖는다. */
  readonly code: string;
  /** ISO. 기본 10분. */
  readonly expiresAt: string;
}

export interface BotChannelSummary {
  /** 내부 uuid 가 아니라 `bot_channels.room`. 내가 **페어링한** 방에만 실려 온다. */
  readonly room: string | null;
  readonly channelId: string;
  readonly platform: string;
  readonly status: "active" | "degraded" | "paused";
  /** 내가 이 방을 페어링한 사람인가. */
  readonly owner: boolean;
  /** 내 계정이 이 방에서 `!연결` 로 확인되었는가. */
  readonly linked: boolean;
  /** 방에서 나를 부르는 이름(표시용 스냅샷). */
  readonly displayName: string | null;
  readonly linkedAt: string | null;
}

export interface BotBoundParty {
  readonly partyId: string;
  readonly name: string;
  /** 이 파티의 알림이 갈 방. `null` = 웹 전용 파티(푸시 없음)이며 **정상 상태**다. */
  readonly channelId: string | null;
}

export interface BotSetupState {
  readonly channels: readonly BotChannelSummary[];
  readonly parties: readonly BotBoundParty[];
}
