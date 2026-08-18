/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 동기화 실패 → **원인과 조치가 함께 들어 있는 한 문장**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 별도 모듈인가 — 예전 문구가 **사실이 아니었다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 실계정에서 이 문장이 떴다:
 *
 *   `자동 갱신을 마치지 못했습니다 — 넥슨 API 가 요청을 거절했습니다.
 *    캐릭터명이나 조회 날짜를 확인해 주세요.`
 *
 * 캐릭터명도 조회 날짜도 멀쩡했다. 진짜 원인은 **그 캐릭터가 속한 넥슨 계정의 키가 이
 * 브라우저에 없다**는 것이었고, 사용자에게 캐릭터명이나 날짜를 고칠 수단은 애초에 없다.
 * 게다가 "확인해 주세요"는 **행동을 지시하지 않는다** — 무엇을 어디서 확인하는지가 없다.
 *
 * 그래서 이 모듈은 실패를 **원인(cause) + 조치(action)** 두 조각으로 낸다. 화면은 두
 * 조각을 이어 붙이기만 하고, 문구를 스스로 만들지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 분기 근거는 **§1.0 실측**이다. 추측하지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * | 원인                              | 넥슨 코드      | 우리 kind             |
 * |-----------------------------------|----------------|-----------------------|
 * | 이 브라우저에 그 계정 키가 없음   | (호출 안 함)   | `missing_key`         |
 * | 그 계정 키가 아님(남의 계정 ocid) | (호출 전 차단) | `credential_mismatch` |
 * | 무효한 키                         | OPENAPI00005   | `invalid_key`         |
 * | 할당량 초과                       | OPENAPI00007   | `quota_exceeded`      |
 * | 파라미터 거절 / 남의 계정 ocid    | OPENAPI00004   | `invalid_parameter`   |
 * | 낡은 ocid                         | OPENAPI00003   | `invalid_id`          |
 * | 접근 불가 경로                    | OPENAPI00002   | `forbidden`           |
 * | 넥슨 장애(5xx) / 응답 형식 변화   | -              | `upstream`            |
 * | 응답 자체를 못 받음               | -              | `network`             |
 *
 * `missing_key` 와 `credential_mismatch` 는 **넥슨을 부르지 않는다.** 부르면 거절과
 * 함께 호출량만 태우기 때문이며, 그 차단이 이번 수정의 절반이다.
 */

/** 화면이 분기할 수 있는 실패의 종류. 서버의 `ApiErrorKind` 를 사용자 관점으로 좁힌 것. */
export type SyncFailureKind =
  /**
   * 그 캐릭터가 속한 계정의 키를 **어디에서도 찾지 못했다** — 서버에도, 이 브라우저에도.
   * 실패가 아니라 상태에 가깝다.
   */
  | "missing_key"
  /**
   * 그 계정 키가 **서버에 저장돼 있지 않다**(§2.1.2). 서버가 판정해 돌려준 종류다.
   * `missing_key` 와 문구가 다른 이유: 조치가 "이 브라우저에 넣어라"가 아니라
   * **"한 번 입력해 서버에 올려라"** 이고, 한 번 하면 모든 기기에서 끝난다.
   */
  | "server_key_missing"
  /** 보낸 키가 그 캐릭터의 계정 키가 아니다(서버가 넥슨 호출 전에 차단). */
  | "credential_mismatch"
  | "invalid_key"
  | "quota_exceeded"
  | "invalid_parameter"
  | "invalid_id"
  | "forbidden"
  | "network"
  | "upstream"
  | "unauthenticated"
  | "unknown";

export interface SyncFailureNotice {
  readonly kind: SyncFailureKind;
  /** **무슨 일이 일어났는가.** 사용자가 아는 말로, 내부 식별자 없이. */
  readonly cause: string;
  /** **무엇을 하면 되는가.** 명령형 한 문장. 할 일이 없으면 기다리라고 분명히 말한다. */
  readonly action: string;
  /**
   * 사용자가 직접 고칠 수 있는가.
   *
   * `false` 면 화면은 "다시 시도" 버튼을 강조하지 않는다 — 눌러도 같은 실패가 나고
   * 할당량만 더 탄다(§1.1 재시도 폭주 금지).
   */
  readonly userActionable: boolean;
}

/**
 * 키가 없다는 것은 **에러가 아니라 상태**다. 문구도 실패가 아니라 안내로 쓴다.
 *
 * ★ "이 브라우저에 없습니다"라고 말하지 않는다(§2.1.2). 키는 이제 서버가 보관하므로,
 *   이 상태의 실제 의미는 **"그 키를 아직 한 번도 등록하지 않았다"** 이고 조치도 한 번뿐이다.
 *   기기를 지목하면 사용자는 "다른 기기에서는 되나?"라는 틀린 기대를 갖게 된다.
 */
export function describeMissingKey(
  credentialLabel: string | null,
): SyncFailureNotice {
  const named =
    credentialLabel === null || credentialLabel === ""
      ? "이 캐릭터가 속한 넥슨 계정의"
      : `${credentialLabel} 계정의`;
  return {
    kind: "missing_key",
    cause: `${named} API 키가 아직 등록되지 않았습니다.`,
    action:
      "계정 · 키 관리에서 그 키를 한 번 입력하면, 이후에는 어느 기기에서든 자동으로 갱신됩니다.",
    userActionable: true,
  };
}

/** 자격증명 자체가 없어 어느 계정인지도 특정되지 않는 경우. */
export function describeUnlinkedCharacter(): SyncFailureNotice {
  return {
    kind: "missing_key",
    cause:
      "이 캐릭터가 어느 넥슨 계정에서 왔는지 기록이 없어 어떤 키로 불러야 할지 알 수 없습니다.",
    action:
      "계정 · 키 관리에서 그 계정의 API 키를 다시 입력하면 연결이 복구됩니다.",
    userActionable: true,
  };
}

/** 서버가 준 `kind` 를 이 표의 축으로 좁힌다. 모르는 값은 감추지 않고 `unknown` 이다. */
function toFailureKind(kind: string | null | undefined): SyncFailureKind {
  switch (kind) {
    case "server_key_missing":
    case "credential_mismatch":
    case "invalid_key":
    case "quota_exceeded":
    case "invalid_parameter":
    case "invalid_id":
    case "forbidden":
    case "network":
    case "unauthenticated":
      return kind;
    case "upstream_unavailable":
    case "schema_mismatch":
      return "upstream";
    default:
      return "unknown";
  }
}

/**
 * `kind` → 원인·조치.
 *
 * ⚠️ `credential_mismatch` 는 **서버 문구를 그대로 쓴다.** 서버만 캐릭터 이름과
 *    "어느 계정인지"를 알고 있어 더 구체적인 문장을 만들 수 있기 때문이다.
 *    나머지는 여기서 만든다 — 서버 문구는 엔드포인트를 모르는 일반 문구다.
 */
function describeKind(
  kind: SyncFailureKind,
  serverMessage: string,
): SyncFailureNotice {
  switch (kind) {
    case "credential_mismatch":
      return {
        kind,
        cause: serverMessage,
        action: "계정 · 키 관리에서 그 계정의 API 키를 입력해 주세요.",
        userActionable: true,
      };
    case "server_key_missing":
      /*
       * 서버 문구를 그대로 쓴다 — 서버만 캐릭터 이름과 "어느 계정인지"를 알고 있어 더
       * 구체적인 문장을 만들 수 있고, 조치까지 이미 그 문장 안에 들어 있다(§2.1.2).
       */
      return {
        kind,
        cause: serverMessage,
        action:
          "한 번만 입력하면 이후에는 다른 기기에서도 다시 넣을 필요가 없습니다.",
        userActionable: true,
      };
    case "invalid_key":
      return {
        kind,
        cause: "넥슨이 이 API 키를 더 이상 유효하지 않다고 답했습니다.",
        action:
          "openapi.nexon.com 에서 키를 새로 발급받아 계정 · 키 관리에서 교체해 주세요.",
        userActionable: true,
      };
    case "quota_exceeded":
      return {
        kind,
        cause: "오늘 쓸 수 있는 넥슨 API 호출량을 다 썼습니다.",
        // 눌러 봐야 같은 실패다. 기다리는 것이 유일한 조치라고 분명히 말한다.
        action:
          "자동 갱신은 멈춥니다. 지금 새로고침을 눌러도 같은 결과이니 잠시 뒤(한도는 매일 초기화됩니다) 다시 열어 주세요.",
        userActionable: false,
      };
    case "invalid_parameter":
      return {
        kind,
        cause:
          "넥슨이 이 요청을 받아들이지 않았습니다. 이 캐릭터가 다른 넥슨 계정 소속이거나 조회 가능한 기간을 벗어난 요청입니다.",
        action:
          "계정 · 키 관리에서 그 계정의 API 키가 등록돼 있는지 확인하고, 없으면 추가해 주세요.",
        userActionable: true,
      };
    case "invalid_id":
      return {
        kind,
        cause: "저장된 캐릭터 식별자(ocid)가 낡아 넥슨이 알아보지 못했습니다.",
        action:
          "추적 캐릭터 버튼으로 캐릭터 선택을 한 번 열면 목록이 새로 받아지며 복구됩니다.",
        userActionable: true,
      };
    case "forbidden":
      return {
        kind,
        cause: "이 API 키로는 접근할 수 없는 요청입니다.",
        action:
          "넥슨 개발자 센터에서 키의 서비스 권한을 확인하거나 키를 새로 발급해 주세요.",
        userActionable: true,
      };
    case "network":
      return {
        kind,
        cause: "넥슨 API 에 연결하지 못해 응답 자체를 받지 못했습니다.",
        action: "네트워크 연결을 확인한 뒤 새로고침을 눌러 주세요.",
        userActionable: true,
      };
    case "upstream":
      return {
        kind,
        cause: "넥슨 API 가 일시적으로 응답하지 않습니다. 우리 쪽 문제가 아닙니다.",
        action: "잠시 뒤 캐릭터별 새로고침을 눌러 주세요.",
        userActionable: false,
      };
    case "unauthenticated":
      return {
        kind,
        cause: "로그인 세션이 만료됐습니다.",
        action: "API 키로 다시 로그인해 주세요.",
        userActionable: true,
      };
    case "missing_key":
      // 이 경로로는 오지 않는다(키 없음은 요청을 보내기 전에 판정된다).
      return describeMissingKey(null);
    case "unknown":
      return {
        kind,
        // 서버가 준 문구가 그나마 구체적이다. 지어내지 않는다.
        cause: serverMessage,
        action: "잠시 뒤 캐릭터별 새로고침을 눌러 주세요.",
        userActionable: false,
      };
  }
}

interface KindedError {
  readonly kind?: unknown;
  readonly code?: unknown;
}

/**
 * 던져진 에러 → 원인·조치.
 *
 * `BossPlanRequestError`(`kind` 를 들고 다닌다)를 기대하지만, 어떤 값이 와도 문장이
 * 나와야 한다 — 실패 화면이 비어 있는 것이 가장 나쁘다.
 */
export function describeSyncFailure(error: unknown): SyncFailureNotice {
  const serverMessage =
    error instanceof Error && error.message !== ""
      ? error.message
      : "인게임 스케줄러를 불러오지 못했습니다.";

  const rawKind =
    typeof error === "object" && error !== null
      ? (error as KindedError).kind
      : null;

  return describeKind(
    toFailureKind(typeof rawKind === "string" ? rawKind : null),
    serverMessage,
  );
}

/** 화면에 그대로 넣는 한 문장. 원인 다음에 조치가 온다 — 순서가 뒤집히면 읽히지 않는다. */
export function formatSyncFailure(notice: SyncFailureNotice): string {
  return `${notice.cause} ${notice.action}`;
}
