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

import type {
  ChangeBase,
  IncrementChange,
  MapChange,
  Op,
  Path,
  ReplaceChange,
  RichTextChange,
  RichTextInstruction,
  SchemaBinding,
  Schema as SchemaNode,
  SequenceChange,
  SequenceInstruction,
  TextChange,
  TextInstruction,
} from "@kyneta/schema"
import {
  advanceSchema,
  expandMapOpsToLeaves,
  KIND,
  RawPath,
  richTextChange,
  structuralKind,
} from "@kyneta/schema"
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
  LoroEventBatch,
  MapDiff,
  MapJsonDiff,
  TextDiff,
  TreeDiff,
  Value,
} from "loro-crdt"
import { hasKind, isLoroContainer } from "./loro-guards.js"
import { PROPS_KEY, resolveContainer } from "./loro-resolve.js"

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
  binding?: SchemaBinding,
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
      binding,
    )
  }

  // Resolve the target container
  const { container: resolved } = resolveContainer(doc, schema, path, binding)

  // Get the ContainerID
  let targetCID: ContainerID
  if (isLoroContainer(resolved)) {
    targetCID = resolved.id
  } else {
    // The path resolved to a scalar value inside a container.
    // The target for the diff is the parent container.
    if (path.segments.length === 0) {
      throw new Error("changeToDiff: cannot create diff for root-level scalar")
    }
    const parentPath = path.slice(0, -1)
    const { container: parentResolved } = resolveContainer(doc, schema, parentPath, binding)
    if (!isLoroContainer(parentResolved)) {
      // Parent is the LoroDoc (root level) — use the _props map
      const propsMap = (parentResolved as any).getMap(PROPS_KEY)
      targetCID = propsMap.id as ContainerID
    } else {
      targetCID = parentResolved.id
    }
  }

  // Resolve the schema at the target path for structured insert handling
  let targetSchema = schema
  for (const seg of path.segments) {
    targetSchema = advanceSchema(targetSchema, seg)
  }

  switch (change.type) {
    case "text":
      return [[targetCID, textChangeToDiff(change as TextChange)]]

    case "richtext":
      return [[targetCID, richTextChangeToDiff(change as RichTextChange)]]

    case "sequence":
      return sequenceChangeToDiff(
        targetCID,
        change as SequenceChange,
        targetSchema,
      )

    case "map":
      return mapChangeToDiff(targetCID, change as MapChange, targetSchema)

    case "increment":
      return [[targetCID, counterChangeToDiff(change as IncrementChange)]]

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
 * RichTextChange → TextDiff
 * Rich text instructions map to Loro text deltas with attributes for marks.
 */
function richTextChangeToDiff(change: RichTextChange): TextDiff {
  const diff: Delta<string>[] = change.instructions.map(
    (inst: RichTextInstruction) => {
      if ("retain" in inst) {
        return { retain: inst.retain } as Delta<string>
      }
      if ("format" in inst) {
        return { retain: inst.format, attributes: inst.marks } as Delta<string>
      }
      if ("insert" in inst) {
        const d: any = { insert: inst.insert }
        if (inst.marks && Object.keys(inst.marks).length > 0) {
          d.attributes = inst.marks
        }
        return d as Delta<string>
      }
      if ("delete" in inst) {
        return { delete: inst.delete } as Delta<string>
      }
      throw new Error("richTextChangeToDiff: unknown instruction type")
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

  // Determine the item schema — movable sequences also have .item
  const sk = structuralKind(targetSchema)
  const itemSchema =
    sk === "sequence" && "item" in targetSchema
      ? ((targetSchema as any).item as SchemaNode)
      : undefined

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
          const cid = materializeCIDForSchema(itemSchema)
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

  // Determine the item schema for dynamic maps (including set)
  const sk = structuralKind(targetSchema)
  const valueSchema =
    sk === "map" && "item" in targetSchema
      ? ((targetSchema as any).item as SchemaNode)
      : undefined

  // Set entries
  if (change.set) {
    for (const [key, value] of Object.entries(change.set)) {
      // Try to find the field schema for product-typed maps (structs)
      let fieldSchema = valueSchema
      if (
        !fieldSchema &&
        targetSchema[KIND] === "product" &&
        targetSchema.fields[key]
      ) {
        fieldSchema = targetSchema.fields[key]
      }

      if (fieldSchema && needsContainer(value, fieldSchema)) {
        const cid = materializeCIDForSchema(fieldSchema)
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

  result.unshift([targetCID, { type: "map", updated } as MapJsonDiff])
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
  binding?: SchemaBinding,
): [ContainerID, Diff | JsonDiff][] {
  if (path.segments.length === 0) {
    throw new Error("replaceChangeToDiff: cannot replace at root")
  }

  const lastSeg = path.segments[path.segments.length - 1]
  if (!lastSeg) throw new Error("replaceChangeToDiff: empty path")
  const parentPath = path.slice(0, -1)
  const { container: parentResolved } = resolveContainer(doc, schema, parentPath, binding)

  // If the parent is the LoroDoc itself (root-level field), the target
  // depends on the field type. For scalars/sums, they're stored in the
  // shared _props LoroMap. For containers, use the container's own ID.
  if (!isLoroContainer(parentResolved)) {
    // Parent is the LoroDoc — this is a root-level replace.
    // Scalars at root are stored in _props.
    if (lastSeg.role === "key") {
      const fieldName = lastSeg.resolve() as string
      const identity = binding?.forward.get(fieldName) as string | undefined
      const key = identity ?? fieldName
      const propsMap = (parentResolved as any).getMap(PROPS_KEY)
      const propsCID = propsMap.id as ContainerID
      const updated: Record<string, Value | undefined> = {
        [key]: change.value as Value,
      }
      return [[propsCID, { type: "map", updated } as MapDiff]]
    }
    throw new Error(
      "replaceChangeToDiff: root-level replace requires a key segment",
    )
  }

  const parentCID = parentResolved.id
  const resolved = lastSeg.resolve()

  if (lastSeg.role === "key") {
    // Compute the absolute schema path for nested identity lookup.
    // Collect all key segments to form the absolute path.
    const absPath = path.segments
      .filter(s => s.role === "key")
      .map(s => s.resolve() as string)
      .join(".")
    const identity = binding?.forward.get(absPath) as string | undefined
    const key = identity ?? (resolved as string)
    const updated: Record<string, Value | undefined> = {
      [key]: change.value as Value,
    }
    return [[parentCID, { type: "map", updated } as MapDiff]]
  }

  // Index-based replace in a list — modeled as delete + insert at position
  if (lastSeg.role === "index") {
    const idx = resolved as number
    const diff: Delta<Value[]>[] = []
    if (idx > 0) {
      diff.push({ retain: idx } as Delta<Value[]>)
    }
    diff.push({ delete: 1 } as Delta<Value[]>)
    diff.push({ insert: [change.value as Value] } as Delta<Value[]>)
    return [[parentCID, { type: "list", diff } as ListDiff]]
  }

  // TypeScript has exhaustively narrowed segment roles above
  throw new Error("replaceChangeToDiff: unexpected segment role")
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
 * Map a schema's `[KIND]` to the Loro container type string used in
 * synthetic CID generation, or `undefined` if the kind does not
 * correspond to a Loro container.
 */
function kindToContainerType(
  schema: SchemaNode,
): "Counter" | "Text" | "List" | "MovableList" | "Tree" | "Map" | undefined {
  switch (schema[KIND]) {
    case "counter":
      return "Counter"
    case "text":
      return "Text"
    case "movable":
      return "MovableList"
    case "tree":
      return "Tree"
    case "set":
    case "product":
    case "map":
      return "Map"
    case "sequence":
      return "List"
    default:
      return undefined
  }
}

/**
 * Determine whether a value needs to be materialized as a Loro container
 * (vs. inserted as a plain value).
 *
 * A value needs a container if the schema indicates it should be:
 * - A composite type (product/struct, sequence/list, map/record)
 * - A first-class CRDT type (text, counter, movable, tree, set)
 *
 * For first-class types the value itself may be a primitive (number
 * for counter, string for text) but Loro still needs a container.
 */
function needsContainer(_value: unknown, schema: SchemaNode): boolean {
  const kind = schema[KIND]
  switch (kind) {
    // First-class CRDT types — always need a Loro container
    case "text":
    case "counter":
    case "movable":
    case "tree":
    case "set":
    // Structural composites — need a Loro container
    case "product":
    case "map":
    case "sequence":
      return true
    default:
      return false
  }
}

/**
 * Recursively produce [ContainerID, Diff] tuples for a plain JS value
 * that should be materialized as Loro containers.
 *
 * The `parentCID` is the synthetic CID that was referenced via 🦜: in
 * the parent's insert. This function emits a MapDiff for `parentCID`
 * with the value's fields, and recurses for any nested containers.
 *
 * For product (struct) schemas, also creates containers for first-class
 * fields (counter, text, etc.) that are declared in the schema but may
 * be missing from the value object. This ensures Loro containers exist
 * for later mutation (e.g. `.increment()` on a counter inside a struct
 * inside a record).
 */
function materializeValueDiffs(
  value: unknown,
  schema: SchemaNode,
  parentCID: ContainerID,
  result: [ContainerID, Diff | JsonDiff][],
): void {
  const kind = schema[KIND]

  // First-class leaf CRDT types — emit an init diff directly
  switch (kind) {
    case "counter": {
      const amount = typeof value === "number" ? value : 0
      if (amount !== 0) {
        result.push([
          parentCID,
          { type: "counter", increment: amount } as CounterDiff,
        ])
      }
      return
    }
    case "text": {
      const content = typeof value === "string" ? value : ""
      if (content !== "") {
        result.push([
          parentCID,
          {
            type: "text",
            diff: [{ insert: content }],
          } as TextDiff,
        ])
      }
      return
    }
    case "movable":
    case "tree":
      // movableList, tree — future work; fall through to structural handling
      break
  }

  if (kind === "product" && typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>
    const updated: Record<string, Value | JsonContainerID | undefined> = {}

    // Deferred init diffs for first-class containers (counter, text).
    // These must come AFTER the parent MapDiff that creates them via
    // 🦜: JsonContainerID references. Loro resolves 🦜: refs when it
    // processes a MapDiff, so the container must be created (by the
    // MapDiff) before the init diff (CounterDiff, TextDiff) can target it.
    const deferred: [ContainerID, Diff | JsonDiff][] = []

    // Process fields present in the value object
    for (const [key, fieldValue] of Object.entries(obj)) {
      const fieldSchema = schema.fields[key]
      if (fieldSchema && needsContainer(fieldValue, fieldSchema)) {
        const childCID = materializeCIDForSchema(fieldSchema)
        updated[key] = jsonCID(childCID)
        materializeValueDiffs(fieldValue, fieldSchema, childCID, deferred)
      } else {
        updated[key] = fieldValue as Value
      }
    }

    // Create containers for first-class fields declared in the schema
    // but missing from the value object. This ensures Loro containers
    // exist for later mutation (e.g. counter.increment()).
    for (const [key, fieldSchema] of Object.entries(schema.fields)) {
      if (key in obj) continue // already processed above
      if (fieldSchema && needsContainer(undefined, fieldSchema as SchemaNode)) {
        const childCID = materializeCIDForSchema(fieldSchema as SchemaNode)
        updated[key] = jsonCID(childCID)
        materializeValueDiffs(
          undefined,
          fieldSchema as SchemaNode,
          childCID,
          deferred,
        )
      }
    }

    // Parent MapDiff first (creates containers via 🦜: refs), then
    // deferred init diffs for the containers it created.
    result.push([parentCID, { type: "map", updated } as MapJsonDiff])
    result.push(...deferred)
  } else if (kind === "product" && (value === undefined || value === null)) {
    // Product with no value — still need to create containers for
    // first-class fields in the schema
    const updated: Record<string, Value | JsonContainerID | undefined> = {}
    const deferred: [ContainerID, Diff | JsonDiff][] = []

    for (const [key, fieldSchema] of Object.entries(schema.fields)) {
      if (fieldSchema && needsContainer(undefined, fieldSchema as SchemaNode)) {
        const childCID = materializeCIDForSchema(fieldSchema as SchemaNode)
        updated[key] = jsonCID(childCID)
        materializeValueDiffs(
          undefined,
          fieldSchema as SchemaNode,
          childCID,
          deferred,
        )
      }
    }

    if (Object.keys(updated).length > 0) {
      result.push([parentCID, { type: "map", updated } as MapJsonDiff])
      result.push(...deferred)
    }
  } else if (
    (kind === "map" || kind === "set") &&
    typeof value === "object" &&
    value !== null
  ) {
    const obj = value as Record<string, unknown>
    const updated: Record<string, Value | JsonContainerID | undefined> = {}
    const deferred: [ContainerID, Diff | JsonDiff][] = []

    for (const [key, entryValue] of Object.entries(obj)) {
      if (needsContainer(entryValue, (schema as any).item)) {
        const childCID = materializeCIDForSchema((schema as any).item)
        updated[key] = jsonCID(childCID)
        materializeValueDiffs(
          entryValue,
          (schema as any).item,
          childCID,
          deferred,
        )
      } else {
        updated[key] = entryValue as Value
      }
    }

    result.push([parentCID, { type: "map", updated } as MapJsonDiff])
    result.push(...deferred)
  }
}

/**
 * Create a synthetic CID with the appropriate Loro container type
 * for a given schema node.
 *
 * For first-class CRDT types (counter, text, etc.), uses the schema's
 * [KIND] to determine the container type. For structural schemas
 * (product, map, sequence), uses "Map" or "List".
 */
function materializeCIDForSchema(schema: SchemaNode): ContainerID {
  const containerType = kindToContainerType(schema)
  if (containerType !== undefined) {
    return syntheticCID(containerType)
  }
  // Fallback — should not happen for well-formed schemas
  return syntheticCID("Map")
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
 * @param schema - The root document schema (used for leaf expansion)
 */
export function batchToOps(
  batch: LoroEventBatch,
  schema: SchemaNode,
  binding?: SchemaBinding,
): Op[] {
  const ops: Op[] = []

  for (const event of batch.events) {
    const kynetaPath = loroPathToKynetaPath(event.path, binding)
    // Resolve the leaf schema to distinguish text vs richtext diffs.
    let leafSchema: SchemaNode | undefined
    try {
      let s = schema
      for (const seg of kynetaPath.segments) {
        s = advanceSchema(s, seg)
      }
      leafSchema = s
    } catch {
      // Schema walk failed — fall back to untyped dispatch
    }
    const change = diffToChange(event.diff, binding, leafSchema)
    if (change) {
      ops.push({ path: kynetaPath, change })
    }
  }

  return expandMapOpsToLeaves(ops, schema)
}

// ---------------------------------------------------------------------------
// Loro path → kyneta Path conversion
// ---------------------------------------------------------------------------

/**
 * Convert a Loro event path (array of string | number | TreeID) to a
 * kyneta RawPath.
 *
 * Root scalar fields are stored in the shared `_props` LoroMap (see
 * TECHNICAL.md §11). Loro fires events at path `["_props", ...]` for
 * these fields, but the kyneta schema tree treats them as direct
 * children of the root — `RawPath.empty.field("darkMode")`, not
 * `RawPath.empty.field("_props").field("darkMode")`. Strip the
 * `_props` prefix so changefeed paths match listener registration.
 */
function loroPathToKynetaPath(
  loroPath: (string | number | unknown)[],
  binding?: SchemaBinding,
): RawPath {
  // Strip _props prefix — root scalars live in _props but their
  // kyneta paths are direct children of the root product.
  const startIndex = loroPath.length > 0 && loroPath[0] === PROPS_KEY ? 1 : 0

  let path = RawPath.empty
  for (let i = startIndex; i < loroPath.length; i++) {
    const segment = loroPath[i]
    if (typeof segment === "string") {
      // Reverse-map identity hash → absolute schema path → leaf field name.
      // Loro events emit identity-keyed strings; we need to recover the
      // original field name for kyneta schema paths.
      const absPath = binding?.inverse.get(segment as any)
      if (absPath) {
        const lastDot = absPath.lastIndexOf(".")
        const leaf = lastDot >= 0 ? absPath.slice(lastDot + 1) : absPath
        path = path.field(leaf)
      } else {
        path = path.field(segment)
      }
    } else if (typeof segment === "number") {
      path = path.item(segment)
    }
    // TreeID segments are skipped — tree path handling is future work
  }
  return path
}

// ---------------------------------------------------------------------------
// Per-type converters: Loro Diff → kyneta Change
// ---------------------------------------------------------------------------

/**
 * Convert a Loro Diff to a kyneta Change.
 * Returns null for diff types we can't map (shouldn't happen for
 * supported container types).
 */
function diffToChange(diff: Diff, binding?: SchemaBinding, leafSchema?: SchemaNode): ChangeBase | null {
  switch (diff.type) {
    case "text":
      if (leafSchema && leafSchema[KIND] === "richtext") {
        return richTextDiffToChange(diff as TextDiff)
      }
      return textDiffToChange(diff as TextDiff)
    case "list":
      return listDiffToChange(diff as ListDiff)
    case "map":
      return mapDiffToChange(diff as MapDiff, binding)
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
 * TextDiff → RichTextChange
 * Converts Loro text deltas (with optional attributes) to richtext instructions.
 */
function richTextDiffToChange(diff: TextDiff): RichTextChange {
  const instructions: RichTextInstruction[] = diff.diff.map(
    (delta: Delta<string>) => {
      if (delta.insert !== undefined) {
        const attrs = (delta as any).attributes
        if (attrs && Object.keys(attrs).length > 0) {
          return { insert: delta.insert, marks: attrs }
        }
        return { insert: delta.insert }
      }
      if (delta.delete !== undefined) {
        return { delete: delta.delete }
      }
      if (delta.retain !== undefined) {
        const attrs = (delta as any).attributes
        if (attrs && Object.keys(attrs).length > 0) {
          return { format: delta.retain, marks: attrs }
        }
        return { retain: delta.retain }
      }
      throw new Error("richTextDiffToChange: unknown delta type")
    },
  )
  return richTextChange(instructions)
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
        const items = (delta.insert as unknown[]).map(item => {
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
function mapDiffToChange(diff: MapDiff, binding?: SchemaBinding): MapChange {
  const set: Record<string, unknown> = {}
  const deleteKeys: string[] = []

  for (const [loroKey, value] of Object.entries(diff.updated)) {
    // Reverse-map identity hash → absolute schema path → leaf field name.
    // Loro map diffs use identity-keyed keys; kyneta Changes use field names.
    let key = loroKey
    if (binding) {
      const absPath = binding.inverse.get(loroKey as any)
      if (absPath) {
        const lastDot = absPath.lastIndexOf(".")
        key = lastDot >= 0 ? absPath.slice(lastDot + 1) : absPath
      }
    }

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
function treeDiffToChange(
  diff: TreeDiff,
): ChangeBase & { instructions: unknown[] } {
  // Map TreeDiffItems to kyneta TreeInstructions
  // This is a simplified mapping — full tree support is future work
  const instructions = diff.diff.map(item => {
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
      default:
        throw new Error(`Unknown tree action: ${(item as any).action}`)
    }
  })
  return { type: "tree", instructions }
}
