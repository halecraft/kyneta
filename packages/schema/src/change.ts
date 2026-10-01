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
import { deepClonePlain } from "./clone.js"

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
  /**
   * Every key is removed, seen or not, before `delete` and `set` apply.
   *
   * Intent rather than a key list, because which keys a clear reaches is the
   * substrate's merge law to decide. A substrate that orders removals by
   * observation expands it against the keys it holds (`mapChangeEffects`); the
   * ephemeral substrate reads it as a horizon over the whole map.
   */
  readonly clear?: true
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
  | {
      readonly action: "create"
      readonly target: string
      readonly parent: string | null
      readonly index: number
    }
  | { readonly action: "delete"; readonly target: string }
  | {
      readonly action: "move"
      readonly target: string
      readonly parent: string | null
      readonly index: number
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
// Set actions — value-addressed add/remove for `Schema.set` collections
// ---------------------------------------------------------------------------
//
// Distinct from `MapChange`: sets are *values* not key→value pairs.
// `add` introduces members; `remove` removes by value. The wire name
// `"set-op"` avoids verb collision with `MapChange.set`.
//
// `stepSet` is total over arbitrary input — duplicate adds idempotent,
// duplicate removes idempotent, overlapping add+remove resolves via
// remove-wins (mirrors `stepMap`'s asymmetric set-wins handling).

export interface SetChange<T = unknown> extends ChangeBase {
  readonly type: "set-op"
  readonly add?: readonly T[]
  readonly remove?: readonly T[]
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
  | SetChange
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

export function isSetOpChange(action: ChangeBase): action is SetChange {
  return action.type === "set-op"
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
  instructions: readonly SequenceInstruction<Owned<T>>[],
): SequenceChange<T> {
  for (const inst of instructions) {
    if (
      "insert" in inst &&
      (inst as { insert: readonly unknown[] }).insert.includes(undefined)
    ) {
      throw new TypeError("Cannot insert undefined into a sequence")
    }
  }
  return { type: "sequence", instructions }
}

export function mapChange(
  set?: Owned<Record<string, unknown>>,
  del?: readonly string[],
): MapChange {
  return { type: "map", set, delete: del }
}

/** A map change that clears the map, then writes `set` into it. */
export function mapClearChange(
  set?: Owned<Record<string, unknown>>,
): MapChange {
  return set === undefined
    ? { type: "map", clear: true }
    : { type: "map", clear: true, set }
}

/**
 * What a map change removes and writes, given the keys the map holds.
 *
 * A key named in both `delete` and `set` ends up set, and a clear removes
 * every held key the change does not set. Every consumer that applies a map
 * change key by key reads it through here, so they cannot disagree about
 * either rule.
 *
 * `held` is called only for a clear, so a set or delete costs O(|change|)
 * however many keys the map holds.
 */
export function mapChangeEffects(
  change: MapChange,
  held: () => Iterable<string>,
): {
  readonly set: Readonly<Record<string, unknown>>
  readonly remove: readonly string[]
} {
  const set = change.set ?? {}
  const remove = new Set<string>(change.clear ? held() : [])
  for (const key of change.delete ?? []) remove.add(key)
  for (const key of Object.keys(set)) remove.delete(key)
  return { set, remove: [...remove] }
}

// ---------------------------------------------------------------------------
// mapPayload — the values a change carries
// ---------------------------------------------------------------------------

/** Where a carried value lands, relative to the change's path. */
export type PayloadSlot =
  /** A `replace` value: at the path itself. */
  | { readonly at: "self" }
  /** A sequence `insert` item or a set-op `add` member: an item of the
   *  collection at the path. */
  | { readonly at: "item" }
  /** A map `set` value: the child at `key`. */
  | { readonly at: "key"; readonly key: string }
  /** Rich-text `marks`, on an insert or a format. */
  | { readonly at: "marks" }

const SELF: PayloadSlot = { at: "self" }
const ITEM: PayloadSlot = { at: "item" }
const MARKS: PayloadSlot = { at: "marks" }

/**
 * Apply `f` to every value `change` carries, with the slot it lands in: a
 * `replace` value, sequence `insert` items, map `set` values, set-op `add`
 * members, and rich-text `marks` (on inserts and formats). Returns `change`
 * itself when `f` returned every value unchanged; any other change type is
 * returned as is.
 *
 * The one definition of "the values a change carries", so the edges that
 * touch them (`completeChange`, `ownedForStore`) cannot disagree about which
 * they are. Set-op `remove`
 * members and map `delete` keys name values rather than carry them, and are
 * left alone.
 */
export function mapPayload(
  change: ChangeBase,
  f: (value: unknown, slot: PayloadSlot) => unknown,
): ChangeBase {
  switch (change.type) {
    case "replace": {
      const replace = change as ReplaceChange
      const value = f(replace.value, SELF)
      if (value === replace.value) return change
      const out: ReplaceChange = { ...replace, value }
      return out
    }
    case "sequence": {
      const sequence = change as SequenceChange
      const instructions = mapEach(sequence.instructions, inst => {
        if (!("insert" in inst)) return inst
        const insert = mapEach(inst.insert, item => f(item, ITEM))
        return insert === inst.insert ? inst : { insert }
      })
      if (instructions === sequence.instructions) return change
      const out: SequenceChange = { ...sequence, instructions }
      return out
    }
    case "map": {
      const map = change as MapChange
      if (map.set === undefined) return change
      let set: Record<string, unknown> | undefined
      for (const [key, value] of Object.entries(map.set)) {
        const mapped = f(value, { at: "key", key })
        if (mapped !== value) set ??= { ...map.set }
        if (set !== undefined) set[key] = mapped
      }
      if (set === undefined) return change
      const out: MapChange = { ...map, set }
      return out
    }
    case "set-op": {
      const setOp = change as SetChange
      if (setOp.add === undefined) return change
      const add = mapEach(setOp.add, member => f(member, ITEM))
      if (add === setOp.add) return change
      const out: SetChange = { ...setOp, add }
      return out
    }
    case "richtext": {
      const richText = change as RichTextChange
      const instructions = mapEach(richText.instructions, inst => {
        if (!("marks" in inst) || inst.marks === undefined) return inst
        const marks = f(inst.marks, MARKS) as MarkMap
        return marks === inst.marks ? inst : { ...inst, marks }
      })
      if (instructions === richText.instructions) return change
      const out: RichTextChange = { ...richText, instructions }
      return out
    }
    default:
      return change
  }
}

/** `values.map(f)`, or `values` itself when `f` changed none of them. */
function mapEach<T, U>(values: readonly T[], f: (value: T) => U): readonly U[] {
  let out: U[] | undefined
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    const mapped = f(value)
    if (out === undefined && (mapped as unknown) !== value) {
      out = values.slice(0, i) as unknown as U[]
    }
    out?.push(mapped)
  }
  return out ?? (values as unknown as readonly U[])
}

// ---------------------------------------------------------------------------
// Owned — a payload the change layer may keep
// ---------------------------------------------------------------------------

declare const OWNED: unique symbol

/**
 * A value a change may retain: either freshly copied, or vouched for.
 *
 * A change holds its payload by reference and hands it to subscribers. If that
 * payload is still the object the caller passed in, then the caller can rewrite
 * what a subscriber sees, long after the write — no second write, no changeset,
 * nothing in the log. The document itself is safe (the store takes its own copy
 * at the boundary; see `ownedForStore` in `reader.ts`), but the op is not.
 *
 * Requiring `Owned<T>` here makes that a compile error rather than a silent
 * default. Every construction site has to say which it is: `own(value)` to copy,
 * or `trustAsOwned(value)` to assert nobody else holds it.
 *
 * Object payloads carry the brand, and so do payloads typed `unknown`, which
 * may be objects. A value typed as a primitive cannot be aliased — there is
 * nothing to hold a reference to — so `replaceChange(1)` stays as it reads,
 * and the requirement shows up exactly where a real hazard exists.
 *
 * Every constructor whose change carries caller values takes them `Owned`:
 * `replaceChange`, `sequenceChange`, `mapChange`, `mapClearChange`,
 * `setOpChange` and `richTextChange`. The store makes its own copy of each
 * once the change is completed (`ownedForStore` in `reader.ts`), so neither
 * the op nor the document shares a value with the caller.
 *
 * Deliberately *shallow*: one conditional and an intersection. A
 * `DeepReadonly<T>` would express more but recurses through the payload, and
 * this codebase already runs close to the TS2589 instantiation ceiling — see
 * the workarounds in `@kyneta/exchange`.
 */
export type Owned<T> = unknown extends T
  ? T & { readonly [OWNED]: true }
  : T extends object
    ? T & { readonly [OWNED]: true }
    : T

/**
 * Copy a caller-supplied value so the change can keep it.
 *
 * The normal choice. Costs a `structuredClone` for objects and nothing for
 * primitives.
 */
export function own<T>(value: T): Owned<T> {
  return deepClonePlain(value) as Owned<T>
}

/**
 * Assert a value is already unshared, so no copy is needed.
 *
 * Legitimate when the value was just built here, or arrived deserialized from
 * the wire, and nothing else holds a reference. Every use wants a one-line
 * reason next to it — this is the escape hatch, and an unexplained one is
 * indistinguishable from someone silencing the compiler.
 */
export function trustAsOwned<T>(value: T): Owned<T> {
  return value as Owned<T>
}

export function replaceChange<T>(value: Owned<T>): ReplaceChange<T> {
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

/**
 * Construct a `SetChange` — a thin passthrough.
 *
 * No dedup, no normalization, no validation: `stepSet` is total over
 * arbitrary input and handles duplicates / overlap / undefined fields.
 * The invariant lives at the operation boundary, not the constructor.
 */
export function setOpChange<T>(
  add?: readonly Owned<T>[],
  remove?: readonly T[],
): SetChange<T> {
  return { type: "set-op", add, remove }
}

/**
 * A rich-text change. Its `marks` are caller values, so each must be owned:
 * the instructions a helper builds carry `own(marks)`.
 */
export function richTextChange(
  instructions: readonly OwnedRichTextInstruction[],
): RichTextChange {
  return { type: "richtext", instructions }
}

/** A `RichTextInstruction` whose marks, if it has any, are owned. */
export type OwnedRichTextInstruction =
  | { readonly retain: number }
  | { readonly insert: string; readonly marks?: Owned<MarkMap> }
  | { readonly delete: number }
  | { readonly format: number; readonly marks: Owned<MarkMap> }

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
 * Early exit wrapper for `foldInstructions`.
 */
export class EarlyExit<S> {
  constructor(public readonly value: S) {}
}

/**
 * The result of a fold step. Return `S` to continue, or
 * `new EarlyExit(S)` for early exit.
 */
export type FoldResult<S> = S | EarlyExit<S>

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

function isDone<S>(result: FoldResult<S>): result is EarlyExit<S> {
  return result instanceof EarlyExit
}

/**
 * Dual-cursor fold over retain/insert/delete instructions.
 *
 * Manages both cursors:
 * - **source** advances on retain + delete
 * - **target** advances on retain + insert
 *
 * The visitor receives both positions and the count/length for each
 * operation. Return `S` to continue or `new EarlyExit(S)` for early exit.
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
      if (isDone(result)) return result.value
      acc = result
      source += op.retain
      target += op.retain
    } else if ("format" in op) {
      // format ≡ retain positionally — same cursor math
      const result = fold.onRetain(acc, op.format, source, target)
      if (isDone(result)) return result.value
      acc = result
      source += op.format
      target += op.format
    } else if ("insert" in op) {
      const length = op.insert.length
      const result = fold.onInsert(acc, length, source, target)
      if (isDone(result)) return result.value
      acc = result
      target += length
    } else if ("delete" in op) {
      const result = fold.onDelete(acc, op.delete, source, target)
      if (isDone(result)) return result.value
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
          return new EarlyExit({
            resolved: true,
            result: target + (oldIndex - source),
          })
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
          return new EarlyExit({ resolved: true, result: null })
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
          return new EarlyExit({
            result: target + (index - source),
            source: source + count,
            target: target + count,
          })
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
          return new EarlyExit({
            result: target,
            source,
            target: target + length,
          })
        }
        // Right-sticky or insert not at gap position: let target accumulate
        return { result: undefined, source, target: target + length }
      },
      onDelete(_acc, count, source, target) {
        if (index >= source && index < source + count) {
          // Gap within deleted range collapses to target
          return new EarlyExit({
            result: target,
            source: source + count,
            target,
          })
        }
        // Gap after deleted range: let source advance
        return { result: undefined, source: source + count, target }
      },
    },
  )

  if (final.result !== undefined) return final.result
  // Trailing retain: index is past all explicit ops
  return final.target + (index - final.source)
}

// ---------------------------------------------------------------------------
// diffText — the single contiguous edit between two strings
// ---------------------------------------------------------------------------

/**
 * Compare two strings and produce a `TextChange` describing the single
 * contiguous edit that transforms `oldText` into `newText`.
 *
 * Minimal in the sense that matters to positions: everything outside the edit
 * is retained, so `transformIndex` carries a cursor there through unmoved.
 *
 * The `cursorHint` (an editor's `selectionStart` after an input event)
 * disambiguates when the edit falls within a run of identical characters.
 * Inserting `'a'` into `"aaa"` is ambiguous; the cursor says where it
 * happened. Without a hint the common prefix is unbounded, which places the
 * edit as far right as the strings allow.
 *
 * Algorithm:
 * 1. Scan from the left for a common prefix, bounded by `cursorHint` when
 *    given, so the edit is placed at or before the cursor.
 * 2. Scan from the right for a common suffix, not overlapping the prefix.
 * 3. The region between prefix and suffix is the edit range.
 *
 * @param oldText - The text before the edit.
 * @param newText - The text after the edit.
 * @param cursorHint - Where the cursor sits after the edit, if known.
 * @returns A `TextChange` with retain/delete/insert instructions.
 */
export function diffText(
  oldText: string,
  newText: string,
  cursorHint?: number,
): TextChange {
  if (oldText === newText) return textChange([])

  const oldLen = oldText.length
  const newLen = newText.length

  // Common prefix, bounded by the cursor hint to disambiguate within
  // identical runs.
  let prefixLen = 0
  const maxPrefix = Math.min(oldLen, newLen, cursorHint ?? Infinity)
  while (prefixLen < maxPrefix && oldText[prefixLen] === newText[prefixLen]) {
    prefixLen++
  }

  // Common suffix, not overlapping with prefix.
  let suffixLen = 0
  const maxSuffix = Math.min(oldLen - prefixLen, newLen - prefixLen)
  while (
    suffixLen < maxSuffix &&
    oldText[oldLen - 1 - suffixLen] === newText[newLen - 1 - suffixLen]
  ) {
    suffixLen++
  }

  const deleteLen = oldLen - prefixLen - suffixLen
  const insertText = newText.slice(prefixLen, newLen - suffixLen)

  const instructions: TextInstruction[] = []
  if (prefixLen > 0) instructions.push({ retain: prefixLen })
  if (deleteLen > 0) instructions.push({ delete: deleteLen })
  if (insertText.length > 0) instructions.push({ insert: insertText })

  return textChange(instructions)
}

// ---------------------------------------------------------------------------
// advanceAddresses — imperative shell for bulk address advancement
// ---------------------------------------------------------------------------

import type { IndexAddress } from "./path.js"

/**
 * Advance all index addresses in one pass through the instructions.
 *
 * Mutates each surviving `address.index` in place, and returns the addresses
 * whose items the instructions deleted. It does not mark those dead: the
 * caller does, with whatever else a death entails (its listeners, and the
 * coordinates below it).
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
        const addr = sorted[ci]
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
        const addr = sorted[ci]
        if (addr.index >= source) dead.push(addr)
        ci++
      }
      source += op.delete
    }
  }

  // Remaining addresses are in the implicit trailing retain.
  while (ci < sorted.length) {
    const addr = sorted[ci]
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

/** One contiguous edit: `deleted` characters removed at `index`, then
 *  `inserted` put there. */
export interface SingleEdit {
  readonly index: number
  readonly inserted: string
  readonly deleted: number
}

/**
 * The single contiguous edit `instructions` make, or `undefined` if they
 * make none or several. A replacement is one edit: a delete and an insert at
 * the same offset, as `diffText` produces.
 */
export function singleEdit(
  instructions: readonly TextInstruction[],
): SingleEdit | undefined {
  const patches = textInstructionsToPatches(instructions)
  const [first, second] = patches
  if (first === undefined || patches.length > 2) return undefined
  if (second === undefined) {
    return first.kind === "insert"
      ? { index: first.offset, inserted: first.text, deleted: 0 }
      : { index: first.offset, inserted: "", deleted: first.count }
  }
  if (
    first.kind === "delete" &&
    second.kind === "insert" &&
    second.offset === first.offset
  ) {
    return { index: first.offset, inserted: second.text, deleted: first.count }
  }
  return undefined
}

// ---------------------------------------------------------------------------
// applyTextInstructions — replay a text delta onto a live TextRef
// ---------------------------------------------------------------------------

import type { TextRef } from "./interpreters/writable.js"

/**
 * Replay a `TextInstruction[]` delta onto a live, mutable `TextRef`,
 * character-cursor style (retain advances the cursor; insert applies at the
 * cursor and advances it by the inserted length; delete applies at the cursor
 * and does not advance it).
 *
 * This is the **imperative shell** over the pure `textInstructionsToPatches`:
 * it converts the cursor-based instructions to absolute-offset patches and
 * dispatches each to `TextRef.insert` / `TextRef.delete`. It is the `TextRef`
 * counterpart to applying those same patches to a DOM `Text` node via
 * `insertData`/`deleteData` — the use case `textInstructionsToPatches` was
 * built for. The cursor math lives there, not here.
 *
 * Distinct from `foldInstructions`, which is a *dual-cursor* (source/target)
 * fold for tracking position across a diff and whose `insert` case carries only
 * a length, not content — the wrong sibling to build replay on. This is the
 * single-cursor, content-carrying replay.
 */
export function applyTextInstructions(
  target: TextRef,
  instructions: readonly TextInstruction[],
): void {
  for (const patch of textInstructionsToPatches(instructions)) {
    if (patch.kind === "insert") target.insert(patch.offset, patch.text)
    else target.delete(patch.offset, patch.count)
  }
}
