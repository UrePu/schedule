"use client";

import { Crown, Star, UserRound } from "lucide-react";
import { useState } from "react";

import { Checkbox } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { GameCharacter } from "@/types/domain";

/**
 * 캐릭터 카드 — 초상화(또는 실루엣) / 닉네임 / `Lv.295 | 비숍` / 월드.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 실루엣은 **에러가 아니다** (§2.1.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * `/character/list` 는 이미지를 주지 않고, 초상화는 `/character/basic` 에서
 * **캐릭터당 1콜**로 온다. 그래서 초상화는 아래 세 경우에 없을 수 있다:
 *   1. 아직 안 받아 왔다 (조회 중)
 *   2. 응답에 이미지가 없다 (`imageUrl === null`)
 *   3. 받아 온 URL 이 로드에 실패했다 (`onError`)
 * 셋 다 **회색 실루엣**으로 같게 처리한다. 어느 것도 오류 UI 가 아니다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 본캐 버튼이 카드 안에 중첩되지 않은 이유
 * ─────────────────────────────────────────────────────────────────────────────
 * 카드 본체는 체크박스를 감싼 `<label>` 이다. 본캐 버튼을 그 안에 넣으면
 * **label 안의 button** 이 되어 클릭이 체크박스 토글까지 함께 발화하고,
 * 스크린리더도 라벨 텍스트에 버튼 이름을 섞어 읽는다.
 * → 형제로 두고 `absolute` 로 겹쳐 놓는다. 탭 순서는 카드 → 본캐 버튼이다.
 */

export interface CharacterCardProps {
  readonly character: GameCharacter;
  /** 초상화 URL. `null`/`undefined` 면 실루엣. */
  readonly imageUrl: string | null | undefined;
  readonly selected: boolean;
  readonly isMain: boolean;
  readonly onToggle: (characterId: string) => void;
  readonly onSetMain: (characterId: string) => void;
}

export function CharacterCard({
  character,
  imageUrl,
  selected,
  isMain,
  onToggle,
  onSetMain,
}: CharacterCardProps) {
  /**
   * 불린 대신 **실패한 URL 자체**를 담는다.
   * 불린이면 새 URL 이 들어올 때 effect 로 초기화해야 하는데, 그건 이벤트가 아니라
   * 프롭 변화를 쫓는 동기화라 렌더 연쇄를 만든다. URL 을 담아 두면 비교 한 번으로
   * "이 URL 이 실패했는가"가 그대로 나오고 초기화가 저절로 된다.
   */
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  const showImage =
    typeof imageUrl === "string" && imageUrl !== "" && failedUrl !== imageUrl;

  return (
    <li className="relative">
      {/*
        카드 **바깥** 크기는 그리드가 정한다(`character-picker-dialog.tsx` 의 `GRID_CLASS`,
        넓은 화면 6열). 초상화 틀이 `aspect-square w-full` 이라 열 폭을 그대로 따라가므로
        카드에는 고정 px 폭·높이를 넣지 않는다 — 넣는 순간 반응형이 죽는다.

        ★ **"캐릭터를 크게"는 이 틀(회색 박스)을 키우는 일이 아니다.** 그건 아래 img 의
          `scale` 이 하는 일이고, 그 근거는 거기 주석에 실측값으로 적어 두었다.
          카드 패딩·간격은 레이아웃 밀도일 뿐이니 여기서 캐릭터 크기를 벌려고 하지 말 것.
          글자 크기도 깎지 않는다 — 문장 14px 하한(§4)이 우선이다.
      */}
      <label
        className={cn(
          /*
           * `cursor-pointer` 를 지웠다 — `globals.css` base 의
           * `label:has(input[type="checkbox"]:not(:disabled))` 가 이 라벨을 이미 잡는다
           * (안에 `Checkbox` 가 있다). 개별로 또 적으면 규칙이 두 군데로 갈린다.
           */
          "group flex h-full flex-col items-center gap-1.5 rounded-md border p-1.5 text-center",
          "transition duration-200",
          /*
           * 선택된 카드에는 hover 가 **없었다** — 이미 고른 카드를 다시 눌러 해제할 수
           * 있다는 사실이 보이지 않았다. 비선택 hover 면도 `hover-surface`(1.10:1)에서
           * `hover-strong`(1.245:1)으로 올렸다.
           */
          selected
            ? "border-primary bg-primary-subtle hover:border-primary-hover hover:bg-primary-subtle-hover"
            : "border-border bg-surface hover:border-border-strong hover:bg-hover-strong",
        )}
      >
        <span
          className={cn(
            "flex aspect-square w-full items-center justify-center overflow-hidden rounded-md",
            // 이미지가 없을 때 이 자리에 **닉네임 첫 글자**가 글자로 들어간다.
            // 읽는 글자이므로 `ink-placeholder`(neutral-100 위 2.33:1)를 쓰면 안 된다(§4).
            // `ink-muted` 는 같은 면에서 5.37:1.
            "bg-neutral-100 text-ink-muted",
          )}
        >
          {showImage ? (
            /*
             * 넥슨 초상화 CDN 은 임의 외부 호스트라 next/image 의 remotePatterns 로
             * 고정할 수 없고, 초상화는 이미 작은 고정 크기라 최적화 이득도 없다.
             * `alt=""` 인 이유: 바로 아래에 닉네임이 텍스트로 있어 장식 이미지다.
             *
             * ───────────────────────────────────────────────────────────────────
             * `scale-200 origin-[43.3%_54.7%]` — 감이 아니라 **실측값**이다
             * ───────────────────────────────────────────────────────────────────
             * 원본(`character_image`)은 **항상 300×300 PNG(RGBA)** 이고, 그 안에서
             * 캐릭터는 아주 작게 그려져 있다. 실측(캐릭터 50명, 알파>8 인 픽셀의
             * 경계 상자):
             *   · 캐릭터 크기      중앙값 76×76px = 원본 변의 **25%** (면적의 6%)
             *   · 머리 끝 minY     중앙값 129 · 최소 88
             *   · 발 끝  maxY      중앙값 202 · 최대 226
             *   · 좌우  minX/maxX  최소 70 / 최대 210
             * 즉 틀을 아무리 키워도 **투명 여백까지 같이 커질 뿐** 캐릭터는 25%에
             * 묶인다. 여백을 잘라내야 커진다.
             *
             * 잘라내는 방법: 틀에 `overflow-hidden`(위 span) + 여기서 확대.
             * 원본이 정사각이고 틀도 정사각이라 `object-contain` 은 1:1 대응이므로,
             * 원본 좌표 그대로 계산할 수 있다.
             *   · 50명 전원을 담는 최소 정사각 창 = 140×140 (x 70–210, y 88–226)
             *     → 이론상 최대 배율 300/140 ≈ 2.14
             *   · 실제 채택 배율 **2.0** = 창 150×150. 최악값 대비 각 변 5~6px 여유를
             *     둬서 표본(59명 중 50명)에 없던 탈것·큰 모자까지 흡수한다.
             *   · 확대 중심: 창 중심 (140, 157)/300 을 틀 중앙으로 보내는 원점은
             *     P = (S·C − 150)/(S − 1) → (130, 164)/300 = **43.3% / 54.7%**.
             *     캐릭터는 프레임 세로 중앙이 아니라 **아래쪽**에 서 있어서, 50%
             *     중앙 확대로는 발이 잘린다. 그래서 원점을 아래로 내렸다.
             *     보이는 원본 영역 = x 65–215, y 82–232 → 실측 최악값을 전부 포함.
             *
             * 화질: 6열 한 칸 ≈145px 이므로 300px 원본이 145px 로 축소된 뒤 2배 →
             * 실효 290px < 원본 300px. **확대가 아니라 여전히 축소**라 열화가 없다.
             * 더 큰 원본은 없다(실측: `width`/`height`/`w`/`h`/`size`/`scale`/`x`/
             * `resize` 전부 무시되고 바이트까지 동일한 300×300 이 온다. `wmotion` 만
             * 실제로 먹히는데 그건 포즈이지 해상도가 아니다).
             */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt=""
              loading="lazy"
              onError={() => setFailedUrl(imageUrl)}
              className="size-full origin-[43.3%_54.7%] scale-200 object-contain"
            />
          ) : (
            /*
              실루엣은 초상화 영역의 **절반**을 차지한다. 고정 px(예전 `size={56}`)는
              4열 시절 넓은 칸에 맞춘 값이라 6열에서는 칸을 압도한다. 비율로 두면
              모든 브레이크포인트에서 같은 무게로 읽힌다.
              **에러가 아니라 정상 상태**다(§2.1.1).
            */
            <UserRound aria-hidden className="h-1/2 w-1/2" strokeWidth={1.25} />
          )}
        </span>

        {/*
          텍스트 블록이 먹는 세로 공간이 곧 초상화가 못 쓰는 공간이다. 줄 사이 `gap` 을
          없애 그만큼을 초상화에 넘긴다. **글자 크기는 건드리지 않는다** — 닉네임은 문장
          하한 14px(`text-body-sm`), 아래 둘은 수치·라벨이라 caption/overline 이 맞다(§4).
          행간도 그대로 둔다: 타이포 토큰이 `--text-*--line-height` 를 짝으로 들고 있어
          `leading-*` 유틸을 부모에 걸어 봐야 각 줄에서 덮어써진다(= 무효). 세로 공간은
          패딩과 `gap` 에서만 나온다.
        */}
        <span className="flex w-full min-w-0 flex-col items-center">
          <span className="flex min-w-0 items-center gap-1.5">
            <Checkbox
              checked={selected}
              onChange={() => onToggle(character.characterId)}
            />
            <span className="truncate text-body-sm font-semibold text-ink">
              {character.name}
            </span>
          </span>
          {/*
            hover 면 위에서 `ink-muted` 는 라이트 3.88:1 로 AA 미달이라
            `group-hover` 로 `ink-label`(8.39 / 8.97:1)까지 같이 올린다.
          */}
          <span className="text-caption text-ink-muted tabular-nums group-hover:text-ink-label">
            Lv.{character.level} | {character.className}
          </span>
          {/* 월드는 표기 전용이다 — 필터 수단이 아니다. */}
          <span className="text-overline text-ink-muted group-hover:text-ink-label">
            {character.worldName}
          </span>
        </span>
      </label>

      <button
        type="button"
        aria-pressed={isMain}
        aria-label={`${character.name} 을(를) 본캐로 지정`}
        title="본캐로 지정 — 계정 표시 이름이 됩니다"
        onClick={() => onSetMain(character.characterId)}
        className={cn(
          "absolute top-1.5 right-1.5 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5",
          "text-overline font-bold transition duration-200",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
          isMain
            ? "bg-primary text-surface"
            : "bg-surface/90 text-ink-muted hover:bg-hover-strong hover:text-ink-label",
        )}
      >
        {isMain ? (
          <Crown aria-hidden size={11} />
        ) : (
          <Star aria-hidden size={11} />
        )}
        본캐
      </button>
    </li>
  );
}
