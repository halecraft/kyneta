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
//   s.peerStates    // current per-peer sync state
//   await s.waitForSync()

import type { DocId, PeerId, PeerIdentityDetails } from "@kyneta/transport"
import type { Synchronizer } from "./synchronizer.js"
import type { Connectivity, PeerSyncState } from "./types.js"

// ---------------------------------------------------------------------------
// SyncRef — what sync() returns
// ---------------------------------------------------------------------------

/**
 * Options for waitForSync().
 */
export type WaitForSyncOptions = {
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
 * - `peerStates` — current per-peer sync state
 * - `waitForSync()` — wait for sync to complete
 * - `onPeerSyncChange()` — subscribe to per-peer sync state changes
 */
export interface SyncRef {
  /** The local peer ID. */
  readonly peerId: PeerId

  /** The document ID. */
  readonly docId: DocId

  /** Current per-peer sync state with all peers (volatile — can regress). */
  readonly peerStates: PeerSyncState[]

  /**
   * Monotonic readiness latch: `true` once this doc has reconciled with ≥1
   * peer (received data, or a terminal `vacant` reply). Stays `true` across
   * the `synced→pending→synced` reconnect re-handshake flip and across a
   * reconciled peer departing. The 90% case that users typically want: "is it
   * safe to read?" gate.
   */
  readonly ready: boolean

  /**
   * Monotonic latch restricted to peers matching `pred` (the authority /
   * quorum case) — resolved against stored identities, so it holds even
   * after the matching peer has left.
   */
  readyFor(pred: (peer: PeerIdentityDetails) => boolean): boolean

  /**
   * Coarse connection lifecycle: `online` (≥1 established peer),
   * `connecting` (transports configured, none established), or `offline`
   * (no transports configured).
   */
  readonly connectivity: Connectivity

  /**
   * Resolve when sync has settled — never rejects. Resolves
   * `{ via: "local" }` immediately when no transports are configured;
   * `{ via: "peer" }` on first reconciliation; `{ via: "offline" }` after
   * `opts.offlineAfter` ms with no upstream reconciliation.
   */
  settled(opts?: {
    offlineAfter?: number
  }): Promise<{ via: "peer" | "local" | "offline" }>

  /**
   * Wait for sync to complete with a peer of the specified kind.
   *
   * Resolves when we've completed a sync handshake with at least one
   * peer of the requested kind:
   * - Received document data (peer state = "synced")
   * - Peer confirmed it doesn't have the document (peer state = "vacant")
   *
   * @param options - Configuration options
   * @throws If the timeout is reached before sync completes
   */
  waitForSync(options?: WaitForSyncOptions): Promise<void>

  /**
   * Subscribe to per-peer sync state changes.
   * @param cb Callback that receives the new peer states
   * @returns Unsubscribe function
   */
  onPeerSyncChange(cb: (peerStates: PeerSyncState[]) => void): () => void
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

  get peerStates(): PeerSyncState[] {
    return this.#synchronizer.getPeerStates(this.docId)
  }

  get ready(): boolean {
    // With no transports configured there is no peer that could ever answer,
    // so waiting would be waiting forever. Reporting ready is the honest
    // answer, not a shortcut — and it matches the carve-out `settled()` has
    // had all along (see `connectivity() === "offline"` below).
    if (this.#synchronizer.connectivity() === "offline") return true
    return this.#synchronizer.hasReconciled(this.docId)
  }

  readyFor(pred: (peer: PeerIdentityDetails) => boolean): boolean {
    // Deliberately NOT given the offline carve-out that `ready` has. `ready`
    // means "safe to proceed"; `readyFor` asserts that one *particular* peer
    // was consulted. With no transports, no peer was — so answering `true`
    // would be a lie, and callers use this precisely when they need the
    // authority's word rather than a plausible default.
    return this.#synchronizer.reconciledMatching(this.docId, pred)
  }

  get connectivity(): Connectivity {
    return this.#synchronizer.connectivity()
  }

  async settled(opts?: {
    offlineAfter?: number
  }): Promise<{ via: "peer" | "local" | "offline" }> {
    // No transports configured — there is no upstream to wait for.
    if (this.#synchronizer.connectivity() === "offline") return { via: "local" }
    // Already reconciled with a peer.
    if (this.#synchronizer.hasReconciled(this.docId)) return { via: "peer" }

    // Otherwise wait for the monotonic latch. `offlineAfter` (if given) is
    // the deadline after which we proceed offline; 0 ⇒ wait indefinitely.
    const result = await this.#synchronizer.awaitReconciliation(
      this.docId,
      () => this.#synchronizer.hasReconciled(this.docId),
      opts?.offlineAfter ?? 0,
    )
    return result === "ready" ? { via: "peer" } : { via: "offline" }
  }

  async waitForSync(options?: WaitForSyncOptions): Promise<void> {
    const timeout = options?.timeout ?? 30000

    return this.#synchronizer.waitUntilReady(this.docId, timeout)
  }

  onPeerSyncChange(cb: (peerStates: PeerSyncState[]) => void): () => void {
    return this.#synchronizer.onPeerSyncChange((docId, peerStates) => {
      if (docId === this.docId) {
        cb(peerStates)
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
 * - `peerStates` — current per-peer sync state
 * - `waitForSync()` — wait for sync to complete
 * - `onPeerSyncChange()` — subscribe to per-peer sync state changes
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
 * sync(doc).peerStates
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
