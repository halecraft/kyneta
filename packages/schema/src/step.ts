// step — pure state transitions: (State, Action) → State
//
// Each step function applies an action to a plain value, producing the
// next plain value. No CRDT runtime required — this is pure computation.
//
// step dispatches on the action's `type` discriminant (not on the schema).
// The schema says "sequence"; the backend picks the action vocabulary.
// step is action-driven and schema-agnostic.

import type {
  ChangeBase,
  IncrementChange,
  MapChange,
  ReplaceChange,
  RichTextChange,
  RichTextDelta,
  RichTextSpan,
  SequenceChange,
  SetChange,
  TextChange,
  TreeChange,
} from "./change.js"
import { isPlainObject, isSameSetMember } from "./guards.js"

// ---------------------------------------------------------------------------
// Container mutation primitives — shared by the pure and in-place duals
// ---------------------------------------------------------------------------

/**
 * Splice `items` into `target` at `index` without `Array.prototype.splice`'s
 * variadic call. A bulk insert can carry more items than an engine's argument
 * limit, so `splice(i, 0, ...items)` is not a safe spelling of this.
 *
 * O(|target| - index + |items|); O(|items|) for the append that dominates
 * real workloads.
 */
function insertItems<T>(target: T[], index: number, items: readonly T[]): void {
  if (items.length === 0) return
  if (index >= target.length) {
    for (const item of items) target.push(item)
    return
  }
  const shift = items.length
  const end = target.length
  target.length = end + shift
  for (let i = end - 1; i >= index; i--) target[i + shift] = target[i]
  for (let i = 0; i < shift; i++) target[index + i] = items[i]
}

// ---------------------------------------------------------------------------
// stepText — apply retain/insert/delete ops to a string
// ---------------------------------------------------------------------------

/**
 * Applies a `TextAction` to a string, producing a new string.
 *
 * ```
 * stepText("Hello", { type: "text", ops: [{ retain: 5 }, { insert: " World" }] })
 * → "Hello World"
 * ```
 *
 * Ops are cursor-based: the cursor starts at 0 and advances through
 * retains and deletes. Inserts add characters at the cursor position.
 */
export function stepText(state: string, action: TextChange): string {
  const s = state ?? ""
  let cursor = 0
  let result = ""

  for (const op of action.instructions) {
    if ("retain" in op) {
      result += s.slice(cursor, cursor + op.retain)
      cursor += op.retain
    } else if ("insert" in op) {
      result += op.insert
    } else if ("delete" in op) {
      cursor += op.delete
    }
  }

  // Append any remaining characters after the last op
  if (cursor < s.length) {
    result += s.slice(cursor)
  }

  return result
}

// ---------------------------------------------------------------------------
// stepSequence — apply retain/insert/delete ops to an array
// ---------------------------------------------------------------------------

/**
 * Applies a `SequenceAction` to an array, producing a new array.
 *
 * ```
 * stepSequence([1, 2, 3], { type: "sequence", ops: [
 *   { retain: 1 }, { insert: [10, 20] }, { delete: 1 }
 * ] })
 * → [1, 10, 20, 3]
 * ```
 *
 * Same cursor semantics as text, but over array items.
 */
export function stepSequence<T>(
  state: readonly T[],
  action: SequenceChange<T>,
): T[] {
  return mutateSequence([...(state ?? [])], action)
}

/**
 * `stepSequence`'s mutating core. Retain never touches an element — it only
 * advances the cursor — so the array's contents pass through untouched, and an
 * append costs O(|insert|) rather than O(|state|).
 */
function mutateSequence<T>(target: T[], action: SequenceChange<T>): T[] {
  let cursor = 0

  for (const op of action.instructions) {
    if ("retain" in op) {
      cursor = Math.min(
        cursor + (op as { retain: number }).retain,
        target.length,
      )
    } else if ("insert" in op) {
      const items = (op as { insert: readonly T[] }).insert
      insertItems(target, cursor, items)
      cursor += items.length
    } else if ("delete" in op) {
      target.splice(cursor, (op as { delete: number }).delete)
    }
  }

  return target
}

// ---------------------------------------------------------------------------
// stepMap — apply set/delete to a plain object
// ---------------------------------------------------------------------------

/**
 * Applies a `MapAction` to a plain object, producing a new object.
 *
 * ```
 * stepMap({ a: 1, b: 2 }, { type: "map", set: { a: 10 }, delete: ["b"] })
 * → { a: 10 }
 * ```
 *
 * Order: deletes are applied first, then sets. This means a key that
 * appears in both `delete` and `set` will end up with the `set` value.
 */
export function stepMap<T extends Record<string, unknown>>(
  state: T,
  action: MapChange,
): T {
  return mutateMap({ ...(state ?? ({} as T)) }, action)
}

/** `stepMap`'s mutating core. O(|delete| + |set|). */
function mutateMap<T extends Record<string, unknown>>(
  target: T,
  action: MapChange,
): T {
  const record = target as Record<string, unknown>

  if (action.delete) {
    for (const key of action.delete) {
      delete record[key]
    }
  }

  if (action.set) {
    for (const [key, value] of Object.entries(action.set)) {
      record[key] = value
    }
  }

  return target
}

// ---------------------------------------------------------------------------
// stepReplace — wholesale scalar replacement
// ---------------------------------------------------------------------------

/**
 * Applies a `ReplaceAction` — simply returns the new value.
 *
 * ```
 * stepReplace(42, { type: "replace", value: 99 })
 * → 99
 * ```
 */
export function stepReplace<T>(_state: T, action: ReplaceChange<T>): T {
  return action.value
}

// ---------------------------------------------------------------------------
// stepIncrement — counter increment/decrement
// ---------------------------------------------------------------------------

/**
 * Applies an `IncrementAction` to a number.
 *
 * ```
 * stepIncrement(10, { type: "increment", amount: 5 })
 * → 15
 * ```
 */
export function stepIncrement(state: number, action: IncrementChange): number {
  return (state ?? 0) + action.amount
}

// ---------------------------------------------------------------------------
// normalizeSpans — merge adjacent spans with identical marks
// ---------------------------------------------------------------------------

/**
 * Normalize a span array: merge adjacent spans with deeply-equal marks,
 * remove empty spans.
 */
export function normalizeSpans(spans: RichTextSpan[]): RichTextSpan[] {
  const result: RichTextSpan[] = []
  for (const span of spans) {
    if (span.text === "") continue
    const prev = result[result.length - 1]
    if (prev && marksEqual(prev.marks, span.marks)) {
      result[result.length - 1] = {
        text: prev.text + span.text,
        ...(prev.marks ? { marks: prev.marks } : {}),
      }
    } else {
      result.push(span)
    }
  }
  return result
}

/** Deep equality for mark maps (null/undefined/empty are all equivalent to "no marks"). */
function marksEqual(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  const aKeys = a ? Object.keys(a).filter(k => a[k] !== undefined) : []
  const bKeys = b ? Object.keys(b).filter(k => b[k] !== undefined) : []
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (a?.[key] !== b?.[key]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// stepRichText — apply rich text instructions to a RichTextDelta
// ---------------------------------------------------------------------------

/**
 * Applies a `RichTextChange` to a `RichTextDelta`, producing a new delta.
 *
 * Remaining input spans after the last instruction are implicitly retained.
 * The result is normalized: adjacent spans with equal marks are merged.
 */
export function stepRichText(
  state: RichTextDelta,
  action: RichTextChange,
): RichTextDelta {
  const s = state ?? []
  const output: RichTextSpan[] = []

  // Flat cursor into the input spans
  let spanIndex = 0
  let charOffset = 0

  function consume(
    count: number,
    markMerger?: (
      existing: Record<string, unknown> | undefined,
    ) => Record<string, unknown> | undefined,
  ): void {
    let remaining = count
    while (remaining > 0 && spanIndex < s.length) {
      const span = s[spanIndex] as RichTextSpan
      const available = span.text.length - charOffset
      const take = Math.min(remaining, available)

      const text = span.text.slice(charOffset, charOffset + take)
      const marks = markMerger ? markMerger(span.marks) : span.marks
      output.push(
        marks && Object.keys(marks).length > 0 ? { text, marks } : { text },
      )

      remaining -= take
      charOffset += take
      if (charOffset >= span.text.length) {
        spanIndex++
        charOffset = 0
      }
    }
  }

  function skip(count: number): void {
    let remaining = count
    while (remaining > 0 && spanIndex < s.length) {
      const span = s[spanIndex] as RichTextSpan
      const available = span.text.length - charOffset
      const take = Math.min(remaining, available)

      remaining -= take
      charOffset += take
      if (charOffset >= span.text.length) {
        spanIndex++
        charOffset = 0
      }
    }
  }

  for (const op of action.instructions) {
    if ("retain" in op) {
      consume(op.retain)
    } else if ("format" in op) {
      consume(op.format, existing => {
        const merged = { ...(existing ?? {}) }
        for (const [key, value] of Object.entries(op.marks)) {
          if (value === null) {
            delete merged[key]
          } else {
            merged[key] = value
          }
        }
        return Object.keys(merged).length > 0 ? merged : undefined
      })
    } else if ("insert" in op) {
      const span: RichTextSpan =
        op.marks && Object.keys(op.marks).length > 0
          ? { text: op.insert, marks: op.marks }
          : { text: op.insert }
      output.push(span)
    } else if ("delete" in op) {
      skip(op.delete)
    }
  }

  // Append remaining input spans (implicit trailing retain)
  while (spanIndex < s.length) {
    const span = s[spanIndex] as RichTextSpan
    if (charOffset > 0) {
      const text = span.text.slice(charOffset)
      if (text) {
        output.push(span.marks ? { text, marks: span.marks } : { text })
      }
      charOffset = 0
    } else {
      output.push(span)
    }
    spanIndex++
  }

  return normalizeSpans(output)
}

// ---------------------------------------------------------------------------
// stepSet — value-addressed add/remove over an array of set members
// ---------------------------------------------------------------------------

/**
 * Applies a `SetChange` to a `T[]` set of members, producing a new array.
 *
 * **Total over arbitrary input.** `undefined` fields are treated as empty.
 * Duplicate adds are idempotent; duplicate removes are idempotent.
 *
 * **Remove-wins on overlap.** Items appearing in both `add` and `remove`
 * are removed. Mirrors `stepMap`'s asymmetric handling (delete-then-set
 * means set-wins for map; SetChange's natural order is add-then-remove,
 * giving remove-wins).
 *
 * **Output is normalized.** No duplicates (via `isSameSetMember`).
 * Order: existing members retain relative position; new adds appended
 * in `add[]` order; an add of an existing member is a no-op (preserves
 * original position, does *not* re-append).
 *
 * ```
 * stepSet(["a", "b"], { type: "set-op", add: ["c"], remove: ["a"] })
 * → ["b", "c"]
 * ```
 */
export function stepSet<T>(state: readonly T[], change: SetChange<T>): T[] {
  return mutateSet([...(state ?? [])], change)
}

/**
 * `stepSet`'s mutating core. Removal compacts in place; adds append.
 */
function mutateSet<T>(target: T[], change: SetChange<T>): T[] {
  const adds = change.add ?? []
  const removes = change.remove ?? []

  // Remove-wins: an add that matches a removal is a no-op.
  const isRemoved = (v: unknown): boolean =>
    removes.some(r => isSameSetMember(r, v))

  // 1. Drop removed members, keeping the survivors' relative order.
  if (removes.length > 0) {
    let write = 0
    for (const member of target) {
      if (!isRemoved(member)) {
        target[write] = member
        write++
      }
    }
    target.length = write
  }
  // 2. Append new adds (in `add[]` order), skipping anything already
  // present or marked for removal. An add that matches a retained member
  // is a no-op — it keeps its original position rather than re-appending.
  for (const candidate of adds) {
    if (isRemoved(candidate)) continue
    if (target.some(m => isSameSetMember(m, candidate))) continue
    target.push(candidate)
  }
  return target
}

// ---------------------------------------------------------------------------
// stepTree — apply tree instructions to a flat node array
// ---------------------------------------------------------------------------

interface TreeNode {
  readonly id: string
  readonly parent: string | null
  readonly index: number
  readonly data: unknown
}

export function stepTree(state: unknown[], action: TreeChange): unknown[] {
  return mutateTree([...state], action)
}

/**
 * `stepTree`'s mutating core. Mutates the array, never a node: `stepTree`
 * copies the array but shares its nodes, so a node rewritten here would
 * reach through the copy and out of the pure arrow.
 */
function mutateTree(target: unknown[], action: TreeChange): unknown[] {
  for (const inst of action.instructions) {
    switch (inst.action) {
      case "create": {
        const node: TreeNode = {
          id: inst.target,
          parent: inst.parent,
          index: inst.index,
          data: {},
        }
        target.push(node)
        break
      }
      case "delete": {
        let write = 0
        for (const node of target) {
          if ((node as TreeNode).id !== inst.target) {
            target[write] = node
            write++
          }
        }
        target.length = write
        break
      }
      case "move": {
        for (let i = 0; i < target.length; i++) {
          const node = target[i] as TreeNode
          if (node.id !== inst.target) continue
          target[i] = { ...node, parent: inst.parent, index: inst.index }
        }
        break
      }
    }
  }
  return target
}

// ---------------------------------------------------------------------------
// step — top-level dispatcher
// ---------------------------------------------------------------------------

/**
 * Applies an action to a state value, dispatching on the action's `type`.
 *
 * This is the generic entry point. For known action types it delegates to
 * the specific step function. For unknown action types it throws — callers
 * handling third-party actions should use the specific step functions or
 * register their own dispatchers.
 *
 * ```
 * step("Hello", { type: "text", ops: [{ retain: 5 }, { insert: " World" }] })
 * → "Hello World"
 *
 * step([1, 2, 3], { type: "sequence", ops: [{ retain: 1 }, { delete: 1 }] })
 * → [1, 3]
 *
 * step({ a: 1 }, { type: "map", set: { b: 2 } })
 * → { a: 1, b: 2 }
 *
 * step(42, { type: "replace", value: 99 })
 * → 99
 *
 * step(10, { type: "increment", amount: 5 })
 * → 15
 * ```
 */
export function step<S>(state: S, action: ChangeBase): S {
  switch (action.type) {
    case "text":
      return stepText(state as string, action as TextChange) as S

    case "sequence":
      return stepSequence(state as unknown[], action as SequenceChange) as S

    case "map":
      return stepMap(state as Record<string, unknown>, action as MapChange) as S

    case "replace":
      return stepReplace(state, action as ReplaceChange<S>)

    case "increment":
      return stepIncrement(state as number, action as IncrementChange) as S

    case "richtext":
      return stepRichText(state as RichTextDelta, action as RichTextChange) as S

    case "tree":
      return stepTree(state as unknown[], action as TreeChange) as S

    case "set-op":
      return stepSet(state as unknown[], action as SetChange) as S

    default:
      throw new Error(
        `step: unknown action type "${action.type}". ` +
          `Use a specific step function for third-party action types.`,
      )
  }
}

// ---------------------------------------------------------------------------
// stepInPlace — the mutating dual of `step`
// ---------------------------------------------------------------------------

/**
 * The same arrow as {@link step}, for a caller that owns σ.
 *
 * `step` is pure: it returns a fresh σ' and therefore rebuilds the whole
 * carrier, so k writes into a container of size n cost O(n·k). Every one of
 * `step`'s container cases is already written as `copy-then-mutate`; this
 * dual skips the copy. The cost becomes O(|δ|) for map set/delete and for
 * sequence append — the two shapes a batch that fills a container is made of.
 *
 * Returns the advanced σ. That is `state` itself when δ's carrier is a
 * container the document already holds; otherwise — a value carrier (text,
 * scalar, counter, or a normalised rich-text delta), or a δ whose carrier does
 * not match the σ found at the path — it is a new value the caller must write
 * back. Compare with `!==` to tell the two apart.
 *
 * Substrates own their document and hand out live readers (see the liveness
 * invariant on `plainReader`), and an inverse is recorded from σ *before* the
 * write, so preserving container identity here is observationally equivalent
 * to replacing it.
 */
export function stepInPlace(state: unknown, action: ChangeBase): unknown {
  switch (action.type) {
    case "map":
      if (isPlainObject(state)) return mutateMap(state, action as MapChange)
      break

    case "sequence":
      if (Array.isArray(state))
        return mutateSequence(state, action as SequenceChange)
      break

    case "set-op":
      if (Array.isArray(state)) return mutateSet(state, action as SetChange)
      break

    case "tree":
      if (Array.isArray(state)) return mutateTree(state, action as TreeChange)
      break
  }
  return step(state, action)
}
