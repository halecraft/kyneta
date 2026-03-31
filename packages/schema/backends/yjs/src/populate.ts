// populate — Yjs container creation from schema structure.
//
// Ensures that the correct Yjs shared types (Y.Text, Y.Array, Y.Map)
// exist in a Y.Doc's root map to match the schema structure, and that
// scalar/sum fields are initialized with Zero.structural defaults.
//
// This is NOT seed data — it's structural completeness, matching what
// PlainSubstrate does when it initializes its store with Zero.structural.
// The Yjs store reader expects to find values at every schema path;
// without this, unset scalars would return undefined instead of their
// type-correct zero ("", 0, false).
//
// Root container strategy: All schema fields are children of a single
// root `Y.Map` obtained via `doc.getMap("root")`. This root map holds
// shared types (Y.Text, Y.Array, Y.Map) and plain value slots uniformly.

import type { Schema as SchemaNode } from "@kyneta/schema"
import { Zero } from "@kyneta/schema"
import * as Y from "yjs"

// ---------------------------------------------------------------------------
// ensureContainers — top-level entry point
// ---------------------------------------------------------------------------

/**
 * Ensure that a Y.Doc's root map contains the correct Yjs shared types
 * matching the schema structure.
 *
 * Obtains the root map via `doc.getMap("root")`, unwraps the root product
 * schema, and creates empty containers for each field within a single
 * `doc.transact()` call for atomicity.
 *
 * No values are written — the containers are empty after this call.
 * Initial content should be applied via `change()` after substrate
 * construction.
 *
 * @param doc - The Y.Doc to prepare
 * @param schema - The root document schema (typically annotated("doc", product))
 */
export function ensureContainers(doc: Y.Doc, schema: SchemaNode): void {
  const rootMap = doc.getMap("root")

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
      ensureRootField(rootMap, key, fieldSchema as SchemaNode)
    }
  })
}

// ---------------------------------------------------------------------------
// ensureRootField — create a single root-level container
// ---------------------------------------------------------------------------

/**
 * Ensure a root-level Yjs shared type exists for a schema field.
 *
 * Dispatches based on the schema annotation tag and structural kind:
 * - `annotated("text")` → empty Y.Text
 * - `annotated("counter")` → throws (unsupported in Yjs)
 * - `annotated("movable")` → throws (unsupported in Yjs)
 * - `annotated("tree")` → throws (unsupported in Yjs)
 * - `product` → empty Y.Map (recursive for nested products)
 * - `sequence` → empty Y.Array
 * - `map` → empty Y.Map
 * - `scalar`/`sum` → no-op (plain values don't need containers)
 */
function ensureRootField(
  rootMap: Y.Map<unknown>,
  key: string,
  fieldSchema: SchemaNode,
): void {
  const tag = fieldSchema._kind === "annotated" ? fieldSchema.tag : undefined

  switch (tag) {
    case "text":
      rootMap.set(key, new Y.Text())
      return

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

  const structural = unwrapAnnotations(fieldSchema)

  switch (structural._kind) {
    case "product":
      rootMap.set(key, ensureMapContainers(structural))
      return
    case "sequence":
      rootMap.set(key, new Y.Array())
      return
    case "map":
      rootMap.set(key, new Y.Map())
      return
    case "scalar":
    case "sum": {
      // Plain values don't need shared type containers, but they DO
      // need structural zero defaults so the store reader returns
      // type-correct values (e.g. "" not undefined for strings).
      const zero = Zero.structural(fieldSchema)
      if (zero !== undefined) {
        rootMap.set(key, zero)
      }
      return
    }
  }
}

// ---------------------------------------------------------------------------
// ensureMapContainers — recursively create nested Y.Map structure
// ---------------------------------------------------------------------------

/**
 * Create an empty Y.Map with nested shared type children matching
 * the product schema's field structure.
 *
 * Only creates containers for fields that require Yjs shared types
 * (text → Y.Text, product → Y.Map, sequence → Y.Array, map → Y.Map).
 * Scalar and sum fields are left empty — they'll be written as plain
 * values via change() when needed.
 */
function ensureMapContainers(schema: SchemaNode): Y.Map<unknown> {
  const map = new Y.Map()
  const structural = unwrapAnnotations(schema)

  if (structural._kind !== "product") return map

  for (const [key, fieldSchema] of Object.entries(
    structural.fields as Record<string, SchemaNode>,
  )) {
    const tag = fieldSchema._kind === "annotated" ? fieldSchema.tag : undefined

    if (tag === "text") {
      map.set(key, new Y.Text())
      continue
    }

    const fs = unwrapAnnotations(fieldSchema)

    switch (fs._kind) {
      case "product":
        map.set(key, ensureMapContainers(fieldSchema))
        break
      case "sequence":
        map.set(key, new Y.Array())
        break
      case "map":
        map.set(key, new Y.Map())
        break
      case "scalar":
      case "sum": {
        const zero = Zero.structural(fieldSchema)
        if (zero !== undefined) {
          map.set(key, zero)
        }
        break
      }
    }
  }

  return map
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
