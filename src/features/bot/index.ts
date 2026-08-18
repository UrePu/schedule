/**
 * 봇 연동 기능의 공개 표면.
 *
 * ⚠️ `./server/*` 는 여기서 재수출하지 않는다. 서버 모듈은 `import "server-only"` 로
 *    잠겨 있고, 이 배럴을 클라이언트 컴포넌트가 import 하는 순간 빌드가 깨진다.
 */
export {
  BotLinkDialogButton,
  type BotLinkDialogButtonProps,
} from "./components";
export {
  createBotLinkCode,
  fetchBotSetupState,
  updatePartyChannel,
} from "./data/bot-api";
export type {
  BotBoundParty,
  BotChannelSummary,
  BotCommandRequest,
  BotCommandResponse,
  BotLinkCode,
  BotLinkCodeKind,
  BotOutboxAckRequest,
  BotOutboxAckResponse,
  BotOutboxAckResult,
  BotOutboxMessage,
  BotOutboxResponse,
  BotPairRequest,
  BotPairResponse,
  BotRotateResponse,
  BotSetupState,
} from "./types";
