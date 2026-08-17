/**
 * 인증/프록시 엔드포인트의 **계약**. 서버와 클라이언트가 같은 파일을 본다.
 *
 * 타입만 있으므로 클라이언트 번들에 안전하게 들어간다.
 * (서버 구현은 `./server/*`, 클라이언트 호출은 `./data/*`.)
 */

import type { NexonErrorKind } from "@/lib/nexon/errors";

/**
 * 우리 API 가 돌려주는 실패 종류.
 *
 * 넥슨 쪽 실패(`NexonErrorKind`)를 그대로 포함한다 — 사용자 입장에서 "키가 틀렸다"는
 * 넥슨이 말했든 우리가 말했든 같은 사건이기 때문이다. 여기에 **우리만 아는** 실패를 더한다.
 */
export type ApiErrorKind =
  | NexonErrorKind
  /** 세션이 없다. 로그인 후 다시 시도해야 한다. */
  | "unauthenticated"
  /**
   * 이 키는 **이미 다른 계정**에 묶여 있다.
   * 조용히 소유자를 바꾸면 계정 탈취가 되므로 거부한다(CLAUDE.md §2.1).
   */
  | "key_owned_by_other_account"
  /** 계정이 정지/삭제 상태다. */
  | "account_unavailable"
  /** 요청 본문이 잘못됐다. */
  | "bad_request"
  /** 우리 쪽 오류. */
  | "internal";

export interface ApiErrorBody {
  readonly error: {
    readonly kind: ApiErrorKind;
    /** 넥슨 원본 코드가 있을 때만. 진단용이며 화면이 분기에 쓰지 않는다. */
    readonly code: string | null;
    readonly message: string;
  };
}

/**
 * 등록된 API 키 1개의 요약. **해시도 원문도 나가지 않는다.**
 *
 * ⚠️ **마스킹된 키가 여기 없는 것은 의도다.** 서버는 원문 키를 저장하지 않으므로
 *    (§2.1.1) 마스킹 문자열조차 만들 수 없다. 화면에 보이는 마스킹은 **브라우저가
 *    자기 localStorage 에 남겨 둔 마스킹 스냅샷**이며, 그 매핑은
 *    `features/auth/lib/api-key.ts` 가 담당한다. 다른 기기에서 등록한 키는
 *    마스킹이 없는 것이 정상 상태다.
 */
export interface CredentialSummary {
  readonly id: string;
  /** 사용자가 붙인 이름(부계정 구분용). */
  readonly label: string | null;
  /** 본캐가 속한 계정의 키인가. **로그인 자격과는 무관하다**(§2.1). */
  readonly isPrimary: boolean;
  readonly isInvalidated: boolean;
  readonly lastValidatedAt: string | null;
  /**
   * 이 키로 확인된 넥슨 계정 수(`credential_nexon_accounts`).
   * 키 ↔ 계정은 M:N 이라 1이 아닐 수 있다.
   */
  readonly nexonAccountCount: number;
  /** 그 계정들에 속한 캐릭터 수. "이 키를 지우면 무엇이 사라지는가"를 알려 준다. */
  readonly characterCount: number;
}

/**
 * "지금 누가 보고 있는가"의 정답.
 *
 * 표시 정체성은 **본캐 닉네임**이다(§2.1). 키도 내부 id 도 화면에 나오지 않는다.
 */
export interface SessionUser {
  readonly id: string;
  readonly displayName: string;
  readonly mainCharacterName: string | null;
  readonly mainWorldName: string | null;
  readonly status: "active" | "suspended" | "deleted";
  readonly credentials: readonly CredentialSummary[];
  /** 등록된 캐릭터 수. */
  readonly characterCount: number;
  /** 그중 실제로 동기화하는 캐릭터 수(`is_tracked`). 옵트인이라 처음엔 0이다. */
  readonly trackedCharacterCount: number;
}

/** `GET /api/auth/me` — **비로그인도 200 이다.** `user: null` 로 답한다. */
export interface MeResponse {
  readonly user: SessionUser | null;
}

export interface LoginRequest {
  readonly apiKey: string;
  /** 신규 가입 시 주 키에 붙일 이름. 생략하면 null. */
  readonly label?: string;
}

export interface LoginResponse {
  readonly user: SessionUser;
  readonly credentialId: string;
  /** 이번 호출로 계정이 새로 만들어졌는가. 화면이 캐릭터 선택 모달을 띄울지 정한다. */
  readonly isNewAccount: boolean;
  /** 이 키가 실제로 소유한 캐릭터. 이 목록이 곧 소유 증명이다. */
  readonly characters: readonly LoginCharacter[];
}

/** 로그인 응답에 실리는 캐릭터. 캐릭터 선택 모달이 그대로 쓴다. */
export interface LoginCharacter {
  /** 우리 `characters.id`(UUID PK). ocid 는 가변이라 PK 로 쓰지 않는다. */
  readonly id: string;
  readonly ocid: string;
  readonly characterName: string;
  readonly worldName: string | null;
  readonly characterClass: string | null;
  readonly characterLevel: number | null;
  readonly isMain: boolean;
  readonly isTracked: boolean;
}

export interface AddCredentialRequest {
  readonly apiKey: string;
  readonly label?: string;
}

export interface AddCredentialResponse {
  readonly user: SessionUser;
  readonly credentialId: string;
  readonly characters: readonly LoginCharacter[];
}

export interface LogoutResponse {
  readonly ok: true;
}

/** `GET /api/nexon/quota` — 우리 장부 그대로. 넥슨에는 잔여량 헤더가 없다. */
export interface QuotaResponse {
  readonly dayKey: string;
  readonly credentials: readonly {
    readonly credentialId: string;
    readonly label: string | null;
    readonly callCount: number;
    readonly errorCount: number;
    readonly throttledCount: number;
    readonly devBudgetRemaining: number;
    readonly nearDevBudget: boolean;
  }[];
}
