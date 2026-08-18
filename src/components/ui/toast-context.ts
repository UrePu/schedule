"use client";

import { createContext, useContext } from "react";

/**
 * 알림의 **계약만** 담는 모듈. 그리는 쪽(`toast.tsx`)과 부르는 쪽
 * (`@/lib/query/optimistic`)이 이 파일 하나를 공유한다.
 *
 * 왜 컴포넌트에서 갈라 놨는가:
 * - `lib/` 가 `components/` 의 **JSX 모듈**을 끌어오면 의존 방향이 거꾸로 선다.
 *   계약(컨텍스트 + 훅)만 있는 이 파일은 UI 가 아니라 배선이라 방향이 맞다.
 * - 그리고 이 파일에는 JSX 가 없어 **React 트리 밖에서도 불러올 수 있다** —
 *   Node 로 롤백 경로를 검증할 때 실제로 그 성질을 썼다(트리 밖 호출은 아래
 *   기본값의 `console.warn` 으로 드러난다).
 */

export interface ToastInput {
  readonly title: string;
  readonly description: string;
  readonly detail?: string | null;
}

export interface ToastApi {
  /** 롤백 알림 하나를 띄운다. 실패 경로에서만 부른다. */
  readonly notify: (input: ToastInput) => void;
}

/**
 * Provider 밖에서도 **터지지 않는다.** 알림은 부가 기능이고, 그것 때문에 화면이
 * 죽는 것은 비용 대비 손해다. 대신 콘솔에 남겨 배선 누락을 알아챈다.
 */
export const ToastContext = createContext<ToastApi>({
  notify: (input) => {
    console.warn(
      `[toast] ToastProvider 밖에서 notify 가 호출됐습니다: ${input.title} / ${input.description}`,
    );
  },
});

export function useToaster(): ToastApi {
  return useContext(ToastContext);
}
