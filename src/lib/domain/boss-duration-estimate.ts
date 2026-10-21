/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 보스 소요 시간 — **기본값 · 우선순위 · "하나 고치면 나머지도"** 의 유일한 주인
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 흐름(전부 2026-10-21):
 *   ① *"각 보스의 소요시간을 대략적으로 만들고싶은데 하나를 입력하면 다 같이 계산되도록"*
 *   ② *"일단 현재 가장 어려운 보스를 20분으로 잡아서 자동계산 넣어버려. 세세한건 수정 조금씩
 *      해주고. 캐릭별 보스 관리에서 시간 수정 할수 있게. 기본값을 넣어주고 사람이 수정하면
 *      수정되도록."*
 *   ③ *"이게 배율이야. … 60% 2인이면 120% 인건 알겠지? 배율 110% 를 대충 20분 으로 치고
 *      올라갈수록 시간이 줄어드는거임. 이걸 기반으로 시간대 조절해봐. 이건 본캐라 엄청 높은거고
 *      체력기준으로 배율이 나오니까 각 보스의 시간정도는 계산되지? 부캐일때 어느 한 보스가
 *      15분 걸리면 다른보스들 쫙 계산 가능하지?"* — 본캐의 보스별 **배율표**(스크린샷)와 함께.
 *
 * ②가 이 파일의 성격을 정한다: **기본값은 진실이 아니라 출발점이다.** 실제 소요는 그
 * 캐릭터가 솔플이냐 · 센 사람과 2인이냐에 따라 달라진다. 그래서 이 파일은 **기본값**을
 * 만들고, 사람이 고친 값이 언제나 이긴다(아래 3절).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 0. 왜 계단이 아니게 됐나 (2026-10-21 저녁)
 * ─────────────────────────────────────────────────────────────────────────────
 * 같은 날 첫 판은 **계단** 모델이었다: "1극(극딜 한 주기) ≈ 2분" 을 한 칸으로 보고, 발주자가
 * 말로 준 순서(*"세대카는 동급, 림흉동급 < 벨로나 < 발드"*, *"노말 대적자 1인을 잡을수있으면
 * 하드 진힐라는 거의 1~2분"* → 하진힐 −6 칸)를 표에 박은 뒤, 표에 없는 보스는 시세로 칸을
 * 끼웠다. 칸 간격은 `2분 ÷ 인원`이었다. 그 모델의 한계는 **근거가 말뿐**이라는 것이었다 —
 * 칸 간격이 고정이라 "하드 보스는 몇 배 어렵다"를 표현할 수 없었고, 하진힐 한 점을 맞추려고
 * 세대카 아래 6칸을 손으로 벌려야 했다. ③에서 발주자가 **실측 배율**을 줬으므로 근거를
 * 그것으로 바꾼다. 순서(세대카 ≈ 림흉 < 벨로나 < 발드)는 배율표에서도 그대로 나온다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. 배율 — 소요 시간은 배율에 **반비례**한다
 * ─────────────────────────────────────────────────────────────────────────────
 * 배율 = 캐릭터 딜 ÷ 보스 체력 요구치(%). 파티는 배율이 **더해진다**(60% × 2인 = 120%).
 * 같은 딜로 체력이 두 배인 보스는 두 배 걸리므로:
 *     소요 시간 ∝ 1 / 배율
 * 배율의 출처는 둘이다:
 *   (가) **표** — `BOSS_HP_RATIO_PERCENT`. 발주자 본캐의 솔로 배율(스크린샷 판독).
 *   (나) **시세로 끼움** — 표에 없는 보스. ② *"자동계산 넣어버려"* 때문에 필요하다.
 *       표 보스들을 결정석 시세 순으로 놓고, 양옆 이웃 사이를 **log(시세)–log(배율) 직선**
 *       으로 보간한다. 시세와 체력은 둘 다 "어려움"을 곱의 척도로 따라가므로 로그끼리 잇는다.
 *       ★ 닻은 **주간·시즌 보스만**이다 — 월간은 시세 척도가 달라 직선을 휜다
 *         (`isRatioAnchorCandidate`).
 *       - 가장 비싼 표 보스보다 비싸다 → 표의 **최소 배율**(→ 20분 벽).
 *       - 가장 싼 표 보스보다 싸다 → **반비례 외삽**: 시세가 절반이면 배율 두 배(→ 대개 1분).
 *       - 시세가 `null` → 배율 **없음**(§1.3 D4 — 모르는 것은 지어내지 않는다). 3절의
 *         마지막 방어선(`fallbackMinutes`)으로 간다.
 * 화면·보고가 둘을 갈라 보이도록 결과에 `source: "table" | "price"` 를 싣는다. 발주자가
 * (나)를 보고 실측을 (가)로 옮겨 적는 것이 이 표가 자라는 방식이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 2. 전역 기본값 — "배율 110% = 20분"
 * ─────────────────────────────────────────────────────────────────────────────
 *     기본값(보스) = 20 × 110 / 배율(보스) → 반올림 → 1~20 (RUN_DURATION_MIN/MAX)
 * 기준점은 ③ 원문 그대로다(`REFERENCE_RATIO_PERCENT` · `REFERENCE_MINUTES`). 110% 보다
 * 어려운 보스(익스트림 칼로스 50% 등)는 계산상 20분을 넘지만 한 판 상한(20)에 막힌다.
 * ⚠️ **본캐 기준이다.** 표는 발주자 본캐(배율이 "엄청 높은")의 값이라 부캐에게는 기본값이
 *    **짧게** 나온다. 부캐는 보스 하나를 실제 분(그 줄의 인원으로)으로 넣으면 3절의 세기 k 가 나머지를 맞춘다
 *    (③ *"부캐일때 어느 한 보스가 15분 걸리면 다른보스들 쫙 계산"*).
 *
 * 근사의 한계 — 알고 쓰는 것:
 *   - 스크린샷의 보스별 **스탯 값이 서로 다르다**(114,411 / 113,868 / 110,972 / 107,721).
 *     포스(아케인·어센틱) 보정으로 보인다. 부캐는 포스가 본캐와 달라 보스 사이 비율이
 *     조금 어긋난다.
 *   - 실제 시간에는 페이즈 전환·무적·연출 같은 **고정 시간**이 있다. 순수 반비례는 이를
 *     모르므로 아주 쉬운 보스는 계산상 1분 미만이 되어 **1분 바닥**에 막힌다.
 *   - 표에서 뺀 것: 스크린샷의 `[파티]` 표기 값(익스트림 카링 127% · 하드 유피테르 57% ·
 *     익스트림 발드릭스 · 익스트림 림보)은 **파티 기준**이라 솔로 배율과 같은 자에 놓을 수
 *     없다 — 이 보스들은 (나) 시세로 끼운다. DESTINY 는 퀘스트 콘텐츠(CLAUDE.md §1.0),
 *     CHAMPION 은 우리 `boss_difficulty_tier` 에 없는 난이도라 버렸다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 3. 캐릭터 세기 k — 계획 한 줄(분 + 그 줄의 인원)이 그 캐릭터의 배율을 알려 준다
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주(2026-10-21): *"솔로 보스 하나를 입력하면 그 보스의 배율을 알수있으니 다른 파티의
 * 시간을 입력하라는 소리인데"* · *"거의 동일 배율로 구한다고. 솔플로 하는거 10분이상을
 * 입력하면 파티도 같이 계산되도록 해"*.
 * ★ **줄의 인원 — 그 분은 그 줄의 인원 n 으로 친 시간이다**(발주자 제보 2026-10-21:
 *   `/boss-plans` 한 줄 "익스트림 선택받은 세렌 · 시간 15분 · 3인" 에 *"익세 솔로 15분 기준이면
 *   본캐 배율의 약 1.08배"* 라고 적자 *"3인이라고 표시 되어있는데 왜이러는거임?"*).
 *   n ← `character_boss_plans.default_party_size`(결정석 1/n 에 쓰는 그 값, 없거나 비정상이면
 *   1). 파티원 배율이 거의 같다고 보면 n인 배율 = n × 효율(n) × 혼자 배율이므로(4절 효율):
 *     그 줄에서 읽은 캐릭터(혼자) 배율 = 20 × 110 / (넣은 분 × n × 효율(n))
 *     k(입력 한 줄)                   = 캐릭터 배율 / 본캐 배율(그 보스)
 *     k(캐릭터)                       = 보정에 쓸 수 있는 줄들의 k 의 **기하평균**
 *   n = 1 이면 효율 1 이라 이 정의 이전(같은 날 저녁, "솔로 값")과 같은 값이다.
 * ★ 보정에 쓰는 줄은 **10분 이상**(`CALIBRATION_MIN_MINUTES`)이다 — 원문의 조건. 짧은
 *   시간은 페이즈 전환·무적 같은 고정 시간에 묻혀 배율을 읽을 수 없다. 이 조건과 아래
 *   경계값 규칙은 **넣은 분 그대로**에 건다(× n 이 아니다) — 고정 시간·상한은 그 판의 시계다.
 *   (같은 날 밤 "입력값들을 기준점으로 보스마다 k 를 보간"하는 안이 나왔으나 발주자가
 *    *"이건 보류"* — 지금은 k 하나다.)
 * ★ **경계값 규칙 — 가둬진 값은 정확한 배율이 아니다**(이 파일의 가정, 2026-10-21 교차 검증).
 *   한 판은 1~20분으로 가둬지므로, 사람이 넣은 **20 은 "20분 이상", 1 은 "1분 이하"**일 수
 *   있다(`isClampedMinutes`). 실제 40분 보스를 20으로 넣은 줄을 배율로 읽으면 두 배 세게
 *   잡힌다. 그래서 한 규칙으로 두 자리에 쓴다:
 *     - k 보정: 20 은 쓰지 않는다(1 은 이미 10분 하한에 걸린다) → 보정 줄은 10~19분.
 *     - 파티 합산(4절): 경계값을 그 참여자의 **정확한 배율로 쓰지 않고** k 기반 추정(자기 k
 *       ?? 빌린 k)으로 대신한다. 아래 "나머지 맞추기"가 계산상 20을 넘는 보스를 20으로
 *       저장하므로, 이 규칙이 없으면 그 저장값이 2인 런을 반토막 냈다(익칼 19 → 10).
 *     - 단, **혼자 가는 런이고 그 줄도 1인**이면 경계값이 곧 답이다 — 결과도 같은 1~20 으로
 *       가둬지므로 "20 이상"과 20 이 같은 숫자가 된다. 캐릭터 맥락의 줄 분(아래)도 그 줄
 *       자신의 값이라 20 을 그대로 쓴다.
 *     - 본캐 배율이 없는 보스(시세 미확인)는 경계값이라도 그대로 쓴다 — 다른 근거가 없다.
 * ★ 스키마 변경이 없다 — `character_boss_plans.duration_minutes` 행에서 매번 파생한다.
 *   보정할 줄이 없으면 그 캐릭터는 **미보정**(k 모름)이다.
 * ★ 캐릭터 맥락의 줄 분(보스) = 사람이 넣은 값 ?? 20×110/(n × 효율(n) × k × 본캐 배율) — k
 *   모르면 1(`characterRowMinutes`). **그 줄의 인원으로 친 시간**이다. `/boss-plans` 표시·
 *   총/남은 시간·`!숙제` 카드가 이것을 쓴다. 그래서 부캐에 보스 하나만 넣어도 나머지
 *   기본값과 총 시간이 함께 움직인다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 4. 파티 런의 분 · 우선순위 — `resolveBossDuration` 한 곳에만 적는다
 * ─────────────────────────────────────────────────────────────────────────────
 *     묶음에 사람이 넣은 값 > 20 × 110 / (Σ 참여자 배율 × 효율(참여 인원)) > 20(DEFAULT_RUN_MINUTES)
 * 파티는 배율이 **더해지되 조금 손실이 있다**(60% × 2 = 120% 의 "조금 덜"). 참여자 i 의 배율은:
 *   - 그 캐릭터가 그 보스에 값을 넣었으면 → 20 × 110 / (그 값 × n_i × 효율(n_i))(직접 쓴다).
 *     단 그 값이 경계값(1·20)이면 3절의 경계값 규칙대로 아래 k 추정으로 대신한다(혼자 가는
 *     런이면서 1인 줄 · 배율 없는 보스는 예외);
 *   - 아니면 k_i × 본캐 배율(보스);
 *   - k_i 를 모르는 참여자(게스트 · 입력 없는 캐릭터)는 *"거의 동일 배율"* 대로 **같은 런의
 *     보정된 참여자 k 의 기하평균**, 아무도 보정되지 않았으면 k = 1(본캐 기준).
 * ★ **파티 효율 `PARTY_EFFICIENCY`** — 발주(2026-10-21): *"파티인경우 배율에서 너프가 좀
 *   들어간다고 생각하고"* → *"그냥 계산에다가만 넣고 조정하지마. 너무 티나게 많이 넣지말고
 *   조금만 ㄱㄱ"*. 1인 1 · 2인 0.95 · 3인 0.93 · 4인 이상 0.9. **값은 어림이고 발주자가 고치는
 *   상수**다. 화면 설정·문구 노출은 없다(내부 식). 역방향(3절 줄 → k)도 **같은 계수**라
 *   "3인 15분" 넣은 줄을 같은 세기 3인 런으로 다시 계산하면 15분이 나온다(왕복 일관성).
 *   전원이 같은 세기면 n인 런 = 혼자 시간 ÷ (n × 효율(n)).
 * ★ 묶음 값(`party_bundle_bosses.duration_minutes`)과 일정 잡기 창의 편집분은 **이미 그
 *   파티의 시간**이라 그대로 쓴다 — 나누지도, 다른 보스로 전파하지도 않는다(5절 돌먹).
 * ★ 참여자 목록은 서버 `createPartyRuns` 가 실제로 넣는 참가 기록과 **같은 사람 · 같은
 *   캐릭터**다(본인 = 요청의 캐릭터, 나머지 = 묶음 → 파티 → 본캐, 게스트 = 캐릭터 없음).
 *   화면 미리보기·봇 `!보스` 겹침 검사가 같은 함수에 같은 목록을 넣는다.
 * ★ 참여자가 0명(아무도 체크하지 않음)이면 미보정 1명으로 본다(= 전역 기본값).
 * ★ 2026-10-21 부터 **새로 잡는 일정**이 이 순서로 깔린다. 이미 잡힌 런의 길이는
 *   `party_runs.duration_minutes` 에 얼어 있어 이 함수와 무관하다.
 * ★ 사람이 넣은 값은 DB 에 `null` 아닌 값으로만 존재한다. **기본값을 행에 미리 박지
 *   않는다** — 박으면 배율표를 고쳐도 기본값이 따라오지 않고 "사람이 고친 값"과 구분할 수 없다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 5. "하나를 고치면 나머지도" — **캐릭터 맥락의 명시적 동작에만** 있다
 * ─────────────────────────────────────────────────────────────────────────────
 *     분(보스) = 20 × 110 / (그 줄 인원 × 효율 × k(기준 줄) × 본캐 배율(보스)) → 반올림 → 1~20
 *     (기준 줄의 k 는 그 줄의 인원과 효율로 읽는다 — 3절)
 * ★ 쓰는 곳은 `/boss-plans` 의 "나머지 보스도 이 기준으로 맞추기" 하나다(미리보기 → 확인
 *   후 저장, 그 캐릭터의 계획 값만 바꾼다). 기준 줄은 3절과 같은 이유로 10~19분이어야 한다.
 * ★ **파티·일정 맥락에서 사람이 고친 분은 전파하지 않는다**(발주 2026-10-21: *"대신 돌먹을
 *   하는 경우도 있으니 이걸 직접 수정 하는거는 다른 보스 시간에 영향을 주면 안되"*).
 *   돌먹(센 사람이 끌어 주는 파티)은 딜이 한 사람에게 쏠려 보스마다 다르게 줄어든다 — "그
 *   파티의 한 보스 시간"으로 다른 보스를 비례 추정할 근거가 없다. 그래서 묶음 편집·일정
 *   잡기 창에 있던 자동 추정 스위치(같은 날 첫 판, 기본 켜짐)를 **없앴다**(토글로도 안 남김).
 * ★ 첫 판의 `2분 ÷ 인원` 칸 간격은 근거가 사라져 지웠다.
 * ★ 순서는 뒤집히지 않는다(비율 > 0, 반올림·가두기 모두 비감소).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 `lib/domain/` 인가
 * ─────────────────────────────────────────────────────────────────────────────
 * `run-grouping.ts` 와 같은 근거 — 웹과 봇과 서버 런 생성이 같은 답을 내야 한다. 이 파일은
 * **환경 중립**이다(React·DOM·DB 의존 없음, 보스 마스터는 코드 상수다 §2.4).
 */

import { getBossEntry, getTrackedBossCatalog } from "@/lib/boss-master";
import {
  DEFAULT_RUN_MINUTES,
  RUN_DURATION_MAX,
  RUN_DURATION_MIN,
} from "@/lib/domain/run-grouping";

// ─────────────────────────────────────────────────────────────────────────────
// 1. 배율
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ★ **보스별 솔로 배율(%) — 발주자 본캐 실측**(2026-10-21 스크린샷, 아이콘 대조 판독).
 *   결정석 시세처럼 **패치·재측정 때 손으로 고치는 상수**다.
 *
 * 고치는 법: `bossDifficultyId: 배율` 한 줄을 더하거나 숫자 하나를 바꾼다. id 는
 * `src/lib/boss-master/generated.ts` 의 `GENERATED_BOSS_DIFFICULTIES[].id` 와 같은 글자여야
 * 한다(틀린 id 는 어느 보스에도 붙지 않는다). 배율은 **상대값**으로만 쓰인다 — 4절은 두
 * 보스의 비만 보고, 2절만 110% 기준점과 비교한다. 줄을 더하면 그 보스는 "시세로 끼움"에서
 * "표"로 바뀌고, 남은 보스들의 보간 이웃도 새 점에 맞춰 다시 정해진다.
 *
 * 표에 **없는** 것과 이유는 머리말 2절 "표에서 뺀 것"(파티 기준 값 · DESTINY · CHAMPION).
 */
export const BOSS_HP_RATIO_PERCENT: Readonly<Record<string, number>> = {
  kalos_extreme: 50.77,
  first_adversary_extreme: 37.7,
  baldrix_hard: 59.84,
  bellona_hard: 71.26,
  limbo_hard: 85.28,
  radiant_malefic_star_hard: 91.07,
  jupiter_normal: 87.02,
  first_adversary_hard: 124.1,
  baldrix_normal: 134.3,
  kaling_hard: 130.9,
  seren_extreme: 135.9,
  black_mage_extreme: 163.3,
  limbo_normal: 169.6,
  kalos_chaos: 210.1,
  bellona_normal: 243.0,
  kaling_normal: 394.0,
  radiant_malefic_star_normal: 422.5,
  lotus_extreme: 488.9,
  first_adversary_normal: 812.4,
  kalos_normal: 1023,
  bellona_easy: 1310,
  kaling_easy: 1528,
  seren_hard: 1764,
  first_adversary_easy: 2340,
  kalos_easy: 2981,
  black_mage_hard: 3470,
  seren_normal: 4074,
  lucid_hard: 4663,
  guardian_angel_slime_chaos: 6701,
  verus_hilla_hard: 6730,
  dunkel_hard: 7695,
  dusk_chaos: 8109,
  will_hard: 9633,
  verus_hilla_normal: 13461,
  damien_hard: 18517,
  lotus_hard: 24731,
  dusk_normal: 40545,
  will_normal: 48166,
  dunkel_normal: 48482,
  lucid_normal: 50485,
  will_easy: 72249,
};

/** 2절의 기준점 — ③ *"배율 110% 를 대충 20분 으로 치고"*. */
export const REFERENCE_RATIO_PERCENT = 110;
export const REFERENCE_MINUTES = RUN_DURATION_MAX;

/** 배율과 그 출처. `table` = 표(실측), `price` = 시세로 끼움(1절 (나)). */
export interface BossHpRatio {
  readonly ratioPercent: number;
  readonly source: "table" | "price";
}

/** 보간의 점 하나 — 시세를 아는 표 보스. */
interface RatioAnchor {
  readonly priceMeso: number;
  readonly ratioPercent: number;
}

/**
 * 보간 닻이 될 수 있는 보스인가 — **주간·시즌 주기만**(2026-10-21 교차 검증).
 * 월간(검은 마법사)은 한 달에 한 번이라 같은 난이도의 주간 보스보다 결정석이 몇 배 비싸다
 * (익검마 56.8억 vs 하대적 13.9억). 그 점이 닻에 섞이면 "시세 대비 배율"의 직선이 휘어,
 * 시세가 비싼 주간 보스가 지나치게 쉽게 끼워졌다(익스 카링 107.8% · 하유피 46.9%).
 * 월간 보스 **자신**은 표 값을 그대로 쓴다 — 닻에서만 빠진다.
 */
export function isRatioAnchorCandidate(bossDifficultyId: string): boolean {
  const cycle = getBossEntry(bossDifficultyId)?.cycle;
  return cycle === "weekly" || cycle === "season";
}

/**
 * 표 보스 중 시세를 아는 것으로 만든 보간 점. **시세 오름차순.**
 * 시세가 같은 표 보스가 여럿이면(보간 구간 폭이 0 이 된다) 배율을 **기하평균**으로 모아
 * 한 점으로 만든다 — 곱의 척도에서 가운데라 누구에게도 치우치지 않는다.
 * `isAnchor` 로 닻 후보를 거른다(기본: 주간·시즌만 — `isRatioAnchorCandidate`).
 */
export function bossRatioAnchors(
  priceOf: (bossDifficultyId: string) => number | null,
  table: Readonly<Record<string, number>> = BOSS_HP_RATIO_PERCENT,
  isAnchor: (bossDifficultyId: string) => boolean = isRatioAnchorCandidate,
): readonly RatioAnchor[] {
  const logsByPrice = new Map<number, number[]>();
  for (const [id, ratio] of Object.entries(table)) {
    if (!isAnchor(id)) continue;
    const price = priceOf(id);
    if (price === null || !(price > 0) || !(ratio > 0)) continue;
    logsByPrice.set(price, [...(logsByPrice.get(price) ?? []), Math.log(ratio)]);
  }
  return [...logsByPrice.entries()]
    .map(([priceMeso, logs]) => ({
      priceMeso,
      ratioPercent: Math.exp(
        logs.reduce((sum, value) => sum + value, 0) / logs.length,
      ),
    }))
    .sort((a, b) => a.priceMeso - b.priceMeso);
}

/** 표의 최소 배율(가장 어려운 보스). 표가 비면 기준점(110%). */
function minTableRatio(table: Readonly<Record<string, number>>): number {
  const ratios = Object.values(table).filter((ratio) => ratio > 0);
  return ratios.length === 0 ? REFERENCE_RATIO_PERCENT : Math.min(...ratios);
}

/**
 * ★ **배율 판정의 본체.** 시세 조회와 표를 주입받으므로 가짜 데이터로 검증할 수 있다.
 * 표에 없고 시세도 모르면 `null` — 지어내지 않는다.
 */
export function bossRatioFrom(
  bossDifficultyId: string,
  priceOf: (bossDifficultyId: string) => number | null,
  table: Readonly<Record<string, number>> = BOSS_HP_RATIO_PERCENT,
  anchors: readonly RatioAnchor[] = bossRatioAnchors(priceOf, table),
): BossHpRatio | null {
  if (Object.hasOwn(table, bossDifficultyId)) {
    const ratio = table[bossDifficultyId];
    if (ratio !== undefined && ratio > 0) {
      return { ratioPercent: ratio, source: "table" };
    }
  }
  const price = priceOf(bossDifficultyId);
  if (price === null || !(price > 0)) return null;
  const cheapest = anchors[0];
  const priciest = anchors[anchors.length - 1];
  if (cheapest === undefined || priciest === undefined) return null;

  // 가장 비싼 표 보스보다 비싸다 → 표의 최소 배율(→ 20분 벽).
  if (price > priciest.priceMeso) {
    return { ratioPercent: minTableRatio(table), source: "price" };
  }
  // 가장 싼 표 보스보다 싸다 → 반비례 외삽(시세 절반 = 배율 두 배).
  if (price < cheapest.priceMeso) {
    return {
      ratioPercent: cheapest.ratioPercent * (cheapest.priceMeso / price),
      source: "price",
    };
  }
  // 이웃 사이 → log(시세)–log(배율) 직선 보간.
  for (let index = 1; index < anchors.length; index += 1) {
    const below = anchors[index - 1];
    const above = anchors[index];
    if (below === undefined || above === undefined) continue;
    if (price > above.priceMeso) continue;
    const span = Math.log(above.priceMeso / below.priceMeso);
    const position = span > 0 ? Math.log(price / below.priceMeso) / span : 0;
    const logRatio =
      Math.log(below.ratioPercent) +
      (Math.log(above.ratioPercent) - Math.log(below.ratioPercent)) * position;
    return { ratioPercent: Math.exp(logRatio), source: "price" };
  }
  // 점이 하나뿐이고 시세가 정확히 같다.
  return { ratioPercent: priciest.ratioPercent, source: "price" };
}

/** 지금 유효한 시세(코드 상수)로 본 배율. 화면·서버가 부르는 입구. */
export function bossRatioOf(bossDifficultyId: string): BossHpRatio | null {
  return bossRatioFrom(
    bossDifficultyId,
    currentPriceOf,
    BOSS_HP_RATIO_PERCENT,
    currentAnchors(),
  );
}

function currentPriceOf(bossDifficultyId: string): number | null {
  return getBossEntry(bossDifficultyId)?.crystalPriceMeso ?? null;
}

/** 보간 점은 카탈로그 스냅샷(참조 안정)마다 한 번만 만든다. 시세 패치 시각을 넘으면 새로 만든다. */
const ANCHORS_BY_CATALOG = new WeakMap<object, readonly RatioAnchor[]>();

function currentAnchors(): readonly RatioAnchor[] {
  const catalog = getTrackedBossCatalog();
  const cached = ANCHORS_BY_CATALOG.get(catalog);
  if (cached !== undefined) return cached;
  const anchors = bossRatioAnchors(currentPriceOf);
  ANCHORS_BY_CATALOG.set(catalog, anchors);
  return anchors;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. 전역 기본값
// ─────────────────────────────────────────────────────────────────────────────

function clampMinutes(minutes: number): number {
  return Math.min(
    RUN_DURATION_MAX,
    Math.max(RUN_DURATION_MIN, Math.round(minutes)),
  );
}

/**
 * 배율 → **가두지 않은** 기준 분(`20 × 110 / 배율`). 1~20 밖일 수 있다.
 * 총 시간 분배의 무게로 쓰인다(`relativeDurationWeight`) — 가둔 값을 무게로 쓰면 20 벽에
 * 붙은 상위 보스들의 차이가 뭉개진다.
 */
export function unclampedMinutesForRatio(ratioPercent: number): number {
  return (REFERENCE_MINUTES * REFERENCE_RATIO_PERCENT) / ratioPercent;
}

/** 배율 → 기본 분. 2절의 식. 반올림 후 1~20 으로 가둔다. */
export function defaultMinutesForRatio(ratioPercent: number): number {
  return clampMinutes(unclampedMinutesForRatio(ratioPercent));
}

/** 보스의 전역 기본 분. 배율이 없으면(표에 없고 시세 null) `null`. */
export function defaultBossMinutes(bossDifficultyId: string): number | null {
  const ratio = bossRatioOf(bossDifficultyId);
  return ratio === null ? null : defaultMinutesForRatio(ratio.ratioPercent);
}

/**
 * ★ **총 시간 분배의 무게** — `1 / 배율` 에 비례하는 값(분 단위로 맞춰 둔 것), **가두지 않음**.
 *   배율이 없는 보스는 `null` — 부르는 쪽이 `DEFAULT_RUN_MINUTES` 로 접는다(그 보스에
 *   `resolveBossDuration` 이 실제로 쓰는 값과 같은 자).
 */
export function relativeDurationWeight(bossDifficultyId: string): number | null {
  const ratio = bossRatioOf(bossDifficultyId);
  return ratio === null ? null : unclampedMinutesForRatio(ratio.ratioPercent);
}


// ─────────────────────────────────────────────────────────────────────────────
// 3. 캐릭터 세기 k
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 계획 한 줄에 사람이 넣은 소요 시간 — **그 줄의 인원으로 친 시간**(머리말 3절 "줄의 인원").
 * `minutes` ← `character_boss_plans.duration_minutes`, `partySize` ←
 * `character_boss_plans.default_party_size`(결정석 1/n 에 쓰는 그 값, NOT NULL DEFAULT 1).
 */
export interface CharacterBossDuration {
  readonly minutes: number;
  readonly partySize: number;
}

/**
 * 캐릭터 하나가 **사람이 고쳐 둔** 보스별 분(각 줄의 인원 포함). 키 = `bossDifficultyId`.
 * 값이 없는 보스는 키가 없다(= 추정을 따름). 서버(`loadCharacterBossMinutes`)와
 * 화면(`RunCharacterOption.bossMinutes`)이 같은 모양을 쓴다.
 * ★ k 를 읽으려면 **그 캐릭터의 모든 줄**이 필요하다 — 런의 보스만 골라 싣지 않는다.
 */
export type CharacterBossMinutes = Readonly<Record<string, CharacterBossDuration>>;

/** 인원 값을 1 이상의 정수로 접는다. 없거나 비정상이면 1(혼자). */
export function normalizePartySize(partySize: number | null | undefined): number {
  if (partySize === null || partySize === undefined) return 1;
  if (!Number.isFinite(partySize)) return 1;
  const size = Math.trunc(partySize);
  return size >= 1 ? size : 1;
}

/**
 * ★ **파티 효율** — n인 파티 배율 = n × 혼자 배율 × 이 값(머리말 4절 "파티 손실").
 *   발주(2026-10-21): *"파티인경우 배율에서 너프가 좀 들어간다고 생각하고"* → *"그냥
 *   계산에다가만 넣고 조정하지마. 너무 티나게 많이 넣지말고 조금만 ㄱㄱ"*. 동선 · 무적 ·
 *   딜 타이밍 겹침으로 생기는 손실의 **어림값**이고, 패치·체감에 따라 **발주자가 고치는
 *   상수**다. 화면에 노출하지 않는다(내부 식). 4인 이상은 마지막 값.
 */
export const PARTY_EFFICIENCY: Readonly<Record<number, number>> = {
  1: 1,
  2: 0.95,
  3: 0.93,
  4: 0.9,
};

/** 그 인원의 파티 효율. 표에 없는 큰 인원·비정상 값은 표의 마지막 값(4인). */
export function partyEfficiency(partySize: number | null | undefined): number {
  const size = normalizePartySize(partySize);
  const keys = Object.keys(PARTY_EFFICIENCY)
    .map(Number)
    .sort((a, b) => a - b);
  const last = keys[keys.length - 1] ?? 1;
  return PARTY_EFFICIENCY[Math.min(size, last)] ?? 1;
}

/** n인 파티가 혼자 배율의 몇 배를 내는가 — `n × 파티 효율(n)`. */
export function partyRatioFactor(partySize: number | null | undefined): number {
  const size = normalizePartySize(partySize);
  return size * partyEfficiency(size);
}

/**
 * 보정에 쓰는 분의 하한 — 원문 *"솔플로 하는거 10분이상을 입력하면"*(2026-10-21).
 * 그보다 짧으면 고정 시간(페이즈·무적)에 묻혀 배율을 읽을 수 없다(머리말 3절).
 */
export const CALIBRATION_MIN_MINUTES = 10;

/**
 * 이 분(넣은 값 그대로)으로 캐릭터 세기를 읽을 수 있는가. **10 이상 · 20(상한) 미만** — 20 은
 * "20분 이상"일 수 있어 뺀다(머리말 3절의 가정).
 */
export function isCalibrationMinutes(minutes: number): boolean {
  return (
    Number.isFinite(minutes) &&
    minutes >= CALIBRATION_MIN_MINUTES &&
    minutes < RUN_DURATION_MAX
  );
}

/**
 * 가둬진 값인가 — 한 판 경계(1 · 20)에 붙은 값은 "그 이하 / 그 이상"일 수 있어 정확한
 * 배율이 아니다(머리말 3절 경계값 규칙).
 */
export function isClampedMinutes(minutes: number): boolean {
  return minutes <= RUN_DURATION_MIN || minutes >= RUN_DURATION_MAX;
}

/** 본캐 배율 조회의 기본 — 지금 유효한 표·시세. 검증용으로 갈아 끼울 수 있다. */
function currentMainRatio(bossDifficultyId: string): number | null {
  return bossRatioOf(bossDifficultyId)?.ratioPercent ?? null;
}

/** 혼자 걸리는 분 ↔ 배율(%). `20 × 110 / x` 는 자기 자신의 역함수다. */
function ratioFromMinutes(minutes: number): number {
  return (REFERENCE_MINUTES * REFERENCE_RATIO_PERCENT) / minutes;
}

function geometricMean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return Math.exp(
    values.reduce((sum, value) => sum + Math.log(value), 0) / values.length,
  );
}

/**
 * 그 줄에서 읽은 **이 캐릭터 혼자의 배율**(%) — `20 × 110 / (분 × n × 효율(n))`.
 * 줄의 인원이 거의 같은 배율이라고 보면(*"거의 동일 배율"*) n인 파티 배율 =
 * n × 효율(n) × 혼자 배율이다(4절 파티 효율과 같은 계수 — 왕복 일관성).
 */
function characterRatioOf(entry: CharacterBossDuration): number {
  return ratioFromMinutes(entry.minutes * partyRatioFactor(entry.partySize));
}

/**
 * ★ **캐릭터 세기 k**(본캐 = 1) — 머리말 3절. 보정할 줄(10~19분)들의 k 의 기하평균 하나.
 *   보정할 줄이 없으면 `null`(미보정).
 */
export function characterStrength(
  bossMinutes: CharacterBossMinutes | null | undefined,
  mainRatioOf: (bossDifficultyId: string) => number | null = currentMainRatio,
): number | null {
  if (bossMinutes === null || bossMinutes === undefined) return null;
  const ks: number[] = [];
  for (const [id, entry] of Object.entries(bossMinutes)) {
    // 보정 조건(10~19분)은 **넣은 분 그대로**에 건다 — 고정 시간·상한은 그 판의 시계 문제다.
    if (!isCalibrationMinutes(entry.minutes)) continue;
    const main = mainRatioOf(id);
    if (main === null || !(main > 0)) continue;
    ks.push(characterRatioOf(entry) / main);
  }
  return geometricMean(ks);
}

/** 사람이 넣은 한 칸(분 + 그 줄의 인원). 없으면 `null`. */
export function characterMinutesOf(
  minutes: CharacterBossMinutes | null | undefined,
  bossDifficultyId: string,
): CharacterBossDuration | null {
  if (minutes === null || minutes === undefined) return null;
  return Object.hasOwn(minutes, bossDifficultyId)
    ? (minutes[bossDifficultyId] ?? null)
    : null;
}

/**
 * ★ **캐릭터 맥락의 한 줄 분** — `/boss-plans` 표시 · 총/남은 시간 · `!숙제` 카드 ·
 *   그 줄의 인원 n 으로 친 시간이다(머리말 3절):
 *     사람이 넣은 값이 있으면 그 값 그대로,
 *     없으면 20 × 110 / (n × 효율(n) × k × 본캐 배율)   — k 모르면 1(본캐 기준),
 *     배율도 모르면 `fallbackMinutes`(기본 20, §1.3 D4).
 */
export function characterRowMinutes(
  bossDifficultyId: string,
  bossMinutes: CharacterBossMinutes | null,
  rowPartySize: number | null | undefined,
  options: {
    readonly fallbackMinutes?: number;
    readonly mainRatioOf?: (bossDifficultyId: string) => number | null;
  } = {},
): number {
  const explicit = characterMinutesOf(bossMinutes, bossDifficultyId);
  if (explicit !== null && Number.isFinite(explicit.minutes) && explicit.minutes > 0) {
    return clampMinutes(explicit.minutes);
  }
  const mainRatioOf = options.mainRatioOf ?? currentMainRatio;
  const main = mainRatioOf(bossDifficultyId);
  if (main === null || !(main > 0)) {
    return options.fallbackMinutes ?? DEFAULT_RUN_MINUTES;
  }
  const k = characterStrength(bossMinutes, mainRatioOf) ?? 1;
  return clampMinutes(ratioFromMinutes(partyRatioFactor(rowPartySize) * k * main));
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. 파티 런의 분 · 우선순위
// ─────────────────────────────────────────────────────────────────────────────

export type BossDurationSource = "bundle" | "estimate" | "fallback";

export interface ResolvedBossDuration {
  readonly minutes: number;
  /**
   * 어느 층에서 왔는가.
   * - `bundle`: 묶음(또는 그 창)에 사람이 넣은 값 — 그대로.
   * - `estimate`: 참여자 배율 합산 추정(머리말 4절).
   * - `fallback`: 배율도 사람 값도 없어 마지막 방어선.
   */
  readonly source: BossDurationSource;
  /** `estimate` 일 때만 — 화면이 근거("3인 기준 예상 시간(시간을 넣어 두지 않은 사람 1명)")를 적는 재료. */
  readonly estimate: {
    readonly participantCount: number;
    /** k 도 그 보스의 사람 값도 없어 남의 k(또는 본캐 기준)를 빌린 참여자 수. */
    readonly uncalibratedCount: number;
    /** 그 보스에 사람이 넣은 값(그 줄의 인원으로 환산)을 그대로 쓴 참여자 수. */
    readonly explicitCount: number;
  } | null;
}

/**
 * ★ **우선순위의 유일한 정의** (머리말 4절).
 *     묶음 값 > 참여자 배율 합산 추정 > 마지막 방어선(`fallbackMinutes`, 기본 20)
 *     합산 추정 = 20 × 110 / (Σ 참여자 배율_i(b) × 효율(참여 인원))
 *
 * ★ **부르는 곳이 넷이고, 같은 입력을 넣어야 한다**:
 *   - 서버 `schedule-repo.createPartyRuns` — 실제로 깔리는 분.
 *   - 화면 `timetable-run-dialog`(미리보기) · `bundle-editor-dialog`(칸 placeholder) ·
 *     `plan-run-dialog`(미리보기).
 *   - 봇 `!보스` 의 겹침 검사(답장 시각은 저장 결과를 그대로 읽는다).
 *   `bundleMinutes` = "그 창에서 방금 고친 값 ?? 묶음에 저장된 값".
 *   `participants` = 그 런에 **가는** 사람마다 데려가는 캐릭터의 분 지도(분 + 줄의 인원, `null` =
 *   캐릭터 없음 · 게스트). 어느 캐릭터인지는 `createPartyRuns` 의 참가 기록 규칙이 정한다.
 * ★ `fallbackMinutes` — 배율이 없는 보스(§1.3 D4 — 지어내지 않는다)에서만 쓰인다. 단, 그
 *   보스에 모든 참여자가 값을 넣었으면 배율 없이도 합산할 수 있어 추정이 이긴다.
 */
export function resolveBossDuration(input: {
  readonly bossDifficultyId: string;
  readonly bundleMinutes: number | null;
  readonly participants: readonly (CharacterBossMinutes | null)[];
  readonly fallbackMinutes?: number;
  /** 검증용 주입. 생략하면 지금 유효한 표·시세. */
  readonly mainRatioOf?: (bossDifficultyId: string) => number | null;
}): ResolvedBossDuration {
  /*
    ★ 묶음 값의 방어선(2026-10-21 교차 검증): 비유한 값(NaN · ±∞)은 "정하지 않음"으로 보고,
      유한 값은 1~20 으로 가둔다. DB CHECK 와 라우트 검증이 이미 막지만, 이 함수는 화면 편집분도
      받으므로 깨진 값이 시각 계산(분 × 60_000)까지 흘러가지 않게 여기서 한 번 더 접는다.
  */
  const bundleMinutes =
    input.bundleMinutes !== null && Number.isFinite(input.bundleMinutes)
      ? clampMinutes(input.bundleMinutes)
      : null;
  if (bundleMinutes !== null) {
    return { minutes: bundleMinutes, source: "bundle", estimate: null };
  }
  const mainRatioOf = input.mainRatioOf ?? currentMainRatio;
  const fallback: ResolvedBossDuration = {
    minutes: input.fallbackMinutes ?? DEFAULT_RUN_MINUTES,
    source: "fallback",
    estimate: null,
  };
  // 아무도 안 가면 미보정 1명(= 전역 기본값)으로 본다.
  const participants: readonly (CharacterBossMinutes | null)[] =
    input.participants.length === 0 ? [null] : input.participants;

  const strengths = participants.map((minutes) =>
    characterStrength(minutes, mainRatioOf),
  );
  // 미보정 참여자가 빌릴 k — 같은 런 보정 참여자들의 k 기하평균("거의 동일 배율").
  const borrowed =
    geometricMean(strengths.filter((k): k is number => k !== null)) ?? 1;
  const main = mainRatioOf(input.bossDifficultyId);

  let ratioSum = 0;
  let uncalibratedCount = 0;
  let explicitCount = 0;
  const alone = participants.length === 1;
  for (const [index, minutes] of participants.entries()) {
    const explicit = characterMinutesOf(minutes, input.bossDifficultyId);
    /*
      ★ 사람이 넣은 줄은 **그 줄의 인원 n_i 로 친 시간**이라 그 사람 혼자 배율 =
        20×110/(분 × n_i × 효율(n_i)) (머리말 3절 "줄의 인원").
      ★ 경계값 규칙(머리말 3절): 1 · 20 은 "그 이하 / 그 이상"일 수 있어 합산에 정확한 배율로
        쓰지 않는다. 예외 둘 — 혼자 가는 런이면서 그 줄도 1인(결과도 같은 경계로 가둬진다) ·
        본캐 배율이 없는 보스(다른 근거가 없다).
    */
    const usableExplicit =
      explicit !== null &&
      explicit.minutes > 0 &&
      Number.isFinite(explicit.minutes) &&
      ((alone && normalizePartySize(explicit.partySize) === 1) ||
        !isClampedMinutes(explicit.minutes) ||
        main === null ||
        !(main > 0));
    if (usableExplicit) {
      ratioSum += characterRatioOf(explicit);
      explicitCount += 1;
      continue;
    }
    if (main === null || !(main > 0)) return fallback;
    const own = strengths[index] ?? null;
    if (own === null) uncalibratedCount += 1;
    ratioSum += (own ?? borrowed) * main;
  }
  if (!(ratioSum > 0)) return fallback;
  return {
    minutes: clampMinutes(
      ratioFromMinutes(ratioSum * partyEfficiency(participants.length)),
    ),
    source: "estimate",
    estimate: {
      participantCount: participants.length,
      uncalibratedCount,
      explicitCount,
    },
  };
}

/**
 * 근거를 한 토막으로 — **시간 말로만**: `3인 기준 예상 시간(시간을 넣어 두지 않은 사람 1명)`,
 * `혼자 기준 예상 시간`. 사람이 넣은 값·마지막 방어선이면 `null`. 화면이 placeholder 옆에
 * 적는다(머리말 4절).
 * ★ 배율·k·"보정"·"합산" 같은 내부 식 용어를 화면에 내보내지 않는다(발주 2026-10-21:
 *   *"그 배율얘기 하지말고 … 그냥 시간으로 계산해 … 내부 식이야."*). "시간을 넣어 두지
 *   않은 사람" = 보정할 줄(10~19분)이 하나도 없는 참여자(게스트 포함)다.
 */
export function describeResolvedDuration(
  resolved: ResolvedBossDuration,
): string | null {
  const estimate = resolved.estimate;
  if (resolved.source !== "estimate" || estimate === null) return null;
  const head =
    estimate.participantCount <= 1
      ? "혼자 기준 예상 시간"
      : `${String(estimate.participantCount)}인 기준 예상 시간`;
  return estimate.uncalibratedCount > 0 && estimate.participantCount > 1
    ? `${head}(시간을 넣어 두지 않은 사람 ${String(estimate.uncalibratedCount)}명)`
    : head;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. "하나를 고치면 나머지도" — 캐릭터 맥락의 명시적 동작 전용
// ─────────────────────────────────────────────────────────────────────────────

export type DurationEstimateResult =
  | {
      readonly kind: "applied";
      /** **기준 보스를 뺀** 나머지 중 배율이 있는 보스의 새 분(반올림·1~20). */
      readonly minutes: ReadonlyMap<string, number>;
      /** 배율이 없어(표에 없고 시세 미확인) **건드리지 않은** 나머지 보스. */
      readonly unknownIds: readonly string[];
    }
  | {
      readonly kind: "skipped";
      /**
       * - `unset`: 기준으로 쓸 값이 없다.
       * - `not-calibratable`: 10~19분이 아니다(머리말 3절 — 짧으면 고정 시간에 묻히고,
       *   20 은 상한이라 "20분 이상"일 수 있다).
       * - `unknown-ratio`: 기준 보스의 배율이 없다. 나머지를 움직일 근거가 없다.
       */
      readonly reason: "unset" | "not-calibratable" | "unknown-ratio";
    };

/**
 * ★ `/boss-plans` 가 부르는 입구 — 캐릭터의 한 줄(분 + 그 줄의 인원)로 그 캐릭터의
 *   나머지 보스를 맞춘다(머리말 5절). 파티·일정 맥락에서는 부르지 않는다(돌먹).
 *     k = 20×110 / (기준 분 × 기준 줄 인원 × 효율(기준 줄 인원) × 본캐 배율(기준))
 *     새 분(보스) = 20×110 / (그 줄 인원 × 효율(그 줄 인원) × k × 본캐 배율(보스)) → 반올림 → 1~20
 */
export function estimateCharacterDurations(
  targets: readonly { readonly bossDifficultyId: string; readonly partySize: number }[],
  anchor: {
    readonly bossDifficultyId: string;
    readonly minutes: number | null;
    readonly partySize: number;
  },
  mainRatioOf: (bossDifficultyId: string) => number | null = currentMainRatio,
): DurationEstimateResult {
  if (anchor.minutes === null) return { kind: "skipped", reason: "unset" };
  if (!isCalibrationMinutes(anchor.minutes)) {
    return { kind: "skipped", reason: "not-calibratable" };
  }
  const anchorMain = mainRatioOf(anchor.bossDifficultyId);
  if (anchorMain === null || !(anchorMain > 0)) {
    return { kind: "skipped", reason: "unknown-ratio" };
  }
  const strength =
    characterRatioOf({ minutes: anchor.minutes, partySize: anchor.partySize }) /
    anchorMain;
  const minutes = new Map<string, number>();
  const unknownIds: string[] = [];
  for (const target of targets) {
    if (target.bossDifficultyId === anchor.bossDifficultyId) continue;
    const main = mainRatioOf(target.bossDifficultyId);
    if (main === null || !(main > 0)) {
      unknownIds.push(target.bossDifficultyId); // 배율을 몰라 근거가 없다 — 그대로 둔다.
      continue;
    }
    minutes.set(
      target.bossDifficultyId,
      clampMinutes(
        ratioFromMinutes(partyRatioFactor(target.partySize) * strength * main),
      ),
    );
  }
  return { kind: "applied", minutes, unknownIds };
}
