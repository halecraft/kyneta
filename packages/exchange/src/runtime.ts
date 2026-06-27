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
import { createRef, SUBSTRATE, subscribe } from "@kyneta/schema"
import type { DocId } from "@kyneta/transport"
import type { Store, StoreMeta } from "./store/store.js"
import {
  allDocsIdle,
  type StoreEffect,
  type StoreInput,
  type StoreModel,
  storeProgram,
} from "./store/store-program.js"

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
// DocCacheEntry — local document registry entry
// ---------------------------------------------------------------------------

export type DocCacheEntry =
  | { mode: "interpret"; ref: any; bound: BoundSchema; suspended?: boolean }
  | { mode: "replicate"; suspended?: boolean }
  | { mode: "deferred" }

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
   */
  setHooks(hooks: RuntimeHooks): void {
    this.#hooks = hooks
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
   * @param docId - The document ID
   * @param bound - A BoundSchema created by `bind()`
   * @returns A full-stack ref with the local substrate
   */
  get: RuntimeGet = (docId, bound) =>
    this.createInterpretDoc(docId, bound) as never

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
   */
  destroy(docId: DocId): void {
    this.#docCache.delete(docId)
    this.#storeHandle?.dispatch({ type: "destroy", docId })
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
   * No-op if no stores are configured.
   */
  onStateAdvanced(
    docId: DocId,
    replica: ReplicaLike,
    replicaFactory: ReplicaFactoryLike,
  ): void {
    if (!this.#storeHandle) return
    const phase = this.#storeHandle.getState().docs.get(docId)
    if (!phase) return // Not yet registered — still hydrating

    const confirmedVersion = phase.version
    if (!confirmedVersion) return // Empty string = initial register, skip

    const sinceVersion = replicaFactory.parseVersion(confirmedVersion)
    const delta = replica.exportSince(sinceVersion)
    if (!delta) return // Version didn't actually advance — deduplication

    const newVersion = replica.version().serialize()
    this.#storeHandle.dispatch({
      type: "state-advanced",
      docId,
      delta,
      newVersion,
    })
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

    const factory = bound.factory({
      peerId: this.peerId,
      binding: bound.identityBinding,
    })

    // ── Shared prefix: create substrate, build ref ──
    const substrate = factory.create(bound.schema)

    const ref: any = createRef(bound.schema, substrate, {
      lease: this.lease,
    })

    this.#docCache.set(docId, {
      mode: "interpret",
      ref,
      bound,
    })

    // ── Divergent tail: store vs no-store ──
    if (this.#stores.length > 0) {
      const hydrationOp = this.#hydrateAndRegister(
        docId,
        substrate,
        factory.replica,
        bound.syncMode,
        bound.schemaHash,
        "interpret",
        [...bound.supportedHashes],
      ).then(() => {
        this.#wireDocSubscription(docId, ref)
      })
      this.#trackHydration(hydrationOp)
    } else {
      // No stores — doc is immediately ready.
      this.#fireDocReady(docId, "interpret", substrate, factory.replica, {
        syncMode: bound.syncMode,
        schemaHash: bound.schemaHash,
        supportedHashes: [...bound.supportedHashes],
      })
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

    this.#docCache.set(docId, { mode: "replicate" })

    if (this.#stores.length > 0) {
      const hydrationOp = this.#hydrateAndRegister(
        docId,
        replica,
        replicaFactory,
        syncMode,
        schemaHash,
        "replicate",
      )
      this.#trackHydration(hydrationOp)
    } else {
      // No stores — doc is immediately ready.
      this.#fireDocReady(docId, "replicate", replica, replicaFactory, {
        syncMode,
        schemaHash,
      })
    }
  }

  /**
   * Wire the changefeed subscription for a document and forward
   * changesets to the hooks (Exchange wires these into the Synchronizer).
   *
   * Called after hydration completes (or immediately if no stores).
   */
  #wireDocSubscription(docId: DocId, ref: any): void {
    subscribe(ref, changeset => {
      this.#hooks.onDocChangeset?.(docId, changeset)
    })
  }

  /**
   * Fire the `onDocReady` hook with the document's sync metadata.
   */
  #fireDocReady(
    docId: DocId,
    mode: "interpret" | "replicate",
    replica: ReplicaLike,
    replicaFactory: ReplicaFactoryLike,
    meta: {
      syncMode: SyncMode
      schemaHash: string
      supportedHashes?: readonly string[]
    },
  ): void {
    if (!this.#hooks.onDocReady) return

    const info: DocReadyInfo = {
      docId,
      mode,
      replica,
      replicaFactory,
      syncMode: meta.syncMode,
      schemaHash: meta.schemaHash,
      ...(meta.supportedHashes
        ? { supportedHashes: meta.supportedHashes }
        : {}),
    }
    this.#hooks.onDocReady(info)
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
  // INTERNAL — Storage: hydrate & register
  // =========================================================================

  /**
   * Async hydration — loads stored entries and merges them into the
   * replica, then registers the doc in the store program and fires
   * `onDocReady`.
   *
   * For interpret mode with structural clientID 0, `factory.create(schema)`
   * produces structural ops at `(0, 0..N)` — identical to what any stored
   * state has. Merging stored data deduplicates the structural ops and
   * applies application ops. No separate replica, no upgrade step.
   */
  async #hydrateAndRegister(
    docId: DocId,
    replica: ReplicaLike,
    replicaFactory: ReplicaFactoryLike,
    syncMode: SyncMode,
    schemaHash: string,
    mode: "interpret" | "replicate",
    supportedHashes?: readonly string[],
  ): Promise<void> {
    const meta: StoreMeta = {
      replicaType: replicaFactory.replicaType,
      syncMode,
      schemaHash,
    }

    // First-hit semantics: use the first store that has data
    let hadStoredEntries = false
    for (const backend of this.#stores) {
      try {
        const existing = await backend.currentMeta(docId)
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
        console.warn(
          `[runtime] store hydration failed for doc '${docId}':`,
          error,
        )
      }
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

    // Fire ready hook — Exchange calls synchronizer.registerDoc here.
    this.#fireDocReady(docId, mode, replica, replicaFactory, {
      syncMode,
      schemaHash,
      ...(supportedHashes ? { supportedHashes } : {}),
    })
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
        // Defensive: substrates may not implement tick (it's optional).
        // The `.decay()` feature (jj:nxxwqosl) will implement it on the
        // state substrate.
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
