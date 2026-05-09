// store-conformance — reusable contract test suite for Store.
//
// Any conforming Store implementation must pass these tests.
// The suite covers: currentMeta, append, loadAll, replace, delete,
// listDocIds, and both JSON and binary payload round-trips. Backends
// that opt in via `faultFactory` and `isolationFactory` get additional
// property-level tests (atomicity under fault injection; storage-domain
// isolation across two stores sharing one physical resource).
//
// Usage:
//   import { describeStore } from "@kyneta/exchange/testing"
//   describeStore("MyBackend", () => new MyBackend(), {
//     cleanup: async (b) => { ... },
//     faultFactory: async (failOnNthCall) => ({ ... }),
//     isolationFactory: async () => ({ ... }),
//   })

import { SYNC_AUTHORITATIVE, SYNC_COLLABORATIVE } from "@kyneta/schema"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { Store, StoreMeta, StoreRecord } from "../store/store.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const plainMeta: StoreMeta = {
  replicaType: ["plain", 1, 0] as const,
  syncProtocol: SYNC_AUTHORITATIVE,
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
  const { cleanup, faultFactory, isolationFactory } = options
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
    // 4. append of second meta with same replicaType/syncProtocol but
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
      expect(meta.syncProtocol).toEqual(plainMeta.syncProtocol)
    })

    // =======================================================================
    // 5. append of meta with mismatched replicaType or syncProtocol → throws
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

    it("append of meta with mismatched syncProtocol throws", async () => {
      await backend.append("doc-1", makeMetaRecord())
      await expect(
        backend.append(
          "doc-1",
          makeMetaRecord({ syncProtocol: SYNC_COLLABORATIVE }),
        ),
      ).rejects.toThrow(/syncProtocol/)
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
    // 7. replace atomically swaps stream; loadAll yields exactly the
    //    replacement records
    // =======================================================================

    it("replace atomically swaps stream", async () => {
      await backend.append("doc-1", makeMetaRecord())
      await backend.append("doc-1", makeEntryRecord("since", "1"))
      await backend.append("doc-1", makeEntryRecord("since", "2"))
      await backend.append("doc-1", makeEntryRecord("since", "3"))

      // Before replace: 4 records (1 meta + 3 entries)
      let records = await collectAll(backend.loadAll("doc-1"))
      expect(records).toHaveLength(4)

      // After replace: exactly 2 records (1 meta + 1 entry)
      const replacementMeta = makeMetaRecord()
      const replacementEntry = makeEntryRecord("entirety", "4")
      await backend.replace("doc-1", [replacementMeta, replacementEntry])

      records = await collectAll(backend.loadAll("doc-1"))
      expect(records).toHaveLength(2)
      expect(records[0]).toEqual(replacementMeta)
      expect(records[1]).toEqual(replacementEntry)
    })

    // =======================================================================
    // 8. replace without a meta record in the batch → throws
    // =======================================================================

    it("replace without a meta record in the batch throws", async () => {
      await backend.append("doc-1", makeMetaRecord())

      await expect(
        backend.replace("doc-1", [makeEntryRecord("entirety", "1")]),
      ).rejects.toThrow()
    })

    // =======================================================================
    // 9. replace updates materialized index from last meta in batch
    // =======================================================================

    it("replace updates materialized index from last meta in batch", async () => {
      await backend.append("doc-1", makeMetaRecord())

      const metaA = makeMetaRecord({ schemaHash: "hash-a" })
      const metaB = makeMetaRecord({ schemaHash: "hash-b" })
      const entry = makeEntryRecord("entirety", "1")

      await backend.replace("doc-1", [metaA, entry, metaB])

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

    // =======================================================================
    // 12. append after replace produces correct ordering (no seqNo collision)
    // =======================================================================

    it("append after replace produces correct ordering", async () => {
      await backend.append("doc-1", makeMetaRecord())
      await backend.append("doc-1", makeEntryRecord("since", "1"))
      await backend.append("doc-1", makeEntryRecord("since", "2"))

      // Replace collapses to meta + one entry
      const snapshot = makeMetaRecord()
      const collapsed = makeEntryRecord("entirety", "3")
      await backend.replace("doc-1", [snapshot, collapsed])

      // Append after replace must not overwrite the replacement
      const delta = makeEntryRecord("since", "4")
      await backend.append("doc-1", delta)

      const records = await collectAll(backend.loadAll("doc-1"))
      expect(records).toHaveLength(3)
      expect(records[0]).toEqual(snapshot)
      expect(records[1]?.kind).toBe("entry")
      if (records[1]?.kind === "entry") {
        expect(records[1].version).toBe("3")
      }
      expect(records[2]?.kind).toBe("entry")
      if (records[2]?.kind === "entry") {
        expect(records[2].version).toBe("4")
      }
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
