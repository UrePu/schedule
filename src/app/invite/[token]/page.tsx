import type { Metadata } from "next";
import Link from "next/link";

import { PAGE_SHELL_CLASS } from "@/components/layout";
import { readSession } from "@/features/auth/server/session";
import { InviteClaimPanel } from "@/features/invites/components";
import { resolveInvite } from "@/features/invites/server/invite-repo";

/**
 * 초대 링크 착지 화면 (`/invite/<토큰>`).
 *
 * ★ **비로그인도 열린다**(§0.3 마지막 항목). 받는 사람은 대개 아직 계정이 없다.
 *   서버 컴포넌트가 토큰을 풀어 "누구로 초대됐고 어떤 파티가 딸려오는지"를 먼저 그리고,
 *   그 아래에서 로그인 → 승계로 이어진다.
 *
 * ⚠️ 토큰 조회는 **repo 를 직접 import** 한다. `features/invites/data` 의 함수는 상대 경로
 *   `fetch("/api/...")` 라 서버에서 해석되지 않는다 (`/schedule/page.tsx` 와 같은 이유).
 *
 * `force-dynamic` 인 이유: 결과가 **토큰 상태**(살아 있나·이미 쓰였나)와 **세션**에 달려
 * 있다. 프리렌더되면 이미 사용된 링크가 계속 "받기" 버튼을 보여 준다.
 *
 * `robots: noindex` 인 이유: 주소 자체가 비밀이다. 색인되면 검색으로 새어 나간다.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "파티 초대",
  description: "초대 링크로 파티 자리를 내 계정에 가져옵니다.",
  robots: { index: false, follow: false },
};

export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const [session, summary] = await Promise.all([
    readSession(),
    resolveInvite(token),
  ]);

  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className="flex flex-col gap-1">
        <p className="text-overline uppercase text-primary">파티 초대</p>
        <h1 className="font-headline text-subhead text-ink">
          내 계정으로 파티 가져오기
        </h1>
      </header>

      <InviteClaimPanel
        token={token}
        summary={summary}
        isSignedIn={session !== null}
      />

      <footer className="flex flex-col gap-2 border-t border-border pt-6">
        <p className="text-body-sm text-ink-muted">
          Data based on NEXON Open API
        </p>
        <Link
          href="/"
          className="text-body-sm text-primary underline-offset-2 hover:underline"
        >
          ← 홈으로
        </Link>
      </footer>
    </main>
  );
}
