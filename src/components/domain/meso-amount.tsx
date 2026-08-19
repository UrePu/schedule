import type { ComponentPropsWithRef } from "react";

import { cn, formatMeso, formatMesoCompact } from "@/lib/utils";

import { NumericText } from "./numeric";

/**
 * 메소 금액 표기.
 *
 * 규칙(CLAUDE.md §4): 금액은 **항상 ko-KR 로케일**로 포맷한다.
 *
 * 규칙(CLAUDE.md §1.3 D4): 결정석 가격이 `null` 인 것은 **"모름"이지 0 이 아니다.**
 * 벨로나 3난이도가 실제로 `crystal_price = null` 로 들어온다. 0 으로 찍으면
 * "수익 없음"으로 오독되므로 `null` 은 반드시 "미확인"으로 구분해 표시하고,
 * 수익 합계에서도 제외해야 한다(합산은 호출부 책임).
 *
 * 축약 표기(`compact`)를 쓰더라도 정확한 값은 `title` 로 항상 노출한다.
 *
 * ★ **금액 숫자는 등폭(`font-mono`)이다.** 기본 UI 서체(메이플스토리체)에는 `tnum` 피처가
 *   없어 `tabular-nums` 가 아무 효과를 내지 못한다 — `1` 이 `0` 의 64% 폭이라 세로로 쌓인
 *   금액의 자릿수가 어긋난다(`Claude/FONT-NOTES.md` §6-1). 앱에서 금액은 거의 항상 목록·
 *   표로 쌓이므로 여기가 등폭이 가장 절실한 자리다. 이 컴포넌트가 앱의 **모든** 메소 표기를
 *   지나가므로 고칠 곳도 여기 하나다.
 *
 *   `tabular-nums` 는 지우지 않고 남겨 둔다. mono 에서는 중복이지만, 언젠가 mono 서체가
 *   바뀌었을 때 다시 필요해진다.
 *
 * ★ 축약 단위(`억` `만`)와 `메소` 접미사는 **본문 서체 그대로** 둔다. Source Code Pro 에는
 *   한글이 없어 함께 감싸면 OS 기본 등폭 서체로 떨어진다(FONT-NOTES §9).
 */

export type MesoTone = "default" | "accent" | "muted";

/*
 * ★ **톤은 색 이름이 아니라 위계다.** 세 톤 전부 저장소 여러 곳이 쓴다
 *  (`accent` 만 13곳). 그래서 톤을 지우거나 갈아끼우는 것은 해법이 아니고,
 *  **색 값 자체가 읽힐 책임**이 있다.
 *
 *  2026-08-19 대비 감사: `accent` 가 가리키는 라이트 `secondary` 는 `#06b6d4` 로
 *  `background` 위 **2.33:1** 이었다 — 이 앱에서 가장 중요한 숫자(메소)가
 *  가장 안 읽히는 색이었다. 토큰을 `#106b7d` 로 내려 고쳤고(상세는
 *  `globals.css` 의 `--color-secondary` 주석), 호출부 13곳은 한 줄도 안 바뀌었다.
 *  측정(라이트/다크): surface 6.14/9.89 · background 5.88/10.61 ·
 *                    hover-surface 5.58/8.74 · hover-strong 4.93/7.41
 *  `muted`(= `ink-muted`) 도 같은 감사에서 `neutral-100` 위 4.40 → **5.56** 이 됐다.
 */
const TONE_CLASS: Record<MesoTone, string> = {
  default: "text-ink",
  accent: "text-secondary",
  muted: "text-ink-muted",
};

export interface MesoAmountProps
  extends Omit<ComponentPropsWithRef<"span">, "children" | "title"> {
  /** 메소 금액. `null` 은 "가격 미확인"이며 0 과 다르다. */
  value: number | null;
  /** 한국식 축약("3억 2,400만") 사용 여부. */
  compact?: boolean;
  /** 뒤에 "메소" 를 붙일지 여부. */
  suffix?: boolean;
  tone?: MesoTone;
  /** 미확인 상태에 쓸 문구. */
  unknownLabel?: string;
}

export function MesoAmount({
  value,
  compact = false,
  suffix = true,
  tone = "default",
  unknownLabel = "미확인",
  className,
  ...props
}: MesoAmountProps) {
  if (value === null) {
    return (
      <span
        title="결정석 가격 미확인 — 값이 알려지지 않은 상태이며 0 메소가 아닙니다."
        data-meso-state="unknown"
        /*
          여기 들어오는 내용은 `unknownLabel`("미확인") — 한글 문구다. 숫자가 아니므로
          `font-mono` 를 걸지 않는다(걸면 한글이 폴백 등폭 서체로 떨어진다).
          `tabular-nums` 만 남겨 둔 것은 위 머리말과 같은 이유다.
        */
        className={cn(
          "inline-flex items-center gap-1 text-ink-muted tabular-nums",
          className,
        )}
        {...props}
      >
        {unknownLabel}
      </span>
    );
  }

  const exact = `${formatMeso(value)} 메소`;
  const shown = compact ? formatMesoCompact(value) : formatMeso(value);

  return (
    <span
      title={exact}
      data-meso-state="known"
      className={cn(
        "inline-flex items-center gap-1 tabular-nums",
        TONE_CLASS[tone],
        className,
      )}
      {...props}
    >
      {/*
        `formatMesoCompact` 는 `3억 2,400만` 처럼 한글 단위를 섞어 낸다. `NumericText` 가
        숫자 구간(`3` · `2,400`)만 mono 로 감싸고 `억` `만` 은 본문 서체로 남긴다.

        ★ **바깥 `<span>` 을 지우지 말 것.** 이 컴포넌트의 루트는 `inline-flex gap-1` 이라
          자식이 여럿이면 조각마다 4px 간격이 벌어진다 — `NumericText` 는 `3` / `억` /
          `2,400` / `만` 으로 쪼개므로 감싸지 않으면 `3 억 2,400 만` 으로 보인다.
          이 한 겹이 금액 전체를 **flex 아이템 하나**로 묶어 준다.
      */}
      <span>
        <NumericText>{shown}</NumericText>
      </span>
      {suffix ? (
        <span className="text-caption text-ink-muted">메소</span>
      ) : null}
    </span>
  );
}
