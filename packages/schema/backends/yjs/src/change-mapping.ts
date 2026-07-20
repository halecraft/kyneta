// change-mapping — bidirectional change mapping between kyneta and Yjs.
//
// Two directions:
//
// 1. kyneta → Yjs (`applyChangeToYjs`): Resolves the target Yjs shared
//    type at a path, then applies the change imperatively via Yjs API.
//    No intermediate diff format — direct imperative mutations.
//
// 2. Yjs → kyneta (`eventsToOps`): Converts `observeDeep` events into
//    kyneta `Op[]` for changefeed delivery. Each Y.YEvent maps to one Op
//    with a path derived from `event.path` (relative to the observed root
//    Y.Map) and a Change derived from the event's delta/keys.
//
// Structured inserts use populate-then-attach order: new shared types
// are fully populated before being inserted into their parent container.
// This produces a single observeDeep event with the complete struct,
// rather than a cascade of child MapChange events.

import type {
  ChangeBase,
  IncrementChange,
  MapChange,
  Op,
  Path,
  ProductSchema,
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
} from "@kyneta/schema"
import * as Y from "yjs"
import { resolveYjsType } from "./yjs-resolve.js"

/** Eager policy for Yjs: only first-class leaf containers (text/richtext). */
const YJS_EAGER = "leaf-containers" as const

// ---------------------------------------------------------------------------
// Direction 1: kyneta → Yjs (`applyChangeToYjs`)
// ---------------------------------------------------------------------------

/**
 * Apply a kyneta Change to the Yjs shared type tree imperatively.
 *
 * Resolves the target shared type at `path`, then applies the change
 * via the appropriate Yjs API. Must be called within a `doc.transact()`
 * for atomicity and correct event batching.
 *
 * @param rootMap - The root `Y.Map` obtained via `doc.getMap("root")`
 * @param rootSchema - The root document schema
 * @param path - The path to the target
 * @param change - The kyneta Change to apply
 */
export function applyChangeToYjs(
  rootMap: Y.Map<any>,
  rootSchema: SchemaNode,
  path: Path,
  change: ChangeBase,
  binding?: SchemaBinding,
): void {
  switch (change.type) {
    case "text":
      applyTextChange(rootMap, rootSchema, path, change as TextChange, binding)
      return

    case "richtext":
      applyRichTextChange(
        rootMap,
        rootSchema,
        path,
        change as RichTextChange,
        binding,
      )
      return

    case "sequence":
      applySequenceChange(
        rootMap,
        rootSchema,
        path,
        change as SequenceChange,
        binding,
      )
      return

    case "map":
      applyMapChange(rootMap, rootSchema, path, change as MapChange, binding)
      return

    case "replace":
      applyReplaceChange(
        rootMap,
        rootSchema,
        path,
        change as ReplaceChange,
        binding,
      )
      return

    case "increment":
      throw new Error(
        `Yjs substrate does not support "${change.type}" changes. ` +
          `Counter requires a CRDT backend that supports counters (e.g. Loro). ` +
          `Attempted IncrementChange with amount=${(change as IncrementChange).amount} at path [${pathToString(path)}].`,
      )

    case "tree":
      throw new Error(
        `Yjs substrate does not support "${change.type}" changes. ` +
          `Tree requires a CRDT backend that supports trees (e.g. Loro). ` +
          `Attempted TreeChange at path [${pathToString(path)}].`,
      )

    case "set-op":
      // Sets (`Schema.set`) are rejected by `yjs.bind` at compile time
      // (`"add-wins-per-key"` is not in `YjsLaws`). Unreachable from any
      // bound Yjs substrate today; kept against the new `SetChange`
      // vocabulary so future law-set expansion has a clear extension point.
      throw new Error(
        `Yjs substrate does not support "${change.type}" changes. ` +
          `Schema.set requires "add-wins-per-key" which is not in YjsLaws. ` +
          `Attempted SetChange at path [${pathToString(path)}].`,
      )

    default:
      throw new Error(
        `applyChangeToYjs: unsupported change type "${change.type}"`,
      )
  }
}

// ---------------------------------------------------------------------------
// Text change
// ---------------------------------------------------------------------------

function applyTextChange(
  rootMap: Y.Map<any>,
  rootSchema: SchemaNode,
  path: Path,
  change: TextChange,
  binding?: SchemaBinding,
): void {
  const { resolved } = resolveYjsType(rootMap, rootSchema, path, binding)
  if (!(resolved instanceof Y.Text)) {
    throw new Error(
      `applyChangeToYjs: TextChange target at path [${pathToString(path)}] is not a Y.Text`,
    )
  }

  // Yjs Y.Text.applyDelta uses the Quill Delta format, which is
  // structurally identical to kyneta TextInstruction[].
  resolved.applyDelta(change.instructions as any)
}

// ---------------------------------------------------------------------------
// Rich text change
// ---------------------------------------------------------------------------

function applyRichTextChange(
  rootMap: Y.Map<any>,
  rootSchema: SchemaNode,
  path: Path,
  change: RichTextChange,
  binding?: SchemaBinding,
): void {
  const { resolved } = resolveYjsType(rootMap, rootSchema, path, binding)
  if (!(resolved instanceof Y.Text)) {
    throw new Error(
      `applyChangeToYjs: RichTextChange target at path [${pathToString(path)}] is not a Y.Text`,
    )
  }
  // Map RichTextInstruction → Yjs delta format
  const delta = change.instructions.map((inst: RichTextInstruction) => {
    if ("retain" in inst) return { retain: inst.retain }
    if ("format" in inst) return { retain: inst.format, attributes: inst.marks }
    if ("insert" in inst) {
      const d: any = { insert: inst.insert }
      if (inst.marks && Object.keys(inst.marks).length > 0) {
        d.attributes = inst.marks
      }
      return d
    }
    if ("delete" in inst) return { delete: inst.delete }
    throw new Error("applyRichTextChange: unknown instruction type")
  })
  resolved.applyDelta(delta as any)
}

// ---------------------------------------------------------------------------
// Sequence change
// ---------------------------------------------------------------------------

function applySequenceChange(
  rootMap: Y.Map<any>,
  rootSchema: SchemaNode,
  path: Path,
  change: SequenceChange,
  binding?: SchemaBinding,
): void {
  const { resolved } = resolveYjsType(rootMap, rootSchema, path, binding)
  if (!(resolved instanceof Y.Array)) {
    throw new Error(
      `applyChangeToYjs: SequenceChange target at path [${pathToString(path)}] is not a Y.Array`,
    )
  }

  // Resolve the item schema for structured insert detection. List items share
  // the list's field-abs-path (an index is not a field boundary).
  const targetSchema = pathSchema(rootSchema, path)
  const itemSchema = getItemSchema(targetSchema)
  const absPath = fieldAbsPath(path.segments)

  let cursor = 0
  for (const instruction of change.instructions) {
    if ("retain" in instruction) {
      cursor += instruction.retain
    } else if ("delete" in instruction) {
      resolved.delete(cursor, instruction.delete)
      // cursor stays — deleted items shift remaining items down
    } else if ("insert" in instruction) {
      const items = instruction.insert as readonly unknown[]
      const yjsItems = items.map(item =>
        itemSchema
          ? realizeYjs(
              materializeValue(itemSchema, item, binding, absPath, YJS_EAGER),
            )
          : item,
      )
      resolved.insert(cursor, yjsItems)
      cursor += items.length
    }
  }
}

// ---------------------------------------------------------------------------
// Map change
// ---------------------------------------------------------------------------

function applyMapChange(
  rootMap: Y.Map<any>,
  rootSchema: SchemaNode,
  path: Path,
  change: MapChange,
  binding?: SchemaBinding,
): void {
  const { resolved } = resolveYjsType(rootMap, rootSchema, path, binding)
  if (!(resolved instanceof Y.Map)) {
    throw new Error(
      `applyChangeToYjs: MapChange target at path [${pathToString(path)}] is not a Y.Map`,
    )
  }

  // Resolve the schema at this path for structured value detection
  const targetSchema = pathSchema(rootSchema, path)
  const parentAbsPath = fieldAbsPath(path.segments)
  const isProduct = targetSchema[KIND] === "product"

  // Apply deletes first
  if (change.delete) {
    for (const key of change.delete) {
      resolved.delete(key)
    }
  }

  // Apply sets. Product fields are identity-keyed and advance the abs-path;
  // map/record entries keep their runtime key and leave the abs-path unchanged.
  if (change.set) {
    for (const [key, value] of Object.entries(change.set)) {
      const fieldSchema = getFieldSchema(targetSchema, key)
      const childAbsPath = isProduct
        ? extendSchemaPathKey(parentAbsPath, key)
        : parentAbsPath
      const mapKey = isProduct ? containerKey(binding, childAbsPath, key) : key
      const yjsValue = fieldSchema
        ? realizeYjs(
            materializeValue(
              fieldSchema,
              value,
              binding,
              childAbsPath,
              YJS_EAGER,
            ),
          )
        : value
      resolved.set(mapKey, yjsValue)
    }
  }
}

// ---------------------------------------------------------------------------
// Replace change
// ---------------------------------------------------------------------------

function applyReplaceChange(
  rootMap: Y.Map<any>,
  rootSchema: SchemaNode,
  path: Path,
  change: ReplaceChange,
  binding?: SchemaBinding,
): void {
  if (path.length === 0) {
    throw new Error(
      "Cannot replace the root document struct in a CRDT backend. The root identity is fixed. Please mutate its properties individually (e.g., `doc.myField.set(value)` instead of `doc.set({ myField: value })`).",
    )
  }

  // Target the parent container, using the last segment to identify
  // which child to replace.
  const lastSeg = path.segments.at(-1)
  if (!lastSeg) throw new Error("replaceChangeToDiff: empty path")
  const parentPath = path.slice(0, -1)
  const { resolved: parent } = resolveYjsType(
    rootMap,
    rootSchema,
    parentPath,
    binding,
  )

  const resolved = lastSeg.resolve()
  // The target field's own field-abs-path (includes the last field segment).
  const targetSchema = pathSchema(rootSchema, path)
  const absPath = fieldAbsPath(path.segments)
  const yjsValue = realizeYjs(
    materializeValue(targetSchema, change.value, binding, absPath, YJS_EAGER),
  )
  if (
    parent instanceof Y.Map &&
    (lastSeg.role === "field" || lastSeg.role === "entry")
  ) {
    // Identity-keying applies only at product-field boundaries; entry
    // segments use the runtime key as-is.
    const mapKey =
      lastSeg.role === "field"
        ? containerKey(binding, absPath, resolved as string)
        : (resolved as string)
    parent.set(mapKey, yjsValue)
  } else if (parent instanceof Y.Array && lastSeg.role === "index") {
    parent.delete(resolved as number, 1)
    parent.insert(resolved as number, [yjsValue])
  } else {
    throw new Error(
      `applyChangeToYjs: ReplaceChange parent at path [${pathToString(parentPath)}] ` +
        `is not a Y.Map or Y.Array (got ${typeof parent})`,
    )
  }
}

// ---------------------------------------------------------------------------
// realizeYjs — MaterializedNode → Yjs shared type (populate-then-attach)
// ---------------------------------------------------------------------------

/**
 * Turn a `MaterializedNode` (from `materializeValue`) into a Yjs shared type or
 * plain value. Post-order: children are fully built before their parent is
 * assembled, and the parent is attached to the tree by the caller — the
 * populate-then-attach pattern that keeps a whole structural insert to a single
 * `observeDeep` event.
 *
 * All keys in the IR are already final (identity-hashed at product-field
 * boundaries by `materializeValue`); this function never computes a key.
 */
function realizeYjs(node: MaterializedNode): unknown {
  switch (node.kind) {
    case "plain":
      return node.value

    case "text": {
      const text = new Y.Text()
      if (node.content.length > 0) text.insert(0, node.content)
      return text
    }

    case "richtext": {
      // Yjs uses Y.Text for both plain and rich text.
      const text = new Y.Text()
      const value = node.value
      if (typeof value === "string" && value.length > 0) {
        text.insert(0, value)
      } else if (Array.isArray(value)) {
        // RichTextDelta: array of { text, marks? } spans → Yjs delta
        const delta = (
          value as Array<{ text: string; marks?: Record<string, unknown> }>
        ).map(span => {
          const d: any = { insert: span.text }
          if (span.marks && Object.keys(span.marks).length > 0) {
            d.attributes = span.marks
          }
          return d
        })
        if (delta.length > 0) text.applyDelta(delta)
      }
      return text
    }

    case "counter":
      // Unreachable: counters are rejected at `yjs.bind` (no "additive" law).
      throw new Error(
        "Yjs substrate does not support counters. " +
          "This should have been caught at bind() time.",
      )

    case "map": {
      const map = new Y.Map()
      for (const [key, child] of node.entries) map.set(key, realizeYjs(child))
      return map
    }

    case "list": {
      const arr = new Y.Array()
      arr.insert(0, node.items.map(realizeYjs))
      return arr
    }
  }
}

// ---------------------------------------------------------------------------
// Direction 2: Yjs → kyneta (`eventsToOps`)
// ---------------------------------------------------------------------------

/**
 * Convert `observeDeep` events into kyneta `Op[]` for changefeed delivery.
 *
 * Each `Y.YEvent` in the array maps to one Op with:
 * - `path`: derived from `event.path` (relative to the observed root Y.Map)
 * - `change`: derived from the event's delta/keys based on target type
 *
 * `event.path` in `observeDeep` is relative to the observed shared type.
 * Since we observe `rootMap` (the single root Y.Map), paths map directly
 * to kyneta `PathSegment[]`.
 *
 * @param events - The events from the `observeDeep` callback
 */
export function eventsToOps(
  events: Y.YEvent<any>[],
  schema: SchemaNode,
  binding?: SchemaBinding,
): Op[] {
  const ops: Op[] = []

  for (const event of events) {
    const kynetaPath = yjsPathToKynetaPath(event.path, schema, binding)
    const change = eventToChange(event, schema, kynetaPath, binding)
    if (change) {
      ops.push({ path: kynetaPath, change })
    }
  }

  return expandMapOpsToLeaves(ops, schema)
}

// ---------------------------------------------------------------------------
// Yjs path → kyneta Path conversion
// ---------------------------------------------------------------------------

/**
 * Convert a Yjs event path to a kyneta `RawPath`, walking the schema
 * alongside so each segment is classified as field / entry / index by
 * the current schema kind.
 *
 * Why schema-aware and not "did the inverse lookup hit?": the binding's
 * inverse map only covers declared product-field positions reachable
 * without crossing a runtime-keyed container. A declared struct field
 * nested under a `record(...)` value type is reachable via Yjs but
 * absent from `binding.inverse` — without the schema walk it would be
 * misclassified as an entry and then rejected by `advanceSchema`.
 */
function yjsPathToKynetaPath(
  yjsPath: (string | number)[],
  rootSchema: SchemaNode,
  binding?: SchemaBinding,
): RawPath {
  let path = RawPath.empty
  let schema: SchemaNode | undefined = rootSchema
  for (const segment of yjsPath) {
    if (typeof segment === "string") {
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
        schema = (schema as ProductSchema | undefined)?.fields[leaf]
      } else if (kind === "map" || kind === "set" || kind === "tree") {
        path = path.entry(leaf)
        schema = (schema as any)?.item
      } else {
        // Unknown / sum / unrecognized — fall back to entry. Subsequent
        // segments are likely walking plain JSON inside a sum variant.
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
    }
  }
  return path
}

// ---------------------------------------------------------------------------
// Per-type event → Change converters
// ---------------------------------------------------------------------------

/**
 * Convert a single Yjs event into a kyneta Change.
 *
 * For Y.Text events, dispatches to either `textEventToChange` or
 * `richTextEventToChange` based on the schema at the event's path.
 * Both text and richtext produce `Y.YTextEvent`, so schema awareness
 * is required for correct dispatch.
 *
 * Returns null for event types we can't map.
 */
function eventToChange(
  event: Y.YEvent<any>,
  rootSchema: SchemaNode,
  kynetaPath: RawPath,
  binding?: SchemaBinding,
): ChangeBase | null {
  if (event.target instanceof Y.Text) {
    // Both text and richtext use Y.Text — resolve the schema to dispatch.
    const schemaAtPath = pathSchema(rootSchema, kynetaPath)
    if (schemaAtPath[KIND] === "richtext") {
      return richTextEventToChange(event)
    }
    return textEventToChange(event)
  }
  if (event.target instanceof Y.Array) {
    return arrayEventToChange(event)
  }
  if (event.target instanceof Y.Map) {
    return mapEventToChange(event, binding)
  }
  return null
}

/**
 * Y.Text event → TextChange.
 *
 * `event.delta` uses the Quill Delta format, structurally identical to
 * kyneta `TextInstruction[]`. We strip the `attributes` field (rich text
 * formatting not surfaced by kyneta plain text).
 */
function textEventToChange(event: Y.YEvent<any>): TextChange {
  const instructions: TextInstruction[] = []

  for (const delta of event.delta) {
    if (delta.retain !== undefined) {
      instructions.push({ retain: delta.retain as number })
    } else if (delta.insert !== undefined) {
      instructions.push({ insert: delta.insert as string })
    } else if (delta.delete !== undefined) {
      instructions.push({ delete: delta.delete as number })
    }
  }

  return { type: "text", instructions }
}

/**
 * Y.Text event → RichTextChange.
 *
 * `event.delta` uses the Quill Delta format. We map each delta op to a
 * `RichTextInstruction`, preserving `attributes` as `marks` for format
 * and insert instructions.
 */
function richTextEventToChange(event: Y.YEvent<any>): RichTextChange {
  const instructions: RichTextInstruction[] = []

  for (const delta of event.delta) {
    if (delta.retain !== undefined) {
      const attrs = (delta as any).attributes
      if (attrs && Object.keys(attrs).length > 0) {
        instructions.push({ format: delta.retain as number, marks: attrs })
      } else {
        instructions.push({ retain: delta.retain as number })
      }
    } else if (delta.insert !== undefined) {
      const attrs = (delta as any).attributes
      if (attrs && Object.keys(attrs).length > 0) {
        instructions.push({ insert: delta.insert as string, marks: attrs })
      } else {
        instructions.push({ insert: delta.insert as string })
      }
    } else if (delta.delete !== undefined) {
      instructions.push({ delete: delta.delete as number })
    }
  }

  return richTextChange(instructions)
}

/**
 * Y.Array event → SequenceChange.
 *
 * `event.changes.delta` provides the same cursor-based ops as kyneta
 * SequenceInstruction[]. Container values (Y.Map, Y.Array) in insert
 * arrays are converted to plain objects via `.toJSON()`.
 */
function arrayEventToChange(event: Y.YEvent<any>): SequenceChange {
  const instructions: SequenceInstruction[] = []

  for (const delta of event.changes.delta) {
    if (delta.retain !== undefined) {
      instructions.push({ retain: delta.retain as number })
    } else if (delta.delete !== undefined) {
      instructions.push({ delete: delta.delete as number })
    } else if (delta.insert !== undefined) {
      const items = (delta.insert as unknown[]).map((item: unknown) =>
        extractEventValue(item),
      )
      instructions.push({ insert: items })
    }
  }

  return { type: "sequence", instructions }
}

/**
 * Y.Map event → MapChange.
 *
 * `event.changes.keys` is a `Map<string, { action: 'add'|'update'|'delete', ... }>`.
 * - `action: 'add'|'update'` → `set[key] = map.get(key)`
 * - `action: 'delete'` → `delete.push(key)`
 */
function mapEventToChange(
  event: Y.YEvent<any>,
  binding?: SchemaBinding,
): MapChange | null {
  const set: Record<string, unknown> = {}
  const deleteKeys: string[] = []
  let hasSet = false
  let hasDelete = false

  const target = event.target as Y.Map<any>

  event.changes.keys.forEach((change: { action: string }, key: string) => {
    // Reverse-map identity hash → absolute schema path → leaf field name.
    const absPath = binding?.inverse.get(key as any)
    const fieldName = absPath
      ? absPath.lastIndexOf(".") >= 0
        ? absPath.slice(absPath.lastIndexOf(".") + 1)
        : absPath
      : key

    if (change.action === "add" || change.action === "update") {
      const value = target.get(key)
      set[fieldName] = extractEventValue(value)
      hasSet = true
    } else if (change.action === "delete") {
      deleteKeys.push(fieldName)
      hasDelete = true
    }
  })

  if (!hasSet && !hasDelete) return null

  return {
    type: "map",
    ...(hasSet ? { set } : {}),
    ...(hasDelete ? { delete: deleteKeys } : {}),
  }
}

// ---------------------------------------------------------------------------
// Value extraction from Yjs events
// ---------------------------------------------------------------------------

/**
 * Convert a Yjs value from an event into a plain value.
 * Container values (Y.Map, Y.Array, Y.Text) → `.toJSON()`.
 * Plain values → returned as-is.
 */
function extractEventValue(value: unknown): unknown {
  if (value instanceof Y.Map) return value.toJSON()
  if (value instanceof Y.Array) return value.toJSON()
  if (value instanceof Y.Text) return value.toJSON()
  return value
}

// ---------------------------------------------------------------------------
// Schema helpers
// ---------------------------------------------------------------------------

/**
 * Get the item schema from a sequence schema, if available.
 */
function getItemSchema(schema: SchemaNode): SchemaNode | undefined {
  if (schema[KIND] === "sequence") return schema.item
  if (schema[KIND] === "movable") return schema.item
  return undefined
}

/**
 * Get the field schema from a product or map schema for a given key.
 */
function getFieldSchema(
  schema: SchemaNode,
  key: string,
): SchemaNode | undefined {
  if (schema[KIND] === "product") {
    return schema.fields[key]
  }
  if (schema[KIND] === "map") {
    return schema.item
  }
  if (schema[KIND] === "set") {
    return schema.item
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Path formatting
// ---------------------------------------------------------------------------

function pathToString(path: Path): string {
  return path.segments.map(seg => String(seg.resolve())).join(".")
}
