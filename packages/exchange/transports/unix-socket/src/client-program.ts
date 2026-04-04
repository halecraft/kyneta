// client-program — pure Mealy machine for unix socket client connection lifecycle.
//
// The client program encodes every state transition and effect as data.
// The imperative shell (client-transport.ts) interprets effects as I/O.
// Tests assert on data — no sockets, no timing, never flaky.
//
// Algebra: Program<UnixSocketClientMsg, UnixSocketClientState, UnixSocketClientEffect>
// Interpreter: client-transport.ts executeClientEffect()

import type { Program } from "@kyneta/machine"
import type { ReconnectOptions } from "@kyneta/transport"
import { computeBackoffDelay, DEFAULT_RECONNECT } from "@kyneta/transport"

import type { DisconnectReason, UnixSocketClientState } from "./types.js"

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type UnixSocketClientMsg =
  | { type: "start" }
  | { type: "connection-opened" }
  | { type: "connection-closed" }
  | { type: "connection-error"; error: Error; errno?: string }
  | { type: "reconnect-timer-fired" }
  | { type: "stop" }

// ---------------------------------------------------------------------------
// Effects (data — interpreted by the imperative shell)
// ---------------------------------------------------------------------------

export type UnixSocketClientEffect =
  | { type: "connect"; path: string; attempt: number }
  | { type: "close-connection" }
  | { type: "add-channel-and-establish" }
  | { type: "remove-channel" }
  | { type: "start-reconnect-timer"; delayMs: number }
  | { type: "cancel-reconnect-timer" }

// ---------------------------------------------------------------------------
// Program factory
// ---------------------------------------------------------------------------

export interface UnixSocketClientProgramOptions {
  path: string
  reconnect?: Partial<ReconnectOptions>
  /** Inject jitter source for deterministic testing. Default: () => Math.random() * 1000 */
  jitterFn?: () => number
}

/**
 * Create the client connection lifecycle program — a pure Mealy machine.
 *
 * The returned `Program<UnixSocketClientMsg, UnixSocketClientState, UnixSocketClientEffect>`
 * encodes every state transition and effect as inspectable data. The imperative
 * shell interprets `UnixSocketClientEffect` as actual I/O.
 */
export function createUnixSocketClientProgram(
  options: UnixSocketClientProgramOptions,
): Program<UnixSocketClientMsg, UnixSocketClientState, UnixSocketClientEffect> {
  const { path, jitterFn = () => Math.random() * 1000 } = options
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
    ...extraEffects: UnixSocketClientEffect[]
  ): [UnixSocketClientState, ...UnixSocketClientEffect[]] {
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

    update(msg, model): [UnixSocketClientState, ...UnixSocketClientEffect[]] {
      switch (msg.type) {
        // -----------------------------------------------------------------
        // start
        // -----------------------------------------------------------------
        case "start": {
          if (model.status !== "disconnected") return [model]
          return [
            { status: "connecting", attempt: 1 },
            { type: "connect", path, attempt: 1 },
          ]
        }

        // -----------------------------------------------------------------
        // connection-opened
        // -----------------------------------------------------------------
        case "connection-opened": {
          if (model.status !== "connecting") return [model]
          return [
            { status: "connected" },
            { type: "add-channel-and-establish" },
          ]
        }

        // -----------------------------------------------------------------
        // connection-error
        // -----------------------------------------------------------------
        case "connection-error": {
          const reason: DisconnectReason = {
            type: "error",
            error: msg.error,
            ...(msg.errno !== undefined ? { errno: msg.errno } : {}),
          }

          if (model.status === "connecting") {
            return tryReconnect(model.attempt, reason)
          }

          if (model.status === "connected") {
            return tryReconnect(0, reason, { type: "remove-channel" })
          }

          return [model]
        }

        // -----------------------------------------------------------------
        // connection-closed
        // -----------------------------------------------------------------
        case "connection-closed": {
          if (model.status !== "connected") return [model]

          if (!reconnect.enabled) {
            return [
              { status: "disconnected", reason: { type: "closed" } },
              { type: "remove-channel" },
            ]
          }

          return tryReconnect(0, { type: "closed" }, { type: "remove-channel" })
        }

        // -----------------------------------------------------------------
        // reconnect-timer-fired
        // -----------------------------------------------------------------
        case "reconnect-timer-fired": {
          if (model.status !== "reconnecting") return [model]
          return [
            { status: "connecting", attempt: model.attempt },
            { type: "connect", path, attempt: model.attempt },
          ]
        }

        // -----------------------------------------------------------------
        // stop
        // -----------------------------------------------------------------
        case "stop": {
          if (model.status === "disconnected") return [model]

          const effects: UnixSocketClientEffect[] = [
            { type: "cancel-reconnect-timer" },
          ]

          if (model.status === "connected") {
            effects.push(
              { type: "close-connection" },
              { type: "remove-channel" },
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
