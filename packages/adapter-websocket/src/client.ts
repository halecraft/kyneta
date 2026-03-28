// client — barrel export for @kyneta/adapter-websocket/client.
//
// This is the client-side entry point. It exports everything needed
// to create a Websocket client adapter for browser or service connections.

// ---------------------------------------------------------------------------
// Client adapter + factory functions
// ---------------------------------------------------------------------------

export {
  WebsocketClientAdapter,
  createWebsocketClient,
  createServiceWebsocketClient,
  DEFAULT_FRAGMENT_THRESHOLD,
  type WebsocketClientOptions,
  type WebsocketClientLifecycleEvents,
  type ServiceWebsocketClientOptions,
  type DisconnectReason,
  type WebsocketClientState,
  type WebsocketClientStateTransition,
} from "./client-adapter.js"

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export { WebsocketClientStateMachine } from "./client-state-machine.js"

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type {
  Socket,
  SocketReadyState,
  TransitionListener,
} from "./types.js"

export { wrapStandardWebsocket } from "./types.js"