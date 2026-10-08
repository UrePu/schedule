"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { BossIcon } from "@/components/domain";
import type { HomeworkCardView } from "@/features/share/server/homework-card-view";
import { cn, formatMesoCompact } from "@/lib/utils";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `/s/<토큰>` 의 캐릭터 목록 — **얼굴에 올리면 말풍선이 뜬다**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-10-08): *"밑에 저런 쓸모없는 설명빼고 원복한다음에 호버했을때만 상세
 * 보이게 해… 12건남음 얼굴 상세 어쩌고는 관심없어.. 말풍선처럼 위에 떠야지 저게 뭐야"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️⚠️ **여기까지 온 길 — 두 번 틀렸고 두 번 다 측정이 뒤집었다. 지우지 않는다.**
 * ─────────────────────────────────────────────────────────────────────────────
 * 1. 처음에는 상세를 **묶음 바닥에 고정**해 띄웠고, 주석에 이렇게 적었다:
 *    ~~바닥 얼굴 한 줄을 잠깐 덮는다. 떠 있는 동안만이고, 안 덮으려면 묶음마다 빈 줄을
 *      상시로 비워 둬야 하는데 그 값이 더 비싸다.~~
 *    **측정이 뒤집었다**: 폭 1024px 에서 얼굴 12개가 한 줄에 다 서므로 바닥이 곧 그 줄이고,
 *    95개 전부 `covers: true` · `상세.top − 얼굴.bottom = −33px` → 64px 아이콘의 **아래
 *    52%**가, **호버 중인 그 얼굴까지** 가려졌다. 폭 360px 에서는 두 줄로 접히며 15 → 31개.
 * 2. 그래서 바닥에 `h-9` 짜리 칸을 **상시로 비워 두고**(기본값 `12건 남음 · …`) 그 위에만
 *    겹치게 고쳤다. 가림은 세 폭 모두 0 이 됐지만, **발주자가 그 모양을 거부했다** —
 *    *"저런 쓸모없는 설명"*, *"저게 뭐야"*. 숫자를 통과시키면서 화면을 망친 것이다.
 * 3. 그래서 말풍선으로 바꾸면서, *"얼굴을 덮지 말 것"* 을 지키려고 세로 기준을 **얼굴 격자
 *    전체**에 묶었다. 그때 적은 근거가 이것이다:
 *    ~~세로는 "얼굴 격자 바로 위"에 둔다. 개별 줄 위가 아니다. 줄마다 띄우면 두 번째 줄의
 *      말풍선이 첫 번째 줄 얼굴을 덮는다 — 줄 간격 8px 에 말풍선은 꼬리까지 약 44px 이라
 *      36px 이 모자란다. 격자 위에 두면 어느 얼굴을 올려도 얼굴을 덮지 않는다.~~
 *    **폭 1024px 에서는 얼굴 12개가 한 줄이라 둘이 같은 자리여서 이 결함이 보이지 않았다.**
 *    폭 400px 에서는 다섯 개씩 **세 줄**로 흐르는데, 둘째·셋째 줄을 올려도 말풍선은 격자
 *    맨 위에 떴다 — 트리거에서 세로로 **100px 넘게** 떨어진 자리이고, 꼬리가 아래를
 *    가리키는데 **그 아래에 트리거가 없다.** 교차 검증이 전에 잡았던 *"지시 대상이
 *    사라진다"* 가 **좁은 폭에서만 되살아난 것**이다. 그리고 카톡에서 눌러 들어오는 사람은
 *    대부분 폰이라, 깨지는 쪽이 **주된 사용 환경**이었다.
 * ★ 남는 교훈 **세 가지**: **바닥 고정은 틀렸다**(1번의 측정) · **자리를 비워 두는 것으로
 *   사는 것도 답이 아니다**(2번의 거부) · **덮지 않으려고 지시 대상을 잃으면 더 나쁘다**
 *   (3번). 말풍선은 **트리거를 따라다녀야** 한다 — 가로도 세로도.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **왜 이 조각만 클라이언트인가 — CSS 로는 성립하지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 직전 라운드 주석의 *"이 화면은 서버 컴포넌트로 남는다"* 는 **이 모양에서는 버티지 못한다.**
 * 계산해 보면 이유가 분명하다:
 *   가장 긴 문장 `익스트림 선택받은 세렌 · 1인 · 1인당 18억 4,000만` 은 14px 에서 **약
 *   300px**, 얼굴은 56px 다. 트리거 가운데에 붙이면(`left-1/2 -translate-x-1/2`) 좌우로
 *   각각 **(300−56)/2 ≈ 122px** 씩 삐져나온다. 폭 400px 에 한 줄 다섯 개가 서므로 맨
 *   왼쪽·맨 오른쪽 얼굴은 **반드시** 화면 밖이다. **충돌 회피는 측정 없이는 못 하고,
 *   측정은 CSS 가 할 수 없는 일이다.**
 * ★ 그래서 **캐릭터 묶음 하나가 클라이언트 컴포넌트 하나**다. 얼굴 95개를 각각 경계로
 *   만들지 않는다 — 말풍선은 묶음마다 **하나**이고, 어느 얼굴이 켜졌는지만 들고 자리를 옮긴다.
 *   (8명 → 경계 8개. 얼굴마다였다면 95개였다.)
 * ★ **페이지의 나머지는 서버 컴포넌트로 남는다.** 여기로 내려오는 것은 이미 포맷이 끝난
 *   문자열 묶음(`rows`)뿐이다. §2.4 Rule 1 의 *"서버가 DB 행을 props 로 넘기지 말 것"* 은
 *   **뮤테이션이 있는 화면**의 규칙이다 — 그 규칙이 막는 사고는 "`invalidateQueries` 가
 *   prop 을 못 건드려 화면이 낡는다"는 것인데, 이 화면에는 쓰기도, 쿼리 캐시도, 새로고침
 *   버튼도 없다. 토큰 하나가 내용을 정하고 그 내용은 요청마다 새로 서버에서 온다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **자리 계산은 `li` 안으로 가둔다 — 그래서 화면 밖으로 나갈 수가 없다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `li` 는 이미 페이지 여백 안에 있다. 말풍선의 좌우를 `li` 안쪽으로 clamp 하면 **구조적으로**
 * 화면을 넘지 못한다(뷰포트를 따로 재지 않아도 된다는 뜻이다).
 * ★ **세로는 트리거 기준이다 — 올린 그 얼굴 바로 위**(2026-10-08 재작업). 위 ⚠️⚠️ 3번이
 *   왜 격자 기준이 틀렸는지의 기록이다. 기준이 트리거이므로 말풍선과 꼬리는 **어느 폭에서도
 *   그 얼굴을 떠나지 않는다.**
 *   - **윗줄 얼굴들을 잠깐 덮는 것은 허용**이다. 툴팁이 원래 그렇게 동작하고, 떠 있는
 *     동안뿐이다. 바닥 고정 띠(1번)와 다른 점은 **상시가 아니라는 것**과 **가리는 대상이
 *     읽으려는 그 얼굴이 아니라는 것**이다.
 *   - 다만 **호버 중인 바로 그 얼굴은 덮지 않는다.** 무엇을 올렸는지 못 보게 되기 때문이고,
 *     이것이 1번 측정에서 실제로 터진 증상이다. `TRIGGER_GAP` 이 그 보증이다.
 *   - **`li` 밖으로 삐져나가도 된다.** 첫 줄 얼굴은 위에 자리가 없다 — 툴팁이 윗 카드를
 *     조금 겹치는 것은 정상이고, `z-50` 이 위에 오게 한다(`li` 에는 `overflow` 가 없다).
 *   - **화면 위로 나갈 때만 아래로 뒤집는다.** 뒤집으면 꼬리도 함께 위를 향한다.
 *     ⚠️ 실측(2026-10-08): 이 분기는 **거의 안 탄다.** 앱 머리글이 `sticky top-0` 으로 위
 *        56px 쯤을 차지해 얼굴이 뷰포트 맨 위까지 올라올 일이 없기 때문이다. 그래도 지우지
 *        않는다 — 머리글이 사라지거나 화면이 아주 낮은 기기에서 이 분기가 유일한 보호다.
 *        (검증은 마우스 대신 **포커스**로 연다. 맨 위 얼굴은 머리글에 가려 포인터가 닿지
 *         않아서다 — 그 자체가 이 분기가 안 타는 이유의 증거이기도 하다.)
 *   - 어느 얼굴 것인지는 **두 겹**으로 말한다: 꼬리가 그 얼굴의 가로 가운데를 가리키고,
 *     그 얼굴에 primary 링이 들어온다.
 *
 * ⚠️ 금액은 **1인당 수령액**(`shareMeso`)이지 솔로가가 아니다. 인원수도 그 금액을 실제로
 *    나눈 수 그대로다(`RemainingBoss.defaultPartySize` — `null` 접기는 조회 쪽에서 끝났다).
 *    여기서 다시 나누거나 `?? 1` 하지 말 것.
 * ⚠️ `title` 속성은 **쓰지 않는다.** 데스크톱에서 네이티브 툴팁과 말풍선이 같은 문장을
 *    동시에 띄웠다. 보조기기 몫은 버튼의 `aria-label` 이 진다.
 */

/** 말풍선과 `li` 테두리 사이 최소 여백. 좌우 clamp 의 바닥값이다. */
const EDGE_PAD = 8;
/** 꼬리 높이. 말풍선 모서리에서 이만큼 바깥으로 나간다. */
const CARET = 6;
/**
 * 말풍선 모서리와 **트리거** 사이 간격. 꼬리(6px)가 이 안에 들어가고 2px 이 남는다.
 * ★ 이 값이 *"호버 중인 그 얼굴은 덮지 않는다"* 의 보증이다 — 측정의 합격 기준이기도 하다.
 */
const TRIGGER_GAP = CARET + 2;
/** 뒤집기 판단용 화면 위 여유. 이보다 위로 올라가면 아래로 뒤집는다. */
const VIEWPORT_MARGIN = 4;
/** 꼬리가 말풍선 밖으로 나가지 않도록 하는 안쪽 여백. */
const CARET_INSET = 14;

type Row = HomeworkCardView["rows"][number];

export function ShareCharacterList({
  rows,
}: {
  readonly rows: HomeworkCardView["rows"];
}) {
  return (
    <ul className="flex flex-col gap-3">
      {rows.map((row) => (
        <ShareCharacterRow key={row.characterName} row={row} />
      ))}
    </ul>
  );
}

/**
 * 캐릭터 한 묶음 — **이름 · 남은 금액 / 얼굴 전부.** 바닥 안내 줄은 없다(발주 거부).
 *
 * ★ 얼굴은 `lg`(48px)를 `cn`(tailwind-merge)이 덮어 **56 / 64px** 로 선다. 받아 오는 해상도는
 *   그대로다 — `BossIcon` 의 `SOURCE_HINT_PX` 가 96px 이라 64px 자리까지 모자라지 않는다.
 * ★ 트리거는 `<button type="button">` 이다. WebKit 이 탭에 `:hover` 를 붙이는 조건은
 *   **"그 요소가 클릭 가능한가"**(클릭 핸들러 또는 `cursor: pointer`)인데 `<span>` 은 둘 다
 *   없어 호버·포커스 두 경로가 **동시에** 막힐 수 있었다. 버튼은 네이티브로 클릭 가능하고
 *   탭에서 포커스를 받으므로 두 경로가 함께 죽지 않는다.
 *   ⚠️ **실제 iOS 기기에서는 실측하지 못했다.** 적어 둔 것은 WebKit 의 공개된 조건과
 *      `<button>` 이 그것을 만족한다는 사실이지 *"iPhone 에서 뜨는 것을 봤다"* 가 아니다.
 * ★ 켜는 것은 `onFocus` 이지 `:focus-visible` 이 아니다 — 손가락 탭은 `focus-visible` 을
 *   띄우지 않는 브라우저가 많아 그걸로 걸면 탭에서 아무것도 안 뜬다. 아웃라인만
 *   `focus-visible` 로 둬서 마우스 클릭에 굵은 테를 남기지 않는다.
 */
function ShareCharacterRow({ row }: { readonly row: Row }) {
  const [active, setActive] = useState<number | null>(null);

  const liRef = useRef<HTMLLIElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const caretRef = useRef<HTMLSpanElement>(null);
  const btnRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const close = useCallback(() => {
    setActive(null);
  }, []);

  /*
    자리는 **그린 뒤에** 잰다. 말풍선 폭이 글자에 따라 달라지므로 그리기 전에는 알 수 없다 —
    그래서 `useLayoutEffect` 로 첫 페인트 전에 재서 옮긴다(깜빡임 없음).
    ★ **좌표를 state 에 담지 않고 DOM 에 직접 쓴다.** 담으면 "재고 → setState → 또 그린다"로
      렌더가 한 번 더 돌고, `react-hooks/set-state-in-effect` 가 정확히 그걸 막는다. 이펙트가
      해야 할 일은 *외부 시스템(여기서는 DOM)을 최신 상태에 맞추는 것*이고, 자리 잡기는 그
      정의에 그대로 들어맞는다.
    ★ 말풍선에 `key={active}` 를 준다 — 켜질 때마다 **새 노드**로 올라오므로 `visibility:
      hidden` 인 초기 모습에서 시작한다. 같은 노드를 재사용하면 React 가 모르는 사이에
      바뀐 인라인 스타일(이전 자리)이 한 프레임 동안 남아 말풍선이 튄다.
  */
  useLayoutEffect(() => {
    if (active === null) return;
    const li = liRef.current;
    const bubble = bubbleRef.current;
    const caret = caretRef.current;
    const btn = btnRefs.current[active];
    if (li === null || bubble === null || caret === null || btn == null) {
      return;
    }

    const liRect = li.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const width = bubble.offsetWidth;
    const height = bubble.offsetHeight;

    /** 트리거 가로 중심 — `li` 로컬. 꼬리가 가리켜야 하는 지점이다. */
    const center = btnRect.left + btnRect.width / 2 - liRect.left;

    /*
      좌우: 가운데 정렬을 시도하고 **`li` 안쪽으로 clamp**. `li` 가 이미 페이지 여백 안이라
      이 한 번의 clamp 가 곧 "화면 밖으로 안 나간다"의 보증이다.
      ⚠️ `Math.max(EDGE_PAD, …)` 를 바깥에 한 번 더 씌운다 — 말풍선이 `li` 보다 넓은
         극단에서 `maxLeft < EDGE_PAD` 가 되어 clamp 가 뒤집히는 것을 막는다.
    */
    const maxLeft = Math.max(EDGE_PAD, liRect.width - EDGE_PAD - width);
    const left = Math.min(Math.max(center - width / 2, EDGE_PAD), maxLeft);

    /*
      세로: **트리거 바로 위.** `li` 밖으로 나가도 clamp 하지 않는다 — 첫 줄 얼굴은 위에
      자리가 없고, 윗 카드를 조금 겹치는 것이 정상이다(`z-50` — 그 값의 근거는 아래 ⚠️).
      ⚠️ 뒤집기 판단은 **`li` 가 아니라 뷰포트** 기준이다. `li` 를 기준으로 삼으면 첫 줄
         얼굴마다 뒤집혀 아랫줄 얼굴을 덮게 된다 — 화면 위에 자리가 멀쩡히 있는데도.
    */
    const flipped = btnRect.top - height - TRIGGER_GAP < VIEWPORT_MARGIN;
    const top = flipped
      ? btnRect.bottom - liRect.top + TRIGGER_GAP
      : btnRect.top - liRect.top - height - TRIGGER_GAP;

    const caretX = Math.min(
      Math.max(center - left, CARET_INSET),
      Math.max(CARET_INSET, width - CARET_INSET),
    );

    bubble.style.left = `${String(Math.round(left))}px`;
    bubble.style.top = `${String(Math.round(top))}px`;
    bubble.style.visibility = "visible";
    caret.style.left = `${String(Math.round(caretX - 6))}px`;
    /* 뒤집히면 꼬리도 **함께 위를 향한다** — 안 그러면 꼬리가 허공을 가리킨다. */
    caret.style.top = flipped ? `${String(-CARET)}px` : "auto";
    caret.style.bottom = flipped ? "auto" : `${String(-CARET)}px`;
  }, [active]);

  /*
    ★ `Esc` 로 닫고, **스크롤되면 닫는다.** 자리를 그릴 때 한 번 잰 좌표라 스크롤하면
      꼬리가 엉뚱한 곳을 가리킨다. 다시 재는 대신 닫는 쪽을 고른 이유: 말풍선은 손이
      얼굴 위에 있을 때만 의미가 있고, 스크롤은 손이 떠났다는 신호다.
    ⚠️ `capture: true` — 페이지가 `window` 가 아니라 안쪽 요소를 스크롤하는 날에도 잡힌다.
  */
  useEffect(() => {
    if (active === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("scroll", close, { capture: true, passive: true });
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", close, { capture: true });
    };
  }, [active, close]);

  const activeBoss = active === null ? null : (row.bosses[active] ?? null);

  return (
    <li
      ref={liRef}
      className="relative flex flex-col gap-3 rounded-lg border border-border border-l-4 border-l-primary bg-surface p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-headline text-subhead text-ink">
          {row.characterName}
        </span>
        <span className="font-headline text-subhead text-primary">
          {row.mesoLabel}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {row.bosses.map((boss, index) => {
          /* 문장은 **한 번만** 만든다 — 보이는 말풍선과 접근명이 같은 변수를 쓴다. */
          const detail = bossDetail(boss);
          return (
            <button
              /*
                ⚠️ 키에 **순번을 섞는다.** 이 목록은 자르지 않아 캐릭터당 12~13개가 들어온다 —
                   id 하나로 잡다가 중복이 생기면 React 가 조용히 한 칸을 덮어쓴다.
              */
              key={`${boss.bossDifficultyId}-${String(index)}`}
              ref={(node) => {
                btnRefs.current[index] = node;
              }}
              type="button"
              className="group inline-flex cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              aria-label={detail}
              onPointerEnter={() => {
                setActive(index);
              }}
              onPointerLeave={close}
              onFocus={() => {
                setActive(index);
              }}
              onBlur={close}
            >
              <BossIcon
                bossDifficultyId={boss.bossDifficultyId}
                difficulty={boss.difficulty}
                size="lg"
                /*
                  링은 말풍선이 **어느 얼굴 것인지**를 말하는 두 번째 겹이다(꼬리가 첫 번째).
                  상태로 켜므로 말풍선과 **항상 같은 얼굴**을 가리킨다.
                */
                className={cn(
                  "size-14 ring-offset-surface sm:size-16",
                  active === index && "ring-2 ring-primary ring-offset-2",
                )}
              />
            </button>
          );
        })}
      </div>

      {/*
        말풍선 — 묶음마다 **하나**다. 켜진 얼굴만 바뀌고 자리가 옮겨 다닌다.
        색은 공용 툴팁과 같은 토큰 쌍(`bg-ink` / `text-neutral-50`)이라 라이트·다크 양쪽에서
        이미 검증된 조합이고, 글자는 **14px**(`text-body-sm`) — 이 화면의 바닥선이다.
        `pointer-events-none` 이라 말풍선이 마우스를 가로채 깜빡이게 하지 않는다.
      */}
      {activeBoss === null ? null : (
        <div
          key={active}
          ref={bubbleRef}
          role="presentation"
          aria-hidden
          /*
            ⚠️ `z-50` 인 이유는 **앱 머리글이 `sticky top-0 z-40`** 이기 때문이다(측정
               2026-10-08). `z-20` 이면 머리글 바로 아래 얼굴의 말풍선이 **머리글 뒤로
               숨는다** — 떠 있는데 안 보이는, 알아채기 가장 어려운 모양이다. 잠깐 뜨는
               말풍선이 머리글을 살짝 겹치는 쪽이 가려지는 쪽보다 낫다.
          */
          className="pointer-events-none absolute z-50 w-max max-w-full whitespace-nowrap rounded-md bg-ink px-3 py-1.5 text-body-sm text-neutral-50 shadow-overlay"
          style={{ left: 0, top: 0, visibility: "hidden" }}
        >
          {bossDetail(activeBoss)}
          {/* 꼬리 — 말풍선 안쪽으로 따로 clamp 해서 모서리 밖으로 삐져나오지 않는다. */}
          <span
            ref={caretRef}
            aria-hidden
            className="absolute size-3 rotate-45 rounded-xs bg-ink"
            style={{ left: 0, bottom: -CARET, top: "auto" }}
          />
        </div>
      )}
    </li>
  );
}

/** `하드 카링 · 3인 · 1인당 10억 2,600만` — 말풍선과 접근명이 **같은 문자열**을 쓴다. */
function bossDetail(boss: Row["bosses"][number]): string {
  const name = boss.isSeason ? `${boss.koreanName} (시즌)` : boss.koreanName;
  return `${name} · ${String(boss.partySize)}인 · 1인당 ${formatMesoCompact(boss.shareMeso)}`;
}
