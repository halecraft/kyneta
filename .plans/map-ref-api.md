# Map-Like API for Map Refs

## Background

The schema interpreter algebra produces ref trees via `interpret(schema, interpreter, ctx)`. Maps (created via `Schema.record()` / `Schema.map()`) currently use a Proxy with an arrow function target. The Proxy's `get` trap routes all string keys to child refs via a cache, the `set` trap delegates through a `[SET_HANDLER]` symbol filled by `withMutation`, and the `deleteProperty` trap delegates through `[DELETE_HANDLER]`.

This design has a fundamental type-safety problem: `doc.labels.bug = "red"` assigns a **plain value** to a slot typed as a **ref**. At runtime the Proxy's set trap silently dispatches a `MapChange`, but TypeScript's `readonly` index signature correctly rejects this. The only workaround is an `as unknown as Record<string, string>` cast — which destroys all type safety.

Meanwhile, `@loro-extended/change`'s `RecordRef` already models maps with explicit `Map`-like methods: `.get(key)`, `.set(key, value)`, `.delete(key)`, `.has(key)`, `.keys()`, `.size`, `.entries()`, `.values()`. This is the established pattern in the project.

### Products vs Maps: Different Data Structures, Different Access Patterns

Products (structs) have **fixed, schema-known keys**. TypeScript can type each field precisely. Direct property access (`doc.settings.darkMode`) is the right model — it's a struct.

Maps (records) have **dynamic, runtime-determined keys**. A string index signature pretends every possible string key has a typed child ref, but in reality only keys present in the store exist. The right model is `Map` — explicit `.get(key)` / `.set(key, value)` with proper return types including `undefined` for missing keys.

### Sequence `.at(i)` Consistency Issue

`ReadableSequenceRef.at(i)` currently returns `T` unconditionally — it eagerly creates a child ref via the interpreter's `item(index)` thunk regardless of whether the index exists in the store. This means `.at(100)` on a 2-item array returns a zombie ref that reads `undefined` from the store, rather than returning `undefined` itself.

This is inconsistent with `Array.prototype.at()` (returns `undefined` for out-of-bounds) and with the proposed `ReadableMapRef.get(key)` (returns `undefined` for missing keys). Both collections should signal absence via `undefined` at the access site.

## Problem Statement

Map refs use a Proxy-based string index signature that conflates reads and writes into a single access pattern. Writing via `proxy.key = value` is type-unsafe (assigns a plain value where a ref is expected), requires casts to use, and differs semantically from reading (`proxy.key` returns a ref, not a plain value). The `[SET_HANDLER]` / `[DELETE_HANDLER]` composability symbol machinery exists solely to support this broken pattern. Additionally, sequence `.at(i)` silently produces zombie refs for out-of-bounds indices instead of returning `undefined`.

## Success Criteria

1. Map refs expose `Map`-like methods: `.get(key)`, `.has(key)`, `.keys()`, `.size`, `.entries()`, `.values()`, `[Symbol.iterator]` on readable refs; `.set()`, `.delete()`, `.clear()` added by `withMutation`.
2. `.get(key)` returns a child ref (callable, navigable) or `undefined` if the key is absent — consistent with `Map.get()`. The implementation checks store existence before creating a child ref.
3. `.set(key, value)` accepts `Plain<I>` (the plain value type) — type-safe, no cast needed.
4. `.delete(key)` removes a key from the store — returns `void` (matches `RecordRef`; use `.has()` before `.delete()` if existence check is needed).
5. `.clear()` removes all keys from the store.
6. No string index signature on either `Readable<MapSchema>` or `Writable<MapSchema>`.
7. No Proxy on map refs. No `[SET_HANDLER]` / `[DELETE_HANDLER]` symbols. All old Proxy-trap code and related comments are removed (not deprecated).
8. `[INVALIDATE]` symbol is retained for cache coordination between readable and mutation layers.
9. `ReadableMapRef<T>` named interface exists (parallel to `ReadableSequenceRef<T>`).
10. `Writable<MapSchema<I>>` is a clean interface with `.set()`, `.delete()`, `.clear()` — no index signature.
11. The example's map usage requires zero casts.
12. API is consistent with `@loro-extended/change`'s `RecordRef` (`.get`, `.set`, `.delete`, `.has`, `.keys`, `.size`, `.clear`).
13. `ReadableSequenceRef.at(i)` returns `T | undefined` — bounds-checked, consistent with `Array.prototype.at()` and `ReadableMapRef.get(key)`.

## Gap

- Map refs currently expose a string index signature on both `Readable` and `Writable` types.
- The Proxy `get` trap routes all string keys to child refs unconditionally — no existence check, no distinction between methods and data keys.
- `[SET_HANDLER]` / `[DELETE_HANDLER]` symbols and their Proxy trap delegation exist solely for the broken `proxy.key = value` pattern.
- No `ReadableMapRef<T>` named interface.
- `Writable<MapSchema<I>>` is `{ readonly [key: string]: Writable<I> }` — an index signature with no methods.
- Example requires `as unknown as Record<string, string>` cast for map writes.
- `Object.keys(mapRef)` and `"key" in mapRef` rely on Proxy `ownKeys`/`has` traps for store introspection — these should migrate to `.keys()` and `.has()`.
- `ReadableSequenceRef.at(i)` returns `T` unconditionally — eagerly creates zombie refs for out-of-bounds indices.
- No type-level test for `Readable<MapSchema>` exists (pre-existing gap).

## PR Stack

Three PRs, dependency-ordered. Each is individually sound (builds, tests pass, no broken intermediate states).

### PR 1: `(packages/schema) feat: sequence .at() bounds check — return T | undefined for out-of-bounds` ✅

**Why separate:** Orthogonal to the map redesign. Touches different interfaces, different interpreter cases, different tests. Small and focused. Establishes the "collections signal absence" pattern before the map PR builds on it.

**Semantic change — `.at(i)` checks bounds:** The current `ReadableSequenceRef.at(i)` unconditionally creates child refs via the interpreter's `item(index)` thunk. The fix checks the store array length first and returns `undefined` for out-of-bounds indices. This follows `Array.prototype.at()` semantics. Negative indices are treated as out-of-bounds for simplicity (see Learnings).

**Implementation:**

- `readable.ts`: Update `ReadableSequenceRef<T>` interface: `.at()` return type from `T` to `T | undefined` ✅
- `readable.ts`: Update readable interpreter `sequence` case: `.at(i)` checks store array length, returns `undefined` for out-of-bounds ✅
- `writable.ts`: Update `SequenceRef<T>` interface: `.at()` return type from `T` to `T | undefined` (parallel change) ✅

**Tests:**

- `readable.test.ts`: Add `.at(100)` → `undefined` test, `.at(-1)` → `undefined` test ✅
- `readable.test.ts`: Update existing `.at(0)` call sites to handle `| undefined` (add `!`) ✅
- `writable.test.ts`: Update `.at()` call sites (L383 `msg.author()`, L416 `msg.author`, L481 `msg.author()` — add `!`) ✅
- `example/main.ts`: Update `.at(0)` call sites (L310 `task.title()`, L594 `roDoc.tasks.at(0).title()` — add `!` or `?.`) ✅

**Not touched:** No map code, no Proxy code, no `SET_HANDLER`/`DELETE_HANDLER`, no `with-changefeed.test.ts`.

### PR 2: `(packages/schema) feat: Map-like API for map refs — ReadableMapRef, WritableMapRef, Proxy removal` 🔴

**Why atomic:** The readable map change, writable map change, test migration, example migration, export cleanup, and stale comment removal form one logical behavior change. Splitting them would leave broken intermediate states — you can't land the new interfaces without the test rewrites and old symbol removal. This is pre-1.0 experimental code; the plan says "remove, don't deprecate."

**`ReadableMapRef<T>` interface:**

```ts
export interface ReadableMapRef<T = unknown> {
  /** Callable: returns a deep plain snapshot of the entire map. */
  (): Record<string, unknown>
  /** Get a child ref by key. Returns undefined if key is not in the store. */
  get(key: string): T | undefined
  /** Check if a key exists in the store. */
  has(key: string): boolean
  /** Return all current store keys. */
  keys(): string[]
  /** Number of entries in the store. */
  readonly size: number
  /** Iterate over [key, childRef] pairs. */
  entries(): IterableIterator<[string, T]>
  /** Iterate over child refs. */
  values(): IterableIterator<T>
  /** Iterate over [key, childRef] pairs. */
  [Symbol.iterator](): IterableIterator<[string, T]>
}
```

**`Writable<MapSchema<I>>` becomes:**

```ts
{
  set(key: string, value: Plain<I>): void
  delete(key: string): void
  clear(): void
}
```

**Proxy elimination:** With the Map-like API, the Proxy is no longer needed. The target is already an arrow function (callable without an `apply` trap). Methods (`.get()`, `.has()`, `.keys()`, etc.) and symbols (`[INVALIDATE]`, `[CHANGEFEED]`) are attached directly to the function via `Object.defineProperty`. `withChangefeed` uses `attachChangefeed` → `Object.defineProperty(result, CHANGEFEED, ...)` which works directly on bare functions — no Proxy `defineProperty` trap needed. This is actually simpler than the current Proxy-mediated path.

**Method enumerability:** All map methods (`.get`, `.has`, `.keys`, `.size`, `.entries`, `.values`) and the `[Symbol.iterator]` must be attached via `Object.defineProperty` with `enumerable: false`. This ensures `Object.keys(mapRef)` returns `[]` — matching `Object.keys(new Map())` behavior and avoiding method names polluting key enumeration. Without the Proxy, the bare function accepts arbitrary property assignment; non-enumerable attachment is the replacement guardrail. Decorators must continue the convention of returning only symbol-keyed or empty protocol objects.

**Semantic change — `.get(key)` checks store existence:** The current Proxy `get` trap unconditionally creates child refs for any string key. The new `.get(key)` checks the store first and returns `undefined` for missing keys. This is a deliberate behavior change, not just a refactor.

**`.clear()` implementation note:** There is no primitive "clear" change type. `.clear()` is a compound operation: read all current keys from the store, then dispatch `mapChange(undefined, allKeys)`. This is more semantically correct than `replaceChange({})` because it stays within map-change semantics and produces a `MapChange` that subscribers can interpret. `.clear()` calls `[INVALIDATE]()` (full cache clear, no argument).

**Note:** `ReadablePlain<MapSchema>` (used inside the callable return type) is untouched — it already computes `Record<string, ReadablePlain<I>>` correctly.

**Implementation — readable layer:**

- Define `ReadableMapRef<T>` interface in `readable.ts` 🔴
- Update `Readable<MapSchema<I>>` type to use `ReadableMapRef<Readable<I>>` 🔴
- Rewrite readable interpreter `map` case: arrow function target with `.get()`, `.has()`, `.keys()`, `.size`, `.entries()`, `.values()`, `[Symbol.iterator]` attached as non-enumerable methods via `Object.defineProperty`; `.get()` checks store existence before creating child ref; `[INVALIDATE]` retained; no Proxy 🔴
- Remove `SET_HANDLER` and `DELETE_HANDLER` symbol definitions from `readable.ts` 🔴
- Remove all Proxy-trap-related comments in `readable.ts` map case header 🔴

**Implementation — writable layer:**

- Define `WritableMapRef` interface (or inline in `Writable` type) in `writable.ts` — `.set(key, value)`, `.delete(key)`, `.clear()` 🔴
- Update `Writable<MapSchema<I>>` type: replace `{ readonly [key: string]: Writable<I> }` with the new map mutation interface 🔴
- Rewrite `withMutation` map case: attach `.set()`, `.delete()`, `.clear()` directly to the result, with `[INVALIDATE]` calls for cache coordination 🔴
- Remove `SET_HANDLER` and `DELETE_HANDLER` imports from `writable.ts` 🔴
- Remove all `SET_HANDLER` / `DELETE_HANDLER` related code from `withMutation` map case 🔴

**Implementation — changefeed & exports:**

- Remove stale Proxy comments in `with-changefeed.ts` ("bypasses Proxy set traps" etc.) 🔴
- `index.ts`: remove `SET_HANDLER` and `DELETE_HANDLER` exports 🔴
- `index.ts`: add `ReadableMapRef` and `WritableMapRef` (if named) to type exports 🔴

**Tests — readable:**

- `readable.test.ts`: rewrite "map via Proxy" describe block (rename to "map ref") 🔴
  - `doc.metadata.version` → `doc.metadata.get("version")`
  - `Object.keys(doc.metadata)` → `doc.metadata.keys()`
  - `"version" in doc.metadata` → `doc.metadata.has("version")`
  - Remove "map proxy rejects writes when no SET_HANDLER is installed" test
  - Add tests for `.get("nonexistent")` returning `undefined`, `.size`, `.entries()`, `.values()`, `[Symbol.iterator]`
- `readable.test.ts`: update composability hooks tests 🔴
  - Remove `SET_HANDLER` / `DELETE_HANDLER` symbol tests
  - Keep `INVALIDATE` symbol test
  - Update `INVALIDATE` map tests to use `.get()` instead of dot access
- `readable.test.ts`: add type-level test for `Readable<MapSchema>` (new coverage, not migration) 🔴

**Tests — writable:**

- `writable.test.ts`: rewrite map tests 🔴
  - `doc.metadata.get("version")` for reads
  - `doc.metadata.set("newKey", "newValue")` for writes
  - `doc.metadata.delete("version")` for deletes
  - `doc.metadata.keys()` for key listing
  - `doc.metadata.has("version")` for existence
  - Add `.clear()` test
- `writable.test.ts`: rewrite map mutation tests (L485–495) 🔴
  - `proxy.key = value` → `doc.metadata.set("newKey", "newValue")`
  - `delete proxy.key` → `doc.metadata.delete("version")`

**Tests — changefeed (all four map-touching tests by name):**

- `with-changefeed.test.ts` 🔴
  - `"map refs have changefeed (via Proxy defineProperty trap)"` → rename to `"map refs have changefeed"`
  - `"[CHANGEFEED] is accessible on map proxy via symbol"` → rename to `"[CHANGEFEED] is accessible on map ref via symbol"`
  - `"Object.keys on map proxy returns only store keys"` → **rewrite**: `Object.keys` on a bare function no longer returns store keys; migrate to `doc.metadata.keys()` and update assertion + test name (e.g. `"map ref .keys() returns store keys"`)
  - `hasChangefeed(doc.metadata)` for changefeed checks (already available, cleaner than `CF_SYM in (doc.metadata as object)`)
  - `doc.metadata.keys()` for key listing wherever `Object.keys(doc.metadata)` was used

**Tests — types:**

- `types.test.ts`: update `Writable<S>` map type assertions — replace `{ readonly [key: string]: ScalarRef<unknown> }` with new `WritableMapRef` shape 🔴

**Example & plan cleanup:**

- `example/main.ts`: rewrite section 5 (Records) — no casts needed 🔴
  - `doc.labels.set("bug", "red")` for writes
  - `doc.labels.get("bug")!()` for reads (or just log the ref)
  - `doc.labels.keys()` for key listing
  - `doc.labels.has("bug")` for existence
  - Remove the `const labels = doc.labels as unknown as Record<string, string>` cast
- `example/README.md`: update section 5 description 🔴
- `readable-interpreter.md` plan: remove references to `SET_HANDLER` / `DELETE_HANDLER` in the Composability hooks section and elsewhere; these are historical artifacts of a design that no longer exists 🔴

**Not touched:** `schema.ts`, `loro-schema.ts`, `change.ts`, `step.ts`, `store.ts`, `combinators.ts`, `guards.ts`, `changefeed.ts`, `plain.ts`, `validate.ts`, `interpret.ts`.

### PR 3: `(packages/schema) docs: update TECHNICAL.md and plans for Map-like API` 🔴

**Why separate:** Pure documentation. No code behavior. Different reviewer attention than the implementation PRs.

**Tasks:**

- Update TECHNICAL.md §"Readable Interpreter": replace Proxy map description with Map-like API; document `.get()` store-existence check; document sequence `.at()` bounds check; note that map iteration follows `Map` semantics (yields `[key, ref]` entries) while sequence iteration follows `Array` semantics (yields bare refs) 🔴
- Update TECHNICAL.md §"Mutation Layer": replace Proxy handler installation with direct method attachment for maps; document `.clear()` 🔴
- Update TECHNICAL.md §"Composability hooks": remove `[SET_HANDLER]` / `[DELETE_HANDLER]` entirely; note only `[INVALIDATE]` remains for maps 🔴
- Update TECHNICAL.md §"Verified Properties": update map-related properties (Map-like API, no Proxy); add sequence `.at()` bounds-check property 🔴

## Test Specifications

### PR 1 tests (sequence `.at()` bounds check)

- `sequenceRef.at(0)` returns child ref when index exists
- `sequenceRef.at(100)` returns `undefined` when out of bounds
- `sequenceRef.at(-1)` returns `undefined` (negative indices treated as out-of-bounds; see Learnings)
- `ReadableSequenceRef.at()` return type includes `undefined`
- `SequenceRef.at()` return type includes `undefined`

### PR 2 tests (Map-like API)

**Read-only Map-like API:**

- `mapRef.get("version")` returns a callable child ref
- `mapRef.get("version")!()` returns the plain value
- `mapRef.get("nonexistent")` returns `undefined`
- `mapRef.has("version")` returns `true`
- `mapRef.has("nonexistent")` returns `false`
- `mapRef.keys()` returns current store keys
- `mapRef.size` reflects store entry count
- `mapRef()` returns deep plain record snapshot
- `typeof mapRef` → `"function"` (still callable)
- `mapRef.entries()` yields `[key, childRef]` pairs
- `mapRef.values()` yields child refs
- `for (const [k, v] of mapRef)` iterates entries
- `.get(key)` caches child refs (referential identity): `mapRef.get("x") === mapRef.get("x")`

**Composability:**

- `mapRef[INVALIDATE]` is a function (cache coordination)
- `mapRef[INVALIDATE]("key")` clears single cache entry — subsequent `.get()` returns fresh ref
- `mapRef[INVALIDATE]()` clears full cache
- `enrich(readableInterpreter, withChangefeed)` attaches `[CHANGEFEED]` to bare-function map refs (no Proxy needed)

**Writable Map-like API:**

- `mapRef.set("newKey", "value")` dispatches change and updates store
- `mapRef.delete("version")` dispatches change and removes from store
- `mapRef.clear()` removes all keys from the store
- After `.set("k", v)`, `mapRef.get("k")!()` returns the new value
- After `.delete("k")`, `mapRef.has("k")` returns `false`
- After `.clear()`, `mapRef.size` is `0` and `mapRef.keys()` returns `[]`
- Cache invalidation: after `.set("k", v)`, `.get("k")` returns a fresh child ref
- Cache invalidation: `.clear()` clears the full child cache

**Type-level:**

- `Readable<MapSchema<ScalarSchema<"string">>>` is `ReadableMapRef<Readable<ScalarSchema<"string">>>`
- `Writable<MapSchema<ScalarSchema<"string">>>` has `.set(key, value)`, `.delete(key)`, `.clear()` but no index signature
- `Readable<...> & Writable<...>` intersection for maps has `.get()`, `.set()`, `.delete()`, `.clear()`, `.has()`, `.keys()`, `.size` — all accessible, no conflicts

## Transitive Effect Analysis

### `ReadableMapRef` replaces string index signature → `Readable<S>` type

`Readable<MapSchema<I>>` changes from `(() => Record) & { readonly [key: string]: Readable<I> }` to `ReadableMapRef<Readable<I>>`. Any code that accesses map children via dot notation (`doc.metadata.version`) must switch to `.get("version")`. Affects: `readable.test.ts`, `writable.test.ts`, `with-changefeed.test.ts`, `example/main.ts`.

### `Writable<MapSchema>` drops index signature → `types.test.ts`

The end-to-end `Writable<S>` type assertions for maps (`{ readonly [key: string]: ScalarRef<unknown> }`) must be updated to the new method-based interface.

### `SET_HANDLER` / `DELETE_HANDLER` removal → `index.ts`, `readable.ts`, `writable.ts`

These symbols are exported from `index.ts`, defined in `readable.ts`, imported in `writable.ts`. All three files are cleaned up as part of implementation — no deprecation period, no backward compatibility shims.

### `withChangefeed` `attachChangefeed` → works directly on bare functions

`withChangefeed` uses `attachChangefeed` → `Object.defineProperty(result, CHANGEFEED, ...)`. The current comment says "this bypasses Proxy set traps — goes through defineProperty trap." With the Proxy eliminated, `Object.defineProperty` on the bare function works directly — simpler than before. The stale comment is removed as part of the implementation.

### `enrich` `Object.assign` → no-op for `withChangefeed`, works on functions

`enrich` calls `Object.assign(result, protocol)`. For `withChangefeed`, `protocol` is `{}` (empty — the real work is in `attachChangefeed`). `Object.assign(fn, {})` on a bare function is a no-op. No issue.

### `Object.keys()` / `in` operator behavior change

Currently `Object.keys(mapRef)` returns store keys and `"key" in mapRef` checks the store. After the change, these revert to standard JS behavior on functions. Code must switch to `.keys()` and `.has()`. Affects: `readable.test.ts`, `writable.test.ts`, `with-changefeed.test.ts`, `example/main.ts`.

### `ReadableSequenceRef.at()` return type `T → T | undefined` → all `.at()` call sites

Any code that chains `.at(i).field()` without a null check will need `?.` optional chaining. Affects: `readable.test.ts`, `writable.test.ts`, `example/main.ts`. This is the correct behavior — crashing at the access site is better than silently reading `undefined` from a zombie ref.

### No impact on: `schema.ts`, `loro-schema.ts`, `change.ts`, `step.ts`, `zero.ts`, `describe.ts`, `interpret.ts`, `store.ts`, `plain.ts`, `validate.ts`, `combinators.ts`, `guards.ts`, `changefeed.ts`

These modules don't reference map ref types, sequence ref types, or produce map/sequence refs.

### Downstream (out of scope, noted for follow-up)

- **`@loro-extended/change` `RecordRef`**: Already uses the Map-like API. Schema's new API aligns with it. No changes needed.
- **Kinetic**: Does not reference schema map or sequence refs directly. No impact.

## Resources for Implementation Context

- `packages/schema/src/interpreters/readable.ts` — current Proxy-based map implementation (L340–453), sequence implementation (L286–335), `ReadableSequenceRef` interface (L94–99), `Readable<S>` type (L120–168), `SET_HANDLER`/`DELETE_HANDLER` symbol definitions (L55–83)
- `packages/schema/src/interpreters/writable.ts` — current `withMutation` map case (L470–510), `Writable<MapSchema>` type (L339–340), `SequenceRef` interface (L187–194)
- `packages/schema/src/__tests__/readable.test.ts` — map tests (L266–303), composability hook tests (L391–412), sequence tests (L222–260)
- `packages/schema/src/__tests__/writable.test.ts` — map tests (L140–157), map mutation tests (L485–495), sequence tests (L375–398)
- `packages/schema/src/__tests__/with-changefeed.test.ts` — map changefeed tests (L89–93, L120–128)
- `packages/schema/src/__tests__/types.test.ts` — map type assertions (L374–380), sequence type assertions (L294–316)
- `packages/schema/example/main.ts` — map usage in section 5 (L326–344), sequence usage in section 4 (L290–316)
- `packages/schema/src/index.ts` — `SET_HANDLER`/`DELETE_HANDLER` exports to remove, `ReadableMapRef` to add
- `packages/schema/src/interpreters/with-changefeed.ts` — `attachChangefeed` uses `Object.defineProperty` (L158–165), stale Proxy comment to remove (L328)
- `packages/change/src/typed-refs/record-ref.ts` — `RecordRef` with `.get()`, `.set()`, `.delete()`, `.has()`, `.keys()`, `.size`, `.entries()`, `.values()`, `.clear()` — the target API shape
- `packages/schema/TECHNICAL.md` — documentation target (§Readable Interpreter, §Mutation Layer, §Composability hooks, §Verified Properties)

## Alternatives Considered

### Keep Proxy `set` trap with non-`readonly` index signature

Remove `readonly` from `Writable<MapSchema>` so `proxy.key = value` compiles. Rejected because:

- The value being assigned is a plain value, but the type at that position is a ref — fundamental type mismatch
- Conflates two operations: reading returns a ref, writing accepts a plain value
- Doesn't match `@loro-extended/change`'s established `RecordRef` pattern
- `Map` semantics are well-understood; magical Proxy assignment is not

### Keep string index signature on `Readable` alongside methods

Have both `doc.labels.bug` (via index) and `doc.labels.get("bug")` (via method) for reads. Rejected because:

- Two ways to do the same thing — confusing
- Index signature claims every string key returns a ref, but missing keys return `undefined` at runtime — the type lies
- Method names (`get`, `set`, `delete`, `has`, `keys`, `size`) would collide with index signature — a key literally named `"get"` would shadow the method
- Products already own the "direct property access" pattern; maps should be distinct

### Symbol-keyed mutation methods

Put `.set` and `.delete` behind symbols (`[MAP_SET]`, `[MAP_DELETE]`) to avoid potential key collisions. Rejected because:

- Terrible DX: `doc.labels[MAP_SET]("bug", "red")`
- `Map` doesn't have this problem — method name collision with data keys is a well-understood trade-off
- Keys named `"get"`, `"set"`, `"delete"` are extremely unlikely in practice
- `@loro-extended/change`'s `RecordRef` uses plain method names without issue

### Keep `ownKeys` / `has` Proxy traps for `Object.keys()` / `in` operator

Keep `Object.keys(mapRef)` returning store keys and `"key" in mapRef` checking the store for backward compat. Rejected because:

- Inconsistent with `Map` semantics (`Object.keys(aMap)` returns `[]`)
- `.keys()` and `.has()` are explicit, discoverable, and type-safe
- Keeping Proxy traps for these when the primary access pattern is methods adds complexity for no benefit
- The `ownKeys` invariant requirements for Proxy with function targets are a source of subtle bugs

### Keep `.at(i)` returning `T` unconditionally

Leave the current behavior where `.at(100)` on a 2-item array creates a zombie ref. Rejected because:

- Inconsistent with `Array.prototype.at()` which returns `undefined` for out-of-bounds
- Inconsistent with the new `ReadableMapRef.get(key)` which returns `undefined` for missing keys
- A zombie ref silently reads `undefined` from the store — the developer has no way to distinguish "index doesn't exist" from "index has an `undefined` value"
- The `T | undefined` return type forces correct null-checking at the access site

## Learnings

### Products and maps are fundamentally different

Products have fixed, schema-known keys — direct property access is the right model. Maps have dynamic, runtime-determined keys — `Map`-like explicit methods are the right model. Conflating them with a single "string index signature" access pattern created the type-safety problem.

### Proxy traps are a poor mutation interface

The `set` trap conflates "assign a value to a property" (JavaScript semantics) with "dispatch a change to the store" (application semantics). The types can't express this — `proxy.key` returns `Ref<T>` on read but expects `Plain<T>` on write. Explicit methods make the asymmetry visible and type-safe.

### Collections should signal absence, not produce zombies

Both `Map.get("missing")` and `Array.prototype.at(100)` return `undefined`. Our collection refs should do the same. Eagerly creating child refs for absent entries produces objects that "work" but silently read `undefined` from the store — a footgun that's impossible to distinguish from a legitimate `undefined` value. Returning `undefined` from the access method forces the developer to handle absence explicitly.

### Negative indices in `.at()`

`Array.prototype.at(-1)` returns the last element. We should decide whether `ReadableSequenceRef.at(-1)` follows this convention. For simplicity, the initial implementation treats negative indices as out-of-bounds (returns `undefined`). Supporting negative indices is a small follow-up if desired — the semantics are `index < 0 ? length + index : index`, then bounds-check.

### `@loro-extended/change` already solved the map problem

`RecordRef` has `.get(key)`, `.set(key, value)`, `.delete(key)`, `.has(key)`, `.keys()`, `.size`, `.clear()`. The schema package should follow the same pattern for consistency across the project.

### The readable/writable decomposition maps perfectly to Map's read/write surface

`Map` has `.get()`, `.has()`, `.keys()`, `.size`, `.entries()`, `.values()`, `[Symbol.iterator]` as read operations, and `.set()`, `.delete()`, `.clear()` as write operations. This maps directly to `ReadableMapRef` = read surface, `WritableMapRef` = write surface. A developer who knows `Map` already knows the schema map API.

### Composability symbols should be minimal

`[SET_HANDLER]` and `[DELETE_HANDLER]` were over-engineered. The mutation layer can attach methods directly — same pattern as sequences. Only `[INVALIDATE]` is needed for cross-layer cache coordination.

### The Proxy was load-bearing for the wrong reasons

The map Proxy existed to support three things: (1) routing all string keys to child refs, (2) `set`/`deleteProperty` traps for mutation, (3) `ownKeys`/`has` for store introspection. With the Map-like API, all three move to explicit methods. The arrow function target is already callable. Methods and symbols attach directly to functions. The Proxy can be eliminated entirely — a significant simplification.

### Experimental code should be removed, not deprecated

This codebase is pre-1.0 experimental. When a design is superseded, the old code is deleted — no deprecation notices, no backward compatibility shims, no transition period. This keeps the codebase lean and unambiguous.

### Implementation phases ≠ PR boundaries

Implementation phases describe *what to build in what order*. PR boundaries describe *what to ship as a reviewable unit*. For this plan, the five original phases (readable map, writable map, test migration, example migration, docs) collapsed into three PRs because: (1) the `.at()` bounds check is orthogonal to the map work and can land independently; (2) the readable + writable map changes break all map tests, so tests must ship with the implementation; (3) pre-1.0 code doesn't need a backward-compatible intermediate state, so "add new API → migrate → remove old API" collapses to one atomic PR.

### Map iteration follows `Map`, sequence iteration follows `Array`

`ReadableMapRef[Symbol.iterator]` yields `[string, T]` pairs (matching `Map`). `ReadableSequenceRef[Symbol.iterator]` yields `T` (matching `Array`). This is correct — maps iterate as entries, arrays iterate as values — but the asymmetry should be documented because `for (const x of mapRef)` and `for (const x of seqRef)` produce different shapes.