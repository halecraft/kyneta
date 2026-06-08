// drain — pure scheduling core for graceful connection draining.
//
// On a rolling deploy the server must close its open WebSockets *staggered*
// rather than all in one tick, or every disconnected client reconnects inside
// the same narrow window and stampedes the freshly-started instance. This
// module is the functional core of that stagger: `planDrainSchedule` is a pure
// function from peer IDs + a jitter window to a list of per-connection close
// offsets. The imperative shell (`WebsocketServerTransport.drainConnections`)
// interprets the schedule with real timers and awaits socket closure.
//
// Keeping the schedule pure mirrors `computeBackoffDelay`/`shouldReconnect` in
// @kyneta/transport: the `[0, 1)` random source is injected so tests pin
// deterministic offsets without sockets or timers.

import type { PeerId } from "@kyneta/transport"

// ---------------------------------------------------------------------------
// Options + result types
// ---------------------------------------------------------------------------

/**
 * Options for {@link WebsocketServerTransport.drainConnections}, also usable as
 * `WebsocketServerTransportOptions.drain` construction-time defaults. Every
 * field is optional; unset fields fall back to the {@link DEFAULT_DRAIN}
 * constants. Per-call options win over constructor defaults win over these.
 */
export interface DrainOptions {
  /** Max jitter window in ms; each connection closes at `random*window`. Default 5000. */
  windowMs?: number
  /** Close code sent to draining clients. Default 1001 (going away). */
  closeCode?: number
  /** Close reason text. Default "Server draining". */
  closeReason?: string
  /** Hard cap (ms after drain start) to await socket closure before giving up. Default `windowMs + 5000`. */
  deadlineMs?: number
  /** `[0, 1)` source for jitter. Default `Math.random`. */
  randomFn?: () => number
}

/** One scheduled close: peer `peerId` is closed `delayMs` after drain start. */
export interface DrainStep {
  readonly peerId: PeerId
  readonly delayMs: number
}

/**
 * Snapshot taken when the drain resolves. `timedOut` distinguishes the two
 * exit paths: `false` means every connection closed within the deadline,
 * `true` means the deadline fired first and `remaining` sockets are still open
 * (the caller may want to log them before a hard exit).
 */
export interface DrainResult {
  readonly closed: number
  readonly remaining: number
  readonly timedOut: boolean
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Hard-coded fallbacks for unset {@link DrainOptions} fields. */
export const DEFAULT_DRAIN = {
  windowMs: 5000,
  closeCode: 1001,
  closeReason: "Server draining",
  /** Grace added on top of `windowMs` to wait for the last sockets to close. */
  deadlineGraceMs: 5000,
} as const

/**
 * A {@link DrainOptions} with every field populated — the shape the imperative
 * shell actually consumes after merging per-call options over constructor
 * defaults over {@link DEFAULT_DRAIN}.
 */
export interface ResolvedDrainOptions {
  readonly windowMs: number
  readonly closeCode: number
  readonly closeReason: string
  readonly deadlineMs: number
  readonly randomFn: () => number
}

/**
 * Merge `perCall` over `defaults` over {@link DEFAULT_DRAIN} into a fully
 * populated option set. Pure. `deadlineMs` defaults relative to the *resolved*
 * `windowMs` so a caller that only overrides the window still gets a sensible
 * deadline.
 */
export function resolveDrainOptions(
  perCall: DrainOptions = {},
  defaults: DrainOptions = {},
): ResolvedDrainOptions {
  const windowMs =
    perCall.windowMs ?? defaults.windowMs ?? DEFAULT_DRAIN.windowMs
  return {
    windowMs,
    closeCode:
      perCall.closeCode ?? defaults.closeCode ?? DEFAULT_DRAIN.closeCode,
    closeReason:
      perCall.closeReason ?? defaults.closeReason ?? DEFAULT_DRAIN.closeReason,
    deadlineMs:
      perCall.deadlineMs ??
      defaults.deadlineMs ??
      windowMs + DEFAULT_DRAIN.deadlineGraceMs,
    randomFn: perCall.randomFn ?? defaults.randomFn ?? Math.random,
  }
}

// ---------------------------------------------------------------------------
// Functional core — schedule computation
// ---------------------------------------------------------------------------

/**
 * Assign each peer a close offset in `[0, windowMs)`.
 *
 * Pure and order-preserving: with a pinned `randomFn` the schedule is fully
 * deterministic. Edge cases: empty input → `[]`; `windowMs <= 0` → every step
 * `delayMs: 0` (degenerates to an immediate close of all connections, but the
 * shell still routes it through the same drain-await path).
 *
 * Offsets are floored to whole milliseconds — `setTimeout` truncates anyway,
 * and integer offsets make the schedule easier to assert on.
 */
export function planDrainSchedule(
  peerIds: readonly PeerId[],
  windowMs: number,
  randomFn: () => number,
): DrainStep[] {
  if (windowMs <= 0) {
    return peerIds.map(peerId => ({ peerId, delayMs: 0 }))
  }
  return peerIds.map(peerId => ({
    peerId,
    delayMs: Math.floor(randomFn() * windowMs),
  }))
}
