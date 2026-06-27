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
import type { Lease } from "@kyneta/machine"
import type {
  BoundReplica,
  BoundSchema,
  Defer,
  DevtoolsHistory,
  DocRef,
  FactoryBuilder,
  Interpret,
  NativeMap,
  ProductSchema,
  Ref,
  Reject,
  ReplicaFactoryLike,
  ReplicaType,
  Replicate,
  Schema as SchemaNode,
  SyncMode,
  Version,
} from "@kyneta/schema"
import type {
  AnyTransport,
  DocId,
  PeerId,
  PeerIdentityDetails,
  WireFeatures,
} from "@kyneta/transport"
import type { Capabilities } from "./capabilities.js"
import { createCapabilities, DEFAULT_REPLICAS } from "./capabilities.js"
import type { Policy } from "./governance.js"
import { Governance } from "./governance.js"
import type { ObsSink } from "./observe.js"
import { Runtime } from "./runtime.js"
import type { Store } from "./store/store.js"
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
 * Call signature for {@link Exchange.get}.
 *
 * Returns the precise root ref `DocRef<S, N>` for product-schema documents
 * (the common case) — so `unwrap(doc)` resolves to the substrate's root
 * container (`LoroDoc` / `Y.Doc` / `PlainState`) rather than the per-node
 * `N["struct"]`. Non-product roots fall back to `Ref<S, N>`.
 *
 * The conditional (`S extends ProductSchema ? … : …`) is load-bearing: it
 * keeps `DocRef<S, N>` *deferred* while `S` is the abstract type parameter
 * of this signature. Returning `DocRef<S, N>` unconditionally would force
 * TypeScript to instantiate it against an abstract `S` when checking the
 * `get` field's contextual type, which re-enters the deeply recursive
 * `SchemaRef` tree and trips `TS2589`. A deferred conditional is only
 * resolved once `S` is concrete at a call site, where the depth is bounded.
 * (Confirmed empirically; this is the same shape `useDocument` uses.)
 */
type Get = <S extends SchemaNode, N extends NativeMap>(
  docId: DocId,
  bound: BoundSchema<S, N>,
) => S extends ProductSchema ? DocRef<S, N> : Ref<S, N>

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
 * Network-only parameters for constructing an Exchange over a pre-existing
 * {@link Runtime}. Used by the rare {@link Exchange} constructor overload:
 *
 * ```ts
 * const runtime = new Runtime({ peerId: "alice", stores: [...] })
 * const exchange = new Exchange(runtime, { transports: [...] })
 * ```
 *
 * Excludes `id` (derived from `runtime.peerId`) and all local concerns
 * (`stores`, `lease`, `tickInterval`, `onStoreError`) — those live in the Runtime.
 */
export type ExchangeNetworkParams = {
  transports?: AnyTransport[]
  schemas?: BoundSchema[]
  replicas?: readonly BoundReplica[]
  departureTimeout?: number
} & Policy

/**
 * Options for creating an Exchange via the primary (flat) constructor.
 *
 * The Exchange is the **network shell** — it owns transports, peers,
 * governance, and the sync graph. Local concerns (stores, lease, clock)
 * are accepted here as flat fields and used to construct an internal
 * {@link Runtime}. The Runtime is an implementation detail — users of
 * this constructor never interact with it directly.
 *
 * For the rare case of wrapping a pre-constructed Runtime, use the
 * second constructor overload: `new Exchange(runtime, networkParams)`.
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
   * Transport instances for network connectivity.
   *
   * Use `create*` helpers for low-friction setup:
   *
   * ```typescript
   * transports: [createWebsocketClient({ url: "ws://localhost:3000/ws" })]
   * ```
   */
  transports?: AnyTransport[]

  /**
   * Stores for persistent document storage.
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
   * Interval (ms) for the heartbeat tick that drives time-based substrate
   * projections (e.g. `.decay()`). `0` disables the tick.
   *
   * @default 1000
   */
  tickInterval?: number

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
   * Each `BoundReplica` pairs a `ReplicaFactory` with a `SyncMode`,
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
// Doc cache entry — re-exported from Runtime for backward compatibility
// ---------------------------------------------------------------------------

export type { DocCacheEntry } from "./runtime.js"

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
 *   transports: [createWebsocketClient({ url: "ws://localhost:3000/ws", WebSocket })],
 *   stores: [createInMemoryStore()],
 * })
 *
 * const TodoDoc = loro.bind(Schema.struct({ title: Schema.text() }))
 * const ConfigDoc = json.bind(Schema.struct({ theme: Schema.string() }))
 *
 * const doc = exchange.get("my-doc", TodoDoc)
 * const config = exchange.get("config", ConfigDoc)
 * doc.title()  // read
 * batch(doc, d => d.title.insert(0, "Hello"))  // write
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

  /** The local imperative shell — owns documents, stores, lease, clock. */
  readonly #runtime: Runtime

  readonly peers: ReactiveMap<PeerId, PeerIdentityDetails, PeerChange>
  readonly documents: ReactiveMap<DocId, DocInfo, DocChange>

  /**
   * **Primary path (90% case)** — construct an Exchange from flat params.
   * The Exchange constructs its own {@link Runtime} internally from the
   * local concerns (`stores`, `lease`, `tickInterval`, `onStoreError`).
   *
   * ```typescript
   * new Exchange({ id: "alice", transports: [...], stores: [...] })
   * ```
   */
  constructor(params: ExchangeParams)

  /**
   * **Rare path (10% case)** — wrap a pre-constructed {@link Runtime}.
   * Use this when you need a standalone Runtime first (e.g. local-first
   * app that later upgrades to networked), then attach networking.
   *
   * The `peerId` is derived from `runtime.peerId` — do not pass `id`.
   *
   * ```typescript
   * const runtime = new Runtime({ peerId: "alice", stores: [...] })
   * const exchange = new Exchange(runtime, { transports: [...] })
   * ```
   */
  constructor(runtime: Runtime, params: ExchangeNetworkParams)

  constructor(
    paramsOrRuntime: ExchangeParams | Runtime,
    networkParams?: ExchangeNetworkParams,
  ) {
    const isRuntime = paramsOrRuntime instanceof Runtime

    // ── Resolve peerId and Runtime ──
    let peerId: string
    if (isRuntime) {
      this.#runtime = paramsOrRuntime
      peerId = paramsOrRuntime.peerId
    } else {
      const params = paramsOrRuntime as ExchangeParams
      const id = params.id
      peerId = typeof id === "string" ? id : id.peerId
      validatePeerId(peerId)
      this.#runtime = new Runtime({
        peerId,
        stores: params.stores,
        onStoreError: params.onStoreError,
        lease: params.lease,
        tickInterval: params.tickInterval,
      })
    }
    this.peerId = peerId

    // ── Extract network params (from flat params or network-only params) ──
    const {
      transports = [],
      schemas = [],
      replicas = DEFAULT_REPLICAS,
      departureTimeout,
      ...policyFields
    } = (
      isRuntime
        ? (networkParams as ExchangeNetworkParams)
        : (paramsOrRuntime as ExchangeParams)
    ) as ExchangeNetworkParams & {
      transports?: AnyTransport[]
    }

    // ── Resolve full identity (for the Synchronizer) ──
    const fullIdentity: PeerIdentityDetails = isRuntime
      ? { peerId, type: "user" }
      : typeof (paramsOrRuntime as ExchangeParams).id === "string"
        ? { peerId, type: "user" }
        : {
            type: "user",
            ...((paramsOrRuntime as ExchangeParams).id as PeerIdentityInput),
          }

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
        builder({ peerId, binding: bound.identityBinding }),
    })

    // Create synchronizer — call each factory to produce fresh adapter instances.
    // The canShare and canAccept predicates delegate to the live Governance,
    // so dynamically registered policies are visible without recreating the
    // synchronizer's update function.
    //
    // The Synchronizer shares the Runtime's lease so doc-layer dispatchers
    // and the synchronizer cooperate under one cascade budget.
    this.#synchronizer = new Synchronizer({
      identity: fullIdentity,
      transports,
      canShare: this.#governance.canShare.bind(this.#governance),
      canAccept: this.#governance.canAccept.bind(this.#governance),
      canConnect: this.#governance.canConnect.bind(this.#governance),
      canReset: this.#governance.canReset.bind(this.#governance),
      departureTimeout,
      lease: this.#runtime.lease,

      onEnsureDoc: (
        docId,
        peer,
        replicaType,
        syncMode,
        schemaHash,
        _supportedHashes,
      ): void => {
        // 1. Schema auto-resolve
        const resolvedBound = this.#capabilities.resolveSchema(
          schemaHash,
          replicaType,
          syncMode,
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
          syncMode,
          schemaHash,
        )

        if (!result) {
          // Two-tiered default: no callback matched this doc.
          if (this.#capabilities.supportsReplicaType(replicaType)) {
            // Supported replica type but no schema match — defer.
            // Promotion is plausible: a later exchange.get() or registerSchema()
            // will expand the schema set and auto-promote. NOT terminal, so
            // no `vacant` — the peer's interest stays live.
            this.#deferDoc(docId, replicaType, syncMode, schemaHash)
          } else {
            // Unsupported replica type — terminal will-not-serve. Tell the
            // requester so it can record us `vacant` instead of hanging.
            this.#synchronizer.declareVacant(docId, peer.peerId)
          }
          return
        }

        switch (result.kind) {
          case "interpret":
            this.#interpretDoc(docId, result.bound)
            break
          case "replicate": {
            const boundReplica = this.#capabilities.resolveReplica(
              replicaType,
              syncMode,
            )
            if (!boundReplica) {
              console.warn(
                `[exchange] resolve returned Replicate() for doc "${docId}" but no BoundReplica ` +
                  `is registered for replicaType [${replicaType}] with syncMode ${JSON.stringify(syncMode)}. ` +
                  `Add the appropriate BoundReplica to ExchangeParams.replicas.`,
              )
              // Terminal will-not-serve — tell the requester.
              this.#synchronizer.declareVacant(docId, peer.peerId)
              return
            }
            this.#replicateDoc(
              docId,
              boundReplica.factory,
              syncMode,
              schemaHash,
            )
            break
          }
          case "defer":
            this.#deferDoc(docId, replicaType, syncMode, schemaHash)
            break
          case "reject":
            // Explicitly rejected — terminal will-not-serve. Tell the
            // requester so it records us `vacant` rather than hanging.
            this.#synchronizer.declareVacant(docId, peer.peerId)
            break
        }
      },
    })
    this.peers = this.#synchronizer.createPeerFeed()
    this.documents = this.#synchronizer.createDocFeed()

    // ── Wire Runtime hooks → Synchronizer ──
    // The Runtime fires these when local docs become ready, change, or
    // are dismissed. The Exchange bridges them into the sync graph.
    this.#runtime.setHooks({
      onDocReady: info => {
        this.#synchronizer.registerDoc({
          mode: info.mode,
          docId: info.docId,
          replica: info.replica,
          replicaFactory: info.replicaFactory,
          syncMode: info.syncMode,
          schemaHash: info.schemaHash,
          ...(info.supportedHashes
            ? { supportedHashes: info.supportedHashes }
            : {}),
        } as DocRuntime)
      },
      onDocChangeset: (docId, changeset) => {
        // Observation tee — publish BOTH local and replay changesets
        // (before the echo filter) so the doc layer sees every change.
        this.#synchronizer.observeDocChangeset(docId, changeset)
        // Filter on the structural `replay` flag — not the `origin`
        // label string — so foreign-origin merges still don't echo
        // and `batch(doc, fn, { origin: "sync" })` still broadcasts.
        if (changeset.replay) return
        this.#synchronizer.notifyLocalChange(docId)
      },
      onDocDestroyed: docId => {
        this.#synchronizer.dismissDocument(docId)
      },
      onDocSuspended: docId => {
        this.#synchronizer.suspendDocument(docId)
      },
      onDocResumed: docId => {
        this.#synchronizer.resumeDocument(docId)
      },
    })

    // ── Wire Synchronizer → Runtime (store delta saves) ──
    // When the sync graph advances a doc's version (from network import
    // or local change), the Runtime needs to persist the delta.
    this.#synchronizer.onStateAdvanced((docId: DocId) => {
      const docRuntime = this.#synchronizer.getDocRuntime(docId)
      if (!docRuntime) return
      this.#runtime.onStateAdvanced(
        docId,
        docRuntime.replica,
        docRuntime.replicaFactory,
      )
    })
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
   * Internal document creation — delegates to the Runtime, then wires
   * sync capabilities onto the returned ref.
   *
   * This is the single creation path for interpreted docs. Both the
   * public `get()` and internal `onEnsureDoc` paths delegate here.
   */
  #interpretDoc(docId: DocId, bound: BoundSchema): any {
    // The Runtime handles substrate creation, caching, hydration, and
    // fires onDocReady (which the Exchange wires to registerDoc).
    //
    // Uses createInterpretDoc (non-generic) instead of get (generic) to
    // avoid TS2589: #interpretDoc is called from both the generic #getImpl
    // (precise types) and the non-generic onEnsureDoc callback. Since this
    // method returns `any` and #getImpl supplies the precise return type via
    // the Get call-signature, the non-generic internal path is correct.
    const ref = this.#runtime.createInterpretDoc(docId, bound)

    // Wire sync capabilities onto the ref. This must happen after the
    // Runtime creates the ref so sync() works immediately.
    registerSync(ref, {
      peerId: this.peerId,
      docId,
      synchronizer: this.#synchronizer,
    })

    return ref
  }

  /**
   * Internal document replication — delegates to the Runtime.
   */
  #replicateDoc(
    docId: DocId,
    replicaFactory: ReplicaFactoryLike,
    syncMode: SyncMode,
    schemaHash: string,
  ): void {
    this.#runtime.replicate(docId, replicaFactory, syncMode, schemaHash)
  }

  /**
   * Defer a document — register it in the synchronizer as deferred
   * (participates in routing/present but not data exchange) and cache
   * the deferred state in the Runtime.
   */
  #deferDoc(
    docId: DocId,
    replicaType: ReplicaType,
    syncMode: SyncMode,
    schemaHash: string,
  ): void {
    this.#synchronizer.deferDoc(docId, replicaType, syncMode, schemaHash)
    this.#runtime.markDeferred(docId)
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
   * For a product-schema root (the common case), the returned ref is a
   * `DocRef<S, N>`: its top-level `[NATIVE]` resolves to the substrate's
   * *root* container (`unwrap(doc)` → `LoroDoc` / `Y.Doc` / `PlainState`),
   * while nested struct fields resolve to their per-node container
   * (`unwrap(doc.field)` → `LoroMap` / `Y.Map` / `undefined`). The native
   * map `N` is threaded from the `BoundSchema`, so `unwrap` is precisely
   * typed end-to-end — no union, no narrowing, no separate accessor.
   *
   * @param docId - The document ID
   * @param bound - A BoundSchema created by `bind()`, `json.bind()`, or `loro.bind()`
   * @returns A full-stack DocRef<S, N> with sync capabilities via `sync()`
   *
   * @example
   * ```typescript
   * import { json, unwrap } from "@kyneta/schema"
   * import { loro } from "@kyneta/loro-schema"
   *
   * const TodoDoc = loro.bind(Schema.struct({ title: Schema.text() }))
   * const doc = exchange.get("my-doc", TodoDoc)
   * unwrap(doc) // LoroDoc — the root container, precisely typed
   *
   * // Initial content via batch() after construction:
   * batch(doc, d => { d.title.insert(0, "Hello") })
   * ```
   */
  get: Get = (docId, bound) => this.#getImpl(docId, bound) as never

  /**
   * Implementation of {@link get}. Kept generic only in `S` and returning the
   * plain `Ref<S>` so the heavy `DocRef`/native-map inference stays out of the
   * checked method body — the precise `DocRef<S, N>` return type is supplied
   * by the {@link Get} call-signature on the public `get` field, which the
   * `as never` cast bridges. See {@link Get} for the TS2589 rationale.
   */
  #getImpl<S extends SchemaNode>(docId: DocId, bound: BoundSchema<S>): Ref<S> {
    // Check Runtime cache first
    const cached = this.#runtime.getEntry(docId)

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
        this.#runtime.deleteDeferred(docId)
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
   * - `replicate(docId, replicaFactory, syncMode, schemaHash)` — full
   *   registration with explicit arguments.
   *
   * @param docId - The document ID
   * @param replicaFactory - Factory for constructing headless replicas
   * @param syncMode - The sync protocol for this document
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
    syncMode: SyncMode,
    schemaHash: string,
  ): void
  replicate(
    docId: DocId,
    replicaFactory?: ReplicaFactoryLike,
    syncMode?: SyncMode,
    schemaHash?: string,
  ): void {
    // Handle deferred promotion or throw on duplicate
    const cached = this.#runtime.getEntry(docId)
    if (cached?.mode === "deferred") {
      // Promote deferred → replicate
      this.#runtime.deleteDeferred(docId)
      const metadata = this.#synchronizer.getDocMetadata(docId)
      if (!metadata) {
        throw new Error(
          `Document '${docId}' is deferred but has no synchronizer metadata.`,
        )
      }
      const bound = this.#capabilities.resolveReplica(
        metadata.replicaType,
        metadata.syncMode,
      )
      if (!bound) {
        throw new Error(
          `Document '${docId}' is deferred with replicaType [${metadata.replicaType}] and ` +
            `syncMode ${JSON.stringify(metadata.syncMode)} but no matching BoundReplica is registered.`,
        )
      }
      replicaFactory = bound.factory
      syncMode = metadata.syncMode
      schemaHash = metadata.schemaHash
    } else if (cached) {
      throw new Error(
        `Document '${docId}' is already registered. ` +
          `Cannot call exchange.replicate() on an existing document.`,
      )
    }

    if (!replicaFactory || !syncMode || !schemaHash) {
      throw new Error(
        `exchange.replicate() requires (docId, replicaFactory, syncMode, schemaHash) ` +
          `or a deferred document to promote.`,
      )
    }

    this.#replicateDoc(docId, replicaFactory, syncMode, schemaHash)
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
    return this.#runtime.has(docId)
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

    await this.#runtime.compact(
      docId,
      runtime.replica,
      runtime.replicaFactory,
      runtime.syncMode,
      runtime.schemaHash,
    )
  }

  /**
   * The set of deferred document IDs.
   *
   * Deferred docs participate in routing but have no local representation.
   * They can be promoted via `exchange.get()` or `exchange.replicate()`.
   */
  get deferred(): ReadonlySet<DocId> {
    return this.#runtime.deferred
  }

  /**
   * All document IDs currently in interpret mode.
   *
   * Returns a snapshot — the set is not live. Call again to get
   * the current state.
   */
  documentIds(): ReadonlySet<DocId> {
    return this.#runtime.documentIds()
  }

  /**
   * Schema hash for a document, if it exists.
   *
   * For interpreted docs, reads from the cached BoundSchema.
   * For replicate/deferred docs, reads from the synchronizer model.
   * Returns `undefined` if the document is not known.
   */
  getDocSchemaHash(docId: DocId): string | undefined {
    const cached = this.#runtime.getEntry(docId)
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
    this.#runtime.destroy(docId)
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
    this.#runtime.suspend(docId)
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
    this.#runtime.resume(docId)
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
    for (const docId of this.#runtime.deferred) {
      const metadata = this.#synchronizer.getDocMetadata(docId)
      if (!metadata) continue
      // Check if the new schema matches the deferred doc's triple
      if (
        bound.schemaHash === metadata.schemaHash &&
        replicaType[0] === metadata.replicaType[0] &&
        replicaType[1] === metadata.replicaType[1] &&
        bound.syncMode.writerModel === metadata.syncMode.writerModel &&
        bound.syncMode.delivery === metadata.syncMode.delivery &&
        bound.syncMode.durability === metadata.syncMode.durability
      ) {
        // Safe: Runtime.deleteDeferred removes from cache, then #interpretDoc
        // inserts the new entry.
        this.#runtime.deleteDeferred(docId)
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
    await this.#runtime.flush()
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
    this.#runtime.reset()
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
    await this.#runtime.shutdown()
    const disposeErrors = this.#governance.clear()
    await this.#synchronizer.shutdown()
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

  /**
   * Subscribe a DevTools observation sink. Returns an unsubscribe function.
   *
   * The sink receives a correlated `ObsEvent` stream across the engine,
   * protocol, doc, directory, and diagnostic layers (plus wire/substrate in
   * later phases). Opt-in and zero-cost when no sink is attached.
   *
   * **Experimental** — the `ObsEvent` shape (`v: 1`) may change.
   */
  observe(sink: ObsSink): () => void {
    return this.#synchronizer.observe(sink)
  }

  /**
   * Lazy DevTools history for a document — version/op summary and (where the
   * substrate supports it, e.g. Loro) `valueAt(version)` time-travel.
   * Returns `undefined` for unknown docs or substrates without the capability.
   *
   * **Experimental.**
   */
  docHistory(docId: DocId): DevtoolsHistory | undefined {
    return this.#synchronizer.docHistory(docId)
  }

  /** @internal */
  get synchronizer(): Synchronizer {
    return this.#synchronizer
  }

  /**
   * The local imperative shell backing this Exchange.
   *
   * Exposed for advanced use cases (standalone document creation, direct
   * store access, etc.). Most callers should use the Exchange API directly.
   */
  get runtime(): Runtime {
    return this.#runtime
  }
}
