// client — barrel export for @kyneta/sse-transport/client.
//
// This is the client-side entry point. It exports everything needed
// to create an SSE client adapter for browser connections.

// ---------------------------------------------------------------------------
// Client transport + factory function
// ---------------------------------------------------------------------------

export {
  createSseClient,
  DEFAULT_FRAGMENT_THRESHOLD,
  type DisconnectReason,
  type SseClientLifecycleEvents,
  type SseClientOptions,
  type SseClientState,
  type SseClientStateTransition,
  SseClientTransport,
} from "./client-transport.js"

// ---------------------------------------------------------------------------
// Client program (pure Mealy machine)
// ---------------------------------------------------------------------------

export {
  createSseClientProgram,
  type SseClientEffect,
  type SseClientMsg,
  type SseClientProgramOptions,
} from "./client-program.js"

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export type { StateTransition, TransitionListener } from "@kyneta/machine"
