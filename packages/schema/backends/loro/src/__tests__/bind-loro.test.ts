// loro.bind() and unwrap() escape hatch — unit tests.

import {
  createDoc,
  createRef,
  isBoundSchema,
  plainSubstrateFactory,
  Schema,
  SUBSTRATE,
  unwrap,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { loro } from "../bind-loro.js"

const testSchema = Schema.struct({
  title: Schema.text(),
  count: Schema.counter(),
  items: Schema.list(Schema.struct.json({ name: Schema.string() })),
})

describe("loro.bind()", () => {
  it("creates a BoundSchema with collaborative strategy", () => {
    const bound = loro.bind(testSchema)
    expect(isBoundSchema(bound)).toBe(true)
    expect(bound.schema).toBe(testSchema)
    expect(bound.strategy).toBe("collaborative")
  })

  it("factory builder produces a working SubstrateFactory", () => {
    const bound = loro.bind(testSchema)
    const factory = bound.factory({ peerId: "test-peer-abc" })

    // Create a substrate and verify it works
    const substrate = factory.create(testSchema)
    expect(substrate.version().serialize()).toBeDefined()
    expect(substrate.exportEntirety()).toBeDefined()
  })

  it("same peerId always produces the same Loro PeerID (deterministic hash)", () => {
    const bound = loro.bind(testSchema)

    // Create two factories from the same peerId
    const factory1 = bound.factory({ peerId: "alice-laptop-7f3a" })
    const factory2 = bound.factory({ peerId: "alice-laptop-7f3a" })

    // Create docs and check their peerIdStr matches
    const sub1 = factory1.create(testSchema)
    const sub2 = factory2.create(testSchema)

    // Use createRef to build full-stack refs, then unwrap to get LoroDoc
    const ref1 = createRef(testSchema, sub1)
    const ref2 = createRef(testSchema, sub2)

    const doc1 = unwrap(ref1)
    const doc2 = unwrap(ref2)

    // Critical invariant: deterministic — same input → same output
    expect(doc1.peerIdStr).toBe(doc2.peerIdStr)

    // And different peerId → different PeerID
    const factory3 = bound.factory({ peerId: "bob-desktop-9c2d" })
    const sub3 = factory3.create(testSchema)
    const ref3 = createRef(testSchema, sub3)
    const doc3 = unwrap(ref3)

    expect(doc3.peerIdStr).not.toBe(doc1.peerIdStr)
  })
})

describe("unwrap() escape hatch", () => {
  it("returns the underlying LoroDoc for a root ref created via createDoc", () => {
    const doc = createDoc(loro.bind(testSchema))

    const loroDoc = unwrap(doc as any)
    expect(typeof loroDoc.toJSON).toBe("function")
    expect(typeof loroDoc.getText).toBe("function")
  })

  it("returns undefined for a bare object with no [NATIVE]", () => {
    // The generic unwrap() reads [NATIVE]; a bare object has no such property.
    const native = unwrap({} as any)
    expect(native).toBeUndefined()
  })

  it("returns non-LoroDoc native for refs with a non-Loro substrate", () => {
    const schema = Schema.struct({ title: Schema.string() })
    const substrate = plainSubstrateFactory.create(schema)
    const fakeRef = createRef(schema, substrate)

    // unwrap returns the [NATIVE] value — for plain substrate the root
    // ref's [NATIVE] is the plain state object, not a LoroDoc.
    const native = unwrap(fakeRef)
    expect(native).toBeDefined()
    // It should NOT have LoroDoc-specific methods like getText
    expect((native as any).getText).toBeUndefined()
  })
})

describe("compile-time type constraints", () => {
  it("loro.bind rejects 'sequential' strategy (compile-time + runtime)", () => {
    // @ts-expect-error — "sequential" not assignable to CrdtStrategy
    expect(() => loro.bind(testSchema, "sequential")).toThrow()
  })

  it("loro.replica rejects 'sequential' strategy (compile-time + runtime)", () => {
    // @ts-expect-error — "sequential" not assignable to CrdtStrategy
    expect(() => loro.replica("sequential")).toThrow()
  })
})

describe("[SUBSTRATE] on refs created via createDoc", () => {
  it("root ref carries the substrate via [SUBSTRATE] symbol", () => {
    const doc = createDoc(loro.bind(testSchema))
    const substrate = (doc as any)[SUBSTRATE]
    expect(substrate).toBeDefined()
    expect(typeof substrate.version).toBe("function")
    expect(typeof substrate.exportEntirety).toBe("function")
  })
})
