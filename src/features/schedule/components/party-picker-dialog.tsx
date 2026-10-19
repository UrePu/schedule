"use client";

import { Search, Users } from "lucide-react";
import Link from "next/link";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";

import { PartyOptionGrid, type PartyOptionData } from "@/components/domain";
import {
  Button,
  Dialog,
  EmptyState,
  HelperText,
  Input,
  Label,
} from "@/components/ui";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 파티 고르기 — **창 하나, 큰 카드 목록** (발주 2026-10-19)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 지시: *"이거 파티 대가리 너무 작으니까 다른 파티에서 고르는것처럼 추가 모달
 * 여는걸로 바꿔"*
 *
 * 그 전까지 `/parties` 의 파티 전환은 **가로 스크롤 칩 띠**였다. 칩의 얼굴은 20px
 * (`FACE_BOX.chip` = `size-5`)이고 네 명까지만 보였으므로(`MAX_FACES_CHIP`), 실측된
 * 파티 이름이 `본캐 림흉 돌먹` · `은월 림흉 돌먹` 처럼 **캐릭터 이름으로만** 갈리는
 * 이 도메인에서 칩은 "누가 있는 파티인가"를 사실상 말하지 못했다. 게다가 활성 파티가
 * **33개**(2026-10-19 실측)라 띠는 언제나 잘린 채 가로로 흘렀다.
 *
 * 그래서 고르는 일을 창으로 옮긴다. 쓰는 것은 **일정 잡기 창과 같은 `PartyOptionGrid`**
 * (= `PartyOption` 의 `card` 밀도, 얼굴 **40px**)이고, 발주가 말한 "다른 파티에서
 * 고르는 것처럼"이 정확히 그것이다. 띠가 없어지므로 **가로 스크롤도 없어진다.**
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 33개는 **찾을 수 있어야** 한다 — 창에 쏟아 놓으면 띠보다 나을 게 없다
 * ─────────────────────────────────────────────────────────────────────────────
 * 그래서 검색이 창의 절반이다. 걸러지는 축은 **이름 · 파티원 · 캐릭터** 셋인데,
 * 그 셋이 사용자가 파티를 떠올리는 방식 전부다(이름은 보스 줄임말이라 그것만으로는
 * 모자라고, 실제로 기억에 남는 것은 "누구와 가는 조합"이다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ `useComboboxList` 를 쓰지 않은 근거 (발주가 요구한 판단)
 * ─────────────────────────────────────────────────────────────────────────────
 * 그 훅은 후보 한 줄에 **`role="option"` 을 펼치는 것**을 전제로 만들어졌다
 * (`getOptionProps` → `id` · `role` · `aria-selected`). 그런데 이 창의 한 줄은
 * `PartyOption` 이 그리는 **`<button aria-pressed>`** 이고, 그 버튼과 2열 격자 ·
 * `min-w-0` 가로 스크롤 가드는 전부 `PartyOptionGrid` 가 소유한다(그 파일 머리말이
 * 왜 소유해야 하는지를 적어 뒀다 — 호출부가 가드를 빼먹을 수 없게 하기 위해서다).
 * 훅을 끼우려면 둘 중 하나를 해야 한다:
 *
 *   ① `role="option"` 안에 버튼을 넣는다 → **ARIA 위반**이다(option 은 포커스 가능한
 *      위젯을 품을 수 없다). 스크린리더에서 줄이 두 번 읽히거나 아예 못 눌린다.
 *   ② 격자를 이 파일에 베껴 쓴다 → `min-w-0` 가드 · 열 수 · 얼굴 순서가 **두 벌**이
 *      된다. `party-option.tsx` 머리말이 막으려 한 사고가 정확히 그것이다.
 *
 * 그래서 훅 대신 **네이티브 키보드 도달**을 쓴다. 한 줄 한 줄이 진짜 `<button>` 이라
 * `Tab` 으로 닿고 `Enter`/`Space` 로 눌린다 — 새로 만들 ARIA 가 없다. 거기에 검색칸의
 * `Enter` 가 **맨 앞 후보**를 고르는 길을 더해, 좁힌 뒤 손을 옮기지 않아도 끝난다.
 * 어느 줄이 걸리는지는 아래 도움말이 **이름으로** 말하므로 추측이 아니다.
 *
 * ★ 한글 IME 함정이 여기서는 **생기지 않는다.** 훅이 `keyup` 까지 끌고 간 이유는
 *   "담은 뒤 검색칸을 비우는데 IME 가 확정 글자를 되살려 쓴다" 였다(그쪽은 담고 나서도
 *   창이 열려 있다). 이 창은 고르는 순간 **닫히고 검색칸이 언마운트**되므로 되살아날
 *   자리가 없다. 그래서 조합 중 `Enter` 도 그 자리에서 고른다 — 사용자가 누르는 횟수는
 *   한 번이다.
 */

export interface PartyPickerDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 보관되지 않은 파티만. 거르는 일은 목록 조회가 이미 했다(`fetchParties`). */
  readonly parties: readonly PartyOptionData[];
  readonly selectedPartyId: string | null;
  /**
   * 고른 파티. **창을 닫는 것은 부모의 일**이다 — 선택 반영과 닫기가 한 틱에 같이
   * 일어나야 하고, 그 순서를 아는 쪽은 선택 상태를 가진 부모다.
   */
  readonly onSelect: (partyId: string) => void;
  /** 파티가 하나도 없을 때 "새 파티" 로 보내는 길. `null` 이면 안내만 한다. */
  readonly onCreateParty: (() => void) | null;
}

/** 공백과 대소문자를 지운다 — `세쌀카 2인` 과 `세쌀카2인` 이 같은 말이어야 한다. */
function normalize(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

/**
 * 한 파티가 검색어에 걸리는가.
 *
 * ★ 찾는 축이 **셋**이다: 파티 이름 · 파티원 이름 · 캐릭터 이름. `displayName` 과
 *   `characterName` 을 **둘 다** 보는 이유는 부캐로 들어간 사람이 흔하기 때문이다 —
 *   `더저(메검메)` 를 사람은 `더저` 로도 `메검메` 로도 떠올린다.
 * ★ 둘째 줄(`subtitle`)도 본다. `/parties` 에서는 비어 있지만, 묶음을 고르는 자리에서
 *   이 창을 재사용하면 그 줄이 소속 파티 이름을 진다.
 */
function matches(party: PartyOptionData, needle: string): boolean {
  if (needle === "") return true;
  if (normalize(party.name).includes(needle)) return true;
  if (
    party.subtitle !== null &&
    party.subtitle !== undefined &&
    normalize(party.subtitle).includes(needle)
  ) {
    return true;
  }
  return party.members.some(
    (member) =>
      normalize(member.displayName).includes(needle) ||
      (member.characterName !== null &&
        normalize(member.characterName).includes(needle)),
  );
}

export function PartyPickerDialog({
  open,
  onClose,
  parties,
  selectedPartyId,
  onSelect,
  onCreateParty,
}: PartyPickerDialogProps) {
  const searchId = useId();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  /*
    ⚠️ **`requestAnimationFrame` 이 꼭 필요하다.** 자식의 effect 가 부모보다 먼저 도므로
       여기서 바로 `focus()` 를 부르면 그 뒤에 도는 `Dialog` 의 `showModal()` 이 포커스를
       **헤더의 닫기 버튼**(첫 포커스 가능 요소)으로 가져간다. 33개를 찾으러 연 창에서
       바로 타이핑이 안 되면 검색칸이 있는 의미가 절반 사라진다.
  */
  useEffect(() => {
    if (!open) return;
    const handle = requestAnimationFrame(() => searchRef.current?.focus());
    return () => cancelAnimationFrame(handle);
  }, [open]);

  const needle = normalize(query);
  const candidates = useMemo(
    () => parties.filter((party) => matches(party, needle)),
    [parties, needle],
  );

  const first = candidates[0] ?? null;

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Enter") {
      if (first === null) return;
      /* 폼 제출도, IME 확정도 여기서는 상관없다 — 바로 뒤에 창이 닫힌다(머리말 ★). */
      event.preventDefault();
      onSelect(first.partyId);
      return;
    }
    if (event.key === "Escape") {
      /*
        검색어가 비어 있으면 **흘려보낸다.** 네이티브 `<dialog>` 의 `Esc` 가 창을
        닫는 유일한 키보드 경로이므로, 그 길을 통째로 막으면 창을 못 닫는다
        (`use-combobox-list` 가 같은 이유로 같은 가드를 가진다).
      */
      if (query === "") return;
      event.preventDefault();
      event.stopPropagation();
      setQuery("");
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="파티 고르기"
      description={`활성 파티 ${String(parties.length)}개. 이름·파티원·캐릭터로 찾을 수 있습니다.`}
    >
      <div className="flex flex-col gap-3">
        {parties.length === 0 ? (
          /*
            파티가 하나도 없는 경우. 띠 쪽 빈 상태와 **같은 말**을 하지만, 창을 열어
            놓고 아무것도 안 그리면 "불러오는 중인가" 와 구별되지 않는다.
          */
          <EmptyState
            icon={<Users aria-hidden size={22} className="text-primary" />}
            title="아직 파티가 없습니다"
            description="같이 보스 갈 사람들을 파티로 묶으면 여기서 골라 쓸 수 있습니다."
            action={
              onCreateParty === null ? (
                <Link href="/parties">
                  <Button size="sm">파티 관리로 가기</Button>
                </Link>
              ) : (
                <Button
                  size="sm"
                  onClick={() => {
                    onClose();
                    onCreateParty();
                  }}
                >
                  첫 파티 만들기
                </Button>
              )
            }
          />
        ) : (
          <>
            {/*
              ── 찾기 ────────────────────────────────────────────────────────
              ★ 개수를 함께 말한다. "이게 전부인가" 를 화면이 답해야 조용히 걸러진
                목록과 구분된다(`party-boss-picker` 가 세운 규칙 그대로).
              ⚠️ 파티가 **하나뿐이면 검색칸을 그리지 않는다.** 한 줄을 걸러 낼 수단은
                 없는 것이 낫다 — 비우는 것 말고 할 일이 없는 칸이다.
            */}
            {parties.length === 1 ? null : (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor={searchId}>
                  파티 찾기
                  <span className="ml-1 font-normal text-ink-muted">
                    · {candidates.length}/{parties.length}개
                  </span>
                </Label>
                <div className="relative">
                  <Search
                    aria-hidden
                    size={16}
                    className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-ink-placeholder"
                  />
                  <Input
                    id={searchId}
                    ref={searchRef}
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    onKeyDown={handleKeyDown}
                    placeholder="파티 이름 · 파티원 · 캐릭터 — 더저, 림흉, 2인"
                    className="pl-9"
                    autoComplete="off"
                  />
                </div>
                {/*
                  `Enter` 가 **무엇을** 고르는지 이름으로 말한다. "맨 앞" 이라고만 하면
                  목록이 접혀 있을 때 어느 줄인지 보이지 않아 추측이 된다.
                  문장이라 14px 하한을 지킨다(§4).
                */}
                {first === null ? null : (
                  <HelperText>
                    <kbd className="font-mono">Enter</kbd> 로{" "}
                    <strong className="font-semibold">{first.name}</strong> 을(를)
                    고릅니다. <kbd className="font-mono">Tab</kbd> 으로 목록을
                    오가고, <kbd className="font-mono">Esc</kbd> 는 검색어를
                    지웁니다.
                  </HelperText>
                )}
              </div>
            )}

            {candidates.length === 0 ? (
              <HelperText>
                이름·파티원·캐릭터 어디에도 일치하는 파티가 없습니다. 다른 이름으로
                찾아보세요.
              </HelperText>
            ) : (
              /*
                줄의 모양과 배치는 전부 `PartyOptionGrid` 가 소유한다 — 일정 잡기 창 ·
                보스 계획 등록 창과 **같은 컴포넌트 · 같은 밀도**다.
              */
              <PartyOptionGrid
                parties={candidates}
                selectedPartyId={selectedPartyId}
                onSelect={onSelect}
              />
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
