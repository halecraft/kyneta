// inverse — reverse arrows for the change groupoid.
//
// The change algebra `⟨State, Change, step⟩` is extended into a groupoid
// by `invert`: every `(state, change)` pair has a reverse arrow such that
//
//   step(step(state, change), invert(state, change)) = state
//
// — the groupoid identity law `c ∘ c⁻¹ = id` in coordinates. See the
// plan's "Algebraic framing" subsection for the bigger picture; this
// module is the per-type table of reverse arrows.
//
// Inverses are pure: they depend on the pre-state at the change's target
// path and the change itself. Substrates capture σ at the target path
// before applying the forward change, compute the inverse, push it on
// the active runBatch frame's stack, then apply. On abort, the bracket
// replays inverses LIFO inside the same commit — observers see one
// batched event with net-zero delta.
//
// Context: jj:ryquprut (three-primitive substrate refactor).

import type {
  ChangeBase,
  IncrementChange,
  MapChange,
  ReplaceChange,
  RichTextChange,
  RichTextSpan,
  SequenceChange,
  SequenceInstruction,
  SetChange,
  TextChange,
  TextInstruction,
  TreeChange,
  TreeInstruction,
} from "./change.js"
import {
  incrementChange,
  mapChange,
  replaceChange,
  richTextChange,
  sequenceChange,
  setOpChange,
  textChange,
  treeChange,
} from "./change.js"

// ---------------------------------------------------------------------------
// deepClonePreState — defensive clone for inverse construction
// ---------------------------------------------------------------------------

/**
 * Deep-clone a pre-state value before storing it in an inverse.
 *
 * The substrate captures σ at the change's target path *before* applying
 * the forward change. The same σ is then mutated by `applyChange`, so the
 * inverter must hold a snapshot — otherwise subsequent mutations would
 * corrupt the recorded inverse.
 *
 * Primitives are returned as-is (clone is a no-op for `undefined`, `null`,
 * `boolean`, `number`, `string`, `bigint`, `symbol`). Objects and arrays
 * go through `structuredClone`. Plain JSON values (the σ shape) round-trip
 * faithfully under `structuredClone`.
 */
export function deepClonePreState<T>(value: T): T {
  if (value === null || value === undefined) return value
  const t = typeof value
  if (t === "object") return structuredClone(value)
  return value
}

// ---------------------------------------------------------------------------
// invertReplace — value swap
// ---------------------------------------------------------------------------

/**
 * Reverse arrow for `ReplaceChange`. The inverse re-replaces with the
 * pre-state value. Deep-cloned so subsequent σ mutations don't corrupt
 * the inverse.
 */
export function invertReplace<T>(
  pre: T,
  _change: ReplaceChange<T>,
): ReplaceChange<T> {
  return replaceChange(deepClonePreState(pre))
}

// ---------------------------------------------------------------------------
// invertIncrement — negate the amount
// ---------------------------------------------------------------------------

/**
 * Reverse arrow for `IncrementChange`. The inverse increments by `-amount`.
 * No pre-state needed (counter arithmetic is invertible from the change alone).
 */
export function invertIncrement(change: IncrementChange): IncrementChange {
  return incrementChange(-change.amount)
}

// ---------------------------------------------------------------------------
// invertText — OT inverse for retain/insert/delete instructions
// ---------------------------------------------------------------------------

/**
 * Reverse arrow for `TextChange`. Walks the instruction stream:
 *   retain N → retain N
 *   insert s → delete |s|
 *   delete N → insert pre[cursor..cursor+N]
 *
 * Maintains a `preCursor` pointer into the pre-state string to source
 * deleted content for the reverse `insert`.
 */
export function invertText(pre: string, change: TextChange): TextChange {
  const inverse: TextInstruction[] = []
  const source = pre ?? ""
  let preCursor = 0

  for (const op of change.instructions) {
    if ("retain" in op) {
      inverse.push({ retain: op.retain })
      preCursor += op.retain
    } else if ("insert" in op) {
      inverse.push({ delete: op.insert.length })
      // preCursor does not advance — inserts don't consume source.
    } else if ("delete" in op) {
      const segment = source.slice(preCursor, preCursor + op.delete)
      inverse.push({ insert: segment })
      preCursor += op.delete
    }
  }

  return textChange(inverse)
}

// ---------------------------------------------------------------------------
// invertSequence — OT inverse for sequence retain/insert/delete
// ---------------------------------------------------------------------------

/**
 * Reverse arrow for `SequenceChange`. Same algorithm as `invertText` but
 * over array items.
 *
 * Captures deleted items from `pre[preCursor..preCursor+N]` and deep-clones
 * each so subsequent σ mutations don't corrupt the inverse.
 */
export function invertSequence<T>(
  pre: readonly T[],
  change: SequenceChange<T>,
): SequenceChange<T> {
  const inverse: SequenceInstruction<T>[] = []
  const source = pre ?? []
  let preCursor = 0

  for (const op of change.instructions) {
    if ("retain" in op) {
      inverse.push({ retain: op.retain })
      preCursor += op.retain
    } else if ("insert" in op) {
      inverse.push({ delete: op.insert.length })
    } else if ("delete" in op) {
      const segment = source
        .slice(preCursor, preCursor + op.delete)
        .map(item => deepClonePreState(item))
      inverse.push({ insert: segment })
      preCursor += op.delete
    }
  }

  return sequenceChange(inverse)
}

// ---------------------------------------------------------------------------
// invertMap — restore prior entries
// ---------------------------------------------------------------------------

/**
 * Reverse arrow for `MapChange`. For every key written or deleted,
 * the inverse restores the pre-state value (or deletes if the key
 * didn't exist before).
 *
 * stepMap's order is "delete first, then set." The inverse applies
 * sets first (restore deleted keys) and deletes second (remove newly-set
 * keys that didn't exist before) — same shape as the forward change,
 * just with restored values.
 */
export function invertMap(
  pre: Record<string, unknown>,
  change: MapChange,
): MapChange {
  const source = pre ?? {}
  const invertSet: Record<string, unknown> = {}
  const invertDelete: string[] = []

  if (change.set) {
    for (const key of Object.keys(change.set)) {
      if (Object.hasOwn(source, key)) {
        invertSet[key] = deepClonePreState(source[key])
      } else {
        invertDelete.push(key)
      }
    }
  }

  if (change.delete) {
    for (const key of change.delete) {
      if (Object.hasOwn(source, key)) {
        invertSet[key] = deepClonePreState(source[key])
      }
      // If the key didn't exist, deleting it was a no-op; the inverse
      // is also a no-op (no entry to add to invertSet or invertDelete).
    }
  }

  const hasSet = Object.keys(invertSet).length > 0
  const hasDelete = invertDelete.length > 0
  return mapChange(
    hasSet ? invertSet : undefined,
    hasDelete ? invertDelete : undefined,
  )
}

// ---------------------------------------------------------------------------
// invertSet — swap add and remove
// ---------------------------------------------------------------------------

/**
 * Reverse arrow for `SetChange`. Sets are value-addressed: an add's
 * inverse removes exactly that value; a remove's inverse adds it back.
 * No pre-state needed (set arithmetic is invertible from the change alone
 * under the value-equality semantics of `stepSet`).
 */
export function invertSet<T>(change: SetChange<T>): SetChange<T> {
  return setOpChange<T>(change.remove, change.add)
}

// ---------------------------------------------------------------------------
// invertRichText — OT inverse with mark restoration
// ---------------------------------------------------------------------------

/**
 * Reverse arrow for `RichTextChange`. Walks the instruction stream:
 *   retain N → retain N
 *   insert s → delete |s|  (marks on the insert are restored implicitly by deletion)
 *   delete N → insert pre[cursor..cursor+N]  (with the pre-state marks)
 *   format(N, marks) → format(N, prevMarks)  (restore prior marks on that range)
 *
 * For `format` operations we walk the pre-state span structure to harvest
 * the previous marks; emit one `format(span.length, span.marks ?? {})` per
 * pre-state span that overlaps the formatted range.
 */
export function invertRichText(
  pre: readonly RichTextSpan[],
  change: RichTextChange,
): RichTextChange {
  const inverse: import("./change.js").RichTextInstruction[] = []
  const source = pre ?? []

  // Flat cursor into pre-state spans (mirrors stepRichText's structure).
  let spanIndex = 0
  let charOffset = 0

  /** Consume `count` characters from the source cursor, calling `emit` per pre-state span fragment. */
  function consumeForInverse(
    count: number,
    emit: (length: number, marks: Record<string, unknown> | undefined) => void,
  ): void {
    let remaining = count
    while (remaining > 0 && spanIndex < source.length) {
      const span = source[spanIndex] as RichTextSpan
      const available = span.text.length - charOffset
      const take = Math.min(remaining, available)

      emit(take, span.marks)

      remaining -= take
      charOffset += take
      if (charOffset >= span.text.length) {
        spanIndex++
        charOffset = 0
      }
    }
  }

  for (const op of change.instructions) {
    if ("retain" in op) {
      inverse.push({ retain: op.retain })
      // Advance source cursor through `op.retain` characters.
      consumeForInverse(op.retain, () => {})
    } else if ("format" in op) {
      // Restore prior marks span-by-span. format(N, prevMarks) ≡ retain(N)
      // when prevMarks is empty, but we keep an explicit format to mirror
      // the forward shape and round-trip cleanly.
      consumeForInverse(op.format, (length, prevMarks) => {
        // Construct a mark map that, when merged via stepRichText.format's
        // semantics, restores the pre-state marks: any mark added by the
        // forward op needs to be removed (null in the inverse); any mark
        // overwritten needs to be restored to its prior value.
        const restored: Record<string, unknown> = {}
        for (const key of Object.keys(op.marks)) {
          // If pre had this mark with a different value, restore it.
          // If pre didn't have this mark, the inverse must remove it (null).
          if (prevMarks && Object.hasOwn(prevMarks, key)) {
            restored[key] = prevMarks[key]
          } else {
            restored[key] = null
          }
        }
        inverse.push({ format: length, marks: restored })
      })
    } else if ("insert" in op) {
      inverse.push({ delete: op.insert.length })
      // No source advance — inserts don't consume source.
    } else if ("delete" in op) {
      // Re-emit deleted spans as inserts with their original marks.
      consumeForInverse(op.delete, (length, prevMarks) => {
        // Slice the actual text out of the source for this fragment.
        // consumeForInverse advances charOffset AFTER calling emit, but
        // we need the text at the position before this fragment. Reconstruct
        // by recomputing the position: span at the time of emit is at
        // spanIndex with charOffset *before* this emit's take.
        // Simplest: rebuild from spanIndex/charOffset state at emit-time
        // by storing the take. Use a closure capture.
        // Since emit happens before the cursor advance, charOffset is
        // pre-take here.
        const span = source[spanIndex] as RichTextSpan
        const start = charOffset
        const text = span.text.slice(start, start + length)
        inverse.push(
          prevMarks && Object.keys(prevMarks).length > 0
            ? { insert: text, marks: deepClonePreState(prevMarks) }
            : { insert: text },
        )
      })
    }
  }

  return richTextChange(inverse)
}

// ---------------------------------------------------------------------------
// invertTree — per-instruction inverse with pre-state topology
// ---------------------------------------------------------------------------

/**
 * Reverse arrow for `TreeChange`. Per-instruction inverse:
 *   create(id, parent, index) → delete(id)
 *   delete(id) → create(id, oldParent, oldIndex)
 *   move(id, newParent, newIndex) → move(id, oldParent, oldIndex)
 *
 * `pre` is the `FlatTreeNode[]` topology before the change. We index it
 * by id once for O(1) lookup.
 *
 * Inversion is per-instruction, so the inverse instruction list is the
 * reverse of the forward list — applying inverse instructions LIFO undoes
 * forward instructions in reverse order.
 */
interface TreeTopologyNode {
  readonly id: string
  readonly parent: string | null
  readonly index: number
}

export function invertTree(
  pre: readonly unknown[],
  change: TreeChange,
): TreeChange {
  const byId = new Map<string, TreeTopologyNode>()
  for (const n of pre ?? []) {
    const node = n as TreeTopologyNode
    byId.set(node.id, node)
  }

  // Walk forward, applying each instruction to our local topology so that
  // a later instruction's pre-state reflects earlier instructions in the
  // same change (e.g. create then move).
  const inverse: TreeInstruction[] = []
  for (const inst of change.instructions) {
    if (inst.action === "create") {
      inverse.push({ action: "delete", target: inst.target })
      byId.set(inst.target, {
        id: inst.target,
        parent: inst.parent,
        index: inst.index,
      })
    } else if (inst.action === "delete") {
      const old = byId.get(inst.target)
      if (!old) {
        throw new Error(
          `invertTree: instruction targets non-existent node "${inst.target}". ` +
            `Pre-state topology has ${byId.size} nodes.`,
        )
      }
      inverse.push({
        action: "create",
        target: inst.target,
        parent: old.parent,
        index: old.index,
      })
      byId.delete(inst.target)
    } else if (inst.action === "move") {
      const old = byId.get(inst.target)
      if (!old) {
        throw new Error(
          `invertTree: instruction targets non-existent node "${inst.target}". ` +
            `Pre-state topology has ${byId.size} nodes.`,
        )
      }
      inverse.push({
        action: "move",
        target: inst.target,
        parent: old.parent,
        index: old.index,
      })
      byId.set(inst.target, {
        id: inst.target,
        parent: inst.parent,
        index: inst.index,
      })
    }
  }

  // LIFO: reverse so that applying invert(c) undoes c instruction-by-instruction
  // from the most recent. (For tree this matters when one change creates a node
  // and a later change deletes it; the inverse of the combined change must
  // re-create then re-delete in the opposite order.)
  inverse.reverse()
  return treeChange(inverse)
}

// ---------------------------------------------------------------------------
// invert — top-level dispatcher
// ---------------------------------------------------------------------------

/**
 * Compute the reverse arrow for `(pre, change)` in the change groupoid.
 *
 * `pre` is the σ value at the change's target path *before* applying.
 * The returned `ChangeBase` satisfies the groupoid identity law:
 *
 *   step(step(pre, change), invert(pre, change)) = pre
 *
 * Dispatches on `change.type`. Mirrors the structure of `step` in
 * `step.ts` — every type that `step` handles, `invert` must handle.
 */
export function invert(pre: unknown, change: ChangeBase): ChangeBase {
  switch (change.type) {
    case "replace":
      return invertReplace(pre, change as ReplaceChange<unknown>)
    case "increment":
      return invertIncrement(change as IncrementChange)
    case "text":
      return invertText(pre as string, change as TextChange)
    case "sequence":
      return invertSequence(pre as unknown[], change as SequenceChange)
    case "map":
      return invertMap(pre as Record<string, unknown>, change as MapChange)
    case "set-op":
      return invertSet(change as SetChange)
    case "richtext":
      return invertRichText(
        pre as readonly RichTextSpan[],
        change as RichTextChange,
      )
    case "tree":
      return invertTree(pre as readonly unknown[], change as TreeChange)
    default:
      throw new Error(
        `invert: unknown change type "${change.type}". ` +
          `Use a specific invert function for third-party change types.`,
      )
  }
}
