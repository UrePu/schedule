"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { CharacterPickerTrigger } from "@/features/characters/components";

import type { LoginResponse } from "../types";
import { AuthPanel } from "./auth-panel";

/**
 * 홈(`/`)의 로그인 구획.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 클라이언트 컴포넌트인가 — **비로그인 200 을 구조로 보장한다**
 * ─────────────────────────────────────────────────────────────────────────────
 * `/` 는 로그아웃 상태에서 반드시 열려야 한다(DoD §0.3). 서버 컴포넌트가 세션을 읽기
 * 시작하면 그 한 줄이 언제든 리다이렉트나 500 으로 자라날 수 있다. 그래서 페이지는
 * 세션을 **한 줄도 읽지 않고**, 로그인 여부 분기는 전부 여기서 `useSessionQuery()` 로
 * 한다(`/api/auth/me` 는 비로그인도 200 `{user:null}`).
 *
 * 네 상태(로딩·비로그인·로그인·에러)는 `AuthPanel` 이 그린다. 이 컴포넌트가 더하는 것은
 * **캐릭터 선택 모달과의 연결** 하나다.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 로그인 직후 모달 자동 오픈 (§2.1.1)
 * ─────────────────────────────────────────────────────────────────────────────
 * 판정 기준은 "신규 계정인가"가 **아니라** `trackedCharacterCount === 0` 이다.
 * 추적은 옵트인이라 기본값이 0이고, 로그인만 하고 캐릭터를 고르지 않은 채 나간 사람은
 * 신규가 아니면서도 여전히 0명이다. 신규 여부로 가르면 그 사람은 다음 로그인부터
 * 영원히 안내를 못 받는다. 또한 이 값은 **계정 전체** 기준이라, 부계정 키로 로그인해도
 * 이미 본계정에서 고른 캐릭터가 있으면 모달이 뜨지 않는다.
 */

export interface HomeAuthSectionProps {
  readonly className?: string;
}

export function HomeAuthSection({ className }: HomeAuthSectionProps) {
  const router = useRouter();
  const [pickerOpen, setPickerOpen] = useState(false);

  /*
   * ─────────────────────────────────────────────────────────────────────────
   * 로그인 성공 뒤 대시보드로 넘어가는 방식
   * ─────────────────────────────────────────────────────────────────────────
   * `/` 는 **서버에서** 세션을 보고 랜딩/대시보드를 가른다. 쿠키만 심고 끝내면 이
   * 페이지는 계속 랜딩인 채로 남으므로 `router.refresh()` 로 서버 렌더를 다시 받아야 한다.
   *
   * 다만 **추적 캐릭터가 0명이면 먼저 모달을 띄운다.** 새로고침이 먼저 일어나면 이
   * 컴포넌트가 통째로 사라지면서 모달도 함께 없어져, 캐릭터를 고르라는 안내가
   * 조용히 증발한다. 그래서 순서를 "모달 → (닫힌 뒤) 새로고침" 으로 고정했다.
   */
  function handleLoggedIn(result: LoginResponse): void {
    if (result.user.trackedCharacterCount === 0) {
      setPickerOpen(true);
      return;
    }
    router.refresh();
  }

  function handlePickerOpenChange(open: boolean): void {
    setPickerOpen(open);
    if (!open) router.refresh();
  }

  return (
    <section className={className}>
      {/*
        이 두 줄은 **세션과 무관하게 항상 참**이라 서버 렌더 HTML 에 그대로 들어간다.
        아래 패널은 세션 조회가 끝나야 로그인 폼/계정 카드로 갈리므로, 첫 페인트에는
        스켈레톤만 남는다. 그때도 "여기가 로그인 자리"라는 사실은 보여야 한다.
      */}
      <h2 className="mb-1 font-headline text-body-lg font-semibold text-ink">
        계정
      </h2>
      <p className="mb-3 max-w-2xl text-body-sm text-ink-muted">
        넥슨 API 키로 로그인합니다. 키는 이 브라우저에만 저장되고 서버에는 해시만
        남습니다. 공개 시간표는 로그인 없이도 볼 수 있습니다.
      </p>
      <AuthPanel
        onLoggedIn={handleLoggedIn}
        actions={
          <CharacterPickerTrigger
            open={pickerOpen}
            onOpenChange={handlePickerOpenChange}
          />
        }
      />
    </section>
  );
}
