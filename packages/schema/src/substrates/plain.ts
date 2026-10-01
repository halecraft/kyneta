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
// `() => cell.current`, and the headless replica replays base + log on demand.
//
// Context: jj:wmyomqzw (Phase 0), jj:wqoqzzpp (Phase 2), jj:umtmlpvn (version strategy extraction)
// Context: jj:oyouvrss (Phase 1 — append-log replica, init ops, batched wire format)

import { randomHex } from "@kyneta/random"
import type { ChangeBase } from "../change.js"
import { replaceChange, trustAsOwned } from "../change.js"
import type { Op } from "../changefeed.js"
import { freezeTree } from "../clone.js"
import { completeAt, completeValue } from "../complete.js"
import type { Path } from "../interpret.js"
import {
  createMaterializeInterpreter,
  plainValueResolver,
} from "../interpreters/materialize.js"
import type { WritableContext } from "../interpreters/writable.js"
import { buildWritableContext } from "../interpreters/writable.js"
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
  freezePayload,
  type PlainState,
  plainReader,
  type StateCell,
} from "../reader.js"
import { planReconcile, reconcileShadow } from "../reconcile-shadow.js"
import type { Schema as SchemaNode } from "../schema.js"
import type {
  BatchOutcome,
  HasBackingDoc,
  HydrationHandle,
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
import {
  versionVectorCompare,
  versionVectorJoin,
  versionVectorMeet,
} from "../version-vector.js"
import { createLocalUpdateSignal } from "./local-update-signal.js"
import { deserializeOps, type SerializedOp, serializeOps } from "./op-codec.js"
import { createPlainRevertible } from "./plain-revertible.js"

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

/** Base-36 digits of the mint time: enough for any millisecond before 5000 AD. */
const MINT_TIME_DIGITS = 9

/**
 * A new lineage, minted at `now` (milliseconds): the mint time as fixed-width
 * base 36, then random hex. String order is mint order, and the random part
 * breaks a tie within one millisecond, so two lineages always compare one
 * way (see {@link supersedes}).
 */
export function mintLineage(now: number): string {
  return `${Math.floor(now).toString(36).padStart(MINT_TIME_DIGITS, "0")}${randomHex(8)}`
}

/**
 * Does real lineage `a` supersede real lineage `b`: was it minted later?
 *
 * A plain document has one writer, so two real lineages meeting means a writer
 * restarted without its history, or two writers authored the document. Either
 * way every peer must settle on the same one, and the later is the one a
 * restarted writer minted. The order is by wall clock, so a writer whose clock
 * is behind the lineage it replaces loses to it.
 */
export function supersedes(a: string, b: string): boolean {
  return a > b
}

/**
 * The lineage a document holding all of `lineages` belongs to: the one that
 * supersedes the rest. Genesis (`DEFAULT_LINEAGE`) is continued by any real
 * lineage, so it is the answer only when nothing else is given.
 */
export function latestLineage(lineages: Iterable<string>): string {
  let latest = DEFAULT_LINEAGE
  for (const lineage of lineages) {
    if (lineage === DEFAULT_LINEAGE) continue
    if (latest === DEFAULT_LINEAGE || supersedes(lineage, latest)) {
      latest = lineage
    }
  }
  return latest
}

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
   * `compare`/`meet`/`join` are then the shared `versionVector*` algebra,
   * the same lattice Loro/Yjs use, with no Plain-specific special cases.
   * See jj:kxswmuzx for the derivation.
   */
  #toVector(): Map<string, number> {
    if (this.#lineage === DEFAULT_LINEAGE) return new Map()
    return new Map([[this.#lineage, this.#value]])
  }

  /**
   * The inverse of `#toVector`. A plain replica holds one lineage, so a vector
   * naming two, which only a join of two real lineages produces, is no
   * version at all.
   */
  static #fromVector(vector: Map<string, number>): PlainVersion {
    if (vector.size > 1) {
      throw new Error(
        `PlainVersion: versions of different lineages have no join (${[...vector.keys()].join(", ")})`,
      )
    }
    const entry = vector.entries().next()
    if (entry.done) return new PlainVersion(0, DEFAULT_LINEAGE)
    const [lineage, value] = entry.value
    return new PlainVersion(value, lineage)
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
    // it is the min counter.
    return PlainVersion.#fromVector(
      versionVectorMeet(this.#toVector(), other.#toVector()),
    )
  }

  /** The larger counter within one lineage; genesis joins as the identity. */
  join(other: Version): PlainVersion {
    if (!(other instanceof PlainVersion)) {
      throw new Error(
        "PlainVersion can only be joined with another PlainVersion",
      )
    }
    return PlainVersion.#fromVector(
      versionVectorJoin(this.#toVector(), other.#toVector()),
    )
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
      // a genesis peer is served from offset 0 whatever counter it carries.
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

/**
 * Why authored writes are refused, or `null` when they are allowed. Read at
 * every authored write.
 */
export type Authoring = () => string | null

/** For a substrate that may author from the start. */
export const ALWAYS_AUTHOR: Authoring = () => null

const STILL_LOADING =
  "This document is still loading from its store. " +
  "Await whenHydrated(doc) before writing to it."

// ---------------------------------------------------------------------------
// createPlainSubstrate — full Substrate from a doc, a clock and a history
// ---------------------------------------------------------------------------

/**
 * Creates a `Substrate<PlainVersion>` over a plain JS object document.
 *
 * σ starts as `doc`, which the substrate takes as its own: a write may change
 * it in place, and a read freezes it. `prepare` advances σ eagerly, so the
 * core's `materialize` is σ itself. `history` must describe `doc`: its log
 * replayed onto the trimmed base produces `doc`. `schema` is `doc`'s: a reset
 * announces what it moved by diffing the two states under it.
 * `plainSubstrateFactory` is the schema-aware entry point.
 *
 * `authoring` gives the reason authored writes are refused, if any: while the
 * document's own history is still loading (a plain merge does not commute with
 * a local write, so a write made then has no well-defined result: the loaded
 * state would overwrite it, and it would mint a lineage the store does not
 * know), or once another writer holds the document. Authored writes throw the
 * reason; merges and announcements are unaffected.
 */
export function createPlainSubstrate(
  doc: PlainState,
  schema: SchemaNode,
  clock: PlainClock,
  history: PlainHistory,
  authoring: Authoring,
): Substrate<PlainVersion> {
  const cell: StateCell = { current: doc }
  const reader = plainReader(cell)
  const core = createPlainCore(() => cell.current, clock, history)

  // Ops of the authored batch in progress: filled by `prepare`, logged by
  // `afterBatch`.
  const pendingOps: Op[] = []

  // Every op this substrate logs locally is authored here, so a batch that
  // logged something is exactly a local update.
  const localUpdates = createLocalUpdateSignal()

  // The WritableContext is built lazily and cached — the same context
  // is returned on every call to `context()`.
  let cachedCtx: WritableContext | undefined

  /**
   * How ops taken in from elsewhere reach the doc: completed, applied, then
   * announced, after the log already holds them as sent. One announcement
   * per sender batch.
   */
  const docEffects = (options?: MergeOptions): PlainEffects => ({
    append(batch) {
      // Each op is completed against σ as it stands when that op applies,
      // since a sum's variant can depend on the ops before it.
      const completed = batch.map(op => {
        const change = completeAt(schema, reader, op.path, op.change)
        applyChange(cell, op.path, freezePayload(change))
        return change === op.change ? op : { path: op.path, change }
      })
      substrate.context().announce(completed, {
        origin: options?.origin,
        local: false,
      })
    },
    adopt(state) {
      // Reconcile σ at the root against `state`: the fold over it completes
      // it, as `completeValue` would, and the ops are what a local writer
      // would have written to get there, per field, record key, list
      // position and register, so every subscriber below a moved value
      // hears it, and a list item that stayed keeps its address.
      const resolver = plainValueResolver(state)
      const ops = reconcileShadow(
        cell,
        planReconcile(schema, [{ path: RawPath.empty, effect: "all" }]),
        resolver,
        createMaterializeInterpreter(resolver),
      )
      substrate.context().announce(ops, {
        origin: options?.origin,
        local: false,
      })
    },
  })

  const revertible = createPlainRevertible({
    head: () => core.version().serialize(),
    isPast: position =>
      core.version().compare(plainReplicaFactory.parseVersion(position)) ===
      "ahead",
    context: () => substrate.context(),
  })

  const substrate = {
    get [BACKING_DOC](): PlainState {
      return cell.current
    },

    reader: reader,

    prepare(
      path: Path,
      change: ChangeBase,
      recordInverse: RecordInverseFn | null,
    ): void {
      const refusal = authoring()
      if (refusal !== null) throw new Error(refusal)
      if (recordInverse) {
        // Read, don't copy. `invert` owns whatever it retains (`own`): a
        // value a read froze is shared, since no write can change it, and
        // anything else is copied.
        recordInverse(path, invert(path.read(cell.current), change))
      }
      // The writable context completed the change, so σ and the log take the
      // same value, frozen and shared.
      applyChange(cell, path, freezePayload(change))
      // Freeze to an immutable RawPath before the op enters the log. The live
      // AddressedPath aliases memoized registry Address objects that a later
      // delete tombstones and a later insert re-indexes, in place — logging it
      // would let those mutations corrupt this historical op (export throws, or
      // serializes a drifted index). The addressed `path` above is still needed
      // for the σ read and inverse; only the logged copy is frozen. jj:mlurlzqt
      pendingOps.push({ path: path.toRaw(), change })
    },

    afterBatch(outcome: BatchOutcome): void {
      if (pendingOps.length === 0) return
      const before = core.version().serialize()
      // Mint a REAL lineage on the first authored flush. Only authored
      // batches reach here: a merge appends to the log directly, so taking
      // in a peer's ops never claims an identity. Minting before the append
      // makes the new version carry the new lineage.
      if (clock.lineage() === DEFAULT_LINEAGE) {
        clock.adopt(mintLineage(Date.now()))
      }
      core.append(pendingOps.splice(0))
      revertible.captured(outcome, before, core.version().serialize())
      localUpdates.notify()
    },

    revertible,

    subscribeLocalUpdates: localUpdates.subscribe,

    // Only Kyneta writes here, and a batch commits when it ends.
    commitPending(): void {},

    context(): WritableContext {
      if (!cachedCtx) {
        let nextTreeNodeCounter = 1
        cachedCtx = buildWritableContext(substrate, schema, {
          nativeResolver: (
            _schema: unknown,
            path: { segments: readonly unknown[] },
          ) => {
            return path.segments.length === 0 ? cell.current : undefined
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
      // σ already holds every logged op, so trimming moves only the base
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
      core.merge(
        decodePlainPayload(payload, "PlainSubstrate.merge"),
        docEffects(options),
      )
    },

    resetFromEntirety(payload: SubstratePayload, options?: MergeOptions): void {
      core.adopt(
        decodeEntirety(payload, "PlainSubstrate.resetFromEntirety"),
        docEffects(options),
      )
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
 * `materialize` returns the current state: σ for a substrate, a base + log
 * replay for a headless replica.
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

  /** How many flush cycles this replica holds: the count its version carries. */
  const position = (): number => baseOffset + log.length

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
      return clock.version(position())
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
      // A target from another lineage names no position in this log, and one
      // the base has already passed (genesis included) has nothing left to
      // trim: `advance` trims as far as it can without passing `to`.
      if (targetOffset === null || targetOffset <= baseOffset) return
      if (targetOffset > baseOffset + log.length) {
        throw new Error(
          `advance(${to.serialize()}): target offset ${targetOffset} exceeds ` +
            `current version offset ${baseOffset + log.length}`,
        )
      }

      const count = targetOffset - baseOffset
      advanceBase(log.splice(0, count))
      baseOffset = targetOffset
      revision++
    },

    exportEntirety(): SubstratePayload {
      const body: EntiretyBody = { at: position(), state: materialize() }
      return {
        kind: "entirety",
        encoding: "json",
        data: JSON.stringify(body),
        lineage: clock.lineage(),
      }
    },

    exportSince(since: PlainVersion): SubstratePayload | null {
      const offset = clock.logOffset(since)

      // A cursor from another lineage cannot be served from this log; the
      // whole document is the only answer that means anything to it.
      if (offset === null) return this.exportEntirety()

      // Behind the trimmed base: the delta can no longer be computed, and the
      // caller answers with the whole document.
      if (offset < baseOffset) return null

      // At or beyond our position this is an empty delta, not `null`: a peer
      // that is merely current must not be answered with the whole document.
      const from = Math.min(offset, position())
      const body: SinceBody = {
        from,
        batches: log.slice(from - baseOffset).map(serializeOps),
      }
      return {
        kind: "since",
        encoding: "json",
        data: JSON.stringify(body),
        lineage: clock.lineage(),
      }
    },

    /**
     * Take in a payload: decide with `planMerge`, keep the log's books, and
     * hand the ops to `effects` to reach the state. A gap applies nothing,
     * which leaves the version short of the one the payload was offered at.
     *
     * The log keeps each batch as sent. It is history shared across peers and
     * addressed by position: a schema-less replica serves it as received, and
     * peers on different schemas would log different contents at the same
     * positions if each rewrote it. A substrate's `effects` complete the ops
     * on their way into σ.
     */
    merge(payload: PlainPayload, effects: PlainEffects): void {
      const plan = planMerge(position(), clock.lineage(), payload)
      switch (plan.kind) {
        case "gap":
        case "none":
          return
        case "append":
          // A merge claims a lineage only while this replica has none; a
          // different REAL lineage never reaches here (see `planMerge`).
          if (plan.lineage !== clock.lineage()) clock.adopt(plan.lineage)
          for (const batch of plan.batches) {
            log.push(batch)
            revision++
            effects.append(batch)
          }
          return
        case "adopt":
          this.adopt(plan, effects)
          return
      }
    },

    /**
     * Become the document at `adoption.at`: its lineage, its state, and a log
     * that restarts at that position with nothing trimmed below it.
     */
    adopt(adoption: Adoption, effects: PlainEffects): void {
      if (adoption.lineage !== clock.lineage()) clock.adopt(adoption.lineage)
      log.length = 0
      baseOffset = adoption.at
      revision++
      effects.adopt(adoption.state)
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
  // The base incorporates every op trimmed by `advance`. It is always frozen,
  // so a replay onto it copies what it writes and leaves the base as it was.
  const base: StateCell = { current: Object.freeze({}) }

  let cached: { readonly revision: number; readonly state: PlainState } | null =
    null

  /** Replay `batches` onto `cell`, which copies only the frozen nodes the
   *  writes reach. The log owns its payloads: they were decoded on arrival. */
  function replay(cell: StateCell, batches: readonly (readonly Op[])[]): void {
    for (const batch of batches) {
      for (const op of batch) {
        applyChange(cell, op.path, freezePayload(op.change))
      }
    }
  }

  /**
   * Replay the log onto the base, frozen. The replay leaves new, unfrozen
   * nodes wherever it wrote, and a substrate upgraded from this state changes
   * unfrozen nodes in place, so the state is frozen before anyone sees it.
   */
  function materialize(): PlainState {
    const revision = core.revision()
    if (cached !== null && cached.revision === revision) return cached.state
    const cell: StateCell = { current: base.current }
    replay(cell, core.log)
    const state = freezeTree(cell.current)
    cached = { revision, state }
    return state
  }

  const core = createPlainCore(materialize, clock, EMPTY_HISTORY)

  // Appended batches need nothing: the log is the state, replayed on demand.
  // An adopted document becomes the base, frozen in place: it was decoded
  // from a payload, so the replica owns it.
  const baseEffects: PlainEffects = {
    append() {},
    adopt(state) {
      base.current = freezeTree(state)
    },
  }

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
      // `to` may trim only part of the log, so the base takes the trimmed
      // batches rather than the materialized state, and is frozen again.
      core.advance(asPlainVersion(to), batches => {
        replay(base, batches)
        freezeTree(base.current)
      })
    },

    exportEntirety(): SubstratePayload {
      return core.exportEntirety()
    },

    exportSince(since: Version): SubstratePayload | null {
      return core.exportSince(asPlainVersion(since))
    },

    merge(payload: SubstratePayload, _options?: MergeOptions): void {
      core.merge(decodePlainPayload(payload, "PlainReplica.merge"), baseEffects)
    },

    resetFromEntirety(
      payload: SubstratePayload,
      _options?: MergeOptions,
    ): void {
      core.adopt(
        decodeEntirety(payload, "PlainReplica.resetFromEntirety"),
        baseEffects,
      )
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
 * WritableContext. The substrate takes `doc` as its own: a read freezes it in
 * place, and a write may change it or, once frozen, replace it, so read the
 * document through a ref rather than through `doc`.
 *
 * Useful in tests where you don't need the substrate reference:
 *
 * ```ts
 * const ctx = plainContext(schema, doc)
 * const ref = interpret(schema, ctx).with(readable).with(writable).done()
 * ```
 */
export function plainContext(
  schema: SchemaNode,
  doc: PlainState,
): WritableContext {
  return createPlainSubstrate(
    doc,
    schema,
    createPlainClock("test"),
    EMPTY_HISTORY,
    ALWAYS_AUTHOR,
  ).context()
}

// ---------------------------------------------------------------------------
// Payload decomposition — pure helpers shared by replica and substrate
// ---------------------------------------------------------------------------

/**
 * One `replace` op per top-level key in a state object.
 *
 * For a whole-document answer rather than a change: `delta()` in
 * `@kyneta/schema/basic` hands back an entirety this way. A state that
 * replaces another is announced with `diffOps`, which names only what moved.
 */
export function objectToReplaceOps(state: Record<string, unknown>): Op[] {
  const ops: Op[] = []
  for (const [key, value] of Object.entries(state)) {
    ops.push({
      path: RawPath.empty.field(key),
      // Every caller hands over a state it just built or decoded, and keeps
      // no other use of it.
      change: replaceChange(trustAsOwned(value)),
    })
  }
  return ops
}

// ---------------------------------------------------------------------------
// Plain payloads: each says where it belongs in the log
// ---------------------------------------------------------------------------

/** The JSON body of a `"since"` payload: the batches after log position `from`. */
interface SinceBody {
  readonly from: number
  readonly batches: readonly SerializedOp[][]
}

/** The JSON body of an `"entirety"` payload: the document at log position `at`. */
interface EntiretyBody {
  readonly at: number
  readonly state: PlainState
}

/** A document at a log position: what adopting a whole-document payload takes on. */
interface Adoption {
  readonly lineage: string
  readonly at: number
  readonly state: PlainState
}

/**
 * A plain payload, decoded. Positions count flush cycles within `lineage`,
 * the count a `PlainVersion` carries, so a receiver can tell whether the
 * payload continues what it holds.
 */
export type PlainPayload =
  | {
      readonly kind: "since"
      readonly lineage: string
      readonly from: number
      readonly batches: readonly (readonly Op[])[]
    }
  | ({ readonly kind: "entirety" } & Adoption)

/** What merging a plain payload does. Pure; see {@link planMerge}. */
export type MergePlan =
  | { readonly kind: "gap" }
  | { readonly kind: "none" }
  | {
      readonly kind: "append"
      readonly lineage: string
      readonly batches: readonly (readonly Op[])[]
    }
  | ({ readonly kind: "adopt" } & Adoption)

/** How ops taken in reach a replica's state, once the log holds them. */
interface PlainEffects {
  append(batch: readonly Op[]): void
  adopt(state: PlainState): void
}

export function decodePlainPayload(
  payload: SubstratePayload,
  label: string,
): PlainPayload {
  if (payload.encoding !== "json" || typeof payload.data !== "string") {
    throw new Error(
      `${label} expects JSON-encoded payloads. ` +
        "If you recently switched CRDT backends, stale clients may be sending incompatible data.",
    )
  }
  const lineage = payload.lineage ?? DEFAULT_LINEAGE
  if (payload.kind === "entirety") {
    const body = JSON.parse(payload.data) as EntiretyBody
    return { kind: "entirety", lineage, at: body.at, state: body.state }
  }
  const body = JSON.parse(payload.data) as SinceBody
  return {
    kind: "since",
    lineage,
    from: body.from,
    batches: body.batches.map(deserializeOps),
  }
}

function decodeEntirety(payload: SubstratePayload, label: string): Adoption {
  const decoded = decodePlainPayload(payload, label)
  if (decoded.kind !== "entirety") {
    throw new Error(`${label} expects an entirety payload`)
  }
  return decoded
}

/**
 * What merging `payload` into a log at `position` on `lineage` does.
 *
 * - A delta that starts at or before `position` continues what we hold: the
 *   batches we already have are skipped, so a redelivered delta is harmless.
 *   One that starts past `position` does not, and is a gap.
 * - A whole document ahead of `position` is adopted. At or behind it, we
 *   already hold everything it says.
 * - A payload from a different REAL lineage continues nothing we hold. The
 *   Synchronizer crosses a lineage boundary with `resetFromEntirety`, toward
 *   the lineage that supersedes the other, before a merge would see it, so
 *   here it is a gap.
 *
 * A replica at genesis holds nothing, so any lineage continues it.
 */
export function planMerge(
  position: number,
  lineage: string,
  payload: PlainPayload,
): MergePlan {
  const continues =
    lineage === DEFAULT_LINEAGE ||
    payload.lineage === lineage ||
    payload.lineage === DEFAULT_LINEAGE
  if (!continues) return { kind: "gap" }

  if (payload.kind === "entirety") {
    if (payload.at <= position) return { kind: "none" }
    return {
      kind: "adopt",
      lineage: payload.lineage,
      at: payload.at,
      state: payload.state,
    }
  }

  if (payload.from > position) return { kind: "gap" }
  const batches = payload.batches.slice(position - payload.from)
  if (batches.length === 0) return { kind: "none" }
  return { kind: "append", lineage: payload.lineage, batches }
}

/**
 * A substrate over `replica` whose authored writes wait for `adopt` unless
 * `loaded`, and stop for good at `refuse`.
 */
function refusable(
  replica: Replica<PlainVersion>,
  schema: SchemaNode,
  loaded: boolean,
): HydrationHandle<PlainVersion> {
  let adopted = loaded
  let refusal: string | null = null
  return {
    substrate: buildUpgrade(replica, schema, () =>
      refusal !== null ? refusal : adopted ? null : STILL_LOADING,
    ),
    adopt: () => {
      adopted = true
    },
    refuse: reason => {
      refusal = reason
    },
  }
}

// ---------------------------------------------------------------------------
// buildUpgrade — a replica gains a schema, σ and a changefeed
// ---------------------------------------------------------------------------

/**
 * Upgrade a replica built by `createPlainReplica` into a substrate over the
 * same state and history.
 *
 * σ is the completion of the replica's state: every value the schema declares
 * and the state lacks is its zero, applied to the doc without entering the
 * log. Completion is a pure function of the schema and the state, so every
 * peer reconstructs it, and a fresh doc's version stays genesis ⊥.
 */
function buildUpgrade(
  replica: Replica<PlainVersion>,
  schema: SchemaNode,
  authoring: Authoring,
): Substrate<PlainVersion> {
  const history = replicaHistories.get(replica)
  if (history === undefined || !hasBackingDoc<PlainState>(replica)) {
    throw new Error(
      "upgrade() requires a replica produced by this substrate factory.",
    )
  }

  // The replica's state is frozen, so the substrate shares it: a write copies
  // a frozen node before changing it. Completion rebuilds only what it fills.
  const doc = completeValue(schema, replica[BACKING_DOC]) as PlainState
  return createPlainSubstrate(
    doc,
    schema,
    createPlainClock(replica.version().lineage),
    history(),
    authoring,
  )
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
  replicaType: ["plain", 2, 0] as const,
  historyFree: false,

  createEmpty(): Replica<PlainVersion> {
    return createPlainReplica(createPlainClock(DEFAULT_LINEAGE))
  },

  fromEntirety(payload: SubstratePayload): Replica<PlainVersion> {
    // Starts from nothing and becomes the document at the payload's position,
    // so the replica's version is the sender's.
    const replica = this.createEmpty()
    replica.resetFromEntirety(payload)
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
 * - `createForHydration(schema)` — the same, refusing authored writes until
 *   `adopt()` says the document's stored history has loaded, and from
 *   `refuse(reason)` on
 * - `upgradeForHydration(replica, schema)` — `upgrade`, refusable
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
    return buildUpgrade(replica, schema, ALWAYS_AUTHOR)
  },

  create(schema: SchemaNode): Substrate<PlainVersion> {
    return this.upgrade(this.createReplica(), schema)
  },

  createForHydration(schema: SchemaNode) {
    // A plain document's identity is its lineage, and authoring is what mints
    // it. It may author once its history has loaded (`adopt`), unless the
    // right to was withdrawn (`refuse`), which wins either way.
    return refusable(this.createReplica(), schema, false)
  },

  upgradeForHydration(replica: Replica<PlainVersion>, schema: SchemaNode) {
    return refusable(replica, schema, true)
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
