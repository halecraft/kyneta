// bind-yjs — Yjs CRDT binding target and factory internals.
//
// The `yjs` binding target provides `yjs.bind()` and `yjs.replica()` for
// binding schemas to the Yjs substrate with collaborative sync protocol.
// The factory builder accepts { peerId } and returns a SubstrateFactory that
// derives one deterministic clientID from it via yjsClientId, so all of an
// exchange's documents speak as its seat, the peer id its Runtime issued.
// With a store, the store issues that seat, and it survives a restart over
// the same storage; without one, every Runtime is a new seat.
//
// Every construction path claims that clientID; they differ only in *when*.
// A document that will first import its own stored history has to wait —
// see `createForHydration` below for what goes wrong otherwise.
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
  SchemaBinding,
  SubstrateFactory,
} from "@kyneta/schema"
import {
  BACKING_DOC,
  createBindingTarget,
  peerNumber,
  SYNC_COLLABORATIVE,
} from "@kyneta/schema"
import * as Y from "yjs"
import type { YjsNativeMap } from "./native-map.js"
import { takeReplicaDoc, yjsReplicaFactory, yjsUpgrade } from "./substrate.js"
import type { YjsVersion } from "./version.js"

// ---------------------------------------------------------------------------
// Peer id → Yjs clientID
// ---------------------------------------------------------------------------

/**
 * The Yjs `clientID` a peer id writes under: its 53-bit `peerNumber`.
 *
 * 53 bits is the widest id a JS `number` holds exactly; Yjs's own random ids
 * use only 32, but its encoders carry any safe integer. Never 0, which is
 * `STRUCTURAL_YJS_CLIENT_ID`, and always the low 53 bits of the peer id's
 * Loro PeerID (`loroPeerId` in `@kyneta/loro-schema`).
 */
export function yjsClientId(peerId: string): number {
  return Number(peerNumber(peerId, 53))
}

// ---------------------------------------------------------------------------
// createYjsFactory — factory builder with peer identity injection
// ---------------------------------------------------------------------------

/**
 * Create a SubstrateFactory<YjsVersion> whose documents share one
 * deterministic clientID, `yjsClientId(peerId)`.
 */
function createYjsFactory(
  peerId: string,
  binding: SchemaBinding,
): SubstrateFactory<YjsVersion> {
  const numericClientId = yjsClientId(peerId)

  // Both constructions give a document a schema through `yjsUpgrade`, and
  // differ only in when identity is claimed. Its structural ops are written
  // under STRUCTURAL_YJS_CLIENT_ID either way, so a freshly built document has
  // no operations under the peer's *own* id.
  return {
    replica: yjsReplicaFactory,

    // Claims identity now: the replica has already taken in any history, so
    // the clock for our id is wherever that history left it, and writes
    // continue from there rather than colliding with it.
    upgrade: (replica, schema) =>
      yjsUpgrade(takeReplicaDoc(replica), schema, binding, numericClientId),

    createForHydration(schema) {
      // Identity is deferred to `adopt` below. See the contract note on
      // SubstrateFactory.createForHydration for why claiming a clientID before
      // importing that clientID's own history silently drops an operation.
      //
      // Worth knowing about Yjs specifically: it would catch this itself, by
      // reassigning clientID when an arriving update carries operations from
      // an id it claims but did not author. That saves the data, but only when
      // the import beats every local write, and it costs the peer its identity
      // on every restart either way. Deferring keeps both.
      //
      // The cost of deferring: anything written during the import stays
      // attributed to the throwaway id — one extra version-vector entry that
      // never grows again, which is far cheaper than a lost operation.
      const substrate = yjsUpgrade(new Y.Doc(), schema, binding)
      return {
        substrate,
        // Through the substrate, which reads the document through its slot.
        adopt: () => {
          substrate[BACKING_DOC].clientID = numericClientId
        },
      }
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
  syncMode: SYNC_COLLABORATIVE,
})
