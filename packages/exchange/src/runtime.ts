// runtime — the local imperative shell for document execution.
//
// The Runtime owns the *local* lifecycle of documents: the document cache,
// persistent storage (hydration + persistence via the pure store-program
// Mealy machine), the cascade `Lease` (cooperating dispatch budget), and
// a ticking clock for time-based projections (e.g. `.decay()`).
//
// The Runtime is deliberately separate from the `Exchange`. The `Exchange`
// is the *network* shell — it manages transports, peers, and the sync
// graph. The `Runtime` is the *local* shell — it manages what happens on
// this machine regardless of network connectivity. A purely local-first
// app (SQLite storage, no transports) uses a `Runtime` directly, without
// ever constructing an `Exchange`.
//
// The `Exchange` composes a `Runtime` and wires the `Synchronizer` into
// the Runtime's lifecycle hooks (onDocReady, onStateAdvanced). When a doc
// is hydrated from storage, the Runtime fires `onDocReady`; the Exchange
// responds by registering the doc with the Synchronizer for network sync.
//
// FC/IS boundary: the store-program (Mealy machine) is a pure functional
// core; the Runtime is the imperative shell that interprets its effects as
// real I/O. The tick clock (`setInterval`) lives here, not in substrates —
// substrates expose a pure `tick?(now: number)` that the Runtime calls.

import type { Lease, ObservableHandle } from "@kyneta/machine"
import { createLease, createObservableProgram } from "@kyneta/machine"
import type {
  BoundSchema,
  DocRef,
  NativeMap,
  ProductSchema,
  Ref,
  ReplicaFactoryLike,
  ReplicaLike,
  Schema as SchemaNode,
  SyncMode,
} from "@kyneta/schema"
import { beginHydration, createRef, SUBSTRATE, subscribe } from "@kyneta/schema"
import type { DocId } from "@kyneta/transport"
import { registerDocSyncMode } from "./doc-meta.js"
import { makeSettleTerm, registerHydrationTerm } from "./settle.js"
import type { Store, StoreMeta } from "./store/store.js"
import {
  allDocsIdle,
  type DocPhase,
  type StoreEffect,
  type StoreInput,
  type StoreModel,
  storeProgram,
} from "./store/store-program.js"

/** The obligation a no-store document has: none. */
const NO_ADOPT = (): void => {}

// ---------------------------------------------------------------------------
// RuntimeGet — the call signature for Runtime.get (mirrors Exchange's Get type)
// ---------------------------------------------------------------------------

/**
 * Call signature for {@link Runtime.get}.
 *
 * Returns the precise root ref `DocRef<S, N>` for product-schema documents
 * (the common case) — so `unwrap(doc)` resolves to the substrate's root
 * container. Non-product roots fall back to `Ref<S, N>`.
 *
 * This is the same deferred-conditional pattern Exchange.Get uses to avoid
 * TS2589 (see Exchange.ts for the full rationale).
 */
type RuntimeGet = <S extends SchemaNode, N extends NativeMap>(
  docId: DocId,
  bound: BoundSchema<S, N>,
) => S extends ProductSchema ? DocRef<S, N> : Ref<S, N>

// ---------------------------------------------------------------------------
// RuntimeHooks — callbacks the Exchange wires for network participation
// ---------------------------------------------------------------------------

/**
 * Information about a ready document, passed to {@link RuntimeHooks.onDocReady}.
 *
 * This is the local view of a document — it carries the replica/substrate
 * and sync metadata. The Exchange uses it to construct the network-facing
 * `DocRuntime` for the Synchronizer.
 */
export type DocReadyInfo = {
  docId: DocId
  mode: "interpret" | "replicate"
  replica: ReplicaLike
  replicaFactory: ReplicaFactoryLike
  syncMode: SyncMode
  schemaHash: string
  supportedHashes?: readonly string[]
}

// ---------------------------------------------------------------------------
// DocCacheEntry — local document registry entry
// ---------------------------------------------------------------------------

/**
 * Where a document's load-from-storage has got to.
 *
 * Three states, not two, because "still loading" and "tried and failed" must
 * not look alike to anything downstream. A document whose store read threw is
 * *not* an empty document — treating it as one would mean writing defaults
 * over data we merely failed to read, which is the failure this whole
 * readiness layer exists to prevent. So a failed load keeps the document
 * un-settled and hangs on to the error for whoever asks.
 *
 * A document with no stores configured starts `loaded`: there is nothing to
 * wait for.
 */
export type HydrationLatch = {
  state: "pending" | "loaded" | "failed"
  error?: unknown
  /** Fired once when the state leaves `pending`. */
  readonly listeners: Set<() => void>
}

/** @internal Move a latch out of `pending` and wake anyone waiting on it. */
export function resolveHydration(
  latch: HydrationLatch,
  outcome: { ok: true } | { ok: false; error: unknown },
): void {
  if (latch.state !== "pending") return
  latch.state = outcome.ok ? "loaded" : "failed"
  if (!outcome.ok) latch.error = outcome.error
  for (const listener of latch.listeners) listener()
  latch.listeners.clear()
}

/** @internal A latch for a document with nothing to load. */
export function createHydrationLatch(
  initial: "pending" | "loaded",
): HydrationLatch {
  return { state: initial, listeners: new Set() }
}

/**
 * `readyInfo` + `announced` let {@link Runtime.setHooks} safely backfill
 * `onDocReady` for documents that already existed before hooks were
 * attached (e.g. a standalone `Runtime` later wrapped in an `Exchange`).
 * `readyInfo` is captured once, when the document first becomes ready
 * (post-hydration, or immediately if no stores are configured); `announced`
 * tracks whether `onDocReady` has actually fired for it yet, so repeated or
 * out-of-order `setHooks` calls never double-announce. Context: jj:mrlnmlus.
 *
 * `hydration` is the storage half of the document's readiness — see
 * {@link HydrationLatch} and `settle.ts`.
 */
export type DocCacheEntry =
  | {
      mode: "interpret"
      ref: any
      bound: BoundSchema
      readyInfo: DocReadyInfo
      announced: boolean
      suspended?: boolean
      hydration: HydrationLatch
    }
  | {
      mode: "replicate"
      readyInfo: DocReadyInfo
      announced: boolean
      suspended?: boolean
      hydration: HydrationLatch
    }
  | { mode: "deferred" }

/**
 * Lifecycle hooks the Exchange implements to bridge the local Runtime
 * into the network Synchronizer.
 *
 * These are optional — a standalone Runtime (no Exchange) never sets them.
 */
export type RuntimeHooks = {
  /**
   * Called when a document has been fully hydrated from storage (or
   * immediately if no stores are configured) and is ready to participate
   * in the sync graph.
   *
   * The Exchange implements this to call `synchronizer.registerDoc(...)`.
   */
  onDocReady?: (info: DocReadyInfo) => void

  /**
   * Called when a document's changeset fires (local or replay).
   *
   * The Exchange implements this to forward the changeset to the
   * Synchronizer's observation tee and notify-local-change path.
   *
   * Note: the `replay` flag is preserved on the changeset; the Exchange
   * uses it to decide whether to broadcast.
   */
  onDocChangeset?: (docId: DocId, changeset: any) => void

  /**
   * Called when a document is destroyed locally — remove from sync graph
   * AND delete from stores. The Exchange implements this to broadcast
   * `dismiss` to peers via the Synchronizer.
   */
  onDocDestroyed?: (docId: DocId) => void

  /**
   * Called when a document is suspended locally — leave the sync graph
   * but keep all local state (including in the Synchronizer's runtime).
   * The Exchange implements this to call `synchronizer.suspendDocument()`
   * which broadcasts a wire `dismiss` but retains the doc runtime.
   */
  onDocSuspended?: (docId: DocId) => void

  /**
   * Called when a document is resumed locally — re-enter the sync graph.
   * The Exchange implements this to call `synchronizer.resumeDocument()`
   * which re-announces presence to peers.
   */
  onDocResumed?: (docId: DocId) => void
}

// ---------------------------------------------------------------------------
// RuntimeParams — constructor options
// ---------------------------------------------------------------------------

/**
 * Options for creating a {@link Runtime}.
 */
export type RuntimeParams = {
  /** The local peer ID — used for substrate factory construction. */
  peerId: string

  /** Persistent storage backends (first-hit semantics). */
  stores?: Store[]

  /**
   * Called when a store operation fails. Default: `console.warn`.
   */
  onStoreError?: (docId: DocId, operation: string, error: unknown) => void

  /**
   * Optional pre-existing dispatch budget. If omitted, the Runtime
   * creates a private lease.
   */
  lease?: Lease

  /**
   * Interval (ms) for the heartbeat tick that drives time-based
   * substrate projections (e.g. `.decay()`). `0` disables the tick
   * entirely (substrates with `.decay()` will not auto-revert).
   *
   * @default 1000
   */
  tickInterval?: number
}

// ---------------------------------------------------------------------------
// Runtime — the local imperative shell
// ---------------------------------------------------------------------------

/**
 * The local imperative shell for document execution.
 *
 * Owns the document cache, persistent storage (hydration + persistence),
 * the cascade `Lease`, and the ticking clock. This is the layer between
 * the pure CRDT math (substrates) and the network shell (`Exchange`).
 *
 * A standalone local-first application (no network) uses a `Runtime`
 * directly:
 *
 * ```typescript
 * const runtime = new Runtime({ peerId: "alice", stores: [createInMemoryStore()] })
 * const doc = runtime.get("my-doc", TodoDoc)
 * await runtime.flush() // persist
 * await runtime.shutdown()
 * ```
 *
 * An `Exchange` composes a `Runtime` and wires the `Synchronizer` into
 * it via {@link RuntimeHooks}.
 */
export class Runtime {
  readonly peerId: string
  readonly lease: Lease

  readonly #stores: Store[]
  /** Store-program handle — pure Mealy machine for store coordination. */
  readonly #storeHandle: ObservableHandle<StoreInput, StoreModel> | null

  readonly #docCache = new Map<DocId, DocCacheEntry>()

  /** In-flight hydration I/O tracked so flush()/shutdown() can await it. */
  readonly #pendingHydrations = new Set<Promise<void>>()

  /**
   * Doc-ids with a local (non-replay) changeset pending persistence,
   * coalesced into one `#persistIfAdvanced` call per doc per microtask
   * tick — mirrors the Synchronizer's own dirty-set-drained-at-quiescence
   * pattern (`onStateAdvanced`'s doc comment: "Coalescing is intentional:
   * multiple advances within one dispatch cycle produce a single
   * notification"). Without this, a multi-field `batch()` — which fires
   * one changeset per touched field — would persist the same starting
   * delta once per field instead of once per batch. Context: jj:mrlnmlus.
   */
  readonly #dirtyLocalChanges = new Set<DocId>()
  #localChangeDrain: Promise<void> | null = null

  /** Network hooks — set by Exchange. Undefined for standalone use. */
  #hooks: RuntimeHooks = {}

  /** Tick clock infrastructure. */
  readonly #tickIntervalMs: number
  #tickTimer: ReturnType<typeof setInterval> | null = null

  constructor({
    peerId,
    stores = [],
    onStoreError,
    lease,
    tickInterval = 1000,
  }: RuntimeParams) {
    this.peerId = peerId
    this.lease = lease ?? createLease()
    this.#stores = stores
    this.#tickIntervalMs = tickInterval

    // ── Store-program — pure machine for store coordination ──
    if (stores.length > 0) {
      const errorHandler =
        onStoreError ??
        ((docId: DocId, operation: string, error: unknown) => {
          console.warn(
            `[runtime] store ${operation} failed for doc '${docId}':`,
            error,
          )
        })

      this.#storeHandle = createObservableProgram(
        storeProgram,
        (effect: StoreEffect, dispatch: (msg: StoreInput) => void) => {
          switch (effect.type) {
            case "persist-append": {
              const { docId, records } = effect
              Promise.all(
                stores.map(async store => {
                  for (const record of records) {
                    await store.append(docId, record)
                  }
                }),
              ).then(
                () => {
                  let version = ""
                  for (const r of records) {
                    if (r.kind === "entry") version = r.version
                  }
                  dispatch({ type: "write-succeeded", docId, version })
                },
                error => dispatch({ type: "write-failed", docId, error }),
              )
              break
            }
            case "persist-replace": {
              const { docId, records } = effect
              Promise.all(
                stores.map(store => store.replace(docId, records)),
              ).then(
                () => {
                  let version = ""
                  for (const r of records) {
                    if (r.kind === "entry") version = r.version
                  }
                  dispatch({ type: "write-succeeded", docId, version })
                },
                error => dispatch({ type: "write-failed", docId, error }),
              )
              break
            }
            case "persist-delete": {
              const { docId } = effect
              Promise.all(stores.map(store => store.delete(docId))).then(
                () => {}, // No write-succeeded for destroy
                error => errorHandler(docId, "delete", error),
              )
              break
            }
            case "store-error": {
              errorHandler(effect.docId, effect.operation, effect.error)
              break
            }
          }
        },
      )
    } else {
      this.#storeHandle = null
    }

    // ── Tick clock — drives time-based substrate projections ──
    if (this.#tickIntervalMs > 0) {
      this.#startTick()
    }
  }

  // =========================================================================
  // Hook management (called by Exchange)
  // =========================================================================

  /**
   * Set the lifecycle hooks. The Exchange calls this during construction
   * to bridge the Runtime into the Synchronizer.
   *
   * Backfills `onDocReady` for every already-live, non-deferred document
   * in the cache — covers the "standalone Runtime later wrapped in an
   * Exchange" path (`new Exchange(runtime, params)`), where documents
   * created via `runtime.get()`/`runtime.replicate()` before this call
   * fired `onDocReady` against the (then-empty) hook set and were never
   * announced. `#register` is idempotent per entry, so this is safe
   * regardless of call order or repeated `setHooks` calls. Context: jj:mrlnmlus.
   */
  setHooks(hooks: RuntimeHooks): void {
    this.#hooks = hooks
    if (hooks.onDocReady) {
      for (const [, entry] of this.#docCache) {
        if (entry.mode !== "deferred") this.#register(entry)
      }
    }
  }

  // =========================================================================
  // PUBLIC API — Document access
  // =========================================================================

  /**
   * Gets (or creates) an interpreted document.
   *
   * Creates the substrate + ref, caches the entry, and begins hydration
   * (if stores are configured). Returns the ref synchronously. If stores
   * are configured, hydration completes asynchronously — the ref starts
   * empty and the changefeed fires when stored data is merged.
   *
   * Multiple calls with the same `docId` return the same instance.
   * Calling with a different BoundSchema for the same `docId` throws.
   *
   * That last check lives here and not in {@link createInterpretDoc}, because
   * `createInterpretDoc` is shared. The Exchange calls it both for a caller's
   * own `get()` and for documents a peer announces — and in the second case
   * the `BoundSchema` is whichever object the capability registry returned,
   * not one the caller ever held. Comparing object identity catches a caller
   * that rebuilds its schema on every call, which is worth catching; applied
   * to the network path it would reject documents that are perfectly fine.
   *
   * @param docId - The document ID
   * @param bound - A BoundSchema created by `bind()`
   * @returns A full-stack ref with the local substrate
   */
  get: RuntimeGet = (docId, bound) => {
    const cached = this.#docCache.get(docId)
    if (cached && cached.mode === "interpret" && cached.bound !== bound) {
      throw new Error(
        `Document '${docId}' already exists with a different BoundSchema. ` +
          `Use the same BoundSchema object when calling get() for the same document.`,
      )
    }
    return this.createInterpretDoc(docId, bound) as never
  }

  /**
   * Register a document for headless replication — no schema, no ref.
   *
   * The document participates in the sync graph via a bare `Replica<V>`,
   * enabling version tracking and state accumulation without interpretation.
   */
  replicate(
    docId: DocId,
    replicaFactory: ReplicaFactoryLike,
    syncMode: SyncMode,
    schemaHash: string,
  ): void {
    this.#createReplicateDoc(docId, replicaFactory, syncMode, schemaHash)
  }

  /**
   * Check if a document exists in the runtime.
   */
  has(docId: DocId): boolean {
    return this.#docCache.has(docId)
  }

  /**
   * Get a cached document entry, or undefined.
   */
  getEntry(docId: DocId): DocCacheEntry | undefined {
    return this.#docCache.get(docId)
  }

  /**
   * All document IDs currently in interpret mode.
   */
  documentIds(): ReadonlySet<DocId> {
    const result = new Set<DocId>()
    for (const [docId, entry] of this.#docCache) {
      if (entry.mode === "interpret") result.add(docId)
    }
    return result
  }

  /**
   * The set of deferred document IDs.
   */
  get deferred(): ReadonlySet<DocId> {
    const result = new Set<DocId>()
    for (const [docId, entry] of this.#docCache) {
      if (entry.mode === "deferred") result.add(docId)
    }
    return result
  }

  /**
   * Schema hash for a document, if it exists.
   */
  getDocSchemaHash(docId: DocId): string | undefined {
    const cached = this.#docCache.get(docId)
    if (!cached) return undefined
    if (cached.mode === "interpret") return cached.bound.schemaHash
    return undefined
  }

  // =========================================================================
  // PUBLIC API — Document lifecycle
  // =========================================================================

  /**
   * Destroy a document — remove it from the cache and delete from stores.
   *
   * Fires {@link RuntimeHooks.onDocDestroyed} so the Exchange can broadcast
   * `dismiss` to peers and remove the doc from the sync graph.
   *
   * The store delete is skipped for a document that was never stored, which is
   * only knowable from the cache entry. Gathering the facts, deciding, then
   * executing makes "read the entry before deleting it" a property of the
   * code's shape rather than of a comment asking nobody to reorder two lines.
   */
  destroy(docId: DocId): void {
    const entry = this.#docCache.get(docId)

    // Both "we don't know" cases default to deleting, because skipping is only
    // safe when we know the document was never stored. An absent cache entry is
    // exactly the case where we know nothing: `Exchange.destroy` is the single
    // public API for removal and has to work on a document left on disk by an
    // earlier session. A deferred entry holds no replica, so there is no sync
    // mode to consult either.
    //
    // Discriminating on `mode` is forced rather than stylistic — the deferred
    // variant is `{ mode: "deferred" }`, with no `readyInfo` to reach through.
    const touchesStore =
      entry === undefined ||
      entry.mode === "deferred" ||
      this.#usesStores(entry.readyInfo.syncMode)

    this.#docCache.delete(docId)
    if (touchesStore) this.#storeHandle?.dispatch({ type: "destroy", docId })
    this.#hooks.onDocDestroyed?.(docId)
  }

  /**
   * Suspend a document — leave the sync graph but keep all local state.
   *
   * Fires {@link RuntimeHooks.onDocSuspended} so the Exchange can suspend
   * the doc in the Synchronizer (broadcasts `dismiss` but retains runtime).
   */
  suspend(docId: DocId): void {
    const cached = this.#docCache.get(docId)
    if (!cached) {
      throw new Error(`Document '${docId}' does not exist.`)
    }
    if (cached.mode === "deferred") {
      throw new Error(`Cannot suspend deferred document '${docId}'.`)
    }
    if (cached.suspended) {
      return // Already suspended — idempotent
    }
    cached.suspended = true
    this.#hooks.onDocSuspended?.(docId)
  }

  /**
   * Resume a suspended document.
   */
  resume(docId: DocId): void {
    const cached = this.#docCache.get(docId)
    if (!cached) {
      throw new Error(`Document '${docId}' does not exist.`)
    }
    if (cached.mode === "deferred" || !cached.suspended) {
      throw new Error(
        `Document '${docId}' is not suspended. Call suspend() first.`,
      )
    }
    cached.suspended = false
    this.#hooks.onDocResumed?.(docId)
  }

  /**
   * Delete a deferred entry and return its metadata (for promotion).
   *
   * @internal — used by Exchange for deferred→interpret/replicate promotion.
   */
  deleteDeferred(docId: DocId): DocCacheEntry | undefined {
    const entry = this.#docCache.get(docId)
    if (entry?.mode === "deferred") {
      this.#docCache.delete(docId)
      return entry
    }
    return undefined
  }

  /**
   * Mark a document as deferred (participates in routing but has no local data).
   *
   * @internal — used by Exchange for unsupported/deferred documents.
   */
  markDeferred(docId: DocId): void {
    this.#docCache.set(docId, { mode: "deferred" })
  }

  // =========================================================================
  // PUBLIC API — Store coordination
  // =========================================================================

  /**
   * Called by the Exchange when the Synchronizer reports a doc's state
   * has advanced (from network sync or local change). Dispatches a
   * delta-save into the store program.
   *
   * No-op if no stores are configured. Delegates to {@link Runtime.#persistIfAdvanced},
   * which a standalone Runtime (no Exchange) also calls directly from its
   * own local-changeset subscription — see {@link Runtime.#wireDocSubscription}.
   * Safe to call redundantly for the same mutation from both paths: the
   * store-program's confirmed-version dedup means whichever call reaches
   * it first performs the real write, the other is a no-op. Context: jj:mrlnmlus.
   */
  onStateAdvanced(
    docId: DocId,
    replica: ReplicaLike,
    replicaFactory: ReplicaFactoryLike,
  ): void {
    this.#persistIfAdvanced(docId, replica, replicaFactory)
  }

  /**
   * Will this document's state ever reach a store, in either direction?
   */
  #usesStores(syncMode: SyncMode): boolean {
    return this.#stores.length > 0 && syncMode.durability === "persistent"
  }

  /**
   * Shared core of {@link Runtime.onStateAdvanced} — exports the delta
   * since the store program's last confirmed version and dispatches a
   * `state-advanced` write if the version actually moved. No-op if no
   * stores are configured, if the doc hasn't finished its initial
   * registration yet, or if there's nothing new to persist.
   *
   * **Transient documents never get past the `!phase` guard**, because they
   * are never registered with the store-program at all — see `#usesStores`.
   * That guard is a second line of defence rather than the mechanism: if such
   * a document ever does acquire a phase, the rule upstream has already failed
   * and this will not save it. It is not idle work, though — before that rule
   * existed, every presence mutation ran this method almost to the end and
   * computed an `exportSince` delta that a snapshot-only substrate always
   * returns `null` for.
   *
   * Deduplicates on the *target* version, not just on an empty delta.
   * Pre-existing gap, exposed (not caused) by this plan's new local-change
   * call site: `deliverNotifications` fires one `Changeset` per touched
   * top-level field in a `batch()`, so a multi-field batch synchronously
   * triggers this method multiple times before the first dispatch's async
   * write ever resolves — every one of those calls computes the same
   * `exportSince(confirmedVersion)` delta, because the store-program's
   * confirmed version hasn't advanced yet. An empty-delta check alone
   * doesn't catch this (the delta is real, just redundant). Tracking the
   * already-targeted version — both the in-flight `pendingVersion` and
   * any versions already sitting in the `writing`-phase queue — closes it
   * without touching the store-program's own Mealy-machine transitions.
   * Context: jj:mrlnmlus.
   */
  #persistIfAdvanced(
    docId: DocId,
    replica: ReplicaLike,
    replicaFactory: ReplicaFactoryLike,
  ): void {
    if (!this.#storeHandle) return
    const phase = this.#storeHandle.getState().docs.get(docId)
    if (!phase) return // Not yet registered — still hydrating

    // The version the store has actually confirmed. While a write is in
    // flight that is still whatever it was *before* that write started —
    // `pendingVersion` is not confirmed until `write-succeeded` — which is
    // exactly what the `writing` phase carries as `revertTo`.
    //
    // Deliberately not an early return for `writing`. A mutation arriving
    // mid-write still has to compute its delta from the confirmed point and
    // dispatch, so the store-program can queue it and replay it once the
    // in-flight write lands. Returning here instead would drop that mutation:
    // nothing else would ever offer it to the store.
    const settled = phase.status === "writing" ? phase.revertTo : phase

    // Nothing has ever been written, so there is no base to diff against. Two
    // ways to arrive: the document's first write failed (`unwritten`), or it
    // is still in flight (`writing` from `unwritten`).
    if (settled.status === "unwritten") return

    const confirmedVersion = settled.version

    const newVersion = replica.version().serialize()
    if (this.#versionAlreadyTargeted(phase, newVersion)) return

    const sinceVersion = replicaFactory.parseVersion(confirmedVersion)
    const delta = replica.exportSince(sinceVersion)
    if (!delta) return // Version didn't actually advance — deduplication

    this.#storeHandle.dispatch({
      type: "state-advanced",
      docId,
      delta,
      newVersion,
    })
  }

  /**
   * True if `newVersion` is already the in-flight write's target, or
   * already queued behind it, for a `"writing"` phase.
   */
  #versionAlreadyTargeted(phase: DocPhase, newVersion: string): boolean {
    if (phase.status !== "writing") return false
    if (phase.pendingVersion === newVersion) return true
    return (
      phase.queued?.some(
        q => q.type === "state-advanced" && q.newVersion === newVersion,
      ) ?? false
    )
  }

  /**
   * Compact a document — replace stored payloads with the trimmed entirety.
   *
   * @param docId - The document to compact
   * @param replica - The replica to compact
   * @param replicaFactory - The replica's factory (for metadata)
   * @param syncMode - The sync mode
   * @param schemaHash - The schema hash
   */
  async compact(
    docId: DocId,
    replica: ReplicaLike,
    replicaFactory: ReplicaFactoryLike,
    syncMode: SyncMode,
    schemaHash: string,
  ): Promise<void> {
    if (!this.#storeHandle) return

    const meta: StoreMeta = {
      replicaType: replicaFactory.replicaType,
      syncMode,
      schemaHash,
    }
    this.#storeHandle.dispatch({
      type: "compact",
      docId,
      meta,
      entirety: replica.exportEntirety(),
      newVersion: replica.version().serialize(),
    })
    await this.#storeHandle.waitForState((s: StoreModel) => {
      const phase = s.docs.get(docId)
      return !phase || phase.status === "idle"
    })
  }

  // =========================================================================
  // PUBLIC API — Lifecycle
  // =========================================================================

  /**
   * Await all pending store operations.
   */
  async flush(): Promise<void> {
    await this.#awaitHydrations()
    if (this.#storeHandle) {
      await this.#storeHandle.waitForState(allDocsIdle)
    }
  }

  /**
   * Gracefully shut down: flush all pending operations, close stores,
   * stop the tick clock.
   */
  async shutdown(): Promise<void> {
    await this.#awaitHydrations()
    if (this.#storeHandle) {
      await this.#storeHandle.waitForState(allDocsIdle)
      this.#storeHandle.dispose()
    }
    this.#stopTick()
    this.#docCache.clear()
    for (const backend of this.#stores) {
      await backend.close()
    }
  }

  /**
   * Synchronous teardown — clears the cache and stops everything without
   * awaiting pending I/O. Use {@link shutdown} for graceful teardown.
   */
  reset(): void {
    this.#stopTick()
    this.#storeHandle?.dispose()
    this.#docCache.clear()
  }

  // =========================================================================
  // INTERNAL — Document creation (non-generic, for Exchange delegation)
  // =========================================================================

  /**
   * Create an interpreted document — non-generic internal path.
   *
   * This is the same as {@link get} but without the generic type
   * parameters, avoiding TS2589 when called from non-generic contexts
   * (e.g. Exchange's onEnsureDoc callback). The public {@link get} method
   * delegates here with an `as never` cast to preserve precise types.
   *
   * @internal
   */
  createInterpretDoc(docId: DocId, bound: BoundSchema): any {
    // Ensure semantics: if this doc already exists in interpret mode,
    // return the existing ref.
    const cached = this.#docCache.get(docId)
    if (cached && cached.mode === "interpret") {
      return cached.ref
    }

    // A replicate entry holds an accumulated `Replica` and no ref. Falling
    // through to the construction below would replace it with a fresh, empty
    // substrate — losing that state with no error and no event. `replicate`
    // is the tier relays and audit logs use, so the loss would land exactly
    // where nobody is reading a document's contents to notice it.
    //
    // Refusing is not a ruling on *promotion*: whether `get()` should one day
    // upgrade a replicate document to interpret is still open. Refusing is
    // right under either answer; overwriting is right under neither. Keep the
    // wording in step with the Exchange's own replicate guard, so both layers
    // describe the same situation the same way.
    if (cached && cached.mode === "replicate") {
      throw new Error(
        `Document '${docId}' is registered in replicate mode. ` +
          `Cannot call get() on a replicated document — it has no schema or ref.`,
      )
    }

    const factory = bound.factory({
      peerId: this.peerId,
      binding: bound.identityBinding,
    })

    // ── Shared prefix: create substrate, build ref ──
    //
    // A document that will hydrate is about to import operations this peer
    // wrote in an earlier session, so it takes the deferred-identity path:
    // `adopt` is called once that import lands, below. One that will not
    // hydrate has nothing to import, so `create()`'s immediate claim is
    // correct and `adopt` is a no-op.
    //
    // Whether deferring changes anything is a per-backend fact, and not one
    // this file should hold: `beginHydration` puts the question to the factory
    // and falls back to the safe answer for backends that do not care.
    //
    // Bound once and used at all three decision points below — see
    // `#usesStores` for why they have to agree.
    const willHydrate = this.#usesStores(bound.syncMode)
    const { substrate, adopt } = willHydrate
      ? beginHydration(factory, bound.schema)
      : { substrate: factory.create(bound.schema), adopt: NO_ADOPT }

    const ref: any = createRef(bound.schema, substrate, {
      lease: this.lease,
    })

    const readyInfo: DocReadyInfo = {
      docId,
      mode: "interpret",
      replica: substrate,
      replicaFactory: factory.replica,
      syncMode: bound.syncMode,
      schemaHash: bound.schemaHash,
      supportedHashes: [...bound.supportedHashes],
    }

    // `loaded` means "there is nothing further to wait for", not "a load
    // happened". A document that will not hydrate is in that state from the
    // start, because nothing downstream will ever resolve this latch for it.
    const hydration = createHydrationLatch(willHydrate ? "pending" : "loaded")

    const entry: DocCacheEntry = {
      mode: "interpret",
      ref,
      bound,
      readyInfo,
      announced: false,
      hydration,
    }
    // The early returns at the top of this method are the only thing between
    // an existing entry and this overwrite. Any new document mode has to be
    // handled up there — returned early, or refused — or it reaches this line
    // and whatever it was holding is replaced without a word.
    this.#docCache.set(docId, entry)

    // The storage term joins this document's settle conjunction. It is
    // registered here rather than after hydration finishes, because the point
    // of the term is to be observable *while* still pending — that is what
    // stops a caller concluding "empty" from a document that simply has not
    // finished loading.
    registerDocSyncMode(ref, bound.syncMode)
    registerHydrationTerm(
      ref,
      makeSettleTerm(
        () => hydration.state === "loaded",
        onChange => {
          if (hydration.state !== "pending") return () => {}
          hydration.listeners.add(onChange)
          return () => hydration.listeners.delete(onChange)
        },
      ),
      () => (hydration.state === "failed" ? hydration.error : undefined),
    )

    // ── Divergent tail: hydrate, or be ready now ──
    if (willHydrate) {
      const hydrationOp = this.#hydrate(
        docId,
        substrate,
        factory.replica,
        bound.syncMode,
        bound.schemaHash,
      ).then(
        () => {
          resolveHydration(hydration, { ok: true })
          // Claim identity before announcing or subscribing. Registration
          // publishes this document's version to the sync graph and the
          // subscription starts forwarding local changes; both should carry
          // the peer's final identity rather than the throwaway one it wore
          // while loading.
          //
          // Deliberately not on the failure branch below: a document whose
          // load failed stays unregistered and un-settled because its state is
          // unknown, and claiming a stable identity on something we may yet
          // reload would defeat that.
          adopt()
          this.#register(entry)
          this.#wireDocSubscription(docId, ref)
        },
        (error: unknown) => {
          // A failed load must stay visible. Marking the latch `failed` keeps
          // the document un-settled (so nothing concludes it is empty) and
          // holds the error for `whenSettled` to surface, rather than leaving
          // an unexplained hang. The document deliberately does NOT get
          // registered or announced: we have no idea what its state is.
          resolveHydration(hydration, { ok: false, error })
        },
      )
      this.#trackHydration(hydrationOp)
    } else {
      // No stores — doc is immediately ready.
      this.#register(entry)
      this.#wireDocSubscription(docId, ref)
    }

    return ref
  }

  /**
   * Create a replicated (headless) document.
   */
  #createReplicateDoc(
    docId: DocId,
    replicaFactory: ReplicaFactoryLike,
    syncMode: SyncMode,
    schemaHash: string,
  ): void {
    // Ensure semantics: first writer wins.
    const cached = this.#docCache.get(docId)
    if (cached && cached.mode === "replicate") return

    const replica = replicaFactory.createEmpty()

    const readyInfo: DocReadyInfo = {
      docId,
      mode: "replicate",
      replica,
      replicaFactory,
      syncMode,
      schemaHash,
    }

    // Same rule as the interpret path — a relay holds transient documents too.
    const willHydrate = this.#usesStores(syncMode)

    // A replicate document has no ref, so no settle term can be keyed to it
    // and it has no `docStatus` surface. The latch is still tracked so the
    // entry's hydration state is uniform across modes and available for
    // diagnostics.
    const hydration = createHydrationLatch(willHydrate ? "pending" : "loaded")

    const entry: DocCacheEntry = {
      mode: "replicate",
      readyInfo,
      announced: false,
      hydration,
    }
    this.#docCache.set(docId, entry)

    if (willHydrate) {
      const hydrationOp = this.#hydrate(
        docId,
        replica,
        replicaFactory,
        syncMode,
        schemaHash,
      ).then(
        () => {
          resolveHydration(hydration, { ok: true })
          this.#register(entry)
        },
        (error: unknown) => {
          resolveHydration(hydration, { ok: false, error })
        },
      )
      this.#trackHydration(hydrationOp)
    } else {
      // No stores — doc is immediately ready.
      this.#register(entry)
    }
  }

  /**
   * Wire the changefeed subscription for a document: forwards changesets
   * to the hooks (Exchange wires these into the Synchronizer), and
   * self-persists local (non-replay) changesets unconditionally — so a
   * standalone Runtime (no Exchange) durably persists its own mutations
   * without depending on the Exchange's `Synchronizer → onStateAdvanced`
   * wiring. Safe to run alongside that wiring: `#persistIfAdvanced` is
   * idempotent per confirmed version, so whichever call reaches the store
   * program first performs the real write and the other is a no-op.
   *
   * Marks the doc dirty and schedules a microtask-deferred, coalesced
   * drain rather than persisting inline — a single `batch()` fires one
   * changeset per touched field, so persisting on every changeset would
   * export and dispatch the same starting delta once per field instead
   * of once per batch. Context: jj:mrlnmlus.
   *
   * Called after hydration completes (or immediately if no stores).
   */
  #wireDocSubscription(docId: DocId, ref: any): void {
    subscribe(ref, changeset => {
      this.#hooks.onDocChangeset?.(docId, changeset)
      if (!changeset.replay) {
        this.#markLocalChangeDirty(docId)
      }
    })
  }

  /**
   * Marks `docId` as having a pending local changeset, and schedules a
   * microtask to drain the whole dirty set (once per microtask tick,
   * regardless of how many docs/changesets accumulate before it runs).
   */
  #markLocalChangeDirty(docId: DocId): void {
    this.#dirtyLocalChanges.add(docId)
    if (this.#localChangeDrain) return // Already scheduled this tick.
    this.#localChangeDrain = Promise.resolve().then(() => {
      this.#localChangeDrain = null
      this.#drainLocalChanges()
    })
    this.#trackHydration(this.#localChangeDrain)
  }

  /**
   * Snapshot-then-clear the dirty set (so re-entrant local writes during
   * the drain schedule a fresh drain rather than being lost), and persist
   * each doc's current state at most once.
   */
  #drainLocalChanges(): void {
    const docIds = [...this.#dirtyLocalChanges]
    this.#dirtyLocalChanges.clear()
    for (const docId of docIds) {
      const entry = this.#docCache.get(docId)
      if (entry && entry.mode !== "deferred") {
        this.#persistIfAdvanced(
          docId,
          entry.readyInfo.replica,
          entry.readyInfo.replicaFactory,
        )
      }
    }
  }

  /**
   * Fire the `onDocReady` hook for a document, exactly once.
   *
   * No reference to any `Store` — structurally incapable of triggering a
   * hydration replay. Safe to call for an already-announced entry (no-op)
   * or for an entry that was hydrated before hooks existed (backfill via
   * {@link setHooks}). This is the only method permitted to call
   * `RuntimeHooks.onDocReady`. Context: jj:mrlnmlus.
   *
   * `announced` only flips to `true` once a hook is actually present and
   * called — a doc created before any hooks exist (the standalone-Runtime
   * case) must remain un-announced so `setHooks`'s later backfill still
   * fires for it.
   */
  #register(
    entry: Extract<DocCacheEntry, { mode: "interpret" | "replicate" }>,
  ): void {
    if (entry.announced) return
    if (!this.#hooks.onDocReady) return
    this.#hooks.onDocReady(entry.readyInfo)
    entry.announced = true
  }

  // =========================================================================
  // INTERNAL — Hydration tracking
  // =========================================================================

  #trackHydration(op: Promise<void>): void {
    this.#pendingHydrations.add(op)
    op.finally(() => {
      this.#pendingHydrations.delete(op)
    })
  }

  async #awaitHydrations(): Promise<void> {
    while (this.#pendingHydrations.size > 0) {
      await Promise.all(this.#pendingHydrations)
    }
  }

  // =========================================================================
  // INTERNAL — Storage: hydrate
  // =========================================================================

  /**
   * Async hydration — loads stored entries and merges them into the
   * replica, then registers the doc in the store program.
   *
   * Storage I/O only — this method never fires `onDocReady`. It has no
   * knowledge of hooks at all, which makes it structurally impossible to
   * accidentally re-run hydration (and therefore double-`merge()` stored
   * ops) while trying to announce an already-hydrated document. Callers
   * call {@link Runtime.#register} separately, once hydration resolves.
   * Context: jj:mrlnmlus.
   *
   * For interpret mode with structural clientID 0, `factory.create(schema)`
   * produces structural ops at `(0, 0..N)` — identical to what any stored
   * state has. Merging stored data deduplicates the structural ops and
   * applies application ops. No separate replica, no upgrade step.
   */
  async #hydrate(
    docId: DocId,
    replica: ReplicaLike,
    replicaFactory: ReplicaFactoryLike,
    syncMode: SyncMode,
    schemaHash: string,
  ): Promise<void> {
    const meta: StoreMeta = {
      replicaType: replicaFactory.replicaType,
      syncMode,
      schemaHash,
    }

    // First-hit semantics: use the first store that has data
    let hadStoredEntries = false
    // A store that throws has told us nothing — not "the document is empty",
    // merely "I could not answer". Track those separately from stores that
    // answered (with data or with a definitive null), because the difference
    // decides whether an empty replica means "nothing stored" or "we failed to
    // look". Reporting the second as the first is how defaults get written
    // over data that exists on disk.
    const readFailures: unknown[] = []
    let anyStoreAnswered = false
    for (const backend of this.#stores) {
      try {
        const existing = await backend.currentMeta(docId)
        anyStoreAnswered = true
        if (existing) {
          for await (const record of backend.loadAll(docId)) {
            if (record.kind === "entry") {
              try {
                replica.merge(record.payload, { origin: "sync" })
                hadStoredEntries = true
              } catch (err) {
                console.warn(
                  `[runtime] failed to merge stored entry for doc '${docId}':`,
                  err,
                )
              }
            }
          }
          break // First-hit: use first store that has the doc
        }
      } catch (error) {
        readFailures.push(error)
        console.warn(
          `[runtime] store hydration failed for doc '${docId}':`,
          error,
        )
      }
    }

    // Only a *total* read failure is fatal. With several stores configured, one
    // failing and another answering is a legitimate fallback — that is what
    // first-hit ordering is for. But if nothing could be read at all, the
    // caller must not be handed a document that merely looks empty.
    if (!anyStoreAnswered && readFailures.length > 0) {
      throw readFailures[0]
    }

    const handle = this.#storeHandle
    if (handle) {
      if (hadStoredEntries) {
        handle.dispatch({
          type: "hydrated",
          docId,
          version: replica.version().serialize(),
        })
      } else {
        handle.dispatch({
          type: "register",
          docId,
          meta,
          entirety: replica.exportEntirety(),
          version: replica.version().serialize(),
        })
      }
    }
  }

  // =========================================================================
  // INTERNAL — Tick clock
  // =========================================================================

  /**
   * Start the heartbeat tick. Iterates all interpreted documents and
   * calls `substrate.tick(now)` if the substrate supports it.
   *
   * This is the imperative shell side of the pure `tick(now)` functional
   * core method on substrates. The clock lives here so substrates stay
   * side-effect-free (FC/IS purity).
   */
  #startTick(): void {
    if (this.#tickTimer !== null) return
    this.#tickTimer = setInterval(() => {
      const now = Date.now()
      for (const [, entry] of this.#docCache) {
        if (entry.mode !== "interpret") continue
        const substrate = (entry.ref as any)?.[SUBSTRATE]
        // `tick` is optional on the Substrate interface, and most substrates
        // have no use for it — only `ephemeral` does, to re-project decayed
        // leaves as their structural zeros. Everything durable skips this.
        if (substrate && typeof substrate.tick === "function") {
          substrate.tick(now)
        }
      }
    }, this.#tickIntervalMs)
    // Don't keep the Node.js process alive just for the tick.
    // In browsers, `unref` doesn't exist — guard with a runtime check.
    if (typeof (this.#tickTimer as any).unref === "function") {
      ;(this.#tickTimer as any).unref()
    }
  }

  #stopTick(): void {
    if (this.#tickTimer !== null) {
      clearInterval(this.#tickTimer)
      this.#tickTimer = null
    }
  }
}
