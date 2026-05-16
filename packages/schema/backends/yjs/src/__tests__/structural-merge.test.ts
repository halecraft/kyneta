// structural-merge — Yjs structural merge protocol tests.
//
// Validates the core invariant: all peers using the same schema produce
// byte-identical structural ops via STRUCTURAL_YJS_CLIENT_ID (0),
// which Yjs deduplicates on merge instead of conflicting.
//
// Context: jj:ptyzqoul (structural merge protocol)

import {
  BACKING_DOC,
  deriveIdentity,
  deriveSchemaBinding,
  KIND,
  type ProductSchema,
  Schema,
  type SchemaBinding,
  STRUCTURAL_YJS_CLIENT_ID,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { yjs } from "../bind-yjs.js"
import { ensureContainers } from "../populate.js"
import { yjsSubstrateFactory } from "../substrate.js"

// ===========================================================================
// Identity-keying helpers
// ===========================================================================

function trivialBinding(schema: any): SchemaBinding {
  if (schema[KIND] === "product") {
    return deriveSchemaBinding(schema as ProductSchema, {})
  }
  return { forward: new Map(), inverse: new Map() }
}

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

describe("structural merge protocol (Yjs)", () => {
  // ── Core invariant: two peers independently create, sync, no data loss ──

  it("two peers independently create same schema, sync, data preserved", () => {
    const binding = trivialBinding(TestSchema)

    // Peer A creates doc and writes text
    const docA = new Y.Doc()
    docA.clientID = 100
    ensureContainers(docA, TestSchema, false, binding)
    docA.transact(() => {
      const root = docA.getMap("root")
      ;(root.get(id("title")) as Y.Text).insert(0, "Hello from A")
      root.set(id("count"), 42)
    })

    // Peer B independently creates same doc and writes different text
    const docB = new Y.Doc()
    docB.clientID = 200
    ensureContainers(docB, TestSchema, false, binding)
    docB.transact(() => {
      const root = docB.getMap("root")
      ;(root.get(id("title")) as Y.Text).insert(0, "Hello from B")
      root.set(id("count"), 99)
    })

    // Sync bidirectionally
    const updateA = Y.encodeStateAsUpdate(docA)
    const updateB = Y.encodeStateAsUpdate(docB)
    Y.applyUpdate(docB, updateA)
    Y.applyUpdate(docA, updateB)

    // Both see the same state — no data loss
    const rootA = docA.getMap("root")
    const rootB = docB.getMap("root")

    // Text should contain content from both peers (no orphaned containers)
    const titleA = (rootA.get(id("title")) as Y.Text).toString()
    const titleB = (rootB.get(id("title")) as Y.Text).toString()
    expect(titleA).toBe(titleB)
    // Both texts should be present (merged, not lost)
    expect(titleA).toContain("Hello from A")
    expect(titleA).toContain("Hello from B")

    // Count: last writer wins — both converge to the same value
    expect(rootA.get(id("count"))).toBe(rootB.get(id("count")))
  })

  it("three peers independently create, sync, all converge", () => {
    const binding = trivialBinding(TestSchema)

    const docs = [100, 200, 300].map(cid => {
      const doc = new Y.Doc()
      doc.clientID = cid
      ensureContainers(doc, TestSchema, false, binding)
      doc.transact(() => {
        const root = doc.getMap("root")
        ;(root.get(id("title")) as Y.Text).insert(0, `Peer${cid}`)
      })
      return doc
    })

    // Full mesh sync
    for (let i = 0; i < docs.length; i++) {
      for (let j = 0; j < docs.length; j++) {
        if (i !== j) {
          const target = docs[j]
          const source = docs[i]
          if (target && source)
            Y.applyUpdate(target, Y.encodeStateAsUpdate(source))
        }
      }
    }

    // All three converge to the same text
    const texts = docs.map(d =>
      (d.getMap("root").get(id("title")) as Y.Text).toString(),
    )
    expect(texts[0]).toBe(texts[1])
    expect(texts[1]).toBe(texts[2])
    // All three peer contributions present
    expect(texts[0]).toContain("Peer100")
    expect(texts[0]).toContain("Peer200")
    expect(texts[0]).toContain("Peer300")
  })

  // ── Persistence round-trip ──

  it("persist → hydrate → data preserved", () => {
    const binding = trivialBinding(TestSchema)

    // Create and write
    const doc1 = new Y.Doc()
    doc1.clientID = 42
    ensureContainers(doc1, TestSchema, false, binding)
    doc1.transact(() => {
      const root = doc1.getMap("root")
      ;(root.get(id("title")) as Y.Text).insert(0, "Persistent")
      root.set(id("count"), 7)
    })

    // Export
    const snapshot = Y.encodeStateAsUpdate(doc1)

    // Hydrate into fresh doc
    const doc2 = new Y.Doc()
    doc2.clientID = 42
    Y.applyUpdate(doc2, snapshot)
    ensureContainers(doc2, TestSchema, true, binding) // conditional

    // Data preserved
    const root2 = doc2.getMap("root")
    expect((root2.get(id("title")) as Y.Text).toString()).toBe("Persistent")
    expect(root2.get(id("count"))).toBe(7)
  })

  // ── Determinism: alphabetical sort ──

  it("field reordering in source doesn't affect structural ops", () => {
    // Schema A: fields in one order
    const schemaA = Schema.struct({
      alpha: Schema.string(),
      beta: Schema.number(),
      gamma: Schema.text(),
    })

    // Schema B: same fields, different insertion order
    // JavaScript objects preserve insertion order, so we construct
    // with a different order to verify alphabetical sort overrides it.
    const fields: Record<string, any> = {}
    fields.gamma = Schema.text()
    fields.alpha = Schema.string()
    fields.beta = Schema.number()
    const schemaB = Schema.struct(fields)

    const bindingA = trivialBinding(schemaA)
    const bindingB = trivialBinding(schemaB)

    const docA = new Y.Doc()
    ensureContainers(docA, schemaA, false, bindingA)

    const docB = new Y.Doc()
    ensureContainers(docB, schemaB, false, bindingB)

    // Both should produce byte-identical structural state
    const stateA = Y.encodeStateAsUpdate(docA)
    const stateB = Y.encodeStateAsUpdate(docB)
    expect(stateA).toEqual(stateB)
  })

  // ── Schema evolution ──

  it("add field after hydration, structural ops extend correctly", () => {
    const v1Schema = Schema.struct({
      title: Schema.text(),
      count: Schema.number(),
    })

    const v2Schema = Schema.struct({
      count: Schema.number(),
      notes: Schema.text(), // new field
      title: Schema.text(),
    })

    const v1Binding = trivialBinding(v1Schema)
    const v2Binding = trivialBinding(v2Schema)

    // Peer A: create v1, write data, export
    const docA = new Y.Doc()
    docA.clientID = 100
    ensureContainers(docA, v1Schema, false, v1Binding)
    docA.transact(() => {
      const root = docA.getMap("root")
      ;(root.get(id("title")) as Y.Text).insert(0, "Title")
      root.set(id("count"), 5)
    })
    const v1State = Y.encodeStateAsUpdate(docA)

    // Peer B: independently create v2, hydrate v1 data, conditional containers
    const docB = new Y.Doc()
    docB.clientID = 200
    Y.applyUpdate(docB, v1State)
    ensureContainers(docB, v2Schema, true, v2Binding) // conditional — only creates "notes"

    // Another peer C: same thing independently
    const docC = new Y.Doc()
    docC.clientID = 300
    Y.applyUpdate(docC, v1State)
    ensureContainers(docC, v2Schema, true, v2Binding)

    // B and C's structural ops for "notes" should be identical (both at clientID 0)
    const stateB = Y.encodeStateAsUpdate(docB)
    const stateC = Y.encodeStateAsUpdate(docC)

    // Merge B into C and C into B — should converge without conflict
    Y.applyUpdate(docC, stateB)
    Y.applyUpdate(docB, stateC)

    const rootB = docB.getMap("root")
    const rootC = docC.getMap("root")

    // Original data preserved
    expect((rootB.get(id("title")) as Y.Text).toString()).toBe("Title")
    expect(rootB.get(id("count"))).toBe(5)
    expect((rootC.get(id("title")) as Y.Text).toString()).toBe("Title")
    expect(rootC.get(id("count"))).toBe(5)

    // New field exists on both
    expect(rootB.get(id("notes"))).toBeInstanceOf(Y.Text)
    expect(rootC.get(id("notes"))).toBeInstanceOf(Y.Text)
  })

  // ── Structural identity is clientID 0 ──

  it("ensureContainers uses clientID 0 for structural ops", () => {
    const binding = trivialBinding(TestSchema)

    const doc = new Y.Doc()
    doc.clientID = 999
    ensureContainers(doc, TestSchema, false, binding)

    // clientID should be restored
    expect(doc.clientID).toBe(999)

    // Structural ops should be at clientID 0
    const sv = Y.decodeStateVector(Y.encodeStateVector(doc))
    expect(sv.get(STRUCTURAL_YJS_CLIENT_ID)).toBeGreaterThan(0)
  })

  it("ensureContainers does not leak caller clientID into structural ops", () => {
    const binding = trivialBinding(TestSchema)

    const doc = new Y.Doc()
    doc.clientID = 777
    ensureContainers(doc, TestSchema, false, binding)

    // The state vector should NOT contain the caller's clientID —
    // only STRUCTURAL_YJS_CLIENT_ID (0) should have produced ops.
    const sv = Y.decodeStateVector(Y.encodeStateVector(doc))
    expect(sv.has(STRUCTURAL_YJS_CLIENT_ID)).toBe(true)
    expect(sv.has(777)).toBe(false)
  })

  // ── SubstrateFactory integration ──

  it("yjsSubstrateFactory.create produces deterministic structural ops", () => {
    const sub1 = yjsSubstrateFactory.create(TestSchema)
    const sub2 = yjsSubstrateFactory.create(TestSchema)

    const state1 = sub1.exportEntirety()
    const state2 = sub2.exportEntirety()

    // Byte-identical structural state
    expect(state1.data).toEqual(state2.data)
  })

  it("yjsSubstrateFactory.fromEntirety preserves data through round-trip", () => {
    const sub1 = yjsSubstrateFactory.create(TestSchema)
    const doc1 = (sub1 as any)[BACKING_DOC] as Y.Doc
    doc1.transact(() => {
      const root = doc1.getMap("root")
      ;(root.get(id("title")) as Y.Text).insert(0, "Round-trip")
      root.set(id("count"), 123)
    })

    const payload = sub1.exportEntirety()
    const sub2 = yjsSubstrateFactory.fromEntirety(payload, TestSchema)
    const doc2 = (sub2 as any)[BACKING_DOC] as Y.Doc
    const root2 = doc2.getMap("root")

    expect((root2.get(id("title")) as Y.Text).toString()).toBe("Round-trip")
    expect(root2.get(id("count"))).toBe(123)
  })

  // ── yjs.bind integration ──

  it("yjs.bind factory produces deterministic structural ops across peers", () => {
    const bound = yjs.bind(TestSchema)

    const factoryA = bound.factory({
      peerId: "alice",
      binding: bound.identityBinding,
    })
    const factoryB = bound.factory({
      peerId: "bob",
      binding: bound.identityBinding,
    })

    const subA = factoryA.create(TestSchema)
    const subB = factoryB.create(TestSchema)

    // Different peerIds but same structural ops
    const stateA = subA.exportEntirety()
    const stateB = subB.exportEntirety()

    // Structural state is byte-identical (same schema → same containers at clientID 0)
    expect(stateA.data).toEqual(stateB.data)
  })

  it("yjs.bind peers merge without structural conflict", () => {
    const bound = yjs.bind(TestSchema)

    const factoryA = bound.factory({
      peerId: "alice",
      binding: bound.identityBinding,
    })
    const factoryB = bound.factory({
      peerId: "bob",
      binding: bound.identityBinding,
    })

    const subA = factoryA.create(TestSchema)
    const subB = factoryB.create(TestSchema)

    // Write different data on each peer
    const docA = (subA as any)[BACKING_DOC] as Y.Doc
    docA.transact(() => {
      const root = docA.getMap("root")
      ;(root.get(id("title")) as Y.Text).insert(0, "Alice's text")
      root.set(id("count"), 10)
    })

    const docB = (subB as any)[BACKING_DOC] as Y.Doc
    docB.transact(() => {
      const root = docB.getMap("root")
      ;(root.get(id("title")) as Y.Text).insert(0, "Bob's text")
      root.set(id("count"), 20)
    })

    // Bidirectional merge — should not throw
    const payloadA = subA.exportEntirety()
    const payloadB = subB.exportEntirety()
    subA.merge(payloadB, { origin: "sync" })
    subB.merge(payloadA, { origin: "sync" })

    // Both converge
    const rootA = docA.getMap("root")
    const rootB = docB.getMap("root")

    const titleA = (rootA.get(id("title")) as Y.Text).toString()
    const titleB = (rootB.get(id("title")) as Y.Text).toString()
    expect(titleA).toBe(titleB)
    expect(titleA).toContain("Alice's text")
    expect(titleA).toContain("Bob's text")

    expect(rootA.get(id("count"))).toBe(rootB.get(id("count")))
  })

  // ── Conditional ensureContainers is idempotent ──

  it("conditional ensureContainers is idempotent on hydrated doc", () => {
    const binding = trivialBinding(TestSchema)

    const doc = new Y.Doc()
    doc.clientID = 50
    ensureContainers(doc, TestSchema, false, binding)

    const stateBefore = Y.encodeStateAsUpdate(doc)

    // Conditional call should not create new ops (everything already exists)
    ensureContainers(doc, TestSchema, true, binding)

    const stateAfter = Y.encodeStateAsUpdate(doc)
    expect(stateAfter).toEqual(stateBefore)
  })
})
