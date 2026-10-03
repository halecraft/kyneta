// document — what undo reads of a Y.Doc: ids at indices, where an id sits
// now, a text's ids in document order, and where a path is now.
//
// Only Yjs's public API is used, and `yjs-surface.test.ts` pins each call:
// relative positions (from an index, from JSON, to JSON, resolved back),
// `isDeleted` over `snapshot`, `getState`, and `YText.toDelta` over two
// snapshots with `computeYChange`, which is how the ids of text in document
// order are read. Capture adds the transaction's `local`, `beforeState`,
// `afterState` and `deleteSet`, and `YEvent.changes`.

import {
  type Path,
  RawPath,
  type SchemaBinding,
  type Schema as SchemaNode,
} from "@kyneta/schema"
import * as Y from "yjs"
import { resolveYjsType } from "../yjs-resolve.js"
import {
  type Id,
  type IdRun,
  type StablePath,
  type StableSegment,
  toRuns,
} from "./record.js"

// ---------------------------------------------------------------------------
// Reading ids from a Y.Doc
// ---------------------------------------------------------------------------

/** The id of the item at `index` of `type`, or null past its end. */
export function idAt(type: Y.AbstractType<any>, index: number): Id | null {
  const json = Y.relativePositionToJSON(
    Y.createRelativePositionFromTypeIndex(type, index, 0),
  ) as { item?: Id | null }
  return json.item ?? null
}

/** Where item `id` sits now: its type and index, or null if it is gone. */
export function locate(
  doc: Y.Doc,
  id: Id,
): { type: Y.AbstractType<any>; index: number } | null {
  const abs = Y.createAbsolutePositionFromRelativePosition(
    Y.createRelativePositionFromJSON({ item: id, assoc: 0 }),
    doc,
  )
  return abs === null ? null : { type: abs.type, index: abs.index }
}

/** The index just after item `after` (deleted or not), or 0 for null: where
 *  a deleted run re-inserts. Null when the item is gone. */
export function gapAfter(doc: Y.Doc, after: Id | null): number | null {
  if (after === null) return 0
  const abs = Y.createAbsolutePositionFromRelativePosition(
    Y.createRelativePositionFromJSON({ item: after, assoc: -1 }),
    doc,
  )
  return abs === null ? null : abs.index
}

/**
 * Walk a text's items in document order, through two snapshots:
 * `computeYChange` names each item that differs between them, and a run with
 * no change is `"same"`.
 */
export function textRuns(
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
export function textIds(doc: Y.Doc, text: Y.Text): IdRun[] {
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

/**
 * The clock `client`'s next item will take in `doc`, which is how many items
 * `client` has made (`Y.getState`). Next, not last: the runs of ids built
 * from it, a text insert's from the clocks around it and a crashed revert's
 * from its noted position, start at the clock itself.
 */
export function clockOf(doc: Y.Doc, client: number): number {
  return Y.getState(doc.store, client)
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** Yjs exports the constructor of its delete set, not the type. */
export type DeleteSet = ReturnType<typeof Y.createDeleteSet>

export interface Tree {
  readonly doc: Y.Doc
  readonly rootMap: Y.Map<any>
  readonly schema: SchemaNode
  readonly binding: SchemaBinding | undefined
}

export function typeAt(tree: Tree, path: Path): unknown {
  return resolveYjsType(tree.rootMap, tree.schema, path, tree.binding).resolved
}

/** `path` as it stands now, with each list index replaced by its item's id. */
export function stabilize(tree: Tree, path: Path): StablePath | null {
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
export function destabilize(
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
