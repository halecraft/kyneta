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
 * Factories recover the backing state via `hasBackingDoc(replica)`, naming
 * the concrete type they know they created.
 *
 * Exported from the barrel for substrate packages (`@kyneta/loro-schema`,
 * `@kyneta/yjs-schema`) that need it in their `upgrade()` methods.
 * Not part of the public API.
 *
 * Context: jj:smmulzkm (two-phase substrate construction)
 */
export const BACKING_DOC: unique symbol = Symbol.for("kyneta:backingDoc")

/**
 * An object carrying its substrate-specific backing state under
 * `[BACKING_DOC]`.
 *
 * `D` is the backing type — `PlainState`, `Y.Doc`, `LoroDoc` — and is
 * **not checked at runtime**, because there is nothing generic to check it
 * against: the whole point of the symbol is that each substrate stores
 * something only it understands. The guard verifies the slot exists; naming
 * `D` is the caller stating which substrate's replica it is holding, and it
 * is the caller's job to be right about that. `hasChangefeed` takes its type
 * parameters on the same terms.
 */
export interface HasBackingDoc<D = unknown> {
  readonly [BACKING_DOC]: D
}

/**
 * Returns `true` if `value` carries a `[BACKING_DOC]` property.
 *
 * @see HasBackingDoc for why `D` is an assertion rather than a check.
 */
export function hasBackingDoc<D = unknown>(
  value: unknown,
): value is HasBackingDoc<D> {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "function") &&
    BACKING_DOC in (value as object)
  )
}

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
)

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
)

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
  /**
   * The causal island this version belongs to. Versions from different
   * lineages are incommensurable — `compare()` is only meaningful within
   * one lineage. The Synchronizer gates on lineage equality before invoking
   * `compare()`.
   */
  readonly lineage: string

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

  /**
   * Least upper bound (lattice join): the least version that holds
   * everything either holds.
   *
   * Laws, for versions of one lineage:
   * - Commutative, associative, idempotent.
   * - Upper bound: `a ≤ a.join(b)` and `b ≤ a.join(b)`.
   * - Absorption: `a.meet(a.join(b)) = a` and `a.join(a.meet(b)) = a`.
   *
   * Two versions of different real lineages have no join (a replica holds
   * one lineage); implementations throw.
   */
  join(other: Version): Version
}

/**
 * Whether `ours` holds everything `theirs` does: `ours` is ahead of or equal
 * to `theirs`.
 *
 * The one test of holding a version. It never reads a digest: a digest
 * answers only "equal", and a replica that took an offer and holds more of
 * its own must still reach it.
 */
export function reaches(ours: Version, theirs: Version): boolean {
  const order = ours.compare(theirs)
  return order === "ahead" || order === "equal"
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

  /**
   * The causal island (see {@link Version.lineage}) this payload was
   * produced under, if the producing substrate tracks lineages explicitly
   * (Plain always sets this; Loro/Yjs set it to `DEFAULT_LINEAGE`).
   */
  readonly lineage?: string
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
   * A `to` the base has already passed, or one this replica cannot place in
   * its history (another lineage, or genesis), trims nothing. A `to` beyond
   * `version()` throws.
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
   * Returns `null` only when the cursor cannot be served: history trimmed
   * past it. A peer that is merely current gets an empty delta, never `null`,
   * because the caller answers `null` with the whole document.
   *
   * For Plain: the logged batches after `since`, with the log position they
   * start from; the whole document for a cursor the log cannot continue
   * (another lineage, or genesis).
   * For Loro/Yjs: ops not in the peer's version vector.
   */
  exportSince(since: Version): SubstratePayload | null

  /**
   * A fingerprint of everything this replica would replicate, or `undefined`
   * when the version already answers equality.
   *
   * Only substrates whose version cannot say "equal" need one. A version
   * vector compares two replicas exactly, so Plain, Loro and Yjs (whose delete
   * clock makes every change advance its state vector) return nothing and
   * mean it: *ask my version*. The ephemeral substrate's version is an install
   * counter — a fact about itself, meaningless to a peer — so it answers here
   * instead.
   *
   * Equal fingerprints must mean equal replicated state, and must not depend
   * on the order state arrived in or on anything local. Two peers that
   * converged by opposite routes have to agree, or they will resync forever
   * while each looks correct.
   */
  digest?(): string | undefined

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
   * Plain: a payload names its log position. A delta that continues what
   *   the replica holds appends the batches it lacks; one that starts past
   *   it is refused, and nothing is applied. A whole document ahead of the
   *   replica is adopted at its position.
   *
   * Whether the payload was taken in is whether the replica's version now
   * reaches the version it was offered at (`reaches`): a refused plain delta,
   * or CRDT ops held back for a missing dependency, leave it short.
   *
   * A full Substrate then brings σ into agreement with λ and announces the
   * ops, so subscribers receive them with `Changeset.replay: true`. A bare
   * Replica has no changefeed and only updates its state and version.
   */
  merge(payload: SubstratePayload, options?: MergeOptions): void

  /**
   * Discard local history and adopt an entirely new state and lineage.
   *
   * Called exclusively on the lineage-boundary path, when an incoming
   * payload's lineage differs from this replica's current lineage (see
   * {@link Version.lineage}). Unlike `merge()` — which assumes the incoming
   * payload shares causal ancestry with local state — `resetFromEntirety`
   * assumes no shared ancestry: local history is discarded, not merged.
   *
   * @param payload A SubstratePayload where `kind === "entirety"`. It says
   *   everything the replica takes on, its version included.
   */
  resetFromEntirety(payload: SubstratePayload, options?: MergeOptions): void
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
// Batch options — how a batch reached the changefeed
// ---------------------------------------------------------------------------

/**
 * How a batch reached the changefeed.
 *
 * - `author` — a local Kyneta writer (`batch`, `applyChanges`, a ref helper).
 *   The substrate applies it inside the `runBatch` bracket.
 * - `announce` — the substrate took the ops in by another route (a merge, a
 *   native event, a decay tick) and has already made λ and σ agree. The batch
 *   only tells the changefeed what happened; the substrate never sees it.
 *
 * `Changeset.replay` is `ingress !== "author"`.
 */
export type BatchIngress = "author" | "announce"

/**
 * How one op reached `ctx.prepare`. `compensate` is an inverse replayed by the
 * abort path of an `author` batch; the substrate applies it without recording
 * an inverse of its own.
 */
export type PrepareIngress = BatchIngress | "compensate"

/**
 * Options for a local writer: `batch`, `applyChanges`, and the `runBatch`
 * bracket. Both fields surface unchanged on the delivered `Changeset`.
 */
export interface CommitOptions {
  /**
   * App-level provenance label attached to the emitted `Changeset`.
   *
   * Subscribers receive this as `changeset.origin` — useful for
   * categorizing batches (`"sync"`, `"undo"`, `"migration"`, etc.).
   * The schema layer and the exchange never branch on its value.
   * For kyneta-internal echo suppression use {@link CommitOptions.source}.
   *
   * @example
   * applyChanges(doc, ops, { origin: "sync" })
   */
  readonly origin?: string
  /**
   * Identity-typed echo-suppression token. Propagates to
   * `Changeset.source`. Compared with `===` by subscribers that issued
   * the change.
   *
   * @example
   * const mySource = Symbol("my-binding")
   * batch(ref, fn, { source: mySource })
   * cf.subscribe(cs => { if (cs.source === mySource) return; / apply / })
   */
  readonly source?: unknown
}

/**
 * Options for `merge` and `resetFromEntirety`. There is no `source`: an echo
 * token names a local caller and never survives a merge.
 */
export interface MergeOptions {
  /** App-level provenance label for the announced `Changeset`. */
  readonly origin?: string
}

/**
 * Batch-level options: what a sealed batch (`SealedBatch.options`) carries
 * to `ctx.deliver`.
 *
 * Only an authored batch carries `source` or can be `aborted` (the outermost
 * `batch()` block threw and was compensated).
 */
export type BatchOptions =
  | (CommitOptions & {
      readonly ingress: "author"
      readonly aborted?: boolean
    })
  | { readonly ingress: "announce"; readonly origin?: string }

/** Per-op options, taken by `ctx.prepare`. */
export interface PrepareOptions {
  readonly ingress: PrepareIngress
}

/**
 * Records the inverse of a change on the active `runBatch` frame. The bracket
 * replays recorded inverses LIFO if the block throws.
 */
export type RecordInverseFn = (path: Path, inverse: ChangeBase) => void

// ---------------------------------------------------------------------------
// SubstratePrepare — mutation primitives for the WritableContext
// ---------------------------------------------------------------------------

/**
 * The mutation primitives a substrate exposes to the WritableContext.
 *
 * These see only local writes and their compensations. Every other change
 * (a merge, a native event, a decay tick) is applied by the substrate itself,
 * which then brings σ into agreement with λ and announces the ops through
 * `ctx.announce(ops, origin)`, which never calls back into `prepare` or
 * `afterBatch`.
 *
 * Caching and changefeed layers wrap the context built over these; the
 * substrate never needs to know about those layers.
 */
export interface SubstratePrepare {
  /** The readable reader for the interpreter's RefContext. */
  readonly reader: Reader

  /**
   * Apply one change to σ and λ. `recordInverse` is present for a forward
   * write: the substrate reads the pre-state at `path`, computes the inverse,
   * and records it before writing. It is `null` for a compensation, which
   * records nothing.
   */
  prepare(
    path: Path,
    change: ChangeBase,
    recordInverse: RecordInverseFn | null,
  ): void

  /**
   * End of an authored batch, called once when its outermost frame ends,
   * inside `runBatch`'s bracket and so before the native commit. Its work is
   * part of that commit, and subscribers, who run after it, see the updated
   * version and log.
   *
   * For PlainSubstrate: mints the lineage on the first authored flush and
   * logs the batch. For CRDT substrates: drains the coalescing buffer.
   */
  afterBatch(): void

  /**
   * Optional transaction-boundary bracket for authored batches.
   *
   * `WritableContext.runBatch` invokes it at the outermost depth transition,
   * around the prepare loop and the depth-0 flush. CRDT substrates install
   * their native transaction here, so external observers see one native event
   * per outermost logical action:
   *
   * - Loro: one `doc.commit()` after the body.
   * - Yjs: `Y.transact(doc, work, options.origin)`; Yjs collapses nested
   *   transacts on its own.
   *
   * Substrates that omit it (plain, ephemeral) get the body called directly.
   */
  runBatch?(work: () => void, options: CommitOptions): void
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
   * Heartbeat for time-based projections (ephemeral decay): re-project σ at
   * `now` and announce what moved. The `Runtime` calls it every
   * `tickInterval` milliseconds.
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

/**
 * Is this document persisted?
 *
 * `transient` is a commitment, not a hint. An exchange keeps such a document
 * out of durable storage in **both** directions: it is never read from a store
 * on open, never written on mutation, and never deleted on teardown.
 * Configuring stores does not change that, and there is no way to opt a
 * transient document into persistence.
 *
 * The tier exists because some state is a statement about *now*. Presence,
 * cursors and live input describe who is here at this moment, and such a
 * document may expire on a timer via `.decay()`. A restarted server
 * resurrecting yesterday's cursor positions would be worse than having none.
 *
 * Today only `SYNC_EPHEMERAL` — and so only the `ephemeral` binding target —
 * is transient.
 */
export type Durability = "persistent" | "transient"

/**
 * The sync mode for a document — decomposed into independent axes so each
 * dispatch site in the exchange can match on exactly the field it cares about.
 *
 * There were three. A `delivery` axis distinguished substrates that could send
 * a delta from those that could only send a snapshot, and once the ephemeral
 * substrate gained `exportSince` it had one value and discriminated nothing.
 * The two sites that branched on it wanted `durability` instead, which is what
 * they had always been reaching for through it.
 */
export interface SyncMode {
  readonly writerModel: WriterModel
  readonly durability: Durability
}

/** Authoritative: serialized writes, persistent. Used by `json`. */
export const SYNC_AUTHORITATIVE: SyncMode = {
  writerModel: "serialized",
  durability: "persistent",
} as const

/** Collaborative: concurrent CRDT writes, persistent. Used by `loro`, `yjs`. */
export const SYNC_COLLABORATIVE: SyncMode = {
  writerModel: "concurrent",
  durability: "persistent",
} as const

/** Ephemeral: concurrent LWW writes, transient. Used by `ephemeral`. */
export const SYNC_EPHEMERAL: SyncMode = {
  writerModel: "concurrent",
  durability: "transient",
} as const

/**
 * Does this mode require bidirectional state exchange (causal merge)?
 *
 * True wherever writes are concurrent: two peers that both write need to hear
 * each other, whatever they are storing. False for authoritative, which is
 * request/response rather than exchange.
 */
export function requiresBidirectionalSync(mode: SyncMode): boolean {
  return mode.writerModel === "concurrent"
}

// ---------------------------------------------------------------------------
// DocMetadata — per-document metadata
// ---------------------------------------------------------------------------

/**
 * What a document *is* — the three facts two peers must agree on before any
 * bytes can pass between them: how it is encoded (`replicaType`), how it
 * syncs (`syncMode`), and what shape it holds (`schemaHash`).
 *
 * A document has exactly one of each. Notably it does *not* have a set of
 * schema hashes: the set of shapes a *reader* can cope with belongs to the
 * reader, not to the thing being read — see {@link ReadCapability}.
 *
 * Appears across storage, the wire protocol, the synchronizer model, and the
 * public API, which is why it is a named type rather than an inline shape.
 */
export type DocMetadata = {
  readonly replicaType: ReplicaType
  readonly syncMode: SyncMode
  readonly schemaHash: string
}

/**
 * What a peer *can read* — a document's own facts, plus every ancestor shape
 * this peer's schema can still reach by walking its migration chains
 * backwards (see `computeSupportedHashes` in `migration.ts`).
 *
 * `supportedHashes` is **required** here, and that is load-bearing rather
 * than fussy. A read capability is always derived locally from a
 * `BoundSchema`, whose own `supportedHashes` is a required set — it never
 * arrives over the wire, so it is never absent. Requiring it is what lets the
 * compiler tell a reader apart from a document: a bare {@link DocMetadata}
 * cannot be passed where a `ReadCapability` is expected, so the argument
 * order of the *directional* law below cannot be silently reversed.
 */
export type ReadCapability = DocMetadata & {
  readonly supportedHashes: readonly string[]
}

// ---------------------------------------------------------------------------
// The two compatibility laws
// ---------------------------------------------------------------------------
//
// `supportedHashes` gets asked two different questions, and they have
// different answers. Keeping them apart is the whole point of this section.
//
//   interpretation — "can MY schema read a document written at this shape?"
//                    Look for that one shape in my own set. One-directional:
//                    swapping the two sides asks something else entirely.
//
//   sync           — "is there a shape we BOTH speak?"
//                    Look for any overlap between the two sets. Symmetric:
//                    either side may ask, and the answer is the same.
//
// The first implies the second, but not the reverse — and the gap is real, not
// a technicality. Picture two peers that both migrated away from a shared
// ancestor, in different directions: each still recognises the ancestor, so
// they overlap and can sync there. Neither has ever seen the shape the other
// currently writes, so neither can read the other's documents. Both answers
// are correct for their own question, and using one law to answer the other's
// question is a bug whichever way round you do it.

/**
 * Can a peer with this read capability take on data written at `hash`?
 *
 * Directional. `supportedHashes` is built by walking migration chains
 * *backwards*, so a newer schema reaches its own ancestors' shapes and never
 * the other way round — a V2 schema reads V1 documents, a V1 schema does not
 * read V2 documents. This is the question `exchange.get()` asks.
 *
 * One caveat, because the set is narrower than this function's name suggests.
 * `computeSupportedHashes` stops walking backwards at any migration step that
 * destroys field identities, so what it returns is "shapes I can exchange
 * *operations* at" — a stricter bar than "shapes I can read", since a shape
 * past that boundary could still be recovered by shipping the document whole.
 * The effect is that this predicate sometimes says no where reading would
 * have worked. That is the safe direction to be wrong in, and it is what
 * `resolveSchema` in `@kyneta/exchange` has always done.
 *
 * Those two notions are meant to become separate sets (§`supportedHashes` in
 * this package's TECHNICAL.md calls them `readSupports` and `nativeSupports`).
 * When they do, *this* law follows the looser one and {@link mismatchForSync}
 * keeps the stricter — so the two laws will then read different sets, not the
 * same set two ways. Worth knowing before anyone tries to merge them.
 */
export function supportsHash(reader: ReadCapability, hash: string): boolean {
  return reader.supportedHashes.includes(hash)
}

/**
 * Is there a shape both peers can take on?
 *
 * Symmetric, and *derived* rather than independent: syncing is interpreting,
 * at some shape the two of them happen to share. Every `reachable.has(h)`
 * below is one {@link supportsHash} question, asked once per shape the other
 * peer knows — the loop is the only thing this adds.
 */
function hashesIntersect(a: ReadCapability, b: ReadCapability): boolean {
  // The membership test is inlined against a Set rather than calling
  // `supportsHash` in the loop, purely to keep the O(1) lookup the sync
  // program used before this law was extracted. The sets are small either way
  // — `computeSupportedHashes` is a cartesian product over migration chains,
  // "dozens" for a realistic schema — but the original made that choice on
  // purpose, and a refactor should not quietly hand it back.
  const reachable = new Set(a.supportedHashes)
  return b.supportedHashes.some(h => reachable.has(h))
}

// ---------------------------------------------------------------------------
// Comparing two descriptions of the same document
// ---------------------------------------------------------------------------

/** Which axis of a document's metadata failed to line up. */
export type MetadataAxis = "replicaType" | "schemaHash" | "syncMode"

/**
 * The first axis on which two descriptions of a document disagreed, with both
 * offending values rendered for a human.
 *
 * `local` and `remote` are strings rather than the original values because
 * every consumer either logs them or puts them in an error; `@kyneta/exchange`
 * lifts them straight into its structured `Diagnostic` type.
 */
export type MetadataMismatch = {
  readonly axis: MetadataAxis
  readonly local: string
  readonly remote: string
}

/**
 * The two axes that mean the same thing to both laws. Factored out so the
 * pair cannot drift apart on the parts where they agree.
 *
 * `replicaType` is checked first, matching the order the sync program has
 * always used: if the bytes cannot be decoded at all, telling the reader
 * their *schema* disagrees points them at the wrong problem.
 */
function mismatchOnSharedAxes(
  local: DocMetadata,
  remote: DocMetadata,
): MetadataMismatch | undefined {
  if (!replicaTypesCompatible(local.replicaType, remote.replicaType)) {
    return {
      axis: "replicaType",
      local: JSON.stringify(local.replicaType),
      remote: JSON.stringify(remote.replicaType),
    }
  }
  if (
    local.syncMode.writerModel !== remote.syncMode.writerModel ||
    local.syncMode.durability !== remote.syncMode.durability
  ) {
    return {
      axis: "syncMode",
      local: JSON.stringify(local.syncMode),
      remote: JSON.stringify(remote.syncMode),
    }
  }
  return undefined
}

/**
 * Can `reader` take on `doc`? Returns the first axis that says no.
 *
 * All three axes are checked, and the `syncMode` one is not a stray: "to
 * interpret" here means *admission to the interpret tier* — the tier named
 * alongside replicate and deferred — not the narrow act of decoding bytes.
 * What a document must supply to enter that tier is not a matter of taste;
 * it is `DocReadyInfo` in `@kyneta/exchange`, whose three
 * compatibility-bearing fields are exactly these. One axis per precondition:
 * construct a substrate (`replicaType`), register for sync (`syncMode`),
 * bind a schema (`schemaHash`).
 *
 * The two parameters are deliberately different types. Passing them the wrong
 * way round would invert a directional law silently — newer-reads-older
 * becoming older-reads-newer — so `doc` being a bare {@link DocMetadata}
 * makes that a compile error instead. It also means `doc` has no
 * `supportedHashes` field to misuse: a document is read at the one shape it
 * was written at, and no set enters into it.
 */
export function mismatchForInterpretation(
  reader: ReadCapability,
  doc: DocMetadata,
): MetadataMismatch | undefined {
  const shared = mismatchOnSharedAxes(reader, doc)
  if (shared) return shared
  if (!supportsHash(reader, doc.schemaHash)) {
    return {
      axis: "schemaHash",
      local: reader.schemaHash,
      remote: doc.schemaHash,
    }
  }
  return undefined
}

/**
 * Can these two peers sync? Returns the first axis that says no.
 *
 * Same three axes as {@link mismatchForInterpretation}, for a different
 * reason: here they are the triple two peers must share to exchange ops at
 * all, rather than the preconditions for entering a tier. Both parameters are
 * read capabilities because sync compares two peers, each with its own range
 * of shapes.
 */
export function mismatchForSync(
  a: ReadCapability,
  b: ReadCapability,
): MetadataMismatch | undefined {
  const shared = mismatchOnSharedAxes(a, b)
  if (shared) return shared
  if (!hashesIntersect(a, b)) {
    return { axis: "schemaHash", local: a.schemaHash, remote: b.schemaHash }
  }
  return undefined
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

  /**
   * Whether this format keeps no history to trim: its state carries its whole
   * meaning, `advance` has nothing to do, and every cursor stays serviceable.
   *
   * Such a document is never compacted, so its receivers send no `accept`,
   * and a whole-document payload from it is never a compaction reset. It is
   * a property of the format, so every replica of one document agrees on it;
   * whether a particular replica can `advance` is not (a live Loro substrate
   * cannot, a relay's Loro replica can).
   */
  readonly historyFree: boolean

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
 * support `version()`, `exportEntirety()`, `exportSince()`, and
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
/**
 * A substrate, plus the obligation that comes with it.
 *
 * Returned by {@link beginHydration} rather than attached to the substrate as
 * an optional capability, so that a caller cannot obtain the substrate without
 * also being handed the thing it owes. A capability a caller must know to go
 * looking for can only be discharged by a caller who already knew.
 */
export type HydrationHandle<V extends Version = Version> = {
  readonly substrate: Substrate<V>
  /**
   * The document's own history has loaded. Claims this peer's stable identity
   * (Yjs, Loro) and allows authored writes (plain). Idempotent — safe to call
   * twice.
   */
  readonly adopt: () => void
}

/**
 * Build a substrate for a caller that is about to import this peer's own
 * history, and receive the obligation to call `adopt` afterwards.
 *
 * Falls back to `create()` plus a no-op `adopt` for backends that declare no
 * {@link SubstrateFactory.createForHydration}. That default lives here rather
 * than at the call site because it is a statement about the substrate
 * contract — *claiming immediately is safe when nothing will be imported* —
 * not a convenience for one consumer.
 */
export function beginHydration<V extends Version>(
  factory: SubstrateFactory<V>,
  schema: SchemaNode,
): HydrationHandle<V> {
  return (
    factory.createForHydration?.(schema) ?? {
      substrate: factory.create(schema),
      adopt: NOOP_ADOPT,
    }
  )
}

const NOOP_ADOPT = (): void => {}

export interface SubstrateFactory<V extends Version = Version> {
  /**
   * Create a bare replica with no schema, no identity, no structural
   * initialization. A replica has no write surface, so it can import stored
   * history without anything being written ahead of it.
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
   * **Also the mechanism behind a public transition.** `@kyneta/exchange` uses
   * this to promote a document it has been relaying headlessly — a bare
   * `Replica` with no schema — into a fully interpreted one, when a caller
   * supplies the schema it was missing. Because the returned substrate wraps
   * the same backing document, everything the replica accumulated carries
   * across.
   *
   * Step 1 above is why that transition has a precondition. Identity is
   * claimed here immediately, assuming any import has already finished —
   * which holds for two-phase construction, where `createReplica` hydrates
   * first. Promoting a document whose load is still in flight breaks that
   * assumption and loses operations to the collision
   * {@link SubstrateFactory.createForHydration} describes, so the exchange
   * refuses until loading completes. That refusal is required by this
   * ordering, not caution about it.
   *
   * @param replica - A replica previously created by `createReplica()`
   *   on this factory (or a compatible one).
   * @param schema - The root schema for the document.
   *
   * Context: jj:smmulzkm (two-phase substrate construction)
   */
  upgrade(replica: Replica<V>, schema: SchemaNode): Substrate<V>

  /**
   * Create a fresh substrate from a schema, ready to use.
   *
   * Convenience that composes `upgrade(createReplica(), schema)`.
   * Useful for tests and standalone scripts that don't need the
   * two-phase lifecycle. Store starts with Zero.structural defaults.
   *
   * **Claims this peer's identity immediately**, which is correct as long as
   * the caller is not about to import operations this same peer authored
   * earlier. A caller that *is* — a document being hydrated from storage —
   * must use {@link SubstrateFactory.createForHydration} instead; see the
   * note there for why the order matters.
   */
  create(schema: SchemaNode): Substrate<V>

  /**
   * Create a substrate for a caller that is about to import this peer's own
   * history — hydration from a store, principally.
   *
   * **Optional.** Implement it when claiming identity, or writing, on an
   * empty document would be unsafe once that document imports what it held
   * earlier. {@link beginHydration} supplies `create()` plus a no-op for
   * backends that leave it out.
   *
   * Whether it is unsafe follows from how the backend addresses operations.
   * Where an address is `(peer, counter)` and the counter restarts at zero on
   * a fresh document, a peer that claims its identity and then writes produces
   * operations at addresses its own stored history already occupies. Merge
   * deduplicates by address, so one of the two is discarded — silently, and
   * with no way to tell which was the real one.
   *
   * Both operation-log backends are in this position, and both implement this.
   * Neither defends itself adequately: Yjs notices the collision and reassigns
   * its id, which saves the data but costs the peer its identity, and Loro
   * does not notice at all.
   *
   * Plain is in a different position and implements it too. Its merge does
   * not commute with a local write, so a write made before its history loads
   * has no well-defined result: the loaded state overwrites it, and it mints
   * a lineage the store does not know. Its substrate refuses authored writes
   * until `adopt`. The ephemeral substrate needs nothing here: it is never
   * stored.
   *
   * The returned `adopt` is the obligation that comes with the substrate: call
   * it once the imports are finished and no further ones are outstanding.
   */
  createForHydration?(schema: SchemaNode): HydrationHandle<V>

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
   * For PlainSubstrate: `upgrade(replica.fromEntirety(payload), schema)`.
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
