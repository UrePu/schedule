import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { BossIcon } from "@/components/domain";
import { PAGE_SHELL_CLASS } from "@/components/layout";
import { buildHomeworkCard } from "@/features/bot/server/homework-list";
import {
  buildHomeworkCardView,
  type HomeworkCardView,
} from "@/features/share/server/homework-card-view";
import { publicOriginFrom } from "@/features/share/server/og-assets";
import {
  sanitizeShareBust,
  SHARE_BUST_PARAM,
  verifyShareToken,
} from "@/features/share/server/share-token";
import { getAdminDb } from "@/lib/supabase/admin-db";
import { formatKstShort } from "@/components/domain/kst-format";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `/s/<토큰>` — `!숙제` 가 방에 던지는 **착지 화면**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 두 손님을 받는다.
 * 1. **카톡 크롤러** — `generateMetadata` 가 심은 `og:image`(= `./card.png?t=…`)만 읽고 간다.
 *    세션이 없으므로 이 경로는 로그인 없이 열려야 한다(§0.3 마지막 항목과 같은 요구).
 * 2. **그림을 눌러 들어온 사람** — 미리보기만 있고 눌렀더니 깨지는 화면이면 안 된다.
 *    그래서 같은 카드를 HTML 로 다시 그린다. 그림과 다른 점은 **캐릭터를 다 보여 준다**는
 *    것뿐이다(그림은 **4줄**에서 접는다 — 2026-10-07 에 아이콘을 키우며 5 → 3 으로 내렸고,
 *    같은 날 발주 지시 *"3줄은 에바고 4줄로 해"* 로 4 가 되었다, `IMAGE_CHARACTER_ROWS`
 *    머리말). 그림이 접은 나머지를 보려고 누르는 화면이 여기다.
 *
 * ⚠️ **토큰 검증 외에는 아무것도 흘리지 않는다.** 위조·만료는 둘 다 `notFound()` 이고
 *    (구분해 알려 주면 토큰을 훑을 수 있다), 담기는 정보는 `buildHomeworkCard` 가 평문과
 *    같은 기준으로 접은 것뿐이다. 세션은 읽지 않는다 — 읽으면 "내 계정으로 보는 화면"이
 *    되어 로그인 여부에 따라 내용이 달라지고, 그건 공유 링크가 아니다.
 *
 * `force-dynamic` 인 이유: 토큰마다 내용이 다르고 만료가 시각에 달려 있다. 정적으로
 * 구워지면 빌드 시점의 숫자가 영원히 박힌다.
 * `robots: noindex` 인 이유: **주소 자체가 비밀**이다. 색인되면 검색으로 새어 나간다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ ═══ **쿼리 `t` 는 읽는다 — 다만 캐시를 가르는 데만** (2026-10-07)
 * ─────────────────────────────────────────────────────────────────────────────
 * 번복이다. 이 자리에는 *"쿼리스트링은 읽지 않는다"* 가 적혀 있었고, 근거는 "자격증명은
 * 토큰에만 있으니 쿼리를 읽기 시작하면 사용자가 고칠 수 있는 입력이 권한 경로에 끼어든다"
 * 였다. 그 근거는 **여전히 옳고 여전히 지킨다** — 아래에서 `t` 는 권한에도, 내용에도,
 * 만료에도 닿지 않는다. 바뀐 것은 **읽지 않아서 생긴 버그**가 드러났다는 사실이다.
 *
 * 발주 보고: *"이미지 캐싱때문에 갱신이 안되는듯함"*. 봇이 보내는 **페이지** 주소에는
 * `?t=HHmmss` 가 붙지만(`share/server/share-token.ts` `buildShareUrl`), 이 화면이 내려주던
 * **`og:image` 는 쿼리 없는 고정 주소**(`.../card.png`)였다. 카톡과 브라우저는 **그림을 그
 * 주소로** 캐시하므로, 페이지 주소가 매번 달라도 **그림은 옛것**이 나왔다. 페이지만 새로
 * 긁히고 그림은 그대로였던 것이다.
 * → 그래서 들어온 `t` 를 `og:image`/`twitter:image` 주소로 **흘려보낸다.** 한 번 보낼
 *   때마다 그림 주소가 새로 생겨 캐시를 비껴간다.
 *
 * ⚠️ `t` 는 **신뢰할 수 없는 입력**이므로 그대로 잇지 않는다. `sanitizeShareBust` 가
 *    형식(`HHmmss`)을 보고, 아니면 지금 시각으로 갈아 끼운다 — 근거는 그 함수 머리말.
 * ⚠️ `card.png` 는 여전히 `t` 를 **보지 않는다.** 그림의 내용은 토큰 하나가 정한다.
 *    쿼리는 캐시를 가르는 용도뿐이고, 그 성질을 깨면 쿼리가 그림 내용을 흔드는 입력이 된다.
 * ⚠️ **이미 나간 메시지는 못 고친다.** 카카오가 옛 주소(`?t=` 없던 `card.png`)로 캐시해 둔
 *    카드는 그대로 남고, 우리 쪽에서 무효화할 방법이 없다. 그 방에서 `!숙제` 를 **다시
 *    치면** 새 `t` 가 붙은 새 그림 주소가 나간다. "왜 옛 카드가 아직 보이지"가 다시
 *    나오면 이 문단이 답이다 — 같은 조사를 반복하지 말 것.
 */
export const dynamic = "force-dynamic";

interface PageProps {
  readonly params: Promise<{ readonly token: string }>;
  /**
   * ★ `searchParams` 는 **page 세그먼트에서만** 주어진다(Next 16
   * `docs/01-app/03-api-reference/04-functions/generate-metadata.md`). 그래서 이 값을
   * 읽는 자리가 이 화면일 수밖에 없다 — `card.png` 는 Route Handler 라 `params` 만 받고,
   * 레이아웃에는 애초에 오지 않는다.
   */
  readonly searchParams: Promise<
    Record<string, string | readonly string[] | undefined>
  >;
}

export async function generateMetadata({
  params,
  searchParams,
}: PageProps): Promise<Metadata> {
  const { token } = await params;
  const claim = verifyShareToken(token, new Date());

  /*
    토큰이 죽었으면 **미리보기를 만들지 않는다.** 이미지 주소를 심어 두면 크롤러가
    404 를 받으러 한 번 더 오고, 방에는 깨진 카드가 뜬다. 아무 카드도 없는 편이 낫다.
  */
  if (claim === null) {
    return {
      title: "숙제 공유",
      description: null,
      robots: { index: false, follow: false },
    };
  }

  /*
    `metadataBase` 를 두지 않는 이유는 `og-assets.publicOriginFrom` 머리말과 같다 —
    배포 주소를 환경변수에 적으면 조용히 낡는다. 요청 헤더가 늘 맞는 답을 갖고 있다.
  */
  const origin = publicOriginFrom(await headers());
  /*
    그림 주소에 `t` 를 얹는다 — 위 ⚠️ 문단의 캐시 깨기. 없거나 모양이 아니면
    `sanitizeShareBust` 가 지금 시각을 넣으므로, **쿼리 없는 주소는 나가지 않는다.**
  */
  const bust = sanitizeShareBust((await searchParams)[SHARE_BUST_PARAM]);
  const imageUrl = `${origin}/s/${token}/card.png?${SHARE_BUST_PARAM}=${bust}`;

  /*
    ───────────────────────────────────────────────────────────────────────────
    ★ ═══ **설명을 되살린다 — 그림이 더는 제목을 말하지 않는다** (발주 지시 2026-10-07)
    ───────────────────────────────────────────────────────────────────────────
    번복 경위를 한 줄로 남긴다. 같은 날 오전 *"설명없애서 바로보기에서 딱 이미지처럼
    나오게 해"* 로 한 번 걷어냈고, 같은 날 *"숙제 밑에 남은 숙제 같은 설명 도 있긴해야
    되네"* 로 **되살렸다.** 말이 바뀐 것이 아니라 **그림이 바뀌었다** — 같은 날 카드
    그림에서 `남은 주간 보스` 제목줄을 걷어냈으므로(`card.png/route.tsx` 의 잘림 머리말),
    처음 설명을 없앤 근거("그림이 이미 머리에 더 크게 적고 있다")가 그대로 사라졌다.
    지금은 그 낱말을 말하는 자리가 og 설명밖에 없다.

    ⚠️ **숫자는 되풀이하지 않는다.** 건수·금액은 그림이 가장 큰 글씨로 말한다. 설명이
       같은 숫자를 작은 회색 글씨로 한 번 더 쌓으면 그림이 그만큼 밀리고, 그게 애초에
       설명을 없애게 만든 바로 그 모양이다. 설명은 **그림이 말하지 않는 것**만 말한다.
    ⚠️ **두 자리에 같은 문자열을 명시한다.** 한쪽을 비우면 루트 레이아웃(`app/layout.tsx`)의
       앱 소개문이 상속되고, Next 는 `openGraph.description` 이 비어 있으면 그 값으로
       **채워 넣는다**(`next/dist/lib/metadata/resolve-metadata.js` 의
       `inheritFromMetadata`). 즉 비우는 것은 "설명 없음"이 아니라 "긴 앱 소개문"이다.
    ★ **`og:title` 은 `숙제` 그대로 둔다**(2026-10-07). 제목까지 없애 보자는 이야기가 한때
      있었지만, og 제목이 없으면 미리보기 자체를 포기하는 크롤러가 있어 **설명을 없애려다
      카드를 없애는** 결과가 된다. 발주자도 설명과 함께 있는 편이 낫다고 정리했다.
      사람이 방에서 친 명령(`!숙제`)과 같은 말이기도 하다.
    ★ **브라우저 탭 제목(`title`)은 줄이지 않는다.** 그쪽 독자는 크롤러가 아니라 **링크를
      눌러 들어온 사람**이고, 탭에 `숙제` 한 글자만 뜨면 어느 화면인지 알 수 없다. 두
      독자에게 서로 다른 문자열을 주는 것이 맞다 — 카드는 `숙제`, 탭은
      `남은 주간 보스 | M_Schedule`(루트 템플릿). 페이지 **본문은 한 줄도 건드리지 않았다.**
    ★ `alt` 는 남긴다. 그림을 못 읽는 독자에게 유일한 설명이고, 카드에는 렌더되지 않는다.
  */
  const scopeTitle = claim.scope === "monthly" ? "남은 월간 보스" : "남은 주간 보스";
  /** 그림이 말하지 않는 것 하나 — **무엇이 남은 숫자인지**. 금액·건수는 적지 않는다. */
  const description = `${scopeTitle} · 캐릭터별 결정석`;

  return {
    title: scopeTitle,
    description,
    robots: { index: false, follow: false },
    openGraph: {
      type: "website",
      title: "숙제",
      description,
      images: [{ url: imageUrl, width: 1200, height: 630, alt: scopeTitle }],
    },
    twitter: {
      card: "summary_large_image",
      description,
      images: [imageUrl],
    },
  };
}

export default async function SharePage({ params }: PageProps) {
  const { token } = await params;
  const now = new Date();

  const claim = verifyShareToken(token, now);
  if (claim === null) notFound();

  const card = await buildHomeworkCard(
    getAdminDb(),
    claim.userId,
    claim.scope,
    now,
  );
  const view = buildHomeworkCardView(card);

  return (
    <main className={PAGE_SHELL_CLASS}>
      <header className="flex flex-col gap-1">
        <p className="text-overline uppercase text-primary">공유 링크</p>
        <h1 className="font-headline text-subhead text-ink">{view.title}</h1>
        <p className="text-body-sm text-ink-muted">{view.resetNote}</p>
      </header>

      <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-5">
        <p className="font-headline text-display text-primary">
          {view.emptyLabel ?? view.summary}
        </p>
        {view.notes.length > 0 ? (
          <p className="text-body-sm text-ink-muted">{view.notes.join(" · ")}</p>
        ) : null}
      </section>

      {view.rows.length === 0 ? (
        /*
          빈 상태다. **오류가 아니다** — 다 돌았거나, 남은 것이 전부 금액 문턱 아래거나,
          계획이 아직 없다. 셋 중 어느 것인지는 위 요약 줄과 꼬리말이 이미 말한다.
        */
        <p className="rounded-lg border border-border bg-surface p-5 text-body-sm text-ink-muted">
          목록에 올릴 보스가 없습니다.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {view.rows.map((row) => (
            <ShareCharacterRow key={row.characterName} row={row} />
          ))}
        </ul>
      )}

      <footer className="flex flex-col gap-2 border-t border-border pt-6">
        <p className="text-body-sm text-ink-muted">
          이 링크는 {formatKstShort(claim.expiresAt)} (주간 초기화)에 만료됩니다.
        </p>
        <p className="text-body-sm text-ink-muted">
          Data based on NEXON Open API
        </p>
        <Link
          href="/"
          className="text-body-sm text-primary underline-offset-2 hover:underline"
        >
          ← M_Schedule 열기
        </Link>
      </footer>
    </main>
  );
}

/**
 * 캐릭터 한 줄. 참고 화면(`/boss-status`)과 같은 축 — 이름 · 남은 개수 · 남은 금액 ·
 * 남은 보스 얼굴.
 *
 * ★ 왼쪽 보더로 구분을 짊어진다(§4). 아이콘 테두리 색은 난이도다 — `BossIcon` 의 규약.
 */
function ShareCharacterRow({ row }: { readonly row: HomeworkCardView["rows"][number] }) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border border-l-4 border-l-primary bg-surface p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex flex-col gap-0.5">
        <span className="font-headline text-body text-ink">
          {row.characterName}
        </span>
        <span className="text-body-sm text-ink-muted">
          {`${row.countLabel} · ${row.mesoLabel}`}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {row.bosses.map((boss) => (
          <span
            key={boss.bossDifficultyId}
            className="flex items-center gap-1"
            title={boss.isSeason ? `${boss.koreanName} (시즌)` : boss.koreanName}
          >
            <BossIcon
              bossDifficultyId={boss.bossDifficultyId}
              difficulty={boss.difficulty}
              size="sm"
            />
            <span className="text-caption text-ink-label">
              {boss.isSeason ? `${boss.shortName}(시즌)` : boss.shortName}
            </span>
          </span>
        ))}
      </div>
    </li>
  );
}
