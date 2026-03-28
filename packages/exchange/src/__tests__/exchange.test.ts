// Exchange — unit tests for the public Exchange API.

import { describe, expect, it, vi, afterEach } from "vitest"
import {
  Schema,
  LoroSchema,
  bindPlain,
  bindLww,
  bind,
  change,
  plainSubstrateFactory,
  unwrap,
} from "@kyneta/schema"
import { bindLoro, loro } from "@kyneta/loro-schema"
import { Exchange } from "../exchange.js"
import { sync, hasSync } from "../sync.js"
import { Bridge, BridgeAdapter } from "../adapter/bridge-adapter.js"

// ---------------------------------------------------------------------------
// Test schemas (bound at module scope)
// ---------------------------------------------------------------------------

const testSchema = Schema.doc({
  title: Schema.string(),
  count: Schema.number(),
})

const TestDoc = bindPlain(testSchema)

const otherSchema = Schema.doc({ name: Schema.string() })
const OtherDoc = bindPlain(otherSchema)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Helpers for multi-peer tests
// ---------------------------------------------------------------------------

async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((r) => queueMicrotask(r))
    await new Promise<void>((r) => setTimeout(r, 0))
  }
}

const activeExchanges: Exchange[] = []

function createExchange(params: ConstructorParameters<typeof Exchange>[0] = {}): Exchange {
  const ex = new Exchange(params)
  activeExchanges.push(ex)
  return ex
}

afterEach(async () => {
  for (const ex of activeExchanges) {
    try { await ex.shutdown() } catch { /* ignore */ }
  }
  activeExchanges.length = 0
})

// ---------------------------------------------------------------------------

describe("Exchange", () => {
  describe("constructor", () => {
    it("creates with auto-generated peerId", () => {
      const exchange = new Exchange()

      expect(exchange.peerId).toBeDefined()
      expect(typeof exchange.peerId).toBe("string")
      expect(exchange.peerId.length).toBeGreaterThan(0)
    })

    it("creates with explicit peerId", () => {
      const exchange = new Exchange({
        identity: { peerId: "my-peer" },
      })

      expect(exchange.peerId).toBe("my-peer")
    })

  })

  describe("get()", () => {
    it("returns a Ref<S> that can be read", () => {
      const exchange = new Exchange()
      const doc = exchange.get("doc-1", TestDoc)

      // The ref should be callable (returns plain value)
      const value = doc()
      expect(value).toEqual({ title: "", count: 0 })
    })

    it("returns a Ref<S> with navigation and change()-applied values", () => {
      const exchange = new Exchange()
      const doc = exchange.get("doc-1", TestDoc)
      change(doc, (d: any) => {
        d.title.set("Hello")
        d.count.set(42)
      })

      expect(doc.title()).toBe("Hello")
      expect(doc.count()).toBe(42)
    })

    it("same docId returns same instance", () => {
      const exchange = new Exchange()

      const doc1 = exchange.get("doc-1", TestDoc)
      const doc2 = exchange.get("doc-1", TestDoc)

      expect(doc1).toBe(doc2)
    })

    it("different BoundSchema for same docId throws", () => {
      const exchange = new Exchange()

      exchange.get("doc-1", TestDoc)
      expect(() => exchange.get("doc-1", OtherDoc)).toThrow(
        "different BoundSchema",
      )
    })

    it("change() values are applied", () => {
      const exchange = new Exchange()
      const doc = exchange.get("doc-1", TestDoc)
      change(doc, (d: any) => {
        d.title.set("Changed")
        d.count.set(99)
      })

      expect(doc.title()).toBe("Changed")
      expect(doc.count()).toBe(99)
    })
  })

  describe("factory builder lifecycle", () => {
    it("factory builder is called with the exchange's peerId", () => {
      const builder = vi.fn(() => plainSubstrateFactory)
      const Doc = bind({ schema: testSchema, factory: builder, strategy: "sequential" })

      const exchange = new Exchange({ identity: { peerId: "alice-123" } })
      exchange.get("doc-1", Doc)

      expect(builder).toHaveBeenCalledWith({ peerId: "alice-123" })
    })

    it("factory builder is called only once per unique builder (cached)", () => {
      const builder = vi.fn(() => plainSubstrateFactory)
      const DocA = bind({ schema: testSchema, factory: builder, strategy: "sequential" })
      const DocB = bind({ schema: otherSchema, factory: builder, strategy: "sequential" })

      const exchange = new Exchange()
      exchange.get("doc-1", DocA)
      exchange.get("doc-2", DocB)

      // Same builder → called only once
      expect(builder).toHaveBeenCalledTimes(1)
    })

    it("two exchanges sharing the same BoundSchema get independent factory instances", () => {
      const factories: any[] = []
      const builder = vi.fn((ctx: { peerId: string }) => {
        const f = { ...plainSubstrateFactory, _peerId: ctx.peerId }
        factories.push(f)
        return f
      })
      const Doc = bind({ schema: testSchema, factory: builder, strategy: "sequential" })

      const exchangeA = new Exchange({ identity: { peerId: "alice" } })
      const exchangeB = new Exchange({ identity: { peerId: "bob" } })

      exchangeA.get("doc-1", Doc)
      exchangeB.get("doc-1", Doc)

      // Builder called twice — once per exchange
      expect(builder).toHaveBeenCalledTimes(2)
      expect(builder).toHaveBeenCalledWith({ peerId: "alice" })
      expect(builder).toHaveBeenCalledWith({ peerId: "bob" })

      // Separate factory instances
      expect(factories.length).toBe(2)
      expect(factories[0]).not.toBe(factories[1])
    })
  })

  describe("has()", () => {
    it("returns false for unknown doc", () => {
      const exchange = new Exchange()
      expect(exchange.has("nonexistent")).toBe(false)
    })

    it("returns true after get()", () => {
      const exchange = new Exchange()
      exchange.get("doc-1", TestDoc)
      expect(exchange.has("doc-1")).toBe(true)
    })
  })

  describe("delete()", () => {
    it("removes a document", async () => {
      const exchange = new Exchange()

      exchange.get("doc-1", TestDoc)
      expect(exchange.has("doc-1")).toBe(true)

      await exchange.delete("doc-1")
      expect(exchange.has("doc-1")).toBe(false)
    })
  })

  describe("sync()", () => {
    it("returns a SyncRef with peerId and docId", () => {
      const exchange = new Exchange({ identity: { peerId: "alice" } })
      const doc = exchange.get("doc-1", TestDoc)
      const s = sync(doc)

      expect(s.peerId).toBe("alice")
      expect(s.docId).toBe("doc-1")
    })

    it("hasSync returns true for exchange docs", () => {
      const exchange = new Exchange()
      const doc = exchange.get("doc-1", TestDoc)
      expect(hasSync(doc)).toBe(true)
    })

    it("hasSync returns false for non-exchange objects", () => {
      expect(hasSync({})).toBe(false)
    })

    it("sync() throws for non-exchange objects", () => {
      expect(() => sync({})).toThrow("exchange.get()")
    })

    it("readyStates is initially empty", () => {
      const exchange = new Exchange()
      const doc = exchange.get("doc-1", TestDoc)
      expect(sync(doc).readyStates).toEqual([])
    })
  })

  describe("lifecycle", () => {
    it("reset() clears doc cache", () => {
      const exchange = new Exchange()

      exchange.get("doc-1", TestDoc)
      expect(exchange.has("doc-1")).toBe(true)

      exchange.reset()
      expect(exchange.has("doc-1")).toBe(false)
    })

    it("shutdown() clears doc cache", async () => {
      const exchange = new Exchange()

      exchange.get("doc-1", TestDoc)
      await exchange.shutdown()
      expect(exchange.has("doc-1")).toBe(false)
    })

    describe("escape hatches", () => {
      it("unwrap(ref) returns the substrate for an exchange-created doc", () => {
        const exchange = new Exchange()
        const doc = exchange.get("doc-1", TestDoc)
        change(doc, (d: any) => {
          d.title.set("Hi")
          d.count.set(1)
        })

        const substrate = unwrap(doc)
        expect(substrate.version()).toBeDefined()

        const snapshot = substrate.exportSnapshot()
        expect(snapshot.encoding).toBe("json")
        expect(JSON.parse(snapshot.data as string)).toEqual({ title: "Hi", count: 1 })
      })

      it("loro(ref) returns the LoroDoc for a Loro-backed exchange doc", () => {
        const LoroDoc = bindLoro(LoroSchema.doc({ title: LoroSchema.text() }))
        const exchange = new Exchange()
        const doc = exchange.get("doc-1", LoroDoc)

        const loroDoc = loro(doc)
        expect(typeof loroDoc.toJSON).toBe("function")
        expect(typeof loroDoc.getText).toBe("function")
      })

      it("loro(ref) throws for a plain-backed exchange doc", () => {
        const exchange = new Exchange()
        const doc = exchange.get("doc-1", TestDoc)

        expect(() => loro(doc)).toThrow("not a Loro substrate")
      })
    })

    describe("changefeed → synchronizer auto-wiring", () => {
      it("change() auto-notifies synchronizer — no manual notifyLocalChange needed", async () => {
        const bridge = new Bridge()

        const exchangeA = createExchange({
          identity: { peerId: "alice" },
          adapters: [new BridgeAdapter({ adapterType: "alice", bridge })],
        })
        const exchangeB = createExchange({
          identity: { peerId: "bob" },
          adapters: [new BridgeAdapter({ adapterType: "bob", bridge })],
        })

        const docA = exchangeA.get("doc-1", TestDoc)
        change(docA, (d: any) => {
          d.title.set("V1")
          d.count.set(1)
        })
        const docB = exchangeB.get("doc-1", TestDoc)

        // Initial sync
        await drain()
        expect(docB.title()).toBe("V1")

        // Mutate WITHOUT calling notifyLocalChange — auto-wiring should handle it
        change(docA, (d: any) => {
          d.title.set("V2")
          d.count.set(2)
        })

        await drain()

        // Bob should see the mutation via auto-wired sync
        expect(docB.title()).toBe("V2")
        expect(docB.count()).toBe(2)
      })
    })
  })
})