// server — LevelDB storage backend for @kyneta/exchange.
//
// Implements the Store interface using classic-level.
//
// Key-space design (FoundationDB convention — \x00 null-byte separator):
//   doc-meta\x00{docId}                   → JSON-encoded StoreMeta (materialized index)
//   record\x00{docId}\x00{seqNo}          → binary-encoded StoreRecord (unified stream)
//   store-meta\x00{key}                   → store-global metadata (e.g. format version)
//
// The \x00 separator cannot appear in valid UTF-8 strings, so no docId
// validation is needed — the key-space imposes zero constraints on callers.
//
// SeqNo is a zero-padded 16-digit monotonic counter per doc, tracked in
// memory. On reboot, the max seqNo for a doc is lazily discovered via a
// single reverse-iterator seek on first append.

import {
  type DocId,
  decideStoreFormat,
  parseStoreFormat,
  resolveMetaFromBatch,
  SeqNoTracker,
  STORE_META_FORMAT_KEY,
  type Store,
  type StoreFormatVersion,
  StoreFormatVersionError,
  type StoreMeta,
  type StoreRecord,
  validateAppend,
} from "@kyneta/exchange"
import { ClassicLevel } from "classic-level"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEP = "\x00"
const DOC_META_PREFIX = `doc-meta${SEP}`
const RECORD_PREFIX = `record${SEP}`
const SEQ_PAD = 16

// Store-global metadata namespace, keyed `store-meta\x00{key}`. It sorts
// above `doc-meta\x00` ('d' < 's') and `record\x00` ('r' < 's'), so it is
// outside every `doc-meta`/`record` iteration range and needs no filtering.
// Do not relocate it into those ranges. The on-disk format version lives at
// `store-meta\x00format`. This is read by a bootstrap reader on open, never
// through the Store interface. Context: jj:uvssotsy.
const STORE_META_PREFIX = `store-meta${SEP}`
const STORE_FORMAT_KEY = `${STORE_META_PREFIX}${STORE_META_FORMAT_KEY}`

// LevelDB owns its own on-disk format version (its binary envelope), gated on
// open via `decideStoreFormat`. Distinct from the envelope's per-record bit-7
// guard (`decodeStoreRecord`): bit-7 guards one record's decode; this marker
// guards opening the store at all.
const STORE_FORMAT_VERSION: StoreFormatVersion = { major: 1, minor: 0 }

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

function docMetaKey(docId: DocId): string {
  return `${DOC_META_PREFIX}${docId}`
}

function recordPrefix(docId: DocId): string {
  return `${RECORD_PREFIX}${docId}${SEP}`
}

function recordKey(docId: DocId, seqNo: number): string {
  return `${recordPrefix(docId)}${String(seqNo).padStart(SEQ_PAD, "0")}`
}

function parseDocIdFromDocMetaKey(key: string): DocId {
  return key.slice(DOC_META_PREFIX.length)
}

function parseSeqNoFromRecordKey(key: string, docId: DocId): number {
  const prefix = recordPrefix(docId)
  return Number.parseInt(key.slice(prefix.length), 10)
}

// ---------------------------------------------------------------------------
// Write planning — pure gather/plan/execute split (mirrors sql-core)
// ---------------------------------------------------------------------------

type BatchOp =
  | { readonly type: "put"; readonly key: string; readonly value: Uint8Array }
  | { readonly type: "del"; readonly key: string }

// Pure StoreMeta JSON envelope, shared by the writers (append/replace) and the
// reader (currentMeta). The store-format marker keeps its own JSON.stringify —
// it serializes a StoreFormatVersion, not a StoreMeta.
function encodeDocMeta(meta: StoreMeta): Uint8Array {
  return encoder.encode(JSON.stringify(meta))
}
function decodeDocMeta(bytes: Uint8Array): StoreMeta {
  return JSON.parse(decoder.decode(bytes)) as StoreMeta
}

/**
 * Pure: validate the record against existing meta and return the LevelDB batch
 * ops to write. Mirrors sql-core's `planAppend` (the gather/plan/execute split,
 * jj:pzuytnvo). An entry record yields a single record `put`; a meta record
 * adds the doc-meta index `put`, and the two commit together in one batch.
 * `validateAppend` throws on an entry-before-meta violation — a pure,
 * input-deterministic throw.
 */
function planAppend(
  docId: DocId,
  record: StoreRecord,
  existingMeta: StoreMeta | null,
  seq: number,
): BatchOp[] {
  const resolved = validateAppend(docId, record, existingMeta)
  const ops: BatchOp[] = [
    {
      type: "put",
      key: recordKey(docId, seq),
      value: encodeStoreRecord(record),
    },
  ]
  if (resolved !== null) {
    ops.push({
      type: "put",
      key: docMetaKey(docId),
      value: encodeDocMeta(resolved),
    })
  }
  return ops
}

// ---------------------------------------------------------------------------
// LevelDBStore
// ---------------------------------------------------------------------------

export class LevelDBStore implements Store {
  readonly #db: ClassicLevel<string, Uint8Array>
  readonly #seqNos = new SeqNoTracker()

  // Accepts a path (constructs a ClassicLevel) or an already-built handle. The
  // handle form is the test seam for fault injection — production callers pass
  // a path via `createLevelDBStore` / `open`. jj:pzuytnvo
  constructor(dbPathOrDb: string | ClassicLevel<string, Uint8Array>) {
    this.#db =
      typeof dbPathOrDb === "string"
        ? new ClassicLevel(dbPathOrDb, { valueEncoding: "binary" })
        : dbPathOrDb
  }

  // -------------------------------------------------------------------------
  // Store interface
  // -------------------------------------------------------------------------

  async currentMeta(docId: DocId): Promise<StoreMeta | null> {
    try {
      const raw = await this.#db.get(docMetaKey(docId))
      return decodeDocMeta(raw)
    } catch (error: any) {
      if (error.code === "LEVEL_NOT_FOUND") return null
      throw error
    }
  }

  async append(docId: DocId, record: StoreRecord): Promise<void> {
    const existingMeta = await this.currentMeta(docId)

    // SeqNoTracker.next advances the in-memory counter before the write lands.
    // On a caught write failure the counter runs one ahead of disk → a benign
    // sparse seqNo (records are range-scanned, not indexed contiguously); it
    // self-heals on reopen via the cold-start seek. Context: jj:pzuytnvo.
    const seq = await this.#seqNos.next(docId, async () => {
      const prefix = recordPrefix(docId)
      for await (const key of this.#db.keys({
        gte: prefix,
        lt: `${prefix}\xff`,
        reverse: true,
        limit: 1,
      })) {
        return parseSeqNoFromRecordKey(key, docId)
      }
      return null
    })

    // Single atomic batch: an entry append is a one-op batch (record only); a
    // meta append commits the record and the doc-meta index together, so a
    // crash never advances the index past its backing record. jj:pzuytnvo
    await this.#db.batch(planAppend(docId, record, existingMeta, seq))
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
    const ops: BatchOp[] = keysToDelete.map(key => ({
      type: "del" as const,
      key,
    }))

    for (let i = 0; i < records.length; i++) {
      ops.push({
        type: "put",
        key: recordKey(docId, i),
        value: encodeStoreRecord(records[i]!),
      })
    }

    ops.push({
      type: "put",
      key: docMetaKey(docId),
      value: encodeDocMeta(resolved),
    })

    await this.#db.batch(ops)

    // Reset seqNo counter to the last written index
    this.#seqNos.reset(docId, records.length - 1)
  }

  async delete(docId: DocId): Promise<void> {
    const prefix = recordPrefix(docId)

    // Collect record keys to delete
    const keysToDelete: string[] = [docMetaKey(docId)]
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
    this.#seqNos.remove(docId)
  }

  async *listDocIds(prefix?: string): AsyncIterable<DocId> {
    const rangePrefix =
      prefix !== undefined ? `${DOC_META_PREFIX}${prefix}` : DOC_META_PREFIX
    for await (const key of this.#db.keys({
      gte: rangePrefix,
      lt: `${rangePrefix}\xff`,
    })) {
      yield parseDocIdFromDocMetaKey(key)
    }
  }

  async close(): Promise<void> {
    await this.#db.close()
  }

  // Bootstrap reader: consult the store-format marker before trusting any
  // bytes. Stamps a brand-new store, accepts a compatible one, or throws.
  // A `static open` reaches this private method so the gate stays internal.
  async #assertFormat(): Promise<void> {
    let parsed: StoreFormatVersion | "malformed" | null = null
    try {
      const raw = await this.#db.get(STORE_FORMAT_KEY)
      parsed = parseStoreFormat(decoder.decode(raw))
    } catch (error: any) {
      if (error.code !== "LEVEL_NOT_FOUND") throw error
      // absent → parsed stays null
    }
    if (parsed === "malformed") {
      throw new StoreFormatVersionError({
        reason: "malformed-version",
        backend: "leveldb",
        stored: null,
        current: STORE_FORMAT_VERSION,
      })
    }

    // Empty-store probe: does any doc-meta key exist?
    let hasData = false
    for await (const _key of this.#db.keys({
      gte: DOC_META_PREFIX,
      lt: `${DOC_META_PREFIX}\xff`,
      limit: 1,
    })) {
      hasData = true
    }

    const decision = decideStoreFormat({
      current: STORE_FORMAT_VERSION,
      stored: parsed,
      storeHasData: hasData,
    })

    if (decision.action === "refuse") {
      throw new StoreFormatVersionError({
        reason: decision.reason,
        backend: "leveldb",
        stored: parsed,
        current: STORE_FORMAT_VERSION,
      })
    }
    if (decision.action === "stamp") {
      await this.#db.put(
        STORE_FORMAT_KEY,
        encoder.encode(JSON.stringify(decision.value)),
      )
    }
  }

  /** Open the store and run the store-format gate. Used by `createLevelDBStore`. */
  static async open(
    dbPathOrDb: string | ClassicLevel<string, Uint8Array>,
  ): Promise<Store> {
    const store = new LevelDBStore(dbPathOrDb)
    try {
      await store.#assertFormat()
    } catch (error) {
      // A refused store must not leak its file handle / lock.
      await store.#db.close()
      throw error
    }
    return store
  }
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a LevelDB storage backend for server-side persistence.
 *
 * Async: it opens the database and runs the store-format gate (stamping a
 * brand-new store, accepting a compatible one, or throwing
 * `StoreFormatVersionError`). `await` it before passing to the `Exchange`.
 *
 * @param dbPath - Directory path where LevelDB stores its files
 *
 * @example
 * ```typescript
 * import { createLevelDBStore } from "@kyneta/leveldb-store"
 *
 * const exchange = new Exchange({
 *   stores: [await createLevelDBStore("./data/exchange-db")],
 * })
 * ```
 */
export function createLevelDBStore(dbPath: string): Promise<Store> {
  return LevelDBStore.open(dbPath)
}
