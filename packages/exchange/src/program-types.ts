// program-types — shared types and combinators for TEA programs.
//
// Both the session program and sync program follow the same TEA pattern:
// pure update functions that return a transition triple. This module
// provides the shared vocabulary for that pattern.

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// TRANSITION — the co-product of a state transition
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * The co-product of a state transition: new state, effect(s), and
 * observation(s).
 *
 * - **Model**: the new state after the transition
 * - **Effect**: side effects to execute (send messages, start timers, etc.)
 * - **Notification**: observations to broadcast (peer events, ready state)
 *
 * Both the session and sync programs return this triple from every
 * handler. Effects change the world; notifications observe what changed.
 */
export type Transition<M, E, N> = [model: M, effect?: E, notification?: N]

// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=
// COLLAPSE — variadic combinator for optional batching
// =-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=-=

/**
 * Collapse an array of optional items into a single item, batching
 * if necessary.
 *
 * - 0 defined items → `undefined`
 * - 1 defined item → that item (unwrapped)
 * - N defined items → `wrap(items)` (caller provides the batch constructor)
 *
 * This is the generic core of `batchEffects` and `batchNotifications`
 * in both programs. Each program instantiates it with its own batch
 * wrapper (e.g. `{ type: "batch", effects }` for effects).
 */
export function collapse<T>(
  items: (T | undefined)[],
  wrap: (items: T[]) => T,
): T | undefined {
  const filtered = items.filter((x): x is T => x !== undefined)
  if (filtered.length === 0) return undefined
  if (filtered.length === 1) return filtered[0]
  return wrap(filtered)
}
