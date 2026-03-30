# @kyneta/react

Thin React bindings for [`@kyneta/schema`](../schema) and [`@kyneta/exchange`](../exchange). Subscribe to collaborative documents with hooks, get plain JS snapshots with stable referential equality.

## Install

```sh
pnpm add @kyneta/react @kyneta/schema @kyneta/exchange react
```

## Quick Start

```tsx
import {
  ExchangeProvider,
  useDocument,
  useValue,
  change,
  Schema,
} from "@kyneta/react"
import { bindLoro, LoroSchema } from "@kyneta/loro-schema"

// 1. Define your schema and bind to a substrate
const TodoSchema = LoroSchema.doc({
  title: LoroSchema.text(),
  items: Schema.list(
    Schema.struct({ text: Schema.string(), done: Schema.boolean() }),
  ),
})
const TodoDoc = bindLoro(TodoSchema)

// 2. Wrap your app in ExchangeProvider
function Root() {
  return (
    <ExchangeProvider config={{ adapters: [/* your adapter */] }}>
      <App />
    </ExchangeProvider>
  )
}

// 3. Use hooks to read and mutate
function App() {
  const doc = useDocument("my-doc", TodoDoc)
  const value = useValue(doc)
  // value: { title: string, items: { text: string, done: boolean }[] }

  return (
    <div>
      <h1>{value.title}</h1>
      <ul>
        {value.items.map((item, i) => (
          <li key={i}>
            <input
              type="checkbox"
              checked={item.done}
              onChange={() =>
                change(doc, (d) => {
                  d.items.at(i)?.done.set(!item.done)
                })
              }
            />
            {item.text}
          </li>
        ))}
      </ul>
      <button
        onClick={() =>
          change(doc, (d) => {
            d.items.push({ text: "New todo", done: false })
          })
        }
      >
        Add
      </button>
    </div>
  )
}
```

## API

### `<ExchangeProvider config={...}>`

Provides an `Exchange` instance to the React subtree. Creates the exchange from `config` on mount, calls `exchange.reset()` on unmount.

```tsx
<ExchangeProvider config={{ adapters: [wsAdapter] }}>
  <App />
</ExchangeProvider>
```

### `useExchange()`

Retrieves the `Exchange` from the nearest `ExchangeProvider`. Throws if called outside a provider.

### `useDocument(docId, boundSchema)`

Gets (or creates) a document from the Exchange. Returns a full-stack `Ref<S>` — callable, navigable, writable, transactable, and observable. Multiple calls with the same `docId` and `boundSchema` return the same ref instance.

```tsx
const doc = useDocument("my-doc", TodoDoc)
```

### `useValue(ref)`

Subscribes to a ref's current plain value. Returns `Plain<S>` — a plain JS snapshot — and re-renders when the changefeed fires. The snapshot is memoized for referential equality.

```tsx
// Full document — re-renders on any descendant change
const value = useValue(doc)

// Leaf field — re-renders only when this field changes
const title = useValue(doc.title)

// Nullish passthrough
const maybeValue = useValue(optionalRef) // null/undefined pass through
```

**Subscription granularity:**
- Composite refs (products, sequences, maps) subscribe deep via `subscribeTree` — any descendant change triggers a re-render.
- Leaf refs (scalars, text, counters) subscribe at node level — only own-path changes trigger a re-render.

### `useSyncStatus(doc)`

Subscribes to a document's sync ready-state. Returns `ReadyState[]` and re-renders when the sync status changes.

```tsx
const readyStates = useSyncStatus(doc)
const synced = readyStates.some((s) => s.state === "ready")
```

### Mutations

Use `change()` (re-exported from `@kyneta/schema`) to mutate documents:

```tsx
change(doc, (d) => {
  d.title.set("New title")
  d.items.push({ text: "New item", done: false })
})
```

### Re-exports

`@kyneta/react` re-exports a curated subset so most app code only needs one import:

From `@kyneta/schema`: `change`, `applyChanges`, `subscribe`, `subscribeNode`, `Schema`, `CHANGEFEED`, and types `Ref`, `RRef`, `Plain`, `Changeset`, `Op`, `BoundSchema`.

From `@kyneta/exchange`: `Exchange`, `sync`, `hasSync`, and types `ExchangeParams`, `SyncRef`, `ReadyState`, `DocId`.

## Architecture

The package follows a **Functional Core / Imperative Shell** pattern:

- **Functional Core** (`src/store.ts`): Pure `createChangefeedStore(ref)` and `createSyncStore(syncRef)` functions translate from kyneta's reactive protocols into the `{ subscribe, getSnapshot }` contract. Zero React imports. Independently testable.
- **Imperative Shell** (hooks): `useValue`, `useSyncStatus`, etc. are thin wrappers that feed the pure stores into React's `useSyncExternalStore`.

See [TECHNICAL.md](./TECHNICAL.md) for details on snapshot memoization, type recovery, and subscription strategy.

## Compared to `@loro-extended/react`

| Concern | loro-extended/react | @kyneta/react |
|---|---|---|
| Ref identity | Unstable — `.toJSON()` on every change | Stable — `doc.title === doc.title` |
| Subscription bridge | `createSyncStore` + version-key caching | Direct `CHANGEFEED` → `useSyncExternalStore` |
| `useValue` overloads | 12+ TypeScript overloads | Single conditional return type |
| Framework abstraction | `FrameworkHooks` DI + factory pattern | None — CHANGEFEED is the framework boundary |
| Text input hooks | `useCollaborativeText` (beforeinput) | Deferred (future work) |
| Undo/redo | `useUndoManager` | Deferred (future work) |