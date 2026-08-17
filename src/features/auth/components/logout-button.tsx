"use client";

import { LogOut } from "lucide-react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui";

import { useLogoutMutation } from "../data/auth-queries";

/**
 * 로그아웃 버튼 하나.
 *
 * `AuthPanel` 을 통째로 쓰지 않고 이것만 떼어 낸 이유: 대시보드는 신원·키·캐릭터를
 * 각각 전용 카드로 이미 보여 준다. 거기에 `AuthPanel` 을 얹으면 같은 정보가 두 번
 * 나오고, 어느 쪽이 진실인지 화면이 스스로 헷갈리게 된다.
 *
 * 로그아웃 후 `router.refresh()` 를 부르는 것이 핵심이다. `/` 는 **서버에서** 세션을 보고
 * 대시보드/랜딩을 가르므로, 쿠키만 지우고 서버 렌더를 새로 받지 않으면 로그아웃했는데도
 * 대시보드가 그대로 남는다.
 */
export interface LogoutButtonProps {
  readonly className?: string;
}

export function LogoutButton({ className }: LogoutButtonProps) {
  const router = useRouter();
  const logout = useLogoutMutation();

  return (
    <Button
      variant="ghost"
      size="sm"
      className={className}
      disabled={logout.isPending}
      onClick={() =>
        logout.mutate(undefined, {
          onSuccess: () => router.refresh(),
        })
      }
    >
      <LogOut aria-hidden size={14} />
      {logout.isPending ? "로그아웃 중…" : "로그아웃"}
    </Button>
  );
}
