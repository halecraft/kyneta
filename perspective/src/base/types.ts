// === Shared Base Types ===
// Used by both the Datalog evaluator and the kernel layer.
// Extracted here so neither layer depends on the other for
// fundamental identity and value types.
//
// Convention: `Uint8Array` immutability.
// Uint8Array is inherently mutable in JavaScript. All code in this codebase
// treats Uint8Array values as logically immutable — never call .set(), .fill(),
// or mutate buffer contents after construction. Enforced by convention, not
// the type system.

// ---------------------------------------------------------------------------
// Identity (§1)
// ---------------------------------------------------------------------------

/**
 * Peer identifier — public key or hash thereof.
 *
 * In production this is a public key. For testing we use human-readable
 * strings like "alice", "bob".
 */
export type PeerID = string;

/**
 * Monotonically increasing per-peer operation counter.
 *
 * Must satisfy: `Number.isSafeInteger(x) && x >= 0`.
 * Enforced at Agent construction and store insertion boundaries.
 */
export type Counter = number;

/**
 * Lamport timestamp for causal ordering.
 *
 * Must satisfy: `Number.isSafeInteger(x) && x >= 0`.
 * Enforced at Agent construction and store insertion boundaries.
 */
export type Lamport = number;

/**
 * Constraint Id — globally unique identifier for a constraint.
 *
 * The pair (peer, counter) is globally unique because each peer
 * maintains a monotonically increasing counter.
 */
export interface CnId {
  readonly peer: PeerID;
  readonly counter: Counter;
}

// ---------------------------------------------------------------------------
// Safe-integer validation
// ---------------------------------------------------------------------------

/**
 * Check that a number is a safe unsigned integer (0 ≤ x ≤ 2^53 − 1).
 *
 * Structural integer fields (counter, lamport, layer) must pass this check.
 * See unified-engine.md §1 for rationale.
 */
export function isSafeUint(x: number): boolean {
  return Number.isSafeInteger(x) && x >= 0;
}

// ---------------------------------------------------------------------------
// Values (§3)
//
// `number` and `bigint` are distinct types with distinct comparison semantics.
// int(3n) and float(3.0) are NOT equal — this avoids precision-loss bugs
// across language boundaries. See unified-engine.md §3 for full rationale.
// ---------------------------------------------------------------------------

/**
 * The value domain for constraint payloads and Datalog terms.
 *
 * - `null`       — absence (for Map deletion via LWW)
 * - `boolean`    — true / false
 * - `number`     — IEEE 754 f64 (floats and safe integers)
 * - `bigint`     — arbitrary-precision integer
 * - `string`     — UTF-8 string
 * - `Uint8Array` — raw binary (logically immutable by convention)
 * - `{ ref }`    — reference to a structure constraint (for nesting)
 */
export type Value =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | { readonly ref: CnId };