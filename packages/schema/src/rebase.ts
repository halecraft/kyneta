// rebase — carry a positional change past another made on the same state.
//
// Undo applies the inverse of an old change to a document others have edited
// since. The inverse is written in the coordinates of the state it was made
// against; `rebaseChange` rewrites it into the coordinates of the state after
// `over`, which was made against that same state. This is the operational
// transform of a text, sequence or rich-text change, with the inverse winning
// ties: content an undo restores goes before what a peer inserted at the same
// place, as both CRDTs' own undo managers do.
//
// Only positions are rebased. What a value, a key or a mark should become is
// decided by comparison when the undo is planned (`planValueRestores`), since
// a later write to it means the undone write no longer stands.

import type {
  ChangeBase,
  Owned,
  OwnedRichTextInstruction,
  SequenceInstruction,
  TextInstruction,
} from "./change.js"
import {
  isRichTextChange,
  isSequenceChange,
  isTextChange,
  richTextChange,
  sequenceChange,
  textChange,
} from "./change.js"

/** One instruction of a text, sequence or rich-text change. */
type Component =
  | { readonly retain: number }
  | { readonly format: number; readonly marks: unknown }
  | { readonly delete: number }
  | {
      readonly insert: string | readonly unknown[]
      readonly marks?: unknown
    }

function length(c: Component): number {
  if ("retain" in c) return c.retain
  if ("format" in c) return c.format
  if ("delete" in c) return c.delete
  return c.insert.length
}

/** Split `c` into its first `n` units and the rest. */
function split(c: Component, n: number): [Component, Component | undefined] {
  const total = length(c)
  if (n >= total) return [c, undefined]
  if ("retain" in c) return [{ retain: n }, { retain: total - n }]
  if ("format" in c) {
    return [
      { format: n, marks: c.marks },
      { format: total - n, marks: c.marks },
    ]
  }
  if ("delete" in c) return [{ delete: n }, { delete: total - n }]
  return [
    { ...c, insert: c.insert.slice(0, n) },
    { ...c, insert: c.insert.slice(n) },
  ]
}

/** A queue over a component list that hands out pieces of a given length. */
function queue(components: readonly Component[]) {
  const items = [...components]
  return {
    peek: (): Component | undefined => items[0],
    take(n?: number): Component {
      const head = items[0]
      if (head === undefined) throw new Error("rebase: queue exhausted")
      if (n === undefined) {
        items.shift()
        return head
      }
      const [first, rest] = split(head, n)
      if (rest === undefined) items.shift()
      else items[0] = rest
      return first
    },
  }
}

function push(out: Component[], c: Component): void {
  if (length(c) === 0) return
  const last = out.at(-1)
  if (last !== undefined && "retain" in last && "retain" in c) {
    out[out.length - 1] = { retain: last.retain + c.retain }
    return
  }
  if (last !== undefined && "delete" in last && "delete" in c) {
    out[out.length - 1] = { delete: last.delete + c.delete }
    return
  }
  out.push(c)
}

/**
 * The instructions of `change` rewritten to apply after `over`. Both apply to
 * the same state.
 *
 * - An insert of `change` stays, and goes first when `over` inserts at the
 *   same place.
 * - What `over` inserted is retained, unformatted.
 * - Content `over` deleted drops out of whatever `change` did to it.
 */
function transform(
  change: readonly Component[],
  over: readonly Component[],
): Component[] {
  const a = queue(change)
  const b = queue(over)
  const out: Component[] = []
  for (;;) {
    const x = a.peek()
    const y = b.peek()
    if (x === undefined) break
    if ("insert" in x) {
      push(out, a.take())
      continue
    }
    if (y === undefined) {
      push(out, a.take())
      continue
    }
    if ("insert" in y) {
      push(out, { retain: length(b.take()) })
      continue
    }
    const n = Math.min(length(x), length(y))
    const piece = a.take(n)
    const theirs = b.take(n)
    if ("delete" in theirs) continue
    push(out, piece)
  }
  // A trailing retain says nothing.
  for (let last = out.at(-1); last !== undefined && "retain" in last; ) {
    out.pop()
    last = out.at(-1)
  }
  return out
}

/**
 * `change`, rebased past `over`: the change to apply after `over` so that
 * what `change` did still happens, to the content it still concerns.
 *
 * Both are changes at the same coordinate, made against the same state.
 * Defined for two text changes, two sequence changes and two rich-text
 * changes. For any other pair `over` rewrote the coordinate (a `replace`),
 * so none of `change`'s positions survive and the result is null.
 */
export function rebaseChange(
  change: ChangeBase,
  over: ChangeBase,
): ChangeBase | null {
  // The pieces are slices of `change`'s own instructions, whose payloads the
  // change already owns, and neither change is ever mutated.
  if (isTextChange(change) && isTextChange(over)) {
    return textChange(
      transform(change.instructions, over.instructions) as TextInstruction[],
    )
  }
  if (isSequenceChange(change) && isSequenceChange(over)) {
    return sequenceChange(
      transform(change.instructions, over.instructions) as SequenceInstruction<
        Owned<unknown>
      >[],
    )
  }
  if (isRichTextChange(change) && isRichTextChange(over)) {
    return richTextChange(
      transform(
        change.instructions,
        over.instructions,
      ) as OwnedRichTextInstruction[],
    )
  }
  return null
}
