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
 * | 제시간에 답이 안 옴               | -              | `timeout`             |
 * | 우리 서버가 알 수 없게 실패       | -              | `server_error`        |
 *
 * `missing_key` 와 `credential_mismatch` 는 **넥슨을 부르지 않는다.** 부르면 거절과
 * 함께 호출량만 태우기 때문이며, 그 차단이 이번 수정의 절반이다.
 */

import { describeMaintenanceWait } from "@/lib/time/nexon-maintenance";

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
  /** 제시간에 답이 오지 않았다. 브라우저가 기다리기를 멈췄다(`boss-plan-queries.ts`). */
  | "timeout"
  /** 우리 서버가 본문 없이 실패했다(플랫폼 500 같은 것). 넥슨 탓으로 돌릴 근거가 없다. */
  | "server_error"
  | "upstream"
  /**
   * 넥슨 점검 중.
   *
   * `upstream` 과 **반드시 갈라야 한다.** 둘 다 "우리 잘못이 아니다"지만 지속 시간이
   * 자릿수로 다르다 — 장애는 몇 분, 점검은 **몇 시간**이다. 같은 문구를 쓰면
   * *"잠시 뒤 새로고침을 눌러 주세요"* 라고 안내하게 되고, 사용자는 6시간 동안 눌러 보며
   * 실패만 본다.
   */
  | "maintenance"
  /** 넥슨이 데이터를 아직 준비하지 못했다. 서비스는 살아 있다는 점이 점검과 다르다. */
  | "data_not_ready"
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
    case "timeout":
    case "server_error":
    case "maintenance":
    case "data_not_ready":
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
  credentialLabel: string | null,
): SyncFailureNotice {
  /*
    **어느 키인지 말한다.** 한 사람이 넥슨 계정을 여러 개 쓰므로(§2.1) "이 API 키"로는 어느
    것을 고칠지 알 수 없다. 쓰는 것은 사용자가 붙인 **이름**뿐이고 원문·마스킹은 넣지 않는다.
  */
  const namedKey =
    credentialLabel === null || credentialLabel === ""
      ? "이 API 키"
      : `${credentialLabel} 계정의 API 키`;

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
        cause: `넥슨이 ${namedKey}를 더 이상 유효하지 않다고 답했습니다.`,
        action:
          "openapi.nexon.com 에서 키를 새로 발급받아 계정 · 키 관리에서 교체해 주세요.",
        userActionable: true,
      };
    case "quota_exceeded":
      return {
        kind,
        cause: `${namedKey}로 오늘 쓸 수 있는 넥슨 호출량을 다 썼습니다.`,
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
        cause: "저장된 캐릭터 정보가 낡아 넥슨이 이 캐릭터를 알아보지 못했습니다.",
        action:
          "추적 캐릭터 버튼으로 캐릭터 선택을 한 번 열면 목록이 새로 받아지며 복구됩니다.",
        userActionable: true,
      };
    case "forbidden":
      return {
        kind,
        cause: `${namedKey}로는 접근할 수 없는 요청입니다.`,
        action:
          "넥슨 개발자 센터에서 키의 서비스 권한을 확인하거나 키를 새로 발급해 주세요.",
        userActionable: true,
      };
    case "network":
      return {
        kind,
        cause: "서버나 넥슨 API 에 연결하지 못해 응답을 받지 못했습니다.",
        action: "인터넷 연결을 확인한 뒤 다시 눌러 주세요.",
        userActionable: true,
      };
    case "timeout":
      return {
        kind,
        cause: "응답이 너무 오래 걸려 기다리기를 멈췄습니다.",
        action: "잠시 뒤 다시 눌러 주세요.",
        userActionable: false,
      };
    case "server_error":
      return {
        kind,
        cause: "서버가 요청을 처리하지 못했습니다.",
        action: "잠시 뒤 다시 눌러 주세요.",
        userActionable: false,
      };
    case "upstream":
      return {
        kind,
        cause: "넥슨 API 가 일시적으로 응답하지 않습니다. 우리 쪽 문제가 아닙니다.",
        action: "잠시 뒤 캐릭터별 새로고침을 눌러 주세요.",
        userActionable: false,
      };
    case "maintenance":
      return {
        kind,
        cause: "넥슨이 점검 중이라 게임 정보를 읽을 수 없습니다.",
        /*
          ★ **다시 시도하라고 하지 않는다.** 이 상황에서 사용자가 할 수 있는 일은 없고,
            누르면 캐릭터 수만큼 호출량만 탄다. 대신 언제 끝나는지를 말한다 —
            `describeMaintenanceWait` 는 서버가 실제로 다시 시도하는 시각과 **같은 분기**를
            쓰므로, 화면에 적힌 시각과 동작이 어긋나지 않는다.
        */
        action: `${describeMaintenanceWait(new Date())} 끝나면 자동으로 다시 동기화되니 그대로 두셔도 됩니다.`,
        userActionable: false,
      };
    case "data_not_ready":
      return {
        kind,
        cause: "넥슨이 이 데이터를 아직 준비하지 못했습니다.",
        action:
          "전날 기록은 다음 날 오전 2시 이후에 들어옵니다. 저장된 값은 그대로이니 잠시 뒤 다시 열어 주세요.",
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
export function describeSyncFailure(
  error: unknown,
  context: { readonly credentialLabel?: string | null } = {},
): SyncFailureNotice {
  const rawKind =
    typeof error === "object" && error !== null
      ? (error as KindedError).kind
      : null;
  const credentialLabel = context.credentialLabel ?? null;

  /*
    `kind` 칸이 아예 없으면 서버가 말한 것이 아니라 브라우저가 던진 것이다. `Failed to fetch`
    같은 말을 그대로 내보내지 않는다. 정상 경로에서는 `boss-plan-queries.ts` 가 이미 접어서 오므로
    여기는 다른 호출부를 위한 안전망이다.
  */
  if (typeof error === "object" && error !== null && !("kind" in error)) {
    const name = (error as { readonly name?: unknown }).name;
    return describeKind(
      name === "TimeoutError" || name === "AbortError" ? "timeout" : "network",
      "",
      credentialLabel,
    );
  }

  const serverMessage =
    error instanceof Error && error.message !== ""
      ? error.message
      : "인게임 스케줄러를 불러오지 못했습니다.";

  return describeKind(
    toFailureKind(typeof rawKind === "string" ? rawKind : null),
    serverMessage,
    credentialLabel,
  );
}

/**
 * 조치가 큰 실패일수록 높다. 없는 종류는 그 캐릭터 하나의 문제다.
 *
 * 세션 만료·점검은 무엇을 눌러도 안 되고, 한도·만료·권한은 그 키의 캐릭터가 전부 안 된다.
 * 네트워크·시간 초과·서버·넥슨 장애는 캐릭터와 상관없이 다음 호출도 같을 수 있어, 캐릭터 하나의
 * 문제(크기 0)가 앞에 있다고 가려지면 안 된다.
 */
const FAILURE_SEVERITY: Partial<Record<SyncFailureKind, number>> = {
  unauthenticated: 3,
  maintenance: 3,
  invalid_key: 2,
  quota_exceeded: 2,
  forbidden: 2,
  network: 1,
  timeout: 1,
  server_error: 1,
  upstream: 1,
};

/**
 * 여럿 실패했을 때 **무엇을 말할 것인가.** 첫 실패가 뒤의 더 큰 실패를 가리면 안 된다 —
 * "이 캐릭터 문제" 뒤에 "한도를 다 썼다"가 왔는데 앞엣것을 말하면, 사람은 계속 눌러 본다.
 * 크기가 같으면 먼저 난 것을 유지한다.
 */
export function pickFailureToReport(
  current: SyncFailureNotice | null,
  next: SyncFailureNotice,
): SyncFailureNotice {
  if (current === null) return next;
  const severity = (notice: SyncFailureNotice) =>
    FAILURE_SEVERITY[notice.kind] ?? 0;
  return severity(next) > severity(current) ? next : current;
}

/** 화면에 그대로 넣는 한 문장. 원인 다음에 조치가 온다 — 순서가 뒤집히면 읽히지 않는다. */
export function formatSyncFailure(notice: SyncFailureNotice): string {
  return `${notice.cause} ${notice.action}`;
}

/**
 * 전체 갱신 버튼의 라벨. 자동 동기화가 돌 때도 같은 자리에서 같은 말을 한다.
 *
 * `total` 이 0 인데 도는 중이면(시작 직후) 숫자 없이 말한다 — 지난 배치의 `12/12` 를
 * 잠깐이라도 보여 주면 "벌써 끝났나"로 읽힌다.
 */
export function formatRefreshAllLabel(
  isRunning: boolean,
  progress: { readonly done: number; readonly total: number },
): string {
  if (!isRunning) return "전체 갱신";
  return progress.total === 0
    ? "갱신 중"
    : `갱신 중 ${progress.done}/${progress.total}`;
}

/** 잠긴 버튼이 왜 잠겼는지. 자동·전체·카드별 어느 갱신이 돌든 맞는 말이어야 한다. */
export const SYNC_LOCKED_REASON = "갱신이 끝나면 누를 수 있습니다";

export interface RefreshAllResultCounts {
  readonly succeeded: number;
  readonly failed: number;
  /** 부르려 했지만 앞선 실패로 부르지 못하고 끝난 수. */
  readonly notReached: number;
  /** 키가 없어 부를 수 없는 수. */
  readonly missingKey: number;
}

/**
 * 전체 갱신 결과 한 줄. 단위는 `명`, 분모는 **추적 캐릭터 전체**다 — 평소 같은 칸에 있는
 * `추적 N명` 과 같은 수를 말해야 읽는 사람이 다시 세지 않는다.
 *
 * ★ 실패한 수와 앞선 실패로 부르지 못한 수를 **합쳐 말한다.** 읽는 사람에게는 둘 다 "못 받았다"
 *   이고, 이유는 토스트가 말한다. 이 줄이 예약된 한 줄을 넘으면 카드가 밀린다(390px 에서 실측).
 *
 * 키가 없어 아무도 못 불렀으면 그렇게 말한다 — 버튼을 눌렀는데 아무 일도 없어 보이면
 * 사람은 또 누른다.
 */
export function formatRefreshAllResult(counts: RefreshAllResultCounts): string {
  const attempted = counts.succeeded + counts.failed + counts.notReached;
  const total = attempted + counts.missingKey;

  if (attempted === 0) {
    return counts.missingKey > 0
      ? `${counts.missingKey}명 모두 API 키가 없어 갱신하지 못했습니다`
      : "갱신할 캐릭터가 없습니다";
  }

  const parts = [
    counts.succeeded === total
      ? `${total}명 모두 갱신`
      : `${total}명 중 ${counts.succeeded}명 갱신`,
  ];
  const notReceived = counts.failed + counts.notReached;
  if (notReceived > 0) parts.push(`${notReceived}명 실패`);
  if (counts.missingKey > 0) parts.push(`${counts.missingKey}명 키 없음`);
  return parts.join(" · ");
}

/**
 * 머리 상태 칸에 들어가는 한 건.
 *
 * ★ **자세한 사정은 칸에 넣지 않는다.** 칸은 자리가 예약돼 있어 카드를 밀지 않는 대신 짧아야
 *   하고, 원인·조치 문장은 토스트(`detail`)가 말한다. 칸의 "자세히"로 다시 열 수 있다.
 */
export interface StatusNotice {
  readonly text: string;
  /** `ok` 는 시간이 지나면 내려가고, `warning` 은 조치가 필요한 말이라 다음 누름까지 남는다. */
  readonly tone: "ok" | "warning";
  readonly detail: {
    readonly title: string;
    readonly description: string;
    readonly tone: "error" | "warning";
  } | null;
}

const STORED_VALUE_NOTE = "화면의 값은 마지막으로 저장된 것입니다.";

/** 초기화 구간(`@/lib/time/reset-window`)에는 동기화가 클리어를 기록하지 않는다. 그 이유. */
const RESET_WINDOW_DETAIL = {
  title: "초기화 직후입니다",
  description:
    "이 시간에는 넥슨이 초기화 전 값을 줄 수 있어 클리어를 기록하지 않습니다. 00:20 이후 다시 받아 주세요.",
  tone: "warning",
} as const;
const RESET_WINDOW_SUFFIX = "클리어는 00:20 이후";

export function describeRefreshAllNotice(
  input: RefreshAllResultCounts & {
    readonly failureMessage: string | null;
    readonly inResetWindow: boolean;
  },
): StatusNotice {
  const text = formatRefreshAllResult(input);
  const held = input.inResetWindow && input.succeeded > 0;

  if (input.failureMessage !== null) {
    return {
      text: held ? `${text} · ${RESET_WINDOW_SUFFIX}` : text,
      tone: "warning",
      detail: {
        title: "전체 갱신을 마치지 못했습니다",
        description: `${input.failureMessage} ${STORED_VALUE_NOTE}`,
        // 하나라도 받았으면 실패가 아니라 부분 성공이다(§4: 빨강은 실패 전용).
        tone: input.succeeded > 0 ? "warning" : "error",
      },
    };
  }
  return {
    text: held ? `${text} · ${RESET_WINDOW_SUFFIX}` : text,
    tone: input.missingKey > 0 ? "warning" : "ok",
    detail: held ? RESET_WINDOW_DETAIL : null,
  };
}

export function describeAutoFailureNotice(input: {
  readonly failed: number;
  readonly notReached: number;
  readonly failureMessage: string;
}): StatusNotice {
  return {
    text: `자동 갱신 ${input.failed + input.notReached}명 실패`,
    tone: "warning",
    detail: {
      title: "자동 갱신을 마치지 못했습니다",
      description: `${input.failureMessage} ${STORED_VALUE_NOTE}`,
      tone: "warning",
    },
  };
}

export function describeCardSuccessNotice(input: {
  readonly characterName: string;
  readonly clearRecordedCount: number;
  readonly unmappedCount: number;
  readonly inResetWindow: boolean;
}): StatusNotice {
  if (input.inResetWindow) {
    return {
      text: `${input.characterName} 갱신 · ${RESET_WINDOW_SUFFIX}`,
      tone: "ok",
      detail: RESET_WINDOW_DETAIL,
    };
  }
  const unmapped =
    input.unmappedCount > 0 ? ` · 미확인 보스 ${input.unmappedCount}건` : "";
  return {
    text: `${input.characterName} 갱신 · 클리어 ${input.clearRecordedCount}건 반영${unmapped}`,
    tone: "ok",
    detail: null,
  };
}

export function describeCardFailureNotice(
  characterName: string,
  failure: SyncFailureNotice,
): StatusNotice {
  return {
    text: `${characterName} 갱신 실패`,
    tone: "warning",
    detail: {
      title: `${characterName} 갱신 실패`,
      description: `${formatSyncFailure(failure)} ${STORED_VALUE_NOTE}`,
      tone: "error",
    },
  };
}
