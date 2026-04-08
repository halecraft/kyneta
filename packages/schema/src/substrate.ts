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
import { KIND, type Schema as SchemaNode } from "./schema.js"

// ---------------------------------------------------------------------------
// BACKING_DOC — universal accessor for the backing state of any replica
// ---------------------------------------------------------------------------

/**
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
 * Context: jj:smmulzkm (two-phase substrate construction)
 */
export const BACKING_DOC = Symbol("kyneta.backingDoc")

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
// computeSchemaHash — deterministic schema fingerprint
// ---------------------------------------------------------------------------

/**
 * Compute a deterministic fingerprint from a schema's structural shape.
 *
 * Uses FNV-1a at 128 bits (two independent 64-bit passes with different
 * seeds). Synchronous, no platform dependency.
 *
 * The result is a 34-character hex string:
 *   - 2-char algorithm version prefix ("00" = FNV-1a-128)
 *   - 32-char hex hash (16 bytes)
 *
 * The canonical serialization captures field names (alphabetical order),
 * field types (scalar kind, annotation tag, structural kind), and nested
 * structure (recursive). It does NOT capture runtime values or
 * backend-specific details.
 *
 * This is a **versioning commitment** — the hash must never change for
 * the same schema across releases. The canonical serialization format
 * and FNV-1a algorithm are stable contracts.
 */
export function computeSchemaHash(schema: SchemaNode): string {
  const canonical = canonicalizeSchema(schema)
  const hash = fnv1a128(canonical)
  return `00${hash}`
}

// ---------------------------------------------------------------------------
// Canonical schema serialization (internal)
// ---------------------------------------------------------------------------

/**
 * Produce a deterministic string representation of a schema's structure.
 *
 * The format is a compact S-expression-like notation:
 *   - scalar: `s:kind` (e.g. `s:string`, `s:number`)
 *   - product: `p(field1:...,field2:...)` with fields in alphabetical order
 *   - sequence: `q(item)`
 *   - map: `m(value)`
 *   - sum: `u(v0,v1,...)` for positional, `d:disc(tag0:...,tag1:...)` for discriminated
 *   - annotated: `a:tag` (leaf) or `a:tag(inner)` (with inner schema)
 */
function canonicalizeSchema(schema: SchemaNode): string {
  switch (schema[KIND]) {
    case "scalar": {
      const constraint = (schema as any).constraint as unknown[] | undefined
      if (constraint && constraint.length > 0) {
        // Include constraints in the hash for discriminated sum tags
        return `s:${schema.scalarKind}[${constraint.map(String).join(",")}]`
      }
      return `s:${schema.scalarKind}`
    }

    case "product": {
      const fields = Object.entries(
        (schema as any).fields as Record<string, SchemaNode>,
      ).sort(([a], [b]) => a.localeCompare(b))
      const parts = fields.map(
        ([name, fieldSchema]) => `${name}:${canonicalizeSchema(fieldSchema)}`,
      )
      return `p(${parts.join(",")})`
    }

    case "sequence":
      return `q(${canonicalizeSchema((schema as any).item as SchemaNode)})`

    case "map":
      return `m(${canonicalizeSchema((schema as any).item as SchemaNode)})`

    case "sum": {
      const discriminant = (schema as any).discriminant as string | undefined
      if (discriminant !== undefined) {
        // Discriminated sum — variants are products, keyed by discriminant tag
        const variants = (schema as any).variants as SchemaNode[]
        const parts = variants
          .map((v: SchemaNode) => canonicalizeSchema(v))
          .sort()
        return `d:${discriminant}(${parts.join(",")})`
      }
      // Positional sum
      const variants = (schema as any).variants as SchemaNode[]
      const parts = variants.map((v: SchemaNode) => canonicalizeSchema(v))
      return `u(${parts.join(",")})`
    }

    case "annotated": {
      const tag = (schema as any).tag as string
      const inner = (schema as any).schema as SchemaNode | undefined
      if (inner !== undefined) {
        return `a:${tag}(${canonicalizeSchema(inner)})`
      }
      return `a:${tag}`
    }

    default:
      return `?:${(schema as any)[KIND]}`
  }
}

// ---------------------------------------------------------------------------
// FNV-1a 128-bit hash (internal)
// ---------------------------------------------------------------------------

/**
 * FNV-1a at 128 bits, implemented as two independent 64-bit passes
 * with different seeds. Returns a 32-character hex string.
 */
function fnv1a128(input: string): string {
  // Pass 1: standard FNV-1a 64-bit
  let h1 = BigInt("0xcbf29ce484222325")
  const p1 = BigInt("0x100000001b3")
  const mask64 = BigInt("0xFFFFFFFFFFFFFFFF")
  for (let i = 0; i < input.length; i++) {
    h1 ^= BigInt(input.charCodeAt(i))
    h1 = (h1 * p1) & mask64
  }

  // Pass 2: FNV-1a 64-bit with offset seed
  let h2 = BigInt("0x6c62272e07bb0142")
  const p2 = BigInt("0x100000001b3")
  for (let i = 0; i < input.length; i++) {
    h2 ^= BigInt(input.charCodeAt(i))
    h2 = (h2 * p2) & mask64
  }

  // Concatenate both halves as 32 hex chars
  return h1.toString(16).padStart(16, "0") + h2.toString(16).padStart(16, "0")
}

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
 * CRDT runtime but NOT a schema. For authoritative/LWW substrates, a
 * replica is a plain JS object with an op log — no external runtime.
 */
export interface Replica<V extends Version = Version> {
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
  advance(to: V): void

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
 * - **"collaborative"**: Bidirectional exchange. `compare()` may return
 *   `"concurrent"`. Uses `exportSince()` for fine-grained deltas.
 *
 * - **"authoritative"**: Request/response. Total order — `compare()` never
 *   returns `"concurrent"`. Uses `exportSince()` or `exportEntirety()`.
 *
 * - **"ephemeral"**: Unidirectional push/broadcast. Timestamp-based. Always
 *   uses `exportEntirety()`. Receiver compares timestamps and discards
 *   stale arrivals.
 */
export type MergeStrategy = "collaborative" | "authoritative" | "ephemeral"

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
  readonly schemaHash: string
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
