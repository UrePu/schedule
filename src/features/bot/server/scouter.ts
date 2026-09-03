import "server-only";

import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";
import type { Browser, HTTPResponse } from "puppeteer-core";

import type { AdminDb } from "@/lib/supabase/admin-db";
import type { Database } from "@/types/database";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `!환산` 의 스탯 — **남의 화면을 열어서 읽는다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-09-03): `!환산 <닉네임>` 이 미리보기 카드만 던지지 말고 **스탯 요약**도
 * 같이 보내게 한다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 HTML 을 긁지 않고 브라우저를 띄우는가
 * ─────────────────────────────────────────────────────────────────────────────
 * maplescouter 의 `/ko/info` 는 **껍데기만 서버 렌더**다. 페이지 HTML 을 받아도 숫자가
 * 하나도 들어 있지 않고, 값은 페이지가 브라우저에서 스스로 부르는 XHR 로 뒤늦게 온다.
 * 그래서 `fetch` 로는 영원히 빈 문서만 받는다.
 *
 * ★ 그래서 **헤드리스 브라우저로 페이지를 열고, 그 브라우저가 받는 응답을 엿듣는다.**
 *   DOM 셀렉터는 한 개도 쓰지 않는다 — 두 가지를 동시에 얻기 때문이다:
 *     ① 그쪽 클래스명·마크업이 바뀌어도 안 깨진다(셀렉터는 남의 집 CSS 에 우리 코드를
 *        묶는 짓이다),
 *     ② 값이 이미 JSON 이라 파싱이 문자열 긁기가 아니라 타입 확인 한 번으로 끝난다.
 *
 * ⚠️ **그쪽 내부 API 를 직접 부르지 않는다.** `api.maplescouter.com` 은 `viewer-key`
 *    헤더를 요구하고, 우리가 그 헤더를 흉내내는 것은 **접근 제어 우회**다. 우리가 하는
 *    일은 사람이 브라우저로 여는 것과 똑같은 **공개 페이지 열기** 하나뿐이고, 응답을
 *    엿듣는 것은 그 브라우저가 이미 받은 바이트를 읽는 것이다. 이 경계를 옮기지 마라.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 실측 (2026-09-03, 지휘 측 로컬)
 * ─────────────────────────────────────────────────────────────────────────────
 *   브라우저 기동            405ms
 *   조회 1건                  0.9 ~ 2.0초
 *   응답 URL                 `/api/id?` 를 포함
 *   있는 닉네임              **HTTP 201**
 *   없는 닉네임              **HTTP 400**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 남의 서버에 대한 예의 — 이 네 가지는 타협하지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **이미지·폰트·미디어는 차단한다.** 우리가 쓰는 것은 JSON 하나뿐인데 초상화와 웹폰트
 *    까지 받아 오는 것은 남의 대역폭을 이유 없이 쓰는 일이다. 덤으로 빨라진다.
 * 2. **캐시로 재방문을 억제한다.** 같은 닉네임을 30분 안에 다시 물으면 우리 표에서 답한다
 *    (`scouter_stat_cache`, 음성 24시간).
 * 3. **재시도 루프가 없다.** 한 번 실패하면 그대로 `"unavailable"` 이다. 실패했다는 것은
 *    그쪽이 느리거나 아픈 것인데, 그때 우리가 한 번 더 두드리는 것은 정확히 반대 행동이다.
 * 4. **상한이 확실하다.** 조회 한 건 전체가 25초 예산 안에서 끝난다(아래 "예산" 절).
 *    방에서 사람이 기다려 주는 한계이자, 라우트의 `maxDuration = 60` 을 넘기지 않기 위한
 *    값이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ 예산 — **상한이 한 군데만 걸려 있으면 그건 상한이 아니다** ★★
 * ─────────────────────────────────────────────────────────────────────────────
 * 초판은 `page.goto` 와 응답 대기에만 12초를 걸어 두고 "12초 상한" 이라고 적었다.
 * **거짓이었다.** 그 앞 세 단계가 무방비였기 때문이다(교차 검증 2026-09-03):
 *
 *   `chromium.executablePath()`   64.8MB 브로틀리 압축해제 — **상한 없음**
 *   `puppeteer.launch()`          상한 미지정 → puppeteer 기본 **30초**
 *   `newPage` / CDP 호출          `protocolTimeout` 미지정 → 기본 **180초**
 *
 * 현실적 최악이 45초, 이론상 180초라 `api/bot/command/route.ts` 의 `maxDuration = 60` 을
 * 넘긴다. 넘기면 그 파일이 "절대 일어나면 안 된다"고 적은 증상 — **방에 아무 말도 안
 * 나감** — 이 된다. 카드조차 안 뜨고, 사람 눈에는 봇이 죽은 것으로 보인다.
 *
 * 그래서 상한을 **네 겹**으로 건다. 바깥 한 겹이 나머지를 전부 덮는 것이 요점이다:
 *
 *   `LOOKUP_BUDGET_MS`     25초  **조회 전체**(기동+열기+대기)를 감싸는 바깥 예산
 *   `LAUNCH_TIMEOUT_MS`    10초  `puppeteer.launch` 자체
 *   `PROTOCOL_TIMEOUT_MS`  15초  CDP 왕복 하나(`newPage` 등)
 *   `RESPONSE_TIMEOUT_MS`  12초  `/api/id?` 응답 대기
 *   `CLOSE_TIMEOUT_MS`      3초  브라우저 종료(넘으면 프로세스를 죽인다)
 *
 * 25 + 3 = 28초 < 60초. 안쪽 값을 올릴 사람은 이 부등식을 먼저 볼 것.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `"missing"` 과 `"unavailable"` 을 절대 합치지 않는 이유
 * ─────────────────────────────────────────────────────────────────────────────
 *   `"missing"`     — 그쪽이 **정상적으로** "그런 닉네임 없다"고 답했다(HTTP 400).
 *                     사람에게 할 말: *"그 닉네임으로는 못 찾았어요."* → 오타를 고치면 된다.
 *   `"unavailable"` — 타임아웃 · 브라우저 기동 실패 · 그 밖의 사고. **우리 사정**이다.
 *                     사람에게 할 말: *"스탯을 못 가져왔어요. 링크로 확인해 주세요."*
 * 둘을 합치면 멀쩡한 닉네임을 친 사람이 자기 오타를 찾느라 시간을 쓴다. 그리고 캐시에서도
 * 갈린다 — `"unavailable"` 은 **한 줄도 적지 않는다**(적으면 멀쩡한 닉네임이 24시간 동안
 * "못 찾았어요" 가 된다).
 */

/**
 * 환산 스펙 페이지 주소. **이 저장소에서 여기 한 곳에만 적는다.**
 *
 * ⚠️ 한동안 `commands.ts` 에도 `SCOUTER_BASE` 라는 같은 문자열이 있었고, 그 옆 주석이
 *    "여기 한 곳에만 적는다" 고 **거짓**을 단언하고 있었다(교차 검증 2026-09-03).
 *    소유자를 서버 모듈인 이쪽으로 정한 이유는 방향이다 — 답장을 만드는 쪽이 페이지를 여는
 *    쪽을 알 이유는 없지만, **페이지를 여는 쪽은 반드시 그 주소를 안다.**
 *    `commands.ts` 는 이것을 import 해서 링크를 만든다.
 */
export const SCOUTER_PAGE_BASE = "https://maplescouter.com/ko/info?name=";

/**
 * **조회 한 건 전체**(브라우저 기동 + 페이지 열기 + 응답 대기)의 바깥 예산 — **25초.**
 *
 * ★ 아래 개별 상한들이 다 지켜져도 **합이 60초를 넘을 수 있으므로** 바깥에 하나가 더
 *   필요하다. 특히 `chromium.executablePath()`(64.8MB 압축해제)에는 자기 상한이 아예
 *   없어서, 이 예산이 그 단계를 덮는 **유일한** 장치다.
 * ★ 25초로 잡은 근거는 `route.ts` 의 `maxDuration = 60` 이다. 25 + 종료 3 = 28초라
 *   나머지 32초가 서명 검증·DB 왕복·콜드스타트 몫으로 남는다.
 */
const LOOKUP_BUDGET_MS = 25_000;

/**
 * `puppeteer.launch` 자체의 한계 — **10초.**
 *
 * 명시하지 않으면 puppeteer 기본값 **30초**가 적용된다. 실측 기동이 405ms 였으므로 10초는
 * 이미 24배이고, 여기서 10초를 쓴 조회는 어차피 방에서 못 쓸 만큼 느리다.
 */
const LAUNCH_TIMEOUT_MS = 10_000;

/**
 * CDP 왕복 하나의 한계 — **15초.**
 *
 * 명시하지 않으면 기본값 **180초**다. `newPage()` 하나가 굳었을 때 3분을 잡아먹는다는 뜻이고,
 * 그건 `maxDuration` 을 세 번 넘긴다.
 */
const PROTOCOL_TIMEOUT_MS = 15_000;

/**
 * `/api/id?` 응답을 기다리는 한계 — **12초.**
 *
 * 실측 0.9~2.0초의 6배다. 넉넉해 보이지만 이 자리는 **방에서 사람이 기다리는 자리**라
 * 위로도 못 늘린다. 서버리스 콜드스타트에서 크롬 기동이 1~2초 더 붙는 것까지 감안한 값이다.
 */
const RESPONSE_TIMEOUT_MS = 12_000;

/**
 * 브라우저 종료를 기다리는 한계 — **3초.** 넘으면 프로세스를 직접 죽인다.
 *
 * ⚠️ `browser.close()` 에는 상한이 없다. 서버리스에서 도는 크롬은 `--single-process` 라
 *    한 번 굳으면 `finally` 의 `await` 가 무한정 잡고, 그러면 **이미 다 만들어 놓은 답장이
 *    통째로 사라진다.** 조회에 성공하고도 방에 아무 말이 안 나가는 최악의 실패다.
 */
const CLOSE_TIMEOUT_MS = 3_000;

/**
 * 양성 캐시 TTL — **30분.**
 *
 * 환산 스탯은 사람이 **장비를 갈아입어야** 변한다. 방에서 자랑하려고 두세 번 연달아 치는
 * 것이 전형적인 사용 패턴이고, 그 연타마다 크롬이 뜨는 것을 막는 데는 30분이면 충분하다.
 * 더 길게 잡으면 "방금 스펙업했는데 옛날 값" 이 된다.
 */
const POSITIVE_TTL_MS = 30 * 60 * 1000;

/**
 * 음성 캐시 재시도 주기 — **24시간.**
 *
 * 없는 닉네임의 대부분은 오타다. 오타 한 줄 때문에 크롬이 하루에 수십 번 뜨는 것을 막는
 * 것이 이 값의 존재 이유 전부다. 하루면 닉네임 변경권을 쓴 사람도 다음 날 다시 잡힌다.
 */
const NEGATIVE_RETRY_MS = 24 * 60 * 60 * 1000;

/** 받아 오지 않을 리소스. JSON 하나만 필요하다. */
const BLOCKED_RESOURCE_TYPES: ReadonlySet<string> = new Set(["image", "font", "media"]);

/** 한 닉네임의 환산 스탯. 표 한 행을 답장이 쓰는 모양으로 접은 것이다. */
export interface ScouterStats {
  /** 조회에 쓴 닉네임 그대로. 표의 기본키이자 답장 첫 줄의 이름이다. */
  readonly name: string;
  readonly characterClass: string | null;
  readonly characterLevel: number | null;
  readonly worldName: string | null;
  /** 환산 주스탯(380). */
  readonly bossStat: number | null;
  /** 헥사 환산 주스탯(380). */
  readonly hexaStat: number | null;
  /** 어센틱 심볼 레벨. **미착용(0)은 빠져 있다.** 빈 배열은 정상이다. */
  readonly authenticSymbols: readonly number[];
  /** 그랜드 어센틱 심볼 레벨. 없는 캐릭터가 흔하며 그때는 빈 배열이다. */
  readonly grandAuthenticSymbols: readonly number[];
  readonly authenticForce: number | null;
}

/**
 * 조회 결과.
 *
 * 문자열 두 개를 `null` 하나로 접지 않은 이유는 위 머리말에 있다 — **사람에게 할 말이
 * 다르다.**
 */
export type ScouterLookup = ScouterStats | "missing" | "unavailable";

// ─────────────────────────────────────────────────────────────────────────────
// unknown 안전 접근 — 남의 JSON 이므로 `any` 로 뚫지 않는다
// ─────────────────────────────────────────────────────────────────────────────
/*
  이 응답은 **우리가 스키마를 통제하지 못하는 남의 데이터**다. `as any` 한 번이면 그쪽이
  필드 하나를 옮긴 날 런타임에서 터진다. 값이 없으면 `null` 로 접히도록 한 칸씩 확인한다.
*/

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function numberAt(record: Record<string, unknown> | null, key: string): number | null {
  if (record === null) return null;
  const value = record[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  // 숫자를 문자열로 주는 필드가 섞여 있을 수 있다(넥슨 원본이 그렇다 — §1.0 플래그 문자열).
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function stringAt(record: Record<string, unknown> | null, key: string): string | null {
  if (record === null) return null;
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * `authentic_symbol_1..N` 처럼 **개수가 캐릭터마다 다른** 키 묶음에서 레벨만 모은다.
 *
 * ⚠️ **키를 하드코딩하지 않는다.** 지휘 측 실측에서 어센틱 6개 · 그랜드 2개였지만, 그랜드가
 *    `0·0` 인 캐릭터(메검메)가 있고 지역이 추가되는 패치도 있다. 접두사로 훑고 **레벨 0 은
 *    미착용으로 보고 뺀다** — 답장에 `0` 을 늘어놓는 것은 정보가 아니다.
 * ★ 키 순서에 기대지 않고 **접미 숫자로 정렬**한다. JSON 파싱 순서는 대체로 맞지만,
 *   `1·10·2` 같은 사전순 뒤집힘을 우리가 대신 막아 준다.
 */
function symbolLevels(
  symbols: Record<string, unknown> | null,
  prefix: string,
): readonly number[] {
  if (symbols === null) return [];
  return Object.keys(symbols)
    .filter((key) => key.startsWith(prefix))
    .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
    .map((key) => numberAt(asRecord(symbols[key]), "level"))
    .filter((level): level is number => level !== null && level > 0);
}

function parseScouterBody(name: string, body: unknown): ScouterStats | null {
  const root = asRecord(body);
  if (root === null) return null;

  const calculated = asRecord(root.calculatedData);
  const userApi = asRecord(root.userApiData);
  const info = asRecord(userApi?.info);
  const symbols = asRecord(userApi?.symbol);

  /*
    ★ **아무 값도 못 건졌으면 성공으로 치지 않는다.** 201 을 받았어도 본문 모양이 바뀌면
      "비숍 아님 · Lv.? · 환산 ?" 같은 껍데기가 방에 나간다. 그건 캐시에 담아서도 안 된다.
      직업·레벨·환산 중 하나라도 있으면 사람에게 보여 줄 값이 있는 것으로 본다.
  */
  const characterClass = stringAt(calculated, "class");
  const characterLevel = numberAt(info, "character_level");
  const bossStat = numberAt(calculated, "boss380_stat");
  if (characterClass === null && characterLevel === null && bossStat === null) return null;

  return {
    name,
    characterClass,
    characterLevel,
    worldName: stringAt(info, "world_name"),
    bossStat,
    hexaStat: numberAt(calculated, "boss380_hexaStat"),
    authenticSymbols: symbolLevels(symbols, "authentic_symbol_"),
    grandAuthenticSymbols: symbolLevels(symbols, "grand_authentic_symbol_"),
    authenticForce: numberAt(info, "authenticForce"),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 브라우저
// ─────────────────────────────────────────────────────────────────────────────

/** `withTimeout` 이 "시간이 다 됐다" 를 값으로 돌려주기 위한 표식. */
const TIMED_OUT = Symbol("scouter-timed-out");

/**
 * `work` 를 `ms` 안에 끝내거나 `TIMED_OUT` 을 돌려준다.
 *
 * ★ **진 쪽 타이머를 반드시 지운다.** 안 지우면 그 타이머가 이벤트 루프를 붙잡아, 조회가
 *   1초에 끝나도 프로세스가 그만큼 더 살아 있는다(서버리스에서는 그대로 과금이다).
 * ⚠️ 시간이 다 됐다고 해서 `work` 가 멈추지는 **않는다.** 자바스크립트에는 취소가 없다.
 *   그래서 부르는 쪽이 **뒤늦게 뜬 브라우저를 반드시 닫아 주어야** 한다 —
 *   `fetchScouterStats` 가 `lookup` 에 별도 `finally` 를 다는 이유가 이것이다.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * 살아 있는 브라우저를 담아 두는 상자.
 *
 * 왜 지역 변수가 아니라 상자인가: 바깥 예산이 이겨서 `fetchScouterStats` 가 먼저 돌아간
 * **뒤에** 기동이 끝날 수 있다. 그때 뜬 브라우저를 닫으려면 두 코드가 같은 칸을 봐야 한다.
 */
interface BrowserSlot {
  browser: Browser | null;
}

/**
 * 브라우저를 **상한을 걸어** 닫는다. 안 닫히면 프로세스를 죽인다.
 *
 * 두 번 불려도 안전하다(두 번째는 칸이 비어 있어 즉시 돌아간다) — 정상 경로와 지각 정리
 * 경로가 둘 다 이 함수를 부르기 때문에 그 성질이 필요하다.
 */
async function closeBrowser(slot: BrowserSlot): Promise<void> {
  const browser = slot.browser;
  if (browser === null) return;
  slot.browser = null;

  const closed = browser.close().catch(() => {
    /* 이미 죽은 브라우저. 여기서 더 할 수 있는 일이 없다. */
  });
  const outcome = await withTimeout(closed, CLOSE_TIMEOUT_MS);
  if (outcome === TIMED_OUT) {
    // 굳었다. 예의보다 답장이 먼저다.
    browser.process()?.kill("SIGKILL");
  }
}

/**
 * 크롬을 띄운다. **로컬과 서버리스에서 실행 파일이 다르다.**
 *
 * - `CHROME_PATH` 가 있으면 **무조건 그것이 이긴다.** 개발 기계(Windows/macOS)에는 이미
 *   크롬이 깔려 있고, 거기서 `@sparticuz/chromium` 은 리눅스 바이너리라 애초에 돌지 않는다.
 * - 없으면 `@sparticuz/chromium` — Vercel 서버리스(Amazon Linux)에서 도는 표준 조합이다.
 *   **Playwright 를 쓰지 않는 이유가 이것이다**: 그쪽은 자체 브라우저 번들을 요구해서
 *   서버리스 이미지 용량 한도에 걸린다.
 */
async function launchBrowser(): Promise<Browser> {
  /*
    두 경로 공통 상한. **둘 다 반드시 명시한다** — 생략하면 launch 30초·CDP 180초라는
    puppeteer 기본값이 조용히 적용되고, 그 둘만으로 `maxDuration = 60` 이 날아간다.
  */
  const limits = { timeout: LAUNCH_TIMEOUT_MS, protocolTimeout: PROTOCOL_TIMEOUT_MS };

  const explicit = process.env.CHROME_PATH?.trim();
  if (explicit !== undefined && explicit !== "") {
    /*
      로컬은 **진짜 크롬**이다. `headless: true` 면 puppeteer 가 `--headless=new` 를 붙이는데,
      정식 크롬 빌드는 그 모드를 지원한다. 여기서 굳이 `"shell"` 을 쓸 이유가 없다.
    */
    return puppeteer.launch({
      ...limits,
      executablePath: explicit,
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  }

  /*
    ★ **서버리스는 `headless: "shell"` 이다. `true` 가 아니다.**
      `@sparticuz/chromium@149` 가 싣는 바이너리는 정식 크롬이 아니라 `chrome-headless-shell`
      이고, 그 README 가 못박는다: *"headless_shell does not seem to include support for the
      'new' headless mode."* `headless: true` 면 puppeteer 가 `--headless=new` 를 붙이므로
      바이너리가 모르는 플래그를 받는다. 그쪽 예제도 전부 `"shell"` 이다.
    ⚠️ **이 저장소의 개발 환경에는 리눅스가 없어 이 분기는 검증하지 못했다**(2026-09-03).
       로컬 검증은 전부 위쪽 `CHROME_PATH` 분기로만 돌았다. 배포 후 `!환산` 이 **항상**
       "스탯을 못 가져왔어요" 를 내면 가장 먼저 의심할 줄이 여기다.
    ★ `@sparticuz/chromium@149` 는 `headless` 값을 export 하지 않는다(실제로 확인함).
      그래서 상수를 그대로 적는다 — 없는 export 를 읽어 `undefined` 를 넘기면
      puppeteer 기본값(`true`)으로 되돌아가 같은 문제가 조용히 재현된다.
  */
  return puppeteer.launch({
    ...limits,
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: "shell",
  });
}

/** 엿들은 응답 한 건. 본문 파싱 실패와 상태코드를 분리해서 들고 있는다. */
interface ScouterHit {
  readonly status: number;
  readonly body: unknown;
}

/**
 * 페이지를 한 번 열어 `/api/id?` 응답을 엿듣는다. **재시도하지 않는다.**
 *
 * ⚠️ `try/finally` 로 브라우저를 반드시 닫는다. 서버리스 인스턴스는 재사용되므로, 안 닫으면
 *    좀비 크롬이 쌓여 다음 호출이 메모리로 죽는다 — 그때 나는 증상은 "가끔 느림"이라
 *    원인을 찾기 매우 어렵다.
 */
export async function fetchScouterStats(name: string): Promise<ScouterLookup> {
  const slot: BrowserSlot = { browser: null };
  const lookup = runLookup(name, slot);

  /*
    ★ **지각 정리.** 바깥 예산이 이겨서 우리가 먼저 돌아가도 `lookup` 은 계속 돌고, 그
      뒤에 브라우저가 뜰 수 있다. 자바스크립트에는 취소가 없으니 그 브라우저를 닫아 줄
      코드가 따로 있어야 한다 — 없으면 정확히 이 경로로 좀비 크롬이 쌓인다.
      `closeBrowser` 는 두 번 불려도 안전해서 아래 `finally` 와 겹쳐도 문제가 없다.
  */
  void lookup
    .catch(() => {
      /* 실패 판정은 아래에서 한다. 여기서는 정리만 한다. */
    })
    .finally(() => {
      void closeBrowser(slot);
    });

  try {
    const outcome = await withTimeout(lookup, LOOKUP_BUDGET_MS);
    if (outcome === TIMED_OUT) {
      console.error(`[bot/scouter] 예산(${LOOKUP_BUDGET_MS}ms) 초과 — 조회를 포기한다.`);
      return "unavailable";
    }
    return outcome;
  } catch (error) {
    console.error(
      "[bot/scouter] 환산 조회 실패:",
      error instanceof Error ? `${error.name}: ${error.message}` : error,
    );
    return "unavailable";
  } finally {
    await closeBrowser(slot);
  }
}

/**
 * 실제 조회. **상한은 부르는 쪽이 쥔다** — 여기서 다시 걸지 않는다.
 *
 * 띄운 브라우저를 `slot` 에 넣는 것이 이 함수의 계약이다. 그래야 예산이 이겨서 이 함수가
 * 버려진 뒤에도 부르는 쪽이 그 브라우저를 닫을 수 있다.
 */
async function runLookup(name: string, slot: BrowserSlot): Promise<ScouterLookup> {
  const browser = await launchBrowser();
  slot.browser = browser;
  const page = await browser.newPage();
  /*
    JSON 하나만 필요하다. 초상화·웹폰트·동영상을 받아 오는 것은 남의 대역폭을 이유 없이
    쓰는 일이다. 스타일시트는 **막지 않는다** — 페이지가 렌더 도중 죽으면 우리가 기다리는
    XHR 자체가 안 나갈 수 있고, 그 위험을 몇 KB 아끼자고 질 이유가 없다.
  */
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const blocked = BLOCKED_RESOURCE_TYPES.has(request.resourceType());
    void (blocked ? request.abort() : request.continue()).catch(() => {
      /* 이미 처리된 요청. 무시해도 흐름에 영향이 없다. */
    });
  });

  const target = `${SCOUTER_PAGE_BASE}${encodeURIComponent(name)}`;

  const hit = await new Promise<ScouterHit | null>((resolve) => {
    let settled = false;
    const finish = (value: ScouterHit | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), RESPONSE_TIMEOUT_MS);

    page.on("response", (response: HTTPResponse) => {
      if (!response.url().includes("/api/id?")) return;
      /*
        ⚠️ **CORS 프리플라이트를 먼저 걸러야 한다.** 그쪽 XHR 은 다른 오리진
           (`api.maplescouter.com`)으로 나가서 진짜 `GET` 앞에 `OPTIONS 204` 가 한 번
           먼저 도착한다(실측 2026-09-03). 이걸 안 거르면 **모든 조회가 204 를 보고
           `"unavailable"`** 이 된다 — 실제로 첫 실행이 그렇게 세 건 다 실패했다.
           `finish()` 는 선착순이라, 순서를 믿지 말고 메서드로 판별한다.
      */
      if (response.request().method() !== "GET") return;
      // 3xx 는 최종 응답이 아니다. 뒤따라오는 진짜 응답을 기다린다.
      const status = response.status();
      if (status >= 300 && status < 400) return;
      /*
        ★ **201 만 받지 않는다. 2xx 전체를 받는다.** 오늘 `/api/id` 는 201 이지만 같은
          서버가 `/api/notice/famous-character/daily` 에는 200 을 쓴다. 그쪽이 201 을
          200 으로 바꾸는 날, 상태코드로 막아 두면 **모든 조회가 조용히
          `"unavailable"`** 이 되고 증상은 "항상 못 가져와요" 하나뿐이라 원인을 찾기가
          매우 어렵다. 성공/실패 판정은 상태코드가 아니라 **본문 파싱**에 맡긴다 —
          우리가 실제로 필요한 것이 값이지 숫자가 아니기 때문이다.
        ⚠️ 400 만은 예외로 남긴다. 그건 실패가 아니라 **"그런 닉네임 없음" 이라는 답**이고
          (실측 2026-09-03), 본문으로는 그 뜻을 알아낼 수 없다.
      */
      if (status < 200 || status >= 300) {
        finish({ status, body: null });
        return;
      }
      void response
        .json()
        .then((body: unknown) => finish({ status, body }))
        .catch(() => finish({ status, body: null }));
    });

    /*
      `waitUntil: "domcontentloaded"` — 문서가 파싱되면 그만이다. 우리가 기다리는 것은
      그 뒤에 나가는 XHR 이지 `load` 이벤트가 아니고, 광고·분석 스크립트 하나가 늦으면
      `load` 는 영영 안 온다. (Playwright 의 `"commit"` 은 puppeteer 에 없다.)
      goto 실패(네트워크 사고)도 여기서 끝내지 않는다 — 리다이렉트 중 취소처럼 페이지가
      살아 있는 실패가 있어서, 응답 대기와 타임아웃에 판정을 맡긴다.
    */
    void page
      .goto(target, { waitUntil: "domcontentloaded", timeout: RESPONSE_TIMEOUT_MS })
      .catch(() => {
        /* 판정은 위 타임아웃이 한다. */
      });
  });

  if (hit === null) return "unavailable";
  // 400 = 그런 닉네임 없음. **정상 응답이다**(실측 2026-09-03).
  if (hit.status === 400) return "missing";
  if (hit.status < 200 || hit.status >= 300) return "unavailable";

  return parseScouterBody(name, hit.body) ?? "unavailable";
}

// ─────────────────────────────────────────────────────────────────────────────
// 캐시
// ─────────────────────────────────────────────────────────────────────────────

/** 표에서 읽어 온 한 행을 `ScouterStats` 로 접는다. */
function rowToStats(
  name: string,
  row: {
    character_class: string | null;
    character_level: number | null;
    world_name: string | null;
    boss_stat: number | null;
    hexa_stat: number | null;
    authentic_symbols: number[] | null;
    grand_authentic_symbols: number[] | null;
    authentic_force: number | null;
  },
): ScouterStats {
  /*
    ★ **모든 칸에 `?? null` 을 건다.** 타입상 `undefined` 는 올 수 없지만, `readCache` 의
      select 목록에서 컬럼 이름이 하나 빠지는 날 그 칸은 `undefined` 가 되고, 답장을
      만드는 `scouterSummary` 의 가드는 `=== null` 이라 그걸 통과시켜 방에
      **`Lv.undefined`** 가 나간다. 여기서 한 번 접어 두는 비용이 0이라 그냥 접는다 —
      값의 모양을 바로잡는 자리는 값이 밖에서 들어오는 이 함수다.
  */
  return {
    name,
    characterClass: row.character_class ?? null,
    characterLevel: row.character_level ?? null,
    worldName: row.world_name ?? null,
    bossStat: row.boss_stat ?? null,
    hexaStat: row.hexa_stat ?? null,
    authenticSymbols: row.authentic_symbols ?? [],
    grandAuthenticSymbols: row.grand_authentic_symbols ?? [],
    authenticForce: row.authentic_force ?? null,
  };
}

/**
 * 캐시를 먼저 보고, 필요할 때만 크롬을 띄운다. **`!환산` 이 부르는 것은 이쪽이다.**
 *
 * 판정 순서와 근거:
 *   1. 30분 안에 받아 둔 값이 있으면 그대로 준다(양성 적중).
 *   2. 24시간 안에 "없음" 을 받았으면 그대로 `"missing"`(음성 적중). 크롬을 띄우지 않는다.
 *   3. 그 밖에는 실제로 연다.
 *
 * ★ **조회가 `"unavailable"` 인데 낡은 값이라도 있으면 그 낡은 값을 준다.** 환산 스탯은
 *   장비를 갈아입어야 변하는 값이라 30분 지난 숫자도 여전히 쓸 만하고, 사람에게는
 *   "못 가져왔어요" 보다 "조금 지난 값" 이 언제나 낫다.
 * ★ **캐시 사고가 답장을 막지 않는다.** DB 읽기/쓰기가 실패해도 조회는 그대로 진행하고
 *   답장도 그대로 나간다 — 캐시는 비용을 줄이는 장치이지 기능의 일부가 아니다.
 */
export async function loadScouterStats(
  db: AdminDb,
  name: string,
  now: Date,
): Promise<ScouterLookup> {
  const cached = await readCache(db, name);

  if (cached !== null) {
    const fetchedAt = cached.fetched_at === null ? null : Date.parse(cached.fetched_at);
    if (fetchedAt !== null && Number.isFinite(fetchedAt)) {
      if (now.getTime() - fetchedAt < POSITIVE_TTL_MS) return rowToStats(name, cached);
    }
    const missingAt = cached.missing_at === null ? null : Date.parse(cached.missing_at);
    if (missingAt !== null && Number.isFinite(missingAt)) {
      if (now.getTime() - missingAt < NEGATIVE_RETRY_MS) return "missing";
    }
  }

  const fresh = await fetchScouterStats(name);

  if (fresh === "unavailable") {
    // 우리 사정이다. **한 줄도 적지 않는다** — 적으면 멀쩡한 닉네임이 하루 동안 "없음" 이 된다.
    if (cached !== null && cached.fetched_at !== null) return rowToStats(name, cached);
    return "unavailable";
  }

  await writeCache(db, name, fresh, now);
  return fresh;
}

interface ScouterCacheRow {
  readonly character_class: string | null;
  readonly character_level: number | null;
  readonly world_name: string | null;
  readonly boss_stat: number | null;
  readonly hexa_stat: number | null;
  readonly authentic_symbols: number[] | null;
  readonly grand_authentic_symbols: number[] | null;
  readonly authentic_force: number | null;
  readonly fetched_at: string | null;
  readonly missing_at: string | null;
}

async function readCache(db: AdminDb, name: string): Promise<ScouterCacheRow | null> {
  const { data, error } = await db
    .from("scouter_stat_cache")
    /*
      ⚠️ 이 문자열은 **한 덩이 리터럴이어야 한다.** `"a, b" + "c, d"` 로 쪼개면
         supabase-js 의 타입 추론이 컬럼을 못 읽어 결과가 `GenericStringError` 로 떨어진다
         (실제로 typecheck 가 그렇게 터졌다).
    */
    .select(
      "character_class, character_level, world_name, boss_stat, hexa_stat, authentic_symbols, grand_authentic_symbols, authentic_force, fetched_at, missing_at",
    )
    .eq("name", name)
    .maybeSingle();

  if (error !== null) {
    console.error("[bot/scouter] 캐시 읽기 실패:", error.message);
    return null;
  }
  return data;
}

async function writeCache(
  db: AdminDb,
  name: string,
  result: ScouterStats | "missing",
  now: Date,
): Promise<void> {
  /*
    ★ **성공은 `missing_at` 을 지우고, 없음은 값 칸을 지운다.** 부분 갱신으로 두면 어제
      찾아 둔 스탯이 오늘 "없음" 인 행에 그대로 남아, 이름을 바꾼 사람의 옛 스펙이 계속
      나간다. 한 행은 언제나 **한 가지 사실**만 말해야 한다.
  */
  const row: Database["public"]["Tables"]["scouter_stat_cache"]["Insert"] =
    result === "missing"
      ? {
          name,
          character_class: null,
          character_level: null,
          world_name: null,
          boss_stat: null,
          hexa_stat: null,
          authentic_symbols: null,
          grand_authentic_symbols: null,
          authentic_force: null,
          fetched_at: null,
          missing_at: now.toISOString(),
        }
      : {
          name,
          character_class: result.characterClass,
          character_level: result.characterLevel,
          world_name: result.worldName,
          boss_stat: result.bossStat,
          hexa_stat: result.hexaStat,
          authentic_symbols: [...result.authenticSymbols],
          grand_authentic_symbols: [...result.grandAuthenticSymbols],
          authentic_force: result.authenticForce,
          fetched_at: now.toISOString(),
          missing_at: null,
        };

  const { error } = await db.from("scouter_stat_cache").upsert(row, { onConflict: "name" });
  if (error !== null) {
    // 캐시는 비용 절감 장치다. 못 적었다고 답장을 막지 않는다.
    console.error("[bot/scouter] 캐시 쓰기 실패:", error.message);
  }
}
