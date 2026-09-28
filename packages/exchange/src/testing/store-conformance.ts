// store-conformance — reusable contract test suite for Store.
//
// Any conforming Store implementation must pass these tests.
// The suite covers: currentMeta, append, loadAll, mark, compact, delete,
// listDocIds, both JSON and binary payload round-trips, and the seats a
// store issues (declared by every backend through `seats`). Backends that opt
// in via `faultFactory` and `isolationFactory` get additional property-level
// tests (atomicity under fault injection at every step; storage-domain
// isolation across two stores sharing one physical resource).
//
// Usage:
//   import { describeStore, makeArmedFault } from "@kyneta/exchange/testing"
//   describeStore("MyBackend", () => MyBackend.open(), {
//     seats: { kind: "owned", storage: async () => ({ open, cleanup }) },
//     cleanup: async (b) => { ... },
//     faultFactory: async () => {
//       const { proxy, arm, fired } = makeArmedFault(backing, { write: 1 })
//       return { store: await MyBackend.open(proxy), injectFault: arm, fired, ... }
//     },
//     isolationFactory: async () => ({ ... }),
//   })

import { SYNC_AUTHORITATIVE, SYNC_COLLABORATIVE } from "@kyneta/schema"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { SeatLostError, WriterRefusedError } from "../store/seats.js"
import type {
  Store,
  StoreMeta,
  StoreRecord,
  WriteOptions,
} from "../store/store.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A write that only persists: it claims no document. */
export const UNAUTHORED: WriteOptions = { authored: false }

/** A write carrying the seat's own operations: it claims the document. */
export const AUTHORED: WriteOptions = { authored: true }

export const plainMeta: StoreMeta = {
  replicaType: ["plain", 2, 0] as const,
  syncMode: SYNC_AUTHORITATIVE,
  schemaHash: "00test",
}

export function makeMetaRecord(
  overrides?: Partial<StoreMeta>,
): StoreRecord & { kind: "meta" } {
  return { kind: "meta", meta: { ...plainMeta, ...overrides } }
}

export function makeEntryRecord(
  kind: "entirety" | "since",
  version: string,
): StoreRecord & { kind: "entry" } {
  return {
    kind: "entry",
    payload: { kind, encoding: "json", data: JSON.stringify({ v: version }) },
    version,
  }
}

/**
 * A stored whole-document entry for a plain document: `state` at log position
 * `at` on `lineage`, with the version a plain document would record for it.
 */
export function makePlainEntirety(
  state: Record<string, unknown>,
  lineage = "seed",
  at = 1,
): StoreRecord & { kind: "entry" } {
  return {
    kind: "entry",
    payload: {
      kind: "entirety",
      encoding: "json",
      data: JSON.stringify({ at, state }),
      lineage,
    },
    version: `${lineage}:${at}`,
  }
}

export function makeBinaryEntryRecord(
  kind: "entirety" | "since",
  version: string,
  bytes: Uint8Array,
): StoreRecord & { kind: "entry" } {
  return {
    kind: "entry",
    payload: { kind, encoding: "binary", data: bytes },
    version,
  }
}

export async function collectAll<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = []
  for await (const item of iter) {
    results.push(item)
  }
  return results
}

// ---------------------------------------------------------------------------
// Conformance suite
// ---------------------------------------------------------------------------

/**
 * A fault-injection harness for a single backend.
 *
 * `store` is the primary Store used by the test — it begins
 * non-faulting and is used to prime backing state. `injectFault(n)`
 * arms the harness so that the Nth subsequent call to the backend's
 * underlying write seam (adapter `exec` for sqlite, client `query`
 * for postgres, `$transaction` for prisma) throws, and `fired()` says
 * whether it has. The suite sweeps `n = 1, 2, …` until a write completes
 * without reaching the fault, so every step of it is covered.
 * `freshStore()` reads the same persistent state as `store` — used to
 * assert that no partial state leaked. For a backend whose seat is
 * `owned`, it may return `store` itself, since a second open is refused.
 */
export interface FaultInjection {
  readonly store: Store
  readonly injectFault: (n: number) => void
  readonly fired: () => boolean
  readonly freshStore: () => Promise<Store>
  readonly cleanup: () => Promise<void>
}

/** One storage, which the seat section opens stores over. */
export interface SeatStorage {
  /** Open a store over this storage, as another tab or process would. */
  readonly open: () => Promise<Store>
  /** Remove the storage, once the suite has closed every store it opened. */
  readonly cleanup: () => Promise<void>
}

/**
 * The kind of seat a backend issues, with a fresh storage per test. A pooled
 * backend also says how a holder dies without closing: `abandon` releases the
 * store's seat lock as the platform would, and leaves its writes able to
 * reach the storage.
 */
export type SeatDeclaration =
  | {
      readonly kind: "pooled"
      readonly storage: () => Promise<SeatStorage>
      readonly abandon: (store: Store) => Promise<void>
    }
  | { readonly kind: "owned"; readonly storage: () => Promise<SeatStorage> }
  | { readonly kind: "session"; readonly storage: () => Promise<SeatStorage> }

/** Two stores sharing a physical resource via distinct namespacing. */
export interface IsolationPair {
  readonly storeA: Store
  readonly storeB: Store
  readonly cleanup?: () => Promise<void>
}

/**
 * Options for the conformance suite.
 *
 * Every backend declares its `seats`. Backends supplying `faultFactory` get
 * the atomicity property test; backends supplying `isolationFactory` get the
 * storage-domain isolation test. Backends that opt out get those tests
 * skipped.
 */
export interface DescribeStoreOptions {
  seats: SeatDeclaration
  cleanup?: (backend: Store) => Promise<void>
  faultFactory?: () => Promise<FaultInjection>
  isolationFactory?: () => Promise<IsolationPair>
}

/**
 * Register the full Store contract test suite for a given backend.
 *
 * @param name - Display name for the describe block
 * @param factory - Creates a fresh backend instance per test
 * @param options - Optional teardown and opt-in property tests
 */
export function describeStore(
  name: string,
  factory: () => Store | Promise<Store>,
  options: DescribeStoreOptions,
): void {
  const { cleanup, faultFactory, isolationFactory, seats } = options
  describe(name, () => {
    let backend: Store

    beforeEach(async () => {
      backend = await factory()
    })

    afterEach(async () => {
      if (cleanup) await cleanup(backend)
      await backend.close()
    })

    // =======================================================================
    // 1. currentMeta returns null for nonexistent doc
    // =======================================================================

    it("currentMeta returns null for nonexistent doc", async () => {
      expect(await backend.currentMeta("nonexistent")).toBeNull()
    })

    // =======================================================================
    // 2. First append with kind: 'entry' (no prior meta) throws
    // =======================================================================

    it("append of entry without prior meta throws", async () => {
      await expect(
        backend.append("doc-1", makeEntryRecord("entirety", "1"), UNAUTHORED),
      ).rejects.toThrow()
    })

    // =======================================================================
    // 3. append of meta → currentMeta returns it; listDocIds includes it
    // =======================================================================

    it("append of meta → currentMeta returns it and listDocIds includes it", async () => {
      const metaRecord = makeMetaRecord()
      await backend.append("doc-1", metaRecord, UNAUTHORED)

      const meta = await backend.currentMeta("doc-1")
      expect(meta).toEqual(plainMeta)

      const docIds = await collectAll(backend.listDocIds())
      expect(docIds).toContain("doc-1")
    })

    // =======================================================================
    // 4. append of second meta with same replicaType/syncMode but
    //    different schemaHash → currentMeta reflects new hash (LWW)
    // =======================================================================

    it("append of second meta with different schemaHash is last-writer-wins", async () => {
      await backend.append("doc-1", makeMetaRecord(), UNAUTHORED)
      await backend.append(
        "doc-1",
        makeMetaRecord({ schemaHash: "00updated" }),
        UNAUTHORED,
      )

      const meta = await backend.currentMeta("doc-1")
      expect(meta).not.toBeNull()
      if (meta === null) return
      expect(meta.schemaHash).toBe("00updated")
      expect(meta.replicaType).toEqual(plainMeta.replicaType)
      expect(meta.syncMode).toEqual(plainMeta.syncMode)
    })

    // =======================================================================
    // 5. append of meta with mismatched replicaType or syncMode → throws
    // =======================================================================

    it("append of meta with mismatched replicaType throws", async () => {
      await backend.append("doc-1", makeMetaRecord(), UNAUTHORED)
      await expect(
        backend.append(
          "doc-1",
          makeMetaRecord({ replicaType: ["loro", 1, 0] as const }),
          UNAUTHORED,
        ),
      ).rejects.toThrow(/replicaType/)
    })

    it("append of meta with mismatched syncMode throws", async () => {
      await backend.append("doc-1", makeMetaRecord(), UNAUTHORED)
      await expect(
        backend.append(
          "doc-1",
          makeMetaRecord({ syncMode: SYNC_COLLABORATIVE }),
          UNAUTHORED,
        ),
      ).rejects.toThrow(/syncMode/)
    })

    // =======================================================================
    // 6. append + loadAll round-trip: records in insertion order,
    //    discriminated union preserved
    // =======================================================================

    it("append + loadAll round-trip: records in insertion order, union preserved", async () => {
      const meta = makeMetaRecord()
      const e1 = makeEntryRecord("entirety", "1")
      const e2 = makeEntryRecord("since", "2")
      const e3 = makeEntryRecord("since", "3")

      await backend.append("doc-1", meta, UNAUTHORED)
      await backend.append("doc-1", e1, UNAUTHORED)
      await backend.append("doc-1", e2, UNAUTHORED)
      await backend.append("doc-1", e3, UNAUTHORED)

      const records = await collectAll(backend.loadAll("doc-1"))
      expect(records).toHaveLength(4)
      expect(records[0]).toEqual(meta)
      expect(records[0]?.kind).toBe("meta")
      expect(records[1]).toEqual(e1)
      expect(records[1]?.kind).toBe("entry")
      expect(records[2]).toEqual(e2)
      expect(records[3]).toEqual(e3)
    })

    it("loadAll of nonexistent doc yields nothing (no crash)", async () => {
      const records = await collectAll(backend.loadAll("nonexistent"))
      expect(records).toHaveLength(0)
    })

    // =======================================================================
    // 7. mark and compact
    // =======================================================================

    it("mark is null for a document with no records, and grows with appends", async () => {
      expect(await backend.mark("doc-1")).toBeNull()
      await backend.append("doc-1", makeMetaRecord(), UNAUTHORED)
      const first = await backend.mark("doc-1")
      await backend.append("doc-1", makeEntryRecord("since", "1"), UNAUTHORED)
      const second = await backend.mark("doc-1")
      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      if (first === null || second === null) return
      expect(second).toBeGreaterThan(first)
    })

    it("compact swaps only what is at or before the mark", async () => {
      await backend.append("doc-1", makeMetaRecord(), UNAUTHORED)
      await backend.append("doc-1", makeEntryRecord("since", "1"), UNAUTHORED)
      await backend.append("doc-1", makeEntryRecord("since", "2"), UNAUTHORED)
      const through = await backend.mark("doc-1")
      // Appended after the mark: another writer's, which the compaction never
      // read.
      const later = makeEntryRecord("since", "3")
      await backend.append("doc-1", later, UNAUTHORED)

      const meta = makeMetaRecord()
      const collapsed = makeEntryRecord("entirety", "2")
      await backend.compact("doc-1", [meta, collapsed], through, UNAUTHORED)

      const records = await collectAll(backend.loadAll("doc-1"))
      expect(records).toEqual([later, meta, collapsed])
    })

    it("compact with no mark only appends", async () => {
      const first = makeMetaRecord()
      await backend.compact("doc-1", [first], null, UNAUTHORED)
      const meta = makeMetaRecord()
      const entry = makeEntryRecord("entirety", "1")
      await backend.compact("doc-1", [meta, entry], null, UNAUTHORED)

      const records = await collectAll(backend.loadAll("doc-1"))
      expect(records).toEqual([first, meta, entry])
      expect(await backend.currentMeta("doc-1")).toEqual(plainMeta)
    })

    it("compact without a meta record in the batch throws", async () => {
      await backend.append("doc-1", makeMetaRecord(), UNAUTHORED)
      await expect(
        backend.compact(
          "doc-1",
          [makeEntryRecord("entirety", "1")],
          await backend.mark("doc-1"),
          UNAUTHORED,
        ),
      ).rejects.toThrow()
    })

    it("compact updates materialized index from last meta in batch", async () => {
      await backend.append("doc-1", makeMetaRecord(), UNAUTHORED)

      const metaA = makeMetaRecord({ schemaHash: "hash-a" })
      const metaB = makeMetaRecord({ schemaHash: "hash-b" })
      const entry = makeEntryRecord("entirety", "1")

      await backend.compact(
        "doc-1",
        [metaA, entry, metaB],
        await backend.mark("doc-1"),
        UNAUTHORED,
      )

      const meta = await backend.currentMeta("doc-1")
      expect(meta).not.toBeNull()
      if (meta === null) return
      expect(meta.schemaHash).toBe("hash-b")
    })

    // =======================================================================
    // 10. delete removes stream and index; currentMeta returns null;
    //     listDocIds excludes it
    // =======================================================================

    it("delete removes stream and index", async () => {
      await backend.append("doc-1", makeMetaRecord(), UNAUTHORED)
      await backend.append(
        "doc-1",
        makeEntryRecord("entirety", "1"),
        UNAUTHORED,
      )
      await backend.append("doc-1", makeEntryRecord("since", "2"), UNAUTHORED)

      await backend.delete("doc-1")

      expect(await backend.currentMeta("doc-1")).toBeNull()
      const records = await collectAll(backend.loadAll("doc-1"))
      expect(records).toHaveLength(0)
      const docIds = await collectAll(backend.listDocIds())
      expect(docIds).not.toContain("doc-1")
    })

    // =======================================================================
    // 11. listDocIds(prefix) filters correctly
    // =======================================================================

    it("listDocIds(prefix) filters correctly", async () => {
      await backend.append("users/alice", makeMetaRecord(), UNAUTHORED)
      await backend.append("users/bob", makeMetaRecord(), UNAUTHORED)
      await backend.append("posts/first", makeMetaRecord(), UNAUTHORED)

      const userDocs = await collectAll(backend.listDocIds("users/"))
      expect(userDocs.sort()).toEqual(["users/alice", "users/bob"])

      const postDocs = await collectAll(backend.listDocIds("posts/"))
      expect(postDocs).toEqual(["posts/first"])

      const allDocs = await collectAll(backend.listDocIds())
      expect(allDocs.sort()).toEqual([
        "posts/first",
        "users/alice",
        "users/bob",
      ])
    })

    it("listDocIds(prefix) is exactly the ids starting with prefix", async () => {
      // Each id guards against a way a store has got this wrong: `%` and `_`
      // read as LIKE wildcards, case ignored (SQLite's LIKE), a character
      // after the prefix above a hand-picked sentinel (LevelDB's "\xff",
      // which is C3 BF in UTF-8), an astral character, and a sibling that
      // sorts just past the prefix.
      const ids = [
        "users/alice",
        "Users/Bob",
        "users/\u0101lice",
        "users/\u65e5\u672c",
        "users/\u{1f600}",
        "users0",
        "100%_done",
        "100_other",
        "100xyz",
      ]
      for (const id of ids)
        await backend.append(id, makeMetaRecord(), UNAUTHORED)

      for (const prefix of ["users/", "Users/", "100%", "100_", "users", ""]) {
        const listed = await collectAll(backend.listDocIds(prefix))
        expect(listed.sort(), `prefix ${JSON.stringify(prefix)}`).toEqual(
          ids.filter(id => id.startsWith(prefix)).sort(),
        )
      }
    })

    // =======================================================================
    // 12. append after compact produces correct ordering
    // =======================================================================

    it("append after compact produces correct ordering", async () => {
      await backend.append("doc-1", makeMetaRecord(), UNAUTHORED)
      await backend.append("doc-1", makeEntryRecord("since", "1"), UNAUTHORED)
      await backend.append("doc-1", makeEntryRecord("since", "2"), UNAUTHORED)

      // Compaction collapses to meta + one entry
      const snapshot = makeMetaRecord()
      const collapsed = makeEntryRecord("entirety", "3")
      await backend.compact(
        "doc-1",
        [snapshot, collapsed, makeEntryRecord("since", "3a")],
        await backend.mark("doc-1"),
        UNAUTHORED,
      )

      // An append after the compaction must not overwrite what it wrote, even
      // when it wrote more records than it deleted.
      const delta = makeEntryRecord("since", "4")
      await backend.append("doc-1", delta, UNAUTHORED)

      const records = await collectAll(backend.loadAll("doc-1"))
      expect(
        records.map(r => (r.kind === "entry" ? r.version : "meta")),
      ).toEqual(["meta", "3", "3a", "4"])
    })

    // =======================================================================
    // 13. Doc prefix isolation (overlapping doc ID prefixes don't leak)
    // =======================================================================

    it("docs with overlapping name prefixes are isolated", async () => {
      await backend.append("doc", makeMetaRecord(), UNAUTHORED)
      await backend.append("doc-extra", makeMetaRecord(), UNAUTHORED)
      await backend.append("doc2", makeMetaRecord(), UNAUTHORED)

      await backend.append("doc", makeEntryRecord("entirety", "a"), UNAUTHORED)
      await backend.append(
        "doc-extra",
        makeEntryRecord("entirety", "b"),
        UNAUTHORED,
      )
      await backend.append("doc2", makeEntryRecord("entirety", "c"), UNAUTHORED)

      // loadAll for "doc" must not include records from "doc-extra" or "doc2"
      const docRecords = await collectAll(backend.loadAll("doc"))
      const docEntries = docRecords.filter(r => r.kind === "entry")
      expect(docEntries).toHaveLength(1)
      expect(
        (docEntries[0] as { kind: "entry"; version: string }).version,
      ).toBe("a")

      const extraRecords = await collectAll(backend.loadAll("doc-extra"))
      const extraEntries = extraRecords.filter(r => r.kind === "entry")
      expect(extraEntries).toHaveLength(1)
      expect(
        (extraEntries[0] as { kind: "entry"; version: string }).version,
      ).toBe("b")
    })

    // =======================================================================
    // 14. Binary payload round-trip
    // =======================================================================

    it("append + loadAll round-trips binary (Uint8Array) payloads", async () => {
      await backend.append("doc-1", makeMetaRecord(), UNAUTHORED)

      const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd])
      const entry = makeBinaryEntryRecord("entirety", "bin-1", bytes)
      await backend.append("doc-1", entry, UNAUTHORED)

      const records = await collectAll(backend.loadAll("doc-1"))
      const entries = records.filter(r => r.kind === "entry")
      expect(entries).toHaveLength(1)

      const loaded = entries[0] as {
        kind: "entry"
        payload: { kind: string; encoding: string; data: unknown }
        version: string
      }
      expect(loaded.version).toBe("bin-1")
      expect(loaded.payload.kind).toBe("entirety")
      expect(loaded.payload.encoding).toBe("binary")
      expect(loaded.payload.data).toBeInstanceOf(Uint8Array)
      expect(loaded.payload.data).toEqual(bytes)
    })

    it("append + loadAll round-trips mixed JSON and binary entries", async () => {
      await backend.append("doc-1", makeMetaRecord(), UNAUTHORED)

      const jsonEntry = makeEntryRecord("entirety", "v1")
      const binaryEntry = makeBinaryEntryRecord(
        "since",
        "v2",
        new Uint8Array([10, 20, 30]),
      )

      await backend.append("doc-1", jsonEntry, UNAUTHORED)
      await backend.append("doc-1", binaryEntry, UNAUTHORED)

      const records = await collectAll(backend.loadAll("doc-1"))
      const entries = records.filter(r => r.kind === "entry")
      expect(entries).toHaveLength(2)

      const loadedJson = entries[0]
      const loadedBinary = entries[1]
      if (loadedJson?.kind !== "entry" || loadedBinary?.kind !== "entry") return

      expect(loadedJson.payload.encoding).toBe("json")
      expect(typeof loadedJson.payload.data).toBe("string")
      expect(loadedJson.version).toBe("v1")

      expect(loadedBinary.payload.encoding).toBe("binary")
      expect(loadedBinary.payload.data).toBeInstanceOf(Uint8Array)
      expect(loadedBinary.payload.data).toEqual(new Uint8Array([10, 20, 30]))
      expect(loadedBinary.version).toBe("v2")
    })

    // Sentinel: after an append succeeds, both writes are observable
    // together. Mostly subsumed by test 6's round-trip; kept as a
    // human-readable statement of the invariant. Backends that supply
    // `faultFactory` get the stronger property check below.

    it("atomic append — meta+record writes commit together", async () => {
      await backend.append("doc-1", makeMetaRecord(), UNAUTHORED)
      await backend.append(
        "doc-1",
        makeEntryRecord("entirety", "v1"),
        UNAUTHORED,
      )

      const meta = await backend.currentMeta("doc-1")
      expect(meta).toEqual(plainMeta)

      const records = await collectAll(backend.loadAll("doc-1"))
      expect(records).toHaveLength(2)
      expect(records[0]?.kind).toBe("meta")
      expect(records[1]?.kind).toBe("entry")
    })
  })

  // Property test: a write is atomic. A meta-record append performs two
  // writes (meta upsert + record insert), a compaction several; if they are
  // not atomic, a failure between them leaves partial state. Each backend
  // supplies the seam-counting harness. The suite fails each step in turn,
  // from the first until a write completes without reaching the fault, and
  // asserts the state after every failure.

  if (faultFactory !== undefined) {
    /**
     * Fail `write` at step 1, 2, … until it completes without reaching the
     * fault, checking `unchanged` after each failure.
     */
    async function sweep(
      fault: FaultInjection,
      write: () => Promise<void>,
      unchanged: () => Promise<void>,
    ): Promise<void> {
      for (let n = 1; n <= 1000; n++) {
        fault.injectFault(n)
        const failed = await write().then(
          () => false,
          () => true,
        )
        if (!fault.fired()) {
          expect(failed).toBe(false)
          return
        }
        expect(failed).toBe(true)
        await unchanged()
      }
      throw new Error("fault sweep: the write never completed")
    }

    /** Read `fault`'s storage through a fresh store. */
    async function readFresh(
      fault: FaultInjection,
      read: (store: Store) => Promise<void>,
    ): Promise<void> {
      const fresh = await fault.freshStore()
      try {
        await read(fresh)
      } finally {
        if (fresh !== fault.store) await fresh.close()
      }
    }

    describe(`${name} — fault-injected atomicity`, () => {
      it("a failure at any step of an append leaves no partial state", async () => {
        const fault = await faultFactory()
        try {
          const primer = makeMetaRecord({ schemaHash: "primer" })
          const injected = makeMetaRecord({ schemaHash: "injected" })
          await fault.store.append("doc-1", primer, UNAUTHORED)

          await sweep(
            fault,
            () => fault.store.append("doc-1", injected, UNAUTHORED),
            () =>
              readFresh(fault, async fresh => {
                expect((await fresh.currentMeta("doc-1"))?.schemaHash).toBe(
                  "primer",
                )
                expect(await collectAll(fresh.loadAll("doc-1"))).toEqual([
                  primer,
                ])
              }),
          )

          await readFresh(fault, async fresh => {
            expect((await fresh.currentMeta("doc-1"))?.schemaHash).toBe(
              "injected",
            )
            expect(await collectAll(fresh.loadAll("doc-1"))).toEqual([
              primer,
              injected,
            ])
          })
        } finally {
          await fault.cleanup()
        }
      })

      it("a failure at any step of a compaction leaves the records as they were", async () => {
        const fault = await faultFactory()
        try {
          const meta = makeMetaRecord({ schemaHash: "primer" })
          const entry = makeEntryRecord("since", "1")
          await fault.store.append("doc-1", meta, UNAUTHORED)
          await fault.store.append("doc-1", entry, UNAUTHORED)
          const through = await fault.store.mark("doc-1")
          const compacted = [
            makeMetaRecord({ schemaHash: "injected" }),
            makeEntryRecord("entirety", "2"),
          ]

          await sweep(
            fault,
            () => fault.store.compact("doc-1", compacted, through, UNAUTHORED),
            () =>
              readFresh(fault, async fresh => {
                expect((await fresh.currentMeta("doc-1"))?.schemaHash).toBe(
                  "primer",
                )
                expect(await collectAll(fresh.loadAll("doc-1"))).toEqual([
                  meta,
                  entry,
                ])
              }),
          )

          await readFresh(fault, async fresh => {
            expect(await collectAll(fresh.loadAll("doc-1"))).toEqual(compacted)
          })
        } finally {
          await fault.cleanup()
        }
      })
    })
  }

  // Seats. Every store issues the seat kind its backend declares. Stores
  // over one storage issue seats as that kind promises: pooled seats are
  // exclusive, reused and fenced; an owned seat is the storage's one seat and
  // a second open is refused; a session seat is fresh on every open.

  describe(`${name} — seats`, () => {
    /**
     * Run `test` with a fresh storage, then close every store it opened and
     * remove the storage. A store whose seat was abandoned may fail to close,
     * as a dead holder's would.
     */
    async function withStorage(
      test: (open: () => Promise<Store>) => Promise<void>,
    ): Promise<void> {
      const storage = await seats.storage()
      const opened: Store[] = []
      try {
        await test(async () => {
          const store = await storage.open()
          opened.push(store)
          return store
        })
      } finally {
        for (const store of opened) await store.close().catch(() => {})
        await storage.cleanup()
      }
    }

    it(`issues ${seats.kind} seats`, async () => {
      await withStorage(async open => {
        expect((await open()).seat.kind).toBe(seats.kind)
      })
    })

    it("a closed store refuses every operation", async () => {
      await withStorage(async open => {
        const store = await open()
        await store.append("doc-1", makeMetaRecord(), UNAUTHORED)
        await store.close()
        await expect(
          store.append("doc-1", makeMetaRecord(), UNAUTHORED),
        ).rejects.toThrow()
        await expect(collectAll(store.loadAll("doc-1"))).rejects.toThrow()
        await expect(store.mark("doc-1")).rejects.toThrow()
        await expect(
          store.compact("doc-1", [makeMetaRecord()], null, UNAUTHORED),
        ).rejects.toThrow()
        await expect(store.delete("doc-1")).rejects.toThrow()
        await expect(store.currentMeta("doc-1")).rejects.toThrow()
        await expect(store.writerOf("doc-1")).rejects.toThrow()
        await expect(collectAll(store.listDocIds())).rejects.toThrow()
      })
    })

    if (seats.kind !== "pooled") {
      it("records no writer, whether or not a write is authored", async () => {
        await withStorage(async open => {
          const store = await open()
          await store.append("doc-1", makeMetaRecord(), AUTHORED)
          await store.append("doc-1", makeEntryRecord("since", "1"), AUTHORED)
          await store.compact("doc-1", [makeMetaRecord()], null, AUTHORED)
          expect(await store.writerOf("doc-1")).toBeNull()
        })
      })
    }

    if (seats.kind === "owned") {
      it("a reopen holds the same seat", async () => {
        await withStorage(async open => {
          const first = await open()
          await first.close()
          const second = await open()
          expect(second.seat).toEqual(first.seat)
        })
      })

      it("a second open while the first holds the storage is refused", async () => {
        await withStorage(async open => {
          await open()
          await expect(open()).rejects.toThrow()
        })
      })
      return
    }

    if (seats.kind === "session") {
      it("every open issues a fresh seat", async () => {
        await withStorage(async open => {
          const first = await open()
          const second = await open()
          await first.close()
          const third = await open()
          const ids = [first, second, third].map(s => s.seat.peerId)
          expect(new Set(ids).size).toBe(3)
        })
      })
    }

    if (seats.kind === "pooled") {
      const { abandon } = seats

      it("two open stores hold different seats, and a closed seat is reused", async () => {
        await withStorage(async open => {
          const first = await open()
          const second = await open()
          expect(second.seat.peerId).not.toBe(first.seat.peerId)
          await first.close()
          const third = await open()
          expect(third.seat.peerId).toBe(first.seat.peerId)
        })
      })

      it("the pool never grows past the most stores open at once", async () => {
        await withStorage(async open => {
          const opening = async (): Promise<Store[]> => [
            await open(),
            await open(),
            await open(),
          ]
          const first = await opening()
          for (const store of first) await store.close()
          const second = await opening()
          const ids = (stores: Store[]) =>
            new Set(stores.map(store => store.seat.peerId))
          expect(ids(first).size).toBe(3)
          expect(ids(second)).toEqual(ids(first))
        })
      })

      it("a store whose seat was taken again cannot write, and changes nothing", async () => {
        await withStorage(async open => {
          const stale = await open()
          await stale.append("doc-1", makeMetaRecord(), UNAUTHORED)
          await stale.append("doc-1", makeEntryRecord("since", "1"), UNAUTHORED)
          const through = await stale.mark("doc-1")

          await abandon(stale)
          const next = await open()
          expect(next.seat.peerId).toBe(stale.seat.peerId)
          const before = await collectAll(next.loadAll("doc-1"))

          await expect(
            stale.append("doc-1", makeEntryRecord("since", "2"), UNAUTHORED),
          ).rejects.toBeInstanceOf(SeatLostError)
          await expect(
            stale.compact(
              "doc-1",
              [makeMetaRecord(), makeEntryRecord("entirety", "2")],
              through,
              UNAUTHORED,
            ),
          ).rejects.toBeInstanceOf(SeatLostError)
          await expect(stale.delete("doc-1")).rejects.toBeInstanceOf(
            SeatLostError,
          )

          expect(await collectAll(next.loadAll("doc-1"))).toEqual(before)
          expect(await next.currentMeta("doc-1")).toEqual(plainMeta)
        })
      })
    }

    // Of the seats sharing a pooled storage, at most one authors each
    // serialized document, and the storage records which one.
    if (seats.kind === "pooled") {
      const { abandon } = seats

      /** `store`'s write of `docId`'s first records, authored or not. */
      const seed = async (store: Store, options = AUTHORED): Promise<void> => {
        await store.append("doc-1", makeMetaRecord(), options)
        await store.append("doc-1", makeEntryRecord("since", "1"), options)
      }

      it("an authored write claims the document for its seat", async () => {
        await withStorage(async open => {
          const writer = await open()
          const other = await open()
          expect(await other.writerOf("doc-1")).toBeNull()
          await seed(writer)
          expect(await writer.writerOf("doc-1")).toBe(writer.seat.peerId)
          expect(await other.writerOf("doc-1")).toBe(writer.seat.peerId)
        })
      })

      it("another seat's authored writes are refused and change nothing", async () => {
        await withStorage(async open => {
          const writer = await open()
          const other = await open()
          await seed(writer)
          const before = await collectAll(writer.loadAll("doc-1"))

          const refusal = await other
            .append("doc-1", makeEntryRecord("since", "2"), AUTHORED)
            .then(
              () => undefined,
              (error: unknown) => error,
            )
          expect(refusal).toBeInstanceOf(WriterRefusedError)
          expect((refusal as WriterRefusedError).writer).toBe(
            writer.seat.peerId,
          )
          await expect(
            other.compact(
              "doc-1",
              [makeMetaRecord(), makeEntryRecord("entirety", "2")],
              await other.mark("doc-1"),
              AUTHORED,
            ),
          ).rejects.toBeInstanceOf(WriterRefusedError)

          expect(await collectAll(writer.loadAll("doc-1"))).toEqual(before)
          expect(await writer.writerOf("doc-1")).toBe(writer.seat.peerId)
        })
      })

      it("another seat's unauthored writes succeed and keep the claim", async () => {
        await withStorage(async open => {
          const writer = await open()
          const other = await open()
          await seed(writer)
          await other.append("doc-1", makeEntryRecord("since", "2"), UNAUTHORED)
          await other.compact(
            "doc-1",
            [makeMetaRecord(), makeEntryRecord("entirety", "2")],
            await other.mark("doc-1"),
            UNAUTHORED,
          )
          expect(await writer.writerOf("doc-1")).toBe(writer.seat.peerId)
          await writer.append("doc-1", makeEntryRecord("since", "3"), AUTHORED)
        })
      })

      it("another seat cannot delete a claimed document; its writer can, which clears the claim", async () => {
        await withStorage(async open => {
          const writer = await open()
          const other = await open()
          await seed(writer)
          await expect(other.delete("doc-1")).rejects.toBeInstanceOf(
            WriterRefusedError,
          )
          expect(await writer.currentMeta("doc-1")).toEqual(plainMeta)

          await writer.delete("doc-1")
          expect(await other.writerOf("doc-1")).toBeNull()
          await seed(other)
          expect(await writer.writerOf("doc-1")).toBe(other.seat.peerId)
        })
      })

      it("any seat can delete a document nobody claimed", async () => {
        await withStorage(async open => {
          const first = await open()
          const other = await open()
          await seed(first, UNAUTHORED)
          await other.delete("doc-1")
          expect(await first.currentMeta("doc-1")).toBeNull()
        })
      })

      it("the writer seat, taken again after its holder died, may author", async () => {
        await withStorage(async open => {
          const writer = await open()
          await seed(writer)
          await abandon(writer)

          const next = await open()
          expect(next.seat.peerId).toBe(writer.seat.peerId)
          expect(next.seat).toMatchObject({ kind: "pooled" })
          if (next.seat.kind !== "pooled" || writer.seat.kind !== "pooled") {
            return
          }
          expect(next.seat.fence).toBeGreaterThan(writer.seat.fence)
          await next.append("doc-1", makeEntryRecord("since", "2"), AUTHORED)
          expect(await next.writerOf("doc-1")).toBe(next.seat.peerId)
        })
      })
    }

    // Several stores open one storage: two tabs over one IndexedDB database,
    // several processes over one Postgres schema. Each must append safely,
    // and a compaction by one must not lose what another wrote.

    const versions = (records: StoreRecord[]): string[] =>
      records.flatMap(r => (r.kind === "entry" ? [r.version] : []))

    it("appends from two stores, interleaved, all load", async () => {
      await withStorage(async open => {
        const first = await open()
        const second = await open()
        await first.append("doc-1", makeMetaRecord(), UNAUTHORED)
        await Promise.all(
          Array.from({ length: 10 }, (_, i) => [
            first.append(
              "doc-1",
              makeEntryRecord("since", `a${i}`),
              UNAUTHORED,
            ),
            second.append(
              "doc-1",
              makeEntryRecord("since", `b${i}`),
              UNAUTHORED,
            ),
          ]).flat(),
        )
        for (const store of [first, second]) {
          const loaded = versions(await collectAll(store.loadAll("doc-1")))
          expect(loaded.sort()).toEqual(
            [
              ...Array.from({ length: 10 }, (_, i) => `a${i}`),
              ...Array.from({ length: 10 }, (_, i) => `b${i}`),
            ].sort(),
          )
        }
      })
    })

    it("a compaction by one keeps what the other appended after its mark", async () => {
      await withStorage(async open => {
        const first = await open()
        const second = await open()
        await first.append("doc-1", makeMetaRecord(), UNAUTHORED)
        await first.append("doc-1", makeEntryRecord("since", "1"), UNAUTHORED)
        const through = await first.mark("doc-1")
        await second.append(
          "doc-1",
          makeEntryRecord("since", "theirs"),
          UNAUTHORED,
        )

        await first.compact(
          "doc-1",
          [makeMetaRecord(), makeEntryRecord("entirety", "whole")],
          through,
          UNAUTHORED,
        )

        const loaded = versions(await collectAll(second.loadAll("doc-1")))
        expect(loaded.sort()).toEqual(["theirs", "whole"])
      })
    })

    it("two compactions through one mark lose nothing either wrote", async () => {
      await withStorage(async open => {
        const first = await open()
        const second = await open()
        await first.append("doc-1", makeMetaRecord(), UNAUTHORED)
        await first.append("doc-1", makeEntryRecord("since", "1"), UNAUTHORED)
        const through = await first.mark("doc-1")

        await first.compact(
          "doc-1",
          [makeMetaRecord(), makeEntryRecord("entirety", "first")],
          through,
          UNAUTHORED,
        )
        await second.compact(
          "doc-1",
          [makeMetaRecord(), makeEntryRecord("entirety", "second")],
          through,
          UNAUTHORED,
        )

        const loaded = versions(await collectAll(first.loadAll("doc-1")))
        expect(loaded.sort()).toEqual(["first", "second"])
      })
    })
  })

  // Two stores backed by the same physical resource (same DB file,
  // same Pool, same PrismaClient) but namespaced differently must not
  // leak writes across the boundary. Distinct from test 13's
  // doc-prefix isolation, which covers overlap inside one store.

  if (isolationFactory !== undefined) {
    describe(`${name} — storage-domain isolation`, () => {
      it("writes in one namespace are not visible in the other", async () => {
        const pair = await isolationFactory()
        try {
          await pair.storeA.append("doc-1", makeMetaRecord(), UNAUTHORED)
          await pair.storeA.append(
            "doc-1",
            makeEntryRecord("entirety", "from-A"),
            UNAUTHORED,
          )

          await pair.storeB.append("doc-1", makeMetaRecord(), UNAUTHORED)
          await pair.storeB.append(
            "doc-1",
            makeEntryRecord("entirety", "from-B"),
            UNAUTHORED,
          )

          const recordsA = await collectAll(pair.storeA.loadAll("doc-1"))
          const entriesA = recordsA.filter(r => r.kind === "entry")
          expect(entriesA).toHaveLength(1)
          expect(
            (entriesA[0] as { kind: "entry"; version: string }).version,
          ).toBe("from-A")

          const recordsB = await collectAll(pair.storeB.loadAll("doc-1"))
          const entriesB = recordsB.filter(r => r.kind === "entry")
          expect(entriesB).toHaveLength(1)
          expect(
            (entriesB[0] as { kind: "entry"; version: string }).version,
          ).toBe("from-B")

          // Doc-id list must reflect each namespace independently.
          const idsA = await collectAll(pair.storeA.listDocIds())
          const idsB = await collectAll(pair.storeB.listDocIds())
          expect(idsA).toContain("doc-1")
          expect(idsB).toContain("doc-1")
        } finally {
          // Stores may share a connection (one adapter, one Pool); the
          // pair's cleanup closes the shared resource once. Calling
          // store.close() on each would double-close.
          await pair.cleanup?.()
        }
      })
    })
  }
}
