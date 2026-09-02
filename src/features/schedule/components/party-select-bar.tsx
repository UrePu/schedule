"use client";

import Link from "next/link";
import { Settings2, UsersRound } from "lucide-react";
import { useId } from "react";

import { Button, ErrorState, Skeleton } from "@/components/ui";
import type { Party, PartyId } from "@/types/domain";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 일정 화면의 파티 줄 — **고르는 것 하나, 확인하는 것 하나**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시(2026-08-25): *"파티 설정은 좀 다르게 안되나? 일정짜기에 드롭다운으로
 * 선택하도록? 그 드롭다운 오른쪽에 파티원 설명해주면 되고. 저 설명은 필요없을거같은데."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 무엇을 덜어냈는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 여기 있던 `PartyBar` 는 파티 칩 줄 · 구성원 줄 · 내 참여 캐릭터 선택 · 안내 두 문단 ·
 * 해체 버튼까지 얹혀 **화면 위쪽 절반을 먹었다.** 정작 이 화면에서 파티에 대해 하는 일은
 * **"어느 파티인가"를 고르는 것 하나**뿐이다. 나머지는 전부 파티 관리(`/parties`)의 일이다.
 *
 * · 칩 → **드롭다운.** 파티가 6개만 돼도 칩 줄이 가로로 넘쳐 스크롤이 생긴다. 고르는
 *   행위는 한 번뿐이라 늘 펼쳐 둘 이유가 없다.
 * · 구성원은 처음엔 **드롭다운 오른쪽 한 줄**이었다가, 2026-09-02 에 **드롭다운 안으로
 *   합쳐졌다**(발주 지시: *"1,2 필요없잖아 파티원 포함이니까"*). 하루 전 선택지마다
 *   파티원을 실으면서 같은 이름이 한 줄에 두 번 서게 됐고, 그러면 둘 다 안 읽힌다.
 *   "누가 들어 있나"는 **고를 때** 필요한 정보이므로 선택지 쪽이 제자리다.
 * · 안내 문단(`번호는 … 재사용하지 않습니다` · `부캐로 참여하면 …`)은 **뺐다.** 규칙
 *   설명은 그 규칙을 **쓰는 자리**(파티 관리)에 있어야 하고, 매일 보는 화면에서 매번
 *   같은 문장을 읽히면 그때부터 아무도 읽지 않는다.
 *
 * ⚠️ **내 참여 캐릭터 선택도 여기 없다.** `party_participants.character_id` 는 파티 설정이라
 *    `/parties` 로 갔다. 일정에 데려갈 캐릭터는 **런마다 다를 수 있는 다른 값**이고
 *    (`run_signups.character_id`), 그건 등록 모달 3단계가 묻는다. 둘을 같은 화면에 두면
 *    어느 쪽을 고치는지 알 수 없다.
 */

/**
 * 드롭다운 한 줄 — `이름 — 멤버1, 멤버2`.
 *
 * 발주 지시(2026-09-01): *"파티 고를때 파티원도 다 보이게 해서 해줘 이름이 비슷해서
 * 하나도 모르겠음"*. 실측된 제목들이 `발벨3륹3인` · `익세 4인` · `세쌀칼2인523` ·
 * `세쌀칼2인물결` 처럼 **보스 줄임말 + 인원**이라 서로 구분이 안 된다 — 심지어
 * 같은 이름이 둘 있다. 구분에 실제로 쓰이는 정보는 "누가 들어 있나"다.
 *
 * ★ `<option>` 은 **글자만** 담는다 — 마크업도 두 줄도 못 넣는다. 그래서 구분자 하나로
 *   붙인다. 대신 네이티브 드롭다운은 모바일에서 OS 피커로 열려 목록이 길어도 고르기 쉽다.
 * ★ 닫힌 상태에서 길면 브라우저가 잘라 보여 준다. **그래도 괜찧4은** 고른 파티의 구성원은
 *   바로 오른쪽에 번호까지 붙어 온전히 나오기 때문이다. 헷갈리는 순간은 **고를 때**고,
 *   그때는 목록이 펼쳐져 전문이 보인다.
 * ★ 6명에서 자른다. 파티 최대 인원이 6(§1)이라 정상 파티는 잘리지 않고, 그보다 많은
 *   예외에서만 `외 N명` 이 붙는다 — 잘라낸 사실을 숨기지 않는다.
 */
const MEMBER_PREVIEW_MAX = 6;

function partyOptionLabel(party: Party): string {
  if (party.memberNames.length === 0) return party.name;

  const shown = party.memberNames.slice(0, MEMBER_PREVIEW_MAX);
  const rest = party.memberNames.length - shown.length;
  const names =
    rest > 0
      ? `${shown.join(", ")} 외 ${String(rest)}명`
      : shown.join(", ");
  return `${party.name} — ${names}`;
}

export interface PartySelectBarProps {
  readonly parties: readonly Party[];
  readonly selectedPartyId: PartyId | null;
  readonly onSelectParty: (partyId: PartyId) => void;
  readonly isPartiesLoading: boolean;
  readonly isPartiesError: boolean;
  readonly onPartiesRetry: () => void;
}

export function PartySelectBar({
  parties,
  selectedPartyId,
  onSelectParty,
  isPartiesLoading,
  isPartiesError,
  onPartiesRetry,
}: PartySelectBarProps) {
  const selectId = useId();

  if (isPartiesError) {
    return (
      <ErrorState
        title="파티 목록을 불러오지 못했습니다"
        description="잠시 후 다시 시도해 주세요."
        onRetry={onPartiesRetry}
      />
    );
  }

  if (isPartiesLoading) {
    return <Skeleton className="h-12 w-full" />;
  }

  /*
    파티가 없으면 **고를 것이 없다.** 빈 드롭다운을 띄우는 대신 갈 곳을 말한다 —
    이 화면에서는 파티를 만들 수 없으므로 막다른 길이 되지 않게 해야 한다.
  */
  if (parties.length === 0) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2.5">
        <p className="text-body-sm text-ink">
          아직 파티가 없습니다. 파티를 만들면 각자의 가능 시간이 겹쳐서 보입니다.
        </p>
        <Link href="/parties">
          <Button size="sm">
            <UsersRound aria-hidden size={16} />
            파티 만들러 가기
          </Button>
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-surface px-3 py-2.5">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <label
          htmlFor={selectId}
          className="shrink-0 text-caption font-semibold text-ink-muted"
        >
          파티
        </label>
        {/*
          구성원 줄이 빠지면서 남은 폭을 **드롭다운이 가져간다.** 이제 닫힌 상태의 이 칸이
          "어느 파티인가 · 누가 들어 있나"를 함께 말하는 유일한 자리라, 잘리는 글자가
          적을수록 좋다. 상한을 두는 것은 파티원이 여섯이면 줄이 화면 끝까지 늘어나
          오른쪽 `파티 관리` 버튼이 멀어지기 때문이다.
        */}
        <select
          id={selectId}
          value={selectedPartyId ?? ""}
          onChange={(event) => onSelectParty(event.target.value)}
          className="h-9 min-w-0 flex-1 rounded-md border border-border bg-background px-2.5 text-body-sm font-semibold text-ink sm:max-w-[36rem]"
        >
          {parties.map((party) => (
            <option key={party.partyId} value={party.partyId}>
              {partyOptionLabel(party)}
            </option>
          ))}
        </select>
      </div>

      {/*
        ── 구성원 줄은 **없앴다** (발주 지시 2026-09-02: *"1,2 필요없잖아 파티원
           포함이니까"*) ──────────────────────────────────────────────────────
        2026-08-25 에는 드롭다운이 이름만 보여 줬으므로 오른쪽 줄이 "누가 들어 있나"를
        답하는 유일한 자리였다. 하루 전 드롭다운에 파티원을 실으면서 **같은 이름이 한
        줄에 두 번** 서게 됐고, 그러면 둘 다 안 읽힌다.

        ⚠️ 함께 사라진 것은 `member_no` 표시다(§1.4 — 카톡에서 `1번` 으로 부르는 그 번호).
           일정 화면에서 번호로 사람을 지목하는 조작이 없어서 여기서는 값이 없었고,
           번호가 필요한 자리에는 그대로 남아 있다 — 파티 관리 화면의 구성원 목록,
           그리고 방에서 실제로 번호를 쓰는 `!파티` · `!알림`.
      */}

      {/*
        고치러 가는 문. 이 화면에서 파티를 못 고치게 한 이상, **어디서 고치는지**는
        말해 줘야 한다. `ghost` 라 눈에 띄지 않게 두되 자리는 늘 같다.
      */}
      <Link href="/parties" className="shrink-0">
        <Button variant="ghost" size="sm">
          <Settings2 aria-hidden size={16} />
          파티 관리
        </Button>
      </Link>
    </div>
  );
}
