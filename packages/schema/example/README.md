# @kyneta/schema — Example Mini-App

A self-contained example that exercises the full `@kyneta/schema` API surface using direct library imports — no local facade, no wrapper class. Every function used here (`change`, `applyChanges`, `subscribe`, `subscribeTree`, `validate`, etc.) is imported from the library barrel.

## Architecture

The interpreter stack decomposes into **five composable layers**, each independently useful:

| Layer | What it provides | Context needed |
|---|---|---|
| `navigation` | Structural addressing — product field getters, `.at()`, `.keys()`, `.length`, sum dispatch | `RefContext { store }` |
| `readable` | Fills the `[CALL]` slot — `ref()` returns the current plain value | `RefContext { store }` |
| `caching` | Identity-preserving memoization — `doc.name === doc.name` | `RefContext { store }` |
| `writable` | Mutation methods — `.set()`, `.insert()`, `.increment()`, `.push()`, `.delete()` | `WritableContext { store, dispatch, … }` |
| `changefeed` | Observation protocol — `[CHANGEFEED]`, `subscribe`, `subscribeTree` | `RefContext` (works on read-only stacks too) |

The pre-built `readable` layer bundles navigation + reading + caching in one step. Most users compose with the pre-built layers:

**Fluent composition:**

```ts
const doc = interpret(schema, ctx)
  .with(readable)
  .with(writable)
  .with(changefeed)
  .done()   // → Ref<typeof schema>
```

**Manual composition (equivalent):**

```ts
const interp = withChangefeed(withWritable(withCaching(withReadable(withNavigation(bottomInterpreter)))))
const doc = interpret(schema, interp, ctx)   // carrier type A (use ResolveCarrier<S, A> for schema-level type)
```

Both `interpret()` paths infer the correct ref type — `Ref<S>` for the full stack, `RWRef<S>` for read-write without changefeed, `RRef<S>` (≡ `Readable<S>`) for read-only. The fluent builder uses phantom brands; the three-arg form returns the raw carrier type `A` (honest with `HasTransact` and `HasChangefeed` from transformer return types).

Each concern is independently useful — a read-only document needs only the `readable` layer and a bare `{ store }` context.

## Running

```sh
# From packages/schema/
bun run example/main.ts

# Or with tsx:
npx tsx example/main.ts
```

## Structure

### Setup

Write `createDoc` once — use it everywhere:

```ts
function createDoc<S extends SchemaNode>(schema: S, seed?: Record<string, unknown>): Ref<S>
function createDoc(schema, seed = {}) {
  const defaults = Zero.structural(schema)
  const initial = Zero.overlay(seed, defaults, schema)
  const store = { ...initial }
  const ctx = createWritableContext(store)
  return interpret(schema, ctx)
    .with(readable).with(writable).with(changefeed).done()
}

const doc = createDoc(ProjectSchema, { name: "Schema Algebra", ... })
```

### Library-Level Functions

The example uses four library-level functions from `facade.ts` — no local wrappers:

- **`change(ref, fn)`** — Runs mutations inside a transaction, returns `PendingChange[]`. Discovers the `WritableContext` via `ref[TRANSACT]`.
- **`applyChanges(ref, ops, options?)`** — Applies captured changes to a (potentially different) document. Triggers the full prepare/flush pipeline. Supports `{ origin }` provenance tagging.
- **`subscribe(ref, cb)`** — Node-level observation. Callback receives a `Changeset`.
- **`subscribeTree(ref, cb)`** — Tree-level observation for composites (products, sequences, maps). Callback receives `Changeset<TreeEvent>` with relative paths.

### The Sections (~600 lines)

The example is organized into 14 sections:

1. **Define a Schema** — `Schema.doc({ ... })` with text, counter, list of struct, struct, discriminated union, nullable, record, constrained scalars
2. **Create a Document** — Inline setup with `Zero.overlay`, `createWritableContext`, fluent builder. Shows `doc()` snapshot.
3. **Mutations: Five Change Types** — Text (`doc.name.insert`), counter (`doc.stars.increment`), sequence (`doc.tasks.push`), replace (`doc.settings.darkMode.set`), map (`doc.labels.set`), product bulk `.set()`
4. **Working with Collections** — Lists: `.at(i)`, `.get(i)`, `.length`, iteration, `.insert()`, `.delete()`. Records: `.at(key)`, `.get(key)`, `.has()`, `.keys()`, `.size`
5. **Sums and Nullables** — Discriminated union with native narrowing (`if (doc.content.type === "text") { doc.content.body() }`). Nullable: set to value, read, set back to null.
6. **Transactions with `change()`** — Library-level `change()` returns `PendingChange[]`. All five change types in one atomic transaction.
7. **Observing Changes** — `subscribe(doc.stars, cb)` for leaf observation. `subscribeTree(doc, cb)` for tree observation with multi-level relative paths (`tasks[2].done`, `settings.fontSize`). Unsubscribe.
8. **The Round-Trip: `change` → `applyChanges`** — Capture ops on docA, apply to docB with `{ origin: "sync" }`. Assert deep equality. The sync story in 10 lines.
9. **Batched Notification and Origin** — `applyChanges` delivers one `Changeset` per affected path (not per change). Subscribers see fully-applied state. Origin provenance flows through.
10. **Portable Refs** — Pass refs to generic functions (`tag(ref, label)`, `ensureMinimum(counter, min)`). Template literal coercion via `[Symbol.toPrimitive]`.
11. **Validation** — Same schema, no separate Zod definition. `validate()` narrows to `Plain<S>`. `tryValidate()` collects errors with human-readable paths. `SchemaValidationError` on first error.
12. **The Composition Algebra** — Read-only documents by dropping layers. Fluent vs. manual composition. Referential identity. Namespace isolation. Symbol-keyed hooks.
13. **Pure State Transitions with `step`** — `stepText`, `stepSequence`, `stepIncrement` — apply changes to plain values without any interpreter machinery.
14. **Final Snapshot** — `doc()` returns the full plain object.

## Key Concepts

### Callable Refs

Every ref produced by the `readable` layer is a function: `ref()` returns the current plain value. This is the foundational read API — no `.get()` method needed.

```ts
doc.name()           // "Schema Algebra" — current string value
doc.stars()          // 42 — current number value
doc.settings()       // { darkMode: false, fontSize: 14 } — deep plain snapshot
doc.tasks.at(0)()    // { title: "...", done: false, priority: 1 }
```

### Template Literal Coercion

Leaf refs have `[Symbol.toPrimitive]`, so they work in template literals without calling `ref()`:

```ts
`Project: ${doc.name}`   // "Project: Schema Algebra" — via toPrimitive
`Stars: ${doc.stars}`    // "Stars: 42" — hint-aware coercion
+doc.stars               // 42 — numeric coercion
```

### Transactions via `[TRANSACT]`

Every ref carries a `[TRANSACT]` symbol referencing its `WritableContext`. The library-level `change()` uses this to enter a transaction without re-interpretation:

```ts
const ops = change(doc, d => {
  d.name.insert(0, "✨ ")
  d.stars.increment(10)
})
// ops: PendingChange[] — can be sent to another doc via applyChanges
```

Under the hood:

```ts
function change(ref, fn) {
  const ctx = ref[TRANSACT]
  ctx.beginTransaction()
  try {
    fn(ref)
    return ctx.commit()  // → PendingChange[]
  } catch (e) {
    ctx.abort()
    throw e
  }
}
```

### Observation via `subscribe` and `subscribeTree`

Library-level functions — no raw `[CHANGEFEED]` access needed:

```ts
// Node-level: fires only for changes at this exact ref
const unsub = subscribe(doc.stars, (changeset) => {
  console.log(changeset.changes, changeset.origin)
})

// Tree-level: fires for changes anywhere in the subtree
subscribeTree(doc.settings, (changeset) => {
  for (const event of changeset.changes) {
    console.log(event.path, event.change.type)
  }
})
```

`subscribe` is node-level (fires only for changes at that ref). `subscribeTree` fires for all descendant changes with relative paths. Both deliver `Changeset` — the protocol's unit of batched notification.

### Read-Only Documents

The readable layer needs only a store — no dispatch, no mutation methods, no observation:

```ts
const ctx: RefContext = { store }
const doc = interpret(schema, ctx)
  .with(readable)
  .done()   // → RRef<typeof schema> (≡ Readable<typeof schema>)

doc.name()         // ✓ reads work
doc.name.insert    // undefined — no mutation methods
hasChangefeed(doc) // false — no observation
hasTransact(doc)   // false — no transactions
```

### Composition

The layers compose freely. Navigation is the foundational structural capability. Reading fills the `[CALL]` slot. Writing and observation are independent.

```ts
// Read-only → RRef<S>:
interpret(schema, { store }).with(readable).done()

// Read + write → RWRef<S>:
interpret(schema, ctx).with(readable).with(writable).done()

// Read + write + observe → Ref<S>:
interpret(schema, ctx).with(readable).with(writable).with(changefeed).done()
```

The `changefeed` layer accepts `RefContext` — it works on read-only stacks too, producing valid Moore machines (`.current` works, `.subscribe` never fires since there's no mutation source).

## Symbol-Keyed Composability Hooks

| Symbol | Module | Purpose |
|---|---|---|
| `CALL` (`kyneta:call`) | `bottom.ts` | Controls what `carrier()` does — `withReadable` fills it |
| `INVALIDATE` (`kyneta:invalidate`) | `with-caching.ts` | Change-driven cache invalidation — prepare pipeline hook |
| `TRANSACT` (`kyneta:transact`) | `writable.ts` | Context discovery — refs carry a reference to their `WritableContext` |
| `CHANGEFEED` (`kyneta:changefeed`) | `with-changefeed.ts` | Observation coalgebra — `withChangefeed` attaches it with `subscribeTree` |

## The Point

The developer sees a clean, high-level API — all library imports:

```
Schema.doc({ ... })           →  define structure
createDoc(schema, seed)       →  get a live document

doc.name()                    →  read current value
doc.name.insert(...)          →  mutate naturally
`Name: ${doc.name}`           →  coerce in templates

change(doc, fn)               →  batch mutations, get PendingChange[]
applyChanges(doc, ops)        →  apply ops (from another doc, from sync, etc.)
subscribe(ref, cb)            →  observe changes
subscribeTree(ref, cb)        →  observe subtree changes
validate(schema, data)        →  validate & narrow types
doc()                         →  snapshot
```

This is the same API shape as `@loro-extended/change` — but backed by the clean, mathematically rigorous schema algebra instead of 10+ parallel `switch` dispatch sites.