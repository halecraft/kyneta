# @kyneta/index

Live, queryable views over document collections. Group by field, join across collections, subscribe to changes — views update automatically as data moves.

## Group your documents

You have tasks in an exchange. You need them organized by owner.

```ts
import { Source, Collection, Index, field } from "@kyneta/index"

// Track every TaskDoc in the exchange — includes docs from all peers
const [source] = Source.fromExchange(exchange, TaskDoc)
const tasks = Collection.from(source)

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

## It updates itself

When a task's owner changes, the index reorganizes — no manual invalidation, no re-query:

```ts
// Alice reassigns task-1 to Bob
taskRef.ownerId.set("bob")

aliceTasks.size              // 2 — task-1 is gone
byOwner.get("bob").size      // 1 — task-1 appeared here
```

When a new document syncs in from another peer, it lands in the right group automatically.

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
const convs    = Collection.from(Source.fromExchange(exchange, ConvDoc)[0])
const threads  = Collection.from(Source.fromExchange(exchange, ThreadDoc)[0])

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

`Source` adapters connect different data shapes to the same pipeline:

```ts
// From an exchange (most common — syncing documents)
const [source] = Source.fromExchange(exchange, TaskDoc)

// From a schema record ref (e.g. doc.members)
const source = Source.fromRecord(doc.members)

// From a schema list ref with a key extractor
const source = Source.fromList(doc.items, item => item.id)

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

All changes flow internally as **ℤ-sets** — weighted sets from the [DBSP paper](https://arxiv.org/abs/2203.16684) that form an abelian group under pointwise addition. This algebraic foundation guarantees that incremental view maintenance is correct by construction: filter, union, and grouping are linear operators (they work directly on deltas), while join uses the bilinear three-term formula. See [TECHNICAL.md](./TECHNICAL.md) for the full mathematical foundations.