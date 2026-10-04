"use client";

import { UserRound } from "lucide-react";
import { useState } from "react";

import { FilterChip } from "@/components/ui";
import { characterFirstName } from "@/lib/domain/participant-label";
import { cn } from "@/lib/utils";
import type { PartyBossBrief, PartyMemberBrief } from "@/types/domain";

import { BossIcon } from "./boss-icon";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 파티를 고르는 자리 — **한 컴포넌트, 두 밀도**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-10-04): *"파티를 선택하는부분은 전부다 같은 컴포넌트를 사용해서 좀
 * 보기 편하게 만들어"*
 *
 * 그 전까지 파티를 고르는 자리는 셋이 **서로 다른 언어로** 말하고 있었다:
 *
 *   `schedule/components/timetable-run-dialog.tsx`  얼굴 격자 (2026-10-04 에 추가)
 *   `boss-plans/components/plan-run-dialog.tsx`     `<select>` 드롭다운 — 얼굴 없음
 *   `schedule/components/party-bar.tsx`             가로 스크롤 칩 한 줄
 *
 * 같은 파티가 화면마다 다르게 보이면 "이 파티가 그 파티인가"를 매번 다시 풀어야 한다.
 * 그 비용이 실제로 컸던 이유는 **실측된 파티 이름이 서로 구분되지 않기 때문**이다 —
 * `발벨3인` · `세쌀카2인523` · `세쌀카2인물결` 처럼 보스 줄임말 + 인원이고, 글자까지
 * 똑같은 칩이 둘 있던 사례도 있다. 구분에 실제로 쓰이는 정보는 **누가 들어 있고 무엇을
 * 도는가**이고, 그건 사람이 글자보다 그림으로 훨씬 빨리 읽는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 합친 것은 **컴포넌트**이고, 통일한 것은 **크기가 아니다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `party-bar.tsx` 에는 *"칩 안에 이름을 넣으면 줄이 가로로 터지므로 `title` 로만
 * 말한다"* 는 2026-09-01 의 결정이 있었다. 그 결정은 지금도 옳다 — 칩은 좁다.
 * 그래서 밀도를 프롭으로 둔다:
 *
 *   `density="card"`  창에서 고를 때. 얼굴 40px · 보스 32px · 파티원 **이름 줄까지**.
 *                     자리가 넉넉하므로 글자로 정확히 확인할 기회를 남긴다.
 *   `density="chip"`  띠에서 고를 때. 한 줄 · 얼굴 20px · **이름 줄 없음.**
 *                     파티 이름 말고는 글자를 넣지 않고, 전체 정보는 `title` 이 진다.
 *                     즉 예전 결정을 어긴 것이 아니라 **그 결정을 변형으로 지킨 것**이다.
 *                     얼굴은 글자가 아니라 그림이라 가로로 터지지 않는다(20px 칸 일곱 개에
 *                     간격까지 ≈150px 로, 예전 칩이 이미 들고 있던 `max-w-40` 이름 한 줄과
 *                     같은 자리다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 조회는 **이 안에서 하지 않는다** (§2.4 Rule 1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 입력은 "파티 하나의 표시용 데이터"뿐이고 쿼리도 뮤테이션도 없다. 세 화면의 캐시
 * 전략(키 · staleTime · 무효화 목록)은 각자 다르고, 그걸 컴포넌트가 들고 있으면 화면
 * 데이터의 주인이 쿼리 캐시에서 컴포넌트로 옮겨 간다 — 그 순간 §2.4 Rule 1 이 깨진다.
 */

/**
 * 목록 한 줄에 그릴 얼굴 개수 상한. 넘으면 `+N` 으로 접는다.
 *
 * 6 인 이유는 **보스 파티의 상한이 대개 6인**이기 때문이다(§1 — 구세대 6 · 신세대 3 ·
 * 익스 스우 2). 즉 거의 모든 파티가 접히지 않고 전원 보이고, 접히는 것은 정원을 넘겨
 * 사람이 들락날락한 파티뿐이다.
 */
const MAX_FACES = 6;

/**
 * 칩 한 줄의 상한. `card` 보다 낮다 — 칩은 가로로 흐르는 띠 안에 있어서, 한 칩이
 * 넓어지면 **옆 칩이 화면 밖으로 밀린다.** 4 는 실측된 파티 대부분(2~4인)을 접지 않고
 * 덮는 값이고, 그 이상은 어차피 `title` 이 전부 말한다.
 */
const MAX_FACES_CHIP = 4;

/** 칩의 보스 얼굴 상한. 보스는 파티원보다 수가 적고(묶음 2~3개), 자리는 더 좁다. */
const MAX_BOSS_FACES_CHIP = 3;

/** 얼굴 칸 크기. `BossIcon` 의 `sm`(32px) / `xs`(20px) 과 **짝이 맞아야** 줄이 고르다. */
const FACE_BOX: Record<PartyOptionDensity, string> = {
  card: "size-10",
  chip: "size-5",
};

/**
 * `+N` 칩의 자리 크기 — **얼굴 칸과 따로 둔다.**
 *
 * `card`(40px)에서는 정사각이 맞다. 그런데 `chip` 의 20px 정사각에는 12px 글자로
 * `+12` 가 들어가지 않는다(세 글자 ≈ 21px). 파티 정원은 DB CHECK 로 24명까지라
 * 두 자리는 실제로 나올 수 있다. 그래서 칩에서는 **높이만 맞추고 가로는 글자에 맡긴다** —
 * `min-w-5` 가 한 자리일 때의 정사각 모양을 지킨다.
 */
const MORE_BOX: Record<PartyOptionDensity, string> = {
  card: "size-10",
  chip: "h-5 min-w-5 px-1",
};

export type PartyOptionDensity = "card" | "chip";

/**
 * 이 컴포넌트가 그리는 데 필요한 **전부**. 서버 타입(`Party`)의 부분집합이므로
 * 호출부는 그대로 넘기면 된다 — 변환 함수를 만들지 않는다.
 *
 * ★ `partyId` 가 `string` 인 이유: `PartyId` 는 `Party` 쪽 별칭이고, `/boss-plans` 는
 *   자기 payload 타입(`PlanRunParty`)으로 같은 값을 들고 온다. 넓은 쪽으로 받아
 *   두 화면이 같은 컴포넌트를 쓰는 데 캐스트가 필요 없게 한다.
 */
export interface PartyOptionData {
  readonly partyId: string;
  readonly name: string;
  readonly memberCount: number;
  readonly members: readonly PartyMemberBrief[];
  readonly bosses: readonly PartyBossBrief[];
}

export interface PartyOptionProps {
  readonly party: PartyOptionData;
  readonly density?: PartyOptionDensity;
  /** 고른 상태. `card` 는 테두리 + 면, `chip` 은 `FilterChip` 의 채움으로 말한다. */
  readonly selected?: boolean;
  readonly onSelect: (partyId: string) => void;
  readonly className?: string;
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * 한 줄에 들어가는 네 가지, 그리고 그 순서 (`card`)
 * ─────────────────────────────────────────────────────────────────────────────
 * ① 파티 이름 + 인원 · 보스 개수  ② **보스 얼굴**  ③ **파티원 얼굴**  ④ 파티원 이름 한 줄
 *
 * ★ 얼굴이 먼저이고 글자가 나중인 이유: 사람은 이름보다 그림을 훨씬 빨리 알아본다.
 *   그런데 **글자 줄을 지우지는 않았다** — 얼굴 칸(40px) 아래에 이름을 적으면 폭
 *   400px 에서 네 글자쯤에 잘려(`truncate`) 정작 구분이 안 된다. 그래서 얼굴은
 *   알아보는 데, 아래 한 줄은 정확히 확인하는 데 쓴다. 그 줄은 삭제된
 *   `party-select-bar.tsx` 의 닫힌 줄과 같은 규칙이다 — **캐릭터 이름만**, `·` 로
 *   이어 붙이고(`characterFirstName(...).lead`), 넘치면 잘린다.
 * ★ 보스 얼굴이 파티원보다 위인 이유: 파티 이름이 보스 줄임말(`발벨3인`)이라, 바로
 *   아래에서 그 줄임말이 무엇이었는지 확인된다.
 */
export function PartyOption({
  party,
  density = "card",
  selected = false,
  onSelect,
  className,
}: PartyOptionProps) {
  /*
    파티원 이름 한 줄 — **캐릭터 이름만** 적는다. `무르겨르 더저 · 라온내일` 처럼
    계정까지 붙이면 한 줄이 금세 잘리고, 잘리는 쪽은 언제나 뒤 — 즉 다음 사람의
    캐릭터다. 누구의 부캐인지는 얼굴 칸의 `title` 에서 본다.
  */
  const memberLine = party.members
    .map((member) => characterFirstName(member).lead)
    .join(" · ");

  if (density === "chip") {
    return (
      <FilterChip
        selected={selected}
        onClick={() => onSelect(party.partyId)}
        /*
          ★ **전체 정보는 `title` 이 진다** (2026-09-01 결정을 그대로 잇는다). 칩 안에
            이름을 넣으면 줄이 가로로 터지므로 글자는 파티 이름 하나뿐이고, 얼굴이
            그 자리를 대신한다. 얼굴은 **누구인지를 알려 주지만 이름을 말해 주지는
            않으므로**, 정확한 확인 경로가 여전히 필요하다.
          ★ 툴팁은 한 줄이라 **캐릭터만** 적는다(2026-09-02). 계정까지 붙이면 6인
            파티에서 열두 낱말이 되어 툴팁이 두 줄로 접힌다 — 칩을 구분하려고 띄운
            것이 새 읽을거리가 되면 안 된다.
        */
        title={[
          party.name,
          `${String(party.memberCount)}명`,
          ...(party.bosses.length > 0
            ? [party.bosses.map((boss) => boss.koreanName).join(", ")]
            : []),
          ...(memberLine === "" ? [] : [memberLine]),
        ].join(" · ")}
        className={className}
      >
        <span className="max-w-40 truncate">{party.name}</span>
        <span className="tabular-nums opacity-80">{party.memberCount}</span>
        <BossFaceRow
          bosses={party.bosses}
          max={MAX_BOSS_FACES_CHIP}
          density="chip"
        />
        <MemberFaceRow
          members={party.members}
          max={MAX_FACES_CHIP}
          density="chip"
        />
      </FilterChip>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(party.partyId)}
      aria-pressed={selected}
      className={cn(
        "flex h-full w-full flex-col gap-2 rounded-lg border bg-surface px-3 py-2.5 text-left",
        "transition duration-200 hover:border-primary hover:bg-hover-surface",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
        /*
          고른 줄은 **테두리와 면 두 채널로** 말한다. 색 하나로만 말하면 색각 이상에서
          구분이 사라지고, `aria-pressed` 가 보조 기술 쪽 세 번째 채널이다.
        */
        selected ? "border-primary bg-primary-subtle" : "border-border",
        className,
      )}
    >
      <span className="flex w-full flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="min-w-0 flex-1 truncate text-body font-semibold text-ink">
          {party.name}
        </span>
        <span className="shrink-0 text-caption tabular-nums text-ink-muted">
          {party.memberCount}명
          {party.bosses.length === 0
            ? ""
            : ` · 보스 ${String(party.bosses.length)}`}
        </span>
      </span>

      <BossFaceRow bosses={party.bosses} max={MAX_FACES} density="card" />
      <MemberFaceRow members={party.members} max={MAX_FACES} density="card" />

      {memberLine === "" ? null : (
        <span className="w-full truncate text-body-sm text-ink-muted">
          {memberLine}
        </span>
      )}
    </button>
  );
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * `card` 밀도의 **배치**까지 함께 소유한다
 * ─────────────────────────────────────────────────────────────────────────────
 * 모달은 넓은 화면에서 `max-w-5xl` 까지 쓰므로 한 열로 세우면 줄이 가로로 늘어지고
 * 세로로만 길어진다. 반으로 잘라 두 열로 놓으면 같은 높이에 **두 배가 보인다.**
 * 좁은 화면(<640px)에서는 **한 열**이다 — 거기서 두 열은 줄당 170px 남짓이라 얼굴
 * 40px 이 네 개도 못 들어간다. (삭제된 `party-picker-dialog.tsx` 의 배치 근거 그대로.)
 * `items-stretch` + 버튼 `h-full` — 옆 줄과 파티원 수가 달라도 높이가 맞는다.
 *
 * ⚠️ **`<li>` 의 `min-w-0` 이 없으면 좁은 폭에서 가로 스크롤이 생긴다.** 격자 트랙은
 *    `minmax(auto, 1fr)` 이라 자동 최소 크기가 칸의 **min-content** 이고, 파티원 이름
 *    줄은 `truncate`(=`white-space: nowrap`)라 min-content 가 **잘리지 않은 전체 문장
 *    폭**이다. 즉 이름이 길면 트랙이 그만큼 벌어진다. 세로 flex 목록에서는 교차축이라
 *    이 규칙이 적용되지 않았는데, 2열 격자로 바꾸면서 생긴 자리다. 0 으로 못박아
 *    `truncate` 가 제 일을 하게 한다. **이 가드가 배치와 함께 여기 사는 이유**가
 *    그것이다 — 격자를 만든 쪽이 가드도 가져야 호출부가 빼먹을 수 없다.
 */
export interface PartyOptionGridProps {
  readonly parties: readonly PartyOptionData[];
  readonly selectedPartyId?: string | null;
  readonly onSelect: (partyId: string) => void;
  /** 높이 제한을 자리마다 달리 줄 수 있게 열어 둔다. 기본은 모달 목록용 `max-h-[60vh]`. */
  readonly className?: string;
}

export function PartyOptionGrid({
  parties,
  selectedPartyId = null,
  onSelect,
  className,
}: PartyOptionGridProps) {
  return (
    <ul
      /*
        목록 자체가 자기를 말한다. `<Label htmlFor>` 는 폼 컨트롤 **하나**를 가리키는
        장치라 버튼 여러 개인 이 격자에는 걸 수 없다 — 선택 여부는 각 버튼의
        `aria-pressed` 가 진다.
      */
      aria-label="파티 선택"
      className={cn(
        "grid max-h-[60vh] grid-cols-1 items-stretch gap-2 overflow-y-auto sm:grid-cols-2",
        className,
      )}
    >
      {parties.map((party) => (
        <li className="min-w-0" key={party.partyId}>
          <PartyOption
            party={party}
            density="card"
            selected={party.partyId === selectedPartyId}
            onSelect={onSelect}
          />
        </li>
      ))}
    </ul>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 얼굴 — 파티원 초상화 · 보스 아이콘
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 파티원 한 명 = **네모 초상화 한 칸** (삭제된 `party-picker-dialog.tsx` 에서 가져옴)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 원래 자리의 근거를 그대로 옮긴다 — 같은 값을 다시 유도하다 틀리는 것을 막기 위해서다.
 *
 * ★ **`scale-[5]` 는 감이 아니라 실측값이다.** 넥슨 `character_image` 는 항상 300×300
 *   PNG 이고 그 안에서 캐릭터는 `y≈129~208` · `x≈108~184` 에만 그려져 있다. 나머지는
 *   투명 여백이라 칸을 키워도 **여백만 커진다.** 머리 띠(`y≈129~174`)의 세로 중심이
 *   `y≈151` 로 캔버스 중심 150 과 사실상 같아서 **`transform-origin` 을 건드릴 필요가
 *   없다** — 기본값(중앙)에서 배율만 올리면 얼굴이 가운데에 온다.
 *   배율 5 는 가운데 `300/5 = 60px`(y 120~180)만 보여 주므로 머리 띠가 통째로 들어오고
 *   아래 6px 이 목이다. 발주가 말한 **얼굴 + 목 조금**이 이 배율이고(2026-09-03:
 *   *"얼굴과 목 조금? 만 나오게 확대가능?"*), 5.6 은 머리카락 옆이 과하게 잘려 **5 가
 *   상한**이다. **잘려 나가는 비율은 칸 크기와 무관하므로** 칸이 40px 이어도 20px
 *   이어도 구도는 같다 — `chip` 밀도에서 배율을 다시 계산하지 않는 근거가 이것이다.
 * ★ **실패한 URL 자체를 담는다**(불린이 아니다). 불린이면 새 URL 이 들어올 때 effect 로
 *   초기화해야 하는데 그건 프롭 변화를 쫓는 동기화라 렌더 연쇄를 만든다. URL 을 담으면
 *   비교 한 번으로 초기화가 저절로 된다.
 * ★ **그림이 없어도 네모는 그린다.** 칸이 정사각 고정이라 비어 있어도 줄 높이가 흔들리지
 *   않고, 빈 칸이 "이 사람은 아직 사진이 없다"를 말해 준다(게스트가 그렇다).
 *   실루엣은 **오류가 아니라 정상 상태**다(§2.1.1) — 색 · 문구 · 경고 아이콘을 쓰지 않는다.
 *   `null` · 빈 문자열 · `onError` 세 경우가 **같은 실루엣 한 자리로** 떨어지므로
 *   깨진 이미지 아이콘이 나올 길이 없다.
 * ★ 실루엣 색은 `ink-muted` 다. `ink-placeholder` 는 `neutral-100` 위에서 2.33:1 로
 *   장식 아이콘 기준 3:1 에 미달해 `pnpm contrast` 의 면제 목록으로 떨어진다 —
 *   `ink-muted` 는 같은 면에서 라이트 5.37 · 다크 9.01 로 그냥 통과한다
 *   (`characters/components/character-card.tsx` 가 같은 이유로 같은 선택을 했다).
 * ★ `alt=""` 다. 이름은 **같은 줄의 글자 쪽에 전부** 있고(`card` 는 아래 이름 줄,
 *   `chip` 은 `title`), 같은 이름을 두 번 읽히면 목록 훑기가 느려진다. `BossIcon` 이
 *   같은 규약을 쓴다. 잘리지 않은 전체 이름은 `title` 에서 본다.
 */
export function MemberFace({
  member,
  density = "card",
}: {
  readonly member: PartyMemberBrief;
  readonly density?: PartyOptionDensity;
}) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const name = characterFirstName(member);
  /* 부캐로 들어간 사람은 `무르겨르 · 더저` 로 누구인지까지 적는다. */
  const label =
    name.account === null ? name.lead : `${name.lead} · ${name.account}`;
  const imageUrl = member.characterImageUrl;
  const showImage =
    imageUrl !== null && imageUrl !== "" && failedUrl !== imageUrl;

  return (
    <span
      title={label}
      className={cn(
        "flex shrink-0 items-center justify-center overflow-hidden rounded-md border border-border bg-neutral-100",
        FACE_BOX[density],
      )}
    >
      {showImage ? (
        /*
          넥슨 CDN 은 임의 외부 호스트라 next/image 의 `remotePatterns` 로 고정할 수
          없고, 한 변이 최대 40px 이라 최적화 이득도 없다. (지시 주석은 한 줄이어야
          한다 — 여러 줄에 걸친 `eslint-disable-next-line` 은 적용되지 않는다.)
        */
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={imageUrl}
          alt=""
          /* 종횡비 힌트일 뿐이다 — 실제 크기는 위 `FACE_BOX` 가 정한다. */
          width={64}
          height={64}
          loading="lazy"
          className="size-full scale-[5] object-contain"
          onError={() => setFailedUrl(imageUrl)}
        />
      ) : (
        <UserRound
          aria-hidden
          strokeWidth={1.5}
          /* 비율로 둔다 — 고정 px 는 칸 크기가 바뀌는 날 칸을 압도한다. */
          className="size-1/2 text-ink-muted"
        />
      )}
    </span>
  );
}

/**
 * 파티원 얼굴 줄.
 *
 * ★ `max` 가 `null` 이면 **접지 않는다.** 등록 확인 단계가 그렇다 — 거기서 `+2` 는
 *   "누가 빠졌나"를 숨기는 쪽으로만 작동한다. 목록 · 칩에서는 줄 높이와 폭을 지켜야
 *   하므로 접는다.
 * ★ `flex-wrap` 이다. 폭 400px(칸 40px × 6 + 간격 = 270px)에서는 한 줄에 들어가지만,
 *   더 좁아지거나 접지 않는 자리에서 사람이 많으면 **넘치는 대신 다음 줄로 흐른다.**
 *   `shrink-0` 이라 칸이 찌그러지지 않는다.
 */
export function MemberFaceRow({
  members,
  max,
  density = "card",
}: {
  readonly members: readonly PartyMemberBrief[];
  readonly max: number | null;
  readonly density?: PartyOptionDensity;
}) {
  if (members.length === 0) return null;

  const visible = max === null ? members : members.slice(0, max);
  const hidden = members.length - visible.length;

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {visible.map((member, index) => (
        <MemberFace
          key={`${member.displayName}-${String(index)}`}
          member={member}
          density={density}
        />
      ))}
      {hidden > 0 ? (
        <MoreChip count={hidden} className={MORE_BOX[density]} />
      ) : null}
    </span>
  );
}

/**
 * 파티가 **묶어서 도는 보스**의 얼굴 줄.
 *
 * ★ 아이콘은 일정표 블록(`week-timetable.tsx`)과 **같은 `BossIcon`** 이다. `card` 는
 *   `sm`(32px — 목록 행용 크기), `chip` 은 `xs`(20px — `h-chip` 30px 을 넘기지 않는
 *   크기). 파일이 없는 보스는 실루엣으로 떨어지지만 자리 크기는 변하지 않는다
 *   (§2.1.1 과 같은 규약).
 * ★ **로딩 상태가 없다**(2026-10-04). 보스 목록은 파티 목록 payload 에 함께 실려 오므로
 *   (`Party.bosses`) "파티는 왔는데 보스는 아직"인 상태가 존재하지 않는다. 예전에는
 *   파티당 한 건씩 따로 받아서 스켈레톤이 필요했고, 그때 **`isPending` 이 아니라
 *   `isLoading` 을 써야 하는 함정**이 있었다 — v5 에서 `enabled: false` 인 쿼리는 영원히
 *   `isPending` 이라 "아직 받지 않기로 한 줄"이 스켈레톤을 평생 띄웠다. 그 쿼리가
 *   없어졌으므로 함정도 없어졌지만, **다시 파티별 조회를 붙이려는 사람을 위해** 기록을
 *   남긴다: 그 길로 되돌아가면 왕복이 파티 수만큼 늘고 이 함정이 같이 돌아온다.
 * ★ 보스가 0개인 파티는 **정상**이다(`/parties` 에서 아직 안 정한 파티가 실제로 있다).
 *   줄을 그리지 않을 뿐이고, 그 파티로 일정을 잡으려 하면 등록 단계가 무엇을 해야
 *   하는지 말해 준다.
 */
export function BossFaceRow({
  bosses,
  max,
  density = "card",
}: {
  readonly bosses: readonly PartyBossBrief[];
  readonly max: number | null;
  readonly density?: PartyOptionDensity;
}) {
  if (bosses.length === 0) return null;

  const visible = max === null ? bosses : bosses.slice(0, max);
  const hidden = bosses.length - visible.length;

  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {visible.map((entry) => (
        <span key={entry.bossDifficultyId} title={entry.koreanName}>
          <BossIcon
            bossDifficultyId={entry.bossDifficultyId}
            difficulty={entry.difficulty}
            size={density === "chip" ? "xs" : "sm"}
          />
        </span>
      ))}
      {hidden > 0 ? (
        <MoreChip
          count={hidden}
          className={density === "chip" ? MORE_BOX.chip : "size-8"}
        />
      ) : null}
    </span>
  );
}

/**
 * 접힌 개수 칩 — `+2`.
 *
 * 숫자 주석이라 `text-caption`(12px)이 맞다(§4 — 문장 14px 하한은 문장에 걸린다).
 * 테두리를 점선으로 둬서 **얼굴 칸이 아니라 더 있다는 표시**임을 모양으로도 말한다.
 *
 * ⚠️ **`bg-surface` 를 스스로 들고 간다** (2026-10-04에 추가. §4: *대비는 토큰 표가
 *    아니라 실제로 겹친 쌍에서 판정한다*). 예전에는 배경이 없어 **부모 면을 그대로**
 *    썼는데, `chip` 밀도에서 이 칩이 앉는 부모는 **고른 `FilterChip`, 즉 `bg-primary`**
 *    다. 거기서 `ink-muted #62616a` 대 `primary #4F46E5` 는 **1.03 : 1** 로 글자가
 *    사실상 보이지 않는다. 자동 감사(`pnpm contrast`)는 조상 쪽 `selected ? …` 삼항을
 *    따라가지 못해 이것을 잡지 못한다 — 손으로 재서 찾았다.
 *    면을 고정해 두면 앉는 자리가 어디든 비율이 하나다: `ink-muted` / `surface` 는
 *    라이트 6.11 · 다크 9.01 로 둘 다 AA 를 넘는다. 얼굴 칸(`bg-neutral-100`)과
 *    보스 아이콘(`bg-background`)이 이미 같은 이유로 각자 면을 들고 있다.
 */
export function MoreChip({
  count,
  className,
}: {
  readonly count: number;
  readonly className: string;
}) {
  return (
    <span
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md border border-dashed border-border",
        "bg-surface text-caption tabular-nums text-ink-muted",
        className,
      )}
    >
      +{count}
    </span>
  );
}
