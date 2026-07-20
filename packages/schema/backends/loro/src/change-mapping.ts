// change-mapping — bidirectional mapping between kyneta Changes and Loro Diffs.
//
// changeToDiff: kyneta Change → Loro [ContainerID, Diff | JsonDiff][]
// batchToOps:   Loro LoroEventBatch → kyneta Op[]
//
// These are conceptual inverses at the kyneta↔Loro boundary.
// changeToDiff is invoked by the substrate's `prepare` to produce the
// diff group that the coalescer then dispatches against `applyDiff`
// (immediately for structural inserts; merged into the per-CID
// buffer for plain MapDiff writes). batchToOps is used by the
// `doc.subscribe()` event bridge to translate Loro events into
// kyneta Ops for the changefeed.
//
// Structured inserts use Loro's JsonContainerID format (🦜:cid:...)
// to reference new containers within an applyDiff batch.

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
  TreeChange,
  TreeInstruction,
} from "@kyneta/schema"
import {
  containerKey,
  expandMapOpsToLeaves,
  extendSchemaPathKey,
  fieldAbsPath,
  KIND,
  type MaterializedNode,
  materializeValue,
  pathSchema,
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
 * The counter is module-scoped and intentionally unbounded: each
 * `changeToDiff` call produces a self-contained group whose synthetic
 * CIDs are remapped to real CIDs the moment `doc.applyDiff(group)`
 * runs. There is no cross-call coalescing of synthetic CIDs — the
 * eager-prepare write path applies each structural group inside the
 * call that produced it.
 */
function syntheticCID(
  containerType: "Map" | "List" | "Text" | "Counter" | "MovableList" | "Tree",
): ContainerID {
  return `cid:${syntheticCounter++}@0:${containerType}` as ContainerID
}

function jsonCID(cid: ContainerID): JsonContainerID {
  return `🦜:${cid}` as JsonContainerID
}

/** Loro needs declared containers to exist before nested writes land on them. */
const LORO_EAGER = "all-containers" as const

// ---------------------------------------------------------------------------
// realizeLoro — MaterializedNode → Loro applyDiff tuples (pre-order)
// ---------------------------------------------------------------------------

/**
 * The Loro container type for a materialized container node. `movable` on a
 * list node selects `MovableList` over `List`.
 */
function containerTypeForNode(
  node: MaterializedNode,
): "Map" | "List" | "MovableList" | "Text" | "Counter" {
  switch (node.kind) {
    case "map":
      return "Map"
    case "list":
      return node.movable ? "MovableList" : "List"
    case "text":
    case "richtext":
      return "Text"
    case "counter":
      return "Counter"
    default:
      // Unreachable: `plain` nodes are inlined by `materializeChild`.
      return "Map"
  }
}

/**
 * Resolve a materialized child into the value the parent stores for it — a
 * plain `Value` for `plain` nodes, or a `🦜:` JsonContainerID reference for
 * container/leaf-container nodes (whose own diffs are pushed into `result`).
 * The single point where a synthetic ContainerID is minted — keeping
 * `materializeValue` (the pure planner) free of CID allocation.
 */
function materializeChild(
  node: MaterializedNode,
  result: [ContainerID, Diff | JsonDiff][],
): Value | JsonContainerID {
  if (node.kind === "plain") return node.value as Value
  const cid = syntheticCID(containerTypeForNode(node))
  realizeLoro(node, cid, result)
  return jsonCID(cid)
}

/**
 * Emit the applyDiff tuples for a container `node` under `cid`, pre-order:
 * the container's own diff is pushed BEFORE its descendants. Loro resolves a
 * `🦜:` reference only once the referenced container has been created, so the
 * parent (which holds the reference) must land before the child it points to.
 */
function realizeLoro(
  node: MaterializedNode,
  cid: ContainerID,
  result: [ContainerID, Diff | JsonDiff][],
): void {
  switch (node.kind) {
    case "map": {
      const updated: Record<string, Value | JsonContainerID | undefined> = {}
      const pending: Array<[ContainerID, MaterializedNode]> = []
      for (const [key, child] of node.entries) {
        if (child.kind === "plain") {
          updated[key] = child.value as Value
        } else {
          const childCID = syntheticCID(containerTypeForNode(child))
          updated[key] = jsonCID(childCID)
          pending.push([childCID, child])
        }
      }
      result.push([cid, { type: "map", updated } as MapJsonDiff])
      for (const [childCID, child] of pending) {
        realizeLoro(child, childCID, result)
      }
      return
    }
    case "list": {
      const listDeltas: Delta<(Value | JsonContainerID)[]>[] = []
      const pending: Array<[ContainerID, MaterializedNode]> = []
      for (const item of node.items) {
        if (item.kind === "plain") {
          listDeltas.push({ insert: [item.value as Value] })
        } else {
          const childCID = syntheticCID(containerTypeForNode(item))
          listDeltas.push({ insert: [jsonCID(childCID)] })
          pending.push([childCID, item])
        }
      }
      result.push([cid, { type: "list", diff: listDeltas } as ListJsonDiff])
      for (const [childCID, child] of pending) {
        realizeLoro(child, childCID, result)
      }
      return
    }
    case "text": {
      if (node.content !== "") {
        result.push([cid, { type: "text", diff: [{ insert: node.content }] }])
      }
      return
    }
    case "richtext": {
      const value = node.value
      if (typeof value === "string" && value.length > 0) {
        result.push([cid, { type: "text", diff: [{ insert: value }] }])
      } else if (Array.isArray(value)) {
        const diff = (
          value as Array<{ text: string; marks?: Record<string, unknown> }>
        ).map(span => {
          const d: any = { insert: span.text }
          if (span.marks && Object.keys(span.marks).length > 0) {
            d.attributes = span.marks
          }
          return d as Delta<string>
        })
        if (diff.length > 0) result.push([cid, { type: "text", diff }])
      }
      return
    }
    case "counter": {
      if (node.amount !== 0) {
        result.push([cid, { type: "counter", increment: node.amount }])
      }
      return
    }
  }
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
  const { resolved } = resolveContainer(doc, schema, path, binding)

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
    const { resolved: parentResolved } = resolveContainer(
      doc,
      schema,
      parentPath,
      binding,
    )
    if (!isLoroContainer(parentResolved)) {
      // Parent is the LoroDoc (root level) — use the _props map
      const propsMap = (parentResolved as any).getMap(PROPS_KEY)
      targetCID = propsMap.id as ContainerID
    } else {
      targetCID = parentResolved.id
    }
  }

  // Invariant: no sum schema mid-walk. Non-replace change types cannot
  // originate from sum-interior paths (PlainSchema excludes all CRDT
  // types); replace changes are dispatched early above. If the invariant
  // were violated, `pathSchema` would return the sum schema (instead of
  // the prior behavior where `advanceSchema` would throw); the downstream
  // switch then receives a sum schema for a non-replace change — same
  // effective failure mode (malformed write), different surface.
  const targetSchema = pathSchema(schema, path)
  // Field-only abs-path of the target container — the prefix under which a
  // materialized value's product fields are identity-keyed.
  const absPath = fieldAbsPath(path.segments)

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
        binding,
        absPath,
      )

    case "map":
      return mapChangeToDiff(
        targetCID,
        change as MapChange,
        targetSchema,
        binding,
        absPath,
      )

    case "increment":
      return [[targetCID, counterChangeToDiff(change as IncrementChange)]]

    case "set-op":
      // Sets (`Schema.set`) are rejected by `loro.bind` at compile time
      // (`"add-wins-per-key"` is not in `LoroLaws`). This branch is
      // unreachable from any bound Loro substrate today. Kept against
      // the new `SetChange` vocabulary so a future law-set expansion
      // doesn't have to invent the wire format from scratch — when that
      // happens, encode `add[]` as Map updates keyed by member identity
      // and `remove[]` as `updated[key] = undefined` (matching Loro's
      // MapDiff delete convention; see mapChangeToDiff).
      throw new Error(
        "changeToDiff: 'set-op' is not yet supported by the Loro backend " +
          "(Schema.set requires 'add-wins-per-key' which is not in LoroLaws).",
      )

    case "tree":
      return treeChangeToDiff(targetCID, change as TreeChange, doc)

    default:
      throw new Error(`changeToDiff: unsupported change type "${change.type}"`)
  }
}

/**
 * TreeChange → TreeDiff.
 *
 * Loro's `TreeDiffItem` carries fields we don't track in `TreeInstruction`
 * (`fractionalIndex`, `oldParent`, `oldIndex`); Loro derives the real
 * values from its own state at `applyDiff` time, so empty/undefined
 * placeholders pass through the WASM decoder.
 *
 * Local prepare vs. peer replay split for `create`:
 *
 * - On local prepare, the substrate's `[TREE_NODE_ALLOCATE]` has already
 *   run `LoroTree.createNode(parent, index)` and the node exists at the
 *   target position. Re-applying the `create` diff item against the
 *   same TreeID is not idempotent in Loro — it panics with a
 *   locking-order violation in `handler.rs:236` when the diff carries a
 *   different parent than the node already has. We filter the create
 *   item out by checking `tree.getNodeByID(target)` against the live
 *   tree handle.
 *
 * - On peer replay (`applyChanges` on a remote doc, or merge-driven
 *   batch replay), the node does NOT exist yet — `getNodeByID` returns
 *   undefined, the filter is a no-op, and the create lands naturally.
 *
 * The kyneta-level `TreeChange.create` instruction always rides the
 * changefeed (the schema-side write semantics don't change); only the
 * Loro diff dispatch is conditional.
 */
function treeChangeToDiff(
  targetCID: ContainerID,
  change: TreeChange,
  doc: LoroDoc,
): [ContainerID, Diff | JsonDiff][] {
  const tree = doc.getContainerById(targetCID) as
    | { getNodeByID?: (id: string) => unknown }
    | undefined
  const items: any[] = []
  for (const inst of change.instructions) {
    if (inst.action === "create") {
      if (tree?.getNodeByID?.(inst.target) !== undefined) {
        // Already created by TREE_NODE_ALLOCATE; skip the redundant diff.
        continue
      }
      items.push({
        target: inst.target,
        action: "create",
        parent: inst.parent ?? undefined,
        index: inst.index,
        fractionalIndex: "",
      })
    } else if (inst.action === "delete") {
      items.push({
        target: inst.target,
        action: "delete",
        oldParent: undefined,
        oldIndex: 0,
      })
    } else if (inst.action === "move") {
      items.push({
        target: inst.target,
        action: "move",
        parent: inst.parent ?? undefined,
        index: inst.index,
        fractionalIndex: "",
        oldParent: undefined,
        oldIndex: 0,
      })
    }
  }
  return [[targetCID, { type: "tree", diff: items } as TreeDiff]]
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
  binding: SchemaBinding | undefined,
  absPath: string,
): [ContainerID, Diff | JsonDiff][] {
  const result: [ContainerID, Diff | JsonDiff][] = []
  const listDeltas: Delta<(Value | JsonContainerID)[]>[] = []

  // Determine the item schema — movable sequences also have .item. List items
  // share the list's abs-path prefix (an index is not a field boundary).
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
      for (const item of inst.insert as readonly unknown[]) {
        const child = itemSchema
          ? materializeChild(
              materializeValue(itemSchema, item, binding, absPath, LORO_EAGER),
              result,
            )
          : (item as Value)
        listDeltas.push({ insert: [child] })
      }
    }
  }

  // The list diff itself goes first (parent-before-descendant).
  result.unshift([
    targetCID,
    { type: "list", diff: listDeltas } as ListJsonDiff,
  ])
  return result
}

/**
 * MapChange → MapDiff (possibly with JsonContainerID references).
 *
 * Product fields are identity-keyed and advance the abs-path; map/record
 * entries keep their runtime key and leave the abs-path unchanged.
 */
function mapChangeToDiff(
  targetCID: ContainerID,
  change: MapChange,
  targetSchema: SchemaNode,
  binding: SchemaBinding | undefined,
  absPath: string,
): [ContainerID, Diff | JsonDiff][] {
  const result: [ContainerID, Diff | JsonDiff][] = []
  const updated: Record<string, Value | JsonContainerID | undefined> = {}

  const isProduct = targetSchema[KIND] === "product"
  const sk = structuralKind(targetSchema)
  const valueSchema =
    sk === "map" && "item" in targetSchema
      ? ((targetSchema as any).item as SchemaNode)
      : undefined

  const keyFor = (key: string): { mapKey: string; childAbs: string } => {
    if (isProduct) {
      const childAbs = extendSchemaPathKey(absPath, key)
      return { mapKey: containerKey(binding, childAbs, key), childAbs }
    }
    return { mapKey: key, childAbs: absPath }
  }

  // Set entries
  if (change.set) {
    for (const [key, value] of Object.entries(change.set)) {
      let fieldSchema = valueSchema
      if (!fieldSchema && isProduct && targetSchema.fields[key]) {
        fieldSchema = targetSchema.fields[key]
      }
      const { mapKey, childAbs } = keyFor(key)
      updated[mapKey] = fieldSchema
        ? materializeChild(
            materializeValue(fieldSchema, value, binding, childAbs, LORO_EAGER),
            result,
          )
        : (value as Value)
    }
  }

  // Delete entries
  if (change.delete) {
    for (const key of change.delete) {
      updated[keyFor(key).mapKey] = undefined
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
    throw new Error(
      "Cannot replace the root document struct in a CRDT backend. The root identity is fixed. Please mutate its properties individually (e.g., `doc.myField.set(value)` instead of `doc.set({ myField: value })`).",
    )
  }

  const lastSeg = path.segments[path.segments.length - 1]
  if (!lastSeg) throw new Error("replaceChangeToDiff: empty path")

  // Materialize the replaced value. `absPath` is the target's own field-abs-path
  // — only product-field segments contribute; entry/index segments are runtime.
  const targetSchema = pathSchema(schema, path, binding)
  const absPath = fieldAbsPath(path.segments)
  const node = materializeValue(
    targetSchema,
    change.value,
    binding,
    absPath,
    LORO_EAGER,
  )

  // Container-kind target (product/map/sequence/text/counter): set the field's
  // OWN container contents in place. A root-level container is addressed
  // directly (`doc.getMap(id)`) and cannot be swapped, and a nested one is
  // reused rather than swapped — both are correct because `realizeLoro`
  // identity-keys every leaf onto the resolved container.
  if (node.kind !== "plain") {
    const { resolved: target } = resolveContainer(doc, schema, path, binding)
    if (isLoroContainer(target)) {
      const result: [ContainerID, Diff | JsonDiff][] = []
      realizeLoro(node, target.id as ContainerID, result)
      return result
    }
    // No live container for a bound container field would be a resolution bug;
    // fall through to the plain path defensively.
  }

  // Plain-value target (scalar/sum/json subtree): store as a plain value in the
  // parent container (root scalars live in the shared _props map).
  const parentPath = path.slice(0, -1)
  const { resolved: parentResolved } = resolveContainer(
    doc,
    schema,
    parentPath,
    binding,
  )
  const plainValue = (
    node.kind === "plain" ? node.value : change.value
  ) as Value
  const mapKey =
    lastSeg.role === "field"
      ? containerKey(binding, absPath, lastSeg.resolve() as string)
      : (lastSeg.resolve() as string)

  if (!isLoroContainer(parentResolved)) {
    if (lastSeg.role === "field" || lastSeg.role === "entry") {
      const propsMap = (parentResolved as any).getMap(PROPS_KEY)
      const propsCID = propsMap.id as ContainerID
      return [
        [
          propsCID,
          { type: "map", updated: { [mapKey]: plainValue } } as MapDiff,
        ],
      ]
    }
    throw new Error(
      "replaceChangeToDiff: root-level replace requires a key-style segment",
    )
  }

  const parentCID = parentResolved.id

  if (lastSeg.role === "field" || lastSeg.role === "entry") {
    return [
      [
        parentCID,
        { type: "map", updated: { [mapKey]: plainValue } } as MapDiff,
      ],
    ]
  }

  // Index-based replace of a plain list item — delete + insert at position.
  if (lastSeg.role === "index") {
    const idx = lastSeg.resolve() as number
    const diff: Delta<Value[]>[] = []
    if (idx > 0) diff.push({ retain: idx } as Delta<Value[]>)
    diff.push({ delete: 1 } as Delta<Value[]>)
    diff.push({ insert: [plainValue] } as Delta<Value[]>)
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
    const kynetaPath = loroPathToKynetaPath(event.path, schema, binding)
    // Resolve the leaf schema to distinguish text vs richtext diffs.
    // Sum-interior paths return the sum schema (foldPath's short-circuit
    // takes over what the old try/catch handled by falling through).
    const leafSchema: SchemaNode | undefined = pathSchema(schema, kynetaPath)
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
 * Convert a Loro event path to a kyneta `RawPath`, walking the schema
 * alongside so each segment is classified as field / entry / index by
 * the current schema kind — not by guessing from the segment shape.
 *
 * Schema-aware walking is what makes deep records work: at a `record(struct)`
 * position, the first segment is the record entry (not identity-keyed)
 * and the next is a declared field of the inner struct; without the
 * schema walk both would be misclassified by a uniform heuristic.
 *
 * The `_props` prefix at index 0 is stripped because root scalar fields
 * live there in Loro's wire format but appear as direct root children
 * in kyneta paths (see TECHNICAL.md §11).
 */
function loroPathToKynetaPath(
  loroPath: (string | number | unknown)[],
  rootSchema: SchemaNode,
  binding?: SchemaBinding,
): RawPath {
  // Strip _props prefix — root scalars live in _props but their
  // kyneta paths are direct children of the root product.
  const startIndex = loroPath.length > 0 && loroPath[0] === PROPS_KEY ? 1 : 0

  let path = RawPath.empty
  let schema: SchemaNode | undefined = rootSchema
  for (let i = startIndex; i < loroPath.length; i++) {
    const segment = loroPath[i]
    if (typeof segment === "string") {
      // At a tree position, a Loro `TreeID` (`${counter}@${peerId}`) is
      // a runtime node id, not an identity hash — short-circuit before
      // the inverse-lookup branch below.
      if (schema?.[KIND] === "tree") {
        path = path.entry(segment)
        schema = (schema as any).item
        continue
      }
      // Inverse-lookup recovers the original declared field name when
      // the segment IS an identity hash; otherwise we keep the string.
      let leaf = segment
      const absPath = binding?.inverse.get(segment as any)
      if (absPath) {
        const lastDot = absPath.lastIndexOf(".")
        leaf = lastDot >= 0 ? absPath.slice(lastDot + 1) : absPath
      }
      const kind = schema?.[KIND]
      if (kind === "product") {
        path = path.field(leaf)
        schema = (schema as any).fields[leaf]
      } else if (kind === "map" || kind === "set") {
        path = path.entry(leaf)
        schema = (schema as any).item
      } else {
        path = path.entry(leaf)
        schema = undefined
      }
    } else if (typeof segment === "number") {
      path = path.item(segment)
      const kind = schema?.[KIND]
      if (kind === "sequence" || kind === "movable") {
        schema = (schema as any).item
      } else {
        schema = undefined
      }
    } else if (typeof segment === "object" && segment !== null) {
      // Loro TreeID may arrive as an object `{ peer, counter }` in some
      // wire forms — coerce to its canonical string repr.
      const treeId =
        typeof (segment as { toString?: () => string }).toString === "function"
          ? String(segment)
          : ""
      if (treeId && schema?.[KIND] === "tree") {
        path = path.entry(treeId)
        schema = (schema as any).item
      }
    }
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
function diffToChange(
  diff: Diff,
  binding?: SchemaBinding,
  leafSchema?: SchemaNode,
): ChangeBase | null {
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
 * TreeDiff → TreeChange.
 *
 * Inverse of `treeChangeToDiff` for the structural fields. kyneta's
 * `TreeInstruction` vocabulary is intentionally minimal:
 * - `create` / `move` carry `(target, parent, index)`. Loro's
 *   `fractionalIndex` is dropped — it's a substrate-internal detail
 *   that doesn't survive the round trip and isn't needed by `stepTree`.
 * - `delete` carries only `target`. Loro's `oldParent`/`oldIndex`
 *   metadata is discarded because the plain shadow's `stepTree` only
 *   needs the target to remove a node.
 *
 * The asymmetry is deliberate: kyneta's vocabulary stays stable across
 * substrates that use fractional indexing (Loro) and those that don't
 * (plain). Round-trip equality holds at the `doc.tree()` snapshot level,
 * not at the raw instruction level.
 */
function treeDiffToChange(diff: TreeDiff): TreeChange {
  const instructions: TreeInstruction[] = diff.diff.map(
    (item): TreeInstruction => {
      switch (item.action) {
        case "create":
          return {
            action: "create" as const,
            target: item.target,
            parent: item.parent ?? null,
            index: item.index,
          }
        case "delete":
          return {
            action: "delete" as const,
            target: item.target,
          }
        case "move":
          return {
            action: "move" as const,
            target: item.target,
            parent: item.parent ?? null,
            index: item.index,
          }
        default:
          throw new Error(`Unknown tree action: ${(item as any).action}`)
      }
    },
  )
  return { type: "tree", instructions }
}
