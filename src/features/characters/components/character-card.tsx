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
        카드가 커졌다(발주자 요구 "캐릭터 크기 2배"). 초상화는 `aspect-square w-full` 이라
        **그리드 열 수가 크기를 정한다** — 모달이 6열에서 4열로 줄면서 한 칸이 약 1.5배
        넓어지고 초상화도 같은 비율로 커진다. 카드 안에는 고정 px 가 없으므로 반응형이
        그대로 유지된다. 패딩과 실루엣 아이콘만 커진 면적에 맞춰 올렸다.
      */}
      <label
        className={cn(
          "flex h-full cursor-pointer flex-col items-center gap-2.5 rounded-md border p-3 text-center",
          "transition duration-200",
          selected
            ? "border-primary bg-primary-subtle"
            : "border-border bg-surface hover:bg-hover-surface",
        )}
      >
        <span
          className={cn(
            "flex aspect-square w-full items-center justify-center overflow-hidden rounded-md",
            "bg-neutral-100 text-ink-placeholder",
          )}
        >
          {showImage ? (
            /*
             * 넥슨 초상화 CDN 은 임의 외부 호스트라 next/image 의 remotePatterns 로
             * 고정할 수 없고, 초상화는 이미 작은 고정 크기라 최적화 이득도 없다.
             * `alt=""` 인 이유: 바로 아래에 닉네임이 텍스트로 있어 장식 이미지다.
             */
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={imageUrl}
              alt=""
              loading="lazy"
              onError={() => setFailedUrl(imageUrl)}
              className="size-full object-contain"
            />
          ) : (
            /* 실루엣도 카드와 함께 커진다. **에러가 아니라 정상 상태**다(§2.1.1). */
            <UserRound aria-hidden size={56} strokeWidth={1.25} />
          )}
        </span>

        <span className="flex w-full min-w-0 flex-col items-center gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            <Checkbox
              checked={selected}
              onChange={() => onToggle(character.characterId)}
            />
            <span className="truncate text-body-sm font-semibold text-ink">
              {character.name}
            </span>
          </span>
          <span className="text-caption text-ink-muted tabular-nums">
            Lv.{character.level} | {character.className}
          </span>
          {/* 월드는 표기 전용이다 — 필터 수단이 아니다. */}
          <span className="text-overline text-ink-muted">
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
            : "bg-surface/90 text-ink-muted hover:bg-hover-surface hover:text-ink-label",
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
