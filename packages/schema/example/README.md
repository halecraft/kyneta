# @kyneta/schema — Example Mini-App

A self-contained example that builds a high-level document API on top of the schema algebra primitives, then uses it to demonstrate the apex developer experience — the same ergonomics as `@loro-extended/change`, but running on a plain JS object store with zero CRDT runtime.

## Architecture

The example showcases the **four-layer composable interpreter stack**:

| Layer | What it provides | Context needed |
|---|---|---|
| `readable` | Callable function-shaped refs with caching — `ref()` reads the current value | `RefContext { store }` |
| `writable` | Adds `.set()`, `.insert()`, `.increment()`, etc. | `WritableContext { store, dispatch, ... }` |
| `changefeed` | Adds `[CHANGEFEED]` observation protocol with `subscribeTree` | `WritableContext` |

**Fluent composition:**

```ts
const doc = interpret(schema, ctx)
  .with(readable)
  .with(writable)
  .with(changefeed)
  .done()
```

**Manual composition (equivalent):**

```ts
const interp = withChangefeed(withWritable(withCaching(withReadable(bottomInterpreter))))
const doc = interpret(schema, interp, ctx)
```

Each concern is independently useful — a read-only document needs only the `readable` layer and a bare `{ store }` context.

## Running

```sh
# From packages/schema/
npx tsx example/main.ts
```

## Structure

The example has two halves:

### The Facade (~80 lines)

A thin, high-level API built entirely from schema primitives. In production this would live in its own package (or in `@kyneta/change`). Here it lives in the example to prove the algebra supports this developer experience.

- **`createDoc(schema, seed?)`** — Creates a typed, writable, observable document handle from a schema and optional seed values. Uses the fluent builder: `interpret(schema, ctx).with(readable).with(writable).with(changefeed).done()`. Attaches `toJSON()` via the plain interpreter. Return type is `Readable<F[K]> & Writable<F[K]>`.
- **`change(doc, fn)`** — Wraps mutations in a transaction. Discovers the `WritableContext` via `doc[TRANSACT]` — no internal WeakMap or re-interpretation needed. On commit, changefeed subscribers fire.
- **`subscribe(ref, callback)`** — Subscribes to changes on any changefeed ref via `ref[CHANGEFEED].subscribe()`. Returns an unsubscribe function.

### The App (~400 lines)

Uses the facade exactly like an application developer would:

1. **Define a Schema** — `LoroSchema.doc({ ... })` with text, counter, list, struct, record, nullable, constrained scalars
2. **Create a Document** — `createDoc(ProjectSchema, { name: "..." })`
3. **Direct Mutations** — `doc.name.insert()`, `doc.stars.increment()`, `doc.settings.visibility.set()`
4. **Working with Lists** — `doc.tasks.push()`, `doc.tasks.at(0).title()`, iteration via `for..of`, delete
5. **Working with Records** — Map-like API: `.set()`, `.get()`, `.delete()`, `.has()`, `.keys()`, `.size`, `.clear()`
6. **Transactions with change()** — `change(doc, d => { d.name.update(...); d.stars.increment(...) })` — atomic, with abort-on-error
7. **Subscribing to Changes** — `subscribe(doc.name, action => ...)`, unsubscribe
8. **Portable Refs** — Extract refs, pass to standalone generic functions typed with `(() => T) & MutationRef`
9. **Referential Identity & Namespace Isolation** — `doc.name === doc.name`, `Object.keys(doc)` returns only schema keys, `hasChangefeed()`, `hasTransact()`
10. **Validation** — `validate(ProjectSchema, snapshot)` narrows to `Plain<typeof ProjectSchema>`, `tryValidate()` collects multiple errors with human-readable paths, `validate()` throws `SchemaValidationError` on first error
11. **Compositional Tree Subscriptions** — `doc.settings[CHANGEFEED].subscribeTree(cb)` notifies for changes anywhere in the subtree, with relative `origin` paths. Part of the `[CHANGEFEED]` protocol — no raw context needed
12. **Transaction + Tree Subscription Integration** — Shows how `beginTransaction()` / `commit()` interacts with `subscribeTree`: store is unchanged until commit, listeners fire at commit time via dispatch replay
13. **Read-Only Documents** — `interpret(schema, readableInterpreter, { store })` produces a fully navigable, callable document with no mutation methods, no observation, no dispatch context
14. **Template Literal Coercion** — `` `Stars: ${doc.stars}` `` works via `[Symbol.toPrimitive]` — no `ref()` call needed in template literals; hint-aware (number for counters, string for text)
15. **The Composition Algebra** — Summary of the four layers, context requirements, and symbol-keyed composability hooks
16. **Final Snapshot** — `doc.toJSON()` returns the full plain object

## Key Concepts

### Callable Refs

Every ref produced by the `readable` layer is a function: `ref()` returns the current plain value. This is the foundational read API — no `.get()` method needed.

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

### Transactions via `[TRANSACT]`

Every ref carries a `[TRANSACT]` symbol referencing its `WritableContext`. The `change()` facade uses this to enter a transaction without re-interpretation:

```ts
function change(doc, fn) {
  const ctx = doc[TRANSACT]
  ctx.beginTransaction()
  try {
    fn(doc)
    ctx.commit()     // replay through dispatch → subscribers fire
  } catch (e) {
    ctx.abort()      // discard buffered changes
    throw e
  }
}
```

### Compositional Tree Subscriptions

Composite refs (products, sequences, maps) implement `ComposedChangefeed` with `subscribeTree`:

```ts
doc.settings[CHANGEFEED].subscribeTree((event) => {
  console.log(event.origin)  // [{type:"key", key:"darkMode"}]
  console.log(event.change)  // {type:"replace", ...}
})
doc.settings.darkMode.set(true)  // fires tree subscriber with origin path
```

`subscribe` remains node-level (fires only for changes at that node). `subscribeTree` fires for all descendant changes with relative origin paths.

### Read-Only Documents

The readable layer needs only a store — no dispatch, no mutation methods, no observation:

```ts
const ctx: RefContext = { store }
const doc = interpret(schema, ctx).with(readable).done()
doc.name()         // ✓ reads work
doc.name.insert    // undefined — no mutation methods
hasChangefeed(doc) // false — no observation
```

### Composition

Reading is the foundational capability. Writing depends on reading. Observation depends on writing.

```ts
// Read-only:
interpret(schema, { store }).with(readable).done()

// Read + write:
interpret(schema, ctx).with(readable).with(writable).done()

// Read + write + observe:
interpret(schema, ctx).with(readable).with(writable).with(changefeed).done()
```

## Symbol-Keyed Composability Hooks

| Symbol | Module | Purpose |
|---|---|---|
| `READ` (`kyneta:read`) | `bottom.ts` | Controls what `carrier()` does — `withReadable` fills it |
| `INVALIDATE` (`kyneta:invalidate`) | `with-caching.ts` | Change-driven cache invalidation — `withWritable` calls before dispatch |
| `TRANSACT` (`kyneta:transact`) | `writable.ts` | Context discovery — refs carry a reference to their `WritableContext` |
| `CHANGEFEED` (`kyneta:changefeed`) | `changefeed.ts` | Observation coalgebra — `withChangefeed` attaches it with `subscribeTree` |

## The Point

The developer never touches `interpret()`, `step()`, `Zero.structural()`, `CHANGEFEED`, `WritableContext`, or any of the algebra primitives. Those are implementation details of the facade. The developer sees:

```
Schema.doc({ ... })    →  define structure
createDoc(schema)      →  get a live document
doc.title()            →  read current value
doc.title.insert(...)  →  mutate naturally
`Title: ${doc.title}`  →  coerce in templates
change(doc, fn)        →  batch mutations in a transaction
subscribe(ref, cb)     →  observe changes
validate(schema, data) →  validate & narrow types
doc.toJSON()           →  snapshot
```

This is the same API shape as `@loro-extended/change` — but backed by the clean, mathematically rigorous schema algebra instead of 10+ parallel `switch` dispatch sites.