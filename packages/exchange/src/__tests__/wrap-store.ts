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
