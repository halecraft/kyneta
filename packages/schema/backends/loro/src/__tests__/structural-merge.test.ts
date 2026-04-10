// structural-merge — Loro structural merge protocol tests.
//
// Loro container creation (doc.getText(), doc.getList(), etc.) is
// idempotent — no CRDT ops. The structural merge tests for Loro
// focus on scalar defaults (propsMap.set) and deterministic ordering.
//
// Context: jj:ptyzqoul (structural merge protocol)

import { Schema } from "@kyneta/schema"
import { LoroDoc } from "loro-crdt"
import { describe, expect, it } from "vitest"
import { loro } from "../bind-loro.js"
import { PROPS_KEY } from "../loro-resolve.js"
import { LoroSchema } from "../loro-schema.js"
import { ensureLoroContainers, loroSubstrateFactory } from "../substrate.js"

// ===========================================================================
// Schemas used across tests
// ===========================================================================

const TestSchema = Schema.struct({
  title: Schema.text(),
  count: LoroSchema.plain.number(),
  items: Schema.list(Schema.string()),
})

// ===========================================================================
// Tests
// ===========================================================================

describe("structural merge protocol (Loro)", () => {
  // ── Container creation is idempotent ──

  it("two peers independently create same schema — containers are identical", () => {
    const docA = new LoroDoc()
    ensureLoroContainers(docA, TestSchema, false)
    docA.commit()

    const docB = new LoroDoc()
    ensureLoroContainers(docB, TestSchema, false)
    docB.commit()

    // Both should produce the same containers — text, list
    expect(docA.getText("title")).toBeDefined()
    expect(docB.getText("title")).toBeDefined()
    expect(docA.getList("items")).toBeDefined()
    expect(docB.getList("items")).toBeDefined()

    // Scalar defaults via _props
    const propsA = docA.getMap(PROPS_KEY)
    const propsB = docB.getMap(PROPS_KEY)
    expect(propsA.get("count")).toBe(0) // Zero.structural for number
    expect(propsB.get("count")).toBe(0)
  })

  it("container creation is idempotent — calling twice doesn't conflict", () => {
    const doc = new LoroDoc()
    ensureLoroContainers(doc, TestSchema, false)
    doc.commit()

    // Second call — should be a no-op for containers
    ensureLoroContainers(doc, TestSchema, false)
    doc.commit()

    // Still works correctly
    expect(doc.getText("title")).toBeDefined()
    expect(doc.getList("items")).toBeDefined()
  })

  // ── Conditional mode preserves hydrated state ──

  it("conditional mode skips scalar defaults for existing keys", () => {
    const doc = new LoroDoc()
    // Set a non-default value first
    const propsMap = doc.getMap(PROPS_KEY)
    propsMap.set("count", 42)
    doc.commit()

    // Conditional ensureLoroContainers should NOT overwrite count
    ensureLoroContainers(doc, TestSchema, true)
    doc.commit()

    expect(propsMap.get("count")).toBe(42)
  })

  // ── Alphabetical sort ──

  it("field ordering in source doesn't affect container creation order", () => {
    const schemaA = Schema.struct({
      alpha: Schema.string(),
      beta: Schema.number(),
      gamma: Schema.text(),
    })

    // Same fields, different insertion order — alphabetical sort should
    // override JavaScript object insertion order.
    const fields: Record<string, any> = {}
    fields.gamma = Schema.text()
    fields.alpha = Schema.string()
    fields.beta = Schema.number()
    const schemaB = Schema.struct(fields)

    const docA = new LoroDoc()
    ensureLoroContainers(docA, schemaA, false)
    docA.commit()

    const docB = new LoroDoc()
    ensureLoroContainers(docB, schemaB, false)
    docB.commit()

    // Both have the same containers and defaults
    expect(docA.getText("gamma")).toBeDefined()
    expect(docB.getText("gamma")).toBeDefined()
    const propsA = docA.getMap(PROPS_KEY)
    const propsB = docB.getMap(PROPS_KEY)
    expect(propsA.get("alpha")).toBe("") // Zero.structural for string
    expect(propsB.get("alpha")).toBe("")
    expect(propsA.get("beta")).toBe(0) // Zero.structural for number
    expect(propsB.get("beta")).toBe(0)
  })

  // ── Persistence round-trip ──

  it("persist → hydrate → data preserved", () => {
    const doc1 = new LoroDoc()
    ensureLoroContainers(doc1, TestSchema, false)
    doc1.getText("title").insert(0, "Hello Loro")
    doc1.getMap(PROPS_KEY).set("count", 7)
    doc1.commit()

    // Export snapshot
    const snapshot = doc1.export({ mode: "snapshot" })

    // Hydrate into fresh doc
    const doc2 = new LoroDoc()
    doc2.import(snapshot)
    ensureLoroContainers(doc2, TestSchema, true) // conditional

    expect(doc2.getText("title").toString()).toBe("Hello Loro")
    expect(doc2.getMap(PROPS_KEY).get("count")).toBe(7)
  })

  // ── Factory integration ──

  it("loroSubstrateFactory.create and independent create merge cleanly", () => {
    const sub1 = loroSubstrateFactory.create(TestSchema)
    const sub2 = loroSubstrateFactory.create(TestSchema)

    // Both substrates exist and have the same structure
    const state1 = sub1.exportEntirety()
    const state2 = sub2.exportEntirety()

    // Cross-merge — should not throw
    sub1.merge(state2, "sync")
    sub2.merge(state1, "sync")
  })

  it("loro.bind() factory produces merge-compatible substrates", () => {
    const bound = loro.bind(TestSchema)

    const factoryA = bound.factory({ peerId: "alice" })
    const factoryB = bound.factory({ peerId: "bob" })

    const subA = factoryA.create(TestSchema)
    const subB = factoryB.create(TestSchema)

    // Cross-merge — should not throw
    const stateA = subA.exportEntirety()
    const stateB = subB.exportEntirety()
    subA.merge(stateB, "sync")
    subB.merge(stateA, "sync")

    // No crash, no data loss
  })
})
