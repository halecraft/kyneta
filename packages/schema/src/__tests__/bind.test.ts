// bind — unit tests for BoundSchema, bind(), bindPlain, bindLww.

import { describe, expect, it, vi } from "vitest"
import { bind, bindLww, bindPlain, isBoundSchema } from "../bind.js"
import { Schema } from "../schema.js"
import { plainSubstrateFactory } from "../substrates/plain.js"

const testSchema = Schema.doc({
  title: Schema.string(),
  count: Schema.number(),
})

describe("bind()", () => {
  it("creates a BoundSchema with correct schema, factory, strategy", () => {
    const factory = vi.fn(() => plainSubstrateFactory)
    const bound = bind({
      schema: testSchema,
      factory,
      strategy: "causal",
    })

    expect(isBoundSchema(bound)).toBe(true)
    expect(bound.schema).toBe(testSchema)
    expect(bound.factory).toBe(factory)
    expect(bound.strategy).toBe("causal")
  })

  it("factory builder is called with { peerId } and returns a SubstrateFactory", () => {
    const factory = vi.fn(() => plainSubstrateFactory)
    const bound = bind({
      schema: testSchema,
      factory,
      strategy: "sequential",
    })

    const result = bound.factory({ peerId: "test-peer-123" })
    expect(factory).toHaveBeenCalledWith({ peerId: "test-peer-123" })
    expect(typeof result.create).toBe("function")
    expect(typeof result.fromSnapshot).toBe("function")
    expect(typeof result.parseVersion).toBe("function")
  })
})

describe("isBoundSchema()", () => {
  it("returns true for a BoundSchema", () => {
    const bound = bindPlain(testSchema)
    expect(isBoundSchema(bound)).toBe(true)
  })

  it("returns false for non-BoundSchema values", () => {
    expect(isBoundSchema(testSchema)).toBe(false)
    expect(isBoundSchema(null)).toBe(false)
    expect(isBoundSchema(undefined)).toBe(false)
    expect(isBoundSchema({ _brand: "NotBoundSchema" })).toBe(false)
  })
})

describe("bindPlain()", () => {
  it("creates a BoundSchema with sequential strategy", () => {
    const bound = bindPlain(testSchema)
    expect(bound.schema).toBe(testSchema)
    expect(bound.strategy).toBe("sequential")
  })
})

describe("bindLww()", () => {
  it("creates a BoundSchema with lww strategy", () => {
    const bound = bindLww(testSchema)
    expect(bound.schema).toBe(testSchema)
    expect(bound.strategy).toBe("lww")
  })
})