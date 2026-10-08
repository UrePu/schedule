import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { BossIcon } from "@/components/domain";
import { PAGE_SHELL_CLASS } from "@/components/layout";
import { fetchRemainingBosses } from "@/features/bot/server/bot-repo";
import {
  buildHomeworkCardViewFromRemaining,
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
import { cn, formatMesoCompact } from "@/lib/utils";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * `/s/<토큰>` — `!숙제` 가 방에 던지는 **착지 화면**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 두 손님을 받는다.
 * 1. **카톡 크롤러** — `generateMetadata` 가 심은 `og:image`(= `./card.png?t=…`)만 읽고 간다.
 *    세션이 없으므로 이 경로는 로그인 없이 열려야 한다(§0.3 마지막 항목과 같은 요구).
 * 2. **그림을 눌러 들어온 사람** — 미리보기만 있고 눌렀더니 깨지는 화면이면 안 된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **역할이 갈린다 — 그림은 미리보기, 이 화면은 전부** (발주 지시 2026-10-08)
 * ─────────────────────────────────────────────────────────────────────────────
 * *"사진으로는 4개 짤려서 보이게 하고… 웹 안에 직접 들어가면 더크게 다 보여줘야지.
 * 생략된 캐릭터들까지 여기는 외 어쩌고 하지말고 그냥 다 보여줘 글씨필요없고 이미지 크게해서"*
 *
 * 그래서 이 화면은 **아무것도 접지 않는다**:
 *   - 캐릭터 **전부**(그림은 `IMAGE_CHARACTER_ROWS` 4명에서 접는다)
 *   - 캐릭터마다 남은 보스 **전부**(그림은 `IMAGE_ICONS_PER_ROW` 4개 + `+N`)
 *   - **`외 N명` 같은 생략 안내는 쓰지 않는다** — 생략하는 것이 없으니 할 말도 없다.
 *     (안내 문구는 "접었다"는 사실의 보상이다. 접지 않으면 그 문구는 거짓이 된다.)
 *   - 보스 **이름 글자를 늘어놓지 않는다.** 전에는 아이콘 옆에 `하카` 같은 줄임말을
 *     붙였는데, 캐릭터당 12~13개가 되자 **글자가 아이콘을 밀어내** 한 줄에 서너 개밖에
 *     못 섰다. 이름은 `title` 과 스크린리더용 `sr-only` 로 내려가고, 보이는 것은 얼굴이다.
 * ⚠️ 세로로 길어지는 것은 **받아들인 비용**이다. 여기는 스크롤하는 화면이고, 접지 않는 것이
 *    이 화면의 존재 이유다. 길이를 줄이려고 다시 접기 시작하면 그림과 같은 화면이 된다.
 *
 * ★ **데이터는 그림과 같은 모집단이다** — `fetchRemainingBosses`(자르지 않은 전부)를
 *   `buildHomeworkCardViewFromRemaining` 으로 묶는다. 조회는 **한 번**이고 새로 만들지
 *   않는다. 평문용 `buildHomeworkCard` 를 쓰면 금액 문턱과 상위 15건으로 잘린 목록이
 *   들어오는데, 그게 2026-10-08 에 그림에서 터진 결함이다(그 함수 머리말).
 *
 * ⚠️ **토큰 검증 외에는 아무것도 흘리지 않는다.** 위조·만료는 둘 다 `notFound()` 이고
 *    (구분해 알려 주면 토큰을 훑을 수 있다), 담기는 정보는 `fetchRemainingBosses` 가
 *    토큰 주인의 추적 캐릭터에 대해 돌려주는 "남은 보스"뿐이다. 세션은 읽지 않는다 —
 *    읽으면 "내 계정으로 보는 화면"이 되어 로그인 여부에 따라 내용이 달라지고, 그건
 *    공유 링크가 아니다.
 *
 * ⚠️⚠️ **넥슨 출처 표기(`Data based on NEXON Open API`)는 이 화면에만 남아 있다.**
 *    2026-10-07 발주 지시로 카드 그림에서 지웠기 때문에(`card.png/route.tsx` 머리말
 *    *"없앤 것 1"*), §1.1 의 의무가 **여기 한 곳**에 걸려 있다. 아래 `<footer>` 의 그 줄을
 *    지우면 의무가 통째로 사라진다 — **지우지 말 것.**
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

  /*
    자르지 않은 **전부**를 받아 그대로 묶는다(위 ★ 역할 분담). 그림(`card.png`)이 부르는
    것과 **같은 함수 · 같은 인자**라 두 화면이 다른 숫자를 말할 수 없다.
  */
  const remaining = await fetchRemainingBosses(getAdminDb(), claim.userId, {
    scope: claim.scope,
  });
  const view = buildHomeworkCardViewFromRemaining(remaining, claim.scope, now);

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
        {/*
          ★ **꼬리말(`view.notes`)을 그리던 자리다 — 지웠다**(2026-10-08).
            그 문구들(`…외 N건` · `2억 이하 결정석 N건`)은 **평문의 자르기를 설명하는 말**인데
            이 화면은 아무것도 자르지 않으므로 할 말이 없다. 실제로도 이 경로의 `notes` 는
            늘 빈 배열이다(`buildHomeworkCardViewFromRemaining`) — 조건문만 남겨 두면
            "언젠가 뭔가 뜬다"는 착각을 남기는 죽은 분기가 된다.
        */}
      </section>

      {view.rows.length === 0 ? (
        /*
          빈 상태다. **오류가 아니다** — 다 돌았거나, 남은 것이 전부 금액 문턱 아래거나,
          계획이 아직 없다. 셋 중 어느 것인지는 위 요약 줄과 꼬리말이 이미 말한다.
        */
        <p className="rounded-lg border border-border bg-surface p-5 text-body-sm text-ink-muted">
          남은 보스가 없습니다.
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

/** 상세 한 줄이 늘 차지하는 세로(14px 글자 + 위아래 여백). 비워 두는 자리와 **같은 값**이다. */
const DETAIL_ROW_CLASS = "h-9";

/**
 * 캐릭터 한 묶음 — **이름 · 남은 금액 / 얼굴 전부 / 상세 한 줄.**
 *
 * ★ **가로로 나란히 두던 것을 세로로 쌓았다**(2026-10-08). 접기를 그만두면서 한 캐릭터의
 *   얼굴이 **12~13개**가 됐고, 그 수를 오른쪽 절반에 밀어 넣으면 폰에서는 두세 개씩 끊겨
 *   흐른다. 쌓으면 얼굴이 **줄 너비를 통째로** 쓴다 — *"이미지 크게"* 다.
 * ★ **보스 이름 글자를 뺐다.** 얼굴 하나당 폭을 두 배로 먹고 있었다. 이름은 아래 상세 줄과
 *   버튼의 접근명(`aria-label`)으로 내려간다 — **보는 사람에게서 뺀 것이지 없앤 것이 아니다.**
 * ★ 금액을 primary 로 크게 둔 이유는 이 화면이 답하는 질문이 *"얼마 남았나"* 라서다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **상세는 얼굴을 덮지 않는다 — 자리를 상시로 비워 둔다** (측정으로 뒤집힘, 2026-10-08)
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 지시(2026-10-08): *"들어가서 마우스에 호버 하면 몇인인지 각 얼마인지 상세정보 뜨게도"*.
 *
 * ⚠️⚠️ **틀린 근거와 그 시체 — 지우지 않고 남긴다.** 처음 구현에는 이렇게 적혀 있었다:
 *   ~~대신 바닥 얼굴 한 줄을 잠깐 덮는다. 떠 있는 동안만이고, 안 덮으려면 묶음마다 빈 줄을
 *     상시로 비워 둬야 하는데 그 값이 더 비싸다.~~
 *   **측정이 뒤집었다**(교차 검증, 2026-10-08):
 *     · 폭 1024px — 얼굴 12개가 한 줄에 다 서므로 바닥에 띄운 상세가 **곧 그 줄**이다.
 *       95개 전부 `covers: true`, `상세.top − 얼굴.bottom = −33px` → 64px 아이콘의 **아래
 *       52%**가 가려졌다. **호버 중인 바로 그 얼굴까지** 가렸다.
 *     · 폭 360px — 상세가 두 줄로 접히며 가림이 15 → **31개**로 늘었다.
 *   즉 *"잠깐"* 도 *"바닥 한 줄"* 도 아니었고, 이 화면의 목표(*"이미지 크게"*)를 호버할
 *   때마다 되돌리고 있었다. **비싼 쪽은 반대였다** — 36px 을 상시로 비워 두는 값이
 *   64px 아이콘의 절반을 가리는 값보다 싸다.
 *
 * **지금의 구조**: 묶음의 마지막 칸이 `DETAIL_ROW_CLASS` 높이의 **빈 줄**이고(기본값으로
 * 남은 건수를 적어 둔다), 상세는 `absolute` 로 **정확히 그 칸 위에** 겹친다. 얼굴 위가
 * 아니다. 그래서 어느 폭에서도 가림이 **0** 이다.
 *   - 상세는 **한 줄로 고정**한다(`truncate`). 접히면 높이가 변해 비워 둔 칸을 넘치고,
 *     그 순간 다시 얼굴을 덮는다 — 폭 360px 에서 실제로 그랬다.
 *   - 좌우는 `inset-x-4` 로 묶음 안쪽에 못박혀 있다. 트리거가 맨 오른쪽이든 자리가 같으므로
 *     **화면 밖으로 나갈 수가 없다**(구조적으로).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ **트리거는 `<button>` 이다 — iOS 의 호버 추측에 기대지 않기 위해서**
 * ─────────────────────────────────────────────────────────────────────────────
 * 전에는 `<span tabIndex={0}>` 이었다. 안드로이드 크롬은 탭에서 떴지만 **WebKit 이 탭에
 * `:hover` 를 붙이는 조건은 "그 요소가 클릭 가능한가"**(클릭 핸들러 또는 `cursor: pointer`)
 * 이고, 그 `<span>` 은 둘 다 없었다(`cursor: auto` 로 측정됨). 즉 `group-hover` 와
 * `group-focus` 두 경로가 **동시에** 막힐 수 있었다.
 * ★ `<button type="button">` 은 **네이티브로 클릭 가능**하고 탭에서 포커스를 받는다. 두
 *   조건을 다 만족하므로 WebKit 도 `:hover` 를 붙이고, 설령 붙이지 않아도 `:focus` 가
 *   남는다 — **두 경로가 함께 죽지 않는다**는 것이 바꾼 이유다. `cursor-pointer` 는
 *   그 판정을 눈으로도 말해 준다(발견 가능성, 아래 ★).
 * ⚠️ **실제 iOS 기기에서는 실측하지 못했다.** 여기 적은 것은 WebKit 의 공개된 조건과
 *    `<button>` 이 그 조건을 만족한다는 사실이지, *"iPhone 에서 뜨는 것을 봤다"* 가 아니다.
 *    기기가 생기면 가장 먼저 볼 것.
 * ★ **표시를 켜는 것은 `group-focus` 이지 `group-focus-visible` 이 아니다.** 손가락 탭은
 *   `:focus-visible` 을 띄우지 않는 브라우저가 많다 — 그걸로 걸면 탭에서 아무것도 안 뜬다.
 *   테두리 아웃라인만 `focus-visible` 로 두어 마우스 클릭에 굵은 테를 안 남긴다.
 *
 * ★ **어느 얼굴 얘기인지 얼굴이 직접 말한다**(2026-10-08). 상세 줄은 늘 같은 자리에 뜨므로,
 *   폭 400px 에서 얼굴이 5/5/2 로 흐르면 첫 줄 얼굴을 올렸을 때 글자가 **95px 아래**에
 *   찍혔다. 얼굴 12개가 다 비슷한 작은 그림이라 지시 대상이 사라진다.
 *   → 올린 얼굴에 **primary 링**을 둘러 그 줄의 주인을 눈으로 잇는다(§4 — 토큰 색).
 * ★ **발견 가능성**: `cursor-pointer` + 기본 안내 문구(*"얼굴을 누르면 상세"*). 전에는
 *   얼굴 95개 중 어느 것도 "올리면 뭔가 뜬다"고 말하지 않았다.
 * ★ **`title` 을 뺐다.** 데스크톱에서 1초 머물면 네이티브 툴팁과 아래 상세 줄이 **같은
 *   문장을 동시에** 띄웠다. 보조기기 몫은 `aria-label` 이 이미 진다.
 *
 * ⚠️ **`components/ui/tooltip.tsx` 를 쓰지 않은 근거 — 버티는 것만 남긴다**(2026-10-08).
 *    한때 *"`<span>` 은 포커스를 받지 못한다"* 를 근거로 적었는데, **바로 아래 코드가 그
 *    `<span>` 에 `tabIndex` 를 붙여 포커스를 받게 만들고 있었다** — 같은 수단을 그 툴팁의
 *    트리거에도 붙일 수 있으므로 성립하지 않는 근거였다. 지운다. 남는 것:
 *    ① **폭 400px 에서 넘친다** — `left-1/2 -translate-x-1/2 w-max` 로 트리거 가운데에
 *       붙고 **충돌 회피가 없다.** 한 줄에 다섯 개가 서는 폰에서 맨 오른쪽 얼굴이 화면 밖.
 *    ② **트리거 위에 겹친다** — 이번에 측정으로 걷어낸 바로 그 문제(위 ⚠️⚠️)를 다시 만든다.
 *    ③ 본문이 `text-caption`(12px)이다. 이 화면의 바닥선은 14px.
 *    ④ `"use client"` 라 얼굴 하나하나가 클라이언트 경계가 된다 — 95개면 95개.
 *    이 화면은 **서버 컴포넌트로 남는다**: 아래 어디에도 상태도 이벤트 핸들러도 없고,
 *    여닫는 일은 전부 CSS(`group-hover` / `group-focus`)가 한다.
 *
 * ⚠️ **탭 정지점 95개는 알고 남긴 비용이다.** 바닥글 링크까지 Tab 을 95번 더 눌러야 한다.
 *    그래도 없애지 않는 이유: 포커스를 걷으면 **손가락 사용자가 상세에 닿을 길이 사라진다**
 *    (위 WebKit 문단) — 발주 제약이 금지한 그것이다. 대신 둘을 고쳤다.
 *    · 전부 `role: generic` · `name: ""` 이던 것에 **`aria-label` 로 이름을 줬다.**
 *    · 같은 문장을 `sr-only` 로 또 두던 것을 **없앴다** — 이름이 생겼으므로 두 번 읽힌다.
 *    스크린리더 사용자는 애초에 Tab 이 아니라 읽기로 지나가므로 95번을 누르지 않는다.
 *
 * ⚠️ 금액은 **1인당 수령액**(`shareMeso`)이지 솔로가가 아니다. 인원수도 그 금액을 실제로
 *    나눈 수 그대로다(`RemainingBoss.defaultPartySize` — `null` 접기는 조회 쪽에서 끝났다).
 *    여기서 다시 나누거나 `?? 1` 하지 말 것.
 * ★ 왼쪽 보더로 구분을 짊어진다(§4). 아이콘 테두리 색은 난이도다 — `BossIcon` 의 규약.
 */
function ShareCharacterRow({ row }: { readonly row: HomeworkCardView["rows"][number] }) {
  return (
    <li className="relative flex flex-col gap-3 rounded-lg border border-border border-l-4 border-l-primary bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <span className="font-headline text-subhead text-ink">
          {row.characterName}
        </span>
        <span className="font-headline text-subhead text-primary">
          {row.mesoLabel}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {row.bosses.map((boss, index) => {
          /*
            한 문장을 **한 번만** 만든다. 보이는 상세와 접근명이 같은 변수를 쓰므로 둘이
            다른 말을 할 수가 없다.
          */
          const detail = `${boss.isSeason ? `${boss.koreanName} (시즌)` : boss.koreanName} · ${String(boss.partySize)}인 · 1인당 ${formatMesoCompact(boss.shareMeso)}`;
          return (
            <button
              /*
                ⚠️ 키에 **순번을 섞는다.** 이 목록은 더는 자르지 않아 캐릭터당 12~13개가
                   들어온다 — id 하나로 잡다가 중복이 생기면 React 가 조용히 한 칸을 덮어쓴다.
              */
              key={`${boss.bossDifficultyId}-${String(index)}`}
              type="button"
              /*
                `relative` 는 **주지 않는다** — 주는 순간 아래 상세가 이 버튼에 붙어
                화면 밖으로 나가고, 얼굴 위에 겹친다(위 ★ 두 문단).
              */
              className="group inline-flex cursor-pointer rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
              aria-label={detail}
            >
              <BossIcon
                bossDifficultyId={boss.bossDifficultyId}
                difficulty={boss.difficulty}
                size="lg"
                /*
                  `lg`(48px)를 `cn`(tailwind-merge)이 덮어 **56 / 64px** 로 키운다. 받아 오는
                  해상도는 그대로다 — `SOURCE_HINT_PX` 가 96px 이라 64px 자리까지 모자라지 않는다.
                  링은 올린 얼굴과 아래 상세 줄을 잇는 **유일한 표시**다.
                */
                className="size-14 ring-offset-surface group-hover:ring-2 group-hover:ring-primary group-hover:ring-offset-2 group-focus:ring-2 group-focus:ring-primary group-focus:ring-offset-2 sm:size-16"
              />
              {/*
                상세 한 줄. 자리는 아래 빈 칸이 **상시로** 잡아 두므로 이 겹침은 얼굴에
                닿지 않는다. 한 줄 고정(`truncate`)이라 높이도 변하지 않는다.
                색은 툴팁과 같은 토큰 쌍(`bg-ink` / `text-neutral-50`) — 라이트·다크 양쪽에서
                이미 검증된 조합이다. 글자는 **14px**(`text-body-sm`), 이 화면의 바닥선이다.
              */}
              <span
                aria-hidden
                className={cn(
                  "pointer-events-none absolute inset-x-4 bottom-4 z-10 hidden items-center",
                  DETAIL_ROW_CLASS,
                  "rounded-md bg-ink px-3 text-body-sm text-neutral-50 shadow-overlay",
                  "group-hover:flex group-focus:flex",
                )}
              >
                <span className="truncate">{detail}</span>
              </span>
            </button>
          );
        })}
      </div>

      {/*
        ★ **상세가 들어설 자리 — 늘 비워 둔다.** 이 칸이 없으면 위 `absolute` 상세가 얼굴
          위로 올라앉는다(머리말의 ⚠️⚠️ 측정). 기본값으로 남은 건수를 적어 두어 빈 띠가
          아니게 하고, 동시에 *"누르면 상세가 뜬다"* 를 말한다(발견 가능성).
          넘치면 `truncate` — 폭 360px 에서도 높이가 변하지 않아야 한다.
      */}
      <p
        className={cn(
          "flex items-center truncate px-3 text-body-sm text-ink-muted",
          DETAIL_ROW_CLASS,
        )}
      >
        {`${row.countLabel} 남음 · 얼굴을 누르면 상세`}
      </p>
    </li>
  );
}
