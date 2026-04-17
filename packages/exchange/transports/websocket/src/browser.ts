// browser — barrel export for @kyneta/websocket-transport/browser.
//
// This is the browser-side entry point. It exports everything needed
// to create a Websocket client transport for browser-to-server connections.
//
// Service-to-service connections (with headers) are in `./server`.
// The `wrapStandardWebsocket` wrapper is a server-side concern — use `./server`.

// ---------------------------------------------------------------------------
// Client program (pure Mealy machine)
// ---------------------------------------------------------------------------

export {
  createWsClientProgram,
  type WsClientEffect,
  type WsClientMsg,
  type WsClientProgramOptions,
} from "./client-program.js"

// ---------------------------------------------------------------------------
// Client transport + factory function
// ---------------------------------------------------------------------------

export {
  createWebsocketClient,
  DEFAULT_FRAGMENT_THRESHOLD,
  type WebsocketClientLifecycleEvents,
  type WebsocketClientOptions,
  WebsocketClientTransport,
} from "./client-transport.js"

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type {
  DisconnectReason,
  Socket,
  SocketReadyState,
  TransitionListener,
  WebSocketCloseEvent,
  WebSocketConstructor,
  WebSocketLike,
  WebSocketMessageEvent,
  WebsocketClientState,
  WebsocketClientStateTransition,
} from "./types.js"

export { READY_STATE } from "./types.js"
