// refusal — why a document refuses authored writes.
//
// Every refusal, in any package, is a `WriteRefusal`, so a caller that only
// wants to know whether it may write narrows with one `instanceof`, and one
// that wants to know why narrows further.

/**
 * Why a document refuses authored writes. Every refusal extends it.
 *
 * A refusal is a state the document is in, not an event: its refusal feed
 * holds it for as long as a ref is held, and the write path throws that same
 * value. So it carries no stack. V8 keeps an error's call sites, with the
 * receiver of every frame, until its `stack` is read, and a refusal made in a
 * method would keep that method's object (a Runtime, an Exchange) alive
 * through every held ref. Assigning `stack` drops them without formatting
 * them.
 */
export class WriteRefusal extends Error {
  constructor(message?: string) {
    super(message)
    this.stack = undefined
  }
}

/**
 * Why a document closed: `destroyed` (removed, from the store too),
 * `unloaded` (let go here, kept in the store), or `disposed` (its owner shut
 * down, or let go of a replica it no longer needs).
 */
export type ClosedReason = "destroyed" | "unloaded" | "disposed"

/**
 * The document is closed: its native document, op log or state tree was
 * released. A ref that outlives it still reads its last value; everything
 * that needs what was released throws this.
 */
export class DocumentClosedError extends WriteRefusal {
  override readonly name = "DocumentClosedError"

  constructor(readonly reason: ClosedReason) {
    super(`This document was ${reason}, and is closed.`)
  }
}

/**
 * A serialized document's own history is still loading from its store. A
 * write made now would be overwritten by what loads, and would mint a lineage
 * the store does not know. Await `whenHydrated(doc)` before writing.
 */
export class DocumentLoadingError extends WriteRefusal {
  override readonly name = "DocumentLoadingError"

  constructor() {
    super(
      "This document is still loading from its store. " +
        "Await whenHydrated(doc) before writing to it.",
    )
  }
}
