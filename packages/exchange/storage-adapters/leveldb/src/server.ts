// server — LevelDB storage backend for @kyneta/exchange.
//
// Implements the StorageBackend interface using classic-level.
//
// Key-space design (FoundationDB convention — \x00 null-byte separator):
//   meta\x00{docId}                    → JSON-encoded DocMetadata
//   entry\x00{docId}\x00{seqNo}       → binary-encoded StorageEntry
//
// The \x00 separator cannot appear in valid UTF-8 strings, so no docId
// validation is needed — the key-space imposes zero constraints on callers.
//
// SeqNo is a zero-padded 10-digit monotonic counter per doc, tracked in
// memory. On reboot, the max seqNo for a doc is lazily discovered via a
// single reverse-iterator seek on first append.

import type { DocMetadata } from "@kyneta/schema"
import type {
  StorageBackend,
  StorageEntry,
} from "@kyneta/exchange/src/storage/storage-backend.js"
import type { DocId } from "@kyneta/exchange/src/types.js"
import { ClassicLevel } from "classic-level"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SEP = "\x00"
const META_PREFIX = `meta${SEP}`
const ENTRY_PREFIX = `entry${SEP}`
const SEQ_PAD = 10

// ---------------------------------------------------------------------------
// Binary envelope — pure encode/decode for StorageEntry
// ---------------------------------------------------------------------------

// Flags byte layout:
//   bit 0: kind        (0 = entirety, 1 = since)
//   bit 1: encoding    (0 = json, 1 = binary)
//   bit 2: data type   (0 = string, 1 = Uint8Array)
//
// Layout: [1 byte flags] [4 bytes version length BE] [N bytes version UTF-8] [remaining: payload data]

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function encodeStorageEntry(entry: StorageEntry): Uint8Array {
  const { payload, version } = entry

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

export function decodeStorageEntry(bytes: Uint8Array): StorageEntry {
  const view = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  )

  const flags = bytes[0]!
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

function entryPrefix(docId: DocId): string {
  return `${ENTRY_PREFIX}${docId}${SEP}`
}

function entryKey(docId: DocId, seqNo: number): string {
  return `${entryPrefix(docId)}${String(seqNo).padStart(SEQ_PAD, "0")}`
}

function parseDocIdFromMetaKey(key: string): DocId {
  return key.slice(META_PREFIX.length)
}

function parseSeqNoFromEntryKey(key: string, docId: DocId): number {
  const prefix = entryPrefix(docId)
  return Number.parseInt(key.slice(prefix.length), 10)
}

// ---------------------------------------------------------------------------
// LevelDBStorageBackend
// ---------------------------------------------------------------------------

export class LevelDBStorageBackend implements StorageBackend {
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
    const prefix = entryPrefix(docId)
    let maxSeq = -1
    for await (const key of this.#db.keys({
      gte: prefix,
      lt: `${prefix}\xff`,
      reverse: true,
      limit: 1,
    })) {
      maxSeq = parseSeqNoFromEntryKey(key, docId)
    }

    const next = maxSeq + 1
    this.#seqNos.set(docId, next)
    return next
  }

  // -------------------------------------------------------------------------
  // StorageBackend interface
  // -------------------------------------------------------------------------

  async lookup(docId: DocId): Promise<DocMetadata | null> {
    try {
      const raw = await this.#db.get(metaKey(docId))
      return JSON.parse(decoder.decode(raw)) as DocMetadata
    } catch (error: any) {
      if (error.code === "LEVEL_NOT_FOUND") return null
      throw error
    }
  }

  async ensureDoc(docId: DocId, metadata: DocMetadata): Promise<void> {
    try {
      await this.#db.get(metaKey(docId))
      // Already exists — no-op (first call wins)
    } catch (error: any) {
      if (error.code === "LEVEL_NOT_FOUND") {
        await this.#db.put(
          metaKey(docId),
          encoder.encode(JSON.stringify(metadata)),
        )
        return
      }
      throw error
    }
  }

  async append(docId: DocId, entry: StorageEntry): Promise<void> {
    const seq = await this.#nextSeqNo(docId)
    await this.#db.put(entryKey(docId, seq), encodeStorageEntry(entry))
  }

  async *loadAll(docId: DocId): AsyncIterable<StorageEntry> {
    const prefix = entryPrefix(docId)
    for await (const value of this.#db.values({
      gte: prefix,
      lt: `${prefix}\xff`,
    })) {
      yield decodeStorageEntry(value)
    }
  }

  async replace(docId: DocId, entry: StorageEntry): Promise<void> {
    const prefix = entryPrefix(docId)

    // Collect keys to delete
    const keysToDelete: string[] = []
    for await (const key of this.#db.keys({
      gte: prefix,
      lt: `${prefix}\xff`,
    })) {
      keysToDelete.push(key)
    }

    // Atomic batch: delete all existing entries + write the single replacement
    const ops: Array<
      | { type: "del"; key: string }
      | { type: "put"; key: string; value: Uint8Array }
    > = keysToDelete.map(key => ({ type: "del" as const, key }))
    ops.push({
      type: "put",
      key: entryKey(docId, 0),
      value: encodeStorageEntry(entry),
    })
    await this.#db.batch(ops)

    // Reset seqNo counter
    this.#seqNos.set(docId, 0)
  }

  async delete(docId: DocId): Promise<void> {
    const prefix = entryPrefix(docId)

    // Collect entry keys to delete
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

  async *listDocIds(): AsyncIterable<DocId> {
    for await (const key of this.#db.keys({
      gte: META_PREFIX,
      lt: `${META_PREFIX}\xff`,
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
 * Returns a `StorageBackend` — pass directly to `Exchange({ storage: [...] })`.
 *
 * @param dbPath - Directory path where LevelDB stores its files
 *
 * @example
 * ```typescript
 * import { createLevelDBStorage } from "@kyneta/leveldb-storage-backend/server"
 *
 * const exchange = new Exchange({
 *   storage: [createLevelDBStorage("./data/exchange-db")],
 * })
 * ```
 */
export function createLevelDBStorage(dbPath: string): StorageBackend {
  return new LevelDBStorageBackend(dbPath)
}