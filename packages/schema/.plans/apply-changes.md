# Apply Changes — Declarative Change Application

## Background

The interpreter stack provides two mechanisms for mutating document state:

1. **Mutation methods** on refs (`.set()`, `.push()`, `.update()`, `.increment()`, etc.) — imperative, ref-scoped, triggered by user interaction.
2. **`change(doc, fn)`** — the facade's transaction wrapper that batches imperative mutations, commits atomically, and returns `PendingChange[]` via `ctx.commit()`.

Both paths execute the invalidate-before-dispatch protocol: `ref[INVALIDATE](change)` clears/shifts caches, then `ctx.dispatch(path, change)` mutates the store and fires changefeed subscribers. This ensures caches are consistent when subscribers observe the new state.

However, there is no mechanism for **declarative** change application — applying a list of `{path, change}` pairs that arrived as data (not as method calls). This is the dual of `change`: instead of "do these mutations," it's "these mutations happened."

The `step` functions (`step.ts`) are the mathematical core: `(State, Change) → State`. `applyChangeToStore` composes `step` with `readByPath`/`writeByPath` for path-scoped store mutation. `ctx.dispatch` wraps `applyChangeToStore` with changefeed notification (via `withChangefeed`'s dispatch wrapper). But calling `ctx.dispatch` directly from outside the interpreter stack bypasses `[INVALIDATE]`, leaving caches stale.

The `ChangeBase` type has an `origin?: string` field (defined in `change.ts` L30–34) for provenance tagging. The `@kyneta/core` runtime's `inputTextRegion` branches on `change.origin` for cursor management (local → move to end, remote → preserve position). This field is currently unused by the schema layer.

### The Changeset discovery

During plan review, we identified a fundamental problem with the current notification model: `commit()` replays buffered changes through `ctx.dispatch` one at a time, firing subscribers after each individual change. Subscribers during a batched commit see **partially applied** state — after change 1, the subscriber fires but changes 2 and 3 haven't been applied yet.

This matters concretely: when a sync payload delivers 3 new recipes, the frontend subscriber fires 3 times, each time navigating the DOM to find the insertion point. It should fire once, find the insertion point once, and append all 3 nodes together.

The root cause is that the Changefeed — the core Moore machine coalgebra — emits individual transitions `(change: C) => void`. The fix is to make the transition stream emit **batches**: `(changeset: Changeset<C>) => void`. This is a protocol-level change to the reactive primitive itself.

Additionally, provenance (`origin`) belongs to the **batch**, not to individual changes. "These 3 inserts came from sync" is a statement about the batch, not about each insert independently. This motivates a first-class `Changeset` type that carries batch-level metadata alongside the array of changes.

The plan also identified a naming collision: `TreeEvent.origin` means "path from subscription point" while `ChangeBase.origin` means "provenance." Introducing `Changeset` with its own `origin` for provenance makes this collision untenable. `TreeEvent.origin` is renamed to `TreeEvent.path`.

### The phase-separation discovery

For batched notification to work, the dispatch pipeline must separate **preparation** (cache invalidation + store mutation) from **notification** (firing subscribers). Today these are fused in a single `dispatch` call — each wrapper runs both concerns per-change. The fix factors dispatch into two phases: `prepare` (invalidate + mutate, per-change) and `flush` (notify, once per batch).

## Problem Statement

A developer receiving changes from an external source (sync, undo/redo, replay, import) has a list of `PendingChange[]` — the same type that `ctx.commit()` returns — and needs to apply them to a document with the full effect pipeline: store mutation, cache invalidation, and changefeed notification. No public API exists for this. The only workarounds involve reaching into `doc[TRANSACT]` internals, and even then, `[INVALIDATE]` is bypassed because it's wired to individual refs, not to the dispatch pipeline.

Furthermore, the existing transaction mechanism has a correctness issue: `commit()` replays changes sequentially through the full dispatch pipeline, causing subscribers to fire between individual changes. Subscribers observe partially-applied batch state.

## Success Criteria

1. A public `applyChanges(ref, ops)` function that applies `PendingChange[]` to a document atomically, with store mutation + cache invalidation + changefeed notification.
2. The function accepts any ref with `[TRANSACT]` as the first argument (same as `change`).
3. Subscribers receive exactly **one `Changeset`** per `applyChanges` call (or per `change` call), containing all changes in the batch. Subscribers never see partially-applied state.
4. An optional `origin` tag on the `Changeset` flows through to subscribers as batch-level provenance.
5. The function returns the applied `PendingChange[]` for logging/chaining.
6. `change` and `applyChanges` are symmetric duals: `change` is imperative (callback on refs), `applyChanges` is declarative (change data). Both are atomic, both work with any ref, both produce `PendingChange[]`.
7. `change` returns `PendingChange[]` (currently the facade returns the doc; the library-level function should return the ops for round-trip use).
8. Cache invalidation is **surgical** — only caches at affected paths are invalidated, not the entire tree. Incrementing a counter does not blow away unrelated product field caches.
9. Auto-commit (single mutation outside a transaction) wraps the change in a degenerate `Changeset` of one — the subscriber API is uniform regardless of batch size.

## The Gap

| What exists | What's missing |
|---|---|
| `change(doc, fn)` — imperative, atomic, full pipeline | No declarative counterpart |
| `ctx.dispatch(path, change)` — store + notify | No `[INVALIDATE]` call — caches go stale |
| `applyChangeToStore(store, path, change)` — store only | No notify, no invalidate |
| `ctx.commit()` returns `PendingChange[]` | `change` facade discards it, returns doc |
| `ctx.commit()` replays one-at-a-time | Subscribers see partially-applied batch state |
| `ChangeBase.origin?: string` | Provenance belongs to the batch, not individual changes |
| `Changefeed.subscribe(cb: (change) => void)` | Emits individual transitions, no batch delivery |
| `TreeEvent.origin` (means "path") | Name collides with provenance `origin` |
| `[INVALIDATE]` on refs — called by mutation methods | Wired to individual refs, not to the dispatch pipeline |
| `withChangefeed` wraps `ctx.dispatch` for notification | `withCaching` does not wrap `ctx.dispatch` for invalidation |
| `pathKey` in `with-changefeed.ts` (private) | Needed by `withCaching` too; should be shared |

### The `[INVALIDATE]` problem — and the real fix

Today, cache invalidation is an **informal protocol**: mutation methods in `withWritable` call `ref[INVALIDATE](change)` before `ctx.dispatch(path, change)`. This works for imperative mutation (the ref knows its own cache), but fails for declarative application (we have raw `{path, change}` pairs, not refs).

The root cause is that `[INVALIDATE]` lives on the ref rather than in the dispatch pipeline. `withChangefeed` already solved the analogous problem for notifications — it wraps `ctx.dispatch` so that every dispatch (from any source) fires subscribers. `withCaching` should do the same for invalidation.

The fix: **move `[INVALIDATE]` into the dispatch pipeline** by having `withCaching` register path-keyed invalidation handlers that fire during the `prepare` phase. Each node's invalidation handler is registered by path at interpretation time. The prepare phase looks up the handler by path and calls it before store mutation.

### The `Changeset` protocol — batched notification

The `Changefeed` coalgebra currently emits individual transitions: `subscribe(cb: (change: C) => void)`. This forces subscribers into per-change reactions, preventing amortization across batches.

The fix: introduce `Changeset<C>` as the unit of delivery. The Changefeed emits changesets: `subscribe(cb: (changeset: Changeset<C>) => void)`. A changeset carries batch-level metadata (`origin`) and an array of changes. Auto-commit wraps a single change in a degenerate changeset of one.

This also resolves the provenance placement: `origin` migrates from `ChangeBase` to `Changeset`. Individual changes don't carry provenance — the batch does.

### Phase-separated dispatch

Today's dispatch pipeline fuses three concerns into one call chain per-change:

```
ctx.dispatch(path, change)
  → withChangefeed: forward, then notify (per-change)
    → withCaching: invalidate, then forward (would be added)
      → original: applyChangeToStore
```

For batched notification, the pipeline must separate preparation from notification:

```
prepare(path, change)   — per-change, called N times
  → withCaching: invalidate cache at path
  → original: applyChangeToStore(store, path, change)

flush()                 — once per batch, after all prepares
  → withChangefeed: deliver accumulated Changeset to subscribers
```

The `WritableContext` gains `prepare`/`flush` semantics. Auto-commit calls `prepare` then `flush` immediately. Transactions call `prepare` N times during commit, then `flush` once.

Ordering: **invalidate → store mutation → (all changes applied) → notification**. This matches today's per-change ordering (invalidate before store, store before notify) while adding the batch boundary between store mutation and notification.

### Shared `pathKey` utility

Both `withChangefeed` and `withCaching` need to convert a `Path` to a stable string key for their handler maps. Today `pathKey` is private to `with-changefeed.ts`. It should be extracted to a shared location (`src/path-utils.ts` or `src/store.ts`) so both modules can import it.

## Phases

### Phase 1: Extract `pathKey` to shared utility 🟢

The `pathKey(path: Path) → string` function converts a `Path` to a stable `\0`-delimited string for use as a `Map` key. Currently private in `with-changefeed.ts`. Extract to a shared module so both `withChangefeed` and `withCaching` can import it.

- Task: Create `src/path-utils.ts` (or add to `src/store.ts`) with the `pathKey` function. 🟢 Added to `src/store.ts` (Path helpers section).
- Task: Export `pathKey` from `src/index.ts`. 🟢
- Task: Update `with-changefeed.ts` to import `pathKey` from the shared module instead of defining it locally. 🟢
- Task: Verify all existing tests pass (pure refactor, no behavior change). 🟢 775/775 pass.

### Phase 2: `Changeset` type and `TreeEvent.path` rename 🔴

> **Breaking change coordination.** This phase changes the `Changefeed` coalgebra's subscriber signature from `(change: C) => void` to `(changeset: Changeset<C>) => void`. The `@kyneta/core` compiler's `getDeltaKind` extracts the change type from this signature via a multi-hop TypeScript type walk. The new `Changeset<C>` wrapper adds an indirection layer that will break the compiler's type extraction. This must be verified and fixed as part of this phase.

Define `Changeset<C>` as the unit of batch delivery. Rename `TreeEvent.origin` → `TreeEvent.path` to resolve the naming collision with provenance. Remove `origin` from `ChangeBase` — provenance migrates to `Changeset`.

#### `Changeset` type

```ts
interface Changeset<C extends ChangeBase = ChangeBase> {
  /** The individual changes in this batch. */
  readonly changes: readonly C[]
  /** Provenance of the batch (e.g. "sync", "undo", "local"). */
  readonly origin?: string
}
```

#### `TreeEvent` rename

```ts
interface TreeEvent<C extends ChangeBase = ChangeBase> {
  /** Relative path from subscription point to where the change occurred. */
  readonly path: Path
  /** The change that occurred. */
  readonly change: C
}
```

#### `Changefeed` protocol change

```ts
interface Changefeed<S, C extends ChangeBase = ChangeBase> {
  readonly current: S
  subscribe(callback: (changeset: Changeset<C>) => void): () => void
}

interface ComposedChangefeed<S, C extends ChangeBase = ChangeBase>
  extends Changefeed<S, C> {
  subscribeTree(callback: (changeset: Changeset<TreeEvent<C>>) => void): () => void
}
```

- Task: Define `Changeset` in `src/changeset.ts` (or extend `src/changefeed.ts`). 🔴
- Task: Remove `origin?: string` from `ChangeBase` in `src/change.ts`. 🔴
- Task: Rename `TreeEvent.origin` to `TreeEvent.path` in `src/changefeed.ts`. 🔴
- Task: Update `Changefeed.subscribe` signature to receive `Changeset<C>`. 🔴
- Task: Update `ComposedChangefeed.subscribeTree` signature to receive `Changeset<TreeEvent<C>>`. 🔴
- Task: Export `Changeset` from `src/index.ts`. 🔴
- Task: Update all existing subscribers in tests and example code to use the new signatures. 🔴
- Task: Update `@kyneta/core`'s `inputTextRegion` — it currently reads `change.origin`; it must read `changeset.origin` instead, with inner iteration over `changeset.changes`. Flag this as a downstream breaking change. 🔴
- Task: Verify and update `@kyneta/core`'s compiler `getDeltaKind` type extraction — it walks the `subscribe` callback signature to extract the change type. The new `Changeset<C>` wrapper adds an indirection that changes what the compiler sees. 🔴
- Task: Update mock infrastructure in `packages/core/src/compiler/integration/helpers.ts` — mocks that stamp `origin: "local"` onto change objects must instead wrap changes in `Changeset` with `origin: "local"`. 🔴
- Task: Verify all existing tests pass after the type migration. 🔴

**Note:** This phase changes the types but does not yet implement batched delivery. `withChangefeed` temporarily wraps each individual notification in a degenerate `Changeset` of one to satisfy the new signature. The actual batched delivery comes in Phase 3.

### Phase 3: Phase-separated dispatch and batched notification 🔴

Replace the monolithic `dispatch` with a two-phase `prepare`/`flush` model. This is the mechanism that enables batched changefeed notification and correct cache invalidation for both imperative and declarative paths.

#### `WritableContext` changes

```ts
interface WritableContext extends RefContext {
  /** Apply a change: invalidate caches + mutate store. No notification. */
  readonly prepare: (path: Path, change: ChangeBase) => void
  /** Deliver accumulated notifications as a single Changeset per subscriber. */
  readonly flush: (origin?: string) => void
  /** Convenience: prepare + flush for a single change (auto-commit). */
  readonly dispatch: (path: Path, change: ChangeBase) => void
  beginTransaction(): void
  commit(origin?: string): PendingChange[]
  abort(): void
  readonly inTransaction: boolean
}
```

`prepare` always does real work — invalidate caches, mutate store, accumulate notification entries. It has no awareness of transactions and **must not be called during an active transaction** (the store would mutate while the transaction expects it unchanged).

`flush` always does real work — drain the changefeed accumulator and deliver `Changeset` to subscribers. It also has no awareness of transactions.

`executeBatch` is the single primitive that composes `prepare` and `flush`:

```ts
function executeBatch(
  ctx: WritableContext,
  changes: readonly PendingChange[],
  origin?: string,
): void {
  for (const { path, change } of changes) {
    ctx.prepare(path, change)
  }
  ctx.flush(origin)
}
```

All three entry points collapse to one-liners:

- **`dispatch(path, change)`** = `executeBatch(ctx, [{ path, change }])` — auto-commit convenience.
- **`commit(origin?)`** = copy pending, clear buffer, set `inTransaction = false`, `executeBatch(ctx, flushed, origin)` — transaction commit.
- **`applyChanges(ref, ops, options?)`** = `executeBatch(ctx, ops, options?.origin)` — declarative application.

`dispatch` is transaction-aware:

- **Outside a transaction (auto-commit):** calls `executeBatch` with one change. The subscriber receives a degenerate `Changeset` of one change.
- **During a transaction:** buffers the `{path, change}` pair. Does NOT call `prepare`, `flush`, or `executeBatch`. The store is unchanged; caches are unchanged; subscribers are silent.

`commit(origin?)` ends the transaction and does the real work via `executeBatch`.

This is clean: `prepare`, `flush`, and `executeBatch` are stateless with respect to transactions. Transaction buffering lives solely in `dispatch` and `commit`. The phase separation (prepare N times, flush once) is enforced by `executeBatch`, not by conditionals inside `prepare` or `flush`.

**Invariant:** `prepare` and `flush` must never be called while `ctx.inTransaction` is true. `executeBatch` should guard against this (throw if `inTransaction`). This prevents `applyChanges` from corrupting a half-built transaction.

#### `withChangefeed` changes

The changefeed layer wraps both `prepare` and `flush`, following the Functional Core / Imperative Shell pattern established by `planCacheUpdate`/`applyCacheOps` in `withCaching`:

**Functional Core** — pure, testable:

```ts
interface NotificationPlan {
  /** Per-path shallow changes to deliver. Map key is pathKey. */
  readonly shallow: ReadonlyMap<string, readonly ChangeBase[]>
  /** Tree events accumulated for composite subscribers. */
  readonly tree: readonly TreeEvent[]
}

/** Given accumulated pending changes, plan the notifications to deliver. */
function planNotifications(
  pending: readonly { path: Path; change: ChangeBase }[],
  listenerPaths: ReadonlySet<string>,
): NotificationPlan
```

`planNotifications` groups changes by `pathKey`, filters to paths that have listeners, and builds `TreeEvent` entries. No mutation — returns fresh data. This is table-testable: "given 3 changes at 2 paths, the plan produces 2 shallow entries."

**Imperative Shell** — trivial delivery:

```ts
/** Build and deliver Changesets from a notification plan. */
function deliverNotifications(
  plan: NotificationPlan,
  listeners: Map<string, Set<callback>>,
  origin?: string,
): void
```

The `prepare` and `flush` hooks use this split:

- **`prepare` wrapping**: after the inner `prepare` (cache invalidation + store mutation), records the `{path, change}` in a pending accumulator (per-path). Does NOT fire subscribers. This is the only stateful part — the accumulator is a simple array append.
- **`flush` wrapping**: calls `planNotifications` on the accumulated entries (pure), then `deliverNotifications` (imperative). Clears the accumulator.

For `subscribeTree`, the flush delivers one `Changeset<TreeEvent>` containing all accumulated tree events.

The `inTransaction` guard in the current changefeed wrapper is no longer needed — the phase separation inherently solves this. `prepare` accumulates but never notifies; `flush` delivers. During a transaction, neither is called (dispatch buffers instead). At commit time, `executeBatch` calls `prepare` N times (accumulating), then `flush` once (delivering).

- Task: Add `prepare` and `flush` to `WritableContext` interface and `createWritableContext`. 🔴
- Task: Implement `executeBatch(ctx, changes, origin?)` as the single primitive composing `prepare` × N + `flush`. Add a guard: throw if `ctx.inTransaction` is true. 🔴
- Task: Redefine `dispatch` as `executeBatch(ctx, [{path, change}])` outside a transaction, or buffer during a transaction. 🔴
- Task: Update `commit()` to copy+clear pending buffer, set `inTransaction = false`, then call `executeBatch(ctx, flushed, origin)`. 🔴
- Task: Remove the `replaying` flag from `createWritableContext` — it is no longer needed since `commit` calls `executeBatch` (not `dispatch`). 🔴
- Task: Implement `planNotifications` (Functional Core) — pure function that groups accumulated `{path, change}` pairs by pathKey and builds `TreeEvent` entries. 🔴
- Task: Implement `deliverNotifications` (Imperative Shell) — builds `Changeset` objects from the plan and fires subscriber callbacks. 🔴
- Task: Update `withChangefeed`'s dispatch wrapping: `prepare` hook accumulates `{path, change}` pairs; `flush` hook calls `planNotifications` then `deliverNotifications`. 🔴
- Task: The `flush` hook accepts an optional `origin` parameter, attached to the emitted `Changeset`. 🔴
- Task: Update all changefeed factories (`createLeafChangefeed`, `createProductChangefeed`, `createSequenceChangefeed`, `createMapChangefeed`) for the new accumulation/delivery model. 🔴
- Task: Verify all existing tests pass — behavior is now truly atomic (one notification per batch). Update test assertions that assumed per-change notification counts during commit. 🔴

**Key design constraint:** Auto-commit (`dispatch`) must produce a `Changeset` of exactly one change. The subscriber API is uniform — it always receives a `Changeset`, whether from a single mutation or a batched transaction.

### Phase 4: Move `[INVALIDATE]` into `prepare` pipeline AND remove from `withWritable` (atomic) 🔴

> **Why atomic:** Phases 4 and 5 from the original plan are merged. The sequence `applyCacheOps` performs non-idempotent `shift` operations — if both the pipeline and mutation methods fire `INVALIDATE` for the same sequence change, the cache is double-shifted and corrupted. Product `clear` and map `delete` are idempotent, but sequence `shift` is not. The only safe approach is to add pipeline invalidation and remove mutation-method invalidation in a single atomic step.

Have `withCaching` hook into the `prepare` phase using a path-keyed invalidation handler map. Each composite node (product, sequence, map) registers its invalidation handler by path during interpretation. The `prepare` wrapper looks up the handler and calls it before store mutation. Simultaneously, remove the `if (INVALIDATE in result) result[INVALIDATE](change)` guards from `withWritable` mutation methods.

This uses the same structural pattern as `withChangefeed` — a `WeakMap<WritableContext, State>` + idempotent wrapping + path-keyed handler map — but hooks into `prepare` rather than `flush`.

- Task: Add `ensureCacheWiring(ctx)` to `with-caching.ts` — idempotent `prepare` wrapping, returns a `Map<string, (change: ChangeBase) => void>` (the invalidation handler map). Uses `pathKey` from the shared module. 🔴
- Task: In each composite case (product, sequence, map), register the existing `[INVALIDATE]` handler in the invalidation map via `ensureCacheWiring(ctx)`. The handler logic (field state clear, `planCacheUpdate` + `applyCacheOps`) is unchanged — it just lives in the prepare pipeline now instead of on the ref. 🔴
- Task: **In the same commit**, remove the ~9 `if (INVALIDATE in result) result[INVALIDATE](change)` lines from `withWritable` mutation methods (scalar `.set()`, product `.set()`, sequence `.push()`, `.insert()`, `.delete()`, map `.set()`, `.delete()`, `.clear()`). Each method simplifies to: construct the change, `ctx.dispatch(path, change)`. 🔴
- Task: Remove the now-unused `INVALIDATE` import from `writable.ts`. Update the ~4 stale comments in `writable.ts` that reference invalidate-before-dispatch. 🔴
- Task: Update the `withWritable` header comment and `TECHNICAL.md` §withWritable to document that mutation methods no longer call `[INVALIDATE]` directly — the pipeline handles it. 🔴
- Task: Verify all existing tests pass. 🔴

The `prepare` pipeline after this phase:

```
ctx.prepare(path, change)
  → withCaching's hook: invalidate cache at path
  → withChangefeed's hook: accumulate notification entry
  → original: applyChangeToStore(store, path, change)
```

Note: `[INVALIDATE]` **remains on refs** as a public symbol. It's still part of the `HasCaching` interface and can be called directly for advanced use cases. What changes is that `withWritable` no longer needs to call it — `prepare` does.

### Phase 5: Library-level `change` and `applyChanges` 🔴

Implement `applyChanges` as a public function in `@kyneta/schema`. Also implement a library-level `change` that returns `PendingChange[]` instead of the doc, making the two functions symmetric duals that produce/consume the same currency.

Both functions live in a new module `src/facade.ts`. The example facade functions (`createDoc`, `change`, `subscribe`) remain in `example/main.ts` as teaching code; the library functions are the production versions.

- Task: Create `src/facade.ts` with `change` and `applyChanges` implementations. 🔴
- Task: Export `change`, `applyChanges`, and `ApplyChangesOptions` from `src/index.ts`. 🔴

#### `change` signature

```ts
function change<D extends object>(
  ref: D,
  fn: (draft: D) => void,
): PendingChange[]
```

#### `applyChanges` signature

```ts
interface ApplyChangesOptions {
  /** Provenance tag attached to the emitted Changeset (e.g. "sync", "undo"). */
  origin?: string
}

function applyChanges(
  ref: object,
  ops: ReadonlyArray<PendingChange>,
  options?: ApplyChangesOptions,
): PendingChange[]
```

#### Implementation of `applyChanges`

1. Guard: `hasTransact(ref)` — throw if not a transactable ref.
2. Extract `ctx: WritableContext` from `ref[TRANSACT]`.
3. Call `executeBatch(ctx, ops, options?.origin)` — which calls `prepare` N times (invalidate + store mutate + accumulate), then `flush(origin)` once (deliver Changeset to subscribers). `executeBatch` throws if `ctx.inTransaction` is true.
4. Return the ops.

Note: `applyChanges` uses `executeBatch`, not `beginTransaction`/`commit`. The transaction API is for imperative mutation (buffering `dispatch` calls); `applyChanges` already has the full list of changes and can call `prepare` in a loop without buffering. Calling `applyChanges` during an active transaction throws — the developer must commit or abort the transaction first.

No special invalidation logic needed — the `prepare` pipeline (from Phase 4) handles it for every change.

#### Implementation of `change`

Same as the example facade but returns `PendingChange[]` from `ctx.commit()` instead of the doc.

### Phase 6: Tests 🔴

- Task: Test that `applyChanges` applies changes to the store correctly (text, sequence, replace, increment). 🔴
- Task: Test that `applyChanges` fires changefeed subscribers exactly **once** with a `Changeset` containing all changes (not once per change). 🔴
- Task: Test that subscribers see fully-applied state when the `Changeset` arrives — no partially-applied intermediate states. 🔴
- Task: Test that `applyChanges` with `origin` option produces a `Changeset` with `changeset.origin === "sync"`. 🔴
- Task: Test round-trip: `change(docA, fn)` → ops → `applyChanges(docB, ops)` → `docB()` matches `docA()`. 🔴
- Task: Test that caches are surgically invalidated: after `applyChanges` modifies `doc.settings.darkMode`, `doc.settings.darkMode()` returns the new value, but `doc.messages.at(0)` still returns the same cached ref (not blown away). 🔴
- Task: Test that `change` returns `PendingChange[]` with correct paths and change types. 🔴
- Task: Test error handling: `applyChanges` on a non-transactable ref throws. 🔴
- Task: Test that `applyChanges(doc, [])` is a no-op (returns empty array, no subscribers fire). 🔴
- Task: Test auto-commit: a single mutation outside a transaction delivers a `Changeset` with exactly one change. 🔴
- Task: Test `subscribeTree` receives one `Changeset<TreeEvent>` per batch, with `TreeEvent.path` (not `.origin`) for relative paths. 🔴
- Task: Test cache invalidation via prepare pipeline (Phase 4 verification): directly call `ctx.prepare(path, change)` + `ctx.flush()` on a cached document. Assert the cache at that path is invalidated and subsequent reads return the new value. 🔴
- Task: Test `applyChanges` during active transaction throws. 🔴
- Task: Test `planNotifications` (Functional Core unit tests): given 3 changes at 2 paths, assert the plan groups them correctly into 2 shallow entries. Given a sequence of changes, assert `TreeEvent` entries have correct relative paths. 🔴
- Task: Test `Changeset<TreeEvent>` ≅ `(PendingChange[], origin)` round-trip: the output of `subscribeTree` on docA can be used to reconstruct `PendingChange[]` input for `applyChanges` on docB (modulo absolute vs. relative paths). 🔴

### Phase 7: Documentation 🔴

- Task: Update `TECHNICAL.md` §Changefeed to document the `Changeset` protocol — batched delivery, `origin` provenance, uniform API for single and batched mutations. 🔴
- Task: Update `TECHNICAL.md` §Changefeed to document the `TreeEvent.path` rename (from `.origin`). 🔴
- Task: Update `TECHNICAL.md` §withCaching to document the prepare-pipeline invalidation (prepare wrapping, path-keyed handler map, ordering guarantee). 🔴
- Task: Update `TECHNICAL.md` §withWritable to document that mutation methods no longer call `[INVALIDATE]` directly. 🔴
- Task: Update `TECHNICAL.md` §WritableContext to document the `prepare`/`flush` phase separation, and `applyChanges` as the declarative dual of `change`. 🔴
- Task: Update `TECHNICAL.md` §Changefeed Decorator to remove stale `enrich` references — `withChangefeed` is now a proper interpreter transformer, not a decorator via `enrich`. 🔴
- Task: Add to the Verified Properties section: "Batched notification: subscribers receive exactly one `Changeset` per transaction, never partially-applied state" and "Declarative change application round-trips with `change`" and "Prepare-pipeline invalidation: `ctx.prepare` triggers surgical cache invalidation at the target path." 🔴
- Task: Update Verified Property #7 — `commit()` no longer replays through `ctx.dispatch`; it calls `executeBatch` which calls `prepare` N times + `flush` once. 🔴
- Task: Document the `executeBatch` primitive and the invariant that `prepare`/`flush`/`executeBatch` must not be called during an active transaction. 🔴
- Task: Document the `Changeset<TreeEvent>` ≅ `(PendingChange[], origin)` isomorphism (up to path relativity) — this is a powerful property for sync use cases where the output of a tree subscription can be round-tripped as input to `applyChanges`. 🔴
- Task: Update the recipe-book plan's Phase 1 to reference the library-level `applyChanges` instead of a custom `applyDelta` implementation. 🔴

## Tests

### Round-trip (the primary correctness test)

Create two documents from the same seed. Mutate docA via `change()`, capture the returned ops. Apply ops to docB via `applyChanges()`. Assert `docA()` deep-equals `docB()`. This is the single most valuable test — it proves the entire pipeline.

### Surgical invalidation (proves the pipeline, not the sledgehammer)

After `applyChanges` modifies `doc.settings.darkMode` via a replace change at the darkMode path:
- `doc.settings.darkMode()` returns the new value (cache was invalidated at that path).
- `doc.messages.at(0)` returns the same cached ref as before (unrelated cache was not touched).

This test would **fail** under the root-clear approach (where `doc.messages.at(0)` would be a fresh carrier after the clear).

### Batched notification (the key correctness test for the Changeset protocol)

Apply 3 changes via `applyChanges`. Subscribe to the root doc's changefeed before the call. Assert the subscriber fires exactly **once** with a `Changeset` whose `changes` array has length 3. Assert the store is fully consistent when the subscriber fires — all 3 changes are applied, not just the first one.

This test would **fail** under the old per-change replay model (where the subscriber fires 3 times, seeing partially-applied state on the first two invocations).

### No notification during buffering

Begin a transaction, make 3 mutations. Assert subscriber fires zero times. Commit. Assert subscriber fires exactly once with all 3 changes.

### Auto-commit wraps in degenerate Changeset

Make a single mutation outside a transaction. Assert the subscriber receives a `Changeset` with `changes.length === 1`. The subscriber API is uniform.

### Origin tagging on Changeset

Apply changes with `{ origin: "sync" }`. Subscribe to a leaf ref. Assert the received `changeset.origin === "sync"`.

### TreeEvent.path (renamed from .origin)

Subscribe to `doc.settings` via `subscribeTree`. Mutate `doc.settings.darkMode`. Assert the tree event has `path: [{ type: "key", key: "darkMode" }]` (not `.origin`). Assert `changeset.origin` is `undefined` (no provenance was tagged).

### Cache invalidation via prepare pipeline (Phase 4 verification)

Without using `applyChanges` — directly call `ctx.prepare(path, replaceChange(newValue))` then `ctx.flush()` on a cached document. Assert the cache at that path is invalidated and subsequent reads return the new value. This proves the pipeline works independently of `applyChanges`.

### Error paths

- `applyChanges({}, ops)` throws (no `[TRANSACT]`).
- `applyChanges(doc, [])` is a no-op (returns empty array, no subscribers fire).

## Transitive Effect Analysis

### `Changefeed` / `ComposedChangefeed` (`src/changefeed.ts`)

**Modified in Phase 2.** `subscribe` callback signature changes from `(change: C) => void` to `(changeset: Changeset<C>) => void`. `subscribeTree` callback changes from `(event: TreeEvent) => void` to `(changeset: Changeset<TreeEvent<C>>) => void`. `TreeEvent.origin` renamed to `TreeEvent.path`.

Note: `getOrCreateChangefeed` and its backing `WeakMap` remain in this module — they are **not used within `@kyneta/schema`** (the `withChangefeed` transformer uses `attachChangefeed` instead) but are still actively used by `@kyneta/core`'s `local-ref.ts`. Do not remove from the public API.

### `ChangeBase` (`src/change.ts`)

**Modified in Phase 2.** The `origin?: string` field is removed. Provenance migrates to `Changeset.origin`.

### `WritableContext` (`src/interpreters/writable.ts`)

**Modified in Phase 3.** Gains `prepare`, `flush`, and `executeBatch` methods. `dispatch` becomes transaction-aware: auto-commit calls `executeBatch`, transaction mode buffers. `commit()` accepts an optional `origin` parameter, calls `executeBatch(flushed, origin)`. The `replaying` flag is removed — no longer needed since `commit` calls `executeBatch` directly, not `dispatch`.

### `withChangefeed` (`src/interpreters/with-changefeed.ts`)

**Substantially modified in Phases 2–3.** Phase 2: subscriber signatures updated, `TreeEvent.origin` → `TreeEvent.path`. Phase 3: dispatch wrapping replaced with `prepare`/`flush` hooks — `prepare` accumulates pending notifications per path, `flush` calls `planNotifications` (Functional Core) then `deliverNotifications` (Imperative Shell) to deliver `Changeset` to listeners. The `inTransaction` guard is removed (no longer needed — phase separation inherently handles this).

### `withCaching` (`src/interpreters/with-caching.ts`)

**Modified in Phase 4 (atomic with withWritable changes).** Adds `ensureCacheWiring(ctx)` — idempotent `prepare` wrapping that registers per-node invalidation handlers by path. The handler logic (field state clear, `planCacheUpdate` + `applyCacheOps`) is unchanged. The `prepare` wrapper calls the handler **before** forwarding to the original `prepare`. Uses the shared `pathKey` utility.

### `withWritable` (`src/interpreters/writable.ts`)

**Modified in Phase 4 (same commit as withCaching changes — must be atomic).** The ~9 `if (INVALIDATE in result) result[INVALIDATE](change)` guards are removed from mutation methods. Each method simplifies to: construct change, `ctx.dispatch(path, change)`. The `INVALIDATE` import becomes unused and is removed, along with ~4 stale comments referencing invalidate-before-dispatch.

### `@kyneta/core` runtime (`text-patch.ts`, compiler, mocks)

**Breaking change in Phase 2.** Three areas affected:

1. **`inputTextRegion`** currently reads `change.origin` for cursor management (`"local"` → `"end"`, else → `"preserve"`). After Phase 2, provenance is on the `Changeset`, not the individual change. The `subscribe` callback receives a `Changeset`, so the code changes from `change.origin === "local"` to `changeset.origin === "local"`, with inner iteration over `changeset.changes`.

2. **Compiler `getDeltaKind`** type-walks the `subscribe` callback signature to extract the change type via a multi-hop TypeScript type walk. The new `Changeset<C>` wrapper adds an indirection that changes what the compiler extracts. Must be verified and updated.

3. **Mock infrastructure** in `helpers.ts` stamps `origin: "local"` directly onto change objects. Must wrap changes in `Changeset` instead.

### `example/main.ts` facade

**Modified in Phase 2.** All subscriber callbacks updated for new signatures. The `subscribe` helper wraps the `Changeset` protocol. The `change` function continues to return `doc` (teaching convenience). Tree event logging updated for `TreeEvent.path`.

### Recipe-book example plan

**Unblocked.** The recipe-book plan's `applyDelta` becomes a thin wrapper around `applyChanges` with version tracking. The `Changeset.origin` field provides provenance for the recipe sync use case.

### `[INVALIDATE]` symbol remains public

`[INVALIDATE]` stays on refs as part of the `HasCaching` interface. Advanced consumers can still call it directly. The change is that `withWritable` no longer *needs* to call it — the `prepare` pipeline does. The `INVALIDATE` export from `with-caching.ts` is unchanged.

### Dispatch pipeline ordering

**Stated invariant:** Interpreter transformers compose by wrapping `prepare`/`flush` in interpretation order. The outermost wrapper runs first for `prepare` (pre-mutation concerns like cache invalidation). `flush` is only wrapped by `withChangefeed`; no ordering concern there.

The `prepare` pipeline after Phases 3–4 has hooks from both layers:

```
ctx.prepare(path, change)
  → withCaching's hook: invalidate cache at path
  → withChangefeed's hook: accumulate {path, change} for notification
  → original prepare: applyChangeToStore(store, path, change)

ctx.flush(origin?)
  → withChangefeed's hook: planNotifications (pure) → deliverNotifications (imperative)
    Deliver Changeset to per-path listeners, Changeset<TreeEvent> to tree listeners.
    Clear accumulator.
```

The hook installation order is determined by interpretation order. `withChangefeed` wraps `prepare` first (during its interpreter cases), `withCaching` wraps it second (during its inner interpreter cases). Since `withCaching` wraps later, its hook is outermost — it runs first. This gives: **invalidate → accumulate → store mutation** per change, then **plan + deliver notifications** once per batch. Correct.

Note: the two buffers in the system serve different lifetimes and must not be confused:
1. **Transaction buffer** (`pending` in `createWritableContext`) — holds `{path, change}` pairs during a transaction. Drained by `commit`, which feeds them to `executeBatch`.
2. **Notification accumulator** (in `withChangefeed`'s prepare hook) — holds `{path, change}` pairs for the current `executeBatch` call. Drained by `flush`.

### Existing changefeed test impact

All changefeed tests that assert per-change notification counts need updating:

- Tests asserting `events.length === N` after N mutations outside a transaction remain correct — each auto-commit dispatch produces one `Changeset` of one change, so `N` dispatches produce `N` changesets (each containing 1 change).
- Tests asserting `events.length >= 2` after a 2-mutation transaction commit must change to assert `events.length === 1` with `events[0].changes.length === 2`. This is the whole point.
- The test `"no tree subscriber notifications during transaction buffering"` (`changefeed.test.ts` L593–608) currently asserts `events.length >= 2` after commit. It should assert `events.length === 1` with the changeset containing 2 tree events.

### Symbols that become unused

| Symbol | Module | Action |
|---|---|---|
| `INVALIDATE` import | `writable.ts` L49–51 | Remove — all 9 usage sites removed in Phase 4 |
| `replaying` flag | `writable.ts` L160 | Remove — `commit` calls `executeBatch`, not `dispatch` |
| `inTransaction` guard | `with-changefeed.ts` L116 | Remove — phase separation makes it structurally unnecessary |
| ~4 stale comments | `writable.ts` L13–17, L69, L347–362, L438–442 | Update to describe new pipeline model |

## Resources for Implementation Context

| Resource | Path | Relevance |
|---|---|---|
| `withChangefeed` dispatch wrapping pattern | `src/interpreters/with-changefeed.ts` L68–127 | The `WeakMap` + `ensureDispatchWiring` + `pathKey` pattern to adapt for `prepare`/`flush` |
| `withCaching` invalidation handlers | `src/interpreters/with-caching.ts` L272–353 | Product field state clear, sequence/map `planCacheUpdate` + `applyCacheOps` — the handlers to register in the prepare pipeline |
| `withWritable` mutation methods | `src/interpreters/writable.ts` L390–530 | The ~9 `if (INVALIDATE in result)` guards to remove |
| `WritableContext` interface and `createWritableContext` | `src/interpreters/writable.ts` L86–220 | Transaction API: `beginTransaction`, `commit`, `abort`, `dispatch` — to be extended with `prepare`/`flush` |
| `TRANSACT` symbol and `hasTransact` guard | `src/interpreters/writable.ts` L56–93 | Context discovery from any ref |
| `INVALIDATE` symbol and `planCacheUpdate` | `src/interpreters/with-caching.ts` L50–60, L95–114 | Cache invalidation protocol and the Functional Core planning functions |
| `ChangeBase` with `origin` field | `src/change.ts` L30–34 | Provenance field to be removed (migrates to `Changeset`) |
| `Changefeed` / `ComposedChangefeed` / `TreeEvent` | `src/changefeed.ts` | Core reactive protocol to be updated |
| `PendingChange` type | `src/interpreters/writable.ts` L136–139 | The `{ path, change }` pair — universal currency |
| `step` functions | `src/step.ts` | Mathematical core: `(S, Change) → S`; used by `applyChangeToStore` |
| Example facade (`change`, `subscribe`) | `example/main.ts` L129–181 | The teaching version of `change` — returns doc, not ops |
| Changefeed test patterns | `src/__tests__/changefeed.test.ts` | Transaction + changefeed integration tests — will need assertion updates |
| `inputTextRegion` origin branching | `packages/core/src/runtime/text-patch.ts` L223–233 | Downstream consumer of `change.origin` — must migrate to `changeset.origin` |
| `TECHNICAL.md` §Changefeed Decorator | `TECHNICAL.md` L351–361 | Stale `enrich` references to clean up during documentation phase |

## Alternatives Considered

### Root-level cache clear (the sledgehammer)

Before replaying changes through dispatch, call `ref[INVALIDATE](replaceChange(null))` on the root ref to clear all caches. This is O(1) and correct, but invalidates the entire tree for every `applyChanges` call — even a single counter increment blows away every cached field, sequence child, and map entry. The cost is amortized into subsequent lazy re-access, but for large documents with many cached nodes, this creates unnecessary churn.

**Rejected.** The prepare-pipeline approach gives surgical invalidation at no additional cost to `applyChanges` callers, and also benefits imperative mutation by simplifying `withWritable`. The implementation cost (one `ensureCacheWiring` function mirroring `withChangefeed`'s existing pattern) is modest.

### Navigate the ref tree to find refs at each path

For each `{path, change}` in ops, walk the carrier tree (`doc.settings`, `doc.messages.at(0)`, etc.) to find the ref at the target path, call its `[INVALIDATE]`, then dispatch. This gives surgical per-path invalidation without pipeline changes.

**Rejected.** Fragile — cache shifting means the ref at a numeric index may not correspond to the logical item at that index after a prior sequence change in the same batch. Dynamic map keys may not have cached refs. The tree walk would need to handle all these edge cases.

### Make `applyChanges` a method on `WritableContext`

Add `applyExternalChanges(ops, origin?)` directly to `WritableContext`. This keeps the primitive at the context level.

**Rejected.** `WritableContext` is infrastructure — it shouldn't know about origin tagging or the `Changeset` protocol. The `applyChanges` function is a facade-level concern that composes context primitives. Keeping it as a standalone function maintains the separation.

### Extract a generic dispatch-hook utility

Both `withChangefeed` and `withCaching` use `WeakMap<WritableContext, State>` + idempotent wrapping + path-keyed handler maps. Extract a generic `createPipelineHook<H>(phase)` utility.

**Rejected for now.** The two consumers hook into different phases (`prepare` vs `flush`), have different handler types (`single function` vs `Set<callback>` + accumulator), and different accumulation semantics (stateless vs stateful). The shared pieces — `pathKey` and the structural pattern — are better served by extracting `pathKey` as a utility and repeating the ~20-line wiring pattern. Consider extracting a shared type alias (e.g. `PipelineHookState<H>`) to keep the two modules aligned and the pattern grep-able, even without sharing the function. If a third consumer emerges, the generic hook becomes justified.

### Keep `origin` on `ChangeBase` instead of `Changeset`

Stamp each individual change with `origin` via shallow spread, as the original plan proposed.

**Rejected.** Provenance describes *why a batch happened* (sync, undo, local edit), not a property of individual changes. Putting `origin` on `ChangeBase` creates redundancy (N identical stamps per batch), prevents expressing batch-level metadata that isn't per-change (e.g. correlation tokens), and conflates two meanings of "origin" (provenance vs. `TreeEvent.origin` path). `Changeset` is the correct locus.

### Keep per-change notification (no `Changeset`)

Leave the `subscribe(cb: (change) => void)` signature unchanged. Fix only the partial-visibility problem by applying all store mutations before any notifications.

**Rejected.** Per-change notification forces subscribers into per-change reactions even when the changes are logically grouped. The recipe sync use case (3 inserts → 3 DOM traversals) demonstrates the real cost. `Changeset` enables subscribers to amortize work across a batch. The subscriber receives the group, decides how to handle it.

### Use `ChangeBase[]` as the delivery type (no `Changeset` wrapper)

Deliver `changes: ChangeBase[]` directly without a wrapper type.

**Rejected.** An array has no metadata slot. Provenance, correlation tokens, and future batch-level metadata need a home. `Changeset` provides this cleanly — `changes` for the data, top-level fields for the metadata.

### Use `structuredClone` on changes to attach origin

Deep-clone each `PendingChange` before attaching the `origin` field.

**Rejected.** With `origin` migrating to `Changeset`, there is no need to clone or modify individual changes at all. The provenance tag lives on the batch wrapper.

## PR Stack

Seven PRs, ordered inside-out: foundational types and refactors first, behavior changes in the middle, public API and documentation last. Each PR builds, tests, and is independently reviewable.

### PR 1 — refactor: extract `pathKey` to shared utility

**Phase 1. Type: mechanical refactor.**

Pure code motion — no behavior change, no new tests needed beyond verifying existing ones pass.

- Extract `pathKey` from `with-changefeed.ts` to `src/path-utils.ts`
- Export from `src/index.ts`
- Update `with-changefeed.ts` import
- Verify all existing tests pass

Reviewer sees: a 5-line function moves from a private location to a shared module. Trivial to verify.

### PR 2 — feat: `Changeset` type, `TreeEvent.path` rename, `ChangeBase.origin` removal

**Phase 2. Type: API/contract change + call-site migration (single PR because the type changes are tightly coupled).**

This is the protocol-level breaking change. It introduces the `Changeset<C>` type, renames `TreeEvent.origin` → `TreeEvent.path`, removes `origin` from `ChangeBase`, and migrates all subscribers to the new signatures. `withChangefeed` temporarily wraps each notification in a degenerate `Changeset` of one — no batched delivery yet.

Schema-side:
- Define `Changeset` in `src/changefeed.ts` (co-located with `Changefeed` / `TreeEvent`)
- Remove `origin?: string` from `ChangeBase`
- Rename `TreeEvent.origin` to `TreeEvent.path`
- Update `Changefeed.subscribe` and `ComposedChangefeed.subscribeTree` signatures
- Update `withChangefeed` to wrap each notification in `Changeset` of one (degenerate)
- Update all 12 `TreeEvent` construction sites in `with-changefeed.ts` (field rename)
- Update all ~35 test sites reading `event.origin` → `event.path`
- Update `example/main.ts` subscriber callbacks and tree event logging
- Export `Changeset` from `src/index.ts`

Core-side (coordinated):
- Update `inputTextRegion` — `changeset.origin` instead of `change.origin`, inner iteration over `changeset.changes`
- Update compiler `getDeltaKind` — type walk must unwrap `Changeset<C>` to reach the change type (add ~3 hops: get `changes` property type → get array element type → then existing hops for `.type`)
- Update mock infrastructure in `helpers.ts` — wrap changes in `Changeset`

Why one PR: the type changes are interdependent — you can't rename `TreeEvent.origin` without updating all construction sites, you can't change `subscribe` signature without updating all callbacks, and the core compiler fix is load-bearing (tests fail without it). Splitting would leave intermediate commits that don't build.

Reviewer sees: a coherent protocol upgrade. The `Changeset` type is introduced, every subscriber adapts, and the system behaves identically (degenerate changesets of one). The reviewer can verify: "every callback now receives a `Changeset`, every `TreeEvent` uses `.path`, all tests pass."

### PR 3 — feat: `prepare`/`flush`/`executeBatch` phase separation in `WritableContext`

**Phase 3, infrastructure half. Type: new abstraction (no behavior change to existing callers yet).**

Adds the `prepare`/`flush`/`executeBatch` primitives to `WritableContext`. Rewires `dispatch` and `commit` to use `executeBatch` internally. Removes the `replaying` flag. The `inTransaction` guard in the changefeed wrapper is removed (phase separation makes it structurally unnecessary).

This PR does NOT yet change `withChangefeed` to do batched delivery — `prepare` just does `applyChangeToStore`, and `flush` is initially a no-op. The changefeed wrapper continues to fire (via `prepare` wrapping) as before, but now goes through the new code path.

- Add `prepare`, `flush`, `executeBatch` to `WritableContext` interface
- Implement in `createWritableContext`: `prepare` = `applyChangeToStore`, `flush` = no-op initially
- Redefine `dispatch` as transaction-aware: auto-commit calls `executeBatch`, transaction mode buffers
- Redefine `commit` to use `executeBatch`
- Remove `replaying` flag
- Add `inTransaction` guard to `executeBatch` (throws)
- `withChangefeed` wraps `prepare` instead of `dispatch` — fires degenerate `Changeset` per change after `prepare` (same behavior as PR 2, different code path)
- Remove `inTransaction` guard from changefeed wrapper
- Verify all existing tests pass (behavior unchanged — each `prepare` still fires a degenerate `Changeset`)

Reviewer sees: the dispatch pipeline is factored into `prepare`/`flush` but observable behavior is identical. The `executeBatch` primitive is introduced and used by both `dispatch` and `commit`. The reviewer can verify: "all existing tests pass, the new code paths are equivalent."

### PR 4 — feat: batched changefeed notification via `flush`

**Phase 3, notification half. Type: behavior change.**

This is where notification semantics actually change. `withChangefeed`'s `prepare` hook switches from firing immediately to accumulating. `flush` drains the accumulator and delivers `Changeset` batches. Introduces `planNotifications` (Functional Core) and `deliverNotifications` (Imperative Shell).

- Implement `planNotifications` (pure function — groups changes by pathKey, builds TreeEvent entries)
- Implement `deliverNotifications` (imperative — builds Changeset objects, fires callbacks)
- Update `withChangefeed` `prepare` hook: accumulate `{path, change}` instead of firing
- Update `withChangefeed` `flush` hook: call `planNotifications` → `deliverNotifications`
- Update changefeed factories for the accumulation/delivery model
- Add unit tests for `planNotifications` (table-driven, like `planCacheUpdate`)
- Update changefeed test assertions: transaction commit now fires 1 changeset with N changes (not N changesets of 1)

Reviewer sees: the actual semantic change. Subscribers now receive batched `Changeset` objects. The FC/IS split mirrors the existing `planCacheUpdate`/`applyCacheOps` pattern. The reviewer can verify: "transaction tests now assert 1 event with N changes, `planNotifications` is table-tested."

### PR 5 — feat: move `[INVALIDATE]` into `prepare` pipeline, remove from `withWritable`

**Phase 4. Type: behavior change (atomic — both sides in one PR to avoid double-shift corruption).**

`withCaching` hooks into the `prepare` phase via `ensureCacheWiring`. Simultaneously, the ~9 `if (INVALIDATE in result) result[INVALIDATE](change)` guards are removed from `withWritable` mutation methods.

- Add `ensureCacheWiring(ctx)` to `with-caching.ts`
- Register invalidation handlers by path in each composite case (product, sequence, map)
- Remove ~9 INVALIDATE guards from `withWritable` mutation methods
- Remove unused `INVALIDATE` import from `writable.ts`
- Update ~4 stale comments in `writable.ts`
- Update `TECHNICAL.md` §withWritable
- Verify all existing tests pass

Reviewer sees: cache invalidation moves from manual convention (each mutation method calls INVALIDATE) to pipeline enforcement (prepare does it). The mutation methods simplify to "construct change, dispatch." The reviewer can verify: "every mutation method lost its INVALIDATE guard, `ensureCacheWiring` mirrors the existing `ensureDispatchWiring` pattern, all tests pass."

### PR 6 — feat: library-level `change` and `applyChanges`

**Phase 5 + Phase 6 tests. Type: feature (new public API + tests).**

Introduces the two symmetric duals: imperative `change` (returns `PendingChange[]`) and declarative `applyChanges` (consumes `PendingChange[]`). Both use `executeBatch` under the hood.

- Create `src/facade.ts` with `change` and `applyChanges`
- Export from `src/index.ts`
- Tests: round-trip, batched notification, origin tagging, surgical invalidation, error paths, auto-commit changeset shape, `applyChanges` during transaction throws, `Changeset<TreeEvent>` round-trip isomorphism

Reviewer sees: the payoff — the public API that motivated the entire plan. The round-trip test is the crown jewel ("mutate docA, capture ops, apply to docB, assert equal"). The reviewer can verify: "the API surface is small, `executeBatch` does the heavy lifting, tests are comprehensive."

### PR 7 — docs: TECHNICAL.md and plan updates

**Phase 7. Type: documentation only.**

- Update `TECHNICAL.md` §Changefeed (Changeset protocol, batched delivery, origin provenance)
- Update `TECHNICAL.md` §Changefeed (TreeEvent.path rename)
- Update `TECHNICAL.md` §withCaching (prepare-pipeline invalidation)
- Update `TECHNICAL.md` §WritableContext (prepare/flush, executeBatch, applyChanges)
- Update `TECHNICAL.md` §Changefeed Decorator (remove stale `enrich` references)
- Update Verified Properties (#6, #7, #24 + 3 new)
- Document `executeBatch` invariant and `Changeset<TreeEvent>` ≅ `(PendingChange[], origin)` isomorphism
- Update recipe-book plan

Reviewer sees: documentation catching up to the implementation. No code changes.

### Stack visualization

```
PR 7  docs: TECHNICAL.md and plan updates
  ↑
PR 6  feat: library-level change/applyChanges + tests
  ↑
PR 5  feat: INVALIDATE into prepare pipeline (atomic with withWritable cleanup)
  ↑
PR 4  feat: batched changefeed notification via flush
  ↑
PR 3  feat: prepare/flush/executeBatch phase separation
  ↑
PR 2  feat: Changeset type, TreeEvent.path rename, subscriber protocol
  ↑
PR 1  refactor: extract pathKey to shared utility
```

### Risk profile

| PR | Risk | Reason |
|---|---|---|
| 1 | None | Pure code motion |
| 2 | **High** | Protocol-level breaking change across schema + core. Coordinate deployment. |
| 3 | Medium | Deep infrastructure rework, but behavior-preserving. Existing tests are the safety net. |
| 4 | Medium | Observable behavior change (batched notification). Test assertion updates required. |
| 5 | Low | Atomic swap — add pipeline + remove guards. Existing cache tests verify correctness. |
| 6 | Low | New additive API. Comprehensive test coverage. |
| 7 | None | Documentation only |

### Safe revert boundaries

- **Revert PR 7**: docs drift, no functional impact.
- **Revert PR 6**: public API disappears, no internal breakage (executeBatch still exists).
- **Revert PR 5**: INVALIDATE moves back to mutation methods, pipeline hook removed. Must revert atomically.
- **Revert PR 4**: notification reverts to per-change delivery (degenerate Changeset). Tests revert too.
- **Revert PR 3**: prepare/flush removed, dispatch/commit revert to original implementation. Requires reverting PR 4+ (depends on prepare/flush).
- **Revert PR 2**: Changeset type removed, subscriber signatures revert. Requires reverting PR 3+ (depends on Changeset).
- **Revert PR 1**: pathKey moves back to private. Requires reverting PR 5 (uses shared pathKey).