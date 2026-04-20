// bind-yjs — Yjs CRDT binding target and factory internals.
//
// The `yjs` binding target provides `yjs.bind()` and `yjs.replica()` for
// binding schemas to the Yjs substrate with collaborative sync protocol.
// The factory builder accepts { peerId } and returns a SubstrateFactory
// that calls doc.clientID = hashPeerId(peerId) on every new Y.Doc,
// ensuring deterministic peer identity across all documents in an exchange.
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
  BindingTarget,
  Replica,
  SchemaBinding,
  Schema as SchemaNode,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
} from "@kyneta/schema"
import {
  BACKING_DOC,
  createBindingTarget,
  STRUCTURAL_YJS_CLIENT_ID,
  SYNC_COLLABORATIVE,
} from "@kyneta/schema"
import * as Y from "yjs"
import type { YjsNativeMap } from "./native-map.js"
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
function createYjsFactory(
  peerId: string,
  binding: SchemaBinding,
): SubstrateFactory<YjsVersion> {
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
      ensureContainers(doc, schema, true, binding)
      return createYjsSubstrate(doc, schema, binding)
    },

    create(schema: SchemaNode): Substrate<YjsVersion> {
      // Fresh doc — set identity immediately, unconditional containers.
      const doc = new Y.Doc()
      doc.clientID = numericClientId
      ensureContainers(doc, schema, false, binding)
      return createYjsSubstrate(doc, schema, binding)
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
// yjs — the Yjs CRDT binding target
// ---------------------------------------------------------------------------

/**
 * Yjs composition-law tags — the set of concurrent composition laws
 * that the Yjs substrate faithfully implements.
 */
export type YjsLaws =
  | "lww"
  | "positional-ot"
  | "lww-per-key"
  | "lww-tag-replaced"

/**
 * The Yjs CRDT binding target.
 *
 * - `yjs.bind(schema)` — bind a schema to Yjs with collaborative sync
 * - `yjs.replica()` — create a collaborative replica
 *
 * Laws are constrained to `YjsLaws` — schemas requiring composition laws
 * outside this set (e.g. `"additive"` from `Schema.counter()`,
 * `"positional-ot-move"` from `Schema.movableList()`) are rejected at
 * compile time.
 *
 * To access the underlying Y.Doc, use `unwrap(ref)` from `@kyneta/schema`.
 */
export const yjs: BindingTarget<YjsLaws, YjsNativeMap> = createBindingTarget<
  YjsLaws,
  YjsNativeMap
>({
  factory: ctx => createYjsFactory(ctx.peerId, ctx.binding),
  replicaFactory: yjsReplicaFactory,
  syncProtocol: SYNC_COLLABORATIVE,
})
