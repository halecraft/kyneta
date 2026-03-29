// change-mapping — bidirectional mapping between kyneta Changes and Loro Diffs.
//
// changeToDiff: kyneta Change → Loro [ContainerID, Diff | JsonDiff][]
// batchToOps:   Loro LoroEventBatch → kyneta Op[]
//
// These are conceptual inverses at the kyneta↔Loro boundary.
// changeToDiff is used by the substrate's `prepare` to accumulate diffs
// for `applyDiff`. batchToOps is used by the `doc.subscribe()` event
// bridge to translate Loro events into kyneta Ops for the changefeed.
//
// Structured inserts use Loro's JsonContainerID format (🦜:cid:...)
// to reference new containers within an applyDiff batch. See the
// "Structured inserts via JsonContainerID" section in the plan.

import { advanceSchema, expandMapOpsToLeaves } from "@kyneta/schema"
import { PROPS_KEY } from "./loro-resolve.js"
import type {
  ChangeBase,
  IncrementChange,
  MapChange,
  Op,
  Path,
  PathSegment,
  ReplaceChange,
  SequenceChange,
  SequenceInstruction,
  TextChange,
  TextInstruction,
} from "@kyneta/schema"
import type { Schema as SchemaNode } from "@kyneta/schema"
import type {
  ContainerID,
  CounterDiff,
  Delta,
  Diff,
  JsonContainerID,
  JsonDiff,
  ListDiff,
  ListJsonDiff,
  LoroDoc,
  LoroEvent,
  LoroEventBatch,
  MapDiff,
  MapJsonDiff,
  TextDiff,
  TreeDiff,
  Value,
} from "loro-crdt"
import { resolveContainer } from "./loro-resolve.js"

// ---------------------------------------------------------------------------
// Synthetic ContainerID generation (batch-local)
// ---------------------------------------------------------------------------

let syntheticCounter = 0

/**
 * Generate a synthetic ContainerID for use within an applyDiff batch.
 * These are batch-local — Loro remaps them to real peer-scoped IDs.
 *
 * The counter is module-scoped for uniqueness across calls within the
 * same JS tick, but since applyDiff remaps all synthetic IDs anyway,
 * collisions between batches are harmless.
 */
function syntheticCID(
  containerType: "Map" | "List" | "Text" | "Counter" | "MovableList" | "Tree",
): ContainerID {
  return `cid:${syntheticCounter++}@0:${containerType}` as ContainerID
}

function jsonCID(cid: ContainerID): JsonContainerID {
  return `🦜:${cid}` as JsonContainerID
}

// ---------------------------------------------------------------------------
// hasKind helper
// ---------------------------------------------------------------------------

function hasKind(value: unknown): value is { kind(): string; id: ContainerID } {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    "kind" in value &&
    typeof (value as any).kind === "function"
  )
}

// ---------------------------------------------------------------------------
// changeToDiff — kyneta Change → Loro [ContainerID, Diff | JsonDiff][]
// ---------------------------------------------------------------------------

/**
 * Convert a kyneta Change at a given path into Loro Diff tuples suitable
 * for `doc.applyDiff()`.
 *
 * Returns an array of `[ContainerID, Diff | JsonDiff]` tuples. Simple
 * changes (text edit, counter increment) produce one tuple. Structured
 * inserts (e.g. inserting a struct into a list) produce multiple tuples:
 * one for the list insert (with JsonContainerID references) and one for
 * each new container's fields.
 *
 * The path is resolved against the live LoroDoc to obtain the target
 * container's ContainerID.
 *
 * @param path - The kyneta path to the target
 * @param change - The kyneta Change to convert
 * @param schema - The root document schema
 * @param doc - The live LoroDoc (for container ID resolution)
 */
export function changeToDiff(
  path: Path,
  change: ChangeBase,
  schema: SchemaNode,
  doc: LoroDoc,
): [ContainerID, Diff | JsonDiff][] {
  // ReplaceChange handles its own parent resolution (it targets the
  // parent container, not the scalar value itself). Dispatch early
  // before attempting target CID resolution.
  if (change.type === "replace") {
    return replaceChangeToDiff(
      path,
      change as ReplaceChange,
      schema,
      doc,
    )
  }

  // Resolve the target container
  const resolved = resolveContainer(doc, schema, path)

  // Get the ContainerID
  let targetCID: ContainerID
  if (hasKind(resolved)) {
    targetCID = resolved.id
  } else {
    // The path resolved to a scalar value inside a container.
    // The target for the diff is the parent container.
    if (path.length === 0) {
      throw new Error(
        "changeToDiff: cannot create diff for root-level scalar",
      )
    }
    const parentPath = path.slice(0, -1)
    const parentResolved = resolveContainer(doc, schema, parentPath)
    if (!hasKind(parentResolved)) {
      // Parent is the LoroDoc (root level) — use the _props map
      const propsMap = (parentResolved as any).getMap(PROPS_KEY)
      targetCID = propsMap.id as ContainerID
    } else {
      targetCID = parentResolved.id
    }
  }

  // Resolve the schema at the target path for structured insert handling
  let targetSchema = schema
  for (const seg of path) {
    targetSchema = advanceSchema(targetSchema, seg)
  }

  switch (change.type) {
    case "text":
      return [
        [targetCID, textChangeToDiff(change as TextChange)],
      ]

    case "sequence":
      return sequenceChangeToDiff(
        targetCID,
        change as SequenceChange,
        targetSchema,
      )

    case "map":
      return mapChangeToDiff(
        targetCID,
        change as MapChange,
        targetSchema,
      )

    case "increment":
      return [
        [targetCID, counterChangeToDiff(change as IncrementChange)],
      ]

    default:
      throw new Error(`changeToDiff: unsupported change type "${change.type}"`)
  }
}

// ---------------------------------------------------------------------------
// Per-type converters: kyneta Change → Loro Diff
// ---------------------------------------------------------------------------

/**
 * TextChange → TextDiff
 * The delta shapes are structurally identical.
 */
function textChangeToDiff(change: TextChange): TextDiff {
  const diff: Delta<string>[] = change.instructions.map(
    (inst: TextInstruction) => {
      if ("retain" in inst) {
        return { retain: inst.retain } as Delta<string>
      }
      if ("insert" in inst) {
        return { insert: inst.insert } as Delta<string>
      }
      if ("delete" in inst) {
        return { delete: inst.delete } as Delta<string>
      }
      throw new Error("textChangeToDiff: unknown instruction type")
    },
  )
  return { type: "text", diff }
}

/**
 * SequenceChange → ListDiff (possibly with JsonContainerID references)
 *
 * For inserts containing plain values: emits them directly.
 * For inserts containing structured objects: emits JsonContainerID
 * references and additional [syntheticCID, MapDiff] tuples.
 */
function sequenceChangeToDiff(
  targetCID: ContainerID,
  change: SequenceChange,
  targetSchema: SchemaNode,
): [ContainerID, Diff | JsonDiff][] {
  const result: [ContainerID, Diff | JsonDiff][] = []
  const listDeltas: Delta<(Value | JsonContainerID)[]>[] = []

  // Determine the item schema (unwrap annotations to find the sequence)
  let seqSchema = targetSchema
  while (seqSchema._kind === "annotated" && seqSchema.schema !== undefined) {
    seqSchema = seqSchema.schema
  }
  const itemSchema =
    seqSchema._kind === "sequence" ? seqSchema.item : undefined

  for (const inst of change.instructions as readonly SequenceInstruction[]) {
    if ("retain" in inst) {
      listDeltas.push({
        retain: inst.retain,
      } as Delta<(Value | JsonContainerID)[]>)
    } else if ("delete" in inst) {
      listDeltas.push({
        delete: inst.delete,
      } as Delta<(Value | JsonContainerID)[]>)
    } else if ("insert" in inst) {
      const items: (Value | JsonContainerID)[] = []

      for (const item of inst.insert as readonly unknown[]) {
        if (itemSchema && needsContainer(item, itemSchema)) {
          // Structured insert: create synthetic container diffs
          const cid = syntheticCID("Map")
          items.push(jsonCID(cid))
          materializeValueDiffs(item, itemSchema, cid, result)
        } else {
          // Plain value insert
          items.push(item as Value)
        }
      }

      listDeltas.push({
        insert: items,
      } as Delta<(Value | JsonContainerID)[]>)
    }
  }

  // The list diff itself goes first
  result.unshift([
    targetCID,
    { type: "list", diff: listDeltas } as ListJsonDiff,
  ])
  return result
}

/**
 * MapChange → MapDiff (possibly with JsonContainerID references)
 */
function mapChangeToDiff(
  targetCID: ContainerID,
  change: MapChange,
  targetSchema: SchemaNode,
): [ContainerID, Diff | JsonDiff][] {
  const result: [ContainerID, Diff | JsonDiff][] = []
  const updated: Record<string, Value | JsonContainerID | undefined> = {}

  // Determine the item schema for dynamic maps
  let mapSchema = targetSchema
  while (mapSchema._kind === "annotated" && mapSchema.schema !== undefined) {
    mapSchema = mapSchema.schema
  }
  const valueSchema = mapSchema._kind === "map" ? mapSchema.item : undefined

  // Set entries
  if (change.set) {
    for (const [key, value] of Object.entries(change.set)) {
      // Try to find the field schema for product-typed maps (structs)
      let fieldSchema = valueSchema
      if (
        !fieldSchema &&
        mapSchema._kind === "product" &&
        mapSchema.fields[key]
      ) {
        fieldSchema = mapSchema.fields[key]
      }

      if (fieldSchema && needsContainer(value, fieldSchema)) {
        const cid = syntheticCID("Map")
        updated[key] = jsonCID(cid)
        materializeValueDiffs(value, fieldSchema, cid, result)
      } else {
        updated[key] = value as Value
      }
    }
  }

  // Delete entries
  if (change.delete) {
    for (const key of change.delete) {
      updated[key] = undefined
    }
  }

  result.unshift([
    targetCID,
    { type: "map", updated } as MapJsonDiff,
  ])
  return result
}

/**
 * ReplaceChange → MapDiff on the parent container
 *
 * A scalar replacement is modeled as a map update on the parent
 * product/map at the last path segment's key.
 */
function replaceChangeToDiff(
  path: Path,
  change: ReplaceChange,
  schema: SchemaNode,
  doc: LoroDoc,
): [ContainerID, Diff | JsonDiff][] {
  if (path.length === 0) {
    throw new Error("replaceChangeToDiff: cannot replace at root")
  }

  const lastSeg = path[path.length - 1]!
  const parentPath = path.slice(0, -1)
  const parentResolved = resolveContainer(doc, schema, parentPath)

  // If the parent is the LoroDoc itself (root-level field), the target
  // depends on the field type. For scalars/sums, they're stored in the
  // shared _props LoroMap. For containers, use the container's own ID.
  if (!hasKind(parentResolved)) {
    // Parent is the LoroDoc — this is a root-level replace.
    // Scalars at root are stored in _props.
    if (lastSeg.type === "key") {
      const propsMap = (parentResolved as any).getMap(PROPS_KEY)
      const propsCID = propsMap.id as ContainerID
      const updated: Record<string, Value | undefined> = {
        [lastSeg.key]: change.value as Value,
      }
      return [[propsCID, { type: "map", updated } as MapDiff]]
    }
    throw new Error(
      "replaceChangeToDiff: root-level replace requires a key segment",
    )
  }

  const parentCID = parentResolved.id

  if (lastSeg.type === "key") {
    const updated: Record<string, Value | undefined> = {
      [lastSeg.key]: change.value as Value,
    }
    return [[parentCID, { type: "map", updated } as MapDiff]]
  }

  // Index-based replace in a list — modeled as delete + insert at position
  if (lastSeg.type === "index") {
    const diff: Delta<(Value)[]>[] = []
    if (lastSeg.index > 0) {
      diff.push({ retain: lastSeg.index } as Delta<Value[]>)
    }
    diff.push({ delete: 1 } as Delta<Value[]>)
    diff.push({ insert: [change.value as Value] } as Delta<Value[]>)
    return [[parentCID, { type: "list", diff } as ListDiff]]
  }

  // TypeScript has exhaustively narrowed segment types above
  throw new Error("replaceChangeToDiff: unexpected segment type")
}

/**
 * IncrementChange → CounterDiff
 */
function counterChangeToDiff(change: IncrementChange): CounterDiff {
  return { type: "counter", increment: change.amount }
}

// ---------------------------------------------------------------------------
// Structured value materialization (for container inserts)
// ---------------------------------------------------------------------------

/**
 * Determine whether a value needs to be materialized as a Loro container
 * (vs. inserted as a plain value).
 *
 * A value needs a container if the schema indicates it should be a
 * product (struct), sequence (list), or map — i.e., a composite type
 * that Loro represents as a container.
 */
function needsContainer(value: unknown, schema: SchemaNode): boolean {
  if (value === null || value === undefined) return false
  if (typeof value !== "object") return false

  // Unwrap annotations
  let s = schema
  while (s._kind === "annotated" && s.schema !== undefined) {
    s = s.schema
  }

  return s._kind === "product" || s._kind === "map"
}

/**
 * Recursively produce [ContainerID, Diff] tuples for a plain JS value
 * that should be materialized as Loro containers.
 *
 * The `parentCID` is the synthetic CID that was referenced via 🦜: in
 * the parent's insert. This function emits a MapDiff for `parentCID`
 * with the value's fields, and recurses for any nested containers.
 */
function materializeValueDiffs(
  value: unknown,
  schema: SchemaNode,
  parentCID: ContainerID,
  result: [ContainerID, Diff | JsonDiff][],
): void {
  // Unwrap annotations
  let s = schema
  while (s._kind === "annotated" && s.schema !== undefined) {
    s = s.schema
  }

  if (s._kind === "product" && typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>
    const updated: Record<string, Value | JsonContainerID | undefined> = {}

    for (const [key, fieldValue] of Object.entries(obj)) {
      const fieldSchema = s.fields[key]
      if (fieldSchema && needsContainer(fieldValue, fieldSchema)) {
        const childCID = syntheticCID("Map")
        updated[key] = jsonCID(childCID)
        materializeValueDiffs(fieldValue, fieldSchema, childCID, result)
      } else {
        updated[key] = fieldValue as Value
      }
    }

    result.push([parentCID, { type: "map", updated } as MapJsonDiff])
  } else if (s._kind === "map" && typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>
    const updated: Record<string, Value | JsonContainerID | undefined> = {}

    for (const [key, entryValue] of Object.entries(obj)) {
      if (needsContainer(entryValue, s.item)) {
        const childCID = syntheticCID("Map")
        updated[key] = jsonCID(childCID)
        materializeValueDiffs(entryValue, s.item, childCID, result)
      } else {
        updated[key] = entryValue as Value
      }
    }

    result.push([parentCID, { type: "map", updated } as MapJsonDiff])
  }
}

// ---------------------------------------------------------------------------
// batchToOps — Loro LoroEventBatch → kyneta Op[]
// ---------------------------------------------------------------------------

/**
 * Convert a Loro event batch into kyneta Ops for changefeed delivery.
 *
 * This is the conceptual inverse of `changeToDiff`. Each LoroEvent in
 * the batch has a `target` (ContainerID), `diff` (Diff), and `path`
 * (Loro's absolute path). We convert the Loro path to a kyneta Path
 * and the Loro Diff to a kyneta Change.
 *
 * @param batch - The Loro event batch from doc.subscribe()
 * @param _schema - The root document schema (for future use in disambiguation)
 */
export function batchToOps(
  batch: LoroEventBatch,
  _schema: SchemaNode,
): Op[] {
  const ops: Op[] = []

  for (const event of batch.events) {
    const kynetaPath = loroPathToKynetaPath(event.path)
    const change = diffToChange(event.diff)
    if (change) {
      ops.push({ path: kynetaPath, change })
    }
  }

  return expandMapOpsToLeaves(ops)
}

// ---------------------------------------------------------------------------
// Loro path → kyneta Path conversion
// ---------------------------------------------------------------------------

/**
 * Convert a Loro event path (array of string | number | TreeID) to a
 * kyneta Path (array of {type: "key", key} | {type: "index", index}).
 */
function loroPathToKynetaPath(
  loroPath: (string | number | unknown)[],
): Path {
  const result: PathSegment[] = []
  for (const segment of loroPath) {
    if (typeof segment === "string") {
      result.push({ type: "key", key: segment })
    } else if (typeof segment === "number") {
      result.push({ type: "index", index: segment })
    }
    // TreeID segments are skipped — tree path handling is future work
  }
  return result
}

// ---------------------------------------------------------------------------
// Per-type converters: Loro Diff → kyneta Change
// ---------------------------------------------------------------------------

/**
 * Convert a Loro Diff to a kyneta Change.
 * Returns null for diff types we can't map (shouldn't happen for
 * supported container types).
 */
function diffToChange(diff: Diff): ChangeBase | null {
  switch (diff.type) {
    case "text":
      return textDiffToChange(diff as TextDiff)
    case "list":
      return listDiffToChange(diff as ListDiff)
    case "map":
      return mapDiffToChange(diff as MapDiff)
    case "counter":
      return counterDiffToChange(diff as CounterDiff)
    case "tree":
      return treeDiffToChange(diff as TreeDiff)
    default:
      return null
  }
}

/**
 * TextDiff → TextChange
 */
function textDiffToChange(diff: TextDiff): TextChange {
  const instructions: TextInstruction[] = diff.diff.map(
    (delta: Delta<string>) => {
      if (delta.insert !== undefined) {
        return { insert: delta.insert }
      }
      if (delta.delete !== undefined) {
        return { delete: delta.delete }
      }
      if (delta.retain !== undefined) {
        return { retain: delta.retain }
      }
      throw new Error("textDiffToChange: unknown delta type")
    },
  )
  return { type: "text", instructions }
}

/**
 * ListDiff → SequenceChange
 *
 * Container values in inserts are converted to their plain JSON
 * representation — the kyneta Change protocol uses plain values,
 * not container references.
 */
function listDiffToChange(diff: ListDiff): SequenceChange {
  const instructions: SequenceInstruction[] = diff.diff.map(
    (delta: Delta<(Value | any)[]>) => {
      if (delta.insert !== undefined) {
        // Convert container objects to plain values
        const items = (delta.insert as unknown[]).map((item) => {
          if (hasKind(item)) {
            return (item as any).toJSON()
          }
          return item
        })
        return { insert: items }
      }
      if (delta.delete !== undefined) {
        return { delete: delta.delete }
      }
      if (delta.retain !== undefined) {
        return { retain: delta.retain }
      }
      throw new Error("listDiffToChange: unknown delta type")
    },
  )
  return { type: "sequence", instructions }
}

/**
 * MapDiff → MapChange
 *
 * Updated entries with `undefined` values become deletes.
 * Container values are converted to their plain JSON representation.
 */
function mapDiffToChange(diff: MapDiff): MapChange {
  const set: Record<string, unknown> = {}
  const deleteKeys: string[] = []

  for (const [key, value] of Object.entries(diff.updated)) {
    if (value === undefined) {
      deleteKeys.push(key)
    } else if (hasKind(value)) {
      // Container value — convert to plain JSON
      set[key] = (value as any).toJSON()
    } else {
      set[key] = value
    }
  }

  const result: MapChange = { type: "map" }
  if (Object.keys(set).length > 0) {
    ;(result as any).set = set
  }
  if (deleteKeys.length > 0) {
    ;(result as any).delete = deleteKeys
  }
  return result
}

/**
 * CounterDiff → IncrementChange
 */
function counterDiffToChange(diff: CounterDiff): IncrementChange {
  return { type: "increment", amount: diff.increment }
}

/**
 * TreeDiff → TreeChange (stub — tree support is future work)
 */
function treeDiffToChange(diff: TreeDiff): ChangeBase & { instructions: unknown[] } {
  // Map TreeDiffItems to kyneta TreeInstructions
  // This is a simplified mapping — full tree support is future work
  const instructions = diff.diff.map((item) => {
    switch (item.action) {
      case "create":
        return {
          type: "create" as const,
          target: item.target,
          parent: item.parent,
          index: item.index,
        }
      case "delete":
        return {
          type: "delete" as const,
          target: item.target,
        }
      case "move":
        return {
          type: "move" as const,
          target: item.target,
          parent: item.parent,
          index: item.index,
        }
    }
  })
  return { type: "tree", instructions }
}