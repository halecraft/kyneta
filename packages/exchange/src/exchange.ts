// exchange — the public API for @kyneta/exchange.
//
// The Exchange class is the central orchestrator for substrate-agnostic
// state synchronization. It manages document lifecycle, coordinates
// transports and a store, and provides the main API for
// document operations.
//
// Storage is coordinated via a pure Mealy machine (store-program) that
// models per-document write phases (idle ↔ writing). The Exchange
// instantiates the machine via createObservableProgram and interprets
// its data effects as actual I/O against the configured Store backends.
//
// Usage:
//   const exchange = new Exchange({
//     principal: "alice",
//     transports: [createWebsocketClient({ url: "ws://localhost:3000/ws" })],
//     store: createInMemoryStore(),
//   })
//
//   const TodoDoc = loro.bind(Schema.struct({ title: Schema.text() }))  // loro from @kyneta/loro-schema
//   const doc = exchange.get("my-doc", TodoDoc)
//   await whenSettled(doc)

import { type ReactiveMap, settableFeed, signalFeed } from "@kyneta/changefeed"
import type {
  BoundReplica,
  BoundSchema,
  Defer,
  DevtoolsHistory,
  DocRef,
  FactoryBuilder,
  Interpret,
  MetadataMismatch,
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
  WriteRefusal,
} from "@kyneta/schema"
import { metadataOf } from "@kyneta/schema"
import type {
  AnyTransport,
  DocId,
  PeerId,
  PeerIdentityDetails,
  PeerType,
  WireFeatures,
} from "@kyneta/transport"
import type { Capabilities } from "./capabilities.js"
import { createCapabilities, DEFAULT_REPLICAS } from "./capabilities.js"
import { type Peer, registerNetworkTerms, type Sync } from "./document-terms.js"
import type { Authority, Policy } from "./governance.js"
import { Governance, NotAWriterError } from "./governance.js"
import { planInterpretation } from "./interpret.js"
import type { Intent } from "./lifecycle-program.js"
import type { ObsSink } from "./observe.js"
import { mismatchError, Runtime, type RuntimeParams } from "./runtime.js"
import { liveSync, OfferRefusedError } from "./sync.js"
import {
  derivePeerSettled,
  refusingAuthority,
  Synchronizer,
} from "./synchronizer.js"
import type { DocChange, DocInfo, PeerChange } from "./types.js"
import { validatePrincipal } from "./utils.js"

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

/** Call signature for {@link Exchange.open}: {@link Get}'s, as a promise
 *  that may hold nothing. */
type Open = <S extends SchemaNode, N extends NativeMap>(
  docId: DocId,
  bound: BoundSchema<S, N>,
) => Promise<(S extends ProductSchema ? DocRef<S, N> : Ref<S, N>) | undefined>

/**
 * Who an Exchange says it is. Its peer id, the seat, is not here: the
 * {@link Runtime} issues it.
 */
export type PeerNaming = {
  /**
   * The name policies key on: a user, a service, a server fleet. Several
   * Exchanges may share one. Carried in `establish` and not verified.
   */
  principal: string
  /** Default `"user"`. */
  type?: PeerType
}

/**
 * Network-only parameters for constructing an Exchange over a pre-existing
 * {@link Runtime}. Used by the rare {@link Exchange} constructor overload:
 *
 * ```ts
 * const runtime = new Runtime({ store: ... })
 * const exchange = new Exchange(runtime, { principal: "alice", transports: [...] })
 * ```
 *
 * Excludes the local concerns (`store`, `lease`, `tickInterval`,
 * `onStoreError`), which live in the Runtime. The peer id is the Runtime's.
 */
export type ExchangeNetworkParams = PeerNaming & {
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
} & Policy

/**
 * Options for creating an Exchange via the primary (flat) constructor.
 *
 * The Exchange is the **network shell** — it owns transports, peers,
 * governance, and the sync graph. Local concerns (store, lease, clock)
 * are accepted here as flat fields and used to construct an internal
 * {@link Runtime}. The Runtime is an implementation detail — users of
 * this constructor never interact with it directly.
 *
 * For the rare case of wrapping a pre-constructed Runtime, use the
 * second constructor overload: `new Exchange(runtime, networkParams)`.
 */
export type ExchangeParams = ExchangeNetworkParams & RuntimeParams

// ---------------------------------------------------------------------------
// Exchange
// ---------------------------------------------------------------------------

/**
 * The Exchange class is the central orchestrator for substrate-agnostic
 * state synchronization.
 *
 * It manages the lifecycle of documents, coordinates subsystems (transports,
 * synchronizer, store), and provides the main public API for
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
 *   principal: "alice",
 *   transports: [createWebsocketClient({ url: "ws://localhost:3000/ws", WebSocket })],
 *   store: createInMemoryStore(),
 * })
 *
 * const TodoDoc = loro.bind(Schema.struct({ title: Schema.text() }))
 * const ConfigDoc = json.bind(Schema.struct({ theme: Schema.string() }))
 *
 * const doc = exchange.get("my-doc", TodoDoc)
 * const config = exchange.get("config", ConfigDoc)
 * doc.title()  // read
 * batch(doc, d => d.title.insert(0, "Hello"))  // write
 * await whenSettled(doc)          // sync
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
  /**
   * This replica's seat: the one its store issued, or a fresh one without a
   * store. See {@link Runtime.seat}.
   */
  readonly peerId: string
  /** Who this Exchange says it is. */
  readonly principal: string

  /**
   * The identity this Exchange announces, and the one `Policy.canWrite`
   * judges for this peer's own writes.
   */
  readonly #identity: PeerIdentityDetails
  readonly #governance: Governance
  readonly #capabilities: Capabilities
  readonly #synchronizer: Synchronizer

  /** The local imperative shell — owns documents, store, lease, clock. */
  readonly #runtime: Runtime

  readonly peers: ReactiveMap<PeerId, PeerIdentityDetails, PeerChange>
  readonly documents: ReactiveMap<DocId, DocInfo, DocChange>

  /**
   * **Primary path (90% case)** — construct an Exchange from flat params.
   * The Exchange constructs its own {@link Runtime} internally from the
   * local concerns (`store`, `lease`, `tickInterval`, `onStoreError`).
   *
   * ```typescript
   * new Exchange({ principal: "alice", transports: [...], store: ... })
   * ```
   */
  constructor(params: ExchangeParams)

  /**
   * **Rare path (10% case)** — wrap a pre-constructed {@link Runtime}.
   * Use this when you need a standalone Runtime first (e.g. local-first
   * app that later upgrades to networked), then attach networking.
   *
   * The `peerId` is `runtime.peerId`.
   *
   * ```typescript
   * const runtime = new Runtime({ store: ... })
   * const exchange = new Exchange(runtime, { principal: "alice", transports: [...] })
   * ```
   */
  constructor(runtime: Runtime, params: ExchangeNetworkParams)

  constructor(
    paramsOrRuntime: ExchangeParams | Runtime,
    networkParams?: ExchangeNetworkParams,
  ) {
    // The network-only overload carries no local fields, so reading them off
    // the flat shape yields `undefined` there.
    const {
      principal,
      type = "user",
      transports = [],
      schemas = [],
      replicas = DEFAULT_REPLICAS,
      departureTimeout,
      store,
      onStoreError,
      lease,
      tickInterval,
      ...policyFields
    }: ExchangeParams = paramsOrRuntime instanceof Runtime
      ? (networkParams as ExchangeNetworkParams)
      : paramsOrRuntime

    validatePrincipal(principal)
    this.#runtime =
      paramsOrRuntime instanceof Runtime
        ? paramsOrRuntime
        : new Runtime({ store, onStoreError, lease, tickInterval })
    this.peerId = this.#runtime.peerId
    this.principal = principal

    this.#identity = { peerId: this.peerId, principal, type }

    // Transports start last (`#synchronizer.start()` below), so nothing a
    // transport's first peer reaches is still missing, and a Runtime that
    // already belongs to an Exchange is refused before any socket opens.
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

    // The gate predicates read the live Governance at each call, so a policy
    // registered later counts without recreating the Synchronizer.
    //
    // `canAccept` is `canAccept ∧ canWrite`: both decide whether an offer's
    // sender may bring operations into the document, and the Synchronizer
    // treats a veto by either the same way.
    //
    // The Synchronizer shares the Runtime's lease so doc-layer dispatchers
    // and the synchronizer cooperate under one cascade budget.
    const governance = this.#governance
    this.#synchronizer = new Synchronizer({
      identity: this.#identity,
      transports,
      canShare: governance.canShare.bind(governance),
      canAccept: (docId, peer) =>
        governance.canAccept(docId, peer) && governance.canWrite(docId, peer),
      canConnect: this.#governance.canConnect.bind(this.#governance),
      canReset: this.#governance.canReset.bind(this.#governance),
      rebuildReplica: (docId, payload) =>
        this.#runtime.rebuildReplica(docId, payload),
      publishable: docId => this.#runtime.publishable(docId),
      // A peer that serves documents serves the ones it unloaded: a request
      // for one loads it again.
      servesUnloaded: () => this.#authority() === "self",
      onReloadDoc: docId => {
        this.#runtime.request({ type: "reload", docId })
      },
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
          // Unlike `#getImpl`, this door applies no policy of its own: no
          // local-schema-authoritative override. A deferred document the
          // announced metadata says this schema cannot read is skipped, and
          // so is whatever the Runtime refuses: a replicate document still
          // loading, or one this schema cannot read.
          if (this.#deferredMismatch(docId, resolvedBound) === undefined) {
            this.#runtime.request({
              type: "get",
              docId,
              bound: resolvedBound,
              intent: "create",
            })
          }
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
            this.#runtime.request({
              type: "get",
              docId,
              bound: result.bound,
              intent: "create",
            })
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
            // A document already held is left as it is: first writer wins.
            this.#runtime.request({
              type: "replicate",
              docId,
              replicaFactory: boundReplica.factory,
              syncMode,
              schemaHash,
            })
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
    // leave. The Exchange bridges them into the sync graph.
    this.#runtime.setHooks({
      // The Runtime's own record, not a copy: a replica the Runtime rebuilds
      // is then the one the Synchronizer syncs from.
      onDocReady: (info, state) => this.#synchronizer.registerDoc(info, state),
      onDocInterpreted: (docId, ref) => this.#attachNetwork(docId, ref),
      onDocChangeset: (docId, changeset) => {
        // Observation only: the changeset feed is for readers. What leaves
        // the process follows `onDocAdvanced`.
        this.#synchronizer.observeDocChangeset(docId, changeset)
      },
      onDocAdvanced: docId => {
        this.#synchronizer.notifyAdvanced(docId)
      },
      onDocPublishable: docId => {
        this.#synchronizer.notifyPublishable(docId)
      },
      onDocDestroyed: docId => {
        this.#synchronizer.leaveDocument(docId, "destroy")
      },
      onDocSuspended: docId => {
        this.#synchronizer.leaveDocument(docId, "suspend")
      },
      onDocLeaving: (docId, on) => {
        this.#synchronizer.setLeaving(docId, on)
      },
      onDocUnload: (docId, left) => {
        this.#synchronizer.leaveDocument(docId, "unload", left)
      },
      onDocResumed: docId => {
        this.#synchronizer.resumeDocument(docId)
      },
      onDocReset: docId => {
        this.#synchronizer.resetDocument(docId)
      },
    })

    // ── Wire Synchronizer → Runtime (store delta saves) ──
    // When the network advances a doc's version, the Runtime persists the
    // delta. Local changes reach the store from the Runtime's own drain, not
    // through here. Only the docId crosses: the Runtime resolves the document
    // itself.
    this.#synchronizer.onStateAdvanced((docId: DocId) => {
      this.#runtime.onStateAdvanced(docId)
    })

    this.#synchronizer.start()
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
   * Attach a ref's network terms: `sync(ref)`, its authority, the peer half
   * of its settle conjunction, and the policy's refusal of this peer's
   * writes. The Runtime calls this through `onDocInterpreted` for every
   * interpreted document, whether created through `get()`, loaded, promoted,
   * or created on a standalone Runtime before it was wrapped; it has already
   * attached the local half.
   *
   * The peer term is attached now rather than once sync completes, because
   * it has to be observable *while still false*. That is what stops a caller
   * reading a not-yet-synced document as empty. Each term follows a live feed
   * over this Exchange until the Runtime closes the document, which sets each
   * to its value at the close and so lets go of this Exchange.
   */
  #attachNetwork(docId: DocId, ref: object): void {
    const governance = this.#governance
    const identity = this.#identity
    const notAWriter = new NotAWriterError(docId, identity)
    // One error object per refusing peer, so successive reads of a document
    // its authority refuses return the same value.
    const offerRefused = new Map<PeerId, OfferRefusedError>()
    const refusedBy = (peer: PeerIdentityDetails): OfferRefusedError => {
      let error = offerRefused.get(peer.peerId)
      if (error === undefined) {
        error = new OfferRefusedError(docId, peer)
        offerRefused.set(peer.peerId, error)
      }
      return error
    }
    registerNetworkTerms(ref, {
      peer: settableFeed<Peer>(
        signalFeed(
          () => ({
            settled: this.#peerSettled(docId),
            resolve: authority => this.#peerSettled(docId, authority),
          }),
          onChange => this.#followDocument(docId, onChange),
        ),
      ),
      // Read at each use, and notified on every policy change: `Policy` is a
      // mutable registry, so a policy registered after the document was
      // created counts, for a reader and for an observer.
      authority: settableFeed<Authority>(
        signalFeed(
          () => this.#authority(),
          onChange => governance.subscribe(onChange),
        ),
      ),
      sync: settableFeed<Sync>(
        liveSync({
          peerId: this.peerId,
          docId,
          synchronizer: this.#synchronizer,
        }),
      ),
      // The network's verdict on this peer's writes, policy first, since it
      // is the standing rule and an offer refusal is what happened under it:
      // - the answer of `canWrite` for this peer's own identity, the one the
      //   Synchronizer announces, so a peer refuses its own write exactly when
      //   its peers would refuse its offer;
      // - the refusal of our operations by a peer this Exchange treats as the
      //   document's authority, derived from sync state as `peer` is.
      // One feed over both, so a policy change, which can move either, is
      // heard once.
      refusal: settableFeed<WriteRefusal | undefined>(
        signalFeed(
          () => {
            if (!governance.canWrite(docId, identity)) return notAWriter
            const peer = refusingAuthority(
              this.#authority(),
              this.#synchronizer.refusing(docId),
            )
            return peer === undefined ? undefined : refusedBy(peer)
          },
          onChange => this.#followDocument(docId, onChange),
        ),
      ),
    })
  }

  /**
   * Follow what a term over `docId`'s sync state and the policy's authority
   * reads: the Synchronizer's peer-sync changes for the document, and every
   * policy change, since the authority judges both whether the peers settle
   * the document and whether a refusing peer locks its writes. Returns one
   * unsubscribe.
   */
  #followDocument(docId: DocId, onChange: () => void): () => void {
    const stopSync = this.#synchronizer.onPeerSyncChange(changed => {
      if (changed === docId) onChange()
    })
    const stopPolicy = this.#governance.subscribe(onChange)
    return () => {
      stopSync()
      stopPolicy()
    }
  }

  /** The declared `Policy.authority`, or `"any"` when no policy declares one. */
  #authority(): Authority {
    return this.#governance.authority() ?? "any"
  }

  /**
   * Resolve the effective authority for a document and ask whether it has
   * reported.
   *
   * Resolution order is call-site → `Policy.authority` → `"any"`. There is no
   * call-site override at this layer — that arrives with `docStatus` — so this
   * consults the policy and falls back.
   *
   * Defaulting to `"any"` is safe because the case where a wrong guess would
   * corrupt data is blocked elsewhere by the schema binding: a
   * `writerModel: "serialized"` document can only be initialised by the peer
   * that declares `authority: "self"`.
   */
  #peerSettled(docId: DocId, override?: Authority): boolean {
    const authority = override ?? this.#authority()
    return derivePeerSettled({
      authority,
      hasReconciled: this.#synchronizer.hasReconciled(docId),
      matchesAuthority:
        typeof authority === "function"
          ? this.#synchronizer.reconciledMatching(docId, authority)
          : false,
      isOffline: this.#synchronizer.connectivity() === "offline",
    })
  }

  /**
   * Defer a document — register it in the synchronizer as deferred
   * (participates in routing/present but not data exchange) and record it
   * as deferred in the Runtime. A peer's announcement never replaces a
   * document this Runtime holds or has unloaded, so such a one is left as it
   * is, here and in the synchronizer.
   */
  #deferDoc(
    docId: DocId,
    replicaType: ReplicaType,
    syncMode: SyncMode,
    schemaHash: string,
  ): void {
    const lifecycle = this.#runtime.lifecycleOf(docId)
    if (lifecycle !== undefined && lifecycle.phase !== "deferred") return
    this.#synchronizer.deferDoc(docId, replicaType, syncMode, schemaHash)
    this.#runtime.defer(docId)
  }

  /**
   * The axis on which `bound` cannot read the deferred document `docId`, by
   * the metadata its announcement carried, which the Runtime does not hold.
   * `undefined` when it can, when nothing was announced, or when the
   * document is not deferred.
   */
  #deferredMismatch(
    docId: DocId,
    bound: BoundSchema,
  ): MetadataMismatch | undefined {
    if (this.#runtime.lifecycleOf(docId)?.phase !== "deferred") return undefined
    const action = planInterpretation({
      phase: "deferred",
      reader: metadataOf(bound),
      doc: this.#synchronizer.getDocMetadata(docId),
      hydration: { status: "none" },
    })
    return action.action === "refuse" && action.kind === "mismatch"
      ? action.mismatch
      : undefined
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
   * Multiple calls with the same `docId` return the same instance, for any
   * schema that can read what is already open — including a second `bind()`
   * over the same schema, and a schema whose migration chain reaches the
   * document's shape. A schema that cannot read it throws, naming the axis
   * that disagrees.
   *
   * The ref is returned synchronously. If a store is configured,
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
  get: Get = (docId, bound) => this.#getImpl(docId, bound, "create") as never

  /**
   * The document, if this exchange holds it: open, replicated, or stored.
   * Never creates, writes or announces one; resolves `undefined` instead.
   *
   * `get` answers "give me this document" and may create it; `open` answers
   * "give me this document if it is here". It is `get` with that intent,
   * through the same load: a document loaded from nothing is taken out again
   * before anything registers, writes or announces it. A document destroyed
   * here is not held, including while its delete is in flight or when the
   * destroy happens while `open` loads. A deferred document opens if the store
   * holds it, and otherwise stays deferred.
   *
   * Rejects when the store cannot be read (a failed read is not an absent
   * document), and throws as `get` does for a schema that cannot read the
   * document.
   */
  open: Open = (docId, bound) => this.#openImpl(docId, bound) as never

  /** Implementation of {@link open}, kept non-generic for the TS2589 reason
   *  {@link Get} gives. */
  async #openImpl(docId: DocId, bound: BoundSchema): Promise<unknown> {
    // Let a load in flight finish first: a replicate document mid-load would
    // be refused as "still loading". Its failure is not this call's: a load
    // that found nothing (another `open`) or was destroyed has left the
    // Runtime, and one whose read failed is still held, so the step below
    // throws its error (a replica) or the wait below rejects with it.
    await this.#runtime.whenHydrated(docId).catch(() => {})
    const ref = this.#getImpl(docId, bound, "open")
    // An `open` that can load nothing builds nothing.
    if (ref === undefined) return undefined
    const held = () => {
      const instance = this.#runtime.instanceOf(docId)
      return instance?.tier === "interpret" && instance.ref === ref
    }
    try {
      await this.#runtime.whenHydrated(docId)
    } catch (error) {
      if (held()) throw error
      return undefined
    }
    return held() ? ref : undefined
  }

  /**
   * Implementation of {@link get} and {@link open}, which differ only in
   * `kind`: what a load that finds nothing does (`Intent`). Not generic, so
   * the heavy `DocRef`/native-map inference stays out of the checked method
   * body; the precise return type is supplied by the {@link Get} and
   * {@link Open} call signatures, which the `as never` casts bridge. See
   * {@link Get} for the TS2589 rationale.
   *
   * One step of the Runtime's lifecycle, which answers every check but the
   * one below and throws its refusal. Returns `undefined` for an `open` that
   * can load nothing.
   */
  #getImpl(docId: DocId, bound: BoundSchema, kind: Intent["kind"]): unknown {
    // Note what is *not* checked here: suspension.
    //
    // `get()` on a suspended document returns the ref and leaves it
    // suspended — not "re-hydrates", not "resumes". `suspend()` only sets a
    // flag and tells peers to drop the document; the ref and substrate are
    // untouched, so reading locally was always well-defined.
    //
    // Resuming here would mean an unrelated read silently re-entering the
    // sync graph and restarting traffic peers can observe. Returning without
    // resuming keeps a property worth relying on: **`get()` never takes a
    // suspended document into the sync graph**, whether it promotes or loads
    // it; only `resume()` does. A standalone `Runtime` behaves the same.

    const mismatch = this.#deferredMismatch(docId, bound)
    if (mismatch !== undefined) {
      // The one policy this door holds, and the only place it is true.
      //
      // A deferred document got here because a *peer* announced it. If we
      // refused on a schema disagreement, any peer could break a local
      // `get()` simply by announcing a document under a colliding docId with
      // a different schema. So on the interpretation axis the local schema
      // stays authoritative: promote anyway, and say so.
      //
      // Only that axis. A replicaType or syncMode disagreement is about
      // whether bytes can be exchanged at all, and no amount of local intent
      // makes an undecodable format decodable — those refusals stand.
      //
      // And only for a deferred document. Both phases can arrive from a
      // peer's announcement, so provenance is not the distinction — what is
      // at stake is. A deferred document holds *nothing*, so overriding
      // materialises an empty one under the local schema. A replicate
      // document holds accumulated bytes, and overriding there reinterprets
      // them under a shape their writer did not use. That answer would be
      // wrong and silent, so the Runtime refuses it like any other axis.
      if (mismatch.axis !== "schemaHash") {
        throw mismatchError(docId, mismatch, "discovered")
      }
      console.warn(
        `[exchange] Promoting deferred doc "${docId}": local schemaHash "${bound.schemaHash}" ` +
          `differs from discovery schemaHash "${mismatch.remote}". ` +
          `Local schema is authoritative, but this indicates protocol disagreement.`,
      )
    }

    const before = this.#runtime.lifecycleOf(docId)
    const interpreted =
      before !== undefined &&
      before.phase !== "deferred" &&
      before.spec.tier === "interpret"
    const ref = this.#runtime.createInterpretDoc(docId, bound, kind)

    // Auto-register this schema's capabilities, unless the document was
    // interpreted already. registerSchema is idempotent (upserts into the
    // registry), so repeated get() calls with the same BoundSchema are safe.
    //
    // After the step, not before: registerSchema's sweep promotes deferred
    // documents this schema can read, and must not reach this one. Before the
    // step it would find it still deferred and promote it with intent
    // `create`, which an `open` of it does not have.
    if (!interpreted) this.registerSchema(bound)
    return ref
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
    // A deferred document is promoted with the factory its announcement
    // names. One already held is the Runtime's to refuse.
    if (this.#runtime.lifecycleOf(docId)?.phase === "deferred") {
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
    }

    if (!replicaFactory || !syncMode || !schemaHash) {
      throw new Error(
        `exchange.replicate() requires (docId, replicaFactory, syncMode, schemaHash) ` +
          `or a deferred document to promote.`,
      )
    }

    this.#runtime.replicate(docId, replicaFactory, syncMode, schemaHash)
  }

  /**
   * Check if a document exists in the exchange.
   *
   * Returns `true` for documents registered via `get()` (interpret mode)
   * or `replicate()` (replicate mode), deferred ones, and unloaded ones.
   *
   * @param docId - The document ID
   * @returns true if the document exists
   */
  has(docId: DocId): boolean {
    return this.#runtime.has(docId)
  }

  /**
   * Has this document finished loading from storage?
   *
   * Use this rather than the ref-keyed `hydrated(ref)` when there is no ref to
   * ask about — a document held in `replicate` mode is a bare replica with no
   * schema and no interpreter stack. An unknown document reports `true`: there
   * is nothing to load.
   *
   * @param docId - The document ID
   */
  hydrated(docId: DocId): boolean {
    return this.#runtime.hydrated(docId)
  }

  /**
   * Resolve once this document's stored data has finished loading; reject if
   * the load failed.
   *
   * The precise alternative to `flush()`, which drains every pending write
   * across the whole exchange and is named for that. This waits for one
   * document, and for loading rather than writing.
   *
   * @param docId - The document ID
   */
  whenHydrated(docId: DocId): Promise<void> {
    return this.#runtime.whenHydrated(docId)
  }

  /**
   * Compute the least common version (LCV) for a document across the
   * cohort members we push it to. The LCV is the greatest version that is
   * ≤ what each of them holds of ours (from its `accept`s and interests):
   * the safe trim point for `advance()`.
   *
   * Cohort membership is determined by the governance `cohort` gate;
   * the default cohort includes all peers (open gate).
   *
   * Returns `null` if no such peer's holding is known, or if the doc
   * doesn't exist.
   *
   * @param docId - The document to compute the LCV for
   */
  leastCommonVersion(docId: DocId): Version | null {
    return this.#synchronizer.leastCommonVersion(docId, (peer, docId) =>
      this.#governance.cohort(docId, peer),
    )
  }

  /**
   * Compact a document: trim its history in memory as far as every peer we
   * keep up to date allows, and replace what the store holds with the whole
   * document (`Runtime.compact`). Works for every document; a live CRDT
   * document trims nothing in memory, and its storage is compacted all the
   * same.
   *
   * The bound is `leastCommonVersion()`, so no peer whose holding is known is
   * stranded behind the trimmed base. With none known, history is trimmed
   * entirely; a peer whose holding is not known catches up with the whole
   * document.
   *
   * @param docId - The document to compact
   */
  async compact(docId: DocId): Promise<void> {
    await this.#runtime.compact(
      docId,
      this.leastCommonVersion(docId) ?? undefined,
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
   * All document IDs held in memory in interpret mode.
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
   * For interpreted docs, reads from the instance's BoundSchema.
   * For replicate/deferred docs, reads from the synchronizer model.
   * Returns `undefined` if the document is not known.
   */
  getDocSchemaHash(docId: DocId): string | undefined {
    if (!this.#runtime.has(docId)) return undefined
    // For replicate/deferred, the schema hash lives in the synchronizer model.
    return (
      this.#runtime.getDocSchemaHash(docId) ??
      this.#synchronizer.getDocMetadata(docId)?.schemaHash
    )
  }

  /**
   * Destroy a document — remove it locally, broadcast `dismiss` to
   * all peers, and delete from the store. A `get` afterwards creates a
   * fresh document, and `open` resolves `undefined`, even while the delete
   * is in flight. An unloaded document is deleted from the store too.
   *
   * To release a document's memory and keep it stored, use `unload`. For
   * bulk teardown without per-doc notification, use `reset()` or
   * `shutdown()`.
   *
   * @param docId - The ID of the document to destroy
   */
  destroy(docId: DocId): void {
    this.#runtime.destroy(docId)
  }

  /**
   * Suspend a document — leave the sync graph but keep all local state.
   *
   * The document remains in the Runtime and the store, and `exchange.has()`
   * still returns `true`. Peers are sent `dismiss`, and the document is not
   * announced again, even when it is promoted or loaded, until `resume()`
   * re-enters the sync graph.
   *
   * Cannot suspend a deferred, unloading or unloaded document.
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
   * Unload a document: release its memory and keep it in the store. `get`
   * or `open` loads it again, in the tier it had, suspended if it was.
   *
   * At once, its writes are refused with `DocumentClosedError` (reason
   * `"unloaded"`); it still sends peers every write made before the unload,
   * and takes nothing in. Once the store holds all of it, its ref closes (a
   * ref you hold reads its last value) and it leaves the sync graph; then
   * its native document is released. Opening it before the store holds all
   * of it cancels the unload and returns the same ref; opening it after
   * loads it again.
   *
   * While unloaded, `exchange.documents` shows it as `unloaded`, and peers
   * are not told of it. A peer that asks for it loads it again only where
   * this exchange's `Policy.authority` is `"self"`, and the first such
   * request logs an `unloaded-doc-reloaded` warning.
   *
   * Throws for a document not held, still loading, whose load failed, or not
   * stored (no store, or a transient sync mode), since unloading it would
   * lose its data. Does nothing for one already unloading or unloaded.
   *
   * @param docId - The ID of the document to unload
   */
  unload(docId: DocId): void {
    this.#runtime.unload(docId)
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

    // Auto-promote deferred docs this schema can now interpret.
    //
    // This asks the same question `resolveSchema` asks when a `present` first
    // arrives — "can this local schema read that document?" — so it has to
    // answer it the same way. It used to compare hashes for equality while
    // `resolveSchema` matched through `supportedHashes`, and the gap showed up
    // as promotion depending on *when* a schema was registered: before the
    // peer's `present` and the document was interpreted, after and it stayed
    // deferred forever, because nothing else re-examines a deferred document
    // no door names, and by then it has already run.
    //
    // Keep the iteration to deferred documents only. It is tempting, once a
    // shared law is in play, to widen this to replicate entries as well —
    // don't. This sweep is blanket: registering one schema would promote every
    // matching replicate document at once, and a relay that registered a
    // schema to interpret *one* document would silently acquire full
    // substrates for all of them. Unloaded documents are not deferred, so the
    // sweep never loads one back into memory.
    const reader = metadataOf(bound)
    for (const docId of this.#runtime.deferred) {
      const metadata = this.#synchronizer.getDocMetadata(docId)
      // No metadata means the synchronizer has nothing to match against, which
      // is a different situation from "matched and disagreed" — a blanket
      // sweep should not act on a document it knows nothing about.
      if (!metadata) continue
      const action = planInterpretation({
        phase: "deferred",
        reader,
        doc: metadata,
        // A deferred document holds nothing a load could preserve.
        hydration: { status: "none" },
      })
      if (action.action === "refuse") continue
      // One step, which promotes the deferred entry in place. A refusal is
      // skipped, as this sweep skips the classifier's.
      this.#runtime.request({ type: "get", docId, bound, intent: "create" })
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
   *
   * The order matters. With a store, an offer is withheld until the store
   * confirms the document's own writes, and the confirmation queues the
   * withheld offers synchronously, before `runtime.flush()` resolves. Draining
   * the transports after it is what sends them. A store that keeps failing
   * does not hold `runtime.flush()` up, so offers still waiting on it are not
   * sent.
   */
  async flush(): Promise<void> {
    await this.#runtime.flush()
    await this.#synchronizer.flush()
  }

  /**
   * Close every document, clear the policies, and disconnect every
   * transport, in that order.
   *
   * ⚠️ WARNING: This is synchronous and does NOT wait for pending storage
   * saves to complete. If you need to ensure data persistence, use
   * {@link shutdown} instead.
   */
  reset(): void {
    // Documents close before the policies clear, as in `shutdown`: clearing
    // first would lift every policy refusal of a document still open.
    this.#runtime.reset()
    const disposeErrors = this.#governance.clear()
    this.#synchronizer.reset()
    rethrowErrors(disposeErrors)
  }

  /**
   * Gracefully shut down: flush all pending store operations, then
   * disconnect all transports and clean up resources.
   *
   * This is the recommended way to stop an Exchange when using a persistent
   * store.
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
   * @internal The replica and schema registry, which an undo stack reads to
   * open a document it recorded before a reload.
   */
  get capabilities(): Capabilities {
    return this.#capabilities
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
