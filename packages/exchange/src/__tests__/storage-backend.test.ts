// storage-backend — unit tests for InMemoryStorageBackend.
//
// The StorageBackend contract tests are in the conformance suite
// (`describeStorageBackend`). This file runs that suite against
// InMemoryStorageBackend and adds InMemory-specific tests for
// shared state (`sharedData`, `getStorage()`).

import { describe, expect, it } from "vitest"
import {
  InMemoryStorageBackend,
  type InMemoryStorageData,
} from "../storage/in-memory-storage-backend.js"
import {
  describeStorageBackend,
  makeEntry,
  collectAll,
  plainMetadata,
} from "../testing/storage-backend-conformance.js"

// ---------------------------------------------------------------------------
// Conformance suite — validates the full StorageBackend contract
// ---------------------------------------------------------------------------

describeStorageBackend(
  "InMemoryStorageBackend",
  () => new InMemoryStorageBackend(),
)

// ---------------------------------------------------------------------------
// InMemory-specific tests — sharedData / getStorage()
// ---------------------------------------------------------------------------

describe("InMemoryStorageBackend — shared state", () => {
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
})