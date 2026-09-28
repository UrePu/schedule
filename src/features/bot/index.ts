/**
 * 봇 연동 기능의 공개 표면.
 *
 * ⚠️ `./server/*` 는 여기서 재수출하지 않는다. 서버 모듈은 `import "server-only"` 로
 *    잠겨 있고, 이 배럴을 클라이언트 컴포넌트가 import 하는 순간 빌드가 깨진다.
 *
 * ★ 2026-09-28 에 표면이 절반으로 줄었다 — 방·페어링·아웃박스 타입과 `updatePartyChannel`
 *   이 함께 사라졌다(`./types` 머리말). 남은 것은 **명령 응답 계약 + 계정 연결**뿐이다.
 */
export {
  BotLinkDialogButton,
  type BotLinkDialogButtonProps,
} from "./components";
export { createBotLinkCode, fetchBotSetupState } from "./data/bot-api";
export type {
  BotBoundParty,
  BotCommandRequest,
  BotCommandResponse,
  BotIdentitySummary,
  BotLinkCode,
  BotLinkCodeKind,
  BotSetupState,
} from "./types";
export { DEFAULT_BOT_PLATFORM } from "./types";
