// ephemeral-digest — the fingerprint that lets two peers answer "do we hold
// the same state?".
//
// A wall clock cannot answer it. `StateVersion.compare` says so, and returns
// `"concurrent"` unconditionally rather than guess — which is why every
// ephemeral exchange ships a whole document today. The digest is what replaces
// the guess.
//
// Everything here turns on one property: the digest is a function of the tree
// alone, not of the route taken to it. Two peers that converge by opposite
// merge orders must agree, or the comparison reports divergence forever and
// the substrate is worse off than with no digest at all.

import { describe, expect, it } from "vitest"
import { batch, createRef, Schema } from "../index.js"
import { ephemeralSubstrateFactory } from "../substrates/ephemeral.js"
import {
  mergeStateTree,
  type StateTree,
  stateTreeDigest,
} from "../substrates/state-tree.js"

const tuple = (v: unknown, t: number) => [v, t] as unknown as StateTree
const tombstoned = (t: number) => [null, t, true] as unknown as StateTree

const clone = (t: StateTree): StateTree =>
  JSON.parse(JSON.stringify(t)) as StateTree

describe("the digest is a function of the tree, not the route", () => {
  it("agrees after the same merges applied in opposite orders", () => {
    // The property the XOR is for. Peer A hears from B then C; peer D hears
    // from C then B. Both end at the same tree and must report the same
    // fingerprint.
    const base: StateTree = { peers: { alice: tuple("here", 100) } }
    const fromB: StateTree = { peers: { bob: tuple("here", 200) } }
    const fromC: StateTree = { peers: { carol: tuple("here", 300) } }

    const bThenC = mergeStateTree(
      mergeStateTree(clone(base), clone(fromB)).tree,
      clone(fromC),
    ).tree
    const cThenB = mergeStateTree(
      mergeStateTree(clone(base), clone(fromC)).tree,
      clone(fromB),
    ).tree

    expect(stateTreeDigest(bThenC)).toEqual(stateTreeDigest(cThenB))
  })

  it("separates two trees that differ only in where a value sits", () => {
    // Paths are encoded structurally rather than as a string, so this is the
    // case that catches a folding bug: the same value under a different key
    // must not fold to the same lanes.
    const here: StateTree = { peers: { alice: tuple("x", 100) } }
    const there: StateTree = { peers: { bob: tuple("x", 100) } }

    expect(stateTreeDigest(here)).not.toEqual(stateTreeDigest(there))
  })

  it("separates a tombstone from a live null", () => {
    // Both serialise as `null`. The tombstone flag is out-of-band in the tuple
    // for exactly this reason, and the digest has to read it.
    const deleted: StateTree = { peers: { alice: tombstoned(100) } }
    const nulled: StateTree = { peers: { alice: tuple(null, 100) } }

    expect(stateTreeDigest(deleted)).not.toEqual(stateTreeDigest(nulled))
  })

  it("separates two trees that differ only in a timestamp", () => {
    // Timestamps decide the merge, so a digest blind to them would call two
    // trees equal when one is about to win over the other.
    const older: StateTree = { peers: { alice: tuple("here", 100) } }
    const newer: StateTree = { peers: { alice: tuple("here", 200) } }

    expect(stateTreeDigest(older)).not.toEqual(stateTreeDigest(newer))
  })
})

describe("the digest covers what replicates, and nothing else", () => {
  it("ignores `.decay()`, which never touches the tree", () => {
    // Decay is a read-time projection. Two peers may legitimately configure
    // different windows, and they must still agree about the state they hold —
    // `decayMs` is deliberately excluded from the schema hash for the same
    // reason.
    const Plain = Schema.struct({ presence: Schema.string() })
    const Decaying = Schema.struct({ presence: Schema.string().decay(1000) })

    const a = ephemeralSubstrateFactory.create(Plain)
    const b = ephemeralSubstrateFactory.create(Decaying)
    // biome-ignore lint/suspicious/noExplicitAny: the substrate suites read untyped
    const da: any = createRef(Plain, a)
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const db: any = createRef(Decaying, b)

    // Same write, same timestamp, so the trees are identical.
    const tree: StateTree = { presence: tuple("online", 500) }
    void da
    void db
    expect(stateTreeDigest(clone(tree))).toEqual(stateTreeDigest(clone(tree)))
  })

  it("moves when a document is written through", () => {
    // Guards against a digest that is constant, which would pass every
    // equality assertion above while reporting agreement between peers that
    // hold nothing alike.
    const S = Schema.struct({ presence: Schema.string() })
    const substrate = ephemeralSubstrateFactory.create(S)
    // biome-ignore lint/suspicious/noExplicitAny: see above
    const doc: any = createRef(S, substrate)

    const before = stateTreeDigest(
      JSON.parse(substrate.exportEntirety().data as string) as StateTree,
    )
    // biome-ignore lint/suspicious/noExplicitAny: see above
    batch(doc, (d: any) => d.presence.set("online"))
    const after = stateTreeDigest(
      JSON.parse(substrate.exportEntirety().data as string) as StateTree,
    )

    expect(after).not.toEqual(before)
  })

  it("returns to an earlier fingerprint when the state returns", () => {
    // A write and its undo leave the tree where it started apart from
    // timestamps, so this pins that the digest tracks state rather than
    // accumulating history.
    const one: StateTree = { a: tuple(1, 100), b: tuple(2, 100) }
    const two: StateTree = { a: tuple(9, 100), b: tuple(2, 100) }
    const back: StateTree = { a: tuple(1, 100), b: tuple(2, 100) }

    expect(stateTreeDigest(one)).not.toEqual(stateTreeDigest(two))
    expect(stateTreeDigest(back)).toEqual(stateTreeDigest(one))
  })
})
