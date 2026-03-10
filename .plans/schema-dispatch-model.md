# Schema Dispatch Model: Self-Path Dispatch + Product `.set()`

## Status: 🟡 In Progress

## Background

The `@loro-extended/schema` package implements a schema interpreter algebra where mutations flow through a `withMutation` interpreter transformer. Currently, scalar `.set()` uses an "upward reference" pattern inherited from Loro's CRDT model: it dispatches a `MapChange` to the **parent** path rather than a `ReplaceChange` at the scalar's own path. This was necessary in `@loro-extended/change` because Loro stores plain JSON values inside `LoroMap` containers — setting a boolean means calling `loroMap.set("key", true)` on the parent map. There is no standalone `LoroBooleanContainer`.

However, the `schema` package is backend-agnostic. Its store is a plain JS object. The upward-dispatch pattern:

1. Breaks notification expectations — exact-path subscribers at a scalar's path never fire on `.set()`.
2. Conflates the change type — a scalar write appears as a `MapChange` (parent's vocabulary) instead of a `ReplaceChange` (the scalar's vocabulary).
3. Prevents product-level `.set()` — products are currently "pure pass-through" with no mutation methods, so there's no way to atomically replace an entire struct subtree in a single change.

Separately, product nodes lack a `.set(plainObject)` method. This means there's no way to express "replace this entire struct" as a single `ReplaceChange`. For Loro integration (Phase 5+ in the roadmap), this matters: a `ReplaceChange` at a product path maps naturally to `LoroMap.set(key, entireBlob)` — one CRDT operation instead of N per-leaf operations. The developer controls mutation granularity: leaf `.set()` for surgical edits, product `.set()` for bulk replacement.

## Problem Statement

1. **Scalar `.set()` dispatches to the wrong path.** It dispatches `MapChange` at `path.slice(0, -1)` instead of `ReplaceChange` at `path`. This is a Loro-ism that doesn't belong in the base library.

2. **Products have no `.set()`.** There is no way to atomically replace a product's entire value in a single change. This creates a granularity problem: the only way to "reset settings" is N individual scalar `.set()` calls, producing N changes and N notifications.

## Success Criteria

- Scalar `.set(value)` dispatches `ReplaceChange` at its own path.
- An exact-path changefeed subscriber on a scalar fires when `.set()` is called.
- Deep subscribers see scalar `.set()` with the correct relative `origin` (the scalar's segment, not the parent's).
- Product nodes gain `.set(plainObject)` that dispatches `ReplaceChange` at the product's own path.
- `Writable<ProductSchema<F>>` includes `{ set(value: { [K in keyof F]: Plain<F[K]> }): void }`.
- All existing tests pass (with updated expectations where the dispatch model changed).
- `example/main.ts` showcases both granularities.
- TECHNICAL.md documents the new dispatch model and design intent for Loro integration.

## The Gap

| Aspect | Current | Target |
|---|---|---|
| `scalar.set()` dispatch path | Parent path (`path.slice(0, -1)`) | Own path (`path`) |
| `scalar.set()` change type | `MapChange` | `ReplaceChange` |
| Product mutation | None (pass-through) | `.set(plainObject)` → `ReplaceChange` |
| `Writable<ProductSchema>` | `{ readonly [K in keyof F]: Writable<F[K]> }` | Same + `{ set(value): void }` |
| Scalar exact-path subscriber | Never fires on `.set()` | Fires on `.set()` |
| Deep subscriber origin for scalar `.set()` | `origin: []` at parent path | `origin: [{type:"key",key:"darkMode"}]` from parent |

## Phases and Tasks

### Phase 1: Fix scalar dispatch model ✅

- ✅ In `withMutation` scalar case, replace upward `MapChange` dispatch with `ReplaceChange` at own path. Remove `parentPath`, `lastSeg`, `key` computation. The scalar case becomes: `result.set = (value) => ctx.dispatch(path, replaceChange(value))`.
- ✅ Update `writable.test.ts`: rename "scalar upward reference" describe block to "scalar dispatch". Update assertions — store write still works (via `applyChangeToStore` + `writeByPath`), but the mechanism is now `ReplaceChange` at own path.
- ✅ Update `with-changefeed.test.ts`: rename "scalar upward dispatch" describe block. Fix `origin` and `change.type` expectations: scalar `.set()` now dispatches at `["settings", "darkMode"]` (not `["settings"]`), so deep subscriber at `["settings"]` sees `origin: [{type:"key", key:"darkMode"}]` with type `"replace"` (not `origin: []` with type `"map"`). Deep subscriber at root sees `origin: [{type:"key",key:"settings"},{type:"key",key:"darkMode"}]`.
- ✅ Update `with-changefeed.test.ts` batched mode test: switched root exact subscriber to deep subscriber at root, since scalar `.set()` now dispatches `ReplaceChange` at `["x"]` (not `MapChange` at `[]`). Also updated batched deep subscription test change types from `"map"` to `"replace"`.
- ✅ Add test: exact-path changefeed subscriber on a scalar fires on `.set()`.

### Phase 2: Add product `.set()` 🔴

- 🔴 Add `ProductRef<T>` interface to `writable.ts`: `{ set(value: T): void }`.
- 🔴 Update `Writable<S>` type: product case changes from `{ readonly [K in keyof F]: Writable<F[K]> }` to `{ readonly [K in keyof F]: Writable<F[K]> } & ProductRef<{ [K in keyof F]: Plain<F[K]> }>`. Same for `doc` annotation's inner product case.
- 🔴 In `withMutation` product case, stop passing through. Add `.set(value)` to the base result as a non-enumerable method (via `Object.defineProperty`, matching the pattern used by map refs). Dispatches `ReplaceChange` at own path.
- 🔴 Add tests in `writable.test.ts`: product `.set()` writes entire object to store; individual field refs still work after product `.set()`; product `.set()` inside batched mode accumulates one `PendingChange`.
- 🔴 Add tests in `with-changefeed.test.ts`: exact subscriber on product fires on `.set()`; deep subscriber on root sees product `.set()` with correct origin.
- 🔴 Add type-level test in `types.test.ts`: `Writable<ProductSchema<{ x: ScalarSchema<"number"> }>>` has `.set({ x: number })`.

### Phase 3: Update example 🔴

- 🔴 **Section 3** (Direct Mutations): after per-field `doc.settings.visibility.set("private")` and `doc.settings.maxTasks.set(50)`, add `doc.settings.set({ visibility: "public", maxTasks: 100, archived: false })` to show bulk struct assignment. Log the result.
- 🔴 **Section 6** (Batched Mutations): replace `d.settings.archived.set(true)` with `d.settings.set({ visibility: "private", maxTasks: 25, archived: true })` inside the `change()` block to demonstrate product `.set()` in batch context.
- 🔴 **Section 8** (Portable Refs): add a one-liner variant of `resetSettings` using `doc.settings.set({...})` alongside the existing per-ref version. Comment contrasting the two granularities.
- 🔴 **Section 11** (Deep Subscriptions): output naturally changes — `doc.settings.maxTasks.set(999)` now shows `origin: settings.maxTasks, type: replace` instead of `origin: settings, type: map`. Add a `doc.settings.set({...})` call to contrast: product `.set()` dispatches at the product path.

### Phase 4: Documentation 🔴

- 🔴 **TECHNICAL.md §Mutation Layer**: replace `MapChange to parent (upward reference pattern)` with `ReplaceChange at own path`. Document product `.set()`. Add "Dispatch Model" subsection explaining: every node dispatches at its own path; the developer controls granularity (leaf `.set()` for surgical, product `.set()` for bulk); Loro integration will map `ReplaceChange` at a plain subtree path to the appropriate `LoroMap` operations.
- 🔴 **TECHNICAL.md §Verified Properties**: add property for product `.set()` and scalar exact-path subscriber. Update test count.
- 🔴 **TECHNICAL.md §File Map**: confirm `interpreter-types.ts` is listed (from the prior refactor).

## Tests

Tests focus on behavioral changes and new capabilities. Reuse existing `createStructuralDoc()`, `createLoroDoc()`, `createChangefeedChatDoc()` helpers.

**`writable.test.ts`:**
- Scalar `.set()` applies `ReplaceChange` at own path (store reflects change).
- Portable scalar ref `.set()` works (existing test, unchanged behavior).
- Product `.set(entireObject)` writes to store.
- Product `.set()` is non-enumerable (doesn't appear in `Object.keys`).
- Product `.set()` inside batched mode: one pending change of type `"replace"`.
- Individual field refs still work after product `.set()`.

**`with-changefeed.test.ts`:**
- Exact subscriber on scalar fires on `.set()` with `ReplaceChange`.
- Deep subscriber at parent sees scalar `.set()` with `origin: [scalarSegment]`.
- Deep subscriber at root sees scalar `.set()` with full origin path.
- Exact subscriber on product fires on `.set()` with `ReplaceChange`.
- Deep subscriber at root sees product `.set()` with `origin: [productSegment]`.
- Batched mode: `changefeedFlush` notifies for scalar and product changes at their own paths.

**`types.test.ts`:**
- `Writable<ProductSchema<{ x: ScalarSchema<"number"> }>>` includes `set(value: { x: number }): void`.
- `Writable<AnnotatedSchema<"doc", ProductSchema<F>>>` inner product also has `.set()`.

## Transitive Effect Analysis

### Direct dependencies (files we modify)

| File | Change |
|---|---|
| `src/interpreters/writable.ts` | Scalar dispatch fix, product `.set()`, `ProductRef` interface, `Writable<S>` type update |
| `src/__tests__/writable.test.ts` | Updated scalar tests, new product `.set()` tests |
| `src/__tests__/with-changefeed.test.ts` | Updated dispatch expectations, new exact-subscriber tests |
| `src/__tests__/types.test.ts` | New type-level tests for `ProductRef` |
| `example/main.ts` | Showcase both granularities |
| `TECHNICAL.md` | Document new dispatch model |

### Transitive dependencies (files that import from modified files)

| Consumer | Risk | Mitigation |
|---|---|---|
| `src/interpreters/with-changefeed.ts` | Imports `WritableContext`, `PendingChange` from `writable.ts`. No interface change — safe. | None needed. |
| `src/interpreters/readable.ts` | Imports `RefContext` from `interpreter-types.ts` (not from `writable.ts` anymore). No interface change. | None needed. |
| `src/interpreters/validate.ts` | Imports `Plain` from `interpreter-types.ts`. No change. | None needed. |
| `src/index.ts` | Re-exports from `writable.ts`. New `ProductRef` interface needs to be added to barrel exports. | Add `ProductRef` to the `export type` block. |
| `src/store.ts` | `applyChangeToStore` handles `ReplaceChange` at non-root paths via `writeByPath`. Already works — `step(currentValue, replaceChange(newValue))` returns `newValue`, then `writeByPath` puts it at the path. | Verify with test (Phase 1). |
| `src/step.ts` | `stepReplace` is already implemented and dispatched for `type: "replace"`. | No change needed. |
| `example/main.ts` | The `change()` facade creates a separate batched context. Product `.set()` on the draft will dispatch `ReplaceChange`. The batched context accumulates it. `changefeedFlush` applies it. The original doc's refs read from the shared store. | Verify the `change()` facade works with product `.set()` in the example. |

### Notification model change — the key transitive risk

The scalar dispatch change means any code subscribing at a **parent** path expecting to receive `MapChange` when a child scalar is `.set()` will stop receiving those notifications. This affects:

1. `with-changefeed.test.ts` — explicitly tested, will be updated.
2. `example/main.ts` §11 — deep subscription output changes, will be updated.
3. No external consumers (the package has no dependents).

The product `.set()` addition is purely additive — no existing behavior changes.

## Resources for Implementation Context

These files should be loaded during implementation:

- `src/interpreters/writable.ts` — primary modification target (scalar case, product case, `Writable<S>`, `ProductRef`)
- `src/interpreter-types.ts` — `Plain<S>` definition (needed for `ProductRef<T>` type parameter)
- `src/store.ts` — `applyChangeToStore`, `writeByPath` (verify `ReplaceChange` at non-root path works)
- `src/change.ts` — `replaceChange` constructor
- `src/interpreters/with-changefeed.ts` — `notifyAll` logic (understand notification flow)
- `src/__tests__/writable.test.ts` — test helpers, existing scalar/product tests
- `src/__tests__/with-changefeed.test.ts` — changefeed test helpers, scalar dispatch tests
- `src/__tests__/types.test.ts` — type-level test patterns
- `example/main.ts` — sections 3, 6, 8, 11 for showcase updates
- `TECHNICAL.md` — §Mutation Layer, §Verified Properties, §File Map

## Alternatives Considered

### Alternative: Keep upward dispatch, add Loro-specific flag

Keep scalar `.set()` dispatching `MapChange` to parent. Add a `loroCompat` flag on `WritableContext` to control behavior.

**Rejected:** The upward dispatch is a Loro storage model concern, not a schema algebra concern. Baking it into the base library couples the backend-agnostic algebra to Loro's two-layer container/value distinction. When Loro integration happens (Phase 5+), the Loro-specific interpreter will talk to `LoroMap.set()` directly — it won't dispatch abstract changes through the same `ctx.dispatch` path. The base library should model the clean case.

### Alternative: Product `.set()` via MapChange instead of ReplaceChange

Have product `.set(obj)` dispatch a `MapChange` with all keys set, instead of a single `ReplaceChange`. This would mirror what the old scalar dispatch did — use the map vocabulary at the product level.

**Rejected:** `MapChange` is a partial operation (set some keys, delete others). `ReplaceChange` is a total operation (replace the entire value). Product `.set(entireObject)` has "replace" semantics — the old value is gone, the new value is the whole thing. `ReplaceChange` is the correct change type. Additionally, `MapChange` doesn't handle the case where the new object has fewer keys than the old one (you'd need explicit deletes), while `ReplaceChange` + `writeByPath` handles it naturally.

### Alternative: Annotate plain subtrees with `annotated("plain", ...)`

Mark the CRDT/value boundary in the grammar so interpreters can dispatch differently for plain subtrees vs CRDT containers.

**Deferred, not rejected:** This may be needed when the Loro-specific interpreter is built (Phase 5+). For now, the base library doesn't need this distinction — every node dispatches at its own path regardless. The annotation can be added later without breaking changes, because annotations are the grammar's extension mechanism.

### Alternative: Context accumulation for CRDT boundary tracking

Have the interpreter accumulate a "nearest CRDT container" context as it walks through annotations, so scalars inside plain subtrees know to dispatch upward.

**Deferred, not rejected:** This is an implementation strategy for the Loro-specific interpreter, not a base library concern. The base `withMutation` stays clean. The Loro interpreter (when built) may use context accumulation, annotation markers, or direct `LoroMap` API calls — that decision is deferred to Phase 5+.

## Changeset

```
(packages/schema) feat: self-path dispatch model + product .set()

Fix scalar .set() to dispatch ReplaceChange at its own path instead
of MapChange at the parent. The upward-dispatch pattern was a Loro-ism
that doesn't belong in the backend-agnostic base library.

Add .set(plainObject) to product nodes, enabling atomic subtree
replacement in a single ReplaceChange. This gives developers two
mutation granularities: leaf .set() for surgical edits, product
.set() for bulk replacement. For future Loro integration, a single
ReplaceChange at a product path maps to one LoroMap operation instead
of N per-leaf operations.

Breaking (internal only, no external consumers):
- Scalar .set() now dispatches ReplaceChange at own path
- Changefeed subscribers at parent path no longer see scalar writes
- Deep subscription origins shift to include the scalar segment
```
