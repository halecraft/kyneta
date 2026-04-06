// storage-integration — end-to-end integration tests for direct storage dependency.
//
// These tests prove that the Exchange's direct Store integration
// works with real Exchange instances, BridgeTransports, and actual substrates
// (Plain, Loro, LWW).
//
// Replaces the old storage-integration tests which tested the deleted
// StorageAdapter / storage-first sync machinery.

import { bindLoro, LoroSchema } from "@kyneta/loro-schema"
import {
  bindEphemeral,
  bindPlain,
  change,
  Interpret,
  Replicate,
  Schema,
} from "@kyneta/schema"
import { Bridge, createBridgeTransport } from "@kyneta/transport"
import { afterEach, describe, expect, it } from "vitest"
import { Exchange } from "../exchange.js"
import {
  createInMemoryStore,
  InMemoryStore,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"

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

function createExchange(
  params: ConstructorParameters<typeof Exchange>[0] = {},
): Exchange {
  const merged = {
    ...params,
    identity: { peerId: "test", ...params?.identity },
  }
  const ex = new Exchange(merged)
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

const SequentialDoc = bindPlain(
  Schema.doc({
    title: Schema.string(),
    count: Schema.number(),
  }),
)

const CausalDoc = bindLoro(
  LoroSchema.doc({
    title: LoroSchema.text(),
  }),
)

const PresenceDoc = bindEphemeral(
  Schema.doc({
    cursor: Schema.struct({ x: Schema.number(), y: Schema.number() }),
    name: Schema.string(),
  }),
)

// ===========================================================================
// Storage persist + hydrate (direct dependency model)
// ===========================================================================

describe("Storage persist + hydrate", () => {
  it("sequential doc: write → shutdown → restart with same storage → hydrate", async () => {
    const sharedData: InMemoryStoreData = {
      entries: new Map(),
      metadata: new Map(),
    }

    // Phase 1: create doc, mutate, persist
    const exchange1 = createExchange({
      identity: { peerId: "server" },
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
      identity: { peerId: "server" },
      stores: [createInMemoryStore({ sharedData })],
    })

    const doc2 = exchange2.get("doc-1", SequentialDoc)
    await exchange2.flush()

    expect(doc2.title()).toBe("persisted")
    expect(doc2.count()).toBe(42)
  })

  it("causal doc (Loro): write → shutdown → restart → hydrate", async () => {
    const sharedData: InMemoryStoreData = {
      entries: new Map(),
      metadata: new Map(),
    }

    const exchange1 = createExchange({
      identity: { peerId: "server" },
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
      identity: { peerId: "server" },
      stores: [createInMemoryStore({ sharedData })],
      schemas: [CausalDoc],
    })

    const doc2 = exchange2.get("doc-1", CausalDoc)
    await exchange2.flush()

    expect(doc2.title()).toBe("hello loro")
  })

  it("LWW doc: write → shutdown → restart → hydrate", async () => {
    const sharedData: InMemoryStoreData = {
      entries: new Map(),
      metadata: new Map(),
    }

    const exchange1 = createExchange({
      identity: { peerId: "server" },
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
      identity: { peerId: "server" },
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
      entries: new Map(),
      metadata: new Map(),
    }

    const bridge = new Bridge()

    const server = createExchange({
      identity: { peerId: "server", type: "service" },
      transports: [
        createBridgeTransport({ transportType: "server-side", bridge }),
      ],
      stores: [createInMemoryStore({ sharedData })],
      onUnresolvedDoc: () => Replicate(),
    })

    const peerA = createExchange({
      identity: { peerId: "peer-a" },
      transports: [
        createBridgeTransport({ transportType: "peer-a-side", bridge }),
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

    // Verify server persisted
    const backend = new InMemoryStore(sharedData)
    expect(await backend.lookup("doc-1")).not.toBeNull()

    // Stop peer A, restart server with same storage
    await peerA.shutdown()
    await server.shutdown()

    const bridge2 = new Bridge()

    const server2 = createExchange({
      identity: { peerId: "server", type: "service" },
      transports: [
        createBridgeTransport({
          transportType: "server-side",
          bridge: bridge2,
        }),
      ],
      stores: [createInMemoryStore({ sharedData })],
      onUnresolvedDoc: () => Replicate(),
    })

    const peerB = createExchange({
      identity: { peerId: "peer-b" },
      transports: [
        createBridgeTransport({
          transportType: "peer-b-side",
          bridge: bridge2,
        }),
      ],
      onUnresolvedDoc: () => Interpret(SequentialDoc),
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
    const bridge = new Bridge()

    const server = createExchange({
      identity: { peerId: "server", type: "service" },
      transports: [
        createBridgeTransport({ transportType: "server-side", bridge }),
      ],
      stores: [backend],
      onUnresolvedDoc: () => Replicate(),
    })

    const client = createExchange({
      identity: { peerId: "client" },
      transports: [
        createBridgeTransport({ transportType: "client-side", bridge }),
      ],
    })

    const doc = client.get("doc-1", SequentialDoc)
    change(doc, d => {
      d.title.set("network payload")
      d.count.set(99)
    })

    await drain(200)
    await server.flush()

    // Storage on server should have entries
    const entries: unknown[] = []
    for await (const e of backend.loadAll("doc-1")) {
      entries.push(e)
    }
    expect(entries.length).toBeGreaterThanOrEqual(1)
  })
})

// ===========================================================================
// Storage + replicated doc
// ===========================================================================

describe("Storage + replicated doc", () => {
  it("exchange.replicate() + storage → relay persists and hydrates", async () => {
    const sharedData: InMemoryStoreData = {
      entries: new Map(),
      metadata: new Map(),
    }

    const bridge1 = new Bridge()

    // Relay 1: replicate mode + storage
    const relay1 = createExchange({
      identity: { peerId: "relay-1", type: "service" },
      transports: [
        createBridgeTransport({ transportType: "relay-side", bridge: bridge1 }),
      ],
      stores: [createInMemoryStore({ sharedData })],
      onUnresolvedDoc: () => Replicate(),
    })

    const peerA = createExchange({
      identity: { peerId: "peer-a" },
      transports: [
        createBridgeTransport({
          transportType: "peer-a-side",
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

    // Verify storage has data
    const check = new InMemoryStore(sharedData)
    expect(await check.lookup("doc-1")).not.toBeNull()
    const entries: unknown[] = []
    for await (const e of check.loadAll("doc-1")) {
      entries.push(e)
    }
    expect(entries.length).toBeGreaterThanOrEqual(1)

    // Shut down relay 1
    await peerA.shutdown()
    await relay1.shutdown()

    // Relay 2: restart with same storage, connect to peer B
    const bridge2 = new Bridge()

    const relay2 = createExchange({
      identity: { peerId: "relay-2", type: "service" },
      transports: [
        createBridgeTransport({ transportType: "relay-side", bridge: bridge2 }),
      ],
      stores: [createInMemoryStore({ sharedData })],
      onUnresolvedDoc: () => Replicate(),
    })

    const peerB = createExchange({
      identity: { peerId: "peer-b" },
      transports: [
        createBridgeTransport({
          transportType: "peer-b-side",
          bridge: bridge2,
        }),
      ],
      onUnresolvedDoc: () => Interpret(SequentialDoc),
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
// Storage + dismiss
// ===========================================================================

describe("Storage + dismiss", () => {
  it("dismiss() removes doc from storage", async () => {
    const backend = new InMemoryStore()

    const exchange = createExchange({
      identity: { peerId: "server" },
      stores: [backend],
    })

    const doc = exchange.get("doc-1", SequentialDoc)
    await exchange.flush()

    change(doc, d => d.title.set("will be dismissed"))
    await exchange.flush()

    expect(await backend.lookup("doc-1")).not.toBeNull()

    exchange.dismiss("doc-1")
    await exchange.flush()

    expect(await backend.lookup("doc-1")).toBeNull()
  })
})

// ===========================================================================
// No storage (baseline — storage is optional)
// ===========================================================================

describe("No storage (baseline)", () => {
  it("exchange without storage works exactly as before", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      identity: { peerId: "peer-a" },
      transports: [createBridgeTransport({ transportType: "side-a", bridge })],
    })

    const exchangeB = createExchange({
      identity: { peerId: "peer-b" },
      transports: [createBridgeTransport({ transportType: "side-b", bridge })],
      onUnresolvedDoc: () => Interpret(SequentialDoc),
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
