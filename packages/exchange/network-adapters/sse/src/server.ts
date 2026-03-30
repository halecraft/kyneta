// server — barrel export for @kyneta/sse-network-adapter/server.
//
// This is the server-side entry point. It exports everything needed
// to create an SSE server adapter with any framework.

// ---------------------------------------------------------------------------
// Server adapter
// ---------------------------------------------------------------------------

export {
  SseServerAdapter,
  type SseServerAdapterOptions,
} from "./server-adapter.js"

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

export {
  SseConnection,
  DEFAULT_FRAGMENT_THRESHOLD,
  type SseConnectionConfig,
} from "./connection.js"

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type {
  DisconnectReason,
  SseConnectionHandle,
  SseConnectionResult,
} from "./types.js"