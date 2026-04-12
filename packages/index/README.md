# @kyneta/index

Reactive catalogs, secondary indexes, and joins over document collections. Turn any source of refs — manual, record, list, or exchange-backed — into a queryable, incrementally-updated collection.

```ts
import { Catalog, Index } from "@kyneta/index"
import { json, Schema, change } from "@kyneta/schema"

const Task = json.bind(Schema.struct({
  title: Schema.string(),
  ownerId: Schema.string(),
}))

const catalog = Catalog.create(Task)
const t1 = catalog.createDoc("task:1")
change(t1, (d) => { d.title.set("Ship it"); d.ownerId.set("user:alice") })

const byOwner = Index.by(catalog, (ref) => ref.ownerId)
byOwner.lookup("user:alice")  // [{ key: "task:1", ref: t1 }]
```

Catalogs are reactive keyed collections of refs. Secondary indexes group catalog entries by derived keys. Joins compose two indexes over a shared key space. Everything updates incrementally — add a document, change a foreign key, delete an entry — downstream indexes and joins reflect the change immediately.

---

## Quick Start

The simplest case: a manually-populated catalog with a secondary index. No exchange, no network — just local documents.

```ts
import { Catalog, Index } from "@kyneta/index"
import { json, Schema, change } from "@kyneta/schema"

const Item = json.bind(Schema.struct({
  name: Schema.string(),
  ownerId: Schema.string(),
}))

// 1. Create a catalog backed by a BoundSchema
const catalog = Catalog.create(Item)

// 2. Populate it
const ref1 = catalog.createDoc("item:1")
change(ref1, (d) => { d.name.set("Hammer"); d.ownerId.set("user:alice") })

const ref2 = catalog.createDoc("item:2")
change(ref2, (d) => { d.name.set("Wrench"); d.ownerId.set("user:bob") })

// 3. Build a secondary index on ownerId
const byOwner = Index.by(catalog, (ref) => ref.ownerId)

byOwner.lookup("user:alice")  // [{ key: "item:1", ref: ref1 }]
byOwner.lookup("user:bob")    // [{ key: "item:2", ref: ref2 }]
byOwner.keys()                // ["user:alice", "user:bob"]
byOwner.size                  // 2

// 4. Mutate a foreign key — the index updates automatically
change(ref1, (d) => d.ownerId.set("user:bob"))
byOwner.lookup("user:alice")  // []
byOwner.lookup("user:bob")    // [{ key: "item:1", ... }, { key: "item:2", ... }]
```

---

## Catalog

A `Catalog<S>` is a reactive keyed collection of `Ref<S>` values. It's a `ReactiveMap` — callable, iterable, subscribable — with `.get()`, `.has()`, `.keys()`, `.size`, and a changefeed that emits `added` / `removed` events.

The catalog is source-agnostic. Five constructors produce the same `Catalog<S>` interface; secondary indexes and joins work identically over any of them.

### `Catalog.create(bound)` — managed catalog

The common path. Returns a `WritableCatalog<S>` that owns document creation. `createDoc(key)` creates a ref via the BoundSchema, adds it, and emits `"added"`.

```ts
const catalog = Catalog.create(MyBound)

const ref = catalog.createDoc("doc:1")  // creates via BoundSchema, emits "added"
catalog.delete("doc:1")                 // emits "removed"
```

### `Catalog.collect()` — manual aggregation

Power-user path. Returns a `[Catalog<S>, CatalogHandle<S>]` tuple. The handle accepts refs from any source — different exchanges, standalone `createDoc` calls, etc. Use this when aggregating refs from multiple sources into one queryable collection.

```ts
const [catalog, handle] = Catalog.collect<typeof MySchema>()

handle.set("key-1", refFromExchangeA)  // emits { type: "added", key: "key-1" }
handle.set("key-1", refReplacement)    // silent — key already exists (idempotent replace)
handle.delete("key-1")                 // emits { type: "removed", key: "key-1" }
```

### `Catalog.fromRecord(ref)` — from a record ref

Tracks the keys of a record (map) ref. The record is the source of truth — structural changes (key added, key removed) propagate reactively.

```ts
const catalog = Catalog.fromRecord<typeof MemberSchema>(doc.members)

// catalog.keys() mirrors doc.members.keys()
// Adding/removing keys on doc.members automatically updates the catalog
```

Returns a `DisposableCatalog<S>` (read-only + `dispose()`).

### `Catalog.fromList(ref, keyFn)` — from a list ref

Tracks items in a list ref, using `keyFn` to extract a stable string key from each item. Structural changes (push, insert, delete) and key mutations are both tracked reactively.

```ts
const catalog = Catalog.fromList<typeof TodoSchema>(doc.todos, (item) => item.id)

// Each item in doc.todos becomes a catalog entry keyed by item.id()
// If an item's id changes, the catalog re-keys it automatically
```

Returns a `DisposableCatalog<S>` (read-only + `dispose()`).

### `Catalog.fromExchange(exchange, bound, mapping)` — from an exchange

Tracks documents in an exchange that match the given `BoundSchema`. The `CatalogMapping` controls the docId ↔ catalog key translation.

```ts
import { Exchange } from "@kyneta/exchange"

const catalog = Catalog.fromExchange(exchange, TaskBound, {
  toKey: (docId) => docId.startsWith("task:") ? docId.slice(5) : null,
  toDocId: (key) => `task:${key}`,
})

// Remote docs matching TaskBound are auto-added as they appear
const ref = catalog.createDoc("abc")  // creates "task:abc" in the exchange
catalog.delete("abc")                 // removes from catalog
```

The `toKey` function returns `null` to filter out non-matching docIds. The catalog registers a scope on the exchange — `onDocCreated` adds entries, `onDocDismissed` removes them. It also calls `exchange.registerSchema(bound)` so matching remote docs are auto-resolved.

Returns a `WritableCatalog<S>` with `createDoc`, `delete`, and `dispose()`.

---

## Secondary Indexes

A `SecondaryIndex<S>` groups catalog entries by derived keys. Three flavors cover the common cases.

### `Index.by(catalog, keyFn)` — scalar FK grouping

Each entry belongs to exactly one group, determined by a scalar foreign key.

```ts
const byAuthor = Index.by(catalog, (ref) => ref.authorId)

byAuthor.lookup("alice")          // IndexEntry[] — all entries with authorId "alice"
byAuthor.groupKeysFor("doc:1")    // ["alice"] — which group(s) "doc:1" belongs to
byAuthor.keys()                   // all distinct authorId values
byAuthor.size                     // count of distinct groups
```

The index watches each entry's key ref — when `ref.authorId` changes from `"alice"` to `"bob"`, the entry moves groups automatically.

### `Index.byKeys(catalog, keyFn)` — record fan-out

Each entry fans out into multiple groups, one per key in a record (map) ref.

```ts
const byTag = Index.byKeys(catalog, (ref) => ref.tags)

byTag.lookup("urgent")   // all entries that have "urgent" in their tags map
byTag.lookup("low")      // all entries that have "low" in their tags map
```

Adding or removing a key in an entry's `tags` map triggers re-indexing for that entry.

### `Index.byIdentity(catalog)` — identity index

The catalog key IS the group key. No transformation, no per-entry watching.

```ts
const byId = Index.byIdentity(catalog)

byId.lookup("doc:123")  // [{ key: "doc:123", ref: ... }]
```

Primarily useful as a building block for joins — when one side of a join needs no key transformation.

---

## Joins

`Index.join(leftIndex, rightIndex)` composes two secondary indexes that share a common group-key space. The join maintains no state of its own — it delegates to the underlying indexes.

```ts
// Schema: conversations have an id, threads have a conversationId
const convCatalog   = Catalog.fromRecord(doc.conversations)
const threadCatalog = Catalog.fromRecord(doc.threads)

// Left: identity index on conversations (catalogKey = conversationId)
const convIndex   = Index.byIdentity(convCatalog)
// Right: group threads by their conversationId FK
const threadIndex = Index.by(threadCatalog, (ref) => ref.conversationId)

// Join them
const convThreads = Index.join(convIndex, threadIndex)
```

### Forward lookup

Given a left-side key, find all matching right-side entries:

```ts
convThreads.lookup("conv:abc")
// → [{ key: "thread:1", ref: ... }, { key: "thread:2", ref: ... }]
```

### Reverse lookup

Given a right-side key, find all matching left-side entries:

```ts
convThreads.reverse("thread:1")
// → [{ key: "conv:abc", ref: ... }]
```

### You don't need a reverse field

In a traditional database you might store `conversationId` on each thread AND `threadIds[]` on each conversation. With joins, you don't need the reverse field. Store the FK in one direction; use `reverse()` to traverse the other way.

```ts
// ✗ Don't do this — redundant reverse field
// conversation.threadIds = ["t1", "t2"]

// ✓ Do this — single FK, query both directions
const threadIndex = Index.by(threadCatalog, (ref) => ref.conversationId)
const joined = Index.join(Index.byIdentity(convCatalog), threadIndex)

joined.lookup("conv:abc")     // conv → threads (forward)
joined.reverse("thread:1")    // thread → conv (reverse)
```

---

## Reactive Updates

All structures — catalogs, indexes, joins — update incrementally and expose changefeeds for subscription.

### Catalog changefeed

```ts
catalog.subscribe((changeset) => {
  for (const change of changeset.changes) {
    switch (change.type) {
      case "added":   console.log(`new entry: ${change.key}`); break
      case "removed": console.log(`removed: ${change.key}`); break
    }
  }
})
```

### Index changefeed

```ts
byOwner.subscribe((changeset) => {
  for (const change of changeset.changes) {
    switch (change.type) {
      case "group-added":
        console.log(`${change.entryKey} joined group ${change.groupKey}`)
        break
      case "group-removed":
        console.log(`${change.entryKey} left group ${change.groupKey}`)
        break
    }
  }
})
```

### FK mutations trigger re-indexing

When a scalar FK changes (e.g. `ref.ownerId` goes from `"alice"` to `"bob"`), `Index.by` detects the change via a per-entry subscription and emits both a `group-removed` from `"alice"` and a `group-added` to `"bob"`. Similarly, `Index.byKeys` watches the record ref for structural changes.

### Join changefeed

A join's `subscribe` re-emits changes from both underlying indexes, so a single subscription covers both sides:

```ts
convThreads.subscribe((changeset) => {
  // Receives SecondaryIndexChange events from both convIndex and threadIndex
})
```

---

## Lifecycle

Every catalog, index, and join that holds subscriptions exposes a `dispose()` method. Call it to tear down internal watchers and release resources.

```ts
// Catalog — dispose tears down source subscriptions
const catalog = Catalog.fromRecord(doc.members)
catalog.dispose()

// Index — dispose tears down catalog subscription + per-entry watchers
const byOwner = Index.by(catalog, (ref) => ref.ownerId)
byOwner.dispose()

// Join — dispose tears down both underlying indexes
const joined = Index.join(leftIndex, rightIndex)
joined.dispose()  // also disposes leftIndex and rightIndex
```

> **Note:** `Index.join` owns its underlying indexes — calling `dispose()` on the join disposes both. Don't dispose the indexes separately if you passed them to a join.

Collected catalogs from `Catalog.collect()` have no internal subscriptions, so the returned `CatalogHandle` has no `dispose`.

---

## API Reference

### Catalog

| Constructor | Returns | Description |
|-------------|---------|-------------|
| `Catalog.create<S>(bound)` | `WritableCatalog<S>` | BoundSchema-backed with `createDoc` |
| `Catalog.collect<S>()` | `[Catalog<S>, CatalogHandle<S>]` | Manual aggregation from arbitrary sources |
| `Catalog.fromRecord<S>(ref)` | `DisposableCatalog<S>` | Reactive mirror of a record ref |
| `Catalog.fromList<S>(ref, keyFn)` | `DisposableCatalog<S>` | Reactive mirror of a list ref |
| `Catalog.fromExchange<S>(exchange, bound, mapping)` | `WritableCatalog<S>` | Exchange-backed with lifecycle tracking |

### Catalog<S> (ReactiveMap)

| Member | Description |
|--------|-------------|
| `get(key)` | Get the `Ref<S>` for a key, or `undefined` |
| `has(key)` | Check if a key exists |
| `keys()` | All catalog keys |
| `size` | Number of entries |
| `subscribe(cb)` | Subscribe to `CatalogChange` events. Returns unsubscribe. |
| `[Symbol.iterator]` | Iterate `[key, ref]` pairs |

### WritableCatalog<S>

| Member | Description |
|--------|-------------|
| `createDoc(key)` | Create a new ref under the given key. Throws if key exists. |
| `delete(key)` | Remove an entry. Returns `true` if present. |
| `dispose()` | Tear down subscriptions |

### CatalogHandle<S> (from `Catalog.collect`)

| Member | Description |
|--------|-------------|
| `set(key, ref)` | Insert or replace. Emits `"added"` only for new keys. |
| `delete(key)` | Remove. Emits `"removed"` if present. Returns `boolean`. |

### Index

| Constructor | Description |
|-------------|-------------|
| `Index.by(catalog, keyFn)` | Scalar FK grouping — one group per entry |
| `Index.byKeys(catalog, keyFn)` | Record fan-out — entry in N groups |
| `Index.byIdentity(catalog)` | Identity — catalogKey = groupKey |
| `Index.join(left, right)` | Reactive join over shared group-key space |

### SecondaryIndex<S>

| Member | Description |
|--------|-------------|
| `lookup(groupKey)` | `IndexEntry<S>[]` — all entries in the group |
| `groupKeysFor(catalogKey)` | `string[]` — which groups an entry belongs to |
| `keys()` | All distinct group keys |
| `size` | Count of distinct groups |
| `subscribe(cb)` | Subscribe to `SecondaryIndexChange` events. Returns unsubscribe. |
| `dispose()` | Tear down all subscriptions |

### JoinIndex<L, R>

| Member | Description |
|--------|-------------|
| `lookup(leftKey)` | `JoinResult<R>[]` — left → group keys → right entries |
| `reverse(rightKey)` | `JoinResult<L>[]` — right → group keys → left entries |
| `subscribe(cb)` | Subscribe to changes from both underlying indexes |
| `dispose()` | Dispose both underlying indexes |

---

## Peer Dependencies

```json
{
  "peerDependencies": {
    "@kyneta/changefeed": "^1.0.0",
    "@kyneta/schema": "^1.0.0"
  }
}
```

## License

MIT
