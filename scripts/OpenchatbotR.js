/**
 * ═════════════════════════════════════════════════════════════════════════════
 * M_Schedule — 메신저봇R 글루 (카카오톡)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 방에서 온 `!명령` 을 우리 서버 `/api/bot/command` 로 넘기고, 돌려받은 `reply` 를 그대로
 * 방에 뿌린다. 텔레그램 글루(`telegram-glue.mjs`)와 **하는 일이 똑같다** — 서버 계약이
 * 런너 비종속이라 서버는 0줄 바뀌지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 이 파일은 **ES5 로만 쓴다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 메신저봇R 의 Rhino 는 구형 ECMA-262 라 ES6 문법을 거부한다. 처음에 ES6 로 썼다가
 * 실기에서 오류가 쏟아졌고, 원인은 셋이었다:
 *
 *   · **마지막 쉼표(trailing comma)** — 객체·배열 리터럴에서 불법이다
 *   · **`for (const k in ...)`** — for-in 초기자에 const/let 을 못 쓴다
 *   · **`const` 재선언** — 블록 스코프가 없어 함수마다 쓴 같은 이름이 충돌한다
 *
 * 그래서 이 파일에는 `var` 만 쓰고, 화살표 함수·템플릿 리터럴·for...of 도 쓰지 않는다.
 * 고칠 때 이 규칙을 깨면 **컴파일 단계에서 바로 터진다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 넣기 전에 알아야 할 것
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 카카오톡 운영정책은 봇·매크로 프로그램 이용을 금지한다. 위반 시 **카카오톡 전체
 *    서비스** 이용 제한 대상이고, 2021-03-03 에 봇 계정과 **소유자 본계정까지** 정지된
 *    전례가 있다. 방 자체가 제재받아 다른 참여자에게 영향이 갈 수도 있다.
 *    → **반드시 부계정 + 전용 단말**에서 돌린다.
 *
 * ⚠️ 이 방식은 **알림을 읽어서** 동작한다. 봇 폰에서 그 방 화면을 열어 두면 알림이 안 떠
 *    봇이 반응하지 않는다. 알림 미리보기 끄기 금지, 배터리 최적화 제외 필수.
 *
 * ⚠️ 발신자 식별이 **닉네임뿐**이다. 방에서 닉네임을 바꾸면 `!연결` 이 끊긴다.
 *    방 이름을 바꾸면 재페어링이 필요하다. 둘 다 Iris 로 옮기면 사라지는 한계다.
 */

var CONFIG = {
  BASE_URL: "https://mapleschedule.vercel.app",
  /** 명령 응답 예산(ms). 서버 설계 기준 3초. 넘으면 포기한다 — 재시도 큐는 없다. */
  COMMAND_TIMEOUT: 3000,
  /**
   * 타이머가 **깨어나는** 주기(ms). 이때마다 서버를 부르는 것이 **아니다.**
   *
   * 실제 호출 여부는 방마다 서버가 알려 준 `pollIntervalSec` 이 정한다(아래 `POLL_STATE`).
   * 이 값은 그 예정 시각을 얼마나 촘촘히 확인할지일 뿐이라, 깨어나서 하는 일은 시각 비교
   * 하나다 — 네트워크도 배터리도 쓰지 않는다. 15초면 서버가 30초를 주문했을 때 최대
   * 15초까지만 늦는다.
   */
  POLL_TICK_MS: 15000,
  /** 방↔채널 매핑 저장 경로. 지우면 재페어링이 필요하다. */
  STATE_PATH: "sdcard/msgbot/mschedule-state.json"
};

// ─────────────────────────────────────────────────────────────────────────────
// 자바 상호운용 — Rhino 가 Java 클래스에 직접 접근한다는 점에 전적으로 기댄다
// ─────────────────────────────────────────────────────────────────────────────

var JavaMac = javax.crypto.Mac;
var JavaKeySpec = javax.crypto.spec.SecretKeySpec;
var JavaDigest = java.security.MessageDigest;
var JavaString = java.lang.String;

/** 부호 있는 자바 바이트 배열 → 소문자 hex. padStart 가 없어 직접 채운다. */
function toHex(bytes) {
  var out = "";
  var i;
  for (i = 0; i < bytes.length; i++) {
    var v = bytes[i] & 0xff;
    if (v < 16) out += "0";
    out += v.toString(16);
  }
  return out;
}

function sha256Hex(text) {
  var md = JavaDigest.getInstance("SHA-256");
  return toHex(md.digest(new JavaString(text).getBytes("UTF-8")));
}

function hmacSha256Hex(secret, message) {
  var mac = JavaMac.getInstance("HmacSHA256");
  mac.init(new JavaKeySpec(new JavaString(secret).getBytes("UTF-8"), "HmacSHA256"));
  return toHex(mac.doFinal(new JavaString(message).getBytes("UTF-8")));
}

/**
 * 서버 `signature.ts` 의 `canonicalize` 와 **한 글자도 달라지면 안 된다.**
 * 키를 정렬한 결정적 JSON. 원문 바이트를 해싱하지 않는 이유는 서버 주석에 있다 —
 * 직렬화 공백·키 순서가 클라이언트마다 다르기 때문이다.
 */
function canonicalize(value) {
  if (value === null) return "null";

  if (Object.prototype.toString.call(value) === "[object Array]") {
    var items = [];
    var i;
    for (i = 0; i < value.length; i++) items.push(canonicalize(value[i]));
    return "[" + items.join(",") + "]";
  }

  if (typeof value === "object") {
    var keys = [];
    var k;
    for (k in value) {
      if (Object.prototype.hasOwnProperty.call(value, k) && value[k] !== undefined) {
        keys.push(k);
      }
    }
    keys.sort();
    var parts = [];
    var j;
    for (j = 0; j < keys.length; j++) {
      parts.push(JSON.stringify(keys[j]) + ":" + canonicalize(value[keys[j]]));
    }
    return "{" + parts.join(",") + "}";
  }

  var encoded = JSON.stringify(value);
  return encoded === undefined ? "null" : encoded;
}

/** `{timestamp}.{nonce}.{METHOD}.{path}.{sha256(body)}` */
function signatureBase(timestamp, nonce, method, path, bodyHash) {
  return [String(timestamp), nonce, method.toUpperCase(), path, bodyHash].join(".");
}

function nowSeconds() {
  return Math.floor(java.lang.System.currentTimeMillis() / 1000);
}

function newNonce() {
  return String(java.util.UUID.randomUUID().toString());
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP — 안드로이드 기본 스택(HttpURLConnection). Jsoup 을 쓰지 않는 이유는 아래.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ★ **Jsoup 을 쓰지 않는다** (2026-08-20).
 *
 *   원래는 `org.jsoup.Jsoup.connect()` 였고 한동안 잘 됐다. 그런데 갑자기 모든 명령이
 *   403 을 받기 시작했고, 응답 본문이 **우리 JSON 이 아니라 Astro 로 만든 HTML** 이었다
 *   — 즉 우리 서버가 아니라 **Vercel 앞단**이 막은 것이다. 같은 시각에
 *     · PC 에서 node 로 보낸 요청 (UA 를 Jsoup 으로 위장한 것 포함) → 정상
 *     · **같은 에뮬레이터 안에서 `curl` 로 보낸 요청** → 정상 (같은 공인 IP)
 *   이었다. 즉 IP 도 UA 도 아니고 **Jsoup 이 보내는 요청만** 걸렸다.
 *
 *   Jsoup 은 자바 자체 TLS 스택을 쓰고, 그 핸드셰이크 지문(JA3/JA4)은 브라우저·모바일과
 *   확연히 달라 봇 탐지의 표적이 된다. 그래서 **안드로이드 기본 HTTP 스택**
 *   (`HttpURLConnection` → 내부적으로 OkHttp + Conscrypt)으로 갈아탄다. 평범한 안드로이드
 *   앱과 같은 지문이 나가므로 이 부류에 걸릴 이유가 없다.
 *
 *   ⚠️ 이것은 **가설에 대한 조치**다. 지문이 원인이 아니었다면 증상이 그대로일 텐데,
 *      그때는 아래에서 남기는 `x-vercel-mitigated` / `x-vercel-id` 가 답을 준다.
 *      Vercel 이 막았다면 그 헤더에 이유가 실린다.
 */
function readStream(stream) {
  if (stream === null) return "";
  var reader = new java.io.BufferedReader(
    new java.io.InputStreamReader(stream, "UTF-8")
  );
  var out = new java.lang.StringBuilder();
  try {
    var line;
    // 줄바꿈을 **살린다** — `curl -i` 응답에서 헤더와 본문을 빈 줄로 갈라야 한다.
    while ((line = reader.readLine()) !== null) {
      out.append(line);
      out.append("\n");
    }
  } finally {
    try {
      reader.close();
    } catch (closeError) {
      // 닫기 실패는 응답 내용에 영향이 없다.
    }
  }
  return String(out.toString());
}

/*
  ═══════════════════════════════════════════════════════════════════════════════
  전송 계층 — **curl 이 1순위, 자바 스택이 2순위**
  ═══════════════════════════════════════════════════════════════════════════════

  왜 이 지경이 됐는지 남겨 둔다. 2026-08-20 에 모든 요청이 403 을 받기 시작했고,
  응답 헤더가 `x-vercel-mitigated: challenge` 였다 — **Vercel 이 자바스크립트 챌린지를
  요구**한 것이다. 봇 런너는 JS 를 실행할 수 없으니 영원히 통과하지 못한다.

  범인을 좁힌 기록(전부 같은 공인 IP, 같은 시각):

    · PC 에서 node — 기본 UA / Jsoup UA / 브라우저 UA  → **전부 통과**
    · 에뮬레이터 안에서 `curl` — UA 세 종류 전부        → **전부 통과**
    · 에뮬레이터 안에서 Jsoup                            → 403 challenge
    · 에뮬레이터 안에서 `HttpURLConnection`              → 403 challenge

  즉 IP 도 UA 도 아니고 **HTTP 클라이언트 자체**다. 자바 스택은 TLS 핸드셰이크 지문과
  HTTP/2 프레임 모양이 브라우저·curl 과 달라 봇 탐지의 표적이 된다. 우리가 Rhino 안에서
  그 지문을 바꿀 방법은 없다.

  그래서 **통과하는 것이 증명된 경로**를 쓴다. 안드로이드에는 `/system/bin/curl` 이 있고,
  Rhino 는 `Runtime.exec` 로 그것을 부를 수 있다.

  ★ **셸을 거치지 않는다.** 인자를 `String[]` 로 넘기므로 JSON 본문의 따옴표·공백·한글이
    셸에 해석될 여지가 없다. `exec("curl -d '" + json + "'")` 로 문자열을 이어 붙였다면
    본문 한 글자에 요청이 깨졌을 것이다.
  ★ curl 이 없는 단말(진짜 폰 등)에서는 **자바 스택으로 자동 폴백**한다. 거기서는 Vercel
    챌린지가 안 걸릴 수도 있고, 걸리더라도 이 파일이 죽는 것보다는 낫다.
*/

/** `null` = 아직 안 찾아봄, `""` = 찾았지만 없음. */
var CURL_PATH = null;

function findCurl() {
  if (CURL_PATH !== null) return CURL_PATH;
  var candidates = ["/system/bin/curl", "/system/xbin/curl", "/vendor/bin/curl"];
  var i;
  for (i = 0; i < candidates.length; i++) {
    try {
      if (new java.io.File(candidates[i]).exists()) {
        CURL_PATH = candidates[i];
        return CURL_PATH;
      }
    } catch (e) {
      // 접근 못 하는 경로는 없는 것으로 친다.
    }
  }
  CURL_PATH = "";
  return CURL_PATH;
}

/** `curl -i` 출력 → { status, headers, body }. 헤더와 본문은 **빈 줄**로 갈린다. */
function parseCurlResponse(text) {
  var normalized = String(text).replace(/\r/g, "");
  var split = normalized.indexOf("\n\n");
  var head = split < 0 ? normalized : normalized.substring(0, split);
  var body = split < 0 ? "" : normalized.substring(split + 2);

  var lines = head.split("\n");
  var status = 0;
  var headers = {};
  var i;
  for (i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (i === 0) {
      var m = /^HTTP\/[\d.]+\s+(\d{3})/.exec(line);
      status = m ? parseInt(m[1], 10) : 0;
      continue;
    }
    var colon = line.indexOf(":");
    if (colon > 0) {
      headers[line.substring(0, colon).toLowerCase().replace(/^\s+|\s+$/g, "")] =
        line.substring(colon + 1).replace(/^\s+|\s+$/g, "");
    }
  }
  return { status: status, headers: headers, body: body };
}

/** curl 로 보낸다. curl 이 없거나 실행 자체가 실패하면 `null` → 호출부가 폴백한다. */
function curlJson(method, path, bodyObject, headers, timeoutMs) {
  var curl = findCurl();
  if (curl === "") return null;

  var seconds = Math.max(3, Math.ceil((timeoutMs || 10000) / 1000));
  var args = [
    curl,
    "-s",
    "-i",
    "--max-time",
    String(seconds),
    "-X",
    method === "POST" ? "POST" : "GET",
    "-A",
    "M_Schedule-glue/1.0",
    "-H",
    "Accept: application/json"
  ];

  if (headers) {
    var h;
    for (h in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, h)) {
        args.push("-H");
        args.push(h + ": " + headers[h]);
      }
    }
  }
  if (bodyObject !== null && bodyObject !== undefined) {
    args.push("-H");
    args.push("Content-Type: application/json");
    args.push("--data-binary");
    // ★ 셸을 안 거치므로 이 문자열은 **그대로** 인자 하나로 전달된다.
    args.push(JSON.stringify(bodyObject));
  }
  args.push(CONFIG.BASE_URL + path);

  var out;
  try {
    var proc = java.lang.Runtime.getRuntime().exec(args);
    out = readStream(proc.getInputStream());
    readStream(proc.getErrorStream()); // 버퍼가 차서 프로세스가 멈추는 것을 막는다
    proc.waitFor();
  } catch (execError) {
    Log.e("curl 실행 실패(자바 스택으로 폴백): " + execError);
    return null;
  }

  var parsed = parseCurlResponse(out);
  if (parsed.status === 0) {
    Log.e("curl 응답을 해석하지 못했습니다(자바 스택으로 폴백)");
    return null;
  }

  var json = null;
  try {
    json = JSON.parse(parsed.body);
  } catch (parseError) {
    json = null;
  }

  return {
    status: parsed.status,
    json: json,
    text: parsed.body,
    mitigated: parsed.headers["x-vercel-mitigated"] || "",
    requestId: parsed.headers["x-vercel-id"] || "",
    via: "curl"
  };
}

function httpJson(method, path, bodyObject, headers, timeoutMs) {
  var viaCurl = curlJson(method, path, bodyObject, headers, timeoutMs);
  if (viaCurl !== null) return viaCurl;
  return httpJsonViaJava(method, path, bodyObject, headers, timeoutMs);
}

function httpJsonViaJava(method, path, bodyObject, headers, timeoutMs) {
  var url = new java.net.URL(CONFIG.BASE_URL + path);
  var conn = url.openConnection();
  var timeout = timeoutMs || 10000;

  conn.setRequestMethod(method === "POST" ? "POST" : "GET");
  conn.setConnectTimeout(timeout);
  conn.setReadTimeout(timeout);
  conn.setInstanceFollowRedirects(true);
  /*
    ★ UA 에서 **`bot` 이라는 글자를 뺐다** (2026-08-20).
      처음엔 "정체를 숨기지 말자"는 생각으로 `M_Schedule-glue/1.0 (messengerbotr)` 를 썼는데,
      **`messengerbotr` 안에 `bot` 이 들어 있다.** UA 에 `bot` 이 있으면 잡는 것은 봇 필터의
      가장 흔한 규칙이라, 정직하려던 UA 가 스스로 표적이 된 꼴이었다.
      브라우저인 척하지는 않는다 — 그건 다른 종류의 거짓말이고, 필요하지도 않다.
      우리 이름은 그대로 밝히되 필터를 자극하는 낱말만 없앤다.
  */
  conn.setRequestProperty("User-Agent", "M_Schedule-glue/1.0 (android)");
  conn.setRequestProperty("Accept", "application/json");

  if (headers) {
    var h;
    for (h in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, h)) {
        conn.setRequestProperty(h, headers[h]);
      }
    }
  }

  if (bodyObject !== null && bodyObject !== undefined) {
    var payload = new java.lang.String(JSON.stringify(bodyObject)).getBytes("UTF-8");
    conn.setDoOutput(true);
    conn.setRequestProperty("Content-Type", "application/json");
    conn.setFixedLengthStreamingMode(payload.length);
    var out = conn.getOutputStream();
    try {
      out.write(payload);
      out.flush();
    } finally {
      try {
        out.close();
      } catch (closeError) {
        // 이미 보낸 뒤라 닫기 실패는 무해하다.
      }
    }
  }

  var status = conn.getResponseCode();
  // 4xx·5xx 는 본문이 `getInputStream` 이 아니라 `getErrorStream` 으로 온다.
  var text = readStream(status >= 400 ? conn.getErrorStream() : conn.getInputStream());

  var parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch (parseError) {
    parsed = null;
  }

  /*
    ★ 진단 헤더를 함께 돌려준다. 403 의 원인이 우리인지 Vercel 인지를 가르는 것이
      `x-vercel-mitigated` 다 — 값이 있으면 앞단이 막은 것이 확정된다. 이게 없어서
      2026-08-20 사건에서 원인을 좁히는 데 한참 걸렸다.
  */
  var mitigated = conn.getHeaderField("x-vercel-mitigated");
  var requestId = conn.getHeaderField("x-vercel-id");

  try {
    conn.disconnect();
  } catch (disconnectError) {
    // 연결 정리 실패는 응답 처리에 영향이 없다.
  }

  return {
    status: status,
    json: parsed,
    text: text,
    mitigated: mitigated === null ? "" : String(mitigated),
    requestId: requestId === null ? "" : String(requestId),
    via: "java"
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 상태 — 방 이름 → { room, secret }
// ─────────────────────────────────────────────────────────────────────────────
//
// ⚠️ **방 이름이 키다.** 카톡 알림은 안정적인 방 id 를 주지 않는다.
// ⚠️ 이 파일에는 **채널 시크릿 원문**이 들어간다. 서버는 해시만 갖고 있어 다시 발급해 줄
//    수 없으므로, 지우면 방을 다시 페어링해야 한다.

var STATE = { chats: {} };

/**
 * 미연결 방 안내를 마지막으로 보낸 시각(방 이름 → epoch ms).
 * 디스크에 저장하지 않는다 — 재시작 뒤 첫 사용자에게는 다시 알려 주는 편이 맞다.
 */
var GUIDANCE_AT = {};
var GUIDANCE_COOLDOWN_MS = 10 * 60 * 1000;

function loadState() {
  try {
    var raw = FileStream.read(CONFIG.STATE_PATH);
    if (raw) STATE = JSON.parse(raw);
    if (!STATE.chats) STATE.chats = {};
  } catch (e) {
    STATE = { chats: {} };
  }
}

function saveState() {
  try {
    FileStream.write(CONFIG.STATE_PATH, JSON.stringify(STATE));
  } catch (e) {
    Log.e("상태 저장 실패: " + e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 서버 호출
// ─────────────────────────────────────────────────────────────────────────────

/** 401/404/409/429 는 **방에 아무 말도 하지 않는다** — 경고조차 도배가 된다. */
function explainStatus(status) {
  if (status === 400) return "요청 형식 오류(글루 버그일 가능성이 높음)";
  if (status === 401) return "서명 불일치. 서버의 BOT_SIGNING_SECRET 이 바뀌었으면 재페어링";
  /*
    ★ **원인을 단정하지 않는다.** 예전에는 "채널이 정지 상태입니다"라고 못박았는데,
      2026-08-20 09:35 에 이 문구가 나왔을 때 **채널은 정지된 적이 없었다**(DB 는
      status=active / suspended_until=null / 실패 0). 진짜 원인은 그 시각에 서버가
      배포 교체 중이었던 것이고, 서버 로그에는 그 요청이 아예 없었다 — 라우트에
      닿기도 전에 플랫폼이 막은 것이다. 확신에 찬 오답은 침묵보다 나쁘다.
  */
  if (status === 403) return "403 — 채널 정지이거나, 배포 교체·방화벽 등 서버 앞단이 막은 것";
  if (status === 404) return "서버가 모르는 room 입니다. 재페어링이 필요합니다";
  if (status === 409) return "nonce 재사용(리플레이로 판정됨)";
  if (status === 429) return "레이트리밋 초과";
  return "HTTP " + status;
}

/**
 * 요청 본문을 **매 시도마다 새로** 만든다.
 *
 * ★ 예전에는 만들어 둔 본문을 재시도에 그대로 다시 썼다. 그러면 `nonce` 가 같아서 서버가
 *   **리플레이로 보고 409** 를 준다 — 즉 재시도가 성공할 수 없는 구조였다. 타임스탬프도
 *   낡아 창 밖으로 나갈 수 있다.
 */
function buildCommandBody(chat, message, senderName) {
  var payload = {
    room: chat.room,
    sender: {
      // 카톡은 안정적인 발신자 id 를 주지 않는다. 닉네임이 유일한 단서다.
      id: "kakao:" + senderName,
      name: senderName.length > 100 ? senderName.substring(0, 100) : senderName
    },
    message: message.length > 1000 ? message.substring(0, 1000) : message,
    timestamp: nowSeconds(),
    nonce: newNonce()
  };
  var base = signatureBase(
    payload.timestamp,
    payload.nonce,
    "POST",
    "/api/bot/command",
    sha256Hex(canonicalize(payload))
  );
  // 서버는 `signature` 를 뺀 나머지로 서명을 계산한다. 필드를 더 실으면 어긋난다.
  return {
    room: payload.room,
    sender: payload.sender,
    message: payload.message,
    timestamp: payload.timestamp,
    nonce: payload.nonce,
    signature: "v1=" + hmacSha256Hex(chat.secret, base)
  };
}

/**
 * **403 도 한 번은 다시 시도한다.**
 *
 * 403 은 우리 서버의 채널 정지일 수도 있지만, 서버 앞단(배포 교체·방화벽)이 낸 것일 수도
 * 있다. 뒤엣것은 몇 초면 지나간다 — 실제로 2026-08-20 09:35 에 배포 교체 창에서 한 번
 * 맞았고, 그때 사용자에게는 "봇이 갑자기 죽었다"로 보였다. 한 번 더 두드리면 그 부류는
 * 사용자 눈에 띄지 않고 지나간다. 진짜 정지라면 두 번째도 403 이라 손해는 2초뿐이다.
 *
 * 401(서명 불일치) · 404(모르는 방) · 409(리플레이) · 429(레이트리밋)는 **재시도하지
 * 않는다.** 원인이 그대로면 결과도 그대로이고, 두드릴수록 나빠지기만 한다.
 */
function isRetryableStatus(status) {
  return status >= 500 || status === 403;
}

function postCommand(chat, message, senderName) {
  var attempt;
  var res;
  for (attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      try {
        java.lang.Thread.sleep(2000);
      } catch (sleepError) {
        // 잠들지 못해도 그냥 바로 다시 시도한다.
      }
    }

    try {
      res = httpJson(
        "POST",
        "/api/bot/command",
        buildCommandBody(chat, message, senderName),
        null,
        CONFIG.COMMAND_TIMEOUT
      );
    } catch (e) {
      Log.e("서버 호출 실패: " + e);
      return null;
    }

    if (res.status === 200) return res.json;

    if (attempt === 0 && isRetryableStatus(res.status)) {
      Log.i("  -> HTTP " + res.status + " — 2초 뒤 한 번 더 시도합니다");
      continue;
    }

    Log.e("  -> " + explainStatus(res.status));
    if (res.mitigated) Log.e("  -> Vercel 이 막음: " + res.mitigated + " (" + res.requestId + ")");
    /*
      ★ **응답 본문을 남긴다.** 상태 코드만으로는 "우리 서버가 거절한 것"과 "앞단이 막은
        것"을 구분할 수 없다. 우리 오류는 JSON(`{"error":{"kind":...}}`)이고 플랫폼 오류는
        HTML 이라, 한 줄만 봐도 갈린다. 이게 없어서 09:35 사건의 원인을 찾는 데 한참
        걸렸다. 시크릿은 요청 쪽에만 있고 응답에는 없으므로 남겨도 안전하다.
    */
    Log.e("  -> 응답: " + String(res.text).substring(0, 200));
    return null;
  }
  return null;
}

function signedHeaders(chat, method, path, bodyObject) {
  var timestamp = nowSeconds();
  var nonce = newNonce();
  var bodyHash = sha256Hex(bodyObject === null ? "" : canonicalize(bodyObject));
  var sig = "v1=" + hmacSha256Hex(chat.secret, signatureBase(timestamp, nonce, method, path, bodyHash));
  return {
    "X-MS-Timestamp": String(timestamp),
    "X-MS-Nonce": nonce,
    "X-MS-Signature": sig
  };
}

/** 방 최초 연결. **부트스트랩이라 여기만 무서명**이고, 코드는 1회용·10분이다. */
function pairRoom(roomName, code) {
  var res;
  try {
    res = httpJson(
      "POST",
      "/api/bot/pair",
      {
        code: code,
        runner: "messengerbotr/1.0",
        // 방 이름 원문은 보내지 않는다. 같은 방인지 확인할 지문만 보낸다.
        roomFingerprint: sha256Hex("kakao:" + roomName)
      },
      null,
      10000
    );
  } catch (e) {
    return { ok: false, reason: "서버에 닿지 못했습니다: " + e };
  }

  if (res.status !== 200 && res.status !== 201) {
    if (res.status === 404) {
      return {
        ok: false,
        reason:
          "코드가 없거나·만료됐거나(10분)·이미 쓴 코드입니다.\n" +
          "혹시 [내 계정 연결 코드]를 쓰지 않으셨나요? 방 연결에는 [새 방 연결 코드]가 필요합니다."
      };
    }
    if (res.status === 500) {
      return {
        ok: false,
        reason: "서버 오류. 배포 환경에 BOT_SIGNING_SECRET 이 설정돼 있는지 확인해 주세요."
      };
    }
    return { ok: false, reason: explainStatus(res.status) };
  }

  STATE.chats[roomName] = { room: res.json.room, secret: res.json.secret };
  saveState();
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 아웃박스 — 선제 알림(일정 리마인더 · 정기 알림)
// ─────────────────────────────────────────────────────────────────────────────

/*
  ═══════════════════════════════════════════════════════════════════════════════
  폴링 간격은 **서버가 정한다**
  ═══════════════════════════════════════════════════════════════════════════════
  예전에는 30초 고정이었다. 실측(2026-08-20)에서 방 5개가 하루 14,400번을 두드렸는데
  그중 실제로 보낼 것이 있던 경우는 거의 없었다 — 예정된 런이 0건이고 정기 알림은 방
  하나에 하루 한 번뿐이었다.

  서버는 원래부터 응답에 `pollIntervalSec` 을 실어 보내고 있었고 **이 글루만 그걸 무시**
  했다(텔레그램 글루는 따르고 있었다). 이제 그 값을 지킨다. 서버는 다음 알림까지의 거리를
  재서 조용하면 5분, 발사 시각이 가까우면 30초를 준다 — **호출은 줄고 알림은 늦지 않는다.**

  ★ 실패하면 **점점 뜸하게** 시도한다(최대 10분). 서버가 죽었는데 30초마다 두드리는 것은
    복구를 돕지 않고 로그만 채운다.
  ★ 명령이 왔을 때는 **예정 시각을 무시하고 즉시** 비운다(`force`). 사람이 방에서 말을
    걸고 있다는 것은 그 방이 살아 있다는 가장 확실한 신호다.
*/
var DEFAULT_POLL_SEC = 30;
var MAX_BACKOFF_SEC = 600;

/** 방 이름 → { nextAt: epoch ms, sec: 초 }. **디스크에 남기지 않는다** — 재시작하면 즉시 한 번 돈다. */
var POLL_STATE = {};

function pollState(roomName) {
  if (!POLL_STATE[roomName]) {
    POLL_STATE[roomName] = { nextAt: 0, sec: DEFAULT_POLL_SEC };
  }
  return POLL_STATE[roomName];
}

function schedulePoll(roomName, seconds) {
  var st = pollState(roomName);
  st.sec = seconds;
  st.nextAt = java.lang.System.currentTimeMillis() + seconds * 1000;
}

function backoffPoll(roomName) {
  var st = pollState(roomName);
  schedulePoll(roomName, Math.min(st.sec * 2, MAX_BACKOFF_SEC));
}

function pumpOutbox(roomName, chat, force) {
  var st = pollState(roomName);
  if (!force && java.lang.System.currentTimeMillis() < st.nextAt) return;

  var path = "/api/bot/outbox?room=" + encodeURIComponent(chat.room) + "&max=5";
  var res;
  try {
    res = httpJson("GET", path, null, signedHeaders(chat, "GET", path, null), 10000);
  } catch (e) {
    backoffPoll(roomName);
    return;
  }
  if (res.status !== 200 || !res.json || !res.json.messages) {
    backoffPoll(roomName);
    return;
  }

  // ★ 서버가 말한 간격을 그대로 따른다. 없으면 예전 기본값으로 떨어진다.
  schedulePoll(roomName, res.json.pollIntervalSec || DEFAULT_POLL_SEC);

  var messages = res.json.messages;
  if (messages.length === 0) return;

  var results = [];
  var i;
  for (i = 0; i < messages.length; i++) {
    var item = messages[i];
    if (item.expiresAt <= nowSeconds()) {
      // 지난 알림은 가치가 음수다. 보내지 않고 처리한 것으로 마감한다.
      results.push({ id: item.id, status: "failed", error: "expired" });
      continue;
    }
    try {
      Api.replyRoom(roomName, item.reply);
      if (item.extra) {
        var j;
        for (j = 0; j < item.extra.length; j++) Api.replyRoom(roomName, item.extra[j]);
      }
      results.push({ id: item.id, status: "sent" });
    } catch (e) {
      results.push({ id: item.id, status: "failed", error: String(e).substring(0, 200) });
    }
  }

  var ackBody = { room: chat.room, results: results };
  try {
    // ack 는 멱등하다 — 응답을 못 받아도 마음 놓고 다시 보낼 수 있다.
    httpJson(
      "POST",
      "/api/bot/outbox/ack",
      ackBody,
      signedHeaders(chat, "POST", "/api/bot/outbox/ack", ackBody),
      10000
    );
  } catch (e) {
    Log.e("ack 실패(다음 폴링에서 다시 나옵니다): " + e);
  }
}

function pumpAllOutboxes() {
  var roomName;
  for (roomName in STATE.chats) {
    if (!Object.prototype.hasOwnProperty.call(STATE.chats, roomName)) continue;
    try {
      pumpOutbox(roomName, STATE.chats[roomName]);
    } catch (e) {
      Log.e("아웃박스 처리 실패(" + roomName + "): " + e);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 메시지 처리
// ─────────────────────────────────────────────────────────────────────────────

/** `/명령` 도 `!명령` 으로 받는다. 방마다 습관이 다르다. */
function normalizeCommand(text) {
  var trimmed = String(text).replace(/^\s+/, "").replace(/\s+$/, "");
  var head = trimmed.charAt(0);
  if (head !== "!" && head !== "/") return null;
  var body = trimmed.substring(1);
  if (body === "") return null;
  return "!" + body;
}

/** 로그에 명령 **머리만** 남긴다. `!연결 <코드>` 의 코드가 로그에 찍히면 안 된다. */
function commandHead(text) {
  var parts = text.split(/\s+/);
  return parts.length > 0 ? parts[0] : text;
}

function handleMessage(roomName, text, senderName, replier) {
  var command = normalizeCommand(text);
  if (command === null) return; // 일반 대화 — 여기서 버린다. 서버에 가지 않는다.

  var chat = STATE.chats[roomName];

  // ── 런너 로컬 명령: 서버로 보내지 않고 코드도 로그에 남기지 않는다 ──────────
  if (command.indexOf("!페어링") === 0) {
    var code = command.split(/\s+/)[1];
    if (!code) {
      replier.reply("사용법: !페어링 <웹에서 받은 6자리 코드>");
      return;
    }
    Log.i("[" + roomName + "] !페어링 요청");
    var paired = pairRoom(roomName, code);
    replier.reply(
      paired.ok
        ? "연결됐습니다.\n이제 !도움말 을 쳐 보세요.\n각자 웹에서 [내 계정 연결 코드]를 받아 !연결 <코드> 로 본인 확인을 해야 개인 정보가 나옵니다."
        : "연결 실패 — " + paired.reason
    );
    return;
  }

  if (command === "!방정보") {
    replier.reply(
      chat
        ? "연결됨\nroom: " + chat.room
        : "이 방은 아직 서버에 연결되지 않았습니다.\n" +
            CONFIG.BASE_URL +
            "\n채팅방 연결 > [새 방 연결 코드] 를 받아 !페어링 <코드> 를 입력하세요."
    );
    return;
  }

  if (!chat) {
    /*
      ★ **미연결 방 안내는 방당 10분에 한 번만 한다.**
        통째로 침묵하면 "봇이 죽었나"로 보이지만, 활발한 방에서는 매번 답하는 것이 곧
        도배다. 3000개씩 쌓이는 방에서 누가 `/ㅋㅋ` 만 쳐도 8줄이 나간다.
        한 번은 말해 주되 되풀이하지 않는 것이 두 요구를 다 만족한다.
      ★ 쿨다운은 메모리에만 둔다. 재시작 뒤 첫 사용자에게는 다시 알려 주는 편이 맞다.
    */
    var last = GUIDANCE_AT[roomName] || 0;
    var nowMs = java.lang.System.currentTimeMillis();
    if (nowMs - last < GUIDANCE_COOLDOWN_MS) return;
    GUIDANCE_AT[roomName] = nowMs;

    replier.reply(
      "이 방은 아직 서버에 연결되지 않았습니다. 먼저 방을 연결해 주세요.\n\n" +
        CONFIG.BASE_URL +
        "\n-> 채팅방 연결 > [새 방 연결 코드]\n" +
        "-> 여기서 !페어링 <코드>\n\n" +
        "※ 코드가 두 종류입니다. 방 연결에는 반드시\n" +
        "  [새 방 연결 코드] 를 쓰세요.\n" +
        "  [내 계정 연결 코드] 는 방 연결이 끝난 뒤 !연결 에 씁니다."
    );
    return;
  }

  Log.i("[" + roomName + "] " + commandHead(command) + " <- " + senderName);
  var answer = postCommand(chat, command, senderName);
  if (answer === null) return; // 실패는 침묵. 재시도 큐에 넣지 않는다.
  if (answer.reply === null || answer.reply === undefined) {
    Log.i("  -> 침묵(미인식 명령)");
    return;
  }

  replier.reply(answer.reply);
  if (answer.extra) {
    var e;
    for (e = 0; e < answer.extra.length; e++) replier.reply(answer.extra[e]);
  }

  /*
    ★ 명령이 올 때 아웃박스도 함께 비운다. 타이머가 죽어 있어도 방이 살아 있으면 알림이
      나가도록 하는 **두 번째 줄**이다.
  */
  try {
    // 사람이 말을 걸었다 = 그 방이 확실히 살아 있다. 예정 시각을 무시하고 즉시 비운다.
    pumpOutbox(roomName, chat, true);
  } catch (err) {
    Log.e("아웃박스 처리 실패: " + err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 자가 검사 — **HMAC 이 되는지가 이 방식 전체의 성립 조건이다**
// ─────────────────────────────────────────────────────────────────────────────
//
// 조사 단계에서 "Rhino 가 HMAC-SHA256 을 낼 수 있는가"가 미확인으로 남아 있었다. 안 되면
// 서명이 성립하지 않아 설계 자체를 바꿔야 하므로, 켜자마자 여기서 판정한다.

function selfTest() {
  Log.i("== M_Schedule 글루 자가 검사 ==");

  try {
    // 표준 벡터: HMAC-SHA256(key="key", msg="The quick brown fox jumps over the lazy dog")
    var mac = hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog");
    if (mac !== "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8") {
      Log.e("HMAC 결과가 표준 벡터와 다릅니다: " + mac);
      return false;
    }
    Log.i("  HMAC-SHA256  OK");
  } catch (e) {
    Log.e("  HMAC-SHA256  실패 — 사용할 수 없습니다: " + e);
    Log.e("  -> 이 방식으로는 서명을 만들 수 없습니다. 설계를 바꿔야 합니다.");
    return false;
  }

  try {
    var dig = sha256Hex("abc");
    if (dig !== "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad") {
      Log.e("SHA-256 결과가 표준 벡터와 다릅니다: " + dig);
      return false;
    }
    Log.i("  SHA-256      OK");
  } catch (e2) {
    Log.e("  SHA-256      실패: " + e2);
    return false;
  }

  // 서버와 같은 결정적 JSON 이 나오는지. 키 정렬이 어긋나면 모든 서명이 401 이 된다.
  var canon = canonicalize({ b: 1, a: { d: [1, 2], c: "x" } });
  if (canon !== '{"a":{"c":"x","d":[1,2]},"b":1}') {
    Log.e("  canonicalize 실패: " + canon);
    return false;
  }
  Log.i("  canonicalize OK");

  try {
    // 없는 코드라 404 가 정상이다. 서버에 닿았다는 뜻이면 충분하다.
    var probe = httpJson("POST", "/api/bot/pair", { code: "ZZZZZZ" }, null, 10000);
    // 어느 전송 계층으로 나갔는지 함께 남긴다 — Vercel 챌린지 추적의 출발점이다.
    Log.i("  서버 연결     OK (HTTP " + probe.status + ", " + probe.via + ")");
  } catch (e3) {
    Log.e("  서버 연결     실패: " + e3);
    return false;
  }

  Log.i("== 통과. 방에서 !페어링 <코드> 로 시작하세요 ==");
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 진입점
// ─────────────────────────────────────────────────────────────────────────────

loadState();
var READY = selfTest();

/*
  아웃박스 폴링 타이머.

  ★ 메신저봇R 의 앱 API 에 기대지 않고 `java.util.Timer` 를 쓴다. 앱 버전마다 스케줄러
    API 가 달라 "있는 줄 알았는데 없는" 사고가 나기 쉽고, Timer 는 Rhino 가 Java 에
    직접 닿는다는 사실 하나에만 기댄다.
  ★ 그래도 타이머가 죽을 수 있으므로, 명령이 올 때마다 한 번 더 비운다(handleMessage).
*/
if (READY) {
  var outboxTimer = new java.util.Timer();
  outboxTimer.scheduleAtFixedRate(
    new java.util.TimerTask({
      run: function () {
        try {
          pumpAllOutboxes();
        } catch (e) {
          Log.e("아웃박스 타이머 실패: " + e);
        }
      }
    }),
    CONFIG.POLL_TICK_MS,
    CONFIG.POLL_TICK_MS
  );
}

/**
 * 진입점 — **API1 과 API2 를 모두 받는다.**
 *
 * ★ 실기에서 `ReferenceError: "BotManager" is not defined` (586행) 로 죽었다. 그 봇이
 *   **구형 API1 모드**로 돌고 있었기 때문이다. `BotManager` 와 `Event` 는 API2 에만
 *   존재한다.
 *
 * ★ 앱 설정을 바꾸게 하는 대신 **양쪽을 다 지원한다.** 사용자가 봇을 어느 모드로
 *   만들었는지는 우리가 알 수 없고, 알아야 할 이유도 없다. 어느 쪽으로 켜도 그냥 돌아야
 *   한다. 한쪽만 지원하면 이 오류가 설치할 때마다 되풀이된다.
 *
 * ★ `typeof` 검사는 선언되지 않은 이름에도 안전하다 — 그래서 `BotManager` 가 없는
 *   API1 에서도 ReferenceError 가 나지 않는다. 이것이 이 분기의 요점이다.
 */

/** 두 API 가 공유하는 실제 처리부. 인자 이름만 다를 뿐 하는 일은 같다. */
function dispatch(roomName, content, senderName, replier) {
  if (!READY) return;
  try {
    handleMessage(String(roomName), String(content), String(senderName), replier);
  } catch (e) {
    Log.e("메시지 처리 실패: " + e);
  }
}

// ── API2 (메신저봇R 최신) ────────────────────────────────────────────────────
//
// ★ `typeof` 조차 try 로 감싼다. **선언되지 않은 이름**에 쓰는 `typeof` 는 안전하지만,
//   `BotManager` 가 **감싸지지 않은 자바 객체로 존재**하면 Rhino 는 여기서도
//   `Invalid JavaScript value of type ...` 을 던진다(위 진입점에서 실제로 겪은 것과
//   같은 함정). 던졌다는 것은 곧 **존재한다**는 뜻이므로 그때는 API2 로 친다.
var HAS_API2 = false;
try {
  HAS_API2 = typeof BotManager !== "undefined";
} catch (probeError) {
  HAS_API2 = true;
}

if (HAS_API2) {
  try {
    var bot = BotManager.getCurrentBot();
    bot.addListener(Event.MESSAGE, function (chat) {
      dispatch(chat.room, chat.content, chat.author.name, chat);
    });
    Log.i("진입점: API2");
  } catch (listenerError) {
    // 붙이지 못했어도 아래 `response` 가 살아 있으므로 봇이 죽지는 않는다.
    Log.e("API2 리스너 등록 실패(response 로 계속합니다): " + listenerError);
  }
} else {
  Log.i("진입점: API1 대기 중 (BotManager 없음 — response 함수로 받습니다)");
}

/**
 * API1 진입점 — **위치 인자와 통합 파라미터를 모두 받는다.**
 *
 * ★ 1차 증상: `!페어링` 에 **아무 반응이 없었다.** 오류도 답장도 없었다. 원인은
 *   `bot.json` 의 `"useUnifiedParams": true` 였다. 이 모드에서 앱은 인자를 7개로
 *   넘기지 않고 **객체 하나**로 넘긴다. 그래서 `msg` 가 `undefined` 가 되고
 *   `normalizeCommand` 가 "!" 로 시작하지 않는다며 **조용히 버렸다.** 침묵이 정상
 *   경로였기 때문에 로그에도 아무것도 남지 않았다 — 이런 종류가 제일 찾기 어렵다.
 *
 * ★ 2차 증상: 모양을 `typeof` 로 판별했더니 이번엔
 *   `Invalid JavaScript value of type com.xfl.msgbot.script.ResponseParameters` 로
 *   죽었다. **Rhino 는 감싸지지 않은 자바 객체에 `typeof` 를 적용하면 예외를 던진다**
 *   (`ScriptRuntime.typeof` 가 Scriptable/CharSequence/Number/Boolean 이 아니면
 *   `msg.invalid.type` 을 던진다). 통합 파라미터는 JS 객체가 아니라 **자바 객체**라
 *   판별 코드 자체가 폭탄이었다.
 *
 *   → 그래서 **인자에는 `typeof` 를 절대 쓰지 않는다.** 대신 `arguments.length` 로
 *     가른다. 위치 인자는 7개, 통합 파라미터는 1개다. 속성 **읽기**는 안전하다 —
 *     Rhino 가 그때는 WrapFactory 로 감싸 주기 때문이다. 던지는 것은 `typeof` 뿐이다.
 *
 * ★ 앱이 **전역 `response` 함수**를 이름으로 찾으므로 조건문 안에 넣으면 안 된다.
 *   API2 모드에서는 앱이 이 함수를 부르지 않으므로 놀고 있을 뿐, 해가 없다.
 */
var SHAPE_LOGGED = false;

function response(a, b, c, d, e, f, g) {
  try {
    if (arguments.length >= 5) {
      // (room, msg, sender, isGroupChat, replier, imageDB, packageName)
      if (!SHAPE_LOGGED) {
        Log.i("진입점: API1 (위치 인자)");
        SHAPE_LOGGED = true;
      }
      dispatch(a, b, c, e);
      return;
    }

    if (!SHAPE_LOGGED) {
      Log.i("진입점: API1 (통합 파라미터)");
      SHAPE_LOGGED = true;
    }
    // 앱 버전에 따라 본문 키가 `msg` 이거나 `content` 다. `typeof` 없이 고른다.
    var text = a.msg;
    if (text === undefined || text === null) text = a.content;
    dispatch(a.room, text, a.sender, a.replier);
  } catch (err) {
    // 여기서 죽으면 원인이 안 보인다. 반드시 남긴다.
    Log.e("진입점 처리 실패: " + err);
  }
}
