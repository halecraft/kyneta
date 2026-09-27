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
import {
  beginHydration,
  createRef,
  metadataOf,
  reaches,
  replicaTypesCompatible,
  SUBSTRATE,
  subscribe,
} from "@kyneta/schema"
import type { DocId } from "@kyneta/transport"
import { registerDocSyncMode } from "./doc-meta.js"
import { planInterpretation } from "./interpret.js"
import { makeSettleTerm, registerHydrationTerm } from "./settle.js"
import type { Store, StoreRecord } from "./store/store.js"
import {
  allDocsSettled,
  isSettled,
  type StoreEffect,
  type StoreInput,
  type StoreModel,
  storeProgram,
  type Write,
} from "./store/store-program.js"

/** The obligation a no-store document has: none. */
const NO_ADOPT = (): void => {}

/** What loading found. `#hydrate` gathers it; `#becomeReady` acts on it. */
export type LoadOutcome =
  /** The store holds the document at `version`, the last loaded entry's. */
  | { readonly kind: "stored"; readonly version: string }
  /** No store holds the document. */
  | { readonly kind: "empty" }
  /** Nothing was loaded: no stores, a transient document, or a promotion
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
 * `readyInfo` + `announced` let {@link Runtime.setHooks} safely backfill
 * `onDocReady` for documents that already existed before hooks were
 * attached (e.g. a standalone `Runtime` later wrapped in an `Exchange`).
 * `readyInfo` is captured when the entry is created, and announced by
 * `#becomeReady` once the document is ready; `announced` tracks whether
 * `onDocReady` has actually fired for it yet, so repeated or out-of-order
 * `setHooks` calls never double-announce. Context: jj:mrlnmlus.
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
   * coalesced into one `onStateAdvanced` call per doc per microtask
   * tick — mirrors the Synchronizer's own dirty-set-drained-at-quiescence
   * pattern (`onStateAdvanced`'s doc comment: "Coalescing is intentional:
   * multiple advances within one dispatch cycle produce a single
   * notification").
   *
   * This originally existed because a multi-field `batch()` fired one
   * changeset per touched field, so persisting inline wrote the same
   * starting delta once per field. Since `@kyneta/schema` 4.0 a batch
   * delivers one changeset per subscriber, so that particular trigger is
   * gone — but the coalescing is not redundant. It still collapses
   * *several separate batches* landing in one microtask, and it collapses
   * across *several documents* at once, neither of which the schema-layer
   * change addresses. A tick that issues three batches would otherwise
   * write twice: the first batch at once, the other two as the write owed
   * behind it. Context: jj:mrlnmlus.
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
            case "persist": {
              this.#persist(effect.docId, effect.write, dispatch)
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
   * has advanced (from network sync or local change). Tells the store
   * program the document may have moved past what the store holds.
   *
   * A standalone Runtime (no Exchange) calls this from its own
   * local-changeset subscription too — see {@link Runtime.#wireDocSubscription}.
   * Calling it redundantly for the same mutation costs nothing: a request
   * that arrives while a write is in flight collapses into the one write owed
   * after it, and that write finds nothing new and touches no store.
   *
   * Carries a `docId` and nothing else. Every hook in {@link RuntimeHooks}
   * reports outward, from the Runtime to whoever wired it up; this is the one
   * call that comes back in, and it should not need the network shell to hold
   * local bookkeeping in order to make it. The Runtime resolves the document
   * from its own cache, which is where the document lives.
   */
  onStateAdvanced(docId: DocId): void {
    this.#storeHandle?.dispatch({ type: "state-advanced", docId })
  }

  /**
   * Will this document's state ever reach a store, in either direction?
   */
  #usesStores(syncMode: SyncMode): boolean {
    return this.#stores.length > 0 && syncMode.durability === "persistent"
  }

  /**
   * Compact a document: replace what the stores hold with the document as it
   * stands when the write starts. Resolves once no write is in flight for it.
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
   * that one confirmed, so no record repeats another's operations.
   */
  #persist(
    docId: DocId,
    write: Write,
    dispatch: (msg: StoreInput) => void,
  ): void {
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

    Promise.all(
      this.#stores.map(async store => {
        if (write.kind === "compact") {
          await store.replace(docId, records)
          return
        }
        for (const record of records) await store.append(docId, record)
      }),
    ).then(
      () => dispatch({ type: "write-succeeded", docId, version }),
      error => dispatch({ type: "write-failed", docId, error }),
    )
  }

  /**
   * The records a write consists of, and the version they bring the store to.
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
    await this.#awaitHydrations()
    if (this.#storeHandle) {
      await this.#storeHandle.waitForState(allDocsSettled)
    }
  }

  /**
   * Gracefully shut down: flush all pending operations, close stores,
   * stop the tick clock.
   */
  async shutdown(): Promise<void> {
    await this.#awaitHydrations()
    if (this.#storeHandle) {
      await this.#storeHandle.waitForState(allDocsSettled)
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
    const willHydrate = !promoting && this.#usesStores(bound.syncMode)

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

    const readyInfo: DocReadyInfo = {
      docId,
      mode: "interpret",
      replica: substrate,
      replicaFactory: factory.replica,
      syncMode: bound.syncMode,
      schemaHash: bound.schemaHash,
      supportedHashes: [...bound.supportedHashes],
    }

    const hydration = createHydrationLatch()

    const entry: DocCacheEntry = {
      mode: "interpret",
      ref,
      bound,
      readyInfo,
      announced: false,
      hydration,
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
   * Load the document from the stores, then make it ready. A failed load
   * marks the latch `failed` and nothing else: its state is unknown, so the
   * document is neither registered, announced, nor given a stable identity.
   */
  #loadThenBecomeReady(entry: ReadyEntry, adopt: () => void): void {
    const loading = this.#hydrate(entry.readyInfo).then(
      outcome => this.#becomeReady(entry, outcome, adopt),
      (error: unknown) =>
        resolveHydration(entry.hydration, { ok: false, error }),
    )
    this.#trackHydration(loading)
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
   *    interpreted document starts forwarding its changesets. Both carry the
   *    identity claimed in step 3.
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
    if (entry.mode === "interpret") this.#wireDocSubscription(docId, entry.ref)
  }

  /**
   * Wire the changefeed subscription for a document: forwards changesets
   * to the hooks (Exchange wires these into the Synchronizer), and
   * self-persists local (non-replay) changesets unconditionally — so a
   * standalone Runtime (no Exchange) durably persists its own mutations
   * without depending on the Exchange's `Synchronizer → onStateAdvanced`
   * wiring. Safe to run alongside that wiring: the store program collapses
   * the two requests, and the write owed by the second finds nothing new.
   *
   * Marks the doc dirty and schedules a microtask-deferred, coalesced
   * drain rather than persisting inline. A single `batch()` used to fire
   * one changeset per touched field, so persisting on every changeset
   * exported the same starting delta once per field; since
   * `@kyneta/schema` 4.0 a batch delivers one changeset, but the drain
   * still earns its place by coalescing several batches — and several
   * documents — within one microtask. See {@link Runtime.#dirtyLocalChanges}.
   * Context: jj:mrlnmlus.
   *
   * Called by `#becomeReady`, the one place a document becomes ready.
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
    for (const docId of docIds) this.onStateAdvanced(docId)
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
  async #hydrate(readyInfo: DocReadyInfo): Promise<LoadOutcome> {
    const { docId, replica, replicaFactory } = readyInfo
    // First-hit semantics: use the first store that has data. `storedVersion`
    // is the version of the last entry loaded: what the store holds.
    let storedVersion: string | undefined
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
        if (
          existing &&
          !replicaTypesCompatible(
            existing.replicaType,
            replicaFactory.replicaType,
          )
        ) {
          // Records in a format this replica cannot read are not an empty
          // document: reading them anyway would misparse them. The store
          // could not answer, the same as a store that threw.
          throw new Error(
            `stored replica type [${existing.replicaType}] cannot be read by [${replicaFactory.replicaType}]`,
          )
        }
        anyStoreAnswered = true
        if (existing) {
          for await (const record of backend.loadAll(docId)) {
            if (record.kind === "entry") {
              // The store holds this entry whether or not it loads here, so
              // it counts toward the store's version either way.
              storedVersion = record.version
              try {
                // A whole-document entry is the state at its version, whatever
                // came before it: after a lineage reset, the store's next
                // write is the new lineage's whole document, which a merge
                // would refuse as not continuing the old one. A delta must
                // bring the replica to the version it was stored at; one that
                // does not continue what loaded before it leaves the replica
                // short, and is a failed read of that entry.
                if (record.payload.kind === "entirety") {
                  replica.resetFromEntirety(record.payload, { origin: "sync" })
                } else {
                  replica.merge(record.payload, { origin: "sync" })
                  // A history-free version is a private counter, compared
                  // with nothing but its own replica.
                  if (
                    !replicaFactory.historyFree &&
                    !reaches(
                      replica.version(),
                      replicaFactory.parseVersion(record.version),
                    )
                  ) {
                    throw new Error(
                      `stored entry at ${record.version} does not continue the entries loaded before it`,
                    )
                  }
                }
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

    return storedVersion === undefined
      ? { kind: "empty" }
      : { kind: "stored", version: storedVersion }
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
        const substrate = entry.ref?.[SUBSTRATE]
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
