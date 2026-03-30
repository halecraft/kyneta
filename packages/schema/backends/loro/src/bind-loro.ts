// bind-loro — bindLoro() convenience wrapper for Loro CRDT substrate.
//
// Binds a schema to the Loro substrate with causal merge strategy.
// The factory builder accepts { peerId } and returns a SubstrateFactory
// that calls doc.setPeerId() on every new LoroDoc, ensuring deterministic
// peer identity across all documents in an exchange.
//
// Usage:
//   import { bindLoro } from "@kyneta/loro-schema"
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
import type { Substrate, SubstrateFactory, SubstratePayload, ReplicaFactory } from "@kyneta/schema"
import { LoroDoc } from "loro-crdt"
import type { PeerID } from "loro-crdt"
import { createLoroSubstrate, ensureRootContainer, loroReplicaFactory } from "./substrate.js"
import { LoroVersion } from "./version.js"

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

  return {
    replica: loroReplicaFactory,

    create(schema: SchemaNode): Substrate<LoroVersion> {
      const doc = new LoroDoc()
      doc.setPeerId(numericPeerId)

      // Ensure root containers exist (lazy creation). No seed data —
      // initial content should be applied via change() after construction.
      let rootProduct = schema
      while (
        rootProduct._kind === "annotated" &&
        rootProduct.schema !== undefined
      ) {
        rootProduct = rootProduct.schema
      }

      if (rootProduct._kind === "product") {
        for (const [key, fieldSchema] of Object.entries(rootProduct.fields)) {
          ensureRootContainer(doc, key, fieldSchema as SchemaNode)
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
 * import { bindLoro } from "@kyneta/loro-schema"
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