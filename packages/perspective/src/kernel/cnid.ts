// === CnId — Constraint Identifier ===
// Implements CnId creation, equality, comparison, and string serialization.
//
// A CnId uniquely identifies a constraint as the pair (peer, counter).
// See unified-engine.md §1.

import type { CnId, Counter, PeerID } from "./types.js"

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create a CnId from a peer and counter.
 */
export function createCnId(peer: PeerID, counter: Counter): CnId {
  return { peer, counter }
}

// ---------------------------------------------------------------------------
// Equality
// ---------------------------------------------------------------------------

/**
 * Check if two CnIds are equal (same peer and counter).
 */
export function cnIdEquals(a: CnId, b: CnId): boolean {
  return a.peer === b.peer && a.counter === b.counter
}

/**
 * Check if two nullable CnIds are equal.
 */
export function cnIdNullableEquals(a: CnId | null, b: CnId | null): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return cnIdEquals(a, b)
}

// ---------------------------------------------------------------------------
// Comparison / Ordering
// ---------------------------------------------------------------------------

/**
 * Compare two CnIds for ordering.
 *
 * Ordering: peer lexicographic first, then counter numeric.
 *
 * Returns:
 * - negative if a < b
 * - 0 if a === b
 * - positive if a > b
 */
export function cnIdCompare(a: CnId, b: CnId): number {
  if (a.peer !== b.peer) {
    return a.peer < b.peer ? -1 : 1
  }
  return a.counter - b.counter
}

// ---------------------------------------------------------------------------
// String Serialization
// ---------------------------------------------------------------------------

/**
 * Convert a CnId to a deterministic string representation.
 *
 * Format: "peer@counter" (e.g., "alice@5").
 * Used as Map/Set keys throughout the kernel.
 */
export function cnIdToString(id: CnId): string {
  return `${id.peer}@${id.counter}`
}

/**
 * Parse a CnId from its string representation.
 *
 * @throws Error if the string is not in valid "peer@counter" format.
 */
export function cnIdFromString(str: string): CnId {
  const atIndex = str.lastIndexOf("@")
  if (atIndex === -1) {
    throw new Error(`Invalid CnId string: ${str}`)
  }
  const peer = str.slice(0, atIndex)
  const counter = parseInt(str.slice(atIndex + 1), 10)
  if (Number.isNaN(counter)) {
    throw new Error(`Invalid CnId counter in: ${str}`)
  }
  return createCnId(peer, counter)
}

/**
 * Produce a deterministic string key for a CnId, suitable for use as a
 * Map key. This is the same as `cnIdToString` but named to clarify intent.
 */
export function cnIdKey(id: CnId): string {
  return cnIdToString(id)
}
