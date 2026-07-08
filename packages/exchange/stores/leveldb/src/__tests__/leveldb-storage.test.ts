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
  makeArmedFault,
  makeBinaryEntryRecord,
  makeEntryRecord,
  makeMetaRecord,
  plainMeta,
} from "@kyneta/exchange/testing"
import { ClassicLevel } from "classic-level"
import { afterAll, describe, expect, it } from "vitest"
import {
  createLevelDBStore,
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

describeStore("LevelDBStore", () => createLevelDBStore(makeTmpDir()), {
  cleanup: async backend => {
    await backend.close()
  },
  // Atomicity property: wrap the raw ClassicLevel so the Nth write op fails.
  // Op-weighting (put = 1, batch = ops.length) makes the harness's
  // injectFault(2) land inside the meta-append's 2-op batch, so the throw fires
  // before the atomic batch commits — nothing leaks. jj:pzuytnvo
  faultFactory: async () => {
    const dir = makeTmpDir()
    const raw = new ClassicLevel<string, Uint8Array>(dir, {
      valueEncoding: "binary",
    })
    const { proxy, arm } = makeArmedFault(raw, {
      put: 1,
      batch: ops => (ops as readonly unknown[]).length,
    })
    const store = await LevelDBStore.open(proxy)
    return {
      store,
      injectFault: arm,
      // LevelDB takes a single-process directory lock, so the fresh store
      // cannot open a second handle on `dir` while `raw` is live — release it
      // first, then reopen non-faulting on the same dir.
      freshStore: async () => {
        await raw.close()
        return createLevelDBStore(dir)
      },
      cleanup: async () => {
        try {
          await raw.close()
        } catch {
          // already closed by freshStore
        }
      },
    }
  },
})

// ---------------------------------------------------------------------------
// LevelDB-specific tests
// ---------------------------------------------------------------------------

describe("LevelDBStore — close + reopen", () => {
  it("data persists across close and reopen on the same path", async () => {
    const dir = makeTmpDir()

    // Phase 1: write data then close
    const backend1 = await createLevelDBStore(dir)
    await backend1.append("doc-1", makeMetaRecord())
    await backend1.append("doc-1", makeEntryRecord("entirety", "v1"))
    await backend1.append("doc-1", makeEntryRecord("since", "v2"))
    await backend1.close()

    // Phase 2: reopen and verify
    const backend2 = await createLevelDBStore(dir)
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

    const backend1 = await createLevelDBStore(dir)
    await backend1.append("doc-1", makeMetaRecord())
    await backend1.append("doc-1", makeEntryRecord("entirety", "v1"))
    await backend1.append("doc-1", makeEntryRecord("since", "v2"))
    await backend1.close()

    // Reopen and append more
    const backend2 = await createLevelDBStore(dir)
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

    const backend1 = await createLevelDBStore(dir)
    await backend1.append("doc-1", makeMetaRecord())
    await backend1.append("doc-1", makeEntryRecord("since", "v1"))
    await backend1.append("doc-1", makeEntryRecord("since", "v2"))
    await backend1.replace("doc-1", [
      makeMetaRecord(),
      makeEntryRecord("entirety", "v3"),
    ])
    await backend1.close()

    const backend2 = await createLevelDBStore(dir)
    const records = await collectAll(backend2.loadAll("doc-1"))
    expect(records).toHaveLength(2)
    expect(records[0]?.kind).toBe("meta")
    expect(records[1]?.kind).toBe("entry")
    expect((records[1] as { kind: "entry"; version: string }).version).toBe(
      "v3",
    )
    await backend2.close()
  })

  it("listDocIds works after reopen", async () => {
    const dir = makeTmpDir()

    const backend1 = await createLevelDBStore(dir)
    await backend1.append("alpha", makeMetaRecord())
    await backend1.append("beta", makeMetaRecord())
    await backend1.append("gamma", makeMetaRecord())
    await backend1.close()

    const backend2 = await createLevelDBStore(dir)
    const docIds = await collectAll(backend2.listDocIds())
    expect(docIds.sort()).toEqual(["alpha", "beta", "gamma"])
    await backend2.close()
  })
})

// ---------------------------------------------------------------------------
// Store-format gate
// ---------------------------------------------------------------------------

describe("LevelDBStore — store-format gate", () => {
  it("refuses an incompatible major and releases the lock so the dir reopens", async () => {
    const dir = makeTmpDir()

    // First open stamps {major:1,minor:0}; then corrupt it to a future major.
    const backend1 = await createLevelDBStore(dir)
    await backend1.append("doc-1", makeMetaRecord())
    await backend1.close()

    const raw = new ClassicLevel<string, Uint8Array>(dir, {
      valueEncoding: "binary",
    })
    await raw.put(
      "store-meta\x00format",
      new TextEncoder().encode(JSON.stringify({ major: 99, minor: 0 })),
    )
    await raw.close()

    // Open twice. Each must refuse *through the gate* with the major-mismatch
    // reason. A refused open that leaked its handle would hold the LevelDB
    // lock, so the second open would reject with a lock error — which has no
    // `reason` and would fail this match.
    const refusal = {
      name: "StoreFormatVersionError",
      reason: "incompatible-major",
    }
    await expect(createLevelDBStore(dir)).rejects.toMatchObject(refusal)
    await expect(createLevelDBStore(dir)).rejects.toMatchObject(refusal)
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

  it("round-trips an entry record with lineage set (json payload)", () => {
    const record: StoreRecord = {
      kind: "entry",
      payload: {
        kind: "entirety",
        encoding: "json",
        data: '{"hello":"world"}',
        lineage: "abc123",
      },
      version: "abc123:1",
    }
    const decoded = decodeStoreRecord(encodeStoreRecord(record))
    expect(decoded).toEqual(record)
  })

  it("round-trips an entry record with lineage set (binary payload)", () => {
    const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
    const record: StoreRecord = {
      kind: "entry",
      payload: {
        kind: "since",
        encoding: "binary",
        data: bytes,
        lineage: "inc-a",
      },
      version: "inc-a:5",
    }
    const decoded = decodeStoreRecord(encodeStoreRecord(record))
    expect(decoded).toEqual(record)
  })

  it("round-trips an entry record without lineage (legacy, bit 4 clear)", () => {
    const record: StoreRecord = makeEntryRecord("entirety", "v1")
    const encoded = encodeStoreRecord(record)
    expect(encoded[0]! & 0x10).toBe(0x00) // bit 4 clear — no lineage segment
    const decoded = decodeStoreRecord(encoded)
    expect(decoded.kind).toBe("entry")
    if (decoded.kind === "entry") {
      expect(decoded.payload.lineage).toBeUndefined()
    }
  })

  it("entry record with lineage has bit 4 set", () => {
    const record: StoreRecord = {
      kind: "entry",
      payload: {
        kind: "entirety",
        encoding: "json",
        data: "{}",
        lineage: "e1",
      },
      version: "e1:1",
    }
    const encoded = encodeStoreRecord(record)
    expect(encoded[0]! & 0x10).toBe(0x10) // bit 4 set — lineage segment present
  })
})
