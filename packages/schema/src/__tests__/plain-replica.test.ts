// plain-replica — the replica's state is frozen and shared, never deep-copied:
// its base stays frozen, so no replay and no upgraded substrate can change it.
import { describe, expect, it } from "vitest"
import { isDeeplyFrozen } from "../clone.js"
import {
  BACKING_DOC,
  batch,
  createRef,
  createSubstrate,
  hasBackingDoc,
  type PlainState,
  plainSubstrateFactory,
  replicaFromEntirety,
  Schema,
} from "../index.js"

const Doc = Schema.struct({
  title: Schema.string(),
  rows: Schema.record(Schema.struct({ n: Schema.number() })),
})

/** A source document with `count` batches, one row each. */
function source(count: number) {
  const substrate = createSubstrate(plainSubstrateFactory, Doc)
  const doc = createRef(Doc, substrate)
  for (let i = 0; i < count; i++) {
    batch(doc, (d: any) => d.rows.set(`r${i}`, { n: i }))
  }
  return { substrate, doc }
}

function stateOf(replica: unknown): PlainState {
  if (!hasBackingDoc<PlainState>(replica)) throw new Error("no backing doc")
  return replica[BACKING_DOC]
}

describe("the plain replica", () => {
  it("after merge, its materialized state is deeply frozen", () => {
    const { substrate } = source(3)
    const replica = plainSubstrateFactory.replica.createEmpty()
    replica.merge(substrate.exportSince(replica.version()) ?? fail())
    const state = stateOf(replica)
    expect(state).toEqual({
      rows: { r0: { n: 0 }, r1: { n: 1 }, r2: { n: 2 } },
    })
    expect(isDeeplyFrozen(state)).toBe(true)
  })

  it("after adopt, after a partial advance, and after materialize, its state is deeply frozen", () => {
    const { substrate } = source(2)
    const replica = plainSubstrateFactory.replica.createEmpty()
    replica.resetFromEntirety(substrate.exportEntirety())
    expect(isDeeplyFrozen(stateOf(replica))).toBe(true)

    const more = source(0)
    const writer = createRef(Doc, more.substrate)
    more.substrate.resetFromEntirety(substrate.exportEntirety())
    const from = more.substrate.version()
    batch(writer, (d: any) => d.title.set("a"))
    const middle = more.substrate.version()
    batch(writer, (d: any) => d.title.set("b"))
    replica.merge(more.substrate.exportSince(from) ?? fail())

    replica.advance(middle)
    expect(isDeeplyFrozen(stateOf(replica))).toBe(true)
    expect(stateOf(replica).title).toBe("b")
  })

  it("a substrate upgraded from it writes without changing its next export", () => {
    const { substrate } = source(2)
    const replica = plainSubstrateFactory.replica.createEmpty()
    replica.merge(substrate.exportSince(replica.version()) ?? fail())
    const exported = replica.exportEntirety()

    const upgraded = plainSubstrateFactory.upgrade(replica, Doc)
    const doc = createRef(Doc, upgraded)
    batch(doc, (d: any) => {
      d.rows.at("r0").n.set(99)
      d.title.set("changed")
    })

    expect(doc.rows.at("r0").n()).toBe(99)
    expect(replica.exportEntirety()).toEqual(exported)
  })
})

function fail(): never {
  throw new Error("expected a payload")
}

describe("the plain log takes what a batch did", () => {
  it("an aborted batch logs nothing and leaves the version", () => {
    const substrate = createSubstrate(plainSubstrateFactory, Doc)
    const doc: any = createRef(Doc, substrate)
    batch(doc, (d: any) => d.title.set("kept"))
    const before = substrate.version()
    expect(() =>
      batch(doc, (d: any) => {
        d.title.set("gone")
        throw new Error("abort")
      }),
    ).toThrow("abort")
    expect(substrate.version().compare(before)).toBe("equal")
    expect(doc.title()).toBe("kept")
  })

  it("a batch that absorbed an inner abort logs only what survived", () => {
    const substrate = createSubstrate(plainSubstrateFactory, Doc)
    const doc: any = createRef(Doc, substrate)
    const since = substrate.version()
    batch(doc, (d: any) => {
      d.title.set("outer")
      try {
        batch(doc, (e: any) => {
          e.rows.set("r", { n: 1 })
          throw new Error("inner")
        })
      } catch {
        // absorbed
      }
    })

    const peer = createSubstrate(plainSubstrateFactory, Doc)
    peer.merge(substrate.exportSince(since) ?? fail())
    expect(createRef(Doc, peer)()).toEqual(doc())
    expect(doc()).toEqual({ title: "outer", rows: {} })
  })
})

describe("replicaFromEntirety on plain", () => {
  it("is at the sender's version, lineage and position, not at count 1", () => {
    // A whole document is adopted at its log position: a replica that logged
    // it as one batch would disagree with the sender on every later delta.
    const { substrate } = source(3)
    const replica = replicaFromEntirety(
      plainSubstrateFactory.replica,
      substrate.exportEntirety(),
    )
    expect(replica.version().serialize()).toBe(substrate.version().serialize())
    expect(replica.version().lineage).toBe(substrate.version().lineage)
    const delta = substrate.exportSince(replica.version())
    expect(delta?.kind).toBe("since")
  })
})
