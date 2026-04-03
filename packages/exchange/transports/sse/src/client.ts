// client — barrel export for @kyneta/sse-network-adapter/client.
//
// This is the client-side entry point. It exports everything needed
// to create an SSE client adapter for browser connections.

// ---------------------------------------------------------------------------
// Client adapter + factory function
// ---------------------------------------------------------------------------

export {
  createSseClient,
  DEFAULT_FRAGMENT_THRESHOLD,
  type DisconnectReason,
  type SseClientLifecycleEvents,
  type SseClientOptions,
  type SseClientState,
  SseClientTransport,
} from "./client-transport.js"

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export { SseClientStateMachine } from "./client-state-machine.js"

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type { StateTransition, TransitionListener } from "./types.js"
