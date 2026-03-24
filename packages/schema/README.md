# @kyneta/schema

Define a schema. Get a live, reactive, syncable document with full TypeScript types.

```ts
import { Schema, createDoc, change, subscribe } from "@kyneta/schema/basic"

const TaskDoc = Schema.doc({
  title: Schema.annotated("text"),
  done:  Schema.boolean(),
  count: Schema.annotated("counter"),
})

const doc = createDoc(TaskDoc, { title: "Ship it" })

doc.title()              // "Ship it"
doc.title.insert(7, "!") // surgical text edit
doc.count.increment()    // counter delta
doc.done.set(true)       // whole-value swap

subscribe(doc, (changeset) => {
  // fires for any change anywhere in the document
})
```

Zero runtime dependencies.

## What you get from one schema

| Capability | How |
|---|---|
| **Typed reads** | `doc.title()` returns `string`, `doc()` returns the full plain snapshot |
| **Typed writes** | `.set()`, `.insert()`, `.increment()`, `.push()`, `.delete()` — each ref knows its mutation surface |
| **Transactions** | `change(doc, d => { ... })` → `Op[]` — atomic batching, returns captured ops |
| **Sync** | `applyChanges(docB, ops)` — apply ops from another doc, network, or undo stack |
| **Observation** | `subscribe(doc, cb)` for tree-level, `subscribeNode(ref, cb)` for leaf-level |
| **Version tracking** | `version(doc)`, `delta(doc, fromVersion)`, `exportSnapshot(doc)` |
| **Validation** | `validate(schema, data)` — same schema, no separate Zod/Yup definition |
| **Template coercion** | `` `Count: ${doc.count}` `` works via `toPrimitive` — no `.()` needed |

## The sync story in 5 lines

```ts
// Capture mutations on docA
const ops = change(docA, d => {
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

// CRDT-ready annotations
Schema.annotated("text")             // collaborative text
Schema.annotated("counter")          // increment/decrement counter

// Composites
Schema.struct({ ... })               // fixed-key product
Schema.list(itemSchema)              // ordered sequence
Schema.record(valueSchema)           // dynamic-key map

// Unions
Schema.discriminatedUnion("type", [  // native TS narrowing
  Schema.struct({ type: Schema.string("text"), body: Schema.annotated("text") }),
  Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
])
Schema.nullable(inner)               // null | inner

// Root
Schema.doc({ ... })                  // document root (annotated product)
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
for (const task of doc.tasks) { ... }  // iterate refs

// Records
doc.labels.at("bug")?.()   // navigate + read
doc.labels.get("bug")      // read plain value
doc.labels.set("bug", "red")
doc.labels.delete("bug")
doc.labels.keys()           // string[]
doc.labels.has("bug")       // boolean
```

## Observation

```ts
// Tree-level — fires for any change in the subtree
const unsub = subscribe(doc, (changeset) => {
  for (const event of changeset.changes) {
    console.log(event.path, event.change.type)
  }
})

// Node-level — fires only for changes at this exact ref
subscribeNode(doc.count, (changeset) => {
  console.log(changeset.origin) // "sync", "undo", etc.
})
```

Subscribers receive batched `Changeset` objects — never partially-applied state. Origin provenance (`{ origin: "sync" }`) flows through from `change()` and `applyChanges()`.

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

The `/basic` API is built on a composable interpreter algebra with five stackable layers (navigation, reading, caching, writing, observation). If you need custom stacks — read-only documents, write-only mutation dispatchers, or your own substrate — import from `@kyneta/schema` directly. See `example/advanced/` for details.

## Examples

```sh
# Getting started (basic API)
bun run example/basic/main.ts

# Under the hood (interpreter algebra)
bun run example/advanced/main.ts
```

## Design

Under the hood, the schema is a recursive functor (`Scalar | Product | Sequence | Map | Sum | Annotated`) and each capability — reading, writing, caching, observation — is an F-algebra composed via interpreter transformers. `interpret()` is a catamorphism; `subscribe` is a coalgebra (Moore machine). The `step(state, change) → state` functions are pure, the change vocabulary is open, and the `change → applyChanges` round-trip is verified to be extensionally equal. This means the reactive system, the sync protocol, and the validation layer are all derived from the same structure — not parallel implementations that drift apart.

See `theory/interpreter-algebra.md` for the full treatment, or `TECHNICAL.md` for the implementation map.

## License

MIT