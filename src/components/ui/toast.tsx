"use client";

import { CircleAlert, CircleCheck, X } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { cn } from "@/lib/utils";

import {
  ToastContext,
  type ToastApi,
  type ToastInput,
  type ToastTone,
} from "./toast-context";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 알림 한 줄 — **낙관적 업데이트가 되돌아갔을 때 그 사실을 말하는 자리**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 이 컴포넌트가 존재하는 이유는 하나다. 낙관적 업데이트(`@/lib/query/optimistic`)는
 * 서버 응답을 기다리지 않고 화면을 먼저 바꾼다. 실패하면 값을 스냅샷으로 되돌리는데,
 * **되돌리기만 하고 아무 말도 하지 않으면 사용자는 저장된 줄 안다.** 화면은 잠깐
 * 바뀌었다가 원래대로 돌아왔을 뿐이고, 그 깜빡임은 "안 눌렸나?" 로 읽힌다.
 * 즉 조용한 롤백은 **데이터가 사라지는 버그와 구별되지 않는다.**
 *
 * 왜 화면 안의 `ErrorState` 로는 부족한가:
 * - 조작한 자리가 **모달이었다가 닫혔을 수 있다**(추적 캐릭터 저장은 성공을 낙관해
 *   창을 먼저 닫는다). 닫힌 창 뒤에 문구를 그리면 아무도 못 본다.
 * - 조작한 자리가 **목록의 한 줄**이라 문구를 넣을 자리가 없다(보스 계획 · 클리어 체크).
 * - 실패는 드물다. 드문 것을 위해 모든 줄에 자리를 비워 두는 것은 화면 낭비다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 색과 크기 (§4)
 * ─────────────────────────────────────────────────────────────────────────────
 * - **red 를 쓴다.** §4 는 red 를 실패·취소 전용으로 못박았고, 롤백은 정확히 실패다.
 *   임박·경고(주황)와 혼동되면 안 된다 — 이것은 "곧 마감"이 아니라 "저장 안 됐다"이다.
 *   주황과 같은 규칙을 지킨다: **배경·테두리·아이콘이 색을 지고 문장은 잉크**다.
 * - 제목과 본문은 전부 `text-body-sm`(14px) 이상이다. 문장은 14px 밑으로 내려가지
 *   않는다(§4). 12px 로 남는 것은 없다 — 이 카드에는 배지도 수치 주석도 없다.
 * - 전환은 `duration-150` — 체감 지연이 있는 전환의 200ms 상한 안이다(§4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 낭독기
 * ─────────────────────────────────────────────────────────────────────────────
 * 영역 자체가 `aria-live="assertive"` 다. 롤백은 "방금 한 일이 저장되지 않았다"는
 * 사실이라 다음 문단을 기다렸다 읽어 줄 성질이 아니다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 자동 사라짐
 * ─────────────────────────────────────────────────────────────────────────────
 * 8초. 짧으면 못 읽고, 영구히 남기면 화면을 가린다. 닫기 버튼이 항상 있으므로
 * 급한 사람은 바로 치울 수 있다.
 */

const AUTO_DISMISS_MS = 8000;

export interface ToastMessage {
  readonly id: number;
  /** 한 줄 제목. 무엇이 실패했는가. */
  readonly title: string;
  /** **무엇이 되돌아갔는지.** 이 문장이 비면 이 컴포넌트를 쓸 이유가 없다. */
  readonly description: string;
  /** 서버가 준 사유. 있으면 등폭으로 덧붙인다. */
  readonly detail: string | null;
  readonly tone: ToastTone;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [messages, setMessages] = useState<readonly ToastMessage[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setMessages((current) => current.filter((message) => message.id !== id));
  }, []);

  const notify = useCallback((input: ToastInput) => {
    const id = nextId.current;
    nextId.current += 1;
    setMessages((current) => [
      // 최근 것이 위. 세 개를 넘기면 오래된 것부터 버린다 — 화면을 덮지 않는다.
      {
        id,
        title: input.title,
        description: input.description,
        detail: input.detail ?? null,
        tone: input.tone ?? "error",
      },
      ...current.slice(0, 2),
    ]);
  }, []);

  const api = useMemo<ToastApi>(() => ({ notify }), [notify]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        // 화면 위에 떠 있지만 포인터를 막지 않는다 — 카드만 다시 켠다.
        className={cn(
          "pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-3",
          "sm:inset-x-auto sm:right-0 sm:items-end",
        )}
        role="region"
        /*
          `assertive` 를 유지한다. 실패는 다음 문단을 기다렸다 읽어 줄 성질이 아니고,
          성공도 **사용자가 방금 누른 것의 결과**라 즉시 읽히는 편이 맞다.
        */
        aria-live="assertive"
        aria-label="저장 결과 알림"
      >
        {messages.map((message) => (
          <ToastCard
            key={message.id}
            message={message}
            onDismiss={() => dismiss(message.id)}
          />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({
  message,
  onDismiss,
}: {
  readonly message: ToastMessage;
  readonly onDismiss: () => void;
}) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  const isSuccess = message.tone === "success";
  const Icon = isSuccess ? CircleCheck : CircleAlert;

  return (
    <div
      className={cn(
        "pointer-events-auto flex w-full max-w-96 items-start gap-2 rounded-lg border",
        // §4: 실패는 red, 성공은 green. 색은 테두리·배경·아이콘이 지고 문장은 잉크가 진다.
        isSuccess
          ? "border-chip-done-border bg-chip-done-bg"
          : "border-chip-failed-border bg-chip-failed-bg",
        "px-3 py-2.5 shadow-overlay",
        "transition duration-150",
      )}
    >
      <Icon
        aria-hidden
        size={18}
        className={cn("mt-0.5 shrink-0", isSuccess ? "text-success" : "text-error")}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-body-sm font-semibold text-ink">{message.title}</p>
        {/* **무엇이 되돌아갔는지.** 이 줄이 이 컴포넌트의 존재 이유다. */}
        <p className="text-body-sm text-ink-label">{message.description}</p>
        {message.detail === null ? null : (
          <p
            className={cn(
              "font-mono text-caption break-all",
              isSuccess ? "text-chip-done-fg" : "text-chip-failed-fg",
            )}
          >
            {message.detail}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="알림 닫기"
        className={cn(
          "-m-1 shrink-0 rounded-md p-1 text-ink-muted",
          "transition duration-150 hover:bg-hover-strong hover:text-ink",
          "outline-none focus-visible:ring-[3px] focus-visible:ring-focus-ring",
        )}
      >
        <X aria-hidden size={16} />
      </button>
    </div>
  );
}
