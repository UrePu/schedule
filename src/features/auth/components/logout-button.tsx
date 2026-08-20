"use client";

import { LogOut } from "lucide-react";

import { Button } from "@/components/ui";

import { useLogoutMutation } from "../data/auth-queries";

/**
 * 로그아웃 버튼 하나.
 *
 * `AuthPanel` 을 통째로 쓰지 않고 이것만 떼어 낸 이유: 대시보드는 신원·키·캐릭터를
 * 각각 전용 카드로 이미 보여 준다. 거기에 `AuthPanel` 을 얹으면 같은 정보가 두 번
 * 나오고, 어느 쪽이 진실인지 화면이 스스로 헷갈리게 된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 로그아웃은 **문서 재적재로 끝낸다** — `router.refresh()` 가 아니다
 * ─────────────────────────────────────────────────────────────────────────────
 * `/` 는 **서버에서** 세션을 보고 이번 주 시간표/랜딩을 가르므로, 쿠키만 지우고 서버 렌더를
 * 새로 받지 않으면 로그아웃했는데도 대시보드가 그대로 남는다. 예전에는 `router.refresh()`
 * 로 그걸 했는데, 이 경로는 로그인 경로보다 **더** 확실해야 한다:
 *
 * - `router.refresh()` 는 트랜지션이 커밋될 때까지 옛 UI(=로그인 상태 화면)를 그대로 보여 준다.
 *   왕복이 멎으면 "로그아웃 눌렀는데 내 데이터가 그대로" 인 화면이 남는다.
 * - 남의 PC 에서 로그아웃하는 상황이 이 버튼의 존재 이유다. 문서를 다시 적재하면 라우터
 *   캐시 · BFCache · 남은 쿼리 캐시가 **프로세스 단위로 전부** 사라진다. SPA 갱신은
 *   그중 무엇도 보장하지 않는다(뒤로가기로 앞사람 화면이 되살아나는 길이 남는다).
 * - 로그아웃은 자주 일어나는 동작이 아니라 문서 로드 한 번을 치를 값어치가 있다.
 *
 * `assign` 이 아니라 `replace` 인 이유: 뒤로가기가 방금 버린 로그인 화면으로 돌아가면
 * 안 된다.
 *
 * 목적지가 `/` 인 이유: `/` 는 세션이 없으면 **랜딩**을 그린다. 즉 로그아웃한 사람이
 * 정확히 도착해야 할 곳이며, 어느 화면에서 눌렀든 같다.
 * (2026-08-20 정정 — 예전에는 *"이 버튼은 `Dashboard` 에만 있고 `Dashboard` 는 `/` 에만
 *  있으므로"* 라고 적혀 있었다. 대시보드가 해체되면서 이 버튼은 관리 › 기타(`/etc`)로
 *  옮겨 갔고, 그 근거는 더 이상 사실이 아니다. 결론만 그대로 옳다.)
 */
export interface LogoutButtonProps {
  readonly className?: string;
}

export function LogoutButton({ className }: LogoutButtonProps) {
  const logout = useLogoutMutation();

  return (
    <Button
      variant="ghost"
      size="sm"
      className={className}
      disabled={logout.isPending}
      onClick={() =>
        logout.mutate(undefined, {
          onSuccess: () => {
            window.location.replace("/");
          },
        })
      }
    >
      <LogOut aria-hidden size={14} />
      {logout.isPending ? "로그아웃 중…" : "로그아웃"}
    </Button>
  );
}
