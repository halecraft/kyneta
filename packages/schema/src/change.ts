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
// Base protocol
// ---------------------------------------------------------------------------

/**
 * All actions carry a string `type` discriminant. Built-in action types
 * use well-known strings ("text", "sequence", "map", "replace", "tree").
 * Third-party backends extend this with their own types.
 *
 * Provenance metadata (e.g. "local", "sync") is carried at the batch
 * level on `Changeset.origin`, not on individual changes. See
 * `Changeset` in `changefeed.ts`.
 */
export interface ChangeBase {
  readonly type: string
}

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
// Union of all built-in action types
// ---------------------------------------------------------------------------

export type BuiltinChange =
  | TextChange
  | SequenceChange
  | MapChange
  | ReplaceChange
  | TreeChange
  | IncrementChange

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
 * This is the input type for `foldInstructions`, which manages
 * dual-cursor position tracking over any instruction stream.
 */
export type Instruction =
  | { readonly retain: number }
  | { readonly insert: { readonly length: number } }
  | { readonly delete: number }

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
      while (ci < sorted.length && sorted[ci]!.index < source + op.retain) {
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
      while (ci < sorted.length && sorted[ci]!.index < source + op.delete) {
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
