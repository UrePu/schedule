import { Fragment, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 등폭 숫자 — **본문 서체의 `tnum` 으로 낸다** (2026-08-20)
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 mono 를 뗐나
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 모듈은 원래 **메이플스토리체에 `tnum` 이 없어서** 생겼다. 그 서체는 GSUB 테이블이
 * 통째로 비어 있어 `tabular-nums` 가 아무 효과를 못 냈고(`1` 이 `0` 의 64% 폭), 등폭을 낼
 * 수 있는 서체가 `--font-mono`(Source Code Pro) 하나뿐이라 **숫자만 mono 로 감쌌다.**
 *
 * 기본 서체가 **Pretendard 로 바뀌면서 전제가 사라졌다**(fontTools 실측: GSUB 피처 45개,
 * `tnum` 있음 — `Claude/FONT-NOTES.md` §10). 이제 `tabular-nums` 한 줄이 그대로 듣는다.
 *
 * mono 를 계속 붙여 두면 손해만 남는다. 금액·시각·카운터가 전부 **본문과 다른 서체**로
 * 찍혀, 한국어 문장 한 줄 안에서 서체가 두 벌로 갈린다 — 발주자가 "UI가 지저분하다"고
 * 말한 그 얼룩이다. 그래서 뗀다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 그런데 이 컴포넌트들은 **남는다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 클래스 하나로 줄었다고 지우면, "이 숫자는 세로로 줄 세워 읽는 값" 이라는 **표시**가
 * 코드에서 사라진다. 그 표시가 있어야 다음 사람이 새 금액 칸을 만들 때 무엇을 붙여야
 * 하는지 알고, 서체가 또 바뀌어도 고칠 자리가 여기 하나로 남는다.
 * (`NumericText` 의 숫자 구간 분리도 그대로 둔다 — 지금은 결과가 같지만, 숫자와 한글에
 *  서로 다른 처리가 다시 필요해지면 그 경계가 이미 그어져 있어야 한다.)
 */

/**
 * 숫자 구간을 감싸는 인라인 span. **세로로 줄 세워 읽는 숫자**에 붙인다.
 *
 * 본문 서체(Pretendard)가 `tnum` 을 갖고 있으므로 `tabular-nums` 한 줄이면 등폭이 된다.
 * 한글이 섞여 들어와도 이제는 안전하다 — 서체가 갈리지 않기 때문이다. 그래도 숫자에만
 * 붙이는 습관은 유지한다: `tabular-nums` 는 숫자에만 뜻이 있는 속성이다.
 */
export function Numeric({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span className={cn("tabular-nums", className)}>{children}</span>
  );
}

/**
 * 숫자 구간을 이어 주는 구분자. `8/20` · `00:00` · `3,240,000` · `2026-08-20` 이
 * 한 덩어리로 묶이도록 숫자 사이에 낀 것만 인정한다. 앞뒤로 튀어나온 기호
 * (`~00:00` 의 `~`, `12개` 의 `개`)는 일부러 밖에 둔다 — 본문 서체가 맡아야 한다.
 */
const NUMERIC_RUN = /\d+(?:[.,:/-]\d+)*/g;

/**
 * 한글이 섞인 문자열에서 **숫자 구간만** 등폭으로 만든다.
 *
 * `formatKstShort` 는 `8/20 목 00:00` 처럼 요일 한 글자를 품고 나온다. 이 컴포넌트가
 * `8/20` 과 `00:00` 에만 등폭을 걸고 `목` 은 건드리지 않는다.
 *
 * JSX 안에서 숫자가 이미 별도 표현식으로 떨어져 있으면(`보스 {a}/{b}`) 이걸 쓰지 말고
 * `Numeric` 으로 그 표현식만 직접 감싸는 편이 읽기 쉽다.
 */
export function NumericText({
  children,
  className,
}: {
  readonly children: string;
  readonly className?: string;
}) {
  const parts: ReactNode[] = [];
  let cursor = 0;

  for (const match of children.matchAll(NUMERIC_RUN)) {
    const start = match.index;
    if (start > cursor) parts.push(children.slice(cursor, start));
    parts.push(
      <Numeric key={start} className={className}>
        {match[0]}
      </Numeric>,
    );
    cursor = start + match[0].length;
  }

  // 숫자가 하나도 없으면 원문 그대로다("확인 이력 없음" 같은 대체 문구).
  if (cursor < children.length) parts.push(children.slice(cursor));

  return (
    <>
      {parts.map((part, index) => (
        <Fragment key={index}>{part}</Fragment>
      ))}
    </>
  );
}
