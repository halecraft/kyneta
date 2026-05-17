// result — discriminated union for fallible operations.
//
// A value-level Result type that forces callers to inspect success/failure
// before accessing the payload. Used throughout the wire pipeline for
// operations that can fail with typed errors (fragmentation, decoding,
// alias resolution, validation).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Ok<T> = { readonly ok: true; readonly value: T }
export type Err<E> = { readonly ok: false; readonly error: E }
export type Result<T, E> = Ok<T> | Err<E>

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function ok<T>(value: T): Ok<T> {
  return { ok: true, value }
}

export function err<E>(error: E): Err<E> {
  return { ok: false, error }
}
