import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { Schema } from "@kyneta/schema"
import { bindYjs } from "../bind-yjs.js"
import { yjs } from "../yjs-escape.js"
import { createYjsDoc } from "../create.js"
import { yjsSubstrateFactory } from "../substrate.js"

// ===========================================================================
// Schemas used across tests
// ===========================================================================

const TodoSchema = Schema.doc({
  title: Schema.annotated("text"),
  items: Schema.list(
    Schema.struct({
      name: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

const SimpleSchema = Schema.doc({
  title: Schema.annotated("text"),
  count: Schema.number(),
})

// ===========================================================================
// Tests
// ===========================================================================

describe("bindYjs", () => {
  // -------------------------------------------------------------------------
  // BoundSchema shape
  // -------------------------------------------------------------------------

  describe("BoundSchema", () => {
    it("creates BoundSchema with causal strategy", () => {
      const bound = bindYjs(TodoSchema)
      expect(bound._brand).toBe("BoundSchema")
      expect(bound.schema).toBe(TodoSchema)
      expect(bound.strategy).toBe("causal")
    })

    it("has a factory builder function", () => {
      const bound = bindYjs(TodoSchema)
      expect(typeof bound.factory).toBe("function")
    })

    it("preserves the schema reference", () => {
      const bound = bindYjs(SimpleSchema)
      expect(bound.schema).toBe(SimpleSchema)
    })
  })

  // -------------------------------------------------------------------------
  // Factory builder
  // -------------------------------------------------------------------------

  describe("factory builder", () => {
    it("produces a working SubstrateFactory", () => {
      const bound = bindYjs(SimpleSchema)
      const factory = bound.factory({ peerId: "peer-1" })

      const substrate = factory.create(SimpleSchema, {
        title: "Test",
        count: 7,
      })

      expect(substrate.store.read([{ type: "key", key: "title" }])).toBe(
        "Test",
      )
      expect(substrate.store.read([{ type: "key", key: "count" }])).toBe(7)
    })

    it("factory supports fromSnapshot", () => {
      const bound = bindYjs(SimpleSchema)
      const factory = bound.factory({ peerId: "peer-1" })

      // Create and export
      const substrate1 = factory.create(SimpleSchema, {
        title: "Snap",
        count: 42,
      })
      const snapshot = substrate1.exportSnapshot()

      // Restore
      const substrate2 = factory.fromSnapshot(snapshot, SimpleSchema)
      expect(substrate2.store.read([{ type: "key", key: "title" }])).toBe(
        "Snap",
      )
      expect(substrate2.store.read([{ type: "key", key: "count" }])).toBe(42)
    })

    it("factory supports parseVersion", () => {
      const bound = bindYjs(SimpleSchema)
      const factory = bound.factory({ peerId: "peer-1" })

      const substrate = factory.create(SimpleSchema)
      const v = substrate.version()
      const serialized = v.serialize()
      const parsed = factory.parseVersion(serialized)
      expect(parsed.compare(v)).toBe("equal")
    })
  })

  // -------------------------------------------------------------------------
  // Deterministic clientID from peerId
  // -------------------------------------------------------------------------

  describe("deterministic clientID", () => {
    it("same peerId produces same clientID across multiple factory calls", () => {
      const bound = bindYjs(SimpleSchema)
      const factory = bound.factory({ peerId: "stable-peer-id" })

      const s1 = factory.create(SimpleSchema)
      const s2 = factory.create(SimpleSchema)

      // Both docs should have the same clientID
      const doc1 = yjs(
        createYjsDocFromFactory(factory, SimpleSchema),
      )
      const doc2 = yjs(
        createYjsDocFromFactory(factory, SimpleSchema),
      )

      expect(doc1.clientID).toBe(doc2.clientID)
    })

    it("different peerIds produce different clientIDs", () => {
      const bound = bindYjs(SimpleSchema)
      const factory1 = bound.factory({ peerId: "peer-alpha" })
      const factory2 = bound.factory({ peerId: "peer-beta" })

      const doc1 = yjs(createYjsDocFromFactory(factory1, SimpleSchema))
      const doc2 = yjs(createYjsDocFromFactory(factory2, SimpleSchema))

      expect(doc1.clientID).not.toBe(doc2.clientID)
    })

    it("clientID is a valid uint32", () => {
      const bound = bindYjs(SimpleSchema)
      const factory = bound.factory({ peerId: "test-peer-id-12345" })
      const doc = yjs(createYjsDocFromFactory(factory, SimpleSchema))

      expect(typeof doc.clientID).toBe("number")
      expect(doc.clientID).toBeGreaterThanOrEqual(0)
      expect(doc.clientID).toBeLessThanOrEqual(0xffffffff)
      expect(Number.isInteger(doc.clientID)).toBe(true)
    })

    it("clientID is deterministic across restarts (same string → same number)", () => {
      const peerId = "deterministic-check-peer"

      // Simulate two separate "sessions" — both should hash to the same value
      const bound1 = bindYjs(SimpleSchema)
      const factory1 = bound1.factory({ peerId })
      const doc1 = yjs(createYjsDocFromFactory(factory1, SimpleSchema))

      const bound2 = bindYjs(SimpleSchema)
      const factory2 = bound2.factory({ peerId })
      const doc2 = yjs(createYjsDocFromFactory(factory2, SimpleSchema))

      expect(doc1.clientID).toBe(doc2.clientID)
    })
  })

  // -------------------------------------------------------------------------
  // yjs() escape hatch
  // -------------------------------------------------------------------------

  describe("yjs() escape hatch", () => {
    it("returns the underlying Y.Doc from a createYjsDoc ref", () => {
      const doc = createYjsDoc(SimpleSchema, { title: "Escape", count: 0 })
      const yjsDoc = yjs(doc)

      expect(yjsDoc).toBeInstanceOf(Y.Doc)
      expect(yjsDoc.getMap("root").get("count")).toBe(0)
    })

    it("returns a Y.Doc with the correct root map state", () => {
      const doc = createYjsDoc(SimpleSchema, {
        title: "Hello",
        count: 42,
      })
      const yjsDoc = yjs(doc)
      const rootMap = yjsDoc.getMap("root")

      expect((rootMap.get("title") as Y.Text).toJSON()).toBe("Hello")
      expect(rootMap.get("count")).toBe(42)
    })

    it("throws for non-Yjs refs (plain object)", () => {
      expect(() => yjs({})).toThrow("yjs() requires a ref")
    })

    it("throws for non-Yjs refs (random object with properties)", () => {
      const fake = {
        title: () => "fake",
        count: () => 0,
      }
      expect(() => yjs(fake)).toThrow("yjs() requires a ref")
    })

    it("mutations through escape hatch are visible via kyneta ref", () => {
      const doc = createYjsDoc(SimpleSchema, { title: "", count: 0 })
      const yjsDoc = yjs(doc)

      // Mutate via raw Yjs
      yjsDoc.getMap("root").set("count", 99)
      expect(doc.count()).toBe(99)
    })

    it("text mutations through escape hatch are visible", () => {
      const doc = createYjsDoc(SimpleSchema, { title: "Hello" })
      const yjsDoc = yjs(doc)

      const text = yjsDoc.getMap("root").get("title") as Y.Text
      text.insert(5, " World")
      expect(doc.title()).toBe("Hello World")
    })
  })
})

// ===========================================================================
// Helper — create a doc via a factory and return a ref with escape hatch
// ===========================================================================

import { interpret, readable, writable, changefeed, registerSubstrate } from "@kyneta/schema"
import type { SubstrateFactory } from "@kyneta/schema"
import type { Schema as SchemaType } from "@kyneta/schema"

/**
 * Helper to create a kyneta ref from a factory (mimicking what exchange.get does).
 * This exercises the factory's create path including clientID injection.
 */
function createYjsDocFromFactory(
  factory: SubstrateFactory<any>,
  schema: SchemaType,
): any {
  const substrate = factory.create(schema)
  const doc: any = (interpret as any)(schema, substrate.context())
    .with(readable)
    .with(writable)
    .with(changefeed)
    .done()

  // Register for escape hatch — createYjsSubstrate already registered
  // substrate → Y.Doc internally, but we also need ref → substrate
  // for unwrap() (used by the yjs() escape hatch).
  registerSubstrate(doc, substrate)

  return doc
}