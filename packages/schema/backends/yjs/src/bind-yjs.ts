// bind-yjs — Yjs CRDT substrate namespace and factory.
//
// Provides the `yjs` substrate namespace (`yjs.bind()`, `yjs.replica()`,
// `yjs.unwrap()`) and the internal factory builder that injects a
// deterministic numeric Yjs clientID derived from the exchange's peerId.
//
// Yjs clientID is a uint32 number. We use FNV-1a hash truncated to
// 32 bits, mirroring the Loro binding's hashPeerId pattern but
// targeting Yjs's number type (not Loro's bigint/53-bit PeerID).
//
// Usage:
//   import { yjs } from "@kyneta/yjs-schema"
//
//   const TodoDoc = yjs.bind(Schema.struct({
//     title: Schema.text(),
//     items: Schema.list(Schema.struct({ name: Schema.string() })),
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
import {
  BACKING_DOC,
  createSubstrateNamespace,
  STRUCTURAL_YJS_CLIENT_ID,
  unwrap,
} from "@kyneta/schema"
import * as Y from "yjs"
import { ensureContainers } from "./populate.js"
import {
  createYjsReplica,
  createYjsSubstrate,
  yjsReplicaFactory,
} from "./substrate.js"
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
  const result = hash >>> 0
  // Reserve 0 for structural ops — real peers never collide
  return result === STRUCTURAL_YJS_CLIENT_ID ? 1 : result
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

    upgrade(
      replica: Replica<YjsVersion>,
      schema: SchemaNode,
    ): Substrate<YjsVersion> {
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
// yjs — the Yjs CRDT substrate namespace
// ---------------------------------------------------------------------------

/**
 * The Yjs CRDT substrate namespace.
 *
 * - `yjs.bind(schema)` — collaborative sync (default)
 * - `yjs.bind(schema, "ephemeral")` — ephemeral/presence broadcast
 * - `yjs.replica()` — collaborative replication (default)
 * - `yjs.replica("ephemeral")` — ephemeral replication
 * - `yjs.unwrap(ref)` — access the underlying Y.Doc
 *
 * Strategy is constrained to `CrdtStrategy` (`"collaborative" | "ephemeral"`).
 * Passing `"authoritative"` is a compile error.
 */
/** The closed set of capability tags that the Yjs substrate supports. */
export type YjsCaps = "text" | "json"

export const yjs: SubstrateNamespace<CrdtStrategy, YjsCaps> & {
  /** Access the underlying `Y.Doc` backing a ref. */
  unwrap(ref: object): Y.Doc
} = {
  ...createSubstrateNamespace<CrdtStrategy, YjsCaps>({
    strategies: {
      collaborative: {
        factory: ctx => createYjsFactory(ctx.peerId),
        replicaFactory: yjsReplicaFactory,
      },
      ephemeral: {
        factory: ctx => createYjsFactory(ctx.peerId),
        replicaFactory: yjsReplicaFactory,
      },
    },
    defaultStrategy: "collaborative",
  }),

  unwrap(ref: object): Y.Doc {
    let substrate: any
    try {
      substrate = unwrap(ref)
    } catch {
      throw new Error(
        "yjs.unwrap() requires a ref backed by a Yjs substrate. " +
          "Use a doc created by exchange.get() with a yjs.bind() schema, " +
          "or by createYjsDoc().",
      )
    }

    const doc = substrate[BACKING_DOC]
    if (
      !doc ||
      typeof doc !== "object" ||
      typeof (doc as any).getMap !== "function" ||
      typeof (doc as any).clientID !== "number"
    ) {
      throw new Error(
        "yjs.unwrap() requires a ref backed by a Yjs substrate. " +
          "The ref has a substrate but it is not a Yjs substrate. " +
          "Use a doc created with a yjs.bind() schema or createYjsDoc().",
      )
    }
    return doc as Y.Doc
  },
}
