// watcher-table — per-key watcher lifecycle helper used by `fromList`,
// `flatMap`, `filter`, `Index.by`.
//
// The `install` callback returns a teardown for its own watcher *only*.
// Secondary cleanup (e.g. `innerSource.dispose()` in `flatMap`) is the
// caller's responsibility — running it inside the install closure would
// fire on every re-add, which is wrong for owned-resource teardown.

export interface WatcherEntry<V> {
  readonly value: V
  readonly unwatch: () => void
}

export interface WatcherTable<V> {
  /** Re-adding an existing key tears down the prior watcher before installing. */
  add(key: string, value: V): void
  /** Returns true iff a watcher was present (and was torn down). */
  remove(key: string): boolean
  has(key: string): boolean
  get(key: string): V | undefined
  keys(): Iterable<string>
  values(): Iterable<V>
  entries(): Iterable<[string, V]>
  clear(): void
  readonly size: number
}

export function createWatcherTable<V>(
  install: (key: string, value: V) => () => void,
): WatcherTable<V> {
  const table = new Map<string, WatcherEntry<V>>()

  return {
    add(key: string, value: V): void {
      const prev = table.get(key)
      if (prev) prev.unwatch()
      const unwatch = install(key, value)
      table.set(key, { value, unwatch })
    },
    remove(key: string): boolean {
      const entry = table.get(key)
      if (!entry) return false
      entry.unwatch()
      table.delete(key)
      return true
    },
    has(key: string): boolean {
      return table.has(key)
    },
    get(key: string): V | undefined {
      return table.get(key)?.value
    },
    keys(): Iterable<string> {
      return table.keys()
    },
    *values(): Iterable<V> {
      for (const entry of table.values()) yield entry.value
    },
    *entries(): Iterable<[string, V]> {
      for (const [k, entry] of table) yield [k, entry.value]
    },
    clear(): void {
      for (const entry of table.values()) entry.unwatch()
      table.clear()
    },
    get size(): number {
      return table.size
    },
  }
}
