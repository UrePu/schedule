"use client";

import { Archive, Copy, Layers, Plus, Settings2 } from "lucide-react";
import { useState } from "react";

import { BossFaceRow } from "@/components/domain";
import {
  Button,
  Card,
  CardDescription,
  CardTitle,
  EmptyState,
  ErrorState,
  HelperText,
  Skeleton,
  SkeletonGroup,
} from "@/components/ui";
import type { PartyBossBrief } from "@/types/domain";

import type { PartyBundleWire } from "../types";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 파티 안의 **보스 묶음 목록** — `/parties` 의 중심 (2단계, 2026-10-16)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 이 카드가 2026-10-16 까지 있던 "묶어서 도는 보스" 카드를 **대체한다.** 그 카드는 파티
 * 하나에 보스 목록이 하나뿐이라는 전제 위에 있었고, 그 전제가 발주 문제의 원인이었다 —
 * 조합이 늘면 **파티를 더 만들어야** 했다(실측: 같은 구성원인데 보스만 다른 활성 파티 6개).
 *
 * ★ 한 줄에 네 가지를 적는다: **보스 얼굴 · 내 캐릭터 · 분배 요약 · 잡힌 일정 수.**
 *   그 넷이 묶음을 서로 구분하는 축 전부다. 이름은 보스 줄임말(`익세 하대 하카 3인`)이라
 *   같은 보스를 캐릭터만 바꿔 도는 두 묶음은 **이름이 같을 수 있고**, 그때 실제로 가르는
 *   것은 캐릭터 줄이다.
 * ★ 분배 요약이 **상속을 그대로 말한다.** `파티 설정 따름` 과 `균등` 을 한 글자로 접으면
 *   (둘 다 결과가 1/n 일 수 있다) 파티 분배를 바꿨을 때 어느 묶음이 따라오는지 알 수
 *   없어진다 — 비어 있음이 뜻을 갖는 설계(§1.3 D4 기조)를 화면이 지키는 자리다.
 * ★ **삭제가 아니라 보관**이다. 과거 런이 그 묶음을 가리키고 그 행이 "이 돈이 왜 이렇게
 *   나뉘었나" 를 설명한다(`archivePartyBundle` 머리말). 그래서 버튼 이름도 `보관` 이고,
 *   확인 줄이 **무엇이 남는지**를 먼저 말한다(파티 해체 확인과 같은 규약).
 *
 * ⚠️ 조회는 **부모가 소유한다**(§2.4 Rule 1). 이 컴포넌트는 쿼리도 뮤테이션도 갖지 않고
 *    상태·오류를 프롭으로 받는다 — 무효화 목록은 화면마다 다르고, 그것을 컴포넌트가
 *    들고 있으면 화면 데이터의 주인이 캐시에서 컴포넌트로 옮겨 간다.
 */

export interface PartyBundleListProps {
  readonly bundles: readonly PartyBundleWire[];
  readonly isLoading: boolean;
  readonly isError: boolean;
  readonly onRetry: () => void;
  /** `null` 이면 버튼을 그리지 않는다 — 남의 공개 파티를 구경하는 경우다. */
  readonly onAddBundle: (() => void) | null;
  readonly onEditBundle: (bundle: PartyBundleWire) => void;
  readonly onCopyBundle: (bundle: PartyBundleWire) => void;
  readonly onArchiveBundle: (bundle: PartyBundleWire) => void;
  readonly isArchiving: boolean;
  readonly archiveErrorMessage: string | null;
}

/**
 * 분배 한 줄 — **상속 / 균등 / 비율**을 그대로 말하고 결정석 예외를 덧붙인다.
 *
 * ★ `crystalFollowsShare === false` 는 **비율일 때만** 적는다. 균등인 묶음에서는 결정석도
 *   드랍도 어차피 균등이라, 그 자리에 "결정석은 균등" 을 적으면 아무것도 구분하지 못하는
 *   글자가 한 줄 늘어난다.
 */
function shareSummary(bundle: PartyBundleWire): string {
  const base =
    bundle.shareMode === null
      ? `파티 설정 따름 (${bundle.partyShareMode === "manual" ? "비율 지정" : "균등"})`
      : bundle.shareMode === "manual"
        ? "이 묶음만 비율 지정"
        : "이 묶음만 균등";
  if (bundle.effectiveShareMode === "manual" && !bundle.crystalFollowsShare) {
    return `${base} · 결정석은 균등`;
  }
  return base;
}

/** 내 캐릭터 한 줄. **지정과 폴백을 가른다** — 그 둘은 사용자가 할 일이 다르다. */
function myCharacterSummary(bundle: PartyBundleWire): string | null {
  const mine = bundle.members.find((member) => member.isMe) ?? null;
  if (mine === null) return null;
  if (mine.bundleCharacterName !== null) {
    return `내 캐릭터 ${mine.bundleCharacterName}`;
  }
  if (mine.partyCharacterName !== null) {
    return `내 캐릭터 ${mine.partyCharacterName} (파티 기본값)`;
  }
  return "내 캐릭터 미지정";
}

export function PartyBundleList({
  bundles,
  isLoading,
  isError,
  onRetry,
  onAddBundle,
  onEditBundle,
  onCopyBundle,
  onArchiveBundle,
  isArchiving,
  archiveErrorMessage,
}: PartyBundleListProps) {
  /**
   * 보관 확인을 펼쳐 둔 묶음. **묶음 id 로 기억한다** — 확인 중에 목록이 바뀌어도
   * 열려 있던 확인이 다른 묶음의 것처럼 보이지 않는다(파티 해체 확인과 같은 근거).
   */
  const [confirmingArchiveId, setConfirmingArchiveId] = useState<string | null>(
    null,
  );

  return (
    <Card className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <CardTitle className="flex items-center gap-1.5">
            <Layers aria-hidden size={16} className="text-primary" />
            보스 묶음
            <span className="text-body-sm tabular-nums text-ink-muted">
              {bundles.length}개
            </span>
          </CardTitle>
          <CardDescription>
            같이 묶어 도는 보스 조합입니다. 주간 일정표의 빈 칸을 누르면 이 중
            하나를 골라 일정이 잡힙니다. 보스만 다른 조합은 파티를 새로 만들지
            않고 묶음을 추가하세요.
          </CardDescription>
        </div>
        {onAddBundle === null ? null : (
          <Button variant="secondary" size="sm" onClick={onAddBundle}>
            <Plus aria-hidden size={16} />
            묶음 추가
          </Button>
        )}
      </div>

      {archiveErrorMessage === null ? null : (
        <HelperText tone="error" role="alert">
          {archiveErrorMessage}
        </HelperText>
      )}

      {isError ? (
        <ErrorState
          title="보스 묶음을 불러오지 못했습니다"
          description="잠시 후 다시 시도해 주세요."
          onRetry={onRetry}
          className="py-6"
        />
      ) : isLoading ? (
        <SkeletonGroup label="보스 묶음을 불러오는 중">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        </SkeletonGroup>
      ) : bundles.length === 0 ? (
        <EmptyState
          title="보스 묶음이 없습니다"
          description="묶음이 없으면 이 파티로는 일정을 잡을 수 없습니다. 같이 돌 보스를 묶어 하나 만들어 주세요."
          action={
            onAddBundle === null ? null : (
              <Button size="sm" onClick={onAddBundle}>
                <Plus aria-hidden size={16} />첫 묶음 만들기
              </Button>
            )
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {bundles.map((bundle) => {
            const confirming = confirmingArchiveId === bundle.bundleId;
            const mineText = myCharacterSummary(bundle);
            return (
              /* ⚠️ `min-w-0` — 긴 이름이 줄을 벌려 가로 스크롤을 만드는 것을 막는다. */
              <li
                key={bundle.bundleId}
                className="flex min-w-0 flex-col gap-2 rounded-lg border border-border bg-background p-2.5"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="flex min-w-0 flex-1 basis-40 flex-col gap-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      {/*
                        번호는 **관리 식별자**다(§1.4). 재배열·재사용하지 않으므로
                        연속이 아닐 수 있고, 그래야 "2묶음" 이라는 호칭이 어제와 같은
                        것을 가리킨다.
                      */}
                      {bundle.bundleNo === null ? null : (
                        <span className="shrink-0 text-caption tabular-nums text-ink-muted">
                          {bundle.bundleNo}묶음
                        </span>
                      )}
                      <span className="min-w-0 flex-1 truncate text-body font-semibold text-ink">
                        {bundle.name}
                      </span>
                    </span>
                    <BossFaceRow
                      bosses={bundle.bosses.map(
                        (boss): PartyBossBrief => ({
                          bossDifficultyId: boss.bossDifficultyId,
                          koreanName: boss.koreanName,
                          difficulty: boss.difficulty,
                        }),
                      )}
                      max={null}
                      density="card"
                    />
                    {bundle.bosses.length === 0 ? (
                      /*
                        ⚠️ **일정을 잡을 수 없는 묶음**이다. 주황이다 — 실패나 취소가
                           아니라 "지금 이대로는 안 된다"는 주의이고, 문장은 ink 다(§4).
                      */
                      <span className="rounded-md border border-chip-soon-border bg-chip-soon-bg px-2 py-1 text-body-sm text-ink">
                        등록된 보스가 없어 이 묶음으로는 일정을 잡을 수
                        없습니다. 편집에서 보스를 담아 주세요.
                      </span>
                    ) : null}
                    <span className="flex flex-col gap-0.5">
                      {mineText === null ? null : (
                        <span className="truncate text-body-sm text-ink-muted">
                          {mineText}
                        </span>
                      )}
                      <span className="truncate text-body-sm text-ink-muted">
                        분배 {shareSummary(bundle)}
                      </span>
                      <span className="text-body-sm text-ink-muted">
                        잡힌 일정{" "}
                        <span className="tabular-nums">{bundle.runCount}</span>건
                      </span>
                    </span>
                  </div>

                  <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => onEditBundle(bundle)}
                    >
                      <Settings2 aria-hidden size={16} />
                      편집
                    </Button>
                    {/*
                      ── `묶음 복사` (2026-10-16 판단) ──────────────────────────
                      0단계의 `파티 복사` 가 노리던 쓰임 — *"같은 사람, 보스만 다름"* —
                      은 이제 **이 버튼**이 받는다. 파티를 늘리지 않고 조합만 늘리므로
                      그 쪽이 발주 문제의 해답이다. 서버에 복사 전용 경로를 만들지 않고
                      **편집 창을 원본 값으로 열어** 저장은 평범한 만들기 하나로 둔다 —
                      복사의 요점이 "바로 뒤에 고치는 것"이기 때문이다(캐릭터를 바꾼다).
                    */}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onCopyBundle(bundle)}
                    >
                      <Copy aria-hidden size={16} />
                      복사
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        setConfirmingArchiveId(
                          confirming ? null : bundle.bundleId,
                        )
                      }
                    >
                      <Archive aria-hidden size={16} />
                      {confirming ? "보관 취소" : "보관"}
                    </Button>
                  </div>
                </div>

                {/*
                  ── 보관 확인 ───────────────────────────────────────────────
                  ★ **"정말요?" 만 묻지 않는다.** 무엇이 사라지고 무엇이 남는지를 먼저
                    말한다 — 특히 **과거 일정과 수익이 그대로 남는다**는 사실이다.
                    겁을 주는 확인창은 안전한 것이 아니라, 안 쓰는 묶음을 계속 안고
                    가게 만드는 것이다(파티 해체 확인이 세운 규칙).
                */}
                {confirming ? (
                  <div className="flex flex-col gap-2 rounded-md border border-border-strong bg-surface p-2.5">
                    <p className="text-body-sm text-ink">
                      <strong className="font-semibold">{bundle.name}</strong>{" "}
                      을(를) 보관합니다. 목록과 일정 잡기에서 사라지고, 이미 잡힌
                      일정{" "}
                      <strong className="font-semibold tabular-nums">
                        {bundle.runCount}건
                      </strong>
                      과 기록된 수익은{" "}
                      <strong className="font-semibold">그대로 남습니다.</strong>
                    </p>
                    <div className="flex flex-wrap gap-2">
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={isArchiving}
                        onClick={() => {
                          onArchiveBundle(bundle);
                          setConfirmingArchiveId(null);
                        }}
                      >
                        {isArchiving ? "보관하는 중…" : "보관합니다"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={isArchiving}
                        onClick={() => setConfirmingArchiveId(null)}
                      >
                        그만두기
                      </Button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
