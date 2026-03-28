// bind-loro — bindLoro() convenience wrapper for Loro CRDT substrate.
//
// Binds a schema to the Loro substrate with causal merge strategy.
// The factory builder accepts { peerId } and returns a SubstrateFactory
// that calls doc.setPeerId() on every new LoroDoc, ensuring deterministic
// peer identity across all documents in an exchange.
//
// Usage:
//   import { bindLoro } from "@kyneta/schema-loro"
//
//   const TodoDoc = bindLoro(LoroSchema.doc({
//     title: LoroSchema.text(),
//     items: Schema.list(Schema.struct({ name: Schema.string() })),
//   }))
//
//   const doc = exchange.get("my-doc", TodoDoc)

import { bind } from "@kyneta/schema"
import type { BoundSchema } from "@kyneta/schema"
import type { Schema as SchemaNode } from "@kyneta/schema"
import type { Substrate, SubstrateFactory, SubstratePayload } from "@kyneta/schema"
import { LoroDoc } from "loro-crdt"
import type { PeerID } from "loro-crdt"
import { createLoroSubstrate } from "./substrate.js"
import { LoroVersion } from "./version.js"
import {
  Zero,
  type Schema as SchemaNodeType,
} from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Peer ID hashing — deterministic string → numeric Loro PeerID
// ---------------------------------------------------------------------------

/**
 * Hash a string peerId to a deterministic numeric Loro PeerID.
 *
 * Loro PeerIDs are bigints (represented as numeric strings). We use a
 * simple FNV-1a hash to produce a deterministic 53-bit integer from the
 * string peerId. 53 bits is the safe integer range for JavaScript numbers,
 * which Loro accepts via setPeerId().
 *
 * The hash is deterministic: the same string always produces the same
 * numeric PeerID, across restarts and across machines.
 */
function hashPeerId(peerId: string): PeerID {
  // FNV-1a 64-bit hash, truncated to 53 bits for safe JS integer range
  let hash = BigInt("0xcbf29ce484222325")
  const prime = BigInt("0x100000001b3")
  for (let i = 0; i < peerId.length; i++) {
    hash ^= BigInt(peerId.charCodeAt(i))
    hash = (hash * prime) & BigInt("0xFFFFFFFFFFFFFFFF")
  }
  // Truncate to 53 bits (Number.MAX_SAFE_INTEGER = 2^53 - 1)
  const truncated = hash & BigInt("0x1FFFFFFFFFFFFF")
  // Loro expects PeerID as a numeric string
  return truncated.toString() as PeerID
}

// ---------------------------------------------------------------------------
// createLoroFactory — factory builder with peer identity injection
// ---------------------------------------------------------------------------

/**
 * Create a SubstrateFactory<LoroVersion> that calls doc.setPeerId()
 * on every new LoroDoc with a deterministic numeric PeerID derived
 * from the exchange's string peerId.
 */
function createLoroFactory(
  peerId: string,
): SubstrateFactory<LoroVersion> {
  const numericPeerId = hashPeerId(peerId)

  // We build on top of the existing loroSubstrateFactory logic
  // but inject setPeerId before the doc is used.
  return {
    create(
      schema: SchemaNode,
      seed: Record<string, unknown> = {},
    ): Substrate<LoroVersion> {
      const doc = new LoroDoc()
      doc.setPeerId(numericPeerId)

      // Compute defaults and overlay seed
      const defaults = Zero.structural(schema) as Record<string, unknown>
      const initial = Zero.overlay(seed, defaults, schema) as Record<
        string,
        unknown
      >

      // Walk the schema to create root containers and populate.
      // Import the populate helper pattern from substrate.ts.
      let rootProduct = schema
      while (
        rootProduct._kind === "annotated" &&
        rootProduct.schema !== undefined
      ) {
        rootProduct = rootProduct.schema
      }

      if (rootProduct._kind === "product") {
        for (const [key, fieldSchema] of Object.entries(rootProduct.fields)) {
          const value = initial[key]
          populateRootField(doc, key, fieldSchema as SchemaNode, value)
        }
      }

      doc.commit()
      return createLoroSubstrate(doc, schema)
    },

    fromSnapshot(
      payload: SubstratePayload,
      schema: SchemaNode,
    ): Substrate<LoroVersion> {
      if (
        payload.encoding !== "binary" ||
        !(payload.data instanceof Uint8Array)
      ) {
        throw new Error(
          "LoroSubstrateFactory.fromSnapshot only supports binary-encoded payloads",
        )
      }
      const doc = new LoroDoc()
      doc.setPeerId(numericPeerId)
      doc.import(payload.data)
      return createLoroSubstrate(doc, schema)
    },

    parseVersion(serialized: string): LoroVersion {
      return LoroVersion.parse(serialized)
    },
  }
}

// ---------------------------------------------------------------------------
// Root field population helpers (mirrored from substrate.ts)
// ---------------------------------------------------------------------------

import { LoroMap, LoroList } from "loro-crdt"
import type { LoroDoc as LoroDocType } from "loro-crdt"

const PROPS_KEY = "_props"

function populateRootField(
  doc: LoroDocType,
  key: string,
  fieldSchema: SchemaNode,
  value: unknown,
): void {
  const tag = fieldSchema._kind === "annotated" ? fieldSchema.tag : undefined

  switch (tag) {
    case "text": {
      const text = doc.getText(key)
      if (typeof value === "string" && value.length > 0) {
        text.insert(0, value)
      }
      return
    }
    case "counter": {
      const counter = doc.getCounter(key)
      if (typeof value === "number" && value !== 0) {
        counter.increment(value)
      }
      return
    }
    case "movable": {
      const movList = doc.getMovableList(key)
      if (Array.isArray(value)) {
        populateList(movList as any, value, fieldSchema)
      }
      return
    }
    case "tree": {
      doc.getTree(key)
      return
    }
  }

  // Non-annotated structural types
  let structural = fieldSchema
  while (structural._kind === "annotated" && structural.schema !== undefined) {
    structural = structural.schema
  }

  switch (structural._kind) {
    case "product": {
      const map = doc.getMap(key)
      if (typeof value === "object" && value !== null) {
        populateMap(map as any, value as Record<string, unknown>, structural)
      }
      return
    }
    case "sequence": {
      const list = doc.getList(key)
      if (Array.isArray(value)) {
        populateList(list as any, value, fieldSchema)
      }
      return
    }
    case "map": {
      const map = doc.getMap(key)
      if (typeof value === "object" && value !== null) {
        for (const [k, v] of Object.entries(
          value as Record<string, unknown>,
        )) {
          map.set(k, v as any)
        }
      }
      return
    }
    case "scalar":
    case "sum": {
      const propsMap = doc.getMap(PROPS_KEY)
      if (value !== undefined) {
        propsMap.set(key, value as any)
      }
      return
    }
  }
}

function populateMap(
  map: any,
  value: Record<string, unknown>,
  schema: SchemaNode,
): void {
  let structural = schema
  while (structural._kind === "annotated" && structural.schema !== undefined) {
    structural = structural.schema
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    if (fieldValue === undefined) continue

    let fieldSchema: SchemaNode | undefined
    if (structural._kind === "product") {
      fieldSchema = structural.fields[key]
    }

    if (
      fieldSchema &&
      fieldValue !== null &&
      typeof fieldValue === "object" &&
      !Array.isArray(fieldValue)
    ) {
      let fs = fieldSchema
      while (fs._kind === "annotated" && fs.schema !== undefined) {
        fs = fs.schema
      }
      if (fs._kind === "product") {
        const childMap = map.setContainer(key, new LoroMap())
        populateMap(
          childMap,
          fieldValue as Record<string, unknown>,
          fieldSchema,
        )
        continue
      }
    }

    if (fieldSchema && Array.isArray(fieldValue)) {
      let fs = fieldSchema
      while (fs._kind === "annotated" && fs.schema !== undefined) {
        fs = fs.schema
      }
      if (fs._kind === "sequence") {
        const childList = map.setContainer(key, new LoroList())
        populateList(childList, fieldValue, fieldSchema)
        continue
      }
    }

    map.set(key, fieldValue as any)
  }
}

function populateList(list: any, value: unknown[], schema: SchemaNode): void {
  let seqSchema = schema
  while (seqSchema._kind === "annotated" && seqSchema.schema !== undefined) {
    seqSchema = seqSchema.schema
  }

  const itemSchema =
    seqSchema._kind === "sequence" ? seqSchema.item : undefined

  for (let i = 0; i < value.length; i++) {
    const item = value[i]

    if (
      itemSchema &&
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      let is = itemSchema
      while (is._kind === "annotated" && is.schema !== undefined) {
        is = is.schema
      }
      if (is._kind === "product") {
        const childMap = list.insertContainer(i, new LoroMap())
        populateMap(childMap, item as Record<string, unknown>, itemSchema)
        continue
      }
    }

    list.insert(i, item as any)
  }
}

// ---------------------------------------------------------------------------
// bindLoro — the convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Bind a schema to the Loro CRDT substrate with causal merge strategy.
 *
 * This is the recommended way to declare a Loro-backed document type.
 * The factory builder injects a deterministic numeric Loro PeerID derived
 * from the exchange's string peerId, ensuring consistent change attribution
 * across all documents and sessions.
 *
 * @example
 * ```ts
 * import { bindLoro } from "@kyneta/schema-loro"
 * import { LoroSchema, Schema } from "@kyneta/schema"
 *
 * const TodoDoc = bindLoro(LoroSchema.doc({
 *   title: LoroSchema.text(),
 *   items: Schema.list(Schema.struct({
 *     name: Schema.string(),
 *     done: Schema.boolean(),
 *   })),
 * }))
 *
 * const doc = exchange.get("my-todos", TodoDoc)
 * ```
 */
export function bindLoro<S extends SchemaNode>(schema: S): BoundSchema<S> {
  return bind({
    schema,
    factory: (ctx) => createLoroFactory(ctx.peerId),
    strategy: "causal",
  })
}