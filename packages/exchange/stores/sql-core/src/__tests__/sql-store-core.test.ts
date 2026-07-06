// sql-store-core — pure-helpers unit tests.

import type { StoreMeta, StoreRecord } from "@kyneta/exchange"
import { SYNC_AUTHORITATIVE, SYNC_COLLABORATIVE } from "@kyneta/schema"
import { describe, expect, it } from "vitest"
import {
  DEFAULT_TABLES,
  fromRow,
  normalizeBlob,
  planAppend,
  planReplace,
  resolveTables,
  toRow,
} from "../index.js"

const baseMeta: StoreMeta = {
  replicaType: ["plain", 1, 0] as const,
  syncMode: SYNC_AUTHORITATIVE,
  schemaHash: "00test",
}

function metaRecord(overrides?: Partial<StoreMeta>): StoreRecord {
  return { kind: "meta", meta: { ...baseMeta, ...overrides } }
}

function jsonEntry(version: string, data = "{}"): StoreRecord {
  return {
    kind: "entry",
    payload: { kind: "entirety", encoding: "json", data },
    version,
  }
}

function binaryEntry(version: string, bytes: Uint8Array): StoreRecord {
  return {
    kind: "entry",
    payload: { kind: "since", encoding: "binary", data: bytes },
    version,
  }
}

// ---------------------------------------------------------------------------
// toRow / fromRow round-trips
// ---------------------------------------------------------------------------

describe("toRow / fromRow", () => {
  it("round-trips a meta record", () => {
    const record = metaRecord()
    const decoded = fromRow(toRow(record))
    expect(decoded).toEqual(record)
  })

  it("round-trips a JSON-string entry record", () => {
    const record = jsonEntry("v1", '{"hello":"world"}')
    const decoded = fromRow(toRow(record))
    expect(decoded).toEqual(record)
  })

  it("round-trips a binary Uint8Array entry record", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xfe])
    const record = binaryEntry("v2", bytes)
    const row = toRow(record)
    expect(row.blob).toEqual(bytes)
    const decoded = fromRow(row)
    expect(decoded.kind).toBe("entry")
    if (decoded.kind === "entry") {
      expect(decoded.payload.encoding).toBe("binary")
      expect(decoded.payload.data).toBeInstanceOf(Uint8Array)
      expect(decoded.payload.data).toEqual(bytes)
      expect(decoded.version).toBe("v2")
    }
  })

  it("round-trips a sequence of mixed records", () => {
    const records: StoreRecord[] = [
      metaRecord(),
      jsonEntry("v1"),
      binaryEntry("v2", new Uint8Array([1, 2, 3])),
      jsonEntry("v3", '{"a":1}'),
    ]
    for (const r of records) {
      expect(fromRow(toRow(r))).toEqual(r)
    }
  })

  it("round-trips a JSON-string entry record with epoch set", () => {
    const record: StoreRecord = {
      kind: "entry",
      payload: {
        kind: "entirety",
        encoding: "json",
        data: '{"hello":"world"}',
        epoch: "abc123",
      },
      version: "abc123:1",
    }
    const decoded = fromRow(toRow(record))
    expect(decoded).toEqual(record)
  })

  it("round-trips a binary entry record with epoch set", () => {
    const bytes = new Uint8Array([0x00, 0x01, 0xff, 0xfe])
    const record: StoreRecord = {
      kind: "entry",
      payload: {
        kind: "since",
        encoding: "binary",
        data: bytes,
        epoch: "inc-a",
      },
      version: "inc-a:2",
    }
    const decoded = fromRow(toRow(record))
    expect(decoded).toEqual(record)
  })

  it("round-trips an entry record without epoch (legacy)", () => {
    const record = jsonEntry("v1")
    const decoded = fromRow(toRow(record))
    expect(decoded.kind).toBe("entry")
    if (decoded.kind === "entry") {
      expect(decoded.payload.epoch).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// normalizeBlob
// ---------------------------------------------------------------------------

describe("normalizeBlob", () => {
  it("returns plain Uint8Array unchanged (constructor identity)", () => {
    const u8 = new Uint8Array([1, 2, 3])
    expect(normalizeBlob(u8)).toBe(u8)
  })

  it("converts a Buffer-like Uint8Array subclass into a plain Uint8Array", () => {
    // Simulate a Buffer (Buffer extends Uint8Array; toEqual would fail)
    const buf = Buffer.from([1, 2, 3])
    const normalized = normalizeBlob(buf)
    expect(normalized.constructor).toBe(Uint8Array)
    expect(normalized).toEqual(new Uint8Array([1, 2, 3]))
  })
})

// ---------------------------------------------------------------------------
// resolveTables
// ---------------------------------------------------------------------------

describe("resolveTables", () => {
  it("returns DEFAULT_TABLES when no options provided", () => {
    expect(resolveTables()).toEqual(DEFAULT_TABLES)
  })

  it("returns DEFAULT_TABLES when tables option is empty", () => {
    expect(resolveTables({})).toEqual(DEFAULT_TABLES)
    expect(resolveTables({ tables: {} })).toEqual(DEFAULT_TABLES)
  })

  it("applies a partial override (docMeta only)", () => {
    expect(resolveTables({ tables: { docMeta: "alt_meta" } })).toEqual({
      docMeta: "alt_meta",
      records: DEFAULT_TABLES.records,
      storeMeta: DEFAULT_TABLES.storeMeta,
    })
  })

  it("applies a partial override (records only)", () => {
    expect(resolveTables({ tables: { records: "alt_records" } })).toEqual({
      docMeta: DEFAULT_TABLES.docMeta,
      records: "alt_records",
      storeMeta: DEFAULT_TABLES.storeMeta,
    })
  })

  it("applies a full override", () => {
    expect(
      resolveTables({ tables: { docMeta: "m", records: "r", storeMeta: "s" } }),
    ).toEqual({
      docMeta: "m",
      records: "r",
      storeMeta: "s",
    })
  })

  it("default tables are kyneta_doc_meta, kyneta_records, kyneta_store_meta", () => {
    expect(DEFAULT_TABLES.docMeta).toBe("kyneta_doc_meta")
    expect(DEFAULT_TABLES.records).toBe("kyneta_records")
    expect(DEFAULT_TABLES.storeMeta).toBe("kyneta_store_meta")
  })
})

// ---------------------------------------------------------------------------
// planAppend
// ---------------------------------------------------------------------------

describe("planAppend", () => {
  it("returns upsertMeta non-null for a meta record", () => {
    const plan = planAppend("doc-1", metaRecord(), null, 0)
    expect(plan.upsertMeta).not.toBeNull()
    if (plan.upsertMeta !== null) {
      const parsed = JSON.parse(plan.upsertMeta.data) as StoreMeta
      expect(parsed).toEqual(baseMeta)
    }
    expect(plan.insertRecord.seq).toBe(0)
    expect(plan.insertRecord.row.kind).toBe("meta")
  })

  it("returns null upsertMeta for an entry record with prior meta", () => {
    const plan = planAppend("doc-1", jsonEntry("v1"), baseMeta, 1)
    expect(plan.upsertMeta).toBeNull()
    expect(plan.insertRecord.seq).toBe(1)
    expect(plan.insertRecord.row.kind).toBe("entry")
  })

  it("throws for an entry record without prior meta", () => {
    expect(() => planAppend("doc-1", jsonEntry("v1"), null, 0)).toThrow(
      /first record/,
    )
  })

  it("throws for a meta record incompatible with existing meta", () => {
    const existing: StoreMeta = {
      ...baseMeta,
      syncMode: SYNC_COLLABORATIVE,
    }
    expect(() => planAppend("doc-1", metaRecord(), existing, 1)).toThrow(
      /syncMode/,
    )
  })

  it("plans place the row at the supplied nextSeq", () => {
    const plan = planAppend("doc-1", jsonEntry("v9"), baseMeta, 42)
    expect(plan.insertRecord.seq).toBe(42)
  })
})

// ---------------------------------------------------------------------------
// planReplace
// ---------------------------------------------------------------------------

describe("planReplace", () => {
  it("returns a plan with rows at array-index seqs", () => {
    const records: StoreRecord[] = [
      metaRecord(),
      jsonEntry("v1"),
      jsonEntry("v2"),
    ]
    const plan = planReplace(records, null)

    expect(plan.records).toHaveLength(3)
    expect(plan.records[0]?.seq).toBe(0)
    expect(plan.records[1]?.seq).toBe(1)
    expect(plan.records[2]?.seq).toBe(2)

    const parsed = JSON.parse(plan.upsertMeta.data) as StoreMeta
    expect(parsed).toEqual(baseMeta)
  })

  it("uses the last meta in the batch for upsertMeta (LWW)", () => {
    const records: StoreRecord[] = [
      metaRecord({ schemaHash: "first" }),
      jsonEntry("v1"),
      metaRecord({ schemaHash: "last" }),
    ]
    const plan = planReplace(records, null)
    const parsed = JSON.parse(plan.upsertMeta.data) as StoreMeta
    expect(parsed.schemaHash).toBe("last")
  })

  it("throws when batch has no meta record", () => {
    expect(() => planReplace([jsonEntry("v1")], null)).toThrow(
      /at least one meta/,
    )
  })

  it("throws when batch meta conflicts with existing meta", () => {
    const existing: StoreMeta = {
      ...baseMeta,
      replicaType: ["loro", 1, 0] as const,
    }
    expect(() => planReplace([metaRecord()], existing)).toThrow(/replicaType/)
  })

  it("throws when batch contains conflicting meta records", () => {
    const records: StoreRecord[] = [
      metaRecord(),
      { kind: "meta", meta: { ...baseMeta, syncMode: SYNC_COLLABORATIVE } },
    ]
    expect(() => planReplace(records, null)).toThrow(/syncMode/)
  })
})

// failOnNthCall was retired in favour of `makeArmedFault`
// (`@kyneta/exchange/testing`); its behaviours are covered by that primitive's
// own unit test. jj:vzuwrotu
