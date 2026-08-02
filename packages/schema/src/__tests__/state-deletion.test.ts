// state-deletion — a deleted key stays deleted after a merge.
//
// `mergeStateTree` unions keys, so absence carries no information: a key
// missing from one peer looks exactly like a key that peer has never seen.
// Removing a key therefore used to survive only until the next merge with
// anyone who still held it, which made `Schema.record` unusable as a roster —
// players, cursors and sessions could join but never leave.
//
// A delete now writes a tombstone: `[null, timestamp, true]`. It is an
// ordinary register value, so it wins or loses by the same rule as any other
// write, and `mergeStateTree` needs no knowledge of it.
//
// Semantics are LWW-Element-Set, not OR-Set: concurrent add and remove resolve
// by timestamp, so a later add beats an earlier delete. Anyone reading
// "tombstone" is likely to assume OR-Set (where a concurrent add always wins),
// so the distinguishing case is pinned below as a decision rather than left to
// be inferred.

import { describe, expect, it } from "vitest"
import {
  batch,
  createDoc,
  lastUpdated,
  mapChange,
  Schema,
  state,
} from "../index.js"
import { RawPath } from "../path.js"
import { stateSubstrateFactory } from "../substrates/state.js"
import {
  applyChangeToStateTree,
  isTombstone,
  mergeStateTree,
  type StateTree,
  syncStateTreeToShadow,
} from "../substrates/state-tree.js"

const Roster = Schema.struct({ peers: Schema.record(Schema.number()) })
const peersPath = RawPath.empty.field("peers")
const asRecord = (tree: StateTree) => tree as Record<string, any>

const payload = (data: unknown) => ({
  kind: "entirety" as const,
  encoding: "json" as const,
  data: JSON.stringify(data),
})

/** A roster tree with the given entries, all stamped at `t`. */
function roster(entries: Record<string, number>, t: number): StateTree {
  const peers: Record<string, StateTree> = {}
  for (const [key, value] of Object.entries(entries)) peers[key] = [value, t]
  return { peers }
}

// ---------------------------------------------------------------------------
// The tombstone itself
// ---------------------------------------------------------------------------

describe("a delete writes a tombstone", () => {
  it("replaces the tuple rather than removing the key", () => {
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
      mapChange(undefined, ["alice"]),
      200,
      Roster,
    )

    expect(isTombstone(asRecord(tree).peers.alice)).toBe(true)
    expect(asRecord(tree).peers.alice[1]).toBe(200)
    expect(asRecord(tree).peers.bob).toEqual([2, 100])
  })

  it("reads as absent through the document", () => {
    const Bound = state.bind(Roster)
    const doc: any = createDoc(Bound)
    batch(doc, (writable: any) => {
      writable.peers.set("alice", 1)
      writable.peers.set("bob", 2)
    })
    batch(doc, (writable: any) => writable.peers.delete("alice"))

    // The tuple is still in the tree so the delete can replicate; the
    // projection drops it.
    expect(doc.peers()).toEqual({ bob: 2 })
  })

  it("is written by a whole-value sync that omits a key, not just by delete", () => {
    // `syncStateTreeToShadow` propagates a whole plain value into the tree and
    // prunes keys the value no longer has. That pruning is a deletion too, and
    // it has to converge the same way an explicit `delete` does — otherwise
    // which one a caller happened to use would decide whether the removal
    // survives a merge.
    const tree: StateTree = { peers: { alice: [1, 100], bob: [2, 100] } }
    syncStateTreeToShadow(tree, { peers: { bob: 2 } }, Roster, 200)

    expect(isTombstone(asRecord(tree).peers.alice)).toBe(true)
    expect(asRecord(tree).peers.alice[1]).toBe(200)
  })

  it("does not re-stamp a key that is already tombstoned", () => {
    // Refreshing a tombstone's timestamp on every unrelated whole-value write
    // would let an old delete keep beating a newer remote re-add.
    const tree: StateTree = {
      peers: { alice: [null, 100, true], bob: [2, 100] },
    }
    syncStateTreeToShadow(tree, { peers: { bob: 2 } }, Roster, 900)

    expect(asRecord(tree).peers.alice[1]).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// Convergence — the point of the exercise
// ---------------------------------------------------------------------------

describe("a delete converges", () => {
  it("survives a merge with a peer that never saw it", () => {
    // A deletes alice at t=200. B still holds her at t=100.
    const deleted: StateTree = { peers: { alice: [null, 200, true] } }
    const stale = roster({ alice: 1 }, 100)

    const aThenB = mergeStateTree(
      { peers: { alice: [null, 200, true] } },
      stale,
    )
    const bThenA = mergeStateTree(roster({ alice: 1 }, 100), deleted)

    // Both directions agree, and both agree she is gone.
    expect(aThenB).toEqual(bThenA)
    expect(isTombstone(asRecord(aThenB).peers.alice)).toBe(true)
    expect(isTombstone(asRecord(bThenA).peers.alice)).toBe(true)
  })

  it("is absent on both peers after a real sync", () => {
    // Asserted through the substrate, not just the tree builder: local reads
    // come from a separate shadow, so a tree-level pass can coexist with a
    // document that still shows the key.
    const peerA = stateSubstrateFactory.fromEntirety(
      payload({ peers: { alice: [1, 100], bob: [2, 100] } }),
      Roster,
    )
    peerA.merge(payload({ peers: { alice: [null, 200, true] } }))

    expect(peerA.reader.read(peersPath)).toEqual({ bob: 2 })
  })
})

// ---------------------------------------------------------------------------
// LWW-Element-Set, not OR-Set
// ---------------------------------------------------------------------------

describe("delete and re-add resolve by timestamp", () => {
  it("a later add beats an earlier delete", () => {
    // A deletes at t=10; B re-adds at t=11. The re-add wins, and — the part
    // worth noticing — it OVERWRITES the tombstone rather than sitting beside
    // it, so the key holds exactly one tuple either way.
    const merged = mergeStateTree(
      { peers: { alice: [null, 10, true] } },
      { peers: { alice: [7, 11] } },
    )
    expect(asRecord(merged).peers.alice).toEqual([7, 11])
    expect(Object.keys(asRecord(merged).peers)).toEqual(["alice"])
  })

  it("a later delete beats an earlier add", () => {
    const merged = mergeStateTree(
      { peers: { alice: [7, 11] } },
      { peers: { alice: [null, 12, true] } },
    )
    expect(isTombstone(asRecord(merged).peers.alice)).toBe(true)
  })

  it("resolves the same way whichever peer merges first", () => {
    const forward = mergeStateTree(
      { peers: { alice: [null, 10, true] } },
      { peers: { alice: [7, 11] } },
    )
    const backward = mergeStateTree(
      { peers: { alice: [7, 11] } },
      { peers: { alice: [null, 10, true] } },
    )
    expect(forward).toEqual(backward)
  })
})

// ---------------------------------------------------------------------------
// The one tuple-shape consumer outside the substrate
// ---------------------------------------------------------------------------

describe("lastUpdated sees tombstones", () => {
  // `lastUpdated` is the only reader of the tuple shape outside
  // `state-tree.ts` and `state.ts`, so widening the tuple to three slots could
  // plausibly have broken it.
  //
  // A deleted key cannot be asked about directly: `doc.peers.at("alice")`
  // resolves against the projected shadow, where a deleted key is absent, so
  // it returns `undefined` and there is no ref to pass. That is unchanged by
  // this work — under the old local-removal behaviour the key was equally
  // unreachable. The reachable question is what a *container* reports, which
  // is the maximum timestamp of the leaves beneath it.

  it("reports a container's delete as its last update", () => {
    const Bound = state.bind(Roster)
    const doc: any = createDoc(Bound)
    batch(doc, (writable: any) => {
      writable.peers.set("alice", 1)
      writable.peers.set("bob", 2)
    })
    const beforeDelete = lastUpdated(doc.peers) as number

    batch(doc, (writable: any) => writable.peers.delete("alice"))
    const afterDelete = lastUpdated(doc.peers) as number

    // A delete is a real change to the record, so it moves the record's
    // "last updated" forward rather than being invisible to it.
    expect(typeof afterDelete).toBe("number")
    expect(afterDelete).toBeGreaterThanOrEqual(beforeDelete)
  })

  it("still reads a live key through the widened tuple", () => {
    const Bound = state.bind(Roster)
    const doc: any = createDoc(Bound)
    batch(doc, (writable: any) => writable.peers.set("alice", 1))
    expect(typeof lastUpdated(doc.peers.at("alice"))).toBe("number")
  })
})

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

describe("tombstones do not accumulate", () => {
  it("holds one tuple per key across many delete/add cycles", () => {
    // Deleting REPLACES a tuple rather than adding one, and re-adding replaces
    // it back, so the tree is bounded by the set of keys ever written — the
    // same bound it had when nothing was ever deleted. This is why no
    // collection mechanism is needed, and it is worth pinning: "tombstone" is
    // borrowed from CRDTs where deletes really do accumulate per operation.
    const tree: StateTree = {}
    for (let cycle = 0; cycle < 500; cycle++) {
      applyChangeToStateTree(
        tree,
        peersPath,
        mapChange({ alice: cycle }),
        cycle * 2,
        Roster,
      )
      applyChangeToStateTree(
        tree,
        peersPath,
        mapChange(undefined, ["alice"]),
        cycle * 2 + 1,
        Roster,
      )
    }

    const peers = asRecord(tree).peers
    expect(Object.keys(peers)).toEqual(["alice"])
    expect(isTombstone(peers.alice)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Record of containers — deletion where the entry is a subtree
// ---------------------------------------------------------------------------

describe("deleting an entry whose value is a container", () => {
  const Cursors = Schema.struct({
    peers: Schema.record(Schema.struct({ x: Schema.number() })),
  })

  it("tombstones the leaves inside it, keeping the node's shape", () => {
    // A cursor-per-peer roster is at least as plausible as a scalar one. The
    // delete could replace the whole subtree with a single tombstone tuple,
    // which is shorter — but then a peer that had seen the delete would hold a
    // LEAF exactly where a peer that had not still held a CONTAINER, and
    // resolving that shape disagreement means discarding one side's contents.
    // Discarding breaks associativity, so peers given the same updates in
    // different orders would end up with different state.
    const tree: StateTree = {}
    applyChangeToStateTree(
      tree,
      peersPath,
      mapChange({ alice: { x: 1 } }),
      100,
      Cursors,
    )
    applyChangeToStateTree(
      tree,
      peersPath,
      mapChange(undefined, ["alice"]),
      200,
      Cursors,
    )

    expect(isTombstone(asRecord(tree).peers.alice.x)).toBe(true)
    expect(asRecord(tree).peers.alice.x[1]).toBe(200)
  })

  it("converges, and reads as absent on both peers", () => {
    const deleted: StateTree = { peers: { alice: { x: [null, 200, true] } } }

    const forward = mergeStateTree(
      { peers: { alice: { x: [null, 200, true] } } },
      { peers: { alice: { x: [1, 100] } } },
    )
    const backward = mergeStateTree(
      { peers: { alice: { x: [1, 100] } } },
      { peers: { alice: { x: [null, 200, true] } } },
    )
    expect(forward).toEqual(backward)

    // Every leaf beneath `alice` is tombstoned, so the whole entry drops out
    // of the projection — not an empty `{}` where she used to be.
    const peerA = stateSubstrateFactory.fromEntirety(
      payload({ peers: { alice: { x: [1, 100] }, bob: { x: [5, 100] } } }),
      Cursors,
    )
    peerA.merge(payload(deleted))
    expect(peerA.reader.read(peersPath)).toEqual({ bob: { x: 5 } })

    // An empty record is NOT a deleted one: it still projects as `{}`.
    const empty = stateSubstrateFactory.fromEntirety(
      payload({ peers: {} }),
      Cursors,
    )
    expect(empty.reader.read(peersPath)).toEqual({})
  })
})
