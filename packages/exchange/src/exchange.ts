// exchange — the public API for @kyneta/exchange.
//
// The Exchange class is the central orchestrator for substrate-agnostic
// state synchronization. It manages document lifecycle, coordinates
// transports and stores, and provides the main API for
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
//     transports: [createWebsocketClient({ url: "ws://localhost:3000/ws" })],
//     stores: [createInMemoryStore()],
//   })
//
//   const TodoDoc = loro.bind(Schema.struct({ title: Schema.text() }))  // loro from @kyneta/loro-schema
//   const doc = exchange.get("my-doc", TodoDoc)
//   sync(doc).waitForSync()

import type { ReactiveMap } from "@kyneta/changefeed"
import {
  type BoundReplica,
  type BoundSchema,
  createRef,
  type Defer,
  type DocMetadata,
  type FactoryBuilder,
  type Interpret,
  type MergeStrategy,
  type Ref,
  type Reject,
  type Replica,
  type ReplicaFactory,
  type ReplicaType,
  type Replicate,
  type Schema as SchemaNode,
  subscribe,
  type Version,
} from "@kyneta/schema"
import type {
  AnyTransport,
  DocId,
  PeerId,
  PeerIdentityDetails,
  TransportFactory,
} from "@kyneta/transport"
import type { Capabilities } from "./capabilities.js"
import { createCapabilities, DEFAULT_REPLICAS } from "./capabilities.js"
import type { Policy } from "./governance.js"
import { Governance } from "./governance.js"
import type { Store } from "./store/store.js"
import { registerSync } from "./sync.js"
import { type DocRuntime, Synchronizer } from "./synchronizer.js"
import type { DocChange, DocInfo, PeerChange } from "./types.js"
import { randomPeerId, validatePeerId } from "./utils.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The four possible dispositions when classifying a discovered document.
 */
export type Disposition = Interpret | Replicate | Defer | Reject

/**
 * Options for creating an Exchange.
 */
export type ExchangeParams = {
  /**
   * Peer identity. If `peerId` is omitted, one is auto-generated.
   *
   * The `peerId` must satisfy two invariants:
   *
   * - **Stability:** The same participant must use the same peerId across
   *   restarts. Without stability, each boot fragments the CRDT version
   *   vector with phantom peer entries and breaks causal continuity.
   *
   * - **Uniqueness:** Different participants must use different peerIds.
   *   Two peers sharing a peerId will silently corrupt CRDT state —
   *   the version vector conflates their operations and `exportSince`
   *   produces wrong deltas. The synchronizer warns at channel
   *   establishment when a duplicate peerId is detected.
   *
   * For browser clients, use `persistentPeerId(storageKey)` from
   * `@kyneta/exchange` — it generates a random peerId on first visit
   * and caches it in `localStorage` for stability across reloads.
   *
   * For servers, use an explicit string (e.g. `"my-server"`).
   */
  identity?: Partial<PeerIdentityDetails>

  /**
   * Adapter factories for network connectivity.
   *
   * Each factory is called once during Exchange construction to create
   * a fresh adapter instance. Use `create*` helpers for low-friction setup:
   *
   * ```typescript
   * transports: [createWebsocketClient({ url: "ws://localhost:3000/ws" })]
   * ```
   */
  transports?: TransportFactory[]

  /**
   * Stores for persistent document storage.
   *
   * Storage is a direct Exchange dependency — not an adapter, not a
   * channel, not a participant in the sync protocol. The Exchange
   * handles hydration (loading from storage on `get()`/`replicate()`)
   * and persistence (saving on network imports and local changes)
   * directly.
   *
   * ```typescript
   * stores: [createInMemoryStore()]
   * ```
   */
  stores?: Store[]

  /**
   * Declares document types this Exchange can interpret.
   *
   * Sugar for calling `registerSchema()` at construction time. Each
   * `BoundSchema` is indexed by its `schemaHash` under the appropriate
   * `ReplicaKey`, enabling automatic resolution in `onEnsureDoc`.
   */
  schemas?: BoundSchema[]

  /**
   * Declares replication modes for headless participation.
   *
   * Each `BoundReplica` pairs a `ReplicaFactory` with a `MergeStrategy`,
   * defining a replication tier the Exchange can service. The defaults
   * cover plain/authoritative and lww/lww — extend this set for CRDT-backed
   * relay or storage participants.
   *
   * @default DEFAULT_REPLICAS
   */
  replicas?: readonly BoundReplica[]

  /**
   * How long (in ms) a disconnected peer is preserved before being
   * declared departed. During this window the peer remains in
   * `exchange.peers()` and emits `peer-disconnected` / `peer-reconnected`
   * events instead of `peer-departed`.
   *
   * - `0` — immediate departure on last channel loss (no grace period).
   * - `Infinity` — disconnected peers are never auto-departed.
   *
   * @default 30_000
   */
  departureTimeout?: number
} & Policy

// ---------------------------------------------------------------------------
// Doc cache entry
// ---------------------------------------------------------------------------

type DocCacheEntry =
  | { mode: "interpret"; ref: any; bound: BoundSchema; suspended?: boolean }
  | { mode: "replicate"; suspended?: boolean }
  | { mode: "deferred" }

// ---------------------------------------------------------------------------
// Exchange
// ---------------------------------------------------------------------------

/**
 * The Exchange class is the central orchestrator for substrate-agnostic
 * state synchronization.
 *
 * It manages the lifecycle of documents, coordinates subsystems (transports,
 * synchronizer, stores), and provides the main public API for
 * document operations.
 *
 * A single Exchange can host documents backed by different substrate types
 * simultaneously (heterogeneous documents). Each document's substrate type
 * and sync strategy are determined by its `BoundSchema`.
 *
 * @example
 * ```typescript
 * import { Exchange, sync, json } from "@kyneta/exchange"
 * import { loro } from "@kyneta/loro-schema"
 *
 * const exchange = new Exchange({
 *   identity: { name: "alice" },
 *   transports: [createBridgeTransport({ transportType: "peer-a", bridge })],
 *   stores: [createInMemoryStore()],
 * })
 *
 * const TodoDoc = loro.bind(Schema.struct({ title: Schema.text() }))
 * const ConfigDoc = json.bind(Schema.struct({ theme: Schema.string() }))
 *
 * const doc = exchange.get("my-doc", TodoDoc)
 * const config = exchange.get("config", ConfigDoc)
 * doc.title()  // read
 * change(doc, d => d.title.insert(0, "Hello"))  // write
 * await sync(doc).waitForSync()  // sync
 * ```
 */
function rethrowErrors(errors: unknown[]): void {
  if (errors.length === 1) throw errors[0]
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      `${errors.length} policy dispose callbacks threw`,
    )
  }
}

export class Exchange {
  readonly peerId: string
  readonly #peerIdIsExplicit: boolean

  readonly #governance: Governance
  readonly #capabilities: Capabilities
  readonly #synchronizer: Synchronizer
  readonly peers: ReactiveMap<PeerId, PeerIdentityDetails, PeerChange>
  readonly documents: ReactiveMap<DocId, DocInfo, DocChange>
  readonly #docCache = new Map<DocId, DocCacheEntry>()
  readonly #stores: Store[]

  /**
   * Per-doc store version — the version at which the store was last
   * persisted. Used by `onStateAdvanced` to compute incremental deltas
   * via `exportSince(storeVersion)`.
   *
   * Context: jj:smmulzkm (unified persistence via notify/state-advanced)
   */
  readonly #storeVersions = new Map<DocId, Version>()

  /**
   * Pending async store operations tracked for flush()/shutdown().
   * Each promise is added when a store write begins and removed
   * when it settles.
   */
  readonly #pendingStorageOps: Set<Promise<void>> = new Set()

  /**
   * Per-doc operation chains ensuring sequential backend access.
   * Each docId maps to the tail of a promise chain — new operations
   * for that docId await the previous one before proceeding.
   */
  readonly #docQueues: Map<DocId, Promise<void>> = new Map()

  constructor({
    identity = {},
    transports = [],
    stores = [],
    schemas = [],
    replicas = DEFAULT_REPLICAS,
    departureTimeout,
    ...policyFields
  }: ExchangeParams = {}) {
    // Resolve peer identity
    const peerId = identity.peerId ?? randomPeerId()
    validatePeerId(peerId)
    this.peerId = peerId
    this.#peerIdIsExplicit = identity.peerId !== undefined

    this.#stores = stores

    const fullIdentity: PeerIdentityDetails = {
      peerId,
      name: identity.name,
      type: identity.type ?? "user",
    }
    // ── Governance — must be initialized before the Synchronizer,
    // because the Synchronizer may call onEnsureDoc during
    // _start() if a transport immediately discovers peers.
    this.#governance = new Governance()

    // Register the initial policy from ExchangeParams. Because
    // ExchangeParams intersects Policy, the spread contains all
    // Policy fields the caller provided. Register if any gate is set.
    const { canShare, canAccept, canReset, canConnect, resolve } = policyFields
    if (canShare || canAccept || canReset || canConnect || resolve) {
      this.#governance.register(policyFields)
    }

    // Build the capabilities registry from declared schemas and replicas.
    this.#capabilities = createCapabilities({
      schemas,
      replicas: [...replicas],
      resolveFactory: (builder: FactoryBuilder<any>) =>
        builder({ peerId: this.peerId }),
    })

    // Create synchronizer — call each factory to produce fresh adapter instances.
    // The canShare and canAccept predicates delegate to the live Governance,
    // so dynamically registered policies are visible without recreating the
    // synchronizer's update function.
    this.#synchronizer = new Synchronizer({
      identity: fullIdentity,
      transports: transports.map(factory => factory()),
      canShare: this.#governance.canShare.bind(this.#governance),
      canAccept: this.#governance.canAccept.bind(this.#governance),
      canConnect: this.#governance.canConnect.bind(this.#governance),
      canReset: this.#governance.canReset.bind(this.#governance),
      departureTimeout,

      onEnsureDoc: (
        docId,
        peer,
        replicaType,
        mergeStrategy,
        schemaHash,
      ): void => {
        // 1. Schema auto-resolve
        const resolvedBound = this.#capabilities.resolveSchema(
          schemaHash,
          replicaType,
          mergeStrategy,
        )
        if (resolvedBound) {
          this.#interpretDoc(docId, resolvedBound)
          return
        }

        // 2. Resolve callback
        const result = this.#governance.resolve(
          docId,
          peer,
          replicaType,
          mergeStrategy,
          schemaHash,
        )

        if (!result) {
          // Two-tiered default: no callback matched this doc.
          if (this.#capabilities.supportsReplicaType(replicaType)) {
            // Supported replica type but no schema match — defer.
            // Promotion is plausible: a later exchange.get() or registerSchema()
            // will expand the schema set and auto-promote.
            this.#deferDoc(docId, replicaType, mergeStrategy, schemaHash)
          }
          // Unsupported replica type — reject silently.
          // No callback, no schema, no replica capability. Nothing to do.
          return
        }

        switch (result.kind) {
          case "interpret":
            this.#interpretDoc(docId, result.bound)
            break
          case "replicate": {
            const boundReplica = this.#capabilities.resolveReplica(
              replicaType,
              mergeStrategy,
            )
            if (!boundReplica) {
              console.warn(
                `[exchange] resolve returned Replicate() for doc "${docId}" but no BoundReplica ` +
                  `is registered for replicaType [${replicaType}] with strategy "${mergeStrategy}". ` +
                  `Add the appropriate BoundReplica to ExchangeParams.replicas.`,
              )
              return
            }
            this.#replicateDoc(
              docId,
              boundReplica.factory,
              mergeStrategy,
              schemaHash,
            )
            break
          }
          case "defer":
            this.#deferDoc(docId, replicaType, mergeStrategy, schemaHash)
            break
          case "reject":
            // Explicitly rejected — do nothing
            break
        }
      },
    })
    this.peers = this.#synchronizer.createPeerFeed()
    this.documents = this.#synchronizer.createDocFeed()

    // ── Unified persistence via onStateAdvanced ──
    // Subscribe to state-advanced events from the synchronizer. This fires
    // at quiescence when any document's state has advanced — either from a
    // local mutation (changefeed → notifyLocalChange → handleLocalDocChange)
    // or a network import (handleOffer → cmd/import-doc-data → handleDocImported).
    //
    // The listener computes an incremental delta via exportSince(storeVersion)
    // and appends it to all stores. This replaces both:
    // - The old onDocImported callback (which stored orphaned raw deltas)
    // - The old changefeed-based replace() (which stored full snapshots per keystroke)
    //
    // Context: jj:smmulzkm (unified persistence via notify/state-advanced)
    if (this.#stores.length > 0) {
      this.#synchronizer.onStateAdvanced((docId: DocId) => {
        const storeVersion = this.#storeVersions.get(docId)
        if (!storeVersion) return // Doc not yet initialized — still hydrating

        const runtime = this.#synchronizer.getDocRuntime(docId)
        if (!runtime) return

        const delta = runtime.replica.exportSince(storeVersion)
        if (!delta) return // Version didn't actually advance — deduplication

        const newVersion = runtime.replica.version()
        this.#storeVersions.set(docId, newVersion)

        const versionStr = newVersion.serialize()
        this.#persistToStore(docId, backend =>
          backend.append(docId, { payload: delta, version: versionStr }),
        )
      })
    }
  }

  /**
   * Internal document creation — creates an interpreted doc without
   * registering the schema in the auto-resolve set.
   *
   * This is the single creation path for interpreted docs. Both the
   * public `get()` and internal `onEnsureDoc` paths delegate here.
   */
  #interpretDoc(docId: DocId, bound: BoundSchema): any {
    // Ensure semantics: if this doc already exists in interpret mode,
    // return the existing ref. First writer wins.
    // Context: jj:mumrnvlk (stale-batch race in cmd/ensure-doc)
    const cached = this.#docCache.get(docId)
    if (cached && cached.mode === "interpret") {
      return cached.ref
    }

    const factory = bound.factory({ peerId: this.peerId })
    const replicaType = factory.replica.replicaType
    if (!this.#capabilities.supportsReplicaType(replicaType)) {
      throw new Error(
        `[exchange] Internal error: registerSchema did not register replicaType [${replicaType}]`,
      )
    }

    // ── Shared prefix: create substrate, build ref, wire metadata ──
    const substrate = factory.create(bound.schema)

    const ref: any = createRef(bound.schema, substrate)

    registerSync(ref, {
      peerId: this.peerId,
      docId,
      synchronizer: this.#synchronizer,
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
        bound.strategy,
        bound.schemaHash,
        "interpret",
      ).then(() => {
        subscribe(ref, changeset => {
          if (changeset.origin === "sync") return
          this.#synchronizer.notifyLocalChange(docId)
        })
      })
      this.#trackOp(hydrationOp)
    } else {
      this.#synchronizer.registerDoc({
        mode: "interpret",
        docId,
        replica: substrate,
        replicaFactory: factory.replica,
        strategy: bound.strategy,
        schemaHash: bound.schemaHash,
      })

      subscribe(ref, changeset => {
        if (changeset.origin === "sync") return
        this.#synchronizer.notifyLocalChange(docId)
      })
    }

    return ref
  }

  /**
   * Internal document replication — creates a headless replicated doc.
   *
   * This is the single creation path for replicated docs. Both the
   * public `replicate()` and internal `onEnsureDoc` paths delegate here.
   */
  #replicateDoc(
    docId: DocId,
    replicaFactory: ReplicaFactory<any>,
    strategy: MergeStrategy,
    schemaHash: string,
  ): void {
    // Ensure semantics: if this doc already exists in replicate mode,
    // it was created by a sibling command's cascade. First writer wins.
    const cached = this.#docCache.get(docId)
    if (cached && cached.mode === "replicate") return

    const replica = replicaFactory.createEmpty()

    this.#docCache.set(docId, { mode: "replicate" })

    if (this.#stores.length > 0) {
      const hydrationOp = this.#hydrateAndRegister(
        docId,
        replica,
        replicaFactory,
        strategy,
        schemaHash,
        "replicate",
      )
      this.#trackOp(hydrationOp)
    } else {
      this.#synchronizer.registerDoc({
        mode: "replicate",
        docId,
        replica,
        replicaFactory,
        strategy,
        schemaHash,
      })
    }
  }

  /**
   * Defer a document — register it in the synchronizer as deferred
   * (participates in routing/present but not data exchange) and cache
   * the deferred state locally.
   */
  #deferDoc(
    docId: DocId,
    replicaType: ReplicaType,
    mergeStrategy: MergeStrategy,
    schemaHash: string,
  ): void {
    this.#synchronizer.deferDoc(docId, replicaType, mergeStrategy, schemaHash)
    this.#docCache.set(docId, { mode: "deferred" })
  }

  // =========================================================================
  // PRIVATE — Storage helpers
  // =========================================================================

  /**
   * Track an async store operation so flush() can await it.
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
   * Run a store operation against all backends for a document,
   * with per-doc sequencing and flush tracking.
   */
  #persistToStore(
    docId: DocId,
    operation: (backend: Store) => Promise<void>,
  ): void {
    if (this.#stores.length === 0) return

    const op = this.#enqueueForDoc(docId, async () => {
      for (const backend of this.#stores) {
        try {
          await operation(backend)
        } catch (error) {
          console.error(
            `[exchange] store operation failed for doc '${docId}':`,
            error,
          )
        }
      }
    })
    this.#trackOp(op)
  }

  /**
   * Hydrate a replica/substrate from stores, then register with the
   * synchronizer.
   *
   * This is the async tail of get() and replicate() when stores are
   * configured. The caller has already created the replica/substrate
   * and cached the ref (if interpret mode). This function:
   * 1. Ensures doc metadata in all backends
   * 2. Loads stored entries and merges into the replica
   * 3. If store was empty (first boot), persists an entirety base entry
   * 4. Records storeVersion for incremental persistence
   * 5. Registers with the synchronizer
   *
   * For interpret mode with structural clientID 0, `factory.create(schema)`
   * produces structural ops at `(0, 0..N)` — identical to what any stored
   * state has. Merging stored data into this substrate deduplicates the
   * structural ops and applies application ops into the shared containers.
   * No separate replica, no upgrade step, no merge-into-temp.
   *
   * Context: jj:ptyzqoul (structural merge protocol)
   */
  async #hydrateAndRegister(
    docId: DocId,
    replica: Replica<any>,
    replicaFactory: ReplicaFactory<any>,
    strategy: MergeStrategy,
    schemaHash: string,
    mode: "interpret" | "replicate",
  ): Promise<void> {
    const metadata: DocMetadata = {
      replicaType: replicaFactory.replicaType,
      mergeStrategy: strategy,
      schemaHash,
    }

    // 1. Ensure doc metadata is registered in all backends
    for (const backend of this.#stores) {
      try {
        await backend.ensureDoc(docId, metadata)
      } catch (error) {
        console.error(`[exchange] ensureDoc failed for doc '${docId}':`, error)
      }
    }

    // 2. Hydrate from storage — load all entries and merge into the replica
    let hadStoredEntries = false
    for (const backend of this.#stores) {
      try {
        const existing = await backend.lookup(docId)
        if (existing) {
          for await (const entry of backend.loadAll(docId)) {
            try {
              replica.merge(entry.payload, "sync")
              hadStoredEntries = true
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
          `[exchange] store hydration failed for doc '${docId}':`,
          error,
        )
      }
    }

    // 3. If store was empty (first boot), persist an entirety base entry
    //    so future deltas have a base to build on.
    if (!hadStoredEntries) {
      const payload = replica.exportEntirety()
      const version = replica.version().serialize()
      this.#persistToStore(docId, backend =>
        backend.append(docId, { payload, version }),
      )
    }

    // 4. Record storeVersion for incremental persistence via onStateAdvanced
    this.#storeVersions.set(docId, replica.version())

    // 5. Register with synchronizer — present/interest messages carry
    //    the hydrated version, not an empty one
    this.#synchronizer.registerDoc({
      mode,
      docId,
      replica,
      replicaFactory,
      strategy,
      schemaHash,
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
   * The ref is returned synchronously. If stores are configured,
   * hydration happens asynchronously — the ref starts empty and the
   * changefeed fires when stored data is merged. The synchronizer only
   * learns about the doc after hydration completes, so present/interest
   * messages carry the hydrated version.
   *
   * @param docId - The document ID
   * @param bound - A BoundSchema created by `bind()`, `json.bind()`, or `loro.bind()`
   * @returns A full-stack Ref<S> with sync capabilities via `sync()`
   *
   * @example
   * ```typescript
   * import { json } from "@kyneta/schema"
   * import { loro } from "@kyneta/loro-schema"
   *
   * const TodoDoc = loro.bind(Schema.struct({ title: Schema.text() }))
   * const doc = exchange.get("my-doc", TodoDoc)
   *
   * // Initial content via change() after construction:
   * change(doc, d => { d.title.insert(0, "Hello") })
   * ```
   */
  get<S extends SchemaNode>(docId: DocId, bound: BoundSchema<S>): Ref<S> {
    // Require explicit peerId for interpret mode — the peerId identifies
    // this exchange as a participant in causal history and must be stable
    // across restarts for correct CRDT operation.
    // Context: jj:smmulzkm (two-phase substrate construction)
    if (!this.#peerIdIsExplicit) {
      throw new Error(
        `exchange.get() requires an explicit peerId. ` +
          `Provide identity: { peerId: "..." } in ExchangeParams. ` +
          `The peerId identifies this exchange as a participant in causal history — ` +
          `it must be stable across restarts for correct CRDT operation.`,
      )
    }

    // Check cache first
    const cached = this.#docCache.get(docId)

    if (cached) {
      if (cached.mode !== "deferred" && cached.suspended) {
        throw new Error(
          `Document '${docId}' is suspended. Call exchange.resume('${docId}') to re-enter the sync graph.`,
        )
      }

      if (cached.mode === "replicate") {
        throw new Error(
          `Document '${docId}' is registered in replicate mode. ` +
            `Cannot call exchange.get() on a replicated document — it has no schema or ref.`,
        )
      }

      if (cached.mode === "deferred") {
        // Promote deferred → interpret: retrieve metadata for diagnostics
        const metadata = this.#synchronizer.getDocMetadata(docId)
        if (metadata && bound.schemaHash !== metadata.schemaHash) {
          console.warn(
            `[exchange] Promoting deferred doc "${docId}": local schemaHash "${bound.schemaHash}" ` +
              `differs from discovery schemaHash "${metadata.schemaHash}". ` +
              `Local schema is authoritative, but this indicates protocol disagreement.`,
          )
        }
        // Delete deferred entry and fall through to normal get() creation.
        // registerDoc() → doc-ensure handles the deferred→promoted transition
        // in the synchronizer model.
        this.#docCache.delete(docId)
      } else {
        // mode === "interpret" — validate BoundSchema match
        if (cached.bound !== bound) {
          throw new Error(
            `Document '${docId}' already exists with a different BoundSchema. ` +
              `Use the same BoundSchema object when calling exchange.get() for the same document.`,
          )
        }

        return cached.ref as Ref<S>
      }
    }

    // Auto-register this schema's capabilities. registerSchema is idempotent
    // (upserts into the registry), so repeated get() calls with the same
    // BoundSchema are safe.
    //
    // Reentrancy note: registerSchema scans deferred docs and may re-enter
    // get() for matching docs. This is safe because inner get() calls operate
    // on *different* docIds (the deferred docs being promoted), so there is
    // no infinite recursion or cache corruption.
    this.registerSchema(bound)

    return this.#interpretDoc(docId, bound) as Ref<S>
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
   * **Overloaded:**
   * - `replicate(docId)` — promote a deferred document, resolving the
   *   factory from the capabilities registry.
   * - `replicate(docId, replicaFactory, strategy, schemaHash)` — full
   *   registration with explicit arguments.
   *
   * @param docId - The document ID
   * @param replicaFactory - Factory for constructing headless replicas
   * @param strategy - The merge strategy for this document
   * @param schemaHash - The schema hash for this document
   *
   * @example
   * ```typescript
   * import { loro } from "@kyneta/loro-schema"
   *
   * // Schema-free relay — replicate all docs without compile-time schema knowledge
   * exchange.replicate("shared-doc", loro.replica().factory, "causal", "v1:abc123")
   *
   * // Promote a deferred doc — factory resolved from capabilities registry
   * exchange.replicate("deferred-doc")
   * ```
   */
  replicate(docId: DocId): void
  replicate(
    docId: DocId,
    replicaFactory: ReplicaFactory<any>,
    strategy: MergeStrategy,
    schemaHash: string,
  ): void
  replicate(
    docId: DocId,
    replicaFactory?: ReplicaFactory<any>,
    strategy?: MergeStrategy,
    schemaHash?: string,
  ): void {
    // Handle deferred promotion or throw on duplicate
    const cached = this.#docCache.get(docId)
    if (cached?.mode === "deferred") {
      // Promote deferred → replicate
      this.#docCache.delete(docId)
      const metadata = this.#synchronizer.getDocMetadata(docId)
      if (!metadata) {
        throw new Error(
          `Document '${docId}' is deferred but has no synchronizer metadata.`,
        )
      }
      const bound = this.#capabilities.resolveReplica(
        metadata.replicaType,
        metadata.mergeStrategy,
      )
      if (!bound) {
        throw new Error(
          `Document '${docId}' is deferred with replicaType [${metadata.replicaType}] and ` +
            `strategy "${metadata.mergeStrategy}" but no matching BoundReplica is registered.`,
        )
      }
      replicaFactory = bound.factory
      strategy = metadata.mergeStrategy
      schemaHash = metadata.schemaHash
    } else if (cached) {
      throw new Error(
        `Document '${docId}' is already registered. ` +
          `Cannot call exchange.replicate() on an existing document.`,
      )
    }

    if (!replicaFactory || !strategy || !schemaHash) {
      throw new Error(
        `exchange.replicate() requires (docId, replicaFactory, strategy, schemaHash) ` +
          `or a deferred document to promote.`,
      )
    }

    this.#replicateDoc(docId, replicaFactory, strategy, schemaHash)
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
   * Compute the least common version (LCV) for a document across all
   * synced peers. The LCV is the greatest version that is ≤ every
   * synced peer's last known version — the safe trim point for
   * `advance()`.
   *
   * Returns `null` if no peers are synced for this doc, or if the
   * doc doesn't exist.
   *
   * @param docId - The document to compute the LCV for
   */
  leastCommonVersion(docId: DocId): Version | null {
    return this.#synchronizer.leastCommonVersion(docId)
  }

  /**
   * Compact a document — advance the base to the LCV and replace
   * stored payloads with the trimmed entirety.
   *
   * This is a convenience that composes `leastCommonVersion()` →
   * `replica.advance()` → `exportEntirety()` → `store.replace()`.
   *
   * If no peers are synced, the full document is projected (all
   * history discarded). The undershoot contract ensures the base
   * never exceeds the LCV, so no peer is stranded.
   *
   * @param docId - The document to compact
   */
  async compact(docId: DocId): Promise<void> {
    const runtime = this.#synchronizer.getDocRuntime(docId)
    if (!runtime) return

    const lcv = this.leastCommonVersion(docId)
    // If no peers are synced, advance to current version (full projection).
    const target = lcv ?? runtime.replica.version()

    runtime.replica.advance(target)

    // Replace stored payloads with the trimmed entirety.
    const entirety = runtime.replica.exportEntirety()
    const metadata: DocMetadata = {
      replicaType: runtime.replicaFactory.replicaType,
      mergeStrategy: runtime.strategy,
      schemaHash: runtime.schemaHash,
    }
    for (const store of this.#stores) {
      await store.ensureDoc(docId, metadata)
      await store.replace(docId, {
        payload: entirety,
        version: runtime.replica.version().serialize(),
      })
    }
  }

  /**
   * The set of deferred document IDs.
   *
   * Deferred docs participate in routing but have no local representation.
   * They can be promoted via `exchange.get()` or `exchange.replicate()`.
   */
  get deferred(): ReadonlySet<DocId> {
    const result = new Set<DocId>()
    for (const [docId, entry] of this.#docCache) {
      if (entry.mode === "deferred") result.add(docId)
    }
    return result
  }

  /**
   * All document IDs currently in interpret mode.
   *
   * Returns a snapshot — the set is not live. Call again to get
   * the current state.
   */
  documentIds(): ReadonlySet<DocId> {
    const result = new Set<DocId>()
    for (const [docId, entry] of this.#docCache) {
      if (entry.mode === "interpret") result.add(docId)
    }
    return result
  }

  /**
   * Schema hash for a document, if it exists.
   *
   * For interpreted docs, reads from the cached BoundSchema.
   * For replicate/deferred docs, reads from the synchronizer model.
   * Returns `undefined` if the document is not known.
   */
  getDocSchemaHash(docId: DocId): string | undefined {
    const cached = this.#docCache.get(docId)
    if (!cached) return undefined
    if (cached.mode === "interpret") return cached.bound.schemaHash
    // For replicate/deferred, the schema hash lives in the synchronizer model.
    const metadata = this.#synchronizer.getDocMetadata(docId)
    return metadata?.schemaHash
  }

  /**
   * Destroy a document — remove it locally, broadcast `dismiss` to
   * all peers, and delete from stores.
   *
   * This is the single public API for document removal. For bulk
   * teardown without per-doc notification, use `reset()` or `shutdown()`.
   *
   * @param docId - The ID of the document to destroy
   */
  destroy(docId: DocId): void {
    this.#docCache.delete(docId)
    this.#synchronizer.dismissDocument(docId)

    // Delete from all stores
    this.#persistToStore(docId, backend => backend.delete(docId))
  }

  /**
   * Suspend a document — leave the sync graph but keep all local state.
   *
   * The document remains in `#docCache` and stores, and `exchange.has()`
   * still returns `true`. The sync model removes the document and
   * broadcasts a wire `dismiss` message to peers. Call `resume()` to
   * re-enter the sync graph.
   *
   * Cannot suspend deferred docs (they have no sync participation).
   *
   * @param docId - The ID of the document to suspend
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
    this.#synchronizer.suspendDocument(docId)
  }

  /**
   * Resume a suspended document — re-enter the sync graph.
   *
   * The surviving replica's current version is used to re-announce to
   * peers. Peers receive `present` + `interest` messages and delta-sync
   * from the suspended version.
   *
   * @param docId - The ID of the document to resume
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
    this.#synchronizer.resumeDocument(docId)
  }

  /**
   * Register a BoundSchema at runtime.
   *
   * Indexes the schema by its `schemaHash` under the appropriate
   * `ReplicaKey` in the capabilities registry. Future
   * `onEnsureDoc` calls with a matching `schemaHash` will
   * auto-resolve to this schema.
   *
   * @param bound - A BoundSchema to register
   */
  registerSchema(bound: BoundSchema): void {
    this.#capabilities.registerSchema(bound, builder =>
      builder({ peerId: this.peerId }),
    )

    // Auto-promote deferred docs that match the newly registered schema
    const factory = bound.factory({ peerId: this.peerId })
    const replicaType = factory.replica.replicaType
    for (const [docId, entry] of this.#docCache) {
      if (entry.mode !== "deferred") continue
      const metadata = this.#synchronizer.getDocMetadata(docId)
      if (!metadata) continue
      // Check if the new schema matches the deferred doc's triple
      if (
        bound.schemaHash === metadata.schemaHash &&
        replicaType[0] === metadata.replicaType[0] &&
        replicaType[1] === metadata.replicaType[1] &&
        bound.strategy === metadata.mergeStrategy
      ) {
        // Safe to mutate Map during iteration per ES spec.
        // Delete the deferred entry, then #interpretDoc inserts the new one.
        this.#docCache.delete(docId)
        this.#interpretDoc(docId, bound)
      }
    }
  }

  // =========================================================================
  // PUBLIC API — Adapter management
  // =========================================================================

  /**
   * Add an adapter at runtime.
   * Idempotent: adding an adapter with the same transportId is a no-op.
   */
  async addTransport(adapter: AnyTransport): Promise<void> {
    await this.#synchronizer.addTransport(adapter)
  }

  /**
   * Remove an adapter at runtime.
   * Idempotent: removing a non-existent adapter is a no-op.
   */
  async removeTransport(transportId: string): Promise<void> {
    await this.#synchronizer.removeTransport(transportId)
  }

  /**
   * Check if an adapter exists by ID.
   */
  hasTransport(transportId: string): boolean {
    return this.#synchronizer.hasTransport(transportId)
  }

  /**
   * Get an adapter by ID.
   */
  getTransport(transportId: string): AnyTransport | undefined {
    return this.#synchronizer.getTransport(transportId)
  }

  // =========================================================================
  // PUBLIC API — Lifecycle
  // =========================================================================

  /**
   * Await all pending store operations. The loop handles operations
   * that spawn new operations (e.g. a hydration that triggers a save).
   */
  async #flushStores(): Promise<void> {
    while (this.#pendingStorageOps.size > 0) {
      await Promise.all(this.#pendingStorageOps)
    }
  }

  /**
   * Await all pending store operations without disconnecting transports.
   *
   * Use this when you want to ensure all data has been persisted but
   * plan to continue using the Exchange afterwards.
   */
  async flush(): Promise<void> {
    await this.#flushStores()
    await this.#synchronizer.flush()
  }

  /**
   * Disconnects all network transports and cleans up resources.
   *
   * ⚠️ WARNING: This is synchronous and does NOT wait for pending storage
   * saves to complete. If you need to ensure data persistence, use
   * {@link shutdown} instead.
   */
  reset(): void {
    const disposeErrors = this.#governance.clear()
    this.#docCache.clear()
    this.#synchronizer.reset()
    rethrowErrors(disposeErrors)
  }

  /**
   * Gracefully shut down: flush all pending store operations, then
   * disconnect all transports and clean up resources.
   *
   * This is the recommended way to stop an Exchange when using persistent
   * stores.
   */
  async shutdown(): Promise<void> {
    await this.#flushStores()
    const disposeErrors = this.#governance.clear()
    this.#docCache.clear()
    await this.#synchronizer.shutdown()
    // Close stores that hold native handles
    for (const backend of this.#stores) {
      if (backend.close) await backend.close()
    }
    rethrowErrors(disposeErrors)
  }

  // =========================================================================
  // Internal access (for testing)
  // =========================================================================

  /**
   * Register a doc policy. Returns a dispose function that removes the
   * policy from all compositions.
   *
   * A Policy bundles predicates and handlers governing a region of
   * the document space. Multiple policies compose via three-valued logic:
   * - `false` from any policy → deny (short-circuit)
   * - `true` from at least one policy, no `false` → allow
   * - all `undefined` → default (open for both canShare and canAccept)
   *
   * Policies may include a `resolve` handler for policy-gating documents
   * not auto-resolved by the capabilities registry. Multiple resolve
   * handlers are evaluated in registration order — first non-`undefined`
   * disposition wins.
   */
  register(policy: Policy): () => void {
    return this.#governance.register(policy)
  }

  /** @internal */
  get synchronizer(): Synchronizer {
    return this.#synchronizer
  }
}
