// bind-loro — Loro CRDT binding target and factory internals.
//
// The `loro` binding target provides `loro.bind()` and `loro.replica()` for
// binding schemas to the Loro substrate with collaborative sync protocol.
// The factory builder accepts { peerId } and returns a SubstrateFactory that
// derives one deterministic PeerID from it via loroPeerId, so all of an
// exchange's documents speak as its seat, the peer id its Runtime issued.
// With a store, the store issues that seat, and it survives a restart over
// the same storage; without one, every Runtime is a new seat.
//
// Every construction path claims that PeerID; they differ only in *when*.
// A document that will first import its own stored history has to wait —
// see `createForHydration` below for what goes wrong otherwise.
//
// Usage:
//   import { loro, Schema } from "@kyneta/loro-schema"
//
//   const TodoDoc = loro.bind(Schema.struct({
//     title: Schema.text(),
//     items: Schema.list(Schema.struct.json({ name: Schema.string() })),
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
  hasBackingDoc,
  peerNumber,
  SYNC_COLLABORATIVE,
} from "@kyneta/schema"
import type { LoroDoc as LoroDocType, PeerID } from "loro-crdt"
import { LoroDoc } from "loro-crdt"
import type { LoroNativeMap } from "./native-map.js"
import {
  createLoroReplica,
  createLoroSubstrate,
  ensureLoroContainers,
  loroReplicaFactory,
} from "./substrate.js"
import { LoroVersion } from "./version.js"

// ---------------------------------------------------------------------------
// Peer id → Loro PeerID
// ---------------------------------------------------------------------------

/**
 * The Loro `PeerID` a peer id writes under: its 64-bit `peerNumber`, as the
 * decimal string Loro uses for a u64. Its low 53 bits are the peer id's Yjs
 * clientID (`yjsClientId` in `@kyneta/yjs-schema`).
 */
export function loroPeerId(peerId: string): PeerID {
  return peerNumber(peerId, 64).toString() as PeerID
}

// ---------------------------------------------------------------------------
// createLoroFactory — factory builder with peer identity injection
// ---------------------------------------------------------------------------

/**
 * Create a SubstrateFactory<LoroVersion> whose documents share one
 * deterministic numeric PeerID, derived from the exchange's string peerId.
 */
function createLoroFactory(
  peerId: string,
  binding: SchemaBinding,
): SubstrateFactory<LoroVersion> {
  const numericPeerId = loroPeerId(peerId)

  // Every construction below is this, differing only in where the LoroDoc
  // comes from and whether identity is claimed now or later. Sharing the body
  // keeps that one difference visible as an argument rather than something a
  // reader has to find by diffing three near-identical functions.
  //
  // Loro's root containers are addressed by name, so `ensureLoroContainers`
  // only looks them up — it writes no operations, and the commit that follows
  // has nothing to record. That is why this has no counterpart to the Yjs
  // binding's STRUCTURAL_YJS_CLIENT_ID dance: Yjs has to neutralise the
  // identity on its structural operations, and here there are none to
  // neutralise. Either choice of `claimIdentity` therefore starts from an
  // empty operation log.
  const buildSubstrate = (
    doc: LoroDocType,
    schema: SchemaNode,
    claimIdentity: boolean,
  ): Substrate<LoroVersion> => {
    if (claimIdentity) doc.setPeerId(numericPeerId)
    ensureLoroContainers(doc, schema, binding)
    doc.commit()
    return createLoroSubstrate(doc, schema, binding)
  }

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
      // Claim identity now: this is the two-phase path, so any import has
      // already happened and the op counter for our PeerID resumes past it
      // rather than colliding with it.
      if (!hasBackingDoc<LoroDocType>(replica)) {
        throw new Error(
          "upgrade() requires a replica produced by this factory.",
        )
      }
      return buildSubstrate(replica[BACKING_DOC], schema, true)
    },

    create(schema: SchemaNode): Substrate<LoroVersion> {
      // Fresh doc, nothing to import — claiming immediately is safe.
      return buildSubstrate(new LoroDoc(), schema, true)
    },

    createForHydration(schema: SchemaNode) {
      // Identity is deferred to `adopt` below. See the contract note on
      // SubstrateFactory.createForHydration for why claiming a PeerID before
      // importing that PeerID's own history silently drops an operation.
      //
      // Worth knowing about Loro specifically: it has no counterpart to Yjs's
      // collision detection. It does not notice the clash and simply loses the
      // operation, which makes a stable PeerID misleading here — identity
      // survives a restart looking healthy precisely because nothing defended
      // it.
      const doc = new LoroDoc()
      const substrate = buildSubstrate(doc, schema, false)
      return {
        substrate,
        adopt: () => {
          doc.setPeerId(numericPeerId)
        },
      }
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
// loro — the Loro CRDT binding target
// ---------------------------------------------------------------------------

/**
 * Loro composition-law tags — the set of concurrent composition laws
 * that the Loro substrate faithfully implements.
 */
export type LoroLaws =
  | "lww"
  | "additive"
  | "positional-ot"
  | "positional-ot-move"
  | "lww-per-key"
  | "tree-move"
  | "lww-tag-replaced"

/**
 * The Loro CRDT binding target.
 *
 * - `loro.bind(schema)` — bind a schema to Loro with collaborative sync
 * - `loro.replica()` — create a collaborative replica
 *
 * Laws are constrained to `LoroLaws` — schemas requiring composition laws
 * outside this set (e.g. `"add-wins-per-key"` from `Schema.set()`) are
 * rejected at compile time.
 *
 * To access the underlying LoroDoc, use `unwrap(ref)` from `@kyneta/schema`
 * which reads the `[NATIVE]` symbol property set during interpretation.
 */
export const loro: BindingTarget<LoroLaws, LoroNativeMap> = createBindingTarget<
  LoroLaws,
  LoroNativeMap
>({
  factory: ctx => createLoroFactory(ctx.peerId, ctx.binding),
  replicaFactory: loroReplicaFactory,
  syncMode: SYNC_COLLABORATIVE,
})
