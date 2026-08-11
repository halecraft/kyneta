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
//   await whenSettled(doc)

import type { DocId, PeerId, PeerIdentityDetails } from "@kyneta/transport"
import { whenHydrated } from "./settle.js"
import type { Synchronizer } from "./synchronizer.js"
import type { Connectivity, PeerSyncState } from "./types.js"

// ---------------------------------------------------------------------------
// SyncRef — what sync() returns
// ---------------------------------------------------------------------------

/**
 * SyncRef provides access to sync/network capabilities for a document.
 *
 * This interface is returned by `sync(ref)` and provides:
 * - `peerId` — the local peer ID
 * - `docId` — the document ID
 * - `peerStates` — current per-peer sync state
 * - `ready` / `readyFor(pred)` — monotonic readiness latches
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

/** The raw wiring behind each `SyncRef`, for waits that need the synchronizer. */
const syncSourceMap = new WeakMap<
  object,
  { docId: DocId; synchronizer: Synchronizer }
>()

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
  // `whenSettled` needs the synchronizer itself, not just the public SyncRef
  // surface, because it waits on an authority predicate that `SyncRef` does
  // not expose.
  syncSourceMap.set(ref, params)
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
 * - `ready` / `readyFor(pred)` — monotonic readiness latches
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
 * await whenSettled(doc)
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

// ---------------------------------------------------------------------------
// whenSettled — wait for every truth source, not just the network
// ---------------------------------------------------------------------------

/**
 * Resolve once every truth source attached to this document has reported.
 *
 * This is the promise form of `settled(ref)`, and the one to reach for before
 * deciding whether a document is empty. It awaits **both** halves: the stored
 * data finishing its load, and the authority answering.
 *
 * Waiting on the network alone is the tempting shortcut and it is wrong. A
 * document with both a store and transports would proceed the moment the
 * server replied — while its own disk read was still in flight — and read as
 * empty. That is exactly the failure this layer exists to prevent.
 *
 * The two waits run in sequence, and that order is load-bearing rather than
 * incidental: the storage wait carries no timeout, so there is nowhere for a
 * deadline on a disk read to be introduced later. A missing peer may genuinely
 * never arrive, so abandoning that wait is the only option available; a slow
 * disk is a local fault we can observe, and abandoning it would mean writing
 * defaults over data we merely failed to load.
 *
 * Never rejects for network reasons — an unreachable peer resolves
 * `{ via: "offline" }` after `offlineAfter`. It *does* reject if the store
 * read failed, because that is a fault worth surfacing rather than a state
 * worth proceeding from.
 *
 * @param ref - A document ref.
 * @param opts.peer - Require a peer matching this predicate to have answered.
 * @param opts.offlineAfter - Give up waiting for peers after this many ms.
 *   `0` (the default) waits indefinitely. Never applies to the storage wait.
 */
export async function whenSettled(
  ref: object,
  opts?: {
    peer?: (peer: PeerIdentityDetails) => boolean
    offlineAfter?: number
  },
): Promise<{ via: "peer" | "local" | "offline" }> {
  // ── Step 1: storage. No timeout, by construction. ──
  await whenHydrated(ref)

  // ── Step 2: peers, with the timeout. ──
  const source = syncSourceMap.get(ref)
  // No exchange behind this document, so there is no upstream to wait for.
  if (!source) return { via: "local" }

  const { docId, synchronizer } = source
  if (synchronizer.connectivity() === "offline") return { via: "local" }

  const isReady = opts?.peer
    ? () => synchronizer.reconciledMatching(docId, opts.peer as never)
    : () => synchronizer.hasReconciled(docId)

  if (isReady()) return { via: "peer" }

  const result = await synchronizer.awaitReconciliation(
    docId,
    isReady,
    opts?.offlineAfter ?? 0,
  )
  return result === "ready" ? { via: "peer" } : { via: "offline" }
}
