// client — barrel export for @kyneta/websocket-network-adapter/client.
//
// This is the client-side entry point. It exports everything needed
// to create a Websocket client adapter for browser or service connections.

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
// Client transport + factory functions
// ---------------------------------------------------------------------------

export {
  createServiceWebsocketClient,
  createWebsocketClient,
  DEFAULT_FRAGMENT_THRESHOLD,
  type DisconnectReason,
  type ServiceWebsocketClientOptions,
  type WebsocketClientLifecycleEvents,
  type WebsocketClientOptions,
  type WebsocketClientState,
  type WebsocketClientStateTransition,
  WebsocketClientTransport,
} from "./client-transport.js"

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type {
  Socket,
  SocketReadyState,
  TransitionListener,
} from "./types.js"

export { wrapStandardWebsocket } from "./types.js"
