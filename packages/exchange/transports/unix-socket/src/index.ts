// @kyneta/unix-socket-transport — unix domain socket transport.

// Server transport
export {
  UnixSocketServerTransport,
  type UnixSocketServerOptions,
  type UnixSocketListener,
  type OnConnectionCallback,
} from "./server-transport.js"

// Client transport + factory
export {
  createUnixSocketClient,
  UnixSocketClientTransport,
  type UnixSocketClientOptions,
  type UnixSocketClientStateTransition,
  type DisconnectReason,
  type UnixSocketClientState,
} from "./client-transport.js"

// Connection
export { UnixSocketConnection } from "./connection.js"

// Shared types + wrappers
export type {
  BunSocketHandlers,
  BunUnixSocketLike,
  NodeUnixSocketLike,
  UnixSocket,
} from "./types.js"
export { wrapBunUnixSocket, wrapNodeUnixSocket } from "./types.js"

// Platform-abstracted connect/listen
export { connect } from "./connect.js"
export { listen } from "./listen.js"

// Peer — leaderless topology negotiation
export {
  createUnixSocketPeer,
  decideRole,
  type UnixSocketPeer,
  type UnixSocketPeerOptions,
  type ProbeResult,
  type NegotiationDecision,
} from "./peer.js"