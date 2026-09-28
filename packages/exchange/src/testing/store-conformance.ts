// store-conformance — reusable contract test suite for Store.
//
// Any conforming Store implementation must pass these tests.
// The suite covers: currentMeta, append, loadAll, mark, compact, delete,
// listDocIds, and both JSON and binary payload round-trips. Backends
// that opt in via `faultFactory`, `isolationFactory` and `secondInstance`
// get additional property-level tests (atomicity under fault injection;
// storage-domain isolation across two stores sharing one physical resource;
// two instances opening one storage).
//
// Usage:
//   import { describeStore, makeArmedFault } from "@kyneta/exchange/testing"
//   describeStore("MyBackend", () => new MyBackend(), {
//     cleanup: async (b) => { ... },
//     faultFactory: async () => {
//       const { proxy, arm } = makeArmedFault(backing, { write: 1 })
//       return { store: new MyBackend(proxy), injectFault: arm, ... }
//     },
//     isolationFactory: async () => ({ ... }),
//   })

import { SYNC_AUTHORITATIVE, SYNC_COLLABORATIVE } from "@kyneta/schema"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Store, StoreMeta, StoreRecord } from "../store/store.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
 * for postgres, `$transaction` for prisma) throws. `freshStore()`
 * opens a separate non-faulting Store reading the same persistent
 * state — used to assert that no partial state leaked.
 */
export interface FaultInjection {
  readonly store: Store
  readonly injectFault: (n: number) => void
  readonly freshStore: () => Promise<Store>
  readonly cleanup: () => Promise<void>
}

/**
 * A first instance over a storage, and a way to open a second over the same
 * one, as a second tab or process would.
 */
export interface TwoInstances {
  readonly first: Store
  readonly openSecond: () => Promise<Store>
  readonly cleanup: () => Promise<void>
}

/** Two stores sharing a physical resource via distinct namespacing. */
export interface IsolationPair {
  readonly storeA: Store
  readonly storeB: Store
  readonly cleanup?: () => Promise<void>
}

/**
 * Options for the conformance suite.
 *
 * Backends supplying `faultFactory` get the atomicity property test;
 * backends supplying `isolationFactory` get the storage-domain
 * isolation test. Backends that opt out get those tests skipped.
 */
export interface DescribeStoreOptions {
  cleanup?: (backend: Store) => Promise<void>
  faultFactory?: () => Promise<FaultInjection>
  isolationFactory?: () => Promise<IsolationPair>
  /**
   * Two instances over one storage. With `refused`, the backend refuses the
   * second (LevelDB), and the suite asserts that its open fails instead of
   * running the multi-instance section.
   */
  secondInstance?: {
    readonly open: () => Promise<TwoInstances>
    readonly refused: boolean
  }
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
  options: DescribeStoreOptions = {},
): void {
  const { cleanup, faultFactory, isolationFactory, secondInstance } = options
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
        backend.append("doc-1", makeEntryRecord("entirety", "1")),
      ).rejects.toThrow()
    })

    // =======================================================================
    // 3. append of meta → currentMeta returns it; listDocIds includes it
    // =======================================================================

    it("append of meta → currentMeta returns it and listDocIds includes it", async () => {
      const metaRecord = makeMetaRecord()
      await backend.append("doc-1", metaRecord)

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
      await backend.append("doc-1", makeMetaRecord())
      await backend.append("doc-1", makeMetaRecord({ schemaHash: "00updated" }))

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
      await backend.append("doc-1", makeMetaRecord())
      await expect(
        backend.append(
          "doc-1",
          makeMetaRecord({ replicaType: ["loro", 1, 0] as const }),
        ),
      ).rejects.toThrow(/replicaType/)
    })

    it("append of meta with mismatched syncMode throws", async () => {
      await backend.append("doc-1", makeMetaRecord())
      await expect(
        backend.append(
          "doc-1",
          makeMetaRecord({ syncMode: SYNC_COLLABORATIVE }),
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

      await backend.append("doc-1", meta)
      await backend.append("doc-1", e1)
      await backend.append("doc-1", e2)
      await backend.append("doc-1", e3)

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
      await backend.append("doc-1", makeMetaRecord())
      const first = await backend.mark("doc-1")
      await backend.append("doc-1", makeEntryRecord("since", "1"))
      const second = await backend.mark("doc-1")
      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      if (first === null || second === null) return
      expect(second).toBeGreaterThan(first)
    })

    it("compact swaps only what is at or before the mark", async () => {
      await backend.append("doc-1", makeMetaRecord())
      await backend.append("doc-1", makeEntryRecord("since", "1"))
      await backend.append("doc-1", makeEntryRecord("since", "2"))
      const through = await backend.mark("doc-1")
      // Appended after the mark: another writer's, which the compaction never
      // read.
      const later = makeEntryRecord("since", "3")
      await backend.append("doc-1", later)

      const meta = makeMetaRecord()
      const collapsed = makeEntryRecord("entirety", "2")
      await backend.compact("doc-1", [meta, collapsed], through)

      const records = await collectAll(backend.loadAll("doc-1"))
      expect(records).toEqual([later, meta, collapsed])
    })

    it("compact with no mark only appends", async () => {
      const first = makeMetaRecord()
      await backend.compact("doc-1", [first], null)
      const meta = makeMetaRecord()
      const entry = makeEntryRecord("entirety", "1")
      await backend.compact("doc-1", [meta, entry], null)

      const records = await collectAll(backend.loadAll("doc-1"))
      expect(records).toEqual([first, meta, entry])
      expect(await backend.currentMeta("doc-1")).toEqual(plainMeta)
    })

    it("compact without a meta record in the batch throws", async () => {
      await backend.append("doc-1", makeMetaRecord())
      await expect(
        backend.compact(
          "doc-1",
          [makeEntryRecord("entirety", "1")],
          await backend.mark("doc-1"),
        ),
      ).rejects.toThrow()
    })

    it("compact updates materialized index from last meta in batch", async () => {
      await backend.append("doc-1", makeMetaRecord())

      const metaA = makeMetaRecord({ schemaHash: "hash-a" })
      const metaB = makeMetaRecord({ schemaHash: "hash-b" })
      const entry = makeEntryRecord("entirety", "1")

      await backend.compact(
        "doc-1",
        [metaA, entry, metaB],
        await backend.mark("doc-1"),
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
      await backend.append("doc-1", makeMetaRecord())
      await backend.append("doc-1", makeEntryRecord("entirety", "1"))
      await backend.append("doc-1", makeEntryRecord("since", "2"))

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
      await backend.append("users/alice", makeMetaRecord())
      await backend.append("users/bob", makeMetaRecord())
      await backend.append("posts/first", makeMetaRecord())

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
      for (const id of ids) await backend.append(id, makeMetaRecord())

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
      await backend.append("doc-1", makeMetaRecord())
      await backend.append("doc-1", makeEntryRecord("since", "1"))
      await backend.append("doc-1", makeEntryRecord("since", "2"))

      // Compaction collapses to meta + one entry
      const snapshot = makeMetaRecord()
      const collapsed = makeEntryRecord("entirety", "3")
      await backend.compact(
        "doc-1",
        [snapshot, collapsed, makeEntryRecord("since", "3a")],
        await backend.mark("doc-1"),
      )

      // An append after the compaction must not overwrite what it wrote, even
      // when it wrote more records than it deleted.
      const delta = makeEntryRecord("since", "4")
      await backend.append("doc-1", delta)

      const records = await collectAll(backend.loadAll("doc-1"))
      expect(
        records.map(r => (r.kind === "entry" ? r.version : "meta")),
      ).toEqual(["meta", "3", "3a", "4"])
    })

    // =======================================================================
    // 13. Doc prefix isolation (overlapping doc ID prefixes don't leak)
    // =======================================================================

    it("docs with overlapping name prefixes are isolated", async () => {
      await backend.append("doc", makeMetaRecord())
      await backend.append("doc-extra", makeMetaRecord())
      await backend.append("doc2", makeMetaRecord())

      await backend.append("doc", makeEntryRecord("entirety", "a"))
      await backend.append("doc-extra", makeEntryRecord("entirety", "b"))
      await backend.append("doc2", makeEntryRecord("entirety", "c"))

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
      await backend.append("doc-1", makeMetaRecord())

      const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd])
      const entry = makeBinaryEntryRecord("entirety", "bin-1", bytes)
      await backend.append("doc-1", entry)

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
      await backend.append("doc-1", makeMetaRecord())

      const jsonEntry = makeEntryRecord("entirety", "v1")
      const binaryEntry = makeBinaryEntryRecord(
        "since",
        "v2",
        new Uint8Array([10, 20, 30]),
      )

      await backend.append("doc-1", jsonEntry)
      await backend.append("doc-1", binaryEntry)

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
      await backend.append("doc-1", makeMetaRecord())
      await backend.append("doc-1", makeEntryRecord("entirety", "v1"))

      const meta = await backend.currentMeta("doc-1")
      expect(meta).toEqual(plainMeta)

      const records = await collectAll(backend.loadAll("doc-1"))
      expect(records).toHaveLength(2)
      expect(records[0]?.kind).toBe("meta")
      expect(records[1]?.kind).toBe("entry")
    })
  })

  // Property test: a meta-record append performs two writes (meta
  // upsert + record insert). If those aren't atomic, a mid-append
  // failure leaves the meta column updated with no corresponding row.
  // Each backend supplies the seam-counting harness; conformance only
  // asserts the post-failure state.

  if (faultFactory !== undefined) {
    describe(`${name} — fault-injected atomicity`, () => {
      it("a mid-append failure leaves no partial state observable", async () => {
        const fault = await faultFactory()
        try {
          await fault.store.append(
            "doc-1",
            makeMetaRecord({ schemaHash: "primer" }),
          )

          // Arming with n=2 targets the 2nd write of the next append.
          // For a meta record that's the record-insert step (1st was
          // the meta-upsert), so the throw fires after one write has
          // already happened — the case that catches non-atomic
          // implementations.
          fault.injectFault(2)

          await expect(
            fault.store.append(
              "doc-1",
              makeMetaRecord({ schemaHash: "injected" }),
            ),
          ).rejects.toThrow()

          // Verify on a fresh non-faulting store: state must be the
          // primer's, never the injected one.
          const fresh = await fault.freshStore()
          try {
            const meta = await fresh.currentMeta("doc-1")
            expect(meta?.schemaHash).toBe("primer")

            const records = await collectAll(fresh.loadAll("doc-1"))
            // Exactly one record (the primer's meta), no leaked second meta.
            expect(records).toHaveLength(1)
            expect(records[0]?.kind).toBe("meta")
            if (records[0]?.kind === "meta") {
              expect(records[0].meta.schemaHash).toBe("primer")
            }
          } finally {
            await fresh.close()
          }
        } finally {
          await fault.cleanup()
        }
      })

      it("a mid-compaction failure leaves the records as they were", async () => {
        const fault = await faultFactory()
        try {
          const meta = makeMetaRecord({ schemaHash: "primer" })
          const entry = makeEntryRecord("since", "1")
          await fault.store.append("doc-1", meta)
          await fault.store.append("doc-1", entry)
          const through = await fault.store.mark("doc-1")

          // The 2nd write of the compaction: after it has started deleting or
          // writing, before it has finished.
          fault.injectFault(2)
          await expect(
            fault.store.compact(
              "doc-1",
              [
                makeMetaRecord({ schemaHash: "injected" }),
                makeEntryRecord("entirety", "2"),
              ],
              through,
            ),
          ).rejects.toThrow()

          const fresh = await fault.freshStore()
          try {
            expect((await fresh.currentMeta("doc-1"))?.schemaHash).toBe(
              "primer",
            )
            expect(await collectAll(fresh.loadAll("doc-1"))).toEqual([
              meta,
              entry,
            ])
          } finally {
            await fresh.close()
          }
        } finally {
          await fault.cleanup()
        }
      })
    })
  }

  // Several instances may open one storage: two tabs over one IndexedDB
  // database, several processes over one Postgres schema. Each must append
  // safely, and a compaction by one must not lose what another wrote.

  if (secondInstance?.refused) {
    describe(`${name} — a second instance`, () => {
      it("is refused", async () => {
        const pair = await secondInstance.open()
        try {
          await expect(pair.openSecond()).rejects.toThrow()
        } finally {
          await pair.cleanup()
        }
      })
    })
  } else if (secondInstance !== undefined) {
    const twoInstances = secondInstance.open
    describe(`${name} — two instances over one storage`, () => {
      const versions = (records: StoreRecord[]): string[] =>
        records.flatMap(r => (r.kind === "entry" ? [r.version] : []))

      it("appends from both, interleaved, all load", async () => {
        const pair = await twoInstances()
        try {
          const second = await pair.openSecond()
          await pair.first.append("doc-1", makeMetaRecord())
          await Promise.all(
            Array.from({ length: 10 }, (_, i) => [
              pair.first.append("doc-1", makeEntryRecord("since", `a${i}`)),
              second.append("doc-1", makeEntryRecord("since", `b${i}`)),
            ]).flat(),
          )
          for (const store of [pair.first, second]) {
            const loaded = versions(await collectAll(store.loadAll("doc-1")))
            expect(loaded.sort()).toEqual(
              [
                ...Array.from({ length: 10 }, (_, i) => `a${i}`),
                ...Array.from({ length: 10 }, (_, i) => `b${i}`),
              ].sort(),
            )
          }
        } finally {
          await pair.cleanup()
        }
      })

      it("a compaction by one keeps what the other appended after its mark", async () => {
        const pair = await twoInstances()
        try {
          const second = await pair.openSecond()
          await pair.first.append("doc-1", makeMetaRecord())
          await pair.first.append("doc-1", makeEntryRecord("since", "1"))
          const through = await pair.first.mark("doc-1")
          await second.append("doc-1", makeEntryRecord("since", "theirs"))

          await pair.first.compact(
            "doc-1",
            [makeMetaRecord(), makeEntryRecord("entirety", "whole")],
            through,
          )

          const loaded = versions(await collectAll(second.loadAll("doc-1")))
          expect(loaded.sort()).toEqual(["theirs", "whole"])
        } finally {
          await pair.cleanup()
        }
      })

      it("two compactions through one mark lose nothing either wrote", async () => {
        const pair = await twoInstances()
        try {
          const second = await pair.openSecond()
          await pair.first.append("doc-1", makeMetaRecord())
          await pair.first.append("doc-1", makeEntryRecord("since", "1"))
          const through = await pair.first.mark("doc-1")

          await pair.first.compact(
            "doc-1",
            [makeMetaRecord(), makeEntryRecord("entirety", "first")],
            through,
          )
          await second.compact(
            "doc-1",
            [makeMetaRecord(), makeEntryRecord("entirety", "second")],
            through,
          )

          const loaded = versions(await collectAll(pair.first.loadAll("doc-1")))
          expect(loaded.sort()).toEqual(["first", "second"])
        } finally {
          await pair.cleanup()
        }
      })
    })
  }

  // Two stores backed by the same physical resource (same DB file,
  // same Pool, same PrismaClient) but namespaced differently must not
  // leak writes across the boundary. Distinct from test 13's
  // doc-prefix isolation, which covers overlap inside one store.

  if (isolationFactory !== undefined) {
    describe(`${name} — storage-domain isolation`, () => {
      it("writes in one namespace are not visible in the other", async () => {
        const pair = await isolationFactory()
        try {
          await pair.storeA.append("doc-1", makeMetaRecord())
          await pair.storeA.append(
            "doc-1",
            makeEntryRecord("entirety", "from-A"),
          )

          await pair.storeB.append("doc-1", makeMetaRecord())
          await pair.storeB.append(
            "doc-1",
            makeEntryRecord("entirety", "from-B"),
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
