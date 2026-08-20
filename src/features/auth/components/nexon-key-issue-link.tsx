import { ExternalLink } from "lucide-react";

import { buttonClass, type ButtonSize, type ButtonVariant } from "@/components/ui";

/**
 * ═════════════════════════════════════════════════════════════════════════════
 * 넥슨 오픈 API 키 **발급받으러 가기**
 * ═════════════════════════════════════════════════════════════════════════════
 *
 * 발주 요구(2026-08-20): *"로그인 전에 openapi.nexon.com 로 다이렉트되는 버튼 만들어줘
 * api 받으려면 여기가서 받아야해"*
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 별도 컴포넌트인가
 * ─────────────────────────────────────────────────────────────────────────────
 * 이 링크가 필요한 자리는 하나가 아니다. **키를 처음 넣는 로그인 폼**과, 부계정 키를
 * 더하는 **계정 · 키 관리 모달**이 같은 것을 요구한다(§2.1 — 한 사람이 넥슨 계정을 여러 개
 * 쓰고, 계정마다 키가 따로 발급된다). 주소를 양쪽에 적어 두면 언젠가 한쪽만 낡는다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `<button>` 이 아니라 `<a>` 인 이유
 * ─────────────────────────────────────────────────────────────────────────────
 * 발주 표현은 "버튼"이지만 하는 일은 **바깥으로 나가는 이동**이다. 앵커로 두면 가운데
 * 클릭으로 새 탭, 우클릭으로 주소 복사, 스크린리더의 "링크" 안내가 전부 공짜로 따라온다.
 * `onClick={() => window.open(...)}` 로 만든 버튼은 그 셋을 모두 잃는다.
 * 모양은 `buttonClass()` 로 진짜 버튼과 **같은 조합**을 쓰므로 눈에는 버튼이다.
 *
 * ★ **새 탭으로 연다.** 키를 발급받는 동안 이 페이지가 사라지면, 돌아왔을 때 입력하던
 *   것이 없다. 로그인 도중이라 특히 그렇다.
 * ★ `rel="noreferrer"` — 우리 주소를 넘길 이유가 없다. `noopener` 는 최신 브라우저에서
 *   `_blank` 에 자동으로 붙지만, 명시해도 손해가 없고 의도가 드러난다.
 */

/** 넥슨 오픈 API 포털. 키 발급은 여기서만 가능하다. */
const NEXON_OPEN_API_URL = "https://openapi.nexon.com/";

export function NexonKeyIssueLink({
  variant = "secondary",
  size = "sm",
  label = "API 키 발급받으러 가기",
  className,
}: {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly label?: string;
  readonly className?: string;
}) {
  return (
    <a
      href={NEXON_OPEN_API_URL}
      target="_blank"
      rel="noreferrer noopener"
      className={buttonClass(variant, size, className)}
    >
      {label}
      {/*
        새 탭으로 나간다는 사실을 **아이콘으로 알린다.** 링크 문구만으로는 클릭 결과가
        예측되지 않고, 그 예측 실패가 "뒤로 가기가 안 되네"로 나타난다.
      */}
      <ExternalLink aria-hidden size={14} />
      <span className="sr-only">(새 탭에서 열림)</span>
    </a>
  );
}
