"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { cn } from "@/lib/utils";
import { Button } from "./button";

/**
 * 모달 다이얼로그.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 네이티브 `<dialog>` 인가 (직접 구현하지 않은 이유)
 * ─────────────────────────────────────────────────────────────────────────────
 * 새 의존성을 넣을 수 없고, 포커스 트랩을 손으로 짜면 **거의 항상 미묘하게 틀린다**
 * (Shift+Tab 역방향, 동적으로 추가된 요소, `inert` 처리, iframe…).
 * `showModal()` 은 그 전부를 브라우저가 보장한다:
 *
 * | 요건                    | 네이티브 `<dialog>` |
 * |-------------------------|---------------------|
 * | 포커스 트랩             | ✅ 브라우저 강제 (top layer + 나머지 inert) |
 * | `Esc` 닫기              | ✅ `cancel` 이벤트  |
 * | 열 때 첫 요소 포커스    | ✅ 첫 포커스 가능 요소(여기서는 닫기 버튼) |
 * | 닫을 때 원래 요소 복귀  | ✅ 브라우저가 되돌린다 |
 * | 배경 요소 접근 차단     | ✅ top layer 라서 z-index 경쟁 자체가 없다 |
 * | 배경 클릭 닫기          | ❌ 직접 처리 (아래 `onMouseDown`) |
 * | 배경 스크롤 잠금        | ❌ 직접 처리 (아래 effect) |
 *
 * 브라우저가 못 해 주는 두 가지만 우리가 채운다.
 *
 * 배경 클릭은 `click` 이 아니라 **`mousedown` 기준**이다. 패널 안에서 드래그를 시작해
 * 바깥에서 손을 뗐을 때 창이 닫히면 사용자는 자기가 뭘 잘못했는지 알 수 없다.
 *
 * 모바일에서는 하단에서 올라오는 시트, 데스크톱에서는 가운데 카드로 뜬다.
 */

export interface DialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** 접근성 이름. `aria-labelledby` 로 연결된다. */
  readonly title: string;
  readonly description?: ReactNode;
  /** 헤더 우측(닫기 버튼 왼쪽) 보조 영역. */
  readonly headerAside?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Dialog({
  open,
  onClose,
  title,
  description,
  headerAside,
  footer,
  children,
  className,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  // React 상태 → DOM 명령. effect 의 정석적인 용도(외부 시스템 동기화)다.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  // 배경 스크롤 잠금 — `<dialog>` 가 해 주지 않는 부분.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      /*
       * `showModal()` 로 연 `<dialog>` 는 role=dialog 와 모달 의미론을 **암묵적으로**
       * 갖는다. 그래도 명시하는 이유는 (1) 검사 도구와 사람이 마크업만 보고 의도를
       * 확인할 수 있고, (2) 우리는 `show()`(비모달)를 절대 쓰지 않으므로
       * `aria-modal="true"` 가 언제나 사실이기 때문이다.
       */
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        // Esc. 기본 동작을 막고 React 상태를 통해 닫아 열림 상태가 어긋나지 않게 한다.
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      className={cn(
        // UA 기본 스타일(fit-content + margin auto + max-height)을 전부 걷어낸다.
        "m-0 h-dvh max-h-dvh w-screen max-w-none border-0 bg-transparent p-0 text-ink",
        // ⚠️ `bg-ink/50` 을 쓰면 다크에서 ink 가 밝은 색이라 **하얀 막**이 된다.
        //    막은 테마와 무관하게 어두워야 하므로 전용 토큰을 쓴다.
        "backdrop:bg-scrim",
      )}
    >
      <div
        ref={overlayRef}
        onMouseDown={(event) => {
          if (event.target === overlayRef.current) onClose();
        }}
        className="flex h-full w-full items-end justify-center sm:items-center sm:p-4"
      >
        <div
          className={cn(
            "flex max-h-[92dvh] w-full flex-col overflow-hidden bg-surface shadow-overlay",
            "rounded-t-lg sm:max-w-5xl sm:rounded-lg",
            /*
              ⚠️ 등장 애니메이션은 **넣지 않는다** (발주 지시 2026-08-20: 한 번 넣었다가
                 *"그냥 애니메이션 넣지말고"* 로 철회). 레이아웃은 원래부터 폰에서
                 바닥에 붙는 시트였고(`items-end` · `rounded-t-lg`), 그 자체로 충분하다.
                 되살릴 일이 생기면 커밋 이력에 keyframes 3종이 그대로 있다.
            */
            className,
          )}
        >
          <header className="flex shrink-0 items-start gap-3 border-b border-border p-pad-lg">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <h2
                id={titleId}
                className="font-headline text-body-lg font-semibold text-ink"
              >
                {title}
              </h2>
              {/* 설명은 문장이므로 14px 하한을 지킨다(12px 뮤티드 문장은 다크에서 묻힌다). */}
              {description ? (
                <p id={descriptionId} className="text-body-sm text-ink-muted">
                  {description}
                </p>
              ) : null}
            </div>
            {headerAside}
            <Button
              variant="ghost"
              size="sm"
              onClick={onClose}
              aria-label="닫기"
              className="shrink-0"
            >
              <X aria-hidden size={16} />
            </Button>
          </header>

          <div className="min-h-0 flex-1 overflow-y-auto p-pad-lg">
            {children}
          </div>

          {footer ? (
            <footer className="shrink-0 border-t border-border p-pad-lg">
              {footer}
            </footer>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}
