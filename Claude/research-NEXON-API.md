# 넥슨 오픈 API (메이플스토리) 실사양 조사

조사일: 2026-08-17
조사 방법: 넥슨이 배포하는 **공식 OpenAPI 3.0.3 YAML 스펙 원본**(`https://openapi.nexon.com/static/api/maplestory/*.yaml`) 8종 전량 다운로드 + 실제 HTTP 호출 실측.
문서 페이지(`openapi.nexon.com/ko/game/maplestory/?id=NN`)는 SPA라 본문이 렌더링되지 않으므로, 그 페이지가 내부적으로 로드하는 스펙 파일을 직접 받아 근거로 삼았다.

---

## 결론 요약

1. **"스케줄러 조회 API"는 실제로 존재한다.** `GET /maplestory/v1/scheduler/character-state` — 발주자의 주장은 착각이 아니다.
2. 응답의 `boss_contents[]`에는 보스명·난이도·**`registration_flag`(인게임 스케줄러 등록 = "이 보스 갈 거임")**·`complete_flag`(클리어 여부)가 들어있다. 발주자 설명과 정확히 일치한다.
3. **그러나 치명적 제약이 있다: "자신의 계정에 속한 캐릭터만 조회가 가능합니다."** 즉 내 API 키로는 **내 계정 캐릭터의 스케줄만** 읽을 수 있고, 남의 캐릭터 스케줄은 절대 못 읽는다. 이 앱의 핵심 가치인 "여러 사람 스케줄 겹쳐보기"는 API만으로 불가능하다.
4. **"몇 시에 갈지"(시각) 정보는 API에 전혀 없다.** 인게임 스케줄러는 시간표가 아니라 체크리스트다. 결정석 가격·메소 수익 데이터도 API 전역에 존재하지 않는다.
5. CORS는 전면 허용(실측 확인)이라 기술적으로는 브라우저 직접 호출이 가능하나, 약관 제5조가 API Key의 타인 제공을 원칙 금지하므로 **키 보관·대리호출 모델은 법적 리스크가 있다**(§제약사항 참조).

---

## 확인된 엔드포인트 표

**Base URL: `https://open.api.nexon.com`** (전 스펙 `servers[0].url` 동일)
**인증: 요청 헤더 `x-nxopen-api-key: <API KEY>` (String, 전 엔드포인트 필수)**
모든 엔드포인트는 `GET`이다. 쓰기(POST/PUT/DELETE) API는 **하나도 없다.**

### A. 스케줄러 — 이 프로젝트의 핵심

| 경로 | 용도 | 주요 파라미터 | 응답 핵심 필드 |
|---|---|---|---|
| `/maplestory/v1/scheduler/character-state` | 캐릭터의 스케줄러 수행 현황 조회 | `ocid`(필수, **자기 계정 캐릭터만**), `date`(YYYY-MM-DD, 생략 시 오늘) | `date`, `character_name`, `world_name`, `character_level`, `character_class`, `daily_contents[]`, `weekly_contents[]`, `boss_contents[]`, `weekly_boss_clear_count`, `weekly_boss_clear_limit_count` |

`boss_contents[]` 항목 구조 (스펙 원문 그대로):

| 필드 | 타입 | 설명 (원문) |
|---|---|---|
| `content_name` | string | 보스 명 |
| `difficulty` | string | 보스 난이도 |
| `cycle` | string | 보스 초기화 주기 |
| `list_order_no` | int64 | 리스트 순서 |
| `registration_flag` | string | **인게임 스케줄러 등록 여부 (true/false)** |
| `complete_flag` | string | **완료 여부 (true/false)** |

`daily_contents[]` / `weekly_contents[]` 항목 구조:

| 필드 | 타입 | 설명 (원문) |
|---|---|---|
| `content_name` | string | 콘텐츠/퀘스트 명 |
| `type` | string | 타입 (`'contents'`, `'quest'`) |
| `registration_flag` | string | 인게임 스케줄러 등록 여부 (true/false) |
| `now_count` | int64 | 현재 완료 횟수/점수 |
| `max_count` | int64 | 최대 완료 가능 횟수/점수 |
| `quest_state` | string | 퀘스트 진행 상태 (`"0"`:기타, `"1"`:진행 중, `"2"`:완료) |

> 스펙 주석 원문: `ocid` — "캐릭터 식별자<br>**자신의 계정에 속한 캐릭터만 조회가 가능합니다.**"
> `date` — "조회 기준일 (YYYY-MM-DD), 미입력 시 오늘 날짜<br>**캐릭터가 해당 기준일에 접속하지 않은 경우, 응답 결과가 없을 수 있음**"

### B. 캐릭터 식별 흐름 (캐릭터명 → ocid → 상세)

| 경로 | 용도 | 주요 파라미터 | 응답 핵심 필드 |
|---|---|---|---|
| `/maplestory/v1/character/list` | **계정의 보유 캐릭터 목록** (키 소유자 본인 계정) | 없음 (헤더만) | `account_list[].account_id`, `account_list[].character_list[]` = `{ocid, character_name, world_name, character_class, character_level}` |
| `/maplestory/v1/id` | 캐릭터명 → `ocid` 변환 (**타인 캐릭터도 조회 가능**) | `character_name`(필수) | `ocid` |
| `/maplestory/v1/character/basic` | 기본 정보 | `ocid`(필수), `date` | `character_name`, `world_name`, `character_gender`, `character_class`, `character_class_level`, `character_level`, `character_exp`, `character_exp_rate`, **`character_guild_name`**, `character_image` |
| `/maplestory/v1/user/achievement` | 계정 업적 정보 | 없음 (헤더만) | 업적 정보 |

캐릭터 상세 계열 (전부 `ocid` 필수 + `date` 선택, 이 앱과 직접 관련 낮음):
`/character/popularity`, `/character/stat`, `/character/hyper-stat`, `/character/propensity`, `/character/ability`, `/character/item-equipment`, `/character/cashitem-equipment`, `/character/symbol-equipment`, `/character/set-effect`, `/character/beauty-equipment`, `/character/android-equipment`, `/character/pet-equipment`, `/character/skill`, `/character/link-skill`, `/character/vmatrix`, `/character/hexamatrix`, `/character/hexamatrix-stat`, `/character/dojang`, `/character/other-stat`, `/character/ring-exchange-skill-equipment`, `/character/ring-reserve-skill-equipment`

### C. 길드 / 유니온 — "같이 가는 사람" 탐색용

| 경로 | 용도 | 주요 파라미터 | 응답 핵심 필드 |
|---|---|---|---|
| `/maplestory/v1/guild/id` | 길드명+월드 → `oguild_id` | `guild_name`(필수), `world_name`(필수, enum 18종) | `oguild_id` |
| `/maplestory/v1/guild/basic` | 길드 기본 정보 | `oguild_id`(필수), `date` | `guild_name`, `world_name`, `guild_level`, `guild_fame`, `guild_point`, `guild_master_name`, `guild_member_count`, `guild_user_count`, **`guild_member[]` (길드원 캐릭터명 배열)**, `guild_skill[]`, `guild_noblesse_skill[]` |
| `/maplestory/v1/user/union` | 유니온 정보 (**본인 계정**) | 없음 (헤더만) | `union_level`, `union_grade`, `union_artifact_level`, `union_artifact_exp`, `union_artifact_point` |
| `/maplestory/v1/user/union-raider` | 유니온 공격대 | 없음 (헤더만) | 공격대 배치 정보 |
| `/maplestory/v1/user/union-artifact` | 유니온 아티팩트 | 없음 (헤더만) | 아티팩트 정보 |
| `/maplestory/v1/user/union-champion` | 유니온 챔피언 | 없음 (헤더만) | 챔피언 정보 |

> **유니온은 "게임 내 길드 유니온"이 아니라 본인 계정의 캐릭터 육성 시스템이다.** 다른 사람을 알아내는 데 전혀 쓸 수 없다.
> **`guild_member[]`가 "같이 가는 사람" 후보를 얻을 수 있는 유일한 공개 경로다.** (캐릭터명 문자열 배열만 제공)

### D. 나머지 (참고)

| 경로군 | 용도 | 비고 |
|---|---|---|
| `/maplestory/v1/ranking/overall`, `/ranking/union`, `/ranking/guild`, `/ranking/dojang`, `/ranking/theseed`, `/ranking/achievement` | 랭킹 조회 | `date` 필수. `world_name`/`class`/`character_name`/`page` 등으로 필터. 캐릭터 탐색 보조 수단 |
| `/maplestory/v1/notice`, `/notice/detail`, `/notice-update`, `/notice-update/detail`, `/notice-event`, `/notice-event/detail`, `/notice-cashshop`, `/notice-cashshop/detail` | 공지/업데이트/이벤트/캐시샵 공지 | 점검 일정 파악에 활용 가능 |
| `/maplestory/v1/battle-practice/replay-id`, `/result`, `/skill-timeline`, `/character-info` | 연무장(보스 연습) 기록 | **실전 보스 클리어 이력이 아니다.** 연무장 시뮬레이션 전용 |
| `/maplestory/v1/ouid`, `/maplestory/legacy/ouid`, `/history/starforce`, `/history/potential`, `/history/cube` | 확률형 아이템 사용 이력 | 스타포스/잠재능력/큐브 |

---

## 제약사항

### 1. 요청 수 제한 (rate limit)

애플리케이션 타입별로 결정되며, **애플리케이션별로 합산**된다 (공식 가이드 원문: "API 허용량은 애플리케이션별로 합산됩니다").

| 애플리케이션 타입 | 초당 최대 허용량 | 1일 최대 허용량 |
|---|---|---|
| 개발 단계 | **5건 / 초** | **1,000건 / 일** |
| 서비스 단계 | **500건 / 초** | **20,000,000건 / 일** |

- 초과 시 `429 Too Many Requests` / `OPENAPI00007`.
- 애플리케이션당 API Key 최대 2개, 넥슨 ID당 동일 게임 애플리케이션 최대 3개.
- 서비스 단계 키는 유효한 서비스 URL + 애플리케이션 설명 + API 활용 목적을 모두 기재해야 발급된다.
- 개발 단계 → 서비스 단계 전환 시 **키를 새로 발급**받아야 한다.
- 1년 이상 미사용 키는 사전 안내 후 삭제될 수 있다 (약관 제7조 ②).

### 2. 데이터 갱신 주기와 지연 — **실시간이 아니다**

캐릭터/유니온/길드/연무장 스펙의 `info.description` 원문:

> - 메이플스토리 게임 데이터는 **평균 15분 후** 확인 가능합니다.
> - 과거 데이터는 원하는 일자를 입력해 조회할 수 있으며, **전일 데이터는 다음날 오전 2시부터** 확인할 수 있습니다. (12월 22일 데이터 조회 시, 22일 00시부터 23일 00시 사이 데이터가 조회 됩니다.)
> - **게임 콘텐츠 변경으로 ocid가 변경될 수 있습니다.** ocid 기반 서비스 갱신 시 유의해 주시길 바랍니다.
> - 해당 API는 메이플스토리 한국의 데이터가 제공됩니다.

- 캐릭터/길드 기본 정보: **2023년 12월 21일 데이터부터** 조회 가능.
- `date` 응답 형식: `"2023-12-21T00:00+09:00"` — **KST 고정, 일 단위(시·분은 일괄 0)**.
- 랭킹 API는 별도 규칙: 2023년 12월 22일 데이터부터, **오늘 랭킹은 오전 9시 30분경부터** 조회 가능, 종합 랭킹은 최근 2년치만.
- 공지 API는 실시간 조회 또는 최소 일배치 권장.

### 3. CORS — **허용됨 (실측 확인)**

`https://open.api.nexon.com`에 `Origin: https://example.com`을 붙여 실제 호출한 결과:

```
# GET 응답 헤더
access-control-allow-origin: https://example.com
access-control-allow-credentials: true
access-control-expose-headers: *

# OPTIONS(preflight) → HTTP 200
access-control-allow-methods: GET,HEAD,PUT,POST,DELETE,PATCH,OPTIONS
access-control-allow-headers: x-nxopen-api-key
vary: origin
```

**Origin을 그대로 반사(reflect)한다. 즉 브라우저에서 직접 호출 가능하며, CORS는 서버 프록시의 근거가 되지 못한다.**
그럼에도 프록시를 유지해야 할 별개의 근거는 아래 4가지다:

1. **Rate limit 보호** — 브라우저 직접 호출은 호출량 제어·백오프·중복 제거가 불가능하다. 개발 단계 키는 1,000건/일이라 금방 소진된다.
2. **캐시 계층** — 데이터가 15분 지연이므로 서버 캐시로 호출량을 크게 줄일 수 있다.
3. **키 노출면 축소** — localStorage의 키가 XSS/확장프로그램에 노출되면 그대로 유출된다.
4. **약관 준수 흔적** — 호출 주체·빈도를 서버에서 통제해야 약관 제5조 ⑧(과부하 유발 금지)을 보장할 수 있다.

→ CLAUDE.md §2의 "Route Handler 프록시 경유" 결정은 **유지가 타당하다. 다만 그 사유를 'CORS 때문'이 아니라 '호출량 통제·캐시·키 노출면 축소'로 고쳐 적어야 한다.**

### 4. 에러 응답 포맷과 에러 코드

응답 바디 형식 (실측):

```json
{"error":{"name":"OPENAPI00005","message":"The apikey is not valid."}}
```

스키마: `error.name`(에러 명), `error.message`(에러 설명). 전 엔드포인트 공통.

| 에러 코드 | 응답 코드 | 응답명 | 설명 |
|---|---|---|---|
| OPENAPI00001 | 500 | Internal Server Error | 서버 내부 오류 |
| OPENAPI00002 | 403 | Forbidden | 권한이 없는 경우 |
| OPENAPI00003 | 400 | Bad Request | 유효하지 않은 식별자 |
| OPENAPI00004 | 400 | Bad Request | 파라미터 누락 또는 유효하지 않음 |
| OPENAPI00005 | 400 | Bad Request | **유효하지 않은 API KEY** |
| OPENAPI00006 | 400 | Bad Request | 유효하지 않은 게임 또는 API PATH |
| OPENAPI00007 | 429 | Too Many Requests | API 호출량 초과 |
| OPENAPI00009 | 400 | Bad Request | 데이터 준비 중 |
| OPENAPI00010 | 400 | Bad Request | 게임 점검 중 |
| OPENAPI00011 | 503 | Service Unavailable | API 점검 중 |

> 공식 표에 `OPENAPI00008`, `OPENAPI00012`는 없다(가이드 표에 미기재). 페이지 소스에는 `OPENAPI00012` 문자열이 존재하나 설명이 없어 **미확인**으로 분류한다.

**실측한 중요한 동작 특성**: 키 검증이 경로 검증보다 **먼저** 수행된다. 존재하지 않는 경로(`/maplestory/v1/bogus/path`)에 무효 키를 보내도 `OPENAPI00006`이 아니라 `OPENAPI00005`가 돌아온다. → 무효 키 판별은 어떤 경로로도 가능하다.

### 5. API 키 발급 절차 / 키 종류

1. 넥슨 ID로 `openapi.nexon.com` 로그인
2. **내 애플리케이션 > 애플리케이션 등록** — 게임 선택, 애플리케이션 타입 선택(개발 단계 / 서비스 단계), 이용약관 동의
   - 개발 단계 기재 항목: 서비스명
   - 서비스 단계 기재 항목: 서비스명, 개발 환경, URL 정보, 소개, 대표 이미지
3. 등록 완료 시 **API Key 자동 발급** — 내 애플리케이션 > 애플리케이션 목록 > 상세 페이지에서 확인
4. 키 유출 시 상세 페이지에서 추가 발급 가능

### 6. 이용약관상 제약 — **가장 중요한 리스크**

**제5조 (이용자의 의무) ①②** (원문):

> ① 이용자는 자신이 발급 받은 API Key를 **타인에게 제공, 공개하거나 공유할 수 없습니다.** 단, **일부 API의 경우 API Key 소유자가 공개를 허용할 경우 API Key를 타인에게 제공할 수 있으며, 타인에게 제공 가능한 API Key는 Open API 공지사항 또는 내 애플리케이션 페이지를 통해 확인할 수 있습니다.**
> ② 이용자는 자신이 발급 받은 API Key가 타인에 의하여 도용 당하지 않도록 관리하여야 하며, **타인이 발급받은 API Key를 이용해서는 안 됩니다.** 단, (①과 동일한 예외 조항)

→ **원칙적으로 금지, 예외적으로 허용.** 우리 앱은 사용자 키를 받아 대신 호출하므로 정확히 이 조항의 사정권에 있다. 예외 조항이 적용되려면 (a) 키 소유자가 공개를 허용해야 하고 (b) 해당 API가 "타인 제공 가능" 목록에 있어야 한다. **그 목록의 실제 내용은 로그인 없이 접근 불가하여 확인하지 못했다(미확인 항목 참조).**

**제5조 ⑤** (원문):

> 이용자는 회사의 사전 동의 없이 API 서비스의 결과 데이터(...)를 본 약관에서 허용한 범위를 넘어서서 **무단으로 복제, 저장, 가공, 배포**하거나 프로그램 등을 통해 API 서비스를 다시 제3자에게 제공하는 행위는 할 수 없습니다.

→ 캐릭터 데이터를 우리 Supabase에 캐싱/저장하는 행위가 여기에 걸릴 수 있다. 완화 근거: 넥슨 게임 API 페이지 하단 고지 **"API를 통해 데이터를 크롤링한 경우 30일 이내에 크롤링한 데이터를 갱신해야 할 의무가 있습니다."** → **30일 이내 갱신을 전제로 한 캐싱은 사실상 허용**된다고 읽는 것이 합리적이다.

**제5조 ⑧**: 자동화 프로그램으로 주기적/지속적 접속을 시도해 과부하를 발생시키면 안 된다. → 백그라운드 폴링 주기 설계에 직접 영향.
**제5조 ③**: 서비스 유료화 시 홈페이지 안내 및 게임 IP 사용 가이드 준수 필요.
**제6조 ④ / 가이드**: 서비스에 **"Data based on NEXON Open API"** 문구를 명시해야 한다. **(필수)**
**제7조 ②**: 1년 이상 미사용 키는 삭제될 수 있다.
**제11조 ③**: 이용계약 해지·서비스 중단 시 결과 데이터 일체를 삭제해야 한다.
**제8조 ①**: 넥슨은 결과의 정확성·지속성을 보증하지 않는다.
약관 시행일: 2024년 9월 9일.

**대안 경로 — "게임 데이터 활용 로그인" (NEXON Open ID / 프렌즈 프로그램)**
넥슨은 사용자가 키를 넘기지 않고 넥슨 계정 로그인 동의만으로 서드파티에 게임 데이터를 제공하는 공식 메커니즘을 운영한다. 그러나 **"지정된 프렌즈 제작자"에게만 열려 있고**, 2025년 2월 27일 기준 승인 서비스는 MapleGG / 메아기 / 츄츄지지 / 메이플 히스토리 **4곳뿐**이다. 신규 진입은 `지원 > 프렌즈 프로그램 신청`을 거쳐야 한다.

**업계 관행 (법적 근거 아님, 참고용)**: 츄츄지지·메이플유틸리티·메이플린드·maple.support·maplechecklist 등 다수의 실서비스가 사용자에게 본인 API Key 발급을 안내하고 이를 받아 대신 호출하는 방식으로 운영 중이다. 특히 츄츄지지는 `chuchu.gg/mymaple`에서 API Key 로그인 후 **"스케줄러 대시보드"**를 제공하며, 이는 본 조사의 스케줄러 API가 실제로 이 용도로 쓰이고 있음을 뒷받침한다.

---

## 이 앱의 설계에 미치는 영향

### API에서 가져올 수 있는 것 (자체 DB 불필요)

| 데이터 | 출처 엔드포인트 |
|---|---|
| 로그인 검증 + 본인 캐릭터 목록 | `/maplestory/v1/character/list` |
| 캐릭터 프로필 (레벨·직업·월드·길드명·외형 이미지) | `/maplestory/v1/character/basic` |
| 캐릭터명 → ocid 변환 (타인 포함) | `/maplestory/v1/id` |
| **본인 캐릭터의 보스 등록 의사 + 클리어 여부** | `/maplestory/v1/scheduler/character-state` → `boss_contents[]` |
| **본인 캐릭터의 주간 보스 클리어 수 / 제한 수** | 동일 → `weekly_boss_clear_count`, `weekly_boss_clear_limit_count` |
| 본인 캐릭터의 일일/주간 숙제 진행도 | 동일 → `daily_contents[]`, `weekly_contents[]` |
| 길드원 캐릭터명 목록 (친구 초대 후보) | `/maplestory/v1/guild/basic` → `guild_member[]` |
| 점검 일정 | `/maplestory/v1/notice*` |

### 반드시 자체 DB로 만들어야 하는 것

| 데이터 | 이유 |
|---|---|
| **보스 참여 "시각" (몇 시에 갈지)** | **API에 시간 개념이 전혀 없다.** 인게임 스케줄러는 체크리스트지 시간표가 아니다. → 이 앱의 1순위 핵심 가치는 100% 자체 구현 |
| **여러 사람의 스케줄 취합·겹쳐보기** | 스케줄러 API는 "자신의 계정에 속한 캐릭터만" 조회 가능. 남의 스케줄을 API로 읽을 방법이 없다 |
| **파티/그룹 구성원 관계** | 파티·친구 관계 API가 존재하지 않는다 (전 스펙 grep 결과 `파티`/`친구` 필드 0건) |
| **결정석 보스별 가격 테이블 + 주간 수익 집계** | `결정석`/`메소 가격` 데이터가 API 전역에 없다 (grep 결과 "메소 획득량 %" 스탯 필드만 존재). 보스별 결정석 시세는 **하드코딩 상수 테이블**로 관리해야 하며, 게임 패치 시 수동 갱신이 필요하다 |
| **보스 난이도·주기 마스터 테이블** | `difficulty`/`cycle`은 enum 없는 자유 문자열이라 값 목록을 미리 알 수 없다. 실호출로 수집 후 자체 매핑 테이블 구축 필요 |
| **클리어 체크 이력 / 주차별 스냅샷** | API `complete_flag`는 현재 상태만 준다. 주차 경계(KST 목 00:00) 기준 누적 이력은 우리가 저장해야 한다 |
| **비로그인 공개 시간표** | API 호출 없이 서빙되어야 하므로 전량 자체 DB |
| **카카오톡 알림 대상·구독 정보** | API 무관 |

### 인증 모델에 미치는 영향 (CLAUDE.md §2.1 검증 결과)

- **로그인 검증용 최적 엔드포인트: `GET /maplestory/v1/character/list`** — 파라미터가 없고(헤더만), 단 1회 호출로 **① 키 유효성 ② 계정 소유 캐릭터 목록**을 동시에 확보한다. CLAUDE.md §2.1의 "유효성 검증 → 캐릭터 소유 확인" 2단계를 1콜로 끝낼 수 있다.
  - 실패 시: `400` + `OPENAPI00005` (유효하지 않은 API KEY)
  - 대안이었을 `/maplestory/v1/id`는 `character_name`을 요구하고 ocid만 주므로 소유 확인이 불가능하다. **쓰지 말 것.**
- **키 해시(SHA-256)를 식별자로 쓰는 §2.1 설계는 유효하다.** 다만 스케줄러 API는 호출 시점에 **키 원문이 반드시 필요**하므로, 서버 측 자동 갱신·봇 알림 기능을 켜려면 §2.1이 예고한 "명시적 동의 + 암호화 보관"이 **선택이 아니라 필수 전제**가 된다. 이때 약관 제5조 ①② 예외 조항 충족 여부를 사전 확인해야 한다(미확인 항목 참조).
- **키 재발급 시 로그인 불가 문제**: 사용자가 키를 재발급하면 SHA-256 해시가 바뀌어 기존 계정과 연결이 끊긴다. `account_list[].account_id`(메이플스토리 계정 식별자)를 보조 식별자로 함께 저장해 계정 복구 경로를 마련할 것을 권한다.
- **ocid 불변성 없음**: 스펙 원문이 "게임 콘텐츠 변경으로 ocid가 변경될 수 있습니다"라고 명시한다. **ocid를 PK로 쓰지 말고**, 자체 UUID PK + ocid는 갱신 가능한 컬럼으로 둘 것.

### 호출량 설계

- 개발 단계 키(1,000건/일, 5건/초)는 **사용자 1인당 본인 키를 쓰므로 사용자마다 독립 예산**이 된다. 이건 유리한 구조다.
- 다만 우리 서버가 대리 호출할 때도 그 사용자의 키를 쓰므로 예산 주체는 동일하다.
- 데이터가 15분 지연이므로 **TanStack Query `staleTime`은 최소 15분**으로 잡는 것이 합리적이다. 그보다 짧게 잡으면 호출만 늘고 새 데이터는 오지 않는다.
- 주간 초기화(KST 목 00:00) 직후 동시 리프레시가 몰릴 수 있으므로 지터(jitter)를 넣을 것.
- `date` 미입력 시 오늘 기준이고 "해당 기준일에 접속하지 않은 캐릭터는 응답 결과가 없을 수 있음"이므로, **빈 응답을 에러로 취급하지 말고 "미접속" 상태로 구분해 표시**해야 한다(DoD의 빈 상태 UI에 해당).

### 발주자 주장에 대한 최종 판정

> "API를 이용하면 각 캐릭터가 등록한 스케줄러를 확인할 수 있고, 거기엔 '무슨 보스를 가겠다'는 정보만 들어있다"

- **"스케줄러를 확인할 수 있다" → 사실.** `/maplestory/v1/scheduler/character-state` 존재.
- **"'무슨 보스를 가겠다'는 정보만 있다" → 사실.** `boss_contents[].registration_flag`가 정확히 그 의미이며, 시각 정보는 없다.
- **"각 캐릭터" → 부분적으로 오해.** "각"이 "임의의 타인 캐릭터"를 뜻했다면 틀렸다. **자기 계정 캐릭터에 한정**된다. 이 점을 발주자에게 반드시 확인시켜야 하며, 앱 설계의 근본 전제가 바뀐다: 다른 사람의 참여 의사는 **API가 아니라 우리 앱 안에서 사용자가 직접 등록**해야 한다.

---

## 미확인 / 불확실 항목

아래는 **확인하지 못한 것**이며, 사실로 간주해서는 안 된다.

1. **`boss_contents[].difficulty` 및 `cycle`의 실제 값 문자열.** 스펙에 enum이 없다("보스 난이도", "보스 초기화 주기"라는 설명만 있음). 유효한 API 키가 없어 실호출로 확인하지 못했다. → **개발 착수 전 실제 키로 1회 호출해 값 목록을 수집해야 한다.**
2. **`daily_contents` / `weekly_contents`의 `content_name` 전체 목록.** 동일 사유.
3. **스케줄러 API의 데이터 지연·갱신 기준.** 스케줄러 스펙(`62_ko_*.yaml`)에는 `info.description`이 **없다.** 캐릭터/길드 스펙의 "평균 15분 지연, 전일 데이터는 익일 오전 2시" 규칙이 스케줄러에도 동일 적용되는지 **명시된 근거를 찾지 못했다.** 보수적으로 15분 지연을 가정하되 실측 검증 필요.
4. **스케줄러 API의 `date` 소급 조회 가능 범위.** 캐릭터 기본 정보처럼 "2023-12-21부터"인지, 최근 N일만인지 불명.
5. **주간 초기화(KST 목 00:00) 시점에 스케줄러 응답이 정확히 어떻게 리셋되는지.** `complete_flag`와 `weekly_boss_clear_count`의 리셋 타이밍이 15분 지연을 포함하는지 미확인.
6. **타 계정 ocid로 스케줄러를 호출했을 때의 정확한 에러 코드.** 스펙에 403 응답이 정의되어 있어 `OPENAPI00002`(권한 없음)로 **추정**되나 실측하지 못했다.
7. **존재하지 않는 캐릭터명으로 `/maplestory/v1/id` 호출 시의 정확한 에러 코드.** 공식 표상 `OPENAPI00003`(유효하지 않은 식별자)로 **추정**되나, 유효 키가 없으면 키 검증이 선행되어 `OPENAPI00005`가 먼저 반환되므로 실측 불가였다.
8. **API 키의 실제 형식.** 커뮤니티 자료는 개발 단계 키 `test_` / 서비스 단계 키 `live_` 접두사를 언급하나, **넥슨 공식 문서에서 이 형식을 명시한 문구를 찾지 못했다.** 접두사로 키 종류를 판별하는 로직을 넣지 말 것. 길이·문자셋도 미확인.
9. **"타인에게 제공 가능한 API Key" 허용 목록의 실제 내용.** 약관 제5조가 이 목록이 "Open API 공지사항 또는 내 애플리케이션 페이지"에 있다고 하나, 공지 목록이 클라이언트 렌더링 + 내 애플리케이션 페이지가 로그인 필수라 접근하지 못했다. **메이플스토리 스케줄러 API가 이 목록에 포함되는지 여부가 이 프로젝트 법적 리스크의 핵심이며, 반드시 로그인 후 직접 확인하거나 `help_openapi@nexon.co.kr`로 문의해야 한다.**
10. **프렌즈 프로그램(게임 데이터 활용 로그인) 신규 신청의 승인 기준·소요 기간.** 신청 메뉴 존재만 확인.
11. **`OPENAPI00008` / `OPENAPI00012`의 의미.** 공식 에러 코드 표에 `00008`은 없고, `00012`는 페이지 소스에 문자열만 존재할 뿐 설명이 없다.
12. **Rate limit 초과 시 응답 헤더에 잔여 호출량(`X-RateLimit-*` 등)이 포함되는지.** 정상 응답 헤더 실측 결과 관련 헤더가 없었으나, 유효 키 기준으로는 검증하지 못했다.
13. **`character/list`가 여러 메이플스토리 계정(`account_list`가 복수)을 반환하는 실제 조건.** 스키마상 배열이나, 한 넥슨 ID에 복수 계정이 붙는 경우의 규칙 미확인.
14. **결정석 가격 정보의 공식 출처.** API에 없음은 확인했으나, 넥슨이 다른 형태로 공식 제공하는지는 조사 범위 밖.

---

## 출처

**공식 OpenAPI 스펙 원본 (1차 근거)**
- 캐릭터 정보 조회: https://openapi.nexon.com/static/api/maplestory/14_ko_script20260811231428.yaml
- 유니온 정보 조회: https://openapi.nexon.com/static/api/maplestory/15_ko_script20260618050040.yaml
- 길드 정보 조회: https://openapi.nexon.com/static/api/maplestory/16_ko_script20260723040144.yaml
- 확률 정보 조회: https://openapi.nexon.com/static/api/maplestory/17_ko_script20260320040201.yaml
- 랭킹 정보 조회: https://openapi.nexon.com/static/api/maplestory/18_ko_script20260622043839.yaml
- 공지 정보 조회: https://openapi.nexon.com/static/api/maplestory/27_ko_script20251218035959.yaml
- 연무장 정보 조회: https://openapi.nexon.com/static/api/maplestory/59_ko_script20260618050117.yaml
- **스케줄러 정보 조회: https://openapi.nexon.com/static/api/maplestory/62_ko_script20260624052642.yaml**

> 이 URL들은 문서 페이지의 `__NEXT_DATA__`에 담긴 `fileUrl` 값이며, 파일명에 타임스탬프가 포함되어 **개정 시 URL이 바뀐다.** 재확인 시에는 https://openapi.nexon.com/ko/game/maplestory/ 의 페이지 소스에서 `fileUrl`을 다시 추출할 것.

**공식 문서 페이지**
- 메이플스토리 API 목록: https://openapi.nexon.com/ko/game/maplestory/
- 스케줄러 정보 조회 문서: https://openapi.nexon.com/ko/game/maplestory/?id=57
- 캐릭터 정보 조회 문서: https://openapi.nexon.com/ko/game/maplestory/?id=14
- 사전 준비하기 (API Key 발급·애플리케이션 타입·rate limit): https://openapi.nexon.com/ko/guide/prepare-in-advance/
- API 사용하기 (인증 헤더·에러 코드표·표기 의무): https://openapi.nexon.com/ko/guide/request-api/
- 이용약관 (2024-09-09 시행): https://openapi.nexon.com/ko/support/terms/
- FAQ "API KEY는 어떻게 발급 받을 수 있나요?": https://openapi.nexon.com/ko/support/faq/2354085/
- 게임 데이터 활용 로그인 소개 (프렌즈 프로그램): https://openapi.nexon.com/ko/data-util/introduction/
- 공지사항: https://openapi.nexon.com/ko/support/notice/

**실측 (2026-08-17 수행)**
- `curl -i https://open.api.nexon.com/maplestory/v1/id?character_name=... -H "Origin: https://example.com" -H "x-nxopen-api-key: <invalid>"` → `400` / `{"error":{"name":"OPENAPI00005","message":"The apikey is not valid."}}` / `access-control-allow-origin: https://example.com`
- `curl -X OPTIONS https://open.api.nexon.com/maplestory/v1/id -H "Origin: https://example.com" -H "Access-Control-Request-Method: GET" -H "Access-Control-Request-Headers: x-nxopen-api-key"` → `200` / `access-control-allow-headers: x-nxopen-api-key`
- `/maplestory/v1/scheduler/character-state`, `/maplestory/v1/character/list`, `/maplestory/v1/bogus/path`에 무효 키 호출 → 전부 `OPENAPI00005` (키 검증이 경로 검증에 선행함을 확인)

**참고 (2차 자료, 법적 근거 아님)**
- 츄츄지지 API Key 발급 가이드: https://chuchu.gg/help/api
- 츄츄지지 마이메이플 (스케줄러 대시보드 실사용 사례): https://chuchu.gg/mymaple
- 인벤 "[API] 캐릭터 스케줄러 대시보드 사이트 오픈!": https://www.inven.co.kr/board/maple/5974/6775810
- 메이플스토리 오픈API 최초 공지: https://maplestory.nexon.com/News/Notice/Notice/139611
