"use client";

import { SeatNumber } from "@/components/domain";
import { Checkbox } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Person, PersonId } from "@/types/domain";

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
 */

export interface MemberSelectGridProps {
  readonly people: readonly Person[];
  readonly selectedIds: ReadonlySet<PersonId>;
  readonly onToggle: (personId: PersonId) => void;
  /** 그 파티에서 이미 쓰고 있는 번호. 없으면 신규(저장 시 max+1). */
  readonly seatNoByPersonId?: ReadonlyMap<PersonId, number>;
}

export function MemberSelectGrid({
  people,
  selectedIds,
  onToggle,
  seatNoByPersonId,
}: MemberSelectGridProps) {
  return (
    <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
      {people.map((person) => {
        const selected = selectedIds.has(person.personId);
        const seatNo = seatNoByPersonId?.get(person.personId);

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
                    {person.isGuest ? (
                      <span className="shrink-0 text-caption text-ink-muted">
                        게스트
                      </span>
                    ) : null}
                  </span>
                }
              />
              {/* 가용 시간 요약은 사람이 실제로 읽는 본문이다 — 14px 하한을 지킨다. */}
              <p className="text-body-sm leading-snug text-ink-muted">
                {person.blurb ?? "가능 시간 미등록"}
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
