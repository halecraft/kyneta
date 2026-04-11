import {
  change,
  createRef,
  exportEntirety,
  RawPath,
  Schema,
  unwrap,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { yjs } from "../bind-yjs.js"

// ===========================================================================
// Helper — createDoc using the generic API
// ===========================================================================

import { createDoc } from "@kyneta/schema"

// ===========================================================================
// Schemas used across tests
// ===========================================================================

const TodoSchema = Schema.struct({
  title: Schema.text(),
  items: Schema.list(
    Schema.struct({
      name: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
})

const SimpleSchema = Schema.struct({
  title: Schema.text(),
  count: Schema.number(),
})

// ===========================================================================
// Tests
// ===========================================================================

describe("yjs.bind", () => {
  // -------------------------------------------------------------------------
  // BoundSchema shape
  // -------------------------------------------------------------------------

  describe("BoundSchema", () => {
    it("creates BoundSchema with collaborative strategy", () => {
      const bound = yjs.bind(TodoSchema)
      expect(bound._brand).toBe("BoundSchema")
      expect(bound.schema).toBe(TodoSchema)
      expect(bound.strategy).toBe("collaborative")
    })

    it("has a factory builder function", () => {
      const bound = yjs.bind(TodoSchema)
      expect(typeof bound.factory).toBe("function")
    })

    it("preserves the schema reference", () => {
      const bound = yjs.bind(SimpleSchema)
      expect(bound.schema).toBe(SimpleSchema)
    })
  })

  // -------------------------------------------------------------------------
  // Factory builder
  // -------------------------------------------------------------------------

  describe("factory builder", () => {
    it("produces a working SubstrateFactory", () => {
      const bound = yjs.bind(SimpleSchema)
      const factory = bound.factory({ peerId: "peer-1" })

      const _substrate = factory.create(SimpleSchema)

      // Populate via the substrate's writable context
      const doc = createYjsDocFromFactory(factory, SimpleSchema)
      change(doc, (d: any) => {
        d.title.insert(0, "Test")
        d.count.set(7)
      })

      expect(doc.title()).toBe("Test")
      expect(doc.count()).toBe(7)
    })

    it("factory supports fromEntirety", () => {
      const bound = yjs.bind(SimpleSchema)
      const factory = bound.factory({ peerId: "peer-1" })

      // Create and populate
      const doc1 = createYjsDocFromFactory(factory, SimpleSchema)
      change(doc1, (d: any) => {
        d.title.insert(0, "Snap")
        d.count.set(42)
      })
      const snapshot = exportEntirety(doc1)

      // Restore
      const substrate2 = factory.fromEntirety(snapshot, SimpleSchema)
      expect(substrate2.reader.read(RawPath.empty.field("title"))).toBe("Snap")
      expect(substrate2.reader.read(RawPath.empty.field("count"))).toBe(42)
    })

    it("factory supports parseVersion", () => {
      const bound = yjs.bind(SimpleSchema)
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
      const bound = yjs.bind(SimpleSchema)
      const factory = bound.factory({ peerId: "stable-peer-id" })

      const _s1 = factory.create(SimpleSchema)
      const _s2 = factory.create(SimpleSchema)

      // Both docs should have the same clientID
      const doc1 = unwrap(
        createYjsDocFromFactory(factory, SimpleSchema),
      ) as Y.Doc
      const doc2 = unwrap(
        createYjsDocFromFactory(factory, SimpleSchema),
      ) as Y.Doc

      expect(doc1.clientID).toBe(doc2.clientID)
    })

    it("different peerIds produce different clientIDs", () => {
      const bound = yjs.bind(SimpleSchema)
      const factory1 = bound.factory({ peerId: "peer-alpha" })
      const factory2 = bound.factory({ peerId: "peer-beta" })

      const doc1 = unwrap(
        createYjsDocFromFactory(factory1, SimpleSchema),
      ) as Y.Doc
      const doc2 = unwrap(
        createYjsDocFromFactory(factory2, SimpleSchema),
      ) as Y.Doc

      expect(doc1.clientID).not.toBe(doc2.clientID)
    })

    it("clientID is a valid uint32", () => {
      const bound = yjs.bind(SimpleSchema)
      const factory = bound.factory({ peerId: "test-peer-id-12345" })
      const doc = unwrap(
        createYjsDocFromFactory(factory, SimpleSchema),
      ) as Y.Doc

      expect(typeof doc.clientID).toBe("number")
      expect(doc.clientID).toBeGreaterThanOrEqual(0)
      expect(doc.clientID).toBeLessThanOrEqual(0xffffffff)
      expect(Number.isInteger(doc.clientID)).toBe(true)
    })

    it("clientID is deterministic across restarts (same string → same number)", () => {
      const peerId = "deterministic-check-peer"

      // Simulate two separate "sessions" — both should hash to the same value
      const bound1 = yjs.bind(SimpleSchema)
      const factory1 = bound1.factory({ peerId })
      const doc1 = unwrap(
        createYjsDocFromFactory(factory1, SimpleSchema),
      ) as Y.Doc

      const bound2 = yjs.bind(SimpleSchema)
      const factory2 = bound2.factory({ peerId })
      const doc2 = unwrap(
        createYjsDocFromFactory(factory2, SimpleSchema),
      ) as Y.Doc

      expect(doc1.clientID).toBe(doc2.clientID)
    })
  })

  // -------------------------------------------------------------------------
  // unwrap() escape hatch
  // -------------------------------------------------------------------------

  describe("unwrap() escape hatch", () => {
    it("returns the underlying Y.Doc from a createDoc ref", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      change(doc, (d: any) => {
        d.title.insert(0, "Escape")
        d.count.set(0)
      })
      const yjsDoc = unwrap(doc) as Y.Doc

      expect(yjsDoc).toBeInstanceOf(Y.Doc)
      expect(yjsDoc.getMap("root").get("count")).toBe(0)
    })

    it("returns a Y.Doc with the correct root map state", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      change(doc, (d: any) => {
        d.title.insert(0, "Hello")
        d.count.set(42)
      })
      const yjsDoc = unwrap(doc) as Y.Doc
      const rootMap = yjsDoc.getMap("root")

      expect((rootMap.get("title") as Y.Text).toJSON()).toBe("Hello")
      expect(rootMap.get("count")).toBe(42)
    })

    it("returns undefined for non-refs (plain object)", () => {
      expect(unwrap({} as any)).toBeUndefined()
    })

    it("returns undefined for non-refs (random object with properties)", () => {
      const fake = {
        title: () => "fake",
        count: () => 0,
      }
      expect(unwrap(fake as any)).toBeUndefined()
    })

    it("throws for primitives", () => {
      expect(() => unwrap(null as any)).toThrow("unwrap() requires a ref")
      expect(() => unwrap(undefined as any)).toThrow("unwrap() requires a ref")
    })

    it("mutations through escape hatch are visible via kyneta ref", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      const yjsDoc = unwrap(doc) as Y.Doc

      // Mutate via raw Yjs
      yjsDoc.getMap("root").set("count", 99)
      expect(doc.count()).toBe(99)
    })

    it("text mutations through escape hatch are visible", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      change(doc, (d: any) => {
        d.title.insert(0, "Hello")
      })
      const yjsDoc = unwrap(doc) as Y.Doc

      const text = yjsDoc.getMap("root").get("title") as Y.Text
      text.insert(5, " World")
      expect(doc.title()).toBe("Hello World")
    })
  })
})

// ===========================================================================
// Helper — create a doc via a factory and return a ref with escape hatch
// ===========================================================================

import type { Schema as SchemaType, SubstrateFactory } from "@kyneta/schema"

/**
 * Helper to create a kyneta ref from a factory (mimicking what exchange.get does).
 * This exercises the factory's create path including clientID injection.
 */
function createYjsDocFromFactory(
  factory: SubstrateFactory<any>,
  schema: SchemaType,
): any {
  const substrate = factory.create(schema)
  return createRef(schema, substrate)
}
