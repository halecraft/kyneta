# @loro-extended/schema — Example Mini-App

A self-contained example that builds a high-level document API on top of the schema algebra primitives, then uses it to demonstrate the apex developer experience — the same ergonomics as `@loro-extended/change`, but running on a plain JS object store with zero CRDT runtime.

## Architecture

The example showcases the **three-building-block composition algebra**:

| Building block | What it provides | Context needed |
|---|---|---|
| `readableInterpreter` | Callable function-shaped refs — `ref()` reads the current value | `RefContext { store }` |
| `withMutation(base)` | Adds `.set()`, `.insert()`, `.increment()`, etc. | `WritableContext { store, dispatch, ... }` |
| `withChangefeed` | Adds `[CHANGEFEED]` observation protocol | `ChangefeedContext { ... + subscribers }` |

**Composition:** `enrich(withMutation(readableInterpreter), withChangefeed)`

Each concern is independently useful — a read-only document needs only `readableInterpreter` and a bare `{ store }` context.

## Running

```sh
# From packages/schema/
npx tsx example/main.ts
```

## Structure

The example has two halves:

### The Facade (~100 lines)

A thin, high-level API built entirely from schema primitives. In production this would live in its own package (or in `@loro-extended/change`). Here it lives in the example to prove the algebra supports this developer experience.

- **`createDoc(schema, seed?)`** — Creates a typed, writable, observable document handle from a schema and optional seed values. Return type is `Readable<F[K]> & Writable<F[K]>` — callable refs with mutation methods. Wires up the store, writable context, changefeed context, enrichment, interpretation, and `toJSON()` in a single call.
- **`change(doc, fn)`** — Batches mutations into a single atomic flush. The callback receives a draft with the same typed API.
- **`subscribe(ref, callback)`** — Subscribes to changes on any changefeed ref. Returns an unsubscribe function.

### The App (~300 lines)

Uses the facade exactly like an application developer would:

1. **Define a Schema** — `LoroSchema.doc({ ... })` with text, counter, list, struct, record, nullable, constrained scalars
2. **Create a Document** — `createDoc(ProjectSchema, { name: "..." })`
3. **Direct Mutations** — `doc.name.insert()`, `doc.stars.increment()`, `doc.settings.visibility.set()`
4. **Working with Lists** — `doc.tasks.push()`, `doc.tasks.at(0).title()`, iteration via `for..of`, delete
5. **Working with Records** — Dynamic key access via Proxy, `Object.keys()`, `in` operator
6. **Batched Mutations** — `change(doc, d => { d.name.update(...); d.stars.increment(...) })`
7. **Subscribing to Changes** — `subscribe(doc.name, action => ...)`, unsubscribe
8. **Portable Refs** — Extract refs, pass to standalone generic functions typed with `(() => T) & MutationRef`
9. **Referential Identity & Namespace Isolation** — `doc.name === doc.name`, `Object.keys(doc)` returns only schema keys
10. **Validation** — `validate(ProjectSchema, snapshot)` narrows to `Plain<typeof ProjectSchema>`, `tryValidate()` collects multiple errors with human-readable paths, `validate()` throws `SchemaValidationError` on first error
11. **Deep Subscriptions** — `subscribeDeep(cfCtx, [], cb)` notifies for changes anywhere in the subtree, with relative `origin` paths and change types
12. **Read-Only Documents** — `interpret(schema, readableInterpreter, { store })` produces a fully navigable, callable document with no mutation methods and no dispatch context
13. **Template Literal Coercion** — `` `Stars: ${doc.stars}` `` works via `[Symbol.toPrimitive]` — no `ref()` call needed in template literals; hint-aware (number for counters, string for text)
14. **The Composition Algebra** — Summary of the three building blocks and their context requirements
15. **Final Snapshot** — `doc.toJSON()` returns the full plain object

## Key Concepts

### Callable Refs

Every ref produced by `readableInterpreter` is a function: `ref()` returns the current plain value. This is the foundational read API — no `.get()` method needed.

```ts
doc.name()           // "Hello" — current string value
doc.stars()          // 42 — current number value
doc.settings()       // { visibility: "public", ... } — deep plain snapshot
doc.tasks.at(0)()    // { title: "...", done: false, ... }
```

### Template Literal Coercion

Leaf refs have `[Symbol.toPrimitive]`, so they work in template literals without calling `ref()`:

```ts
`Project: ${doc.name}`   // "Project: Hello" — via toPrimitive
`Stars: ${doc.stars}`    // "Stars: 42" — hint-aware coercion
+doc.stars               // 42 — numeric coercion
```

### Read-Only Documents

The readable interpreter needs only a store — no dispatch, no mutation methods:

```ts
const ctx: RefContext = { store }
const doc = interpret(schema, readableInterpreter, ctx)
doc.name()         // ✓ reads work
doc.name.insert    // undefined — no mutation methods
```

### Composition

Reading is the foundational capability. Writing depends on reading. Observation depends on writing.

```ts
// Read-only:
interpret(schema, readableInterpreter, { store })

// Read + write:
interpret(schema, withMutation(readableInterpreter), writableCtx)

// Read + write + observe:
interpret(schema, enrich(withMutation(readableInterpreter), withChangefeed), cfCtx)
```

## The Point

The developer never touches `interpret()`, `step()`, `Zero.structural()`, `CHANGEFEED`, `WritableContext`, or any of the algebra primitives. Those are implementation details of the facade. The developer sees:

```
Schema.doc({ ... })    →  define structure
createDoc(schema)      →  get a live document
doc.title()            →  read current value
doc.title.insert(...)  →  mutate naturally
`Title: ${doc.title}`  →  coerce in templates
change(doc, fn)        →  batch mutations
subscribe(ref, cb)     →  observe changes
validate(schema, data) →  validate & narrow types
doc.toJSON()           →  snapshot
```

This is the same API shape as `@loro-extended/change` — but backed by the clean, mathematically rigorous schema algebra instead of 10+ parallel `switch` dispatch sites.