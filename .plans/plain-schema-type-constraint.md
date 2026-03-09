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

## Key Design Insight

The `Plain*Schema` interfaces are needed **only for the recursive type definition** of `PlainSchema`. The constructor **return types stay as the original** `ProductSchema<F>`, `SequenceSchema<I>`, etc. — only the **parameter constraints** narrow to `PlainSchema`.

This works because of structural subtyping: `ProductSchema<{ x: ScalarSchema<"string"> }>` is structurally assignable to `PlainProductSchema` (since `ScalarSchema` ∈ `PlainSchema`), while `ProductSchema<{ x: AnnotatedSchema<"text"> }>` is not (since `AnnotatedSchema` ∉ `PlainSchema`). The original return types remain compatible with `Plain<S>`, `Writable<S>`, `interpret()`, `describe()`, `validate()`, and `Zero.structural()` — no downstream changes required.

Verified empirically with standalone TypeScript compilation (see previous session).

## Phases

### Phase 1: Define `PlainSchema` type and narrow constructors ✅

Define a recursive type alias in `schema.ts` that represents the subset of `Schema` containing no `AnnotatedSchema` nodes. Then narrow the `LoroSchema.plain` constructor parameter types in `loro-schema.ts`.

**Tasks:**

- Define `PlainSchema` and supporting `Plain*Schema` interfaces in `schema.ts` ✅
- Export `PlainSchema` and supporting interfaces from `schema.ts` and `index.ts` ✅
- Import new types in `loro-schema.ts` ✅
- Narrow `plain.struct`, `plain.record`, `plain.array`, `plain.union`, `plain.discriminatedUnion` parameter constraints to `PlainSchema` ✅
- Keep return types as the original `ProductSchema<F>`, `SequenceSchema<I>`, `MapSchema<I>`, etc. ✅
- Scalar constructors need no change — `ScalarSchema` is already a `PlainSchema` ✅
- Remove the "follow-up concern" comment from `loro-schema.ts` L82–88 ✅
- Update the `plain` sub-namespace JSDoc ✅

The types to add in `schema.ts`:

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

The constructor signature changes in `loro-schema.ts` (parameter types only — return types unchanged):

```ts
// Before:
struct<F extends Record<string, SchemaType>>(fields: F): ProductSchema<F>

// After:
struct<F extends Record<string, PlainSchema>>(fields: F): ProductSchema<F>
```

### Phase 2: Fix example and add type-level tests ✅

The example at `example/main.ts` L213–220 has `text: LoroSchema.text()` inside `LoroSchema.plain.struct()`. This will now fail to compile, which is correct. Fix it and add tests proving the constraint.

**Tasks:**

- Remove the `text: LoroSchema.text()` field from the tasks item schema in `example/main.ts` ✅
- Verify the example compiles ✅
- Add type-level tests to `types.test.ts` verifying the constraint ✅

### Phase 3: Documentation ✅

**Tasks:**

- Update TECHNICAL.md "Composition Constraints Are Backend-Specific" section to describe how `PlainSchema` enforces the constraint ✅

## Tests

All new tests are type-level (compile-time), added to `src/__tests__/types.test.ts`. Use `expectTypeOf` from vitest.

**Positive cases (should compile):**

- `ScalarSchema<"string">` extends `PlainSchema`
- `PlainProductSchema<{ x: ScalarSchema<"number"> }>` extends `PlainSchema`
- `PlainSequenceSchema<ScalarSchema<"string">>` extends `PlainSchema`
- Nested: `PlainProductSchema<{ items: PlainSequenceSchema<ScalarSchema> }>` extends `PlainSchema`
- `PlainProductSchema` extends `Schema` (subtype relationship preserved)
- Return type of `LoroSchema.plain.struct({ x: LoroSchema.plain.string() })` extends `Schema`
- `Schema.nullable(Schema.string())` result extends `PlainSchema` (sums of plain are plain)
- `LoroSchema.plain.struct({ bio: Schema.nullable(Schema.string()) })` compiles (nullable inside plain struct)

**Negative cases (should NOT compile):**

- `AnnotatedSchema<"text">` does NOT extend `PlainSchema`
- `ProductSchema<{ x: AnnotatedSchema<"text"> }>` does NOT extend `PlainProductSchema`
- `AnnotatedSchema<"doc", ProductSchema>` does NOT extend `PlainSchema`
- `LoroSchema.plain.struct({ x: LoroSchema.text() })` fails to compile (via `@ts-expect-error`)
- `LoroSchema.plain.array(LoroSchema.counter())` fails to compile
- `Schema.nullable(LoroSchema.text())` result does NOT extend `PlainSchema` (annotation inside sum)

## Transitive Effect Analysis

### `schema.ts` → all interpreters

`PlainSchema` is a new export. It does not change the existing `Schema` type. All interpreters accept `Schema`, which remains unchanged. Every `PlainSchema` value is also a `Schema` value (structural subtype), so passing plain schemas to `interpret()` works without casts.

### `loro-schema.ts` → `example/main.ts`

The example has an invalid schema that currently compiles. After the change, it will fail to compile. Fixed in Phase 2.

### `loro-schema.ts` → consumers of `LoroSchema.plain.*` return types

Return types are **unchanged** — still `ProductSchema<F>`, `SequenceSchema<I>`, `MapSchema<I>`, etc. This means:

- `interpret()` — accepts `Schema`, which these satisfy ✓
- `describe()` — accepts `Schema` ✓
- `Zero.structural()` — accepts `Schema` ✓
- `validate()` — accepts `Schema` ✓
- `Plain<S>` — matches on `S extends ProductSchema<infer F>`, which `ProductSchema<F>` trivially satisfies ✓
- `Writable<S>` — same ✓

No downstream type changes. No runtime changes. The `plain.*` constructor functions continue to call `Schema.*` internally — only parameter type annotations narrow.

### No new unused code / no deprecations

This change is purely additive (new types) plus a constraint tightening on existing signatures. No code is deprecated, removed, or made unused.

## Resources for Implementation Context

- `packages/schema/src/schema.ts` — `Schema` type, all structural interfaces, constructors
- `packages/schema/src/loro-schema.ts` — `LoroSchema` namespace, `plain` sub-namespace (target)
- `packages/schema/src/interpreters/writable.ts` — `Plain<S>` and `Writable<S>` conditional types (must remain compatible — verified, no changes needed)
- `packages/schema/src/index.ts` — barrel exports (new types must be exported)
- `packages/schema/src/__tests__/types.test.ts` — existing type-level tests (add new tests here)
- `packages/schema/example/main.ts` — L213–220, the invalid schema to fix
- `packages/schema/TECHNICAL.md` — documentation to update
- `packages/change/src/shape.ts` — L908 (`Shape.plain.struct<T extends Record<string, ValueShape>>`) — reference implementation in the old system

## PR Stack

### PR 1: `(packages/schema) feat: PlainSchema type constraint for LoroSchema.plain namespace`

**Type:** Feature (new abstraction + constraint tightening)

Contains all three phases — this change is small enough (type definitions + signature narrowing + example fix + tests + docs) to be a single reviewable unit. The phases are not independently shippable: defining `PlainSchema` without narrowing the constructors is dead code, and narrowing the constructors without fixing the example breaks the build.

**Commits:**

1. **feat: define PlainSchema type and narrow LoroSchema.plain constructors** — `schema.ts` (new types), `loro-schema.ts` (narrowed signatures + updated JSDoc), `index.ts` (exports)
2. **fix: remove CRDT annotation from plain struct in example** — `example/main.ts`
3. **test: type-level tests for PlainSchema constraint** — `types.test.ts`
4. **docs: document PlainSchema composition constraint in TECHNICAL.md** — `TECHNICAL.md`

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

### Return `Plain*Schema` types from constructors

Have `plain.struct` return `PlainProductSchema<F>` instead of `ProductSchema<F>`. Rejected because:

- `Plain<S>` and `Writable<S>` match on `S extends ProductSchema<infer F>` — introducing a new nominal-looking interface risks inference breakage
- The `Plain*Schema` interfaces are structurally identical to the originals, so the return type narrowing provides no additional safety
- Keeping return types as the originals means zero downstream type changes — `interpret()`, `describe()`, `validate()`, `Zero.structural()` all work unchanged
- The `Plain*Schema` types serve their purpose purely as parameter constraints; leaking them into the API surface adds cognitive overhead

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