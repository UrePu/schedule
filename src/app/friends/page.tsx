import type { Metadata } from "next";
import Link from "next/link";

import { PAGE_SHELL_CLASS } from "@/components/layout";
import { Card, CardDescription, CardTitle } from "@/components/ui";
import { SessionGate } from "@/features/auth/components";
import { readSignedInHint } from "@/features/auth/server/session";
import { FriendsWorkspace } from "@/features/friends/components";

/**
 * `/friends` — 친구 (§1.2 3순위 · 발주 지시 2026-08-20).
 *
 * *"친구기능 실제로 구현. 검색 신청 수락 목록. 전부 추가 하고 맨위에 수익 옆에 친구 탭
 * 만들어."*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 화면은 **비로그인 열람 대상이 아니다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 친구 관계는 개인의 사회관계망이고, 공개 시간표가 공개하는 범위(§2.1 — "언제 무슨 보스를
 * 간다")에 들어가지 않는다. `friendships` 는 anon 에게 GRANT 자체가 없다.
 *
 * 다만 `/income` · `/boss-plans` 와 같은 판단으로 **리다이렉트하지 않고 200 으로 안내
 * 화면을 그린다.** 리다이렉트는 북마크와 공유 링크를 중간 경유지로 만든다 — 특히 이
 * 화면은 **친구 링크가 도착하는 곳**이라 그 성질이 더 중요하다. 로그인하지 않은 사람이
 * 링크를 열면 주소는 그대로 남고, 로그인 뒤 같은 주소로 돌아오면 토큰이 살아 있다.
 *
 * ★ 서버가 세션을 모른다고 해도 그것을 최종 판정으로 받아들이지 않는다(`SessionGate`).
 *   RSC 렌더 경로에서만 세션 쿠키가 null 로 떨어지는 결함을 이미 두 번 겪었다
 *   (`app/page.tsx` · `app/income/page.tsx` 주석).
 * ★ **서버가 prefetch 하지 않는다.** 친구 목록은 뮤테이션이 곧바로 갱신하는 값이라 캐시가
 *   소유해야 하고(§2.4 Rule 1), 화면 컴포넌트가 자기 `useQuery` 로 가져온다.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "친구",
  description:
    "닉네임으로 친구를 찾아 신청하고, 받은 신청을 수락합니다. 검색을 거부하면 링크로만 추가할 수 있습니다.",
};

function SignInNotice() {
  return (
    <Card className="flex flex-col gap-3">
      <CardTitle>로그인이 필요합니다</CardTitle>
      <CardDescription>
        친구 목록은 본인만 볼 수 있습니다. 넥슨 API 키로 로그인하면 닉네임으로 친구를
        찾고, 받은 링크로 바로 추가할 수 있습니다.
      </CardDescription>
      <Link href="/" className="text-body-sm font-semibold text-primary">
        로그인하러 가기 →
      </Link>
    </Card>
  );
}

export default async function FriendsPage({
  searchParams,
}: {
  /**
   * `?add=<토큰>` — 친구 링크로 들어온 방문자.
   *
   * 토큰을 **서버에서 쓰지 않고 화면에 넘기기만** 한다. 링크를 여는 것만으로 관계가
   * 생기면 미리보기 크롤러나 잘못 눌린 링크가 곧 친구 추가가 된다 — 마지막 한 번은
   * 사람이 눌러야 한다.
   */
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const raw = params.add;
  const addToken = typeof raw === "string" ? raw : null;

  const signedInHint = await readSignedInHint();

  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className="flex flex-col gap-1">
        <p className="text-overline uppercase text-primary">친구</p>
        <h1 className="font-headline text-subhead text-ink">친구 관리</h1>
        <p className="max-w-3xl text-body-sm text-ink-muted">
          친구가 되면 서로의 <strong className="font-semibold">가능 시간</strong>이 일정
          화면에 겹쳐 보이고, 파티에 넣을 수 있는 후보로 나타납니다. 닉네임 검색이 부담
          스러우면 아래 <strong className="font-semibold">내 설정</strong>에서 검색을 끄고
          링크로만 받을 수 있습니다.
        </p>
      </header>

      <SessionGate serverHint={signedInHint} fallback={<SignInNotice />}>
        <FriendsWorkspace initialToken={addToken} />
      </SessionGate>
    </main>
  );
}
