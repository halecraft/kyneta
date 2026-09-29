# @kyneta/reactive — Technical Reference

> **Package**: `@kyneta/reactive`
> **Role**: Fine-grained, auto-tracked reactive computations over the changefeed — *tree/point* reactivity. `reactive(thunk)` captures exactly the nodes `thunk` reads (via `@kyneta/schema`'s read tracking) and re-runs when they change, coalescing bursts on a microtask. The relational/set sibling is `@kyneta/index` (ℤ-set IVM); the two compose.
> **Depends on**: `@kyneta/schema` (peer), `@kyneta/changefeed` (peer)
> **Depended on by**: `@kyneta/react` (`useTracked`/`useSelector`/`useValue` rest on it); application code wanting derived state without manual subscription wiring.
> **Canonical symbols**: `reactive`, `computed`, `track`, `Reactive`, `diffDeps`, `DepDiff`
> **Key invariant(s)**:
> 1. A `Reactive`'s `version` advances **iff** a tracked dependency fired. The runtime performs **no value comparison** — change detection is dependency-driven, not `shallowEqual`.
> 2. `reactive` and `computed` are the *same* primitive. A `Reactive` is a `HasChangefeed` whose `()` reports a read when a scope is active, so reading one inside another's thunk auto-wires it.
> 3. Parsimony: a `Reactive` re-runs only when a node it actually read changes — a `text` edit never wakes a `done`-only computation.
> 4. `refresh(thunk)` re-runs only when `thunk` is a new function or a dependency fired, so a value keeps its identity until one of its inputs changes — the closure among them.

## Architecture

Three pieces, FC/IS-split:

| Layer | Module | Pure? |
|-------|--------|-------|
| **Functional core** | `diff.ts` (`diffDeps`) | yes — subscription delta as a pure function |
| **Imperative shell** | `reactive.ts` (subscribe via `WatcherTable`, recompute, notify, scheduler) | no |

The shape mirrors `@kyneta/index`'s `integrate` (pure) + collection wiring (imperative), and `@kyneta/machine`'s `Program.update` (pure) + runtime.

### The cycle

1. **Capture** — `track(node)` runs the thunk inside `withReadScope` (`@kyneta/schema`), yielding the value + the exact `Dependency[]` (stable handle + `value`/`deep`/`structure` aspect, keyed by cursor-stable carrier identity).
2. **Subscribe (Fork A)** — `diffDeps(prevKeys, deps)` computes add/remove/keep; the imperative shell installs/tears down per-dependency subscriptions in a `WatcherTable` (hoisted to `@kyneta/changefeed`, shared with `@kyneta/index`). The aspect → primitive map reuses `@kyneta/schema`'s `hasRecursiveChangefeed` discriminator:

   | dependency | primitive |
   |---|---|
   | schema ref · `value`/`structure` | `subscribeNode` (own-path) |
   | schema ref · `deep` | `subscribe` (`subscribeDescendants`) |
   | plain `HasChangefeed` (another `Reactive`, an index `Collection`, a `ReactiveMap`) | `[CHANGEFEED].subscribe` |

   The last row is why reactives compose with the index tier for free — a `Collection` is a `HasChangefeed`.
3. **Invalidate → coalesce** — a firing subscription calls `markDirty(node)`, which schedules a single `queueMicrotask` flush. A burst of changesets (multiple merges, a sync replay) collapses to one re-run per node — the cross-merge/cross-tick coalescing that neither the substrate (intra-commit only) nor React (framework-specific) provides for a standalone runtime.
4. **Recompute** — the flush re-runs each dirty node once (`track` again + diff + reconcile subscriptions), bumps `version`, and notifies subscribers.

### Glitch-freedom without topological order

Reads are **pull-on-read**: `reactive()` (and `.current`) recompute first if dirty. So a computation reading a dirty dependency recomputes that dependency before using it — DAG glitch-freedom falls out without an explicit `flushOrder`. A per-flush **epoch guard** (`computedEpoch === flushEpoch`) caps each node to one recompute per flush, so the diamond case (A and B both depend on base X) re-runs each exactly once. (This is why the plan's proposed `flushOrder` was unnecessary.)

Direct schema-ref dependencies mark their node dirty *synchronously* when the changefeed fires, so a synchronous `reactive()` read after a `batch` is exact. Transitive `reactive → reactive` propagation completes on the microtask flush — which is what React observes anyway (it re-renders on the notification, after the flush).

### `refresh(thunk)` — the thunk as an input

A framework binding calls `refresh(thunk)` every render with the render's thunk, which becomes the node's thunk. It re-runs (tracking again, **without** bumping `version` or notifying) only if `thunk` is not the function last run or a dependency fired since, and otherwise returns the stored value — with its identity.

The closure is one more input to the computation, and its identity is its change signal. A thunk closing over new props is a new function and re-runs, so a binding follows props with no dependency list; the same function has nothing new to say, so a render that changed nothing gets the same value back. Keeping a thunk stable is the caller's job: React Compiler memoizes an inline thunk on exactly what it captures, and `useCallback` does the same by hand.

The gate reads `dirty`, not `version`. A dependency marks the node dirty synchronously, but `version` only advances on the microtask flush, and a render in between must not return the stale value. A re-run in that window clears `dirty`, so the flush then finds nothing to do and `version` stays put — the render already has the value, and no re-render is owed.

**Purity.** A thunk must be pure over its captures and its tracked reads. One that reads something untracked — `Date.now()`, a mutable ref, an outside store — returns a stale value once its identity is stable. This is the contract of `useMemo`, `computed` and React Compiler alike.

### What this package is NOT

- **Not relational/set IVM.** That's `@kyneta/index` (ℤ-sets, joins, groupings over collections). This is tree/point auto-tracking over a single document's node graph. They compose via `[CHANGEFEED]`.
- **Not value-diffing.** No `isEqual`/`shallowEqual` — `version` is the change token, driven by dependency firing. The only imprecision is a no-op write that the substrate still emits for (rare, harmless extra re-run) — the same bound as a per-subscription version counter.
- **Not React-bound.** Zero React imports (symmetric to `@kyneta/react`'s `store.ts`). React bindings live in `@kyneta/react`.

## Known limits (v1)

- **Subscription multiplicity (Fork A).** A reactive holds O(|deps|) subscriptions. For a huge dependency set this is real memory/churn; mitigate with the `deep` aspect (read a whole subtree → one `subscribeDescendants`, not one-per-field). Central op-stabilization (one shared index, resolve positional Op paths once at delivery) is the deferred scaling lever for the many-subscriber regime — and the delivery-side half of it has since landed in `@kyneta/schema`. Deep subscribers now register at their own path in one shared map, and `deliverNotifications` walks each changed path's ancestors to find them, rebasing once at delivery instead of re-prefixing at every level of a subscription graph. What remains deferred is the *reactive-side* half: one shared index over dependencies, rather than O(|deps|) subscriptions per reactive. As of schema 4.0 a `deep` dependency also receives one invalidation per transaction rather than one per changed path, so the callback volume that reaches `markDirty` fell sharply — most of all on sync merges, which previously fired once per path in the incoming payload. Recompute counts are unchanged, because the microtask coalescing already collapsed those bursts; what changed is how much work it takes to collapse them.
- **Collection composition needs a reported read.** Reading a plain `Collection`/`ReactiveMap` inside a thunk only becomes a dependency if it is *reported* — `Reactive` self-reports via its `()`, but `@kyneta/index` operators do not. Read one through `track(source)`, which reports it and returns its current value.

## File Map

| File | Role |
|------|------|
| `src/diff.ts` | `diffDeps` — the pure subscription-delta core. |
| `src/reactive.ts` | `reactive`/`computed`, the `Reactive` type, the aspect→primitive resolver, the coalescing scheduler, disposal. |
| `src/index.ts` | Public barrel. |
| `src/__tests__/reactive.test.ts` | Runtime tests over real refs: parsimony, coalescing, glitch-free composition, disposal, the `refresh` gate; pure `diffDeps`. |

## Testing

Tests use `createDoc` + `batch` from `@kyneta/schema/basic` (the same package boundary the runtime imports `@kyneta/schema` from, so read-tracking is one module instance). Run with `cd packages/reactive && pnpm exec vitest run`.
