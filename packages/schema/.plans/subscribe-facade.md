# Subscribe Facade — Library-level `subscribe` and `subscribeTree`

## Background

The `@kyneta/schema` package has a fully functional changefeed protocol: every ref produced by `withChangefeed` carries a `[CHANGEFEED]` symbol with `subscribe` (node-level) and optionally `subscribeTree` (tree-level). The protocol delivers `Changeset<C>` — a batch of changes with optional `origin` provenance.

However, subscribing today requires the caller to know about the `CHANGEFEED` symbol and access it directly:

```ts
import { CHANGEFEED } from "@kyneta/schema"

const unsub = doc.settings.darkMode[CHANGEFEED].subscribe((cs) => { ... })
const unsub = doc.settings[CHANGEFEED].subscribeTree!((cs) => { ... })
```

This ceremony is justified in tests (which exercise the protocol itself) and in the `withChangefeed` internals (which build the protocol), but it's the wrong interface for application code. The library already provides `change(ref, fn)` and `applyChanges(ref, ops)` as clean function-call facades over `[TRANSACT]` — subscription deserves the same treatment.

Three independent implementations of subscribe exist today:

1. **`@kyneta/core/runtime/subscribe.ts`** — scope-bound, unwraps `Changeset` to `(change, origin?)`, tracks in global `activeSubscriptions` map, returns `SubscriptionId`. This is the compiler runtime's subscribe; it has different concerns (scope lifecycle, subscription tracking) and will remain unchanged.

2. **`example/main.ts` local `subscribe()`** — unwraps `Changeset` to individual `ChangeBase`, returns unsubscribe function. This will be deleted when the example is updated.

3. **Raw `ref[CHANGEFEED].subscribe(cb)`** — used in all schema tests. Tests access the protocol directly, which is correct for testing the protocol itself.

The `change` and `applyChanges` functions (in `src/facade.ts`) established the pattern: thin, typed, error-guarded functions that discover capabilities via symbols on refs. `subscribe` and `subscribeTree` complete the facade triad.

## Problem Statement

Application code that wants to observe changes on a `@kyneta/schema` ref must import `CHANGEFEED`, know about `Changeset`, and navigate the symbol protocol directly. There is no library-level function for subscription — the simplest user-facing operation after read and write.

## Success Criteria

1. `subscribe(ref, cb)` and `subscribeTree(ref, cb)` are exported from `@kyneta/schema`.
2. Both return `() => void` (unsubscribe function).
3. `subscribe` receives `Changeset` (preserving batch semantics and `origin`).
4. `subscribeTree` receives `Changeset<TreeEvent>` (preserving relative paths).
5. Both throw a clear error when the ref lacks `[CHANGEFEED]`.
6. `subscribeTree` throws a clear error when the ref has a leaf changefeed (no `subscribeTree` method).
7. The `example/main.ts` local `subscribe` function is replaced by the library-level import (when the example is updated — not in this plan's scope).
8. `@kyneta/core/runtime/subscribe.ts` is unaffected — it wraps the protocol for different reasons (scope lifecycle, unwrapping to individual changes).
9. Existing tests that access `[CHANGEFEED]` directly are left unchanged — they test the protocol, not the facade.
10. TECHNICAL.md documents the new functions in the Facade section.

## The Gap

### No library-level subscribe

`src/facade.ts` exports `change` and `applyChanges` but no subscribe. The three symmetric operations on a document are: mutate (`change`), apply (`applyChanges`), and observe (`subscribe`). Observe is missing.

### `subscribeTree` requires `!` assertion and symbol knowledge

Even in the example, tree subscription looks like:

```ts
doc.settings[CHANGEFEED].subscribeTree!((changeset) => { ... })
```

The `!` is needed because `Changefeed` doesn't have `subscribeTree` — only `ComposedChangefeed` does. The library function can use `hasComposedChangefeed` to do this check and throw a clear error.

### Callback type is the `Changeset` protocol, not unwrapped changes

The library-level `subscribe` should preserve `Changeset` as the callback type. This is the uniform delivery unit — auto-commit delivers a degenerate changeset of one, transactions and `applyChanges` deliver multi-change batches. Unwrapping to individual changes loses batch boundaries and `origin`, which are core to the protocol.

This is a deliberate design choice: `@kyneta/core`'s runtime subscribe unwraps because compiled code processes changes individually. The schema-level subscribe preserves the protocol because library users need batch boundaries for round-trip workflows (`subscribeTree` output → `applyChanges` input).

## Phases

### Phase 1: Implement `subscribe` and `subscribeTree` in `src/facade.ts` 🔴

- Task: Add `subscribe(ref, callback)` function. 🔴
  - Guard: `hasChangefeed(ref)` → throw if false.
  - Delegate to `ref[CHANGEFEED].subscribe(callback)`.
  - Return the unsubscribe function.
- Task: Add `subscribeTree(ref, callback)` function. 🔴
  - Guard: `hasChangefeed(ref)` → throw if false.
  - Guard: `hasComposedChangefeed(ref)` → throw if false (leaf ref, no tree).
  - Delegate to `ref[CHANGEFEED].subscribeTree(callback)`.
  - Return the unsubscribe function.
- Task: Export both from `src/index.ts`. 🔴

Function signatures:

```ts
export function subscribe(
  ref: unknown,
  callback: (changeset: Changeset) => void,
): () => void

export function subscribeTree(
  ref: unknown,
  callback: (changeset: Changeset<TreeEvent>) => void,
): () => void
```

### Phase 2: Tests 🔴

- Task: Add tests for `subscribe` in `facade.test.ts`. 🔴
  - `subscribe(leaf, cb)` fires on mutation with correct `Changeset`.
  - `subscribe(composite, cb)` fires on node-level change only (not child mutations).
  - Unsubscribe stops delivery.
  - Throws on non-changefeed ref.
- Task: Add tests for `subscribeTree` in `facade.test.ts`. 🔴
  - `subscribeTree(composite, cb)` fires on child mutation with relative path.
  - `subscribeTree(composite, cb)` fires on own-path change with `path: []`.
  - Unsubscribe stops delivery.
  - Throws on non-changefeed ref.
  - Throws on leaf ref (no `subscribeTree`).
- Task: Add integration test: `subscribe` + `change` + `applyChanges` round-trip. 🔴
  - `subscribeTree` on docA captures events → reconstruct `PendingChange[]` → `applyChanges` on docB → docs match. This test already exists using raw `getChangefeed`; the new test uses the library functions only.

Re-use the existing `facade.test.ts` fixtures (`createChatDoc`, `chatDocSchema`, etc.). Do not refactor existing tests that use `getChangefeed` — those test the protocol layer and should remain as-is.

### Phase 3: Documentation 🔴

- Task: Update TECHNICAL.md §Facade to document `subscribe` and `subscribeTree` alongside `change` and `applyChanges`. 🔴
- Task: Add Verified Properties #30 and #31 for subscribe/subscribeTree invariants. 🔴
- Task: Update File Map description for `facade.ts` (now includes subscribe functions). 🔴

## Tests

### `subscribe`: basic behavior

- Leaf ref fires on mutation: `subscribe(doc.settings.darkMode, cb)` → `doc.settings.darkMode.set(true)` → callback receives `Changeset` with one `ReplaceChange`.
- Composite ref fires on node-level only: `subscribe(doc.settings, cb)` → mutate `doc.settings.darkMode` → 0 notifications; `doc.settings.set({...})` → 1 notification.
- Unsubscribe: call the returned function, mutate, assert no callback.
- Error: `subscribe({}, cb)` throws about `[CHANGEFEED]`.

### `subscribeTree`: basic behavior

- Product tree: `subscribeTree(doc.settings, cb)` → mutate `doc.settings.darkMode` → callback receives `Changeset<TreeEvent>` with `path: [{type:"key", key:"darkMode"}]`.
- Own-path: `subscribeTree(doc.settings, cb)` → `doc.settings.set({...})` → `path: []`.
- Unsubscribe stops delivery.
- Error (no changefeed): `subscribeTree({}, cb)` throws.
- Error (leaf): `subscribeTree(doc.settings.darkMode, cb)` throws about composite ref requirement.

### Integration: library-only round-trip

- Use `change`, `subscribeTree`, and `applyChanges` — no `CHANGEFEED` symbol, no `getChangefeed`. This is the intended DX proof-point.

## Transitive Effect Analysis

| Change | Affected | Impact |
|---|---|---|
| New exports from `src/facade.ts` | `src/index.ts` | Two new function exports, no breaking changes |
| New exports from `src/index.ts` | Downstream consumers (`@kyneta/core`, `example/main.ts`) | Additive only — no existing export changes |
| `@kyneta/core/runtime/subscribe.ts` | None | Completely independent — uses raw `[CHANGEFEED]` protocol for scope-bound subscriptions. No refactor needed or desired. |
| `example/main.ts` local `subscribe` | Not in this plan's scope | Will be replaced when the example is rewritten (separate plan). Already uses a compatible pattern. |
| Existing tests using `getChangefeed` | None | Tests that access `[CHANGEFEED]` directly are testing the protocol layer, not the facade. They remain as-is. |
| `changefeed.ts` types (`Changeset`, `TreeEvent`, `Changefeed`, `ComposedChangefeed`) | None | Already exported. The facade functions import them but don't modify them. |
| Type guards (`hasChangefeed`, `hasComposedChangefeed`) | None | Already exported and used. The facade functions call them. |

## Resources for Implementation Context

- `src/facade.ts` — where `subscribe` and `subscribeTree` will be added. Read `change` and `applyChanges` for the established pattern (symbol discovery, error guard, delegation).
- `src/changefeed.ts` — `CHANGEFEED`, `Changeset`, `TreeEvent`, `Changefeed`, `ComposedChangefeed`, `hasChangefeed`, `hasComposedChangefeed`.
- `src/index.ts` — barrel exports. Add new exports here.
- `src/__tests__/facade.test.ts` — existing tests and fixtures. Add new `describe` blocks here.
- `TECHNICAL.md` §Facade (L391–400) — document the new functions.
- `TECHNICAL.md` §Verified Properties (L486–520) — add new properties.
- `packages/core/src/runtime/subscribe.ts` — the runtime subscribe for reference. Do NOT modify.

## PR Stack

### PR 1 — feat: library-level `subscribe` and `subscribeTree` 🔴

**Phases 1 + 2 + 3. Type: feature (implementation + tests + docs in one PR).**

- Add `subscribe(ref, cb)` and `subscribeTree(ref, cb)` to `src/facade.ts`
- Export from `src/index.ts`
- Tests in `facade.test.ts` (~11 cases: basic behavior, error paths, integration round-trip)
- Update TECHNICAL.md §Facade, Verified Properties, File Map

**Why a single PR:** The implementation is ~30 lines, tests ~80 lines, docs a few paragraphs. Splitting implementation from tests creates an untested intermediate state. Splitting docs from implementation creates an artificially tiny follow-up. A reviewer sees one logical unit: "add the observe leg of the change/apply/observe triad." The PR is small enough to review in one pass (~200 lines total diff), safe to revert as a unit, and every intermediate commit within the PR builds and passes tests.

**Commit structure within the PR:**

1. `feat: add subscribe and subscribeTree to facade` — implementation + exports + tests
2. `docs: document subscribe/subscribeTree in TECHNICAL.md` — Verified Properties, Facade section, File Map

Reviewer sees: the implementation and tests prove correctness (commit 1), then the docs update the architectural record (commit 2). The reviewer can verify the functions follow the established `change`/`applyChanges` pattern — symbol discovery, error guard, delegation — and that the tests cover the same categories (basic behavior, error paths, integration round-trip).

### Risk profile

**Low risk.** Purely additive — no existing exports change, no existing tests change, no downstream code is modified. The functions are thin wrappers over an already-tested protocol. The only failure mode is a bad error message or a missing re-export, both caught by the new tests.

## Alternatives Considered

### Unwrap `Changeset` to individual `ChangeBase` in the callback

The `@kyneta/core` runtime does this because compiled code processes changes individually. However, at the schema level, `Changeset` is the protocol's unit of delivery. Unwrapping loses:
- Batch boundaries (was this 1 change or 5?)
- `origin` provenance (was this from sync, undo, or local?)
- The ability to round-trip `subscribeTree` output → `applyChanges` input

Preserving `Changeset` is the right default for library consumers.

### Single `subscribe` with an options bag for tree mode

```ts
subscribe(ref, cb, { tree: true })
```

Rejected: `subscribe` and `subscribeTree` have different callback types (`Changeset` vs `Changeset<TreeEvent>`). An options bag would require overloads that hurt type inference, or a union callback type that forces runtime narrowing. Two functions is cleaner and mirrors the protocol's own two-method design.

### Add `subscribe` as a method on refs instead of a standalone function

Rejected: this would require modifying every interpreter layer that builds refs. The facade pattern (standalone function that discovers capabilities via symbols) is established, non-invasive, and works with any ref — including custom reactive types that implement `[CHANGEFEED]`.

### Place in a new `src/subscribe.ts` module

Rejected: the facade module (`src/facade.ts`) already houses `change` and `applyChanges`. Subscription completes the same triad. A separate file would fragment the public API surface for no benefit.