// substrate — the formal interface between state management, the
// interpreter stack, and the replication layer.
//
// Two orthogonal concerns are factored into separate interfaces:
//
//   Replica<V>     — replication surface (schema-free)
//                    version tracking, export/import, payload transfer.
//                    Sufficient for conduit participants: stores,
//                    routing servers, CDN edges, replication services.
//
//   Substrate<V>   — interpretation surface (schema-aware)
//                    extends Replica with readable reader, writable context,
//                    prepare/flush pipeline. Required for participants that
//                    read, write, or observe document state.
//
// The same factoring applies to their factories:
//
//   ReplicaFactory<V>    — construct replicas without a schema.
//   SubstrateFactory<V>  — construct substrates from schemas.
//                          Every SubstrateFactory provides a ReplicaFactory
//                          via the `replica` accessor.
//
// Three tiers of participation follow from this factoring:
//
//   Opaque conduit      — stores/forwards SubstratePayload blobs verbatim.
//                          Needs nothing from this module beyond the types.
//
//   Replication conduit — accumulates state, computes per-peer deltas,
//                          compacts storage. Needs ReplicaFactory + Replica.
//                          Does NOT need a schema.
//
//   Full interpreter    — reads, writes, observes document state via the
//                          schema-driven interpreter stack. Needs
//                          SubstrateFactory + Substrate + SchemaNode.
//
// Context: jj:wmyomqzw (SubstratePrepare), jj:wqoqzzpp (Substrate)

import type { BatchMetadata } from "@kyneta/changefeed"
import type { ChangeBase } from "./change.js"
import type { Path } from "./interpret.js"
import type { WritableContext } from "./interpreters/writable.js"
import type { Reader } from "./reader.js"
import type { Schema as SchemaNode } from "./schema.js"

// ---------------------------------------------------------------------------
// BACKING_DOC — universal accessor for the backing state of any replica
// ---------------------------------------------------------------------------

/**
 * @internal
 *
 * Symbol for accessing the backing document of a replica or substrate.
 *
 * Every kyneta-produced replica and substrate implementation places its
 * backing state under this symbol key:
 * - Plain/LWW: the `PlainState` object
 * - Yjs: the `Y.Doc`
 * - Loro: the `LoroDoc`
 *
 * This symbol is NOT on the `Replica<V>` or `Substrate<V>` interfaces —
 * it's a convention that all kyneta-produced implementations follow.
 * Factories recover the backing state via `(replica as any)[BACKING_DOC]`
 * and cast to the concrete type they know they created.
 *
 * Exported from the barrel for substrate packages (`@kyneta/loro-schema`,
 * `@kyneta/yjs-schema`) that need it in their `upgrade()` methods.
 * Not part of the public API.
 *
 * Context: jj:smmulzkm (two-phase substrate construction)
 */
export const BACKING_DOC = Symbol.for("kyneta:backingDoc")

// ---------------------------------------------------------------------------
// TREE_NODE_ALLOCATE — capability symbol for substrate-provided id allocation
// ---------------------------------------------------------------------------

/**
 * `WritableContext` hook for tree node id allocation.
 *
 * Why a capability and not a generated id: Loro's `tree-move` merge
 * semantics need peer-stamped (peer-id + Lamport) ids, so the substrate
 * has to mint them. The plain substrate gets away with a counter because
 * it doesn't merge. Substrates that don't support trees (e.g. Yjs) don't
 * implement the symbol, and `installTreeWriteOps` throws if `.create` is
 * called on such a context.
 *
 * The optional `parent` and `index` arguments let substrates that
 * natively position nodes at allocation time (Loro's `LoroTree.createNode`)
 * do so in one shot, avoiding a redundant create-then-move dance in the
 * write path. Substrates that mint pure ids (plain) ignore the args.
 */
export const TREE_NODE_ALLOCATE: unique symbol = Symbol.for(
  "kyneta:tree-node-allocate",
) as any

/** Marker for contexts that implement `TREE_NODE_ALLOCATE`. */
export interface HasTreeNodeAllocation {
  readonly [TREE_NODE_ALLOCATE]: (
    path: Path,
    parent?: string | null,
    index?: number,
  ) => string
}

export function hasTreeNodeAllocation(
  ctx: unknown,
): ctx is HasTreeNodeAllocation {
  return (
    ctx !== null &&
    ctx !== undefined &&
    typeof ctx === "object" &&
    TREE_NODE_ALLOCATE in (ctx as object)
  )
}

// ---------------------------------------------------------------------------
// STRUCTURAL_YJS_CLIENT_ID — deterministic identity for container creation
// ---------------------------------------------------------------------------

/**
 * Reserved Yjs clientID for structural container creation.
 * All peers use this identity for ensureContainers ops, producing
 * byte-identical structural ops that Yjs deduplicates on merge.
 *
 * Loro does not need a structural identity — all Loro container creation
 * (doc.getText(), doc.getList(), etc.) is idempotent.
 */
export const STRUCTURAL_YJS_CLIENT_ID = 0

// ---------------------------------------------------------------------------
// DEVTOOLS_HISTORY — optional capability for DevTools history inspection
// ---------------------------------------------------------------------------

/**
 * A point-in-time summary of a replica's version/op history, for DevTools.
 * Deliberately substrate-neutral and cheap — the detail of the CRDT op DAG
 * is intentionally out of scope here.
 */
export interface DevtoolsHistorySummary {
  /** Serialized current version (same string `Version.serialize()` produces). */
  readonly version: string
  /** Total op count retained (substrate-defined granularity; 0 if unknown). */
  readonly opCount: number
  /** Per-actor op counts (the CRDT version vector), when the substrate has one. */
  readonly actors?: Readonly<Record<string, number>>
}

/**
 * Optional **pull** capability: a renderer/devtool reads it lazily (e.g. when
 * a developer drills into a document) — it is NOT pushed through the
 * observation bus. Substrates that can answer cheaply implement it; others
 * omit it and `hasDevtoolsHistory` returns false (graceful absence, exactly
 * like {@link TREE_NODE_ALLOCATE}).
 */
export interface DevtoolsHistory {
  /** A cheap version/op summary of this replica. */
  summary(): DevtoolsHistorySummary
  /**
   * Materialize the document value at a past `version` (as produced by
   * `Version.serialize()`), WITHOUT mutating the live replica. Optional —
   * substrates that cannot time-travel safely omit it.
   */
  valueAt?(version: string): unknown
}

/** Symbol under which a replica/substrate exposes {@link DevtoolsHistory}. */
export const DEVTOOLS_HISTORY: unique symbol = Symbol.for(
  "kyneta:devtools-history",
) as any

/** Marker for replicas/substrates that implement {@link DEVTOOLS_HISTORY}. */
export interface HasDevtoolsHistory {
  readonly [DEVTOOLS_HISTORY]: DevtoolsHistory
}

/** Returns `true` if `value` exposes the DevTools history capability. */
export function hasDevtoolsHistory(
  value: unknown,
): value is HasDevtoolsHistory {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    DEVTOOLS_HISTORY in (value as object)
  )
}

export { computeSchemaHash, HASH_ALGORITHM_VERSION } from "./hash.js"

// ---------------------------------------------------------------------------
// Version — external version marker
// ---------------------------------------------------------------------------

/**
 * A Version is a version marker for a substrate's state.
 *
 * `Version` is the external version concept — the one peers exchange,
 * serialize into HTML meta tags, and compare to determine ordering.
 *
 * For a plain JS substrate, this wraps a monotonic integer.
 * For a Loro substrate, this would wrap a VersionVector.
 *
 * Substrates may use richer internal version tracking beyond what
 * Version exposes. The Version is what crosses the substrate boundary.
 *
 * Versions form a partial order: plain substrates are totally ordered
 * (no concurrency), CRDT substrates may have concurrent versions.
 */
export interface Version {
  /** Serialize for embedding in HTML (meta tags, script tags). */
  serialize(): string

  /**
   * Compare with another version.
   * - "behind": this version is strictly behind other
   * - "equal": same version
   * - "ahead": this version is strictly ahead of other
   * - "concurrent": neither is ahead (only possible with CRDT substrates)
   */
  compare(other: Version): "behind" | "equal" | "ahead" | "concurrent"

  /**
   * Greatest lower bound (lattice meet) of two versions.
   *
   * For a total order, this is `min(this, other)`.
   * For a partial order (version vectors), this is the component-wise minimum.
   *
   * Algebraic properties:
   * - Commutative: `a.meet(b) = b.meet(a)`
   * - Associative: `a.meet(b.meet(c)) = a.meet(b).meet(c)`
   * - Idempotent: `a.meet(a) = a`
   * - Lower bound: `a.meet(b) ≤ a` and `a.meet(b) ≤ b`
   */
  meet(other: Version): Version
}

// ---------------------------------------------------------------------------
// SubstratePayload — opaque transfer format
// ---------------------------------------------------------------------------

/**
 * An opaque payload produced by a substrate for transfer to another peer.
 *
 * The sync/SSR layer never inspects the contents — only the substrate
 * knows how to produce and consume these.
 *
 * `kind` is a discriminant set by the producer:
 * - `"entirety"` — self-sufficient payload (reconstruct from ∅).
 *   Produced by `exportEntirety()`. For Plain: a state image.
 *   For Loro/Yjs: the complete oplog.
 * - `"since"` — relative payload (catch up from a version).
 *   Produced by `exportSince(v)`. For Plain: a log suffix of ops.
 *   For Loro/Yjs: the set difference of operations.
 *
 * Routing table:
 *   exportEntirety() → SubstratePayload { kind: "entirety" } → factory.fromEntirety() or replica.merge()
 *   exportSince(v)   → SubstratePayload { kind: "since" }    → replica.merge()
 *
 * The `encoding` hint tells the transport layer whether the data is
 * text-safe (JSON) or binary (needs base64 for text contexts).
 */
export interface SubstratePayload {
  readonly kind: "entirety" | "since"
  readonly encoding: "json" | "binary"
  readonly data: string | Uint8Array
}

// ---------------------------------------------------------------------------
// ReplicaLike — variance-safe replica contract (no type parameter)
// ---------------------------------------------------------------------------

/**
 * The minimal replica contract — what the synchronizer needs.
 *
 * All version-typed positions use the base {@link Version} type so the
 * synchronizer can hold heterogeneous replicas in a single `Map` without
 * variance escapes. Concrete replicas narrow the return types via
 * {@link Replica}, which extends this interface.
 *
 * Named after the `-Like` convention (`PromiseLike`, `ArrayLike`):
 * a structural interface that the full `Replica<V>` satisfies.
 */
export interface ReplicaLike {
  /** Current version marker. */
  version(): Version

  /**
   * The earliest version this replica can serve incremental exports for.
   *
   * Initially the zero version (no history trimmed). After `advance(to)`,
   * this returns the version at which retained history begins.
   *
   * Invariant: `baseVersion() ≤ version()` (via `compare`).
   *
   * `exportSince(v)` returns `null` for `v < baseVersion()`.
   */
  baseVersion(): Version

  /**
   * Trim history, advancing the base as far as possible without exceeding `to`.
   *
   * Precondition: `baseVersion() ≤ to ≤ version()`, or throws.
   *
   * Postcondition: `baseVersion() <= to` — the substrate trims conservatively.
   * Plain lands exactly at `to`. Loro may undershoot to the nearest critical
   * version at or before `to`. Yjs and LWW are no-ops unless `to = version()`.
   * The caller checks `baseVersion()` after the call to see where the base
   * actually landed.
   *
   * After advance:
   * - `exportSince(v)` returns `null` for `v < baseVersion()`
   * - `exportEntirety()` returns the trimmed document (base + remaining log)
   *
   * This undershoot convention is essential for LCV safety: `advance(lcv)`
   * guarantees no peer is stranded because the base never exceeds the
   * safe frontier.
   */
  advance(to: Version): void

  /**
   * Self-sufficient payload — everything needed to construct an
   * equivalent replica from nothing via `ReplicaFactory.fromEntirety()`.
   *
   * For Plain: JSON-serialized store (a state image).
   * For Loro/Yjs: the complete oplog.
   *
   * Always produces `{ kind: "entirety", ... }`.
   */
  exportEntirety(): SubstratePayload

  /**
   * Relative payload — what a peer at version `since` is missing.
   *
   * Returns null if the relative export is not possible (e.g. version
   * too old, log compacted, or nothing to send).
   *
   * For Plain: JSON-serialized Op[] from the version log.
   * For Loro/Yjs: ops not in the peer's version vector.
   *
   * Always produces `{ kind: "since", ... }` when non-null.
   */
  exportSince(since: Version): SubstratePayload | null

  /**
   * Merge a payload into this live replica.
   *
   * Accepts both `"entirety"` and `"since"` payloads. The replica
   * determines how to integrate the incoming data based on its own
   * structure and the payload's `kind` discriminant:
   *
   * Oplog substrates (Loro, Yjs): set union — idempotent, commutative.
   *   Handles both payload kinds identically via `doc.import()`.
   *
   * State-image substrates (Plain): dispatches on `payload.kind`.
   *   `"since"` → apply ops incrementally.
   *   `"entirety"` → decompose state image to ReplaceChange ops.
   *
   * For a full Substrate, merge also fires the changefeed so that
   * subscribers observe the incoming mutations. For a bare Replica,
   * no changefeed exists — merge only updates internal state and version.
   *
   * Accepts `options?: BatchOptions`. The substrate internally sets
   * `replay: true` on the resulting `executeBatch` so the changefeed's
   * `Changeset.replay` field surfaces "this batch was authored
   * elsewhere" to consumers like the exchange's echo filter.
   */
  merge(payload: SubstratePayload, options?: BatchOptions): void
}

// ---------------------------------------------------------------------------
// Replica<V> — replication surface (schema-free)
// ---------------------------------------------------------------------------

/**
 * The replication surface of a document.
 *
 * Extends {@link ReplicaLike} with concrete version types. External
 * consumers use this for compile-time version-type safety; the
 * synchronizer uses the wider {@link ReplicaLike} to avoid variance
 * issues with heterogeneous replica maps.
 *
 * A Replica holds the state needed for convergent state transfer between
 * peers: version tracking, snapshot export, incremental delta export,
 * and delta import. It does NOT provide schema-driven reads, writes, or
 * the changefeed — those require the full `Substrate`.
 *
 * Two responsibilities:
 * 1. Track versioning via Version
 * 2. Export/import state for replication (sync, storage, relay)
 *
 * Replicas are the minimal capability for conduit participants:
 * - Storage adapters use replicas for compaction (accumulate deltas,
 *   export a consolidated snapshot).
 * - Routing servers use replicas for per-peer delta computation
 *   (accumulate state from multiple peers, export deltas relative
 *   to each downstream peer's version).
 *
 * For causal substrates (Loro, Yjs), creating a replica requires the
 * CRDT runtime but NOT a schema. For authoritative/LWW substrates, a
 * replica is a plain JS object with an op log — no external runtime.
 */
export interface Replica<V extends Version = Version> extends ReplicaLike {
  /** Current version marker. */
  version(): V

  /**
   * The earliest version this replica can serve incremental exports for.
   *
   * Initially the zero version (no history trimmed). After `advance(to)`,
   * this returns the version at which retained history begins.
   *
   * Invariant: `baseVersion() ≤ version()` (via `compare`).
   *
   * `exportSince(v)` returns `null` for `v < baseVersion()`.
   */
  baseVersion(): V

  // exportSince, advance, merge inherited from ReplicaLike (accept Version)
}

// ---------------------------------------------------------------------------
// BatchOptions — BatchMetadata + the upstream-only `compensating` directive
// ---------------------------------------------------------------------------

/**
 * Batch-level metadata threaded through the prepare/flush pipeline.
 *
 * Extends {@link BatchMetadata} (the four user/kyneta-visible fields that
 * also surface on `Changeset`) with one upstream-only directive:
 *
 * - `compensating` — kyneta-internal directive set when the prepare is
 *   running under the **undo-replay handler** of the bracket primitive
 *   (`ctx.runBatch` is one bracket primitive with three handlers —
 *   substrate, flush, inverse stack). `compensating: true` signals "this
 *   prepare is replaying an inverse, not applying a new forward change."
 *   Substrates skip inverse recording when set; recording an inverse of
 *   an inverse would re-emit the original forward change and loop.
 *   Conceptually not a property of the change but a "which handler am I
 *   under?" signal. User-facing APIs never set it; only the abort path
 *   inside `WritableContext.runBatch` sets it on the prepares it issues
 *   during inverse replay. Lives upstream-only — never surfaces on the
 *   delivered Changeset.
 *
 * `compensating` is the directive flag on the *prepare* of an inverse op;
 * `aborted` (inherited from `BatchMetadata`) is the directive flag on the
 * *flush* that delivers the resulting Changeset. They are siblings, not
 * synonyms — both end up `true` on a fully-aborted outermost batch, but a
 * `compensating` op without an `aborted` flush is what an *inner* caught
 * abort looks like from the outermost frame.
 *
 * Context: jj:qpultxsw (origin/replay), jj:ryquprut (compensating/aborted),
 * jj:wpvtoxmw (source).
 */
export interface BatchOptions extends BatchMetadata {
  /** Kyneta-internal directive: this prepare is running under the
   *  undo-replay handler of `WritableContext.runBatch`. Substrates skip
   *  inverse recording. Set only by the abort path inside `runBatch`. */
  readonly compensating?: boolean

  /**
   * Kyneta-internal directive: this prepare is a **local projection**
   * (e.g. time-decay via `substrate.tick()`), not a real write.
   *
   * State substrates that maintain a separate `PlainState` shadow use
   * this to skip mutating the underlying CRDT math (`applyChangeToStateTree`)
   * and to skip bumping the version clock — only the local-facing shadow
   * moves. Always paired with `replay: true` so the Exchange does not
   * broadcast the projection to peers.
   *
   * Set only by `substrate.tick()`; never surfaces on user-facing writes.
   */
  readonly projection?: boolean
}

// ---------------------------------------------------------------------------
// RECORD_INVERSE — internal callback for substrate→bracket inverse recording
// ---------------------------------------------------------------------------

/**
 * Internal-only symbol that `buildWritableContext` attaches to every
 * `prepare` invocation's options. The substrate calls it after computing
 * the inverse of a forward change, passing `(path, inverse)`. The
 * receiving closure pushes onto the active runBatch frame's inverse stack.
 *
 * Not part of the public `BatchOptions` interface — substrates and the
 * ctx wrapper coordinate through this symbol on the options bag, keeping
 * the public surface clean.
 *
 * Context: jj:ryquprut (three-primitive substrate refactor).
 */
export const RECORD_INVERSE: unique symbol = Symbol.for(
  "kyneta:record-inverse",
) as any

/**
 * The shape of the inverse-recording callback threaded through prepare
 * options under the `RECORD_INVERSE` symbol key.
 */
export type RecordInverseFn = (path: Path, inverse: ChangeBase) => void

// ---------------------------------------------------------------------------
// SubstratePrepare — mutation primitives for the WritableContext
// ---------------------------------------------------------------------------

/**
 * The mutation primitives a substrate exposes to the WritableContext.
 *
 * `prepare` applies a single addressed delta to the substrate's state.
 * `afterBatch` is a post-batch lifecycle hook — called once at the end
 * of every `executeBatch`, for both local-write and replay batches. It
 * is *not* a buffer-drain (the eager-prepare model removes prepare-time
 * buffers); on CRDT substrates it now flushes coalescing buffers and
 * re-materialises the shadow on replay.
 *
 * `runBatch` (optional) is the *transaction-boundary bracket* for local
 * writes — it wraps the entire prepare-loop + flush block from
 * `executeBatch`. CRDT substrates use this seam to install their native
 * transaction primitive (Loro: a single `doc.commit()` after the body;
 * Yjs: `Y.transact(doc, body, KYNETA_ORIGIN)`) at the right scope so
 * external observers see one batched event per logical user action.
 * Substrates that don't need a bracket (Plain) omit it; the caller
 * falls back to invoking the body directly.
 *
 * All methods accept `options?: BatchOptions`:
 * - `options?.origin` is opaque label, substrate-passthrough only (Loro
 *   uses it for commit messages; plain ignores).
 * - `options?.replay === true` means "this batch represents state
 *   authored elsewhere; substrates with external mutation paths skip
 *   native-side work." The plain substrate ignores `replay` because it
 *   has no out-of-band mutation path. Replay batches *bypass* `runBatch`
 *   entirely — the bracket is for local writes only.
 *
 * These are the ground floor of the prepare/flush pipeline. Caching and
 * changefeed layers wrap them — the substrate never needs to know about
 * those layers.
 */
export interface SubstratePrepare {
  /** The readable reader for the interpreter's RefContext. */
  readonly reader: Reader

  /** Apply a single (path, change) to the backing state. */
  prepare(path: Path, change: ChangeBase, options?: BatchOptions): void

  /**
   * Post-batch lifecycle hook — called once at the end of every
   * `executeBatch`, after all prepares and before changefeed
   * notification delivery (so subscribers see the updated version/log).
   *
   * For PlainSubstrate: bumps version, appends to operation log.
   * For CRDT substrates: flushes any prepare-time coalescing buffer
   * on local writes; re-materialises the shadow from the native doc
   * on replay.
   */
  afterBatch(options?: BatchOptions): void

  /**
   * Optional transaction-boundary bracket for local-write batches.
   *
   * `executeBatch` invokes `runBatch(work, options)` when present
   * (skipping it for replay batches). `work` is the prepare-loop +
   * `ctx.flush` block. CRDT substrates use this to install their
   * native transaction primitive at the right scope:
   *
   * - Loro: increment a depth counter; on outermost release (depth
   *   returns to 0) run `doc.commit()` once — collapses nested
   *   `batch()` re-entries into one Loro commit.
   * - Yjs: `Y.transact(doc, work, KYNETA_ORIGIN)` — Yjs's native
   *   transact nesting handles the collapse for free.
   *
   * Substrates that omit this method get the trivial default
   * (caller just calls `work()`); PlainSubstrate is the canonical
   * no-op case.
   */
  runBatch?(work: () => void, options?: BatchOptions): void
}

// ---------------------------------------------------------------------------
// Substrate<V> — interpretation + replication (schema-aware)
// ---------------------------------------------------------------------------

/**
 * A Substrate holds document state and defines both its interpretation
 * and transfer semantics.
 *
 * Extends `Replica<V>` with the schema-driven interpretation surface:
 * readable reader, writable context, prepare/flush pipeline. This is the
 * full-stack interface required by participants that read, write, or
 * observe document state (clients, application servers with game logic,
 * etc.).
 *
 * Responsibilities:
 * 1. Provide a readable reader + WritableContext for the interpreter stack
 *    (from SubstratePrepare: reader, prepare, afterBatch, runBatch?)
 * 2. Track versioning via Version (from Replica)
 * 3. Export/import state for replication (from Replica)
 *
 * The substrate fires the `project` morphism automatically: after any
 * mutation (local or imported), the resulting Ops are delivered through
 * the CHANGEFEED attached by the interpreter's changefeed layer.
 *
 * Two kinds of state absorption:
 * - `merge(payload)` absorbs a payload into a live substrate using
 *   native merge semantics, preserving ref identity and firing the
 *   changefeed. This is the normal sync path.
 * - `factory.fromEntirety(payload, schema)` constructs a NEW substrate
 *   for cold-start scenarios (SSR, first load, schema migration).
 *   No continuity with any prior instance.
 */
export interface Substrate<V extends Version = Version>
  extends Replica<V>,
    SubstratePrepare {
  /** The readable reader for the interpreter (from SubstratePrepare). */
  readonly reader: Reader

  /** Build a WritableContext for this substrate. */
  context(): WritableContext

  /**
   * Optional pure function to advance time-based projections.
   * If implemented, the Exchange will call this on a periodic interval.
   */
  tick?(now: number): void
}

// ---------------------------------------------------------------------------
// ReplicaType — substrate identity tuple
// ---------------------------------------------------------------------------

/**
 * Identifies the binary format a replica produces and consumes.
 *
 * `[name, major, minor]` — semver-like tuple:
 * - `name`: the CRDT runtime ("yjs", "loro", "plain")
 * - `major`: breaking format change (incompatible payloads)
 * - `minor`: backwards-compatible extension
 *
 * Two replicas are compatible iff `name` matches AND `major` matches.
 * Minor version differences are tolerated (the newer side may produce
 * richer payloads, but the older side can still decode them).
 */
export type ReplicaType = readonly [name: string, major: number, minor: number]

/**
 * Check whether two ReplicaType tuples are compatible.
 *
 * Compatible means: same name AND same major version.
 * Minor version differences are allowed.
 */
export function replicaTypesCompatible(
  a: ReplicaType,
  b: ReplicaType,
): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

// ---------------------------------------------------------------------------
// SyncMode — structured sync mode
// ---------------------------------------------------------------------------

/** Who can write to this document? */
export type WriterModel = "serialized" | "concurrent"

/** What's sent over the wire? */
export type Delivery = "delta-capable" | "snapshot-only"

/** Is this document persisted? */
export type Durability = "persistent" | "transient"

/**
 * The sync mode for a document — decomposed into three independent axes
 * so each dispatch site in the exchange can match on exactly the field it
 * cares about.
 */
export interface SyncMode {
  readonly writerModel: WriterModel
  readonly delivery: Delivery
  readonly durability: Durability
}

/** Authoritative: serialized writes, delta-capable, persistent. Used by `json`. */
export const SYNC_AUTHORITATIVE: SyncMode = {
  writerModel: "serialized",
  delivery: "delta-capable",
  durability: "persistent",
} as const

/** Collaborative: concurrent CRDT writes, delta-capable, persistent. Used by `loro`, `yjs`. */
export const SYNC_COLLABORATIVE: SyncMode = {
  writerModel: "concurrent",
  delivery: "delta-capable",
  durability: "persistent",
} as const

/** Ephemeral: concurrent LWW writes, snapshot-only, transient. Used by `ephemeral`. */
export const SYNC_EPHEMERAL: SyncMode = {
  writerModel: "concurrent",
  delivery: "snapshot-only",
  durability: "transient",
} as const

/**
 * Does this mode require bidirectional state exchange (causal merge)?
 *
 * True for collaborative CRDTs (concurrent + delta-capable).
 * False for ephemeral LWW (concurrent + snapshot-only) — unidirectional push suffices.
 * False for authoritative (serialized + delta-capable) — request/response, not exchange.
 */
export function requiresBidirectionalSync(mode: SyncMode): boolean {
  return mode.writerModel === "concurrent" && mode.delivery === "delta-capable"
}

// ---------------------------------------------------------------------------
// DocMetadata — per-document metadata
// ---------------------------------------------------------------------------

/**
 * Per-document metadata — the replicaType + syncMode pair.
 *
 * Used in StorageBackend, PresentMsg, DocEntry, cmd/ensure-doc,
 * and onDocDiscovered. Named as a first-class type because it appears
 * across storage, wire protocol, synchronizer model, and public API.
 */
export type DocMetadata = {
  readonly replicaType: ReplicaType
  readonly syncMode: SyncMode
  readonly schemaHash: string
  readonly supportedHashes?: readonly string[]
}

// ---------------------------------------------------------------------------
// ReplicaFactoryLike — variance-safe factory contract (no type parameter)
// ---------------------------------------------------------------------------

/**
 * The minimal replica-factory contract — what the synchronizer needs.
 *
 * Named after the `-Like` convention: a structural interface that
 * {@link ReplicaFactory} satisfies.
 */
export interface ReplicaFactoryLike {
  /** Identifies the binary format this factory produces and consumes. */
  readonly replicaType: ReplicaType

  /** Create a fresh, empty replica. No schema needed. */
  createEmpty(): ReplicaLike

  /**
   * Construct a replica from a self-sufficient payload.
   *
   * The payload must have been produced by `exportEntirety()` on a
   * compatible replica or substrate. No schema needed — the payload
   * is self-describing for replication purposes.
   */
  fromEntirety(payload: SubstratePayload): ReplicaLike

  /** Deserialize a version from its string representation. */
  parseVersion(serialized: string): Version
}

// ---------------------------------------------------------------------------
// ReplicaFactory<V> — schema-free construction
// ---------------------------------------------------------------------------

/**
 * Factory for constructing replicas without a schema.
 *
 * Extends {@link ReplicaFactoryLike} with concrete version types.
 *
 * This is the minimal factory needed by conduit participants (storage
 * adapters, routing servers). It constructs headless replicas that
 * support replication operations but not schema-driven interpretation.
 *
 * For Loro: `createEmpty()` creates a bare `LoroDoc()` — no schema
 * walking, no container initialization. `fromSnapshot()` creates a
 * `LoroDoc()` and imports the payload. Both return replicas that
 * support `version()`, `exportSnapshot()`, `exportSince()`, and
 * `merge()` but NOT `store`, `prepare`, `afterBatch`, `runBatch?`, or `context()`.
 *
 * For Plain: `createEmpty()` creates a fresh store with an empty op log.
 * `fromEntirety()` parses the JSON state image into a store.
 */
export interface ReplicaFactory<V extends Version = Version>
  extends ReplicaFactoryLike {
  /** Identifies the binary format this factory produces and consumes. */
  readonly replicaType: ReplicaType

  /** Create a fresh, empty replica. No schema needed. */
  createEmpty(): Replica<V>

  /**
   * Construct a replica from a self-sufficient payload.
   *
   * The payload must have been produced by `exportEntirety()` on a
   * compatible replica or substrate. No schema needed — the payload
   * is self-describing for replication purposes.
   */
  fromEntirety(payload: SubstratePayload): Replica<V>

  /** Deserialize a version from its string representation. */
  parseVersion(serialized: string): V
}

// ---------------------------------------------------------------------------
// SubstrateFactory<V> — schema-aware construction
// ---------------------------------------------------------------------------

/**
 * Factory for constructing substrates from schemas.
 *
 * This is the full factory needed by interpreter participants (clients,
 * application servers). It constructs substrates that support both
 * schema-driven interpretation AND replication.
 *
 * Every SubstrateFactory provides a `replica` accessor that returns
 * the corresponding `ReplicaFactory` — the schema-free subset. This
 * enables conduit participants to receive just the `ReplicaFactory`
 * without depending on the schema infrastructure.
 */
export interface SubstrateFactory<V extends Version = Version> {
  /**
   * Create a bare replica with no schema, no identity, no structural
   * initialization. Safe for hydration — no local writes.
   *
   * The backing CRDT document (Y.Doc, LoroDoc) is created with a
   * default/random identity. For Plain/LWW, the backing store is
   * an empty `PlainState`.
   *
   * Use `upgrade(replica, schema)` after hydration to transition
   * the replica into a full Substrate.
   *
   * Context: jj:smmulzkm (two-phase substrate construction)
   */
  createReplica(): Replica<V>

  /**
   * Transition a hydrated replica into a full Substrate.
   *
   * The factory has the peerId (from the FactoryBuilder closure) and
   * knows the concrete backing document type (because it produced the
   * replica via `createReplica()`). The upgrade:
   *
   * 1. Sets peer identity on the underlying CRDT document (identity
   *    must be set **after** hydration to avoid Yjs clientID conflict
   *    detection).
   * 2. Conditionally creates structural containers for schema fields
   *    that don't already exist (skip containers present from hydrated
   *    state).
   * 3. Returns a Substrate wrapping the same backing document with the
   *    full interpreter surface.
   *
   * @param replica - A replica previously created by `createReplica()`
   *   on this factory (or a compatible one).
   * @param schema - The root schema for the document.
   *
   * Context: jj:smmulzkm (two-phase substrate construction)
   */
  upgrade(replica: Replica<V>, schema: SchemaNode): Substrate<V>

  /**
   * Create a fresh substrate from a schema.
   *
   * Convenience that composes `upgrade(createReplica(), schema)`.
   * Useful for tests and standalone scripts that don't need the
   * two-phase lifecycle. Store starts with Zero.structural defaults.
   */
  create(schema: SchemaNode): Substrate<V>

  /**
   * Construct a new substrate from a self-sufficient payload.
   *
   * The payload must have been produced by `exportEntirety()` on a
   * compatible substrate. This always creates a NEW substrate — it
   * does not mutate an existing one.
   *
   * This is the entry point for cold-start construction: SSR hydration,
   * reconnection past log compaction, etc. For live absorption into an
   * existing replica, use `replica.merge()` instead.
   *
   * For PlainSubstrate: parses JSON state image, applies via executeBatch.
   * For LoroSubstrate: LoroDoc.fromSnapshot(bytes).
   */
  fromEntirety(payload: SubstratePayload, schema: SchemaNode): Substrate<V>

  /** Deserialize a version from its string representation. */
  parseVersion(serialized: string): V

  /**
   * The schema-free replication factory.
   *
   * Returns a `ReplicaFactory` that constructs headless replicas
   * without requiring a schema. Used by conduit participants (storage
   * adapters, routing servers) that handle replication but don't
   * interpret document state.
   *
   * The returned factory constructs `Replica<V>` instances — not
   * full `Substrate<V>` instances. Replicas support versioning and
   * export/import but not the prepare/flush pipeline or changefeed.
   */
  replica: ReplicaFactory<V>
}
