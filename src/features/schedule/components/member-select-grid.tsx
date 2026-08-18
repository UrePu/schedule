"use client";

import { SeatNumber } from "@/components/domain";
import { Checkbox } from "@/components/ui";
import { participantAltCharacterName } from "@/lib/domain/participant-label";
import { cn } from "@/lib/utils";
import type { PartyMember, Person, PersonId } from "@/types/domain";

/**
 * 파티 로스터를 짜는 체크박스 격자.
 *
 * ⚠️ 이건 **"이번 조회에 누구를 볼까"가 아니라 "이 파티에 누가 있는가"** 다 (§1.4 갱신).
 *   파티는 한 번 짜두고 계속 쓰는 것이라, 겹쳐보기는 언제나 그 파티의 **전원**을 그린다.
 *   "6명 중 4명만 되는 시간"은 로스터에서 빼는 게 아니라 최소 인원 필터가 답한다.
 *
 * 이미 그 파티에 있는 사람은 **현재 번호를 그대로 보여 준다.** 번호는 파티 단위이고
 * 재배열되지 않으므로, 편집 중에도 자기 번호가 유지된다는 것이 보여야 한다.
 * 새로 넣는 사람은 저장 시점에 `max + 1` 을 받으므로 아직 번호가 없다.
 *
 * ★ 부캐로 들어가 있는 사람은 `더저(메검메)` 로 보인다. 조합 규칙은
 *   `lib/domain/participant-label.ts` 한 곳이 소유한다 — 여기서 문자열을 다시 만들면
 *   파티 바·겹쳐보기와 이름이 갈린다.
 */

export interface MemberSelectGridProps {
  readonly people: readonly Person[];
  readonly selectedIds: ReadonlySet<PersonId>;
  readonly onToggle: (personId: PersonId) => void;
  /**
   * 그 파티의 현재 구성원. 번호와 **참여 캐릭터**의 출처다.
   * 여기 없는 사람은 신규(저장 시 `max + 1`).
   */
  readonly currentMembers?: readonly PartyMember[];
}

export function MemberSelectGrid({
  people,
  selectedIds,
  onToggle,
  currentMembers = [],
}: MemberSelectGridProps) {
  const memberByPersonId = new Map(
    currentMembers.map((member) => [member.personId, member] as const),
  );

  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {people.map((person) => {
        const selected = selectedIds.has(person.personId);
        const member = memberByPersonId.get(person.personId);
        const seatNo = member?.seatNo;
        const altCharacterName =
          member === undefined ? null : participantAltCharacterName(member);

        return (
          <li key={person.personId}>
            <div
              className={cn(
                "flex h-full flex-col gap-1 rounded-md border p-3 transition duration-200",
                selected
                  ? "border-primary bg-primary-subtle"
                  : "border-border bg-surface hover:bg-hover-surface",
              )}
            >
              <Checkbox
                checked={selected}
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

                ⚠️ 예전에는 모두에게 "가능 시간 미등록"이라고 적었는데, **후보 목록은
                   가용시간을 읽지 않는다** — 이미 패턴을 등록한 사람에게도 미등록이라고
                   말하는 거짓 문장이었다. 게스트만 사실이다(세션이 없어 본인이 입력할
                   방법이 아예 없다). 나머지는 확인되지 않은 것을 주장하지 않는다.
              */}
              <p className="text-body-sm leading-snug text-ink-muted">
                {person.blurb ??
                  (person.isGuest
                    ? "닉네임만 등록 · 초대 링크를 보내야 본인이 가능 시간을 넣습니다"
                    : "파티에 넣으면 겹쳐보기에 가능 시간이 표시됩니다")}
              </p>
              {selected && seatNo === undefined ? (
                /*
                  임박 경고가 아니라 단순 안내라 주황을 쓰지 않는다. 주황 문장은
                  라이트에서 2.80:1 로 읽히지도 않았다(§4 의 주황은 임박·주의용이다).
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
