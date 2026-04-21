// indexeddb-storage — conformance + IndexedDB-specific tests.

import {
  collectAll,
  describeStore,
  makeEntryRecord,
  makeMetaRecord,
  plainMeta,
} from "@kyneta/exchange/testing"
import { afterAll, describe, expect, it } from "vitest"
import { deleteIndexedDBStore, IndexedDBStore } from "../index.js"

// ---------------------------------------------------------------------------
// Unique database name management
// ---------------------------------------------------------------------------

let dbCounter = 0
function uniqueDbName(): string {
  return `kyneta-test-${Date.now()}-${dbCounter++}`
}

const dbNames: string[] = []

afterAll(async () => {
  for (const name of dbNames) {
    await deleteIndexedDBStore(name)
  }
})

// ---------------------------------------------------------------------------
// Conformance suite — validates the full Store contract
// ---------------------------------------------------------------------------

describeStore(
  "IndexedDBStore",
  async () => {
    const name = uniqueDbName()
    dbNames.push(name)
    return IndexedDBStore.open(name)
  },
  async backend => {
    await backend.close()
  },
)

// ---------------------------------------------------------------------------
// IndexedDB-specific: close + reopen persistence
// ---------------------------------------------------------------------------

describe("IndexedDBStore — close + reopen", () => {
  it("data persists across close and reopen on the same database name", async () => {
    const name = uniqueDbName()
    dbNames.push(name)

    // Phase 1: write data then close
    const store1 = await IndexedDBStore.open(name)
    await store1.append("doc-1", makeMetaRecord())
    await store1.append("doc-1", makeEntryRecord("entirety", "v1"))
    await store1.append("doc-1", makeEntryRecord("since", "v2"))
    await store1.close()

    // Phase 2: reopen and verify
    const store2 = await IndexedDBStore.open(name)
    expect(await store2.currentMeta("doc-1")).toEqual(plainMeta)

    const records = await collectAll(store2.loadAll("doc-1"))
    expect(records).toHaveLength(3)
    expect(records[0]).toEqual(makeMetaRecord())
    const entries = records.filter(r => r.kind === "entry")
    expect(entries).toHaveLength(2)
    expect((entries[0] as { kind: "entry"; version: string }).version).toBe(
      "v1",
    )
    expect((entries[1] as { kind: "entry"; version: string }).version).toBe(
      "v2",
    )
    await store2.close()
  })

  it("append after reopen continues with correct ordering", async () => {
    const name = uniqueDbName()
    dbNames.push(name)

    const store1 = await IndexedDBStore.open(name)
    await store1.append("doc-1", makeMetaRecord())
    await store1.append("doc-1", makeEntryRecord("entirety", "v1"))
    await store1.append("doc-1", makeEntryRecord("since", "v2"))
    await store1.close()

    // Reopen and append more
    const store2 = await IndexedDBStore.open(name)
    await store2.append("doc-1", makeEntryRecord("since", "v3"))

    const records = await collectAll(store2.loadAll("doc-1"))
    const entries = records.filter(r => r.kind === "entry")
    expect(entries).toHaveLength(3)
    expect((entries[0] as { kind: "entry"; version: string }).version).toBe(
      "v1",
    )
    expect((entries[1] as { kind: "entry"; version: string }).version).toBe(
      "v2",
    )
    expect((entries[2] as { kind: "entry"; version: string }).version).toBe(
      "v3",
    )
    await store2.close()
  })

  it("replace then reopen preserves the replacement records", async () => {
    const name = uniqueDbName()
    dbNames.push(name)

    const store1 = await IndexedDBStore.open(name)
    await store1.append("doc-1", makeMetaRecord())
    await store1.append("doc-1", makeEntryRecord("since", "v1"))
    await store1.append("doc-1", makeEntryRecord("since", "v2"))
    await store1.replace("doc-1", [
      makeMetaRecord(),
      makeEntryRecord("entirety", "v3"),
    ])
    await store1.close()

    const store2 = await IndexedDBStore.open(name)
    const records = await collectAll(store2.loadAll("doc-1"))
    expect(records).toHaveLength(2)
    expect(records[0]?.kind).toBe("meta")
    expect(records[1]?.kind).toBe("entry")
    if (records[1]?.kind === "entry") {
      expect(records[1].version).toBe("v3")
    }
    await store2.close()
  })

  it("listDocIds works after reopen", async () => {
    const name = uniqueDbName()
    dbNames.push(name)

    const store1 = await IndexedDBStore.open(name)
    await store1.append("alpha", makeMetaRecord())
    await store1.append("beta", makeMetaRecord())
    await store1.append("gamma", makeMetaRecord())
    await store1.close()

    const store2 = await IndexedDBStore.open(name)
    const docIds = await collectAll(store2.listDocIds())
    expect(docIds.sort()).toEqual(["alpha", "beta", "gamma"])
    await store2.close()
  })
})

// ---------------------------------------------------------------------------
// IndexedDB-specific: database isolation
// ---------------------------------------------------------------------------

describe("IndexedDBStore — database isolation", () => {
  it("two stores on different database names are fully isolated", async () => {
    const nameA = uniqueDbName()
    const nameB = uniqueDbName()
    dbNames.push(nameA, nameB)

    const storeA = await IndexedDBStore.open(nameA)
    const storeB = await IndexedDBStore.open(nameB)

    await storeA.append("shared-id", makeMetaRecord())
    await storeA.append("shared-id", makeEntryRecord("entirety", "from-a"))

    await storeB.append("shared-id", makeMetaRecord())
    await storeB.append("shared-id", makeEntryRecord("entirety", "from-b"))

    // Each store sees only its own data
    const recordsA = await collectAll(storeA.loadAll("shared-id"))
    const entriesA = recordsA.filter(r => r.kind === "entry")
    expect(entriesA).toHaveLength(1)
    expect((entriesA[0] as { kind: "entry"; version: string }).version).toBe(
      "from-a",
    )

    const recordsB = await collectAll(storeB.loadAll("shared-id"))
    const entriesB = recordsB.filter(r => r.kind === "entry")
    expect(entriesB).toHaveLength(1)
    expect((entriesB[0] as { kind: "entry"; version: string }).version).toBe(
      "from-b",
    )

    await storeA.close()
    await storeB.close()
  })
})

// ---------------------------------------------------------------------------
// IndexedDB-specific: deleteDatabase cleanup
// ---------------------------------------------------------------------------

describe("deleteIndexedDBStore", () => {
  it("deleteDatabase cleans up completely", async () => {
    const name = uniqueDbName()
    // Don't push to dbNames — we're explicitly deleting

    const store1 = await IndexedDBStore.open(name)
    await store1.append("doc-1", makeMetaRecord())
    await store1.append("doc-1", makeEntryRecord("entirety", "v1"))
    await store1.close()

    // Delete the database
    await deleteIndexedDBStore(name)

    // Reopen — should be empty
    const store2 = await IndexedDBStore.open(name)
    expect(await store2.currentMeta("doc-1")).toBeNull()
    const records = await collectAll(store2.loadAll("doc-1"))
    expect(records).toHaveLength(0)
    const docIds = await collectAll(store2.listDocIds())
    expect(docIds).toHaveLength(0)
    await store2.close()

    // Clean up the reopened empty database
    await deleteIndexedDBStore(name)
  })
})
