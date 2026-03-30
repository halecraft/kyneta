// bind — unit tests for BoundSchema, bind(), bindPlain, bindEphemeral.

import { describe, expect, it, vi } from "vitest"
import { bind, bindEphemeral, bindPlain, isBoundSchema } from "../bind.js"
import { executeBatch } from "../interpreters/writable.js"
import { RawPath } from "../path.js"
import { Schema } from "../schema.js"
import { replaceChange } from "../change.js"
import { plainSubstrateFactory } from "../substrates/plain.js"
import { TimestampVersion } from "../substrates/timestamp-version.js"

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

describe("bindEphemeral()", () => {
  it("creates a BoundSchema with lww strategy", () => {
    const bound = bindEphemeral(testSchema)
    expect(bound.schema).toBe(testSchema)
    expect(bound.strategy).toBe("lww")
  })

  it("factory produces a substrate with TimestampVersion", () => {
    const bound = bindEphemeral(testSchema)
    const factory = bound.factory({ peerId: "test-peer" })
    const substrate = factory.create(testSchema)

    expect(substrate.version()).toBeInstanceOf(TimestampVersion)
  })

  it("substrate bumps TimestampVersion on flush", () => {
    const bound = bindEphemeral(testSchema)
    const factory = bound.factory({ peerId: "test-peer" })
    const substrate = factory.create(testSchema)

    const versionBefore = substrate.version()
    expect(versionBefore).toBeInstanceOf(TimestampVersion)
    expect((versionBefore as TimestampVersion).timestamp).toBe(0)

    // Trigger prepare → flush via executeBatch
    executeBatch(substrate.context(), [
      { path: RawPath.empty.field("title"), change: replaceChange("hello") },
    ])

    const versionAfter = substrate.version()
    expect(versionAfter).toBeInstanceOf(TimestampVersion)
    expect((versionAfter as TimestampVersion).timestamp).toBeGreaterThan(0)
  })

  it("each mutation advances the timestamp (monotonic wall clock)", () => {
    const bound = bindEphemeral(testSchema)
    const factory = bound.factory({ peerId: "test-peer" })
    const substrate = factory.create(testSchema)

    const ts0 = (substrate.version() as TimestampVersion).timestamp
    expect(ts0).toBe(0)

    executeBatch(substrate.context(), [
      { path: RawPath.empty.field("title"), change: replaceChange("v1") },
    ])
    const ts1 = (substrate.version() as TimestampVersion).timestamp

    executeBatch(substrate.context(), [
      { path: RawPath.empty.field("title"), change: replaceChange("v2") },
    ])
    const ts2 = (substrate.version() as TimestampVersion).timestamp

    // Each flush should produce a wall-clock timestamp >= the previous
    expect(ts1).toBeGreaterThan(0)
    expect(ts2).toBeGreaterThanOrEqual(ts1)
  })

  it("fromSnapshot starts with a current timestamp (not zero)", () => {
    const bound = bindEphemeral(testSchema)
    const factory = bound.factory({ peerId: "test-peer" })

    // Create a substrate and export its snapshot
    const source = factory.create(testSchema)
    executeBatch(source.context(), [
      { path: RawPath.empty.field("title"), change: replaceChange("hello") },
    ])
    const snapshot = source.exportSnapshot()

    // Reconstruct from snapshot — version should be current wall clock, not 0
    const before = Date.now()
    const reconstructed = factory.fromSnapshot(snapshot, testSchema)
    const ts = (reconstructed.version() as TimestampVersion).timestamp
    expect(ts).toBeGreaterThanOrEqual(before)
  })
})