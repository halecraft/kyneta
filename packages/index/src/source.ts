// source — consumer-stateless delta producer protocol.
//
// A Source<V> produces SourceEvent<V> deltas — the consumer sees only
// `subscribe`, `snapshot`, `dispose` with no mutable surface. Adapters
// hold internal state (known keys, item subscriptions) but consumers
// interact with a stateless interface.
//
// Source is NOT a Changefeed — it has no `current`, no `[CHANGEFEED]`.
// It is a subscription-only protocol. The gate into the reactive world
// is `Collection.from(source)`.

import type { ChangeBase, ReactiveMap } from "@kyneta/changefeed"
import type {
  BoundSchema,
  DocRef,
  NativeMap,
  NavigableMapRef,
  NavigableSequenceRef,
  ReadCapability,
  SchemaNode,
} from "@kyneta/schema"
import { metadataOf, subscribeNode, supportsHash } from "@kyneta/schema"
import { createWatcherTable } from "./watcher-table.js"
import type { ZSet } from "./zset.js"
import { add, isEmpty, single, zero } from "./zset.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A delta event from a source — a ℤ-set delta plus values for added entries.
 *
 * Representational invariant: every key with positive weight in `delta`
 * must have a corresponding entry in `values`.
 */
export interface SourceEvent<V> {
  readonly delta: ZSet
  readonly values: ReadonlyMap<string, V>
}

/**
 * A consumer-stateless producer of entry events.
 */
export interface Source<V> {
  /** Subscribe to entry events. Returns unsubscribe. */
  subscribe(cb: (event: SourceEvent<V>) => void): () => void
  /** Snapshot: current entries as a map (for bootstrap). */
  snapshot(): ReadonlyMap<string, V>
  /**
   * Weighted snapshot: current entries as a SourceEvent — a ZSet of
   * integrated weights plus values. Adapters that produce weight 1 per key
   * use the default {@link defaultSnapshotZSet}; combinators that can
   * produce multiplicity > 1 (`union`, non-injective `map`, `flatMap`)
   * override to preserve refcounts through bootstrap.
   */
  snapshotZSet(): SourceEvent<V>
  /** Tear down internal subscriptions if any. */
  dispose(): void
}

/**
 * Producer-side handle for a manual source.
 */
export interface SourceHandle<V> {
  /**
   * Insert a value, or replace an existing key's value. **Membership-keyed**: a
   * replace on an existing key is SILENT — no delta is emitted, so a downstream
   * `Collection` keeps the prior value (the source's `snapshot()` and the
   * materialized `Collection` then diverge). Suits set-once keys or stable live
   * refs you mutate in place. For replaceable *plain* values (an LWW register of
   * immutable data) use a `@kyneta/changefeed` `ReactiveMap` consumed via
   * `Source.fromReactiveMap`. Context: jj:qwzkmzvy.
   */
  set(key: string, value: V): void
  /** Remove a value by key. Emits `removed` delta if the key was present. */
  delete(key: string): void
}

/**
 * Mapping between exchange docIds and source keys.
 */
export interface SourceMapping {
  toKey: (docId: string) => string | null
  toDocId: (key: string) => string
}

/**
 * Producer-side handle for an exchange-backed source.
 */
export interface ExchangeSourceHandle<V> {
  /** Create a new document under the given key. Returns the ref. */
  createDoc(key: string): V
  /** Destroy the document from the exchange. Returns true if key was present. */
  delete(key: string): boolean
}

/**
 * Options for `Source.flatMap`.
 */
export interface FlatMapOptions {
  /** Derive the flat key from outer and inner keys. Default: `outerKey + "\0" + innerKey`. */
  key?: (outerKey: string, innerKey: string) => string
}

/**
 * Options for `Source.fromReactiveMap`.
 */
export interface ReactiveMapSourceOptions<V> {
  /** Value equality used to detect in-place updates. Default `Object.is`. */
  readonly equals?: (a: V, b: V) => boolean
}

// ---------------------------------------------------------------------------
// defaultSnapshotZSet — for adapters where every present key has weight 1
// ---------------------------------------------------------------------------

function defaultSnapshotZSet<V>(snap: ReadonlyMap<string, V>): SourceEvent<V> {
  const delta = new Map<string, number>()
  for (const key of snap.keys()) delta.set(key, 1)
  return { delta, values: snap }
}

// ---------------------------------------------------------------------------
// createSourceEvent — factory with invariant check
// ---------------------------------------------------------------------------

function createSourceEvent<V>(
  delta: ZSet,
  values: ReadonlyMap<string, V>,
): SourceEvent<V> {
  // Representational invariant: every positive key must have a value
  for (const [key, weight] of delta) {
    if (weight > 0 && !values.has(key)) {
      throw new Error(
        `[source] Representational invariant violated: key "${key}" has positive weight but no value`,
      )
    }
  }
  return { delta, values }
}

// ---------------------------------------------------------------------------
// createSourceEmitter — shared subscriber management
// ---------------------------------------------------------------------------

/**
 * Extract the subscriber set + emit + subscribe + clear pattern shared by
 * every Source adapter. Combinators (`filter`, `union`, `map`) delegate
 * subscribe to upstreams and don't need this.
 */
function createSourceEmitter<V>(): {
  emit: (event: SourceEvent<V>) => void
  subscribe: (cb: (event: SourceEvent<V>) => void) => () => void
  clear: () => void
} {
  const subscribers = new Set<(event: SourceEvent<V>) => void>()
  return {
    emit(event: SourceEvent<V>): void {
      for (const cb of subscribers) {
        cb(event)
      }
    },
    subscribe(cb: (event: SourceEvent<V>) => void): () => void {
      subscribers.add(cb)
      return () => {
        subscribers.delete(cb)
      }
    },
    clear(): void {
      subscribers.clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Source.create — manual source
// ---------------------------------------------------------------------------

function create<V>(): [Source<V>, SourceHandle<V>] {
  const entries = new Map<string, V>()
  const { emit, subscribe, clear } = createSourceEmitter<V>()

  const source: Source<V> = {
    subscribe,
    snapshot(): ReadonlyMap<string, V> {
      return new Map(entries)
    },
    snapshotZSet(): SourceEvent<V> {
      return defaultSnapshotZSet(entries)
    },
    dispose(): void {
      clear()
    },
  }

  const handle: SourceHandle<V> = {
    set(key: string, value: V): void {
      const isNew = !entries.has(key)
      entries.set(key, value)
      if (isNew) {
        const values = new Map<string, V>()
        values.set(key, value)
        emit(createSourceEvent(single(key, 1), values))
      }
    },
    delete(key: string): void {
      if (!entries.has(key)) return
      entries.delete(key)
      emit(createSourceEvent(single(key, -1), new Map()))
    },
  }

  return [source, handle]
}

// ---------------------------------------------------------------------------
// Source.fromRecord — record ref adapter
// ---------------------------------------------------------------------------

function fromRecord<V>(recordRef: any): Source<V> {
  const { emit, subscribe, clear } = createSourceEmitter<V>()
  const knownKeys = new Set<string>()

  // Bootstrap known keys from current state
  const currentKeys: string[] = recordRef.keys()
  for (const key of currentKeys) {
    knownKeys.add(key)
  }

  // Subscribe to structural changes — subscribeNode, NOT subscribe (fixes granularity bug)
  const unsub = subscribeNode(recordRef, () => {
    const currentKeys: string[] = recordRef.keys()
    const currentSet = new Set(currentKeys)

    // Compute ℤ-set delta: add(fromKeys(new), negate(fromKeys(old)))
    let delta = zero()
    const values = new Map<string, V>()

    for (const key of currentSet) {
      if (!knownKeys.has(key)) {
        delta = add(delta, single(key, 1))
        values.set(key, recordRef.at(key))
      }
    }
    for (const key of knownKeys) {
      if (!currentSet.has(key)) {
        delta = add(delta, single(key, -1))
      }
    }

    // Update known keys
    knownKeys.clear()
    for (const key of currentSet) {
      knownKeys.add(key)
    }

    if (!isEmpty(delta)) {
      emit(createSourceEvent(delta, values))
    }
  })

  return {
    subscribe,
    snapshot(): ReadonlyMap<string, V> {
      const result = new Map<string, V>()
      for (const key of knownKeys) {
        result.set(key, recordRef.at(key))
      }
      return result
    },
    snapshotZSet(): SourceEvent<V> {
      return defaultSnapshotZSet(this.snapshot())
    },
    dispose(): void {
      unsub()
      clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Source.fromList — list ref adapter
// ---------------------------------------------------------------------------

function fromList<V>(listRef: any, keyFn: (itemRef: V) => any): Source<V> {
  const { emit, subscribe, clear } = createSourceEmitter<V>()
  const items = createWatcherTable<V>((currentKey, itemRef) => {
    const keyRef = keyFn(itemRef)
    return subscribeNode(keyRef, () => {
      const newKey: string = keyRef()
      if (newKey === currentKey) return

      // Re-install the watcher under the new key so its closure captures it.
      items.remove(currentKey)
      items.add(newKey, itemRef)

      const delta = add(single(currentKey, -1), single(newKey, 1))
      const values = new Map<string, V>()
      values.set(newKey, itemRef)
      emit(createSourceEvent(delta, values))
    })
  })

  for (const itemRef of listRef) {
    const keyRef = keyFn(itemRef as V)
    const key: string = keyRef()
    items.add(key, itemRef as V)
  }

  const listUnsub = subscribeNode(listRef, () => {
    const currentKeys = new Set<string>()
    const currentByKey = new Map<string, V>()

    for (const itemRef of listRef) {
      const keyRef = keyFn(itemRef as V)
      const key: string = keyRef()
      currentKeys.add(key)
      currentByKey.set(key, itemRef as V)
    }

    const knownKeySet = new Set(items.keys())

    let delta = zero()
    const values = new Map<string, V>()

    // Removed
    for (const key of knownKeySet) {
      if (!currentKeys.has(key)) {
        delta = add(delta, single(key, -1))
        items.remove(key)
      }
    }

    // Added
    for (const key of currentKeys) {
      if (!knownKeySet.has(key)) {
        const itemRef = currentByKey.get(key)!
        delta = add(delta, single(key, 1))
        values.set(key, itemRef)
        items.add(key, itemRef)
      }
    }

    if (!isEmpty(delta)) {
      emit(createSourceEvent(delta, values))
    }
  })

  return {
    subscribe,
    snapshot(): ReadonlyMap<string, V> {
      return new Map(items.entries())
    },
    snapshotZSet(): SourceEvent<V> {
      return defaultSnapshotZSet(this.snapshot())
    },
    dispose(): void {
      listUnsub()
      items.clear()
      clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Source.fromExchange — exchange-backed source
// ---------------------------------------------------------------------------

const defaultMapping: SourceMapping = {
  toKey: (docId: string) => docId,
  toDocId: (key: string) => key,
}

/**
 * One entry of `exchange.documents()`.
 *
 * Declared structurally instead of imported from `@kyneta/exchange`, which is
 * an optional peer dependency: a type import would put that package into this
 * one's emitted `.d.ts`, breaking consumers who never installed it. The same
 * reason `fromExchange` takes `exchange: any`.
 *
 * `suspended` is listed to record that we see it and deliberately do not read
 * it — see `isTrackable`.
 */
type DocInfo = {
  readonly mode: "interpret" | "replicate" | "deferred"
  readonly suspended: boolean
}

/**
 * Which documents this source tracks. Pure — the caller does the lookups.
 *
 * This states what a source *tracks*, which is a different question from what
 * `exchange.get()` will *tolerate*, and the two are meant to stay independent.
 * `get()` is the more permissive of the pair — its job is to raise documents
 * to a usable state, so it may well learn to upgrade a replicate document on
 * request. This predicate must go on refusing to index one either way. Phrased
 * as policy, it stays correct without tracking changes to `get()`; phrased as
 * a precondition check, every change there would become a change here.
 *
 * Taking already-gathered values rather than the exchange keeps this a truth
 * table — testable with no Exchange at all, the same shape as
 * `deriveConnectivity` in `@kyneta/exchange`.
 */
function isTrackable(
  info: DocInfo | undefined,
  docHash: string | undefined,
  reader: ReadCapability,
): boolean {
  // Gone from `exchange.documents()` — destroyed, or removed. `reconcile`
  // relies on this to drop the entry.
  if (info === undefined) return false

  // The tier line, and the whole of it. A source may change a document's
  // *readability* — attaching one registers its schema, which promotes the
  // deferred documents that schema can now read, and that is the feature. It
  // must never change a document's *tier*: turning a relay's headless replica
  // into a full substrate is an operator's decision, not a side effect of
  // someone indexing.
  //
  // This clause does not stop deferred documents being promoted —
  // `registerSchema` below has already done that by the time we run. It
  // stops a *replicate* document being upgraded.
  if (info.mode !== "interpret") return false

  // There is deliberately no `info.suspended` check here. Suspension is
  // sync-graph state rather than a phase: a suspended document is still
  // interpreted, still in `documents()`, still holding a live readable ref. If
  // it decided membership, `exchange.suspend(docId)` would delete a row from
  // every view built on this source and `resume` would put it back — churn
  // because the network went quiet. `remove()` and `destroy()` are the exits.

  // `supportsHash` rather than string equality, because a schema is defined to
  // read its own ancestor shapes; comparing for equality would drop the very
  // documents a migrated schema exists to keep reading. A hash the exchange
  // cannot name is not evidence of a mismatch, so an absent one passes.
  if (docHash !== undefined && !supportsHash(reader, docHash)) return false

  return true
}

function fromExchange<V>(
  exchange: any,
  bound: BoundSchema<any>,
  mapping?: SourceMapping,
): [Source<V>, ExchangeSourceHandle<V>] {
  const m = mapping ?? defaultMapping
  const { emit, subscribe, clear } = createSourceEmitter<V>()
  const entries = new Map<string, V>()
  // Built once, outside the predicate: the set of schema hashes this source
  // can read, which is its own hash plus every ancestor shape it migrates from.
  const reader = metadataOf(bound)

  /**
   * Re-decide one document's membership, and emit if it changed.
   *
   * The single rule behind all three paths into this source — the scan asks it
   * of every document, the subscription of one, the handle of the document it
   * just created or destroyed. Two invariants follow, and both are worth
   * holding onto when changing anything here:
   *
   * 1. The source's contents always equal what a fresh scan would produce.
   * 2. The integrated deltas always equal the contents.
   *
   * The second is the one that is easy to break and hard to see. `entries` is
   * a `Map`, so it dedupes silently and `snapshot()` will look right while the
   * emitted stream — which is what downstream consumers integrate — is wrong.
   * That is why nothing outside this function writes to `entries` or emits.
   *
   * Idempotent in both directions, so calling it twice for the same event is
   * always safe.
   */
  function reconcile(docId: string): void {
    const key = m.toKey(docId)
    if (key === null) return

    const info = exchange.documents().get(docId) as DocInfo | undefined
    const docHash = exchange.getDocSchemaHash(docId) as string | undefined

    if (!isTrackable(info, docHash, reader)) {
      if (!entries.delete(key)) return
      emit(createSourceEvent(single(key, -1), new Map()))
      return
    }

    // Already tracked — nothing changed. This guard sits after the
    // trackability check and before `get()` on purpose: it must not suppress a
    // removal, and it must spare us a redundant `get()` on a repeat event.
    if (entries.has(key)) return

    const ref = exchange.get(docId, bound) as V
    entries.set(key, ref)

    const values = new Map<string, V>()
    values.set(key, ref)
    emit(createSourceEvent(single(key, 1), values))
  }

  // Register the BoundSchema so matching remote docs are auto-resolved.
  //
  // This also sweeps documents already sitting deferred and promotes the ones
  // this schema can now read — so attaching a source is not a read-only act,
  // and cannot be: without registering, this peer would never be offered the
  // remote documents the source exists to index. It is also why `isTrackable`
  // has nothing to say about deferred promotion; it has already happened by
  // the time the scan below runs.
  exchange.registerSchema(bound)

  // Subscribe to the documents changefeed — BEFORE scanning existing docs
  // so we don't miss docs created between scan and subscribe.
  //
  // No dispatch on `change.type`. Every `DocChange` means the same thing here
  // — "this document may have changed" — and `reconcile` answers it from the
  // exchange's current state rather than from what the event claims. A seventh
  // member added to `DocChange` later is handled the day it ships.
  const unsubscribeDocs: () => void = exchange.documents.subscribe(
    (cs: any) => {
      for (const change of cs.changes) reconcile(change.docId)
    },
  )

  // Scan existing documents to catch docs created before the subscription.
  // Literally the same call the subscription makes, rather than a loop that
  // resembles it — two implementations of one rule can drift apart, and a
  // single call cannot.
  //
  // Emitting here is a no-op — `createSourceEmitter` does not buffer, and
  // `fromExchange` has not returned, so there is nothing subscribed yet.
  for (const docId of exchange.documents().keys()) reconcile(docId)

  const source: Source<V> = {
    subscribe,
    snapshot(): ReadonlyMap<string, V> {
      return new Map(entries)
    },
    snapshotZSet(): SourceEvent<V> {
      return defaultSnapshotZSet(entries)
    },
    dispose(): void {
      unsubscribeDocs()
      clear()
    },
  }

  // Both methods act on the exchange, then let `reconcile` decide what that
  // means for membership. Keeping their own bookkeeping is what made
  // `createDoc` emit twice: `doc-created` fires synchronously inside
  // `exchange.get()`, so the subscriber had already added and emitted before
  // `createDoc` reached its own `entries.set`. The key integrated to weight 2,
  // and a later `delete` left a phantom behind in every derived view.
  //
  // Routing through `reconcile` holds whichever way that ordering goes. If the
  // event is synchronous, as today, the subscriber has done the work and the
  // `entries.has` guard makes this call a no-op; were it ever deferred,
  // `reconcile` does the work here and the later subscriber no-ops. Neither
  // can double-emit, because one rule owns `entries`.
  const handle: ExchangeSourceHandle<V> = {
    createDoc(key: string): V {
      // A caller-error check, not membership bookkeeping — hence still here.
      if (entries.has(key)) {
        throw new Error(
          `[source] Key "${key}" already exists. Use delete() first to replace.`,
        )
      }
      const docId = m.toDocId(key)
      const ref = exchange.get(docId, bound) as V
      reconcile(docId)
      return ref
    },
    delete(key: string): boolean {
      if (!entries.has(key)) return false
      // Symmetric with createDoc: destroy from the exchange
      const docId = m.toDocId(key)
      exchange.destroy(docId)
      reconcile(docId)
      return true
    },
  }

  return [source, handle]
}

// ---------------------------------------------------------------------------
// Source.fromReactiveMap — changefeed ReactiveMap adapter
// ---------------------------------------------------------------------------

/**
 * Pure functional core: diff a previously-seen value map against the current
 * one into a remove-before-add pair of ℤ-set events. An in-place value change
 * (same key, `!equals`) is the DBSP-faithful update — a retraction of the old
 * row plus an insertion of the new — so such a key appears in BOTH the retract
 * (`-1`) and the insert (`+1`, new value). Returns:
 *   `[]`                no change
 *   `[retract]`         pure removal(s)
 *   `[insert]`          pure addition(s)
 *   `[retract, insert]` removals/updates, then additions/updates
 * The retract event always precedes the insert event so a downstream
 * `Collection` applies the removal before the matching re-insert.
 */
export function diffValueMaps<V>(
  known: ReadonlyMap<string, V>,
  current: ReadonlyMap<string, V>,
  equals: (a: V, b: V) => boolean,
): SourceEvent<V>[] {
  let retract: ZSet = zero()
  let insert: ZSet = zero()
  const insertValues = new Map<string, V>()

  // Removals + the retraction half of in-place updates.
  for (const [key, prev] of known) {
    const now = current.get(key)
    if (now === undefined || !equals(prev, now)) {
      retract = add(retract, single(key, -1))
    }
  }
  // Additions + the insertion half of in-place updates.
  for (const [key, now] of current) {
    const prev = known.get(key)
    if (prev === undefined || !equals(prev, now)) {
      insert = add(insert, single(key, 1))
      insertValues.set(key, now)
    }
  }

  const events: SourceEvent<V>[] = []
  if (!isEmpty(retract)) events.push(createSourceEvent(retract, new Map()))
  if (!isEmpty(insert)) events.push(createSourceEvent(insert, insertValues))
  return events
}

/**
 * Adapt a `@kyneta/changefeed` `ReactiveMap` (an LWW register-per-key) into a
 * `Source<V>`. Bridges the framework's two integrators: the map's last-writer-
 * wins value cells become a ℤ-set membership stream that `Collection`/`Index`
 * can consume. In-place value updates are lowered to retract+insert (the
 * Materialize/DBSP UPSERT envelope), so the ℤ-set core stays untouched.
 *
 * Vocabulary-agnostic: the changefeed payload is ignored; each notification
 * re-diffs `map.current` (like `fromRecord`), so any `ReactiveMap` change type
 * works uniformly. The adapter is a *reader* — `dispose()` unsubscribes but
 * does NOT dispose the map. Context: jj:qwzkmzvy.
 */
function fromReactiveMap<V, C extends ChangeBase>(
  map: ReactiveMap<string, V, C>,
  options?: ReactiveMapSourceOptions<V>,
): Source<V> {
  const equals = options?.equals ?? Object.is
  const { emit, subscribe, clear } = createSourceEmitter<V>()

  // Last-seen value map — diffed against `map.current` on every notification.
  let known = new Map<string, V>(map.current)

  const unsub = map.subscribe(() => {
    const current = map.current
    for (const event of diffValueMaps(known, current, equals)) {
      emit(event)
    }
    known = new Map(current)
  })

  return {
    subscribe,
    snapshot(): ReadonlyMap<string, V> {
      return new Map(map.current)
    },
    snapshotZSet(): SourceEvent<V> {
      return defaultSnapshotZSet(map.current)
    },
    dispose(): void {
      unsub()
      clear()
      // NOT map.dispose(): the adapter reads the map; its owner tears it down.
    },
  }
}

// ---------------------------------------------------------------------------
// Source.filter — linear composition
// ---------------------------------------------------------------------------

function filter<V>(
  source: Source<V>,
  pred: (key: string, value: V) => boolean,
  watch?: (key: string, value: V, onChange: () => void) => () => void,
): Source<V> {
  const { emit, subscribe, clear } = createSourceEmitter<V>()

  // Stored value is what the predicate is re-evaluated against when the
  // watcher fires — for mutable-value predicates, this captures the
  // post-mutation state because `value` is the same reference as upstream.
  const admitted = createWatcherTable<V>((key, value) => {
    if (!watch) return () => {}
    return watch(key, value, () => {
      const stillAdmitted = admitted.get(key)
      if (stillAdmitted === undefined) return
      if (!pred(key, stillAdmitted)) {
        admitted.remove(key)
        emit(createSourceEvent(single(key, -1), new Map()))
      }
    })
  })

  // Bootstrap-install watchers for predicate-passing entries that already
  // exist upstream — otherwise their post-construction mutations would slip
  // past the filter.
  const bootstrap = source.snapshotZSet()
  for (const [key, weight] of bootstrap.delta) {
    if (weight <= 0) continue
    const value = bootstrap.values.get(key)
    if (value !== undefined && pred(key, value)) {
      admitted.add(key, value)
    }
  }

  const upstreamUnsub = source.subscribe(event => {
    let delta = zero()
    const values = new Map<string, V>()

    for (const [key, weight] of event.delta) {
      if (weight > 0) {
        const value = event.values.get(key)!
        if (pred(key, value)) {
          // Install before emit: a subscriber that synchronously mutates the
          // value in response to `added` must find the watcher already armed.
          admitted.add(key, value)
          delta = add(delta, single(key, weight))
          values.set(key, value)
        }
      } else {
        if (admitted.has(key)) {
          admitted.remove(key)
          delta = add(delta, single(key, weight))
        }
        // else: upstream removal of a never-admitted key — nothing to forward.
      }
    }

    if (!isEmpty(delta)) {
      emit(createSourceEvent(delta, values))
    }
  })

  return {
    subscribe,
    snapshot(): ReadonlyMap<string, V> {
      return new Map(admitted.entries())
    },
    snapshotZSet(): SourceEvent<V> {
      // Project upstream weights through the admitted set — preserves
      // multiplicity for keys we're tracking, drops the rest.
      const upstream = source.snapshotZSet()
      const delta = new Map<string, number>()
      const values = new Map<string, V>()
      for (const [key, weight] of upstream.delta) {
        if (!admitted.has(key)) continue
        delta.set(key, weight)
        const v = upstream.values.get(key)
        if (v !== undefined) values.set(key, v)
      }
      return { delta, values }
    },
    dispose(): void {
      upstreamUnsub()
      admitted.clear()
      clear()
      source.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// Source.union — linear composition
// ---------------------------------------------------------------------------

function union<V>(a: Source<V>, b: Source<V>): Source<V> {
  return {
    subscribe(cb: (event: SourceEvent<V>) => void): () => void {
      const unsubA = a.subscribe(cb)
      const unsubB = b.subscribe(cb)
      return () => {
        unsubA()
        unsubB()
      }
    },
    snapshot(): ReadonlyMap<string, V> {
      const result = new Map(a.snapshot())
      for (const [key, value] of b.snapshot()) {
        if (!result.has(key)) {
          result.set(key, value)
        }
      }
      return result
    },
    snapshotZSet(): SourceEvent<V> {
      // ZSet-sum preserves multiplicity across overlapping keys. Value
      // merge is first-wins; presence downstream is decided by the refcount,
      // not by which value won.
      const sa = a.snapshotZSet()
      const sb = b.snapshotZSet()
      const delta = add(sa.delta, sb.delta)
      const values = new Map<string, V>()
      for (const [k, v] of sa.values) values.set(k, v)
      for (const [k, v] of sb.values) if (!values.has(k)) values.set(k, v)
      return { delta, values }
    },
    dispose(): void {
      a.dispose()
      b.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// Source.map — linear composition (key remapping)
// ---------------------------------------------------------------------------

function map<V>(
  source: Source<V>,
  fn: (key: string) => string | null,
): Source<V> {
  return {
    subscribe(cb: (event: SourceEvent<V>) => void): () => void {
      return source.subscribe(event => {
        let delta = zero()
        const values = new Map<string, V>()

        for (const [key, weight] of event.delta) {
          const newKey = fn(key)
          if (newKey === null) continue
          delta = add(delta, single(newKey, weight))
          if (weight > 0) {
            const value = event.values.get(key)!
            values.set(newKey, value)
          }
        }

        if (!isEmpty(delta)) {
          cb(createSourceEvent(delta, values))
        }
      })
    },
    snapshot(): ReadonlyMap<string, V> {
      const base = source.snapshot()
      const result = new Map<string, V>()
      for (const [key, value] of base) {
        const newKey = fn(key)
        if (newKey !== null) {
          result.set(newKey, value)
        }
      }
      return result
    },
    snapshotZSet(): SourceEvent<V> {
      // Accumulate weights at remapped keys — non-injective fn produces
      // weight > 1, which the refcounted integrator downstream preserves.
      const upstream = source.snapshotZSet()
      let delta = zero()
      const values = new Map<string, V>()
      for (const [key, weight] of upstream.delta) {
        const newKey = fn(key)
        if (newKey === null) continue
        delta = add(delta, single(newKey, weight))
        const v = upstream.values.get(key)
        if (v !== undefined && !values.has(newKey)) values.set(newKey, v)
      }
      return { delta, values }
    },
    dispose(): void {
      source.dispose()
    },
  }
}

// ---------------------------------------------------------------------------
// Source.flatMap — dynamic union combinator
// ---------------------------------------------------------------------------

// Pure functional core: remap an inner event's keys via the key function.
function remapEvent<V>(
  event: SourceEvent<V>,
  outerKey: string,
  keyFn: (outerKey: string, innerKey: string) => string,
): SourceEvent<V> {
  let delta = zero()
  const values = new Map<string, V>()

  for (const [innerKey, weight] of event.delta) {
    const flatKey = keyFn(outerKey, innerKey)
    delta = add(delta, single(flatKey, weight))
    if (weight > 0) {
      const value = event.values.get(innerKey)!
      values.set(flatKey, value)
    }
  }

  return createSourceEvent(delta, values)
}

const defaultFlatMapKey = (outerKey: string, innerKey: string): string =>
  `${outerKey}\0${innerKey}`

function flatMap<Outer, Inner>(
  outer: Source<Outer>,
  fn: (key: string, value: Outer) => Source<Inner>,
  options?: FlatMapOptions,
): Source<Inner> {
  const keyFn = options?.key ?? defaultFlatMapKey
  const { emit, subscribe, clear } = createSourceEmitter<Inner>()

  // innerSource.dispose() is called by removeInner *before* the WatcherTable
  // teardown — removal needs to read the inner snapshot to synthesize
  // retractions, which would be empty if we disposed first.
  const inners = createWatcherTable<Source<Inner>>((outerKey, innerSource) => {
    return innerSource.subscribe(event => {
      emit(remapEvent(event, outerKey, keyFn))
    })
  })

  function addInner(outerKey: string, outerValue: Outer): void {
    const innerSource = fn(outerKey, outerValue)
    // Subscribe before snapshot to avoid missing events in the gap.
    inners.add(outerKey, innerSource)

    // Emit inner snapshot as additions
    const snap = innerSource.snapshot()
    if (snap.size > 0) {
      let delta = zero()
      const values = new Map<string, Inner>()
      for (const [innerKey, value] of snap) {
        const flatKey = keyFn(outerKey, innerKey)
        delta = add(delta, single(flatKey, 1))
        values.set(flatKey, value)
      }
      emit(createSourceEvent(delta, values))
    }
  }

  function removeInner(outerKey: string): void {
    const innerSource = inners.get(outerKey)
    if (!innerSource) return

    // Snapshot inner source to discover current keys for retraction
    const snap = innerSource.snapshot()
    if (snap.size > 0) {
      let delta = zero()
      for (const [innerKey] of snap) {
        const flatKey = keyFn(outerKey, innerKey)
        delta = add(delta, single(flatKey, -1))
      }
      emit(createSourceEvent(delta, new Map()))
    }

    inners.remove(outerKey)
    innerSource.dispose()
  }

  // Bootstrap from outer snapshot
  const outerSnap = outer.snapshot()
  for (const [outerKey, outerValue] of outerSnap) {
    // During bootstrap, create inner sources but don't emit — snapshot() handles it
    const innerSource = fn(outerKey, outerValue)
    inners.add(outerKey, innerSource)
  }

  // Subscribe to outer for dynamic lifecycle
  const outerUnsub = outer.subscribe(event => {
    for (const [outerKey, weight] of event.delta) {
      if (weight > 0) {
        const outerValue = event.values.get(outerKey)!
        addInner(outerKey, outerValue)
      } else if (weight < 0) {
        removeInner(outerKey)
      }
    }
  })

  return {
    subscribe,
    snapshot(): ReadonlyMap<string, Inner> {
      // Lazy: iterate all inner sources and remap keys on the fly
      const result = new Map<string, Inner>()
      for (const [outerKey, innerSource] of inners.entries()) {
        const snap = innerSource.snapshot()
        for (const [innerKey, value] of snap) {
          result.set(keyFn(outerKey, innerKey), value)
        }
      }
      return result
    },
    snapshotZSet(): SourceEvent<Inner> {
      // ZSet-sum every inner source's weighted snapshot under its flat-key
      // remap. Custom keyFns that produce collisions across outers preserve
      // multiplicity.
      let delta = zero()
      const values = new Map<string, Inner>()
      for (const [outerKey, innerSource] of inners.entries()) {
        const innerSnap = innerSource.snapshotZSet()
        for (const [innerKey, weight] of innerSnap.delta) {
          const flatKey = keyFn(outerKey, innerKey)
          delta = add(delta, single(flatKey, weight))
          const v = innerSnap.values.get(innerKey)
          if (v !== undefined && !values.has(flatKey)) values.set(flatKey, v)
        }
      }
      return { delta, values }
    },
    dispose(): void {
      outerUnsub()
      outer.dispose()
      for (const innerSource of inners.values()) {
        innerSource.dispose()
      }
      inners.clear()
      clear()
    },
  }
}

// ---------------------------------------------------------------------------
// Source.of — exchange entity discovery
// ---------------------------------------------------------------------------

function of<V>(
  exchange: any,
  bound: BoundSchema<any>,
  accessor?: (docRef: any) => any,
  keyFn?: (itemRef: V) => any,
): Source<V> {
  // Document-level (2 args): each doc is an entry keyed by docId
  if (accessor === undefined) {
    const [source] = fromExchange<V>(exchange, bound)
    return source
  }

  // Record-level (3 args): accessor returns a record ref
  if (keyFn === undefined) {
    const [outerSource] = fromExchange<any>(exchange, bound)
    return flatMap<any, V>(outerSource, (_docId, docRef) =>
      fromRecord<V>(accessor(docRef)),
    )
  }

  // List-level (4 args): accessor returns a list ref, keyFn extracts entity keys
  const [outerSource] = fromExchange<any>(exchange, bound)
  return flatMap<any, V>(outerSource, (_docId, docRef) =>
    fromList<V>(accessor(docRef), keyFn),
  )
}

// ---------------------------------------------------------------------------
// Source namespace — typed facade
// ---------------------------------------------------------------------------

/**
 * The slice of an Exchange these sources use.
 *
 * Declared structurally rather than imported, because `@kyneta/exchange` is an
 * *optional* peer dependency here: a consumer indexing plain records or lists
 * should not be made to install it. Structural typing keeps that true while
 * still rejecting an argument that is obviously not an exchange, which a bare
 * `any` did not.
 */
export interface ExchangeLike {
  readonly documents: ReactiveMap<string, unknown, ChangeBase>
  get(docId: string, bound: BoundSchema<never, never>): unknown
  destroy(docId: string): void
}

export interface SourceStatic {
  create<V>(): [Source<V>, SourceHandle<V>]
  fromRecord<V>(recordRef: any): Source<V>
  fromList<V>(listRef: any, keyFn: (itemRef: V) => any): Source<V>
  fromExchange<V>(
    exchange: any,
    bound: BoundSchema<any>,
    mapping?: SourceMapping,
  ): [Source<V>, ExchangeSourceHandle<V>]
  fromReactiveMap<V, C extends ChangeBase>(
    map: ReactiveMap<string, V, C>,
    options?: ReactiveMapSourceOptions<V>,
  ): Source<V>
  filter<V>(
    source: Source<V>,
    pred: (key: string, value: V) => boolean,
    watch?: (key: string, value: V, onChange: () => void) => () => void,
  ): Source<V>
  union<V>(a: Source<V>, b: Source<V>): Source<V>
  map<V>(source: Source<V>, fn: (key: string) => string | null): Source<V>
  flatMap<Outer, Inner>(
    outer: Source<Outer>,
    fn: (key: string, value: Outer) => Source<Inner>,
    options?: FlatMapOptions,
  ): Source<Inner>
  // `S` and `N` are threaded from `bound` so the accessor receives the real
  // document, and `V` is inferred from what the accessor *returns* rather than
  // from a callback parameter. A type parameter that appears only in a callback
  // parameter position has nothing to infer from and silently resolves to its
  // constraint — which is how every caller of this used to end up with
  // `docRef: any` and `itemRef: unknown`.
  of<S extends SchemaNode, N extends NativeMap>(
    exchange: ExchangeLike,
    bound: BoundSchema<S, N>,
  ): Source<DocRef<S, N>>
  of<S extends SchemaNode, N extends NativeMap, V>(
    exchange: ExchangeLike,
    bound: BoundSchema<S, N>,
    accessor: (docRef: DocRef<S, N>) => NavigableMapRef<V>,
  ): Source<V>
  of<S extends SchemaNode, N extends NativeMap, V>(
    exchange: ExchangeLike,
    bound: BoundSchema<S, N>,
    accessor: (docRef: DocRef<S, N>) => NavigableSequenceRef<V>,
    keyFn: (itemRef: V) => string,
  ): Source<V>
}

// Annotated via the cast rather than `const Source: SourceStatic`, and routed
// through `unknown` deliberately. An annotation makes TypeScript check these
// deliberately-loose implementations against the precise interface above, and
// comparing them against `DocRef<S, N>` exceeds its recursion budget (TS2589).
// The interface is the contract callers see; the implementations are internal
// and typed loosely on purpose. Same trade `useDocument` makes in
// `@kyneta/react`, and for the same reason.
export const Source = {
  create,
  fromRecord,
  fromList,
  fromExchange,
  fromReactiveMap,
  filter,
  union,
  map,
  flatMap,
  of,
} as unknown as SourceStatic
