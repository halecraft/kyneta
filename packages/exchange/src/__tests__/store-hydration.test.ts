// storage-hydration — Exchange-level storage hydration tests.
//
// These tests validate that the Exchange hydrates documents from
// Store on get()/replicate(), persists network imports
// via onDocImported, and persists local changes via changefeed.

import { Bridge, createBridgeTransport } from "@kyneta/bridge-transport"
import { loro } from "@kyneta/loro-schema"
import {
  type BoundSchema,
  batch,
  decodePlainPayload,
  json,
  plainReplicaFactory,
  populated,
  Replicate,
  Schema,
  type SubstratePayload,
  SYNC_AUTHORITATIVE,
} from "@kyneta/schema"
import { yjs } from "@kyneta/yjs-schema"
import { describe, expect, it } from "vitest"
import {
  Exchange,
  type ExchangeParams,
  type PeerIdentityInput,
} from "../exchange.js"
import { Runtime } from "../runtime.js"
import { whenHydrated } from "../settle.js"
import {
  createInMemoryStore,
  createInMemoryStoreData,
  InMemoryStore,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"
import type { Store, StoreRecord } from "../store/store.js"
import {
  collectAll,
  makeMetaRecord,
  makePlainEntirety,
} from "../testing/store-conformance.js"
import { seedStoredDoc } from "./stored-doc.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** The document a plain whole-document payload carries. */
function plainState(payload: SubstratePayload): Record<string, unknown> {
  const decoded = decodePlainPayload(payload, "test")
  if (decoded.kind !== "entirety") throw new Error("expected an entirety")
  return decoded.state
}

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
  it("refuses to load records written in an incompatible replica format", async () => {
    // A plain store from before payloads carried their log position holds
    // `["plain", 1, 0]` records. Reading them as today's format would
    // misparse them, so the load fails rather than presenting an empty doc.
    const sharedData: InMemoryStoreData = createInMemoryStoreData()
    const seedBackend = new InMemoryStore(sharedData)
    await seedBackend.append(
      "doc-1",
      makeMetaRecord({ replicaType: ["plain", 1, 0] }),
    )
    await seedBackend.append("doc-1", makePlainEntirety({ title: "old" }))

    const exchange = createExchange({
      id: "peer-1",
      store: createInMemoryStore({ sharedData }),
    })
    const doc = exchange.get("doc-1", TestDoc)

    await expect(whenHydrated(doc)).rejects.toThrow("cannot be read")
    await exchange.shutdown()
  })

  it("exchange.get() hydrates from storage", async () => {
    // Pre-populate storage with a document (meta + entry)
    const sharedData: InMemoryStoreData = createInMemoryStoreData()
    const seedBackend = new InMemoryStore(sharedData)
    await seedBackend.append("doc-1", makeMetaRecord())
    await seedBackend.append(
      "doc-1",
      makePlainEntirety({ title: "stored", count: 42 }),
    )

    const exchange = createExchange({
      id: "peer-1",
      store: createInMemoryStore({ sharedData }),
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
      store: createInMemoryStore(),
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
    const sharedData: InMemoryStoreData = createInMemoryStoreData()
    const seedBackend = new InMemoryStore(sharedData)
    await seedBackend.append("doc-1", makeMetaRecord())
    await seedBackend.append(
      "doc-1",
      makePlainEntirety({ title: "replicated", count: 7 }),
    )

    const exchange = createExchange({
      id: "peer-1",
      store: createInMemoryStore({ sharedData }),
    })

    exchange.replicate(
      "doc-1",
      plainReplicaFactory,
      SYNC_AUTHORITATIVE,
      "00test",
    )

    // Wait for hydration
    await exchange.flush()

    // The registered document should have the hydrated version
    const doc = exchange.synchronizer.getDoc("doc-1")
    expect(doc).toBeDefined()
    // Version should be > "0" after hydration
    const version = doc?.replica.version().serialize()
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
      store: backend,
    })

    const doc = exchange.get("doc-1", TestDoc)
    await exchange.flush() // wait for hydration

    // Mutate locally
    batch(doc, d => {
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
    // Exactly one entirety (first boot) + one delta (the mutation) — NOT
    // one delta per touched field.
    //
    // The mutation reaches the store program twice — from the Exchange's
    // state-advanced listener and from the Runtime's own changeset
    // subscription. The second request arrives while the first write is in
    // flight, becomes the write owed after it, and that write finds nothing
    // past the version just confirmed, so it touches no store.
    expect(entries).toHaveLength(2)

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
    const state = plainState(replica.exportEntirety())
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
      transports: [createBridgeTransport({ transportId: "side-a", bridge })],
    })
    const docA = exchangeA.get("doc-1", TestDoc)
    batch(docA, d => {
      d.title.set("from A")
      d.count.set(1)
    })

    // Exchange B (sink) — has storage, discovers doc from A
    const exchangeB = createExchange({
      id: "peer-b",
      transports: [createBridgeTransport({ transportId: "side-b", bridge })],
      store: backend,
      resolve: () => Replicate(),
    })

    // Wait for sync
    await drain(200)
    await exchangeB.flush()

    // B hydrated empty, so its first write is the empty document, and the
    // import lands while that write is in flight. The import is owed behind
    // it and written as a delta from it. This test used to expect one entry,
    // and got it because the import was dropped: a request arriving during
    // the first write was discarded and nothing offered it again, so a
    // restart found the document empty.
    const records = await collectAll(backend.loadAll("doc-1"))
    const entries = records.filter(
      (r): r is StoreRecord & { kind: "entry" } => r.kind === "entry",
    )
    expect(entries.map(e => e.payload.kind)).toEqual(["entirety", "since"])

    const replica = plainReplicaFactory.createEmpty()
    for (const entry of entries) replica.merge(entry.payload)
    expect(plainState(replica.exportEntirety())).toEqual({
      title: "from A",
      count: 1,
    })

    await exchangeA.shutdown()
    await exchangeB.shutdown()
  })

  it("destroy() deletes from storage", async () => {
    const backend = new InMemoryStore()

    const exchange = createExchange({
      id: "test",
      store: backend,
    })

    const doc = exchange.get("doc-1", TestDoc)
    await exchange.flush()

    batch(doc, d => d.title.set("will be deleted"))
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
      store: backend,
    })

    exchange.get("doc-1", TestDoc)
    // Flush should not throw and should complete all pending ops
    await exchange.flush()

    // After flush, a meta record should have been appended
    expect(await backend.currentMeta("doc-1")).toEqual({
      replicaType: ["plain", 2, 0],
      syncMode: SYNC_AUTHORITATIVE,
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
    const sharedData: InMemoryStoreData = createInMemoryStoreData()

    // First exchange: create doc, write data, shut down
    const exchange1 = createExchange({
      id: "peer-1",
      store: createInMemoryStore({ sharedData }),
    })

    const doc1 = exchange1.get("doc-1", TestDoc)
    await exchange1.flush() // hydration

    batch(doc1, d => {
      d.title.set("persisted title")
      d.count.set(777)
    })
    await exchange1.shutdown()

    // Second exchange: should hydrate from storage
    const exchange2 = createExchange({
      id: "peer-1",
      store: createInMemoryStore({ sharedData }),
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
      store: createInMemoryStore(),
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
      store: createInMemoryStore(),
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

    const sharedData: InMemoryStoreData = createInMemoryStoreData()

    // First exchange: create doc, write data, shut down
    const exchange1 = createExchange({
      id: "peer-1",
      store: createInMemoryStore({ sharedData }),
      schemas: [YjsDoc],
    })

    const doc1 = exchange1.get("doc-1", YjsDoc)
    await exchange1.flush() // hydration

    batch(doc1, (d: any) => {
      d.title.insert(0, "Yjs persisted")
      d.count.set(123)
    })

    await exchange1.flush() // persist
    await exchange1.shutdown()

    // Second exchange: should hydrate from storage
    const exchange2 = createExchange({
      id: "peer-1",
      store: createInMemoryStore({ sharedData }),
      schemas: [YjsDoc],
    })

    const doc2 = exchange2.get("doc-1", YjsDoc)
    await exchange2.flush() // hydration

    expect(doc2.title()).toBe("Yjs persisted")
    expect(doc2.count()).toBe(123)

    await exchange2.shutdown()
  })
})

// ===========================================================================
// populated through hydration
//
// `populated` is the *content* half of document readiness ("does this doc
// hold data?"). For it to serve as an initialization gate ("is this doc
// empty, so I may write defaults?"), hydration replays must mark paths
// populated — otherwise a restarted authoritative peer would read `false`
// against a full store and overwrite it with defaults.
//
// The three tests below pin the three distinguishable states, and in
// particular the middle one: while hydration is still in flight,
// `populated` reads `false` even though the store holds data. It is
// therefore only meaningful *behind a settle gate*, never on its own.
// ===========================================================================

describe("populated through storage hydration", () => {
  it("marks the doc populated from a hydration replay alone", async () => {
    const sharedData = await seedStoredDoc({ title: "stored", count: 42 })
    const exchange = createExchange({
      id: "peer-1",
      store: createInMemoryStore({ sharedData }),
    })

    const doc = exchange.get("doc-1", TestDoc)
    // `whenHydrated` is the storage gate. `flush()` also happens to await
    // hydration, but it is named for draining pending *writes* — using it here
    // would test the coincidence rather than the contract.
    await whenHydrated(doc)

    // No local write has occurred — population comes purely from replay.
    expect(populated(doc)).toBe(true)
    expect(populated(doc.title)).toBe(true)
    expect(populated(doc.count)).toBe(true)

    await exchange.shutdown()
  })

  it("reads false while hydration is pending, though the store has data", async () => {
    const sharedData = await seedStoredDoc({ title: "stored", count: 42 })
    const exchange = createExchange({
      id: "peer-1",
      store: createInMemoryStore({ sharedData }),
    })

    const doc = exchange.get("doc-1", TestDoc)

    // Hydration is async. The store holds data, but nothing has replayed yet,
    // so `populated` is indistinguishable from a genuinely empty document.
    // Seeding defaults *here* would clobber the stored state — which is why
    // an empty verdict is only trustworthy behind a settle gate.
    expect(populated(doc)).toBe(false)
    expect(doc.title()).toBe("")

    await whenHydrated(doc)

    expect(populated(doc)).toBe(true)
    expect(doc.title()).toBe("stored")

    await exchange.shutdown()
  })

  it("stays false after hydration settles with nothing stored", async () => {
    const exchange = createExchange({
      id: "peer-1",
      store: createInMemoryStore(),
    })

    const doc = exchange.get("doc-1", TestDoc)
    await whenHydrated(doc) // settles with nothing to replay

    // The genuine "empty" verdict — the only state an initializer may act on.
    expect(populated(doc)).toBe(false)

    await exchange.shutdown()
  })
})

// ---------------------------------------------------------------------------
// The store's baseline is what the store holds
// ---------------------------------------------------------------------------

const BaselineSchema = Schema.struct({
  a: Schema.string(),
  b: Schema.string(),
  items: Schema.list(Schema.string()),
})
const baselineBindings = [
  ["plain", json.bind(BaselineSchema)],
  ["yjs", yjs.bind(BaselineSchema)],
  ["loro", loro.bind(BaselineSchema)],
] as const

/** Run one session on `store`: load `docId`, run `work`, persist, shut down. */
async function session(
  store: Store,
  bound: BoundSchema,
  work: (doc: any, runtime: Runtime) => unknown = () => {},
): Promise<{ doc: any; version: string }> {
  const runtime = new Runtime({ peerId: "alice", store })
  const doc: any = runtime.createInterpretDoc("doc", bound)
  await whenHydrated(doc)
  await work(doc, runtime)
  await runtime.flush()
  const entry = runtime.getEntry("doc") as { readyInfo: { replica: any } }
  const version = entry.readyInfo.replica.version().serialize()
  await runtime.shutdown()
  return { doc, version }
}

async function entryVersions(store: Store): Promise<string[]> {
  const versions: string[] = []
  for await (const record of store.loadAll("doc")) {
    if (record.kind === "entry") versions.push(record.version)
  }
  return versions
}

describe("writes made while a document loads", () => {
  it.each([
    ["yjs", yjs.bind(BaselineSchema)],
    ["loro", loro.bind(BaselineSchema)],
  ] as const)("are persisted (%s)", async (_name, bound) => {
    const store = createInMemoryStore()
    await session(store, bound, doc =>
      batch(doc, (d: any) => d.a.set("stored")),
    )

    // Written while the second session is still loading.
    const runtime = new Runtime({ peerId: "alice", store })
    const doc: any = runtime.createInterpretDoc("doc", bound)
    batch(doc, (d: any) => d.b.set("during-load"))
    await runtime.flush()
    await runtime.shutdown()

    const { doc: reloaded } = await session(store, bound)
    expect(reloaded.a()).toBe("stored")
    expect(reloaded.b()).toBe("during-load")
  })
})

describe("a load with nothing new writes nothing", () => {
  for (const [name, bound] of baselineBindings) {
    for (const compacted of [false, true]) {
      it(`${name}${compacted ? ", after a compaction" : ""}`, async () => {
        const store = createInMemoryStore()
        await session(store, bound, async (doc, runtime) => {
          batch(doc, (d: any) => {
            d.a.set("x")
            d.items.push("1")
            d.items.push("2")
          })
          await runtime.flush()
          batch(doc, (d: any) => d.items.delete(0, 1))
          if (compacted) {
            await runtime.flush()
            await runtime.compact("doc")
            batch(doc, (d: any) => d.items.push("3"))
          }
        })
        const stored = await entryVersions(store)

        // The reloaded replica stands exactly where the store does, so the
        // write owed on load has nothing to append.
        const { doc, version } = await session(store, bound)
        expect(version).toBe(stored.at(-1))
        expect(await entryVersions(store)).toEqual(stored)
        expect(doc.items()).toEqual(compacted ? ["2", "3"] : ["2"])
      })
    }
  }
})

describe("plain: reload, write, reload", () => {
  it("stores no delta twice", async () => {
    const bound = json.bind(BaselineSchema)
    const store = createInMemoryStore()
    await session(store, bound, async (doc, runtime) => {
      batch(doc, (d: any) => {
        d.items.push("1")
        d.items.push("2")
        d.items.push("3")
      })
      await runtime.flush()
      batch(doc, (d: any) => d.items.delete(0, 1))
    })
    await session(store, bound, doc => batch(doc, (d: any) => d.a.set("y")))

    // A repeated delete would remove a second item on this load.
    const { doc } = await session(store, bound)
    expect(doc.items()).toEqual(["2", "3"])
    expect(doc.a()).toBe("y")
  })
})
