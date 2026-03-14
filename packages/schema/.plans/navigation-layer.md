# Navigation Layer: Separating Navigation from Reading

## Background

The `@kyneta/schema` interpreter stack decomposes ref construction into composable transformer layers: `bottomInterpreter` → `withReadable` → `withCaching` → `withWritable` → `withChangefeed`. Each layer adds exactly one capability. However, two architectural conflations exist:

### Conflation 1: `withReadable` fuses navigation and reading

`withReadable` currently fuses **two** independent capabilities:

1. **Reading** — filling the `[READ]` slot so `ref()` returns a plain value, plus `[Symbol.toPrimitive]` for coercion
2. **Navigation** — structural addressing: product field getters, sequence `.at(i)` / `.length` / `[Symbol.iterator]`, map `.at(key)` / `.has()` / `.keys()` / `.size` / `.entries()` / `.values()` / `[Symbol.iterator]`

These are categorically distinct operations. Reading is an **algebra** (F-algebra, catamorphism): `F(A) → A` — collapsing structure into a value. Navigation is a **coalgebra**: `A → F(A)` — revealing addressable child positions within a composite. Navigation says "give me a handle to the child at position X"; reading says "give me the value at this location."

### Conflation 2: `READ` conflates call delegation with value reading

The `[READ]` symbol in `bottom.ts` serves as the carrier's call delegation slot — `carrier()` invokes `carrier[READ]()`. But `READ` is a misnomer: the slot controls what happens when you **call** the carrier, not what it means to read. Reading is what `withReadable` *puts into* that slot. The slot itself is simply "what does `carrier()` do?"

This conflation means `HasRead` — the base brand produced by `bottomInterpreter` — claims "this carrier can read" when it really means "this carrier is callable." A write-only carrier produced by `withWritable(bottomInterpreter)` satisfies `HasRead` even though calling it throws.

### Concrete problems caused by these conflations

#### 1. `SequenceRef` declares `.at()` (a navigation method) on a mutation-only interface

`SequenceRef` in `writable.ts` is documented as "mutation-only interface" but declares `.at()`, `.length`, and `[Symbol.iterator]` — all navigation concerns. At runtime, `withWritable` never attaches these; they come from `withReadable`. The type declaration is a category error.

#### 2. `Readable<S> & Writable<S>` intersection is unsound for collection children

Both `ReadableSequenceRef` and `SequenceRef` declare `at: (index: number) => T | undefined` with different `T` parameters. TypeScript resolves identically-signatured function properties in an intersection as overloads, picking the first match rather than intersecting return types. So `doc.messages.at(0)!.author` resolves as `Readable<AuthorSchema>` only — the `Writable` half is silently lost. This produces 6 type errors in `changefeed.test.ts` where `.set()` is called on sequence/map children.

#### 3. `[TRANSACT]` and `[CHANGEFEED]` are invisible to `Readable<S> & Writable<S>`

Neither `Readable<S>` nor `Writable<S>` includes the `HasTransact` or `HasChangefeed` interfaces. These symbols are attached at runtime via `Object.defineProperty` but have no type-level representation in the combined ref type. This produces 5 additional type errors in `changefeed.test.ts`. Additionally, `withChangefeed` requires `WritableContext` even though the `Changefeed` protocol (a Moore machine) only requires reading for `.current` — mutation is needed for transitions to fire, but a Moore machine with no transitions is still valid. This prevents read-only observation stacks.

#### 4. Write-only-with-navigation is impossible

A valid use case exists: navigate to a child ref and mutate it without needing to read values (event sourcing, command dispatch). Today this requires the full `withReadable` stack because navigation and reading are bundled. `withWritable(bottomInterpreter)` can `.push()` on a sequence but cannot `.at(0)` to reach a child — even though `.at()` is a structural operation that doesn't depend on reading.

#### 5. `as any` is pervasive in tests

Every test file except `changefeed.test.ts` and `facade.test.ts` casts `interpret()` results to `any`, hiding type errors. The `changefeed.test.ts` file is the only one that attempts proper typing via `Readable<S> & Writable<S>`, which exposed the unsoundness. The `as any` pattern means the type system provides zero safety for the most common operations: navigating to a child and mutating it.

## Problem Statement

`withReadable` conflates navigation (coalgebraic structural addressing) with reading (algebraic value observation). The `READ` symbol conflates call delegation with value reading, and `HasRead` conflates "is a carrier" with "can produce values." `withChangefeed` requires `WritableContext` despite only needing reading for its Moore machine `.current` output. Together, these prevent write-only navigation, force `SequenceRef` to redundantly declare navigation methods, make `Readable<S> & Writable<S>` unsound for collection children, leave `[TRANSACT]`/`[CHANGEFEED]` invisible to the type system, and prevent read-only observation stacks. Tests mask these issues with `as any`.

## Success Criteria

1. `READ` is renamed to `CALL`. The carrier delegation slot honestly describes what it is: the call behavior of the carrier.
2. `HasCall` replaces `HasRead` as the base brand produced by `bottomInterpreter`. It means "this is a callable carrier with a `[CALL]` slot."
3. `HasRead` becomes a phantom brand (no runtime symbol) meaning "the `[CALL]` slot has been filled with a reader." Produced by `withReadable`.
4. `withNavigation` is a standalone transformer: `Interpreter<RefContext, A extends HasCall> → Interpreter<RefContext, A & HasNavigation>`. It adds product field getters, sequence `.at()` / `.length` / `[Symbol.iterator]`, and map `.at()` / `.has()` / `.keys()` / `.size` / `.entries()` / `.values()` / `[Symbol.iterator]`.
5. `withReadable` requires `HasNavigation` as input. It fills `[CALL]`, adds `[Symbol.toPrimitive]`, and adds `.get()` on sequences/maps. It produces `A & HasRead`.
6. `withCaching` requires `HasNavigation` (not `HasRead`) — caching wraps `.at()` and adds `[INVALIDATE]`, neither of which requires reading.
6a. `withChangefeed` requires `HasRead` (not `WritableContext`) — `.current` is reading, but mutation is not required for a valid Moore machine. Accepts `RefContext`; degrades gracefully (static Moore machine) when `WritableContext` is absent.
7. `SequenceRef` contains only mutation methods: `.push()`, `.insert()`, `.delete()`. No `.at()`, `.length`, or `[Symbol.iterator]`.
8. A unified `Ref<S>` recursive conditional type exists that maps each schema node to its full surface (navigation + reading + writing). `.at()` on a `Ref<SequenceSchema<I>>` returns `Ref<I> | undefined` — child types propagate correctly.
9. `Ref<S>` includes `HasTransact` at every level where `withWritable` attaches it.
10. `bun tsc --noEmit` produces zero errors.
11. All existing runtime tests pass unchanged.
12. Test files that previously used `as any` for full-stack `interpret()` results use `Ref<S>` instead, with proper type checking on navigation, reading, and mutation.
13. The capability lattice compiles correctly: `withCaching(bottomInterpreter)` is a compile error. `withReadable(bottomInterpreter)` is a compile error. `withNavigation(bottomInterpreter)` compiles. `withReadable(withNavigation(bottomInterpreter))` compiles.
14. `withWritable(withNavigation(bottomInterpreter))` compiles and produces refs with navigation + mutation but no reading (`ref()` throws).
15. The `readable` layer in `layers.ts` composes `withCaching(withReadable(withNavigation(base)))`.

## The Gap

The current architecture has no `withNavigation` layer — navigation lives inside `withReadable`. The `READ` symbol conflates call delegation with value reading. `HasRead` is used for the carrier base when it should mean "can read." There is no `Ref<S>` unified type. `SequenceRef` over-declares navigation members. Tests use `as any` pervasively.

## Phase 1: Rename `READ` → `CALL` and split `HasRead` into `HasCall` + `HasRead` 🟢

### Task 1.1: Rename the runtime symbol 🟢

In `src/interpreters/bottom.ts`:

- Rename `export const READ` → `export const CALL` (keeping `Symbol.for("kyneta:call")` — or keep the same symbol string `"kyneta:read"` for zero runtime breakage and rename just the export binding; prefer renaming the string too since there are no prod consumers)
- Update `makeCarrier()` to use `CALL`:

```ts
export const CALL: unique symbol = Symbol.for("kyneta:call") as any

export function makeCarrier(): HasCall {
  const carrier: any = function (this: any, ...args: unknown[]): unknown {
    return carrier[CALL](...args)
  }
  carrier[CALL] = (): unknown => {
    throw new Error("No call behavior configured")
  }
  return carrier as HasCall
}
```

### Task 1.2: Split the capability interfaces 🟢

In `src/interpreters/bottom.ts`, replace the current `HasRead` / `HasNavigation` / `HasCaching` chain with:

```ts
// HasCall — base brand: "this is a callable carrier with a [CALL] slot"
export interface HasCall {
  readonly [CALL]: (...args: unknown[]) => unknown
}

// HasNavigation — structural addressing available
export interface HasNavigation extends HasCall {
  /** @internal phantom brand */
  readonly [NAVIGATION]: true
}

// HasRead — [CALL] has been filled with a reader
// Phantom brand only — no runtime symbol. The runtime slot is [CALL].
declare const READ_BRAND: unique symbol
export interface HasRead extends HasNavigation {
  /** @internal phantom brand */
  readonly [READ_BRAND]: true
}

// HasCaching — child caching + INVALIDATE
export interface HasCaching extends HasNavigation {
  readonly [INVALIDATE_SYMBOL]?: (change: ChangeBase) => void
  /** @internal phantom brand */
  readonly [CACHING]: true
}
```

Key changes from current:
- `HasCall` replaces old `HasRead` as the base. `bottomInterpreter` produces `HasCall`.
- `HasNavigation extends HasCall` (was `extends HasRead`). Same shape, new parent.
- `HasRead` is now a phantom brand extending `HasNavigation` — "the `[CALL]` slot has been filled with a reader." Produced by `withReadable`.
- `HasCaching extends HasNavigation` (was `extends HasNavigation` — unchanged). Caching does not require reading.

### Task 1.3: Update `bottomInterpreter` 🟢

Change its type from `Interpreter<unknown, HasRead>` to `Interpreter<unknown, HasCall>`.

### Task 1.4: Update all `READ` references across the codebase 🟢

Grep for `READ` (the symbol import/usage, not the word "read" in comments) across all files:

- `with-readable.ts` — `result[READ] = ...` → `result[CALL] = ...`
- `with-changefeed.ts` — import `CALL` instead of `READ`, `(result as any)[READ]()` → `(result as any)[CALL]()`
- `index.ts` — re-export `CALL` instead of `READ`
- `bottom.test.ts` — `READ` → `CALL` in imports, assertions, describe blocks
- `with-readable.test.ts` — `READ` → `CALL` in imports and assertions
- `writable.test.ts` — remove dead `READ` import (imported on line 11 but never used)

**Does NOT touch:** `writable.ts` (does not reference or re-export `READ` — verified by grep). `with-caching.ts` (does not reference `READ` — verified by grep).

Deprecate the `READ` export with a comment pointing to `CALL`, or remove outright (no prod consumers).

### Task 1.5: Tests for the rename 🟢

Update `src/__tests__/bottom.test.ts`:
- `CALL in carrier` is true
- `carrier[CALL]` is a function
- Default `carrier[CALL]()` throws
- Type-level: `bottomInterpreter` produces `Interpreter<unknown, HasCall>`
- Type-level: `HasCall` does NOT satisfy `HasNavigation` (negative test)
- Type-level: `HasNavigation extends HasCall` (positive test)

Update type-level tests in `with-caching.test.ts`:
- `withCaching(bottomInterpreter)` is a compile error (needs `HasNavigation`)
- `withCaching(withNavigation(bottomInterpreter))` compiles (once `withNavigation` exists — can defer to Phase 2 or use `withReadable` which still produces `HasNavigation`)

## Phase 2: Extract `withNavigation` from `withReadable` 🔴

### Task 2.0: Extract store-inspection helpers into `store.ts` 🔴

The navigation code in `with-readable.ts` repeats store-inspection patterns: `readByPath → Array.isArray → length` (sequences), `readByPath → isNonNullObject → Object.keys` (maps), and `readByPath → isNonNullObject → key in obj` (map key existence). These appear 4+ times in the map case alone.

Before extracting navigation into its own file, extract these into pure helpers in `store.ts` (alongside the existing `readByPath`):

```ts
export function storeArrayLength(store: Store, path: Path): number
export function storeKeys(store: Store, path: Path): string[]
export function storeHasKey(store: Store, path: Path, key: string): boolean
```

These are structural inspection — "what does the store look like at this position?" — not value reading. They're independently useful: `withWritable`'s `.push()` already does the `readByPath → Array.isArray → arr.length` pattern and could use `storeArrayLength` instead.

Pushing imperative store access into the store module makes `withNavigation` more declarative and aligns with the project's FC/IS principle.

### Task 2.1: Create `src/interpreters/with-navigation.ts` 🔴

Extract navigation logic from `with-readable.ts` into a new `withNavigation` transformer. Use the `storeArrayLength`, `storeKeys`, `storeHasKey` helpers from Task 2.0 instead of inline `readByPath` + type-checking patterns.

**Moves to `withNavigation`:**
- Product: enumerable lazy getters (`Object.defineProperty(result, key, { get() { return thunk() } })`)
- Sequence: `.at(i)` (using `storeArrayLength` for bounds check), `.length`, `[Symbol.iterator]`
- Map: `.at(key)` (using `storeHasKey`), `.has(key)`, `.keys()` (using `storeKeys`), `.size`, `.entries()`, `.values()`, `[Symbol.iterator]`
- Sum: `dispatchSum(readByPath(...), ...)` — variant resolution reads the store discriminant to select a child position, which is structural addressing
- Annotated `"doc"` / `"movable"` / `"tree"` — delegation to inner (structural pass-through)

**Stays in `withReadable`:**
- Scalar: `result[CALL] = () => readByPath(...)`, `result[Symbol.toPrimitive]`
- Product: `result[CALL] = () => { fold children through getters }`
- Sequence: `result[CALL] = () => { fold children into array snapshot }`, `.get(i)`
- Map: `result[CALL] = () => { fold children into record snapshot }`, `.get(key)`
- Annotated text: `result[CALL]`, `toPrimitive`
- Annotated counter: `result[CALL]`, `toPrimitive`

Signature:

```ts
export function withNavigation<A extends HasCall>(
  base: Interpreter<RefContext, A>,
): Interpreter<RefContext, A & HasNavigation>
```

**Note on store access in navigation:** `.at(i)` checks bounds via `readByPath(ctx.store, path)` to determine array length. `.at(key)` checks key existence similarly. This is **structural inspection** — "does this position exist?" — not value reading. The `RefContext` (which has `.store`) is sufficient. This does not create a dependency on `withReadable`.

### Task 2.2: Slim `withReadable` to reading-only concerns 🔴

Change `withReadable`'s input constraint from `A extends HasCall` to `A extends HasNavigation`. Remove all navigation logic (field getters, `.at()`, `.has()`, `.keys()`, etc.). What remains:

- Scalar: fill `[CALL]`, add `[Symbol.toPrimitive]`
- Product: fill `[CALL]` (fold through existing navigation getters)
- Sequence: fill `[CALL]` (fold through `item(i)` closure), add `.get(i)` (convenience: `.at(i)?.()`)
- Map: fill `[CALL]` (fold through `item(key)` closure), add `.get(key)` (convenience: `.at(key)?.()`)
- Annotated text/counter: fill `[CALL]`, add `toPrimitive`
- Sum: pass-through (dispatch already handled by `withNavigation`)

New signature:

```ts
export function withReadable<A extends HasNavigation>(
  base: Interpreter<RefContext, A>,
): Interpreter<RefContext, A & HasRead>
```

`withReadable` now produces `HasRead` — a phantom brand that says "the `[CALL]` slot has been filled with a reader." This is the compile-time guarantee that `ref()` returns a meaningful value.

Composition check: `withCaching` requires `HasNavigation`. `withReadable` produces `A & HasRead`, and `HasRead extends HasNavigation`, so `withCaching(withReadable(withNavigation(bottom)))` typechecks. ✓ And `withCaching(withNavigation(bottom))` also typechecks (caching without reading). ✓

### Task 2.2a: Fix `text.update()` to use store inspection instead of carrier call 🔴

`withWritable`'s text `.update()` method currently calls `result()` to read the current text length:

```ts
result.update = (content: string): void => {
  const current: string = result()
  // ... uses current.length to build delete op
}
```

This routes through the carrier's `[CALL]` slot, which only works when `withReadable` has filled it. Every other mutation method in `withWritable` reads from the store directly via `readByPath(ctx.store, path)` — `.push()`, `.insert()`, `.delete()`, `.clear()` all follow this pattern. `.update()` is the sole exception.

In a navigate+write-without-read stack (`withWritable(withNavigation(bottomInterpreter))`), `.push()` works but `.update()` throws. This is inconsistent.

**Fix:** Replace the carrier call with direct store inspection:

```ts
result.update = (content: string): void => {
  const current = readByPath(ctx.store, path)
  const currentLength = typeof current === "string" ? current.length : 0
  ctx.dispatch(
    path,
    textChange([
      ...(currentLength > 0 ? [{ delete: currentLength }] : []),
      { insert: content },
    ]),
  )
}
```

This is a one-line behavioral change with zero impact on existing tests — the store always has the same value that `result()` would return. The fix makes `withWritable` internally consistent: all mutation methods use store inspection, none depend on the carrier's call behavior.

### Task 2.2b: Widen `withChangefeed` from `WritableContext` to `RefContext`, require `HasRead` 🔴

`withChangefeed` currently requires `WritableContext`:

```ts
export function withChangefeed<A>(
  base: Interpreter<WritableContext, A>,
): Interpreter<WritableContext, A>
```

This is too narrow. The `Changefeed` protocol defines a Moore machine: `.current` (output function) + `.subscribe` (transition observer). A Moore machine with no transitions is still a valid Moore machine — it's a constant. `staticChangefeed` already embodies this: `.current` returns the value, `.subscribe` returns a no-op unsubscribe. The `kyneta/core` web framework depends on Moore machine semantics — without `.current`, there's nothing to render on first load. But `.subscribe` firing is not required: a read-only data source that never changes is a valid reactive source.

Therefore `withChangefeed` should accept `RefContext` (read-only) and degrade gracefully when `WritableContext` is not present. The `withCaching` layer already demonstrates this pattern with `hasPrepare()` duck-typing.

**Changes:**

1. **Signature**: `<A extends HasRead>(base: Interpreter<RefContext, A>) → Interpreter<RefContext, A>`. Requires `HasRead` because `.current` is a read operation — the carrier's `[CALL]` slot must be filled. Accepts `RefContext` because mutation infrastructure is optional.

2. **`ensurePrepareWiring` graceful degradation**: Duck-type for `prepare`/`flush` on `ctx` (same pattern as `withCaching`'s `hasPrepare`). If present, wire the notification pipeline. If absent, return a null/empty listener map — `.subscribe` callbacks are registered but never fire. Valid static Moore machine.

3. **Leaf `.current` routing**: Change `createLeafChangefeed` calls from `() => readByPath(ctx.store, path)` to `() => (result as any)[CALL]()`. This routes through the carrier's call slot, consistent with composite `.current` (which already does `(result as any)[READ]()`). If `HasRead` is not satisfied, both leaf and composite `.current` throw with the same carrier error — no silent store bypass.

4. **`layers.ts` `changefeed` layer**: Change from `InterpreterLayer<WritableContext, WritableContext>` to `InterpreterLayer<RefContext, RefContext>`. The layer no longer forces context widening — it works on whatever context it receives. Read-only stacks get static Moore machines. Read-write stacks get full reactive changefeeds.

**Why `HasRead` and not `HasNavigation`:** `.current` calls the carrier. The carrier's `[CALL]` slot is filled by `withReadable`, which produces `HasRead`. Navigation alone (`HasNavigation`) provides structural addressing but doesn't fill `[CALL]` — calling the carrier would throw. A changefeed that throws on `.current` is not a valid Moore machine.

**Impact on existing code:** Zero behavioral change for the standard full stack (`withChangefeed(withWritable(withCaching(withReadable(withNavigation(bottom)))))`). The `WritableContext` is a subtype of `RefContext`, so all existing call sites compile. The `HasRead` bound is satisfied because `withReadable` is always present in existing compositions. The only new capability is that `withChangefeed` can now be composed on read-only stacks.

### Task 2.3: Update `layers.ts` 🔴

The `readable` layer currently composes `withCaching(withReadable(base))`. Update to `withCaching(withReadable(withNavigation(base)))`. Export a new `navigation` layer for standalone use. Update `changefeed` layer from `InterpreterLayer<WritableContext, WritableContext>` to `InterpreterLayer<RefContext, RefContext>` (Task 2.2b).

```ts
export const navigation: InterpreterLayer<RefContext, RefContext> = {
  name: "navigation",
  transform(base) { return withNavigation(base) },
}

export const readable: InterpreterLayer<RefContext, RefContext> = {
  name: "readable",
  transform(base) { return withCaching(withReadable(withNavigation(base))) },
}

export const changefeed: InterpreterLayer<RefContext, RefContext> = {
  name: "changefeed",
  transform(base) { return withChangefeed(base) },
}
```

### Task 2.4: Update `index.ts` barrel exports 🔴

Export `withNavigation` and the `navigation` layer. Export `NavigableSequenceRef` and `NavigableMapRef` type interfaces (introduced in Phase 3). Export `CALL` and `HasCall`.

### Task 2.5: Tests for `withNavigation` 🔴

Create `src/__tests__/with-navigation.test.ts`:

- Product field getters work on `withNavigation(bottomInterpreter)` — returns child carriers
- Sequence `.at(i)` returns child carrier, `.length` reflects store, `[Symbol.iterator]` yields children
- Map `.at(key)` returns child carrier, `.has()`, `.keys()`, `.size`, `.entries()`, `.values()`, `[Symbol.iterator]`
- Bounds checking: `.at(-1)` and `.at(outOfBounds)` return `undefined`
- Map `.at(missingKey)` returns `undefined`
- Compile-time: `withNavigation(bottomInterpreter)` compiles; output satisfies `HasNavigation`
- Compile-time: `withReadable(bottomInterpreter)` is a compile error (requires `HasNavigation`)
- Integration: `withWritable(withNavigation(bottomInterpreter))` produces navigate+write refs where `.at(0)` works but `ref()` throws
- Integration: text `.update()` works on navigate+write stack (no reading layer) after Task 2.2a fix
- Integration: `withChangefeed(withCaching(withReadable(withNavigation(bottom))))` (read-only) produces valid Moore machines — `.current` returns values, `.subscribe` returns no-op unsubscribe
- Sum dispatch: discriminated union dispatches to correct variant
- Annotated `"doc"` / `"movable"` / `"tree"` delegates to inner

Update `src/__tests__/with-readable.test.ts`:

- Verify `withReadable` requires `HasNavigation` input (compile error test: `withReadable(bottomInterpreter)` fails)
- Verify reading still works when composed: `withReadable(withNavigation(bottom))`
- Verify `.get()` on sequence and map works
- Verify `[Symbol.toPrimitive]` works

### Task 2.6: Update existing tests for new composition 🔴

Any test that calls `withReadable(bottomInterpreter)` directly must change to `withReadable(withNavigation(bottomInterpreter))`. Grep for `withReadable(bottom` to find all call sites. Also grep for `READ` imports and update to `CALL`.

## Phase 3: Introduce `Ref<S>` unified type and slim `SequenceRef` 🔴

### Task 3.1: Create navigation-only type interfaces 🔴

In a new file `src/interpreters/navigable.ts`, define:

```ts
export interface NavigableSequenceRef<T = unknown> {
  at: (index: number) => T | undefined
  readonly length: number
  [Symbol.iterator](): Iterator<T>
}

export interface NavigableMapRef<T = unknown> {
  at(key: string): T | undefined
  has(key: string): boolean
  keys(): string[]
  readonly size: number
  entries(): IterableIterator<[string, T]>
  values(): IterableIterator<T>
  [Symbol.iterator](): IterableIterator<[string, T]>
}
```

`ReadableSequenceRef` and `ReadableMapRef` in `readable.ts` extend these with call signatures and `.get()`:

```ts
export interface ReadableSequenceRef<T = unknown, V = unknown>
  extends NavigableSequenceRef<T> {
  (): V[]
  get: (index: number) => V | undefined
}

export interface ReadableMapRef<T = unknown, V = unknown>
  extends NavigableMapRef<T> {
  (): Record<string, V>
  get(key: string): V | undefined
}
```

### Task 3.2: Slim `SequenceRef` to mutation-only 🔴

Remove `.at()`, `.length`, and `[Symbol.iterator]` from `SequenceRef`:

```ts
export interface SequenceRef {
  push: (...items: unknown[]) => void
  insert: (index: number, ...items: unknown[]) => void
  delete: (index: number, count?: number) => void
}
```

No type parameter needed — there are no child ref types in mutation-only operations (push/insert take plain values).

**Cascade check:** The `<T>` type parameter removal breaks any code referencing `SequenceRef<SomeType>`. Known consumers:
- `Writable<SequenceSchema<I>>` currently returns `SequenceRef<Writable<I>>` — must change to `SequenceRef` (Task 3.4)
- `types.test.ts` imports `SequenceRef` and may have `expectTypeOf` assertions on `SequenceRef<T>` — audit and update in Task 3.5

### Task 3.3: Define `Ref<S>` unified recursive type 🔴

`Ref<S>` is a single recursive conditional type that produces the full ref surface at every node. It unifies navigation, reading, writing, and `HasTransact` in one traversal so `.at()` returns `Ref<ChildSchema>`.

Use a `WithTransact<T>` helper to reduce `& HasTransact` noise across every branch:

```ts
type WithTransact<T> = T & HasTransact

type Ref<S extends Schema> =
  S extends AnnotatedSchema<infer Tag, infer Inner>
    ? Tag extends "text"
      ? WithTransact<(() => string) & { [Symbol.toPrimitive](hint: string): string }
        & TextRef>
      : Tag extends "counter"
        ? WithTransact<(() => number) & { [Symbol.toPrimitive](hint: string): number | string }
          & CounterRef>
        : Tag extends "doc"
          ? Inner extends ProductSchema<infer F>
            ? WithTransact<(() => { [K in keyof F]: Plain<F[K]> })
              & { readonly [K in keyof F]: Ref<F[K]> }
              & ProductRef<{ [K in keyof F]: Plain<F[K]> }>>
            : unknown
          : Tag extends "movable"
            ? Inner extends SequenceSchema<infer I>
              ? WithTransact<ReadableSequenceRef<Ref<I>, Plain<I>>
                & SequenceRef>
              : unknown
            : Tag extends "tree"
              ? Inner extends Schema ? Ref<Inner> : unknown
              : Inner extends Schema ? Ref<Inner> : unknown
    : S extends ScalarSchema<infer _K, infer V>
      ? WithTransact<(() => V) & { [Symbol.toPrimitive](hint: string): V | string }
        & ScalarRef<V>>
      : S extends ProductSchema<infer F>
        ? WithTransact<(() => { [K in keyof F]: Plain<F[K]> })
          & { readonly [K in keyof F]: Ref<F[K]> }
          & ProductRef<{ [K in keyof F]: Plain<F[K]> }>>
        : S extends SequenceSchema<infer I>
          ? WithTransact<ReadableSequenceRef<Ref<I>, Plain<I>>
            & SequenceRef>
          : S extends MapSchema<infer I>
            ? WithTransact<ReadableMapRef<Ref<I>, Plain<I>>
              & WritableMapRef<Plain<I>>>
            : unknown
```

Key properties:
- `WithTransact<T>` helper provides a single edit point if more cross-cutting concerns (e.g. `HasChangefeed`) are woven in later
- Children are `Ref<Child>`, not `Readable<Child>` or `Writable<Child>` — no intersection needed
- `HasTransact` is included at every level (matches runtime `attachTransact` behavior)
- `ReadableSequenceRef<Ref<I>, Plain<I>>` brings navigation (`.at()` returning `Ref<I>`) and reading (`()`, `.get()`) in one type
- `SequenceRef` brings only mutation (`.push()`, `.insert()`, `.delete()`)
- No `.at()` on `SequenceRef` — no overload conflict

**Implementation-time optimization:** The intersection `Readable<S> & Writable<S>` is sound at leaf nodes (scalar, text, counter) and product fields — there are no overlapping `.at()` declarations at these levels. `Ref<S>` could reuse `Readable<S> & Writable<S>` at those safe branches to reduce duplication between three nearly-isomorphic recursive types. The unsoundness only occurs at sequences and maps (where `.at()` child types diverge). Start with the standalone definition above for clarity; refactor leaf/product branches to reuse `Readable<S> & Writable<S>` if the duplication feels burdensome during implementation.

### Task 3.4: Update `Writable<S>` to use slimmed `SequenceRef` 🔴

`Writable<SequenceSchema<I>>` becomes `SequenceRef` (no type parameter). `Writable<MapSchema<I>>` stays `WritableMapRef<Plain<I>>`. `Writable<ProductSchema<F>>` drops `.at()` references if any leaked.

### Task 3.5: Type-level tests for `Ref<S>` 🔴

In `src/__tests__/types.test.ts` (or a new file):

- `Ref<ScalarSchema<"string", string>>` has `.set()` and `()` call signature
- `Ref<SequenceSchema<ScalarSchema<"string", string>>>` — `.at(0)` returns a ref with `.set()` AND `()` call signature
- `Ref<MapSchema<ScalarSchema<"number", number>>>` — `.at("key")` returns a ref with `.set()` AND `()` call signature
- `Ref<ProductSchema<{ x: ScalarSchema<"number", number> }>>` — `.x` has `.set()` AND `()` call signature
- `Ref<AnnotatedSchema<"doc", ProductSchema<{ title: AnnotatedSchema<"text", undefined> }>>>` — `.title` has `.insert()` AND `()` call signature
- `Ref<S>` at all levels has `[TRANSACT]`
- Audit existing `SequenceRef<T>` references in `types.test.ts` — update any `expectTypeOf` assertions that reference the removed type parameter

## Phase 4: Migrate tests from `as any` to `Ref<S>` 🔴

### Task 4.1: Migrate `writable.test.ts` 🔴

Replace `as any` casts on full-stack `interpret()` results with `as Ref<typeof schema>`. This is the largest file (~26 `as any` casts on interpret results). Some `as any` casts are intentional (testing edge cases, write-only stacks, raw carriers) — those stay. Only full-stack results (where `fullInterpreter` or `writableInterpreter` is the composed stack) migrate.

### Task 4.2: Migrate `changefeed.test.ts` 🔴

Replace `as unknown as Readable<S> & Writable<S>` with `as Ref<typeof schema>` (or just `Ref<typeof chatDocSchema>`). The 11 existing type errors should resolve. For tests that access `[TRANSACT]`, `Ref<S>` includes `HasTransact`.

For tests that access `[CHANGEFEED]` (via `getChangefeed` helper), those use `(obj as any)[CF_SYM]` which already bypasses the type system. No change needed for the changefeed symbol access pattern itself.

### Task 4.3: Migrate `facade.test.ts` 🔴

Replace `as unknown as Readable<S> & Writable<S>` with `as Ref<typeof schema>`.

### Task 4.4: Migrate `transaction.test.ts` 🔴

Replace the one `as unknown as Readable<S> & Writable<S>` cast with `Ref<S>`.

### Task 4.5: Migrate `readable.test.ts` 🔴

These tests use `withCaching(withReadable(bottomInterpreter))` (no writable layer). They should use `Readable<S>` (unchanged). Update composition to `withCaching(withReadable(withNavigation(bottomInterpreter)))`.

### Task 4.6: Migrate `with-caching.test.ts` and `with-readable.test.ts` 🔴

Update composition patterns. These tests operate at individual layer level and may legitimately use `as any` for testing internal behavior. Only migrate where the full composed stack is used.

### Task 4.7: Migrate `fluent.test.ts` 🔴

Update the fluent API tests to use `Ref<S>` where the full `.with(readable).with(writable)` stack is used.

### Task 4.8: Migrate `example/main.ts` 🔴

Replace `as any` with `as Ref<typeof ProjectSchema>`.

### Task 4.9: Verify zero `tsc` errors 🔴

Run `bun tsc --noEmit` and confirm zero errors across the entire project.

## Phase 5: Documentation 🔴

### Task 5.1: Update `TECHNICAL.md` 🔴

- **Symbol-keyed composability hooks table**: `READ` → `CALL`. Update the description from "Controls what `carrier()` does" to reflect the rename.
- **Capability lattice section**: replace the linear `HasRead → HasNavigation → HasCaching` chain with the new diamond:
  ```
  HasCall (bottom — callable carrier with [CALL] slot)
    ↓
  HasNavigation (withNavigation — field getters, .at(), .keys())
    ↙         ↘
  HasRead        HasCaching
  (withReadable — fills [CALL],    (withCaching — memoization,
   toPrimitive, .get())             INVALIDATE)
  ```
- **Combinatorial stacks table**: update to show 5 layers. Add new rows:
  - `withNavigation(bottom)` — navigate only
  - `withWritable(withNavigation(bottom))` — navigate + write (no read)
  - `withCaching(withNavigation(bottom))` — navigate + cache (no read)
- **`withReadable` section**: update to reflect that it only fills `[CALL]` and adds `.get()` / `toPrimitive`. Remove navigation descriptions.
- **New `withNavigation` section**: describe the coalgebraic structural addressing layer, what it adds, and why it's independent from reading.
- **Type-level interpretation section**: add `Ref<S>` as the primary user-facing type. `Readable<S>` and `Writable<S>` remain for partial-stack scenarios. Replace the "consumer code that composes both uses `Readable<S> & Writable<S>`" guidance with `Ref<S>`.
- **File map**: add `with-navigation.ts`, `navigable.ts`, `with-navigation.test.ts`.
- **Verified properties**: add properties for navigation-without-reading, `Ref<S>` type correctness, and `CALL` rename.

### Task 5.2: Update plan status 🔴

Mark `interpreter-decomposition.md` notes as superseded where applicable (its lattice diagram is now outdated).

## Unit and Integration Tests

**New test file: `with-navigation.test.ts`** — Tests the `withNavigation` layer in isolation:
- Navigation on `withNavigation(bottomInterpreter)` without any reading layer
- Product field getters return carriers (callable, but `ref()` throws)
- Sequence `.at(i)` returns carriers, bounds checking
- Map `.at(key)` returns carriers, `.has()`, `.keys()`, `.size`
- `withNavigation(bottomInterpreter)` satisfies `Interpreter<RefContext, HasCall & HasNavigation>` (type-level)
- `withReadable(bottomInterpreter)` is a compile error (type-level)
- `withWritable(withNavigation(bottomInterpreter))` produces navigate+write refs (integration)
- Sum dispatch works at navigation level

**Updated test file: `bottom.test.ts`** — Tests for the `READ` → `CALL` rename:
- `CALL in carrier` is true
- `carrier[CALL]` is a function
- Default `carrier[CALL]()` throws "No call behavior configured"
- Type-level: `bottomInterpreter` produces `Interpreter<unknown, HasCall>`
- Type-level: `HasCall` does NOT satisfy `HasNavigation`

**Updated test file: `with-readable.test.ts`** — Verify reading-only concerns:
- Composition now requires `withNavigation` first
- `.get()` convenience methods work
- `[CALL]` slot is filled, `ref()` returns values
- `[Symbol.toPrimitive]` works
- Type-level: `withReadable` output satisfies `HasRead`

**Updated test file: `types.test.ts`** — Type-level assertions for `Ref<S>`:
- `Ref<S>` at every schema kind has navigation, reading, writing, and `HasTransact`
- `Ref<SequenceSchema<I>>.at(0)` return type includes `.set()` (the core regression that started this)
- `Ref<MapSchema<I>>.at("key")` return type includes `.set()`

**All existing test files** — Must continue to pass at runtime. `as any` → `Ref<S>` migration must not change test logic.

## Transitive Effect Analysis

### Direct dependencies on `READ` symbol

| Consumer | Current usage | Impact |
|---|---|---|
| `bottom.ts` | Defines `READ`, uses in `makeCarrier` | Rename to `CALL` |
| `with-readable.ts` | `result[READ] = ...` | Update to `result[CALL] = ...` |
| `with-changefeed.ts` | `(result as any)[READ]()` (3 sites) | Update to `(result as any)[CALL]()` |
| `index.ts` | Re-exports `READ` | Re-export `CALL` |
| `bottom.test.ts` | `READ in carrier`, `carrier[READ]` | Update to `CALL` |
| `with-readable.test.ts` | Imports `READ` | Update to `CALL` |
| `writable.test.ts` | Imports `READ` (dead import — never used) | Remove import entirely |

**Verified no impact:** `writable.ts` (does not reference or re-export `READ`). `with-caching.ts` (does not reference `READ`).

### Direct dependencies on `HasRead` (old meaning: "is a carrier")

| Consumer | Current usage | Impact |
|---|---|---|
| `bottom.ts` | `bottomInterpreter: Interpreter<unknown, HasRead>` | Changes to `HasCall` |
| `with-readable.ts` | `A extends HasRead` | Changes to `A extends HasNavigation` |
| `with-caching.ts` | `A extends HasNavigation` (where `HasNavigation extends HasRead`) | `HasNavigation` now extends `HasCall` — check all constraint chains |
| All type-level tests referencing `HasRead` | Compile-time assertions | Update to `HasCall` where testing carrier base; new `HasRead` tests for readable output |

### Direct dependencies on `withReadable`

| Consumer | Current usage | Impact |
|---|---|---|
| `with-readable.ts` | Defines `withReadable` | Split into `with-navigation.ts` + slimmed `with-readable.ts` |
| `with-caching.ts` | `A extends HasNavigation` | No change — `withNavigation` produces `HasNavigation` |
| `writable.ts` | `withWritable` has no bound on `A`; text `.update()` calls `result()` (hidden carrier call dependency) | Fix `.update()` to use `readByPath(ctx.store, path)` (Task 2.2a) |
| `with-changefeed.ts` | Requires `WritableContext`; leaf `.current` bypasses carrier via `readByPath`; composite `.current` uses `(result as any)[READ]()` | Widen to `RefContext` with `HasRead` bound; unify all `.current` through carrier; graceful degradation when no `prepare`/`flush` (Task 2.2b) |
| `layers.ts` | `readable` layer composes `withCaching(withReadable(base))`; `changefeed` layer requires `WritableContext` | Update readable to `withCaching(withReadable(withNavigation(base)))`; update changefeed to `InterpreterLayer<RefContext, RefContext>` |
| `index.ts` | Re-exports `withReadable` | Add `withNavigation` export |
| All test files using `withReadable(bottomInterpreter)` | Direct composition | Must insert `withNavigation` |

### Transitive: `SequenceRef` consumers

| Consumer | Current usage | Impact |
|---|---|---|
| `writable.ts` `Writable<S>` type | `SequenceRef<Writable<I>>` | Changes to `SequenceRef` (no type param) |
| `changefeed.test.ts` | Uses `Readable<S> & Writable<S>` | Migrates to `Ref<S>` — fixes all 11 type errors |
| `writable.test.ts` | Uses `as any` | Migrates to `Ref<S>` — gains type safety |
| `facade.test.ts` | Uses `Readable<S> & Writable<S>` | Migrates to `Ref<S>` |

### Transitive: `ReadableSequenceRef` / `ReadableMapRef` consumers

| Consumer | Current usage | Impact |
|---|---|---|
| `readable.ts` | Defines the interfaces | Refactored to extend `NavigableSequenceRef` / `NavigableMapRef` |
| `Readable<S>` type | Uses `ReadableSequenceRef<Readable<I>, Plain<I>>` | Unchanged — still valid |
| `Ref<S>` type (new) | Uses `ReadableSequenceRef<Ref<I>, Plain<I>>` | New consumer, correct by construction |
| `with-changefeed.ts` | References `ReadableSequenceRef` in runtime type checks | Check if any `instanceof` or structural checks need updating — likely none since it uses duck typing |
| `packages/core/.../schema-ssr.test.ts` | Imports `ReadableSequenceRef` from `@kyneta/schema` | Backward-compatible — `ReadableSequenceRef` now extends `NavigableSequenceRef`, which is an extension (adds a supertype), not a breaking reshape. No changes needed in core, but noted for awareness. |

### Transitive: `HasNavigation` brand

| Consumer | Current usage | Impact |
|---|---|---|
| `bottom.ts` | Defines `HasNavigation` | `extends HasCall` (was `extends HasRead`) |
| `with-caching.ts` | Requires `HasNavigation` input | No change — still satisfied |
| `with-readable.ts` | Produces `HasNavigation` output | Now requires `HasNavigation` input instead of producing it; produces `HasRead` |
| `with-navigation.ts` (new) | Produces `HasNavigation` output | New producer |

### Transitive: `example/main.ts`

Uses `as any`. Migrates to `Ref<typeof ProjectSchema>`. The fluent builder `.with(readable).with(writable).with(changefeed).done()` returns `unknown` — the cast to `Ref<S>` is still needed but is now type-safe.

### No impact

- `schema.ts`, `change.ts`, `changefeed.ts` (protocol definition, not `withChangefeed`), `step.ts`, `zero.ts`, `describe.ts`, `guards.ts`, `interpreter-types.ts`, `validate.ts`, `plain.ts`, `combinators.ts`, `facade.ts` — no dependency on `withReadable` internals, `SequenceRef.at`, or the `READ` symbol.
- `store.ts` gains new helpers (`storeArrayLength`, `storeKeys`, `storeHasKey`) but has no existing dependencies that change.

## Resources for Implementation Context

These files should be in context during implementation:

| File | Why |
|---|---|
| `src/interpreters/bottom.ts` | `READ` → `CALL` rename, `HasRead` → `HasCall` split, `makeCarrier` |
| `src/interpreters/with-readable.ts` | Source of extraction — navigation code moves out, `READ` → `CALL` |
| `src/interpreters/writable.ts` | `SequenceRef`, `WritableMapRef`, `Writable<S>`, `TRANSACT`, `HasTransact`, re-exports `READ` |
| `src/interpreters/readable.ts` | `Readable<S>`, `ReadableSequenceRef`, `ReadableMapRef` |
| `src/interpreters/with-caching.ts` | Requires `HasNavigation`, wraps `.at()`, may reference `READ` |
| `src/interpreter-types.ts` | `RefContext`, `Plain<S>` |
| `src/layers.ts` | `readable`, `writable`, `changefeed` layers |
| `src/index.ts` | Barrel exports |
| `src/store.ts` | `readByPath`, `dispatchSum` — used by both navigation and reading |
| `src/__tests__/changefeed.test.ts` | The 11 type errors that motivated this work |
| `src/__tests__/bottom.test.ts` | `READ` → `CALL` rename in tests |
| `src/__tests__/writable.test.ts` | Largest `as any` migration target |
| `src/__tests__/with-readable.test.ts` | Must update composition to include `withNavigation` |
| `src/__tests__/with-caching.test.ts` | Must verify unchanged behavior, update `READ` refs |
| `src/__tests__/types.test.ts` | Type-level test target for `Ref<S>` |
| `TECHNICAL.md` | Architecture documentation to update |

## Alternatives Considered

### Alternative 1: Fix `Readable<S> & Writable<S>` directly without `withNavigation` or `CALL` rename

Remove `.at()` from `SequenceRef` and introduce `Ref<S>` without a navigation layer or symbol rename. This fixes the type errors but leaves navigation conflated with reading at the runtime level, and `READ` continues to misleadingly name a call delegation slot. The type fix would be a patch over two conceptual conflations.

**Rejected** because the type unsoundness is a symptom of the deeper architectural issues, and addressing only the symptom leaves the incorrect decomposition and misleading naming in place.

### Alternative 2: Parametric `Readable<S, ChildType>` / `Writable<S, ChildType>`

Make `Readable` and `Writable` accept a second type parameter controlling the child ref type. Then `Readable<S, Ref<ChildSchema>>` would have `.at()` returning `Ref<ChildSchema>`. This avoids introducing `Ref<S>` as a new top-level type.

**Rejected** because it complicates the type signatures for partial-stack scenarios (what is the `ChildType` for a read-only document?), doesn't address the runtime decomposition issue, and a unified `Ref<S>` is simpler for the common case.

### Alternative 3: Keep `withReadable` intact, add `Ref<S>` type only

Fix the type system without touching runtime code. `Ref<S>` would be a type-only construct, and navigation stays bundled in `withReadable`.

**Rejected** because it leaves the write-only-with-navigation gap, doesn't address the `SequenceRef` category error, and creates a type system that doesn't mirror the runtime decomposition (the type says navigation is independent, the runtime says it isn't).

### Alternative 4: Rename `READ` → `CALL` but keep the `HasRead` name for the base brand

Keep `HasRead` as the bottom brand (meaning "has a `[CALL]` slot"), avoiding the `HasCall` introduction. This reduces churn.

**Rejected** because it perpetuates the naming confusion. `HasRead` saying "I'm callable" when there's a separate `withReadable` layer that means "I can actually read" is a contradiction. `HasCall` is honest about what the base brand guarantees: a callable carrier. `HasRead` is then free to mean what it says: a carrier that can produce values when called.

### Alternative 5: Full open registry with `Map<symbol, Function>`

Replace the symbol-property pattern with a formal `Map<symbol, Function>` registry on each carrier.

**Rejected** because JavaScript objects already *are* symbol-keyed registries. `Object.defineProperty` is the register call, `symbol in obj` is the lookup, and `Object.getOwnPropertySymbols(ref)` is the enumeration. A `Map` would add indirection and GC overhead for no new capability.

## PR Stack

The work is arranged as a dependency-ordered stack of 6 PRs. Each is individually buildable, testable, and reviewable. The stack follows an additive-first strategy: new APIs and types are introduced before anything is removed or migrated.

### PR 1: `refactor: rename READ → CALL, HasRead → HasCall` 🟢

**Type:** Mechanical refactor (rename)

Pure symbol/type rename with zero behavior change. Every `READ` reference becomes `CALL`, every `HasRead` (in the "base carrier" sense) becomes `HasCall`. The `Symbol.for` string changes from `"kyneta:read"` to `"kyneta:call"`.

**Scope:**
- `bottom.ts`: `READ` → `CALL`, `HasRead` → `HasCall`, `makeCarrier` return type, `bottomInterpreter` type signature
- `with-readable.ts`: import `CALL` instead of `READ`, all `result[READ]` → `result[CALL]`, `A extends HasRead` → `A extends HasCall`
- `with-changefeed.ts`: import `CALL` instead of `READ`, `result[READ]()` → `result[CALL]()`
- `writable.ts`: re-export `CALL` instead of `READ`
- `index.ts`: re-export `CALL` and `HasCall`
- `bottom.test.ts`: `READ` → `CALL` in imports, assertions, describe blocks
- `with-readable.test.ts`: `READ` → `CALL` in imports and assertions, `HasRead` → `HasCall` in type tests
- `with-caching.test.ts`: `HasRead` → `HasCall` in type-level test imports/assertions
- `writable.test.ts`: `READ` → `CALL` in imports
- `example/main.ts`: `[READ]` → `[CALL]` in the symbol hooks display string
- Comments and JSDoc updated throughout

**Does NOT change:** Runtime behavior, test logic, capability lattice shape (just names).

**Tests:** All existing tests pass with updated symbol names. Type-level tests use `HasCall` where they previously used `HasRead`.

---

### PR 2: `refactor: introduce HasRead phantom brand` 🔴

**Type:** Prep — add new type, no callers yet

Adds `HasRead` back as a **new** phantom brand meaning "the `[CALL]` slot has been filled with a reader." This is additive — nothing requires `HasRead` yet.

**Scope:**
- `bottom.ts`: add `HasRead extends HasNavigation` with a phantom `[READ_BRAND]: true`. Export it.
- `index.ts`: export `HasRead`
- `bottom.test.ts`: add type-level test — `HasNavigation` does NOT satisfy `HasRead` (negative). `HasRead extends HasNavigation` (positive).

**Does NOT change:** `withReadable`'s signature (still produces `A & HasNavigation`). No consumer uses `HasRead` yet. `HasCaching` still extends `HasNavigation`.

**Tests:** Existing tests unaffected. New type-level tests for brand relationships.

---

### PR 3: `feat: extract withNavigation from withReadable` 🔴

**Type:** Feature — new runtime layer + slimmed existing layer

The core behavioral change. Creates `withNavigation` by moving navigation code out of `withReadable`. Updates `withReadable` to require `HasNavigation` and produce `HasRead`.

**Scope:**
- New file `with-navigation.ts`: navigation logic extracted from `with-readable.ts` (product field getters, `.at()`, `.length`, `.keys()`, `.has()`, `.size`, `.entries()`, `.values()`, `[Symbol.iterator]`, sum dispatch, annotated delegation). Signature: `<A extends HasCall>(base) → Interpreter<RefContext, A & HasNavigation>`.
- `with-readable.ts`: slimmed to `[CALL]` filling, `toPrimitive`, `.get()`. Input changes to `A extends HasNavigation`. Output changes to `A & HasRead`. Sum dispatch removed (handled by `withNavigation`).
- `writable.ts`: text `.update()` refactored from `result()` (carrier call) to `readByPath(ctx.store, path)` (store inspection) — eliminates hidden reading dependency, makes navigate+write-without-read stacks fully functional.
- `with-changefeed.ts`: widen from `Interpreter<WritableContext, A>` to `Interpreter<RefContext, A extends HasRead>`. Leaf `.current` changed from `readByPath(ctx.store, path)` to `(result as any)[CALL]()` (consistent with composite case). `ensurePrepareWiring` duck-types for `prepare`/`flush` — graceful degradation to static Moore machine on read-only stacks.
- `layers.ts`: `readable` layer updated to `withCaching(withReadable(withNavigation(base)))`. New `navigation` layer exported. `changefeed` layer widened from `InterpreterLayer<WritableContext, WritableContext>` to `InterpreterLayer<RefContext, RefContext>`.
- `index.ts`: export `withNavigation` and `navigation` layer.
- All test files using `withReadable(bottomInterpreter)` updated to `withReadable(withNavigation(bottomInterpreter))`.
- New file `with-navigation.test.ts`: navigation in isolation, navigate+write integration, type-level composition tests.
- `with-readable.test.ts`: updated for new composition and `HasRead` output brand.
- `with-caching.test.ts`: updated type-level test comments (now `HasCall & HasNavigation & HasCaching`, not `HasRead & ...`).
- `changefeed.test.ts`: add read-only changefeed test — `withChangefeed(withCaching(withReadable(withNavigation(bottom))))` with plain `RefContext` produces valid Moore machines (`.current` works, `.subscribe` returns no-op). Existing full-stack tests unaffected.

**Tests:** All existing runtime tests pass (the composed behavior is identical). New tests for `withNavigation` in isolation, the navigate+write stack, and read-only changefeed stacks.

---

### PR 4: `feat: NavigableSequenceRef, NavigableMapRef, slim SequenceRef, Ref<S>` 🔴

**Type:** Feature — new types, no test migration yet

Introduces the type-level fix. Additive: new types are defined and exported, but test files are not yet migrated.

**Scope:**
- New file `navigable.ts`: `NavigableSequenceRef<T>`, `NavigableMapRef<T>`.
- `readable.ts`: `ReadableSequenceRef` and `ReadableMapRef` refactored to extend `NavigableSequenceRef` / `NavigableMapRef`.
- `writable.ts`: `SequenceRef` slimmed to mutation-only (remove `.at()`, `.length`, `[Symbol.iterator]`, drop type parameter). `Writable<S>` updated.
- New `Ref<S>` unified recursive type defined (in `writable.ts` or a new `ref.ts`). Uses `ReadableSequenceRef<Ref<I>, Plain<I>> & SequenceRef & HasTransact` for sequences, etc.
- `index.ts`: export `Ref`, `NavigableSequenceRef`, `NavigableMapRef`.
- `types.test.ts`: type-level assertions for `Ref<S>` — `.at()` returns `Ref<Child>` with both `.set()` and `()`, `[TRANSACT]` present at all levels.

**Does NOT change:** Any test file's runtime behavior or cast patterns. `Readable<S>` and `Writable<S>` remain unchanged (except `Writable` uses slimmed `SequenceRef`).

**Tests:** Existing tests unaffected (they still use `as any` or `Readable & Writable`). New type-level tests for `Ref<S>`.

---

### PR 5: `refactor: migrate tests from as-any to Ref<S>` 🔴

**Type:** Call-site migration

Replaces `as any` and `as unknown as Readable<S> & Writable<S>` with `as Ref<typeof schema>` across all test files and the example. Zero runtime behavior change — only type annotations change.

**Scope:**
- `changefeed.test.ts`: `as unknown as Readable<S> & Writable<S>` → `as Ref<typeof chatDocSchema>`. Resolves all 11 original type errors.
- `writable.test.ts`: `as any` → `as Ref<typeof schema>` for full-stack interpret results (~20 sites). Intentional `as any` for write-only / edge-case tests stays.
- `facade.test.ts`: `as unknown as Readable<S> & Writable<S>` → `as Ref<S>`.
- `transaction.test.ts`: one cast migrated.
- `readable.test.ts`: composition updated (already done in PR 3), casts remain `as any` where testing read-only stack (no `Ref<S>` for partial stacks).
- `fluent.test.ts`: migrate where full stack is used.
- `example/main.ts`: `as any` → `as Ref<typeof ProjectSchema>`.
- Verify `bun tsc --noEmit` produces zero errors.

**Tests:** All runtime tests pass unchanged. The PR's value is purely type-safety: tsc now catches navigation/mutation/symbol-access errors at compile time.

---

### PR 6: `docs: update TECHNICAL.md for navigation layer and CALL rename` 🔴

**Type:** Documentation

Updates architecture documentation to reflect the new decomposition.

**Scope:**
- `TECHNICAL.md`: capability lattice diagram (5 layers, diamond shape), symbol table (`READ` → `CALL`), `withNavigation` section, `withReadable` section slimmed, combinatorial stacks table (new rows), type-level interpretation section (`Ref<S>` as primary user-facing type), file map (new files), verified properties (new entries).
- `interpreter-decomposition.md`: mark lattice diagram as superseded.
- Plan status updates across `.plans/navigation-layer.md`.

**Tests:** N/A — documentation only.

---

### Stack Dependency Graph

```
PR 1  refactor: READ → CALL rename
  ↓
PR 2  refactor: HasRead phantom brand (additive)
  ↓
PR 3  feat: withNavigation extraction + withChangefeed widening (core behavioral change)
  ↓
PR 4  feat: Ref<S> + NavigableSequenceRef + slim SequenceRef (type-level fix)
  ↓
PR 5  refactor: test migration as-any → Ref<S> (call-site migration)
  ↓
PR 6  docs: TECHNICAL.md updates
```

### Narrative

A reviewer encounters this stack as a progression: first, a mechanical rename that makes the naming honest (PR 1). Then, a small additive type prep (PR 2). Then the core extraction that creates the new architectural layer (PR 3) — the biggest PR, but purely moving existing code + updating compositions. Then the type-level payoff: `Ref<S>` and the slimmed interfaces that eliminate the intersection unsoundness (PR 4). Then the test migration that proves the types work end-to-end (PR 5). Finally, documentation that captures the new architecture for posterity (PR 6).

Each PR builds on the previous one's foundation. Any PR can be reverted independently without breaking the ones below it (though reverting PR 3 would require reverting 4–6 as well, since they depend on the navigation layer existing).

## Changeset

```
feat: CALL rename + withNavigation layer + Ref<S> unified type

Renames READ → CALL, splits HasRead into HasCall (carrier base) +
HasRead (phantom brand for "reader configured"). Introduces
withNavigation as a standalone interpreter transformer, extracting
structural addressing from withReadable.

- READ → CALL: carrier delegation slot honestly named
- HasCall: base brand from bottomInterpreter ("is callable")
- HasRead: phantom brand from withReadable ("can produce values")
- withNavigation: coalgebraic structural addressing layer
- withReadable slimmed to reading-only (requires HasNavigation)
- SequenceRef reduced to mutation-only (no .at(), .length)
- Ref<S> unified type: navigation + reading + writing + HasTransact
- NavigableSequenceRef / NavigableMapRef type interfaces
- HasCaching now extends HasNavigation (not HasRead) — caching
  without reading is a valid composition
- Test migration: as any → Ref<S> across all test files
- TECHNICAL.md: updated capability lattice, symbol table, type docs
```
