// persistence — "has the store confirmed every write this peer made?", and
// "may this peer write at all?"
//
// With a store, an own write reaches peers only once the store has confirmed
// it (§"Store-first" in TECHNICAL.md). These functions answer, for any ref
// within a document, whether that has happened, and why not. A serialized
// document another seat of the storage writes refuses authored writes
// (§"Serialized documents: one writer seat per storage"); `writeRefusal` says
// so.
//
// Not a settle term. `settled` asks whether every source has reported what it
// holds; a write waiting on the store is not a source, and a document can be
// settled with writes still unconfirmed.

import { CHANGEFEED, type Feed } from "@kyneta/changefeed"
import { createDocumentMap } from "./document-key.js"
import { signalFeed } from "./settle.js"
import type { WriterRefusedError } from "./store/seats.js"

/** A document's refusal, readable and observable. */
export type WriteRefusalFeed = Feed<WriterRefusedError | undefined>

const persistence = createDocumentMap<{
  readonly term: Feed<boolean>
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
  term: Feed<boolean>,
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
export function persistedFeed(ref: object): Feed<boolean> {
  return (
    persistence.get(ref)?.term ??
    signalFeed(
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

const refusals = createDocumentMap<WriteRefusalFeed>()

/**
 * Register a document's refusal.
 *
 * @internal Called by `Runtime` as it creates an interpreted document.
 */
export function registerWriteRefusal(
  ref: object,
  feed: WriteRefusalFeed,
): void {
  refusals.set(ref, feed)
}

/**
 * Why this document's authored writes are refused, or `undefined` when they
 * are not: another seat of its storage is the recorded writer of this
 * serialized document. Set when the document loads, or when its first own
 * write lost a race to another seat's, and kept for the session: writership
 * moves only with the seat.
 *
 * Not a {@link persistenceError}: a refused document never failed a write
 * when it was refused at load, and its unauthored writes (what the network
 * sends) still succeed.
 */
export function writeRefusal(ref: object): WriterRefusedError | undefined {
  return refusals.get(ref)?.()
}

/**
 * Observable form of {@link writeRefusal}, for a UI that disables editing. A
 * callable, so never put it in an `if`.
 */
export function writeRefusalFeed(ref: object): WriteRefusalFeed {
  return refusals.get(ref) ?? NEVER_REFUSED
}

const NEVER_REFUSED: WriteRefusalFeed = signalFeed<
  WriterRefusedError | undefined
>(
  () => undefined,
  () => () => {},
)
