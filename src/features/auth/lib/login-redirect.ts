/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 로그인이 풀린 사람을 **로그인 화면으로 보내고, 로그인하면 보던 화면으로 돌려보낸다**
 * ═════════════════════════════════════════════════════════════════════════════
 * 발주 지시(2026-11-09): *"로그인이 풀렸으면 그냥 로그인창으로 보내줘"*.
 *
 * 계기: 로그인이 풀린 사람이 `/parties` 를 열었더니 "아직 파티가 없습니다"가 떴고, 그
 * 사람은 **파티가 다 지워진 줄 알았다**(DB 는 멀쩡했다). 예전에는 화면마다 비로그인
 * 안내 카드나 공개 목록을 200 으로 그렸는데, 사람은 그것을 "내 데이터가 이렇다"로
 * 읽는다. 로그인이 필요한 곳에서 로그인이 풀렸다면 보여 줄 것은 로그인 화면뿐이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 파일은 **순수 모듈**이다
 * ─────────────────────────────────────────────────────────────────────────────
 * 서버 페이지(리다이렉트 판정) · 로그인 화면(돌아갈 곳 검증) · 클라이언트 요청 헬퍼
 * (401 감지)가 **같은 판정**을 써야 한다. 그래서 `server-only` 도 `window` 도 없다 —
 * 어느 쪽에서 import 해도 같은 코드가 돈다. 브라우저를 만지는 부분은
 * `./session-expiry.ts` 가 따로 갖는다.
 */

/** 로그인 화면이 "로그인 뒤 돌아갈 곳"을 받는 쿼리 이름. `/?next=%2Fparties` */
export const LOGIN_RETURN_PARAM = "next";

/**
 * 로그인해야 내용이 있는 화면 — **허용 목록(allowlist)** 이다.
 *
 * 거꾸로("공개 화면 목록 밖은 전부 로그인 필요") 두지 않은 이유: 새 공개 화면이 생겼는데
 * 이 목록을 고치는 것을 잊으면 **비로그인 방문자가 로그인 화면으로 튕긴다.** 비로그인
 * 200 은 DoD(§0.3)이고, 공유 링크(`/s/*` · `/invite/*`)가 튕기면 링크를 받은 사람은
 * 아무것도 볼 수 없다. 반대로 이 목록에 넣는 것을 잊은 새 화면은 지금까지처럼 자기
 * 안내를 그릴 뿐이다 — 잊었을 때 덜 나쁜 쪽을 골랐다.
 *
 * ⚠️ `components/layout/nav-routes.ts` 의 `requiresAuth` 와 **같은 사실을 다른 목적으로**
 *    적은 목록이다(저쪽은 메뉴 표시 여부). 화면을 더하거나 뺄 때 두 곳을 함께 본다.
 */
export const LOGIN_REQUIRED_PATHS = [
  "/parties",
  "/boss-plans",
  "/boss-status",
  "/chores",
  "/drops",
  "/etc",
  "/income",
  "/friends",
] as const;

/** 돌아갈 곳으로 받는 경로의 최대 길이. 그 이상은 정상 화면 주소가 아니다. */
const MAX_RETURN_PATH_LENGTH = 2048;

/** 제어문자와 백슬래시. 브라우저마다 `\` 를 `/` 로 읽어 `/\evil.com` 이 외부로 나간다. */
const UNSAFE_CHARACTERS = /[\u0000-\u001f\u007f\\]/;

/**
 * 판정 전용 가상 출처. 상대 경로를 이 출처 위에서 풀어 보고 **출처가 그대로인지**만 본다.
 * 실제 호스트가 아니며 어디로도 요청이 나가지 않는다.
 */
const PROBE_ORIGIN = "http://x";

/** 정확히 그 경로이거나, 그 경로 + `/` 로 시작하는가. `/partiesX` 는 아니다. */
export function isLoginRequiredPath(pathname: string): boolean {
  return LOGIN_REQUIRED_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

/**
 * 로그인 뒤 돌아갈 곳으로 **받아도 되는** 경로인가 — 오픈 리다이렉트 방어.
 *
 * `?next=` 는 누구나 만들 수 있는 링크 조각이다. 검증 없이 그대로 `location.replace`
 * 하면 `/?next=https://evil.com` 링크가 "로그인하면 피싱 사이트로 보내 주는" 장치가 된다.
 * 그래서 통과 조건을 **좁게** 잡는다:
 *   - 문자열이고 길이가 정상 범위다.
 *   - `/` 로 시작하고 `//`(프로토콜 상대 URL) · `/\` 로 시작하지 않는다.
 *   - 제어문자 · 백슬래시가 어디에도 없다.
 *   - 가상 출처 위에서 풀었을 때 **출처가 바뀌지 않는다.**
 *   - 풀린 경로가 `isLoginRequiredPath` 를 만족한다 — 로그인 뒤 돌아갈 이유가 있는
 *     곳은 그것뿐이다. `/parties/../guide` 같은 우회도 **풀린 뒤의** 경로로 보므로 막힌다.
 *
 * 통과하면 **정규화된** `pathname + search` 를 돌려준다(해시는 서버가 보지 못하는
 * 값이라 버린다). 하나라도 어긋나면 null — 그때 로그인 화면은 `/` 로 돌아간다.
 */
export function toSafeReturnPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (raw.length === 0 || raw.length > MAX_RETURN_PATH_LENGTH) return null;
  if (!raw.startsWith("/")) return null;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return null;
  if (UNSAFE_CHARACTERS.test(raw)) return null;

  let url: URL;
  try {
    url = new URL(raw, PROBE_ORIGIN);
  } catch {
    return null;
  }
  if (url.origin !== PROBE_ORIGIN) return null;
  if (!isLoginRequiredPath(url.pathname)) return null;

  return `${url.pathname}${url.search}`;
}

/**
 * 로그인 화면 주소. 돌아갈 곳이 없으면 그냥 `/` 다.
 *
 * ★ 여기서는 **검증하지 않는다** — 받는 쪽(`/` 페이지)이 `toSafeReturnPath` 로 다시
 *   거른다. 보내는 쪽 검증을 믿으면 손으로 만든 링크가 그대로 통과한다.
 */
export function loginHref(returnTo: string | null): string {
  if (returnTo === null) return "/";
  return `/?${LOGIN_RETURN_PARAM}=${encodeURIComponent(returnTo)}`;
}

/**
 * 서버 페이지가 자기 주소를 "돌아갈 곳"으로 만든다 — **쿼리스트링을 보존한다.**
 *
 * 보존이 요점인 화면이 둘 있다:
 *   - `/friends?add=<토큰>` — 친구 링크가 도착하는 곳이다. 토큰을 잃으면 로그인한 뒤
 *     링크를 다시 받아야 한다.
 *   - `/boss-plans?characterId=…` — 이번 주 현황의 캐릭터 카드에서 넘어오는 경로.
 *
 * `searchParams` 는 Next 가 풀어 준 객체라 같은 키가 여러 번 오면 배열이다. 순서대로
 * 다시 붙인다.
 */
export function returnPathFrom(
  pathname: string,
  searchParams: Readonly<Record<string, string | string[] | undefined>>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) query.append(key, item);
    } else {
      query.append(key, value);
    }
  }
  const search = query.toString();
  return search === "" ? pathname : `${pathname}?${search}`;
}

/**
 * 이 실패 응답이 **"세션이 없다"** 인가.
 *
 * ⚠️ 상태 코드만 보면 안 된다. 넥슨이 키를 거절해도 401 이다(`lib/nexon/errors.ts` 의
 *    `invalid_key: 401`). 로그인 폼에 틀린 키를 넣었을 때나 넥슨 프록시가 키 오류를 줄
 *    때 로그인 화면으로 튕기면, 사람은 무엇이 틀렸는지 볼 기회를 잃는다. 그래서 우리
 *    서버가 세션이 없을 때만 내는 몸체(`ApiError.unauthenticated()` →
 *    `{ error: { kind: "unauthenticated" } }`)까지 함께 본다.
 */
export function isSessionExpiredResponse(
  status: number,
  body: unknown,
): boolean {
  if (status !== 401) return false;
  if (typeof body !== "object" || body === null) return false;
  const error = (body as { error?: unknown }).error;
  if (typeof error !== "object" || error === null) return false;
  return (error as { kind?: unknown }).kind === "unauthenticated";
}
