// undo-step — how much of a step still stands, and what an undo does with it.
//
// A record names some units (characters, items, keys, values), and some of
// them still stand. A step's parts each tally theirs; tallies add, and the
// standing is read once, from the sum. Counts combine, not standings: a part
// that names nothing (its commits cancelled out) tallies 0 of 0 and adds
// nothing, where a standing "whole" for it would turn a dead step's "none"
// into "part". Only whether all, none or some units stand matters, so the
// weight of a unit never changes a verdict.
//
// The exchange's stack and `undoConformance`'s both decide with
// `settleStep`, so the suite tests the decision that ships.

/** How much of a record still stands, judged against the document now. */
export type Standing = "whole" | "part" | "none"

/** What a record names, in units, and how many of them still stand. */
export interface Tally {
  readonly kept: number
  readonly total: number
}

/** A record that names nothing: whole, and the identity of `addTally`. */
export const EMPTY_TALLY: Tally = { kept: 0, total: 0 }

export function addTally(a: Tally, b: Tally): Tally {
  return { kept: a.kept + b.kept, total: a.total + b.total }
}

/** Every unit stands (or there are none): "whole"; no unit: "none". */
export function howMuchStands(tally: Tally): Standing {
  if (tally.kept === tally.total) return "whole"
  return tally.kept === 0 ? "none" : "part"
}

/** What an undo does with a step: revert it, drop it because nothing of it
 *  stands, or drop it because `whole` was asked and it does not stand
 *  whole. */
export type Settlement = "undone" | "dropped" | "refused"

/** The settlement of a step whose parts tally `tallies`. */
export function settleStep(
  tallies: readonly Tally[],
  whole: boolean,
): Settlement {
  const standing = howMuchStands(tallies.reduce(addTally, EMPTY_TALLY))
  if (whole) return standing === "whole" ? "undone" : "refused"
  return standing === "none" ? "dropped" : "undone"
}
