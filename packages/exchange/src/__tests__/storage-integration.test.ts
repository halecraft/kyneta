// storage-integration — end-to-end integration tests for storage adapters.
//
// These tests prove that the StorageAdapter, InMemoryStorageBackend, and
// storage-first sync machinery work together with real Exchange instances,
// BridgeAdapters, and actual substrates (Plain, Loro, LWW).

import { bindLoro, LoroSchema, loroReplicaFactory } from "@kyneta/loro-schema"
import {
  bindEphemeral,
  bindPlain,
  change,
  Interpret,
  plainReplicaFactory,
  Replicate,
  Schema,
  type BoundSchema,
} from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import { Bridge, createBridgeAdapter } from "../adapter/bridge-adapter.js"
import { Exchange } from "../exchange.js"
import {
  createInMemoryStorage,
  InMemoryStorageBackend,
} from "../storage/in-memory-storage-backend.js"
import type { StorageEntry } from "../storage/storage-backend.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Drain microtask queue — necessary for BridgeAdapter async delivery
 * and StorageAdapter async operations.
 */
async function drain(rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>(r => queueMicrotask(r))
    await new Promise<void>(r => setTimeout(r, 0))
  }
}

/** Active exchanges that need cleanup */
const activeExchanges: Exchange[] = []

function createExchange(
  params: ConstructorParameters<typeof Exchange>[0] = {},
): Exchange {
  const ex = new Exchange(params)
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
// Bound schemas (module scope)
// ---------------------------------------------------------------------------

const sequentialSchema = Schema.doc({
  title: Schema.string(),
  count: Schema.number(),
})
const SequentialDoc = bindPlain(sequentialSchema)

const loroSchema = LoroSchema.doc({
  title: LoroSchema.text(),
})
const CausalDoc = bindLoro(loroSchema)

const presenceSchema = Schema.doc({
  cursor: Schema.struct({ x: Schema.number(), y: Schema.number() }),
  name: Schema.string(),
})
const PresenceDoc = bindEphemeral(presenceSchema)

// ---------------------------------------------------------------------------
// Storage persist + hydrate
// ---------------------------------------------------------------------------

describe("Storage persist + hydrate", () => {
  it("write via peer A → storage persists → shutdown → new exchange with same storage → peer B gets data", async () => {
    const sharedData: Map<string, StorageEntry[]> = new Map()

    // --- Phase 1: Exchange 1 creates doc, mutates, persists to storage ---
    const bridge1 = new Bridge()
    const exchange1 = createExchange({
      identity: { peerId: "server-1", name: "Server", type: "service" },
      adapters: [
        createInMemoryStorage({ sharedData }),
        createBridgeAdapter({
          adapterType: "peer-a-side",
          bridge: bridge1,
        }),
      ],
    })

    const peerA = createExchange({
      identity: { peerId: "peer-a", name: "Peer A", type: "user" },
      adapters: [
        createBridgeAdapter({
          adapterType: "peer-b-side",
          bridge: bridge1,
        }),
      ],
    })

    // Peer A creates and mutates a document
    const docA = peerA.get("todo-1", SequentialDoc)
    change(docA, d => {
      d.title.set("My Todos")
      d.count.set(42)
    })

    // Server should discover and sync
    exchange1.get("todo-1", SequentialDoc)
    await drain()

    // Verify storage has data (drain covers the async storage write
    // since InMemoryStorageBackend resolves within one microtask)
    expect(sharedData.has("todo-1")).toBe(true)
    expect(sharedData.get("todo-1")!.length).toBeGreaterThan(0)

    // Shutdown exchange 1 (shutdown() calls flush() internally,
    // ensuring all pending storage ops complete before teardown)
    await exchange1.shutdown()
    await peerA.shutdown()

    // --- Phase 2: New exchange with same storage, new peer connects ---
    const bridge2 = new Bridge()
    const exchange2 = createExchange({
      identity: { peerId: "server-2", name: "Server 2", type: "service" },
      adapters: [
        createInMemoryStorage({ sharedData }),
        createBridgeAdapter({
          adapterType: "server-side",
          bridge: bridge2,
        }),
      ],
      onDocDiscovered: (docId) => {
        if (docId === "todo-1") return Interpret(SequentialDoc)
        return undefined
      },
    })

    const peerB = createExchange({
      identity: { peerId: "peer-b", name: "Peer B", type: "user" },
      adapters: [
        createBridgeAdapter({
          adapterType: "peer-b-side",
          bridge: bridge2,
        }),
      ],
      onDocDiscovered: (docId) => {
        if (docId === "todo-1") return Interpret(SequentialDoc)
        return undefined
      },
    })

    // Server 2 re-creates the doc — should hydrate from storage
    const docServer = exchange2.get("todo-1", SequentialDoc)
    await drain(40)

    // Peer B should get the data via the server
    const docB = peerB.get("todo-1", SequentialDoc)
    await drain(40)

    // Verify data survived the restart
    expect(docServer.title()).toBe("My Todos")
    expect(docServer.count()).toBe(42)
    expect(docB.title()).toBe("My Todos")
    expect(docB.count()).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// Storage + interpreted doc
// ---------------------------------------------------------------------------

describe("Storage + interpreted doc", () => {
  it("exchange.get() + storage adapter → mutations persist and hydrate correctly", async () => {
    const sharedData: Map<string, StorageEntry[]> = new Map()

    // Exchange with storage creates a doc and mutates it
    const exchange1 = createExchange({
      identity: { peerId: "node-1", name: "Node 1", type: "service" },
      adapters: [createInMemoryStorage({ sharedData })],
    })

    const doc1 = exchange1.get("config-1", SequentialDoc)
    change(doc1, d => {
      d.title.set("Settings")
      d.count.set(7)
    })
    await drain()

    // shutdown() flushes pending storage ops internally
    await exchange1.shutdown()

    const exchange2 = createExchange({
      identity: { peerId: "node-2", name: "Node 2", type: "service" },
      adapters: [createInMemoryStorage({ sharedData })],
    })

    // Re-create the doc — it should hydrate from storage
    const doc2 = exchange2.get("config-1", SequentialDoc)
    await drain(40)

    expect(doc2.title()).toBe("Settings")
    expect(doc2.count()).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// Storage + replicated doc
// ---------------------------------------------------------------------------

describe("Storage + replicated doc", () => {
  it("exchange.replicate() + storage adapter → relay persists and hydrates", async () => {
    const sharedData: Map<string, StorageEntry[]> = new Map()

    // Set up a relay server with storage + a client peer
    const bridge1 = new Bridge()
    const relay1 = createExchange({
      identity: { peerId: "relay-1", name: "Relay", type: "service" },
      adapters: [
        createInMemoryStorage({ sharedData }),
        createBridgeAdapter({ adapterType: "relay-side", bridge: bridge1 }),
      ],
      onDocDiscovered: () => Replicate(plainReplicaFactory, "sequential"),
    })

    const client1 = createExchange({
      identity: { peerId: "client-1", name: "Client 1", type: "user" },
      adapters: [
        createBridgeAdapter({
          adapterType: "client-side",
          bridge: bridge1,
        }),
      ],
    })

    // Client creates doc and syncs through relay
    const doc1 = client1.get("data-1", SequentialDoc)
    change(doc1, d => {
      d.title.set("Replicated Data")
      d.count.set(99)
    })
    await drain(40)

    // Verify storage has the data (drain covers the async write)
    expect(sharedData.has("data-1")).toBe(true)

    // shutdown() flushes pending storage ops internally
    await relay1.shutdown()
    await client1.shutdown()

    // New relay with same storage, new client connects
    const bridge2 = new Bridge()
    const relay2 = createExchange({
      identity: { peerId: "relay-2", name: "Relay 2", type: "service" },
      adapters: [
        createInMemoryStorage({ sharedData }),
        createBridgeAdapter({ adapterType: "relay-side", bridge: bridge2 }),
      ],
      onDocDiscovered: () => Replicate(plainReplicaFactory, "sequential"),
    })

    const client2 = createExchange({
      identity: { peerId: "client-2", name: "Client 2", type: "user" },
      adapters: [
        createBridgeAdapter({
          adapterType: "client-side",
          bridge: bridge2,
        }),
      ],
      onDocDiscovered: () => Interpret(SequentialDoc),
    })

    // Client 2 creates the doc — should get data from relay's storage
    const doc2 = client2.get("data-1", SequentialDoc)
    await drain(40)

    expect(doc2.title()).toBe("Replicated Data")
    expect(doc2.count()).toBe(99)
  })
})

// ---------------------------------------------------------------------------
// Dismiss propagates to storage
// ---------------------------------------------------------------------------

describe("Dismiss propagates to storage", () => {
  it("exchange.dismiss() → storage.delete() called", async () => {
    const sharedData: Map<string, StorageEntry[]> = new Map()

    const exchange = createExchange({
      identity: { peerId: "node-1", name: "Node 1", type: "service" },
      adapters: [createInMemoryStorage({ sharedData })],
    })

    // Create and persist a document
    const doc = exchange.get("ephemeral-1", SequentialDoc)
    change(doc, d => d.title.set("Will be dismissed"))
    await drain()

    // Verify it's in storage (drain covers the async append)
    expect(sharedData.has("ephemeral-1")).toBe(true)

    // Dismiss the document
    exchange.dismiss("ephemeral-1")
    await drain()

    // Storage should have deleted it (drain covers the async delete)
    expect(sharedData.has("ephemeral-1")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Multiple storage adapters
// ---------------------------------------------------------------------------

describe("Multiple storage adapters", () => {
  it("two InMemoryStorageBackends, one has data, one doesn't → both consulted", async () => {
    // Storage 1 has data, storage 2 is empty
    const storageData1: Map<string, StorageEntry[]> = new Map()
    const storageData2: Map<string, StorageEntry[]> = new Map()

    // Pre-populate storage 1 by running an exchange with it
    const setupExchange = createExchange({
      identity: { peerId: "setup", name: "Setup", type: "service" },
      adapters: [createInMemoryStorage({ sharedData: storageData1 })],
    })
    const setupDoc = setupExchange.get("multi-1", SequentialDoc)
    change(setupDoc, d => {
      d.title.set("From Storage 1")
      d.count.set(11)
    })
    await drain()
    // shutdown() flushes pending storage ops internally
    await setupExchange.shutdown()

    expect(storageData1.has("multi-1")).toBe(true)
    expect(storageData2.has("multi-1")).toBe(false)

    // Create server with both storage adapters. The server pre-creates the
    // doc so that storage hydration completes before any client connects.
    // This validates that both storage adapters are consulted during the
    // doc-ensure → interest → offers → completion flow.
    const bridge = new Bridge()
    const server = createExchange({
      identity: { peerId: "server", name: "Server", type: "service" },
      adapters: [
        createInMemoryStorage({
          sharedData: storageData1,
          adapterType: "storage-1",
        }),
        createInMemoryStorage({
          sharedData: storageData2,
          adapterType: "storage-2",
        }),
        createBridgeAdapter({ adapterType: "server-side", bridge }),
      ],
    })

    // Server pre-creates the doc — triggers interest to both storage channels.
    // Storage 1 sends offers (has data), storage 2 sends only completion interest.
    const serverDoc = server.get("multi-1", SequentialDoc)
    await drain(50)

    // Server doc should be hydrated from storage 1
    expect(serverDoc.title()).toBe("From Storage 1")
    expect(serverDoc.count()).toBe(11)

    // Now a client connects and requests the same doc
    const client = createExchange({
      identity: { peerId: "client", name: "Client", type: "user" },
      adapters: [
        createBridgeAdapter({ adapterType: "client-side", bridge }),
      ],
      onDocDiscovered: () => Interpret(SequentialDoc),
    })

    const clientDoc = client.get("multi-1", SequentialDoc)
    await drain(40)

    // Client should receive the hydrated data from the server
    expect(clientDoc.title()).toBe("From Storage 1")
    expect(clientDoc.count()).toBe(11)

    // Verify storage 2 also got the data (persisted via the offer relay)
    expect(storageData2.has("multi-1")).toBe(true)
  })
})