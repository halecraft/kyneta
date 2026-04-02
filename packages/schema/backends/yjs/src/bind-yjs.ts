// bind-yjs — bindYjs() convenience wrapper for Yjs CRDT substrate.
//
// Binds a schema to the Yjs substrate with causal merge strategy.
// The factory builder accepts { peerId } and returns a SubstrateFactory
// that sets doc.clientID on every new Y.Doc, ensuring deterministic
// peer identity across all documents in an exchange.
//
// Yjs clientID is a uint32 number. We use FNV-1a hash truncated to
// 32 bits, mirroring the Loro binding's hashPeerId pattern but
// targeting Yjs's number type (not Loro's bigint/53-bit PeerID).
//
// Usage:
//   import { bindYjs } from "@kyneta/yjs-schema"
//
//   const TodoDoc = bindYjs(Schema.doc({
//     title: Schema.annotated("text"),
//     items: Schema.list(Schema.struct({ name: Schema.string() })),
//   }))
//
//   const doc = exchange.get("my-doc", TodoDoc)

import type {
  BoundSchema,
  Replica,
  Schema as SchemaNode,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
} from "@kyneta/schema"
import { BACKING_DOC, bind } from "@kyneta/schema"
import * as Y from "yjs"
import { ensureContainers } from "./populate.js"
import { createYjsReplica, createYjsSubstrate, yjsReplicaFactory } from "./substrate.js"
import { YjsVersion } from "./version.js"

// ---------------------------------------------------------------------------
// Peer ID hashing — deterministic string → numeric Yjs clientID
// ---------------------------------------------------------------------------

/**
 * Hash a string peerId to a deterministic numeric Yjs clientID.
 *
 * Yjs clientIDs are unsigned 32-bit integers. We use FNV-1a hash to
 * produce a deterministic uint32 from the string peerId.
 *
 * The hash is deterministic: the same string always produces the same
 * numeric clientID, across restarts and across machines.
 */
function hashPeerId(peerId: string): number {
  // FNV-1a 32-bit hash
  let hash = 0x811c9dc5
  for (let i = 0; i < peerId.length; i++) {
    hash ^= peerId.charCodeAt(i)
    // Multiply by FNV prime 0x01000193.
    // Use Math.imul for correct 32-bit integer multiplication.
    hash = Math.imul(hash, 0x01000193)
  }
  // Ensure unsigned 32-bit integer
  return hash >>> 0
}

// ---------------------------------------------------------------------------
// createYjsFactory — factory builder with peer identity injection
// ---------------------------------------------------------------------------

/**
 * Create a SubstrateFactory<YjsVersion> that sets doc.clientID
 * on every new Y.Doc with a deterministic uint32 clientID derived
 * from the exchange's string peerId.
 */
function createYjsFactory(peerId: string): SubstrateFactory<YjsVersion> {
  const numericClientId = hashPeerId(peerId)

  return {
    replica: yjsReplicaFactory,

    createReplica(): Replica<YjsVersion> {
      // Default random clientID — safe for hydration (no local writes).
      // Identity is set at upgrade() time, after hydration.
      return createYjsReplica(new Y.Doc())
    },

    upgrade(replica: Replica<YjsVersion>, schema: SchemaNode): Substrate<YjsVersion> {
      const doc = (replica as any)[BACKING_DOC] as Y.Doc
      // Set stable identity AFTER hydration — avoids Yjs clientID
      // conflict detection that would reassign to a random value.
      doc.clientID = numericClientId
      // Conditional ensureContainers: skip fields that already exist
      // from hydrated state (each set() is a CRDT write).
      ensureContainers(doc, schema, true)
      return createYjsSubstrate(doc, schema)
    },

    create(schema: SchemaNode): Substrate<YjsVersion> {
      // Fresh doc — set identity immediately, unconditional containers.
      const doc = new Y.Doc()
      doc.clientID = numericClientId
      ensureContainers(doc, schema)
      return createYjsSubstrate(doc, schema)
    },

    fromEntirety(
      payload: SubstratePayload,
      schema: SchemaNode,
    ): Substrate<YjsVersion> {
      // Two-phase path: createReplica → merge → upgrade
      // Identity is set at upgrade() time, after hydration —
      // avoids Yjs clientID conflict detection.
      const replica = this.createReplica()
      replica.merge(payload)
      return this.upgrade(replica, schema)
    },

    parseVersion(serialized: string): YjsVersion {
      return YjsVersion.parse(serialized)
    },
  }
}

// ---------------------------------------------------------------------------
// bindYjs — the convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Bind a schema to the Yjs CRDT substrate with causal merge strategy.
 *
 * This is the recommended way to declare a Yjs-backed document type.
 * The factory builder injects a deterministic numeric Yjs clientID derived
 * from the exchange's string peerId, ensuring consistent change attribution
 * across all documents and sessions.
 *
 * **Unsupported annotations:** Yjs has no native counter, movable list,
 * or tree types. Schemas passed to `bindYjs` must not contain
 * `Schema.annotated("counter")`, `Schema.annotated("movable")`, or
 * `Schema.annotated("tree")`. These will throw at construction time.
 *
 * @example
 * ```ts
 * import { bindYjs } from "@kyneta/yjs-schema"
 * import { Schema } from "@kyneta/schema"
 *
 * const TodoDoc = bindYjs(Schema.doc({
 *   title: Schema.annotated("text"),
 *   items: Schema.list(Schema.struct({
 *     name: Schema.string(),
 *     done: Schema.boolean(),
 *   })),
 * }))
 *
 * const doc = exchange.get("my-todos", TodoDoc)
 * ```
 */
export function bindYjs<S extends SchemaNode>(schema: S): BoundSchema<S> {
  return bind({
    schema,
    factory: ctx => createYjsFactory(ctx.peerId),
    strategy: "causal",
  })
}
