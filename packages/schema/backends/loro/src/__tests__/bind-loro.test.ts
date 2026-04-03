// bindLoro and loro() escape hatch — unit tests.

import {
  change,
  isBoundSchema,
  plainSubstrateFactory,
  registerSubstrate,
  Schema,
  unwrap,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { bindLoro } from "../bind-loro.js"
import { createLoroDoc, getSubstrate } from "../create.js"
import { loro } from "../loro-escape.js"
import { LoroSchema } from "../loro-schema.js"

const testSchema = LoroSchema.doc({
  title: LoroSchema.text(),
  count: LoroSchema.counter(),
  items: Schema.list(Schema.struct({ name: Schema.string() })),
})

describe("bindLoro()", () => {
  it("creates a BoundSchema with causal strategy", () => {
    const bound = bindLoro(testSchema)
    expect(isBoundSchema(bound)).toBe(true)
    expect(bound.schema).toBe(testSchema)
    expect(bound.strategy).toBe("causal")
  })

  it("factory builder produces a working SubstrateFactory", () => {
    const bound = bindLoro(testSchema)
    const factory = bound.factory({ peerId: "test-peer-abc" })

    // Create a substrate and verify it works
    const substrate = factory.create(testSchema)
    expect(substrate.version().serialize()).toBeDefined()
    expect(substrate.exportEntirety()).toBeDefined()
  })

  it("same peerId always produces the same Loro PeerID (deterministic hash)", () => {
    const bound = bindLoro(testSchema)

    // Create two factories from the same peerId
    const factory1 = bound.factory({ peerId: "alice-laptop-7f3a" })
    const factory2 = bound.factory({ peerId: "alice-laptop-7f3a" })

    // Create docs and check their peerIdStr matches
    const sub1 = factory1.create(testSchema)
    const sub2 = factory2.create(testSchema)

    // Use the loro escape hatch to get the LoroDoc and check peerIdStr
    const ref1 = { _test: 1 }
    const ref2 = { _test: 2 }
    registerSubstrate(ref1, sub1)
    registerSubstrate(ref2, sub2)

    const doc1 = loro(ref1)
    const doc2 = loro(ref2)

    // Critical invariant: deterministic — same input → same output
    expect(doc1.peerIdStr).toBe(doc2.peerIdStr)

    // And different peerId → different PeerID
    const factory3 = bound.factory({ peerId: "bob-desktop-9c2d" })
    const sub3 = factory3.create(testSchema)
    const ref3 = { _test: 3 }
    registerSubstrate(ref3, sub3)
    const doc3 = loro(ref3)

    expect(doc3.peerIdStr).not.toBe(doc1.peerIdStr)
  })
})

describe("loro() escape hatch", () => {
  it("returns the underlying LoroDoc for a root ref created via createLoroDoc", () => {
    const doc = createLoroDoc(testSchema)

    // createLoroDoc registers in its internal WeakMap but not in the
    // general unwrap() registry (that's the exchange's job). Bridge manually.
    const substrate = getSubstrate(doc)
    registerSubstrate(doc, substrate)

    const loroDoc = loro(doc)
    expect(typeof loroDoc.toJSON).toBe("function")
    expect(typeof loroDoc.getText).toBe("function")
  })

  it("throws for non-Loro refs", () => {
    expect(() => loro({})).toThrow("loro()")
  })

  it("throws for refs with a non-Loro substrate", () => {
    const substrate = plainSubstrateFactory.create(
      Schema.doc({ title: Schema.string() }),
    )
    const fakeRef = { _fake: true }
    registerSubstrate(fakeRef, substrate)

    expect(() => loro(fakeRef)).toThrow("not a Loro substrate")
  })
})
