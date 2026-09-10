// === Result Type ===
// The engine's channel for expected failures: stratification errors, host
// registration errors. Owned by the Datalog package; perspective imports it
// from here rather than keeping a second definition.

/**
 * A discriminated union representing success or failure.
 *
 * - `{ ok: true, value: T }` — success
 * - `{ ok: false, error: E }` — expected failure
 *
 * Used for expected failures throughout the engine.
 * Unexpected failures (programmer errors) throw.
 */
export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

/** Construct a success result. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

/** Construct a failure result. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}
