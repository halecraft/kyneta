// substrate — LoroSubstrate implementation.
//
// Implements Substrate<LoroVersion> with:
// - applyDiff-based local writes (prepare accumulates diffs, onFlush applies)
// - Persistent doc.subscribe() event bridge for external changes
// - Two re-entrancy guards: inOurCommit and inEventHandler
//
// The event bridge contract: wrapping a LoroDoc in a kyneta substrate
// means subscribing to the kyneta doc observes ALL mutations to the
// underlying LoroDoc, regardless of source (local kyneta writes,
// importDelta, external doc.import, external raw Loro API mutations).

import type {
  Schema as SchemaNode,
  Substrate,
  SubstrateFactory,
  SubstratePayload,
} from "@kyneta/schema"
import {
  buildWritableContext,
  executeBatch,
  type WritableContext,
  type Path,
  type ChangeBase,
  type Op,
  Zero,
} from "@kyneta/schema"
import type {
  ContainerID,
  Diff,
  JsonDiff,
  LoroDoc as LoroDocType,
} from "loro-crdt"
import { LoroDoc } from "loro-crdt"
import { PROPS_KEY } from "./loro-resolve.js"
import { LoroVersion } from "./version.js"
import { loroStoreReader } from "./store-reader.js"
import { changeToDiff, batchToOps } from "./change-mapping.js"
import { registerLoroSubstrate } from "./loro-escape.js"

// ---------------------------------------------------------------------------
// createLoroSubstrate — wrap a user-provided LoroDoc
// ---------------------------------------------------------------------------

/**
 * Creates a `Substrate<LoroVersion>` wrapping a user-provided LoroDoc.
 *
 * This is the "bring your own doc" entry point. The user creates and
 * manages the LoroDoc (possibly via a state bus); this function wraps
 * it with a schema-aware overlay providing typed reads, writes,
 * versioning, and export/import through the standard Substrate interface.
 *
 * **Event bridge contract:** A persistent `doc.subscribe()` handler is
 * registered at construction time. All non-kyneta mutations to the
 * LoroDoc (imports, external local writes) are bridged to the kyneta
 * changefeed. Subscribing to the kyneta doc observes all mutations
 * regardless of source.
 *
 * @param doc - The LoroDoc to wrap. The substrate does NOT own the doc;
 *   the caller is responsible for its lifecycle.
 * @param schema - The root schema for the document.
 */
export function createLoroSubstrate(
  doc: LoroDocType,
  schema: SchemaNode,
): Substrate<LoroVersion> {
  // --- Closure-scoped state ---

  // Accumulated diff groups from prepare(), drained by onFlush().
  // Each group is the output of a single changeToDiff() call and must
  // be applied as a single applyDiff() batch to preserve JsonContainerID
  // (🦜:) cross-references within the group.
  const pendingGroups: [ContainerID, Diff | JsonDiff][][] = []

  // Re-entrancy guard: set true around doc.commit() inside onFlush.
  // When doc.commit() fires Loro events with by:"local", the subscriber
  // sees inOurCommit === true and ignores them (changefeed already
  // captured these ops via wrappedPrepare).
  let inOurCommit = false

  // Re-entrancy guard: set true around executeBatch inside the subscriber.
  // Prevents substrate.prepare from accumulating diffs (changes already
  // applied by Loro) and substrate.onFlush from calling applyDiff/commit.
  let inEventHandler = false

  // Stashed origin from importDelta for the subscriber to pick up.
  let pendingImportOrigin: string | undefined

  // Lazy-built WritableContext (same pattern as PlainSubstrate).
  let cachedCtx: WritableContext | undefined

  // The StoreReader — live view over the Loro container tree.
  const reader = loroStoreReader(doc, schema)

  // --- Substrate object ---

  const substrate: Substrate<LoroVersion> = {
    store: reader,

    prepare(path: Path, change: ChangeBase): void {
      if (!inEventHandler) {
        // Local write: convert Change → Loro Diff, accumulate as a group.
        // No Loro side effects — mutations happen at flush time.
        // Each group must be applied as a single applyDiff() call to
        // preserve JsonContainerID (🦜:) cross-references.
        const group = changeToDiff(path, change, schema, doc)
        if (group.length > 0) {
          pendingGroups.push(group)
        }
      }
      // During event handler replay: no-op on Loro side.
      // wrappedPrepare (changefeed layer) still buffers the op.
    },

    onFlush(origin?: string): void {
      if (!inEventHandler) {
        // Local write: apply accumulated diff groups, then commit.
        if (pendingGroups.length > 0) {
          // Apply each group as a single applyDiff() call. Groups from
          // different prepare() calls are applied separately (Loro can't
          // handle duplicate ContainerIDs in a single batch, e.g. two
          // TextDiffs for the same container from a multi-op transaction).
          // Within a group, entries may cross-reference via JsonContainerID
          // (🦜:) and MUST be in the same applyDiff() call.
          for (const group of pendingGroups) {
            doc.applyDiff(group as any)
          }
          pendingGroups.length = 0
        }
        if (origin !== undefined) {
          doc.setNextCommitMessage(origin)
        }
        inOurCommit = true
        try {
          doc.commit()
        } finally {
          inOurCommit = false
        }
      }
      // During event handler replay: no-op on Loro side.
      // wrappedFlush (changefeed layer) still delivers notifications.
    },

    context(): WritableContext {
      if (!cachedCtx) {
        cachedCtx = buildWritableContext(substrate)
      }
      return cachedCtx
    },

    frontier(): LoroVersion {
      return new LoroVersion(doc.version())
    },

    exportSnapshot(): SubstratePayload {
      return {
        encoding: "binary",
        data: doc.export({ mode: "snapshot" }),
      }
    },

    exportSince(since: LoroVersion): SubstratePayload | null {
      try {
        const bytes = doc.export({ mode: "update", from: since.vv })
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
          "LoroSubstrate.importDelta only supports binary-encoded payloads",
        )
      }
      // Stash origin for the subscriber to pick up
      pendingImportOrigin = origin
      try {
        doc.import(payload.data)
      } finally {
        pendingImportOrigin = undefined
      }
      // That's it — the doc.subscribe() handler bridges events to the
      // changefeed via executeBatch.
    },
  }

  // --- Event bridge (registered once at construction) ---

  doc.subscribe((batch) => {
    // Ignore our own commits (changefeed already captured via wrappedPrepare)
    if (batch.by === "local" && inOurCommit) {
      return
    }

    // Ignore checkout events (version travel, not mutations)
    if (batch.by === "checkout") {
      return
    }

    // Map Loro events → kyneta Ops
    const ops = batchToOps(batch, schema)
    if (ops.length === 0) {
      return
    }

    // Determine origin: prefer stashed kyneta origin (from importDelta),
    // fall back to Loro's batch origin.
    const origin = pendingImportOrigin ?? batch.origin

    // Lazily ensure the context is built
    const ctx = substrate.context()

    // Feed through executeBatch for changefeed delivery.
    // The inEventHandler guard prevents prepare/onFlush from doing
    // Loro-side work (changes are already applied).
    inEventHandler = true
    try {
      executeBatch(ctx, ops, origin)
    } finally {
      inEventHandler = false
    }
  })

  // Register for the loro() escape hatch
  registerLoroSubstrate(substrate, doc)

  return substrate
}

// ---------------------------------------------------------------------------
// loroSubstrateFactory — SubstrateFactory<LoroVersion>
// ---------------------------------------------------------------------------

/**
 * Factory for constructing Loro-backed substrates.
 *
 * - `create(schema, seed?)` — creates a fresh LoroDoc, populates root
 *   containers from the schema, applies seed values, returns a substrate.
 * - `fromSnapshot(payload, schema)` — creates a LoroDoc from a snapshot
 *   payload, returns a substrate.
 * - `parseVersion(serialized)` — deserializes a LoroVersion.
 */
export const loroSubstrateFactory: SubstrateFactory<LoroVersion> = {
  create(
    schema: SchemaNode,
    seed: Record<string, unknown> = {},
  ): Substrate<LoroVersion> {
    const doc = new LoroDoc()

    // Compute defaults and overlay seed
    const defaults = Zero.structural(schema) as Record<string, unknown>
    const initial = Zero.overlay(seed, defaults, schema) as Record<
      string,
      unknown
    >

    // Walk the schema to create root containers and populate from initial values.
    // The root schema should be an annotated("doc", product) — unwrap to get fields.
    let rootProduct = schema
    while (
      rootProduct._kind === "annotated" &&
      rootProduct.schema !== undefined
    ) {
      rootProduct = rootProduct.schema
    }

    if (rootProduct._kind === "product") {
      for (const [key, fieldSchema] of Object.entries(rootProduct.fields)) {
        const value = initial[key]
        populateRootField(doc, key, fieldSchema, value)
      }
    }

    doc.commit()
    return createLoroSubstrate(doc, schema)
  },

  fromSnapshot(
    payload: SubstratePayload,
    schema: SchemaNode,
  ): Substrate<LoroVersion> {
    if (
      payload.encoding !== "binary" ||
      !(payload.data instanceof Uint8Array)
    ) {
      throw new Error(
        "LoroSubstrateFactory.fromSnapshot only supports binary-encoded payloads",
      )
    }
    const doc = new LoroDoc()
    doc.import(payload.data)
    return createLoroSubstrate(doc, schema)
  },

  parseVersion(serialized: string): LoroVersion {
    return LoroVersion.parse(serialized)
  },
}

// ---------------------------------------------------------------------------
// populateRootField — create root container and populate with initial value
// ---------------------------------------------------------------------------

/**
 * Create a root-level container for a field and populate it with an
 * initial value from the seed/defaults.
 */
function populateRootField(
  doc: LoroDocType,
  key: string,
  fieldSchema: SchemaNode,
  value: unknown,
): void {
  const tag = fieldSchema._kind === "annotated" ? fieldSchema.tag : undefined

  switch (tag) {
    case "text": {
      const text = doc.getText(key)
      if (typeof value === "string" && value.length > 0) {
        text.insert(0, value)
      }
      return
    }

    case "counter": {
      const counter = doc.getCounter(key)
      if (typeof value === "number" && value !== 0) {
        counter.increment(value)
      }
      return
    }

    case "movable": {
      const movList = doc.getMovableList(key)
      if (Array.isArray(value)) {
        populateList(movList as any, value, fieldSchema)
      }
      return
    }

    case "tree": {
      // Tree initialization is complex — skip for now
      doc.getTree(key)
      return
    }
  }

  // Non-annotated structural types
  let structural = fieldSchema
  while (structural._kind === "annotated" && structural.schema !== undefined) {
    structural = structural.schema
  }

  switch (structural._kind) {
    case "product": {
      const map = doc.getMap(key)
      if (typeof value === "object" && value !== null) {
        populateMap(map as any, value as Record<string, unknown>, structural)
      }
      return
    }

    case "sequence": {
      const list = doc.getList(key)
      if (Array.isArray(value)) {
        populateList(list as any, value, fieldSchema)
      }
      return
    }

    case "map": {
      const map = doc.getMap(key)
      if (typeof value === "object" && value !== null) {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          map.set(k, v as any)
        }
      }
      return
    }

    case "scalar":
    case "sum": {
      // Non-container types: stored in the shared _props LoroMap.
      const propsMap = doc.getMap(PROPS_KEY)
      if (value !== undefined) {
        propsMap.set(key, value as any)
      }
      return
    }
  }
}

// ---------------------------------------------------------------------------
// Populate helpers for initial values
// ---------------------------------------------------------------------------

import { LoroMap, LoroList } from "loro-crdt"

function populateMap(
  map: any,
  value: Record<string, unknown>,
  schema: SchemaNode,
): void {
  let structural = schema
  while (structural._kind === "annotated" && structural.schema !== undefined) {
    structural = structural.schema
  }

  for (const [key, fieldValue] of Object.entries(value)) {
    if (fieldValue === undefined) continue

    let fieldSchema: SchemaNode | undefined
    if (structural._kind === "product") {
      fieldSchema = structural.fields[key]
    }

    if (
      fieldSchema &&
      fieldValue !== null &&
      typeof fieldValue === "object" &&
      !Array.isArray(fieldValue)
    ) {
      let fs = fieldSchema
      while (fs._kind === "annotated" && fs.schema !== undefined) {
        fs = fs.schema
      }
      if (fs._kind === "product") {
        const childMap = map.setContainer(key, new LoroMap())
        populateMap(childMap, fieldValue as Record<string, unknown>, fieldSchema)
        continue
      }
    }

    if (fieldSchema && Array.isArray(fieldValue)) {
      let fs = fieldSchema
      while (fs._kind === "annotated" && fs.schema !== undefined) {
        fs = fs.schema
      }
      if (fs._kind === "sequence") {
        const childList = map.setContainer(key, new LoroList())
        populateList(childList, fieldValue, fieldSchema)
        continue
      }
    }

    map.set(key, fieldValue as any)
  }
}

function populateList(
  list: any,
  value: unknown[],
  schema: SchemaNode,
): void {
  let seqSchema = schema
  while (seqSchema._kind === "annotated" && seqSchema.schema !== undefined) {
    seqSchema = seqSchema.schema
  }

  const itemSchema =
    seqSchema._kind === "sequence" ? seqSchema.item : undefined

  for (let i = 0; i < value.length; i++) {
    const item = value[i]

    if (
      itemSchema &&
      item !== null &&
      typeof item === "object" &&
      !Array.isArray(item)
    ) {
      let is = itemSchema
      while (is._kind === "annotated" && is.schema !== undefined) {
        is = is.schema
      }
      if (is._kind === "product") {
        const childMap = list.insertContainer(i, new LoroMap())
        populateMap(childMap, item as Record<string, unknown>, itemSchema)
        continue
      }
    }

    list.insert(i, item as any)
  }
}