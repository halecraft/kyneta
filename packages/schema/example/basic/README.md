# @kyneta/schema — Getting Started

A hands-on walkthrough of the `@kyneta/schema/basic` API. Everything you need to build reactive, syncable documents — define a schema, create a document, read, write, observe, validate, and sync.

## Running

```sh
# From packages/schema/
bun run example/basic/main.ts
```

## What You'll See

| Section | What it covers |
|---|---|
| **Define a Schema** | `Schema.struct({ ... })` with text, counter, list, struct, discriminated union, nullable, record |
| **Create a Document** | `createDoc(schema, seed)` → a live, typed document |
| **Read Values** | Callable refs (`doc.name()`), template coercion (`` `${doc.stars}` ``) |
| **Mutations** | Text insert, counter increment, sequence push, scalar set, map set, product set |
| **Collections** | Lists (`.at()`, `.get()`, `.length`, iteration) and records (`.keys()`, `.has()`, `.size`) |
| **Sums and Nullables** | Discriminated union narrowing, nullable set/read/null |
| **Transactions** | `change(doc, fn)` → `Op[]` — batch mutations atomically |
| **Round-Trip** | `change(docA, fn)` → ops → `applyChanges(docB, ops)` — the sync story |
| **Observation** | `subscribe` (tree-level) and `subscribeNode` (node-level) |
| **Sync** | `version()`, `delta()`, `exportSnapshot()` — version tracking and replication |
| **Validation** | `validate()` and `tryValidate()` — same schema, no separate definition |
| **Portable Refs** | Pass refs to generic functions, template literal coercion |
| **Batched Notification** | One `Changeset` per path, not per change |

## The Import

```ts
import {
  Schema,
  createDoc,
  change,
  applyChanges,
  subscribe,
  subscribeNode,
  version,
  delta,
  exportSnapshot,
  validate,
  tryValidate,
} from "@kyneta/schema/basic"
```

One import path. Batteries included.

## Next Steps

- **Advanced example** — `example/advanced/` dives into the composable interpreter algebra: custom layer stacks, read-only documents, pure state transitions, and symbol-keyed hooks.
- **Recipe Book** — `examples/recipe-book/` is a full-stack SSR app with WebSocket sync, built entirely on `@kyneta/schema/basic`.
