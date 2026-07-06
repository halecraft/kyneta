// state — field-level LWW State-based CRDT (CvRDT).
//
// The state substrate is a history-free, snapshot-only CRDT that merges
// concurrently at the field level. Unlike the plain/LWW substrate which
// tracks a single timestamp for the entire document, this tracks a
// `[Value, Timestamp]` tuple for every scalar leaf.
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
import type { Path } from "../interpret.js"
import type { WritableContext } from "../interpreters/writable.js"
import { buildWritableContext } from "../interpreters/writable.js"
import { deepClonePreState, invert } from "../inverse.js"
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
import { DEFAULT_EPOCH } from "./plain.js"
import {
  extractPlainState,
  isStateTuple,
  mergeStateTree,
  type StateTree,
} from "./state-tree.js"

// ---------------------------------------------------------------------------
// StateVersion — Concurrent-by-default version for CvRDTs
// ---------------------------------------------------------------------------

/**
 * A Version wrapping a wall-clock timestamp for the `state` substrate.
 *
 * Unlike `StateVersion` which forms a total order, a CvRDT's global
 * version must always return `"concurrent"` if timestamps differ, so the
 * Exchange synchronizer doesn't aggressively discard payloads that might
 * contain newer data for specific fields.
 */
export class StateVersion implements Version {
  readonly timestamp: number

  constructor(timestamp: number) {
    this.timestamp = timestamp
  }

  get epoch(): string {
    return DEFAULT_EPOCH
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
    if (this.timestamp === other.timestamp) return "equal"
    return "concurrent" // ALWAYS concurrent if not perfectly equal!
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
 * Creates the core replication surface for a state substrate.
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
        epoch: DEFAULT_EPOCH,
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
      // `state` is a CvRDT with a single constant epoch (DEFAULT_EPOCH) for
      // its entire lifetime — a true epoch boundary never arises here. If
      // this is ever invoked (e.g. via the legacy entirety-after-sync
      // fallback), field-level LWW merge is the correct and safe behavior:
      // discarding local history would lose concurrent field writes that
      // the peer doesn't yet have, exactly like the replicate-mode
      // fallback for `state` in the Synchronizer.
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
        const pre = deepClonePreState(path.read(shadow))
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
        applyChangeToStateTree(currentTree, path, change, Date.now())
      }

      // Record op for changefeed delivery
      core.pendingOps.push({ path, change })
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
      // `state` is a CvRDT with a single constant epoch for its entire
      // lifetime — a true epoch boundary never arises here. Field-level
      // LWW merge is the correct and safe fallback: discarding local
      // history would lose concurrent field writes the peer doesn't yet
      // have (the same reasoning the Synchronizer applies to fall through
      // to `merge()` for `state` in replicate mode).
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
// applyChangeToStateTree
// ---------------------------------------------------------------------------

/**
 * Applies a change directly to the StateTree, stamping mutated scalar leaves
 * with the given timestamp.
 */
function applyChangeToStateTree(
  tree: StateTree,
  path: Path,
  change: ChangeBase,
  timestamp: number,
): void {
  if (path.length === 0) {
    if (change.type === "replace") {
      const val = (change as any).value
      if (typeof val === "object" && val !== null && !Array.isArray(val)) {
        // Deep replace: we must recursively stamp all leaves
        const newTree: Record<string, StateTree> = {}
        syncStateTreeToShadow(newTree, val, timestamp)
        // Clear the existing root and merge the new one
        const target = tree as Record<string, StateTree>
        for (const k of Object.keys(target)) delete target[k]
        for (const k of Object.keys(newTree)) target[k] = newTree[k]
      } else {
        throw new Error("Cannot replace root with a scalar")
      }
    } else if (change.type === "map") {
      const target = tree as Record<string, StateTree>
      const mapChange = change as any
      for (const [key, instruction] of Object.entries(mapChange.entries)) {
        if ((instruction as any).type === "delete") {
          delete target[key]
        } else if ((instruction as any).type === "set") {
          const val = (instruction as any).value
          if (typeof val === "object" && val !== null && !Array.isArray(val)) {
            const newTree: Record<string, StateTree> = {}
            syncStateTreeToShadow(newTree, val, timestamp)
            target[key] = newTree
          } else {
            target[key] = [val, timestamp]
          }
        }
      }
    }
    return
  }

  // Traverse to the parent of the target node
  let current: unknown = tree
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path.segments[i]
    const key = String(segment.resolve())
    let next = (current as Record<string, unknown>)[key]
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      next = {}
      ;(current as Record<string, unknown>)[key] = next
    }
    current = next
  }

  const lastSegment = path.segments[path.length - 1]
  const key = String(lastSegment.resolve())
  const target = current as Record<string, StateTree>

  if (change.type === "replace") {
    const val = (change as any).value
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      const newTree: Record<string, StateTree> = {}
      syncStateTreeToShadow(newTree, val, timestamp)
      target[key] = newTree
    } else {
      target[key] = [val, timestamp]
    }
  } else if (change.type === "map") {
    let child = target[key]
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      child = {}
      target[key] = child
    }
    const mapChange = change as any
    const cTarget = child as Record<string, StateTree>
    for (const [k, instruction] of Object.entries(mapChange.entries)) {
      if ((instruction as any).type === "delete") {
        delete cTarget[k]
      } else if ((instruction as any).type === "set") {
        const val = (instruction as any).value
        if (typeof val === "object" && val !== null && !Array.isArray(val)) {
          const newTree: Record<string, StateTree> = {}
          syncStateTreeToShadow(newTree, val, timestamp)
          cTarget[k] = newTree
        } else {
          cTarget[k] = [val, timestamp]
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// syncStateTreeToShadow
// ---------------------------------------------------------------------------

/**
 * Propagate a PlainState (from user mutations) into a StateTree.
 * Any scalar value in `plain` becomes `[value, timestamp]` in `tree`.
 */
function syncStateTreeToShadow(
  tree: StateTree,
  plain: any,
  timestamp: number,
): void {
  if (isStateTuple(tree)) {
    throw new Error("Cannot sync into a root tuple.")
  }

  const target = tree as Record<string, StateTree>

  // Recursively update or insert keys
  for (const key of Object.keys(plain)) {
    const val = plain[key]

    // If it's an object, it's a container.
    if (typeof val === "object" && val !== null && !Array.isArray(val)) {
      if (!target[key] || isStateTuple(target[key])) {
        target[key] = {}
      }
      syncStateTreeToShadow(target[key], val, timestamp)
    } else {
      // It's a scalar leaf.
      target[key] = [val, timestamp]
    }
  }

  // Remove keys deleted from plain
  for (const key of Object.keys(target)) {
    if (!(key in plain)) {
      delete target[key]
    }
  }
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
      // `state` has no true epoch boundary, so field-level LWW merge is
      // the correct fallback.
      replica.merge(payload)
    },
  }
  return replica
}

// ---------------------------------------------------------------------------
// stateSubstrateFactory
// ---------------------------------------------------------------------------

export const stateReplicaFactory: ReplicaFactory<StateVersion> = {
  replicaType: ["state", 1, 0] as const,

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

export const stateSubstrateFactory: SubstrateFactory<StateVersion> = {
  replica: stateReplicaFactory,

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
    insertStructuralZeros(tree, defaults)

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

function insertStructuralZeros(tree: StateTree, defaults: any): void {
  if (isStateTuple(tree)) return

  const t = tree as Record<string, StateTree>

  for (const key of Object.keys(defaults)) {
    const defaultVal = defaults[key]
    if (!(key in t)) {
      if (
        typeof defaultVal === "object" &&
        defaultVal !== null &&
        !Array.isArray(defaultVal)
      ) {
        t[key] = {}
        insertStructuralZeros(t[key], defaultVal)
      } else {
        // Scalar zero gets timestamp 0 (Unix epoch = -Infinity)
        t[key] = [defaultVal, 0]
      }
    } else {
      if (
        typeof defaultVal === "object" &&
        defaultVal !== null &&
        !Array.isArray(defaultVal)
      ) {
        insertStructuralZeros(t[key], defaultVal)
      }
    }
  }
}
