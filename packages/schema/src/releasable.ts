// releasable — the one slot a replica keeps what its `dispose` releases.
//
// A replica's native document (a `LoroDoc`, a `Y.Doc`), op log or state tree
// lives in a slot, and every path to it goes through `get()`. Closed is the
// slot being empty, so there is no flag to forget to check: a member, a
// position or an undo record made before the close reaches the value through
// the slot, and finds it gone.

import { type Feed, type Settable, settableFeed } from "@kyneta/changefeed"
import { type ClosedReason, DocumentClosedError } from "./refusal.js"

/** What a replica's `dispose` releases. Closed is empty. */
export interface Releasable<T> {
  /** The held value; throws `DocumentClosedError` once the slot is empty. */
  get(): T
  /** Empty the slot and hand the value to a new holder, which now owns it. */
  take(): T
  /** Free the value if this slot owns it, and empty the slot. Idempotent. */
  release(reason: ClosedReason): void
  /** `undefined` while the slot holds its value; notified by `release` and
   *  `take`. */
  readonly closed: Feed<DocumentClosedError | undefined>
}

/**
 * A slot holding `value`. `free` releases what the slot owns, and is `null`
 * for a value the caller owns (a bring-your-own document), which `release`
 * only lets go of.
 */
export function releasable<T>(
  value: T,
  free: ((value: T) => void) | null,
): Releasable<T> {
  let held: { readonly value: T } | undefined = { value }
  const closed: Settable<DocumentClosedError | undefined> = settableFeed<
    DocumentClosedError | undefined
  >(undefined)

  const get = (): T => {
    if (held === undefined) throw closed()
    return held.value
  }

  return {
    get,
    take(): T {
      const value = get()
      held = undefined
      closed.set(new DocumentClosedError("disposed"))
      return value
    },
    release(reason: ClosedReason): void {
      if (held === undefined) return
      const { value } = held
      held = undefined
      closed.set(new DocumentClosedError(reason))
      free?.(value)
    },
    closed,
  }
}
