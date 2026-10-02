# @kyneta/react

Thin React bindings for [`@kyneta/schema`](../schema) and [`@kyneta/exchange`](../exchange). Subscribe to collaborative documents with hooks, and get frozen plain JS snapshots that keep their identity until they change — so `React.memo` and `useMemo` work as they should.

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
  principal: "me",
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

<!--
Setup shared by the API examples below. Renderers drop HTML comments, so this is
invisible on npm and GitHub — but it is compiled, which is what keeps the
examples honest. It holds only what no block defines for itself.
-->
<!-- ts-docs-prelude
import { Exchange } from "@kyneta/exchange"
import { createDoc } from "@kyneta/schema"
import { loro } from "@kyneta/loro-schema"
import {
  ExchangeProvider,
  Schema,
  batch,
  useDocReady,
  useDocument,
  useExchangeSingleton,
  useSelector,
  useSyncState,
  useText,
  useTracked,
  useValue,
} from "@kyneta/react"
import { createWebsocketClient } from "@kyneta/websocket-transport/browser"

const TodoSchema = Schema.struct({
  title: Schema.text(),
  items: Schema.list(
    Schema.struct({ text: Schema.string(), done: Schema.boolean() }),
  ),
})
const TodoDoc = loro.bind(TodoSchema)

const exampleDoc = createDoc(TodoDoc)
declare const App: () => React.ReactNode
declare const Badge: (props: { count: number }) => React.ReactNode
declare const Spinner: () => React.ReactNode
declare const user: { id: string; name: string }
declare const filter: string
const optionalRef: (typeof exampleDoc)["title"] | null = null
-->

## API

### `<ExchangeProvider exchange={...}>`

Provides an `Exchange` instance to the React subtree. The Exchange must be created **outside** the React component tree (e.g. at module scope) so it survives lifecycle events like StrictMode remounts — the provider neither constructs nor tears it down. Each Exchange holds its own seat, so recreating one for the same principal corrupts nothing, but it opens a second connection while the first stays open; the provider warns when it happens. For the async-dependency case (e.g. waiting on an auth token before you know who the user is), reach for `useExchangeSingleton`.

<!-- ts-docs-standalone -->
<!-- Not compiled: a fragment from inside a component, or one assuming a document shape the shared prelude does not declare. -->
<!-- ts-docs-verifier:ignore -->
```tsx
import { Exchange } from "@kyneta/exchange"
import { createWebsocketClient } from "@kyneta/websocket-transport/browser"

// Create exactly once at module scope
const exchange = new Exchange({
  principal: "alice",
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

### `useExchangeSingleton(principal, factory)`

The async-dependency path. Instantiates an Exchange inside the React tree, one per `principal` — immune to React 18 StrictMode double-invocation. Pass `principal` (or `null`/`undefined` while it is still loading) and a `factory` that returns an `Exchange` or a promise of one, invoked at most once per principal; returns the `Exchange`, or `null` until the principal is known and the factory has resolved. A rejected factory is thrown during render, for an error boundary. Prefer module-scope construction above when you can.

<!-- ts-docs-standalone -->
<!-- Not compiled: a fragment from inside a component, or one assuming a document shape the shared prelude does not declare. -->
<!-- ts-docs-verifier:ignore -->
```tsx
const exchange = useExchangeSingleton(user?.id, async () => {
  const principal = user?.id
  if (!principal) throw new Error("user id required")
  const store = await createIndexedDBStore(`app-${principal}`)
  return new Exchange({
    principal,
    store,
    transports: [createWebsocketClient({ url: "ws://localhost:3000/ws", WebSocket })],
  })
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

Subscribes to a ref's current plain value. Returns `Plain<S>` — a frozen plain JS snapshot — and re-renders when the value changes. The snapshot keeps its identity across renders until the value changes, and a change leaves every unchanged part of it the same object, so a `React.memo` child given one part re-renders only when that part changed.

<!-- ts-docs-setup
const doc = createDoc(TodoDoc)
-->
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

<!-- ts-docs-setup
const doc = createDoc(TodoDoc)
-->
<!-- Not compiled: a fragment from inside a component, or one assuming a document shape the shared prelude does not declare. -->
<!-- ts-docs-verifier:ignore -->
```tsx
// Re-renders only when the visible set of todo refs changes (add/remove, or a
// `done` flip crossing the filter) — NOT when a todo's text is edited.
const visible = useSelector(doc.todos, todos =>
  [...todos].filter(t => (filter === "all" ? true : t.done())),
)
```

The `select` closure may freely close over props/state (e.g. a URL `filter`) with **no deps array**: an inline closure is a new function each render, so it re-runs and follows them.

### `useTracked(thunk)`

The primitive behind `useValue`/`useSelector`. Runs an arbitrary `thunk` reading kyneta refs (and/or other reactives), auto-tracks its reads, and re-renders when they change. `useSelector(ref, fn)` is `useTracked` over `() => fn(ref)`, memoized on `ref` and `fn`; `useValue(ref)` is `useSelector(ref, readValue)`, with one module-level `readValue`.

Built on [`@kyneta/reactive`](../reactive); change detection is version-driven (no value comparison) and microtask-coalesced.

**Identity.** The value is new on any change to what the thunk tracked, and otherwise keeps its identity — as long as the thunk does. The thunk's identity is its change signal: an inline thunk is a new function each render, so it re-runs (and follows props with no deps array). To keep the value stable across renders that change nothing, keep the thunk stable — React Compiler does this for an inline thunk, and `useCallback` does it by hand:

<!-- Not compiled: a fragment from inside a component. -->
<!-- ts-docs-verifier:ignore -->
```tsx
const visible = useTracked(
  useCallback(() => [...doc.todos].filter(t => t.done() === done), [done]),
)
```

The thunk must be pure over what it captures and what it reads: one that reads `Date.now()` or a mutable ref returns a stale value once its identity is stable. Values read from documents are frozen; copy one (`structuredClone`) to mutate it.

### `useDocReady(doc, opts?)`

The 90% gate. Returns a **monotonic** `boolean` that flips to `true` the first time the doc reconciles with a peer (receives data, **or** a terminal `vacant` reply) and never regresses — across the reconnect re-handshake flip or a reconciled peer departing. Flicker-free (a stable scalar). Pass `opts.authority` to require a specific peer (or `"self"`) to have answered.

<!-- Not compiled: a fragment from inside a component, so it returns at top level. -->
<!-- ts-docs-verifier:ignore -->
```tsx
const ready = useDocReady(doc)
if (!ready) return <Spinner />
// require a service peer specifically:
const authReady = useDocReady(doc, { authority: (p) => p.principal === "my-server" })
```

### `useSyncState(doc)`

The raw escape hatch (renamed from `useSyncStatus` in 2.0 — **breaking**). Returns `PeerSyncState[]` (`{ docId, peer, state: "pending" | "synced" | "vacant" }`) and re-renders on any per-peer change. Volatile — an entry can regress `synced → pending` on reconnect; for a stable gate use `useDocReady`.

<!-- ts-docs-setup
const doc = createDoc(TodoDoc)
-->
```tsx
const peerStates = useSyncState(doc)
const synced = peerStates.some((s) => s.state === "synced")
```

### `whenSettled(doc, opts?)`

Resolves once every truth source has reported — the stored data finished loading *and* the authority answered. `{ via: "local" }` when nothing upstream had to answer: no transports are configured, or this peer *is* the authority (`authority: "self"`). `{ via: "peer" }` once the authority reconciles, `{ via: "offline" }` after `opts.offlineAfter` ms. Rejects only if the store read failed. For a display label, compose `connectivity`, `peerStates`, and `docStatus(doc)`.

### Mutations

A single mutation can be written directly — `doc.title.set("New title")` auto-commits. Use `batch()` (re-exported from `@kyneta/schema`) to group **multiple** mutations into one atomic commit and one notification:

<!-- ts-docs-setup
const doc = createDoc(TodoDoc)
-->
<!-- Not compiled: a fragment from inside a component, or one assuming a document shape the shared prelude does not declare. -->
<!-- ts-docs-verifier:ignore -->
```tsx
batch(doc, (d) => {
  d.title.set("New title")
  d.items.push({ text: "New item", done: false })
})
```

A plain (`json.bind`) document backed by stores refuses writes until it has loaded, so render its write controls once `useDocReady(doc)` is `true`. `useText` handles this itself: its element stays read-only until the document has loaded, then shows the loaded text.

A stored `json` document also refuses writes when another tab of the same store writes it: of the tabs sharing a store, one writes each `json` document, and the others read it. A document a `canWrite` policy keeps from this peer refuses them too, on any backend: it is read-only here, and another peer writes it. So does a document whose authority refused this peer's operations: its writes forked from the authority's, and destroying and opening it again rejoins. And every document refuses writes once it is closed (`exchange.destroy`, or its Exchange shut down): it still reads its last value. `useText` handles all of these: its element is read-only while the document refuses writes, and still shows the writer's edits. For any other editor, `useWriteRefusal(doc)` returns the refusal, a `WriteRefusal`, or `undefined`. Narrow it with `instanceof` to say why: a `NotAWriterError` names the document and the identity the policy rejected, an `OfferRefusedError` names the authority that refused this peer's operations, a `WriterRefusedError` names the writer, a `DocumentLoadingError` lasts until the document has loaded, and a `DocumentClosedError` is final.

A document that refuses writes hands out no native handle either (`unwrap` throws its refusal), so a read-only view renders through Kyneta refs (`useText` and its siblings), not a native editor binding such as y-prosemirror or loro-prosemirror in read-only mode.

<!-- ts-docs-verifier:ignore -->
```tsx
const refusal = useWriteRefusal(doc)
const why =
  refusal instanceof WriterRefusedError ? "Another tab is editing this" : undefined
return <input disabled={refusal !== undefined} title={why} value={title} onChange={onChange} />
```

### Undo in a text field

Give `useText` an undo stack (`createUndoStack` from `@kyneta/exchange`) and Cmd/Ctrl+Z undoes, Cmd/Ctrl+Shift+Z and Ctrl+Y redo, typing joins a step while the user keeps typing in one place, and the caret goes to what was undone. Without one, `useText` swallows undo (`"prevent"`), since the browser's own undo works on the element's value, which the document moves under it; `undo: "browser"` lets it through for a text nobody else edits.

<!-- Not compiled: a fragment from inside a component. -->
<!-- ts-docs-verifier:ignore -->
```tsx
<textarea ref={useText(card.text, { undo: stack })} />
```

With one stack for many cards, give each card's editor a target that undoes only that card. `useText` binds again when `undo` changes identity, so memoize it:

<!-- Not compiled: a fragment from inside a component. -->
<!-- ts-docs-verifier:ignore -->
```tsx
const undo = useMemo(
  () => ({
    typing: stack.typing,
    undo: (options?: CommitOptions) => stack.undo({ ...options, docs: [cardId] }),
    redo: (options?: CommitOptions) => stack.redo({ ...options, docs: [cardId] }),
  }),
  [stack, cardId],
)
<textarea ref={useText(card.text, { undo })} />
```

### Re-exports

`@kyneta/react` re-exports a curated subset so most app code only needs one import:

From `@kyneta/schema`: `batch`, `applyChanges`, `diffText`, `subscribe`, `subscribeNode`, `Schema`, and types `Ref`, `RRef`, `Plain`, `Op`, `BoundSchema`, `CommitOptions`. From `@kyneta/changefeed`: `CHANGEFEED`, and types `Changefeed`, `Changeset`.

### Document status

<!-- Not compiled: a fragment from inside a component, so it returns at top level. -->
<!-- ts-docs-verifier:ignore -->
```tsx
import { useDocStatus, useInitialize } from "@kyneta/react"

// "pending" until every source has reported; then "empty" or "populated".
const status = useDocStatus(doc)
if (status === "pending") return <Spinner />

// Or: ensure defaults exist, exactly once, without overwriting stored data.
const status = useInitialize(doc, d => d.set({ title: "Untitled" }))
```

`useDocReady(doc)` is sugar for `useDocStatus(doc) !== "pending"` — use it when
you only need a gate, and `useDocStatus` when you need to tell an empty
document from one that already has data.

From `@kyneta/exchange`: `Exchange`, `WriterRefusedError`, `NotAWriterError`, `OfferRefusedError`, `sync`, `whenSettled`, `docStatus`, `initialize`, and types `ExchangeParams`, `SyncRef`, `PeerSyncState`, `Connectivity`, `DocStatus`, `PeerIdentityDetails`, `DocId`.

## Architecture

The package follows a **Functional Core / Imperative Shell** pattern:

- **Functional Core**: reactive change detection lives in [`@kyneta/reactive`](../reactive) (auto-tracked computations over the changefeed) and the React-free `src/store.ts` (the `SyncRef`-backed `createSyncStore`). Zero React imports. Independently testable.
- **Imperative Shell** (hooks): `useTracked`/`useSelector`/`useValue`, `useSyncState`, `useDocReady`, etc. are thin wrappers that feed reactives / pure stores into React's `useSyncExternalStore`.

See [TECHNICAL.md](./TECHNICAL.md) for details on value identity, type recovery, and subscription strategy.

## Best Practices

### Prefer `useSelector` over `useValue(doc)` for large documents

`useValue(doc)` materializes the **entire document** — every field, every list item, every text node — into a plain JS snapshot, and re-renders on **every** change anywhere in it. A read is the store's own frozen value, so it copies nothing, and a change gives new objects only to the path to what changed and shares the rest; but for a document with a growing `turns` array, a `messages` log, or any unbounded collection, every keystroke anywhere still re-renders the component.

Kyneta refs are **live**: you can traverse the schema and read individual nodes without building a snapshot of their parents. `doc.activeStudentTurnId()` reads one scalar. `doc.turns.at(0)?.role()` reads one field of one item. The ref never builds a full snapshot unless you call `()` on the root.

`useSelector` exploits this: it auto-tracks exactly the nodes your `select` function reads, and re-renders **only** when those specific nodes change. A `text` edit in turn #5 never re-renders a `status`-only selector.

**Avoid this — re-renders on every change, and copies the entire document:**

<!-- Not compiled: a fragment from inside a component, or one assuming a document shape the shared prelude does not declare. -->
<!-- ts-docs-verifier:ignore -->
```tsx
// ❌ Re-renders on ANY change anywhere in the document, and materializes
// every turn's full text content into a JS snapshot.
function Conversation({ docRef }) {
  const doc = useValue(docRef)
  return <div>{doc.turns.at(0)?.content}</div>
}
```

**Do this instead — reads only what it needs, re-renders only when those nodes change:**

<!-- Not compiled: a fragment from inside a component, or one assuming a document shape the shared prelude does not declare. -->
<!-- ts-docs-verifier:ignore -->
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

<!-- Not compiled: a fragment from inside a component, or one assuming a document shape the shared prelude does not declare. -->
<!-- ts-docs-verifier:ignore -->
```tsx
const visible = useSelector(doc.todos, todos =>
  [...todos].filter(t => t.done()),
)
```

For a specific text field's insertions, subscribe directly to that ref:

<!-- Not compiled: a fragment from inside a component, or one assuming a document shape the shared prelude does not declare. -->
<!-- ts-docs-verifier:ignore -->
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
| Value identity | New on every read | The same until it changes; unchanged subtrees shared |
| Subscription bridge | `createSyncStore` + version-key caching | Direct `CHANGEFEED` → `useSyncExternalStore` |
| `useValue` overloads | 12+ TypeScript overloads | Single conditional return type |
| Framework abstraction | `FrameworkHooks` DI + factory pattern | None — CHANGEFEED is the framework boundary |
| Text input hooks | `useCollaborativeText` (beforeinput) | `useText` — an uncontrolled `<input>`/`<textarea>` bound through `attach` |
| Undo/redo | `useUndoManager` | `useText(ref, { undo: stack })`, over `createUndoStack` from `@kyneta/exchange`: selective, across documents, durable |

## License

MIT