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
  /**
   * 보낸 키가 **그 캐릭터가 속한 넥슨 계정의 키가 아니다.**
   *
   * 넥슨도 이 요청을 거절하지만(`OPENAPI00004`, §1.0 실측) **그 거절은 우리 호출량을
   * 태운 뒤에** 온다. 그래서 우리 DB 에서 먼저 끊고, 사용자에게는 "캐릭터명이나 날짜를
   * 확인하라"는 **사실이 아닌** 안내 대신 "그 계정의 키를 넣어라"라고 말한다.
   *
   * 그 캐릭터 하나의 문제이므로 자동 동기화는 **중단하지 않고 건너뛴다**
   * (`scheduler-freshness.ts` 의 `shouldAbortAutoSync`).
   */
  | "credential_mismatch"
  /**
   * 그 자격증명의 **원문 키가 서버에 보관돼 있지 않다** (§2.1.2).
   *
   * `credential_mismatch`("보낸 키가 그 계정 것이 아니다")와 원인도 조치도 다르다.
   * 여기서 필요한 것은 "맞는 키를 보내라"가 아니라 **"그 계정 키를 한 번 입력해 두라"**
   * 이며, 한 번 입력하면 이후로는 어느 브라우저에서든 서버가 알아서 부른다.
   *
   * 그 자격증명 하나의 문제이므로 자동 동기화는 **중단하지 않고 건너뛴다.**
   */
  | "server_key_missing"
  /**
   * **마지막 남은 키는 지울 수 없다.**
   *
   * 로그인은 `sha256(키)` → `user_credentials.api_key_hash` → `app_users` 한 경로뿐이다
   * (§2.1). 그래서 키를 전부 지우면 **그 계정으로 다시 들어갈 문이 사라진다** — 캐릭터도
   * 파티도 수익 기록도 DB 에 그대로 남은 채로. 되돌릴 방법이 없으므로 취향이 아니라
   * 안전장치이고, 화면이 아니라 **서버가** 막는다.
   */
  | "last_credential"
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
 * ⚠️ **마스킹된 키가 여기 없는 것은 의도다.** 서버는 원문 키를 AEAD 로 암호화해
 *    보관하지만(§2.1.2) 그것을 **응답에 실어 내보내지는 않는다** — 마스킹조차 보내지
 *    않는 이유는, 보내는 순간 XSS 하나가 "어느 키인지"를 훔쳐 갈 표면이 되고 화면에는
 *    아무 이득이 없기 때문이다. 화면에 보이는 마스킹은 **그 키를 실제로 입력한
 *    브라우저**가 localStorage 에 남긴 원문에서 파생하며, 그 매핑은
 *    `features/auth/lib/api-key.ts` 가 담당한다. 다른 기기에서 등록한 키는 마스킹이
 *    없는 것이 정상 상태이고, `hasServerKey` 가 그때도 동기화가 된다고 말해 준다.
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
   * **서버가 이 키를 대신 부를 수 있는가**(`allow_server_side_use`, §2.1.2).
   *
   * `true` 면 이 브라우저에 원문이 없어도 그 계정 캐릭터가 동기화된다 — 화면이 "이
   * 브라우저에 키 없음"을 **경고로 그리면 안 되는** 유일한 판정 근거다.
   * `false` 는 오류가 아니라 "아직 서버에 올리지 않았다"이며, 그 키를 한 번 입력하면 된다.
   */
  readonly hasServerKey: boolean;
  /**
   * 이 키로 확인된 넥슨 계정 수(`credential_nexon_accounts`).
   * 키 ↔ 계정은 M:N 이라 1이 아닐 수 있다.
   */
  readonly nexonAccountCount: number;
  /** 그 계정들에 속한 캐릭터 수. "이 키를 지우면 무엇이 사라지는가"를 알려 준다. */
  readonly characterCount: number;
  /**
   * 이 키를 지우면 **동기화가 멈추는** 넥슨 계정 수.
   *
   * `nexonAccountCount` 와 다르다. 같은 계정에 다른 유효한 키가 하나라도 더 붙어 있으면
   * 이 키가 사라져도 그 계정은 계속 동기화된다(`character_is_syncable`). 그러니 "연결된
   * 계정 수"를 삭제 영향으로 보여 주면 **없는 피해를 과장**하게 된다. 여기 담기는 것은
   * 정확히 "이 키가 마지막 유효 키인 계정"의 수다.
   */
  readonly strandedAccountCount: number;
  /**
   * 그 계정들에 속한 캐릭터 수 = **삭제 확인 화면이 보여 줘야 할 숫자**.
   *
   * 되돌릴 수 없는 동작 앞에서 "정말요?"만 묻는 것은 확인이 아니다. 사용자가 판단하려면
   * "무엇이 얼마나 멈추는가"를 숫자로 봐야 한다. 캐릭터 행과 클리어 기록은 **지워지지
   * 않으므로**(캐릭터는 키가 아니라 넥슨 계정을 가리킨다) 이 수는 "사라지는 캐릭터"가
   * 아니라 "동기화가 멈추는 캐릭터"다. 문구도 그렇게 써야 한다.
   */
  readonly strandedCharacterCount: number;
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

/**
 * `DELETE /api/auth/credentials/{credentialId}` — 등록된 키 1개 삭제.
 *
 * 응답이 **바뀐 뒤의 사용자 전체**인 것은 다른 쓰기 API 와 같은 규약이다(부분 갱신을
 * 화면이 조립하지 않게 한다). 여기서는 그 규약이 특히 중요하다 — 삭제 한 번으로
 * 키 목록·캐릭터 수·주 키 위치가 **함께** 바뀌기 때문이다.
 */
export interface DeleteCredentialResponse {
  readonly user: SessionUser;
  /** 방금 지운 키. 브라우저가 localStorage 에서 같은 id 를 지우는 데 쓴다. */
  readonly deletedCredentialId: string;
  /**
   * 주 키가 옮겨 갔다면 그 대상. 옮길 일이 없었으면 `null`.
   *
   * ⚠️ **로그인 자격과는 무관하다**(§2.1 — 어느 연결 키로도 같은 사람으로 들어온다).
   *    옮겨 가는 것은 "표시 정체성의 출처"뿐이다.
   */
  readonly promotedCredentialId: string | null;
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
