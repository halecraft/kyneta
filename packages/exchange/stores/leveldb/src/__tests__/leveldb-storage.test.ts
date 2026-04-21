// leveldb-storage — conformance + LevelDB-specific tests.
//
// Runs the reusable Store conformance suite against
// LevelDBStore, plus LevelDB-specific tests for
// close+reopen persistence and encode/decode edge cases.

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { StoreRecord } from "@kyneta/exchange"
import {
  collectAll,
  describeStore,
  makeBinaryEntryRecord,
  makeEntryRecord,
  makeMetaRecord,
  plainMeta,
} from "@kyneta/exchange/testing"
import { afterAll, describe, expect, it } from "vitest"
import {
  decodeStoreRecord,
  encodeStoreRecord,
  LevelDBStore,
} from "../index.js"

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
    await backend.close()
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
    await backend1.append("doc-1", makeMetaRecord())
    await backend1.append("doc-1", makeEntryRecord("entirety", "v1"))
    await backend1.append("doc-1", makeEntryRecord("since", "v2"))
    await backend1.close()

    // Phase 2: reopen and verify
    const backend2 = new LevelDBStore(dir)
    expect(await backend2.currentMeta("doc-1")).toEqual(plainMeta)

    const records = await collectAll(backend2.loadAll("doc-1"))
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
    await backend2.close()
  })

  it("append after reopen continues with correct seqNo ordering", async () => {
    const dir = makeTmpDir()

    const backend1 = new LevelDBStore(dir)
    await backend1.append("doc-1", makeMetaRecord())
    await backend1.append("doc-1", makeEntryRecord("entirety", "v1"))
    await backend1.append("doc-1", makeEntryRecord("since", "v2"))
    await backend1.close()

    // Reopen and append more
    const backend2 = new LevelDBStore(dir)
    await backend2.append("doc-1", makeEntryRecord("since", "v3"))

    const records = await collectAll(backend2.loadAll("doc-1"))
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
    await backend2.close()
  })

  it("replace then reopen preserves the replacement records", async () => {
    const dir = makeTmpDir()

    const backend1 = new LevelDBStore(dir)
    await backend1.append("doc-1", makeMetaRecord())
    await backend1.append("doc-1", makeEntryRecord("since", "v1"))
    await backend1.append("doc-1", makeEntryRecord("since", "v2"))
    await backend1.replace("doc-1", [
      makeMetaRecord(),
      makeEntryRecord("entirety", "v3"),
    ])
    await backend1.close()

    const backend2 = new LevelDBStore(dir)
    const records = await collectAll(backend2.loadAll("doc-1"))
    expect(records).toHaveLength(2)
    expect(records[0]!.kind).toBe("meta")
    expect(records[1]!.kind).toBe("entry")
    expect((records[1] as { kind: "entry"; version: string }).version).toBe(
      "v3",
    )
    await backend2.close()
  })

  it("listDocIds works after reopen", async () => {
    const dir = makeTmpDir()

    const backend1 = new LevelDBStore(dir)
    await backend1.append("alpha", makeMetaRecord())
    await backend1.append("beta", makeMetaRecord())
    await backend1.append("gamma", makeMetaRecord())
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

describe("encodeStoreRecord / decodeStoreRecord", () => {
  it("round-trips a meta record", () => {
    const record: StoreRecord = makeMetaRecord()
    const decoded = decodeStoreRecord(encodeStoreRecord(record))
    expect(decoded).toEqual(record)
  })

  it("round-trips a meta record with custom schemaHash", () => {
    const record: StoreRecord = makeMetaRecord({ schemaHash: "00custom" })
    const decoded = decodeStoreRecord(encodeStoreRecord(record))
    expect(decoded).toEqual(record)
    expect(decoded.kind).toBe("meta")
    if (decoded.kind === "meta") {
      expect(decoded.meta.schemaHash).toBe("00custom")
    }
  })

  it("round-trips a JSON string payload entry (entirety)", () => {
    const record: StoreRecord = {
      kind: "entry",
      payload: {
        kind: "entirety",
        encoding: "json",
        data: '{"hello":"world"}',
      },
      version: "42",
    }
    const decoded = decodeStoreRecord(encodeStoreRecord(record))
    expect(decoded).toEqual(record)
  })

  it("round-trips a binary Uint8Array payload entry (since)", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0x02, 0xff, 0xfe])
    const record: StoreRecord = {
      kind: "entry",
      payload: { kind: "since", encoding: "binary", data: bytes },
      version: "v7",
    }
    const decoded = decodeStoreRecord(encodeStoreRecord(record))
    expect(decoded.kind).toBe("entry")
    if (decoded.kind === "entry") {
      expect(decoded.version).toBe("v7")
      expect(decoded.payload.kind).toBe("since")
      expect(decoded.payload.encoding).toBe("binary")
      expect(decoded.payload.data).toBeInstanceOf(Uint8Array)
      expect(decoded.payload.data).toEqual(bytes)
    }
  })

  it("round-trips a binary entry record via makeBinaryEntryRecord", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    const record: StoreRecord = makeBinaryEntryRecord(
      "entirety",
      "bin-v1",
      bytes,
    )
    const decoded = decodeStoreRecord(encodeStoreRecord(record))
    expect(decoded).toEqual(record)
  })

  it("handles empty string data", () => {
    const record: StoreRecord = {
      kind: "entry",
      payload: { kind: "entirety", encoding: "json", data: "" },
      version: "v0",
    }
    const decoded = decodeStoreRecord(encodeStoreRecord(record))
    expect(decoded).toEqual(record)
  })

  it("handles empty Uint8Array data", () => {
    const record: StoreRecord = {
      kind: "entry",
      payload: { kind: "since", encoding: "binary", data: new Uint8Array(0) },
      version: "v0",
    }
    const decoded = decodeStoreRecord(encodeStoreRecord(record))
    expect(decoded.kind).toBe("entry")
    if (decoded.kind === "entry") {
      expect(decoded.payload.data).toBeInstanceOf(Uint8Array)
      expect((decoded.payload.data as Uint8Array).length).toBe(0)
    }
  })

  it("handles empty version string", () => {
    const record: StoreRecord = {
      kind: "entry",
      payload: { kind: "entirety", encoding: "json", data: "{}" },
      version: "",
    }
    const decoded = decodeStoreRecord(encodeStoreRecord(record))
    expect(decoded.kind).toBe("entry")
    if (decoded.kind === "entry") {
      expect(decoded.version).toBe("")
      expect(decoded.payload.data).toBe("{}")
    }
  })

  it("handles large binary payload", () => {
    const largeData = new Uint8Array(100_000)
    for (let i = 0; i < largeData.length; i++) {
      largeData[i] = i % 256
    }
    const record: StoreRecord = {
      kind: "entry",
      payload: { kind: "entirety", encoding: "binary", data: largeData },
      version: "large-v1",
    }
    const decoded = decodeStoreRecord(encodeStoreRecord(record))
    expect(decoded.kind).toBe("entry")
    if (decoded.kind === "entry") {
      expect(decoded.payload.data).toEqual(largeData)
    }
  })

  it("meta record flags byte has bit 3 set", () => {
    const record: StoreRecord = makeMetaRecord()
    const encoded = encodeStoreRecord(record)
    expect(encoded[0]! & 0x08).toBe(0x08) // bit 3 set
    expect(encoded[0]! & 0x80).toBe(0x00) // bit 7 clear (current format)
  })

  it("entry record flags byte has bit 3 clear", () => {
    const record: StoreRecord = makeEntryRecord("entirety", "v1")
    const encoded = encodeStoreRecord(record)
    expect(encoded[0]! & 0x08).toBe(0x00) // bit 3 clear
    expect(encoded[0]! & 0x80).toBe(0x00) // bit 7 clear (current format)
  })

  it("rejects bytes with future-format bit set", () => {
    const record: StoreRecord = makeEntryRecord("entirety", "v1")
    const encoded = encodeStoreRecord(record)
    encoded[0] = encoded[0]! | 0x80 // set bit 7
    expect(() => decodeStoreRecord(encoded)).toThrow(/future-format/)
  })

  it("throws on empty bytes", () => {
    expect(() => decodeStoreRecord(new Uint8Array(0))).toThrow()
  })
})