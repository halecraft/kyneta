// zset — the abelian group type for incremental computation.
//
// A ℤ-set over string keys is a function K → ℤ with finite support,
// forming an abelian group under pointwise addition. This is the
// universal change type for the DBSP-grounded index layer.
//
// Invariant: no entry has weight 0 — zero-weight entries are pruned
// on construction and after algebraic operations.

// The type
export type ZSet = ReadonlyMap<string, number>

// Shared empty singleton (safe because it's readonly)
const EMPTY: ZSet = new Map()

// Group operations — all pure functions

export function zero(): ZSet { return EMPTY }

export function single(key: string, weight: number = 1): ZSet {
  if (weight === 0) return EMPTY
  const m = new Map<string, number>()
  m.set(key, weight)
  return m
}

export function add(a: ZSet, b: ZSet): ZSet {
  if (a.size === 0) return b
  if (b.size === 0) return a

  const result = new Map<string, number>(a)
  for (const [key, bw] of b) {
    const aw = result.get(key) ?? 0
    const sum = aw + bw
    if (sum === 0) {
      result.delete(key)
    } else {
      result.set(key, sum)
    }
  }
  return result.size === 0 ? EMPTY : result
}

export function negate(a: ZSet): ZSet {
  if (a.size === 0) return EMPTY
  const result = new Map<string, number>()
  for (const [key, w] of a) {
    result.set(key, -w)
  }
  return result
}

export function isEmpty(z: ZSet): boolean {
  return z.size === 0
}

/** DBSP `distinct` — clamp positive multiplicities to 1, discard non-positive. */
export function positive(z: ZSet): ZSet {
  if (z.size === 0) return EMPTY
  const result = new Map<string, number>()
  for (const [key, w] of z) {
    if (w > 0) result.set(key, 1)
  }
  return result.size === 0 ? EMPTY : result
}

/** Iterate non-zero entries. */
export function entries(z: ZSet): Iterable<[string, number]> {
  return z
}

// Convenience

/** Create a ℤ-set from an iterable of keys, each with weight +1. */
export function fromKeys(keys: Iterable<string>): ZSet {
  const result = new Map<string, number>()
  for (const key of keys) {
    result.set(key, (result.get(key) ?? 0) + 1)
  }
  return result.size === 0 ? EMPTY : result
}

/** Keys where weight > 0 (added entries in a delta). */
export function toAdded(z: ZSet): string[] {
  const result: string[] = []
  for (const [key, w] of z) {
    if (w > 0) result.push(key)
  }
  return result
}

/** Keys where weight < 0 (removed entries in a delta). */
export function toRemoved(z: ZSet): string[] {
  const result: string[] = []
  for (const [key, w] of z) {
    if (w < 0) result.push(key)
  }
  return result
}