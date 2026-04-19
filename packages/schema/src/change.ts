// Change types — the universal currency of change.
//
// A change describes a delta to a schema node. The same change structure
// flows in both directions:
//   - Going in (developer → backend): the change describes intent
//   - Coming out (backend → observer): the change describes what happened
//   - Pure computation (step): (State, Change) → State
//
// Changes are an open protocol identified by a string discriminant.
// They are interpretation-level — the schema says "sequence," the backend
// picks the change vocabulary. Built-in changes cover the common cases.
// Third-party backends extend ChangeBase with their own types.

// ---------------------------------------------------------------------------
// Base protocol — re-exported from @kyneta/changefeed
// ---------------------------------------------------------------------------

export type { ChangeBase } from "@kyneta/changefeed"

import type { ChangeBase } from "@kyneta/changefeed"

// ---------------------------------------------------------------------------
// Text actions — cursor-based retain/insert/delete over characters
// ---------------------------------------------------------------------------

export type TextInstruction =
  | { readonly retain: number }
  | { readonly insert: string }
  | { readonly delete: number }

export interface TextChange extends ChangeBase {
  readonly type: "text"
  readonly instructions: readonly TextInstruction[]
}

// ---------------------------------------------------------------------------
// Sequence actions — cursor-based retain/insert/delete over items
// ---------------------------------------------------------------------------

export type SequenceInstruction<T = unknown> =
  | { readonly retain: number }
  | { readonly insert: readonly T[] }
  | { readonly delete: number }

export interface SequenceChange<T = unknown> extends ChangeBase {
  readonly type: "sequence"
  readonly instructions: readonly SequenceInstruction<T>[]
}

// ---------------------------------------------------------------------------
// Map actions — key-level set/delete for products and maps
// ---------------------------------------------------------------------------

export interface MapChange extends ChangeBase {
  readonly type: "map"
  readonly set?: Readonly<Record<string, unknown>>
  readonly delete?: readonly string[]
}

// ---------------------------------------------------------------------------
// Scalar replacement — wholesale value swap
// ---------------------------------------------------------------------------

export interface ReplaceChange<T = unknown> extends ChangeBase {
  readonly type: "replace"
  readonly value: T
}

// ---------------------------------------------------------------------------
// Tree actions — structural operations on hierarchical trees
// ---------------------------------------------------------------------------

export type TreeInstruction =
  | { readonly action: "create"; readonly index: number }
  | { readonly action: "delete"; readonly index: number }
  | {
      readonly action: "move"
      readonly fromIndex: number
      readonly toIndex: number
    }

export interface TreeChange extends ChangeBase {
  readonly type: "tree"
  readonly instructions: readonly TreeInstruction[]
}

// ---------------------------------------------------------------------------
// Counter actions — increment/decrement
// ---------------------------------------------------------------------------

export interface IncrementChange extends ChangeBase {
  readonly type: "increment"
  readonly amount: number
}

// ---------------------------------------------------------------------------
// Rich text types — cursor-based with format/mark instructions
// ---------------------------------------------------------------------------

/** Keys are mark names; values are mark data or null (remove). `unknown` because mark payloads are schema-opaque. */
export type MarkMap = Readonly<Record<string, unknown>>

export interface RichTextSpan {
  readonly text: string
  readonly marks?: MarkMap
}

export type RichTextDelta = readonly RichTextSpan[]

/**
 * Rich text instructions — the structural type doesn't name the variants:
 * `retain(N)`, `insert(text, marks?)`, `delete(N)`, `format(N, marks)`.
 *
 * Positionally, `format(N)` ≡ `retain(N)` — it advances both cursors
 * by N. `foldInstructions` handles this equivalence.
 */
export type RichTextInstruction =
  | { readonly retain: number }
  | { readonly insert: string; readonly marks?: MarkMap }
  | { readonly delete: number }
  | { readonly format: number; readonly marks: MarkMap }

export interface RichTextChange extends ChangeBase {
  readonly type: "richtext"
  readonly instructions: readonly RichTextInstruction[]
}

// ---------------------------------------------------------------------------
// Union of all built-in action types
// ---------------------------------------------------------------------------

export type BuiltinChange =
  | TextChange
  | SequenceChange
  | MapChange
  | ReplaceChange
  | TreeChange
  | IncrementChange
  | RichTextChange

/**
 * Any action — built-in or third-party. Use this as a general constraint
 * when writing code that is generic over all possible actions.
 */
export type Change = ChangeBase

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

export function isTextChange(action: ChangeBase): action is TextChange {
  return action.type === "text"
}

export function isSequenceChange(action: ChangeBase): action is SequenceChange {
  return action.type === "sequence"
}

export function isMapChange(action: ChangeBase): action is MapChange {
  return action.type === "map"
}

export function isReplaceChange(action: ChangeBase): action is ReplaceChange {
  return action.type === "replace"
}

export function isTreeChange(action: ChangeBase): action is TreeChange {
  return action.type === "tree"
}

export function isIncrementChange(
  action: ChangeBase,
): action is IncrementChange {
  return action.type === "increment"
}

// ---------------------------------------------------------------------------
// Action constructors — convenience factories
// ---------------------------------------------------------------------------

export function textChange(
  instructions: readonly TextInstruction[],
): TextChange {
  return { type: "text", instructions }
}

export function sequenceChange<T>(
  instructions: readonly SequenceInstruction<T>[],
): SequenceChange<T> {
  return { type: "sequence", instructions }
}

export function mapChange(
  set?: Record<string, unknown>,
  del?: string[],
): MapChange {
  return { type: "map", set, delete: del }
}

export function replaceChange<T>(value: T): ReplaceChange<T> {
  return { type: "replace", value }
}

export function treeChange(
  instructions: readonly TreeInstruction[],
): TreeChange {
  return { type: "tree", instructions }
}

export function incrementChange(amount: number): IncrementChange {
  return { type: "increment", amount }
}

export function richTextChange(
  instructions: readonly RichTextInstruction[],
): RichTextChange {
  return { type: "richtext", instructions }
}

export function isRichTextChange(change: ChangeBase): change is RichTextChange {
  return change.type === "richtext"
}

// ---------------------------------------------------------------------------
// Instruction — structural type for retain/insert/delete instructions
// ---------------------------------------------------------------------------

/**
 * Structural type for any retain/insert/delete instruction.
 *
 * Both `TextInstruction` and `SequenceInstruction<T>` satisfy this.
 * The `insert` case requires only `{ length: number }` — both
 * `string` and `readonly T[]` have `.length`, so both qualify.
 *
 * `RichTextInstruction` also satisfies this: its `format` variant
 * has `{ format: number }` which is handled by `foldInstructions`
 * as positionally equivalent to `retain`.
 *
 * This is the input type for `foldInstructions`, which manages
 * dual-cursor position tracking over any instruction stream.
 */
export type Instruction =
  | { readonly retain: number }
  | { readonly insert: { readonly length: number } }
  | { readonly delete: number }
  | { readonly format: number }

// ---------------------------------------------------------------------------
// foldInstructions — dual-cursor fold over instructions
// ---------------------------------------------------------------------------

/**
 * The result of a fold step. Return `S` to continue, or
 * `{ done: S }` for early exit.
 */
export type FoldResult<S> = S | { readonly done: S }

/**
 * Visitor callbacks for `foldInstructions`. Each receives the
 * accumulator, the count/length, and both cursor positions
 * (source and target) at the start of the operation.
 */
export interface InstructionFold<S> {
  onRetain: (
    acc: S,
    count: number,
    source: number,
    target: number,
  ) => FoldResult<S>
  onInsert: (
    acc: S,
    length: number,
    source: number,
    target: number,
  ) => FoldResult<S>
  onDelete: (
    acc: S,
    count: number,
    source: number,
    target: number,
  ) => FoldResult<S>
}

function isDone<S>(result: FoldResult<S>): result is { readonly done: S } {
  return (
    result !== null &&
    typeof result === "object" &&
    "done" in (result as object)
  )
}

/**
 * Dual-cursor fold over retain/insert/delete instructions.
 *
 * Manages both cursors:
 * - **source** advances on retain + delete
 * - **target** advances on retain + insert
 *
 * The visitor receives both positions and the count/length for each
 * operation. Return `S` to continue or `{ done: S }` for early exit.
 *
 * This is the shared primitive for position-tracking across text,
 * sequence, and cursor-advancement operations. It is NOT designed
 * for content-collecting operations (e.g. `stepText` needs the actual
 * insert string, not just its length).
 */
export function foldInstructions<S>(
  instructions: readonly Instruction[],
  initial: S,
  fold: InstructionFold<S>,
): S {
  let acc = initial
  let source = 0
  let target = 0

  for (const op of instructions) {
    if ("retain" in op) {
      const result = fold.onRetain(acc, op.retain, source, target)
      if (isDone(result)) return result.done
      acc = result
      source += op.retain
      target += op.retain
    } else if ("format" in op) {
      // format ≡ retain positionally — same cursor math
      const result = fold.onRetain(acc, op.format, source, target)
      if (isDone(result)) return result.done
      acc = result
      source += op.format
      target += op.format
    } else if ("insert" in op) {
      const length = op.insert.length
      const result = fold.onInsert(acc, length, source, target)
      if (isDone(result)) return result.done
      acc = result
      target += length
    } else if ("delete" in op) {
      const result = fold.onDelete(acc, op.delete, source, target)
      if (isDone(result)) return result.done
      acc = result
      source += op.delete
    }
  }

  return acc
}

// ---------------------------------------------------------------------------
// advanceIndex — pure position tracking
// ---------------------------------------------------------------------------

/**
 * Given an old index and a sequence of instructions, compute the new
 * index after the instructions are applied. Returns `null` if the
 * item at `oldIndex` was deleted.
 *
 * This is the Functional Core — pure, table-testable, no mutation.
 *
 * Uses early exit (`{ done }`) when the tracked index is resolved
 * (found in a retain range or deleted). Post-fold: if unresolved,
 * the index is in the implicit trailing retain.
 */
export function advanceIndex(
  oldIndex: number,
  instructions: readonly Instruction[],
): number | null {
  interface State {
    resolved: boolean
    result: number | null
  }

  const final = foldInstructions<State>(
    instructions,
    { resolved: false, result: null },
    {
      onRetain(acc, count, source, target) {
        // If oldIndex falls within this retain range, it maps to
        // the corresponding position in the target.
        if (oldIndex >= source && oldIndex < source + count) {
          return {
            done: { resolved: true, result: target + (oldIndex - source) },
          }
        }
        return acc
      },
      onInsert(acc, _length, _source, _target) {
        // Inserts don't consume source positions — oldIndex is unaffected
        // by the insert itself, but target cursor advances.
        return acc
      },
      onDelete(acc, count, source, _target) {
        // If oldIndex falls within this delete range, the item is dead.
        if (oldIndex >= source && oldIndex < source + count) {
          return { done: { resolved: true, result: null } }
        }
        return acc
      },
    },
  )

  if (final.resolved) return final.result

  // Unresolved — the index is in the implicit trailing retain.
  // The fold tracked source/target through all explicit ops.
  // We need to recompute the final source/target positions.
  let source = 0
  let target = 0
  for (const op of instructions) {
    if ("retain" in op) {
      source += op.retain
      target += op.retain
    } else if ("insert" in op) {
      target += op.insert.length
    } else if ("delete" in op) {
      source += op.delete
    }
  }
  return target + (oldIndex - source)
}

// ---------------------------------------------------------------------------
// transformIndex — sticky-side-aware gap position tracking
// ---------------------------------------------------------------------------

/**
 * Sticky-side-aware index transform through a delta.
 *
 * Tracks a *gap position* (between items) through a set of instructions,
 * as opposed to `advanceIndex` which tracks *item positions*.
 *
 * Key differences from `advanceIndex`:
 * - Gaps survive deletion (returns the collapsed target position, never `null`).
 * - When an insert occurs at exactly the gap index, sticky side determines
 *   the result: `"left"` stays before the insertion, `"right"` shifts past it.
 * - Threads source/target through the accumulator to avoid the trailing-retain
 *   double-walk present in `advanceIndex`.
 *
 * @param index - The gap position in the source (pre-image) index space.
 * @param side - Sticky side: `"left"` stays before inserts at the gap,
 *   `"right"` shifts past them.
 * @param instructions - The instruction sequence (retain/insert/delete).
 * @returns The transformed index in the target (post-image) index space.
 */
export function transformIndex(
  index: number,
  side: "left" | "right",
  instructions: readonly Instruction[],
): number {
  interface State {
    result: number | undefined
    source: number
    target: number
  }

  const final = foldInstructions<State>(
    instructions,
    { result: undefined, source: 0, target: 0 },
    {
      onRetain(_acc, count, source, target) {
        if (index >= source && index < source + count) {
          return {
            done: {
              result: target + (index - source),
              source: source + count,
              target: target + count,
            },
          }
        }
        return {
          result: undefined,
          source: source + count,
          target: target + count,
        }
      },
      onInsert(_acc, length, source, target) {
        if (source === index && side === "left") {
          // Left-sticky: position stays before the insertion
          return { done: { result: target, source, target: target + length } }
        }
        // Right-sticky or insert not at gap position: let target accumulate
        return { result: undefined, source, target: target + length }
      },
      onDelete(_acc, count, source, target) {
        if (index >= source && index < source + count) {
          // Gap within deleted range collapses to target
          return {
            done: { result: target, source: source + count, target },
          }
        }
        return { result: undefined, source: source + count, target }
      },
    },
  )

  if (final.result !== undefined) return final.result
  // Trailing retain: index is past all explicit ops
  return final.target + (index - final.source)
}

// ---------------------------------------------------------------------------
// advanceAddresses — imperative shell for bulk address advancement
// ---------------------------------------------------------------------------

import type { IndexAddress } from "./path.js"

/**
 * Advance all index addresses in one pass through the instructions.
 *
 * Mutates `address.index` and `address.dead` in place. Returns the
 * list of addresses that were killed (dead set to true).
 *
 * Complexity: O(n + k) where n = instruction count, k = address count.
 * Addresses are sorted by index and walked in tandem with the
 * instruction stream.
 *
 * This is the Imperative Shell — it mutates address objects. The naive
 * correctness reference is: calling `advanceIndex` independently per
 * address should produce the same results.
 */
export function advanceAddresses(
  addresses: IndexAddress[],
  instructions: readonly Instruction[],
): IndexAddress[] {
  if (addresses.length === 0) return []

  // Sort by index (ascending) for tandem walk
  const sorted = [...addresses].sort((a, b) => a.index - b.index)
  const dead: IndexAddress[] = []

  // Walk instructions and addresses in tandem
  let source = 0
  let target = 0
  let ci = 0 // index into sorted array

  for (const op of instructions) {
    if (ci >= sorted.length) break

    if ("retain" in op) {
      // All addresses in [source, source + retain) map to [target, target + retain)
      while (ci < sorted.length && sorted[ci]?.index < source + op.retain) {
        const addr = sorted[ci]!
        if (addr.index >= source) {
          addr.index = target + (addr.index - source)
        }
        ci++
      }
      source += op.retain
      target += op.retain
    } else if ("insert" in op) {
      // Inserts don't consume source positions — no addresses resolved here.
      // Target advances.
      target += op.insert.length
    } else if ("delete" in op) {
      // All addresses in [source, source + delete) are dead.
      while (ci < sorted.length && sorted[ci]?.index < source + op.delete) {
        const addr = sorted[ci]!
        if (addr.index >= source) {
          addr.dead = true
          dead.push(addr)
        }
        ci++
      }
      source += op.delete
    }
  }

  // Remaining addresses are in the implicit trailing retain.
  while (ci < sorted.length) {
    const addr = sorted[ci]!
    addr.index = target + (addr.index - source)
    ci++
  }

  return dead
}

// ---------------------------------------------------------------------------
// textInstructionsToPatches — cursor-based → offset-based instruction conversion
// ---------------------------------------------------------------------------

/**
 * Offset-based patch operation for DOM-friendly text application.
 *
 * These operations use absolute offsets and can be applied directly via
 * `Text.insertData()`/`Text.deleteData()` or `HTMLInputElement.setRangeText()`.
 */
export type TextPatch =
  | { kind: "insert"; offset: number; text: string }
  | { kind: "delete"; offset: number; count: number }

/**
 * Convert cursor-based text instructions to offset-based patch operations.
 *
 * Text instructions use a cursor model (retain/insert/delete applied
 * left-to-right). This function converts to absolute-offset operations
 * suitable for direct DOM application.
 *
 * Critical detail: **delete does not advance the cursor** — subsequent
 * operations apply at the same position (the deleted range collapses).
 *
 * @param instructions - Cursor-based text instructions.
 * @returns Offset-based patch operations.
 */
export function textInstructionsToPatches(
  instructions: readonly TextInstruction[],
): TextPatch[] {
  const result: TextPatch[] = []
  let cursor = 0

  for (const op of instructions) {
    if ("retain" in op) {
      cursor += op.retain
    } else if ("insert" in op) {
      result.push({ kind: "insert", offset: cursor, text: op.insert })
      cursor += op.insert.length
    } else if ("delete" in op) {
      result.push({ kind: "delete", offset: cursor, count: op.delete })
      // Cursor does NOT advance on delete — subsequent ops apply at same position
    }
  }

  return result
}
