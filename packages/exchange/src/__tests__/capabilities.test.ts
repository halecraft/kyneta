// Capabilities — unit tests for the capabilities registry.

import { LoroSchema, loro } from "@kyneta/loro-schema"
import {
  type FactoryBuilder,
  json,
  plainReplicaFactory,
  Schema,
  type SubstrateFactory,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import { createCapabilities, DEFAULT_REPLICAS } from "../capabilities.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Minimal resolveFactory for tests: calls the builder with a fixed peerId.
 */
const resolveFactory = (builder: FactoryBuilder): SubstrateFactory =>
  builder({ peerId: "test" })

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Capabilities", () => {
  // -------------------------------------------------------------------------
  // Core registry behavior
  // -------------------------------------------------------------------------

  it("supportsReplicaType returns true for DEFAULT_REPLICAS entries", () => {
    const caps = createCapabilities({
      schemas: [],
      replicas: [...DEFAULT_REPLICAS],
      resolveFactory,
    })

    expect(caps.supportsReplicaType(["plain", 1, 0])).toBe(true)
  })

  it("supportsReplicaType returns false for unregistered type", () => {
    const caps = createCapabilities({
      schemas: [],
      replicas: [...DEFAULT_REPLICAS],
      resolveFactory,
    })

    expect(caps.supportsReplicaType(["loro", 1, 0])).toBe(false)
  })

  it("supportsReplicaType tolerates minor version differences", () => {
    const caps = createCapabilities({
      schemas: [],
      replicas: [json.replica()],
      resolveFactory,
    })

    // Registered as ["plain", 1, 0], querying with minor=2 should still match
    expect(caps.supportsReplicaType(["plain", 1, 2])).toBe(true)
  })

  it("supportsReplicaType rejects major version differences", () => {
    const caps = createCapabilities({
      schemas: [],
      replicas: [json.replica()],
      resolveFactory,
    })

    // Registered as ["plain", 1, 0], querying with major=2 should not match
    expect(caps.supportsReplicaType(["plain", 2, 0])).toBe(false)
  })

  it("resolveReplica returns the BoundReplica for a matching pair", () => {
    const caps = createCapabilities({
      schemas: [],
      replicas: [...DEFAULT_REPLICAS],
      resolveFactory,
    })

    const resolved = caps.resolveReplica(["plain", 1, 0], "authoritative")
    expect(resolved).toBeDefined()
    expect(resolved?.factory).toBe(plainReplicaFactory)
    expect(resolved?.strategy).toBe("authoritative")
  })

  it("resolveReplica returns undefined for wrong strategy", () => {
    const caps = createCapabilities({
      schemas: [],
      replicas: [...DEFAULT_REPLICAS],
      resolveFactory,
    })

    // ["plain", 1, 0] is registered with "authoritative" and "ephemeral", but not "collaborative"
    const resolved = caps.resolveReplica(["plain", 1, 0], "collaborative")
    expect(resolved).toBeUndefined()
  })

  it("resolveReplica returns undefined for unregistered type", () => {
    const caps = createCapabilities({
      schemas: [],
      replicas: [...DEFAULT_REPLICAS],
      resolveFactory,
    })

    const resolved = caps.resolveReplica(["loro", 1, 0], "collaborative")
    expect(resolved).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Schema resolution
  // -------------------------------------------------------------------------

  it("resolveSchema returns BoundSchema for matching triple", () => {
    const schema = Schema.doc({ title: Schema.string() })
    const bound = json.bind(schema)

    const caps = createCapabilities({
      schemas: [bound],
      replicas: [...DEFAULT_REPLICAS],
      resolveFactory,
    })

    const resolved = caps.resolveSchema(
      bound.schemaHash,
      ["plain", 1, 0],
      "authoritative",
    )
    expect(resolved).toBe(bound)
  })

  it("resolveSchema returns undefined for wrong strategy", () => {
    const schema = Schema.doc({ title: Schema.string() })
    const bound = json.bind(schema)

    const caps = createCapabilities({
      schemas: [bound],
      replicas: [...DEFAULT_REPLICAS],
      resolveFactory,
    })

    const resolved = caps.resolveSchema(
      bound.schemaHash,
      ["plain", 1, 0],
      "ephemeral",
    )
    expect(resolved).toBeUndefined()
  })

  it("resolveSchema returns undefined for unknown hash", () => {
    const schema = Schema.doc({ title: Schema.string() })
    const bound = json.bind(schema)

    const caps = createCapabilities({
      schemas: [bound],
      replicas: [...DEFAULT_REPLICAS],
      resolveFactory,
    })

    const resolved = caps.resolveSchema(
      "nonexistent",
      ["plain", 1, 0],
      "authoritative",
    )
    expect(resolved).toBeUndefined()
  })

  // -------------------------------------------------------------------------
  // Schema ⊃ replica derivation
  // -------------------------------------------------------------------------

  it("schema registration auto-derives replica capability", () => {
    const loroSchema = LoroSchema.doc({ title: LoroSchema.text() })
    const bound = loro.bind(loroSchema)

    // No explicit Loro replicas — only DEFAULT_REPLICAS (plain-wire).
    // The Loro BoundReplica should be auto-derived from the schema.
    const caps = createCapabilities({
      schemas: [bound],
      replicas: [...DEFAULT_REPLICAS],
      resolveFactory,
    })

    expect(caps.supportsReplicaType(["loro", 1, 0])).toBe(true)

    const resolved = caps.resolveReplica(["loro", 1, 0], "collaborative")
    expect(resolved).toBeDefined()
    expect(resolved?.factory.replicaType).toEqual(["loro", 1, 0])
    expect(resolved?.strategy).toBe("collaborative")
  })

  // -------------------------------------------------------------------------
  // Dynamic registration
  // -------------------------------------------------------------------------

  it("registerSchema adds to both outer and inner maps", () => {
    const caps = createCapabilities({
      schemas: [],
      replicas: [],
      resolveFactory,
    })

    const schema = Schema.doc({ count: Schema.number() })
    const bound = json.bind(schema)

    // Before registration: nothing resolves
    expect(
      caps.resolveSchema(bound.schemaHash, ["plain", 1, 0], "authoritative"),
    ).toBeUndefined()
    expect(caps.supportsReplicaType(["plain", 1, 0])).toBe(false)

    // Register dynamically
    caps.registerSchema(bound, resolveFactory)

    // After registration: schema resolves and replica type is supported
    expect(
      caps.resolveSchema(bound.schemaHash, ["plain", 1, 0], "authoritative"),
    ).toBe(bound)
    expect(caps.supportsReplicaType(["plain", 1, 0])).toBe(true)
  })

  // -------------------------------------------------------------------------
  // DEFAULT_REPLICAS coverage
  // -------------------------------------------------------------------------

  it("DEFAULT_REPLICAS covers both plain-wire strategies", () => {
    const caps = createCapabilities({
      schemas: [],
      replicas: [...DEFAULT_REPLICAS],
      resolveFactory,
    })

    const sequential = caps.resolveReplica(["plain", 1, 0], "authoritative")
    const ephemeral = caps.resolveReplica(["plain", 1, 0], "ephemeral")

    expect(sequential).toBeDefined()
    expect(ephemeral).toBeDefined()

    // They should be different BoundReplica instances with different factories
    expect(sequential?.factory).toBe(plainReplicaFactory)
    expect(ephemeral?.factory).toBe(json.replica("ephemeral").factory)
    expect(sequential?.factory).not.toBe(ephemeral?.factory)
  })
})
