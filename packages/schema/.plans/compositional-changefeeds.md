# Compositional Changefeeds

## Background

The `@kyneta/schema` package implements a schema interpreter algebra where a recursive schema type is walked by a generic catamorphism (`interpret`), producing refs at each node. Three orthogonal interpreter layers compose to form the full ref surface:

1. **`readableInterpreter`** — callable function-shaped refs (`ref()` returns current value)
2. **`withMutation(base)`** — interpreter transformer adding `.set()`, `.insert()`, `.increment()`, etc.
3. **`withChangefeed`** — `enrich` decorator attaching `[CHANGEFEED]` observation protocol

The changefeed layer provides a coalgebra at each node: `{ current: S, subscribe(cb): unsubscribe }`. This is a Moore machine — one state, one output stream.

### The Flat Subscriber Map

Today, changefeeds are implemented as a **flat subscriber map** on `ChangefeedContext`:

```ts
interface ChangefeedContext extends WritableContext {
  readonly subscribers: Map<string, Set<(change: ChangeBase) => void>>
  readonly deepSubscribers: Map<string, Set<(event: DeepEvent) => void>>
}
```

Each ref's `[CHANGEFEED].subscribe` registers a callback in `ctx.subscribers` keyed by `pathKey(path)`. A product ref's changefeed fires **only** when something dispatches at that exact path (e.g., `product.set()`). It does **not** fire when children mutate. There is no structural relationship between a parent's changefeed and its children's changefeeds. The tree structure of the schema is not reflected in the tree structure of the changefeeds.

`subscribeDeep` was added as a context-level workaround — it walks ancestor paths during `notifyAll` to find deep subscribers. It works, but requires the raw `ChangefeedContext` object and is not accessible through the `[CHANGEFEED]` protocol.

### The `change()` Transaction Bug

The `change()` facade (in `example/main.ts`) creates batched atomic mutations:

```ts
function change<D>(doc: D, fn: (draft: D) => void): D {
  const { schema, store } = getInternals(doc)
  const batchWCtx = createWritableContext(store, { autoCommit: false })
  const batchCfCtx = createChangefeedContext(batchWCtx)
  const draft = interpret(schema, enriched, batchCfCtx) as D
  fn(draft)
  changefeedFlush(batchCfCtx)  // notifies batchCfCtx's subscribers — which are empty
  return doc
}
```

`changefeedFlush(batchCfCtx)` applies changes to the shared store correctly, but notifies `batchCfCtx.subscribers` — an empty map. The original doc's subscribers (on the original `ChangefeedContext`) are never notified.

The root cause is structural: `autoCommit` is an immutable construction-time mode on `WritableContext`, so batching requires creating a second context. That second context has its own (empty) subscriber maps. The `change()` bug is not a missing parameter — it's a consequence of the two-context architecture.

### Consequences for `@kyneta/core`

The compiled runtime in `@kyneta/core` subscribes to refs via `ref[CHANGEFEED].subscribe(handler)`. This means:

- `listRegion` subscribes to a list ref and receives only `SequenceChange` events (structural insert/delete). It does **not** know when items within the list are mutated.
- `subscribeDeep` is inaccessible from the protocol — the runtime cannot do subtree observation without the raw context.
- `change()` transactions do not notify the original doc's subscribers.

## Problem Statement

1. Changefeeds do not compose. A product ref's `[CHANGEFEED]` does not aggregate its children's changefeeds. Subtree observation requires the context-level `subscribeDeep` workaround.
2. `change()` re-interprets the entire schema to create draft refs, and notifications go to an empty context. Transactions should operate on existing refs without re-interpretation.
3. The `withChangefeed` decorator cannot build compositional changefeeds because `enrich` runs post-hoc — the decorator sees only the finished result, not child changefeeds. Composition requires interpreter-level access to the recursive structure.
4. The `Changefeed` interface must remain a clean Moore machine. Tree-level observation must be an extension, not a modification.
5. The batched-mode mechanism (`autoCommit: false` + `pending` + `flush`/`changefeedFlush`) is the same concept as transactions but with a worse API — construction-time mode, publicly exposed buffer, no abort, and the root cause of the `change()` bug. These should be unified into a single transaction API.

## Success Criteria

1. A product ref's changefeed can be subscribed to for **tree-level** observation (all descendant changes with origin path), accessible through the `[CHANGEFEED]` protocol without requiring a raw context object.
2. The existing `Changefeed.subscribe` remains node-level: leaf refs fire on any mutation; composite refs fire only on structural changes at that node (e.g., `SequenceChange` for lists, `ReplaceChange` for products). This is backward-compatible — all existing runtime regions (`listRegion`, `conditionalRegion`, `valueRegion`, `textRegion`) work unchanged.
3. `subscribeDeep`, the flat `deepSubscribers` map, `ChangefeedContext`, `createChangefeedContext`, `changefeedFlush`, and `notifyAll` are eliminated. Tree-level observation is provided by `ComposedChangefeed.subscribeTree`. Notification flows through the changefeed tree, not flat maps.
4. The `WritableContext` gains transaction support (`beginTransaction` / `commit` / `abort`), replacing the old `autoCommit` / `pending` / `flush` mechanism. `change()` uses the same refs, same context — no re-interpretation.
5. Refs carry a `[CONTEXT]` symbol referencing their `WritableContext`, making context discoverable for `change()`.
6. The fluent composition API `interpret(schema, ctx).with(readable).with(mutation).with(changefeed)` provides explicit, ordered layering.
7. All new behavior has test coverage. Existing tests for removed infrastructure are replaced by equivalent tests against the new APIs.

## Gap

- `withChangefeed` is an `enrich` decorator. It has no access to child changefeeds during construction. It cannot compose them.
- `ChangefeedContext` carries two flat subscriber maps (`subscribers`, `deepSubscribers`). These are not tree-structured.
- `WritableContext` has no transaction API. The only batching mechanism is `autoCommit: false` + `changefeedFlush`, which requires creating a new context — and that new context is the root cause of the `change()` bug.
- `autoCommit`, `pending`, `flush`, and `changefeedFlush` are all surface area for the same concept that the transaction API subsumes.
- Refs do not carry a reference to their originating context. The `change()` facade uses a `DOC_INTERNALS` WeakMap — fragile and only available at the document root.
- No `ComposedChangefeed` interface or `subscribeTree` method exists.
- No `CONTEXT` symbol exists. (It will be added to `writable.ts`, following the `INVALIDATE`-in-`readable.ts` pattern.)
- The `interpret` API returns a result directly — no fluent builder.
- No `InterpreterLayer` abstraction exists for fluent `.with()` chaining.

## Design Decisions

### Two Coalgebras, One Interface Extension

The `Changefeed` interface (one state, one stream) is a Moore machine. Adding tree-level observation as a second stream would make it a product of Moore machines sharing the same state carrier.

Rather than adding `subscribeTree` to the base `Changefeed` interface (which would force every implementor — including `LocalRef` and third-party types — to provide it), we define `ComposedChangefeed extends Changefeed` with the additional method. Only composite refs (products, sequences, maps) implement `ComposedChangefeed`. Leaf refs implement `Changefeed` only.

```ts
// Unchanged — universal reactive protocol
interface Changefeed<S, C extends ChangeBase = ChangeBase> {
  readonly current: S
  subscribe(callback: (change: C) => void): () => void
}

// Extension for tree-structured refs
interface ComposedChangefeed<S, C extends ChangeBase = ChangeBase>
  extends Changefeed<S, C> {
  subscribeTree(callback: (event: TreeEvent) => void): () => void
}

interface TreeEvent {
  readonly origin: Path
  readonly change: ChangeBase
}
```

`subscribe` on a composite ref fires only for changes at that node's own path (node-level). `subscribeTree` fires for all descendant changes with relative origin paths (tree-level). For leaf refs, `subscribe` and `subscribeTree` (if it existed) would be identical — but leaves don't implement `ComposedChangefeed`, so the question doesn't arise.

This preserves backward compatibility: `@kyneta/core`'s runtime calls `ref[CHANGEFEED].subscribe(handler)`, which remains node-level. `listRegion` continues to receive only `SequenceChange`. No existing consumer breaks.

### `subscribeTree` Semantics

`subscribeTree` on a product ref composes its children: it subscribes to each child's changefeed (both `subscribe` and `subscribeTree` if the child is itself composite) and aggregates events with origin paths. When a leaf child fires, the product's tree subscribers receive `{ origin: [{ type: "key", key: fieldName }], change }`. When a composite child's tree fires with origin `O`, the product's tree subscribers receive `{ origin: [{ type: "key", key: fieldName }, ...O], change }`.

`subscribeTree` on a sequence ref composes structural changes (its own `subscribe` stream, which emits `SequenceChange`) with item content changes (each item's changefeed). The set of items is dynamic — subscriptions must be managed as items are added and removed. On insert, subscribe to the new item's changefeed. On delete, unsubscribe from the removed item's changefeed.

`subscribeTree` fires for changes at the node's own path too (with `origin: []`), making it a strict superset of `subscribe`. A tree subscriber sees everything a node-level subscriber sees, plus descendants.

### Interpreter Transformer, Not Decorator

`withChangefeed` is currently an `enrich` decorator. The `enrich` combinator runs the base interpreter and then post-hoc attaches protocol — the decorator sees only the finished result, not the child thunks.

Compositional changefeeds require interpreter-level access to the recursive structure. Specifically, the `product` case needs to access the child field results (which are already `A & Changefeed`) to compose their changefeeds. The `sequence` case needs access to the item closure to subscribe to dynamically created items.

The solution is an **interpreter transformer** — the same pattern as `withMutation(base)`. It takes a base interpreter, returns a new interpreter that delegates to the base for the core result and adds changefeed protocol with full access to children.

```ts
function withCompositionalChangefeed(
  base: Interpreter<WritableContext, unknown>,
): Interpreter<WritableContext, unknown>
```

This replaces both `withChangefeed` (the `enrich` decorator) and `subscribeDeep` (the context-level workaround). The flat subscriber maps on `ChangefeedContext` become unnecessary — subscribers live in the changefeed tree itself.

### Transaction Subsumes Batched Mode

The current `WritableContext` has four members:

```ts
interface WritableContext extends RefContext {
  readonly dispatch: (path: Path, change: ChangeBase) => void
  readonly autoCommit: boolean
  readonly pending: PendingChange[]
}
```

`autoCommit` and `pending` exist solely to support one use case: "buffer mutations now, apply later." The transaction API (`beginTransaction` / `commit` / `abort`) does the same thing with strictly better semantics:

| Old batched mode | Transaction API |
|---|---|
| `createWritableContext(store, { autoCommit: false })` | `ctx.beginTransaction()` |
| `ctx.pending` accumulates changes (publicly visible) | Buffer is internal to transaction lifecycle |
| `flush(ctx)` applies to store, no notification | `commit()` replays through `dispatch`, notifications fire |
| `changefeedFlush(ctx)` applies to store + notifies flat maps | `commit()` does this inherently via dispatch replay |
| No abort mechanism | `ctx.abort()` discards buffer |
| Construction-time, permanent mode | Dynamic — enter/exit on demand |
| Requires second context → `change()` bug | Same context, same refs → bug structurally eliminated |

The old mechanism is a construction-time, permanent mode (`autoCommit` is immutable). Transactions are dynamic — the default context auto-commits, and you enter/exit transactional mode on demand. This is strictly more capable, and it eliminates the need for a second context entirely.

`WritableContext` becomes:

```ts
interface WritableContext extends RefContext {
  readonly dispatch: (path: Path, change: ChangeBase) => void
  beginTransaction(): void
  commit(): PendingChange[]
  abort(): void
}
```

`autoCommit`, `pending`, `flush()`, `changefeedFlush()`, `WritableOptions`, `ChangefeedContext`, and `createChangefeedContext` are all removed. They are subsumed.

During a transaction, `dispatch` accumulates changes in an internal pending buffer instead of applying them. On `commit()`, each pending change is replayed through the **normal dispatch path** — `applyChangeToStore` followed by the same notification hooks that `withCompositionalChangefeed` wired onto `dispatch`. This means commit fires the shallow subscribers at each node, which propagate up the composed changefeed tree to tree subscribers. The same refs and the same changefeeds are in use — no re-interpretation.

Critically, `commit()` must replay through `dispatch` (not bypass it via raw `applyChangeToStore`), because the compositional changefeed transformer wraps `dispatch` to attach notification. If `commit()` bypassed `dispatch`, subscribers would never fire. The implementation: `commit()` temporarily sets a flag to prevent re-buffering, then calls `dispatch(path, change)` for each pending entry, then clears the flag and the pending buffer.

### `CONTEXT` Symbol on Refs

Every mutation method already closes over `ctx` (the `WritableContext`). Making this explicit via a symbol-keyed property enables `change()` to discover the context from any ref. The `CONTEXT` symbol lives in `writable.ts` alongside `WritableContext` — the same pattern as `INVALIDATE` in `readable.ts` (a composability hook defined in the layer that owns the concept):

```ts
// In writable.ts, alongside WritableContext
const CONTEXT: unique symbol = Symbol.for("kyneta:context") as any

interface HasContext {
  readonly [CONTEXT]: WritableContext
}
```

`change()` becomes:

```ts
function change<D extends HasContext>(ref: D, fn: (ref: D) => void): void {
  ref[CONTEXT].beginTransaction()
  fn(ref)
  ref[CONTEXT].commit()
}
```

No `DOC_INTERNALS` WeakMap. No re-interpretation. No empty context. Works on any ref, not just the document root.

### Fluent Interpreter Composition

The current composition `enrich(withMutation(readableInterpreter), withChangefeed)` is inside-out and not self-documenting. A fluent builder makes the layering explicit:

```ts
const doc = interpret(schema, ctx)
  .with(readable)
  .with(mutation)
  .with(changefeed)
  .done()
```

Each `.with(layer)` accumulates an `InterpreterLayer` — an interpreter transformer. `.done()` composes all layers and runs the single catamorphism walk.

```ts
interface InterpreterLayer<InCtx, OutCtx, InResult, Added> {
  transform(base: Interpreter<InCtx, InResult>): Interpreter<OutCtx, InResult & Added>
}

interface InterpretBuilder<Ctx, A> {
  with<NewCtx extends Ctx, B>(
    layer: InterpreterLayer<Ctx, NewCtx, A, B>
  ): InterpretBuilder<NewCtx, A & B>
  done(): A
}
```

The existing `interpret(schema, interpreter, ctx)` signature remains for power users and backward compatibility. The fluent API is sugar on top.

### Notification Flow in Compositional Design

With compositional changefeeds, notification does not use flat subscriber maps at all. Instead:

1. A mutation dispatches via `ctx.dispatch(path, change)` → `applyChangeToStore` updates the store.
2. The interpreter transformer's `withCompositionalChangefeed` attaches a `dispatch` wrapper at each node that also fires the node's own (shallow) subscribers.
3. Tree-level notification propagates up the changefeed tree: each composite's `subscribeTree` implementation aggregates child events and re-emits with extended origin paths.

This eliminates `notifyAll`, `pathKey`, `subscribeToPath`, `subscribeToMap`, and the flat subscriber infrastructure entirely. Subscribers live on the changefeed objects themselves, which form a tree.

## Phases

### Phase 1: `ComposedChangefeed` Interface and `TreeEvent` 🔴

Define the types. No runtime implementation yet.

- Task: Define `TreeEvent` interface in `changefeed.ts`: `{ readonly origin: Path, readonly change: ChangeBase }`. 🔴
- Task: Define `ComposedChangefeed<S, C>` interface in `changefeed.ts` extending `Changefeed<S, C>` with `subscribeTree(callback: (event: TreeEvent) => void): () => void`. 🔴
- Task: Define `HasComposedChangefeed<S, C>` interface with `readonly [CHANGEFEED]: ComposedChangefeed<S, C>`. 🔴
- Task: Add `hasComposedChangefeed(value)` type guard in `changefeed.ts`. 🔴
- Task: Export all new types and guards from `index.ts`. 🔴

### Phase 2: `CONTEXT` Symbol and `WritableContext` Transactions 🔴

Replace the old `autoCommit` / `pending` / `flush` batched mode with a proper transaction API. Remove `ChangefeedContext`, `createChangefeedContext`, `changefeedFlush`, and `flush`.

- Task: Define `CONTEXT` symbol in `src/interpreters/writable.ts`: `Symbol.for("kyneta:context")`. This follows the same pattern as `INVALIDATE` in `readable.ts` — a composability hook defined in the layer that owns the concept. 🔴
- Task: Define `HasContext` interface in `writable.ts`. 🔴
- Task: Replace `WritableContext` interface: remove `autoCommit` and `pending`, add `beginTransaction()`, `commit()`, `abort()`. The new interface is `{ dispatch, beginTransaction, commit, abort }`. 🔴
- Task: Remove `WritableOptions` interface. `createWritableContext(store)` no longer accepts options — dispatch always auto-commits by default. 🔴
- Task: Implement transaction methods in `createWritableContext`. `beginTransaction` sets an internal flag causing `dispatch` to buffer into an internal pending array instead of applying. `commit` replays each pending change through the normal `dispatch` path (with a re-entrancy guard to prevent re-buffering during replay), then clears the buffer and returns the flushed changes. `abort` discards the buffer. Nested transactions are not supported — `beginTransaction` while already in a transaction throws. 🔴
- Task: Remove `flush(ctx)` from `writable.ts`. 🔴
- Task: Remove `ChangefeedContext`, `createChangefeedContext`, `changefeedFlush`, `subscribeDeep`, `DeepEvent`, `notifyAll`, `pathKey`, `subscribeToPath` from `with-changefeed.ts`. The `withChangefeed` decorator remains temporarily (removed in Phase 5) and needs adaptation. Currently it's typed as `Decorator<ChangefeedContext, ...>` and reads `ctx.subscribers` (the flat map from `ChangefeedContext`). Since `ChangefeedContext` no longer exists, retype `withChangefeed` as `Decorator<WritableContext, ...>` and give it its own module-level `Map<string, Set<...>>` for exact-path subscriptions. The decorator's shape doesn't change — it still attaches a `[CHANGEFEED]` with `current`/`subscribe` — but notification now requires the decorator to also wrap `ctx.dispatch` to fire its own subscriber map (the same wrapping that `createChangefeedContext` used to do). Keep `subscribeToMap` as a private helper in this file since `withChangefeed` still needs it. This is throwaway scaffolding — Phase 5 deletes the entire file. 🔴
- Task: Add `hasContext(value)` type guard in `writable.ts`. Export `CONTEXT`, `HasContext`, `hasContext` from `index.ts`. Remove exports for `ChangefeedContext`, `createChangefeedContext`, `changefeedFlush`, `flush`, `subscribeDeep`, `DeepEvent`. 🔴
- Task: Update existing tests in `writable.test.ts`: replace `autoCommit: false` + `flush()` tests with equivalent `beginTransaction` / `commit` tests. 🔴
- Task: Update existing tests in `with-changefeed.test.ts`: remove batched-mode tests that depend on `changefeedFlush`. Replace with transaction-based equivalents where the behavior is covered by the new API. Remove `subscribeDeep` tests (the behavior moves to `subscribeTree` in Phase 3). 🔴
- Task: New tests in `transaction.test.ts`: `beginTransaction` → mutations do not apply to store until `commit`. `commit` applies all pending changes to the store via replay through `dispatch`. `commit` returns the list of flushed `PendingChange` entries. `abort` discards pending changes; store is unchanged. `beginTransaction` while already in a transaction throws. `commit` without `beginTransaction` throws. `abort` without `beginTransaction` throws. `dispatch` applies immediately outside a transaction (replaces old `autoCommit: true` test). 🔴
- Task: Update `schema-ssr.test.ts` in `@kyneta/core`: replace `createChangefeedContext(wCtx)` with plain `createWritableContext(store)`. The `withChangefeed` decorator still works with `WritableContext` during the transition. 🔴

### Phase 3: `withCompositionalChangefeed` Interpreter Transformer 🔴

The core implementation. Replaces `withChangefeed` (the `enrich` decorator).

- Task: **Extract shared changefeed utilities** into `src/changefeed-utils.ts`: move `attachChangefeed` (non-enumerable `Object.defineProperty` for `[CHANGEFEED]`) and `attachSymbolProperty` (generalized non-enumerable symbol attachment for `[CONTEXT]`) out of `with-changefeed.ts`. Update `with-changefeed.ts` to import from the new module. This prevents duplication between old and new interpreters. 🔴
- Task: Create `src/interpreters/with-composed-changefeed.ts`. Implement `withCompositionalChangefeed(base): Interpreter<WritableContext, unknown>`. 🔴
- Task: **Scalar case**: Produce a `Changefeed` (not `ComposedChangefeed` — no children). `subscribe` fires on any change dispatched at this path. Attach `[CHANGEFEED]` and `[CONTEXT]` as non-enumerable symbol properties. 🔴
- Task: **Product case**: Produce a `ComposedChangefeed`. `subscribe` fires on changes at this node's own path only (e.g., `product.set()`). `subscribeTree` subscribes to each child field's changefeed: if the child has `ComposedChangefeed`, subscribe to its `subscribeTree`; otherwise subscribe to its `subscribe`. Aggregate with origin path prefix. Attach `[CHANGEFEED]` and `[CONTEXT]`. Children are accessed by forcing the field thunks — the product case receives `fields: Record<string, () => A>` from the catamorphism, so child changefeeds are available after forcing. 🔴
- Task: **Sequence case**: Produce a `ComposedChangefeed`. `subscribe` fires on `SequenceChange` at this path. `subscribeTree` composes: subscribes to own `subscribe` stream (structural changes, re-emitted with `origin: []`) AND dynamically manages per-item subscriptions. The transformer maintains its own `Map<number, () => void>` of active per-item unsubscribe functions, independent of the readable layer's `childCache`. On `SequenceChange`: parse ops to determine inserts/deletes, unsubscribe from removed items, force-materialize new items via `.at(newIndex)` (store is already updated, cache already invalidated by `withMutation`), subscribe to their changefeeds, and shift tracking for retained items. Attach `[CHANGEFEED]` and `[CONTEXT]`. 🔴
- Task: **Map case**: Produce a `ComposedChangefeed`. Similar to sequence — maintains its own `Map<string, () => void>` of per-entry unsubscribe functions. `subscribe` fires on `MapChange` at this path. `subscribeTree` composes structural + per-entry content changes. On `MapChange`: subscribe to new keys (via `.at(key)`), unsubscribe from deleted keys. 🔴
- Task: **Sum case**: Delegate to base. 🔴
- Task: **Annotated case**: Dispatch on tag. `"text"`, `"counter"` → leaf, produce `Changefeed`. `"doc"`, `"movable"`, `"tree"` → delegate to inner (which handles composition). 🔴
- Task: Notification wiring — the transformer wraps `ctx.dispatch` at each node to fire that node's shallow subscribers after the store is updated. Tree notification propagates via the subscription composition (children → parent) without any flat map. 🔴
- Task: Export `withCompositionalChangefeed` from `index.ts`. 🔴

### Phase 4: Fluent Interpret Builder 🔴

- Task: Define `InterpreterLayer` interface in `interpret.ts`. 🔴
- Task: Define `InterpretBuilder` interface in `interpret.ts`. 🔴
- Task: Implement `interpret(schema, ctx)` overload that returns an `InterpretBuilder`. The existing `interpret(schema, interpreter, ctx)` signature remains. Overload resolution: if the second argument is an `Interpreter`, use the existing path; if it's a context object (no interpreter methods), return a builder. 🔴
- Task: Wrap `readableInterpreter` as `readable: InterpreterLayer`. 🔴
- Task: Wrap `withMutation` as `mutation: InterpreterLayer`. 🔴
- Task: Wrap `withCompositionalChangefeed` as `changefeed: InterpreterLayer`. 🔴
- Task: Export layers and builder types from `index.ts`. 🔴
- Task: Tests: fluent API produces refs identical to manual composition. Type-level tests verify accumulated types. 🔴

### Phase 5: Remove Old Changefeed Infrastructure 🔴

- Task: Delete `withChangefeed` decorator from `with-changefeed.ts`. If the file is empty after removing all old infrastructure, delete it. 🔴
- Task: Remove `enrich` combinator and `Decorator` type from `combinators.ts` if no other decorators remain. (Check: `enrich` is only used by `withChangefeed`.) 🔴
- Task: Remove old exports from `index.ts`: `withChangefeed`, `enrich`, `Decorator`, and any remaining old aliases (`withFeed`, `createFeedableContext`, `feedableFlush`, `FeedableContext`). 🔴
- Task: Update `example/main.ts` to use `withCompositionalChangefeed`, `CONTEXT`, transactions, and the fluent API. Remove `DOC_INTERNALS` symbol and `getInternals`. 🔴
- Task: Update `packages/core/src/compiler/integration/schema-ssr.test.ts` — migrate from `enrich(writableInterpreter, withChangefeed)` to `withCompositionalChangefeed(writableInterpreter)`. 🔴
- Task: Delete old test cases in `with-changefeed.test.ts` that test removed infrastructure. Consolidate remaining valid test scenarios into `composed-changefeed.test.ts` if not already covered. 🔴

### Phase 6: Documentation 🔴

- Task: Update `TECHNICAL.md`: document `ComposedChangefeed` / `TreeEvent` protocol, the two-coalgebra design, the interpreter transformer approach, `CONTEXT` symbol, transaction API, fluent builder. Replace the "Deep Subscriptions" section with "Compositional Changefeeds" section. Update file map. Update verified properties list. 🔴
- Task: Update `theory/interpreter-algebra.md` if it references the old changefeed design. 🔴

## Tests

New test file `src/__tests__/transaction.test.ts` for context transactions (Phase 2). New test file `src/__tests__/composed-changefeed.test.ts` for the compositional behavior (Phase 3). New test file `src/__tests__/fluent.test.ts` for the builder API (Phase 4). Existing test files `writable.test.ts` and `with-changefeed.test.ts` are updated in Phase 2 to remove tests for deleted infrastructure and replace with transaction-based equivalents.

### Phase 2 Tests (in `transaction.test.ts`)

- `dispatch` applies immediately outside a transaction (store reflects change synchronously).
- `beginTransaction` → mutations do not apply to store until `commit`.
- `commit` applies all pending changes to the store via replay through `dispatch`.
- `commit` returns the list of flushed `PendingChange` entries.
- `commit` fires shallow changefeed subscribers (verified by subscribing to a scalar ref's `[CHANGEFEED]` and confirming the callback fires at commit time, not during buffered dispatch).
- `abort` discards pending changes; store is unchanged.
- `beginTransaction` while already in a transaction throws.
- `commit` without `beginTransaction` throws.
- `abort` without `beginTransaction` throws.

### Phase 3 Tests (in `composed-changefeed.test.ts`)

Risk areas and test strategies:

- **Leaf refs produce `Changefeed`, not `ComposedChangefeed`**: `hasComposedChangefeed(doc.title)` returns `false`. `hasChangefeed(doc.title)` returns `true`.
- **Product refs produce `ComposedChangefeed`**: `hasComposedChangefeed(doc.settings)` returns `true`.
- **Product `subscribe` is node-level**: subscribe to `doc.settings[CHANGEFEED]`, mutate `doc.settings.darkMode.set(true)` → callback does NOT fire. `doc.settings.set({...})` → callback fires with `ReplaceChange`.
- **Product `subscribeTree` is tree-level**: subscribe to `doc.settings[CHANGEFEED].subscribeTree(cb)`, mutate `doc.settings.darkMode.set(true)` → callback fires with `{ origin: [{type:"key",key:"darkMode"}], change: ReplaceChange }`.
- **Nested tree composition**: `subscribeTree` on doc root, mutate `doc.settings.darkMode.set(true)` → origin is `[{type:"key",key:"settings"},{type:"key",key:"darkMode"}]`.
- **Sequence `subscribe` is structural only**: subscribe to `doc.messages[CHANGEFEED]`, push an item → fires with `SequenceChange`. Mutate item content → does NOT fire.
- **Sequence `subscribeTree` includes item content**: `subscribeTree` on list, mutate item field → fires with appropriate origin.
- **Dynamic sequence subscription management**: push an item, then mutate the new item → `subscribeTree` fires. Delete an item, then mutate it → `subscribeTree` does NOT fire (subscription was cleaned up).
- **Sequence insert-in-middle resubscription**: insert at index 1 in a 3-item list, mutate the new item at index 1 → `subscribeTree` fires. Mutate the item now at index 2 (shifted from old index 1) → `subscribeTree` fires with updated origin index.
- **`subscribeTree` at own path**: structural change on a list delivers `{ origin: [], change: SequenceChange }` to tree subscribers.
- **Unsubscribe cleans up**: unsubscribe from `subscribeTree`, mutate descendants → no callback.
- **`CONTEXT` is present and correct**: `ref[CONTEXT]` returns the `WritableContext` used during interpretation.
- **Transaction + compositional notification**: `beginTransaction`, mutate two fields, `commit` → tree subscribers fire at commit time (not during mutations), receiving both changes.
- **Transaction dispatch replay**: `beginTransaction`, mutate, `commit` → verify changes go through `dispatch` (not raw `applyChangeToStore`) by confirming the compositional changefeed's dispatch wrapper fires.
- **Coexistence**: exact `subscribe` and `subscribeTree` on the same ref both fire for a change at that node's own path.

### Phase 4 Tests (in `fluent.test.ts`)

- Fluent API produces refs functionally equivalent to manual `withCompositionalChangefeed(withMutation(readableInterpreter))`.
- `.done()` returns a typed result with all accumulated capabilities.
- Existing `interpret(schema, interpreter, ctx)` still works (regression).

## Transitive Effect Analysis

### `changefeed.ts`

Gains `ComposedChangefeed`, `TreeEvent`, `HasComposedChangefeed`, `hasComposedChangefeed`. No changes to existing `Changefeed`, `HasChangefeed`, `CHANGEFEED`, `hasChangefeed`, `getOrCreateChangefeed`, `staticChangefeed`. Zero risk to existing consumers.

### `changefeed-utils.ts` (new)

Shared utilities extracted from `with-changefeed.ts`: `attachChangefeed`, `attachSymbolProperty`. The old `with-changefeed.ts` is updated to import from the new module during Phase 3. The new `with-composed-changefeed.ts` also imports from here. Zero duplication.

### `interpret.ts`

Gains overloaded `interpret` signature (builder path) and `InterpreterLayer` / `InterpretBuilder` types. Existing `interpret(schema, interp, ctx)` signature unchanged. Existing callers unaffected.

### `interpreters/writable.ts`

`WritableContext` is replaced: `autoCommit` and `pending` are removed, `beginTransaction` / `commit` / `abort` are added. `createWritableContext` no longer accepts `WritableOptions`. `flush()` is removed. `CONTEXT` symbol and `HasContext` are added. All callsites currently go through `createWritableContext()` — no hand-constructed `WritableContext` objects exist.

### `interpreters/with-changefeed.ts`

`ChangefeedContext`, `createChangefeedContext`, `changefeedFlush`, `subscribeDeep`, `DeepEvent`, `notifyAll`, `pathKey`, `subscribeToPath`, `subscribeToMap` are removed in Phase 2. The `withChangefeed` decorator is adapted to work with plain `WritableContext` during the transition (Phase 2), then removed entirely in Phase 5.

### `interpreters/readable.ts`

No modifications. The readable interpreter is the base layer — composition works through it, not by modifying it.

### `@kyneta/core` runtime (`subscribe.ts`, `regions.ts`)

**Zero changes required.** The runtime calls `ref[CHANGEFEED].subscribe(handler)`, which remains node-level on both leaf and composite refs. `listRegion` continues to receive only `SequenceChange`. `conditionalRegion` and `valueRegion` continue to work with leaf refs.

Future work: `@kyneta/core` may add a `subscribeTree` runtime helper that checks for `ComposedChangefeed` and calls `subscribeTree`. This is additive and not part of this plan.

### `@kyneta/core` compiler integration test (`schema-ssr.test.ts`)

Updated in Phase 2 to use plain `WritableContext` (removing `createChangefeedContext`). Updated in Phase 5 to use `withCompositionalChangefeed` (removing `enrich` + `withChangefeed`). This is the only external consumer.

### `@kyneta/core` compiler (`reactive-detection.ts`, `dom.ts`)

**Zero changes required.** The compiler detects reactivity via the `[CHANGEFEED]` symbol property on types. `ComposedChangefeed extends Changefeed`, so it still has `[CHANGEFEED]`. The compiler's `getDeltaKind` 7-hop type walk reads the `subscribe` method's callback parameter type — unchanged. The compiler always emits node-level subscriptions, which is exactly `Changefeed.subscribe`.

### `index.ts` barrel exports

Phase 2 removes: `ChangefeedContext`, `createChangefeedContext`, `changefeedFlush`, `flush`, `subscribeDeep`, `DeepEvent`. Phase 2 adds: `CONTEXT`, `HasContext`, `hasContext`. Phase 3 adds: `withCompositionalChangefeed`. Phase 4 adds: `InterpreterLayer`, `InterpretBuilder`, `readable`, `mutation`, `changefeed` layers. Phase 5 removes: `withChangefeed`, `enrich`, `Decorator`, old aliases.

### `example/main.ts`

Phase 5 updates the example to use the new API. The old `DOC_INTERNALS` symbol and `changefeedFlush`-based `change()` are replaced with `CONTEXT` + `beginTransaction` / `commit`. No external consumers depend on the example.

## Sequence Subscription Timing

The sequence case of `withCompositionalChangefeed` is the most complex due to dynamic child subscription management. Key timing constraint discovered during planning:

1. **Dispatch** — `ctx.dispatch(path, sequenceChange(...))` applies the change to the store synchronously (outside a transaction). The store now has the new/removed items. Shallow subscribers fire here.
2. **INVALIDATE** — `withMutation` calls `result[INVALIDATE]()` immediately after dispatch, clearing the readable interpreter's `childCache`. Old cached refs are gone.
3. **Tree subscription handler** — the composed changefeed's own shallow subscriber receives the `SequenceChange`. At this point, the store is updated and the cache is cleared. The handler can call `.at(newIndex)` to force-materialize fresh child refs with their changefeeds, then subscribe to them.

The transformer maintains its **own** `Map<number, () => void>` of per-item unsubscribe functions, independent of the readable layer's `childCache`. On structural changes, it parses the `SequenceChange` ops (retain/insert/delete) to determine which indices changed, tears down subscriptions for removed items, and rebuilds for new items. For insert-in-middle, all subscriptions at and after the insert point are torn down and re-established at shifted indices — this is O(k + shifted) per structural change, where k is the number of inserted/deleted items. For typical list operations (push, pop, splice), this is efficient.

**Known limitation**: after a structural change, old item refs (held by external code) become orphaned from the changefeed tree. The old ref's changefeed still works for direct `subscribe`, but it is no longer composed into any parent's `subscribeTree`. This is consistent with the existing behavior (structural mutations invalidate old refs via `INVALIDATE`), not a regression.

## Resources for Implementation Context

| Resource | Path | Relevance |
|---|---|---|
| Changefeed protocol | `src/changefeed.ts` | Base `Changefeed` interface — extend with `ComposedChangefeed`, `TreeEvent` |
| Current changefeed decorator | `src/interpreters/with-changefeed.ts` | Reference implementation for flat subscriber maps; extract utilities, then remove |
| Writable interpreter | `src/interpreters/writable.ts` | `WritableContext` — replace batched mode with transaction methods + `CONTEXT` symbol; `withMutation` — pattern to follow for interpreter transformer |
| Readable interpreter | `src/interpreters/readable.ts` | Base interpreter; `INVALIDATE` symbol pattern for composability hooks |
| Catamorphism | `src/interpret.ts` | `Interpreter` interface, `interpret` function — add overload and builder |
| Combinators | `src/combinators.ts` | `enrich` — understand what it can't do (no child access); `Decorator` type; remove in Phase 5 if no other users |
| Change types | `src/change.ts` | `ChangeBase`, `SequenceChange`, `MapChange`, `ReplaceChange` |
| Store utilities | `src/store.ts` | `applyChangeToStore`, `readByPath` |
| Guards | `src/guards.ts` | `isPropertyHost` — for attaching symbol properties |
| Existing changefeed tests | `src/__tests__/with-changefeed.test.ts` | Test patterns, fixtures, helpers; update in Phase 2, consolidate in Phase 5 |
| Existing writable tests | `src/__tests__/writable.test.ts` | Batched-mode tests; replace with transaction equivalents in Phase 2 |
| Example facade | `example/main.ts` | `change()`, `createDoc`, `subscribe` — rewrite in Phase 5 |
| Core runtime subscribe | `packages/core/src/runtime/subscribe.ts` | Consumes `[CHANGEFEED].subscribe` — verify no breakage |
| Core runtime regions | `packages/core/src/runtime/regions.ts` | `listRegion` subscribes to list refs — verify node-level semantics preserved |
| Core integration test | `packages/core/src/compiler/integration/schema-ssr.test.ts` | Only external consumer of `withChangefeed` and `createChangefeedContext` — update in Phases 2 and 5 |

## Learnings from Existing Codebase

These are relevant findings from `packages/core/LEARNINGS.md` and the existing plan documents:

- **`SequenceChangeOp.insert` carries items, not a count.** The "two-layer model" — change layer carries plain values, ref layer carries reactive handles. The composed changefeed's sequence handler must use `.at()` to get refs, not read from the change's insert array.
- **`subscribeWithValue`'s `getValue` closure is NOT `CHANGEFEED.current`.** The runtime's `read()` helper extracts `current` from the coalgebra, but codegen expressions may transform the value. The compositional changefeed doesn't change this — `subscribe` still emits raw changes, and the runtime still re-reads via closures.
- **`Object.defineProperty` bypasses Proxy `set` traps.** From `.plans/feed-separation.md` — when attaching symbol properties to Proxy-backed objects (like map refs), use `Object.defineProperty` not assignment. The `attachChangefeed` utility already does this correctly; `attachSymbolProperty` for `[CONTEXT]` must follow the same pattern.
- **`getOrCreateChangefeed` WeakMap caching.** `LocalRef` uses this for its `[CHANGEFEED]` getter. The compositional changefeed creates changefeeds during interpretation (not lazily), so this caching pattern is not needed — but `LocalRef` and other external implementors continue to use it unchanged.
- **`INVALIDATE` uses `Symbol.for("schema:invalidate")` — the namespace predates the `kyneta:` convention.** The new `CONTEXT` symbol uses `Symbol.for("kyneta:context")` to follow the convention established by `CHANGEFEED` (`Symbol.for("kyneta:changefeed")`). `INVALIDATE` is not renamed — it's an internal composability hook, not a public protocol symbol.

## Alternatives Considered

### Extend `Changefeed.subscribe` to be Deep by Default

Make `subscribe` on composite refs naturally deep — emitting all descendant changes. This would break `listRegion`, which subscribes to list refs and only expects `SequenceChange`. It would also change the callback signature (needing origin paths), breaking backward compatibility. Rejected for breakage and for violating the existing Moore machine contract.

### Add `subscribeShallow` Instead of `subscribeTree`

Keep `subscribe` as the deep stream, add `subscribeShallow` for node-level. This inverts the current semantics — `subscribe` changes meaning on composite refs. Every existing caller would need updating. The "shallow" name implies the method is the special case, but node-level is what existing code overwhelmingly uses. Rejected for breaking existing consumers and misleading naming.

### Options Parameter on `subscribe`

`subscribe(callback, { deep: true })` — adds an options bag to the Moore machine. Changes the callback signature (deep callbacks need origin). Overloaded signatures or union callback types. Muddles the clean coalgebra. Rejected for complexity.

### New `DEEP_CHANGEFEED` Symbol

Separate symbol for tree-level observation. Every enriched object carries two symbols. Makes deep subscription a per-node protocol rather than an interface extension. More conceptual overhead for consumers. Rejected for proliferating symbols and conceptual weight.

### Keep `subscribeDeep` as Context-Level Function

Leave the current architecture and just fix `changefeedFlush`. This works for the immediate `change()` bug but leaves the fundamental composition gap: `subscribeDeep` requires the raw context, isn't part of the `[CHANGEFEED]` protocol, and can't be used by the compiled runtime. The flat subscriber map scales poorly and duplicates the tree structure the schema already defines. Rejected as a long-term solution.

### Refs Carry Context Reference Without Compositional Changefeeds

Add `[CONTEXT]` to refs so `change()` can find its context, but keep flat subscriber maps. This solves the `change()` problem but not the composition problem. The flat maps and `subscribeDeep` remain. It's half a solution. Rejected as incomplete — if we're touching the changefeed layer, we should solve both problems.

### Compositional Changefeeds Without Transaction-on-Context

Build composed changefeeds but keep the re-interpretation approach for `change()`. The compositional design makes notification routing natural (subscribers are on the refs), but re-interpretation still creates unnecessary allocations. Adding transactions to the context is a small incremental cost that completes the design. Rejected as leaving known inefficiency on the table.

### Patch `changefeedFlush` with `notifyCtx` Parameter

Add an optional second parameter to `changefeedFlush(ctx, notifyCtx?)` so the original context's subscribers get notified during batch flush. This fixes the immediate `change()` bug but adds API surface that is immediately superseded by the transaction API. The deeper problem is that `autoCommit: false` forces a second context, and a notification-target parameter is a band-aid on that structural issue. Rejected as churn — transactions eliminate the root cause.

### Keep `autoCommit` / `pending` / `flush` Alongside Transactions

Add transactions as an additional mechanism while keeping the old batched mode. Two ways to do the same thing is confusing — callers must choose between `autoCommit: false` + `flush()` and `beginTransaction()` + `commit()` with no clear guidance. The old mechanism also leaks internal state (`pending` is public on the interface) and has the `change()` bug baked in. Since all callsites go through `createWritableContext()` and this is experimental with no production dependents, there's no reason to maintain both. Rejected for unnecessary complexity.