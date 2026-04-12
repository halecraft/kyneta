// secondary-index — reactive grouping over a catalog.
//
// A SecondaryIndex<S> groups catalog entries by one or more derived
// "group keys". Three flavors cover the common cases:
//
// - Index.by(catalog, keyFn)        — scalar FK grouping (one group per entry)
// - Index.byKeys(catalog, keyFn)    — record fan-out (entry in N groups)
// - Index.byIdentity(catalog)       — trivial identity (catalogKey = groupKey)
//
// All three are built on a shared `createSecondaryIndex` factory that
// subscribes to the catalog changefeed and optionally watches individual
// entries for re-indexing.

import type { Changeset } from "@kyneta/changefeed"
import { createChangefeed } from "@kyneta/changefeed"
import type { Ref, SchemaNode } from "@kyneta/schema"
import { subscribe, subscribeNode } from "@kyneta/schema"
import type { Catalog, CatalogChange } from "./catalog.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single entry in a secondary index group — the catalog key and
 * the live ref it points to.
 */
export interface IndexEntry<S extends SchemaNode> {
  readonly key: string
  readonly ref: Ref<S>
}

/**
 * A change to a secondary index's group structure.
 *
 * - `"group-added"` — an entry joined a group
 * - `"group-removed"` — an entry left a group
 */
export type SecondaryIndexChange =
  | { readonly type: "group-added"; readonly groupKey: string; readonly entryKey: string }
  | { readonly type: "group-removed"; readonly groupKey: string; readonly entryKey: string }

/**
 * A reactive secondary index over a catalog.
 *
 * Groups catalog entries by derived keys. Supports lookup by group
 * key, reverse lookup (which groups does an entry belong to), and
 * subscription to structural group changes.
 */
export interface SecondaryIndex<S extends SchemaNode> {
  /** All entries in the given group. */
  lookup(groupKey: string): IndexEntry<S>[]
  /** Which group keys a catalog entry belongs to. */
  groupKeysFor(catalogKey: string): string[]
  /** All distinct group keys. */
  keys(): string[]
  /** Count of distinct group keys. */
  readonly size: number
  /** Subscribe to group membership changes. Returns an unsubscribe function. */
  subscribe(cb: (changeset: Changeset<SecondaryIndexChange>) => void): () => void
  /** Tear down all subscriptions and release resources. */
  dispose(): void
}

// ---------------------------------------------------------------------------
// regroupEntry — pure grouping diff (functional core)
// ---------------------------------------------------------------------------

/**
 * Compute the changes when an entry's group keys change from
 * `oldKeys` to `newKeys`.
 *
 * Pure function — no side effects. Returns an array of
 * `SecondaryIndexChange` describing which groups the entry
 * was added to and removed from.
 */
export function regroupEntry(
  catalogKey: string,
  oldKeys: string[],
  newKeys: string[],
): SecondaryIndexChange[] {
  const oldSet = new Set(oldKeys)
  const newSet = new Set(newKeys)
  const changes: SecondaryIndexChange[] = []

  for (const key of oldKeys) {
    if (!newSet.has(key)) {
      changes.push({ type: "group-removed", groupKey: key, entryKey: catalogKey })
    }
  }
  for (const key of newKeys) {
    if (!oldSet.has(key)) {
      changes.push({ type: "group-added", groupKey: key, entryKey: catalogKey })
    }
  }

  return changes
}

// ---------------------------------------------------------------------------
// createSecondaryIndex — imperative shell
// ---------------------------------------------------------------------------

/**
 * Shared factory that all three index types use.
 *
 * Subscribes to the catalog changefeed for `added`/`removed` events,
 * maintains internal group maps, and optionally installs per-entry
 * watchers for re-indexing when an entry's group keys change.
 */
function createSecondaryIndex<S extends SchemaNode>(
  catalog: Catalog<S>,
  getGroupKeys: (catalogKey: string, ref: any) => string[],
  watchEntry?: (catalogKey: string, ref: any, onRegroup: () => void) => (() => void),
): SecondaryIndex<S> {
  // groupKey → set of catalogKeys
  const groups = new Map<string, Set<string>>()
  // catalogKey → current list of groupKeys (reverse map)
  const entryGroups = new Map<string, string[]>()
  // catalogKey → watcher unsubscribe
  const entryUnsubs = new Map<string, () => void>()

  // Changefeed for notifying subscribers of group changes.
  const [feed, emitFeed] = createChangefeed<null, SecondaryIndexChange>(
    () => null,
  )

  // -- Internal helpers --

  function addToGroup(groupKey: string, catalogKey: string): void {
    let set = groups.get(groupKey)
    if (!set) {
      set = new Set()
      groups.set(groupKey, set)
    }
    set.add(catalogKey)
  }

  function removeFromGroup(groupKey: string, catalogKey: string): void {
    const set = groups.get(groupKey)
    if (!set) return
    set.delete(catalogKey)
    if (set.size === 0) {
      groups.delete(groupKey)
    }
  }

  function addEntry(catalogKey: string, ref: any): SecondaryIndexChange[] {
    const groupKeys = getGroupKeys(catalogKey, ref)
    entryGroups.set(catalogKey, groupKeys)

    const changes: SecondaryIndexChange[] = []
    for (const gk of groupKeys) {
      addToGroup(gk, catalogKey)
      changes.push({ type: "group-added", groupKey: gk, entryKey: catalogKey })
    }

    // Install per-entry watcher if provided.
    if (watchEntry) {
      const unsub = watchEntry(catalogKey, ref, () => {
        handleRegroup(catalogKey, ref)
      })
      entryUnsubs.set(catalogKey, unsub)
    }

    return changes
  }

  function removeEntry(catalogKey: string): SecondaryIndexChange[] {
    const oldKeys = entryGroups.get(catalogKey) ?? []
    entryGroups.delete(catalogKey)

    const changes: SecondaryIndexChange[] = []
    for (const gk of oldKeys) {
      removeFromGroup(gk, catalogKey)
      changes.push({ type: "group-removed", groupKey: gk, entryKey: catalogKey })
    }

    // Unsubscribe per-entry watcher.
    const unsub = entryUnsubs.get(catalogKey)
    if (unsub) {
      unsub()
      entryUnsubs.delete(catalogKey)
    }

    return changes
  }

  function handleRegroup(catalogKey: string, ref: any): void {
    const oldKeys = entryGroups.get(catalogKey) ?? []
    const newKeys = getGroupKeys(catalogKey, ref)
    const changes = regroupEntry(catalogKey, oldKeys, newKeys)

    if (changes.length === 0) return

    // Apply structural changes.
    for (const change of changes) {
      if (change.type === "group-removed") {
        removeFromGroup(change.groupKey, catalogKey)
      } else {
        addToGroup(change.groupKey, catalogKey)
      }
    }
    entryGroups.set(catalogKey, newKeys)

    emitFeed({ changes })
  }

  // -- Bootstrap: index all existing catalog entries --

  const bootstrapChanges: SecondaryIndexChange[] = []
  for (const [catalogKey, ref] of catalog as any) {
    bootstrapChanges.push(...addEntry(catalogKey, ref))
  }
  // We don't emit bootstrap changes — subscribers join after construction.

  // -- Subscribe to catalog changefeed --

  const catalogUnsub = catalog.subscribe((changeset: Changeset<CatalogChange>) => {
    const indexChanges: SecondaryIndexChange[] = []

    for (const change of changeset.changes) {
      if (change.type === "added") {
        const ref = (catalog as any).get(change.key)
        if (ref !== undefined) {
          indexChanges.push(...addEntry(change.key, ref))
        }
      } else if (change.type === "removed") {
        indexChanges.push(...removeEntry(change.key))
      }
    }

    if (indexChanges.length > 0) {
      emitFeed({ changes: indexChanges })
    }
  })

  // -- Public interface --

  const index: SecondaryIndex<S> = {
    lookup(groupKey: string): IndexEntry<S>[] {
      const set = groups.get(groupKey)
      if (!set) return []
      const entries: any[] = []
      for (const catalogKey of set) {
        const ref = (catalog as any).get(catalogKey)
        if (ref !== undefined) {
          entries.push({ key: catalogKey, ref })
        }
      }
      return entries
    },

    groupKeysFor(catalogKey: string): string[] {
      return entryGroups.get(catalogKey) ?? []
    },

    keys(): string[] {
      return [...groups.keys()]
    },

    get size(): number {
      return groups.size
    },

    subscribe(cb: (changeset: Changeset<SecondaryIndexChange>) => void): () => void {
      return feed.subscribe(cb)
    },

    dispose(): void {
      catalogUnsub()
      for (const unsub of entryUnsubs.values()) {
        unsub()
      }
      entryUnsubs.clear()
    },
  }

  return index
}

// ---------------------------------------------------------------------------
// Index.by — scalar FK grouping
// ---------------------------------------------------------------------------

/**
 * Create a secondary index that groups catalog entries by a scalar
 * foreign key. Each entry belongs to exactly one group.
 *
 * ```ts
 * const byAuthor = Index.by(catalog, (ref) => ref.authorId)
 * byAuthor.lookup("alice")  // all entries with authorId = "alice"
 * ```
 */
function by(catalog: any, keyFn: (ref: any) => any): SecondaryIndex<any> {
  return createSecondaryIndex(
    catalog,
    (_catalogKey, ref) => {
      const value = keyFn(ref)()
      return [String(value)]
    },
    (_catalogKey, ref, onRegroup) => {
      return subscribeNode(keyFn(ref), onRegroup)
    },
  )
}

// ---------------------------------------------------------------------------
// Index.byKeys — record fan-out grouping
// ---------------------------------------------------------------------------

/**
 * Create a secondary index that groups catalog entries by the keys
 * of a record (map) ref. Each entry can belong to multiple groups.
 *
 * ```ts
 * const byTag = Index.byKeys(catalog, (ref) => ref.tags)
 * byTag.lookup("urgent")  // all entries with "urgent" in their tags map
 * ```
 */
function byKeys(catalog: any, keyFn: (ref: any) => any): SecondaryIndex<any> {
  return createSecondaryIndex(
    catalog,
    (_catalogKey, ref) => {
      const mapRef = keyFn(ref)
      return [...mapRef.keys()]
    },
    (_catalogKey, ref, onRegroup) => {
      return subscribe(keyFn(ref), onRegroup)
    },
  )
}

// ---------------------------------------------------------------------------
// Index.byIdentity — trivial identity index
// ---------------------------------------------------------------------------

/**
 * Create a secondary index where each catalog key IS the group key.
 *
 * Useful as a building block for joins where no transformation is
 * needed — the catalog key itself is the join key.
 *
 * ```ts
 * const byId = Index.byIdentity(catalog)
 * byId.lookup("doc-123")  // [{key: "doc-123", ref: ...}]
 * ```
 */
function byIdentity(catalog: any): SecondaryIndex<any> {
  return createSecondaryIndex(
    catalog,
    (catalogKey, _ref) => [catalogKey],
    // No watchEntry — catalog add/remove is sufficient.
  )
}

// ---------------------------------------------------------------------------
// Index namespace — typed facade
// ---------------------------------------------------------------------------

/**
 * Static method signatures for the `Index` namespace.
 *
 * Declared as an interface so TypeScript resolves the generic signatures
 * without instantiating `Ref<S>` at declaration depth (which triggers
 * TS2589). The runtime implementation uses `any` internally; type
 * safety is enforced here at the call-site boundary.
 */
export interface IndexStatic {
  /** Group by a scalar FK — one group per entry. */
  by<S extends SchemaNode>(
    catalog: Catalog<S>,
    keyFn: (ref: Ref<S>) => any,
  ): SecondaryIndex<S>
  /** Group by record keys — entry fans out to N groups. */
  byKeys<S extends SchemaNode>(
    catalog: Catalog<S>,
    keyFn: (ref: Ref<S>) => any,
  ): SecondaryIndex<S>
  /** Identity index — catalogKey = groupKey. */
  byIdentity<S extends SchemaNode>(catalog: Catalog<S>): SecondaryIndex<S>
}

/**
 * Secondary index constructors.
 *
 * ```ts
 * // Scalar FK grouping
 * const byAuthor = Index.by(catalog, (ref) => ref.authorId)
 *
 * // Record fan-out grouping
 * const byTag = Index.byKeys(catalog, (ref) => ref.tags)
 *
 * // Identity index
 * const byId = Index.byIdentity(catalog)
 * ```
 */
export const Index = {
  by,
  byKeys,
  byIdentity,
} as unknown as IndexStatic