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
// merge, external doc.import, external raw Loro API mutations).

import {
  BACKING_DOC,
  buildWritableContext,
  type ChangeBase,
  deriveSchemaBinding,
  executeBatch,
  KIND,
  type MarkConfig,
  type Path,
  type PositionCapable,
  type ProductSchema,
  type Replica,
  type ReplicaFactory,
  type RichTextSchema,
  type SchemaBinding,
  type Schema as SchemaNode,
  type Side,
  type Substrate,
  type SubstrateFactory,
  type SubstratePayload,
  type Version,
  type WritableContext,
  Zero,
} from "@kyneta/schema"
import type {
  ContainerID,
  Diff,
  JsonDiff,
  LoroDoc as LoroDocType,
} from "loro-crdt"
import { Cursor, LoroDoc } from "loro-crdt"
import { batchToOps, changeToDiff } from "./change-mapping.js"
import { PROPS_KEY, resolveContainer } from "./loro-resolve.js"
import { LoroPosition, toLoroSide } from "./position.js"
import { loroReader } from "./reader.js"
import { LoroVersion } from "./version.js"

// ---------------------------------------------------------------------------
// mergePendingGroups — outbound leaf→container composition
// ---------------------------------------------------------------------------

/**
 * Merge pending diff groups that target the same ContainerID with MapDiff.
 *
 * When a transaction sets multiple keys on the same struct (e.g.,
 * `d.settings.a.set(true); d.settings.b.set(0)`), each `prepare` call
 * produces a separate single-element group targeting the same LoroMap.
 * This function merges those into a single group with a combined
 * `updated` record, producing one `applyDiff` call per container.
 *
 * **Only merges** single-element groups whose sole tuple is a MapDiff
 * (type "map") with no `🦜:` (JsonContainerID) references in values.
 * Multi-element groups (structured inserts with cross-references) and
 * non-map diffs (text, list, counter) are never merged — they pass
 * through unchanged.
 */
function mergePendingGroups(
  groups: [ContainerID, Diff | JsonDiff][][],
): [ContainerID, Diff | JsonDiff][][] {
  if (groups.length <= 1) return groups

  const result: [ContainerID, Diff | JsonDiff][][] = []
  // Map from ContainerID → index in result where the merged group lives
  const mergeTargets = new Map<ContainerID, number>()

  for (const group of groups) {
    // Only merge single-element groups with a MapDiff
    if (group.length === 1) {
      const [cid, diff] = group[0]
      if (diff.type === "map" && !hasJsonContainerRef(diff)) {
        const existingIdx = mergeTargets.get(cid)
        if (existingIdx !== undefined) {
          // Merge into existing group: combine `updated` records
          const existing = result[existingIdx][0][1] as {
            type: "map"
            updated: Record<string, unknown>
          }
          const incoming = diff as {
            type: "map"
            updated: Record<string, unknown>
          }
          existing.updated = { ...existing.updated, ...incoming.updated }
          continue
        }
        // First MapDiff for this CID — register as a merge target
        // Clone the diff so we can mutate `updated` during merge
        const cloned: [ContainerID, Diff | JsonDiff] = [
          cid,
          { type: "map", updated: { ...(diff as any).updated } } as
            | Diff
            | JsonDiff,
        ]
        mergeTargets.set(cid, result.length)
        result.push([cloned])
        continue
      }
    }
    // Non-mergeable group — pass through
    result.push(group)
  }

  return result
}

/**
 * Check if a MapDiff has any JsonContainerID references (`🦜:` prefix)
 * in its `updated` values. Groups with such references are structured
 * inserts that must stay intact for CID resolution.
 */
function hasJsonContainerRef(diff: Diff | JsonDiff): boolean {
  const updated = (diff as any).updated
  if (!updated) return false
  for (const value of Object.values(updated)) {
    if (typeof value === "string" && value.startsWith("🦜:")) return true
  }
  return false
}

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
  binding?: SchemaBinding,
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

  // Stashed origin from merge for the subscriber to pick up.
  let pendingImportOrigin: string | undefined

  // Lazy-built WritableContext (same pattern as PlainSubstrate).
  let cachedCtx: WritableContext | undefined

  // The Reader — live view over the Loro container tree.
  const reader = loroReader(doc, schema, binding)

  // --- Substrate object ---

  const substrate = {
    [BACKING_DOC]: doc,

    reader: reader,

    baseVersion(): LoroVersion {
      return new LoroVersion(doc.shallowSinceVV())
    },

    advance(_to: LoroVersion): void {
      throw new Error(
        "advance() on a live Loro substrate is not yet supported. " +
          "Use advance() on a LoroReplica instead.",
      )
    },

    prepare(path: Path, change: ChangeBase): void {
      if (!inEventHandler) {
        // Local write: convert Change → Loro Diff, accumulate as a group.
        // No Loro side effects — mutations happen at flush time.
        // Each group must be applied as a single applyDiff() call to
        // preserve JsonContainerID (🦜:) cross-references.
        const group = changeToDiff(path, change, schema, doc, binding)
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
          // Merge single-element MapDiff groups targeting the same
          // ContainerID into one group. This composes N per-leaf replace
          // ops into a single per-container map update — the inverse of
          // expandMapOpsToLeaves on the inbound path.
          const merged = mergePendingGroups(pendingGroups)
          for (const group of merged) {
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
        // Attach nativeResolver — used by interpretImpl to set [NATIVE]
        // on every ref. The resolver maps schema positions to Loro containers.
        ;(cachedCtx as any).nativeResolver = (
          nodeSchema: SchemaNode,
          path: { segments: readonly unknown[] },
        ) => {
          if (path.segments.length === 0) return doc
          if (nodeSchema[KIND] === "scalar" || nodeSchema[KIND] === "sum")
            return undefined
          return resolveContainer(doc, schema, path as any, binding).container
        }
        // Attach positionResolver — used to create and decode LoroPositions
        // backed by Loro Cursors. Resolves the schema path to a LoroText
        // container, then delegates to Cursor-based anchoring.
        ;(cachedCtx as any).positionResolver = (
          _nodeSchema: unknown,
          path: { segments: readonly unknown[] },
        ) => {
          return {
            createPosition(index: number, side: Side) {
              // Resolve path to the LoroText container
              const container = resolveContainer(
                doc,
                schema,
                path as any,
                binding,
              ).container
              if (
                !container ||
                typeof (container as any).getCursor !== "function"
              ) {
                throw new Error(
                  `positionResolver: path does not resolve to a LoroText`,
                )
              }
              const loroSide = toLoroSide(side)
              const cursor = (container as any).getCursor(index, loroSide) as
                | Cursor
                | undefined
              if (!cursor) {
                throw new Error(
                  `positionResolver: getCursor returned undefined at index ${index}`,
                )
              }
              return new LoroPosition(cursor, doc)
            },
            decodePosition(bytes: Uint8Array) {
              const cursor = Cursor.decode(bytes)
              return new LoroPosition(cursor, doc)
            },
          } satisfies PositionCapable
        }
      }
      return cachedCtx
    },

    version(): LoroVersion {
      return new LoroVersion(doc.version())
    },

    exportEntirety(): SubstratePayload {
      return {
        kind: "entirety",
        encoding: "binary",
        data: doc.export({ mode: "snapshot" }),
      }
    },

    exportSince(since: Version): SubstratePayload | null {
      try {
        // ReplicaLike variance: signature uses Version, runtime type is always LoroVersion.
        const bytes = doc.export({
          mode: "update",
          from: (since as LoroVersion).vv,
        })
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
          "LoroSubstrate.merge expects binary-encoded payloads. " +
            "If you recently switched CRDT backends, stale clients may be sending incompatible data.",
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

  doc.subscribe(batch => {
    // Ignore our own commits (changefeed already captured via wrappedPrepare)
    if (batch.by === "local" && inOurCommit) {
      return
    }

    // Ignore checkout events (version travel, not mutations)
    if (batch.by === "checkout") {
      return
    }

    // Map Loro events → kyneta Ops
    const ops = batchToOps(batch, schema, binding)
    if (ops.length === 0) {
      return
    }

    // Determine origin: prefer stashed kyneta origin (from merge),
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

  return substrate as Substrate<LoroVersion>
}

// ---------------------------------------------------------------------------
// loroReplicaFactory — ReplicaFactory<LoroVersion>
// ---------------------------------------------------------------------------

/**
 * Schema-free replica factory for Loro substrates.
 *
 * Constructs headless `Replica<LoroVersion>` instances backed by bare
 * `LoroDoc`s — no schema walking, no container initialization, no
 * Reader, no event bridge, no changefeed. Just the CRDT runtime
 * with version tracking and export/import.
 *
 * Used by conduit participants (stores, routing servers)
 * that need to accumulate state, compute per-peer deltas, and compact
 * storage without ever interpreting document fields.
 */
export function createLoroReplica(doc: LoroDocType): Replica<LoroVersion> {
  let currentDoc = doc

  return {
    get [BACKING_DOC]() {
      return currentDoc
    },

    version(): LoroVersion {
      return new LoroVersion(currentDoc.version())
    },

    baseVersion(): LoroVersion {
      return new LoroVersion(currentDoc.shallowSinceVV())
    },

    advance(to: Version): void {
      const base = this.baseVersion()
      const cmp = base.compare(to)
      if (cmp === "ahead") {
        throw new Error(`advance(): target is behind base version`)
      }
      const cmpCurrent = to.compare(this.version())
      if (cmpCurrent === "ahead") {
        throw new Error(`advance(): target is ahead of current version`)
      }
      // Convert VV to frontiers for the shallow-snapshot API.
      const frontiers = currentDoc.vvToFrontiers((to as LoroVersion).vv)
      // Export a shallow snapshot at the target frontiers.
      const bytes = currentDoc.export({
        mode: "shallow-snapshot",
        frontiers,
      })
      // Create a new doc from the shallow snapshot.
      // LoroDoc.fromSnapshot handles both regular and shallow snapshots.
      currentDoc = LoroDoc.fromSnapshot(bytes)
    },

    exportEntirety(): SubstratePayload {
      return {
        kind: "entirety",
        encoding: "binary",
        data: currentDoc.export({ mode: "snapshot" }),
      }
    },

    exportSince(since: Version): SubstratePayload | null {
      try {
        // The ReplicaLike contract uses the base `Version` type for variance
        // safety. At runtime the synchronizer always passes a LoroVersion from
        // this replica's own factory — the cast is sound.
        const bytes = currentDoc.export({
          mode: "update",
          from: (since as LoroVersion).vv,
        })
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
          "LoroReplica.merge expects binary-encoded payloads. " +
            "If you recently switched CRDT backends, stale clients may be sending incompatible data.",
        )
      }
      currentDoc.import(payload.data)
    },
  } as Replica<LoroVersion>
}

export const loroReplicaFactory: ReplicaFactory<LoroVersion> = {
  replicaType: ["loro", 1, 0] as const,

  createEmpty(): Replica<LoroVersion> {
    return createLoroReplica(new LoroDoc())
  },

  fromEntirety(payload: SubstratePayload): Replica<LoroVersion> {
    if (
      payload.encoding !== "binary" ||
      !(payload.data instanceof Uint8Array)
    ) {
      throw new Error(
        "LoroReplicaFactory.fromEntirety only supports binary-encoded payloads",
      )
    }
    const doc = new LoroDoc()
    doc.import(payload.data)
    return createLoroReplica(doc)
  },

  parseVersion(serialized: string): LoroVersion {
    return LoroVersion.parse(serialized)
  },
}

// ---------------------------------------------------------------------------
// loroSubstrateFactory — SubstrateFactory<LoroVersion>
// ---------------------------------------------------------------------------

/**
 * Factory for constructing Loro-backed substrates.
 *
 * - `create(schema)` — creates a fresh LoroDoc with empty containers
 *   matching the schema structure. No seed data — initial content
 *   should be applied via `change()` after construction.
 * - `fromEntirety(payload, schema)` — creates a LoroDoc from an entirety
 *   payload, returns a substrate.
 * - `parseVersion(serialized)` — deserializes a LoroVersion.
 */
/**
 * Compute a trivial SchemaBinding for a schema (no migration chain).
 * For product schemas, derives identity from field names at generation 1.
 * For non-product schemas, returns empty maps.
 */
function trivialBinding(schema: SchemaNode): SchemaBinding {
  if (schema[KIND] === "product") {
    return deriveSchemaBinding(schema as ProductSchema, {})
  }
  return { forward: new Map(), inverse: new Map() }
}

export const loroSubstrateFactory: SubstrateFactory<LoroVersion> = {
  replica: loroReplicaFactory,

  createReplica(): Replica<LoroVersion> {
    // Default random PeerID — safe for hydration (no local writes).
    return createLoroReplica(new LoroDoc())
  },

  upgrade(
    replica: Replica<LoroVersion>,
    schema: SchemaNode,
  ): Substrate<LoroVersion> {
    const doc = (replica as any)[BACKING_DOC] as LoroDocType
    const binding = trivialBinding(schema)
    // No identity injection for the standalone factory (no peerId).
    // Conditional ensureRootContainer: skip scalar defaults that
    // already exist from hydrated state.
    ensureLoroContainers(doc, schema, true, binding)
    return createLoroSubstrate(doc, schema, binding)
  },

  create(schema: SchemaNode): Substrate<LoroVersion> {
    const doc = new LoroDoc()
    const binding = trivialBinding(schema)
    // Fresh doc — unconditional container creation.
    ensureLoroContainers(doc, schema, false, binding)
    doc.commit()
    return createLoroSubstrate(doc, schema, binding)
  },

  fromEntirety(
    payload: SubstratePayload,
    schema: SchemaNode,
  ): Substrate<LoroVersion> {
    // Two-phase path: createReplica → merge → upgrade
    const replica = this.createReplica()
    replica.merge(payload)
    return this.upgrade(replica, schema)
  },

  parseVersion(serialized: string): LoroVersion {
    return LoroVersion.parse(serialized)
  },
}

// ---------------------------------------------------------------------------
// ensureRootContainer — create root containers without populating values
// ---------------------------------------------------------------------------

/**
 * Walk a schema and ensure all root-level Loro containers exist.
 *
 * Unwraps the root product schema and calls `ensureRootContainer` for
 * each field. When `conditional` is true, scalar/sum defaults are
 * skipped for keys that already exist in the props map (preserving
 * hydrated state). Container-type fields (text, counter, list, map,
 * tree) are always idempotent in Loro — `doc.getText(key)` etc.
 * returns the existing container without generating ops.
 *
 * @param doc - The LoroDoc to prepare
 * @param schema - The root document schema
 * @param conditional - If true, skip scalar defaults for existing keys.
 *   Context: jj:smmulzkm (two-phase substrate construction)
 */
/**
 * Recursively walk a schema tree collecting all RichTextSchema nodes'
 * `.marks` properties into a single MarkConfig. Throws if two richtext
 * fields declare the same mark name with different expand values.
 */
function collectMarkConfigs(schema: SchemaNode): MarkConfig {
  const result: Record<string, { expand: string }> = {}

  function walk(s: SchemaNode): void {
    if (s[KIND] === "richtext") {
      const rt = s as RichTextSchema
      for (const [name, config] of Object.entries(rt.marks)) {
        if (name in result && result[name]!.expand !== config.expand) {
          throw new Error(
            `collectMarkConfigs: mark "${name}" declared with conflicting expand values: "${result[name]!.expand}" vs "${config.expand}"`,
          )
        }
        result[name] = config
      }
    } else if (s[KIND] === "product") {
      for (const fieldSchema of Object.values((s as any).fields)) {
        walk(fieldSchema as SchemaNode)
      }
    } else if (s[KIND] === "sequence" || s[KIND] === "movable") {
      walk((s as any).item)
    } else if (s[KIND] === "map" || s[KIND] === "set") {
      walk((s as any).item)
    } else if (s[KIND] === "tree") {
      walk((s as any).nodeData)
    }
    // scalar, text, counter, sum — no recursion needed (leaves or no richtext children in sums)
  }

  walk(schema)
  return result as MarkConfig
}

export function ensureLoroContainers(
  doc: LoroDocType,
  schema: SchemaNode,
  conditional: boolean,
  binding?: SchemaBinding,
): void {
  // Loro requires configTextStyle() to be called before mark/unmark ops.
  const markConfig = collectMarkConfigs(schema)
  if (Object.keys(markConfig).length > 0) {
    doc.configTextStyle(markConfig as any)
  }

  // The schema is now directly a ProductSchema (no annotation wrapper)
  if (schema[KIND] === "product") {
    for (const [key, fieldSchema] of Object.entries(schema.fields).sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      const identity = binding?.forward.get(key) as string | undefined
      ensureRootContainer(
        doc,
        identity ?? key,
        fieldSchema as SchemaNode,
        conditional,
      )
    }
  }
}

/**
 * Ensure a root-level Loro container exists for a schema field.
 *
 * Loro containers are lazily created — calling `doc.getText(key)` etc.
 * ensures the container is registered. This function walks the schema
 * to create the right container type for each root field, but does NOT
 * populate any values. Initial content should be applied via `change()`
 * after construction.
 *
 * When `conditional` is true, scalar/sum defaults are skipped for keys
 * that already have a value in the props map (preserving hydrated state).
 * Container-type fields are always safe — Loro's `getXxx()` is idempotent.
 */
export function ensureRootContainer(
  doc: LoroDocType,
  key: string,
  fieldSchema: SchemaNode,
  conditional = false,
): void {
  // Dispatch on the schema's [KIND] directly — no annotation unwrapping
  switch (fieldSchema[KIND]) {
    case "text":
    case "richtext":
      doc.getText(key)
      return
    case "counter":
      doc.getCounter(key)
      return
    case "movable":
      doc.getMovableList(key)
      return
    case "tree":
      doc.getTree(key)
      return
    case "set":
    case "product":
      doc.getMap(key)
      return
    case "sequence":
      doc.getList(key)
      return
    case "map":
      doc.getMap(key)
      return
    case "scalar":
    case "sum": {
      // Non-container types live in the shared _props LoroMap.
      // Set the structural zero so the store reader returns type-correct
      // values (e.g. "" not undefined for strings). This is NOT seed
      // data — it's structural completeness, matching what PlainSubstrate
      // does with Zero.structural.
      const propsMap = doc.getMap(PROPS_KEY)
      // When conditional, skip if key already exists from hydrated state
      // (propsMap.set is a real CRDT write that produces ops).
      if (conditional && propsMap.get(key) !== undefined) return
      const zero = Zero.structural(fieldSchema)
      if (zero !== undefined) {
        propsMap.set(key, zero as any)
      }
      return
    }
  }
}
