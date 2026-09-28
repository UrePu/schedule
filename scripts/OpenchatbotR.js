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
 *    Iris 로 옮기면 사라지는 한계다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★★ 2026-09-28: **방(채널) 개념이 사라졌다** ★★
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지시: *"카톡의 방의 개념을 삭제. 닉네임으로 판별하여 연결하는거만 가능
 * !연결 ~~ 만 남기기. !페어링 필요 x. 그거에따른 리마인더 삭제. 알림 삭제."*
 *
 * 근거는 이 파일이 직접 겪은 일이다. 카톡 알림이 주는 방 식별자는 **방 이름 문자열**
 * 하나뿐이고 메시지 객체에 방 고유 번호가 없는데(API1·API2 실측), 2026-09-23 에 런너를
 * 실기 폰으로 옮긴 뒤 그 자리에 **말한 사람의 닉네임**이 실려 오기 시작했다. 상태 파일의
 * 키가 방 이름이라 같은 방에서 한 사람은 되고 다른 사람은 "연결 안 됨"을 받았다.
 * 정규화(`normalizeRoomKey`)와 `!별칭` 으로 메워 봤지만, 애초에 **식별할 수 없는 값을
 * 키로 쓰고 있었던 것**이다.
 *
 * 그래서 이 파일에서 통째로 사라진 것들:
 *   · `!페어링` · `!별칭` · `!방정보`  (전부 방을 다루는 런너 로컬 명령)
 *   · 상태 파일(`STATE.chats`) 과 방 키 정규화 — **저장할 것이 없다**
 *   · 아웃박스 폴링 타이머와 `Api.replyRoom` — 봇이 먼저 말을 거는 경로가 없어졌다
 *   · 방별 시크릿 — 인증은 아래 **설치 토큰 하나**다
 *
 * 답장은 이제 `replier.reply` 하나뿐이다. 그것은 **온 자리에 답하는 것**이라 방을 알
 * 필요가 없다 — 이 변경이 성립하는 이유의 전부가 이 한 줄이다.
 */

var CONFIG = {
  BASE_URL: "https://mapleschedule.vercel.app",

  /*
    ★ ═══════════════════════════════════════════════════════════════════════
      **설치 토큰 — 여기에 사람이 직접 적는다**
      ═══════════════════════════════════════════════════════════════════════
    서버 환경변수 `BOT_RUNNER_TOKEN` 과 **한 글자도 다르면 안 된다.** 모든 요청의 HMAC
    서명 키이고, 틀리면 전부 401 이 되며 방에는 아무 말도 나가지 않는다(침묵이 정상
    경로다 — 로그를 봐야 원인이 보인다).

    ⚠️ 이 값은 **이 파일 안에 평문으로 있다.** 폰을 남에게 넘기거나 스크립트를 공유하면
       그 사람이 우리 서버에 명령을 보낼 수 있다. 토큰을 갈아 끼우면 모든 런너가 한 번에
       무효가 되므로, 그때는 서버 환경변수와 이 줄을 같이 바꾼다.
    ⚠️ 32자 이상이어야 서버가 받는다. 생성:
         node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
  */
  RUNNER_TOKEN: "여기에-서버의-BOT_RUNNER_TOKEN-을-그대로-붙여넣으세요",

  /*
    메신저 종류. 서버에서 신원의 유일성이 `(platform, sender.id)` 라 함께 보낸다.
    ⚠️ **서명 대상에 들어간다.** 한 번 정하면 계속 같은 값을 보내야 한다.
  */
  PLATFORM: "kakao",

  /** 명령 응답 예산(ms). 서버 설계 기준 3초. 넘으면 포기한다 — 재시도 큐는 없다. */
  COMMAND_TIMEOUT: 3000
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
// 서버 호출
// ─────────────────────────────────────────────────────────────────────────────

/** 401/409/429 는 **방에 아무 말도 하지 않는다** — 경고조차 도배가 된다. */
function explainStatus(status) {
  if (status === 400) return "요청 형식 오류(글루 버그일 가능성이 높음)";
  if (status === 401) return "서명 불일치. CONFIG.RUNNER_TOKEN 이 서버의 BOT_RUNNER_TOKEN 과 같은지 확인";
  /*
    ★ **원인을 단정하지 않는다.** 예전에는 "채널이 정지 상태입니다"라고 못박았는데,
      2026-08-20 09:35 에 이 문구가 나왔을 때 **채널은 정지된 적이 없었다**(DB 는
      status=active / suspended_until=null / 실패 0). 진짜 원인은 그 시각에 서버가
      배포 교체 중이었던 것이고, 서버 로그에는 그 요청이 아예 없었다 — 라우트에
      닿기도 전에 플랫폼이 막은 것이다. 확신에 찬 오답은 침묵보다 나쁘다.
  */
  if (status === 403) return "403 — 채널 정지이거나, 배포 교체·방화벽 등 서버 앞단이 막은 것";
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
 *
 * ★ **`room` 이 없다**(2026-09-28). 서명 키도 방 시크릿이 아니라 `CONFIG.RUNNER_TOKEN`
 *   하나다. 서명 자체는 그대로 남는다 — 토큰만 보내면 요청 한 번을 캡처한 쪽이 그것을
 *   영원히 재생할 수 있고, 서명 + 타임스탬프 창 + nonce 가 그 창을 닫는다.
 */
function buildCommandBody(message, senderName) {
  var payload = {
    platform: CONFIG.PLATFORM,
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
    platform: payload.platform,
    sender: payload.sender,
    message: payload.message,
    timestamp: payload.timestamp,
    nonce: payload.nonce,
    signature: "v1=" + hmacSha256Hex(CONFIG.RUNNER_TOKEN, base)
  };
}

/**
 * **403 도 한 번은 다시 시도한다.**
 *
 * 403 은 서버 앞단(배포 교체·방화벽)이 낸 것일 수 있다. 그 부류는 몇 초면 지나간다 —
 * 실제로 2026-08-20 09:35 에 배포 교체 창에서 한 번 맞았고, 그때 사용자에게는 "봇이 갑자기
 * 죽었다"로 보였다. 한 번 더 두드리면 그 부류는 사용자 눈에 띄지 않고 지나간다.
 *
 * 401(서명 불일치 = **토큰이 틀렸다**) · 409(리플레이) · 429(레이트리밋)는 **재시도하지
 * 않는다.** 원인이 그대로면 결과도 그대로이고, 두드릴수록 나빠지기만 한다.
 */
function isRetryableStatus(status) {
  return status >= 500 || status === 403;
}

function postCommand(message, senderName) {
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
        buildCommandBody(message, senderName),
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
        HTML 이라, 한 줄만 봐도 갈린다. 토큰은 요청 쪽에만 있고 응답에는 없으므로 남겨도 안전하다.
    */
    Log.e("  -> 응답: " + String(res.text).substring(0, 200));
    return null;
  }
  return null;
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

/**
 * 명령 하나를 서버에 넘기고 답장을 그대로 방에 뿌린다. **이 함수가 전부다.**
 *
 * ★ 2026-09-28 에 앞부분이 통째로 사라졌다 — 방 키 조회 · `!페어링` · `!별칭` ·
 *   `!방정보` · 미연결 방 안내(10분 쿨다운)가 전부 **방을 다루는 코드**였다. 서버가 방을
 *   모르게 됐으므로 런너도 알 필요가 없다. 남은 것은 "! 로 시작하면 서버에 넘긴다"뿐이다.
 * ★ 답장은 `replier.reply` — **온 자리에 답한다.** 방 이름이 필요 없는 유일한 길이고,
 *   그래서 이 변경이 성립한다(`Api.replyRoom` 은 방 이름을 요구해서 함께 내려갔다).
 */
function handleMessage(text, senderName, replier) {
  var command = normalizeCommand(text);
  if (command === null) return; // 일반 대화 — 여기서 버린다. 서버에 가지 않는다.

  Log.i(commandHead(command) + " <- " + senderName);
  var answer = postCommand(command, senderName);
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

  /*
    ★ ═══════════════════════════════════════════════════════════════════════
      **토큰이 맞는지를 여기서 판정한다** (2026-09-28)
      ═══════════════════════════════════════════════════════════════════════
    예전 탐침은 `/api/bot/pair` 에 없는 코드를 던져 404 를 받는 것이었다. 그 경로가
    사라졌고, 더 중요하게는 **그 탐침이 인증을 시험하지 않았다**(페어링은 무서명이었다).
    그래서 설치에서 가장 흔한 실수 — `CONFIG.RUNNER_TOKEN` 을 안 바꿨거나 잘못 붙여넣은
    것 — 을 켤 때 잡지 못하고, 방에서 아무 반응이 없는 것으로 나타났다.

    이제는 **진짜 명령을 한 번 보낸다.** 알 수 없는 명령이라 서버는 `reply: null` 로
    침묵하지만(방에는 아무것도 안 나간다), 그 200 이 곧 "토큰과 서명이 맞다"는 증거다.
      · 200 → 통과
      · 401 → 토큰이 틀렸다. **여기서 멈춘다** — 이대로 켜 두면 모든 명령이 조용히 죽는다.
      · 그 밖 → 서버에 닿기는 했다. 켜 두고 로그를 본다(배포 교체 등 지나가는 것일 수 있다).
  */
  try {
    var probe = httpJson(
      "POST",
      "/api/bot/command",
      buildCommandBody("!자가검사", "runner-selftest"),
      null,
      10000
    );
    // 어느 전송 계층으로 나갔는지 함께 남긴다 — Vercel 챌린지 추적의 출발점이다.
    Log.i("  서버 연결     HTTP " + probe.status + " (" + probe.via + ")");
    if (probe.status === 401) {
      Log.e("  인증          실패 — CONFIG.RUNNER_TOKEN 이 서버의 BOT_RUNNER_TOKEN 과 다릅니다");
      return false;
    }
    if (probe.status === 200) {
      Log.i("  인증          OK");
    } else {
      Log.e("  인증          판정 불가(HTTP " + probe.status + "). 로그를 확인하세요");
      if (probe.mitigated) Log.e("  -> Vercel 이 막음: " + probe.mitigated);
    }
  } catch (e3) {
    Log.e("  서버 연결     실패: " + e3);
    return false;
  }

  Log.i("== 통과. 방에서 !도움말 을 쳐 보세요 ==");
  Log.i("   (각자 웹에서 [내 계정 연결 코드]를 받아 !연결 <코드> 를 해야 개인 정보가 나옵니다)");
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// 진입점
// ─────────────────────────────────────────────────────────────────────────────

var READY = selfTest();

/*
  ★ **타이머가 없다**(2026-09-28). 예전에는 `java.util.Timer` 가 15초마다 깨어나 방마다
    아웃박스를 비웠다 — 봇이 먼저 말을 거는 유일한 경로였고, `Api.replyRoom(방이름, …)` 로
    뿌리느라 방 이름이 반드시 필요했다. 알림이 사라지면서 타이머도, 그 요구도 사라졌다.
    이제 이 스크립트는 **사람이 칠 때만 깨어난다.**
*/

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

/*
  ═══════════════════════════════════════════════════════════════════════════════
  ★ **방 진단이 통째로 빠졌다** (2026-09-28)
  ═══════════════════════════════════════════════════════════════════════════════
  여기에는 `probeShape()`(메시지 객체가 방 고유 번호를 싣고 오는지 한 번 열거)와
  `[room] len=… fp=… name=…` 한 줄이 있었다. 둘 다 **방 이름 문자열을 키로 쓰던 시절의
  진단**이다 — "사람마다 다른 문자열이 실려 온다"를 잡으려고 넣었고, 실제로 그것을 잡았다.
  그 조사가 내린 결론이 *"방은 식별할 수 없다"* 였고, 그래서 방을 버렸다. 답이 나온
  질문의 진단은 로그만 채운다.

  ⚠️ 되살릴 일이 생긴다면 그건 방을 다시 쓰려는 때다. 그 전에 먼저 답해야 하는 것은
     여전히 같다 — **이 런너가 방을 무엇으로 식별하는가.** Iris 처럼 방 id 를 주는 런너로
     옮기지 않는 한 답은 없다.
*/

/** 두 API 가 공유하는 실제 처리부. 인자 이름만 다를 뿐 하는 일은 같다. */
function dispatch(content, senderName, replier) {
  if (!READY) return;
  try {
    handleMessage(String(content), String(senderName), replier);
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
      dispatch(chat.content, chat.author.name, chat);
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
      dispatch(b, c, e);
      return;
    }

    if (!SHAPE_LOGGED) {
      Log.i("진입점: API1 (통합 파라미터)");
      SHAPE_LOGGED = true;
    }
    // 앱 버전에 따라 본문 키가 `msg` 이거나 `content` 다. `typeof` 없이 고른다.
    var text = a.msg;
    if (text === undefined || text === null) text = a.content;
    dispatch(text, a.sender, a.replier);
  } catch (err) {
    // 여기서 죽으면 원인이 안 보인다. 반드시 남긴다.
    Log.e("진입점 처리 실패: " + err);
  }
}
