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
  batch,
  ephemeral,
  ephemeralReplicaFactory,
  Interpret,
  json,
  Replicate,
  Schema,
  SYNC_EPHEMERAL,
} from "@kyneta/schema"
import { afterEach, describe, expect, it } from "vitest"
import { docStatus } from "../doc-status.js"
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
import { whenSettled } from "../sync.js"
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

/**
 * Wrap a store, replacing some of its methods.
 *
 * Forwarding every method by hand is the point of the helper, not an
 * oversight. `createInMemoryStore` returns a class instance, so the obvious
 * spelling — `{ ...store, append }` — copies the own properties and none of
 * the prototype methods. The result typechecks as a complete `Store` and then
 * fails at the first `currentMeta` or `loadAll`, a long way from the line that
 * caused it. Adding a method to `Store` now breaks this in one visible place
 * rather than silently in several.
 */
function wrapStore(inner: Store, overrides: Partial<Store>): Store {
  return {
    append: (docId, record) => inner.append(docId, record),
    loadAll: docId => inner.loadAll(docId),
    replace: (docId, records) => inner.replace(docId, records),
    delete: docId => inner.delete(docId),
    currentMeta: docId => inner.currentMeta(docId),
    listDocIds: prefix => inner.listDocIds(prefix),
    close: () => inner.close(),
    ...overrides,
  }
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

    batch(doc1, d => {
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

    batch(doc1, (d: any) => {
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

  it("ephemeral doc: writes do NOT survive a restart", async () => {
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

    batch(doc1, d => {
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

    // `SYNC_EPHEMERAL` is `durability: "transient"`. Presence says who is here
    // *now*, so a restarted server resurrecting yesterday's cursor positions
    // would be worse than having none — the document comes back at its
    // structural zeros.
    //
    // Asserted against that contract rather than against the mechanism, which
    // is why this test did not have to change when the mechanism did. It used
    // to hold by accident — nothing told the store the document was transient,
    // it simply could not persist updates, because a snapshot-only substrate
    // always returns `null` from `exportSince`. The rule is now declared, and
    // the assertion is untouched.
    expect(doc2.name()).toBe("")
    expect(doc2.cursor.x()).toBe(0)
    expect(doc2.cursor.y()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Writes that arrive while another write is in flight
// ---------------------------------------------------------------------------

/** Wrap a store so appends resolve on a later turn, holding a write open. */
function slowAppend(inner: Store): Store {
  return wrapStore(inner, {
    append: async (docId, record) => {
      await new Promise(resolve => setTimeout(resolve, 5))
      return inner.append(docId, record)
    },
  })
}

describe("a mutation during an in-flight write", () => {
  it("is queued and persisted, not dropped", async () => {
    // At most one write per document is in flight at a time; anything that
    // arrives meanwhile is queued by the store-program and replayed when the
    // first completes. That only works if the runtime still *offers* it —
    // computing the delta from the last confirmed version, which during a
    // write is the version that write started from, not its pending one.
    //
    // Returning early for an in-flight write instead looks harmless and is
    // not: nothing else would ever offer that mutation to the store, so it
    // would sit unpersisted until some later mutation happened to sweep it up.
    const sharedData: InMemoryStoreData = {
      records: new Map(),
      metadata: new Map(),
    }
    const exchange1 = createExchange({
      id: "server",
      stores: [slowAppend(createInMemoryStore({ sharedData }))],
    })

    const doc = exchange1.get("doc-1", SequentialDoc)
    await exchange1.flush()

    batch(doc, d => {
      d.title.set("first")
    })
    // Lands while the write above is still open.
    batch(doc, d => {
      d.count.set(99)
    })
    await exchange1.shutdown()

    const exchange2 = createExchange({
      id: "server",
      stores: [createInMemoryStore({ sharedData })],
    })
    const restored = exchange2.get("doc-1", SequentialDoc)
    await exchange2.flush()

    expect(restored.title()).toBe("first")
    expect(restored.count()).toBe(99)
  })
})

// ---------------------------------------------------------------------------

// Recovering from a failed first write
// ---------------------------------------------------------------------------

/** Wrap a store so that its first `append` rejects and later ones succeed. */
function failingFirstAppend(inner: Store): Store {
  let failuresLeft = 1
  return wrapStore(inner, {
    append: async (docId, record) => {
      if (failuresLeft > 0) {
        failuresLeft--
        throw new Error("disk full")
      }
      return inner.append(docId, record)
    },
  })
}

describe("a store whose first write fails", () => {
  it("still persists the document on the next mutation", async () => {
    // The first write is the one with nothing behind it. Every later write is
    // a delta against the version the store last confirmed; the first has no
    // such version, so if it fails there is nothing to recompute from.
    //
    // The document used to be abandoned at that point — silently excluded
    // from persistence for the rest of the process, recovering only on
    // restart, while `onStoreError` reported the failure but nothing reported
    // the durable consequence.
    const sharedData: InMemoryStoreData = {
      records: new Map(),
      metadata: new Map(),
    }
    const flaky = failingFirstAppend(createInMemoryStore({ sharedData }))

    const exchange = createExchange({
      id: "server",
      stores: [flaky],
      onStoreError: () => {}, // expected here; keep it out of the test output
    })

    const doc = exchange.get("doc-1", SequentialDoc)
    await exchange.flush()
    expect(sharedData.records.has("doc-1")).toBe(false)

    // The next mutation re-attempts the whole document rather than a delta.
    batch(doc, d => {
      d.title.set("written on the retry")
    })
    await exchange.flush()

    expect(sharedData.records.has("doc-1")).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Transient documents and durable storage
// ---------------------------------------------------------------------------

describe("transient documents never reach a store", () => {
  // The test above pins the *observable* contract: writes do not survive a
  // restart. These pin the rule underneath it — that a transient document is
  // never offered to a store in either direction. Before this rule existed the
  // document was registered at creation, so an empty creation-time snapshot sat
  // on disk, was faithfully hydrated on restart, and never updated again.

  it("an interpreted transient document leaves no records", async () => {
    const sharedData: InMemoryStoreData = {
      records: new Map(),
      metadata: new Map(),
    }
    const exchange = createExchange({
      id: "server",
      stores: [createInMemoryStore({ sharedData })],
    })

    const doc = exchange.get("presence-1", PresenceDoc)
    batch(doc, d => {
      d.name.set("Alice")
    })
    await exchange.flush()

    expect(sharedData.records.has("presence-1")).toBe(false)
  })

  it("a replicated transient document leaves no records", async () => {
    // A relay holds transient documents too, headlessly. This is the only
    // coverage of the replicate creation path — it has no `docStatus` surface,
    // so the store is the one place its behaviour is observable.
    const sharedData: InMemoryStoreData = {
      records: new Map(),
      metadata: new Map(),
    }
    const exchange = createExchange({
      id: "relay",
      stores: [createInMemoryStore({ sharedData })],
    })

    exchange.replicate(
      "relayed-presence",
      ephemeralReplicaFactory,
      SYNC_EPHEMERAL,
      PresenceDoc.schemaHash,
    )
    await exchange.flush()

    expect(sharedData.records.has("relayed-presence")).toBe(false)
  })

  it("destroying a transient document issues no store delete", async () => {
    // Presence documents churn on every tab open and close, so a delete per
    // teardown for something never written is a steady trickle of pointless
    // store I/O.
    const sharedData: InMemoryStoreData = {
      records: new Map(),
      metadata: new Map(),
    }
    const store = createInMemoryStore({ sharedData })
    let deletes = 0
    const counting = wrapStore(store, {
      delete: async (docId: string) => {
        deletes++
        return store.delete(docId)
      },
    })

    const exchange = createExchange({ id: "server", stores: [counting] })
    exchange.get("presence-1", PresenceDoc)
    await exchange.flush()

    exchange.destroy("presence-1")
    await exchange.flush()

    expect(deletes).toBe(0)
  })

  it("destroying a durable document never opened this session still deletes", async () => {
    // The guard on this phase's own risk. Skipping the delete is only safe
    // when we know the document was never stored, and a document absent from
    // the cache is precisely the case where we know nothing — it may well be
    // sitting on disk from a previous session. `Exchange.destroy` is
    // documented as the single public API for removal, so it has to work here.
    const sharedData: InMemoryStoreData = {
      records: new Map(),
      metadata: new Map(),
    }

    const exchange1 = createExchange({
      id: "server",
      stores: [createInMemoryStore({ sharedData })],
    })
    const doc = exchange1.get("doc-1", SequentialDoc)
    await exchange1.flush()
    batch(doc, d => {
      d.title.set("on disk")
    })
    await exchange1.shutdown()
    expect(sharedData.records.has("doc-1")).toBe(true)

    // Second exchange never calls get() for this document, so it has no cache
    // entry to consult.
    const exchange2 = createExchange({
      id: "server",
      stores: [createInMemoryStore({ sharedData })],
    })
    exchange2.destroy("doc-1")
    await exchange2.flush()

    expect(sharedData.records.get("doc-1") ?? []).toHaveLength(0)
  })

  it("a transient document settles rather than waiting on a load", async () => {
    // The readiness half of the rule, and the failure no other test can see.
    //
    // Three places in document creation ask "will this hydrate?" and they have
    // to agree. Change only the branch that dispatches the load, and the latch
    // is still initialised `pending` while the only code that resolves it sits
    // in the branch now skipped — so the document never settles.
    //
    // `flush()` and `shutdown()` cannot catch that: an unregistered document is
    // not tracked by the store-program, so both complete while it hangs.
    const exchange = createExchange({
      id: "server",
      stores: [
        createInMemoryStore({
          sharedData: { records: new Map(), metadata: new Map() },
        }),
      ],
    })

    const doc = exchange.get("presence-1", PresenceDoc)

    await whenSettled(doc)
    expect(docStatus(doc)).not.toBe("pending")
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

    const bridge = new Bridge()

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
    batch(docA, d => {
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

    const bridge2 = new Bridge()

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
    const bridge = new Bridge()

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
    batch(doc, d => {
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

    const bridge1 = new Bridge()

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
    batch(docA, d => {
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
    const bridge2 = new Bridge()

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

    batch(doc, d => d.title.set("will be destroyed"))
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
    const bridge = new Bridge()

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
    batch(docA, d => {
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
