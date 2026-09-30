// wrap-store — a store with some of its methods replaced, for tests that
// hold, slow or fail a write.

import type { Store } from "../store/store.js"

/**
 * Wrap a store, replacing some of its methods.
 *
 * Forwarding every method by hand is the point of the helper, not an
 * oversight. `createInMemoryStore` returns a class instance, so the obvious
 * spelling — `{ ...store, append }` — copies the own properties and none of
 * the prototype methods. The result typechecks as a complete `Store` and then
 * fails at the first `currentMeta` or `loadAll`, a long way from the line that
 * caused it. Adding a member to `Store` now breaks this in one visible place
 * rather than silently in several.
 */
export function wrapStore(
  inner: Store,
  overrides: Partial<Omit<Store, "seat">>,
): Store {
  return {
    seat: inner.seat,
    append: (docId, record, options) => inner.append(docId, record, options),
    loadAll: docId => inner.loadAll(docId),
    mark: docId => inner.mark(docId),
    compact: (docId, records, through, options) =>
      inner.compact(docId, records, through, options),
    delete: docId => inner.delete(docId),
    currentMeta: docId => inner.currentMeta(docId),
    writerOf: docId => inner.writerOf(docId),
    listDocIds: prefix => inner.listDocIds(prefix),
    close: () => inner.close(),
    ...overrides,
  }
}

/** Store methods a test can hold. */
export type Holdable = "append" | "compact" | "delete"

/**
 * Wrap a store so that, while held, `method` calls wait until released, or
 * fail. Lets a test decide exactly which calls are in flight when something
 * else happens.
 */
export function gated(inner: Store, method: Holdable) {
  let held: {
    promise: Promise<void>
    resolve: () => void
    reject: (error: unknown) => void
  } | null = null
  const wait = async (): Promise<void> => {
    if (held) await held.promise
  }
  const overrides: Partial<Omit<Store, "seat">> =
    method === "append"
      ? {
          append: async (docId, record, options) => {
            await wait()
            return inner.append(docId, record, options)
          },
        }
      : method === "compact"
        ? {
            compact: async (docId, records, through, options) => {
              await wait()
              return inner.compact(docId, records, through, options)
            },
          }
        : {
            delete: async docId => {
              await wait()
              return inner.delete(docId)
            },
          }
  return {
    store: wrapStore(inner, overrides),
    /** Hold every later call until `release` or `fail`. */
    hold(): void {
      let resolve = (): void => {}
      let reject = (_error: unknown): void => {}
      const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      held = { promise, resolve, reject }
    },
    release(): void {
      const h = held
      held = null
      h?.resolve()
    },
    fail(error: unknown): void {
      const h = held
      held = null
      h?.reject(error)
    },
  }
}
