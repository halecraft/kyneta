// store — persistence contract for the Exchange.
//
// The Store interface defines document-level operations
// that concrete backends implement. Backends need no knowledge of the
// sync protocol, substrates, merge strategies, or schemas.
//
// The Exchange guarantees that for any given docId, these methods are
// called sequentially — never concurrently. Backends may assume
// single-writer-per-document semantics.

import type { DocMetadata, SubstratePayload } from "@kyneta/schema"
import type { DocId } from "../types.js"

// ---------------------------------------------------------------------------
// StoreEntry — the unit of persistence
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
 * the Exchange can send truthful version information during
 * hydration without needing to deserialize or reconstruct the payload.
 */
export type StoreEntry = {
  readonly payload: SubstratePayload
  readonly version: string
}

// ---------------------------------------------------------------------------
// Store — the persistence interface
// ---------------------------------------------------------------------------

/**
 * The persistence contract for a storage backend.
 *
 * Concrete backends implement these methods. They need no knowledge
 * of the sync protocol, substrates, or schemas.
 *
 * The Exchange guarantees that for any given docId, these methods are
 * called sequentially — never concurrently. Backends may assume
 * single-writer-per-document semantics.
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
export interface Store {
  /**
   * Check existence and return per-document metadata.
   *
   * Returns `DocMetadata` if the document has been registered via
   * `ensureDoc()`, or `null` if the document is unknown. This
   * subsumes the old `has()` method — `lookup(docId) !== null`
   * is the existence check, and the metadata comes for free.
   */
  lookup(docId: DocId): Promise<DocMetadata | null>

  /**
   * Register per-document metadata. Called once before the first
   * `append()`. Idempotent — calling again with the same metadata
   * is a no-op.
   *
   * Backends persist this alongside entries, not per-row. For
   * `InMemoryStore`, this is a `Map<DocId, DocMetadata>`.
   * For real backends (Postgres, IndexedDB), it's a single metadata
   * row per document.
   */
  ensureDoc(docId: DocId, metadata: DocMetadata): Promise<void>

  /**
   * Append an entry for a document. `ensureDoc()` must be called
   * first. Entries are returned by `loadAll` in insertion order.
   */
  append(docId: DocId, entry: StoreEntry): Promise<void>

  /**
   * Load all entries for a document, yielding in insertion order.
   * Returns an AsyncIterable to support pagination for large stores
   * (S3, Postgres) without loading everything into memory.
   *
   * For a nonexistent document, yields nothing (no error).
   */
  loadAll(docId: DocId): AsyncIterable<StoreEntry>

  /**
   * Atomically replace all entries for a document with a single entry.
   * Used for compaction (collapsing deltas into a single entirety).
   *
   * A concurrent reader must never observe an empty intermediate state.
   * If the document doesn't exist, creates it with the single entry.
   */
  replace(docId: DocId, entry: StoreEntry): Promise<void>

  /**
   * Delete all entries and metadata for a document.
   * After this call, `lookup(docId)` returns `null` and
   * `loadAll(docId)` yields nothing.
   */
  delete(docId: DocId): Promise<void>

  /**
   * List all document IDs that have been registered via `ensureDoc()`.
   * Returns an AsyncIterable to support million-doc stores without
   * loading all IDs into memory.
   */
  listDocIds(): AsyncIterable<DocId>

  /**
   * Release resources held by this backend (file handles, connections).
   * Called by `Exchange.shutdown()`. Optional — in-memory backends
   * and backends without native handles may omit it.
   */
  close?(): Promise<void>
}