"use client";

import { useId, useMemo, useState } from "react";

import { BossIcon, SeatNumber } from "@/components/domain";
import {
  Button,
  Checkbox,
  Dialog,
  ErrorState,
  HelperText,
  Input,
  Label,
  Radio,
} from "@/components/ui";
import { buildPartyTitle, PARTY_TITLE_HINT } from "@/lib/domain/party-title";
import { participantLabel } from "@/lib/domain/participant-label";
import type { BossCatalogEntry, RunCharacterOption } from "@/types/domain";

import {
  BUNDLE_CRYSTAL_FOLLOWS_SHARE_HINT,
  BUNDLE_OTHER_CHARACTER_NOTE,
  RUN_SHARE_WEIGHT_SCALE,
  type BundleShareInput,
  type PartyBundleWire,
  type SaveBundleBody,
} from "../types";
import { PartyBossPicker } from "./party-boss-picker";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 보스 묶음 만들기·고치기 — **한 파티 안의 "이 조합"**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 문제(2026-10-16): *"같은 두 사람이 보스 묶음·캐릭터·분배만 바꿔 여러 조합을 도는데
 * 조합마다 파티를 새로 만들어야 한다."* 라이브 실측 — 같은 구성원인데 보스만 다른 활성
 * 파티가 **6개**, 이름이 `본캐 림흉 돌먹` · `은월 림흉 돌먹` 처럼 캐릭터 이름으로만 갈린다.
 *
 * 이 창이 그 6개를 **묶음 6개**로 바꾼다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 마법사(단계)가 아니라 **한 화면**인가 — 판단과 근거
 * ─────────────────────────────────────────────────────────────────────────────
 * 파티 만들기는 4단 마법사다. 그 근거는 *"분배 단계는 파티가 저장된 뒤에만 존재할 수
 * 있다(비율이 `party_participants.id` 에 매여 있다)"* 였다. 묶음에는 그 제약이 **없다** —
 * 사람은 파티가 이미 소유하고 있어 `participantId` 가 창을 열 때부터 손에 있고, 저장은
 * `POST` **한 번**이다. 그런데 더 중요한 이유는 **고치는 쪽**이다: 실제로 일어나는 수정은
 * "분배만" · "내 캐릭터만" 이고, 단계로 묶으면 그 한 가지를 고치려고 보스 단계를 지나야
 * 한다. 그래서 세 묶음(보스 · 캐릭터 · 분배)을 **제목 붙인 섹션**으로 한 화면에 세우고,
 * 순서만 발주 순서대로 둔다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ **남의 캐릭터는 고르지 못한다 — 자료가 없어서다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 고를 후보는 `fetchMyRunCharacters`(내 추적 캐릭터)뿐이고, 남의 캐릭터 목록을 내주는
 * 경로는 이 앱에 없다(만들면 그 사람의 로스터를 전부 공개하는 일이 된다). 서버도 같은
 * 선을 긋는다 — `requireOwnedTrackedCharacter` 는 부르는 사람 소유만 통과시킨다.
 * 그래서 **내 줄만** 고치고 남의 줄은 그 사람이 정해 둔 값을 읽기 전용으로 보여 준다.
 * 발주자가 겪던 혼란은 **자기 캐릭터**가 다른 경우이므로 이 범위로 전부 해결된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 분배는 **비워 둘 수 있고, 비어 있음이 "파티를 따름"** 이다
 * ─────────────────────────────────────────────────────────────────────────────
 * 세 갈래를 라디오로 못박는다(`BundleShareInput`): 파티 설정 따름 / 균등 / 비율 지정.
 * **빈 상태를 0 으로 그리지 않는 것**이 이 화면의 조건이다 — 0 은 "이 사람 몫이 없다"는
 * 확정된 약정이고, 상속은 "아직 정하지 않았다"다(§1.3 D4 와 같은 기조). 그래서 상속일
 * 때는 입력칸을 **아예 그리지 않고**, 파티가 지금 어떻게 나누는지 한 줄로 말한다.
 *
 * ★ 가중치 → 만분율 환산도, 잔돈 배분도 **DB `distribute_meso()`** 가 한다. 이 창은
 *   사용자가 친 가중치를 그대로 보낼 뿐이다 — 화면이 1/n 을 다시 적었다가 실제 약정과
 *   다른 금액을 말한 사고가 이 저장소에서 두 번 있었다(`party-share-section` 머리말).
 */

/** 화면에서 받을 수 있는 가중치의 상한. 서버 상한을 배율로 나눈 값이다. */
const WEIGHT_INPUT_MAX = 10_000;

/** 만분율 → 입력칸 문자열. `3333` → `"33.33"`, `5000` → `"50"`. */
function weightTextFromBp(shareBp: number): string {
  return String(shareBp / RUN_SHARE_WEIGHT_SCALE);
}

/**
 * 입력 문자열 → 서버로 보낼 정수 가중치(이미 100 이 곱해진 값).
 *
 * `null` 은 **입력이 유효하지 않다**는 뜻이다. 0 과 다르다 — 0 은 "이 사람 몫이 없다"는
 * 확정된 입력이고, `null` 은 아직 숫자가 아니다.
 */
function parseWeight(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value < 0 || value > WEIGHT_INPUT_MAX) {
    return null;
  }
  // `33.33 * 100` 은 부동소수점에서 3332.9999… 다. 반올림해 정수로 못박는다.
  return Math.round(value * RUN_SHARE_WEIGHT_SCALE);
}

type ShareKind = "inherit" | "equal" | "manual";

export type BundleEditorMode = "create" | "edit" | "copy";

export interface BundleEditorDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly mode: BundleEditorMode;
  /**
   * 바탕이 되는 묶음. `create` 면 `null`, `copy` 면 **원본**이다.
   *
   * ★ `copy` 가 원본을 그대로 받는 것이 `묶음 복사` 의 전부다 — 서버에 복사 전용 경로를
   *   만들지 않았다. 사용자는 복사된 값을 **저장 전에** 고칠 수 있고(그게 복사하는
   *   이유다: 보스는 같고 캐릭터만 다르다), 저장은 평범한 만들기 한 번이다.
   */
  readonly bundle: PartyBundleWire | null;
  /**
   * 구성원 줄의 출처. `create` 에서는 같은 파티의 **다른 묶음**에서 빌려 온다
   * (`members` 는 파티의 성질이라 어느 묶음에서 읽어도 같다).
   */
  readonly members: readonly PartyBundleWire["members"][number][];
  /** 파티 쪽 분배 방식. 상속일 때 "파티가 지금 어떻게 나누는가"를 말하는 데 쓴다. */
  readonly partyShareMode: "auto_equal" | "manual";
  readonly bosses: readonly BossCatalogEntry[];
  /** 내가 데려갈 수 있는 캐릭터(추적 대상만). 비로그인·미추적이면 빈 배열이다. */
  readonly characters: readonly RunCharacterOption[];
  /**
   * **그 파티가 전에 돈 보스** — 체크 수를 줄이는 빠른 담기(발주 지시 2026-10-16).
   * 같은 파티의 다른 묶음에 등록된 보스들이며, **새 조회가 아니다.**
   */
  readonly suggestedBossIds: readonly string[];
  readonly onSubmit: (body: SaveBundleBody) => void;
  readonly isSubmitting: boolean;
  readonly submitError: Error | null;
}

export function BundleEditorDialog({
  open,
  onClose,
  mode,
  bundle,
  members,
  partyShareMode,
  bosses,
  characters,
  suggestedBossIds,
  onSubmit,
  isSubmitting,
  submitError,
}: BundleEditorDialogProps) {
  const nameId = useId();
  const shareGroupName = useId();

  /*
    ── 초기값은 **마운트 때 한 번** 읽는다 ─────────────────────────────────────
    부모가 `key` 로 다시 마운트해 "취소가 실제로 취소되게" 한다(`PartyEditorDialog` 와
    같은 규약). 그래서 부모는 **조회가 도착한 뒤에** 이 창을 마운트해야 한다 — 빈 초기값
    으로 열린 창에서 저장을 누르면 보스와 분배가 지워진다(2026-10-11 사고).
  */
  const [bossIds, setBossIds] = useState<readonly string[]>(() =>
    (bundle?.bosses ?? []).map((boss) => boss.bossDifficultyId),
  );
  const [durations, setDurations] = useState<readonly (number | null)[]>(() =>
    (bundle?.bosses ?? []).map((boss) => boss.durationMinutes),
  );
  /**
   * ★ ═══════════════════════════════════════════════════════════════════════
   *   **사용자가 분을 실제로 고쳤는가** — 안 고쳤으면 보내지 않는다 (2026-10-11 결함)
   *   ═══════════════════════════════════════════════════════════════════════
   *   저장 요청에 `durationMinutes` 를 실으면 서버가 **그 배열로 전부 덮어쓴다.** 생략하면
   *   DB 함수가 `boss_difficulty_id` 로 키를 잡아 **기존 값을 보존**하고(delete 전에
   *   스냅샷을 뜬다) 새로 담은 보스는 `null`(정하지 않음)로 들어간다 — 정확히 우리가
   *   원하는 동작이다.
   *
   *   실제 피해: 이 창의 초기값은 60초 stale 캐시에서 온다. 안 고쳤는데 되돌려 보내면
   *   **다른 파티원이 방금 넣은 40분이 내 화면의 옛 값으로 지워진다.** 보스를 더하거나
   *   순서를 바꾸는 저장에는 분 배열이 **아예 필요하지 않으므로**, 보내는 쪽이 전적으로
   *   손해다. 그래서 값 수정 콜백(`onDurationEdit`)이 불릴 때만 센다 — 구조 변경
   *   (`onChange`)으로는 켜지지 않는다. `PartyBossPicker` 가 그 둘을 갈라 둔 이유다.
   */
  const [durationsTouched, setDurationsTouched] = useState(false);
  /*
    이름은 **자동이면 비워 둔다.** 손대지 않고 저장했다고 "사람이 정한 이름"으로 굳으면
    이후 보스를 바꿔도 제목이 영영 따라오지 않는다(파티 편집 창과 같은 규약).
  */
  const [name, setName] = useState(() =>
    bundle !== null && bundle.nameIsCustom ? bundle.name : "",
  );

  /** 내 줄이 데려가는 캐릭터. `null` = 묶음에서 정하지 않음(파티 기본값으로). */
  const myRow = members.find((member) => member.isMe) ?? null;
  const [myCharacterId, setMyCharacterId] = useState<string | null>(
    () => myRow?.bundleCharacterId ?? null,
  );

  const [shareKind, setShareKind] = useState<ShareKind>(() => {
    if (bundle === null || bundle.shareMode === null) return "inherit";
    return bundle.shareMode === "manual" ? "manual" : "equal";
  });
  const [crystalFollowsShare, setCrystalFollowsShare] = useState(
    () => bundle?.crystalFollowsShare ?? true,
  );
  /**
   * 가중치 입력칸.
   *
   * `manual` 이 아니면 **전부 1 로 시작한다.** 균등은 사람에게 `1 : 1 : 1` 로 읽히는 것이
   * 맞고, 저장된 잔돈(3334)이 칸에 노출되면 "왜 나만 33.34냐"는 질문이 생긴다
   * (`party-share-section.baselineWeights` 와 같은 판단).
   */
  const [weights, setWeights] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const member of members) {
      const bp = bundle?.shareMode === "manual" ? member.bundleShareBp : null;
      seed[member.participantId] = bp === null ? "1" : weightTextFromBp(bp);
    }
    return seed;
  });

  /** 체크된 보스의 줄임말 — 자동 이름 미리보기의 재료다. */
  const shortNameById = useMemo(
    () =>
      new Map(
        bosses.map((entry) => [entry.bossDifficultyId, entry.shortName] as const),
      ),
    [bosses],
  );

  /*
    자동 이름 **미리보기**. 조합 규칙의 주인은 `@/lib/domain/party-title` 하나이고
    (`buildPartyTitle`), 서버도 같은 함수를 부른다 — 그래서 미리보기와 저장 결과가
    갈라질 수 없다.
  */
  const autoName =
    buildPartyTitle(
      bossIds.map((id) => shortNameById.get(id) ?? id),
      members.length,
    ) ?? (bundle?.bundleNo === undefined || bundle.bundleNo === null
      ? "새 묶음"
      : `${String(bundle.bundleNo)}묶음`);

  /** 아직 담지 않은 "전에 돈 보스". 이미 담은 것을 또 권하지 않는다. */
  const quickAddIds = useMemo(() => {
    const picked = new Set(bossIds);
    return suggestedBossIds.filter((id) => !picked.has(id));
  }, [suggestedBossIds, bossIds]);

  const parsedWeights = members.map((member) => ({
    participantId: member.participantId,
    weight: parseWeight(weights[member.participantId] ?? ""),
  }));
  const hasInvalidWeight =
    shareKind === "manual" && parsedWeights.some((entry) => entry.weight === null);
  const weightTotal = parsedWeights.reduce(
    (sum, entry) => sum + (entry.weight ?? 0),
    0,
  );
  const weightSumIsZero = shareKind === "manual" && weightTotal <= 0;

  const canSubmit =
    bossIds.length > 0 && !hasInvalidWeight && !weightSumIsZero && !isSubmitting;

  const submit = () => {
    if (!canSubmit) return;
    const share: BundleShareInput =
      shareKind === "manual"
        ? {
            kind: "manual",
            weights: parsedWeights.map((entry) => ({
              participantId: entry.participantId,
              weight: entry.weight ?? 0,
            })),
          }
        : { kind: shareKind };

    onSubmit({
      /*
        ⚠️ **네 칸을 전부 보낸다.** 이 창이 그 넷의 집이고 화면에 값이 다 떠 있으므로,
           보낸 값이 곧 사용자가 보고 있는 값이다. 일부만 보내는 것(= PATCH 의 보존)은
           다른 화면(일정 창의 소요 시간 등)의 몫이다.
        ★ `durationMinutes` 는 `bossDifficultyIds` 와 **같은 길이**여야 한다(아니면 400).
          둘을 한 번에 움직이는 `PartyBossPicker` 의 콜백이 그 짝을 보장한다.
      */
      name,
      bossDifficultyIds: bossIds,
      /*
        ★ **안 고쳤으면 키를 아예 싣지 않는다**(위 `durationsTouched` 머리말). 그러면
          서버가 보스별 기존 값을 보존하고, 새로 담은 보스만 "정하지 않음" 으로 들어간다.
        ★ 실을 때는 길이가 `bossDifficultyIds` 와 **같아야 한다**(다르면 400). 같은
          `bossIds` 를 돌려 짝을 맞춘다 — 두 배열을 함께 움직이는 `PartyBossPicker` 의
          콜백이 그 짝을 이미 보장하지만, 자리 수는 여기서 한 번 더 못박는다.
      */
      ...(durationsTouched
        ? {
            durationMinutes: bossIds.map(
              (_, index) => durations[index] ?? null,
            ),
          }
        : {}),
      share,
      crystalFollowsShare,
      /*
        ★ 내 캐릭터는 **내 줄이 있을 때만** 보낸다. 게스트만으로 된 파티나 공개 파티를
          구경하는 경우에는 고칠 대상이 없다.
      */
      ...(myRow === null ? {} : { myCharacterId }),
    });
  };

  if (!open) return null;

  const title =
    mode === "edit"
      ? "보스 묶음 편집"
      : mode === "copy"
        ? "보스 묶음 복사"
        : "보스 묶음 추가";

  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={
        mode === "copy"
          ? "보스·캐릭터·분배를 그대로 가져왔습니다. 고칠 것만 바꾸고 저장하세요."
          : "같은 파티 안에서 보스 조합·캐릭터·분배를 따로 두는 단위입니다. 조합이 늘어도 파티를 더 만들 필요가 없습니다."
      }
      footer={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={isSubmitting}>
            취소
          </Button>
          <Button onClick={submit} disabled={!canSubmit}>
            {isSubmitting
              ? "저장 중…"
              : mode === "edit"
                ? "저장"
                : "묶음 만들기"}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        {/* ── ① 갈 보스 ─────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-2">
          <h3 className="text-body-sm font-semibold text-ink">
            묶어서 도는 보스{" "}
            <span className="tabular-nums text-ink-muted">
              {bossIds.length}개
            </span>
          </h3>

          {/*
            ── **전에 돈 보스**를 먼저 (발주 지시 2026-10-16) ─────────────────
            원문의 요구는 *"보스 고르기를 빠르게 — 그 파티가 전에 돈 보스를 먼저 보여
            체크 수를 줄여라"* 다. 재료는 같은 파티의 **다른 묶음**에 이미 등록된 보스이고
            **새 조회가 없다**(부모가 묶음 목록을 이미 들고 있다).

            ★ 검색창 **위**다. 아래 검색은 "카탈로그 54건에서 찾기"이고 이 줄은 "늘 돌던
              것 담기"라, 자주 쓰는 쪽이 위에 와야 손이 덜 간다.
            ★ 이미 담은 보스는 권하지 않는다(`quickAddIds`). 눌러도 아무 일 없는 칩은
              "왜 안 담기지"가 된다.
          */}
          {quickAddIds.length === 0 ? null : (
            <div className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2">
              <p className="text-body-sm text-ink-muted">
                이 파티가 전에 돈 보스 — 눌러서 바로 담기
              </p>
              <div className="flex flex-wrap gap-1.5">
                {quickAddIds.map((id) => {
                  const boss = bosses.find(
                    (entry) => entry.bossDifficultyId === id,
                  );
                  return (
                    <button
                      key={id}
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => {
                        /*
                          새 보스는 **"정하지 않음"(null)** 으로 들어간다. 20 을 심으면
                          거짓 확정이 되고, 기본값을 바꿀 때 이 묶음만 영원히 20분이다.
                          두 배열은 **언제나 함께** 움직인다(`PartyBossPicker` 머리말).
                        */
                        setBossIds((prev) => [...prev, id]);
                        setDurations((prev) => [...prev, null]);
                      }}
                      className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-body-sm text-ink transition duration-200 hover:border-primary hover:bg-hover-surface focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
                    >
                      <BossIcon
                        bossDifficultyId={id}
                        difficulty={boss?.difficulty ?? "normal"}
                        size="xs"
                      />
                      <span className="truncate">
                        {boss?.koreanName ?? id}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <PartyBossPicker
            bosses={bosses}
            selectedIds={bossIds}
            durations={durations}
            /*
              인원 = 파티의 **현재** 구성원 수. 서버가 `left_at is null` 로 거른 목록이라
              나간 사람은 이미 빠져 있다. 묶음 편집에는 "이번에 갈 사람"을 고르는 칸이 없으므로
              이것이 가진 것 중 가장 가까운 값이다.
            */
            partySize={members.length}
            disabled={isSubmitting}
            onChange={(nextIds, nextDurations) => {
              setBossIds(nextIds);
              setDurations(nextDurations);
            }}
            onDurationEdit={(bossDifficultyId, minutes) => {
              setDurations((prev) =>
                bossIds.map((id, index) =>
                  id === bossDifficultyId ? minutes : (prev[index] ?? null),
                ),
              );
              // 값 수정만 센다(위 `durationsTouched` 머리말).
              setDurationsTouched(true);
            }}
          />

          {bossIds.length === 0 ? (
            /*
              ⚠️ **저장을 막는 상태**다. 보스가 없는 묶음으로는 일정을 잡을 수 없고
                 (서버가 400), 빈 묶음은 목록에서 아무것도 알려 주지 않는다.
                 `tone="error"` 는 "지금 누를 수 없다"는 뜻이다 — 주황은 임박·주의용이다(§4).
            */
            <HelperText tone="error">
              갈 보스를 하나 이상 담아 주세요. 보스가 없으면 이 묶음으로 일정을
              잡을 수 없습니다.
            </HelperText>
          ) : null}
        </section>

        {/* ── ② 이름 ──────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-1.5">
          <Label htmlFor={nameId}>묶음 이름</Label>
          <Input
            id={nameId}
            value={name}
            disabled={isSubmitting}
            maxLength={80}
            placeholder={autoName}
            onChange={(event) => setName(event.target.value)}
          />
          <HelperText>
            비워 두면 <strong className="font-semibold">{autoName}</strong>{" "}
            (으)로 자동입니다. {PARTY_TITLE_HINT} 파티 이름은 바뀌지 않습니다.
          </HelperText>
        </section>

        {/* ── ③ 각자 캐릭터 ───────────────────────────────────────────────── */}
        <section className="flex flex-col gap-2">
          <h3 className="text-body-sm font-semibold text-ink">각자 캐릭터</h3>
          <p className="text-body-sm text-ink-muted">
            이 묶음으로 일정을 잡으면 아래 캐릭터로 참가 기록이 만들어집니다.
            같은 사람이 묶음마다 다른 캐릭터로 갈 수 있는 것이 이 칸의 존재
            이유입니다.
          </p>
          {members.length === 0 ? (
            <p className="text-body-sm text-ink-label">
              구성원이 없습니다. 파티 편집에서 사람을 먼저 넣어 주세요.
            </p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {members.map((member) => (
                <li
                  key={member.participantId}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-border bg-surface px-2.5 py-1.5"
                >
                  <SeatNumber seatNo={member.seatNo} size="sm" />
                  <span className="min-w-0 flex-1 basis-24 truncate text-body-sm text-ink">
                    {/*
                      이름 조합 규칙(`더저(메검메)`)의 주인은 `participantLabel` 하나다 —
                      여기서 다시 만들면 파티 띠·일정 창과 글자가 갈린다.
                      ⚠️ `isMainCharacter` 를 **false 로 둔다.** 묶음 payload 는 본캐 여부를
                         싣지 않는데(그 값은 `characters.is_main` 이고 묶음의 성질이 아니다),
                         false 면 캐릭터 이름이 **언제나 괄호로 함께** 적힌다. 본캐로 가는
                         사람에게 `더저(더저)` 가 되는 자리지만, 캐릭터가 파티 기본값과
                         같을 때는 `partyCharacterName` 이 `displayName` 과 같은 글자라
                         실제로는 괄호가 붙지 않는다(`participantAltCharacterName` 이 같은
                         문자열을 접는다). 다른 캐릭터로 갈 때만 괄호가 생기고, 그게 이
                         목록이 보여 줘야 하는 바로 그 사실이다.
                    */}
                    {participantLabel({
                      displayName: member.displayName,
                      isGuest: member.isGuest,
                      characterName:
                        member.bundleCharacterName ??
                        member.partyCharacterName,
                      isMainCharacter: false,
                    })}
                  </span>
                  {member.isMe ? (
                    <>
                      <label
                        className="sr-only"
                        htmlFor={`bundle-character-${member.participantId}`}
                      >
                        내가 데려갈 캐릭터
                      </label>
                      {/*
                        ★ 네이티브 `<select>` 다. 파티 띠의 캐릭터 선택이 이미 같은 것을
                          쓰고 있어 두 자리가 같은 조작법을 갖는다.
                        ★ 빈 값은 **"파티 기본값 따름"** 이고 0 이나 거짓 확정이 아니다.
                      */}
                      <select
                        id={`bundle-character-${member.participantId}`}
                        className="h-control-sm max-w-44 shrink-0 rounded-md border border-border bg-surface px-2 text-body-sm text-ink"
                        value={myCharacterId ?? ""}
                        disabled={isSubmitting}
                        onChange={(event) =>
                          setMyCharacterId(
                            event.target.value === ""
                              ? null
                              : event.target.value,
                          )
                        }
                      >
                        <option value="">
                          파티 기본값 따름
                          {member.partyCharacterName === null
                            ? ""
                            : ` (${member.partyCharacterName})`}
                        </option>
                        {characters.map((entry) => (
                          <option
                            key={entry.characterId}
                            value={entry.characterId}
                          >
                            {entry.name}
                            {entry.isMain ? " (본캐)" : ""}
                          </option>
                        ))}
                      </select>
                    </>
                  ) : (
                    <span className="shrink-0 text-caption text-ink-muted">
                      {member.bundleCharacterName === null
                        ? "파티 기본값"
                        : "이 묶음 지정"}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {/*
            ⚠️ **없는 버튼을 가리키지 않는다.** 남의 캐릭터를 고를 칸은 이 창에 없고,
               그 사실과 이유를 한 줄로 말한다(§ `BUNDLE_OTHER_CHARACTER_NOTE`).
          */}
          <HelperText>{BUNDLE_OTHER_CHARACTER_NOTE}</HelperText>
        </section>

        {/* ── ④ 분배 ─────────────────────────────────────────────────────── */}
        <section className="flex flex-col gap-2">
          <h3 className="text-body-sm font-semibold text-ink">분배</h3>
          <div
            role="radiogroup"
            aria-label="분배 방식"
            className="flex flex-col gap-1"
          >
            <Radio
              name={shareGroupName}
              checked={shareKind === "inherit"}
              disabled={isSubmitting}
              onChange={() => setShareKind("inherit")}
              label={
                <span className="text-body-sm text-ink">
                  파티 설정 따름{" "}
                  <span className="text-ink-muted">
                    (지금 파티는{" "}
                    {partyShareMode === "manual" ? "비율 지정" : "균등"})
                  </span>
                </span>
              }
            />
            <Radio
              name={shareGroupName}
              checked={shareKind === "equal"}
              disabled={isSubmitting}
              onChange={() => setShareKind("equal")}
              label={
                <span className="text-body-sm text-ink">
                  이 묶음만 균등 (1/n)
                </span>
              }
            />
            <Radio
              name={shareGroupName}
              checked={shareKind === "manual"}
              disabled={isSubmitting}
              onChange={() => setShareKind("manual")}
              label={
                <span className="text-body-sm text-ink">
                  이 묶음만 비율 지정
                </span>
              }
            />
          </div>

          {/*
            ★ **상속일 때 입력칸을 그리지 않는다.** 비어 있음이 "파티를 따름"이라는 사실을
              화면이 그대로 보여야 하고, 칸에 숫자를 띄우면(특히 0) 그 숫자가 저장된
              약정처럼 읽힌다 — 이 창에서 가장 조심해야 하는 자리다.
          */}
          {shareKind === "manual" ? (
            <ul className="flex flex-col gap-1.5">
              {members.map((member) => {
                const text = weights[member.participantId] ?? "";
                const invalid = parseWeight(text) === null;
                return (
                  <li
                    key={member.participantId}
                    className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5"
                  >
                    <SeatNumber seatNo={member.seatNo} size="sm" />
                    <span className="min-w-0 flex-1 truncate text-body-sm text-ink">
                      {member.displayName}
                    </span>
                    <label
                      className="sr-only"
                      htmlFor={`bundle-share-${member.participantId}`}
                    >
                      {member.displayName} 분배 가중치
                    </label>
                    <Input
                      id={`bundle-share-${member.participantId}`}
                      className="h-control-sm w-20 text-right"
                      type="number"
                      inputMode="decimal"
                      min={0}
                      max={WEIGHT_INPUT_MAX}
                      step={0.01}
                      value={text}
                      disabled={isSubmitting}
                      invalid={invalid}
                      onChange={(event) =>
                        setWeights((prev) => ({
                          ...prev,
                          [member.participantId]: event.target.value,
                        }))
                      }
                    />
                  </li>
                );
              })}
            </ul>
          ) : null}

          {hasInvalidWeight ? (
            <HelperText tone="error">
              숫자로 된 가중치를 넣어 주세요. 0 이상 {WEIGHT_INPUT_MAX}{" "}
              이하까지 됩니다.
            </HelperText>
          ) : weightSumIsZero ? (
            <HelperText tone="error">
              합이 0 입니다. 최소 한 명은 0보다 큰 값을 가져야 합니다.
            </HelperText>
          ) : (
            <HelperText>
              비율은 가중치입니다 —{" "}
              <strong className="font-semibold">1 : 2</strong> 처럼 적으면 됩니다.
              만분율 환산과 잔돈은 서버가 나눕니다.
            </HelperText>
          )}

          {/*
            ── 결정석 포함 (발주 직접 요구) ──────────────────────────────────
            원문: *"분배비율 에 결정석 포함 설정을 넣어. 드랍만 비율로 거는사람도있어"*.
            ★ **끄면 무슨 일이 일어나는지** 한 줄이 반드시 붙는다. 토글 이름만으로는
              "결정석을 안 받는다"로도 읽히는데 실제 뜻은 "결정석은 균등"이다.
          */}
          <div className="flex flex-col gap-1 rounded-md border border-border bg-background px-2.5 py-2">
            <Checkbox
              checked={crystalFollowsShare}
              disabled={isSubmitting}
              onChange={(event) =>
                setCrystalFollowsShare(event.target.checked)
              }
              label={
                <span className="text-body-sm text-ink">
                  결정석도 위 비율로 나누기
                </span>
              }
            />
            <p className="text-body-sm text-ink-muted">
              {BUNDLE_CRYSTAL_FOLLOWS_SHARE_HINT}
            </p>
          </div>
        </section>

        {submitError === null ? null : (
          <ErrorState
            title="묶음을 저장하지 못했습니다"
            detail={submitError.message}
            className="py-4"
          />
        )}
      </div>
    </Dialog>
  );
}
