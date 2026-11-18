import "server-only";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 지난날 경험치 저장소 — `public.character_exp_daily`
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 넥슨 `/character/basic?date=D` 는 하루치만 주고, **지난 날짜(D ≤ 어제)의 값은 다시 바뀌지
 * 않는다.** 그래서 한 번 받은 날은 여기 적어 두고 봇 `!%` 는 넥슨에 최신 1콜만 묻는다
 * (마이그레이션 `20261118120000_character_exp_daily.sql` 머리말). 봇 `!ㄼ`(레벨업 날짜)가 찌른
 * 날도 같은 규칙으로 여기 쌓이고, 다음 `!ㄼ` 는 그 표본에서 이어 찾는다(`loadLevelDays`). 넥슨이
 * **데이터 없음**으로 답한 날은 이 표에 못 넣으므로(NOT NULL) 따로 `character_exp_empty_days` 에 둔다
 * (`loadEmptyDays` · `saveEmptyDays`, 마이그레이션 `20261118130000_character_exp_empty_days.sql`).
 *
 * ★ **이 모듈은 던지지 않는다.** 저장은 최적화일 뿐이다 — 표가 아직 라이브에 없거나(배포가
 *   마이그레이션 적용보다 먼저 나갈 수 있다) DB 가 흔들려도 `!%` 는 지금처럼 넥슨만으로 답해야
 *   한다. 읽기 실패는 "저장된 날 없음"(빈 배열), 쓰기 실패는 로그만 남긴다.
 * ★ **오늘(KST) 이상은 절대 저장하지 않는다.** 아직 바뀌는 값이다. 표의 CHECK 로는 막을 수 없어
 *   (`now()` 는 불변 함수가 아니다) 여기서 강제한다.
 * ⚠️ 로그에 ocid · 닉네임은 남기지 않는다. DB 오류 문구와 건수만.
 */

import { MAX_LEVEL } from "@/lib/domain/exp-history";
import type { AdminDb } from "@/lib/supabase/admin-db";
import { addKstDays, kstDayKey, kstMoment } from "@/lib/time/kst-wallclock";
import { formatKst } from "@/lib/time/week";

/**
 * **어제 값이 확정됐다고 보는 KST 시각(시)** — 3시.
 *
 * 넥슨의 전날 데이터는 다음 날 오전 2시께 들어온다(CLAUDE.md §1.1). 그 전에 받은 "어제" 값은 아직
 * 바뀔 수 있으므로 **저장하지 않는다**(답장에는 그대로 쓴다). 크론 채우기도 이 시각부터 연다 —
 * `exp-daily-fill.ts` 의 `EXP_FILL_FIRST_HOUR_KST` 는 이 상수를 그대로 가리킨다(숫자를 두 번 적지
 * 않는다). 여기 두는 이유는 채우기 모듈이 이미 이 모듈을 import 하므로, 반대로 두면 순환이 생기기
 * 때문이다.
 */
export const YESTERDAY_SETTLED_HOUR_KST = 3;

/**
 * KST 시(0~23) — **내림**이다. 02:59:59 는 2시, 08:59:59 는 8시.
 *
 * ★ `minutesFromKstDay` 는 분 단위로 **반올림**하므로 쓰지 않는다(교차 검증: 02:59:59 가 3시로
 *   잡혔다). 저장 규칙과 크론 시간대가 같은 판정을 타도록 둘 다 이 함수를 쓴다.
 */
export function kstHourOf(now: Date): number {
  return Number.parseInt(formatKst(now, "H"), 10);
}

/** 저장된 하루. */
export interface StoredExpDay {
  /** KST 기준일 `YYYY-MM-DD`. */
  readonly day: string;
  readonly characterName: string | null;
  readonly worldName: string | null;
  readonly level: number;
  /** 그 레벨에서 보유한 경험치(정수). */
  readonly exp: number;
  /** 넥슨 퍼센트 문자열 그대로(`"7.143"`). */
  readonly rateText: string;
}

/** 저장할 하루. 어느 캐릭터인지(`ocid`)를 함께 든다. */
export interface ExpDayToSave extends StoredExpDay {
  readonly ocid: string;
}

/** 표의 CHECK 와 같은 모양. 표가 막기 전에 여기서 걸러 한 줄 때문에 묶음 전체가 실패하지 않게 한다. */
const EXP_RATE_TEXT = /^\d+(?:\.\d+)?$/u;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/u;

function isUsableDay(row: StoredExpDay): boolean {
  return (
    DAY_KEY.test(row.day) &&
    Number.isInteger(row.level) &&
    row.level >= 1 &&
    row.level <= MAX_LEVEL &&
    Number.isSafeInteger(row.exp) &&
    row.exp >= 0 &&
    EXP_RATE_TEXT.test(row.rateText)
  );
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

/**
 * 한 ocid 의 `fromDay`…`toDay`(양끝 포함, KST `YYYY-MM-DD`) 저장분. 날짜 오름차순.
 * **실패하면 빈 배열**이다 — 부르는 쪽은 그 날들을 넥슨에서 받는다.
 */
export async function loadExpDays(
  db: AdminDb,
  ocid: string,
  fromDay: string,
  toDay: string,
): Promise<readonly StoredExpDay[]> {
  try {
    const { data, error } = await db
      .from("character_exp_daily")
      .select("day,character_name,world_name,character_level,character_exp,exp_rate")
      .eq("ocid", ocid)
      .gte("day", fromDay)
      .lte("day", toDay)
      .order("day", { ascending: true });
    if (error !== null) {
      console.warn(`[exp-daily] 읽기 실패 — 넥슨으로만 답한다: ${error.message}`);
      return [];
    }
    return (data ?? [])
      .map(
        (row): StoredExpDay => ({
          day: row.day,
          characterName: row.character_name,
          worldName: row.world_name,
          level: row.character_level,
          exp: Number(row.character_exp),
          rateText: row.exp_rate,
        }),
      )
      .filter(isUsableDay);
  } catch (error) {
    console.warn(`[exp-daily] 읽기 실패 — 넥슨으로만 답한다: ${describe(error)}`);
    return [];
  }
}

/**
 * `loadLevelDays` 가 한 번에 읽는 행 수 상한 — 1,000.
 *
 * ★ PostgREST 의 기본 최대 행 수와 같은 값이라, 이보다 크게 잡아도 서버가 잘라 준다. 캐릭터당 하루
 *   한 행이므로 크론이 매일 채우는 추적 캐릭터도 2년 반 넘게 이 안이다. 넘으면 **최근 것부터** 남긴다
 *   (최근 레벨일수록 답장 맨 아래에 먼저 보이는 줄이다). 빠진 옛 날은 `!ㄼ` 가 넥슨에 다시 묻는다.
 */
export const LEVEL_DAYS_READ_LIMIT = 1000;

/** `!ㄼ` 가 쓰는 하루 — 레벨 · 경험치 · 퍼센트. */
export interface StoredLevelDay {
  /** KST 기준일 `YYYY-MM-DD`. */
  readonly day: string;
  readonly level: number;
  /** 그 레벨에서 보유한 경험치(정수). 레벨별 필요 경험치를 역산해 탐침 위치를 고르는 데 쓴다. */
  readonly exp: number;
  /** 넥슨 퍼센트 문자열 그대로(`"7.143"`). */
  readonly rateText: string;
}

/**
 * 한 ocid 의 `fromDay`…`toDay`(양끝 포함) 저장분에서 **레벨 · 경험치 · 퍼센트**, 최근 날부터
 * `LEVEL_DAYS_READ_LIMIT` 행. 봇 `!ㄼ`(레벨업 날짜 탐색)의 표본이다 — `!%` 가 7일만 읽는 것과 달리
 * 하한일부터 전부 본다. **실패하면 빈 배열**이다 — 부르는 쪽은 넥슨에 묻는다.
 */
export async function loadLevelDays(
  db: AdminDb,
  ocid: string,
  fromDay: string,
  toDay: string,
): Promise<readonly StoredLevelDay[]> {
  try {
    const { data, error } = await db
      .from("character_exp_daily")
      .select("day,character_level,character_exp,exp_rate")
      .eq("ocid", ocid)
      .gte("day", fromDay)
      .lte("day", toDay)
      .order("day", { ascending: false })
      .limit(LEVEL_DAYS_READ_LIMIT);
    if (error !== null) {
      console.warn(`[exp-daily] 레벨 읽기 실패 — 넥슨으로만 찾는다: ${error.message}`);
      return [];
    }
    return (data ?? [])
      .map(
        (row): StoredLevelDay => ({
          day: row.day,
          level: row.character_level,
          exp: Number(row.character_exp),
          rateText: row.exp_rate,
        }),
      )
      .filter(
        (row) =>
          DAY_KEY.test(row.day) &&
          Number.isInteger(row.level) &&
          row.level >= 1 &&
          row.level <= MAX_LEVEL &&
          Number.isSafeInteger(row.exp) &&
          row.exp >= 0 &&
          EXP_RATE_TEXT.test(row.rateText),
      );
  } catch (error) {
    console.warn(`[exp-daily] 레벨 읽기 실패 — 넥슨으로만 찾는다: ${describe(error)}`);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 데이터 없는 날 — `public.character_exp_empty_days` (`!ㄼ` 전용)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `loadEmptyDays` 가 한 번에 읽는 행 수 상한. 캐릭터 하나의 빈 날은 데이터가 시작하기 전 몇 날(이분
 * 탐색이 찌른 것)뿐이라 넉넉하다. `LEVEL_DAYS_READ_LIMIT` 와 같은 값을 쓴다(PostgREST 기본 최대 행 수).
 */
export const EMPTY_DAYS_READ_LIMIT = LEVEL_DAYS_READ_LIMIT;

/**
 * 저장한 빈 날을 **믿는 기간(일)** — 30일. `checked_at` 이 이보다 오래된 행은 읽지 않고 다시 찌른다(다시 비면
 * `saveEmptyDays` 가 `checked_at` 을 갱신한다). 지휘 결정(2026-11-18, R2-6).
 * ★ 거래: 넥슨이 **일시적으로** 빈 응답을 준 날이 영구히 "데이터 없음"으로 굳지 않게 하는 대가로, 데이터가
 *   하한일보다 늦게 시작한 캐릭터는 한 달에 한 번 그 앞쪽 빈 날 몇 개(이분 탐색이 찌른 만큼)를 다시 찌른다.
 */
export const EMPTY_DAY_TRUST_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** 빈 날의 까닭. DB 에는 `no_data` · `before_creation` 으로 적는다. */
export type StoredEmptyReason = "no-data" | "before-creation";

/** 데이터 없는 날 하나. */
export interface EmptyDayToSave {
  readonly ocid: string;
  /** KST 기준일 `YYYY-MM-DD`. */
  readonly day: string;
  /**
   * `before-creation` = 넥슨이 그 날짜를 "유효하지 않은 파라미터"로 거절했다(캐릭터가 없던 날). 그 밖(빈 200 등)은
   * `no-data`. "지난 기록 없음" 판정이 이 값에 기댄다(`lib/domain/level-history` `noPastData`).
   */
  readonly reason: StoredEmptyReason;
}

/** 저장된 빈 날 하나. */
export interface StoredEmptyDay {
  readonly day: string;
  readonly reason: StoredEmptyReason;
}

/**
 * 한 ocid 의 `fromDay`…`toDay`(양끝 포함) 중 넥슨이 **데이터 없음**으로 답했던 날, 최근 날부터.
 * `checked_at` 이 `EMPTY_DAY_TRUST_DAYS` 보다 오래된 행은 빼고 읽는다(위 상수의 거래).
 * **실패하면 빈 배열**이다 — 부르는 쪽은 그 날을 다시 찌를 뿐이다(마이그레이션이 라이브에 아직 없을 때 포함).
 */
export async function loadEmptyDays(
  db: AdminDb,
  ocid: string,
  fromDay: string,
  toDay: string,
  now: Date = new Date(),
): Promise<readonly StoredEmptyDay[]> {
  const trustedSince = new Date(now.getTime() - EMPTY_DAY_TRUST_DAYS * DAY_MS).toISOString();
  try {
    const { data, error } = await db
      .from("character_exp_empty_days")
      .select("day,reason")
      .eq("ocid", ocid)
      .gte("day", fromDay)
      .lte("day", toDay)
      .gte("checked_at", trustedSince)
      .order("day", { ascending: false })
      .limit(EMPTY_DAYS_READ_LIMIT);
    if (error !== null) {
      console.warn(`[exp-daily] 빈 날 읽기 실패 — 다시 찌른다: ${error.message}`);
      return [];
    }
    return (data ?? [])
      .filter((row) => DAY_KEY.test(row.day))
      .map(
        (row): StoredEmptyDay => ({
          day: row.day,
          reason: row.reason === "before_creation" ? "before-creation" : "no-data",
        }),
      );
  } catch (error) {
    console.warn(`[exp-daily] 빈 날 읽기 실패 — 다시 찌른다: ${describe(error)}`);
    return [];
  }
}

/**
 * 데이터 없는 날을 저장한다(`(ocid, day)` 기준 upsert, `checked_at` 갱신). **어제보다 이른 날만** —
 * 어제는 새벽(넥슨 전날 기록이 들어오기 전)의 빈 값일 수 있다. `data_not_ready` 를 넘기지 않는 것은 부르는
 * 쪽 몫이다(종류를 여기서는 모른다). 던지지 않는다. 저장한 행 수를 돌려준다(실패면 0).
 */
export async function saveEmptyDays(
  db: AdminDb,
  rows: readonly EmptyDayToSave[],
  now: Date = new Date(),
): Promise<number> {
  const yesterdayKey = kstDayKey(addKstDays(kstMoment(kstDayKey(now), 0), -1));
  const unique = new Map<string, EmptyDayToSave>();
  for (const row of rows) {
    if (row.ocid === "" || !DAY_KEY.test(row.day) || row.day >= yesterdayKey) continue;
    unique.set(`${row.ocid}|${row.day}`, row);
  }
  if (unique.size === 0) return 0;

  try {
    const { error } = await db.from("character_exp_empty_days").upsert(
      [...unique.values()].map((row) => ({
        ocid: row.ocid,
        day: row.day,
        reason: row.reason === "before-creation" ? "before_creation" : "no_data",
        checked_at: now.toISOString(),
      })),
      { onConflict: "ocid,day" },
    );
    if (error !== null) {
      console.warn(`[exp-daily] 빈 날 저장 실패(${String(unique.size)}건, 무시): ${error.message}`);
      return 0;
    }
    return unique.size;
  } catch (error) {
    console.warn(`[exp-daily] 빈 날 저장 실패(${String(unique.size)}건, 무시): ${describe(error)}`);
    return 0;
  }
}

/**
 * 지난날들을 저장한다(`(ocid, day)` 기준 upsert). **오늘(KST) 이상 · 모양이 틀린 행은 버린다.**
 * KST `YESTERDAY_SETTLED_HOUR_KST` 시 전이면 **어제 행도** 버린다(아직 확정 전). 크론 · 봇이 모두
 * 이 함수로 저장하므로 규칙이 한 곳에 있다.
 * 실패해도 던지지 않는다. 저장한 행 수를 돌려준다(실패면 0).
 *
 * ★ 같은 묶음 안의 같은 `(ocid, day)` 는 하나로 줄인다 — 한 문장에서 같은 행을 두 번 upsert 하면
 *   Postgres 가 문장 전체를 거부한다.
 */
export async function saveExpDays(
  db: AdminDb,
  rows: readonly ExpDayToSave[],
  now: Date = new Date(),
): Promise<number> {
  const todayKey = kstDayKey(now);
  const yesterdayKey = kstDayKey(addKstDays(kstMoment(todayKey, 0), -1));
  const yesterdaySettled = kstHourOf(now) >= YESTERDAY_SETTLED_HOUR_KST;
  const unique = new Map<string, ExpDayToSave>();
  for (const row of rows) {
    if (row.ocid === "" || row.day >= todayKey || !isUsableDay(row)) continue;
    if (!yesterdaySettled && row.day === yesterdayKey) continue;
    unique.set(`${row.ocid}|${row.day}`, row);
  }
  if (unique.size === 0) return 0;

  try {
    const { error } = await db.from("character_exp_daily").upsert(
      [...unique.values()].map((row) => ({
        ocid: row.ocid,
        day: row.day,
        character_name: row.characterName,
        world_name: row.worldName,
        character_level: row.level,
        character_exp: row.exp,
        exp_rate: row.rateText,
        fetched_at: now.toISOString(),
      })),
      { onConflict: "ocid,day" },
    );
    if (error !== null) {
      console.warn(`[exp-daily] 저장 실패(${String(unique.size)}건, 무시): ${error.message}`);
      return 0;
    }
    return unique.size;
  } catch (error) {
    console.warn(`[exp-daily] 저장 실패(${String(unique.size)}건, 무시): ${describe(error)}`);
    return 0;
  }
}
