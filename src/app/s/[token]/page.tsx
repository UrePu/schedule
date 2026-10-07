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
import { verifyShareToken } from "@/features/share/server/share-token";
import { getAdminDb } from "@/lib/supabase/admin-db";
import { formatKstShort } from "@/components/domain/kst-format";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `/s/<토큰>` — `!숙제` 가 방에 던지는 **착지 화면**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 두 손님을 받는다.
 * 1. **카톡 크롤러** — `generateMetadata` 가 심은 `og:image`(= `./card.png`)만 읽고 간다.
 *    세션이 없으므로 이 경로는 로그인 없이 열려야 한다(§0.3 마지막 항목과 같은 요구).
 * 2. **그림을 눌러 들어온 사람** — 미리보기만 있고 눌렀더니 깨지는 화면이면 안 된다.
 *    그래서 같은 카드를 HTML 로 다시 그린다. 그림과 다른 점은 **캐릭터를 다 보여 준다**는
 *    것뿐이다(그림은 5줄에서 접는다 — `IMAGE_CHARACTER_ROWS` 머리말).
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
 * ⚠️ **쿼리스트링은 읽지 않는다.** 봇이 보내는 주소에는 `?t=HHmmss` 가 붙어 있다
 *    (`share/server/share-token.ts` `buildShareUrl` — 같은 답장을 두 번 보낼 때 도배 방지가
 *    카드를 깨뜨리지 않게 하는 조각이다). 이 화면과 `card.png` 는 둘 다 `params.token`
 *    하나만 보므로 그 값은 **아무 영향이 없다.** 자격증명은 토큰에만 있다 — 쿼리를 읽기
 *    시작하면 사용자가 고칠 수 있는 입력이 권한 경로에 끼어든다.
 */
export const dynamic = "force-dynamic";

interface PageProps {
  readonly params: Promise<{ readonly token: string }>;
}

export async function generateMetadata({
  params,
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
  const imageUrl = `${origin}/s/${token}/card.png`;

  /*
    ───────────────────────────────────────────────────────────────────────────
    ★ ═══ **설명을 걷어낸다 — 카드가 사실상 그림 하나여야 한다** (발주 지시 2026-10-07)
    ───────────────────────────────────────────────────────────────────────────
    *"설명없애서 바로보기에서 딱 이미지처럼 나오게 해"*

    카톡 카드는 `그림 + og:title + og:description` 을 쌓는다. 그런데 그 설명문이 말하는
    것(*"남은 보스와 결정석 금액을 캐릭터별로"*)은 **그림이 이미 머리에 더 크게 적고 있다.**
    같은 말을 작은 회색 글씨로 한 번 더 쌓으면 그림이 그만큼 밀리고, 발주자가 본 것이
    정확히 그 모양이다. 그래서 설명은 **뺀다.**

    ⚠️ **`description: null` 을 명시해야 실제로 사라진다.** 필드를 그냥 지우면 루트
       레이아웃(`app/layout.tsx`)의 앱 소개문이 **상속되고**, Next 는 `openGraph.description`
       이 비어 있으면 그 값으로 **채워 넣는다**(`next/dist/lib/metadata/resolve-metadata.js`
       의 `inheritFromMetadata`). 즉 지우는 것만으로는 설명이 더 길어진다. `null` 은 Next 가
       공식적으로 지원하는 "부모 상속 거부" 값이다(`description?: null | string`).
    ⚠️ **제목은 비우지 않는다.** og 제목이 없으면 미리보기 자체를 포기하는 크롤러가 있어,
       설명을 없애려다 **카드를 없애는** 결과가 된다. 그래서 가장 짧은 뜻 있는 한 단어
       `숙제` 만 남겼다 — 사람이 방에서 친 명령과 같은 말이고, 그림의 제목줄(`💎 남은 주간
       보스 …`)과 겹치지 않는 길이다.
    ★ **브라우저 탭 제목(`title`)은 줄이지 않는다.** 그쪽 독자는 크롤러가 아니라 **링크를
      눌러 들어온 사람**이고, 탭에 `숙제` 한 글자만 뜨면 어느 화면인지 알 수 없다. 두
      독자에게 서로 다른 문자열을 주는 것이 맞다 — 카드는 `숙제`, 탭은
      `남은 주간 보스 | M_Schedule`(루트 템플릿). 페이지 **본문은 한 줄도 건드리지 않았다.**
    ★ `alt` 는 남긴다. 그림을 못 읽는 독자에게 유일한 설명이고, 카드에는 렌더되지 않는다.
  */
  return {
    title: "남은 주간 보스",
    description: null,
    robots: { index: false, follow: false },
    openGraph: {
      type: "website",
      title: "숙제",
      images: [{ url: imageUrl, width: 1200, height: 630, alt: "남은 주간 보스" }],
    },
    twitter: {
      card: "summary_large_image",
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
