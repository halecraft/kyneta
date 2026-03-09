# Readable Interpreter

## Background

The `packages/schema` interpreter algebra produces trees of ref objects via `interpret(schema, interpreter, ctx)`. The writable interpreter (`writableInterpreter`) is currently the only ref-producing interpreter — it creates `ScalarRef<T>`, `TextRef`, `CounterRef`, `SequenceRef<T>`, plus plain objects for products and Proxies for maps.

Reading the current value requires `.get()` on leaf refs — a pragmatic compromise inherited from `@loro-extended/change`. The writable interpreter **mixes read and write concerns**: each ref has mutation methods (`.set()`, `.insert()`, `.increment()`) alongside read methods (`.get()`, `.toString()`). Meanwhile, `[CHANGEFEED].current` provides a separate reactive read, and `plainInterpreter` produces yet another kind of read (eager deep snapshots).

The theory document (§5.4, capability decomposition) identifies three orthogonal capabilities:

| Capability | What it provides | Protocol |
|---|---|---|
| **Readable** | Current value observation | `feed.head` / `.get()` |
| **Subscribable** | Action notification | `feed.subscribe` |
| **Writable** | State mutation | `.set()`, `.insert()`, etc. |

Today, `writableInterpreter` fuses Readable + Writable, and `withChangefeed` adds Subscribable. The fundamental problem: **reading is the base capability, but it has no first-class representation**. Writing depends on reading (mutations need to read length, current values, etc.), but reading does not depend on writing. The dependency arrow points one way, yet the architecture has them fused.

### Relationship to Changefeed

The Changefeed protocol (`{ current, subscribe }`) is a **general reactive protocol** — any value can implement it, with or without a schema. The readable interpreter's callable `()` is a **schema-specific read**: `ref()` returns `Plain<S>` (a deep snapshot via `readByPath`). At leaf nodes both return the same primitive. At structural nodes they differ: `()` produces a deep plain snapshot; `.current` returns the shallow store value for the reactive "read then subscribe" pattern.

### Prior Plan: `callable()` Combinator

An earlier plan (`callable-refs.md`) proposed a `callable()` interpreter combinator that wraps any interpreter's results in function objects. During design review, we identified two fundamental problems with that approach:

1. **Double-wrapping on delegating annotations.** For `annotated("doc")`, the base interpreter returns `inner()` (already wrapped by the product case). The combinator wraps it again — a new function each time. This requires either tag-aware skip logic or brand-checking, both fragile.
2. **Proxy-on-Proxy for maps.** The base map result is already a Proxy; the combinator wraps it in a second Proxy with a function target and `apply` trap. Every property access goes through two trap dispatches.

Both problems stem from the same root: the combinator tries to **change the carrier type** (object → function) after the fact. The cleaner solution is to produce functions from the start.

### Architectural Insight

Through design discussion, we arrived at a key insight: **reading is the foundational capability, not writing**. A schema over a store is fundamentally a read lens. Writing is an enhancement. Observation is an enhancement. But reading is the base.

The `plainInterpreter` is today's read interpreter, but it produces *ephemeral snapshots* (eagerly walks the tree), not *persistent handles*. What's missing is a **readable ref interpreter** — one that produces persistent, lazy, function-shaped handles where `ref()` reads the current value. This becomes the structural host. Mutation is composed on top via an interpreter transformer. Observation is composed via the existing `enrich` + `withChangefeed` decorator.

## Problem Statement

The current ref API has three overlapping read mechanisms (`.get()`, `[CHANGEFEED].current`, `plainInterpreter`) with no unifying concept. `.get()` adds syntactic noise and doesn't compose — you can't write `` `Stars: ${doc.stars}` `` because `doc.stars` is a `ScalarRef`, not a number. The writable interpreter owns both reading and writing with no way to use one without the other.

## Success Criteria

1. A `readableInterpreter` exists that produces callable, function-shaped refs at every node: `ref()` returns the current plain value (`Plain<S>`).
2. A `withMutation(base)` interpreter transformer exists that adds mutation methods to any ref-producing interpreter.
3. Leaf refs support `[Symbol.toPrimitive]` for template literal coercion (hint-aware, following `@loro-extended/change` precedent).
4. `SequenceRef.get(i)` is renamed to `.at(i)` for consistency with `Array.prototype.at()`.
5. `.get()` is removed from all ref interfaces (pre-1.0, no deprecation period).
6. `Readable<S>` type maps schema nodes to callable ref types. `Writable<S>` reflects mutation-only interfaces.
7. Composition: `enrich(withMutation(readableInterpreter), withChangefeed)` — three concerns, three building blocks.
8. Read-only documents work: `interpret(schema, readableInterpreter, { store })` produces a fully navigable, callable document with no mutation methods and no dispatch context.
9. Maps use a single Proxy with a function target — no Proxy-on-Proxy.
10. All existing behavior (changefeed subscription, lazy product getters, Proxy maps, batched mode) is preserved.

## Gap

- No `readableInterpreter` exists — reading is fused into `writableInterpreter`.
- Ref factories (`createScalarRef`, `createTextRef`, `createCounterRef`) produce plain objects, not functions.
- Product refs and sequence refs are plain objects — not callable.
- Map Proxy target is a plain object — no `apply` trap capability.
- No `RefContext` base interface — `WritableContext` is the only context type, even for read operations.
- No `withMutation` interpreter transformer — mutation is fused into the writable interpreter.
- `Writable<S>` type includes both read (`.get()`) and write (`.set()`) interfaces.
- No `Readable<S>` type exists.
- No `[Symbol.toPrimitive]` support on any ref.
- `isNonNullObject` guard returns `false` for functions (fixed by Phase 1 of prior plan — `isPropertyHost` guard is already in place).

## Phases

### Phase 1: Update guards to accept functions ✅

Completed in prior work. `isPropertyHost` guard accepts functions. `enrich`, `withChangefeed`, and `hasChangefeed` all handle function-object refs.

### Phase 2: `readableInterpreter` — the readable host 🔴

Create a new `Interpreter<RefContext, unknown>` that produces function-shaped handles at every schema node. This is the foundational building block — a read-only, callable, navigable document tree.

**Context type:**

```ts
interface RefContext {
  readonly store: Store
}
```

Minimal — reading requires only a store. `WritableContext extends RefContext` adds `dispatch`, `autoCommit`, `pending`. `ChangefeedContext extends WritableContext` adds subscriber maps. This makes the context hierarchy explicit.

**Composability hooks:** The readable interpreter exposes three well-known symbols on sequence and map refs for mutation layer integration:

```ts
const INVALIDATE: unique symbol   // (key?: string | number) => void — clears child cache entry or all
const SET_HANDLER: unique symbol   // (prop: string, value: unknown) => boolean — map set hook
const DELETE_HANDLER: unique symbol // (prop: string) => boolean — map delete hook
```

Sequence and map refs attach `[INVALIDATE]` for child cache management. Map Proxy `set`/`deleteProperty` traps delegate through `[SET_HANDLER]`/`[DELETE_HANDLER]` — rejecting writes if no handler is installed (read-only by default).

**`[Symbol.toPrimitive]` attachment:** The `annotated` case has access to `schema.tag` and attaches hint-aware coercion directly. Text always returns the string. Counter returns the number on `"default"`/`"number"` hints, `String(n)` on `"string"` hint. Unannotated scalars get a generic hint-aware coercion. The `toPrimitive` body reads from the store directly (same closure over `ctx.store` and `path`) — no indirection through a symbol slot.

**Map Proxy design:** The Proxy target is an arrow function (not a plain object). This means `typeof proxy === "function"` and the Proxy can have an `apply` trap — no second Proxy needed. Arrow functions have only `length` and `name` as own keys (both `configurable: true`), avoiding the `arguments`/`caller`/`prototype` invariant issues of `function(){}` declarations. The `ownKeys` trap must include `length` and `name` to satisfy Proxy invariants, but both are non-enumerable, so `Object.keys()` returns only store keys.

**Tasks:**

- Add `RefContext` interface to `writable.ts` (or new file), make `WritableContext extends RefContext` 🔴
- Create `src/interpreters/readable.ts` with `readableInterpreter` 🔴
- Implement `scalar` case: arrow function returning `readByPath(ctx.store, path)`, plus hint-aware `[Symbol.toPrimitive]` 🔴
- Implement `product` case: arrow function with lazy child getters via `Object.defineProperty` on the function 🔴
- Implement `sequence` case: arrow function with `.at(i)` (child navigation via cache), `.length` getter, `[Symbol.iterator]` generator, `[INVALIDATE]` symbol 🔴
- Implement `map` case: Proxy with arrow function target, `apply` trap, read-only traps, `[SET_HANDLER]`/`[DELETE_HANDLER]` delegation, `[INVALIDATE]` symbol, `defineProperty` trap for symbol-keyed protocol 🔴
- Implement `sum` case: identical to current writable sum (reads discriminant from store, dispatches to variant) 🔴
- Implement `annotated` case: `"text"` → callable with text-specific `toPrimitive`; `"counter"` → callable with hint-aware `toPrimitive`; delegating tags → `inner()` pass-through 🔴
- Export `INVALIDATE`, `SET_HANDLER`, `DELETE_HANDLER` symbols 🔴
- Export `readableInterpreter` and `RefContext` from `index.ts` 🔴
- Add `Readable<S>` recursive type alongside `Plain<S>` 🔴
- Add tests for read-only document (see Tests section) 🔴

### Phase 3: `withMutation` — interpreter transformer 🔴

Create an interpreter transformer `withMutation(base)` that takes an `Interpreter<RefContext, A>` and returns an `Interpreter<WritableContext, A>`. This adds mutation methods at the cases that need them, delegating to the base for everything structural.

This is an **interpreter-level combinator** (like `enrich`, `product`, `overlay`) but with a different signature: it transforms the context type (`RefContext → WritableContext`) rather than the result type. The base interpreter's cases receive a `WritableContext` (which extends `RefContext`), so they work unchanged.

**Cache invalidation protocol:** After dispatching mutation changes, `withMutation` calls `result[INVALIDATE](key?)` on the base's sequence/map refs. For sequence `.push()`/`.insert()`/`.delete()`, full cache clear (`ref[INVALIDATE]()`). For map set/delete, per-key invalidation (`ref[INVALIDATE](prop)`).

**Tasks:**

- Implement `withMutation` in `src/interpreters/writable.ts` (or new file in `src/combinators/`) 🔴
- `scalar` case: call `base.scalar(...)`, attach `.set()` 🔴
- `product` case: pass through (`return base.product(...)`) 🔴
- `sequence` case: call `base.sequence(...)`, attach `.push()`, `.insert()`, `.delete()` with `[INVALIDATE]` calls 🔴
- `map` case: call `base.map(...)`, fill `[SET_HANDLER]` and `[DELETE_HANDLER]` via `Object.defineProperty` through the Proxy, with `[INVALIDATE]` calls 🔴
- `sum` case: pass through 🔴
- `annotated` case: dispatch on `schema.tag` — `"text"` gets `.insert()`, `.delete()`, `.update()`; `"counter"` gets `.increment()`, `.decrement()`; delegating tags pass through 🔴
- Remove `.get()` from `ScalarRef`, `TextRef`, `CounterRef` interfaces 🔴
- Remove `.toString()` from `TextRef` interface (reading is via callable `()` and `toPrimitive`; `String(ref)` works via `toPrimitive`) 🔴
- Remove `.toArray()` from `SequenceRef` interface (unused outside definition) 🔴
- Rename `.get(i)` to `.at(i)` on `SequenceRef` interface 🔴
- Update `Writable<S>` type to reflect mutation-only interfaces 🔴
- Export `withMutation` from `index.ts` 🔴
- Remove `writableInterpreter` export (no backward compat needed) 🔴
- Add tests for mutation layer (see Tests section) 🔴

### Phase 4: Migrate tests and example 🔴

Update all call sites to the new architecture. Tests that were using `writableInterpreter` directly switch to `withMutation(readableInterpreter)` (or `readableInterpreter` alone for read-only tests).

**Tasks:**

- Migrate `writable.test.ts`: all `.get()` → `ref()`, all `.get(i)` → `.at(i)`, interpreter construction uses `withMutation(readableInterpreter)` 🔴
- Migrate `with-changefeed.test.ts`: composition becomes `enrich(withMutation(readableInterpreter), withChangefeed)` 🔴
- Migrate `example/main.ts`: all `.get()` → `ref()`, all `.get(i)` → `.at(i)`, `createDoc` and `change` use new composition 🔴
- Migrate `types.test.ts`: update `Writable<S>` assertions (no `.get()`), add `Readable<S>` type tests 🔴
- Verify all 447+ tests pass 🔴

### Phase 5: Documentation 🔴

**Tasks:**

- Update TECHNICAL.md §"Interpreters" table: add `readableInterpreter` row, update `writableInterpreter` → `withMutation(readableInterpreter)` 🔴
- Update TECHNICAL.md §"Writable Interpreter": describe the decomposition into readable host + mutation transformer 🔴
- Update TECHNICAL.md §"Type-Level Interpretation": add `Readable<S>` alongside `Plain<S>` and `Writable<S>` 🔴
- Update TECHNICAL.md §"Verified Properties": add readable-specific properties (callable refs, `toPrimitive`, `Object.keys` on function hosts, read-only documents) 🔴
- Update TECHNICAL.md §"File Map": add `readable.ts`, update `writable.ts` description 🔴
- Document the composition algebra: `readableInterpreter` = reading, `withMutation` = mutation, `withChangefeed` = observation 🔴

## Tests

### Phase 1 tests (guards) ✅

Already complete: 24 tests for `isPropertyHost`, `isNonNullObject`, `hasChangefeed` with functions.

### Phase 2 tests (`readableInterpreter`)

**Read-only document (no mutation context):**

- `interpret(schema, readableInterpreter, { store })` produces a navigable tree
- `scalarRef()` returns current value from store
- `scalarRef()` reflects direct store mutations (live read)
- `textRef()` returns current string
- `counterRef()` returns current number
- `productRef()` returns deep plain snapshot
- `sequenceRef()` returns plain array
- `sequenceRef.at(0)` returns child ref (itself callable)
- `sequenceRef.length` reflects store array length
- Iteration via `for (const item of sequenceRef)` yields child refs
- Map ref callable returns plain record
- Map ref string key access returns child ref (callable)
- `Object.keys(mapRef)` returns store keys
- `"key" in mapRef` checks store
- Product ref `Object.keys()` returns schema field names only
- `typeof scalarRef` → `"function"`
- `typeof productRef` → `"function"`

**`[Symbol.toPrimitive]` and coercion:**

- `` `Stars: ${counterRef}` `` → `"Stars: 42"` (hint `"string"`)
- `` `Title: ${textRef}` `` → `"Title: Hello"` (hint `"string"`)
- `counterRef[Symbol.toPrimitive]("number")` → `42`
- `counterRef[Symbol.toPrimitive]("string")` → `"42"`
- `counterRef[Symbol.toPrimitive]("default")` → `42`
- `String(textRef)` → `"Hello"` (via `toPrimitive`)
- `scalarRef[Symbol.toPrimitive]("string")` → `String(value)`

**Structural edge cases:**

- Product field named `"name"`: lazy getter shadows `Function.prototype.name`
- Product field named `"length"`: lazy getter shadows `Function.prototype.length`
- Referential identity: `doc.settings === doc.settings` (lazy getter caches)
- Sum dispatch: discriminated and nullable sums produce callable child refs

**Composability hooks:**

- `readableInterpreter` sequence ref has `[INVALIDATE]` symbol
- `readableInterpreter` map ref has `[INVALIDATE]`, `[SET_HANDLER]`, `[DELETE_HANDLER]` symbols accessible
- Map ref rejects `proxy.x = value` when no `[SET_HANDLER]` is installed

### Phase 3 tests (`withMutation`)

**Mutation methods present:**

- `withMutation(readableInterpreter)` scalar ref has `.set()` — no `.get()`
- `withMutation(readableInterpreter)` text ref has `.insert()`, `.delete()`, `.update()` — no `.get()`, no `.toString()`
- `withMutation(readableInterpreter)` counter ref has `.increment()`, `.decrement()` — no `.get()`
- `withMutation(readableInterpreter)` sequence ref has `.push()`, `.insert()`, `.delete()`, `.at(i)` — no `.get()`

**Mutation + read integration:**

- `ref()` reflects value after `.set()` / `.insert()` / `.increment()`
- Sequence `.push()` updates store and `ref()` reflects new items
- Sequence cache invalidation: after `.push()`, `.at(newIndex)` returns correct child
- Map `proxy.key = value` dispatches change when `withMutation` is composed
- Map delete `delete proxy.key` dispatches change when `withMutation` is composed

**Composition with changefeed:**

- `enrich(withMutation(readableInterpreter), withChangefeed)` works — `[CHANGEFEED]` attaches to callable refs
- `hasChangefeed(callableRef)` → `true` after enrichment
- Changefeed `.current` still returns shallow store value (unchanged)

### Phase 4 tests (type-level)

- `Readable<ScalarSchema<"number">>` has call signature returning `number`
- `Readable<ProductSchema<{ x: ScalarSchema<"number"> }>>` has call signature returning `{ x: number }`, and `.x` is `Readable<ScalarSchema<"number">>`
- `Readable<AnnotatedSchema<"text">>` has call signature returning `string`
- `Readable<AnnotatedSchema<"counter">>` has call signature returning `number`
- `Readable<SequenceSchema<ScalarSchema<"string">>>` has call signature returning `string[]`, and `.at()` returns `Readable<ScalarSchema<"string">>`
- `Writable<ScalarSchema<"number">>` has `.set()` but no `.get()` and no call signature
- `Writable<AnnotatedSchema<"text">>` has `.insert()`, `.delete()`, `.update()` but no `.get()`, no `.toString()`

## Transitive Effect Analysis

### `RefContext` introduction → `WritableContext` → `ChangefeedContext`

Adding `RefContext` as a base interface and making `WritableContext extends RefContext` is a non-breaking narrowing. `ChangefeedContext extends WritableContext` is unchanged. All existing `WritableContext` values already have `store`, so they satisfy `RefContext`. The `readableInterpreter` accepts `RefContext`; `withMutation` widens to `WritableContext`; `withChangefeed` widens to `ChangefeedContext`. Each layer adds only what it needs.

### `readableInterpreter` → function-shaped refs → `enrich` / `withChangefeed` / `hasChangefeed`

Phase 1 already switched `enrich` and `withChangefeed` to `isPropertyHost` (accepts functions) and widened `hasChangefeed`. `Object.assign` in `enrich` works on functions. `Object.defineProperty` in `withChangefeed` works on functions. No additional changes needed in these modules.

### Removal of `writableInterpreter` export → all consumer call sites

Every file that imports `writableInterpreter` must switch to `withMutation(readableInterpreter)` or just `readableInterpreter`. Affected: `writable.test.ts`, `with-changefeed.test.ts`, `example/main.ts`, `index.ts`, comments in `with-changefeed.ts` and `combinators.ts`.

### `.get()` removal from ref interfaces → `writable.test.ts`, `example/main.ts`

All `.get()` call sites become `ref()`. All `.get(i)` become `.at(i)`. Counts: ~12 `.get()` + 1 `.get(0)` in `writable.test.ts`; ~16 `.get()` + ~3 `.get(0)` in `example/main.ts`; 0 in `with-changefeed.test.ts`.

### `.toString()` removal from `TextRef` → `writable.test.ts`, `example/main.ts`, internal `update()` usage

One test checks `.toString()`. The `update()` method internally calls `ref.toString()` to get current length — this changes to `ref()` (the callable read). The example does not use `.toString()`.

### `.toArray()` removal from `SequenceRef` → no external usage

Not used outside the interface definition itself.

### Map Proxy target change (object → function) → `ownKeys` trap invariants

Arrow function targets require `ownKeys` to include `length` and `name` (non-configurable own keys). Both are non-enumerable, so `Object.keys()` behavior is unchanged (returns only store keys). The `getOwnPropertyDescriptor` trap must return the real descriptors for `length` and `name` when asked.

### `Readable<S>` and updated `Writable<S>` types → `types.test.ts`

All type-level assertions that reference `ScalarRef<T>`, `TextRef`, `CounterRef`, `SequenceRef<T>` in the context of `Writable<S>` must be updated for the mutation-only interfaces (no `.get()`). New `Readable<S>` assertions are added.

### No impact on: `schema.ts`, `loro-schema.ts`, `change.ts`, `step.ts`, `zero.ts`, `describe.ts`, `interpret.ts`, `store.ts`, `plain.ts`, `validate.ts`

These modules don't reference ref types or produce refs.

### Downstream (out of scope, noted for follow-up)

- **Kinetic compiler** (`packages/kinetic/src/compiler/analyze.ts`): synthesizes `.get()` calls for bare refs. Will need updating to synthesize `ref()` calls when schema refs migrate. Not blocking — Kinetic currently works against `@loro-extended/change` refs which retain `.get()`.
- **Kinetic runtime** (`packages/kinetic/src/runtime/regions.ts`): `ListRefLike<T>` interface uses `.get(i)`. This is a separate interface from schema's `SequenceRef` and doesn't break, but should be renamed to `.at(i)` for consistency in a follow-up.

## Resources for Implementation Context

- `packages/schema/src/interpreters/writable.ts` — current monolithic interpreter with ref interfaces, ref factories, `Plain<S>`, `Writable<S>` (primary decomposition target)
- `packages/schema/src/combinators.ts` — `enrich`, `product`, `overlay` combinators (pattern for `withMutation`)
- `packages/schema/src/guards.ts` — `isNonNullObject`, `isPropertyHost` (Phase 1 already complete)
- `packages/schema/src/interpreters/with-changefeed.ts` — `withChangefeed` decorator (must handle function results — already does)
- `packages/schema/src/changefeed.ts` — `hasChangefeed` guard (already widened for functions)
- `packages/schema/src/store.ts` — `readByPath` (used by readable interpreter for all reads)
- `packages/schema/src/interpret.ts` — `Interpreter` interface, `interpret` catamorphism, `Path` types
- `packages/schema/src/interpreters/plain.ts` — `plainInterpreter` (ephemeral read interpreter — contrast with readable's persistent handles)
- `packages/schema/src/__tests__/writable.test.ts` — ~12 `.get()` + 1 `.get(i)` call sites to migrate
- `packages/schema/example/main.ts` — ~16 `.get()` + ~3 `.get(i)` call sites to migrate
- `packages/schema/src/__tests__/types.test.ts` — type-level tests (add `Readable<S>`, update `Writable<S>`)
- `packages/schema/TECHNICAL.md` — documentation target
- `packages/schema/theory/interpreter-algebra.md` — §3 (interpreters as algebras), §5.4 (capability decomposition), §7.2 (enrich combinator)
- `packages/change/src/typed-refs/counter-ref.ts` — hint-aware `[Symbol.toPrimitive]` precedent
- `packages/change/src/typed-refs/text-ref.ts` — `[Symbol.toPrimitive]` precedent (schema refs adopt toPrimitive but not valueOf)

## PR Stack

### PR 1: `(packages/schema) refactor: add isPropertyHost guard for function-object refs` ✅

Already landed. Adds `isPropertyHost` to `guards.ts`, switches `enrich` + `withChangefeed` to use it, widens `hasChangefeed` for functions.

### PR 2: `(packages/schema) feat: readableInterpreter — callable function-shaped refs`

**Type:** Feature

Adds `readableInterpreter` in a new `src/interpreters/readable.ts`. Introduces `RefContext` interface. Every ref is a callable function: `ref()` returns the current plain value. `[Symbol.toPrimitive]` on leaf refs. `[INVALIDATE]`, `[SET_HANDLER]`, `[DELETE_HANDLER]` composability symbols. `Readable<S>` type. No breaking changes — `writableInterpreter` still exists alongside.

### PR 3: `(packages/schema) feat: withMutation transformer, decompose writableInterpreter`

**Type:** Feature (breaking — pre-1.0)

Adds `withMutation(base)` interpreter transformer. Removes `writableInterpreter` (replaced by `withMutation(readableInterpreter)`). Drops `.get()` from all ref interfaces. Renames `.get(i)` to `.at(i)`. Drops `.toString()` from `TextRef`. Drops `.toArray()` from `SequenceRef`. Updates `Writable<S>` type. Migrates all tests and example.

### PR 4: `(packages/schema) docs: readable interpreter architecture`

**Type:** Documentation

Updates TECHNICAL.md with the three-building-block composition algebra, new interpreter table, `Readable<S>` type documentation, updated verified properties.

## Alternatives Considered

### Keep `writableInterpreter` as host, add `callable()` combinator

The prior `callable-refs.md` plan. Rejected because:

- Double-wrapping on delegating annotations (`"doc"`, `"movable"`, `"tree"` return `inner()` which is already wrapped, then the combinator wraps again)
- Proxy-on-Proxy for maps (base Proxy wrapped in outer Proxy with function target)
- Property descriptor copying dance (`Object.getOwnPropertyDescriptors` + `Object.defineProperties`) at every node
- Architecturally backwards — writing as the host, reading bolted on

### Fuse callable directly into `writableInterpreter`

Rewrite `writableInterpreter` to produce function objects. Rejected because:

- Still fuses read and write concerns in a single interpreter
- No read-only document capability
- No composable building blocks — consumer gets everything or nothing
- Doesn't follow the established `enrich` pattern for orthogonal capabilities

### Symbol-slot `[CALL]` with `withRead` decorator

An intermediate proposal: writable interpreter produces functions with a `[CALL]` symbol slot, a `withRead` decorator fills the slot with `readByPath`. Rejected because:

- The writable interpreter already closes over `ctx.store` and `path` for its own reads (e.g. `update()` reads current text length). The read closure is zero additional cost. Making it a separate decorator adds indirection for no benefit.
- `toPrimitive` would need to delegate through `[CALL]`, but `[CALL]` is only filled when `withRead` is composed. Without `withRead`, template literals silently produce `undefined`.
- The real issue was that `writableInterpreter` shouldn't be the host at all — reading is the foundational capability.

### Keep `.get()` alongside `()` for backward compat

Two ways to read the same value. Rejected because:

- Pre-1.0 spike — no backward compat obligation
- `.get()` on `SequenceRef` remains ambiguous (no-arg read vs indexed navigation)
- Two ways to do the same thing is strictly worse than one

### Keep `.toString()` on `TextRef`

Rejected because:

- `String(ref)` works via `[Symbol.toPrimitive]` — same result, standard JS protocol
- `ref.toString()` on a function-shaped ref would fall through to `Function.prototype.toString()` if not explicitly defined — confusing but also a signal that the explicit method is unnecessary
- `ref()` is the canonical read; `toPrimitive` handles coercion contexts
- Internal usage in `update()` method switches to `ref()` trivially

### Keep `.toArray()` on `SequenceRef`

Rejected because:

- Not used outside the interface definition itself
- `ref()` returns the plain array (deep snapshot)
- `[...ref]` works via `[Symbol.iterator]` for an array of child refs
- Two ways to get an array representation is redundant

## Learnings

### Reading is the foundational capability

The theory document (§5.4) identified three capabilities but the implementation fused two of them. By making reading the host and mutation the enhancement, the architecture matches the dependency structure: writing depends on reading (mutations need store reads for lengths, current values, discriminants), but reading does not depend on writing.

### Arrow functions as Proxy targets

Regular `function(){}` declarations have non-configurable `arguments`, `caller`, and `prototype` own keys. These create Proxy `ownKeys` invariant violations. Arrow functions have only `length` and `name` (both `configurable: true`), making them clean Proxy targets. Use arrow functions for all function-shaped refs.

### `withMutation` is not a `Decorator`

The `Decorator<Ctx, A, P>` type receives `(result, ctx, path)` but no schema information. Mutation is tag-dependent (text gets `.insert()`, counter gets `.increment()`), so it needs access to `schema.tag` in the `annotated` case. This makes it an interpreter transformer (wraps the full interpreter, case by case) rather than a decorator (applied uniformly to results). The distinction: decorators are schema-agnostic (like `withChangefeed`), transformers are schema-aware (like `withMutation`).

### Composability hooks via well-known symbols

The `[INVALIDATE]`, `[SET_HANDLER]`, `[DELETE_HANDLER]` pattern is analogous to `[CHANGEFEED]` — symbol-keyed protocol that decorators/transformers attach to or read from. The readable interpreter defines the hooks; `withMutation` fills them. This is a general pattern for inter-layer communication without coupling.

### `toPrimitive` is tag-dependent but read-only

`[Symbol.toPrimitive]` belongs in the readable interpreter (not the mutation layer) because it's a read operation. Its hint-aware behavior is tag-dependent (text always returns string, counter is hint-aware), which is why it lives in the `annotated` case of the readable interpreter — the one place where both the tag and the read closure are in scope.