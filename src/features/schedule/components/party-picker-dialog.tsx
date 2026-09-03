"use client";

import { useQueryClient } from "@tanstack/react-query";
import { Check, Settings2, UserRound, UsersRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button, Dialog, EmptyState } from "@/components/ui";
import { characterFirstName } from "@/lib/domain/participant-label";
import { queryKeys } from "@/lib/query-keys";
import { cn } from "@/lib/utils";
import type { Party, PartyId, PartyMemberBrief } from "@/types/domain";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 파티 고르기 — **드롭다운에서 모달로** (발주 지시 2026-09-02)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 원문: *"파티 선택을 모달로 변경해서 캐릭터도 좀 보이게 해줘. 가시성이 너무 구린거같기도 해"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `<select>` 가 여기서 진 이유
 * ─────────────────────────────────────────────────────────────────────────────
 * 어제 선택지에 파티원을 실었더니(`세쌀카2인523 — 더저(무르겨르), 라온내일`) 이름만
 * 보이던 문제는 풀렸지만 새 문제가 생겼다. `<option>` 은 **글자 한 줄**만 담는다:
 *
 * · 파티 이름과 파티원이 같은 굵기·같은 색으로 한 줄에 이어 붙는다. 무엇이 이름이고
 *   무엇이 사람인지 **글자 모양으로는 구분되지 않는다.**
 * · 닫힌 상태에서 브라우저가 잘라 버린다. 정작 구분에 쓰이는 뒷부분(파티원)이 먼저 잘린다.
 * · 글자 크기·줄 간격을 우리가 정할 수 없다. 열 줄이 넘으면 그냥 빽빽한 문단이다.
 *
 * 모달은 그 셋을 전부 해결한다 — **두 줄**을 쓸 수 있어 이름은 굵게, 파티원은 아래
 * 작은 글씨로 갈라 놓고, 폭이 넉넉해 잘리지 않으며, 현재 선택에 체크를 붙일 수 있다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 캐릭터를 **앞세워** 적는다 (2026-09-02: *"캐릭터 실제로 보여주고싶은데"*)
 * ─────────────────────────────────────────────────────────────────────────────
 * 처음에는 `participantLabel` 이 만든 `더저(무르겨르)` 를 그대로 썼는데, 그 규칙은
 * **사람이 주인공**이라 본캐로 참여하면 괄호를 붙이지 않는다(`더저(더저)` 는 소음이니까).
 * 그래서 절반의 사람은 캐릭터가 화면에 아예 나오지 않았다.
 *
 * 여기서 알고 싶은 것은 "이 파티에 **어느 캐릭이** 들어가 있나"이므로 순서를 뒤집는다 —
 * `무르겨르 더저` 처럼 **캐릭터가 앞, 계정이 뒤**이고 둘이 같으면 한 번만 적는다.
 * 판정은 `lib/domain/participant-label.ts` 의 `characterFirstName` 하나가 소유한다.
 * 캐릭터를 안 고른 사람은 **본캐가 그 캐릭터**다(§2.1) — "미정" 같은 꼬리표를 덧대지
 * 않고, 본캐 행에서 사진·레벨까지 끌어온다(`schedule-repo.loadMainCharacters`).
 *
 * ⚠️ **번호(`member_no`)는 적지 않는다.** 방에서 `1번` 이라 부르는 그 번호는 빈자리를
 *    재사용하지 않으므로(§1.4) 목록 순서와 어긋날 수 있고, 여기서 순번을 새로 매기면
 *    화면이 방과 다른 번호를 말하게 된다. 고르는 데 필요한 것은 이름이지 번호가 아니다.
 */

/**
 * 구성원 하나 = **네모 초상화 한 칸** + 그 아래 이름.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 칩에서 **타일로** (발주 지시 2026-09-02: *"너무 작잖아... 직업 없애고 그냥 네모네모
 * 하게 해 진짜 너무 작아"*)
 * ─────────────────────────────────────────────────────────────────────────────
 * 처음에는 한 줄짜리 칩 안에 24px 그림을 끼워 넣었다. 얼굴을 보여 주려고 넣은 그림이
 * 24px 이면 **무엇을 넣었는지 알아볼 수가 없다** — 그 크기에서 캐릭터는 색깔 점이다.
 * 게다가 직업까지 같은 줄에 서면서 한 사람이 `[▪ 쌍욱 Lv.285 칼리 죠린]` 이 됐고,
 * 실제로 읽히는 것은 그중 아무것도 아니었다.
 *
 * ★ 그림을 **96px 정사각**으로 키우고 이름을 아래로 내린다. 가로로 나열하던 것을
 *   칸으로 만들면 사람 수만큼 폭을 먹는 대신 얼굴이 실제로 보인다.
 *   (24 → 64 → **96px**. 두 번 더 키웠다 — *"이래도 너무 작다. 캐릭터 크기두배"*.)
 * ★ **직업을 뺐다.** 파티를 고를 때 필요한 것은 "누가 있나"이고, 직업은 그 판단에
 *   쓰이지 않으면서 줄에서 가장 긴 글자였다. 레벨은 두 글자라 남긴다.
 * ★ **그림이 없어도 네모는 그린다.** 칩일 때는 빈 네모가 높이를 흔들어 뺐지만, 타일은
 *   칸이 이미 정사각이라 비어 있어도 줄이 흔들리지 않는다 — 오히려 빈 칸이 "이 사람은
 *   아직 사진이 없다"를 말해 준다(게스트가 그렇다).
 * ★ **실패한 URL 자체를 담는다**(`CharacterCard` 와 같은 기법). 불리언이면 새 URL 이
 *   들어올 때 effect 로 초기화해야 하는데, 그건 이벤트가 아니라 프롭 변화를 쫓는 동기화라
 *   렌더 연쇄를 만든다. URL 을 담아 두면 비교 한 번으로 초기화가 저절로 된다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 다시 **줄인다** — 한 줄에 여섯 (발주 지시 2026-09-03)
 * ─────────────────────────────────────────────────────────────────────────────
 * 원문: *"캐릭터가 들어가는 네모 자체를 줄여서 6개가 한줄에 들어갈만하게 바꿔줘"*
 *
 * 96px 은 얼굴이 확실히 보였지만 카드 안쪽 폭(모달이 2열 배치라 대략 430~460px)에
 * **4개**밖에 앉지 못했다. 5명 이상인 파티는 타일이 두 줄로 접히고, 그러면 옆 카드와
 * 높이가 어긋나 목록을 훑는 눈이 매번 걸린다. 보스 파티의 상한은 대개 6인이므로(§1)
 * **한 줄이 곧 한 파티**가 되는 폭이 이 화면에 맞는 폭이다.
 *
 * ★ 고정 px 폭을 버리고 **열 개수를 고정**한다. `w-24` 같은 고정폭으로 6개를 맞추면
 *   카드 폭이 조금만 달라져도 5개나 7개가 되지만, `grid-cols-6` 은 폭이 얼마든 언제나
 *   여섯이다. 칸은 `aspect-square w-full` 이라 크기가 **열 폭을 따라간다**
 *   (2열 배치에서 대략 66px). 즉 96 → 열 폭이지, 새 고정 숫자를 박은 것이 아니다.
 * ★ **배율 2.2 는 그대로 둔다.** 배율은 잘려 나가는 비율을 정하는 값이지 크기가 아니라서
 *   칸이 작아져도 구도는 같다. 여기서 더 올리면 머리와 발이 잘린다(위 근거 그대로).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 레벨을 치우고 그 자리에 **본캐 닉네임**을 적는다 (발주 지시 2026-09-03)
 * ─────────────────────────────────────────────────────────────────────────────
 * 원문: *"레벨 치우고 밑에 본캐닉네임 써"*
 *
 * 직업을 뺄 때 "레벨은 두 글자라 남긴다"고 했는데, 그 두 글자가 파티를 고르는 판단에
 * 쓰이지 않는다는 것이 남은 문제였다. 여기서 헷갈리는 것은 **"이 캐릭이 누구 캐릭이냐"**
 * 다 — 이름이 서로 비슷한 파티가 여럿이고(`발벨3인` 이 둘), 부캐로 들어간 사람은
 * 캐릭터 이름만 봐서는 아는 사람인지 알 수가 없다. 레벨은 그 물음에 아무 답도 하지 않고,
 * 본캐 닉네임은 그 물음 자체다.
 *
 * ★ **적는 값은 `characterFirstName(member).account` 다.** §2.1 에 따라 정식 사용자의
 *   `displayName` 이 곧 본캐 닉네임이고, 그 판정은 이미 이 파일이 쓰고 있는
 *   `characterFirstName` 하나가 소유한다. 새 필드도 새 판정도 만들지 않는다.
 * ★ **`account` 가 `null` 이면 줄 자체를 그리지 않는다.** `null` 은 "데려가는 캐릭터가
 *   곧 본캐"라는 뜻이므로 여기서 그리면 위아래로 같은 이름이 두 번 선다 — 이 파일이
 *   맨 위에서 이미 배제한 `더저(더저)` 소음과 정확히 같은 것이다.
 * ★ **위계를 눈에 보이게 둔다** — 위가 캐릭터(12px `text-caption` · `font-medium` ·
 *   `ink-label`), 아래가 본캐(11px `text-overline` · `ink-muted`). 짧은 라벨이라
 *   §4 의 "문장은 14px 아래로 내리지 않는다" 규칙에 걸리지 않지만, **색은
 *   `ink-placeholder` 를 쓰지 않는다** — 읽으라고 넣은 글자다.
 *   대비(이 타일이 실제로 앉는 세 면 전부, 최악값 기준):
 *     라이트 `ink-muted #62616a` → surface 6.11 · hover-surface 5.56 ·
 *              primary-subtle(선택된 카드) **5.46**
 *     다크   `ink-muted #b8b8c4` → surface 9.01 · hover-surface 7.96 ·
 *              primary-subtle **8.00** · primary-subtle-hover **7.13**
 *   → 두 테마 모두 AA(4.5:1) 통과. 토큰 표가 아니라 **글자가 실제로 앉는 면**으로
 *     계산했다(§4 가독성 규칙).
 * ★ `tabular-nums` 는 따라오지 않는다. 그건 `Lv.285` 의 자릿수를 맞추려던 값이고
 *   닉네임은 숫자가 아니다.
 * ★ 좁은 칸(2열 배치에서 열 폭 대략 66px)에서 긴 닉네임이 칸을 밀어내지 않도록
 *   캐릭터 이름 줄과 똑같이 `w-full truncate` 다. 잘린 전체 이름은 `title` 에서 본다.
 * ★ **`PartyMemberBrief.characterLevel` 은 지우지 않았다.** 여기서 그리지 않을 뿐이고,
 *   도메인 타입과 서버 조회 경로가 그 값을 계속 들고 있다(렌더 지점은 이 타일이
 *   유일했다 — `grep -rn "characterLevel" src/ --include=*.tsx`).
 */
function MemberTile({ member }: { readonly member: PartyMemberBrief }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const name = characterFirstName(member);
  const showImage =
    member.characterImageUrl !== null &&
    failedUrl !== member.characterImageUrl;

  return (
    <span
      /*
        `title` 에 계정까지 넣는다. 타일 아래에는 캐릭터 이름만 서므로, 부캐로 들어간
        사람이 누구인지는 여기서 확인한다 — 두 줄을 쓰면 타일 높이가 사람마다 달라진다.

        ★ 2026-09-03: 계정(본캐 닉네임)이 타일 아래 둘째 줄로도 나오게 됐지만 이 `title`
          은 **그대로 둔다.** 열 폭이 대략 66px 이라 그 줄은 거의 항상 `truncate` 되고,
          잘린 전체 이름을 확인할 곳이 여기 말고는 없다.
      */
      title={
        name.account === null ? name.lead : `${name.lead} · ${name.account}`
      }
      /*
        `w-full` — 폭은 이제 그리드 열이 정한다(고정 `w-24` 였다면 열이 6개여도 타일이
        열 폭을 넘겨 삐져나간다). `min-w-0` 이 없으면 그리드/플렉스 자식의 기본
        `min-width: auto` 때문에 아래 이름 줄의 `truncate` 가 잘리는 대신 칸을 밀어낸다.
      */
      className="flex w-full min-w-0 flex-col items-center gap-1"
    >
      <span className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-md border border-border bg-neutral-100">
        {showImage && member.characterImageUrl !== null ? (
          // eslint-disable-next-line @next/next/no-img-element -- 넥슨 CDN 이라 도메인 등록이 필요하고, 어차피 한 변 70px 남짓이라 최적화 이득이 없다.
          <img
            src={member.characterImageUrl}
            alt=""
            /*
              실제 렌더 폭은 이제 열 폭(2열 배치에서 대략 66px)이라 고정 96 은 거짓말이
              됐다. 종횡비 힌트로만 쓰이는 값이므로 실측에 가까운 64 로 맞춘다.
            */
            width={64}
            height={64}
            loading="lazy"
            /*
              ★ **칸 안에서 확대해 여백을 잘라낸다.** 넥슨 초상화는 캔버스 가장자리에
                투명 여백이 넓게 들어 있어서, `object-contain` 으로 캔버스 전체를 맞추면
                정작 캐릭터는 칸의 절반도 차지하지 못한다.
                박스 크기는 그대로라 타일 격자가 흔들리지 않는다(부모가 `overflow-hidden`).
              ★ 배율은 두 번 올랐다 — 1.7 → **2.2**(2026-09-02: *"네모 박스는 좋은데 안에
                캐릭터 크기 지금보다 1.7배는 키워야함"* → *"이래도 너무 작다. 캐릭터
                크기두배"*). 칸도 64 → 96px 이라 화면에 그려지는 캐릭터는 처음의 약 **2배**다
                (64×1.7 → 96×2.2). 여기서 더 키우면 머리와 발이 잘려 나가기 시작한다 —
                보이는 것은 캔버스의 가운데 `96/(96×2.2) ≈ 45%` 뿐이다.
              ★ 2026-09-03 에 칸이 96px → 열 폭(대략 66px)으로 줄었지만 **배율은 손대지
                않았다.** 잘려 나가는 비율 `1/2.2 ≈ 45%` 는 칸 크기와 무관해서, 칸만 줄면
                구도는 그대로인 채 그림만 작아진다.
              ★ 2026-09-03(2차) 배율 2.2 → **5**. 발주: *"이상태로 두배 이상 확대해서
                얼굴과 목 조금? 만 나오게 확대가능?"* — 칸 크기도 열 수도 그대로 두고
                배율만 올린 순수한 크롭 변경이다. 근거는 넥슨 `/character/basic` 의
                `character_image` 4장(Lv.5 · Lv.285 · Lv.289 · Lv.295)을 실제로 받아
                알파 채널을 행 단위로 계측한 값이다:
                - 캔버스는 **300×300** 인데 캐릭터가 그려진 영역은 **y≈129~208,
                  x≈108~184** 뿐이고 나머지는 전부 투명 여백이다.
                - 머리 띠는 **y≈129~174**, 그 세로 중심이 **y≈151** 로 캔버스 중심 150 과
                  사실상 같다. → **`transform-origin` 을 건드릴 필요가 없다.** 머리가 이미
                  캔버스 정중앙에 오므로 기본값(중앙)에서 배율만 올리면 얼굴이 그대로
                  가운데에 온다. origin 을 옮기면 오히려 캐릭터가 한쪽으로 밀린다.
                - 머리 높이는 약 45px = 캔버스의 **15%**. 배율 2.2 는 가운데
                  `300/2.2 ≈ 136px` 를 보여주므로 머리가 칸의 33% 밖에 안 됐다 — 그래서
                  칸을 96px 로 키운 뒤에도 얼굴이 계속 작아 보였다.
                - 배율 **5** 는 가운데 **60px**(y 120~180)만 보여준다. 머리 띠 129~174 가
                  통째로 들어오고 위로 9px 여백, 아래 6px 이 목·어깨다. 발주가 말한
                  **얼굴 + 목 조금**이 정확히 이 배율이다.
              ★ **5 가 상한이다.** 후보 2.2 / 4.4 / 5.0 / 5.6 을 실제로 잘라 눈으로
                비교했고, 4.4 는 아직 어깨까지 나오고 5.6 은 머리카락 옆이 과하게 잘렸다.
                머리 띠의 가로폭이 최대 72px 인데 배율 5 의 가시 창은 60px 이라 바깥쪽
                머리카락은 이미 살짝 잘린다 — 얼굴 크롭에서는 정상이지만, 5 를 넘기면
                그 잘림이 눈에 띄기 시작한다.
            */
            className="size-full scale-[5] object-contain"
            onError={() => setFailedUrl(member.characterImageUrl)}
          />
        ) : (
          <UserRound aria-hidden size={24} className="text-ink-placeholder" />
        )}
      </span>
      <span className="w-full truncate text-center text-caption font-medium text-ink-label">
        {name.lead}
      </span>
      {/*
        본캐 닉네임. `account === null` 이면 데려가는 캐릭터가 곧 본캐라는 뜻이라
        그리지 않는다 — 같은 이름을 위아래로 두 번 적는 `더저(더저)` 소음이 된다.
      */}
      {name.account === null ? null : (
        <span className="w-full truncate text-center text-overline text-ink-muted">
          {name.account}
        </span>
      )}
    </span>
  );
}

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 실루엣 메우기 — **모달을 열 때 한 번, 조용히**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주(2026-09-03): *"내 api 로 파티원들의 이미지를 가져오는식으로"*.
 *
 * 게스트는 우리 DB 에 `characters` 행도 ocid 도 없어서 얼굴 자리가 계속 비어 있었다.
 * `POST /api/characters/looks` 가 **이름만으로** 넥슨에서 생김새를 받아
 * `character_looks` 에 적고, 다음 파티 조회가 그 캐시를 읽어 그림을 채운다
 * (`schedule-repo.withCachedLooks`).
 *
 * ★ **서버 렌더가 아니라 여기서 부른다.** 이름 하나에 넥슨 2콜 + 250ms 간격이라
 *   렌더 경로에 넣으면 파티 고르기를 여는 데 초 단위가 걸린다. 읽기는 DB 조회뿐이고,
 *   채우기는 사람이 모달을 연 이 순간에만 일어난다.
 * ★ 끝나면 **파티 목록 쿼리를 무효화**한다. 화면 데이터의 주인은 쿼리 캐시이므로
 *   (§2.4 규칙 1) 여기서 `router.refresh()` 를 부르지 않는다(규칙 3).
 *   키는 `queryKeys.db.party.list()` — 이 모달에 `parties` 를 내려 주는
 *   `ScheduleWorkspace.partiesQuery` 가 쓰는 **바로 그 키**다. 접두사가 비슷하다고
 *   덮인다고 가정하지 않는다(§2.4 경고 — `party.mine` 은 형제이지 조상이 아니다).
 * ★ **이미 시도한 이름은 다시 부르지 않는다.** 넥슨에 그런 이름이 없으면 응답 후에도
 *   초상화는 계속 `null` 이라, 시도 기록이 없으면 모달을 열 때마다 같은 2콜이 영원히
 *   나간다(서버 쪽 음성 캐시가 있어도 우리 왕복은 반복된다).
 * ★ **실패해도 아무 일도 일어나지 않는다.** 실루엣은 오류가 아니라 정상 상태이고
 *   (§2.1.1) 파티를 고르는 일과는 무관하다 — 토스트도, 로딩 표시도 띄우지 않는다.
 */
/** 한 번에 물어보는 최대 이름 수. 라우트의 상한과 같은 값이다. */
const LOOKUP_BATCH_LIMIT = 20;

/** `character_looks.character_name` 의 CHECK(1~40자)와 같은 값. */
const LOOKUP_NAME_MAX_LENGTH = 40;

function useGuestLookBackfill(
  open: boolean,
  parties: readonly Party[],
): void {
  const queryClient = useQueryClient();
  /*
    시도한 이름. 모달을 닫았다 열어도 살아 있어야 하므로 ref 다 — state 로 두면 값이
    바뀔 때마다 다시 그려지는데, 이 값은 화면에 한 글자도 나오지 않는다.
  */
  const attempted = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;

    const names: string[] = [];
    for (const party of parties) {
      for (const member of party.members) {
        // 이미 얼굴이 있는 사람은 물을 이유가 없다.
        if (member.characterImageUrl !== null) continue;
        const name = (member.characterName ?? member.displayName).trim();
        if (name === "" || name.length > LOOKUP_NAME_MAX_LENGTH) continue;
        if (attempted.current.has(name)) continue;
        attempted.current.add(name);
        names.push(name);
        if (names.length >= LOOKUP_BATCH_LIMIT) break;
      }
      if (names.length >= LOOKUP_BATCH_LIMIT) break;
    }
    if (names.length === 0) return;

    /*
      무효화가 `parties` 를 새 배열로 갈아 끼워 이 effect 가 다시 돈다. 그때 남은
      이름은 전부 `attempted` 에 있으므로 위 반복이 빈 배열을 만들고 여기서 끝난다 —
      되먹임 고리가 생기지 않는다.
    */
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/characters/looks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ names }),
        });
        if (cancelled || !response.ok) return;
        await queryClient.invalidateQueries({
          queryKey: queryKeys.db.party.list(),
        });
      } catch {
        // 조용히 넘어간다. 실루엣은 정상 상태다(§2.1.1).
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, parties, queryClient]);
}

export interface PartyPickerDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly parties: readonly Party[];
  readonly selectedPartyId: PartyId | null;
  readonly onSelect: (partyId: PartyId) => void;
}

export function PartyPickerDialog({
  open,
  onClose,
  parties,
  selectedPartyId,
  onSelect,
}: PartyPickerDialogProps) {
  // 얼굴이 빈 파티원을 조용히 메운다. 화면 모양에는 아무 영향이 없다(위 머리말).
  useGuestLookBackfill(open, parties);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="파티 고르기"
      description="고른 파티의 가능 시간이 겹쳐서 보이고, 일정도 그 파티에 잡힙니다."
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-body-sm text-ink-muted tabular-nums">
            파티 {parties.length}개
          </p>
          {/*
            만들기·고치기는 여기서 하지 않는다(§1.1.1 — 이 화면은 "언제"만 묻는다).
            그래도 **어디서 하는지**는 말해 줘야 막다른 길이 되지 않는다.
          */}
          <Link href="/parties">
            <Button variant="ghost" size="sm">
              <Settings2 aria-hidden size={16} />
              파티 관리
            </Button>
          </Link>
        </div>
      }
    >
      {parties.length === 0 ? (
        <EmptyState
          icon={<UsersRound size={24} />}
          title="아직 파티가 없습니다"
          description="파티를 만들면 각자의 가능 시간이 겹쳐서 보입니다."
          className="py-8"
        />
      ) : (
        /*
          ── **두 열** (발주 지시 2026-09-02: *"카드 반으로 잘라서 2열배치"*) ────
          모달 폭이 1,024px 까지 쓰므로 한 열로 세우면 카드 하나가 가로로 늘어지고
          세로로만 길어졌다 — 파티가 열 개가 넘으면 전부 보려고 스크롤해야 한다.
          반으로 잘라 두 열로 놓으면 같은 높이에 **두 배가 보인다.**
          좁은 화면(<640px)에서는 한 열이다 — 거기서 두 열은 카드당 150px 이라
          얼굴 타일 두 개도 안 들어간다.
          ★ `items-stretch` + 버튼 `h-full` — 옆 카드와 파티원 수가 달라도 높이가 맞는다.
        */
        <ul className="grid max-h-[60vh] grid-cols-1 items-stretch gap-2 overflow-y-auto sm:grid-cols-2">
          {parties.map((party) => {
            const selected = party.partyId === selectedPartyId;
            return (
              <li key={party.partyId}>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => {
                    onSelect(party.partyId);
                    onClose();
                  }}
                  className={cn(
                    "flex h-full w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                    selected
                      ? "border-primary bg-primary-subtle"
                      : "border-border bg-surface hover:bg-hover-surface",
                  )}
                >
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate text-body-sm font-semibold text-ink">
                      {party.name}
                    </span>
                    {/*
                      ── 파티원 = **얼굴 타일 줄** ──────────────────────────
                      이름이 서로 비슷해서(`발벨3인` 이 둘) 실제로 구분에 쓰이는 것은
                      이 줄이다. 그래서 글자로 이어 붙이는 대신 **얼굴을 띄운다** —
                      사람은 이름보다 그림을 훨씬 빨리 알아본다.
                      크기와 근거는 `MemberTile` 머리말에 있다.

                      ★ **줄이 아니라 격자다**(2026-09-03). `flex-wrap` 은 몇 개가 한 줄에
                        앉을지를 카드 폭이 정하게 두므로, 6인 파티가 4+2 로 접혀 옆 카드와
                        높이가 어긋났다. 열 수를 못 박으면 파티마다 같은 자리에 같은
                        사람이 온다.
                      ★ 좁은 화면(<640px)에서는 카드가 **1열**이라 폭이 넉넉하지 않으므로
                        6열이 아니라 **4열**이다 — 그래야 칸의 실제 크기가 데스크톱 6열과
                        비슷해진다. 6열로 두면 거기서만 얼굴이 눈에 띄게 작아진다.
                    */}
                    {party.members.length > 0 ? (
                      <span className="grid grid-cols-4 gap-2 pt-1 sm:grid-cols-6">
                        {party.members.map((member, index) => (
                          <MemberTile
                            key={`${member.displayName}-${String(index)}`}
                            member={member}
                          />
                        ))}
                      </span>
                    ) : (
                      <span className="text-caption text-ink-muted">
                        {party.memberCount}명
                      </span>
                    )}
                  </span>
                  {/*
                    선택 표시는 **체크 + 테두리 + 면색** 세 채널이다. 색 하나로만 말하면
                    색각 이상에서 어느 것이 선택된 파티인지 알 수 없다(§4).
                  */}
                  {selected ? (
                    <Check
                      aria-hidden
                      size={18}
                      className="shrink-0 text-primary"
                    />
                  ) : null}
                  <span className="sr-only">{selected ? "선택됨" : ""}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Dialog>
  );
}
