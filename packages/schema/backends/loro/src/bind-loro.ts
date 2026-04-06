// bind-loro — Loro CRDT substrate namespace and factory internals.
//
// The `loro` namespace provides `loro.bind()` and `loro.replica()` for
// binding schemas to the Loro substrate with concurrent merge strategy.
// The factory builder accepts { peerId } and returns a SubstrateFactory
// that calls doc.setPeerId() on every new LoroDoc, ensuring deterministic
// peer identity across all documents in an exchange.
//
// Usage:
//   import { loro, LoroSchema } from "@kyneta/loro-schema"
//
//   const TodoDoc = loro.bind(LoroSchema.doc({
//     title: LoroSchema.text(),
//     items: LoroSchema.list(LoroSchema.plain.struct({ name: LoroSchema.plain.string() })),
//   }))
//
//   const doc = exchange.get("my-doc", TodoDoc)

import type {
  CrdtStrategy,
  Replica,
  Schema as SchemaNode,
  Substrate,
  SubstrateFactory,
  SubstrateNamespace,
  SubstratePayload,
} from "@kyneta/schema"
import { BACKING_DOC, createSubstrateNamespace, unwrap } from "@kyneta/schema"
import type { LoroDoc as LoroDocType, PeerID } from "loro-crdt"
import { LoroDoc } from "loro-crdt"
import {
  createLoroReplica,
  createLoroSubstrate,
  ensureLoroContainers,
  loroReplicaFactory,
} from "./substrate.js"
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
function createLoroFactory(peerId: string): SubstrateFactory<LoroVersion> {
  const numericPeerId = hashPeerId(peerId)

  return {
    replica: loroReplicaFactory,

    createReplica(): Replica<LoroVersion> {
      // Default random PeerID — safe for hydration (no local writes).
      // Identity is set at upgrade() time, after hydration.
      return createLoroReplica(new LoroDoc())
    },

    upgrade(
      replica: Replica<LoroVersion>,
      schema: SchemaNode,
    ): Substrate<LoroVersion> {
      const doc = (replica as any)[BACKING_DOC] as LoroDocType
      // Set stable identity AFTER hydration — avoids any PeerID
      // conflict with operations in hydrated state.
      doc.setPeerId(numericPeerId)
      // Conditional ensureRootContainer: container-type getXxx() calls
      // are idempotent in Loro, but scalar propsMap.set() produces ops.
      // Skip scalar defaults for keys already present from hydration.
      ensureLoroContainers(doc, schema, true)
      doc.commit()
      return createLoroSubstrate(doc, schema)
    },

    create(schema: SchemaNode): Substrate<LoroVersion> {
      // Fresh doc — set identity immediately, unconditional containers.
      const doc = new LoroDoc()
      doc.setPeerId(numericPeerId)
      ensureLoroContainers(doc, schema, false)
      doc.commit()
      return createLoroSubstrate(doc, schema)
    },

    fromEntirety(
      payload: SubstratePayload,
      schema: SchemaNode,
    ): Substrate<LoroVersion> {
      // Two-phase path: createReplica → merge → upgrade
      // Identity is set at upgrade() time, after hydration —
      // avoids any PeerID conflict with operations in hydrated state.
      const replica = this.createReplica()
      replica.merge(payload)
      return this.upgrade(replica, schema)
    },

    parseVersion(serialized: string): LoroVersion {
      return LoroVersion.parse(serialized)
    },
  }
}

// ---------------------------------------------------------------------------
// loro — the Loro CRDT substrate namespace
// ---------------------------------------------------------------------------

/**
 * The Loro CRDT substrate namespace.
 *
 * - `loro.bind(schema)` — concurrent sync (default)
 * - `loro.bind(schema, "ephemeral")` — ephemeral/presence broadcast
 * - `loro.replica()` — concurrent replication (default)
 * - `loro.replica("ephemeral")` — ephemeral replication
 * - `loro.unwrap(ref)` — access the underlying LoroDoc
 *
 * Strategy is constrained to `CrdtStrategy` (`"concurrent" | "ephemeral"`).
 * Passing `"sequential"` is a compile error.
 */
export const loro: SubstrateNamespace<CrdtStrategy> & {
  /** Access the underlying `LoroDoc` backing a ref. */
  unwrap(ref: object): LoroDoc
} = {
  ...createSubstrateNamespace<CrdtStrategy>({
    strategies: {
      concurrent: {
        factory: ctx => createLoroFactory(ctx.peerId),
        replicaFactory: loroReplicaFactory,
      },
      ephemeral: {
        factory: ctx => createLoroFactory(ctx.peerId),
        replicaFactory: loroReplicaFactory,
      },
    },
    defaultStrategy: "concurrent",
  }),

  unwrap(ref: object): LoroDoc {
    let substrate: any
    try {
      substrate = unwrap(ref)
    } catch {
      throw new Error(
        "loro.unwrap() requires a ref backed by a Loro substrate. " +
          "Use a doc created by exchange.get() with a loro.bind() schema, " +
          "or by createLoroDoc().",
      )
    }

    const doc = substrate[BACKING_DOC]
    if (
      !doc ||
      typeof doc !== "object" ||
      typeof (doc as any).toJSON !== "function" ||
      typeof (doc as any).version !== "function" ||
      typeof (doc as any).import !== "function"
    ) {
      throw new Error(
        "loro.unwrap() requires a ref backed by a Loro substrate. " +
          "The ref has a substrate but it is not a Loro substrate. " +
          "Use a doc created with a loro.bind() schema or createLoroDoc().",
      )
    }
    return doc as LoroDoc
  },
}
