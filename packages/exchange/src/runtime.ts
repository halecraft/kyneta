// runtime — the local imperative shell for document execution.
//
// The Runtime owns the *local* lifecycle of documents: the lifecycle
// program's model and each instance's live objects, persistent storage (hydration + persistence via the pure store-program
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
// FC/IS boundary: the store program and the lifecycle program are pure
// functional cores; the Runtime is the imperative shell that interprets
// their effects as real I/O. The tick clock (`setInterval`) lives here, not in substrates —
// substrates expose a pure `tick?(now: number)` that the Runtime calls.

import {
  type Changeset,
  type Feed,
  firstDefined,
  type Settable,
  settableFeed,
  signalFeed,
} from "@kyneta/changefeed"
import type { Lease, ObservableHandle } from "@kyneta/machine"
import { createLease, createObservableProgram } from "@kyneta/machine"
import type {
  BoundSchema,
  DocRef,
  HydrationHandle,
  NativeMap,
  Op,
  ProductSchema,
  Ref,
  ReplicaFactoryLike,
  ReplicaLike,
  Schema as SchemaNode,
  Substrate,
  SubstratePayload,
  SyncMode,
  Version,
} from "@kyneta/schema"
import {
  beginHydration,
  type ClosedReason,
  createRef,
  DEFAULT_LINEAGE,
  DocumentClosedError,
  type MetadataMismatch,
  replicaFromEntirety,
  replicaTypesCompatible,
  subscribe,
  upgradeReplica,
  type WriteRefusal,
} from "@kyneta/schema"
import type { DocId, PeerId } from "@kyneta/transport"
import {
  buildLocalTerms,
  closedHydration,
  closeTerms,
  type Hydration,
  type NetworkTerms,
  networkTermFeed,
  type Persistence,
  registerTerms,
  termsOf,
} from "./document-terms.js"
import {
  type BuildSpec,
  currentGen,
  deferredIds,
  type Generation,
  hydrationOf,
  type Intent,
  initialLifecycle,
  isHeld,
  type Lifecycle,
  type LifecycleEffect,
  type LifecycleInput,
  type LifecycleModel,
  type LifecycleRequest,
  type LoadOutcome,
  lifecycleProgram,
  type Refusal,
  storedOf,
  unloadingOf,
} from "./lifecycle-program.js"
import { gateOpen } from "./publish-gate.js"
import {
  type Seat,
  SeatLostError,
  sessionSeat,
  WriterRefusedError,
} from "./store/seats.js"
import { type SerialStore, serialStore } from "./store/serial-store.js"
import type {
  Store,
  StoreMark,
  StoreRecord,
  WriteOptions,
} from "./store/store.js"
import {
  allDocsSettled,
  confirmedVersion,
  isSettled,
  type StoreEffect,
  type StoreInput,
  type StoreModel,
  storeProgram,
  type Write,
} from "./store/store-program.js"
import {
  latestStoredLineage,
  type StoredEntry,
  takeStoredEntries,
} from "./stored-entries.js"

/**
 * Let a Node.js timer run without keeping the process alive. Browser timers
 * are numbers and have no `unref`.
 */
function unrefTimer(timer: unknown): void {
  if (
    typeof timer === "object" &&
    timer !== null &&
    "unref" in timer &&
    typeof timer.unref === "function"
  ) {
    timer.unref()
  }
}

/**
 * What one write stores, and the version it brings the store to. Each kind is
 * one Store call, so a write is never split around another call of the same
 * document (see `serialStore`).
 */
type Prepared =
  /** Meta and the whole document, by `compact`. */
  | {
      readonly kind: "whole"
      readonly records: StoreRecord[]
      readonly version: string
    }
  /** A delta, by `append`. */
  | {
      readonly kind: "delta"
      readonly record: StoreRecord
      readonly version: string
    }
  /** Nothing past the store's confirmed version: the store already holds it
   *  all, and the write succeeds without a call. */
  | { readonly kind: "none"; readonly version: string }

/**
 * Store `prepared` in one call. A whole document replaces the records at or
 * before `through`, or with `through` null (a document the store has never
 * acknowledged) only appends.
 */
async function storeWrite(
  store: Store,
  docId: DocId,
  prepared: Prepared,
  through: StoreMark | null,
  options: WriteOptions,
): Promise<void> {
  switch (prepared.kind) {
    case "whole":
      return store.compact(docId, prepared.records, through, options)
    case "delta":
      return store.append(docId, prepared.record, options)
    case "none":
      return
  }
}

/**
 * What the Runtime owes a document's substrate: its `HydrationHandle`, less
 * the substrate.
 */
type Authorship = Omit<HydrationHandle, "substrate">

/**
 * The authorship of an interpreted document that loads nothing from a store
 * (no store, a transient document, or a promotion whose replica already
 * loaded): `adopt` has nothing to wait for.
 */
const NO_AUTHORSHIP: Authorship = { adopt: () => {} }

/**
 * The Runtime's part of who, besides the substrate, refuses an interpreted
 * document's authored writes. `createRef` attaches the owner's answer as
 * `firstDefined(lifecycle, seat, network refusal)`, where the network
 * refusal is a network term (`NetworkTerms.refusal`), closed with the other
 * terms.
 */
type Refusals = {
  /** Derived from the lifecycle: `DocumentClosedError("unloaded")` while the
   *  instance unloads. Set to the close error when the instance closes. */
  readonly lifecycle: Settable<WriteRefusal | undefined>
  /** Another seat of the storage writes this serialized document. Set once,
   *  at load or after a lost race, and kept for the session. */
  readonly seat: Settable<WriteRefusal | undefined>
}

/**
 * The network term an interpreted document's owner refusal follows. Declared
 * here rather than inline in `#buildInterpret`: a closure made there would
 * share that method's scope, which holds the Runtime, and a held ref keeps
 * its owner refusal after the close.
 */
const networkRefusal = (
  network: NetworkTerms,
): Feed<WriteRefusal | undefined> => network.refusal

/** What an interpreted document that is not yet wired has wired: nothing. */
const NOTHING_WIRED = (): void => {}

/**
 * What `#hydrate` gathers: the outcome, and the seat the store records as the
 * document's writer (`null` when none is, or the store records none).
 */
type Loaded = {
  readonly outcome: LoadOutcome
  readonly writer: PeerId | null
}

const NOTHING_LOADED: Loaded = { outcome: { kind: "none" }, writer: null }

/** The error every door that throws `refusal` throws. */
export function refusalError(refusal: Refusal): Error {
  const { docId } = refusal
  switch (refusal.kind) {
    case "not-hydrated":
      return new Error(
        `Document '${docId}' is still loading from storage. ` +
          `Await whenHydrated('${docId}') before calling get() ` +
          `— promoting a document mid-load would lose part of it.`,
      )
    case "load-failed":
      return refusal.error instanceof Error
        ? refusal.error
        : new Error(String(refusal.error))
    case "mismatch":
      return mismatchError(docId, refusal.mismatch, "document")
    case "not-held":
      switch (refusal.phase) {
        case "absent":
          return new Error(`Document '${docId}' does not exist.`)
        case "unloaded":
          return new Error(`Document '${docId}' is unloaded; open it first.`)
        case "deferred":
          return refusal.door === "resume"
            ? notSuspended(docId)
            : new Error(`Cannot ${refusal.door} deferred document '${docId}'.`)
      }
      break
    case "not-suspended":
      return notSuspended(docId)
    case "already-held":
      return new Error(
        `Document '${docId}' is already registered. ` +
          `Cannot replicate an existing document.`,
      )
    case "not-stored":
      return new Error(
        `Document '${docId}' is not stored: unloading it would lose its ` +
          `data. Unloading needs a store and a persistent sync mode.`,
      )
    case "unloading":
      return new Error(
        `Document '${docId}' is unloading; cannot ${refusal.door} it ` +
          `until it is opened again.`,
      )
  }
}

function notSuspended(docId: DocId): Error {
  return new Error(
    `Document '${docId}' is not suspended. Call suspend() first.`,
  )
}

/**
 * A schema that cannot read a document, as an error. `other` names where the
 * document's metadata came from: this Runtime's record (`document`), or a
 * peer's announcement (`discovered`).
 */
export function mismatchError(
  docId: DocId,
  mismatch: MetadataMismatch,
  other: "document" | "discovered",
): Error {
  return new Error(
    `Document '${docId}' cannot be interpreted with this schema: ` +
      `${mismatch.axis} disagrees (local ${mismatch.local} ` +
      `vs ${other} ${mismatch.remote}).`,
  )
}

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
 * The one record of a registered document: its replica and sync metadata.
 *
 * The Runtime creates it and owns it. {@link RuntimeHooks.onDocReady} hands
 * the same object to the Exchange, which registers it with the Synchronizer
 * as it is, so the network shell and the local shell never hold two copies
 * that could disagree. The Synchronizer reads it through `Readonly`; only the
 * Runtime replaces a replica (see {@link Runtime.rebuildReplica}).
 *
 * Discriminated by mode: an interpreted document's replica is its
 * `Substrate`.
 */
export type DocReadyInfo = {
  readonly docId: DocId
  readonly replicaFactory: ReplicaFactoryLike
  readonly syncMode: SyncMode
  readonly schemaHash: string
  /** Ancestor hashes from the schema's migration chain, which `present`
   *  messages advertise for multi-version compatibility. */
  readonly supportedHashes?: readonly string[]
} & (
  | { readonly mode: "interpret"; readonly replica: Substrate<Version> }
  | { readonly mode: "replicate"; replica: ReplicaLike }
)

type InterpretReadyInfo = Extract<DocReadyInfo, { mode: "interpret" }>
type ReplicateReadyInfo = Extract<DocReadyInfo, { mode: "replicate" }>

// ---------------------------------------------------------------------------
// Instance — the live objects of one generation of a document
// ---------------------------------------------------------------------------

/**
 * Where an interpreted document's own writes stand against its store. See
 * §"Store-first" in TECHNICAL.md.
 */
export type Publication = {
  /**
   * The replica's version when the drain last found own writes, until the
   * store confirms a version that reaches it. `undefined` when every own write
   * is confirmed, and always for a document without a store.
   */
  ownHigh: Version | undefined
  /** The error of the latest failed store write, until a write succeeds. */
  error: unknown
  /** What the persistence term last reported, so it reports changes only. */
  reported: { readonly persisted: boolean; readonly error: unknown }
  readonly listeners: Set<() => void>
}

function createPublication(): Publication {
  return {
    ownHigh: undefined,
    error: undefined,
    reported: { persisted: true, error: undefined },
    listeners: new Set(),
  }
}

/** An instance's values the lifecycle model decides. */
type Observed = {
  readonly hydration: Hydration
  readonly refusal: WriteRefusal | undefined
}

/**
 * Whoever follows an instance's {@link Observed} values: `whenHydrated(docId)`,
 * and the subscribers of its hydration term and its lifecycle refusal. Each
 * is called with the new values when a step changes them, and with the
 * closing values when the instance closes.
 */
type Observers = Set<(observed: Observed) => void>

/**
 * The live objects of one instance of a document, under its generation. What
 * the instance *is* (its phase, tier, metadata, writer, whether it is
 * suspended or registered) is data, and lives in the lifecycle model; this is
 * what a model cannot hold.
 *
 * Exported so `Runtime`'s declarations can name it; `index.ts` does not
 * export it.
 */
export type Instance =
  | {
      readonly tier: "interpret"
      readonly ref: any
      readonly bound: BoundSchema
      readonly readyInfo: InterpretReadyInfo
      readonly authorship: Authorship
      readonly refusals: Refusals
      /** Where its own writes stand against the store. */
      readonly publication: Publication
      /** What its lifecycle refusal answers while it unloads: one object,
       *  so the refusal reads the same each time. */
      readonly unloaded: DocumentClosedError
      readonly observers: Observers
      /** Undoes what `wire` attached; a no-op until then. */
      unwire: () => void
    }
  | {
      readonly tier: "replicate"
      readonly readyInfo: ReplicateReadyInfo
      readonly observers: Observers
    }

type InterpretInstance = Extract<Instance, { tier: "interpret" }>

/** What a step came to: a refusal, or the instance it built, if any. */
type Stepped =
  | { readonly refusal: Refusal }
  | { readonly built: Instance | undefined }

/** Two hydrations say the same: one status, and for a failure one error. */
function sameHydration(a: Hydration, b: Hydration): boolean {
  if (a.status !== b.status) return false
  return a.status !== "failed" || (b.status === "failed" && a.error === b.error)
}

/** Two observations say the same: by value, each refusal by identity. */
function sameObserved(a: Observed, b: Observed): boolean {
  return sameHydration(a.hydration, b.hydration) && a.refusal === b.refusal
}

/** What `model` says of the instance of `gen`. */
function observedIn(
  model: LifecycleModel,
  docId: DocId,
  gen: Generation,
  instance: Instance,
): Observed {
  return {
    hydration: hydrationOf(model, docId),
    refusal:
      instance.tier === "interpret" && unloadingOf(model, docId, gen)
        ? instance.unloaded
        : undefined,
  }
}

/** Follow `observers` with a callback that ignores the values; return what
 *  stops it. */
function observe(observers: Observers, onChange: () => void): () => void {
  const observer = (): void => onChange()
  observers.add(observer)
  return () => observers.delete(observer)
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
   * immediately if no store is configured), or when an unload begun before
   * an Exchange set hooks is cancelled: it is ready to participate in the
   * sync graph. A `suspended` one is held out of the sync graph, so it
   * registers without being announced.
   *
   * The Exchange implements this to call `synchronizer.registerDoc(...)`.
   */
  onDocReady?: (info: DocReadyInfo, state: { suspended: boolean }) => void

  /**
   * Called when an interpreted document's changeset fires, local or replay.
   *
   * For observation only: the Exchange forwards it to the Synchronizer's
   * observation bus. Nothing leaves the process from here; see
   * {@link RuntimeHooks.onDocAdvanced}.
   */
  onDocChangeset?: (docId: DocId, changeset: Changeset<Op>) => void

  /**
   * Called when a document's replica advanced by a route other than the
   * network: an interpreted document's local operations, however they were
   * written (from the drain, after persistence was requested for them), or
   * records a compaction took in from the store.
   *
   * The Exchange implements this to call `synchronizer.notifyAdvanced`,
   * which asks for a push to peers. With a store, the push is held until the
   * store confirms the document's own operations (see
   * {@link Runtime.publishable}).
   */
  onDocAdvanced?: (docId: DocId) => void

  /**
   * Called when the store confirms a document's own writes, so the document
   * may leave the process again. An export can only have been refused before
   * this.
   *
   * The Exchange implements this to call `synchronizer.notifyPublishable`,
   * which sends the offers that were withheld.
   */
  onDocPublishable?: (docId: DocId) => void

  /**
   * Called when a document is gone: destroyed locally, or found deleted from
   * the store when an unloaded one was opened. The Exchange implements this
   * to take it out of the sync graph as destroyed
   * (`synchronizer.leaveDocument`).
   */
  onDocDestroyed?: (docId: DocId) => void

  /**
   * Called when a document is suspended locally: it leaves the sync graph
   * and keeps all local state. The Exchange implements this to take it out
   * of the sync graph as suspended (`synchronizer.leaveDocument`), which
   * keeps its record for `resume`.
   */
  onDocSuspended?: (docId: DocId) => void

  /**
   * Called when an unload starts (`on`) or is cancelled: while leaving, the
   * document sends what it owes peers and takes nothing in. The Exchange
   * implements this with `synchronizer.setLeaving`.
   */
  onDocLeaving?: (docId: DocId, on: boolean) => void

  /**
   * Called once the store holds all of an unloading document: take it out of
   * the sync graph as unloaded, then call `left`, after which its replica is
   * disposed. The Exchange implements this with
   * `synchronizer.leaveDocument`. Without it, the document leaves at once.
   */
  onDocUnload?: (docId: DocId, left: () => void) => void

  /**
   * Called when an interpreted document is created, on every path (a new
   * document, a stored one, a promotion from a relay), and for every
   * interpreted document already held when the hooks are set. Fired
   * before the document becomes ready, so what is attached here observes its
   * registration with the sync graph.
   *
   * The Exchange implements this to attach the ref's network terms:
   * `sync(ref)`, its authority, and the peer half of its settle conjunction.
   * The Runtime has already attached the local ones (hydration, persistence)
   * and its refusal.
   */
  onDocInterpreted?: (docId: DocId, ref: object) => void

  /**
   * Called when an interpreted document's state was replaced locally by what
   * its store holds (a lost writer race's rebuild). Peers may have sent
   * operations the replacement discarded, and believe this replica holds
   * them. The Exchange implements this to call
   * `synchronizer.resetDocument()`, which asks each again.
   */
  onDocReset?: (docId: DocId) => void

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
  /**
   * The store documents persist to and load from. It also issues the
   * Runtime's seat, which survives a restart over the same storage.
   */
  store?: Store

  /**
   * Called when a store operation fails. Default: `console.warn`. A
   * `SeatLostError` is reported once: another writer holds this Runtime's
   * seat, so it writes nothing more, and the application recovers by opening
   * a new store (in a browser, by reloading).
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
 * Owns the documents (the lifecycle program's model, and each instance's
 * live objects), persistent storage (hydration + persistence), the cascade
 * `Lease`, and the ticking clock. This is the layer between
 * the pure CRDT math (substrates) and the network shell (`Exchange`).
 *
 * A standalone local-first application (no network) uses a `Runtime`
 * directly:
 *
 * ```typescript
 * const runtime = new Runtime({ store: createInMemoryStore() })
 * const doc = runtime.get("my-doc", TodoDoc)
 * await runtime.flush() // persist
 * await runtime.shutdown()
 * ```
 *
 * An `Exchange` composes a `Runtime` and wires the `Synchronizer` into
 * it via {@link RuntimeHooks}.
 */
export class Runtime {
  /**
   * This replica's seat, never chosen by the caller. With a store, it is the
   * seat the store issued, which an earlier writer over the same storage may
   * have held. A stored document claims it only once it has loaded, and the
   * store holds every operation issued under it (store-first), so none is
   * missing. Without a store, it is a fresh id per Runtime.
   */
  readonly seat: Seat
  /** The seat's peer id. */
  readonly peerId: string
  readonly lease: Lease

  /** The only store this Runtime holds: every call is ordered per document. */
  readonly #store: SerialStore | undefined
  /** Store-program handle — pure Mealy machine for store coordination. */
  readonly #storeHandle: ObservableHandle<StoreInput, StoreModel> | null

  /** Every document's lifecycle: the lifecycle program's model. */
  #lifecycle: LifecycleModel

  /** The live objects of every held instance, by generation. */
  readonly #instances = new Map<Generation, Instance>()

  /** Loads and local-change drains still running, which flush() and
   *  shutdown() wait for. */
  readonly #pendingWork = new Set<Promise<void>>()

  /**
   * Documents whose substrate reported local operations that the drain has
   * not reached. Drained once per microtask by
   * {@link Runtime.#drainLocalChanges}, so several signals, batches and
   * documents in one tick cost one persist and one push per document, the
   * same dirty-set-drained-later pattern the Synchronizer uses for its own
   * notifications, and drained for one document on demand by
   * {@link Runtime.publishable}. Context: jj:mrlnmlus.
   */
  readonly #dirtyLocalChanges = new Set<DocId>()
  #localChangeDrain: Promise<void> | null = null

  /** One timer per document whose failed write waits to be retried. */
  readonly #retryTimers = new Map<DocId, ReturnType<typeof setTimeout>>()

  /** Network hooks, set once by the Exchange that owns this Runtime. */
  #hooks: RuntimeHooks | undefined

  /** Tick clock infrastructure. */
  readonly #tickIntervalMs: number
  #tickTimer: ReturnType<typeof setInterval> | null = null

  constructor({
    store: given,
    onStoreError,
    lease,
    tickInterval = 1000,
  }: RuntimeParams = {}) {
    this.lease = lease ?? createLease()
    const store = given === undefined ? undefined : serialStore(given)
    this.#store = store
    this.seat = store?.seat ?? sessionSeat()
    this.peerId = this.seat.peerId
    this.#tickIntervalMs = tickInterval
    this.#lifecycle = initialLifecycle(store !== undefined)

    // ── Store-program — pure machine for store coordination ──
    if (store) {
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
            case "persist": {
              // Any write that starts replaces a scheduled retry.
              this.#cancelRetry(effect.docId)
              this.#persist(store, effect.docId, effect.write, dispatch)
              break
            }
            case "persisted": {
              this.#confirmed(effect.docId, effect.version)
              break
            }
            case "released": {
              const { docId, gen, version } = effect
              this.#step({ type: "released", docId, gen, version })
              break
            }
            case "retry": {
              this.#scheduleRetry(effect.docId, effect.afterMs)
              break
            }
            case "persist-delete": {
              const { docId } = effect
              this.#cancelRetry(docId)
              store.delete(docId).then(
                // No write-succeeded for destroy. `serialStore` runs the
                // delete after the document's calls already made, and
                // before any made later (a load of a document created again).
                () => {},
                error =>
                  error instanceof SeatLostError
                    ? dispatch({ type: "seat-lost", docId, error })
                    : errorHandler(docId, "delete", error),
              )
              break
            }
            case "rebuild": {
              this.#track(
                this.#rebuild(
                  store,
                  effect.docId,
                  effect.error,
                  dispatch,
                ).catch((error: unknown) =>
                  errorHandler(effect.docId, "rebuild", error),
                ),
              )
              break
            }
            case "seat-lost": {
              this.#cancelAllRetries()
              for (const instance of this.#instances.values()) {
                if (instance.tier === "interpret") {
                  this.#reportPersistence(instance)
                }
              }
              break
            }
            case "store-error": {
              if (effect.operation === "write") {
                this.#writeFailed(effect.docId, effect.error)
              }
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
   * Once per Runtime: a second call throws. Two Exchanges over one Runtime
   * would share its seat and sync its documents twice. So a document gets
   * `onDocInterpreted` exactly once: from the backfill below if it already
   * exists, at creation otherwise.
   *
   * Backfills `onDocInterpreted` for every interpreted document, then steps
   * `hooked`, which registers every ready one with the sync graph. This is
   * the "standalone Runtime later wrapped in an Exchange" path
   * (`new Exchange(runtime, params)`): documents created before this call
   * had no hooks to fire, so they gain `sync()` and the peer settle term,
   * and are announced. One still loading is announced when its load
   * finishes, and one whose load failed never is.
   */
  setHooks(hooks: RuntimeHooks): void {
    if (this.#hooks)
      throw new Error(
        "[runtime] this Runtime already belongs to an Exchange; two Exchanges over one Runtime would share its seat",
      )
    this.#hooks = hooks
    // Network capabilities first, so a peer term is listening before the
    // document registers with the sync graph.
    for (const instance of [...this.#instances.values()]) {
      if (instance.tier === "interpret") {
        hooks.onDocInterpreted?.(instance.readyInfo.docId, instance.ref)
      }
    }
    this.#step({ type: "hooked" })
  }

  // =========================================================================
  // PUBLIC API — Document access
  // =========================================================================

  /**
   * Gets (or creates) an interpreted document.
   *
   * Creates the substrate + ref and begins hydration (if a store is
   * configured). Returns the ref synchronously. If a store is configured,
   * hydration completes asynchronously — the ref starts empty and the
   * changefeed fires when stored data is merged.
   *
   * Multiple calls with the same `docId` return the same instance. Calling
   * with a schema that cannot read what is already there throws, naming the
   * axis that disagrees. A replicate document is promoted once it has loaded;
   * one still loading, or whose load failed, throws.
   *
   * @param docId - The document ID
   * @param bound - A BoundSchema created by `bind()`
   * @returns A full-stack ref with the local substrate
   */
  get: RuntimeGet = (docId, bound) =>
    this.createInterpretDoc(docId, bound, "create") as never

  /**
   * Register a document for headless replication — no schema, no ref.
   *
   * The document participates in the sync graph via a bare `Replica<V>`,
   * enabling version tracking and state accumulation without interpretation.
   * Throws for a document this Runtime already holds, in either tier.
   */
  replicate(
    docId: DocId,
    replicaFactory: ReplicaFactoryLike,
    syncMode: SyncMode,
    schemaHash: string,
  ): void {
    this.#throwing({
      type: "replicate",
      docId,
      replicaFactory,
      syncMode,
      schemaHash,
    })
  }

  /**
   * Check if a document exists in the runtime: held in either tier,
   * deferred, or unloaded.
   */
  has(docId: DocId): boolean {
    return this.#lifecycle.docs.has(docId)
  }

  /**
   * Has this document finished loading from storage?
   *
   * The docId-keyed twin of `hydrated(ref)` in `settle.ts`, and the same
   * answer. Both exist because not every document has a ref to ask about:
   * one held in `replicate` mode is a bare replica with no schema and no
   * interpreter stack, so the ref-keyed form has nothing to key on. The
   * parameter type says which surface you are using.
   *
   * `false` while the load runs and after it fails: a failed read is not an
   * empty document. An unknown document reports `true`. There is nothing to
   * load, so the load is trivially finished — the same answer `hydrated(ref)`
   * gives a document with no store behind it, and it saves every caller an
   * existence check.
   */
  hydrated(docId: DocId): boolean {
    return hydrationOf(this.#lifecycle, docId).status === "loaded"
  }

  /**
   * Resolve once this document's stored data has finished loading; reject if
   * the load failed, or with its `DocumentClosedError` if the document closed
   * while it loaded.
   *
   * No timeout, for the reason `whenHydrated(ref)` gives: a slow disk is a
   * local fault we can observe, and abandoning the wait would mean proceeding
   * as though the document were empty. That is how defaults get written over
   * data we merely failed to read.
   */
  whenHydrated(docId: DocId): Promise<void> {
    const hydration = hydrationOf(this.#lifecycle, docId)
    if (hydration.status === "loaded") return Promise.resolve()
    if (hydration.status === "failed") return Promise.reject(hydration.error)
    // Pending: an instance is loading, and its observers hear how it ends.
    const instance = this.#current(docId)
    if (instance === undefined) return Promise.resolve()
    const { observers } = instance
    return new Promise<void>((resolve, reject) => {
      const observer = ({ hydration }: Observed): void => {
        if (hydration.status === "pending") return
        observers.delete(observer)
        if (hydration.status === "failed") reject(hydration.error)
        else resolve()
      }
      observers.add(observer)
    })
  }

  /**
   * The live objects of the instance held under `docId`, if one is.
   */
  instanceOf(docId: DocId): Readonly<Instance> | undefined {
    return this.#current(docId)
  }

  /**
   * The lifecycle the Runtime records for `docId`: its phase, tier,
   * generation and metadata, or `undefined` for a document it knows nothing
   * of.
   */
  lifecycleOf(docId: DocId): Lifecycle | undefined {
    return this.#lifecycle.docs.get(docId)
  }

  /**
   * Every document held in memory in interpret mode, including one still
   * loading or unloading.
   */
  documentIds(): ReadonlySet<DocId> {
    const result = new Set<DocId>()
    for (const [docId, entry] of this.#lifecycle.docs) {
      if (isHeld(entry) && entry.spec.tier === "interpret") result.add(docId)
    }
    return result
  }

  /**
   * The set of deferred document IDs.
   */
  get deferred(): ReadonlySet<DocId> {
    return deferredIds(this.#lifecycle)
  }

  /**
   * Schema hash for a document, if it is interpreted here.
   */
  getDocSchemaHash(docId: DocId): string | undefined {
    const instance = this.#current(docId)
    return instance?.tier === "interpret"
      ? instance.bound.schemaHash
      : undefined
  }

  // =========================================================================
  // PUBLIC API — Document lifecycle
  // =========================================================================

  /**
   * Destroy a document — close it, remove it, and delete it from the store.
   *
   * Closing releases its native document: a ref the application still holds
   * reads its last value, and its writes throw `DocumentClosedError` with
   * reason `"destroyed"`.
   *
   * Fires {@link RuntimeHooks.onDocDestroyed} so the Exchange can broadcast
   * `dismiss` to peers and remove the doc from the sync graph.
   *
   * The store delete is skipped only for a document known never to have been
   * stored (see the program's `destroy` row).
   */
  destroy(docId: DocId): void {
    this.#throwing({ type: "destroy", docId })
  }

  /**
   * Suspend a document — leave the sync graph but keep all local state.
   *
   * Fires {@link RuntimeHooks.onDocSuspended} so the Exchange can take it out
   * of the sync graph. Suspending a suspended document does nothing; one not
   * held here, or unloading, throws.
   */
  suspend(docId: DocId): void {
    this.#throwing({ type: "suspend", docId })
  }

  /**
   * Resume a suspended document. Throws for one that is not suspended.
   */
  resume(docId: DocId): void {
    this.#throwing({ type: "resume", docId })
  }

  /**
   * Unload a document: release its memory and keep it in the store, so that
   * `get` or `open` loads it again, in the tier it had and suspended if it
   * was.
   *
   * At once, its writes are refused with `DocumentClosedError` (reason
   * `"unloaded"`); it still sends what peers are owed, and takes nothing in. Once the store holds all of it, its
   * ref closes and it leaves the sync graph; then its replica is disposed. A
   * `get` or `open` before the store holds all of it cancels the unload and
   * returns the same ref; one after loads it again.
   *
   * Throws for a document not held, still loading, whose load failed, or not
   * stored (no store, or a transient sync mode). Does nothing for one already
   * unloading or unloaded.
   */
  unload(docId: DocId): void {
    this.#throwing({ type: "unload", docId })
  }

  /**
   * Record that a peer announced a document this Runtime holds nothing of.
   * A document it holds stays as it is.
   *
   * @internal — used by the Exchange for documents it defers.
   */
  defer(docId: DocId): void {
    this.#throwing({ type: "defer", docId })
  }

  /**
   * Step a request, and return its refusal rather than throw it.
   *
   * @internal — for the Exchange's doors that skip a refusal: `onEnsureDoc`,
   * `registerSchema`'s sweep, and a peer's request for an unloaded document
   * (`reload`).
   */
  request(input: LifecycleRequest): Refusal | undefined {
    const stepped = this.#step(input)
    return "refusal" in stepped ? stepped.refusal : undefined
  }

  /** Step a request, throw its refusal, and return what it built. */
  #throwing(input: LifecycleRequest): Instance | undefined {
    const stepped = this.#step(input)
    if ("refusal" in stepped) throw refusalError(stepped.refusal)
    return stepped.built
  }

  // =========================================================================
  // PUBLIC API — Store coordination
  // =========================================================================

  /**
   * Tell the store program a document may have moved past what the store
   * holds.
   *
   * Two callers, one per cause. The Exchange calls it when the Synchronizer
   * reports that the network advanced the document, and this Runtime's own
   * drain calls it for local changes (see {@link Runtime.#drainLocalChanges}).
   * Calling it redundantly costs nothing: a request that arrives while a
   * write is in flight collapses into the one write owed after it, and that
   * write finds nothing new and touches no store.
   *
   * Carries a `docId` and nothing else. The store program's executor
   * resolves the document's current instance when a write starts, so the
   * network shell never needs local bookkeeping to make the call.
   */
  onStateAdvanced(docId: DocId): void {
    this.#storeHandle?.dispatch({ type: "state-advanced", docId })
  }

  /**
   * Replace a replicate-mode document's replica with one built from an
   * entirety (`replicaFromEntirety`), and dispose the one it replaces. Throws
   * what taking the entirety in throws.
   *
   * The Synchronizer calls this when a reset means the incoming image is not
   * a continuation of what the relay holds (see the replicate arm of its
   * reset branch). It is the Runtime's to do because the Runtime owns the
   * document's record: the Synchronizer reads the same object, so it sees
   * the new replica, and so do persistence and promotion. The replaced
   * replica is disposed.
   */
  rebuildReplica(docId: DocId, payload: SubstratePayload): void {
    const instance = this.#current(docId)
    if (instance?.tier !== "replicate") {
      throw new Error(
        `[runtime] cannot rebuild '${docId}': not a replicate-mode document`,
      )
    }
    const { readyInfo } = instance
    const replaced = readyInfo.replica
    readyInfo.replica = replicaFromEntirety(readyInfo.replicaFactory, payload)
    replaced.dispose("disposed")
  }

  /**
   * Compact a document: trim its history in memory to `trimTo`, or entirely
   * without one, as far as its replica can; then take in what the store
   * holds of it and replace what was read with the whole document
   * ({@link Runtime.#compact}). Resolves once no write is in flight for it,
   * which a `destroy` makes true at once.
   *
   * `trimTo` is what the network allows: the Exchange passes the least common
   * version of the peers it keeps up to date, so none is stranded behind the
   * trimmed base. A live CRDT document trims nothing, since it cannot swap
   * the native document its callers hold; its storage is compacted all the
   * same. Without a store, only the trim happens.
   */
  async compact(docId: DocId, trimTo?: Version): Promise<void> {
    const instance = this.#current(docId)
    if (instance === undefined) return
    const { replica } = instance.readyInfo
    replica.advance(trimTo ?? replica.version())

    if (!this.#storeHandle) return
    this.#storeHandle.dispatch({ type: "compact", docId })
    await this.#storeHandle.waitForState((s: StoreModel) => {
      const phase = s.docs.get(docId)
      return !phase || isSettled(phase)
    })
  }

  /**
   * Perform one write the store program asked for, and report how it went.
   *
   * The replica is read here, when the write starts, not when it was
   * requested. A write owed behind another therefore diffs from the version
   * that one confirmed, so no record repeats another's operations. A
   * compaction reads the store first ({@link Runtime.#compact}).
   *
   * Whether the write is authored is decided here too (see
   * {@link Runtime.#authored}). A failure is reported by what it means: a
   * lost seat ends every write of the store, a refused writer ends this
   * document's authoring, and anything else is retried.
   */
  #persist(
    store: Store,
    docId: DocId,
    write: Write,
    dispatch: (msg: StoreInput) => void,
  ): void {
    const failed = (error: unknown): void =>
      dispatch(
        error instanceof SeatLostError
          ? { type: "seat-lost", docId, error }
          : error instanceof WriterRefusedError
            ? { type: "writer-refused", docId, error }
            : { type: "write-failed", docId, error },
      )
    const options = this.#authored(docId)

    if (write.kind === "compact") {
      this.#compact(store, docId, options).then(
        version => dispatch({ type: "write-succeeded", docId, version }),
        failed,
      )
      return
    }

    let prepared: Prepared
    try {
      prepared = this.#prepareWrite(docId, write)
    } catch (error) {
      failed(error)
      return
    }
    const { version } = prepared
    storeWrite(store, docId, prepared, null, options).then(
      () => dispatch({ type: "write-succeeded", docId, version }),
      failed,
    )
  }

  /**
   * A write is authored when it carries this seat's own operations on a
   * serialized document: own writes the store has not confirmed, which is
   * exactly while `ownHigh` is set. It claims the document on a pooled store.
   * A write that only persists what the network sent never claims, and
   * neither does any write of a refused document: its own operations were
   * discarded when it was rebuilt.
   */
  #authored(docId: DocId): WriteOptions {
    const instance = this.#current(docId)
    return {
      authored:
        instance?.tier === "interpret" &&
        instance.readyInfo.syncMode.writerModel === "serialized" &&
        instance.publication.ownHigh !== undefined &&
        instance.refusals.seat() === undefined,
    }
  }

  /**
   * Compact a document, and resolve with the version the store then holds.
   *
   * 1. Read the store's mark, then every entry.
   * 2. Stop if the instance held when the read began is no longer current
   *    (its generation differs): nothing is merged into, or pushed from, a
   *    document that is gone. The store orders calls, not this whole
   *    compaction (`serialStore`), so a destroy's delete may run between the
   *    read and the write; this check is what keeps the write from storing
   *    the document again.
   * 3. Take what was read into the live replica, toward its own lineage, or
   *    toward the latest stored one while it is still at genesis, since
   *    joining a lineage from genesis is not a crossing. Records other
   *    instances appended are then held here. A merge that moved the replica
   *    is an advance the Synchronizer must hear of, or the writes of an
   *    instance that stored them and crashed before sending would never
   *    leave.
   * 4. Write the whole document, deleting the records at or before the mark.
   *    Everything deleted was read and is now held; anything appended after
   *    the read is after the mark and survives.
   *
   * If the replica could not take everything in, deleting would lose it. The
   * compaction then appends what a `since` write would, and deletes nothing:
   * compaction only saves space, and a stray record must not surface as a
   * failed write on every compaction while every append succeeds.
   */
  async #compact(
    store: Store,
    docId: DocId,
    options: WriteOptions,
  ): Promise<string> {
    const held = currentGen(this.#lifecycle, docId)
    const mark = await store.mark(docId)
    const entries: StoredEntry[] = []
    for await (const record of store.loadAll(docId)) {
      if (record.kind === "entry") entries.push(record)
    }

    const instance = this.#current(docId)
    if (instance === undefined || currentGen(this.#lifecycle, docId) !== held) {
      throw new Error(`[runtime] cannot compact '${docId}': document not held`)
    }
    const { replica, replicaFactory } = instance.readyInfo
    const before = replica.version()
    const toward =
      before.lineage === DEFAULT_LINEAGE
        ? latestStoredLineage(replicaFactory, entries)
        : before.lineage
    const { untaken } = takeStoredEntries(
      replica,
      replicaFactory,
      entries,
      toward,
    )
    if (replica.version().serialize() !== before.serialize()) {
      this.#hooks?.onDocAdvanced?.(docId)
    }

    if (untaken.length > 0) {
      console.warn(
        `[runtime] compaction of '${docId}' could not take in the stored ` +
          `entries at ${untaken.join(", ")}; appending instead`,
      )
      const phase = this.#storeHandle?.getState().docs.get(docId)
      const confirmed =
        phase === undefined ? undefined : confirmedVersion(phase)
      const write: Write =
        confirmed === undefined
          ? { kind: "register" }
          : { kind: "since", version: confirmed }
      const prepared = this.#prepareWrite(docId, write)
      await storeWrite(store, docId, prepared, null, options)
      return prepared.version
    }

    const prepared = this.#prepareWrite(docId, { kind: "compact" })
    await storeWrite(store, docId, prepared, mark, options)
    return prepared.version
  }

  /**
   * What a write stores, and the version it brings the store to.
   *
   * Reads the replica now, when the write starts.
   *
   * Throws if the document is not held here. The store program only writes
   * documents this Runtime registered, and `destroy` removes both together,
   * so that is a broken invariant; it is reported as a failed write rather
   * than thrown through the dispatcher.
   */
  #prepareWrite(docId: DocId, write: Write): Prepared {
    const instance = this.#current(docId)
    if (instance === undefined) {
      throw new Error(`[runtime] cannot write '${docId}': document not held`)
    }
    // Commit, read the version, export: otherwise the export commits a
    // pending native write here, its signal fires from inside this executor,
    // and the drain asks for one more write that finds nothing new.
    if (instance.tier === "interpret")
      instance.readyInfo.replica.commitPending()
    const { replica, replicaFactory, syncMode, schemaHash } = instance.readyInfo
    const current = replica.version()
    const version = current.serialize()

    switch (write.kind) {
      case "register":
      case "compact":
        return {
          kind: "whole",
          records: [
            {
              kind: "meta",
              meta: {
                replicaType: replicaFactory.replicaType,
                syncMode,
                schemaHash,
              },
            },
            { kind: "entry", payload: replica.exportEntirety(), version },
          ],
          version,
        }
      case "since": {
        const since = replicaFactory.parseVersion(write.version)
        // `compare` is only meaningful within one lineage.
        if (
          current.lineage === since.lineage &&
          current.compare(since) === "equal"
        ) {
          return { kind: "none", version: write.version }
        }
        // `exportSince` answers `null` both for "nothing new" and for "cannot:
        // `since` is behind the trimmed base". The second happens once a
        // compaction has advanced the base past what the store confirmed, and
        // reading it as the first would drop every change since. So an
        // advanced replica always writes something: the delta if it can,
        // otherwise the whole document, appended.
        const payload = replica.exportSince(since) ?? replica.exportEntirety()
        return {
          kind: "delta",
          record: { kind: "entry", payload, version },
          version,
        }
      }
    }
  }

  // =========================================================================
  // PUBLIC API — Lifecycle
  // =========================================================================

  /**
   * Await all pending store operations.
   */
  async flush(): Promise<void> {
    await this.#quiesce()
  }

  /**
   * Gracefully shut down: flush all pending operations, close every document
   * (reason `"disposed"`), close the store, stop the tick clock.
   */
  async shutdown(): Promise<void> {
    await this.#quiesce()
    this.#storeHandle?.dispose()
    this.#stopTick()
    this.#cancelAllRetries()
    this.#step({ type: "close-all", reason: "disposed" })
    await this.#store?.close()
  }

  /**
   * Synchronous teardown — closes every document (reason `"disposed"`) and
   * stops everything without awaiting pending I/O. Use {@link shutdown} for
   * graceful teardown.
   */
  reset(): void {
    this.#stopTick()
    this.#cancelAllRetries()
    this.#storeHandle?.dispose()
    this.#step({ type: "close-all", reason: "disposed" })
  }

  // =========================================================================
  // INTERNAL — Document creation (non-generic, for Exchange delegation)
  // =========================================================================

  /**
   * Get or open an interpreted document — non-generic internal path.
   *
   * {@link get} without the generic type parameters, avoiding TS2589 when
   * called from non-generic contexts (the Exchange's doors). The public
   * {@link get} delegates here with an `as never` cast to preserve precise
   * types. `kind` is the request's intent: an `open` that can load nothing
   * builds nothing, and returns `undefined`. Throws the step's refusal.
   *
   * @internal
   */
  createInterpretDoc(
    docId: DocId,
    bound: BoundSchema,
    kind: Intent["kind"],
  ): any {
    // What this step built, even if a nested step has closed it since: the
    // caller then holds a closed ref. Otherwise the instance already held.
    const instance =
      this.#throwing({ type: "get", docId, bound, intent: kind }) ??
      this.#current(docId)
    return instance?.tier === "interpret" ? instance.ref : undefined
  }

  // =========================================================================
  // INTERNAL — The lifecycle program's shell
  // =========================================================================

  /**
   * Run one step of the lifecycle program, as a transaction:
   * 1. `update` computes the next model and its effects. Those that can fail
   *    (`refuse`, `build`) lead the list.
   * 2. A refusal is returned, and nothing is committed. Otherwise the step
   *    returns the instance it built, if any.
   * 3. Each `build` constructs its instance. A throw disposes what this step
   *    built and propagates: nothing is committed, and the generation it was
   *    issued is never used.
   * 4. The model is committed, and the built instances join `#instances`. A
   *    promotion's build took the promoted replica, so that instance leaves
   *    without being disposed.
   * 5. The remaining effects run in order (`#execute`).
   * 6. The observers of each document whose observed values changed (its
   *    load, its lifecycle refusal) are told.
   *
   * Synchronous, not on a `@kyneta/machine` runtime: both of those queue a
   * re-entrant dispatch, and a door reached from inside an effect
   * (`onDocReady` → `onEnsureDoc` → `get`) must return its ref. Such a step
   * runs against the committed model, and an outer effect it made stale finds
   * no instance under its generation and is skipped. Nothing between `update`
   * and the commit calls a hook, so no door can step in between.
   */
  #step(input: LifecycleInput): Stepped {
    const before = this.#lifecycle
    const [next, ...effects] = lifecycleProgram.update(input, before)

    const built = new Map<Generation, Instance>()
    let promoted: Generation | undefined
    try {
      for (const effect of effects) {
        if (effect.type === "refuse") return { refusal: effect.refusal }
        if (effect.type !== "build") break
        built.set(
          effect.gen,
          this.#build(effect.docId, effect.gen, effect.spec),
        )
        if (
          effect.spec.tier === "interpret" &&
          typeof effect.spec.from === "object"
        ) {
          promoted = effect.spec.from.promote
        }
      }
    } catch (error) {
      for (const instance of built.values()) {
        instance.readyInfo.replica.dispose("disposed")
      }
      throw error
    }

    this.#lifecycle = next
    for (const [gen, instance] of built) this.#instances.set(gen, instance)
    if (promoted !== undefined) this.#instances.delete(promoted)

    for (const effect of effects) this.#execute(effect)
    this.#notify(input, before)
    return { built: built.values().next().value }
  }

  /** The instance held under `docId`, by the model's current generation. */
  #current(docId: DocId): Instance | undefined {
    const gen = currentGen(this.#lifecycle, docId)
    return gen === undefined ? undefined : this.#instances.get(gen)
  }

  /**
   * Construct the live objects a `build` names. Calls no hook, so nothing
   * here can step the program.
   */
  #build(docId: DocId, gen: Generation, spec: BuildSpec): Instance {
    if (spec.tier === "interpret") return this.#buildInterpret(docId, gen, spec)
    const readyInfo: ReplicateReadyInfo = {
      docId,
      mode: "replicate",
      replica: spec.replicaFactory.createEmpty(),
      replicaFactory: spec.replicaFactory,
      syncMode: spec.syncMode,
      schemaHash: spec.schemaHash,
    }
    return { tier: "replicate", readyInfo, observers: new Set() }
  }

  /**
   * Construct an interpreted instance: its substrate, ref, refusals,
   * publication record and local terms.
   *
   * A promotion's build is transactional up to `upgradeReplica`'s take, and
   * no further. Everything that depends on the input runs before it: the
   * factory, the replica's origin (`upgrade` checks it before it takes), and
   * the schema's fit, which `update` already decided. `createRef` needs the
   * substrate, so it cannot run first; after the take, only a bug can throw.
   * Should one, nothing is committed, and the model records a ready replica
   * over a closed one, whose every use throws `DocumentClosedError`.
   */
  #buildInterpret(
    docId: DocId,
    gen: Generation,
    spec: Extract<BuildSpec, { tier: "interpret" }>,
  ): InterpretInstance {
    const { bound, from } = spec
    const factory = bound.factory({
      peerId: this.peerId,
      binding: bound.identityBinding,
    })

    // A document that will hydrate is about to import operations this peer
    // wrote in an earlier session, so it takes the deferred-identity path:
    // its `adopt` effect claims identity once that import finishes. One that
    // will not hydrate has nothing to import, so `upgrade`'s immediate claim
    // is correct and `adopt` is a no-op.
    //
    // Whether deferring changes anything is a per-backend fact, and not one
    // this file should hold: `beginHydration` puts the question to the factory
    // and falls back to the safe answer for backends that do not care.
    //
    // Otherwise a replica is upgraded, which claims at once: a promoted
    // relay's, whose import has already finished, or an empty one, with
    // nothing to import. Making it defer would leave the identity unclaimed
    // with nothing left to claim it. `upgradeReplica` closes the replica,
    // which `upgrade` took or copied. Promoting means giving the replica a
    // schema, not building a new document beside it: a fresh substrate would
    // replace the accumulated state, with no error and no event.
    const { substrate, ...authorship } =
      from === "hydration"
        ? beginHydration(factory, bound.schema)
        : {
            substrate: upgradeReplica(
              factory,
              from === "empty"
                ? factory.replica.createEmpty()
                : this.#promotedReplica(from.promote),
              bound.schema,
            ),
            ...NO_AUTHORSHIP,
          }

    try {
      const observers: Observers = new Set()
      const publication = createPublication()

      // The terms record, built before the ref so that its owner refusal can
      // follow the record's network refusal, and filed under the ref once
      // the ref exists. The local terms are the storage term, which joins
      // this document's settle conjunction, and the persistence term. They
      // exist from the start rather than once the load finishes, because the
      // point of the storage term is to be observable *while* still pending:
      // that is what stops a caller concluding "empty" from a document that
      // simply has not finished loading. Each follows a live feed over this
      // instance until it closes; the persistence term reads `instance` only
      // when read, after it is assigned below.
      const terms = buildLocalTerms({
        syncMode: bound.syncMode,
        hydration: settableFeed<Hydration>(
          signalFeed(
            () => this.#hydrationFor(docId, gen),
            onChange => observe(observers, onChange),
          ),
        ),
        persistence: settableFeed<Persistence>(
          signalFeed(
            () => ({
              persisted: this.#persisted(instance),
              error: this.#persistenceError(instance),
            }),
            onChange => {
              publication.listeners.add(onChange)
              return () => publication.listeners.delete(onChange)
            },
          ),
        ),
      })

      // Who refuses its authored writes besides the substrate, first answer
      // first: its lifecycle, while it unloads or closes; another seat of the
      // storage, which may write it (`#refuse`); and the network's policy
      // refusal, a network term the Exchange attaches (`Policy.canWrite`).
      const unloaded = new DocumentClosedError("unloaded")
      const refusals: Refusals = {
        lifecycle: settableFeed<WriteRefusal | undefined>(
          signalFeed(
            () =>
              unloadingOf(this.#lifecycle, docId, gen) ? unloaded : undefined,
            onChange => observe(observers, onChange),
          ),
        ),
        seat: settableFeed<WriteRefusal | undefined>(undefined),
      }
      const ref: any = createRef(bound.schema, substrate, {
        lease: this.lease,
        refusal: firstDefined(
          refusals.lifecycle,
          refusals.seat,
          networkTermFeed(terms, networkRefusal, undefined),
        ),
      })
      const readyInfo: InterpretReadyInfo = {
        docId,
        mode: "interpret",
        replica: substrate,
        replicaFactory: factory.replica,
        syncMode: bound.syncMode,
        schemaHash: bound.schemaHash,
        supportedHashes: [...bound.supportedHashes],
      }
      const instance: InterpretInstance = {
        tier: "interpret",
        ref,
        bound,
        readyInfo,
        authorship,
        refusals,
        publication,
        unloaded,
        observers,
        unwire: NOTHING_WIRED,
      }
      registerTerms(ref, terms)
      return instance
    } catch (error) {
      substrate.dispose("disposed")
      throw error
    }
  }

  /** The replica a promotion upgrades: the ready replica of `gen`. */
  #promotedReplica(gen: Generation): ReplicaLike {
    const instance = this.#instances.get(gen)
    if (instance?.tier !== "replicate") {
      throw new Error(`[runtime] no replica to promote under generation ${gen}`)
    }
    return instance.readyInfo.replica
  }

  /**
   * The hydration term's live value for the instance of `gen`. Read only
   * while that instance is current: its term is set to a constant when it
   * closes, and nothing reads it before its step commits.
   */
  #hydrationFor(docId: DocId, gen: Generation): Hydration {
    return currentGen(this.#lifecycle, docId) === gen
      ? hydrationOf(this.#lifecycle, docId)
      : { status: "pending" }
  }

  /**
   * Execute one effect after the commit. An effect that names a generation
   * runs against that instance, and does nothing if it is gone: a nested step
   * closed or replaced it.
   */
  #execute(effect: LifecycleEffect): void {
    switch (effect.type) {
      case "refuse":
      case "build":
        return
      case "store":
        this.#storeHandle?.dispatch(effect.input)
        return
      case "notify": {
        const hooks = this.#hooks
        if (effect.hook === "destroyed") hooks?.onDocDestroyed?.(effect.docId)
        else if (effect.hook === "suspended") {
          hooks?.onDocSuspended?.(effect.docId)
        } else hooks?.onDocResumed?.(effect.docId)
        return
      }
      case "leaving":
        this.#hooks?.onDocLeaving?.(effect.docId, effect.on)
        return
    }

    const instance = this.#instances.get(effect.gen)
    if (instance === undefined) return
    switch (effect.type) {
      case "interpreted":
        // The network terms attach here, before the document can register,
        // so what is attached observes its registration with the sync graph.
        if (instance.tier === "interpret") {
          this.#hooks?.onDocInterpreted?.(effect.docId, instance.ref)
        }
        return
      case "load":
        this.#load(effect.docId, effect.gen, instance)
        return
      case "adopt":
        if (instance.tier === "interpret") this.#adopt(instance, effect.writer)
        return
      case "register":
        this.#hooks?.onDocReady?.(instance.readyInfo, {
          suspended: effect.suspended,
        })
        return
      case "wire":
        if (instance.tier === "interpret") {
          instance.unwire = this.#wire(effect.docId, instance)
        }
        return
      case "drain":
        this.#drainLocal(effect.docId)
        return
      case "leave": {
        const { docId, gen } = effect
        const left = (): void => {
          this.#step({ type: "left", docId, gen })
        }
        const unload = this.#hooks?.onDocUnload
        if (unload === undefined) left()
        else unload(docId, left)
        return
      }
      case "close":
        this.#close(instance, effect.reason, effect.hydration)
        return
      case "dispose":
        this.#dispose(instance, effect.gen, effect.reason)
        return
    }
  }

  /**
   * Load the instance of `gen` from the store, and report how it went under
   * that generation: a load that returns after its document closed, or was
   * replaced, is ignored by `update`.
   */
  #load(docId: DocId, gen: Generation, instance: Instance): void {
    this.#track(
      this.#hydrate(instance.readyInfo).then(
        ({ outcome, writer }) => {
          this.#step({ type: "loaded", docId, gen, outcome, writer })
        },
        (error: unknown) => {
          this.#step({ type: "load-failed", docId, gen, error })
        },
      ),
    )
  }

  /**
   * Claim this peer's identity (Yjs, Loro), and lift plain's loading
   * refusal. A serialized document another seat of the storage writes is
   * refused instead (its seat refusal is set), so a listener's write on the
   * loaded signal throws.
   */
  #adopt(instance: InterpretInstance, writer: PeerId | null): void {
    instance.authorship.adopt()
    if (
      instance.readyInfo.syncMode.writerModel === "serialized" &&
      writer !== null &&
      writer !== this.peerId
    ) {
      this.#refuse(
        instance,
        new WriterRefusedError(instance.readyInfo.docId, writer),
      )
    }
  }

  /**
   * End an instance's ref, in this order:
   * 1. Close its hydration once (`closedHydration`): a load still pending
   *    fails with the close error, and an answer already given stands.
   * 2. Unwire it. Its changeset subscription lives in the context's
   *    subscriber trie, which a held ref keeps, and closes over this Runtime.
   * 3. Fix its lifecycle refusal at the close error (for an unload, the one
   *    it already answered), which holds until the replica is disposed and
   *    its slot refuses; then close its terms (`closeTerms`) with that
   *    hydration: each keeps the answer it had, and none reaches this
   *    Runtime or the Exchange any more. The network's policy refusal closes
   *    to none, which lets go of the Exchange's Governance, and the document
   *    refuses writes throughout.
   * 4. Tell every observer those values, so `whenHydrated(ref)` and
   *    `whenHydrated(docId)` settle with the same error object.
   *
   * The replica is left to `#dispose`: an unload closes at its release and
   * disposes once it has left the sync graph, which may still read it.
   */
  #close(instance: Instance, reason: ClosedReason, before: Hydration): void {
    const error = new DocumentClosedError(reason)
    const hydration = closedHydration(before, error)
    let refusal: WriteRefusal | undefined
    if (instance.tier === "interpret") {
      instance.unwire()
      // Fixed first: a term's subscriber may write as it hears the close.
      refusal = reason === "unloaded" ? instance.unloaded : error
      instance.refusals.lifecycle.set(refusal)
      const terms = termsOf(instance.ref)
      if (terms !== undefined) closeTerms(terms, error, hydration)
    }
    for (const observer of [...instance.observers]) {
      observer({ hydration, refusal })
    }
    instance.observers.clear()
  }

  /**
   * Release an instance's memory: dispose its replica, which releases the
   * native document, and delete the instance. A held ref reads its last
   * value, and every write throws `DocumentClosedError`.
   */
  #dispose(instance: Instance, gen: Generation, reason: ClosedReason): void {
    instance.readyInfo.replica.dispose(reason)
    this.#instances.delete(gen)
  }

  /**
   * Tell the observers of each document whose observed values the step
   * changed. The step names one document, or for `hooked` and `close-all`
   * every one. Compared by value, so a step that only registers a document
   * wakes nobody.
   */
  #notify(input: LifecycleInput, before: LifecycleModel): void {
    const ids =
      "docId" in input
        ? [input.docId]
        : new Set([...before.docs.keys(), ...this.#lifecycle.docs.keys()])
    for (const docId of ids) {
      const gen = currentGen(this.#lifecycle, docId)
      const instance = gen === undefined ? undefined : this.#instances.get(gen)
      if (gen === undefined || instance === undefined) continue
      const now = observedIn(this.#lifecycle, docId, gen, instance)
      if (sameObserved(observedIn(before, docId, gen, instance), now)) continue
      for (const observer of [...instance.observers]) observer(now)
    }
  }

  /**
   * Wire an interpreted document, and return what undoes it.
   *
   * - The substrate's local-update signal marks the document dirty. It fires
   *   for every local write, whether through Kyneta or directly on the native
   *   document, so it decides what leaves the process; a changeset can't,
   *   because a native write outside the schema produces none.
   * - Changesets go to the observation hook and nowhere else.
   *
   * Nothing needs to have been heard before this point: whatever was written
   * while the document loaded is owed to the store by `hydrated`, and
   * `register`, once hooks are set, has just published the live version to
   * peers.
   */
  #wire(docId: DocId, instance: InterpretInstance): () => void {
    const stopLocalUpdates = instance.readyInfo.replica.subscribeLocalUpdates(
      () => this.#markLocalChangeDirty(docId),
    )
    const stopChangesets = subscribe(instance.ref, changeset =>
      this.#hooks?.onDocChangeset?.(docId, changeset),
    )
    return () => {
      stopLocalUpdates()
      stopChangesets()
    }
  }

  /**
   * Mark `docId` as having local operations that have not left the process,
   * and schedule one microtask to drain the whole dirty set.
   *
   * The signal fires synchronously, sometimes inside a native commit or a
   * merge, and sometimes several times for one batch. Deferring keeps the
   * store program and the Synchronizer out of those callbacks, and turns any
   * number of signals, batches and documents in one tick into one persist
   * and one push per document.
   */
  #markLocalChangeDirty(docId: DocId): void {
    this.#dirtyLocalChanges.add(docId)
    const instance = this.#current(docId)
    if (instance?.tier === "interpret") this.#reportPersistence(instance)
    if (this.#localChangeDrain) return // Already scheduled this tick.
    this.#localChangeDrain = Promise.resolve().then(() => {
      this.#localChangeDrain = null
      this.#drainLocalChanges()
    })
    this.#track(this.#localChangeDrain)
  }

  /**
   * Drain each dirty document once.
   *
   * The set is snapshotted first, so a local write made during the drain
   * schedules a fresh one rather than being lost.
   */
  #drainLocalChanges(): void {
    for (const docId of [...this.#dirtyLocalChanges]) this.#drainLocal(docId)
  }

  /**
   * Bring one document's own writes into view, and if it has any, request
   * persistence and a push.
   *
   * First commits whatever the native document holds uncommitted, whose
   * signal marks the document dirty. Then, if it is dirty:
   * - records `ownHigh`, the version the store must confirm before the
   *   document may leave the process again (with a store);
   * - requests persistence;
   * - asks for a push, which {@link Runtime.publishable} holds until the store
   *   has confirmed.
   *
   * Runs from the microtask drain for every dirty document, and on demand
   * from `publishable`, which is why it is per document. A document closed
   * since it was marked is dropped.
   */
  #drainLocal(docId: DocId): void {
    const instance = this.#current(docId)
    if (instance?.tier !== "interpret") {
      this.#dirtyLocalChanges.delete(docId)
      return
    }
    const { replica, syncMode } = instance.readyInfo
    replica.commitPending()
    if (!this.#dirtyLocalChanges.delete(docId)) return
    if (storedOf(this.#lifecycle, syncMode)) {
      instance.publication.ownHigh = replica.version()
      this.#reportPersistence(instance)
    }
    this.onStateAdvanced(docId)
    this.#hooks?.onDocAdvanced?.(docId)
  }

  // =========================================================================
  // INTERNAL — Pending-work tracking
  // =========================================================================

  #track(op: Promise<void>): void {
    this.#pendingWork.add(op)
    op.finally(() => {
      this.#pendingWork.delete(op)
    })
  }

  /**
   * Wait until no tracked work is running, every document is settled, and no
   * store call is queued (a destroy's delete settles nothing in the store
   * program, so only the store's queue shows it). Each can start another: a
   * write that settles can start a rebuild, which hands the document back to
   * the store program with a write owed.
   */
  async #quiesce(): Promise<void> {
    for (;;) {
      await Promise.all(this.#pendingWork)
      await this.#storeHandle?.waitForState(allDocsSettled)
      await this.#store?.idle()
      if (this.#pendingWork.size === 0) return
    }
  }

  // =========================================================================
  // INTERNAL — Storage: hydrate
  // =========================================================================

  /**
   * Async hydration — loads stored entries, merges them into the replica,
   * and returns what it found; the lifecycle program's `loaded` row decides
   * from that. Its reads go through `serialStore`, so a load after a destroy
   * reads after the delete.
   *
   * Storage I/O only — this method never fires `onDocReady`. It has no
   * knowledge of hooks at all, which makes it structurally impossible to
   * accidentally re-run hydration (and therefore double-`merge()` stored
   * ops) while trying to announce an already-hydrated document. Context:
   * jj:mrlnmlus.
   *
   * For interpret mode with structural clientID 0, an upgraded empty replica
   * produces structural ops at `(0, 0..N)` — identical to what any stored
   * state has. Merging stored data deduplicates the structural ops and
   * applies application ops. No separate replica, no upgrade step.
   */
  async #hydrate(readyInfo: DocReadyInfo): Promise<Loaded> {
    const { docId, replica, replicaFactory } = readyInfo
    const store = this.#store
    if (!store) return NOTHING_LOADED
    // Read with the records, whatever they turn out to hold: a store can
    // record a writer for a document none of whose entries this replica takes.
    const writer = await store.writerOf(docId)
    const nothingStored: Loaded = { outcome: { kind: "empty" }, writer }

    // A read that throws is a failed load, not an empty document: reporting
    // it as empty is how defaults get written over data that exists.
    const existing = await store.currentMeta(docId)
    if (!existing) return nothingStored
    if (
      !replicaTypesCompatible(existing.replicaType, replicaFactory.replicaType)
    ) {
      // Records in a format this replica cannot read are not an empty
      // document either: reading them would misparse them.
      throw new Error(
        `stored replica type [${existing.replicaType}] cannot be read by [${replicaFactory.replicaType}]`,
      )
    }

    const entries: StoredEntry[] = []
    for await (const record of store.loadAll(docId)) {
      if (record.kind === "entry") entries.push(record)
    }
    // Nothing live is loaded into, so the latest stored lineage is the
    // document's.
    const { stored, untaken } = takeStoredEntries(
      replica,
      replicaFactory,
      entries,
      latestStoredLineage(replicaFactory, entries),
    )
    for (const version of untaken) {
      console.warn(
        `[runtime] stored entry at ${version} for doc '${docId}' could not be loaded`,
      )
    }
    return stored === undefined
      ? nothingStored
      : { outcome: { kind: "stored", version: stored }, writer }
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
      for (const instance of this.#instances.values()) {
        if (instance.tier !== "interpret") continue
        // `tick` is optional on the Substrate interface, and most substrates
        // have no use for it — only `ephemeral` does, to re-project decayed
        // leaves as their structural zeros. Everything durable skips this.
        instance.readyInfo.replica.tick?.(now)
      }
    }, this.#tickIntervalMs)
    // Don't keep the Node.js process alive just for the tick.
    unrefTimer(this.#tickTimer)
  }

  #stopTick(): void {
    if (this.#tickTimer !== null) {
      clearInterval(this.#tickTimer)
      this.#tickTimer = null
    }
  }

  // =========================================================================
  // INTERNAL — Store-first: the publish gate
  // =========================================================================

  /**
   * May this document's live state leave the process now?
   *
   * The Synchronizer asks immediately before it exports the document. Asking
   * first brings every own write into view: a pending native write is
   * committed and drained here, so the answer covers it. Draining, checking
   * and exporting are consecutive synchronous calls, so nothing can write
   * between the answer and the export.
   *
   * After a refusal, {@link RuntimeHooks.onDocPublishable} fires once the
   * store confirms what the export was waiting for.
   *
   * @internal The Exchange wires it into the Synchronizer.
   */
  publishable(docId: DocId): boolean {
    const instance = this.#current(docId)
    // Replicate documents make no operations of their own, and a deferred
    // one holds nothing to export.
    if (instance?.tier !== "interpret") return true
    this.#drainLocal(docId)
    return this.#gateOpen(instance)
  }

  /**
   * Has the store confirmed every own write of this document? Always, for a
   * document without a store. `confirmed`: the version the store holds it
   * at, read from the store program unless given.
   */
  #gateOpen(
    instance: InterpretInstance,
    confirmed = this.#storedVersion(instance.readyInfo.docId),
  ): boolean {
    const { replica, replicaFactory, syncMode } = instance.readyInfo
    if (!storedOf(this.#lifecycle, syncMode)) return true
    return gateOpen({
      ownHigh: instance.publication.ownHigh,
      confirmed:
        confirmed === undefined
          ? undefined
          : replicaFactory.parseVersion(confirmed),
      current: replica.version(),
    })
  }

  /** The version the store program records the store holds `docId` at. */
  #storedVersion(docId: DocId): string | undefined {
    const phase = this.#storeHandle?.getState().docs.get(docId)
    return phase === undefined ? undefined : confirmedVersion(phase)
  }

  /**
   * Withdraw the right to author `instance`: another seat of its storage writes
   * it. Its context's refusal answers `refusal` from now on, so authored
   * writes throw it and `writeRefusal` reports it. The first refusal stands.
   */
  #refuse(instance: InterpretInstance, refusal: WriterRefusedError): void {
    const { seat } = instance.refusals
    if (seat() === undefined) seat.set(refusal)
  }

  /**
   * Recover from a lost writer race: another seat claimed the document before
   * this one's first own write reached the store.
   *
   * 1. Refuse further authored writes.
   * 2. Read the store, and take it into a fresh document of the same schema,
   *    toward the latest stored lineage. Not into the live one: when both
   *    seats extended one lineage from the same position, the live replica's
   *    version reaches the winner's, and its entries would be skipped as held.
   *    Not into a bare replica either: without the schema, its entirety omits
   *    the fields at their defaults, and the reset would keep this seat's
   *    values there.
   * 3. Replace the live document with it, which discards this seat's refused
   *    write. Nothing of it left the process (store-first).
   * 4. Tell the Synchronizer, so peers are asked again from here: a merge
   *    that arrived while the store was read was discarded with the rest.
   * 5. Hand the document back to the store program as loaded. The write it
   *    owes finds nothing new, and its confirmation reopens the gate, since
   *    the rebuilt version reaches `ownHigh` or lies on another lineage.
   *
   * Stops at the read if the instance it began with is no longer current (a
   * destroy, or a destroy and create, meanwhile), so a delete that runs after
   * the read is not undone by what follows.
   */
  async #rebuild(
    store: Store,
    docId: DocId,
    refusal: WriterRefusedError,
    dispatch: (msg: StoreInput) => void,
  ): Promise<void> {
    const instance = this.#current(docId)
    if (instance?.tier !== "interpret") return
    const held = currentGen(this.#lifecycle, docId)
    this.#refuse(instance, refusal)

    const entries: StoredEntry[] = []
    for await (const record of store.loadAll(docId)) {
      if (record.kind === "entry") entries.push(record)
    }
    if (currentGen(this.#lifecycle, docId) !== held) return

    // A fresh document of the same schema, not a bare replica: its entirety
    // then names every field, so the reset replaces each one this seat wrote.
    const { bound, readyInfo } = instance
    const { substrate: fresh } = beginHydration(
      bound.factory({ peerId: this.peerId, binding: bound.identityBinding }),
      bound.schema,
    )
    let stored: string | undefined
    try {
      stored = takeStoredEntries(
        fresh,
        readyInfo.replicaFactory,
        entries,
        latestStoredLineage(readyInfo.replicaFactory, entries),
      ).stored
      // The entirety is a payload of its own: the live document shares
      // nothing with the fresh one once it has taken it in.
      readyInfo.replica.resetFromEntirety(fresh.exportEntirety())
    } finally {
      fresh.dispose("disposed")
    }
    this.#hooks?.onDocReset?.(docId)

    dispatch(
      stored === undefined
        ? { type: "register", docId }
        : { type: "hydrated", docId, version: stored },
    )
  }

  /**
   * The store confirmed a write of `docId`, at `version`. Called from the
   * `persisted` effect, which carries the version: the store program may
   * have stopped tracking the document by then (a release in the same
   * transition).
   *
   * This is also how a rebuilt document's gate reopens: the write `hydrated`
   * owes after a rebuild confirms at once, and the rebuilt version reaches
   * `ownHigh` or lies on another lineage.
   */
  #confirmed(docId: DocId, version: string): void {
    const instance = this.#current(docId)
    if (instance?.tier !== "interpret") return
    const publication = instance.publication
    publication.error = undefined
    // The gate was shut exactly while `ownHigh` was set, so clearing it is
    // the opening. Nothing may have been refused meanwhile; the offers owed
    // are then none, and the signal sends nothing.
    if (
      publication.ownHigh !== undefined &&
      this.#gateOpen(instance, version)
    ) {
      publication.ownHigh = undefined
      this.#hooks?.onDocPublishable?.(docId)
    }
    this.#reportPersistence(instance)
  }

  /** A store write of `docId` failed. Only a confirmation opens the gate. */
  #writeFailed(docId: DocId, error: unknown): void {
    const instance = this.#current(docId)
    if (instance?.tier !== "interpret") return
    instance.publication.error = error
    this.#reportPersistence(instance)
  }

  /**
   * What the persistence term reports: every own write confirmed. A write
   * the drain has not reached yet is unconfirmed too, though the gate has not
   * heard of it: the gate is only asked after a drain.
   */
  #persisted(instance: InterpretInstance): boolean {
    if (!storedOf(this.#lifecycle, instance.readyInfo.syncMode)) return true
    if (this.#dirtyLocalChanges.has(instance.readyInfo.docId)) return false
    return this.#gateOpen(instance)
  }

  /**
   * What `persistenceError` reports: the lost seat once the store program
   * holds one, since it fails every document's writes, including a document
   * opened afterwards; otherwise the document's own latest write error.
   */
  #persistenceError(instance: InterpretInstance): unknown | undefined {
    if (!storedOf(this.#lifecycle, instance.readyInfo.syncMode))
      return undefined
    return this.#storeHandle?.getState().seatLost ?? instance.publication.error
  }

  /** Tell the persistence term's subscribers, if what it reports moved. */
  #reportPersistence(instance: InterpretInstance): void {
    const publication = instance.publication
    const now = {
      persisted: this.#persisted(instance),
      error: this.#persistenceError(instance),
    }
    const before = publication.reported
    if (before.persisted === now.persisted && before.error === now.error) {
      return
    }
    publication.reported = now
    for (const listener of [...publication.listeners]) listener()
  }

  #scheduleRetry(docId: DocId, afterMs: number): void {
    this.#cancelRetry(docId)
    const timer = setTimeout(() => {
      this.#retryTimers.delete(docId)
      this.onStateAdvanced(docId)
    }, afterMs)
    // A retry alone does not keep a Node.js process alive.
    unrefTimer(timer)
    this.#retryTimers.set(docId, timer)
  }

  #cancelRetry(docId: DocId): void {
    const timer = this.#retryTimers.get(docId)
    if (timer === undefined) return
    clearTimeout(timer)
    this.#retryTimers.delete(docId)
  }

  #cancelAllRetries(): void {
    for (const timer of this.#retryTimers.values()) clearTimeout(timer)
    this.#retryTimers.clear()
  }
}
