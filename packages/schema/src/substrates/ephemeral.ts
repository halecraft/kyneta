// ephemeral — field-level LWW state-based CRDT (CvRDT).
//
// The substrate behind the `ephemeral` binding target: history-free, and
// merging concurrently at the field level. Rather than one timestamp for the
// whole document, it keeps a timestamped `Live` tuple for every scalar leaf,
// and a `Horizon` for every key deleted or written whole.
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
import { own, replaceChange } from "../change.js"
import { deepClonePlain } from "../clone.js"
import { findOpaqueBoundary } from "../fold-path.js"
import { digestToHex } from "../hash.js"
import type { Path } from "../interpret.js"
import type { WritableContext } from "../interpreters/writable.js"
import { buildWritableContext } from "../interpreters/writable.js"
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
  MergeOptions,
  RecordInverseFn,
  Replica,
  ReplicaFactory,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
  Version,
} from "../substrate.js"
import { BACKING_DOC } from "../substrate.js"
import { createLocalUpdateSignal } from "./local-update-signal.js"
import { DEFAULT_LINEAGE, movedRootKeys, objectToReplaceOps } from "./plain.js"
import {
  applyChangeToStateTree,
  type Container,
  decodeTree,
  encodeTree,
  formatStateTreeViolation,
  installedAfter,
  mergeStateTree,
  projectStateTree,
  stateTreeDigest,
  stateTreeViolation,
  type WriteStamp,
} from "./state-tree.js"

// ---------------------------------------------------------------------------
// StateVersion — Concurrent-by-default version for CvRDTs
// ---------------------------------------------------------------------------

/**
 * The `ephemeral` substrate's version: which replica instance is counting, and
 * how much it has installed.
 *
 * A CvRDT has no total order to offer. Where `PlainVersion` can say "you are
 * behind me", this can only ever say "we are concurrent" — any payload may
 * carry the newest value for some individual field, so none can be discarded
 * as stale. See `compare`.
 *
 * **This substrate has no peer identity, deliberately.** One install counter,
 * not a per-peer version vector — and the binding target hands back the shared
 * `ephemeralSubstrateFactory` rather than building one per peer, so the
 * exchange's `peerId` never arrives here. It can afford that because it merges
 * field by field and lets timestamps decide, so it never has to order two
 * writes by their author. One writer's own writes are ordered anyway, by
 * construction: each is stamped past what it replaces. Peer identity is the
 * tie-breaker it chose not to need.
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

  /**
   * Within one incarnation the counters order, so the join is the larger.
   * Counters from two incarnations measure different replicas' intake and
   * have no join; nothing asks for one, since a history-free document's
   * versions are never joined across replicas.
   */
  join(other: Version): StateVersion {
    if (!(other instanceof StateVersion)) {
      throw new Error("StateVersion mismatch")
    }
    if (other.incarnation !== this.incarnation) {
      throw new Error(
        "StateVersion: counters from two incarnations have no join",
      )
    }
    return new StateVersion(
      this.incarnation,
      Math.max(this.installSeq, other.installSeq),
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
  getTree: () => Container,
  setTree: (tree: Container) => void,
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
    /**
     * Open the next install ordinal for a local write, stamped no earlier
     * than the wall clock the caller read.
     */
    nextStamp(notBefore: number): WriteStamp {
      installSeq += 1
      return { notBefore, installedAt: installSeq }
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
      const delta = installedAfter(getTree(), since.installSeq)
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

    resetFromEntirety(payload: SubstratePayload): void {
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
  tree: Container,
  schema: SchemaNode,
): Substrate<StateVersion> {
  // Refuse a schema this tree cannot hold. `bind()` asks the same question
  // with a better error site, but `ephemeralSubstrateFactory` can be called
  // without it, and the first write to an unrepresentable field would store it
  // in a shape the schema never declared.
  const violation = stateTreeViolation(schema)
  if (violation) throw new Error(formatStateTreeViolation(violation))

  let currentTree = tree
  const core = createStateReplicaCore(
    () => currentTree,
    t => {
      currentTree = t
    },
  )

  // The PlainState shadow that the reader consumes. `prepare` writes it for
  // local writes; `announceReprojection` writes it for merges and decay.
  //
  // A copy, because a projection shares register values with the tree.
  const shadow: PlainState = deepClonePlain(
    projectStateTree(currentTree, schema, Date.now()),
  )
  const reader = plainReader(shadow)

  let cachedCtx: WritableContext | undefined

  // Whether the authored batch in progress wrote the tree. Compensations
  // write it too, so an aborted batch counts. Merges and decay ticks never
  // reach `prepare` or `afterBatch`.
  let wrote = false
  const localUpdates = createLocalUpdateSignal()

  /**
   * The tree moved without a local write: re-project σ from it and tell
   * subscribers which root fields changed.
   *
   * Both ways that happens — a peer's merge and a decay sweep — need the
   * same two steps, and differ only in the `origin` they announce under.
   *
   * The announcement names the root fields that actually moved. Delivery
   * notifies a changed path's *ancestors*, so one blanket op at the root
   * reaches root subscribers
   * and nobody else — a presence roster's per-entry subscribers would never
   * hear a peer arrive or expire. Naming every field instead would wake
   * subscribers whose subtree nothing touched, which for a roster is most of
   * them, on every tick and every sync.
   *
   * σ is written here, before announcing: an announcement never reaches
   * `prepare`. The announcement still has to go through the writable
   * context, which seals the moved ops as one batch and delivers it.
   */
  function announceReprojection(now: number, origin?: string): void {
    const next = projectStateTree(currentTree, schema, now)
    const moved: PlainState = {}
    // Each moved value is copied twice: once into σ, once into the op that
    // subscribers receive. The projection shares register values with the
    // tree, and σ and the op must not share them with each other.
    for (const key of movedRootKeys(shadow, next)) {
      moved[key] = deepClonePlain(next[key])
      shadow[key] = deepClonePlain(next[key])
    }
    // A state image of what changed, turned into ops by the same primitive
    // the plain substrate absorbs an entirety payload with.
    substrate.context().announce(objectToReplaceOps(moved), {
      origin,
      local: false,
    })
  }

  const substrate = {
    get [BACKING_DOC]() {
      return currentTree
    },

    reader,

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
        recordInverse(path, invert(path.read(shadow), change))
      }

      // We apply the change directly to the shadow PlainState
      applyChange(shadow, path, ownedForStore(change))

      // Then, we apply the change to the StateTree so that ONLY the mutated
      // fields get their timestamps bumped. Merges and decay never reach
      // here: they move the tree (or nothing) and σ themselves, then announce.
      //
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
      // Re-aiming also normalizes the change into a `replace`, which is what
      // makes register-shaped `map` and `sequence` changes work: the tree
      // has no container to apply them to inside a register.
      //
      // Watch out when testing this: `prepare` also updates the shadow above,
      // and local reads come from the shadow. Get the re-aim wrong and reads
      // on this peer still look perfect — only what replicates is damaged.
      wrote = true
      const boundary = findOpaqueBoundary(schema, path)
      const registerPath =
        boundary === null ? null : path.slice(0, boundary.prefixLength + 1)
      applyChangeToStateTree(
        currentTree,
        registerPath ?? path,
        registerPath === null
          ? change
          : replaceChange(own(registerPath.read(shadow))),
        core.nextStamp(Date.now()),
        schema,
      )
    },

    afterBatch(): void {
      // The install counter advances as each leaf lands, so a batch has no
      // bookkeeping left to reconcile when it ends. What remains is to say
      // whether it wrote anything.
      if (!wrote) return
      wrote = false
      localUpdates.notify()
    },

    subscribeLocalUpdates: localUpdates.subscribe,

    // Only Kyneta writes here, and a batch commits when it ends.
    commitPending(): void {},

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

    merge(payload: SubstratePayload, options?: MergeOptions): void {
      // Both kinds join the same way. A delta is a partial tree and the merge
      // unions keys, so a key it omits is one it makes no claim about — the
      // same rule that makes an entirety safe to join rather than adopt.
      core.merge(payload)
      announceReprojection(Date.now(), options?.origin)
    },

    resetFromEntirety(payload: SubstratePayload, options?: MergeOptions): void {
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
     * Only σ moves. The `StateTree` is never mutated and the version stays
     * put, so the network never sees a synthesized "absent" write that could
     * clobber a slower peer's still-valid value.
     */
    tick(now: number): void {
      announceReprojection(now)
    },
  }

  return substrate
}

// ---------------------------------------------------------------------------
// createStateReplica — headless
// ---------------------------------------------------------------------------

export function createStateReplica(): Replica<StateVersion> {
  let tree: Container = {}
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
    merge(payload: SubstratePayload): void {
      core.merge(payload)
    },
    resetFromEntirety(payload: SubstratePayload) {
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
  historyFree: true,

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
    // The headless replica keeps its tree in a closure, so the tree is read
    // back out through its entirety, and through `decodeTree` like any other
    // payload. The wire shape is not the in-memory one: on the wire a
    // deletion's marker sits where the install ordinal lives in memory, so
    // reading it as-is turns every deletion into a live `null`.
    //
    // Adopted nodes keep install ordinal 0: this incarnation's counter never
    // took them in, and no peer holds a cursor into an incarnation minted now.
    return createStateSubstrate(
      decodeTree(replica.exportEntirety().data as string),
      schema,
    )
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
