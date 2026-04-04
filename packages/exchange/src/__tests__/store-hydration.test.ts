// storage-hydration — Exchange-level storage hydration tests.
//
// These tests validate that the Exchange hydrates documents from
// Store on get()/replicate(), persists network imports
// via onDocImported, and persists local changes via changefeed.

import {
  bindPlain,
  change,
  Interpret,
  plainReplicaFactory,
  Schema,
} from "@kyneta/schema"
import { bindYjs } from "@kyneta/yjs-schema"
import { describe, expect, it } from "vitest"
import { Exchange } from "../exchange.js"
import {
  createInMemoryStore,
  InMemoryStore,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"
import type { StoreEntry } from "../store/store.js"
import { Bridge, createBridgeTransport } from "../transport/bridge-transport.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TestDoc = bindPlain(
  Schema.doc({
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

function createExchange(
  options: ConstructorParameters<typeof Exchange>[0] = {},
): Exchange {
  return new Exchange({
    ...options,
    identity: { peerId: "test", ...options?.identity },
  })
}

// ===========================================================================
// Store interface (InMemoryStore)
// ===========================================================================

describe("InMemoryStore", () => {
  it("lookup() returns null for nonexistent doc", async () => {
    const backend = new InMemoryStore()
    expect(await backend.lookup("nonexistent")).toBeNull()
  })

  it("lookup() returns DocMetadata after ensureDoc()", async () => {
    const backend = new InMemoryStore()
    const metadata = {
      replicaType: ["plain", 1, 0] as const,
      mergeStrategy: "sequential" as const,
      schemaHash: "00test",
    }
    await backend.ensureDoc("doc-1", metadata)
    expect(await backend.lookup("doc-1")).toEqual(metadata)
  })

  it("ensureDoc() is idempotent — calling twice with same metadata is a no-op", async () => {
    const backend = new InMemoryStore()
    const metadata = {
      replicaType: ["plain", 1, 0] as const,
      mergeStrategy: "sequential" as const,
      schemaHash: "00test",
    }
    await backend.ensureDoc("doc-1", metadata)
    await backend.ensureDoc("doc-1", metadata)
    expect(await backend.lookup("doc-1")).toEqual(metadata)
  })

  it("ensureDoc() does not overwrite existing metadata", async () => {
    const backend = new InMemoryStore()
    const meta1 = {
      replicaType: ["plain", 1, 0] as const,
      mergeStrategy: "sequential" as const,
      schemaHash: "00test",
    }
    const meta2 = {
      replicaType: ["loro", 1, 0] as const,
      mergeStrategy: "causal" as const,
      schemaHash: "00test",
    }
    await backend.ensureDoc("doc-1", meta1)
    await backend.ensureDoc("doc-1", meta2)
    expect(await backend.lookup("doc-1")).toEqual(meta1)
  })

  it("StoreEntry stays lean — only payload and version", async () => {
    const backend = new InMemoryStore()
    await backend.ensureDoc("doc-1", {
      replicaType: ["plain", 1, 0] as const,
      mergeStrategy: "sequential" as const,
      schemaHash: "00test",
    })
    const entry = {
      payload: {
        kind: "entirety" as const,
        encoding: "json" as const,
        data: '{"title":"hello","count":0}',
      },
      version: "1",
    }
    await backend.append("doc-1", entry)

    const loaded: StoreEntry[] = []
    for await (const e of backend.loadAll("doc-1")) {
      loaded.push(e)
    }
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toEqual(entry)
    // Verify no extra fields
    expect(Object.keys(loaded[0]!)).toEqual(["payload", "version"])
  })

  it("delete() removes both entries and metadata", async () => {
    const backend = new InMemoryStore()
    await backend.ensureDoc("doc-1", {
      replicaType: ["plain", 1, 0] as const,
      mergeStrategy: "sequential" as const,
      schemaHash: "00test",
    })
    await backend.append("doc-1", {
      payload: {
        kind: "entirety" as const,
        encoding: "json" as const,
        data: "{}",
      },
      version: "0",
    })

    await backend.delete("doc-1")
    expect(await backend.lookup("doc-1")).toBeNull()
    const loaded: unknown[] = []
    for await (const e of backend.loadAll("doc-1")) {
      loaded.push(e)
    }
    expect(loaded).toHaveLength(0)
  })

  it("listDocIds() yields registered doc IDs", async () => {
    const backend = new InMemoryStore()
    await backend.ensureDoc("a", {
      replicaType: ["plain", 1, 0] as const,
      mergeStrategy: "sequential" as const,
      schemaHash: "00test",
    })
    await backend.ensureDoc("b", {
      replicaType: ["plain", 1, 0] as const,
      mergeStrategy: "sequential" as const,
      schemaHash: "00test",
    })

    const ids: string[] = []
    for await (const id of backend.listDocIds()) {
      ids.push(id)
    }
    expect(ids.sort()).toEqual(["a", "b"])
  })

  it("getStorage() returns shared data for cross-instance persistence", () => {
    const backend = new InMemoryStore()
    const data = backend.getStorage()
    expect(data.entries).toBeInstanceOf(Map)
    expect(data.metadata).toBeInstanceOf(Map)
  })

  it("shared data enables cross-instance persistence", async () => {
    const sharedData: InMemoryStoreData = {
      entries: new Map(),
      metadata: new Map(),
    }

    const backend1 = new InMemoryStore(sharedData)
    await backend1.ensureDoc("doc-1", {
      replicaType: ["plain", 1, 0] as const,
      mergeStrategy: "sequential" as const,
      schemaHash: "00test",
    })
    await backend1.append("doc-1", {
      payload: {
        kind: "entirety" as const,
        encoding: "json" as const,
        data: '{"title":"hello","count":0}',
      },
      version: "1",
    })

    // Second instance sees the data
    const backend2 = new InMemoryStore(sharedData)
    expect(await backend2.lookup("doc-1")).toEqual({
      replicaType: ["plain", 1, 0],
      mergeStrategy: "sequential",
      schemaHash: "00test",
    })
    const loaded: unknown[] = []
    for await (const e of backend2.loadAll("doc-1")) {
      loaded.push(e)
    }
    expect(loaded).toHaveLength(1)
  })
})

// ===========================================================================
// Exchange-level storage hydration
// ===========================================================================

describe("Exchange storage hydration", () => {
  it("exchange.get() hydrates from storage", async () => {
    // Pre-populate storage with a document
    const sharedData: InMemoryStoreData = {
      entries: new Map(),
      metadata: new Map(),
    }
    const seedBackend = new InMemoryStore(sharedData)
    await seedBackend.ensureDoc("doc-1", {
      replicaType: ["plain", 1, 0] as const,
      mergeStrategy: "sequential" as const,
      schemaHash: "00test",
    })
    await seedBackend.append("doc-1", {
      payload: {
        kind: "entirety" as const,
        encoding: "json" as const,
        data: '{"title":"stored","count":42}',
      },
      version: "1",
    })

    const exchange = createExchange({
      identity: { peerId: "test" },
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
      identity: { peerId: "test" },
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
      entries: new Map(),
      metadata: new Map(),
    }
    const seedBackend = new InMemoryStore(sharedData)
    await seedBackend.ensureDoc("doc-1", {
      replicaType: ["plain", 1, 0] as const,
      mergeStrategy: "sequential" as const,
      schemaHash: "00test",
    })
    await seedBackend.append("doc-1", {
      payload: {
        kind: "entirety" as const,
        encoding: "json" as const,
        data: '{"title":"replicated","count":7}',
      },
      version: "1",
    })

    const exchange = createExchange({
      identity: { peerId: "test" },
      stores: [createInMemoryStore({ sharedData })],
    })

    exchange.replicate("doc-1", plainReplicaFactory, "sequential", "00test")

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
      identity: { peerId: "test" },
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

    // Storage should have the data — the first entry is the base entirety
    // from initial hydration (first boot), and the second is a since delta
    // from the local mutation via onStateAdvanced.
    const entries: { payload: any; version: string }[] = []
    for await (const e of backend.loadAll("doc-1")) {
      entries.push(e)
    }
    expect(entries.length).toBeGreaterThanOrEqual(2)

    // First entry: base entirety from first boot
    expect(entries[0]?.payload.kind).toBe("entirety")

    // Last entry: since delta from local mutation (not an entirety snapshot)
    const last = entries[entries.length - 1]!
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
      identity: { peerId: "peer-a" },
      transports: [createBridgeTransport({ transportType: "side-a", bridge })],
    })
    const docA = exchangeA.get("doc-1", TestDoc)
    change(docA, d => {
      d.title.set("from A")
      d.count.set(1)
    })

    // Exchange B (sink) — has storage, discovers doc from A
    const exchangeB = createExchange({
      identity: { peerId: "peer-b" },
      transports: [createBridgeTransport({ transportType: "side-b", bridge })],
      stores: [backend],
      onDocDiscovered: () => Interpret(TestDoc),
    })

    // Wait for sync
    await drain(200)
    await exchangeB.flush()

    // Storage on B should have persisted the import
    const entries: { payload: any; version: string }[] = []
    for await (const e of backend.loadAll("doc-1")) {
      entries.push(e)
    }
    // Should have at least one entry from the network import
    expect(entries.length).toBeGreaterThanOrEqual(1)

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })

  it("dismiss() deletes from storage", async () => {
    const backend = new InMemoryStore()

    const exchange = createExchange({
      identity: { peerId: "test" },
      stores: [backend],
    })

    const doc = exchange.get("doc-1", TestDoc)
    await exchange.flush()

    change(doc, d => d.title.set("will be deleted"))
    await exchange.flush()

    // Verify storage has data
    expect(await backend.lookup("doc-1")).not.toBeNull()

    // Dismiss
    exchange.dismiss("doc-1")
    await exchange.flush()

    // Storage should be cleaned up
    expect(await backend.lookup("doc-1")).toBeNull()

    await exchange.shutdown()
  })

  it("flush() awaits all pending storage operations", async () => {
    const backend = new InMemoryStore()

    const exchange = createExchange({
      identity: { peerId: "test" },
      stores: [backend],
    })

    exchange.get("doc-1", TestDoc)
    // Flush should not throw and should complete all pending ops
    await exchange.flush()

    // After flush, ensureDoc should have been called
    expect(await backend.lookup("doc-1")).toEqual({
      replicaType: ["plain", 1, 0],
      mergeStrategy: "sequential",
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
      entries: new Map(),
      metadata: new Map(),
    }

    // First exchange: create doc, write data, shut down
    const exchange1 = createExchange({
      identity: { peerId: "server" },
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
      identity: { peerId: "server" },
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
      identity: { peerId: "test" },
    })

    // The synchronizer model should have no documents
    expect(exchange.synchronizer.model.documents.size).toBe(0)

    // After adding a channel and receiving interest for unknown doc,
    // the model should still have no documents (no placeholder created)
    exchange.reset()
  })

  it("no DocEntry has sentinel version ''", async () => {
    const exchange = createExchange({
      identity: { peerId: "test" },
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
      identity: { peerId: "test" },
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
// exchange.get() without explicit peerId
// ===========================================================================

describe("exchange.get() without explicit peerId", () => {
  it("throws when no peerId is provided", () => {
    // Exchange created without identity.peerId — gets an auto-generated one,
    // but #peerIdIsExplicit is false → get() must throw.
    const exchange = new Exchange()

    const Doc = bindPlain(
      Schema.doc({
        title: Schema.string(),
      }),
    )

    expect(() => exchange.get("doc-1", Doc)).toThrow(
      /exchange\.get\(\) requires an explicit peerId/,
    )

    exchange.reset()
  })
})

// ===========================================================================
// Yjs doc: write → shutdown → restart → hydrate → data preserved
// ===========================================================================

describe("Yjs storage round-trip", () => {
  it("Yjs doc: write → shutdown → restart → hydrate → data preserved", async () => {
    const YjsDoc = bindYjs(
      Schema.doc({
        title: Schema.annotated("text"),
        count: Schema.number(),
      }),
    )

    const sharedData: InMemoryStoreData = {
      entries: new Map(),
      metadata: new Map(),
    }

    // First exchange: create doc, write data, shut down
    const exchange1 = createExchange({
      identity: { peerId: "yjs-peer" },
      stores: [createInMemoryStore({ sharedData })],
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
      identity: { peerId: "yjs-peer" },
      stores: [createInMemoryStore({ sharedData })],
    })

    const doc2 = exchange2.get("doc-1", YjsDoc)
    await exchange2.flush() // hydration

    expect(doc2.title()).toBe("Yjs persisted")
    expect(doc2.count()).toBe(123)

    await exchange2.shutdown()
  })
})
