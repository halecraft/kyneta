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
import { KIND, STRUCTURAL_YJS_CLIENT_ID, Zero } from "@kyneta/schema"
import * as Y from "yjs"

// ---------------------------------------------------------------------------
// ensureContainers — top-level entry point
// ---------------------------------------------------------------------------

/**
 * Ensure that a Y.Doc's root map contains the correct Yjs shared types
 * matching the schema structure.
 *
 * Obtains the root map via `doc.getMap("root")`, reads the root product
 * schema's fields, and creates empty containers for each field within a
 * single `doc.transact()` call for atomicity.
 *
 * When `conditional` is true, fields that already exist in the root map
 * are skipped. This is the correct mode after hydration — containers
 * present from stored state must not be overwritten (each `rootMap.set()`
 * is a CRDT write that advances the version vector and may conflict
 * with stored operations).
 *
 * When `conditional` is false (default), all fields are created
 * unconditionally. This is the correct mode for fresh documents.
 *
 * **Structural identity:** This function temporarily sets `doc.clientID`
 * to `STRUCTURAL_YJS_CLIENT_ID` (0) for the duration of container creation,
 * then restores the caller's clientID. This produces byte-identical
 * structural ops across all peers, enabling Yjs deduplication on merge.
 *
 * @param doc - The Y.Doc to prepare
 * @param schema - The root document schema (a ProductSchema)
 * @param conditional - If true, skip fields that already exist in the root map.
 *   Context: jj:smmulzkm (two-phase substrate construction)
 */
export function ensureContainers(
  doc: Y.Doc,
  schema: SchemaNode,
  conditional = false,
): void {
  const rootMap = doc.getMap("root")

  if (schema[KIND] !== "product") {
    return
  }

  // Switch to structural identity for deterministic container creation.
  // All peers produce byte-identical structural ops at clientID 0.
  const savedClientID = doc.clientID
  doc.clientID = STRUCTURAL_YJS_CLIENT_ID

  try {
    doc.transact(() => {
      for (const [key, fieldSchema] of Object.entries(schema.fields).sort(
        ([a], [b]) => a.localeCompare(b),
      )) {
        if (conditional && rootMap.has(key)) continue
        ensureRootField(rootMap, key, fieldSchema as SchemaNode)
      }
    })
  } finally {
    // Restore the caller's identity for application writes.
    doc.clientID = savedClientID
  }
}

// ---------------------------------------------------------------------------
// ensureRootField — create a single root-level container
// ---------------------------------------------------------------------------

/**
 * Ensure a root-level Yjs shared type exists for a schema field.
 *
 * Dispatches on `[KIND]`:
 * - `"text"` → empty Y.Text
 * - `"product"` → empty Y.Map (recursive for nested products)
 * - `"sequence"` → empty Y.Array
 * - `"map"` → empty Y.Map
 * - `"scalar"` / `"sum"` → Zero.structural default
 * - `"counter"` / `"set"` / `"tree"` / `"movable"` → throw (not supported by Yjs)
 */
function ensureRootField(
  rootMap: Y.Map<unknown>,
  key: string,
  fieldSchema: SchemaNode,
): void {
  switch (fieldSchema[KIND]) {
    case "text":
      rootMap.set(key, new Y.Text())
      return

    case "product":
      rootMap.set(key, ensureMapContainers(fieldSchema))
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

    case "counter":
    case "set":
    case "tree":
    case "movable":
      throw new Error(
        `Yjs substrate does not support [KIND]="${fieldSchema[KIND]}". ` +
          `Supported kinds: text, product, sequence, map, scalar, sum. ` +
          `Encountered unsupported kind at root field "${key}".`,
      )
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
 * Scalar and sum fields are set to their structural zero defaults.
 */
function ensureMapContainers(schema: SchemaNode): Y.Map<unknown> {
  const map = new Y.Map()

  if (schema[KIND] !== "product") return map

  for (const [key, fieldSchema] of Object.entries(
    schema.fields as Record<string, SchemaNode>,
  ).sort(([a], [b]) => a.localeCompare(b))) {
    switch (fieldSchema[KIND]) {
      case "text":
        map.set(key, new Y.Text())
        break

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

      case "counter":
      case "set":
      case "tree":
      case "movable":
        throw new Error(
          `Yjs substrate does not support [KIND]="${fieldSchema[KIND]}". ` +
            `Supported kinds: text, product, sequence, map, scalar, sum. ` +
            `Encountered unsupported kind at nested field "${key}".`,
        )
    }
  }

  return map
}