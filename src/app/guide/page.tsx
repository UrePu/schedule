import type { Metadata } from "next";

import { PAGE_SHELL_CLASS } from "@/components/layout";
import { SetupGuide } from "@/features/guide/components";

/**
 * `/guide` — 기타 › **가이드**
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * 발주 지시(2026-08-20)
 * ═════════════════════════════════════════════════════════════════════════════
 * *"봇 처음 들어와서 적용하기까지가 조금 어려운거같음. 처음 설명에 가이드문서 작성해서
 * 현황 관리 옆에 기타 하나 넣고 거기다 가이드 넣어줘. 그리고 실제로 가이드 문서에서도
 * 채팅방 연결과 계정연결을 설명해주고 생성도 거기서도 가능하게 해서 그냥 12345 순서대로
 * 따라하면되도록 ㄱㄱ"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * **비로그인도 열린다** — 그것이 이 화면의 요점이다
 * ─────────────────────────────────────────────────────────────────────────────
 * 다른 설정 화면들은 세션이 없으면 "로그인이 필요합니다" 카드를 그린다. 여기는 그러면
 * **순서가 거꾸로다** — 1번이 바로 "로그인하기"이기 때문이다. 로그인해야 볼 수 있는
 * 가입 안내는 안내가 아니다.
 *
 * ★ 그래서 이 페이지는 **서버에서 세션을 읽지 않고, DB 도 읽지 않는다.** 단계별 진행
 *   상태는 클라이언트가 자기 쿼리로 확인하며, 세션이 없으면 그 쿼리들이 아예 꺼진다
 *   (`setup-guide.tsx` 의 `enabled`). 비로그인 200 이 구조로 보장된다(DoD §0.3).
 * ★ prefetch 도 하지 않는다. 심을 값이 사용자마다 다른데 사용자를 모르는 화면이고,
 *   가이드를 여는 사람은 대개 **아직 아무 데이터도 없는** 사람이다.
 *
 * `force-dynamic` 을 쓰지 않는다 — 이 화면은 "누가 보고 있는가"에도 "지금이 몇 주차인가"
 * 에도 달려 있지 않다. 정적으로 그려도 되는 몇 안 되는 화면이다.
 */

export const metadata: Metadata = {
  title: "가이드",
  description:
    "넥슨 API 키 로그인부터 카카오톡·텔레그램 채팅방 연결과 계정 연결까지, 순서대로 따라 하면 되는 처음 설정 안내입니다.",
};

export default function GuidePage() {
  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className="flex flex-col gap-2">
        <p className="text-overline uppercase text-primary">기타</p>
        <h1 className="font-headline text-subhead text-ink">처음 설정 가이드</h1>
        <p className="max-w-3xl text-body-sm text-ink-muted">
          위에서부터 <strong className="font-semibold">1 → 5 순서대로</strong>{" "}
          따라가면 됩니다. 코드 발급 같은 실제 동작은 그 단계 안에서 바로 할 수 있으니
          다른 화면으로 옮길 일이 없습니다. 이미 끝난 단계는 체크로 표시됩니다.
        </p>
      </header>

      <SetupGuide />

      <footer className="flex flex-col gap-2 border-t border-border pt-6">
        <p className="text-body-sm text-ink-muted">
          Data based on NEXON Open API
        </p>
      </footer>
    </main>
  );
}
