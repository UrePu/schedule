"use client";

/**
 * PipelinePro 컴포넌트 쇼케이스 — **개발용 경로 `/showcase`**.
 *
 * 제품 화면이 아니다. 디자인 토큰과 컴포넌트가 살아 있는지 눈으로 확인하는 용도이며
 * **프로덕션 내비게이션에서 링크하지 않는다.** 지우지도 않는다 — 토큰을 고칠 때마다
 * 전 컴포넌트를 한 화면에서 대조할 수 있는 곳이 여기뿐이다.
 *
 * 모든 기본/상태/도메인 컴포넌트의 variant · size · 상태를 눈으로 확인하기 위한 화면이다.
 * 실제 데이터는 연결하지 않는다 — 전부 하드코딩 예시다.
 *
 * 이 페이지만 `"use client"` 다. 칩 선택·체크박스·툴팁·재시도 같은 상호작용을 보여 주려면
 * 상태가 필요하기 때문이며, 컴포넌트 라이브러리 쪽은 Checkbox/Tooltip 만 클라이언트다.
 *
 * 시각은 전부 고정값을 주입한다. `new Date()` 를 쓰면 SSR/CSR 결과가 갈려
 * 하이드레이션 불일치가 난다.
 */

import {
  CalendarClock,
  Coins,
  Search,
  Swords,
  TriangleAlert,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import {
  BOSS_DIFFICULTIES,
  BOSS_DIFFICULTY_LABEL,
  BossCard,
  MesoAmount,
  PartyOption,
  PartyOptionGrid,
  SeatNumber,
  TimeUntil,
  WeekLabel,
  myPartyLens,
  resolveMyPartyOption,
  type PartyOptionData,
} from "@/components/domain";
import { PAGE_SHELL_CLASS } from "@/components/layout";
/*
 * ⚠️ **전시 화면이 기능 컴포넌트를 쓰는 유일한 자리다**(2026-10-19). 파티 고르기 창은
 *    `/parties` 안에만 살고 그 화면은 로그인한 사람의 파티를 읽으므로, **비로그인으로
 *    폭을 재려면** 여기서 띄워야 한다. 데이터는 여전히 하드코딩 예시다.
 */
import {
  MemberPicker,
  PartyBar,
  PartyPickerDialog,
  type PendingGuest,
} from "@/features/schedule/components";
import type { GuestTidySource } from "@/features/schedule/components/member-select-grid";
import type {
  GuestManageState,
  Party,
  PartyMember,
  Person,
  PersonId,
  RunCharacterOption,
} from "@/types/domain";
import {
  Button,
  Card,
  CardDescription,
  CardOverline,
  CardTitle,
  Checkbox,
  DurationField,
  EmptyState,
  ErrorState,
  FilterChip,
  HelperText,
  Input,
  Label,
  ListItem,
  Radio,
  Skeleton,
  SkeletonGroup,
  StatusChip,
  Tooltip,
  type ButtonSize,
  type ButtonVariant,
  type StatusTone,
} from "@/components/ui";

/** 고정 기준 시각 (2026-08-17 21:30 KST). 하이드레이션 안정성을 위해 상수. */
const NOW = new Date("2026-08-17T21:30:00+09:00");
const IN_20_MIN = new Date("2026-08-17T21:50:00+09:00");
const IN_3_HOURS = new Date("2026-08-18T00:30:00+09:00");
const IN_2_DAYS = new Date("2026-08-19T22:00:00+09:00");
const PAST = new Date("2026-08-17T19:00:00+09:00");

const BUTTON_VARIANTS: readonly ButtonVariant[] = [
  "primary",
  "secondary",
  "ghost",
  "destructive",
];
const BUTTON_SIZES: ReadonlyArray<{ size: ButtonSize; label: string }> = [
  { size: "sm", label: "Small 32px" },
  { size: "md", label: "Medium 38px" },
  { size: "lg", label: "Large 46px" },
];
const STATUS_TONES: ReadonlyArray<{ tone: StatusTone; label: string }> = [
  { tone: "done", label: "완료 (won)" },
  { tone: "soon", label: "임박 (at-risk)" },
  { tone: "failed", label: "실패 (lost)" },
];

const MESO_SAMPLES: ReadonlyArray<{ label: string; value: number | null }> = [
  { label: "카오스 검은 마법사", value: 3_200_000_000 },
  { label: "익스트림 세렌", value: 324_000_000 },
  { label: "하드 스우", value: 85_000_000 },
  { label: "노멀 루시드", value: 12_345 },
  { label: "이지 매그너스", value: 9_999 },
  { label: "노멀 벨로나 (§1.3 D4)", value: null },
];

/**
 * 파티 전시용 하드코딩 데이터.
 *
 * ★ 시에스 내가 들고 가는 캐릭터(`mine`)는 **실제 해산 함수를 그대로 통해** 만든다
 *   (`myPartyLens` + `resolveMyPartyOption`). 직접 운줄하면 전시 화면이 제품 화면에서
 *   나올 수 없는 조합을 보여 주게 되고, 그러면 전시가 거짓이 된다.
 * ★ 세 줄이 `mine` 의 상태 세 가지를 각각 만들어 낸다 — 아래 주석 참고.
 */
const SHOWCASE_LENS = myPartyLens([
  { name: "더죀", isMain: true },
  { name: "무르개르", isMain: false },
]);

const SHOWCASE_PARTIES: readonly PartyOptionData[] = (
  [
    {
      /* 지정됨 — 부캐로 들어가 있으밋로 폴백일 수 없다(`assigned: true`). */
      partyId: "sc-1",
      name: "무르개르 림홈 돌먹",
      memberCount: 3,
      members: [
        {
          displayName: "더죀",
          characterName: "무르개르",
          characterLevel: 285,
          characterClass: "은월",
          characterImageUrl: null,
          isGuest: false,
        },
        {
          displayName: "풍무고불빠따",
          characterName: "풍무고불빠따",
          characterLevel: 291,
          characterClass: "아랗",
          characterImageUrl: null,
          isGuest: false,
        },
        {
          displayName: "신복관",
          characterName: "신복관",
          characterLevel: 276,
          characterClass: "바이페라",
          characterImageUrl: null,
          isGuest: true,
        },
      ],
      bosses: [
        {
          bossDifficultyId: "limbo_hard",
          koreanName: "하드 림보",
          difficulty: "hard",
        },
        {
          bossDifficultyId: "seren_extreme",
          koreanName: "엑스트림 세렌",
          difficulty: "extreme",
        },
      ],
    },
    {
      /* 지정 없음 — 이름은 본캐 폴백이라 보이지만 경고가 붙는다. */
      partyId: "sc-2",
      name: "본캐 림홈 돌먹",
      memberCount: 2,
      members: [
        {
          displayName: "더죀",
          characterName: "더죀",
          characterLevel: 295,
          characterClass: "카인",
          characterImageUrl: null,
          isGuest: false,
        },
        {
          displayName: "풍무고불빠따",
          characterName: "풍무고불빠따",
          characterLevel: 291,
          characterClass: "아랗",
          characterImageUrl: null,
          isGuest: false,
        },
      ],
      bosses: [
        {
          bossDifficultyId: "limbo_hard",
          koreanName: "하드 림보",
          difficulty: "hard",
        },
      ],
    },
    {
      /* 보여 줄 춐릭터가 없다 — 내 캐릭터 이름을 가진 줄이 없다. */
      partyId: "sc-3",
      name: "이름이 아주 긴 파티 — 잘림을 보는 줄",
      memberCount: 6,
      members: [
        {
          displayName: "바이보라",
          characterName: "바이보라",
          characterLevel: 288,
          characterClass: "향후사",
          characterImageUrl: null,
          isGuest: false,
        },
        {
          displayName: "죄린",
          characterName: "죄린",
          characterLevel: 284,
          characterClass: "보우마스트",
          characterImageUrl: null,
          isGuest: false,
        },
        {
          displayName: "콜라이제없어",
          characterName: null,
          characterLevel: null,
          characterClass: null,
          characterImageUrl: null,
          isGuest: true,
        },
      ],
      bosses: [
        {
          bossDifficultyId: "kalos_chaos",
          koreanName: "카오스 칼로스",
          difficulty: "chaos",
        },
        {
          bossDifficultyId: "kaling_hard",
          koreanName: "하드 카링",
          difficulty: "hard",
        },
        {
          bossDifficultyId: "lucid_hard",
          koreanName: "하드 루시드",
          difficulty: "hard",
        },
        {
          bossDifficultyId: "will_hard",
          koreanName: "하드 주넉",
          difficulty: "hard",
        },
      ],
    },
  ] satisfies readonly Omit<PartyOptionData, "mine">[]
).map((party, index) => ({
  ...party,
  /*
    ★ 세 번째 줄은 확정값을 넘긴다(`false`) — 제품에서는 `fetchPartyMembers` 를
      돌린 파티가 그렇게 한다. 나머지는 추룠 경로를 그대로 태워 보여 주고,
      그래서 sc-2 는 `assigned: null`(가를 수 없음)이 아니라… 샡팅에서 보여 주려는
      상태가 **경고 부업**이묀로 `false` 를 넘긴다.
  */
  mine: resolveMyPartyOption(
    party.members,
    SHOWCASE_LENS,
    index === 1 ? false : undefined,
  ),
  /*
    ★ **둘째 줄(`subtitle`)** — 2026-10-16(2단계)에 더해진 칸이다. 일정 잡기가 고르는
      대상이 파티에서 **보스 묶음**으로 바뀌면서, 줄이 "어느 파티의 조합인가" 를 말해야
      한다(묶음 이름은 `익세 하대 하카 3인` 처럼 보스 줄임말이라 그것만으로는 구분이
      안 된다). 전시에서는 **한 줄만** 넣어 둔다 — 있는 줄과 없는 줄을 나란히 놓아야
      "없으면 그리지 않는다" 는 규약이 눈에 보인다.
  */
  ...(index === 0 ? { subtitle: "본캐 고정팟" } : {}),
}));

/**
 * **33개로 부풀린 목록** — `PartyPickerDialog` 전시·측정용 (2026-10-19).
 *
 * 창을 고칠 때 재야 하는 것은 "세 줄이 들어가는가" 가 아니라 **실제 규모에서 찾을 수
 * 있는가**다. 2026-10-19 실측 활성 파티가 33개이므로 그 수에 맞춰 돌려 쓴다.
 * 이름 뒤에 번호를 붙여 검색이 실제로 좁히는지 눈으로 볼 수 있게 한다.
 */
const SHOWCASE_PARTIES_MANY: readonly PartyOptionData[] = Array.from(
  { length: 33 },
  (_unused, index) => {
    const base = SHOWCASE_PARTIES[index % SHOWCASE_PARTIES.length];
    /* 위 배열이 비어 있을 수 없지만, 타입상 `undefined` 를 가려야 한다. */
    if (base === undefined) throw new Error("SHOWCASE_PARTIES is empty");
    return {
      ...base,
      partyId: `sc-many-${String(index + 1)}`,
      name: `${base.name} ${String(index + 1)}`,
    };
  },
);

/**
 * `PartyBar` 전시·측정용 묶음 (2026-10-19).
 *
 * ★ **진짜 컴포넌트를 띄운다.** 여는 버튼의 모양을 여기 베껴 쓰면 두 벌이 되고, 재는
 *   대상이 제품이 아니게 된다. `PartyBar` 는 조회를 하지 않고 프롭만 받으므로
 *   (§2.4 Rule 1 — 데이터의 주인은 부모의 쿼리 캐시다) 고정값으로 그대로 뜬다.
 * ★ 첫 줄 이름을 **일부러 길게** 둔다. 폭 320px 에서 `min-w-0 truncate` 가 실제로
 *   일하는지(= 가로 스크롤이 안 생기는지) 그 줄이 판정한다.
 */
const SHOWCASE_BAR_PARTIES: readonly Party[] = SHOWCASE_PARTIES_MANY.map(
  (party, index): Party => ({
    partyId: party.partyId,
    isOwner: index === 0,
    name:
      index === 0
        ? `${party.name} — 아주 긴 파티 이름으로 잘림을 확인한다`
        : party.name,
    visibility: "private",
    defaultCapacity: party.memberCount,
    memberCount: party.memberCount,
    members: party.members,
    nameIsCustom: true,
    bosses: party.bosses,
  }),
);

const SHOWCASE_BAR_MEMBERS: readonly PartyMember[] = (
  SHOWCASE_PARTIES[0]?.members ?? []
).map(
  (member, index): PartyMember => ({
    personId: `sc-person-${String(index)}`,
    displayName: member.displayName,
    isGuest: member.isGuest,
    participantId: `sc-participant-${String(index)}`,
    seatNo: index + 1,
    characterId:
      member.characterName === null ? null : `sc-character-${String(index)}`,
    characterName: member.characterName,
    isMainCharacter: index === 0,
  }),
);

const SHOWCASE_BAR_CHARACTERS: readonly RunCharacterOption[] = [
  {
    characterId: "sc-character-0",
    name: "무르겨르",
    worldName: "스카니아",
    className: "은월",
    level: 285,
    isMain: true,
    bossMinutes: {},
  },
];

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * **후보 70명** — `MemberPicker` 전시·측정용 (2026-10-19)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 2026-10-19 실측: 파티에 넣을 수 있는 후보가 **70명**(게스트 59 + 앱 사용자 11)이고
 * 그 자리에 검색이 한 줄도 없었다. 게스트 59개의 **이름 종류는 49개** — 같은 이름이
 * 8종 겹쳐 있었다. 그래서 전시도 그 규모와 그 **중복**을 그대로 만든다:
 *   · `구름아이` 를 **둘** 넣는다(실제로 둘 있었던 이름이다). 검색했을 때 **둘 다**
 *     보이는지, "이미 2명 있습니다" 가 뜨는지 여기서 잰다.
 *   · 이름을 일부러 길게 둔 줄이 하나 있다 — 폭 320px 에서 `truncate` 가 실제로
 *     일하는지(= 가로 스크롤이 안 생기는지) 그 줄이 판정한다.
 */
const SHOWCASE_PEOPLE: readonly Person[] = [
  /* 앱 사용자 11명 — 첫 줄이 열람자 본인 자리다(후보 조회가 본인을 맨 앞에 둔다). */
  ...[
    "더죀",
    "우레푸",
    "라이언",
    "어피치",
    "프로도",
    "네오",
    "제이지",
    "콘",
    "튜브",
    "무지",
    "아주 긴 닉네임으로 잘림을 확인하는 사람",
  ].map(
    (displayName, index): Person => ({
      personId: `sc-user-${String(index)}` as PersonId,
      displayName,
      isGuest: false,
    }),
  ),
  /* 게스트 59명. 두 번째 `구름아이` 가 **같은 이름 다른 행**이다(실측 상황 재현). */
  ...Array.from({ length: 59 }, (_unused, index): Person => {
    const names = [
      "구름아이",
      "죠린",
      "카더우드",
      "깜고봄이",
      "정보원",
      "정부삼",
      "구르",
      "pl2y",
      "콜라이제없어",
      "풍무고불빠따",
    ];
    const base = names[index % names.length] ?? "게스트";
    return {
      personId: `sc-guest-${String(index)}` as PersonId,
      /* 0번과 10번이 **둘 다** `구름아이` 가 되도록 10번만 접미사를 붙이지 않는다. */
      displayName:
        index < names.length || index === names.length
          ? base
          : `${base}${String(Math.floor(index / names.length))}`,
      isGuest: true,
    };
  }),
];

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 게스트 정리 전시용 판정 (2026-10-21)
 * ═════════════════════════════════════════════════════════════════════════════
 * 서버 없이 네 갈래를 전부 보이게 만든다. 실제 판정은 SQL(`guest_manage_states`)이 하고,
 * 여기 값은 **모양을 재기 위한** 하드코딩이다:
 *   · `구름아이`(첫 번째) — 일정 참여 4건 → **숨기기만**(실측: 중복 한쪽이 4건을 진다)
 *   · `구름아이`(두 번째) — 기록 0건 → 숨기기 + **지우기**
 *   · `죠린`(첫 번째)      — 승계됨 → 둘 다 불가, 이유만
 *   · `카더우드`(첫 번째)  — 남의 파티에도 있음 → 둘 다 불가, 이유만
 *   · `정보원`(첫 번째)    — 처음부터 숨겨 둠 → 아래 "숨긴 사람" 칸에 나온다
 *   · `정부삼`(첫 번째)    — 지우기를 누르면 **실패**한다 → 오류 문구 자리를 잰다
 *   · 나머지 — 셋 중 하나꼴로 기록이 있고, 나머지는 지울 수 있다.
 */
function showcaseGuestState(person: Person, hidden: boolean): GuestManageState {
  const index = Number(person.personId.replace("sc-guest-", ""));
  const zero = {
    seats: 1,
    parties: 1,
    signups: 0,
    dropShares: 0,
    dropRefs: 0,
    runsAuthored: 0,
    bundleSettings: 0,
    claimLogs: 0,
    invites: 0,
    availability: 0,
    historyTotal: 0,
  };
  const base = {
    personId: person.personId,
    displayName: person.displayName,
    hidden,
  };
  if (index === 1) {
    return {
      ...base,
      canHide: false,
      canDelete: false,
      blockReason: "claimed",
      footprint: { ...zero, seats: 0, parties: 0, claimLogs: 1, historyTotal: 1 },
    };
  }
  if (index === 2) {
    return {
      ...base,
      canHide: false,
      canDelete: false,
      blockReason: "notMine",
      footprint: { ...zero, seats: 2, parties: 2 },
    };
  }
  const withHistory = index === 0 || (index > 10 && index % 3 === 0);
  if (withHistory) {
    const signups = index === 0 ? 4 : (index % 5) + 1;
    const dropShares = index % 2 === 0 ? 1 : 0;
    return {
      ...base,
      canHide: true,
      canDelete: false,
      blockReason: "history",
      footprint: {
        ...zero,
        signups,
        dropShares,
        historyTotal: signups + dropShares,
      },
    };
  }
  return {
    ...base,
    canHide: true,
    canDelete: true,
    blockReason: null,
    footprint: { ...zero, seats: index === 10 ? 2 : 1, parties: index === 10 ? 2 : 1 },
  };
}

/** 전시용 지연 — "처리 중…" 상태가 눈에 보일 만큼만. */
function showcaseDelay(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 400);
  });
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="font-headline text-subhead text-ink">{title}</h2>
        {description ? (
          <p className="text-body-sm text-ink-muted">{description}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-6">
      <p className="w-40 shrink-0 text-caption text-ink-muted">{label}</p>
      <div className="flex flex-wrap items-center gap-3">{children}</div>
    </div>
  );
}

export default function ShowcasePage() {
  const [filters, setFilters] = useState<ReadonlySet<string>>(
    () => new Set(["hard"]),
  );
  const [agreed, setAgreed] = useState(false);
  const [world, setWorld] = useState("scania");
  const [selectedSeat, setSelectedSeat] = useState(2);
  const [retryCount, setRetryCount] = useState(0);
  /** `DurationField` 전시용. `null` 은 "정하지 않음"이고 0 도 20 도 아니다. */
  const [duration, setDuration] = useState<number | null>(20);
  /**
   * `PartyPickerDialog` 전시용 (2026-10-19).
   *
   * 이 창은 `/parties` 안에서만 열리고 그 화면은 로그인한 사람의 파티를 읽으므로,
   * **비로그인으로 폭을 재려면 여기여야 한다.** 재는 것이 목적이라 목록을 33개로
   * 부풀려 둔다 — 실측 활성 파티 수가 그만큼이다.
   */
  const [partyPickerOpen, setPartyPickerOpen] = useState(false);
  const [pickedShowcaseParty, setPickedShowcaseParty] = useState("sc-1");
  /**
   * `MemberPicker` 전시용 (2026-10-19). 이 블록은 파티 만들기·편집 창 안에만 있고 그
   * 창들은 로그인한 사람의 후보를 읽으므로, **비로그인으로 검색과 폭을 재려면 여기여야
   * 한다.** 후보는 실측 규모인 70명이다(`SHOWCASE_PEOPLE`).
   */
  const [pickedPeople, setPickedPeople] = useState<ReadonlySet<PersonId>>(
    () => new Set<PersonId>(["sc-user-0"]),
  );
  const [showcaseGuests, setShowcaseGuests] = useState<readonly PendingGuest[]>(
    [],
  );
  /** 게스트 정리 전시용(2026-10-21). 숨김·삭제는 이 화면 안에서만 산다. */
  const [showcaseHidden, setShowcaseHidden] = useState<ReadonlySet<PersonId>>(
    () => new Set<PersonId>(["sc-guest-4" as PersonId]),
  );
  const [showcaseDeleted, setShowcaseDeleted] = useState<
    ReadonlySet<PersonId>
  >(() => new Set<PersonId>());
  const showcasePickerPeople = useMemo(
    () =>
      SHOWCASE_PEOPLE.filter(
        (person) => !showcaseDeleted.has(person.personId),
      ).map(
        (person): Person =>
          showcaseHidden.has(person.personId)
            ? { ...person, hidden: true }
            : person,
      ),
    [showcaseDeleted, showcaseHidden],
  );
  const showcaseTidy = useMemo<GuestTidySource>(
    () => ({
      snapshot: {
        available: true,
        guests: showcasePickerPeople
          .filter((person) => person.isGuest)
          .map((person) =>
            showcaseGuestState(person, person.hidden === true),
          ),
      },
      isLoading: false,
      isError: false,
      onRetry: () => undefined,
      setHidden: async (personId, hidden) => {
        await showcaseDelay();
        setShowcaseHidden((prev) => {
          const next = new Set(prev);
          if (hidden) next.add(personId);
          else next.delete(personId);
          return next;
        });
      },
      remove: async (personId) => {
        await showcaseDelay();
        if (personId === "sc-guest-5") {
          throw new Error(
            "전시용 실패입니다 — 서버가 거절했을 때 문구가 이 자리에 뜹니다.",
          );
        }
        setShowcaseDeleted((prev) => new Set(prev).add(personId));
        return personId === "sc-guest-10" ? 2 : 1;
      },
    }),
    [showcasePickerPeople],
  );

  const toggleFilter = (key: string) => {
    setFilters((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className="flex flex-col gap-3">
        <p className="rounded-md border border-dashed border-border-strong bg-neutral-100 px-3 py-2 text-caption text-ink-label">
          <strong className="font-semibold">개발용 경로입니다.</strong> 제품
          화면이 아니며 서비스 내비게이션에서 링크되지 않습니다. 디자인 토큰과
          컴포넌트가 살아 있는지 확인하는 용도입니다.
        </p>
        <p className="text-overline uppercase text-primary">
          PipelinePro component showcase
        </p>
        <h1 className="font-headline text-headline text-ink">
          M_Schedule 디자인 시스템
        </h1>
        <p className="max-w-2xl text-body-lg text-ink-muted">
          이후 모든 화면이 올라갈 기본·상태·도메인 컴포넌트 전시장입니다.
          데이터는 연결되어 있지 않으며 전부 하드코딩된 예시입니다.
        </p>
        <WeekLabel date={NOW} />
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/">
            <Button variant="secondary">← 홈으로</Button>
          </Link>
          {/* 핵심 화면(§1.4)으로 가는 입구. 쇼케이스는 부품 전시장일 뿐이다. */}
          <Link href="/parties">
            <Button>파티 관리 화면 열기 →</Button>
          </Link>
        </div>
      </header>

      {/* ------------------------------------------------------------ */}
      <Section
        title="Button"
        description="Primary / Secondary / Ghost / Destructive · 32 · 38 · 46px · disabled 40%. hover 는 마우스를 올려 확인하세요. Primary 는 active 시 scale 0.98 이 걸립니다."
      >
        <Card className="flex flex-col gap-4">
          {BUTTON_VARIANTS.map((variant) => (
            <Row key={variant} label={variant}>
              {BUTTON_SIZES.map(({ size, label }) => (
                <Button key={size} variant={variant} size={size}>
                  {label}
                </Button>
              ))}
              <Button variant={variant} disabled>
                disabled
              </Button>
              <Button variant={variant}>
                <Swords aria-hidden size={16} />
                아이콘
              </Button>
            </Row>
          ))}
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="Card"
        description="Default 는 hover 시 보더가 진해지고, Elevated 는 medium → large shadow 와 함께 2px 떠오릅니다."
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardOverline>Default</CardOverline>
            <CardTitle>1px border · 8px radius</CardTitle>
            <CardDescription className="mt-2">
              16px 패딩. hover 시 border 가 border-strong 으로 전이합니다.
            </CardDescription>
          </Card>
          <Card variant="elevated">
            <CardOverline>Elevated</CardOverline>
            <CardTitle>medium → large shadow</CardTitle>
            <CardDescription className="mt-2">
              hover 시 translateY(-2px). 전환은 200ms 입니다.
            </CardDescription>
          </Card>
        </div>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="Input · Label · HelperText"
        description="38px 높이, focus 시 primary 보더 + 3px ring(12%). error 와 disabled 상태를 함께 전시합니다."
      >
        <Card className="grid gap-5 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="showcase-nickname" required>
              본캐 닉네임
            </Label>
            <Input id="showcase-nickname" placeholder="예: Urepu" />
            <HelperText>계정 식별은 본캐 닉네임으로 합니다.</HelperText>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="showcase-key">NEXON Open API 키</Label>
            <Input
              id="showcase-key"
              invalid
              defaultValue="test_invalid_key"
              aria-describedby="showcase-key-help"
              className="font-mono text-code"
            />
            <HelperText id="showcase-key-help" tone="error">
              유효하지 않은 키입니다 (OPENAPI00005).
            </HelperText>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="showcase-disabled">월드 (비활성)</Label>
            <Input id="showcase-disabled" disabled defaultValue="스카니아" />
            <HelperText>월드는 캐릭터 정보에서 자동으로 채워집니다.</HelperText>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="showcase-search">보스 검색</Label>
            <Input id="showcase-search" type="search" placeholder="보스 이름" />
            <HelperText>placeholder 는 ink-placeholder 토큰입니다.</HelperText>
          </div>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="DurationField"
        description="보스 한 판의 소요 시간(분). 범위는 1~20 이고 DB CHECK 와 같은 경계입니다(2026-10-11 상한 정정 — 보스 한 판은 20분을 넘지 않고, 묶음 길이는 보스별 값의 합입니다 · 2026-10-21 하한 5 → 1 — 하드 진힐라는 1~2분). 빈 칸은 '정하지 않음'(null)이며 0 도 20 도 아닙니다 — placeholder 가 접힐 기본값을 말합니다. ⚠️ 폭을 재려고 여기 둡니다: 오류 상태의 문구가 칸 묶음의 폭을 늘리면 좁은 화면에서 가로 스크롤이 생깁니다(§4 금지). 320px 까지 줄여 보세요."
      >
        <Card className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="showcase-duration">
              소요 시간 — 값이 있는 상태
            </Label>
            <DurationField
              id="showcase-duration"
              value={duration}
              fallbackMinutes={20}
              allowUnset
              aria-label="쇼케이스 소요 시간"
              onChange={setDuration}
            />
            <HelperText>
              −/+ 는 즉시 확정되며 걸음이 구간마다 다릅니다 — 10분 이하는 1분,
              10분 위는 2분이고 짝수 칸에 맞춥니다(1·2·…·10·12·…·20 —
              11·13 처럼 격자에 없는 값은 타이핑이 경로입니다). 비우면 `null` 이 되어 placeholder 가 예상 시간(이 예시는 20)을
              말합니다. 지금 값:{" "}
              <strong className="font-semibold tabular-nums">
                {duration === null ? "null (정하지 않음)" : `${duration}분`}
              </strong>
            </HelperText>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="showcase-duration-error">
              소요 시간 — 범위를 벗어난 오류 상태
            </Label>
            {/*
              ★ **고정된 오류 상태**다. `value` 를 바꿀 수 없게 두고 칸에 범위 밖 값을
                심어 둔다 — 폭을 재는 쪽이 매번 숫자를 타이핑하지 않아도 되도록.
                (999 는 상한 20 을 넘으므로 `invalid` 분기가 켜진다.)
            */}
            <DurationField
              id="showcase-duration-error"
              value={999}
              fallbackMinutes={20}
              aria-label="쇼케이스 소요 시간 (오류 상태)"
              onChange={() => {
                /* 전시용. 폭 측정이 목적이라 값을 바꾸지 않는다. */
              }}
            />
            <HelperText>
              오류 문구는 `max-w-36`(144px) 로 묶여 있어 길어져도 **줄바꿈으로**
              가고 폭으로는 가지 않습니다. 컨트롤 줄(≈152px)이 묶음 폭을
              결정합니다.
            </HelperText>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="showcase-duration-disabled">
              소요 시간 — 비활성
            </Label>
            <DurationField
              id="showcase-duration-disabled"
              value={40}
              fallbackMinutes={20}
              allowUnset
              disabled
              aria-label="쇼케이스 소요 시간 (비활성)"
              onChange={() => {
                /* 전시용. */
              }}
            />
            <HelperText>
              일정 잡기 창에서 **체크를 끈 보스**가 이 상태입니다 — 전송 배열에
              실릴 자리가 없어 고칠 수 없게 둡니다.
            </HelperText>
          </div>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="Checkbox · Radio"
        description="16px 박스/원, 1.5px 보더. indeterminate 와 disabled 포함."
      >
        <Card className="flex flex-col gap-4">
          <Row label="checkbox">
            <Checkbox
              label="이번 주 클리어"
              checked={agreed}
              onChange={(event) => setAgreed(event.target.checked)}
            />
            <Checkbox label="선택됨" defaultChecked />
            <Checkbox label="부분 선택" indeterminate />
            <Checkbox label="비활성" disabled />
            <Checkbox label="비활성 + 선택" disabled defaultChecked />
            <Checkbox aria-label="라벨 없는 체크박스" />
          </Row>
          <Row label="radio">
            <Radio
              name="showcase-world"
              label="스카니아"
              value="scania"
              checked={world === "scania"}
              onChange={(event) => setWorld(event.target.value)}
            />
            <Radio
              name="showcase-world"
              label="루나"
              value="luna"
              checked={world === "luna"}
              onChange={(event) => setWorld(event.target.value)}
            />
            <Radio name="showcase-world-disabled" label="비활성" disabled />
            <Radio
              name="showcase-world-disabled"
              label="비활성 + 선택"
              disabled
              defaultChecked
            />
          </Row>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="Chip"
        description="FilterChip 은 선택 상태가 토글되고, StatusChip 은 won·at-risk·lost 3색을 완료·임박·실패로 매핑합니다."
      >
        <Card className="flex flex-col gap-4">
          <Row label="filter (클릭 가능)">
            {BOSS_DIFFICULTIES.map((difficulty) => (
              <FilterChip
                key={difficulty}
                selected={filters.has(difficulty)}
                onClick={() => toggleFilter(difficulty)}
              >
                {BOSS_DIFFICULTY_LABEL[difficulty]}
              </FilterChip>
            ))}
            <FilterChip disabled>비활성</FilterChip>
          </Row>
          <Row label="status">
            {STATUS_TONES.map(({ tone, label }) => (
              <StatusChip
                key={tone}
                status={tone}
                icon={<CalendarClock aria-hidden size={14} />}
              >
                {label}
              </StatusChip>
            ))}
          </Row>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="ListItem"
        description="44px 높이, 1px 구분선. 선택 항목은 좌측 2px primary 보더가 붙습니다."
      >
        <Card className="p-0">
          <ul className="overflow-hidden rounded-md">
            {[
              { seat: 1, name: "Urepu", note: "평일 21–24시" },
              { seat: 2, name: "Ryan", note: "화요일 제외 20시–" },
              { seat: 4, name: "Mocha", note: "주말만" },
            ].map((member) => (
              <ListItem
                key={member.seat}
                icon={<Users aria-hidden size={18} />}
                selected={selectedSeat === member.seat}
                onClick={() => setSelectedSeat(member.seat)}
                trailing={
                  <span className="text-caption text-ink-muted">
                    {member.note}
                  </span>
                }
              >
                <span className="inline-flex items-center gap-2">
                  <SeatNumber seatNo={member.seat} size="sm" />
                  {member.name}
                </span>
              </ListItem>
            ))}
            <ListItem icon={<Search aria-hidden size={18} />} disabled>
              비활성 항목
            </ListItem>
          </ul>
        </Card>
        <p className="text-caption text-ink-muted">
          3번이 비어 있는 것은 버그가 아닙니다 — 번호는 재배열되지 않는 안정
          식별자입니다 (§1.4).
        </p>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="Tooltip"
        description="외부 의존성 없이 구현했습니다. 300ms 지연, 240px 최대 폭, Escape 로 닫힙니다. 키보드 Tab 으로도 열립니다."
      >
        <Card>
          <Row label="hover / focus">
            <Tooltip content="결정석 가격은 솔로 기준입니다. 실지급은 파티 인원으로 나눈 값입니다.">
              <Button variant="secondary" size="sm">
                <Coins aria-hidden size={14} />
                결정석 가격이란?
              </Button>
            </Tooltip>
            <Tooltip
              content="주간 초기화는 매주 목요일 00:00 KST 입니다."
              delay={0}
            >
              <Button variant="ghost" size="sm">
                지연 0ms 버전
              </Button>
            </Tooltip>
          </Row>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="상태 — 로딩 · 빈 상태 · 에러"
        description="DoD(§0.3) 필수 3종. 스케줄러 응답이 비어 있는 것은 오류가 아니라 빈 상태입니다 (§1.1)."
      >
        <div className="grid gap-4 lg:grid-cols-3">
          <Card className="flex flex-col gap-3">
            <CardOverline>Loading</CardOverline>
            <SkeletonGroup label="보스 목록을 불러오는 중">
              <div className="flex items-center gap-3">
                <Skeleton shape="circle" className="size-10" />
                <div className="flex flex-1 flex-col gap-2">
                  <Skeleton shape="text" className="w-2/3" />
                  <Skeleton shape="text" className="w-1/3" />
                </div>
              </div>
              <Skeleton className="h-20 w-full" />
            </SkeletonGroup>
          </Card>

          <EmptyState
            icon={<Swords size={24} />}
            title="등록된 보스가 없습니다"
            description="해당 캐릭터가 그 날 접속하지 않았을 수도 있습니다. 오류가 아닙니다."
            action={<Button size="sm">보스 등록하기</Button>}
          />

          <ErrorState
            description="NEXON Open API 호출 한도를 초과했습니다. 잠시 후 다시 시도해 주세요."
            detail={`OPENAPI00007 · 재시도 ${retryCount}회`}
            onRetry={() => setRetryCount((count) => count + 1)}
          />
        </div>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="MesoAmount"
        description="항상 ko-KR 로케일. compact 는 한국식 축약이며 정확한 값은 title 속성에 있습니다. null 은 0 이 아니라 '미확인' 입니다 (§1.3 D4)."
      >
        {/*
          ⚠️ **표는 자기 `overflow-x-auto` 통 안에 둔다**(§4). 이 표는 네 열 × `px-4` 라
             min-content 가 362px 이고, 통이 없으면 폭 320px 에서 **페이지 전체가** 가로로
             넘친다(실측 2026-10-16: `/showcase` scrollWidth 362 / clientWidth 320).
             §4 가 허용하는 것은 "표가 더 넓은 것" 이지 "페이지가 넘치는 것" 이 아니다.
        */}
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-body-sm">
            <thead>
              <tr className="border-b border-border text-left text-caption text-ink-muted">
                <th className="px-4 py-2.5 font-medium">보스</th>
                <th className="px-4 py-2.5 font-medium">기본</th>
                <th className="px-4 py-2.5 font-medium">compact</th>
                <th className="px-4 py-2.5 font-medium">accent / muted</th>
              </tr>
            </thead>
            <tbody>
              {MESO_SAMPLES.map((sample) => (
                <tr
                  key={sample.label}
                  className="border-b border-neutral-100 last:border-b-0"
                >
                  <td className="px-4 py-2.5 text-ink-muted">{sample.label}</td>
                  <td className="px-4 py-2.5">
                    <MesoAmount value={sample.value} suffix={false} />
                  </td>
                  <td className="px-4 py-2.5">
                    <MesoAmount value={sample.value} compact />
                  </td>
                  <td className="px-4 py-2.5">
                    <MesoAmount
                      value={sample.value}
                      compact
                      suffix={false}
                      tone="accent"
                    />
                    <span className="px-2 text-ink-muted">/</span>
                    <MesoAmount
                      value={sample.value}
                      compact
                      suffix={false}
                      tone="muted"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="TimeUntil"
        description="임박·지각은 red 가 아니라 tertiary orange 입니다. red 는 실패·취소 전용입니다 (§4)."
      >
        <Card className="flex flex-col gap-3">
          <Row label="여유 (upcoming)">
            <TimeUntil target={IN_2_DAYS} now={NOW} />
          </Row>
          <Row label="임박 (imminent)">
            <TimeUntil target={IN_3_HOURS} now={NOW} />
            <TimeUntil target={IN_20_MIN} now={NOW} />
          </Row>
          <Row label="지각 (overdue)">
            <TimeUntil target={PAST} now={NOW} />
          </Row>
          <Row label="아이콘 없음">
            <TimeUntil target={IN_2_DAYS} now={NOW} hideIcon />
          </Row>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="WeekLabel"
        description="주간 초기화는 매주 목요일 00:00 KST. 초기화 시점을 항상 함께 표시합니다."
      >
        <Card className="flex flex-col gap-3">
          <Row label="기본">
            <WeekLabel date={NOW} />
          </Row>
          <Row label="주차 키 숨김">
            <WeekLabel date={NOW} showWeekKey={false} />
          </Row>
          <Row label="다음 주">
            <WeekLabel date={new Date("2026-08-21T10:00:00+09:00")} />
          </Row>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="SeatNumber"
        description="참가자 번호는 대기열이 아니라 관리용 안정 식별자입니다. 누가 나가도 재배열하지 않습니다 (§1.4)."
      >
        <Card className="flex flex-col gap-3">
          <Row label="tone">
            <SeatNumber seatNo={1} />
            <SeatNumber seatNo={2} tone="primary" />
            <SeatNumber seatNo={4} tone="muted" />
            <SeatNumber seatNo={12} />
          </Row>
          <Row label="size">
            <SeatNumber seatNo={1} size="sm" />
            <SeatNumber seatNo={1} size="md" />
          </Row>
        </Card>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="BossCard"
        description="난이도는 좌측 보더 색으로 인코딩합니다 (§4). 상태(완료·임박·실패)는 칩과 시간 표기가 담당하며 보더 색을 덮지 않습니다. 첫 카드(이지 매그너스)는 아이콘 파일이 없는 보스라 실루엣 폴백이 뜹니다 — 오류가 아닙니다."
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <BossCard
            bossName="매그너스"
            bossDifficultyId="magnus_easy"
            difficulty="easy"
            scheduledAt={IN_2_DAYS}
            now={NOW}
            crystalPrice={9_999_000}
          />
          <BossCard
            bossName="루시드"
            bossDifficultyId="lucid_normal"
            difficulty="normal"
            scheduledAt={IN_2_DAYS}
            now={NOW}
            crystalPrice={120_000_000}
            partySize={3}
            seatNo={1}
          />
          <BossCard
            bossName="스우"
            bossDifficultyId="lotus_hard"
            difficulty="hard"
            scheduledAt={IN_3_HOURS}
            now={NOW}
            crystalPrice={324_000_000}
            partySize={2}
            status="soon"
            seatNo={2}
          />
          <BossCard
            bossName="더스크"
            bossDifficultyId="dusk_chaos"
            difficulty="chaos"
            scheduledAt={PAST}
            now={NOW}
            crystalPrice={3_200_000_000}
            partySize={6}
            status="done"
            seatNo={4}
          />
          <BossCard
            bossName="세렌"
            bossDifficultyId="seren_extreme"
            difficulty="extreme"
            scheduledAt={IN_20_MIN}
            now={NOW}
            crystalPrice={1_400_000_000}
            partySize={2}
            status="failed"
            footer={
              <Button variant="ghost" size="sm">
                다시 등록
              </Button>
            }
          />
          <BossCard
            bossName="벨로나"
            bossDifficultyId="bellona_normal"
            difficulty="normal"
            scheduledAt={IN_3_HOURS}
            now={NOW}
            crystalPrice={null}
            partySize={3}
            footer={
              /* §4: 주황은 아이콘이 지고 문장은 잉크가 진다 (`WarningNote` 와 같은 규약). */
              <p className="flex items-center gap-1.5 text-caption text-ink">
                <TriangleAlert
                  aria-hidden
                  size={14}
                  className="text-tertiary"
                />
                가격 미확인 — 수익 합계에서 제외됩니다 (§1.3 D4).
              </p>
            }
          />
        </div>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="PartyOption — 파티를 고르는 자리 (card / chip)"
        description="네 화면이 공유하는 한 컴포넌트이고 밀도만 다릅니다 — 파티 관리 띠 · 일정 잡기(보스 묶음) · 보스 계획 등록. 첫 줄에만 둘째 줄(subtitle)이 있습니다: 묶음을 고를 때 어느 파티의 조합인지 말하는 칸이고, 없으면 그리지 않습니다. 2026-10-16 부터 ‘나’ 표식이 더해집니다 — 내가 이 파티에 내가 어느 춐릭터로 가는가. 아래 세 줄이 가능한 상태 전부입니다: 지정됨 / 지정 없음(본캐 폴백) / 보여 줄 춐릭터 없음. 폭 320·400px 리팔로 넘침을 봅니다."
      >
        {/*
          ⚠️ **`Row` 를 사용하지 않는다.** `Row` 의 내용 칸은 `flex flex-wrap`
             인 flex 아이템이고 `min-width: auto` 라, 속에 `w-max` 끔 띄를 넣으면
             그 아이템이 min-content(= 띄 전진폭)만큼 부풀어 **후솠중 쪽 포함
             페이지가 가로로 넘친다**(실제로 1024px 에서 scrollWidth 1203 이 나왔다).
             제품 화면(`party-bar`)은 띄가 `flex flex-col` 의 자식이라 이 함정이
             없다 — 전시도 그 배치를 똑같이 동일하게 맞춘다.
        */}
        <div className="flex flex-col gap-2">
          {/* 문장이라 14px 하한을 지킨다(§4) — 12px 는 숫자·배지 자리다. */}
          <p className="text-body-sm text-ink-muted">
            chip — ⚠️ 2026-10-19 부터 **제품 화면에 쓰는 자리가 없습니다.** 파티
            관리 띠가 모달로 바뀌면서 마지막 호출부가 사라졌고, 남은 것은 이 전시뿐
            입니다(얼굴 20px · 네 명까지 · 가로 스크롤 — 발주가 지적한 그 모양).
          </p>
          <div className="-mx-1 overflow-x-auto px-1 pb-1">
            <div
              role="group"
              aria-label="파티 선택 (전시)"
              className="flex w-max gap-2"
            >
              {SHOWCASE_PARTIES.map((party) => (
                <PartyOption
                  key={party.partyId}
                  party={party}
                  density="chip"
                  selected={party.partyId === "sc-1"}
                  onSelect={() => undefined}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-caption text-ink-muted">card (등록 창)</p>
          <PartyOptionGrid
            parties={SHOWCASE_PARTIES}
            selectedPartyId="sc-1"
            onSelect={() => undefined}
            className="max-h-none"
          />
        </div>
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="PartyPickerDialog — 파티 고르기 모달 (2026-10-19)"
        description="`/parties` 의 파티 전환이 가로 스크롤 칩 띠에서 이 창으로 바뀌었습니다. 얼굴이 20px(chip) → 40px(card) 이 되고, 띠가 없어지면서 가로 스크롤도 없어집니다. 목록은 실측 규모인 33개로 부풀려 두었습니다 — 검색이 실제로 좁히는지, 폭 320·400px 에서 창 안이 가로로 넘치지 않는지 여기서 잽니다. 이 창은 로그인한 사람의 파티를 읽는 화면 안에만 있으므로, 비로그인으로 재려면 이 자리여야 합니다."
      >
        <Button variant="secondary" onClick={() => setPartyPickerOpen(true)}>
          파티 고르기 창 열기 (33개)
        </Button>
        <p className="text-body-sm text-ink-muted">
          지금 고른 파티: {pickedShowcaseParty}
        </p>
        <PartyPickerDialog
          open={partyPickerOpen}
          onClose={() => setPartyPickerOpen(false)}
          parties={SHOWCASE_PARTIES_MANY}
          selectedPartyId={pickedShowcaseParty}
          onSelect={(partyId) => {
            setPickedShowcaseParty(partyId);
            setPartyPickerOpen(false);
          }}
          onCreateParty={null}
        />

        {/*
          ── 여는 버튼은 **제품 컴포넌트를 그대로** 띄워 잰다 ────────────────────
          `PartyBar` 는 조회 없이 프롭만 받으므로 고정값으로 뜬다. 베껴 쓰지 않는
          이유는 재는 대상이 제품이어야 하기 때문이다(`SHOWCASE_BAR_PARTIES` 머리말).
        */}
        <p className="text-body-sm text-ink-muted">
          아래는 `/parties` 상단 카드 전체입니다 — 고른 파티(얼굴 40px) · 바꾸기
          버튼 · 구성원 줄 · 내 참여 캐릭터 · 번호 설명.
        </p>
        <PartyBar
          parties={SHOWCASE_BAR_PARTIES}
          selectedPartyId={SHOWCASE_BAR_PARTIES[0]?.partyId ?? null}
          onSelectParty={() => undefined}
          onCreateParty={() => undefined}
          onEditRoster={() => undefined}
          onCopyParty={() => undefined}
          isCopying={false}
          copyErrorMessage={null}
          onDisbandParty={() => undefined}
          isDisbanding={false}
          disbandErrorMessage={null}
          members={SHOWCASE_BAR_MEMBERS}
          isPartiesLoading={false}
          isPartiesError={false}
          onPartiesRetry={() => undefined}
          isMembersLoading={false}
          isMembersError={false}
          onMembersRetry={() => undefined}
          viewerPersonId="sc-person-0"
          characters={SHOWCASE_BAR_CHARACTERS}
          onChangeMyCharacter={() => undefined}
          onInviteGuest={() => undefined}
        />
      </Section>

      {/* ------------------------------------------------------------ */}
      <Section
        title="MemberPicker — 구성원 찾기·추가·정리 (2026-10-19 · 10-21)"
        description="파티 만들기 마법사 2단계와 파티 편집 창이 쓰는 블록입니다. 후보를 실측 규모인 70명(게스트 59 + 사용자 11)으로 두었고 `구름아이` 가 일부러 둘 있습니다 — `구름` 을 치면 개수가 70에서 줄어드는지, 두 `구름아이` 가 둘 다 보이는지, 같은 이름을 적었을 때 ‘이미 2명 있습니다’ 가 뜨는지, 고른 사람이 검색에 걸러져도 아래에 남는지를 여기서 잽니다. 폭 320·400px 에서 가로로 넘치지 않는지도 같은 자리에서 봅니다. ‘게스트 정리’ 를 누르면 게스트 카드마다 숨기기·지우기와 못 하는 이유가 붙습니다 — 첫 `구름아이` 는 기록이 있어 숨기기만, 두 번째는 지우기까지, `죠린` 은 승계됨, `카더우드` 는 남의 파티에도 있음, `정보원` 은 처음부터 숨김, `정부삼` 은 지우기가 실패합니다."
      >
        <MemberPicker
          people={showcasePickerPeople}
          guestTidy={showcaseTidy}
          selectedIds={pickedPeople}
          onToggle={(personId) =>
            setPickedPeople((prev) => {
              const next = new Set(prev);
              if (next.has(personId)) {
                next.delete(personId);
              } else {
                next.add(personId);
              }
              return next;
            })
          }
          guests={showcaseGuests}
          onAddGuest={(guest) =>
            setShowcaseGuests((prev) => [...prev, guest])
          }
          onRemoveGuest={(name) =>
            setShowcaseGuests((prev) =>
              prev.filter((guest) => guest.name !== name),
            )
          }
        />
        <p className="text-body-sm text-ink-muted">
          고른 사람 {pickedPeople.size}명 · 추가 대기 {showcaseGuests.length}명
        </p>
      </Section>

      {/* ------------------------------------------------------------ */}
      <footer className="flex flex-col gap-2 border-t border-border pt-6">
        <p className="text-caption text-ink-muted">
          Data based on NEXON Open API
        </p>
        <p className="text-body-sm text-ink-muted">
          이 화면은 컴포넌트 전시용이며 실제 게임 데이터를 조회하지 않습니다.
        </p>
      </footer>
    </main>
  );
}
