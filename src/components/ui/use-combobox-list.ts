"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/**
 * 검색창 + 후보 목록을 **콤보박스**로 묶는 키보드 조작 (발주 요청, 2026-10-06).
 *
 * 원문: *"이거 검색후 키보드로 바로 조작가능하게좀 해줘 불편"*
 * (검색창에 `하카` 를 치면 아래에 `하드 카링` 한 줄이 나오는데, 그걸 담으려면
 *  마우스로 `+` 를 눌러야 했다.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 포커스는 **입력칸에 머문다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 후보 목록으로 포커스를 옮기는 설계는 "한 글자 더 치기"를 막는다 — `하카` 로 좁히고
 * 다시 `하스` 를 치는 것이 이 화면의 보통 사용이다. 그래서 ARIA 콤보박스 규약을 쓴다:
 * 포커스는 입력에 두고, 하이라이트는 `aria-activedescendant` 로 가리킨다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 한글 IME — `Enter` 한 번으로 담긴다
 * ─────────────────────────────────────────────────────────────────────────────
 * `하카` 를 치면 마지막 글자 `카` 는 **아직 조합 중**이다. 그 상태의 `Enter` 는 IME 에게는
 * "조합 확정", 우리에게는 "담기"다. 둘 중 하나만 고르면 반드시 한쪽이 깨진다:
 *
 *   ① `isComposing` 이면 그냥 무시 → 사용자는 **`Enter` 를 두 번** 눌러야 한다.
 *      발주 요구가 명시적으로 거절한 길이다.
 *   ② 조합 중에도 그 자리에서 담는다 → 우리가 `setQuery("")` 로 입력칸을 비운 **뒤에**
 *      IME 가 확정 글자를 써 넣어 검색창이 `하카` 로 되살아난다.
 *
 * 그래서 **조합 중 `Enter` 는 예약만 하고(`pendingPickRef`), 실제 담기는 그 `Enter` 의
 * `keyup` 에서** 한다. `keyup` 은 `compositionend` 와 IME 의 마지막 `input` 이 모두 끝난
 * 뒤에 오므로, 그때 비운 검색어는 다시 채워지지 않는다. 사용자가 누른 횟수는 한 번이다.
 *
 * 조합 중 **방향키는 가로채지 않는다** — 그것은 IME 후보창의 것이다(일본어·중국어 변환).
 *
 * ⚠️ 알려진 한계: `Enter` 조합 확정에 `keydown` 을 **두 번** 보내는 브라우저(일부 Safari)
 *    에서는 두 번째 `keydown`(`isComposing=false`)이 먼저 담는다. 보스는 바르게 담기고,
 *    검색창이 확정 글자로 되살아나는 것만 남는다 — 틀린 결과가 아니라 군더더기라서
 *    여기서 더 복잡한 장치를 두지 않았다.
 */

export interface ComboboxListOptions<TItem> {
  /** 후보 목록. **배열 순서가 곧 `↓` `↑` 순서다.** */
  readonly items: readonly TItem[];
  /** 줄 `id` 의 뿌리. 호출부의 `useId()` 결과를 넘긴다. */
  readonly baseId: string;
  /** 항목의 안정 식별자. 줄 `id` 와 하이라이트 추적에 쓰인다. */
  readonly getItemKey: (item: TItem) => string;
  /**
   * `Enter` 가 고른 항목. **줄의 버튼이 하는 일과 같은 함수를 넘겨야 한다** —
   * 두 벌이 되면 키보드와 마우스가 다른 일을 하기 시작한다.
   */
  readonly onPick: (item: TItem) => void;
  /** `Esc` 가 검색어를 비우는 길. 검색어가 이미 비어 있으면 호출되지 않는다. */
  readonly onClearQuery: () => void;
  /**
   * 지금 검색어. **바뀌면 하이라이트가 첫 줄로 돌아간다** — 옛 위치가 남으면
   * 사용자가 보고 있는 줄과 `Enter` 가 담는 줄이 달라진다.
   */
  readonly query: string;
  /**
   * 후보 `<ul>` 의 접근성 이름. `<label>` 은 입력칸에 붙으므로 listbox 는 이름이
   * 없는 채로 남는다 — 스크린리더가 "목록"만 읽는 상태를 만들지 않는다.
   */
  readonly listboxLabel: string;
  readonly disabled?: boolean;
}

/** 검색 `<input>` 에 그대로 펼치는 속성. */
export interface ComboboxInputProps {
  readonly role: "combobox";
  readonly "aria-expanded": boolean;
  readonly "aria-controls": string | undefined;
  readonly "aria-activedescendant": string | undefined;
  readonly "aria-autocomplete": "list";
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly onKeyUp: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly onCompositionStart: () => void;
  readonly onCompositionEnd: () => void;
}

/** 후보 `<ul>` 에 그대로 펼치는 속성. */
export interface ComboboxListboxProps {
  readonly id: string;
  readonly role: "listbox";
  readonly "aria-label": string;
}

/** 후보 한 줄에 그대로 펼치는 속성. */
export interface ComboboxOptionProps {
  readonly id: string;
  readonly role: "option";
  readonly "aria-selected": boolean;
}

export interface ComboboxList {
  /** 하이라이트된 줄. 후보가 없으면 `-1`. */
  readonly activeIndex: number;
  readonly inputProps: ComboboxInputProps;
  readonly listboxProps: ComboboxListboxProps;
  /** `index` 번째 줄의 `role="option"` 속성. 렌더 순서와 같은 인덱스를 넘길 것. */
  readonly getOptionProps: (index: number) => ComboboxOptionProps;
}

export function useComboboxList<TItem>({
  items,
  baseId,
  getItemKey,
  onPick,
  onClearQuery,
  query,
  listboxLabel,
  disabled = false,
}: ComboboxListOptions<TItem>): ComboboxList {
  const listboxId = `${baseId}-listbox`;

  /**
   * 하이라이트는 **인덱스가 아니라 키**로 들고 있는다. 목록은 필터·정렬로 흔들리는데
   * 인덱스를 들고 있으면 같은 숫자가 다음 렌더에 다른 보스를 가리킨다.
   * `null` 은 "아직 안 움직였다" = 첫 줄이다.
   */
  const [activeKey, setActiveKey] = useState<string | null>(null);

  /*
    검색어가 바뀌면 하이라이트를 첫 줄로 되돌린다. 렌더 중 상태 보정은 React 가 권하는
    "props 가 바뀌었을 때 state 조정" 패턴이고, effect 로 미루면 한 프레임 동안 엉뚱한
    줄이 하이라이트된 화면이 실제로 보인다.
  */
  const [seenQuery, setSeenQuery] = useState(query);
  if (seenQuery !== query) {
    setSeenQuery(query);
    setActiveKey(null);
  }

  /* 수십 건짜리 목록이라 메모이즈가 벌어다 주는 것이 없다 (§ party-boss-picker 주석). */
  const keys = items.map((item) => getItemKey(item));
  const keyedIndex = activeKey === null ? -1 : keys.indexOf(activeKey);
  /*
    키가 목록에서 사라졌으면(방금 담아서 후보에서 빠졌다 등) 첫 줄로 떨어진다.
    "사라진 줄을 계속 가리키는 상태"를 만들지 않는 것이 요점이다.
  */
  const activeIndex = items.length === 0 ? -1 : keyedIndex === -1 ? 0 : keyedIndex;
  const activeId = activeIndex === -1 ? undefined : `${baseId}-opt-${keys[activeIndex]}`;

  /** 조합 중인지. `isComposing` 을 못 믿는 브라우저를 위한 보조 장부다. */
  const composingRef = useRef(false);
  /** 조합 중 `Enter` 를 받았다 — 실제 담기는 그 `Enter` 의 `keyup` 에서 한다. */
  const pendingPickRef = useRef(false);
  /**
   * 사용자가 이 목록에서 **방향키를 한 번이라도 썼는가.**
   *
   * ⚠️ 이 장부가 없으면 목록이 처음 그려질 때(하이라이트는 자동으로 첫 줄)
   *    `scrollIntoView` 가 돌아 **모달 본문이 제멋대로 스크롤된다** — 사용자는
   *    아무 키도 누르지 않았는데 화면이 움직인다. 반대로 방향키를 쓴 뒤에는
   *    검색어를 다시 쳐서 하이라이트가 첫 줄로 돌아갈 때도 스크롤이 따라가야 하므로
   *    "이번 하이라이트가 키보드 때문인가" 가 아니라 **"키보드를 쓰는 사람인가"** 를
   *    기억한다.
   */
  const navigatedRef = useRef(false);

  /*
    하이라이트가 목록 밖으로 나가면 스크롤해서 보이게 한다. `block: "nearest"` 라
    이미 보이는 줄에서는 아무 일도 일어나지 않고, 페이지 전체가 튀지도 않는다.
    `useId()` 가 만드는 id 에는 콜론이 섞이므로 `querySelector` 가 아니라
    `getElementById` 를 쓴다 — 선택자 이스케이프가 필요 없다.
  */
  useEffect(() => {
    if (activeId === undefined) return;
    if (!navigatedRef.current) return;
    document
      .getElementById(activeId)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeId]);

  function pickActive(): void {
    if (activeIndex === -1) return;
    const item = items[activeIndex];
    if (item === undefined) return;
    onPick(item);
  }

  function move(delta: number): void {
    if (items.length === 0) return;
    /*
      끝에서 반대쪽으로 **감는다.** 후보가 한 자리 수인 일이 흔해서 끝에서 멈추면
      "안 눌렸나" 로 읽히고, 마지막 줄에 가려면 `↓` 를 세어야 한다.
    */
    const next = (activeIndex + delta + items.length) % items.length;
    navigatedRef.current = true;
    setActiveKey(keys[next] ?? null);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (disabled) return;
    const composing = event.nativeEvent.isComposing || composingRef.current;

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      // 조합 중 방향키는 IME 후보창의 것이다. 가로채면 한자·가나 변환이 망가진다.
      if (composing) return;
      if (items.length === 0) return;
      // 캐럿이 글자 사이를 뛰거나 페이지가 스크롤되지 않게.
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }

    if (event.key === "Enter") {
      /*
        ★ 후보가 **열려 있을 때만** `Enter` 를 가져간다. 닫혀 있으면 손대지 않고
          흘려보내므로 마법사의 `다음`·폼 제출 같은 기존 동작이 그대로 남는다.
      */
      if (activeIndex === -1) return;
      // 열려 있을 때의 `Enter` 는 **담기**다 — 마법사를 넘기지 않는다.
      event.preventDefault();
      if (composing) {
        // 확정은 IME 에게 맡기고, 담기는 `keyup` 으로 미룬다 (위 ★ 주석).
        pendingPickRef.current = true;
        return;
      }
      /*
        조합이 아닌 `Enter` 는 여기서 담고 예약을 지운다 — 조합 확정에 `keydown` 을
        두 번 보내는 브라우저에서 `keyup` 이 한 번 더 담는 것을 막는다.
      */
      pendingPickRef.current = false;
      pickActive();
      return;
    }

    if (event.key === "Escape") {
      // 조합 중 `Esc` 는 IME 의 조합 취소다.
      if (composing) return;
      /*
        검색어가 비어 있으면 **흘려보낸다.** 이 목록은 모달 안에 살고, 모달의 `Esc` 는
        네이티브 `<dialog>` 의 닫기다 — 그 길을 막으면 키보드로는 창을 못 닫는다.
      */
      if (query === "") return;
      event.preventDefault();
      event.stopPropagation();
      onClearQuery();
    }
  }

  function handleKeyUp(event: KeyboardEvent<HTMLInputElement>): void {
    if (disabled) return;
    if (event.key !== "Enter") return;
    if (!pendingPickRef.current) return;
    pendingPickRef.current = false;
    pickActive();
  }

  return {
    activeIndex,
    inputProps: {
      role: "combobox",
      "aria-expanded": items.length > 0,
      /* 접힌 동안 가리킬 `<ul>` 이 아예 렌더되지 않으므로 속성도 떼어 둔다. */
      "aria-controls": items.length > 0 ? listboxId : undefined,
      "aria-activedescendant": activeId,
      "aria-autocomplete": "list",
      onKeyDown: handleKeyDown,
      onKeyUp: handleKeyUp,
      onCompositionStart: () => {
        composingRef.current = true;
        // 새 조합이 시작했으면 이전 예약은 지난 이야기다.
        pendingPickRef.current = false;
      },
      onCompositionEnd: () => {
        composingRef.current = false;
      },
    },
    listboxProps: {
      id: listboxId,
      role: "listbox",
      "aria-label": listboxLabel,
    },
    getOptionProps: (index) => ({
      id: `${baseId}-opt-${keys[index] ?? String(index)}`,
      role: "option",
      "aria-selected": index === activeIndex,
    }),
  };
}
