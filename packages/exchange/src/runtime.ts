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

import type { Changeset } from "@kyneta/changefeed"
import type { Lease, ObservableHandle } from "@kyneta/machine"
import { createLease, createObservableProgram } from "@kyneta/machine"
import { randomPeerId } from "@kyneta/random"
import type {
  BoundSchema,
  DocRef,
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
  createRef,
  DEFAULT_LINEAGE,
  metadataOf,
  replicaTypesCompatible,
  subscribe,
} from "@kyneta/schema"
import type { DocId } from "@kyneta/transport"
import { registerDocSyncMode } from "./doc-meta.js"
import { planInterpretation } from "./interpret.js"
import { registerPersistenceTerm } from "./persistence.js"
import { gateOpen } from "./publish-gate.js"
import { makeSettleTerm, registerHydrationTerm } from "./settle.js"
import type { Store, StoreRecord } from "./store/store.js"
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
 * Store the records of a `register` or `since` write: a document the store
 * has never acknowledged is written by `compact` with no mark, which only
 * appends; a delta is appended.
 */
async function writeRecords(
  store: Store,
  docId: DocId,
  write: Exclude<Write, { kind: "compact" }>,
  records: StoreRecord[],
): Promise<void> {
  if (write.kind === "register") {
    await store.compact(docId, records, null)
    return
  }
  for (const record of records) await store.append(docId, record)
}

/** The obligation a no-store document has: none. */
const NO_ADOPT = (): void => {}

/** What a document that has not become ready has wired: nothing. */
const NOTHING_WIRED = (): void => {}

/** What loading found. `#hydrate` gathers it; `#becomeReady` acts on it. */
export type LoadOutcome =
  /**
   * The store holds the document at `version`: the join of the stored
   * entries the replica reaches.
   */
  | { readonly kind: "stored"; readonly version: string }
  /** The store holds nothing of the document the replica could take in. */
  | { readonly kind: "empty" }
  /** Nothing was loaded: no store, a transient document, or a promotion
   *  whose replica already loaded. */
  | { readonly kind: "none" }

const NOTHING_LOADED: LoadOutcome = { kind: "none" }

/**
 * The store program's view of a load, or `null` when there is nothing to tell
 * it. `hydrated` carries the version the store holds, which the program keeps
 * as its baseline for later writes.
 */
export function storeInputFor(
  docId: DocId,
  outcome: LoadOutcome,
): StoreInput | null {
  switch (outcome.kind) {
    case "stored":
      return { type: "hydrated", docId, version: outcome.version }
    case "empty":
      return { type: "register", docId }
    case "none":
      return null
  }
}

/** A cache entry that can become ready: anything but a deferred one. */
type ReadyEntry = Extract<DocCacheEntry, { mode: "interpret" | "replicate" }>

type InterpretEntry = Extract<DocCacheEntry, { mode: "interpret" }>

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
 * Every latch starts `pending`, and `#becomeReady` is what moves it on, on
 * every path. A document with nothing to load passes through it before
 * `get()` returns, so no caller ever sees it pending.
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

/** @internal A latch for a document that has not become ready yet. */
export function createHydrationLatch(): HydrationLatch {
  return { state: "pending", listeners: new Set() }
}

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

/**
 * `readyInfo` + `announced` let {@link Runtime.setHooks} safely backfill
 * `onDocReady` for documents that already existed before hooks were
 * attached (e.g. a standalone `Runtime` later wrapped in an `Exchange`).
 * `readyInfo` is captured when the entry is created, and announced by
 * `#becomeReady` once the document is ready; `announced` tracks whether
 * `onDocReady` has actually fired for it yet, so the `setHooks` backfill and
 * `#becomeReady` never both announce one document. Context: jj:mrlnmlus.
 *
 * `hydration` is the storage half of the document's readiness — see
 * {@link HydrationLatch} and `settle.ts`. `publication` is where its own
 * writes stand against the store — see {@link Publication}.
 */
export type DocCacheEntry =
  | {
      mode: "interpret"
      ref: any
      bound: BoundSchema
      readyInfo: InterpretReadyInfo
      announced: boolean
      suspended?: boolean
      hydration: HydrationLatch
      publication: Publication
      /** Undoes what `#becomeReady` wired; a no-op until then. */
      unwire: () => void
    }
  | {
      mode: "replicate"
      readyInfo: ReplicateReadyInfo
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
   * immediately if no store is configured) and is ready to participate
   * in the sync graph.
   *
   * The Exchange implements this to call `synchronizer.registerDoc(...)`.
   */
  onDocReady?: (info: DocReadyInfo) => void

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
   * Called when a document is destroyed locally — remove from sync graph
   * AND delete from the store. The Exchange implements this to broadcast
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
  /** The store documents persist to and load from. */
  store?: Store

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
   * This replica's seat: a fresh random id, never chosen by the caller, so no
   * other writer holds it and no earlier writer's history is missing from it.
   */
  readonly peerId: string = randomPeerId()
  readonly lease: Lease

  readonly #store: Store | undefined
  /** Store-program handle — pure Mealy machine for store coordination. */
  readonly #storeHandle: ObservableHandle<StoreInput, StoreModel> | null

  readonly #docCache = new Map<DocId, DocCacheEntry>()

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
    store,
    onStoreError,
    lease,
    tickInterval = 1000,
  }: RuntimeParams = {}) {
    this.lease = lease ?? createLease()
    this.#store = store
    this.#tickIntervalMs = tickInterval

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
              this.#confirmed(effect.docId)
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
                () => {}, // No write-succeeded for destroy
                error => errorHandler(docId, "delete", error),
              )
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
   * would share its seat and sync its documents twice.
   *
   * Backfills `onDocReady` for every already-live, non-deferred document
   * in the cache — covers the "standalone Runtime later wrapped in an
   * Exchange" path (`new Exchange(runtime, params)`), where documents
   * created via `runtime.get()`/`runtime.replicate()` before this call
   * fired `onDocReady` with no hooks set and were never announced.
   * Context: jj:mrlnmlus.
   */
  setHooks(hooks: RuntimeHooks): void {
    if (this.#hooks)
      throw new Error(
        "[runtime] this Runtime already belongs to an Exchange; two Exchanges over one Runtime would share its seat",
      )
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
   * (if a store is configured). Returns the ref synchronously. If a store
   * is configured, hydration completes asynchronously — the ref starts
   * empty and the changefeed fires when stored data is merged.
   *
   * Multiple calls with the same `docId` return the same instance. Calling
   * with a schema that cannot read what is already there throws, naming the
   * axis that disagrees.
   *
   * @param docId - The document ID
   * @param bound - A BoundSchema created by `bind()`
   * @returns A full-stack ref with the local substrate
   */
  get: RuntimeGet = (docId, bound) => {
    const cached = this.#docCache.get(docId)

    // A standalone Runtime is a complete door, not a shortcut through the
    // Exchange's. Both consult the same classifier, so a local-first
    // application gets the same compatibility check and the same hydration
    // precondition — without this, `createInterpretDoc` below would upgrade a
    // replicate document having verified nothing.
    //
    // Only `deferred` needs metadata the Runtime does not hold, and it never
    // holds a deferred document, so that arm is unreachable from here.
    if (cached?.mode === "replicate" || cached?.mode === "interpret") {
      const action = planInterpretation({
        phase: cached.mode,
        reader: metadataOf(bound),
        // An interpreted document's shape is the `BoundSchema` it was made
        // with — a `BoundSchema` carries the three `DocMetadata` fields, so
        // it *is* that shape.
        doc:
          cached.mode === "interpret"
            ? cached.bound
            : {
                replicaType: cached.readyInfo.replicaFactory.replicaType,
                syncMode: cached.readyInfo.syncMode,
                schemaHash: cached.readyInfo.schemaHash,
              },
        hydrated: this.hydrated(docId),
      })
      if (action.action === "refuse") {
        throw action.kind === "not-hydrated"
          ? new Error(
              `Document '${docId}' is still loading from storage. ` +
                `Await whenHydrated('${docId}') before calling get() ` +
                `— promoting a document mid-load would lose part of it.`,
            )
          : new Error(
              `Document '${docId}' cannot be interpreted with this schema: ` +
                `${action.mismatch.axis} disagrees (local ${action.mismatch.local} ` +
                `vs document ${action.mismatch.remote}).`,
            )
      }
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
   * Has this document finished loading from storage?
   *
   * The docId-keyed twin of `hydrated(ref)` in `settle.ts`. Both exist because
   * not every document has a ref to ask about: one held in `replicate` mode is
   * a bare replica with no schema and no interpreter stack, so the ref-keyed
   * form has nothing to key on. The parameter type says which surface you are
   * using.
   *
   * An unknown document reports `true`. There is nothing to load, so the load
   * is trivially finished — the same answer `hydrated(ref)` gives a document
   * with no store behind it, and it saves every caller an existence check.
   */
  hydrated(docId: DocId): boolean {
    const entry = this.#docCache.get(docId)
    if (!entry || entry.mode === "deferred") return true
    return entry.hydration.state !== "pending"
  }

  /**
   * Resolve once this document's stored data has finished loading; reject if
   * the load failed.
   *
   * No timeout, for the reason `whenHydrated(ref)` gives: a slow disk is a
   * local fault we can observe, and abandoning the wait would mean proceeding
   * as though the document were empty. That is how defaults get written over
   * data we merely failed to read.
   */
  whenHydrated(docId: DocId): Promise<void> {
    const entry = this.#docCache.get(docId)
    if (!entry || entry.mode === "deferred") return Promise.resolve()

    const latch = entry.hydration
    if (latch.state === "loaded") return Promise.resolve()
    if (latch.state === "failed") return Promise.reject(latch.error)

    return new Promise<void>((resolve, reject) => {
      latch.listeners.add(() => {
        if (latch.state === "failed") reject(latch.error)
        else resolve()
      })
    })
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
   * Destroy a document — remove it from the cache and delete from the store.
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
      this.#usesStore(entry.readyInfo.syncMode)

    this.#evict(docId)
    if (touchesStore) this.#storeHandle?.dispatch({ type: "destroy", docId })
    this.#hooks?.onDocDestroyed?.(docId)
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
    this.#hooks?.onDocSuspended?.(docId)
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
    this.#hooks?.onDocResumed?.(docId)
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
   * Carries a `docId` and nothing else. The Runtime resolves the document
   * from its own cache, which is where the document lives, so the network
   * shell never needs local bookkeeping to make the call.
   */
  onStateAdvanced(docId: DocId): void {
    this.#storeHandle?.dispatch({ type: "state-advanced", docId })
  }

  /**
   * Replace a replicate-mode document's replica with one built from an
   * entirety. Throws what `fromEntirety` throws.
   *
   * The Synchronizer calls this when a reset means the incoming image is not
   * a continuation of what the relay holds (see the replicate arm of its
   * reset branch). It is the Runtime's to do because the Runtime owns the
   * document's record: the Synchronizer reads the same object, so it sees
   * the new replica, and so do persistence and promotion.
   */
  rebuildReplica(docId: DocId, payload: SubstratePayload): void {
    const entry = this.#docCache.get(docId)
    if (entry?.mode !== "replicate") {
      throw new Error(
        `[runtime] cannot rebuild '${docId}': not a replicate-mode document`,
      )
    }
    entry.readyInfo.replica =
      entry.readyInfo.replicaFactory.fromEntirety(payload)
  }

  /**
   * Will this document's state ever reach a store, in either direction?
   */
  #usesStore(syncMode: SyncMode): boolean {
    return this.#store !== undefined && syncMode.durability === "persistent"
  }

  /**
   * Compact a document: take in what the store holds of it, then replace
   * what was read with the whole document ({@link Runtime.#compact}).
   * Resolves once no write is in flight for it, which a `destroy` makes true
   * at once.
   */
  async compact(docId: DocId): Promise<void> {
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
   */
  #persist(
    store: Store,
    docId: DocId,
    write: Write,
    dispatch: (msg: StoreInput) => void,
  ): void {
    if (write.kind === "compact") {
      this.#compact(store, docId).then(
        version => dispatch({ type: "write-succeeded", docId, version }),
        error => dispatch({ type: "write-failed", docId, error }),
      )
      return
    }

    let prepared: { records: StoreRecord[]; version: string }
    try {
      prepared = this.#prepareWrite(docId, write)
    } catch (error) {
      dispatch({ type: "write-failed", docId, error })
      return
    }
    const { records, version } = prepared

    // Nothing past the confirmed version. The store already holds it all.
    if (records.length === 0) {
      dispatch({ type: "write-succeeded", docId, version })
      return
    }

    writeRecords(store, docId, write, records).then(
      () => dispatch({ type: "write-succeeded", docId, version }),
      error => dispatch({ type: "write-failed", docId, error }),
    )
  }

  /**
   * Compact a document, and resolve with the version the store then holds.
   *
   * 1. Read the store's mark, then every entry.
   * 2. Stop if the document is no longer the one held when the read began:
   *    nothing is merged into, or pushed from, a document that is gone.
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
  async #compact(store: Store, docId: DocId): Promise<string> {
    const held = this.#docCache.get(docId)
    const mark = await store.mark(docId)
    const entries: StoredEntry[] = []
    for await (const record of store.loadAll(docId)) {
      if (record.kind === "entry") entries.push(record)
    }

    const entry = this.#docCache.get(docId)
    if (entry === undefined || entry !== held || entry.mode === "deferred") {
      throw new Error(`[runtime] cannot compact '${docId}': document not held`)
    }
    const { replica, replicaFactory } = entry.readyInfo
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
      const { records, version } = this.#prepareWrite(docId, write)
      if (records.length > 0) await writeRecords(store, docId, write, records)
      return version
    }

    const { records, version } = this.#prepareWrite(docId, { kind: "compact" })
    await store.compact(docId, records, mark)
    return version
  }

  /**
   * The records a write consists of, and the version they bring the store to.
   *
   * Reads the replica now, when the write starts.
   *
   * Throws if the document is not held here. The store program only writes
   * documents this Runtime registered, and `destroy` removes both together,
   * so that is a broken invariant; it is reported as a failed write rather
   * than thrown through the dispatcher.
   */
  #prepareWrite(
    docId: DocId,
    write: Write,
  ): { records: StoreRecord[]; version: string } {
    const entry = this.#docCache.get(docId)
    if (!entry || entry.mode === "deferred") {
      throw new Error(`[runtime] cannot write '${docId}': document not held`)
    }
    // Commit, read the version, export: otherwise the export commits a
    // pending native write here, its signal fires from inside this executor,
    // and the drain asks for one more write that finds nothing new.
    if (entry.mode === "interpret") entry.readyInfo.replica.commitPending()
    const { replica, replicaFactory, syncMode, schemaHash } = entry.readyInfo
    const current = replica.version()
    const version = current.serialize()

    const whole = (): StoreRecord[] => [
      {
        kind: "meta",
        meta: { replicaType: replicaFactory.replicaType, syncMode, schemaHash },
      },
      { kind: "entry", payload: replica.exportEntirety(), version },
    ]

    switch (write.kind) {
      case "register":
      case "compact":
        return { records: whole(), version }
      case "since": {
        const since = replicaFactory.parseVersion(write.version)
        // `compare` is only meaningful within one lineage.
        if (
          current.lineage === since.lineage &&
          current.compare(since) === "equal"
        ) {
          return { records: [], version: write.version }
        }
        // `exportSince` answers `null` both for "nothing new" and for "cannot:
        // `since` is behind the trimmed base". The second happens once a
        // compaction has advanced the base past what the store confirmed, and
        // reading it as the first would drop every change since. So an
        // advanced replica always writes something: the delta if it can,
        // otherwise the whole document, appended.
        const payload = replica.exportSince(since) ?? replica.exportEntirety()
        return { records: [{ kind: "entry", payload, version }], version }
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
    await this.#awaitPendingWork()
    if (this.#storeHandle) {
      await this.#storeHandle.waitForState(allDocsSettled)
    }
  }

  /**
   * Gracefully shut down: flush all pending operations, close the store,
   * stop the tick clock.
   */
  async shutdown(): Promise<void> {
    await this.#awaitPendingWork()
    if (this.#storeHandle) {
      await this.#storeHandle.waitForState(allDocsSettled)
      this.#storeHandle.dispose()
    }
    this.#stopTick()
    this.#cancelAllRetries()
    for (const docId of [...this.#docCache.keys()]) this.#evict(docId)
    await this.#store?.close()
  }

  /**
   * Synchronous teardown — clears the cache and stops everything without
   * awaiting pending I/O. Use {@link shutdown} for graceful teardown.
   */
  reset(): void {
    this.#stopTick()
    this.#cancelAllRetries()
    this.#storeHandle?.dispose()
    for (const docId of [...this.#docCache.keys()]) this.#evict(docId)
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

    // A replicate entry holds an accumulated `Replica` and no ref. Promoting
    // it means giving that same replica a schema, not building a new document
    // beside it — `factory.upgrade` wraps the existing backing state, so the
    // accumulated bytes carry across. Falling through to ordinary construction
    // instead would replace them with a fresh, empty substrate, losing the
    // state with no error and no event, in the tier relays and audit logs use
    // — exactly where nobody is reading contents closely enough to notice.
    const promoting = cached?.mode === "replicate" ? cached : undefined

    const factory = bound.factory({
      peerId: this.peerId,
      binding: bound.identityBinding,
    })

    // ── Shared prefix: create substrate, build ref ──
    //
    // A document that will hydrate is about to import operations this peer
    // wrote in an earlier session, so it takes the deferred-identity path:
    // `adopt` is called by `#becomeReady` once that import finishes. One that will not
    // hydrate has nothing to import, so `create()`'s immediate claim is
    // correct and `adopt` is a no-op.
    //
    // Whether deferring changes anything is a per-backend fact, and not one
    // this file should hold: `beginHydration` puts the question to the factory
    // and falls back to the safe answer for backends that do not care.
    //
    // Bound once and used at all three decision points below — see
    // `#usesStores` for why they have to agree. A promotion never hydrates:
    // the replica it upgrades has already loaded, which is the precondition
    // the caller had to satisfy to get here.
    const willHydrate = !promoting && this.#usesStore(bound.syncMode)

    // All three arms end with this peer's identity claimed; they differ in
    // *when*, and each is right for what it can guarantee. `beginHydration`
    // defers, because an import is still coming. `create` claims at once,
    // because none is. `upgrade` claims at once too, because the import has
    // already finished — that is the two-phase construction contract every
    // backend defines `create` in terms of. Making it defer to match the first
    // arm would leave the identity unclaimed with nothing left to claim it.
    const { substrate, adopt } = promoting
      ? {
          substrate: factory.upgrade(promoting.readyInfo.replica, bound.schema),
          adopt: NO_ADOPT,
        }
      : willHydrate
        ? beginHydration(factory, bound.schema)
        : { substrate: factory.create(bound.schema), adopt: NO_ADOPT }

    const ref: any = createRef(bound.schema, substrate, {
      lease: this.lease,
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

    const hydration = createHydrationLatch()
    const publication = createPublication()

    const entry: InterpretEntry = {
      mode: "interpret",
      ref,
      bound,
      readyInfo,
      announced: false,
      hydration,
      publication,
      unwire: NOTHING_WIRED,
      // Suspension survives promotion. The two say different things: which
      // tier holds the document, versus whether it is in the sync graph.
      // Dropping the flag here would let a `get()` silently re-announce a
      // document the application had deliberately withdrawn — the property
      // `get()` is specifically built not to have.
      ...(promoting?.suspended ? { suspended: true } : {}),
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
    registerPersistenceTerm(
      ref,
      makeSettleTerm(
        () => this.#persisted(entry),
        onChange => {
          publication.listeners.add(onChange)
          return () => publication.listeners.delete(onChange)
        },
      ),
      () => publication.error,
    )

    if (willHydrate) {
      this.#loadThenBecomeReady(entry, adopt)
    } else {
      this.#becomeReady(entry, NOTHING_LOADED, adopt)
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

    const readyInfo: ReplicateReadyInfo = {
      docId,
      mode: "replicate",
      replica,
      replicaFactory,
      syncMode,
      schemaHash,
    }

    // Same rule as the interpret path — a relay holds transient documents too.
    const willHydrate = this.#usesStore(syncMode)

    // A replicate document has no ref, so no settle term can be keyed to it
    // and it has no `docStatus` surface. The latch is still tracked so the
    // entry's hydration state is uniform across modes, and
    // `whenHydrated(docId)` can wait on it.
    const hydration = createHydrationLatch()

    const entry: DocCacheEntry = {
      mode: "replicate",
      readyInfo,
      announced: false,
      hydration,
    }
    this.#docCache.set(docId, entry)

    if (willHydrate) {
      this.#loadThenBecomeReady(entry, NO_ADOPT)
    } else {
      this.#becomeReady(entry, NOTHING_LOADED, NO_ADOPT)
    }
  }

  /**
   * Load the document from the store, then make it ready. A failed load
   * marks the latch `failed` and nothing else: its state is unknown, so the
   * document is neither registered, announced, nor given a stable identity.
   */
  #loadThenBecomeReady(entry: ReadyEntry, adopt: () => void): void {
    const loading = this.#hydrate(entry.readyInfo).then(
      outcome => this.#becomeReady(entry, outcome, adopt),
      (error: unknown) =>
        resolveHydration(entry.hydration, { ok: false, error }),
    )
    this.#track(loading)
  }

  /**
   * The one place a document becomes ready, whatever path created it.
   *
   * The order is fixed:
   * 1. A document destroyed or replaced while it loaded is no longer this
   *    entry's to make ready: its latch fails, so waiters are not told a
   *    document that is gone has loaded, and nothing below runs.
   * 2. The store program learns what the store holds.
   * 3. `adopt` claims identity (Yjs, Loro) and the right to author (plain)
   *    before anyone is told the document has loaded, so a listener that
   *    writes on that signal finds the document writable.
   * 4. The latch resolves `loaded`.
   * 5. `#register` publishes the document to the sync graph, and an
   *    interpreted document is wired: its local updates start leaving the
   *    process, and its changesets reach the observation hook. Both carry
   *    the identity claimed in step 3.
   */
  #becomeReady(
    entry: ReadyEntry,
    outcome: LoadOutcome,
    adopt: () => void,
  ): void {
    const { docId } = entry.readyInfo
    if (this.#docCache.get(docId) !== entry) {
      resolveHydration(entry.hydration, {
        ok: false,
        error: new Error(`Document '${docId}' was destroyed while loading`),
      })
      return
    }
    const input = storeInputFor(docId, outcome)
    if (input) this.#storeHandle?.dispatch(input)
    adopt()
    resolveHydration(entry.hydration, { ok: true })
    this.#register(entry)
    if (entry.mode === "interpret") entry.unwire = this.#wire(docId, entry)
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
   * `#register` has just published the live version to peers.
   */
  #wire(docId: DocId, entry: InterpretEntry): () => void {
    const stopLocalUpdates = entry.readyInfo.replica.subscribeLocalUpdates(() =>
      this.#markLocalChangeDirty(docId),
    )
    const stopChangesets = subscribe(entry.ref, changeset =>
      this.#hooks?.onDocChangeset?.(docId, changeset),
    )
    return () => {
      stopLocalUpdates()
      stopChangesets()
    }
  }

  /**
   * Remove a document from the cache, and unwire it first so that a write on
   * a ref that outlives it cannot reach whatever is created under its id
   * next.
   */
  #evict(docId: DocId): void {
    const entry = this.#docCache.get(docId)
    if (entry?.mode === "interpret") entry.unwire()
    this.#docCache.delete(docId)
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
    const entry = this.#docCache.get(docId)
    if (entry?.mode === "interpret") this.#reportPersistence(entry)
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
   * from `publishable`, which is why it is per document. A document evicted
   * since it was marked is dropped.
   */
  #drainLocal(docId: DocId): void {
    const entry = this.#docCache.get(docId)
    if (entry?.mode !== "interpret") {
      this.#dirtyLocalChanges.delete(docId)
      return
    }
    const { replica, syncMode } = entry.readyInfo
    replica.commitPending()
    if (!this.#dirtyLocalChanges.delete(docId)) return
    if (this.#usesStore(syncMode)) {
      entry.publication.ownHigh = replica.version()
      this.#reportPersistence(entry)
    }
    this.onStateAdvanced(docId)
    this.#hooks?.onDocAdvanced?.(docId)
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
    if (!this.#hooks?.onDocReady) return
    this.#hooks.onDocReady(entry.readyInfo)
    entry.announced = true
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

  async #awaitPendingWork(): Promise<void> {
    while (this.#pendingWork.size > 0) {
      await Promise.all(this.#pendingWork)
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
  async #hydrate(readyInfo: DocReadyInfo): Promise<LoadOutcome> {
    const { docId, replica, replicaFactory } = readyInfo
    const store = this.#store
    if (!store) return NOTHING_LOADED
    const nothingStored: LoadOutcome = { kind: "empty" }

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
      : { kind: "stored", version: stored }
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
        // `tick` is optional on the Substrate interface, and most substrates
        // have no use for it — only `ephemeral` does, to re-project decayed
        // leaves as their structural zeros. Everything durable skips this.
        entry.readyInfo.replica.tick?.(now)
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
    const entry = this.#docCache.get(docId)
    // Replicate documents make no operations of their own, and a deferred
    // one holds nothing to export.
    if (entry?.mode !== "interpret") return true
    this.#drainLocal(docId)
    return this.#gateOpen(entry)
  }

  /**
   * Has the store confirmed every own write of this document? Always, for a
   * document without a store.
   */
  #gateOpen(entry: InterpretEntry): boolean {
    const { replica, replicaFactory, syncMode, docId } = entry.readyInfo
    if (!this.#usesStore(syncMode)) return true
    const phase = this.#storeHandle?.getState().docs.get(docId)
    const confirmed = phase === undefined ? undefined : confirmedVersion(phase)
    return gateOpen({
      ownHigh: entry.publication.ownHigh,
      confirmed:
        confirmed === undefined
          ? undefined
          : replicaFactory.parseVersion(confirmed),
      current: replica.version(),
    })
  }

  /**
   * The store confirmed a write of `docId`. Called from the `persisted`
   * effect, which runs with the store model already updated.
   */
  #confirmed(docId: DocId): void {
    const entry = this.#docCache.get(docId)
    if (entry?.mode !== "interpret") return
    const publication = entry.publication
    publication.error = undefined
    // The gate was shut exactly while `ownHigh` was set, so clearing it is
    // the opening. Nothing may have been refused meanwhile; the offers owed
    // are then none, and the signal sends nothing.
    if (publication.ownHigh !== undefined && this.#gateOpen(entry)) {
      publication.ownHigh = undefined
      this.#hooks?.onDocPublishable?.(docId)
    }
    this.#reportPersistence(entry)
  }

  /** A store write of `docId` failed. Only a confirmation opens the gate. */
  #writeFailed(docId: DocId, error: unknown): void {
    const entry = this.#docCache.get(docId)
    if (entry?.mode !== "interpret") return
    entry.publication.error = error
    this.#reportPersistence(entry)
  }

  /**
   * What the persistence term reports: every own write confirmed. A write
   * the drain has not reached yet is unconfirmed too, though the gate has not
   * heard of it: the gate is only asked after a drain.
   */
  #persisted(entry: InterpretEntry): boolean {
    if (!this.#usesStore(entry.readyInfo.syncMode)) return true
    if (this.#dirtyLocalChanges.has(entry.readyInfo.docId)) return false
    return this.#gateOpen(entry)
  }

  /** Tell the persistence term's subscribers, if what it reports moved. */
  #reportPersistence(entry: InterpretEntry): void {
    const publication = entry.publication
    const now = {
      persisted: this.#persisted(entry),
      error: publication.error,
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
