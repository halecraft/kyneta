# Validate Interpreter

## Background

The `packages/schema` package implements a Schema Interpreter Algebra — a unified recursive grammar with a generic catamorphism (`interpret`) that replaces 10+ parallel `switch (shape._type)` dispatch sites in the `packages/change` codebase. Four interpreters exist: `plainInterpreter` (read values), `zeroInterpreter` (derive defaults), `writableInterpreter` (mutation refs), plus the `withFeed` decorator (observation layer via `enrich`). Each is ~30-100 lines of interpreter definition atop the shared `interpret()` walker.

The `packages/change` codebase has a `validation.ts` module (~230 lines) that validates plain values against schemas. It is a hand-rolled recursive walker with **two nested levels of dispatch** — first on `shape._type` (text, counter, list, struct, record, tree), then on `valueType` within the `_type === "value"` branch (string, number, boolean, null, undefined, uint8array, struct, record, array, union, discriminatedUnion). This is exactly the kind of parallel dispatch the algebra eliminates.

Before building the validate interpreter, the `Schema` namespace needs restructuring. The current design has a `Schema.plain.*` sub-namespace that duplicates several top-level constructors (`struct`, `record`, `union`, `discriminatedUnion`) and is the only home for scalar constructors (`string`, `number`, `boolean`, etc.). This split is a vestige of the `change` package's dual `ContainerShape` / `ValueShape` type hierarchies — a Loro-specific implementation detail that the unified grammar explicitly abolished. Having both `Schema.struct(...)` and `Schema.plain.struct(...)` produce identical `ProductSchema` nodes creates confusion about which to use.

Additionally, the `change` package supports value-domain constraints on scalars (e.g. `Shape.plain.string<"item" | "magic-item">("item", "magic-item")`) for both type-level narrowing and runtime validation. The `schema` package's `ScalarSchema<K>` parameterizes on the *kind* but has no mechanism to constrain the *value domain* within that kind, making it impossible for a validate interpreter to check "is this one of these specific strings?"

## Problem Statement

1. **The `Schema.plain.*` namespace is a semantic dead end.** `Schema.struct(...)` and `Schema.plain.struct(...)` produce the same `ProductSchema`. A developer cannot reason about which to use. The `plain` grouping carries no information in the unified grammar — the container/value distinction it encoded belongs to the Loro backend, not the base schema library.

2. **Scalar constructors are buried.** `Schema.plain.string()` is the only way to create a string scalar, yet there's nothing "plain" about it — it's just a scalar. Scalar constructors should be top-level: `Schema.string()`.

3. **Top-level sum sugar is missing.** `Schema.nullable(inner)`, `Schema.union(...)`, and `Schema.discriminatedUnion(key, map)` don't exist at the top level. They exist only under `Schema.plain.*` or as low-level grammar constructors (`Schema.sum`, `Schema.discriminatedSum`).

4. **Scalar value-domain constraints are missing from the grammar.** `ScalarSchema<K>` has no way to express "must be one of these values" at either the type or runtime level.

5. **No validate interpreter exists.** Validation is an obvious use case for the algebra but hasn't been implemented yet.

## Success Criteria

1. The `Schema.plain` sub-namespace is removed. All constructors live at the top level of `Schema`.
2. Scalar constructors are top-level: `Schema.string()`, `Schema.number()`, `Schema.boolean()`, `Schema.null()`, `Schema.undefined()`, `Schema.bytes()`, `Schema.any()`.
3. `Schema.nullable(inner)`, `Schema.union(...)`, and `Schema.discriminatedUnion(key, map)` exist at the top level.
4. The duplicate structural constructors (`plain.struct`, `plain.record`, `plain.array`) are removed.
5. The `Schema` namespace has three clear groupings: scalars, structural composites, and annotated (backend semantics) — plus the low-level grammar constructors for power users.
6. `ScalarSchema` supports an optional value-domain constraint at both the type level and runtime level.
7. `Plain<S>` narrows to the constrained type when a constraint is present (e.g. `Plain<ScalarSchema<"string", "a" | "b">>` = `"a" | "b"`).
8. `Writable<S>` narrows `ScalarRef<T>` to use the constrained type.
9. A `validateInterpreter` walks a schema and collects `SchemaValidationError`s into a mutable accumulator, returning validated values on success or pushing errors on mismatch. The interpreter never throws.
10. A public `validate<S>(schema: S, value: unknown): Plain<S>` function narrows `unknown` to `Plain<S>`, throwing the first collected error on mismatch.
11. A public `tryValidate<S>(schema: S, value: unknown): { ok: true; value: Plain<S> } | { ok: false; errors: SchemaValidationError[] }` function returns all collected errors without throwing.
12. The validate interpreter correctly handles scalar constraints, nullable, positional unions, discriminated unions, and all structural kinds.
13. `describe()` renders constrained scalars readably and recognizes nullable as sugar.
14. The example `main.ts` demonstrates validation.
15. All existing tests continue to pass after migration (228 currently), with `Schema.plain.*` calls updated to `Schema.*`.
16. Backend-specific composition constraints (e.g. Loro's "no containers inside value blobs") remain expressible via typed builder wrappers outside the base library — the flattened namespace does NOT prevent this.

## Gap

- ~~`Schema.plain` sub-namespace exists with duplicate constructors and is the only home for scalars.~~ ✅ Phase 1
- ~~`Schema.nullable`, `Schema.union`, `Schema.discriminatedUnion` are absent from the top level.~~ ✅ Phase 1
- ~~Loro-specific annotations (`text`, `counter`, `movableList`, `tree`) leak into the backend-agnostic `Schema` namespace.~~ ✅ Phase 1b
- Two redundant path representations: the catamorphism's typed `Path` (discriminated `PathSegment[]`) and the writable layer's flat `string[]`. The writable layer converts at every interpreter case boundary via `toStorePath()`, discarding the key-vs-index distinction. The `readPath` utility in `plain.ts` is module-private and duplicated in spirit by `readByPath` in `writable.ts`.
- `ScalarSchema` has no `constraint` field.
- `ScalarPlain<K>` ignores any value-domain narrowing.
- `Plain<S>` and `Writable<S>` don't account for constrained scalars.
- No validate interpreter, `SchemaValidationError`, or `validate()` / `tryValidate()` function exists.
- `describe()` has no awareness of scalar constraints or nullable sugar.
- `Zero.structural` doesn't account for constrained scalars.
- The example `main.ts` has no validation section.

## Phases

### Phase 1: Flatten the `Schema` namespace 🟢

Remove `Schema.plain`, promote scalars and composites to the top level, eliminate duplicate constructors.

**Target namespace structure:**

```
Schema
  // Scalars (leaf values)
  .string()  .number()  .boolean()  .null()  .undefined()  .bytes()  .any()

  // Structural composites
  .struct(fields)  .list(item)  .record(item)
  .union(...variants)  .discriminatedUnion(key, map)  .nullable(inner)

  // Annotated (backend semantics)
  .text()  .counter()  .movableList(item)  .tree(nodeData)  .doc(fields)

  // Low-level (grammar-native, power users)
  .scalar(kind)  .product(fields)  .sequence(item)  .map(item)
  .sum(variants)  .discriminatedSum(key, map)  .annotated(tag, inner?, meta?)
```

- Task: In `schema.ts`, move scalar constructors (`string`, `number`, `boolean`, `null`, `undefined`, `bytes`, `any`) from the `plain` object to standalone functions. Add `nullable`, `union`, `discriminatedUnion` as top-level functions. 🟢
- Task: Add all new constructors to the `Schema` namespace object. Remove the `plain` property entirely. 🟢
- Task: Update the JSDoc on the `Schema` namespace to document the three clear groupings (scalars, structural composites, annotated) plus the low-level group. 🟢
- Task: Migrate all `Schema.plain.*` call sites across the package (~90+ occurrences across tests, example, and source). This is a mechanical find-and-replace: 🟢
  - `Schema.plain.string()` → `Schema.string()`
  - `Schema.plain.number()` → `Schema.number()`
  - `Schema.plain.boolean()` → `Schema.boolean()`
  - `Schema.plain.null()` → `Schema.null()`
  - `Schema.plain.undefined()` → `Schema.undefined()`
  - `Schema.plain.bytes()` → `Schema.bytes()`
  - `Schema.plain.any()` → `Schema.any()`
  - `Schema.plain.struct(...)` → `Schema.struct(...)` (already exists, identical)
  - `Schema.plain.record(...)` → `Schema.record(...)` (already exists, identical)
  - `Schema.plain.array(...)` → `Schema.list(...)` (rename to match top-level; only 3 call sites)
  - `Schema.plain.union(...)` → `Schema.union(...)`
  - `Schema.plain.discriminatedUnion(...)` → `Schema.discriminatedUnion(...)`
- Task: Update barrel exports in `index.ts` — remove any `plain`-related references. 🟢
- Task: Verify all 228 existing tests pass after migration. 🟢

### Phase 1c: Unify path representation 🔴

Eliminate the redundant `string[]` path representation. Make the catamorphism's typed `Path` the single canonical path format across all interpreters and infrastructure.

**Motivation:** Two path representations exist — the catamorphism's `Path` (array of `{ type: "key", key }` | `{ type: "index", index }` segments) and the writable layer's flat `string[]`. The writable layer converts via `toStorePath()` at every interpreter case boundary, losing the key-vs-index distinction. This distinction matters for human-readable error paths (`tasks[0].author` vs `tasks.0.author`) and is needed by the validate interpreter. Rather than extracting yet another `readPath` utility for Phase 3, unify now so all interpreters share one path type and one read function.

- Task: Change `readByPath(store: Store, path: readonly string[])` in `writable.ts` to accept `Path` instead of `string[]`. The loop body changes from indexing by `key` to branching on `seg.type` — identical to the private `readPath` in `plain.ts`. 🔴
- Task: Change `writeByPath(store: Store, path: readonly string[], value: unknown)` to accept `Path`. Same mechanical change. 🔴
- Task: Change `applyActionToStore` to accept `Path` for its path parameter. 🔴
- Task: Change `WritableContext.dispatch` signature from `(storePath: readonly string[], action: ActionBase) => void` to `(path: Path, action: ActionBase) => void`. 🔴
- Task: Change `PendingAction.path` from `readonly string[]` to `Path`. 🔴
- Task: Update `createWritableContext` — the `dispatch` closure and `pending` array use `Path`. 🔴
- Task: Update all call sites in `writableInterpreter` — remove `toStorePath(path)` calls. Each case already receives `path: Path` from the catamorphism; pass it directly to `readByPath`, `writeByPath`, `ctx.dispatch`, and ref constructors. 🔴
- Task: Update `createTextRef`, `createCounterRef`, `createScalarRef` to accept `Path` instead of `readonly string[]`. 🔴
- Task: Update `with-feed.ts` — `pathKey`, `subscribeToPath`, `notifySubscribers`, `createFeedForPath`, `feedableFlush`, and the `withFeed` decorator all switch from `string[]` to `Path`. The `pathKey` function becomes `path.map(seg => seg.type === "key" ? seg.key : String(seg.index)).join("\0")`. 🔴
- Task: Delete `toStorePath()` from `writable.ts` and remove its export from `index.ts`. 🔴
- Task: Delete the private `readPath` from `plain.ts` — replace its call sites with the now-`Path`-compatible `readByPath` imported from `writable.ts`. 🔴
- Task: Export `readByPath` from `index.ts` (already exported, just verify signature updated). 🔴
- Task: Verify all 238 tests pass. No behavioral change — this is a pure representation unification. 🔴

### Phase 2: Scalar value-domain constraints 🔴

Add an optional `constraint` field to `ScalarSchema` that carries both the type-level narrowing and the runtime values for validation.

- Task: Extend `ScalarSchema<K, V>` with an optional second type parameter `V` that defaults to `ScalarPlain<K>` and an optional `constraint?: readonly V[]` field. When present, `constraint` lists the allowed values. When absent, any value matching the kind is accepted. 🔴
- Task: Update `Plain<S>` — when resolving a scalar, use `V` (the second type parameter) instead of `ScalarPlain<K>`. Since `V` defaults to `ScalarPlain<K>`, unconstrained scalars are unchanged. 🔴
- Task: Update `Writable<S>` — when resolving a scalar, produce `ScalarRef<V>` instead of `ScalarRef<ScalarPlain<K>>`. 🔴
- Task: Update `Schema.string()` to accept optional type parameter and variadic options: `string<V extends string = string>(...options: V[])`. When options are provided, produces `ScalarSchema<"string", V>` with `constraint: options`. When no options, produces `ScalarSchema<"string">` (no constraint field). Same pattern for `Schema.number()` and `Schema.boolean()`. The low-level `Schema.scalar(kind)` also gains an optional constraint parameter. 🔴
- Task: Update `Zero.structural` and `zeroInterpreter` — when a scalar has a non-empty `constraint`, use `constraint[0]` as the default instead of the generic kind default. 🔴
- Task: Update `describe()` to render constrained scalars, e.g. `string("public" | "private")` instead of just `string`. Update nullable rendering: when a positional sum's first variant is `scalar("null")` and it has exactly two variants, render as `nullable<inner>` instead of `union`. 🔴
- Task: Tests — type-level tests for `Plain<S>` and `Writable<S>` with constrained scalars, runtime tests for `Zero.structural` with constrained scalars, `describe()` with constrained scalars and nullable. Verify all existing tests still pass (the second type parameter defaults must be fully backward-compatible). 🔴

### Phase 3: Validate interpreter 🔴

Implement the validate interpreter and the public `validate()` / `tryValidate()` functions.

**Architecture: one collecting interpreter, two public wrappers.**

The interpreter always collects errors into a mutable accumulator — it never throws. On mismatch, it pushes a `SchemaValidationError` and returns `undefined` as a sentinel. On success, it returns the validated value. The two public functions are thin wrappers:

- `validate()` runs the interpreter, checks the error list, throws the first error if non-empty.
- `tryValidate()` runs the interpreter, returns a `{ ok, value/errors }` discriminant.

This avoids building two separate interpreters or bolting a "collecting mode" onto a throwing interpreter.

**Context type:** `ValidateContext = { root: unknown; errors: SchemaValidationError[] }`. The `root` field is the root value (same role as `ctx` in `plainInterpreter`). The `errors` array accumulates all validation failures.

**Positional sum rollback:** When trying variant `i`, snapshot `const mark = errors.length` before the attempt. If the variant fails, reset `errors.length = mark` to discard that variant's errors before trying the next. If all variants fail, push a single "expected one of union variants" error. For nullable sums specifically (two variants where the first is `scalar("null")`), the error message should mention nullable semantics.

- Task: Create `src/interpreters/validate.ts` containing `validateInterpreter: Interpreter<ValidateContext, unknown>` and `ValidateContext` type. 🔴
  - `scalar`: read the value at path. Check `typeof` matches kind. If `constraint` is present, check value is in the constraint array. On mismatch, push `SchemaValidationError` and return `undefined`.
  - `product`: read the value at path. Check it's a non-null, non-array object. If not, push error and return `undefined`. Otherwise, force each field thunk (which validates the field's value). Collect into result object.
  - `sequence`: read the value at path. Check it's an array. If not, push error and return `undefined`. Validate each item via the item closure.
  - `map`: read the value at path. Check it's a non-null, non-array object. If not, push error and return `undefined`. Validate each key's value via the item closure.
  - `sum` (positional): read the value at path. Try each variant via `byIndex` with error rollback. Return the first that produces no new errors. If all fail, push "expected one of union variants" error.
  - `sum` (discriminated): read the value at path. Check it's an object. Read the discriminant key. Check it's a string and exists in the variant map. Validate through the matching variant via `byKey`.
  - `annotated`: leaf annotations (`text` → check string, `counter` → check number). Structural annotations (`doc`, `movable`, `tree` → delegate to inner).
- Task: Create `SchemaValidationError` class in `validate.ts`. Fields: `path: string`, `expected: string`, `actual: unknown`. Path formatted as dot-separated with bracket notation for indices (e.g. `messages[0].author`). 🔴
- Task: Create `formatPath(path: Path): string` helper that converts `Path` segments to the human-readable string for error reporting. Empty path → `"root"`. This is trivial because `Path` preserves the key-vs-index distinction (thanks to Phase 1c). 🔴
- Task: Use `readByPath` from `writable.ts` (already `Path`-compatible after Phase 1c) — no new utility needed. 🔴
- Task: Create public `validate<S extends Schema>(schema: S, value: unknown): Plain<S>`. Creates a `ValidateContext`, calls `interpret(schema, validateInterpreter, ctx)`, checks `ctx.errors.length > 0`, throws the first error if so, otherwise casts and returns the result. 🔴
- Task: Create public `tryValidate<S extends Schema>(schema: S, value: unknown): { ok: true; value: Plain<S> } | { ok: false; errors: SchemaValidationError[] }`. Creates a `ValidateContext`, calls `interpret(schema, validateInterpreter, ctx)`, returns the appropriate discriminant based on `ctx.errors`. 🔴
- Task: Update barrel exports in `index.ts`. 🔴
- Task: Tests in `src/__tests__/validate.test.ts`: 🔴
  - Scalar validation: string/number/boolean/null/undefined/bytes/any — valid and invalid.
  - Constrained scalar: string with options — valid option, invalid option, error message includes allowed values.
  - Product: valid object, non-object value, missing field, extra fields (should pass — schemas don't forbid extra keys).
  - Sequence: valid array, non-array, invalid item at specific index (error path includes `[i]`).
  - Map: valid object, non-object, invalid value at specific key (error path includes `.key`).
  - Positional sum: value matching first variant, value matching second variant, value matching no variant.
  - Discriminated sum: valid discriminant + valid body, valid discriminant + invalid body, invalid discriminant value, missing discriminant key.
  - Nullable: null passes, valid inner passes, invalid inner fails with nullable-aware message.
  - Annotated: text (valid string, invalid), counter (valid number, invalid), doc (delegates to inner product), movable (delegates to inner sequence).
  - Nested realistic schema: full doc with all kinds, valid data passes, deeply nested error has correct path.
  - `tryValidate`: collects multiple errors from a single value with wrong types in several fields.
  - `validate`: throws on first error (from the collected list).
  - Type narrowing: `validate(schema, value)` return type is `Plain<typeof schema>` — verified via `expectTypeOf`.

### Phase 4: Example and documentation 🔴

- Task: Update `example/main.ts`'s `ProjectSchema` to exercise new features: at least one constrained scalar (e.g. `visibility: Schema.string<"public" | "private">("public", "private")`) and one nullable field (e.g. `Schema.nullable(Schema.string())`). Update all `Schema.plain.*` calls to the flattened namespace. 🔴
- Task: Add a validation section to `example/main.ts` (section 11, before final snapshot). Demonstrate: 🔴
  - Validating the current doc snapshot (should pass).
  - Validating invalid data with caught errors showing path and message.
  - Type narrowing: `const data: Plain<typeof ProjectSchema> = validate(ProjectSchema, rawJSON)`.
  - Using `tryValidate` to collect multiple errors.
- Task: Update `example/README.md` to document the validation section. 🔴
- Task: Update `TECHNICAL.md`: document the flattened namespace and rationale, add validate interpreter to the interpreters table, document `SchemaValidationError`, document scalar constraints, document `nullable`/`union`/`discriminatedUnion`, note that backend-specific composition constraints belong in backend adapter layers (not the base grammar). 🔴

## Tests

Tests are distributed across Phases 1-3. Key risk areas:

- **Namespace flattening migration volume (Phase 1).** ~90+ occurrences of `Schema.plain.*` across tests, example, and source. ✅ Complete.
- **Path unification is behaviorally invisible (Phase 1c).** The `string[]` → `Path` change is a pure representation swap. All existing tests must pass without modification. The risk is mechanical (many call sites in `writable.ts` and `with-feed.ts`) but not semantic — the JS object access patterns are identical since `obj[String(index)]` and `obj[index]` produce the same result. No new tests needed; existing writable and feed tests provide coverage.
- **Backward compatibility of `ScalarSchema<K, V>` (Phase 2).** The second type parameter must default cleanly so that all existing `ScalarSchema<"string">` usages continue to work. Every existing test must pass without modification after this change.
- **`Plain<S>` recursion depth (Phase 2).** Adding a second type parameter to the scalar case adds one more conditional branch. Verify no "excessively deep" errors on the realistic end-to-end schema in the types test.
- **Positional sum validation with error rollback (Phase 3).** The collecting interpreter tries each variant, rolling back errors via `errors.length = mark`. Must verify that (a) successful variant produces zero spurious errors, (b) all-fail produces exactly one "expected one of union variants" error (not N variant-level errors), (c) nullable sums produce nullable-aware error messages.
- **Discriminated sum validation (Phase 3).** Must check discriminant key existence and value before validating the variant body, producing clear errors for each failure mode.
- **Multi-error collection (Phase 3).** `tryValidate` on a value with multiple type mismatches must collect all errors (not short-circuit after the first). Product fields should all be validated even if the first field fails.

## Transitive Effect Analysis

This work is contained within `packages/schema`, which has **no dependents and no dependencies on existing packages**. No transitive effects on other packages.

Within `packages/schema`, the Phase 1 namespace flattening touches every file that references `Schema.plain.*`:

1. `schema.ts` — remove `plain` object, add top-level constructors. ✅ Phase 1
2. `describe.ts` — no changes needed in Phase 1 (walks `_kind`, not constructors). Phase 2 adds constraint and nullable rendering.
3. `interpret.ts`, `combinators.ts` — no changes needed (receive `ScalarSchema` generically).
4. `zero.ts` — must read `constraint` from `ScalarSchema` in Phase 2.
5. `interpreters/zero.ts` — must read `constraint` in Phase 2.
6. `interpreters/writable.ts` — Phase 1c: path representation change (`string[]` → `Path` throughout, delete `toStorePath`). Phase 2: `Plain<S>` and `Writable<S>` types must account for constrained scalars. Runtime behavior unchanged (writable doesn't validate).
7. `interpreters/plain.ts` — Phase 1c: delete private `readPath`, import shared `readByPath` from `writable.ts`. No other changes (reads values regardless of constraint).
8. `interpreters/with-feed.ts` — Phase 1c: all path infrastructure (`pathKey`, `subscribeToPath`, `notifySubscribers`, `feedableFlush`) switches from `string[]` to `Path`. No other changes.
9. `index.ts` — update exports in Phase 1 (remove `plain` references), Phase 1c (remove `toStorePath`), and Phase 3 (add validate exports).
10. All test files — mechanical `Schema.plain.*` → `Schema.*` migration in Phase 1. ✅
11. `example/main.ts` — migration in Phase 1, new features in Phase 4.

The `writableInterpreter` receives `ScalarSchema` in its `scalar` case but only reads `scalarKind`. The `constraint` field is ignored by the writable interpreter (validation is not a mutation concern). Same for `plainInterpreter`. Only `zeroInterpreter`, `validateInterpreter`, and `describe` need awareness of `constraint`.

## Resources for Implementation Context

| Resource | Path | Relevance |
|---|---|---|
| Schema grammar | `packages/schema/src/schema.ts` | `ScalarSchema`, `Schema` namespace (restructured in Phase 1) |
| Interpreter interface | `packages/schema/src/interpret.ts` | `Interpreter<Ctx, A>`, `Path`/`PathSegment` — the canonical path type |
| LoroSchema namespace | `packages/schema/src/loro-schema.ts` | Loro-specific constructors + `plain` sub-namespace (created in Phase 1b) |
| Plain interpreter | `packages/schema/src/interpreters/plain.ts` | Pattern to follow — `Ctx` is root value, reads by path. Contains module-private `readPath` (to be deleted in Phase 1c) |
| Zero interpreter | `packages/schema/src/interpreters/zero.ts` | Must update for constrained scalar defaults |
| Zero module | `packages/schema/src/zero.ts` | `scalarDefault` and `structural` must account for constraints |
| Writable interpreter + types | `packages/schema/src/interpreters/writable.ts` | `ScalarPlain`, `Plain<S>`, `Writable<S>`, `readByPath`, `writeByPath`, `toStorePath`, `WritableContext.dispatch`, `PendingAction` — Phase 1c path unification + Phase 2 type updates |
| Feed decorator | `packages/schema/src/interpreters/with-feed.ts` | Phase 1c: path infra (`pathKey`, `subscribeToPath`, etc.) switches from `string[]` to `Path` |
| Describe | `packages/schema/src/describe.ts` | Must render constraints and nullable sugar |
| Barrel exports | `packages/schema/src/index.ts` | Add/remove exports |
| Change validation | `packages/change/src/validation.ts` | Reference implementation — the 230-line walker this replaces |
| Change string shape | `packages/change/src/shape.ts` L742-765 | `Shape.plain.string(…options)` pattern with `options?: T[]` |
| Change error type | `packages/change/src/errors.ts` | `SchemaViolationError` — reference for error design |
| Change DU test | `packages/change/src/discriminated-union.test.ts` | Validation test cases for discriminated unions |
| Change string test | `packages/change/src/string-literal.test.ts` | Validation test cases for string literal constraints |
| Existing type tests | `packages/schema/src/__tests__/types.test.ts` | Pattern for `expectTypeOf` type-level tests |
| Existing zero tests | `packages/schema/src/__tests__/zero.test.ts` | Pattern for zero/default tests |
| Existing describe tests | `packages/schema/src/__tests__/describe.test.ts` | LoroSchema annotation rendering tests |
| Existing interpret tests | `packages/schema/src/__tests__/interpret.test.ts` | Catamorphism + LoroSchema constructor tests |
| Existing writable tests | `packages/schema/src/__tests__/writable.test.ts` | Writable ref tests (path-sensitive, affected by Phase 1c) |
| Example | `packages/schema/example/main.ts` | Uses `LoroSchema.plain.*` — add validation section in Phase 4 |
| TECHNICAL.md | `packages/schema/TECHNICAL.md` | Update with new architecture |

## Alternatives Considered

### Keep `Schema.plain` as a backward-compatible alias

We considered keeping `Schema.plain` as a deprecated alias pointing to the same functions, easing migration. Rejected because: (a) the package has no external consumers — it's an internal spike, (b) keeping the alias perpetuates the confusion about which to use, (c) the migration is mechanical (find-and-replace) with no semantic ambiguity.

### Scalar constraint as annotation vs. scalar field

We considered using the annotation mechanism (`annotated("constrained", scalar("string"), { options: [...] })`) to carry value-domain constraints. Rejected because: (a) it makes the common case verbose, (b) it buries constraint info behind an annotation unwrap, (c) the `change` package puts options directly on `StringValueShape`, and (d) interpreters that care about constraints should read them directly from the scalar node.

### Throwing interpreter with bolt-on collecting mode

The original design had two modes: a throwing `validateInterpreter` for `validate()`, and a separate collecting mechanism (catch-per-node) for `tryValidate()`. Rejected because: (a) two modes means either two interpreters or a runtime mode flag that complicates every case, (b) the catch-per-node approach is fragile — it requires try/catch at every product field, sequence item, and map key boundary, (c) since we have no backward-compat constraint, we can design the one right architecture from scratch: a single collecting interpreter that never throws, with `validate()` and `tryValidate()` as thin wrappers that read from the error accumulator. The positional-sum rollback pattern (`errors.length = mark`) is clean and local.

### `nullable` as method vs. function

We considered adding `.nullable()` as a chainable method on schema nodes (matching `change` package's builder pattern). Rejected — schema nodes are plain data objects, and a standalone `Schema.nullable(inner)` function is consistent with the functional style, works for any schema node, and avoids builder complexity. Chainable sugar can be added later in a backend-specific builder layer.

### Discriminated union with array vs. map

The `change` package uses `Record<string, StructValueShape>` — a map from discriminant value to variant shape. The map is correct: O(1) lookup, explicit key-variant relationship, no need to inspect variant fields. The `change` package's constraint to `StructValueShape`-only variants was the mistake, not the map. The `schema` package's `DiscriminatedSumSchema` accepts any `Schema` as variant values, which is more general.

### Backend-specific composition constraints in the base library

We considered keeping some form of the `plain` namespace to enforce Loro's "no containers inside value blobs" rule. Rejected because: (a) this constraint is Loro-specific — a Firestore or plain-JS backend has no such rule, (b) the base grammar should be unconstrained (context-free), (c) backend-specific well-formedness rules belong in a typed builder wrapper (e.g. `LoroSchema.plain.struct(...)` that narrows type bounds to prevent invalid nesting), (d) this keeps `@loro-extended/schema` truly backend-agnostic.

## Documentation Updates

- `TECHNICAL.md`: Document flattened namespace with rationale, add validate interpreter to interpreters table, document scalar constraints, document `nullable`/`union`/`discriminatedUnion`, document `SchemaValidationError`, document the collecting-interpreter architecture, note that backend composition constraints belong in adapter layers.
- `example/README.md`: Add validation section description.
- No top-level README.md changes needed (no public-facing API changes outside the package).

## Learnings

1. **The `change` package only constrains strings, not numbers or booleans.** `StringValueShape` has `options?: T[]`; `NumberValueShape` and `BooleanValueShape` do not. Phase 2 generalizes constraints to all three scalar kinds. There is no reference test corpus for number/boolean constraints — tests must be written from scratch.

2. **The catamorphism's `sum` case passes `schema: SumSchema` directly.** The validate interpreter needs the variant count for positional sums (to try each `byIndex(i)`). This is available via `(schema as PositionalSumSchema).variants.length` — no changes to the `interpret()` walker needed.

3. **Annotated leaf validation (`text`, `counter`) must read the value directly.** For leaf annotations, `inner` is `undefined` (no inner schema). The validate interpreter's `annotated` case must call `readByPath(ctx.root, path)` and check the type itself, same pattern as `plainInterpreter`. This is why Phase 1c's path unification matters — the validate interpreter needs `readByPath` to accept `Path`, which Phase 1c delivers.

4. **The `change` package's union validation uses try/catch for variant probing.** The schema package's collecting interpreter with `errors.length = mark` rollback avoids exception overhead and is cleaner. This confirms the plan's architecture is a genuine improvement.

5. **`toStorePath()` is exported from `index.ts` but has no external consumers.** The schema package has no dependents. Removing it in Phase 1c is safe.

## Changeset

No changeset needed — `packages/schema` is an internal package with no consumers.

## Amendment: Extract `LoroSchema` — backend-specific annotations and composition constraints

**Discovered during:** Phase 1 (flatten the `Schema` namespace)
**Targets:** New Phase 1b, inserted between Phase 1 and Phase 2

### Preamble

Phase 1 flattened `Schema.plain.*` into the top-level `Schema` namespace, arguing that the container/value split was a Loro-specific implementation detail. This succeeded, but it surfaced a deeper tension: after flattening, `Schema.text()` and `Schema.string()` sit side by side with no clear guidance on when to use which. The answer is "it depends on your backend" — exactly the kind of leaked implementation detail we were trying to eliminate.

The annotations `text`, `counter`, `movableList`, and `tree` are Loro-specific semantics. `text` means "collaborative string with insert/delete/marks" — a Loro CRDT container. `counter` means "collaborative number with increment/decrement." `movableList` means "sequence with move semantics." `tree` means "hierarchical CRDT." None of these concepts exist in a plain-JS backend, a Firestore backend, or any other non-CRDT system. They belong in a backend-specific builder layer, not the base grammar.

The key insight is that **moving the constructors is purely a namespace concern**. The interpreter implementations (`writableInterpreter`, `zeroInterpreter`, `describe`, `Plain<S>`, `Writable<S>`) all dispatch on annotation tag strings — they don't care whether the constructor that produced the `annotated("text")` node lives in `Schema` or `LoroSchema`. No interpreter code changes.

Additionally, the `plain` sub-namespace that Phase 1 removed was doing something valuable for Loro users: enforcing composition constraints (no CRDTs inside value blobs). Re-introducing `LoroSchema.plain.*` as a typed builder wrapper restores this constraint at the correct layer — not in the base grammar, but in the backend-specific API.

### Learnings

1. **`doc` stays in `Schema`.** "Named product root" is a reasonable structural concept for all schemas. This could be revisited later, but it's not a backend-specific annotation in the same way `text` and `counter` are.

2. **`LoroSchema` should be the full developer-facing API for Loro users.** It re-exports everything from `Schema` (so users don't need two imports) plus the Loro-specific annotations. A Loro developer writes `LoroSchema.doc(...)` and `LoroSchema.text()` — one import, one namespace.

3. **`LoroSchema.plain.*` restores composition constraints.** The type bounds on `LoroSchema.plain.struct(...)` would narrow to prevent nesting CRDT containers inside value blobs — the same constraint the `change` package enforces, but now explicit and layered rather than baked into the grammar.

4. **The validate interpreter is unaffected.** Validation is structural — it looks through annotations to the implied type (`text` → string, `counter` → number). It doesn't need to know whether the constructor came from `Schema` or `LoroSchema`. Phases 2-4 can proceed with or without this extraction.

5. **Interpreter hardcoded tag dispatch stays where it is.** `Plain<S>`, `Writable<S>`, `writableInterpreter`, and `Zero` all switch on tag strings like `"text"` and `"counter"`. This is correct — the interpreters are Loro-aware by design (they produce `TextRef`, `CounterRef`, etc.). The separation is about the *constructor namespace*, not the *interpreter dispatch*.

### Target namespace structure

**`Schema` (backend-agnostic base grammar):**

```
Schema
  // Scalars (leaf values)
  .string()  .number()  .boolean()  .null()  .undefined()  .bytes()  .any()

  // Structural composites
  .struct(fields)  .list(item)  .record(item)
  .union(...)  .discriminatedUnion(key, map)  .nullable(inner)

  // Root
  .doc(fields)

  // Low-level (grammar-native, power users)
  .scalar(kind)  .product(fields)  .sequence(item)  .map(item)
  .sum(variants)  .discriminatedSum(key, map)  .annotated(tag, inner?, meta?)
```

**`LoroSchema` (Loro-specific, re-exports Schema + adds annotations):**

```
LoroSchema
  // Everything from Schema (re-exported)
  .string()  .number()  .boolean()  .null()  .undefined()  .bytes()  .any()
  .struct(fields)  .list(item)  .record(item)
  .union(...)  .discriminatedUnion(key, map)  .nullable(inner)
  .doc(fields)
  .scalar(kind)  .product(fields)  .sequence(item)  .map(item)
  .sum(variants)  .discriminatedSum(key, map)  .annotated(tag, inner?, meta?)

  // Loro-specific annotations
  .text()                   // annotated("text") — collaborative string
  .counter()                // annotated("counter") — collaborative number
  .movableList(item)        // annotated("movable", sequence(item))
  .tree(nodeData)           // annotated("tree", nodeData)

  // Composition-constrained plain values (no CRDTs inside value blobs)
  .plain.string()  .plain.number()  .plain.boolean()  ...
  .plain.struct(fields)  .plain.record(item)  .plain.array(item)
  .plain.union(...)  .plain.discriminatedUnion(key, map)
```

### Tasks

- Task: Create `src/loro-schema.ts` containing the `LoroSchema` namespace object. It spreads `Schema` and adds `text`, `counter`, `movableList`, `tree`. 🟢
- Task: Move `text()`, `counter()`, `movableList()`, `tree()` functions out of `schema.ts` into `loro-schema.ts`. Remove them from the `Schema` namespace object. The functions themselves are unchanged. 🟢
- Task: Create the `LoroSchema.plain` sub-namespace with composition-constrained constructors. For now these are identical to the base constructors (the type-level narrowing that prevents CRDT nesting is a follow-up concern for when the Loro adapter integrates). 🟢
- Task: Add `LoroSchema.doc()` that delegates to `Schema.doc()` — for symmetry so Loro users only need one import. 🟢
- Task: Export `LoroSchema` from `index.ts`. 🟢
- Task: Migrate tests and example to use `LoroSchema` where Loro-specific annotations are used. Tests that exercise the base grammar (e.g. `Schema.scalar(...)`, `Schema.struct(...)`) stay on `Schema`. Tests that use `text`, `counter`, `movableList`, `tree` move to `LoroSchema`. 🟢
- Task: Update `describe.ts` — no changes needed (dispatches on tag strings, not constructor origin). 🟢
- Task: Update `Plain<S>` and `Writable<S>` — no changes needed (dispatch on `AnnotatedSchema<"text">` etc., which is the same regardless of constructor origin). 🟢
- Task: Update JSDoc and `TECHNICAL.md` to document the two-namespace design. 🟢
- Task: Verify all 238 tests pass after migration (228 original + 10 new from layered LoroSchema tests). 🟢

### Migration impact

The migration is mechanical — same pattern as Phase 1:
- `Schema.text()` → `LoroSchema.text()`
- `Schema.counter()` → `LoroSchema.counter()`
- `Schema.movableList(...)` → `LoroSchema.movableList(...)`
- `Schema.tree(...)` → `LoroSchema.tree(...)`
- `Schema.doc(...)` stays as-is (or can use `LoroSchema.doc(...)` in Loro-specific contexts)

Estimated ~60 occurrences across tests, example, and JSDoc.