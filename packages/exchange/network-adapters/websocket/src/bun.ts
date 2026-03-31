// bun — barrel export for @kyneta/websocket-network-adapter/bun.
//
// This is the Bun-specific entry point. It exports everything needed
// to integrate WebsocketServerAdapter with Bun's WebSocket API.

// ---------------------------------------------------------------------------
// Bun wrappers
// ---------------------------------------------------------------------------

export {
  type BunWebsocketData,
  createBunWebsocketHandlers,
  wrapBunWebsocket,
} from "./bun-websocket.js"

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type {
  DisconnectReason,
  Socket,
  SocketReadyState,
} from "./types.js"
