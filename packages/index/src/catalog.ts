// catalog — reactive keyed collection of refs from any source.
//
// A Catalog<S> is a ReactiveMap<string, Ref<S>, CatalogChange> — a
// callable changefeed over a keyed collection of refs. It can be
// populated from any source: Catalog.create(bound), Catalog.collect(),
// Catalog.fromExchange, Catalog.fromList, or Catalog.fromRecord.
//
// The index layer is agnostic to the source — all constructors
// produce the same Catalog<S> interface. Secondary indexes and joins
// operate uniformly over any catalog.

import type {
  ChangeBase,
  Changeset,
  ReactiveMap,
  ReactiveMapHandle,
} from "@kyneta/changefeed"
import { createReactiveMap } from "@kyneta/changefeed"
import type { BoundSchema, Ref, SchemaNode } from "@kyneta/schema"
import { createDoc, subscribe, subscribeNode } from "@kyneta/schema"

// ---------------------------------------------------------------------------
// Change type
// ---------------------------------------------------------------------------

/**
 * A change to a catalog's keyed collection.
 *
 * - `"added"` — a new key appeared (the ref is now in the map)
 * - `"removed"` — a key was removed (the ref is no longer in the map)
 *
 * Idempotent replace (same key, different ref) does NOT emit — the
 * catalog treats it as a silent overwrite. Only structural membership
 * changes (key enters or leaves the collection) are observable.
 */
export type CatalogChange =
  | { readonly type: "added"; readonly key: string }
  | { readonly type: "removed"; readonly key: string }

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

/**
 * A reactive keyed collection of refs.
 *
 * `Catalog<S>` is a `ReactiveMap<string, Ref<S>, CatalogChange>` —
 * callable, subscribable, with `.get()`, `.has()`, `.keys()`, `.size`,
 * and iteration. The changefeed emits `CatalogChange` events when
 * entries are added or removed.
 */
export type Catalog<S extends SchemaNode> = ReactiveMap<
  string,
  Ref<S>,
  CatalogChange
>

/**
 * A catalog that supports document creation and deletion.
 *
 * Returned by `Catalog.create(bound)` and `Catalog.fromExchange()`.
 * Exposes `createDoc` (which creates a ref through the bound schema)
 * and `delete` — but NOT raw `set`. The catalog manages its own
 * entries; inserting arbitrary refs is not allowed.
 */
export interface WritableCatalog<S extends SchemaNode> extends Catalog<S> {
  /** Create a new document under the given key. Returns the ref. */
  createDoc(key: string): Ref<S>
  /** Remove an entry by key. Returns `true` if the key was present. */
  delete(key: string): boolean
  /** Tear down subscriptions and release resources. */
  dispose(): void
}

/**
 * Producer-side handle for a collected catalog.
 *
 * Returned by `Catalog.collect()` as the write side of the tuple.
 * The creator manages entries via `set` / `delete` — the catalog
 * automatically emits `CatalogChange` events. Refs can come from
 * any source (different exchanges, standalone createDoc, etc.).
 *
 * - `set(key, ref)` on a new key → emits `{ type: "added", key }`
 * - `set(key, ref)` on an existing key → no emit (idempotent replace)
 * - `delete(key)` on an existing key → emits `{ type: "removed", key }`, returns `true`
 * - `delete(key)` on a missing key → no emit, returns `false`
 */
export interface CatalogHandle<S extends SchemaNode> {
  /** Insert or replace a ref. Emits `"added"` only for new keys. */
  set(key: string, ref: Ref<S>): void
  /** Remove a ref by key. Emits `"removed"` if the key was present. */
  delete(key: string): boolean
}

// ---------------------------------------------------------------------------
// diffKeys — shared utility
// ---------------------------------------------------------------------------

/**
 * Diff two sets of string keys, returning the added and removed keys.
 *
 * Used by catalog constructors (`fromList`, `fromRecord`) and secondary
 * index grouping logic wherever "diff current keys against known keys"
 * is needed. Pure function — no side effects.
 */
export function diffKeys(
  oldKeys: ReadonlySet<string>,
  newKeys: ReadonlySet<string>,
): { added: string[]; removed: string[] } {
  const added: string[] = []
  const removed: string[] = []

  for (const key of newKeys) {
    if (!oldKeys.has(key)) added.push(key)
  }
  for (const key of oldKeys) {
    if (!newKeys.has(key)) removed.push(key)
  }

  return { added, removed }
}

// ---------------------------------------------------------------------------
// Catalog.collect — manual aggregation from arbitrary sources
// ---------------------------------------------------------------------------

/**
 * Collect refs from arbitrary sources into a single queryable catalog.
 *
 * Returns a tuple: the read-only `Catalog<S>` (for indexes and
 * consumers) and a `CatalogHandle<S>` (the write side for inserting
 * refs from any source). The handle's `set` / `delete` methods
 * automatically emit `CatalogChange` events.
 *
 * Use this when aggregating refs from multiple sources (e.g. two
 * exchanges, test harnesses, cross-boundary collections).
 */
function collect<S extends SchemaNode>(): [
  Catalog<S>,
  CatalogHandle<S>,
] {
  // Use `any` for the value parameter to avoid TS2589 — Ref<S> is a
  // deeply recursive conditional type that exceeds the instantiation
  // depth limit when threaded through ReactiveMapHandle generics.
  // Type safety is enforced at the public API boundary (CatalogHandle<S>).
  const [map, mapHandle] = createReactiveMap<string, any, CatalogChange>()

  const handle = {
    set(key: string, ref: any): void {
      const isNew = !map.has(key)
      mapHandle.set(key, ref)
      if (isNew) {
        mapHandle.emit({ changes: [{ type: "added", key }] })
      }
    },
    delete(key: string): boolean {
      if (!mapHandle.delete(key)) return false
      mapHandle.emit({ changes: [{ type: "removed", key }] })
      return true
    },
  } as unknown as CatalogHandle<S>

  return [map as Catalog<S>, handle]
}

/**
 * Create a writable catalog backed by a BoundSchema.
 *
 * Returns a single `WritableCatalog<S>` (no tuple) since the developer
 * is both producer and consumer. `createDoc(key)` creates a fresh
 * document via the bound schema, adds it to the catalog, and emits
 * `"added"`. `delete(key)` removes and emits `"removed"`.
 */
function createBound<S extends SchemaNode>(
  bound: BoundSchema<S>,
): WritableCatalog<S> {
  // Use `any` for the value parameter — same TS2589 rationale as createManual.
  const [map, mapHandle] = createReactiveMap<string, any, CatalogChange>()

  // Build the writable surface by attaching methods to the callable.
  const writable = map as any

  writable.createDoc = (key: string): Ref<S> => {
    if (map.has(key)) {
      throw new Error(
        `[catalog] Key "${key}" already exists. Use delete() first to replace.`,
      )
    }
    const ref = (createDoc as any)(bound)
    mapHandle.set(key, ref)
    mapHandle.emit({ changes: [{ type: "added", key }] })
    return ref as Ref<S>
  }

  writable.delete = (key: string): boolean => {
    if (!mapHandle.delete(key)) return false
    mapHandle.emit({ changes: [{ type: "removed", key }] })
    return true
  }

  writable.dispose = (): void => {
    // No subscriptions to clean up for a standalone catalog.
  }

  return writable as WritableCatalog<S>
}

// ---------------------------------------------------------------------------
// DisposableCatalog — read-only catalog with dispose
// ---------------------------------------------------------------------------

/**
 * A read-only catalog that can be disposed.
 *
 * Returned by `Catalog.fromList()` and `Catalog.fromRecord()` — the
 * source ref is the authority, so no `createDoc` or `delete` is exposed.
 */
export interface DisposableCatalog<S extends SchemaNode> extends Catalog<S> {
  /** Tear down all internal subscriptions. */
  dispose(): void
}

// ---------------------------------------------------------------------------
// Catalog.fromRecord — record ref → catalog
// ---------------------------------------------------------------------------

/**
 * Create a catalog from a record (map) ref.
 *
 * Each key in the record becomes a catalog entry. Structural changes
 * to the record (key added, key removed) are tracked reactively via
 * `subscribe`. The record ref is the source of truth.
 *
 * Returns a read-only `DisposableCatalog<S>`.
 */
function fromRecord<S extends SchemaNode>(
  recordRef: any,
): DisposableCatalog<S> {
  const [map, mapHandle] = createReactiveMap<string, any, CatalogChange>()

  // Track known keys for diffing on structural changes.
  const knownKeys = new Set<string>()

  // Build initial entries from the current record state.
  const keys: string[] = recordRef.keys()
  for (const key of keys) {
    const childRef = recordRef.at(key)
    mapHandle.set(key, childRef)
    knownKeys.add(key)
  }

  // Subscribe to structural changes on the record ref.
  const unsub = subscribe(recordRef, () => {
    const currentKeys: string[] = recordRef.keys()
    const currentSet = new Set(currentKeys)
    const { added, removed } = diffKeys(knownKeys, currentSet)

    const changes: CatalogChange[] = []

    for (const key of removed) {
      mapHandle.delete(key)
      knownKeys.delete(key)
      changes.push({ type: "removed", key })
    }

    for (const key of added) {
      const childRef = recordRef.at(key)
      mapHandle.set(key, childRef)
      knownKeys.add(key)
      changes.push({ type: "added", key })
    }

    if (changes.length > 0) {
      mapHandle.emit({ changes })
    }
  })

  // Attach dispose method.
  const catalog = map as any
  catalog.dispose = (): void => {
    unsub()
  }

  return catalog as DisposableCatalog<S>
}

// ---------------------------------------------------------------------------
// Catalog.fromList — sequence ref → catalog
// ---------------------------------------------------------------------------

/**
 * Create a catalog from a list (sequence) ref with a key extraction function.
 *
 * Each item in the list becomes a catalog entry keyed by `keyFn(item)()`.
 * The `keyFn` returns a scalar string ref whose current value is the key.
 *
 * Structural changes (push, insert, delete) and key value changes are
 * tracked reactively. The list ref is the source of truth.
 *
 * Returns a read-only `DisposableCatalog<S>`.
 */
function fromList<S extends SchemaNode>(
  listRef: any,
  keyFn: (itemRef: Ref<S>) => any,
): DisposableCatalog<S> {
  const [map, mapHandle] = createReactiveMap<string, any, CatalogChange>()

  // Track: key → itemRef, and per-item key subscriptions.
  const keyToRef = new Map<string, any>()
  const itemUnsubs = new Map<string, () => void>()

  // Subscribe to a single item's key ref for re-keying.
  function watchItemKey(itemRef: any, currentKey: string): void {
    const keyRef = keyFn(itemRef)
    const unsub = subscribeNode(keyRef, () => {
      const newKey: string = keyRef()
      if (newKey === currentKey) return

      const changes: CatalogChange[] = []

      // Remove old key
      mapHandle.delete(currentKey)
      keyToRef.delete(currentKey)
      changes.push({ type: "removed", key: currentKey })

      // Clean up old subscription
      const oldUnsub = itemUnsubs.get(currentKey)
      if (oldUnsub) {
        oldUnsub()
        itemUnsubs.delete(currentKey)
      }

      // Add under new key
      mapHandle.set(newKey, itemRef)
      keyToRef.set(newKey, itemRef)
      changes.push({ type: "added", key: newKey })

      // Re-watch under new key
      watchItemKey(itemRef, newKey)

      if (changes.length > 0) {
        mapHandle.emit({ changes })
      }
    })
    itemUnsubs.set(currentKey, unsub)
  }

  // Build initial entries.
  for (const itemRef of listRef) {
    const keyRef = keyFn(itemRef as Ref<S>)
    const key: string = keyRef()
    mapHandle.set(key, itemRef)
    keyToRef.set(key, itemRef)
    watchItemKey(itemRef, key)
  }

  // Subscribe to structural changes on the list ref.
  const listUnsub = subscribeNode(listRef, () => {
    // Re-iterate the list and diff against known keys.
    const currentKeys = new Set<string>()
    const currentByKey = new Map<string, any>()

    for (const itemRef of listRef) {
      const keyRef = keyFn(itemRef as Ref<S>)
      const key: string = keyRef()
      currentKeys.add(key)
      currentByKey.set(key, itemRef)
    }

    const { added, removed } = diffKeys(
      new Set(keyToRef.keys()),
      currentKeys,
    )

    const changes: CatalogChange[] = []

    for (const key of removed) {
      mapHandle.delete(key)
      keyToRef.delete(key)
      // Clean up key subscription
      const unsub = itemUnsubs.get(key)
      if (unsub) {
        unsub()
        itemUnsubs.delete(key)
      }
      changes.push({ type: "removed", key })
    }

    for (const key of added) {
      const itemRef = currentByKey.get(key)
      mapHandle.set(key, itemRef)
      keyToRef.set(key, itemRef)
      watchItemKey(itemRef, key)
      changes.push({ type: "added", key })
    }

    if (changes.length > 0) {
      mapHandle.emit({ changes })
    }
  })

  // Attach dispose method.
  const catalog = map as any
  catalog.dispose = (): void => {
    listUnsub()
    for (const unsub of itemUnsubs.values()) {
      unsub()
    }
    itemUnsubs.clear()
  }

  return catalog as DisposableCatalog<S>
}

// ---------------------------------------------------------------------------
// Catalog.fromExchange — exchange-backed catalog
// ---------------------------------------------------------------------------

/**
 * Mapping between exchange docIds and catalog keys.
 *
 * - `toKey(docId)` — convert a docId to a catalog key, or `null` to filter out
 * - `toDocId(key)` — convert a catalog key to a docId
 */
export interface CatalogMapping {
  toKey: (docId: string) => string | null
  toDocId: (key: string) => string
}

/**
 * Create a catalog backed by an exchange.
 *
 * Documents matching the BoundSchema's schemaHash are tracked via
 * scope registration (`onDocCreated`, `onDocDismissed`). The mapping
 * controls how docIds translate to catalog keys (and back).
 *
 * `createDoc(key)` creates the document in the exchange via
 * `exchange.get(toDocId(key), bound)`.
 *
 * Returns a `WritableCatalog<S>` with `createDoc`, `delete`, and `dispose`.
 */
function fromExchange<S extends SchemaNode>(
  exchange: any,
  bound: BoundSchema<S>,
  mapping: CatalogMapping,
): WritableCatalog<S> {
  const [map, mapHandle] = createReactiveMap<string, any, CatalogChange>()

  const schemaHash = bound.schemaHash

  // Helper: add a doc to the catalog if it matches our schema.
  function tryAdd(docId: string): void {
    const key = mapping.toKey(docId)
    if (key === null) return

    // Check schema hash — only track docs matching our bound.
    const docHash = exchange.getDocSchemaHash(docId)
    if (docHash !== undefined && docHash !== schemaHash) return

    if (map.has(key)) return

    const ref = exchange.get(docId, bound)
    mapHandle.set(key, ref)
    mapHandle.emit({ changes: [{ type: "added" as const, key }] })
  }

  // Helper: remove a doc from the catalog.
  function tryRemove(docId: string): void {
    const key = mapping.toKey(docId)
    if (key === null) return
    if (!mapHandle.delete(key)) return
    mapHandle.emit({ changes: [{ type: "removed" as const, key }] })
  }

  // Register the BoundSchema so matching remote docs are auto-resolved.
  exchange.registerSchema(bound)

  // Scan existing docs to catch docs created before the catalog.
  const existingIds: ReadonlySet<string> = exchange.documentIds()
  for (const docId of existingIds) {
    tryAdd(docId)
  }

  // Register a scope for lifecycle tracking.
  const disposeScope: () => void = exchange.register({
    onDocCreated(docId: string, _peer: any, mode: string, _origin: string) {
      if (mode !== "interpret") return
      tryAdd(docId)
    },
    onDocDismissed(docId: string, _peer: any, _origin: string) {
      tryRemove(docId)
    },
  })

  // Build the writable surface.
  const writable = map as any

  writable.createDoc = (key: string): any => {
    if (map.has(key)) {
      throw new Error(
        `[catalog] Key "${key}" already exists. Use delete() first to replace.`,
      )
    }
    const docId = mapping.toDocId(key)
    const ref = exchange.get(docId, bound)
    mapHandle.set(key, ref)
    mapHandle.emit({ changes: [{ type: "added" as const, key }] })
    return ref
  }

  writable.delete = (key: string): boolean => {
    if (!mapHandle.delete(key)) return false
    mapHandle.emit({ changes: [{ type: "removed" as const, key }] })
    return true
  }

  writable.dispose = (): void => {
    disposeScope()
  }

  return writable as WritableCatalog<S>
}

// ---------------------------------------------------------------------------
// Catalog namespace — typed facade
// ---------------------------------------------------------------------------

/**
 * Static method signatures for the `Catalog` namespace.
 *
 * Declared as an interface so TypeScript resolves the generic signatures
 * without instantiating `Ref<S>` at declaration depth (which triggers
 * TS2589). The runtime implementation uses `any` internally; the
 * type safety is enforced here at the call-site boundary.
 */
export interface CatalogStatic {
  /** Create a writable catalog backed by a BoundSchema. */
  create<S extends SchemaNode>(bound: BoundSchema<S>): WritableCatalog<S>
  /** Collect refs from arbitrary sources into a queryable catalog. */
  collect<S extends SchemaNode>(): [Catalog<S>, CatalogHandle<S>]
  /** Create a catalog from a record (map) ref. */
  fromRecord<S extends SchemaNode>(recordRef: any): DisposableCatalog<S>
  /** Create a catalog from a list (sequence) ref with key extraction. */
  fromList<S extends SchemaNode>(
    listRef: any,
    keyFn: (itemRef: any) => any,
  ): DisposableCatalog<S>
  /** Create a catalog from an exchange, tracking docs by BoundSchema. */
  fromExchange<S extends SchemaNode>(
    exchange: any,
    bound: BoundSchema<S>,
    mapping: CatalogMapping,
  ): WritableCatalog<S>
}

/**
 * Catalog constructors.
 *
 * ```ts
 * // Managed catalog — common path
 * const catalog = Catalog.create(MyBound)
 * const ref = catalog.createDoc("key")
 *
 * // Collect from arbitrary sources — power-user path
 * const [catalog, handle] = Catalog.collect<typeof MySchema>()
 * handle.set("key", refFromExchangeA)
 *
 * // From a record ref
 * const catalog = Catalog.fromRecord(doc.members)
 *
 * // From a list ref with key extraction
 * const catalog = Catalog.fromList(doc.items, (item) => item.id)
 * ```
 */
export const Catalog = {
  create(bound: any): any {
    return createBound(bound)
  },
  collect,
  fromRecord,
  fromList,
  fromExchange,
} as unknown as CatalogStatic