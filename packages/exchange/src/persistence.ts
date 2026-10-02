// persistence — "has the store confirmed every write this peer made?", and
// "may this peer write at all?"
//
// With a store, an own write reaches peers only once the store has confirmed
// it (§"Store-first" in TECHNICAL.md). These functions answer, for any ref
// within a document, whether that has happened, and why not. Whether this peer
// may author the document is its context's refusal (`writeRefusal`): a
// document a `canWrite` policy keeps from this peer refuses authored writes,
// so does one whose authority refused this peer's operations, so does a
// serialized document another seat of the storage writes
// (§"Serialized documents: one writer seat per storage"), and so does a closed
// one.
//
// Not a settle term. `settled` asks whether every source has reported what it
// holds; a write waiting on the store is not a source, and a document can be
// settled with writes still unconfirmed.

import { CHANGEFEED, type Feed, signalFeed } from "@kyneta/changefeed"
import { hasTransact, TRANSACT, type WriteRefusal } from "@kyneta/schema"
import { constantFeed, type Persistence, termsOf } from "./document-terms.js"

/** A document's refusal, readable and observable. */
export type WriteRefusalFeed = Feed<WriteRefusal | undefined>

const CONFIRMED: Persistence = { persisted: true }

/** The persistence of the document `ref` belongs to; confirmed when no store
 *  is behind it. */
function persistenceOf(ref: object): Persistence {
  return termsOf(ref)?.local.persistence() ?? CONFIRMED
}

/**
 * Has the store confirmed every write this peer made to the document?
 *
 * `true` for a document with no store behind it: nothing it writes can
 * outlive it, so nothing is held back. A plain boolean, safe in an `if`.
 */
export function persisted(ref: object): boolean {
  return persistenceOf(ref).persisted
}

/** Observable form of {@link persisted}. A callable, so never put it in an `if`. */
export function persistedFeed(ref: object): Feed<boolean> {
  const term = termsOf(ref)?.local.persistence
  if (term === undefined) return constantFeed(true)
  return signalFeed(
    () => term().persisted,
    onChange => term[CHANGEFEED].subscribe(() => onChange()),
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
 *
 * A document closed with own writes the store had not confirmed reports its
 * `DocumentClosedError`: those writes will never be confirmed.
 */
export function persistenceError(ref: object): unknown | undefined {
  return persistenceOf(ref).error
}

/**
 * Checks in this order, as `whenHydrated` does: resolve at once if
 * {@link persisted}; otherwise reject at once if {@link persistenceError} is
 * set; otherwise wait, resolving once persisted and rejecting with the error
 * if a store write fails first, or with its `DocumentClosedError` if the
 * document closes first.
 *
 * Failed writes are retried automatically, so a rejection may be transient: a
 * caller that wants to wait it out checks `persistenceError(ref)` and calls
 * again. A `SeatLostError` and a `DocumentClosedError` are final.
 */
export function whenPersisted(ref: object): Promise<void> {
  const term = termsOf(ref)?.local.persistence
  if (term === undefined) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const settle = ({ persisted, error }: Persistence): boolean => {
      if (persisted) resolve()
      else if (error !== undefined) reject(error)
      else return false
      return true
    }
    if (settle(term())) return
    const stop = term[CHANGEFEED].subscribe(() => {
      if (settle(term())) stop()
    })
  })
}

/**
 * Why this document's authored writes are refused, or `undefined` when they
 * are not. Read from the document's context, the one answer the write path
 * itself throws:
 * - `NotAWriterError`: a `Policy.canWrite` rejects this peer's own identity
 *   for the document, for as long as the policies say so;
 * - `OfferRefusedError`: the document's authority refused this peer's
 *   operations on it, for as long as that refusal stands;
 * - `DocumentClosedError`: the document was destroyed, unloaded or disposed,
 *   or is unloading;
 * - `DocumentLoadingError`: a serialized document is still loading its own
 *   history from its store;
 * - `WriterRefusedError`: another seat of its storage is the recorded writer
 *   of this serialized document, set when the document loads or when its
 *   first own write lost a race to another seat's, and kept for the session.
 *
 * Every refusal is a `WriteRefusal`: narrow with `instanceof`. Not a
 * {@link persistenceError}: a refused document never failed a write when it
 * was refused at load, and its unauthored writes (what the network sends)
 * still succeed.
 */
export function writeRefusal(ref: object): WriteRefusal | undefined {
  return writeRefusalFeed(ref)()
}

/**
 * Observable form of {@link writeRefusal}, for a UI that disables editing. A
 * callable, so never put it in an `if`.
 */
export function writeRefusalFeed(ref: object): WriteRefusalFeed {
  return hasTransact(ref) ? ref[TRANSACT].refusal : constantFeed(undefined)
}
