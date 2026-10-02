// loro.bind() and unwrap() escape hatch — unit tests.
//
// Tests verify that loro.bind() produces a BoundSchema with the
// collaborative sync protocol, deterministic peer identity, and
// correct unwrap() escape hatch behavior.

import {
  createDoc,
  createRef,
  createSubstrate,
  isBoundSchema,
  plainSubstrateFactory,
  Schema,
  SUBSTRATE,
  unwrap,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { loro, loroPeerId } from "../bind-loro.js"

const testSchema = Schema.struct({
  title: Schema.text(),
  count: Schema.counter(),
  items: Schema.list(Schema.struct.json({ name: Schema.string() })),
})

describe("loro.bind()", () => {
  it("creates a BoundSchema with collaborative sync protocol", () => {
    const bound = loro.bind(testSchema)
    expect(isBoundSchema(bound)).toBe(true)
    expect(bound.schema).toBe(testSchema)
    expect(bound.syncMode).toEqual({
      writerModel: "concurrent",
      durability: "persistent",
    })
  })

  it("factory builder produces a working SubstrateFactory", () => {
    const bound = loro.bind(testSchema)
    const factory = bound.factory({
      peerId: "test-peer-abc",
      binding: bound.identityBinding,
    })

    // Create a substrate and verify it works
    const substrate = createSubstrate(factory, testSchema)
    expect(substrate.version().serialize()).toBeDefined()
    expect(substrate.exportEntirety()).toBeDefined()
  })

  it("every document claims loroPeerId of the peer id", () => {
    const peerIdOf = (peerId: string): string => {
      // A fresh bind per document stands in for a restart.
      const bound = loro.bind(testSchema)
      const factory = bound.factory({ peerId, binding: bound.identityBinding })
      return unwrap(createRef(testSchema, createSubstrate(factory, testSchema)))
        .peerIdStr
    }

    expect(peerIdOf("alice-laptop-7f3a")).toBe(loroPeerId("alice-laptop-7f3a"))
    expect(peerIdOf("alice-laptop-7f3a")).toBe(loroPeerId("alice-laptop-7f3a"))
    expect(peerIdOf("bob-desktop-9c2d")).not.toBe(peerIdOf("alice-laptop-7f3a"))
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
    const substrate = createSubstrate(plainSubstrateFactory, schema)
    const fakeRef = createRef(schema, substrate)

    // unwrap returns the [NATIVE] value — for plain substrate the root
    // ref's [NATIVE] is the plain state object, not a LoroDoc.
    const native = unwrap(fakeRef)
    expect(native).toBeDefined()
    // It should NOT have LoroDoc-specific methods like getText
    expect((native as any).getText).toBeUndefined()
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
