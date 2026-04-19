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
} from "@kyneta/schema"
import * as Y from "yjs"
import { resolveYjsType } from "./yjs-resolve.js"

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

  // Resolve the item schema for structured insert detection
  const targetSchema = resolveSchemaAtPath(rootSchema, path)
  const itemSchema = getItemSchema(targetSchema)

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
        maybeCreateSharedType(item, itemSchema),
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
  const targetSchema = resolveSchemaAtPath(rootSchema, path)

  // Apply deletes first
  if (change.delete) {
    for (const key of change.delete) {
      resolved.delete(key)
    }
  }

  // Apply sets
  if (change.set) {
    for (const [key, value] of Object.entries(change.set)) {
      const fieldSchema = getFieldSchema(targetSchema, key)
      const yjsValue = maybeCreateSharedType(value, fieldSchema)
      // For product schemas (structs), use the identity hash as the map key.
      // For map schemas (records), use the key as-is (no identity-keying).
      let mapKey = key
      if (binding && targetSchema[KIND] === "product") {
        // Compute absolute schema path for this field.
        const parentAbsPath = path.segments
          .filter(s => s.role === "key")
          .map(s => s.resolve() as string)
          .join(".")
        const absPath = parentAbsPath ? `${parentAbsPath}.${key}` : key
        const identity = binding.forward.get(absPath) as string | undefined
        if (identity) mapKey = identity
      }
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
      "applyChangeToYjs: ReplaceChange at root path is not supported",
    )
  }

  // Target the parent container, using the last segment to identify
  // which child to replace.
  const lastSeg = path.segments.at(-1)
  if (!lastSeg) throw new Error("replaceChangeToDiff: empty path")
  const parentPath = path.slice(0, -1)
  const { resolved: parent } = resolveYjsType(rootMap, rootSchema, parentPath, binding)

  const resolved = lastSeg.resolve()
  if (parent instanceof Y.Map && lastSeg.role === "key") {
    // Resolve schema for the target field for structured value detection
    const targetSchema = resolveSchemaAtPath(rootSchema, path)
    const yjsValue = maybeCreateSharedType(change.value, targetSchema)
    // Use identity hash for product-field boundaries.
    let mapKey = resolved as string
    if (binding) {
      const absPath = path.segments
        .filter(s => s.role === "key")
        .map(s => s.resolve() as string)
        .join(".")
      const identity = binding.forward.get(absPath) as string | undefined
      if (identity) mapKey = identity
    }
    parent.set(mapKey, yjsValue)
  } else if (parent instanceof Y.Array && lastSeg.role === "index") {
    const targetSchema = resolveSchemaAtPath(rootSchema, path)
    const yjsValue = maybeCreateSharedType(change.value, targetSchema)
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
// Structured value creation (populate-then-attach pattern)
// ---------------------------------------------------------------------------

/**
 * If the schema says the value should be a shared type (product → Y.Map,
 * sequence → Y.Array, text → Y.Text, richtext → Y.Text), create and
 * populate it. Otherwise return the plain value as-is.
 *
 * Uses populate-then-attach: the new shared type is fully populated
 * before being returned for insertion into its parent.
 */
function maybeCreateSharedType(
  value: unknown,
  schema: SchemaNode | undefined,
): unknown {
  if (schema === undefined) return value

  switch (schema[KIND]) {
    // First-class text → Y.Text
    case "text": {
      const text = new Y.Text()
      if (typeof value === "string" && value.length > 0) {
        text.insert(0, value)
      }
      return text
    }

    // Rich text → Y.Text (Yjs uses Y.Text for both plain and rich text)
    case "richtext": {
      const text = new Y.Text()
      if (typeof value === "string" && value.length > 0) {
        text.insert(0, value)
      } else if (Array.isArray(value)) {
        // RichTextDelta: array of { text, marks? } spans → Yjs delta
        const delta = (value as Array<{ text: string; marks?: Record<string, unknown> }>).map(
          span => {
            const d: any = { insert: span.text }
            if (span.marks && Object.keys(span.marks).length > 0) {
              d.attributes = span.marks
            }
            return d
          },
        )
        if (delta.length > 0) {
          text.applyDelta(delta)
        }
      }
      return text
    }

    case "product": {
      if (
        value === null ||
        value === undefined ||
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        return value
      }
      return createStructuredMap(value as Record<string, unknown>, schema)
    }

    case "sequence": {
      if (!Array.isArray(value)) return value
      const arr = new Y.Array()
      const itemSchema = schema.item
      const items = (value as unknown[]).map(item =>
        maybeCreateSharedType(item, itemSchema),
      )
      arr.insert(0, items)
      return arr
    }

    case "map": {
      if (
        value === null ||
        value === undefined ||
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        return value
      }
      const map = new Y.Map()
      const valueSchema = schema.item
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        map.set(k, maybeCreateSharedType(v, valueSchema))
      }
      return map
    }

    // Unsupported first-class CRDT types — should not reach here
    // (rejected at bind time by caps check)
    case "counter":
    case "set":
    case "tree":
    case "movable":
      throw new Error(
        `Yjs substrate does not support [KIND]="${schema[KIND]}". ` +
          `This should have been caught at bind() time.`,
      )

    default:
      // Scalar, sum — return as plain value
      return value
  }
}

/**
 * Create a Y.Map from a plain object, recursively creating nested
 * shared types as guided by the product schema.
 *
 * Follows populate-then-attach: fully populates the map before the
 * caller inserts it into a parent container.
 */
function createStructuredMap(
  obj: Record<string, unknown>,
  productSchema: SchemaNode,
): Y.Map<any> {
  const map = new Y.Map()

  if (productSchema[KIND] !== "product") {
    // Fallback: set all values as plain
    for (const [key, val] of Object.entries(obj)) {
      map.set(key, val)
    }
    return map
  }

  // Process fields present in the value object
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue
    const fieldSchema = productSchema.fields[key]
    const yjsVal = fieldSchema ? maybeCreateSharedType(val, fieldSchema) : val
    map.set(key, yjsVal)
  }

  // Create shared types for first-class CRDT fields declared in the schema
  // but missing from the value object. This ensures Yjs containers
  // exist for later mutation (e.g. .insert() on a text field inside
  // a struct inside a record/list).
  for (const [key, fieldSchema] of Object.entries(
    productSchema.fields as Record<string, SchemaNode>,
  )) {
    if (key in obj) continue // already processed above
    if (fieldSchema[KIND] === "text" || fieldSchema[KIND] === "richtext") {
      map.set(key, new Y.Text())
    }
  }

  return map
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
    const kynetaPath = yjsPathToKynetaPath(event.path, binding)
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
 * Convert a Yjs event path (array of string | number) to a kyneta Path.
 *
 * `event.path` from `observeDeep` is relative to the observed type.
 * Strings become key segments, numbers become index segments.
 */
function yjsPathToKynetaPath(
  yjsPath: (string | number)[],
  binding?: SchemaBinding,
): RawPath {
  let path = RawPath.empty
  for (const segment of yjsPath) {
    if (typeof segment === "string") {
      // Reverse-map identity hash → absolute schema path → leaf field name.
      // Yjs events emit identity-keyed strings at product-field positions;
      // we need to recover the original field name for kyneta schema paths.
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
    const schemaAtPath = resolveSchemaAtPath(rootSchema, kynetaPath)
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
 * Resolve the schema at a given path by walking through advanceSchema.
 */
function resolveSchemaAtPath(rootSchema: SchemaNode, path: Path): SchemaNode {
  let schema = rootSchema
  for (const seg of path.segments) {
    schema = advanceSchema(schema, seg)
  }
  return schema
}

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