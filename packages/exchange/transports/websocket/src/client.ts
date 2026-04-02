// client — barrel export for @kyneta/websocket-network-adapter/client.
//
// This is the client-side entry point. It exports everything needed
// to create a Websocket client adapter for browser or service connections.

// ---------------------------------------------------------------------------
// Client adapter + factory functions
// ---------------------------------------------------------------------------

export {
  createServiceWebsocketClient,
  createWebsocketClient,
  DEFAULT_FRAGMENT_THRESHOLD,
  type DisconnectReason,
  type ServiceWebsocketClientOptions,
  WebsocketClientTransport,
  type WebsocketClientLifecycleEvents,
  type WebsocketClientOptions,
  type WebsocketClientState,
  type WebsocketClientStateTransition,
} from "./client-transport.js"

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
