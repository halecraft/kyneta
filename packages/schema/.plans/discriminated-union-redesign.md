# Discriminated Union Redesign — Zod-Style Variant Schemas

## Background

`@kyneta/schema` has a discriminated union API that is unique among TypeScript validators:

```ts
// Current @kyneta/schema approach — discriminant is implicit
Schema.discriminatedUnion("type", {
  text: Schema.struct({ body: LoroSchema.text() }),
  image: Schema.struct({ url: LoroSchema.plain.string() }),
})
```

The variant map key (`"text"`, `"image"`) doubles as the discriminant value. The variant schemas themselves have no field called `type` — it exists only as routing metadata between the schema and the store.

Every other major TypeScript validator uses a different convention where each variant explicitly declares the discriminant as a field:

**Zod:**
```ts
z.discriminatedUnion("status", [
  z.object({ status: z.literal("success"), data: z.string() }),
  z.object({ status: z.literal("failed"), error: z.string() }),
])
```

**Valibot:**
```ts
v.variant('type', [
  v.object({ type: v.literal('foo'), foo: v.string() }),
  v.object({ type: v.literal('bar'), bar: v.number() }),
])
```

**io-ts** and **TypeBox** don't have a first-class discriminated union — they use standard unions where each variant is a full object with the discriminant as a declared property.

In every case, the discriminant is a **real, declared field** in each variant's schema. The `discriminatedUnion` API is merely an optimization hint that says "use this field for fast dispatch." The schema is self-describing.

### The problems with the current approach

1. **Type/runtime mismatch.** `Plain<DiscriminatedSumSchema<D, M>>` produces `Plain<M[K]> & { [_ in D]: K }` — it injects the discriminant into the type. But the runtime interpreters (`plainInterpreter`, `withReadable`'s `ref()` fold) walk the variant schema, which has no discriminant field, and produce output without it. The type lies.

2. **Round-trip broken.** `Zero.structural(schema)` produces `{ type: "text", body: "" }` (includes discriminant). `doc()` produces `{ body: "..." }` (drops it). `validate(schema, doc())` fails because validate expects `type` to be present. The create → read → validate loop doesn't close.

3. **`Zero.structural` has to special-case it.** It manually merges `{ [schema.discriminant]: firstKey }` into the variant's structural zero — the only place in the codebase where the runtime injects the discriminant.

4. **Developer expectation mismatch.** TypeScript developers expect discriminated unions to have the discriminant as a real field in each variant. Every other validation library follows this convention. The current API requires understanding an unusual implicit mapping from object keys to discriminant values.

5. **The variant schemas are not self-describing.** `Schema.struct({ body: text })` doesn't know it lives inside a discriminated sum or what its discriminant value is. This makes it impossible for any interpreter to include the discriminant in its output without special-casing.

## Problem Statement

The `Schema.discriminatedUnion` API uses an implicit convention (variant map keys = discriminant values) that no other TypeScript validator follows. This creates a type/runtime mismatch in `Plain<S>`, breaks the create → read → validate round-trip, and confuses developers who expect the Zod/Valibot convention. The API should be changed so each variant explicitly declares the discriminant field in its own schema.

## Success Criteria

1. `Schema.discriminatedUnion("type", [...])` accepts an array of variant schemas, each of which must be a product (struct) that contains a field matching the discriminant key. The discriminant field's schema must be a scalar with a string constraint (acting as a literal).
2. The `DiscriminatedSumSchema` type changes from `{ discriminant: D, variantMap: M }` to `{ discriminant: D, variants: V[] }` where variants are product schemas. The variant map is derived at runtime by reading each variant's discriminant field constraint.
3. `Plain<S>` for discriminated sums naturally includes the discriminant field — no special `& { [_ in D]: K }` injection needed, because the field is part of each variant's schema.
4. `plainInterpreter`, `withReadable`'s `ref()` fold, `Zero.structural`, `validate`, and `describe` all produce output that includes the discriminant field, with no special-casing.
5. `doc()` output round-trips through `validate` without hacks.
6. `Zero.structural` no longer needs to inject the discriminant — it falls out naturally from walking the variant's product fields.
7. All existing tests are updated. No existing behavior is lost for positional sums or nullable sums.
8. The `example/main.ts` discriminated union uses the new API.
9. TECHNICAL.md documents the new convention and the rationale.

## The Gap

### API surface change

The current `discriminatedUnion` signature:

```ts
function discriminatedUnion<D extends string, M extends Record<string, Schema>>(
  discriminant: D,
  variantMap: M,
): DiscriminatedSumSchema<D, M>
```

Must become:

```ts
function discriminatedUnion<D extends string, V extends ProductSchema[]>(
  discriminant: D,
  variants: [...V],
): DiscriminatedSumSchema<D, V>
```

Where each variant in `V` is a `ProductSchema` that contains a field at key `D` whose schema is a `ScalarSchema<"string", SomeLiteralConstraint>`.

### Type-level change

`DiscriminatedSumSchema` currently stores a `variantMap: Record<string, Schema>`. It must change to store `variants: ProductSchema[]` (an array, like Zod). The discriminant value for each variant is extracted from the variant's own field schema at compile time and runtime.

### `Plain<S>` simplification

The current `Plain<S>` for discriminated sums:

```ts
S extends DiscriminatedSumSchema<infer D, infer M>
  ? { [K in keyof M]: Plain<M[K]> & { [_ in D]: K } }[keyof M]
```

After the change, each variant is a `ProductSchema` that already has the discriminant as a field. So `Plain<S>` for discriminated sums becomes a simple union of `Plain<V[number]>` — no `& { [_ in D]: K }` injection needed.

### Runtime dispatch change

`dispatchSum` currently reads `store[discriminant]` and looks it up in `variantMap`. After the change, it reads `store[discriminant]` and finds the variant whose discriminant field constraint matches. The variant map can be built lazily or eagerly at interpretation time.

### `Zero.structural` simplification

Currently has a special case that merges `{ [discriminant]: firstKey }` into the variant's zero. After the change, the discriminant field is part of the variant's product schema, so `structural` just walks the product fields normally — the discriminant field produces its literal constraint value as the default.

## Phases

### Phase 1: Change `DiscriminatedSumSchema` type and constructors ✅

- Task: Redefine `DiscriminatedSumSchema` to store `variants: readonly ProductSchema[]` instead of `variantMap: Record<string, Schema>`. Keep `discriminant: D`. ✅
- Task: Add a `variantMap` getter or builder function that derives the `Record<string, ProductSchema>` from the variants array by reading each variant's discriminant field constraint. This is needed internally by `dispatchSum`, `validate`, `describe`, etc. ✅
- Task: Update `PlainDiscriminatedSumSchema` to match. ✅
- Task: Update `discriminatedSum()` and `discriminatedUnion()` constructors to accept `variants: ProductSchema[]`. Each variant must be a product whose fields include the discriminant key. ✅
- Task: Add runtime validation in the constructor: throw if any variant lacks the discriminant field or the field's schema is not a scalar with a string constraint. ✅
- Task: Update `Schema.discriminatedUnion` JSDoc and examples. ✅

New type shape:

```ts
interface DiscriminatedSumSchema<
  D extends string = string,
  V extends readonly ProductSchema[] = readonly ProductSchema[],
> {
  readonly _kind: "sum"
  readonly discriminant: D
  readonly variants: V  // was variantMap
  readonly variantMap?: undefined  // removed
}
```

New constructor signature:

```ts
// New: variants is an array of product schemas, each declaring the discriminant
Schema.discriminatedUnion("type", [
  Schema.struct({ type: Schema.string("text"), body: LoroSchema.text() }),
  Schema.struct({ type: Schema.string("image"), url: LoroSchema.plain.string() }),
])
```

Note: `Schema.string("text")` already exists — it's `Schema.scalar("string", "text")` which produces `ScalarSchema<"string", "text">` with `constraint: ["text"]`. The first constraint value is both the literal type and the default from `Zero.structural`.

### Phase 2: Update `Plain<S>` type ✅

- Task: Simplify `Plain<DiscriminatedSumSchema>` to `Plain<V[number]>` — a union of the plain types of each variant. No `& { [_ in D]: K }` injection. ✅
- Task: Verify that `Plain<S>` for discriminated sums now includes the discriminant field naturally (because each variant's product schema has it as a field). ✅
- Task: Update type-level tests in `types.test.ts`. ✅

### Phase 3: Update runtime — `dispatchSum`, `Zero`, `interpret`, `describe` ✅

- Task: Update `dispatchSum` in `store.ts` to work with the new `variants` array. Build or accept a variant lookup map from discriminant value → variant. ✅ (variantMap is now derived at construction time; dispatchSum uses it unchanged)
- Task: Update `interpret.ts` catamorphism sum case to build `SumVariants` from the new structure. The `byKey` closure should call `interpretImpl` on the matched variant. ✅ (uses variantMap unchanged — it's a derived field)
- Task: Update `Zero.structural` — remove the special-case discriminant injection. The discriminant field is now part of the variant's product, so `structural` walks it normally and gets the constraint value as the default. ✅
- Task: Update `describe.ts` to render discriminated sums from the new `variants` array. The label for each variant can be derived from the discriminant field's constraint value. ✅ (uses variantMap unchanged)

### Phase 4: Update interpreters — `plainInterpreter`, `withReadable`, `validate` ✅

- Task: Update `plainInterpreter.sum` to work with the new structure. The output now naturally includes the discriminant because the variant's product has the field. No injection needed. ✅ (no code change needed — variantMap is still present as derived field)
- Task: Update `withReadable.sum` if it has discriminated sum logic. `dispatchSum` returns the interpreted variant, which now includes the discriminant field in its product navigation surface. ✅ (no code change needed)
- Task: Update `validate` interpreter's sum case to work with the new structure. It already reads the discriminant from the store and validates the variant — the variant now declares the discriminant as a field, so validation is self-consistent. ✅ (no code change needed)
- Task: Verify that `doc()` now produces output that includes the discriminant field, and that `validate(schema, doc())` works without hacks. ✅

### Phase 5: Update all tests ✅

- Task: Update `types.test.ts` — discriminated sum type tests. ✅
- Task: Update `validate.test.ts` — discriminated sum validation tests. Expected outputs now include the discriminant field. ✅
- Task: Update `zero.test.ts` — discriminated sum zero test. The zero no longer needs special injection. ✅
- Task: Update `readable.test.ts`, `with-readable.test.ts`, `writable.test.ts`, `with-caching.test.ts` — discriminated sum tests. ✅
- Task: Update `describe.test.ts` — discriminated sum describe output. ✅
- Task: Update `interpret.test.ts` if it has discriminated sum tests. ✅ (added constructor validation tests)
- Task: Add a new round-trip test: `Zero.structural(schema)` → `validate(schema, zero)` → passes for schemas with discriminated sums. ✅
- Task: Add a new round-trip test: `doc()` → `validate(schema, doc())` → passes for schemas with discriminated sums. ✅

### Phase 6: Update `example/main.ts` and documentation ✅

- Task: Update `ProjectSchema` in `example/main.ts` to use the new discriminated union API. ✅
- Task: Remove the `{ ...store } as Record<string, unknown>` hack in the validation section — use `doc()` directly. ✅
- Task: Update `example/README.md` if it references the discriminated union API. ✅ (no references found)
- Task: Update TECHNICAL.md §Sum Types to document the new convention and rationale. ✅
- Task: Update TECHNICAL.md §Facade to document subscribe and subscribeTree. ✅
- Task: Update TECHNICAL.md File Map descriptions. ✅
- Task: Update `.plans/example-rewrite.md` to reflect the new API in its section descriptions. ✅

## Tests

### Round-trip correctness (highest value)

- `Zero.structural(schema)` → `validate(schema, result)` passes for a schema with a discriminated sum. This was broken before.
- Create a doc with `interpret` + `createWritableContext`, call `doc()`, pass to `validate` — must pass. This was broken before.
- `change(docA, fn)` → `applyChanges(docB, ops)` → `docA()` deep-equals `docB()` for docs with discriminated sums.

### Constructor validation

- `Schema.discriminatedUnion("type", [...])` throws if a variant lacks the discriminant field.
- `Schema.discriminatedUnion("type", [...])` throws if a variant's discriminant field is not a constrained string scalar.
- Valid construction succeeds and the schema is well-formed.

### Dispatch correctness

- `dispatchSum` with the new variant array dispatches to the correct variant based on store discriminant value.
- Fallback to first variant when discriminant is missing or unknown.

### `Plain<S>` type correctness

- `Plain<DiscriminatedSumSchema>` includes the discriminant field in each variant's type (verified via `expectTypeOf`).

### Validate correctness

- Valid data with correct discriminant and body passes.
- Invalid discriminant value fails with clear error.
- Missing discriminant field fails with clear error.
- Valid discriminant but invalid body fields fail.

### `describe` output

- `describe(schema)` renders discriminated unions with the discriminant values as variant labels.

## Transitive Effect Analysis

| Change | Affected | Impact |
|---|---|---|
| `DiscriminatedSumSchema` type change | Every file that imports or references this type | `schema.ts`, `interpreter-types.ts`, `interpret.ts`, `store.ts`, `zero.ts`, `describe.ts`, `plain.ts`, `with-readable.ts`, `validate.ts`, all test files with discriminated sums |
| `variantMap` is now a derived field on `DiscriminatedSumSchema` | `interpret.ts` (catamorphism), `store.ts` (`dispatchSum`), `zero.ts`, `validate.ts`, `describe.ts`, `plain.ts` | These sites still access `schema.variantMap` unchanged — it's built eagerly by the constructor. Only `zero.ts` needed a code change (removed special-case injection). |
| `Plain<S>` simplification | `interpreter-types.ts` | The mapped type `{ [K in keyof M]: ... }[keyof M]` becomes `Plain<V[number]>`. Downstream type inference changes — existing discriminated sum type tests must be updated. |
| `PlainDiscriminatedSumSchema` change | `schema.ts` type definition | Must match the new `DiscriminatedSumSchema` shape |
| `Zero.structural` loses special case | `zero.ts` | Simpler code. The zero test must update its expected output — the discriminant field now comes from the variant's product fields, not from injection. The actual output value should be identical. |
| `example/main.ts` uses new API | `example/main.ts`, `example/README.md` | Must update schema definition. The validation hack (`{ ...store }`) can be removed. |
| `@kyneta/core` | No direct references to `Schema.discriminatedUnion` in core | No impact — core uses its own IR types, not schema discriminated sums |
| `packages/perspective` | No direct references to `Schema.discriminatedUnion` | No impact |
| TECHNICAL.md | §Sum Types, §Interpreters | Must document the new convention |

## Resources for Implementation Context

- `packages/schema/src/schema.ts` — `DiscriminatedSumSchema`, `PlainDiscriminatedSumSchema`, `discriminatedSum()`, `discriminatedUnion()` constructors. The primary API surface being changed.
- `packages/schema/src/interpreter-types.ts` — `Plain<S>` type mapping. The `DiscriminatedSumSchema` branch must be simplified.
- `packages/schema/src/interpret.ts` — catamorphism `sum` case. Builds `SumVariants.byKey` from `variantMap`. Must change to use `variants` array.
- `packages/schema/src/store.ts` — `dispatchSum()`. Reads discriminant from store, looks up in `variantMap`. Must change to use `variants` array.
- `packages/schema/src/zero.ts` — `Zero.structural` sum case. Has special discriminant injection. Must be simplified.
- `packages/schema/src/describe.ts` — `walk` function, sum case. Iterates `variantMap` entries. Must change to use `variants` array.
- `packages/schema/src/interpreters/plain.ts` — `plainInterpreter.sum`. Reads discriminant, calls `variants.byKey`. Output will now naturally include discriminant.
- `packages/schema/src/interpreters/with-readable.ts` — `withReadable.sum`. Uses `dispatchSum`. No direct `variantMap` access, but output changes.
- `packages/schema/src/interpreters/validate.ts` — `validateInterpreter.sum`. Reads discriminant, validates against `variantMap`. Must change.
- `packages/schema/src/__tests__/validate.test.ts` — 7 discriminated sum tests. Expected outputs must include discriminant field.
- `packages/schema/src/__tests__/zero.test.ts` — 1 discriminated sum test. Expected output stays the same but the mechanism changes.
- `packages/schema/src/__tests__/types.test.ts` — type-level discriminated sum tests. Must update.
- `packages/schema/src/__tests__/readable.test.ts` — 2 discriminated sum tests. Must update schema declarations.
- `packages/schema/src/__tests__/with-readable.test.ts` — 5+ `dispatchSum` tests. Must update.
- `packages/schema/src/__tests__/writable.test.ts` — 3 discriminated sum tests. Must update.
- `packages/schema/src/__tests__/with-caching.test.ts` — 1 discriminated sum test. Must update.
- `packages/schema/src/__tests__/describe.test.ts` — 2 discriminated sum tests. Must update.
- `packages/schema/example/main.ts` — uses discriminated union in `ProjectSchema`. Must update.
- `packages/schema/TECHNICAL.md` — §Sum Types, §Interpreters.

## Alternatives Considered

### Keep the current API and have interpreters inject the discriminant at runtime

This would fix the round-trip without changing the API. `plainInterpreter.sum` and `withReadable.sum` would merge `{ [discriminant]: discValue }` into the variant's output, similar to what `Zero.structural` already does.

Rejected because:
- It leaves `@kyneta/schema` as the only TypeScript validator where the discriminant isn't declared in variant schemas.
- Developers must understand the unusual implicit key-to-value mapping.
- The variant schemas remain not self-describing — they can't be used standalone.
- Every interpreter that produces snapshots needs the same special-casing.
- `Plain<S>` still needs the `& { [_ in D]: K }` injection hack at the type level.

### Use a Valibot-style `variant` function with separate object schemas

Valibot uses `v.variant('type', [...])` with `v.object(...)` variants. This is identical in spirit to the Zod approach. Both require each variant to declare the discriminant.

The Zod and Valibot approaches are essentially the same pattern — the only difference is syntax (Zod uses `z.discriminatedUnion`, Valibot uses `v.variant`). We adopt the Zod naming convention (`discriminatedUnion`) since it's already our function name.

### Derive variant map at schema construction time vs. interpretation time

The variant map (discriminant value → variant schema) could be built eagerly in the `discriminatedUnion` constructor or lazily when first needed.

Building it eagerly in the constructor is better: it validates the schema structure upfront (every variant has the discriminant field, no duplicate discriminant values) and makes the map available to all consumers without re-computation. The constructor is the natural place for structural validation.

### Change `discriminant` field to accept a `Schema.literal()` instead of `Schema.string("value")`

We could introduce a `Schema.literal("text")` constructor. However, `Schema.string("text")` already exists and produces the right type (`ScalarSchema<"string", "text">` with `constraint: ["text"]`). Adding a separate `literal` constructor would be redundant and create two ways to express the same thing. The existing constrained scalar mechanism is sufficient.

## PR Stack

Since `@kyneta/schema` is pre-1.0 with no external consumers of `Schema.discriminatedUnion` (verified: `@kyneta/core` has zero references), and the blast radius is entirely within `packages/schema`, we can do this as a compact 3-PR stack rather than the slow introduce-migrate-remove pattern.

### PR 1 — refactor: redesign `DiscriminatedSumSchema` type, constructors, and `Plain<S>` ✅

**Phases 1 + 2. Type: API redesign (types + constructors, no interpreter behavior change yet).**

- Change `DiscriminatedSumSchema` from `{ discriminant, variantMap }` to `{ discriminant, variants }` where variants are `ProductSchema[]`
- Change `PlainDiscriminatedSumSchema` to match
- Update `discriminatedSum()` and `discriminatedUnion()` constructors to accept an array of product schemas; add runtime validation (discriminant field present, constrained string scalar)
- Add internal `buildVariantMap()` helper that derives `Record<string, ProductSchema>` from the variants array by reading each variant's discriminant field constraint
- Simplify `Plain<S>` — remove `& { [_ in D]: K }` injection, replace with `Plain<V[number]>`
- Update `LoroSchema.discriminatedUnion` and `LoroSchema.plain.discriminatedUnion` to match new signature
- Update `src/index.ts` exports if any types changed
- Update type-level tests in `types.test.ts`
- Add constructor validation tests (missing discriminant field throws, duplicate discriminant values throw, valid construction succeeds)

At this point the types compile and constructors work, but existing runtime code (`dispatchSum`, `interpret`, `Zero`, `describe`, `plainInterpreter`, `validate`) will need updating in the next PR. Tests that only exercise construction and type inference pass; tests that exercise runtime dispatch are updated in PR 2.

Reviewer sees: the new API shape, the type simplification, and proof that construction + type inference are correct.

### PR 2 — feat: update all runtime dispatch for new discriminated sum structure ✅

**Phases 3 + 4 + 5. Type: behavior change (runtime + all tests).**

- Update `dispatchSum` in `store.ts` to use `buildVariantMap()` (or accept pre-built map) instead of `schema.variantMap`
- Update `interpret.ts` catamorphism sum case — `byKey` closure uses the derived variant map
- Update `Zero.structural` — remove special-case discriminant injection (now falls out from walking variant product fields)
- Update `describe.ts` — derive variant labels from discriminant field constraints
- Update `plainInterpreter.sum` — output naturally includes discriminant (no injection needed)
- Update `withReadable.sum` — `dispatchSum` change flows through
- Update `validate.ts` sum case — use derived variant map for dispatch
- Update ALL discriminated sum tests across: `validate.test.ts`, `zero.test.ts`, `readable.test.ts`, `with-readable.test.ts`, `writable.test.ts`, `with-caching.test.ts`, `describe.test.ts`, `bottom.test.ts`
- Add round-trip tests: `Zero.structural(schema)` → `validate(schema, result)` passes; `doc()` → `validate(schema, doc())` passes
- All 850+ tests pass

Reviewer sees: the runtime now matches the types from PR 1. The round-trip tests are the crown jewels — they prove the type/runtime mismatch is resolved. Every test file that touches discriminated sums is updated in one logical unit, so the reviewer can verify completeness.

### PR 3 — docs: update example and TECHNICAL.md for new discriminated union API ✅

**Phase 6. Type: documentation only.**

- Update `ProjectSchema` in `example/main.ts` to use the new array-of-variants API
- Remove the `{ ...store } as Record<string, unknown>` validation hack — use `doc()` directly
- Update `example/README.md` if it references the discriminated union API
- Update TECHNICAL.md §Sum Types to document the new convention and rationale
- Update TECHNICAL.md §Interpreters if they reference discriminated sum dispatch
- Update `.plans/example-rewrite.md` to reflect the new API

Reviewer sees: the documentation catches up to the code. The example validation section is now clean — no hacks. The `npx tsx example/main.ts` output demonstrates the round-trip working.

### Stack visualization

```
PR 3  docs: example + TECHNICAL.md update
  ↑
PR 2  feat: runtime dispatch + all tests (the big one)
  ↑
PR 1  refactor: types, constructors, Plain<S>
  ↑
main
```

### Risk profile

- **PR 1** — Low risk. Type-level changes and constructors. No runtime behavior change. If it's wrong, it's a compile error.
- **PR 2** — Medium risk. Touches every interpreter's sum case and every discriminated sum test. But the changes are mechanical (replace `variantMap` access with derived map) and the test suite is comprehensive. The round-trip tests are the key correctness proof.
- **PR 3** — No risk. Documentation only.

### Safe revert boundaries

- Revert PR 3 alone: docs go stale, no code impact.
- Revert PR 2 + 3: runtime reverts to old behavior, types from PR 1 still compile but `Plain<S>` output won't match runtime (same bug as before, just in a different shape). Best to revert PR 1 too.
- Revert all three: clean rollback to current state.

In practice, PR 1 and PR 2 should be reviewed and landed together (PR 1 creates a transient state where types are ahead of runtime). PR 3 can follow independently.

## Changeset

This is a **breaking API change** to `Schema.discriminatedUnion`. The changeset touches:

- `packages/schema/src/schema.ts` — type + constructor changes
- `packages/schema/src/interpreter-types.ts` — `Plain<S>` simplification
- `packages/schema/src/interpret.ts` — catamorphism sum case
- `packages/schema/src/store.ts` — `dispatchSum`
- `packages/schema/src/zero.ts` — remove special case
- `packages/schema/src/describe.ts` — sum rendering
- `packages/schema/src/interpreters/plain.ts` — `plainInterpreter.sum`
- `packages/schema/src/interpreters/with-readable.ts` — if it has discriminated sum logic
- `packages/schema/src/interpreters/validate.ts` — `validateInterpreter.sum`
- `packages/schema/src/loro-schema.ts` — `LoroSchema.discriminatedUnion` signature
- `packages/schema/src/__tests__/*.test.ts` — all discriminated sum tests
- `packages/schema/example/main.ts` — schema definition + remove validation hack
- `packages/schema/example/README.md` — if it references the API
- `packages/schema/TECHNICAL.md` — §Sum Types, §Interpreters