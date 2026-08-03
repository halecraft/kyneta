# @kyneta/schema

Define a schema. Get a live, reactive, syncable document with full TypeScript type safety.

`@kyneta/schema` is a mathematically rigorous but beautiful and ergonomic building block for representing structured data as it changes over time. You can use plain JS, or bring your own CRDT library (e.g. Loro, Yjs).

```ts
import { Schema, createDoc, change, subscribe } from "@kyneta/schema/basic"

const TaskDoc = Schema.struct({
  title: Schema.text(),
  count: Schema.counter(),
  games: Schema.list(
    Schema.struct({
      type: Schema.string("uno", "catan"),
      players: Schema.number(2, 3, 4)
    })
  ),
  done:  Schema.boolean(),
})

const doc = createDoc(TaskDoc)

// Group several writes into one atomic commit + one notification:
batch(doc, d => {
  d.title.insert(0, "Ship it")
  d.done.set(true)
  d.games.push({ type: "catan", players: 3 })
})

doc()                    // { "title": "Ship it", "count": 0, ... }
doc.title()              // "Ship it"
// A single mutation needs no batch() — a bare helper call auto-commits:
doc.title.insert(7, "!") // surgical text edit
doc.count.increment()    // counter delta
doc.games.push({         // makes structural doc.games.at(1) available
  type: "uno",
  players: 4
})

subscribe(doc, (changeset) => {
  // fires for any change anywhere in the document
})
```

Zero runtime dependencies.

> **Mutation convention.** A single write commits on its own — call it directly (`doc.title.insert(...)`). Reach for `batch(doc, d => …)` only to group **multiple** writes into one atomic commit + notification, to capture the returned `Op[]`, or to attach `origin`/`source` provenance.

## What you get from one schema

| Capability | How |
|---|---|
| **Typed reads** | `doc.title()` returns `string`, `doc()` returns the full plain snapshot |
| **Typed writes** | `.set()`, `.insert()`, `.increment()`, `.push()`, `.delete()` — each ref knows its mutation surface |
| **Batching** | `batch(doc, d => { … })` → `Op[]` — group writes into one atomic commit + one notification (a single write needs no wrapper); returns the captured ops for sync |
| **Sync** | `applyChanges(docB, ops)` — apply ops from another doc, network, or undo stack |
| **Observation** | `subscribe(doc, cb)` for tree-level, `subscribeNode(ref, cb)` for leaf-level |
| **Self-removal** | `remove(ref)` — a child ref removes itself from its parent container |
| **Version tracking** | `version(doc)`, `delta(doc, fromVersion)`, `exportSnapshot(doc)` |
| **Validation** | `validate(schema, data)` — same schema, no separate Zod/Yup definition |
| **Template coercion** | `` `Count: ${doc.count}` `` works via `toPrimitive` — no `.()` needed |

## The sync story in 5 lines

```ts
// Capture mutations on docA
const ops = batch(docA, d => {
  d.title.insert(0, "✨ ")
  d.count.increment(10)
})

// Apply to docB (could be on another machine)
applyChanges(docB, ops, { origin: "sync" })

// docA() deep-equals docB()
```

## Schema types

```ts
// Scalars
Schema.string()                      // also Schema.string("a", "b") for constrained values
Schema.number()
Schema.boolean()

// CRDT kinds
Schema.text()                        // collaborative text
Schema.counter()                     // increment/decrement counter
Schema.set(itemSchema)               // add-wins set (value-addressed: .add(v), .has(v), .delete(v))
Schema.tree(itemSchema)              // tree with move semantics
Schema.movableList(itemSchema)       // ordered list with move
Schema.richText({ bold: { expand: "after" } })  // collaborative rich text with marks

// Composites
Schema.struct({ ... })               // fixed-key product
Schema.list(itemSchema)              // ordered sequence
Schema.record(valueSchema)           // dynamic-key map

// Unions
Schema.discriminatedUnion("type", [  // native TS narrowing
  Schema.struct({ type: Schema.string("text"), body: Schema.text() }),
  Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
])
Schema.string().nullable()           // null | string (fluent method on all plain schema types)

// Root
Schema.struct({ ... })                  // document root (annotated product)
```

## Collections

```ts
// Lists
doc.tasks.at(0)?.title()   // navigate to child ref
doc.tasks.get(0)           // read plain value directly
doc.tasks.length           // current length
doc.tasks.push({ ... })    // append
doc.tasks.insert(0, item)  // insert at index
doc.tasks.delete(1, 2)     // delete range
remove(doc.tasks.at(0))    // item removes itself from parent
for (const task of doc.tasks) { ... }  // iterate refs
doc.tasks()                // convert tasks to plain JSON

// Records
doc.labels.at("bug")?.()   // navigate + read
doc.labels.get("bug")      // read plain value
doc.labels.set("bug", "red")
doc.labels.delete("bug")
doc.labels.keys()           // string[]
doc.labels.has("bug")       // boolean
doc.labels()                // convert labels to plain JSON

// Sets — value-addressed (no .at(value); members are not addressable)
doc.tags.add("javascript")          // idempotent for an existing member
doc.tags.has("javascript")           // boolean (structural content equality)
doc.tags.delete("typescript")        // returns boolean (was present)
doc.tags.clear()
doc.tags.size                        // number
for (const tag of doc.tags) { ... }  // iterate plain values
doc.tags()                           // → string[]
```

## Observation

```ts
// Tree-level — fires for any change in the subtree
const unsub = subscribe(doc, (changeset) => {
  for (const event of changeset.changes) {
    console.log(event.path, event.change.type)
  }
})

// `subscribe` works on leaves too — a leaf is a tree of size 1, so the
// delivered `Op.path` is the empty relative path.
subscribe(doc.count, (changeset) => {
  console.log(changeset.changes[0].path.segments) // []
})

// Node-level — explicit shallow opt-in; delivers Changeset<ChangeBase>
// without paths, for when you don't need the tree shape.
subscribeNode(doc.count, (changeset) => {
  console.log(changeset.origin) // "sync", "undo", etc.
})
```

Subscribers receive batched `Changeset` objects — never partially-applied state. Origin provenance (`{ origin: "sync" }`) flows through from `batch()` and `applyChanges()`.

## Data readiness

```ts
import { isPopulated, populatedFeed } from "@kyneta/schema"

// Every ref starts unpopulated — no data has arrived yet
isPopulated(doc.title)      // false

doc.title.insert(0, "Hello")

isPopulated(doc.title)      // true (monotonic — never reverts)
isPopulated(doc)            // true (parent flips when any child does)
isPopulated(doc.count)      // false (untouched siblings stay false)

// The reactive form — a callable carrying its own [CHANGEFEED]
subscribeNode(populatedFeed(doc.title), () => { /* data arrived */ })
```

`isPopulated(ref)` reports whether any mutation — local, remote, or replayed from storage — has touched that ref or a descendant. It starts `false` and, once `true`, never reverts. `populatedFeed(ref)` returns the same state as a callable carrying its own `[CHANGEFEED]`, so it can be subscribed to or composed into a reactive computation.

These are free functions, not properties on the ref. Refs expose your schema's fields as properties, so framework metadata is stored under a `Symbol` (`[POPULATED]`) instead — otherwise a schema with an `isPopulated` field would collide with it. The same applies to `isDeleted(ref)` / `deletedFeed(ref)`.

> **`*Feed` is the carrier; the short name is the value.** `populatedFeed(ref)` returns a *callable*, so it is always truthy — `if (populatedFeed(ref))` reports the opposite of the truth for an empty document. Use `isPopulated(ref)` when you want a boolean. The older spellings `populated(ref)` / `deleted(ref)` are deprecated aliases of the `*Feed` functions; in 3.0 those short names become the booleans.

> **For documents in a Runtime or Exchange**, `docStatus(doc)` from
> `@kyneta/exchange` answers this properly — it waits for stored data and
> peers before saying a document is empty — and `initialize(doc, seed)`
> writes defaults exactly once, safely.

> **Readiness is not emptiness.** `isPopulated` answers "has data arrived?", not "has everything that could deliver data reported in?". A document whose store is still hydrating, or whose peers have not yet replied, reads `false` — indistinguishable from a genuinely empty document. Before treating `false` as "empty, safe to write defaults", gate on the relevant settle signal (storage hydration, and `sync(doc)` readiness when the document belongs to an Exchange).

## Validation

```ts
// Throws on first error
const data = validate(MySchema, unknownInput)
// data is now Plain<typeof MySchema> — fully narrowed

// Collect all errors
const result = tryValidate(MySchema, unknownInput)
if (!result.ok) {
  for (const err of result.errors) {
    console.log(err.path, err.expected, err.actual)
    // "tasks[0].priority"  "one of 1 | 2 | 3"  99
  }
}
```

## Two import paths

| Path | Audience | What you get |
|---|---|---|
| `@kyneta/schema/basic` | App developers | `createDoc`, `change`, `subscribe`, `validate`, sync primitives — batteries included |
| `@kyneta/schema` | Library authors | The full composable interpreter toolkit — build custom document systems |

Most projects only need `@kyneta/schema/basic`.

The `/basic` API is built on a composable interpreter algebra with six stackable layers (navigation, reading, addressing, caching, writing, observation). If you need custom stacks — read-only documents, write-only mutation dispatchers, or your own substrate — import from `@kyneta/schema` directly. See `example/advanced/` for details.

## Examples

```sh
# Getting started (basic API)
bun run example/basic/main.ts

# Under the hood (interpreter algebra)
bun run example/advanced/main.ts
```

## Design (Math Nerd Corner)

Under the hood:

- the schema is a recursive functor (`Scalar | Product | Sequence | Map | Sum | Annotated`)
- `interpret()` is a catamorphism
  - each capability (reading, addressing, writing, caching, observation) is an F-algebra composed via interpreter transformers
- `subscribe` is a coalgebra (Moore machine)
- the `step(state, change) → state` functions are pure
- the `change → applyChanges` round-trip is verified to be extensionally equal
- the change vocabulary is open

This means the reactive system, the sync protocol, and the validation layer are all derived from the same structure — not parallel implementations that drift apart. It also means this representation of schemas is rigorous, and you can depend on it.

See `theory/interpreter-algebra.md` for the full treatment, or `TECHNICAL.md` for the implementation map.

## License

MIT
