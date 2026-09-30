// revertible — undo for a Yjs document, on Yjs's public API.
//
// A record names content by Yjs identity, which survives edits, merges,
// garbage collection and a reload:
//
// - the items this peer inserted into a text or list, so an undo deletes
//   exactly those and spares whatever a collaborator typed among them;
// - the runs it deleted, with their ids in document order and their content,
//   so an undo re-inserts the content where it was (Yjs cannot undelete);
// - the values and marks it wrote, which an undo restores only while they
//   still hold what it wrote (state, not identity: see `planValueRestores`).
//
// A container inside a list is addressed by its path with each list index
// replaced by the list item's id (`StablePath`). Re-inserting deleted content
// creates new items, so a revert returns a remap from the old ids to the new
// ones, and the stack rewrites every older record through it.
//
// Only these Yjs calls are used, and `yjs-surface.test.ts` pins each one:
// relative positions (from an index, from JSON, to JSON, resolved back),
// `isDeleted` over `snapshot`, `getState`, the transaction's `local`,
// `beforeState`, `afterState` and `deleteSet`, `YEvent.changes` and the item
// ids and lengths it lists, and `YText.toDelta` over two snapshots with
// `computeYChange`, which is how the ids of text in document order are read.

import {
  type BatchOutcome,
  type ChangeBase,
  findOpaqueBoundary,
  isMapChange,
  isReplaceChange,
  isRichTextChange,
  isSequenceChange,
  isTextChange,
  jsonRecordCodec,
  KIND,
  mapChange,
  mapChangeEffects,
  type Op,
  type OwnedRichTextInstruction,
  own,
  type Path,
  type PlainState,
  pathSchema,
  planValueRestores,
  RawPath,
  type Remap,
  type Revertible,
  type RevertibleCommit,
  type RichTextSpan,
  replaceChange,
  richTextChange,
  type SchemaBinding,
  type Schema as SchemaNode,
  type SequenceInstruction,
  sequenceChange,
  type TextInstruction,
  textChange,
  trustAsOwned,
  type WritableContext,
} from "@kyneta/schema"
import * as Y from "yjs"
import { yjsPathToKynetaPath } from "./change-mapping.js"
import { resolveYjsType } from "./yjs-resolve.js"

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

const idKey = (id: Id): string => `${id.client}:${id.clock}`

function* unitsOf(runs: readonly IdRun[]): Generator<Id> {
  for (const run of runs) {
    for (let i = 0; i < run.length; i++) {
      yield { client: run.client, clock: run.clock + i }
    }
  }
}

/** Ids as runs of consecutive clocks, in the order given. */
function toRuns(ids: Iterable<Id>): IdRun[] {
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

/** The ids of a text inside the `item`th item of a deleted list run. */
export interface NestedIds {
  readonly item: number
  /** From the item to the text: fields and entries only. */
  readonly path: StablePath
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
  /** Where to re-insert: a relative position, as JSON. */
  readonly anchor: unknown
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

const EMPTY: YjsRecord = { inserted: [], deleted: [], values: [], marks: [] }

function isEmpty(record: YjsRecord): boolean {
  return (
    record.inserted.length === 0 &&
    record.deleted.length === 0 &&
    record.values.length === 0 &&
    record.marks.length === 0
  )
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
  return toRuns([...unitsOf(runs)].map(id => rewriteId(id, remap)))
}

function rewritePath(path: StablePath, remap: Remap): StablePath {
  return path.map(seg =>
    "item" in seg ? { item: rewriteId(seg.item, remap) } : seg,
  )
}

/** `record` naming what `remap` re-created in place of what it named. */
function rewriteYjsRecord(record: YjsRecord, remap: Remap): YjsRecord {
  if (remap.size === 0) return record
  return {
    inserted: record.inserted.map(r => ({
      container: rewritePath(r.container, remap),
      ids: rewriteRuns(r.ids, remap),
    })),
    deleted: record.deleted.map(r => ({
      ...r,
      container: rewritePath(r.container, remap),
      ids: rewriteRuns(r.ids, remap),
      nested: r.nested.map(n => ({ ...n, ids: rewriteRuns(n.ids, remap) })),
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
// Reading ids from a Y.Doc
// ---------------------------------------------------------------------------

/** The id of the item at `index` of `type`, or null past its end. */
function idAt(type: Y.AbstractType<any>, index: number): Id | null {
  const json = Y.relativePositionToJSON(
    Y.createRelativePositionFromTypeIndex(type, index, 0),
  ) as { item?: Id | null }
  return json.item ?? null
}

/** Where item `id` sits now: its type and index, or null if it is gone. */
function locate(
  doc: Y.Doc,
  id: Id,
): { type: Y.AbstractType<any>; index: number } | null {
  const abs = Y.createAbsolutePositionFromRelativePosition(
    Y.createRelativePositionFromJSON({ item: id, assoc: 0 }),
    doc,
  )
  return abs === null ? null : { type: abs.type, index: abs.index }
}

function resolveAnchor(doc: Y.Doc, anchor: unknown): number | null {
  const abs = Y.createAbsolutePositionFromRelativePosition(
    Y.createRelativePositionFromJSON(anchor),
    doc,
  )
  return abs === null ? null : abs.index
}

/**
 * Walk a text's items in document order, through two snapshots:
 * `computeYChange` names each item that differs between them, and a run with
 * no change is `"same"`.
 */
function textRuns(
  text: Y.Text,
  current: Y.Snapshot,
  previous: Y.Snapshot,
): { type: string; id: Id | null; insert: string }[] {
  const delta = text.toDelta(current, previous, (type: string, id: Y.ID) => ({
    type,
    id: { client: id.client, clock: id.clock },
  })) as {
    insert?: unknown
    attributes?: { ychange?: { type: string; id: Id } }
  }[]
  const out: { type: string; id: Id | null; insert: string }[] = []
  for (const op of delta) {
    if (typeof op.insert !== "string") continue
    const ychange = op.attributes?.ychange
    out.push(
      ychange === undefined
        ? { type: "same", id: null, insert: op.insert }
        : { type: ychange.type, id: ychange.id, insert: op.insert },
    )
  }
  return out
}

/** Every character's id in `text`, in document order. */
function textIds(doc: Y.Doc, text: Y.Text): IdRun[] {
  const empty = Y.createSnapshot(Y.createDeleteSet(), new Map())
  const ids: Id[] = []
  for (const run of textRuns(text, Y.snapshot(doc), empty)) {
    if (run.type !== "added" || run.id === null) continue
    for (let k = 0; k < run.insert.length; k++) {
      ids.push({ client: run.id.client, clock: run.id.clock + k })
    }
  }
  return toRuns(ids)
}

function stateOf(doc: Y.Doc, client: number): number {
  return Y.getState(doc.store, client)
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Yjs exports the constructor of its delete set, not the type. */
type DeleteSet = ReturnType<typeof Y.createDeleteSet>

interface Tree {
  readonly doc: Y.Doc
  readonly rootMap: Y.Map<any>
  readonly schema: SchemaNode
  readonly binding: SchemaBinding | undefined
}

function typeAt(tree: Tree, path: Path): unknown {
  return resolveYjsType(tree.rootMap, tree.schema, path, tree.binding).resolved
}

/** `path` as it stands now, with each list index replaced by its item's id. */
function stabilize(tree: Tree, path: Path): StablePath | null {
  const out: StableSegment[] = []
  let prefix = RawPath.empty
  for (const seg of path.toRaw().segments) {
    const key = seg.resolve()
    if (seg.role === "field") {
      out.push({ field: key as string })
      prefix = prefix.field(key as string)
    } else if (seg.role === "entry") {
      out.push({ entry: key as string })
      prefix = prefix.entry(key as string)
    } else {
      const list = typeAt(tree, prefix)
      if (!(list instanceof Y.Array)) return null
      const id = idAt(list, key as number)
      if (id === null) return null
      out.push({ item: id })
      prefix = prefix.item(key as number)
    }
  }
  return out
}

/** Where `path` is now, or null if a list item on the way is gone. */
function destabilize(
  tree: Tree,
  path: StablePath,
  deleted: DeleteSet,
): RawPath | null {
  let raw = RawPath.empty
  for (const seg of path) {
    if ("field" in seg) raw = raw.field(seg.field)
    else if ("entry" in seg) raw = raw.entry(seg.entry)
    else {
      if (Y.isDeleted(deleted, Y.createID(seg.item.client, seg.item.clock)))
        return null
      const list = typeAt(tree, raw)
      const at = locate(tree.doc, seg.item)
      if (at === null || at.type !== list) return null
      raw = raw.item(at.index)
    }
  }
  return raw
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** What one transaction did, gathered as it happens. */
interface Draft {
  inserted: InsertedRun[]
  deleted: DeletedRun[]
  values: Map<string, ValueWrite>
  marks: MarkWrite[]
  /** `.json()` values the batch wrote into, with what they held before. */
  boundaries: Map<string, { path: StablePath; at: Path; previous: Slot }>
  /** A rich text's spans before the transaction first touched it. */
  texts: Map<string, readonly RichTextSpan[]>
  aborted: boolean
}

const newDraft = (): Draft => ({
  inserted: [],
  deleted: [],
  values: new Map(),
  marks: [],
  boundaries: new Map(),
  texts: new Map(),
  aborted: false,
})

/** The item schema of a list, or undefined for anything else. */
function itemOf(schema: SchemaNode): SchemaNode | undefined {
  return "item" in schema ? (schema.item as SchemaNode) : undefined
}

function kindAt(tree: Tree, path: Path): string {
  return pathSchema(tree.schema, path, tree.binding)[KIND]
}

/** Keep a value write: the first `previous` and the last `wrote`. */
function addValue(draft: Draft, write: ValueWrite): void {
  const key = JSON.stringify(write.path)
  const earlier = draft.values.get(key)
  draft.values.set(
    key,
    earlier === undefined ? write : { ...write, previous: earlier.previous },
  )
}

/**
 * The value writes `change` makes at `path`, read against `pre`, the value
 * there before it.
 */
function valueWrites(
  tree: Tree,
  path: Path,
  change: ChangeBase,
  pre: unknown,
): { path: Path; wrote: Slot; previous: Slot }[] {
  if (isReplaceChange(change)) {
    return [
      {
        path,
        wrote: { value: change.value },
        previous: pre === undefined ? null : { value: pre },
      },
    ]
  }
  if (isMapChange(change)) {
    const held = (pre ?? {}) as Record<string, unknown>
    const { set, remove } = mapChangeEffects(change, Object.keys(held))
    const product = kindAt(tree, path) === "product"
    const at = (k: string) => (product ? path.field(k) : path.entry(k))
    const slot = (k: string): Slot =>
      Object.hasOwn(held, k) ? { value: held[k] } : null
    return [
      ...Object.entries(set).map(([k, v]) => ({
        path: at(k),
        wrote: { value: v },
        previous: slot(k),
      })),
      ...remove.map(k => ({ path: at(k), wrote: null, previous: slot(k) })),
    ]
  }
  return []
}

/**
 * When a change is read: `"before"` it applies (a Kyneta batch, in
 * `prepare`), or `"after"` (a direct write, in the event bridge). Indices
 * then count in the change's source or target coordinates.
 */
type Stage = "before" | "after"

/**
 * The mark writes of a rich-text change read at `stage`, against the spans
 * that were there before it. `idOf` names the character at an index.
 */
function markWrites(
  container: StablePath,
  change: ChangeBase,
  spans: readonly RichTextSpan[],
  stage: Stage,
  idOf: (index: number) => Id | null,
): MarkWrite[] {
  if (!isRichTextChange(change)) return []
  const marksAt = (index: number): Record<string, unknown> => {
    let offset = 0
    for (const span of spans) {
      if (index < offset + span.text.length) return { ...(span.marks ?? {}) }
      offset += span.text.length
    }
    return {}
  }
  // One write per key, value set and value replaced, over every character
  // that took it.
  const groups = new Map<
    string,
    { key: string; wrote: unknown; previous: unknown; ids: Id[] }
  >()
  let source = 0
  let target = 0
  for (const op of change.instructions) {
    if ("retain" in op) {
      source += op.retain
      target += op.retain
    } else if ("delete" in op) {
      source += op.delete
    } else if ("insert" in op) {
      target += op.insert.length
    } else {
      for (let i = 0; i < op.format; i++) {
        const id = idOf((stage === "before" ? source : target) + i)
        if (id === null) continue
        const before = marksAt(source + i)
        for (const [key, wrote] of Object.entries(op.marks)) {
          const previous = Object.hasOwn(before, key) ? before[key] : null
          const slot = JSON.stringify([key, wrote, previous])
          const group = groups.get(slot) ?? { key, wrote, previous, ids: [] }
          group.ids.push(id)
          groups.set(slot, group)
        }
      }
      source += op.format
      target += op.format
    }
  }
  const out: MarkWrite[] = []
  for (const { key, wrote, previous, ids } of groups.values()) {
    out.push({ container, ids: toRuns(ids), key, wrote, previous })
  }
  return out
}

/**
 * The deleted list runs of a sequence change. Before it applies, each run's
 * ids come in document order from the list; after, the items are gone and
 * their order is not public, so the content restores and the ids do not
 * follow.
 */
function deletedItems(
  tree: Tree,
  container: StablePath,
  path: Path,
  change: ChangeBase,
  pre: readonly unknown[],
  list: Y.Array<unknown> | null,
  stage: Stage,
): DeletedRun[] {
  if (!isSequenceChange(change)) return []
  const itemSchema = itemOf(pathSchema(tree.schema, path, tree.binding))
  const out: DeletedRun[] = []
  let source = 0
  let target = 0
  for (const op of change.instructions) {
    if ("retain" in op) {
      source += op.retain
      target += op.retain
    } else if ("insert" in op) {
      target += op.insert.length
    } else {
      const ids: Id[] = []
      const nested: NestedIds[] = []
      if (list !== null && stage === "before") {
        for (let i = 0; i < op.delete; i++) {
          const id = idAt(list, source + i)
          if (id !== null) ids.push(id)
          if (itemSchema === undefined) continue
          for (const text of nestedTexts(
            tree,
            path.item(source + i),
            itemSchema,
          )) {
            nested.push({ item: i, ...text })
          }
        }
      }
      const first = ids[0]
      const at = stage === "before" ? source : target
      out.push({
        container,
        ids: toRuns(ids),
        anchor:
          first !== undefined
            ? { item: first, assoc: 0 }
            : list !== null
              ? Y.relativePositionToJSON(
                  Y.createRelativePositionFromTypeIndex(list, at, 0),
                )
              : null,
        content: {
          kind: "sequence",
          items: own(pre.slice(source, source + op.delete)),
        },
        nested,
      })
      source += op.delete
    }
  }
  return out
}

/** The texts inside the list item at `item`, with their ids in document
 *  order. */
function nestedTexts(
  tree: Tree,
  item: Path,
  schema: SchemaNode,
): { path: StablePath; ids: IdRun[] }[] {
  const out: { path: StablePath; ids: IdRun[] }[] = []
  const walk = (node: SchemaNode, at: Path, path: StableSegment[]) => {
    const kind = node[KIND]
    if (kind === "text" || kind === "richtext") {
      const text = typeAt(tree, at)
      if (text instanceof Y.Text)
        out.push({ path, ids: textIds(tree.doc, text) })
    } else if (kind === "product") {
      const fields = (node as unknown as { fields: Record<string, SchemaNode> })
        .fields
      for (const [name, field] of Object.entries(fields)) {
        walk(field, at.field(name), [...path, { field: name }])
      }
    }
  }
  walk(schema, item, [])
  return out
}

/**
 * What one transaction did to a text, read before gc: the runs it deleted,
 * with their content, and the characters it inserted, each in document
 * order. Yjs's text events list no items, so both come from the text's
 * items between the state before the transaction and now.
 *
 * A deleted run's marks are read from `before`, the text's spans before the
 * transaction, since Yjs renders deleted text without its formatting.
 */
function textChanges(
  doc: Y.Doc,
  text: Y.Text,
  container: StablePath,
  transaction: Y.Transaction,
  before: readonly RichTextSpan[] | null,
): { deleted: DeletedRun[]; inserted: IdRun[] } {
  const previous = Y.createSnapshot(
    Y.createDeleteSet(),
    transaction.beforeState,
  )
  const marks = before === null ? null : charMarks(before)
  const deleted: DeletedRun[] = []
  const inserted: Id[] = []
  let open:
    | { ids: Id[]; text: string; spans: RichTextSpan[]; first: Id }
    | undefined
  const close = () => {
    if (open === undefined) return
    deleted.push({
      container,
      ids: toRuns(open.ids),
      anchor: { item: open.first, assoc: 0 },
      content:
        marks === null
          ? { kind: "text", text: open.text }
          : { kind: "richtext", spans: open.spans },
      nested: [],
    })
    open = undefined
  }
  // Where the walk is in the text as it was before the transaction.
  let index = 0
  for (const run of textRuns(text, Y.snapshot(doc), previous)) {
    const { id } = run
    if (run.type === "same" || id === null) {
      close()
      index += run.insert.length
      continue
    }
    const ids = Array.from({ length: run.insert.length }, (_, k) => ({
      client: id.client,
      clock: id.clock + k,
    }))
    if (run.type === "added") {
      close()
      inserted.push(...ids)
      continue
    }
    // Removed: by this transaction, or earlier (then not part of `before`).
    if (!Y.isDeleted(transaction.deleteSet, Y.createID(id.client, id.clock))) {
      close()
      continue
    }
    open ??= { ids: [], text: "", spans: [], first: id }
    open.ids.push(...ids)
    open.text += run.insert
    for (let k = 0; k < run.insert.length; k++) {
      const m = marks?.[index + k] ?? {}
      const last = open.spans.at(-1)
      const char = run.insert[k] ?? ""
      if (
        last !== undefined &&
        JSON.stringify(last.marks ?? {}) === JSON.stringify(m)
      ) {
        open.spans[open.spans.length - 1] = { ...last, text: last.text + char }
      } else {
        open.spans.push(
          Object.keys(m).length > 0 ? { text: char, marks: m } : { text: char },
        )
      }
    }
    index += run.insert.length
  }
  close()
  return { deleted, inserted: toRuns(inserted) }
}

// ---------------------------------------------------------------------------
// Revert planning (pure over what was gathered)
// ---------------------------------------------------------------------------

/** One positional edit of a container, in its coordinates before the revert. */
type Edit =
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

interface ComposedEdit {
  readonly change: ChangeBase
  /** For each restore: where its content starts after the change. */
  readonly placed: readonly { run: DeletedRun; at: number }[]
}

const contentLength = (c: RunContent): number =>
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
  edits: readonly Edit[],
): ComposedEdit {
  const inserts = new Map<number, Extract<Edit, { kind: "insert" }>[]>()
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
  const edits = new Map<string, Edit[]>()
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

// ---------------------------------------------------------------------------
// Codec
// ---------------------------------------------------------------------------

const codec = jsonRecordCodec<YjsRecord>()

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

export interface YjsRevertibleHost {
  readonly doc: Y.Doc
  readonly rootMap: Y.Map<any>
  readonly schema: SchemaNode
  readonly binding: SchemaBinding | undefined
  readonly shadow: PlainState
  context(): WritableContext
}

/** A Yjs substrate's undo, plus the hooks the substrate calls. */
export interface YjsRevertible extends Revertible<YjsRecord> {
  /** Whether anything needs records: hooks do nothing otherwise. */
  readonly active: boolean
  /** An authored transaction opened. */
  opened(transaction: Y.Transaction): void
  /** An authored op, before it applies. */
  preparing(path: Path, change: ChangeBase): void
  /** The authored op `preparing` saw, after it applied. */
  prepared(path: Path, change: ChangeBase): void
  /** An authored batch ended. */
  ended(outcome: BatchOutcome): void
  /** Events on the root map, for any transaction, before the bridge syncs σ. */
  observed(
    events: Y.YEvent<any>[],
    transaction: Y.Transaction,
    ops: readonly Op[] | null,
  ): void
}

export function createYjsRevertible(host: YjsRevertibleHost): YjsRevertible {
  const { doc } = host
  const tree: Tree = host
  const listeners = new Set<(commit: RevertibleCommit<YjsRecord>) => void>()
  const drafts = new Map<Y.Transaction, Draft>()
  let authored: Y.Transaction | undefined
  let reverting: { record: YjsRecord | null } | undefined

  const active = () => listeners.size > 0 || reverting !== undefined
  const draftFor = (tr: Y.Transaction): Draft => {
    let draft = drafts.get(tr)
    if (draft === undefined) {
      draft = newDraft()
      drafts.set(tr, draft)
    }
    return draft
  }

  // The ops of each transaction, for grouping.
  const draftOps = new Map<Y.Transaction, Op[]>()

  doc.on("afterTransaction", (tr: Y.Transaction) => {
    const draft = drafts.get(tr)
    if (draft === undefined) return
    drafts.delete(tr)
    const ops = draftOps.get(tr) ?? []
    draftOps.delete(tr)
    if (!tr.local || draft.aborted) return
    const record: YjsRecord = {
      inserted: draft.inserted,
      deleted: draft.deleted,
      values: [...draft.values.values()],
      marks: draft.marks,
    }
    if (isEmpty(record)) return
    if (reverting !== undefined) {
      reverting.record = record
      return
    }
    for (const listener of [...listeners]) listener({ record, ops })
  })

  // The client's clock before the authored op `prepared` will see.
  let clockBefore = 0

  /**
   * What an op wrote, read against `pre`, σ at its path before it: its
   * values, the list runs it deleted, and its marks.
   */
  function capture(
    draft: Draft,
    path: Path,
    change: ChangeBase,
    pre: unknown,
    stage: Stage,
  ): void {
    for (const w of valueWrites(tree, path, change, pre)) {
      const at = stabilize(tree, w.path)
      if (at !== null) {
        addValue(draft, { path: at, wrote: w.wrote, previous: w.previous })
      }
    }
    const stable = stabilize(tree, path)
    if (stable === null) return
    const target = typeAt(tree, path)
    if (isSequenceChange(change)) {
      const list = target instanceof Y.Array ? target : null
      draft.deleted.push(
        ...deletedItems(
          tree,
          stable,
          path,
          change,
          (pre ?? []) as unknown[],
          list,
          stage,
        ),
      )
    }
    if (isRichTextChange(change) && target instanceof Y.Text) {
      draft.marks.push(
        ...markWrites(stable, change, (pre ?? []) as RichTextSpan[], stage, i =>
          idAt(target, i),
        ),
      )
    }
  }

  const revertible: YjsRevertible = {
    get active() {
      return active()
    },

    opened(transaction) {
      authored = transaction
    },

    preparing(path, change) {
      if (!active() || authored === undefined) return
      clockBefore = stateOf(doc, doc.clientID)
      const draft = draftFor(authored)
      // Inside a `.json()` value the whole value is one register, written
      // as a whole when the batch ends: record it as one value.
      const boundary = findOpaqueBoundary(tree.schema, path, tree.binding)
      if (boundary !== null) {
        const at = path.slice(0, boundary.prefixLength + 1)
        const stableAt = stabilize(tree, at)
        if (stableAt === null) return
        const key = JSON.stringify(stableAt)
        if (!draft.boundaries.has(key)) {
          draft.boundaries.set(key, {
            path: stableAt,
            at,
            previous: readSlot(at),
          })
        }
        return
      }
      const pre = path.read(host.shadow)
      if (isRichTextChange(change)) {
        const stable = stabilize(tree, path)
        const key = JSON.stringify(stable)
        if (stable !== null && !draft.texts.has(key)) {
          draft.texts.set(key, (pre ?? []) as RichTextSpan[])
        }
      }
      capture(draft, path, change, pre, "before")
    },

    prepared(path, change) {
      if (!active() || authored === undefined) return
      const positional =
        isTextChange(change) ||
        isSequenceChange(change) ||
        isRichTextChange(change)
      if (!positional || !change.instructions.some(i => "insert" in i)) return
      const stable = stabilize(tree, path)
      if (stable === null) return
      let ids: IdRun[]
      if (isRichTextChange(change)) {
        // Marks on an insert are format items of their own, which an undo
        // must leave for the mark rule: take only the characters.
        const text = typeAt(tree, path)
        if (!(text instanceof Y.Text)) return
        const chars: Id[] = []
        let target = 0
        for (const op of change.instructions) {
          if ("insert" in op) {
            for (let k = 0; k < op.insert.length; k++) {
              const id = idAt(text, target + k)
              if (id !== null) chars.push(id)
            }
            target += op.insert.length
          } else if ("retain" in op) target += op.retain
          else if ("format" in op) target += op.format
        }
        ids = toRuns(chars)
      } else {
        const clockAfter = stateOf(doc, doc.clientID)
        if (clockAfter === clockBefore) return
        ids = [
          {
            client: doc.clientID,
            clock: clockBefore,
            length: clockAfter - clockBefore,
          },
        ]
      }
      if (ids.length > 0) {
        draftFor(authored).inserted.push({ container: stable, ids })
      }
    },

    ended(outcome) {
      if (authored === undefined) return
      const draft = drafts.get(authored)
      const transaction = authored
      authored = undefined
      if (draft === undefined) return
      if (outcome.aborted) {
        draft.aborted = true
        return
      }
      draftOps.set(transaction, [...outcome.ops])
      for (const { path, at, previous } of draft.boundaries.values()) {
        addValue(draft, { path, wrote: readSlot(at), previous })
      }
    },

    observed(events, transaction, ops) {
      if (!active() || !transaction.local) return
      const draft = draftFor(transaction)
      // What happened to texts: deletions for authored and direct writes
      // alike, insertions for direct writes (an authored insert is known
      // from the clock around it).
      for (const event of events) {
        const target = event.target
        if (!(target instanceof Y.Text)) continue
        const path = pathOf(event)
        if (path === null) continue
        const stable = stabilize(tree, path)
        if (stable === null) continue
        // σ still holds a direct write's before-state here; an authored
        // batch noted it as it began.
        const before =
          kindAt(tree, path) !== "richtext"
            ? null
            : (draft.texts.get(JSON.stringify(stable)) ??
              ((path.read(host.shadow) ?? []) as RichTextSpan[]))
        const { deleted, inserted } = textChanges(
          doc,
          target,
          stable,
          transaction,
          before,
        )
        draft.deleted.push(...deleted)
        if (ops !== null && inserted.length > 0) {
          draft.inserted.push({ container: stable, ids: inserted })
        }
      }
      if (ops === null) return
      // The rest of a direct write: what `prepare` gathers for an authored
      // op, read after the write, with σ still before it.
      draftOps.set(transaction, [...ops])
      for (const event of events) {
        const target = event.target
        if (!(target instanceof Y.Array)) continue
        const path = pathOf(event)
        if (path === null) continue
        const stable = stabilize(tree, path)
        if (stable === null) continue
        const ids: Id[] = []
        for (const item of event.changes.added) {
          for (let k = 0; k < item.length; k++) {
            ids.push({ client: item.id.client, clock: item.id.clock + k })
          }
        }
        ids.sort((a, b) => a.client - b.client || a.clock - b.clock)
        if (ids.length > 0) {
          draft.inserted.push({ container: stable, ids: toRuns(ids) })
        }
      }
      for (const op of ops) {
        capture(draft, op.path, op.change, op.path.read(host.shadow), "after")
      }
    },

    subscribeCommits(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    revert(record, options) {
      const plan = planYjsRevert(record, gather(record))
      if (plan === null) return null
      const ctx = host.context()
      reverting = { record: null }
      try {
        ctx.runBatch(() => {
          for (const { path, change } of plan.ops) ctx.dispatch(path, change)
        }, options)
        const redo = reverting.record ?? EMPTY
        return { redo, remap: remapOfLanded(landed(plan)) }
      } finally {
        reverting = undefined
      }
    },

    recovered(record, position) {
      const from = decodePosition(position)
      const now = stateOf(doc, from.client)
      const fresh: IdRun[] =
        now > from.clock
          ? [
              {
                client: from.client,
                clock: from.clock,
                length: now - from.clock,
              },
            ]
          : []
      const restorable = record.deleted
      const remap = new Map<string, string>()
      // One restored run is the revert's whole insertion: its ids pair up.
      if (restorable.length === 1) {
        const [run] = restorable
        const old = [...unitsOf(run.ids)]
        const next = [...unitsOf(fresh)]
        if (old.length > 0 && old.length <= next.length) {
          old.forEach((id, k) => {
            remap.set(idKey(id), idKey(next[k] as Id))
          })
        }
      }
      return {
        redo: {
          inserted: restorable.map(r => ({
            container: r.container,
            ids: fresh,
          })),
          deleted: [],
          values: record.values.map(v => ({
            ...v,
            wrote: v.previous,
            previous: v.wrote,
          })),
          marks: record.marks.map(m => ({
            ...m,
            wrote: m.previous,
            previous: m.wrote,
          })),
        },
        remap,
      }
    },

    rewrite: rewriteYjsRecord,

    position() {
      return encodePosition({
        client: doc.clientID,
        clock: stateOf(doc, doc.clientID),
      })
    },

    authoredSince(position) {
      const from = decodePosition(position)
      return stateOf(doc, from.client) > from.clock
    },

    codec,
  }

  function pathOf(event: Y.YEvent<any>): Path | null {
    try {
      return yjsPathToKynetaPath(event.path, tree.schema, tree.binding)
    } catch {
      return null
    }
  }

  /** Read what `record` names as the document holds it now. */
  function gather(record: YjsRecord): YjsGathered {
    const deletedNow = Y.snapshot(doc).ds
    const alive = (id: Id) =>
      !Y.isDeleted(deletedNow, Y.createID(id.client, id.clock))
    const containers = new Map<string, GatheredContainer>()
    /** A container's key, noting its kind and length, or null if gone. */
    const container = (stable: StablePath): string | null => {
      const path = destabilize(tree, stable, deletedNow)
      if (path === null) return null
      if (!containers.has(path.key)) {
        const kind = kindAt(tree, path)
        const current = path.read(host.shadow)
        const length =
          kind === "text"
            ? String(current ?? "").length
            : kind === "richtext"
              ? ((current ?? []) as RichTextSpan[]).reduce(
                  (n, span) => n + span.text.length,
                  0,
                )
              : ((current ?? []) as unknown[]).length
        const spans = kind === "richtext" ? (current as RichTextSpan[]) : []
        containers.set(path.key, {
          path,
          kind,
          length,
          marks: charMarks(spans ?? []),
        })
      }
      return path.key
    }
    /** Where each id still alive in the container sits. */
    const indices = (key: string | null, ids: readonly IdRun[]) => {
      const at = key === null ? undefined : containers.get(key)
      if (at === undefined) return []
      const type = typeAt(tree, at.path)
      const out: { id: Id; index: number }[] = []
      for (const id of unitsOf(ids)) {
        if (!alive(id)) continue
        const where = locate(doc, id)
        if (where !== null && where.type === type) {
          out.push({ id, index: where.index })
        }
      }
      return out
    }
    return {
      containers,
      inserted: record.inserted.map(run => {
        const key = container(run.container)
        return {
          container: key,
          indices: indices(key, run.ids).map(u => u.index),
        }
      }),
      deleted: record.deleted.map(run => ({
        container: container(run.container),
        back: [...unitsOf(run.ids)].some(alive),
        gap: run.anchor === null ? null : resolveAnchor(doc, run.anchor),
      })),
      marks: record.marks.map(mark => {
        const key = container(mark.container)
        return {
          container: key,
          indices: indices(key, mark.ids).map(u => u.index),
        }
      }),
      values: record.values.map(write => {
        const path = destabilize(tree, write.path, deletedNow)
        return { path, current: path === null ? null : readSlot(path) }
      }),
    }
  }

  /** What the revert gave each run it restored, read where it landed. */
  function landed(plan: YjsPlan): Landed[] {
    return plan.placed.map(({ container, run, at }) => {
      const type = typeAt(tree, container)
      const fresh: Id[] = []
      if (type instanceof Y.Text || type instanceof Y.Array) {
        for (let k = 0; k < contentLength(run.content); k++) {
          const id = idAt(type, at + k)
          if (id !== null) fresh.push(id)
        }
      }
      const itemSchema =
        type instanceof Y.Array
          ? itemOf(pathSchema(tree.schema, container, tree.binding))
          : undefined
      const nested =
        itemSchema === undefined
          ? []
          : run.nested.map(n => ({
              nested: n,
              ids:
                nestedTexts(tree, container.item(at + n.item), itemSchema).find(
                  t => JSON.stringify(t.path) === JSON.stringify(n.path),
                )?.ids ?? [],
            }))
      return { run, fresh, nested }
    })
  }

  function readSlot(path: Path): Slot {
    const segments = path.segments
    const last = segments.at(-1)
    if (last === undefined) return { value: path.read(host.shadow) }
    const parent = path.slice(0, segments.length - 1).read(host.shadow)
    const key = last.resolve()
    if (parent === null || typeof parent !== "object") return null
    return Object.hasOwn(parent as object, key as string)
      ? { value: (parent as Record<string, unknown>)[key as string] }
      : null
  }

  return revertible
}

/** Stands in for an absent value in comparisons. */
const ABSENT = { absent: true } as const

function charMarks(spans: readonly RichTextSpan[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const span of spans) {
    for (let k = 0; k < span.text.length; k++)
      out.push({ ...(span.marks ?? {}) })
  }
  return out
}

function encodePosition(position: Id): Uint8Array {
  return new TextEncoder().encode(idKey(position))
}

function decodePosition(bytes: Uint8Array): Id {
  const [client, clock] = new TextDecoder().decode(bytes).split(":").map(Number)
  return { client, clock }
}
