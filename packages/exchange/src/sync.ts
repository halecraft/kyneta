// sync — sync capabilities access for exchange documents.
//
// The `sync()` function retrieves sync capabilities for a document
// created by `Exchange.get()`. Internally, sync state is tracked via
// a module-scoped WeakMap (same pattern as @kyneta/loro-schema's
// substrate tracking and the vendor's syncRefMap).
//
// Usage:
//   const doc = exchange.get("my-doc", schema)
//   const s = sync(doc)
//   s.peerId        // local peer ID
//   s.docId         // document ID
//   s.readyStates   // current sync status
//   await s.waitForSync()

import type { Synchronizer } from "./synchronizer.js"
import type { DocId, PeerId, ReadyState } from "./types.js"

// ---------------------------------------------------------------------------
// SyncRef — what sync() returns
// ---------------------------------------------------------------------------

/**
 * Options for waitForSync().
 */
export type WaitForSyncOptions = {
  /**
   * The kind of channel to wait for.
   * @default "network"
   */
  kind?: "network" | "storage"

  /**
   * Timeout in milliseconds. Set to 0 to disable timeout.
   * @default 30000
   */
  timeout?: number
}

/**
 * SyncRef provides access to sync/network capabilities for a document.
 *
 * This interface is returned by `sync(ref)` and provides:
 * - `peerId` — the local peer ID
 * - `docId` — the document ID
 * - `readyStates` — current sync status with all peers
 * - `waitForSync()` — wait for sync to complete
 * - `onReadyStateChange()` — subscribe to sync status changes
 */
export interface SyncRef {
  /** The local peer ID. */
  readonly peerId: PeerId

  /** The document ID. */
  readonly docId: DocId

  /** Current sync status with all peers. */
  readonly readyStates: ReadyState[]

  /**
   * Wait for sync to complete with a peer of the specified kind.
   *
   * Resolves when we've completed a sync handshake with at least one
   * peer of the requested kind:
   * - Received document data (peer state = "synced")
   * - Peer confirmed it doesn't have the document (peer state = "absent")
   *
   * @param options - Configuration options
   * @throws If the timeout is reached before sync completes
   */
  waitForSync(options?: WaitForSyncOptions): Promise<void>

  /**
   * Subscribe to ready state changes.
   * @param cb Callback that receives the new ready states
   * @returns Unsubscribe function
   */
  onReadyStateChange(cb: (readyStates: ReadyState[]) => void): () => void
}

// ---------------------------------------------------------------------------
// Module-scoped WeakMap — primary storage for sync refs
// ---------------------------------------------------------------------------

const syncRefMap = new WeakMap<object, SyncRef>()

// ---------------------------------------------------------------------------
// SyncRef implementation
// ---------------------------------------------------------------------------

class SyncRefImpl implements SyncRef {
  readonly peerId: PeerId
  readonly docId: DocId
  readonly #synchronizer: Synchronizer

  constructor(params: {
    peerId: PeerId
    docId: DocId
    synchronizer: Synchronizer
  }) {
    this.peerId = params.peerId
    this.docId = params.docId
    this.#synchronizer = params.synchronizer
  }

  get readyStates(): ReadyState[] {
    return this.#synchronizer.getReadyStates(this.docId)
  }

  async waitForSync(options?: WaitForSyncOptions): Promise<void> {
    const kind = options?.kind ?? "network"
    const timeout = options?.timeout ?? 30000

    return this.#synchronizer.waitUntilReady(this.docId, kind, timeout)
  }

  onReadyStateChange(cb: (readyStates: ReadyState[]) => void): () => void {
    return this.#synchronizer.onReadyStateChange((docId, readyStates) => {
      if (docId === this.docId) {
        cb(readyStates)
      }
    })
  }
}

// ---------------------------------------------------------------------------
// registerSync — internal helper (called by Exchange.get())
// ---------------------------------------------------------------------------

/**
 * Register sync capabilities for a document ref.
 *
 * Called internally by `Exchange.get()` after creating the ref.
 * NOT exported from the barrel — internal cross-module helper.
 *
 * @param ref - The document ref (Ref<S>) to attach sync to
 * @param params - The sync parameters (peerId, docId, synchronizer)
 */
export function registerSync(
  ref: object,
  params: {
    peerId: PeerId
    docId: DocId
    synchronizer: Synchronizer
  },
): void {
  const syncRef = new SyncRefImpl(params)
  syncRefMap.set(ref, syncRef)
}

// ---------------------------------------------------------------------------
// sync() — public API to access sync capabilities
// ---------------------------------------------------------------------------

/**
 * Access sync/network capabilities for a document.
 *
 * Use this to access:
 * - `peerId` — the local peer ID
 * - `docId` — the document ID
 * - `readyStates` — current sync status with all peers
 * - `waitForSync()` — wait for sync to complete
 * - `onReadyStateChange()` — subscribe to sync status changes
 *
 * @param ref - A document obtained from `exchange.get()`
 * @returns SyncRef with sync capabilities
 * @throws If the document was not created via `exchange.get()`
 *
 * @example
 * ```typescript
 * import { sync } from "@kyneta/exchange"
 *
 * const doc = exchange.get("my-doc", schema)
 * sync(doc).peerId
 * sync(doc).readyStates
 * await sync(doc).waitForSync()
 * ```
 */
export function sync(ref: object): SyncRef {
  const syncRef = syncRefMap.get(ref)

  if (!syncRef) {
    throw new Error(
      "sync() requires a document from exchange.get(). " +
        "Documents created without an Exchange don't have sync capabilities. " +
        "Use exchange.get(docId, schema) to get a document with sync support.",
    )
  }

  return syncRef
}

/**
 * Check if a document has sync capabilities (was created via exchange.get()).
 *
 * @param ref - A document ref to check
 * @returns true if the document has sync capabilities
 */
export function hasSync(ref: object): boolean {
  return syncRefMap.has(ref)
}
