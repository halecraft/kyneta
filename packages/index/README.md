# @kyneta/index

Live, queryable views over document collections. Group by field, join across collections, subscribe to changes — views update automatically as data moves.

## Index nested documents

Your project documents each contain a task list. You need every task — across every project — indexed by owner.

```ts
import { Source, Collection, Index, field } from "@kyneta/index"

// Pull tasks out of every ProjectDoc in the exchange.
// Documents arrive from all peers; tasks appear and disappear automatically.
const tasks = Collection.from(
  Source.of(exchange, ProjectDoc, doc => doc.tasks, item => item.id),
)

// Group by owner — one line
const byOwner = Index.by(tasks, field(ref => ref.ownerId))
```

Now access any group as a live, reactive map:

```ts
const aliceTasks = byOwner.get("alice")  // all tasks where ownerId is "alice"

aliceTasks.size              // 3
aliceTasks.has("task-1")     // true

const taskRef = aliceTasks.get("task-1")  // a live, writable ref

for (const [key, ref] of aliceTasks) {
  // render each task
}
```

`Source.of` is the primary on-ramp. It watches an exchange for documents matching a schema, reaches inside each document to extract nested entities, and produces a single flat `Source` — ready for `Collection.from`.

## It updates itself

When a task's owner changes, the index reorganizes — no manual invalidation, no re-query:

```ts
// Alice reassigns task-1 to Bob
taskRef.ownerId.set("bob")

aliceTasks.size              // 2 — task-1 is gone
byOwner.get("bob").size      // 1 — task-1 appeared here
```

When a new document syncs in from another peer, its tasks land in the right groups automatically. When a document is dismissed, its tasks retract.

## Data from many documents

There's nothing special about one project versus ten. `Source.of` tracks *every* document matching the schema across the entire exchange. Documents arrive and depart; tasks appear and disappear:

```ts
// Three ProjectDocs from three different peers — doesn't matter.
// All their tasks are unified into one collection, one index.
const tasks = Collection.from(
  Source.of(exchange, ProjectDoc, doc => doc.tasks, item => item.id),
)

const byOwner = Index.by(tasks, field(ref => ref.ownerId))

// Alice's tasks across ALL projects
byOwner.get("alice").size  // 7
```

A new peer joins and syncs a fourth project? Its tasks appear. A project is dismissed? Its tasks retract. The index stays correct.

## Compose across document types

Tasks live in `ProjectDoc`. More tasks live in `SprintDoc`. You want one unified view:

```ts
const allTasks = Collection.from(
  Source.union(
    Source.of(exchange, ProjectDoc,  doc => doc.tasks, item => item.id),
    Source.of(exchange, SprintDoc,   doc => doc.items, item => item.id),
  ),
)

const byOwner = Index.by(allTasks, field(ref => ref.ownerId))

// Alice's tasks from both schemas, one reactive map
byOwner.get("alice")
```

`Source.of` returns a `Source` — a composable stream — so `union`, `filter`, and `map` all work before you ever materialize a `Collection`.

## Subscribe to changes

The reactive map returned by `get` tells you *when* things move:

```ts
aliceTasks.subscribe(changeset => {
  for (const change of changeset.changes) {
    // { type: "group-removed", groupKey: "alice", entryKey: "task-1" }
    // { type: "group-added",   groupKey: "alice", entryKey: "task-4" }
  }
})
```

Or subscribe to the entire index for all group changes at once:

```ts
byOwner.subscribe(changeset => {
  // every add, remove, and regroup across all owners
})
```

## Join across collections

Conversations and threads live in separate collections. You need to show threads grouped by conversation — without storing a reverse field.

```ts
const convs    = Collection.from(Source.of(exchange, ConvDoc))
const threads  = Collection.from(Source.of(exchange, ThreadDoc))

const convIndex    = Index.by(convs)  // identity — each conv is its own group
const threadIndex  = Index.by(threads, field(ref => ref.conversationId))
const convThreads  = Index.join(convIndex, threadIndex)

// All threads in a conversation — reactive
const threads = convThreads.get("conv:abc")
threads.size  // 5

// Which conversation does this thread belong to?
const convs = convThreads.reverse("thread-1")
convs.has("conv:abc")  // true
```

Joins are live — add a thread, and it appears. Move a thread, and both sides update.

## Your data can come from anywhere

`Source.of` is the standard path — it handles document-level, list-level, and record-level extraction in one call:

```ts
// Document-level — each doc is an entry, keyed by docId
Source.of(exchange, TaskDoc)

// List-level — reach into each doc's list, extract entities by key
Source.of(exchange, ProjectDoc, doc => doc.tasks, item => item.id)

// Record-level — reach into each doc's record, entries keyed by record keys
Source.of(exchange, TeamDoc, doc => doc.members)
```

For power users, raw adapters give you full control:

```ts
// From a schema record ref directly
const source = Source.fromRecord(doc.members)

// From a schema list ref with a key extractor
const source = Source.fromList(doc.items, item => item.id)

// From an exchange with handle access for dismiss control
const [source, handle] = Source.fromExchange(exchange, TaskDoc)

// Manual — you control what goes in
const [source, handle] = Source.create()
handle.set("task-1", myRef)
```

Every source feeds into `Collection.from(source)` the same way.

## Compose before materializing

Sources are composable. Filter, merge, or remap *before* creating a collection:

```ts
// Only active tasks
const active = Source.filter(source, (key, ref) => ref.status() === "active")

// Merge tasks from two exchanges
const merged = Source.union(sourceA, sourceB)

// Remap keys (return null to filter out)
const prefixed = Source.map(source, key => `org:${key}`)
```

## Key helpers

`field` and `keys` tell the index how to group entries:

```ts
// Group by a single field
Index.by(tasks, field(ref => ref.ownerId))

// Group by multiple fields (compound key)
Index.by(tasks, field(ref => ref.ownerId, ref => ref.status))

// Fan out by record keys — an entry appears in multiple groups
Index.by(tasks, keys(ref => ref.tags))

// Identity — each entry is its own group (useful for joins)
Index.by(tasks)
```

## API at a glance

### Source

| | |
|---|---|
| `Source.of(exchange, bound)` | Document-level — each doc is an entry keyed by docId |
| `Source.of(exchange, bound, accessor)` | Record-level — reach into each doc's record |
| `Source.of(exchange, bound, accessor, keyFn)` | List-level — reach into each doc's list, extract entities by key |
| `Source.flatMap(outer, fn, options?)` | For each outer entry, spawn an inner `Source`; flatten into one stream |
| `Source.create()` | Manual source — returns `[source, handle]` |
| `Source.fromExchange(exchange, bound, mapping?)` | Exchange-backed — returns `[source, handle]` |
| `Source.fromRecord(recordRef)` | Record ref adapter |
| `Source.fromList(listRef, keyFn)` | List ref adapter |
| `Source.filter(source, pred)` | Filter entries |
| `Source.union(a, b)` | Merge two sources |
| `Source.map(source, fn)` | Remap keys |

### Collection

| | |
|---|---|
| `Collection.from(source)` | The single constructor — accumulates source into reactive state |
| `.get(key)` | Get a value by key |
| `.has(key)` | Check membership |
| `.size` | Entry count |
| `.subscribe(cb)` | Changefeed — `added` / `removed` events |

### Index

| | |
|---|---|
| `Index.by(collection, keySpec?)` | Group by derived key. Identity when no keySpec. |
| `.get(groupKey)` | Reactive map of entries in that group |
| `.groupKeysFor(entryKey)` | Which groups an entry belongs to |
| `.keys()` | All group keys |
| `.size` | Number of groups |
| `.subscribe(cb)` | `group-added` / `group-removed` events |

### Join

| | |
|---|---|
| `Index.join(left, right)` | Compose two indexes over shared group keys |
| `.get(leftKey)` | Reactive map of right-side entries |
| `.reverse(rightKey)` | Reactive map of left-side entries |
| `.subscribe(cb)` | Changes from both sides |

### Key helpers

| | |
|---|---|
| `field(accessor)` | Scalar FK |
| `field(a, b, ...)` | Compound key |
| `keys(accessor)` | Record fan-out |

## Under the hood

All changes flow internally as **ℤ-sets** — weighted sets from the [DBSP paper](https://arxiv.org/abs/2203.16684) that form an abelian group under pointwise addition. This algebraic foundation guarantees that incremental view maintenance is correct by construction: filter, union, and grouping are linear operators (they work directly on deltas), while join uses the bilinear three-term formula. `Source.of` is built on `Source.flatMap` — each document in the exchange becomes an outer entry whose inner source (via `fromList` or `fromRecord`) is dynamically managed. Documents arrive and depart; `flatMap` handles the lifecycle. See [TECHNICAL.md](./TECHNICAL.md) for the full mathematical foundations.