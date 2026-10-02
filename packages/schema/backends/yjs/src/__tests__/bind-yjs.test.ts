import {
  batch,
  createRef,
  createSubstrate,
  deriveIdentity,
  exportEntirety,
  RawPath,
  Schema,
  SYNC_COLLABORATIVE,
  substrateFromEntirety,
  unwrap,
} from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import * as Y from "yjs"
import { yjs, yjsClientId } from "../bind-yjs.js"

// ===========================================================================
// Identity-keying helpers
// ===========================================================================

function id(fieldName: string): string {
  return deriveIdentity(fieldName, 1)
}

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
    it("creates BoundSchema with collaborative sync protocol", () => {
      const bound = yjs.bind(TodoSchema)
      expect(bound._brand).toBe("BoundSchema")
      expect(bound.schema).toBe(TodoSchema)
      expect(bound.syncMode).toEqual(SYNC_COLLABORATIVE)
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
      const factory = bound.factory({
        peerId: "peer-1",
        binding: bound.identityBinding,
      })

      const doc = createYjsDocFromFactory(factory, SimpleSchema)
      batch(doc, (d: any) => {
        d.title.insert(0, "Test")
        d.count.set(7)
      })

      expect(doc.title()).toBe("Test")
      expect(doc.count()).toBe(7)
    })

    it("a bound factory builds a substrate from an entirety", () => {
      const bound = yjs.bind(SimpleSchema)
      const factory = bound.factory({
        peerId: "peer-1",
        binding: bound.identityBinding,
      })

      // Create and populate
      const doc1 = createYjsDocFromFactory(factory, SimpleSchema)
      batch(doc1, (d: any) => {
        d.title.insert(0, "Snap")
        d.count.set(42)
      })
      const snapshot = exportEntirety(doc1)

      // Restore
      const substrate2 = substrateFromEntirety(factory, snapshot, SimpleSchema)
      expect(substrate2.reader.read(RawPath.empty.field("title"))).toBe("Snap")
      expect(substrate2.reader.read(RawPath.empty.field("count"))).toBe(42)
    })

    it("factory supports parseVersion", () => {
      const bound = yjs.bind(SimpleSchema)
      const factory = bound.factory({
        peerId: "peer-1",
        binding: bound.identityBinding,
      })

      const substrate = createSubstrate(factory, SimpleSchema)
      const v = substrate.version()
      const serialized = v.serialize()
      const parsed = factory.replica.parseVersion(serialized)
      expect(parsed.compare(v)).toBe("equal")
    })
  })

  // -------------------------------------------------------------------------
  // Deterministic clientID from peerId
  // -------------------------------------------------------------------------

  describe("deterministic clientID", () => {
    const clientIdOf = (peerId: string): number => {
      // A fresh bind per document stands in for a restart.
      const bound = yjs.bind(SimpleSchema)
      const factory = bound.factory({ peerId, binding: bound.identityBinding })
      return (unwrap(createYjsDocFromFactory(factory, SimpleSchema)) as Y.Doc)
        .clientID
    }

    it("every document claims yjsClientId of the peer id", () => {
      const clientId = yjsClientId("stable-peer-id")
      expect(Number.isSafeInteger(clientId)).toBe(true)
      expect(clientId).toBeGreaterThan(0)
      expect(clientIdOf("stable-peer-id")).toBe(clientId)
      expect(clientIdOf("stable-peer-id")).toBe(clientId)
    })

    it("different peerIds produce different clientIDs", () => {
      expect(clientIdOf("peer-alpha")).not.toBe(clientIdOf("peer-beta"))
    })
  })

  // -------------------------------------------------------------------------
  // unwrap() escape hatch
  // -------------------------------------------------------------------------

  describe("unwrap() escape hatch", () => {
    it("returns the underlying Y.Doc from a createDoc ref", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      batch(doc, (d: any) => {
        d.title.insert(0, "Escape")
        d.count.set(0)
      })
      const yjsDoc = unwrap(doc) as Y.Doc

      expect(yjsDoc).toBeInstanceOf(Y.Doc)
      expect(yjsDoc.getMap("root").get(id("count"))).toBe(0)
    })

    it("returns a Y.Doc with the correct root map state", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      batch(doc, (d: any) => {
        d.title.insert(0, "Hello")
        d.count.set(42)
      })
      const yjsDoc = unwrap(doc) as Y.Doc
      const rootMap = yjsDoc.getMap("root")

      expect((rootMap.get(id("title")) as Y.Text).toJSON()).toBe("Hello")
      expect(rootMap.get(id("count"))).toBe(42)
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
      yjsDoc.getMap("root").set(id("count"), 99)
      expect(doc.count()).toBe(99)
    })

    it("text mutations through escape hatch are visible", () => {
      const doc = createDoc(yjs.bind(SimpleSchema))
      batch(doc, (d: any) => {
        d.title.insert(0, "Hello")
      })
      const yjsDoc = unwrap(doc) as Y.Doc

      const text = yjsDoc.getMap("root").get(id("title")) as Y.Text
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
  const substrate = createSubstrate(factory, schema)
  return createRef(schema, substrate)
}
