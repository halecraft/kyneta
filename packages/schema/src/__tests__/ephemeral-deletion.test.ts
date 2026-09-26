// ephemeral-deletion — a deleted key stays deleted after a merge.
//
// `mergeStateTree` unions keys, so absence carries no information: a key one
// peer lacks looks exactly like a key it has never seen. A removal therefore
// survived only until the next merge with anyone still holding it, which made
// `Schema.record` unusable as a roster — players, cursors and sessions could
// join but never leave.
//
// A delete now writes a tombstone, `[null, timestamp, true]`. It is an
// ordinary value that wins or loses by the normal rule, so the merge needs no
// knowledge of it.
//
// Semantics are LWW-Element-Set, not OR-Set: concurrent add and remove resolve
// by timestamp. Since "tombstone" usually implies OR-Set, where a concurrent
// add always wins, the distinguishing case is pinned below as a decision
// rather than left to be inferred.

import { afterEach, describe, expect, it, vi } from "vitest"
import {
  batch,
  createDoc,
  createRef,
  ephemeral,
  lastUpdated,
  mapChange,
  Schema,
  type SchemaNode,
} from "../index.js"
import { RawPath } from "../path.js"
import type { Substrate } from "../substrate.js"
import {
  ephemeralSubstrateFactory,
  type StateVersion,
} from "../substrates/ephemeral.js"
import {
  applyChangeToStateTree,
  type Container,
  type Horizon,
  isHorizon,
  type Live,
  mergeStateTree,
  type StateTree,
  type WriteStamp,
  writeProduct,
} from "../substrates/state-tree.js"
import { defined } from "../testing/index.js"

/** A horizon recording a deletion, whatever has been written since. */
const isDeletion = (node: unknown): boolean => isHorizon(node) && node[3]

/** A tuple as a peer holds it; the install ordinal is fixed and unread here. */
const tup = (
  value: unknown,
  timestamp: number,
  deleted?: true,
): Live | Horizon =>
  deleted ? [null, timestamp, 1, true] : [value, timestamp, 1]

/** A write's stamp. The ordinal only has to be above a structural zero. */
const stamp = (notBefore: number): WriteStamp => ({ notBefore, installedAt: 1 })

const merge = (local: Container, remote: Container) =>
  mergeStateTree(local, remote, 1)

const Roster = Schema.struct({ peers: Schema.record(Schema.number()) })
const peersPath = RawPath.empty.field("peers")
const asRecord = (tree: StateTree) => tree as Record<string, any>

const payload = (data: unknown) => ({
  kind: "entirety" as const,
  encoding: "json" as const,
  data: JSON.stringify(data),
})

/**
 * A tuple in wire shape: no install ordinal, because that is a fact about the
 * receiver and a sender has no business asserting it.
 */
const wire = (value: unknown, timestamp: number, deleted?: true) =>
  deleted ? [value, timestamp, true] : [value, timestamp]

/** A roster tree with the given entries, all stamped at `t`. */
function roster(entries: Record<string, number>, t: number): Container {
  const peers: Container = {}
  for (const [key, value] of Object.entries(entries)) peers[key] = [value, t, 1]
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
      stamp(100),
      Roster,
    )
    applyChangeToStateTree(
      tree,
      peersPath,
      mapChange(undefined, ["alice"]),
      stamp(200),
      Roster,
    )

    expect(isDeletion(asRecord(tree).peers.alice)).toBe(true)
    expect(asRecord(tree).peers.alice[1]).toBe(200)
    expect(asRecord(tree).peers.bob).toEqual(tup(2, 100))
  })

  it("reads as absent through the document", () => {
    const Bound = ephemeral.bind(Roster)
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

  it("a whole-record write puts every earlier key below one horizon", () => {
    // Writing a record whole is a statement about all of it: a key the value
    // omits is gone, whether or not this peer holds it. One horizon says that;
    // a tombstone per omitted key could only reach the keys held.
    const tree: Container = {
      peers: { alice: tup(1, 100), bob: tup(2, 100) },
    }
    writeProduct(tree, { peers: { bob: 2 } }, Roster, stamp(200))

    const replaced: Horizon = [{ bob: tup(2, 200) }, 200, 1, false]
    expect(asRecord(tree).peers).toEqual(replaced)

    // A peer that still holds alice has her dropped by the join.
    const merged = merge(tree, { peers: { alice: tup(1, 100) } }).tree
    expect(asRecord(merged).peers).toEqual(replaced)
  })
})

// ---------------------------------------------------------------------------
// Convergence — the point of the exercise
// ---------------------------------------------------------------------------

describe("a delete converges", () => {
  it("survives a merge with a peer that never saw it", () => {
    // A deletes alice at t=200. B still holds her at t=100.
    const deleted: StateTree = { peers: { alice: tup(null, 200, true) } }
    const stale = roster({ alice: 1 }, 100)

    const aThenB = merge({ peers: { alice: tup(null, 200, true) } }, stale).tree
    const bThenA = merge(roster({ alice: 1 }, 100), deleted).tree

    // Both directions agree, and both agree she is gone.
    expect(aThenB).toEqual(bThenA)
    expect(isDeletion(asRecord(aThenB).peers.alice)).toBe(true)
    expect(isDeletion(asRecord(bThenA).peers.alice)).toBe(true)
  })

  it("is absent on both peers after a real sync", () => {
    // Asserted through the substrate, not just the tree builder: local reads
    // come from a separate shadow, so a tree-level pass can coexist with a
    // document that still shows the key.
    const peerA = ephemeralSubstrateFactory.fromEntirety(
      payload({ peers: { alice: wire(1, 100), bob: wire(2, 100) } }),
      Roster,
    )
    peerA.merge(payload({ peers: { alice: wire(null, 200, true) } }))

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
    const merged = merge(
      { peers: { alice: tup(null, 10, true) } },
      { peers: { alice: tup(7, 11) } },
    ).tree
    expect(asRecord(merged).peers.alice).toEqual(tup(7, 11))
    expect(Object.keys(asRecord(merged).peers)).toEqual(["alice"])
  })

  it("a later delete beats an earlier add", () => {
    const merged = merge(
      { peers: { alice: tup(7, 11) } },
      { peers: { alice: tup(null, 12, true) } },
    ).tree
    expect(isDeletion(asRecord(merged).peers.alice)).toBe(true)
  })

  it("resolves the same way whichever peer merges first", () => {
    const forward = merge(
      { peers: { alice: tup(null, 10, true) } },
      { peers: { alice: tup(7, 11) } },
    ).tree
    const backward = merge(
      { peers: { alice: tup(7, 11) } },
      { peers: { alice: tup(null, 10, true) } },
    ).tree
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
    const Bound = ephemeral.bind(Roster)
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
    const Bound = ephemeral.bind(Roster)
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
        stamp(cycle * 2),
        Roster,
      )
      applyChangeToStateTree(
        tree,
        peersPath,
        mapChange(undefined, ["alice"]),
        stamp(cycle * 2 + 1),
        Roster,
      )
    }

    const peers = asRecord(tree).peers
    expect(Object.keys(peers)).toEqual(["alice"])
    expect(isDeletion(peers.alice)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Record of containers — deletion where the entry is a subtree
// ---------------------------------------------------------------------------

describe("deleting an entry whose value is a container", () => {
  const Cursors = Schema.struct({
    peers: Schema.record(Schema.struct({ x: Schema.number() })),
  })

  it("is one deletion, whatever the entry holds", () => {
    // One horizon covers the whole entry, including anything written into it
    // that this peer never saw. The join resolves it against a container by
    // pruning, so no peer ever has to choose between two shapes.
    const tree: Container = {}
    applyChangeToStateTree(
      tree,
      peersPath,
      mapChange({ alice: { x: 1 } }),
      stamp(100),
      Cursors,
    )
    applyChangeToStateTree(
      tree,
      peersPath,
      mapChange(undefined, ["alice"]),
      stamp(200),
      Cursors,
    )

    expect(asRecord(tree).peers.alice).toEqual([null, 200, 1, true])
  })

  it("converges, and reads as absent on both peers", () => {
    const deleted = { peers: { alice: { x: wire(null, 200, true) } } }

    const forward = merge(
      { peers: { alice: { x: tup(null, 200, true) } } },
      { peers: { alice: { x: tup(1, 100) } } },
    ).tree
    const backward = merge(
      { peers: { alice: { x: tup(1, 100) } } },
      { peers: { alice: { x: tup(null, 200, true) } } },
    ).tree
    expect(forward).toEqual(backward)

    // Every leaf beneath `alice` is tombstoned, so the whole entry drops out
    // of the projection — not an empty `{}` where she used to be.
    const peerA = ephemeralSubstrateFactory.fromEntirety(
      payload({
        peers: { alice: { x: wire(1, 100) }, bob: { x: wire(5, 100) } },
      }),
      Cursors,
    )
    peerA.merge(payload(deleted))
    expect(peerA.reader.read(peersPath)).toEqual({ bob: { x: 5 } })

    // An empty record is NOT a deleted one: it still projects as `{}`.
    const empty = ephemeralSubstrateFactory.fromEntirety(
      payload({ peers: {} }),
      Cursors,
    )
    expect(empty.reader.read(peersPath)).toEqual({})
  })

  it("reads as absent on a peer when the entry holds a nested struct", () => {
    // Presence at a dynamic key is decided by the leaves beneath it. It used
    // to be decided field by field against the schema, and a declared nested
    // container counted as present even with every leaf in it tombstoned, so
    // the peer saw `{ alice: { pos: {} } }` while the deleter saw `{}`.
    const Nested = Schema.struct({
      peers: Schema.record(
        Schema.struct({ pos: Schema.struct({ x: Schema.number() }) }),
      ),
    })
    const writer = peerOf(Nested)
    const peer = peerOf(Nested)
    batch(writer.doc, (d: any) => d.peers.set("alice", { pos: { x: 1 } }))
    ship(writer, peer)
    batch(writer.doc, (d: any) => d.peers.delete("alice"))
    ship(writer, peer)

    expect(writer.doc.peers()).toEqual({})
    expect(peer.doc.peers()).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// A delete reaches what the deleter never saw
// ---------------------------------------------------------------------------
//
// A delete is a statement about a whole entry as of one moment: everything
// written under the key before it is gone. Tombstoning leaf by leaf can only
// say that about the leaves the deleting peer holds, so each case below is a
// leaf it does not hold — an entry never seen, an inner key never seen, an
// entry with no leaves at all.
//
// Asserted through substrates, projections and digests rather than tree
// shapes, so these pin behaviour and survive a change of representation.

interface Peer {
  readonly substrate: Substrate<StateVersion>
  readonly doc: any
}

function peerOf(schema: SchemaNode): Peer {
  const substrate = ephemeralSubstrateFactory.create(schema)
  return { substrate, doc: createRef(schema, substrate) }
}

/** Anti-entropy by entirety: `to` joins everything `from` holds. */
function ship(from: Peer, to: Peer): void {
  to.substrate.merge(from.substrate.exportEntirety())
}

function digestOf(p: Peer): string {
  const digest = p.substrate.digest?.()
  if (digest === undefined) throw new Error("ephemeral must digest")
  return digest
}

describe("a delete reaches what the deleter never saw", () => {
  afterEach(() => vi.restoreAllMocks())

  const Rooms = Schema.struct({
    rooms: Schema.record(Schema.record(Schema.number())),
  })

  it("an entry the deleter never saw converges whatever the merge order", () => {
    // The delete lands as a leaf where the others hold a container, and the
    // join's leaf-versus-container branch discards one side whole — which is
    // not associative. B's `x` predates the delete and must go; C's `y` was
    // written after it and must stay.
    const now = vi.spyOn(Date, "now")
    const a = peerOf(Rooms)
    const b = peerOf(Rooms)
    const c = peerOf(Rooms)
    now.mockReturnValue(150)
    batch(b.doc, (d: any) => d.rooms.set("r1", { x: 1 }))
    now.mockReturnValue(300)
    batch(a.doc, (d: any) => d.rooms.delete("r1"))
    now.mockReturnValue(400)
    batch(c.doc, (d: any) => d.rooms.set("r1", { y: 2 }))

    const first = peerOf(Rooms)
    const second = peerOf(Rooms)
    for (const from of [a, b, c]) ship(from, first)
    for (const from of [b, c, a]) ship(from, second)

    expect(first.doc.rooms()).toEqual({ r1: { y: 2 } })
    expect(second.doc.rooms()).toEqual({ r1: { y: 2 } })
    expect(digestOf(first)).toBe(digestOf(second))
  })

  it("an inner key the deleter never saw does not outlive the delete", () => {
    const now = vi.spyOn(Date, "now")
    const a = peerOf(Rooms)
    const b = peerOf(Rooms)
    now.mockReturnValue(100)
    batch(a.doc, (d: any) => d.rooms.set("r1", { a: 1 }))
    ship(a, b)
    now.mockReturnValue(150)
    batch(b.doc, (d: any) => d.rooms.at("r1").set("b", 2))
    now.mockReturnValue(200)
    batch(a.doc, (d: any) => d.rooms.delete("r1"))
    ship(a, b)
    ship(b, a)

    expect(a.doc.rooms()).toEqual({})
    expect(b.doc.rooms()).toEqual({})
    expect(digestOf(a)).toBe(digestOf(b))
  })

  it("an inner key written after the delete brings the entry back", () => {
    // The converse, and it holds today. Pinned so the fix for the case above
    // cannot overshoot into "a delete wins regardless of clock", which is
    // OR-Set's opposite and not what this substrate promises.
    const now = vi.spyOn(Date, "now")
    const a = peerOf(Rooms)
    const b = peerOf(Rooms)
    now.mockReturnValue(100)
    batch(a.doc, (d: any) => d.rooms.set("r1", { a: 1 }))
    ship(a, b)
    now.mockReturnValue(200)
    batch(a.doc, (d: any) => d.rooms.delete("r1"))
    now.mockReturnValue(250)
    batch(b.doc, (d: any) => d.rooms.at("r1").set("b", 2))
    ship(a, b)
    ship(b, a)

    expect(a.doc.rooms()).toEqual({ r1: { b: 2 } })
    expect(b.doc.rooms()).toEqual({ r1: { b: 2 } })
  })

  describe("replacing a whole record", () => {
    const Lobby = Schema.struct({
      room: Schema.struct({ peers: Schema.record(Schema.string()) }),
    })

    it("clears an older key the writer never saw", () => {
      const now = vi.spyOn(Date, "now")
      const a = peerOf(Lobby)
      const b = peerOf(Lobby)
      now.mockReturnValue(100)
      batch(b.doc, (d: any) => d.room.peers.set("carol", "here"))
      now.mockReturnValue(200)
      batch(a.doc, (d: any) => d.room.set({ peers: { alice: "here" } }))
      ship(a, b)
      ship(b, a)

      expect(a.doc.room.peers()).toEqual({ alice: "here" })
      expect(b.doc.room.peers()).toEqual({ alice: "here" })
    })

    it("while a per-key set clears nothing else", () => {
      const now = vi.spyOn(Date, "now")
      const a = peerOf(Lobby)
      const b = peerOf(Lobby)
      now.mockReturnValue(100)
      batch(b.doc, (d: any) => d.room.peers.set("carol", "here"))
      now.mockReturnValue(200)
      batch(a.doc, (d: any) => d.room.peers.set("alice", "here"))
      ship(a, b)
      ship(b, a)

      const both = { alice: "here", carol: "here" }
      expect(a.doc.room.peers()).toEqual(both)
      expect(b.doc.room.peers()).toEqual(both)
    })
  })

  it("clear() reaches older entries even when the clearer sees none", () => {
    // The cross-substrate half of this, a clear against an earlier unseen add,
    // is in `tests/conformance` under `clearReach`. This half is ephemeral's
    // alone: a clear is a statement about the record as of now, so it has
    // something to say even when the local view is empty, and `clear()` sends
    // it then too.
    const Roster = Schema.struct({ peers: Schema.record(Schema.string()) })
    const now = vi.spyOn(Date, "now")
    const a = peerOf(Roster)
    const b = peerOf(Roster)
    now.mockReturnValue(100)
    batch(b.doc, (d: any) => d.peers.set("carol", "here"))
    now.mockReturnValue(200)
    batch(a.doc, (d: any) => d.peers.clear())
    ship(a, b)
    ship(b, a)

    expect(a.doc.peers()).toEqual({})
    expect(b.doc.peers()).toEqual({})
  })

  describe("an empty entry", () => {
    // It has no leaves, and deltas, digests and tombstones all see only
    // leaves — so it neither arrives nor leaves.

    it("reaches a peer by delta", () => {
      const a = peerOf(Rooms)
      const b = peerOf(Rooms)
      const cursor = a.substrate.version()
      batch(a.doc, (d: any) => d.rooms.set("r1", {}))
      const delta = a.substrate.exportSince(cursor)
      if (delta === null) throw new Error("same incarnation; must be served")
      b.substrate.merge(delta)

      expect(b.doc.rooms()).toEqual({ r1: {} })
    })

    it("stays deleted on every peer", () => {
      const now = vi.spyOn(Date, "now")
      const a = peerOf(Rooms)
      const b = peerOf(Rooms)
      now.mockReturnValue(100)
      batch(a.doc, (d: any) => d.rooms.set("r1", {}))
      ship(a, b)
      now.mockReturnValue(200)
      batch(a.doc, (d: any) => d.rooms.delete("r1"))
      ship(a, b)

      expect(a.doc.rooms()).toEqual({})
      expect(b.doc.rooms()).toEqual({})
    })
  })
})

describe("what a delete leaves behind", () => {
  afterEach(() => vi.restoreAllMocks())

  const Cursors = Schema.struct({
    peers: Schema.record(
      Schema.struct({ x: Schema.number(), y: Schema.number() }),
    ),
  })

  it("a field written after the delete brings the entry back with zeros beside it", () => {
    // The delete removes everything written before it, so of alice only the
    // later `x` survives. Her `y` is gone from the tree, and the projection
    // supplies its zero because the schema says she has one.
    const now = vi.spyOn(Date, "now")
    const a = peerOf(Cursors)
    const b = peerOf(Cursors)
    now.mockReturnValue(100)
    batch(a.doc, (d: any) => d.peers.set("alice", { x: 1, y: 2 }))
    ship(a, b)
    now.mockReturnValue(200)
    batch(a.doc, (d: any) => d.peers.delete("alice"))
    now.mockReturnValue(250)
    batch(b.doc, (d: any) => d.peers.at("alice").x.set(5))
    ship(a, b)
    ship(b, a)

    expect(a.doc.peers()).toEqual({ alice: { x: 5, y: 0 } })
    expect(b.doc.peers()).toEqual({ alice: { x: 5, y: 0 } })
  })

  it("deleting an entry ships one tuple, however many fields it has", () => {
    const Wide = Schema.struct({
      peers: Schema.record(
        Schema.struct(
          Object.fromEntries(
            Array.from({ length: 10 }, (_, i) => [`f${i}`, Schema.number()]),
          ),
        ),
      ),
    })
    const now = vi.spyOn(Date, "now")
    const a = peerOf(Wide)
    now.mockReturnValue(100)
    batch(a.doc, (d: any) =>
      d.peers.set(
        "alice",
        Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}`, i])),
      ),
    )
    const cursor = a.substrate.version()
    now.mockReturnValue(200)
    batch(a.doc, (d: any) => d.peers.delete("alice"))

    const delta = defined(a.substrate.exportSince(cursor), "a delta")
    expect(JSON.parse(delta.data as string)).toEqual({
      peers: { alice: [null, 200, true] },
    })
  })

  it("clearing a record ships one tuple, however many entries it has", () => {
    const Roster = Schema.struct({ peers: Schema.record(Schema.number()) })
    const now = vi.spyOn(Date, "now")
    const a = peerOf(Roster)
    now.mockReturnValue(100)
    batch(a.doc, (d: any) => {
      for (let i = 0; i < 50; i++) d.peers.set(`peer-${i}`, i)
    })
    const cursor = a.substrate.version()
    now.mockReturnValue(200)
    batch(a.doc, (d: any) => d.peers.clear())

    // The horizon is the news. `null` content in a delta makes no claim about
    // the content, and the receiver reads a replacement's `null` as empty.
    const delta = defined(a.substrate.exportSince(cursor), "a delta")
    expect(JSON.parse(delta.data as string)).toEqual({
      peers: [null, 200, false],
    })
  })
})

// ---------------------------------------------------------------------------
// A delete survives being loaded
// ---------------------------------------------------------------------------

describe("a delete survives being loaded from a payload", () => {
  // `fromEntirety(payload, schema)` is what `createDoc(bound, payload)` and an
  // exchange promotion both reach. It read the payload with `JSON.parse`,
  // taking the wire's tombstone marker for the install ordinal, so every
  // delete came back as a live `null` — which then beat the tombstone on
  // every peer, because live beats tombstone on a tie.
  const loaded = () =>
    ephemeralSubstrateFactory.fromEntirety(
      payload({ peers: { alice: wire(null, 200, true), bob: wire(2, 100) } }),
      Roster,
    )

  it("reads as absent", () => {
    expect(loaded().reader.read(peersPath)).toEqual({ bob: 2 })
  })

  it("does not resurrect on a peer it is shipped to", () => {
    const holder = ephemeralSubstrateFactory.fromEntirety(
      payload({ peers: { alice: wire(1, 100), bob: wire(2, 100) } }),
      Roster,
    )
    holder.merge(loaded().exportEntirety())
    expect(holder.reader.read(peersPath)).toEqual({ bob: 2 })
  })
})
