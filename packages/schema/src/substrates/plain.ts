// plain — the plain JS object substrate.
//
// The plain substrate wraps a passive `Record<string, unknown>` and
// delegates mutations to `applyChangeToStore`. It is the degenerate
// case of the Substrate abstraction — no CRDT runtime, no native
// oplog, just a plain JS object.
//
// `createPlainSubstrate(store)` returns a full `Substrate<PlainVersion>`
// with version tracking via a shadow buffer in `prepare`/`onFlush`,
// plus `version`, `exportEntirety`, `exportSince`, `merge`.
// `plainContext(store)` is a shorthand that returns just the
// `WritableContext` — convenient for tests that don't need the
// substrate reference.
//
// `PlainVersion` wraps a monotonic integer — the external version
// marker for plain substrates. Plain substrates have a total order
// (no concurrency), so `compare()` never returns "concurrent".
//
// `plainSubstrateFactory` is the canonical factory for constructing
// plain substrates from schemas or entirety payloads. It delegates
// to `createPlainSubstrate` internally.
//
// Context: jj:wmyomqzw (Phase 0), jj:wqoqzzpp (Phase 2)

import type { ChangeBase } from "../change.js"
import { replaceChange } from "../change.js"
import type { Op } from "../changefeed.js"
import type { Path } from "../interpret.js"
import type { WritableContext } from "../interpreters/writable.js"
import { buildWritableContext, executeBatch } from "../interpreters/writable.js"
import { RawPath, rawIndex, rawKey } from "../path.js"
import type { Schema as SchemaNode } from "../schema.js"
import { applyChangeToStore, plainStoreReader, type Store } from "../store.js"
import type {
  Replica,
  ReplicaFactory,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
  Version,
} from "../substrate.js"
import { Zero } from "../zero.js"

// ---------------------------------------------------------------------------
// PlainVersion — monotonic integer version marker
// ---------------------------------------------------------------------------

/**
 * A version marker wrapping a monotonic integer.
 *
 * Plain substrates have a total order — `compare()` returns "behind",
 * "equal", or "ahead" but never "concurrent".
 */
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
// createPlainSubstrate — full Substrate<PlainVersion> from a bare store
// ---------------------------------------------------------------------------

/**
 * Creates a full `Substrate<PlainVersion>` wrapping a plain JS object
 * store, with version tracking, export/merge, and the shadow buffer
 * for op logging.
 *
 * This is the low-level entry point when you already have a store.
 * For schema-aware construction (with `Zero.structural` / `Zero.overlay`),
 * use `plainSubstrateFactory.create(schema, seed?)` instead.
 */
export function createPlainSubstrate(storeObj: Store): Substrate<PlainVersion> {
  const reader = plainStoreReader(storeObj)

  // --- Shared replication core ---
  const replicaCore = createPlainReplicaCore(storeObj)

  // The WritableContext is built lazily and cached — the same context
  // is returned on every call to `context()`.
  let cachedCtx: WritableContext | undefined

  const substrate: Substrate<PlainVersion> = {
    store: reader,

    prepare(path: Path, change: ChangeBase): void {
      applyChangeToStore(storeObj, path, change)
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

    version(): PlainVersion {
      return replicaCore.version()
    },

    exportEntirety(): SubstratePayload {
      return replicaCore.exportEntirety()
    },

    exportSince(since: PlainVersion): SubstratePayload | null {
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
        // Op array — apply incrementally through the prepare/flush pipeline.
        const raw = JSON.parse(payload.data) as SerializedOp[]
        if (raw.length === 0) return
        const ops = deserializeOps(raw)
        executeBatch(ctx, ops, origin)
      }
    },
  }

  return substrate
}

// ---------------------------------------------------------------------------
// createPlainReplicaCore — shared versioning and export/merge core
// ---------------------------------------------------------------------------

/**
 * The shared replication core used by both `createPlainSubstrate` and
 * `createPlainReplica`. Holds the op log, version counter, and
 * export/merge logic — the parts that don't require schema
 * interpretation or the changefeed pipeline.
 */
function createPlainReplicaCore(storeObj: Store) {
  // Version log: log[i] = batch of Ops from version i → i+1.
  const log: Op[][] = []

  // Monotonic version counter, incremented on each flush cycle
  // that produced at least one Op.
  let versionCounter = 0

  // Pending ops buffer — filled by prepare (Substrate) or
  // merge (Replica), drained by flush.
  const pendingOps: Op[] = []

  return {
    pendingOps,

    flush(): void {
      if (pendingOps.length > 0) {
        log.push([...pendingOps])
        pendingOps.length = 0
        versionCounter++
      }
    },

    version(): PlainVersion {
      return new PlainVersion(versionCounter)
    },

    exportEntirety(): SubstratePayload {
      return {
        kind: "entirety",
        encoding: "json",
        data: JSON.stringify(storeObj),
      }
    },

    exportSince(since: PlainVersion): SubstratePayload | null {
      const sinceValue = since.value
      if (sinceValue > versionCounter) return null
      if (sinceValue === versionCounter) {
        return null
      }
      const ops = log.slice(sinceValue).flat()
      return {
        kind: "since",
        encoding: "json",
        data: JSON.stringify(serializeOps(ops)),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// createPlainReplica — headless replication surface (no schema)
// ---------------------------------------------------------------------------

/**
 * Creates a headless `Replica<PlainVersion>` — a plain JS object with
 * version tracking and export/merge, but no schema interpretation,
 * no StoreReader, no WritableContext, no changefeed.
 *
 * Used by conduit participants (storage adapters, routing servers)
 * that need to accumulate state, compute deltas, and compact storage
 * without ever reading or writing document fields.
 *
 * @param storeObj - The backing plain JS object store.
 */
export function createPlainReplica(storeObj: Store): Replica<PlainVersion> {
  const core = createPlainReplicaCore(storeObj)

  return {
    version(): PlainVersion {
      return core.version()
    },

    exportEntirety(): SubstratePayload {
      return core.exportEntirety()
    },

    exportSince(since: PlainVersion): SubstratePayload | null {
      return core.exportSince(since)
    },

    merge(payload: SubstratePayload, _origin?: string): void {
      if (payload.encoding !== "json" || typeof payload.data !== "string") {
        throw new Error(
          "PlainReplica.merge expects JSON-encoded payloads. " +
            "If you recently switched CRDT backends, stale clients may be sending incompatible data.",
        )
      }

      // Dispatch on payload kind — the producer tagged it at creation time.
      const ops: Op[] =
        payload.kind === "entirety"
          ? stateImageToOps(payload.data)
          : deserializeOps(JSON.parse(payload.data) as SerializedOp[])

      if (ops.length === 0) return

      // Apply directly to the store — no changefeed, no prepare/flush.
      for (const op of ops) {
        applyChangeToStore(storeObj, op.path, op.change)
        core.pendingOps.push(op)
      }
      core.flush()
    },
  }
}

// ---------------------------------------------------------------------------
// plainContext — shorthand for tests
// ---------------------------------------------------------------------------

/**
 * Shorthand: wraps a plain store in a substrate and returns its
 * WritableContext.
 *
 * Useful in tests where you don't need the substrate reference:
 *
 * ```ts
 * const ctx = plainContext(store)
 * const doc = interpret(schema, ctx).with(readable).with(writable).done()
 * ```
 */
export function plainContext(storeObj: Store): WritableContext {
  return createPlainSubstrate(storeObj).context()
}

// ---------------------------------------------------------------------------
// stateImageToOps — shared helper for entirety payload absorption
// ---------------------------------------------------------------------------

/**
 * Parse a JSON state image and build one `ReplaceChange` op per top-level key.
 *
 * Used by three call sites:
 * - `PlainSubstrate.merge` (entirety path — apply via executeBatch)
 * - `PlainReplica.merge` (entirety path — apply via applyChangeToStore)
 * - `plainSubstrateFactory.fromEntirety` (cold-start construction)
 */
function stateImageToOps(json: string): Op[] {
  const state = JSON.parse(json) as Record<string, unknown>
  const ops: Op[] = []
  for (const [key, value] of Object.entries(state)) {
    ops.push({
      path: RawPath.empty.field(key),
      change: replaceChange(value),
    })
  }
  return ops
}

// ---------------------------------------------------------------------------
// PlainSubstrateFactory — construction from schema or entirety
// ---------------------------------------------------------------------------

/**
 * Factory for constructing plain JS object substrates.
 *
 * - `create(schema)` — fresh substrate with Zero.structural defaults.
 * - `fromEntirety(payload, schema)` — reconstruct from an entirety payload
 *   via executeBatch (produces version > 0 with ops in the log).
 * - `parseVersion(serialized)` — deserialize a PlainVersion.
 */
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
    return createPlainReplica({} as Store)
  },

  fromEntirety(payload: SubstratePayload): Replica<PlainVersion> {
    if (payload.encoding !== "json" || typeof payload.data !== "string") {
      throw new Error(
        "PlainReplicaFactory.fromEntirety only supports JSON-encoded payloads",
      )
    }
    const state = JSON.parse(payload.data) as Record<string, unknown>
    return createPlainReplica(state as Store)
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

export const plainSubstrateFactory: SubstrateFactory<PlainVersion> = {
  create(schema: SchemaNode): Substrate<PlainVersion> {
    const defaults = Zero.structural(schema) as Record<string, unknown>
    const storeObj = { ...defaults } as Store
    return createPlainSubstrate(storeObj)
  },

  fromEntirety(
    payload: SubstratePayload,
    schema: SchemaNode,
  ): Substrate<PlainVersion> {
    if (payload.encoding !== "json" || typeof payload.data !== "string") {
      throw new Error(
        "PlainSubstrateFactory.fromEntirety only supports JSON-encoded payloads",
      )
    }
    // Create empty substrate, then apply entirety state through the
    // prepare/flush pipeline. This produces version > 0 with ops in
    // the log, so version comparison works correctly for sequential sync.
    const substrate = plainSubstrateFactory.create(schema)
    const ops = stateImageToOps(payload.data as string)
    if (ops.length > 0) {
      executeBatch(substrate.context(), ops)
    }
    return substrate
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
