import type { Metadata } from "next";

import { PAGE_SHELL_CLASS } from "@/components/layout";
import {
  LoginRequiredGate,
  requireSessionOrLogin,
} from "@/features/auth/server/login-required";
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
 * 그래서 비로그인은 **로그인 화면으로 보낸다**(발주 2026-11-09 — 예전에는 200 으로
 * "로그인이 필요합니다" 카드를 그렸다). 이 화면은 **친구 링크가 도착하는 곳**이라 돌아갈
 * 주소에 쿼리스트링이 **그대로** 실린다(`returnPathFrom`): `/friends?add=<토큰>` 으로 온
 * 사람은 `/?next=%2Ffriends%3Fadd%3D…` 에서 로그인하고, 같은 주소로 돌아와 토큰이 살아 있다.
 *
 * ★ 서버가 세션을 모른다고 해도 힌트 쿠키가 있으면 그것을 최종 판정으로 받아들이지
 *   않는다(`LoginRequiredGate` → `SessionGate`). RSC 렌더 경로에서만 세션 쿠키가 null 로
 *   떨어지는 결함을 이미 두 번 겪었다(`app/page.tsx` · `app/income/page.tsx` 주석).
 *   세션이 있을 때도 같은 게이트 뒤에서 그린다 — 원래 클라이언트가 그리는 화면이라
 *   서버가 아는 것이 화면을 바꾸지 않고, 정지 계정은 게이트가 `/api/auth/me` 로 걸러
 *   로그인 화면으로 보낸다.
 * ★ **서버가 prefetch 하지 않는다.** 친구 목록은 뮤테이션이 곧바로 갱신하는 값이라 캐시가
 *   소유해야 하고(§2.4 Rule 1), 화면 컴포넌트가 자기 `useQuery` 로 가져온다.
 */

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "친구",
  description:
    "닉네임으로 친구를 찾아 신청하고, 받은 신청을 수락합니다. 검색을 거부하면 링크로만 추가할 수 있습니다.",
};

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

  /*
    세션도 힌트 쿠키도 없으면 이 줄에서 로그인 화면으로 간다 — `?add=` 를 보존한 채로.
    돌아오는 값은 쓰지 않는다: 세션이 있든(서버가 봤다) 없든(힌트만 있다) 아래 게이트가
    클라이언트 세션으로 판정한다.
  */
  await requireSessionOrLogin("/friends", params);

  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className="flex flex-col gap-1">
        <p className="text-overline uppercase text-primary">친구</p>
        <h1 className="font-headline text-subhead text-ink">친구 관리</h1>
        <p className="max-w-3xl text-body-sm text-ink-muted">
          친구가 되면 <strong className="font-semibold">파티에 넣을 수 있는 후보</strong>
          로 나타납니다. 닉네임 검색이 부담스러우면 아래{" "}
          <strong className="font-semibold">내 설정</strong>에서 검색을 끄고 링크로만
          받을 수 있습니다.
        </p>
      </header>

      <LoginRequiredGate>
        <FriendsWorkspace initialToken={addToken} />
      </LoginRequiredGate>
    </main>
  );
}
