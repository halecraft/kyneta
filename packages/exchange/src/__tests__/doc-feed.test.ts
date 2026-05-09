// Document feed — tests for `exchange.documents` reactive collection.
//
// Verifies the `ReactiveMap<DocId, DocInfo, DocChange>` surface exposed
// via `exchange.documents`, including snapshot access, subscription events,
// reset/shutdown, and two-peer integration.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { hasChangefeed } from "@kyneta/changefeed"
import { loro } from "@kyneta/loro-schema"
import {
  Defer,
  json,
  plainReplicaFactory,
  Schema,
  SYNC_AUTHORITATIVE,
} from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import {
  Exchange,
  type ExchangeParams,
  type PeerIdentityInput,
} from "../exchange.js"
import type { DocChange, DocInfo } from "../types.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function drain(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

const activeExchanges: Exchange[] = []

function createExchange(params: Partial<ExchangeParams> = {}): Exchange {
  const merged = { id: "test" as string | PeerIdentityInput, ...params }
  const ex = new Exchange(merged as ExchangeParams)
  activeExchanges.push(ex)
  return ex
}

afterEach(async () => {
  for (const ex of activeExchanges) {
    try {
      await ex.shutdown()
    } catch {
      /* ignore */
    }
  }
  activeExchanges.length = 0
})

// ---------------------------------------------------------------------------
// Test schemas
// ---------------------------------------------------------------------------

const testSchema = Schema.struct({
  title: Schema.string(),
  count: Schema.number(),
})

const TestDoc = json.bind(testSchema)

const collabSchema = Schema.struct({ text: Schema.text() })
const CollabDoc = loro.bind(collabSchema)

// ---------------------------------------------------------------------------
// Reactive map basics
// ---------------------------------------------------------------------------

describe("exchange.documents", () => {
  describe("reactive map basics", () => {
    it("returns empty ReadonlyMap initially", () => {
      const exchange = createExchange({
        id: "alice",
      })

      const docs = exchange.documents()
      expect(docs).toBeInstanceOf(Map)
      expect(docs.size).toBe(0)
    })

    it("hasChangefeed returns true", () => {
      const exchange = createExchange({
        id: "alice",
      })

      expect(hasChangefeed(exchange.documents)).toBe(true)
    })

    it("after get(): documents.has() is true, get() returns { mode: 'interpret' }", () => {
      const exchange = createExchange({
        id: "alice",
      })

      exchange.get("doc-1", TestDoc)

      // The doc feed updates at quiescence — the synchronizer's
      // registerDoc fires during get() which triggers a dispatch cycle.
      expect(exchange.documents.has("doc-1")).toBe(true)
      expect(exchange.documents.get("doc-1")).toEqual({
        mode: "interpret",
        suspended: false,
      })
    })

    it("after replicate(): documents.get() returns { mode: 'replicate' }", () => {
      const exchange = createExchange({
        id: "alice",
      })

      exchange.replicate(
        "rep-1",
        plainReplicaFactory,
        SYNC_AUTHORITATIVE,
        "00test",
      )

      expect(exchange.documents.has("rep-1")).toBe(true)
      expect(exchange.documents.get("rep-1")).toEqual({
        mode: "replicate",
        suspended: false,
      })
    })

    it("after destroy(): documents.has() is false", () => {
      const exchange = createExchange({
        id: "alice",
      })

      exchange.get("doc-1", TestDoc)
      expect(exchange.documents.has("doc-1")).toBe(true)

      exchange.destroy("doc-1")

      expect(exchange.documents.has("doc-1")).toBe(false)
    })

    it("documents.size reflects the number of tracked docs", () => {
      const exchange = createExchange({
        id: "alice",
      })

      expect(exchange.documents.size).toBe(0)

      exchange.get("doc-1", TestDoc)
      exchange.get("doc-2", TestDoc)

      expect(exchange.documents.size).toBe(2)

      exchange.destroy("doc-1")

      expect(exchange.documents.size).toBe(1)
    })

    it("documents.keys() iterates over all tracked doc IDs", () => {
      const exchange = createExchange({
        id: "alice",
      })

      exchange.get("doc-a", TestDoc)
      exchange.get("doc-b", TestDoc)

      const keys = new Set(exchange.documents.keys())
      expect(keys.has("doc-a")).toBe(true)
      expect(keys.has("doc-b")).toBe(true)
      expect(keys.size).toBe(2)
    })

    it("[Symbol.iterator] iterates over [docId, DocInfo] pairs", () => {
      const exchange = createExchange({
        id: "alice",
      })

      exchange.get("doc-1", TestDoc)
      exchange.replicate(
        "rep-1",
        plainReplicaFactory,
        SYNC_AUTHORITATIVE,
        "00test",
      )

      const entries = new Map(exchange.documents)
      expect(entries.get("doc-1")).toEqual({
        mode: "interpret",
        suspended: false,
      })
      expect(entries.get("rep-1")).toEqual({
        mode: "replicate",
        suspended: false,
      })
    })
  })

  // -------------------------------------------------------------------------
  // Subscription events
  // -------------------------------------------------------------------------

  describe("subscription events", () => {
    it("subscribe receives doc-created for get()", () => {
      const exchange = createExchange({
        id: "alice",
      })

      const changes: DocChange[] = []
      exchange.documents.subscribe(cs => {
        changes.push(...cs.changes)
      })

      exchange.get("doc-1", TestDoc)

      expect(changes.length).toBe(1)
      expect(changes[0].type).toBe("doc-created")
      expect(changes[0].docId).toBe("doc-1")
    })

    it("subscribe receives doc-created for replicate()", () => {
      const exchange = createExchange({
        id: "alice",
      })

      const changes: DocChange[] = []
      exchange.documents.subscribe(cs => {
        changes.push(...cs.changes)
      })

      exchange.replicate(
        "rep-1",
        plainReplicaFactory,
        SYNC_AUTHORITATIVE,
        "00test",
      )

      expect(changes.length).toBe(1)
      expect(changes[0].type).toBe("doc-created")
      expect(changes[0].docId).toBe("rep-1")
    })

    it("subscribe receives doc-removed on destroy", () => {
      const exchange = createExchange({
        id: "alice",
      })

      exchange.get("doc-1", TestDoc)

      const changes: DocChange[] = []
      exchange.documents.subscribe(cs => {
        changes.push(...cs.changes)
      })

      exchange.destroy("doc-1")

      expect(changes.length).toBe(1)
      expect(changes[0].type).toBe("doc-removed")
      expect(changes[0].docId).toBe("doc-1")
    })

    it("subscribe receives doc-deferred for deferred docs via resolve → Defer()", async () => {
      const bridge = new Bridge()

      const exchangeA = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })

      const changes: DocChange[] = []

      const exchangeB = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
        resolve: () => Defer(),
      })

      exchangeB.documents.subscribe(cs => {
        changes.push(...cs.changes)
      })

      // Alice creates a doc — Bob defers it
      exchangeA.get("deferred-doc", TestDoc)

      await drain()

      const deferredEvents = changes.filter(c => c.type === "doc-deferred")
      expect(deferredEvents.length).toBe(1)
      expect(deferredEvents[0].docId).toBe("deferred-doc")
      expect(exchangeB.documents.get("deferred-doc")).toEqual({
        mode: "deferred",
        suspended: false,
      })
    })

    it("subscribe receives doc-promoted when deferred doc is promoted via get()", async () => {
      const bridge = new Bridge()

      const exchangeA = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })

      const exchangeB = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
        resolve: () => Defer(),
      })

      // Alice creates a doc — Bob defers it
      exchangeA.get("promote-doc", TestDoc)
      await drain()

      expect(exchangeB.deferred.has("promote-doc")).toBe(true)

      const changes: DocChange[] = []
      exchangeB.documents.subscribe(cs => {
        changes.push(...cs.changes)
      })

      // Bob promotes by calling get()
      exchangeB.get("promote-doc", TestDoc)

      const promotedEvents = changes.filter(c => c.type === "doc-promoted")
      expect(promotedEvents.length).toBe(1)
      expect(promotedEvents[0].docId).toBe("promote-doc")
      expect(exchangeB.documents.get("promote-doc")).toEqual({
        mode: "interpret",
        suspended: false,
      })
    })

    it("unsubscribe stops receiving events", () => {
      const exchange = createExchange({
        id: "alice",
      })

      const changes: DocChange[] = []
      const unsub = exchange.documents.subscribe(cs => {
        changes.push(...cs.changes)
      })

      exchange.get("doc-1", TestDoc)
      expect(changes.length).toBe(1)

      unsub()

      exchange.get("doc-2", TestDoc)
      // Should not have received the second event
      expect(changes.length).toBe(1)
    })
  })

  // -------------------------------------------------------------------------
  // Consistency with existing APIs
  // -------------------------------------------------------------------------

  describe("consistency with existing APIs", () => {
    it("exchange.documentIds() still returns interpret-mode docs from #docCache", () => {
      const exchange = createExchange({
        id: "alice",
      })

      exchange.get("doc-1", TestDoc)
      exchange.get("doc-2", TestDoc)
      exchange.replicate(
        "rep-1",
        plainReplicaFactory,
        SYNC_AUTHORITATIVE,
        "00test",
      )

      const ids = exchange.documentIds()
      expect(ids.has("doc-1")).toBe(true)
      expect(ids.has("doc-2")).toBe(true)
      expect(ids.has("rep-1")).toBe(false) // replicate not in documentIds
      expect(ids.size).toBe(2)
    })

    it("exchange.has(docId) still reads from #docCache", () => {
      const exchange = createExchange({
        id: "alice",
      })

      exchange.get("doc-1", TestDoc)

      expect(exchange.has("doc-1")).toBe(true)
      expect(exchange.has("nonexistent")).toBe(false)
    })

    it("exchange.deferred still returns deferred docs from #docCache", async () => {
      const bridge = new Bridge()

      const exchangeA = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })

      const exchangeB = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
        resolve: () => Defer(),
      })

      exchangeA.get("deferred-1", TestDoc)
      await drain()

      expect(exchangeB.deferred.has("deferred-1")).toBe(true)
      expect(exchangeB.deferred.size).toBe(1)
    })

    it("after quiescence, documents and #docCache contain the same doc IDs", () => {
      const exchange = createExchange({
        id: "alice",
      })

      exchange.get("doc-1", TestDoc)
      exchange.get("doc-2", TestDoc)
      exchange.replicate(
        "rep-1",
        plainReplicaFactory,
        SYNC_AUTHORITATIVE,
        "00test",
      )

      // Both exchange.has() and documents.has() should agree
      for (const docId of ["doc-1", "doc-2", "rep-1"]) {
        expect(exchange.has(docId)).toBe(true)
        expect(exchange.documents.has(docId)).toBe(true)
      }

      // The document IDs should be the same set
      const docCacheIds = new Set<string>()
      if (exchange.has("doc-1")) docCacheIds.add("doc-1")
      if (exchange.has("doc-2")) docCacheIds.add("doc-2")
      if (exchange.has("rep-1")) docCacheIds.add("rep-1")

      const feedIds = new Set(exchange.documents.keys())
      expect(feedIds).toEqual(docCacheIds)
    })
  })

  // -------------------------------------------------------------------------
  // Reset/shutdown
  // -------------------------------------------------------------------------

  describe("reset/shutdown", () => {
    it("reset() emits synthetic doc-removed events for all tracked docs", () => {
      const exchange = createExchange({
        id: "alice",
      })

      exchange.get("doc-1", TestDoc)
      exchange.get("doc-2", TestDoc)

      const changes: DocChange[] = []
      exchange.documents.subscribe(cs => {
        changes.push(...cs.changes)
      })

      exchange.reset()

      const removedEvents = changes.filter(c => c.type === "doc-removed")
      const removedDocIds = new Set(removedEvents.map(c => c.docId))
      expect(removedDocIds.has("doc-1")).toBe(true)
      expect(removedDocIds.has("doc-2")).toBe(true)
    })

    it("after reset(), documents.size is 0", () => {
      const exchange = createExchange({
        id: "alice",
      })

      exchange.get("doc-1", TestDoc)
      exchange.get("doc-2", TestDoc)
      expect(exchange.documents.size).toBe(2)

      exchange.reset()

      expect(exchange.documents.size).toBe(0)
    })

    it("shutdown() emits synthetic doc-removed events for all tracked docs", async () => {
      const exchange = createExchange({
        id: "alice",
      })

      exchange.get("doc-1", TestDoc)

      const changes: DocChange[] = []
      exchange.documents.subscribe(cs => {
        changes.push(...cs.changes)
      })

      await exchange.shutdown()

      const removedEvents = changes.filter(c => c.type === "doc-removed")
      expect(removedEvents.length).toBe(1)
      expect(removedEvents[0].docId).toBe("doc-1")
      expect(exchange.documents.size).toBe(0)
    })

    it("reset() emits synthetic doc-removed for deferred docs too", async () => {
      const bridge = new Bridge()

      const exchangeA = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })

      const exchangeB = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
        resolve: () => Defer(),
      })

      exchangeA.get("deferred-doc", TestDoc)
      await drain()

      expect(exchangeB.documents.has("deferred-doc")).toBe(true)
      expect(exchangeB.documents.get("deferred-doc")).toEqual({
        mode: "deferred",
        suspended: false,
      })

      const changes: DocChange[] = []
      exchangeB.documents.subscribe(cs => {
        changes.push(...cs.changes)
      })

      exchangeB.reset()

      const removedEvents = changes.filter(c => c.type === "doc-removed")
      expect(removedEvents.some(c => c.docId === "deferred-doc")).toBe(true)
      expect(exchangeB.documents.size).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Integration: two-peer sync
  // -------------------------------------------------------------------------

  describe("two-peer sync", () => {
    it("peer B auto-resolves and receives doc-created when peer A creates a doc", async () => {
      const bridge = new Bridge()

      const exchangeA = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })

      const exchangeB = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
        schemas: [TestDoc],
      })

      const changes: DocChange[] = []
      exchangeB.documents.subscribe(cs => {
        changes.push(...cs.changes)
      })

      exchangeA.get("remote-doc", TestDoc)

      await drain()

      const created = changes.filter(c => c.type === "doc-created")
      expect(created.length).toBeGreaterThanOrEqual(1)
      expect(created.some(c => c.docId === "remote-doc")).toBe(true)
      expect(exchangeB.documents.has("remote-doc")).toBe(true)
      expect(exchangeB.documents.get("remote-doc")?.mode).toBe("interpret")
    })

    it("peer B receives doc-created for collaborative (loro) docs", async () => {
      const bridge = new Bridge()

      const exchangeA = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })

      const exchangeB = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
        schemas: [CollabDoc],
      })

      const changes: DocChange[] = []
      exchangeB.documents.subscribe(cs => {
        changes.push(...cs.changes)
      })

      exchangeA.get("collab-doc", CollabDoc)

      await drain()

      const created = changes.filter(
        c => c.type === "doc-created" && c.docId === "collab-doc",
      )
      expect(created.length).toBe(1)
      expect(exchangeB.documents.get("collab-doc")).toEqual({
        mode: "interpret",
        suspended: false,
      })
    })

    it("local destroy emits doc-removed on the destroying peer's feed", async () => {
      const bridge = new Bridge()

      const exchangeA = createExchange({
        id: "alice",
        transports: [createBridgeTransport({ transportId: "alice", bridge })],
      })

      const exchangeB = createExchange({
        id: "bob",
        transports: [createBridgeTransport({ transportId: "bob", bridge })],
        schemas: [CollabDoc],
      })

      exchangeA.get("destroy-doc", TestDoc)
      await drain()

      expect(exchangeB.documents.has("destroy-doc")).toBe(true)

      // Subscribe to Alice's feed — she dismisses locally
      const aliceChanges: DocChange[] = []
      exchangeA.documents.subscribe(cs => {
        aliceChanges.push(...cs.changes)
      })

      exchangeA.destroy("destroy-doc")

      const removed = aliceChanges.filter(
        c => c.type === "doc-removed" && c.docId === "destroy-doc",
      )
      expect(removed.length).toBe(1)
      expect(exchangeA.documents.has("destroy-doc")).toBe(false)
    })

    it("exchange.documents() reflects correct state during subscriber callback", () => {
      const exchange = createExchange({
        id: "alice",
      })

      let docsDuringCallback: ReadonlyMap<string, DocInfo> | undefined
      exchange.documents.subscribe(() => {
        docsDuringCallback = exchange.documents()
      })

      exchange.get("doc-1", TestDoc)

      expect(docsDuringCallback).toBeDefined()
      expect(docsDuringCallback?.has("doc-1")).toBe(true)
      expect(docsDuringCallback?.get("doc-1")).toEqual({
        mode: "interpret",
        suspended: false,
      })
    })
  })

  // -------------------------------------------------------------------------
  // Idempotency
  // -------------------------------------------------------------------------

  describe("idempotency", () => {
    it("calling get() twice for the same doc does not emit duplicate doc-created", () => {
      const exchange = createExchange({
        id: "alice",
      })

      const changes: DocChange[] = []
      exchange.documents.subscribe(cs => {
        changes.push(...cs.changes)
      })

      exchange.get("doc-1", TestDoc)
      exchange.get("doc-1", TestDoc) // same doc, same bound — returns cached ref

      const created = changes.filter(c => c.type === "doc-created")
      expect(created.length).toBe(1)
    })
  })
})
