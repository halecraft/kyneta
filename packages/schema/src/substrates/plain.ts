// plain — the plain JS object substrate.
//
// The plain substrate wraps a passive `Record<string, unknown>` and
// delegates mutations to `applyChange`. It is the degenerate
// case of the Substrate abstraction — no CRDT runtime, no native
// oplog, just a plain JS object.
//
// `createPlainSubstrate(doc, strategy)` returns a full `Substrate<V>`
// with version tracking via a shadow buffer in `prepare`/`afterBatch`,
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

import { randomHex } from "@kyneta/random"
import type { ChangeBase } from "../change.js"
import { replaceChange } from "../change.js"
import type { Op } from "../changefeed.js"
import type { Path } from "../interpret.js"
import type { WritableContext } from "../interpreters/writable.js"
import { buildWritableContext, executeBatch } from "../interpreters/writable.js"
import { deepClonePreState, invert } from "../inverse.js"
import { RawPath } from "../path.js"
import {
  decodePlainPosition,
  PlainPosition,
  type PositionCapable,
  type Side,
} from "../position.js"
import { applyChange, type PlainState, plainReader } from "../reader.js"
import type { Schema as SchemaNode } from "../schema.js"
import type {
  BatchOptions,
  RecordInverseFn,
  Replica,
  ReplicaFactory,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
  Version,
} from "../substrate.js"
import { BACKING_DOC, RECORD_INVERSE } from "../substrate.js"
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
 * Three members:
 * - `zero` — the version for a replica with no state transitions.
 * - `current(flushCount)` — the version after N flush cycles.
 * - `logOffset(since)` — map a since-version to a log array index,
 *   or null if the version cannot be mapped (→ entirety fallback).
 *
 * The type itself is pure — no member mutates anything through this
 * interface. But `createPlainVersionStrategy`'s concrete implementation for
 * `PlainVersion` is per-replica *stateful*: it closes over a mutable
 * `epoch` string (lazily minted, and updatable via the accompanying
 * `adoptEpoch` closure returned alongside the strategy — see below).
 * `timestampVersionStrategy` (LWW, in `lww.ts`) remains a genuinely stateless
 * `VersionStrategy<TimestampVersion>` singleton, unaffected by this.
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

// The sentinel epoch assigned to all newly created plain replicas.
// A DEFAULT epoch is pluripotent: it has no identity yet because the
// replica contains only schema defaults (init ops). Any version carrying
// DEFAULT compares as "behind" a REAL epoch and as "equal" to
// another DEFAULT. The first real write (flushCount > 1) or the first
// merge with a REAL epoch upgrades the replica to a specific identity.
export const DEFAULT_EPOCH = "kyneta.default"

// Legacy sentinel used when parsing bare integer version strings that
// pre-date epoch support. Treated as a REAL epoch for comparison
// purposes — it won't match any active epoch.
export const LEGACY_EPOCH = "kyneta.legacy"

export class PlainVersion implements Version {
  readonly #value: number
  readonly #epoch: string

  constructor(value: number, epoch: string) {
    this.#value = value
    this.#epoch = epoch
  }

  /** The raw version integer. */
  get value(): number {
    return this.#value
  }

  get epoch(): string {
    return this.#epoch
  }

  serialize(): string {
    return `${this.#epoch}:${this.#value}`
  }

  compare(other: Version): "behind" | "equal" | "ahead" | "concurrent" {
    if (!(other instanceof PlainVersion)) {
      throw new Error(
        "PlainVersion can only be compared with another PlainVersion",
      )
    }

    const otherValue = other.#value
    const thisDefault = this.#epoch === DEFAULT_EPOCH
    const otherDefault = other.#epoch === DEFAULT_EPOCH

    if (thisDefault && otherDefault) {
      // Both are DEFAULT — no identity formed yet. Treat as totally ordered.
      if (this.#value < otherValue) return "behind"
      if (this.#value > otherValue) return "ahead"
      return "equal"
    }

    if (thisDefault && !otherDefault) {
      // We are DEFAULT, they are REAL. DEFAULT can never be ahead of REAL.
      if (this.#value < otherValue) return "behind"
      return "equal"
    }

    if (!thisDefault && otherDefault) {
      // We are REAL, they are DEFAULT. REAL is never behind DEFAULT.
      if (this.#value > otherValue) return "ahead"
      return "equal"
    }

    // Both REAL, same epoch — pure total order on value. Cross-epoch REAL
    // pairs are no longer compared here: the Synchronizer gates on
    // `Version.epoch` equality upstream of `compare()`. If a caller
    // bypasses that gate, this is a safety fallback only.
    if (this.#epoch !== other.#epoch) {
      return "concurrent"
    }

    if (this.#value < otherValue) return "behind"
    if (this.#value > otherValue) return "ahead"
    return "equal"
  }

  meet(other: Version): PlainVersion {
    if (!(other instanceof PlainVersion)) {
      throw new Error(
        "PlainVersion can only be meet'd with another PlainVersion",
      )
    }

    const thisDefault = this.#epoch === DEFAULT_EPOCH
    const otherDefault = other.#epoch === DEFAULT_EPOCH

    if (thisDefault && otherDefault) {
      return new PlainVersion(
        Math.min(this.#value, other.#value),
        DEFAULT_EPOCH,
      )
    }

    if (thisDefault && !otherDefault) {
      // DEFAULT vs REAL: REAL subsumes DEFAULT. Meet at REAL's root.
      return new PlainVersion(0, other.#epoch)
    }

    if (!thisDefault && otherDefault) {
      return new PlainVersion(0, this.#epoch)
    }

    // Both REAL. Different lineages have no shared history.
    if (this.#epoch !== other.#epoch) {
      const inc = this.#epoch < other.#epoch ? this.#epoch : other.#epoch
      return new PlainVersion(0, inc)
    }

    return new PlainVersion(Math.min(this.#value, other.#value), this.#epoch)
  }
}

// ---------------------------------------------------------------------------
// plainVersionStrategy — the PlainVersion algebra
// ---------------------------------------------------------------------------

export function createPlainVersionStrategy(initialEpoch: string): {
  strategy: VersionStrategy<PlainVersion>
  adoptEpoch: (inc: string) => void
  getEpoch: () => string
} {
  let epoch = initialEpoch

  const strategy: VersionStrategy<PlainVersion> = {
    get zero() {
      return new PlainVersion(0, epoch)
    },
    current(flushCount: number) {
      // Lazy mint: if we're still DEFAULT and this is the first real write
      // (flushCount > 1 means more than just init ops), claim an identity.
      if (epoch === DEFAULT_EPOCH && flushCount > 1) {
        epoch = randomHex(8)
      }
      return new PlainVersion(flushCount, epoch)
    },
    logOffset(since: PlainVersion) {
      // DEFAULT is the universal prefix — any epoch can map it.
      if (since.epoch === DEFAULT_EPOCH) {
        return since.value
      }
      if (since.epoch !== epoch) {
        return null
      }
      return since.value
    },
  }

  return {
    strategy,
    adoptEpoch: (inc: string) => {
      epoch = inc
    },
    getEpoch: () => epoch,
  }
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
  adoptEpoch?: (inc: string) => void,
  getEpoch?: () => string,
): Substrate<V> {
  const reader = plainReader(doc)

  // --- Shared replication core ---
  // Substrate passes `() => doc` because it eagerly mutates `doc` in prepare().
  const replicaCore = createPlainReplicaCore(
    () => doc,
    strategy,
    adoptEpoch,
    getEpoch,
  )

  // The WritableContext is built lazily and cached — the same context
  // is returned on every call to `context()`.
  let cachedCtx: WritableContext | undefined

  const substrate = {
    [BACKING_DOC]: doc,

    reader: reader,

    prepare(path: Path, change: ChangeBase, options?: BatchOptions): void {
      // Plain has no event bridge / external mutation path, so the
      // replay-vs-local distinction doesn't matter for the substrate
      // write itself. The flag still flows to subscribers via
      // Changeset.replay (set in `merge` below).
      //
      // Inverse recording: under the normal handler, capture σ at the
      // target path before the write, compute the reverse arrow in the
      // change groupoid, and push it on the active runBatch frame's
      // stack. Skipped when `options.compensating === true` — the
      // change is itself an inverse being replayed during abort, and
      // recording its inverse would loop. Also skipped on replay
      // (afterBatch re-materialises σ from λ in one Π pass, so
      // sequential inverse-step would double-count).
      const record = (
        options as
          | (BatchOptions & { [RECORD_INVERSE]?: RecordInverseFn })
          | undefined
      )?.[RECORD_INVERSE]
      if (record && !options?.compensating && !options?.replay) {
        const pre = deepClonePreState(path.read(doc))
        const inverse = invert(pre, change)
        record(path, inverse)
      }
      applyChange(doc, path, change)
      replicaCore.pendingOps.push({ path, change })
    },

    afterBatch(_options?: BatchOptions): void {
      replicaCore.flush()
    },

    context(): WritableContext {
      if (!cachedCtx) {
        let nextTreeNodeCounter = 1
        cachedCtx = buildWritableContext(substrate, {
          nativeResolver: (
            _schema: unknown,
            path: { segments: readonly unknown[] },
          ) => {
            return path.segments.length === 0 ? doc : undefined
          },
          positionResolver: (
            _schema: unknown,
            _path: { segments: readonly unknown[] },
          ) => {
            return {
              createPosition(index: number, side: Side): PlainPosition {
                return new PlainPosition(index, side)
              },
              decodePosition(bytes: Uint8Array): PlainPosition {
                return decodePlainPosition(bytes)
              },
            } satisfies PositionCapable
          },
          treeNodeAllocate: (
            treePath: { key: string },
            _parent?: string | null,
            _index?: number,
          ) => `tree-${treePath.key || "root"}-${nextTreeNodeCounter++}`,
        })
      }
      return cachedCtx
    },

    version(): V {
      return replicaCore.version()
    },

    baseVersion(): V {
      return replicaCore.baseVersion()
    },

    advance(to: V): void {
      replicaCore.advance(to, (_batches: Op[][]) => {
        // Substrate eagerly mutates doc — project trimmed ops in place.
        // The doc is already up to date (prepare applies eagerly), but
        // the base offset needs to advance so exportSince knows what's
        // available. The ops in the trimmed batches are already reflected
        // in doc — no replay needed for the substrate case.
        // (The applyChange calls are redundant here because the substrate
        // already applied them in prepare(). The advance callback exists
        // for the replica case where the base is separate from the log.)
      })
    },

    exportEntirety(): SubstratePayload {
      return replicaCore.exportEntirety()
    },

    exportSince(since: V): SubstratePayload | null {
      return replicaCore.exportSince(since)
    },

    merge(payload: SubstratePayload, options?: BatchOptions): void {
      if (payload.encoding !== "json" || typeof payload.data !== "string") {
        throw new Error(
          "PlainSubstrate.merge expects JSON-encoded payloads. " +
            "If you recently switched CRDT backends, stale clients may be sending incompatible data.",
        )
      }

      const { epoch: legacyEpoch, content } = parsePlainPayload(payload.data)
      // `SubstratePayload.epoch` is the canonical source for the epoch;
      // the legacy `{i, ...}` envelope extraction inside `data` is the
      // fallback for peers that pre-date epoch support.
      const epoch = payload.epoch ?? legacyEpoch

      // Adopt the incoming epoch if we are still DEFAULT (accept our first
      // real identity). True epoch-boundary resets (REAL -> different REAL)
      // are handled exclusively by `resetFromEntirety` — the Synchronizer
      // calls that instead of `merge()` once it detects an epoch mismatch.
      if (
        epoch !== undefined &&
        getEpoch &&
        epoch !== getEpoch() &&
        getEpoch() === DEFAULT_EPOCH
      ) {
        adoptEpoch?.(epoch)
      }

      const ctx = substrate.context()
      // A merge replays authored-elsewhere state; surface `replay: true`
      // so layered consumers (exchange echo filter) can short-circuit
      // without parsing the origin label.
      const replayOptions: BatchOptions = {
        origin: options?.origin,
        replay: true,
      }

      if (payload.kind === "entirety") {
        // State image — decompose to ReplaceChange ops and apply through
        // the prepare/flush pipeline so the changefeed fires and refs
        // observe the transition.
        const ops = stateImageToOps(content as Record<string, unknown>)
        if (ops.length > 0) {
          executeBatch(ctx, ops, replayOptions)
        }
      } else {
        // Batched op array — each inner array is one flush cycle.
        // Apply each batch through the prepare/flush pipeline so that
        // version parity is preserved across export → merge → re-export.
        const batches = content as SerializedOp[][]
        for (const batch of batches) {
          if (batch.length === 0) continue
          const ops = deserializeOps(batch)
          executeBatch(ctx, ops, replayOptions)
        }
      }
    },

    resetFromEntirety(
      payload: SubstratePayload,
      remoteVersion: Version,
      options?: BatchOptions,
    ): void {
      if (
        payload.encoding !== "json" ||
        typeof payload.data !== "string" ||
        payload.kind !== "entirety"
      ) {
        throw new Error(
          "PlainSubstrate.resetFromEntirety expects a JSON entirety payload",
        )
      }

      const { epoch: legacyEpoch, content } = parsePlainPayload(payload.data)
      const epoch = payload.epoch ?? legacyEpoch
      if (epoch !== undefined && getEpoch && epoch !== getEpoch()) {
        adoptEpoch?.(epoch)
      }

      const ctx = substrate.context()
      const replayOptions: BatchOptions = {
        origin: options?.origin,
        replay: true,
      }

      // Decompose to ReplaceChange ops and apply through the prepare/flush
      // pipeline so the changefeed fires and refs observe the transition.
      // Every schema-defined top-level field is present in the incoming
      // entirety (built from Zero.structural on the sender), so replacing
      // each field fully supersedes the prior epoch's value — no explicit
      // doc wipe is needed for the schema-aware substrate case.
      const ops = stateImageToOps(content as Record<string, unknown>)
      if (ops.length > 0) {
        executeBatch(ctx, ops, replayOptions)
      }

      // Resynchronize the log/version with the remote's authoritative
      // value — this prevents flush-count inflation across epochs.
      if (remoteVersion instanceof PlainVersion) {
        replicaCore.resetLog(remoteVersion.value)
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
  _adoptEpoch?: (inc: string) => void,
  getEpoch?: () => string,
) {
  // Version log: log[i] = batch of Ops from flush cycle (baseOffset + i).
  // The absolute flush count is baseOffset + log.length.
  const log: Op[][] = []

  // Base offset: the number of flush cycles that have been trimmed
  // (projected into the base state). Initially 0 — no history trimmed.
  // After advance(), baseOffset increases and log entries are spliced.
  let baseOffset = 0

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
        cachedVersion = strategy.current(baseOffset + log.length)
      }
    },

    version(): V {
      return cachedVersion
    },

    baseVersion(): V {
      return strategy.current(baseOffset)
    },

    /**
     * Advance the base, trimming log entries before `to`.
     *
     * The `advanceBase` callback is invoked with the ops to project into
     * the base state. For a substrate, this replays via `applyChange()`
     * on the doc. For a replica, this replays onto the mutable base state.
     *
     * For strategies without log offset mapping (LWW/Timestamp), only
     * full projection is supported: if `to = version()`, the entire log
     * is projected. Otherwise, the call is a no-op.
     */
    advance(to: V, advanceBase: (batches: Op[][]) => void): void {
      const targetOffset = strategy.logOffset(to)

      if (targetOffset === null) {
        // Strategy cannot map versions to log offsets (LWW/Timestamp).
        // Only full projection is supported: to must equal version().
        if (to.compare(this.version()) === "equal") {
          // Full projection: project entire log, clear it.
          if (log.length > 0) {
            advanceBase([...log])
            baseOffset = baseOffset + log.length
            log.length = 0
          }
        }
        // Otherwise: no-op (undershoot contract — base doesn't move).
        return
      }

      // Validate: targetOffset must be within [baseOffset, baseOffset + log.length].
      if (targetOffset < baseOffset) {
        throw new Error(
          `advance(${to.serialize()}): target offset ${targetOffset} is behind ` +
            `base offset ${baseOffset}`,
        )
      }
      if (targetOffset > baseOffset + log.length) {
        throw new Error(
          `advance(${to.serialize()}): target offset ${targetOffset} exceeds ` +
            `current version offset ${baseOffset + log.length}`,
        )
      }

      const count = targetOffset - baseOffset
      if (count === 0) return // Already at this base — no-op.

      // Project the trimmed log entries onto the base state.
      const trimmed = log.splice(0, count)
      advanceBase(trimmed)
      baseOffset = targetOffset
    },

    resetLog(newBaseOffset: number): void {
      log.length = 0
      baseOffset = newBaseOffset
      cachedVersion = strategy.current(baseOffset)
    },

    exportEntirety(): SubstratePayload {
      return {
        kind: "entirety",
        encoding: "json",
        data: JSON.stringify(materialize()),
        epoch: getEpoch ? getEpoch() : undefined,
      }
    },

    exportSince(since: V): SubstratePayload | null {
      const offset = strategy.logOffset(since)

      // Strategy cannot map the version to a log index — fall back to
      // entirety. This is the TimestampVersion path: wall-clock timestamps
      // have no relationship to the op log array.
      // Additionally, for PlainVersion, this is now triggered for cross-epoch versions.
      if (offset === null) return this.exportEntirety()

      // Peer is behind the base — incremental export is not possible.
      // The caller (synchronizer) should fall back to exportEntirety().
      if (offset < baseOffset) return null

      // Nothing to send: offset is at or beyond the current version.
      if (offset >= baseOffset + log.length) return null

      // Slice relative to the base offset.
      const batches = log.slice(offset - baseOffset)
      if (batches.every(b => b.length === 0)) return null

      const serializedBatches = batches.map(batch => serializeOps(batch))

      return {
        kind: "since",
        encoding: "json",
        data: JSON.stringify(serializedBatches),
        epoch: getEpoch ? getEpoch() : undefined,
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
  adoptEpoch?: (inc: string) => void,
  getEpoch?: () => string,
): Replica<V> {
  // --- Mutable base state ---
  // After advance(), the base incorporates projected ops. Starts empty.
  // materialize() clones this and replays the retained log on top.
  const base: PlainState = {}

  // --- Lazy materialization cache ---
  // The cache is the single materialized PlainState, built by replaying
  // the retained log on top of a clone of `base`. Invalidated on every
  // flush and on advance.
  let cachedState: PlainState | null = null

  /** Replay Base + Log through applyChange to produce current state. */
  function materialize(): PlainState {
    if (cachedState !== null) return cachedState
    // Clone the base — we must not mutate it, as it represents the
    // trim frontier and must remain stable until the next advance().
    const state: PlainState = { ...base }
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
  const core = createPlainReplicaCore(
    materialize,
    strategy,
    adoptEpoch,
    getEpoch,
  )

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

    baseVersion(): V {
      return core.baseVersion()
    },

    advance(to: Version): void {
      // The ReplicaLike contract uses `Version` for variance safety.
      // The synchronizer always pairs replicas with matching factories,
      // so the runtime type is always the correct concrete V.
      core.advance(to as V, (batches: Op[][]) => {
        // Project trimmed ops onto the base state.
        for (const batch of batches) {
          for (const op of batch) {
            applyChange(base, op.path, op.change)
          }
        }
      })
      // Invalidate the materialization cache — the base has changed.
      cachedState = null
    },

    exportEntirety(): SubstratePayload {
      return core.exportEntirety()
    },

    exportSince(since: Version): SubstratePayload | null {
      // Same variance-safety rationale as advance() above.
      return core.exportSince(since as V)
    },

    merge(payload: SubstratePayload, _options?: BatchOptions): void {
      if (payload.encoding !== "json" || typeof payload.data !== "string") {
        throw new Error(
          "PlainReplica.merge expects JSON-encoded payloads. " +
            "If you recently switched CRDT backends, stale clients may be sending incompatible data.",
        )
      }

      const { epoch: legacyEpoch, content } = parsePlainPayload(payload.data)
      const epoch = payload.epoch ?? legacyEpoch
      // Adopt the incoming epoch only while still DEFAULT (accept our first
      // real identity). Genuine epoch-boundary resets (REAL -> different
      // REAL) go through `resetFromEntirety` instead — the Synchronizer
      // calls that once it detects an epoch mismatch.
      if (
        epoch !== undefined &&
        getEpoch &&
        epoch !== getEpoch() &&
        getEpoch() === DEFAULT_EPOCH
      ) {
        adoptEpoch?.(epoch)
      }

      if (payload.kind === "entirety") {
        // State image — decompose to ReplaceChange ops and append as
        // a single batch. No applyChange, no step — just log it.
        const ops = stateImageToOps(content as Record<string, unknown>)
        if (ops.length === 0) return
        for (const op of ops) {
          core.pendingOps.push(op)
        }
        core.flush()
      } else {
        // Batched op array — each inner array is one flush cycle.
        // Replay one flush per batch to preserve version parity.
        const batches = content as SerializedOp[][]
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

    resetFromEntirety(
      payload: SubstratePayload,
      remoteVersion: Version,
      _options?: BatchOptions,
    ): void {
      if (
        payload.encoding !== "json" ||
        typeof payload.data !== "string" ||
        payload.kind !== "entirety"
      ) {
        throw new Error(
          "PlainReplica.resetFromEntirety expects a JSON entirety payload",
        )
      }

      const { epoch: legacyEpoch, content } = parsePlainPayload(payload.data)
      const epoch = payload.epoch ?? legacyEpoch
      if (epoch !== undefined && getEpoch && epoch !== getEpoch()) {
        adoptEpoch?.(epoch)
      }

      // Discard local history and adopt the incoming state and lineage:
      // clear the base, project the new state directly onto it, and
      // synchronize the log/version with the sender's authoritative value.
      // This prevents flush-count inflation across epochs.
      const ops = stateImageToOps(content as Record<string, unknown>)
      for (const key of Object.keys(base)) {
        delete base[key]
      }
      for (const op of ops) {
        applyChange(base, op.path, op.change)
      }
      if (remoteVersion instanceof PlainVersion) {
        core.resetLog(remoteVersion.value)
      }
      cachedState = null
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
  const { strategy } = createPlainVersionStrategy("test")
  return createPlainSubstrate(doc, strategy).context()
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
export function objectToReplaceOps(state: Record<string, unknown>): Op[] {
  const ops: Op[] = []
  for (const [key, value] of Object.entries(state)) {
    ops.push({
      path: RawPath.empty.field(key),
      change: replaceChange(value),
    })
  }
  return ops
}

export function parsePlainPayload(data: string): {
  epoch: string | undefined
  content: unknown
} {
  const parsed = JSON.parse(data)
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "i" in parsed &&
    ("s" in parsed || "b" in parsed)
  ) {
    const raw = parsed as Record<string, unknown>
    return {
      epoch: typeof raw.i === "string" ? raw.i : undefined,
      content: "s" in raw ? raw.s : raw.b,
    }
  }
  return { epoch: undefined, content: parsed }
}

/**
 * Parse a JSON state image and build one `ReplaceChange` op per top-level key.
 *
 * Used by three call sites:
 * - `PlainSubstrate.merge` (entirety path — apply via executeBatch)
 * - `PlainReplica.merge` (entirety path — append to log)
 * - `buildPlainSubstrateFromEntirety` (cold-start construction)
 */
function stateImageToOps(state: Record<string, unknown>): Op[] {
  return objectToReplaceOps(state)
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
  adoptEpoch?: (inc: string) => void,
  getEpoch?: () => string,
): Substrate<V> {
  if (payload.encoding !== "json" || typeof payload.data !== "string") {
    throw new Error(
      "PlainSubstrateFactory.fromEntirety only supports JSON-encoded payloads",
    )
  }

  const { epoch, content } = parsePlainPayload(payload.data)
  if (epoch !== undefined && getEpoch && epoch !== getEpoch()) {
    adoptEpoch?.(epoch)
  }

  // Plain substrates track version via log length — creating a fresh
  // substrate and applying ops via executeBatch advances the version
  // correctly. (CRDT substrates use the two-phase path instead because
  // their version is inherent in the document state.)
  const defaults = Zero.structural(schema) as Record<string, unknown>
  const doc = { ...defaults } as PlainState
  const substrate = createPlainSubstrate(doc, strategy, adoptEpoch, getEpoch)
  const ops = stateImageToOps(content as Record<string, unknown>)
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
  adoptEpoch?: (inc: string) => void,
  getEpoch?: () => string,
): Replica<V> {
  if (payload.encoding !== "json" || typeof payload.data !== "string") {
    throw new Error(
      "PlainReplicaFactory.fromEntirety only supports JSON-encoded payloads",
    )
  }
  const replica = createPlainReplica(strategy, adoptEpoch, getEpoch)
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
  adoptEpoch?: (inc: string) => void,
  getEpoch?: () => string,
): Substrate<V> {
  const materializedState = (replica as any)[BACKING_DOC] as PlainState

  // Create a fresh doc seeded from the replica's materialized state.
  // The substrate owns this doc — the replica's state is not shared.
  const doc = { ...materializedState } as PlainState
  const substrate = createPlainSubstrate(doc, strategy, adoptEpoch, getEpoch)

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
    const { strategy, adoptEpoch, getEpoch } =
      createPlainVersionStrategy(DEFAULT_EPOCH)
    return createPlainReplica(strategy, adoptEpoch, getEpoch)
  },

  fromEntirety(payload: SubstratePayload): Replica<PlainVersion> {
    const { strategy, adoptEpoch, getEpoch } =
      createPlainVersionStrategy(DEFAULT_EPOCH)
    return buildPlainReplicaFromEntirety(
      payload,
      strategy,
      adoptEpoch,
      getEpoch,
    )
  },

  parseVersion(serialized: string): PlainVersion {
    if (serialized === "") {
      throw new Error(`Invalid PlainVersion value: (empty string)`)
    }
    const parts = serialized.split(":")
    let inc: string
    let n: number
    if (parts.length === 2) {
      inc = parts[0]
      n = Number(parts[1])
    } else {
      inc = LEGACY_EPOCH
      n = Number(serialized)
    }
    if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
      throw new Error(`Invalid PlainVersion value: ${serialized}`)
    }
    return new PlainVersion(n, inc)
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
    const { strategy, adoptEpoch, getEpoch } =
      createPlainVersionStrategy(DEFAULT_EPOCH)
    return createPlainReplica(strategy, adoptEpoch, getEpoch)
  },

  upgrade(
    replica: Replica<PlainVersion>,
    schema: SchemaNode,
  ): Substrate<PlainVersion> {
    const inc = replica.version().epoch
    const { strategy, adoptEpoch, getEpoch } = createPlainVersionStrategy(inc)
    return buildUpgrade(replica, schema, strategy, adoptEpoch, getEpoch)
  },

  create(schema: SchemaNode): Substrate<PlainVersion> {
    return this.upgrade(this.createReplica(), schema)
  },

  fromEntirety(
    payload: SubstratePayload,
    schema: SchemaNode,
  ): Substrate<PlainVersion> {
    const { strategy, adoptEpoch, getEpoch } =
      createPlainVersionStrategy(DEFAULT_EPOCH)
    return buildPlainSubstrateFromEntirety(
      payload,
      schema,
      strategy,
      adoptEpoch,
      getEpoch,
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
  | { type: "field"; field: string }
  | { type: "entry"; entry: string }
  | { type: "index"; index: number }

/** A JSON-safe representation of an Op. */
interface SerializedOp {
  path: SerializedSegment[]
  change: ChangeBase
}

/**
 * Convert Ops with Path objects into JSON-safe form for serialization.
 * Extracts segments and produces plain `{ type, field/entry/index }` objects.
 */
function serializeOps(ops: readonly Op[]): SerializedOp[] {
  return ops.map(op => ({
    path: op.path.segments.map(seg => {
      if (seg.role === "field") {
        return { type: "field" as const, field: seg.resolve() as string }
      }
      if (seg.role === "entry") {
        return { type: "entry" as const, entry: seg.resolve() as string }
      }
      return { type: "index" as const, index: seg.resolve() as number }
    }),
    change: op.change,
  }))
}

/**
 * Reconstruct Ops with RawPath objects from JSON-parsed data.
 * Converts plain `{ type, field/entry/index }` arrays back into RawPath instances.
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
    if (seg.type === "field") {
      path = path.field(seg.field)
    } else if (seg.type === "entry") {
      path = path.entry(seg.entry)
    } else {
      path = path.item(seg.index)
    }
  }
  return path
}
