// reconnect — shared reconnection scheduler for client transports.
//
// Extracts the reconnection logic that was byte-for-byte identical
// across WebsocketClientTransport and SseClientTransport. Provides
// a small FC/IS design:
//   - Backoff delay computation is pure (functional core)
//   - Timer scheduling and state machine transitions are imperative shell
//
// Any client transport with a ClientStateMachine whose states include
// "disconnected", "connecting" (with attempt), and "reconnecting"
// (with attempt + nextAttemptMs) can use this scheduler.

import type { ClientStateMachine } from "./client-state-machine.js"

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Reconnect configuration — shared across all client transports.
 */
export interface ReconnectOptions {
  enabled: boolean
  maxAttempts: number
  baseDelay: number
  maxDelay: number
}

/**
 * Default reconnection options.
 */
export const DEFAULT_RECONNECT: ReconnectOptions = {
  enabled: true,
  maxAttempts: 10,
  baseDelay: 1000,
  maxDelay: 30000,
}

// ---------------------------------------------------------------------------
// Functional core — pure backoff computation
// ---------------------------------------------------------------------------

/**
 * Compute the reconnection delay for a given attempt number.
 *
 * Uses exponential backoff with jitter, clamped to maxDelay.
 * Pure function — no side effects.
 *
 * @param attempt - The 1-based attempt number
 * @param baseDelay - Base delay in ms
 * @param maxDelay - Maximum delay in ms
 * @param jitter - Random jitter in ms (injected for testability)
 */
export function computeBackoffDelay(
  attempt: number,
  baseDelay: number,
  maxDelay: number,
  jitter: number,
): number {
  return Math.min(baseDelay * 2 ** (attempt - 1) + jitter, maxDelay)
}

// ---------------------------------------------------------------------------
// Scheduler interface
// ---------------------------------------------------------------------------

/**
 * Shared reconnection scheduler for client transports.
 *
 * Manages the reconnection state machine transitions and exponential
 * backoff timing. The caller provides:
 * - The state machine (to read current state and transition)
 * - The connect function (to call on retry)
 * - The reconnect options (merged with defaults)
 *
 * FC/IS: the backoff delay computation is pure; the timer scheduling
 * and state machine transitions are the imperative shell.
 */
export interface ReconnectScheduler {
  /** Schedule a reconnection or transition to disconnected. */
  schedule(reason: { type: string; [key: string]: unknown }): void
  /** Cancel any pending reconnection timer. */
  cancel(): void
  /** Set whether reconnection is allowed (false during intentional stop). */
  setEnabled(enabled: boolean): void
}

// ---------------------------------------------------------------------------
// Scheduler parameters
// ---------------------------------------------------------------------------

/**
 * Parameters for creating a reconnect scheduler.
 *
 * The state machine's state type must include at least:
 * - `{ status: "disconnected"; reason?: ... }`
 * - `{ status: "connecting"; attempt: number }`
 * - `{ status: "reconnecting"; attempt: number; nextAttemptMs: number }`
 *
 * The scheduler reads state via `getState()` and pattern-matches on
 * `status` — it does not need to know the full state type.
 */
export interface ReconnectSchedulerParams {
  stateMachine: ClientStateMachine<any>
  connectFn: () => void
  options: Partial<ReconnectOptions>
  /** Inject a random jitter source for deterministic testing. Default: `() => Math.random() * 1000`. */
  jitterFn?: () => number
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a shared reconnection scheduler for a client transport.
 *
 * Encapsulates the reconnection state machine transitions, exponential
 * backoff timing, and timer lifecycle. Replaces the `#scheduleReconnect`,
 * `#clearReconnectTimer`, and `#shouldReconnect` patterns that were
 * duplicated across WebSocket and SSE client transports.
 */
export function createReconnectScheduler(
  params: ReconnectSchedulerParams,
): ReconnectScheduler {
  const {
    stateMachine,
    connectFn,
    jitterFn = () => Math.random() * 1000,
  } = params
  const opts: ReconnectOptions = { ...DEFAULT_RECONNECT, ...params.options }

  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  let enabled = true

  function cancel(): void {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer)
      reconnectTimer = undefined
    }
  }

  function setEnabled(value: boolean): void {
    enabled = value
  }

  function schedule(reason: { type: string; [key: string]: unknown }): void {
    const currentState = stateMachine.getState()

    // If already disconnected, don't transition again
    if (currentState.status === "disconnected") {
      return
    }

    if (!enabled || !opts.enabled) {
      stateMachine.transition({ status: "disconnected", reason })
      return
    }

    // Get current attempt count from state
    const currentAttempt =
      currentState.status === "reconnecting"
        ? (currentState as { attempt: number }).attempt
        : currentState.status === "connecting"
          ? (currentState as { attempt: number }).attempt
          : 0

    if (currentAttempt >= opts.maxAttempts) {
      stateMachine.transition({
        status: "disconnected",
        reason: { type: "max-retries-exceeded", attempts: currentAttempt },
      })
      return
    }

    const nextAttempt = currentAttempt + 1

    // Exponential backoff with jitter (pure computation)
    const delay = computeBackoffDelay(
      nextAttempt,
      opts.baseDelay,
      opts.maxDelay,
      jitterFn(),
    )

    stateMachine.transition({
      status: "reconnecting",
      attempt: nextAttempt,
      nextAttemptMs: delay,
    })

    reconnectTimer = setTimeout(() => {
      connectFn()
    }, delay)
  }

  return { schedule, cancel, setEnabled }
}
