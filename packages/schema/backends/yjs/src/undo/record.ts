// record — what an undo record of a Yjs document holds, and its rewrite.
//
// A record names content by Yjs identity (item ids), which survives edits,
// merges, garbage collection and a reload. A container inside a list is
// addressed by a `StablePath`: its path with each list index replaced by the
// list item's id. `rewriteYjsRecord` substitutes the ids a revert re-created.
//
// A record holds the items this peer inserted into a text or list (an undo
// deletes exactly those and spares whatever a collaborator typed among
// them); the runs it deleted, with their ids in document order and their
// content (an undo re-inserts them: Yjs cannot undelete); and the values and
// marks it wrote, restored only while they still hold what it wrote.
//
// A record is kept in normal form (`./normal.js`): it names no id it inserts
// or deletes anywhere but in its own `inserted` and `deleted` lists.

import { jsonRecordCodec, type Remap, type RichTextSpan } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Ids and stable paths
// ---------------------------------------------------------------------------

export interface Id {
  readonly client: number
  readonly clock: number
}

/** `length` consecutive clocks of one client. */
export interface IdRun {
  readonly client: number
  readonly clock: number
  readonly length: number
}

/** A path segment, with a list index replaced by the list item's id. */
export type StableSegment =
  | { readonly field: string }
  | { readonly entry: string }
  | { readonly item: Id }

export type StablePath = readonly StableSegment[]

export const idKey = (id: Id): string => `${id.client}:${id.clock}`

export const samePath = (a: StablePath, b: StablePath): boolean =>
  JSON.stringify(a) === JSON.stringify(b)

export function* expandRuns(runs: readonly IdRun[]): Generator<Id> {
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      yield { client: run.client, clock: run.clock + i }
    }
  }
}

/** Ids as runs of consecutive clocks, in the order given. */
export function toRuns(ids: Iterable<Id>): IdRun[] {
  const runs: IdRun[] = []
  for (const id of ids) {
    const last = runs.at(-1)
    if (
      last !== undefined &&
      last.client === id.client &&
      last.clock + last.length === id.clock
    ) {
      runs[runs.length - 1] = { ...last, length: last.length + 1 }
    } else {
      runs.push({ client: id.client, clock: id.clock, length: 1 })
    }
  }
  return runs
}

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

/** What a list or text held where a run was deleted. */
export type RunContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "richtext"; readonly spans: readonly RichTextSpan[] }
  | { readonly kind: "sequence"; readonly items: readonly unknown[] }

/** The ids of a text or list inside the `item`th item of a deleted list
 *  run, at any depth: a text's characters, a list's items, each in document
 *  order. */
export interface NestedIds {
  readonly item: number
  /** From the item to the container; a list index is the list item's id. */
  readonly path: StablePath
  /** The container's schema kind: `"text"`, `"richtext"` or `"sequence"`. */
  readonly kind: string
  readonly ids: readonly IdRun[]
}

export interface InsertedRun {
  readonly container: StablePath
  readonly ids: readonly IdRun[]
}

export interface DeletedRun {
  readonly container: StablePath
  /** The deleted items, in document order. Empty when unknown: a list
   *  deleted directly on the `Y.Doc` has no public order. */
  readonly ids: readonly IdRun[]
  /** Where to re-insert: just after this item, or at the container's start
   *  when null. It is the item that preceded the run, not the run's own
   *  first item: a text re-inserts past a run of tombstones, so a run
   *  anchored to its own tombstone would land before a neighbour that an
   *  earlier revert in the same step just re-created. The neighbour's id is
   *  rewritten with the rest, and so names that re-creation. */
  readonly after: Id | null
  readonly content: RunContent
  readonly nested: readonly NestedIds[]
}

/** A value slot: present with a value, or absent. */
export type Slot = { readonly value: unknown } | null

export interface ValueWrite {
  readonly path: StablePath
  readonly wrote: Slot
  readonly previous: Slot
}

export interface MarkWrite {
  readonly container: StablePath
  /** The characters I marked. A collaborator's text typed among them
   *  later is not among them. */
  readonly ids: readonly IdRun[]
  readonly key: string
  readonly wrote: unknown
  /** The mark before, or null for none. */
  readonly previous: unknown
}

export interface YjsRecord {
  readonly inserted: readonly InsertedRun[]
  readonly deleted: readonly DeletedRun[]
  readonly values: readonly ValueWrite[]
  readonly marks: readonly MarkWrite[]
}

export function isEmpty(record: YjsRecord): boolean {
  return (
    record.inserted.length === 0 &&
    record.deleted.length === 0 &&
    record.values.length === 0 &&
    record.marks.length === 0
  )
}

/**
 * Where `path` sits among the containers of one deleted item, `nested`: its
 * path with each list item's id replaced by its index in that list. Two
 * copies of one item's content, under different ids, agree on it. Null when
 * a list on the way is not among `nested`, or does not hold the id.
 */
export function positionalPath(
  nested: readonly NestedIds[],
  path: StablePath,
): string | null {
  const out: (StableSegment | number)[] = []
  for (let i = 0; i < path.length; i++) {
    const seg = path[i] as StableSegment
    if (!("item" in seg)) {
      out.push(seg)
      continue
    }
    const prefix = path.slice(0, i)
    const list = nested.find(n => samePath(n.path, prefix))
    if (list === undefined) return null
    const index = [...expandRuns(list.ids)].findIndex(
      id => id.client === seg.item.client && id.clock === seg.item.clock,
    )
    if (index < 0) return null
    out.push(index)
  }
  return JSON.stringify(out)
}

// ---------------------------------------------------------------------------
// Rewrite (pure)
// ---------------------------------------------------------------------------

function rewriteId(id: Id, remap: Remap): Id {
  const to = remap.get(idKey(id))
  if (to === undefined) return id
  const [client, clock] = to.split(":").map(Number)
  return { client, clock }
}

function rewriteRuns(runs: readonly IdRun[], remap: Remap): IdRun[] {
  return toRuns([...expandRuns(runs)].map(id => rewriteId(id, remap)))
}

function rewritePath(path: StablePath, remap: Remap): StablePath {
  return path.map(seg =>
    "item" in seg ? { item: rewriteId(seg.item, remap) } : seg,
  )
}

/** `record` naming what `remap` re-created in place of what it named. */
export function rewriteYjsRecord(record: YjsRecord, remap: Remap): YjsRecord {
  if (remap.size === 0) return record
  return {
    inserted: record.inserted.map(r => ({
      container: rewritePath(r.container, remap),
      ids: rewriteRuns(r.ids, remap),
    })),
    deleted: record.deleted.map(r => ({
      ...r,
      container: rewritePath(r.container, remap),
      after: r.after === null ? null : rewriteId(r.after, remap),
      ids: rewriteRuns(r.ids, remap),
      nested: r.nested.map(n => ({
        ...n,
        path: rewritePath(n.path, remap),
        ids: rewriteRuns(n.ids, remap),
      })),
    })),
    values: record.values.map(v => ({
      ...v,
      path: rewritePath(v.path, remap),
    })),
    marks: record.marks.map(m => ({
      ...m,
      container: rewritePath(m.container, remap),
      ids: rewriteRuns(m.ids, remap),
    })),
  }
}

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

export const codec = jsonRecordCodec<YjsRecord>()
