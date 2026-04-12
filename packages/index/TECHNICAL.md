# @kyneta/index — Technical Reference

Reactive indexing over keyed collections of refs. Provides `Catalog` (source-agnostic reactive collection), `SecondaryIndex` (grouping by derived keys), and `JoinIndex` (composition of two secondary indexes over a shared key space).

---

## 1. Architecture Overview

The package is organized in three layers, each building on the one below:

```
┌─────────────────────────────────────────────────┐
│  JoinIndex<L, R>                                │
│  Pure composition — delegates to two             │
│  SecondaryIndex instances, maintains no state    │
├─────────────────────────────────────────────────┤
│  SecondaryIndex<S>                              │
│  Reactive grouping — subscribes to catalog       │
│  changefeed + optional per-entry watchers        │
├─────────────────────────────────────────────────┤
│  Catalog<S>                                     │
│  Reactive keyed collection of refs — source-     │
│  agnostic, five constructors                     │
└─────────────────────────────────────────────────┘
```

All three layers participate in the `[CHANGEFEED]` protocol from `@kyneta/changefeed`:

| Layer | Type | Changefeed events |
|-------|------|-------------------|
| `Catalog<S>` | `ReactiveMap<string, Ref<S>, CatalogChange>` | `added`, `removed` |
| `SecondaryIndex<S>` | Custom interface with `.subscribe()` | `group-added`, `group-removed` |
| `JoinIndex<L, R>` | Custom interface with `.subscribe()` | Re-emits `SecondaryIndexChange` from both sides |

**Dependency graph:** `@kyneta/index` depends on `@kyneta/changefeed` (for `ReactiveMap`, `createReactiveMap`, `createChangefeed`) and peer-depends on `@kyneta/schema` (for `Ref<S>`, `SchemaNode`, `BoundSchema`, `subscribe`, `subscribeNode`, `createDoc`). The dependency on `@kyneta/exchange` is optional — only `Catalog.fromExchange` requires it.

---

## 2. The 13 Concerns

A thorough analysis identified 13 top-level concerns for cross-document relationships. This package addresses 9 of them directly.

| # | Concern | Status | Notes |
|---|---------|--------|-------|
| 1 | Doc → Doc | ✅ Addressed | Catalog maps keys to refs; secondary index resolves FK strings |
| 2 | Ref → Doc | ✅ Addressed | `Index.by(catalog, ref => ref.foreignKey)` — scalar FK grouping |
| 3 | Ref → Ref | ✅ Addressed | `Index.join` composes two indexes; `lookup` traverses left → right |
| 4 | Temporal references | ⏳ Deferred | Requires `(DocId, Version)` pairs — not yet implemented |
| 5 | Join semantics | ✅ Addressed | `lookup` returns `[]` for missing groups (left-join behavior) |
| 6 | Bidirectional indexing | ✅ Addressed | `JoinIndex.lookup` (forward) and `JoinIndex.reverse` (backward) |
| 7 | Cardinality | ✅ Addressed | `by` (1:N), `byKeys` (M:N), `byIdentity` (1:1) |
| 8 | Data readiness | ✅ Addressed | Missing docs → empty lookup results; arrival triggers changefeed |
| 9 | Reactive joins | ⏳ Deferred | Join re-emits index changefeeds but does not propagate value-level changes |
| 10 | Scope / visibility | ⏳ Deferred | No filtering by peer visibility |
| 11 | Lifecycle coupling | ⏳ Deferred | No cascading delete/dismiss semantics |
| 12 | Cross-document indexing | ✅ Addressed | `SecondaryIndex` is the derived reverse-lookup structure |
| 13 | Identity and keys | ✅ Addressed | `CatalogMapping` controls key identity; `keyFn` extracts stable keys |

---

## 3. Catalog — Reactive Keyed Collection of Refs

`Catalog<S>` is a `ReactiveMap<string, Ref<S>, CatalogChange>` — callable, iterable, subscribable, with `.get()`, `.has()`, `.keys()`, `.size`, and a changefeed that emits structural membership changes (`added`, `removed`).

The catalog is source-agnostic. The same `Catalog<S>` interface is produced regardless of how entries are populated. Secondary indexes and joins operate uniformly over any catalog — they do not know or care whether the refs came from an exchange, a list field inside a document, a record field, or manual insertion.

Only structural membership changes are observable. Idempotent replace (same key, different ref) does not emit — the catalog treats it as a silent overwrite.

### Five Constructors

#### `Catalog.create()` — Manual, No Subscriptions

```ts
const [catalog, handle] = Catalog.create<MySchema>()
handle.set("key", ref)    // emits { type: "added", key: "key" }
handle.delete("key")      // emits { type: "removed", key: "key" }
```

Returns a `[Catalog<S>, CatalogHandle<S>]` tuple. The producer manages entries via the handle; the catalog is read-only. No internal subscriptions — the producer is responsible for all mutations.

#### `Catalog.create(bound)` — Manual with `createDoc`

```ts
const catalog = Catalog.create(MyBound)
const ref = catalog.createDoc("key")   // creates via BoundSchema, emits "added"
catalog.delete("key")                  // emits "removed"
```

Returns a `WritableCatalog<S>` (no tuple). `createDoc(key)` calls `createDoc(bound)` from `@kyneta/schema`, inserts into the internal map, and emits `"added"`. Duplicate keys throw.

#### `Catalog.fromRecord(recordRef)` — Subscribes to Record Structural Changes

```ts
const catalog = Catalog.fromRecord(doc.members)
```

Returns a `DisposableCatalog<S>`. Each key in the record ref becomes a catalog entry. Uses `subscribe(recordRef, ...)` to track structural changes — keys added to or removed from the record trigger `CatalogChange` events. The record ref is the source of truth; no `createDoc` or `delete` is exposed.

**Subscription strategy:** One `subscribe` call on the record ref. On each notification, diffs current keys against known keys via `diffKeys()`, then applies additions and removals.

#### `Catalog.fromList(listRef, keyFn)` — Subscribes to List + Per-Item Key Changes

```ts
const catalog = Catalog.fromList(doc.items, (item) => item.id)
```

Returns a `DisposableCatalog<S>`. Each item in the list becomes a catalog entry keyed by `keyFn(item)()` — where `keyFn` returns a scalar string ref. Two subscription layers:

1. **Structural:** `subscribe(listRef, ...)` — fires when items are added or removed from the list. On each notification, re-iterates the list, diffs against known keys, and applies changes.
2. **Per-item key:** `subscribeNode(keyFn(itemRef), ...)` — fires when a single item's key value changes. Handles re-keying: removes the old key, adds the new key, and re-installs the watcher under the new key.

The combination means the catalog stays synchronized with both list membership and individual key mutations.

#### `Catalog.fromExchange(exchange, bound, mapping)` — Subscribes via Scope Registration

```ts
const catalog = Catalog.fromExchange(exchange, MyBound, {
  toKey: (docId) => docId.replace("doc:", ""),
  toDocId: (key) => `doc:${key}`,
})
```

Returns a `WritableCatalog<S>`. Integrates with the exchange lifecycle via `exchange.register()` (see §6). Documents matching the bound schema's `schemaHash` are tracked. `createDoc(key)` creates documents through the exchange.

---

## 4. Secondary Index — FC/IS Decomposition

The secondary index follows a functional core / imperative shell decomposition.

### Functional Core: `regroupEntry`

```ts
function regroupEntry(
  catalogKey: string,
  oldKeys: string[],
  newKeys: string[],
): SecondaryIndexChange[]
```

Pure function. Given a catalog key and its previous and current group keys, computes the diff — which groups the entry was added to and removed from. No side effects, no internal state. Returns an array of `SecondaryIndexChange` events (`group-added`, `group-removed`).

### Imperative Shell: `createSecondaryIndex`

```ts
function createSecondaryIndex<S extends SchemaNode>(
  catalog: Catalog<S>,
  getGroupKeys: (catalogKey: string, ref: any) => string[],
  watchEntry?: (catalogKey: string, ref: any, onRegroup: () => void) => (() => void),
): SecondaryIndex<S>
```

Shared factory that all three index flavors use. Maintains two internal maps:

| Map | Type | Purpose |
|-----|------|---------|
| `groups` | `Map<string, Set<string>>` | groupKey → set of catalogKeys |
| `entryGroups` | `Map<string, string[]>` | catalogKey → current groupKeys (reverse map) |

**Lifecycle:**

1. **Bootstrap** — iterates existing catalog entries via `for (const [key, ref] of catalog)`, calls `getGroupKeys` and `addEntry` for each. Bootstrap changes are not emitted (subscribers join after construction).
2. **Catalog subscription** — subscribes to `catalog.subscribe()`. On `added`, calls `addEntry`. On `removed`, calls `removeEntry`. Emits accumulated changes via the changefeed.
3. **Per-entry watchers** (optional) — if `watchEntry` is provided, `addEntry` installs a watcher that calls `handleRegroup` when triggered. `handleRegroup` calls `regroupEntry` (the pure function), applies the structural diff, and emits changes.
4. **Dispose** — unsubscribes from the catalog changefeed and all per-entry watchers.

### Three Flavors

| Constructor | `getGroupKeys` | `watchEntry` | Use case |
|-------------|----------------|--------------|----------|
| `Index.by(catalog, keyFn)` | `[String(keyFn(ref)())]` | `subscribeNode(keyFn(ref), onRegroup)` | Scalar FK — one group per entry |
| `Index.byKeys(catalog, keyFn)` | `[...keyFn(ref).keys()]` | `subscribe(keyFn(ref), onRegroup)` | Record fan-out — N groups per entry |
| `Index.byIdentity(catalog)` | `[catalogKey]` | None | Identity — catalogKey = groupKey |

**Why `subscribeNode` vs `subscribe`:**

- `Index.by` watches a scalar field (e.g. `ref.authorId`). The field is a leaf node — `subscribeNode` watches the node itself for value changes.
- `Index.byKeys` watches a record field (e.g. `ref.tags`). The record is a structural node — `subscribe` watches for key additions/removals (structural changes to the record).
- `Index.byIdentity` needs no watcher — the catalog key is the group key, so catalog `added`/`removed` events are sufficient.

---

## 5. Join as Pure Composition

`JoinIndex<L, R>` bridges two `SecondaryIndex` instances that share a common group-key space. It maintains no state of its own — all data lives in the two underlying indexes.

### Lookup Traversal

```
lookup(leftKey):
  leftKey → leftIndex.groupKeysFor(leftKey) → [gk₁, gk₂, ...]
    → for each gk: rightIndex.lookup(gk) → [{ key, ref }, ...]
  → flat array of JoinResult<R>

reverse(rightKey):
  rightKey → rightIndex.groupKeysFor(rightKey) → [gk₁, gk₂, ...]
    → for each gk: leftIndex.lookup(gk) → [{ key, ref }, ...]
  → flat array of JoinResult<L>
```

Missing groups return `[]` — this is left-join semantics. There is no inner-join variant; the consumer filters.

### Changefeed

The join creates a single changefeed via `createChangefeed` and subscribes to both underlying indexes. Changes from either side are re-emitted verbatim. This means a single `join.subscribe(cb)` call covers structural changes on both the left and right side of the join.

### Dispose

`join.dispose()` unsubscribes from both underlying changefeeds, then calls `dispose()` on both underlying indexes. The join owns its indexes — disposing the join disposes the indexes.

---

## 6. Exchange Integration

`Catalog.fromExchange` is the bridge between the exchange's document lifecycle and the index layer.

### Scope Registration

Calls `exchange.register(scope)` with an anonymous scope providing two callbacks:

- **`onDocCreated(docId, peer, mode, origin)`** — when `mode === "interpret"`, calls `tryAdd(docId)`. The `"interpret"` filter ensures only documents that have been locally interpreted (i.e., have a live substrate and ref) are tracked.
- **`onDocDismissed(docId, peer, origin)`** — calls `tryRemove(docId)`.

The scope's `disposeScope` function is stored and called from `catalog.dispose()`.

### Schema Registration

Before scanning existing documents, calls `exchange.registerSchema(bound)` so that matching remote documents arriving via sync are automatically resolved (interpreted) — which in turn fires `onDocCreated` with `mode: "interpret"`, adding them to the catalog.

### Bootstrap

Calls `exchange.documentIds()` to get the current set of known docIds. For each, calls `tryAdd(docId)`, which:

1. Applies `mapping.toKey(docId)` — returns `null` to filter the doc out.
2. Checks `exchange.getDocSchemaHash(docId)` — skips docs whose schema hash doesn't match the bound's `schemaHash`.
3. Calls `exchange.get(docId, bound)` to obtain the ref.
4. Inserts into the reactive map and emits `"added"`.

### Key Mapping via `CatalogMapping`

```ts
interface CatalogMapping {
  toKey: (docId: string) => string | null
  toDocId: (key: string) => string
}
```

- `toKey` — converts a docId to a catalog key. Return `null` to exclude the document.
- `toDocId` — converts a catalog key back to a docId. Used by `createDoc(key)`.

This supports namespace translation (e.g. stripping a `"doc:"` prefix), filtering (only track docIds matching a pattern), and bidirectional round-tripping.

### Dispose Lifecycle

`catalog.dispose()` calls the `disposeScope()` function returned by `exchange.register()`. This removes the scope's `onDocCreated` and `onDocDismissed` callbacks from the exchange's scope registry. No further lifecycle events will be delivered after disposal.

---

## 7. TS2589 and `Ref<S>`

`Ref<S extends SchemaNode>` is a deeply recursive conditional type that maps a schema tree to a tree of reactive accessors. When threaded through generic containers — `ReactiveMap<string, Ref<S>, C>`, `ReactiveMapHandle<string, Ref<S>, C>`, etc. — TypeScript's type instantiation hits the depth limit and emits TS2589: "Type instantiation is excessively deep and possibly infinite."

The solution is a consistent pattern used throughout the package:

1. **Internal implementations use `any` for the value parameter.** `createReactiveMap<string, any, CatalogChange>()` avoids threading `Ref<S>` through the generic machinery.

2. **Public interfaces enforce type safety at the call-site boundary.** `CatalogStatic` and `IndexStatic` are declared as interfaces with explicit generic signatures. The runtime objects are cast via `as unknown as CatalogStatic` / `as unknown as IndexStatic`.

3. **Type safety is not sacrificed — it's relocated.** Consumers see fully typed APIs. The `any` is confined to the internal implementation where the type system cannot resolve the recursive depth.

Example from `catalog.ts`:

```ts
// Internal: any avoids TS2589
const [map, mapHandle] = createReactiveMap<string, any, CatalogChange>()

// Public: typed at the boundary
export const Catalog = {
  create(bound?: any): any { ... },
  fromRecord,
  fromList,
  fromExchange,
} as unknown as CatalogStatic
```

Example from `secondary-index.ts`:

```ts
// Internal: any in the factory signature
function createSecondaryIndex<S extends SchemaNode>(
  catalog: Catalog<S>,
  getGroupKeys: (catalogKey: string, ref: any) => string[],
  watchEntry?: (catalogKey: string, ref: any, onRegroup: () => void) => (() => void),
): SecondaryIndex<S>

// Public: typed at the boundary
export const Index = {
  by,
  byKeys,
  byIdentity,
} as unknown as IndexStatic
```

The same pattern appears in test files, which use `as any` casts on refs and catalogs at construction sites.

---

## 8. Deferred Concerns

The following capabilities are not implemented. They build on the primitives introduced here but are not required for the foundational layer.

### Temporal References (Concern 4)

A `(DocId, Version)` pair that pins a reference to a specific causal moment. Requires version-aware lookup — "give me the ref as it was at version V." This needs substrate-level support for version snapshots, which does not exist yet.

### Reactive Joins at the Value Level (Concern 9)

The current `JoinIndex` re-emits structural changes from both underlying indexes (group membership changes). It does not propagate value-level changes — if a right-side ref's content changes, subscribers of the join are not notified. True reactive joins would require subscribing to every ref on both sides of the join and emitting value-level changesets. This is deferred because the cost model (N×M subscriptions) needs careful design.

### Scope / Visibility (Concern 10)

A peer may see one side of a reference but not the other (e.g. access to a thread but not its parent conversation). The index layer currently has no visibility filtering — all entries in a catalog are visible to all consumers. Integrating with the exchange's `route` / `authorize` predicates is future work.

### Lifecycle Coupling (Concern 11)

When a document is dismissed or deleted, what happens to references that point to it? Currently: nothing. The secondary index removes the entry (via catalog `"removed"` → `group-removed`), but there is no cascading delete, no dangling-reference cleanup, no tombstone protocol. This is a policy decision that belongs above the index layer.

---

## 9. File Map

| File | Purpose |
|------|---------|
| `src/catalog.ts` | `Catalog<S>`, `CatalogChange`, five constructors, `diffKeys` |
| `src/secondary-index.ts` | `SecondaryIndex<S>`, `regroupEntry`, `createSecondaryIndex`, `Index.by`/`byKeys`/`byIdentity` |
| `src/join-index.ts` | `JoinIndex<L, R>`, `join()` factory |
| `src/index.ts` | Barrel — augments `Index` with `join`, re-exports everything |

### Test Files

| File | Coverage |
|------|----------|
| `src/__tests__/catalog.test.ts` | `diffKeys`, manual catalog, bound catalog, `fromRecord`, `fromList` |
| `src/__tests__/secondary-index.test.ts` | `regroupEntry`, `Index.by`, `Index.byKeys`, `Index.byIdentity` |
| `src/__tests__/join-index.test.ts` | `Index.join` — forward lookup, reverse lookup, changefeed, dispose |