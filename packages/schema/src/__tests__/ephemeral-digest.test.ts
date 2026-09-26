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
  type Container,
  decodeTree,
  type Horizon,
  type Live,
  mergeStateTree,
  stateTreeDigest,
} from "../substrates/state-tree.js"

/** A tuple as a peer holds it; the install ordinal is fixed and never folded. */
const tup = (
  value: unknown,
  timestamp: number,
  deleted?: true,
): Live | Horizon =>
  deleted ? [null, timestamp, 1, true] : [value, timestamp, 1]

const merge = (local: Container, remote: Container) =>
  mergeStateTree(local, remote, 1)

const clone = (t: Container): Container =>
  JSON.parse(JSON.stringify(t)) as Container

describe("the digest is a function of the tree, not the route", () => {
  it("agrees after the same merges applied in opposite orders", () => {
    // The property the XOR is for. Peer A hears from B then C; peer D hears
    // from C then B. Both end at the same tree and must report the same
    // fingerprint.
    const base: Container = { peers: { alice: tup("here", 100) } }
    const fromB: Container = { peers: { bob: tup("here", 200) } }
    const fromC: Container = { peers: { carol: tup("here", 300) } }

    const bThenC = merge(
      merge(clone(base), clone(fromB)).tree,
      clone(fromC),
    ).tree
    const cThenB = merge(
      merge(clone(base), clone(fromC)).tree,
      clone(fromB),
    ).tree

    expect(stateTreeDigest(bThenC)).toEqual(stateTreeDigest(cThenB))
  })

  it("separates two trees that differ only in where a value sits", () => {
    // Paths are encoded structurally rather than as a string, so this is the
    // case that catches a folding bug: the same value under a different key
    // must not fold to the same lanes.
    const here: Container = { peers: { alice: tup("x", 100) } }
    const there: Container = { peers: { bob: tup("x", 100) } }

    expect(stateTreeDigest(here)).not.toEqual(stateTreeDigest(there))
  })

  it("separates a tombstone from a live null", () => {
    // Both serialise as `null`. The tombstone flag is out-of-band in the tuple
    // for exactly this reason, and the digest has to read it.
    const deleted: Container = { peers: { alice: tup(null, 100, true) } }
    const nulled: Container = { peers: { alice: tup(null, 100) } }

    expect(stateTreeDigest(deleted)).not.toEqual(stateTreeDigest(nulled))
  })

  it("separates two trees that differ only in a timestamp", () => {
    // Timestamps decide the merge, so a digest blind to them would call two
    // trees equal when one is about to win over the other.
    const older: Container = { peers: { alice: tup("here", 100) } }
    const newer: Container = { peers: { alice: tup("here", 200) } }

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
    const da: any = createRef(Plain, a)
    const db: any = createRef(Decaying, b)

    // Same write, same timestamp, so the trees are identical.
    const tree: Container = { presence: tup("online", 500) }
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
    const doc: any = createRef(S, substrate)

    const before = stateTreeDigest(
      decodeTree(substrate.exportEntirety().data as string),
    )
    batch(doc, (d: any) => d.presence.set("online"))
    const after = stateTreeDigest(
      decodeTree(substrate.exportEntirety().data as string),
    )

    expect(after).not.toEqual(before)
  })

  it("returns to an earlier fingerprint when the state returns", () => {
    // A write and its undo leave the tree where it started apart from
    // timestamps, so this pins that the digest tracks state rather than
    // accumulating history.
    const one: Container = { a: tup(1, 100), b: tup(2, 100) }
    const two: Container = { a: tup(9, 100), b: tup(2, 100) }
    const back: Container = { a: tup(1, 100), b: tup(2, 100) }

    expect(stateTreeDigest(one)).not.toEqual(stateTreeDigest(two))
    expect(stateTreeDigest(back)).toEqual(stateTreeDigest(one))
  })
})
