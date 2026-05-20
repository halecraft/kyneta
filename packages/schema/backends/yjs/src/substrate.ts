// substrate — YjsSubstrate implementation.
//
// Implements Substrate<YjsVersion> with:
// - Imperative-eager local writes: `prepare` advances both the shadow σ
//   AND the native Y.Doc tree λ inside the ambient `Y.transact` opened
//   by `runBatch`. The projection law `σ ≡ Π(λ)` holds at every prepare
//   boundary — re-entrant subscribers reading either σ (via the Reader)
//   or λ (via `unwrap`) see a coherent state.
// - `runBatch(body)` opens one `Y.transact(doc, body, KYNETA_ORIGIN)` per
//   outermost logical action. Yjs's native transact nesting collapses
//   inner re-entrant transacts into the outer one for free — no depth
//   counter needed (unlike Loro). External `observeDeep` consumers see
//   exactly one batched event per outermost `change(doc, fn)`.
// - JSON-boundary writes (struct.json/list.json/record.json subtrees)
//   are buffered in a per-target-key coalescer and flushed in
//   `afterBatch`. Non-boundary writes are applied directly to λ via
//   `applyChangeToYjs`.
// - `afterBatch` flushes the json-boundary coalescer on local writes
//   and re-materialises σ from λ on replay.
// - Persistent observeDeep event bridge for external changes.
// - Transaction-origin filter (`KYNETA_ORIGIN`) to ignore our own writes.
//
// The event bridge contract: wrapping a Y.Doc in a kyneta substrate
// means subscribing to the kyneta doc observes ALL mutations to the
// underlying Y.Doc, regardless of source (local kyneta writes,
// merge, external Y.applyUpdate, external raw Yjs API mutations).
//
// `prepare` and `afterBatch` accept `BatchOptions` and branch on
// `options?.replay`. The event bridge constructs the replay batch via
// `executeBatch(ctx, ops, { origin, replay: true })`; substrate-side
// work (transact, write) is skipped when `replay` is true because the
// native Y.Doc already absorbed the change. This makes `prepare` and
// `afterBatch` total functions of their declared inputs — no hidden
// ambient state for the substrate-write decision. Context: jj:qpultxsw.
//
// Identity-keying: when a SchemaBinding is provided, all Y.Map key
// lookups and writes use the identity hash instead of the field name.
// The binding is threaded to the reader, event bridge, and write path.

import type {
  BatchOptions,
  ChangeBase,
  Path,
  PlainState,
  PositionCapable,
  ProductSchema,
  Reader,
  Replica,
  ReplicaFactory,
  SchemaBinding,
  Schema as SchemaNode,
  Side,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
  Version,
  WritableContext,
} from "@kyneta/schema"
import {
  applyChange,
  BACKING_DOC,
  buildWritableContext,
  deriveSchemaBinding,
  executeBatch,
  findJsonBoundary,
  KIND,
  plainReader,
  syncShadow,
} from "@kyneta/schema"
import * as Y from "yjs"
import { applyChangeToYjs, eventsToOps } from "./change-mapping.js"
import { materializeYjsShadow } from "./materialize.js"
import { ensureContainers } from "./populate.js"
import { toYjsAssoc, YjsPosition } from "./position.js"
import { YjsVersion } from "./version.js"
import { resolveYjsType } from "./yjs-resolve.js"

// ---------------------------------------------------------------------------
// Origin tag — used to suppress echo from our own transactions
// ---------------------------------------------------------------------------

const KYNETA_ORIGIN = "kyneta-prepare"

// ---------------------------------------------------------------------------
// createYjsSubstrate — wrap a user-provided Y.Doc
// ---------------------------------------------------------------------------

/**
 * Creates a `Substrate<YjsVersion>` wrapping a user-provided Y.Doc.
 *
 * This is the "bring your own doc" entry point. The user creates and
 * manages the Y.Doc (possibly via a Yjs provider); this function wraps
 * it with a schema-aware overlay providing typed reads, writes,
 * versioning, and export/merge through the standard Substrate interface.
 *
 * **Event bridge contract:** A persistent `observeDeep` handler is
 * registered on the root Y.Map at construction time. All non-kyneta
 * mutations to the Y.Doc (merges, external local writes) are bridged
 * to the kyneta changefeed. Subscribing to the kyneta doc observes all
 * mutations regardless of source.
 *
 * @param doc - The Y.Doc to wrap. The substrate does NOT own the doc;
 *   the caller is responsible for its lifecycle.
 * @param schema - The root schema for the document.
 * @param binding - Optional SchemaBinding for identity-keyed containers.
 */
export function createYjsSubstrate(
  doc: Y.Doc,
  schema: SchemaNode,
  binding?: SchemaBinding,
): Substrate<YjsVersion> {
  // --- Closure-scoped state ---

  // JSON-boundary coalescing buffer. Keyed by the target Y.Map and the
  // boundary key — repeated writes inside the same struct.json /
  // record.json subtree overwrite the entry with the latest σ value
  // before `afterBatch` flushes it back into λ as a single
  // `target.set(key, value)`. Non-boundary writes bypass the buffer
  // entirely — they go straight to `applyChangeToYjs` in prepare.
  const jsonBoundaryBuffer = new Map<
    string,
    { target: Y.Map<unknown> | Y.Array<unknown>; key: string | number; value: unknown }
  >()

  // Stashed origin from merge for the event bridge to pick up.
  let pendingMergeOrigin: string | undefined

  // Lazy-built WritableContext (same pattern as PlainSubstrate / LoroSubstrate).
  let cachedCtx: WritableContext | undefined

  // Incremental delete set tracking.
  // Initialized once from the struct store (O(n)), then maintained
  // incrementally by merging each transaction's deleteSet (O(delta)).
  // Note: DeleteSet class isn't exported from yjs's public entry point,
  // so we infer the type from createDeleteSet's return type.
  let accumulatedDs: ReturnType<typeof Y.createDeleteSet> =
    Y.createDeleteSetFromStructStore(doc.store)

  // The root Y.Map — all schema fields are children of this single map.
  const rootMap = doc.getMap("root")

  // The shadow — a plain JS object materialized from the Y.Doc.
  // Kept in sync by applyChange() in prepare().
  const shadow: PlainState = materializeYjsShadow(doc, schema, binding)
  const reader: Reader = plainReader(shadow)

  // --- Coalescer helpers ---

  /**
   * Compute the identity-aware boundary key (or numeric index) for a
   * json-boundary write at `prefixLength`. Mirrors the Loro substrate's
   * `boundaryKey`; field segments inside a bound product get the
   * identity hash, others pass through raw.
   */
  function boundaryKey(path: Path, prefixLength: number): string | number {
    const seg = path.segments[prefixLength]!
    if (seg.role === "field" && binding) {
      const absPath = path.segments
        .slice(0, prefixLength + 1)
        .filter(s => s.role === "field")
        .map(s => s.resolve() as string)
        .join(".")
      const identity = binding.forward.get(absPath) as string | undefined
      if (identity) return identity
    }
    return seg.resolve() as string | number
  }

  /**
   * Buffer a json-boundary write. The boundary value is the entire σ
   * subtree at the boundary path — already updated by the preceding
   * `applyChange(shadow, ...)`. Subsequent writes inside the same
   * subtree overwrite this entry (last-write-wins by σ snapshot).
   *
   * Returns silently when the parent container can't be resolved
   * (root-level json fields land in `rootMap` directly — Yjs's
   * root is the rootMap, so the parentResolved is `rootMap`).
   */
  function stageJsonBoundaryWrite(path: Path, prefixLength: number): void {
    const parentPath = path.slice(0, prefixLength)
    const { resolved: parent } = resolveYjsType(
      rootMap,
      schema,
      parentPath,
      binding,
    )
    const boundaryPath = path.slice(0, prefixLength + 1)
    const value = boundaryPath.read(shadow)
    const key = boundaryKey(path, prefixLength)

    // The target can be either a Y.Map (struct field, record entry,
    // or rootMap) or a Y.Array (list/movable item). Both expose a
    // shape we can stash and flush in `afterBatch`.
    let target: Y.Map<unknown> | Y.Array<unknown>
    if (parent instanceof Y.Map) {
      target = parent
    } else if (parent instanceof Y.Array) {
      target = parent
    } else {
      throw new Error(
        `yjs substrate: json-boundary write to unsupported parent type at path ${path.format()}`,
      )
    }

    // Use the Yjs shared-type's stable identity for the buffer key
    // when available; fall back to a unique sentinel for the
    // ultra-rare case where `_item` is undefined (freshly-created
    // shared types before they're attached). Combine with key/index
    // for a unique slot — repeat writes to the same slot overwrite.
    const targetId = `${(target as any)._item?.id?.client ?? "root"}:${(target as any)._item?.id?.clock ?? "root"}`
    const slot = `${targetId}/${String(key)}`
    jsonBoundaryBuffer.set(slot, { target, key, value })
  }

  /**
   * Drain the json-boundary buffer into λ. Called from `afterBatch`
   * inside the ambient `Y.transact` opened by `runBatch`. Each entry
   * is applied as `target.set(key, value)` for Y.Map parents or as a
   * delete+insert for Y.Array parents (Yjs Arrays don't have a
   * `set(index, value)` primitive — replace = delete one + insert one).
   */
  function flushJsonBoundaryBuffer(): void {
    if (jsonBoundaryBuffer.size === 0) return
    for (const { target, key, value } of jsonBoundaryBuffer.values()) {
      if (target instanceof Y.Map) {
        target.set(String(key), value)
      } else {
        const index = key as number
        target.delete(index, 1)
        target.insert(index, [value])
      }
    }
    jsonBoundaryBuffer.clear()
  }

  // --- Substrate object ---

  const substrate = {
    [BACKING_DOC]: doc,

    reader: reader,

    prepare(path: Path, change: ChangeBase, options?: BatchOptions): void {
      // Replay writes: λ has already absorbed these ops via
      // Y.applyUpdate at the event-bridge call site; skip σ/λ
      // advance — afterBatch(replay) rebuilds σ from λ in one
      // Π pass.
      if (options?.replay) return

      // Local write — σ advances eagerly. CRDT-side writes happen
      // inside the ambient Y.transact opened by runBatch (the
      // substrate's `runBatch` wraps `executeBatch`'s prepare-loop +
      // flush).
      applyChange(shadow, path, change)

      // JSON-boundary write: stage a full-value write at the
      // boundary segment of the parent container. Coalesces with
      // repeated writes inside the same subtree (last σ snapshot
      // wins) and lands in λ on `afterBatch` flush.
      const boundary = findJsonBoundary(schema, path, binding)
      if (boundary !== null) {
        stageJsonBoundaryWrite(path, boundary.prefixLength)
        return
      }

      // Non-boundary write: imperatively apply to λ inside the
      // ambient Y.transact. The KYNETA_ORIGIN tag lets the
      // observeDeep bridge below recognise and skip the events we
      // generate here, so the changefeed isn't fired twice.
      applyChangeToYjs(rootMap, schema, path, change, binding)
    },

    afterBatch(options?: BatchOptions): void {
      if (options?.replay) {
        // CRDT merge is a lattice join — re-materialise σ from λ in
        // one Π pass instead of replaying ops incrementally.
        syncShadow(shadow, materializeYjsShadow(doc, schema, binding))
        return
      }
      // Local write: drain the json-boundary coalescer. Runs inside
      // the ambient Y.transact from `runBatch`; the transact closes
      // when `runBatch`'s body returns, emitting one batched
      // observeDeep event for the whole logical action.
      flushJsonBoundaryBuffer()
    },

    runBatch(work: () => void, _options?: BatchOptions): void {
      // Yjs's native transact nesting collapses inner re-entrant
      // transacts into the outermost — exactly the "one batched
      // event per outermost logical action" semantic we want. No
      // depth counter needed.
      //
      // The KYNETA_ORIGIN tag (NOT `options?.origin`) is the Yjs-
      // layer transaction origin: the observeDeep bridge skips
      // transactions tagged with this origin because we already
      // captured the ops via wrappedPrepare. The app-level
      // `options?.origin` flows separately through the kyneta
      // Changeset via the changefeed layer.
      doc.transact(work, KYNETA_ORIGIN)
    },

    context(): WritableContext {
      if (!cachedCtx) {
        cachedCtx = buildWritableContext(substrate)
        // Attach nativeResolver — used by interpretImpl to set [NATIVE]
        // on every ref. The resolver maps schema positions to Yjs shared types.
        ;(cachedCtx as any).nativeResolver = (
          nodeSchema: SchemaNode,
          path: { segments: readonly unknown[] },
        ) => {
          if (path.segments.length === 0) return doc
          if (nodeSchema[KIND] === "scalar" || nodeSchema[KIND] === "sum")
            return undefined
          return resolveYjsType(rootMap, schema, path as any, binding).resolved
        }
        ;(cachedCtx as any).positionResolver = (
          _nodeSchema: unknown,
          path: { segments: readonly unknown[] },
        ) => {
          return {
            createPosition(index: number, side: Side) {
              // Resolve path to the Y.Text shared type
              const { resolved: ytype } = resolveYjsType(
                rootMap,
                schema,
                path as any,
                binding,
              )
              if (!(ytype instanceof Y.Text)) {
                throw new Error(
                  `positionResolver: path does not resolve to a Y.Text`,
                )
              }
              const assoc = toYjsAssoc(side)
              const rpos = Y.createRelativePositionFromTypeIndex(
                ytype,
                index,
                assoc,
              )
              return new YjsPosition(rpos, doc)
            },
            decodePosition(bytes: Uint8Array) {
              const rpos = Y.decodeRelativePosition(bytes)
              return new YjsPosition(rpos, doc)
            },
          } satisfies PositionCapable
        }
      }
      return cachedCtx
    },

    version(): YjsVersion {
      // Derive the deleteSet from the live struct store on every read.
      // Eager-prepare delivers notifications *inside* the ambient
      // `Y.transact` opened by `runBatch`, which means `afterTransaction`
      // (where `accumulatedDs` is incrementally updated) fires AFTER
      // the changefeed's `notifyLocalChange → version()` call. Computing
      // from the store picks up in-progress deletes too, so the
      // exchange's auto-subscribe sees a version that already reflects
      // the just-applied mutation. `accumulatedDs` remains for parity
      // with the prior incremental tracking — currently unused on the
      // version path but retained so external readers see a stable
      // running aggregate if/when we re-introduce incremental access.
      void accumulatedDs
      return YjsVersion.fromDeleteSet(
        doc,
        Y.createDeleteSetFromStructStore(doc.store),
      )
    },

    baseVersion(): YjsVersion {
      // Yjs substrate: base is always the initial state (no advance supported).
      return new YjsVersion(new Uint8Array([0]))
    },

    advance(_to: YjsVersion): void {
      throw new Error(
        "advance() on a live Yjs substrate is not yet supported. " +
          "Use advance() on a YjsReplica instead.",
      )
    },

    exportEntirety(): SubstratePayload {
      return {
        kind: "entirety",
        encoding: "binary",
        data: Y.encodeStateAsUpdate(doc),
      }
    },

    exportSince(since: Version): SubstratePayload | null {
      try {
        // ReplicaLike variance: signature uses Version, runtime type is always YjsVersion.
        const bytes = Y.encodeStateAsUpdate(doc, (since as YjsVersion).sv)
        return { kind: "since", encoding: "binary", data: bytes }
      } catch {
        return null
      }
    },

    merge(payload: SubstratePayload, options?: BatchOptions): void {
      if (
        payload.encoding !== "binary" ||
        !(payload.data instanceof Uint8Array)
      ) {
        throw new Error(
          "YjsSubstrate.merge expects binary-encoded payloads. " +
            "If you recently switched CRDT backends, stale clients may be sending incompatible data.",
        )
      }
      // Stash origin for the event bridge to pick up
      pendingMergeOrigin = options?.origin
      try {
        Y.applyUpdate(doc, payload.data, options?.origin ?? "remote")
      } finally {
        pendingMergeOrigin = undefined
      }
      // That's it — the observeDeep handler bridges events to the
      // changefeed via executeBatch with `replay: true`.
    },
  }

  // --- Event bridge (registered once at construction) ---

  rootMap.observeDeep((events, transaction) => {
    // Ignore our own transactions (changefeed already captured via wrappedPrepare)
    if (transaction.origin === KYNETA_ORIGIN) {
      return
    }

    // Convert Yjs events → kyneta Ops
    const ops = eventsToOps(events, schema, binding)
    if (ops.length === 0) {
      return
    }

    // Update accumulated delete set BEFORE executeBatch, so version()
    // reflects deletes when notifyLocalChange fires from the changefeed.
    if (transaction.deleteSet.clients.size > 0) {
      accumulatedDs = Y.mergeDeleteSets([accumulatedDs, transaction.deleteSet])
    }

    // Determine origin: prefer stashed kyneta origin (from merge),
    // fall back to the transaction's origin if it's a string.
    const origin =
      pendingMergeOrigin ??
      (typeof transaction.origin === "string" ? transaction.origin : undefined)

    // Lazily ensure the context is built
    const ctx = substrate.context()

    // `replay: true` tells substrate.prepare/afterBatch to skip native-side
    // work (Yjs has already absorbed these ops via Y.applyUpdate) and
    // surfaces on the Changeset for downstream filters (exchange echo).
    executeBatch(ctx, ops, { origin, replay: true })
  })

  // For local mutations (KYNETA_ORIGIN): the observeDeep handler returns
  // early, so we merge the delete set via afterTransaction instead.
  // afterTransaction fires inside doc.transact() — before runBatch's
  // body returns — so accumulatedDs is up to date when the changefeed's
  // deliverNotifications → notifyLocalChange → version() fires.
  doc.on("afterTransaction", (transaction: Y.Transaction) => {
    if (
      transaction.origin === KYNETA_ORIGIN &&
      transaction.deleteSet.clients.size > 0
    ) {
      accumulatedDs = Y.mergeDeleteSets([accumulatedDs, transaction.deleteSet])
    }
  })

  return substrate as Substrate<YjsVersion>
}

// ---------------------------------------------------------------------------
// yjsSubstrateFactory — SubstrateFactory<YjsVersion>
// ---------------------------------------------------------------------------

/**
 * Factory for constructing Yjs-backed substrates.
 *
 * - `create(schema)` — creates a fresh Y.Doc with empty containers
 *   matching the schema structure. No seed data — initial content
 *   should be applied via `change()` after construction.
 * - `fromEntirety(payload, schema)` — creates a Y.Doc from an entirety
 *   payload, returns a substrate.
 * - `parseVersion(serialized)` — deserializes a YjsVersion.
 *
 * Uses trivialBinding for identity-keying: every path maps to
 * `deriveIdentity(path, 1)` (generation 1, no renames).
 */

/**
 * Compute a trivial SchemaBinding for a schema with no migration history.
 * Every product field maps to `deriveIdentity(path, 1)`.
 */
function trivialBinding(schema: SchemaNode): SchemaBinding {
  if (schema[KIND] === "product") {
    return deriveSchemaBinding(schema as ProductSchema, {})
  }
  return { forward: new Map(), inverse: new Map() }
}
// ---------------------------------------------------------------------------
// yjsReplicaFactory — ReplicaFactory<YjsVersion>
// ---------------------------------------------------------------------------

/**
 * Schema-free replica factory for Yjs substrates.
 *
 * Constructs headless `Replica<YjsVersion>` instances backed by bare
 * `Y.Doc`s — no schema walking, no container initialization, no
 * Reader, no event bridge, no changefeed. Just the CRDT runtime
 * with version tracking and export/merge.
 *
 * Used by conduit participants (stores, routing servers)
 * that need to accumulate state, compute per-peer deltas, and compact
 * storage without ever interpreting document fields.
 */
export function createYjsReplica(doc: Y.Doc): Replica<YjsVersion> {
  let currentDoc = doc
  let currentBase: YjsVersion = new YjsVersion(Y.encodeStateVector(new Y.Doc()))

  return {
    get [BACKING_DOC]() {
      return currentDoc
    },

    version(): YjsVersion {
      return YjsVersion.fromDoc(currentDoc)
    },

    baseVersion(): YjsVersion {
      return currentBase
    },

    advance(to: Version): void {
      const baseCmp = currentBase.compare(to)
      if (baseCmp === "ahead") {
        throw new Error("advance(): target is behind base version")
      }
      const currentCmp = to.compare(this.version())
      if (currentCmp === "ahead") {
        throw new Error("advance(): target is ahead of current version")
      }

      // Yjs can only do full projection (to = version).
      // For any to < version, it's a no-op — undershoot contract.
      if (currentCmp !== "equal") return

      // Full projection: create a new doc with current state, no history.
      const update = Y.encodeStateAsUpdate(currentDoc)
      const newDoc = new Y.Doc()
      Y.applyUpdate(newDoc, update)
      currentDoc = newDoc
      currentBase = YjsVersion.fromDoc(currentDoc)
    },

    exportEntirety(): SubstratePayload {
      return {
        kind: "entirety",
        encoding: "binary",
        data: Y.encodeStateAsUpdate(currentDoc),
      }
    },

    exportSince(since: Version): SubstratePayload | null {
      try {
        // The ReplicaLike contract uses the base `Version` type for variance
        // safety. At runtime the synchronizer always passes a YjsVersion from
        // this replica's own factory — the cast is sound.
        const bytes = Y.encodeStateAsUpdate(
          currentDoc,
          (since as YjsVersion).sv,
        )
        return { kind: "since", encoding: "binary", data: bytes }
      } catch {
        return null
      }
    },

    merge(payload: SubstratePayload, _options?: BatchOptions): void {
      if (
        payload.encoding !== "binary" ||
        !(payload.data instanceof Uint8Array)
      ) {
        throw new Error(
          "YjsReplica.merge expects binary-encoded payloads. " +
            "If you recently switched CRDT backends, stale clients may be sending incompatible data.",
        )
      }
      Y.applyUpdate(currentDoc, payload.data)
    },
  } as Replica<YjsVersion>
}

export const yjsReplicaFactory: ReplicaFactory<YjsVersion> = {
  replicaType: ["yjs", 1, 0] as const,

  createEmpty(): Replica<YjsVersion> {
    return createYjsReplica(new Y.Doc())
  },

  fromEntirety(payload: SubstratePayload): Replica<YjsVersion> {
    if (
      payload.encoding !== "binary" ||
      !(payload.data instanceof Uint8Array)
    ) {
      throw new Error(
        "YjsReplicaFactory.fromEntirety only supports binary-encoded payloads",
      )
    }
    const doc = new Y.Doc()
    Y.applyUpdate(doc, payload.data)
    return createYjsReplica(doc)
  },

  parseVersion(serialized: string): YjsVersion {
    return YjsVersion.parse(serialized)
  },
}

// ---------------------------------------------------------------------------
// yjsSubstrateFactory — SubstrateFactory<YjsVersion>
// ---------------------------------------------------------------------------

export const yjsSubstrateFactory: SubstrateFactory<YjsVersion> = {
  replica: yjsReplicaFactory,

  createReplica(): Replica<YjsVersion> {
    // Default random clientID — safe for hydration (no local writes).
    return createYjsReplica(new Y.Doc())
  },

  upgrade(
    replica: Replica<YjsVersion>,
    schema: SchemaNode,
  ): Substrate<YjsVersion> {
    const doc = (replica as any)[BACKING_DOC] as Y.Doc
    const binding = trivialBinding(schema)
    // No identity injection for the standalone factory (no peerId).
    ensureContainers(doc, schema, binding)
    return createYjsSubstrate(doc, schema, binding)
  },

  create(schema: SchemaNode): Substrate<YjsVersion> {
    const doc = new Y.Doc()
    const binding = trivialBinding(schema)
    ensureContainers(doc, schema, binding)
    return createYjsSubstrate(doc, schema, binding)
  },

  fromEntirety(
    payload: SubstratePayload,
    schema: SchemaNode,
  ): Substrate<YjsVersion> {
    // Two-phase path: createReplica → merge → upgrade
    const replica = this.createReplica()
    replica.merge(payload)
    return this.upgrade(replica, schema)
  },

  parseVersion(serialized: string): YjsVersion {
    return YjsVersion.parse(serialized)
  },
}
