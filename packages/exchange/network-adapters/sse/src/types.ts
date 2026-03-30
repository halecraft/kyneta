// types — SSE-specific types for @kyneta/sse-network-adapter.
//
// SSE has a simpler lifecycle than WebSocket — no "ready" state because
// there's no transport-level handshake. The connection is usable as soon
// as EventSource.onopen fires.
//
// DisconnectReason is SSE-specific: no "closed" variant (SSE doesn't have
// close codes) and no "not-started" variant (no "ready" gate).

import type { PeerId } from "@kyneta/exchange"

// Re-export specialized transition types from generic state machine
export type { StateTransition, TransitionListener } from "@kyneta/exchange"

// ---------------------------------------------------------------------------
// Disconnect reason
// ---------------------------------------------------------------------------

/**
 * Discriminated union describing why an SSE connection was lost.
 *
 * Unlike WebSocket's DisconnectReason, SSE does not have:
 * - `{ type: "closed"; code; reason }` — SSE has no close codes
 * - `{ type: "not-started" }` — SSE has no "ready" gate
 */
export type DisconnectReason =
  | { type: "intentional" }
  | { type: "error"; error: Error }
  | { type: "max-retries-exceeded"; attempts: number }

// ---------------------------------------------------------------------------
// Connection state (for client adapter observability)
// ---------------------------------------------------------------------------

/**
 * All possible states of the SSE client.
 *
 * State machine transitions (4 states, no "ready"):
 * ```
 * disconnected → connecting → connected
 *                    ↓            ↓
 *               reconnecting ← ─ ─┘
 *                    ↓
 *               connecting (retry)
 *                    ↓
 *               disconnected (max retries)
 * ```
 */
export type SseClientState =
  | { status: "disconnected"; reason?: DisconnectReason }
  | { status: "connecting"; attempt: number }
  | { status: "connected" }
  | { status: "reconnecting"; attempt: number; nextAttemptMs: number }

/**
 * A state transition event for SSE client states.
 * Specialized from the generic `StateTransition<S>`.
 */
export type { StateTransition as SseClientStateTransition } from "@kyneta/exchange"

// ---------------------------------------------------------------------------
// Connection handle — used by server adapter
// ---------------------------------------------------------------------------

/**
 * Handle for an active SSE connection (server-side).
 */
export interface SseConnectionHandle {
  /** The peer ID for this connection. */
  readonly peerId: PeerId
  /** The channel ID for this connection. */
  readonly channelId: number
  /** Disconnect this connection. */
  disconnect(): void
}

/**
 * Result of registering an SSE connection on the server.
 */
export interface SseConnectionResult {
  /** The connection handle for managing this peer. */
  connection: SseConnectionHandle
}

// ---------------------------------------------------------------------------
// Client options
// ---------------------------------------------------------------------------

/**
 * Lifecycle event callbacks for the SSE client.
 */
export interface SseClientLifecycleEvents {
  /** Called on every state transition (delivered async via microtask). */
  onStateChange?: (transition: {
    from: SseClientState
    to: SseClientState
    timestamp: number
  }) => void

  /** Called when the connection is lost. */
  onDisconnect?: (reason: DisconnectReason) => void

  /** Called when a reconnection attempt is scheduled. */
  onReconnecting?: (attempt: number, nextAttemptMs: number) => void

  /** Called when reconnection succeeds after a previous connection. */
  onReconnected?: () => void
}