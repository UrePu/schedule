<!-- nexon-probe: state=measured; runId=2026-08-17T03-49-07Z; mode=live -->
# 넥슨 오픈 API 실측 관측 결과

> 이 문서는 `pnpm probe` 가 **자동 생성**합니다. 손으로 고치지 마세요.
> 값의 근거는 `.nexon-probe-out/raw/<runId>/*.json` (gitignore 대상) 에 있습니다.
>
> **갱신 규칙 — 이 문서는 정보량이 줄어드는 방향으로 절대 덮어쓰이지 않습니다.**
> - 아래 헤더는 항상 **이 문서를 만든 실행**의 상태를 말합니다.
> - 실측 결과가 담긴 문서는 **실측에 성공한 실행만** 갱신할 수 있습니다.
>   키가 없거나 무효인 실행은 이 문서를 건드리지 않고 보존합니다 (`--overwrite-doc` 로만 강제 가능).
> - 아직 실측 전(=이 표시가 남아 있는 상태)이라면 어떤 실행이든 현재 상태로 다시 씁니다.
> - `--dry-run`(기본 모드)은 **이 문서를 절대 쓰지 않습니다.** 요청도 파일 쓰기도 0건입니다.

- 실행 ID: `2026-08-17T03-49-07Z`
- 생성 시각: 2026-08-17T03:49:07.879Z
- 모드: `live`
- 호출: 계획 18회 / 실행 18회 / 예산 100회 / 스로틀 2req/s
- API 키: 있음 (출처 `.env.local`) / 유효

**비식별화**: API 키는 어떤 값에도 포함되지 않습니다. `ocid` / `account_id` 는 앞 6자만 남겼습니다.

---

## 미확인 항목 해소 현황

| 항목 | 질문 | 상태 | 실측 결과 |
|---|---|---|---|
| `NEXON-API#1` | boss_contents[].difficulty / cycle 의 실제 값 문자열 | ✅ 해소 | difficulty = `chaos`, `easy`, `extreme`, `hard`, `normal` / cycle = `bossDaily`, `bossMonthly`, `bossWeekly` (보스 항목 183건 기준). 주의: 이 캐릭터들이 스케줄러에 등록한 보스만 나옵니다. 전체 값 집합이라는 보장은 없습니다. |
| `NEXON-API#2` | daily_contents / weekly_contents 의 content_name / type / quest_state 실제 값 | ✅ 해소 | daily type = `contents`, `quest`, daily quest_state = `0`, weekly type = `contents`, `quest`, weekly quest_state = `0`, `2`. content_name 은 daily 18종 / weekly 22종 수집 (아래 목록 참조). |
| `NEXON-API#3` | 스케줄러 API 의 데이터 지연 (스펙에 info.description 이 없어 15분 규칙 적용 여부 불명이었음) | 🟡 부분 | 응답 date 는 KST 일 단위(시·분 0)라 "현재 시각 - date" 는 최소 지연이 아니라 **당일 경과 시간**을 포함합니다. 실측 차이 12.82h, 12.82h, 12.82h. → date 필드만으로는 15분 지연을 확정할 수 없습니다. 확정하려면 인게임에서 보스 하나를 클리어한 뒤 complete_flag 가 바뀌는 시각을 재야 합니다(이 도구 범위 밖). |
| `NEXON-API#4` | 스케줄러 API 의 date 소급 조회 가능 범위 | 🟡 부분 | 200 응답: 2026-08-16, 2026-08-10 / 실패: 2026-07-18(400 OPENAPI00004), 2023-12-21(400 OPENAPI00004). 사다리 방식 표본이므로 정확한 경계는 추가 이분 탐색이 필요합니다. |
| `NEXON-API#5` | 주간 초기화(KST 목 00:00) 시점의 complete_flag / weekly_boss_clear_count 리셋 타이밍 | ⬜ 미해소 | 단일 실행으로는 확인할 수 없습니다. 목요일 00:00 KST 전후로 이 도구를 두 번 돌리고 `--diff` 로 비교해야 합니다. (예: 수요일 23:50, 목요일 00:10, 목요일 00:30) |
| `NEXON-API#6` | 타 계정 ocid 로 스케줄러 호출 시의 정확한 에러 코드 (OPENAPI00002 로 추정했었음) | ✅ 해소 | HTTP 400 / error.name = OPENAPI00004 |
| `NEXON-API#7` | 존재하지 않는 캐릭터명으로 /v1/id 호출 시의 에러 코드 (OPENAPI00003 로 추정했었음) | ✅ 해소 | HTTP 400 / error.name = OPENAPI00004 |
| `NEXON-API#8` | API 키의 실제 형식(test_ / live_ 접두사 여부) | ⬜ 미해소 | 이 도구는 키를 절대 출력·판별·저장하지 않는다는 원칙에 따라 형식을 조사하지 않습니다. 접두사로 키 종류를 판별하는 로직은 애초에 넣지 않기로 한 결정(research-NEXON-API #8)이 유효합니다. |
| `NEXON-API#11` | OPENAPI00008 / OPENAPI00012 의 의미 | ⬜ 미해소 | 이번 실행에서 관측된 error.name: `OPENAPI00002`, `OPENAPI00003`, `OPENAPI00004`. 00008/00012 를 유발할 조건을 알 수 없어 의도적으로 재현하지 못했습니다. |
| `NEXON-API#12` | 응답 헤더에 잔여 호출량 헤더가 있는지 | ✅ 해소 | 잔여 호출량 관련 헤더는 없습니다. 관측된 응답 헤더 전체: `cache-control`, `connection`, `content-encoding`, `content-type`, `date`, `expires`, `inface-wasm-filter`, `pragma`, `referrer-policy`, `server`, `strict-transport-security`, `transfer-encoding`, `vary`, `via`, `x-amz-cf-id`, `x-amz-cf-pop`, `x-cache`, `x-content-type-options`, `x-envoy-upstream-service-time`, `x-request-id`, `x-xss-protection` → 앱에서 남은 할당량을 헤더로 알 수 없으므로 호출량은 우리가 직접 세야 합니다. |
| `NEXON-API#13` | character/list 가 복수 계정(account_list 복수)을 반환하는 조건 | 🟡 부분 | 이 키로는 account_list 길이 = 1 (계정별 캐릭터 수 59). 단일 계정만 반환되었습니다. 복수 반환 조건은 이 키만으로는 알 수 없습니다(넥슨 ID 에 메이플 계정이 여러 개 붙은 경우로 추정). |
| `BOSS-DATA#R7` | weekly_boss_clear_limit_count 의 실제 값 (12 로 예상했었음) | ✅ 해소 | limit = 12 / count = 0, 2, 10 |
| `FLAG-TYPE` | registration_flag / complete_flag 가 문자열 "true"/"false" 인지 불리언인지 | ✅ 해소 | boss_contents[].complete_flag: string = false, true / boss_contents[].registration_flag: string = false, true / daily_contents[].registration_flag: string = false, true / weekly_contents[].registration_flag: string = false, true |
| `NEXON-API#9` | "타인에게 제공 가능한 API Key" 허용 목록에 스케줄러 API 가 포함되는지 (법적 리스크의 핵심) | ⬜ 미해소 | API 호출로 답할 수 없습니다. 넥슨 OpenAPI 사이트에 로그인해 「내 애플리케이션」/공지사항을 직접 확인하거나 help_openapi@nexon.co.kr 에 문의해야 합니다. |
| `NEXON-API#10` | 프렌즈 프로그램(게임 데이터 활용 로그인) 신규 신청의 승인 기준·소요 기간 | ⬜ 미해소 | API 호출로 답할 수 없습니다. 넥슨 지원 > 프렌즈 프로그램 신청 절차를 통해서만 확인 가능합니다. |
| `NEXON-API#14` | 결정석 가격 정보의 공식 출처 | ⬜ 미해소 | API 전역에 결정석/메소 가격 필드가 없다는 사실은 스펙 대조로 재확인됩니다. 다른 형태의 공식 제공 여부는 API 범위 밖입니다. |
| `SPEC-DRIFT` | 넥슨 OpenAPI YAML 원본과 실제 응답의 차이 | 🟡 부분 | 스펙 8건 대조 완료. 스펙과 어긋난 필드 0건. |

---

## 계정 / 캐릭터

- `account_list` 길이: **1**
- 계정 식별자(마스킹): `9c9d75…(len=32)`
- 캐릭터 총 59명 (계정별 59)
- 월드: `루나`, `스카니아`, `스페셜`, `챌린저스`, `챌린저스2`, `챌린저스3`, `챌린저스4`, `크로아`
- 스케줄러 응답 있음 3명 / 비어 있음(미접속 추정) 0명

## `boss_contents[]` 실제 값

- 수집한 보스 항목: **183건**
- `difficulty` 값 집합: `chaos`, `easy`, `extreme`, `hard`, `normal`
- `cycle` 값 집합: `bossDaily`, `bossMonthly`, `bossWeekly`
- `content_name` (32종): `가디언 엔젤 슬라임`, `감시자 칼로스`, `검은 마법사`, `더스크`, `데미안`, `듄켈`, `루시드`, `림보`, `매그너스`, `반 레온`, `반반`, `발드릭스`, `벨룸`, `블러디퀸`, `선택받은 세렌`, `스우`, `시그너스`, `시즌 보스 메이린`, `아카이럼`, `윌`, `유피테르`, `자쿰`, `진 힐라`, `찬란한 흉성`, `최초의 대적자`, `카링`, `카웅`, `파풀라투스`, `피에르`, `핑크빈`, `혼테일`, `힐라`
- `weekly_boss_clear_count`: 0, 2, 10
- `weekly_boss_clear_limit_count`: **12**

## `daily_contents[]` / `weekly_contents[]` 실제 값

- daily `type`: `contents`, `quest`
- daily `quest_state`: `0`
- daily `content_name` (18종): `[일일 퀘스트] 고통의 미궁 조사`, `[일일 퀘스트] 기어드락 크로노스의 잔재 수집`, `[일일 퀘스트] 도원경 오염 정화`, `[일일 퀘스트] 레헬른의 평온한 밤`, `[일일 퀘스트] 리멘 조사`, `[일일 퀘스트] 모라스의 안정을 위해`, `[일일 퀘스트] 문브릿지 조사`, `[일일 퀘스트] 세르니움 조사`, `[일일 퀘스트] 소멸의 여로 조사`, `[일일 퀘스트] 아르카나의 평온한 바람`, `[일일 퀘스트] 아르테리아 잔당 처치`, `[일일 퀘스트] 에스페라 연구 명령`, `[일일 퀘스트] 오디움 일대 탐사`, `[일일 퀘스트] 츄츄 아일랜드 최고의 요리`, `[일일 퀘스트] 카르시온 복구 지원`, `[일일 퀘스트] 탈라하트 고대신의 힘 조사`, `[일일 퀘스트] 호텔 아르크스 주변 청소`, `몬스터파크`
- weekly `type`: `contents`, `quest`
- weekly `quest_state`: `0`, `2`
- weekly `content_name` (22종): `[길드] 주간 미션 포인트`, `[길드] 지하 수로`, `[길드] 플래그 레이스`, `[메이플 유니온] 주간 드래곤 퇴치`, `[메이플 유니온] PC방 주간 드래곤 퇴치`, `[몬스터파크] 익스트림 몬스터파커에 도전해보겠나?`, `[주간 퀘스트] 꾸준한 의뢰에 대한 보답`, `[주간 퀘스트] 성실한 조사에 대한 보답`, `[주간 퀘스트] 크리티아스 주간 임무`, `[주간 퀘스트] 타락한 세계수 정화에 대한 보답`, `[주간 퀘스트] 타락한 세계수 주간 임무`, `[주간 퀘스트] 헤이븐 주간 임무`, `무릉도장`, `미드나잇 체이서`, `배고픈 무토`, `스피릿 세이비어`, `에르다 스펙트럼`, `에픽 던전 : 악몽선경`, `에픽 던전 : 앵글러 컴퍼니`, `에픽 던전 : 하이마운틴`, `엔하임 디펜스`, `프로텍트 에스페라`

## 플래그 필드의 실제 타입

| 필드 | JS 타입 | 관측된 값 |
|---|---|---|
| `boss_contents[].complete_flag` | `string` | `false`, `true` |
| `boss_contents[].registration_flag` | `string` | `false`, `true` |
| `daily_contents[].registration_flag` | `string` | `false`, `true` |
| `weekly_contents[].registration_flag` | `string` | `false`, `true` |

## 데이터 지연 실측

> 응답 `date` 는 KST 일 단위(시·분 0)입니다. 아래 차이는 "지연"이 아니라 **기준일 00:00 부터 관측 시각까지의 경과**를 포함합니다.

| 캐릭터 | 응답 date | 관측 시각(UTC) | 차이(h) |
|---|---|---|---|
| 더저 | `2026-08-17T00:00+09:00` | 2026-08-17T03:49:09.166Z | 12.82 |
| 카파런 | `2026-08-17T00:00+09:00` | 2026-08-17T03:49:10.198Z | 12.82 |
| 메검메 | `2026-08-17T00:00+09:00` | 2026-08-17T03:49:11.199Z | 12.82 |

## `date` 소급 조회 범위

| date | 며칠 전 | HTTP | error.name | 본문 있음 |
|---|---|---|---|---|
| `2026-08-16` | 1 | 200 | - | O |
| `2026-08-10` | 7 | 200 | - | O |
| `2026-07-18` | 30 | 400 | OPENAPI00004 | X |
| `2023-12-21` | - | 400 | OPENAPI00004 | X |

## 에러 형태 실측

| 탐침 | 상황 | HTTP | error.name | error.message |
|---|---|---|---|---|
| `error-unknown-character` | 존재하지 않는 캐릭터명으로 /v1/id 호출 | 400 | `OPENAPI00004` | Please input valid parameter |
| `error-bad-ocid` | 잘못된 ocid 로 /character/basic 호출 | 400 | `OPENAPI00003` | Please input valid id |
| `error-bogus-path` | 존재하지 않는 경로 호출 (유효 키) | 403 | `OPENAPI00002` | Access Denied |
| `error-cross-account-scheduler` | 타 계정(길드원) ocid 로 /scheduler/character-state 호출 | 400 | `OPENAPI00004` | Please input valid parameter |

## 응답 헤더

- 관측된 헤더: `cache-control`, `connection`, `content-encoding`, `content-type`, `date`, `expires`, `inface-wasm-filter`, `pragma`, `referrer-policy`, `server`, `strict-transport-security`, `transfer-encoding`, `vary`, `via`, `x-amz-cf-id`, `x-amz-cf-pop`, `x-cache`, `x-content-type-options`, `x-envoy-upstream-service-time`, `x-request-id`, `x-xss-protection`
- 잔여 호출량 관련 헤더: **없음** → 남은 할당량은 우리가 직접 세야 합니다.

---

## 넥슨 OpenAPI 스펙 대조

스펙 목록 출처: https://openapi.nexon.com/ko/game/maplestory/ 의 `__NEXT_DATA__` → `fileUrl`

| id | 분류 | 파일명 (타임스탬프 = 개정 신호) | sha256(앞12) | 파싱 |
|---|---|---|---|---|
| 14 | 캐릭터 정보 조회 | `14_ko_script20260811231428.yaml` | `ade53a1e4be8` | O |
| 15 | 유니온 정보 조회 | `15_ko_script20260618050040.yaml` | `dc1be7d7599d` | O |
| 16 | 길드 정보 조회 | `16_ko_script20260723040144.yaml` | `d9c40e2acc81` | O |
| 17 | 확률 정보 조회 | `17_ko_script20260320040201.yaml` | `a0cf0991e337` | O |
| 18 | 랭킹 정보 조회 | `18_ko_script20260622043839.yaml` | `40722277296f` | O |
| 27 | 공지 정보 조회 | `27_ko_script20251218035959.yaml` | `2f0102975552` | O |
| 59 | 연무장 정보 조회 | `59_ko_script20260618050117.yaml` | `6c3fc8509870` | O |
| 62 | 스케줄러 정보 조회 | `62_ko_script20260624052642.yaml` | `1cf95090c294` | O |

### 스펙 ↔ 실제 응답 차이

#### `/maplestory/v1/character/list` — 스키마 `CharacterList`

- 스펙에 있는데 응답에 없음: _없음_
- 응답에 있는데 스펙에 없음: _없음_
- 타입 불일치: _없음_

#### `/maplestory/v1/character/basic` — 스키마 `CharacterBasic`

- 스펙에 있는데 응답에 없음: _없음_
- 응답에 있는데 스펙에 없음: _없음_
- 타입 불일치: _없음_

#### `/maplestory/v1/scheduler/character-state` — 스키마 `CharacterStateResponse`

- 스펙에 있는데 응답에 없음: _없음_
- 응답에 있는데 스펙에 없음: _없음_
- 타입 불일치: _없음_

---

Data based on NEXON Open API
