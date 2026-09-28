// server — LevelDB storage backend for @kyneta/exchange.
//
// Implements the Store interface using classic-level.
//
// Key-space design (FoundationDB convention — \x00 null-byte separator):
//   doc-meta\x00{docId}                   → JSON-encoded StoreMeta (materialized index)
//   record\x00{docId}\x00{seqNo}          → binary-encoded StoreRecord (unified stream)
//   store-meta\x00{key}                   → store-global metadata (format version, seat pool)
//
// The \x00 separator cannot appear in valid UTF-8 strings, so no docId
// validation is needed — the key-space imposes zero constraints on callers.
//
// SeqNo is a zero-padded 16-digit monotonic counter per doc, tracked in
// memory. On reboot, the max seqNo for a doc is lazily discovered via a
// single reverse-iterator seek on first append.
//
// `classic-level` locks the directory, so one open store owns it. Its seat is
// `owned`: the pool's one seat, reused on every open, and unfenced, since the
// handle that holds the lock is the one that writes (and a `batch` is
// write-only, so it could not read a fence anyway).

import {
  type DocId,
  freshPeerIds,
  type OwnedSeat,
  type PeerId,
  planStoreOpen,
  prefixSuccessor,
  resolveMetaFromBatch,
  STORE_META_FORMAT_KEY,
  STORE_META_SEATS_KEY,
  type Store,
  type StoreFormatVersion,
  type StoreMark,
  type StoreMeta,
  type StoreRecord,
  validateAppend,
  type WriteOptions,
} from "@kyneta/exchange"
import { ClassicLevel } from "classic-level"
import { SeqNoTracker } from "./seq-tracker.js"

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
// `store-meta\x00format`, the seat pool at `store-meta\x00seats`. Both are
// read on open, never through the Store interface. Context: jj:uvssotsy.
const STORE_META_PREFIX = `store-meta${SEP}`
const STORE_FORMAT_KEY = `${STORE_META_PREFIX}${STORE_META_FORMAT_KEY}`
const STORE_SEATS_KEY = `${STORE_META_PREFIX}${STORE_META_SEATS_KEY}`

// LevelDB owns its own on-disk format version (its binary envelope), checked
// on open by `planStoreOpen`. Distinct from the envelope's per-record bit-7
// guard (`decodeStoreRecord`): bit-7 guards one record's decode; this marker
// guards opening the store at all.
// 1.1: `store-meta\x00seats` holds the seat pool. Older stores read as an
// empty pool.
const STORE_FORMAT_VERSION: StoreFormatVersion = { major: 1, minor: 1 }

// ---------------------------------------------------------------------------
// Binary envelope v2 — pure encode/decode for StoreRecord
// ---------------------------------------------------------------------------

// Flags byte layout:
//   bit 0: payload kind     (0 = entirety, 1 = since) — entry records only
//   bit 1: encoding         (0 = json, 1 = binary) — entry records only
//   bit 2: data type        (0 = string, 1 = Uint8Array) — entry records only
//   bit 3: record kind      (0 = entry, 1 = meta)
//   bit 4: lineage present    (0 = absent/legacy, 1 = lineage segment follows version) — entry records only
//   bit 7: future-format    (0 = current format, reserved)
//
// Meta records (bit 3 = 1):
//   [1 byte flags] [remaining: JSON-encoded StoreMeta]
//
// Entry records (bit 3 = 0):
//   [1 byte flags] [4 bytes version length BE] [N bytes version UTF-8]
//   [4 bytes lineage length BE] [M bytes lineage UTF-8]   (only present if bit 4 is set)
//   [remaining: payload data]
//
// The lineage segment is additive and gated by bit 4 so pre-lineage records
// (bit 4 = 0) decode unchanged — no migration needed for existing stores.

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

  const hasLineage = payload.lineage !== undefined
  if (hasLineage) flags |= 0x10

  const versionBytes = encoder.encode(version)
  const lineageBytes = hasLineage ? encoder.encode(payload.lineage) : undefined
  const dataBytes = isDataBinary
    ? (payload.data as Uint8Array)
    : encoder.encode(payload.data as string)

  const lineageSegmentLength = lineageBytes ? 4 + lineageBytes.length : 0
  const buf = new Uint8Array(
    1 + 4 + versionBytes.length + lineageSegmentLength + dataBytes.length,
  )
  const view = new DataView(buf.buffer)

  buf[0] = flags
  view.setUint32(1, versionBytes.length, false) // big-endian
  buf.set(versionBytes, 5)

  let offset = 5 + versionBytes.length
  if (lineageBytes) {
    view.setUint32(offset, lineageBytes.length, false)
    buf.set(lineageBytes, offset + 4)
    offset += 4 + lineageBytes.length
  }

  buf.set(dataBytes, offset)

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
  const hasLineage = (flags & 0x10) !== 0

  const versionLen = view.getUint32(1, false)
  const version = decoder.decode(bytes.subarray(5, 5 + versionLen))

  let offset = 5 + versionLen
  let lineage: string | undefined
  if (hasLineage) {
    const lineageLen = view.getUint32(offset, false)
    lineage = decoder.decode(
      bytes.subarray(offset + 4, offset + 4 + lineageLen),
    )
    offset += 4 + lineageLen
  }

  const rawData = bytes.subarray(offset)

  const data: string | Uint8Array = isDataBinary
    ? new Uint8Array(rawData)
    : decoder.decode(rawData)

  return {
    kind: "entry",
    payload: {
      kind,
      encoding,
      data,
      ...(lineage !== undefined ? { lineage } : {}),
    },
    version,
  }
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

function docMetaKey(docId: DocId): string {
  return `${DOC_META_PREFIX}${docId}`
}

/**
 * The key range holding exactly the keys that start with `prefix`. Keys are
 * compared as UTF-8 bytes, which is code-point order. A sentinel such as
 * `prefix + "\xff"` is not this range: it encodes as `C3 BF`, below every
 * character from U+0100 on, so a document id continuing with one fell
 * outside it.
 */
function keysWithPrefix(prefix: string): { gte: string; lt?: string } {
  const lt = prefixSuccessor(prefix, "code-point")
  return lt === null ? { gte: prefix } : { gte: prefix, lt }
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
  readonly seat: OwnedSeat
  readonly #db: ClassicLevel<string, Uint8Array>
  readonly #seqNos = new SeqNoTracker()

  private constructor(db: ClassicLevel<string, Uint8Array>, seat: OwnedSeat) {
    this.#db = db
    this.seat = seat
  }

  // -------------------------------------------------------------------------
  // Store interface
  // -------------------------------------------------------------------------

  /**
   * Always `null`: an owned directory has one writer by construction, so it
   * records none, and `append` and `compact` ignore their `WriteOptions`.
   */
  async writerOf(_docId: DocId): Promise<PeerId | null> {
    if (this.#db.status !== "open") {
      throw new Error("LevelDBStore: the store is closed")
    }
    return null
  }

  async currentMeta(docId: DocId): Promise<StoreMeta | null> {
    try {
      const raw = await this.#db.get(docMetaKey(docId))
      return decodeDocMeta(raw)
    } catch (error: any) {
      if (error.code === "LEVEL_NOT_FOUND") return null
      throw error
    }
  }

  async append(
    docId: DocId,
    record: StoreRecord,
    _options: WriteOptions,
  ): Promise<void> {
    const existingMeta = await this.currentMeta(docId)

    const seq = await this.#nextSeq(docId)

    // Single atomic batch: an entry append is a one-op batch (record only); a
    // meta append commits the record and the doc-meta index together, so a
    // crash never advances the index past its backing record. jj:pzuytnvo
    await this.#db.batch(planAppend(docId, record, existingMeta, seq))
  }

  async *loadAll(docId: DocId): AsyncIterable<StoreRecord> {
    const prefix = recordPrefix(docId)
    for await (const value of this.#db.values({
      ...keysWithPrefix(prefix),
    })) {
      yield decodeStoreRecord(value)
    }
  }

  async mark(docId: DocId): Promise<StoreMark | null> {
    return this.#lastSeq(docId)
  }

  async compact(
    docId: DocId,
    records: StoreRecord[],
    through: StoreMark | null,
    _options: WriteOptions,
  ): Promise<void> {
    const existingMeta = await this.currentMeta(docId)

    // Resolve validates: at least one meta present, immutable fields match.
    const resolved = resolveMetaFromBatch(records, existingMeta)

    // Atomic batch: delete the records at or before the mark, write the new
    // ones after everything that remains, upsert meta.
    const ops: BatchOp[] = []
    if (through !== null) {
      const prefix = recordPrefix(docId)
      for await (const key of this.#db.keys({
        gte: prefix,
        lte: recordKey(docId, through),
      })) {
        ops.push({ type: "del", key })
      }
    }
    for (const record of records) {
      ops.push({
        type: "put",
        key: recordKey(docId, await this.#nextSeq(docId)),
        value: encodeStoreRecord(record),
      })
    }
    ops.push({
      type: "put",
      key: docMetaKey(docId),
      value: encodeDocMeta(resolved),
    })

    await this.#db.batch(ops)
  }

  /**
   * The next record's sequence number. Kept in memory, which is sound only
   * because `classic-level` refuses a second open of a directory, so this
   * instance is the only writer.
   *
   * The counter advances before the write lands. On a caught write failure it
   * runs ahead of disk, leaving a benign gap (records are range-scanned, not
   * indexed contiguously) that a reopen does not repeat. Context: jj:pzuytnvo.
   */
  #nextSeq(docId: DocId): Promise<number> {
    return this.#seqNos.next(docId, () => this.#lastSeq(docId))
  }

  /** The sequence number of the document's last record on disk. */
  async #lastSeq(docId: DocId): Promise<number | null> {
    const prefix = recordPrefix(docId)
    for await (const key of this.#db.keys({
      ...keysWithPrefix(prefix),
      reverse: true,
      limit: 1,
    })) {
      return parseSeqNoFromRecordKey(key, docId)
    }
    return null
  }

  async delete(docId: DocId): Promise<void> {
    const prefix = recordPrefix(docId)

    // Collect record keys to delete
    const keysToDelete: string[] = [docMetaKey(docId)]
    for await (const key of this.#db.keys({
      ...keysWithPrefix(prefix),
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
    for await (const key of this.#db.keys(
      keysWithPrefix(`${DOC_META_PREFIX}${prefix ?? ""}`),
    )) {
      yield parseDocIdFromDocMetaKey(key)
    }
  }

  async close(): Promise<void> {
    await this.#db.close()
  }

  /**
   * Open the store, holding the directory's seat. Throws
   * `StoreFormatVersionError` for a store this build cannot read, and when
   * another handle holds the directory.
   *
   * Accepts a path, or an already-built handle: the test seam for fault
   * injection. jj:pzuytnvo
   */
  static async open(
    dbPathOrDb: string | ClassicLevel<string, Uint8Array>,
  ): Promise<LevelDBStore> {
    const db =
      typeof dbPathOrDb === "string"
        ? new ClassicLevel<string, Uint8Array>(dbPathOrDb, {
            valueEncoding: "binary",
          })
        : dbPathOrDb
    try {
      return new LevelDBStore(db, await openSeat(db))
    } catch (error) {
      // A refused store must not leak its file handle / lock.
      await db.close()
      throw error
    }
  }
}

/**
 * Read the store-wide metadata, plan the open, and write what it says in one
 * batch.
 */
async function openSeat(
  db: ClassicLevel<string, Uint8Array>,
): Promise<OwnedSeat> {
  const read = async (key: string): Promise<string | undefined> => {
    try {
      return decoder.decode(await db.get(key))
    } catch (error: any) {
      if (error.code === "LEVEL_NOT_FOUND") return undefined
      throw error
    }
  }
  let hasData = false
  for await (const _key of db.keys({
    ...keysWithPrefix(DOC_META_PREFIX),
    limit: 1,
  })) {
    hasData = true
  }
  const plan = planStoreOpen({
    backend: "leveldb",
    current: STORE_FORMAT_VERSION,
    storedFormat: await read(STORE_FORMAT_KEY),
    storeHasData: hasData,
    storedPool: await read(STORE_SEATS_KEY),
    seating: { kind: "owned" },
    fresh: freshPeerIds(),
  })
  if (plan.action === "refuse") throw plan.error
  const ops: BatchOp[] = []
  if (plan.writeFormat !== undefined) {
    ops.push({
      type: "put",
      key: STORE_FORMAT_KEY,
      value: encoder.encode(JSON.stringify(plan.writeFormat)),
    })
  }
  if (plan.writePool !== undefined) {
    ops.push({
      type: "put",
      key: STORE_SEATS_KEY,
      value: encoder.encode(JSON.stringify(plan.writePool)),
    })
  }
  if (ops.length > 0) await db.batch(ops)
  return plan.seat
}

// ---------------------------------------------------------------------------
// Factory function
// ---------------------------------------------------------------------------

/**
 * Create a LevelDB storage backend for server-side persistence.
 *
 * Async: it opens the database, checks its format (stamping a brand-new
 * store, accepting a compatible one, or throwing `StoreFormatVersionError`)
 * and takes its seat, the same on every open. `await` it before passing to
 * the `Exchange`. A second open of the directory while one holds it throws.
 *
 * @param dbPath - Directory path where LevelDB stores its files
 *
 * @example
 * ```typescript
 * import { createLevelDBStore } from "@kyneta/leveldb-store"
 *
 * const exchange = new Exchange({
 *   store: await createLevelDBStore("./data/exchange-db"),
 * })
 * ```
 */
export function createLevelDBStore(dbPath: string): Promise<Store> {
  return LevelDBStore.open(dbPath)
}
