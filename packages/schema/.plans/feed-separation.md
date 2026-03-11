# Separate Feed from Writable Interpreter

## Background

The theory document (§5.4) defines three orthogonal capabilities:

| Capability | Protocol | Consumer |
|---|---|---|
| **Readable** | `feed.head` | Kinetic compiler, `toJSON()` |
| **Subscribable** | `feed.subscribe` | Kinetic compiler |
| **Writable** | `.set()`, `.insert()`, etc. | `change()` blocks |

The writable interpreter currently violates this separation by attaching `[FEED]` directly to every ref it produces (products, sequences, maps, text refs, counter refs). This means:

1. Observation and mutation are coupled — you can't have one without the other
2. The `enrich` combinator exists but isn't used for its intended purpose
3. The `Writable<S>` type doesn't include `Feedable` (correctly), so accessing `[FEED]` requires `as unknown as ...` casts in tests
4. The writable interpreter imports `FEED`, `Feed`, `getOrCreateFeed` — dependencies it shouldn't need
5. The `WritableContext` carries `subscribers` — infrastructure the writable interpreter doesn't conceptually own

## Problem Statement

The `[FEED]` attachment code in the writable interpreter should be extracted into a `withFeed` decorator used via `enrich(writableInterpreter, withFeed)`. The subscription infrastructure (`subscribers`, `notifySubscribers`, `subscribeToPath`, `pathKey`) should move out of the writable interpreter into the feed decorator's scope. The `dispatch` function in `WritableContext` should only apply actions to the store; notification is the feed layer's concern.

## Success Criteria

1. `writableInterpreter` has zero imports from `feed.ts` — no `FEED`, no `Feed`, no `getOrCreateFeed`
2. `WritableContext` has no `subscribers` field, no notification infrastructure at all
3. A `withFeed` decorator exists that attaches `[FEED]` to object results via `enrich`
4. `enrich(writableInterpreter, withFeed)` produces results where `isFeedable(result) === true`
5. The `Writable<S>` type remains the mutation-only surface
6. A `WritableWithFeed<S>` type adds `& Feedable<...>` at each node for the enriched case
7. Feed subscription tests pass against the enriched interpreter, not the bare writable
8. Bare writable tests pass WITHOUT any feed assertions or `isFeedable` checks
9. All existing tests pass (some will move between test files)
10. `tsc --noEmit` reports zero errors

## Gap

- The writable interpreter has ~60 lines of feed infrastructure baked in (subscriber map, notification, feed creation, attachment)
- `dispatch` in `createWritableContext` calls `notifySubscribers` — this coupling must be removed
- The `flush` function also calls `notifySubscribers` — same coupling
- 7+ tests in `writable.test.ts` directly test feed behavior on the bare writable (including `isFeedable` assertions)

## Design: Dispatch Wrapping (not hooks)

The key architectural decision: the feed layer **wraps the dispatch function** rather than injecting hooks into `WritableContext`.

```
                    createWritableContext(store)
                    │
                    ▼
            WritableContext
            { store, dispatch, autoCommit, pending }
                    │
                    │  createFeedableContext(writableCtx)
                    ▼
            FeedableContext extends WritableContext
            { ...writableCtx, dispatch: wrappedDispatch, subscribers }
```

1. `createWritableContext(store)` — pure mutation context. `dispatch` only applies actions to the store. No subscribers, no notification.
2. `createFeedableContext(writableCtx)` — returns a new context with the same store but a **wrapped dispatch** that calls the original dispatch AND notifies subscribers. The subscriber map lives in the `createFeedableContext` closure.
3. `interpret(schema, enrich(writableInterpreter, withFeed), feedableCtx)` — the `withFeed` decorator reads from `feedableCtx.subscribers` (via the ctx it receives) to create feed objects. Notification happens through the wrapped dispatch.

The writable interpreter code is untouched — it calls `ctx.dispatch` and doesn't know or care what dispatch does.

### Why `enrich(writableInterpreter, withFeed)` and not the reverse

`enrich` is asymmetric: `enrich(base, decorator)`. The base interpreter runs first, then the decorator receives the result and adds protocol. `withFeed` is a `Decorator`, not an `Interpreter` — it can't be swapped.

The `withFeed` decorator is also independent of the writable interpreter — it only needs `ctx` and `path` to create feeds (reading `head` from the store, subscribing via the context's subscriber map). It could decorate *any* interpreter sharing the same context type.

### Flush wrapping

`flush` exists for **batched mode**. When `autoCommit: false`, mutations push actions into a `pending` array without applying them. `flush(ctx)` applies all pending actions at once — this models the `change()` block's commit boundary.

`createFeedableContext` wraps `flush` so that after each pending action is applied, subscribers are notified. The bare `flush` only applies actions. The feedable `flush` applies AND notifies.

### FEED attachment via `Object.defineProperty` (no Proxy changes needed)

The `withFeed` decorator attaches `[FEED]` using `Object.defineProperty` (non-enumerable, like the current `attachFeed` helper). This is critical because:

- `Object.defineProperty` does NOT trigger a Proxy's `set` trap — it goes through the `defineProperty` trap instead
- The Map Proxy already delegates symbol property descriptors to the base/target object via `getOwnPropertyDescriptor`
- Therefore, no changes to the Map Proxy's `set` trap are needed

The `withFeed` decorator mutates the result directly via `Object.defineProperty` and returns `{}` from the `Decorator` function. The `enrich` combinator's `Object.assign({})` is a no-op. This keeps the decorator self-contained.

However, the Map Proxy does need a `defineProperty` trap that forwards symbol definitions to the target. Without this trap, the Proxy will use the default behavior which should work for non-configurable descriptors, but we should verify this in tests.

### Shared utilities

`readByPath` and `toStorePath` are needed by both the writable interpreter (for refs) and the `withFeed` decorator (for `feed.head`). These should be exported from `writable.ts`.

## Phases

### Phase 1: Extract feed infrastructure and create `withFeed` decorator 🟢

- Task: Export `readByPath` and `toStorePath` from `writable.ts` (they're currently module-private). 🟢

- Task: Create `packages/schema/src/interpreters/with-feed.ts` containing: 🟢
  - The subscription infrastructure moved from writable.ts: `pathKey`, `subscribeToPath`, `notifySubscribers`
  - A `FeedableContext` interface extending `WritableContext` with `{ subscribers: Map<string, Set<...>> }`
  - `createFeedableContext(writableCtx)` — wraps `dispatch` to apply + notify, wraps `flush` similarly, creates the subscriber map
  - `createFeedForPath(ctx, storePath, readHead)` helper (moved from writable.ts)
  - `attachFeed(target, feed)` helper (moved from writable.ts) — uses `Object.defineProperty` for non-enumerable symbol attachment
  - The `withFeed` decorator: attaches `[FEED]` non-enumerably to object results via `Object.defineProperty`, returns `{}` so `enrich`'s `Object.assign` is a no-op. For primitives, returns empty (no-op).

- Task: Remove from `packages/schema/src/interpreters/writable.ts`: 🟢
  - All imports from `feed.ts` (`FEED`, `Feed`)
  - `subscribeToPath`, `notifySubscribers`, `pathKey`, `createFeedForPath`, `attachFeed`
  - All `attachFeed(...)` calls in `product`, `sequence`, `map`, `createTextRef`, `createCounterRef`
  - The `subscribers` field from `WritableContext`
  - The `notifySubscribers` call from `dispatch` in `createWritableContext`
  - The `notifySubscribers` call from `flush`

- Task: Verify the Map Proxy works with `Object.defineProperty`-based FEED attachment. Add a `defineProperty` trap to the Map Proxy if needed to forward symbol definitions to the target. 🟢

- Task: Update `packages/schema/src/index.ts` barrel to export `withFeed`, `FeedableContext`, `createFeedableContext`, `readByPath`, `toStorePath`. 🟢

### Phase 2: Update tests 🟢

- Task: In `writable.test.ts`, remove all feed-related code: 🟢
  - The entire "feed subscription" describe block (head, head-reflects-mutation, subscribe-lifecycle tests)
  - All `isFeedable` assertions (isFeedable for products, text, counter)
  - The namespace isolation tests that assert `FEED_SYM in doc` and check the FEED descriptor
  - All `FEED` / `isFeedable` imports

- Task: In `writable.test.ts`, the `createChatDoc` fixture should use the bare `writableInterpreter`. All remaining tests should work without feeds. 🟢

- Task: Create `packages/schema/src/__tests__/with-feed.test.ts` with: 🟢
  - A `createFeedableChatDoc` fixture using `enrich(writableInterpreter, withFeed)` + `createFeedableContext`
  - Feed subscription lifecycle (subscribe, receive action on mutation, unsubscribe stops delivery)
  - `isFeedable` returns true for products, text refs, counter refs, sequences, maps
  - `[FEED].head` returns current value and reflects mutations
  - Namespace isolation: `[FEED]` is non-enumerable, `Object.keys` returns only schema keys
  - Batched mode: feedable flush notifies subscribers
  - Mutations still work through the enriched interpreter (writable surface preserved)

### Phase 3: `WritableWithFeed<S>` type 🔴

- Task: Define `WritableWithFeed<S>` as a recursive conditional type that mirrors `Writable<S>` but intersects each node with `Feedable<HeadType, ActionType>`: 🔴
  - `AnnotatedSchema<"text">` → `TextRef & Feedable<string, TextAction>`
  - `AnnotatedSchema<"counter">` → `CounterRef & Feedable<number, IncrementAction>`
  - `ProductSchema<F>` → `{ readonly [K in keyof F]: WritableWithFeed<F[K]> } & Feedable<unknown, MapAction>`
  - `SequenceSchema<I>` → `SequenceRef<WritableWithFeed<I>> & Feedable<unknown, SequenceAction>`
  - `MapSchema<I>` → `{ readonly [key: string]: WritableWithFeed<I> } & Feedable<unknown, MapAction>`
  - `ScalarSchema<K>` → `ScalarRef<ScalarPlain<K>>` (scalars don't get feeds — they're primitives without independent identity)
  - `AnnotatedSchema<"doc", ProductSchema<F>>` → delegates to product case

- Task: Add type-level tests in `types.test.ts` validating `WritableWithFeed<S>` computes correct types for the chat doc schema. 🔴

- Task: Update `with-feed.test.ts` to use `WritableWithFeed<typeof chatDocSchema>` instead of casts. 🔴

### Phase 4: Documentation 🔴

- Task: Update `packages/schema/TECHNICAL.md` — correct the writable interpreter section to reflect that feed attachment is now via `enrich`, not baked in. Remove "Feed subscription" from "Verified Properties" for the writable interpreter; add it to a new "Feed Decorator" section. Update the file map to include `with-feed.ts`. 🔴

## Learnings

### `Object.defineProperty` bypasses Proxy `set` traps

When attaching symbol-keyed protocol to a Proxy-backed object (like the Map Proxy), `Object.defineProperty` is the correct tool because it goes through the `defineProperty` trap, not the `set` trap. This means the Proxy's `set` trap (which rejects symbol writes to prevent data pollution) doesn't need to change. The `attachFeed` helper already uses `Object.defineProperty` — the `withFeed` decorator should do the same.

### `enrich`'s `Object.assign` merge is insufficient for non-enumerable symbols

The `enrich` combinator uses `Object.assign(result, protocol)` to merge decorator output onto the base result. But `Object.assign` only copies *own enumerable* properties. A `[FEED]` property defined via `Object.defineProperty` with `enumerable: false` would NOT be copied by `Object.assign`.

The solution: the `withFeed` decorator attaches `[FEED]` directly to the result (mutating it) and returns `{}` from the decorator function. The `enrich` combinator's `Object.assign({})` is a harmless no-op. The decorator is self-contained — it doesn't rely on `enrich`'s merge mechanism for attachment.

### Decorators that mutate vs. decorators that return protocol

This reveals two decorator patterns:

1. **Returning protocol** — the decorator returns `{ symbolProp: value }` and relies on `enrich`'s `Object.assign` to merge it. Works for enumerable properties.
2. **Mutating the result** — the decorator calls `Object.defineProperty` on the result directly and returns `{}`. Required for non-enumerable symbol properties.

The `withFeed` decorator uses pattern 2. This is the correct pattern for any protocol that should be invisible to `Object.keys()`, `JSON.stringify()`, and `for...in`.

## Transitive Effect Analysis

This change is contained within `packages/schema/` — no other packages depend on it. Within the package:

- `writable.ts` loses ~60 lines, its `feed.ts` imports, and the `subscribers` field on `WritableContext`
- `writable.ts` gains two exports: `readByPath`, `toStorePath`
- New `with-feed.ts` takes ownership of all feed infrastructure
- `combinators.ts` is unchanged (already defines `enrich`)
- `feed.ts` is unchanged (already defines `FEED`, `Feed`, `getOrCreateFeed`)
- `interpret.ts` is unchanged
- `index.ts` gains new exports
- `types.test.ts` gains `WritableWithFeed<S>` assertions (Phase 3)
- `writable.test.ts` loses all feed tests and all `FEED`/`isFeedable` references
- New `with-feed.test.ts` takes ownership of feed tests
- `dispatch` in `createWritableContext` no longer notifies — code that relied on auto-commit notification must use `createFeedableContext` instead
- `flush` no longer notifies — code must use the feedable context's flush

## Resources for Implementation Context

| Resource | Path | Relevance |
|---|---|---|
| Theory: capability decomposition | `packages/schema/theory/interpreter-algebra.md` §5.4 | Readable + Subscribable + Writable as orthogonal capabilities |
| Theory: enrich combinator | `packages/schema/theory/interpreter-algebra.md` §7.2 | `TypedRef = enrich(writable, withFeed)` |
| Writable interpreter | `packages/schema/src/interpreters/writable.ts` | The code being refactored |
| Feed module | `packages/schema/src/feed.ts` | FEED symbol, Feed/Feedable, getOrCreateFeed |
| Combinators | `packages/schema/src/combinators.ts` | `enrich` combinator |
| Writable tests | `packages/schema/src/__tests__/writable.test.ts` | Tests to split |
| Type tests | `packages/schema/src/__tests__/types.test.ts` | Writable<S> type assertions |
| Package TECHNICAL.md | `packages/schema/TECHNICAL.md` | Documentation to update |

## Alternatives Considered

### `onDispatch` hook on WritableContext

Add an optional `onDispatch: (path, action) => void` hook to `WritableContext` that the feed layer registers. **Rejected** because it puts an observation concern back into the writable context behind an indirection. Dispatch wrapping is cleaner — the writable interpreter calls `ctx.dispatch` without knowing what happens inside, and the feed layer wraps dispatch externally without touching WritableContext's shape.

### Keep feeds in writable, add a `bare` variant

Create a `bareWritableInterpreter` that strips feeds, keep the current `writableInterpreter` with feeds baked in. **Rejected** because it inverts the principle — the default should be minimal (just mutation), and observation should be opt-in via composition.

### Use event emitter on WritableContext

Replace the subscriber map with a generic event emitter. **Rejected** as overengineered — a wrapped dispatch function achieves the same result with zero new abstractions.

### `Object.assign` for FEED attachment in the decorator

Have the decorator return `{ [FEED]: feed }` and let `enrich`'s `Object.assign` merge it onto the result. **Rejected** because `[FEED]` must be non-enumerable (namespace isolation), and `Object.assign` only copies enumerable properties. The decorator must use `Object.defineProperty` directly.

## Changeset

No changeset needed — `packages/schema` is an internal package with no consumers.