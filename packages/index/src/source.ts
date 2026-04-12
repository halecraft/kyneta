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

import type { BoundSchema } from "@kyneta/schema"
import { subscribeNode } from "@kyneta/schema"
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
  /** Tear down internal subscriptions if any. */
  dispose(): void
}

/**
 * Producer-side handle for a manual source.
 */
export interface SourceHandle<V> {
  /** Insert or replace a value. Emits `added` delta only for new keys. */
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
  /** Dismiss the document from the exchange. Returns true if key was present. */
  delete(key: string): boolean
}

/**
 * Options for `Source.flatMap`.
 */
export interface FlatMapOptions {
  /** Derive the flat key from outer and inner keys. Default: `outerKey + "\0" + innerKey`. */
  key?: (outerKey: string, innerKey: string) => string
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
  // key → itemRef
  const keyToRef = new Map<string, V>()
  // key → unsubscribe for per-item key watcher
  const itemUnsubs = new Map<string, () => void>()

  // Subscribe to a single item's key ref for re-keying.
  function watchItemKey(itemRef: V, currentKey: string): void {
    const keyRef = keyFn(itemRef)
    const unsub = subscribeNode(keyRef, () => {
      const newKey: string = keyRef()
      if (newKey === currentKey) return

      // Remove old key, add new key
      keyToRef.delete(currentKey)
      const oldUnsub = itemUnsubs.get(currentKey)
      if (oldUnsub) {
        oldUnsub()
        itemUnsubs.delete(currentKey)
      }

      keyToRef.set(newKey, itemRef)

      // Re-watch under new key
      watchItemKey(itemRef, newKey)

      // Emit paired delta
      const delta = add(single(currentKey, -1), single(newKey, 1))
      const values = new Map<string, V>()
      values.set(newKey, itemRef)
      emit(createSourceEvent(delta, values))
    })
    itemUnsubs.set(currentKey, unsub)
  }

  // Bootstrap initial entries
  for (const itemRef of listRef) {
    const keyRef = keyFn(itemRef as V)
    const key: string = keyRef()
    keyToRef.set(key, itemRef as V)
    watchItemKey(itemRef as V, key)
  }

  // Subscribe to structural changes on the list ref
  const listUnsub = subscribeNode(listRef, () => {
    const currentKeys = new Set<string>()
    const currentByKey = new Map<string, V>()

    for (const itemRef of listRef) {
      const keyRef = keyFn(itemRef as V)
      const key: string = keyRef()
      currentKeys.add(key)
      currentByKey.set(key, itemRef as V)
    }

    const knownKeySet = new Set(keyToRef.keys())

    let delta = zero()
    const values = new Map<string, V>()

    // Removed
    for (const key of knownKeySet) {
      if (!currentKeys.has(key)) {
        delta = add(delta, single(key, -1))
        keyToRef.delete(key)
        const unsub = itemUnsubs.get(key)
        if (unsub) {
          unsub()
          itemUnsubs.delete(key)
        }
      }
    }

    // Added
    for (const key of currentKeys) {
      if (!knownKeySet.has(key)) {
        const itemRef = currentByKey.get(key)!
        delta = add(delta, single(key, 1))
        values.set(key, itemRef)
        keyToRef.set(key, itemRef)
        watchItemKey(itemRef, key)
      }
    }

    if (!isEmpty(delta)) {
      emit(createSourceEvent(delta, values))
    }
  })

  return {
    subscribe,
    snapshot(): ReadonlyMap<string, V> {
      return new Map(keyToRef)
    },
    dispose(): void {
      listUnsub()
      for (const unsub of itemUnsubs.values()) {
        unsub()
      }
      itemUnsubs.clear()
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

function fromExchange<V>(
  exchange: any,
  bound: BoundSchema<any>,
  mapping?: SourceMapping,
): [Source<V>, ExchangeSourceHandle<V>] {
  const m = mapping ?? defaultMapping
  const { emit, subscribe, clear } = createSourceEmitter<V>()
  const entries = new Map<string, V>()
  const schemaHash = bound.schemaHash

  function tryAdd(docId: string): void {
    const key = m.toKey(docId)
    if (key === null) return

    // Check schema hash — only track docs matching our bound
    const docHash = exchange.getDocSchemaHash(docId)
    if (docHash !== undefined && docHash !== schemaHash) return

    if (entries.has(key)) return

    const ref = exchange.get(docId, bound) as V
    entries.set(key, ref)

    const values = new Map<string, V>()
    values.set(key, ref)
    emit(createSourceEvent(single(key, 1), values))
  }

  function tryRemove(docId: string): void {
    const key = m.toKey(docId)
    if (key === null) return
    if (!entries.delete(key)) return
    emit(createSourceEvent(single(key, -1), new Map()))
  }

  // Register the BoundSchema so matching remote docs are auto-resolved
  exchange.registerSchema(bound)

  // Scan existing docs to catch docs created before the source
  const existingIds: ReadonlySet<string> = exchange.documentIds()
  for (const docId of existingIds) {
    const key = m.toKey(docId)
    if (key === null) continue
    const docHash = exchange.getDocSchemaHash(docId)
    if (docHash !== undefined && docHash !== schemaHash) continue
    if (entries.has(key)) continue
    const ref = exchange.get(docId, bound) as V
    entries.set(key, ref)
  }

  // Register a scope for lifecycle tracking
  const disposeScope: () => void = exchange.register({
    onDocCreated(docId: string, _peer: any, mode: string, _origin: string) {
      if (mode !== "interpret") return
      tryAdd(docId)
    },
    onDocDismissed(docId: string, _peer: any, _origin: string) {
      tryRemove(docId)
    },
  })

  const source: Source<V> = {
    subscribe,
    snapshot(): ReadonlyMap<string, V> {
      return new Map(entries)
    },
    dispose(): void {
      disposeScope()
      clear()
    },
  }

  const handle: ExchangeSourceHandle<V> = {
    createDoc(key: string): V {
      if (entries.has(key)) {
        throw new Error(
          `[source] Key "${key}" already exists. Use delete() first to replace.`,
        )
      }
      const docId = m.toDocId(key)
      const ref = exchange.get(docId, bound) as V
      entries.set(key, ref)

      const values = new Map<string, V>()
      values.set(key, ref)
      emit(createSourceEvent(single(key, 1), values))
      return ref
    },
    delete(key: string): boolean {
      if (!entries.has(key)) return false
      entries.delete(key)
      // Symmetric with createDoc: dismiss from the exchange
      const docId = m.toDocId(key)
      exchange.dismiss(docId)
      emit(createSourceEvent(single(key, -1), new Map()))
      return true
    },
  }

  return [source, handle]
}

// ---------------------------------------------------------------------------
// Source.filter — linear composition
// ---------------------------------------------------------------------------

function filter<V>(
  source: Source<V>,
  pred: (key: string, value: V) => boolean,
): Source<V> {
  return {
    subscribe(cb: (event: SourceEvent<V>) => void): () => void {
      return source.subscribe(event => {
        let delta = zero()
        const values = new Map<string, V>()

        for (const [key, weight] of event.delta) {
          if (weight > 0) {
            const value = event.values.get(key)!
            if (pred(key, value)) {
              delta = add(delta, single(key, weight))
              values.set(key, value)
            }
          } else {
            // For removals, we need to check if the key was previously accepted.
            // Since we're stateless at the filter layer, we pass through all removals —
            // the downstream Collection will no-op if the key wasn't present.
            delta = add(delta, single(key, weight))
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
        if (pred(key, value)) {
          result.set(key, value)
        }
      }
      return result
    },
    dispose(): void {
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

  // outerKey → { innerSource, innerUnsub }
  const inners = new Map<
    string,
    { innerSource: Source<Inner>; innerUnsub: () => void }
  >()

  function addInner(outerKey: string, outerValue: Outer): void {
    const innerSource = fn(outerKey, outerValue)

    // Subscribe before snapshot to avoid missing events in the gap
    const innerUnsub = innerSource.subscribe(event => {
      emit(remapEvent(event, outerKey, keyFn))
    })

    inners.set(outerKey, { innerSource, innerUnsub })

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
    const entry = inners.get(outerKey)
    if (!entry) return

    // Snapshot inner source to discover current keys for retraction
    const snap = entry.innerSource.snapshot()
    if (snap.size > 0) {
      let delta = zero()
      for (const [innerKey] of snap) {
        const flatKey = keyFn(outerKey, innerKey)
        delta = add(delta, single(flatKey, -1))
      }
      emit(createSourceEvent(delta, new Map()))
    }

    entry.innerUnsub()
    entry.innerSource.dispose()
    inners.delete(outerKey)
  }

  // Bootstrap from outer snapshot
  const outerSnap = outer.snapshot()
  for (const [outerKey, outerValue] of outerSnap) {
    // During bootstrap, create inner sources but don't emit — snapshot() handles it
    const innerSource = fn(outerKey, outerValue)
    const innerUnsub = innerSource.subscribe(event => {
      emit(remapEvent(event, outerKey, keyFn))
    })
    inners.set(outerKey, { innerSource, innerUnsub })
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
      for (const [outerKey, { innerSource }] of inners) {
        const snap = innerSource.snapshot()
        for (const [innerKey, value] of snap) {
          result.set(keyFn(outerKey, innerKey), value)
        }
      }
      return result
    },
    dispose(): void {
      outerUnsub()
      outer.dispose()
      for (const { innerUnsub, innerSource } of inners.values()) {
        innerUnsub()
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

export interface SourceStatic {
  create<V>(): [Source<V>, SourceHandle<V>]
  fromRecord<V>(recordRef: any): Source<V>
  fromList<V>(listRef: any, keyFn: (itemRef: V) => any): Source<V>
  fromExchange<V>(
    exchange: any,
    bound: BoundSchema<any>,
    mapping?: SourceMapping,
  ): [Source<V>, ExchangeSourceHandle<V>]
  filter<V>(
    source: Source<V>,
    pred: (key: string, value: V) => boolean,
  ): Source<V>
  union<V>(a: Source<V>, b: Source<V>): Source<V>
  map<V>(source: Source<V>, fn: (key: string) => string | null): Source<V>
  flatMap<Outer, Inner>(
    outer: Source<Outer>,
    fn: (key: string, value: Outer) => Source<Inner>,
    options?: FlatMapOptions,
  ): Source<Inner>
  of<V>(exchange: any, bound: BoundSchema<any>): Source<V>
  of<V>(
    exchange: any,
    bound: BoundSchema<any>,
    accessor: (docRef: any) => any,
  ): Source<V>
  of<V>(
    exchange: any,
    bound: BoundSchema<any>,
    accessor: (docRef: any) => any,
    keyFn: (itemRef: V) => any,
  ): Source<V>
}

export const Source: SourceStatic = {
  create,
  fromRecord,
  fromList,
  fromExchange,
  filter,
  union,
  map,
  flatMap,
  of,
} as SourceStatic
