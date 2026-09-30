// substrate — YjsSubstrate implementation.
//
// Implements Substrate<YjsVersion> with:
// - Imperative-eager local writes: `prepare` advances both the shadow σ
//   AND the native Y.Doc tree λ inside the ambient `Y.transact` opened
//   by `runBatch`. The projection law `σ ≡ Π(λ)` holds at every prepare
//   boundary.
// - `runBatch(body)` opens one `Y.transact(doc, body, options.origin)` per
//   outermost logical action, so external `observeDeep` consumers see
//   exactly one batched event per outermost `batch(doc, fn)`. Kyneta
//   subscribers run after the transaction closes, so a `batch()` they issue
//   is a transaction of its own.
// - JSON-boundary writes (struct.json/list.json/record.json subtrees)
//   are buffered in a per-target-key coalescer and flushed in
//   `afterBatch`. Non-boundary writes are applied directly to λ via
//   `applyChangeToYjs`.
// - `afterBatch` flushes the json-boundary coalescer.
// - Persistent observeDeep event bridge for external changes: it
//   re-materialises σ from λ, then announces the ops.
// - Per-transaction meta mark (`KYNETA_MARK`, one per substrate) inscribed
//   from inside the transact body to ignore our own writes; survives Yjs's
//   nested-transact collapse so external wrapping is handled correctly.
// - Undo (`revertible`, from `./undo/revertible.js`): `prepare`, `afterBatch` and
//   the bridge feed it what each local transaction did, the bridge before
//   it re-materialises σ, so a direct write's inverse is read from the state
//   before it.
//
// The event bridge contract: wrapping a Y.Doc in a kyneta substrate
// means subscribing to the kyneta doc observes ALL mutations to the
// underlying Y.Doc, regardless of source (local kyneta writes,
// merge, external Y.applyUpdate, external raw Yjs API mutations).
//
// `prepare` and `afterBatch` see only Kyneta's own writes. The event bridge
// handles everything else: the Y.Doc already holds those ops, so it brings σ
// up to date and announces them via `ctx.announce`, which never calls back
// into `prepare`. An announcement is `local` iff its transaction is: a native
// write on this peer is not a replay.
//
// Identity-keying: when a SchemaBinding is provided, all Y.Map key
// lookups and writes use the identity hash instead of the field name.
// The binding is threaded to the reader, event bridge, and write path.

import type {
  BatchOutcome,
  ChangeBase,
  CommitOptions,
  MergeOptions,
  Path,
  PlainState,
  PositionCapable,
  ProductSchema,
  Reader,
  RecordInverseFn,
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
  containerKey,
  DEFAULT_LINEAGE,
  DEVTOOLS_HISTORY,
  type DevtoolsHistory,
  type DevtoolsHistorySummary,
  deriveSchemaBinding,
  fieldAbsPath,
  findOpaqueBoundary,
  hasBackingDoc,
  invert,
  KIND,
  ownedForStore,
  plainReader,
  planAdvance,
  syncShadow,
} from "@kyneta/schema"
import * as Y from "yjs"
import { applyChangeToYjs, eventsToOps } from "./change-mapping.js"
import { materializeYjsShadow } from "./materialize.js"
import { ensureContainers } from "./populate.js"
import { toYjsAssoc, YjsPosition } from "./position.js"
import { createYjsRevertible } from "./undo/revertible.js"
import { YjsVersion } from "./version.js"
import { resolveYjsType } from "./yjs-resolve.js"

// ---------------------------------------------------------------------------
// The delete clock
// ---------------------------------------------------------------------------

/** A top-level type Kyneta writes to only to advance the clock. */
export const DELETE_CLOCK = "kyneta.clock"

const clockedDocs = new WeakSet<Y.Doc>()

/**
 * Keep "every change advances the state vector" true of `doc`.
 *
 * Yjs clocks inserts only: a delete leaves the state vector where it was, so
 * a peer that lacks the delete cannot tell from any version that it holds
 * less. After a transaction that deleted something without advancing any
 * entry, this inserts one character into `DELETE_CLOCK` and deletes it, which
 * advances this client's entry. Local or remote alike: a plain Yjs client's
 * delete arriving through a parallel provider advances no clock either. A
 * Kyneta delete arriving through the exchange carries its author's tick in
 * the same payload, so it does not tick again.
 *
 * The tick is a transaction of its own, run while the deleting one is cleaned
 * up, so the deleting call returns with the clock advanced. It inserts, so it
 * never triggers another. Installs once per document, however many
 * substrates wrap it.
 */
export function installDeleteClock(doc: Y.Doc): void {
  if (clockedDocs.has(doc)) return
  clockedDocs.add(doc)
  doc.on("afterTransaction", (transaction: Y.Transaction) => {
    if (transaction.deleteSet.clients.size === 0) return
    if (advancedAnyClock(transaction)) return
    doc.transact(() => {
      const clock = doc.getText(DELETE_CLOCK)
      clock.insert(0, ".")
      clock.delete(0, 1)
    })
  })
}

function advancedAnyClock(transaction: Y.Transaction): boolean {
  for (const [client, clock] of transaction.afterState) {
    if (clock > (transaction.beforeState.get(client) ?? 0)) return true
  }
  return false
}

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
 * registered on the root Y.Map at construction time. Every mutation under
 * it that this substrate's `runBatch` did not make (a merge, or a write on
 * the Y.Doc from an editor binding or another substrate) is announced to
 * the kyneta changefeed, with `replay: false` iff its transaction is local.
 * A write to another top-level type is not announced, since the schema has
 * no place for it, but `subscribeLocalUpdates` still reports it.
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
    {
      target: Y.Map<unknown> | Y.Array<unknown>
      key: string | number
      value: unknown
    }
  >()

  // Own-commit discriminator, one per substrate. `runBatch` marks
  // `transaction.meta` from inside the transact body; the mark travels with
  // the Transaction object that Yjs hands to observeDeep, regardless of
  // `transaction.origin`. That frees the `origin` slot for `options.origin`,
  // and handles external code that wraps `batch(doc, fn)` in its own
  // `Y.transact` (Yjs's nested-transact collapse delivers the SAME
  // Transaction object to both outer and inner callbacks; see TECHNICAL.md
  // "Why transaction.meta mark"). Per substrate, so a second substrate over
  // the same `Y.Doc` sees this one's batches as native writes.
  const KYNETA_MARK = Symbol("kyneta:own-commit")

  // Lazy-built WritableContext (same pattern as PlainSubstrate / LoroSubstrate).
  let cachedCtx: WritableContext | undefined

  // The root Y.Map — all schema fields are children of this single map.
  const rootMap = doc.getMap("root")

  installDeleteClock(doc)

  // The shadow — a plain JS object materialized from the Y.Doc.
  // `prepare` steps it for local writes; the event bridge re-materializes it
  // for everything else.
  const shadow: PlainState = materializeYjsShadow(doc, schema, binding)
  const reader: Reader = plainReader(shadow)

  // Undo records of local transactions. Gathers nothing until someone
  // subscribes to commits or a revert runs.
  const revertible = createYjsRevertible({
    doc,
    rootMap,
    schema,
    binding,
    shadow,
    context: () => substrate.context(),
  })

  // --- Coalescer helpers ---

  /**
   * Compute the identity-aware boundary key (or numeric index) for a
   * json-boundary write at `prefixLength`. Mirrors the Loro substrate's
   * `boundaryKey`; field segments inside a bound product get the
   * identity hash, others pass through raw.
   */
  function boundaryKey(path: Path, prefixLength: number): string | number {
    const seg = path.segments[prefixLength]
    if (seg === undefined) {
      throw new Error(
        `boundaryKey: path ${path.format()} has no segment at ${prefixLength}`,
      )
    }
    if (seg.role === "field") {
      const absPath = fieldAbsPath(path.segments.slice(0, prefixLength + 1))
      return containerKey(binding, absPath, seg.resolve() as string)
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
    // `_item` is a Yjs internal — not in its published types, and the only
    // way to get a stable identity for a shared type. The first access
    // type-checks because `AbstractType` declares it; the second is on a
    // narrower subtype where it is absent.
    const targetId = `${target._item?.id?.client ?? "root"}:${(target as any)._item?.id?.clock ?? "root"}`
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
    [DEVTOOLS_HISTORY]: yjsDevtoolsHistory(() => doc),

    reader: reader,

    prepare(
      path: Path,
      change: ChangeBase,
      recordInverse: RecordInverseFn | null,
    ): void {
      // Capture σ at the target path before applyChange mutates the shadow.
      if (recordInverse) {
        // Read, don't copy. `invert` snapshots whatever it retains — see
        // `invertReplace`, `invertMap`, `invertSequence` and the rich-text
        // marks in `inverse.ts`, each of which deep-clones the pre-state it
        // captures. Copying here as well protected nothing and cost a deep
        // clone of the written subtree on every local write.
        recordInverse(path, invert(path.read(shadow), change))
        revertible.preparing(path, change)
      }

      // Local write — σ advances eagerly. CRDT-side writes happen
      // inside the ambient Y.transact opened by runBatch, which wraps
      // the batch's prepare-loop and flush.
      applyChange(shadow, path, ownedForStore(change))

      // JSON-boundary write: stage a full-value write at the
      // boundary segment of the parent container. Coalesces with
      // repeated writes inside the same subtree (last σ snapshot
      // wins) and lands in λ on `afterBatch` flush.
      const boundary = findOpaqueBoundary(schema, path, binding)
      if (boundary !== null) {
        stageJsonBoundaryWrite(path, boundary.prefixLength)
        return
      }

      // Non-boundary write: imperatively apply to λ inside the
      // ambient Y.transact. The KYNETA_MARK on the transaction
      // lets the observeDeep bridge below recognise and skip the events we
      // generate here, so the changefeed isn't fired twice.
      applyChangeToYjs(rootMap, schema, path, change, binding)
      if (recordInverse) revertible.prepared(path, change)
    },

    afterBatch(outcome: BatchOutcome): void {
      // Drain the json-boundary coalescer. Runs inside
      // the ambient Y.transact from `runBatch`; the transact closes
      // when `runBatch`'s body returns, emitting one batched
      // observeDeep event for the whole logical action.
      flushJsonBoundaryBuffer()
      revertible.ended(outcome)
    },

    revertible,

    runBatch(work: () => void, options: CommitOptions): void {
      // Yjs's native transact nesting collapses inner re-entrant
      // transacts into the outermost — exactly the "one batched
      // event per outermost logical action" semantic we want. No
      // depth counter needed.
      //
      // We mark the transaction via `tr.meta.set` inside the transact body.
      // The mark lives on per-transaction meta, orthogonal to origin.
      // The app-level `options?.origin` flows directly to `transaction.origin`
      // and round-trips to the changefeed layer.
      doc.transact(tr => {
        tr.meta.set(KYNETA_MARK, true)
        revertible.opened(tr)
        work()
      }, options.origin)
    },

    subscribeLocalUpdates(listener: () => void): () => void {
      // Yjs emits `update` exactly when a transaction changed something, for
      // every shared type in the doc, not only the schema's root map.
      const onUpdate = (
        _update: Uint8Array,
        _origin: unknown,
        _doc: Y.Doc,
        transaction: Y.Transaction,
      ): void => {
        if (transaction.local) listener()
      }
      doc.on("update", onUpdate)
      return () => doc.off("update", onUpdate)
    },

    // Every Yjs transaction commits when it ends, so nothing is ever pending.
    commitPending(): void {},

    context(): WritableContext {
      if (!cachedCtx) {
        cachedCtx = buildWritableContext(substrate, {
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
            return resolveYjsType(rootMap, schema, path as any, binding)
              .resolved
          },
          positionResolver: (
            _nodeSchema: unknown,
            path: { segments: readonly unknown[] },
          ) => {
            return {
              createPosition(index: number, side: Side) {
                // Resolve path to the Y.Text shared type
                const { resolved: ytype } = resolveYjsType(
                  rootMap,
                  schema,
                  // Structurally-declared `path` — see the note above.
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
          },
        })
      }
      return cachedCtx
    },

    version(): YjsVersion {
      return YjsVersion.fromDoc(doc)
    },

    baseVersion(): YjsVersion {
      // A live substrate never trims, so its history starts at the beginning.
      return YjsVersion.empty
    },

    /**
     * Trims nothing, and throws only for a `to` beyond the current version.
     * Yjs has no trim primitive, and re-projecting into a fresh `Y.Doc`, as
     * the replica does, would strand every native type editor bindings and
     * `unwrap` callers hold.
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

    exportEntirety(): SubstratePayload {
      return {
        kind: "entirety",
        encoding: "binary",
        data: Y.encodeStateAsUpdate(doc),
        lineage: DEFAULT_LINEAGE,
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

    merge(payload: SubstratePayload, options?: MergeOptions): void {
      if (
        payload.encoding !== "binary" ||
        !(payload.data instanceof Uint8Array)
      ) {
        throw new Error(
          "YjsSubstrate.merge expects binary-encoded payloads. " +
            "If you recently switched CRDT backends, stale clients may be sending incompatible data.",
        )
      }
      // The origin rides on the merge's transaction, where the event bridge
      // reads it. A write an observer makes in reaction is a transaction of
      // its own, so it keeps its own origin.
      Y.applyUpdate(doc, payload.data, options?.origin)
      // The observeDeep handler announces the merged ops. Yjs holds back
      // structs whose dependencies are missing; the version stays short of
      // the offer's, which is how a caller sees what is missing.
    },

    resetFromEntirety(payload: SubstratePayload, options?: MergeOptions): void {
      // Yjs never mints a new lineage automatically (see YjsVersion.lineage),
      // so an lineage boundary never arises for this substrate today — this
      // exists to satisfy the Substrate contract. CRDT merge (Y.applyUpdate)
      // is an idempotent, commutative set union; there is no "discard local
      // history" step to perform — union is always the correct absorption
      // for an oplog CRDT, lineage boundary or not.
      substrate.merge(payload, options)
    },
  }

  // --- Event bridge (registered once at construction) ---

  rootMap.observeDeep((events, transaction) => {
    // Own-commit discriminator: kyneta's runBatch marks the transaction
    // via `tr.meta.set` inside the transact body. The mark survives Yjs's
    // nested-transact collapse, so external code wrapping `batch()` in
    // its own Y.transact is correctly classified as own.
    const own = transaction.meta.get(KYNETA_MARK) === true

    // Convert Yjs events → kyneta Ops
    const ops = own ? [] : eventsToOps(events, schema, binding)

    // Undo reads a transaction's deleted text before gc, and a direct
    // write's inverse from σ before it is re-materialised below.
    if (revertible.active && transaction.local) {
      revertible.observed(events, transaction, own ? null : ops)
    }

    if (own || ops.length === 0) {
      return
    }

    const origin =
      typeof transaction.origin === "string" ? transaction.origin : undefined

    // Lazily ensure the context is built
    const ctx = substrate.context()

    // The Y.Doc already holds these ops. CRDT merge is a lattice join with
    // no sequential decomposition, so σ is re-materialised from λ in one Π
    // pass rather than stepped op by op, and only then announced.
    syncShadow(shadow, materializeYjsShadow(doc, schema, binding))
    ctx.announce(ops, { origin, local: transaction.local })
  })

  return substrate
}

// ---------------------------------------------------------------------------
// yjsSubstrateFactory — SubstrateFactory<YjsVersion>
// ---------------------------------------------------------------------------

/**
 * Factory for constructing Yjs-backed substrates.
 *
 * - `create(schema)` — creates a fresh Y.Doc with empty containers
 *   matching the schema structure. No seed data — initial content
 *   should be applied via `batch()` after construction.
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
// ---------------------------------------------------------------------------
// DevTools history capability (pull) — version/op summary.
// ---------------------------------------------------------------------------

/**
 * Build the `DevtoolsHistory` capability over a Y.Doc accessor.
 *
 * `summary()` only: reliable Yjs time-travel (`valueAt`) requires the doc to
 * be constructed with `gc: false`, which this substrate does not impose (it
 * wraps a user-provided Y.Doc). So `valueAt` is intentionally omitted.
 * Context: jj:qpmkoryn.
 */
function yjsDevtoolsHistory(getDoc: () => Y.Doc): DevtoolsHistory {
  return {
    summary(): DevtoolsHistorySummary {
      const sv = Y.encodeStateVector(getDoc())
      const actors: Record<string, number> = {}
      let opCount = 0
      for (const [client, clock] of Y.decodeStateVector(sv)) {
        actors[String(client)] = clock
        opCount += clock
      }
      return { version: new YjsVersion(sv).serialize(), opCount, actors }
    },
  }
}

export function createYjsReplica(doc: Y.Doc): Replica<YjsVersion> {
  let currentDoc = doc
  let currentBase: YjsVersion = YjsVersion.empty

  return {
    get [BACKING_DOC]() {
      return currentDoc
    },
    [DEVTOOLS_HISTORY]: yjsDevtoolsHistory(() => currentDoc),

    version(): YjsVersion {
      return YjsVersion.fromDoc(currentDoc)
    },

    baseVersion(): YjsVersion {
      return currentBase
    },

    advance(to: Version): void {
      const current = this.version()
      const plan = planAdvance({ base: currentBase, current, to })
      if (plan === "beyond") {
        throw new Error("advance(): target is ahead of current version")
      }
      // Yjs has no partial trim, only a full projection, so it trims only
      // at the current version; short of it, as far as it can is nothing.
      if (plan !== "trim" || to.compare(current) !== "equal") return

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
        lineage: DEFAULT_LINEAGE,
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

    merge(payload: SubstratePayload, _options?: MergeOptions): void {
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

    resetFromEntirety(payload: SubstratePayload, options?: MergeOptions): void {
      // See createYjsSubstrate's resetFromEntirety — CRDT merge (set union
      // via Y.applyUpdate) is always the correct absorption, lineage boundary
      // or not, so this delegates to the routine merge path.
      this.merge(payload, options)
    },
  } as Replica<YjsVersion>
}

export const yjsReplicaFactory: ReplicaFactory<YjsVersion> = {
  replicaType: ["yjs", 2, 0] as const,
  historyFree: false,

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
    if (!hasBackingDoc<Y.Doc>(replica)) {
      throw new Error("upgrade() requires a replica produced by this factory.")
    }
    const doc = replica[BACKING_DOC]
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
