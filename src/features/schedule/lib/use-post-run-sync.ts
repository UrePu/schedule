"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { paceNexonRequest } from "@/features/auth/lib/nexon-pacer";
import { syncCharacterScheduler } from "@/features/boss-plans/data";
import { NEXON_CACHE_TTL_MS } from "@/lib/nexon/constants";
import { queryKeys } from "@/lib/query-keys";
import { getWeekKey } from "@/lib/time/week";
import type { TimetableRun } from "@/features/schedule/types";
import type { WeekKey } from "@/types/domain";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 런이 끝나면 **그 캐릭터만** 동기화한다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-21): *"죠린쪽 파티 방금 한거같은데 런이 끝났는지 동기화가 안되는듯.
 * 각 보스시간이 끝나고 그 캐릭을 동기화 돌리는게 좋을듯"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 여기서 도는가 — §1.1.1 의 "한 화면만 동기화한다" 를 어기지 않는다
 * ─────────────────────────────────────────────────────────────────────────────
 * CLAUDE.md §1.1.1 은 *"이것(계정 보스 현황)이 동기화하는 유일한 화면"* 이라고 못박았다.
 * 그 규칙의 **이유는 쿼터**다 — 화면마다 추적 캐릭터 전원을 돌면 한 번 둘러보는 것만으로
 * 캐릭터 수 × 화면 수만큼 호출이 나간다.
 *
 * 여기는 그 모양이 아니다. **끝났는데 아직 클리어가 안 잡힌 런의 캐릭터만** 부른다.
 *   · 조건이 참인 경우가 드물다(보스를 막 돈 직후 몇 분).
 *   · 대상이 전원이 아니라 **그 런에 간 캐릭터 하나**다.
 *   · 클리어가 잡히면 조건이 거짓이 되어 **스스로 멈춘다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **이번 주가 아니면 한 건도 부르지 않는다** — 2026-10-12, 주 이동이 붙으면서
 * ─────────────────────────────────────────────────────────────────────────────
 * 위 "하루 한 자릿수" 산술은 **입력이 늘 이번 주라는 전제**에 얹혀 있었다. 시간표에 주
 * 이동(`?week=`)이 붙으면서 그 전제가 깨졌고, 가드가 없으면 이렇게 샌다:
 *
 *   지난 주를 열면 그 주의 **클리어가 안 붙은 런 전부**가 `dueAt = 종료 + 10분` 을 이미
 *   한참 지난 상태다 → 즉시 `due` 가 되어 **그 주에 등장하는 구별되는 캐릭터 수만큼**
 *   호출이 나간다. 그리고 `attemptedRef` 는 **15분 버킷**으로만 막으므로 화면을 열어 둔
 *   채 15분이 지나면 **같은 수만큼 또** 나간다.
 *
 * 숫자로: 한 주에 캐릭터 6명이 런을 돌았고 그중 클리어가 안 붙은 것이 남아 있다면,
 * 지난 주를 한 번 여는 것만으로 6콜. 주를 뒤로 8주 훑으면 48콜, 화면을 한 시간 열어
 * 두면(15분 버킷 4개) 그 4배다. 개발 키는 하루 1,000콜이고(§1.1) 매시 :50 크론이 이미
 * `캐릭터 × 24` 를 쓰고 있으므로, "지난주에 뭐 돌았지" 를 몇 번 보는 것만으로 쿼터가
 * 바닥난다.
 *
 * 게다가 그 호출은 **효과가 0이다.** 넥슨 스케줄러는 현재 상태만 주고 과거 주차 기록은
 * 없다(§1.1 — `complete_flag` 는 현재 상태뿐). 지난 주의 클리어는 그 응답에 들어 있지
 * 않고, 다음 주의 클리어는 아직 존재하지 않는다. 비용만 있고 얻는 것이 없다.
 *
 * → 그래서 `collectTargets()` 가 **보고 있는 주 ≠ 지금 주차이면 빈 배열**을 돌려준다.
 *   판정이 대상 선정 안에 있으므로 타이머도 걸리지 않고 버킷도 소비되지 않는다.
 *   "지금 주차" 는 props 로 받은 `now` 가 아니라 **effect 가 도는 순간의 시각**으로
 *   센다 — 화면을 목요일 00:00 을 넘겨 열어 두면 서버가 준 `now` 는 이미 지난 주다.
 *
 * 가드가 선 뒤의 산술은 원래와 같다: 실측 한 주에 런이 10~20건, 이번 주를 볼 때만
 * 작동하므로 이 경로의 호출은 **하루 한 자릿수**다(개발 키 1,000/일).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **끝나자마자가 아니라 15분 뒤**다
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨 데이터는 약 15분 지연된다(§1.1). 런이 끝난 그 순간에 부르면 **아직 클리어가 없는
 * 응답**을 받고 호출만 한 건 태운다. 게다가 그 뒤 15분은 "방금 불렀으니 신선하다"로 막혀
 * 정작 데이터가 도착했을 때 다시 부르지 못한다 — 지연을 무시하면 오히려 늦어진다.
 *
 * 그래서 기준은 `런 종료 + NEXON_CACHE_TTL_MS` 이고, 화면을 열어 둔 채 그 시각이 되면
 * **타이머가 한 번 깨워** 부른다(다시 들어올 필요가 없다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 폭주하지 않기 위한 세 가지
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. **같은 캐릭터는 15분에 한 번.** `attemptedRef` 가 `캐릭터 + 15분 버킷` 으로 기억한다.
 *    리렌더·재조회·StrictMode 이중 마운트가 여기서 전부 걸린다. **폴링이 아니다.**
 * 2. **직렬 + 페이서.** 동시에 쏘면 초당 5콜 한도에 걸려 그 키가 쿨다운에 들어간다.
 * 3. **실패해도 조용하다.** 이 동기화는 사용자가 요청한 것이 아니라 화면이 알아서 하는
 *    일이라, 실패를 띄우면 아무것도 안 한 사람에게 오류창이 뜬다. 실패는 삼키고 다음
 *    버킷에서 다시 시도한다(수동 새로고침은 보스 현황 화면에 그대로 있다).
 */

/**
 * 런 종료 후 이만큼 지나야 부른다. **10분**(발주 지시 2026-08-24).
 *
 * 처음에는 넥슨 지연 창과 같은 15분이었다. 그런데 그 15분은 **최악 가정**이었다 —
 * 캐릭터가 로그아웃하거나 캐시샵에 들어가면 넥슨 쪽이 **즉시 갱신된다**(발주자 확인).
 * 보스를 다 돌고 나면 대개 그중 하나를 하므로, 15분을 꼬박 기다리는 것은 대부분의 경우
 * 그냥 늦는 것이다.
 *
 * 10분으로 당기면 로그아웃한 사람은 그 시점에 잡히고, 안 한 사람은 이번 호출에서 놓친다.
 * 놓친 경우를 위해 **화면에 새로고침 버튼**을 뒀다(같은 날 지시) — 그 버튼은 서버 캐시를
 * 건너뛰므로 15분 안에 다시 눌러도 실제로 새 값을 받는다.
 */
const SYNC_AFTER_END_MS = 10 * 60 * 1000;

/** 같은 캐릭터를 다시 부르기까지의 최소 간격 = 버킷 크기. */
const BUCKET_MS = NEXON_CACHE_TTL_MS;

export interface Target {
  readonly characterId: string;
  /** 이 시각이 지나야 부를 수 있다. */
  readonly dueAt: number;
}

/**
 * 끝났는데 아직 내 클리어가 없는 런 → 그 캐릭터. 가장 이른 `dueAt` 만 남긴다.
 *
 * ★ **보고 있는 주가 이번 주가 아니면 빈 배열이다** — 머리말 ★ 의 가드가 여기 있다.
 *   판정을 훅이 아니라 이 함수가 하는 이유: 대상 선정의 **유일한 자리**로 남겨 두면
 *   가드를 통과하는 다른 경로가 생기지 않고, 함수 하나를 직접 불러 가드를 증명할 수 있다.
 *
 * `export` 인 이유도 그것이다(검증용). 화면은 훅만 쓴다.
 */
export function collectTargets(
  runs: readonly TimetableRun[],
  viewedWeekKey: WeekKey,
  now: Date,
): readonly Target[] {
  if (viewedWeekKey !== getWeekKey(now)) return [];

  const earliest = new Map<string, number>();

  for (const run of runs) {
    if (run.clearedAt !== null) continue;
    if (run.characterId === null) continue;

    const endsAt =
      new Date(run.scheduledAt).getTime() + run.durationMinutes * 60 * 1000;
    const dueAt = endsAt + SYNC_AFTER_END_MS;
    const seen = earliest.get(run.characterId);
    if (seen === undefined || dueAt < seen) earliest.set(run.characterId, dueAt);
  }

  return [...earliest].map(([characterId, dueAt]) => ({ characterId, dueAt }));
}

/**
 * @param runs 보고 있는 주의 런 목록. `undefined` 면 아직 로딩 중이라 아무것도 하지 않는다.
 * @param viewedWeekKey **보고 있는** 주차. 이번 주가 아니면 호출이 한 건도 나가지 않는다
 *   (머리말 ★). 기본값을 두지 않는다 — 빼먹으면 가드가 조용히 사라지는 대신 타입 오류가
 *   나야 한다.
 */
export function usePostRunSync(
  runs: readonly TimetableRun[] | undefined,
  viewedWeekKey: WeekKey,
): void {
  const queryClient = useQueryClient();
  /** `캐릭터:버킷` 을 기억한다. state 가 아니라 ref 여야 한다 — 리렌더를 유발하면 안 된다. */
  const attemptedRef = useRef(new Set<string>());
  /**
   * 타이머가 깨울 때 effect 를 다시 돌리기 위한 값. 시각 자체는 쓰지 않고, **바뀌었다는
   * 사실**만으로 재실행을 유발한다.
   */
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (runs === undefined) return;

    const now = Date.now();
    const targets = collectTargets(runs, viewedWeekKey, new Date(now));
    const due = targets.filter((target) => now >= target.dueAt);

    /*
      아직 때가 안 된 것 중 **가장 이른 하나**에 타이머를 건다. 여러 개를 걸 이유가 없다 —
      그 시각이 되면 effect 가 다시 돌면서 나머지도 함께 다시 평가된다.
      +1초는 경계에서 `now >= dueAt` 이 아슬하게 거짓이 되어 헛깨우는 것을 막는다.
    */
    const next = targets
      .filter((target) => now < target.dueAt)
      .reduce<number | null>(
        (soonest, target) =>
          soonest === null || target.dueAt < soonest ? target.dueAt : soonest,
        null,
      );

    let timer: number | undefined;
    if (next !== null) {
      timer = window.setTimeout(
        () => {
          setTick((value) => value + 1);
        },
        next - now + 1000,
      );
    }

    const pending = due.filter((target) => {
      const key = `${target.characterId}:${String(Math.floor(now / BUCKET_MS))}`;
      if (attemptedRef.current.has(key)) return false;
      attemptedRef.current.add(key);
      return true;
    });

    if (pending.length > 0) {
      /*
        직렬로 돈다(머리말 2). `void` 로 띄우되 effect 정리와 경쟁하지 않는다 —
        마지막에 하는 일이 캐시 무효화뿐이고, 그건 언마운트 뒤에 일어나도 안전하다.
      */
      void (async () => {
        let changed = false;
        for (const target of pending) {
          try {
            // 서버가 그 캐릭터 계정의 키를 꺼내 쓴다(§2.1.2). 브라우저 키는 필요 없다.
            await paceNexonRequest(() =>
              syncCharacterScheduler({ characterId: target.characterId }),
            );
            changed = true;
          } catch {
            // 조용히 넘긴다(머리말 3). 다음 버킷에서 다시 시도된다.
          }
        }
        if (!changed) return;

        /*
          §2.4 Rule 5 — 무효화 대상 키를 명시한다. 동기화는 클리어를 만들므로
          시간표(클리어 표시) · 체크리스트(12칸) · 수익(결정석)이 함께 움직인다.
        */
        void queryClient.invalidateQueries({ queryKey: queryKeys.db.runs.root() });
        void queryClient.invalidateQueries({
          queryKey: queryKeys.db.bossPlans.root(),
        });
        void queryClient.invalidateQueries({ queryKey: queryKeys.db.income.root() });
      })();
    }

    return () => {
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runs, viewedWeekKey, queryClient, tick]);
}
