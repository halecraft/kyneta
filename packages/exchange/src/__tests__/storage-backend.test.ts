// storage-backend — unit tests for InMemoryStorageBackend.
//
// These tests validate the StorageBackend contract through the
// InMemoryStorageBackend implementation. Any conforming backend
// should pass the same tests.
//
// The old StorageAdapter behavioral tests have been removed —
// storage is now a direct Exchange dependency, not an adapter.

import { describe, expect, it } from "vitest"
import {
  InMemoryStorageBackend,
  type InMemoryStorageData,
} from "../storage/in-memory-storage-backend.js"
import type { StorageEntry } from "../storage/storage-backend.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(kind: "entirety" | "since", version: string): StorageEntry {
  return {
    payload: {
      kind,
      encoding: "json",
      data: JSON.stringify({ v: version }),
    },
    version,
  }
}

async function collectAll<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const results: T[] = []
  for await (const item of iter) {
    results.push(item)
  }
  return results
}

const plainMetadata = {
  replicaType: ["plain", 1, 0] as const,
  mergeStrategy: "sequential" as const,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InMemoryStorageBackend", () => {
  // =========================================================================
  // lookup / ensureDoc
  // =========================================================================

  it("lookup returns null for nonexistent doc", async () => {
    const backend = new InMemoryStorageBackend()
    expect(await backend.lookup("nonexistent")).toBeNull()
  })

  it("lookup returns DocMetadata after ensureDoc", async () => {
    const backend = new InMemoryStorageBackend()
    await backend.ensureDoc("doc-1", plainMetadata)
    expect(await backend.lookup("doc-1")).toEqual(plainMetadata)
  })

  it("ensureDoc is idempotent — calling twice with same metadata is a no-op", async () => {
    const backend = new InMemoryStorageBackend()
    await backend.ensureDoc("doc-1", plainMetadata)
    await backend.ensureDoc("doc-1", plainMetadata)
    expect(await backend.lookup("doc-1")).toEqual(plainMetadata)
  })

  it("ensureDoc does not overwrite existing metadata", async () => {
    const backend = new InMemoryStorageBackend()
    const meta2 = {
      replicaType: ["loro", 1, 0] as const,
      mergeStrategy: "causal" as const,
    }
    await backend.ensureDoc("doc-1", plainMetadata)
    await backend.ensureDoc("doc-1", meta2)
    // First call wins
    expect(await backend.lookup("doc-1")).toEqual(plainMetadata)
  })

  // =========================================================================
  // append / loadAll
  // =========================================================================

  it("append + loadAll round-trip: entries returned in insertion order", async () => {
    const backend = new InMemoryStorageBackend()
    await backend.ensureDoc("doc-1", plainMetadata)

    const e1 = makeEntry("entirety", "1")
    const e2 = makeEntry("since", "2")
    const e3 = makeEntry("since", "3")

    await backend.append("doc-1", e1)
    await backend.append("doc-1", e2)
    await backend.append("doc-1", e3)

    const entries = await collectAll(backend.loadAll("doc-1"))
    expect(entries).toHaveLength(3)
    expect(entries[0]).toEqual(e1)
    expect(entries[1]).toEqual(e2)
    expect(entries[2]).toEqual(e3)
  })

  it("loadAll of nonexistent doc yields nothing (no crash)", async () => {
    const backend = new InMemoryStorageBackend()
    const entries = await collectAll(backend.loadAll("nonexistent"))
    expect(entries).toHaveLength(0)
  })

  // =========================================================================
  // replace
  // =========================================================================

  it("replace atomically swaps entries: loadAll yields exactly one entry", async () => {
    const backend = new InMemoryStorageBackend()
    await backend.ensureDoc("doc-1", plainMetadata)

    await backend.append("doc-1", makeEntry("since", "1"))
    await backend.append("doc-1", makeEntry("since", "2"))
    await backend.append("doc-1", makeEntry("since", "3"))

    // Before replace: 3 entries
    let entries = await collectAll(backend.loadAll("doc-1"))
    expect(entries).toHaveLength(3)

    // After replace: exactly 1 entry
    const replacement = makeEntry("entirety", "4")
    await backend.replace("doc-1", replacement)
    entries = await collectAll(backend.loadAll("doc-1"))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual(replacement)
  })

  it("replace on nonexistent doc creates entries (but not metadata)", async () => {
    const backend = new InMemoryStorageBackend()

    const entry = makeEntry("entirety", "1")
    await backend.replace("doc-1", entry)

    // Entries exist
    const entries = await collectAll(backend.loadAll("doc-1"))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toEqual(entry)

    // But metadata was not implicitly created
    expect(await backend.lookup("doc-1")).toBeNull()
  })

  // =========================================================================
  // delete
  // =========================================================================

  it("delete removes both entries and metadata", async () => {
    const backend = new InMemoryStorageBackend()
    await backend.ensureDoc("doc-1", plainMetadata)
    await backend.append("doc-1", makeEntry("entirety", "1"))
    await backend.append("doc-1", makeEntry("since", "2"))

    await backend.delete("doc-1")

    expect(await backend.lookup("doc-1")).toBeNull()
    const entries = await collectAll(backend.loadAll("doc-1"))
    expect(entries).toHaveLength(0)
  })

  // =========================================================================
  // listDocIds
  // =========================================================================

  it("listDocIds enumerates registered docs (via ensureDoc)", async () => {
    const backend = new InMemoryStorageBackend()
    await backend.ensureDoc("doc-a", plainMetadata)
    await backend.ensureDoc("doc-b", plainMetadata)
    await backend.ensureDoc("doc-c", plainMetadata)

    // Delete one
    await backend.delete("doc-b")

    const docIds = await collectAll(backend.listDocIds())
    expect(docIds.sort()).toEqual(["doc-a", "doc-c"])
  })

  // =========================================================================
  // Shared state (cross-instance persistence)
  // =========================================================================

  it("shared state via constructor arg is visible across instances", async () => {
    const sharedData: InMemoryStorageData = {
      entries: new Map(),
      metadata: new Map(),
    }
    const backend1 = new InMemoryStorageBackend(sharedData)
    const backend2 = new InMemoryStorageBackend(sharedData)

    await backend1.ensureDoc("doc-1", plainMetadata)
    await backend1.append("doc-1", makeEntry("entirety", "1"))

    // Second instance sees metadata
    expect(await backend2.lookup("doc-1")).toEqual(plainMetadata)

    // Second instance sees entries
    const entries = await collectAll(backend2.loadAll("doc-1"))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.version).toBe("1")
  })

  it("getStorage() returns data for late sharing across instances", async () => {
    const backend1 = new InMemoryStorageBackend()
    await backend1.ensureDoc("doc-1", plainMetadata)
    await backend1.append("doc-1", makeEntry("entirety", "1"))

    // Late sharing via getStorage()
    const backend2 = new InMemoryStorageBackend(backend1.getStorage())
    expect(await backend2.lookup("doc-1")).toEqual(plainMetadata)
    const entries = await collectAll(backend2.loadAll("doc-1"))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.version).toBe("1")
  })

  // =========================================================================
  // StorageEntry shape
  // =========================================================================

  it("StorageEntry stays lean — only payload and version, no metadata fields", async () => {
    const backend = new InMemoryStorageBackend()
    await backend.ensureDoc("doc-1", plainMetadata)

    const entry = makeEntry("entirety", "1")
    await backend.append("doc-1", entry)

    const entries = await collectAll(backend.loadAll("doc-1"))
    expect(entries).toHaveLength(1)
    expect(Object.keys(entries[0]!).sort()).toEqual(["payload", "version"])
  })
})