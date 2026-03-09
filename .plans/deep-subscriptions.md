# Deep Subscriptions

## Background

The `withChangefeed` observation layer in `packages/schema` attaches `[CHANGEFEED]` coalgebras to interpreted ref objects. Each `Changefeed` has `current` (live value) and `subscribe` (change stream) — a Moore machine. Subscriptions are exact-path: when a change dispatches at path `P`, only callbacks registered at exactly `P` are notified.

This works well for leaf-level observation ("tell me when this text field changes") but fails for subtree observation ("tell me when anything in this document changes"). In Loro and most reactive document systems, subscribing to a node implies subscribing to its entire subtree. A React component rendering a settings panel needs to know when *any* setting changes, not just a specific one.

The current system has an accidental partial solution: `ScalarRef.set()` dispatches a `MapChange` to the *parent* path (the "upward reference" pattern), so subscribing to a product node does catch scalar field mutations within it. But `TextRef.insert()`, `CounterRef.increment()`, and `SequenceRef.push()` all dispatch at their *own* path — a subscriber on the parent never sees these.

Before implementing deep subscriptions, the vocabulary throughout the package must be updated: `Feed` → `Changefeed`, `ActionBase` → `ChangeBase`, `head` → `current`, `Feedable` → `HasChangefeed`, `FEED` → `CHANGEFEED`. This clarifies intent — "actions" doesn't capture the idea of a delta or change, and "changefeed" is a well-known term (CouchDB, RethinkDB, Fauna).

## Problem Statement

1. There is no way to subscribe to a subtree of the document. A callback registered at path `[]` (the doc root) does not fire when `doc.title.insert(0, "X")` dispatches a `TextChange` at path `["title"]`.
2. The current vocabulary (`Feed`, `ActionBase`, `head`) is imprecise. "Action" suggests intent, not delta. "Feed" is generic. "head" is confusing (coalgebra jargon). The rename to `Changefeed`, `ChangeBase`, `current` maps cleanly to intent.

## Success Criteria

1. **Vocabulary rename (prerequisite).** All references to `Feed` → `Changefeed`, `ActionBase` → `ChangeBase`, `head` → `current`, `Feedable` → `HasChangefeed`, `FEED` → `CHANGEFEED`, `isFeedable` → `hasChangefeed`, `withFeed` → `withChangefeed`, `FeedableContext` → `ChangefeedContext`, `createFeedableContext` → `createChangefeedContext`, `feedableFlush` → `changefeedFlush` across all source, test, example, and documentation files. The symbol string changes from `"kinetic:feed"` to `"kinetic:changefeed"`. All action types extend `ChangeBase` instead of `ActionBase` (type alias `ActionBase = ChangeBase` kept temporarily for migration). All 386 existing tests pass after rename.
2. A new `subscribeDeep(ctx, path, callback)` function allows subscribing to all changes dispatched at `path` or any descendant of `path`.
3. The callback receives a `DeepEvent` envelope containing the **relative** origin path (from the subscriber's position to the dispatch point) and the change.
4. The existing `Changefeed.subscribe` (exact-path) behavior is unchanged.
5. The `Changefeed` interface, `HasChangefeed` interface, and `CHANGEFEED` symbol are untouched by the deep subscription work.
6. Deep subscriptions work in both auto-commit and batched (`changefeedFlush`) modes.
7. Unsubscribe works correctly — no leaked notifications after unsubscribe.
8. Multiple deep subscribers at different ancestor levels all fire for a single dispatch.
9. Deep subscribers coexist with exact subscribers — both fire when a dispatch matches both.
10. Performance is O(depth) per dispatch for the ancestor walk, where depth is typically 3–5 levels.

## Gap

- The vocabulary is imprecise: `Feed`, `ActionBase`, `head`, `Feedable`, `FEED`, `isFeedable`, `withFeed`, `FeedableContext`, `createFeedableContext`, `feedableFlush` all need renaming.
- `notifySubscribers` does exact-match lookup only — no ancestor traversal.
- `ChangefeedContext` (currently `FeedableContext`) has one subscriber map — no deep subscriber infrastructure.
- `createChangefeedContext`'s `wrappedDispatch` calls `notifySubscribers` once — no ancestor walk.
- `changefeedFlush` calls `notifySubscribers` once per flushed change — same limitation.
- No `DeepEvent` type exists.
- No `subscribeDeep` function exists.
- No barrel export for any of the above.

## Design Decisions

### Vocabulary rename as prerequisite, not interleaved

The rename is a mechanical, behavior-preserving transformation that must complete before any deep subscription logic is added. Interleaving rename with feature work would create a confusing diff. The rename phase has zero behavioral changes — all 386 tests must pass identically afterward.

### `ChangeBase` as the new base, `ActionBase` as deprecated alias

All built-in change types (`TextAction` → `TextChange`, etc.) extend `ChangeBase`. A `type ActionBase = ChangeBase` alias is kept in `action.ts` (now `change.ts`) for any external consumers during migration, but all internal code uses `ChangeBase`. The action type names themselves rename: `TextAction` → `TextChange`, `SequenceAction` → `SequenceChange`, `MapAction` → `MapChange`, `ReplaceAction` → `ReplaceChange`, `TreeAction` → `TreeChange`, `IncrementAction` → `IncrementChange`. Corresponding type guards rename: `isTextAction` → `isTextChange`, etc. Constructors rename: `textAction` → `textChange`, etc. The `step.ts` module renames its functions: `stepText`, `stepSequence`, etc. remain unchanged (they describe the operation, not the type).

### Relative origin, not absolute

When a deep subscriber at path `["settings"]` receives a dispatch from `["settings", "darkMode"]`, the `origin` field is `[{type:"key", key:"darkMode"}]` — relative to the subscriber's position. This matches the mental model: "within my subtree, what changed?" It also makes the subscriber portable — it doesn't encode knowledge of its absolute position in the tree.

### Function on context, not method on Changefeed

`subscribeDeep` is `(ctx: ChangefeedContext, path: Path, callback) => unsubscribe`. It operates on the context's subscriber infrastructure, not on the `Changefeed` coalgebra. The `Changefeed` interface stays a pure Moore machine. This keeps the clean separation: `Changefeed` is the node-level reactive protocol, `withChangefeed` / `subscribeDeep` are context-level observation infrastructure. The documentation must make this layering explicit.

### Separate map, not a flag in the existing map

Deep subscribers live in a `deepSubscribers` map on `ChangefeedContext`, structurally identical to `subscribers` but with `DeepEvent` callbacks. This avoids changing the callback signature of the existing map and keeps the two notification paths independent.

### Unified `notifyAll` replaces parallel call sites

The current code calls `notifySubscribers` in two places (`wrappedDispatch` and `changefeedFlush`). Adding deep notification would double this to four parallel calls. Instead, a single `notifyAll(ctx, path, change)` function handles both exact and deep notification. Both `wrappedDispatch` and `changefeedFlush` call `notifyAll` once. This keeps the "all notification for a dispatch" concept in one place.

### `Path` array walk, not NUL-string slicing

The ancestor walk iterates the `Path` array from `path.length` down to `0`, computing `pathKey(path.slice(0, i))` for each prefix. This directly yields `path.slice(i)` as the relative origin — no key-to-segment-count mapping needed. For typical document depths of 3–5, the O(depth) array slicing is trivially fast and far simpler than reverse-scanning NUL separators.

### Generic `subscribeToMap` eliminates subscribe boilerplate

`subscribeToPath` and the new deep subscribe share identical map-management logic (get-or-create Set, add callback, return cleanup function). A generic `subscribeToMap<T>(map, key, callback): () => void` helper eliminates this duplication. Both exact and deep subscribe delegate to it.

## Types

After the Phase 0 rename, the core types are:

```ts
// change.ts (renamed from action.ts)
interface ChangeBase {
  readonly type: string
}

// changefeed.ts (renamed from feed.ts)
const CHANGEFEED: unique symbol = Symbol.for("kinetic:changefeed") as any

interface Changefeed<S, C extends ChangeBase = ChangeBase> {
  readonly current: S
  subscribe(callback: (change: C) => void): () => void
}

interface HasChangefeed<S = unknown, C extends ChangeBase = ChangeBase> {
  readonly [CHANGEFEED]: Changefeed<S, C>
}
```

New types for deep subscriptions (Phase 1):

```ts
interface DeepEvent {
  /** Path from the subscriber's position to the dispatch origin */
  readonly origin: Path
  /** The change that was dispatched */
  readonly change: ChangeBase
}
```

`ChangefeedContext` gains one new field:

```ts
interface ChangefeedContext extends WritableContext {
  readonly subscribers: Map<string, Set<(change: ChangeBase) => void>>
  readonly deepSubscribers: Map<string, Set<(event: DeepEvent) => void>>
}
```

Public function:

```ts
function subscribeDeep(
  ctx: ChangefeedContext,
  path: Path,
  callback: (event: DeepEvent) => void,
): () => void
```

## Phase 0: Vocabulary rename ✅

Mechanical, behavior-preserving rename. Zero behavioral changes. All 386 tests must pass identically afterward.

### File renames

- Task: Rename `src/action.ts` → `src/change.ts`. ✅
- Task: Rename `src/feed.ts` → `src/changefeed.ts`. ✅
- Task: Rename `src/interpreters/with-feed.ts` → `src/interpreters/with-changefeed.ts`. ✅
- Task: Rename `src/__tests__/with-feed.test.ts` → `src/__tests__/with-changefeed.test.ts`. ✅

### Type and interface renames

- Task: In `change.ts`: rename `ActionBase` → `ChangeBase`, add `type ActionBase = ChangeBase` deprecated alias. Rename all built-in types: `TextAction` → `TextChange`, `TextActionOp` → `TextChangeOp`, `SequenceAction` → `SequenceChange`, `SequenceActionOp` → `SequenceChangeOp`, `MapAction` → `MapChange`, `ReplaceAction` → `ReplaceChange`, `TreeAction` → `TreeChange`, `TreeActionOp` → `TreeChangeOp`, `IncrementAction` → `IncrementChange`, `BuiltinAction` → `BuiltinChange`, `Action` → `Change`. Rename type guards: `isTextAction` → `isTextChange`, etc. Rename constructors: `textAction` → `textChange`, etc. ✅
- Task: In `changefeed.ts`: rename `FEED` → `CHANGEFEED` (symbol string `"kinetic:feed"` → `"kinetic:changefeed"`), `Feed` → `Changefeed` (field `head` → `current`), `Feedable` → `HasChangefeed`, `getOrCreateFeed` → `getOrCreateChangefeed`, `isFeedable` → `hasChangefeed`, `staticFeed` → `staticChangefeed`. Internal `feeds` WeakMap → `changefeeds`. ✅
- Task: In `with-changefeed.ts`: rename `withFeed` → `withChangefeed`, `FeedableContext` → `ChangefeedContext`, `createFeedableContext` → `createChangefeedContext`, `feedableFlush` → `changefeedFlush`. Update all internal references from `ActionBase` → `ChangeBase`, `FEED` → `CHANGEFEED`, `Feed` → `Changefeed`, `head` → `current`, `action` parameter names → `change`. ✅

### Consumer updates (mechanical find-and-replace)

- Task: Update `step.ts` — change `ActionBase` imports to `ChangeBase` from `change.ts`. Keep function names (`stepText`, `stepSequence`, etc.) unchanged. ✅
- Task: Update `interpreters/writable.ts` — change `ActionBase` → `ChangeBase` imports, `textAction` → `textChange`, `sequenceAction` → `sequenceChange`, `mapAction` → `mapChange`, `replaceAction` → `replaceChange`, `incrementAction` → `incrementChange`. Update `WritableContext.dispatch` signature, `PendingAction.action` → `PendingAction.change`, `applyActionToStore` → `applyChangeToStore`. ✅
- Task: Update `interpreters/plain.ts` — no changes expected (doesn't reference actions). Verify. ✅
- Task: Update `interpreters/zero.ts` — no changes expected. Verify. ✅
- Task: Update `interpreters/validate.ts` — no changes expected (doesn't reference actions). Verify. ✅
- Task: Update `combinators.ts` — update JSDoc references to `Feed` → `Changefeed`, `FEED` → `CHANGEFEED`, `withFeed` → `withChangefeed`. ✅
- Task: Update `index.ts` barrel — rename all re-exports. Keep deprecated aliases: `type ActionBase = ChangeBase`, `const FEED = CHANGEFEED`, `const isFeedable = hasChangefeed`, `type Feed = Changefeed`, `type Feedable = HasChangefeed`, `const withFeed = withChangefeed`, `type FeedableContext = ChangefeedContext`, `const createFeedableContext = createChangefeedContext`, `const feedableFlush = changefeedFlush`. These aliases can be removed in a future breaking change. ✅

### Test and example updates

- Task: Update all test files — replace `FEED` → `CHANGEFEED`, `isFeedable` → `hasChangefeed`, `ActionBase` → `ChangeBase`, `withFeed` → `withChangefeed`, `createFeedableContext` → `createChangefeedContext`, `feedableFlush` → `changefeedFlush`, `Symbol.for("kinetic:feed")` → `Symbol.for("kinetic:changefeed")`, `.head` → `.current`, `getFeed` → `getChangefeed`, test description strings ("feed" → "changefeed"). ✅
- Task: Update `example/main.ts` — rename all imports and usages. `ActionBase` → `ChangeBase`, `Feed` → `Changefeed`, `FEED` → `CHANGEFEED`, `isFeedable` → `hasChangefeed`, `FeedableContext` → `ChangefeedContext`, `createFeedableContext` → `createChangefeedContext`, `feedableFlush` → `changefeedFlush`, `.head` → `.current`. Update `subscribe` facade function. ✅
- Task: Update `example/README.md` — rename references. ✅
- Task: Update `TECHNICAL.md` — rename all vocabulary throughout. ✅
- Task: Verify all 386 tests pass. ✅

## Phase 1: Implement deep subscriptions ✅

- Task: Define `DeepEvent` interface in `with-changefeed.ts`. ✅
- Task: Add `deepSubscribers` map to `ChangefeedContext` interface. ✅
- Task: Extract generic `subscribeToMap<T>(map: Map<string, Set<T>>, key: string, callback: T): () => void` helper. Refactor existing `subscribeToPath` to delegate to it. The new deep subscribe will also delegate to `subscribeToMap`. ✅
- Task: Create `notifyAll(ctx: ChangefeedContext, path: Path, change: ChangeBase)` — a single function that handles all notification for a dispatch: ✅
  1. Exact subscribers: look up `pathKey(path)` in `ctx.subscribers`, invoke matching callbacks with `change`.
  2. Deep subscribers: walk `i` from `path.length` down to `0`, compute `pathKey(path.slice(0, i))`, look up in `ctx.deepSubscribers`, invoke matching callbacks with `{ origin: path.slice(i), change }`.
- Task: Refactor `notifySubscribers` out of existence — its logic is subsumed by the exact-subscriber branch of `notifyAll`. The existing `createChangefeedForPath` still calls `subscribeToPath` for exact subscription registration (unchanged). ✅
- Task: Create public `subscribeDeep(ctx, path, callback)` — computes `pathKey(path)` and delegates to `subscribeToMap(ctx.deepSubscribers, key, callback)`. ✅
- Task: Update `createChangefeedContext` — initialize `deepSubscribers: new Map()` on the returned context. Replace `notifySubscribers` call in `wrappedDispatch` with `notifyAll(ctx, path, change)` (in auto-commit mode). Note: `notifyAll` needs the full `ChangefeedContext`, so the context object must be created before the dispatch closure captures it (use a mutable ref or a let-then-assign pattern). ✅
- Task: Update `changefeedFlush` — replace `notifySubscribers(ctx.subscribers, path, change)` with `notifyAll(ctx, path, change)`. ✅
- Task: Export `subscribeDeep` and `DeepEvent` from `with-changefeed.ts`. ✅
- Task: Update barrel exports in `index.ts` — add `subscribeDeep` to the value exports and `DeepEvent` to the type exports from `with-changefeed.ts`. ✅

## Phase 2: Tests ✅

All tests go in the existing `src/__tests__/with-changefeed.test.ts` file, extending the current test suite. 11 new tests (397 total).

- Task: Test — deep subscriber on root receives text change from `doc.title.insert()`. Verify `event.origin` is `[{type:"key", key:"title"}]` and `event.change.type` is `"text"`. ✅
- Task: Test — deep subscriber on root receives counter change from `doc.count.increment()`. Verify `event.origin` is `[{type:"key", key:"count"}]` and `event.change.type` is `"increment"`. ✅
- Task: Test — deep subscriber on root receives sequence change from `doc.messages.push()`. Verify origin is `[{type:"key", key:"messages"}]`. ✅
- Task: Test — deep subscriber on `doc.settings` receives scalar set change dispatched to `["settings"]` (the upward-reference MapChange). Verify `event.origin` is `[]` (dispatch is at the subscriber's own path — zero-length relative path). ✅
- Task: Test — deep subscriber on root receives scalar set from `doc.settings.darkMode.set()`. Since the scalar dispatches a MapChange to `["settings"]` (not `["settings", "darkMode"]`), verify the deep subscriber on root gets `origin: [{type:"key", key:"settings"}]`. ✅
- Task: Test — unsubscribe stops delivery. Subscribe deep, receive a change, unsubscribe, mutate again, verify no new callback. ✅
- Task: Test — multiple deep subscribers at different levels. Deep subscribe at root and at `settings`. Dispatch at `["settings"]`. Both fire. Root gets `origin: [{type:"key", key:"settings"}]`, settings subscriber gets `origin: []`. ✅
- Task: Test — deep subscriber and exact subscriber coexist. Exact subscribe to `["title"]` and deep subscribe to `[]`. `doc.title.insert()` fires both. ✅
- Task: Test — batched mode: deep subscribers fire during `changefeedFlush`, not during dispatch. ✅
- Task: Test — deep subscriber on list receives change from nested item field. Push a message, then verify deep subscriber on `["messages"]` gets a `SequenceChange` at `origin: []` (push dispatches at `["messages"]` itself). ✅
- Task: Test — deep subscriber does NOT fire for sibling paths. Deep subscribe to `["settings"]`, mutate `doc.title`. Verify no callback. ✅
- Task: Test — existing exact-path subscription tests still pass (regression). No changes to existing tests needed — they exercise `Changefeed.subscribe` which delegates to `subscribeToPath` → `subscribeToMap`, and notification still works through `notifyAll`. Run full suite to confirm. ✅

## Phase 3: Documentation 🔴

- Task: Update `TECHNICAL.md` — add a "Deep Subscriptions" subsection after the Changefeed subsection. Document: (a) the two-layer design — `Changefeed` is the node-level protocol (Moore machine, unchanged), `subscribeDeep` is context-level observation infrastructure; (b) `DeepEvent` envelope with relative origin semantics; (c) `notifyAll` as the single notification engine; (d) the ancestor walk algorithm; (e) that `subscribeDeep` is purely additive — no existing behavior changes. 🔴
- Task: Update `example/main.ts` — add a section demonstrating `subscribeDeep` on the doc root, showing that mutations to title, stars, and settings all fire the deep subscriber with correct origin paths. Use `formatPath` from the validate interpreter for human-readable output. 🔴
- Task: Update `example/README.md` — add deep subscription to the section list. 🔴

## Tests

Risk areas and their test coverage:

- **Ancestor walk correctness.** The core algorithm walks from the dispatch path up to root, computing relative origins at each level. The multi-level test (root + settings) validates this. The sibling-exclusion test confirms non-ancestors are skipped.
- **Relative origin computation.** Every test asserts the exact `origin` path. The settings-level test with `origin: []` confirms the edge case where dispatch is at the subscriber's own path.
- **Scalar upward dispatch interaction.** Scalars dispatch MapAction to the parent, not to themselves. The `darkMode.set()` test validates that deep subscribers see this at the correct path (the parent, not the scalar).
- **Batched mode parity.** The flush test confirms deep subscribers fire at flush time, not at dispatch time.
- **Exact + deep coexistence.** The coexistence test validates that both fire without interference.
- **`notifyAll` refactor regression.** Existing exact-path tests exercise the notification path through `notifyAll`. If the refactor breaks exact notification, existing tests fail. Explicit regression task in Phase 2 confirms this.

## Transitive Effect Analysis

### Phase 0 (vocabulary rename)

**Every source file in `packages/schema/src/` is touched.** The rename is mechanical but wide. Key risk: missing a reference, causing a compile error. Mitigation: `tsc --noEmit` after rename, plus all 386 tests.

**`action.ts` → `change.ts` affects every file that imports from it.** Consumers: `step.ts`, `interpreters/writable.ts`, `interpreters/with-changefeed.ts`, `index.ts`. All import paths must update.

**`feed.ts` → `changefeed.ts` affects:** `interpreters/with-changefeed.ts`, `index.ts`, `combinators.ts` (JSDoc only). All import paths must update.

**`interpreters/with-feed.ts` → `interpreters/with-changefeed.ts` affects:** `index.ts` import path.

**Symbol string change (`"kinetic:feed"` → `"kinetic:changefeed"`)** means any code using `Symbol.for("kinetic:feed")` directly (tests, example) must update. The `CHANGEFEED` export hides this for normal consumers.

**Deprecated aliases in `index.ts`** ensure that if any external code somehow imported the old names, it still compiles. Since this package has no external consumers, the aliases are a safety net that can be removed later.

### Phase 1 (deep subscriptions)

**`ChangefeedContext` interface gains a field.** This is the only structural change. All code that creates a `ChangefeedContext` (only `createChangefeedContext`) needs to initialize the new field. The new `deepSubscribers` is only read by `notifyAll` and `subscribeDeep`.

**`notifySubscribers` is removed.** Its two call sites (`wrappedDispatch` and `changefeedFlush`) are replaced by `notifyAll`. No external code calls `notifySubscribers` — it is module-private. The `subscribeToPath` function is unchanged (it still registers exact callbacks in `ctx.subscribers`). `createChangefeedForPath` still calls `subscribeToPath`. No risk to exact-path subscription registration or `Changefeed.subscribe` behavior.

**`subscribeToPath` is refactored to delegate to `subscribeToMap`.** The signature and behavior are identical. `createChangefeedForPath` calls `subscribeToPath` and is unaffected.

**`changefeedFlush` changes from `notifySubscribers(ctx.subscribers, path, change)` to `notifyAll(ctx, path, change)`.** The exact notification behavior is identical; deep notification is additive. If no deep subscribers exist, the ancestor walk finds nothing and returns — zero overhead.

**No changes to:** `Changefeed`, `HasChangefeed`, `CHANGEFEED`, `Interpreter`, `interpret`, `writableInterpreter`, `plainInterpreter`, `zeroInterpreter`, `validateInterpreter`, `Schema`, `LoroSchema`, `describe`, `Zero`, `step`, any ref types (`TextRef`, `CounterRef`, `ScalarRef`, `SequenceRef`), `Plain<S>`, `Writable<S>`.

## Resources for Implementation Context

| Resource | Path | Relevance |
|---|---|---|
| Changefeed infrastructure | `packages/schema/src/interpreters/with-changefeed.ts` | Primary file to modify — subscriber maps, notification, context |
| Changefeed protocol | `packages/schema/src/changefeed.ts` | `Changefeed`, `HasChangefeed`, `CHANGEFEED` — must NOT change (after Phase 0) |
| Path types | `packages/schema/src/interpret.ts` | `Path`, `PathSegment` types |
| formatPath | `packages/schema/src/interpreters/validate.ts` | Utility for readable paths (useful in example demo) |
| Writable interpreter | `packages/schema/src/interpreters/writable.ts` | Dispatch patterns — which refs dispatch where |
| Change types | `packages/schema/src/change.ts` | `ChangeBase` and built-in change types |
| Existing changefeed tests | `packages/schema/src/__tests__/with-changefeed.test.ts` | Test helpers, fixtures, patterns to follow |
| Feed separation learnings | `.plans/feed-separation.md` | `Object.defineProperty` bypasses Proxy traps; decorator mutation pattern |
| Barrel exports | `packages/schema/src/index.ts` | Add new exports |
| TECHNICAL.md | `packages/schema/TECHNICAL.md` | Update with deep subscription docs |
| Example | `packages/schema/example/main.ts` | Add deep subscription demo |

## Alternatives Considered

### Extend `Changefeed.subscribe` with an options parameter

Adding `subscribe(callback, { deep: true })` would keep a single subscription API but forces the `Changefeed` interface to grow. The `Changefeed` is a mathematical object — a coalgebra with `current` and `subscribe`. Adding options muddies the clean Moore machine semantics. The `deep` boolean also changes the callback signature (from `(change: C) => void` to `(event: DeepEvent) => void`), which means overloaded signatures or a union callback type. Rejected for complexity and impurity.

### Attach `subscribeDeep` as a method on the ref objects

Could attach `subscribeDeep` via `Object.defineProperty` alongside `[CHANGEFEED]`, making it available as `doc.subscribeDeep(cb)`. But ref objects are produced by the writable interpreter and have clean, schema-determined interfaces. Adding subscription methods to them conflates the mutation concern (writable) with the observation concern (changefeed). The current design keeps these orthogonal: writable produces refs, `withChangefeed` attaches `[CHANGEFEED]`. Deep subscription should stay in the observation layer.

### Bubble via a new symbol (e.g. `DEEP_CHANGEFEED`)

A `[DEEP_CHANGEFEED]` symbol on each object would carry a `{ subscribe(cb) }` interface for deep subscriptions. This is structurally clean but means every enriched object carries two symbols. It also makes deep subscription a per-node protocol rather than a context-level operation. Since deep subscription is really "notify me about dispatches in this subtree of the store" — a property of the observation infrastructure, not of individual nodes — a context-level function is more appropriate.

### Wildcard path patterns in the existing subscriber map

Instead of a separate map, use glob-like patterns (`settings.*`) in the existing `subscribers` map. This conflates two different subscription semantics into one map, makes `pathKey` more complex, and requires pattern matching on every notification. A separate `deepSubscribers` map is simpler and keeps the two notification paths independent with zero overhead when deep subscriptions aren't used.

### NUL-string slicing for ancestor walk

The original plan proposed slicing the `pathKey` string at NUL separators from right to left to avoid recomputing `pathKey` for each ancestor prefix. This is clever but creates a problem: to compute the relative `origin: Path`, you need to map from a key-string-prefix-length back to a segment count, which is fragile. Walking the `Path` array directly (`for i from path.length down to 0`) naturally yields both `pathKey(path.slice(0, i))` for lookup and `path.slice(i)` for origin. At typical depths of 3–5, the performance difference is negligible. Rejected for complexity without meaningful benefit.

## Learnings

### `Object.defineProperty` bypasses Proxy `set` traps

From the feed-separation plan: when attaching symbol-keyed protocol to Proxy-backed objects (like the Map Proxy), `Object.defineProperty` goes through the `defineProperty` trap, not the `set` trap. The `withChangefeed` decorator uses this pattern to attach `[CHANGEFEED]` to map refs without triggering the Proxy's `set` trap (which rejects symbol writes). This is already correctly implemented and unaffected by the deep subscription changes, but implementers should be aware of the pattern when debugging.

### The decorator mutation pattern

The `withChangefeed` decorator mutates the result directly via `Object.defineProperty` and returns `{}` so that `enrich`'s `Object.assign({})` is a harmless no-op. This is the correct pattern for non-enumerable symbol properties (which `Object.assign` would skip). Deep subscriptions don't change this pattern — `subscribeDeep` is a standalone function, not a decorator attachment.

### `notifyAll` is the single notification engine

Before this work, notification was a single `notifySubscribers` function called in two places. After, `notifyAll` becomes the sole notification entry point for both exact and deep subscriptions. This is a deliberate architectural choice: any future subscription mode (e.g. glob patterns, debounced, etc.) would be added as a branch inside `notifyAll` rather than as yet another parallel call site. The function is the single place to reason about "what happens when a change is dispatched."

### Generic `subscribeToMap` reveals a pattern

The `subscribeToMap<T>(map, key, callback): () => void` helper is a generic "register callback in a keyed Set map with cleanup" pattern. This same pattern appears in event emitter libraries, RxJS Subject internals, and Zustand's subscription maps. Extracting it makes the subscription infrastructure composable — if a third subscription mode appeared, it would reuse the same helper without any new map-management code.

### `createChangefeedContext` closure capture timing

The `wrappedDispatch` closure in `createChangefeedContext` currently captures `subscribers` directly (a local variable). After refactoring to use `notifyAll(ctx, path, change)`, the closure needs the full `ChangefeedContext` object — but the context object is constructed *after* the closure is defined (the closure is a field of the context). This is a circular reference: the context contains `dispatch`, and `dispatch` needs the context.

Solution: use a `let ctx` variable initialized to `undefined`, define the dispatch closure referencing `ctx`, construct the context object, then assign `ctx = constructedObject`. The closure captures the `ctx` binding (not its initial value), so by the time dispatch is called, `ctx` is populated. This is a standard JavaScript pattern for circular references in object literals.

### Vocabulary rename is wide but shallow

The Phase 0 rename touches every source file, every test file, and both documentation files. This is intentionally done as a separate, behavior-preserving commit so that the diff is reviewable as pure rename. The risk is missing a reference — mitigated by `tsc --noEmit` (catches type errors) and running all 386 tests (catches runtime mismatches). The symbol string change (`"kinetic:feed"` → `"kinetic:changefeed"`) is the one place where a missed reference would be a silent runtime bug rather than a compile error — tests that use `Symbol.for(...)` directly must be updated.

### Deep subscriber at own path fires with `origin: []`

When `i === path.length` in the ancestor walk, `path.slice(0, i) === path` and `path.slice(i) === []`. This means a deep subscriber at path `P` fires when an action dispatches at `P` itself, with `origin: []`. This is correct and desirable — "something happened at my own path" is a legitimate event for a subtree subscriber. It also means a deep subscriber is a strict superset of an exact subscriber (it sees everything an exact subscriber sees, plus descendants).