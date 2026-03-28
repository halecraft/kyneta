// bun — barrel export for @kyneta/websocket-transport/bun.
//
// This is the Bun-specific entry point. It exports everything needed
// to integrate WebsocketServerAdapter with Bun's WebSocket API.

// ---------------------------------------------------------------------------
// Bun wrappers
// ---------------------------------------------------------------------------

export {
  type BunWebsocketData,
  wrapBunWebsocket,
  createBunWebsocketHandlers,
} from "./bun-websocket.js"

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type {
  Socket,
  SocketReadyState,
  DisconnectReason,
} from "./types.js"