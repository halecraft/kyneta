// server — barrel export for @kyneta/unix-socket-transport/server.
//
// This is the server-side entry point. It exports everything needed
// to create a unix socket server transport.

// ---------------------------------------------------------------------------
// Server transport
// ---------------------------------------------------------------------------

export {
  UnixSocketServerTransport,
  type UnixSocketServerOptions,
  type UnixSocketListener,
} from "./server-transport.js"

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export { UnixSocketConnection } from "./connection.js"

// ---------------------------------------------------------------------------
// Shared types + wrappers
// ---------------------------------------------------------------------------

export type {
  BunSocketHandlers,
  BunUnixSocketLike,
  DisconnectReason,
  NodeUnixSocketLike,
  UnixSocket,
} from "./types.js"

export { wrapBunUnixSocket, wrapNodeUnixSocket } from "./types.js"