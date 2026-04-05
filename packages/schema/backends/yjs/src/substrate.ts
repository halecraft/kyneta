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

import type {
  ChangeBase,
  Path,
  Reader,
  Replica,
  ReplicaFactory,
  Schema as SchemaNode,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
  WritableContext,
} from "@kyneta/schema"
import { BACKING_DOC, buildWritableContext, executeBatch } from "@kyneta/schema"
import * as Y from "yjs"
import { applyChangeToYjs, eventsToOps } from "./change-mapping.js"
import { ensureContainers } from "./populate.js"
import { yjsReader } from "./reader.js"
import { YjsVersion } from "./version.js"

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
 */
export function createYjsSubstrate(
  doc: Y.Doc,
  schema: SchemaNode,
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

  // The root Y.Map — all schema fields are children of this single map.
  const rootMap = doc.getMap("root")

  // The Reader — live view over the Yjs shared type tree.
  const reader: Reader = yjsReader(doc, schema)

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
              applyChangeToYjs(rootMap, schema, path, change)
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
      }
      return cachedCtx
    },

    version(): YjsVersion {
      return new YjsVersion(Y.encodeStateVector(doc))
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
    const ops = eventsToOps(events, schema)
    if (ops.length === 0) {
      return
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
 */
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
  return {
    [BACKING_DOC]: doc,

    version(): YjsVersion {
      return new YjsVersion(Y.encodeStateVector(doc))
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
      Y.applyUpdate(doc, payload.data)
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
    // No identity injection for the standalone factory (no peerId).
    // Conditional ensureContainers: skip fields that already exist
    // from hydrated state.
    ensureContainers(doc, schema, true)
    return createYjsSubstrate(doc, schema)
  },

  create(schema: SchemaNode): Substrate<YjsVersion> {
    // Fresh doc — unconditional ensureContainers (nothing to conflict with).
    const doc = new Y.Doc()
    ensureContainers(doc, schema)
    return createYjsSubstrate(doc, schema)
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
