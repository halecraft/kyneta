// exchange — the public API for @kyneta/exchange.
//
// The Exchange class is the central orchestrator for substrate-agnostic
// state synchronization. It manages document lifecycle, coordinates
// transports and stores, and provides the main API for
// document operations.
//
// Storage is coordinated via a pure Mealy machine (store-program) that
// models per-document write phases (idle ↔ writing). The Exchange
// instantiates the machine via createObservableProgram and interprets
// its data effects as actual I/O against the configured Store backends.
//
// Usage:
//   const exchange = new Exchange({
//     id: "alice",
//     transports: [createWebsocketClient({ url: "ws://localhost:3000/ws" })],
//     stores: [createInMemoryStore()],
//   })
//
//   const TodoDoc = loro.bind(Schema.struct({ title: Schema.text() }))  // loro from @kyneta/loro-schema
//   const doc = exchange.get("my-doc", TodoDoc)
//   sync(doc).waitForSync()

import type { ReactiveMap } from "@kyneta/changefeed"
import type { Lease, ObservableHandle } from "@kyneta/machine"
import { createLease, createObservableProgram } from "@kyneta/machine"
import {
  type BoundReplica,
  type BoundSchema,
  createRef,
  type Defer,
  type FactoryBuilder,
  type Interpret,
  type Ref,
  type Reject,
  type ReplicaFactoryLike,
  type ReplicaLike,
  type ReplicaType,
  type Replicate,
  type Schema as SchemaNode,
  type SyncProtocol,
  subscribe,
  type Version,
} from "@kyneta/schema"
import type {
  AnyTransport,
  DocId,
  PeerId,
  PeerIdentityDetails,
  TransportFactory,
  WireFeatures,
} from "@kyneta/transport"
import type { Capabilities } from "./capabilities.js"
import { createCapabilities, DEFAULT_REPLICAS } from "./capabilities.js"
import type { Policy } from "./governance.js"
import { Governance } from "./governance.js"
import type { Store, StoreMeta } from "./store/store.js"
import {
  allDocsIdle,
  type StoreEffect,
  type StoreInput,
  type StoreModel,
  storeProgram,
} from "./store/store-program.js"
import { registerSync } from "./sync.js"
import { type DocRuntime, Synchronizer } from "./synchronizer.js"
import type { DocChange, DocInfo, PeerChange } from "./types.js"
import { validatePeerId } from "./utils.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The four possible dispositions when classifying a discovered document.
 */
export type Disposition = Interpret | Replicate | Defer | Reject

/**
 * Peer identity input — the *input* shape for Exchange construction.
 *
 * Like `PeerIdentityDetails` from `@kyneta/transport`, but with `type`
 * optional (defaults to `"user"` in the Exchange constructor).
 */
export type PeerIdentityInput = {
  peerId: string
  name?: string
  type?: "user" | "bot" | "service"
}

/**
 * Options for creating an Exchange.
 */
export type ExchangeParams = {
  /**
   * Peer identity — either a plain peerId string or a full identity object.
   *
   * ```ts
   * // Simple — just a peerId string (90% case)
   * new Exchange({ id: "alice" })
   *
   * // Full — with display name and/or type
   * new Exchange({ id: { peerId: "alice", name: "Alice", type: "service" } })
   * ```
   *
   * The peerId must satisfy two invariants:
   *
   * - **Stability:** The same participant must use the same peerId across
   *   restarts. Without stability, each boot fragments the CRDT version
   *   vector with phantom peer entries and breaks causal continuity.
   *
   * - **Uniqueness:** Different participants must use different peerIds.
   *   Two peers sharing a peerId will silently corrupt CRDT state —
   *   the version vector conflates their operations and `exportSince`
   *   produces wrong deltas.
   *
   * For browser clients, use `persistentPeerId(storageKey)` from
   * `@kyneta/exchange` — it provides a per-tab unique peerId via a
   * localStorage CAS lease protocol, stable across reloads.
   *
   * For servers, use an explicit string (e.g. `"my-server"`).
   */
  id: string | PeerIdentityInput

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
   * Called when a store operation fails. Receives the docId, operation
   * name, and error. Default: `console.warn`.
   */
  onStoreError?: (docId: DocId, operation: string, error: unknown) => void

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
   * Each `BoundReplica` pairs a `ReplicaFactory` with a `SyncProtocol`,
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

  /**
   * Optional pre-existing dispatch budget. If omitted, the Exchange
   * creates a private lease. Pass an explicit lease only when
   * coordinating multiple Exchanges in the same synchronous call
   * stack (e.g., test harnesses).
   */
  lease?: Lease
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
 *   id: "alice",
 *   transports: [transportFactory], // e.g. createWebsocketClient(...)
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

  readonly #governance: Governance
  readonly #capabilities: Capabilities
  readonly #synchronizer: Synchronizer
  /** Cooperating cascade budget. Shared with the Synchronizer (created in
   *  jj:qlvnvxox) and with every per-doc changefeed dispatcher (jj:yksllknw)
   *  so cross-doc A→B→A cascades and tick-induced re-entry are bounded by
   *  one budget. Defaults to a fresh `createLease()` if none was provided. */
  readonly #lease: Lease
  readonly peers: ReactiveMap<PeerId, PeerIdentityDetails, PeerChange>
  readonly documents: ReactiveMap<DocId, DocInfo, DocChange>
  readonly #docCache = new Map<DocId, DocCacheEntry>()
  readonly #stores: Store[]

  /** Store-program handle — pure machine for store coordination. */
  readonly #storeHandle: ObservableHandle<StoreInput, StoreModel> | null

  /** In-flight hydration I/O tracked so flush()/shutdown() can await it. */
  readonly #pendingHydrations = new Set<Promise<void>>()

  constructor({
    id,
    transports = [],
    stores = [],
    schemas = [],
    replicas = DEFAULT_REPLICAS,
    departureTimeout,
    onStoreError,
    lease,
    ...policyFields
  }: ExchangeParams) {
    // Resolve peer identity from id: string | PeerIdentityInput
    const peerId = typeof id === "string" ? id : id.peerId
    validatePeerId(peerId)
    this.peerId = peerId

    this.#stores = stores

    // Resolve the shared cascade budget once. Same instance is passed
    // to the Synchronizer below and to every per-doc createRef call so
    // doc-layer dispatchers cooperate with the synchronizer.
    this.#lease = lease ?? createLease()

    const fullIdentity: PeerIdentityDetails =
      typeof id === "string"
        ? { peerId, type: "user" }
        : { type: "user", ...id }
    // ── Governance — must be initialized before the Synchronizer,
    // because the Synchronizer may call onEnsureDoc during
    // _start() if a transport immediately discovers peers.
    this.#governance = new Governance()

    // Register the initial policy from ExchangeParams.
    this.#governance.register(policyFields)

    // Build the capabilities registry from declared schemas and replicas.
    this.#capabilities = createCapabilities({
      schemas,
      replicas: [...replicas],
      resolveFactory: (builder: FactoryBuilder<any>, bound: BoundSchema) =>
        builder({ peerId: this.peerId, binding: bound.identityBinding }),
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
      lease: this.#lease,

      onEnsureDoc: (
        docId,
        peer,
        replicaType,
        syncProtocol,
        schemaHash,
        _supportedHashes,
      ): void => {
        // 1. Schema auto-resolve
        const resolvedBound = this.#capabilities.resolveSchema(
          schemaHash,
          replicaType,
          syncProtocol,
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
          syncProtocol,
          schemaHash,
        )

        if (!result) {
          // Two-tiered default: no callback matched this doc.
          if (this.#capabilities.supportsReplicaType(replicaType)) {
            // Supported replica type but no schema match — defer.
            // Promotion is plausible: a later exchange.get() or registerSchema()
            // will expand the schema set and auto-promote.
            this.#deferDoc(docId, replicaType, syncProtocol, schemaHash)
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
              syncProtocol,
            )
            if (!boundReplica) {
              console.warn(
                `[exchange] resolve returned Replicate() for doc "${docId}" but no BoundReplica ` +
                  `is registered for replicaType [${replicaType}] with syncProtocol ${JSON.stringify(syncProtocol)}. ` +
                  `Add the appropriate BoundReplica to ExchangeParams.replicas.`,
              )
              return
            }
            this.#replicateDoc(
              docId,
              boundReplica.factory,
              syncProtocol,
              schemaHash,
            )
            break
          }
          case "defer":
            this.#deferDoc(docId, replicaType, syncProtocol, schemaHash)
            break
          case "reject":
            // Explicitly rejected — do nothing
            break
        }
      },
    })
    this.peers = this.#synchronizer.createPeerFeed()
    this.documents = this.#synchronizer.createDocFeed()

    // ── Store-program — pure machine for store coordination ──
    if (this.#stores.length > 0) {
      const errorHandler =
        onStoreError ??
        ((docId: DocId, operation: string, error: unknown) => {
          console.warn(
            `[exchange] store ${operation} failed for doc '${docId}':`,
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
                this.#stores.map(async store => {
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
                this.#stores.map(store => store.replace(docId, records)),
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
              Promise.all(this.#stores.map(store => store.delete(docId))).then(
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

      // Always export since the CONFIRMED version (phase.version). This
      // handles both the success and failure cases correctly:
      // - Success: queued delta overlaps with the just-written entry, but
      //   merge is idempotent — safe.
      // - Failure: queued delta covers confirmed → current, which is the
      //   full gap — correct.
      this.#synchronizer.onStateAdvanced((docId: DocId) => {
        if (!this.#storeHandle) return
        const phase = this.#storeHandle.getState().docs.get(docId)
        if (!phase) return // Not yet registered — still hydrating

        const runtime = this.#synchronizer.getDocRuntime(docId)
        if (!runtime) return

        const confirmedVersion = phase.version
        if (!confirmedVersion) return // Empty string = initial register, skip

        const sinceVersion =
          runtime.replicaFactory.parseVersion(confirmedVersion)
        const delta = runtime.replica.exportSince(sinceVersion)
        if (!delta) return // Version didn't actually advance — deduplication

        const newVersion = runtime.replica.version().serialize()
        this.#storeHandle.dispatch({
          type: "state-advanced",
          docId,
          delta,
          newVersion,
        })
      })
    } else {
      this.#storeHandle = null
    }
  }

  /**
   * Wire features advertised by a remote peer.
   *
   * Returns the features the peer advertised in its `establish` message,
   * or `undefined` if the peer is not yet established or advertised no
   * features. Features describe what wire-format extensions the peer
   * understands (aliasing, future QUIC modes); they are distinct from the
   * exchange's own `Capabilities` registry, which describes substrate /
   * schema bindings.
   */
  getPeerFeatures(peerId: PeerId): WireFeatures | undefined {
    return this.#synchronizer.getPeerFeatures(peerId)
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

    const factory = bound.factory({
      peerId: this.peerId,
      binding: bound.identityBinding,
    })
    const replicaType = factory.replica.replicaType
    if (!this.#capabilities.supportsReplicaType(replicaType)) {
      throw new Error(
        `[exchange] Internal error: registerSchema did not register replicaType [${replicaType}]`,
      )
    }

    // ── Shared prefix: create substrate, build ref, wire metadata ──
    const substrate = factory.create(bound.schema)

    const ref: any = createRef(bound.schema, substrate, {
      lease: this.#lease,
    })

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
        bound.syncProtocol,
        bound.schemaHash,
        "interpret",
      ).then(() => {
        subscribe(ref, changeset => {
          // Filter on the structural `replay` flag — not the `origin`
          // label string — so foreign-origin merges still don't echo
          // and `change(doc, fn, { origin: "sync" })` still broadcasts.
          if (changeset.replay) return
          this.#synchronizer.notifyLocalChange(docId)
        })
      })
      this.#trackHydration(hydrationOp)
    } else {
      this.#synchronizer.registerDoc({
        mode: "interpret",
        docId,
        replica: substrate,
        replicaFactory: factory.replica,
        syncProtocol: bound.syncProtocol,
        schemaHash: bound.schemaHash,
      })

      subscribe(ref, changeset => {
        // See companion subscriber above for the replay-vs-origin
        // rationale; identical filter.
        if (changeset.replay) return
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
    replicaFactory: ReplicaFactoryLike,
    syncProtocol: SyncProtocol,
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
        syncProtocol,
        schemaHash,
        "replicate",
      )
      this.#trackHydration(hydrationOp)
    } else {
      this.#synchronizer.registerDoc({
        mode: "replicate",
        docId,
        replica,
        replicaFactory,
        syncProtocol,
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
    syncProtocol: SyncProtocol,
    schemaHash: string,
  ): void {
    this.#synchronizer.deferDoc(docId, replicaType, syncProtocol, schemaHash)
    this.#docCache.set(docId, { mode: "deferred" })
  }

  // =========================================================================
  // PRIVATE — Hydration tracking
  // =========================================================================

  /**
   * Track an in-flight hydration promise so flush()/shutdown() can
   * await all hydrations before settling.
   */
  #trackHydration(op: Promise<void>): void {
    this.#pendingHydrations.add(op)
    op.finally(() => {
      this.#pendingHydrations.delete(op)
    })
  }

  /**
   * The loop handles the case where a hydration spawns another
   * hydration (e.g. schema auto-promotion during onEnsureDoc).
   */
  async #awaitHydrations(): Promise<void> {
    while (this.#pendingHydrations.size > 0) {
      await Promise.all(this.#pendingHydrations)
    }
  }

  // =========================================================================
  // PRIVATE — Storage: hydrate & register
  // =========================================================================

  /**
   * Async tail of get() and replicate() when stores are configured.
   * The caller has already created the replica/substrate and cached
   * the ref (if interpret mode).
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
    replica: ReplicaLike,
    replicaFactory: ReplicaFactoryLike,
    syncProtocol: SyncProtocol,
    schemaHash: string,
    mode: "interpret" | "replicate",
  ): Promise<void> {
    const meta: StoreMeta = {
      replicaType: replicaFactory.replicaType,
      syncProtocol,
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
                  `[exchange] failed to merge stored entry for doc '${docId}':`,
                  err,
                )
              }
            }
          }
          break // First-hit: use first store that has the doc
        }
      } catch (error) {
        console.warn(
          `[exchange] store hydration failed for doc '${docId}':`,
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

    // Register with synchronizer — present/interest messages carry
    // the hydrated version, not an empty one
    this.#synchronizer.registerDoc({
      mode,
      docId,
      replica,
      replicaFactory,
      syncProtocol,
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
   * factory builder. The bound schema's sync protocol determines how
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
   * - `replicate(docId, replicaFactory, syncProtocol, schemaHash)` — full
   *   registration with explicit arguments.
   *
   * @param docId - The document ID
   * @param replicaFactory - Factory for constructing headless replicas
   * @param syncProtocol - The sync protocol for this document
   * @param schemaHash - The schema hash for this document
   *
   * @example
   * ```typescript
   * import { loro } from "@kyneta/loro-schema"
   *
   * // Schema-free relay — replicate all docs without compile-time schema knowledge
   * exchange.replicate("shared-doc", loro.replica().factory, SYNC_COLLABORATIVE, "v1:abc123")
   *
   * // Promote a deferred doc — factory resolved from capabilities registry
   * exchange.replicate("deferred-doc")
   * ```
   */
  replicate(docId: DocId): void
  replicate(
    docId: DocId,
    replicaFactory: ReplicaFactoryLike,
    syncProtocol: SyncProtocol,
    schemaHash: string,
  ): void
  replicate(
    docId: DocId,
    replicaFactory?: ReplicaFactoryLike,
    syncProtocol?: SyncProtocol,
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
        metadata.syncProtocol,
      )
      if (!bound) {
        throw new Error(
          `Document '${docId}' is deferred with replicaType [${metadata.replicaType}] and ` +
            `syncProtocol ${JSON.stringify(metadata.syncProtocol)} but no matching BoundReplica is registered.`,
        )
      }
      replicaFactory = bound.factory
      syncProtocol = metadata.syncProtocol
      schemaHash = metadata.schemaHash
    } else if (cached) {
      throw new Error(
        `Document '${docId}' is already registered. ` +
          `Cannot call exchange.replicate() on an existing document.`,
      )
    }

    if (!replicaFactory || !syncProtocol || !schemaHash) {
      throw new Error(
        `exchange.replicate() requires (docId, replicaFactory, syncProtocol, schemaHash) ` +
          `or a deferred document to promote.`,
      )
    }

    this.#replicateDoc(docId, replicaFactory, syncProtocol, schemaHash)
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
   * synced cohort members. The LCV is the greatest version that is ≤
   * every synced cohort peer's last known version — the safe trim
   * point for `advance()`.
   *
   * Cohort membership is determined by the governance `cohort` gate;
   * the default cohort includes all peers (open gate).
   *
   * Returns `null` if no peers are synced for this doc, or if the
   * doc doesn't exist.
   *
   * @param docId - The document to compute the LCV for
   */
  leastCommonVersion(docId: DocId): Version | null {
    return this.#synchronizer.leastCommonVersion(docId, (peer, docId) =>
      this.#governance.cohort(docId, peer),
    )
  }

  /**
   * Compact a document — advance the base to the LCV and replace
   * stored payloads with the trimmed entirety.
   *
   * This is a convenience that composes `leastCommonVersion()` →
   * `replica.advance()` → `exportEntirety()` → store-program `compact`.
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

    if (this.#storeHandle) {
      const meta: StoreMeta = {
        replicaType: runtime.replicaFactory.replicaType,
        syncProtocol: runtime.syncProtocol,
        schemaHash: runtime.schemaHash,
      }
      this.#storeHandle.dispatch({
        type: "compact",
        docId,
        meta,
        entirety: runtime.replica.exportEntirety(),
        newVersion: runtime.replica.version().serialize(),
      })
      await this.#storeHandle.waitForState((s: StoreModel) => {
        const phase = s.docs.get(docId)
        return !phase || phase.status === "idle"
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
    this.#storeHandle?.dispatch({ type: "destroy", docId })
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
    this.#capabilities.registerSchema(bound, (builder, b) =>
      builder({ peerId: this.peerId, binding: b.identityBinding }),
    )

    // Auto-promote deferred docs that match the newly registered schema
    const factory = bound.factory({
      peerId: this.peerId,
      binding: bound.identityBinding,
    })
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
        bound.syncProtocol.writerModel === metadata.syncProtocol.writerModel &&
        bound.syncProtocol.delivery === metadata.syncProtocol.delivery &&
        bound.syncProtocol.durability === metadata.syncProtocol.durability
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
   * Await all pending store operations without disconnecting transports.
   *
   * Use this when you want to ensure all data has been persisted but
   * plan to continue using the Exchange afterwards.
   */
  async flush(): Promise<void> {
    await this.#awaitHydrations()
    if (this.#storeHandle) {
      await this.#storeHandle.waitForState(allDocsIdle)
    }
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
    this.#storeHandle?.dispose()
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
    await this.#awaitHydrations()
    if (this.#storeHandle) {
      await this.#storeHandle.waitForState(allDocsIdle)
      this.#storeHandle.dispose()
    }
    const disposeErrors = this.#governance.clear()
    this.#docCache.clear()
    await this.#synchronizer.shutdown()
    for (const backend of this.#stores) {
      await backend.close()
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
