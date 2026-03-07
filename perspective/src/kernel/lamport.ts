// === Lamport Clock ===
// Implements a Lamport logical clock for causal ordering.
//
// The Lamport clock is a monotonically increasing counter used for
// conflict resolution (LWW) and establishing happens-before relationships.
//
// Rules (standard Lamport timestamp):
// - On local event: lamport = lamport + 1
// - On receive: lamport = max(local, received) + 1
//
// See unified-engine.md §1.

import type { Lamport } from './types.js';

// ---------------------------------------------------------------------------
// Lamport Clock State
// ---------------------------------------------------------------------------

/**
 * A Lamport clock instance.
 *
 * Mutable — this is one of the few mutable objects in the system,
 * alongside the Agent that owns it.
 */
export interface LamportClock {
  /** Current Lamport timestamp. */
  value: Lamport;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create a new Lamport clock starting at 0.
 */
export function createLamportClock(): LamportClock {
  return { value: 0 };
}

/**
 * Create a Lamport clock starting at a specific value.
 */
export function createLamportClockAt(value: Lamport): LamportClock {
  return { value };
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Tick the clock for a local event.
 *
 * Increments the clock by 1 and returns the new value.
 * The returned value is the timestamp to assign to the new event.
 */
export function tick(clock: LamportClock): Lamport {
  clock.value += 1;
  return clock.value;
}

/**
 * Merge the clock with a received timestamp.
 *
 * Sets the clock to `max(local, received) + 1` and returns the new value.
 * This ensures the clock is always strictly greater than both the local
 * value and any received timestamp.
 */
export function merge(clock: LamportClock, received: Lamport): Lamport {
  clock.value = Math.max(clock.value, received) + 1;
  return clock.value;
}

/**
 * Update the clock to be at least as large as the received timestamp,
 * without ticking.
 *
 * Sets the clock to `max(local, received)`. Unlike `merge`, this does
 * NOT add 1 — it's used when observing a constraint without producing
 * a new one (e.g., during store merge/import).
 */
export function observe(clock: LamportClock, received: Lamport): Lamport {
  clock.value = Math.max(clock.value, received);
  return clock.value;
}

/**
 * Get the current clock value without modifying it.
 */
export function current(clock: LamportClock): Lamport {
  return clock.value;
}