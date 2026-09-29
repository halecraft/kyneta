// checked — reads the caller knows succeed, stated rather than asserted.
//
// With `noUncheckedIndexedAccess`, `xs[i]` is `T | undefined` even for an
// index the loop just bounded. These return `T`, and throw where a `!` would
// have let `undefined` through.

/** `xs[i]`, for an index known to be in bounds. */
export function nth<T>(xs: ArrayLike<T>, i: number): T {
  if (!(i >= 0 && i < xs.length)) {
    throw new RangeError(`index ${i} is out of bounds (length ${xs.length})`)
  }
  return xs[i] as T
}

/** `map.get(key)`, for a key known to be present. */
export function lookup<K, V>(map: ReadonlyMap<K, V>, key: K): V {
  if (!map.has(key)) throw new Error(`no entry for ${String(key)}`)
  return map.get(key) as V
}
