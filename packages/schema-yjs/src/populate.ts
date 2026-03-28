// populate — shared root container population helpers for Yjs.
//
// Extracts `populateRoot` and recursive helpers into a dedicated module
// imported by both `substrate.ts` (for `yjsSubstrateFactory.create`) and
// `bind-yjs.ts` (for `createYjsFactory`). This avoids the duplication
// present in the Loro binding between `substrate.ts` and `bind-loro.ts`.
//
// Root container strategy: All schema fields are children of a single
// root `Y.Map` obtained via `doc.getMap("root")`. This root map holds
// shared types (Y.Text, Y.Array, Y.Map) and plain values uniformly.
//
// Population uses populate-then-attach order for consistency with runtime
// structured inserts, even though it doesn't matter during initial
// population (no observers are registered yet).

import type { Schema as SchemaNode } from "@kyneta/schema"
import { Zero } from "@kyneta/schema"
import * as Y from "yjs"

// ---------------------------------------------------------------------------
// populateRoot — top-level entry point
// ---------------------------------------------------------------------------

/**
 * Populate a Y.Doc's root map from a schema and initial values.
 *
 * Obtains the root map via `doc.getMap("root")`, unwraps the root product
 * schema, computes defaults via `Zero.structural`, overlays the seed, and
 * populates each field within a single `doc.transact()` call for atomicity.
 *
 * @param doc - The Y.Doc to populate
 * @param schema - The root document schema (typically annotated("doc", product))
 * @param seed - Optional partial initial values to overlay on defaults
 */
export function populateRoot(
  doc: Y.Doc,
  schema: SchemaNode,
  seed: Record<string, unknown> = {},
): void {
  const rootMap = doc.getMap("root")

  // Compute defaults and overlay seed
  const defaults = Zero.structural(schema) as Record<string, unknown>
  const initial = Zero.overlay(seed, defaults, schema) as Record<
    string,
    unknown
  >

  // Unwrap the root annotation (e.g. annotated("doc", product)) to get fields
  let rootProduct = schema
  while (
    rootProduct._kind === "annotated" &&
    rootProduct.schema !== undefined
  ) {
    rootProduct = rootProduct.schema
  }

  if (rootProduct._kind !== "product") {
    return
  }

  doc.transact(() => {
    for (const [key, fieldSchema] of Object.entries(rootProduct.fields)) {
      const value = initial[key]
      populateRootField(rootMap, key, fieldSchema as SchemaNode, value)
    }
  })
}

// ---------------------------------------------------------------------------
// populateRootField — create root container and populate with initial value
// ---------------------------------------------------------------------------

/**
 * Create a root-level container for a field and populate it with an
 * initial value from the seed/defaults.
 *
 * Dispatches based on the schema annotation tag and structural kind:
 * - `annotated("text")` → Y.Text child
 * - `annotated("counter")` → throws (unsupported)
 * - `annotated("movable")` → throws (unsupported)
 * - `annotated("tree")` → throws (unsupported)
 * - `product` → nested Y.Map child
 * - `sequence` → Y.Array child
 * - `map` → Y.Map child
 * - `scalar`/`sum` → plain value entry
 */
function populateRootField(
  rootMap: Y.Map<any>,
  key: string,
  fieldSchema: SchemaNode,
  value: unknown,
): void {
  const tag = fieldSchema._kind === "annotated" ? fieldSchema.tag : undefined

  switch (tag) {
    case "text": {
      const text = new Y.Text()
      if (typeof value === "string" && value.length > 0) {
        text.insert(0, value)
      }
      rootMap.set(key, text)
      return
    }

    case "counter":
      throw new Error(
        `Yjs substrate does not support counter annotations. ` +
          `Use Schema.number() with ReplaceChange instead. ` +
          `Encountered counter annotation at root field "${key}".`,
      )

    case "movable":
      throw new Error(
        `Yjs substrate does not support movable list annotations. ` +
          `Yjs has no native movable list type. ` +
          `Encountered movable annotation at root field "${key}".`,
      )

    case "tree":
      throw new Error(
        `Yjs substrate does not support tree annotations. ` +
          `Yjs has no native tree type. ` +
          `Encountered tree annotation at root field "${key}".`,
      )
  }

  // Non-annotated structural types
  const structural = unwrapAnnotations(fieldSchema)

  switch (structural._kind) {
    case "product": {
      const map = populateMap(
        typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {},
        structural,
      )
      rootMap.set(key, map)
      return
    }

    case "sequence": {
      const arr = populateArray(
        Array.isArray(value) ? value : [],
        fieldSchema,
      )
      rootMap.set(key, arr)
      return
    }

    case "map": {
      const map = new Y.Map()
      if (typeof value === "object" && value !== null && !Array.isArray(value)) {
        for (const [k, v] of Object.entries(
          value as Record<string, unknown>,
        )) {
          map.set(k, v)
        }
      }
      rootMap.set(key, map)
      return
    }

    case "scalar":
    case "sum": {
      // Non-container types: stored as plain values in the root map.
      if (value !== undefined) {
        rootMap.set(key, value)
      }
      return
    }
  }
}

// ---------------------------------------------------------------------------
// populateMap — recursively populate a Y.Map from a product schema
// ---------------------------------------------------------------------------

/**
 * Create and populate a Y.Map from a plain object, using the product
 * schema to determine which fields need shared type children.
 *
 * Follows populate-then-attach: the map is fully populated before
 * the caller inserts it into a parent container.
 */
function populateMap(
  value: Record<string, unknown>,
  schema: SchemaNode,
): Y.Map<any> {
  const map = new Y.Map()
  const structural = unwrapAnnotations(schema)

  for (const [key, fieldValue] of Object.entries(value)) {
    if (fieldValue === undefined) continue

    let fieldSchema: SchemaNode | undefined
    if (structural._kind === "product") {
      fieldSchema = structural.fields[key]
    }

    if (fieldSchema) {
      const tag =
        fieldSchema._kind === "annotated" ? fieldSchema.tag : undefined

      // Text annotation → Y.Text
      if (tag === "text") {
        const text = new Y.Text()
        if (typeof fieldValue === "string" && fieldValue.length > 0) {
          text.insert(0, fieldValue)
        }
        map.set(key, text)
        continue
      }

      const fs = unwrapAnnotations(fieldSchema)

      // Nested product → recursive Y.Map
      if (
        fs._kind === "product" &&
        fieldValue !== null &&
        typeof fieldValue === "object" &&
        !Array.isArray(fieldValue)
      ) {
        const childMap = populateMap(
          fieldValue as Record<string, unknown>,
          fieldSchema,
        )
        map.set(key, childMap)
        continue
      }

      // Nested sequence → Y.Array
      if (fs._kind === "sequence" && Array.isArray(fieldValue)) {
        const childArr = populateArray(fieldValue, fieldSchema)
        map.set(key, childArr)
        continue
      }

      // Nested map → Y.Map
      if (
        fs._kind === "map" &&
        fieldValue !== null &&
        typeof fieldValue === "object" &&
        !Array.isArray(fieldValue)
      ) {
        const childMap = new Y.Map()
        for (const [k, v] of Object.entries(
          fieldValue as Record<string, unknown>,
        )) {
          childMap.set(k, v)
        }
        map.set(key, childMap)
        continue
      }
    }

    // Plain value
    map.set(key, fieldValue)
  }

  return map
}

// ---------------------------------------------------------------------------
// populateArray — recursively populate a Y.Array from a sequence schema
// ---------------------------------------------------------------------------

/**
 * Create and populate a Y.Array from a plain array, using the sequence
 * schema to determine whether items need shared type children.
 *
 * Follows populate-then-attach: the array is fully populated before
 * the caller inserts it into a parent container.
 */
function populateArray(value: unknown[], schema: SchemaNode): Y.Array<any> {
  const arr = new Y.Array()

  let seqSchema = unwrapAnnotations(schema)
  const itemSchema =
    seqSchema._kind === "sequence" ? seqSchema.item : undefined

  for (let i = 0; i < value.length; i++) {
    const item = value[i]

    if (itemSchema) {
      const tag =
        itemSchema._kind === "annotated" ? itemSchema.tag : undefined

      // Text items
      if (tag === "text") {
        const text = new Y.Text()
        if (typeof item === "string" && item.length > 0) {
          text.insert(0, item)
        }
        arr.insert(i, [text])
        continue
      }

      const is = unwrapAnnotations(itemSchema)

      // Struct items → recursive Y.Map
      if (
        is._kind === "product" &&
        item !== null &&
        typeof item === "object" &&
        !Array.isArray(item)
      ) {
        const childMap = populateMap(
          item as Record<string, unknown>,
          itemSchema,
        )
        arr.insert(i, [childMap])
        continue
      }

      // Nested sequence items
      if (is._kind === "sequence" && Array.isArray(item)) {
        const childArr = populateArray(item, itemSchema)
        arr.insert(i, [childArr])
        continue
      }
    }

    // Plain value
    arr.insert(i, [item])
  }

  return arr
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Unwrap annotation wrappers to reach the structural schema node.
 */
function unwrapAnnotations(schema: SchemaNode): SchemaNode {
  let s = schema
  while (s._kind === "annotated" && s.schema !== undefined) {
    s = s.schema
  }
  return s
}