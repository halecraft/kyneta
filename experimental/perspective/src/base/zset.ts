// === Z-Set Type and Algebra ===
// Implements the Z-set (weighted set) abstraction from DBSP (Budiu & McSherry,
// 2023) for use in incremental pipeline evaluation.
//
// A Z-set over a universe U is a function w: U → Z with finite support.
// Elements with weight +1 are "present/inserted", weight −1 are
// "removed/retracted", and weight 0 are not stored (pruned).
//
// Addition is pointwise: (a + b)(x) = a(x) + b(x).
// Negation flips weights: (−a)(x) = −a(x).
// This forms an abelian group.
//
// The Z-set is keyed by string identity. The caller provides the key when
// creating entries (via `zsetSingleton`, `zsetFromEntries`). The algebra
// (`zsetAdd`, `zsetNegate`) operates on existing keys and never derives new
// ones. Correctness requires that two semantically identical elements always
// produce the same key — otherwise +1 and −1 entries won't cancel.
//
// See theory/incremental.md §1 for the theoretical foundation.
// See .plans/005-incremental-kernel-pipeline.md § Z-Set Key Conventions for
// the canonical key function per element type.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A Z-set entry: an element with an integer weight.
 * +1 = present/inserted, −1 = removed/retracted, 0 = not stored.
 */
export interface ZSetEntry<T> {
  readonly element: T
  readonly weight: number
}

/**
 * A Z-set over elements of type T, keyed by string identity.
 *
 * Invariant: no entry has weight 0 (zero-weight entries are pruned on
 * construction and after algebraic operations).
 *
 * The Map key is a string identity derived from the element by the caller.
 * Two semantically identical elements must produce the same key.
 */
export type ZSet<T> = ReadonlyMap<string, ZSetEntry<T>>

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/** The empty Z-set (shared singleton — safe because it's readonly). */
const EMPTY: ZSet<never> = new Map()

/**
 * Create an empty Z-set.
 */
export function zsetEmpty<T>(): ZSet<T> {
  return EMPTY as ZSet<T>
}

/**
 * Create a Z-set with a single entry.
 *
 * @param key - The string identity for the element.
 * @param element - The element value.
 * @param weight - The weight (default +1). If 0, returns empty Z-set.
 */
export function zsetSingleton<T>(
  key: string,
  element: T,
  weight: number = 1,
): ZSet<T> {
  if (weight === 0) return zsetEmpty()
  const map = new Map<string, ZSetEntry<T>>()
  map.set(key, { element, weight })
  return map
}

/**
 * Create a Z-set from an iterable of [key, entry] pairs.
 *
 * Zero-weight entries are pruned. If duplicate keys appear, their weights
 * are summed (last element wins for the element value when weights don't
 * cancel to zero).
 */
export function zsetFromEntries<T>(
  entries: Iterable<[string, ZSetEntry<T>]>,
): ZSet<T> {
  const map = new Map<string, ZSetEntry<T>>()

  for (const [key, entry] of entries) {
    const existing = map.get(key)
    if (existing !== undefined) {
      const newWeight = existing.weight + entry.weight
      if (newWeight === 0) {
        map.delete(key)
      } else {
        map.set(key, { element: entry.element, weight: newWeight })
      }
    } else {
      if (entry.weight !== 0) {
        map.set(key, entry)
      }
    }
  }

  if (map.size === 0) return zsetEmpty()
  return map
}

// ---------------------------------------------------------------------------
// Core Algebra
// ---------------------------------------------------------------------------

/**
 * Pointwise addition of two Z-sets.
 *
 * For each key present in either input:
 *   result(key) = a(key) + b(key)
 *
 * Zero-weight entries are pruned. When weights are summed, the element
 * value from the entry with the non-zero contribution is preserved. If
 * both contribute non-zero weight, the element from `b` is used (the
 * "newer" value in typical delta application).
 *
 * Properties:
 * - Commutative: add(a, b) has the same weights as add(b, a)
 * - Associative: add(add(a, b), c) equals add(a, add(b, c))
 * - Identity: add(a, empty) equals a
 * - Inverse: add(a, negate(a)) equals empty
 */
export function zsetAdd<T>(a: ZSet<T>, b: ZSet<T>): ZSet<T> {
  // Fast paths
  if (a.size === 0) return b
  if (b.size === 0) return a

  // Copy the larger, iterate the smaller for efficiency
  const [larger, smaller, smallerIsB] =
    a.size >= b.size ? [a, b, true] : [b, a, false]

  const result = new Map<string, ZSetEntry<T>>(larger)

  for (const [key, smallEntry] of smaller) {
    const largeEntry = result.get(key)
    if (largeEntry !== undefined) {
      const newWeight = largeEntry.weight + smallEntry.weight
      if (newWeight === 0) {
        result.delete(key)
      } else {
        // Prefer the element from the "b" argument (the delta/newer value)
        const element = smallerIsB ? smallEntry.element : largeEntry.element
        result.set(key, { element, weight: newWeight })
      }
    } else {
      result.set(key, smallEntry)
    }
  }

  if (result.size === 0) return zsetEmpty()
  return result
}

/**
 * Negate a Z-set: flip all weights.
 *
 * negate(a)(x) = −a(x)
 *
 * Properties:
 * - add(a, negate(a)) = empty
 * - negate(negate(a)) has the same weights as a
 * - negate(empty) = empty
 */
export function zsetNegate<T>(a: ZSet<T>): ZSet<T> {
  if (a.size === 0) return a

  const result = new Map<string, ZSetEntry<T>>()
  for (const [key, entry] of a) {
    result.set(key, { element: entry.element, weight: -entry.weight })
  }
  return result
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Check if a Z-set is empty (has no entries).
 */
export function zsetIsEmpty<T>(zs: ZSet<T>): boolean {
  return zs.size === 0
}

/**
 * Get the number of entries in a Z-set (regardless of weight sign).
 */
export function zsetSize<T>(zs: ZSet<T>): number {
  return zs.size
}

/**
 * Look up an entry by key.
 */
export function zsetGet<T>(zs: ZSet<T>, key: string): ZSetEntry<T> | undefined {
  return zs.get(key)
}

/**
 * Check if a key exists in the Z-set.
 */
export function zsetHas<T>(zs: ZSet<T>, key: string): boolean {
  return zs.has(key)
}

/**
 * Extract entries with positive weight (weight > 0).
 *
 * Represents the "insertions" or "present elements" in the Z-set.
 */
export function zsetPositive<T>(zs: ZSet<T>): ZSet<T> {
  if (zs.size === 0) return zs

  const result = new Map<string, ZSetEntry<T>>()
  for (const [key, entry] of zs) {
    if (entry.weight > 0) {
      result.set(key, entry)
    }
  }

  if (result.size === 0) return zsetEmpty()
  return result
}

/**
 * Extract entries with negative weight (weight < 0).
 *
 * Represents the "deletions" or "anti-data" in the Z-set.
 */
export function zsetNegative<T>(zs: ZSet<T>): ZSet<T> {
  if (zs.size === 0) return zs

  const result = new Map<string, ZSetEntry<T>>()
  for (const [key, entry] of zs) {
    if (entry.weight < 0) {
      result.set(key, entry)
    }
  }

  if (result.size === 0) return zsetEmpty()
  return result
}

// ---------------------------------------------------------------------------
// Iteration
// ---------------------------------------------------------------------------

/**
 * Iterate over all entries in a Z-set.
 */
export function zsetForEach<T>(
  zs: ZSet<T>,
  fn: (entry: ZSetEntry<T>, key: string) => void,
): void {
  for (const [key, entry] of zs) {
    fn(entry, key)
  }
}

/**
 * Transform elements and re-key a Z-set.
 *
 * For each entry in the input, applies `mapFn` to produce a new element
 * and `keyFn` to produce a new key. Weights are preserved. If multiple
 * input entries map to the same output key, their weights are summed
 * (and zero-weight results are pruned).
 *
 * @param zs - The input Z-set.
 * @param keyFn - Derives the new string key from the transformed element.
 * @param mapFn - Transforms the element.
 */
export function zsetMap<T, U>(
  zs: ZSet<T>,
  keyFn: (e: U) => string,
  mapFn: (e: T) => U,
): ZSet<U> {
  if (zs.size === 0) return zsetEmpty()

  const result = new Map<string, ZSetEntry<U>>()

  for (const [_key, entry] of zs) {
    const newElement = mapFn(entry.element)
    const newKey = keyFn(newElement)
    const existing = result.get(newKey)

    if (existing !== undefined) {
      const newWeight = existing.weight + entry.weight
      if (newWeight === 0) {
        result.delete(newKey)
      } else {
        result.set(newKey, { element: newElement, weight: newWeight })
      }
    } else {
      result.set(newKey, { element: newElement, weight: entry.weight })
    }
  }

  if (result.size === 0) return zsetEmpty()
  return result
}

/**
 * Filter entries in a Z-set by a predicate.
 *
 * Keeps entries where `predicate(entry, key)` returns true.
 * Weights are preserved; keys are preserved.
 */
export function zsetFilter<T>(
  zs: ZSet<T>,
  predicate: (entry: ZSetEntry<T>, key: string) => boolean,
): ZSet<T> {
  if (zs.size === 0) return zs

  const result = new Map<string, ZSetEntry<T>>()
  for (const [key, entry] of zs) {
    if (predicate(entry, key)) {
      result.set(key, entry)
    }
  }

  if (result.size === 0) return zsetEmpty()
  if (result.size === zs.size) return zs // no entries removed
  return result
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

/**
 * Collect the elements of a Z-set into an array (discarding keys and weights).
 *
 * Useful for materializing the "current set" from a Z-set where all
 * weights are +1 (e.g., the accumulated active constraint set).
 */
export function zsetElements<T>(zs: ZSet<T>): T[] {
  const result: T[] = []
  for (const entry of zs.values()) {
    result.push(entry.element)
  }
  return result
}

/**
 * Collect the keys of a Z-set into an array.
 */
export function zsetKeys<T>(zs: ZSet<T>): string[] {
  return Array.from(zs.keys())
}
