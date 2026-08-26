"use client";

import {
  KeyRound,
  Loader2,
  Plus,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useId, useState } from "react";

import {
  Button,
  Card,
  CardDescription,
  CardTitle,
  EmptyState,
  ErrorState,
  HelperText,
  Input,
  Label,
  Skeleton,
  SkeletonGroup,
  StatusChip,
} from "@/components/ui";

import { ApiRequestError } from "../data/auth-api";
import {
  useAddCredentialMutation,
  useCredentialsQuery,
  useDeleteCredentialMutation,
} from "../data/auth-queries";
import { isApiKeyInputUsable, normalizeApiKeyInput } from "../lib/api-key";
import {
  useCredentialKeyMasks,
  useStoredCredentialIds,
} from "../lib/use-stored-api-key";
import type { CredentialSummary } from "../types";

import { NexonKeyIssueLink } from "./nexon-key-issue-link";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 등록된 넥슨 API 키 관리 (CLAUDE.md §2.1)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * §2.1 은 **한 사람이 넥슨 계정을 여러 개 갖는다**고 규정한다. 키 하나는 그 키를 발급한
 * 계정의 캐릭터만 읽으므로, 부계정 캐릭터를 함께 보려면 그 계정의 키를 **추가로** 등록하는
 * 수밖에 없다. 서버(`POST /api/auth/credentials`)는 이미 동작했는데 화면에 진입점이
 * 없어서 기능이 존재하지 않는 것과 같았다. 이 컴포넌트가 그 구멍을 메운다.
 *
 * ── 마스킹된 키는 어디서 오는가 ──────────────────────────────────────────────
 * **서버가 아니다.** 서버는 원문을 AEAD 로 암호화해 보관하지만(§2.1.2) 그것을 응답에
 * 실어 보내지 않는다 — 마스킹조차 보내지 않는다. 보내는 순간 XSS 하나가 "어느 키인지"를
 * 훔쳐 갈 표면이 되고, 화면에는 아무 이득이 없기 때문이다. 화면에 보이는
 * `test_5••••••••fb0d` 는 **그 키를 실제로 입력한 브라우저**가 localStorage 에 남긴
 * 원문에서 파생한다(`lib/api-key.ts`).
 *
 * ── ★ 상태는 셋이고, 경고는 **하나뿐**이다 (§2.1.2) ──────────────────────────
 *   (a) 서버에 보관됨 → 어느 기기에서든 동기화된다. **경고가 아니다.**
 *   (b) 서버에는 없고 이 브라우저에만 있음 → 지금은 되고, 다음 호출이 성공하면 서버가
 *       그 키를 보관한다(백필). 다른 기기에서는 아직 안 된다고 분명히 말한다.
 *   (c) 어디에도 없음 → 그 계정 캐릭터의 동기화가 **전부 멈춰 있다.**
 *       §4 의 tertiary orange 로 드러내고 **바로 입력할 수 있게** 한다.
 *
 * 예전에는 (a) 와 (c) 를 구분하지 못해, 다른 기기에서 등록한 키가 멀쩡히 동작하는데도
 * 주황 경고가 떴다. 판정의 근거는 이제 `credential.hasServerKey` 다.
 *
 * ── 409 는 뭉개지 않는다 ─────────────────────────────────────────────────────
 * 이미 다른 사람에게 묶인 키를 조용히 옮기면 계정 탈취다. 서버가 409
 * `key_owned_by_other_account` 로 거부하며, 화면은 그 종류를 **다른 실패와 구분해**
 * 원인이 보이는 문구로 안내한다. "요청을 처리하지 못했습니다" 로 접으면 사용자는 자기
 * 키가 왜 거부됐는지 영원히 알 수 없다.
 *
 * ── 주 키(primary)와 로그인 자격은 무관하다 ─────────────────────────────────
 * `isPrimary` 는 "본캐가 속한 계정의 키"라는 뜻일 뿐이고, 어느 키로 로그인해도 같은
 * 사람으로 들어온다(§2.1). 그래서 배지는 "주 키"라고만 쓰고 "로그인용" 같은 말을 쓰지 않는다.
 */

function formatValidatedAt(value: string | null): string {
  if (value === null) return "확인 이력 없음";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "확인 이력 없음";
  // 표시는 언제나 KST 고정(§2). Intl 이 타임존을 직접 받으므로 별도 변환이 없다.
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** 키 이름이 비어 있어도 문장이 어색해지지 않게 한 곳에서만 만든다. */
function credentialName(credential: CredentialSummary): string {
  return credential.label ?? "이름 없는 키";
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 삭제 확인 — **결과를 숫자로 보여 준 다음에** 묻는다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * "정말 삭제하시겠습니까?" 만 띄우는 확인은 확인이 아니다. 사용자가 판단할 근거가 없으니
 * 누르는 것 말고 할 수 있는 게 없고, 되돌릴 수 없는 동작에서는 그게 곧 사고다. 그래서
 * 여기서는 **무엇이 얼마나 멈추는지**를 수로 먼저 말한다
 * (`strandedAccountCount` / `strandedCharacterCount` — 계산은 서버가 한다).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 무엇이 남는지도 **같이** 말한다
 * ─────────────────────────────────────────────────────────────────────────────
 * 캐릭터 행은 키가 아니라 **넥슨 계정**을 가리키므로(마이그레이션 12-4) 키를 지워도
 * 캐릭터·클리어·수익 기록은 하나도 사라지지 않는다. 그래서 같은 키를 다시 등록하면
 * 원래대로 돌아온다. 이 사실을 말하지 않으면 사용자는 "수익 이력이 날아갈까 봐" 정리하지
 * 못한 키를 계속 안고 간다 — 겁을 주는 확인창은 안전한 것이 아니라 그냥 나쁜 것이다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 왜 별도 모달이 아니라 **행 안에 펼쳐지는 패널**인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 화면은 이미 네이티브 `<dialog>` 안에서 열린다(`CredentialDialogButton`). 그 위에
 * `<dialog>` 를 또 올리면 Esc 와 포커스 복귀가 사용자 의도와 어긋난다 — 그 이유로 캐릭터
 * 선택 모달도 중첩하지 않기로 이미 정해져 있다. 인라인 패널은 **어느 키를 지우는 중인지**
 * 가 대상 바로 아래에 붙어 있다는 이점도 있다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 파괴적 동작의 색 (§4 — 빨강은 실패·취소 전용)
 * ─────────────────────────────────────────────────────────────────────────────
 * 두 단으로 나눴다.
 * - **진입 버튼은 빨강이 아니다.** `ghost` 로 두어 행에서 가장 약한 요소로 만든다.
 *   목록을 훑는 동안 빨간 버튼이 키 개수만큼 늘어서 있으면, 실제 위험(마지막 키를
 *   지우는 것)과 일상 동작의 구분이 사라지고 빨강은 그냥 배경이 된다.
 * - **최종 확인 버튼만 `destructive`(빨강)** 다. §4 의 "빨강 = 실패와 **취소**"에서
 *   취소 쪽에 해당한다 — 등록을 되돌리는 동작이고, 이 시점에는 사용자가 결과를 이미
 *   숫자로 봤다. 임박·주의는 주황이지만 여기는 임박이 아니라 **되돌릴 수 없음**이다.
 * - 안내 상자는 §4 규칙대로 **주황이 배경과 아이콘을 지고 문장은 잉크**가 진다.
 */
function DeleteConfirmPanel({
  credential,
  hasStoredKey,
  isPending,
  errorMessage,
  onCancel,
  onConfirm,
}: {
  readonly credential: CredentialSummary;
  readonly hasStoredKey: boolean;
  readonly isPending: boolean;
  readonly errorMessage: string | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const stops = credential.strandedCharacterCount > 0;

  return (
    <div className="flex flex-col gap-3 rounded-md border border-chip-soon-border bg-chip-soon-bg p-pad-md">
      <div className="flex items-start gap-2">
        <TriangleAlert
          aria-hidden
          size={16}
          className="mt-0.5 shrink-0 text-tertiary"
        />
        <p className="min-w-0 flex-1 text-body-sm font-semibold text-ink">
          {credentialName(credential)} 키를 삭제합니다
        </p>
      </div>

      {/*
        ★ 숫자가 확인의 본체다. 등폭(`tabular-nums`)으로 두는 이유는 이 문단이 키마다
          다시 그려지는데 자릿수가 흔들리면 훑기 어렵기 때문이다.
      */}
      <ul className="flex flex-col gap-1 text-body-sm text-ink">
        <li className="tabular-nums">
          {stops ? (
            <>
              넥슨 계정{" "}
              <strong className="font-semibold">
                {credential.strandedAccountCount}개
              </strong>
              의 캐릭터{" "}
              <strong className="font-semibold">
                {credential.strandedCharacterCount}명
              </strong>
              이 <strong className="font-semibold">동기화 불가</strong>가 됩니다.
            </>
          ) : (
            <>
              동기화가 멈추는 캐릭터는 <strong className="font-semibold">없습니다</strong>
              . 같은 넥슨 계정에 다른 키가 남아 있습니다.
            </>
          )}
        </li>
        <li>
          캐릭터·클리어·수익 기록은 <strong className="font-semibold">지워지지 않습니다.</strong>{" "}
          같은 키를 다시 등록하면 그대로 되돌아옵니다.
        </li>
        <li>
          서버에 암호화 보관된 키
          {hasStoredKey ? "와 이 브라우저에 저장된 키" : ""}가 함께 지워집니다.
        </li>
        {credential.isPrimary ? (
          <li>
            주 키였으므로 남은 키 중 하나가 주 키가 됩니다.{" "}
            <strong className="font-semibold">로그인에는 영향이 없습니다</strong> — 어느
            연결 키로도 같은 계정으로 들어옵니다.
          </li>
        ) : null}
      </ul>

      {errorMessage !== null ? (
        <HelperText tone="error" role="alert">
          {errorMessage}
        </HelperText>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="destructive"
          size="sm"
          onClick={onConfirm}
          disabled={isPending}
        >
          {isPending ? (
            <>
              <Loader2 aria-hidden size={14} className="animate-spin" />
              삭제하는 중…
            </>
          ) : (
            <>
              <Trash2 aria-hidden size={14} />
              삭제
            </>
          )}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          disabled={isPending}
        >
          취소
        </Button>
      </div>
    </div>
  );
}

interface CredentialRowProps {
  readonly credential: CredentialSummary;
  readonly maskedKey: string | null;
  /** 이 브라우저가 **원문**을 들고 있는가. 마스킹 유무와 다르다(예전 형식 잔재). */
  readonly hasStoredKey: boolean;
  /** "이 키 입력하기" — 키 추가 폼을 그 이름으로 열어 준다. */
  readonly onEnterKey: (credential: CredentialSummary) => void;
  /**
   * 등록된 키가 이것 하나뿐인가 = **삭제 불가 사유**.
   *
   * 서버가 같은 판정을 다시 하며(`ApiError.lastCredential()`), 그쪽이 경계다.
   * 여기서 막는 것은 "눌러 봤자 거절당하는 버튼"을 없애기 위해서다. 다만 **비활성화만
   * 하고 이유를 안 쓰면** 사용자는 버튼이 왜 죽었는지 영원히 모르므로 문장을 함께 둔다.
   */
  readonly isOnlyCredential: boolean;
  readonly isConfirmingDelete: boolean;
  readonly isDeleting: boolean;
  readonly deleteErrorMessage: string | null;
  readonly onRequestDelete: (credential: CredentialSummary) => void;
  readonly onCancelDelete: () => void;
  readonly onConfirmDelete: (credential: CredentialSummary) => void;
}

function CredentialRow({
  credential,
  maskedKey,
  hasStoredKey,
  onEnterKey,
  isOnlyCredential,
  isConfirmingDelete,
  isDeleting,
  deleteErrorMessage,
  onRequestDelete,
  onCancelDelete,
  onConfirmDelete,
}: CredentialRowProps) {
  return (
    <li className="flex flex-col gap-2 rounded-md border border-border bg-surface p-pad-md">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-headline text-body font-semibold text-ink">
          {credentialName(credential)}
        </span>
        {credential.isPrimary ? (
          <StatusChip status="done" title="본캐가 속한 계정의 키입니다.">
            주 키
          </StatusChip>
        ) : null}
        {credential.isInvalidated ? (
          // 실패(빨강)가 맞다 — 이 키로는 더 이상 넥슨을 부를 수 없다(§4).
          <StatusChip status="failed">사용 불가</StatusChip>
        ) : null}
      </div>

      {/* (a) 서버 보관 — 경고가 아니라 **사실**이다. 어느 기기에서든 동기화된다. */}
      {credential.hasServerKey ? (
        <p className="flex items-center gap-2 text-body-sm text-ink-muted">
          <ShieldCheck aria-hidden size={14} className="shrink-0" />
          서버에 암호화 보관됨 · 어느 기기에서든 자동으로 불러옵니다
          {hasStoredKey && maskedKey !== null ? (
            <span className="font-mono">{maskedKey}</span>
          ) : null}
        </p>
      ) : hasStoredKey ? (
        /*
          (b) 이 브라우저에만 있다. 지금은 되지만 다른 기기에서는 안 된다 — 그 사실을
          숨기지 않는다. 다음 동기화가 성공하면 서버가 이 키를 보관하므로(백필) 이
          상태는 오래 남지 않는다.
        */
        <p className="flex flex-wrap items-center gap-2 text-body-sm text-ink-muted">
          <KeyRound aria-hidden size={14} className="shrink-0" />
          <span className="font-mono">{maskedKey}</span>
          <span>이 브라우저에만 있습니다. 다음 동기화 때 서버에 보관됩니다.</span>
        </p>
      ) : (
        /*
          (c) 어디에도 없다.
          §4: 주황이 **배경과 아이콘**을 지고 문장은 잉크가 진다(주황 본문은 라이트에서
          AA 미달). red 가 아닌 이유는 실패가 아니라 **아직 하지 않은 일**이기 때문이다.
        */
        <div className="flex flex-wrap items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2">
          <KeyRound
            aria-hidden
            size={16}
            className="mt-0.5 shrink-0 text-tertiary"
          />
          <p className="min-w-0 flex-1 text-body-sm text-ink">
            이 키가 아직 등록되지 않아 <strong className="font-semibold">
              캐릭터 {credential.characterCount}명
            </strong>
            의 인게임 스케줄러를 불러올 수 없습니다. 같은 키를 한 번 입력하면 서버에
            암호화되어 보관되고, 이후에는 어느 기기에서든 자동으로 불러옵니다.
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onEnterKey(credential)}
          >
            이 키 입력
          </Button>
        </div>
      )}

      <p className="text-body-sm text-ink-muted tabular-nums">
        넥슨 계정 {credential.nexonAccountCount}개 · 캐릭터{" "}
        {credential.characterCount}명 · 마지막 확인{" "}
        {formatValidatedAt(credential.lastValidatedAt)}
      </p>

      {/* ── 삭제 ─────────────────────────────────────────────────────────── */}
      {isConfirmingDelete ? (
        <DeleteConfirmPanel
          credential={credential}
          hasStoredKey={hasStoredKey}
          isPending={isDeleting}
          errorMessage={deleteErrorMessage}
          onCancel={onCancelDelete}
          onConfirm={() => onConfirmDelete(credential)}
        />
      ) : (
        /*
          360px 에서도 가로 스크롤이 생기지 않도록 **줄바꿈**을 허용하고, 설명 문장은
          `min-w-0` 으로 줄여 준다. 버튼은 `shrink-0` 이라 글자가 잘리지 않는다.
        */
        <div className="flex flex-wrap items-center justify-end gap-2">
          {isOnlyCredential ? (
            /*
              ★ 비활성화만 하고 끝내지 않는다. 이 문장이 없으면 사용자는 버튼이 왜
                죽었는지 알 수 없고, 그건 "안 되는 이유를 화면이 말한다"는 요구의 정반대다.
                주황(경고)도 빨강(실패)도 아니다 — 아직 아무 일도 일어나지 않았고,
                키를 하나 더 등록하면 그대로 풀리는 **상태 설명**이기 때문이다.
            */
            <p className="min-w-0 flex-1 text-body-sm text-ink-muted">
              마지막 남은 키라 삭제할 수 없습니다. 이 키를 지우면 이 계정으로 다시
              로그인할 방법이 사라집니다.
            </p>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="shrink-0"
            disabled={isOnlyCredential || isDeleting}
            onClick={() => onRequestDelete(credential)}
          >
            <Trash2 aria-hidden size={14} />키 삭제
          </Button>
        </div>
      )}
    </li>
  );
}

export interface CredentialManagerProps {
  readonly className?: string;
}

export function CredentialManager({ className }: CredentialManagerProps) {
  const keyInputId = useId();
  const labelInputId = useId();
  const helperId = `${keyInputId}-helper`;

  const credentials = useCredentialsQuery();
  const masks = useCredentialKeyMasks();
  /** 원문을 실제로 들고 있는 자격증명. **판정은 마스킹이 아니라 이것이 한다.** */
  const storedCredentialIds = useStoredCredentialIds();
  const addCredential = useAddCredentialMutation();
  const deleteCredential = useDeleteCredentialMutation();

  const [formOpen, setFormOpen] = useState(false);
  const [typedKey, setTypedKey] = useState("");
  const [typedLabel, setTypedLabel] = useState("");
  /** 지금 삭제 확인 중인 키. `null` 이면 확인 단계가 열려 있지 않다. */
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(
    null,
  );
  /**
   * 삭제 직후 안내.
   *
   * 지운 행은 목록에서 사라지므로 아무 말도 없으면 "눌렀는데 뭐가 됐지?"가 된다.
   * 특히 **주 키가 어디로 옮겨 갔는지**와 **다시 등록하면 되돌아온다**는 사실은
   * 사라진 행 자리에서는 알 수 없으므로 여기서 한 번 말해 준다.
   */
  /**
   * 방금 한 일의 결과 한 줄. **추가·재확인·삭제가 같은 자리를 쓴다** — 세 동작이 모두
   * "목록이 바뀌었다(또는 안 바뀌었다)"를 말해야 하고, 자리를 나누면 사용자가 매번
   * 다른 곳을 봐야 한다. 다음 동작이 이전 문장을 덮는다.
   */
  const [resultNotice, setResultNotice] = useState<string | null>(null);

  const conflict =
    addCredential.error instanceof ApiRequestError &&
    addCredential.error.kind === "key_owned_by_other_account";

  const errorMessage =
    addCredential.error === null
      ? null
      : addCredential.error instanceof ApiRequestError
        ? addCredential.error.message
        : "키를 추가하지 못했습니다. 잠시 후 다시 시도해 주세요.";

  const canSubmit = isApiKeyInputUsable(typedKey) && !addCredential.isPending;

  /**
   * 삭제 실패 문구.
   *
   * `last_credential`(마지막 키)은 서버가 이미 사람이 읽을 수 있는 문장으로 답하므로
   * 그대로 쓴다 — 화면이 다시 쓰면 두 문구가 갈라진다. 분류되지 않은 실패만 접는다.
   */
  const deleteErrorMessage =
    deleteCredential.error === null
      ? null
      : deleteCredential.error instanceof ApiRequestError
        ? deleteCredential.error.message
        : "키를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.";

  function closeForm(): void {
    setFormOpen(false);
    setTypedKey("");
    setTypedLabel("");
    addCredential.reset();
  }

  /** 확인 단계를 연다. 두 키를 동시에 확인 중인 상태는 만들지 않는다(하나만 열린다). */
  function handleRequestDelete(credential: CredentialSummary): void {
    deleteCredential.reset();
    setResultNotice(null);
    setConfirmingDeleteId(credential.id);
  }

  function handleCancelDelete(): void {
    setConfirmingDeleteId(null);
    deleteCredential.reset();
  }

  /**
   * 실제 삭제. **여기서만 되돌릴 수 없는 일이 일어난다.**
   *
   * 실패하면 확인 패널을 **열어 둔 채** 문구만 보여 준다 — 닫아 버리면 사용자는 무엇이
   * 실패했는지 모르는 채로 목록만 다시 보게 된다.
   *
   * ★ **`router.refresh()` 는 제거했다** (§2.4 Rule 3). 예전 이유는 *"대시보드는 서버
   *   컴포넌트라 쿼리 캐시 밖"* 이었는데, 그 전제가 더 이상 사실이 아니다 — 대시보드는
   *   이제 `queryKeys.db.dashboard.*` 를 소유하고, 이 mutation 이 세션·키 목록·캐릭터·
   *   계획·대시보드를 **모두 무효화**한다(`useDeleteCredentialMutation`). 키를 지워도
   *   로그인 상태는 그대로라 **페이지 형태는 바뀌지 않으므로**, 여기서 서버 왕복을 한 번
   *   더 도는 것은 숫자 갱신용 refresh 일 뿐이다 — Rule 3 이 금지하는 바로 그 사용이다.
   */
  function handleConfirmDelete(credential: CredentialSummary): void {
    if (deleteCredential.isPending) return;

    deleteCredential.mutate(credential.id, {
      onSuccess: (data) => {
        setConfirmingDeleteId(null);

        const promoted =
          data.promotedCredentialId === null
            ? null
            : (data.user.credentials.find(
                (row) => row.id === data.promotedCredentialId,
              ) ?? null);

        setResultNotice(
          `${credentialName(credential)} 키를 삭제했습니다.` +
            (promoted === null
              ? ""
              : ` 주 키는 이제 ${credentialName(promoted)}입니다.`) +
            " 캐릭터와 기록은 그대로 남아 있으며, 같은 키를 다시 등록하면 동기화도 되돌아옵니다.",
        );
      },
    });
  }

  /**
   * "이 키 입력" — 이미 등록된 키를 **서버에 올리는** 경로 (§2.1.2).
   *
   * 새 엔드포인트를 만들지 않는다. `POST /api/auth/credentials` 는 해시로 자격증명을
   * 찾으므로 같은 키를 넣으면 **같은 `credentialId`** 가 돌아오고, 서버는 그 자리에서
   * 원문을 암호화해 `user_credentials.encrypted_api_key` 에 보관한다. 브라우저 쪽
   * localStorage 보관은 mutation 의 `onSuccess` 가 계속 하지만, 이제 그것은 **캐시**이지
   * 유일한 사본이 아니다. 넥슨 호출은 검증 1건이며, 그 1건으로 "이 키가 아직 유효한가"
   * 까지 함께 확인된다 — **유효를 확인한 뒤에만 저장한다**는 규칙이 여기서 지켜진다.
   */
  function handleEnterKey(credential: CredentialSummary): void {
    addCredential.reset();
    // 삭제 확인을 열어 둔 채 입력 폼까지 뜨면 "지금 무엇을 하는 중인가"가 흐려진다.
    handleCancelDelete();
    setTypedKey("");
    // 이름을 미리 채워 "지금 어느 키를 넣는 중인지"가 폼 안에서도 보이게 한다.
    setTypedLabel(credential.label ?? "");
    setFormOpen(true);
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (!canSubmit) return;

    const label = typedLabel.trim();
    addCredential.mutate(
      {
        apiKey: normalizeApiKeyInput(typedKey),
        ...(label === "" ? {} : { label }),
      },
      {
        onSuccess: (data) => {
          closeForm();
          /*
           * ★ **`router.refresh()` 는 제거했다** (§2.4 Rule 3). 새 계정의 캐릭터가
           *   합쳐지면 추적 요약·수익 카드가 따라와야 하는 것은 맞지만, 그 값들은 이제
           *   쿼리 캐시가 소유하고 `useAddCredentialMutation` 이 캐릭터·계획·대시보드를
           *   무효화한다. 로그인 상태는 그대로라 **페이지 형태는 바뀌지 않는다.**
           */

          /*
            ── 결과를 **사실대로** 말한다 (발주 지적 2026-08-26) ──────────────
            *"Api 하나를 추가했는데 추적캐릭터에 안뜬대"* — 그 사용자는 **이미 등록된
            키를 다시 넣었다.** `attach_nexon_credential` 은 같은 사용자의 같은 해시를
            만나면 새 행을 만들지 않고 기존 행을 UPDATE 하고 그 id 를 돌려준다. 그래서
            창은 조용히 닫히고 "됐다"처럼 보이는데 자격증명도 캐릭터도 하나도 늘지 않았다.
            (실측: `last_validated_at` 만 6일 뒤로 갱신되고 `created_at` 은 그대로.)

            ★ 오류로 만들지 않는다 — 같은 키를 다시 넣는 것은 **정당한 경로**다(§2.1.2:
              새 기기에서 원문 키를 서버에 다시 올린다). 틀린 것은 결과가 아니라
              결과를 말하는 방식이었다.
            ★ 새 키일 때도 **몇 명이 들어왔는지** 적는다. 0명이면 그것도 사실이고,
              그때 "추적 캐릭터에 안 뜬다"의 답이 이 줄에 이미 있다.
          */
          setResultNotice(
            data.alreadyRegistered
              ? "이미 등록된 키입니다. 새로 추가된 것은 없고, 이 브라우저에서 쓸 수 있도록 다시 확인만 했습니다."
              : `키를 추가했습니다. 캐릭터 ${String(data.characters.length)}명을 불러왔습니다. 추적할 캐릭터는 아래 캐릭터 선택에서 고르세요.`,
          );
        },
      },
    );
  }

  return (
    <Card className={className}>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <CardTitle className="text-body-lg">계정 · 키 관리</CardTitle>
            <CardDescription>
              넥슨 계정마다 키가 따로 발급됩니다. 부계정 키를 추가하면 그 계정의
              캐릭터가 이 계정에 합쳐집니다.
            </CardDescription>
          </div>
          {formOpen ? null : (
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              onClick={() => {
                addCredential.reset();
                handleCancelDelete();
                setFormOpen(true);
              }}
            >
              <Plus aria-hidden size={16} />키 추가
            </Button>
          )}
        </div>

        {/*
          ── 결과 안내 (추가 · 재확인 · 삭제) ────────────────────────────────
          성공은 §4 상 초록이 맞다(실패·취소의 빨강, 임박의 주황과 구분된다). 다만
          초록은 **배경과 아이콘만** 지고 문장은 잉크가 진다 — 틴트 위 컬러 본문은
          라이트에서 AA 를 넘기지 못한다.
          `role="status"` 라서 스크린리더는 목록이 다시 그려질 때 이 문장을 읽는다.
        */}
        {resultNotice !== null ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md border border-chip-done-border bg-chip-done-bg px-3 py-2"
          >
            <ShieldCheck
              aria-hidden
              size={16}
              className="mt-0.5 shrink-0 text-success"
            />
            <p className="min-w-0 flex-1 text-body-sm text-ink">
              {resultNotice}
            </p>
          </div>
        ) : null}

        {/* ── 목록: 로딩 · 에러 · 빈 상태 · 정상 네 가지가 전부 있다(DoD §0.3) ── */}
        {credentials.isPending ? (
          <SkeletonGroup label="등록된 키를 불러오는 중">
            <Skeleton className="h-6 w-40" />
            <Skeleton shape="text" className="w-64" />
          </SkeletonGroup>
        ) : credentials.isError ? (
          <ErrorState
            title="키 목록을 불러오지 못했습니다"
            description="잠시 후 다시 시도해 주세요."
            onRetry={() => void credentials.refetch()}
          />
        ) : credentials.data.length === 0 ? (
          // 실제로는 로그인한 사람에게 최소 1개가 있다. 그래도 빈 상태를 둔다 —
          // 키가 전부 회수된 계정이 이 화면에 도달할 수 있기 때문이다.
          <EmptyState
            icon={<KeyRound size={24} />}
            title="등록된 키가 없습니다"
            description="넥슨 오픈 API 키를 추가하면 그 계정의 캐릭터를 불러옵니다."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {credentials.data.map((credential) => (
              <CredentialRow
                key={credential.id}
                credential={credential}
                maskedKey={masks[credential.id] ?? null}
                hasStoredKey={storedCredentialIds.includes(credential.id)}
                onEnterKey={handleEnterKey}
                /*
                  ★ 마지막 남은 키 판정. 서버가 같은 판정을 다시 하며 그쪽이 경계다
                    (`ApiError.lastCredential()`). 여기서는 **이 목록 자체가 근거**라
                    별도 필드를 서버에서 받지 않는다 — 같은 사실을 두 번 실어 보내면
                    둘이 어긋나는 날이 온다.
                */
                isOnlyCredential={credentials.data.length <= 1}
                isConfirmingDelete={confirmingDeleteId === credential.id}
                isDeleting={
                  deleteCredential.isPending &&
                  confirmingDeleteId === credential.id
                }
                deleteErrorMessage={
                  confirmingDeleteId === credential.id
                    ? deleteErrorMessage
                    : null
                }
                onRequestDelete={handleRequestDelete}
                onCancelDelete={handleCancelDelete}
                onConfirmDelete={handleConfirmDelete}
              />
            ))}
          </ul>
        )}

        {/* ── 키 추가 폼 ─────────────────────────────────────────────────── */}
        {formOpen ? (
          <form
            onSubmit={handleSubmit}
            className="flex flex-col gap-3 rounded-md border border-border bg-background p-pad-md"
          >
            <div className="flex items-center justify-between gap-2">
              <p className="font-headline text-body font-semibold text-ink">
                키 추가
              </p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={closeForm}
                aria-label="키 추가 취소"
                disabled={addCredential.isPending}
              >
                <X aria-hidden size={16} />
              </Button>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor={labelInputId}>이름 (선택)</Label>
              <Input
                id={labelInputId}
                value={typedLabel}
                maxLength={40}
                placeholder="예: 부계정"
                autoComplete="off"
                disabled={addCredential.isPending}
                onChange={(event) => setTypedLabel(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor={keyInputId} required>
                API 키
              </Label>
              <Input
                id={keyInputId}
                // 로그인 폼과 같은 취급 — 화면공유·어깨너머 노출을 막는다.
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="추가할 넥슨 계정의 API 키"
                value={typedKey}
                invalid={errorMessage !== null}
                aria-describedby={helperId}
                disabled={addCredential.isPending}
                onChange={(event) => setTypedKey(event.target.value)}
                className="font-mono"
              />
              <HelperText id={helperId}>
                키는 넥슨에 확인한 뒤 서버에 암호화(AES-256-GCM)되어 보관됩니다. 한 번
                입력하면 다른 기기에서도 다시 넣을 필요가 없습니다.
              </HelperText>
              {/*
                로그인 폼과 **같은 링크**를 여기에도 둔다(§0.2 — 한 곳을 고칠 때 같은 것이
                필요한 자리를 함께 본다). 부계정 키는 그 계정으로 넥슨 포털에 로그인해
                따로 발급받아야 하므로(§2.1), 여기가 그 이동이 필요한 두 번째 자리다.
              */}
              <NexonKeyIssueLink className="self-start" />
            </div>

            {errorMessage !== null ? (
              conflict ? (
                /*
                  409 는 **원인이 보이는 문구**로 따로 그린다. 일반 오류와 같은 모양으로
                  뭉개면 사용자는 "왜 내 키가 거부됐는지"를 알 수 없다.
                */
                <div
                  role="alert"
                  className="flex items-start gap-2 rounded-md border border-chip-failed-border bg-chip-failed-bg px-3 py-2"
                >
                  <ShieldAlert
                    aria-hidden
                    size={16}
                    className="mt-0.5 shrink-0 text-error"
                  />
                  <div className="flex flex-col gap-1">
                    <p className="text-body-sm font-semibold text-ink">
                      이 키는 다른 계정에 등록되어 있습니다
                    </p>
                    {/*
                      틴트 배경 위에서는 `ink-muted` 가 라이트 4.42:1 로 AA 를 아슬하게
                      놓친다(다크는 8.22:1 이라 다크만 보면 지나친다). 한 단계 진한
                      `ink-label` 은 라이트 9.55 / 다크 10.93 이다.
                    */}
                    <p className="text-body-sm text-ink-label">
                      한 키는 한 사람에게만 묶입니다. 소유자를 조용히 바꾸면 계정
                      탈취가 되므로 옮겨 붙이지 않습니다. 그 키로 로그인하면 그쪽
                      계정으로 들어갑니다.
                    </p>
                  </div>
                </div>
              ) : (
                <HelperText tone="error" role="alert">
                  {errorMessage}
                </HelperText>
              )
            ) : null}

            <div className="flex items-center gap-2">
              <Button type="submit" size="sm" disabled={!canSubmit}>
                {addCredential.isPending ? (
                  <>
                    <Loader2 aria-hidden size={14} className="animate-spin" />
                    확인하는 중…
                  </>
                ) : (
                  "추가"
                )}
              </Button>
              <span className="text-body-sm text-ink-muted">
                넥슨 호출 1건을 사용합니다.
              </span>
            </div>
          </form>
        ) : null}
      </div>
    </Card>
  );
}
