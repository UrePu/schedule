import { Fragment, type ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 등폭 숫자 — **핵심 수치만** mono 로 되돌린다
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 필요해졌나
 * ─────────────────────────────────────────────────────────────────────────────
 * 기본 UI 서체가 메이플스토리체로 바뀌면서 **`tabular-nums` 가 전부 무효**가 됐다.
 * 이 서체는 GSUB 테이블이 비어 있어 `tnum` 피처가 없고, 기본 숫자 폭도 제각각이다
 * (`1`=432 vs `0`=675 — `1` 이 `0` 의 64%). 실측은 `Claude/FONT-NOTES.md` §6-1.
 *
 * 등폭을 얻을 수 있는 서체는 지금 `--font-mono`(Source Code Pro) 하나뿐이라 그것을 쓴다.
 * §4 가 mono 를 "코드·키·ID"용으로 규정했는데 이번에 **수치 주석까지** 넓히는 것이므로,
 * 그 결정과 범위는 `Claude/FONT-NOTES.md` §9 에 남겼다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 줄 전체를 mono 로 만들지 말 것
 * ─────────────────────────────────────────────────────────────────────────────
 * Source Code Pro 에는 **한글이 없다.** `보스 10/12` 한 줄을 통째로 `font-mono` 로 감싸면
 * `보스` 가 OS 기본 등폭 서체로 떨어져 머신마다 다르게 보인다 — Outfit/Inter 를 버린 바로
 * 그 증상이다(FONT-NOTES §1). 그래서 **숫자 구간만** 감싼다. 그게 이 모듈의 존재 이유다.
 */

/**
 * 순수 숫자 구간을 감싸는 인라인 span. 한글이 **들어가지 않는** 내용에만 쓴다.
 *
 * `tabular-nums` 를 함께 남긴다. Source Code Pro 에서는 이미 모든 글자가 등폭이라
 * 중복이지만, 언젠가 mono 서체가 바뀌었을 때(비례 숫자를 가진 서체가 오면) 다시
 * 필요해진다. 지우면 그때 조용히 어긋난다.
 */
export function Numeric({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span className={cn("font-mono tabular-nums", className)}>{children}</span>
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
 * `formatKstShort` 는 `8/20 목 00:00` 처럼 요일 한 글자를 품고 나오므로 통째로 감쌀 수
 * 없다. 이 컴포넌트가 `8/20` 과 `00:00` 만 mono 로 감싸고 `목` 은 본문 서체로 남긴다.
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
