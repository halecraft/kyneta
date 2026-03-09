# PlainSchema Type Constraint

## Background

The `packages/schema` package unifies Loro's two-layer grammar (container shapes vs. value shapes) into a single recursive `Schema` type with an open `annotated(tag, inner?)` mechanism for backend-specific semantics. The `LoroSchema` namespace provides a `plain` sub-namespace whose *intent* is to enforce Loro's well-formedness rule: CRDT containers (text, counter, movable list, tree) cannot nest inside plain value blobs.

In `@loro-extended/change`, this rule is enforced at the type level: `Shape.plain.struct<T extends Record<string, ValueShape>>` constrains fields to `ValueShape`, which is a closed union that excludes container shapes. `Shape.struct<T extends Record<string, ContainerOrValueShape>>` accepts both.

## Problem Statement

The `LoroSchema.plain.*` constructors currently accept the unconstrained `Schema` type — they are functionally identical to the base `Schema` constructors. The comment in `loro-schema.ts` (L82–88) explicitly acknowledges this as a "follow-up concern":

```ts
// The type-level narrowing that prevents nesting CRDT containers
// inside plain values is a follow-up concern for when the Loro
// adapter integrates. For now, they are functionally identical
// to the base Schema constructors.
```

This means the following compiles without error:

```ts
LoroSchema.plain.struct({
  text: LoroSchema.text(),       // ← CRDT annotation inside plain struct!
})
```

This violates Loro's invariant and is a regression from the guarantees `@loro-extended/change` provides.

## Success Criteria

1. `LoroSchema.plain.struct({ x: LoroSchema.text() })` produces a **TypeScript compile error**.
2. `LoroSchema.plain.struct({ x: LoroSchema.plain.string() })` continues to compile.
3. `LoroSchema.plain.struct({ x: Schema.struct({ y: Schema.string() }) })` continues to compile (nested structural plain data is fine).
4. `LoroSchema.plain.struct({ x: Schema.nullable(Schema.string()) })` compiles (sums of plain schemas are fine).
5. `LoroSchema.plain.struct({ x: Schema.nullable(LoroSchema.text()) })` produces a compile error (annotation inside sum inside plain struct).
6. `LoroSchema.plain.array(LoroSchema.counter())` produces a compile error.
7. The `Schema` type itself remains unconstrained — the grammar is backend-agnostic.
8. All 398 existing tests continue to pass.
9. New type-level tests verify the constraint at compile time.
10. The example's invalid `text: LoroSchema.text()` inside `plain.struct()` is fixed.

## Gap

There is no `PlainSchema` type. The `plain` sub-namespace methods all use `Schema` (aliased as `SchemaType`) as their generic constraint. TypeScript happily accepts any `Schema` node — including `AnnotatedSchema<"text">` — wherever `Schema` is expected.

## Phases

### Phase 1: Define `PlainSchema` type 🔴

Define a recursive type alias in `schema.ts` that represents the subset of `Schema` containing no `AnnotatedSchema` nodes. This type lives in the grammar layer because it is a *structural* subset of the grammar — it says "these constructors, recursively, with no annotations." It does not mention Loro.

**Tasks:**

- Define `PlainSchema` as a recursive union in `schema.ts` excluding `AnnotatedSchema` 🔴
- Export `PlainSchema` from `schema.ts` and `index.ts` 🔴

The type:

```ts
export type PlainSchema =
  | ScalarSchema
  | PlainProductSchema
  | PlainSequenceSchema
  | PlainMapSchema
  | PlainPositionalSumSchema
  | PlainDiscriminatedSumSchema

export interface PlainProductSchema<
  F extends Record<string, PlainSchema> = Record<string, PlainSchema>,
> {
  readonly _kind: "product"
  readonly fields: Readonly<F>
}

export interface PlainSequenceSchema<I extends PlainSchema = PlainSchema> {
  readonly _kind: "sequence"
  readonly item: I
}

export interface PlainMapSchema<I extends PlainSchema = PlainSchema> {
  readonly _kind: "map"
  readonly item: I
}

export interface PlainPositionalSumSchema<
  V extends readonly PlainSchema[] = readonly PlainSchema[],
> {
  readonly _kind: "sum"
  readonly variants: V
  readonly discriminant?: undefined
}

export interface PlainDiscriminatedSumSchema<
  D extends string = string,
  M extends Record<string, PlainSchema> = Record<string, PlainSchema>,
> {
  readonly _kind: "sum"
  readonly discriminant: D
  readonly variantMap: Readonly<M>
  readonly variants?: undefined
}
```

Key design decision: these are **structurally identical** to `ProductSchema`, `SequenceSchema`, etc., but with the recursive position constrained to `PlainSchema` instead of `Schema`. This means `ProductSchema<{ x: ScalarSchema<"string"> }>` is assignable to `PlainProductSchema` because `ScalarSchema` is in the `PlainSchema` union. But `ProductSchema<{ x: AnnotatedSchema<"text"> }>` is not, because `AnnotatedSchema` is excluded.

### Phase 2: Narrow `LoroSchema.plain` constructor signatures 🔴

Change the `plain` sub-namespace in `loro-schema.ts` to accept `PlainSchema` instead of `Schema` in recursive positions.

**Tasks:**

- Import the new `Plain*Schema` interfaces in `loro-schema.ts` 🔴
- Update `plain.struct` signature: `<F extends Record<string, PlainSchema>>(fields: F): PlainProductSchema<F>` 🔴
- Update `plain.record` signature: `<I extends PlainSchema>(item: I): PlainMapSchema<I>` 🔴
- Update `plain.array` signature: `<I extends PlainSchema>(item: I): PlainSequenceSchema<I>` 🔴
- Update `plain.union` signature: `<V extends PlainSchema[]>(...variants: [...V]): PlainPositionalSumSchema<V>` 🔴
- Update `plain.discriminatedUnion` signature: `<D extends string, M extends Record<string, PlainSchema>>(...)` 🔴
- Scalar constructors (`plain.string`, `plain.number`, etc.) need no change — `ScalarSchema` is already a `PlainSchema` 🔴

### Phase 3: Fix the example 🔴

The example at `example/main.ts` L213–220 has `text: LoroSchema.text()` inside `LoroSchema.plain.struct()`. This will now fail to compile, which is correct. Remove that field from the plain struct.

**Tasks:**

- Remove the `text: LoroSchema.text()` field from the tasks item schema in `example/main.ts` 🔴
- Verify the example compiles and runs 🔴

### Phase 4: Type-level tests 🔴

Add tests to `types.test.ts` that verify the constraint using `expectTypeOf`. These tests verify compile-time behavior, not runtime behavior.

**Tasks:**

- Test: `PlainSchema` accepts `ScalarSchema`, `ProductSchema<{x: ScalarSchema}>`, `SequenceSchema<ScalarSchema>`, etc. 🔴
- Test: `PlainSchema` rejects `AnnotatedSchema<"text">`, `AnnotatedSchema<"counter">`, `AnnotatedSchema<"movable", SequenceSchema>` 🔴
- Test: `PlainSchema` rejects `ProductSchema<{ x: AnnotatedSchema<"text"> }>` (annotation nested inside product) 🔴
- Test: `LoroSchema.plain.struct({ x: LoroSchema.plain.string() })` compiles (positive) 🔴
- Test: `LoroSchema.plain.struct({ x: LoroSchema.text() })` does not compile (negative — use `// @ts-expect-error` or `expectTypeOf(...).not.toMatchTypeOf(...)`) 🔴
- Test: `PlainProductSchema` is assignable to `Schema` (plain schemas are still schemas) 🔴

### Phase 5: Documentation 🔴

**Tasks:**

- Update TECHNICAL.md "Composition Constraints Are Backend-Specific" section to describe `PlainSchema` and how it works 🔴
- Update the `LoroSchema.plain` JSDoc in `loro-schema.ts` to reference the type constraint 🔴
- Remove the "follow-up concern" comment from `loro-schema.ts` L82–88 🔴

## Tests

All tests are type-level (compile-time), added to `src/__tests__/types.test.ts`. Use `expectTypeOf` from vitest.

**Positive cases (should compile):**

- `ScalarSchema<"string">` extends `PlainSchema`
- `PlainProductSchema<{ x: ScalarSchema<"number"> }>` extends `PlainSchema`
- `PlainSequenceSchema<ScalarSchema<"string">>` extends `PlainSchema`
- Nested: `PlainProductSchema<{ items: PlainSequenceSchema<ScalarSchema> }>` extends `PlainSchema`
- `PlainProductSchema` extends `Schema` (subtype relationship preserved)
- Return type of `LoroSchema.plain.struct({ x: ... })` extends `PlainSchema`

**Negative cases (should NOT compile):**

- `AnnotatedSchema<"text">` does NOT extend `PlainSchema`
- `ProductSchema<{ x: AnnotatedSchema<"text"> }>` does NOT extend `PlainProductSchema`
- `AnnotatedSchema<"doc", ProductSchema>` does NOT extend `PlainSchema`

## Transitive Effect Analysis

### `schema.ts` → all interpreters

`PlainSchema` is a new export. It does not change the existing `Schema` type. All interpreters (`plainInterpreter`, `writableInterpreter`, `validateInterpreter`, `withChangefeed`) accept `Schema` in their signatures, which remains unchanged. `PlainSchema extends Schema` structurally (every `PlainSchema` value is also a `Schema` value), so passing a `PlainSchema` to `interpret()` works without casts.

### `loro-schema.ts` → `example/main.ts`

The example has an invalid schema that currently compiles. After the change, it will fail to compile. This is a breaking change to the example, fixed in Phase 3.

### `loro-schema.ts` → consumers of `LoroSchema.plain.*` return types

The return types of `plain.struct`, `plain.array`, `plain.record` change from `ProductSchema<F>` to `PlainProductSchema<F>`, etc. Since `PlainProductSchema<F>` has identical runtime shape to `ProductSchema<F>` (same `_kind`, same `fields`), and since `PlainProductSchema extends ProductSchema` structurally, this is backward compatible for:
- `interpret()` — accepts `Schema`, which `PlainProductSchema` satisfies
- `describe()` — accepts `Schema`
- `Zero.structural()` — accepts `Schema`
- `validate()` — accepts `Schema`
- `Plain<S>` type — matches on `_kind: "product"`, which `PlainProductSchema` has
- `Writable<S>` type — same

The key question: does `Plain<PlainProductSchema<F>>` resolve the same as `Plain<ProductSchema<F>>`? Yes — `Plain<S>` checks `S extends ProductSchema<infer F>`, and `PlainProductSchema<F>` satisfies this because it has `_kind: "product"` and `fields: F`. Same for `Writable<S>`.

### No runtime changes

`PlainSchema` is type-only. No runtime code changes. The `plain.*` constructor functions continue to call the same `Schema.*` constructors internally — only the return type annotations narrow.

## Resources for Implementation Context

- `packages/schema/src/schema.ts` — `Schema` type, all structural interfaces, constructors
- `packages/schema/src/loro-schema.ts` — `LoroSchema` namespace, `plain` sub-namespace (the target of this change)
- `packages/schema/src/interpreters/writable.ts` — `Plain<S>` and `Writable<S>` conditional types (must remain compatible)
- `packages/schema/src/index.ts` — barrel exports (new types must be exported)
- `packages/schema/src/__tests__/types.test.ts` — existing type-level tests (add new tests here)
- `packages/schema/example/main.ts` — L213–220, the invalid schema to fix
- `packages/schema/TECHNICAL.md` — documentation to update
- `packages/change/src/shape.ts` — L908 (`Shape.plain.struct<T extends Record<string, ValueShape>>`) — reference implementation of the same constraint in the old system

## Alternatives Considered

### Brand/phantom type on `Schema` itself

Add a type parameter `Schema<Kind extends "plain" | "container" | "any">` to the grammar type, then constrain `plain.struct` to accept `Schema<"plain">`. Rejected because:

- Pollutes the backend-agnostic grammar with backend-specific classification
- Every generic that touches `Schema` would need to carry the `Kind` parameter
- A different backend might have 3 or more classifications, or none at all
- The phantom type adds no runtime value — it's pure type-level bureaucracy that infects the entire API surface

### Enumerated tag exclusion (`Exclude<Schema, AnnotatedSchema>`)

Use `Exclude<Schema, AnnotatedSchema>` as the constraint. Rejected because:

- This is shallow — it prevents `AnnotatedSchema` at the top level but not nested inside a `ProductSchema` or `SequenceSchema`
- The whole point is recursive exclusion: `plain.struct({ items: Schema.list(LoroSchema.text()) })` must also fail

### Keep it as a naming convention (status quo)

Leave `plain.struct` accepting `Schema` and rely on developers not making mistakes. Rejected because:

- This is exactly what `@loro-extended/change` avoids with `ValueShape` vs `ContainerOrValueShape`
- The example already demonstrates the failure mode — `text()` inside `plain.struct()` compiled and nobody noticed
- TypeScript's type system can enforce this; declining to use it leaves a known class of bugs undetected

### Define `PlainSchema` in `loro-schema.ts` instead of `schema.ts`

Keep it next to the `LoroSchema.plain` constructors that use it. Rejected because:

- `PlainSchema` is structurally defined (no annotated nodes) — it references only grammar types, not Loro-specific concepts
- Other backends might want the same constraint (e.g. a Firestore backend with its own annotation tags)
- Placing it in `schema.ts` follows the existing pattern: the grammar file defines the types, backend files constrain them