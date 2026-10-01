// frame-stack — what an authored batch did, frame by frame.
//
// Pure. A `runBatch` frame records each authored op once its substrate has
// applied it, with the inverse the substrate computed. A frame that ends
// returns the ops it made, nested frames that ended included. A frame that
// throws hands back its inverses to compensate, last first, and leaves the
// stack, so no frame around it reports its ops. When the outermost frame ends,
// the stack's whole content is the batch's outcome.
//
// The entries are a list built from the head, newest first: recording is one
// allocation, a frame's start is the head when it opened, its compensations
// are the walk from the head down to that start, and aborting it is moving
// the head back. So no step copies the entries, however large the batch.

import type { ChangeBase } from "./change.js"
import type { Op } from "./changefeed.js"
import type { Path } from "./interpret.js"
import type { BatchOutcome } from "./substrate.js"

/** One authored op, as the frame that made it keeps it. */
export interface Recorded {
  /** The live path the op was prepared at: compensation prepares its
   *  inverse here, where the address stands once the ops after it are
   *  undone. Below the coordinate trie's reach the path is raw indices,
   *  which name the right item for the same reason: compensation runs last
   *  first, so each inverse meets the state just after its own op. */
  readonly at: Path
  /** The op, frozen as it was made. */
  readonly op: Op
  /** Its reverse arrow, at the same coordinate. */
  readonly inverse: ChangeBase
}

/** Recorded ops, newest first. */
type Entries = { readonly entry: Recorded; readonly next: Entries } | null

export interface FrameStack {
  readonly head: Entries
  /** The head when each open frame opened, outermost first. */
  readonly starts: readonly Entries[]
}

/** One compensation: an inverse, and the live path to prepare it at. */
export interface Compensation {
  readonly at: Path
  readonly inverse: ChangeBase
}

export const emptyFrames: FrameStack = { head: null, starts: [] }

/** Whether a frame is open, so a write joins it rather than opening one. */
export function inFrame(frames: FrameStack): boolean {
  return frames.starts.length > 0
}

export function openFrame(frames: FrameStack): FrameStack {
  return { head: frames.head, starts: [...frames.starts, frames.head] }
}

export function record(frames: FrameStack, entry: Recorded): FrameStack {
  return { head: { entry, next: frames.head }, starts: frames.starts }
}

/**
 * Close the innermost frame. `ops` are what it did, in the order it did them:
 * its entries, nested frames that ended included; the array is the caller's.
 * `outcome` is present only when the outermost frame closed, which empties
 * the stack, and shares no array with `ops`.
 */
export function closeFrame(frames: FrameStack): {
  readonly frames: FrameStack
  readonly ops: Op[]
  readonly outcome?: BatchOutcome
} {
  const start = frames.starts.at(-1) ?? null
  const recorded = since(frames.head, start).reverse()
  const ops = recorded.map(r => r.op)
  if (frames.starts.length > 1) {
    return {
      frames: { head: frames.head, starts: frames.starts.slice(0, -1) },
      ops,
    }
  }
  const inverses = recorded.map(r => ({ path: r.op.path, change: r.inverse }))
  return {
    frames: emptyFrames,
    ops,
    outcome: { ops: [...ops], inverses, aborted: false },
  }
}

/**
 * Abort the innermost frame. `compensations` are its inverses, last first,
 * at their live paths. Its entries leave the stack, so no outer frame
 * reports them. `outermost` says the batch itself aborted.
 */
export function abortFrame(frames: FrameStack): {
  readonly frames: FrameStack
  readonly compensations: readonly Compensation[]
  readonly outermost: boolean
} {
  const start = frames.starts.at(-1) ?? null
  const compensations = since(frames.head, start).map(r => ({
    at: r.at,
    inverse: r.inverse,
  }))
  const outermost = frames.starts.length <= 1
  return {
    frames: outermost
      ? emptyFrames
      : { head: start, starts: frames.starts.slice(0, -1) },
    compensations,
    outermost,
  }
}

/** The entries from `head` down to `start`, exclusive, newest first. */
function since(head: Entries, start: Entries): Recorded[] {
  const out: Recorded[] = []
  for (let node = head; node !== null && node !== start; node = node.next) {
    out.push(node.entry)
  }
  return out
}
