// advance — the `Replica` contract, on a live substrate and on a relay's
// replica: throw only for a target beyond the current version; otherwise trim
// as far as the replica can, which for a live substrate is nothing.

import {
  batch,
  createRef,
  createSubstrate,
  planAdvance,
  Schema,
  type Version,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { loro } from "../bind-loro.js"

const bound = loro.bind(Schema.struct({ title: Schema.text() }))

/** A live substrate for `peerId`, and its ref. */
function live(peerId: string) {
  const factory = bound.factory({ peerId, binding: bound.identityBinding })
  const substrate = createSubstrate(factory, bound.schema)
  return { factory, substrate, doc: createRef(bound.schema, substrate) }
}

function write(doc: ReturnType<typeof live>["doc"], text: string): void {
  batch(doc, d => d.title.insert(d.title().length, text))
}

describe("loro live substrate advance", () => {
  it("trims nothing, at, below, or concurrent with the current version", () => {
    const { substrate, doc } = live("alice")
    write(doc, "one")
    const earlier = substrate.version()
    write(doc, "two")
    const other = live("bob")
    write(other.doc, "theirs")
    const base = substrate.baseVersion()
    const bytes = substrate.exportEntirety()

    for (const to of [
      substrate.version(),
      earlier,
      other.substrate.version(),
    ]) {
      substrate.advance(to)
      expect(substrate.baseVersion().serialize()).toBe(base.serialize())
      expect(doc.title()).toBe("onetwo")
    }
    expect(substrate.exportEntirety().data).toEqual(bytes.data)
  })

  it("throws for a target beyond the current version", () => {
    const { substrate, doc } = live("alice")
    write(doc, "one")
    const ahead = live("alice-ahead")
    ahead.substrate.merge(substrate.exportEntirety())
    write(ahead.doc, "more")
    expect(() => substrate.advance(ahead.substrate.version())).toThrow(
      "ahead of current version",
    )
  })
})

describe("loro replica advance", () => {
  /** A relay's replica holding `substrate`'s document. */
  function relayOf(source: ReturnType<typeof live>) {
    const replica = source.factory.replica.createEmpty()
    replica.merge(source.substrate.exportEntirety())
    return replica
  }

  it("trims to the current version, and still serves deltas from there", () => {
    const source = live("alice")
    write(source.doc, "one")
    const replica = relayOf(source)
    const before = replica.baseVersion()
    const target = replica.version()
    replica.advance(target)
    // The base moved, and did not pass the target.
    expect(replica.baseVersion().compare(before)).toBe("ahead")
    expect(["behind", "equal"]).toContain(replica.baseVersion().compare(target))

    write(source.doc, "two")
    const delta = source.substrate.exportSince(replica.version())
    if (delta === null) throw new Error("expected a delta")
    replica.merge(delta)
    expect(replica.exportSince(replica.baseVersion())).not.toBeNull()
  })

  it("trims nothing, and does not throw, for a target behind or concurrent with its base", () => {
    const source = live("alice")
    write(source.doc, "one")
    const behind = source.substrate.version()
    write(source.doc, "two")
    const replica = relayOf(source)
    replica.advance(replica.version())
    const base = replica.baseVersion()

    const other = live("bob")
    write(other.doc, "theirs")
    const targets: Version[] = [behind, other.substrate.version()]
    for (const to of targets) {
      expect(planAdvance({ base, current: replica.version(), to })).toBe(
        "nothing",
      )
      expect(() => replica.advance(to)).not.toThrow()
      expect(replica.baseVersion().serialize()).toBe(base.serialize())
    }
  })

  it("throws for a target beyond the current version", () => {
    const source = live("alice")
    write(source.doc, "one")
    const replica = relayOf(source)
    write(source.doc, "two")
    expect(() => replica.advance(source.substrate.version())).toThrow(
      "ahead of current version",
    )
  })

  it("trims to a target between its base and its current version", () => {
    const source = live("alice")
    write(source.doc, "one")
    const middle = source.substrate.version()
    write(source.doc, "two")
    const replica = relayOf(source)
    const before = replica.baseVersion()

    expect(
      planAdvance({ base: before, current: replica.version(), to: middle }),
    ).toBe("trim")
    replica.advance(middle)
    expect(replica.baseVersion().compare(before)).toBe("ahead")
    expect(["behind", "equal"]).toContain(replica.baseVersion().compare(middle))
    // Everything after the new base is still served.
    const since = replica.exportSince(middle)
    if (since === null) throw new Error("expected a delta")
    const reader = live("reader")
    reader.substrate.merge(replica.exportEntirety())
    expect(reader.doc.title()).toBe("onetwo")
  })
})
