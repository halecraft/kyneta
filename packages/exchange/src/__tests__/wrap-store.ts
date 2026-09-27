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
 * caused it. Adding a method to `Store` now breaks this in one visible place
 * rather than silently in several.
 */
export function wrapStore(inner: Store, overrides: Partial<Store>): Store {
  return {
    append: (docId, record) => inner.append(docId, record),
    loadAll: docId => inner.loadAll(docId),
    replace: (docId, records) => inner.replace(docId, records),
    delete: docId => inner.delete(docId),
    currentMeta: docId => inner.currentMeta(docId),
    listDocIds: prefix => inner.listDocIds(prefix),
    close: () => inner.close(),
    ...overrides,
  }
}
