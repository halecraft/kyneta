// typing — when a keystroke joins the undo step before it.
//
// Undoing one character at a time is useless, and undoing a whole paragraph
// typed in one go loses too much. An editor groups typing the way a person
// thinks of it: a burst of typing in one place, a word at a time. This is
// that decision, as a pure function of the edit before and the edit now.

import type { TextInstruction } from "./change.js"
import { isRichTextChange, isTextChange, singleEdit } from "./change.js"
import type { Op } from "./changefeed.js"

/** One contiguous text edit, when and where it happened. */
export interface Edit {
  /** The edited text's path key. */
  readonly path: string
  /** When, in milliseconds. */
  readonly at: number
  readonly index: number
  readonly inserted: string
  readonly deleted: number
}

/** Pause after which typing starts a new step, in milliseconds. */
export const TYPING_GAP = 1000

/**
 * The single contiguous edit a text or rich-text op makes, if it makes one.
 * A rich-text change that formats makes none: formatting is not typing.
 */
export function editOf(op: Op, at: number): Edit | undefined {
  const { change } = op
  let instructions: readonly TextInstruction[]
  if (isTextChange(change)) {
    instructions = change.instructions
  } else if (isRichTextChange(change)) {
    if (change.instructions.some(i => "format" in i)) return undefined
    instructions = change.instructions as readonly TextInstruction[]
  } else {
    return undefined
  }
  const edit = singleEdit(instructions)
  return edit === undefined ? undefined : { path: op.path.key, at, ...edit }
}

const WHITESPACE = /\s/

/**
 * Whether `next` joins the undo step that `previous` belongs to. It does when
 * the user kept typing, or kept deleting, in one place without pausing:
 *
 * - the same text, less than `gap` after `previous`;
 * - the same kind of edit: both inserts, or both deletes. A replacement
 *   (typing over a selection) always starts a step;
 * - the caret did not jump: an insert continues where the last one ended, a
 *   backspace ends where the last one began, a forward delete stays put;
 * - no word boundary: typing a word after a space starts a step, so undo
 *   takes back a word at a time.
 */
export function continuesStep(
  previous: Edit,
  next: Edit,
  gap: number = TYPING_GAP,
): boolean {
  if (next.path !== previous.path) return false
  if (next.at - previous.at >= gap) return false
  const inserting = (e: Edit) => e.inserted.length > 0 && e.deleted === 0
  const deleting = (e: Edit) => e.deleted > 0 && e.inserted.length === 0
  if (inserting(previous) && inserting(next)) {
    if (next.index !== previous.index + previous.inserted.length) return false
    const last = previous.inserted.at(-1) ?? ""
    const first = next.inserted[0] ?? ""
    return !(WHITESPACE.test(last) && !WHITESPACE.test(first))
  }
  if (deleting(previous) && deleting(next)) {
    const backspace = next.index + next.deleted === previous.index
    const forward = next.index === previous.index
    return backspace || forward
  }
  return false
}
