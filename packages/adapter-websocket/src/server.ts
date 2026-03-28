// server — barrel export for @kyneta/adapter-websocket/server.
//
// This is the server-side entry point. It exports everything needed
// to create a Websocket server adapter with any framework.

// ---------------------------------------------------------------------------
// Server adapter
// ---------------------------------------------------------------------------

export {
  WebsocketServerAdapter,
  type WebsocketServerAdapterOptions,
} from "./server-adapter.js"

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export {
  WebsocketConnection,
  DEFAULT_FRAGMENT_THRESHOLD,
  type WebsocketConnectionConfig,
} from "./connection.js"

// ---------------------------------------------------------------------------
// Shared types + wrappers
// ---------------------------------------------------------------------------

export type {
  Socket,
  SocketReadyState,
  DisconnectReason,
  WebsocketConnectionOptions,
  WebsocketConnectionHandle,
  WebsocketConnectionResult,
  NodeWebsocketLike,
} from "./types.js"

export { wrapStandardWebsocket, wrapNodeWebsocket } from "./types.js"