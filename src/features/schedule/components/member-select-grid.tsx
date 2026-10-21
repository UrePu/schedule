"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Eye,
  EyeOff,
  ListChecks,
  Search,
  Trash2,
  TriangleAlert,
  UserPlus,
  X,
} from "lucide-react";
import {
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

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
import { dbQueryOptions, queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type {
  GuestFootprint,
  GuestManageState,
  PartyMember,
  Person,
  PersonId,
} from "@/types/domain";

import {
  deleteGuest,
  fetchGuestManage,
  setGuestHidden,
} from "../data/schedule-queries";
import type { GuestManageSnapshot } from "../types";

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
  /**
   * 카드 맨 아래에 붙는 칸. **`목록 정리` 중에만** 게스트 카드에 숨기기·지우기를 단다
   * (2026-10-21). 격자는 무엇을 그리는지 모른다 — 판정과 확인 단계는 `MemberPicker` 가 갖는다.
   */
  readonly renderFooter?: (person: Person) => ReactNode;
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
  renderFooter,
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
              {renderFooter?.(person) ?? null}
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
  /**
   * 게스트 정리(숨기기·지우기)의 데이터와 쓰기. **생략이 정상이다** — 생략하면 이 컴포넌트가
   * 직접 `/api/schedule/people/guests` 를 부른다. 파티 만들기·편집 창은 그렇게 쓴다.
   *
   * 넘기는 곳은 전시 화면(`/showcase`) 하나다. 비로그인으로 폭과 확인 단계를 재려면 서버
   * 없이 돌아야 하기 때문이다.
   */
  readonly guestTidy?: GuestTidySource;
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
  guestTidy,
}: MemberPickerProps) {
  const searchId = useId();
  const statusId = useId();
  const [query, setQuery] = useState("");
  const [hint, setHint] = useState<string | null>(null);

  /*
    ── 게스트 정리 (2026-10-21) ─────────────────────────────────────────────
    평소에는 **아무것도 더 그리지 않는다.** `목록 정리` 를 눌렀을 때만 게스트 카드에
    숨기기·지우기가 붙는다 — 70장의 카드마다 버튼이 늘 있으면 고르는 화면이 정리 화면이
    되고, 실수로 누를 자리가 70배가 된다.
  */
  const [tidy, setTidy] = useState(false);
  const liveTidy = useLiveGuestTidy(tidy && guestTidy === undefined);
  const tidySource = guestTidy ?? liveTidy;
  const [confirm, setConfirm] = useState<TidyConfirm | null>(null);
  const [busyId, setBusyId] = useState<PersonId | null>(null);
  const [tidyError, setTidyError] = useState<TidyError | null>(null);
  const [tidyNotice, setTidyNotice] = useState<string | null>(null);

  const stateById = useMemo(() => {
    const map = new Map<PersonId, GuestManageState>();
    for (const state of tidySource.snapshot?.guests ?? []) {
      map.set(state.personId, state);
    }
    return map;
  }, [tidySource.snapshot]);

  /*
    ★ **숨긴 사람은 후보 격자에서 빠지지만, 이미 고른 사람은 빠지지 않는다.** 편집 중인
      파티의 구성원을 숨겼다고 그 사람이 창에서 사라지면 사용자는 "빠졌구나" 하고 저장하고,
      그 저장이 **그 사람을 파티에서 내보낸다.** 숨김은 후보에서 치우는 것이지 파티에서
      빼는 것이 아니다 — 위 "이미 고른 사람은 걸러도 보인다" 와 같은 규칙이다.
  */
  const visiblePeople = useMemo(
    () =>
      people.filter(
        (person) => person.hidden !== true || selectedIds.has(person.personId),
      ),
    [people, selectedIds],
  );
  const hiddenPeople = useMemo(
    () =>
      people.filter(
        (person) => person.hidden === true && !selectedIds.has(person.personId),
      ),
    [people, selectedIds],
  );
  const hasGuests = useMemo(
    () => people.some((person) => person.isGuest),
    [people],
  );

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
      visiblePeople.filter((person) =>
        matchesPerson(
          person,
          altNameByPersonId.get(person.personId) ?? null,
          needle,
        ),
      ),
    [altNameByPersonId, needle, visiblePeople],
  );

  /**
   * 검색어에 걸리지 않지만 **이미 고른** 사람. 여기 모아서 반드시 보여 준다 —
   * 선택이 사라져 보이면 사용자가 같은 사람을 다시 만든다(머리말 ★).
   */
  const selectedOutside = useMemo(() => {
    if (needle === "") return [];
    const shown = new Set(matched.map((person) => person.personId));
    return visiblePeople.filter(
      (person) => selectedIds.has(person.personId) && !shown.has(person.personId),
    );
  }, [matched, needle, visiblePeople, selectedIds]);

  /**
   * 적은 이름과 **똑같은 이름**을 가진 후보. 하나라도 있으면 "이미 있습니다" 를 띄운다.
   * 비교는 공백·대소문자를 지운 값이다 — `구름 아이` 를 다른 사람으로 보지 않는다.
   */
  const sameName = useMemo(
    () =>
      needle === ""
        ? []
        : visiblePeople.filter(
            (person) => normalize(person.displayName) === needle,
          ),
    [needle, visiblePeople],
  );
  /**
   * 숨긴 사람 중 같은 이름. **고르는 길로 내밀지 않는다**(숨긴 것은 사용자의 결정이다).
   * 다만 말은 한다 — 서버는 숨긴 게스트를 재사용하지 않으므로(`resolveGuestNames`) 그대로
   * 추가하면 같은 이름이 하나 더 생긴다. 모르고 만들면 그것이 이 화면이 막으려던 중복이다.
   */
  const sameNameHidden = useMemo(
    () =>
      needle === ""
        ? []
        : hiddenPeople.filter(
            (person) => normalize(person.displayName) === needle,
          ),
    [needle, hiddenPeople],
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

  /**
   * 숨기기 · 되돌리기 · 지우기를 실제로 보낸다. **확인 단계는 여기 오기 전에 끝났다**
   * (`GuestTidyControls` 가 숨기기·지우기를 두 번 눌러야 이 함수를 부른다).
   */
  async function runTidy(person: Person, action: TidyAction): Promise<void> {
    setBusyId(person.personId);
    setTidyError(null);
    setTidyNotice(null);
    try {
      if (action === "delete") {
        const seats = await tidySource.remove(person.personId);
        /*
          지운 사람이 이 창에서 골라 둔 사람이면 **선택도 함께 푼다.** 남겨 두면 저장할 때
          서버가 "넣을 수 없는 사람" 으로 400 을 돌려 파티 저장 전체가 깨진다.
        */
        if (selectedIds.has(person.personId)) onToggle(person.personId);
        setTidyNotice(
          seats > 0
            ? `${person.displayName} 을(를) 지웠습니다. 파티 구성원 자리 ${String(seats)}개가 비었고, 그 번호는 다른 사람에게 다시 주지 않습니다.`
            : `${person.displayName} 을(를) 지웠습니다.`,
        );
      } else {
        await tidySource.setHidden(person.personId, action === "hide");
        setTidyNotice(
          action === "hide"
            ? `${person.displayName} 을(를) 후보에서 숨겼습니다. 아래 ‘숨긴 사람’ 에서 언제든 되돌릴 수 있습니다.`
            : `${person.displayName} 을(를) 다시 후보에 보이게 했습니다.`,
        );
      }
      setConfirm(null);
    } catch (error) {
      setTidyError({
        personId: person.personId,
        message:
          error instanceof Error && error.message !== ""
            ? error.message
            : "처리하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      });
    } finally {
      setBusyId(null);
    }
  }

  /** 정리 중일 때 게스트 카드 아래에 붙는 칸. 앱 사용자 카드에는 아무것도 붙지 않는다. */
  function renderTidyFooter(person: Person): ReactNode {
    if (!tidy || !person.isGuest) return null;
    return (
      <GuestTidyControls
        person={person}
        state={stateById.get(person.personId)}
        loading={tidySource.isLoading}
        confirm={confirm?.personId === person.personId ? confirm.action : null}
        busy={busyId === person.personId}
        locked={disabled || (busyId !== null && busyId !== person.personId)}
        error={
          tidyError?.personId === person.personId ? tidyError.message : null
        }
        onAsk={(action) => {
          setConfirm({ personId: person.personId, action });
          setTidyError(null);
        }}
        onCancel={() => setConfirm(null)}
        onRun={(action) => void runTidy(person, action)}
      />
    );
  }

  const hiddenShown =
    needle === ""
      ? hiddenPeople
      : hiddenPeople.filter((person) =>
          normalize(person.displayName).includes(needle),
        );

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
              · {matched.length}/{visiblePeople.length}명
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
              ? `후보 ${String(visiblePeople.length)}명`
              : `후보 ${String(visiblePeople.length)}명 중 ${String(matched.length)}명 일치`}
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
        ── 게스트 정리 — 숨기기 · 지우기 (2026-10-21) ─────────────────────────
        게스트가 하나도 없으면 정리할 것도 없으므로 줄 자체를 그리지 않는다.
      */}
      {listReady && hasGuests ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {hiddenPeople.length > 0 ? (
            <p className="min-w-0 text-body-sm text-ink-muted">
              숨긴 사람 {hiddenPeople.length}명은 후보에 나오지 않습니다.
            </p>
          ) : null}
          <Button
            size="sm"
            variant={tidy ? "secondary" : "ghost"}
            aria-pressed={tidy}
            onClick={() => {
              setTidy((prev) => !prev);
              setConfirm(null);
              setTidyError(null);
              setTidyNotice(null);
            }}
            disabled={disabled}
            className="ml-auto"
          >
            <ListChecks aria-hidden size={16} />
            {tidy ? "정리 끝내기" : "게스트 정리"}
          </Button>
        </div>
      ) : null}

      {tidy && listReady ? (
        /*
          ⚠️ `relative` — 아래 `sr-only` 알림이 페이지 폭을 늘리지 않게(위 검색칸과 같은 함정).
          ★ 알림 칸은 **늘 그려 둔다.** `role="status"` 는 내용이 *바뀔 때* 읽히므로, 결과가
            생기는 순간 칸이 새로 생기면 보조기기가 아무것도 읽지 않는다.
        */
        <div className="relative flex min-w-0 flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2">
          {tidySource.isError ? (
            <ErrorState
              title="정리할 수 있는지 확인하지 못했습니다"
              onRetry={tidySource.onRetry}
              className="py-4"
            />
          ) : tidySource.snapshot?.available === false ? (
            <p className="text-body-sm text-ink">
              게스트 정리 기능이 아직 준비되지 않았습니다. 데이터베이스 갱신이 끝나면
              여기서 숨기고 지울 수 있습니다.
            </p>
          ) : (
            <p className="text-body-sm text-ink-muted">
              <strong className="font-semibold text-ink">숨기기</strong>는 후보에서만
              빼고 지난 일정·수익·파티 명단은 그대로 둡니다.{" "}
              <strong className="font-semibold text-ink">지우기</strong>는 기록이
              하나도 없는 사람만 되며 되돌릴 수 없습니다. 둘 다{" "}
              <strong className="font-semibold text-ink">
                내가 만든 파티에만 들어 있는 게스트
              </strong>
              에만 됩니다.
            </p>
          )}
          <p
            role="status"
            aria-live="polite"
            className={tidyNotice === null ? "sr-only" : "text-body-sm text-ink"}
          >
            {tidyNotice ?? ""}
          </p>
        </div>
      ) : null}

      {/*
        숨긴 사람 중 같은 이름 — 고르는 길은 내밀지 않고 **사실만** 말한다(`sameNameHidden`).
      */}
      {sameNameHidden.length > 0 ? (
        <HelperText>
          숨긴 사람 중에도 <strong className="font-semibold">{trimmed}</strong> 이(가){" "}
          {sameNameHidden.length}명 있습니다. 그대로 추가하면 같은 이름이 하나 더
          생깁니다 — 같은 사람이면{" "}
          <strong className="font-semibold">게스트 정리</strong>에서 다시 보이게 한
          뒤 고르세요.
        </HelperText>
      ) : null}

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
          {matched.length === 0 && needle === "" ? (
            <HelperText>
              보이는 후보가 없습니다 — 모두 숨겨 두었습니다.{" "}
              <strong className="font-semibold">게스트 정리</strong>에서 다시 보이게
              하거나, 위 칸에 닉네임을 적어 새로 추가하세요.
            </HelperText>
          ) : matched.length === 0 ? (
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
              renderFooter={renderTidyFooter}
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
                renderFooter={renderTidyFooter}
              />
            </div>
          ) : null}

          {/*
            ── 숨긴 사람 — 정리 중에만 ─────────────────────────────────────────
            체크박스 격자가 **아니다.** 숨긴 사람을 여기서 고르게 하면 "숨겼는데 파티에
            들어갔다" 가 생긴다. 되돌리거나 지우는 일만 한다.
          */}
          {tidy ? (
            <div className="flex min-w-0 flex-col gap-2 border-t border-border pt-3">
              <p className="text-body-sm text-ink-muted">
                <strong className="font-semibold text-ink">
                  숨긴 사람 {hiddenPeople.length}명
                </strong>{" "}
                — 후보에는 나오지 않고, 지난 일정·수익에는 이름이 그대로 남아 있습니다.
              </p>
              {hiddenShown.length === 0 ? (
                <p className="text-body-sm text-ink-muted">
                  {hiddenPeople.length === 0
                    ? "숨긴 사람이 없습니다."
                    : "검색어와 일치하는 숨긴 사람이 없습니다."}
                </p>
              ) : (
                <ul
                  aria-label="숨긴 사람"
                  className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3"
                >
                  {hiddenShown.map((person) => (
                    <li key={person.personId} className="min-w-0">
                      <div className="flex h-full flex-col gap-1 rounded-md border border-dashed border-border-strong bg-surface p-3">
                        <p className="flex min-w-0 items-center gap-1.5">
                          <EyeOff
                            aria-hidden
                            size={14}
                            className="shrink-0 text-ink-muted"
                          />
                          <span
                            className="truncate text-body-sm font-semibold text-ink"
                            title={person.displayName}
                          >
                            {person.displayName}
                          </span>
                          <span className="shrink-0 text-caption text-ink-muted">
                            게스트 · 숨김
                          </span>
                        </p>
                        {renderTidyFooter(person)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 게스트 정리 — 숨기기 · 지우기 (2026-10-21)
// ═════════════════════════════════════════════════════════════════════════════
/*
 * 발주 지시: *"그리고 삭제 할수있게도 해줘. 내 기준 게스트니까."*
 *
 * ★ **기본은 숨기기다.** 지우기는 기록이 0건일 때만 보인다 — `party_participants.guest_id`
 *   가 CASCADE 라 기록 있는 게스트를 지우면 그 사람의 일정 참여·분배 몫이 함께 죽는다.
 * ★ **왜 안 되는지를 화면이 말한다.** 버튼을 그냥 감추면 "지우기가 왜 없지?" 가 남는다.
 *   승계됨 · 남의 파티에도 있음 · 기록 있음(몇 건인지까지) — 이유마다 한 문장이다.
 * ★ 숨기기·지우기는 **두 번 눌러야 한다**(확인 단계). 되돌리기는 한 번이다 — 잃을 것이
 *   없는 동작에 확인을 붙이면 확인이 습관이 되어 정작 지우기 앞에서 읽히지 않는다.
 * ★ 이 자리(사람 고르기)를 고른 근거: "목록이 더럽다" 는 불만이 생기는 곳이 바로 여기다.
 *   별도 화면에 두면 더러운 것을 본 자리와 치우는 자리가 갈려, 사용자가 이름을 기억해
 *   다른 화면에서 다시 찾아야 한다.
 */

/** 확인 단계를 거치는 두 동작. 되돌리기(`unhide`)는 확인 없이 바로 간다. */
type TidyConfirmAction = "hide" | "delete";
type TidyAction = TidyConfirmAction | "unhide";

interface TidyConfirm {
  readonly personId: PersonId;
  readonly action: TidyConfirmAction;
}

interface TidyError {
  readonly personId: PersonId;
  readonly message: string;
}

/**
 * 게스트 정리의 데이터와 쓰기. 기본은 `useLiveGuestTidy`(서버)이고, 전시 화면만 손으로 만든
 * 것을 넘긴다(`MemberPickerProps.guestTidy`).
 */
export interface GuestTidySource {
  readonly snapshot: GuestManageSnapshot | undefined;
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly onRetry: () => void;
  /** 실패하면 **던진다** — 메시지가 그대로 그 카드 아래에 뜬다. */
  readonly setHidden: (personId: PersonId, hidden: boolean) => Promise<void>;
  /** 지우고, 함께 사라진 파티 구성원 자리 수를 돌려준다. 실패하면 던진다. */
  readonly remove: (personId: PersonId) => Promise<number>;
}

/**
 * 서버에 붙은 정리 소스. **`게스트 정리` 를 켰을 때만 조회한다** — 판정은 게스트마다 기록
 * 표 여럿을 세는 일이라 창을 열 때마다 돌리지 않는다.
 *
 * 무효화(§2.4 Rule 5):
 *   · 숨기기·되돌리기 → `people.manage` 는 응답으로 **덮어쓰고**, `people.pool` 을 날린다
 *     (숨긴 사람이 후보 격자에서 빠지는 것은 pool 의 `hidden` 이 바뀌어서다).
 *   · 지우기 → 위에 더해 `party.root()`. 지운 게스트의 구성원 자리가 CASCADE 로 사라져
 *     파티 구성원·묶음 화면이 바뀐다. 일정(`runs`)·수익은 건드리지 않는다 — 기록이 0건인
 *     게스트만 지워지므로 그쪽에 바뀔 것이 없다.
 */
function useLiveGuestTidy(enabled: boolean): GuestTidySource {
  const queryClient = useQueryClient();
  const query = useQuery({
    ...dbQueryOptions(queryKeys.db.people.manage()),
    queryFn: fetchGuestManage,
    enabled,
  });

  const settle = useCallback(
    (snapshot: GuestManageSnapshot) => {
      queryClient.setQueryData(queryKeys.db.people.manage(), snapshot);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.db.people.pool(),
      });
    },
    [queryClient],
  );

  const hideMutation = useMutation({
    mutationFn: (input: { personId: PersonId; hidden: boolean }) =>
      setGuestHidden(input.personId, input.hidden),
    onSuccess: settle,
  });
  const deleteMutation = useMutation({
    mutationFn: (personId: PersonId) => deleteGuest(personId),
    onSuccess: (result) => {
      settle(result);
      void queryClient.invalidateQueries({ queryKey: queryKeys.db.party.root() });
    },
  });

  const { mutateAsync: hideAsync } = hideMutation;
  const { mutateAsync: deleteAsync } = deleteMutation;
  const { refetch } = query;

  return {
    snapshot: query.data,
    isLoading: enabled && query.isPending,
    isError: query.isError,
    onRetry: () => void refetch(),
    setHidden: async (personId, hidden) => {
      await hideAsync({ personId, hidden });
    },
    remove: async (personId) => (await deleteAsync(personId)).removedSeats,
  };
}

/** 지우면 사라지는 **기록**을 사람 말로. 0건인 항목은 빼고 말한다. */
function describeHistory(footprint: GuestFootprint): string {
  const parts: string[] = [];
  const push = (count: number, label: string) => {
    if (count > 0) parts.push(`${label} ${String(count)}건`);
  };
  push(footprint.signups, "일정 참여");
  push(footprint.dropShares, "분배 몫");
  push(footprint.dropRefs, "드랍 기록");
  push(footprint.runsAuthored, "등록한 일정");
  push(footprint.bundleSettings, "묶음 설정");
  push(footprint.claimLogs, "승계 기록");
  push(footprint.invites, "초대 기록");
  push(footprint.availability, "가능 시간 기록");
  return parts.join(" · ");
}

interface GuestTidyControlsProps {
  readonly person: Person;
  /** 아직 판정을 못 받았으면 `undefined`. */
  readonly state: GuestManageState | undefined;
  readonly loading: boolean;
  readonly confirm: TidyConfirmAction | null;
  readonly busy: boolean;
  /** 다른 카드가 처리 중이거나 창 전체가 잠겼다. 한 번에 하나만 보낸다. */
  readonly locked: boolean;
  readonly error: string | null;
  readonly onAsk: (action: TidyConfirmAction) => void;
  readonly onCancel: () => void;
  readonly onRun: (action: TidyAction) => void;
}

/**
 * 게스트 카드 아래에 붙는 정리 칸. 상태는 넷이다:
 *   판정 대기(뼈대) · 확인 단계 · 버튼(+ 못 지우는 이유) · 정리 불가(이유만).
 *
 * ⚠️ 문장은 전부 14px(`text-body-sm`)이다(§4). 버튼 글자만 12px — 라벨이라 허용된다.
 * ⚠️ 지우기 확인의 빨강은 **테두리·아이콘·버튼**이 진다. §4 의 빨강은 실패·취소 전용이고,
 *    되돌릴 수 없는 삭제는 그 "취소" 의 가장 센 형태다. 경고 문장 자체는 잉크로 쓴다 —
 *    빨간 문장은 본문 대비가 모자란다.
 * ⚠️ 지우기 확인에서 **초점은 `취소` 에 먼저 간다.** 확인 패널이 뜬 직후 한 번 더 Enter 를
 *    치는 손버릇이 영구 삭제로 이어지지 않게 하려는 것이다. 숨기기는 되돌릴 수 있으므로
 *    초점이 실행 버튼에 간다.
 */
function GuestTidyControls({
  person,
  state,
  loading,
  confirm,
  busy,
  locked,
  error,
  onAsk,
  onCancel,
  onRun,
}: GuestTidyControlsProps) {
  /*
    확인 단계에 들어서면 **버튼 하나로 초점을 옮긴다.** 누른 버튼이 확인 패널로 바뀌며
    사라지므로, 옮기지 않으면 초점이 `<body>` 로 떨어져 키보드 사용자가 창의 맨 처음으로
    돌아간다. 콜백 ref 를 `useCallback` 으로 고정해 **나타날 때 한 번만** 옮긴다.
  */
  const focusOnMount = useCallback((element: HTMLButtonElement | null) => {
    element?.focus();
  }, []);

  if (state === undefined) {
    return loading ? <Skeleton className="mt-1 h-8" /> : null;
  }

  const name = person.displayName;
  const footprint = state.footprint;
  const disabled = busy || locked;

  if (confirm === "hide") {
    return (
      <div className="mt-1 flex min-w-0 flex-col gap-2 rounded-md border border-border-strong bg-surface px-2.5 py-2">
        <p className="text-body-sm text-ink">
          <strong className="font-semibold">{name}</strong> 을(를) 후보 목록에서
          숨길까요? 지난 일정·수익·파티 명단에는 이름이 그대로 남고, 언제든 되돌릴 수
          있습니다.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            ref={focusOnMount}
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => onRun("hide")}
          >
            <EyeOff aria-hidden size={14} />
            {busy ? "숨기는 중…" : "숨기기"}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
            취소
          </Button>
        </div>
        {error === null ? null : <HelperText tone="error">{error}</HelperText>}
      </div>
    );
  }

  if (confirm === "delete") {
    return (
      <div className="mt-1 flex min-w-0 flex-col gap-2 rounded-md border border-error bg-surface px-2.5 py-2">
        <p className="flex items-start gap-1.5 text-body-sm text-ink">
          <TriangleAlert
            aria-hidden
            size={16}
            className="mt-0.5 shrink-0 text-error"
          />
          <span className="min-w-0">
            <strong className="font-semibold">되돌릴 수 없습니다.</strong>{" "}
            <strong className="font-semibold">{name}</strong> 을(를) 지우면 함께
            사라지는 것: 파티 {footprint.parties}곳의 구성원 자리 {footprint.seats}
            개(그 번호는 비워 두고 다시 쓰지 않습니다). 일정 참여·분배·드랍 기록은{" "}
            <strong className="font-semibold">0건</strong>이라 사라지는 기록은
            없습니다.
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button
            ref={focusOnMount}
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onCancel}
          >
            취소
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={disabled}
            onClick={() => onRun("delete")}
          >
            <Trash2 aria-hidden size={14} />
            {busy ? "지우는 중…" : "영구히 지우기"}
          </Button>
        </div>
        {error === null ? null : <HelperText tone="error">{error}</HelperText>}
      </div>
    );
  }

  /*
    정리할 수 없는 사람 — 이유만 말한다. 승계 · 남의 파티 · 파티 없음.
    (`history` 는 여기가 아니다 — 숨기기는 되므로 아래 버튼 칸에서 함께 말한다.)
  */
  if (!state.canHide) {
    const reason =
      state.blockReason === "claimed"
        ? "계정으로 전환된 사람이라 숨기거나 지울 수 없습니다. 이제 이 사람 본인이 계정으로 씁니다."
        : state.blockReason === "noParty"
          ? "어느 파티에도 들어 있지 않아 누가 만든 사람인지 알 수 없습니다. 정리할 수 없습니다."
          : "다른 사람의 파티에도 들어 있어 정리할 수 없습니다. 그 파티 사람들도 이 이름을 쓰고 있습니다.";
    return <p className="mt-1 text-body-sm text-ink-muted">{reason}</p>;
  }

  const history = describeHistory(footprint);

  return (
    <div className="mt-1 flex min-w-0 flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        {state.hidden ? (
          <Button
            size="sm"
            variant="secondary"
            disabled={disabled}
            onClick={() => onRun("unhide")}
          >
            <Eye aria-hidden size={14} />
            {busy ? "되돌리는 중…" : "다시 보이기"}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onAsk("hide")}
            aria-label={`${name} 숨기기`}
          >
            <EyeOff aria-hidden size={14} />
            숨기기
          </Button>
        )}
        {state.canDelete ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={disabled}
            onClick={() => onAsk("delete")}
            aria-label={`${name} 지우기`}
          >
            <Trash2 aria-hidden size={14} />
            지우기
          </Button>
        ) : null}
      </div>
      {state.canDelete ? null : (
        <p className="text-body-sm text-ink-muted">
          지난 기록이 있어 지울 수 없습니다 — {history}.{" "}
          {state.hidden ? "숨긴 채로 두면 됩니다." : "숨기기만 됩니다."}
        </p>
      )}
      {error === null ? null : <HelperText tone="error">{error}</HelperText>}
    </div>
  );
}
