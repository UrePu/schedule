import { kstMoment } from "@/lib/time/kst-wallclock";
import { formatKst } from "@/lib/time/week";

/**
 * KST 요일/시각 표기 헬퍼.
 *
 * date-fns 의 `EEE` 토큰은 로케일을 주지 않으면 영어("Thu")를 내놓는다.
 * UI 전체가 한국어이므로 요일만 ISO 요일 번호(1=월 … 7=일)로 뽑아 직접 매핑한다.
 * 로케일 번들을 끌어오지 않아 번들 크기에도 이득이다.
 */

const WEEKDAY_KO = ["월", "화", "수", "목", "금", "토", "일"] as const;

/** KST 기준 한국어 요일 한 글자. */
export function kstWeekdayKo(date: Date): string {
  const isoDay = Number.parseInt(formatKst(date, "i"), 10);
  return WEEKDAY_KO[isoDay - 1] ?? "";
}

/** 예) "8/20 목 00:00" — 초기화 시점 표기에 쓴다. */
export function formatKstShort(date: Date): string {
  return `${formatKst(date, "M/d")} ${kstWeekdayKo(date)} ${formatKst(date, "HH:mm")}`;
}

/**
 * 예) `2026-08-20` → `8/20 목` — KST **달력 날짜 키**의 표시명.
 *
 * 정오(720분)로 환산해 요일을 뽑는다. 00:00 을 쓰면 경계에서 하루가 밀릴 여지가 남는데,
 * 정오는 어떤 오프셋 계산에서도 같은 날 안에 있다.
 * (특이사항 목록과 특이사항 편집기가 **같은 문자열**을 쓰도록 여기 한 곳에 둔다.)
 */
export function formatKstDayKey(dayKey: string): string {
  const noon = kstMoment(dayKey, 720);
  return `${formatKst(noon, "M/d")} ${kstWeekdayKo(noon)}`;
}

/** 예) "2026-08-20 목 00:00" — title 속성 등 정확한 시각 노출용. */
export function formatKstFull(date: Date): string {
  return `${formatKst(date, "yyyy-MM-dd")} ${kstWeekdayKo(date)} ${formatKst(date, "HH:mm")}`;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 스냅샷 신선도 한 줄 — **`fetched_at` 이 주(主), `snapshot_at` 은 예외일 때만**
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * 발주 지시(2026-08-27): *"동기화하는데 왜 시간은 00이야?"*
 *
 * `character_scheduler_snapshots` 의 두 열은 뜻이 다르고, 화면이 엉뚱한 쪽을 그리고
 * 있었다(`scheduler-freshness.ts` 가 이미 같은 함정을 적어 두었는데 UI 가 빠졌다):
 *
 *   · `snapshot_at` = 넥슨 응답의 `date`. **날짜 단위**라 실측값이 언제나
 *     `2026-08-27T00:00+09:00` 이다. 시각까지 찍으면 **영원히 `00:00`** 이고,
 *     새로고침을 눌러도 값이 안 움직여 "동기화가 안 됐나"로 읽힌다.
 *   · `fetched_at` = **우리가 넥슨을 부른 시각**. 새로고침이 실제로 한 일이 이것이라,
 *     사용자가 확인하려는 값도 이쪽이다.
 *
 * 그렇다고 관측일을 버리면 안 된다 — 캐릭터가 로그인을 안 했으면 넥슨은 **어제 날짜**를
 * 돌려주고(§1.1), 그때 "왜 방금 잡은 게 안 보이지"의 답이 바로 그 날짜다.
 * 그래서 **불러온 날과 관측일이 다를 때만** 덧붙인다. 같은 날이면 덧붙일 정보가 없다.
 */
export interface SnapshotFreshness {
  /** 예) "2026-08-27 목 14:32" — 우리가 넥슨을 부른 시각. */
  readonly fetchedText: string;
  /** 관측일이 불러온 날과 다를 때만 예) "08-26 목". 같으면 `null`. */
  readonly staleDayText: string | null;
}

export function describeSnapshotFreshness(
  snapshotAtIso: string,
  fetchedAtIso: string,
): SnapshotFreshness {
  const snapshotAt = new Date(snapshotAtIso);
  const fetchedAt = new Date(fetchedAtIso);
  const observedDay = formatKst(snapshotAt, "yyyy-MM-dd");
  const fetchedDay = formatKst(fetchedAt, "yyyy-MM-dd");

  return {
    fetchedText: formatKstFull(fetchedAt),
    staleDayText:
      observedDay === fetchedDay
        ? null
        : `${formatKst(snapshotAt, "MM-dd")} ${kstWeekdayKo(snapshotAt)}`,
  };
}
