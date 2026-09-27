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
    expect(replica.factory.replicaType).toEqual(["plain", 2, 0])
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
    expect((versionBefore as StateVersion).installSeq).toBe(0)

    // An auto-committed local write: prepare → flush
    substrate
      .context()
      .dispatch(RawPath.empty.field("title"), replaceChange("hello"))

    const versionAfter = substrate.version()
    expect(versionAfter).toBeInstanceOf(StateVersion)
    expect((versionAfter as StateVersion).installSeq).toBeGreaterThan(0)
  })

  it("each mutation advances the install counter", () => {
    const bound = ephemeral.bind(testSchema)
    const factory = bound.factory({
      peerId: "test-peer",
      binding: bound.identityBinding,
    })
    const substrate = factory.create(testSchema)

    const ts0 = (substrate.version() as StateVersion).installSeq
    expect(ts0).toBe(0)

    substrate
      .context()
      .dispatch(RawPath.empty.field("title"), replaceChange("v1"))
    const ts1 = (substrate.version() as StateVersion).installSeq

    substrate
      .context()
      .dispatch(RawPath.empty.field("title"), replaceChange("v2"))
    const ts2 = (substrate.version() as StateVersion).installSeq

    // The counter is an ordinal, not a clock: each write takes the next one,
    // so a second write is strictly ahead however fast it followed.
    expect(ts1).toBeGreaterThan(0)
    expect(ts2).toBeGreaterThan(ts1)
  })

  it("merge with an entirety payload absorbs state and advances the counter", () => {
    const bound = ephemeral.bind(testSchema)
    const factory = bound.factory({
      peerId: "test-peer",
      binding: bound.identityBinding,
    })

    const source = factory.create(testSchema)
    source
      .context()
      .dispatch(RawPath.empty.field("title"), replaceChange("merged"))

    const target = factory.create(testSchema)
    expect((target.version() as StateVersion).installSeq).toBe(0)

    target.merge(source.exportEntirety(), { origin: "sync" })

    expect((target.version() as StateVersion).installSeq).toBeGreaterThan(0)
    expect(target.reader.read(RawPath.empty.field("title"))).toBe("merged")
  })

  it("exportSince from our own cursor is an empty delta, not null", () => {
    // The distinction is load-bearing. `null` means "I cannot serve this
    // cursor" and the caller answers it with a whole document; an empty
    // payload means "you are current". Returning null here made every
    // agreement cost a full resend — measured at 9 015 B where the repair
    // needed 43 B.
    const bound = ephemeral.bind(testSchema)
    const factory = bound.factory({
      peerId: "test-peer",
      binding: bound.identityBinding,
    })
    const substrate = factory.create(testSchema)
    substrate.context().dispatch(RawPath.empty.field("count"), replaceChange(7))

    const delta = substrate.exportSince(substrate.version())
    expect(delta).not.toBeNull()
    expect(delta?.kind).toBe("since")
    expect(delta?.data).toBe("{}")
  })

  it("exportSince declines a cursor from another replica's incarnation", () => {
    // The one case that earns a whole document: a counter we did not mint
    // says nothing about what this replica holds.
    const bound = ephemeral.bind(testSchema)
    const factory = bound.factory({
      peerId: "test-peer",
      binding: bound.identityBinding,
    })
    const mine = factory.create(testSchema)
    const theirs = factory.create(testSchema)

    expect(mine.exportSince(theirs.version() as StateVersion)).toBeNull()
  })
})
