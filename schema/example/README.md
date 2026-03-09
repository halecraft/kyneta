# @loro-extended/schema — Example Mini-App

A self-contained example that builds a high-level document API on top of the schema algebra primitives, then uses it to demonstrate the apex developer experience — the same ergonomics as `@loro-extended/change`, but running on a plain JS object store with zero CRDT runtime.

## Running

```sh
# From packages/schema/
npx tsx example/main.ts
```

## Structure

The example has two halves:

### The Facade (~100 lines)

A thin, high-level API built entirely from schema primitives. In production this would live in its own package (or in `@loro-extended/change`). Here it lives in the example to prove the algebra supports this developer experience.

- **`createDoc(schema, seed?)`** — Creates a typed, writable, observable document handle from a schema and optional seed values. Wires up the store, writable context, changefeed context, enrichment, interpretation, and `toJSON()` in a single call.
- **`change(doc, fn)`** — Batches mutations into a single atomic flush. The callback receives a draft with the same typed API.
- **`subscribe(ref, callback)`** — Subscribes to changes on any changefeed ref. Returns an unsubscribe function.

### The App (~200 lines)

Uses the facade exactly like an application developer would:

1. **Define a Schema** — `Schema.doc({ ... })` with text, counter, list, struct, record
2. **Create a Document** — `createDoc(ProjectSchema, { name: "..." })`
3. **Direct Mutations** — `doc.name.insert()`, `doc.stars.increment()`, `doc.settings.visibility.set()`
4. **Working with Lists** — `doc.tasks.push()`, `doc.tasks.get(0).title.get()`, iteration, delete
5. **Working with Records** — Dynamic key access via Proxy, `Object.keys()`, `in` operator
6. **Batched Mutations** — `change(doc, d => { d.name.update(...); d.stars.increment(...) })`
7. **Subscribing to Changes** — `subscribe(doc.name, action => ...)`, unsubscribe
8. **Portable Refs** — Extract refs, pass to standalone generic functions
9. **Referential Identity & Namespace Isolation** — `doc.name === doc.name`, `Object.keys(doc)` returns only schema keys
10. **Validation** — `validate(ProjectSchema, snapshot)` narrows to `Plain<typeof ProjectSchema>`, `tryValidate()` collects multiple errors with human-readable paths, `validate()` throws `SchemaValidationError` on first error
11. **Final Snapshot** — `doc.toJSON()` returns the full plain object

## The Point

The developer never touches `interpret()`, `step()`, `Zero.structural()`, `CHANGEFEED`, `WritableContext`, or any of the algebra primitives. Those are implementation details of the facade. The developer sees:

```
Schema.doc({ ... })    →  define structure
createDoc(schema)      →  get a live document
doc.title.insert(...)  →  mutate naturally
change(doc, fn)        →  batch mutations
subscribe(ref, cb)     →  observe changes
validate(schema, data) →  validate & narrow types
doc.toJSON()           →  snapshot
```

This is the same API shape as `@loro-extended/change` — but backed by the clean, mathematically rigorous schema algebra instead of 10+ parallel `switch` dispatch sites.