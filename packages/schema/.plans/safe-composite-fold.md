# Safe Composite Fold

## Background

Every ref in the interpreter stack is a callable function: `ref()` returns the current plain value. Under the hood, `ref()` delegates to the `[READ]` slot filled by `withReadable`. For **leaf** nodes (scalars, text, counters), `[READ]` calls `readByPath(ctx.store, path)` which returns an immutable primitive — this is correct.

For **composite** nodes (products, sequences, maps), `[READ]` also calls `readByPath(ctx.store, path)` — but this returns the **raw store object by reference**. This means:

1. `doc.settings()` returns the same object as `ctx.store.settings` — mutating the return value silently corrupts the store.
2. `doc.settings() === ctx.store.settings` — the caller holds a live reference to internal state.
3. `doc.settings() === doc.settings()` — referential equality is an accident of leaking the store, not a deliberate design choice.

The same bug exists in `withChangefeed`'s `CHANGEFEED.current` getter, which also uses `readByPath` for composite nodes. The `@kyneta/core` runtime's `read(ref)` function calls `ref[CHANGEFEED].current`, so this bug affects the compiled runtime as well.

Meanwhile, `plainInterpreter` correctly builds fresh snapshots by forcing child thunks at each level. The `.get()` methods on sequences and maps call `ref.at(i)()` which recursively folds — but only one level deep under the current bug (a nested composite child's `[READ]` still leaks the store). The top-level `ref()` on a composite does not fold at all. After the fix, `.get()` will be fully correct at all depths because every composite `[READ]` will recursively fold.

## Problem Statement

Calling `ref()` on a composite ref returns a mutable reference to the internal store object. Any external code that modifies the returned value silently corrupts the document state. This violates the expected snapshot semantics of the callable fold.

## Success Criteria

1. `ref()` on product, sequence, and map nodes returns a **fresh plain object** — structurally equal to the store value but a distinct reference. Mutating the returned value does not affect the store.
2. `CHANGEFEED.current` on composite nodes also returns a fresh plain snapshot (same fix, same code path).
3. Leaf nodes (scalars, text, counters) are unaffected — they already return immutable primitives.
4. `.get(i)` and `.get(key)` become fully correct at all depths (they already fold via `ref.at(i)()`, and the fix makes the recursive `[READ]` calls safe).
5. `plainInterpreter` remains available as a standalone interpreter for contexts where no carrier tree is needed (e.g. serialization-only, `toJSON()`).
6. All existing tests pass (with adjustments to those that implicitly relied on store identity).
7. No performance regression for leaf reads. Composite reads become O(n) where n is the number of nodes in the subtree — this is the correct cost for snapshot isolation. The deferred memoized fold (see Alternatives) addresses this for hot paths.

## PR Stack

### PR 1: `fix: ref() on composites returns fresh snapshots instead of leaking the store`

**Type**: Bug fix (tests → fix)

Covers Phases 1–3. The `withReadable` fix and the `withChangefeed` fix are the same logical change applied at two call sites. Splitting them would leave `CHANGEFEED.current` broken between PRs.

**Commits**:
1. **tests: add failing snapshot isolation tests** — `doc.settings()` mutation corrupts store (RED). `CHANGEFEED.current` same issue. Proves the bug exists.
2. **fix: composite `[READ]` folds child thunks instead of returning store reference** — Fix `withReadable` (product/sequence/map `[READ]` slots) and `withChangefeed` (`readCurrent` closures). Tests go GREEN.

### PR 2: `docs: document safe composite fold semantics`

**Type**: Documentation only

Covers Phase 4. Separate review lens (prose/accuracy vs. code/correctness).

**Commits**:
1. **docs: update TECHNICAL.md for composite fold semantics** — §withReadable, "Verified Properties" §5, `ref()` vs `plainInterpreter` relationship, file map corrections.

## Gap

- `withReadable` sets `result[READ] = () => readByPath(ctx.store, path)` for product, sequence, and map cases. This should instead force child values and assemble a fresh object.
- `withChangefeed`'s `readCurrent` closures for composite changefeed factories use the same `() => readByPath(ctx.store, path)` pattern. These should be updated to fold.
- `TECHNICAL.md` documents `readByPath` as the read mechanism but does not distinguish leaf vs composite semantics.
- The "Verified Properties" section in `TECHNICAL.md` §5 claims "Plain round-trip: `interpret(schema, plainInterpreter, store)` produces the identical object tree" — this should clarify that `ref()` now also produces fresh snapshots for composites.

## Phases

### Phase 1: Fix `[READ]` for composite nodes in `withReadable` 🟢

The product, sequence, and map cases in `withReadable` previously set `[READ]` to `readByPath`. Replaced with a fold that forces child values to produce fresh snapshots.

**Design constraint (revised during implementation)**: products access children through the carrier's navigation surface (`result[key]`) to compose with `withCaching`. Sequences and maps use the raw `item` closure instead of `result.at()` because `withCaching`'s cache shifting can leave refs with stale paths after insert/delete operations. All three produce fresh snapshot objects.

- Task: **Product `[READ]`** — iterates `Object.keys(fields)`, accesses each child via `result[key]` (the property getter, composing with caching), calls `child()`, and assembles a fresh `Record<string, unknown>`. 🟢
- Task: **Sequence `[READ]`** — reads array length from the store via `readByPath` (structure discovery), then calls `item(i)()` for each index to produce a fresh array. Uses the raw `item` closure to avoid stale-path issues with cache shifting. 🟢
- Task: **Map `[READ]`** — reads keys from the store via `readByPath` (structure discovery), then calls `item(key)()` for each key to produce a fresh record. Same raw-closure approach as sequence. 🟢
- Task: **Annotated composites** — verified: `"doc"`, `"movable"`, and `"tree"` delegate to `inner()`, whose `[READ]` is the fixed version. No change needed. 🟢

### Phase 2: Fix `CHANGEFEED.current` for composite nodes in `withChangefeed` 🟢

The changefeed factories received a `readCurrent` closure returning `readByPath(ctx.store, path)`. After Phase 1, the ref's `[READ]` already produces a safe snapshot, so `readCurrent` now delegates to `ref[READ]()`.

- Task: Added `import { READ } from "./bottom.js"` to `with-changefeed.ts`. 🟢
- Task: Product case — changed `readCurrent` from `() => readByPath(ctx.store, path)` to `() => (result as any)[READ]()`. 🟢
- Task: Sequence case — same change. 🟢
- Task: Map case — same change. 🟢
- Task: Leaf changefeed factories (`createLeafChangefeed`) unchanged — `readByPath` is correct for scalars. 🟢

### Phase 3: Tests 🟢

13 new snapshot isolation tests added across three test files. All 782 tests pass (769 original + 13 new).

- Task: Product snapshot isolation — `with-readable.test.ts` and `readable.test.ts`. Mutating `doc.settings()` does not corrupt store. Distinct references each call. 🟢
- Task: Sequence snapshot isolation — `with-readable.test.ts` and `readable.test.ts`. Pushing onto `doc.messages()` does not corrupt store. 🟢
- Task: Map snapshot isolation — `with-readable.test.ts` and `readable.test.ts`. Adding key to `doc.metadata()` does not corrupt store. 🟢
- Task: `CHANGEFEED.current` isolation — `changefeed.test.ts`. Product, sequence, and map `.current` returns fresh snapshots; mutation does not corrupt store. 🟢
- Task: Nested fold correctness — `with-readable.test.ts` and `readable.test.ts`. `doc()` returns deeply fresh snapshot. 🟢
- Task: Caching interaction — `readable.test.ts`. `withCaching` does not affect fold freshness. 🟢
- Task: Scalar unchanged — `readable.test.ts`. Leaf reads still return correct primitives. 🟢
- Task: Existing `toEqual` tests all pass unchanged. 🟢
- Task: All ~26 existing `toBe` identity tests pass unchanged (they test child ref caching, not composite `[READ]` output). 🟢

### Phase 4: Documentation 🟢

- Task: Update `TECHNICAL.md` §withReadable to document that composite `[READ]` produces a fresh snapshot via child fold, not a store reference. 🟢
- Task: Update `TECHNICAL.md` "Verified Properties" §5 to clarify snapshot freshness semantics. 🟢
- Task: Add a note to `TECHNICAL.md` explaining the relationship between `ref()` and `plainInterpreter`: both produce structurally identical output, but `ref()` folds through child `[READ]` slots (which benefits from caching layers), while `plainInterpreter` is a standalone eager fold with no carrier overhead. 🟢

## Tests

### Snapshot isolation (the primary regression tests)

- **Product snapshot isolation**: call `doc.settings()`, mutate the returned object, verify store is unchanged. Call `doc.settings()` again, verify it returns a value equal to the original (not the mutated copy). Verify `doc.settings() !== doc.settings()` (distinct references). 🔴
- **Sequence snapshot isolation**: call `doc.tasks()`, push onto the returned array, verify `doc.tasks.length` is unchanged. 🔴
- **Map snapshot isolation**: call `doc.metadata()`, add a key to the returned object, verify `doc.metadata.keys()` is unchanged. 🔴
- **CHANGEFEED.current isolation**: `doc.settings[CHANGEFEED].current` returns a fresh snapshot each access; mutating it does not affect the store. 🔴
- **Nested fold correctness**: `doc()` returns a deeply fresh snapshot where nested objects are also distinct from the store's internal objects. 🔴

### Interaction with caching

- **withCaching does not affect fold freshness**: with the full `withCaching(withReadable(bottom))` stack, `ref()` still returns a fresh snapshot. The caching layer caches child *refs*, not child *values*. 🔴

### Leaf behavior preserved

- **Scalar ref() unchanged**: `doc.name()` returns the same primitive. No regression. 🔴

## Transitive Effect Analysis

### `withReadable` (`src/interpreters/with-readable.ts`)

Direct change. Product, sequence, and map `[READ]` slots are rewritten. Scalar and annotated leaf cases unchanged.

### `withCaching` (`src/interpreters/with-caching.ts`)

**Not modified.** `withCaching` wraps field getters (product) and `.at()` (sequence/map) with memoization, but it does not touch `[READ]`. When a product ref's `[READ]` accesses `result[key]`, it goes through the cached getter — so the fold benefits from caching automatically (no redundant carrier construction). The child ref cache means that calling `doc.settings()` twice reuses the same child refs from cache but still produces distinct snapshot objects. No change needed.

### `withWritable` (`src/interpreters/writable.ts`)

**Not modified.** Mutation methods call `ctx.dispatch()` and `[INVALIDATE]`. The `[READ]` slot is not involved in mutation. The `.update()` method on text refs calls `ref()` to get the current text — this is a leaf read, unaffected. Product `.set()` does not read old values — it wraps the new value in `ReplaceChange` and dispatches directly. `sequence.push()` and `map.clear()` read from the store via `readByPath` directly (not through `[READ]`), so they are also unaffected.

### `withChangefeed` (`src/interpreters/with-changefeed.ts`)

Modified in Phase 2. The `readCurrent` closures for composite changefeed factories change from `readByPath` to `ref[READ]()`. Requires new `import { READ } from "./bottom.js"`. Leaf changefeed factories unchanged. The `ensureDispatchWiring` dispatch wrapper is unaffected.

### `plainInterpreter` (`src/interpreters/plain.ts`)

**Not modified.** Remains a standalone eager fold. Its role narrows slightly — `ref()` now produces the same output — but it's still valuable for pure serialization contexts where building a carrier tree is unnecessary overhead.

### `@kyneta/core` runtime (`subscribe.ts`)

**Not modified.** `read(ref)` calls `ref[CHANGEFEED].current`, which is fixed in Phase 2. The runtime sees fresh snapshots instead of store references. This is strictly better — no code change needed in core.

### `@kyneta/core` compiler (`reactive-detection.ts`, `dom.ts`)

**Not affected.** The compiler detects `[CHANGEFEED]` at the type level and emits subscription code. The runtime value of `current` is not inspected at compile time.

### `example/main.ts`

**Not modified.** The example calls `doc()` and `doc.toJSON()` for display. Both produce equivalent snapshots. The `toJSON()` function still uses `plainInterpreter` for its standalone fold, which remains correct.

### Existing tests

Most tests use `toEqual` (deep value comparison), not `toBe` (reference identity). The one test in `readable.test.ts` that asserts `expect(doc()).toEqual(store)` will continue to pass — the values are the same, just different references. The ~26 `toBe` assertions across `readable.test.ts` and `with-caching.test.ts` test **child ref** caching identity (e.g., `doc.settings === doc.settings`, `doc.messages.at(0) === doc.messages.at(0)`), not composite `[READ]` output — they should be unaffected because the fix accesses children through the cached navigation surface.

## Learnings

### Product fold goes through the carrier's navigation surface; sequence/map do not

The `fields` parameter in the product case contains raw child thunks. But `withCaching` overrides the product's property getters with memoized versions. If the new `[READ]` calls `fields[key]()` directly, it **bypasses** the caching layer and creates fresh uncached carrier objects on every `ref()` call. The correct approach for products is `result[key]()` — access the child through the property getter (which `withCaching` may have wrapped), then invoke the child's `[READ]`.

There is no circular reference concern for products: `result[READ]` accesses `result[key]`, which returns a *child ref*, then `child()` invokes the *child's* `[READ]`. The tree is acyclic by construction.

**However**, this approach does NOT work for sequences and maps. During implementation we discovered that `withCaching`'s cache shifting (after insert/delete on sequences) leaves shifted refs with **stale paths** — a ref created for index 1 still reads `store.items[1]` even after being shifted to cache index 0. The old `readByPath`-based `[READ]` masked this because it read the whole array/object directly. The fold-through-cache approach exposed the stale-path issue, causing the `writable.test.ts` test `"after delete(0, 1), cache shifts preserve ref identity"` to fail: `doc.items()` returned `[{name:"c"}, {name:undefined}]` instead of `[{name:"b"}, {name:"c"}]`.

The fix: sequences and maps use the raw `item` closure (`item(i)()` / `item(key)()`) which creates a fresh child ref at the correct current path. Products can safely go through the cache because product field keys are stable (never shifted).

| Node type | Structure discovery | Child access | Why |
|---|---|---|---|
| Product | `Object.keys(fields)` | `result[key]()` (cached navigation) | Keys are stable — no shifting |
| Sequence | `readByPath` → array length | `item(i)()` (raw closure) | Cache shifting leaves stale paths |
| Map | `readByPath` → `Object.keys(obj)` | `item(key)()` (raw closure) | Keys can be dynamically added/removed |

### Sequence/map fold still needs `readByPath` for structure discovery

Unlike products (where `fields` keys are schema-derived and statically known), sequences and maps must discover their runtime shape (array length / object keys) from the store. The fold still calls `readByPath` for this structure discovery — but only to learn *how many* children exist and *what keys* they have, never to extract their *values*. The actual values come from forcing child `[READ]` calls through `item(...)()`.

### `READ` is not currently imported in `with-changefeed.ts`

The plan originally claimed `READ` was "already imported in `with-changefeed.ts` (or can be imported from `bottom.ts`)." Research confirmed it is **not** imported. The file imports `readByPath` from `../store.js` and `CHANGEFEED` from `../changefeed.js`, but not `READ`. The `READ` symbol is defined and exported from `src/interpreters/bottom.ts` (L60) as `Symbol.for("kyneta:read")`. Phase 2 must add `import { READ } from "./bottom.js"`.

### `.get()` depth correctness depends on this fix

The plan originally said `.get(i)` and `.get(key)` "already do the right thing." This is only true one level deep. `.get(i)` calls `result.at(i)()` — if the child is a leaf, this returns a primitive (correct). But if the child is a nested composite, `child()` invokes the child's (currently broken) `[READ]`, which leaks the store reference. After this fix, the recursive `[READ]` calls are all safe, making `.get()` correct at all depths.

### Existing test landscape is safe but for specific reasons

The ~26 `toBe` assertions in `readable.test.ts` and `with-caching.test.ts` test **child ref identity** (navigation caching), not **composite `[READ]` output identity**. They will pass because:
1. The fix accesses children through `result[key]` / `result.at(...)` (the cached navigation surface)
2. `withCaching` memoizes those getters/`.at()` calls
3. The `toBe` tests assert that repeated *navigation* returns the same *ref* — they don't assert anything about the *value* returned by calling that ref

No existing test asserts `doc() === store` or `doc.settings() === ctx.store.settings` — the reference-leak behavior was never tested for, just accidentally relied upon.

### Transaction interaction with `.current`

`CHANGEFEED.current` is a synchronous getter, not a listener — so the `inTransaction` guard (current commit) doesn't affect it. If someone reads `.current` during a transaction, they get whatever the store currently holds (which may or may not reflect buffered changes, depending on commit status). After the fix, `.current` folds through `[READ]` which reads from `ctx.store`, so it reflects the store's actual state at call time.

## Resources for Implementation Context

| Resource | Path | Relevance |
|---|---|---|
| withReadable (the fix site) | `src/interpreters/with-readable.ts` | Product `[READ]` at L95, sequence `[READ]` at L126, map `[READ]` at L184 |
| withChangefeed (CHANGEFEED.current fix) | `src/interpreters/with-changefeed.ts` | `readCurrent` closures: product L562, sequence L591, map L628 |
| plainInterpreter (reference implementation) | `src/interpreters/plain.ts` | Shows the correct fold pattern for product/sequence/map |
| bottom.ts (READ symbol) | `src/interpreters/bottom.ts` | `READ` symbol export at L60 — needed by `with-changefeed.ts` Phase 2 import |
| store.ts (readByPath) | `src/store.ts` | Current implementation at L48–54 — pure pointer traversal, no cloning |
| with-caching.ts | `src/interpreters/with-caching.ts` | Verify no modification needed — caches field getters (L254–262) and `.at()` (L290–301, L329–340), not `[READ]` |
| readable.test.ts | `src/__tests__/readable.test.ts` | `toEqual` snapshot tests + `toBe` caching identity tests (~6 identity assertions) |
| with-readable.test.ts | `src/__tests__/with-readable.test.ts` | `toEqual` snapshot tests + `not.toBe` assertions (expects fresh refs, no caching) |
| with-caching.test.ts | `src/__tests__/with-caching.test.ts` | `toEqual` snapshot tests + ~20 `toBe` caching identity assertions |
| changefeed.test.ts | `src/__tests__/changefeed.test.ts` | `CHANGEFEED.current` live-getter tests (L108–121); no composite ref identity tests |

## Alternatives Considered

### Keep `readByPath` and add a defensive `structuredClone`

Wrap `readByPath` with `structuredClone()` to produce a fresh copy. Rejected because: (a) `structuredClone` is slower than a targeted fold, (b) it copies data that the fold would naturally produce by forcing child `[READ]` calls, (c) it doesn't compose — the fold approach benefits from child caching layers while `structuredClone` ignores the interpreter stack entirely.

### Make `ref()` on composites throw, forcing `.toJSON()` or field access

Remove the ability to call `ref()` on products/sequences/maps. This eliminates the leak but breaks the "every ref is callable" invariant that the entire type system (`Readable<S>`) is built around. It would also break the `.get()` method on sequences and maps, which is defined as `.at(i)()`. Rejected as too disruptive.

### Cache the fold result (memoized fold / `Schema.memo()`)

Cache the snapshot returned by `ref()`, invalidated by `[INVALIDATE]`. This gives `ref() === ref()` (referential stability) which is valuable for React-style frameworks. Rejected **for this plan** — it's a separable optimization that layers on top of the safe fold. The safe fold is the correctness fix; the memoized fold is a performance feature. The memoized fold is discussed in `.plans/compositional-changefeeds.md` and will be planned separately, potentially using `Schema.memo()` annotations for per-node opt-in.

### Have `withCaching` cache the fold result alongside child refs

Add a second cache in `withCaching` that stores the `[READ]` result and clears it on `[INVALIDATE]`. Rejected for the same reason — it conflates the correctness fix with the optimization. The caching layer should cache *refs* (which it does). Caching *values* is a distinct concern, best handled by a separate `Schema.memo()` mechanism where the schema designer controls the trade-off.

### Redefine `ref()` on composites to return the store reference with a `Readonly<T>` type

Use TypeScript's `Readonly<T>` / `ReadonlyArray<T>` to prevent mutation at the type level. Rejected because: (a) `Readonly` is shallow — nested objects are still mutable, (b) it's a type-level fiction — runtime mutation still corrupts the store, (c) it adds type complexity without solving the problem.