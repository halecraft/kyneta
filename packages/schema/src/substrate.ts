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
import type { Schema as SchemaNode } from "./schema.js"
import type { Reader } from "./reader.js"

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
// Replica<V> — replication surface (schema-free)
// ---------------------------------------------------------------------------

/**
 * The replication surface of a document.
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
 * CRDT runtime but NOT a schema. For sequential/LWW substrates, a
 * replica is a plain JS object with an op log — no external runtime.
 */
export interface Replica<V extends Version = Version> {
  /** Current version marker. */
  version(): V

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
  exportSince(since: V): SubstratePayload | null

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
   */
  merge(payload: SubstratePayload, origin?: string): void
}

// ---------------------------------------------------------------------------
// SubstratePrepare — mutation primitives for the WritableContext
// ---------------------------------------------------------------------------

/**
 * The mutation primitives a substrate exposes to the WritableContext.
 *
 * `prepare` applies a single addressed delta to the substrate's state.
 * `onFlush` is called once per flush cycle, after the changefeed layer
 * has delivered notifications to subscribers.
 *
 * These are the ground floor of the prepare/flush pipeline. Caching and
 * changefeed layers wrap them — the substrate never needs to know about
 * those layers.
 */
export interface SubstratePrepare {
  /** The readable reader for the interpreter's RefContext. */
  readonly reader: Reader

  /** Apply a single (path, change) to the backing state. */
  prepare(path: Path, change: ChangeBase): void

  /**
   * Called once per flush cycle after all prepares and before changefeed
   * notification delivery (so subscribers see the updated version/log).
   *
   * For PlainSubstrate: bumps version, appends to operation log.
   */
  onFlush(origin?: string): void
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
 *    (from SubstratePrepare: reader, prepare, onFlush)
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
// MergeStrategy — dispatch key for the sync algorithm
// ---------------------------------------------------------------------------

/**
 * Declares which sync algorithm the exchange runs on behalf of a substrate.
 *
 * - **"causal"**: Bidirectional exchange. `compare()` may return
 *   `"concurrent"`. Uses `exportSince()` for fine-grained deltas.
 *
 * - **"sequential"**: Request/response. Total order — `compare()` never
 *   returns `"concurrent"`. Uses `exportSince()` or `exportEntirety()`.
 *
 * - **"lww"**: Unidirectional push/broadcast. Timestamp-based. Always
 *   uses `exportEntirety()`. Receiver compares timestamps and discards
 *   stale arrivals.
 */
export type MergeStrategy = "causal" | "sequential" | "lww"

// ---------------------------------------------------------------------------
// DocMetadata — per-document metadata
// ---------------------------------------------------------------------------

/**
 * Per-document metadata — the replicaType + mergeStrategy pair.
 *
 * Used in StorageBackend, PresentMsg, DocEntry, cmd/request-doc-creation,
 * and onDocDiscovered. Named as a first-class type because it appears
 * across storage, wire protocol, synchronizer model, and public API.
 */
export type DocMetadata = {
  readonly replicaType: ReplicaType
  readonly mergeStrategy: MergeStrategy
}

// ---------------------------------------------------------------------------
// ReplicaFactory<V> — schema-free construction
// ---------------------------------------------------------------------------

/**
 * Factory for constructing replicas without a schema.
 *
 * This is the minimal factory needed by conduit participants (storage
 * adapters, routing servers). It constructs headless replicas that
 * support replication operations but not schema-driven interpretation.
 *
 * For Loro: `createEmpty()` creates a bare `LoroDoc()` — no schema
 * walking, no container initialization. `fromSnapshot()` creates a
 * `LoroDoc()` and imports the payload. Both return replicas that
 * support `version()`, `exportSnapshot()`, `exportSince()`, and
 * `merge()` but NOT `store`, `prepare`, `onFlush`, or `context()`.
 *
 * For Plain: `createEmpty()` creates a fresh store with an empty op log.
 * `fromEntirety()` parses the JSON state image into a store.
 */
export interface ReplicaFactory<V extends Version = Version> {
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
  /** Create a fresh substrate from a schema. Store starts with Zero.structural defaults. */
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
