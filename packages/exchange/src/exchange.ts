// exchange — the public API for @kyneta/exchange.
//
// The Exchange class is the central orchestrator for substrate-agnostic
// state synchronization. It manages document lifecycle, coordinates
// adapters and storage backends, and provides the main API for
// document operations.
//
// Storage is a direct dependency — not an adapter, not a channel, not
// a participant in the sync protocol. The Exchange handles hydration
// and persistence directly, keeping the synchronizer purely focused
// on network sync.
//
// Usage:
//   const exchange = new Exchange({
//     identity: { name: "alice" },
//     adapters: [createWebsocketClient({ url: "ws://localhost:3000/ws" })],
//     storage: [createInMemoryStorage()],
//   })
//
//   const TodoDoc = bindLoro(LoroSchema.doc({ title: LoroSchema.text() }))  // LoroSchema from @kyneta/loro-schema
//   const doc = exchange.get("my-doc", TodoDoc)
//   sync(doc).waitForSync()

import {
  type BoundSchema,
  changefeed,
  type DocMetadata,
  type FactoryBuilder,
  type Interpret,
  interpret,
  isBoundSchema,
  type MergeStrategy,
  type Ref,
  type Replica,
  type ReplicaFactory,
  type ReplicaType,
  type Replicate,
  readable,
  registerSubstrate,
  type Schema as SchemaNode,
  type SubstrateFactory,
  type SubstratePayload,
  subscribe,
  writable,
} from "@kyneta/schema"
import type { AdapterFactory, AnyAdapter } from "./adapter/adapter.js"
import { registerSync } from "./sync.js"
import { type DocRuntime, Synchronizer } from "./synchronizer.js"
import type { StorageBackend } from "./storage/storage-backend.js"
import type { DocId, PeerIdentityDetails } from "./types.js"
import { generatePeerId, validatePeerId } from "./utils.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Outbound flow control: should this peer participate in the sync graph
 * for this document? Checked at every outbound gate (present, push,
 * relay).
 *
 * @returns `true` to include the peer, `false` to exclude.
 */
export type RoutePredicate = (
  docId: DocId,
  peer: PeerIdentityDetails,
) => boolean

/**
 * Inbound flow control: should mutations from this peer be accepted
 * for this document? Checked before importing offers.
 *
 * @returns `true` to accept, `false` to reject silently.
 */
export type AuthorizePredicate = (
  docId: DocId,
  peer: PeerIdentityDetails,
) => boolean

/**
 * Callback invoked when a peer announces a document the local exchange
 * doesn't have. Return a disposition to determine how the document
 * participates in the sync graph:
 *
 * - `Interpret(bound)` — full interpretation with schema, ref, changefeed.
 * - `Replicate(replicaFactory, strategy)` — headless replication (relay, storage).
 * - `undefined` — ignore the unknown document.
 *
 * @param docId - The document ID announced by the peer
 * @param peer - Identity of the peer that announced the document
 * @param replicaType - The replica type the remote peer uses for this document
 * @param mergeStrategy - The merge strategy the remote peer uses for this document
 * @returns A disposition (`Interpret | Replicate`), or `undefined` to ignore
 */
export type OnDocDiscovered = (
  docId: DocId,
  peer: PeerIdentityDetails,
  replicaType: ReplicaType,
  mergeStrategy: MergeStrategy,
) => Interpret | Replicate | undefined

/**
 * Callback invoked when a peer sends a `dismiss` message for a document.
 * The peer is announcing it's leaving the sync graph for this document.
 *
 * The callback can take any application-level action: call
 * `exchange.dismiss(docId)` to also leave, archive the doc, etc.
 *
 * @param docId - The document ID being dismissed
 * @param peer - Identity of the peer that sent the dismiss
 */
export type OnDocDismissed = (docId: DocId, peer: PeerIdentityDetails) => void

/**
 * Options for creating an Exchange.
 */
export type ExchangeParams = {
  /**
   * Peer identity. If `peerId` is omitted, one is auto-generated.
   */
  identity?: Partial<PeerIdentityDetails>

  /**
   * Adapter factories for network connectivity.
   *
   * Each factory is called once during Exchange construction to create
   * a fresh adapter instance. Use `create*` helpers for low-friction setup:
   *
   * ```typescript
   * adapters: [createWebsocketClient({ url: "ws://localhost:3000/ws" })]
   * ```
   */
  adapters?: AdapterFactory[]

  /**
   * Storage backends for persistent document storage.
   *
   * Storage is a direct Exchange dependency — not an adapter, not a
   * channel, not a participant in the sync protocol. The Exchange
   * handles hydration (loading from storage on `get()`/`replicate()`)
   * and persistence (saving on network imports and local changes)
   * directly.
   *
   * ```typescript
   * storage: [createInMemoryStorage()]
   * ```
   */
  storage?: StorageBackend[]

  /**
   * Outbound flow control. Determines which peers participate in the
   * sync graph for each document. Checked at every outbound gate:
   * initial present, doc-ensure broadcast, relay push, local change push.
   *
   * Also gates `onDocDiscovered`: if `route` returns `false` for
   * the announcing peer, the callback never fires.
   *
   * @default () => true (open routing)
   */
  route?: RoutePredicate

  /**
   * Inbound flow control. Determines whose mutations are accepted.
   * Checked before importing offers from network peers.
   *
   * @default () => true (accept all)
   */
  authorize?: AuthorizePredicate

  /**
   * Called when a peer sends `dismiss` for a document, announcing
   * it's leaving the sync graph. The callback handles the application
   * response — it can call `exchange.dismiss(docId)` to also leave,
   * or ignore the event.
   *
   * @default undefined (dismiss messages are no-ops)
   */
  onDocDismissed?: OnDocDismissed

  /**
   * Called when a peer discovers a document this exchange doesn't have.
   *
   * Return a disposition to determine how the document participates:
   * - `Interpret(bound)` — full interpretation (client apps, game servers).
   * - `Replicate(replicaFactory, strategy)` — headless replication (relay, storage).
   * - `undefined` — ignore the unknown document.
   *
   * This enables dynamic document patterns where one peer creates a
   * document and the other materializes it on demand.
   *
   * @example
   * ```typescript
   * import { Interpret, Replicate } from "@kyneta/schema"
   * import { loroReplicaFactory } from "@kyneta/loro-schema"
   *
   * const exchange = new Exchange({
   *   // Relay server — replicate all discovered docs without schema knowledge
   *   onDocDiscovered: (docId, peer) => Replicate(loroReplicaFactory, "causal"),
   * })
   *
   * // Or: interpret specific docs, ignore the rest
   * const exchange2 = new Exchange({
   *   onDocDiscovered: (docId, peer) => {
   *     if (docId.startsWith("input:")) return Interpret(PlayerInputDoc)
   *     return undefined
   *   },
   * })
   * ```
   */
  onDocDiscovered?: OnDocDiscovered
}

// ---------------------------------------------------------------------------
// Doc cache entry
// ---------------------------------------------------------------------------

type DocCacheEntry =
  | { mode: "interpret"; ref: any; bound: BoundSchema }
  | { mode: "replicate" }

// ---------------------------------------------------------------------------
// Exchange
// ---------------------------------------------------------------------------

/**
 * The Exchange class is the central orchestrator for substrate-agnostic
 * state synchronization.
 *
 * It manages the lifecycle of documents, coordinates subsystems (adapters,
 * synchronizer, storage backends), and provides the main public API for
 * document operations.
 *
 * A single Exchange can host documents backed by different substrate types
 * simultaneously (heterogeneous documents). Each document's substrate type
 * and sync strategy are determined by its `BoundSchema`.
 *
 * @example
 * ```typescript
 * import { Exchange, sync } from "@kyneta/exchange"
 * import { bindPlain } from "@kyneta/schema"
 * import { bindLoro, LoroSchema } from "@kyneta/loro-schema"
 *
 * const exchange = new Exchange({
 *   identity: { name: "alice" },
 *   adapters: [createBridgeAdapter({ adapterType: "peer-a", bridge })],
 *   storage: [createInMemoryStorage()],
 * })
 *
 * const TodoDoc = bindLoro(LoroSchema.doc({ title: LoroSchema.text() }))
 * const ConfigDoc = bindPlain(Schema.doc({ theme: Schema.string() }))
 *
 * const doc = exchange.get("my-doc", TodoDoc)
 * const config = exchange.get("config", ConfigDoc)
 * doc.title()  // read
 * change(doc, d => d.title.insert(0, "Hello"))  // write
 * await sync(doc).waitForSync()  // sync
 * ```
 */
export class Exchange {
  readonly peerId: string

  readonly #synchronizer: Synchronizer
  readonly #docCache = new Map<DocId, DocCacheEntry>()
  readonly #storageBackends: StorageBackend[]

  /**
   * Pending async storage operations tracked for flush()/shutdown().
   * Each promise is added when a storage write begins and removed
   * when it settles.
   */
  readonly #pendingStorageOps: Set<Promise<void>> = new Set()

  /**
   * Per-doc operation chains ensuring sequential backend access.
   * Each docId maps to the tail of a promise chain — new operations
   * for that docId await the previous one before proceeding.
   */
  readonly #docQueues: Map<DocId, Promise<void>> = new Map()

  /**
   * Per-exchange factory cache. Each FactoryBuilder is called at most once
   * per exchange, and the resulting SubstrateFactory is cached here.
   *
   * This ensures:
   * 1. A BoundSchema shared across multiple exchanges gets a fresh factory
   *    per exchange (with the correct peerId).
   * 2. Multiple documents using the same BoundSchema within one exchange
   *    share the same factory instance.
   */
  readonly #factoryCache = new WeakMap<
    FactoryBuilder<any>,
    SubstrateFactory<any>
  >()

  constructor({
    identity = {},
    adapters = [],
    storage = [],
    route,
    authorize,
    onDocDismissed,
    onDocDiscovered,
  }: ExchangeParams = {}) {
    // Resolve peer identity
    const peerId = identity.peerId ?? generatePeerId()
    validatePeerId(peerId)
    this.peerId = peerId

    this.#storageBackends = storage

    const fullIdentity: PeerIdentityDetails = {
      peerId,
      name: identity.name,
      type: identity.type ?? "user",
    }

    // Create synchronizer — call each factory to produce fresh adapter instances
    let warnedNoDiscoverCallback = false
    this.#synchronizer = new Synchronizer({
      identity: fullIdentity,
      adapters: adapters.map(factory => factory()),
      route: route ?? (() => true),
      authorize: authorize ?? (() => true),
      onDocDismissed,
      onDocCreationRequested: (docId, peer, replicaType, mergeStrategy) => {
        const result = onDocDiscovered
          ? onDocDiscovered(docId, peer, replicaType, mergeStrategy)
          : undefined

        if (!result) {
          if (!onDocDiscovered && !warnedNoDiscoverCallback) {
            warnedNoDiscoverCallback = true
            console.warn(
              `[exchange] Peer "${peer.peerId}" discovered document "${docId}" but no onDocDiscovered ` +
                `callback is configured. The document will be ignored. To accept peer-announced ` +
                `documents, provide onDocDiscovered in ExchangeParams.`,
            )
          }
          return
        }

        switch (result.kind) {
          case "interpret":
            // Cast to avoid TS2589 — get()'s Ref<S> return type triggers
            // excessively deep instantiation when S defaults to SchemaNode.
            ;(this as any).get(docId, result.bound)
            break
          case "replicate":
            this.replicate(docId, result.replicaFactory, result.strategy)
            break
        }
      },
      onDocImported: (docId, payload, version) => {
        // Persist incoming network payloads to all storage backends.
        // Uses append() because network imports are incremental deltas
        // that should accumulate alongside existing entries.
        this.#persistToStorage(docId, backend =>
          backend.append(docId, { payload, version }),
        )
      },
    })
  }

  // =========================================================================
  // PRIVATE — Factory resolution
  // =========================================================================

  /**
   * Resolve a FactoryBuilder to a SubstrateFactory, caching per-exchange.
   *
   * The builder is called with `{ peerId: this.peerId }` on first use.
   * Subsequent calls with the same builder return the cached factory.
   */
  #resolveFactory(builder: FactoryBuilder<any>): SubstrateFactory<any> {
    let factory = this.#factoryCache.get(builder)
    if (!factory) {
      factory = builder({ peerId: this.peerId })
      this.#factoryCache.set(builder, factory)
    }
    return factory
  }

  // =========================================================================
  // PRIVATE — Storage helpers
  // =========================================================================

  /**
   * Track an async storage operation so flush() can await it.
   */
  #trackOp(op: Promise<void>): void {
    this.#pendingStorageOps.add(op)
    op.finally(() => {
      this.#pendingStorageOps.delete(op)
    })
  }

  /**
   * Enqueue a backend operation for a specific docId, ensuring
   * sequential execution per document.
   *
   * Uses a promise-chain pattern: each new operation for a docId
   * is chained onto the previous one. Cross-document operations
   * remain concurrent for throughput.
   */
  #enqueueForDoc(docId: DocId, fn: () => Promise<void>): Promise<void> {
    const prev = this.#docQueues.get(docId) ?? Promise.resolve()
    const next = prev.then(fn, fn) // Run fn regardless of prev result
    this.#docQueues.set(docId, next)

    // Clean up the queue entry when this tail settles and nothing new
    // has been chained on since.
    const cleanup = () => {
      if (this.#docQueues.get(docId) === next) {
        this.#docQueues.delete(docId)
      }
    }
    next.then(cleanup, cleanup)

    return next
  }

  /**
   * Run a storage operation against all backends for a document,
   * with per-doc sequencing and flush tracking.
   */
  #persistToStorage(
    docId: DocId,
    operation: (backend: StorageBackend) => Promise<void>,
  ): void {
    if (this.#storageBackends.length === 0) return

    const op = this.#enqueueForDoc(docId, async () => {
      for (const backend of this.#storageBackends) {
        try {
          await operation(backend)
        } catch (error) {
          console.error(
            `[exchange] storage operation failed for doc '${docId}':`,
            error,
          )
        }
      }
    })
    this.#trackOp(op)
  }

  /**
   * Hydrate a replica from storage backends, then register with the
   * synchronizer and wire persistence.
   *
   * This is the async tail of get()/replicate(). The caller has already
   * created the replica and cached the ref — this function loads stored
   * data, registers with the synchronizer (so present/interest carry
   * the hydrated version), and wires ongoing persistence.
   */
  async #hydrateAndRegister(
    docId: DocId,
    replica: Replica<any>,
    replicaFactory: ReplicaFactory<any>,
    strategy: MergeStrategy,
    mode: "interpret" | "replicate",
  ): Promise<void> {
    const metadata: DocMetadata = {
      replicaType: replicaFactory.replicaType,
      mergeStrategy: strategy,
    }

    // 1. Ensure doc metadata is registered in all backends
    for (const backend of this.#storageBackends) {
      try {
        await backend.ensureDoc(docId, metadata)
      } catch (error) {
        console.error(
          `[exchange] ensureDoc failed for doc '${docId}':`,
          error,
        )
      }
    }

    // 2. Hydrate from storage — load all entries and merge into the replica
    for (const backend of this.#storageBackends) {
      try {
        const existing = await backend.lookup(docId)
        if (existing) {
          for await (const entry of backend.loadAll(docId)) {
            try {
              replica.merge(entry.payload, "sync")
            } catch (err) {
              console.warn(
                `[exchange] failed to merge stored entry for doc '${docId}':`,
                err,
              )
            }
          }
        }
      } catch (error) {
        console.error(
          `[exchange] storage hydration failed for doc '${docId}':`,
          error,
        )
      }
    }

    // 3. Register with synchronizer — present/interest messages carry
    //    the hydrated version, not an empty one
    this.#synchronizer.registerDoc({
      mode,
      docId,
      replica,
      replicaFactory,
      strategy,
    } as DocRuntime)
  }

  // =========================================================================
  // PUBLIC API — Document access
  // =========================================================================

  /**
   * Gets (or creates) a document with a bound schema.
   *
   * This is the primary API for accessing documents. Returns a full-stack
   * `Ref<S>` — callable, navigable, writable, transactable, and observable.
   *
   * The ref is backed by a substrate determined by the `BoundSchema`'s
   * factory builder. The bound schema's merge strategy determines how
   * the exchange syncs this document with peers.
   *
   * Multiple calls with the same `docId` return the same instance.
   * Calling with a different BoundSchema for the same `docId` throws.
   *
   * The ref is returned synchronously. If storage backends are configured,
   * hydration happens asynchronously — the ref starts empty and the
   * changefeed fires when stored data is merged. The synchronizer only
   * learns about the doc after hydration completes, so present/interest
   * messages carry the hydrated version.
   *
   * @param docId - The document ID
   * @param bound - A BoundSchema created by `bind()`, `bindPlain()`, `bindEphemeral()`, or `bindLoro()`
   * @returns A full-stack Ref<S> with sync capabilities via `sync()`
   *
   * @example
   * ```typescript
   * import { bindPlain } from "@kyneta/schema"
   * import { bindLoro, LoroSchema } from "@kyneta/loro-schema"
   *
   * const TodoDoc = bindLoro(LoroSchema.doc({ title: LoroSchema.text() }))
   * const doc = exchange.get("my-doc", TodoDoc)
   *
   * // Initial content via change() after construction:
   * change(doc, d => { d.title.insert(0, "Hello") })
   * ```
   */
  get<S extends SchemaNode>(docId: DocId, bound: BoundSchema<S>): Ref<S> {
    // Check cache first
    const cached = this.#docCache.get(docId)

    if (cached) {
      if (cached.mode === "replicate") {
        throw new Error(
          `Document '${docId}' is registered in replicate mode. ` +
            `Cannot call exchange.get() on a replicated document — it has no schema or ref.`,
        )
      }

      // Validate BoundSchema matches — throw if different binding for same docId
      if (cached.bound !== bound) {
        throw new Error(
          `Document '${docId}' already exists with a different BoundSchema. ` +
            `Use the same BoundSchema object when calling exchange.get() for the same document.`,
        )
      }

      return cached.ref as Ref<S>
    }

    // Resolve factory from the BoundSchema's builder
    const factory = this.#resolveFactory(bound.factory)

    // Create substrate — empty, with Zero.structural defaults.
    // Initial content should be applied via change() after get().
    const substrate = factory.create(bound.schema)

    // Build the full interpreter stack
    // The `as any` avoids TS2589 — interpret's fluent API produces deeply
    // recursive types when S is the abstract SchemaNode. The public
    // get<S>() signature provides the correct Ref<S> return type.
    const ref: any = (interpret as any)(bound.schema, substrate.context())
      .with(readable)
      .with(writable)
      .with(changefeed)
      .done()

    // Register substrate for unwrap() escape hatch
    registerSubstrate(ref, substrate)

    // Register sync capabilities
    registerSync(ref, {
      peerId: this.peerId,
      docId,
      synchronizer: this.#synchronizer,
    })

    // Cache — must happen before the async hydration tail
    this.#docCache.set(docId, {
      mode: "interpret",
      ref,
      bound,
    })

    if (this.#storageBackends.length > 0) {
      // Storage path: hydrate from storage, then register with synchronizer.
      // The ref is returned immediately (empty). The changefeed fires when
      // stored data is merged. The synchronizer learns about the doc only
      // after hydration, so present/interest carry the hydrated version.
      const hydrationOp = this.#hydrateAndRegister(
        docId,
        substrate,
        factory.replica,
        bound.strategy,
        "interpret",
      ).then(() => {
        // Wire changefeed → synchronizer + storage AFTER hydration so that
        // the merges during hydration (with origin "sync") don't trigger
        // unnecessary notifyLocalChange calls or storage writes.
        subscribe(ref, changeset => {
          if (changeset.origin === "sync") return

          this.#synchronizer.notifyLocalChange(docId)

          // Persist local mutations as consolidated snapshots via replace().
          const payload = substrate.exportEntirety()
          const version = substrate.version().serialize()
          this.#persistToStorage(docId, backend =>
            backend.replace(docId, { payload, version }),
          )
        })
      })
      this.#trackOp(hydrationOp)
    } else {
      // No storage: register with synchronizer immediately
      this.#synchronizer.registerDoc({
        mode: "interpret",
        docId,
        replica: substrate, // Substrate extends Replica
        replicaFactory: factory.replica,
        strategy: bound.strategy,
      })

      // Auto-wire changefeed → synchronizer: when a local mutation fires
      // the changefeed, notify the synchronizer so it pushes to peers.
      // Remote imports arrive with origin "sync" — skip those to avoid echo.
      subscribe(ref, changeset => {
        if (changeset.origin === "sync") return
        this.#synchronizer.notifyLocalChange(docId)
      })
    }

    return ref as Ref<S>
  }

  /**
   * Register a document for headless replication — no schema, no ref,
   * no changefeed. The document participates in the sync graph via a
   * bare `Replica<V>`, enabling version tracking, per-peer delta
   * computation, and state accumulation.
   *
   * This is the correct tier for relay servers, routing servers, and
   * audit logs — any participant that needs to accumulate and relay
   * state without interpreting document fields.
   *
   * @param docId - The document ID
   * @param replicaFactory - Factory for constructing headless replicas
   * @param strategy - The merge strategy for this document
   *
   * @example
   * ```typescript
   * import { loroReplicaFactory } from "@kyneta/loro-schema"
   *
   * // Schema-free relay — replicate all docs without compile-time schema knowledge
   * exchange.replicate("shared-doc", loroReplicaFactory, "causal")
   * ```
   */
  replicate(
    docId: DocId,
    replicaFactory: ReplicaFactory<any>,
    strategy: MergeStrategy,
  ): void {
    // Check cache — throw if already registered
    if (this.#docCache.has(docId)) {
      throw new Error(
        `Document '${docId}' is already registered. ` +
          `Cannot call exchange.replicate() on an existing document.`,
      )
    }

    // Create headless replica — no schema, no interpreter stack
    const replica = replicaFactory.createEmpty()

    // Cache
    this.#docCache.set(docId, { mode: "replicate" })

    if (this.#storageBackends.length > 0) {
      // Storage path: hydrate from storage, then register with synchronizer.
      const hydrationOp = this.#hydrateAndRegister(
        docId,
        replica,
        replicaFactory,
        strategy,
        "replicate",
      )
      this.#trackOp(hydrationOp)
    } else {
      // No storage: register with synchronizer immediately
      this.#synchronizer.registerDoc({
        mode: "replicate",
        docId,
        replica,
        replicaFactory,
        strategy,
      })
    }
  }

  /**
   * Check if a document exists in the exchange.
   *
   * Returns `true` for documents registered via `get()` (interpret mode)
   * or `replicate()` (replicate mode).
   *
   * @param docId - The document ID
   * @returns true if the document exists
   */
  has(docId: DocId): boolean {
    return this.#docCache.has(docId)
  }

  /**
   * Dismiss a document — remove it locally, broadcast `dismiss` to
   * all peers, and delete from storage backends.
   *
   * This is the single public API for document removal. For bulk
   * teardown without per-doc notification, use `reset()` or `shutdown()`.
   *
   * @param docId - The ID of the document to dismiss
   */
  dismiss(docId: DocId): void {
    this.#docCache.delete(docId)
    this.#synchronizer.dismissDocument(docId)

    // Delete from all storage backends
    this.#persistToStorage(docId, backend => backend.delete(docId))
  }

  // =========================================================================
  // PUBLIC API — Adapter management
  // =========================================================================

  /**
   * Add an adapter at runtime.
   * Idempotent: adding an adapter with the same adapterId is a no-op.
   */
  async addAdapter(adapter: AnyAdapter): Promise<void> {
    await this.#synchronizer.addAdapter(adapter)
  }

  /**
   * Remove an adapter at runtime.
   * Idempotent: removing a non-existent adapter is a no-op.
   */
  async removeAdapter(adapterId: string): Promise<void> {
    await this.#synchronizer.removeAdapter(adapterId)
  }

  /**
   * Check if an adapter exists by ID.
   */
  hasAdapter(adapterId: string): boolean {
    return this.#synchronizer.hasAdapter(adapterId)
  }

  /**
   * Get an adapter by ID.
   */
  getAdapter(adapterId: string): AnyAdapter | undefined {
    return this.#synchronizer.getAdapter(adapterId)
  }

  // =========================================================================
  // PUBLIC API — Lifecycle
  // =========================================================================

  /**
   * Await all pending storage operations. The loop handles operations
   * that spawn new operations (e.g. a hydration that triggers a save).
   */
  async #flushStorage(): Promise<void> {
    while (this.#pendingStorageOps.size > 0) {
      await Promise.all(this.#pendingStorageOps)
    }
  }

  /**
   * Await all pending storage operations without disconnecting adapters.
   *
   * Use this when you want to ensure all data has been persisted but
   * plan to continue using the Exchange afterwards.
   */
  async flush(): Promise<void> {
    await this.#flushStorage()
    await this.#synchronizer.flush()
  }

  /**
   * Disconnects all network adapters and cleans up resources.
   *
   * ⚠️ WARNING: This is synchronous and does NOT wait for pending storage
   * saves to complete. If you need to ensure data persistence, use
   * {@link shutdown} instead.
   */
  reset(): void {
    this.#docCache.clear()
    this.#synchronizer.reset()
  }

  /**
   * Gracefully shut down: flush all pending storage operations, then
   * disconnect all adapters and clean up resources.
   *
   * This is the recommended way to stop an Exchange when using persistent
   * storage backends.
   */
  async shutdown(): Promise<void> {
    await this.#flushStorage()
    this.#docCache.clear()
    await this.#synchronizer.shutdown()
  }

  // =========================================================================
  // Internal access (for testing)
  // =========================================================================

  /** @internal */
  get synchronizer(): Synchronizer {
    return this.#synchronizer
  }
}