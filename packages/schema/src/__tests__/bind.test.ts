// bind — unit tests for BoundSchema, bind(), json namespace, compile-time type constraints.

import { describe, expect, it, vi } from "vitest"
import { bind, isBoundSchema, json } from "../bind.js"
import { replaceChange } from "../change.js"
import { executeBatch } from "../interpreters/writable.js"
import { RawPath } from "../path.js"
import { Schema } from "../schema.js"
import type { SubstratePayload } from "../substrate.js"
import { lwwReplicaFactory } from "../substrates/lww.js"
import {
  plainReplicaFactory,
  plainSubstrateFactory,
} from "../substrates/plain.js"
import { TimestampVersion } from "../substrates/timestamp-version.js"

const testSchema = Schema.struct({
  title: Schema.string(),
  count: Schema.number(),
})

describe("bind()", () => {
  it("creates a BoundSchema with correct schema, factory, strategy", () => {
    const factory = vi.fn(() => plainSubstrateFactory)
    const bound = bind({
      schema: testSchema,
      factory,
      strategy: "collaborative",
    })

    expect(isBoundSchema(bound)).toBe(true)
    expect(bound.schema).toBe(testSchema)
    expect(bound.factory).toBe(factory)
    expect(bound.strategy).toBe("collaborative")
  })

  it("factory builder is called with { peerId } and returns a SubstrateFactory", () => {
    const factory = vi.fn(() => plainSubstrateFactory)
    const bound = bind({
      schema: testSchema,
      factory,
      strategy: "authoritative",
    })

    const result = bound.factory({ peerId: "test-peer-123" })
    expect(factory).toHaveBeenCalledWith({ peerId: "test-peer-123" })
    expect(typeof result.create).toBe("function")
    expect(typeof result.fromEntirety).toBe("function")
    expect(typeof result.parseVersion).toBe("function")
  })
})

describe("isBoundSchema()", () => {
  it("returns true for a BoundSchema", () => {
    const bound = json.bind(testSchema)
    expect(isBoundSchema(bound)).toBe(true)
  })

  it("returns false for non-BoundSchema values", () => {
    expect(isBoundSchema(testSchema)).toBe(false)
    expect(isBoundSchema(null)).toBe(false)
    expect(isBoundSchema(undefined)).toBe(false)
    expect(isBoundSchema({ _brand: "NotBoundSchema" })).toBe(false)
  })
})

describe("json.bind()", () => {
  it("creates a BoundSchema with authoritative strategy", () => {
    const bound = json.bind(testSchema)
    expect(bound.schema).toBe(testSchema)
    expect(bound.strategy).toBe("authoritative")
  })
})

describe("json.replica()", () => {
  it("produces a BoundReplica with authoritative strategy and plainReplicaFactory", () => {
    const replica = json.replica()
    expect(replica.strategy).toBe("authoritative")
    expect(replica.factory).toBe(plainReplicaFactory)
    expect(replica.factory.replicaType).toEqual(["plain", 1, 0])
  })

  it("json.replica('ephemeral') produces a BoundReplica with ephemeral strategy and lwwReplicaFactory", () => {
    const replica = json.replica("ephemeral")
    expect(replica.strategy).toBe("ephemeral")
    expect(replica.factory).toBe(lwwReplicaFactory)
    expect(replica.factory.replicaType).toEqual(["plain", 1, 0])
  })
})

describe("compile-time type constraints", () => {
  it("json.bind rejects 'collaborative' strategy (compile-time + runtime)", () => {
    // @ts-expect-error — "collaborative" not assignable to JsonStrategy
    expect(() => json.bind(testSchema, "collaborative")).toThrow()
  })

  it("json.replica rejects 'collaborative' strategy (compile-time + runtime)", () => {
    // @ts-expect-error — "collaborative" not assignable to JsonStrategy
    expect(() => json.replica("collaborative")).toThrow()
  })

  it("json.bind rejects bare list at root", () => {
    // @ts-expect-error — SequenceSchema is not ProductSchema
    json.bind(Schema.list(Schema.string()))
  })

  it("json.bind rejects bare record at root", () => {
    // @ts-expect-error — MapSchema is not ProductSchema
    json.bind(Schema.record(Schema.string()))
  })

  it("json.bind rejects bare text at root", () => {
    // @ts-expect-error — TextSchema is not ProductSchema
    json.bind(Schema.text())
  })

  it("json.bind rejects bare scalar at root", () => {
    // @ts-expect-error — ScalarSchema is not ProductSchema
    json.bind(Schema.string())
  })

  it("json.bind rejects list of structs at root", () => {
    // @ts-expect-error — SequenceSchema<ProductSchema> is still not ProductSchema
    json.bind(Schema.list(Schema.struct({ name: Schema.string() })))
  })
})

describe("json.bind(ephemeral)", () => {
  it("creates a BoundSchema with ephemeral strategy", () => {
    const bound = json.bind(testSchema, "ephemeral")
    expect(bound.schema).toBe(testSchema)
    expect(bound.strategy).toBe("ephemeral")
  })

  it("factory produces a substrate with TimestampVersion", () => {
    const bound = json.bind(testSchema, "ephemeral")
    const factory = bound.factory({ peerId: "test-peer" })
    const substrate = factory.create(testSchema)

    expect(substrate.version()).toBeInstanceOf(TimestampVersion)
  })

  it("substrate bumps TimestampVersion on flush", () => {
    const bound = json.bind(testSchema, "ephemeral")
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
    const bound = json.bind(testSchema, "ephemeral")
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

  it("fromEntirety starts with a current timestamp (not zero)", () => {
    const bound = json.bind(testSchema, "ephemeral")
    const factory = bound.factory({ peerId: "test-peer" })

    // Create a substrate and export its snapshot
    const source = factory.create(testSchema)
    executeBatch(source.context(), [
      { path: RawPath.empty.field("title"), change: replaceChange("hello") },
    ])
    const snapshot = source.exportEntirety()

    // Reconstruct from entirety — version should be current wall clock, not 0
    const before = Date.now()
    const reconstructed = factory.fromEntirety(snapshot, testSchema)
    const ts = (reconstructed.version() as TimestampVersion).timestamp
    expect(ts).toBeGreaterThanOrEqual(before)
  })

  it("merge with entirety payload absorbs state and bumps timestamp", () => {
    const bound = json.bind(testSchema, "ephemeral")
    const factory = bound.factory({ peerId: "test-peer" })
    const substrate = factory.create(testSchema)

    expect((substrate.version() as TimestampVersion).timestamp).toBe(0)

    const entirety: SubstratePayload = {
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({ title: "LWW merged", count: 42 }),
    }
    substrate.merge(entirety, "sync")

    const ts = (substrate.version() as TimestampVersion).timestamp
    expect(ts).toBeGreaterThan(0)

    const snap = substrate.exportEntirety()
    const state = JSON.parse(snap.data as string)
    expect(state.title).toBe("LWW merged")
    expect(state.count).toBe(42)
  })

  it("merge with since payload applies ops and bumps timestamp", () => {
    const bound = json.bind(testSchema, "ephemeral")
    const factory = bound.factory({ peerId: "test-peer" })

    // Create source substrate, mutate, export delta
    const source = factory.create(testSchema)
    executeBatch(source.context(), [
      { path: RawPath.empty.field("title"), change: replaceChange("delta") },
    ])
    const v0Before = source.version()
    executeBatch(source.context(), [
      { path: RawPath.empty.field("count"), change: replaceChange(7) },
    ])
    // Ephemeral's exportSince delegates to exportEntirety — it always sends
    // the full state. The kind is "entirety", not "since".
    const payload = source.exportSince(v0Before)
    expect(payload).not.toBeNull()
    expect(payload?.kind).toBe("entirety")

    // Apply to target — merge handles "entirety" payloads correctly
    const target = factory.create(testSchema)
    target.merge(payload!)

    const ts = (target.version() as TimestampVersion).timestamp
    expect(ts).toBeGreaterThan(0)

    const snap = target.exportEntirety()
    const state = JSON.parse(snap.data as string)
    expect(state.count).toBe(7)
  })
})
