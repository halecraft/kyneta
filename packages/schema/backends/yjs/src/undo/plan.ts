// plan — a revert's decisions, pure over what was gathered of the document:
// which of my inserts to delete, which deleted runs to restore where, which
// marks and values still hold what was written; and the remap of what the
// revert restored.

import {
  type ChangeBase,
  mapChange,
  type OwnedRichTextInstruction,
  own,
  planValueRestores,
  type RawPath,
  type Remap,
  replaceChange,
  richTextChange,
  type SequenceInstruction,
  sequenceChange,
  type TextInstruction,
  textChange,
  trustAsOwned,
} from "@kyneta/schema"
import {
  type DeletedRun,
  type Id,
  type IdRun,
  idKey,
  type NestedIds,
  type RunContent,
  type Slot,
  unitsOf,
  type YjsRecord,
} from "./record.js"

// ---------------------------------------------------------------------------
// Revert planning (pure over what was gathered)
// ---------------------------------------------------------------------------

/** One positional edit of a container, in its coordinates before the revert. */
export type PositionalEdit =
  | { readonly kind: "delete"; readonly index: number }
  | {
      readonly kind: "insert"
      readonly gap: number
      readonly content: RunContent
      readonly restores: DeletedRun
    }
  | {
      readonly kind: "format"
      readonly index: number
      readonly key: string
      readonly value: unknown
    }

export interface ComposedEdit {
  readonly change: ChangeBase
  /** For each restore: where its content starts after the change. */
  readonly placed: readonly { run: DeletedRun; at: number }[]
}

export const contentLength = (c: RunContent): number =>
  c.kind === "text"
    ? c.text.length
    : c.kind === "richtext"
      ? c.spans.reduce((n, s) => n + s.text.length, 0)
      : c.items.length

/**
 * One change applying every edit to a container of `length` units, and where
 * where each restored run starts in it. Restores at one gap keep their order.
 */
export function composeEdits(
  kind: string,
  length: number,
  edits: readonly PositionalEdit[],
): ComposedEdit {
  const inserts = new Map<
    number,
    Extract<PositionalEdit, { kind: "insert" }>[]
  >()
  const deletes = new Set<number>()
  const formats = new Map<number, Record<string, unknown>>()
  for (const e of edits) {
    if (e.kind === "insert") {
      const at = Math.min(Math.max(e.gap, 0), length)
      inserts.set(at, [...(inserts.get(at) ?? []), e])
    } else if (e.kind === "delete") deletes.add(e.index)
    else
      formats.set(e.index, {
        ...(formats.get(e.index) ?? {}),
        [e.key]: e.value,
      })
  }
  type Out =
    | { retain: number }
    | { delete: number }
    | { format: number; marks: Record<string, unknown> }
    | { insert: string | unknown[]; marks?: Record<string, unknown> }
  const out: Out[] = []
  const push = (c: Out) => {
    const last = out.at(-1)
    if (last && "retain" in last && "retain" in c) last.retain += c.retain
    else if (last && "delete" in last && "delete" in c) last.delete += c.delete
    else if (
      last &&
      "format" in last &&
      "format" in c &&
      JSON.stringify(last.marks) === JSON.stringify(c.marks)
    )
      last.format += c.format
    else out.push(c)
  }
  const placed: { run: DeletedRun; at: number }[] = []
  let target = 0
  for (let i = 0; i <= length; i++) {
    for (const e of inserts.get(i) ?? []) {
      placed.push({ run: e.restores, at: target })
      const c = e.content
      if (c.kind === "text") push({ insert: c.text })
      else if (c.kind === "sequence") push({ insert: [...c.items] })
      else
        for (const span of c.spans) {
          push(
            span.marks === undefined
              ? { insert: span.text }
              : { insert: span.text, marks: { ...span.marks } },
          )
        }
      target += contentLength(c)
    }
    if (i === length) break
    if (deletes.has(i)) push({ delete: 1 })
    else {
      const f = formats.get(i)
      push(f === undefined ? { retain: 1 } : { format: 1, marks: f })
      target += 1
    }
  }
  while (out.length > 0 && "retain" in (out[out.length - 1] ?? {})) out.pop()
  // Built here from the record's own content, which nothing else holds.
  const change =
    kind === "text"
      ? textChange(out as TextInstruction[])
      : kind === "richtext"
        ? richTextChange(trustAsOwned(out) as OwnedRichTextInstruction[])
        : sequenceChange(trustAsOwned(out) as SequenceInstruction<never>[])
  return { change, placed }
}

// ---------------------------------------------------------------------------
// Revert planning, pure over what was gathered
// ---------------------------------------------------------------------------

/** A container a record touches, as it is now. */
export interface GatheredContainer {
  readonly path: RawPath
  readonly kind: string
  readonly length: number
  /** Each character's marks, for a rich text. */
  readonly marks: readonly Record<string, unknown>[]
}

/**
 * What a record names, as the document holds it now: everything a revert
 * decides by. Containers are named by their path's key; `null` is one that
 * is gone.
 */
export interface YjsGathered {
  readonly containers: ReadonlyMap<string, GatheredContainer>
  /** Per inserted run: where the ids still alive in its container sit. */
  readonly inserted: readonly {
    readonly container: string | null
    readonly indices: readonly number[]
  }[]
  /** Per deleted run: whether any of its ids is alive again, and where its
   *  anchor resolves. */
  readonly deleted: readonly {
    readonly container: string | null
    readonly back: boolean
    readonly gap: number | null
  }[]
  /** Per mark: where the characters still alive in its container sit. */
  readonly marks: readonly {
    readonly container: string | null
    readonly indices: readonly number[]
  }[]
  /** Per value: where it is now, and what it holds. */
  readonly values: readonly {
    readonly path: RawPath | null
    readonly current: Slot
  }[]
}

export interface YjsPlan {
  /** The revert's changes, a change inside a list item before the list. */
  readonly ops: readonly { path: RawPath; change: ChangeBase }[]
  /** Each restored run, and where in its container it starts. */
  readonly placed: readonly {
    readonly container: RawPath
    readonly run: DeletedRun
    readonly at: number
  }[]
}

/** The revert of `record`, decided from what `gathered` says of it. Null
 *  when nothing of it still stands. */
export function planYjsRevert(
  record: YjsRecord,
  gathered: YjsGathered,
): YjsPlan | null {
  const edits = new Map<string, PositionalEdit[]>()
  const editsAt = (key: string) => {
    let list = edits.get(key)
    if (list === undefined) {
      list = []
      edits.set(key, list)
    }
    return list
  }

  // My inserts that are still there.
  for (const { container, indices } of gathered.inserted) {
    if (container === null) continue
    for (const index of indices)
      editsAt(container).push({ kind: "delete", index })
  }

  // What I deleted, unless it is already back.
  record.deleted.forEach((run, i) => {
    const at = gathered.deleted[i]
    if (at === undefined || at.container === null || at.back || at.gap === null)
      return
    editsAt(at.container).push({
      kind: "insert",
      gap: at.gap,
      content: run.content,
      restores: run,
    })
  })

  // Marks that still hold what I set.
  record.marks.forEach((mark, i) => {
    const at = gathered.marks[i]
    if (at === undefined || at.container === null) return
    const container = gathered.containers.get(at.container)
    if (container === undefined) return
    for (const index of at.indices) {
      const marks = container.marks[index] ?? {}
      const held = Object.hasOwn(marks, mark.key) ? marks[mark.key] : null
      const kept = planValueRestores([
        {
          key: index,
          wrote: mark.wrote,
          previous: mark.previous,
          current: held,
        },
      ])
      if (kept.length === 0) continue
      editsAt(at.container).push({
        kind: "format",
        index,
        key: mark.key,
        value: mark.previous,
      })
    }
  })

  const ops: { path: RawPath; change: ChangeBase }[] = []
  const placed: { container: RawPath; run: DeletedRun; at: number }[] = []

  // Values that still hold what I wrote.
  record.values.forEach((write, i) => {
    const at = gathered.values[i]
    if (at === undefined || at.path === null) return
    const kept = planValueRestores([
      {
        key: at.path,
        wrote: write.wrote === null ? ABSENT : write.wrote.value,
        previous: write.previous,
        current: at.current === null ? ABSENT : at.current.value,
      },
    ])
    if (kept.length > 0) ops.push(restoreValue(at.path, write.previous))
  })

  for (const [key, list] of edits) {
    const container = gathered.containers.get(key)
    if (container === undefined) continue
    const composed = composeEdits(container.kind, container.length, list)
    ops.push({ path: container.path, change: composed.change })
    for (const p of composed.placed) {
      placed.push({ container: container.path, ...p })
    }
  }

  if (ops.length === 0) return null
  // Inside out: a change inside a list item applies before the list moves.
  ops.sort((a, b) => b.path.length - a.path.length)
  return { ops, placed }
}

/** A restored run, and the ids it now has: its own, and each nested
 *  text's. */
export interface Landed {
  readonly run: DeletedRun
  readonly fresh: readonly Id[]
  readonly nested: readonly {
    readonly nested: NestedIds
    readonly ids: readonly IdRun[]
  }[]
}

/** The remap of a revert: each restored run's old ids paired, in order,
 *  with the ids it landed with, where the counts agree. */
export function remapOfLanded(landed: readonly Landed[]): Remap {
  const remap = new Map<string, string>()
  const pairAll = (old: readonly Id[], fresh: readonly Id[]) => {
    if (old.length !== fresh.length) return
    old.forEach((id, k) => {
      const to = fresh[k]
      if (to !== undefined) remap.set(idKey(id), idKey(to))
    })
  }
  for (const { run, fresh, nested } of landed) {
    pairAll([...unitsOf(run.ids)], fresh)
    for (const n of nested) {
      pairAll([...unitsOf(n.nested.ids)], [...unitsOf(n.ids)])
    }
  }
  return remap
}

/** The change that puts `previous` back at `path`: a map key removed or set,
 *  or a field replaced. */
function restoreValue(
  path: RawPath,
  previous: Slot,
): { path: RawPath; change: ChangeBase } {
  const last = path.segments.at(-1)
  if (last !== undefined && last.role === "entry") {
    const parent = path.slice(0, path.segments.length - 1) as RawPath
    const key = last.resolve() as string
    // A value this revert read from its own record.
    return previous === null
      ? { path: parent, change: mapChange(undefined, [key]) }
      : {
          path: parent,
          change: mapChange(trustAsOwned({ [key]: own(previous.value) })),
        }
  }
  return { path, change: replaceChange(own(previous?.value)) }
}

/** Stands in for an absent value in comparisons. */
const ABSENT = { absent: true } as const
