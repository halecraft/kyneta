// substrate — YjsSubstrate implementation.
//
// Implements Substrate<YjsVersion> with:
// - Imperative local writes (prepare accumulates, onFlush applies in transact)
// - Persistent observeDeep event bridge for external changes
// - Single re-entrancy guard + transaction.origin check
//
// The event bridge contract: wrapping a Y.Doc in a kyneta substrate
// means subscribing to the kyneta doc observes ALL mutations to the
// underlying Y.Doc, regardless of source (local kyneta writes,
// merge, external Y.applyUpdate, external raw Yjs API mutations).
//
// Identity-keying: when a SchemaBinding is provided, all Y.Map key
// lookups and writes use the identity hash instead of the field name.
// The binding is threaded to the reader, event bridge, and write path.

import type {
  ChangeBase,
  Path,
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
  WritableContext,
} from "@kyneta/schema"
import {
  BACKING_DOC,
  buildWritableContext,
  deriveSchemaBinding,
  executeBatch,
  KIND,
} from "@kyneta/schema"
import * as Y from "yjs"
import { applyChangeToYjs, eventsToOps } from "./change-mapping.js"
import { ensureContainers } from "./populate.js"
import { toYjsAssoc, YjsPosition } from "./position.js"
import { yjsReader } from "./reader.js"
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

  // Accumulated changes from prepare(), drained by onFlush().
  const pendingChanges: Array<{ path: Path; change: ChangeBase }> = []

  // Re-entrancy guard: set true around our doc.transact() in onFlush
  // AND around executeBatch in the event bridge. When true, prepare()
  // skips Yjs-side work (changes are already applied by Yjs or about
  // to be), and onFlush() skips transact/commit.
  let inOurTransaction = false

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

  // The Reader — live view over the Yjs shared type tree.
  const reader: Reader = yjsReader(doc, schema, binding)

  // --- Substrate object ---

  const substrate = {
    [BACKING_DOC]: doc,

    reader: reader,

    prepare(path: Path, change: ChangeBase): void {
      if (!inOurTransaction) {
        // Local write: accumulate for flush.
        // No Yjs side effects — mutations happen at flush time.
        pendingChanges.push({ path, change })
      }
      // During event handler replay: no-op on Yjs side.
      // wrappedPrepare (changefeed layer) still buffers the op.
    },

    onFlush(_origin?: string): void {
      if (!inOurTransaction && pendingChanges.length > 0) {
        // Local write: apply accumulated changes within a single
        // Yjs transaction tagged with our origin for echo suppression.
        inOurTransaction = true
        try {
          doc.transact(() => {
            for (const { path, change } of pendingChanges) {
              applyChangeToYjs(rootMap, schema, path, change, binding)
            }
          }, KYNETA_ORIGIN)
          pendingChanges.length = 0
        } finally {
          inOurTransaction = false
        }
      }
      // During event handler replay: no-op on Yjs side.
      // wrappedFlush (changefeed layer) still delivers notifications.
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
      return YjsVersion.fromDeleteSet(doc, accumulatedDs)
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

    exportSince(since: YjsVersion): SubstratePayload | null {
      try {
        const bytes = Y.encodeStateAsUpdate(doc, since.sv)
        return { kind: "since", encoding: "binary", data: bytes }
      } catch {
        return null
      }
    },

    merge(payload: SubstratePayload, origin?: string): void {
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
      pendingMergeOrigin = origin
      try {
        Y.applyUpdate(doc, payload.data, origin ?? "remote")
      } finally {
        pendingMergeOrigin = undefined
      }
      // That's it — the observeDeep handler bridges events to the
      // changefeed via executeBatch.
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

    // Feed through executeBatch for changefeed delivery.
    // The inOurTransaction guard prevents prepare/onFlush from doing
    // Yjs-side work — the changes are already applied by Yjs.
    inOurTransaction = true
    try {
      executeBatch(ctx, ops, origin)
    } finally {
      inOurTransaction = false
    }
  })

  // For local mutations (KYNETA_ORIGIN): the observeDeep handler returns
  // early, so we merge the delete set via afterTransaction instead.
  // afterTransaction fires inside doc.transact() — before onFlush returns
  // — so accumulatedDs is up to date when the changefeed's
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

    advance(to: YjsVersion): void {
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

    exportSince(since: YjsVersion): SubstratePayload | null {
      try {
        const bytes = Y.encodeStateAsUpdate(currentDoc, since.sv)
        return { kind: "since", encoding: "binary", data: bytes }
      } catch {
        return null
      }
    },

    merge(payload: SubstratePayload, _origin?: string): void {
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
    // Conditional ensureContainers: skip fields that already exist
    // from hydrated state.
    ensureContainers(doc, schema, true, binding)
    return createYjsSubstrate(doc, schema, binding)
  },

  create(schema: SchemaNode): Substrate<YjsVersion> {
    // Fresh doc — unconditional ensureContainers (nothing to conflict with).
    const doc = new Y.Doc()
    const binding = trivialBinding(schema)
    ensureContainers(doc, schema, false, binding)
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
