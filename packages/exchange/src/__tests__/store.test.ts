// store — unit tests for InMemoryStore.
//
// The Store contract tests are in the conformance suite
// (`describeStore`). This file runs that suite against
// InMemoryStore and adds InMemory-specific tests for
// shared state (`sharedData`, `getStorage()`).

import { SYNC_COLLABORATIVE } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import {
  InMemoryStore,
  type InMemoryStoreData,
} from "../store/in-memory-store.js"
import { resolveMetaFromBatch, type StoreMeta } from "../store/store.js"
import {
  collectAll,
  describeStore,
  makeEntryRecord,
  makeMetaRecord,
  plainMeta,
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
      records: new Map(),
      metadata: new Map(),
    }
    const backend1 = new InMemoryStore(sharedData)
    const backend2 = new InMemoryStore(sharedData)

    const metaRecord = makeMetaRecord()
    await backend1.append("doc-1", metaRecord)
    await backend1.append("doc-1", makeEntryRecord("entirety", "1"))

    // Second instance sees metadata
    const meta: StoreMeta | null = await backend2.currentMeta("doc-1")
    expect(meta).toEqual(plainMeta)

    // Second instance sees records
    const records = await collectAll(backend2.loadAll("doc-1"))
    expect(records).toHaveLength(2)
    expect(records[0]).toEqual(metaRecord)
    expect(records[1]?.kind).toBe("entry")
    if (records[1]?.kind === "entry") {
      expect(records[1].version).toBe("1")
    }

    await backend1.close()
    await backend2.close()
  })

  it("getStorage() returns data for late sharing across instances", async () => {
    const backend1 = new InMemoryStore()
    const metaRecord = makeMetaRecord()
    await backend1.append("doc-1", metaRecord)
    await backend1.append("doc-1", makeEntryRecord("entirety", "1"))

    // Late sharing via getStorage()
    const backend2 = new InMemoryStore(backend1.getStorage())
    const meta: StoreMeta | null = await backend2.currentMeta("doc-1")
    expect(meta).toEqual(plainMeta)

    const records = await collectAll(backend2.loadAll("doc-1"))
    expect(records).toHaveLength(2)
    expect(records[0]).toEqual(metaRecord)
    expect(records[1]?.kind).toBe("entry")
    if (records[1]?.kind === "entry") {
      expect(records[1].version).toBe("1")
    }

    await backend1.close()
    await backend2.close()
  })
})

// ---------------------------------------------------------------------------
// resolveMetaFromBatch — pure function unit tests
// ---------------------------------------------------------------------------

describe("resolveMetaFromBatch", () => {
  it("resolves meta from a batch with one meta record", () => {
    const result = resolveMetaFromBatch([makeMetaRecord()], null)
    expect(result).toEqual(plainMeta)
  })

  it("returns last meta's schemaHash when batch has multiple meta records (LWW)", () => {
    const first = makeMetaRecord({ schemaHash: "hash-v1" })
    const second = makeMetaRecord({ schemaHash: "hash-v2" })
    const result = resolveMetaFromBatch([first, second], null)
    expect(result.schemaHash).toBe("hash-v2")
    // Immutable fields unchanged
    expect(result.replicaType).toEqual(plainMeta.replicaType)
    expect(result.syncProtocol).toEqual(plainMeta.syncProtocol)
  })

  it("throws when batch has no meta records", () => {
    expect(() => resolveMetaFromBatch([], null)).toThrow(
      "batch must contain at least one meta record",
    )
  })

  it("throws when batch meta conflicts with existingMeta on replicaType", () => {
    const existing: StoreMeta = {
      ...plainMeta,
      replicaType: ["loro", 1, 0],
    }
    expect(() => resolveMetaFromBatch([makeMetaRecord()], existing)).toThrow(
      "replicaType mismatch",
    )
  })

  it("throws when batch meta conflicts with existingMeta on syncProtocol", () => {
    const existing: StoreMeta = {
      ...plainMeta,
      syncProtocol: SYNC_COLLABORATIVE,
    }
    expect(() => resolveMetaFromBatch([makeMetaRecord()], existing)).toThrow(
      "syncProtocol mismatch",
    )
  })

  it("ignores entry records in the batch", () => {
    const batch = [
      makeEntryRecord("entirety", "v1"),
      makeMetaRecord({ schemaHash: "only-meta" }),
      makeEntryRecord("since", "v2"),
    ]
    const result = resolveMetaFromBatch(batch, null)
    expect(result.schemaHash).toBe("only-meta")
  })

  it("first write (existingMeta=null) accepts any meta", () => {
    const exotic: StoreMeta = {
      replicaType: ["loro", 2, 0],
      syncProtocol: SYNC_COLLABORATIVE,
      schemaHash: "exotic-hash",
    }
    const result = resolveMetaFromBatch(
      [{ kind: "meta", meta: exotic }],
      null,
    )
    expect(result).toEqual(exotic)
  })
})