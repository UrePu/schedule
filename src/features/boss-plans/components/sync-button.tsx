"use client";

import { KeyRound, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui";
import {
  useIsHydrated,
  useStoredApiKeys,
} from "@/features/auth/lib/use-stored-api-key";

import {
  describeMissingKey,
  describeUnlinkedCharacter,
  formatSyncFailure,
} from "../lib/sync-failure-message";

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
 * ★ 키는 **이 캐릭터의 계정 키**여야 한다 (§1.1 · §2.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 넥슨 키는 자기 계정의 캐릭터만 읽는다. 그래서 저장소에서 아무 키나 꺼내 쓰면 다른
 * 계정 캐릭터에서 반드시 거절당하고(`OPENAPI00004`), 그 거절은 **호출량을 태운 뒤에**
 * 온다. 여기서는 서버가 실어 준 `credentialId` 로 정확히 그 키만 꺼낸다.
 *
 * 키가 없으면 **버튼을 감추고 조치를 알린다.** 다른 기기에서 로그인했거나 그 계정 키를
 * 아직 이 브라우저에 넣지 않은 것이며, **오류가 아니라 정상 상태**다.
 */

export interface SyncButtonProps {
  readonly characterId: string;
  /**
   * 이 캐릭터를 읽을 수 있는 자격증명. `null` 이면 어느 계정 소속인지 모르는 상태다.
   * 출처는 `GET /api/boss-plans/checklist` 의 `character.credentialId`.
   */
  readonly credentialId: string | null;
  /** 그 자격증명의 이름. "어느 키를 넣어야 하는지" 안내에 쓴다. */
  readonly credentialLabel?: string | null;
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
  credentialId,
  credentialLabel = null,
  onSync,
  isPending,
  label = "지금 불러오기",
  size = "sm",
  variant = "secondary",
}: SyncButtonProps) {
  const hydrated = useIsHydrated();
  const apiKeys = useStoredApiKeys();
  const apiKey = credentialId === null ? null : (apiKeys[credentialId] ?? null);

  /*
   * 서버 렌더 시점에는 저장소를 읽을 수 없어 **모든 캐릭터가 "키 없음"으로 보인다.**
   * 그 상태를 그대로 그리면 키가 멀쩡한 사용자도 진입할 때마다 주황 경고가 번쩍인다.
   * 판정이 설 때까지는 **비활성 버튼**으로 자리만 잡는다 — 레이아웃도 흔들리지 않는다.
   */
  if (!hydrated) {
    return (
      <Button variant={variant} size={size} disabled>
        <RefreshCw aria-hidden size={size === "sm" ? 14 : 16} />
        {label}
      </Button>
    );
  }

  if (apiKey === null) {
    /*
     * §4: 경고는 **tertiary orange 배경 · 아이콘**이고 문장은 잉크다 — 주황 본문은
     * 라이트에서 AA 에 미달한다. red 는 실패·취소 전용이라 여기서는 쓰지 않는다.
     * 문장은 14px(`text-body-sm`) 이상이어야 한다.
     */
    const notice =
      credentialId === null
        ? describeUnlinkedCharacter()
        : describeMissingKey(credentialLabel);

    return (
      <p className="flex max-w-xs items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink">
        <KeyRound
          aria-hidden
          size={16}
          className="mt-0.5 shrink-0 text-tertiary"
        />
        <span>{formatSyncFailure(notice)}</span>
      </p>
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
