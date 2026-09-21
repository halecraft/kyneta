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
import { deepClonePlain } from "../clone.js"
import { findOpaqueBoundary } from "../fold-path.js"
import type { Path } from "../interpret.js"
import type { WritableContext } from "../interpreters/writable.js"
import { buildWritableContext, executeBatch } from "../interpreters/writable.js"
import { invert } from "../inverse.js"
import {
  decodePlainPosition,
  type PlainPosition,
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
import { DEFAULT_LINEAGE, objectToReplaceOps } from "./plain.js"
import {
  applyChangeToStateTree,
  extractPlainState,
  formatStateTreeViolation,
  insertStructuralZeros,
  isStateTuple,
  mergeStateTree,
  type StateTree,
  stateTreeViolation,
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
 *
 * **This substrate has no peer identity, deliberately.** A scalar timestamp,
 * not a per-peer version vector — and the binding target hands back the shared
 * `ephemeralSubstrateFactory` rather than building one per peer, so the
 * exchange's `peerId` never arrives here. It can afford that because it merges
 * field by field and lets timestamps decide, so it never has to order two
 * writes by their author. Peer identity is the tie-breaker it chose not to
 * need.
 *
 * **If that ever changes, derive the identity from the exchange's stable
 * `peerId` rather than minting one per session.** Transient documents are
 * never persisted, so a fresh identity per restart leaves no residue on disk —
 * but a long-lived peer, a relay or a tab left open for a day, holds these
 * documents in memory across everyone else's reconnects, and a per-session
 * identity would add an entry there on every one. Same unbounded-growth shape
 * the Yjs binding avoids by claiming its `clientID` only after hydration,
 * reached by a different road.
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

  /**
   * The next version, guaranteed to differ from the current one.
   *
   * `Date.now()` has millisecond resolution, and two state changes inside one
   * millisecond are routine for presence traffic, which arrives in bursts. A
   * bare `now()` would hand out the same version twice, making a state change
   * indistinguishable from none to anyone comparing versions — a relay would
   * conclude it had nothing to forward and the document would stop there.
   * Strict monotonicity is what a version owes its readers; the clock is only
   * how this substrate picks a starting point.
   */
  const nextVersion = (): StateVersion =>
    new StateVersion(Math.max(Date.now(), cachedVersion.timestamp + 1))
  // Whether a write has landed since the last batch ended. Not an op log:
  // `exportSince` is always `null` here, so an op would be pushed, counted
  // and dropped without anything ever reading it. What ends a batch needs to
  // know is only whether σ moved.
  let written = false

  return {
    markWritten(): void {
      written = true
    },

    /**
     * End a batch. A write since the last one advances the version clock,
     * just like LWW — unless the batch was a projection, where σ moved but
     * the StateTree math did not, so the network version must stay still.
     */
    endBatch(projection: boolean): void {
      const moved = written
      written = false
      if (moved && !projection) cachedVersion = nextVersion()
    },

    version(): StateVersion {
      return cachedVersion
    },

    baseVersion(): StateVersion {
      return cachedVersion
    },

    advance(to: StateVersion): void {
      // No history to trim — a CvRDT carries its whole meaning in the tree.
      // Only the version moves, so `exportSince` reports the right base.
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
        const { tree, changed } = mergeStateTree(getTree(), incomingTree)
        setTree(tree)

        // Advertise a change only when the join actually moved. Bumping
        // unconditionally makes every peer re-announce every payload it
        // receives, including ones it already had — harmless between two peers,
        // where the sender is excluded from the relay and the cycle closes, and
        // an endless loop among three, where it never does.
        if (changed) cachedVersion = nextVersion()
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
  // Refuse a schema this tree cannot hold, before the shadow below seeds it.
  // `bind()` asks the same question earlier and with a better error site, but
  // it is not on every path: this factory is exported and takes a schema
  // directly. Seeding is itself a write, so an unrepresentable field is
  // already stored wrongly by the time any caller could observe it.
  if (schema !== undefined) {
    const violation = stateTreeViolation(schema)
    if (violation) throw new Error(formatStateTreeViolation(violation))
  }

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

  /**
   * The tree moved without a local write: re-project σ from it and tell
   * subscribers which root fields changed.
   *
   * Both ways that happens — a peer's merge and a decay sweep — need the
   * same two steps, and differ only in the `options` they announce under.
   *
   * The announcement names the fields that actually moved, which
   * `extractPlainState` reports as it writes them. Delivery notifies a changed
   * path's *ancestors*, so one blanket op at the root reaches root subscribers
   * and nobody else — a presence roster's per-entry subscribers would never
   * hear a peer arrive or expire. Naming every field instead would wake
   * subscribers whose subtree nothing touched, which for a roster is most of
   * them, on every tick and every sync.
   *
   * It has to go through the writable context. Notifications are accumulated
   * by `ctx.prepare` and released by `ctx.flush`; advancing the substrate
   * directly reaches neither, which is how a merge came to land its state and
   * tell no one.
   */
  function announceReprojection(now: number, options: BatchOptions): void {
    if (isStateTuple(currentTree)) return

    const changedKeys = extractPlainState(currentTree, shadow, schema, now)
    if (changedKeys.size === 0) return

    const moved: PlainState = {}
    for (const key of changedKeys) moved[key] = shadow[key]

    // A state image of what changed, turned into ops by the same primitive
    // the plain substrate absorbs an entirety payload with.
    executeBatch(substrate.context(), objectToReplaceOps(moved), options)
  }

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
        // Read, don't copy. `invert` snapshots whatever it retains — see
        // `invertReplace`, `invertMap`, `invertSequence` and the rich-text
        // marks in `inverse.ts`, each of which deep-clones the pre-state it
        // captures. Copying here as well protected nothing and cost a deep
        // clone of the written subtree on every local write.
        const pre = path.read(shadow)
        const inverse = invert(pre, change)
        if (inverse) {
          record(path, inverse)
        }
      }

      // We apply the change directly to the shadow PlainState
      applyChange(shadow, path, ownedForStore(change))

      // Then, we apply the change to the StateTree so that ONLY
      // the mutated fields get their timestamps bumped — unless the change
      // did not originate here. A projection (tick/decay) leaves the math
      // untouched and moves only the local shadow. A replay is already in
      // the tree: `merge` runs the lattice join first and then wakes
      // subscribers, and applying its wake-up op here would stamp the whole
      // document with local `Date.now()` and clobber what just merged.
      //
      // Replay can only reach here from `merge`. This substrate is
      // snapshot-only — `exportSince` always returns `null` and `merge`
      // refuses anything but an entirety payload — so no peer's op batch is
      // ever replayed through `prepare`, and `applyChanges` never sets the
      // flag.
      if (!options?.projection && !options?.replay) {
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

      core.markWritten()
    },

    afterBatch(options?: BatchOptions): void {
      core.endBatch(options?.projection === true)
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
      if (payload.kind !== "entirety") {
        throw new Error("StateSubstrate only accepts entirety payloads.")
      }

      core.merge(payload)
      // `replay: true` keeps the Exchange from broadcasting back what it just
      // received. No `projection` — a merge is real state, so the version
      // clock moves with it.
      announceReprojection(Date.now(), {
        origin: options?.origin,
        replay: true,
      })
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
     * Re-projects the shadow, which masks expired presence leaves with their
     * structural zero, and announces whichever fields that moved — see
     * `announceReprojection`, which a peer's merge shares.
     *
     * `projection: true` tells `prepare` to skip `applyChangeToStateTree`
     * and `afterBatch` to skip the version bump; `replay: true` tells the
     * Exchange not to broadcast. The underlying `StateTree` math is never
     * mutated, so the network never sees a synthesized "absent" write that
     * could clobber a slower peer's still-valid value.
     */
    tick(now: number): void {
      // Decay is declared on the schema, so a schemaless substrate has
      // nothing that can expire and need not re-project on every heartbeat.
      if (schema === undefined) return
      announceReprojection(now, { replay: true, projection: true })
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
