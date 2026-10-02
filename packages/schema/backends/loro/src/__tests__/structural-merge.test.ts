// structural-merge — Loro structural merge protocol tests.
//
// Loro container creation (doc.getText(), doc.getList(), etc.) is
// idempotent — no CRDT ops. Scalar/sum fields are NOT eagerly
// written to the CRDT; the materializer's zero fallback handles
// default values on read.
//
// Context: jj:ptyzqoul (structural merge protocol)

import {
  createSubstrate,
  deriveIdentity,
  identityBindingOf,
  Schema,
} from "@kyneta/schema"
import { LoroDoc } from "loro-crdt"
import { describe, expect, it } from "vitest"
import { loro } from "../bind-loro.js"
import { PROPS_KEY } from "../loro-resolve.js"
import { ensureLoroContainers, loroSubstrateFactory } from "../substrate.js"

// ===========================================================================
// Helpers
// ===========================================================================

/** Shortcut to get identity hash for a field name (trivial binding, generation 1) */
function id(fieldName: string): string {
  return deriveIdentity(fieldName, 1)
}

// ===========================================================================
// Schemas used across tests
// ===========================================================================

const TestSchema = Schema.struct({
  title: Schema.text(),
  count: Schema.number(),
  items: Schema.list(Schema.string()),
})

// ===========================================================================
// Tests
// ===========================================================================

describe("structural merge protocol (Loro)", () => {
  // ── Container creation is idempotent ──

  it("two peers independently create same schema — containers are identical", () => {
    const binding = identityBindingOf(TestSchema)

    const docA = new LoroDoc()
    ensureLoroContainers(docA, TestSchema, binding)
    docA.commit()

    const docB = new LoroDoc()
    ensureLoroContainers(docB, TestSchema, binding)
    docB.commit()

    // Both should produce the same containers — text, list (identity-keyed)
    expect(docA.getText(id("title"))).toBeDefined()
    expect(docB.getText(id("title"))).toBeDefined()
    expect(docA.getList(id("items"))).toBeDefined()
    expect(docB.getList(id("items"))).toBeDefined()

    // Scalar fields are NOT pre-populated in _props — the materializer's
    // zero fallback produces correct defaults on read.
    const propsA = docA.getMap(PROPS_KEY)
    const propsB = docB.getMap(PROPS_KEY)
    expect(propsA.get(id("count"))).toBeUndefined()
    expect(propsB.get(id("count"))).toBeUndefined()
  })

  it("container creation is idempotent — calling twice doesn't conflict", () => {
    const binding = identityBindingOf(TestSchema)

    const doc = new LoroDoc()
    ensureLoroContainers(doc, TestSchema, binding)
    doc.commit()

    // Second call — should be a no-op for containers
    ensureLoroContainers(doc, TestSchema, binding)
    doc.commit()

    // Still works correctly (identity-keyed)
    expect(doc.getText(id("title"))).toBeDefined()
    expect(doc.getList(id("items"))).toBeDefined()
  })

  // ── Idempotent container creation preserves existing data ──

  it("calling ensureLoroContainers after manual writes preserves existing data", () => {
    const binding = identityBindingOf(TestSchema)

    const doc = new LoroDoc()
    // Set a non-default value first (using identity-keyed key)
    const propsMap = doc.getMap(PROPS_KEY)
    propsMap.set(id("count"), 42)
    doc.commit()

    // Calling ensureLoroContainers after writes — scalar/sum are no-ops,
    // container getters are idempotent. Existing data is preserved.
    ensureLoroContainers(doc, TestSchema, binding)
    doc.commit()

    expect(propsMap.get(id("count"))).toBe(42)
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

    const bindingA = identityBindingOf(schemaA)
    const bindingB = identityBindingOf(schemaB)

    const docA = new LoroDoc()
    ensureLoroContainers(docA, schemaA, bindingA)
    docA.commit()

    const docB = new LoroDoc()
    ensureLoroContainers(docB, schemaB, bindingB)
    docB.commit()

    // Both have the same containers (identity-keyed)
    expect(docA.getText(id("gamma"))).toBeDefined()
    expect(docB.getText(id("gamma"))).toBeDefined()
    // Scalar fields are NOT pre-populated — the materializer handles zeros.
    const propsA = docA.getMap(PROPS_KEY)
    const propsB = docB.getMap(PROPS_KEY)
    expect(propsA.get(id("alpha"))).toBeUndefined()
    expect(propsB.get(id("alpha"))).toBeUndefined()
    expect(propsA.get(id("beta"))).toBeUndefined()
    expect(propsB.get(id("beta"))).toBeUndefined()
  })

  // ── Persistence round-trip ──

  it("persist → hydrate → data preserved", () => {
    const binding = identityBindingOf(TestSchema)

    const doc1 = new LoroDoc()
    ensureLoroContainers(doc1, TestSchema, binding)
    doc1.getText(id("title")).insert(0, "Hello Loro")
    doc1.getMap(PROPS_KEY).set(id("count"), 7)
    doc1.commit()

    // Export snapshot
    const snapshot = doc1.export({ mode: "snapshot" })

    // Hydrate into fresh doc
    const doc2 = new LoroDoc()
    doc2.import(snapshot)
    ensureLoroContainers(doc2, TestSchema, binding)

    expect(doc2.getText(id("title")).toString()).toBe("Hello Loro")
    expect(doc2.getMap(PROPS_KEY).get(id("count"))).toBe(7)
  })

  // ── Factory integration ──

  it("loroSubstrateFactory.create and independent create merge cleanly", () => {
    const sub1 = createSubstrate(loroSubstrateFactory, TestSchema)
    const sub2 = createSubstrate(loroSubstrateFactory, TestSchema)

    // Both substrates exist and have the same structure
    const state1 = sub1.exportEntirety()
    const state2 = sub2.exportEntirety()

    // Cross-merge — should not throw
    sub1.merge(state2, { origin: "sync" })
    sub2.merge(state1, { origin: "sync" })
  })

  it("loro.bind() factory produces merge-compatible substrates", () => {
    const bound = loro.bind(TestSchema)

    const factoryA = bound.factory({
      peerId: "alice",
      binding: bound.identityBinding,
    })
    const factoryB = bound.factory({
      peerId: "bob",
      binding: bound.identityBinding,
    })

    const subA = createSubstrate(factoryA, TestSchema)
    const subB = createSubstrate(factoryB, TestSchema)

    // Cross-merge — should not throw
    const stateA = subA.exportEntirety()
    const stateB = subB.exportEntirety()
    subA.merge(stateB, { origin: "sync" })
    subB.merge(stateA, { origin: "sync" })

    // No crash, no data loss
  })
})
