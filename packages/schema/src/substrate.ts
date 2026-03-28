// substrate — the formal interface between state management, the
// interpreter stack, and the replication layer.
//
// `SubstratePrepare` (Phase 0) is the ground floor of the prepare/flush
// pipeline. `Substrate<V>` extends it with versioning and transfer
// semantics. `SubstrateFactory<V>` constructs substrates from schemas
// or snapshot payloads.
//
// The payload type `SubstratePayload` is intentionally opaque — the
// meaning of a payload is determined by which method produced it and
// which method consumes it (see Design Decisions in jj:wqoqzzpp).
//
// Context: jj:wmyomqzw (SubstratePrepare), jj:wqoqzzpp (Substrate)

import type { ChangeBase } from "./change.js"
import type { Path } from "./interpret.js"
import type { WritableContext } from "./interpreters/writable.js"
import type { Schema as SchemaNode } from "./schema.js"
import type { StoreReader } from "./store.js"

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
  /** The readable store for the interpreter's RefContext. */
  readonly store: StoreReader

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
 * knows how to produce and consume these. The meaning of a payload is
 * determined by which method produced it and which method consumes it:
 *
 *   exportSnapshot() → SubstratePayload → factory.fromSnapshot()
 *   exportSince()    → SubstratePayload → substrate.importDelta()
 *
 * The `encoding` hint tells the transport layer whether the data is
 * text-safe (JSON) or binary (needs base64 for text contexts).
 */
export interface SubstratePayload {
  readonly encoding: "json" | "binary"
  readonly data: string | Uint8Array
}

// ---------------------------------------------------------------------------
// Substrate<V> — state + versioning + transfer
// ---------------------------------------------------------------------------

/**
 * A Substrate holds document state and defines its transfer semantics.
 *
 * Three responsibilities:
 * 1. Provide a readable store + WritableContext for the interpreter stack
 *    (inherited from SubstratePrepare: store, prepare, onFlush)
 * 2. Track versioning via Version
 * 3. Export/import state for replication (sync, SSR)
 *
 * The substrate fires the `project` morphism automatically: after any
 * mutation (local or imported), the resulting Ops are delivered through
 * the CHANGEFEED attached by the interpreter's changefeed layer.
 *
 * Epoch boundaries (snapshot import / state replacement) are NOT handled
 * by the substrate. They are an application-layer concern: the factory's
 * `fromSnapshot()` constructs a new substrate, and the application swaps
 * the doc reference. Within a substrate lifetime, all transitions are
 * deltas via `Changeset`. Between lifetimes, there is no continuity.
 */
export interface Substrate<V extends Version = Version>
  extends SubstratePrepare {
  /** The readable store for the interpreter (from SubstratePrepare). */
  readonly store: StoreReader

  /** Build a WritableContext for this substrate. */
  context(): WritableContext

  /** Current version marker. */
  version(): V

  /**
   * Full state — sufficient to construct an equivalent substrate from
   * scratch via `SubstrateFactory.fromSnapshot()`.
   *
   * For PlainSubstrate: JSON-serialized store (a state image).
   * For LoroSubstrate: doc.export({ mode: "snapshot" }) (a complete oplog).
   */
  exportSnapshot(): SubstratePayload

  /**
   * Delta payload since a version — sufficient to catch up a live
   * substrate via `importDelta()`.
   *
   * Returns null if delta export is not possible (e.g. version too old,
   * log compacted past that point, substrate doesn't support incremental).
   *
   * For PlainSubstrate: JSON-serialized Op[] from the version log.
   * For LoroSubstrate: doc.export({ mode: "update", from: vv }).
   */
  exportSince(since: V): SubstratePayload | null

  /**
   * Apply a delta payload to this live substrate. The payload must have
   * been produced by `exportSince()` on a compatible substrate.
   *
   * After import, the changefeed layer delivers the resulting Ops as
   * a Changeset to subscribers (via the prepare/flush pipeline).
   *
   * For PlainSubstrate: parses Op[], applies via executeBatch.
   * For LoroSubstrate: doc.import(bytes).
   */
  importDelta(payload: SubstratePayload, origin?: string): void
}

// ---------------------------------------------------------------------------
// SubstrateFactory<V> — construction from schema or snapshot
// ---------------------------------------------------------------------------

/**
 * Factory for constructing substrates. Each substrate type provides one.
 */
export interface SubstrateFactory<V extends Version = Version> {
  /** Create a fresh substrate from a schema. Store starts with Zero.structural defaults. */
  create(schema: SchemaNode): Substrate<V>

  /**
   * Construct a new substrate from a snapshot payload.
   *
   * The payload must have been produced by `exportSnapshot()` on a
   * compatible substrate. This always creates a NEW substrate — it
   * does not mutate an existing one.
   *
   * This is the entry point for epoch boundaries: SSR hydration,
   * reconnection past log compaction, etc.
   *
   * For PlainSubstrate: parses JSON state image, applies via executeBatch.
   * For LoroSubstrate: LoroDoc.fromSnapshot(bytes).
   */
  fromSnapshot(payload: SubstratePayload, schema: SchemaNode): Substrate<V>

  /** Deserialize a version from its string representation. */
  parseVersion(serialized: string): V
}
