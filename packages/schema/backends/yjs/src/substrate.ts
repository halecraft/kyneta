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
// importDelta, external Y.applyUpdate, external raw Yjs API mutations).

import type {
  ChangeBase,
  Path,
  Schema as SchemaNode,
  StoreReader,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
  WritableContext,
} from "@kyneta/schema"
import { buildWritableContext, executeBatch } from "@kyneta/schema"
import * as Y from "yjs"
import { applyChangeToYjs, eventsToOps } from "./change-mapping.js"
import { populateRoot } from "./populate.js"
import { yjsStoreReader } from "./store-reader.js"
import { YjsVersion } from "./version.js"
import { registerYjsSubstrate } from "./yjs-escape.js"

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
 * versioning, and export/import through the standard Substrate interface.
 *
 * **Event bridge contract:** A persistent `observeDeep` handler is
 * registered on the root Y.Map at construction time. All non-kyneta
 * mutations to the Y.Doc (imports, external local writes) are bridged
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

  // Stashed origin from importDelta for the event bridge to pick up.
  let pendingImportOrigin: string | undefined

  // Lazy-built WritableContext (same pattern as PlainSubstrate / LoroSubstrate).
  let cachedCtx: WritableContext | undefined

  // The root Y.Map — all schema fields are children of this single map.
  const rootMap = doc.getMap("root")

  // The StoreReader — live view over the Yjs shared type tree.
  const reader: StoreReader = yjsStoreReader(doc, schema)

  // --- Substrate object ---

  const substrate: Substrate<YjsVersion> = {
    store: reader,

    prepare(path: Path, change: ChangeBase): void {
      if (!inOurTransaction) {
        // Local write: accumulate for flush.
        // No Yjs side effects — mutations happen at flush time.
        pendingChanges.push({ path, change })
      }
      // During event handler replay: no-op on Yjs side.
      // wrappedPrepare (changefeed layer) still buffers the op.
    },

    onFlush(origin?: string): void {
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

    exportSnapshot(): SubstratePayload {
      return {
        encoding: "binary",
        data: Y.encodeStateAsUpdate(doc),
      }
    },

    exportSince(since: YjsVersion): SubstratePayload | null {
      try {
        const bytes = Y.encodeStateAsUpdate(doc, since.sv)
        return { encoding: "binary", data: bytes }
      } catch {
        return null
      }
    },

    importDelta(payload: SubstratePayload, origin?: string): void {
      if (
        payload.encoding !== "binary" ||
        !(payload.data instanceof Uint8Array)
      ) {
        throw new Error(
          "YjsSubstrate.importDelta only supports binary-encoded payloads",
        )
      }
      // Stash origin for the event bridge to pick up
      pendingImportOrigin = origin
      try {
        Y.applyUpdate(doc, payload.data, origin ?? "remote")
      } finally {
        pendingImportOrigin = undefined
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
    const ops = eventsToOps(events)
    if (ops.length === 0) {
      return
    }

    // Determine origin: prefer stashed kyneta origin (from importDelta),
    // fall back to the transaction's origin if it's a string.
    const origin =
      pendingImportOrigin ??
      (typeof transaction.origin === "string"
        ? transaction.origin
        : undefined)

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

  // Register for the yjs() escape hatch
  registerYjsSubstrate(substrate, doc)

  return substrate
}

// ---------------------------------------------------------------------------
// yjsSubstrateFactory — SubstrateFactory<YjsVersion>
// ---------------------------------------------------------------------------

/**
 * Factory for constructing Yjs-backed substrates.
 *
 * - `create(schema, seed?)` — creates a fresh Y.Doc, populates root
 *   containers from the schema, applies seed values, returns a substrate.
 * - `fromSnapshot(payload, schema)` — creates a Y.Doc from a snapshot
 *   payload, returns a substrate.
 * - `parseVersion(serialized)` — deserializes a YjsVersion.
 */
export const yjsSubstrateFactory: SubstrateFactory<YjsVersion> = {
  create(
    schema: SchemaNode,
    seed: Record<string, unknown> = {},
  ): Substrate<YjsVersion> {
    const doc = new Y.Doc()
    populateRoot(doc, schema, seed)
    return createYjsSubstrate(doc, schema)
  },

  fromSnapshot(
    payload: SubstratePayload,
    schema: SchemaNode,
  ): Substrate<YjsVersion> {
    if (
      payload.encoding !== "binary" ||
      !(payload.data instanceof Uint8Array)
    ) {
      throw new Error(
        "YjsSubstrateFactory.fromSnapshot only supports binary-encoded payloads",
      )
    }
    const doc = new Y.Doc()
    Y.applyUpdate(doc, payload.data)
    return createYjsSubstrate(doc, schema)
  },

  parseVersion(serialized: string): YjsVersion {
    return YjsVersion.parse(serialized)
  },
}