// plain — the plain JS object substrate.
//
// The plain substrate wraps a passive `Record<string, unknown>` and applies
// changes with `applyChange`. It has no native runtime: σ is λ, and the version
// is a flush count on a single authored lineage (`PlainVersion`).
//
// A plain replica is its core: a base state, the op log retained after it, the
// base offset, and a `PlainClock`. The substrate is that core plus σ and a
// changefeed. `buildUpgrade` hands the replica's history to the substrate, so
// `create`, `fromEntirety` and promotion from a headless replica all keep it.
//
// The core reads state through a `materialize` callback: the substrate passes
// `() => doc`, and the headless replica replays base + log on demand.
//
// Context: jj:wmyomqzw (Phase 0), jj:wqoqzzpp (Phase 2), jj:umtmlpvn (version strategy extraction)
// Context: jj:oyouvrss (Phase 1 — append-log replica, init ops, batched wire format)

import { randomHex } from "@kyneta/random"
import type { ChangeBase } from "../change.js"
import { replaceChange } from "../change.js"
import type { Op } from "../changefeed.js"
import { deepClonePlain } from "../clone.js"
import type { Path } from "../interpret.js"
import type { WritableContext } from "../interpreters/writable.js"
import { announce, buildWritableContext } from "../interpreters/writable.js"
import { invert } from "../inverse.js"
import { RawPath } from "../path.js"
import {
  decodePlainPosition,
  PlainPosition,
  type PositionCapable,
  type Side,
} from "../position.js"
import {
  applyChange,
  ownedForStore,
  type PlainState,
  plainReader,
} from "../reader.js"
import type { Schema as SchemaNode } from "../schema.js"
import type {
  HasBackingDoc,
  MergeOptions,
  RecordInverseFn,
  Replica,
  ReplicaFactory,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
  Version,
} from "../substrate.js"
import { BACKING_DOC, hasBackingDoc } from "../substrate.js"
import { versionVectorCompare, versionVectorMeet } from "../version-vector.js"
import { Zero } from "../zero.js"

// ---------------------------------------------------------------------------
// PlainVersion — monotonic integer version marker
// ---------------------------------------------------------------------------

// The genesis / empty-vector marker: a version whose authored lineage is
// not yet minted — the ⊥ (bottom) of the lineage lattice. A newly created
// replica holds only schema-derived structure (reconstructible by every
// peer from the schema alone), so its `toVector()` projection is the EMPTY
// version vector: it compares "equal" to any other genesis and "behind"
// (a subset of) any REAL lineage. The first authored write mints a REAL
// lineage (see `PlainClock`). This is Plain's analog of a
// fresh Loro doc's empty version vector — see jj:kxswmuzx.
export const DEFAULT_LINEAGE = "kyneta.genesis"

export class PlainVersion implements Version {
  readonly #value: number
  readonly #lineage: string

  constructor(value: number, lineage: string) {
    this.#value = value
    this.#lineage = lineage
  }

  /** The raw version integer. */
  get value(): number {
    return this.#value
  }

  get lineage(): string {
    return this.#lineage
  }

  serialize(): string {
    return `${this.#lineage}:${this.#value}`
  }

  /**
   * Project this version to a single-entry version vector: genesis
   * (`DEFAULT_LINEAGE`) → the empty vector ⊥; a REAL lineage → `{lineage: value}`.
   * `compare`/`meet` are then the shared `versionVector*` algebra — the same
   * lattice Loro/Yjs use — with zero Plain-specific special cases. See
   * jj:kxswmuzx for the derivation.
   */
  #toVector(): Map<string, number> {
    if (this.#lineage === DEFAULT_LINEAGE) return new Map()
    return new Map([[this.#lineage, this.#value]])
  }

  compare(other: Version): "behind" | "equal" | "ahead" | "concurrent" {
    if (!(other instanceof PlainVersion)) {
      throw new Error(
        "PlainVersion can only be compared with another PlainVersion",
      )
    }
    return versionVectorCompare(this.#toVector(), other.#toVector())
  }

  meet(other: Version): PlainVersion {
    if (!(other instanceof PlainVersion)) {
      throw new Error(
        "PlainVersion can only be meet'd with another PlainVersion",
      )
    }
    // Greatest common ancestor of the two lineage vectors. For divergent
    // lineages the meet is the empty vector → genesis; for a shared lineage
    // it is the min counter. Inputs are ≤1 entry (single authored lineage,
    // prune-on-reset), so the result is ≤1 entry.
    const met = versionVectorMeet(this.#toVector(), other.#toVector())
    const entry = met.entries().next()
    if (entry.done) return new PlainVersion(0, DEFAULT_LINEAGE)
    const [lineage, value] = entry.value
    return new PlainVersion(value, lineage)
  }
}

// ---------------------------------------------------------------------------
// PlainClock — lineage and the flush-count ↔ version mapping
// ---------------------------------------------------------------------------

/**
 * A plain document's version clock: the lineage it authors under, and how
 * flush counts map to versions and back.
 *
 * `adopt` is the only mutator. The substrate mints a lineage on its first
 * authored flush, and a merge adopts a peer's lineage while still at genesis.
 * `version` is a pure projection and never mints. Context: jj:kxswmuzx.
 */
export interface PlainClock {
  lineage(): string
  adopt(next: string): void
  /** The version after `flushCount` flush cycles on the current lineage. */
  version(flushCount: number): PlainVersion
  /** The log offset `since` names, or `null` when it is from another lineage. */
  logOffset(since: PlainVersion): number | null
}

export function createPlainClock(initialLineage: string): PlainClock {
  let lineage = initialLineage
  return {
    lineage: () => lineage,
    adopt(next: string) {
      lineage = next
    },
    version: (flushCount: number) => new PlainVersion(flushCount, lineage),
    logOffset(since: PlainVersion) {
      // Genesis is the empty vector ⊥: it precedes the whole authored log, so
      // a genesis peer receives everything regardless of the counter it carries.
      if (since.lineage === DEFAULT_LINEAGE) return 0
      if (since.lineage !== lineage) return null
      return since.value
    },
  }
}

/**
 * Narrow a `Version` received through the variance-safe `ReplicaLike`
 * surface. The synchronizer pairs every replica with its own factory, so
 * anything else is a wiring error.
 */
function asPlainVersion(version: Version): PlainVersion {
  if (!(version instanceof PlainVersion)) {
    throw new Error(
      `plain substrate expected a PlainVersion, got ${version.serialize()}`,
    )
  }
  return version
}

// ---------------------------------------------------------------------------
// PlainHistory — the op log a substrate inherits on upgrade
// ---------------------------------------------------------------------------

/**
 * Retained op history: the batches logged after `baseOffset` flush cycles
 * were trimmed into the base state.
 */
export interface PlainHistory {
  readonly log: readonly (readonly Op[])[]
  readonly baseOffset: number
}

export const EMPTY_HISTORY: PlainHistory = { log: [], baseOffset: 0 }

// ---------------------------------------------------------------------------
// createPlainSubstrate — full Substrate from a doc, a clock and a history
// ---------------------------------------------------------------------------

/**
 * Creates a `Substrate<PlainVersion>` over a plain JS object document.
 *
 * `prepare` mutates `doc` eagerly, so the core's `materialize` is `() => doc`.
 * `history` must describe `doc`: its log replayed onto the trimmed base
 * produces `doc`. `plainSubstrateFactory` is the schema-aware entry point.
 */
export function createPlainSubstrate(
  doc: PlainState,
  clock: PlainClock,
  history: PlainHistory,
): Substrate<PlainVersion> {
  const reader = plainReader(doc)
  const core = createPlainCore(() => doc, clock, history)

  // Ops of the authored batch in progress: filled by `prepare`, logged by
  // `afterBatch`.
  const pendingOps: Op[] = []

  // The WritableContext is built lazily and cached — the same context
  // is returned on every call to `context()`.
  let cachedCtx: WritableContext | undefined

  const substrate = {
    [BACKING_DOC]: doc,

    reader: reader,

    prepare(
      path: Path,
      change: ChangeBase,
      recordInverse: RecordInverseFn | null,
    ): void {
      if (recordInverse) {
        // Read, don't copy. `invert` snapshots whatever it retains — see
        // `invertReplace`, `invertMap`, `invertSequence` and the rich-text
        // marks in `inverse.ts`, each of which deep-clones the pre-state it
        // captures. Copying here as well protected nothing and cost a deep
        // clone of the written subtree on every local write.
        recordInverse(path, invert(path.read(doc), change))
      }
      applyChange(doc, path, ownedForStore(change))
      // Freeze to an immutable RawPath before the op enters the log. The live
      // AddressedPath aliases memoized registry Address objects that a later
      // delete tombstones and a later insert re-indexes, in place — logging it
      // would let those mutations corrupt this historical op (export throws, or
      // serializes a drifted index). The addressed `path` above is still needed
      // for the σ read and inverse; only the logged copy is frozen. jj:mlurlzqt
      pendingOps.push({ path: path.toRaw(), change })
    },

    afterBatch(): void {
      if (pendingOps.length === 0) return
      // Mint a REAL lineage on the first authored flush. Only authored
      // batches reach here: a merge appends to the log directly, so taking
      // in a peer's ops never claims an identity. Minting before the append
      // makes the new version carry the new lineage.
      if (clock.lineage() === DEFAULT_LINEAGE) clock.adopt(randomHex(8))
      core.append(pendingOps.splice(0))
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

    version(): PlainVersion {
      return core.version()
    },

    baseVersion(): PlainVersion {
      return core.baseVersion()
    },

    advance(to: Version): void {
      // `doc` already holds every logged op, so trimming moves only the base
      // offset; there is nothing to project.
      core.advance(asPlainVersion(to), () => {})
    },

    exportEntirety(): SubstratePayload {
      return core.exportEntirety()
    },

    exportSince(since: Version): SubstratePayload | null {
      return core.exportSince(asPlainVersion(since))
    },

    merge(payload: SubstratePayload, options?: MergeOptions): void {
      const batches = payloadBatches(payload, "PlainSubstrate.merge")
      if (shouldAdoptLineage(payload.lineage, clock.lineage())) {
        clock.adopt(payload.lineage)
      }
      // One announcement per sender batch, each after the doc and the log
      // hold it.
      for (const batch of batches) {
        applyOps(doc, batch)
        core.append(batch)
        announce(substrate.context(), batch, options?.origin)
      }
    },

    resetFromEntirety(
      payload: SubstratePayload,
      remoteVersion: Version,
      options?: MergeOptions,
    ): void {
      const { lineage, ops } = resetPlan(
        payload,
        "PlainSubstrate.resetFromEntirety",
      )
      if (lineage !== undefined && lineage !== clock.lineage()) {
        clock.adopt(lineage)
      }
      // Every schema-defined top-level field is present in the incoming
      // entirety (built from Zero.structural on the sender), so replacing each
      // field supersedes the prior lineage's value without wiping the doc.
      applyOps(doc, ops)
      // Adopt the remote's flush count, so the version does not inflate
      // across lineages.
      core.resetLog(asPlainVersion(remoteVersion).value)
      if (ops.length > 0) announce(substrate.context(), ops, options?.origin)
    },
  }

  return substrate
}

// ---------------------------------------------------------------------------
// createPlainCore — the log, versioning and export of replica and substrate
// ---------------------------------------------------------------------------

/**
 * The replication core of a plain replica or substrate: the op log, the base
 * offset, and export. It knows nothing of schemas or the changefeed.
 *
 * `materialize` returns the current state: `() => doc` for a substrate, a
 * base + log replay for a headless replica.
 */
function createPlainCore(
  materialize: () => PlainState,
  clock: PlainClock,
  history: PlainHistory,
) {
  // log[i] is the batch of flush cycle (baseOffset + i). Batches are never
  // mutated after they are logged, so the seed is copied one level deep.
  const log: (readonly Op[])[] = [...history.log]
  let baseOffset = history.baseOffset

  // Bumped by every change to the log or the base, so a lazily materialized
  // state can tell whether it is stale.
  let revision = 0

  return {
    log: log as readonly (readonly Op[])[],

    /** Log one flush cycle's batch. An empty batch is not a flush cycle. */
    append(ops: readonly Op[]): void {
      if (ops.length === 0) return
      log.push(ops)
      revision++
    },

    revision(): number {
      return revision
    },

    history(): PlainHistory {
      return { log: [...log], baseOffset }
    },

    version(): PlainVersion {
      return clock.version(baseOffset + log.length)
    },

    baseVersion(): PlainVersion {
      return clock.version(baseOffset)
    },

    /**
     * Trim the log up to `to`, handing the trimmed batches to `advanceBase`
     * to project into the base state.
     */
    advance(
      to: PlainVersion,
      advanceBase: (batches: readonly (readonly Op[])[]) => void,
    ): void {
      const targetOffset = clock.logOffset(to)
      // A version from another lineage names no position in this log. The
      // base stays put, which the undershoot contract of `advance` allows.
      if (targetOffset === null) return

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
      if (count === 0) return

      advanceBase(log.splice(0, count))
      baseOffset = targetOffset
      revision++
    },

    /** Discard the log and restart counting at `newBaseOffset`. */
    resetLog(newBaseOffset: number): void {
      log.length = 0
      baseOffset = newBaseOffset
      revision++
    },

    exportEntirety(): SubstratePayload {
      return {
        kind: "entirety",
        encoding: "json",
        data: JSON.stringify(materialize()),
        lineage: clock.lineage(),
      }
    },

    exportSince(since: PlainVersion): SubstratePayload | null {
      const offset = clock.logOffset(since)

      // A cursor from another lineage cannot be served from this log; the
      // whole document is the only answer that means anything to it.
      if (offset === null) return this.exportEntirety()

      // Peer is behind the base — incremental export is not possible.
      // The caller (synchronizer) should fall back to exportEntirety().
      if (offset < baseOffset) return null

      // Nothing to send: offset is at or beyond the current version.
      if (offset >= baseOffset + log.length) return null

      // Slice relative to the base offset.
      const batches = log.slice(offset - baseOffset)
      if (batches.every(b => b.length === 0)) return null

      return {
        kind: "since",
        encoding: "json",
        data: JSON.stringify(batches.map(batch => serializeOps(batch))),
        lineage: clock.lineage(),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// createPlainReplica — headless append-log replication surface (no schema)
// ---------------------------------------------------------------------------

/**
 * The history of every replica `createPlainReplica` built, for `buildUpgrade`.
 * Module-private, so no other code can reach a replica's log.
 */
const replicaHistories = new WeakMap<
  Replica<PlainVersion>,
  () => PlainHistory
>()

/**
 * Creates a headless `Replica<PlainVersion>`: an append-log that accumulates
 * payloads without interpreting them, and materializes state on demand.
 *
 * Merge never touches state; ops are appended to the log. State is derived
 * from base + log when `exportEntirety()` or `[BACKING_DOC]` asks for it.
 *
 * Used by conduit participants (stores, routing servers) that need to
 * accumulate state, compute deltas, and compact storage without ever reading
 * or writing document fields.
 */
export function createPlainReplica(clock: PlainClock): Replica<PlainVersion> {
  // The base incorporates every op trimmed by `advance`.
  const base: PlainState = {}

  let cached: { readonly revision: number; readonly state: PlainState } | null =
    null

  /**
   * Replay base + log. `applyChange` steps containers in place, so the replay
   * runs on a deep copy of the base, and each logged payload is copied before
   * it is applied: the base and the log both outlive this state.
   */
  function materialize(): PlainState {
    const revision = core.revision()
    if (cached !== null && cached.revision === revision) return cached.state
    const state = deepClonePlain(base)
    for (const batch of core.log) applyOps(state, batch)
    cached = { revision, state }
    return state
  }

  const core = createPlainCore(materialize, clock, EMPTY_HISTORY)

  const replica: Replica<PlainVersion> & HasBackingDoc<PlainState> = {
    get [BACKING_DOC](): PlainState {
      return materialize()
    },

    version(): PlainVersion {
      return core.version()
    },

    baseVersion(): PlainVersion {
      return core.baseVersion()
    },

    advance(to: Version): void {
      // Trimmed batches leave the log, so the base may take their payloads
      // without copying.
      core.advance(asPlainVersion(to), batches => {
        for (const batch of batches) {
          for (const op of batch) {
            applyChange(base, op.path, op.change)
          }
        }
      })
    },

    exportEntirety(): SubstratePayload {
      return core.exportEntirety()
    },

    exportSince(since: Version): SubstratePayload | null {
      return core.exportSince(asPlainVersion(since))
    },

    merge(payload: SubstratePayload, _options?: MergeOptions): void {
      const batches = payloadBatches(payload, "PlainReplica.merge")
      if (shouldAdoptLineage(payload.lineage, clock.lineage())) {
        clock.adopt(payload.lineage)
      }
      for (const batch of batches) core.append(batch)
    },

    resetFromEntirety(
      payload: SubstratePayload,
      remoteVersion: Version,
      _options?: MergeOptions,
    ): void {
      const { lineage, ops } = resetPlan(
        payload,
        "PlainReplica.resetFromEntirety",
      )
      if (lineage !== undefined && lineage !== clock.lineage()) {
        clock.adopt(lineage)
      }
      // Discard local history: the incoming state becomes the base.
      for (const key of Object.keys(base)) {
        delete base[key]
      }
      for (const op of ops) {
        applyChange(base, op.path, op.change)
      }
      core.resetLog(asPlainVersion(remoteVersion).value)
    },
  }

  replicaHistories.set(replica, core.history)
  return replica
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
  return createPlainSubstrate(
    doc,
    createPlainClock("test"),
    EMPTY_HISTORY,
  ).context()
}

// ---------------------------------------------------------------------------
// Payload decomposition — pure helpers shared by replica and substrate
// ---------------------------------------------------------------------------

/**
 * Build one `ReplaceChange` op per top-level key in a state object.
 *
 * Every path that turns a whole state image into changes goes through here:
 * entirety payloads (`payloadBatches`, `resetPlan`), `buildUpgrade`'s
 * structural defaults, and the ephemeral substrate's announcement of what a
 * merge or a decay sweep moved.
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
  content: unknown
} {
  return { content: JSON.parse(data) }
}

/**
 * The batches a payload carries, one per flush cycle on the sender. An
 * entirety is one batch of top-level replaces; a delta is its non-empty
 * logged batches. Keeping the sender's batching preserves version parity
 * across export → merge → re-export.
 */
function payloadBatches(payload: SubstratePayload, label: string): Op[][] {
  if (payload.encoding !== "json" || typeof payload.data !== "string") {
    throw new Error(
      `${label} expects JSON-encoded payloads. ` +
        "If you recently switched CRDT backends, stale clients may be sending incompatible data.",
    )
  }
  const { content } = parsePlainPayload(payload.data)
  if (payload.kind === "entirety") {
    const ops = objectToReplaceOps(content as Record<string, unknown>)
    return ops.length === 0 ? [] : [ops]
  }
  return (content as SerializedOp[][])
    .filter(batch => batch.length > 0)
    .map(deserializeOps)
}

/**
 * Apply ops taken in from elsewhere to `state`. Each payload is copied, since
 * the op is also logged and delivered to subscribers.
 */
function applyOps(state: PlainState, ops: readonly Op[]): void {
  for (const op of ops) {
    applyChange(state, op.path, ownedForStore(op.change))
  }
}

/**
 * Whether a merge adopts the payload's lineage: only while this document is
 * still at genesis. A REAL → different REAL transition is a lineage boundary,
 * which only `resetFromEntirety` crosses.
 */
function shouldAdoptLineage(
  incoming: string | undefined,
  current: string,
): incoming is string {
  return (
    incoming !== undefined &&
    incoming !== current &&
    current === DEFAULT_LINEAGE
  )
}

/** The lineage and top-level replaces of an entirety that resets a document. */
function resetPlan(
  payload: SubstratePayload,
  label: string,
): { readonly lineage: string | undefined; readonly ops: Op[] } {
  if (payload.kind !== "entirety") {
    throw new Error(`${label} expects an entirety payload`)
  }
  const [ops = []] = payloadBatches(payload, label)
  return { lineage: payload.lineage, ops }
}

// ---------------------------------------------------------------------------
// buildUpgrade — a replica gains a schema, σ and a changefeed
// ---------------------------------------------------------------------------

/**
 * Upgrade a replica built by `createPlainReplica` into a substrate over the
 * same state and history.
 *
 * Structural defaults for schema keys the state lacks are applied to the doc
 * without entering the log. They are a pure function of the schema, so every
 * interpreter reconstructs them, and a fresh doc's version stays genesis ⊥.
 * Context: jj:kxswmuzx.
 */
function buildUpgrade(
  replica: Replica<PlainVersion>,
  schema: SchemaNode,
): Substrate<PlainVersion> {
  const history = replicaHistories.get(replica)
  if (history === undefined || !hasBackingDoc<PlainState>(replica)) {
    throw new Error(
      "upgrade() requires a replica produced by this substrate factory.",
    )
  }

  // The replica keeps its materialized state cached, and the substrate
  // steps containers in place, so the substrate takes a copy.
  const doc = deepClonePlain(replica[BACKING_DOC])
  const substrate = createPlainSubstrate(
    doc,
    createPlainClock(replica.version().lineage),
    history(),
  )

  const defaults = Zero.structural(schema) as Record<string, unknown>
  const missing: Record<string, unknown> = {}
  for (const key of Object.keys(defaults)) {
    if (!(key in doc)) {
      missing[key] = defaults[key]
    }
  }
  for (const op of objectToReplaceOps(missing)) {
    applyChange(doc, op.path, op.change)
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
    return createPlainReplica(createPlainClock(DEFAULT_LINEAGE))
  },

  fromEntirety(payload: SubstratePayload): Replica<PlainVersion> {
    const replica = this.createEmpty()
    replica.merge(payload)
    return replica
  },

  parseVersion(serialized: string): PlainVersion {
    if (serialized === "") {
      throw new Error(`Invalid PlainVersion value: (empty string)`)
    }
    const parts = serialized.split(":")
    if (parts.length !== 2) {
      throw new Error(`Invalid PlainVersion value: ${serialized}`)
    }
    const lineage = parts[0]
    const n = Number(parts[1])
    if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
      throw new Error(`Invalid PlainVersion value: ${serialized}`)
    }
    return new PlainVersion(n, lineage)
  },
}

// ---------------------------------------------------------------------------
// PlainSubstrateFactory — schema-aware construction
// ---------------------------------------------------------------------------

/**
 * Factory for constructing plain JS object substrates. Every construction is
 * `upgrade` of a replica, so none of them restarts history.
 *
 * - `createReplica()` → bare replica (empty doc)
 * - `upgrade(replica, schema)` → full substrate over the replica's state and log
 * - `create(schema)` = `upgrade(createReplica(), schema)`
 * - `fromEntirety(payload, schema)` = `upgrade(replica.fromEntirety(payload), schema)`
 * - `parseVersion(serialized)` — deserialize a PlainVersion
 */
export const plainSubstrateFactory: SubstrateFactory<PlainVersion> = {
  createReplica(): Replica<PlainVersion> {
    return plainReplicaFactory.createEmpty()
  },

  upgrade(
    replica: Replica<PlainVersion>,
    schema: SchemaNode,
  ): Substrate<PlainVersion> {
    return buildUpgrade(replica, schema)
  },

  create(schema: SchemaNode): Substrate<PlainVersion> {
    return this.upgrade(this.createReplica(), schema)
  },

  fromEntirety(
    payload: SubstratePayload,
    schema: SchemaNode,
  ): Substrate<PlainVersion> {
    return this.upgrade(plainReplicaFactory.fromEntirety(payload), schema)
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
 *
 * `seg.resolve()` here never throws: the log holds only `RawPath` ops —
 * local writes are frozen via `path.toRaw()` in `prepare`, merged ops are
 * already raw from `deserializeOps` — and `RawSegment.resolve()` is total.
 * The dead-`Address` hazard was the *input*, fixed there, not here. jj:mlurlzqt
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
