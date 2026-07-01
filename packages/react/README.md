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
  Schema,
} from "@kyneta/react"
import { Exchange } from "@kyneta/exchange"
import { loro } from "@kyneta/loro-schema"

// 1. Define your schema and bind to a substrate
const TodoSchema = Schema.struct({
  title: Schema.text(),
  items: Schema.list(
    Schema.struct({ text: Schema.string(), done: Schema.boolean() }),
  ),
})
const TodoDoc = loro.bind(TodoSchema)

// 2. Create the Exchange exactly once at module scope so it survives
//    React lifecycle events (e.g. StrictMode remounts).
const exchange = new Exchange({
  id: "me",
  transports: [/* your transport, e.g. createWebsocketClient(...) */],
})

// 3. Wrap your app in ExchangeProvider
function Root() {
  return (
    <ExchangeProvider exchange={exchange}>
      <App />
    </ExchangeProvider>
  )
}

// 4. Use hooks to read and mutate
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
              onChange={() => doc.items.at(i)?.done.set(!item.done)}
            />
            {item.text}
          </li>
        ))}
      </ul>
      <button onClick={() => doc.items.push({ text: "New todo", done: false })}>
        Add
      </button>
    </div>
  )
}
```

## API

### `<ExchangeProvider exchange={...}>`

Provides an `Exchange` instance to the React subtree. The Exchange must be created **outside** the React component tree (e.g. at module scope) so it survives lifecycle events like StrictMode remounts — the provider neither constructs nor tears it down. Recreating an Exchange for the same `peerId` mid-session can corrupt distributed state and leak connections, so the provider guards against it; for the async-dependency case (e.g. waiting on an auth token before you know your identity), reach for `useExchangeSingleton`.

```tsx
import { Exchange } from "@kyneta/exchange"
import { createWebsocketClient } from "@kyneta/websocket-transport/browser"

// Create exactly once at module scope
const exchange = new Exchange({
  id: "my-peer",
  transports: [createWebsocketClient({ url: "ws://localhost:3000/ws", WebSocket })],
})

function Root() {
  return (
    <ExchangeProvider exchange={exchange}>
      <App />
    </ExchangeProvider>
  )
}
```

### `useExchangeSingleton(peerId, factory)`

The async-dependency path. Instantiates an Exchange inside the React tree while still guaranteeing one instance per `peerId` — immune to React 18 StrictMode double-invocation. Pass `peerId` (or `null`/`undefined` while the identity is still loading) and a `factory` invoked at most once per peer; returns the `Exchange`, or `null` until `peerId` is available. Prefer module-scope construction above when you can.

```tsx
const exchange = useExchangeSingleton(user?.id, () => {
  const id = user?.id
  if (!id) throw new Error("user id required")
  return new Exchange({ id, transports: [createWebsocketClient({ url: "ws://localhost:3000/ws", WebSocket })] })
})
if (!exchange) return null
return (
  <ExchangeProvider exchange={exchange}>
    <App />
  </ExchangeProvider>
)
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

`useValue` re-renders on any descendant change (it reads the whole value). To re-render *parsimoniously* — only when the part you use changes — reach for `useSelector`.

### `useSelector(ref, select)`

Projects a ref to a derived value and re-renders **only when the nodes `select` actually read change** — auto-tracked, no deps array, no `isEqual`. A `text` edit never re-renders a `done`-only selector, and nothing is materialized unless `select` asks for it.

```tsx
// Re-renders only when the visible set of todo refs changes (add/remove, or a
// `done` flip crossing the filter) — NOT when a todo's text is edited.
const visible = useSelector(doc.todos, todos =>
  [...todos].filter(t => (filter === "all" ? true : t.done())),
)
```

The `select` closure may freely close over props/state (e.g. a URL `filter`) with **no deps array** — it re-runs every render to follow the latest closure.

### `useTracked(thunk)`

The primitive behind `useValue`/`useSelector`. Runs an arbitrary `thunk` reading kyneta refs (and/or other reactives), auto-tracks its reads, and re-renders when they change. `useValue(ref) ≡ useTracked(() => ref())`; `useSelector(ref, fn) ≡ useTracked(() => fn(ref))`.

Built on [`@kyneta/reactive`](../reactive); change detection is version-driven (no value comparison) and microtask-coalesced.

### `useDocReady(doc, opts?)`

The 90% gate. Returns a **monotonic** `boolean` that flips to `true` the first time the doc reconciles with a peer (receives data, **or** a terminal `vacant` reply) and never regresses — across the reconnect re-handshake flip or a reconciled peer departing. Flicker-free (a stable scalar). Pass `opts.peer` to require reconciliation with a peer matching a predicate (authority / quorum).

```tsx
const ready = useDocReady(doc)
if (!ready) return <Spinner />
// require a service peer specifically:
const authReady = useDocReady(doc, { peer: (p) => p.type === "service" })
```

### `useSyncState(doc)`

The raw escape hatch (renamed from `useSyncStatus` in 2.0 — **breaking**). Returns `PeerSyncState[]` (`{ docId, peer, state: "pending" | "synced" | "vacant" }`) and re-renders on any per-peer change. Volatile — an entry can regress `synced → pending` on reconnect; for a stable gate use `useDocReady`.

```tsx
const peerStates = useSyncState(doc)
const synced = peerStates.some((s) => s.state === "synced")
```

### `sync(doc).settled(opts?)`

Promise that resolves (never rejects): `{ via: "local" }` immediately when no transports are configured, `{ via: "peer" }` on first reconciliation, or `{ via: "offline" }` after `opts.offlineAfter` ms with no upstream. `describeSyncStatus(peerStates, connectivity, ready)` projects the primitives into a single display label (`"connecting" | "pending" | "synced" | "vacant" | "offline"`).

### Mutations

A single mutation can be written directly — `doc.title.set("New title")` auto-commits. Use `batch()` (re-exported from `@kyneta/schema`) to group **multiple** mutations into one atomic commit and one notification:

```tsx
batch(doc, (d) => {
  d.title.set("New title")
  d.items.push({ text: "New item", done: false })
})
```

### Re-exports

`@kyneta/react` re-exports a curated subset so most app code only needs one import:

From `@kyneta/schema`: `batch`, `applyChanges`, `subscribe`, `subscribeNode`, `Schema`, `CHANGEFEED`, and types `Ref`, `RRef`, `Plain`, `Changeset`, `Op`, `BoundSchema`.

From `@kyneta/exchange`: `Exchange`, `sync`, `hasSync`, `describeSyncStatus`, and types `ExchangeParams`, `SyncRef`, `PeerSyncState`, `Connectivity`, `SyncStatusSummary`, `PeerIdentityDetails`, `DocId`.

## Architecture

The package follows a **Functional Core / Imperative Shell** pattern:

- **Functional Core**: reactive change detection lives in [`@kyneta/reactive`](../reactive) (auto-tracked computations over the changefeed) and the React-free `src/store.ts` (the `SyncRef`-backed `createSyncStore` / `createDerivedSyncStore`). Zero React imports. Independently testable.
- **Imperative Shell** (hooks): `useTracked`/`useSelector`/`useValue`, `useSyncState`, `useDocReady`, etc. are thin wrappers that feed reactives / pure stores into React's `useSyncExternalStore`.

See [TECHNICAL.md](./TECHNICAL.md) for details on snapshot memoization, type recovery, and subscription strategy.

## Best Practices

### Prefer `useSelector` over `useValue(doc)` for large documents

`useValue(doc)` materializes the **entire document** — every field, every list item, every text node — into a plain JS snapshot on every render. For a small config doc this is fine. But for a document with a growing `turns` array, a `messages` log, or any unbounded collection, this serializes megabytes of data on every keystroke.

Kyneta refs are **live**: you can traverse the schema and read individual nodes without any serialization. `doc.activeStudentTurnId()` reads one scalar. `doc.turns.at(0)?.role()` reads one field of one item. The ref never builds a full snapshot unless you call `()` on the root.

`useSelector` exploits this: it auto-tracks exactly the nodes your `select` function reads, and re-renders **only** when those specific nodes change. A `text` edit in turn #5 never re-renders a `status`-only selector.

**Avoid this — serializes the entire document on every change:**

```tsx
// ❌ Re-renders on ANY change anywhere in the document, materializing
// every turn's full text content into a JS snapshot each time.
function Conversation({ docRef }) {
  const doc = useValue(docRef)
  return <div>{doc.turns.at(0)?.content}</div>
}
```

**Do this instead — reads only what it needs, re-renders only when those nodes change:**

```tsx
// ✅ Re-renders only when the active student turn's content changes.
function StudentText({ docRef }) {
  const text = useSelector(docRef, doc => {
    const id = doc.activeStudentTurnId()
    if (!id) return ''
    for (const turn of doc.turns) {
      if (turn.id() === id && turn.role() === 'student')
        return turn.content.toString()
    }
    return ''
  })
  return <div>{text}</div>
}

// ✅ Independent selector — re-renders only on status changes,
// NOT when student text is edited.
function StatusBar({ docRef }) {
  const status = useSelector(docRef, doc => doc.state().status)
  return <Badge>{status}</Badge>
}
```

**When `useValue` is appropriate:**

- Small, bounded documents (config, settings, topology)
- Leaf refs: `useValue(doc.title)` tracks only the `title` field
- Prototyping (swap to `useSelector` when the document grows)

### Subscribe to nested refs for targeted reactivity

`useSelector` can accept any ref, not just the root. Subscribing to `doc.todos` tracks the list structure (add/remove) but not descendant text edits — perfect for a filter that only cares about `done` flags.

```tsx
const visible = useSelector(doc.todos, todos =>
  [...todos].filter(t => t.done()),
)
```

For a specific text field's insertions, subscribe directly to that ref:

```tsx
const chunk = useSelector(inferenceRef.response, response =>
  response.toString().slice(lastLength),
)
```

This fires only when `response` changes — not when `prompt` or `status` change on the same document.

## Compared to `@loro-extended/react`

| Concern | loro-extended/react | @kyneta/react |
|---|---|---|
| Ref identity | Unstable — `.toJSON()` on every change | Stable — `doc.title === doc.title` |
| Subscription bridge | `createSyncStore` + version-key caching | Direct `CHANGEFEED` → `useSyncExternalStore` |
| `useValue` overloads | 12+ TypeScript overloads | Single conditional return type |
| Framework abstraction | `FrameworkHooks` DI + factory pattern | None — CHANGEFEED is the framework boundary |
| Text input hooks | `useCollaborativeText` (beforeinput) | Deferred (future work) |
| Undo/redo | `useUndoManager` | Deferred (future work) |

## License

MIT