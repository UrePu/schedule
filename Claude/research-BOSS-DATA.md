# 메이플스토리(한국) 보스 마스터 데이터 & 결정석 가격 조사

조사일: 2026-08-17
조사 대상: 메이플스토리 **한국 서버(KMS)**. 글로벌/GMS·MSEA 수치는 다르므로 이 문서에 섞지 않았다.
전제: `Claude/research-NEXON-API.md`에서 확정된 대로 **넥슨 오픈 API에는 결정석 가격·보스 시세·보스 마스터 목록이 존재하지 않는다.** 따라서 아래 데이터는 전량 우리 앱의 하드코딩 상수로 관리한다.

---

## 결론 요약

1. **결정석의 정식 아이템명은 `강렬한 힘의 결정`**이며, 2024년 7월 18일 패치로 **`(일간)` / `(주간)` / `(월간)` 3종으로 분리**되었다(아이콘 색: 일간 파랑 / 주간 보라 / 월간 노랑). 판매처는 **자유시장 입구의 NPC 콜렉터**.
2. **수집한 보스 = 총 78개 (난이도별 엔트리 기준).** 일간 24 / 주간 52 / 월간 2.
   - 주간 52개 중 **벨로나 3종(이지·노멀·하드)은 2026-08-20(하드는 8/21) 출시 예정**이라 오늘(8/17) 기준 아직 라이브가 아니다. 라이브 기준으로는 주간 49개.
3. **가격 기준 시점은 2026년 6월 18일 `1.2.202 (OVERDRIVE)` 패치**다. 이 패치에서 52개 항목이 **-5% ~ -82%** 조정되었다.
   - 같은 패치에서 **하드 힐라 / 카오스 핑크빈 / 노멀 시그너스가 주간 보스 → 일간 보스로 되돌아갔다.** (그래서 가격이 -78%~-82%로 폭락했다.) 시그너스는 **이지/노멀 난이도가 노멀 하나로 통합**되었다.
   - 검은 마법사(월간) 신규 가격은 **2026년 7월 1일(수)부터** 적용되었다.
4. **수익 계산의 핵심 규칙 3가지** (자세한 내용은 아래 전용 절):
   - **파티 입장 시 결정 가격은 입장 시점 파티 인원수로 정확히 1/n 분할(소수점 버림).** 표에 적힌 값은 **전부 솔로(1인) 기준**이다. 이걸 빼먹으면 수익이 최대 6배 틀어진다.
   - **주간 결정: 캐릭터당 주 12개까지만 판매.** 초과분은 "이미 판 것 중 가장 싼 것과의 **차액**"만 지급.
   - **월드당 주 90개** 총량 제한(일간·주간·월간 합산). 2025-01-16에 180 → 90으로 축소.
5. **파티 인원 상한은 보스 세대별로 다르다.** 구세대(자쿰~듄켈, 검은 마법사, 세렌, 칼로스, 카링)는 **6인**, 김창섭 체제 신세대(최초의 대적자, 림보, 발드릭스, 찬란한 흉성, 유피테르, 벨로나)는 **3인**, **익스트림 스우만 2인**이다. 1/n 분할과 맞물려 실수령액에 직접 영향을 준다.
6. **주간 보스 클리어 자체가 캐릭터당 주 12회로 제한**된다(2025-08-21 패치로 13번째부터 **입장 자체가 차단**). → NEXON API의 `weekly_boss_clear_limit_count`는 **12**를 반환할 것으로 예상된다(실호출 미검증, 미확인 항목 참조).
7. **월간 보스는 검은 마법사(하드/익스트림) 단 하나**다. 매월 1일 00:00 KST 초기화.

---

## 기준 시점

| 항목 | 기준 |
|---|---|
| **결정석 가격 기준 패치** | **1.2.202 / 2026-06-18 (OVERDRIVE 업데이트)** — 대규모 가격 재조정 |
| 월간(검은 마법사) 가격 적용일 | 2026-07-01(수) |
| 주간 보스 처치 12회 제한 도입 | 2025-08-21 |
| 월드 판매 총량 180 → 90 | 2025-01-16 (1.2.183) |
| 일간/주간/월간 결정 분리 + 주간 12개 제한 도입 | 2024-07-18 |
| 최신 신규 보스 | **벨로나** — 이지/노멀 2026-08-20, 하드 2026-08-21 출시 예정 (**본 문서 작성 시점 미출시**) |
| 문서 데이터 최종 대조일 | 2026-08-17 (나무위키 `강렬한 힘의 결정` 문서 최종 수정 2026-08-14 확인) |

> **주의**: 2026-06-13 SUMMER SHOWCASE OVERDRIVE 이후 결정석이 이미 한 차례 대폭 하향됐고, 벨로나 출시(8/20)에 맞춘 **추가 조정 가능성이 커뮤니티에서 거론**되고 있다. 8/20 이후 반드시 재검증할 것.

---

## 보스 마스터 테이블

### 표 읽는 법

- **결정석 가격(메소)** 은 전부 **솔로(1인 입장) 기준**이다. N인 파티로 입장하면 각자 `floor(가격 / N)`을 받는다.
- `?` = 신뢰할 수 있는 출처를 확보하지 못한 값. 절대 임의로 채우지 말 것 (→ 「미확인 / 불확실 항목」).
- `id`는 **우리가 직접 정한 영문 slug**다. 게임 내부 ID나 넥슨 API 값이 아니다. API의 `content_name`/`difficulty` 문자열과의 매핑 테이블은 별도로 만들어야 한다.
- 별칭은 **카톡 봇 명령어 파싱용**이며, 실제 커뮤니티 표기를 모은 것이다(미확인 항목 8·9번의 신뢰도 단서 참조).
- **최대 파티 인원** 중 `6`은 상당수가 "보스 개별 문서에 명시된 값"이 아니라 **세대별 일괄 규칙**에서 도출한 값이다(미확인 항목 3번).

### 일간 보스 (daily) — 24개

매일 00:00 KST 초기화. 보스별 1일 1회.

| id | 한글명 | 별칭[] | 난이도 | 주기 | 결정석 가격(메소) | 최대 파티 인원 | 입장 레벨 |
|---|---|---|---|---|---|---|---|
| `zakum_easy` | 이지 자쿰 | 자쿰, 쟈쿰, 이자쿰, 이쟈쿰, 이자 | 이지 | daily | 114,000 | 6 | 50 |
| `zakum_normal` | 노멀 자쿰 | 자쿰, 노자쿰, 노자 | 노멀 | daily | 349,000 | 6 | 90 |
| `papulatus_easy` | 이지 파풀라투스 | 파풀라투스, 파풀, 이파풀, 이파 | 이지 | daily | 390,000 | 6 | 115 |
| `magnus_easy` | 이지 매그너스 | 매그너스, 매그, 이매그, 이매 | 이지 | daily | 411,000 | 6 | 115 |
| `hilla_normal` | 노멀 힐라 | 힐라, 노힐라, 노힐 | 노멀 | daily | 455,000 | 6 | 85 |
| `horntail_easy` | 이지 혼테일 | 혼테일, 혼테, 이혼테, 이혼 | 이지 | daily | 502,000 | 6 | 130 |
| `bloody_queen_normal` | 노멀 블러디퀸 | 블러디퀸, 블퀸, 노블퀸, 노블 | 노멀 | daily | 551,000 | 6 | 125 |
| `von_bon_normal` | 노멀 반반 | 반반, 노반반, 노반 | 노멀 | daily | 551,000 | 6 | 125 |
| `pierre_normal` | 노멀 피에르 | 피에르, 노피에르, 노피 | 노멀 | daily | 551,000 | 6 | 125 |
| `vellum_normal` | 노멀 벨룸 | 벨룸, 노벨룸, 노벨 | 노멀 | daily | 551,000 | 6 | 125 |
| `horntail_normal` | 노멀 혼테일 | 혼테일, 혼테, 노혼테, 노혼 | 노멀 | daily | 576,000 | 6 | 130 |
| `von_leon_easy` | 이지 반 레온 | 반레온, 반레, 이반레, 이반 | 이지 | daily | 602,000 | 6 | 125 |
| `arkarium_easy` | 이지 아카이럼 | 아카이럼, 아카, 이아카 | 이지 | daily | 656,000 | 6 | 140 |
| `kaung_normal` | 노멀 카웅 | 카웅, 노카웅 | 노멀 | daily | 712,000 | 6 | 180 |
| `horntail_chaos` | 카오스 혼테일 | 카혼테, 카혼, 카오스혼테일 | 카오스 | daily | 770,000 | 6 | 135 |
| `pink_bean_normal` | 노멀 핑크빈 | 핑크빈, 핑빈, 노핑빈, 노핑 | 노멀 | daily | 799,000 | 6 | 140 ⚠️ (상충: 160) |
| `von_leon_normal` | 노멀 반 레온 | 반레온, 반레, 노반레, 노반 | 노멀 | daily | 830,000 | 6 | 125 |
| `von_leon_hard` | 하드 반 레온 | 하반레, 하반, 하드반레온 | 하드 | daily | 1,070,000 | 6 | 125 |
| `arkarium_normal` | 노멀 아카이럼 | 아카이럼, 아카, 노아카 | 노멀 | daily | 1,110,000 | 6 | 140 |
| `magnus_normal` | 노멀 매그너스 | 매그너스, 매그, 노매그, 노매 | 노멀 | daily | 1,160,000 | 6 | 155 |
| `papulatus_normal` | 노멀 파풀라투스 | 파풀라투스, 파풀, 노파풀, 노파 | 노멀 | daily | 1,200,000 | 6 | 155 |
| `hilla_hard` | 하드 힐라 | 하드힐라, 하힐라, 하힐 | 하드 | daily | 1,280,000 | 6 | 170 |
| `pink_bean_chaos` | 카오스 핑크빈 | 카핑빈, 카핑, 카오스핑크빈 | 카오스 | daily | 1,320,000 | 6 | 170 |
| `cygnus_normal` | 노멀 시그너스 | 시그너스, 시그, 노시그, 여제 | 노멀 | daily | 1,360,000 | 6 | 165 |

> `hilla_hard`, `pink_bean_chaos`, `cygnus_normal`은 **2026-06-18 패치로 주간 → 일간으로 원복**된 항목이다. 이전 주차 데이터와 섞이지 않도록 주의.
> `cygnus_normal`: 같은 패치로 **이지/노멀이 노멀 하나로 통합**되었다. `cygnus_easy`는 더 이상 존재하지 않는다.

### 주간 보스 (weekly) — 52개

매주 **목요일 00:00 KST** 초기화. 보스별 주 1회 + **캐릭터당 전체 12회** 제한.

| id | 한글명 | 별칭[] | 난이도 | 주기 | 결정석 가격(메소) | 최대 파티 인원 | 입장 레벨 |
|---|---|---|---|---|---|---|---|
| `zakum_chaos` | 카오스 자쿰 | 카자쿰, 카쿰, 카자 | 카오스 | weekly | 8,080,000 | 6 | 90 |
| `bloody_queen_chaos` | 카오스 블러디퀸 | 카블퀸, 카블 | 카오스 | weekly | 8,140,000 | 6 | 180 |
| `von_bon_chaos` | 카오스 반반 | 카반반, 카반 | 카오스 | weekly | 8,150,000 | 6 | 180 |
| `pierre_chaos` | 카오스 피에르 | 카피에르, 카피 | 카오스 | weekly | 8,170,000 | 6 | 180 |
| `magnus_hard` | 하드 매그너스 | 하매그, 하매 | 하드 | weekly | 8,560,000 | 6 | 175 |
| `vellum_chaos` | 카오스 벨룸 | 카벨룸, 카벨 | 카오스 | weekly | 9,280,000 | 6 | 180 |
| `papulatus_chaos` | 카오스 파풀라투스 | 카파풀, 카파 | 카오스 | weekly | 13,100,000 | 6 | 190 |
| `lotus_normal` | 노멀 스우 | 스우, 노스우, 노스 | 노멀 | weekly | 16,700,000 | 6 | 190 |
| `damien_normal` | 노멀 데미안 | 데미안, 데미, 노데미, 노데 | 노멀 | weekly | 17,500,000 | 6 | 190 |
| `guardian_angel_slime_normal` | 노멀 가디언 엔젤 슬라임 | 가엔슬, 노가엔슬, 슬라임, GAS | 노멀 | weekly | 25,500,000 | 6 | 210 |
| `lucid_easy` | 이지 루시드 | 루시드, 이루시드, 이루 | 이지 | weekly | 29,800,000 | 6 | 220 |
| `will_easy` | 이지 윌 | 윌, 이윌 | 이지 | weekly | 32,300,000 | 6 | 235 |
| `lucid_normal` | 노멀 루시드 | 루시드, 노루시드, 노루 | 노멀 | weekly | 35,600,000 | 6 | 220 |
| `will_normal` | 노멀 윌 | 윌, 노윌 | 노멀 | weekly | 41,100,000 | 6 | 235 |
| `dusk_normal` | 노멀 더스크 | 더스크, 노더스크, 노더 | 노멀 | weekly | 44,000,000 | 6 | 245 |
| `dunkel_normal` | 노멀 듄켈 | 듄켈, 노듄켈, 노듄 | 노멀 | weekly | 47,500,000 | 6 | 255 |
| `damien_hard` | 하드 데미안 | 하데미, 하데 | 하드 | weekly | 48,900,000 | 6 | 190 |
| `lotus_hard` | 하드 스우 | 하스우, 하스 | 하드 | weekly | 51,500,000 | 6 | 190 |
| `lucid_hard` | 하드 루시드 | 하루시드, 하루 | 하드 | weekly | 62,900,000 | 6 | 220 |
| `dusk_chaos` | 카오스 더스크 | 카더스크, 카더 | 카오스 | weekly | 69,800,000 | 6 | 245 |
| `verus_hilla_normal` | 노멀 진 힐라 | 진힐라, 진힐, 노진힐라, 노진힐 | 노멀 | weekly | 71,200,000 | 6 | 250 |
| `guardian_angel_slime_chaos` | 카오스 가디언 엔젤 슬라임 | 카가엔슬, 카슬라임 | 카오스 | weekly | 75,100,000 | 6 | 210 |
| `will_hard` | 하드 윌 | 하윌 | 하드 | weekly | 77,100,000 | 6 | 235 |
| `dunkel_hard` | 하드 듄켈 | 하듄켈, 하듄 | 하드 | weekly | 94,400,000 | 6 | 255 |
| `verus_hilla_hard` | 하드 진 힐라 | 하진힐라, 하진힐 | 하드 | weekly | 106,000,000 | 6 | 250 |
| `seren_normal` | 노멀 선택받은 세렌 | 세렌, 노세렌, 노세 | 노멀 | weekly | 239,000,000 | 6 | 260 |
| `kalos_easy` | 이지 감시자 칼로스 | 칼로스, 이칼로스, 이칼 | 이지 | weekly | 280,000,000 | 6 | 265 |
| `first_adversary_easy` | 이지 최초의 대적자 | 적자, 최적자, 이적자 | 이지 | weekly | 308,000,000 | **3** | 270 |
| `seren_hard` | 하드 선택받은 세렌 | 하세렌, 하세 | 하드 | weekly | 356,000,000 | 6 | 260 |
| `kaling_easy` | 이지 카링 | 카링, 이카링, 이카 | 이지 | weekly | 377,000,000 | 6 | 275 |
| `bellona_easy` ⚠️ | 이지 벨로나 | 벨로나, 이벨로나, 이벨 | 이지 | weekly | 440,000,000 ⚠️ | **3** | 280 |
| `kalos_normal` | 노멀 감시자 칼로스 | 칼로스, 노칼로스, 노칼 | 노멀 | weekly | 505,000,000 | 6 | 265 |
| `first_adversary_normal` | 노멀 최초의 대적자 | 노적자, 노최적자 | 노멀 | weekly | 560,000,000 | **3** | 270 |
| `lotus_extreme` | 익스트림 스우 | 익스우, 익스스우, 익스 | 익스트림 | weekly | 574,000,000 | **2** | 190 |
| `radiant_omen_normal` | 노멀 찬란한 흉성 | 흉성, 찬흉, 노흉성 | 노멀 | weekly | 625,000,000 | **3** | 280 |
| `kaling_normal` | 노멀 카링 | 카링, 노카링, 노카 | 노멀 | weekly | 678,000,000 | 6 | 275 |
| `bellona_normal` ⚠️ | 노멀 벨로나 | 벨로나, 노벨로나, 노벨 | 노멀 | weekly | ⚠️ **출처 충돌: 850,000,000 vs 890,000,000** | **3** | 280 |
| `limbo_normal` | 노멀 림보 | 림보, 노림보, 노림 | 노멀 | weekly | 1,026,000,000 | **3** | 285 |
| `kalos_chaos` | 카오스 감시자 칼로스 | 카칼로스, 카칼 | 카오스 | weekly | 1,273,000,000 | 6 | 265 |
| `baldrix_normal` | 노멀 발드릭스 | 발드릭스, 발드, 노발드 | 노멀 | weekly | 1,368,000,000 | **3** | 290 |
| `first_adversary_hard` | 하드 최초의 대적자 | 하적자, 하최적자 | 하드 | weekly | 1,435,000,000 | **3** | 270 |
| `jupiter_normal` | 노멀 유피테르 | 유피테르, 유피, 노유피 | 노멀 | weekly | 1,615,000,000 | **3** | 295 |
| `kaling_hard` | 하드 카링 | 하카링, 하카 | 하드 | weekly | 1,739,000,000 | 6 | 275 |
| `limbo_hard` | 하드 림보 | 하림보, 하림 | 하드 | weekly | 2,385,000,000 | **3** | 285 |
| `radiant_omen_hard` | 하드 찬란한 흉성 | 하흉성, 하흉 | 하드 | weekly | 2,678,000,000 | **3** | 280 |
| `seren_extreme` | 익스트림 선택받은 세렌 | 익세렌, 익세 | 익스트림 | weekly | 2,835,000,000 | 6 | 260 |
| `bellona_hard` ⚠️ | 하드 벨로나 | 하벨로나, 하벨 | 하드 | weekly | 2,950,000,000 ⚠️ | **3** | 280 |
| `baldrix_hard` | 하드 발드릭스 | 하발드릭스, 하발드 | 하드 | weekly | 3,078,000,000 | **3** | 290 |
| `kalos_extreme` | 익스트림 감시자 칼로스 | 익칼로스, 익칼 | 익스트림 | weekly | 4,104,000,000 | 6 | 265 |
| `first_adversary_extreme` | 익스트림 최초의 대적자 | 익적자, 익최적자 | 익스트림 | weekly | 4,712,000,000 | **3** | 270 |
| `jupiter_hard` | 하드 유피테르 | 하유피테르, 하유피 | 하드 | weekly | 4,845,000,000 | **3** | 295 |
| `kaling_extreme` | 익스트림 카링 | 익카링, 익카 | 익스트림 | weekly | 5,387,000,000 | 6 | 275 |

> ⚠️ **벨로나 3종은 2026-08-17 현재 미출시.** 이지/노멀은 2026-08-20, 하드는 2026-08-21 오픈 예정. 가격은 테스트 월드/위키 값이며 **넥슨 공식 패치 노트에서 결정석 가격을 확인하지 못했다.** 노멀 값은 출처가 엇갈린다(850,000,000 vs 890,000,000). 출시 전까지 **비활성(`released: false`)으로 두고 수익 계산에 넣지 말 것.**
> ⚠️ **익스트림 스우는 최대 2인**이다. 574,000,000을 2로 나누면 1인당 287,000,000. 6인 가정으로 계산하면 크게 틀린다.

### 월간 보스 (monthly) — 2개

매월 **1일 00:00 KST** 초기화. 보스별 월 1회.

| id | 한글명 | 별칭[] | 난이도 | 주기 | 결정석 가격(메소) | 최대 파티 인원 | 입장 레벨 |
|---|---|---|---|---|---|---|---|
| `black_mage_hard` | 하드 검은 마법사 | 검마, 흑마, 하검마, 하검, 하드검은마법사 | 하드 | monthly | 665,000,000 | 6 | 255 |
| `black_mage_extreme` | 익스트림 검은 마법사 | 익검마, 익검, 익스검마 | 익스트림 | monthly | 8,740,000,000 | 6 | 255 |

> 월간 결정 가격은 **2026-07-01(수)부터** 적용된 값이다(주간·일간은 2026-06-18 적용).

### 표에 넣지 않은 보스 (의도적 제외)

| 보스 | 이유 |
|---|---|
| **메이린** | **챌린저스 월드 전용 이벤트 보스.** 주간 보스 처치 12회 제한에 포함되지 않고, 2026-09-16(수) 23:59까지만 입장 가능. 일반 월드 수익 계산에 넣으면 안 된다. |
| **우르스** | 일 3회 입장, **최대 18인 파티**, 강렬한 힘의 결정을 주지 않는다. 주간 숙제 트래커에는 넣을 수 있으나 결정석 수익 대상이 아니다. |
| 필드 보스 / 스토리 전용 보스 / 파티 퀘스트 보스 | 결정석 미지급 |

---

## 결정석 판매 제한 규칙

> **이 절이 주간 수익 계산 로직의 사양서다.** 아래 규칙을 그대로 코드로 옮길 수 있게 정리했다.

### R0. 아이템 구조

- 정식명 **`강렬한 힘의 결정`**. 2024-07-18 패치로 **`(일간)` / `(주간)` / `(월간)` 3종으로 분리**되었고 아이콘 색이 다르다(일간 파랑 / 주간 보라 / 월간 노랑).
- 판매처: **NPC 콜렉터** (자유시장 입구 / 빠른이동 UI로 접근).
- **유효기간 있음**: 획득 후 **1주일 내에 팔지 않으면 소멸**한다. → "지난주 결정석을 이번 주에 판다"는 이월 로직을 만들면 안 된다.

### R1. 파티 인원 분할 — 표 가격은 전부 솔로 기준

- 결정 판매 가격은 **보스 대기맵에 입장할 때의 파티 구성원 수**에 맞춰 **정확히 `1/n`로 나뉘고 소수점은 버린다.**
- **기준 시점은 "입장 시점"**이다. 6인으로 입장한 뒤 도중에 파티원이 나가도 각자 1/6 가격을 받는다.
- 넥슨 공식 가이드도 결정 가격이 "**처치한 보스의 종류, 입장한 파티원의 수**"에 따라 달라진다고 명시한다.

```
개인수령액(boss, partySize) = floor(CRYSTAL_PRICE[boss] / partySize)
```

> **UI 함의**: 우리 앱의 보스 등록 화면에서 **파티 인원수를 반드시 입력받아야** 수익이 맞는다. 인원수 없이 계산하면 실제보다 최대 6배 과대 계상된다.
> 보스별 `maxParty`(2/3/6)를 입력 검증 상한으로 쓸 것.

### R2. 주간 결정 — 캐릭터당 주 12개

- **캐릭터 단위**로 주 **12개**까지만 판매 가능. (2024-07-18 도입)
- 넥슨 공식 가이드 원문: **"강렬한 힘의 결정은 일주일 동안 캐릭터당 최대 12개까지 판매 가능, 판매 횟수는 매주 목요일 오전 0시 초기화"**
- **일간 보스 결정은 이 12개에 포함되지 않는다.** (12개는 `(주간)` 결정 전용 카운터)

### R3. 초과 판매 시 = 차액 정산

- 12개를 모두 판 상태에서 **더 비싼 결정을 팔면**, **이미 판 결정 중 가장 싼 것과의 차액**만큼만 메소를 받는다.
- 즉 주간 수익은 "판 순서"가 아니라 **"그 주에 처치한 주간 보스 중 비싼 순으로 12개"** 의 합으로 수렴한다.

```
weeklyIncome(clearedWeeklyBosses) =
  sum( top12ByPrice( clearedWeeklyBosses.map(개인수령액) ) )
```

> 앱 구현 권장: 사용자가 실제로 판 순서를 추적하려 하지 말고, **그 주 클리어한 주간 보스의 개인수령액을 내림차순 정렬해 상위 12개만 합산**하면 게임 내 최종 결과와 일치한다.
> 참고: 2025-08-21 패치로 13번째 주간 보스는 **입장 자체가 막히므로**, 정상 플레이라면 목록이 12개를 넘지 않는다. 상위 12개 절삭은 방어 로직 성격이다.

### R4. 월드 총량 — 주 90개

- **월드당 주 90개**. 일간·주간·월간 결정이 **모두 합산**된다.
- 이력: 캐릭터당 60개 → (2021-08-12) 월드당 180개 → (2025-01-16, 1.2.183) **월드당 90개**.
- 주간 12개를 채우고 남은 **78개 슬롯을 일간 보스 결정으로 채우는 것**이 실제 플레이 패턴이다.
- ⚠️ "월드당"의 정확한 주체(= 한 계정이 그 월드에 보유한 전 캐릭터 합산인지)는 **1차 출처로 확정하지 못했다.** 「미확인 항목」 참조. 다만 2021년 패치가 "**캐릭터당** 60개 → **월드당** 180개"로 표기된 점에서 **동일 플레이어(계정)의 해당 월드 캐릭터 전체 합산**으로 읽는 것이 자연스럽다.

### R5. 초기화 시점

| 대상 | 초기화 |
|---|---|
| 일간 보스 클리어 | 매일 **00:00 KST** |
| 주간 보스 클리어 + 주간 12회 카운터 | 매주 **목요일 00:00 KST** ✔ (CLAUDE.md §1과 일치) |
| 월간 보스 클리어 | 매월 **1일 00:00 KST** |
| 결정 **판매** 횟수 카운터(12개 / 90개) | 매주 **목요일 00:00 KST** (넥슨 공식 가이드 명시: "매주 목요일 오전 0시") |
| 일간·주간 결정 **가격** 갱신 | 매주 목요일 00:00 (현재 가격 변동 시스템은 **중단 상태** — R6 참조) |
| 월간 결정 **가격** 갱신 | 매월 1일 00:00 (동일하게 중단 상태) |

### R6. 가격 변동 시스템은 현재 꺼져 있다

- 2021-08-12 결정석 **시세 변동(±최대 3%) 시스템**이 도입되었으나 2022-04-21 일시 중지 → 2023-11-30 재개 → **2024-01-04 중단**되어 지금까지 멈춰 있다.
- → **현재 가격은 패치로만 바뀌는 고정값이다.** 앱에서 "실시간 시세 조회" 같은 것을 만들 필요가 없고, 상수 테이블로 충분하다. (다만 시스템이 재개되면 이 전제가 깨진다 — 유지보수 노트 참조)

### R7. 주간 보스 클리어 횟수 제한 (API `weekly_boss_clear_limit_count`)

- 넥슨 공식 가이드: **"캐릭터당 일주일에 최대 12개의 주간 보스를 처치할 수 있으며"**
- 2025-08-21 패치로 **12마리를 채우면 13번째 주간 보스는 입장 자체가 불가능**해졌다. (그 전에는 더 잡을 수는 있고 판매만 12개로 막혔다)
- → API `weekly_boss_clear_limit_count`의 의미는 **"이번 주 이 캐릭터가 입장 가능한 주간 보스 총 횟수"**이며 **값은 12**로 예상된다. `weekly_boss_clear_count`는 현재까지 처치한 수.
- ⚠️ 실제 응답 값은 유효 API 키가 없어 미검증. 개발 착수 시 1회 호출로 반드시 확인할 것.

---

## TypeScript 상수 초안

> 이 코드블록은 **문서 안의 초안**이다. 실제 `src/` 파일 생성은 별도 작업 단위에서 진행할 것.
> `crystalPrice`는 **솔로 기준 메소**. `null`은 "미확인"이며 `0`이 아니다 — 반드시 구분해서 다룰 것.

```ts
export type BossCycle = 'daily' | 'weekly' | 'monthly'
export type BossDifficulty = 'easy' | 'normal' | 'chaos' | 'hard' | 'extreme'

export interface Boss {
  /** 우리가 정한 안정적 slug. 게임/API 값이 아니다. 절대 변경 금지(DB 저장 키) */
  readonly id: string
  /** 난이도를 포함한 한글 표기 (UI 노출용) */
  readonly name: string
  /** 난이도를 뺀 보스 본체명 (그룹핑/필터용) */
  readonly baseName: string
  /** 카톡 봇 명령어 파싱용. 난이도 접두사 없는 형태와 붙은 형태 모두 포함 */
  readonly aliases: readonly string[]
  readonly difficulty: BossDifficulty
  readonly cycle: BossCycle
  /** 솔로(1인 입장) 기준 결정석 판매가(메소). null = 미확인 */
  readonly crystalPrice: number | null
  /** 최대 파티 인원 (입력 검증 상한 겸 1/n 분할 상한) */
  readonly maxParty: number
  /** 입장 가능 최소 레벨 */
  readonly entryLevel: number
  /** 라이브 서버에 출시되어 있는지. false면 수익 계산/등록 UI에서 제외 */
  readonly released: boolean
}

/** 결정석 가격 기준 패치 — 값 갱신 시 이 상수도 같이 올릴 것 */
export const CRYSTAL_PRICE_PATCH = '1.2.202 (2026-06-18)' as const

/** 주간 보스 클리어 및 주간 결정 판매 제한 (캐릭터 단위) */
export const WEEKLY_BOSS_CLEAR_LIMIT = 12 as const
export const WEEKLY_CRYSTAL_SELL_LIMIT = 12 as const
/** 월드 단위 주간 총 판매 제한 (일간+주간+월간 합산) */
export const WORLD_CRYSTAL_SELL_LIMIT = 90 as const

export const DIFFICULTY_LABEL: Record<BossDifficulty, string> = {
  easy: '이지',
  normal: '노멀',
  chaos: '카오스',
  hard: '하드',
  extreme: '익스트림',
}

/**
 * 명령어 파싱용 난이도 별칭.
 * 주의: '이'/'하'/'노'/'카'/'익' 1글자 접두사는 보스명 첫 글자와 충돌할 수 있다
 * (예: '이카' = 이지 카링 vs '이카링'). 파서는 최장 일치(longest match) 우선으로 구현할 것.
 */
export const DIFFICULTY_ALIASES: Record<BossDifficulty, readonly string[]> = {
  easy: ['이지', '이', 'easy', 'e'],
  normal: ['노멀', '노말', '노', 'normal', 'n'],
  chaos: ['카오스', '카', 'chaos', 'c'],
  hard: ['하드', '하', 'hard', 'h'],
  extreme: ['익스트림', '익스', '익', 'extreme', 'x'],
}

export const BOSSES = [
  // ─────────────── 일간 보스 (daily) — 24개 ───────────────
  { id: 'zakum_easy',            name: '이지 자쿰',       baseName: '자쿰',       aliases: ['자쿰', '쟈쿰', '이자쿰', '이쟈쿰', '이자'], difficulty: 'easy',   cycle: 'daily', crystalPrice: 114_000,   maxParty: 6, entryLevel: 50,  released: true },
  { id: 'zakum_normal',          name: '노멀 자쿰',       baseName: '자쿰',       aliases: ['자쿰', '쟈쿰', '노자쿰', '노자'],           difficulty: 'normal', cycle: 'daily', crystalPrice: 349_000,   maxParty: 6, entryLevel: 90,  released: true },
  { id: 'papulatus_easy',        name: '이지 파풀라투스', baseName: '파풀라투스', aliases: ['파풀라투스', '파풀', '이파풀', '이파'],     difficulty: 'easy',   cycle: 'daily', crystalPrice: 390_000,   maxParty: 6, entryLevel: 115, released: true },
  { id: 'magnus_easy',           name: '이지 매그너스',   baseName: '매그너스',   aliases: ['매그너스', '매그', '이매그', '이매'],       difficulty: 'easy',   cycle: 'daily', crystalPrice: 411_000,   maxParty: 6, entryLevel: 115, released: true },
  { id: 'hilla_normal',          name: '노멀 힐라',       baseName: '힐라',       aliases: ['힐라', '노힐라', '노힐'],                   difficulty: 'normal', cycle: 'daily', crystalPrice: 455_000,   maxParty: 6, entryLevel: 85,  released: true },
  { id: 'horntail_easy',         name: '이지 혼테일',     baseName: '혼테일',     aliases: ['혼테일', '혼테', '이혼테', '이혼'],         difficulty: 'easy',   cycle: 'daily', crystalPrice: 502_000,   maxParty: 6, entryLevel: 130, released: true },
  { id: 'bloody_queen_normal',   name: '노멀 블러디퀸',   baseName: '블러디퀸',   aliases: ['블러디퀸', '블퀸', '노블퀸', '노블'],       difficulty: 'normal', cycle: 'daily', crystalPrice: 551_000,   maxParty: 6, entryLevel: 125, released: true },
  { id: 'von_bon_normal',        name: '노멀 반반',       baseName: '반반',       aliases: ['반반', '노반반', '노반'],                   difficulty: 'normal', cycle: 'daily', crystalPrice: 551_000,   maxParty: 6, entryLevel: 125, released: true },
  { id: 'pierre_normal',         name: '노멀 피에르',     baseName: '피에르',     aliases: ['피에르', '노피에르', '노피'],               difficulty: 'normal', cycle: 'daily', crystalPrice: 551_000,   maxParty: 6, entryLevel: 125, released: true },
  { id: 'vellum_normal',         name: '노멀 벨룸',       baseName: '벨룸',       aliases: ['벨룸', '노벨룸', '노벨'],                   difficulty: 'normal', cycle: 'daily', crystalPrice: 551_000,   maxParty: 6, entryLevel: 125, released: true },
  { id: 'horntail_normal',       name: '노멀 혼테일',     baseName: '혼테일',     aliases: ['혼테일', '혼테', '노혼테', '노혼'],         difficulty: 'normal', cycle: 'daily', crystalPrice: 576_000,   maxParty: 6, entryLevel: 130, released: true },
  { id: 'von_leon_easy',         name: '이지 반 레온',    baseName: '반 레온',    aliases: ['반레온', '반레', '이반레', '이반'],         difficulty: 'easy',   cycle: 'daily', crystalPrice: 602_000,   maxParty: 6, entryLevel: 125, released: true },
  { id: 'arkarium_easy',         name: '이지 아카이럼',   baseName: '아카이럼',   aliases: ['아카이럼', '아카', '이아카'],               difficulty: 'easy',   cycle: 'daily', crystalPrice: 656_000,   maxParty: 6, entryLevel: 140, released: true },
  { id: 'kaung_normal',          name: '노멀 카웅',       baseName: '카웅',       aliases: ['카웅', '노카웅'],                           difficulty: 'normal', cycle: 'daily', crystalPrice: 712_000,   maxParty: 6, entryLevel: 180, released: true },
  { id: 'horntail_chaos',        name: '카오스 혼테일',   baseName: '혼테일',     aliases: ['카혼테', '카혼', '카오스혼테일'],           difficulty: 'chaos',  cycle: 'daily', crystalPrice: 770_000,   maxParty: 6, entryLevel: 135, released: true },
  { id: 'pink_bean_normal',      name: '노멀 핑크빈',     baseName: '핑크빈',     aliases: ['핑크빈', '핑빈', '노핑빈', '노핑'],         difficulty: 'normal', cycle: 'daily', crystalPrice: 799_000,   maxParty: 6, entryLevel: 140, released: true }, // ⚠️ 입장 레벨 출처 충돌(140 vs 160)
  { id: 'von_leon_normal',       name: '노멀 반 레온',    baseName: '반 레온',    aliases: ['반레온', '반레', '노반레', '노반'],         difficulty: 'normal', cycle: 'daily', crystalPrice: 830_000,   maxParty: 6, entryLevel: 125, released: true },
  { id: 'von_leon_hard',         name: '하드 반 레온',    baseName: '반 레온',    aliases: ['하반레', '하반', '하드반레온'],             difficulty: 'hard',   cycle: 'daily', crystalPrice: 1_070_000, maxParty: 6, entryLevel: 125, released: true },
  { id: 'arkarium_normal',       name: '노멀 아카이럼',   baseName: '아카이럼',   aliases: ['아카이럼', '아카', '노아카'],               difficulty: 'normal', cycle: 'daily', crystalPrice: 1_110_000, maxParty: 6, entryLevel: 140, released: true },
  { id: 'magnus_normal',         name: '노멀 매그너스',   baseName: '매그너스',   aliases: ['매그너스', '매그', '노매그', '노매'],       difficulty: 'normal', cycle: 'daily', crystalPrice: 1_160_000, maxParty: 6, entryLevel: 155, released: true },
  { id: 'papulatus_normal',      name: '노멀 파풀라투스', baseName: '파풀라투스', aliases: ['파풀라투스', '파풀', '노파풀', '노파'],     difficulty: 'normal', cycle: 'daily', crystalPrice: 1_200_000, maxParty: 6, entryLevel: 155, released: true },
  { id: 'hilla_hard',            name: '하드 힐라',       baseName: '힐라',       aliases: ['하드힐라', '하힐라', '하힐'],               difficulty: 'hard',   cycle: 'daily', crystalPrice: 1_280_000, maxParty: 6, entryLevel: 170, released: true },
  { id: 'pink_bean_chaos',       name: '카오스 핑크빈',   baseName: '핑크빈',     aliases: ['카핑빈', '카핑', '카오스핑크빈'],           difficulty: 'chaos',  cycle: 'daily', crystalPrice: 1_320_000, maxParty: 6, entryLevel: 170, released: true },
  { id: 'cygnus_normal',         name: '노멀 시그너스',   baseName: '시그너스',   aliases: ['시그너스', '시그', '노시그', '여제'],       difficulty: 'normal', cycle: 'daily', crystalPrice: 1_360_000, maxParty: 6, entryLevel: 165, released: true },

  // ─────────────── 주간 보스 (weekly) — 52개 ───────────────
  { id: 'zakum_chaos',                 name: '카오스 자쿰',               baseName: '자쿰',               aliases: ['카자쿰', '카쿰', '카자'],                   difficulty: 'chaos',   cycle: 'weekly', crystalPrice: 8_080_000,     maxParty: 6, entryLevel: 90,  released: true },
  { id: 'bloody_queen_chaos',          name: '카오스 블러디퀸',           baseName: '블러디퀸',           aliases: ['카블퀸', '카블'],                           difficulty: 'chaos',   cycle: 'weekly', crystalPrice: 8_140_000,     maxParty: 6, entryLevel: 180, released: true },
  { id: 'von_bon_chaos',               name: '카오스 반반',               baseName: '반반',               aliases: ['카반반', '카반'],                           difficulty: 'chaos',   cycle: 'weekly', crystalPrice: 8_150_000,     maxParty: 6, entryLevel: 180, released: true },
  { id: 'pierre_chaos',                name: '카오스 피에르',             baseName: '피에르',             aliases: ['카피에르', '카피'],                         difficulty: 'chaos',   cycle: 'weekly', crystalPrice: 8_170_000,     maxParty: 6, entryLevel: 180, released: true },
  { id: 'magnus_hard',                 name: '하드 매그너스',             baseName: '매그너스',           aliases: ['하매그', '하매'],                           difficulty: 'hard',    cycle: 'weekly', crystalPrice: 8_560_000,     maxParty: 6, entryLevel: 175, released: true },
  { id: 'vellum_chaos',                name: '카오스 벨룸',               baseName: '벨룸',               aliases: ['카벨룸', '카벨'],                           difficulty: 'chaos',   cycle: 'weekly', crystalPrice: 9_280_000,     maxParty: 6, entryLevel: 180, released: true },
  { id: 'papulatus_chaos',             name: '카오스 파풀라투스',         baseName: '파풀라투스',         aliases: ['카파풀', '카파'],                           difficulty: 'chaos',   cycle: 'weekly', crystalPrice: 13_100_000,    maxParty: 6, entryLevel: 190, released: true },
  { id: 'lotus_normal',                name: '노멀 스우',                 baseName: '스우',               aliases: ['스우', '노스우', '노스'],                   difficulty: 'normal',  cycle: 'weekly', crystalPrice: 16_700_000,    maxParty: 6, entryLevel: 190, released: true },
  { id: 'damien_normal',               name: '노멀 데미안',               baseName: '데미안',             aliases: ['데미안', '데미', '노데미', '노데'],         difficulty: 'normal',  cycle: 'weekly', crystalPrice: 17_500_000,    maxParty: 6, entryLevel: 190, released: true },
  { id: 'guardian_angel_slime_normal', name: '노멀 가디언 엔젤 슬라임',   baseName: '가디언 엔젤 슬라임', aliases: ['가엔슬', '노가엔슬', '슬라임', 'GAS'],      difficulty: 'normal',  cycle: 'weekly', crystalPrice: 25_500_000,    maxParty: 6, entryLevel: 210, released: true },
  { id: 'lucid_easy',                  name: '이지 루시드',               baseName: '루시드',             aliases: ['루시드', '이루시드', '이루'],               difficulty: 'easy',    cycle: 'weekly', crystalPrice: 29_800_000,    maxParty: 6, entryLevel: 220, released: true },
  { id: 'will_easy',                   name: '이지 윌',                   baseName: '윌',                 aliases: ['윌', '이윌'],                               difficulty: 'easy',    cycle: 'weekly', crystalPrice: 32_300_000,    maxParty: 6, entryLevel: 235, released: true },
  { id: 'lucid_normal',                name: '노멀 루시드',               baseName: '루시드',             aliases: ['루시드', '노루시드', '노루'],               difficulty: 'normal',  cycle: 'weekly', crystalPrice: 35_600_000,    maxParty: 6, entryLevel: 220, released: true },
  { id: 'will_normal',                 name: '노멀 윌',                   baseName: '윌',                 aliases: ['윌', '노윌'],                               difficulty: 'normal',  cycle: 'weekly', crystalPrice: 41_100_000,    maxParty: 6, entryLevel: 235, released: true },
  { id: 'dusk_normal',                 name: '노멀 더스크',               baseName: '더스크',             aliases: ['더스크', '노더스크', '노더'],               difficulty: 'normal',  cycle: 'weekly', crystalPrice: 44_000_000,    maxParty: 6, entryLevel: 245, released: true },
  { id: 'dunkel_normal',               name: '노멀 듄켈',                 baseName: '듄켈',               aliases: ['듄켈', '노듄켈', '노듄'],                   difficulty: 'normal',  cycle: 'weekly', crystalPrice: 47_500_000,    maxParty: 6, entryLevel: 255, released: true },
  { id: 'damien_hard',                 name: '하드 데미안',               baseName: '데미안',             aliases: ['하데미', '하데'],                           difficulty: 'hard',    cycle: 'weekly', crystalPrice: 48_900_000,    maxParty: 6, entryLevel: 190, released: true },
  { id: 'lotus_hard',                  name: '하드 스우',                 baseName: '스우',               aliases: ['하스우', '하스'],                           difficulty: 'hard',    cycle: 'weekly', crystalPrice: 51_500_000,    maxParty: 6, entryLevel: 190, released: true },
  { id: 'lucid_hard',                  name: '하드 루시드',               baseName: '루시드',             aliases: ['하루시드', '하루'],                         difficulty: 'hard',    cycle: 'weekly', crystalPrice: 62_900_000,    maxParty: 6, entryLevel: 220, released: true },
  { id: 'dusk_chaos',                  name: '카오스 더스크',             baseName: '더스크',             aliases: ['카더스크', '카더'],                         difficulty: 'chaos',   cycle: 'weekly', crystalPrice: 69_800_000,    maxParty: 6, entryLevel: 245, released: true },
  { id: 'verus_hilla_normal',          name: '노멀 진 힐라',              baseName: '진 힐라',            aliases: ['진힐라', '진힐', '노진힐라', '노진힐'],     difficulty: 'normal',  cycle: 'weekly', crystalPrice: 71_200_000,    maxParty: 6, entryLevel: 250, released: true },
  { id: 'guardian_angel_slime_chaos',  name: '카오스 가디언 엔젤 슬라임', baseName: '가디언 엔젤 슬라임', aliases: ['카가엔슬', '카슬라임'],                     difficulty: 'chaos',   cycle: 'weekly', crystalPrice: 75_100_000,    maxParty: 6, entryLevel: 210, released: true },
  { id: 'will_hard',                   name: '하드 윌',                   baseName: '윌',                 aliases: ['하윌'],                                     difficulty: 'hard',    cycle: 'weekly', crystalPrice: 77_100_000,    maxParty: 6, entryLevel: 235, released: true },
  { id: 'dunkel_hard',                 name: '하드 듄켈',                 baseName: '듄켈',               aliases: ['하듄켈', '하듄'],                           difficulty: 'hard',    cycle: 'weekly', crystalPrice: 94_400_000,    maxParty: 6, entryLevel: 255, released: true },
  { id: 'verus_hilla_hard',            name: '하드 진 힐라',              baseName: '진 힐라',            aliases: ['하진힐라', '하진힐'],                       difficulty: 'hard',    cycle: 'weekly', crystalPrice: 106_000_000,   maxParty: 6, entryLevel: 250, released: true },
  { id: 'seren_normal',                name: '노멀 선택받은 세렌',        baseName: '선택받은 세렌',      aliases: ['세렌', '노세렌', '노세'],                   difficulty: 'normal',  cycle: 'weekly', crystalPrice: 239_000_000,   maxParty: 6, entryLevel: 260, released: true },
  { id: 'kalos_easy',                  name: '이지 감시자 칼로스',        baseName: '감시자 칼로스',      aliases: ['칼로스', '이칼로스', '이칼'],               difficulty: 'easy',    cycle: 'weekly', crystalPrice: 280_000_000,   maxParty: 6, entryLevel: 265, released: true },
  { id: 'first_adversary_easy',        name: '이지 최초의 대적자',        baseName: '최초의 대적자',      aliases: ['적자', '최적자', '이적자', '이최적자'],     difficulty: 'easy',    cycle: 'weekly', crystalPrice: 308_000_000,   maxParty: 3, entryLevel: 270, released: true },
  { id: 'seren_hard',                  name: '하드 선택받은 세렌',        baseName: '선택받은 세렌',      aliases: ['하세렌', '하세'],                           difficulty: 'hard',    cycle: 'weekly', crystalPrice: 356_000_000,   maxParty: 6, entryLevel: 260, released: true },
  { id: 'kaling_easy',                 name: '이지 카링',                 baseName: '카링',               aliases: ['카링', '이카링', '이카'],                   difficulty: 'easy',    cycle: 'weekly', crystalPrice: 377_000_000,   maxParty: 6, entryLevel: 275, released: true },
  // ⚠️ 벨로나 3종: 2026-08-20/21 출시 예정 · 가격 미확정 → released: false
  { id: 'bellona_easy',                name: '이지 벨로나',               baseName: '벨로나',             aliases: ['벨로나', '이벨로나', '이벨'],               difficulty: 'easy',    cycle: 'weekly', crystalPrice: 440_000_000,   maxParty: 3, entryLevel: 280, released: false },
  { id: 'kalos_normal',                name: '노멀 감시자 칼로스',        baseName: '감시자 칼로스',      aliases: ['칼로스', '노칼로스', '노칼'],               difficulty: 'normal',  cycle: 'weekly', crystalPrice: 505_000_000,   maxParty: 6, entryLevel: 265, released: true },
  { id: 'first_adversary_normal',      name: '노멀 최초의 대적자',        baseName: '최초의 대적자',      aliases: ['노적자', '노최적자'],                       difficulty: 'normal',  cycle: 'weekly', crystalPrice: 560_000_000,   maxParty: 3, entryLevel: 270, released: true },
  { id: 'lotus_extreme',               name: '익스트림 스우',             baseName: '스우',               aliases: ['익스우', '익스스우'],                       difficulty: 'extreme', cycle: 'weekly', crystalPrice: 574_000_000,   maxParty: 2, entryLevel: 190, released: true },
  { id: 'radiant_omen_normal',         name: '노멀 찬란한 흉성',          baseName: '찬란한 흉성',        aliases: ['흉성', '찬흉', '노흉성', '노흉'],           difficulty: 'normal',  cycle: 'weekly', crystalPrice: 625_000_000,   maxParty: 3, entryLevel: 280, released: true },
  { id: 'kaling_normal',               name: '노멀 카링',                 baseName: '카링',               aliases: ['카링', '노카링', '노카'],                   difficulty: 'normal',  cycle: 'weekly', crystalPrice: 678_000_000,   maxParty: 6, entryLevel: 275, released: true },
  // ⚠️ 노멀 벨로나: 출처 충돌 850,000,000 vs 890,000,000 → null 유지, 출시 후 실측으로 확정
  { id: 'bellona_normal',              name: '노멀 벨로나',               baseName: '벨로나',             aliases: ['벨로나', '노벨로나', '노벨'],               difficulty: 'normal',  cycle: 'weekly', crystalPrice: null,          maxParty: 3, entryLevel: 280, released: false },
  { id: 'limbo_normal',                name: '노멀 림보',                 baseName: '림보',               aliases: ['림보', '노림보', '노림'],                   difficulty: 'normal',  cycle: 'weekly', crystalPrice: 1_026_000_000, maxParty: 3, entryLevel: 285, released: true },
  { id: 'kalos_chaos',                 name: '카오스 감시자 칼로스',      baseName: '감시자 칼로스',      aliases: ['카칼로스', '카칼'],                         difficulty: 'chaos',   cycle: 'weekly', crystalPrice: 1_273_000_000, maxParty: 6, entryLevel: 265, released: true },
  { id: 'baldrix_normal',              name: '노멀 발드릭스',             baseName: '발드릭스',           aliases: ['발드릭스', '발드', '노발드릭스', '노발드'], difficulty: 'normal',  cycle: 'weekly', crystalPrice: 1_368_000_000, maxParty: 3, entryLevel: 290, released: true },
  { id: 'first_adversary_hard',        name: '하드 최초의 대적자',        baseName: '최초의 대적자',      aliases: ['하적자', '하최적자'],                       difficulty: 'hard',    cycle: 'weekly', crystalPrice: 1_435_000_000, maxParty: 3, entryLevel: 270, released: true },
  { id: 'jupiter_normal',              name: '노멀 유피테르',             baseName: '유피테르',           aliases: ['유피테르', '유피', '노유피테르', '노유피'], difficulty: 'normal',  cycle: 'weekly', crystalPrice: 1_615_000_000, maxParty: 3, entryLevel: 295, released: true },
  { id: 'kaling_hard',                 name: '하드 카링',                 baseName: '카링',               aliases: ['하카링', '하카'],                           difficulty: 'hard',    cycle: 'weekly', crystalPrice: 1_739_000_000, maxParty: 6, entryLevel: 275, released: true },
  { id: 'limbo_hard',                  name: '하드 림보',                 baseName: '림보',               aliases: ['하림보', '하림'],                           difficulty: 'hard',    cycle: 'weekly', crystalPrice: 2_385_000_000, maxParty: 3, entryLevel: 285, released: true },
  { id: 'radiant_omen_hard',           name: '하드 찬란한 흉성',          baseName: '찬란한 흉성',        aliases: ['하흉성', '하흉'],                           difficulty: 'hard',    cycle: 'weekly', crystalPrice: 2_678_000_000, maxParty: 3, entryLevel: 280, released: true },
  { id: 'seren_extreme',               name: '익스트림 선택받은 세렌',    baseName: '선택받은 세렌',      aliases: ['익세렌', '익세'],                           difficulty: 'extreme', cycle: 'weekly', crystalPrice: 2_835_000_000, maxParty: 6, entryLevel: 260, released: true },
  { id: 'bellona_hard',                name: '하드 벨로나',               baseName: '벨로나',             aliases: ['하벨로나', '하벨'],                         difficulty: 'hard',    cycle: 'weekly', crystalPrice: 2_950_000_000, maxParty: 3, entryLevel: 280, released: false },
  { id: 'baldrix_hard',                name: '하드 발드릭스',             baseName: '발드릭스',           aliases: ['하발드릭스', '하발드'],                     difficulty: 'hard',    cycle: 'weekly', crystalPrice: 3_078_000_000, maxParty: 3, entryLevel: 290, released: true },
  { id: 'kalos_extreme',               name: '익스트림 감시자 칼로스',    baseName: '감시자 칼로스',      aliases: ['익칼로스', '익칼'],                         difficulty: 'extreme', cycle: 'weekly', crystalPrice: 4_104_000_000, maxParty: 6, entryLevel: 265, released: true },
  { id: 'first_adversary_extreme',     name: '익스트림 최초의 대적자',    baseName: '최초의 대적자',      aliases: ['익적자', '익최적자'],                       difficulty: 'extreme', cycle: 'weekly', crystalPrice: 4_712_000_000, maxParty: 3, entryLevel: 270, released: true },
  { id: 'jupiter_hard',                name: '하드 유피테르',             baseName: '유피테르',           aliases: ['하유피테르', '하유피'],                     difficulty: 'hard',    cycle: 'weekly', crystalPrice: 4_845_000_000, maxParty: 3, entryLevel: 295, released: true },
  { id: 'kaling_extreme',              name: '익스트림 카링',             baseName: '카링',               aliases: ['익카링', '익카'],                           difficulty: 'extreme', cycle: 'weekly', crystalPrice: 5_387_000_000, maxParty: 6, entryLevel: 275, released: true },

  // ─────────────── 월간 보스 (monthly) — 2개 ───────────────
  { id: 'black_mage_hard',    name: '하드 검은 마법사',     baseName: '검은 마법사', aliases: ['검마', '흑마', '하검마', '하검', '하드검은마법사'], difficulty: 'hard',    cycle: 'monthly', crystalPrice: 665_000_000,   maxParty: 6, entryLevel: 255, released: true },
  { id: 'black_mage_extreme', name: '익스트림 검은 마법사', baseName: '검은 마법사', aliases: ['익검마', '익검', '익스검마'],                       difficulty: 'extreme', cycle: 'monthly', crystalPrice: 8_740_000_000, maxParty: 6, entryLevel: 255, released: true },
] as const satisfies readonly Boss[]

/** 파티 인원 분할 — 표 가격은 솔로 기준이므로 반드시 이 함수를 거쳐야 한다 */
export function crystalPayout(price: number, partySize: number): number {
  return Math.floor(price / partySize)
}

/**
 * 그 주에 클리어한 주간 보스들의 실수령 결정석 수익.
 * 게임 규칙상 12개 초과분은 "가장 싼 것과의 차액"만 지급되므로,
 * 결과적으로 비싼 순 상위 12개의 합과 같아진다.
 */
export function weeklyCrystalIncome(payouts: readonly number[]): number {
  return [...payouts]
    .sort((a, b) => b - a)
    .slice(0, WEEKLY_CRYSTAL_SELL_LIMIT)
    .reduce((sum, v) => sum + v, 0)
}
```

---

## 미확인 / 불확실 항목

아래는 **확인하지 못했거나 출처가 엇갈리는 것**이며, 사실로 간주해서는 안 된다.

1. **벨로나(이지/노멀/하드) 결정석 가격.** 넥슨 **공식 패치 노트에서 결정 가격을 확인하지 못했다.** 위키 값은 이지 440,000,000 / 하드 2,950,000,000이고 **노멀은 850,000,000(강렬한 힘의 결정 문서) vs 890,000,000(벨로나 문서)로 엇갈린다.** 노멀은 상수에서 `null`로 두었다. 출시(8/20) 후 인게임 실측 필요.
2. **벨로나 출시일 표기 충돌**: 인벤 뉴스 = 2026-08-13(목), 나무위키/테스트월드 공지 = 2026-08-20 정식 출시(하드는 8/21). 8/13은 "Maple Now 방송에서 공개"한 날로 보이며, **실제 오픈은 8/20**으로 판단했다.
3. **`maxParty: 6` 값 상당수는 보스 개별 문서에 명시된 값이 아니다.** 나무위키의 "최대 인원 제한" 정보 상자 필드는 비교적 최근 보스 문서에만 존재한다. 개별 명시가 확인된 것은 **세렌 6 / 칼로스 6 / 카링 6 / 최초의 대적자 3 / 림보 3 / 발드릭스 3 / 찬란한 흉성 3 / 유피테르 3 / 벨로나 3 / 익스트림 스우 2 / 검은 마법사 6 / 가디언 엔젤 슬라임 6**뿐이다.
   나머지(자쿰~듄켈, 노멀·하드 스우 등)의 `6`은 「보스 컨텐츠」 문서의 서술 **"강원기 체제까지의 보스들은 최대 6인까지 입장이 가능… 김창섭 체제의 보스들은 입장 인원이 최대 3인으로 제한"** 및 각주 **"익스트림 스우는 최대 2인, 나머지는 최대 3인"** 에서 도출한 값이다. → **1/n 분할에 직결되므로 인게임 보스 UI로 최종 확인 권장.**
4. **입장 레벨 출처 충돌 2건**:
   - **노멀 핑크빈**: 정보 상자 140 vs 같은 문서 상세표 160. 시간의 신전 맵 입장 제한(140)과의 정합성을 근거로 **140을 채택**했다.
   - **자쿰**: 정보 상자 이지 50 / 노멀·카오스 90 vs 문서 하단 상세표 50·100. 상세표는 빅뱅 이전 과거 데이터로 보여 **정보 상자 값을 채택**했다.
5. **"월드당 90개" 제한의 정확한 주체.** "한 월드에 있는 그 계정의 전 캐릭터 합산"으로 읽는 것이 자연스럽지만(2021년 패치가 "캐릭터당 60개 → 월드당 180개"), **넥슨 1차 출처로 확정하지 못했다.** 실사용상 병목은 주간 12개이므로 v1 계산 로직에는 큰 영향이 없다.
6. **넥슨 공식 가이드(`Guide/N23GameInformation/Articles/458`)의 문구가 최신인지 여부.** 이 페이지는 "강렬한 힘의 결정은 일주일 동안 **캐릭터당 최대 12개**까지 판매 가능"이라고만 적혀 있고 **일간/주간/월간 분리 및 월드당 90개를 언급하지 않는다.** 2024-07-18 분리 이전 문구가 갱신되지 않고 남아 있을 가능성이 있다. 위키·커뮤니티는 일관되게 "주간 결정만 12개 / 전체 90개"라고 설명한다. **두 설명이 충돌한다는 사실 자체를 기록해 둔다.**
7. **API `weekly_boss_clear_limit_count`의 실제 반환값.** 게임 규칙상 12가 유력하나 유효 API 키가 없어 실호출 미검증. `boss_contents[].difficulty` / `cycle`의 실제 문자열 값도 동일하게 미검증(`research-NEXON-API.md` 미확인 항목 1번과 동일 건). → **우리 slug ↔ API 문자열 매핑 테이블은 실호출 후에 확정해야 한다.**
8. **일간 보스 결정 가격의 교차 검증 부족.** 2026-06-18 패치 노트에 등장한 7개(하드 반레온·노멀 아카이럼·노멀 매그너스·노멀 파풀라투스·하드 힐라·카오스 핑크빈·노멀 시그너스)는 복수 출처로 확인했으나, **나머지 일간 17개 가격은 나무위키 단일 출처**다. (주간·월간 가격은 나무위키 / 인벤 패치노트 전재 / 외부 계산기 3중 교차 확인 완료)
9. **`권장 스펙`(요구 전투력 등)은 수집하지 않았다.** 공식 수치가 아니라 커뮤니티 추정치이고 편차가 크다. 가디언 엔젤 슬라임 노멀 "솔로 기준 4~6억 전투력" 같은 언급만 확인했다. 앱에 넣으려면 별도 조사 필요.
10. **별칭 목록은 1차 출처 기반이 아니다.** 나무위키 `보스돌이` 문서에서 실제로 확인된 것은 `노스데`, `하스뎀/스데미`, `노루윌`, `하루윌`, `카더듄/카듄더`, `노세이칼`, `검밑솔`, `검윗솔`, `카쿰`, 그리고 `최초의 대적자 → 적자/최적자/이적자/노적자/하적자/익적자` 정도다. **표의 나머지 별칭은 통용 표기 규칙(난이도 접두사 + 보스 약칭)에 따라 편집자가 구성한 것**이며, 실사용 로그로 검증되지 않았다. 봇 오픈 후 미매칭 입력을 로깅해 보강할 것.
11. **복합 별칭(`노스데`, `하루윌`, `카더듄`, `노세이칼` 등)은 "보스 2마리 묶음"을 뜻하므로 위 테이블의 1:1 별칭에 넣지 않았다.** 명령어 파서에서 별도 처리(입력 1개 → 보스 2개 등록)가 필요하다.
12. **`radiant_omen`(찬란한 흉성) slug는 임의 작명이다.** 공식 영문 명칭을 확인하지 못했다. 다른 slug들도 GMS 통용 영문명을 참고한 우리 자체 값이며, **DB에 저장되는 순간 변경 불가**임에 유의.
13. **접근 실패로 검증하지 못한 경로**: arca.live(403), fmkorea(403/429), thewiki.kr(403), 넥슨 공식 게임가이드 상당수(JS 렌더링/로그인 게이트/302). 인벤 보스 DB·게임메카 보스공략은 현재 404.

---

## 유지보수 노트

### 패치 때 갱신해야 하는 것

| 트리거 | 갱신 대상 |
|---|---|
| **결정석 가격 조정 패치** | `BOSSES[].crystalPrice` 전량 재확인 + `CRYSTAL_PRICE_PATCH` 문자열 갱신 |
| **신규 보스 추가** | `BOSSES`에 난이도별 엔트리 추가, `aliases` 등록, `released` 플래그 관리 |
| **보스 주기 변경(주간↔일간)** | `cycle` 변경. **주간 12개 카운터 대상이 바뀌므로 수익 로직에 즉시 영향.** 2026-06-18에 실제로 3건 발생했다 |
| **난이도 통합/삭제** | 해당 `id`를 삭제하지 말고 **`released: false`로 내려서 과거 기록을 보존할 것.** 2026-06-18 `cygnus_easy` 소멸이 실제 사례 |
| **파티 인원 상한 변경** | `maxParty`. 익스트림 스우가 2024-04-18 리마스터로 6인 → 2인이 된 전례가 있다 |
| **판매 제한 수치 변경** | `WEEKLY_CRYSTAL_SELL_LIMIT` / `WORLD_CRYSTAL_SELL_LIMIT` / `WEEKLY_BOSS_CLEAR_LIMIT` |
| **가격 변동 시스템 재개** | 상수 테이블 전제가 깨진다. R6 참조 — 재개 시 설계 재검토 필요 |

### 즉시 예정된 갱신

- **2026-08-20 / 08-21 — 벨로나 출시.** 3종 엔트리를 `released: true`로 올리고 **결정석 가격을 인게임에서 실측**할 것. 노멀 값은 출처가 엇갈리므로 반드시 실측으로 확정.
- 신규 보스 출시에 맞춰 **기존 결정석 추가 하향이 있을 수 있다**(커뮤니티에서 거론 중). 8/20 이후 전 항목 재대조 권장.
- **2026-09-16 — 메이린(챌린저스 월드 이벤트 보스) 입장 종료.** 만약 이벤트 보스를 앱에 넣기로 한다면 이 날짜에 비활성화.

### 갱신 절차 (권장)

1. 넥슨 공식 업데이트/패치노트에서 변경 내역 확보 (1차 출처)
2. 나무위키 `강렬한 힘의 결정` 문서로 최종 가격표 교차 확인 (2차)
3. 인벤 패치노트 전재글 또는 외부 계산기로 3차 확인
4. 값이 엇갈리면 **임의 선택하지 말고** 이 문서의 「미확인」 절에 기록 → 인게임 실측으로 확정
5. `Claude/PROGRESS.md`에 갱신 이력 남기기

### 데이터 구조 관련 주의

- **`id`는 DB에 저장되는 키다. 한 번 정하면 바꾸지 말 것.** 이름/가격이 바뀌어도 `id`는 유지한다.
- **가격 변경 시 과거 주차 수익이 소급 변경되면 안 된다.** 주차 스냅샷 테이블에 **그 시점의 결정석 단가와 파티 인원을 함께 저장**해야 한다. 상수 테이블만 참조해 과거 수익을 재계산하면 패치 때마다 지난 기록이 틀어진다.
- API의 `content_name` / `difficulty` 문자열은 enum이 없는 자유 문자열이므로, **우리 `id`와의 매핑 테이블을 별도로 두고 매핑 실패 시 로그를 남길 것.** 신규 보스가 추가되면 API에는 먼저 나타나지만 우리 상수에는 없을 수 있다.

---

## 출처

### 공식 (넥슨)

- 보스 컨텐츠 공식 가이드 (주간 12회 제한, 결정 판매 12개/목요일 0시 초기화, 가격이 "보스 종류·입장 파티원 수"에 따라 달라짐): https://maplestory.nexon.com/Guide/N23GameInformation/Articles/458
- 인게임 메이플 — 카웅 보스 가이드 (최저 입장 레벨 180 / 최고 300, 1일 1회, 매일 자정 초기화): https://gi.maplestory.nexon.com/Guide/GameInformation/Boss/Kaung
- 테스트월드 업데이트 — 벨로나 (입장 Lv.280, 이지/노멀/하드, 하드는 2026-08-21 오픈): https://maplestory.nexon.com/testworld/news/update/193
- 업데이트 뉴스 (2026 OVERDRIVE, 챌린저스 월드 / 신규 보스 메이린): https://maplestory.nexon.com/news/update/805
- 신규 보스 최초의 대적자 프로모션: https://maplestory.nexon.com/promotion/event/2025/20250821/event01

### 위키 — 가격 / 규칙

- **강렬한 힘의 결정 (핵심 가격표 · 판매 제한 · 1/n 분할 · 개편 이력)** — 최종 수정 2026-08-14: https://namu.wiki/w/%EA%B0%95%EB%A0%AC%ED%95%9C%20%ED%9E%98%EC%9D%98%20%EA%B2%B0%EC%A0%95
- 강렬한 힘의 결정 (r860 판, 판매 제한 세부 확인): https://namu.wiki/w/%EA%B0%95%EB%A0%AC%ED%95%9C%20%ED%9E%98%EC%9D%98%20%EA%B2%B0%EC%A0%95?uuid=c4c3c3a4-664e-44d6-a4ac-a5df36956bcc
- 강렬한 힘의 결정 (미러, 판매 제한 원문 재확인): https://www.namu.moe/w/%EA%B0%95%EB%A0%AC%ED%95%9C%20%ED%9E%98%EC%9D%98%20%EA%B2%B0%EC%A0%95
- 보스돌이 (주간 12개 제한 · 별칭 · 검밑솔/검윗솔): https://namu.wiki/w/%EB%B3%B4%EC%8A%A4%EB%8F%8C%EC%9D%B4
- 메이플스토리/보스 몬스터/보스 컨텐츠 (일일/주간/월간 구분, 초기화 시점, 주간 전체 12회, **6인/3인/2인 세대별 파티 상한 서술**): https://namu.wiki/w/%EB%A9%94%EC%9D%B4%ED%94%8C%EC%8A%A4%ED%86%A0%EB%A6%AC/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0/%EB%B3%B4%EC%8A%A4%20%EC%BB%A8%ED%85%90%EC%B8%A0
- 메이플스토리/보스 몬스터/보스 티어 (검은 마법사 `[6인]` 태그): https://namu.wiki/w/%EB%A9%94%EC%9D%B4%ED%94%8C%EC%8A%A4%ED%86%A0%EB%A6%AC/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0/%EB%B3%B4%EC%8A%A4%20%ED%8B%B0%EC%96%B4

### 위키 — 보스별 입장 레벨 / 파티 인원

(각 문서 상단 정보 상자의 "입장 가능 레벨" / "최대 인원 제한" 항목 기준)

- 자쿰: https://namu.wiki/w/%EC%9E%90%EC%BF%B0(%EB%A9%94%EC%9D%B4%ED%94%8C%EC%8A%A4%ED%86%A0%EB%A6%AC)
- 매그너스: https://namu.wiki/w/%EB%A7%A4%EA%B7%B8%EB%84%88%EC%8A%A4(%EB%A9%94%EC%9D%B4%ED%94%8C%EC%8A%A4%ED%86%A0%EB%A6%AC)/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 힐라: https://namu.wiki/w/%ED%9E%90%EB%9D%BC/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 파풀라투스: https://namu.wiki/w/%ED%8C%8C%ED%92%80%EB%9D%BC%ED%88%AC%EC%8A%A4
- 피에르: https://namu.wiki/w/%ED%94%BC%EC%97%90%EB%A5%B4(%EB%A9%94%EC%9D%B4%ED%94%8C%EC%8A%A4%ED%86%A0%EB%A6%AC)
- 반반: https://namu.wiki/w/%EB%B0%98%EB%B0%98(%EB%A9%94%EC%9D%B4%ED%94%8C%EC%8A%A4%ED%86%A0%EB%A6%AC)
- 블러디 퀸: https://namu.wiki/w/%EB%B8%94%EB%9F%AC%EB%94%94%20%ED%80%B8
- 벨룸: https://namu.wiki/w/%EB%B2%A8%EB%A3%B8/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 반 레온: https://namu.wiki/w/%EB%B0%98%20%EB%A0%88%EC%98%A8/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 아카이럼: https://namu.wiki/w/%EC%95%84%EC%B9%B4%EC%9D%B4%EB%9F%BC/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 핑크빈: https://namu.wiki/w/%ED%95%91%ED%81%AC%EB%B9%88
- 시그너스: https://namu.wiki/w/%EC%8B%9C%EA%B7%B8%EB%84%88%EC%8A%A4(%EB%A9%94%EC%9D%B4%ED%94%8C%EC%8A%A4%ED%86%A0%EB%A6%AC)/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 혼테일: https://namu.wiki/w/%ED%98%BC%ED%85%8C%EC%9D%BC
- 카웅: https://namu.wiki/w/%EC%B9%B4%EC%9B%85
- 가디언 엔젤 슬라임: https://namu.wiki/w/%EA%B0%80%EB%94%94%EC%96%B8%20%EC%97%94%EC%A0%A4%20%EC%8A%AC%EB%9D%BC%EC%9E%84
- 스우 (익스트림 최대 2인, 2024-04-18 리마스터): https://namu.wiki/w/%EC%8A%A4%EC%9A%B0/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 데미안: https://namu.wiki/w/%EB%8D%B0%EB%AF%B8%EC%95%88(%EB%A9%94%EC%9D%B4%ED%94%8C%EC%8A%A4%ED%86%A0%EB%A6%AC)/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 루시드: https://namu.wiki/w/%EB%A3%A8%EC%8B%9C%EB%93%9C(%EB%A9%94%EC%9D%B4%ED%94%8C%EC%8A%A4%ED%86%A0%EB%A6%AC)/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 윌: https://namu.wiki/w/%EC%9C%8C(%EB%A9%94%EC%9D%B4%ED%94%8C%EC%8A%A4%ED%86%A0%EB%A6%AC)/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 더스크: https://namu.wiki/w/%EB%8D%94%EC%8A%A4%ED%81%AC
- 진 힐라: https://namu.wiki/w/%EC%A7%84%20%ED%9E%90%EB%9D%BC
- 듄켈: https://namu.wiki/w/%EB%93%84%EC%BC%88/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 검은 마법사: https://namu.wiki/w/%EA%B2%80%EC%9D%80%20%EB%A7%88%EB%B2%95%EC%82%AC/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 선택받은 세렌: https://namu.wiki/w/%EC%84%A0%ED%83%9D%EB%B0%9B%EC%9D%80%20%EC%84%B8%EB%A0%8C
- 감시자 칼로스: https://namu.wiki/w/%EA%B0%90%EC%8B%9C%EC%9E%90%20%EC%B9%BC%EB%A1%9C%EC%8A%A4
- 최초의 대적자: https://namu.wiki/w/%EC%B5%9C%EC%B4%88%EC%9D%98%20%EB%8C%80%EC%A0%81%EC%9E%90
- 카링: https://namu.wiki/w/%EC%B9%B4%EB%A7%81/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 찬란한 흉성: https://namu.wiki/w/%EC%B0%AC%EB%9E%80%ED%95%9C%20%ED%9D%89%EC%84%B1
- 벨로나: https://namu.wiki/w/%EB%B2%A8%EB%A1%9C%EB%82%98(%EB%A9%94%EC%9D%B4%ED%94%8C%EC%8A%A4%ED%86%A0%EB%A6%AC)/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 림보: https://namu.wiki/w/%EB%A6%BC%EB%B3%B4(%EB%A9%94%EC%9D%B4%ED%94%8C%EC%8A%A4%ED%86%A0%EB%A6%AC)/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 발드릭스: https://namu.wiki/w/%EB%B0%9C%EB%93%9C%EB%A6%AD%EC%8A%A4/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 유피테르: https://namu.wiki/w/%EC%9C%A0%ED%94%BC%ED%85%8C%EB%A5%B4(%EB%A9%94%EC%9D%B4%ED%94%8C%EC%8A%A4%ED%86%A0%EB%A6%AC)/%EB%B3%B4%EC%8A%A4%20%EB%AA%AC%EC%8A%A4%ED%84%B0
- 메이린 (챌린저스 월드 전용 이벤트 보스, 주간 제한 미포함, 2026-09-16 종료): https://namu.wiki/w/%EB%A9%94%EC%9D%B4%EB%A6%B0(%EB%A9%94%EC%9D%B4%ED%94%8C%EC%8A%A4%ED%86%A0%EB%A6%AC)

### 커뮤니티 / 2차 자료 (교차 확인용)

- 인벤 「[1.2.202] 강렬한 힘의 결정 개편」 — 52개 항목 변경 전/후 가격 전량 (테스트 서버 공지 전재, 2026-06-14): https://www.inven.co.kr/board/maple/5974/6682358
- 인벤 「보스 결정석 가격 변동 가격 및 변동률」: https://www.inven.co.kr/board/maple/5974/6692128
- 인벤 「[1.2.183] 결정 판매 제한 180 > 90개로 감소」: https://www.inven.co.kr/board/maple/5974/4563005
- 인벤 뉴스 「신규 보스 벨로나 출시! 8/13(목) Maple Now」 (Lv.280 · 3인 · 난이도 3종): https://www.inven.co.kr/webzine/news/?news=319507
- devcomma 「메이플스토리 주보 수익 계산기」 — 주간/월간 가격 3차 교차 확인 (2026-06-18 기준 명시): https://tools.devcomma.com/calculators/maplestory-weekly-boss-profit
- 게임톡 「메이플스토리, 신규 보스 '최초의 대적자' 등장」 (이지/노멀/하드/익스트림 · 최대 3인 · Lv.270 · 오디움 스토리 선행): https://www.gametoc.co.kr/news/articleView.html?idxno=100944
- 게임플 「메이플 여름 마지막 퍼즐, 신규 보스 '벨로나'」: https://www.gameple.co.kr/news/articleView.html?idxno=216153
- 게임뷰 「넥슨 '메이플스토리', 신규 보스 '벨로나'로 280레벨 보스전 연다」: https://www.gamevu.co.kr/news/articleView.html?idxno=60007
- 메이플스토리 공식 커뮤니티 「보스 결정석 가격」 스레드 (가격 하향에 대한 유저 반응): https://m.maplestory.nexon.com/Community/N23Free/418819
