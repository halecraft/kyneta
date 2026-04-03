// client — barrel export for @kyneta/unix-socket-transport/client.
//
// This is the client-side entry point. It exports everything needed
// to create a unix socket client transport for service connections.

// ---------------------------------------------------------------------------
// Client transport + factory function
// ---------------------------------------------------------------------------

export {
  createUnixSocketClient,
  type DisconnectReason,
  type UnixSocketClientOptions,
  type UnixSocketClientState,
  type UnixSocketClientStateTransition,
  UnixSocketClientTransport,
} from "./client-transport.js"

// ---------------------------------------------------------------------------
// Shared types + wrappers
// ---------------------------------------------------------------------------

export type {
  BunSocketHandlers,
  BunUnixSocketLike,
  NodeUnixSocketLike,
  UnixSocket,
} from "./types.js"

export { wrapBunUnixSocket, wrapNodeUnixSocket } from "./types.js"