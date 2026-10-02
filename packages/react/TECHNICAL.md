# @kyneta/react — Technical Reference

> **Package**: `@kyneta/react`
> **Role**: Thin React bindings over `@kyneta/schema` + `@kyneta/exchange`. Bridges the `[CHANGEFEED]` reactive protocol to React's rendering cycle via `useSyncExternalStore`, and provides a framework-agnostic text-adapter for binding native `<input>` / `<textarea>` elements to collaborative `TextRef`s.
> **Depends on**: `@kyneta/schema` (peer), `@kyneta/changefeed` (peer), `@kyneta/exchange` (peer), `@kyneta/reactive` (peer), `react` (>=18, peer)
> **Depended on by**: Application code that renders Kyneta documents in React.
> **Canonical symbols**: `ExchangeProvider`, `useExchange`, `useDocument`, `useTracked`, `useSelector`, `useValue`, `useChangefeed`, `useSyncState`, `useDocReady`, `useDocStatus`, `useInitialize`, `useText`, `useWriteRefusal`, `ExchangeProviderProps`, `UseTextOptions`, `ExternalStore`, `createSyncStore`, `attach`, `transformSelection`, `TextRefLike`, `AttachOptions` (and `diffText`, re-exported from `@kyneta/schema`)
> **Key invariant(s)**:
> 1. The package is an **adapter**, not a renderer. Hooks are thin: the reactive core lives in `@kyneta/reactive`, `@kyneta/schema` and `@kyneta/changefeed`, and each hook bridges it to `useSyncExternalStore`. Zero React imports in `store.ts` or `text-adapter.ts`.
> 2. **The identity rule.** A hook's value changes identity only when a tracked read changed or the thunk's identity changed. Downstream `React.memo` and `useMemo` stay stable across every render that changed nothing.
> 3. `useText` never causes re-renders on text changes. Collaborative text binds imperatively through `text-adapter.ts`; the textarea is an *uncontrolled* element.

A minimal React binding kit. Applications wrap their tree in `ExchangeProvider`, consume documents via `useDocument(bound)`, read values with `useValue(ref)`, gate on sync readiness with `useDocReady(doc)` (or read raw per-peer state with `useSyncState(doc)`), and bind collaborative text fields with `useText(textRef)`. That's the full surface. Heavy lifting — dependency tracking, identity-stable reads, the text diffing + selection rebasing — lives in framework-agnostic packages and modules.

Consumed by application code. Not imported by any other Kyneta package.

---

## Questions this document answers

- How do the hooks interact with `useSyncExternalStore`? → [Auto-tracked reads](#auto-tracked-reads--usetracked--useselector-and-usevalue)
- When does a hook's value keep its identity, and when is it new? → [Identity](#identity)
- Why is `useText` imperative — why doesn't it re-render on text changes? → [`useText` — uncontrolled by design](#usetext--uncontrolled-by-design)
- How does the text-adapter detect what the user typed? → [`diffText`](#difftext)
- How does the text-adapter keep the cursor in the right place during remote edits? → [`transformSelection` — cursor rebasing](#transformselection--cursor-rebasing)
- What's the difference between deep and shallow subscription? → [Deep vs shallow subscription](#deep-vs-shallow-subscription)
- How do I pass an `Exchange` to components without prop-drilling? → [`ExchangeProvider` and `useExchange`](#exchangeprovider-and-useexchange)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `ExternalStore<T>` | `{ subscribe(onStoreChange): unsubscribe, getSnapshot(): T }` — the contract `useSyncExternalStore` consumes. | A state container, a Zustand store — this is the React built-in contract |
| `createSyncStore(syncRef)` | `SyncRef → ExternalStore<PeerSyncState[]>`. One `onPeerSyncChange` subscription; the snapshot is cached because `peerStates` allocates a fresh array per read. | `useChangefeed` — a changefeed needs no store factory |
| `ExchangeProvider` | React context provider that publishes an `Exchange` to descendants. | A DI container |
| `useExchange()` | Reads the `Exchange` from context. Throws if no provider is in the tree. | `useContext` on some generic `ExchangeContext` — this is the curated hook |
| `useDocument(bound)` | Returns `Ref<S>` for `exchange.get(docId, bound)`. Stable across renders; memoizes by `(exchange, docId, bound)`. | `useValue` — `useDocument` returns the *ref*, not the plain value |
| `useValue(ref)` | Returns `Plain<S>`, a frozen snapshot that keeps its identity until the ref's value changes. Re-renders when it does. | `useDocument` |
| `useDocReady(doc, opts?)` | Returns a monotonic `boolean` readiness latch (flicker-free scalar). The 90% gate. | `useSyncState(doc)` — raw per-peer array |
| `useSyncState(doc)` | Returns `PeerSyncState[]` describing per-peer sync progress. Re-renders on per-peer sync changes. | `useValue(doc)` — `useSyncState` looks at the sync surface, not the doc's data |
| `useText(textRef, options?)` | React ref callback that binds a native `<input>` / `<textarea>` to a `TextRef`. Does not re-render on text changes. Read-only while loading, and while the document refuses this peer's writes. | `useValue(textRef)` — use that if you want to *read* the text reactively (e.g., for a character count) |
| `useWriteRefusal(doc)` | Why a stored `json` document refuses this peer's writes (a `WriterRefusedError`: another tab of the store writes it), or `undefined`. Re-renders when it changes. | `useDocReady(doc)` — whether the document has loaded, not whether it may be written |
| `attach(element, textRef, options?)` | Imperative, framework-agnostic: bind an element to a text ref, return a detach function. The foundation of `useText`. | A React hook — `attach` has no React dependency |
| `diffText(oldText, newText, cursorHint?)` | From `@kyneta/schema`, re-exported here: the `TextChange` for the single contiguous edit from `oldText` to `newText`, disambiguated by cursor position. | A general-purpose string diff — `diffText` assumes a single contiguous edit |
| `transformSelection(start, end, instructions)` | Pure function: rebase a selection range through text instructions. | `transformIndex` from `@kyneta/schema` — this is the two-index convenience |
| Deep subscription | Via `subscribeDescendants` — composite refs' descendants' changes trigger re-render. | Shallow subscription |
| Shallow subscription | Via `subscribe` — only the node's own changes trigger re-render (no descendants). | Deep subscription |

---

## Architecture

**Thesis**: React is not a state library. Reactive state is already solved by `[CHANGEFEED]`, dependency tracking by `@kyneta/reactive`, and identity by the reads themselves. Each hook bridges one of them to `useSyncExternalStore`.

Two layers:

| Layer | Module | React? |
|-------|--------|--------|
| **Functional Core** | `store.ts`, `text-adapter.ts` (and upstream: `@kyneta/reactive`, `@kyneta/schema`, `@kyneta/changefeed`) | No imports |
| **Imperative Shell** | `exchange-context.tsx`, `use-*.ts` | Thin React wrappers |

```
Application code
     │
     ├─ ExchangeProvider, useExchange ──── React context
     ├─ useDocument(bound)             ─── exchange.get
     ├─ useTracked(thunk)              ─── useSyncExternalStore ──► reactive(thunk)  [@kyneta/reactive]
     ├─ useSelector(ref, select)       ─── useTracked(useMemo(() => () => select(ref), [ref, select]))
     ├─ useValue(ref)                  ─── useSelector(ref, readValue)
     ├─ useChangefeed(feed)            ─── useSyncExternalStore ──► feed.current, subscribeDescendants | subscribe
     ├─ useSyncState(doc)              ─── useSyncExternalStore ──► createSyncStore(syncRef)
     ├─ useDocStatus(doc)              ─── useChangefeed ────────► docStatusFeed(doc)  [@kyneta/exchange]
     ├─ useDocReady(doc)               ─── useDocStatus(doc) !== "pending"
     └─ useText(textRef)               ─── ref callback         ──► attach(el, textRef)
                                                                     │
                                                                     └─ diffText [@kyneta/schema], transformSelection (pure)
```

Every hook file is ≤100 lines — most are 40–80 — because the work lives in the two pure modules.

### What this package is NOT

- **Not a state container.** There is no local mutable state managed by the package. All state is in the underlying `Exchange` / refs; hooks subscribe to it.
- **Not a component library.** Zero exported components (beyond `ExchangeProvider`, which is a zero-DOM context provider). Applications write their own presentation.
- **Not a router.** No data-fetching orchestration, no suspense integration, no route-aware prefetching.
- **Not tied to a specific React version.** `peerDependencies: { react: ">=18" }`. `useSyncExternalStore` is required (React 18+).
- **Not a controlled-component library for text.** `useText` deliberately avoids the controlled pattern — see [`useText` — uncontrolled by design](#usetext--uncontrolled-by-design).

---

## Identity

A hook's value changes identity only when a tracked read changed or the thunk's identity changed. Three things produce that, none of them in this package:

- **Schema reads** are σ's own frozen values (`@kyneta/schema` TECHNICAL.md §"Read identity"). `ref()` returns the same object until a write copies it, which happens exactly when something at or below the ref changes, and the new value shares every subtree that did not change.
- **Changefeed snapshots.** Every changefeed's `current` keeps its identity until its state changes (`@kyneta/changefeed` TECHNICAL.md §"The identity rule") — `exchange.peers`, `exchange.documents`, index `Collection`s among them.
- **The refresh gate.** `useTracked` returns `reactive.refresh(thunk)`, which re-runs only when the thunk is a new function or a tracked dependency fired, and otherwise returns the value it already has (`@kyneta/reactive` TECHNICAL.md §"`refresh(thunk)`").

**Keeping a thunk stable.** The thunk's identity is its change signal, so an inline thunk — a new function each render — re-runs each render. That is what lets it follow props with no dependency list, and it is cheap, since a read copies nothing. To keep the value's identity across renders that change nothing, keep the thunk stable: React Compiler memoizes an inline thunk on exactly what it captures (a thunk over `doc.todos` and `filter` is kept until one of them changes — refs are identity-stable, so they work as its dependencies), and `useCallback` does the same by hand. `useSelector` does it for you over its own arguments, and `useValue`'s selector is one module-level function.

**Purity.** A thunk must be pure over its captures and its tracked reads. One that reads `useRef().current`, `Date.now()` or a store kyneta does not track returns a stale value once its identity is stable — the contract of `useMemo`, `computed` and React Compiler alike.

**Structural sharing and `React.memo`.** Because a read shares its unchanged subtrees, a `React.memo` child handed part of a `useValue` result skips re-rendering unless its part changed: after an edit to `todos[0]`, `value.todos[1]` is the same object as before. Reads are frozen, so a component cannot corrupt a value another component holds; copy one (`structuredClone`) to mutate it.

---

## Auto-tracked reads — `useTracked` / `useSelector` (and `useValue`)

Source: `packages/react/src/use-tracked.ts`, `use-selector.ts`, `use-value.ts`, over `@kyneta/reactive` (jj:kpywvkpr) + `@kyneta/schema`'s read tracking (jj:vtpxvkyk).

`useTracked(thunk)` runs `thunk` as a reactive computation: it **auto-tracks** exactly the kyneta nodes the thunk reads and re-renders the component only when one of those changes. No deps array, no `scope`, no `isEqual`, no `shallowEqual` — the dependency set is discovered from the reads, and change detection is **version-driven** (the reactive's monotonic `version`, which advances iff a tracked dependency fired), not value comparison.

- `useSelector(ref, select)` is `useTracked` over `() => select(ref)`, memoized on `ref` and `select` — project a ref to a derived value; re-renders only when the nodes `select` actually read change. A `text` edit never re-renders a `done`-only selector, and nothing materializes unless `select` asks for it.
- `useValue(ref)` is `useSelector(ref, readValue)`, with `readValue = r => (r == null ? r : track(r))` one module-level function — the deep-aspect corner: reading `ref()` reports a `deep` dependency, so it re-renders on any descendant change. `track` (from `@kyneta/reactive`) reports plain `HasChangefeed` sources (`exchange.peers`/`documents` `ReactiveMap`s, index `Collection`s) that don't self-report; for schema refs it is a pass-through (they self-report when called). One mechanism, not a second `useMemo`.

### Mechanism: version token + the refresh gate (no deps array)

`useTracked` creates `reactive(thunk)` on mount and wires `useSyncExternalStore(reactive.subscribe, () => reactive.version)` — the **version** is the stable change token, so a CRDT change drives a re-render. The returned value comes from `reactive.refresh(thunk)`, which re-runs only when this render's thunk is a new function or a tracked dependency fired, **without** bumping `version` — so it never loops with the store. (This is why a thunk may freely close over `filter`: a `filter` change makes a new thunk, which `refresh` runs; a CRDT change bumps `version` and re-renders.) `reactive.disposed` lets the hook recreate after React StrictMode's dev mount→unmount→mount.

### Subscription granularity (the corrected vocabulary)

The reactive runtime maps each captured dependency's *aspect* to the existing schema observation primitive — `subscribeNode` (own-path: `value`/`structure`), `subscribe`/`subscribeDescendants` (deep), or a plain `[CHANGEFEED].subscribe` for non-schema sources — reusing the `hasRecursiveChangefeed` discriminator.

### Timing — microtask-coalesced

`useValue`/`useSelector`/`useTracked` re-render on the **next microtask** after a change (the reactive scheduler coalesces a burst of changesets — multiple merges, a sync replay — into one re-run). React re-renders are async anyway, so it is imperceptible, and it is why mutation assertions in tests use `await act(async () => …)`.

### What this is NOT

- **Not value comparison.** No `shallowEqual`/`isEqual` — `version` is the change token. The only imprecision is a no-op write the substrate still emits for (rare, harmless extra re-run).
- **Not a deep subscription by default for selectors.** `useSelector` subscribes to exactly what `select` read (parsimony). Only `useValue` is deep (it reads `ref()` wholesale).

---

## `ExchangeProvider` and `useExchange`

Source: `packages/react/src/exchange-context.tsx`.

React context that *receives* an `Exchange` instance and provides it to the subtree:

```tsx
import { Exchange } from "@kyneta/exchange"
import { createWebsocketClient } from "@kyneta/websocket-transport/browser"

// Create the Exchange once at module scope — it owns persistent network
// connections and must survive React lifecycle events like StrictMode remounts.
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

function SomeComponent() {
  const exchange = useExchange()
  // ...
}
```

### Why the Exchange must survive React's lifecycle

An Exchange is a participant in a distributed protocol — it manages persistent network connections, sync state, and a seat. No two live Exchanges hold one seat, whether their store issues it or their Runtime mints it, so a second Exchange for the same principal corrupts nothing: it is another replica, with its own peer id and its own `Line` outboxes. It still costs a second connection and a second copy of every document, and the first keeps both until it is shut down.

React's component model expects components to be safe to tear down and reconstruct. An Exchange is expensive to. Create it once and let it live for the lifetime of the client.

### Safe patterns

**Module scope** (recommended): Create the Exchange outside the React tree so it survives all lifecycle events.

**`useExchangeSingleton`** (for async dependencies): When you must wait for something (an auth token, a store that opens asynchronously) before creating the Exchange, use `useExchangeSingleton` from `@kyneta/react`. It creates one Exchange per principal, keyed in a hidden module-level cache. The cache holds the factory's promise, stored before anything is awaited, so StrictMode's double effects and later remounts reuse it; the hook returns `null` until it resolves.

```tsx
import { useExchangeSingleton, ExchangeProvider } from "@kyneta/react"

function AppRoot() {
  const { token, user } = useAuth()

  const exchange = useExchangeSingleton(user?.id, async () => {
    const principal = user?.id
    if (!principal) throw new Error("user id required")
    const store = await createIndexedDBStore(`app-${principal}`)
    return new Exchange({
      principal,
      store,
      transports: [createWebsocketClient({ url: `ws://.../?token=${token}` })],
    })
  })

  if (!exchange) return <LoadingSpinner />

  return (
    <ExchangeProvider exchange={exchange}>
      <App />
    </ExchangeProvider>
  )
}
```

`useExchange()` throws if called outside a provider — this is a programmer error that deserves to surface loudly rather than return `undefined` and fail later.

### What `ExchangeProvider` is NOT

- **Not a DI container.** It provides *one* value (the `Exchange`). No factory registry, no scope.
- **Not a render wrapper.** It adds no DOM — it returns its `children` wrapped in a context provider.
- **Not an Exchange factory.** It does not construct or own the Exchange lifecycle. The application creates the Exchange and passes it in. This matches the pattern used by Redux (`<Provider store={store}>`), Apollo (`<ApolloProvider client={client}>`), and React Query (`<QueryClientProvider client={client}>`).

---

## `useChangefeed`

Source: `packages/react/src/use-changefeed.ts`.

```ts
useChangefeed<T>(feed: Changefeed<T, any>): T
```

Subscribe to any `[CHANGEFEED]` source — a schema ref, `exchange.peers`, `exchange.documents`, or a standalone feed — and return its current value, re-rendering exactly when it changes.

`.current` is the snapshot and a subscription is the change signal, which is the `useSyncExternalStore` contract once two things hold. `current` must keep its identity until the source changes — the changefeed identity rule, which every kyneta source keeps — or React warns and loops. And the subscription must cover everything `current` reads: a schema composite's `current` is its whole subtree, so a source that supports descendant subscriptions (`hasRecursiveChangefeed`) is subscribed with `subscribeDescendants`, and any other with `subscribe` — the same choice `@kyneta/reactive` makes for a dependency. `useDocStatus` and `useWriteRefusal` are `useChangefeed` over feeds `@kyneta/exchange` composes.

```tsx
// exchange.peers — a ReactiveMap
const peers = useChangefeed(exchange.peers)
// peers: ReadonlyMap<PeerId, PeerIdentityDetails>

// exchange.documents
const docs = useChangefeed(exchange.documents)

// Schema ref (via changefeed() projector) — re-renders on any edit below it
import { changefeed } from "@kyneta/changefeed"
const todos = useChangefeed(changefeed(doc.todos))
```

### What `useChangefeed` is NOT

- **Not a replacement for `useValue`.** `useValue` also accepts `null` / `undefined`, and tracks reads, so it composes with other tracked reads. `useChangefeed` is the raw binding of one feed.
- **Not `useTracked`.** `useChangefeed` subscribes to the whole changeset stream of a single feed. `useTracked` auto-tracks reads across multiple refs within a thunk.

---

## `useDocument`

Source: `packages/react/src/use-document.ts`.

```ts
useDocument<S>(docId: string, bound: BoundSchema<S>): Ref<S>
```

Memoizes `exchange.get(docId, bound)` by `(exchange, docId, bound)`. Returns the same `Ref<S>` instance across renders while those three references are stable.

Not reactive on its own — the returned `Ref<S>` is a handle, not a value. Pass it to `useValue` to get reactive reads, or use `subscribe` directly.

### What `useDocument` is NOT

- **Not an async hook.** `exchange.get` is synchronous. The ref is immediately usable.
- **Not a query hook.** There's no caching by serialization, no refetch, no stale state. One `(exchange, docId, bound)` triple → one ref.
- **Not coupled to React state.** The ref lives as long as the exchange does, regardless of component lifecycle.

---

## `useValue`

Source: `packages/react/src/use-value.ts`.

```ts
useValue<R extends Feed<unknown> | null | undefined>(ref: R): UseValueResult<R>
```

`UseValueResult<R>` unifies three cases via conditional types:

- `R extends Feed<unknown>` (`@kyneta/changefeed`: a callable carrying `[CHANGEFEED]`, which every ref is) → `ReturnType<R>` (the `Plain<S>`).
- `R extends null` → `null`.
- `R extends undefined` → `undefined`.

The single function signature + conditional return covers the three cases without overload explosion. Hook call count is stable (React's rule) — when `ref` is nullish, the hook still runs; its selector returns the nullish value and tracks nothing, so nothing ever fires.

`useValue(ref)` is `useSelector(ref, readValue)`. `readValue` is one module-level function, so the selector never changes and the value keeps its identity across every render in which the ref's value did not change.

### Composite vs leaf

For composite refs, `useValue` re-renders on any descendant change (deep subscription). For leaf refs, only own-node changes. This matches how applications usually want to render:

```tsx
function TodoItem({ todo }: { todo: Ref<TodoSchema> }) {
  const value = useValue(todo)          // Plain<TodoSchema> — re-renders on any field change
  return <li>{value.text}</li>
}

function Counter({ count }: { count: Ref<CounterSchema> }) {
  const n = useValue(count)              // number — re-renders on .increment()
  return <span>{n}</span>
}
```

### What `useValue` is NOT

- **Not the way to read a subset reactively.** `useValue` materializes the whole value (deep). To project to a derived shape that re-renders parsimoniously (no materialization, no over-subscription), use `useSelector(ref, select)` — see [Auto-tracked reads](#auto-tracked-reads--usetracked--useselector-and-usevalue).
- **Not a debounced subscription.** Every changefeed emission triggers a re-render attempt. React's own batching handles coalescing.
- **Not a suspense boundary.** The hook returns synchronously.

---

## Document status hooks

Source: `packages/react/src/use-doc-status.ts`, `use-initialize.ts`, `use-doc-ready.ts`, `use-sync-state.ts`.

```ts
useDocStatus(doc, opts?): "pending" | "empty" | "populated"
useInitialize(doc, seedFn, opts?): DocStatus
useDocReady(doc, opts?): boolean
useSyncState(doc): PeerSyncState[]
```

`useDocStatus` is the primary one. `"pending"` means some truth source — the
document's store, or its authoritative peer — has yet to report; `"empty"`
means everything has and there is no data; `"populated"` means there is. The
three states exist so that "we do not know yet" cannot be mistaken for "there
is nothing here", which is the distinction that decides whether writing
defaults destroys data. See `@kyneta/exchange`'s TECHNICAL.md §"Document
readiness" for the conjunction behind it.

`useInitialize` writes a document's defaults exactly once, waiting for every
source first. Idempotency lives in `initialize` itself (a per-document promise
cache), so StrictMode's deliberate double-invocation, a remount, or two
components both wanting defaults all collapse to one write. The `seed` and
`onError` callbacks are held in refs rather than dependencies — both are
usually inline arrows, so depending on them would re-run the effect every
render; the document is the identity that matters.

`useDocReady` is now sugar over `useDocStatus` (`status !== "pending"`). It
also gained a behaviour fix: `sync(doc).ready` is `true` on a transportless
exchange, so a local-only app no longer shows a spinner that never resolves.

`useSyncState` remains the raw escape hatch: a live `PeerSyncState[]`,
volatile, for multi-peer indicators and debugging.

### No store core needed

These hooks need no store factory at all, unlike
`useSyncState`. `docStatusFeed` carries `[CHANGEFEED]`, and that protocol is
already the `useSyncExternalStore` contract — `.current` for the snapshot,
`.subscribe()` returning an unsubscribe — so `useChangefeed` bridges them
directly.

That matters more than it looks. The status moves for two unrelated reasons:
data arriving, and the last truth source reporting in. A hand-rolled hook would
have to subscribe to both and merge them; the composed feed has already done
that in `@kyneta/exchange`, so there is nothing left to wire in React — the
functional core is upstream, not in `store.ts`.

`createDerivedSyncStore` is consequently gone. It had become a generic
combinator with exactly one caller and one fixed selector, so its `select`
parameter was dead generality kept alive only by its own tests. The caching it
provided is load-bearing and now lives directly in `createSyncStore`; the two
tests that exercised `ready` / `readyFor` selectors were mock-based restatements
of `@kyneta/exchange`'s departure-survival, re-arm, and suspend-survival
integration tests, which assert the same latching against real exchanges.

### What these are NOT

- **Not a connectivity indicator.** They reflect what is known about the
  document's *data*, not transport connectivity — that is
  `sync(doc).connectivity` (`"online" | "connecting" | "offline"`).
- **`useSyncState` is not reactive to peers joining / leaving the connection
  graph.** That is `exchange.peers`. It tracks per-peer sync-state transitions
  on docs that already have peer entries.

---

## `useText` — uncontrolled by design

Source: `packages/react/src/use-text.ts` (hook) + `packages/react/src/text-adapter.ts` (pure core).

```ts
useText(textRef: TextRefLike, options?: UseTextOptions): React.RefCallback<HTMLInputElement | HTMLTextAreaElement>
```

Returns a React ref callback. Assign it to the element's `ref` prop:

```tsx
<textarea ref={useText(doc.body)} />
```

The hook binds the element when it mounts and calls the returned detach function when it unmounts. Between those two events, `useText` **does not cause re-renders on text changes**.

### Binding waits for the document to load

If the document has loaded (`hydrated(textRef)`), the hook calls `attach` at once. Otherwise it calls `attachWhenLoaded(element, textRef, whenHydrated(textRef), options)`, which keeps the element `readOnly` until the promise resolves, then restores the element's own `readOnly` and attaches. If the load fails the element stays read-only: nothing should be typed over state that could not be read.

Two reasons, and they apply to every substrate. Text typed before loading is written over a document nobody has seen, and on a stored plain document the write is refused outright — the refusal would throw inside the `input` handler after the element had already changed, leaving element and model apart. And binding early shows the pre-load (empty) text first.

**A loaded document can still refuse writes.** A stored `json` document that another tab (another seat of the same store) writes is refused: at load, or later if this tab lost a race to write it first, and for the rest of the session. Every document refuses once it closes (destroyed, or its Exchange shut down), with `DocumentClosedError`. Every authored write then throws, so an input handler would throw on the first keystroke with the element already changed, leaving element and model apart — the failure the loading case avoids. So `useText` passes `writeRefusalFeed(textRef)` to `attach` as `AttachOptions.refusal`, and the adapter keeps the element read-only while the refusal is set. Unlike loading, the binding stays: the writer's edits must keep arriving, and a lost race's rollback reaches the element as a remote change. An input that reaches a refused element anyway (dispatched by a script) puts the model's text back rather than throwing. The adapter takes a changefeed, not a document, and so stays free of `@kyneta/exchange`. Other editors disable themselves with `useWriteRefusal`, sugar over `useChangefeed(changefeed(writeRefusalFeed(doc)))`. See §"Serialized documents: one writer seat per storage" in `packages/exchange/TECHNICAL.md`.

`attachWhenLoaded` lives in the framework-agnostic adapter and takes a promise, not a document, so the adapter stays free of `@kyneta/exchange`; its tests use a deferred promise and no React. The synchronous `hydrated` check is what spares a loaded document a read-only flash: `whenHydrated` resolves in a microtask even when the load is long done. The textarea is an *uncontrolled* element — its value lives in the DOM, and the adapter keeps the DOM and the `TextRef` in sync imperatively.

### Why uncontrolled

The controlled pattern for text fields in React re-renders the component on every keystroke, sets `value={...}` on the element, and fights natively with IME composition, autocorrect, selection state, and browser undo. Every one of those concerns must be re-solved per application.

The uncontrolled pattern — register a `ref` callback, bind natively — avoids all of it. The adapter handles IME composition events, rebases selection through remote edits, and sends undo and redo to an undo stack (or swallows them), so undo acts on the document rather than on the element's value. No React re-renders are involved; the DOM is authoritative for display, the CRDT is authoritative for state, and the adapter reconciles them.

If the application needs to read the text reactively (for a character counter, for example), use `useValue(textRef)` in a *separate* component that re-renders only on text changes. The counter component can re-render freely without touching the editor.

### `UseTextOptions`

```ts
interface UseTextOptions {
  undo?: UndoTarget | "prevent" | "browser"   // default: "prevent"
}

interface UndoTarget {                         // an UndoStack from @kyneta/exchange is one
  typing(fn: () => void): void
  undo(options?: CommitOptions): Promise<boolean>
  redo(options?: CommitOptions): Promise<boolean>
}
```

- **An `UndoTarget`** — Cmd/Ctrl+Z and the `historyUndo` input event undo through it; Cmd/Ctrl+Shift+Z, Ctrl+Y and `historyRedo` redo. Every keystroke's write runs inside `target.typing`, which joins it to the step before while the user keeps typing in one place. The undo is asked for with a per-`attach` token (`source`), distinct from the echo token: its changeset is patched into the element like a remote edit, and then the caret goes to the end of its last insert or the place of its last delete, instead of being rebased.
- **`"prevent"`** — swallow undo and redo. The browser's own undo works on the element's value, which the document moves under it.
- **`"browser"`** — let the browser undo, for a text nobody else edits.

`UndoTarget` is structural and declared in the adapter, which stays free of `@kyneta/exchange`. An `UndoStack` is one (`text-adapter.test.ts` checks it); a target that undoes one document wraps the stack and passes `docs` to its `undo` and `redo`.

### What `useText` is NOT

- **Not controlled.** Do not pass `value={...}` alongside `useText`. The adapter manages the element's value directly.
- **Not re-rendering on text changes.** The hook is write-only during text edits. Reads happen through `useValue(textRef)` or the DOM directly.
- **Not tied to a specific text component.** `<input type="text">` and `<textarea>` both work. Any element matching the structural shape (having `value`, `selectionStart`, `selectionEnd`, `setRangeText`) could be bound.

### Gotcha — why `useText(doc.body)` needs no cast

`TextRefLike` is composed from canonical pieces — `(() => string) & TextRef & HasChangefeed` — not a hand-declared text-ref shape. The subtlety is the `[CHANGEFEED]` member: it requires only the **loose** `HasChangefeed` surface (`ChangefeedProtocol<unknown, ChangeBase>`), which is exactly what an interpreted ref statically carries. A ref's changefeed generics are *erased* by `@kyneta/schema`'s `Wrap` (it intersects `HasChangefeed` with no type arguments), so the static type of `someRef[CHANGEFEED]` is `ChangefeedProtocol<unknown, ChangeBase>` — **not** a text-specific `ChangefeedProtocol<string, TextChange>`.

A `<string, TextChange>`-specific shim could therefore never match a real ref (its `.current: unknown` is not assignable to `string`), which is why callers historically wrote `as unknown as TextRefLike`. Matching the loose surface removes the cast for every caller; `attach` recovers the text-ness at runtime by narrowing each delivered change with `isTextChange`. There is **no** per-node changefeed generic to lean on — the loose `Changeset<ChangeBase>` is all the static type carries (the runtime `RecursiveChangefeedProtocol` is more specific but isn't reflected statically; see `schema/TECHNICAL.md`'s `RecursiveChangefeedProtocol` discussion).

---

## `diffText`

`diffText(oldText, newText, cursorHint?)` lives in `@kyneta/schema`, beside `transformIndex` in the position algebra, and is re-exported here; its algorithm is documented in `@kyneta/schema`'s TECHNICAL.md §"Position algebra". The adapter calls it with `element.selectionStart` as the cursor hint, which places an edit inside a run of identical characters where the user made it: `"aaa"` → `"aaaa"` has four valid answers, and the cursor names the right one, which matters for CRDT convergence when two peers type into the same run.

It lives in the schema package because a state-based merge needs it too: announcing a text field that a merge or reset moved as `diffText`'s minimal edit, rather than a replace, keeps every bound element's cursor in place.

---

## `transformSelection` — cursor rebasing

Source: `packages/react/src/text-adapter.ts` → `transformSelection`.

```ts
transformSelection(
  selStart: number,
  selEnd: number,
  instructions: readonly TextInstruction[],
): { start: number; end: number }
```

Given a selection range `[selStart, selEnd]` and a list of text instructions that happened elsewhere, produce the rebased selection. Used when a remote edit arrives while the local user has a selection active — the adapter applies the remote edit to the DOM (via `setRangeText` for surgical insertion) and rebases the cursor so it stays in the same *logical* position.

Internally uses `transformIndex` from `@kyneta/schema` twice — once for `start`, once for `end`. `transformSelection` is just the two-index convenience.

### What `transformSelection` is NOT

- **Not a cursor sticky-side policy.** The caller passes indices; the side bias (left/right at an insert boundary) is determined by `transformIndex`'s own default.
- **Not rate-limited.** Remote edits fire `transformSelection` synchronously within `attach`'s changefeed subscriber. For high-frequency remote mutation, throttling happens at the exchange / changefeed layer, not here.

---

## `attach` — the imperative shell of `useText`

Source: `packages/react/src/text-adapter.ts` → `attach`.

```ts
attach(
  element: HTMLInputElement | HTMLTextAreaElement,
  textRef: TextRefLike,
  options?: AttachOptions,
): () => void   // detach
```

Three responsibilities:

1. **Local edits → CRDT.** Register an `input` event listener. On each event, call `diffText(oldText, newText, selectionStart)`, read its one edit with `singleEdit`, and write it with `batch(textRef, fn, { source: ownSource })` (inside `undo.typing` when there is an undo target), where `ownSource` is a per-`attach()` `Symbol("text-adapter:echo")` minted in the closure.
2. **Remote edits → DOM.** Subscribe to `textRef[CHANGEFEED]`. Skip changesets whose `cs.source === ownSource` (echoes of our own writes). For all other changesets, apply each `TextChange` surgically via `element.setRangeText(...)` and rebase the selection via `transformSelection`, or, for an undo this binding asked for, put the caret at the edit.
3. **Edge cases.** Handle IME composition (`compositionstart` / `compositionend`), and route undo and redo keys and input events per `undo`.

### Echo suppression — identity-typed `source` token

Each `attach()` call mints a private `Symbol` and uses it for both the writer side (passed to `batch()` as `options.source`) and the reader side (compared against `cs.source` to skip echoes). The token is private to the closure — composed adapters or multiple textareas on the same ref mint independent tokens, so their writes don't echo-suppress each other.

This replaces the pre-jj:wpvtoxmw convention `origin === "local"`, which required writer and reader to share an exact string and stole `origin` namespace from app code. The identity-typed mechanism cannot collide with app vocabulary, type-checks at the call site, and composes naturally across nested subscribers.

`AttachOptions` is `UseTextOptions` — same shape, direct import from `text-adapter.ts` as the canonical definition.

### The IME composition edge case

IME composition (Chinese pinyin, Japanese kana-to-kanji, etc.) fires `input` events for intermediate states. The adapter tracks composition via `compositionstart` / `compositionend` and defers applying the diff to the CRDT until `compositionend` fires. Intermediate `input` events update the DOM only (native behaviour); the final committed text is what flows into the CRDT.

Without this handling, every keystroke during composition would emit a separate `TextChange`, producing N intermediate states on remote peers and breaking the "one-edit-per-user-action" invariant.

### What `attach` is NOT

- **Not a React hook.** Zero React imports. `useText` calls `attach` inside `useRef` / `useCallback`, but `attach` itself runs identically under any DOM environment.
- **Not a debouncer.** Every user keystroke produces a CRDT write (modulo IME composition). Downstream batching happens at the exchange / storage layer.
- **Not concerned with element focus.** The adapter neither captures nor releases focus. Applications handle focus independently.

---

## Re-exports

The barrel (`src/index.ts`) re-exports a curated subset of `@kyneta/schema`, `@kyneta/changefeed`, and `@kyneta/exchange` so most application code imports only from `@kyneta/react`:

| From | Re-exported |
|------|-------------|
| `@kyneta/changefeed` | `CHANGEFEED`, `Changeset` (type) |
| `@kyneta/schema` | `Schema`, `batch`, `applyChanges`, `diffText`, `subscribe`, `subscribeNode`, `BoundSchema`, `Op`, `Plain`, `Ref`, `RRef`, `CommitOptions` (types) |
| `@kyneta/exchange` | `AsyncQueue`, `createLineDocSchema`, `Connectivity`, `DocChange`, `DocId`, `DocInfo`, `ExchangeParams`, `GatePredicate`, `LineListener`, `LineProtocol`, `PeerIdentityDetails`, `Policy`, `PeerSyncState`, `SyncRef`, `TransportFactory` (types and values as applicable) |

This is a convenience, not a hard coupling — direct imports from the upstream packages work identically.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `ExternalStore<T>` | `src/store.ts` | `{ subscribe, getSnapshot }` — the `useSyncExternalStore` contract. |
| `useTracked` | `src/use-tracked.ts` | `(thunk) → T` — auto-tracked reactive read over `@kyneta/reactive`. |
| `useSelector` | `src/use-selector.ts` | `(ref, select) → T` — `useTracked` over `() => select(ref)`, memoized on its arguments. |
| `useChangefeed` | `src/use-changefeed.ts` | `(feed) → T` — `useSyncExternalStore` over `feed.current`. |
| `createSyncStore` | `src/store.ts` | Pure factory: `SyncRef` → `ExternalStore<PeerSyncState[]>`. |
| `TextRefLike` | `src/text-adapter.ts` | Structural shape of a text ref for the adapter — `(() => string) & TextRef & HasChangefeed`. Matches the *loose* `[CHANGEFEED]` surface every interpreted ref carries, so any `Ref<TextSchema>` satisfies it without a cast. |
| `AttachOptions` | `src/text-adapter.ts` | `{ undo?: UndoTarget \| "prevent" \| "browser"; refusal? }`. |
| `UndoTarget` | `src/text-adapter.ts` | Where undo goes: `typing`, `undo`, `redo`. |
| `attach` | `src/text-adapter.ts` | Imperative bind: element + textRef → detach. |
| `transformSelection` | `src/text-adapter.ts` | Pure: `(start, end, instructions) → { start, end }`. |
| `ExchangeProvider` | `src/exchange-context.tsx` | React context provider. |
| `useExchange` | `src/exchange-context.tsx` | Context consumer; throws if absent. |
| `ExchangeProviderProps` | `src/exchange-context.tsx` | `{ exchange, children }`. |
| `useDocument` | `src/use-document.ts` | `(bound, docId) → Ref<S>`. |
| `useValue` | `src/use-value.ts` | `(ref) → Plain<S>` — `useSelector(ref, readValue)`; handles null/undefined. |
| `useSyncState` | `src/use-sync-state.ts` | `(doc) → PeerSyncState[]`. |
| `useDocReady` | `src/use-doc-ready.ts` | `(doc, opts?) → boolean` monotonic latch. |
| `useText` | `src/use-text.ts` | `(textRef, options?) → React.RefCallback`. |
| `useWriteRefusal` | `src/use-write-refusal.ts` | `(doc) → WriterRefusedError \| undefined`. |
| `UseTextOptions` | `src/use-text.ts` | `{ undo?: UndoTarget \| "prevent" \| "browser" }`. |

## File Map

| File | Role |
|------|------|
| `src/index.ts` | Public barrel + curated re-exports from upstream packages. |
| `src/store.ts` | `createSyncStore`, `ExternalStore`. Zero React imports. |
| `src/use-tracked.ts` | `useTracked` — `useSyncExternalStore` over a `@kyneta/reactive` computation, through the refresh gate. |
| `src/use-selector.ts` | `useSelector` — `useTracked` over a thunk memoized on `(ref, select)`. |
| `src/use-changefeed.ts` | `useChangefeed` — `useSyncExternalStore` over a feed's `current`, subscribed as widely as `current` reads. |
| `src/text-adapter.ts` | Pure text-adapter: `attach`, `transformSelection`, `TextRefLike`, `AttachOptions`. Zero React imports. |
| `src/exchange-context.tsx` | `ExchangeProvider`, `useExchange`, `ExchangeProviderProps`. |
| `src/use-value.ts` | `useValue` — `useSelector(ref, readValue)`; nullish passthrough. |
| `src/use-document.ts` | `useDocument` — memoized `exchange.get(docId, bound)`. |
| `src/use-sync-state.ts` | `useSyncState` — `useSyncExternalStore` wrapper over `createSyncStore`. |
| `src/use-doc-ready.ts` | `useDocReady` — sugar over `useDocStatus` (`status !== "pending"`). |
| `src/use-write-refusal.ts` | `useWriteRefusal` — the document's `writeRefusalFeed`, through `useChangefeed`. |
| `src/use-text.ts` | `useText` — ref callback wrapping `attach`. |
| `src/__tests__/store.test.ts` | `createSyncStore`. No React. |
| `src/__tests__/identity.test.tsx` | The identity rule: `useValue` across unrelated renders, `React.memo` over a shared subtree, `useTracked` with a `useCallback` thunk, `useChangefeed` over a composite and over `exchange.peers`. |
| `src/__tests__/use-selector.test.tsx` | `useSelector` — the todos parsimony scenario (text edit → no re-render; done flip → re-render) + no-deps + dispose. |
| `src/__tests__/text-adapter.test.ts` | `transformSelection`, `attach` — edit detection, selection rebasing, IME composition, undo to a target and its caret, undo interception. (`diffText`'s cases live with it in `@kyneta/schema`.) |
| `src/__tests__/collaborative-text.test.ts` | End-to-end: two textareas bound to concurrently-syncing text refs, verifying cursor stability during remote edits. |
| `src/__tests__/use-value.test.tsx` | `useValue` hook — React Testing Library against real refs. |
| `src/__tests__/use-document.test.tsx` | `useDocument` hook — memoization and ref stability. |
| `src/__tests__/use-text.test.tsx` | `useText` hook — ref-callback lifecycle, element bind/unbind. |
| `src/__tests__/exchange-context.test.tsx` | `ExchangeProvider` + `useExchange` — context publication, missing-provider error. |

## Testing

Pure-core tests (`store.test.ts`, `text-adapter.test.ts`, `collaborative-text.test.ts`) use `createDoc` + `batch()` directly — no React, no jsdom. Hook tests (`*.test.tsx`) use React Testing Library + jsdom against real refs, counting renders to pin when a hook re-renders and comparing identities to pin when its value is new.

The `collaborative-text.test.ts` file is the realistic end-to-end: two `Bridge`-connected exchanges, two textareas, concurrent typing, selection-stability assertions across remote edits.

Run with `cd packages/react && pnpm exec vitest run`.