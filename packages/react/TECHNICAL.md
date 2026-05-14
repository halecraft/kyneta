# @kyneta/react — Technical Reference

> **Package**: `@kyneta/react`
> **Role**: Thin React bindings over `@kyneta/schema` + `@kyneta/exchange`. Bridges the `[CHANGEFEED]` reactive protocol to React's rendering cycle via `useSyncExternalStore`, and provides a framework-agnostic text-adapter for binding native `<input>` / `<textarea>` elements to collaborative `TextRef`s.
> **Depends on**: `@kyneta/schema` (peer), `@kyneta/changefeed` (peer), `@kyneta/exchange` (peer), `react` (>=18, peer)
> **Depended on by**: Application code that renders Kyneta documents in React.
> **Canonical symbols**: `ExchangeProvider`, `useExchange`, `useDocument`, `useValue`, `useSyncStatus`, `useText`, `ExchangeProviderProps`, `UseTextOptions`, `CallableRef`, `ExternalStore`, `createChangefeedStore`, `createSyncStore`, `createNullishStore`, `attach`, `diffText`, `transformSelection`, `TextRefLike`, `AttachOptions`
> **Key invariant(s)**:
> 1. The package is an **adapter**, not a renderer. Every hook is a ≤10-line `useSyncExternalStore` wrapper over a pure, React-agnostic store factory. Zero React imports in `store.ts` or `text-adapter.ts`.
> 2. `useValue` returns the same object reference between renders when the underlying value has not changed — downstream `React.memo` and `useMemo` remain stable.
> 3. `useText` never causes re-renders on text changes. Collaborative text binds imperatively through `text-adapter.ts`; the textarea is an *uncontrolled* element.

A minimal React binding kit. Applications wrap their tree in `ExchangeProvider`, consume documents via `useDocument(bound)`, read values with `useValue(ref)`, observe sync status with `useSyncStatus(doc)`, and bind collaborative text fields with `useText(textRef)`. That's the full surface. Heavy lifting — the `[CHANGEFEED]` subscription, the snapshot caching, the text diffing + selection rebasing — lives in framework-agnostic pure modules.

Consumed by application code. Not imported by any other Kyneta package.

---

## Questions this document answers

- How does `useValue` interact with `useSyncExternalStore`? → [The FC/IS split](#the-fcis-split)
- Why does `useValue` return a stable reference between renders? → [Snapshot caching for referential stability](#snapshot-caching-for-referential-stability)
- Why is `useText` imperative — why doesn't it re-render on text changes? → [`useText` — uncontrolled by design](#usetext--uncontrolled-by-design)
- How does the text-adapter detect what the user typed? → [`diffText` — single contiguous edit detection](#difftext--single-contiguous-edit-detection)
- How does the text-adapter keep the cursor in the right place during remote edits? → [`transformSelection` — cursor rebasing](#transformselection--cursor-rebasing)
- What's the difference between deep and shallow subscription? → [Deep vs shallow subscription](#deep-vs-shallow-subscription)
- How do I pass an `Exchange` to components without prop-drilling? → [`ExchangeProvider` and `useExchange`](#exchangeprovider-and-useexchange)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `ExternalStore<T>` | `{ subscribe(onStoreChange): unsubscribe, getSnapshot(): T }` — the contract `useSyncExternalStore` consumes. | A state container, a Zustand store — this is the React built-in contract |
| `CallableRef` | Structural type: a callable `(...args) => any` that also carries `[CHANGEFEED]`. Every `Ref<S>` from the standard interpreter stack satisfies it. | A React `ref`, a DOM ref |
| `createChangefeedStore(ref)` | Pure factory: `ref → ExternalStore<Plain<S>>`. Subscribes to `[CHANGEFEED]`, caches snapshots, dispatches deep or shallow based on ref kind. | `createSyncStore` |
| `createSyncStore(syncRef)` | Pure factory: `SyncRef → ExternalStore<ReadonlyMap<PeerId, ReadyState>>`. Subscribes to `onReadyStateChange`. | `createChangefeedStore` |
| `createNullishStore(value)` | Pure factory returning a store whose snapshot is `null` / `undefined` and whose `subscribe` is a no-op. Used for conditional hook calls. | A placeholder — this is a real `ExternalStore` with stable identity |
| `ExchangeProvider` | React context provider that publishes an `Exchange` to descendants. | A DI container |
| `useExchange()` | Reads the `Exchange` from context. Throws if no provider is in the tree. | `useContext` on some generic `ExchangeContext` — this is the curated hook |
| `useDocument(bound)` | Returns `Ref<S>` for `exchange.get(docId, bound)`. Stable across renders; memoizes by `(exchange, docId, bound)`. | `useValue` — `useDocument` returns the *ref*, not the plain value |
| `useValue(ref)` | Returns `Plain<S>`. Re-renders when the ref's changefeed fires. Memoized for referential stability. | `useDocument` |
| `useSyncStatus(doc)` | Returns `ReadonlyMap<PeerId, ReadyState>` describing per-peer sync progress. Re-renders on ready-state changes. | `useValue(doc)` — `useSyncStatus` looks at the sync surface, not the doc's data |
| `useText(textRef, options?)` | React ref callback that binds a native `<input>` / `<textarea>` to a `TextRef`. Does not re-render on text changes. | `useValue(textRef)` — use that if you want to *read* the text reactively (e.g., for a character count) |
| `attach(element, textRef, options?)` | Imperative, framework-agnostic: bind an element to a text ref, return a detach function. The foundation of `useText`. | A React hook — `attach` has no React dependency |
| `diffText(oldText, newText, cursorHint)` | Pure function: produce the `TextChange` describing a single contiguous edit from `oldText` to `newText`, disambiguated by cursor position. | A general-purpose string diff — `diffText` assumes a single contiguous edit |
| `transformSelection(start, end, instructions)` | Pure function: rebase a selection range through text instructions. | `transformIndex` from `@kyneta/schema` — this is the two-index convenience |
| Deep subscription | Via `subscribeTree` — composite refs' descendants' changes trigger re-render. | Shallow subscription |
| Shallow subscription | Via `subscribe` — only the node's own changes trigger re-render (no descendants). | Deep subscription |

---

## Architecture

**Thesis**: React is not a state library. Reactive state is already solved by `[CHANGEFEED]`. The binding is one line each: `useSyncExternalStore(store.subscribe, store.getSnapshot)`, where `store` is a pure factory that knows how to translate `[CHANGEFEED]` into the `{ subscribe, getSnapshot }` contract.

Two layers:

| Layer | Module | React? |
|-------|--------|--------|
| **Functional Core** | `store.ts`, `text-adapter.ts` | No imports |
| **Imperative Shell** | `exchange-context.tsx`, `use-value.ts`, `use-document.ts`, `use-sync-status.ts`, `use-text.ts` | Thin React wrappers |

```
Application code
     │
     ├─ ExchangeProvider, useExchange ──── React context
     ├─ useDocument(bound)             ─── exchange.get
     ├─ useValue(ref)                  ─── useSyncExternalStore ──► createChangefeedStore(ref)
     ├─ useSyncStatus(doc)             ─── useSyncExternalStore ──► createSyncStore(syncRef)
     └─ useText(textRef)               ─── ref callback         ──► attach(el, textRef)
                                                                     │
                                                                     └─ diffText, transformSelection (pure)
```

Every hook file is ≤100 lines — most are 40–80 — because the work lives in the two pure modules.

### What this package is NOT

- **Not a state container.** There is no local mutable state managed by the package. All state is in the underlying `Exchange` / refs; hooks subscribe to it.
- **Not a component library.** Zero exported components (beyond `ExchangeProvider`, which is a zero-DOM context provider). Applications write their own presentation.
- **Not a router.** No data-fetching orchestration, no suspense integration, no route-aware prefetching.
- **Not tied to a specific React version.** `peerDependencies: { react: ">=18" }`. `useSyncExternalStore` is required (React 18+).
- **Not a controlled-component library for text.** `useText` deliberately avoids the controlled pattern — see [`useText` — uncontrolled by design](#usetext--uncontrolled-by-design).

---

## The FC/IS split

Source: `packages/react/src/store.ts` (Functional Core) + `packages/react/src/use-value.ts`, `use-sync-status.ts` (Imperative Shell).

### Functional Core — `store.ts`

Two framework-agnostic pure factories:

```ts
createChangefeedStore(ref: CallableRef): ExternalStore<unknown>
createSyncStore(syncRef: SyncRef):       ExternalStore<ReadonlyMap<PeerId, ReadyState>>
```

Plus a utility:

```ts
createNullishStore<T extends null | undefined>(value: T): ExternalStore<T>
```

`createChangefeedStore(ref)`:

1. Reads `ref[CHANGEFEED]` to determine whether the ref is composite (has `subscribeTree`) or leaf (plain `subscribe`).
2. Caches the current snapshot in a closure variable.
3. Returns `{ subscribe, getSnapshot }`:
   - `subscribe(onChange)` registers a `[CHANGEFEED]` subscriber. When it fires, `snapshot = ref()` (re-compute), then `onChange()`.
   - `getSnapshot()` returns the cached `snapshot`.

The cache is the key detail — without it, `getSnapshot` would return `ref()` fresh each call, producing different object references across tearing-check reads and forcing React to bail out.

`createSyncStore(syncRef)` has the same shape over `SyncRef.onReadyStateChange`.

`createNullishStore(value)` is a degenerate `ExternalStore` with a no-op `subscribe` and a fixed snapshot. Used by `useValue` to handle `null` / `undefined` inputs without calling a hook conditionally (React rule).

### Imperative Shell — the hook files

`use-value.ts` is eight lines of React:

```ts
export function useValue<R extends CallableRef | null | undefined>(ref: R): UseValueResult<R> {
  const store = useMemo(
    () => (ref == null ? createNullishStore(ref as null | undefined) : createChangefeedStore(ref)),
    [ref],
  )
  return useSyncExternalStore(store.subscribe, store.getSnapshot) as UseValueResult<R>
}
```

That's the entire pattern. `use-sync-status.ts` is the same shape.

### Testing the core without React

`store.test.ts` (291 lines) tests `createChangefeedStore` and `createSyncStore` with synthetic refs constructed from `createDoc + change()`. No `render`, no `act`, no jsdom. The React hook test files are thin — they verify that the hook passes the right store factory to `useSyncExternalStore`, not the subscription logic itself.

### What this split is NOT

- **Not a middleware pattern.** There's no interceptor chain. The hook calls the pure factory directly.
- **Not an abstraction that could swap React for another framework.** The factories are React-agnostic, but the *hooks* are React-specific — for Vue or Solid, other bindings would import `store.ts` directly.

---

## Snapshot caching for referential stability

Source: `packages/react/src/store.ts` → `createChangefeedStore` cache logic.

`useSyncExternalStore` calls `getSnapshot()` on every render to detect tearing. If `getSnapshot()` returns a different object each time (for example, `ref()` computing a fresh plain value on each call), React thinks the state is changing constantly and produces warnings or spurious re-renders.

`createChangefeedStore` solves this by caching the snapshot:

```
// Pseudocode
let snapshot = ref()
subscribe = (onChange) => {
  return ref[CHANGEFEED].subscribe(() => {
    snapshot = ref()       // recompute on real change
    onChange()
  })
}
getSnapshot = () => snapshot
```

Between `[CHANGEFEED]` firings, `getSnapshot()` returns the same object. `React.memo(child, (prev, next) => prev === next)` works correctly. A `useMemo(() => compute(value), [value])` remains stable.

This relies on an implicit contract: **`ref()` must return a new reference when the underlying value has changed.** Schema product refs satisfy this by allocating a fresh `{}` on each call; sequence refs allocate a fresh `[]`; scalars return primitives (compared by value). `ReactiveMap` satisfies this by returning `new Map(map)` — a shallow copy — on each call, while `.current` remains the live map for imperative use.

### Eager snapshot on mount

The initial snapshot is computed synchronously during `createChangefeedStore` construction. There is no `null` / loading state — the ref always has a current value (that's the `[CHANGEFEED]` contract). Applications that need a loading indicator use `useSyncStatus` for sync progress, not `useValue` state.

### What snapshot caching is NOT

- **Not deep equality.** Two different object references with the same contents are *not* considered equal. The cache returns the exact instance from the most recent recomputation.
- **Not a memoization of `ref()`.** Each recomputation is a full `ref()` call. The cache holds the *result*, not the computation.

---

## Deep vs shallow subscription

Source: `packages/react/src/store.ts` → `hasTreeChangefeed(ref)` check.

`createChangefeedStore` inspects the ref's `[CHANGEFEED]` to decide how to subscribe:

| Ref kind | Subscription | Fires on |
|----------|--------------|----------|
| Schema-issued ref (every leaf and composite post-1.6.0) | `subscribeTree(cb)` | Own-path + any descendant change |
| Primitive universal-protocol source (e.g. `createReactiveMap`) | `subscribe(cb)` | Own-path changes only |

Every schema-issued ref carries `TreeChangefeedProtocol` with `subscribeTree` — for leaves, `subscribeTree` is the trivial own-path lift (a leaf is a tree of size 1). Primitive sources from `@kyneta/changefeed` (like `createReactiveMap`) carry only the universal `ChangefeedProtocol` and have no `subscribeTree`. `hasTreeChangefeed` from `@kyneta/schema` is the runtime discriminator; it also doubles as a static type narrower, so the dispatch branch is cast-free.

Deep-by-default is the right behaviour for application code — a React component rendering a todo item wants to re-render when the todo's `text`, `done`, or any nested field changes. Opting into shallow subscription is rare; applications that need it can use `subscribeNode` directly and wire `useSyncExternalStore` themselves.

### What deep subscription is NOT

- **Not a performance problem.** The composed changefeed fires one `Changeset<Op>` per transaction (not one per descendant). Subscribers see one coherent batch per commit.
- **Not recursive.** `subscribeTree` does not register subscriptions on every descendant. It listens at the composite's own node and receives expanded descendant changes via the composed protocol.

---

## `ExchangeProvider` and `useExchange`

Source: `packages/react/src/exchange-context.tsx`.

Standard React context for the `Exchange`:

```tsx
<ExchangeProvider exchange={myExchange}>
  <App />
</ExchangeProvider>

function SomeComponent() {
  const exchange = useExchange()
  // ...
}
```

`useExchange()` throws if called outside a provider — this is a programmer error that deserves to surface loudly rather than return `undefined` and fail later.

### What `ExchangeProvider` is NOT

- **Not a DI container.** It provides *one* value (the `Exchange`). No factory, no scope, no configuration.
- **Not a render wrapper.** It adds no DOM. Its return type is `children`.
- **Not responsible for lifecycle.** The application creates the `Exchange` and holds it; the provider merely publishes it to descendants.

---

## `useDocument`

Source: `packages/react/src/use-document.ts`.

```ts
useDocument<S>(bound: BoundSchema<S>, docId: DocId): Ref<S>
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
useValue<R extends CallableRef | null | undefined>(ref: R): UseValueResult<R>
```

`UseValueResult<R>` unifies three cases via conditional types:

- `R extends CallableRef` → `ReturnType<R>` (the `Plain<S>`).
- `R extends null` → `null`.
- `R extends undefined` → `undefined`.

The single function signature + conditional return covers the three cases without overload explosion. Hook call count is stable (React's rule) — when `ref` is nullish, the hook still runs; it just subscribes to a `createNullishStore` instance that never fires.

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

- **Not a selector.** There is no selector parameter. To read a subset, read the ref (`useValue(ref.field)`) rather than selecting after.
- **Not a debounced subscription.** Every changefeed emission triggers a re-render attempt. React's own batching handles coalescing.
- **Not a suspense boundary.** The hook returns synchronously.

---

## `useSyncStatus`

Source: `packages/react/src/use-sync-status.ts`.

```ts
useSyncStatus(doc: Ref<S>): ReadonlyMap<PeerId, ReadyState>
```

Given a document ref, returns a live map of per-peer sync readiness. Re-renders when any peer's ready state flips (via the exchange's `onReadyStateChange` feed).

Applications use this for UI like "syncing with 3 peers" or "all synced" indicators.

### What `useSyncStatus` is NOT

- **Not a connectivity indicator.** It reflects sync readiness per peer per doc, not transport connectivity. Peers may be connected but not yet caught up; others may be synced but currently disconnected (the map still shows their last-known state).
- **Not reactive to peer joining / leaving the connection graph.** That's `exchange.peers`. `useSyncStatus` tracks readiness transitions on docs that already have peer entries.

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

The hook calls `attach(element, textRef, options)` when the element mounts and the returned detach function when it unmounts. Between those two events, `useText` **does not cause re-renders on text changes**. The textarea is an *uncontrolled* element — its value lives in the DOM, and the adapter keeps the DOM and the `TextRef` in sync imperatively.

### Why uncontrolled

The controlled pattern for text fields in React re-renders the component on every keystroke, sets `value={...}` on the element, and fights natively with IME composition, autocorrect, selection state, and browser undo. Every one of those concerns must be re-solved per application.

The uncontrolled pattern — register a `ref` callback, bind natively — avoids all of it. The adapter handles IME composition events, rebases selection through remote edits, and intercepts `Cmd+Z` / `Ctrl+Z` so the CRDT owns undo semantics. No React re-renders are involved; the DOM is authoritative for display, the CRDT is authoritative for state, and the adapter reconciles them.

If the application needs to read the text reactively (for a character counter, for example), use `useValue(textRef)` in a *separate* component that re-renders only on text changes. The counter component can re-render freely without touching the editor.

### `UseTextOptions`

```ts
interface UseTextOptions {
  undo?: "prevent" | "browser"   // default: "prevent"
}
```

- `"prevent"` — intercept `Cmd+Z` / `Ctrl+Z`. The CRDT owns undo (or the application does via `@kyneta/schema`'s undo machinery, future).
- `"browser"` — let native undo fire. Appropriate for single-user scenarios where the browser's undo stack is adequate.

### What `useText` is NOT

- **Not controlled.** Do not pass `value={...}` alongside `useText`. The adapter manages the element's value directly.
- **Not re-rendering on text changes.** The hook is write-only during text edits. Reads happen through `useValue(textRef)` or the DOM directly.
- **Not tied to a specific text component.** `<input type="text">` and `<textarea>` both work. Any element matching the structural shape (having `value`, `selectionStart`, `selectionEnd`, `setRangeText`) could be bound.

---

## `diffText` — single contiguous edit detection

Source: `packages/react/src/text-adapter.ts` → `diffText`.

```ts
diffText(oldText: string, newText: string, cursorHint: number): TextChange
```

Given the text before and after an `input` event, produce a `TextChange` describing the one contiguous edit. The `cursorHint` is `element.selectionStart` after the event, used to disambiguate edits within runs of identical characters.

Algorithm:

1. Scan from the left for a common prefix, bounded by `cursorHint`.
2. Scan from the right for a common suffix, not overlapping the prefix.
3. The region between prefix and suffix is the edit — produce `TextInstruction[]` with `retain(prefix.length)`, optional `delete(deletedLength)`, optional `insert(inserted)`, `retain(suffix.length)`.

The cursor disambiguation matters because a naive diff of `"aaa"` → `"aaaa"` has four valid answers (insert `a` before each of the four positions). The cursor tells the adapter exactly which position was edited, which matters for CRDT convergence: two concurrent peers inserting into different positions of an `"aaa"` should produce different results post-merge, and the operational-transform / CRDT algebra relies on the actual index.

### What `diffText` is NOT

- **Not a general-purpose string diff.** It assumes a single contiguous edit. `paste-replace` and `multi-cursor-edit` scenarios are out of scope — the `input` event surface covers them one edit at a time (the browser fires multiple events for multi-cursor) or falls back to `update(newText)` via dedicated code paths for complete replacement.
- **Not symmetric.** It describes how to get from `oldText` to `newText`. Reversing the arguments produces the inverse edit.
- **Not minimal in the Myers / LCS sense.** It produces *a* single contiguous edit; whether it's the minimal one doesn't matter because the CRDT converges regardless of the specific representation.

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

1. **Local edits → CRDT.** Register an `input` event listener. On each event, call `diffText(oldText, newText, selectionStart)` → feed the `TextChange` into `change(() => textRef.insert/delete/update(...))`.
2. **Remote edits → DOM.** Subscribe to `textRef[CHANGEFEED]`. On each `TextChange` with `origin !== "local"`, apply it surgically via `element.setRangeText(...)` and rebase the selection via `transformSelection`.
3. **Edge cases.** Handle IME composition (`compositionstart` / `compositionend`), intercept `keydown` for undo when `undo: "prevent"`.

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
| `@kyneta/schema` | `Schema`, `change`, `applyChanges`, `subscribe`, `subscribeNode`, `BoundSchema`, `Op`, `Plain`, `Ref`, `RRef`, `CommitOptions` (types) |
| `@kyneta/exchange` | `AsyncQueue`, `createLineDocSchema`, `DocChange`, `DocId`, `DocInfo`, `ExchangeParams`, `GatePredicate`, `LineListener`, `LineProtocol`, `Policy`, `ReadyState`, `SyncRef`, `TransportFactory` (types and values as applicable) |

This is a convenience, not a hard coupling — direct imports from the upstream packages work identically.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `ExternalStore<T>` | `src/store.ts` | `{ subscribe, getSnapshot }` — the `useSyncExternalStore` contract. |
| `CallableRef` | `src/store.ts` | Callable + `[CHANGEFEED]` structural type. |
| `createChangefeedStore` | `src/store.ts` | Pure factory: ref → `ExternalStore<Plain<S>>`. |
| `createSyncStore` | `src/store.ts` | Pure factory: `SyncRef` → `ExternalStore<ReadonlyMap<PeerId, ReadyState>>`. |
| `createNullishStore` | `src/store.ts` | No-op store for `null` / `undefined`. |
| `TextRefLike` | `src/text-adapter.ts` | Structural shape of a text ref for the adapter. |
| `AttachOptions` | `src/text-adapter.ts` | `{ undo?: "prevent" \| "browser" }`. |
| `attach` | `src/text-adapter.ts` | Imperative bind: element + textRef → detach. |
| `diffText` | `src/text-adapter.ts` | Pure: `(oldText, newText, cursorHint) → TextChange`. |
| `transformSelection` | `src/text-adapter.ts` | Pure: `(start, end, instructions) → { start, end }`. |
| `ExchangeProvider` | `src/exchange-context.tsx` | React context provider. |
| `useExchange` | `src/exchange-context.tsx` | Context consumer; throws if absent. |
| `ExchangeProviderProps` | `src/exchange-context.tsx` | `{ exchange, children }`. |
| `useDocument` | `src/use-document.ts` | `(bound, docId) → Ref<S>`. |
| `useValue` | `src/use-value.ts` | `(ref) → Plain<S>`; handles null/undefined. |
| `useSyncStatus` | `src/use-sync-status.ts` | `(doc) → ReadonlyMap<PeerId, ReadyState>`. |
| `useText` | `src/use-text.ts` | `(textRef, options?) → React.RefCallback`. |
| `UseTextOptions` | `src/use-text.ts` | `{ undo?: "prevent" \| "browser" }`. |

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 90 | Public barrel + curated re-exports from upstream packages. |
| `src/store.ts` | 149 | Pure store factories: `createChangefeedStore`, `createSyncStore`, `createNullishStore`, `CallableRef`, `ExternalStore`. Zero React imports. |
| `src/text-adapter.ts` | 355 | Pure text-adapter: `attach`, `diffText`, `transformSelection`, `TextRefLike`, `AttachOptions`. Zero React imports. |
| `src/exchange-context.tsx` | 96 | `ExchangeProvider`, `useExchange`, `ExchangeProviderProps`. |
| `src/use-value.ts` | 70 | `useValue` — `useSyncExternalStore` wrapper over `createChangefeedStore` / `createNullishStore`. |
| `src/use-document.ts` | 67 | `useDocument` — memoized `exchange.get(docId, bound)`. |
| `src/use-sync-status.ts` | 40 | `useSyncStatus` — `useSyncExternalStore` wrapper over `createSyncStore`. |
| `src/use-text.ts` | 82 | `useText` — ref callback wrapping `attach`. |
| `src/__tests__/store.test.ts` | 291 | `createChangefeedStore` + `createSyncStore` — snapshot caching, deep vs shallow, subscription lifecycle. No React. |
| `src/__tests__/text-adapter.test.ts` | 543 | `diffText`, `transformSelection`, `attach` — edit detection, selection rebasing, IME composition, undo interception. |
| `src/__tests__/collaborative-text.test.ts` | 354 | End-to-end: two textareas bound to concurrently-syncing text refs, verifying cursor stability during remote edits. |
| `src/__tests__/use-value.test.tsx` | 113 | `useValue` hook — React Testing Library against real refs. |
| `src/__tests__/use-document.test.tsx` | 71 | `useDocument` hook — memoization and ref stability. |
| `src/__tests__/use-text.test.tsx` | 220 | `useText` hook — ref-callback lifecycle, element bind/unbind. |
| `src/__tests__/exchange-context.test.tsx` | 62 | `ExchangeProvider` + `useExchange` — context publication, missing-provider error. |

## Testing

Pure-core tests (`store.test.ts`, `text-adapter.test.ts`, `collaborative-text.test.ts`) use `createDoc` + `change()` directly — no React, no jsdom. They exercise the subscription, snapshot, diff, and selection logic independently of React's render cycle. Hook tests (`*.test.tsx`) use React Testing Library + jsdom and verify the thin shell: that the hook passes the right arguments to `useSyncExternalStore`, that ref callbacks fire on mount/unmount.

The `collaborative-text.test.ts` file is the realistic end-to-end: two `Bridge`-connected exchanges, two textareas, concurrent typing, selection-stability assertions across remote edits.

**Tests**: 84 passed, 0 skipped across 7 files (`use-value`: 8, `use-text`: 8, `use-document`: 3, `collaborative-text`: 8, `store`: ~25, `text-adapter`: ~26, `exchange-context`: ~6 — approximate per-file breakdown). Run with `cd packages/react && pnpm exec vitest run`.