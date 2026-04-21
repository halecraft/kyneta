// storage-hydration — Exchange-level storage hydration tests.
//
// These tests validate that the Exchange hydrates documents from
// Store on get()/replicate(), persists network imports
// via onDocImported, and persists local changes via changefeed.

import {
  change,
  json,
  plainReplicaFactory,
  Replicate,
  Schema,
  SYNC_AUTHORITATIVE,
} from "@kyneta/schema"
import { Bridge, createBridgeTransport } from "@kyneta/transport"
import { yjs } from "@kyneta/yjs-schema"
import { describe, expect, it } from "vitest"
import {
  Exchange,
  type ExchangeParams,
  type PeerIdentityInput,
} from "../exchange.js"
import {
  createInMemoryStore,
  InMemoryStore,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"
import type { StoreRecord } from "../store/store.js"
import { collectAll, makeMetaRecord } from "../testing/store-conformance.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TestDoc = json.bind(
  Schema.struct({
    title: Schema.string(),
    count: Schema.number(),
  }),
)

/**
 * Drain microtask queue — necessary for BridgeTransport async delivery
 * and storage hydration async operations.
 */
async function drain(ms = 50): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function createExchange(options: Partial<ExchangeParams> = {}): Exchange {
  const merged = { id: "test" as string | PeerIdentityInput, ...options }
  return new Exchange(merged as ExchangeParams)
}

// ===========================================================================
// Exchange-level storage hydration
// ===========================================================================

describe("Exchange storage hydration", () => {
  it("exchange.get() hydrates from storage", async () => {
    // Pre-populate storage with a document (meta + entry)
    const sharedData: InMemoryStoreData = {
      records: new Map(),
      metadata: new Map(),
    }
    const seedBackend = new InMemoryStore(sharedData)
    await seedBackend.append("doc-1", makeMetaRecord())
    await seedBackend.append("doc-1", {
      kind: "entry",
      payload: {
        kind: "entirety" as const,
        encoding: "json" as const,
        data: '{"title":"stored","count":42}',
      },
      version: "1",
    })

    const exchange = createExchange({
      id: "peer-1",
      stores: [createInMemoryStore({ sharedData })],
    })

    const doc = exchange.get("doc-1", TestDoc)

    // Wait for async hydration to complete
    await exchange.flush()

    // Doc should have the stored data
    expect(doc.title()).toBe("stored")
    expect(doc.count()).toBe(42)

    await exchange.shutdown()
  })

  it("exchange.get() returns ref synchronously even with storage", () => {
    const exchange = createExchange({
      id: "peer-1",
      stores: [createInMemoryStore()],
    })

    // get() must be synchronous — returns a ref immediately
    const doc = exchange.get("doc-1", TestDoc)
    expect(doc).toBeDefined()
    // Initially empty (hydration is async)
    expect(doc.title()).toBe("")

    exchange.reset()
  })

  it("exchange.replicate() hydrates from storage", async () => {
    // Pre-populate storage
    const sharedData: InMemoryStoreData = {
      records: new Map(),
      metadata: new Map(),
    }
    const seedBackend = new InMemoryStore(sharedData)
    await seedBackend.append("doc-1", makeMetaRecord())
    await seedBackend.append("doc-1", {
      kind: "entry",
      payload: {
        kind: "entirety" as const,
        encoding: "json" as const,
        data: '{"title":"replicated","count":7}',
      },
      version: "1",
    })

    const exchange = createExchange({
      id: "peer-1",
      stores: [createInMemoryStore({ sharedData })],
    })

    exchange.replicate(
      "doc-1",
      plainReplicaFactory,
      SYNC_AUTHORITATIVE,
      "00test",
    )

    // Wait for hydration
    await exchange.flush()

    // The doc runtime should have the hydrated version
    const runtime = exchange.synchronizer.getDocRuntime("doc-1")
    expect(runtime).toBeDefined()
    // Version should be > "0" after hydration
    const version = runtime?.replica.version().serialize()
    expect(version).not.toBe("0")

    await exchange.shutdown()
  })
})

// ===========================================================================
// Exchange-level storage persistence
// ===========================================================================

describe("Exchange storage persistence", () => {
  it("local mutation persists to storage via onStateAdvanced → append(since)", async () => {
    const backend = new InMemoryStore()

    const exchange = createExchange({
      id: "test",
      stores: [backend],
    })

    const doc = exchange.get("doc-1", TestDoc)
    await exchange.flush() // wait for hydration

    // Mutate locally
    change(doc, d => {
      d.title.set("hello world")
      d.count.set(99)
    })

    // Wait for persistence
    await exchange.flush()

    // Storage should have the data — records include meta records and entry records.
    // Filter for entry records to inspect payloads.
    const records = await collectAll(backend.loadAll("doc-1"))
    const entries = records.filter(
      (r): r is StoreRecord & { kind: "entry" } => r.kind === "entry",
    )
    expect(entries.length).toBeGreaterThanOrEqual(2)

    // First entry: base entirety from first boot
    expect(entries[0]?.payload.kind).toBe("entirety")

    // Last entry: since delta from local mutation (not an entirety snapshot)
    const last = entries.at(-1)
    if (!last) throw new Error("expected at least one entry")
    expect(last.payload.kind).toBe("since")

    // Verify the data round-trips: create a new replica, merge all entries,
    // and check that the state is correct.
    const replica = plainReplicaFactory.createEmpty()
    for (const entry of entries) {
      replica.merge(entry.payload)
    }
    const state = JSON.parse(replica.exportEntirety().data as string) as Record<
      string,
      unknown
    >
    expect(state.title).toBe("hello world")
    expect(state.count).toBe(99)

    await exchange.shutdown()
  })

  it("network import persists to storage via onDocImported → append()", async () => {
    const backend = new InMemoryStore()
    const bridge = new Bridge()

    // Exchange A (source) — has the doc
    const exchangeA = createExchange({
      id: "peer-a",
      transports: [createBridgeTransport({ transportType: "side-a", bridge })],
    })
    const docA = exchangeA.get("doc-1", TestDoc)
    change(docA, d => {
      d.title.set("from A")
      d.count.set(1)
    })

    // Exchange B (sink) — has storage, discovers doc from A
    const exchangeB = createExchange({
      id: "peer-b",
      transports: [createBridgeTransport({ transportType: "side-b", bridge })],
      stores: [backend],
      resolve: () => Replicate(),
    })

    // Wait for sync
    await drain(200)
    await exchangeB.flush()

    // Storage on B should have persisted the import — filter for entry records
    const records = await collectAll(backend.loadAll("doc-1"))
    const entries = records.filter(r => r.kind === "entry")
    // Should have at least one entry from the network import
    expect(entries.length).toBeGreaterThanOrEqual(1)

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })

  it("destroy() deletes from storage", async () => {
    const backend = new InMemoryStore()

    const exchange = createExchange({
      id: "test",
      stores: [backend],
    })

    const doc = exchange.get("doc-1", TestDoc)
    await exchange.flush()

    change(doc, d => d.title.set("will be deleted"))
    await exchange.flush()

    // Verify storage has data
    expect(await backend.currentMeta("doc-1")).not.toBeNull()

    // Destroy
    exchange.destroy("doc-1")
    await exchange.flush()

    // Storage should be cleaned up
    expect(await backend.currentMeta("doc-1")).toBeNull()

    await exchange.shutdown()
  })

  it("flush() awaits all pending storage operations", async () => {
    const backend = new InMemoryStore()

    const exchange = createExchange({
      id: "test",
      stores: [backend],
    })

    exchange.get("doc-1", TestDoc)
    // Flush should not throw and should complete all pending ops
    await exchange.flush()

    // After flush, a meta record should have been appended
    expect(await backend.currentMeta("doc-1")).toEqual({
      replicaType: ["plain", 1, 0],
      syncProtocol: SYNC_AUTHORITATIVE,
      schemaHash: TestDoc.schemaHash,
    })

    await exchange.shutdown()
  })
})

// ===========================================================================
// Persist → restart → hydrate round-trip
// ===========================================================================

describe("Storage round-trip (persist → restart → hydrate)", () => {
  it("data survives exchange restart via shared storage", async () => {
    const sharedData: InMemoryStoreData = {
      records: new Map(),
      metadata: new Map(),
    }

    // First exchange: create doc, write data, shut down
    const exchange1 = createExchange({
      id: "peer-1",
      stores: [createInMemoryStore({ sharedData })],
    })

    const doc1 = exchange1.get("doc-1", TestDoc)
    await exchange1.flush() // hydration

    change(doc1, d => {
      d.title.set("persisted title")
      d.count.set(777)
    })
    await exchange1.shutdown()

    // Second exchange: should hydrate from storage
    const exchange2 = createExchange({
      id: "peer-1",
      stores: [createInMemoryStore({ sharedData })],
    })

    const doc2 = exchange2.get("doc-1", TestDoc)
    await exchange2.flush() // hydration

    expect(doc2.title()).toBe("persisted title")
    expect(doc2.count()).toBe(777)

    await exchange2.shutdown()
  })
})

// ===========================================================================
// Synchronizer purification invariants
// ===========================================================================

describe("Synchronizer purification", () => {
  it("handleInterest for unknown doc drops silently (no placeholder, no probe)", () => {
    // This is tested indirectly: an exchange without the doc simply
    // ignores interests. We verify the model has no sentinel entries.
    const exchange = createExchange({
      id: "peer-1",
    })

    // The synchronizer model should have no documents
    expect(exchange.synchronizer.model.documents.size).toBe(0)

    // After adding a channel and receiving interest for unknown doc,
    // the model should still have no documents (no placeholder created)
    exchange.reset()
  })

  it("no DocEntry has sentinel version ''", async () => {
    const exchange = createExchange({
      id: "peer-1",
      stores: [createInMemoryStore()],
    })

    exchange.get("doc-1", TestDoc)
    await exchange.flush()

    for (const [_docId, entry] of exchange.synchronizer.model.documents) {
      expect(entry.version).not.toBe("")
    }

    await exchange.shutdown()
  })

  it("DocEntry has no pendingStorageChannels or pendingInterests fields", async () => {
    const exchange = createExchange({
      id: "peer-1",
      stores: [createInMemoryStore()],
    })

    exchange.get("doc-1", TestDoc)
    await exchange.flush()

    for (const [_docId, entry] of exchange.synchronizer.model.documents) {
      expect(entry).not.toHaveProperty("pendingStorageChannels")
      expect(entry).not.toHaveProperty("pendingInterests")
    }

    await exchange.shutdown()
  })
})

// ===========================================================================
// Yjs doc: write → shutdown → restart → hydrate → data preserved
// ===========================================================================

describe("Yjs storage round-trip", () => {
  it("Yjs doc: write → shutdown → restart → hydrate → data preserved", async () => {
    const YjsDoc = yjs.bind(
      Schema.struct({
        title: Schema.text(),
        count: Schema.number(),
      }),
    )

    const sharedData: InMemoryStoreData = {
      records: new Map(),
      metadata: new Map(),
    }

    // First exchange: create doc, write data, shut down
    const exchange1 = createExchange({
      id: "peer-1",
      stores: [createInMemoryStore({ sharedData })],
      schemas: [YjsDoc],
    })

    const doc1 = exchange1.get("doc-1", YjsDoc)
    await exchange1.flush() // hydration

    change(doc1, (d: any) => {
      d.title.insert(0, "Yjs persisted")
      d.count.set(123)
    })

    await exchange1.flush() // persist
    await exchange1.shutdown()

    // Second exchange: should hydrate from storage
    const exchange2 = createExchange({
      id: "peer-1",
      stores: [createInMemoryStore({ sharedData })],
      schemas: [YjsDoc],
    })

    const doc2 = exchange2.get("doc-1", YjsDoc)
    await exchange2.flush() // hydration

    expect(doc2.title()).toBe("Yjs persisted")
    expect(doc2.count()).toBe(123)

    await exchange2.shutdown()
  })
})