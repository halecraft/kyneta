// cached-snapshot — one snapshot of mutable state, rebuilt on first read
// after a mutation.

/**
 * A snapshot of mutable state that keeps its identity until the state
 * changes: `get()` builds it on first read and returns the same value after,
 * until `invalidate()` drops it. Call `invalidate()` wherever the state
 * mutates, not where changes are announced, so a snapshot read between a
 * mutation and its announcement already agrees with the state.
 *
 * The producer's half of the changefeed identity rule (`current` is the same
 * value until the state changes).
 */
export function cachedSnapshot<T>(build: () => T): {
  get(): T
  invalidate(): void
} {
  let built = false
  let snapshot: T | undefined
  return {
    get(): T {
      if (!built) {
        snapshot = build()
        built = true
      }
      return snapshot as T
    },
    invalidate(): void {
      built = false
      snapshot = undefined
    },
  }
}
