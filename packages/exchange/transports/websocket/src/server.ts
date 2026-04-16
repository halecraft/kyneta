// server — barrel export for @kyneta/websocket-transport/server.
//
// This is the server-side entry point. It exports everything needed
// to create a Websocket server transport with any framework, plus
// the service-to-service client factory for backend connections.

// ---------------------------------------------------------------------------
// Server transport
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
// Service-to-service client (backend connections with headers)
// ---------------------------------------------------------------------------

export {
  createServiceWebsocketClient,
  type ServiceWebsocketClientOptions,
} from "./service-client.js"

// ---------------------------------------------------------------------------
// Shared types + wrappers
// ---------------------------------------------------------------------------

export type {
  DisconnectReason,
  NodeWebsocketLike,
  Socket,
  SocketReadyState,
  WebSocketCloseEvent,
  WebSocketConstructor,
  WebSocketLike,
  WebSocketMessageEvent,
  WebsocketConnectionHandle,
  WebsocketConnectionOptions,
  WebsocketConnectionResult,
} from "./types.js"

export { READY_STATE, wrapNodeWebsocket, wrapStandardWebsocket } from "./types.js"