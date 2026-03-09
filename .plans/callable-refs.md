# Callable Refs

## Background

The `packages/schema` writable interpreter produces ref objects at each schema node: `ScalarRef<T>`, `TextRef`, `CounterRef`, `SequenceRef<T>`, plus plain objects for products and Proxies for maps. Reading the current value requires `.get()` on leaf refs — a pragmatic compromise inherited from `@loro-extended/change`, where direct value access was abandoned because refs need to carry both a getter and mutation methods. (Note: `@loro-extended/change` is production code and is not in scope for changes here.)

The writable interpreter currently **mixes read and write concerns**: each ref has both mutation methods (`.set()`, `.insert()`, `.increment()`) and read methods (`.get()`, `.toString()`). We want the callable read surface to be a **composable concern** — a combinator that wraps any interpreter's results in function objects — rather than fused into the writable interpreter itself. This follows the same separation-of-concerns pattern as `withChangefeed`, which adds observation as a composable decorator.

Separately, the `Changefeed` coalgebra (`{ current: S, subscribe(cb): unsub }`) provides `.current` as the reactive read and `.subscribe` as the delta stream. The `withChangefeed` decorator attaches this as a `[CHANGEFEED]` symbol property on ref objects.

Through design discussion, we identified that:

1. **`.get()` and `.current` are both "read the current value"** — duplicated across writable refs and the changefeed protocol.
2. **A callable ref** (`ref()` → current value) is a clean unification: the node itself is a function that returns its current plain value when called.
3. **For leaf nodes**, `ref()` returns the primitive (`42`, `"Hello"`). For structural nodes, `ref()` returns `Plain<S>` — a deep snapshot equivalent to `toJSON()` scoped to that subtree.
4. **The Changefeed protocol stays as-is.** `{ current, subscribe }` is the minimum protocol for any reactive value (not just schema refs). `.current` is the shallow live read for the reactive mount cycle ("read current, then subscribe for deltas"). The callable `()` is a schema-specific convenience for imperative deep snapshots.
5. **`SequenceRef.get(i)` is navigation, not reading** — it takes an argument and returns a child ref. It should be renamed to `.at(i)` to avoid confusion with the no-arg callable pattern, and to align with `Array.prototype.at()`.
6. **`[Symbol.toPrimitive]`** on leaf refs enables `\`Stars: ${doc.stars}\`` in template literals with no downside. The implementation should be **hint-aware** (following the precedent set by `@loro-extended/change`'s `CounterRef`): when hint is `"string"`, coerce to string; otherwise return the natural type. `valueOf()` is explicitly excluded — too many gotchas with `===`, type confusion, and the `+` prefix trap.

### Relationship to Changefeed

The Changefeed is a **general protocol** — any reactive value can implement it, with or without a schema. A developer might implement `[CHANGEFEED]` on a Zustand store slice or a custom reactive counter. The callable `()` is a **schema-specific enhancement** that only interpreter-produced refs offer. The two are complementary:

| | `ref()` | `ref[CHANGEFEED].current` |
|---|---|---|
| Depth | Deep (`Plain<S>`) | Shallow (raw store value) |
| Audience | Developer, imperative code | Framework mount cycle |
| Cost | O(subtree) for structural | O(1) |
| Schema required | Yes | No — any reactive value |

At leaf nodes, both return the same primitive. At structural nodes, they differ: `()` produces a deep plain snapshot; `.current` returns the shallow store value for the reactive protocol's "read then subscribe" pattern.

## Problem Statement

The current ref API has three overlapping read mechanisms (`.get()`, `[CHANGEFEED].current`, `plainInterpreter`) with no unifying concept. `.get()` is the primary developer-facing read, but it's a method call that adds syntactic noise and doesn't compose — you can't `\`Stars: ${doc.stars}\`` because `doc.stars` is a `ScalarRef`, not a number.

## Success Criteria

1. A `callable()` interpreter combinator exists that wraps any interpreter's results in function objects: `ref()` returns the current plain value (`Plain<S>`).
2. When composed as `callable(writableInterpreter)`: `ScalarRef<T>`, `TextRef`, `CounterRef` — calling returns the primitive.
3. Product refs — calling returns the deep plain snapshot (`{ darkMode: true, fontSize: 14 }`).
4. `SequenceRef<T>` — calling returns the plain array. `.get(i)` is renamed to `.at(i)`.
5. Map refs — calling returns the deep plain record.
6. Leaf refs support `[Symbol.toPrimitive]` for template literal coercion (hint-aware).
7. `.get()` is removed from all ref interfaces (no deprecation period — this is a pre-1.0 spike). The writable interpreter becomes a pure mutation surface.
8. `Writable<S>` type reflects mutation-only interfaces (no call signatures). A new `Callable<S>` type adds call signatures for use with `callable(writableInterpreter)`.
9. The `callable()` combinator, `enrich` combinator, and `withChangefeed` decorator compose cleanly: `enrich(callable(writableInterpreter), withChangefeed)`.
10. All existing behavior (mutation methods, changefeed subscription, lazy product getters, Proxy maps) is preserved.
11. Changefeed `.current` is unchanged — it remains the shallow reactive read.
12. Read and write concerns are separated: `writableInterpreter` = mutation, `callable()` = reading, `withChangefeed` = observation.

## Gap

- Ref interfaces (`ScalarRef`, `TextRef`, `CounterRef`, `SequenceRef`) use `.get()` with no call signature.
- Ref factory functions (`createScalarRef`, `createTextRef`, `createCounterRef`) produce plain objects, not function objects.
- Product refs and sequence refs are plain objects — not callable.
- `isNonNullObject` guard returns `false` for functions, causing `enrich` and `withChangefeed` to mishandle function-object refs.
- `hasChangefeed` in `changefeed.ts` checks `typeof value === "object"`, which would return `false` for function-object refs.
- `Writable<S>` type has no call signatures.
- No `[Symbol.toPrimitive]` support on any ref.
- No combinator exists for wrapping interpreter results in function objects — the read concern is entangled with the write concern in `writableInterpreter`.

## Phases

### Phase 1: Update guards to accept functions 🔴

The `isNonNullObject` guard is used by `enrich`, `withChangefeed`, `plainInterpreter`, `validateInterpreter`, `store.ts`, and `zero.ts`. Currently it checks `typeof value === "object"`, which excludes functions. Since callable refs are function objects, the guard must also accept functions in the specific places where "can I attach properties / iterate keys?" is the intent. Separately, `hasChangefeed` in `changefeed.ts` has its own inline `typeof value === "object"` check that would also reject function-object refs.

**Tasks:**

- Add a new `isPropertyHost(value): value is object` guard in `guards.ts` that accepts both objects and functions 🔴
- Replace `isNonNullObject` with `isPropertyHost` in `enrich` (`combinators.ts`) 🔴
- Replace `isNonNullObject` with `isPropertyHost` in `withChangefeed` decorator (`with-changefeed.ts`) 🔴
- Update `hasChangefeed` in `changefeed.ts` to accept functions: change `typeof value === "object"` to `(typeof value === "object" || typeof value === "function")` 🔴
- Keep `isNonNullObject` unchanged for callers where "is this a plain JS object?" is the correct semantic (store reads in `store.ts`, validation in `validate.ts`, zero overlay in `zero.ts`, plain interpreter, writable sum dispatch) 🔴
- Add tests: `isPropertyHost` returns `true` for functions, objects, arrays; `false` for primitives and null 🔴
- Add test: `hasChangefeed` returns `true` for a function with `[CHANGEFEED]` attached 🔴

### Phase 2: `callable()` combinator 🔴

Add a new interpreter-level combinator `callable(base)` in `combinators.ts` that wraps any interpreter's results in function objects. This is the **read concern as a composable piece** — analogous to how `enrich(base, withChangefeed)` adds observation, `callable(base)` adds the call-to-read surface.

The combinator operates at the same level as `enrich` (interpreter → interpreter) but with an **inverted merge direction**: instead of merging new protocol *onto* the existing result (`Object.assign(result, protocol)`), it creates a *new function* and copies the existing result's properties *onto the function*.

**Why a combinator, not fused into `writableInterpreter`:**

The writable interpreter should own **mutation only** (`.set()`, `.insert()`, `.increment()`, `.push()`, etc.). The read surface (callable `()` + `[Symbol.toPrimitive]`) is a separate concern. Keeping them composable means:
- A consumer can use `writableInterpreter` alone for write-only contexts (e.g. server-side batch operations where callable overhead is unwanted).
- The callable combinator could wrap *any* interpreter, not just writable — e.g. a future readonly interpreter.
- It follows the established pattern: `enrich` adds observation, `callable` adds reading, `writableInterpreter` provides mutation.

**Combinator signature:**

```ts
function callable<Ctx>(
  base: Interpreter<Ctx, unknown>,
  read: (ctx: Ctx, path: Path) => unknown,
): Interpreter<Ctx, unknown>
```

The `read` parameter decouples the combinator from `Store` — any interpreter with any context that can produce a read value can be made callable. The standard call site is `callable(writableInterpreter, (ctx, path) => readByPath(ctx.store, path))`. This is zero-cost parameterization that keeps the combinator truly generic.

**Tasks:**

- Implement `callable()` combinator in `combinators.ts` 🔴
- For each interpreter case (`scalar`, `product`, `sequence`, `map`, `sum`, `annotated`): run the base, create a function whose body is the read, copy base result's properties onto the function 🔴
- `annotated` case dispatches on `schema.tag` to add `[Symbol.toPrimitive]` for leaf refs (`"text"`, `"counter"`) and type-appropriate coercion for scalars 🔴
- For maps: the base result is a Proxy, so `callable` returns a new Proxy with a function target, an `apply` trap for the call, and all other traps forwarding to the base Proxy 🔴
- Add tests: `callable(writableInterpreter)` produces callable refs at every node type 🔴

**Implementation pattern — leaf refs (scalar, text, counter):**

```ts
function wrapInFunction(result: unknown, ctx: Ctx, path: Path): unknown {
  const fn = function() { return readByPath(ctx.store, path) }
  // Copy ALL own properties (string + symbol, getters + values, enumerable + non-enumerable)
  // Object.getOwnPropertyDescriptors already includes symbol-keyed properties —
  // no separate Object.getOwnPropertySymbols loop needed.
  Object.defineProperties(fn, Object.getOwnPropertyDescriptors(result as object))
  return fn
}
```

**Implementation pattern — products:**

The base interpreter produces `{ settings: [lazy getter], metadata: [lazy getter] }`. The combinator creates a function and copies the lazy getters (as property descriptors) onto it. `Object.getOwnPropertyDescriptors` preserves getter/setter definitions, so lazy caching works unchanged on the new function host.

```ts
// In the product case:
const baseResult = base.product(ctx, path, schema, fields)
const fn = function() { return read(ctx, path) }
Object.defineProperties(fn, Object.getOwnPropertyDescriptors(baseResult as object))
return fn
```

**Implementation pattern — maps (Proxy-on-Proxy):**

The base result is `new Proxy(plainTarget, traps)`. The combinator wraps it:

```ts
const baseProxy = base.map(ctx, path, schema, item)
const fn = function() { return read(ctx, path) }
return new Proxy(fn, {
  apply() { return read(ctx, path) },
  get(_target, prop, receiver) { return Reflect.get(baseProxy, prop, receiver) },
  set(_target, prop, value, receiver) { return Reflect.set(baseProxy, prop, value, receiver) },
  has(_target, prop) { return Reflect.has(baseProxy, prop) },
  ownKeys() { return Reflect.ownKeys(baseProxy) },
  getOwnPropertyDescriptor(_target, prop) { return Reflect.getOwnPropertyDescriptor(baseProxy, prop) },
  defineProperty(_target, prop, desc) { return Reflect.defineProperty(baseProxy, prop, desc) },
  deleteProperty(_target, prop) { return Reflect.deleteProperty(baseProxy, prop) },
})
```

This is Proxy-on-Proxy: every property access goes through two trap dispatches. This is the one localized cost of the composable approach — maps already use one Proxy, so it becomes two. The overhead is acceptable because map access is already Proxy-mediated and the `apply` trap only fires on `proxy()` calls.

**Implementation pattern — `[Symbol.toPrimitive]` on leaf refs:**

The `annotated` case has access to `schema.tag`, so it can dispatch:

```ts
annotated(ctx, path, schema, inner) {
  const result = base.annotated(ctx, path, schema, inner)
  const fn = wrapInFunction(result, ctx, path)
  if (schema.tag === "text") {
    fn[Symbol.toPrimitive] = (_hint: string) => read(ctx, path)
  } else if (schema.tag === "counter") {
    fn[Symbol.toPrimitive] = (hint: string) => {
      const v = read(ctx, path)
      return hint === "string" ? String(v) : v
    }
  }
  return fn
}
```

For unannotated scalars, the `scalar` case adds a generic `toPrimitive`:

```ts
scalar(ctx, path, schema) {
  const result = base.scalar(ctx, path, schema)
  const fn = wrapInFunction(result, ctx, path)
  fn[Symbol.toPrimitive] = (hint: string) => {
    const v = read(ctx, path)
    return hint === "string" ? String(v) : v
  }
  return fn
}
```

`[Symbol.toPrimitive]` is **hint-aware** (matching `@loro-extended/change` precedent):
- `ScalarRef<T>`: when hint is `"string"`, returns `String(value)`; otherwise returns `value` as-is.
- `TextRef`: always returns the string (all hints produce the same result).
- `CounterRef`: when hint is `"string"`, returns `String(n)`; otherwise returns the number.

> **`name` and `length` shadowing:** Functions have built-in `.name`, `.length`, and `.prototype` properties. When `Object.getOwnPropertyDescriptors` copies from a base product result (which has `configurable: true` getters), these shadow the function's own properties — correct behavior. For **sequence refs**, `.length` from the base result (a getter reflecting the backing array length) naturally shadows `Function.prototype.length`. A schema product field named `name` is arguably confusing ("name of what?") but is a schema-author concern — we just need to ensure the mechanism works.

### Phase 3: Remove `.get()` from writable interpreter, rename `.get(i)` to `.at(i)` 🔴

With the read surface now owned by the `callable()` combinator, the writable interpreter's ref interfaces and factories drop `.get()`. This makes `writableInterpreter` a pure **mutation surface**. The `.get(i)` indexed navigation on `SequenceRef` is renamed to `.at(i)` for consistency with `Array.prototype.at()`.

**Updated ref interfaces (mutation only):**

```ts
interface ScalarRef<T = unknown> {
  set: (value: T) => void
}

interface TextRef {
  toString: () => string
  insert: (index: number, content: string) => void
  delete: (index: number, length: number) => void
  update: (content: string) => void
}

interface CounterRef {
  increment: (n?: number) => void
  decrement: (n?: number) => void
}

interface SequenceRef<T = unknown> {
  at: (index: number) => T
  push: (...items: unknown[]) => void
  insert: (index: number, ...items: unknown[]) => void
  delete: (index: number, count?: number) => void
  readonly length: number
  [Symbol.iterator](): Iterator<T>
  toArray: () => unknown[]
}
```

Note: `TextRef.toString()` is kept — it's a standard JS protocol method, not a "read" in the callable sense. It's used by string coercion (`String(ref)`, template literals without `toPrimitive`). `SequenceRef.at(i)` is navigation (returns a child ref), not reading (doesn't return a plain value).

**Tasks:**

- Remove `.get()` from `ScalarRef`, `TextRef`, `CounterRef` interfaces 🔴
- Remove `.get()` implementations from `createScalarRef`, `createTextRef`, `createCounterRef` 🔴
- Rename `.get(i)` to `.at(i)` on `SequenceRef` interface 🔴
- Rename `.get(i)` to `.at(i)` in `writableInterpreter.sequence()` implementation, including internal usages in `[Symbol.iterator]` and `.toArray()` 🔴

### Phase 4: Update `Writable<S>` type and add `Callable<S>` type 🔴

The `Writable<S>` type should reflect the mutation-only interfaces (no call signatures — those come from `callable()`). A new `Callable<S>` type alias adds call signatures at every level, for use when `callable(writableInterpreter)` is the interpreter.

**Tasks:**

- Update `Writable<S>` — leaf cases reference the mutation-only interfaces (no `.get()`, no call signature) 🔴
- Add `Callable<S>` type: `Writable<S> & (() => Plain<S>)` at product/sequence/map/doc levels; `Writable<S> & (() => T) & { [Symbol.toPrimitive]: (hint: string) => ... }` at leaf levels 🔴
- Add type-level tests: `Callable<ProductSchema<...>>` has call signature returning `Plain<ProductSchema<...>>`, etc. 🔴
- Add type-level tests: `Writable<ProductSchema<...>>` does NOT have call signature (mutation only) 🔴

### Phase 5: Migrate tests and example 🔴

Update all `.get()` call sites to use the callable pattern, and `.get(i)` to `.at(i)`. Tests that use `writableInterpreter` directly (without `callable()`) switch to `callable(writableInterpreter, readFn)` where reads are needed. Define a shared `readFn` helper in test fixtures: `const readFn = (ctx, path) => readByPath(ctx.store, path)`.

**Tasks:**

- Migrate `writable.test.ts`: all `.get()` → `()`, all `.get(i)` → `.at(i)`, interpreter construction uses `callable(writableInterpreter, readFn)` 🔴
- Migrate `with-changefeed.test.ts`: interpreter construction uses `callable(writableInterpreter, readFn)` wrapped in `enrich(..., withChangefeed)`. Composition order: `enrich(callable(writableInterpreter, readFn), withChangefeed)` 🔴
- Migrate `example/main.ts`: all `.get()` → `()`, all `.get(i)` → `.at(i)`, use `callable(writableInterpreter, readFn)` 🔴
- Verify all 423+ tests pass 🔴

### Phase 6: Documentation 🔴

**Tasks:**

- Update TECHNICAL.md §"Interpreters" table: add `callable()` combinator row 🔴
- Update TECHNICAL.md §"Writable Interpreter": describe mutation-only interfaces (no `.get()`), note that read surface comes from `callable()` 🔴
- Update TECHNICAL.md §"Type-Level Interpretation": add `Callable<S>` alongside `Plain<S>` and `Writable<S>` 🔴
- Update TECHNICAL.md §"File Map": add `callable` to `combinators.ts` description 🔴
- Update TECHNICAL.md §"Verified Properties": add callable-specific properties (every callable ref returns `readByPath` when called, `toPrimitive` works in template literals, `Object.keys` returns only schema keys on callable function objects) 🔴
- Update ref interface JSDoc in `writable.ts` to clarify mutation-only surface 🔴
- Document the composition algebra: `writableInterpreter` = mutation, `callable()` = reading, `withChangefeed` = observation 🔴

## Tests

### Phase 1 tests (guards)

- `isPropertyHost(fn)` → `true` for regular functions, arrow functions, objects, arrays
- `isPropertyHost(null)` → `false`
- `isPropertyHost(42)` → `false`
- `isPropertyHost(undefined)` → `false`
- `isNonNullObject` behavior unchanged (still `false` for functions)
- `hasChangefeed(fn)` → `true` when function has `[CHANGEFEED]` property attached
- `hasChangefeed(fn)` → `false` for plain function without `[CHANGEFEED]`

### Phase 2 tests (`callable()` combinator)

**Leaf callable (via `callable(writableInterpreter)`):**

- `scalarRef()` returns current value from store
- `scalarRef()` reflects mutations after `.set()`
- `textRef()` returns current string
- `textRef()` reflects mutations after `.insert()` / `.update()`
- `counterRef()` returns current number
- `counterRef()` reflects mutations after `.increment()`
- Template literal: `` `Stars: ${counterRef}` `` → `"Stars: 42"` (via `toPrimitive`, hint `"string"`)
- Template literal: `` `Title: ${textRef}` `` → `"Title: Hello"` (via `toPrimitive`, hint `"string"`)
- `counterRef[Symbol.toPrimitive]("number")` → `42` (hint-aware: returns number)
- `counterRef[Symbol.toPrimitive]("string")` → `"42"` (hint-aware: returns string)
- `counterRef[Symbol.toPrimitive]("default")` → `42` (hint-aware: default returns number)
- Mutation methods (`.set`, `.insert`, `.delete`, `.update`, `.increment`, `.decrement`) still work on the wrapped result
- `typeof scalarRef` → `"function"`

**Structural callable (via `callable(writableInterpreter)`):**

- `productRef()` returns deep plain snapshot
- `productRef()` snapshot reflects mutations
- `sequenceRef()` returns plain array
- `sequenceRef.at(0)` returns child ref (callable because children are also wrapped)
- `sequenceRef.at(0)` child ref is callable
- `sequenceRef.push(...)` still works, `sequenceRef()` reflects new items
- Map ref callable returns plain record
- Product ref property access still returns child refs (lazy getters copied onto function object)
- `Object.keys(productRef)` returns schema field names (enumerable properties on function)
- Product ref with field named `name`: lazy getter shadows `Function.prototype.name`, returns child ref
- Product ref with field named `length`: lazy getter shadows `Function.prototype.length`, returns child ref

**Composition with other combinators:**

- `enrich(callable(writableInterpreter), withChangefeed)` works — `[CHANGEFEED]` attaches to callable refs
- `hasChangefeed(callableRef)` → `true` after enrichment
- `callable(writableInterpreter)` without `enrich` works — callable refs without changefeed
- `enrich(writableInterpreter, withChangefeed)` without `callable` works — plain-object refs with changefeed (backward compat)

### Phase 3 tests (`.get()` removal, `.at(i)` rename)

- `writableInterpreter` alone produces refs without `.get()` — accessing `.get` is `undefined`
- `SequenceRef.at(0)` returns child ref (same as old `.get(0)`)
- `SequenceRef[Symbol.iterator]` and `.toArray()` use `.at(i)` internally

### Phase 4 tests (type-level)

- `Callable<ProductSchema<{ x: ScalarSchema<"number"> }>>` has call signature returning `{ x: number }`
- `Callable<SequenceSchema<ScalarSchema<"string">>>` has call signature returning `string[]`
- `Callable<AnnotatedSchema<"text">>` has call signature returning `string`
- `Callable<AnnotatedSchema<"counter">>` has call signature returning `number`
- `Callable<ScalarSchema<"number">>` has call signature returning `number`
- `Writable<ProductSchema<{ x: ScalarSchema<"number"> }>>` does NOT have call signature
- `Writable<ScalarSchema<"number">>` does NOT have call signature or `.get()`

## Transitive Effect Analysis

### `guards.ts` → `combinators.ts`, `with-changefeed.ts`; `changefeed.ts` → `hasChangefeed`

Only `enrich` and `withChangefeed` switch to `isPropertyHost`. All other consumers of `isNonNullObject` keep the existing guard. Additionally, `hasChangefeed` in `changefeed.ts` has its own inline `typeof value === "object"` check that must be widened to also accept `typeof value === "function"`. Risk: if a guard is missed, callable refs will be treated as primitives. Mitigation: Phase 2 tests verify `enrich` + `withChangefeed` + `hasChangefeed` work with callable refs.

### `combinators.ts` — new `callable()` combinator

The `callable()` combinator is added alongside `enrich`, `product`, and `overlay`. It is an interpreter-level combinator (Interpreter → Interpreter). It imports `readByPath` from `store.ts` and the `isPropertyHost` guard from Phase 1. The `enrich` combinator's `isNonNullObject` check (switched to `isPropertyHost` in Phase 1) must pass *before* `callable`'s wrapping, so `callable` should be the inner combinator in composition: `enrich(callable(base), withChangefeed)`.

### `writable.ts` ref interfaces → `types.test.ts`, `writable.test.ts`, `example/main.ts`

Removing `.get()` from interfaces is a breaking change to all consumer code. Scope: ~12 `.get()` call sites in `writable.test.ts`, ~16 in `example/main.ts`, 0 in `with-changefeed.test.ts`. Plus 1 `.get(0)` (sequence indexed access) in `writable.test.ts` and ~3 `doc.tasks.get(0)` in `example/main.ts`. All migrated in Phase 5.

### `writable.ts` ref interfaces → `Writable<S>` type → type-level tests

`Writable<S>` references `ScalarRef`, `TextRef`, `CounterRef`, `SequenceRef` by name. These become mutation-only interfaces (no `.get()`, no call signature). A new `Callable<S>` type adds call signatures for use with `callable(writableInterpreter)`.

### `callable()` combinator → `enrich` → `withChangefeed`

The `callable()` combinator produces function objects. `enrich`'s `isPropertyHost` check (Phase 1) accepts functions, so `Object.assign(fn, protocol)` works. `withChangefeed` uses `Object.defineProperty(result, CHANGEFEED, ...)` which works on functions. Composition: `enrich(callable(writableInterpreter), withChangefeed)`.

### `callable()` combinator → map Proxy wrapping

Maps are the one case where `callable` creates a Proxy-on-Proxy: the base result is already a Proxy; `callable` wraps it in an outer Proxy with a function target and an `apply` trap. All other traps forward to the inner Proxy via `Reflect`. When `enrich` then applies `withChangefeed`, the `defineProperty` call goes through the outer Proxy → `Reflect.defineProperty` → inner Proxy's `defineProperty` trap → target object. This works because the inner Proxy's trap already allows symbol-keyed definitions.

### `SequenceRef.get(i)` → `.at(i)` rename

The `.get(i)` method is used in `writable.test.ts` and `example/main.ts` for indexed access. It is also used internally by `SequenceRef[Symbol.iterator]` and `.toArray()`. All internal usages must be updated to `.at(i)` alongside the interface change.

### `example/main.ts` facade (`createDoc`, `change`, `subscribe`)

The example facade uses `doc.toJSON()` for snapshots. With callable refs, `doc()` becomes an alternative. The facade should switch to `callable(writableInterpreter)` (or `enrich(callable(writableInterpreter), withChangefeed)`) and demonstrate the callable pattern.

### No impact on: `schema.ts`, `loro-schema.ts`, `change.ts`, `step.ts`, `zero.ts`, `describe.ts`, `interpret.ts`, `store.ts`, `plain.ts`, `validate.ts`

These modules don't reference ref types or produce refs. They work with `Schema`, `Change`, `Path`, and plain values — all unchanged. (`changefeed.ts` does need the `hasChangefeed` guard fix, covered in Phase 1.)

### Downstream (out of scope, noted for follow-up)

- **Kinetic compiler** (`packages/kinetic/src/compiler/analyze.ts`): synthesizes `.get()` calls for bare refs in content position. Will need updating to synthesize `ref()` instead when schema refs migrate. Not blocking — Kinetic currently works against `@loro-extended/change` refs which retain `.get()`.
- **Kinetic runtime** (`packages/kinetic/src/runtime/regions.ts`): `ListRefLike<T>` interface uses `.get(i)`. This is a separate interface from `SequenceRef` and doesn't break, but should be renamed to `.at(i)` for consistency in a follow-up.
- **`@loro-extended/reactive`**: `isReactive` and `isSnapshotable` guards check `typeof value === "object"`. Only relevant if function-object refs ever gain `[REACTIVE]`/`[SNAPSHOT]` properties — not currently planned.

## Resources for Implementation Context

- `packages/schema/src/interpreters/writable.ts` — ref interfaces, ref factories, writable interpreter, `Plain<S>`, `Writable<S>` (primary target for Phase 3 interface changes)
- `packages/schema/src/combinators.ts` — `enrich`, `product`, `overlay` combinators; home for new `callable()` combinator (Phase 2)
- `packages/schema/src/guards.ts` — `isNonNullObject` (needs `isPropertyHost` addition)
- `packages/schema/src/interpreters/with-changefeed.ts` — `withChangefeed` decorator (must handle function results)
- `packages/schema/src/changefeed.ts` — `hasChangefeed` guard (needs `typeof === "function"` addition)
- `packages/schema/src/store.ts` — `readByPath` (used by `callable()` combinator for read operations)
- `packages/schema/src/__tests__/writable.test.ts` — ~12 `.get()` + ~1 `.get(i)` call sites to migrate
- `packages/schema/example/main.ts` — ~16 `.get()` + ~3 `.get(i)` call sites to migrate
- `packages/schema/src/__tests__/types.test.ts` — type-level tests (add `Callable<S>` tests)
- `packages/schema/TECHNICAL.md` — documentation target
- `packages/change/src/typed-refs/counter-ref.ts` — hint-aware `[Symbol.toPrimitive]` precedent to follow
- `packages/change/src/typed-refs/text-ref.ts` — `[Symbol.toPrimitive]` and `valueOf()` precedent (schema refs adopt toPrimitive but not valueOf)
- `packages/reactive/src/index.ts` — `REACTIVE`, `SNAPSHOT`, `Reactive<S,D>` interfaces (predecessor protocol, informs Changefeed design alignment)
- `packages/kinetic/src/runtime/regions.ts` — `listRegion`, `ListRefLike<T>` (downstream `.get(i)` → `.at(i)` rename, out of scope)
- `packages/kinetic/src/runtime/subscribe.ts` — `subscribeWithValue` (mount pattern: read current + subscribe for deltas)
- `packages/kinetic/src/compiler/analyze.ts` — synthesizes `.get()` for bare refs (downstream, out of scope)

## PR Stack

### PR 1: `(packages/schema) refactor: add isPropertyHost guard for function-object refs`

**Type:** Prep refactor

Adds `isPropertyHost` to `guards.ts` and switches `enrich` + `withChangefeed` to use it. Updates `hasChangefeed` in `changefeed.ts` to also accept functions. No behavior change yet — current refs are plain objects, so both guards return the same result. This is the foundation that enables function-object refs in the next PR.

**Commits:**
1. refactor: add `isPropertyHost` guard, switch `enrich`/`withChangefeed` to use it, widen `hasChangefeed` for functions

### PR 2: `(packages/schema) feat: callable() combinator for composable read surface`

**Type:** Feature

Adds the `callable()` interpreter combinator to `combinators.ts`. When composed as `callable(writableInterpreter, readFn)`, every ref becomes a callable function object with `[Symbol.toPrimitive]`. No breaking changes in this PR — `writableInterpreter` still has `.get()`, and `callable()` is additive.

> **Transition note:** During the window between PR 2 and PR 3, there are temporarily three ways to read a value: `.get()` (legacy), `ref()` (new callable), and `[CHANGEFEED].current` (reactive protocol). This is explicitly temporary. PR 2 tests should exercise only the `()` callable pattern and NOT test `.get()` alongside `()`, to avoid normalizing both as valid APIs.

**Commits:**
1. feat: `callable()` combinator — wraps interpreter results in function objects with read + toPrimitive

### PR 3: `(packages/schema) feat: drop .get(), rename .at(i), add Callable<S> type`

**Type:** Feature (breaking — pre-1.0)

`.get()` removed from all ref interfaces (mutation-only surface). `SequenceRef.get(i)` renamed to `.at(i)`. New `Callable<S>` type alias for use with `callable(writableInterpreter)`. All tests and example migrated.

**Commits:**
1. refactor: remove `.get()` from ref interfaces, rename `.get(i)` to `.at(i)`
2. feat: `Callable<S>` type and type-level tests
3. fix: migrate tests and example to `callable(writableInterpreter)`, `()`, and `.at(i)`
4. docs: update TECHNICAL.md for composable callable pattern

## Alternatives Considered

### Keep `.get()` and add `()` as sugar

Add the callable as an additional way to read, keeping `.get()` for backward compatibility. Rejected because:

- Two ways to do the same thing is worse than one
- This is a pre-1.0 spike — no backward compat obligation
- `.get()` on `SequenceRef` would remain ambiguous (no-arg read vs indexed navigation)

### Use `valueOf()` for implicit coercion

Make refs coerce to their values in all expression contexts (arithmetic, comparison, etc.) via `valueOf()`. Rejected because:

- `ref === 42` fails (object identity, not value comparison)
- `ref == 42` works but is a known JS footgun (`==` is discouraged)
- `typeof ref` returns `"function"`, not `"number"` — type confusion
- Developers would forget the `+` prefix to extract the number
- `toPrimitive` in backtick template literals has none of these problems

Note: `@loro-extended/change`'s `TextRef` and `CounterRef` do use `valueOf()`, but that's production code with a different trade-off profile. Schema refs choose to omit `valueOf()` — the callable `()` is the primary read, and `[Symbol.toPrimitive]` handles the template-literal case without the `valueOf` footguns.

### Fuse callable into `writableInterpreter` (no combinator)

Rewrite each case of `writableInterpreter` to directly produce function objects. Rejected because:

- Mixes read and write concerns in a single interpreter — the writable interpreter should own mutation only
- Not composable — a consumer who wants write-only refs (e.g. server-side batch operations) gets callable overhead whether they want it or not
- Doesn't follow the established pattern — `withChangefeed` adds observation composably via `enrich`; the read surface should be composable too
- The three concerns (mutation, reading, observation) are cleanly separable: `writableInterpreter` = mutation, `callable()` = reading, `enrich(..., withChangefeed)` = observation

### `withCallable(interpret(...))` post-hoc transform

Wrap the already-constructed tree of refs in callable function objects. Rejected because:

- Requires walking the schema a second time (the tree has already been interpreted)
- Product lazy getters are internal to the base interpreter's property descriptors — the wrapper would need to intercept them to wrap children, coupling itself to the base implementation
- Map refs are Proxies — wrapping after the fact means Proxy-on-Proxy with no way to inject the `apply` trap into the existing Proxy
- Breaks referential identity for children unless the wrapper adds its own caching layer, duplicating what the interpreter already does
- Feasible for leaf refs only, but architectural inconsistency (some nodes wrapped post-hoc, structural nodes wrapped differently) is worse than a uniform combinator

The `callable()` interpreter combinator avoids all of these problems by operating at the right level of abstraction — it wraps each node's result *as it's produced* during the single `interpret()` walk.

### Solid-style `[getter, setter]` tuple

Split read from write as `const [stars, setStars] = doc.stars`. Rejected because:

- Loses node identity — the getter is a bare function, not a ref with schema knowledge, changefeed, and mutation vocabulary
- Doesn't compose with the interpreter algebra — `interpret()` produces a tree of refs, not a tree of tuples
- The callable pattern preserves the node as the primary abstraction while making reads ergonomic

### Make `.current` the unified read (remove `.get()`, no callable)

Replace `.get()` with `.current` as a property getter. Rejected because:

- `.current` lives on the Changefeed protocol, not on the ref itself
- The Changefeed is a general protocol — non-schema reactive values implement it too
- Putting `.current` directly on refs would conflate the schema-specific ref with the general reactive protocol
- The callable `()` is syntactically lighter than `.current` and semantically distinct (deep snapshot vs shallow reactive read)

## Learnings

### `mapInterpreter` extraction opportunity (deferred)

Both `enrich` and `callable` are interpreter-wrapping combinators with the same 6-case structure: run the base at each node, transform the result. They differ only in the transform function. A generic `mapInterpreter(base, transform)` combinator could eliminate ~60 lines of duplicated boilerplate.

However, the child-thunk downcast handling (`() => B` → `() => A` before passing to the base) differs subtly between combinators. For `enrich`, `A & P` → `A` is a safe upcast. For `callable`, the relationship is different. Forcing them into a shared abstraction would require unsafe casts or complex type parameterization. **Decision:** note the duplication as known debt. If a third interpreter-wrapping combinator is added, extract `mapInterpreter` then. Two is coincidence; three is a pattern.

### Read vs. write concern separation

The writable interpreter historically mixed read (`.get()`) and write (`.set()`, `.insert()`, etc.) concerns. Through design discussion, we determined that the callable read surface should be a **composable combinator** rather than fused into the interpreter:

1. **`enrich` is the wrong tool** for this — it merges protocol *onto* an existing result via `Object.assign`. The callable pattern needs to create a *new function* and copy the result's properties *onto the function* (inverted merge direction).
2. **A post-hoc transform** (`withCallable(interpret(...))`) doesn't work because it would need to re-walk the schema, break lazy getter internals, and create Proxy-on-Proxy without access to the `apply` trap. It's feasible for leaves but architecturally inconsistent for structural nodes.
3. **An interpreter-level combinator** (`callable(base)`) works cleanly — it wraps each node's result as it's produced, during the single `interpret()` walk. It has access to `ctx`, `path`, and `schema` at each node, which is everything it needs for `readByPath`, `[Symbol.toPrimitive]` dispatch, and type-appropriate coercion.

The combinator has one known cost: maps become Proxy-on-Proxy (the base Proxy is wrapped by `callable`'s outer Proxy with an `apply` trap). This is localized to maps and acceptable — map access is already Proxy-mediated.

### Property descriptor copying

The `callable()` combinator copies properties from the base result onto a new function using `Object.getOwnPropertyDescriptors` + `Object.defineProperties`. This preserves:
- Lazy getter/setter definitions (product field caching)
- Non-enumerable symbol properties (e.g. `[CHANGEFEED]` if `enrich` runs first — though in practice `callable` is inner and `enrich` is outer)
- Enumerable string properties (methods on leaf refs)

This is more robust than `Object.assign` (which only copies enumerable own string-keyed properties) and correctly handles the `configurable: true` descriptors that enable `name`/`length` shadowing on function objects.

Note: `Object.getOwnPropertyDescriptors` already includes symbol-keyed properties — no separate `Object.getOwnPropertySymbols` loop is needed. A single `Object.defineProperties(fn, Object.getOwnPropertyDescriptors(source))` call handles everything.

### `callable()`'s read body is NOT `plainInterpreter`

At first glance, the callable's function body (`readByPath(ctx.store, path)` at every node) looks like it duplicates `plainInterpreter`. But `plainInterpreter` **eagerly** evaluates the entire tree (forces all product field thunks, iterates all sequence items) to produce a deep plain snapshot. The callable body just calls `readByPath` lazily — it reads the *raw store value* at that path, which happens to already be the plain representation because the store IS the plain representation. One `readByPath` call, not a recursive traversal. No duplication.

### Composition order

The intended composition is `enrich(callable(writableInterpreter), withChangefeed)`:
- **Inner:** `writableInterpreter` produces plain-object refs with mutation methods
- **Middle:** `callable()` wraps in function objects, adds call signature + `toPrimitive`
- **Outer:** `enrich` + `withChangefeed` attaches `[CHANGEFEED]` symbol property

This order matters because `enrich`'s `isPropertyHost` check must see a function (not a plain object), and `withChangefeed` attaches via `Object.defineProperty` which works on functions.

A consumer who wants write-only refs uses `writableInterpreter` directly. A consumer who wants callable read+write but no observation uses `callable(writableInterpreter)`. The full stack is `enrich(callable(writableInterpreter), withChangefeed)`.