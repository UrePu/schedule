"use client";

import { Package, Plus, TriangleAlert, Users } from "lucide-react";
import { useState } from "react";

import { MesoAmount, Numeric } from "@/components/domain";
import {
  Button,
  Dialog,
  HelperText,
  Input,
  Label,
  Radio,
} from "@/components/ui";
import { cn } from "@/lib/utils";

import type {
  DropShareMode,
  RunDropParticipant,
  RunDropRecord,
  ScheduledRunClear,
} from "../types";
import { WarningNote } from "./warning-note";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 드랍 기록 — 발주 요구: *"드랍은 어디서 하는건지 모르겠네"* → *"드랍 넣고"*
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 **일정(런)** 에서 넣는가 — 그리고 왜 수익 화면인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 드랍은 특정 런에서 나오고 **그 자리에 있던 사람들끼리** 나눈다(`run_drops.run_id`,
 * 수령자는 그 런의 `going` 참가자). 그래서 입력 단위는 파티가 아니라 런이다.
 *
 * 그 런을 손대는 자리는 두 곳이었다 — `/schedule` 의 일정 카드와 `/income` 의 클리어
 * 체크 목록. **수익 화면을 골랐다.**
 *   - 드랍의 수명 주기가 통째로 이 화면에 있다: 기록 → 나중에 판매액 채움 → 주간 드랍
 *     합계와 미판매 건수가 움직임. 세 표시 모두 이미 `/income` 이 그리고 있었다.
 *   - 클리어 체크 바로 옆이다. 둘 다 "그 런에서 번 것"을 적는 **같은 결의 조작**이고,
 *     사람들이 보스를 돌고 나서 한 번에 하는 일이다.
 *   - `/schedule` 은 "언제 갈까"를 맞추는 화면이다. 거기서 메소 정산을 시작하면 조율
 *     중인 화면에 금액이 섞인다.
 * 두 곳에 다 두지 않는 이유는 하나다 — 같은 조작의 입구가 둘이면 반드시 갈라진다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ **"아직 안 팔았다" 가 1급 상태다** — 이 창의 설계 중심
 * ─────────────────────────────────────────────────────────────────────────────
 * 판매액 칸은 **필수가 아니고**, 기본값이 "아직 안 팔았음"이다. `sale_amount_meso` 의
 * `null` 은 0 이 아니라 모름이며(DB 컬럼 주석), 그런 행은 합계에서 빠지고 미판매 건수로
 * 따로 세어진다. 모르는 값을 0 으로 채우면 "0메소를 벌었다"는 거짓이 된다 —
 * 벨로나 미확인 가격을 0 으로 더하지 않는 것(§1.3 D4)과 같은 기조다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ **이 창은 1/n 을 계산하지 않는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 우리가 보내는 것은 판매 **총액**과 분배 **방식**뿐이다. 누가 얼마를 가져가는지는
 * `v_run_drop_recipients` → `distribute_meso()` → `v_run_drop_settlement` 이 정하고,
 * 화면은 그 결과(`myShareMeso`)를 받아 적기만 한다. 화면이 나누기 시작하면 웹과
 * 카톡 봇(`!분배`)의 답이 갈라진다 — 이 저장소에서 이미 두 번 일어난 사고다.
 *
 * ⚠️ 삭제는 **되돌릴 수 없다**(딸린 `run_drop_shares` 도 cascade 로 사라진다). 그래서
 *    `credential-manager` 의 키 삭제와 같은 규약을 쓴다 — 진입 버튼은 빨강이 아니고,
 *    최종 확인 버튼만 `destructive` 이며, 안내 상자는 주황이 배경·아이콘을 지고
 *    문장은 잉크가 진다(§4).
 */

/** 분배 방식 표시 문구. `custom` 은 읽기 전용이라 목록에만 나온다. */
const SHARE_MODE_LABEL: Record<DropShareMode, string> = {
  party_default: "파티 기본 분배",
  custom: "이 건 전용 비율",
  solo: "한 사람이 전부",
};

/** 우리 쓰기 경로가 만드는 두 값. `custom` 은 여기 없다(`DropShareMode` 주석). */
type EditableShareMode = Exclude<DropShareMode, "custom">;

interface DropFormValue {
  readonly itemName: string;
  /** 체크하면 판매액 칸이 열린다. **기본값은 꺼짐 = 아직 안 팔았음.** */
  readonly sold: boolean;
  /** 숫자만 담는 문자열. 빈 값이면 판매액 없음으로 취급한다. */
  readonly saleAmount: string;
  readonly shareMode: EditableShareMode;
  readonly soloParticipantId: string;
  readonly note: string;
}

const EMPTY_FORM: DropFormValue = {
  itemName: "",
  sold: false,
  saleAmount: "",
  shareMode: "party_default",
  soloParticipantId: "",
  note: "",
};

function formFromRecord(drop: RunDropRecord): DropFormValue {
  return {
    itemName: drop.itemName,
    sold: drop.saleAmountMeso !== null,
    saleAmount: drop.saleAmountMeso === null ? "" : String(drop.saleAmountMeso),
    // `custom` 인 행은 편집기가 방식을 못 바꾸므로 기본값으로 두고 아래에서 잠근다.
    shareMode: drop.shareMode === "solo" ? "solo" : "party_default",
    soloParticipantId: drop.soloParticipantId ?? "",
    note: drop.note ?? "",
  };
}

/** 입력 문자열 → 메소. 빈 값·판매 안 함은 `null`(미판매)이며 **0 이 아니다.** */
function parseSaleAmount(value: DropFormValue): number | null {
  if (!value.sold) return null;
  const digits = value.saleAmount.replace(/[^0-9]/g, "");
  if (digits.length === 0) return null;
  const parsed = Number.parseInt(digits, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** 저장 버튼을 눌러도 되는가. 판매액은 비어 있어도 되지만 이름은 있어야 한다. */
function formError(value: DropFormValue): string | null {
  if (value.itemName.trim().length === 0) {
    return "아이템 이름을 입력해 주세요.";
  }
  if (value.itemName.trim().length > 100) {
    return "아이템 이름은 100자까지 입력할 수 있습니다.";
  }
  if (value.shareMode === "solo" && value.soloParticipantId === "") {
    return "전부 가져갈 사람을 골라 주세요.";
  }
  if (value.sold && value.saleAmount.replace(/[^0-9]/g, "").length === 0) {
    return "판매액을 입력하거나 '아직 안 팔았음'으로 두세요.";
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 입력 폼 — 추가와 수정이 **같은 폼**을 쓴다
// ─────────────────────────────────────────────────────────────────────────────

/*
 * 같은 필드를 두 벌 만들면 한쪽에만 규칙이 붙는 날이 온다. 실제로 위험한 필드가
 * "판매액을 비워 둘 수 있다" 하나뿐이라, 그 규칙이 두 곳에 갈라지면 한쪽에서만
 * 0 이 들어가기 시작한다.
 */
function DropForm({
  idPrefix,
  value,
  participants,
  lockedShareMode,
  disabled,
  submitLabel,
  onChange,
  onSubmit,
  onCancel,
}: {
  readonly idPrefix: string;
  readonly value: DropFormValue;
  readonly participants: readonly RunDropParticipant[];
  /** `custom` 비율이 걸린 행. 방식을 바꿀 수 없다는 사실을 폼이 직접 말한다. */
  readonly lockedShareMode: boolean;
  readonly disabled: boolean;
  readonly submitLabel: string;
  readonly onChange: (next: DropFormValue) => void;
  readonly onSubmit: () => void;
  readonly onCancel?: () => void;
}) {
  const error = formError(value);
  const preview = parseSaleAmount(value);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (error === null && !disabled) onSubmit();
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${idPrefix}-name`} required>
          아이템
        </Label>
        <Input
          id={`${idPrefix}-name`}
          value={value.itemName}
          maxLength={100}
          disabled={disabled}
          placeholder="예: 파풀라투스의 시계태엽"
          onChange={(event) =>
            onChange({ ...value, itemName: event.target.value })
          }
        />
      </div>

      {/*
        ★ **판매 여부가 먼저다.** 금액 칸을 항상 열어 두면 사람들이 "모르니까 0" 을 적는다.
          기본값은 꺼짐이고, 그 상태가 곧 `sale_amount_meso = null`(미판매)이다.
      */}
      <div className="flex flex-col gap-2">
        <span className="text-body-sm font-medium text-ink">판매</span>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          <Radio
            name={`${idPrefix}-sold`}
            label="아직 안 팔았음"
            checked={!value.sold}
            disabled={disabled}
            onChange={() => onChange({ ...value, sold: false })}
          />
          <Radio
            name={`${idPrefix}-sold`}
            label="팔았음 · 금액 입력"
            checked={value.sold}
            disabled={disabled}
            onChange={() => onChange({ ...value, sold: true })}
          />
        </div>

        {value.sold ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor={`${idPrefix}-amount`}>판매 총액 (메소)</Label>
            <Input
              id={`${idPrefix}-amount`}
              value={value.saleAmount}
              inputMode="numeric"
              disabled={disabled}
              placeholder="예: 3000000000"
              aria-describedby={`${idPrefix}-amount-help`}
              onChange={(event) =>
                onChange({
                  ...value,
                  saleAmount: event.target.value.replace(/[^0-9]/g, ""),
                })
              }
            />
            <HelperText id={`${idPrefix}-amount-help`}>
              파티 전체가 받은 <strong className="font-semibold">총액</strong>을
              적습니다. 나누는 것은 서버가 합니다
              {preview === null ? null : (
                <>
                  {" — "}
                  <MesoAmount value={preview} compact className="inline-flex" />
                </>
              )}
            </HelperText>
          </div>
        ) : (
          <HelperText id={`${idPrefix}-unsold-help`}>
            금액을 비워 두면 <strong className="font-semibold">미판매</strong>로
            기록됩니다. 합계에 0 으로 더해지지 않고 건수로만 세어지며, 팔린 뒤에
            금액만 채우면 됩니다.
          </HelperText>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-body-sm font-medium text-ink">분배</span>
        {lockedShareMode ? (
          <HelperText>
            이 드랍에는 건별 사용자 지정 비율이 걸려 있습니다. 분배 방식은 이
            화면에서 바꿀 수 없습니다.
          </HelperText>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              <Radio
                name={`${idPrefix}-share`}
                label={`파티 기본 분배 (${participants.length}명)`}
                checked={value.shareMode === "party_default"}
                disabled={disabled}
                onChange={() =>
                  onChange({ ...value, shareMode: "party_default" })
                }
              />
              <Radio
                name={`${idPrefix}-share`}
                label="한 사람이 전부"
                checked={value.shareMode === "solo"}
                disabled={disabled || participants.length === 0}
                onChange={() => onChange({ ...value, shareMode: "solo" })}
              />
            </div>

            {value.shareMode === "solo" ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor={`${idPrefix}-solo`} required>
                  전부 가져갈 사람
                </Label>
                {/*
                  §1.4 — 번호는 관리 식별자다. 카톡 평문에서 "3번"으로 부를 수 있도록
                  이름 앞에 번호를 함께 그린다. 번호는 재부여되지 않는다.
                */}
                <select
                  id={`${idPrefix}-solo`}
                  value={value.soloParticipantId}
                  disabled={disabled}
                  className={cn(
                    "h-control-md w-full rounded-md border border-border bg-surface px-3 py-2",
                    "text-body-sm text-ink",
                    "transition duration-200 outline-none",
                    "focus:border-primary focus:ring-[3px] focus:ring-focus-ring",
                    "disabled:cursor-not-allowed disabled:bg-background disabled:text-ink/50",
                  )}
                  onChange={(event) =>
                    onChange({ ...value, soloParticipantId: event.target.value })
                  }
                >
                  <option value="" disabled>
                    사람을 골라 주세요
                  </option>
                  {participants.map((person) => (
                    <option
                      key={person.participantId}
                      value={person.participantId}
                    >
                      {person.memberNo === null
                        ? person.displayName
                        : `${String(person.memberNo)}번 · ${person.displayName}`}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <HelperText>
                그 일정에 참여로 등록한 사람끼리 나눕니다. 비율을 따로 정해 둔
                파티면 그 비율을 그대로 따릅니다.
              </HelperText>
            )}
          </>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={`${idPrefix}-note`}>메모</Label>
        <Input
          id={`${idPrefix}-note`}
          value={value.note}
          maxLength={500}
          disabled={disabled}
          placeholder="선택 입력"
          onChange={(event) => onChange({ ...value, note: event.target.value })}
        />
      </div>

      {error === null ? null : (
        <HelperText tone="error" role="alert">
          {error}
        </HelperText>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={disabled || error !== null}
        >
          {submitLabel}
        </Button>
        {onCancel === undefined ? null : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={onCancel}
          >
            취소
          </Button>
        )}
      </div>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 드랍 한 줄
// ─────────────────────────────────────────────────────────────────────────────

/*
 * ★ 편집 폼은 **편집 중일 때만 마운트된다.** 그래서 초기값을 `useState` 로 한 번만
 *   읽으면 되고, "행이 새로 내려왔으니 폼도 다시 채워라"는 effect 가 필요 없다
 *   (같이 간 사람이 먼저 금액을 채웠을 수 있으므로 그 동기화 자체는 필요한데,
 *   닫았다 여는 순간 새로 마운트되며 자연히 해결된다). React 문서가 말하는
 *   "effect 로 상태를 되맞추지 말고 언마운트로 리셋하라"가 정확히 이 경우다.
 */
function DropEditForm({
  drop,
  participants,
  pending,
  onSave,
  onCancel,
}: {
  readonly drop: RunDropRecord;
  readonly participants: readonly RunDropParticipant[];
  readonly pending: boolean;
  readonly onSave: (value: DropFormValue) => void;
  readonly onCancel: () => void;
}) {
  const [form, setForm] = useState<DropFormValue>(() => formFromRecord(drop));

  return (
    <div className="rounded-md border border-border bg-background p-3">
      <DropForm
        idPrefix={`drop-edit-${drop.dropId}`}
        value={form}
        participants={participants}
        lockedShareMode={drop.shareMode === "custom"}
        disabled={pending}
        submitLabel={pending ? "저장하는 중…" : "저장"}
        onChange={setForm}
        onSubmit={() => onSave(form)}
        onCancel={onCancel}
      />
    </div>
  );
}

function DropRow({
  drop,
  participants,
  pending,
  isEditing,
  isConfirmingDelete,
  onStartEdit,
  onCancelEdit,
  onStartDelete,
  onCancelDelete,
  onSave,
  onDelete,
}: {
  readonly drop: RunDropRecord;
  readonly participants: readonly RunDropParticipant[];
  readonly pending: boolean;
  readonly isEditing: boolean;
  readonly isConfirmingDelete: boolean;
  readonly onStartEdit: () => void;
  readonly onCancelEdit: () => void;
  readonly onStartDelete: () => void;
  readonly onCancelDelete: () => void;
  readonly onSave: (value: DropFormValue) => void;
  readonly onDelete: () => void;
}) {
  const unsold = drop.saleAmountMeso === null;

  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-surface px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span
          className="min-w-0 flex-1 truncate text-body-sm font-semibold text-ink"
          title={drop.itemName}
        >
          {drop.itemName}
        </span>

        {/*
          ⚠️ 미판매는 **금액 0 이 아니라 별도 상태**다. 배지로 그리고 금액 자리는
             비운다 — `0 메소` 를 찍는 순간 "0원에 팔았다"는 거짓이 된다.
             §4: 조치가 필요한 상태이므로 주황이되, 글자는 잉크다.
        */}
        {unsold ? (
          <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border border-chip-soon-border bg-chip-soon-bg px-2 py-0.5 text-caption text-ink">
            <TriangleAlert aria-hidden size={12} className="text-tertiary" />
            미판매
          </span>
        ) : (
          <MesoAmount
            value={drop.saleAmountMeso}
            compact
            suffix={false}
            className="shrink-0 text-body-sm"
          />
        )}

        <span
          className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-caption text-ink-muted"
          title={
            drop.shareMode === "solo"
              ? `${drop.soloDisplayName ?? "지정된 사람"} 이(가) 전부 가져갑니다.`
              : `${String(drop.recipientCount)}명이 나눠 갖습니다. 계산은 서버가 합니다.`
          }
        >
          <Users aria-hidden size={12} />
          {drop.shareMode === "solo"
            ? `독식 · ${drop.soloDisplayName ?? "알 수 없음"}`
            : `${SHARE_MODE_LABEL[drop.shareMode]} · `}
          {drop.shareMode === "solo" ? null : (
            <>
              <Numeric>{drop.recipientCount}</Numeric>명
            </>
          )}
        </span>

        {/*
          내 몫. **DB 가 낸 값**이며 화면이 나눈 값이 아니다(파일 머리말).
          미판매면 `null` 이라 "미확인"으로 그려진다 — 0 이 아니다.
        */}
        <span className="flex shrink-0 items-center gap-1 whitespace-nowrap text-caption text-ink-label">
          내 몫
          <MesoAmount
            value={drop.myShareMeso}
            compact
            suffix={false}
            unknownLabel="판매 후"
            className="text-body-sm"
          />
        </span>

        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={isEditing ? onCancelEdit : onStartEdit}
          >
            {isEditing ? "닫기" : unsold ? "판매액 입력" : "수정"}
          </Button>
          {/* 진입 버튼은 빨강이 아니다 — 최종 확인만 destructive (§4). */}
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={isConfirmingDelete ? onCancelDelete : onStartDelete}
          >
            {isConfirmingDelete ? "그대로 두기" : "삭제"}
          </Button>
        </div>
      </div>

      {drop.note === null ? null : (
        <p className="text-body-sm text-ink-muted">{drop.note}</p>
      )}

      {isConfirmingDelete ? (
        <div className="flex flex-col gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg p-3">
          <div className="flex items-start gap-2">
            <TriangleAlert
              aria-hidden
              size={16}
              className="mt-0.5 shrink-0 text-tertiary"
            />
            <p className="min-w-0 flex-1 text-body-sm text-ink">
              <strong className="font-semibold">{drop.itemName}</strong> 기록을
              지웁니다. 이 건에 걸린 분배 비율도 함께 사라지며{" "}
              <strong className="font-semibold">되돌릴 수 없습니다.</strong> 이
              일정 자체와 클리어 기록은 그대로 남습니다.
            </p>
          </div>
          <div>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={onDelete}
            >
              {pending ? "지우는 중…" : "지웁니다"}
            </Button>
          </div>
        </div>
      ) : null}

      {isEditing ? (
        <DropEditForm
          drop={drop}
          participants={participants}
          pending={pending}
          onSave={onSave}
          onCancel={onCancelEdit}
        />
      ) : null}
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 창
// ─────────────────────────────────────────────────────────────────────────────

export interface RunDropDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 어느 일정의 드랍인가. `null` 이면 창을 그리지 않는다. */
  readonly run: ScheduledRunClear | null;
  /** 저장 중인 드랍 id. 추가 중이면 `"new"`. */
  readonly pendingKey: string | null;
  readonly errorMessage: string | null;
  readonly onAdd: (input: {
    readonly itemName: string;
    readonly saleAmountMeso: number | null;
    readonly shareMode: EditableShareMode;
    readonly soloParticipantId: string | null;
    readonly note: string | null;
  }) => void;
  readonly onUpdate: (
    dropId: string,
    input: {
      readonly itemName: string;
      readonly saleAmountMeso: number | null;
      readonly shareMode: EditableShareMode | undefined;
      readonly soloParticipantId: string | null;
      readonly note: string | null;
    },
  ) => void;
  readonly onRemove: (dropId: string) => void;
}

/**
 * 창 껍데기. **상태가 없다** — 전부 `RunDropDialogBody` 에 있고, 그 본체는 일정별
 * `key` 로 마운트된다.
 *
 * ★ 그렇게 나눈 이유: 다른 일정으로 창을 다시 열었는데 앞 일정의 입력이 남아 있으면
 *   안 된다(다른 보스의 드랍 이름이 미리 들어간 폼은 오입력을 부른다). 그 초기화를
 *   effect 로 하면 setState 가 렌더를 연쇄시키고 린트가 정확히 그것을 막는다 —
 *   `key` 로 언마운트시키는 것이 React 가 권하는 리셋 방법이다. 닫으면 `run` 이
 *   `null` 이 되어 본체가 통째로 사라지므로 두 경우가 한 규칙으로 처리된다.
 */
export function RunDropDialog(props: RunDropDialogProps) {
  if (props.run === null) return null;
  return <RunDropDialogBody key={props.run.runId} {...props} run={props.run} />;
}

function RunDropDialogBody({
  open,
  onClose,
  run,
  pendingKey,
  errorMessage,
  onAdd,
  onUpdate,
  onRemove,
}: Omit<RunDropDialogProps, "run"> & { readonly run: ScheduledRunClear }) {
  const [addForm, setAddForm] = useState<DropFormValue>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );

  const drops = run.drops;
  const unsoldCount = drops.filter((drop) => drop.saleAmountMeso === null).length;
  const addError = formError(addForm);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="드랍 기록"
      description={
        <>
          {run.bossDisplayName} · {run.partyName} <Numeric>{run.runNo}</Numeric>
          번 일정에서 나온 결정석 외 드랍입니다. 결정석 12개 상한과는 별개 계통이며,
          판매액은 나중에 채워도 됩니다.
        </>
      }
      className="max-w-2xl"
    >
      <div className="flex flex-col gap-4">
        {errorMessage === null ? null : (
          <HelperText tone="error" role="alert">
            {errorMessage}
          </HelperText>
        )}

        <section className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-headline text-body-lg font-semibold text-ink">
              기록된 드랍
            </h3>
            <span className="text-body-sm text-ink-muted tabular-nums">
              {drops.length}건
              {unsoldCount === 0 ? null : ` · 미판매 ${String(unsoldCount)}건`}
            </span>
          </div>

          {/*
            빈 상태는 **"0원"이 아니라 "아직 기록한 드랍이 없다"** 이다(§0.3).
            금액 0 을 찍으면 "아무것도 못 벌었다"는 다른 주장이 된다.
          */}
          {drops.length === 0 ? (
            <p className="flex items-center gap-2 rounded-md border border-border bg-background px-3 py-4 text-body-sm text-ink-muted">
              <Package aria-hidden size={16} className="shrink-0" />
              아직 이 일정에 기록한 드랍이 없습니다. 아래에서 아이템을 추가하세요.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {drops.map((drop) => (
                <DropRow
                  key={drop.dropId}
                  drop={drop}
                  participants={run.dropParticipants}
                  pending={pendingKey === drop.dropId}
                  isEditing={editingId === drop.dropId}
                  isConfirmingDelete={confirmingDeleteId === drop.dropId}
                  onStartEdit={() => {
                    setEditingId(drop.dropId);
                    setConfirmingDeleteId(null);
                  }}
                  onCancelEdit={() => setEditingId(null)}
                  onStartDelete={() => {
                    setConfirmingDeleteId(drop.dropId);
                    setEditingId(null);
                  }}
                  onCancelDelete={() => setConfirmingDeleteId(null)}
                  onSave={(value) => {
                    onUpdate(drop.dropId, {
                      itemName: value.itemName.trim(),
                      saleAmountMeso: parseSaleAmount(value),
                      /*
                        `custom` 행은 방식을 보내지 않는다 — 서버가 거절하고, 애초에
                        폼에서 바꿀 수도 없다. 판매액만 채우러 오는 경로다.
                      */
                      shareMode:
                        drop.shareMode === "custom" ? undefined : value.shareMode,
                      soloParticipantId:
                        value.shareMode === "solo"
                          ? value.soloParticipantId
                          : null,
                      note: value.note.trim() === "" ? null : value.note.trim(),
                    });
                    setEditingId(null);
                  }}
                  onDelete={() => {
                    onRemove(drop.dropId);
                    setConfirmingDeleteId(null);
                  }}
                />
              ))}
            </ul>
          )}
        </section>

        {unsoldCount > 0 ? (
          <WarningNote>
            아직 팔지 않은 드랍 {unsoldCount}건은 주간 합계에 들어가지 않습니다.
            0 으로 더하지 않고 건수로만 셉니다 — 팔린 뒤 금액을 채우면 그때
            수익에 반영됩니다.
          </WarningNote>
        ) : null}

        <section className="flex flex-col gap-2 border-t border-border pt-4">
          <div className="flex items-center gap-2">
            <Plus aria-hidden size={16} className="text-primary" />
            <h3 className="font-headline text-body-lg font-semibold text-ink">
              드랍 추가
            </h3>
          </div>

          <DropForm
            idPrefix="drop-add"
            value={addForm}
            participants={run.dropParticipants}
            lockedShareMode={false}
            disabled={pendingKey === "new"}
            submitLabel={pendingKey === "new" ? "기록하는 중…" : "기록합니다"}
            onChange={setAddForm}
            onSubmit={() => {
              if (addError !== null) return;
              onAdd({
                itemName: addForm.itemName.trim(),
                saleAmountMeso: parseSaleAmount(addForm),
                shareMode: addForm.shareMode,
                soloParticipantId:
                  addForm.shareMode === "solo"
                    ? addForm.soloParticipantId
                    : null,
                note:
                  addForm.note.trim() === "" ? null : addForm.note.trim(),
              });
              setAddForm(EMPTY_FORM);
            }}
          />
        </section>
      </div>
    </Dialog>
  );
}
