// server — LevelDB storage backend for @kyneta/exchange.
//
// Implements the Store interface using classic-level.
//
// Key-space design (FoundationDB convention — \x00 null-byte separator):
//   meta\x00{docId}                       → JSON-encoded StoreMeta (materialized index)
//   record\x00{docId}\x00{seqNo}          → binary-encoded StoreRecord (unified stream)
//
// The \x00 separator cannot appear in valid UTF-8 strings, so no docId
// validation is needed — the key-space imposes zero constraints on callers.
//
// SeqNo is a zero-padded 16-digit monotonic counter per doc, tracked in
// memory. On reboot, the max seqNo for a doc is lazily discovered via a
// single reverse-iterator seek on first append.

import {
  type DocId,
  resolveMetaFromBatch,
  type Store,
  type StoreMeta,
  type StoreRecord,
} from "@kyneta/exchange"
import { ClassicLevel } from "classic-level"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEP = "\x00"
const META_PREFIX = `meta${SEP}`
const RECORD_PREFIX = `record${SEP}`
const SEQ_PAD = 16

// ---------------------------------------------------------------------------
// Binary envelope v2 — pure encode/decode for StoreRecord
// ---------------------------------------------------------------------------

// Flags byte layout:
//   bit 0: payload kind     (0 = entirety, 1 = since) — entry records only
//   bit 1: encoding         (0 = json, 1 = binary) — entry records only
//   bit 2: data type        (0 = string, 1 = Uint8Array) — entry records only
//   bit 3: record kind      (0 = entry, 1 = meta)
//   bit 7: future-format    (0 = current format, reserved)
//
// Meta records (bit 3 = 1):
//   [1 byte flags] [remaining: JSON-encoded StoreMeta]
//
// Entry records (bit 3 = 0):
//   [1 byte flags] [4 bytes version length BE] [N bytes version UTF-8] [remaining: payload data]

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeStoreRecord(record: StoreRecord): Uint8Array {
  if (record.kind === "meta") {
    const metaBytes = encoder.encode(JSON.stringify(record.meta))
    const buf = new Uint8Array(1 + metaBytes.length)
    buf[0] = 0x08 // bit 3 set (meta)
    buf.set(metaBytes, 1)
    return buf
  }

  // Entry record
  const { payload, version } = record

  let flags = 0
  if (payload.kind === "since") flags |= 0x01
  if (payload.encoding === "binary") flags |= 0x02

  const isDataBinary = payload.data instanceof Uint8Array
  if (isDataBinary) flags |= 0x04

  const versionBytes = encoder.encode(version)
  const dataBytes = isDataBinary
    ? (payload.data as Uint8Array)
    : encoder.encode(payload.data as string)

  const buf = new Uint8Array(1 + 4 + versionBytes.length + dataBytes.length)
  const view = new DataView(buf.buffer)

  buf[0] = flags
  view.setUint32(1, versionBytes.length, false) // big-endian
  buf.set(versionBytes, 5)
  buf.set(dataBytes, 5 + versionBytes.length)

  return buf
}

export function decodeStoreRecord(bytes: Uint8Array): StoreRecord {
  const flagByte = bytes[0]
  if (flagByte === undefined) throw new Error("empty store record bytes")
  const flags = flagByte

  // Check future-format flag (bit 7)
  if ((flags & 0x80) !== 0) {
    throw new Error("unknown store record format (future-format bit set)")
  }

  const isMeta = (flags & 0x08) !== 0

  if (isMeta) {
    const metaJson = decoder.decode(bytes.subarray(1))
    return { kind: "meta", meta: JSON.parse(metaJson) as StoreMeta }
  }

  // Entry record
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const kind = (flags & 0x01) !== 0 ? "since" : "entirety"
  const encoding = (flags & 0x02) !== 0 ? "binary" : "json"
  const isDataBinary = (flags & 0x04) !== 0

  const versionLen = view.getUint32(1, false)
  const version = decoder.decode(bytes.subarray(5, 5 + versionLen))

  const dataStart = 5 + versionLen
  const rawData = bytes.subarray(dataStart)

  const data: string | Uint8Array = isDataBinary
    ? new Uint8Array(rawData)
    : decoder.decode(rawData)

  return {
    kind: "entry",
    payload: { kind, encoding, data },
    version,
  }
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function metaKey(docId: DocId): string {
  return `${META_PREFIX}${docId}`
}

function recordPrefix(docId: DocId): string {
  return `${RECORD_PREFIX}${docId}${SEP}`
}

function recordKey(docId: DocId, seqNo: number): string {
  return `${recordPrefix(docId)}${String(seqNo).padStart(SEQ_PAD, "0")}`
}

function parseDocIdFromMetaKey(key: string): DocId {
  return key.slice(META_PREFIX.length)
}

function parseSeqNoFromRecordKey(key: string, docId: DocId): number {
  const prefix = recordPrefix(docId)
  return Number.parseInt(key.slice(prefix.length), 10)
}

// ---------------------------------------------------------------------------
// LevelDBStore
// ---------------------------------------------------------------------------

export class LevelDBStore implements Store {
  readonly #db: ClassicLevel<string, Uint8Array>
  readonly #seqNos: Map<DocId, number> = new Map()

  constructor(dbPath: string) {
    this.#db = new ClassicLevel(dbPath, {
      valueEncoding: "binary",
    })
  }

  // -------------------------------------------------------------------------
  // Private — seqNo management
  // -------------------------------------------------------------------------

  /**
   * Get the next seqNo for a doc. On first call after reboot, discovers
   * the max existing seqNo via a single reverse-iterator seek.
   */
  async #nextSeqNo(docId: DocId): Promise<number> {
    const cached = this.#seqNos.get(docId)
    if (cached !== undefined) {
      const next = cached + 1
      this.#seqNos.set(docId, next)
      return next
    }

    // Lazy discovery: reverse iterate to find the highest existing seqNo
    const prefix = recordPrefix(docId)
    let maxSeq = -1
    for await (const key of this.#db.keys({
      gte: prefix,
      lt: `${prefix}\xff`,
      reverse: true,
      limit: 1,
    })) {
      maxSeq = parseSeqNoFromRecordKey(key, docId)
    }

    const next = maxSeq + 1
    this.#seqNos.set(docId, next)
    return next
  }

  // -------------------------------------------------------------------------
  // Store interface
  // -------------------------------------------------------------------------

  async currentMeta(docId: DocId): Promise<StoreMeta | null> {
    try {
      const raw = await this.#db.get(metaKey(docId))
      return JSON.parse(decoder.decode(raw)) as StoreMeta
    } catch (error: any) {
      if (error.code === "LEVEL_NOT_FOUND") return null
      throw error
    }
  }

  async append(docId: DocId, record: StoreRecord): Promise<void> {
    const existingMeta = await this.currentMeta(docId)

    if (record.kind === "entry") {
      if (existingMeta === null) {
        throw new Error(
          `Store: first record for doc '${docId}' must be meta, got entry`,
        )
      }
    } else {
      // record.kind === "meta" — validate immutability via resolution
      const resolved = resolveMetaFromBatch([record], existingMeta)
      await this.#db.put(
        metaKey(docId),
        encoder.encode(JSON.stringify(resolved)),
      )
    }

    const seq = await this.#nextSeqNo(docId)
    await this.#db.put(recordKey(docId, seq), encodeStoreRecord(record))
  }

  async *loadAll(docId: DocId): AsyncIterable<StoreRecord> {
    const prefix = recordPrefix(docId)
    for await (const value of this.#db.values({
      gte: prefix,
      lt: `${prefix}\xff`,
    })) {
      yield decodeStoreRecord(value)
    }
  }

  async replace(docId: DocId, records: StoreRecord[]): Promise<void> {
    const existingMeta = await this.currentMeta(docId)

    // Resolve validates: at least one meta present, immutable fields match.
    const resolved = resolveMetaFromBatch(records, existingMeta)

    const prefix = recordPrefix(docId)

    // Collect existing record keys to delete
    const keysToDelete: string[] = []
    for await (const key of this.#db.keys({
      gte: prefix,
      lt: `${prefix}\xff`,
    })) {
      keysToDelete.push(key)
    }

    // Atomic batch: delete all existing records, write replacements, upsert meta
    const ops: Array<
      | { type: "del"; key: string }
      | { type: "put"; key: string; value: Uint8Array }
    > = keysToDelete.map(key => ({ type: "del" as const, key }))

    for (let i = 0; i < records.length; i++) {
      ops.push({
        type: "put",
        key: recordKey(docId, i),
        value: encodeStoreRecord(records[i]!),
      })
    }

    ops.push({
      type: "put",
      key: metaKey(docId),
      value: encoder.encode(JSON.stringify(resolved)),
    })

    await this.#db.batch(ops)

    // Reset seqNo counter to the last written index
    this.#seqNos.set(docId, records.length - 1)
  }

  async delete(docId: DocId): Promise<void> {
    const prefix = recordPrefix(docId)

    // Collect record keys to delete
    const keysToDelete: string[] = [metaKey(docId)]
    for await (const key of this.#db.keys({
      gte: prefix,
      lt: `${prefix}\xff`,
    })) {
      keysToDelete.push(key)
    }

    await this.#db.batch(
      keysToDelete.map(key => ({ type: "del" as const, key })),
    )

    // Remove from in-memory seqNo tracker
    this.#seqNos.delete(docId)
  }

  async *listDocIds(prefix?: string): AsyncIterable<DocId> {
    const rangePrefix =
      prefix !== undefined ? `${META_PREFIX}${prefix}` : META_PREFIX
    for await (const key of this.#db.keys({
      gte: rangePrefix,
      lt: `${rangePrefix}\xff`,
    })) {
      yield parseDocIdFromMetaKey(key)
    }
  }

  async close(): Promise<void> {
    await this.#db.close()
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a LevelDB storage backend for server-side persistence.
 *
 * Returns a `Store` — pass directly to `Exchange({ stores: [...] })`.
 *
 * @param dbPath - Directory path where LevelDB stores its files
 *
 * @example
 * ```typescript
 * import { createLevelDBStore } from "@kyneta/leveldb-store"
 *
 * const exchange = new Exchange({
 *   stores: [createLevelDBStore("./data/exchange-db")],
 * })
 * ```
 */
export function createLevelDBStore(dbPath: string): Store {
  return new LevelDBStore(dbPath)
}
