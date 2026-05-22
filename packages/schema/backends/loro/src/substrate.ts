// substrate — LoroSubstrate implementation.
//
// Implements Substrate<LoroVersion> with:
// - applyDiff-eager local writes: `prepare` advances both the shadow σ
//   and the native container tree λ (via a coalescing buffer + direct
//   applyDiff dispatch), satisfying the projection law `σ ≡ Π(λ)` at
//   every prepare boundary.
// - `runBatch` brackets the prepare-loop-plus-flush block with a single
//   `doc.commit()` per outermost logical action (depth-counter design;
//   inner re-entrant change()s collapse into the outer commit).
// - `afterBatch` flushes the coalescing buffer on local writes; on
//   replay it re-materialises σ from λ (CRDT merge is a lattice join
//   that has no incremental σ-step decomposition).
// - Persistent doc.subscribe() event bridge for external changes.
// - Own-commit discriminator: a pre-commit-hook discriminator
//   (`subscribePreCommit` captures the in-flight commit's identity;
//   the subscribe handler matches via `batch.to`) prevents the bridge
//   from reprocessing commits we just issued ourselves, leaving the
//   user-facing `batch.origin` slot free for `options.origin` round-trip.
//   Loro's pre-commit hook fires synchronously inside `doc.commit()`,
//   before the subscribe event. A single-shot `nextIsOurs` flag gates
//   the capture (set sync before `doc.commit()`, cleared by pre-commit
//   on its first fire; `finally` sweeps the empty-commit case).
//
// The event bridge contract: wrapping a LoroDoc in a kyneta substrate
// means subscribing to the kyneta doc observes ALL mutations to the
// underlying LoroDoc, regardless of source (local kyneta writes,
// merge, external doc.import, external raw Loro API mutations).
//
// `prepare` and `afterBatch` accept `BatchOptions` and branch on
// `options?.replay`. The event bridge constructs the replay batch via
// `executeBatch(ctx, ops, { origin, replay: true })`; substrate-side
// work (applyDiff, commit) is skipped when `replay` is true because the
// native LoroDoc already absorbed the change. This makes `prepare` and
// `afterBatch` total functions of their declared inputs — no hidden
// ambient state for the substrate-write decision. Context: jj:qpultxsw.

import {
  applyChange,
  BACKING_DOC,
  type BatchOptions,
  buildWritableContext,
  type ChangeBase,
  deepClonePreState,
  deriveSchemaBinding,
  executeBatch,
  findJsonBoundary,
  invert,
  isJsonBoundary,
  KIND,
  type MarkConfig,
  type Path,
  type PlainState,
  type PositionCapable,
  type ProductSchema,
  plainReader,
  RECORD_INVERSE,
  type RecordInverseFn,
  type Replica,
  type ReplicaFactory,
  type RichTextSchema,
  type SchemaBinding,
  type Schema as SchemaNode,
  type Side,
  type Substrate,
  type SubstrateFactory,
  type SubstratePayload,
  syncShadow,
  TREE_NODE_ALLOCATE,
  type Version,
  type WritableContext,
} from "@kyneta/schema"
import type {
  ContainerID,
  Diff,
  JsonDiff,
  LoroDoc as LoroDocType,
  LoroMap,
  Value,
} from "loro-crdt"
import { Cursor, LoroDoc } from "loro-crdt"
import { batchToOps, changeToDiff } from "./change-mapping.js"
import { isLoroContainer } from "./loro-guards.js"
import { PROPS_KEY, resolveContainer } from "./loro-resolve.js"
import { materializeLoroShadow } from "./materialize.js"
import { LoroPosition, toLoroSide } from "./position.js"
import { LoroVersion } from "./version.js"

// ---------------------------------------------------------------------------
// JsonContainerID detection (used by the coalescer to gate structural inserts)
// ---------------------------------------------------------------------------

/**
 * Check if a MapDiff has any JsonContainerID references (`🦜:` prefix)
 * in its `updated` values. Groups with such references are structured
 * inserts that must stay intact for CID resolution — the coalescer
 * routes them to the immediate-apply path with a buffer force-flush.
 */
function hasJsonContainerRef(diff: Diff | JsonDiff): boolean {
  const updated = (diff as any).updated
  if (!updated) return false
  for (const value of Object.values(updated)) {
    if (typeof value === "string" && value.startsWith("🦜:")) return true
  }
  return false
}

/**
 * Detect whether a single-tuple diff group represents a structural
 * insert that introduces new container references into λ. Multi-tuple
 * groups are always structural (additional tuples are the bodies of
 * the inserted containers). Single-tuple groups are structural only
 * if the diff carries a `🦜:` ref — a MapDiff field insertion or a
 * ListDiff insert delta referring to a synthetic container.
 *
 * Used by the coalescer to decide when to force-flush buffered
 * MapDiff state before applying the structural diff (so subsequent
 * prepares' resolveContainer walks land on the up-to-date λ).
 */
function isStructuralGroup(
  group: readonly [ContainerID, Diff | JsonDiff][],
): boolean {
  if (group.length === 0) return false
  if (group.length > 1) return true
  const [, diff] = group[0]
  if (diff.type === "map") return hasJsonContainerRef(diff)
  if (diff.type === "list") {
    const deltas = (diff as any).diff as Array<Record<string, unknown>>
    if (!deltas) return false
    for (const delta of deltas) {
      const inserts = (delta as { insert?: readonly unknown[] }).insert
      if (!inserts) continue
      for (const item of inserts) {
        if (typeof item === "string" && item.startsWith("🦜:")) return true
      }
    }
    return false
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

  // Coalescing buffer for plain MapDiff writes and json-boundary
  // full-value writes. Each entry is a CID-scoped `updated` record
  // (the same shape the underlying MapDiff carries). Inserts are
  // FIFO; flushing iterates in insertion order so any prior state
  // lands before downstream structural inserts that may build on it.
  //
  // Buffer entries hold the σ-derived value at the boundary key
  // (which, for json-boundary writes, is the entire subtree as a
  // plain JSON object — see Phase 1a). Last-write-wins per `key`
  // within a CID — re-entrant writes overwrite earlier same-key
  // entries by spread semantics.
  const coalesceBuffer = new Map<ContainerID, Record<string, unknown>>()

  // Own-commit discriminator. Loro fires `doc.subscribe` events
  // synchronously inside `doc.commit()`, with nested events from
  // re-entrant commits queued and drained after the current handler
  // exits but still inside the outer commit call. We discriminate via
  // the CRDT's own event machinery (per-commit identity captured in
  // `subscribePreCommit`) rather than via the user-facing `batch.origin`
  // slot, which is reserved for `options.origin` round-trip.
  //
  // `nextIsOurs` is set true synchronously before each `doc.commit()`
  // we issue and cleared by the pre-commit hook on its first fire — it
  // has a single-statement lifetime, no re-entrancy window. The `finally`
  // in runBatch sweeps the empty-commit case (where pre-commit never
  // fires; verified by probe — see TECHNICAL.md "Why pre-commit hook").
  let nextIsOurs = false

  // Pending own-commit identities: `${peer}:${counter+length-1}`
  // matches the tail entry of `batch.to` for the corresponding event.
  const ourCommits = new Set<string>()

  // Stashed origin from merge for the subscriber to pick up.
  let pendingImportOrigin: string | undefined

  // Lazy-built WritableContext (same pattern as PlainSubstrate).
  let cachedCtx: WritableContext | undefined

  // The shadow — a plain JS object materialized from the LoroDoc.
  // The plainReader is a live view over this object; applyChange keeps
  // it in sync with every mutation (local or replayed).
  const shadow: PlainState = materializeLoroShadow(doc, schema, binding)
  const reader = plainReader(shadow)

  // --- Coalescer helpers ---

  /**
   * Merge a `{ key → value }` map into the buffered `updated` record
   * for `cid`. Spread semantics → last write wins per key.
   */
  function coalesceMapDiff(
    cid: ContainerID,
    updated: Record<string, unknown>,
  ): void {
    const existing = coalesceBuffer.get(cid)
    if (existing) {
      Object.assign(existing, updated)
    } else {
      // Clone so the buffer owns its mutation surface (the source
      // diff may be reused by future coalesces of the same shape).
      coalesceBuffer.set(cid, { ...updated })
    }
  }

  /**
   * Flush every buffered MapDiff to the LoroDoc via `applyDiff` and
   * clear the buffer. Order: insertion order (FIFO) so prerequisite
   * state lands before any structural insert depending on it.
   */
  function flushCoalesceBuffer(): void {
    if (coalesceBuffer.size === 0) return
    for (const [cid, updated] of coalesceBuffer) {
      doc.applyDiff([[cid, { type: "map", updated } as any]] as any)
    }
    coalesceBuffer.clear()
  }

  /**
   * Compute the identity-aware key (or numeric index) at the boundary
   * segment. Field segments inside a bound product get identity-keyed
   * via the SchemaBinding; entry segments (record keys, set members,
   * tree node ids) and index segments pass their raw resolution
   * through.
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
   * Apply a json-boundary write at `path` whose boundary value (the
   * entire subtree under the JSON boundary segment) is already in σ
   * after `applyChange`.
   *
   * Map-parent boundaries (struct fields, record entries) coalesce
   * into the buffered MapDiff keyed by their parent CID — repeated
   * writes inside the same subtree collapse into one `applyDiff` at
   * flush. List-parent boundaries (sequence/movable items whose
   * element schema is `struct.json` / `list.json`) flush the buffer
   * and apply a ListDiff replace immediately, since ListDiffs cannot
   * be coalesced via spread semantics. Both paths leave σ ≡ Π(λ)
   * after the next applyDiff lands.
   */
  function applyJsonBoundaryWrite(path: Path, prefixLength: number): void {
    const parentPath = path.slice(0, prefixLength)
    const { resolved: parentResolved } = resolveContainer(
      doc,
      schema,
      parentPath,
      binding,
    )
    const boundaryPath = path.slice(0, prefixLength + 1)
    const value = boundaryPath.read(shadow)
    const key = boundaryKey(path, prefixLength)

    if (isLoroContainer(parentResolved)) {
      const kind = parentResolved.kind()
      if (kind === "Map") {
        coalesceMapDiff(parentResolved.id, {
          [String(key)]: value as Value,
        })
        return
      }
      if (kind === "List" || kind === "MovableList") {
        // ListDiff replace at the boundary index. Coalescing via the
        // map buffer doesn't apply (list deltas are positional retain/
        // delete/insert sequences, not key-addressed updates) — flush
        // any buffered MapDiffs first so observable λ stays in step.
        flushCoalesceBuffer()
        const index = key as number
        const deltas: Array<Record<string, unknown>> = []
        if (index > 0) deltas.push({ retain: index })
        deltas.push({ delete: 1 })
        deltas.push({ insert: [value] })
        doc.applyDiff([
          [parentResolved.id, { type: "list", diff: deltas } as any],
        ] as any)
        return
      }
      throw new Error(
        `loro substrate: json-boundary write to unsupported parent kind "${kind}" at path ${path.format()}`,
      )
    }

    // Parent is the LoroDoc root — json-boundary root fields live in
    // the shared `_props` LoroMap (symmetric with root scalars).
    const propsCid = (doc.getMap(PROPS_KEY) as LoroMap).id as ContainerID
    coalesceMapDiff(propsCid, { [String(key)]: value as Value })
  }

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
      // Replay writes: the native LoroDoc has already absorbed these
      // ops via doc.import; skip σ/λ advance — afterBatch(replay)
      // rebuilds σ from λ in one Π pass.
      if (options?.replay) return

      // Inverse recording under the normal handler. Capture σ at the
      // target path before applyChange mutates the shadow; the
      // recording closure pushes onto the active runBatch frame's
      // stack. Skipped under the undo-replay handler (compensating).
      // For json-boundary writes the inverse is computed against the
      // value at the change's target path inside the σ subtree — when
      // the bracket later replays it under `compensating: true`, σ and
      // λ both revert (naturality of Π over invert).
      const record = (
        options as
          | (BatchOptions & { [RECORD_INVERSE]?: RecordInverseFn })
          | undefined
      )?.[RECORD_INVERSE]
      if (record && !options?.compensating) {
        const pre = deepClonePreState(path.read(shadow))
        const inverse = invert(pre, change)
        record(path, inverse)
      }

      // Local write — σ advances eagerly so reads are immediately
      // consistent regardless of where λ is in the bracket.
      applyChange(shadow, path, change)

      // JSON-boundary write: every write targeting a path that
      // crosses a struct.json/list.json/record.json boundary is
      // staged as a full-value write at the boundary segment in the
      // parent CRDT container — using a MapDiff for map-shaped
      // parents (coalesces with sibling writes) or a ListDiff
      // replace for list-shaped parents (cannot coalesce via spread
      // semantics; force-flushes any buffered MapDiffs first).
      const boundary = findJsonBoundary(schema, path, binding)
      if (boundary !== null) {
        applyJsonBoundaryWrite(path, boundary.prefixLength)
        return
      }

      // Non-boundary write — translate to a Loro diff group.
      const group = changeToDiff(path, change, schema, doc, binding)
      if (group.length === 0) return

      // Coalescable plain MapDiff: merge into the buffer. The
      // multi-key struct mutation pattern (`d.struct.a.set(1);
      // d.struct.b.set(2)`) collapses into one applyDiff at flush
      // time.
      if (group.length === 1) {
        const [cid, diff] = group[0]
        if (diff.type === "map" && !hasJsonContainerRef(diff)) {
          const updated = (diff as { updated: Record<string, unknown> }).updated
          coalesceMapDiff(cid, updated)
          return
        }
      }

      // Structural inserts (multi-tuple groups, or single tuples
      // carrying `🦜:` references) introduce new container refs into
      // λ that subsequent prepares' resolveContainer walks may land
      // on. Force-flush the coalesced MapDiffs first so observable λ
      // is up to date before the structural diff lands.
      if (isStructuralGroup(group)) {
        flushCoalesceBuffer()
      }
      doc.applyDiff(group as any)
    },

    afterBatch(options?: BatchOptions): void {
      if (options?.replay) {
        // CRDT merge is a lattice join — `batchToOps` may emit
        // overlapping structural + leaf diffs whose sequential σ-step
        // composition would double-count. Re-materialise σ from λ in
        // one Π pass instead.
        syncShadow(shadow, materializeLoroShadow(doc, schema, binding))
        return
      }
      // Local write: drain the coalescing buffer. `runBatch` owns the
      // commit boundary — we apply diffs here but do NOT commit.
      flushCoalesceBuffer()
    },

    runBatch(work: () => void, options?: BatchOptions): void {
      // Ctx-level outermost detection (frameStarts.length === 0)
      // means substrate.runBatch is invoked at most once per outermost
      // change(doc, fn). No per-substrate depth counter needed.
      nextIsOurs = true
      try {
        work()
        doc.commit(
          options?.origin !== undefined
            ? { origin: options.origin }
            : undefined,
        )
      } finally {
        // Empty-commit safety: if no event fired (probe-verified
        // behavior), pre-commit never cleared the flag. This ensures a
        // subsequent external raw commit doesn't get misclassified.
        nextIsOurs = false
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
        // Create-then-record. The pattern this once pioneered — eager
        // native mutation during prepare — is now universal across the
        // substrate write path (applyDiff-eager prepare + coalescing
        // buffer; see the module-doc header). Tree node ids retain
        // their own niche because they must be peer-stamped for
        // Loro's `tree-move` merge to work: we materialize the node
        // here so the id we hand back to the kyneta interpreter is
        // identical to the one Loro persists.
        //
        // Position-at-allocation: `LoroTree.createNode(parent, index)`
        // accepts a parent TreeID and index directly. Passing them in
        // up-front avoids a subsequent applyDiff `create` against the
        // same TreeID with a different parent (Loro panics with a
        // locking-order violation on that path — see `treeChangeToDiff`
        // for the diff-side filter that drops the redundant create).
        ;(cachedCtx as any)[TREE_NODE_ALLOCATE] = (
          treePath: Path,
          parent?: string | null,
          index?: number,
        ): string => {
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
          const node = (resolved as any).createNode(
            parent ?? undefined,
            index,
          ) as { id: string }
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

  doc.subscribePreCommit(e => {
    // We set nextIsOurs true synchronously before work() in runBatch.
    // Loro's exportSince() (called by Exchange sync during ctx.flush() inside work())
    // triggers an implicit commit. Setting this flag early ensures we capture
    // that implicit commit's identity. We clear it on first fire to prevent
    // any subsequent raw external commits from being misclassified.
    if (nextIsOurs) {
      const tail = e.changeMeta.counter + e.changeMeta.length - 1
      ourCommits.add(`${e.changeMeta.peer}:${tail}`)
      nextIsOurs = false
    }
  })

  doc.subscribe(batch => {
    // We consume the captured identity via delete-as-predicate. This immediately
    // cleans up the Set on match, preventing memory leaks. Local batches always
    // have a single entry in batch.to representing the peer's new counter, but
    // iterating is robust to any future Loro version vector changes.
    if (batch.by === "local") {
      for (const f of batch.to) {
        if (ourCommits.delete(`${f.peer}:${f.counter}`)) return
      }
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

    // `replay: true` tells substrate.prepare/afterBatch to skip native-side
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
  // JSON-boundary root fields (struct.json/list.json/record.json) are
  // stored as a single plain JSON value in the shared _props LoroMap.
  // No typed root container is created; the materialiser's zero
  // fallback covers absent boundaries, and the first write materialises
  // the value via `_props.set(key, plainValue)`.
  if (isJsonBoundary(fieldSchema)) return
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
