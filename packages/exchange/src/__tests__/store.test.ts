// store — unit tests for InMemoryStore.
//
// The Store contract tests are in the conformance suite
// (`describeStore`). This file runs that suite against
// InMemoryStore and adds InMemory-specific tests for
// shared state (`sharedData`, `getStorage()`).

import { describe, expect, it } from "vitest"
import {
  InMemoryStore,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"
import {
  collectAll,
  describeStore,
  makeEntry,
  plainMetadata,
} from "../testing/store-conformance.js"

// ---------------------------------------------------------------------------
// Conformance suite — validates the full Store contract
// ---------------------------------------------------------------------------

describeStore("InMemoryStore", () => new InMemoryStore())

// ---------------------------------------------------------------------------
// InMemory-specific tests — sharedData / getStorage()
// ---------------------------------------------------------------------------

describe("InMemoryStore — shared state", () => {
  it("shared state via constructor arg is visible across instances", async () => {
    const sharedData: InMemoryStoreData = {
      entries: new Map(),
      metadata: new Map(),
    }
    const backend1 = new InMemoryStore(sharedData)
    const backend2 = new InMemoryStore(sharedData)

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
    const backend1 = new InMemoryStore()
    await backend1.ensureDoc("doc-1", plainMetadata)
    await backend1.append("doc-1", makeEntry("entirety", "1"))

    // Late sharing via getStorage()
    const backend2 = new InMemoryStore(backend1.getStorage())
    expect(await backend2.lookup("doc-1")).toEqual(plainMetadata)
    const entries = await collectAll(backend2.loadAll("doc-1"))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.version).toBe("1")
  })
})
