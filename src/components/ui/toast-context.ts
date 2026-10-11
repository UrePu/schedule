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

/**
 * 알림의 성격.
 *
 * ⚠️ 이 필드는 **나중에 넓힌 것**이다(2026-08-28). 원래 이 컴포넌트는 낙관적 업데이트가
 *    되돌아갔다는 사실만 말하는 실패 전용이었다. 넓힌 이유는 반대쪽에도 같은 구멍이
 *    있었기 때문이다 — 모달에서 저장에 **성공**해도 창이 그대로 서 있고 아무 말이
 *    없어서, 사용자가 눌린 건지 알 수 없었다(발주 지적: *"등록을 눌러도 반응이없음.
 *    생성된건지 확인안됨"*). 조용한 성공은 조용한 실패와 화면에서 구별되지 않는다.
 *
 * ★ 색 규칙은 §4 그대로다. `error` 는 red(실패·취소 전용), `success` 는 green.
 *   둘 다 **배경·테두리·아이콘이 색을 지고 문장은 잉크**다.
 */
/**
 * ★ `warning` 은 2026-10-11 에 더했다 — **2단 저장의 둘째 단계가 실패한 경우** 때문이다.
 *   파티는 만들어졌고 소요 시간만 저장되지 않은 결과는 성공도 실패도 아니다. 초록으로
 *   말하면 다 됐다고 읽히고, 빨강으로 말하면 아무것도 안 됐다고 읽혀 **사용자가 다시
 *   눌러 같은 파티를 둘** 만든다. §4 가 그 자리에 쓰라고 정해 둔 색이 tertiary 주황이고
 *   (빨강은 실패·취소 전용), 쓰는 토큰 쌍은 화면 곳곳의 주의 패널과 **같은**
 *   `chip-soon-*` 이라 이미 대비 감사를 통과한 조합이다.
 */
export type ToastTone = "error" | "success" | "warning";

export interface ToastInput {
  readonly title: string;
  readonly description: string;
  readonly detail?: string | null;
  /** 생략하면 `error`. 기존 호출부(롤백 알림)가 전부 실패 경로라 기본값을 바꾸지 않는다. */
  readonly tone?: ToastTone;
}

export interface ToastApi {
  /** 알림 하나를 띄운다. `tone` 을 생략하면 실패(red)다. */
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
