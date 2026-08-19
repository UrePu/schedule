import { TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * 주의 문구 — **주황은 배경과 아이콘이 지고, 글자는 잉크가 진다** (§4).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 문장을 `text-tertiary` 로 쓰지 않는가
 * ─────────────────────────────────────────────────────────────────────────────
 * 라이트 모드에서 `#f97316` / `#ffffff` = **2.80:1** 로 AA(4.5:1)에 한참 못 미쳤다.
 * 2026-08-19 대비 감사에서 라이트 `tertiary` 를 `#cf6016` 으로 내렸지만 **3.93:1** 이라
 * 여전히 미달이다 — 아이콘 기준 3:1 을 맞추려고 내린 값이지 글자용이 아니다.
 * 글자에 주황이 반드시 필요한 자리는 `tertiary-ink`(#a0490e, 흰 면 6.08:1)를 쓴다.
 * 다크는 7.82:1 이라 다크만 놓고 계산하면 그냥 지나친다 — 실제로 두 번 지나쳤다.
 *   → 색 토큰은 그대로 두고 **역할을 나눴다.** 의미(주의·임박 = 주황, §4)는 틴트 배경과
 *     아이콘이 전달하고, 읽어야 하는 문장은 `text-ink` 가 맡는다.
 *     라이트 16.69:1 · 다크 14.12:1 로 양쪽 모두 넉넉히 통과한다.
 *
 * **빨강을 쓰지 않는다.** 빨강은 실패·취소 전용이다(§4). 인원 미확인이나 12개 상한
 * 접근은 "확인이 필요한 상태"이지 실패가 아니다.
 *
 * 크기는 `text-body-sm`(14px)이다 — 여기 들어가는 것은 라벨이 아니라 **문장**이고,
 * 문장의 하한이 14px 이다(§4).
 */
export function WarningNote({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-md border border-chip-soon-border bg-chip-soon-bg px-3 py-2 text-body-sm text-ink",
        className,
      )}
    >
      <TriangleAlert
        aria-hidden
        size={16}
        className="mt-0.5 shrink-0 text-tertiary"
      />
      <span>{children}</span>
    </p>
  );
}
