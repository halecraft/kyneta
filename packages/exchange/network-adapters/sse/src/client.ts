// client — barrel export for @kyneta/sse-network-adapter/client.
//
// This is the client-side entry point. It exports everything needed
// to create an SSE client adapter for browser connections.

// ---------------------------------------------------------------------------
// Client adapter + factory function
// ---------------------------------------------------------------------------

export {
  SseClientAdapter,
  createSseClient,
  DEFAULT_FRAGMENT_THRESHOLD,
  type SseClientOptions,
  type DisconnectReason,
  type SseClientState,
  type SseClientLifecycleEvents,
} from "./client-adapter.js"

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export { SseClientStateMachine } from "./client-state-machine.js"

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type { StateTransition, TransitionListener } from "./types.js"