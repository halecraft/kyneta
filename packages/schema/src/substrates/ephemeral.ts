// ephemeral — field-level LWW state-based CRDT (CvRDT).
//
// The substrate behind the `ephemeral` binding target: history-free, and
// merging concurrently at the field level. Rather than one timestamp for the
// whole document, it tracks a `StateTuple` for every scalar leaf.
//
// History-free does not mean snapshot-only. There is no op log to replay, but
// each leaf records the local ordinal it was installed at, so `exportSince`
// answers "what have I taken in since?" by scanning rather than by reading a
// log — which is why no cursor is ever too old to serve.
//
// The `State*` vocabulary throughout this file refers to *state-based CRDT* —
// the family that exchanges whole states and joins them — not to any binding
// target. See the header of `state-tree.ts`.
//
// This enables true decentralized presence: multiple peers can write
// to their own keys in a shared document without clobbering each other,
// and without accumulating op-log history.

import type { ChangeBase } from "../change.js"
import { replaceChange } from "../change.js"
import { deepClonePlain } from "../clone.js"
import { findOpaqueBoundary } from "../fold-path.js"
import { digestToHex } from "../hash.js"
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
  decodeTree,
  encodeTree,
  extractPlainState,
  formatStateTreeViolation,
  insertStructuralZeros,
  isStateTuple,
  leavesInstalledAfter,
  mergeStateTree,
  type StateTree,
  stateTreeDigest,
  stateTreeViolation,
  type WriteStamp,
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
  /**
   * Which replica instance minted this, and how much it had installed.
   *
   * The pair is structurally what `PlainVersion` is — a lineage and a counter
   * — so this substrate stops being an exception to the version-vector family
   * it belongs to. An install ordinal is strictly monotone by construction,
   * which a wall clock is not: `Date.now()` has millisecond resolution and
   * presence traffic arrives in bursts, so two changes in one tick used to
   * share a version and a real change read as none.
   */
  readonly incarnation: string
  readonly installSeq: number

  constructor(incarnation: string, installSeq: number) {
    this.incarnation = incarnation
    this.installSeq = installSeq
  }

  /**
   * Deliberately `DEFAULT_LINEAGE`, never the incarnation.
   *
   * `classifyResetTrigger` treats two differing non-default lineages as a
   * lineage boundary, which discards the payload and re-requests an entirety.
   * Every replica instance mints a distinct incarnation, so surfacing it here would
   * make *every pair of peers* a boundary and delta sync would silently never
   * happen. The incarnation identifies whose counter this is; it is not a claim
   * about the document's history.
   */
  get lineage(): string {
    return DEFAULT_LINEAGE
  }

  serialize(): string {
    return `${this.incarnation}:${this.installSeq}`
  }

  /**
   * Two incarnations are incomparable, so the meet of versions from different
   * replicas is the bottom of this replica's own lineage: nothing is known to
   * be common. Within one incarnation the counters order, so the meet is the lower.
   */
  meet(other: Version): StateVersion {
    if (!(other instanceof StateVersion)) {
      throw new Error("StateVersion mismatch")
    }
    if (other.incarnation !== this.incarnation)
      return new StateVersion(this.incarnation, 0)
    return new StateVersion(
      this.incarnation,
      Math.min(this.installSeq, other.installSeq),
    )
  }

  compare(other: Version): "behind" | "equal" | "ahead" | "concurrent" {
    if (!(other instanceof StateVersion)) {
      throw new Error("StateVersion mismatch")
    }

    // Always "concurrent" — a version cannot answer this question here.
    //
    // An install counter says how much *this* replica has taken in, which is
    // a fact about us and meaningless to anyone else: two peers holding
    // identical trees reached them by different routes and hold different
    // counts. So there is no ordering between incarnations to report, and within an
    // incarnation a higher count does not imply the lower one is behind — it may
    // have installed different leaves.
    //
    // Equality is answered by `stateTreeDigest` instead, carried beside the
    // version on the wire, and the synchronizer's classifier reads it. The
    // counter's job is narrower and different: it says what to *send*, not who
    // is ahead.
    return "concurrent"
  }

  static parse(serialized: string): StateVersion {
    const separator = serialized.lastIndexOf(":")
    if (separator <= 0) {
      throw new Error(`Invalid StateVersion value: ${serialized}`)
    }
    const incarnation = serialized.slice(0, separator)
    const n = Number(serialized.slice(separator + 1))
    if (!Number.isInteger(n) || n < 0) {
      throw new Error(`Invalid StateVersion value: ${serialized}`)
    }
    return new StateVersion(incarnation, n)
  }
}

// ---------------------------------------------------------------------------
// createStateReplicaCore — headless history-free replication surface
// ---------------------------------------------------------------------------

/**
 * A fresh identity for one replica instance's install counter.
 *
 * Called an *incarnation* rather than an epoch: this package reserves "epoch"
 * for the declared T3 migration boundary (`.epoch()` / `EpochStep`), which is
 * a global generation a developer chooses. This is neither global nor chosen.
 *
 * Only distinctness matters: it is compared for identity, never for order, and
 * a peer that sees an unfamiliar one simply asks for an entirety. It is not a
 * peer identity — see `StateVersion` for why this substrate declines to have
 * one — and it never persists, because the documents do not either.
 */
let incarnationCounter = 0
function newIncarnation(): string {
  incarnationCounter += 1
  return `e${incarnationCounter}-${Math.random().toString(36).slice(2, 10)}`
}

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
  // Identifies whose install counter this is. Minted per replica instance
  // because the counter means nothing across a restart: a fresh replica
  // starts at zero, and a peer still holding a cursor from the previous life
  // would ask for leaves above a number that now refers to different state.
  // A mismatched incarnation makes `exportSince` decline, and the caller falls back
  // to an entirety.
  const incarnation = newIncarnation()

  // How much this replica has installed. Advanced by every leaf it takes in,
  // from a local write or from a merge, and never by anything else — so
  // "the counter moved" and "our state changed" are the same fact, and
  // `exportSince` can answer "what have I taken in since?" by reading it.
  let installSeq = 0

  return {
    /** Open the next install ordinal, for one write or one merge. */
    nextStamp(timestamp: number): WriteStamp {
      installSeq += 1
      return { timestamp, installedAt: installSeq }
    },

    version(): StateVersion {
      return new StateVersion(incarnation, installSeq)
    },

    baseVersion(): StateVersion {
      // Always the bottom of this incarnation: nothing is ever trimmed, so every
      // cursor within the incarnation remains serviceable however old it is.
      return new StateVersion(incarnation, 0)
    },

    advance(_to: StateVersion): void {
      // Nothing to trim. A CvRDT carries its whole meaning in the tree, and
      // the install counter is not history — it is a position in our own
      // intake that only ever moves forward, on its own.
    },

    /**
     * The tree's fingerprint, for peers to compare against their own.
     *
     * This is what `compare` cannot do: an install counter describes our
     * intake, not the state, so two peers holding identical trees report
     * different counts. The digest is a function of the tree alone — not of
     * the order it arrived in, and not of anything local — so peers that
     * converged by opposite routes agree and stop exchanging.
     */
    digest(): string {
      return digestToHex(stateTreeDigest(getTree()))
    },

    exportEntirety(): SubstratePayload {
      return {
        kind: "entirety",
        encoding: "json",
        data: encodeTree(getTree()),
        lineage: DEFAULT_LINEAGE,
      }
    },

    /**
     * The leaves taken in since `since`, as a partial tree.
     *
     * Any cursor within our incarnation is serviceable, however old: nothing is
     * discarded, so this is a scan rather than a lookup into a log that might
     * have been trimmed. Staleness repairs itself too — a leaf overwritten
     * while a peer was behind is returned at its *current* value, which is the
     * only one that peer needs.
     *
     * `null` means **cannot serve**, not **nothing to send** — the caller
     * answers it with a whole document. Only a cursor from another incarnation earns
     * that; a cursor that is simply current earns an empty delta, which is the
     * quiet round. Conflating the two turns every agreement into a full
     * resend, which is the cost this substrate exists to avoid.
     */
    exportSince(since: StateVersion): SubstratePayload | null {
      if (since.incarnation !== incarnation) return null
      const delta = leavesInstalledAfter(getTree(), since.installSeq)
      return {
        kind: "since",
        encoding: "json",
        data: encodeTree(delta),
        lineage: DEFAULT_LINEAGE,
      }
    },

    merge(payload: SubstratePayload): void {
      if (payload.encoding !== "json" || typeof payload.data !== "string") {
        throw new Error("StateReplica expects JSON-encoded StateTree payloads.")
      }

      // Both kinds join identically. A delta is a partial tree, and the merge
      // unions keys, so a key it omits is a key it says nothing about — which
      // is exactly the "absence carries no information" rule the whole
      // substrate rests on. Handling only `"entirety"` would drop deltas in
      // silence.
      const incomingTree = decodeTree(payload.data)
      installSeq += 1
      const { tree, changed } = mergeStateTree(
        getTree(),
        incomingTree,
        installSeq,
      )
      setTree(tree)

      // The counter advanced speculatively, to have an ordinal ready for
      // whatever the join adopts. Nothing adopted it if nothing moved, so
      // give it back: a merge that changed nothing must leave no trace, or
      // every peer re-announces every payload it receives — harmless between
      // two peers, where the sender is excluded from the relay and the cycle
      // closes, and an endless loop among three, where it never does.
      if (!changed) installSeq -= 1
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
      // Replay can only reach here from `merge`, which joins whole trees
      // rather than replaying ops: this substrate has no op log, so no peer's
      // batch is ever replayed through `prepare` and `applyChanges` never sets
      // the flag.
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
            core.nextStamp(Date.now()),
            schema,
          )
        } else {
          applyChangeToStateTree(
            currentTree,
            path,
            change,
            core.nextStamp(Date.now()),
            schema,
          )
        }
      }
    },

    afterBatch(): void {
      // Nothing to settle. The install counter advances as each leaf lands, so
      // a batch has no bookkeeping left to reconcile when it ends — and a
      // projection never reaches the tree at all, so it cannot have moved it.
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

    digest(): string {
      return core.digest()
    },

    exportEntirety(): SubstratePayload {
      return core.exportEntirety()
    },

    exportSince(since: StateVersion): SubstratePayload | null {
      return core.exportSince(since)
    },

    merge(payload: SubstratePayload, options?: BatchOptions): void {
      // Both kinds join the same way. A delta is a partial tree and the merge
      // unions keys, so a key it omits is one it makes no claim about — the
      // same rule that makes an entirety safe to join rather than adopt.
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
