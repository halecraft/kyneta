// persistence — "has the store confirmed every write this peer made?"
//
// With a store, an own write reaches peers only once the store has confirmed
// it (§"Store-first" in TECHNICAL.md). These functions answer, for any ref
// within a document, whether that has happened, and why not.
//
// Not a settle term. `settled` asks whether every source has reported what it
// holds; a write waiting on the store is not a source, and a document can be
// settled with writes still unconfirmed.

import { CHANGEFEED } from "@kyneta/changefeed"
import { createDocumentMap } from "./document-key.js"
import { makeSettleTerm, type SettleTerm } from "./settle.js"

const persistence = createDocumentMap<{
  readonly term: SettleTerm
  readonly readError: () => unknown | undefined
}>()

/**
 * Register a document's persistence: `term` is whether every own write is
 * confirmed, and `readError` the error of the latest failed store write.
 *
 * @internal Called by `Runtime` as it creates an interpreted document.
 */
export function registerPersistenceTerm(
  ref: object,
  term: SettleTerm,
  readError: () => unknown | undefined,
): void {
  persistence.set(ref, { term, readError })
}

/**
 * Has the store confirmed every write this peer made to the document?
 *
 * `true` for a document with no store behind it: nothing it writes can
 * outlive it, so nothing is held back. A plain boolean, safe in an `if`.
 */
export function persisted(ref: object): boolean {
  const term = persistence.get(ref)?.term
  return term ? term() : true
}

/** Observable form of {@link persisted}. A callable, so never put it in an `if`. */
export function persistedFeed(ref: object): SettleTerm {
  return (
    persistence.get(ref)?.term ??
    makeSettleTerm(
      () => true,
      () => () => {},
    )
  )
}

/**
 * The error of the latest failed store write for this document, cleared by
 * the next write that succeeds. Covers every store write, including one that
 * only stores operations imported from peers, so it can be set while
 * {@link persisted} is true.
 *
 * Once the store's seat is lost to another writer, it is that
 * `SeatLostError` for every stored document of the Runtime, including one
 * opened afterwards, and it never clears: nothing more is written. The
 * application recovers by opening a new store (in a browser, by reloading).
 */
export function persistenceError(ref: object): unknown | undefined {
  return persistence.get(ref)?.readError()
}

/**
 * Checks in this order, as `whenHydrated` does: resolve at once if
 * {@link persisted}; otherwise reject at once if {@link persistenceError} is
 * set; otherwise wait, resolving once persisted and rejecting with the error
 * if a store write fails first.
 *
 * Failed writes are retried automatically, so a rejection may be transient: a
 * caller that wants to wait it out checks `persistenceError(ref)` and calls
 * again. A `SeatLostError` is final.
 */
export function whenPersisted(ref: object): Promise<void> {
  const entry = persistence.get(ref)
  if (!entry || entry.term()) return Promise.resolve()

  const failure = entry.readError()
  if (failure !== undefined) return Promise.reject(failure)

  return new Promise<void>((resolve, reject) => {
    const dispose = entry.term[CHANGEFEED].subscribe(() => {
      if (entry.term()) {
        dispose()
        resolve()
        return
      }
      const error = entry.readError()
      if (error !== undefined) {
        dispose()
        reject(error)
      }
    })
  })
}
