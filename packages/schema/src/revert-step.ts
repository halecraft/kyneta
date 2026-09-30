// revert-step — undo one step: revert its parts last first.
//
// A step is the parts one gesture committed, a record each, possibly over
// several documents. Reverting one part can re-create content another part
// names (a restore makes new items), so each revert's remap reaches every
// part still waiting, and every redo part already made, before the next part
// reverts. Whatever holds the rest of the stack applies the returned remaps
// to it the same way.

import type { Remap } from "./substrate.js"

/** One part's revert: the part that redoes it, and what it re-created. */
export interface PartReverted<P> {
  readonly redo: P
  readonly remap: Remap
}

/** What reverting a step produced. */
export interface StepReverted<P> {
  /** The redo parts, in the order they reverted: reverting them last first
   *  redoes the step. Empty when nothing of the step still stood. */
  readonly redo: readonly P[]
  /** Each part's remap, with the part whose revert made it, in order. */
  readonly remaps: readonly { readonly by: P; readonly remap: Remap }[]
}

/**
 * Revert `parts` last first. `revert` reverts one part, or returns null when
 * nothing of it still stands; `rewrite(part, by, remap)` is `part` naming what
 * `by`'s revert re-created (a part of another document is returned as is).
 */
export function revertStep<P>(
  parts: readonly P[],
  revert: (part: P) => PartReverted<P> | null,
  rewrite: (part: P, by: P, remap: Remap) => P,
): StepReverted<P> {
  let waiting = [...parts]
  let redo: P[] = []
  const remaps: { by: P; remap: Remap }[] = []
  for (let part = waiting.pop(); part !== undefined; part = waiting.pop()) {
    const result = revert(part)
    if (result === null) continue
    const by = part
    const { remap } = result
    redo.push(result.redo)
    remaps.push({ by, remap })
    waiting = waiting.map(p => rewrite(p, by, remap))
    redo = redo.map(p => rewrite(p, by, remap))
  }
  return { redo, remaps }
}
