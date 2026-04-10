// version-vector — shared utilities for version vector lattice operations.
//
// Two algebraic operations over version vectors (Map<K, number>):
// - versionVectorMeet: lattice meet (greatest lower bound)
// - versionVectorCompare: partial-order comparison
//
// Used by both Loro (VersionVector → Map<PeerID, number>) and Yjs
// (state vector → Map<number, number>) backends. The generic key type
// accommodates both.

/**
 * Compute the lattice meet (greatest lower bound) of two version vectors.
 *
 * For each key present in either map, the result contains the minimum
 * of the two values (absent keys default to 0). Keys where the result
 * is 0 are omitted from the output.
 *
 * Algebraic properties:
 * - Commutative: `meet(a, b)` = `meet(b, a)`
 * - Associative: `meet(a, meet(b, c))` = `meet(meet(a, b), c)`
 * - Idempotent: `meet(a, a)` = `a`
 * - Lower bound: for all keys k, `result.get(k) ≤ a.get(k)` and `result.get(k) ≤ b.get(k)`
 */
export function versionVectorMeet<K>(
  a: Map<K, number>,
  b: Map<K, number>,
): Map<K, number> {
  const result = new Map<K, number>()

  // Only keys present in BOTH maps can have a non-zero minimum,
  // because absent keys default to 0 and min(x, 0) = 0 for x ≥ 0.
  for (const [key, aVal] of a) {
    const bVal = b.get(key)
    if (bVal !== undefined) {
      const min = Math.min(aVal, bVal)
      if (min > 0) {
        result.set(key, min)
      }
    }
    // If key is not in b, min(aVal, 0) = 0 → omit
  }

  return result
}

// ---------------------------------------------------------------------------
// versionVectorCompare — partial-order comparison
// ---------------------------------------------------------------------------

/**
 * Compare two version vectors using the standard partial order.
 *
 * For each key in the union of both maps (absent defaults to 0):
 * - If all components of `a` ≤ `b` and at least one strictly less → `"behind"`
 * - If all components of `a` ≥ `b` and at least one strictly greater → `"ahead"`
 * - If all components equal → `"equal"`
 * - Otherwise (some less, some greater) → `"concurrent"`
 *
 * Algebraic properties:
 * - Reflexive: `compare(a, a) = "equal"`
 * - Antisymmetric: if `compare(a, b) = "behind"` then `compare(b, a) = "ahead"`
 * - Transitive: if `compare(a, b) = "behind"` and `compare(b, c) = "behind"` then `compare(a, c) = "behind"`
 */
export function versionVectorCompare<K>(
  a: Map<K, number>,
  b: Map<K, number>,
): "behind" | "equal" | "ahead" | "concurrent" {
  const allKeys = new Set<K>()
  for (const key of a.keys()) allKeys.add(key)
  for (const key of b.keys()) allKeys.add(key)

  let hasLess = false
  let hasGreater = false

  for (const key of allKeys) {
    const aVal = a.get(key) ?? 0
    const bVal = b.get(key) ?? 0

    if (aVal < bVal) hasLess = true
    if (aVal > bVal) hasGreater = true

    // Early exit: concurrent as soon as we see both directions
    if (hasLess && hasGreater) return "concurrent"
  }

  if (hasLess && !hasGreater) return "behind"
  if (hasGreater && !hasLess) return "ahead"
  return "equal"
}
