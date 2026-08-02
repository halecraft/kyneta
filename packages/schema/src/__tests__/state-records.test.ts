// state-records — `Schema.record` works on the `ephemeral` substrate.
//
// The `ephemeral` target exists for decentralised presence, and that use case wants a roster:
// a record keyed by peer, each peer writing only its own key. It was the one
// container the substrate could not do — `applyChangeToStateTree` read a
// `MapChange` shape the change vocabulary has never defined, so every map
// write threw. No test covered a record key write, which is how it survived.
//
// Several assertions reach past the document to the tree. Local reads come
// from a separate shadow, so a document-level assertion can pass while the
// replicated tree is wrong — a trap documented in TECHNICAL.md §"Atomic
// registers in the StateTree" that has caught this substrate before.

import { describe, expect, it } from "vitest"
import { batch, createDoc, ephemeral, mapChange, Schema } from "../index.js"
import { RawPath } from "../path.js"
import { ephemeralSubstrateFactory } from "../substrates/ephemeral.js"
import {
  applyChangeToStateTree,
  isStateTuple,
  isTombstone,
  type StateTree,
} from "../substrates/state-tree.js"

const Roster = Schema.struct({ peers: Schema.record(Schema.number()) })
const Bound = ephemeral.bind(Roster)
const peersPath = RawPath.empty.field("peers")

const asRecord = (tree: StateTree) => tree as Record<string, any>

// ---------------------------------------------------------------------------
// Through the document API — the shape a user actually writes
// ---------------------------------------------------------------------------

describe("record writes on state", () => {
  it("sets a key", () => {
    const doc: any = createDoc(Bound)
    batch(doc, (writable: any) => writable.peers.set("alice", 1))
    expect(doc.peers()).toEqual({ alice: 1 })
  })

  it("sets several keys, then overwrites one", () => {
    const doc: any = createDoc(Bound)
    batch(doc, (writable: any) => {
      writable.peers.set("alice", 1)
      writable.peers.set("bob", 2)
    })
    expect(doc.peers()).toEqual({ alice: 1, bob: 2 })

    batch(doc, (writable: any) => writable.peers.set("alice", 9))
    // The overwrite must leave the sibling key alone — field-level merge is
    // the whole point of this substrate.
    expect(doc.peers()).toEqual({ alice: 9, bob: 2 })
  })

  it("removes a key locally", () => {
    const doc: any = createDoc(Bound)
    batch(doc, (writable: any) => {
      writable.peers.set("alice", 1)
      writable.peers.set("bob", 2)
    })
    batch(doc, (writable: any) => writable.peers.delete("alice"))
    expect(doc.peers()).toEqual({ bob: 2 })
  })
})

// ---------------------------------------------------------------------------
// In the tree — what actually replicates
// ---------------------------------------------------------------------------

describe("a record decomposes into one tuple per key", () => {
  it("stores each entry as its own timestamped leaf", () => {
    const tree: StateTree = {}
    applyChangeToStateTree(
      tree,
      peersPath,
      mapChange({ alice: 1, bob: 2 }),
      100,
      Roster,
    )

    // Per-key tuples, not one register holding the whole record. If the record
    // were stored whole, two peers each writing their own key would clobber
    // one another on merge, which is exactly what this substrate exists to
    // avoid.
    expect(isStateTuple(asRecord(tree).peers)).toBe(false)
    expect(asRecord(tree).peers.alice).toEqual([1, 100])
    expect(asRecord(tree).peers.bob).toEqual([2, 100])
  })

  it("stamps only the keys a change mentions", () => {
    const tree: StateTree = {}
    applyChangeToStateTree(
      tree,
      peersPath,
      mapChange({ alice: 1 }),
      100,
      Roster,
    )
    applyChangeToStateTree(tree, peersPath, mapChange({ bob: 2 }), 200, Roster)

    // Alice keeps her original timestamp. A later write to a sibling key must
    // not refresh her, or a decaying presence field would never expire.
    expect(asRecord(tree).peers.alice).toEqual([1, 100])
    expect(asRecord(tree).peers.bob).toEqual([2, 200])
  })

  it("applies deletes before sets, matching stepMap", () => {
    const tree: StateTree = {}
    applyChangeToStateTree(
      tree,
      peersPath,
      mapChange({ alice: 1, bob: 2 }),
      100,
      Roster,
    )
    applyChangeToStateTree(
      tree,
      peersPath,
      mapChange({ alice: 9 }, ["alice", "bob"]),
      200,
      Roster,
    )

    // `alice` appears in both `set` and `delete`, so the set wins.
    expect(asRecord(tree).peers.alice).toEqual([9, 200])
    // `bob` was only deleted, so he is tombstoned rather than removed — the
    // tuple has to stay in the tree for the delete to replicate.
    expect(isTombstone(asRecord(tree).peers.bob)).toBe(true)
  })

  it("refuses a map change aimed at an atomic register", () => {
    // A sum or `.json()` node is one tuple, and `state.ts:prepare` widens any
    // write at or inside it into a whole-value replace, so this is unreachable
    // in normal operation. It is guarded because the old code responded by
    // overwriting the register with `{}` and writing entries into it —
    // decomposing an atomic register into blendable per-field tuples, and
    // silently, because local reads come from the shadow rather than the tree.
    const Blob = Schema.struct({
      blob: Schema.struct.json({ a: Schema.number() }),
    })
    const tree: StateTree = {}

    expect(() =>
      applyChangeToStateTree(
        tree,
        RawPath.empty.field("blob"),
        mapChange({ a: 1 }),
        100,
        Blob,
      ),
    ).toThrow(/atomic register/)

    // Nothing was written on the way to throwing.
    expect(asRecord(tree).blob).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Two peers — the presence use case
// ---------------------------------------------------------------------------

describe("two peers merge a roster without clobbering", () => {
  const payload = (data: unknown) => ({
    kind: "entirety" as const,
    encoding: "json" as const,
    data: JSON.stringify(data),
  })

  it("each peer's own key survives the merge", () => {
    const peerA = ephemeralSubstrateFactory.fromEntirety(
      payload({ peers: { alice: [1, 100] } }),
      Roster,
    )
    peerA.merge(payload({ peers: { bob: [2, 100] } }))

    expect(peerA.reader.read(peersPath)).toEqual({ alice: 1, bob: 2 })
  })

  it("a key merely missing from an incoming payload is not a delete", () => {
    // `mergeStateTree` unions keys, so absence carries no information: a key
    // one peer lacks is indistinguishable from one it has never seen. This is
    // exactly why deletion has to be represented rather than expressed by
    // omission — see state-deletion.test.ts for the tombstone that does it.
    const peerA = ephemeralSubstrateFactory.fromEntirety(
      payload({ peers: { alice: [1, 100] } }),
      Roster,
    )
    peerA.merge(payload({ peers: {} }))

    expect(peerA.reader.read(peersPath)).toEqual({ alice: 1 })
  })
})
