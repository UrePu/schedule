"use client";

import { Search, TriangleAlert, UserPlus, X } from "lucide-react";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { SeatNumber } from "@/components/domain";
import {
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  HelperText,
  Input,
  Label,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import { participantAltCharacterName } from "@/lib/domain/participant-label";
import { cn } from "@/lib/utils";
import type { PartyMember, Person, PersonId } from "@/types/domain";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 파티 구성원 고르기 — **찾기와 추가가 한 칸에 있다** (발주 2026-10-19)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시: *"파티 생성할때 구름아이 게스트 두개 있고. 검색과 추가를 둘다넣어야지
 * 캐릭터 많아지는데 직접 다 읽어야돼?"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 두 불만은 **한 뿌리**다 — 찾을 수가 없으니 다시 타이핑하고, 그때마다 새 사람이 생겼다
 * ─────────────────────────────────────────────────────────────────────────────
 * 실측(2026-10-19): 후보가 **70명**(게스트 59 + 앱 사용자 11)인데 이 자리에 검색이
 * 한 줄도 없었다. 게스트 59개의 **이름 종류는 49개** — 같은 이름이 8종 겹쳐 있었고,
 * 그중 `깜고봄이`(09-02 / 10-11) · `죠린`(4개) · `카더우드`(10-04 / 10-16) 는 **몇 주
 * 간격**이다. 목록에서 찾지 못해 이름을 다시 적은 흔적이다.
 *
 * 그래서 칸을 **하나**로 둔다. 치면 아래 격자가 좁혀지고, 찾는 사람이 없으면 그 자리에서
 * `추가` 가 새 게스트를 만든다. 예전처럼 "닉네임으로 추가" 칸과 후보 격자가 따로 있으면
 * 사용자는 **찾아보지 않고 바로 적는다** — 그 배치가 중복을 만든 배치다.
 *
 * ★ 같은 이름이 이미 있으면 **막지 않고 보여 준다.** 동명이인은 실재하므로 금지하면
 *   진짜 다른 사람을 넣을 수 없다. 대신 "이미 있습니다 — 이 사람인가요?" 로 고르는 길을
 *   먼저 내밀고, 그래도 새로 만들겠다면 그 의사를 **`forceNew` 로 들고 간다**(서버가
 *   그 값으로 재사용/신규를 가른다 — `schedule-repo.resolveGuestNames`).
 *
 * ★ **이미 고른 사람은 걸러도 보인다.** 검색어를 쳤을 때 선택이 화면에서 사라지면
 *   사용자는 "안 골랐구나" 하고 다시 고른다 — 이 버그가 생긴 방식이 정확히 그것이다.
 *   그래서 일치하지 않는 선택은 아래에 따로 묶어 둔다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ `useComboboxList` 를 쓰지 않은 근거 (발주가 요구한 판단)
 * ─────────────────────────────────────────────────────────────────────────────
 * 그 훅은 후보 한 줄에 **`role="option"` 을 펼치는 것**을 전제로 만들어졌다. 그런데 이
 * 격자의 한 줄은 `<input type="checkbox">` 를 품은 카드다 — `option` 은 포커스 가능한
 * 위젯을 품을 수 없어(ARIA) 스크린리더에서 줄이 두 번 읽히거나 아예 못 눌린다.
 * `party-picker-dialog` 가 같은 이유로 같은 판단을 했다.
 *
 * ★ 그래도 **그 훅의 IME 장치는 그대로 가져온다.** 여기는 고른 뒤에도 창이 열려 있고
 *   검색어를 비우므로, 조합 중 `Enter` 를 그 자리에서 처리하면 우리가 비운 칸에 IME 가
 *   확정 글자를 되살려 쓴다(`하카` 가 다시 나타난다). 그래서 조합 중 `Enter` 는
 *   **예약만 하고 `keyup` 에서 실행**한다 — 사용자가 누르는 횟수는 한 번이다.
 *   (`party-picker-dialog` 는 고르는 순간 창이 언마운트돼 이 장치가 필요 없었다.
 *    같은 함정이 아니라 **다른 자리**라는 뜻이고, 그래서 여기서는 필요하다.)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 번호(§1.4)
 * ─────────────────────────────────────────────────────────────────────────────
 * 검색이 **보이는 순서를 바꿔도 저장되는 번호는 그대로**다. 번호는 파티 단위이고
 * `party_participants.member_no` 트리거가 `max + 1` 로 정하므로, 이 화면의 정렬·필터는
 * 번호에 손끝도 닿지 않는다. 이미 들어와 있는 사람은 자기 번호를 그대로 보여 준다.
 */

/** DB CHECK(`guest_profiles.display_name` 1~40자)와 **같은 경계**. */
export const GUEST_NAME_MAX_LENGTH = 40;

/**
 * 저장 전까지 줄 세워 둔 "닉네임만 있는 사람".
 *
 * ★ `forceNew` 는 **사용자의 의사**다 — "같은 이름이 이미 있다는 걸 보고도 새 사람으로
 *   만들라"는 뜻이고, 서버는 이 값이 `false` 일 때만 기존 게스트를 재사용한다.
 *   화면이 경고를 띄우지 않았다면(= 같은 이름이 후보에 없었다면) 언제나 `false` 다.
 */
export interface PendingGuest {
  readonly name: string;
  readonly forceNew: boolean;
}

/** 공백과 대소문자를 지운다 — `구름 아이` 와 `구름아이` 가 같은 말이어야 한다. */
function normalize(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

/**
 * 한 사람이 검색어에 걸리는가.
 *
 * 축이 **둘**이다: 표시 이름(본캐 닉네임 또는 게스트 닉네임)과 **그 파티에 데려가는
 * 캐릭터 이름**. `더저(메검메)` 를 사람은 `더저` 로도 `메검메` 로도 떠올린다 —
 * `party-picker-dialog` 가 파티를 찾을 때 세운 규칙과 같은 기조다.
 */
function matchesPerson(
  person: Person,
  altCharacterName: string | null,
  needle: string,
): boolean {
  if (needle === "") return true;
  if (normalize(person.displayName).includes(needle)) return true;
  return (
    altCharacterName !== null && normalize(altCharacterName).includes(needle)
  );
}

export interface MemberSelectGridProps {
  readonly people: readonly Person[];
  readonly selectedIds: ReadonlySet<PersonId>;
  readonly onToggle: (personId: PersonId) => void;
  /**
   * 그 파티의 현재 구성원. 번호와 **참여 캐릭터**의 출처다.
   * 여기 없는 사람은 신규(저장 시 `max + 1`).
   */
  readonly currentMembers?: readonly PartyMember[];
  /** 격자 자체의 접근성 이름. 한 화면에 격자가 둘 뜨므로 서로 구별돼야 한다. */
  readonly label?: string;
  readonly disabled?: boolean;
}

/**
 * 파티 로스터를 짜는 체크박스 격자.
 *
 * ⚠️ 이건 **"이번 조회에 누구를 볼까"가 아니라 "이 파티에 누가 있는가"** 다 (§1.4 갱신).
 *   파티는 한 번 짜두고 계속 쓰는 것이라, 일정은 언제나 그 파티의 **전원**으로 잡힌다.
 *
 * 이미 그 파티에 있는 사람은 **현재 번호를 그대로 보여 준다.** 번호는 파티 단위이고
 * 재배열되지 않으므로, 편집 중에도 자기 번호가 유지된다는 것이 보여야 한다.
 * 새로 넣는 사람은 저장 시점에 `max + 1` 을 받으므로 아직 번호가 없다.
 *
 * ★ 부캐로 들어가 있는 사람은 `더저(메검메)` 로 보인다. 조합 규칙은
 *   `lib/domain/participant-label.ts` 한 곳이 소유한다 — 여기서 문자열을 다시 만들면
 *   파티 바와 이름이 갈린다.
 *
 * ★ **검색칸은 이 컴포넌트가 아니라 `MemberPicker` 가 가진다.** 격자는 받은 목록을
 *   그대로 그리는 일만 한다 — 한 화면에서 이 격자를 두 번(일치 / 일치하지 않는 선택)
 *   그려야 하므로, 검색 상태를 격자가 들면 두 벌이 된다.
 */
export function MemberSelectGrid({
  people,
  selectedIds,
  onToggle,
  currentMembers = [],
  label,
  disabled = false,
}: MemberSelectGridProps) {
  const memberByPersonId = new Map(
    currentMembers.map((member) => [member.personId, member] as const),
  );

  return (
    <ul
      aria-label={label}
      className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
    >
      {people.map((person) => {
        const selected = selectedIds.has(person.personId);
        const member = memberByPersonId.get(person.personId);
        const seatNo = member?.seatNo;
        const altCharacterName =
          member === undefined ? null : participantAltCharacterName(member);

        return (
          <li key={person.personId} className="min-w-0">
            <div
              className={cn(
                "flex h-full flex-col gap-1 rounded-md border p-3 transition duration-200",
                /*
                 * 이 카드 자체는 클릭 대상이 아니다(안의 `Checkbox` 라벨이 클릭 영역).
                 * 그래도 hover 피드백은 "여기에 조작이 있다"를 알리는 역할이라 남기되,
                 * 면을 `hover-surface`(1.10:1) → `hover-strong`(1.245:1)으로 올려 실제로
                 * 보이게 하고, 선택 카드에도 hover 를 준다(예전엔 아예 없었다).
                 */
                selected
                  ? "border-primary bg-primary-subtle hover:bg-primary-subtle-hover"
                  : "border-border bg-surface hover:border-border-strong hover:bg-hover-strong",
              )}
            >
              <Checkbox
                checked={selected}
                disabled={disabled}
                onChange={() => onToggle(person.personId)}
                label={
                  <span className="inline-flex min-w-0 items-center gap-1.5">
                    {seatNo === undefined ? null : (
                      <SeatNumber
                        seatNo={seatNo}
                        size="sm"
                        tone={selected ? "primary" : "muted"}
                      />
                    )}
                    <span
                      className="truncate text-body-sm font-semibold"
                      title={person.displayName}
                    >
                      {person.displayName}
                    </span>
                    {/*
                      부캐 이름은 **본캐와 다른 무게**로 그린다. 한 문자열로 붙여 자르면
                      긴 본캐 닉네임에서 괄호 안이 통째로 사라져 무슨 캐릭터인지 알 수 없다.
                    */}
                    {altCharacterName === null ? null : (
                      <span
                        className="truncate text-body-sm text-ink-muted"
                        title={altCharacterName}
                      >
                        ({altCharacterName})
                      </span>
                    )}
                    {person.isGuest ? (
                      <span className="shrink-0 text-caption text-ink-muted">
                        게스트
                      </span>
                    ) : null}
                  </span>
                }
              />
              {/*
                한 줄 설명. 14px 하한을 지킨다(사람이 실제로 읽는 본문이다).

                ⚠️ 예전에는 모두에게 "가능 시간 미등록"이라고 적었는데, 후보 목록은
                   그런 것을 읽지 않았다 — 확인하지 않은 것을 주장하는 문장이었다.
                   가능 시간 기능 자체가 2026-09-28 에 없어졌으므로 문구도 함께 걷어냈다.
                   게스트 줄만 남는다(세션이 없어 본인이 아무것도 못 하는 것은 사실이다).
              */}
              <p className="text-body-sm leading-snug text-ink-muted">
                {person.blurb ??
                  (person.isGuest
                    ? "닉네임만 등록 · 초대 링크를 보내야 본인 계정이 생깁니다"
                    : "파티에 넣으면 이 사람 몫으로 일정이 잡힙니다")}
              </p>
              {selected && seatNo === undefined ? (
                /*
                  임박 경고가 아니라 단순 안내라 주황을 쓰지 않는다. 주황 문장은
                  라이트에서 2.80:1 로 읽히지도 않았다(§4 의 주황은 임박·주의용이다). (2026-08-19 라이트 재산정 후 3.93:1 — 여전히 미달이라 이 규약은 그대로다).
                */
                <p className="text-body-sm text-ink-muted">
                  저장하면 다음 번호를 받습니다
                </p>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export interface MemberPickerProps {
  readonly people: readonly Person[];
  readonly selectedIds: ReadonlySet<PersonId>;
  readonly onToggle: (personId: PersonId) => void;
  readonly currentMembers?: readonly PartyMember[];
  /** 저장 전까지 줄 세워 둔 신규 게스트. 저장 시점에야 `guest_profiles` 행이 된다. */
  readonly guests: readonly PendingGuest[];
  readonly onAddGuest: (guest: PendingGuest) => void;
  readonly onRemoveGuest: (name: string) => void;
  /**
   * 후보 조회 상태. **검색·추가 칸은 이 셋과 무관하게 살아 있다** — 닉네임으로 넣는 일은
   * 후보 목록을 전혀 쓰지 않으므로, 조회가 늦거나 깨졌다고 막을 이유가 없다.
   */
  readonly isPeopleLoading?: boolean;
  readonly isPeopleError?: boolean;
  readonly onPeopleRetry?: () => void;
  readonly disabled?: boolean;
}

/**
 * **찾기 + 추가 + 후보 격자** 한 덩어리. 파티 만들기 마법사와 파티 편집 창이 공유한다.
 *
 * 두 창이 같은 블록을 각자 베껴 들고 있었고(닉네임 칸 · 칩 목록 · 로딩/빈/오류 세 갈래),
 * 그래서 한쪽만 고치는 일이 반복됐다. 여기 한 벌만 둔다.
 */
export function MemberPicker({
  people,
  selectedIds,
  onToggle,
  currentMembers = [],
  guests,
  onAddGuest,
  onRemoveGuest,
  isPeopleLoading = false,
  isPeopleError = false,
  onPeopleRetry,
  disabled = false,
}: MemberPickerProps) {
  const searchId = useId();
  const statusId = useId();
  const [query, setQuery] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  /** 조합 중인지. `isComposing` 을 못 믿는 브라우저를 위한 보조 장부다. */
  const composingRef = useRef(false);
  /** 조합 중 `Enter` 를 받았다 — 실제 실행은 그 `Enter` 의 `keyup` 에서 한다(머리말 ★). */
  const pendingEnterRef = useRef(false);

  const trimmed = query.trim();
  const needle = normalize(query);

  /** 부캐 이름까지 검색에 쓰려면 현재 구성원 쪽 캐릭터를 알아야 한다. */
  const altNameByPersonId = useMemo(() => {
    const map = new Map<PersonId, string | null>();
    for (const member of currentMembers) {
      map.set(member.personId, participantAltCharacterName(member));
    }
    return map;
  }, [currentMembers]);

  const matched = useMemo(
    () =>
      people.filter((person) =>
        matchesPerson(
          person,
          altNameByPersonId.get(person.personId) ?? null,
          needle,
        ),
      ),
    [altNameByPersonId, needle, people],
  );

  /**
   * 검색어에 걸리지 않지만 **이미 고른** 사람. 여기 모아서 반드시 보여 준다 —
   * 선택이 사라져 보이면 사용자가 같은 사람을 다시 만든다(머리말 ★).
   */
  const selectedOutside = useMemo(() => {
    if (needle === "") return [];
    const shown = new Set(matched.map((person) => person.personId));
    return people.filter(
      (person) => selectedIds.has(person.personId) && !shown.has(person.personId),
    );
  }, [matched, needle, people, selectedIds]);

  /**
   * 적은 이름과 **똑같은 이름**을 가진 후보. 하나라도 있으면 "이미 있습니다" 를 띄운다.
   * 비교는 공백·대소문자를 지운 값이다 — `구름 아이` 를 다른 사람으로 보지 않는다.
   */
  const sameName = useMemo(
    () =>
      needle === ""
        ? []
        : people.filter((person) => normalize(person.displayName) === needle),
    [needle, people],
  );
  /** 이미 줄 세워 둔 신규 게스트 중 같은 이름. 저장 전이라 후보 목록에는 없다. */
  const sameQueued = useMemo(
    () =>
      needle === ""
        ? []
        : guests.filter((guest) => normalize(guest.name) === needle),
    [guests, needle],
  );
  const hasSameName = sameName.length > 0 || sameQueued.length > 0;

  const first = matched[0] ?? null;

  function pickPerson(person: Person): void {
    if (selectedIds.has(person.personId)) {
      setHint(`${person.displayName} 은(는) 이미 골라 두었습니다.`);
    } else {
      onToggle(person.personId);
      setHint(null);
    }
    setQuery("");
  }

  /**
   * 적은 이름을 **새 게스트로** 줄 세운다.
   *
   * `forceNew` 는 "같은 이름이 있는 걸 보고도 새로 만든다" 는 의사다. 경고가 떠 있을 때
   * `추가` 를 누른 것 자체가 그 의사이므로, 두 버튼이 같은 값을 넘긴다.
   */
  function addGuest(forceNew: boolean): void {
    if (trimmed === "") {
      setHint("닉네임을 입력해 주세요.");
      return;
    }
    if (trimmed.length > GUEST_NAME_MAX_LENGTH) {
      setHint(`닉네임은 ${GUEST_NAME_MAX_LENGTH}자 이하여야 합니다.`);
      return;
    }
    /*
      같은 요청 안의 **글자까지 똑같은** 중복만 막는다. 공백·대소문자를 지운 비교로
      막으면 `pl2y` 와 `PL2Y` 를 같은 사람이라고 단정하는 것이 되는데, 그건 화면이
      알 수 없는 사실이다 — 경고로 알리고 판단은 사용자에게 남긴다.
    */
    if (guests.some((guest) => guest.name === trimmed)) {
      setHint("이미 추가한 닉네임입니다.");
      return;
    }
    onAddGuest({ name: trimmed, forceNew });
    setQuery("");
    setHint(null);
  }

  /** `Enter` 가 하는 일: 걸린 후보가 있으면 **고르고**, 없으면 **새로 추가**한다. */
  function runEnter(): void {
    if (trimmed === "") return;
    if (first !== null) {
      pickPerson(first);
      return;
    }
    addGuest(hasSameName);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    const composing = event.nativeEvent.isComposing || composingRef.current;

    if (event.key === "Enter") {
      // 다이얼로그 안에서 Enter 가 "다음"·폼 제출로 새는 것을 막는다.
      event.preventDefault();
      if (composing) {
        // 확정은 IME 에게 맡기고, 실행은 `keyup` 으로 미룬다 (머리말 ★).
        pendingEnterRef.current = true;
        return;
      }
      /*
        조합이 아닌 `Enter` 는 여기서 실행하고 예약을 지운다 — 조합 확정에 `keydown` 을
        두 번 보내는 브라우저에서 `keyup` 이 한 번 더 실행하는 것을 막는다.
      */
      pendingEnterRef.current = false;
      runEnter();
      return;
    }

    if (event.key === "Escape") {
      // 조합 중 `Esc` 는 IME 의 조합 취소다.
      if (composing) return;
      /*
        검색어가 비어 있으면 **흘려보낸다.** 이 칸은 모달 안에 살고, 모달의 `Esc` 는
        네이티브 `<dialog>` 의 닫기다 — 그 길을 막으면 키보드로는 창을 못 닫는다
        (`use-combobox-list` 가 같은 이유로 같은 가드를 가진다).
      */
      if (query === "") return;
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
      setHint(null);
    }
  }

  function handleKeyUp(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key !== "Enter") return;
    if (!pendingEnterRef.current) return;
    pendingEnterRef.current = false;
    runEnter();
  }

  const listReady = !isPeopleLoading && !isPeopleError;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      {/*
        ── 찾기 · 추가 ───────────────────────────────────────────────────────
        ⚠️ `relative` 를 **반드시** 둔다. 아래 `sr-only` 는 `position: absolute` 라
           위치 잡힌 조상이 없으면 포함 바탕이 페이지가 되고, 긴 안내 문장이 페이지
           `scrollWidth` 를 늘린다(`party-option.tsx` 가 실측으로 같은 함정을 적어 뒀다).
      */}
      <div className="relative flex min-w-0 flex-col gap-1.5">
        <Label htmlFor={searchId}>
          사람 찾기 · 닉네임으로 추가
          {listReady ? (
            <span className="ml-1 font-normal text-ink-muted">
              · {matched.length}/{people.length}명
            </span>
          ) : null}
        </Label>
        {/*
          360px 에서 입력칸과 버튼이 한 줄에 들어가면 입력칸이 너무 좁아진다.
          좁은 화면에서는 세로로 쌓고, sm 이상에서만 나란히 둔다.
        */}
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row">
          <div className="relative min-w-0 sm:flex-1">
            <Search
              aria-hidden
              size={16}
              className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-placeholder"
            />
            <Input
              id={searchId}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setHint(null);
              }}
              onKeyDown={handleKeyDown}
              onKeyUp={handleKeyUp}
              onCompositionStart={() => {
                composingRef.current = true;
                // 새 조합이 시작했으면 이전 예약은 지난 이야기다.
                pendingEnterRef.current = false;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              placeholder="이름으로 찾거나, 없는 사람을 적어 추가 — 구름아이"
              className="pl-9"
              autoComplete="off"
              maxLength={GUEST_NAME_MAX_LENGTH}
              aria-describedby={statusId}
              disabled={disabled}
            />
          </div>
          <Button
            variant="secondary"
            onClick={() => addGuest(hasSameName)}
            disabled={disabled || trimmed === ""}
            className="shrink-0"
          >
            <UserPlus aria-hidden size={16} />
            추가
          </Button>
        </div>

        {/*
          결과 수를 **보조기기에도** 알린다. 눈으로는 위 라벨의 `N/70명` 이 같은 말을
          하지만, 그 값은 라벨 안이라 바뀔 때 읽히지 않는다.
        */}
        <p id={statusId} role="status" aria-live="polite" className="sr-only">
          {!listReady
            ? "후보 목록을 불러오는 중입니다."
            : needle === ""
              ? `후보 ${String(people.length)}명`
              : `후보 ${String(people.length)}명 중 ${String(matched.length)}명 일치`}
        </p>

        {hint !== null ? (
          <HelperText tone="error">{hint}</HelperText>
        ) : trimmed === "" ? (
          <HelperText>
            이름을 치면 아래 목록이 좁혀집니다. 찾는 사람이 없으면 그 이름 그대로{" "}
            <strong className="font-semibold">추가</strong>하세요 — 계정이 없는
            사람도 닉네임만으로 넣을 수 있고, 나중에 초대 링크를 보내면 그 사람
            계정에 이 파티가 그대로 붙습니다.
          </HelperText>
        ) : first !== null ? (
          <HelperText>
            <kbd className="font-mono">Enter</kbd> 로{" "}
            <strong className="font-semibold">{first.displayName}</strong> 을(를)
            고릅니다. <kbd className="font-mono">Tab</kbd> 으로 목록을 오가고,{" "}
            <kbd className="font-mono">Esc</kbd> 는 검색어를 지웁니다.
          </HelperText>
        ) : (
          <HelperText>
            <kbd className="font-mono">Enter</kbd> 로{" "}
            <strong className="font-semibold">{trimmed}</strong> 을(를) 새 사람으로
            추가합니다.
          </HelperText>
        )}
      </div>

      {/*
        ── 이미 있습니다 — 이 사람인가요? ────────────────────────────────────
        §4: 주황은 **배경과 아이콘**이 지고 문장은 잉크가 진다(`warning-note.tsx` 가
        같은 근거로 같은 토큰을 쓴다). 빨강은 실패·취소 전용이라 쓰지 않는다 —
        여기는 막는 자리가 아니라 **확인하는** 자리다.
      */}
      {hasSameName ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2">
          <p className="flex items-start gap-2 text-body-sm text-ink">
            <TriangleAlert
              aria-hidden
              size={16}
              className="mt-0.5 shrink-0 text-tertiary"
            />
            <span>
              <strong className="font-semibold">{trimmed}</strong> 은(는) 이미{" "}
              {sameName.length + sameQueued.length}명 있습니다. 같은 사람이면
              아래에서 고르세요 — 새로 만들면 이름이 같은 사람이 둘이 됩니다.
              {/*
                ⚠️ **같은 이름이 둘 이상이면 고르기 버튼을 내밀지 않는다.** 두 사람의
                   이름이 글자까지 같으면 버튼도 글자까지 같아서, 어느 쪽을 누르는지
                   사용자가 알 수 없다 — 동전 던지기를 선택지처럼 보여 주는 셈이다.
                   그 상태를 숨기지 않고 **말해 주고**, 고르는 일은 번호·참여 캐릭터가
                   함께 보이는 아래 격자에 맡긴다. 이것이 정리가 필요한 바로 그 상태다.
              */}
              {sameName.length > 1 ? (
                <>
                  {" "}
                  이름이 같아 이 줄에서는 둘을 구별할 수 없습니다 — 번호와 캐릭터가
                  함께 보이는 아래 목록에서 고르세요.
                </>
              ) : null}
            </span>
          </p>
          <div className="flex flex-wrap gap-2">
            {sameName.length === 1
              ? sameName.map((person) => (
                  <Button
                    key={person.personId}
                    size="sm"
                    variant="secondary"
                    disabled={disabled}
                    onClick={() => pickPerson(person)}
                  >
                    {person.displayName}
                    {person.isGuest ? " (게스트)" : ""} 고르기
                  </Button>
                ))
              : null}
            {/*
              막지 않는다 — 동명이인은 실재한다(§ 머리말 ★). 누른 사실이 `forceNew` 로
              서버까지 가고, 서버는 그때만 새 행을 만든다.
            */}
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled}
              onClick={() => addGuest(true)}
            >
              그래도 새로 추가
            </Button>
          </div>
        </div>
      ) : null}

      {/* ── 줄 세워 둔 신규 게스트 ──────────────────────────────────────── */}
      {guests.length > 0 ? (
        <ul aria-label="추가할 닉네임" className="flex flex-wrap gap-2">
          {guests.map((guest) => (
            <li key={guest.name}>
              <span className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-primary bg-primary-subtle py-1 pr-1 pl-3">
                <span
                  className="truncate text-body-sm text-ink"
                  title={guest.name}
                >
                  {guest.name}
                </span>
                {/*
                  꼬리표는 **문장이 아니라 라벨**이라 12px 이 허용된다(§4). 붙는
                  조건이 좁아서(같은 이름을 보고도 새로 만들기로 한 경우) 평소에는
                  아무 소음도 더하지 않는다.
                */}
                {guest.forceNew ? (
                  <span className="shrink-0 text-caption text-ink-muted">
                    동명이인
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => onRemoveGuest(guest.name)}
                  aria-label={`${guest.name} 빼기`}
                  disabled={disabled}
                  className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-ink-muted transition duration-200 hover:bg-hover-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <X aria-hidden size={14} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* ── 후보 격자 — 로딩 · 오류 · 빈 · 결과 네 갈래 ─────────────────── */}
      {isPeopleError ? (
        <ErrorState
          title="사람 목록을 불러오지 못했습니다"
          onRetry={onPeopleRetry}
          className="py-6"
        />
      ) : isPeopleLoading ? (
        <SkeletonGroup label="사람 목록을 불러오는 중">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2, 3, 4, 5].map((index) => (
              <Skeleton key={index} className="h-20" />
            ))}
          </div>
        </SkeletonGroup>
      ) : people.length === 0 ? (
        <EmptyState
          title="후보 목록이 비어 있습니다"
          description="위 칸에 닉네임을 적어 바로 추가할 수 있습니다. 친구를 맺거나 같은 파티가 되면 여기에도 나타납니다."
        />
      ) : (
        <>
          {matched.length === 0 ? (
            <HelperText>
              이름에 <strong className="font-semibold">{trimmed}</strong> 가 들어가는
              사람이 후보에 없습니다. 위 <strong className="font-semibold">추가</strong>{" "}
              로 새로 넣거나, 검색어를 지워 전체를 다시 보세요.
            </HelperText>
          ) : (
            <MemberSelectGrid
              people={matched}
              selectedIds={selectedIds}
              onToggle={onToggle}
              currentMembers={currentMembers}
              label="검색에 일치하는 후보"
              disabled={disabled}
            />
          )}

          {selectedOutside.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-3">
              {/*
                문장이라 14px 하한을 지킨다(§4). "검색어와 다른데 왜 보이지" 에 화면이
                먼저 답해야 사용자가 다시 고르지 않는다.
              */}
              <p className="text-body-sm text-ink-muted">
                검색어와 일치하지 않지만{" "}
                <strong className="font-semibold text-ink">
                  이미 고른 사람 {selectedOutside.length}명
                </strong>
                입니다. 체크를 풀려면 여기서 누르세요.
              </p>
              <MemberSelectGrid
                people={selectedOutside}
                selectedIds={selectedIds}
                onToggle={onToggle}
                currentMembers={currentMembers}
                label="검색어와 일치하지 않지만 이미 고른 사람"
                disabled={disabled}
              />
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
