// client-program — pure Mealy machine for SSE client connection lifecycle.
//
// The client program encodes every state transition and effect as data.
// The imperative shell (client-transport.ts) interprets effects as I/O.
// Tests assert on data — no EventSource, no timing, never flaky.
//
// Algebra: Program<SseClientMsg, SseClientState, SseClientEffect>
// Interpreter: client-transport.ts executeClientEffect()

import type { Program } from "@kyneta/machine"
import type { ReconnectOptions } from "@kyneta/transport"
import { computeBackoffDelay, DEFAULT_RECONNECT } from "@kyneta/transport"

import type { DisconnectReason, SseClientState } from "./types.js"

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type SseClientMsg =
  | { type: "start" }
  | { type: "event-source-opened" }
  | { type: "event-source-error" }
  | { type: "stop" }
  | { type: "reconnect-timer-fired" }

// ---------------------------------------------------------------------------
// Effects (data — interpreted by the imperative shell)
// ---------------------------------------------------------------------------

export type SseClientEffect =
  | { type: "create-event-source"; url: string; attempt: number }
  | { type: "close-event-source" }
  | { type: "add-channel-and-establish" }
  | { type: "remove-channel" }
  | { type: "start-reconnect-timer"; delayMs: number }
  | { type: "cancel-reconnect-timer" }
  | { type: "abort-pending-posts" }

// ---------------------------------------------------------------------------
// Program factory
// ---------------------------------------------------------------------------

export interface SseClientProgramOptions {
  url: string
  reconnect?: Partial<ReconnectOptions>
  /** Inject jitter source for deterministic testing. Default: () => Math.random() * 1000 */
  jitterFn?: () => number
}

/**
 * Create the SSE client connection lifecycle program — a pure Mealy machine.
 *
 * The returned `Program<SseClientMsg, SseClientState, SseClientEffect>`
 * encodes every state transition and effect as inspectable data. The imperative
 * shell interprets `SseClientEffect` as actual I/O.
 */
export function createSseClientProgram(
  options: SseClientProgramOptions,
): Program<SseClientMsg, SseClientState, SseClientEffect> {
  const { url, jitterFn = () => Math.random() * 1000 } = options
  const reconnect: ReconnectOptions = {
    ...DEFAULT_RECONNECT,
    ...options.reconnect,
  }

  /**
   * Attempt to transition into reconnecting, or give up and disconnect.
   *
   * Pure — computes the next state and effects from the current attempt
   * count and reconnect configuration. Returns a tuple suitable for
   * spreading into an `update` return.
   */
  function tryReconnect(
    currentAttempt: number,
    reason: DisconnectReason,
    ...extraEffects: SseClientEffect[]
  ): [SseClientState, ...SseClientEffect[]] {
    if (!reconnect.enabled) {
      return [{ status: "disconnected", reason }, ...extraEffects]
    }

    if (currentAttempt >= reconnect.maxAttempts) {
      return [
        {
          status: "disconnected",
          reason: { type: "max-retries-exceeded", attempts: currentAttempt },
        },
        ...extraEffects,
      ]
    }

    const delay = computeBackoffDelay(
      currentAttempt + 1,
      reconnect.baseDelay,
      reconnect.maxDelay,
      jitterFn(),
    )

    return [
      {
        status: "reconnecting",
        attempt: currentAttempt + 1,
        nextAttemptMs: delay,
      },
      ...extraEffects,
      { type: "start-reconnect-timer", delayMs: delay },
    ]
  }

  return {
    init: [{ status: "disconnected" }],

    update(msg, model): [SseClientState, ...SseClientEffect[]] {
      switch (msg.type) {
        // -----------------------------------------------------------------
        // start
        // -----------------------------------------------------------------
        case "start": {
          if (model.status !== "disconnected") return [model]
          return [
            { status: "connecting", attempt: 1 },
            { type: "create-event-source", url, attempt: 1 },
          ]
        }

        // -----------------------------------------------------------------
        // event-source-opened
        // -----------------------------------------------------------------
        case "event-source-opened": {
          if (model.status !== "connecting") return [model]
          return [
            { status: "connected" },
            { type: "add-channel-and-establish" },
          ]
        }

        // -----------------------------------------------------------------
        // event-source-error
        // -----------------------------------------------------------------
        case "event-source-error": {
          const reason: DisconnectReason = {
            type: "error",
            error: new Error("EventSource connection error"),
          }

          if (model.status === "connecting") {
            return tryReconnect(model.attempt, reason, {
              type: "close-event-source",
            })
          }

          if (model.status === "connected") {
            return tryReconnect(
              0,
              reason,
              { type: "remove-channel" },
              { type: "close-event-source" },
              { type: "abort-pending-posts" },
            )
          }

          return [model]
        }

        // -----------------------------------------------------------------
        // reconnect-timer-fired
        // -----------------------------------------------------------------
        case "reconnect-timer-fired": {
          if (model.status !== "reconnecting") return [model]
          return [
            { status: "connecting", attempt: model.attempt },
            { type: "create-event-source", url, attempt: model.attempt },
          ]
        }

        // -----------------------------------------------------------------
        // stop
        // -----------------------------------------------------------------
        case "stop": {
          if (model.status === "disconnected") return [model]

          const effects: SseClientEffect[] = [
            { type: "cancel-reconnect-timer" },
          ]

          if (model.status === "connecting") {
            effects.push({ type: "close-event-source" })
          }

          if (model.status === "connected") {
            effects.push(
              { type: "close-event-source" },
              { type: "remove-channel" },
              { type: "abort-pending-posts" },
            )
          }

          return [
            { status: "disconnected", reason: { type: "intentional" } },
            ...effects,
          ]
        }
      }
    },
  }
}
