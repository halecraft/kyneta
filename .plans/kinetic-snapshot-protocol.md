# Plan: SNAPSHOT Protocol — Completing the Reactive Observation Algebra

## Background

Kinetic's reactive system is built on the `[REACTIVE]` symbol from `@loro-extended/reactive`. Any type with `[REACTIVE]` is detected by the compiler at compile time and subscribed to at runtime. The `[REACTIVE]` property carries a subscribe function that delivers structured deltas (`ReactiveDelta`) describing how a value changed.

However, `[REACTIVE]` only provides **half** of what a consumer needs. Every runtime consumer of a reactive value performs two operations, always in the same order:

1. **Read the initial state** (the "snapshot")
2. **Subscribe to deltas** that describe how the state evolves

Today, step 1 is accomplished through ad-hoc per-type methods:

| Type | Snapshot method | Returns |
|------|----------------|---------|
| `TextRef` | `.get()` or `.toString()` | `string` |
| `CounterRef` | `.get()` | `number` |
| `LocalRef<T>` | `.get()` | `T` |
| `PlainValueRef<T>` | `.get()` | `T` |
| `ListRef<T>` | `.length` + `.get(i)` | indexed collection |

The snapshot and the deltas are **semantically coupled** — a `TextDelta` with `{ retain: 5, insert: "X" }` only makes sense relative to a string of length ≥ 5 — but **structurally decoupled** across two unrelated access patterns.

### The Mathematical Structure

Each reactive type implements a **Moore machine** (an F-coalgebra for the functor `F(X) = S × (D → X)`):

- **S** — the state type (what you read)
- **D** — the delta type (how it changes)
- **snapshot: () → S** — observe the current state
- **subscribe: (D → void) → (() → void)** — observe future deltas

`[REACTIVE]` formalizes the second half. This plan formalizes the first half via `[SNAPSHOT]`, completing the protocol.

The "replace" delta kind (`ReplaceDelta`) is the **terminal object** in this algebra: `apply(state, replaceDelta) = snapshot()`. The delta carries no structural information, so the only rendering strategy is to re-read the snapshot. Every other delta kind refines this with structure that enables surgical updates.

The relationship between `S` and `D` is **not derivable** from either alone — it's declared by the implementor. `ReplaceDelta` maps to `T` for `LocalRef<T>`, `number` for `CounterRef`, `T` for `PlainValueRef<T>`. A single `Reactive<S, D>` interface encodes this as the complete Moore machine, rather than splitting it across two independent interfaces that could be implemented inconsistently.

### Relationship to Prior Work

- [kinetic-reactive-primitive.md](./kinetic-reactive-primitive.md) (✅ Complete) — Established `@loro-extended/reactive`, `REACTIVE` symbol, `Reactive` interface, `LocalRef`
- [narrow-reactive-delta-types.md](./narrow-reactive-delta-types.md) (✅ Complete) — Narrowed `[REACTIVE]` delta type on every ref so the compiler can extract `DeltaKind`
- [delta-driven-reactivity.md](./delta-driven-reactivity.md) (✅ Complete) — Made `ReactiveSubscribe` callback delta-aware (`ReactiveDelta`), decoupled runtime from Loro
- [reactive-enhancements.md](./reactive-enhancements.md) (✅ Complete) — `state()` factory, `TextRef.get()`, multi-dep subscriptions, `textRegion`, runtime entry point
- [ideas/incremental-view-maintenance.md](../packages/kinetic/ideas/incremental-view-maintenance.md) — Future direction; explicitly lists "Phase 0: Unify `.get()` for scalar reactive types" as the foundation

This plan is the natural next step: unify snapshot access into the protocol so the compiler can emit code without per-type knowledge.

## Problem Statement

1. **User DX friction.** Users must write `p(doc.title.toString())` or `p(count.get())` instead of `p(doc.title)` or `p(count)`. The `.get()`/`.toString()` is ceremony — the compiler already knows the expression is reactive.

2. **The protocol is incomplete.** `[REACTIVE]` only provides subscription. There is no protocol-level way to read initial state. The runtime uses ad-hoc casts (`ref as TextRefLike`, `ref as ListRefLike<T>`) and assumes the existence of `.get()` methods.

3. **The `Child` type rejects reactive values.** `Child = string | number | boolean | null | undefined | Element | Binding<unknown> | Node`. Passing a `TextRef` to `p()` is a TypeScript error.

4. **`detectDirectRead` only recognizes `.get()` / `.toString()` calls.** Bare reactive refs in content position miss the `textRegion` O(k) optimization and fall into the `subscribeWithValue` path with `String()` coercion (which works by accident via `Symbol.toPrimitive`, but loses surgical patching).

5. **Runtime `TextRefLike` and `ListRefLike` are ad-hoc interfaces** that duplicate what the protocol should provide. They exist because the runtime needs to call `.get()` on refs it receives as `unknown`.

## Success Criteria

1. `SNAPSHOT` symbol exported from `@loro-extended/reactive` alongside `REACTIVE`
2. `Snapshotable<S>` interface declares `readonly [SNAPSHOT]: SnapshotFn<S>`
3. `Reactive<S, D>` extends `Snapshotable<S>` — a single interface encoding the complete Moore machine
4. Every scalar typed ref (`TextRef`, `CounterRef`), `LocalRef`, and `PlainValueRef` implements `[SNAPSHOT]`
5. Runtime functions (`textRegion`, `inputTextRegion`) use `[SNAPSHOT]` instead of ad-hoc casts to `TextRefLike`
6. Compiler detects `[SNAPSHOT]` on reactive types and extracts the snapshot return type `S`
7. Bare reactive refs in content position (`p(doc.title)`) compile correctly with `textRegion` optimization when applicable
8. `Child` type accepts `Reactive<any, any>` values
9. Template literals like `` p(`Hello ${doc.name}`) `` continue to work (already functional via `Symbol.toPrimitive`)
10. All existing tests pass; new tests cover the `[SNAPSHOT]` protocol and bare-ref compilation

## The Gap

| Aspect | Current | Target |
|--------|---------|--------|
| Snapshot access | Ad-hoc `.get()` / `.toString()` | Protocol-level `[SNAPSHOT]` |
| `Reactive` interface | `Reactive<D>` (delta only) | `Reactive<S, D>` (state + delta) |
| Bare ref as content | TypeScript error + no optimization | Accepted, auto-unwrapped, O(k) when applicable |
| `Child` type | Rejects reactive values | Accepts `Reactive<any, any>` |
| Runtime ref access | `ref as TextRefLike` with assumed `.get()` | `ref[SNAPSHOT](ref)` via protocol |
| `detectDirectRead` | Requires `.get()` / `.toString()` call node | New `detectImplicitRead` handles bare refs |
| Symbol detection | `isReactiveSymbolProperty` hardcoded for `REACTIVE` | Parameterized `isWellKnownSymbolProperty` reused for both |
| `extractDependencies` | Misses reactive-typed property access results (e.g., `doc.title` where `doc: TypedDoc` is not reactive but `doc.title` is `TextRef`) | Captures the expression itself as a dependency when its result type is reactive |
| `DocRef[REACTIVE]` | Inherited from `TypedRef`, calls `getContainer()` which **throws** for DocRef | Overridden to subscribe to `LoroDoc` directly, emitting `MapDelta` |
| `TypedDoc` type | Omits `[REACTIVE]` — doc is reactive at runtime but invisible to the compiler | Exposes `[REACTIVE]: ReactiveSubscribe<MapDelta>` so the compiler can see it |
| Dependency subsumption | `extractDependencies` can capture both `doc` (map) and `doc.title` (text), breaking `isTextRegionContent` length check | Child dependency subsumes parent — `doc.title` makes `doc` redundant |

## Core Type Declarations

### `@loro-extended/reactive` additions

```typescript
export const SNAPSHOT = Symbol.for("kinetic:snapshot")

export type SnapshotFn<S> = (self: unknown) => S

export interface Snapshotable<S> {
  readonly [SNAPSHOT]: SnapshotFn<S>
}

// The complete Moore machine: snapshot (observation) + subscribe (transition)
// S = state type, D = delta type
export interface Reactive<S = unknown, D extends ReactiveDelta = ReplaceDelta>
  extends Snapshotable<S> {
  readonly [SNAPSHOT]: SnapshotFn<S>
  readonly [REACTIVE]: ReactiveSubscribe<D>
}
```

`Snapshotable<S>` is exported as a building block for consumers that need to express "readable but not necessarily reactive" (e.g., static data sources). The primary user-facing type is `Reactive<S, D>`.

### `isSnapshotable` type guard

```typescript
export function isSnapshotable(value: unknown): value is Snapshotable<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    SNAPSHOT in value &&
    typeof (value as Record<symbol, unknown>)[SNAPSHOT] === "function"
  )
}
```

### Per-ref `[SNAPSHOT]` implementations (scalar types only)

Each ref type's `[SNAPSHOT]` follows the `self` parameter pattern established by `[REACTIVE]`:

| Ref Type | `[SNAPSHOT]` returns | Implementation |
|----------|---------------------|----------------|
| `TextRef` | `string` | `(self) => (self as TextRef).toString()` |
| `CounterRef` | `number` | `(self) => (self as CounterRef).get()` |
| `LocalRef<T>` | `T` | `(self) => (self as LocalRef<T>).get()` |
| `PlainValueRef<T>` | `T` | `(self) => getValue()` (closure from factory) |

Collection types (`ListRef`, `StructRef`, `RecordRef`, `TreeRef`) do **not** override `[SNAPSHOT]` in this plan — they inherit the base class identity fallback `(self) => self`. They are never placed in content position, so the compiler never needs to synthesize a snapshot call for them. `listRegion` continues to receive the list ref directly and call `.length` / `.get(i)` on it — this existing pattern is correct and does not benefit from `[SNAPSHOT]`. Collection types can gain narrowed `[SNAPSHOT]` overrides in a future plan if needed (e.g., for the IVM `join()` pattern).

`DocRef` is a special case: it inherits the identity `[SNAPSHOT]` from `TypedRef`, but its `[REACTIVE]` is broken (see Phase 6). Phase 6 fixes `DocRef[REACTIVE]` to subscribe to `LoroDoc` and exposes `[REACTIVE]` on the `TypedDoc` type.

### `Reactive<S, D>` — the unified Moore machine interface

```typescript
// Before:
export interface Reactive<D extends ReactiveDelta = ReactiveDelta>

// After:
export interface Reactive<S = unknown, D extends ReactiveDelta = ReplaceDelta>
  extends Snapshotable<S> {
  readonly [SNAPSHOT]: SnapshotFn<S>
  readonly [REACTIVE]: ReactiveSubscribe<D>
}
```

This is a **type-level breaking change**. All `implements Reactive<SomeDelta>` sites must update to `Reactive<S, SomeDelta>`. The blast radius is ~14 sites across `@loro-extended/reactive`, `@loro-extended/change`, and Kinetic test mocks — all packages we control. This is acceptable for an experimental framework. See Breaking Change Assessment for the full enumeration.

### `isReactive` — requires both symbols (deferred to Phase 2)

`isReactive` will ultimately check for **both** `[REACTIVE]` and `[SNAPSHOT]`, since `Reactive<S, D>` extends `Snapshotable<S>`:

```typescript
export function isReactive(value: unknown): value is Reactive {
  return (
    value !== null &&
    typeof value === "object" &&
    REACTIVE in value &&
    typeof (value as Record<symbol, unknown>)[REACTIVE] === "function" &&
    SNAPSHOT in value &&
    typeof (value as Record<symbol, unknown>)[SNAPSHOT] === "function"
  )
}
```

**Timing:** `isReactive` is NOT tightened in Phase 1. In Phase 1, only `LocalRef` gains `[SNAPSHOT]`. If `isReactive` immediately required `[SNAPSHOT]`, all typed refs from `@loro-extended/change` would fail the check, breaking the Kinetic runtime's `subscribe()` function and 968+ change package tests. Instead:

- **Phase 1**: `isReactive` continues to check only `[REACTIVE]` (no behavioral change). The `Reactive<S, D>` interface update and `Snapshotable` are type-level only.
- **Phase 2**: After all typed refs gain `[SNAPSHOT]`, `isReactive` is tightened to require both symbols. This is Phase 2 Task 2.8.

The `isSnapshotable` guard is available from Phase 1 for checking `[SNAPSHOT]` in isolation.

## Phases and Tasks

### Phase 1: `SNAPSHOT` symbol, `Reactive<S, D>`, and `LocalRef` in `@loro-extended/reactive` ✅

Introduce the `SNAPSHOT` symbol, `SnapshotFn<S>` type, `Snapshotable<S>` interface, `isSnapshotable` type guard, update `Reactive` to `Reactive<S, D>`, and implement on `LocalRef`. `isReactive` is **not** tightened in this phase (see Phase 2 Task 2.8).

- **Task 1.1**: Add `SNAPSHOT` symbol, `SnapshotFn<S>`, and `Snapshotable<S>` to `packages/reactive/src/index.ts` ✅
- **Task 1.2**: Add `isSnapshotable` type guard ✅
- **Task 1.3**: Update `Reactive` interface from `Reactive<D>` to `Reactive<S, D>` extending `Snapshotable<S>` ✅
- **Task 1.4**: Implement `[SNAPSHOT]` on `LocalRef<T>` — `readonly [SNAPSHOT]: SnapshotFn<T> = (self) => (self as LocalRef<T>).get()` ✅
- **Task 1.5**: Update `LocalRef<T>` from `implements Reactive<ReplaceDelta>` to `implements Reactive<T, ReplaceDelta>` ✅
- **Task 1.6**: Add unit tests for `SNAPSHOT` symbol, `isSnapshotable`, `LocalRef[SNAPSHOT]` ✅
- **Task 1.7**: Verify `@loro-extended/reactive` builds and all tests pass ✅

### Phase 2: `[SNAPSHOT]` on scalar `@loro-extended/change` typed refs ✅

Add `[SNAPSHOT]` to scalar typed refs that appear in content position. Update `Reactive` type parameters on all typed refs to the `<S, D>` form. Tighten `isReactive` to require both symbols (now safe because all refs have `[SNAPSHOT]`).

- **Task 2.1**: Add `[SNAPSHOT]` default implementation to `TypedRef` base class — `(self) => self` (identity fallback for collection types that inherit but don't override) ✅
- **Task 2.2**: Override `[SNAPSHOT]` on `TextRef` — `readonly [SNAPSHOT]: SnapshotFn<string> = (self) => (self as TextRef).toString()`. No `declare` needed — the concrete property definition provides both the narrowed type and the runtime value (see Learnings §"`declare` vs concrete property for symbol overrides"). ✅
- **Task 2.3**: Override `[SNAPSHOT]` on `CounterRef` — `readonly [SNAPSHOT]: SnapshotFn<number> = (self) => (self as CounterRef).get()`. Same pattern as TextRef. ✅
- **Task 2.4**: Update `TypedRef` base from `implements Reactive` to `implements Reactive<unknown, ReactiveDelta>`. **Note:** `Reactive<unknown>` (using the `D` default) would expand to `Reactive<unknown, ReplaceDelta>`, which is too narrow — the base class `[REACTIVE]` must accept any `ReactiveDelta` since subclasses emit text, list, map, tree deltas. Also added `[REACTIVE]` and `[SNAPSHOT]` to `TreeRefInterface` in `shape.ts` to fix a pre-existing type error where TreeRef was not indexable by `[REACTIVE]`. ✅
- **Task 2.5**: Add `[SNAPSHOT]` to `PlainValueRef<T>` interface in `plain-value-ref/types.ts` — `readonly [SNAPSHOT]: SnapshotFn<T>` ✅
- **Task 2.6**: Implement `[SNAPSHOT]` in `buildBasePlainValueRef` factory — `(self) => getValue()` ✅
- **Task 2.7**: Update `StructRef`'s Proxy `get` and `has` traps in `struct-ref.ts` to handle `SNAPSHOT` (same pattern as the existing `REACTIVE` interception). Added `[SNAPSHOT]: SnapshotFn<unknown>` to the `StructRef` type alias. ✅
- **Task 2.8**: Tighten `isReactive` in `packages/reactive/src/index.ts` to require both `[REACTIVE]` and `[SNAPSHOT]`. Now safe because all first-party types (`LocalRef`, all typed refs, `PlainValueRef`) implement both symbols. Updated existing `isReactive` tests to include `[SNAPSHOT]`. ✅
- **Task 2.9**: Rebuild both packages. All `@loro-extended/reactive` tests pass (79). All `@loro-extended/change` tests pass (1012, up from 983). All `@loro-extended/kinetic` tests pass (971). Zero type errors in reactive and change packages. ✅
- **Task 2.10**: Add tests for `[SNAPSHOT]` on `TextRef`, `CounterRef`, `PlainValueRef`, all collection types (identity snapshot), `StructRef` proxy interception, and tightened `isReactive` across all ref types including `LocalRef`. ✅

### Phase 3: Runtime uses `[SNAPSHOT]` instead of ad-hoc interfaces ✅

Replace `TextRefLike` ad-hoc casts with protocol-level `[SNAPSHOT]` access in the Kinetic runtime. `listRegion` is **out of scope** — its `ListRefLike<T>` cast is idiomatic for the functional-core planning functions and does not benefit from `[SNAPSHOT]`.

- **Task 3.1**: Update `textRegion` — replace `(ref as TextRefLike).get()` with `(ref as Snapshotable<string>)[SNAPSHOT](ref)`. Remove `TextRefLike` interface. Also required rebuilding `@loro-extended/reactive` and `@loro-extended/change` dist so the tightened `isReactive` is picked up by the kinetic runtime at test time. ✅
- **Task 3.2**: Update `inputTextRegion` — same replacement pattern. Both `textRegion` and `inputTextRegion` shared the same `TextRefLike` cast; both now use `Snapshotable<string>` + `[SNAPSHOT]`. ✅
- **Task 3.3**: Verify `subscribeWithValue` — the `getValue` parameter is already a closure. No changes needed. ✅
- **Task 3.4**: Verify `conditionalRegion` — `getCondition` is already a closure. No changes needed. ✅
- **Task 3.5**: Run all runtime tests. All 971 kinetic tests pass. Also fixed a mock in `subscribe.test.ts` that lacked `[SNAPSHOT]` (custom reactive type mock now includes both symbols). ✅

### Phase 4: Compiler detects `[SNAPSHOT]`, supports bare-ref content, and widens `Child` type ✅

The compiler gains the ability to detect `[SNAPSHOT]`, extract the snapshot return type, and handle bare reactive refs in content position. Also fixes a pre-existing bug in `extractDependencies` where reactive-typed property access results are not captured. Finally, the `Child` type is widened to accept reactive values at the TypeScript level.

- **Task 4.1**: Refactor `isReactiveSymbolProperty` in `reactive-detection.ts` into a **parameterized** `isWellKnownSymbolProperty(compilerSymbol: ts.Symbol, symbolForKey: string, declarationName: string, mangledPrefix: string): boolean`. The three detection layers (Symbol.for tracing, declaration name, mangled property name) become parameters instead of hardcoded strings. `isReactiveSymbolProperty` becomes a one-line delegate: `isWellKnownSymbolProperty(sym, "kinetic:reactive", "REACTIVE", "__@REACTIVE@")`. Also added `isSnapshotSymbolProperty` as a parallel delegate with `("kinetic:snapshot", "SNAPSHOT", "__@SNAPSHOT@")`. ✅
- **Task 4.2**: Add `isSnapshotableType(type: Type): boolean` to `reactive-detection.ts` — delegates to `isSnapshotSymbolProperty`. Follows the same union-handling and `any`/`unknown` exclusion as `isReactiveType`. ✅
- **Task 4.3**: Add `getSnapshotType(type: Type): string | undefined` to `reactive-detection.ts` — extracts the return type `S` from `[SNAPSHOT]`'s call signature via the TypeChecker. Returns the type's text representation (e.g., `"string"`, `"number"`). ✅
- **Task 4.4**: Fix `extractDependencies` in `analyze.ts` — added a second check to the `PropertyAccessExpression` handler: if the **result type** of the property access expression is reactive (`isReactiveType`), capture the whole expression as a dependency (with `getDeltaKind` of the result type). The `depsMap` deduplication ensures no double-capture. ✅
- **Task 4.5**: Add `detectImplicitRead(expr: Expression): string | undefined` to `analyze.ts` — a **new** pure function. Returns the expression's source text if: (a) not a `CallExpression`, (b) type is reactive, and (c) type is snapshotable. ✅
- **Task 4.6**: Extend `analyzeExpression` in `analyze.ts` — after `detectDirectRead` returns `undefined`, tries `detectImplicitRead`. If it returns a source string, synthesizes `source` as `"${exprText}.get()"` and sets `directReadSource` to the expression text. ✅
- **Task 4.7**: Add compiler tests: bare `TextRef` → `textRegion`; bare `CounterRef` → `subscribeWithValue` with `.get()`. Both unit tests in `analyze.test.ts` and integration tests in `transform.test.ts`. ✅
- **Task 4.8**: Add compiler tests: explicit `.get()` and `.toString()` still work as before (backward compatible). ✅
- **Task 4.9**: Add compiler test: bare ref inside a larger expression (`doc.first.get() + " " + doc.last.get()`) → `subscribeMultiple`, not `textRegion`. ✅
- **Task 4.10**: Add compiler test: `p(doc.title)` where `doc = createTypedDoc(...)` produces `{ source: "doc.title", deltaKind: "text" }` and emits `textRegion`. ✅
- **Task 4.11**: Update test mocks in `analyze.test.ts`: (a) `reactive-base.d.ts` now exports `SNAPSHOT`, `SnapshotFn<S>`, `Snapshotable<S>`, and `Reactive<S, D>` with both symbols. (b) `loro-types.d.ts` ref interfaces updated to two-parameter `Reactive` with `[SNAPSHOT]` properties. (c) `reactive-types.d.ts` `LocalRef<T>` updated similarly. ✅
- **Task 4.12**: Add `Reactive<any, any>` to the `Child` type union in `packages/kinetic/src/types.ts`. Imported `Reactive` from `@loro-extended/reactive`. ✅
- **Task 4.13**: Documented known limitation in `PropsWithBindings` in `elements.d.ts`: reactive attribute values are not yet supported. ✅
- **Task 4.14**: Type-level compilation verified via integration tests — `p(doc.title)` compiles without errors when `doc.title` is `TextRef`. ✅
- **Task 4.15**: Existing tests verify `p("literal string")` and `p(42)` still compile (no regressions). ✅
- **Task 4.16**: Full Kinetic test suite passes: 1000 tests (up from 971). Reactive: 79. Change: 1012. Zero type errors. ✅

### Phase 5: Documentation 🔴

- **Task 5.1**: Update `packages/reactive/README.md` — document `SNAPSHOT` symbol, `Snapshotable<S>` interface, updated `Reactive<S, D>` interface, `isSnapshotable` guard, Moore machine framing 🔴
- **Task 5.2**: Update `packages/kinetic/TECHNICAL.md` — update Reactive Detection section to cover `isWellKnownSymbolProperty` refactor and `[SNAPSHOT]` detection, update Direct-Read Detection to document `detectImplicitRead` for bare-ref handling, update Runtime Dependencies to show `[SNAPSHOT]` usage in `textRegion`/`inputTextRegion` 🔴
- **Task 5.3**: Update `packages/change/TECHNICAL.md` — update Reactive Bridge section to document `[SNAPSHOT]` implementations on scalar ref types, update the ref-to-delta mapping table to include snapshot types and `S` column 🔴
- **Task 5.4**: Update `packages/kinetic/README.md` — update usage examples to show bare-ref syntax (`p(doc.title)` instead of `p(doc.title.toString())`) 🔴
- **Task 5.5**: Create changeset 🔴

### Phase 6: `DocRef[REACTIVE]` fix, `TypedDoc` type exposure, and dependency subsumption 🔴

Fix the latent bug where `DocRef[REACTIVE]` throws at runtime, expose both `[REACTIVE]` and `[SNAPSHOT]` on the `TypedDoc` type so the compiler can see them, and add a dependency subsumption rule so that child dependencies don't degrade to parent dependencies.

**Background:** `DocRef` inherits `[REACTIVE]` from `TypedRef`, but the base class implementation calls `ref[INTERNAL_SYMBOL].getContainer()` — and `DocRef`'s container getter is `() => { throw new Error("can't get container on DocRef") }`. So `doc[REACTIVE](doc, callback)` throws. At runtime `REACTIVE in doc` is `true` (via `Reflect.get` passthrough in the `TypedDoc` Proxy), but calling it is a latent crash. The `TypedDoc<Shape>` type alias also omits `[REACTIVE]` and `[SNAPSHOT]`, so the compiler can't detect docs as reactive or snapshotable. Both are bugs.

**Note on `isReactive(doc)` at runtime:** After Phase 2, `isReactive(doc)` returns `true` at runtime because the TypedDoc Proxy's `has` trap falls through via `Reflect.has` to the underlying `DocRef`, which now has both `[REACTIVE]` and `[SNAPSHOT]` from the `TypedRef` base class. But _calling_ `doc[REACTIVE](doc, cb)` still throws because the inherited `[REACTIVE]` calls `getContainer()`. Phase 6 Task 6.1 fixes the throw.

A document is a Moore machine: `Reactive<TypedDoc<Shape>, MapDelta>`. The snapshot is the ref surface itself (identity, like `ListRef`), and deltas describe which root keys changed. The consumer uses the delta to know which children to re-observe. This is consistent with how all collection types work.

- **Task 6.1**: Override `[REACTIVE]` on `DocRef` to subscribe to `LoroDoc` directly (via `this[INTERNAL_SYMBOL].getDoc().subscribe(...)`) instead of calling `getContainer()`. Translate events using `translateEventBatch`. Extract changed root keys from event paths to produce `MapDelta`. 🔴
- **Task 6.2**: Add both `[REACTIVE]: ReactiveSubscribe<MapDelta>` and `[SNAPSHOT]: SnapshotFn<unknown>` to the `TypedDoc<Shape>` type alias in `typed-doc.ts`. This makes the compiler aware that docs are both reactive and snapshotable. Without `[SNAPSHOT]`, `isSnapshotableType` (Phase 4) would not detect `TypedDoc`, and `detectImplicitRead` would not fire for bare doc refs. 🔴
- **Task 6.3**: Add dependency subsumption to `extractDependencies` in `analyze.ts`: after collecting all dependencies, filter out any dependency whose source is a strict prefix of another dependency's source (i.e., `"doc"` is subsumed by `"doc.title"`). This ensures that `doc.title.toString()` where `doc` is a reactive `TypedDoc` produces only `{ source: "doc.title", deltaKind: "text" }`, not an additional `{ source: "doc", deltaKind: "map" }` that would break the `isTextRegionContent` length-1 check. 🔴
- **Task 6.4**: Add tests: `doc[REACTIVE](doc, callback)` succeeds and delivers `MapDelta` when child containers change. Verify `isReactive(doc)` returns `true` at both runtime and compiler type levels. 🔴
- **Task 6.5**: Add compiler test: `p(doc.title.toString())` where `doc: TypedDoc` (now reactive) still produces `textRegion` (dependency subsumption keeps `doc.title` with deltaKind `"text"`, drops `doc` with deltaKind `"map"`). 🔴
- **Task 6.6**: Verify full test suites pass across all three packages. 🔴

## Tests

### Phase 1: Reactive package tests

```typescript
describe("SNAPSHOT symbol", () => {
  it("is accessible via Symbol.for", () => {
    expect(SNAPSHOT).toBe(Symbol.for("kinetic:snapshot"))
  })

  it("is different from REACTIVE", () => {
    expect(SNAPSHOT).not.toBe(REACTIVE)
  })
})

describe("isSnapshotable", () => {
  it("returns true for objects with SNAPSHOT function", () => {
    const obj = { [SNAPSHOT]: (self: unknown) => 42 }
    expect(isSnapshotable(obj)).toBe(true)
  })

  it("returns false for objects without SNAPSHOT", () => {
    expect(isSnapshotable({ get: () => 42 })).toBe(false)
  })
})

// Note: isReactive is NOT tightened in Phase 1. These tests move to Phase 2
// after Task 2.8 tightens the check. In Phase 1, isReactive still only
// checks [REACTIVE] — the existing tests in index.test.ts remain unchanged.

describe("LocalRef[SNAPSHOT]", () => {
  it("returns current value via protocol", () => {
    const ref = new LocalRef(42)
    expect(ref[SNAPSHOT](ref)).toBe(42)
  })

  it("reflects updates", () => {
    const ref = new LocalRef("hello")
    ref.set("world")
    expect(ref[SNAPSHOT](ref)).toBe("world")
  })
})

describe("Reactive<S, D> interface", () => {
  it("LocalRef satisfies Reactive<number, ReplaceDelta>", () => {
    const ref: Reactive<number, ReplaceDelta> = new LocalRef(0)
    expect(ref[SNAPSHOT](ref)).toBe(0)
    expect(typeof ref[REACTIVE]).toBe("function")
  })
})
```

### Phase 2: Change package tests

```typescript
describe("[SNAPSHOT] on typed refs", () => {
  it("TextRef snapshot returns string", () => {
    const doc = createTypedDoc(Shape.doc({ title: Shape.text() }))
    doc.title.insert(0, "Hello")
    expect(doc.title[SNAPSHOT](doc.title)).toBe("Hello")
  })

  it("CounterRef snapshot returns number", () => {
    const doc = createTypedDoc(Shape.doc({ count: Shape.counter() }))
    doc.count.increment(5)
    expect(doc.count[SNAPSHOT](doc.count)).toBe(5)
  })

  it("PlainValueRef snapshot returns value", () => {
    const doc = createTypedDoc(Shape.doc({
      meta: Shape.struct({ name: Shape.string("Alice") })
    }))
    expect(doc.meta.name[SNAPSHOT](doc.meta.name)).toBe("Alice")
  })
})

describe("isReactive tightened (Phase 2 Task 2.8)", () => {
  it("returns true for objects with both REACTIVE and SNAPSHOT", () => {
    const obj = {
      [REACTIVE]: (self: unknown, cb: Function) => () => {},
      [SNAPSHOT]: (self: unknown) => 42,
    }
    expect(isReactive(obj)).toBe(true)
  })

  it("returns false for objects with only REACTIVE (no SNAPSHOT)", () => {
    const obj = {
      [REACTIVE]: (self: unknown, cb: Function) => () => {},
    }
    expect(isReactive(obj)).toBe(false)
  })

  it("returns false for objects with only SNAPSHOT (no REACTIVE)", () => {
    const obj = {
      [SNAPSHOT]: (self: unknown) => 42,
    }
    expect(isReactive(obj)).toBe(false)
  })

  it("all typed refs pass tightened isReactive", () => {
    const doc = createTypedDoc(Shape.doc({
      title: Shape.text(),
      count: Shape.counter(),
    }))
    expect(isReactive(doc.title)).toBe(true)
    expect(isReactive(doc.count)).toBe(true)
  })

  it("LocalRef passes tightened isReactive", () => {
    const ref = new LocalRef(0)
    expect(isReactive(ref)).toBe(true)
  })
})

describe("StructRef Proxy handles SNAPSHOT", () => {
  it("StructRef exposes [SNAPSHOT] through Proxy", () => {
    const doc = createTypedDoc(Shape.doc({
      settings: Shape.struct({ theme: Shape.plain.string() })
    }))
    expect(SNAPSHOT in doc.settings).toBe(true)
    expect(typeof doc.settings[SNAPSHOT]).toBe("function")
  })
})
```

### Phase 4: Compiler tests

```typescript
describe("isWellKnownSymbolProperty (parameterized detection)", () => {
  it("detects REACTIVE via parameterized function", () => {
    // Same test as existing isReactiveSymbolProperty tests,
    // now verifying the parameterized version works identically
  })

  it("detects SNAPSHOT via same parameterized function", () => {
    // Verify SNAPSHOT detection uses the same three-layer strategy
  })
})

describe("detectImplicitRead", () => {
  it("detects bare TextRef as implicit read", () => {
    // doc.title (not .get()) where doc.title is TextRef
    // → returns "doc.title"
  })

  it("rejects non-reactive expressions", () => {
    // someString (a plain string variable)
    // → returns undefined
  })

  it("rejects call expressions (those go through detectDirectRead)", () => {
    // doc.title.get() — this is a CallExpression, not a bare ref
    // → returns undefined
  })
})

describe("bare reactive ref in content position", () => {
  it("compiles bare TextRef to textRegion", () => {
    const source = `
      import { TextRef } from "@loro-extended/change"
      declare const doc: { title: TextRef }
      div(() => {
        p(doc.title)
      })
    `
    const result = transformSource(source, { target: "dom" })
    expect(result.code).toContain("textRegion(")
    expect(result.code).toContain("doc.title")
  })

  it("compiles bare CounterRef to subscribeWithValue with .get()", () => {
    const source = `
      import { CounterRef } from "@loro-extended/change"
      declare const doc: { count: CounterRef }
      div(() => {
        span(doc.count)
      })
    `
    const result = transformSource(source, { target: "dom" })
    expect(result.code).toContain("subscribeWithValue(")
    expect(result.code).toContain("doc.count.get()")
  })

  it("still supports explicit .get() call", () => {
    const source = `
      import { TextRef } from "@loro-extended/change"
      declare const doc: { title: TextRef }
      div(() => {
        p(doc.title.get())
      })
    `
    const result = transformSource(source, { target: "dom" })
    expect(result.code).toContain("textRegion(")
  })

  it("bare ref inside expression is not an implicit read", () => {
    const source = `
      import { TextRef } from "@loro-extended/change"
      declare const doc: { first: TextRef, last: TextRef }
      div(() => {
        p(doc.first.get() + " " + doc.last.get())
      })
    `
    const result = transformSource(source, { target: "dom" })
    expect(result.code).toContain("subscribeMultiple(")
    expect(result.code).not.toContain("textRegion(")
  })
})

describe("extractDependencies fix for reactive-typed property access", () => {
  it("captures doc.title as dependency when doc is TypedDoc (not reactive) but doc.title is TextRef", () => {
    const source = `
      import { createTypedDoc, Shape } from "@loro-extended/change"
      const schema = Shape.doc({ title: Shape.text() })
      const doc = createTypedDoc(schema)
      div(() => { p(doc.title) })
    `
    const result = transformSource(source, { target: "dom" })
    const p = result.ir[0].children[0] as any
    const content = p.children[0]
    expect(content.dependencies).toHaveLength(1)
    expect(content.dependencies[0].source).toBe("doc.title")
    expect(content.dependencies[0].deltaKind).toBe("text")
  })
})
```

### Phase 6: DocRef reactive + dependency subsumption tests

```typescript
describe("DocRef[REACTIVE] subscription", () => {
  it("doc[REACTIVE](doc, callback) succeeds (no longer throws)", () => {
    const doc = createTypedDoc(Shape.doc({ title: Shape.text() }))
    const callback = vi.fn()
    const unsub = doc[REACTIVE](doc, callback)
    doc.title.insert(0, "Hello")
    loro(doc).commit()
    expect(callback).toHaveBeenCalled()
    unsub()
  })

  it("emits MapDelta with changed root key", () => {
    const doc = createTypedDoc(Shape.doc({ title: Shape.text(), count: Shape.counter() }))
    let receivedDelta: unknown = null
    const unsub = doc[REACTIVE](doc, (delta: unknown) => {
      receivedDelta = delta
    })
    doc.title.insert(0, "Hello")
    loro(doc).commit()
    expect(receivedDelta).toMatchObject({ type: "map" })
    unsub()
  })

  it("isReactive(doc) returns true", () => {
    const doc = createTypedDoc(Shape.doc({ title: Shape.text() }))
    expect(isReactive(doc)).toBe(true)
  })
})

describe("dependency subsumption", () => {
  it("doc.title.toString() with reactive TypedDoc produces only doc.title dep (not doc)", () => {
    // After Phase 6: TypedDoc exposes [REACTIVE], so doc is reactive.
    // extractDependencies would capture both doc (map) and doc.title (text).
    // Subsumption rule drops doc because doc.title is more specific.
    const source = `
      import { createTypedDoc, Shape } from "@loro-extended/change"
      const schema = Shape.doc({ title: Shape.text() })
      const doc = createTypedDoc(schema)
      div(() => { h1(doc.title.toString()) })
    `
    const result = transformSource(source, { target: "dom" })
    expect(result.code).toContain("textRegion")
    expect(result.code).not.toContain("subscribeMultiple")
  })
})
```

## Transitive Effect Analysis

### Package Dependency Graph

```
@loro-extended/reactive   (SNAPSHOT symbol, Snapshotable, Reactive<S,D>)
       ↓                         ↓
@loro-extended/change     @loro-extended/kinetic
  (typed refs impl,          (compiler + runtime)
   DocRef[REACTIVE] fix)
```

### Direct Dependencies

| Package | Files Modified | Nature of Change |
|---------|---------------|------------------|
| `reactive` | `src/index.ts` | New exports (`SNAPSHOT`, `Snapshotable`, `isSnapshotable`), modified `Reactive<S,D>`, updated `isReactive`, `LocalRef[SNAPSHOT]` |
| `change` | `src/typed-refs/base.ts` | `[SNAPSHOT]` base impl, `Reactive<S,D>` type params |
| `change` | `src/typed-refs/text-ref.ts` | `[SNAPSHOT]` override returning `string`, `Reactive<string, TextDelta>` |
| `change` | `src/typed-refs/counter-ref.ts` | `[SNAPSHOT]` override returning `number`, `Reactive<number, ReplaceDelta>` |
| `change` | `src/typed-refs/list-ref-base.ts` | `Reactive` type param update only (no `[SNAPSHOT]` override) |
| `change` | `src/typed-refs/doc-ref.ts` | `Reactive` type param update only (Phase 2); `[REACTIVE]` override to subscribe to `LoroDoc` (Phase 6) |
| `change` | `src/typed-refs/struct-ref.ts` | `Reactive` type param update only; Proxy `get`/`has` traps updated to handle `SNAPSHOT` symbol |
| `change` | `src/typed-refs/record-ref.ts` | `Reactive` type param update only |
| `change` | `src/typed-refs/tree-ref.ts` | `Reactive` type param update only |
| `change` | `src/plain-value-ref/types.ts` | `[SNAPSHOT]` on interface |
| `change` | `src/plain-value-ref/factory.ts` | `[SNAPSHOT]` implementation |
| `kinetic` | `src/runtime/text-patch.ts` | Use `[SNAPSHOT]` instead of `TextRefLike` cast |
| `kinetic` | `src/compiler/reactive-detection.ts` | `isWellKnownSymbolProperty` refactor, `isSnapshotableType`, `getSnapshotType` |
| `kinetic` | `src/compiler/analyze.ts` | `detectImplicitRead`, extended `analyzeExpression`, `extractDependencies` fix for reactive-typed property access results, dependency subsumption (Phase 6) |
| `kinetic` | `src/compiler/analyze.test.ts` | Updated test mocks for `Reactive<S, D>`, new `detectImplicitRead` tests |
| `kinetic` | `src/types.ts` | `Child` type widened (Phase 4) |

### Transitive Dependencies

- **`reactive-bridge.ts`** in `@loro-extended/change` — Used by `DocRef[REACTIVE]` override in Phase 6 (calls `translateEventBatch` on `LoroDoc` events). The bridge itself is not modified.
- **`@loro-extended/react`** — Uses `[REACTIVE]` for subscriptions in React hooks. Not affected unless it also wants to use `[SNAPSHOT]` (future consideration, out of scope).
- **`@loro-extended/hooks-core`** — Same as above; uses its own subscription model. Not affected.
- **`codegen/dom.ts`** — `generateReactiveContentSubscription` already dispatches on `isTextRegionContent` / single-dep / multi-dep. The `directReadSource` field it reads will now also be set for bare refs. The `source` field will contain `"doc.title.get()"` (synthesized), which is valid JavaScript. No changes to codegen needed.
- **`codegen/html.ts`** — HTML codegen for SSR uses `node.source` in template interpolation: `` _html += `${String(${node.source})}` ``. When `source` is synthesized as `"doc.title.get()"`, this evaluates correctly to a string. No changes needed.
- **`template.ts` / `walk.ts`** — Template extraction and walk planning operate on IR nodes. They read `source` for content values but don't interpret it. Not affected.
- **`ir.ts`** — `ContentValue.source` continues to hold a JS expression string. `directReadSource` continues to hold the ref path. No structural changes to IR types.
- **`packages/kinetic/src/loro/binding.ts`** — Uses ad-hoc `getValue` closures with Loro-specific discriminators (`isLoroText`, `isLoroCounter`). These operate at the raw Loro container level (post-`loro()` unwrap), not at the typed-ref level where `[SNAPSHOT]` lives. Not addressable by `[SNAPSHOT]`. No changes needed, but this remains an ad-hoc pattern.
- **`packages/kinetic/src/loro/edit-text.ts`** — Uses `ref.toString()` directly on `TextRef`. This is unaffected; `editText` operates on a known `TextRef` type, not at the `unknown` protocol boundary.
- **`@loro-extended/change` tests** — The `Reactive` generic parameter change from `Reactive<D>` to `Reactive<S, D>` will require updating any test that writes `implements Reactive<SomeDelta>` (if any exist in mocks).

### Breaking Change Assessment

The `Reactive<S, D>` signature change is **type-level breaking**. All sites are within packages we control:

| Affected Pattern | Count | Location | Migration |
|-----------------|-------|----------|-----------|
| `implements Reactive` (bare) | 1 | `TypedRef` base class | → `implements Reactive<unknown>` (defaults sufficient) |
| `implements Reactive<ReplaceDelta>` | 1 | `LocalRef` | → `Reactive<T, ReplaceDelta>` |
| `extends Reactive<TextDelta>` | 1 | Test mock `TextRef` | → `Reactive<string, TextDelta>` |
| `extends Reactive<ReplaceDelta>` | 1 | Test mock `CounterRef` | → `Reactive<number, ReplaceDelta>` |
| `extends Reactive<ListDelta>` | 1 | Test mock `ListRef` | → `Reactive<ListRef<T>, ListDelta>` |
| `extends Reactive<MapDelta>` | 1 | Test mock `StructRef` | → `Reactive<StructRef<T>, MapDelta>` |
| `interface Reactive<D>` definition | 1 | `reactive/src/index.ts` | → `Reactive<S, D>` |
| `interface Reactive<D>` mock | 1 | `analyze.test.ts` mock | → `Reactive<S, D>` |
| `Reactive<D>` in doc examples | ~3 | README, TECHNICAL.md | Update examples |
| `declare readonly [REACTIVE]` | 6 | All typed ref `declare` overrides | No change needed — `[REACTIVE]` type is independent of `S` |

**Total**: ~14 mechanical changes. Zero external consumers (experimental package, not published to npm with stability guarantees).

The `isReactive` behavioral change (requiring `[SNAPSHOT]`) is a **runtime breaking change** but is sequenced in Phase 2 Task 2.8, after all first-party types implement `[SNAPSHOT]`. No intermediate broken state.

The `DocRef[REACTIVE]` fix (Phase 6) changes runtime behavior from "throws" to "works correctly" — this is a bug fix, not a breaking change. Adding `[REACTIVE]` to the `TypedDoc` type is additive.

## Alternatives Considered

### Alternative A: Single symbol `[REACTIVE]` that returns both snapshot and subscribe

Combine snapshot and subscription into a single return value: `[REACTIVE] = (self) => ({ snapshot: S, subscribe: (cb) => unsub })`. Rejected because:
- Breaks all existing `[REACTIVE]` implementations
- The two operations have different usage patterns (snapshot is called once or on fallback; subscribe is called once with a long-lived callback)
- The compiler already has established detection for `[REACTIVE]` — adding a second symbol is additive

### Alternative B: `[UNWRAP]` symbol (simpler, just "get the display value")

A single `[UNWRAP]` symbol that returns the display string. Rejected because:
- It conflates "read the state" with "produce a string" — a counter's state is a `number`, not a `string`
- It doesn't express the algebraic relationship between snapshot and deltas
- It's too specific to the "content text" use case and doesn't generalize to lists, maps, etc.

### Alternative C: Make `S` a conditional type derived from `D`

Instead of a separate `S` parameter, derive `S` from `D`: `TextDelta → string`, `ListDelta → ListRefLike`, etc. Rejected because:
- The mapping is not intrinsic to the delta type — `ReplaceDelta` maps to `T` for `LocalRef<T>`, `number` for `CounterRef`, `T` for `PlainValueRef<T>`. The snapshot type is determined by the implementor, not the delta kind.
- It would require a type-level lookup table, which is fragile and not extensible for custom reactive types.

### Alternative D: Keep `Reactive<D>` with one parameter, add `Snapshotable<S>` as separate interface

`Reactive<D>` stays unchanged; `Snapshotable<S>` is a sibling interface. Types implement both: `class TextRef implements Reactive<TextDelta>, Snapshotable<string>`. Zero breaking changes. Rejected because:
- The two interfaces are semantically coupled (they form a Moore machine together) but structurally independent. A type could implement `Snapshotable` without `Reactive` or vice versa — this is a representable but meaningless state.
- The compiler would need to check for both symbols independently rather than extracting both type parameters from a single interface.
- For an experimental framework seeking mathematical elegance, encoding the Moore machine as a single `Reactive<S, D>` is the correct algebra. Backward compatibility is not a constraint.

## Resources for Implementation

### Files to Create
- None (all changes are to existing files)

### Files to Modify (by phase)

**Phase 1:**
- `packages/reactive/src/index.ts` — `SNAPSHOT`, `SnapshotFn`, `Snapshotable`, `isSnapshotable`, `Reactive<S,D>`, `LocalRef[SNAPSHOT]` (note: `isReactive` NOT tightened here)
- `packages/reactive/src/index.test.ts` — new tests

**Phase 2:** (✅ completed)
- `packages/change/src/typed-refs/base.ts` — `[SNAPSHOT]` default on `TypedRef`, `implements Reactive<unknown, ReactiveDelta>`, `[REACTIVE]` type narrowed to `ReactiveSubscribe<ReactiveDelta>`
- `packages/change/src/typed-refs/text-ref.ts` — `[SNAPSHOT]` override returning `string`
- `packages/change/src/typed-refs/counter-ref.ts` — `[SNAPSHOT]` override returning `number`
- `packages/change/src/typed-refs/struct-ref.ts` — Proxy `get` and `has` traps updated to handle `SNAPSHOT` symbol; `[SNAPSHOT]: SnapshotFn<unknown>` added to `StructRef` type alias
- `packages/change/src/shape.ts` — `[REACTIVE]` and `[SNAPSHOT]` added to `TreeRefInterface` (fixes pre-existing type error)
- `packages/change/src/plain-value-ref/types.ts` — `[SNAPSHOT]: SnapshotFn<T>` added to `PlainValueRef<T>` interface
- `packages/change/src/plain-value-ref/factory.ts` — `[SNAPSHOT]` implementation via closure-captured `getValue()`
- `packages/reactive/src/index.ts` — `isReactive` tightened to require both `[REACTIVE]` and `[SNAPSHOT]`
- `packages/reactive/src/index.test.ts` — existing `isReactive` tests updated; new tightened-guard tests added
- `packages/change/src/typed-refs/reactive.test.ts` — 29 new tests covering `[SNAPSHOT]` on every ref type
- **Not modified** (no changes needed): `list-ref-base.ts`, `doc-ref.ts`, `record-ref.ts`, `tree-ref.ts` — these inherit `[SNAPSHOT]` from `TypedRef` base class and their `declare readonly [REACTIVE]` narrowing was already correct

**Phase 3:**
- `packages/kinetic/src/runtime/text-patch.ts` — `textRegion`, `inputTextRegion`
- `packages/kinetic/src/runtime/subscribe.ts` — verify, likely no changes

**Phase 4:**
- `packages/kinetic/src/compiler/reactive-detection.ts` — `isWellKnownSymbolProperty` refactor, `isSnapshotableType`, `getSnapshotType`
- `packages/kinetic/src/compiler/analyze.ts` — `detectImplicitRead`, `analyzeExpression`, `extractDependencies` fix for reactive-typed property access results
- `packages/kinetic/src/types.ts` — `Child` type widened
- `packages/kinetic/src/compiler/analyze.test.ts` — updated mocks, new tests including `extractDependencies` fix tests
- `packages/kinetic/src/compiler/transform.test.ts` — new end-to-end tests

**Phase 5:**
- `packages/reactive/README.md`
- `packages/kinetic/TECHNICAL.md`
- `packages/kinetic/README.md`
- `packages/change/TECHNICAL.md`

**Phase 6:**
- `packages/change/src/typed-refs/doc-ref.ts` — override `[REACTIVE]` to subscribe to `LoroDoc`
- `packages/change/src/typed-refs/doc-ref-internals.ts` — may need accessor for `LoroDoc` if not already exposed (note: `getDoc()` is already available via `BaseRefInternals`)
- `packages/change/src/typed-doc.ts` — add both `[REACTIVE]: ReactiveSubscribe<MapDelta>` and `[SNAPSHOT]: SnapshotFn<unknown>` to `TypedDoc` type alias
- `packages/kinetic/src/compiler/analyze.ts` — dependency subsumption rule in `extractDependencies`
- `packages/kinetic/src/compiler/analyze.test.ts` — subsumption tests
- `packages/kinetic/src/compiler/transform.test.ts` — end-to-end test with `TypedDoc` as reactive
- `packages/change/src/typed-refs/reactive.test.ts` — `DocRef[REACTIVE]` subscription tests

### Files for Reference (read, not modify)
- `packages/kinetic/src/compiler/codegen/dom.ts` — understand `generateReactiveContentSubscription` dispatch
- `packages/kinetic/src/compiler/codegen/html.ts` — understand SSR content generation and `String(${node.source})` pattern
- `packages/kinetic/src/compiler/ir.ts` — `ContentValue`, `Dependency`, `isTextRegionContent` (the `dependencies.length === 1` check is load-bearing for the subsumption rule)
- `packages/kinetic/src/runtime/regions.ts` — `listRegion` and `ListRefLike` (left unchanged)
- `packages/kinetic/src/loro/binding.ts` — ad-hoc `getValue` closures at Loro container level (not addressable by `[SNAPSHOT]`)
- `packages/kinetic/ideas/incremental-view-maintenance.md` — future direction context
- `.plans/narrow-reactive-delta-types.md` — precedent for `declare` override pattern
- `.plans/kinetic-reactive-primitive.md` — original `[REACTIVE]` protocol design
- `packages/change/src/typed-refs/proxy-handlers.ts` — `RecordRef`'s proxy uses `Reflect.get` fallthrough (no explicit symbol interception needed, unlike `StructRef`)
- `packages/change/src/reactive-bridge.ts` — `translateEventBatch` is reused by `DocRef[REACTIVE]` override in Phase 6

### Critical Implementation Detail: Source Rewriting for Bare Refs

When `analyzeExpression` encounters a bare reactive ref like `doc.title` (no `.get()` call), it must rewrite the IR's `source` field so that generated code produces a value, not a ref object. The rewriting rule:

- IR `source`: `"doc.title.get()"` — synthesize a `.get()` call, which every scalar ref already implements
- IR `directReadSource`: `"doc.title"` — the ref itself, passed to `textRegion`

**Why `.get()` and not `[SNAPSHOT]()`:** The `textRegion` path doesn't use `source` — it passes `directReadSource` directly, and `textRegion` calls `[SNAPSHOT]` internally. For the `subscribeWithValue` fallback path, codegen emits `subscribeWithValue(dep, () => source, callback, scope)` where `source` must be valid JavaScript. Synthesizing `"doc.title.get()"` works because `.get()` exists on every scalar ref. Synthesizing `"doc.title[SNAPSHOT](doc.title)"` would require importing `SNAPSHOT` from `@loro-extended/reactive` in the generated code — a new import pattern from a different package that adds complexity for no benefit.

For the HTML/SSR codegen path, `source` is interpolated directly: `` _html += `${String(${node.source})}` ``. `"doc.title.get()"` evaluates correctly.

## Learnings

### Synthesize `.get()` in codegen, not `[SNAPSHOT]()`

The `[SNAPSHOT]` protocol serves two distinct roles:
1. **Compiler detection** — the presence of `[SNAPSHOT]` tells the compiler "this type has a readable state" and carries the return type `S`
2. **Runtime access** — `textRegion` and `inputTextRegion` call `ref[SNAPSHOT](ref)` to read initial state

For **generated code** (the output of compilation), neither role requires emitting `[SNAPSHOT]` calls. The compiler already knows the type is snapshotable, and every scalar ref has `.get()` which does the same thing. Emitting `.get()` keeps generated code readable, avoids a new import from `@loro-extended/reactive`, and is idiomatic with the existing codebase.

### `detectDirectRead` and `detectImplicitRead` are complementary, not nested

`detectDirectRead` answers: "Is this expression a `.get()` or `.toString()` call on a reactive ref?" (structural: root AST node is a `CallExpression`).

`detectImplicitRead` answers: "Is this expression a bare reactive ref with `[SNAPSHOT]`?" (type-level: expression *is* the ref, not a call on it).

These are structurally different questions. Combining them into one function would violate single-responsibility. `analyzeExpression` calls both: `detectDirectRead(expr) ?? detectImplicitRead(expr)`.

### `listRegion` does not benefit from `[SNAPSHOT]`

The `ListRefLike<T>` interface is a **structural contract for the functional-core planning functions** (`planInitialRender`, `planDeltaOps`). These functions need `{ length: number; get(i: number): T }` — a typed interface for their pure logic. Replacing the cast with `[SNAPSHOT]` would return `self` (since list IS its own snapshot), then still need a cast to `ListRefLike<T>` for the planning functions. This adds a function call indirection for zero benefit.

### `binding.ts` operates at the wrong level for `[SNAPSHOT]`

The Loro binding functions (`bindTextValue`, `bindChecked`, `bindNumericValue`) in `packages/kinetic/src/loro/binding.ts` use `loro()` to unwrap typed refs into raw Loro containers, then use Loro-specific discriminators (`isLoroText`, `isLoroCounter`) at the container level. `[SNAPSHOT]` operates at the typed-ref level — after the `loro()` unwrap, the ref's symbol properties are gone. This is a fundamentally different abstraction layer and is not addressable by this plan.

### `isReactive` must not be tightened before all implementors have `[SNAPSHOT]`

The original plan had `isReactive` tightened in Phase 1 (Task 1.4). This would immediately break all typed refs from `@loro-extended/change` and the Kinetic runtime's `subscribe()` function, which gates on `isReactive()`. The fix: defer the tightening to Phase 2 Task 2.8, after all refs have both symbols. No temporary relaxation of `subscribe()` is needed — `isReactive` simply continues checking only `[REACTIVE]` until Phase 2 completes.

### `StructRef`'s Proxy explicitly intercepts symbol access

`StructRef` is implemented as a `Proxy` around `StructRefImpl`. Unlike `RecordRef` (whose proxy uses `Reflect.get` fallthrough for known properties), `StructRef`'s proxy `get` trap explicitly handles `REACTIVE` — it creates a fresh subscribe function closure when `prop === REACTIVE`. The `has` trap also explicitly lists `REACTIVE`. Adding `[SNAPSHOT]` to the `TypedRef` base class won't automatically be visible on `StructRef` — the Proxy's `get` and `has` traps must also be updated to handle `SNAPSHOT`. `RecordRef`, `DocRef`/`TypedDoc`, and all other typed refs don't have this problem because their proxies (if any) use `Reflect.get`/`Reflect.has` fallthrough.

### `extractDependencies` misses reactive-typed property access results

`extractDependencies` has three cases in its visitor:
1. PropertyAccess on reactive object → captures the object (e.g., `doc.title.get()` → captures `doc.title`)
2. Call on reactive object → captures the callee's receiver
3. Identifier that is reactive → captures itself

Missing case: **PropertyAccess whose *result type* is reactive**. When `doc.title` has type `TextRef` (reactive) but `doc` has type `TypedDoc<Shape>` (NOT reactive), none of the three cases fire — the PropertyAccess handler checks the *object* (`doc`), not the *result* (`doc.title`). The Identifier handler skips `title` because it's a property name in the PropertyAccess. Result: zero dependencies captured.

This is a pre-existing bug (not caused by this plan). Today, `p(doc.title)` compiles as reactive content with zero dependencies — no subscription is generated, so the value is set once and never updates. The fix (Phase 4 Task 4.4) adds a second check to the PropertyAccess handler: if the result type of the expression is reactive, capture the whole expression as a dependency.

### `DocRef[REACTIVE]` is broken and `TypedDoc` hides it

`DocRef` inherits `[REACTIVE]` from `TypedRef`, but the base class implementation calls `ref[INTERNAL_SYMBOL].getContainer()`. `DocRef`'s container getter is `() => { throw new Error("can't get container on DocRef") }`, so calling `doc[REACTIVE](doc, callback)` throws at runtime.

The `TypedDoc<Shape>` type alias omits `[REACTIVE]`, so the compiler can't detect docs as reactive. At runtime, `REACTIVE in doc` is `true` (via `Reflect.get` passthrough in the TypedDoc Proxy to the underlying `DocRef`), but the function throws when called.

Both are bugs. A document is unambiguously a Moore machine: `Reactive<TypedDoc<Shape>, MapDelta>`. The snapshot is the ref surface itself (identity, consistent with how all collection types work), and the delta is a `MapDelta` describing which root keys changed. The `LoroDoc.subscribe()` API provides per-container event batches with `path` fields identifying the root key, which can be translated to `MapDelta` via `translateEventBatch`.

Phase 6 fixes this: override `[REACTIVE]` on `DocRef` to subscribe to `LoroDoc` directly, expose `[REACTIVE]` on the `TypedDoc` type alias, and add dependency subsumption to `extractDependencies`.

### Dependency subsumption: child deps make parent deps redundant

When `TypedDoc` exposes `[REACTIVE]`, `extractDependencies` for `doc.title.toString()` captures both `doc.title` (TextRef, deltaKind `"text"`) and `doc` (TypedDoc, deltaKind `"map"`). The `isTextRegionContent` check requires `dependencies.length === 1`, so the presence of `doc` as a second dependency degrades the expression from `textRegion` (O(k) surgical) to `subscribeMultiple` (O(n) full replacement).

The fix is a subsumption rule: after collecting all dependencies, filter out any dependency whose source is a strict prefix of another dependency's source. If you're subscribing to `doc.title` (character-level text deltas), subscribing to `doc` (key-level map deltas) is strictly redundant — the child subscription is sufficient and more precise. The rule: "a dependency subsumes its parent."

### `PlainValueRef` deltas omit `origin`

`PlainValueRef`'s `[REACTIVE]` implementation in `buildBasePlainValueRef` subscribes to the raw Loro container and emits a hardcoded `{ type: "replace" }` without `origin`. Unlike `TypedRef`'s base implementation (which calls `translateEventBatch` to propagate `origin`), `PlainValueRef` never has `origin: "local"` or `origin: "import"`. This means `inputTextRegion`-like origin-driven dispatch would not work correctly for `PlainValueRef`-bound inputs. This is not a blocker for this plan but is noted for future reference.

### `Reactive` default `D` is `ReplaceDelta`, not `ReactiveDelta`

The `Reactive<S, D>` interface defaults are `S = unknown, D = ReplaceDelta`. Writing `implements Reactive` (no type arguments) expands to `implements Reactive<unknown, ReplaceDelta>`, which constrains `[REACTIVE]` to `ReactiveSubscribe<ReplaceDelta>`. For `TypedRef`, this is wrong — subclasses emit text, list, map, and tree deltas through the inherited `[REACTIVE]`. The correct base type is `implements Reactive<unknown, ReactiveDelta>`, using the full union. The default `ReplaceDelta` is intentional for _leaf_ types (it means "I don't specify what I emit" = conservative fallback), but a _base class_ that must accept all delta kinds needs the explicit wider type.

### `declare` vs concrete property for symbol overrides

The `declare` keyword on a class property tells TypeScript "this property will have this type at runtime, but don't emit any code for it." It's used when the parent class provides the runtime value and the subclass just wants to narrow the type (e.g., `declare readonly [REACTIVE]: ReactiveSubscribe<TextDelta>` on `TextRef` narrows the base `ReactiveSubscribe<ReactiveDelta>`).

When a subclass needs to provide **both** a new runtime value **and** a narrowed type, a concrete property definition suffices: `readonly [SNAPSHOT]: SnapshotFn<string> = (self) => ...`. TypeScript infers the type from the initializer, and the property initializer runs after `super()` in the constructor, shadowing the parent's value. Using both `declare` and a concrete definition on the same property would be a conflict — the `declare` is unnecessary and should be omitted.

### `TreeRefInterface` required `[REACTIVE]` and `[SNAPSHOT]`

`TreeRefInterface` in `shape.ts` is the type-level contract used by `TreeContainerShape`. The `TreeRef` _class_ had `[REACTIVE]` via `TypedRef`, but `TreeRefInterface` only declared `[LORO_SYMBOL]`. This meant `TreeRefInterface`-typed values (e.g., `doc.tree` resolved through the shape system) could not be indexed by `[REACTIVE]` or `[SNAPSHOT]` — producing a `TS7053` error. This was a pre-existing bug, fixed in Phase 2 by adding both symbols to the interface. Any similar interface-level contracts for typed refs should declare both protocol symbols.

### Test mocks define their own `Reactive` interface — must be updated for two-parameter form

The compiler test suite in `analyze.test.ts` creates a mock `reactive-base.d.ts` file with its own `Reactive<D>` interface (one parameter). This mock does NOT import from `@loro-extended/reactive` — it's a self-contained type stub used by the ts-morph Project. After Phase 1 changed the real `Reactive` to `Reactive<S, D>`, the mock's one-parameter form still works for `isReactiveType` (which does property-level scanning for `[REACTIVE]`, not structural assignability checks). However, Phase 4 introduces `isSnapshotableType` which scans for `[SNAPSHOT]`. If the mock types lack `[SNAPSHOT]`, `detectImplicitRead` won't fire for bare-ref tests. Task 4.11 must update the mock to: (a) export `SNAPSHOT`, (b) add `[SNAPSHOT]` to the mock `Reactive` interface, (c) add `[SNAPSHOT]` to each mock ref interface.

### Proxy `has` trap must intercept protocol symbols

Adding a protocol symbol to a Proxy's `get` trap is not sufficient — the `has` trap must also handle it. `isReactive()` and `isSnapshotable()` use the `in` operator (`SNAPSHOT in value`), which invokes the `has` trap, not `get`. If `has` doesn't return `true` for `SNAPSHOT`, the type guard fails even though `get` would return the correct function. This applies specifically to `StructRef`'s Proxy (the only typed ref with explicit symbol interception); other proxied types use `Reflect.has` fallthrough.

### `isReactive(doc)` is true at runtime after Phase 2, but calling `[REACTIVE]` still throws

After Phase 2, the TypedDoc Proxy's `has` trap falls through via `Reflect.has` to the underlying `DocRef`, which now has both `[REACTIVE]` and `[SNAPSHOT]` from `TypedRef`. So `isReactive(doc)` returns `true`. However, calling `doc[REACTIVE](doc, cb)` still throws because the _inherited_ `[REACTIVE]` implementation calls `getContainer()`, which is `() => { throw ... }` for `DocRef`. This is a "type says yes, value says no" inconsistency — a latent bug that Phase 6 Task 6.1 fixes by overriding `[REACTIVE]` on `DocRef`.

### `TypedDoc` type must expose `[SNAPSHOT]` alongside `[REACTIVE]`

The original plan's Phase 6 Task 6.2 only mentioned adding `[REACTIVE]` to the `TypedDoc<Shape>` type alias. But after Phase 2 tightened `isReactive` to require both symbols, and Phase 4 introduces `isSnapshotableType` for compiler detection, the `TypedDoc` type must also expose `[SNAPSHOT]`. Without it, `isSnapshotableType(typedDocType)` would return false, and `detectImplicitRead` would not fire for bare doc refs. Task 6.2 has been updated to include both symbols.

### `expressionIsReactive` already handles bare refs — no changes needed

When implementing Phase 4, we confirmed that `expressionIsReactive` already returns `true` for a bare reactive ref like `doc.title` (a `TextRef` in content position). It checks `isReactiveType(expr.getType())` as its very first test, which catches any expression whose *result type* is reactive — including bare property access expressions. This means the only missing piece for bare-ref support was the *handling* path in `analyzeExpression`, not the *detection* path. The pre-existing `expressionIsReactive` → `extractDependencies` → `detectDirectRead` pipeline classified bare refs as reactive content with dependencies but without `directReadSource`, causing `isTextRegionContent` to fail. The fix was adding `detectImplicitRead` as a second fallback in `analyzeExpression`, not modifying `expressionIsReactive`.

### `extractDependencies` result-type fix has a subtle interaction with deduplication

The fix to `extractDependencies` (Task 4.4) adds a second check in the `PropertyAccessExpression` handler: if the *result type* is reactive, capture the whole expression. This interacts safely with the existing object-type check via `depsMap` deduplication. When `title.get()` is visited, the `CallExpression` handler captures `title` (the callee's receiver), and the `PropertyAccessExpression` handler for `title.get` would also try to capture `title` (the result of `title` PropertyAccess is `TextRef`, which is reactive). But `depsMap` uses source text as the key, so `"title"` is captured only once. The result-type check fires harmlessly on expressions that are already captured by the object-type check. The only case where it *uniquely* contributes is `doc.title` where `doc` is not reactive but `doc.title` is — exactly the bug scenario.

### `isWellKnownSymbolProperty` parameterization is straightforward but the three layers matter

The refactoring from `isReactiveSymbolProperty` to `isWellKnownSymbolProperty(sym, symbolForKey, declarationName, mangledPrefix)` was mechanical — all three detection layers (Symbol.for tracing, declaration name, mangled prefix) became parameters. The key insight is that **all three layers are necessary** even for `SNAPSHOT`:

1. **Symbol.for tracing** works in source `.ts` files where the `SNAPSHOT = Symbol.for("kinetic:snapshot")` initializer is visible to the compiler.
2. **Declaration name** works in `.d.ts` files (built packages) where the initializer is erased but the `unique symbol` type still references the `SNAPSHOT` variable.
3. **Mangled prefix** (`__@SNAPSHOT@`) is the last-resort fallback for edge cases where the type system loses the symbol reference chain.

Without all three, detection would fail in specific build/consumption patterns. The mock `.d.ts` files in `analyze.test.ts` exercise layer 2 specifically (they declare `const SNAPSHOT: unique symbol` without an initializer).

### `detectImplicitRead` checks `isSnapshotableType` separately from `isReactiveType` — this matters for forward compatibility

`detectImplicitRead` requires *both* `isReactiveType` (has `[REACTIVE]`) and `isSnapshotableType` (has `[SNAPSHOT]`). Today this is redundant — `isReactive()` at runtime already requires both symbols, so any type with `[REACTIVE]` also has `[SNAPSHOT]`. But the compiler's `isReactiveType` only checks for `[REACTIVE]` (it was written before `[SNAPSHOT]` existed). The explicit `isSnapshotableType` check in `detectImplicitRead` is a correctness guard: it ensures the compiler only synthesizes `.get()` for types that genuinely have a snapshot protocol. If a future type had `[REACTIVE]` but not `[SNAPSHOT]` (e.g., a write-only channel), `detectImplicitRead` would correctly reject it. This forward-compatible separation also means `isReactiveType` in the compiler does *not* need to be tightened to match the runtime's `isReactive` — each detection function checks exactly what it needs.

### The `Child` type widening is safe because the compiler, not TypeScript, resolves content

Adding `Reactive<any, any>` to the `Child` type union might seem dangerous — it makes `p(doc.title)` type-check even though the DOM runtime expects a string, not a `TextRef`. But this is safe because the Kinetic compiler intercepts the call before runtime. The compiler's `analyzeExpression` detects the bare reactive ref, synthesizes `.get()` in the IR, and emits either `textRegion(node, ref, scope)` or `subscribeWithValue(ref, () => ref.get(), setter, scope)`. The generated code never passes the raw ref to `textContent`. The `Child` type exists only for TypeScript's benefit during authoring — it tells the language server "yes, this is a valid child expression." The actual semantics are determined by the compiler's analysis, not by TypeScript's type system.

## Changeset

```
---
"@loro-extended/reactive": minor
"@loro-extended/change": minor
"@loro-extended/kinetic": minor
---

### SNAPSHOT protocol — completing the reactive observation algebra

**@loro-extended/reactive:**
- New `SNAPSHOT` symbol (`Symbol.for("kinetic:snapshot")`) for protocol-level state observation
- New `SnapshotFn<S>` type and `Snapshotable<S>` interface
- New `isSnapshotable()` type guard
- `Reactive` interface updated from `Reactive<D>` to `Reactive<S, D>` — encodes the complete Moore machine (snapshot + subscribe)
- `isReactive()` now requires both `[REACTIVE]` and `[SNAPSHOT]`
- `LocalRef<T>` implements `Reactive<T, ReplaceDelta>` with `[SNAPSHOT]` returning current value

**@loro-extended/change:**
- Scalar typed refs implement `[SNAPSHOT]`:
  - `TextRef` → returns `string`
  - `CounterRef` → returns `number`
  - `PlainValueRef<T>` → returns `T`
- All typed refs updated to `Reactive<S, D>` type parameters
- Collection types (`ListRef`, `StructRef`, etc.) inherit base `[SNAPSHOT]` (identity) but no narrowed override
- `StructRef` Proxy traps updated to handle `SNAPSHOT` symbol
- `TreeRefInterface` now declares `[REACTIVE]` and `[SNAPSHOT]` (fixes pre-existing type error)
- `DocRef[REACTIVE]` fixed: overridden to subscribe to `LoroDoc` directly instead of calling `getContainer()` (which threw)
- `TypedDoc<Shape>` type now exposes `[REACTIVE]: ReactiveSubscribe<MapDelta>` and `[SNAPSHOT]: SnapshotFn<unknown>`

**@loro-extended/kinetic:**
- Runtime `textRegion`/`inputTextRegion` use `[SNAPSHOT]` protocol instead of ad-hoc `TextRefLike` cast
- Compiler symbol detection refactored: `isWellKnownSymbolProperty` parameterized for reuse
- Compiler detects `[SNAPSHOT]` and supports bare reactive refs in content position:
  `p(doc.title)` compiles to `textRegion` with O(k) surgical patching
- New `detectImplicitRead` function for bare-ref detection (separate from `detectDirectRead`)
- `extractDependencies` fixed: captures reactive-typed property access results (e.g., `doc.title` where `doc: TypedDoc` is not reactive but result is `TextRef`)
- Dependency subsumption: child deps (`doc.title`) make parent deps (`doc`) redundant
- `Child` type widened to accept `Reactive<any, any>` values
- Explicit `.get()` / `.toString()` calls continue to work (backward compatible)
```
