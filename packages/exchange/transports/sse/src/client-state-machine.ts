// client-state-machine — SSE client state machine.
//
// Thin wrapper around the generic ClientStateMachine<S> from @kyneta/exchange,
// providing the SSE-specific 4-state transition map and an isConnected() helper.
//
// States: disconnected → connecting → connected
//                            ↓            ↓
//                       reconnecting ← ─ ─┘
//                            ↓
//                       connecting (retry)
//                            ↓
//                       disconnected (max retries)

import { ClientStateMachine } from "@kyneta/transport"
import type { SseClientState } from "./types.js"

// ---------------------------------------------------------------------------
// SSE transition map
// ---------------------------------------------------------------------------

const SSE_VALID_TRANSITIONS: Record<string, string[]> = {
  disconnected: ["connecting"],
  connecting: ["connected", "disconnected", "reconnecting"],
  connected: ["disconnected", "reconnecting"],
  reconnecting: ["connecting", "disconnected"],
}

// ---------------------------------------------------------------------------
// SseClientStateMachine
// ---------------------------------------------------------------------------

/**
 * Observable state machine for SSE client connection lifecycle.
 *
 * Extends the generic `ClientStateMachine<SseClientState>` with
 * an SSE-specific convenience helper. Unlike the WebSocket state machine,
 * SSE has no `"ready"` state — the connection is usable as soon as
 * `EventSource.onopen` fires.
 *
 * Usage:
 * ```typescript
 * const sm = new SseClientStateMachine()
 *
 * sm.subscribeToTransitions(({ from, to }) => {
 *   console.log(`${from.status} → ${to.status}`)
 * })
 *
 * sm.transition({ status: "connecting", attempt: 1 })
 * sm.transition({ status: "connected" })
 *
 * // Transitions are delivered asynchronously via microtask
 * // Listener will see: disconnected → connecting, connecting → connected
 * ```
 */
export class SseClientStateMachine extends ClientStateMachine<SseClientState> {
  constructor() {
    super({
      initialState: { status: "disconnected" },
      validTransitions: SSE_VALID_TRANSITIONS,
    })
  }

  /**
   * Check if the client is connected (EventSource open, channel established).
   */
  isConnected(): boolean {
    return this.getStatus() === "connected"
  }
}
