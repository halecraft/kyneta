# @kyneta/changefeed — Technical Reference

> **Package**: `@kyneta/changefeed`
> **Role**: The universal reactive contract — a single symbol (`CHANGEFEED`) that any value can carry to expose its current state and a stream of future changes.
> **Depends on**: *(none — zero runtime dependencies)*
> **Depended on by**: `@kyneta/schema`, `@kyneta/index`, `@kyneta/exchange`, `@kyneta/react`, `@kyneta/loro-schema`, `@kyneta/yjs-schema`, `@kyneta/compiler`, `@kyneta/cast`
> **Canonical symbols**: `CHANGEFEED`, `Changefeed<S, C>`, `ChangefeedProtocol<S, C>`, `Changeset<C>`, `HasChangefeed<S, C>`, `CallableChangefeed<S, C>`, `ReactiveMap<K, V, C>`, `ReactiveMapHandle<K, V, C>`, `ChangeBase`, `createChangefeed`, `createCallable`, `createReactiveMap`, `changefeed`, `hasChangefeed`, `staticChangefeed`
> **Key invariant(s)**: Every reactive value in Kyneta exposes itself through exactly one symbol — `CHANGEFEED`. Accessing `value[CHANGEFEED]` yields `{ current, subscribe }`. Anything else is not a changefeed.

A shared vocabulary that lets any object — a schema ref, a document, a live map, a function-object — say "here is my current value and here is how you watch it change." Every reactive surface in Kyneta goes through this one symbol.

Imported by schema, exchange, index, react, compiler, cast, and both CRDT substrates. Nothing imports into it — this is the tier-0 foundation.

---

## Questions this document answers

- What is the `CHANGEFEED` symbol and why a symbol instead of an interface? → [Why a symbol](#why-a-symbol)
- What's the difference between `Changefeed` and `ChangefeedProtocol`? → [Two-layer design](#two-layer-design)
- How do I make my own value reactive? → [Creating a changefeed](#creating-a-changefeed)
- What is a `Changeset` and why are changes batched? → [Changesets and batching](#changesets-and-batching)
- How does `ReactiveMap` differ from a plain `Map` with subscribers? → [ReactiveMap — callable changefeed over a mutable Map](#reactivemap--callable-changefeed-over-a-mutable-map)
- Why does `ReactiveMapHandle.set` not emit automatically? → [Mutation does not imply notification](#mutation-does-not-imply-notification)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `CHANGEFEED` | The unique `Symbol.for("kyneta:changefeed")` that marks a value as a changefeed. | Any instance of `Changefeed` — the symbol is the protocol key, not a value itself |
| `ChangefeedProtocol<S, C>` | `{ current: S, subscribe(cb) → unsubscribe }` — the minimal coalgebra sitting behind the symbol. | `Changefeed<S, C>`, which also exposes `.current`/`.subscribe` at the top level |
| `Changefeed<S, C>` | The developer-facing type: `[CHANGEFEED]` + direct `.current` + `.subscribe` in one object. | `ChangefeedProtocol<S, C>` (the protocol alone, without developer conveniences) |
| `HasChangefeed<S, C>` | Any object that carries `[CHANGEFEED]`. Weaker than `Changefeed` — does not require the convenience accessors. | A type guard — use `hasChangefeed(value)` for that |
| `Changeset<C>` | `{ changes: readonly C[], origin?: string }` — the unit of delivery through `subscribe`. | A single change — a changeset *contains* changes |
| `ChangeBase` | `{ type: string }` — the open base protocol that every change type extends. | A specific change type like `TextChange` (those live in `@kyneta/schema`) |
| `origin` | Batch-level provenance metadata (e.g. `"local"`, `"sync"`, `"undo"`). Lives on the `Changeset`, not on individual changes. | A change's `type` field |
| `CallableChangefeed<S, C>` | A `Changefeed<S, C>` that is also callable — `feed()` returns `feed.current`. | A function that returns a changefeed |
| `ReactiveMap<K, V, C>` | A `CallableChangefeed` over a `ReadonlyMap<K, V>`, with `.get`, `.has`, `.keys`, `.size`, iteration lifted to the top level. | A Signal, an Observable, or a MobX map |
| `ReactiveMapHandle<K, V, C>` | The producer-side split of `ReactiveMap` — `set`, `delete`, `clear`, `emit`. | Any interface a consumer should hold |

---

## Architecture

**Thesis**: a single symbol is enough.

The entire reactive story in Kyneta reduces to: *if `value[CHANGEFEED]` exists, you can read the current state and subscribe to changes; if it does not, the value is static.* No class hierarchy, no framework boundary, no adapter layer — just a structural property any value can opt into.

### Why a symbol

`CHANGEFEED` is declared `Symbol.for("kyneta:changefeed")` (source: `packages/changefeed/src/changefeed.ts` → `CHANGEFEED`). The `Symbol.for` registry means that two copies of this module — for instance, the version bundled into `@kyneta/react` and the version bundled into `@kyneta/exchange` — share the same symbol identity. Without that, a ref produced by one bundle would not be recognised as a changefeed by another.

Using a symbol rather than an interface or class means:

- A changefeed can be a plain object, a proxy, a function-object (`Callable`), or any exotic runtime shape — as long as it exposes the symbol, it participates.
- The reactive protocol does not constrain the rest of the object's shape. A `LoroDoc` ref, a `ReactiveMap`, and a `LocalRef<T>` in cast all satisfy `HasChangefeed` without sharing any other ancestor.
- The marker never collides with a user-authored field (symbols are structurally invisible).

### Two-layer design

Two types sit behind the symbol:

| Type | Fields | Purpose |
|------|--------|---------|
| `ChangefeedProtocol<S, C>` | `current`, `subscribe` | Minimal coalgebra. Internal plumbing — the thing behind the symbol. |
| `Changefeed<S, C>` | `[CHANGEFEED]`, `current`, `subscribe` | Developer-facing. Direct access to the current value and subscription without unwrapping the protocol first. |

`changefeed(source)` (source: `packages/changefeed/src/changefeed.ts` → `changefeed`) projects any `HasChangefeed` into the developer-facing form. `createChangefeed(getCurrent)` (same file) builds a `Changefeed<S, C>` from scratch and returns it paired with an `emit` function.

### What a `Changefeed` is NOT

- **Not a stream.** There is no back-pressure, no completion, no error channel. `subscribe` delivers every changeset the producer emits, synchronously, in order. Consumers who need buffering or completion semantics build them on top.
- **Not a promise or a future.** `current` is always available synchronously. Subscribing does not wait for anything.
- **Not persistent.** The changefeed holds the current value; it does not retain history. Replaying past changes is the producer's responsibility (see `@kyneta/exchange` for the durable-log version).
- **Not deduplicated.** The feed emits exactly what the producer emits. Downstream consumers that want to skip no-op changesets must filter themselves.

### What "reactive" means here (and does NOT mean)

- **Not push-only.** `current` is a *getter* that always returns live state. Consumers may read synchronously at any time without subscribing. The "reactive" part is the *option* to receive future changes, not the requirement.
- **Not signal-graph reactivity.** There is no dependency tracking, no auto-wiring between computations. A consumer that derives a value from a changefeed must subscribe explicitly and re-compute explicitly.
- **Not framework-bound.** `subscribe` returns a plain unsubscribe function. React's `useSyncExternalStore` consumes it, but so does a CLI test that just pushes into an array.

---

## Creating a changefeed

Three factories cover the common cases.

| Factory | Returns | Use case |
|---------|---------|----------|
| `createChangefeed<S, C>(getCurrent)` | `[feed, emit]` | You own the state and want to push changes. The thunk reads live state; `emit(changeset)` fans out to subscribers. |
| `staticChangefeed<S>(head)` | `ChangefeedProtocol<S, never>` | You have a value that never changes but must still satisfy the protocol (e.g. injected into a function that expects a changefeed). |
| `changefeed<S, C>(source)` | `Changefeed<S, C>` | You have a `HasChangefeed` and want the developer-facing surface. Pure projection — no new protocol created. |

The split between `ChangefeedProtocol` and `Changefeed` exists so that producers can implement the minimum (just the protocol) while consumers receive the full ergonomic type through `changefeed()`.

---

## Changesets and batching

Every callback receives a `Changeset<C>`, never a bare change (source: `packages/changefeed/src/changefeed.ts` → `Changeset`, `ChangefeedProtocol.subscribe`). A changeset is:

```
{ changes: readonly C[], origin?: string }
```

Auto-commit produces a degenerate changeset of one. Transactions and `applyChanges` in `@kyneta/schema` produce multi-change batches. The subscriber API is uniform across both cases.

`origin` carries provenance for the **whole batch**, not per-change. Individual changes carry only their `type` discriminant. This is why `@kyneta/exchange` can ask "did this change come from sync or from local?" by checking `changeset.origin === "sync"` on a single field rather than iterating.

### What `Changeset.origin` is NOT

- **Not a peer ID.** Origin is a categorical provenance string (`"local"`, `"sync"`, `"undo"`, `"migration"`), not a sender identity.
- **Not required.** Many changesets emit without origin. Subscribers that filter on origin must handle `undefined`.
- **Not per-change.** Each change in the batch shares the same origin. If a mixed-origin batch were needed, it would have to be split into multiple emits.

---

## `CallableChangefeed` — the function-object variant

`CallableChangefeed<S, C>` is the intersection `Changefeed<S, C> & (() => S)` (source: `packages/changefeed/src/callable.ts` → `CallableChangefeed`). Calling the feed returns its current value; the `.current` / `.subscribe` / `[CHANGEFEED]` surface is preserved as properties on the function-object.

`createCallable(feed)` wraps an existing feed. The callable uses `Object.defineProperty` with non-enumerable getters so that `hasChangefeed(callable)` still returns `true` and `callable[CHANGEFEED]` delegates to the wrapped feed's protocol.

### What a `CallableChangefeed` is NOT

- **Not a computation.** Calling `feed()` reads the current value; it does not compute, re-derive, or trigger a subscription.
- **Not a method.** `feed()` works the same whether bound or unbound — the call signature captures the wrapped feed in a closure.

---

## `ReactiveMap` — callable changefeed over a mutable Map

`ReactiveMap<K, V, C>` extends `CallableChangefeed<ReadonlyMap<K, V>, C>` with lifted collection accessors: `.get`, `.has`, `.keys`, `.size`, and `[Symbol.iterator]()` (source: `packages/changefeed/src/reactive-map.ts` → `ReactiveMap`). Consumers treat it like a read-only map *and* subscribe to it.

`createReactiveMap()` returns `[ReactiveMap, ReactiveMapHandle]`. The map owns an internal `Map<K, V>`; consumers read, producers mutate via the handle.

### Mutation does not imply notification

`ReactiveMapHandle.set`, `delete`, and `clear` mutate the internal map but **do not emit** (source: `packages/changefeed/src/reactive-map.ts` → `createReactiveMap` handle definition). The consumer calls `handle.emit(changeset)` when appropriate.

This separation is deliberate — it enables batching:

```
handle.clear()
for (const [k, v] of incoming) handle.set(k, v)
handle.emit({ changes: [{ type: "replaced", entries: incoming }] })
```

One emit, one changeset, one subscriber invocation per subscriber — instead of N+1.

### Snapshot semantics

`reactiveMap()` and `reactiveMap.current` serve different consumers:

| Access | Returns | Identity | Use case |
|--------|---------|----------|----------|
| `reactiveMap()` | Shallow copy (`new Map(map)`) | New reference each call | External-store consumers (`useSyncExternalStore`, Svelte stores, Solid signals) |
| `reactiveMap.current` | The live internal `Map` | Same reference always | Imperative reads inside subscriber callbacks |
| `.get()`, `.has()`, `.size`, iteration | Reads from live map | N/A | Ergonomic access without unwrapping |

The callable returns a **snapshot** — a new `Map` on each call. This mirrors how schema product/sequence refs work: `ref()` allocates a fresh plain object so that external-store consumers (React's `useSyncExternalStore`, Svelte stores, Solid signals) detect changes via reference identity (`Object.is`). Without snapshot semantics, `useValue(reactiveMap)` would never trigger a re-render because the same `Map` reference would be compared equal.

`.current` returns the **live** map — the same instance every time. This matches the `ChangefeedProtocol.current` contract ("the current value, always live") and is useful for imperative code that reads map state during subscriber callbacks.

### What a `ReactiveMap` is NOT

- **Not a store in the reactive-library sense.** There is no derived state, no selectors, no memoization. It is literally a map with a changefeed.
- **Not a query result.** A `ReactiveMap` is maintained by its producer (e.g. `exchange.peers`). Query results over documents live in `@kyneta/index`.
- **Not thread-safe.** JavaScript is single-threaded; mutations and emissions interleave only when the producer explicitly yields (microtask, timer). Producers are responsible for atomicity across emit boundaries.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `CHANGEFEED` | `src/changefeed.ts` | `Symbol.for("kyneta:changefeed")` — the protocol key. |
| `ChangefeedProtocol<S, C>` | `src/changefeed.ts` | `{ current, subscribe }` — the coalgebra behind the symbol. |
| `Changefeed<S, C>` | `src/changefeed.ts` | Developer-facing: `[CHANGEFEED]` + `.current` + `.subscribe` in one interface. |
| `HasChangefeed<S, C>` | `src/changefeed.ts` | Weakest form — any object that carries `[CHANGEFEED]`. |
| `Changeset<C>` | `src/changefeed.ts` | `{ changes, origin? }` — batch delivery unit. |
| `ChangeBase` | `src/change.ts` | `{ type: string }` — the open base protocol for changes. |
| `CallableChangefeed<S, C>` | `src/callable.ts` | `Changefeed<S, C> & (() => S)` — callable function-object variant. |
| `ReactiveMap<K, V, C>` | `src/reactive-map.ts` | Callable changefeed over `ReadonlyMap<K, V>` with lifted accessors. |
| `ReactiveMapHandle<K, V, C>` | `src/reactive-map.ts` | Producer-side: `set`, `delete`, `clear`, `emit`. |

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 27 | Public exports. |
| `src/changefeed.ts` | 250 | `CHANGEFEED` symbol, protocol/developer types, `createChangefeed`, `changefeed`, `hasChangefeed`, `staticChangefeed`. |
| `src/change.ts` | 28 | `ChangeBase` — the open change protocol. |
| `src/callable.ts` | 82 | `CallableChangefeed`, `createCallable`. |
| `src/reactive-map.ts` | 162 | `ReactiveMap`, `ReactiveMapHandle`, `createReactiveMap`. |
| `src/__tests__/changefeed.test.ts` | 347 | Protocol tests: symbol identity, `createChangefeed`/`changefeed`/`staticChangefeed`, subscribe semantics. |
| `src/__tests__/reactive-map.test.ts` | 324 | `ReactiveMap` tests: lifted accessors, handle semantics, batched emit, subscriber fan-out. |

## Testing

Every test is pure — zero external dependencies, no timers, no network. Subscribers are tested by emitting synthetic changesets and inspecting the recorded callback invocations.

**Tests**: 47 passed, 0 skipped across 2 files (`changefeed.test.ts`: 24, `reactive-map.test.ts`: 23). Run with `cd packages/changefeed && pnpm exec vitest run`.