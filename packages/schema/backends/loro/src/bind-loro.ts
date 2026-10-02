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
  SchemaBinding,
  SubstrateFactory,
} from "@kyneta/schema"
import {
  BACKING_DOC,
  createBindingTarget,
  peerNumber,
  SYNC_COLLABORATIVE,
} from "@kyneta/schema"
import type { PeerID } from "loro-crdt"
import { LoroDoc } from "loro-crdt"
import type { LoroNativeMap } from "./native-map.js"
import { loroReplicaFactory, loroUpgrade, takeReplicaDoc } from "./substrate.js"
import type { LoroVersion } from "./version.js"

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

  // Both constructions give a document a schema through `loroUpgrade`, and
  // differ only in when identity is claimed. Loro's root containers are
  // addressed by name, so they write no operations, which is why this has no
  // counterpart to the Yjs binding's STRUCTURAL_YJS_CLIENT_ID dance: Yjs has
  // to neutralise the identity on its structural operations, and here there
  // are none. Either way the document starts from an empty operation log.
  return {
    replica: loroReplicaFactory,

    // Claims identity now: the replica has already taken in any history, so
    // the op counter for our PeerID resumes past it rather than colliding
    // with it.
    upgrade: (replica, schema) =>
      loroUpgrade(takeReplicaDoc(replica), schema, binding, numericPeerId),

    createForHydration(schema) {
      // Identity is deferred to `adopt` below. See the contract note on
      // SubstrateFactory.createForHydration for why claiming a PeerID before
      // importing that PeerID's own history silently drops an operation.
      //
      // Worth knowing about Loro specifically: it has no counterpart to Yjs's
      // collision detection. It does not notice the clash and simply loses the
      // operation, which makes a stable PeerID misleading here — identity
      // survives a restart looking healthy precisely because nothing defended
      // it.
      const substrate = loroUpgrade(new LoroDoc(), schema, binding)
      return {
        substrate,
        // Through the substrate, which reads the document through its slot.
        adopt: () => {
          substrate[BACKING_DOC].setPeerId(numericPeerId)
        },
      }
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
