"use client";

import { useSyncExternalStore } from "react";

import {
  readCredentialKeyMasks,
  readStoredApiKey,
  subscribeStoredApiKey,
  type CredentialKeyMasks,
} from "./api-key";

/**
 * 브라우저에 저장된 API 키를 구독한다.
 *
 * `useEffect` + `setState` 로 읽지 않는 이유는 두 가지다.
 * - 마운트마다 **연쇄 렌더**가 생긴다(리액트 린트 규칙 `react-hooks/set-state-in-effect`
 *   가 정확히 이걸 막는다).
 * - localStorage 는 React 밖에서도 바뀐다. 다른 탭에서 로그아웃하면 이 탭도 따라가야 하는데,
 *   effect 로 한 번 읽는 방식은 그 변화를 영원히 모른다.
 *
 * 서버 스냅샷은 **항상 `null`** 이다 — 서버에는 localStorage 가 없고, 있다고 가정하면
 * 하이드레이션 결과가 어긋난다. 즉 첫 페인트는 "키 없음" 화면이고 하이드레이션 직후
 * 저장된 키가 반영된다.
 */
export function useStoredApiKey(): string | null {
  return useSyncExternalStore(
    subscribeStoredApiKey,
    readStoredApiKey,
    () => null,
  );
}

/** 서버 스냅샷은 항상 같은 빈 객체여야 한다 — 새 객체를 만들면 하이드레이션이 어긋난다. */
const SERVER_MASKS: CredentialKeyMasks = Object.freeze({});

/**
 * `credentialId → 마스킹된 키` 맵을 구독한다.
 *
 * 저장 대상은 **마스킹 문자열뿐**이며 원문은 들어가지 않는다
 * (`lib/api-key.ts` 의 `rememberCredentialKeyMask` 주석 참고).
 * 값이 없는 자격증명은 "다른 기기에서 등록됨"이라는 정상 상태다.
 */
export function useCredentialKeyMasks(): CredentialKeyMasks {
  return useSyncExternalStore(
    subscribeStoredApiKey,
    readCredentialKeyMasks,
    () => SERVER_MASKS,
  );
}
