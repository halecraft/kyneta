// restore — which values an undo may put back.
//
// A value (a map key, a scalar, a mark, a tree node's parent) is not rebased
// like a position: either the write being undone still stands, or something
// later replaced it. Undo restores a value only while it still holds what the
// undone step wrote. A peer's later write therefore wins, and so does one's
// own later write until it is undone in turn, at which point the value holds
// what the earlier step wrote again.

import { samePlainValue } from "./guards.js"

/** One value an undo might restore. */
export interface ValueRestore<K> {
  /** Where the value lives, in whatever terms the caller addresses it. */
  readonly key: K
  /** What the undone step wrote there. */
  readonly wrote: unknown
  /** What was there before the step. */
  readonly previous: unknown
  /** What is there now. */
  readonly current: unknown
}

/** The restores whose value still holds what the undone step wrote. */
export function planValueRestores<K>(
  parts: readonly ValueRestore<K>[],
): ValueRestore<K>[] {
  return parts.filter(part => samePlainValue(part.current, part.wrote))
}
