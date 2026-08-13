// bind — unit tests for BoundSchema, bind(), the json/ephemeral binding
// targets, and compile-time type constraints.
//
// The law contract each target enforces — which schemas bind and which are
// rejected at compile time — is asserted in the dedicated `bind-constraints-*`
// suites rather than here: see `bind-constraints-ephemeral.test.ts` and the
// equivalents in the loro/yjs backends. Those rely on `@ts-expect-error`, so
// `tsc` is the assertion and the test runner only reports it.

import { describe, expect, it, vi } from "vitest"
import { bind, ephemeral, isBoundSchema, json } from "../bind.js"
import { replaceChange } from "../change.js"
import { executeBatch } from "../interpreters/writable.js"
import { RawPath } from "../path.js"
import { Schema } from "../schema.js"
import {
  SYNC_AUTHORITATIVE,
  SYNC_COLLABORATIVE,
  SYNC_EPHEMERAL,
} from "../substrate.js"
import {
  ephemeralReplicaFactory,
  StateVersion,
} from "../substrates/ephemeral.js"
import {
  plainReplicaFactory,
  plainSubstrateFactory,
} from "../substrates/plain.js"

const testSchema = Schema.struct({
  title: Schema.string(),
  count: Schema.number(),
})

describe("bind()", () => {
  it("creates a BoundSchema with correct schema, factory, syncMode", () => {
    const factory = vi.fn(() => plainSubstrateFactory)
    const bound = bind({
      schema: testSchema,
      factory,
      replicaType: plainReplicaFactory.replicaType,
      syncMode: SYNC_COLLABORATIVE,
    })

    expect(isBoundSchema(bound)).toBe(true)
    expect(bound.schema).toBe(testSchema)
    expect(bound.factory).toBe(factory)
    expect(bound.syncMode).toBe(SYNC_COLLABORATIVE)
  })

  it("factory builder is called with { peerId } and returns a SubstrateFactory", () => {
    const factory = vi.fn(() => plainSubstrateFactory)
    const bound = bind({
      schema: testSchema,
      factory,
      replicaType: plainReplicaFactory.replicaType,
      syncMode: SYNC_AUTHORITATIVE,
    })

    const result = bound.factory({
      peerId: "test-peer-123",
      binding: bound.identityBinding,
    })
    expect(factory).toHaveBeenCalledWith({
      peerId: "test-peer-123",
      binding: bound.identityBinding,
    })
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
  it("creates a BoundSchema with authoritative syncMode", () => {
    const bound = json.bind(testSchema)
    expect(bound.schema).toBe(testSchema)
    expect(bound.syncMode).toBe(SYNC_AUTHORITATIVE)
  })
})

describe("json.replica()", () => {
  it("produces a BoundReplica with authoritative syncMode and plainReplicaFactory", () => {
    const replica = json.replica()
    expect(replica.syncMode).toBe(SYNC_AUTHORITATIVE)
    expect(replica.factory).toBe(plainReplicaFactory)
    expect(replica.factory.replicaType).toEqual(["plain", 1, 0])
  })
})

describe("json binding target", () => {
  it("exposes SYNC_AUTHORITATIVE as its syncMode", () => {
    expect(json.syncMode).toBe(SYNC_AUTHORITATIVE)
  })
})

describe("compile-time type constraints", () => {
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

describe("state binding target", () => {
  it("exposes SYNC_EPHEMERAL as its syncMode", () => {
    expect(ephemeral.syncMode).toBe(SYNC_EPHEMERAL)
  })

  it("creates a BoundSchema with ephemeral syncMode", () => {
    const bound = ephemeral.bind(testSchema)
    expect(bound.schema).toBe(testSchema)
    expect(bound.syncMode).toBe(SYNC_EPHEMERAL)
  })

  it("replica() produces a BoundReplica with ephemeral syncMode and ephemeralReplicaFactory", () => {
    const replica = ephemeral.replica()
    expect(replica.syncMode).toBe(SYNC_EPHEMERAL)
    expect(replica.factory).toBe(ephemeralReplicaFactory)
    expect(replica.factory.replicaType).toEqual(["ephemeral", 1, 0])
  })

  it("factory produces a substrate with StateVersion", () => {
    const bound = ephemeral.bind(testSchema)
    const factory = bound.factory({
      peerId: "test-peer",
      binding: bound.identityBinding,
    })
    const substrate = factory.create(testSchema)

    expect(substrate.version()).toBeInstanceOf(StateVersion)
  })

  it("substrate bumps StateVersion on flush", () => {
    const bound = ephemeral.bind(testSchema)
    const factory = bound.factory({
      peerId: "test-peer",
      binding: bound.identityBinding,
    })
    const substrate = factory.create(testSchema)

    const versionBefore = substrate.version()
    expect(versionBefore).toBeInstanceOf(StateVersion)
    expect((versionBefore as StateVersion).timestamp).toBe(0)

    // Trigger prepare → flush via executeBatch
    executeBatch(substrate.context(), [
      { path: RawPath.empty.field("title"), change: replaceChange("hello") },
    ])

    const versionAfter = substrate.version()
    expect(versionAfter).toBeInstanceOf(StateVersion)
    expect((versionAfter as StateVersion).timestamp).toBeGreaterThan(0)
  })

  it("each mutation advances the timestamp (monotonic wall clock)", () => {
    const bound = ephemeral.bind(testSchema)
    const factory = bound.factory({
      peerId: "test-peer",
      binding: bound.identityBinding,
    })
    const substrate = factory.create(testSchema)

    const ts0 = (substrate.version() as StateVersion).timestamp
    expect(ts0).toBe(0)

    executeBatch(substrate.context(), [
      { path: RawPath.empty.field("title"), change: replaceChange("v1") },
    ])
    const ts1 = (substrate.version() as StateVersion).timestamp

    executeBatch(substrate.context(), [
      { path: RawPath.empty.field("title"), change: replaceChange("v2") },
    ])
    const ts2 = (substrate.version() as StateVersion).timestamp

    // Each flush should produce a wall-clock timestamp >= the previous
    expect(ts1).toBeGreaterThan(0)
    expect(ts2).toBeGreaterThanOrEqual(ts1)
  })

  it("merge with an entirety payload absorbs state and bumps the timestamp", () => {
    const bound = ephemeral.bind(testSchema)
    const factory = bound.factory({
      peerId: "test-peer",
      binding: bound.identityBinding,
    })

    const source = factory.create(testSchema)
    executeBatch(source.context(), [
      { path: RawPath.empty.field("title"), change: replaceChange("merged") },
    ])

    const target = factory.create(testSchema)
    expect((target.version() as StateVersion).timestamp).toBe(0)

    target.merge(source.exportEntirety(), { origin: "sync" })

    expect((target.version() as StateVersion).timestamp).toBeGreaterThan(0)
    expect(target.reader.read(RawPath.empty.field("title"))).toBe("merged")
  })

  it("exportSince returns null — snapshot-only delivery, no delta log", () => {
    // `delivery: "snapshot-only"` is not a policy the exchange applies from
    // outside; it falls out of the substrate keeping no op log to diff.
    const bound = ephemeral.bind(testSchema)
    const factory = bound.factory({
      peerId: "test-peer",
      binding: bound.identityBinding,
    })
    const substrate = factory.create(testSchema)
    executeBatch(substrate.context(), [
      { path: RawPath.empty.field("count"), change: replaceChange(7) },
    ])

    expect(substrate.exportSince(substrate.version())).toBeNull()
  })
})
