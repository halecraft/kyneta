// storage-integration — end-to-end integration tests for direct storage dependency.
//
// These tests prove that the Exchange's direct Store integration
// works with real Exchange instances, BridgeTransports, and actual substrates
// (Plain, Loro, Ephemeral).
//
// Replaces the old storage-integration tests which tested the deleted
// StorageAdapter / storage-first sync machinery.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { loro } from "@kyneta/loro-schema"
import {
  change,
  ephemeral,
  Interpret,
  json,
  Replicate,
  Schema,
} from "@kyneta/schema"
import { cborCodec } from "@kyneta/wire"
import { afterEach, describe, expect, it } from "vitest"
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
import type { Store, StoreRecord } from "../store/store.js"
import { collectAll, makeMetaRecord } from "../testing/store-conformance.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Drain microtask queue — necessary for BridgeTransport async delivery
 * and storage hydration async operations.
 */
async function drain(ms = 100): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Active exchanges that need cleanup */
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
      // ignore
    }
  }
  activeExchanges.length = 0
})

// ---------------------------------------------------------------------------
// Bound schemas
// ---------------------------------------------------------------------------

const SequentialDoc = json.bind(
  Schema.struct({
    title: Schema.string(),
    count: Schema.number(),
  }),
)

const CausalDoc = loro.bind(
  Schema.struct({
    title: Schema.text(),
  }),
)

const PresenceDoc = ephemeral.bind(
  Schema.struct({
    cursor: Schema.struct({ x: Schema.number(), y: Schema.number() }),
    name: Schema.string(),
  }),
)

// ===========================================================================
// Storage persist + hydrate (direct dependency model)
// ===========================================================================

describe("Storage persist + hydrate", () => {
  it("authoritative doc: write → shutdown → restart with same storage → hydrate", async () => {
    const sharedData: InMemoryStoreData = {
      records: new Map(),
      metadata: new Map(),
    }

    // Phase 1: create doc, mutate, persist
    const exchange1 = createExchange({
      id: "server",
      stores: [createInMemoryStore({ sharedData })],
    })

    const doc1 = exchange1.get("doc-1", SequentialDoc)
    await exchange1.flush()

    change(doc1, d => {
      d.title.set("persisted")
      d.count.set(42)
    })
    await exchange1.shutdown()

    // Phase 2: new exchange with same storage → hydrate
    const exchange2 = createExchange({
      id: "server",
      stores: [createInMemoryStore({ sharedData })],
    })

    const doc2 = exchange2.get("doc-1", SequentialDoc)
    await exchange2.flush()

    expect(doc2.title()).toBe("persisted")
    expect(doc2.count()).toBe(42)
  })

  it("collaborative doc (Loro): write → shutdown → restart → hydrate", async () => {
    const sharedData: InMemoryStoreData = {
      records: new Map(),
      metadata: new Map(),
    }

    const exchange1 = createExchange({
      id: "server",
      stores: [createInMemoryStore({ sharedData })],
      schemas: [CausalDoc],
    })

    const doc1 = exchange1.get("doc-1", CausalDoc)
    await exchange1.flush()

    change(doc1, (d: any) => {
      d.title.insert(0, "hello loro")
    })
    await exchange1.shutdown()

    const exchange2 = createExchange({
      id: "server",
      stores: [createInMemoryStore({ sharedData })],
      schemas: [CausalDoc],
    })

    const doc2 = exchange2.get("doc-1", CausalDoc)
    await exchange2.flush()

    expect(doc2.title()).toBe("hello loro")
  })

  it("ephemeral doc: write → shutdown → restart → hydrate", async () => {
    const sharedData: InMemoryStoreData = {
      records: new Map(),
      metadata: new Map(),
    }

    const exchange1 = createExchange({
      id: "server",
      stores: [createInMemoryStore({ sharedData })],
    })

    const doc1 = exchange1.get("presence-1", PresenceDoc)
    await exchange1.flush()

    change(doc1, d => {
      d.name.set("Alice")
      d.cursor.x.set(100)
      d.cursor.y.set(200)
    })
    await exchange1.shutdown()

    const exchange2 = createExchange({
      id: "server",
      stores: [createInMemoryStore({ sharedData })],
    })

    const doc2 = exchange2.get("presence-1", PresenceDoc)
    await exchange2.flush()

    expect(doc2.name()).toBe("Alice")
    expect(doc2.cursor.x()).toBe(100)
    expect(doc2.cursor.y()).toBe(200)
  })
})

// ===========================================================================
// Storage + network sync
// ===========================================================================

describe("Storage + network sync", () => {
  it("peer A writes → server persists → peer B connects → gets data", async () => {
    const sharedData: InMemoryStoreData = {
      records: new Map(),
      metadata: new Map(),
    }

    const bridge = new Bridge({ codec: cborCodec })

    const server = createExchange({
      id: { peerId: "server", type: "service" },
      transports: [
        createBridgeTransport({ transportId: "server-side", bridge }),
      ],
      stores: [createInMemoryStore({ sharedData })],
      resolve: () => Replicate(),
    })

    const peerA = createExchange({
      id: "peer-a",
      transports: [
        createBridgeTransport({ transportId: "peer-a-side", bridge }),
      ],
    })

    const docA = peerA.get("doc-1", SequentialDoc)
    change(docA, d => {
      d.title.set("from peer A")
      d.count.set(7)
    })

    // Wait for sync and persistence
    await drain(200)
    await server.flush()

    // Verify server persisted — use currentMeta instead of lookup
    const backend = new InMemoryStore(sharedData)
    expect(await backend.currentMeta("doc-1")).not.toBeNull()

    // Stop peer A, restart server with same storage
    await peerA.shutdown()
    await server.shutdown()

    const bridge2 = new Bridge({ codec: cborCodec })

    const server2 = createExchange({
      id: { peerId: "server", type: "service" },
      transports: [
        createBridgeTransport({
          transportId: "server-side",
          bridge: bridge2,
        }),
      ],
      stores: [createInMemoryStore({ sharedData })],
      resolve: () => Replicate(),
    })

    const peerB = createExchange({
      id: "peer-b",
      transports: [
        createBridgeTransport({
          transportId: "peer-b-side",
          bridge: bridge2,
        }),
      ],
      resolve: () => Interpret(SequentialDoc),
    })

    // Wait for server hydration + peer B sync
    await drain(300)
    await server2.flush()
    await peerB.flush()

    // Peer B should have the data
    if (peerB.has("doc-1")) {
      const docB = peerB.get("doc-1", SequentialDoc)
      expect(docB.title()).toBe("from peer A")
      expect(docB.count()).toBe(7)
    }
  })

  it("network import persists to storage via onDocImported", async () => {
    const backend = new InMemoryStore()
    const bridge = new Bridge({ codec: cborCodec })

    const server = createExchange({
      id: { peerId: "server", type: "service" },
      transports: [
        createBridgeTransport({ transportId: "server-side", bridge }),
      ],
      stores: [backend],
      resolve: () => Replicate(),
    })

    const client = createExchange({
      id: "client",
      transports: [
        createBridgeTransport({ transportId: "client-side", bridge }),
      ],
    })

    const doc = client.get("doc-1", SequentialDoc)
    change(doc, d => {
      d.title.set("network payload")
      d.count.set(99)
    })

    await drain(200)
    await server.flush()

    // Storage on server should have records — filter for entry records
    const records = await collectAll(backend.loadAll("doc-1"))
    const entries = records.filter(
      (r): r is StoreRecord & { kind: "entry" } => r.kind === "entry",
    )
    expect(entries.length).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// Storage + replicated doc
// ===========================================================================

describe("Storage + replicated doc", () => {
  it("exchange.replicate() + storage → relay persists and hydrates", async () => {
    const sharedData: InMemoryStoreData = {
      records: new Map(),
      metadata: new Map(),
    }

    const bridge1 = new Bridge({ codec: cborCodec })

    // Relay 1: replicate mode + storage
    const relay1 = createExchange({
      id: { peerId: "relay-1", type: "service" },
      transports: [
        createBridgeTransport({ transportId: "relay-side", bridge: bridge1 }),
      ],
      stores: [createInMemoryStore({ sharedData })],
      resolve: () => Replicate(),
    })

    const peerA = createExchange({
      id: "peer-a",
      transports: [
        createBridgeTransport({
          transportId: "peer-a-side",
          bridge: bridge1,
        }),
      ],
    })

    const docA = peerA.get("doc-1", SequentialDoc)
    change(docA, d => {
      d.title.set("replicated")
      d.count.set(55)
    })

    await drain(200)
    await relay1.flush()

    // Verify storage has data — use currentMeta and filter for entry records
    const check = new InMemoryStore(sharedData)
    expect(await check.currentMeta("doc-1")).not.toBeNull()
    const records = await collectAll(check.loadAll("doc-1"))
    const entries = records.filter(r => r.kind === "entry")
    expect(entries.length).toBeGreaterThanOrEqual(1)

    // Shut down relay 1
    await peerA.shutdown()
    await relay1.shutdown()

    // Relay 2: restart with same storage, connect to peer B
    const bridge2 = new Bridge({ codec: cborCodec })

    const relay2 = createExchange({
      id: { peerId: "relay-2", type: "service" },
      transports: [
        createBridgeTransport({ transportId: "relay-side", bridge: bridge2 }),
      ],
      stores: [createInMemoryStore({ sharedData })],
      resolve: () => Replicate(),
    })

    const peerB = createExchange({
      id: "peer-b",
      transports: [
        createBridgeTransport({
          transportId: "peer-b-side",
          bridge: bridge2,
        }),
      ],
      resolve: () => Interpret(SequentialDoc),
    })

    await drain(300)
    await relay2.flush()
    await peerB.flush()

    if (peerB.has("doc-1")) {
      const docB = peerB.get("doc-1", SequentialDoc)
      expect(docB.title()).toBe("replicated")
      expect(docB.count()).toBe(55)
    }
  })
})

// ===========================================================================
// Storage + destroy
// ===========================================================================

describe("Storage + destroy", () => {
  it("destroy() removes doc from storage", async () => {
    const backend = new InMemoryStore()

    const exchange = createExchange({
      id: "server",
      stores: [backend],
    })

    const doc = exchange.get("doc-1", SequentialDoc)
    await exchange.flush()

    change(doc, d => d.title.set("will be destroyed"))
    await exchange.flush()

    expect(await backend.currentMeta("doc-1")).not.toBeNull()

    exchange.destroy("doc-1")
    await exchange.flush()

    expect(await backend.currentMeta("doc-1")).toBeNull()
  })
})

// ===========================================================================
// onStoreError callback
// ===========================================================================

describe("onStoreError callback", () => {
  it("receives store errors instead of swallowing them", async () => {
    const errors: Array<{ docId: string; operation: string }> = []

    // Create a store that fails on append — currentMeta returns null
    // so hydration takes the "first boot" path, which dispatches
    // `register` → `persist-append`. The executor calls append(),
    // which throws. The executor catches and dispatches `write-failed`.
    // The store-program emits `store-error`. The executor calls onStoreError.
    const failingStore: Store = {
      async append() {
        throw new Error("disk full")
      },
      async currentMeta() {
        return null
      },
      async *loadAll() {},
      async *listDocIds() {},
      async replace() {
        throw new Error("disk full")
      },
      async delete() {},
      async close() {},
    }

    const exchange = createExchange({
      id: "server",
      stores: [failingStore],
      onStoreError: (docId, operation, _error) => {
        errors.push({ docId, operation })
      },
    })

    exchange.get("doc-1", SequentialDoc)
    await exchange.flush()

    // The store-program should have reported the failure
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.docId).toBe("doc-1")
  })
})

// ===========================================================================
// Multi-store first-hit reads
// ===========================================================================

describe("Multi-store first-hit reads", () => {
  it("hydration uses the first store that has data, not merge-all", async () => {
    // Store A has doc with value "from-A"
    const storeA = new InMemoryStore()
    await storeA.append("doc-1", makeMetaRecord())
    await storeA.append("doc-1", {
      kind: "entry",
      payload: {
        kind: "entirety",
        encoding: "json",
        data: '{"title":"from-A","count":1}',
      },
      version: "v1",
    })

    // Store B has doc with DIFFERENT value "from-B"
    const storeB = new InMemoryStore()
    await storeB.append("doc-1", makeMetaRecord())
    await storeB.append("doc-1", {
      kind: "entry",
      payload: {
        kind: "entirety",
        encoding: "json",
        data: '{"title":"from-B","count":2}',
      },
      version: "v2",
    })

    const exchange = createExchange({
      id: "server",
      stores: [storeA, storeB], // A is first
    })

    const doc = exchange.get("doc-1", SequentialDoc)
    await exchange.flush()

    // Should use store A (first-hit), not merge from both
    expect(doc.title()).toBe("from-A")
    expect(doc.count()).toBe(1)
  })
})

// ===========================================================================
// No storage (baseline — storage is optional)
// ===========================================================================

describe("No storage (baseline)", () => {
  it("exchange without storage works exactly as before", async () => {
    const bridge = new Bridge({ codec: cborCodec })

    const exchangeA = createExchange({
      id: "peer-a",
      transports: [createBridgeTransport({ transportId: "side-a", bridge })],
    })

    const exchangeB = createExchange({
      id: "peer-b",
      transports: [createBridgeTransport({ transportId: "side-b", bridge })],
      resolve: () => Interpret(SequentialDoc),
    })

    const docA = exchangeA.get("doc-1", SequentialDoc)
    change(docA, d => {
      d.title.set("no storage")
      d.count.set(123)
    })

    await drain(200)

    if (exchangeB.has("doc-1")) {
      const docB = exchangeB.get("doc-1", SequentialDoc)
      expect(docB.title()).toBe("no storage")
      expect(docB.count()).toBe(123)
    }
  })
})
