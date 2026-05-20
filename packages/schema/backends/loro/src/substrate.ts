// substrate — LoroSubstrate implementation.
//
// Implements Substrate<LoroVersion> with:
// - applyDiff-based local writes (prepare accumulates diffs, onFlush applies)
// - Persistent doc.subscribe() event bridge for external changes
// - One re-entrancy guard: `inOurCommit` (suppresses event-bridge
//   reprocessing of commits we just issued ourselves).
//
// The event bridge contract: wrapping a LoroDoc in a kyneta substrate
// means subscribing to the kyneta doc observes ALL mutations to the
// underlying LoroDoc, regardless of source (local kyneta writes,
// merge, external doc.import, external raw Loro API mutations).
//
// `prepare` and `onFlush` accept `BatchOptions` and branch on
// `options?.replay`. The event bridge constructs the replay batch via
// `executeBatch(ctx, ops, { origin, replay: true })`; substrate-side
// work (applyDiff, commit) is skipped when `replay` is true because the
// native LoroDoc already absorbed the change. This makes `prepare` and
// `onFlush` total functions of their declared inputs — no hidden
// ambient state for the substrate-write decision. Context: jj:qpultxsw.

import {
  applyChange,
  BACKING_DOC,
  type BatchOptions,
  buildWritableContext,
  type ChangeBase,
  deriveSchemaBinding,
  executeBatch,
  KIND,
  type MarkConfig,
  type Path,
  type PlainState,
  type PositionCapable,
  type ProductSchema,
  plainReader,
  type Replica,
  type ReplicaFactory,
  type RichTextSchema,
  type SchemaBinding,
  type Schema as SchemaNode,
  type Side,
  type Substrate,
  type SubstrateFactory,
  type SubstratePayload,
  TREE_NODE_ALLOCATE,
  type Version,
  type WritableContext,
} from "@kyneta/schema"
import type {
  ContainerID,
  Diff,
  JsonDiff,
  LoroDoc as LoroDocType,
} from "loro-crdt"
import { Cursor, LoroDoc } from "loro-crdt"
import { batchToOps, changeToDiff } from "./change-mapping.js"
import { resolveContainer } from "./loro-resolve.js"
import { materializeLoroShadow } from "./materialize.js"
import { LoroPosition, toLoroSide } from "./position.js"
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

  // Set true around our own doc.commit() so the subscriber ignores the
  // resulting by:"local" event (changefeed already captured those ops
  // via wrappedPrepare). Orthogonal to BatchOptions.replay, which
  // handles inbound discrimination of replays from local writes.
  let inOurCommit = false

  // Stashed origin from merge for the subscriber to pick up.
  let pendingImportOrigin: string | undefined

  // Lazy-built WritableContext (same pattern as PlainSubstrate).
  let cachedCtx: WritableContext | undefined

  // The shadow — a plain JS object materialized from the LoroDoc.
  // The plainReader is a live view over this object; applyChange keeps
  // it in sync with every mutation (local or replayed).
  const shadow: PlainState = materializeLoroShadow(doc, schema, binding)
  const reader = plainReader(shadow)

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

    prepare(path: Path, change: ChangeBase, options?: BatchOptions): void {
      // Local writes: apply eagerly to the shadow so reads are
      // immediately consistent (the whole point of the shadow).
      // Replay writes: skip — the shadow will be re-materialized
      // from the CRDT doc in onFlush(replay), avoiding
      // double-counting from overlapping structural + leaf diffs.
      if (!options?.replay) {
        applyChange(shadow, path, change)
      }

      if (options?.replay) {
        return
      }
      // Local write: convert Change → Loro Diff, accumulate as a group.
      // No Loro side effects — mutations happen at flush time.
      // Each group must be applied as a single applyDiff() call to
      // preserve JsonContainerID (🦜:) cross-references.
      const group = changeToDiff(path, change, schema, doc, binding)
      if (group.length > 0) {
        pendingGroups.push(group)
      }
    },

    onFlush(options?: BatchOptions): void {
      if (options?.replay) {
        // Loro already committed. Re-materialize the shadow from the
        // CRDT doc so it reflects the merged state. We can't apply
        // replay ops incrementally because batchToOps may emit
        // overlapping structural + leaf diffs that double-count.
        const fresh = materializeLoroShadow(doc, schema, binding)
        for (const key of Object.keys(fresh)) {
          shadow[key] = fresh[key]
        }
        for (const key of Object.keys(shadow)) {
          if (!(key in fresh)) {
            delete shadow[key]
          }
        }
        return
      }
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
      if (options?.origin !== undefined) {
        doc.setNextCommitMessage(options.origin)
      }
      inOurCommit = true
      try {
        doc.commit()
      } finally {
        inOurCommit = false
      }
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
          return resolveContainer(doc, schema, path as any, binding).resolved
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
              const resolved = resolveContainer(
                doc,
                schema,
                path as any,
                binding,
              ).resolved
              if (
                !resolved ||
                typeof (resolved as any).getCursor !== "function"
              ) {
                throw new Error(
                  `positionResolver: path does not resolve to a LoroText`,
                )
              }
              const loroSide = toLoroSide(side)
              const cursor = (resolved as any).getCursor(index, loroSide) as
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
        // Create-then-record. Tree node ids must be peer-stamped for
        // Loro's `tree-move` merge to work, so we materialize the node
        // in Loro state here (during prepare) and let the recorded
        // `TreeInstruction.create` ride through `applyDiff` as a no-op
        // duplicate against the same TreeID.
        ;(cachedCtx as any)[TREE_NODE_ALLOCATE] = (treePath: Path): string => {
          const { resolved } = resolveContainer(doc, schema, treePath, binding)
          if (
            !resolved ||
            typeof (resolved as any).kind !== "function" ||
            (resolved as any).kind() !== "Tree"
          ) {
            throw new Error(
              "TREE_NODE_ALLOCATE: path does not resolve to a LoroTree container",
            )
          }
          const node = (resolved as any).createNode() as { id: string }
          return node.id
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

    merge(payload: SubstratePayload, options?: BatchOptions): void {
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
      pendingImportOrigin = options?.origin
      try {
        doc.import(payload.data)
      } finally {
        pendingImportOrigin = undefined
      }
      // That's it — the doc.subscribe() handler bridges events to the
      // changefeed via executeBatch with `replay: true`.
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

    // `replay: true` tells substrate.prepare/onFlush to skip native-side
    // work (Loro has already absorbed these ops via doc.import) and
    // surfaces on the Changeset for downstream filters (exchange echo).
    executeBatch(ctx, ops, { origin, replay: true })
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

    merge(payload: SubstratePayload, _options?: BatchOptions): void {
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
    ensureLoroContainers(doc, schema, binding)
    return createLoroSubstrate(doc, schema, binding)
  },

  create(schema: SchemaNode): Substrate<LoroVersion> {
    const doc = new LoroDoc()
    const binding = trivialBinding(schema)
    ensureLoroContainers(doc, schema, binding)
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
 * Loro containers are lazily created — `doc.getText(key)`, `doc.getMap(key)`,
 * etc. are idempotent (return the existing container without generating ops).
 * Scalar and sum fields are no-ops — the materializer's zero fallback handles
 * default values on read.
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
      walk((s as any).item)
    }
    // scalar, text, counter, sum — no recursion needed (leaves or no richtext children in sums)
  }

  walk(schema)
  return result as MarkConfig
}

export function ensureLoroContainers(
  doc: LoroDocType,
  schema: SchemaNode,
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
      ensureRootContainer(doc, identity ?? key, fieldSchema as SchemaNode)
    }
  }
}

/**
 * Ensure a root-level Loro container exists for a schema field.
 *
 * Dispatches on [KIND] to call the appropriate Loro container getter.
 * All getters are idempotent — safe to call on fresh or hydrated docs.
 * Scalar and sum fields are no-ops (materializer handles zeros).
 */
export function ensureRootContainer(
  doc: LoroDocType,
  key: string,
  fieldSchema: SchemaNode,
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
    case "sum":
      // Value concerns are handled by the materializer's zero fallback.
      // No CRDT writes needed for non-container types.
      return
  }
}
