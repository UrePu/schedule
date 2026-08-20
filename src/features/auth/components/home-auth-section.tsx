"use client";

import { useState } from "react";

import { CharacterPickerTrigger } from "@/features/characters/components";

import type { LoginResponse } from "../types";
import { AuthPanel } from "./auth-panel";

/**
 * 홈(`/`)의 로그인 구획.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 클라이언트 컴포넌트인가
 * ─────────────────────────────────────────────────────────────────────────────
 * ⚠️ 여기 있던 예전 설명은 **사실이 아니게 됐다.** "페이지는 세션을 한 줄도 읽지 않는다"고
 *    적혀 있었지만, `src/app/page.tsx` 는 이제 **서버에서** `readSession()` 으로 세션을
 *    읽고 랜딩/이번 주 시간표를 가른다. 비로그인 200 보장(DoD §0.3)이 없어진 것이 아니라
 *    **자리를 옮겼다**: `readSession()` 은 쿠키가 없으면 던지지 않고 `null` 을 주고,
 *    `null` 이면 그 아래 DB 접근이 한 줄도 실행되지 않은 채 곧장 랜딩이 반환된다.
 *    (근거 전체는 `page.tsx` 머리말에 있다.)
 *
 * 이 구획이 여전히 클라이언트인 이유는 다른 데 있다 — 로그인은 **입력 · 뮤테이션 ·
 * 로컬 저장소**(키는 브라우저에만 남는다, §2.1.2)를 다루는 상호작용이라 서버 컴포넌트로
 * 만들 수 없다. 네 상태(로딩 · 비로그인 · 로그인 · 에러)는 `AuthPanel` 이 그리고,
 * 이 컴포넌트가 더하는 것은 **캐릭터 선택 모달 연결**과 **로그인 직후 화면 전환**이다.
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
  const [pickerOpen, setPickerOpen] = useState(false);

  /*
   * ─────────────────────────────────────────────────────────────────────────
   * 로그인 성공 → 시간표 전환 : **문서 재적재 한 번으로 끝낸다**
   * ─────────────────────────────────────────────────────────────────────────
   * `/` 는 **서버에서** 세션을 보고 랜딩/이번 주 시간표를 가른다. 쿠키만 심고 끝내면 이
   * 페이지는 계속 랜딩인 채로 남으므로 서버 렌더를 다시 받아야 한다.
   *
   * 예전 구현은 `router.refresh()` 를 부르고 **1.5초 감시 타이머**를 걸어, 그 안에
   * 화면이 안 바뀌면 그때 문서를 재적재했다. 두 가지가 잘못됐다.
   *  ① `router.refresh()` 는 `startTransition` 안에서 라우터 상태를 promise 로 갈아
   *     끼우고 app-router 서브트리가 거기 서스펜드한다. **커밋 전까지 화면은 옛 UI**
   *     이고, RSC 왕복이든 새로 필요해진 클라이언트 청크 적재든 한 군데만 멎으면
   *     사용자에게는 아무 표시 없이 랜딩이 남는다 — 보고된 증상이 정확히 그것이었다.
   *  ② 그래서 걸어 둔 안전장치가 곧 **"실패하면 사용자가 1.5초 동안 랜딩을 본다"**
   *     는 뜻이다. 로그인은 사람이 결과를 기다리는 순간이라 그 1.5초가 그대로 체감된다.
   *
   * 그래서 SPA 경로를 아예 시도하지 않는다. **로그인은 자주 일어나는 동작이 아니고**,
   * 문서 재적재는 라우터 캐시 · BFCache · 로그인 전 쿼리 캐시를 **전부** 버리므로
   * "낡은 랜딩이 살아남는" 경우의 수가 구조적으로 0이 된다. 대기 시간은 0ms 로
   * 시작하는 재적재 1회뿐이고, 판정이 서버 한 곳에만 남아 추론도 쉬워진다.
   *
   * `assign` 이 아니라 `replace` 인 이유: 뒤로가기가 로그인 전 랜딩(이미 낡은 화면)으로
   * 돌아가면 안 된다.
   */
  function goToDashboard(): void {
    window.location.replace("/");
  }

  function handleLoggedIn(result: LoginResponse): void {
    if (result.user.trackedCharacterCount === 0) {
      /*
       * **추적 캐릭터가 0명이면 먼저 모달을 띄운다.** 전환이 먼저 일어나면 이 컴포넌트가
       * 통째로 사라지면서 모달도 함께 없어져, 캐릭터를 고르라는 안내가 조용히 증발한다.
       * 그래서 순서를 "모달 → (닫힌 뒤) 전환" 으로 고정했다.
       */
      setPickerOpen(true);
      return;
    }
    goToDashboard();
  }

  function handlePickerOpenChange(open: boolean): void {
    setPickerOpen(open);
  }

  /*
   * ★ 전환은 **`onOpenChange(false)` 가 아니라 여기서** 한다. 모달은 저장을 누르는
   *   즉시 닫히고 요청은 뒤에서 계속 나므로, 닫히자마자 문서를 재적재하면 그 요청이
   *   끊겨 방금 고른 추적 명단이 조용히 사라진다. `onFinished` 는 요청이 성공·실패로
   *   끝난 뒤(또는 그냥 닫았을 때) 불린다.
   */
  function handlePickerFinished(): void {
    goToDashboard();
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
            onFinished={handlePickerFinished}
          />
        }
      />
    </section>
  );
}
