// === Shared Result Type ===
// Used by both the Datalog evaluator and the kernel layer.
// Extracted here so neither layer depends on the other.

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
  | { readonly ok: false; readonly error: E };

/** Construct a success result. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Construct a failure result. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}