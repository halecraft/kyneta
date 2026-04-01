// storage-backend-conformance — reusable contract test suite for StorageBackend.
//
// Any conforming StorageBackend implementation must pass these tests.
// The suite covers: lookup, ensureDoc, append, loadAll, replace, delete,
// listDocIds, and both JSON and binary payload round-trips.
//
// Usage:
//   import { describeStorageBackend } from "@kyneta/exchange/testing"
//   describeStorageBackend("MyBackend", () => new MyBackend(), async (b) => { ... })

import { describe, expect, it, beforeEach, afterEach } from "vitest"
import type { StorageBackend, StorageEntry } from "../storage/storage-backend.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function makeEntry(kind: "entirety" | "since", version: string): StorageEntry {
  return {
    payload: {
      kind,
      encoding: "json",
      data: JSON.stringify({ v: version }),
    },
    version,
  }
}

export function makeBinaryEntry(
  kind: "entirety" | "since",
  version: string,
  bytes: Uint8Array,
): StorageEntry {
  return {
    payload: {
      kind,
      encoding: "binary",
      data: bytes,
    },
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

export const plainMetadata = {
  replicaType: ["plain", 1, 0] as const,
  mergeStrategy: "sequential" as const,
}

// ---------------------------------------------------------------------------
// Conformance suite
// ---------------------------------------------------------------------------

/**
 * Register the full StorageBackend contract test suite for a given backend.
 *
 * @param name - Display name for the describe block
 * @param factory - Creates a fresh backend instance per test
 * @param cleanup - Optional teardown (close handles, remove temp dirs)
 */
export function describeStorageBackend(
  name: string,
  factory: () => StorageBackend | Promise<StorageBackend>,
  cleanup?: (backend: StorageBackend) => Promise<void>,
): void {
  describe(name, () => {
    let backend: StorageBackend

    beforeEach(async () => {
      backend = await factory()
    })

    afterEach(async () => {
      if (cleanup) await cleanup(backend)
    })

    // =======================================================================
    // lookup / ensureDoc
    // =======================================================================

    it("lookup returns null for nonexistent doc", async () => {
      expect(await backend.lookup("nonexistent")).toBeNull()
    })

    it("lookup returns DocMetadata after ensureDoc", async () => {
      await backend.ensureDoc("doc-1", plainMetadata)
      expect(await backend.lookup("doc-1")).toEqual(plainMetadata)
    })

    it("ensureDoc is idempotent — calling twice with same metadata is a no-op", async () => {
      await backend.ensureDoc("doc-1", plainMetadata)
      await backend.ensureDoc("doc-1", plainMetadata)
      expect(await backend.lookup("doc-1")).toEqual(plainMetadata)
    })

    it("ensureDoc does not overwrite existing metadata", async () => {
      const meta2 = {
        replicaType: ["loro", 1, 0] as const,
        mergeStrategy: "causal" as const,
      }
      await backend.ensureDoc("doc-1", plainMetadata)
      await backend.ensureDoc("doc-1", meta2)
      // First call wins
      expect(await backend.lookup("doc-1")).toEqual(plainMetadata)
    })

    // =======================================================================
    // append / loadAll
    // =======================================================================

    it("append + loadAll round-trip: entries returned in insertion order", async () => {
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
      const entries = await collectAll(backend.loadAll("nonexistent"))
      expect(entries).toHaveLength(0)
    })

    // =======================================================================
    // Binary payload round-trip
    // =======================================================================

    it("append + loadAll round-trips binary (Uint8Array) payloads", async () => {
      await backend.ensureDoc("doc-1", plainMetadata)

      const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd])
      const entry = makeBinaryEntry("entirety", "bin-1", bytes)
      await backend.append("doc-1", entry)

      const entries = await collectAll(backend.loadAll("doc-1"))
      expect(entries).toHaveLength(1)
      expect(entries[0]!.version).toBe("bin-1")
      expect(entries[0]!.payload.kind).toBe("entirety")
      expect(entries[0]!.payload.encoding).toBe("binary")
      expect(entries[0]!.payload.data).toBeInstanceOf(Uint8Array)
      expect(entries[0]!.payload.data).toEqual(bytes)
    })

    it("append + loadAll round-trips mixed JSON and binary entries", async () => {
      await backend.ensureDoc("doc-1", plainMetadata)

      const jsonEntry = makeEntry("entirety", "v1")
      const binaryEntry = makeBinaryEntry(
        "since",
        "v2",
        new Uint8Array([10, 20, 30]),
      )

      await backend.append("doc-1", jsonEntry)
      await backend.append("doc-1", binaryEntry)

      const entries = await collectAll(backend.loadAll("doc-1"))
      expect(entries).toHaveLength(2)

      // JSON entry
      expect(entries[0]!.payload.encoding).toBe("json")
      expect(typeof entries[0]!.payload.data).toBe("string")
      expect(entries[0]!.version).toBe("v1")

      // Binary entry
      expect(entries[1]!.payload.encoding).toBe("binary")
      expect(entries[1]!.payload.data).toBeInstanceOf(Uint8Array)
      expect(entries[1]!.payload.data).toEqual(new Uint8Array([10, 20, 30]))
      expect(entries[1]!.version).toBe("v2")
    })

    // =======================================================================
    // replace
    // =======================================================================

    it("replace atomically swaps entries: loadAll yields exactly one entry", async () => {
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
      const entry = makeEntry("entirety", "1")
      await backend.replace("doc-1", entry)

      // Entries exist
      const entries = await collectAll(backend.loadAll("doc-1"))
      expect(entries).toHaveLength(1)
      expect(entries[0]).toEqual(entry)

      // But metadata was not implicitly created
      expect(await backend.lookup("doc-1")).toBeNull()
    })

    // =======================================================================
    // delete
    // =======================================================================

    it("delete removes both entries and metadata", async () => {
      await backend.ensureDoc("doc-1", plainMetadata)
      await backend.append("doc-1", makeEntry("entirety", "1"))
      await backend.append("doc-1", makeEntry("since", "2"))

      await backend.delete("doc-1")

      expect(await backend.lookup("doc-1")).toBeNull()
      const entries = await collectAll(backend.loadAll("doc-1"))
      expect(entries).toHaveLength(0)
    })

    // =======================================================================
    // listDocIds
    // =======================================================================

    it("listDocIds enumerates registered docs (via ensureDoc)", async () => {
      await backend.ensureDoc("doc-a", plainMetadata)
      await backend.ensureDoc("doc-b", plainMetadata)
      await backend.ensureDoc("doc-c", plainMetadata)

      // Delete one
      await backend.delete("doc-b")

      const docIds = await collectAll(backend.listDocIds())
      expect(docIds.sort()).toEqual(["doc-a", "doc-c"])
    })

    // =======================================================================
    // replace → append ordering (seqNo collision risk)
    // =======================================================================

    it("append after replace produces correct ordering (no seqNo collision)", async () => {
      await backend.ensureDoc("doc-1", plainMetadata)

      await backend.append("doc-1", makeEntry("since", "1"))
      await backend.append("doc-1", makeEntry("since", "2"))

      // Replace collapses to a single entry
      const snapshot = makeEntry("entirety", "3")
      await backend.replace("doc-1", snapshot)

      // Append after replace must not overwrite the replacement
      const delta = makeEntry("since", "4")
      await backend.append("doc-1", delta)

      const entries = await collectAll(backend.loadAll("doc-1"))
      expect(entries).toHaveLength(2)
      expect(entries[0]!.version).toBe("3")
      expect(entries[1]!.version).toBe("4")
    })

    // =======================================================================
    // Doc prefix isolation
    // =======================================================================

    it("docs with overlapping name prefixes are isolated", async () => {
      await backend.ensureDoc("doc", plainMetadata)
      await backend.ensureDoc("doc-extra", plainMetadata)
      await backend.ensureDoc("doc2", plainMetadata)

      await backend.append("doc", makeEntry("entirety", "a"))
      await backend.append("doc-extra", makeEntry("entirety", "b"))
      await backend.append("doc2", makeEntry("entirety", "c"))

      // loadAll for "doc" must not include entries from "doc-extra" or "doc2"
      const docEntries = await collectAll(backend.loadAll("doc"))
      expect(docEntries).toHaveLength(1)
      expect(docEntries[0]!.version).toBe("a")

      const extraEntries = await collectAll(backend.loadAll("doc-extra"))
      expect(extraEntries).toHaveLength(1)
      expect(extraEntries[0]!.version).toBe("b")
    })
  })
}