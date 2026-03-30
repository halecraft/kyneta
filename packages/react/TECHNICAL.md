# @kyneta/react — Technical Documentation

Thin React bindings for `@kyneta/schema` and `@kyneta/exchange`. Bridges the `[CHANGEFEED]` reactive protocol to React's rendering cycle via `useSyncExternalStore`.

## Architecture: Functional Core / Imperative Shell

The package is split into two layers:

**Functional Core** (`src/store.ts`) — Two pure functions that translate from kyneta's reactive protocols into the `{ subscribe, getSnapshot }` contract that `useSyncExternalStore` consumes. Zero React imports. Independently testable with `createDoc` + `change()`.

**Imperative Shell** (hooks) — Thin wrappers (`useValue`, `useSyncStatus`, `useDocument`, `ExchangeProvider`) that feed the pure stores into React primitives. Each hook is 5–10 lines.

```
┌─────────────────────────────────────────────────────────────┐
│  React Component                                            │
│                                                             │
│  const value = useValue(doc.title)                          │
│       │                                                     │
│       └─► useSyncExternalStore(store.subscribe, store.get…) │
└────────────────────────┬────────────────────────────────────┘
                         │
            Imperative Shell (hooks) — React-specific
═════════════════════════╪══════════════════════════════════════
            Functional Core (store.ts) — framework-agnostic
                         │
┌────────────────────────┴──────────────────────────────────────┐
│  createChangefeedStore(ref)                                   │
│    let snapshot = ref()              ← eager initial compute  │
│    subscribe: cf.subscribeTree(…)    ← deep for composites    │
│    getSnapshot: () => snapshot       ← cached, stable ===     │
└────────────────────────┬──────────────────────────────────────┘
                         │
                  ref[CHANGEFEED]
                         │
┌────────────────────────┴──────────────────────────────────────┐
│  @kyneta/schema — CHANGEFEED protocol                         │
│  { current: Plain<S>, subscribe(cb): () => void }             │
└───────────────────────────────────────────────────────────────┘
```

This mirrors Cast's `valueRegion` — both are pure adapters from `[CHANGEFEED]` to a consumer contract. Cast delivers imperatively to DOM callbacks; the store delivers declaratively via `getSnapshot`. Two rendering targets, one protocol, two pure adapter functions.

## Snapshot Memoization and Referential Equality

### The Problem

`ref()` (and `ref[CHANGEFEED].current`) builds a **fresh plain object** on every call — recursively for products and sequences. Without memoization, `useSyncExternalStore` would return a new object reference on every render, defeating downstream `useMemo` / `React.memo`.

### The Solution

`createChangefeedStore` caches the snapshot in a closure variable:

1. **On creation:** `let snapshot = ref()` — eagerly compute the initial value.
1. **On changefeed fire:** `snapshot = ref()` — recompute only when something actually changed.
1. **On `getSnapshot()`:** return the cached `snapshot` — same object reference until the next change.

This guarantees:

- `getSnapshot() === getSnapshot()` between changes (referential stability)
- `getSnapshot()` returns a fresh object after a mutation (correctness)
- No redundant `ref()` calls on every React render

### What About Child Refs?

Child **refs** (e.g. `doc.title`, `doc.items.at(0)`) have stable identity courtesy of `withCaching` in the interpreter stack: `doc.title === doc.title` is always `true`. This means refs are safe to use as:

- `useEffect` / `useMemo` / `useCallback` dependency array members
- React list `key` values
- `React.memo()` props

Child **snapshots** (the plain values returned by `ref()`) are fresh objects on every call. The memoization in `createChangefeedStore` ensures the snapshot returned by `useValue` is stable.

## Type Recovery via `ReturnType<R>`

### The Problem

`Wrap<T, "rwc">` intersects with bare `HasChangefeed` (not `HasChangefeed<Plain<S>>`), so `ref[CHANGEFEED].current` is typed as `unknown` at the TypeScript level. The schema's type system doesn't thread `Plain<S>` through the changefeed generic.

### The Solution

Every ref's call signature is `() => Plain<S>`. Since `ref()` and `ref[CHANGEFEED].current` invoke the same `[CALL]` function at runtime, the hook uses `ReturnType<R>` to recover the plain type:

```ts
type CallableRef = ((...args: any[]) => any) & {
  readonly [CHANGEFEED]: Changefeed<any, ChangeBase>
}

function useValue<R extends CallableRef | null | undefined>(
  ref: R,
): R extends CallableRef ? ReturnType<R> : R
```

This avoids the 12+ overload explosion of the predecessor `@loro-extended/react`'s `useValue`.

### TS2589 on `useDocument`

The deeply recursive `Ref<S>` type exceeds TypeScript's depth budget when `S` is a generic parameter inside `useMemo`'s callback. `useDocument` uses the interface call signature pattern (same as `createDoc` in `@kyneta/schema/basic`) with an internal `as any` cast:

```ts
type UseDocument = <S extends SchemaNode>(
  docId: string,
  bound: BoundSchema<S>,
) => Ref<S>

export const useDocument: UseDocument = (docId, bound) => {
  const exchange = useExchange()
  return useMemo(() => (exchange as any).get(docId, bound), [exchange, docId, bound])
}
```

The outer call signature provides the correct `Ref<S>` return type.

## Conditional Return Type for Nullish Handling

Instead of multiple overloads for `null`, `undefined`, and non-nullish refs, `useValue` uses a single conditional return type:

```ts
R extends CallableRef ? ReturnType<R> : R
```

This collapses three cases into one generic:

- `CallableRef` → `ReturnType<R>` (the plain snapshot)
- `null` → `null`
- `undefined` → `undefined`

The implementation uses a nullish guard with a stable no-op store (`createNullishStore`) to ensure React's hook call count is consistent regardless of whether the ref is nullish.

## Deep-by-Default Subscription Strategy

`createChangefeedStore` dispatches subscription level based on the ref type:

| Ref kind | Changefeed type | Subscription | Behavior | |---|---|---|---| | Product, Sequence, Map | `ComposedChangefeed` | `subscribeTree` (deep) | Fires on any descendant change | | Scalar, Text, Counter | `Changefeed` | `subscribe` (node-level) | Fires only on own-path changes |

Detection uses `hasComposedChangefeed(ref)` from `@kyneta/schema` — a runtime check for the `subscribeTree` method.

This follows the MobX/Valtio "deep is default" pattern. A component using `useValue(doc)` re-renders on any descendant change. A component using `useValue(doc.title)` only re-renders when the title changes — sibling mutations are invisible.

## Exchange Lifecycle

`ExchangeProvider` creates an `Exchange` in `useMemo` (keyed on `config`) and tears it down via `exchange.reset()` in a `useEffect` cleanup.

`reset()` is synchronous and immediate — it disconnects all network adapters and clears the document cache. This matches React's synchronous cleanup model.

If async shutdown is needed (e.g. flushing pending storage writes), the consumer should call `exchange.shutdown()` before unmounting the provider. The provider itself does not handle async teardown.

## Epoch Boundary Behavior

When a remote peer sends a full snapshot (e.g. on initial sync or after log compaction), the exchange replays it as `ReplaceChange` ops on the existing substrate. This preserves all ref handles — components holding refs don't go stale on sync.

However, this triggers changefeed notifications at every affected leaf. Components using `useValue` will re-render. This is correct behavior — the state changed. The snapshot memoization ensures only components whose actual values changed will see new object references.

## Why No Framework-Agnostic Hooks Layer

The predecessor `@loro-extended/react` used a `hooks-core` package with `FrameworkHooks` DI — factory functions that accept `{ useState, useEffect, useSyncExternalStore, ... }` and return framework-specific hooks. This was rejected because:

1. **`[CHANGEFEED]` IS the framework-agnostic boundary.** It lives in `@kyneta/schema`, not in a hooks package. Any framework can consume `{ current, subscribe }`.

1. **The pure store functions are portable without DI.** `createChangefeedStore` and `createSyncStore` have zero React imports and work with any `useSyncExternalStore`-compatible consumer (React, Svelte's `readable`, Solid's `from`, etc.).

1. **The DI pattern forced type complexity.** 13+ TypeScript overloads in the React adapter to preserve type inference across package boundaries. The direct approach needs a single conditional return type.

1. **The shared logic was trivial.** The predecessor's `createSyncStore` utility (~30 lines) is replaced by the direct `CHANGEFEED` → `useSyncExternalStore` bridge (~15 lines per store function).

## File Map

| File | Purpose | |---|---| | `src/store.ts` | Pure store factories: `createChangefeedStore`, `createSyncStore`, `createNullishStore` | | `src/exchange-context.tsx` | `ExchangeProvider` component, `useExchange` hook | | `src/use-document.ts` | `useDocument` hook | | `src/use-value.ts` | `useValue` hook | | `src/use-sync-status.ts` | `useSyncStatus` hook | | `src/index.ts` | Barrel exports + thin re-exports from schema/exchange |

### Test Files

| File | Tier | Environment | |---|---|---| | `src/__tests__/store.test.ts` | Tier 1 — pure | Node (no jsdom) | | `src/__tests__/use-value.test.tsx` | Tier 2 — React | jsdom | | `src/__tests__/exchange-context.test.tsx` | Tier 2 — React | jsdom | | `src/__tests__/use-document.test.tsx` | Tier 2 — React | jsdom |

## Verified Properties

1. **Snapshot memoization:** `getSnapshot() === getSnapshot()` between changes (Tier 1 test: "snapshot is referentially stable between getSnapshot calls").
1. **Deep subscription:** Composite ref store fires on nested field change (Tier 1 test: "deep subscription on composite ref fires on nested field change").
1. **Shallow isolation:** Leaf ref store does NOT fire when a sibling changes (Tier 1 test: "leaf subscription does not fire when a sibling field changes").
1. **Unsubscribe correctness:** After unsubscribe, mutations do not update the cache (Tier 1 test: "unsubscribe stops snapshot updates").
1. **React integration:** `useValue` re-renders on change, returns initial value, handles nullish input (Tier 2 tests).
1. **Provider lifecycle:** `exchange.reset()` called on unmount (Tier 2 test: "calls exchange.reset() on unmount").
1. **Document idempotency:** Same `docId` + `BoundSchema` returns same ref identity across re-renders (Tier 2 test: "returns the same ref identity on re-render").
