// plain — the plain JS object substrate.
//
// The plain substrate wraps a passive `Record<string, unknown>` and
// delegates mutations to `applyChange`. It is the degenerate
// case of the Substrate abstraction — no CRDT runtime, no native
// oplog, just a plain JS object.
//
// `createPlainSubstrate(doc, strategy)` returns a full `Substrate<V>`
// with version tracking via a shadow buffer in `prepare`/`onFlush`,
// plus `version`, `exportEntirety`, `exportSince`, `merge`.
// `plainContext(doc)` is a shorthand that returns just the
// `WritableContext` — convenient for tests that don't need the
// substrate reference.
//
// `PlainVersion` wraps a monotonic integer — the external version
// marker for plain (authoritative) substrates. Plain substrates have
// a total order, so `compare()` never returns "concurrent".
//
// `plainSubstrateFactory` is the canonical factory for constructing
// plain substrates from schemas or entirety payloads. It delegates
// to `createPlainSubstrate` internally.
//
// The `VersionStrategy<V>` type parameterizes version construction
// and log-to-delta mapping. `plainVersionStrategy` and the LWW
// module's `timestampVersionStrategy` are the two concrete strategies.
// This eliminates the decorator pattern previously used by LWW.
//
// The replication core is parameterized on a `materialize` callback:
// - Substrates pass `() => doc` (eagerly-mutated state).
// - Replicas pass a log-replay function (lazy materialization).
// The core's `exportEntirety()` calls `JSON.stringify(materialize())`
// without knowing whether materialization is eager or lazy.
//
// Context: jj:wmyomqzw (Phase 0), jj:wqoqzzpp (Phase 2), jj:umtmlpvn (version strategy extraction)
// Context: jj:oyouvrss (Phase 1 — append-log replica, init ops, batched wire format)

import type { ChangeBase } from "../change.js"
import { replaceChange } from "../change.js"
import type { Op } from "../changefeed.js"
import type { Path } from "../interpret.js"
import type { WritableContext } from "../interpreters/writable.js"
import { buildWritableContext, executeBatch } from "../interpreters/writable.js"
import { RawPath } from "../path.js"
import { applyChange, type PlainState, plainReader } from "../reader.js"
import type { Schema as SchemaNode } from "../schema.js"
import type {
  Replica,
  ReplicaFactory,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
  Version,
} from "../substrate.js"
import { BACKING_DOC } from "../substrate.js"
import { Zero } from "../zero.js"

// ---------------------------------------------------------------------------
// VersionStrategy<V> — parameterizes version algebra for plain substrates
// ---------------------------------------------------------------------------

/**
 * Version algebra for plain-backed substrates.
 *
 * Parameterizes version construction, advancement, and log-to-delta
 * mapping. This is the single axis of variation between Plain (monotonic
 * counter) and LWW (wall-clock timestamp) substrates.
 *
 * Three members, all pure:
 * - `zero` — the version for a replica with no state transitions.
 * - `current(flushCount)` — the version after N flush cycles.
 * - `logOffset(since)` — map a since-version to a log array index,
 *   or null if the version cannot be mapped (→ entirety fallback).
 */
export type VersionStrategy<V extends Version> = {
  /** Version for a replica with no state transitions. */
  readonly zero: V

  /**
   * Produce the current version after `flushCount` flush cycles.
   * For PlainVersion: `new PlainVersion(flushCount)`.
   * For TimestampVersion: `TimestampVersion.now()`.
   */
  current(flushCount: number): V

  /**
   * Map a since-version to a log offset, or null if the version
   * cannot be mapped (e.g. TimestampVersion has no log index).
   *
   * The core uses this to slice the op log for delta export.
   * When null, the core falls back to `exportEntirety()`.
   */
  logOffset(since: V): number | null
}

// ---------------------------------------------------------------------------
// PlainVersion — monotonic integer version marker
// ---------------------------------------------------------------------------

export class PlainVersion implements Version {
  readonly #value: number

  constructor(value: number) {
    this.#value = value
  }

  /** The raw version integer. */
  get value(): number {
    return this.#value
  }

  serialize(): string {
    return String(this.#value)
  }

  compare(other: Version): "behind" | "equal" | "ahead" | "concurrent" {
    if (!(other instanceof PlainVersion)) {
      throw new Error(
        "PlainVersion can only be compared with another PlainVersion",
      )
    }
    const otherValue = other.#value
    if (this.#value < otherValue) return "behind"
    if (this.#value > otherValue) return "ahead"
    return "equal"
  }
}

// ---------------------------------------------------------------------------
// plainVersionStrategy — the PlainVersion algebra
// ---------------------------------------------------------------------------

export const plainVersionStrategy: VersionStrategy<PlainVersion> = {
  zero: new PlainVersion(0),
  current: flushCount => new PlainVersion(flushCount),
  logOffset: since => since.value,
}

// ---------------------------------------------------------------------------
// createPlainSubstrate — full Substrate<V> from a bare doc + strategy
// ---------------------------------------------------------------------------

/**
 * Creates a full `Substrate<V>` wrapping a plain JS object document,
 * with version tracking, export/merge, and the shadow buffer
 * for op logging.
 *
 * The version algebra is determined by the `strategy` parameter:
 * `plainVersionStrategy` for authoritative substrates,
 * `timestampVersionStrategy` (from lww.ts) for LWW/ephemeral substrates.
 *
 * The substrate eagerly mutates `doc` in `prepare()` — the backing doc
 * is always up to date. The core's `materialize` callback is `() => doc`.
 *
 * This is the low-level entry point when you already have a document.
 * For schema-aware construction (with `Zero.structural`),
 * use `plainSubstrateFactory.create(schema)` instead.
 */
export function createPlainSubstrate<V extends Version>(
  doc: PlainState,
  strategy: VersionStrategy<V>,
): Substrate<V> {
  const reader = plainReader(doc)

  // --- Shared replication core ---
  // Substrate passes `() => doc` because it eagerly mutates `doc` in prepare().
  const replicaCore = createPlainReplicaCore(() => doc, strategy)

  // The WritableContext is built lazily and cached — the same context
  // is returned on every call to `context()`.
  let cachedCtx: WritableContext | undefined

  const substrate = {
    [BACKING_DOC]: doc,

    reader: reader,

    prepare(path: Path, change: ChangeBase): void {
      applyChange(doc, path, change)
      replicaCore.pendingOps.push({ path, change })
    },

    onFlush(_origin?: string): void {
      replicaCore.flush()
    },

    context(): WritableContext {
      if (!cachedCtx) {
        cachedCtx = buildWritableContext(substrate)
      }
      return cachedCtx
    },

    version(): V {
      return replicaCore.version()
    },

    exportEntirety(): SubstratePayload {
      return replicaCore.exportEntirety()
    },

    exportSince(since: V): SubstratePayload | null {
      return replicaCore.exportSince(since)
    },

    merge(payload: SubstratePayload, origin?: string): void {
      if (payload.encoding !== "json" || typeof payload.data !== "string") {
        throw new Error(
          "PlainSubstrate.merge expects JSON-encoded payloads. " +
            "If you recently switched CRDT backends, stale clients may be sending incompatible data.",
        )
      }

      const ctx = substrate.context()

      if (payload.kind === "entirety") {
        // State image — decompose to ReplaceChange ops and apply through
        // the prepare/flush pipeline so the changefeed fires and refs
        // observe the transition.
        const ops = stateImageToOps(payload.data)
        if (ops.length > 0) {
          executeBatch(ctx, ops, origin)
        }
      } else {
        // Batched op array — each inner array is one flush cycle.
        // Apply each batch through the prepare/flush pipeline so that
        // version parity is preserved across export → merge → re-export.
        const batches = JSON.parse(payload.data) as SerializedOp[][]
        for (const batch of batches) {
          if (batch.length === 0) continue
          const ops = deserializeOps(batch)
          executeBatch(ctx, ops, origin)
        }
      }
    },
  }

  return substrate as Substrate<V>
}

// ---------------------------------------------------------------------------
// createPlainReplicaCore — shared versioning and export core
// ---------------------------------------------------------------------------

/**
 * The shared replication core used by both `createPlainSubstrate` and
 * `createPlainReplica`. Holds the op log and export logic — the
 * parts that don't require schema interpretation or the changefeed
 * pipeline.
 *
 * Parameterized on a `materialize` callback that returns the current
 * `PlainState`. This eliminates mode branching:
 * - Substrates pass `() => doc` (eagerly-mutated state).
 * - Replicas pass a log-replay function (lazy materialization).
 *
 * Version construction and log-to-delta mapping are delegated to the
 * `VersionStrategy<V>` — the core never mentions `PlainVersion` or
 * `TimestampVersion` directly.
 */
function createPlainReplicaCore<V extends Version>(
  materialize: () => PlainState,
  strategy: VersionStrategy<V>,
) {
  // Version log: log[i] = batch of Ops from flush cycle i.
  // log.length is the flush count — the single source of truth for
  // how many state-advancing operations have occurred.
  const log: Op[][] = []

  // Cached version — computed once per flush cycle via strategy.current().
  // For PlainVersion (monotonic counter), this is deterministic: same
  // flushCount always produces the same version.
  // For TimestampVersion (wall clock), caching is critical: version()
  // must return the timestamp from the last flush, not a fresh Date.now()
  // on every call. Without caching, a receiver's version() advances in
  // real-time, causing inbound offers from the near-past to be rejected
  // as "behind" even though they carry new data.
  let cachedVersion: V = strategy.zero

  // Pending ops buffer — filled by prepare (Substrate) or
  // merge (Replica), drained by flush.
  const pendingOps: Op[] = []

  return {
    pendingOps,
    log,

    flush(): void {
      if (pendingOps.length > 0) {
        log.push([...pendingOps])
        pendingOps.length = 0
        cachedVersion = strategy.current(log.length)
      }
    },

    version(): V {
      return cachedVersion
    },

    exportEntirety(): SubstratePayload {
      return {
        kind: "entirety",
        encoding: "json",
        data: JSON.stringify(materialize()),
      }
    },

    exportSince(since: V): SubstratePayload | null {
      const offset = strategy.logOffset(since)

      // Strategy cannot map the version to a log index — fall back to
      // entirety. This is the TimestampVersion path: wall-clock timestamps
      // have no relationship to the op log array.
      if (offset === null) return this.exportEntirety()

      // Nothing to send: offset is at or beyond the current log length.
      if (offset >= log.length) return null

      // Preserve batch boundaries so receivers replay one flush per batch,
      // maintaining version parity across export → merge → re-export.
      // Without this, relay topologies would collapse all batches into one
      // flush cycle, destroying version parity and causing deadlocks.
      const batches = log.slice(offset)
      if (batches.every(b => b.length === 0)) return null

      const serializedBatches = batches.map(batch => serializeOps(batch))

      return {
        kind: "since",
        encoding: "json",
        data: JSON.stringify(serializedBatches),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// createPlainReplica — headless append-log replication surface (no schema)
// ---------------------------------------------------------------------------

/**
 * Creates a headless `Replica<V>` — an append-log that accumulates
 * payloads without interpreting them, materializing state on demand.
 *
 * The replica never calls `step()` or `applyChange()` during merge.
 * Ops are pushed to the log and flushed. Materialized state is derived
 * lazily from `Base + Log` when needed (for `exportEntirety()` or
 * `[BACKING_DOC]` access).
 *
 * Used by conduit participants (stores, routing servers)
 * that need to accumulate state, compute deltas, and compact storage
 * without ever reading or writing document fields.
 *
 * @param strategy - The version algebra (plain or timestamp).
 */
export function createPlainReplica<V extends Version>(
  strategy: VersionStrategy<V>,
): Replica<V> {
  // --- Lazy materialization cache ---
  // The cache is the single materialized PlainState, built by replaying
  // the entire log through applyChange(). Invalidated on every flush.
  let cachedState: PlainState | null = null

  /** Replay Base ({}) + Log through applyChange to produce current state. */
  function materialize(): PlainState {
    if (cachedState !== null) return cachedState
    const state: PlainState = {}
    for (const batch of core.log) {
      for (const op of batch) {
        applyChange(state, op.path, op.change)
      }
    }
    cachedState = state
    return state
  }

  // The core owns the log — the replica reads core.log for replay.
  // Single source of truth; no parallel data structure to keep in sync.
  const core = createPlainReplicaCore(materialize, strategy)

  // Wrap core.flush to invalidate the materialization cache.
  // Centralized: any path that flushes automatically invalidates —
  // impossible to forget when adding new merge paths.
  const coreFlush = core.flush.bind(core)
  core.flush = () => {
    coreFlush()
    cachedState = null
  }

  const replica = {
    get [BACKING_DOC](): PlainState {
      return materialize()
    },

    version(): V {
      return core.version()
    },

    exportEntirety(): SubstratePayload {
      return core.exportEntirety()
    },

    exportSince(since: V): SubstratePayload | null {
      return core.exportSince(since)
    },

    merge(payload: SubstratePayload, _origin?: string): void {
      if (payload.encoding !== "json" || typeof payload.data !== "string") {
        throw new Error(
          "PlainReplica.merge expects JSON-encoded payloads. " +
            "If you recently switched CRDT backends, stale clients may be sending incompatible data.",
        )
      }

      if (payload.kind === "entirety") {
        // State image — decompose to ReplaceChange ops and append as
        // a single batch. No applyChange, no step — just log it.
        const ops = stateImageToOps(payload.data)
        if (ops.length === 0) return
        for (const op of ops) {
          core.pendingOps.push(op)
        }
        core.flush()
      } else {
        // Batched op array — each inner array is one flush cycle.
        // Replay one flush per batch to preserve version parity.
        const batches = JSON.parse(payload.data) as SerializedOp[][]
        for (const batch of batches) {
          if (batch.length === 0) continue
          const ops = deserializeOps(batch)
          for (const op of ops) {
            core.pendingOps.push(op)
          }
          core.flush()
        }
      }
    },
  }

  return replica as Replica<V>
}

// ---------------------------------------------------------------------------
// plainContext — shorthand for tests
// ---------------------------------------------------------------------------

/**
 * Shorthand: wraps a plain document in a substrate and returns its
 * WritableContext.
 *
 * Useful in tests where you don't need the substrate reference:
 *
 * ```ts
 * const ctx = plainContext(doc)
 * const ref = interpret(schema, ctx).with(readable).with(writable).done()
 * ```
 */
export function plainContext(doc: PlainState): WritableContext {
  return createPlainSubstrate(doc, plainVersionStrategy).context()
}

// ---------------------------------------------------------------------------
// objectToReplaceOps / stateImageToOps — shared helpers
// ---------------------------------------------------------------------------

/**
 * Build one `ReplaceChange` op per top-level key in a state object.
 *
 * This is the primitive used by:
 * - `stateImageToOps` (entirety payload absorption)
 * - `buildUpgrade` (initialization ops for missing schema keys)
 */
export function objectToReplaceOps(
  state: Record<string, unknown>,
): Op[] {
  const ops: Op[] = []
  for (const [key, value] of Object.entries(state)) {
    ops.push({
      path: RawPath.empty.field(key),
      change: replaceChange(value),
    })
  }
  return ops
}

/**
 * Parse a JSON state image and build one `ReplaceChange` op per top-level key.
 *
 * Used by three call sites:
 * - `PlainSubstrate.merge` (entirety path — apply via executeBatch)
 * - `PlainReplica.merge` (entirety path — append to log)
 * - `buildPlainSubstrateFromEntirety` (cold-start construction)
 */
function stateImageToOps(json: string): Op[] {
  return objectToReplaceOps(JSON.parse(json) as Record<string, unknown>)
}

// ---------------------------------------------------------------------------
// Shared fromEntirety helpers — used by both plain and LWW factories
// ---------------------------------------------------------------------------

/**
 * Construct a `Substrate<V>` from a self-sufficient entirety payload.
 *
 * Validates payload encoding, creates a substrate with Zero.structural
 * defaults, then applies the entirety state through the prepare/flush
 * pipeline. This produces version > 0 with ops in the log, so version
 * comparison works correctly for authoritative sync.
 *
 * Used by both `plainSubstrateFactory.fromEntirety` and
 * `lwwSubstrateFactory.fromEntirety` — the only difference is the
 * strategy parameter.
 */
export function buildPlainSubstrateFromEntirety<V extends Version>(
  payload: SubstratePayload,
  schema: SchemaNode,
  strategy: VersionStrategy<V>,
): Substrate<V> {
  if (payload.encoding !== "json" || typeof payload.data !== "string") {
    throw new Error(
      "PlainSubstrateFactory.fromEntirety only supports JSON-encoded payloads",
    )
  }
  // Plain substrates track version via log length — creating a fresh
  // substrate and applying ops via executeBatch advances the version
  // correctly. (CRDT substrates use the two-phase path instead because
  // their version is inherent in the document state.)
  const defaults = Zero.structural(schema) as Record<string, unknown>
  const doc = { ...defaults } as PlainState
  const substrate = createPlainSubstrate(doc, strategy)
  const ops = stateImageToOps(payload.data as string)
  if (ops.length > 0) {
    executeBatch(substrate.context(), ops)
  }
  return substrate
}

/**
 * Construct a `Replica<V>` from a self-sufficient entirety payload.
 *
 * Validates payload encoding, parses JSON state, and creates a replica
 * that merges the entirety into its log.
 *
 * Used by both `plainReplicaFactory.fromEntirety` and
 * `lwwReplicaFactory.fromEntirety` — the only difference is the
 * strategy parameter.
 */
export function buildPlainReplicaFromEntirety<V extends Version>(
  payload: SubstratePayload,
  strategy: VersionStrategy<V>,
): Replica<V> {
  if (payload.encoding !== "json" || typeof payload.data !== "string") {
    throw new Error(
      "PlainReplicaFactory.fromEntirety only supports JSON-encoded payloads",
    )
  }
  const replica = createPlainReplica(strategy)
  replica.merge(payload)
  return replica
}

// ---------------------------------------------------------------------------
// buildUpgrade — shared two-phase construction for plain-backed substrates
// ---------------------------------------------------------------------------

/**
 * Shared `upgrade` implementation for both `plainSubstrateFactory` and
 * `lwwSubstrateFactory`.
 *
 * 1. Read the materialized state from the replica via `[BACKING_DOC]`
 * 2. Create the substrate (so `context()` is available for `executeBatch`)
 * 3. Compute `Zero.structural(schema)` defaults
 * 4. Filter to keys not already present in the materialized state
 * 5. Build init ops via `objectToReplaceOps(filtered)`
 * 6. If the strategy supports delta sync (`logOffset` returns non-null),
 *    apply via `executeBatch` so init ops enter the log and advance the
 *    version. Otherwise (ephemeral), apply directly to the doc via
 *    `applyChange` without entering the log or advancing the version.
 * 7. Return the substrate
 *
 * The `logOffset(zero)` probe discriminates: strategies with log-indexed
 * versions (authoritative) emit init ops through the log; strategies
 * without (ephemeral/LWW) apply them silently. This prevents independent
 * peers from diverging on creation timestamp for ephemeral docs.
 */
export function buildUpgrade<V extends Version>(
  replica: Replica<V>,
  schema: SchemaNode,
  strategy: VersionStrategy<V>,
): Substrate<V> {
  const materializedState = (replica as any)[BACKING_DOC] as PlainState

  // Create a fresh doc seeded from the replica's materialized state.
  // The substrate owns this doc — the replica's state is not shared.
  const doc = { ...materializedState } as PlainState
  const substrate = createPlainSubstrate(doc, strategy)

  // Compute defaults and filter to keys not already present.
  const defaults = Zero.structural(schema) as Record<string, unknown>
  const missing: Record<string, unknown> = {}
  for (const key of Object.keys(defaults)) {
    if (!(key in materializedState)) {
      missing[key] = defaults[key]
    }
  }

  const initOps = objectToReplaceOps(missing)
  if (initOps.length > 0) {
    // Probe whether this strategy supports delta sync.
    const supportsDeltaSync = strategy.logOffset(strategy.zero) !== null

    if (supportsDeltaSync) {
      // Authoritative: init ops enter the log via executeBatch,
      // advancing the version so peers can sync via exportSince(v0).
      executeBatch(substrate.context(), initOps)
    } else {
      // Ephemeral: apply directly to the doc without entering the log.
      // This prevents independent peers from diverging on creation
      // timestamp for ephemeral docs.
      for (const op of initOps) {
        applyChange(doc, op.path, op.change)
      }
    }
  }

  return substrate
}

// ---------------------------------------------------------------------------
// PlainReplicaFactory — schema-free construction
// ---------------------------------------------------------------------------

/**
 * Schema-free replica factory for plain substrates.
 *
 * Constructs headless `Replica<PlainVersion>` instances without
 * requiring a schema. Used by conduit participants and as the
 * `replica` accessor on `plainSubstrateFactory`.
 */
export const plainReplicaFactory: ReplicaFactory<PlainVersion> = {
  replicaType: ["plain", 1, 0] as const,

  createEmpty(): Replica<PlainVersion> {
    return createPlainReplica(plainVersionStrategy)
  },

  fromEntirety(payload: SubstratePayload): Replica<PlainVersion> {
    return buildPlainReplicaFromEntirety(payload, plainVersionStrategy)
  },

  parseVersion(serialized: string): PlainVersion {
    if (serialized === "") {
      throw new Error(`Invalid PlainVersion value: (empty string)`)
    }
    const n = Number(serialized)
    if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
      throw new Error(`Invalid PlainVersion value: ${serialized}`)
    }
    return new PlainVersion(n)
  },
}

// ---------------------------------------------------------------------------
// PlainSubstrateFactory — schema-aware construction
// ---------------------------------------------------------------------------

/**
 * Factory for constructing plain JS object substrates.
 *
 * Supports two-phase construction:
 * - `createReplica()` → bare replica (empty doc)
 * - `upgrade(replica, schema)` → full substrate (conditional defaults)
 *
 * Convenience:
 * - `create(schema)` — composes `upgrade(createReplica(), schema)`
 * - `fromEntirety(payload, schema)` — reconstruct from an entirety payload
 * - `parseVersion(serialized)` — deserialize a PlainVersion
 */
export const plainSubstrateFactory: SubstrateFactory<PlainVersion> = {
  createReplica(): Replica<PlainVersion> {
    return createPlainReplica(plainVersionStrategy)
  },

  upgrade(
    replica: Replica<PlainVersion>,
    schema: SchemaNode,
  ): Substrate<PlainVersion> {
    return buildUpgrade(replica, schema, plainVersionStrategy)
  },

  create(schema: SchemaNode): Substrate<PlainVersion> {
    return this.upgrade(this.createReplica(), schema)
  },

  fromEntirety(
    payload: SubstratePayload,
    schema: SchemaNode,
  ): Substrate<PlainVersion> {
    return buildPlainSubstrateFromEntirety(
      payload,
      schema,
      plainVersionStrategy,
    )
  },

  parseVersion(serialized: string): PlainVersion {
    return plainReplicaFactory.parseVersion(serialized)
  },

  replica: plainReplicaFactory,
}

// ---------------------------------------------------------------------------
// Op serialization — convert between Path objects and JSON-safe arrays
// ---------------------------------------------------------------------------

/** A JSON-safe representation of a path segment. */
type SerializedSegment =
  | { type: "key"; key: string }
  | { type: "index"; index: number }

/** A JSON-safe representation of an Op. */
interface SerializedOp {
  path: SerializedSegment[]
  change: ChangeBase
}

/**
 * Convert Ops with Path objects into JSON-safe form for serialization.
 * Extracts segments and produces plain `{ type, key/index }` objects.
 */
function serializeOps(ops: readonly Op[]): SerializedOp[] {
  return ops.map(op => ({
    path: op.path.segments.map(seg =>
      seg.role === "key"
        ? { type: "key" as const, key: seg.resolve() as string }
        : { type: "index" as const, index: seg.resolve() as number },
    ),
    change: op.change,
  }))
}

/**
 * Reconstruct Ops with RawPath objects from JSON-parsed data.
 * Converts plain `{ type, key/index }` arrays back into RawPath instances.
 */
function deserializeOps(raw: SerializedOp[]): Op[] {
  return raw.map(op => ({
    path: deserializePath(op.path),
    change: op.change,
  }))
}

function deserializePath(segments: SerializedSegment[]): RawPath {
  let path = RawPath.empty
  for (const seg of segments) {
    if (seg.type === "key") {
      path = path.field(seg.key)
    } else {
      path = path.item(seg.index)
    }
  }
  return path
}