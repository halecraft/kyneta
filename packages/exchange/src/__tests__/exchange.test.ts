// Exchange — unit tests for the public Exchange API.

import { describe, expect, it } from "vitest"
import { Schema, plainSubstrateFactory } from "@kyneta/schema"
import { Exchange } from "../exchange.js"
import { sync, hasSync } from "../sync.js"
import type { ExchangeSubstrateFactory } from "../factory.js"
import type { MergeStrategy } from "../factory.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Wrap plainSubstrateFactory as an ExchangeSubstrateFactory with sequential merge.
 */
function createPlainExchangeFactory(): ExchangeSubstrateFactory<any> {
  let initialized = false
  return {
    ...plainSubstrateFactory,
    mergeStrategy: { type: "sequential" } as MergeStrategy,
    _initialize(_context: { peerId: string }) {
      initialized = true
    },
    // Expose for testing
    get _initialized() {
      return initialized
    },
  } as ExchangeSubstrateFactory<any> & { _initialized: boolean }
}

const testSchema = Schema.doc({
  title: Schema.string(),
  count: Schema.number(),
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Exchange", () => {
  describe("constructor", () => {
    it("creates with auto-generated peerId", () => {
      const factory = createPlainExchangeFactory()
      const exchange = new Exchange({
        substrates: { plain: factory },
      })

      expect(exchange.peerId).toBeDefined()
      expect(typeof exchange.peerId).toBe("string")
      expect(exchange.peerId.length).toBeGreaterThan(0)
    })

    it("creates with explicit peerId", () => {
      const factory = createPlainExchangeFactory()
      const exchange = new Exchange({
        identity: { peerId: "my-peer" },
        substrates: { plain: factory },
      })

      expect(exchange.peerId).toBe("my-peer")
    })

    it("initializes all factories with peerId", () => {
      const factory = createPlainExchangeFactory() as ExchangeSubstrateFactory<any> & { _initialized: boolean }
      const exchange = new Exchange({
        identity: { peerId: "test-peer" },
        substrates: { plain: factory },
      })

      expect(factory._initialized).toBe(true)
    })

    it("throws if defaultSubstrate is not in substrates", () => {
      expect(
        () =>
          new Exchange({
            substrates: { plain: createPlainExchangeFactory() },
            defaultSubstrate: "nonexistent",
          }),
      ).toThrow("not found in substrates")
    })

    it("auto-selects default when only one substrate is provided", () => {
      const factory = createPlainExchangeFactory()
      const exchange = new Exchange({
        substrates: { plain: factory },
      })

      // Should not throw — auto-detected default
      const doc = exchange.get("test-doc", testSchema)
      expect(doc).toBeDefined()
    })
  })

  describe("get()", () => {
    it("returns a Ref<S> that can be read", () => {
      const factory = createPlainExchangeFactory()
      const exchange = new Exchange({
        substrates: { plain: factory },
      })

      const doc = exchange.get("doc-1", testSchema)

      // The ref should be callable (returns plain value)
      const value = doc()
      expect(value).toEqual({ title: "", count: 0 })
    })

    it("returns a Ref<S> that can be read with navigation", () => {
      const factory = createPlainExchangeFactory()
      const exchange = new Exchange({
        substrates: { plain: factory },
      })

      const doc = exchange.get("doc-1", testSchema, {
        seed: { title: "Hello", count: 42 },
      })

      expect(doc.title()).toBe("Hello")
      expect(doc.count()).toBe(42)
    })

    it("same docId returns same instance", () => {
      const factory = createPlainExchangeFactory()
      const exchange = new Exchange({
        substrates: { plain: factory },
      })

      const doc1 = exchange.get("doc-1", testSchema)
      const doc2 = exchange.get("doc-1", testSchema)

      expect(doc1).toBe(doc2)
    })

    it("different schema for same docId throws", () => {
      const factory = createPlainExchangeFactory()
      const exchange = new Exchange({
        substrates: { plain: factory },
      })

      const otherSchema = Schema.doc({ name: Schema.string() })

      exchange.get("doc-1", testSchema)
      expect(() => exchange.get("doc-1", otherSchema)).toThrow(
        "different schema",
      )
    })

    it("throws if no substrate specified and no default", () => {
      const exchange = new Exchange({
        substrates: {
          plain: createPlainExchangeFactory(),
          lww: createPlainExchangeFactory(),
        },
        // No defaultSubstrate, and more than one substrate
      })

      expect(() => exchange.get("doc-1", testSchema)).toThrow(
        "No substrate specified",
      )
    })

    it("explicit substrate option overrides default", () => {
      const plainFactory = createPlainExchangeFactory()
      const otherFactory = createPlainExchangeFactory()

      const exchange = new Exchange({
        substrates: { plain: plainFactory, other: otherFactory },
        defaultSubstrate: "plain",
      })

      // Should use "other" factory
      const doc = exchange.get("doc-1", testSchema, { substrate: "other" })
      expect(doc).toBeDefined()
    })

    it("throws for unknown substrate name", () => {
      const exchange = new Exchange({
        substrates: { plain: createPlainExchangeFactory() },
      })

      expect(() =>
        exchange.get("doc-1", testSchema, { substrate: "nonexistent" }),
      ).toThrow("not found")
    })

    it("seed values are applied", () => {
      const factory = createPlainExchangeFactory()
      const exchange = new Exchange({
        substrates: { plain: factory },
      })

      const doc = exchange.get("doc-1", testSchema, {
        seed: { title: "Seeded", count: 99 },
      })

      expect(doc.title()).toBe("Seeded")
      expect(doc.count()).toBe(99)
    })
  })

  describe("has()", () => {
    it("returns false for unknown doc", () => {
      const exchange = new Exchange({
        substrates: { plain: createPlainExchangeFactory() },
      })

      expect(exchange.has("nonexistent")).toBe(false)
    })

    it("returns true after get()", () => {
      const exchange = new Exchange({
        substrates: { plain: createPlainExchangeFactory() },
      })

      exchange.get("doc-1", testSchema)
      expect(exchange.has("doc-1")).toBe(true)
    })
  })

  describe("delete()", () => {
    it("removes a document", async () => {
      const exchange = new Exchange({
        substrates: { plain: createPlainExchangeFactory() },
      })

      exchange.get("doc-1", testSchema)
      expect(exchange.has("doc-1")).toBe(true)

      await exchange.delete("doc-1")
      expect(exchange.has("doc-1")).toBe(false)
    })
  })

  describe("sync()", () => {
    it("returns a SyncRef with peerId and docId", () => {
      const exchange = new Exchange({
        identity: { peerId: "alice" },
        substrates: { plain: createPlainExchangeFactory() },
      })

      const doc = exchange.get("doc-1", testSchema)
      const s = sync(doc)

      expect(s.peerId).toBe("alice")
      expect(s.docId).toBe("doc-1")
    })

    it("hasSync returns true for exchange docs", () => {
      const exchange = new Exchange({
        substrates: { plain: createPlainExchangeFactory() },
      })

      const doc = exchange.get("doc-1", testSchema)
      expect(hasSync(doc)).toBe(true)
    })

    it("hasSync returns false for non-exchange objects", () => {
      expect(hasSync({})).toBe(false)
    })

    it("sync() throws for non-exchange objects", () => {
      expect(() => sync({})).toThrow("exchange.get()")
    })

    it("readyStates is initially empty", () => {
      const exchange = new Exchange({
        substrates: { plain: createPlainExchangeFactory() },
      })

      const doc = exchange.get("doc-1", testSchema)
      expect(sync(doc).readyStates).toEqual([])
    })
  })

  describe("lifecycle", () => {
    it("reset() clears doc cache", () => {
      const exchange = new Exchange({
        substrates: { plain: createPlainExchangeFactory() },
      })

      exchange.get("doc-1", testSchema)
      expect(exchange.has("doc-1")).toBe(true)

      exchange.reset()
      expect(exchange.has("doc-1")).toBe(false)
    })

    it("shutdown() clears doc cache", async () => {
      const exchange = new Exchange({
        substrates: { plain: createPlainExchangeFactory() },
      })

      exchange.get("doc-1", testSchema)
      await exchange.shutdown()
      expect(exchange.has("doc-1")).toBe(false)
    })
  })
})