# Schema Internal Cleanup & Gap-Filling

## Background

The `packages/schema` spike is feature-complete as an isolated proof of the Schema Interpreter Algebra described in `theory/interpreter-algebra.md`. It has 397 passing tests, four interpreters, a composition combinator system, and a self-contained example mini-app. The spike validates every conjecture from the theory document.

However, an engineering review reveals several internal structural issues, redundant code, and one behavioral gap that should be resolved before integration work begins (Phases 1–6 in the theory doc's §11). These are not design problems — the architecture is sound — but rather cleanup from the spike's rapid, exploratory development.

## Problem Statement

1. **Cross-cutting store utilities live in `writable.ts`.** Three interpreters (`plain`, `validate`, `with-changefeed`) import `readByPath` from `writable.ts`. The changefeed decorator also imports `applyChangeToStore` and the `Store` type from there. This creates a logical dependency where read-only and observation code depends on the mutation module. The public barrel (`index.ts`) re-exports `readByPath` under "Store utilities" from `./interpreters/writable.js` — confusing provenance for a shared utility.

2. **Sum dispatch in the writable interpreter is static.** `writableInterpreter.sum()` always picks the first variant regardless of the runtime value in the store. For discriminated sums it should read the discriminant; for positional sums (including nullable) it should inspect the actual value. The `validateInterpreter.sum()` already does this correctly — the writable interpreter just hasn't caught up.

3. **The null-object guard `obj !== null && obj !== undefined && typeof obj === "object"` is repeated ~12 times** across `writable.ts` (4×), `plain.ts` (2×), `validate.ts` (4×), `with-changefeed.ts` (1×), `zero.ts` (1×), `combinators.ts` (1×), and tests (2×). A shared type-narrowing utility eliminates this noise.

4. **The nullable detection pattern is duplicated.** The "is this a nullable sum?" check (2 variants, first is `scalar("null")`) exists as a private `isNullableSum()` in `validate.ts` and as inline code in `describe.ts`. The writable interpreter's sum dispatch (Phase 3) will need it too.

5. **`interpreters/zero.ts` is entirely redundant.** The 140-line zero interpreter duplicates the logic of `Zero.structural()` from `zero.ts` — same scalar defaults, same annotation defaults, same first-variant-for-sums logic. It exists solely to prove that "deriving defaults is just an algebra over the schema functor," but that proof is conceptual (documented in the theory) and the runtime artifact adds nothing. `zeroInterpreter` is never used in production code — only in equivalence tests and as a convenient base in combinator tests (which can use `createInterpreter` instead). Keeping it means maintaining duplicated `annotationDefault` functions in two files with no signal that they must stay in sync.

6. **Theory doc §14.7 is stale.** It says "The `@loro-extended/schema` package is empty" — this was true when the theory doc was written but the spike has since filled the package with ~2500 lines of source and 397 tests.

7. **TECHNICAL.md test count is stale.** The "Verified Properties" section says "386 tests" but the current suite has 397 (and will change again after this work).

## Success Criteria

- `readByPath`, `writeByPath`, `applyChangeToStore`, `segKey`, and `Store` live in their own `src/store.ts` module with no writable-interpreter-specific imports
- A shared `isNonNullObject(v): v is Record<string, unknown>` utility exists and replaces all inline null-object guards
- `isNullableSum` is exported from `schema.ts` alongside `isAnnotated` and `unwrapAnnotation`
- `interpreters/zero.ts` is deleted; `zeroInterpreter` is removed from the public API
- All existing importers (`writable.ts`, `plain.ts`, `validate.ts`, `with-changefeed.ts`, `index.ts`) import from the correct new locations
- The writable interpreter dispatches discriminated sums by reading the discriminant from the store, and handles positional sums (including nullable) by inspecting the runtime value
- New tests cover writable sum dispatch (discriminated, positional, nullable)
- Tests that previously used `zeroInterpreter` are updated or removed
- Theory doc §14.7 reflects reality
- TECHNICAL.md test count is accurate after all changes
- `describe()` output unchanged, example mini-app unchanged

## Gap

- `readByPath`, `writeByPath`, `applyChangeToStore`, `segKey`, `Store` are defined in `writable.ts` (L53–127) but consumed by `plain.ts`, `validate.ts`, and `with-changefeed.ts`
- No shared `isNonNullObject` utility; the guard is inlined ~12 times
- `isNullableSum` is private to `validate.ts`; `describe.ts` reimplements it inline
- `interpreters/zero.ts` duplicates `zero.ts` logic, including a private `annotationDefault` that must stay in sync manually
- `writableInterpreter.sum()` (L753–771) ignores runtime store state — always returns the first variant
- `theory/interpreter-algebra.md` §14.7 (L1094–1101) is factually incorrect
- `TECHNICAL.md` "Verified Properties" section (L289) says "386 tests"

## Phases

### Phase 1: Extract shared utilities ✅

#### Extract `store.ts`

- Task: Create `src/store.ts` containing `Store` type, `segKey`, `readByPath`, `writeByPath`, `applyChangeToStore` — moved verbatim from `writable.ts` L53–127. The only imports `store.ts` needs from outside itself are `Path` from `interpret.ts`, `ChangeBase` from `change.ts`, and `step` from `step.ts`. ✅
- Task: Update `writable.ts` to import `Store`, `readByPath`, `writeByPath`, `applyChangeToStore` from `../store.js` and remove the local definitions. Keep re-exporting `readByPath` for backward compat of any downstream code. ✅
- Task: Update `plain.ts` to import `readByPath` from `../store.js` instead of `./writable.js`. ✅
- Task: Update `validate.ts` to import `readByPath` from `../store.js` instead of `./writable.js`. ✅
- Task: Update `with-changefeed.ts` to import `readByPath`, `applyChangeToStore`, `Store` from `../store.js` instead of `./writable.js`. The type-only imports (`WritableContext`, `PendingChange`) remain from `./writable.js`. ✅
- Task: Update `index.ts` barrel to export `readByPath` from `./store.js` instead of `./interpreters/writable.js`. Also export `Store`, `writeByPath`, `applyChangeToStore` from `./store.js` for completeness. ✅

#### Add `isNonNullObject` guard

- Task: Add to `store.ts` a type-narrowing utility: ✅

  ```ts
  function isNonNullObject(value: unknown): value is Record<string, unknown>
  ```

  Returns `true` when `value` is non-null, non-undefined, and `typeof value === "object"`. Does NOT exclude arrays — callers that need "plain object" semantics add `&& !Array.isArray(value)` themselves (this keeps the guard maximally reusable, since the writable/plain/changefeed call sites don't care about arrays).

- Task: Replace all ~12 inline `obj !== null && obj !== undefined && typeof obj === "object"` / `obj === null || obj === undefined || typeof obj !== "object"` sites in `writable.ts`, `plain.ts`, `validate.ts`, `with-changefeed.ts`, `combinators.ts`, and `zero.ts`. ✅
- Task: Export `isNonNullObject` from `index.ts`. ✅

#### Extract `isNullableSum` to `schema.ts`

- Task: Move `isNullableSum` from `validate.ts` to `schema.ts`, exported alongside `isAnnotated` and `unwrapAnnotation`. Signature: ✅

  ```ts
  function isNullableSum(schema: PositionalSumSchema): boolean
  ```

- Task: Update `validate.ts` to import `isNullableSum` from `../schema.js`. ✅
- Task: Update `describe.ts` to use the imported `isNullableSum` instead of its inline check (L166–169). ✅

#### Run regression

- Task: Run full test suite — all 397 tests pass with no modifications. ✅

### Phase 2: Delete zero interpreter ✅

- Task: Delete `src/interpreters/zero.ts`. ✅
- Task: Remove the `zeroInterpreter` export from `src/index.ts`. ✅
- Task: Update `interpret.test.ts`: ✅
  - Delete the entire `interpret: zero equivalence` describe block (4 tests that compare `zeroInterpreter` output to `Zero.structural`). The equivalence was a proof-of-concept demonstration; `Zero.structural` is the canonical implementation.
  - Delete the `interpret: LoroSchema zero equivalence for annotations` describe block (1 test). Same rationale.
  - Update the two `interpret: enrich combinator` tests that use `zeroInterpreter` as a base. Replaced with a shared `objectInterpreter` via `createInterpreter` that produces objects at every node for `enrich` to operate on.
- Task: Update `TECHNICAL.md` file map to remove `interpreters/zero.ts` entry. Also added `guards.ts` and `store.ts` entries (from Phase 1). ✅
- Task: Update combinator doc comments in `combinators.ts` that reference `zeroInterpreter` — replaced with hypothetical examples (`pathInterpreter`, `fallbackInterpreter`). ✅
- Task: Run full test suite. Net test count decreased by 5 (397 → 392). ✅

### Phase 3: Writable sum dispatch from store ✅

- Task: Implement runtime-aware `sum()` in `writableInterpreter`: ✅
  - **Discriminated sum:** Read `readByPath(ctx.store, path)`, extract the discriminant value from the object, dispatch to `variants.byKey(discValue)`. If the value is missing or the discriminant is not a known key, fall back to the first variant (preserving current behavior as the degenerate case).
  - **Positional sum (nullable):** Read the value from the store. Use `isNullableSum` (now imported from `schema.ts`). For nullable sums, return `variants.byIndex(0)` when the value is `null`/`undefined`, else `variants.byIndex(1)`. For general positional sums, return `variants.byIndex(0)` as a fallback (no runtime type discrimination is possible without backend-specific knowledge).
- Task: Add tests in `writable.test.ts` (6 new tests, 398 total): ✅
  - Discriminated sum writable ref dispatches to the correct variant based on store state
  - Discriminated sum falls back to first variant when discriminant is missing
  - Discriminated sum falls back to first variant when store value is not an object
  - Nullable field returns a scalar ref with `.get()` returning `null` when store value is null
  - Nullable field returns the inner writable ref (e.g. `ScalarRef<string>`) when store value is non-null
  - Mutation on the inner ref of a nullable works (set a value, read it back)
- Task: Type-level tests deferred — `Writable<PositionalSumSchema>` and `Writable<DiscriminatedSumSchema>` both map to `unknown`, which is correct for runtime-dispatched sums. No meaningful type-level assertion beyond `unknown`. ✅

### Phase 4: Documentation updates ✅

- Task: Update `theory/interpreter-algebra.md` §14.7 (L1094–1101): replaced "package is empty" with description of the implemented spike, kept observation about `@loro-extended/change` shape coupling. ✅
- Task: Update `TECHNICAL.md` "Verified Properties" section test count to 398. Removed stale zeroInterpreter item (#5), added deep subscriptions (#7), discriminated sum dispatch (#13), nullable dispatch (#14). ✅
- Task: Update `TECHNICAL.md` "Writable Interpreter" section: added "Sum nodes" paragraph documenting discriminated, nullable, and general positional dispatch behavior. ✅
- Task: `TECHNICAL.md` "Architecture" section updates for `store.ts`, `guards.ts`, and zero interpreter removal were already applied in Phase 2 (file map and interpreter table). ✅

## Tests

All tests live in existing test files — no new test files needed.

**Phase 1** — zero new tests; the existing 397 tests serve as the regression suite for the purely mechanical extractions and guard replacements.

**Phase 2** — net reduction of 5 tests:
- Delete 4 `interpret: zero equivalence` tests
- Delete 1 `interpret: LoroSchema zero equivalence for annotations` test
- Update 2 `interpret: enrich combinator` tests to use `createInterpreter` instead of `zeroInterpreter` (no net change — same test logic, different base interpreter)

**Phase 3** — new tests in `writable.test.ts`:

- `writable: discriminated sum` group
  - reads discriminant from store and dispatches to matching variant (product ref with correct fields)
  - falls back to first variant when discriminant key is missing from store value
  - falls back to first variant when store value is not an object
- `writable: nullable (positional sum)` group
  - null store value produces a ref whose `.get()` returns null
  - non-null store value produces the inner writable ref (e.g. ScalarRef for `nullable(string())`)
  - mutation on the inner ref works (set a value, read it back)

These tests follow the existing patterns in `writable.test.ts`: create a schema, build a store with known values, interpret with `writableInterpreter`, assert on the result.

## Transitive Effect Analysis

### Phase 1 (extract shared utilities)

```
store.ts (NEW — readByPath, writeByPath, applyChangeToStore, Store, isNonNullObject)
  ← writable.ts         (import source changes, isNonNullObject replaces inline guards)
  ← plain.ts            (import source changes, isNonNullObject replaces inline guards)
  ← validate.ts         (import source changes, isNonNullObject replaces inline guards)
  ← with-changefeed.ts  (import source changes, isNonNullObject replaces inline guard)
  ← combinators.ts      (isNonNullObject replaces inline guard)
  ← zero.ts             (isNonNullObject replaces inline guard)
  ← index.ts            (re-export source changes)

schema.ts (isNullableSum exported)
  ← validate.ts         (import isNullableSum, delete local definition)
  ← describe.ts         (import isNullableSum, replace inline check)
```

**Risk:** Near-zero. All functions move verbatim or are pure additions. No signature changes. No behavior changes. The barrel re-export preserves the public API surface.

**`writable.ts` re-export concern:** `writable.ts` currently re-exports `readByPath` (line 122 of `index.ts` says `export { readByPath } from "./interpreters/writable.js"`). After the change, `index.ts` will export from `./store.js`. If any external consumer imports directly from `@loro-extended/schema/src/interpreters/writable.js` (bypassing the barrel), they'd break. However, the package has no external consumers — it's an isolated spike. Still, we'll keep a re-export from `writable.ts` for belt-and-suspenders safety.

### Phase 2 (delete zero interpreter)

```
interpreters/zero.ts (DELETED)
  ← index.ts            (remove export)
  ← interpret.test.ts   (remove 5 tests, update 2 tests)
  ← combinators.ts      (doc comment updates only — no code change)
```

**Risk:** Low. The zero interpreter has no production consumers. `Zero.structural` (in `zero.ts`) is the canonical implementation and is unchanged. The `annotationDefault` duplication disappears naturally when the file is deleted.

**Breaking change note:** `zeroInterpreter` is a public export. Removing it is technically a breaking change to the package API. However, the package is `0.0.1` with no consumers — this is the right time to do it.

### Phase 3 (writable sum dispatch)

```
writableInterpreter.sum()
  ← interpret() catamorphism (calls sum() — unchanged)
  ← with-changefeed decorator (enriches result — unchanged, since sum result is still unknown)
  ← example/main.ts (doesn't use sum types currently — no impact)
```

**Risk:** Low. The change makes sum dispatch smarter but preserves the first-variant fallback as the degenerate case. Existing tests that don't use sum types are unaffected. The only risk is if any test relied on "always pick first variant" for a discriminated sum — but no such test exists (current tests for discriminated sums are in `validate.test.ts` and `zero.test.ts`, not `writable.test.ts`).

### Phase 4 (documentation)

No code changes. Zero transitive risk.

## Resources for Implementation Context

Files to have in context during implementation:

**Phase 1:**
- `packages/schema/src/interpreters/writable.ts` — store extraction source, isNonNullObject replacement sites
- `packages/schema/src/interpreters/plain.ts` — import path update, isNonNullObject replacement
- `packages/schema/src/interpreters/validate.ts` — import path update, isNonNullObject replacement, isNullableSum removal
- `packages/schema/src/interpreters/with-changefeed.ts` — import path update, isNonNullObject replacement
- `packages/schema/src/combinators.ts` — isNonNullObject replacement
- `packages/schema/src/zero.ts` — isNonNullObject replacement
- `packages/schema/src/schema.ts` — isNullableSum addition (alongside isAnnotated, unwrapAnnotation)
- `packages/schema/src/describe.ts` — isNullableSum import
- `packages/schema/src/index.ts` — barrel export updates
- `packages/schema/src/interpret.ts` — `Path` type (needed by `store.ts`)
- `packages/schema/src/change.ts` — `ChangeBase` type (needed by `store.ts`)
- `packages/schema/src/step.ts` — `step` function (needed by `store.ts`)

**Phase 2:**
- `packages/schema/src/interpreters/zero.ts` — file to delete
- `packages/schema/src/index.ts` — remove export
- `packages/schema/src/__tests__/interpret.test.ts` — remove/update tests
- `packages/schema/src/combinators.ts` — doc comment updates

**Phase 3:**
- `packages/schema/src/interpreters/writable.ts` — sum dispatch implementation
- `packages/schema/src/interpreters/validate.ts` — reference implementation for sum dispatch pattern
- `packages/schema/src/schema.ts` — `SumSchema`, `PositionalSumSchema`, `DiscriminatedSumSchema`, `isNullableSum`
- `packages/schema/src/__tests__/writable.test.ts` — add sum dispatch tests

**Phase 4:**
- `packages/schema/TECHNICAL.md`
- `packages/schema/theory/interpreter-algebra.md` §14.7 (L1094–1101)

## Learnings

- **The zero interpreter was a proof artifact, not production code.** It demonstrated that `Zero.structural(schema)` is expressible as `interpret(schema, zeroInterpreter, undefined)` — a mathematically interesting equivalence. But at runtime, `Zero.structural` is simpler (direct recursive walk, no interpreter machinery, no thunks/closures). The zero interpreter's only test usage was proving this equivalence and as a convenient base in combinator tests. The conceptual insight is preserved in the theory document; the runtime code is pure maintenance burden.

- **`annotationDefault` duplication was a latent bug risk.** The function existed identically in both `zero.ts` and `interpreters/zero.ts` as private functions. Adding a new annotation default (e.g. for a future `"richtext"` tag) would require updating both files with no signal that a second copy exists. Deleting the zero interpreter eliminates this risk entirely.

- **Combinator doc comments that reference `zeroInterpreter` describe type-incoherent compositions.** The `overlay` doc comment suggests `overlay(crdtInterpreter, zeroInterpreter, firstDefined)` — but `overlay` requires both interpreters to share a `Ctx` type, and the zero interpreter uses `void` while any real interpreter uses a store-backed context. The example is illustrative but misleading; `plainInterpreter` or a hypothetical are better choices.

## Alternatives Considered

### Leave `readByPath` in `writable.ts` with cross-imports

The type-only import from `validate.ts` → `writable.ts` (for `Plain<S>`) has zero runtime cost. But the runtime import of `readByPath` from `plain.ts` → `writable.ts` creates a real module dependency. This means bundlers must include `writable.ts` even if only the plain interpreter is used. Extracting to `store.ts` eliminates this unnecessary coupling. The cost (one new file, mechanical import changes) is negligible.

### Extract `Plain<S>` and `Writable<S>` into a separate types module

`Plain<S>` is imported (type-only) by `validate.ts` from `writable.ts`. Moving it to its own module would remove even the type-level coupling. However, `Plain<S>` and `Writable<S>` are sister catamorphisms that share structure and are maintained together. Splitting them would make maintenance harder for no runtime benefit (type-only imports are erased). Deferred until `Plain<S>` has more consumers.

### Make writable sum dispatch fully runtime-aware for positional sums

We could try each positional variant at runtime (similar to how `validateInterpreter` does error-rollback). But the writable interpreter produces refs, not validated values — there's no meaningful way to "try" building a ref and roll back. For positional sums, only the nullable pattern (where we can check `value === null`) has a clear runtime discriminator. General positional sums remain first-variant-wins, which is the correct behavior until backend-specific type information is available.

### Keep `zeroInterpreter` as a public export

We could keep the file and fix only the `annotationDefault` duplication by extracting it. But this preserves 140 lines of code whose sole purpose is proving an equivalence that's already been proven and documented. Every future change to `Zero.structural` logic would require a parallel change in the zero interpreter. The mathematical insight is preserved in `theory/interpreter-algebra.md` — the runtime code doesn't need to exist for the proof to hold.

### Inline `isNonNullObject` — leave the pattern as-is

The `obj !== null && obj !== undefined && typeof obj === "object"` guard is idiomatic JavaScript. However, at 12+ repetitions across 7 files, it's crossed the threshold from "idiomatic" to "noise." A type-narrowing utility with a descriptive name improves readability and ensures the guard is consistent everywhere. The function is a one-liner with zero abstraction cost.