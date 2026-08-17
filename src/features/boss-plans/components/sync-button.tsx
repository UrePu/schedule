"use client";

import { RefreshCw } from "lucide-react";

import { Button, HelperText } from "@/components/ui";
import { useStoredApiKey } from "@/features/auth/lib/use-stored-api-key";

/**
 * 인게임 스케줄러 동기화 버튼 — **캐릭터당 넥슨 1콜** (§2.1.1).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 자동 갱신이 있는데 버튼이 왜 또 필요한가
 * ─────────────────────────────────────────────────────────────────────────────
 * 진입 시 자동 갱신(§1.1.1)은 **신선도 가드**를 지킨다 — 마지막 호출이 넥슨 지연 창
 * (15분) 안이면 건너뛴다. 그 창 안에서도 눌러야 할 때가 있다: *"방금 잡았으니 지금
 * 갱신"*. 이 버튼이 그 경로이며 **가드를 우회한다.**
 *
 * 우회하는 것은 우리 가드까지다. 넥슨의 **초당 5콜 한도**는 우회하지 못하며, 호출은
 * 자동 경로와 똑같이 `paceNexonRequest()` 를 지난다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 키가 없으면 버튼을 비활성화한다
 * ─────────────────────────────────────────────────────────────────────────────
 * 원문 키는 **DB 에 없다**(§2.1.1 — SHA-256 해시만 저장). 서버가 대신 넥슨을 부를 수
 * 있는 것은 브라우저가 localStorage 에 들고 있는 키를 헤더로 실어 줄 때뿐이다.
 * 다른 기기에서 로그인했다면 키가 없을 수 있고, **그것은 오류가 아니라 정상 상태**다.
 */

export interface SyncButtonProps {
  readonly characterId: string;
  readonly onSync: (input: {
    readonly apiKey: string;
    readonly characterId: string;
  }) => void;
  readonly isPending: boolean;
  readonly label?: string;
  readonly size?: "sm" | "md";
  readonly variant?: "primary" | "secondary";
}

export function SyncButton({
  characterId,
  onSync,
  isPending,
  label = "지금 불러오기",
  size = "sm",
  variant = "secondary",
}: SyncButtonProps) {
  const apiKey = useStoredApiKey();

  if (apiKey === null) {
    return (
      <HelperText>
        이 기기에 저장된 API 키가 없어 불러올 수 없습니다. 홈에서 키로 다시
        로그인하면 저장됩니다.
      </HelperText>
    );
  }

  return (
    <Button
      variant={variant}
      size={size}
      disabled={isPending}
      onClick={() => onSync({ apiKey, characterId })}
    >
      <RefreshCw aria-hidden size={size === "sm" ? 14 : 16} />
      {isPending ? "불러오는 중…" : label}
    </Button>
  );
}
