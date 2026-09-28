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
  createDoc,
  ephemeral,
  ephemeralReplicaFactory,
  exportEntirety,
  Interpret,
  json,
  Replicate,
  Schema,
  SYNC_EPHEMERAL,
  version,
} from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"
import { decodeImportBlobMeta } from "loro-crdt"
import { afterEach, describe, expect, it, vi } from "vitest"
import { docStatus } from "../doc-status.js"
import { persistenceError } from "../persistence.js"
import { Runtime } from "../runtime.js"
import { whenHydrated } from "../settle.js"
import {
  createInMemoryStore,
  createInMemoryStoreData,
  InMemoryStore,
  type InMemoryStoreData,
  recordsOf,
} from "../store/in-memory-store.js"
import { sessionSeat } from "../store/seats.js"
import type { Store, StoreRecord } from "../store/store.js"
import { whenSettled } from "../sync.js"
import { collectAll } from "../testing/store-conformance.js"
import { exchangesPerTest, sleep } from "./exchanges.js"
import { wrapStore } from "./wrap-store.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Drain microtask queue — necessary for BridgeTransport async delivery
 * and storage hydration async operations.
 */

const createExchange = exchangesPerTest()

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
    const sharedData: InMemoryStoreData = createInMemoryStoreData()

    // Phase 1: create doc, mutate, persist
    const exchange1 = createExchange({
      principal: "server",
      store: createInMemoryStore({ sharedData }),
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
      principal: "server",
      store: createInMemoryStore({ sharedData }),
    })

    const doc2 = exchange2.get("doc-1", SequentialDoc)
    await exchange2.flush()

    expect(doc2.title()).toBe("persisted")
    expect(doc2.count()).toBe(42)
  })

  it("collaborative doc (Loro): write → shutdown → restart → hydrate", async () => {
    const sharedData: InMemoryStoreData = createInMemoryStoreData()

    const exchange1 = createExchange({
      principal: "server",
      store: createInMemoryStore({ sharedData }),
      schemas: [CausalDoc],
    })

    const doc1 = exchange1.get("doc-1", CausalDoc)
    await exchange1.flush()

    batch(doc1, (d: any) => {
      d.title.insert(0, "hello loro")
    })
    await exchange1.shutdown()

    const exchange2 = createExchange({
      principal: "server",
      store: createInMemoryStore({ sharedData }),
      schemas: [CausalDoc],
    })

    const doc2 = exchange2.get("doc-1", CausalDoc)
    await exchange2.flush()

    expect(doc2.title()).toBe("hello loro")
  })

  it("ephemeral doc: writes do NOT survive a restart", async () => {
    const sharedData: InMemoryStoreData = createInMemoryStoreData()

    const exchange1 = createExchange({
      principal: "server",
      store: createInMemoryStore({ sharedData }),
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
      principal: "server",
      store: createInMemoryStore({ sharedData }),
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
    // it simply could not persist updates, because the substrate could not
    // produce a delta at all. It can now, and this assertion did not move:
    // the rule became declared before the accident disappeared.
    expect(doc2.name()).toBe("")
    expect(doc2.cursor.x()).toBe(0)
    expect(doc2.cursor.y()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Writes requested while another write is in flight
// ---------------------------------------------------------------------------

/**
 * Wrap a store so that, while held, appends wait until released — or fail.
 * Lets a test decide exactly which writes are in flight when a mutation lands.
 */
function gatedAppend(inner: Store) {
  let held: {
    promise: Promise<void>
    resolve: () => void
    reject: (error: unknown) => void
  } | null = null
  const store = wrapStore(inner, {
    append: async (docId, record) => {
      if (held) await held.promise
      return inner.append(docId, record)
    },
  })
  return {
    store,
    hold(): void {
      let resolve = (): void => {}
      let reject = (_error: unknown): void => {}
      const promise = new Promise<void>((res, rej) => {
        resolve = res
        reject = rej
      })
      held = { promise, resolve, reject }
    },
    release(): void {
      const h = held
      held = null
      h?.resolve()
    },
    fail(error: unknown): void {
      const h = held
      held = null
      h?.reject(error)
    },
  }
}

/** Let the Runtime's microtask drain dispatch what the last batch did. */
async function tick(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

/** The entry records stored for a document, in order. */
function entriesOf(
  sharedData: InMemoryStoreData,
  docId: string,
): (StoreRecord & { kind: "entry" })[] {
  return recordsOf(sharedData, docId).filter(
    (r): r is StoreRecord & { kind: "entry" } => r.kind === "entry",
  )
}

describe("a mutation during an in-flight write", () => {
  it("is persisted, not dropped", async () => {
    // At most one write per document is in flight at a time. A request that
    // arrives meanwhile is owed, and written once the first lands.
    const sharedData: InMemoryStoreData = createInMemoryStoreData()
    const gate = gatedAppend(createInMemoryStore({ sharedData }))
    const exchange1 = createExchange({ principal: "server", store: gate.store })

    const doc = exchange1.get("doc-1", SequentialDoc)
    await exchange1.flush()

    gate.hold()
    batch(doc, d => {
      d.title.set("first")
    })
    await tick() // this write is in flight
    batch(doc, d => {
      d.count.set(99)
    })
    await tick()
    gate.release()
    await exchange1.shutdown()

    const exchange2 = createExchange({
      principal: "server",
      store: createInMemoryStore({ sharedData }),
    })
    const restored = exchange2.get("doc-1", SequentialDoc)
    await exchange2.flush()

    expect(restored.title()).toBe("first")
    expect(restored.count()).toBe(99)
  })

  it("is persisted when it lands during the document's first write", async () => {
    // The first write is the whole document, and has no confirmed version
    // behind it. A mutation landing while it is in flight used to be
    // discarded — there was no base to diff it against yet — and nothing
    // offered it again, so a restart found the document without it.
    const sharedData: InMemoryStoreData = createInMemoryStoreData()
    const gate = gatedAppend(createInMemoryStore({ sharedData }))
    const exchange1 = createExchange({ principal: "server", store: gate.store })

    gate.hold()
    const doc = exchange1.get("doc-1", SequentialDoc)
    await whenHydrated(doc) // loaded; the first write is now in flight
    batch(doc, d => {
      d.title.set("during the first write")
    })
    await tick()
    gate.release()
    await exchange1.shutdown()

    const exchange2 = createExchange({
      principal: "server",
      store: createInMemoryStore({ sharedData }),
    })
    const restored = exchange2.get("doc-1", SequentialDoc)
    await exchange2.flush()

    expect(restored.title()).toBe("during the first write")
  })

  it("is written as a delta from what the in-flight write confirmed, repeating none of it", async () => {
    // The redundancy this guards against: a delta computed when the request
    // arrived starts from before the in-flight write, so it carries that
    // write's operations again. With a large in-flight write and a few small
    // edits behind it, every record after the first used to be as large as
    // the first.
    const sharedData: InMemoryStoreData = createInMemoryStoreData()
    const gate = gatedAppend(createInMemoryStore({ sharedData }))
    const exchange1 = createExchange({ principal: "server", store: gate.store })

    const doc = exchange1.get("doc-1", CausalDoc)
    await exchange1.flush()
    const before = entriesOf(sharedData, "doc-1").length

    gate.hold()
    batch(doc, d => {
      d.title.insert(0, "x".repeat(50_000))
    })
    await tick() // the large write is now in flight
    batch(doc, d => {
      d.title.insert(0, "a")
    })
    await tick()
    batch(doc, d => {
      d.title.insert(0, "b")
    })
    await tick()
    gate.release()
    await exchange1.flush()

    // Two records: the large write, and one owed write carrying both edits.
    const written = entriesOf(sharedData, "doc-1").slice(before)
    expect(written).toHaveLength(2)
    const [large, owed] = written.map(e => {
      const data = e.payload.data
      if (!(data instanceof Uint8Array)) throw new Error("expected binary")
      return { data, meta: decodeImportBlobMeta(data, false) }
    })
    if (!large || !owed) throw new Error("expected two records")

    // Contiguous: the owed record starts exactly where the large one ends.
    expect(owed.meta.partialStartVersionVector.toJSON()).toEqual(
      large.meta.partialEndVersionVector.toJSON(),
    )
    expect(owed.data.byteLength).toBeLessThan(1_000)

    await exchange1.shutdown()
    const exchange2 = createExchange({
      principal: "server",
      store: createInMemoryStore({ sharedData }),
    })
    const restored = exchange2.get("doc-1", CausalDoc)
    await exchange2.flush()
    expect(restored.title()).toBe(`ba${"x".repeat(50_000)}`)
  })

  it("covers the in-flight write's changes when that write fails", async () => {
    // A write owed behind a failed one diffs from where the failed one
    // started, so it carries both — nothing is lost, and nothing is retried
    // in a loop.
    const sharedData: InMemoryStoreData = createInMemoryStoreData()
    const gate = gatedAppend(createInMemoryStore({ sharedData }))
    const errors: unknown[] = []
    const exchange1 = createExchange({
      principal: "server",
      store: gate.store,
      onStoreError: (_docId, _op, error) => errors.push(error),
    })

    const doc = exchange1.get("doc-1", SequentialDoc)
    await exchange1.flush()

    gate.hold()
    batch(doc, d => {
      d.title.set("lost with the failed write?")
    })
    await tick()
    batch(doc, d => {
      d.count.set(7)
    })
    await tick()
    gate.fail(new Error("disk full"))
    await exchange1.flush()
    expect(errors).toHaveLength(1)
    await exchange1.shutdown()

    const exchange2 = createExchange({
      principal: "server",
      store: createInMemoryStore({ sharedData }),
    })
    const restored = exchange2.get("doc-1", SequentialDoc)
    await exchange2.flush()
    expect(restored.title()).toBe("lost with the failed write?")
    expect(restored.count()).toBe(7)
  })
})

describe("a failed compaction", () => {
  it("does not stop later writes from persisting", async () => {
    // Compaction trims the replica's history before it writes. Queue one
    // behind a write in flight and let both fail, and the store's confirmed
    // version is left behind the trimmed base. `exportSince` from there
    // answers `null` — "cannot", not "nothing" — and reading it as "nothing"
    // silently wrote no further changes until some later compaction
    // happened to succeed.
    const sharedData: InMemoryStoreData = createInMemoryStoreData()
    const gate = gatedAppend(createInMemoryStore({ sharedData }))
    let failCompact = true
    const exchange1 = createExchange({
      principal: "server",
      store: wrapStore(gate.store, {
        compact: async (docId, records, through) => {
          if (failCompact) {
            failCompact = false
            throw new Error("disk full")
          }
          return gate.store.compact(docId, records, through)
        },
      }),
      onStoreError: () => {}, // expected here; keep it out of the test output
    })

    const doc = exchange1.get("doc-1", SequentialDoc)
    await exchange1.flush()
    batch(doc, d => {
      d.title.set("before")
    })
    await exchange1.flush()

    gate.hold()
    batch(doc, d => {
      d.title.set("trimmed")
    })
    await tick() // this write is in flight
    const compacted = exchange1.compact("doc-1") // trims, then waits its turn
    gate.fail(new Error("disk full")) // the write fails, then the compaction
    await compacted

    batch(doc, d => {
      d.count.set(3)
    })
    await exchange1.shutdown()

    const exchange2 = createExchange({
      principal: "server",
      store: createInMemoryStore({ sharedData }),
    })
    const restored = exchange2.get("doc-1", SequentialDoc)
    await exchange2.flush()
    expect(restored.title()).toBe("trimmed")
    expect(restored.count()).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Recovering from a failed first write
// ---------------------------------------------------------------------------

/** Wrap a store so that its first `append` rejects and later ones succeed. */
/** A store whose first write, an append or a compaction, fails. */
function failingFirstWrite(inner: Store): Store {
  let failuresLeft = 1
  const fail = (): boolean => {
    if (failuresLeft === 0) return false
    failuresLeft--
    return true
  }
  return wrapStore(inner, {
    append: async (docId, record) => {
      if (fail()) throw new Error("disk full")
      return inner.append(docId, record)
    },
    compact: async (docId, records, through) => {
      if (fail()) throw new Error("disk full")
      return inner.compact(docId, records, through)
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
    const sharedData: InMemoryStoreData = createInMemoryStoreData()
    const flaky = failingFirstWrite(createInMemoryStore({ sharedData }))

    const exchange = createExchange({
      principal: "server",
      store: flaky,
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
    const sharedData: InMemoryStoreData = createInMemoryStoreData()
    const exchange = createExchange({
      principal: "server",
      store: createInMemoryStore({ sharedData }),
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
    const sharedData: InMemoryStoreData = createInMemoryStoreData()
    const exchange = createExchange({
      principal: "relay",
      store: createInMemoryStore({ sharedData }),
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
    const sharedData: InMemoryStoreData = createInMemoryStoreData()
    const store = createInMemoryStore({ sharedData })
    let deletes = 0
    const counting = wrapStore(store, {
      delete: async (docId: string) => {
        deletes++
        return store.delete(docId)
      },
    })

    const exchange = createExchange({ principal: "server", store: counting })
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
    const sharedData: InMemoryStoreData = createInMemoryStoreData()

    const exchange1 = createExchange({
      principal: "server",
      store: createInMemoryStore({ sharedData }),
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
      principal: "server",
      store: createInMemoryStore({ sharedData }),
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
      principal: "server",
      store: createInMemoryStore({
        sharedData: createInMemoryStoreData(),
      }),
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
    const sharedData: InMemoryStoreData = createInMemoryStoreData()

    const bridge = new Bridge()

    const server = createExchange({
      principal: "server",
      type: "service",
      transports: [
        createBridgeTransport({ transportId: "server-side", bridge }),
      ],
      store: createInMemoryStore({ sharedData }),
      resolve: () => Replicate(),
    })

    const peerA = createExchange({
      principal: "peer-a",
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
    await sleep(200)
    await server.flush()

    // Verify server persisted — use currentMeta instead of lookup
    const backend = new InMemoryStore(sharedData)
    expect(await backend.currentMeta("doc-1")).not.toBeNull()

    // Stop peer A, restart server with same storage
    await peerA.shutdown()
    await server.shutdown()

    const bridge2 = new Bridge()

    const server2 = createExchange({
      principal: "server",
      type: "service",
      transports: [
        createBridgeTransport({
          transportId: "server-side",
          bridge: bridge2,
        }),
      ],
      store: createInMemoryStore({ sharedData }),
      resolve: () => Replicate(),
    })

    const peerB = createExchange({
      principal: "peer-b",
      transports: [
        createBridgeTransport({
          transportId: "peer-b-side",
          bridge: bridge2,
        }),
      ],
      resolve: () => Interpret(SequentialDoc),
    })

    // Wait for server hydration + peer B sync
    await sleep(300)
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
      principal: "server",
      type: "service",
      transports: [
        createBridgeTransport({ transportId: "server-side", bridge }),
      ],
      store: backend,
      resolve: () => Replicate(),
    })

    const client = createExchange({
      principal: "client",
      transports: [
        createBridgeTransport({ transportId: "client-side", bridge }),
      ],
    })

    const doc = client.get("doc-1", SequentialDoc)
    batch(doc, d => {
      d.title.set("network payload")
      d.count.set(99)
    })

    await sleep(200)
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
    const sharedData: InMemoryStoreData = createInMemoryStoreData()

    const bridge1 = new Bridge()

    // Relay 1: replicate mode + storage
    const relay1 = createExchange({
      principal: "relay-1",
      type: "service",
      transports: [
        createBridgeTransport({ transportId: "relay-side", bridge: bridge1 }),
      ],
      store: createInMemoryStore({ sharedData }),
      resolve: () => Replicate(),
    })

    const peerA = createExchange({
      principal: "peer-a",
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

    await sleep(200)
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
      principal: "relay-2",
      type: "service",
      transports: [
        createBridgeTransport({ transportId: "relay-side", bridge: bridge2 }),
      ],
      store: createInMemoryStore({ sharedData }),
      resolve: () => Replicate(),
    })

    const peerB = createExchange({
      principal: "peer-b",
      transports: [
        createBridgeTransport({
          transportId: "peer-b-side",
          bridge: bridge2,
        }),
      ],
      resolve: () => Interpret(SequentialDoc),
    })

    await sleep(300)
    await relay2.flush()
    await peerB.flush()

    if (peerB.has("doc-1")) {
      const docB = peerB.get("doc-1", SequentialDoc)
      expect(docB.title()).toBe("replicated")
      expect(docB.count()).toBe(55)
    }
  })
})

describe("a relay's replica after a lineage reset", () => {
  // A plain writer restarts without a store and writes before reconnecting,
  // so it comes back under a new lineage. The relay answers the writer's
  // entirety by rebuilding its replica from it. Returns the relay once that
  // has happened.
  async function relayThroughReset(sharedData: InMemoryStoreData) {
    const bridge = new Bridge()
    const relay = createExchange({
      principal: "relay",
      type: "service",
      transports: [createBridgeTransport({ transportId: "relay", bridge })],
      store: createInMemoryStore({ sharedData }),
      resolve: () => Replicate(),
    })

    const first = createExchange({
      principal: "writer",
      transports: [createBridgeTransport({ transportId: "first", bridge })],
    })
    batch(first.get("doc-1", SequentialDoc), d => {
      d.title.set("before")
      d.count.set(1)
    })
    await sleep(200)
    await first.shutdown()
    const before = relay.synchronizer.getDoc("doc-1")?.replica

    const second = createExchange({ principal: "writer" })
    batch(second.get("doc-1", SequentialDoc), d => {
      d.title.set("after")
      d.count.set(2)
    })
    await second.addTransport(
      createBridgeTransport({ transportId: "second", bridge }),
    )
    await sleep(300)
    await relay.flush()

    // The rebuild ran. Without this, the assertions below could pass on a
    // relay that merged instead.
    expect(relay.synchronizer.getDoc("doc-1")?.replica).not.toBe(before)
    return relay
  }

  it("persists the rebuilt replica", async () => {
    const sharedData: InMemoryStoreData = createInMemoryStoreData()
    const relay = await relayThroughReset(sharedData)
    await relay.shutdown()

    const bridge = new Bridge()
    createExchange({
      principal: "relay",
      type: "service",
      transports: [createBridgeTransport({ transportId: "relay", bridge })],
      store: createInMemoryStore({ sharedData }),
      resolve: () => Replicate(),
    })
    const reader = createExchange({
      principal: "reader",
      transports: [createBridgeTransport({ transportId: "reader", bridge })],
    })
    const doc = reader.get("doc-1", SequentialDoc)
    await sleep(300)

    expect(doc.title()).toBe("after")
    expect(doc.count()).toBe(2)
  })

  it("promotes the rebuilt replica", async () => {
    const relay = await relayThroughReset(createInMemoryStoreData())

    const doc = relay.get("doc-1", SequentialDoc)

    expect(doc.title()).toBe("after")
    expect(doc.count()).toBe(2)
  })
})

// ===========================================================================
// Storage + destroy
// ===========================================================================

describe("Storage + destroy", () => {
  it("destroy() removes doc from storage", async () => {
    const backend = new InMemoryStore()

    const exchange = createExchange({
      principal: "server",
      store: backend,
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
    // `register` → `persist` a `register` write. The executor calls append(),
    // which throws. The executor catches and dispatches `write-failed`.
    // The store-program emits `store-error`. The executor calls onStoreError.
    const failingStore: Store = {
      seat: sessionSeat(),
      async append() {
        throw new Error("disk full")
      },
      async currentMeta() {
        return null
      },
      async *loadAll() {},
      async *listDocIds() {},
      async mark() {
        return null
      },
      async compact() {
        throw new Error("disk full")
      },
      async delete() {},
      async close() {},
    }

    const exchange = createExchange({
      principal: "server",
      store: failingStore,
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
// No storage (baseline — storage is optional)
// ===========================================================================

describe("No storage (baseline)", () => {
  it("exchange without storage works exactly as before", async () => {
    const bridge = new Bridge()

    const exchangeA = createExchange({
      principal: "peer-a",
      transports: [createBridgeTransport({ transportId: "side-a", bridge })],
    })

    const exchangeB = createExchange({
      principal: "peer-b",
      transports: [createBridgeTransport({ transportId: "side-b", bridge })],
      resolve: () => Interpret(SequentialDoc),
    })

    const docA = exchangeA.get("doc-1", SequentialDoc)
    batch(docA, d => {
      d.title.set("no storage")
      d.count.set(123)
    })

    await sleep(200)

    if (exchangeB.has("doc-1")) {
      const docB = exchangeB.get("doc-1", SequentialDoc)
      expect(docB.title()).toBe("no storage")
      expect(docB.count()).toBe(123)
    }
  })
})

// ===========================================================================
// Several instances over one storage
// ===========================================================================

describe("several instances over one storage", () => {
  const LogSchema = Schema.struct({ log: Schema.text() })
  type LogDoc = {
    readonly log: { (): string; insert(index: number, text: string): void }
  }
  const append = (doc: LogDoc, text: string): void =>
    doc.log.insert(doc.log().length, text)

  const runtimes: Runtime[] = []
  afterEach(async () => {
    vi.useRealTimers()
    for (const runtime of runtimes) await runtime.shutdown()
    runtimes.length = 0
  })

  function open(sharedData: InMemoryStoreData): Runtime {
    const runtime = new Runtime({
      store: createInMemoryStore({ sharedData }),
      tickInterval: 0,
    })
    runtimes.push(runtime)
    return runtime
  }

  const yjsLog = yjs.bind(LogSchema)
  const loroLog = loro.bind(LogSchema)
  const plainLog = json.bind(LogSchema)
  const BACKENDS: readonly {
    readonly name: string
    readonly get: (runtime: Runtime) => LogDoc
  }[] = [
    { name: "yjs", get: r => r.get("doc", yjsLog) },
    { name: "loro", get: r => r.get("doc", loroLog) },
    { name: "plain", get: r => r.get("doc", plainLog) },
  ]

  for (const { name, get } of BACKENDS) {
    it(`a compaction by one keeps what another wrote (${name})`, async () => {
      // The reproduction: compaction used to delete every record, including
      // another instance's it had never read.
      const sharedData = createInMemoryStoreData()
      const a = open(sharedData)
      const docA = get(a)
      await whenHydrated(docA)
      append(docA, "a")
      await a.flush()

      const b = open(sharedData)
      const docB = get(b)
      await whenHydrated(docB)
      append(docB, "b")
      await b.flush()

      await a.compact("doc")

      const c = open(sharedData)
      const docC = get(c)
      await whenHydrated(docC)
      expect(docC.log()).toBe("ab")
    })
  }

  it("a compaction that cannot take everything in appends instead", async () => {
    const sharedData = createInMemoryStoreData()
    const a = open(sharedData)
    const doc = a.get("doc", plainLog) as LogDoc
    await whenHydrated(doc)
    append(doc, "a")
    await a.flush()
    // A record this replica cannot read.
    await createInMemoryStore({ sharedData }).append("doc", {
      kind: "entry",
      payload: { kind: "since", encoding: "json", data: "{}" },
      version: "not a version",
    })
    const before = recordsOf(sharedData, "doc")

    await a.compact("doc")

    const after = recordsOf(sharedData, "doc")
    expect(after.slice(0, before.length)).toEqual(before)
    expect(persistenceError(doc)).toBeUndefined()
  })

  it("a compaction keeps the live lineage over another instance's later one", async () => {
    // Another instance crossed first. The crossing is the network's to make,
    // with its policy and its report, not a compaction's.
    const sharedData = createInMemoryStoreData()
    const a = open(sharedData)
    vi.setSystemTime(1_000)
    const doc = a.get("doc", plainLog) as LogDoc
    await whenHydrated(doc)
    append(doc, "live")
    await a.flush()
    const lineage = version(doc).lineage

    vi.setSystemTime(2_000)
    const later = createDoc(plainLog) as LogDoc
    append(later, "later")
    await createInMemoryStore({ sharedData }).append("doc", {
      kind: "entry",
      payload: exportEntirety(later),
      version: version(later).serialize(),
    })
    const before = recordsOf(sharedData, "doc")

    await a.compact("doc")

    expect(version(doc).lineage).toBe(lineage)
    expect(doc.log()).toBe("live")
    expect(recordsOf(sharedData, "doc").slice(0, before.length)).toEqual(before)
  })

  it("a compaction from genesis takes in another instance's lineage", async () => {
    // Joining a lineage from genesis is not a crossing: a fresh replica does
    // it over the network by an ordinary merge.
    const sharedData = createInMemoryStoreData()
    const a = open(sharedData)
    const idle = a.get("doc", plainLog) as LogDoc
    await whenHydrated(idle)
    await a.flush()

    const b = open(sharedData)
    const writer = b.get("doc", plainLog) as LogDoc
    await whenHydrated(writer)
    append(writer, "b")
    await b.flush()
    const stored = recordsOf(sharedData, "doc").length

    await a.compact("doc")

    expect(idle.log()).toBe("b")
    expect(version(idle).lineage).toBe(version(writer).lineage)
    // Compacted: what it read is gone, and its whole document replaces it.
    expect(recordsOf(sharedData, "doc").length).toBeLessThan(stored)
  })

  it("a compaction of a document destroyed while reading merges and pushes nothing", async () => {
    const sharedData = createInMemoryStoreData()
    // The store deletes only once the compaction is over, so the compaction
    // reads what `b` stored even though its document is gone.
    let releaseDelete = (): void => {}
    const deleting = new Promise<void>(resolve => {
      releaseDelete = resolve
    })
    const inner = createInMemoryStore({ sharedData })
    const a = new Runtime({
      store: wrapStore(inner, {
        delete: async docId => {
          await deleting
          await inner.delete(docId)
        },
      }),
      tickInterval: 0,
    })
    runtimes.push(a)
    const advanced: string[] = []
    a.setHooks({ onDocAdvanced: docId => advanced.push(docId) })
    const idle = a.get("doc", plainLog) as LogDoc
    await whenHydrated(idle)
    await a.flush()

    // Stored after `a` loaded, so a compaction by `a` would take it in.
    const b = open(sharedData)
    const writer = b.get("doc", plainLog) as LogDoc
    await whenHydrated(writer)
    append(writer, "b")
    await b.flush()

    // The compaction reads the store asynchronously; the document is gone
    // before it has read anything.
    // `compact` resolves once the document is no longer written, which a
    // destroy makes true at once; the read it started finishes later.
    const compacting = a.compact("doc")
    a.destroy("doc")
    await compacting
    await sleep(20)
    releaseDelete()

    expect(advanced).toEqual([])
    expect(idle.log()).toBe("")
  })

  it("a compaction pushes what it took in from another instance to peers", async () => {
    // An instance that stored its writes and crashed before sending them
    // leaves them reachable only through the store.
    const sharedData = createInMemoryStoreData()
    const bridge = new Bridge()
    const server = createExchange({
      principal: "server",
      transports: [createBridgeTransport({ transportId: "server", bridge })],
      store: createInMemoryStore({ sharedData }),
    })
    const peer = createExchange({
      principal: "peer",
      transports: [createBridgeTransport({ transportId: "peer", bridge })],
    })
    const doc = server.get("doc", plainLog) as LogDoc
    const seen = peer.get("doc", plainLog) as LogDoc
    await whenHydrated(doc)
    append(doc, "a")
    await server.flush()
    await sleep(50)
    expect(seen.log()).toBe("a")

    const crashed = open(sharedData)
    const writer = crashed.get("doc", plainLog) as LogDoc
    await whenHydrated(writer)
    append(writer, "b")
    await crashed.flush()

    await server.compact("doc")
    await sleep(50)
    expect(seen.log()).toBe("ab")
  })
})
