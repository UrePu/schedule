"use client";

import { useSyncExternalStore } from "react";

import {
  EMPTY_CREDENTIAL_ID_LIST,
  EMPTY_CREDENTIAL_KEY_MAP,
  EMPTY_CREDENTIAL_KEY_MASKS,
  readAnyStoredApiKey,
  readCredentialKeyMasks,
  readStoredApiKeys,
  readStoredCredentialIds,
  subscribeStoredApiKey,
  type CredentialKeyMap,
  type CredentialKeyMasks,
} from "./api-key";

/**
 * 브라우저에 저장된 API 키들을 구독한다.
 *
 * `useEffect` + `setState` 로 읽지 않는 이유는 두 가지다.
 * - 마운트마다 **연쇄 렌더**가 생긴다(리액트 린트 규칙 `react-hooks/set-state-in-effect`
 *   가 정확히 이걸 막는다).
 * - localStorage 는 React 밖에서도 바뀐다. 다른 탭에서 로그아웃하면 이 탭도 따라가야 하는데,
 *   effect 로 한 번 읽는 방식은 그 변화를 영원히 모른다.
 *
 * 서버 스냅샷은 **항상 비어 있다** — 서버에는 localStorage 가 없고, 있다고 가정하면
 * 하이드레이션 결과가 어긋난다. 즉 첫 페인트는 "키 없음" 화면이고 하이드레이션 직후
 * 저장된 키가 반영된다.
 */

/**
 * `credentialId → 원문 키` 맵.
 *
 * ⚠️ **이 값을 화면에 렌더하지 않는다.** 표시는 언제나 `useCredentialKeyMasks()` 다.
 *    이 훅의 결과는 넥슨 프록시로 보낼 헤더를 고르는 데만 쓴다.
 */
export function useStoredApiKeys(): CredentialKeyMap {
  return useSyncExternalStore(
    subscribeStoredApiKey,
    readStoredApiKeys,
    () => EMPTY_CREDENTIAL_KEY_MAP,
  );
}

/**
 * `credentialId → 마스킹된 키` 맵. 저장 대상은 마스킹 문자열이 아니라 원문이지만
 * (`lib/api-key.ts`), **밖으로 나오는 것은 마스킹뿐**이다.
 *
 * 값이 없는 자격증명은 "이 브라우저에 그 키가 없다"는 정상 상태다.
 */
export function useCredentialKeyMasks(): CredentialKeyMasks {
  return useSyncExternalStore(
    subscribeStoredApiKey,
    readCredentialKeyMasks,
    () => EMPTY_CREDENTIAL_KEY_MASKS,
  );
}

/**
 * 하이드레이션이 끝났는가.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 왜 필요한가 — **"아직 모른다"와 "정말 없다"는 다르다**
 * ─────────────────────────────────────────────────────────────────────────────
 * 위 훅들의 서버 스냅샷은 언제나 비어 있다(서버에는 localStorage 가 없다). 그래서 서버
 * 렌더 시점에는 키가 실제로 없는 것과 **아직 읽지 못한 것**이 구분되지 않는다. 그 상태로
 * "이 계정 키가 이 브라우저에 없습니다"라는 경고를 그리면, 키가 멀쩡히 있는 사용자도
 * 화면을 열 때마다 주황 경고가 번쩍인 뒤 사라진다 — **틀린 경고**다.
 *
 * 그래서 경고를 그리는 자리는 이 훅으로 한 번 더 거른다. 서버 스냅샷 `false`,
 * 클라이언트 스냅샷 `true` 이므로 하이드레이션 직후 정확히 한 번 바뀐다.
 * (`useEffect` + `setState` 로 같은 일을 하면 마운트마다 연쇄 렌더가 생기고
 * `react-hooks/set-state-in-effect` 에 걸린다.)
 */
const NEVER_CHANGES = () => () => {};

export function useIsHydrated(): boolean {
  return useSyncExternalStore(
    NEVER_CHANGES,
    () => true,
    () => false,
  );
}

/**
 * 원문 키를 **실제로** 들고 있는 자격증명 id 목록.
 *
 * "이 계정 키가 이 브라우저에 있는가"를 묻는 화면은 마스킹이 아니라 이것을 봐야 한다 —
 * 마스킹에는 예전 형식의 잔재가 섞일 수 있고, 그 항목은 표시만 되고 호출은 못 한다.
 */
export function useStoredCredentialIds(): readonly string[] {
  return useSyncExternalStore(
    subscribeStoredApiKey,
    readStoredCredentialIds,
    () => EMPTY_CREDENTIAL_ID_LIST,
  );
}

/**
 * 자격증명을 특정할 수 없는 자리에서 쓰는 "아무 키" — **로그인 폼 전용**이다.
 *
 * §2.1: 어느 연결 키로 로그인해도 같은 사람으로 들어온다. 그래서 저장된 키가 하나라도
 * 있으면 재입력을 요구할 이유가 없다. 반대로 **대상이 정해진 호출**(캐릭터 동기화,
 * 초상화)에는 절대 쓰면 안 된다 — 그 캐릭터의 계정 키가 아니면 넥슨이 거절한다.
 */
export function useAnyStoredApiKey(): string | null {
  return useSyncExternalStore(
    subscribeStoredApiKey,
    readAnyStoredApiKey,
    () => null,
  );
}
