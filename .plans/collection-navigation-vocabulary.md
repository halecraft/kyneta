# Unified Collection Navigation Vocabulary

## Background

The `@loro-extended/schema` package implements a schema interpreter algebra where every node in the schema tree is interpreted as a **ref** — a callable function whose invocation returns the current plain value at that path. Structural nodes (products, sequences, maps) additionally carry navigation methods to reach child refs.

The current API surface uses different verbs for the same conceptual operation across collection types:

| Kind | Navigate to child | Read plain value | Mutate |
|---|---|---|---|
| **Product** (struct) | `doc.settings.visibility` (property) | `doc.settings()` | `.set(value)` |
| **Sequence** (list) | `doc.tasks.at(0)` | `doc.tasks()` / `doc.tasks.at(0)()` | `.push()`, `.insert()`, `.delete()` |
| **Map** (record) | `doc.labels.get("bug")` | `doc.labels()` / `doc.labels.get("bug")!()` | `.set(key, value)`, `.delete(key)`, `.clear()` |
| **Scalar** (leaf) | — (terminal) | `doc.name()` | `.set(value)` / `.insert()` / `.increment()` |

The map case conflates two distinct operations under `.get()`:

1. **Navigate** — descend the schema tree to obtain a ref (a handle with identity, subscriptions, mutation)
2. **Read** — extract the current plain value at a position

For products, these are cleanly separated: `doc.settings` navigates, `doc.settings()` reads. For sequences, `.at(i)` navigates, calling the returned ref reads. For maps, `.get(key)` is doing navigation but *reads like* a value getter — because that's what `Map.get()` means everywhere else in JavaScript.

### Consequences of the current design

1. **Asymmetric set/get**: `.set("bug", "red")` takes a plain `string`, but `.get("bug")` returns a callable ref. Developers expect symmetric types.
2. **Ceremony on reads**: `doc.labels.get("bug")!()` requires both a non-null assertion and a call. The `!()` pattern is unfamiliar and surprising.
3. **`JSON.stringify` returns `undefined`**: scalar refs are arrow functions. `JSON.stringify(fn)` → `undefined`. A developer who writes `JSON.stringify(doc.labels.get("bug"))` gets silent data loss.
4. **Template literals work but JSON doesn't**: `${doc.labels.get("bug")}` works via `[Symbol.toPrimitive]`, but `JSON.stringify` does not invoke `toPrimitive`. This inconsistency is a trap.

### The insight from discussion

There are always **two** operations at play in collection access: navigation (get a ref) and reading (get a value). The current API conflates them for maps. The fix is to give each operation its own verb, uniformly across both collection types (sequences and maps):

- **`.at()`** — the universal navigation verb. Returns a **ref** (or `undefined`). Already exists on sequences; extend to maps.
- **`.get()`** — the universal read verb. Returns a **plain value** (or `undefined`). Equivalent to `.at(key)?.()`. Symmetric with `.set()`.
- **`()`** — the catamorphism's universal fold. Calling any ref returns its `Plain<S>` snapshot.
- **Iteration** (`entries()`, `values()`, `[Symbol.iterator]`) — yields **refs**, not values. Refs are the primary currency of the reactive system (subscriptions, DOM bindings via kinetic). Plain values are always available via fold.

## Problem Statement

The map ref API uses `.get(key)` for navigation, conflating it with the universally understood "read value" semantics of `Map.get()`. This creates type asymmetry between `.set()` and `.get()`, surprising ceremony (`!()`) on leaf reads, and silent `JSON.stringify` failures. Sequences lack a `.get(i)` convenience for reading plain values. The vocabulary for "navigate to a child" vs "read a child's value" is inconsistent across collection types.

## Success Criteria

1. **`.at()` is the universal navigation verb** for both sequences and maps. Returns `Ref | undefined`.
2. **`.get()` is the universal read verb** for both sequences and maps. Returns `Plain<I> | undefined`. Equivalent to `.at(x)?.()`.
3. **`.get()` and `.set()` are symmetric in types** for maps: `.set("bug", "red")` / `.get("bug")` → `"red"`.
4. **`JSON.stringify(doc.labels.get("bug"))`** returns `'"red"'`, not `undefined`.
5. **Iteration** (`entries()`, `values()`, `[Symbol.iterator]`) continues to yield **refs** — the reactive currency.
6. **No change to the catamorphism internals** — `interpret()`, `Interpreter<Ctx, A>`, and all combinators remain unchanged.
7. **No change to product navigation** — property access for static keys is unchanged.
8. **`Readable<S>` and `Writable<S>` type-level interpretations** updated to reflect the new vocabulary.
9. **All 524 existing tests pass** (updated where the API surface changed) plus new tests for the added methods.
10. **TECHNICAL.md updated** to document the vocabulary distinction and rationale.
11. **Example `main.ts` updated** to use the new API and demonstrate both `.at()` and `.get()`.

## Gap

### Sequences

- **Have**: `.at(i)` returning `Ref | undefined` (navigation).
- **Missing**: `.get(i)` returning `Plain<I> | undefined` (read convenience).

### Maps

- **Have**: `.get(key)` returning `Ref | undefined` (navigation, misnamed).
- **Need**: Rename current `.get(key)` to `.at(key)` (navigation). Add new `.get(key)` returning `Plain<I> | undefined` (read).
- **Iteration**: Already yields refs — no change needed. Type names (`ReadableMapRef<T>`) parameterized on the ref type `T` — this remains correct since `.at()` returns `T` and iteration yields `T`.

### Types

- `ReadableMapRef<T>`: Add second type param `V` for plain values. `.at()` returns `T | undefined`, `.get()` returns `V | undefined`.
- `ReadableSequenceRef<T>`: Add second type param `V`. New `.get(i)` returns `V | undefined`.
- `Readable<S>`: Map branch becomes `ReadableMapRef<Readable<I>, Plain<I>>`. Sequence branch becomes `ReadableSequenceRef<Readable<I>, Plain<I>>`.
- `Writable<S>`: `WritableMapRef<V>` is mutation-only — **no `.get()`, no change**. `SequenceRef<T>` is mutation-only — **no `.get()`, no change**. The readable `.get()` enters the composed type via `Readable<S> & Writable<S>` intersection automatically.

### Runtime

- `readableInterpreter.map()`: Current `.get()` implementation becomes `.at()`. New `.get()` calls `.at()` then forces the ref: `this.at(key)?.()`.
- `readableInterpreter.sequence()`: New `.get(i)` calls `.at(i)` then forces the ref.

## Check-Plan Corrections

The following issues were identified during review and are corrected in this version:

### SequenceRef and WritableMapRef are mutation-only — do NOT add `.get()`

The original plan (Phase 3, task 3b) proposed adding `.get(i)` to `SequenceRef<T>` in `writable.ts`. This is incorrect. `SequenceRef<T>` and `WritableMapRef<V>` are **mutation-only interfaces** by design — they describe the write surface added by `withMutation`. Reading capabilities come from the readable interpreter's `ReadableSequenceRef` and `ReadableMapRef`. The composed type `Readable<S> & Writable<S>` intersects both, so `.get()` is available on the composed surface without polluting the mutation-only types.

### `.get()` implementation: compose, don't duplicate

`.get()` should be implemented as `.at(key)?.()` (navigate then force), NOT by duplicating `readByPath` logic. This avoids duplication and means `.get()` automatically benefits from cache invalidation: after `map.set("x", "new")` → `[INVALIDATE]("x")` clears the child cache → `.get("x")` calls `.at("x")` (cache miss, creates fresh ref) → forces it → reads current store value.

An alternative implementation reading the store directly via `readByPath(ctx.store, [...path, { type: "key", key }])` would be slightly more efficient (avoids creating a throwaway ref) but duplicates store-reading + bounds-checking logic. The composition approach is correct for now; direct store reads can be an optimization later if profiling warrants it.

### Store reference semantics are unchanged

`.get(key)` returns the raw store value by reference, same as `ref()` does. This is consistent with the existing design — the readable interpreter does not deep-copy. The `plainInterpreter` (used by `toJSON()`) does deep snapshot. No new aliasing concern is introduced.

### No downstream consumers

`@loro-extended/schema` has no consumers — no other package depends on it. The second type parameter defaults (`ReadableMapRef<T = unknown, V = unknown>`) preserve backward compat for any direct references, but this is a precaution, not a requirement.

### withMutation does not reference `.get()` or `.at()` on base refs

Verified: `withMutation` in `writable.ts` never calls `.get()` on the base map/sequence ref. It only calls `result[INVALIDATE]()` for cache coordination. The rename from `.get()` to `.at()` has **zero impact** on the mutation layer.

### `with-changefeed.ts` `.get()` calls are on JavaScript `Map` instances

The `subscribeToMap` and `notifyAll` functions call `.get()` on `ctx.subscribers` and `ctx.deepSubscribers`, which are standard JavaScript `Map<string, Set<...>>`. These are unrelated to `ReadableMapRef` and are not affected.

## PR Stack

### PR 1: `(packages/schema) refactor: rename map .get() to .at(), add .at() to ReadableMapRef` ✅

**Type: Mechanical refactor + API prep (introduce new API alongside)**

This is the foundational rename. The current `.get()` on maps becomes `.at()`. No new behavior — just a name change. The old `.get()` name is freed up for the next PR.

**Scope:**

- ✅ Rename `ReadableMapRef.get()` → `ReadableMapRef.at()` in the interface definition (`readable.ts`)
- ✅ Rename `Object.defineProperty(ref, "get", ...)` → `"at"` in `readableInterpreter.map()` runtime
- ✅ Update `Readable<S>` type — no structural change needed since `ReadableMapRef<T>` parameter stays the same at this stage
- ✅ Update all tests in `readable.test.ts` and `writable.test.ts` that call `.get(key)` on map refs → `.at(key)`
- ✅ Update type-level test in `types.test.ts` that asserts `.get()` on `Readable<record(string())>` → `.at()`
- ✅ Update `example/main.ts` Section 5: `doc.labels.get("bug")!()` → `doc.labels.at("bug")!()`

**Test updates (not new tests — just renames):**

- `.at(key)` returns a callable child ref
- `.at(key)` returns `undefined` for missing key
- `.at(key)` caches child refs (referential identity)
- Iteration still yields refs (smoke check)

### PR 2: `(packages/schema) feat: add .get() as read-value verb on maps and sequences` ✅

**Type: Feature — user-visible behavior change**

Add the new `.get()` method to both `ReadableMapRef` and `ReadableSequenceRef`. This is the core vocabulary change: `.get()` now means "read the plain value" (symmetric with `.set()`), and `.at()` means "navigate to a ref."

**Scope:**

- ✅ Add second type parameter to `ReadableMapRef<T = unknown, V = unknown>`. Add `.at(key): T | undefined` (already present from PR 1) and `.get(key): V | undefined`.
- ✅ Add second type parameter to `ReadableSequenceRef<T = unknown, V = unknown>`. Add `.get(index): V | undefined`.
- ✅ Update `Readable<S>`:
  - Map branch: `ReadableMapRef<Readable<I>>` → `ReadableMapRef<Readable<I>, Plain<I>>`
  - Sequence branch: `ReadableSequenceRef<Readable<I>>` → `ReadableSequenceRef<Readable<I>, Plain<I>>`
  - `annotated("movable")` branch: same pattern as sequence
- ✅ In `readableInterpreter.map()` runtime: add `Object.defineProperty(ref, "get", { value: (key) => { const child = ref.at(key); return child !== undefined ? child() : undefined } })`.
- ✅ In `readableInterpreter.sequence()` runtime: add `Object.defineProperty(ref, "get", { value: (index) => { const child = ref.at(index); return child !== undefined ? child() : undefined } })`.
- ✅ Update `example/main.ts` Section 5: `doc.labels.at("bug")!()` → `doc.labels.get("bug")` for the primary read path. Add examples showing both `.at()` (navigation) and `.get()` (read). Show `JSON.stringify(doc.labels.get("bug"))` working. Show `.set()` / `.get()` symmetry.
- ✅ Update `example/main.ts` Section 4: add `.get(i)` examples alongside `.at(i)`.

**New tests:**

Map `.get()`:
- `.get(key)` returns the plain value directly (not a function)
- `.get(key)` returns `undefined` for missing key
- `.get(key)` returns a deep plain snapshot for structural items (e.g., `record(struct({...}))`)
- `JSON.stringify(mapRef.get(key))` returns the JSON-serialized value (not `undefined`)
- `.get(key)` and `.set(key, value)` are symmetric: after `.set("x", "red")`, `.get("x")` → `"red"`
- `.get(key)` reflects store mutations (live read, not cached snapshot)

Sequence `.get(i)`:
- `.get(i)` returns the plain value directly
- `.get(i)` returns `undefined` for out-of-bounds index
- `.get(i)` returns a deep plain snapshot for structural items
- `.get(i)` reflects store mutations after `.push()`

Type-level:
- `Readable<record(string())>`: `.at("x")` is `Readable<string()> | undefined`, `.get("x")` is `string | undefined`
- `Readable<record(struct({...}))>`: `.get("x")` is `{ ... } | undefined` (plain struct)
- `Readable<list(struct({...}))>`: `.get(0)` is `{ ... } | undefined` (plain struct)

### PR 3: `(packages/schema) docs: document navigate-vs-read vocabulary in TECHNICAL.md` 🔴

**Type: Documentation only**

- 🔴 Update TECHNICAL.md Readable Interpreter section: document `.at()` / `.get()` vocabulary distinction
- 🔴 Update `ReadableMapRef` description: `.at(key)` navigates (returns ref), `.get(key)` reads (returns plain value)
- 🔴 Update `ReadableSequenceRef` description: add `.get(i)` documentation
- 🔴 Update Verified Properties #19 (Map-like API) to reflect new vocabulary
- 🔴 Add a "Design Decision: Navigate vs Read" subsection explaining the vocabulary rationale
- 🔴 Verify `index.ts` exports — no new exports needed; interfaces gained a second defaulted type parameter which is backward-compatible

## Transitive Effect Analysis

### `ReadableMapRef<T>` gains second type parameter → all references to `ReadableMapRef`

- `readable.ts`: interface definition, `Readable<S>` type, `readableInterpreter.map()` runtime — **updated in PR 1 + PR 2**
- `writable.ts`: `Writable<S>` map branch references `WritableMapRef` (not `ReadableMapRef`) — **no change**
- `index.ts`: re-exports `ReadableMapRef` — the type export is unchanged in name, second param defaults to `unknown` — **no change**
- `types.test.ts`: type assertions that reference `ReadableMapRef` directly must add the second parameter — **updated in PR 2**
- `combinators.ts`: works on `Interpreter<Ctx, A>` generically — **no change**
- `with-changefeed.ts`: the `enrich` decorator operates on the already-interpreted result — **no change**

### `ReadableSequenceRef<T>` gains second type parameter → all references to `ReadableSequenceRef`

- `readable.ts`: interface definition, `Readable<S>` type (sequence branch and `annotated("movable")` branch) — **updated in PR 2**
- `writable.ts`: `SequenceRef<T>` in writable is a separate mutation-only interface — **no change**
- `index.ts`: re-exports `ReadableSequenceRef` — type export unchanged, second param defaults — **no change**
- `types.test.ts`: type assertions referencing `ReadableSequenceRef` directly — **updated in PR 2**

### `readableInterpreter` runtime changes → `withMutation` transformer

- `withMutation` calls `base.map(ctx, path, schema, item)` and adds `.set()`, `.delete()`, `.clear()` to the result. It does **not** reference `.get()` or `.at()` on the base — **no change needed**.
- `withMutation` calls `result[INVALIDATE](key)` after `.set()` — this invalidates the child cache in `.at()`. The new `.get()` calls `.at()` internally, so it benefits from invalidation automatically — **no change needed**.

### `with-changefeed.ts` decorator

- Operates via `enrich()` which uses `Object.assign`. Does not reference `.get()` or `.at()` on map/sequence refs — **no change**.
- Internal `.get()` calls are on JavaScript `Map` instances (subscriber maps), unrelated — **no change**.

### `validate.ts`, `plain.ts`, `describe.ts`, `zero.ts`

- These interpreters produce their own result types. They do not produce `ReadableMapRef` or `ReadableSequenceRef` — **no change**.

### `SequenceRef<T>` and `WritableMapRef<V>` (writable.ts)

- These are mutation-only interfaces. They do NOT get `.get()`. The readable `.get()` enters the composed type via `Readable<S> & Writable<S>` intersection — **no change to writable types**.

### `example/main.ts`

- Section 5 (Records): `.get("bug")!()` → `.get("bug")` — **updated in PR 2**
- Section 4 (Lists): add `.get(i)` examples — **updated in PR 2**
- Section 8 (Portable Refs): no change — portable refs are extracted via property access
- Section 12 (Read-Only Documents): may reference map `.get()` — **verify in PR 2**

### Downstream consumers (out of scope)

- `packages/kinetic`: does not import `ReadableMapRef` or `ReadableSequenceRef` — **no impact**
- `packages/change`: independent codebase — **no impact**
- No other package depends on `@loro-extended/schema`

## Resources for Implementation Context

| File | Reason |
|---|---|
| `src/interpreters/readable.ts` | Primary target — `ReadableMapRef`, `ReadableSequenceRef`, `readableInterpreter.map()`, `readableInterpreter.sequence()`, `Readable<S>` |
| `src/interpreters/writable.ts` | Verify no breakage — `SequenceRef<T>`, `WritableMapRef<V>`, `Writable<S>` are mutation-only and should NOT change |
| `src/interpreter-types.ts` | `Plain<S>` type definition — the value type that `.get()` returns |
| `src/__tests__/readable.test.ts` | Existing map/sequence read tests — rename `.get()` → `.at()`, add new `.get()` tests |
| `src/__tests__/writable.test.ts` | Existing map/sequence write tests — rename `.get()` → `.at()` where it references map navigation |
| `src/__tests__/types.test.ts` | Type-level assertions — update for new second type parameter and new method signatures |
| `src/index.ts` | Barrel exports — verify nothing breaks |
| `example/main.ts` | Developer-facing example — update API usage |
| `TECHNICAL.md` | Architecture docs — update for vocabulary change |
| `.plans/map-ref-api.md` | Prior plan that introduced the current Map-like API — historical context |

## Alternatives Considered

### Keep `.get()` as navigation, add `.value(key)` for reading

This preserves the current `.get()` semantics and adds a new verb for "read the plain value." Rejected because:

- `.get()` meaning "navigate" violates the universal expectation from `Map`, `WeakMap`, `URLSearchParams`, `Headers`, `FormData`, and every other JS API where `.get()` returns a value.
- `.value()` is not a standard verb in any JS collection API. It adds cognitive load.
- Two unfamiliar patterns (`.get()` as nav, `.value()` as read) vs one familiar (`.get()` as read) plus one that generalizes naturally (`.at()` as nav).

### Make `.get()` return value only for leaf-valued records, ref for structural records

A conditional return type: leaf records get plain values, structural records get refs. Rejected because:

- The API becomes unpredictable — the return type depends on the item schema, which may not be visible at the call site.
- It breaks the simple mental model of "`.get()` always returns data, `.at()` always returns a ref."
- It complicates the type-level interpretation with conditional types that are hard to follow.

### Add `.toJSON()` to scalar refs instead of changing `.get()`

This would fix the `JSON.stringify` problem but not the ceremony (`!()`) or the asymmetry. It's a band-aid on one symptom, not a fix for the underlying vocabulary confusion.

### Make iteration yield plain values instead of refs

This would make `entries()`, `values()`, and `[Symbol.iterator]` return plain data. Rejected because:

- Refs are the primary currency of the reactive system. In `packages/kinetic`, iterating over refs to bind them to DOM nodes is the core use case.
- Plain values are trivially available via fold: `Object.entries(doc.labels())` or `doc.tasks().forEach(...)`.
- Yielding values would destroy the subscription/mutation handles that make iteration useful in a reactive context.

### Implement `.get()` via direct `readByPath` instead of `.at()?.()` composition

For maps, `.get(key)` could call `readByPath(ctx.store, [...path, { type: "key", key }])` directly instead of going through `.at(key)?.()`. This avoids creating a throwaway child ref. Deferred because:

- The composition approach (`at()?.()`) avoids duplicating store-reading + bounds-checking logic.
- It automatically benefits from cache invalidation — no separate invalidation path needed.
- The performance difference is negligible for the expected access patterns.
- Can be revisited as an optimization if profiling warrants it.