import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `!ㄼ` · `!ㄹㅂ` — 레벨 히스토리: 최근 10번의 레벨업 날짜 (2026-11-18)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * `!ㄼ` 는 **보낸 사람의 본캐**, `!ㄼ <닉네임>` 은 아무 캐릭터(미연결자도 된다)를 본다. `!ㄹㅂ` 도 같다
 * (자판에서 ㄹ·ㅂ 을 이어 치면 `ㄼ` 한 글자로 합쳐지기도, 두 글자로 남기도 한다). 무엇을 찌를지와 답장
 * 모양은 `lib/domain/level-history.ts` 가 갖고, 이 파일은 **언제 · 몇 번 · 어느 키로** 부를지만 정한다.
 * 대상 해석 · 키 사다리 · 최신 1콜(캐시 우회 + 5분 쿨다운) · 낡은 ocid 재확인 · 실패 답장은 `!%` 와 같은
 * 코드다(`./character-lookup.ts`). **최신 쿨다운 기억도 함께 쓴다** — `!%` 직후 5분 안의 `!ㄼ` 는 최신을
 * 다시 받지 않는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 호출 — 넥슨에 레벨업 기록은 없다. 날짜 표본을 찔러 찾는다
 * ─────────────────────────────────────────────────────────────────────────────
 *   · 최신 1콜(+ 닉네임이면 `/id` 1콜)로 현재 레벨 L 을 받고, `character_exp_daily` 의 그 ocid 행 전부와
 *     `character_exp_empty_days`(데이터 없음으로 확인된 날)를 하한일 ~ 어제에서 읽어 표본으로 쓴다.
 *     모자란 날만 `date` 로 찌른다. 지난날은 값이 안 바뀌므로 15분 캐시를 쓴다.
 *   · 탐침은 **한 번에 `LEVEL_PROBE_CONCURRENCY`(2)개까지만** 키 줄에 서거나 날아가고, 응답이 하나 올
 *     때마다 다시 계획해 다음 날을 고른다(지휘 결정 2026-11-18, D2 · 2라운드). 예전처럼 웨이브를 통째로 줄에
 *     세우면 같은 키를 쓰는 다른 명령(`!%` · `!숙제` 갱신)이 그 뒤에 서서, 탐색 세 개가 겹친 날 `!%` 가
 *     13.4초(라우트의 10초 오류 답장)까지 밀렸다(교차 검증 실측). 지금은 같은 조건에서 4.4초다.
 *   · 받은 날은 몇 건씩 모아(`SAVE_BATCH_SIZE`) 값 있는 날은 `saveExpDays`(오늘 이후 · KST 3시 전의 어제는
 *     거르는 규칙 그대로 — 걸러진 날은 이번 탐색의 메모리에서만 쓴다), 데이터 없는 날은 `saveEmptyDays`
 *     (어제보다 이른 날만)로 저장한다. **다음 `!ㄼ` 는 두 표에서 이어 찾는다** — 인스턴스가 바뀌어도 같은
 *     날을 다시 찌르지 않는다(D3). 인스턴스 메모리(`emptyDays`)는 표를 못 읽을 때의 보조다. 빈 날 기록은
 *     `EMPTY_DAY_TRUST_DAYS`(30일)보다 오래되면 믿지 않고 다시 찌른다(R2-6 b) — 일시적인 빈 응답이 영구히
 *     굳는 것과, 한 달에 한 번 몇 콜 더 드는 것을 바꾼 값이다.
 *   · "넥슨에 지난 기록이 아직 없어요"는 넥슨이 날짜를 **생성 전**(`invalid_parameter`)으로 거절한 날이 있고
 *     그 뒤 어제까지가 모두 빈 날로 확인됐을 때만 말한다(R2-6 a). 빈 200 묶음만으로는 말하지 않는다.
 *   · 탐침 수(가짜 "날짜 → 레벨 · 경험치" 함수 위에서 이 루프를 그대로 흉내 낸 시뮬레이션, 2026-11-18 ·
 *     저장소 밖 스크래치, 경험치 곡선 8종 × 시드 400, 최신 · `/id` 별도, 중앙값 · 최댓값): 꾸준히 크는
 *     캐릭터 28~32 · 36~43, 이벤트 몰아치기 40 · 53, 월별 활동 기복 51 · 81, 휴가(몇 주 정지) 46 · 78,
 *     기복 + 휴가 + 이벤트 55 · 93. 58 을 넘는 비율은 기복 20% · 휴가 7% · 전부 36%(1라운드 37.5% · 22.8% ·
 *     58%). 하루에 몇 레벨씩 오르는 캐릭터는 한 자리, 기록 안에서 레벨업이 없으면 2~17(데이터 시작일 탐색).
 *     **콜 상한(`LEVEL_CALL_BUDGET` 60)은 늘리지 않는다**(남의 키 비용) — 활동이 불규칙한 캐릭터는 첫 `!ㄼ`
 *     가 상한에서 멈추고 두 번째 `!ㄼ` 가 저장된 표본에서 마저 찾는다. 다 찾은 뒤 다시 치면 0(같은 날)
 *     또는 1(그사이 한 번 레벨업).
 *   · 넥슨 왕복 350ms 가정에서 첫 조회의 탐색 종료는 꾸준한 캐릭터 중앙값 10.2초 · p90 11.7초(1라운드
 *     12.4 · 13.7초), 6.5초 답장에 확정 줄 중앙값 5~6줄. 왕복이 500ms(= 2칸 × 250ms)를 넘으면 동시 2가
 *     속도를 묶는다 — 800ms 에서 1라운드보다 중앙값 2~5초 늦다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 시간 — 6.5초까지 탐색을 기다려 답하고, 못 끝낸 탐색은 응답 뒤에 이어 간다
 * ─────────────────────────────────────────────────────────────────────────────
 *   · 탐색은 요청 시작 후 `LEVEL_REPLY_DEADLINE_MS`(`!숙제` 와 같은 6.5초)까지만 기다린다. 그 안에 끝나면
 *     그 즉시 답하고, 못 끝냈으면 **최근 쪽으로 연속해서 확정된 줄만** 보이고 "찾는 중"이라고 말한다.
 *   · ⚠️ **답장 자체가 6.5초 안이라는 보장은 아니다.** 그 앞의 `/id` · 최신 1콜에는 시한이 없다(`!%` 와
 *     같은 성질) — 넥슨이 느리면 그만큼 늦고, 6.5초를 이미 넘겼으면 탐색을 기다리지 않고 바로 답한다.
 *     서버 안에서 멈추면 라우트가 10초에 오류 답장을 낸다(`api/bot/command/route.ts`).
 *   · 남은 탐색은 `after()` 로 요청 시작 후 `LEVEL_CONTINUE_LIMIT_MS`(45초)까지 이어 간다. 라우트의
 *     `maxDuration` 60초 안쪽이다 — 45초에 이미 나간 호출은 넥슨 응답 상한(10초) 안에 끝난다.
 *   · 같은 인스턴스에서 같은 ocid 탐색이 돌고 있으면 **두 번째를 시작하지 않는다**(`runningSearches`).
 *     뒤에 온 명령은 그 탐색을 자기 상한까지 기다렸다가 그때까지 아는 것으로 답한다.
 *   · 탐색이 **이미 멈췄는데** 못 찾은 레벨이 남았으면 "찾는 중"이라고 하지 않는다(D4): 넥슨 오류로
 *     멈췄으면 줄이 없을 때 `!%` 와 같은 넥슨 실패 답장, 줄이 있으면 목록 + "넥슨 조회가 멈춰 여기까지예요",
 *     콜 · 시간 상한으로 멈췄으면 "다시 치면 이전 레벨을 이어서 찾아요". 단 상한이 60콜이 아니라 **키의 남은
 *     몫으로 줄어든 상한**이었으면 "지금은 넥슨 조회량이 많아 여기까지예요"다(R2-2) — 키 장부가 찼으면 다시
 *     쳐도 몫이 늘지 않아 "이어서 찾아요"가 거짓이 된다. "오늘은"이 아니라 "지금은"인 이유(R3-1): 줄어든 까닭이
 *     같은 키의 **다른 `!ㄼ` 예약**일 수도 있고, 그때는 그 조회가 끝나면 다시 쳐서 이어 갈 수 있다.
 *   · 주간·월간 초기화 직후 20분 규칙(`lib/time/reset-window.ts`)은 적용하지 않는다(`!%` 와 같다 —
 *     레벨은 아무것도 기록하지 않고 보여 주기만 한다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 키 — `!%` 의 사다리 + **콜 상한만큼 남은 키** + 인스턴스 안 예약
 * ─────────────────────────────────────────────────────────────────────────────
 * 본캐 키 → 보낸 사람의 서버 보관 키 → 풀(`./character-lookup.ts` `pickKey`). 이 명령은 첫 조회에 수십
 * 콜이 들고 그 비용이 남의 키에 청구될 수 있으므로, 남은 몫(80% 선 − 장부 − **이 인스턴스의 다른 `!ㄼ`
 * 예약**)이 `LEVEL_MIN_CALLS` 이상인 첫 키를 `min(60, 남은 몫)` 으로 쓴다. 고른 몫은 그 자리에서 예약하고,
 * 콜의 응답이 끝날 때마다(= 장부에 적힐 때마다) 줄이고, 명령이 끝나면 남은 몫을 푼다(D1). 그래서 같은
 * 인스턴스에서 겹친 `!ㄼ` 들이 같은 장부 값을 보고 각자 60콜을 쓰지 않는다. ⚠️ 다른 인스턴스와는 못 나눈다.
 *   · 몫이 `LEVEL_MIN_CALLS` 보다 작아도 **고정 콜(`LEVEL_FIXED_CALLS` 4 = `/id` · 최신 · 낡은 ocid 재확인
 *     `/id` · 최신)** 이상 남은 키는 그 몫만큼 쓴다(교차 검증 R2-3). 고정 콜도 몫에서 빠지므로, 몫이 그보다
 *     작은 키로는 아예 시작하지 않는다 — 시작했다가 최신 조회에서 80% 선을 넘기지 않게.
 *   · 장부만 보면 몫이 있는데 **다른 `!ㄼ` 의 예약** 때문에 모자란 것이면 "할당량" 답장이 아니라
 *     `BUSY_REPLY`("다른 레벨 조회가 진행 중이에요")로 답한다(R2-1). 잠깐 뒤에 다시 치면 풀린다.
 *   · 같은 ocid 탐색에 붙은 명령은 자기 몫을 쓰지 않으므로 **붙는 즉시 예약을 푼다**(R2-1).
 * ⚠️ `!%` 와 같은 위험을 더 크게 진다: 방 안 누구나 `!ㄼ 남의닉` 한 번으로 남의 키 쿼터를 최대 60콜
 *    쓴다. 80% 선이 크론 몫은 지키지만 그 키의 `!%` · `!ㄼ` 는 그날 먼저 막힐 수 있다. 같은 인스턴스에서
 *    같은 키 줄을 쓰는 다른 봇 명령은 탐색 하나당 최대 2칸(`LEVEL_PROBE_CONCURRENCY` × 250ms)만 기다린다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 실패
 * ─────────────────────────────────────────────────────────────────────────────
 *   · 최신 조회 실패 · 찾을 수 없음 · 낡은 ocid 는 `!%` 와 같은 답장이다.
 *   · 찌른 날이 `ROW_SKIP_KINDS`(범위 밖 · 생성 전 · 전날 미준비 · 무효 ocid)면 그날은 "데이터 없음"이다.
 *   · 그 밖의 실패(할당량 · 서버 오류 · 네트워크)는 **탐색을 멈추고** 아는 만큼으로 답한다(위 D4). 다음
 *     `!ㄼ` 가 저장된 표본에서 이어 간다.
 */

import { after } from "next/server";

import type { NexonProxyContext } from "@/features/auth/server/nexon-proxy";
import {
  loadEmptyDays,
  loadLevelDays,
  saveEmptyDays,
  saveExpDays,
  type EmptyDayToSave,
  type ExpDayToSave,
  type StoredEmptyDay,
  type StoredEmptyReason,
  type StoredLevelDay,
} from "@/features/characters/server/exp-daily-store";
import {
  LEVEL_HISTORY_EMPTY_TEXT,
  LEVEL_HISTORY_FLOOR_DAY,
  formatLevelHistory,
  planLevelSearch,
  type LevelGuardState,
  type LevelPendingNote,
  type LevelSample,
  type LevelSearchPlan,
} from "@/lib/domain/level-history";
import { fetchCharacterBasicWithExp, type NexonRequestOptions } from "@/lib/nexon/client";
import { isNexonApiError, type NexonErrorKind } from "@/lib/nexon/errors";
import type { NexonCharacterBasicWithExp } from "@/lib/nexon/types";
import type { AdminDb } from "@/lib/supabase/admin-db";
import { kstDayKey } from "@/lib/time/kst-wallclock";

import { shiftDayKey, type ParsedCommand } from "../lib/command-parse";
import { lines } from "../lib/plaintext";
import type { BotAccount } from "./bot-repo";
import {
  NOT_FOUND_KINDS,
  ROW_SKIP_KINDS,
  createLatestGateway,
  describeFailure,
  fetchLatestWithCooldown,
  isOutcome,
  keyMissReply,
  nexonFailure,
  notFoundOutcome,
  pickKey,
  recheckOcid,
  releaseReservation,
  resolveLookupTarget,
  resolveOcid,
  settleReservedCall,
  stopOnFailure,
  type CallReservation,
  type LookupCommand,
} from "./character-lookup";
import type { CommandContext, CommandOutcome } from "./commands";
import { REFRESH_REPLY_DEADLINE_MS, pacedGateway } from "./refresh-on-command";

const TAG = "레벨";

/**
 * 탐색을 기다리는 상한 — 요청 시작 후 6.5초. **`!숙제` 와 같은 값을 그대로 쓴다**(`REFRESH_REPLY_DEADLINE_MS`
 * 의 근거: 라우트의 10초 오류 답장 · 런너의 12초 포기 사이 여유). 고정 대기가 아니라 상한이고, 그 앞의
 * `/id` · 최신 1콜은 이 상한 밖이다(머리말).
 */
export const LEVEL_REPLY_DEADLINE_MS = REFRESH_REPLY_DEADLINE_MS;

/**
 * 답장 뒤 탐색을 이어 가는 상한 — 요청 시작 후 45초. 라우트 `maxDuration`(60초)에서 마지막 호출의
 * 넥슨 응답 상한(`NEXON_REQUEST_TIMEOUT_MS` 10초)과 저장 왕복 몫을 뺐다. 이 뒤로는 새 호출을 보내지
 * 않는다(줄에서 기다리던 호출도 자리를 쓰지 않고 빠진다).
 */
export const LEVEL_CONTINUE_LIMIT_MS = 45_000;

/**
 * 한 번의 명령이 쓰는 넥슨 콜 상한 — `/id` · 최신 · 탐침을 앞뒤 합쳐 60. **늘리지 않는다**(지휘 결정
 * 2026-11-18) — 남의 키에 청구될 수 있는 비용이다. 첫 조회 분포는 머리말: 꾸준한 캐릭터는 대개 이 안에서
 * 끝나고, 활동이 불규칙한 캐릭터는 여기서 멈춰 두 번째 `!ㄼ` 가 마저 찾는다. 한 키 하루 1,000콜 중 6%.
 */
export const LEVEL_CALL_BUDGET = 60;

/**
 * 키를 고를 때 "제 몫이 있다"고 보는 최소 남은 몫 — 12. 이만큼 남은 키는 사다리 순서대로 먼저 쓴다(내 키가
 * 부분 몫이어도 남의 풀 키보다 앞선다). 최신 1 + `/id` 1 + 아래쪽 끝 겨냥 1~2 + 최근 레벨 몇 개를 확정할
 * 탐침(레벨당 대개 2~3). 이보다 적게 남은 키만 있으면 `LEVEL_FIXED_CALLS` 이상 남은 첫 키를 그 몫으로라도
 * 쓴다(`pickKey`) — 저장된 표본 + 쿨다운이면 0~1콜로 답할 수 있다.
 */
const LEVEL_MIN_CALLS = 12;

/**
 * 탐침 없이도 한 명령이 쓸 수 있는 **고정 콜의 최대치** — 4 = `/id` + 최신 + 낡은 ocid 재확인 `/id` + 다시 최신.
 * 남은 몫이 이보다 적은 키는 고르지 않는다(R2-3: 몫 1~2 인 키를 골라 고정 콜만으로 80% 선을 넘었다 — 801).
 * 이 콜들도 `allowance` 안에서 센다(`countCalls` 가 모든 게이트웨이에 씌워져 있다).
 */
const LEVEL_FIXED_CALLS = 4;

/**
 * 한 탐색이 키 줄에 세우거나 보내는 중인 탐침의 상한 — **2**(지휘 결정 2026-11-18, D2).
 *
 * ★ 1라운드처럼 웨이브의 날들을 통째로 줄에 세우면 같은 키를 쓰는 다른 명령이 웨이브 하나(최대 15콜
 *   ≈ 4초) 뒤에 섰다. 2개씩 흘리면 다른 명령은 탐색 하나당 최대 2칸(≈ 0.5초)만 기다린다.
 * ⚠️ 대가: 넥슨 왕복이 500ms(= 2칸 × 250ms)보다 길면 탐색 자체가 키당 4콜/초를 못 채운다. 시뮬레이션
 *    (머리말): 왕복 350ms 에서는 늦어지지 않고, 800ms 에서는 1라운드 계획에 동시 2만 씌우면 중앙값 5~7.5초
 *    늦다(새 계획이 그중 2~3초를 되찾는다).
 */
export const LEVEL_PROBE_CONCURRENCY = 2;

/** 데이터 없는 날 기억의 크기 상한과 수명. 넘으면 오래된 것부터 지운다. */
const EMPTY_DAY_MEMO_LIMIT = 4096;
const EMPTY_DAY_MEMO_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * "그날 데이터 없음"이 **다시 물어도 같은** 종류. `data_not_ready`(전날 기록이 아직 안 들어옴, 00~02시)는
 * 몇 시간 뒤 바뀌므로 기억하지도 저장하지도 않는다. 빈 200 응답도 영구로 본다.
 */
const PERMANENT_EMPTY_KINDS: ReadonlySet<NexonErrorKind> = new Set<NexonErrorKind>([
  "invalid_parameter",
  "invalid_id",
]);

/** 시간 상한이 지나 보내지 않은 탐침의 표시. 넥슨 오류가 아니다. */
const TIME_UP = new Error("level-search-time-up");

// ─────────────────────────────────────────────────────────────────────────────
// 인스턴스 메모리 — 진행 중인 탐색 · 데이터 없는 날
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 탐색이 끝난 이유. `null` 은 아직 도는 중이다.
 *   · `done` — 더 찌를 것이 없다(다 찾음 · 끊김).
 *   · `nexon` — 넥슨 오류(할당량 · 서버 · 점검 · 네트워크)로 멈췄다. 예기치 못한 예외도 여기로 접는다.
 *   · `limit` — 명령당 콜 상한(`LEVEL_CALL_BUDGET`) · 시간 상한으로 멈췄다. 다시 치면 이어 간다.
 *   · `quota` — 키의 남은 몫 때문에 **줄어든** 상한으로 멈췄다(R2-2). 바로 다시 치면 그 키는 몫이 없다.
 */
type SearchEnding = "done" | "nexon" | "limit" | "quota";

/** 한 ocid 의 탐색. 표본은 탐침마다 늘어나고, 뒤에 온 명령도 같은 객체를 읽는다. */
interface LevelSearch {
  /** 지난날 표본(어제까지). 저장분 + 이번에 받은 날 + 데이터 없는 날. */
  readonly samples: Map<string, LevelSample>;
  /** 줄에 섰거나 날아가는 날(최대 `LEVEL_PROBE_CONCURRENCY`). 답장 시점 계획에 "탐침 금지일"로 넘긴다. */
  readonly inFlight: Set<string>;
  /** 탐색이 끝나면(다 찾음 · 상한 · 실패) 풀린다. 거부하지 않는다. */
  readonly completion: Promise<void>;
  /** 끝난 이유. 끝나기 전에는 `null`. */
  ending: SearchEnding | null;
  /** `ending === "nexon"` 일 때 그 오류(로그용 — 답장에는 싣지 않는다). */
  failure: unknown;
}

/** ocid → 진행 중인 탐색. 끝나면 지운다(저장이 끝난 뒤라 다음 명령은 표에서 읽는다). */
const runningSearches = new Map<string, LevelSearch>();

/**
 * `ocid|day` → 데이터 없다고 확인한 시각. `character_exp_empty_days` 가 원본이고 이것은 보조다 — 표를 못
 * 읽은 경우(마이그레이션 전 · DB 실패)에도 같은 인스턴스에서는 다시 찌르지 않는다.
 */
const emptyDays = new Map<string, { readonly at: number; readonly reason: StoredEmptyReason }>();

function rememberEmptyDay(
  ocid: string,
  day: string,
  reason: StoredEmptyReason,
  nowMs: number,
): void {
  const key = `${ocid}|${day}`;
  emptyDays.delete(key);
  emptyDays.set(key, { at: nowMs, reason });
  if (emptyDays.size <= EMPTY_DAY_MEMO_LIMIT) return;
  for (const [stale, memo] of emptyDays) {
    if (nowMs - memo.at >= EMPTY_DAY_MEMO_TTL_MS) emptyDays.delete(stale);
  }
  while (emptyDays.size > EMPTY_DAY_MEMO_LIMIT) {
    const oldest = emptyDays.keys().next();
    if (oldest.done === true) break;
    emptyDays.delete(oldest.value);
  }
}

function recallEmptyDays(ocid: string, nowMs: number): StoredEmptyDay[] {
  const prefix = `${ocid}|`;
  const days: StoredEmptyDay[] = [];
  for (const [key, memo] of emptyDays) {
    if (key.startsWith(prefix) && nowMs - memo.at < EMPTY_DAY_MEMO_TTL_MS) {
      days.push({ day: key.slice(prefix.length), reason: memo.reason });
    }
  }
  return days;
}

/**
 * 실제로 **보낸** 호출만 센다(`pacedGateway` 가 보낼 때 부른다) — 콜 상한 판정의 근거다. 그 요청이 끝나면
 * (게이트웨이가 장부를 적은 뒤다) 예약 몫을 하나 줄인다(`settleReservedCall`).
 */
function countCalls(
  gateway: NexonProxyContext["gateway"],
  counter: { calls: number },
  reservation: CallReservation | null,
): NexonProxyContext["gateway"] {
  return {
    request: <T>(args: NexonRequestOptions<T>): Promise<T> => {
      counter.calls += 1;
      let pending: Promise<T>;
      try {
        pending = gateway.request(args);
      } catch (error) {
        if (reservation !== null) settleReservedCall(reservation);
        return Promise.reject(error);
      }
      if (reservation !== null) {
        const settle = (): void => settleReservedCall(reservation);
        // 파생 약속은 거부되지 않는다(두 갈래 모두 처리) — 거부는 돌려준 `pending` 을 받은 쪽이 처리한다.
        void pending.then(settle, settle);
      }
      return pending;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 탐색
// ─────────────────────────────────────────────────────────────────────────────

interface SearchEnv {
  readonly db: AdminDb;
  readonly nexon: NexonProxyContext;
  readonly ocid: string;
  readonly todayKey: string;
  readonly currentLevel: number;
  readonly currentRate: string | null;
  readonly currentExp: number | null;
  /** 이 명령이 넥슨에 보낸 콜(최신 · `/id` 포함). */
  readonly counter: { calls: number };
  /** 이 명령의 콜 상한(`pickKey` 가 줄였을 수 있다). */
  readonly allowance: number;
  /** 이 명령이 잡은 몫. 탐색이 끝나면 푼다. */
  readonly reservation: CallReservation | null;
  /** 요청 시작(epoch ms). */
  readonly startedAtMs: number;
}

/** 표에서 읽은 것 — 값 있는 날과 데이터 없는 날. */
interface StoredSamples {
  readonly rows: readonly StoredLevelDay[];
  readonly emptyDays: readonly StoredEmptyDay[];
}

function loadStoredSamples(
  db: AdminDb,
  ocid: string,
  yesterdayKey: string,
): Promise<StoredSamples> {
  // 둘 다 던지지 않는다(실패하면 빈 배열 — 그 날들을 다시 찌를 뿐이다).
  return Promise.all([
    loadLevelDays(db, ocid, LEVEL_HISTORY_FLOOR_DAY, yesterdayKey),
    loadEmptyDays(db, ocid, LEVEL_HISTORY_FLOOR_DAY, yesterdayKey, new Date()),
  ]).then(([rows, empty]) => ({ rows, emptyDays: empty }));
}

/**
 * 지금 표본으로 계획한다. 줄에 섰거나 날아가는 날은 늘 탐침 금지일로 넘긴다 — 그 날이 든 괄호는 답을
 * 기다리고(같은 괄호에 탐침을 겹쳐 내지 않는다), 답장 시점에는 그 날 때문에 근사로 접히지 않는다.
 */
function planFor(
  search: LevelSearch,
  env: SearchEnv,
  previousGuardStates?: ReadonlyMap<number, LevelGuardState>,
): LevelSearchPlan {
  return planLevelSearch({
    samples: [...search.samples.values()],
    todayKey: env.todayKey,
    currentLevel: env.currentLevel,
    currentRate: env.currentRate,
    currentExp: env.currentExp,
    floorDay: LEVEL_HISTORY_FLOOR_DAY,
    blockedDays: new Set(search.inFlight),
    ...(previousGuardStates === undefined ? {} : { previousGuardStates }),
  });
}

/** 받은 것을 몇 건씩 모아 저장하나. 탐침마다 저장하면 DB 왕복이 콜 수만큼 는다. */
const SAVE_BATCH_SIZE = 8;

/**
 * 탐색 본체. 끝난 이유를 돌려준다. 넥슨 · DB 실패는 로그로 남기고 아는 만큼에서 멈춘다(던지지 않게 짰지만,
 * 던지면 `startSearch` 가 `nexon` 으로 접는다).
 *
 * ★ **응답이 하나 올 때마다 다시 계획한다**(2라운드 — 웨이브 대신). 탐침은 언제나
 *   `LEVEL_PROBE_CONCURRENCY`(2)개까지만 줄에 서거나 날아가므로 큰 웨이브의 이점이 없고, 방금 온 답으로
 *   다음 날을 고르는 쪽이 콜이 적다. 계획은 상태가 없고 싸다.
 * ★ 안전장치 상태(`issued`)는 **실제로 낸 탐침**의 목표 몫만 넘긴다(`probeTargets`) — 계획만 하고 내지
 *   않은 목표의 몫을 세면 안전장치가 일찍 이등분으로 넘어간다.
 * ★ 탐침은 응답이 오는 대로 `search.samples` 에 들어가고, 답장은 상한 시점의 표본으로 만든다 — 계획이
 *   최근 레벨의 탐침을 앞에 두므로 답장에 먼저 들어간다.
 */
async function runSearch(
  search: LevelSearch,
  env: SearchEnv,
  stored: Promise<StoredSamples>,
): Promise<SearchEnding> {
  const stopAtMs = env.startedAtMs + LEVEL_CONTINUE_LIMIT_MS;
  const yesterdayKey = shiftDayKey(env.todayKey, -1);
  const fromTables = await stored;
  for (const row of fromTables.rows) {
    if (!search.samples.has(row.day)) {
      search.samples.set(row.day, {
        day: row.day,
        level: row.level,
        rate: row.rateText,
        exp: row.exp,
      });
    }
  }
  for (const empty of [...fromTables.emptyDays, ...recallEmptyDays(env.ocid, Date.now())]) {
    if (!search.samples.has(empty.day)) {
      search.samples.set(empty.day, {
        day: empty.day,
        level: null,
        rate: null,
        emptyReason: empty.reason,
      });
    }
  }

  const stop = { stopped: null as unknown };
  const gateway = pacedGateway(
    countCalls(stopOnFailure(env.nexon.gateway, stop), env.counter, env.reservation),
    env.nexon.apiKeyHash,
    {
      abortReason: (): unknown =>
        stop.stopped ?? (Date.now() >= stopAtMs ? TIME_UP : null),
    },
  );

  const fresh: ExpDayToSave[] = [];
  const empty: EmptyDayToSave[] = [];
  const saves: Promise<number>[] = [];
  /** 모인 것을 저장한다(받은 시각 기준으로 거른다 — KST 3시 전의 어제 · 어제 이후의 빈 날). */
  const flush = (force: boolean): void => {
    if (!force && fresh.length + empty.length < SAVE_BATCH_SIZE) return;
    const savedAt = new Date();
    if (fresh.length > 0) saves.push(saveExpDays(env.db, fresh.splice(0), savedAt));
    if (empty.length > 0) saves.push(saveEmptyDays(env.db, empty.splice(0), savedAt));
  };
  const failure = { error: null as unknown };

  const markEmpty = (day: string, permanent: boolean, reason: StoredEmptyReason): void => {
    search.samples.set(day, { day, level: null, rate: null, emptyReason: reason });
    // 어제는 기억 · 저장하지 않는다 — 새벽(넥슨 전날 데이터가 들어오기 전)의 빈 값일 수 있다.
    if (!permanent || day >= yesterdayKey) return;
    rememberEmptyDay(env.ocid, day, reason, Date.now());
    empty.push({ ocid: env.ocid, day, reason });
  };

  const probe = async (day: string): Promise<void> => {
    try {
      const value: NexonCharacterBasicWithExp = await fetchCharacterBasicWithExp(
        env.nexon.apiKey,
        env.ocid,
        { date: day },
        gateway,
      );
      if (value.characterLevel === null) {
        markEmpty(day, true, "no-data");
        return;
      }
      search.samples.set(day, {
        day,
        level: value.characterLevel,
        rate: value.characterExpRate,
        exp: value.characterExp,
      });
      if (value.characterExp !== null && value.characterExpRate !== null) {
        fresh.push({
          ocid: env.ocid,
          day,
          characterName: value.characterName,
          worldName: value.worldName,
          level: value.characterLevel,
          exp: value.characterExp,
          rateText: value.characterExpRate,
        });
      }
    } catch (error) {
      if (error === TIME_UP) return;
      if (isNexonApiError(error) && ROW_SKIP_KINDS.has(error.kind)) {
        /*
          `invalid_parameter` 는 그 날짜에 캐릭터가 없었다는 뜻이다(범위 밖 날짜는 찌르지 않는다 — 클라이언트
          주석의 실측). "지난 기록 없음" 판정의 근거가 된다(`noPastData`).
        */
        markEmpty(
          day,
          PERMANENT_EMPTY_KINDS.has(error.kind),
          error.kind === "invalid_parameter" ? "before-creation" : "no-data",
        );
        return;
      }
      failure.error ??= error;
    } finally {
      search.inFlight.delete(day);
      flush(false);
    }
  };

  /** 목표 → 안전장치 상태(낸 탐침의 몫만). */
  const issued = new Map<number, LevelGuardState>();
  const running = new Set<Promise<void>>();
  /** 이 탐색이 시작할 때까지 쓴 콜(최신 · `/id`). */
  const callsBefore = env.counter.calls;
  let started = 0;
  let ending: SearchEnding = "done";
  let reason = "완료";
  for (;;) {
    const plan = planFor(search, env, issued);
    if (plan.done && running.size === 0) break;
    if (failure.error !== null) {
      search.failure = failure.error;
      ending = "nexon";
      reason = `넥슨오류 ${describeFailure(failure.error)}`;
      break;
    }
    if (Date.now() >= stopAtMs) {
      ending = "limit";
      reason = "시간";
      break;
    }

    for (const day of plan.probes) {
      if (running.size >= LEVEL_PROBE_CONCURRENCY) break;
      // 콜 상한: 최신 · `/id` 로 이미 쓴 콜 + 이 탐색이 낸 탐침(줄에서 아직 안 나간 것 포함).
      if (callsBefore + started >= env.allowance) break;
      started += 1;
      search.inFlight.add(day);
      for (const level of plan.probeTargets.get(day) ?? []) {
        const state = plan.guardStates.get(level);
        if (state !== undefined) issued.set(level, state);
      }
      const task = probe(day).finally(() => {
        running.delete(task);
      });
      running.add(task);
    }

    if (running.size === 0) {
      /*
        낼 탐침이 없는데 끝나지도 않았다 — 콜 상한이거나 계획상 막힌 경우다. 상한이 **키 몫 때문에 줄어든**
        것이면(R2-2) 다시 쳐도 그 키는 몫이 없으므로 "이어서 찾는다"고 하지 않는다.
      */
      const capped = callsBefore + started >= env.allowance;
      ending = capped && env.allowance < LEVEL_CALL_BUDGET ? "quota" : "limit";
      reason = capped ? (ending === "quota" ? "키몫상한" : "콜상한") : "탐침없음";
      break;
    }
    await Promise.race(running);
  }
  await Promise.all(running);
  flush(true);
  await Promise.all(saves);

  const finalPlan = planFor(search, env);
  const settled = finalPlan.reaches.filter((reach) => reach.kind !== "pending").length;
  // 키 · ocid · 닉네임은 남기지 않는다. 콜 수는 상한을 다시 볼 근거다.
  console.info(
    `[bot/level] 탐침 ${String(env.counter.calls - callsBefore)} · ` +
      `콜 ${String(env.counter.calls)}/${String(env.allowance)} · ` +
      `확정 ${String(settled)}/${String(finalPlan.reaches.length)} · ${reason} · ` +
      `${String(Date.now() - env.startedAtMs)}ms`,
  );
  return ending;
}

/**
 * 탐색을 **동기적으로 등록하고** 시작한다 — 등록과 시작 사이에 `await` 가 없어야 같은 ocid 의 두 번째
 * 명령이 두 번째 탐색을 만들지 않는다. 이 명령이 잡은 몫(`env.reservation`)은 이제 탐색이 갖고, 탐색이
 * 끝나면(예외 경로 포함) 여기서 푼다.
 */
function startSearch(env: SearchEnv, stored: Promise<StoredSamples>): LevelSearch {
  let finish: () => void = () => undefined;
  const completion = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const search: LevelSearch = {
    samples: new Map<string, LevelSample>(),
    inFlight: new Set<string>(),
    completion,
    ending: null,
    failure: null,
  };
  runningSearches.set(env.ocid, search);

  void runSearch(search, env, stored)
    .then(
      (ending) => {
        search.ending = ending;
      },
      (error: unknown) => {
        console.warn(
          `[bot/level] 탐색 실패: ${error instanceof Error ? error.name : "unknown"}`,
        );
        search.failure = error;
        search.ending = "nexon";
      },
    )
    .finally(() => {
      if (env.reservation !== null) releaseReservation(env.reservation);
      if (runningSearches.get(env.ocid) === search) runningSearches.delete(env.ocid);
      finish();
    });

  /*
    ★ 응답이 끝나도 함수가 살아 있게 한다(`refresh-on-command.refreshBeforeReply` 와 같은 방식). 콜백은
      새 일을 시작하지 않고 이미 시작한 탐색을 넘겨 줄 뿐이다. 수명 한도는 라우트의 `maxDuration` 이다.
  */
  try {
    after(() => completion);
  } catch (error) {
    // 플랫폼이 못 받아 줘도 답장은 나간다. 그때 응답 뒤 탐색은 잘릴 수 있다.
    console.warn(
      `[bot/level] after 등록 실패 — 탐색이 잘릴 수 있다: ${error instanceof Error ? error.name : "unknown"}`,
    );
  }
  return search;
}

/** `work` 가 끝나거나 `deadlineMs`(epoch)가 되면 돌아온다. */
async function settleBy(work: Promise<void>, deadlineMs: number): Promise<void> {
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, remaining);
    void work.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 진입점
// ─────────────────────────────────────────────────────────────────────────────

type LatestRead =
  | { readonly kind: "ok"; readonly value: NexonCharacterBasicWithExp }
  | { readonly kind: "not-found" }
  | { readonly kind: "failed"; readonly error: unknown };

async function readLatest(
  nexon: NexonProxyContext,
  ocid: string,
  todayKey: string,
  nowMs: number,
  gateway: NexonProxyContext["gateway"],
): Promise<LatestRead> {
  try {
    return {
      kind: "ok",
      value: await fetchLatestWithCooldown(nexon, ocid, todayKey, nowMs, gateway),
    };
  } catch (error) {
    return isNexonApiError(error) && NOT_FOUND_KINDS.has(error.kind)
      ? { kind: "not-found" }
      : { kind: "failed", error };
  }
}

export async function handleLevelHistory(
  context: CommandContext,
  parsed: ParsedCommand,
  account: BotAccount | null,
): Promise<CommandOutcome> {
  // 안내 문구는 사람이 친 이름 그대로 되읽는다(`!ㄼ` · `!ㄹㅂ`).
  const command: LookupCommand = { label: `!${parsed.name}`, tag: TAG, logTag: "bot/level" };
  // 메이플 닉네임에는 공백이 없다 — `!ㄼ 새 스링` 은 오타로 보고 받아 준다(`!%` 와 같다).
  const nickname = parsed.rest.replace(/\s+/gu, "");
  const userId = account?.userId ?? null;

  const target = await resolveLookupTarget(context, account, nickname, command);
  if (isOutcome(target)) return target;

  const pick = await pickKey(context.db, context.now, target.keyStages, {
    calls: LEVEL_CALL_BUDGET,
    minCalls: LEVEL_MIN_CALLS,
    fixedCalls: LEVEL_FIXED_CALLS,
  });
  if (pick.kind !== "ok") return keyMissReply(pick.kind, account !== null, userId, command);

  /*
    ★ 잡은 몫은 **반드시 푼다.** 탐색을 시작하면 탐색이 끝날 때 풀고(`startSearch`), 그 전에 답하고 끝나는
      모든 길(넥슨 실패 · 찾을 수 없음 · 빈 레벨 · 진행 중 탐색에 붙음 · 예외)은 아래 `finally` 가 푼다.
  */
  const reservation = pick.reservation;
  let handedOff = false;
  try {
    const nexon = pick.context;
    const counter = { calls: 0 };
    const idGateway = pacedGateway(
      countCalls(nexon.gateway, counter, reservation),
      nexon.apiKeyHash,
    );
    const latestGateway = pacedGateway(
      countCalls(createLatestGateway(nexon), counter, reservation),
      nexon.apiKeyHash,
    );
    const nowMs = context.now.getTime();
    const todayKey = kstDayKey(context.now);
    const yesterdayKey = shiftDayKey(todayKey, -1);

    const resolved = await resolveOcid({
      nexon,
      target,
      nickname,
      idGateway,
      nowMs,
      userId,
      command,
    });
    if (resolved.kind === "reply") return resolved.outcome;
    let ocid = resolved.ocid;

    /*
      저장된 표본은 최신 호출과 **나란히** 읽는다(DB 왕복이 넥슨 왕복 안에 숨는다). 이미 돌고 있는 탐색에
      붙을 거면 읽지 않는다.
    */
    const loadStored = (forOcid: string): Promise<StoredSamples> | null =>
      runningSearches.has(forOcid) ? null : loadStoredSamples(context.db, forOcid, yesterdayKey);
    let stored = loadStored(ocid);
    let latest = await readLatest(nexon, ocid, todayKey, nowMs, latestGateway);

    // 낡은 ocid 를 한 번만 다시 찾는다(`!%` 와 같은 규칙 — `recheckOcid`).
    if (latest.kind === "not-found" && resolved.needsRecheck && target.lookupName !== null) {
      const recheck = await recheckOcid({
        nexon,
        lookupName: target.lookupName,
        staleOcid: ocid,
        idGateway,
        nowMs,
        userId,
        command,
      });
      if (recheck.kind === "reply") return recheck.outcome;
      if (recheck.kind === "fresh") {
        ocid = recheck.ocid;
        stored = loadStored(ocid);
        latest = await readLatest(nexon, ocid, todayKey, nowMs, latestGateway);
      }
    }

    if (latest.kind === "failed") return nexonFailure(latest.error, userId, command);
    if (latest.kind === "not-found") return notFoundOutcome(userId, command);
    const current = latest.value;
    if (current.characterLevel === null) {
      return { reply: lines(LEVEL_HISTORY_EMPTY_TEXT), tag: `${TAG}:빈`, userId };
    }

    const env: SearchEnv = {
      db: context.db,
      nexon,
      ocid,
      todayKey,
      currentLevel: current.characterLevel,
      currentRate: current.characterExpRate,
      currentExp: current.characterExp,
      counter,
      allowance: pick.allowance,
      reservation,
      startedAtMs: nowMs,
    };
    /*
      ★ 붙으려던 탐색이 그사이 끝났으면(`stored` 를 안 읽었다) 여기서 읽는다 — 빈 표본으로 새 탐색을
        시작하면 이미 저장된 날을 넥슨에 다시 묻는다.
    */
    let search = runningSearches.get(ocid);
    if (search === undefined) {
      search = startSearch(env, stored ?? loadStoredSamples(context.db, ocid, yesterdayKey));
      handedOff = true;
    } else if (reservation !== null) {
      /*
        ★ 진행 중인 탐색에 붙는다 — 이 명령은 더 찌르지 않으므로 남은 몫을 **지금** 푼다(R2-1). 6.5초를
          기다리는 동안 몫을 쥐고 있으면 그 사이 온 다른 `!ㄼ` 가 몫이 없다는 답을 받는다. 이미 쓴 `/id` ·
          최신은 응답이 끝나 정산돼 있다.
      */
      releaseReservation(reservation);
    }
    await settleBy(search.completion, nowMs + LEVEL_REPLY_DEADLINE_MS);

    // 답을 기다리는 날은 금지일로 넘긴다 — 그 날 때문에 근사로 접힌 줄이 나가지 않게.
    const plan = planFor(search, env);
    const ending = search.ending;
    const head = plan.reaches[0];
    const hasRows = head !== undefined && (head.kind === "exact" || head.kind === "approx");
    // D4: 넥슨 오류로 이미 멈췄고 보일 줄이 없으면 `!%` 와 같은 넥슨 실패 답장이다.
    if (!plan.done && ending === "nexon" && !hasRows) {
      return nexonFailure(search.failure, userId, command);
    }
    const pendingNote: LevelPendingNote =
      ending === null
        ? "searching"
        : ending === "nexon"
          ? "nexon-stopped"
          : ending === "quota"
            ? "quota-stopped"
            : "limit-stopped";

    // 길이 상한은 `formatLevelHistory` 주석(최악 실측)이 지킨다.
    return {
      reply: lines(
        ...formatLevelHistory({
          characterName: current.characterName ?? target.fallbackName,
          worldName: current.worldName,
          currentLevel: current.characterLevel,
          currentRate: current.characterExpRate,
          todayKey,
          reaches: plan.reaches,
          noPastData: plan.noPastData,
          pendingNote,
        }),
      ),
      tag: plan.done ? TAG : ending === null ? `${TAG}:찾는중` : `${TAG}:멈춤`,
      userId,
    };
  } finally {
    if (!handedOff && reservation !== null) releaseReservation(reservation);
  }
}
