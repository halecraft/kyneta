// substrate — LoroSubstrate implementation.
//
// Implements Substrate<LoroVersion> with:
// - applyDiff-eager local writes: `prepare` advances both the shadow σ
//   and the native container tree λ (via a coalescing buffer + direct
//   applyDiff dispatch), satisfying the projection law `σ ≡ Π(λ)` at
//   every prepare boundary.
// - `runBatch` brackets the prepare-loop-plus-flush block with a single
//   `doc.commit()` per outermost logical action. A `batch()` a subscriber
//   issues runs after that commit, as its own.
// - `afterBatch` flushes the coalescing buffer.
// - Persistent doc.subscribe() event bridge for external changes: it
//   re-materialises σ from λ (CRDT merge is a lattice join that has no
//   incremental σ-step decomposition), then announces the ops.
// - Own-commit discriminator: a pre-commit-hook discriminator
//   (`subscribePreCommit` captures the in-flight commit's identity;
//   the subscribe handler matches via `batch.to`) prevents the bridge
//   from reprocessing commits we just issued ourselves, leaving the
//   user-facing `batch.origin` slot free for `options.origin` round-trip.
//   Loro's pre-commit hook fires synchronously inside `doc.commit()`,
//   before the subscribe event. Every commit from the start of `work()`
//   through the pre-commit of `runBatch`'s final commit is ours.
// - Undo (`revertible`, from `./revertible.js`): the pre-commit hook gives
//   each local commit's frontiers, and the bridge reports the commit. An
//   undo is applied with `applyDiff` through `commitNative`, whose origin
//   and echo token the bridge carries onto its local announcement.
//
// The event bridge contract: wrapping a LoroDoc in a kyneta substrate
// means subscribing to the kyneta doc observes ALL mutations to the
// underlying LoroDoc, regardless of source (local kyneta writes,
// merge, external doc.import, external raw Loro API mutations).
//
// `prepare` and `afterBatch` see only Kyneta's own writes. The event bridge
// handles everything else: the LoroDoc already holds those ops, so it brings
// σ up to date and announces them via `ctx.announce`, which never calls back
// into `prepare`. An announcement is `local` iff its batch is: a native write
// on this peer is not a replay.

import {
  applyChange,
  BACKING_DOC,
  type BatchOutcome,
  buildWritableContext,
  type ChangeBase,
  type CommitOptions,
  containerKey,
  createMaterializeInterpreter,
  DEFAULT_LINEAGE,
  DEVTOOLS_HISTORY,
  type DevtoolsHistory,
  type DevtoolsHistorySummary,
  deriveSchemaBinding,
  fieldAbsPath,
  findOpaqueBoundary,
  freezePayload,
  hasBackingDoc,
  invert,
  isJsonBoundary,
  isMapSchema,
  isMovableSchema,
  isProductSchema,
  isSequenceSchema,
  isSetSchema,
  isTreeSchema,
  KIND,
  type MapChange,
  type MarkConfig,
  type MergeOptions,
  type Path,
  type PositionCapable,
  type ProductSchema,
  plainReader,
  planAdvance,
  planReconcile,
  type RecordInverseFn,
  type Replica,
  type ReplicaFactory,
  type RichTextSchema,
  reconcileShadow,
  type SchemaBinding,
  type Schema as SchemaNode,
  type Side,
  type StateCell,
  type Substrate,
  type SubstrateFactory,
  type SubstratePayload,
  touchedBy,
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
import {
  applyDiffGroup,
  isLoroContainer,
  isLoroText,
  isLoroTree,
  listDiffDeltas,
  mapDiffUpdated,
} from "./loro-guards.js"
import { PROPS_KEY, resolveContainer } from "./loro-resolve.js"
import { createLoroResolver, materializeLoroShadow } from "./materialize.js"
import { LoroPosition, toLoroSide } from "./position.js"
import { createLoroRevertible } from "./revertible.js"
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
  const updated = mapDiffUpdated(diff)
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
    const deltas = listDiffDeltas(diff)
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
 * registered at construction time. Every change this substrate's
 * `runBatch` did not commit (an import, or a commit on the LoroDoc from an
 * editor binding or another substrate) is announced to the kyneta
 * changefeed, with `replay: false` iff Loro reports it as local. A root
 * container the schema does not declare is not announced, but
 * `subscribeLocalUpdates` still reports writes to it.
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
  // Which commits are ours. `runBatch` sets "open" before `work()`: any
  // commit inside it (an implicit one from an `export` or `import` in a
  // `batch()` body) carries Kyneta's ops. It sets "closing" just before its
  // final commit, whose pre-commit returns this to "off", so commits made by
  // raw listeners reacting to that commit are announced. An empty final
  // commit fires no pre-commit (see TECHNICAL.md "Why the pre-commit
  // hook"), so `runBatch`'s `finally` also returns it to "off".
  let capture: "off" | "open" | "closing" = "off"

  // Pending own-commit identities: `${peer}:${counter+length-1}`
  // matches the tail entry of `batch.to` for the corresponding event.
  const ourCommits = new Set<string>()

  // The merge's origin, for the event bridge to put on the import's batch.
  // `doc.import` takes no origin of its own.
  let pendingImportOrigin: string | undefined

  // A native commit a local caller asked for (an undo's `applyDiff`): the
  // bridge announces it, carrying the caller's origin and echo token.
  let pendingNative: CommitOptions | undefined

  // The outcome of the authored batch whose commit is closing, for undo.
  let authoredOutcome: BatchOutcome | undefined

  const revertible = createLoroRevertible({
    doc: doc as unknown as LoroDoc,
    schema,
    commitNative(work, options) {
      pendingNative = options
      try {
        work()
        doc.commit(
          options.origin !== undefined ? { origin: options.origin } : undefined,
        )
      } finally {
        pendingNative = undefined
      }
    },
  })

  // Lazy-built WritableContext (same pattern as PlainSubstrate).
  let cachedCtx: WritableContext | undefined

  // The shadow: a plain JS object materialized from the LoroDoc, in a cell
  // the reader reads through. `prepare` steps it for local writes; the event
  // bridge reconciles it for everything else.
  const shadow: StateCell = {
    current: materializeLoroShadow(doc, schema, binding),
  }
  // What the event bridge re-materializes σ's touched parts through.
  const resolver = createLoroResolver(doc, schema, binding)
  const materializer = createMaterializeInterpreter(resolver)
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
      applyDiffGroup(doc, [[cid, { type: "map", updated }]])
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
    const seg = path.segments[prefixLength]
    if (seg === undefined) {
      throw new Error(
        `boundaryKey: no segment at ${prefixLength} in a path of ${path.length}`,
      )
    }
    if (seg.role === "field") {
      const absPath = fieldAbsPath(path.segments.slice(0, prefixLength + 1))
      return containerKey(binding, absPath, seg.resolve() as string)
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
    const value = boundaryPath.read(shadow.current)
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
        applyDiffGroup(doc, [
          [parentResolved.id, { type: "list", diff: deltas }],
        ])
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
    [DEVTOOLS_HISTORY]: loroDevtoolsHistory(() => doc),

    reader: reader,

    baseVersion(): LoroVersion {
      return new LoroVersion(doc.shallowSinceVV())
    },

    /**
     * Trims nothing, and throws only for a `to` beyond the current version.
     * Trimming means importing a shallow snapshot into a new `LoroDoc`, as
     * the replica does, which would strand every native container editor
     * bindings and `unwrap` callers hold.
     */
    advance(to: Version): void {
      const plan = planAdvance({
        base: this.baseVersion(),
        current: this.version(),
        to,
      })
      if (plan === "beyond") {
        throw new Error("advance(): target is ahead of current version")
      }
    },

    prepare(
      path: Path,
      change: ChangeBase,
      recordInverse: RecordInverseFn | null,
    ): void {
      // Capture σ at the target path before applyChange mutates the shadow.
      // For json-boundary writes the inverse is computed against the value
      // at the change's target path inside the σ subtree — when the bracket
      // later applies it as a compensation, σ and λ both revert (naturality
      // of Π over invert).
      if (recordInverse) {
        // Read, don't copy. `invert` owns whatever it retains (`own`): a
        // value a read froze is shared, since no write can change it, and
        // anything else is copied.
        recordInverse(invert(path.read(shadow.current), change))
      }

      // Local write — σ advances eagerly so reads are immediately
      // consistent regardless of where λ is in the bracket. The writable
      // context completed the change, so σ and λ take the same value.
      applyChange(shadow, path, freezePayload(change))

      // JSON-boundary write: every write targeting a path that
      // crosses a struct.json/list.json/record.json boundary is
      // staged as a full-value write at the boundary segment in the
      // parent CRDT container — using a MapDiff for map-shaped
      // parents (coalesces with sibling writes) or a ListDiff
      // replace for list-shaped parents (cannot coalesce via spread
      // semantics; force-flushes any buffered MapDiffs first).
      const boundary = findOpaqueBoundary(schema, path, binding)
      if (boundary !== null) {
        applyJsonBoundaryWrite(path, boundary.prefixLength)
        return
      }

      // A clear removes the keys the container holds, so buffered writes
      // to it have to be in λ first, or the clear misses keys σ has.
      if (change.type === "map" && (change as MapChange).clear) {
        flushCoalesceBuffer()
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
      applyDiffGroup(doc, group)
    },

    afterBatch(outcome: BatchOutcome): void {
      // Drain the coalescing buffer. `runBatch` owns the commit
      // boundary — we apply diffs here but do NOT commit.
      flushCoalesceBuffer()
      authoredOutcome = outcome
    },

    revertible,

    runBatch(work: () => void, options: CommitOptions): void {
      // Ctx-level outermost detection (frameStarts.length === 0)
      // means substrate.runBatch is invoked at most once per outermost
      // batch(doc, fn). No per-substrate depth counter needed.
      capture = "open"
      try {
        try {
          work()
        } finally {
          // Commit even when `work` threw: the batch's compensations are
          // pending, and left uncommitted they would join the next commit
          // under the next batch's origin.
          capture = "closing"
          doc.commit(
            options.origin !== undefined
              ? { origin: options.origin }
              : undefined,
          )
        }
      } finally {
        capture = "off"
      }
    },

    subscribeLocalUpdates(listener: () => void): () => void {
      // Fires inside every commit of local ops, explicit or implicit (an
      // `export`, or an `import` with pending ops), and never for imported
      // ops.
      return doc.subscribeLocalUpdates(() => listener())
    },

    commitPending(): void {
      // A native commit like any other: the event bridge announces it and
      // `subscribeLocalUpdates` fires. Inside an open `batch()` body it is the
      // same implicit commit an `export` there would make.
      if (doc.getPendingTxnLength() > 0) doc.commit()
    },

    context(): WritableContext {
      if (!cachedCtx) {
        cachedCtx = buildWritableContext(substrate, schema, {
          nativeResolver: (
            nodeSchema: SchemaNode,
            path: { segments: readonly unknown[] },
          ) => {
            if (path.segments.length === 0) return doc
            if (nodeSchema[KIND] === "scalar" || nodeSchema[KIND] === "sum")
              return undefined
            // The substrate capability interfaces declare this callback's
            // `path` structurally (`{ segments: readonly unknown[] }`) so they
            // stay substrate-agnostic and do not depend on `Path`. The value
            // really is a `Path`; the assertion recovers what the interface
            // deliberately does not state.
            return resolveContainer(doc, schema, path as any, binding).resolved
          },
          positionResolver: (
            _nodeSchema: unknown,
            path: { segments: readonly unknown[] },
          ) => {
            return {
              createPosition(index: number, side: Side) {
                // Resolve path to the LoroText container
                // Structurally-declared `path` — see the note above.
                const resolved = resolveContainer(
                  doc,
                  schema,
                  path as any,
                  binding,
                ).resolved
                if (!isLoroText(resolved)) {
                  throw new Error(
                    `positionResolver: path does not resolve to a LoroText`,
                  )
                }
                const loroSide = toLoroSide(side)
                const cursor = resolved.getCursor(index, loroSide) as
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
          },
          treeNodeAllocate: (
            treePath: Path,
            parent?: string | null,
            index?: number,
          ): string => {
            const { resolved } = resolveContainer(
              doc,
              schema,
              treePath,
              binding,
            )
            if (!isLoroTree(resolved)) {
              throw new Error(
                "TREE_NODE_ALLOCATE: path does not resolve to a LoroTree container",
              )
            }
            return resolved.createNode(parent ?? undefined, index).id
          },
        })
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
        lineage: DEFAULT_LINEAGE,
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

    merge(payload: SubstratePayload, options?: MergeOptions): void {
      if (
        payload.encoding !== "binary" ||
        !(payload.data instanceof Uint8Array)
      ) {
        throw new Error(
          "LoroSubstrate.merge expects binary-encoded payloads. " +
            "If you recently switched CRDT backends, stale clients may be sending incompatible data.",
        )
      }
      pendingImportOrigin = options?.origin
      try {
        doc.import(payload.data)
      } finally {
        pendingImportOrigin = undefined
      }
      // The doc.subscribe() handler announces the merged ops. Loro holds back
      // imported ops whose dependencies are missing; the version stays short
      // of the offer's, which is how a caller sees what is missing.
    },

    resetFromEntirety(payload: SubstratePayload, options?: MergeOptions): void {
      // Loro never mints a new lineage automatically (see LoroVersion.lineage),
      // so an lineage boundary never arises for this substrate today — this
      // exists to satisfy the Substrate contract. CRDT merge (doc.import)
      // is a idempotent, commutative set union; unlike Plain, there is no
      // "discard local history" step to perform — union is always the
      // correct absorption for an oplog CRDT, lineage boundary or not.
      substrate.merge(payload, options)
    },
  }

  // --- Event bridge (registered once at construction) ---

  doc.subscribePreCommit(e => {
    revertible.committing(e.changeMeta)
    if (capture === "off") return
    const tail = e.changeMeta.counter + e.changeMeta.length - 1
    ourCommits.add(`${e.changeMeta.peer}:${tail}`)
    if (capture === "closing") capture = "off"
  })

  doc.subscribe(batch => {
    // We consume the captured identity via delete-as-predicate. This immediately
    // cleans up the Set on match, preventing memory leaks. Local batches always
    // have a single entry in batch.to representing the peer's new counter, but
    // iterating is robust to any future Loro version vector changes.
    if (batch.by === "local") {
      for (const f of batch.to) {
        if (ourCommits.delete(`${f.peer}:${f.counter}`)) {
          const outcome = authoredOutcome
          authoredOutcome = undefined
          revertible.committed(f, outcome?.ops ?? [], outcome?.aborted ?? false)
          return
        }
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

    // The merge's origin belongs to the import alone. `import` commits pending
    // native ops first, and that commit is a local batch with its own origin.
    const origin =
      batch.by === "import"
        ? (pendingImportOrigin ?? batch.origin)
        : batch.origin

    // Undo records a direct local commit as it would an authored one.
    if (batch.by === "local") {
      const peer = doc.peerIdStr
      const tail = batch.to.find(f => f.peer === peer)
      if (tail !== undefined) revertible.committed(tail, ops, false)
    }

    // Lazily ensure the context is built
    const ctx = substrate.context()

    // The LoroDoc already holds these ops. `batchToOps` may emit
    // overlapping structural + leaf diffs whose sequential σ-step
    // composition would double-count, so σ is re-materialised from λ where
    // the ops touched it, and only then announced.
    reconcileShadow(
      shadow,
      planReconcile(schema, touchedBy(ops)),
      resolver,
      materializer,
    )
    const local = batch.by === "local"
    ctx.announce(ops, {
      origin:
        local && pendingNative !== undefined ? pendingNative.origin : origin,
      local,
      source: local ? pendingNative?.source : undefined,
    })
  })

  return substrate
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
// ---------------------------------------------------------------------------
// DevTools history capability (pull) — version/op summary + safe time-travel
// ---------------------------------------------------------------------------

/**
 * Build the `DevtoolsHistory` capability over a LoroDoc accessor. `getDoc`
 * is a thunk because the replica swaps its backing doc on `advance()`.
 */
function loroDevtoolsHistory(getDoc: () => LoroDocType): DevtoolsHistory {
  return {
    summary(): DevtoolsHistorySummary {
      const d = getDoc()
      const actors: Record<string, number> = {}
      for (const [peer, counter] of d.version().toJSON()) {
        actors[String(peer)] = counter
      }
      return {
        version: new LoroVersion(d.version()).serialize(),
        opCount: d.opCount(),
        actors,
      }
    },
    // Time-travel WITHOUT mutating the live doc: fork an independent copy,
    // check the fork out to the target version's frontiers, read its value.
    valueAt(version: string): unknown {
      const target = LoroVersion.parse(version)
      const fork = getDoc().fork()
      fork.checkout(fork.vvToFrontiers(target.vv))
      return fork.toJSON()
    },
  }
}

export function createLoroReplica(doc: LoroDocType): Replica<LoroVersion> {
  let currentDoc = doc

  return {
    get [BACKING_DOC]() {
      return currentDoc
    },
    [DEVTOOLS_HISTORY]: loroDevtoolsHistory(() => currentDoc),

    version(): LoroVersion {
      return new LoroVersion(currentDoc.version())
    },

    baseVersion(): LoroVersion {
      return new LoroVersion(currentDoc.shallowSinceVV())
    },

    advance(to: Version): void {
      const plan = planAdvance({
        base: this.baseVersion(),
        current: this.version(),
        to,
      })
      if (plan === "beyond") {
        throw new Error("advance(): target is ahead of current version")
      }
      if (plan === "nothing") return
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
        lineage: DEFAULT_LINEAGE,
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

    merge(payload: SubstratePayload, _options?: MergeOptions): void {
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

    resetFromEntirety(payload: SubstratePayload, options?: MergeOptions): void {
      // See createLoroSubstrate's resetFromEntirety — CRDT merge (set
      // union via doc.import) is always the correct absorption, lineage
      // boundary or not, so this delegates to the routine merge path.
      this.merge(payload, options)
    },
  } as Replica<LoroVersion>
}

export const loroReplicaFactory: ReplicaFactory<LoroVersion> = {
  replicaType: ["loro", 1, 0] as const,
  historyFree: false,

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
 *   should be applied via `batch()` after construction.
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
    if (!hasBackingDoc<LoroDocType>(replica)) {
      throw new Error("upgrade() requires a replica produced by this factory.")
    }
    const doc = replica[BACKING_DOC]
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
// Root containers — created up front, never populated
// ---------------------------------------------------------------------------

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
        const prior = result[name]
        if (prior !== undefined && prior.expand !== config.expand) {
          throw new Error(
            `collectMarkConfigs: mark "${name}" declared with conflicting expand values: "${prior.expand}" vs "${config.expand}"`,
          )
        }
        result[name] = config
      }
    } else if (isProductSchema(s)) {
      for (const fieldSchema of Object.values(s.fields)) {
        walk(fieldSchema)
      }
    } else if (isSequenceSchema(s) || isMovableSchema(s)) {
      walk(s.item)
    } else if (isMapSchema(s) || isSetSchema(s)) {
      walk(s.item)
    } else if (isTreeSchema(s)) {
      walk(s.item)
    }
    // scalar, text, counter, sum — no recursion needed (leaves or no richtext children in sums)
  }

  walk(schema)
  return result as MarkConfig
}

/**
 * Walk a schema and ensure all root-level Loro containers exist.
 *
 * Loro containers are lazily created — `doc.getText(key)`, `doc.getMap(key)`,
 * etc. are idempotent (return the existing container without generating ops).
 * Scalar and sum fields are no-ops — the materializer's zero fallback handles
 * default values on read.
 */
export function ensureLoroContainers(
  doc: LoroDocType,
  schema: SchemaNode,
  binding?: SchemaBinding,
): void {
  // Loro requires configTextStyle() to be called before mark/unmark ops.
  const markConfig = collectMarkConfigs(schema)
  if (Object.keys(markConfig).length > 0) {
    // `loro-crdt` types `configTextStyle` against its own mark-config shape.
    // Kyneta's `MarkConfig` is the same record of `{ expand }` entries under a
    // different declaration, with no runtime conversion to do.
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
