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
  Schema as SchemaNode,
  SequenceChange,
  SequenceInstruction,
  TextChange,
  TextInstruction,
} from "@kyneta/schema"
import { advanceSchema, expandMapOpsToLeaves, KIND, RawPath } from "@kyneta/schema"
import * as Y from "yjs"
import { YJS_SUPPORTED_TAGS } from "./populate.js"
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
): void {
  switch (change.type) {
    case "text":
      applyTextChange(rootMap, rootSchema, path, change as TextChange)
      return

    case "sequence":
      applySequenceChange(rootMap, rootSchema, path, change as SequenceChange)
      return

    case "map":
      applyMapChange(rootMap, rootSchema, path, change as MapChange)
      return

    case "replace":
      applyReplaceChange(rootMap, rootSchema, path, change as ReplaceChange)
      return

    case "increment":
      throw new Error(
        `Yjs substrate does not support annotation required for "${change.type}" changes. ` +
          `Supported annotations: ${[...YJS_SUPPORTED_TAGS].join(", ")}. ` +
          `Attempted IncrementChange with amount=${(change as IncrementChange).amount} at path [${pathToString(path)}].`,
      )

    case "tree":
      throw new Error(
        `Yjs substrate does not support annotation required for "${change.type}" changes. ` +
          `Supported annotations: ${[...YJS_SUPPORTED_TAGS].join(", ")}. ` +
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
): void {
  const resolved = resolveYjsType(rootMap, rootSchema, path)
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
// Sequence change
// ---------------------------------------------------------------------------

function applySequenceChange(
  rootMap: Y.Map<any>,
  rootSchema: SchemaNode,
  path: Path,
  change: SequenceChange,
): void {
  const resolved = resolveYjsType(rootMap, rootSchema, path)
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
): void {
  const resolved = resolveYjsType(rootMap, rootSchema, path)
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
      resolved.set(key, yjsValue)
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
): void {
  if (path.length === 0) {
    throw new Error(
      "applyChangeToYjs: ReplaceChange at root path is not supported",
    )
  }

  // Target the parent container, using the last segment to identify
  // which child to replace.
  const lastSeg = path.segments[path.segments.length - 1]!
  const parentPath = path.slice(0, -1)
  const parent = resolveYjsType(rootMap, rootSchema, parentPath)

  const resolved = lastSeg.resolve()
  if (parent instanceof Y.Map && lastSeg.role === "key") {
    // Resolve schema for the target field for structured value detection
    const targetSchema = resolveSchemaAtPath(rootSchema, path)
    const yjsValue = maybeCreateSharedType(change.value, targetSchema)
    parent.set(resolved as string, yjsValue)
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
 * sequence → Y.Array, text → Y.Text), create and populate it.
 * Otherwise return the plain value as-is.
 *
 * Uses populate-then-attach: the new shared type is fully populated
 * before being returned for insertion into its parent.
 */
function maybeCreateSharedType(
  value: unknown,
  schema: SchemaNode | undefined,
): unknown {
  if (schema === undefined) return value

  const structural = unwrapAnnotations(schema)
  const tag = schema[KIND] === "annotated" ? schema.tag : undefined

  // Annotated text → Y.Text
  if (tag === "text") {
    const text = new Y.Text()
    if (typeof value === "string" && value.length > 0) {
      text.insert(0, value)
    }
    return text
  }

  // Unsupported annotation → should not reach here (thrown earlier or caught at bind time)
  if (tag !== undefined && !YJS_SUPPORTED_TAGS.has(tag)) {
    throw new Error(
      `Yjs substrate does not support annotation "${tag}". ` +
        `Supported annotations: ${[...YJS_SUPPORTED_TAGS].join(", ")}.`,
    )
  }

  switch (structural[KIND]) {
    case "product": {
      if (
        value === null ||
        value === undefined ||
        typeof value !== "object" ||
        Array.isArray(value)
      ) {
        return value
      }
      return createStructuredMap(value as Record<string, unknown>, structural)
    }

    case "sequence": {
      if (!Array.isArray(value)) return value
      const arr = new Y.Array()
      const itemSchema = structural.item
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
      const valueSchema = structural.item
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        map.set(k, maybeCreateSharedType(v, valueSchema))
      }
      return map
    }

    default:
      // Scalar, sum, or other — return as plain value
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
  const structural = unwrapAnnotations(productSchema)

  if (structural[KIND] !== "product") {
    // Fallback: set all values as plain
    for (const [key, val] of Object.entries(obj)) {
      map.set(key, val)
    }
    return map
  }

  // Process fields present in the value object
  for (const [key, val] of Object.entries(obj)) {
    if (val === undefined) continue
    const fieldSchema = structural.fields[key]
    const yjsVal = fieldSchema ? maybeCreateSharedType(val, fieldSchema) : val
    map.set(key, yjsVal)
  }

  // Create shared types for annotated fields declared in the schema
  // but missing from the value object. This ensures Yjs containers
  // exist for later mutation (e.g. .insert() on a text field inside
  // a struct inside a record/list).
  for (const [key, fieldSchema] of Object.entries(
    structural.fields as Record<string, SchemaNode>,
  )) {
    if (key in obj) continue // already processed above
    const tag = fieldSchema[KIND] === "annotated" ? fieldSchema.tag : undefined
    if (tag === "text") {
      map.set(key, new Y.Text())
    } else if (tag !== undefined && !YJS_SUPPORTED_TAGS.has(tag)) {
      throw new Error(
        `Yjs substrate does not support annotation "${tag}". ` +
          `Supported annotations: ${[...YJS_SUPPORTED_TAGS].join(", ")}.`,
      )
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
export function eventsToOps(events: Y.YEvent<any>[], schema: SchemaNode): Op[] {
  const ops: Op[] = []

  for (const event of events) {
    const kynetaPath = yjsPathToKynetaPath(event.path)
    const change = eventToChange(event)
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
function yjsPathToKynetaPath(yjsPath: (string | number)[]): RawPath {
  let path = RawPath.empty
  for (const segment of yjsPath) {
    if (typeof segment === "string") {
      path = path.field(segment)
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
 * Returns null for event types we can't map.
 */
function eventToChange(event: Y.YEvent<any>): ChangeBase | null {
  if (event.target instanceof Y.Text) {
    return textEventToChange(event)
  }
  if (event.target instanceof Y.Array) {
    return arrayEventToChange(event)
  }
  if (event.target instanceof Y.Map) {
    return mapEventToChange(event)
  }
  return null
}

/**
 * Y.Text event → TextChange.
 *
 * `event.delta` uses the Quill Delta format, structurally identical to
 * kyneta `TextInstruction[]`. We strip the `attributes` field (rich text
 * formatting not surfaced by kyneta).
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
function mapEventToChange(event: Y.YEvent<any>): MapChange | null {
  const set: Record<string, unknown> = {}
  const deleteKeys: string[] = []
  let hasSet = false
  let hasDelete = false

  const target = event.target as Y.Map<any>

  event.changes.keys.forEach((change: { action: string }, key: string) => {
    if (change.action === "add" || change.action === "update") {
      const value = target.get(key)
      set[key] = extractEventValue(value)
      hasSet = true
    } else if (change.action === "delete") {
      deleteKeys.push(key)
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
 * Unwrap annotation wrappers to reach the structural schema node.
 */
function unwrapAnnotations(schema: SchemaNode): SchemaNode {
  let s = schema
  while (s[KIND] === "annotated" && s.schema !== undefined) {
    s = s.schema
  }
  return s
}

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
  const structural = unwrapAnnotations(schema)
  return structural[KIND] === "sequence" ? structural.item : undefined
}

/**
 * Get the field schema from a product or map schema for a given key.
 */
function getFieldSchema(
  schema: SchemaNode,
  key: string,
): SchemaNode | undefined {
  const structural = unwrapAnnotations(schema)
  if (structural[KIND] === "product") {
    return structural.fields[key]
  }
  if (structural[KIND] === "map") {
    return structural.item
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Path formatting
// ---------------------------------------------------------------------------

function pathToString(path: Path): string {
  return path.segments.map(seg => String(seg.resolve())).join(".")
}
