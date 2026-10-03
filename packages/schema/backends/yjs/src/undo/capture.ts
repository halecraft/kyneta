// capture — what one local transaction did, gathered as it happens and
// built into a record: the values and marks an op wrote, the list runs it
// deleted, a text's deletions and insertions. Each is kept as it was made;
// merging and the rest of the normal form are `./normal.js`'s.

import {
  type ChangeBase,
  isMapChange,
  isReplaceChange,
  isRichTextChange,
  isSequenceChange,
  KIND,
  mapChangeEffects,
  own,
  type Path,
  pathSchema,
  type RichTextSpan,
  type Schema as SchemaNode,
} from "@kyneta/schema"
import * as Y from "yjs"
import { idAt, type Tree, textIds, textRuns, typeAt } from "./document.js"
import {
  type DeletedRun,
  type Id,
  type IdRun,
  type InsertedRun,
  type MarkWrite,
  type NestedIds,
  type Slot,
  type StablePath,
  type StableSegment,
  toRuns,
  type ValueWrite,
} from "./record.js"

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

/** What one transaction did, gathered as it happens. */
export interface Draft {
  inserted: InsertedRun[]
  deleted: DeletedRun[]
  values: ValueWrite[]
  marks: MarkWrite[]
  /** `.json()` values the batch wrote into, with what they held before. */
  boundaries: Map<string, { path: StablePath; at: Path; previous: Slot }>
  /** A rich text's spans before the transaction first touched it. */
  texts: Map<string, readonly RichTextSpan[]>
  aborted: boolean
}

export const newDraft = (): Draft => ({
  inserted: [],
  deleted: [],
  values: [],
  marks: [],
  boundaries: new Map(),
  texts: new Map(),
  aborted: false,
})

/** The item schema of a list, or undefined for anything else. */
export function itemOf(schema: SchemaNode): SchemaNode | undefined {
  return "item" in schema ? (schema.item as SchemaNode) : undefined
}

export function kindAt(tree: Tree, path: Path): string {
  return pathSchema(tree.schema, path, tree.binding)[KIND]
}

/**
 * The value writes `change` makes at `path`, read against `pre`, the value
 * there before it.
 */
export function valueWrites(
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
    const { set, remove } = mapChangeEffects(change, () => Object.keys(held))
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
export type Stage = "before" | "after"

/**
 * The mark writes of a rich-text change read at `stage`, against the spans
 * that were there before it. `idOf` names the character at an index.
 */
export function markWrites(
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
 * ids come in document order from the list, with the ids of every text and
 * list inside its items; after, the items are gone and their order is not
 * public, so the content restores and the ids do not follow.
 */
export function deletedItems(
  tree: Tree,
  container: StablePath,
  path: Path,
  change: ChangeBase,
  pre: readonly unknown[],
  list: Y.Array<unknown>,
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
      if (stage === "before") {
        for (let i = 0; i < op.delete; i++) {
          const id = idAt(list, source + i)
          if (id !== null) ids.push(id)
          if (itemSchema === undefined) continue
          for (const inner of nestedIds(
            tree,
            path.item(source + i),
            itemSchema,
          )) {
            nested.push({ item: i, ...inner })
          }
        }
      }
      // The list as read: before the change, or after it.
      const at = stage === "before" ? source : target
      out.push({
        container,
        ids: toRuns(ids),
        after: at === 0 ? null : idAt(list, at - 1),
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

/**
 * The texts and lists inside the list item at `item`, at any depth, each
 * with its ids in document order: a text's characters, a list's items.
 */
export function nestedIds(
  tree: Tree,
  item: Path,
  schema: SchemaNode,
): Omit<NestedIds, "item">[] {
  const out: Omit<NestedIds, "item">[] = []
  const walk = (node: SchemaNode, at: Path, path: StableSegment[]) => {
    const kind = node[KIND]
    const type = typeAt(tree, at)
    if (kind === "text" || kind === "richtext") {
      if (type instanceof Y.Text) {
        out.push({ path, kind, ids: textIds(tree.doc, type) })
      }
    } else if (kind === "sequence") {
      if (!(type instanceof Y.Array)) return
      const ids: Id[] = []
      for (let i = 0; i < type.length; i++) {
        const id = idAt(type, i)
        if (id !== null) ids.push(id)
      }
      out.push({ path, kind, ids: toRuns(ids) })
      const inner = itemOf(node)
      if (inner === undefined) return
      ids.forEach((id, i) => {
        walk(inner, at.item(i), [...path, { item: id }])
      })
    } else if (kind === "product") {
      // A `.json()` struct is one value, not a map of types.
      if (!(type instanceof Y.Map)) return
      const fields = (node as unknown as { fields: Record<string, SchemaNode> })
        .fields
      for (const [name, field] of Object.entries(fields)) {
        walk(field, at.field(name), [...path, { field: name }])
      }
    } else if (kind === "map") {
      if (!(type instanceof Y.Map)) return
      const inner = itemOf(node)
      if (inner === undefined) return
      for (const key of [...type.keys()].sort()) {
        walk(inner, at.entry(key), [...path, { entry: key }])
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
export function textChanges(
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
    | { ids: Id[]; text: string; spans: RichTextSpan[]; after: Id | null }
    | undefined
  const close = () => {
    if (open === undefined) return
    deleted.push({
      container,
      ids: toRuns(open.ids),
      after: open.after,
      content:
        marks === null
          ? { kind: "text", text: open.text }
          : { kind: "richtext", spans: open.spans },
      nested: [],
    })
    open = undefined
  }
  // Where the walk is in the text as it was before the transaction, and in
  // the text as it is now.
  let index = 0
  let now = 0
  for (const run of textRuns(text, Y.snapshot(doc), previous)) {
    const { id } = run
    if (run.type === "same" || id === null) {
      close()
      index += run.insert.length
      now += run.insert.length
      continue
    }
    const ids = Array.from({ length: run.insert.length }, (_, k) => ({
      client: id.client,
      clock: id.clock + k,
    }))
    if (run.type === "added") {
      close()
      inserted.push(...ids)
      now += run.insert.length
      continue
    }
    // Removed: by this transaction, or earlier (then not part of `before`).
    if (!Y.isDeleted(transaction.deleteSet, Y.createID(id.client, id.clock))) {
      close()
      continue
    }
    open ??= {
      ids: [],
      text: "",
      spans: [],
      after: now === 0 ? null : idAt(text, now - 1),
    }
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

export function charMarks(
  spans: readonly RichTextSpan[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const span of spans) {
    for (let k = 0; k < span.text.length; k++)
      out.push({ ...(span.marks ?? {}) })
  }
  return out
}
