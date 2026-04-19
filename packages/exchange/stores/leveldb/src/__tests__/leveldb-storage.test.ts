// leveldb-storage — conformance + LevelDB-specific tests.
//
// Runs the reusable Store conformance suite against
// LevelDBStore, plus LevelDB-specific tests for
// close+reopen persistence and encode/decode edge cases.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { StoreEntry } from "@kyneta/exchange"
import {
  collectAll,
  describeStore,
  makeEntry,
  plainMetadata,
} from "@kyneta/exchange/testing"
import { afterAll, describe, expect, it } from "vitest"
import { decodeStoreEntry, encodeStoreEntry, LevelDBStore } from "../index.js"

// ---------------------------------------------------------------------------
// Temp directory management
// ---------------------------------------------------------------------------

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kyneta-leveldb-test-"))
  tmpDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

// ---------------------------------------------------------------------------
// Conformance suite — validates the full Store contract
// ---------------------------------------------------------------------------

describeStore(
  "LevelDBStore",
  () => new LevelDBStore(makeTmpDir()),
  async backend => {
    if (backend.close) await backend.close()
  },
)

// ---------------------------------------------------------------------------
// LevelDB-specific tests
// ---------------------------------------------------------------------------

describe("LevelDBStore — close + reopen", () => {
  it("data persists across close and reopen on the same path", async () => {
    const dir = makeTmpDir()

    // Phase 1: write data then close
    const backend1 = new LevelDBStore(dir)
    await backend1.ensureDoc("doc-1", plainMetadata)
    await backend1.append("doc-1", makeEntry("entirety", "v1"))
    await backend1.append("doc-1", makeEntry("since", "v2"))
    await backend1.close()

    // Phase 2: reopen and verify
    const backend2 = new LevelDBStore(dir)
    expect(await backend2.lookup("doc-1")).toEqual(plainMetadata)

    const entries = await collectAll(backend2.loadAll("doc-1"))
    expect(entries).toHaveLength(2)
    expect(entries[0]?.version).toBe("v1")
    expect(entries[1]?.version).toBe("v2")
    await backend2.close()
  })

  it("append after reopen continues with correct seqNo ordering", async () => {
    const dir = makeTmpDir()

    const backend1 = new LevelDBStore(dir)
    await backend1.ensureDoc("doc-1", plainMetadata)
    await backend1.append("doc-1", makeEntry("entirety", "v1"))
    await backend1.append("doc-1", makeEntry("since", "v2"))
    await backend1.close()

    // Reopen and append more
    const backend2 = new LevelDBStore(dir)
    await backend2.append("doc-1", makeEntry("since", "v3"))

    const entries = await collectAll(backend2.loadAll("doc-1"))
    expect(entries).toHaveLength(3)
    expect(entries[0]?.version).toBe("v1")
    expect(entries[1]?.version).toBe("v2")
    expect(entries[2]?.version).toBe("v3")
    await backend2.close()
  })

  it("replace then reopen preserves the single entry", async () => {
    const dir = makeTmpDir()

    const backend1 = new LevelDBStore(dir)
    await backend1.ensureDoc("doc-1", plainMetadata)
    await backend1.append("doc-1", makeEntry("since", "v1"))
    await backend1.append("doc-1", makeEntry("since", "v2"))
    await backend1.replace("doc-1", makeEntry("entirety", "v3"))
    await backend1.close()

    const backend2 = new LevelDBStore(dir)
    const entries = await collectAll(backend2.loadAll("doc-1"))
    expect(entries).toHaveLength(1)
    expect(entries[0]?.version).toBe("v3")
    await backend2.close()
  })

  it("listDocIds works after reopen", async () => {
    const dir = makeTmpDir()

    const backend1 = new LevelDBStore(dir)
    await backend1.ensureDoc("alpha", plainMetadata)
    await backend1.ensureDoc("beta", plainMetadata)
    await backend1.ensureDoc("gamma", plainMetadata)
    await backend1.close()

    const backend2 = new LevelDBStore(dir)
    const docIds = await collectAll(backend2.listDocIds())
    expect(docIds.sort()).toEqual(["alpha", "beta", "gamma"])
    await backend2.close()
  })
})

// ---------------------------------------------------------------------------
// encode/decode round-trip — pure function unit tests
// ---------------------------------------------------------------------------

describe("encodeStoreEntry / decodeStoreEntry", () => {
  it("round-trips a JSON string payload (entirety)", () => {
    const entry: StoreEntry = {
      payload: {
        kind: "entirety",
        encoding: "json",
        data: '{"hello":"world"}',
      },
      version: "42",
    }
    const decoded = decodeStoreEntry(encodeStoreEntry(entry))
    expect(decoded).toEqual(entry)
  })

  it("round-trips a binary Uint8Array payload (since)", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe])
    const entry: StoreEntry = {
      payload: { kind: "since", encoding: "binary", data: bytes },
      version: "v7",
    }
    const decoded = decodeStoreEntry(encodeStoreEntry(entry))
    expect(decoded.version).toBe("v7")
    expect(decoded.payload.kind).toBe("since")
    expect(decoded.payload.encoding).toBe("binary")
    expect(decoded.payload.data).toBeInstanceOf(Uint8Array)
    expect(decoded.payload.data).toEqual(bytes)
  })

  it("handles empty string data", () => {
    const entry: StoreEntry = {
      payload: { kind: "entirety", encoding: "json", data: "" },
      version: "v0",
    }
    const decoded = decodeStoreEntry(encodeStoreEntry(entry))
    expect(decoded).toEqual(entry)
  })

  it("handles empty Uint8Array data", () => {
    const entry: StoreEntry = {
      payload: { kind: "since", encoding: "binary", data: new Uint8Array(0) },
      version: "v0",
    }
    const decoded = decodeStoreEntry(encodeStoreEntry(entry))
    expect(decoded.payload.data).toBeInstanceOf(Uint8Array)
    expect((decoded.payload.data as Uint8Array).length).toBe(0)
  })

  it("handles empty version string", () => {
    const entry: StoreEntry = {
      payload: { kind: "entirety", encoding: "json", data: "{}" },
      version: "",
    }
    const decoded = decodeStoreEntry(encodeStoreEntry(entry))
    expect(decoded.version).toBe("")
    expect(decoded.payload.data).toBe("{}")
  })

  it("handles large binary payload", () => {
    const largeData = new Uint8Array(100_000)
    for (let i = 0; i < largeData.length; i++) {
      largeData[i] = i % 256
    }
    const entry: StoreEntry = {
      payload: { kind: "entirety", encoding: "binary", data: largeData },
      version: "large-v1",
    }
    const decoded = decodeStoreEntry(encodeStoreEntry(entry))
    expect(decoded.payload.data).toEqual(largeData)
  })
})
