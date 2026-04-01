// storage-backend — persistence contract for storage adapters.
//
// The StorageBackend interface defines six document-level operations
// that concrete backends implement. Backends need no knowledge of the
// sync protocol, substrates, merge strategies, or schemas.
//
// The StorageAdapter base class guarantees that for any given docId,
// these methods are called sequentially — never concurrently.
// Backends may assume single-writer-per-document semantics.

import type { SubstratePayload } from "@kyneta/schema"
import type { DocId } from "../types.js"

// ---------------------------------------------------------------------------
// StorageEntry — the unit of persistence
// ---------------------------------------------------------------------------

/**
 * A stored entry — the SubstratePayload plus the version string
 * from the offer that produced it. Storage round-trips these
 * faithfully; it never interprets either field.
 *
 * The `payload` carries its own `kind` discriminant (`"entirety"` or
 * `"since"`), so no separate `entryType` field is needed.
 *
 * The `version` field is the serialized Version string from the
 * original offer. It is persisted alongside the payload so that
 * the storage adapter can send truthful `offer` messages during
 * hydration without needing to deserialize or reconstruct the payload.
 */
export type StorageEntry = {
  readonly payload: SubstratePayload
  readonly version: string
}

// ---------------------------------------------------------------------------
// StorageBackend — the persistence interface
// ---------------------------------------------------------------------------

/**
 * The persistence contract for a storage adapter.
 *
 * Concrete backends implement these six methods. They need no
 * knowledge of the sync protocol, substrates, merge strategies,
 * or schemas.
 *
 * The StorageAdapter base class guarantees that for any given docId,
 * these methods are called sequentially — never concurrently.
 * Backends may assume single-writer-per-document semantics.
 *
 * `replace` must be atomic: a concurrent reader must never observe
 * an empty intermediate state — it sees either the pre-replace or
 * post-replace entries.
 *
 * Achievable on all target backends:
 * - Postgres: transaction
 * - LevelDB: batch
 * - IndexedDB: transaction
 * - Redis: MULTI/EXEC
 * - In-memory: synchronous swap
 * - S3: write-before-delete
 */
export interface StorageBackend {
  /**
   * Append an entry for a document. Called on each incoming offer.
   * Entries are returned by `loadAll` in insertion order.
   */
  append(docId: DocId, entry: StorageEntry): Promise<void>

  /**
   * Check whether storage has any entries for a document.
   * Used by storage-first sync probes — avoids loading all entries
   * just to answer "do you have this doc?"
   */
  has(docId: DocId): Promise<boolean>

  /**
   * Load all entries for a document, yielding in insertion order.
   * Returns an AsyncIterable to support pagination for large stores
   * (S3, Postgres) without loading everything into memory.
   *
   * For a nonexistent document, yields nothing (no error).
   */
  loadAll(docId: DocId): AsyncIterable<StorageEntry>

  /**
   * Atomically replace all entries for a document with a single entry.
   * Used for compaction (collapsing deltas into a single entirety).
   *
   * A concurrent reader must never observe an empty intermediate state.
   * If the document doesn't exist, creates it with the single entry.
   */
  replace(docId: DocId, entry: StorageEntry): Promise<void>

  /**
   * Delete all entries for a document.
   * After this call, `has(docId)` returns false and `loadAll(docId)`
   * yields nothing.
   */
  delete(docId: DocId): Promise<void>

  /**
   * List all document IDs that have stored entries.
   * Returns an AsyncIterable to support million-doc stores without
   * loading all IDs into memory.
   */
  listDocIds(): AsyncIterable<DocId>
}