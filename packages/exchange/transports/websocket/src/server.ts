// server — barrel export for @kyneta/websocket-network-adapter/server.
//
// This is the server-side entry point. It exports everything needed
// to create a Websocket server adapter with any framework.

// ---------------------------------------------------------------------------
// Server adapter
// ---------------------------------------------------------------------------

export {
  WebsocketServerTransport,
  type WebsocketServerTransportOptions,
} from "./server-transport.js"

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export {
  DEFAULT_FRAGMENT_THRESHOLD,
  WebsocketConnection,
  type WebsocketConnectionConfig,
} from "./connection.js"

// ---------------------------------------------------------------------------
// Shared types + wrappers
// ---------------------------------------------------------------------------

export type {
  DisconnectReason,
  NodeWebsocketLike,
  Socket,
  SocketReadyState,
  WebsocketConnectionHandle,
  WebsocketConnectionOptions,
  WebsocketConnectionResult,
} from "./types.js"

export { wrapNodeWebsocket, wrapStandardWebsocket } from "./types.js"
