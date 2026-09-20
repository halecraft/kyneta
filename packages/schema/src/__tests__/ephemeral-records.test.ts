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
        100,
        Roster,
      ),
    ).toThrow(/cannot store a sequence change/)
    expect(tree).toEqual({})
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

  it("a merge leaves every timestamp where the join put it", () => {
    // Reads come from the shadow, so a merge that restamps the tree with
    // local time reads perfectly on this peer — and then nothing ever
    // expires, here or on any peer that later receives this tree. The
    // assertion has to reach past the document.
    const peerA = ephemeralSubstrateFactory.fromEntirety(
      payload({ peers: { alice: [1, 100] } }),
      Roster,
    )
    peerA.merge(payload({ peers: { bob: [2, 200] } }))

    const tree = JSON.parse(peerA.exportEntirety().data as string) as {
      peers: Record<string, unknown>
    }
    expect(tree.peers.alice).toEqual([1, 100])
    expect(tree.peers.bob).toEqual([2, 200])
  })

  it("a key merely missing from an incoming payload is not a delete", () => {
    // `mergeStateTree` unions keys, so absence carries no information: a key
    // one peer lacks is indistinguishable from one it has never seen. This is
    // exactly why deletion has to be represented rather than expressed by
    // omission — see ephemeral-deletion.test.ts for the tombstone that does it.
    const peerA = ephemeralSubstrateFactory.fromEntirety(
      payload({ peers: { alice: [1, 100] } }),
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
      100,
      Mixed,
    )
    // `{a: 9}` is not a valid struct value — `tryValidate` rejects it — so
    // this is a caller past the type guard. The tree must not turn a partial
    // value into a removal.
    applyChangeToStateTree(
      tree,
      strPath,
      replaceChange(own({ a: 9 } as never)),
      500,
      Mixed,
    )

    expect(asRecord(tree).str).toEqual({ a: [9, 500], b: [2, 100] })
  })

  it("still deletes a written key a whole-value set omits", () => {
    const tree: StateTree = {}
    applyChangeToStateTree(
      tree,
      recPath,
      replaceChange(own({ x: 1, y: 2 })),
      100,
      Mixed,
    )
    applyChangeToStateTree(
      tree,
      recPath,
      replaceChange(own({ x: 5 })),
      200,
      Mixed,
    )

    // The case the rule must not break: under a map, omission IS removal, and
    // a removal has to be a tombstone so it survives the next merge.
    expect(asRecord(tree).rec).toEqual({ x: [5, 200], y: [null, 200, true] })
  })

  it("projects an emptied record as an empty record, not as absent", () => {
    const substrate = ephemeralSubstrateFactory.create(Roster)
    // biome-ignore lint/suspicious/noExplicitAny: the substrate suites read untyped
    const d: any = createRef(Roster, substrate)
    // biome-ignore lint/suspicious/noExplicitAny: see above
    batch(d, (w: any) => w.peers.set("alice", 1))
    // biome-ignore lint/suspicious/noExplicitAny: see above
    batch(d, (w: any) => w.peers.delete("alice"))

    // `peers` is a field of the root product, so it exists whatever happens to
    // its keys. Reading the shadow directly — the document read would supply a
    // structural zero and hide a disagreement.
    expect(substrate.reader.read(RawPath.empty)).toEqual({ peers: {} })
  })
})
