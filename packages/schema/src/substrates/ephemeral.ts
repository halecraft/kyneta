// ephemeral — field-level LWW state-based CRDT (CvRDT).
//
// The substrate behind the `ephemeral` binding target: history-free,
// snapshot-only, and merging concurrently at the field level. Rather than one
// timestamp for the whole document, it tracks a `StateTuple` for every scalar
// leaf.
//
// The `State*` vocabulary throughout this file refers to *state-based CRDT* —
// the family that exchanges whole states and joins them — not to any binding
// target. See the header of `state-tree.ts`.
//
// This enables true decentralized presence: multiple peers can write
// to their own keys in a shared document without clobbering each other,
// and without accumulating op-log history.
//
// Because it is snapshot-only (`SYNC_EPHEMERAL`), it has no delta-sync
// log (`exportSince` returns `null`).

import type { ChangeBase } from "../change.js"
import { replaceChange } from "../change.js"
import type { Op } from "../changefeed.js"
import { findOpaqueBoundary } from "../fold-path.js"
import type { Path } from "../interpret.js"
import type { WritableContext } from "../interpreters/writable.js"
import { buildWritableContext } from "../interpreters/writable.js"
import { deepClonePlain, invert } from "../inverse.js"
import { RawPath } from "../path.js"
import {
  decodePlainPosition,
  type PlainPosition,
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
import { DEFAULT_LINEAGE } from "./plain.js"
import {
  applyChangeToStateTree,
  extractPlainState,
  insertStructuralZeros,
  isStateTuple,
  mergeStateTree,
  type StateTree,
} from "./state-tree.js"

// ---------------------------------------------------------------------------
// StateVersion — Concurrent-by-default version for CvRDTs
// ---------------------------------------------------------------------------

/**
 * A Version wrapping a wall-clock timestamp for the `ephemeral` substrate.
 *
 * A CvRDT has no total order to offer. Where `PlainVersion` can say "you are
 * behind me", this can only ever say "we are concurrent" — any payload may
 * carry the newest value for some individual field, so none can be discarded
 * as stale. See `compare` for why that extends even to identical timestamps.
 */
export class StateVersion implements Version {
  readonly timestamp: number

  constructor(timestamp: number) {
    this.timestamp = timestamp
  }

  get lineage(): string {
    return DEFAULT_LINEAGE
  }

  static now(): StateVersion {
    return new StateVersion(Date.now())
  }

  serialize(): string {
    return String(this.timestamp)
  }

  meet(other: Version): StateVersion {
    if (!(other instanceof StateVersion)) {
      throw new Error("StateVersion mismatch")
    }
    return new StateVersion(Math.min(this.timestamp, other.timestamp))
  }

  compare(other: Version): "behind" | "equal" | "ahead" | "concurrent" {
    if (!(other instanceof StateVersion)) {
      throw new Error("StateVersion mismatch")
    }

    // Always "concurrent" — never "equal", even for identical timestamps.
    //
    // The synchronizer skips importing any offer it classifies as "equal", on
    // the assumption that equal versions mean equal state. True of a
    // total-order version; false here. This timestamp records the document's
    // newest *write*, so two peers that wrote to *different fields* in the
    // same millisecond carry the same timestamp over divergent trees. Saying
    // "equal" makes each of them discard the payload that would have
    // reconciled them, and the field-level merge never runs.
    //
    // A wall clock cannot answer "do we hold the same state?", so this does
    // not guess. The cost is that no offer is ever skipped as redundant, which
    // is why this substrate re-merges and re-broadcasts more than it needs to.
    // Answering properly needs a digest of the tree instead of a timestamp;
    // until then merging needlessly is the safe direction, because a merge is
    // idempotent and a skipped merge is not recoverable.
    return "concurrent"
  }

  static parse(serialized: string): StateVersion {
    if (serialized === "") {
      throw new Error("Invalid StateVersion value: (empty string)")
    }
    const n = Number(serialized)
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Invalid StateVersion value: ${serialized}`)
    }
    return new StateVersion(n)
  }
}

// ---------------------------------------------------------------------------
// createStateReplicaCore — headless history-free replication surface
// ---------------------------------------------------------------------------

/**
 * Creates the core replication surface for the ephemeral substrate.
 *
 * This is a pure CvRDT implementation. It maintains a `StateTree` and
 * a cached version, with no op-log.
 */
function createStateReplicaCore(
  getTree: () => StateTree,
  setTree: (tree: StateTree) => void,
) {
  let cachedVersion = new StateVersion(0)
  const pendingOps: Op[] = []

  return {
    pendingOps,

    flush(): void {
      if (pendingOps.length > 0) {
        pendingOps.length = 0
        // Version bumps on every flush, just like LWW.
        cachedVersion = StateVersion.now()
      }
    },

    version(): StateVersion {
      return cachedVersion
    },

    baseVersion(): StateVersion {
      return cachedVersion
    },

    advance(
      to: StateVersion,
      _applyTrimmedOps?: (batches: Op[][]) => void,
    ): void {
      // CvRDT has no log to trim, so advance is functionally a no-op
      // for the data structure, but we must update the version.
      cachedVersion = to
    },

    exportEntirety(): SubstratePayload {
      return {
        kind: "entirety",
        encoding: "json",
        data: JSON.stringify(getTree()),
        lineage: DEFAULT_LINEAGE,
      }
    },

    exportSince(_since: StateVersion): SubstratePayload | null {
      // Snapshot-only — no delta sync.
      return null
    },

    merge(payload: SubstratePayload): void {
      if (payload.encoding !== "json" || typeof payload.data !== "string") {
        throw new Error("StateReplica expects JSON-encoded StateTree payloads.")
      }

      if (payload.kind === "entirety") {
        const incomingTree = JSON.parse(payload.data) as StateTree
        const merged = mergeStateTree(getTree(), incomingTree)
        setTree(merged)

        // After merging, bump the version so this peer advertises a state
        // change (merges can cause changes that need to be re-broadcast).
        cachedVersion = StateVersion.now()
      }
    },

    resetFromEntirety(
      payload: SubstratePayload,
      _remoteVersion: Version,
    ): void {
      // This substrate carries a single constant lineage (DEFAULT_LINEAGE) for
      // its entire lifetime, so a true lineage boundary never arises here —
      // `classifyResetTrigger` in the Synchronizer excludes it on both counts.
      // Kept to satisfy the `ReplicaLike` contract. If it were ever invoked,
      // field-level merge is the safe behaviour: discarding local state would
      // lose concurrent field writes the peer has not seen.
      this.merge(payload)
    },
  }
}

// ---------------------------------------------------------------------------
// createStateSubstrate
// ---------------------------------------------------------------------------

export function createStateSubstrate(
  tree: StateTree,
  schema?: SchemaNode,
): Substrate<StateVersion> {
  let currentTree = tree
  const core = createStateReplicaCore(
    () => currentTree,
    t => {
      currentTree = t
    },
  )

  // The PlainState shadow that the reader consumes.
  // Updated on every prepare (locally) and afterBatch (from merges).
  const shadow: PlainState = {}
  if (!isStateTuple(currentTree)) {
    extractPlainState(currentTree, shadow, schema, Date.now())
  }
  const reader = plainReader(shadow)

  let cachedCtx: WritableContext | undefined

  const substrate = {
    get [BACKING_DOC]() {
      return currentTree
    },

    reader,

    prepare(path: Path, change: ChangeBase, options?: BatchOptions): void {
      // Inverse recording (same as plain)
      const record = (
        options as
          | (BatchOptions & { [RECORD_INVERSE]?: RecordInverseFn })
          | undefined
      )?.[RECORD_INVERSE]
      if (record && !options?.compensating && !options?.replay) {
        const pre = deepClonePlain(path.read(shadow))
        const inverse = invert(pre, change)
        if (inverse) {
          record(path, inverse)
        }
      }

      // We apply the change directly to the shadow PlainState
      applyChange(shadow, path, change)

      // Then, we apply the change to the StateTree so that ONLY
      // the mutated fields get their timestamps bumped — UNLESS this
      // is a projection (tick/decay), in which case the math stays
      // untouched and only the local shadow moves.
      if (!options?.projection) {
        // A register — a sum variant or a `.json()` blob — lives in the tree as
        // ONE leaf tuple, so that concurrent edits to it settle
        // as a single unit. A change aimed at or inside one has nowhere to go:
        // applying it literally would split that tuple into per-field tuples,
        // throwing away every sibling field the change never mentioned and
        // handing the schema-blind `mergeStateTree` something it can blend
        // across two peers' variants. So re-aim the change at the register
        // itself and store the whole post-change value, which the shadow is
        // already holding — the `applyChange` call above just put it there.
        //
        // Yjs and Loro do the same thing at the same point, asking the same
        // function where the boundary is. For them it decides what lands in a
        // CRDT container; here it decides what lands in a tuple. Sharing the
        // oracle is the point: "which subtrees are indivisible" is a property
        // of the schema and should have one answer, not one per substrate.
        //
        // Re-aiming also normalizes the change into a `replace`, which is the
        // only kind `applyChangeToStateTree` handles well. That incidentally
        // makes register-shaped `map` and `sequence` changes work. Bare
        // containers get no such help and remain broken independently of this.
        //
        // Watch out when testing this: `prepare` also updates the shadow above,
        // and local reads come from the shadow. Get this branch wrong and reads
        // on this peer still look perfect — only what replicates is damaged.
        //
        // With no schema there are no registers to find, so a schemaless
        // substrate keeps the old decompose-everything behaviour.
        const boundary = schema ? findOpaqueBoundary(schema, path) : null
        if (boundary !== null) {
          const registerPath = path.slice(0, boundary.prefixLength + 1)
          applyChangeToStateTree(
            currentTree,
            registerPath,
            replaceChange(deepClonePlain(registerPath.read(shadow))),
            Date.now(),
            schema,
          )
        } else {
          applyChangeToStateTree(currentTree, path, change, Date.now(), schema)
        }
      }

      // Record op for changefeed delivery. Freeze to an immutable RawPath
      // at authoring time so the log never aliases the live addressing
      // registry (uniform with the plain substrate; defense-in-depth even
      // though this substrate exports entirety, not serialized ops). Context: jj:mlurlzqt.
      core.pendingOps.push({ path: path.toRaw(), change })
    },

    afterBatch(options?: BatchOptions): Op[][] {
      // Re-extract the shadow from the tree just in case the tree was mutated
      // out of band (e.g. by `merge()` calling `setTree()`).
      if (
        options?.replay &&
        !options?.projection &&
        !isStateTuple(currentTree)
      ) {
        extractPlainState(currentTree, shadow, schema, Date.now())
      }

      const flushed = [...core.pendingOps]
      // Projections (tick/decay) never bump the version — the StateTree
      // math is untouched, so the network version must stay still.
      if (!options?.projection) {
        core.flush()
      } else {
        // Just drain pendingOps without bumping the version.
        core.pendingOps.length = 0
      }
      return flushed.length > 0 ? [flushed] : []
    },

    writable(): PositionCapable {
      return {
        createPosition(_index: number, _side: Side): PlainPosition {
          throw new Error("state substrate does not support ordered sequences")
        },
        decodePosition(bytes: Uint8Array): PlainPosition {
          return decodePlainPosition(bytes)
        },
      }
    },

    context(): WritableContext {
      if (!cachedCtx) {
        cachedCtx = buildWritableContext(substrate, {
          nativeResolver: (
            _schema: unknown,
            path: { segments: readonly unknown[] },
          ) => {
            return path.segments.length === 0 ? shadow : undefined
          },
        })
        Object.defineProperty(cachedCtx, BACKING_DOC, {
          get() {
            return currentTree
          },
          enumerable: false,
        })
      }
      return cachedCtx
    },

    version(): StateVersion {
      return core.version()
    },

    baseVersion(): StateVersion {
      return core.baseVersion()
    },

    advance(to: StateVersion): void {
      core.advance(to)
    },

    exportEntirety(): SubstratePayload {
      return core.exportEntirety()
    },

    exportSince(since: StateVersion): SubstratePayload | null {
      return core.exportSince(since)
    },

    merge(payload: SubstratePayload, options?: BatchOptions): void {
      const replayOptions: BatchOptions = {
        origin: options?.origin,
        replay: true,
      }

      if (payload.kind === "entirety") {
        core.merge(payload)
        // Fire a blanket root replace event so subscribers update.
        // Replay flag ensures the changefeed doesn't rebroadcast.
        core.pendingOps.push({
          path: RawPath.empty,
          change: replaceChange(shadow), // the content doesn't matter, it's just a trigger
        })
        substrate.afterBatch(replayOptions)
      } else {
        throw new Error("StateSubstrate only accepts entirety payloads.")
      }
    },

    resetFromEntirety(
      payload: SubstratePayload,
      _remoteVersion: Version,
      options?: BatchOptions,
    ): void {
      // This substrate is a CvRDT with a single constant lineage for its entire
      // lifetime — a true lineage boundary never arises here. Field-level
      // LWW merge is the correct and safe fallback: discarding local
      // history would lose concurrent field writes the peer doesn't yet
      // have (the same reasoning the Synchronizer applies to fall through
      // to `merge()` in replicate mode).
      substrate.merge(payload, options)
    },

    /**
     * Heartbeat hook driven by the `Runtime` clock (see `tickInterval`).
     *
     * Re-projects the shadow with the upgraded schema-aware
     * `extractPlainState`, which masks expired presence leaves with their
     * structural zero. If any field transitioned to decayed, we route the
     * updated shadow through the writable context's batch machinery as a
     * `projection` prepare — this fires the changefeed so local
     * subscribers (React components, etc.) refresh, while `replay: true`
     * prevents the Exchange from broadcasting to peers.
     *
     * The `projection` flag tells `prepare` to skip
     * `applyChangeToStateTree` and `afterBatch` to skip the version bump.
     * The underlying `StateTree` math is never mutated, so the network
     * never sees a synthesized "absent" write that could clobber a slower
     * peer's still-valid value.
     */
    tick(now: number): void {
      if (schema === undefined || isStateTuple(currentTree)) return
      if (!cachedCtx) return // No writable context — bare substrate, no subscribers

      // Snapshot the shadow before re-projection so we can detect changes.
      const anyDecayed = extractPlainState(currentTree, shadow, schema, now)
      if (!anyDecayed) return

      // Route through the writable context's batch machinery so the
      // changefeed fires for local subscribers. `projection: true` keeps
      // the StateTree math and version clock untouched; `replay: true`
      // tells the Exchange not to broadcast.
      const ctx = cachedCtx
      ctx.runBatch(
        () => {
          ctx.prepare(RawPath.empty, replaceChange(shadow), {
            replay: true,
            projection: true,
          })
        },
        { replay: true, projection: true },
      )
    },
  }

  return substrate
}

// ---------------------------------------------------------------------------
// createStateReplica — headless
// ---------------------------------------------------------------------------

export function createStateReplica(): Replica<StateVersion> {
  let tree: StateTree = {}
  const core = createStateReplicaCore(
    () => tree,
    t => {
      tree = t
    },
  )

  const replica = {
    version: core.version,
    baseVersion: core.baseVersion,
    advance: core.advance,
    exportEntirety: core.exportEntirety,
    exportSince: core.exportSince,
    merge(payload: SubstratePayload) {
      core.merge(payload)
      core.flush()
    },
    resetFromEntirety(payload: SubstratePayload, _remoteVersion: Version) {
      // See createStateSubstrate's resetFromEntirety — same rationale:
      // this substrate has no true lineage boundary, so field-level merge is
      // the correct fallback.
      replica.merge(payload)
    },
  }
  return replica
}

// ---------------------------------------------------------------------------
// ephemeralSubstrateFactory
// ---------------------------------------------------------------------------

export const ephemeralReplicaFactory: ReplicaFactory<StateVersion> = {
  replicaType: ["ephemeral", 1, 0] as const,

  createEmpty(): Replica<StateVersion> {
    return createStateReplica()
  },

  fromEntirety(payload: SubstratePayload): Replica<StateVersion> {
    if (payload.encoding !== "json" || typeof payload.data !== "string") {
      throw new Error(
        "StateReplicaFactory.fromEntirety only supports JSON-encoded payloads",
      )
    }
    const replica = createStateReplica()
    replica.merge(payload)
    return replica
  },

  parseVersion(serialized: string): StateVersion {
    return StateVersion.parse(serialized)
  },
}

export const ephemeralSubstrateFactory: SubstrateFactory<StateVersion> = {
  replica: ephemeralReplicaFactory,

  createReplica(): Replica<StateVersion> {
    return createStateReplica()
  },

  upgrade(
    replica: Replica<StateVersion>,
    schema: SchemaNode,
  ): Substrate<StateVersion> {
    // 1. Get the existing StateTree from the replica.
    // The headless replica stores its tree in closure, but we can't easily extract it
    // without a symbol. Let's rely on exportEntirety for extraction.
    const entirety = replica.exportEntirety()
    const tree = JSON.parse(entirety.data as string) as StateTree

    // 2. Compute structural zeros, filter to missing keys
    const defaults = Zero.structural(schema) as Record<string, unknown>

    // We will do a recursive walk to insert structural zeros tagged with T=0.
    insertStructuralZeros(tree, defaults, schema)

    // 3. Create the substrate with the upgraded tree AND schema.
    // The schema is needed for `tick()` to know which fields have `decayMs`.
    const substrate = createStateSubstrate(tree, schema)

    return substrate
  },

  create(schema: SchemaNode): Substrate<StateVersion> {
    return this.upgrade(this.createReplica(), schema)
  },

  fromEntirety(
    payload: SubstratePayload,
    schema: SchemaNode,
  ): Substrate<StateVersion> {
    const replica = this.replica.fromEntirety(payload)
    return this.upgrade(replica, schema)
  },

  parseVersion(serialized: string): StateVersion {
    return StateVersion.parse(serialized)
  },
}
