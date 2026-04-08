// version-vector — shared utility for version vector lattice operations.
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