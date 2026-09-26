// ephemeral-records — `Schema.record` works on the `ephemeral` substrate.
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
import {
  batch,
  createDoc,
  createRef,
  ephemeral,
  mapChange,
  own,
  replaceChange,
  Schema,
  sequenceChange,
} from "../index.js"
import { RawPath } from "../path.js"
import { ephemeralSubstrateFactory } from "../substrates/ephemeral.js"
import {
  applyChangeToStateTree,
  type Horizon,
  isHorizon,
  isLive,
  type StateTree,
} from "../substrates/state-tree.js"
import { payload, stamp, tup, wire } from "./ephemeral-fixtures.js"

/** A horizon recording a deletion, whatever has been written since. */
const isDeletion = (node: unknown): boolean => isHorizon(node) && node[3]

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
      stamp(100),
      Roster,
    )

    // Per-key tuples, not one register holding the whole record. If the record
    // were stored whole, two peers each writing their own key would clobber
    // one another on merge, which is exactly what this substrate exists to
    // avoid.
    expect(isLive(asRecord(tree).peers)).toBe(false)
    expect(asRecord(tree).peers.alice).toEqual(tup(1, 100))
    expect(asRecord(tree).peers.bob).toEqual(tup(2, 100))
  })

  it("stamps only the keys a change mentions", () => {
    const tree: StateTree = {}
    applyChangeToStateTree(
      tree,
      peersPath,
      mapChange({ alice: 1 }),
      stamp(100),
      Roster,
    )
    applyChangeToStateTree(
      tree,
      peersPath,
      mapChange({ bob: 2 }),
      stamp(200),
      Roster,
    )

    // Alice keeps her original timestamp. A later write to a sibling key must
    // not refresh her, or a decaying presence field would never expire.
    expect(asRecord(tree).peers.alice).toEqual(tup(1, 100))
    expect(asRecord(tree).peers.bob).toEqual(tup(2, 200))
  })

  it("applies deletes before sets, matching stepMap", () => {
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
      mapChange({ alice: 9 }, ["alice", "bob"]),
      stamp(200),
      Roster,
    )

    // `alice` appears in both `set` and `delete`, so the set wins.
    expect(asRecord(tree).peers.alice).toEqual(tup(9, 200))
    // `bob` was only deleted, so he is tombstoned rather than removed — the
    // tuple has to stay in the tree for the delete to replicate.
    expect(isDeletion(asRecord(tree).peers.bob)).toBe(true)
  })

  it("refuses a change kind the tree cannot record", () => {
    // Unreachable through a substrate, because a schema carrying a sequence
    // is now rejected at both seams. It is asserted here because the silent
    // alternative is the defect this guard replaces: an unhandled change type
    // used to fall off the end, advancing σ and leaving λ untouched, so the
    // writing peer read back perfectly and every other peer saw nothing.
    const tree: StateTree = {}
    expect(() =>
      applyChangeToStateTree(
        tree,
        peersPath,
        sequenceChange([{ insert: [1] }]),
        stamp(100),
        Roster,
      ),
    ).toThrow(/cannot store a sequence change/)
    expect(tree).toEqual({})
  })

  it("refuses a map change aimed at an atomic register", () => {
    // A sum or `.json()` node is one tuple, and `prepare` (`ephemeral.ts`)
    // widens any write at or inside it into a whole-value replace, so this is
    // unreachable in normal operation. Without the guard, applying it would
    // overwrite the register with a container and write entries into it,
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
        stamp(100),
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
  it("each peer's own key survives the merge", () => {
    const peerA = ephemeralSubstrateFactory.fromEntirety(
      payload({ peers: { alice: wire(1, 100) } }),
      Roster,
    )
    peerA.merge(payload({ peers: { bob: wire(2, 100) } }))

    expect(peerA.reader.read(peersPath)).toEqual({ alice: 1, bob: 2 })
  })

  it("a merge leaves every timestamp where the join put it", () => {
    // Reads come from the shadow, so a merge that restamps the tree with
    // local time reads perfectly on this peer — and then nothing ever
    // expires, here or on any peer that later receives this tree. The
    // assertion has to reach past the document.
    const peerA = ephemeralSubstrateFactory.fromEntirety(
      payload({ peers: { alice: wire(1, 100) } }),
      Roster,
    )
    peerA.merge(payload({ peers: { bob: wire(2, 200) } }))

    const tree = JSON.parse(peerA.exportEntirety().data as string) as {
      peers: Record<string, unknown>
    }
    expect(tree.peers.alice).toEqual(wire(1, 100))
    expect(tree.peers.bob).toEqual(wire(2, 200))
  })

  it("a key merely missing from an incoming payload is not a delete", () => {
    // `mergeStateTree` unions keys, so absence carries no information: a key
    // one peer lacks is indistinguishable from one it has never seen. This is
    // exactly why deletion has to be represented rather than expressed by
    // omission — see ephemeral-deletion.test.ts for the tombstone that does it.
    const peerA = ephemeralSubstrateFactory.fromEntirety(
      payload({ peers: { alice: wire(1, 100) } }),
      Roster,
    )
    peerA.merge(payload({ peers: {} }))

    expect(peerA.reader.read(peersPath)).toEqual({ alice: 1 })
  })
})

// ---------------------------------------------------------------------------
// Key space — a product's fields are declared, a map's keys are written
// ---------------------------------------------------------------------------
//
// The tree applies one rule per key space, and the two are opposites. Absence
// under a map means "removed, or never there"; absence under a product means
// the value a caller passed was partial. Treating a product like a map is what
// dropped a record when its last key went, and dropped struct fields a partial
// write did not mention.

describe("a declared field is not a written key", () => {
  const Mixed = Schema.struct({
    rec: Schema.record(Schema.number()),
    str: Schema.struct({ a: Schema.number(), b: Schema.number() }),
  })
  const recPath = RawPath.empty.field("rec")
  const strPath = RawPath.empty.field("str")

  it("keeps a declared field a partial value omits", () => {
    const tree: StateTree = {}
    applyChangeToStateTree(
      tree,
      strPath,
      replaceChange(own({ a: 1, b: 2 })),
      stamp(100),
      Mixed,
    )
    // `{a: 9}` is not a valid struct value — `tryValidate` rejects it — so
    // this is a caller past the type guard. The tree must not turn a partial
    // value into a removal.
    applyChangeToStateTree(
      tree,
      strPath,
      replaceChange(own({ a: 9 } as never)),
      stamp(500),
      Mixed,
    )

    expect(asRecord(tree).str).toEqual({ a: tup(9, 500), b: tup(2, 100) })
  })

  it("still deletes a written key a whole-value set omits", () => {
    const tree: StateTree = {}
    applyChangeToStateTree(
      tree,
      recPath,
      replaceChange(own({ x: 1, y: 2 })),
      stamp(100),
      Mixed,
    )
    applyChangeToStateTree(
      tree,
      recPath,
      replaceChange(own({ x: 5 })),
      stamp(200),
      Mixed,
    )

    // The case the rule must not break: under a map, omission IS removal, and
    // the removal has to be recorded so it survives the next merge. Writing
    // the map whole puts `y` below one horizon, along with any key this peer
    // never saw.
    const replaced: Horizon = [{ x: tup(5, 200) }, 200, 1, false]
    expect(asRecord(tree).rec).toEqual(replaced)
  })

  it("projects an emptied record as an empty record, not as absent", () => {
    const substrate = ephemeralSubstrateFactory.create(Roster)
    const d: any = createRef(Roster, substrate)
    batch(d, (w: any) => w.peers.set("alice", 1))
    batch(d, (w: any) => w.peers.delete("alice"))

    // `peers` is a field of the root product, so it exists whatever happens to
    // its keys. Reading the shadow directly — the document read would supply a
    // structural zero and hide a disagreement.
    expect(substrate.reader.read(RawPath.empty)).toEqual({ peers: {} })
  })
})

// ---------------------------------------------------------------------------
// A partial entry is a legitimate state
// ---------------------------------------------------------------------------

describe("an entry missing declared fields reads them as their zeros", () => {
  // A delta carries only the leaves that changed, so a peer can hold an entry
  // with some of its declared fields and not others — a peer that joins
  // after `alice.y` was written and receives only a later write to `alice.x`,
  // say. The tree is right to hold only what arrived; the projection has to be
  // total anyway, because the entry's type says `y` exists.
  //
  // The reader is schema-blind, so it cannot supply the zero. The projection
  // can, because it is the schema's fold.
  const Cursors = Schema.struct({
    peers: Schema.record(
      Schema.struct({ x: Schema.number(), y: Schema.number() }),
    ),
  })

  it("after a delta carrying one of its fields", () => {
    const substrate = ephemeralSubstrateFactory.create(Cursors)
    substrate.merge({
      kind: "since",
      encoding: "json",
      data: JSON.stringify({ peers: { alice: { x: [5, 100] } } }),
    })

    expect(substrate.reader.read(peersPath)).toEqual({ alice: { x: 5, y: 0 } })
  })
})
