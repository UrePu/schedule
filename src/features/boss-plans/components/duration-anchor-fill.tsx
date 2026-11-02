"use client";

import { Scale } from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { Button } from "@/components/ui";
import {
  bossMinutesFromPlans,
  characterBossMinutes,
} from "@/lib/domain/boss-duration-distribute";
import {
  CALIBRATION_MIN_MINUTES,
  estimateCharacterDurations,
  normalizePartySize,
} from "@/lib/domain/boss-duration-estimate";
import { collapseToOnePlanPerBoss, sameBossClearKey } from "@/lib/domain/same-boss-clear";
import { cn } from "@/lib/utils";

import type { CharacterBossPlan } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * "나머지 보스도 이 기준으로 맞추기" — 캐릭터의 한 줄(분 + 그 줄의 인원) → 그 캐릭터의 나머지
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주(2026-10-21): *"부캐일때 어느 한 보스가 15분 걸리면 다른보스들 쫙 계산 가능하지?"*
 * 계산은 `estimateCharacterDurations`(`@/lib/domain/boss-duration-estimate` 머리말 5절):
 *     k        = 20×110 / (넣은 분 × 기준 줄 인원 × 본캐 배율(기준 보스))
 *     분(보스) = 20×110 / (그 줄 인원 × k × 본캐 배율(보스)) → 반올림 → 1~20
 *   각 줄의 분은 **그 줄의 인원으로 친 시간**이다(발주자 제보 2026-10-21 — 인원 3 인 줄의
 *   15분을 솔로로 읽어 "본캐의 1.08배"라고 말했다).
 *
 * ★ **명시적 동작이다.** 사람이 고쳐 둔 다른 보스의 값을 덮어쓰므로 묻지 않고 덮지 않는다:
 *   분을 고치면 계획 목록 바로 위 칸의 문장이 바뀌고 버튼이 켜진다 → "미리보기"(지금 → 새 값)
 *   → "이대로 저장".
 *   저장은 총 시간 나누기와 **같은 경로**(`PUT /api/boss-plans/duration/bulk`)다.
 * ★ 이 캐릭터의 계획 값만 바꾼다. 파티 묶음의 분은 건드리지 않는다 — 파티에서 고친 분은
 *   전파하지 않는다(돌먹, 같은 파일 머리말 5절).
 * ★ 기준 줄이 10~19분일 때만 켜진다(머리말 3절 — 짧으면 고정 시간에 묻혀 배율을 못 읽고,
 *   20은 상한이라 "20분 이상"일 수 있다). 부르는 쪽이 그 조건을 거른다.
 * ★ 대상은 이 캐릭터의 **켜진** 보스다(꺼 둔 보스는 목록에서 빠진 것이라 건드리지 않는다).
 *   배율을 모르는 보스(시세 미확인)는 그대로 두고 그 수를 말한다.
 * ★ 저장하지 않아도 화면 숫자는 이미 움직였다 — 비워 둔 보스의 흐린 숫자는 캐릭터 세기 k
 *   로 보정된다(머리말 3절). 이 동작이 하는 일은 **직접 넣어 둔 다른 값까지** 이 기준으로
 *   맞추는 것이다. 그래서 미리보기는 바뀌는 줄만 진하게 적는다.
 *
 * ── 자리: 계획 목록 바로 위, **언제나 차지하고 있는 한 칸** (발주자 2026-11-02) ──────────
 * *"버튼 위치가 자꾸 바뀌어서 누르기 귀찮아"* · *"맞추기는 상단에 그대로 고정이 맞는데"*.
 * 예전에는 고친 줄 바로 아래에 끼어들어, 다른 줄을 고치거나 값이 20·1 이 되어 사라질 때마다
 * 사이의 줄이 블록 높이만큼 움직였다. 위로 옮기기만 하면 나타날 때 줄 **전부**가 밀리고,
 * 겹쳐 띄우면 맨 윗줄을 고치는 순간 그 줄의 ± 를 덮는다. 그래서:
 *   ① 맞출 보스가 있으면(보스 단위 둘 이상) **언제나 그리고 높이가 고정**이다. 고칠 줄이 없을
 *      때도 안내 문장 + 잠긴 버튼으로 자리를 지키므로, 켜지고 꺼져도 줄 좌표는 1px 도 안 변한다.
 *      문장은 두 줄로 자른다 — 보스 이름이 맨 앞이라 잘리는 것은 뒷부분이다.
 *   ② 미리보기와 실패 문구는 이 칸에 **겹쳐 뜬다**(`absolute`). 흐름에 넣으면 줄이 밀린다.
 *      아래에 자리가 없으면 위로 펼친다. **페이지를 스크롤하지 않는다** — 올리면 방금 누른 버튼이
 *      따라 올라가, *"버튼이 또 위치가 바뀌잖아"*(2026-10-21)가 그대로 돌아온다.
 *      열려 있는 동안 화면의 나머지는 `inert` 다 — 가려진 칸에 Tab 으로 들어가 안 보이는 값을
 *      고치면 안 된다. Esc · 바깥 클릭 · 취소로 내려간다(저장 중에는 접지 않는다).
 *   ③ `sticky` — 줄을 고친 자리에서 위로 올라가지 않게 상단 바 바로 아래에 붙는다.
 *      `z-30`: 상단 바·모바일 탭 바(`z-40`)와 토스트(`z-50`) 아래, 줄 위. 모달은 top layer 다.
 *      ⚠️ 세로 480px 아래(가로로 눕힌 휴대폰)에서는 떼어 낸다 — 상단 바·탭 바·이 칸을 빼면
 *         줄 한 개 남짓만 남아(320px 높이에서 114px) 고칠 줄을 누를 수 없다.
 */

/** 아직 기준이 없을 때의 안내. 좁은 화면은 두 줄에 들어가는 쪽을 쓴다. */
const IDLE_SENTENCE = {
  short: `${String(CALIBRATION_MIN_MINUTES)}분 넘는 보스 하나의 실제 시간을 넣으면 나머지도 맞출 수 있습니다.`,
  full: `${String(CALIBRATION_MIN_MINUTES)}분 넘게 걸리는 보스 하나의 실제 시간을 넣으면 나머지도 맞출 수 있습니다.`,
} as const;

/**
 * 펼친 직후 저장 버튼이 잠겨 있는 시간. 맞추기와 저장이 **같은 자리**라 더블클릭의 두 번째 누름이
 * 그대로 저장이 된다 — 사람이 넣은 값까지 미리보기 없이 덮고 되돌릴 수 없다. 자리는 그대로
 * 두고(발주자 2026-10-21) 이 시간 동안만 잠근다. 일반적인 더블클릭 간격(500ms)보다 조금 길다.
 */
const SAVE_ARM_DELAY_MS = 600;

/** 미리보기 패널의 칸과의 간격 · 화면 가장자리 여백(px). */
const PANEL_GAP_PX = 6;
const PANEL_SCREEN_MARGIN_PX = 8;
/** 패널 높이 상한 — 화면의 40%, 그리고 22rem. 줄을 다 덮지 않는 값이다. */
const PANEL_SCREEN_RATIO = 0.4;
const PANEL_MAX_PX = 352;
/** 위아래 다 모자란 화면에서도 목록이 한 줄은 보이는 하한. */
const PANEL_MIN_PX = 64;

/**
 * 첫 버튼(맞추기)과 둘째 버튼(저장)의 **같은 폭** — 바뀌어도 옆의 닫기/취소가 그 자리에
 * 남는다. 160px: 두 문구(`이 기준으로 맞추기` · `이대로 저장(12개)` · `저장 중…`)가 14px 에서
 * 다 들어가고 320px 화면에서도 가로로 넘치지 않는다.
 */
const ACTION_WIDTH = "w-40 justify-center";

export interface DurationAnchor {
  readonly bossDifficultyId: string;
  readonly bossDisplayName: string;
  readonly minutes: number;
  /** 그 줄의 인원 — 그 분은 이 인원으로 친 시간이다(estimate 머리말 3절). */
  readonly partySize: number;
}

export interface AnchorFillPlan {
  /** 맞출 보스 전부 — 바뀌지 않는 줄도 "지금 → 새 값"으로 보여 준다. */
  readonly preview: readonly {
    readonly id: string;
    readonly name: string;
    readonly current: number;
    readonly next: number;
    readonly willWrite: boolean;
  }[];
  /** 그중 실제로 저장할 줄. */
  readonly writes: readonly { readonly id: string; readonly next: number }[];
  /** 시간을 계산할 수 없어 그대로 두는 보스 수. */
  readonly unknownCount: number;
}

export interface DurationAnchorFillProps {
  readonly characterName: string;
  /**
   * 맞출 수 있는 기준. 없으면 `null` — 칸은 그대로 있고 안내 문장과 잠긴 버튼을 그린다.
   * 켤지 말지는 부르는 쪽이 정한다(기준을 상태로 들고 있는 곳이 거기라, 꺼지면 함께 지운다).
   */
  readonly target: {
    readonly anchor: DurationAnchor;
    readonly fill: AnchorFillPlan;
  } | null;
  /** 바뀌는 보스만 넘어온다. */
  readonly onSave: (
    items: readonly { bossDifficultyId: string; durationMinutes: number }[],
  ) => void;
  readonly onDismiss: () => void;
  readonly isSaving: boolean;
  /** 이 동작의 마지막 저장 실패 문구. 없으면 `null`. */
  readonly saveError: string | null;
}

/** 기준 줄로 나머지를 계산한다. 맞출 보스가 없거나 기준을 쓸 수 없으면 `null`. */
export function planAnchorFill(
  plans: readonly CharacterBossPlan[],
  anchor: DurationAnchor,
): AnchorFillPlan | null {
  /*
    ★ 대상은 **보스 단위로 접힌** 켜진 계획이다(총 진행 시간·`!숙제` 와 같은 모집단 —
      `collapseToOnePlanPerBoss`). 접혀 빠진 같은 보스의 다른 난이도 줄과 기준 줄의 형제
      난이도는 건드리지 않는다 — 그 줄의 사람 값은 그대로 남는다.
  */
  const anchorBossKey =
    sameBossClearKey(anchor.bossDifficultyId) ?? `id:${anchor.bossDifficultyId}`;
  const targets = collapseToOnePlanPerBoss(
    plans.filter((plan) => plan.isActive),
  ).filter(
    (plan) =>
      (sameBossClearKey(plan.bossDifficultyId) ?? `id:${plan.bossDifficultyId}`) !==
      anchorBossKey,
  );
  /*
    ★ 각 줄의 분은 **그 줄의 인원으로 친 시간**이다(발주자 제보 2026-10-21: *"3인이라고
      표시 되어있는데 왜이러는거임?"*). 기준 줄의 인원으로 k 를 읽고, 다른 줄은 각자의 인원으로
      낸다 — 인원 칸이 1 이면 예전(솔로)과 같다.
  */
  const bossMinutes = bossMinutesFromPlans(plans);
  const result = estimateCharacterDurations(
    targets.map((plan) => ({
      bossDifficultyId: plan.bossDifficultyId,
      partySize: plan.defaultPartySize,
    })),
    {
      bossDifficultyId: anchor.bossDifficultyId,
      minutes: anchor.minutes,
      partySize: anchor.partySize,
    },
  );
  // 부르는 쪽이 10~19분만 넘기므로 닿지 않는다. 닿으면 할 말이 없다.
  if (result.kind !== "applied") return null;

  const preview = targets.flatMap((plan) => {
    const next = result.minutes.get(plan.bossDifficultyId);
    if (next === undefined) return [];
    return [
      {
        id: plan.bossDifficultyId,
        name: plan.bossDisplayName,
        current: characterBossMinutes(
          plan.bossDifficultyId,
          bossMinutes,
          plan.defaultPartySize,
        ),
        next,
        // 저장할 것: 저장된 값과 다를 때만(추정을 따르던 칸은 숫자로 굳는다).
        willWrite: plan.durationMinutes !== next,
      },
    ];
  });
  if (preview.length === 0) return null;
  return {
    preview,
    writes: preview.filter((row) => row.willWrite),
    unknownCount: result.unknownIds.length,
  };
}

export function DurationAnchorFill({
  characterName,
  target,
  onSave,
  onDismiss,
  isSaving,
  saveError,
}: DurationAnchorFillProps) {
  const slotRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  /**
   * 이 기준에서 저장을 눌렀는가. 실패 상태는 뮤테이션이 다음 저장까지 들고 있어서, 이것 없이는
   * 다른 줄의 새 기준을 펼치자마자 **아직 누르지도 않은 저장의 실패**를 말하게 된다.
   */
  const [saveAttempted, setSaveAttempted] = useState(false);
  /** 펼친 뒤 `SAVE_ARM_DELAY_MS` 가 지났는가. 지나기 전에는 잠긴 모양이고 눌러도 무동작이다. */
  const [saveArmed, setSaveArmed] = useState(false);
  const panelId = useId();

  /*
    기준이 바뀌면(다른 줄 · 닫힘 · 맞출 대상 없어짐 · 캐릭터 전환) 펼침과 실패를 처음 상태로 —
    칸은 그대로 두고 내용만 바꾸므로 `key` 로 새로 그리지 않는다(문장의 `role="status"` 가 계속
    살아 있어야 바뀐 말이 읽힌다). `useEffect` 가 아니라 렌더 중 조정이다(`DurationField` 와 같다).
  */
  const anchorKey =
    target === null
      ? null
      : `${target.anchor.bossDifficultyId}-${String(target.anchor.minutes)}`;
  const [syncedAnchorKey, setSyncedAnchorKey] = useState(anchorKey);
  if (anchorKey !== syncedAnchorKey) {
    setSyncedAnchorKey(anchorKey);
    setExpanded(false);
    setSaveAttempted(false);
  }
  const panelOpen = expanded && target !== null;

  /*
    상단 바 바로 아래에 붙는다. 바의 높이 토큰이 없고 폭에 따라 달라서(실측 49·55px) 잰다.
    ⚠️ **붙어 있을 때만.** 세로 480px 아래에서는 `position: relative` 라, `top` 이 남아 있으면 칸이
       그만큼 밀려 첫 줄을 덮는다(844×390 에서 47px). 그래서 지금의 `position` 을 보고 정하고,
       화면 회전까지 받도록 창 크기 변화도 듣는다.
  */
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const bar = document.querySelector<HTMLElement>("header.sticky");
    if (slot === null || bar === null) return;
    const apply = () => {
      slot.style.top =
        getComputedStyle(slot).position === "sticky"
          ? `${String(bar.offsetHeight)}px`
          : "";
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(bar);
    window.addEventListener("resize", apply);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", apply);
    };
  }, []);

  /*
    Shift+Tab 으로 올라간 칸이 이 칸 뒤로 들어가지 않게, 가려진 만큼만 내린다. 브라우저의 포커스
    스크롤이 끝난 뒤에 보도록 한 프레임 미룬다.
    ⚠️ 문서에 `scroll-padding-top` 을 주는 쉬운 길은 **쓰지 말 것.** 상단 바 안의 링크도 그 여백 위에
       있다고 읽혀, 바로 Tab 만 해도 페이지가 430px 올라간다(1280×800 실측, 2026-11-02).
  */
  useEffect(() => {
    const slot = slotRef.current;
    const list = slot?.parentElement;
    if (!slot || !list) return;
    let frame = 0;
    const reveal = (event: FocusEvent) => {
      const focused = event.target;
      if (!(focused instanceof Element) || slot.contains(focused)) return;
      // 키보드 포커스에만 — 일부 가린 ± 를 마우스로 누를 때 스크롤하면 클릭이 빗나가 사라진다.
      if (!focused.matches(":focus-visible")) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const covered =
          slot.getBoundingClientRect().bottom +
          PANEL_SCREEN_MARGIN_PX -
          focused.getBoundingClientRect().top;
        if (covered > 0) window.scrollBy(0, -covered);
      });
    };
    list.addEventListener("focusin", reveal);
    return () => {
      cancelAnimationFrame(frame);
      list.removeEventListener("focusin", reveal);
    };
  }, []);

  useEffect(() => {
    if (!panelOpen) return;
    const timer = setTimeout(() => setSaveArmed(true), SAVE_ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, [panelOpen]);

  /*
    패널을 **스크롤 없이** 화면 안에 둔다 — 아래에 들어가면 아래, 안 들어가면 위, 둘 다 모자라면
    넓은 쪽에 높이를 줄여 안쪽 스크롤로. 패널이 열린 채 페이지를 움직이면 칸의 자리가 바뀌므로 다시
    고른다. 패널은 흐름 밖이라 어느 쪽으로 펼쳐도 버튼과 줄은 움직이지 않는다.
  */
  useLayoutEffect(() => {
    const slot = slotRef.current;
    const panel = panelRef.current;
    const scroller = panel?.querySelector<HTMLElement>('[role="group"]');
    if (!panelOpen || !slot || !panel || !scroller) return;
    const place = () => {
      const slotRect = slot.getBoundingClientRect();
      const bar = document.querySelector("header.sticky")?.getBoundingClientRect();
      // `md` 이상에서는 탭 바가 `display: none` 이라 높이가 0 이다.
      const tabBar = document.querySelector("nav.fixed")?.getBoundingClientRect();
      const topLimit = (bar?.bottom ?? 0) + PANEL_SCREEN_MARGIN_PX;
      const bottomLimit =
        (tabBar !== undefined && tabBar.height > 0 ? tabBar.top : window.innerHeight) -
        PANEL_SCREEN_MARGIN_PX;
      const roomBelow = bottomLimit - slotRect.bottom - PANEL_GAP_PX;
      const roomAbove = slotRect.top - PANEL_GAP_PX - topLimit;

      const cap = Math.min(window.innerHeight * PANEL_SCREEN_RATIO, PANEL_MAX_PX);
      // 지금 잘려 있어도 내용 전체 높이를 낸다 — 안쪽 스크롤 칸이 잘린 만큼을 더한다.
      const natural = panel.offsetHeight - scroller.clientHeight + scroller.scrollHeight;
      const wanted = Math.min(natural, cap);
      const below =
        roomBelow >= wanted || (roomAbove < wanted && roomBelow >= roomAbove);

      panel.style.top = below ? "100%" : "auto";
      panel.style.bottom = below ? "auto" : "100%";
      panel.style.marginTop = below ? `${String(PANEL_GAP_PX)}px` : "0";
      panel.style.marginBottom = below ? "0" : `${String(PANEL_GAP_PX)}px`;
      panel.style.maxHeight = `${String(
        Math.min(cap, Math.max(below ? roomBelow : roomAbove, PANEL_MIN_PX)),
      )}px`;
    };
    place();
    window.addEventListener("scroll", place, { passive: true });
    window.addEventListener("resize", place);
    // 실패 문구가 들어오면 내용이 자란다.
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    return () => {
      window.removeEventListener("scroll", place);
      window.removeEventListener("resize", place);
      observer.disconnect();
    };
  }, [panelOpen]);

  /*
    패널에 가려질 수 있는 것을 잠근다(머리말 ②). 위로 펼치면 칸 위의 것이 가려지므로 목록만이
    아니라 `main` 에서 이 칸으로 내려오는 길의 형제 전부다.
  */
  useEffect(() => {
    const slot = slotRef.current;
    const scope = slot?.closest("main");
    if (!panelOpen || !slot || !scope) return;
    const locked: Element[] = [];
    for (
      let node: Element = slot;
      node !== scope && node.parentElement !== null;
      node = node.parentElement
    ) {
      for (const sibling of Array.from(node.parentElement.children)) {
        if (sibling === node) continue;
        sibling.setAttribute("inert", "");
        locked.push(sibling);
      }
    }
    return () => {
      for (const el of locked) el.removeAttribute("inert");
    };
  }, [panelOpen]);

  /*
    Esc · 바깥 클릭으로 접는다. 저장 중에는 접지 않는다 — 결과(실패 문구)가 나올 자리다.
    ★ `click` 인 이유: `pointerdown` 은 휴대폰에서 목록을 밀어 스크롤하려는 손가락에도 온다.
    ★ **캡처 단계**에서 본다. 토스트는 닫기를 누르면 곧바로 사라져, 버블 단계에서는 눌린 요소가
      이미 문서 밖이라 "바깥"으로 읽힌다.
    ★ 토스트(`aria-live`)는 바깥이 아니다 — 실패를 읽고 닫았는데 패널까지 접히면 다시 펼쳐야 한다.
  */
  useEffect(() => {
    const slot = slotRef.current;
    if (!panelOpen || isSaving || slot === null) return;
    const collapse = () => {
      setExpanded(false);
      setSaveAttempted(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") collapse();
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (slot.contains(target) || target.closest("[aria-live]") !== null) return;
      collapse();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("click", onClick, true);
    };
  }, [panelOpen, isSaving]);

  /** Enter 를 누르고 있으면 맞추기 → 저장으로 이어지지 않게 자동 반복을 버린다. */
  const ignoreEnterRepeat = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "Enter" && event.repeat) event.preventDefault();
  };

  /*
    ★ 시간 말로만 말한다 — 배율·"몇 배" 같은 내부 식은 보이지 않는다(발주 2026-10-21:
      *"몇배 약하니 뭐니 이런거 보여주지마 내부 식이야."*).
    ★ 줄과 떨어져 있으므로 **어느 보스 기준인지 이름으로** 말한다. 좁은 화면은 두 줄에 들도록
      뒷부분을 줄인 문장을 쓴다. 이름이 맨 앞이라 줄 수를 넘겨도 잘리는 것은 뒷부분이다.
    "솔로" 단정 금지 — 그 줄의 인원대로 말한다(1 이면 솔로, 아니면 `3인`).
  */
  let sentence: { readonly short: string; readonly full: string } = IDLE_SENTENCE;
  if (target !== null) {
    const { anchor, fill } = target;
    const party = normalizePartySize(anchor.partySize);
    const basis = `${anchor.bossDisplayName} ${party === 1 ? "솔로" : `${String(party)}인`} ${String(anchor.minutes)}분 기준으로`;
    sentence = {
      short: `${basis} 나머지 ${String(fill.preview.length)}개를 맞출까요?`,
      full: `${basis} ${characterName}의 나머지 보스 ${String(fill.preview.length)}개 시간을 맞출까요?`,
    };
  }

  return (
    <div
      ref={slotRef}
      className="relative z-30 flex min-w-0 flex-col gap-2 rounded-md border border-border-strong bg-surface px-3 py-2 shadow-medium md:flex-row md:items-center md:justify-between md:gap-4 [@media(min-height:480px)]:sticky"
    >
      <p
        role="status"
        className={cn(
          "flex h-[2lh] min-w-0 items-center gap-2 text-body-sm md:flex-1",
          target === null ? "text-ink-muted" : "text-ink",
        )}
      >
        <Scale
          aria-hidden
          size={16}
          className={cn("shrink-0", target === null ? "text-ink-placeholder" : "text-primary")}
        />
        <span title={sentence.full} className="line-clamp-2 min-w-0 break-keep">
          <span className="sm:hidden">{sentence.short}</span>
          <span className="hidden sm:inline">{sentence.full}</span>
        </span>
      </p>

      {/*
        ── 버튼 줄은 **한 자리에 고정**한다 (발주자 2026-10-21) ─────────────────────
        *"수정하고나면 이걸로 맞출까요? 하고 뜨는거 확인 누르면 밑에 주르륵 뜨면서 버튼이 또
        위치가 바뀌잖아"*. 평소에도 잠긴 채 이 자리에 있고, 첫 버튼(맞추기)과 둘째 버튼(저장)은
        **같은 자리 · 같은 폭**(`ACTION_WIDTH`)이라 누른 자리에서 손을 안 움직이고 확인한다.
      */}
      <div className="flex flex-wrap items-center gap-2 md:shrink-0 md:flex-nowrap">
        {panelOpen ? (
          <Button
            size="sm"
            /*
              ★ 잠금은 `disabled` 가 아니다. 키보드로 펼친 사람의 포커스가 잠긴 버튼에서 튕겨 나가면
                안 된다. 그래서 모양만 잠그고(`disabled` 와 같은 40%), 포인터를 통과시키고, 키 입력은
                아래에서 버린다. 폭과 자리는 그대로다.
            */
            className={cn(ACTION_WIDTH, !saveArmed && "pointer-events-none opacity-40")}
            aria-disabled={saveArmed ? undefined : true}
            aria-expanded
            aria-controls={panelId}
            disabled={isSaving || target.fill.writes.length === 0}
            onKeyDown={ignoreEnterRepeat}
            onClick={() => {
              if (!saveArmed) return;
              setSaveAttempted(true);
              onSave(
                target.fill.writes.map((row) => ({
                  bossDifficultyId: row.id,
                  durationMinutes: row.next,
                })),
              );
            }}
          >
            {isSaving ? "저장 중…" : `이대로 저장(${String(target.fill.writes.length)}개)`}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            className={ACTION_WIDTH}
            aria-expanded={false}
            disabled={target === null}
            onKeyDown={ignoreEnterRepeat}
            onClick={() => {
              setSaveArmed(false);
              setExpanded(true);
            }}
          >
            이 기준으로 맞추기
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={isSaving || target === null}
          onClick={onDismiss}
        >
          {panelOpen ? "취소" : "닫기"}
        </Button>
      </div>

      {/*
        ── 미리보기는 이 칸에 **겹쳐** 뜬다 ─────────────────────────────────────────
        방향과 높이는 위 `place` 가 정한다(화면의 40% 안쪽 + 안쪽 스크롤, 끝에 닿으면 페이지로
        이어진다). 실패 문구도 여기에 둔다 — 버튼을 밀지 않고, 목록을 스크롤한 뒤에도 보인다.
      */}
      {panelOpen ? (
        <div
          ref={panelRef}
          id={panelId}
          className="absolute inset-x-0 flex flex-col gap-2 rounded-md border border-border-strong bg-surface p-3 shadow-overlay"
        >
          {saveAttempted && saveError !== null ? (
            <p role="alert" className="shrink-0 text-body-sm text-error">
              {saveError}
            </p>
          ) : null}
          <div
            role="group"
            aria-label="바뀌는 시간 미리보기"
            tabIndex={0}
            className="flex min-h-0 flex-col gap-2 overflow-y-auto focus-visible:outline-2 focus-visible:outline-primary"
          >
            <p className="text-body-sm text-ink-muted">
              미리보기 — 저장하면 직접 고쳐 둔 값도 이 값으로 바뀌고, 비워 둔 칸은 지금 예상값이
              그대로 저장됩니다. 파티 묶음에 정해 둔 분은 바뀌지 않습니다.
              {target.fill.unknownCount > 0
                ? ` 시간을 계산할 수 없는 ${String(target.fill.unknownCount)}개는 그대로 둡니다.`
                : ""}
            </p>
            <ul className="flex flex-col gap-1">
              {target.fill.preview.map((row) => (
                <li
                  key={row.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 rounded-md border border-border px-2.5 py-1.5"
                >
                  <span className="min-w-0 truncate text-body-sm text-ink">{row.name}</span>
                  <span className="text-body-sm text-ink-muted tabular-nums">
                    {row.current}분 →{" "}
                    {/* 숫자가 실제로 달라지는 줄만 진하게. 값이 굳기만 하는 줄은 위 문장이 말한다. */}
                    <span
                      className={cn(row.next !== row.current && "font-semibold text-ink")}
                    >
                      {row.next}분
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
