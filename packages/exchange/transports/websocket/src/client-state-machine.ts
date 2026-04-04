// client-state-machine — Websocket client state machine.
//
// Thin wrapper around the generic ClientStateMachine<S> from @kyneta/exchange,
// providing websocket-specific convenience helpers (isConnectedOrReady, isReady)
// and the 5-state transition map.
//
// States: disconnected → connecting → connected → ready
//                            ↓            ↓         ↓
//                       reconnecting ← ─ ┴ ─ ─ ─ ─ ┘
//                            ↓
//                       connecting (retry)
//                            ↓
//                       disconnected (max retries)

import { ClientStateMachine } from "@kyneta/transport"
import type { WebsocketClientState } from "./types.js"

// ---------------------------------------------------------------------------
// Websocket transition map
// ---------------------------------------------------------------------------

const WS_VALID_TRANSITIONS: Record<string, string[]> = {
  disconnected: ["connecting"],
  connecting: ["connected", "disconnected", "reconnecting"],
  connected: ["ready", "disconnected", "reconnecting"],
  ready: ["disconnected", "reconnecting"],
  reconnecting: ["connecting", "disconnected"],
}

// ---------------------------------------------------------------------------
// WebsocketClientStateMachine
// ---------------------------------------------------------------------------

/**
 * Observable state machine for Websocket client connection lifecycle.
 *
 * Extends the generic `ClientStateMachine<WebsocketClientState>` with
 * websocket-specific convenience helpers.
 *
 * Usage:
 * ```typescript
 * const sm = new WebsocketClientStateMachine()
 *
 * sm.subscribeToTransitions(({ from, to }) => {
 *   console.log(`${from.status} → ${to.status}`)
 * })
 *
 * sm.transition({ status: "connecting", attempt: 1 })
 * sm.transition({ status: "connected" })
 * sm.transition({ status: "ready" })
 *
 * // Transitions are delivered asynchronously via microtask
 * // Listener will see: disconnected → connecting, connecting → connected, connected → ready
 * ```
 */
export class WebsocketClientStateMachine extends ClientStateMachine<WebsocketClientState> {
  constructor() {
    super({
      initialState: { status: "disconnected" },
      validTransitions: WS_VALID_TRANSITIONS,
    })
  }

  /**
   * Check if the client is in a "connected" state (either connected or ready).
   */
  isConnectedOrReady(): boolean {
    const s = this.getStatus()
    return s === "connected" || s === "ready"
  }

  /**
   * Check if the client is ready (server ready signal received).
   */
  isReady(): boolean {
    return this.getStatus() === "ready"
  }
}
