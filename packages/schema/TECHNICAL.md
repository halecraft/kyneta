# @kyneta/schema — Technical Documentation

This package implements the Schema Interpreter Algebra described in `theory/interpreter-algebra.md`. It has no runtime dependencies and is consumed by `@kyneta/cast` (compiler runtime) and `examples/recipe-book` (full-stack SSR demo). The architecture provides a composable interpreter stack for schema-driven reactive documents with pluggable backing stores via the Substrate abstraction.

## The Key Insight: Unified Schema Grammar

The predecessor shape system (from the previous `change` package) has two separate recursive grammars: **container shapes** (text, counter, list, struct, record, tree, doc) and **value shapes** (string, number, boolean, structValue, arrayValue, recordValue, union, discriminatedUnion, any). These mirror each other structurally — both have products, sequences, and maps.

This dual-layer split is a **Loro implementation detail**, not a schema-structural property. Loro distinguishes "containers" (CRDTs with identity) from "values" (opaque blobs inside containers). But a different backend would draw the boundary differently or not at all.

The spike collapses both layers into **one recursive type** with five structural constructors plus an open annotation mechanism:

```
SchemaF<A> =
  | Scalar(kind, constraint?)       — leaf: string, number, boolean, null, bytes, any
  | Product({ k₁: A, k₂: A, … })  — fixed-key record (struct, doc)
  | Sequence(A)                     — ordered collection (list)
  | Map(A)                          — dynamic-key collection (record)
  | Sum(A[])                        — union / discriminated union
  | Annotated(tag, A?)              — semantic enrichment (text, counter, movable, tree, doc)
```

Annotations attach backend semantics without changing the recursive structure. `LoroSchema.text()` is `annotated("text")`. `LoroSchema.counter()` is `annotated("counter")`. `LoroSchema.movableList(item)` is `annotated("movable", sequence(item))`. The annotation set is open — third-party backends define their own tags.

### Two-Namespace Design: `Schema` + `LoroSchema`

The constructor namespace is split into two layers:

**`Schema`** — the backend-agnostic base grammar. Contains scalars (`string`, `number`, `boolean`, `null`, `undefined`, `bytes`, `any`), structural composites (`struct`, `list`, `record`, `union`, `discriminatedUnion`, `nullable`), the `doc` root constructor, and low-level grammar-native constructors (`scalar`, `product`, `sequence`, `map`, `sum`, `discriminatedSum`, `annotated`).

**`LoroSchema`** — the Loro-specific developer API. Re-exports everything from `Schema` and adds Loro annotation constructors (`text`, `counter`, `movableList`, `tree`) plus a `plain` sub-namespace with composition-constrained constructors that enforce "no CRDTs inside value blobs" at the type level.

```
Schema                          LoroSchema
├── string()  number()  ...     ├── (all of Schema)
├── struct()  list()  record()  ├── text()  counter()
├── union()  nullable()         ├── movableList()  tree()
├── discriminatedUnion()        └── plain.string()  plain.struct()  ...
├── doc()
└── scalar()  product()  ...
```

A Loro developer imports only `LoroSchema` — one namespace, one import. A backend-agnostic library imports `Schema`. The interpreter dispatch is identical regardless of which constructor produced the node — interpreters dispatch on `_kind` and annotation tag strings, not constructor origin.

### Composition Constraints Are Backend-Specific

Even with a unified grammar, Loro imposes validity rules (e.g. you can't nest a CRDT container inside a plain value blob). These are **well-formedness rules** — context-sensitive constraints layered on the context-free grammar. The solution: the internal `Schema` type is unconstrained; the developer-facing constructor API (`LoroSchema.text()`, `LoroSchema.plain.struct()`, etc.) uses TypeScript's type system to enforce backend-specific constraints at build time.

**`PlainSchema` — the annotation-free subset.** The grammar defines `PlainSchema`, a recursive type that includes all structural kinds (`ScalarSchema`, `ProductSchema`, `SequenceSchema`, `MapSchema`, `SumSchema`) but excludes `AnnotatedSchema`. Each structural kind has a `Plain*` counterpart (`PlainProductSchema`, `PlainSequenceSchema`, etc.) where the recursive position is narrowed from `Schema` to `PlainSchema`. These types exist solely for the recursive definition — they are not used in return positions.

The `LoroSchema.plain.*` constructors use `PlainSchema` as their **parameter constraint** while keeping the original `ProductSchema<F>`, `SequenceSchema<I>`, etc. as **return types**:

```ts
// Parameter type narrowed to PlainSchema — rejects annotations:
struct<F extends Record<string, PlainSchema>>(fields: F): ProductSchema<F>

// This compiles:
LoroSchema.plain.struct({ name: LoroSchema.plain.string() })

// This is a compile error — AnnotatedSchema ∉ PlainSchema:
LoroSchema.plain.struct({ title: LoroSchema.text() })
```

The constraint is recursive: `LoroSchema.plain.struct({ items: Schema.list(LoroSchema.text()) })` also fails because `SequenceSchema<AnnotatedSchema<"text">>` is not assignable to `PlainSequenceSchema` (which requires `PlainSchema` items).

By keeping return types as the original interfaces, all downstream consumers — `interpret()`, `Plain<S>`, `Writable<S>`, `describe()`, `validate()`, `Zero.structural()` — work unchanged. The `PlainSchema` types are invisible at the API surface; they are felt only when you try to pass an annotation where plain data is expected.

This mirrors the approach in the predecessor shape system, where `Shape.plain.struct<T extends Record<string, ValueShape>>` constrains to `ValueShape` (excluding `ContainerShape`), while `Shape.struct<T extends Record<string, ContainerOrValueShape>>` accepts both.

### Annotations Unify Leaf CRDTs and Structural Modifiers

In the old grammar, `text` and `counter` were node kinds alongside `list` and `struct`. Mathematically, `text` is "a string with collaborative editing semantics" — an annotation on a scalar, not a distinct structural kind. Similarly, `movableList` is "a sequence with move semantics." The annotation mechanism captures this uniformly.

## Architecture

### The `@kyneta/schema/basic` Subpath Export

`@kyneta/schema` has a two-layer design:

- **Layer 1 (`@kyneta/schema`)** — the composable toolkit for power users and library authors. Exports the full interpreter algebra, substrate primitives, symbols, and all building blocks. This is the layer documented in the rest of this file.
- **Layer 2 (`@kyneta/schema/basic`)** — a curated, batteries-included API for application developers. Backed by `PlainSubstrate`. Hides the interpreter machinery behind a small, opinionated surface.

#### What `basic/` exports

| Category | Exports |
|----------|---------|
| Document lifecycle | `createDoc`, `createDocFromSnapshot` |
| Schema | `Schema` (re-exported constructor namespace) |
| Mutation | `change`, `applyChanges` |
| Observation | `subscribe`, `subscribeNode` |
| Sync | `version`, `delta`, `exportSnapshot` |
| Validation | `validate`, `tryValidate` |
| Utilities | `Zero`, `describe` |
| Types | `Ref`, `RRef`, `Plain`, `Seed`, `Op`, `Changeset`, `SubstratePayload`, schema node types |

#### What's deliberately excluded

- **Interpreter machinery** — `interpret`, `readable`, `writable`, `changefeed`, `bottomInterpreter`, `withNavigation`, `withReadable`, `withCaching`, `withWritable`, `withChangefeed`, `InterpretBuilder`, `InterpreterLayer`, etc.
- **Substrate primitives** — `plainSubstrateFactory`, `createPlainSubstrate`, `plainContext`, `PlainVersion`.
- **Symbols** — `CHANGEFEED`, `TRANSACT`, `CALL`, `INVALIDATE`.
- **Other internals** — `LoroSchema`, change constructors (`ChangeBase`, `ScalarChange`, etc.), step functions, store utilities (`readByPath`, `writeByPath`, `applyChangeToStore`), capability types (`HasCall`, `HasRead`, `HasTransact`, `HasChangefeed`).

#### `registerDoc` internal helper

Both `createDoc` and `createDocFromSnapshot` delegate to a shared `registerDoc` helper in `basic/create.ts`. It:

1. Runs `interpret(schema, substrate.context()).with(readable).with(writable).with(changefeed).done()` to build the full five-layer interpreter stack.
2. Stores the `substrate` in a **module-scoped `WeakMap`** keyed by the returned ref, enabling `basic/sync.ts` to retrieve the substrate for sync operations without exposing it to callers.

`getSubstrate` is exported from `basic/create.ts` for cross-module use by `basic/sync.ts` (which needs the substrate for `version`, `delta`, `exportSnapshot`) but is **not** re-exported from the `basic/index.ts` barrel — it's an internal implementation detail.

#### Naming rationale

"basic" was chosen over "plain" because "plain" already has four meanings in the codebase:

1. `Plain<S>` — the type-level plain-JS snapshot of a schema
2. `PlainSchema` / `LoroSchema.plain.*` — the plain (non-Loro) schema namespace
3. `PlainSubstrate` / `plainContext` / `PlainVersion` — the plain-JS substrate implementation
4. `plainInterpreter` — the eager deep-snapshot interpreter

"Basic" has zero collisions and communicates the right thing: this is the simple, default entry point.

> **Note:** `plainContext` remains the recommended test helper for Layer 1 tests (direct store control, no facade). `createDoc` is the Layer 2 entry point for application code.

### Schema (`src/schema.ts`)

One recursive `Schema` type discriminated by `_kind`:

| `_kind` | Constructor | Description |
|---|---|---|
| `scalar` | `Schema.scalar("string")` | Terminal value — `ScalarKind` is a string union, not a recursive type |
| `product` | `Schema.product({ x: ..., y: ... })` | Fixed-key record. Optional `discriminantKey?: string` — see below |
| `sequence` | `Schema.sequence(item)` | Ordered collection |
| `map` | `Schema.map(item)` | Dynamic-key collection |
| `sum` | `Schema.sum([a, b])` | Positional or discriminated union |
| `annotated` | `Schema.annotated("text")` | Open tag + optional inner schema + optional metadata |

Developer-facing sugar produces nodes in this grammar:

| Sugar | Produces | Notes |
|---|---|---|
| `Schema.string()` | `scalar("string")` | |
| `Schema.number(1, 2, 3)` | `scalar("number", [1,2,3])` | Constrained — see below |
| `Schema.struct(fields)` | `product(fields)` | |
| `Schema.list(item)` | `sequence(item)` | |
| `Schema.record(item)` | `map(item)` | |
| `Schema.union(a, b)` | `sum([a, b])` | Positional union |
| `Schema.discriminatedUnion(key, map)` | `sum(key, map)` | Keyed variants |
| `Schema.nullable(inner)` | `sum([scalar("null"), inner])` | Sugar for `union(null, X)` |
| `Schema.doc(fields)` | `annotated("doc", product(fields))` | Root document |

Loro-specific annotation constructors live in `LoroSchema` (`src/loro-schema.ts`):

| Sugar | Produces |
|---|---|
| `LoroSchema.text()` | `annotated("text")` |
| `LoroSchema.counter()` | `annotated("counter")` |
| `LoroSchema.movableList(item)` | `annotated("movable", sequence(item))` |
| `LoroSchema.tree(nodeData)` | `annotated("tree", nodeData)` |

### `ProductSchema.discriminantKey`

`ProductSchema` has an optional `discriminantKey?: string` field. It is `undefined` for standalone products (structs, doc inners, etc.) and is set only by the `discriminatedSum` constructor, which stamps each variant with the discriminant key after `buildVariantMap` succeeds. This marker tells interpreter layers which field is the discriminant so they can special-case it at runtime (raw store read instead of a full ref — see [withNavigation](#withnavigation-srcinterpreterswith-navigationts) and [withCaching](#withcaching-srcinterpreterswith-cachingts)).

Since `Schema.struct()` creates fresh objects, there is no risk of `discriminantKey` leaking into standalone products.

### Scalar Value-Domain Constraints

`ScalarSchema<K, V>` has an optional second type parameter `V` (defaults to `ScalarPlain<K>`) and an optional `constraint?: readonly V[]` field. When present, the constraint lists allowed values and narrows both the type level and runtime validation:

```ts
Schema.string("public", "private")
// → ScalarSchema<"string", "public" | "private">
// → Plain<...> = "public" | "private"
// → Writable<...> = ScalarRef<"public" | "private">
// → constraint: ["public", "private"]
```

The constraint field is read by:
- **`zeroInterpreter` / `Zero.structural`** — uses `constraint[0]` as the default instead of the generic kind default
- **`validateInterpreter`** — checks value is in the constraint array
- **`describe()`** — renders `string("public" | "private")` instead of just `string`

Unconstrained scalars (`Schema.string()` with no arguments) have no `constraint` field at runtime and `V` defaults to the full kind type (`string`). This preserves full backward compatibility.

### Sum Types: Union, Discriminated Union, Nullable

The grammar has one `sum` kind with two flavors:

**Positional sum** — `PositionalSumSchema` with a `variants: Schema[]` array. Created by `Schema.union(a, b, ...)`. The validate interpreter tries each variant in order with error rollback.

**Discriminated sum** — `DiscriminatedSumSchema` with a `discriminant: string` key and `variants: ProductSchema[]` array. Created by `Schema.discriminatedUnion(key, variants)`. Follows the Zod/Valibot convention: each variant is a `ProductSchema` that explicitly declares the discriminant as a constrained string scalar field. The variant map key (`"text"`, `"image"`) comes from the field's constraint value, not from an external object key.

```ts
Schema.discriminatedUnion("type", [
  Schema.struct({ type: Schema.string("text"), body: LoroSchema.text() }),
  Schema.struct({ type: Schema.string("image"), url: Schema.string() }),
])
```

The constructor validates: each variant must have the discriminant field, the field must be a constrained string scalar, and no two variants may share a discriminant value. A derived `variantMap: Record<string, ProductSchema>` is built eagerly by `buildVariantMap()` for O(1) dispatch.

This design means the discriminant is a real field in the schema tree — interpreters that walk variant fields naturally include it in their output. `Plain<S>` is a simple `Plain<V[number]>` union (no type-level injection needed). `Zero.structural` produces the discriminant value from the field's constraint. The `doc() → validate()` round-trip closes without special-casing.

**Nullable** — `Schema.nullable(inner)` is sugar for `Schema.union(Schema.null(), inner)`. It produces a positional sum with exactly two variants where the first is `scalar("null")`. The `describe()` function and validate interpreter detect this pattern and render/report it as `nullable<inner>` rather than a generic union.

### Path Representation

The catamorphism accumulates a typed `Path` (array of `PathSegment` discriminated unions) as it descends:

```ts
type PathSegment =
  | { readonly type: "key"; readonly key: string }
  | { readonly type: "index"; readonly index: number }
```

All interpreters use this single representation. The key-vs-index distinction enables:
- Human-readable error paths: `messages[0].author` (not `messages.0.author`)
- Correct store access for both objects and arrays

The `readByPath(store, path)` utility (exported from `store.ts`) accepts `unknown` as its first parameter so all interpreters — including `plainInterpreter` with its `unknown` context and `validateInterpreter` with its `ValidateContext` — can use it without casts.

The `formatPath(path)` utility (exported from `validate.ts`) converts a typed `Path` to a human-readable string for error reporting. Empty path → `"root"`.

### Changes (`src/change.ts`)

Changes are **interpretation-level** — the schema says "sequence," the backend picks the change vocabulary. Built-in change types use the retain/insert/delete cursor encoding:

- `TextChange` — instructions over characters
- `SequenceChange<T>` — instructions over array items
- `MapChange` — key-level set/delete
- `ReplaceChange<T>` — wholesale scalar swap
- `IncrementChange` — counter delta
- `TreeChange` — create/delete/move tree nodes

Changes are an open protocol (`ChangeBase` with string `type` discriminant). Third-party backends extend with their own types.

### Changefeed (`src/changefeed.ts`)

A changefeed is a coalgebra: `{ current: S, subscribe(cb: (changeset: Changeset<C>) => void): () => void }`. One symbol (`CHANGEFEED = Symbol.for("kyneta:changefeed")`) replaces the previous two-symbol `SNAPSHOT` + `REACTIVE` design. WeakMap-based caching preserves referential identity (`ref[CHANGEFEED] === ref[CHANGEFEED]`).

**`Changeset<C>` — the unit of batch delivery.** Subscribers always receive a `Changeset`, never an individual change. A changeset wraps one or more changes with optional batch-level metadata:

- `changes: readonly C[]` — the individual changes in the batch.
- `origin?: string` — provenance of the batch (e.g. `"sync"`, `"undo"`, `"local"`). Individual changes do not carry provenance — the batch does.

Auto-commit (single mutation outside a transaction) delivers a degenerate `Changeset` of exactly one change. Transactions and `applyChanges` deliver multi-change batches. The subscriber API is uniform regardless of batch size.

**`Op<C>` — relative path for tree observation.** Composite refs (products, sequences, maps) implement `ComposedChangefeed`, which adds `subscribeTree(cb: (changeset: Changeset<Op<C>>) => void)`. Each `Op` carries `{ path: Path, change: C }` — the path is relative from the subscription point to where the change occurred. `subscribeTree` is a strict superset of `subscribe` (tree subscribers also see own-path changes with `path: []`).

**`Changeset<Op>` ≅ `(Op[], origin)` isomorphism.** When subscribing at the root, `Op.path` equals the absolute path. The output of tree-level observation (the facade's `subscribe`, which delegates to `ComposedChangefeed.subscribeTree`) can be round-tripped as input to `applyChanges` (modulo path relativity for subtree subscriptions). This is a powerful property for sync: capture tree events on one document, reconstruct `Op[]`, apply to another. Note: tree subscribers receive one `Changeset<Op>` per affected child path (not one combined changeset per flush), so reconstruction uses `flatMap` across changesets.

### Step (`src/step.ts`)

Pure state transitions: `(State, Change) → State`. Dispatches on the change's `type` discriminant, not on the schema — step is change-driven and schema-agnostic. Enables optimistic UI, time travel, testing without a CRDT runtime, and read-your-writes in transaction mode.

### Zero (`src/zero.ts`)

Default values separated from the schema. `Zero.structural(schema)` derives mechanical defaults by walking the grammar. When a scalar has a non-empty `constraint`, `constraint[0]` is used as the default instead of the generic kind default. `Zero.overlay(primary, fallback, schema)` performs deep structural merge — products recurse per-key, leaves use `firstDefined`. This replaces the `_placeholder` mechanism on shapes.

### Describe (`src/describe.ts`)

Human-readable indented tree view of a schema. Pure function over schema data — no interpreter machinery, no dependencies beyond the schema types.

Features:
- **Constrained scalars** render as `string("public" | "private")` instead of just `string`
- **Nullable sugar** is recognized: `sum([scalar("null"), X])` renders as `nullable<X>` instead of `union`
- **Inline rendering** for simple types inside angle brackets: `list<string>`, `record<number>`, `movable-list<string>`, `nullable<string>`
- **Nested indentation** for complex types

### Interpret (`src/interpret.ts`)

The generic catamorphism. `Interpreter<Ctx, A>` has one case per structural kind. The `interpret()` function has two overloads:

**Three-arg (direct):** `interpret(schema, interpreter, ctx)` walks the tree and returns the raw carrier type `A`. The walker builds:

- **Thunks** (`() => A`) for product fields — laziness preserved
- **Closures** (`(index) => A` / `(key) => A`) for sequence/map children
- **Inner thunks** for annotated nodes
- **Sum variants** via `SumVariants<A>` — `byIndex(i)` for positional, `byKey(k)` for discriminated

**Two-arg (fluent builder):** `interpret(schema, ctx)` returns an `InterpretBuilder<S, Ctx, Brands>` that accumulates layers via `.with()` and runs the catamorphism on `.done()`.

#### Type Inference

Both overloads capture `S extends Schema` for type-level resolution.

**Fluent builder path.** Each pre-built layer (`readable`, `writable`, `changefeed`) carries a phantom brand type parameter (`ReadableBrand`, `WritableBrand`, `ChangefeedBrand`). `.with(layer)` intersects the layer's brand into the builder's accumulated `Brands`. `.done()` returns `Resolve<S, Brands>`:

| Brands | `.done()` returns |
|---|---|
| `ReadableBrand` | `RRef<S>` (≡ `Readable<S>`) |
| `ReadableBrand & WritableBrand` | `RWRef<S>` |
| `ReadableBrand & WritableBrand & ChangefeedBrand` | `Ref<S>` |
| Anything else (custom/unbranded layers) | `unknown` |

Standard usage needs no cast:

```ts
const doc = interpret(schema, ctx)
  .with(readable)
  .with(writable)
  .with(changefeed)
  .done()   // → Ref<typeof schema>
```

**Three-arg path.** The three-arg overload returns raw `A` (not a schema-level type). This is because `Ref<S>` / `RWRef<S>` are deeply recursive conditional types that cause TS2589 ("excessively deep") when placed in overload return positions with abstract `S extends Schema`.

However, the carrier type `A` is now **honest** — `withWritable` returns `Interpreter<Ctx, A & HasTransact>` and `withChangefeed` returns `Interpreter<Ctx, A & HasChangefeed>`. These honest return types track contributed capabilities in `A`, so the carrier structurally satisfies the schema-level type. `ResolveCarrier<S, A>` is exported as a utility type for explicit annotations at call sites:

| Carrier capabilities | `ResolveCarrier<S, A>` selects |
|---|---|
| `HasRead & HasTransact & HasChangefeed` | `Ref<S>` |
| `HasRead & HasTransact` | `RWRef<S>` |
| Otherwise | Raw `A` (fallback) |

Both `Ref<S>` and `RWRef<S>` require `HasRead` — a carrier that can't read has no business being typed as a schema-level ref (which promises a call signature returning `Plain<S>`). Write-only and read-only stacks fall through to raw `A`.

### Interpreters: The Five-Layer Decomposed Stack

The interpreter system is built from five composable transformer layers that stack on a universal foundation. Each layer adds exactly one capability:

| Layer | Kind | Input → Output | Purpose |
|---|---|---|---|
| `bottomInterpreter` | Foundation | `Interpreter<unknown, HasCall>` | Callable function carriers with `[CALL]` slot |
| `withNavigation(base)` | Coalgebra | `HasCall → HasNavigation` | Structural addressing: field getters, `.at()`, `.keys()`, sum dispatch |
| `withReadable(base)` | Refinement | `HasNavigation → HasRead` | Fills `[CALL]` slot with reading logic, adds `.get()`, `toPrimitive` |
| `withCaching(base)` | Interposition | `HasNavigation → HasCaching` | Identity-preserving child memoization + `[INVALIDATE]` |
| `withWritable(base)` | Extension | `A → A` | Mutation methods (`.set()`, `.insert()`, etc.) |

The standard composition:
```ts
const interp = withWritable(withCaching(withReadable(withNavigation(bottomInterpreter))))
```

Each layer is independently useful. Combinatorial stacks produce valid interpreters at every level:

| Stack | Capabilities | Use case |
|---|---|---|
| `bottomInterpreter` | Carriers only | Foundation for custom transformers |
| `withNavigation(bottom)` | Navigate only (ref() throws) | Structural addressing without reading |
| `withReadable(withNavigation(bottom))` | Reading + navigation (no caching) | Throwaway reads, tests |
| `withCaching(withReadable(withNavigation(bottom)))` | Reading + navigation + caching | Read-only documents |
| `withWritable(bottom)` | Write-only (ref() throws) | Mutation dispatch without reading |
| `withWritable(withNavigation(bottom))` | Navigate + write (no read) | Reach children via `.at()` and mutate, but `ref()` throws |
| `withCaching(withNavigation(bottom))` | Navigate + cache (no read) | Memoized structural addressing without value observation |
| `withWritable(withReadable(withNavigation(bottom)))` | Read + write (no caching) | Ephemeral documents |
| `withWritable(withCaching(withReadable(withNavigation(bottom))))` | Full stack | Standard composition |

#### Capability Lattice

Compile-time composition safety is enforced via a diamond-shaped capability lattice using phantom-branded interfaces:

```
HasCall  (bottom — callable carrier with [CALL] slot)
  ↓
HasNavigation  (withNavigation — field getters, .at(), .keys(), sum dispatch)
  ↙         ↘
HasRead        HasCaching
(withReadable   (withCaching —
 — fills [CALL],  memoization,
 toPrimitive,     INVALIDATE)
 .get())
```

- **`HasCall`** — has a `[CALL]` slot. Produced by `bottomInterpreter`. Calling the carrier delegates to `carrier[CALL](...args)`.
- **`HasNavigation extends HasCall`** — has structural navigation (product getters, `.at()`, `.keys()`, sum dispatch, etc.). Branded with phantom `[NAVIGATION]: true`. Produced by `withNavigation`.
- **`HasRead extends HasNavigation`** — the `[CALL]` slot has been filled with a reader. Phantom brand only (no runtime symbol). Produced by `withReadable`.
- **`HasCaching extends HasNavigation`** — has child caching and `[INVALIDATE]`. Branded with phantom `[CACHING]: true`. Produced by `withCaching`.

`HasRead` and `HasCaching` both extend `HasNavigation` independently, forming a diamond. TypeScript's structural subtyping enforces valid ordering: `withCaching` requires `HasNavigation` input, so `withCaching(bottomInterpreter)` is a compile error. `withReadable` requires `HasNavigation`, so `withReadable(bottomInterpreter)` is also a compile error. `withWritable` has no bound on `A` — it works with any carrier (mutation operates on paths, not navigation).

#### Symbol-Keyed Composability Hooks

Cross-layer communication uses four well-known symbols:

| Symbol | Module | Purpose |
|---|---|---|
| `CALL` (`kyneta:call`) | `bottom.ts` | Controls what `carrier()` does — default throws, `withReadable` fills it with reading logic |
| `INVALIDATE` (`kyneta:invalidate`) | `with-caching.ts` | Change-driven cache invalidation — refs carry it for direct use; `prepare` pipeline fires it automatically |
| `CHANGEFEED` (`kyneta:changefeed`) | `changefeed.ts` | Observation coalgebra — `withChangefeed` attaches it |
| `TRANSACT` (`kyneta:transact`) | `writable.ts` | Context discovery — refs carry a reference to their `WritableContext` |

All use `Symbol.for()` so multiple copies of the module share identity.

#### Bottom Interpreter (`src/interpreters/bottom.ts`)

The universal foundation. Every schema node produces a callable **function carrier** via `makeCarrier()`. The carrier delegates to its `[CALL]` slot: `(...args) => carrier[CALL](...args)`. By default, `CALL` throws `"No call behavior configured"`.

The carrier is a real `Function` object, so any layer can attach properties (navigation, caching, mutation methods) without replacing the carrier identity. This identity-preserving property is critical — `withNavigation`, `withReadable`, `withCaching`, and `withWritable` all mutate the same carrier object.

The `product`, `sequence`, `map`, and `sum` cases ignore their thunks/closures/variants — bottom produces inert carriers. The `annotated` case delegates to `inner()` when present.

This module also defines the capability lattice interfaces (`HasCall`, `HasNavigation`, `HasRead`, `HasCaching`) and exports the `CALL` symbol.

#### withNavigation (`src/interpreters/with-navigation.ts`)

The coalgebraic structural addressing transformer. Takes any `HasCall`-producing interpreter and adds structural navigation — "give me a handle to the child at position X" — without reading any values:

- **Product:** Enumerable lazy getters for each field. **No caching** — each access forces the thunk afresh. **Discriminant short-circuit:** when `schema.discriminantKey` is set (i.e. this product is a variant of a discriminated union), the discriminant field's getter returns `readByPath(ctx.store, fieldPath)` directly — a raw string value from the store — instead of forcing the field thunk. This enables standard TS discriminated union narrowing (`if (ref.type === "text")`) and prevents discriminant mutation (no `.set()` on a plain string).
- **Sequence:** `.at(i)` returns a child carrier (bounds-checked via `storeArrayLength`). `.length` reflects the store array length. `[Symbol.iterator]` yields child carriers.
- **Map:** `.at(key)` returns a child carrier (checked via `storeHasKey`). `.has(key)`, `.keys()`, `.size`, `.entries()`, `.values()`, `[Symbol.iterator]`.
- **Sum:** Uses `dispatchSum(value, schema, variants)` from `store.ts` for store-driven variant resolution. This is structural addressing — "which child position is active?" — not value reading.
- **Annotated:** `"doc"`/`"movable"`/`"tree"` → delegate to inner. `"text"`/`"counter"` → pass through to base (reading is `withReadable`'s job).

Navigation is a coalgebra (`A → F(A)`): it reveals addressable child positions within a composite. The `[CALL]` slot is NOT filled — calling the carrier still throws after `withNavigation` alone.

**Store inspection vs value reading.** Navigation uses `storeArrayLength`, `storeKeys`, `storeHasKey` (extracted into `store.ts`) to make structural decisions. These ask "what shape is here?" — not "what is the value?" This distinction keeps navigation independent from reading.

#### withReadable (`src/interpreters/with-readable.ts`)

The refinement transformer. Requires `HasNavigation` input (structural navigation must already be installed). Fills the `[CALL]` slot so carriers return values:

- **Scalar:** `CALL` returns `readByPath(store, path)` (immutable primitive). Hint-aware `[Symbol.toPrimitive]`.
- **Product:** `CALL` folds child values through the carrier's property getters (`result[key]()` for each field), producing a **fresh plain object**. This composes with `withCaching`'s memoized getters — the fold reuses cached child refs but always produces a distinct snapshot.
- **Sequence:** `CALL` folds child values via the raw `item(i)()` closure (not `result.at()`), producing a **fresh array**. Uses `storeArrayLength` for structure discovery but never returns the store array directly. The raw closure is used instead of the cached `.at()` because `withCaching`'s cache shifting can leave refs with stale paths after insert/delete. Adds `.get(i)` convenience (returns plain value, not ref).
- **Map:** `CALL` folds child values via the raw `item(key)()` closure, producing a **fresh record**. Same design as sequence — `storeKeys` for key discovery, raw closure for values. Adds `.get(key)` convenience.
- **Sum:** Pass-through — dispatch is already handled by `withNavigation`.
- **Annotated:** `"text"` → string-coercing reader + toPrimitive. `"counter"` → number-coercing reader + hint-aware toPrimitive. `"doc"`/`"movable"`/`"tree"` → delegate to inner.

**Snapshot isolation.** Composite `ref()` always returns a fresh plain object — mutating the returned value does not affect the store. `ref()` and `plainInterpreter` produce extensionally equal output for the same store state. Both are F-algebras over the schema functor; `ref()` folds through the carrier stack (benefiting from child ref caching), while `plainInterpreter` is a standalone eager fold with no carrier overhead.

**Identity is not preserved at this layer.** `ref.title !== ref.title` — each property access produces a new child ref. Use `withCaching` for identity.

#### withCaching (`src/interpreters/with-caching.ts`)

The interposition transformer. Wraps navigation with memoization:

- **Product:** field getters use `resolved`/`cached` memoization pattern. `ref.title === ref.title`. **Discriminant fields are excluded** — when `schema.discriminantKey` is set, both the `fieldState` initialization loop and the getter override loop skip the discriminant key. The `withNavigation` getter already returns a raw store read for the discriminant; memoizing it would cache a potentially stale value outside the normal invalidation pipeline. Skipping is both correct and simpler.
- **Sequence:** `Map<number, A>` child cache wrapping `.at(i)`. `seq.at(0) === seq.at(0)`.
- **Map:** `Map<string, A>` child cache wrapping `.at(key)`. `map.at("k") === map.at("k")`.
- **Scalar, sum, annotated:** pass through (no caching needed at leaves).

**Change-driven `[INVALIDATE]`:** Each structural node gets an `[INVALIDATE](change: ChangeBase)` method that interprets the change surgically:

- `SequenceChange` → shift/delete cached entries via `planCacheUpdate` + `applyCacheOps`
- `MapChange` → delete affected keys (both set and delete keys)
- `ReplaceChange` → clear all
- Unknown → clear all (safe fallback)

The invalidation logic is split into **Functional Core** (`planCacheUpdate` — pure, table-testable) and **Imperative Shell** (`applyCacheOps` — trivial `Map` mutation). Both are exported for testing.

`CacheInstruction` is the instruction set: `clear` (drop all), `delete` (drop specific keys), `shift` (re-key numeric entries by delta).

**Prepare-pipeline integration:** When composed inside `withWritable` (i.e. the context is a `WritableContext`), `withCaching` hooks into the `prepare` phase via `ensureCacheWiring`. Each composite node registers its invalidation handler by `pathKey(path)` during interpretation. The `prepare` wrapper fires the handler **before** forwarding to the inner prepare (store mutation), so caches are invalidated automatically for every change source — whether from imperative mutation methods or declarative `applyChanges`.

The wiring uses the same structural pattern as `withChangefeed` — `WeakMap<object, State>` + idempotent wrapping + path-keyed handler map. The duck-typed `hasPrepare(ctx)` check allows `withCaching` to keep its `RefContext` type signature while participating in the pipeline when composed inside `withWritable`. In read-only stacks (`RefContext` without `prepare`), the pipeline hook is skipped — `[INVALIDATE]` remains on refs for direct use.

The effective `prepare` pipeline ordering (showing nesting):

```
ctx.prepare(path, change)
  → withChangefeed's wrapper (outermost):
      calls inner prepare:
        → withCaching's wrapper:
            invalidate cache at path
            calls original: applyChangeToStore(store, path, change)
      accumulate {path, change} for notification
```

Effective per-change order: **invalidate cache → store mutation → accumulate notification**.

#### withWritable (`src/interpreters/writable.ts`)

An extension transformer: `withWritable(base)` takes `Interpreter<RefContext, A>` and returns `Interpreter<WritableContext, A & HasTransact>`. The return type honestly declares that `[TRANSACT]` is attached to every carrier, enabling `ResolveCarrier` to detect `HasTransact` in the composed carrier type. The type parameter `A` is **unconstrained** — `withWritable` works with any carrier because mutation operates on paths (via `ctx.dispatch`), not navigation:

- **Scalar:** `.set(value)` — dispatches `ReplaceChange` at own path.
- **Product:** `.set(plainObject)` — dispatches `ReplaceChange` at own path. Non-enumerable. Enables atomic subtree replacement.
- **Text:** `.insert(index, content)`, `.delete(index, length)`, `.update(content)` — dispatches `TextChange`. `update()` reads current text via `readByPath(ctx.store, path)` (direct store inspection, not the carrier's `[CALL]` slot) so navigate+write stacks work without a reading layer.
- **Counter:** `.increment(n?)`, `.decrement(n?)` — dispatches `IncrementChange`.
- **Sequence:** `.push(...items)`, `.insert(index, ...items)`, `.delete(index, count?)` — dispatches `SequenceChange`.
- **Map:** `.set(key, value)`, `.delete(key)`, `.clear()` — dispatches `MapChange`. All non-enumerable.
- **Sum:** pass-through — delegates to base.

Mutation methods simply construct the appropriate change and call `ctx.dispatch(path, change)`. Cache invalidation is handled by the `prepare` pipeline — `withCaching` hooks `ctx.prepare` to fire per-path invalidation handlers before store mutation. This means every change source (imperative mutation, `applyChanges`, direct `ctx.prepare` calls) gets automatic cache invalidation without manual `[INVALIDATE]` calls.

**Why `withWritable` is not a `Decorator`:** The `Decorator<Ctx, A, P>` type receives `(result, ctx, path)` but no schema information. Mutation is tag-dependent (text gets `.insert()`, counter gets `.increment()`), so it needs `schema.tag` in the `annotated` case. This makes it an interpreter transformer (wraps the full 6-case interpreter) rather than a decorator.

#### Dispatch Model

**Every node dispatches at its own path.** This is a universal invariant with no exceptions. Scalar `.set()` dispatches `ReplaceChange` at `["settings", "darkMode"]`, not `MapChange` at `["settings"]`. Product `.set()` dispatches `ReplaceChange` at `["settings"]`. Text `.insert()` dispatches `TextChange` at `["title"]`. The dispatch path always equals the node's path in the schema tree.

This design gives developers two mutation granularities:

- **Leaf `.set()`** for surgical edits — one scalar, one `ReplaceChange`, one notification at the leaf path.
- **Product `.set()`** for bulk replacement — one struct, one `ReplaceChange`, one notification at the product path.

#### WritableContext and Phase-Separated Dispatch

`WritableContext` extends `RefContext` with phase-separated dispatch, mutation infrastructure, and transaction support:

```ts
interface WritableContext extends RefContext {
  readonly prepare: (path: Path, change: ChangeBase) => void
  readonly flush: (origin?: string) => void
  readonly dispatch: (path: Path, change: ChangeBase) => void
  beginTransaction(): void
  commit(origin?: string): Op[]
  abort(): void
  readonly inTransaction: boolean
}
```

**Context hierarchy:** `RefContext { store: StoreReader }` → `WritableContext { prepare, flush, dispatch, beginTransaction, commit, abort, inTransaction }`. Each layer adds only what it needs.

**Phase separation.** The dispatch pipeline splits into two phases:

- **`prepare(path, change)`** — called N times (once per change). Invalidates caches (via `withCaching`'s hook), mutates the store, accumulates notification entries (via `withChangefeed`'s hook). No subscriber notification fires.
- **`flush(origin?)`** — called once after all prepares. Plans notifications (grouping accumulated entries by path), delivers one `Changeset` per affected path to subscribers. Subscribers see fully-applied state.

**`executeBatch(ctx, changes, origin?)`** is the single primitive that composes the two phases: `prepare × N + flush × 1`. All entry points collapse to it:

- `dispatch(path, change)` — outside a transaction, calls `executeBatch` with one change (auto-commit). During a transaction, buffers the `{path, change}` pair.
- `commit(origin?)` — copies+clears the buffer, ends the transaction, calls `executeBatch`.
- `applyChanges(ref, ops, {origin})` — calls `executeBatch` directly (no transaction needed — the full list of changes is already known).

**Invariant:** `executeBatch`, `prepare`, and `flush` must not be called during an active transaction. `executeBatch` throws if `ctx.inTransaction` is true — this prevents `applyChanges` from corrupting a half-built transaction.

Layers like `withChangefeed` wrap `prepare` (to accumulate notification entries) and `flush` (to deliver `Changeset` batches). `withCaching` wraps `prepare` (to invalidate caches). Both use the `WeakMap` + idempotent wrapping pattern for per-context, exactly-once wiring.

The `TRANSACT` symbol (`Symbol.for("kyneta:transact")`) and `HasTransact` interface enable context discovery from any ref — `change()` and `applyChanges()` find the `WritableContext` without a WeakMap or re-interpretation.

#### Facade (`src/facade/`)

The facade has been split into two cohesive modules under `src/facade/`:

- **`facade/change.ts`** — mutation protocol: `change`, `applyChanges`, `ApplyChangesOptions`. Discovers `WritableContext` via `[TRANSACT]`.
- **`facade/observe.ts`** — observation protocol: `subscribe`, `subscribeNode`. Discovers capabilities via `[CHANGEFEED]`.

The library-level API for change capture, declarative application, and observation:

- **`change(ref, fn) → Op[]`** — imperative mutation capture. Runs `fn` inside a transaction, returns the captured changes. Aborts on error.
- **`applyChanges(ref, ops, {origin?}) → Op[]`** — declarative application. Applies a list of changes via `executeBatch`, triggering the full prepare pipeline (cache invalidation + store mutation + notification accumulation) then flush (batched `Changeset` delivery). Empty ops is a no-op.
- **`subscribe(ref, cb) → () => void`** — tree-level observation (the default). Callback receives `Changeset<Op>` with relative paths. Only works on composite refs (products, sequences, maps). A strict superset of `subscribeNode` — subscribers also see own-path changes with `path: []`. Delegates to `ref[CHANGEFEED].subscribeTree(cb)`.
- **`subscribeNode(ref, cb) → () => void`** — node-level observation. Callback receives `Changeset`. For leaf refs, fires on any mutation. For composite refs, fires only on node-level changes (e.g. product `.set()`), not child mutations. Delegates to `ref[CHANGEFEED].subscribe(cb)`.

**Facade vs. protocol naming.** The facade and the changefeed protocol use different vocabulary by design. The facade speaks the developer's language: `subscribe` is the unmarked default (deep/tree-level, the thing you reach for first), `subscribeNode` is the explicit opt-in for node-level observation. The protocol speaks its own language: `Changefeed.subscribe` is the universal Moore machine transition stream, `ComposedChangefeed.subscribeTree` is the tree-level composition extension. The facade translates: `subscribe` → `[CHANGEFEED].subscribeTree`, `subscribeNode` → `[CHANGEFEED].subscribe`. This follows the principle of least surprise and ecosystem precedent (Yjs `observeDeep`, Vue `{ deep: true }`, MobX deep-by-default). The name `subscribeNode` communicates positive intent ("I want events at this node") rather than degradation — the `@kyneta/cast` runtime's `listRegion` legitimately needs node-level subscriptions for structural `SequenceChange` events, and that's the correct semantic.

`change` and `applyChanges` are symmetric duals: `change` produces `Op[]`, `applyChanges` consumes them. Round-trip correctness is verified: `change(docA, fn)` → ops → `applyChanges(docB, ops)` → `docA()` deep-equals `docB()`.

All four functions discover capabilities via symbols on refs (`[TRANSACT]` for `change`/`applyChanges`, `[CHANGEFEED]` for `subscribe`/`subscribeNode`). All throw clear errors when the ref lacks the required symbol.

#### Changefeed Transformer (`src/interpreters/with-changefeed.ts`)

An interpreter transformer: `withChangefeed(base)` takes `Interpreter<RefContext, A extends HasRead>` and returns `Interpreter<RefContext, A & HasChangefeed>`. The return type honestly declares that `[CHANGEFEED]` is attached to every carrier, enabling `ResolveCarrier` to detect `HasChangefeed` in the composed carrier type. `attachChangefeed` uses an `asserts target is HasChangefeed` signature for type narrowing — after the call, the target is known to have `[CHANGEFEED]`. The `sum` case has an explicit `as A & HasChangefeed` cast because assertion narrowing doesn't compose through conditional guards.

Requires `HasRead` (the `[CALL]` slot must be filled) because `.current` reads values through the carrier. Context type is `RefContext` (not `WritableContext`) — it duck-types for `prepare`/`flush` via `hasPreparePipeline()`, enabling both writable and read-only stacks.

For leaf refs, attaches a plain `Changefeed` with `subscribe` (node-level). For composite refs (product, sequence, map), attaches a `ComposedChangefeed` with both `subscribe` (node-level) and `subscribeTree` (tree-level observation via subscription composition). Note: the facade exports `subscribe` (tree-level, delegates to `subscribeTree`) and `subscribeNode` (node-level, delegates to `subscribe`) — see §Facade above for the naming rationale.

**Read-only Moore machines.** A `Changefeed` defines a Moore machine: `.current` (output function) + `.subscribe` (transition observer). On read-only stacks (no `prepare`/`flush`), subscribers register but never fire — a valid static Moore machine. `.current` still works because it routes through the carrier's `[CALL]` slot.

**Notification flow:** `withChangefeed` wraps `ctx.prepare` to accumulate `{path, change}` entries without firing subscribers. It wraps `ctx.flush` to group accumulated entries by `pathKey` (via `planNotifications` — pure FC) and deliver one `Changeset` per subscriber (via `deliverNotifications` — imperative shell). This follows the same FC/IS pattern as `planCacheUpdate`/`applyCacheOps` in `withCaching`.

**Tree notification** propagates via subscription composition (children → parent), not a flat subscriber map. When a leaf's changefeed fires, its parent's `subscribeTree` callback re-prefixes the path and propagates upward. Each child path produces its own `Changeset<Op>` — so a transaction touching N different paths delivers N tree changesets to the parent (each with the correct relative path prefix).

**Composition:** `withChangefeed(withWritable(withCaching(withReadable(bottomInterpreter))))`

### Substrate (`src/substrate.ts`, `src/substrates/`)

The Substrate abstraction formalizes the boundary between three algebras:

| Algebra | Domain | Currency |
|---------|--------|----------|
| **Application** (CHANGEFEED) | Reactive UI, compiler regions | `Op`, `Changeset` |
| **State** (Substrate) | State management, merge semantics | Substrate-native (plain store or LoroDoc) |
| **Replication** (Sync) | Peer-to-peer data transfer | `SubstratePayload` (opaque to the framework) |

**Morphisms:**
- **project: State → Application** — substrate mutations become `Changeset`s delivered through the CHANGEFEED. The changefeed layer wraps `ctx.prepare`/`ctx.flush` to implement this automatically.
- **export: State → Replication** — `substrate.exportSnapshot()` (full state) or `substrate.exportSince(version)` (delta since a version).
- **import: Replication → State** — `substrate.importDelta(payload)` applies deltas through the prepare/flush pipeline, triggering `project` automatically. `factory.fromSnapshot(payload, schema)` constructs a new substrate from a snapshot.

**Commutativity law:** `snapshot(apply(state, M₁..Mₙ)) = fold(step, snapshot(state), project(M₁)..project(Mₙ))` — applying mutations then snapshotting equals stepping the snapshot through the projected changesets.

**Key interfaces:**

- **`Version`** — the external version marker. Serializable (for SSR embedding in HTML meta tags) and comparable (partial order — plain substrates are totally ordered, CRDT substrates may have concurrent versions). This is the single type parameter on `Substrate<V>`. Substrates may use richer internal version tracking; the Version is what crosses the substrate boundary. Named `Version` (not `Frontier`) to avoid collision with Loro's `Frontiers` concept — Loro's `Frontiers` are DAG-leaf operation IDs used for checkpoints, while our `Version` corresponds to Loro's `VersionVector` (the complete peer state used for sync diffing).

- **`StoreReader`** — the abstract read interface for the interpreter stack. All interpreters read from the store exclusively through this four-method interface (`read`, `arrayLength`, `keys`, `hasKey`), allowing substrates to provide their own read semantics. `plainStoreReader(obj)` wraps a plain JS object; a Loro substrate navigates the Loro container tree directly. The `StoreReader` returned by `plainStoreReader` is a *live view* — mutations to the backing object via `applyChangeToStore` are immediately visible through the reader.

- **`SubstratePayload`** — an opaque blob with an encoding hint (`"json" | "binary"`). The meaning of a payload is determined by which method produced it and which method consumes it — `exportSnapshot()` → `factory.fromSnapshot()`, `exportSince()` → `substrate.importDelta()`. No `kind` discriminant; the method-level distinction is sufficient and substrate-universal (Loro's `import()` accepts both snapshots and updates through the same code path).

- **`Substrate<V>`** extends `SubstratePrepare` — adds `version()`, `exportSnapshot()`, `exportSince()`, `importDelta()`, and `context()`. The `SubstratePrepare` interface (Phase 0) provides the ground floor of the prepare/flush pipeline: `store: StoreReader`, `prepare(path, change)`, `onFlush(origin?)`.

- **`SubstrateFactory<V>`** — `create(schema, seed?)` for fresh substrates, `fromSnapshot(payload, schema)` for reconstruction from snapshots, `parseVersion(serialized)` for version deserialization.

**Epoch boundaries.** Within a single substrate lifetime, all state transitions are deltas delivered as `Changeset`s through the changefeed. `Changeset` is and remains delta-only. State replacement (snapshot import) is an **epoch boundary** — a new substrate is constructed via `factory.fromSnapshot()`, and the application layer swaps the doc reference. The old interpreter tree is GC'd. The invariant: within an epoch, all transitions are deltas; between epochs, there is no continuity.

**`PlainSubstrate`** is the first concrete implementation. It wraps a plain JS object store (the degenerate case — no CRDT runtime, no native oplog). The raw `Record<string, unknown>` is wrapped in a `plainStoreReader` for the interpreter stack, while mutations and export still operate on the raw object directly. Version tracking uses a **shadow buffer**: `prepare` accumulates `{path, change}` entries alongside `applyChangeToStore`, and `onFlush` drains the buffer into the version log and increments the version counter. The changefeed layer independently accumulates the same entries for notification planning — both hold the same object references and are drained every flush cycle. `PlainVersion` wraps a monotonic integer; `compare()` never returns `"concurrent"`.

**`LoroSubstrate`** is the second concrete implementation, provided by the separate `@kyneta/loro-schema` package. It wraps a user-provided `LoroDoc` with schema-aware typed reads (via `LoroStoreReader`), `applyDiff`-based writes, and a persistent `doc.subscribe()` event bridge that ensures all mutations to the underlying LoroDoc — whether from kyneta, `importDelta`, or external systems — fire kyneta changefeed subscribers. See `packages/schema/loro/TECHNICAL.md` for the full architecture.

### Additional Interpreters

| Interpreter | Context | Result | Purpose |
|---|---|---|---|
| `plainInterpreter` | Plain JS object (store) | `unknown` | Eager deep snapshot — equivalent to `toJSON()` / `value()` |
| `validateInterpreter` | `ValidateContext` | `unknown` | Validate plain values against schema, collect errors |

### Validate Interpreter (`src/interpreters/validate.ts`)

**Architecture: one collecting interpreter, two public wrappers.**

The interpreter always collects errors into a mutable `SchemaValidationError[]` accumulator — it never throws. On mismatch, it pushes an error and returns `undefined` as a sentinel. On success, it returns the validated value. Two thin public wrappers:

- **`validate<S>(schema, value): Plain<S>`** — runs the interpreter, throws the first error if any
- **`tryValidate<S>(schema, value)`** — returns `{ ok: true; value: Plain<S> }` or `{ ok: false; errors: SchemaValidationError[] }`

**`SchemaValidationError`** extends `Error` with three fields:
- `path: string` — human-readable dot/bracket path (e.g. `"messages[0].author"`, `"root"` for empty path)
- `expected: string` — what the schema expected (e.g. `"string"`, `"one of \"a\" | \"b\""`, `"nullable<string>"`)
- `actual: unknown` — the actual value found

**Per-kind validation logic:**

| Kind | Validates | On mismatch |
|---|---|---|
| `scalar` | `typeof` check (or `=== null`, `instanceof Uint8Array` for null/bytes). Then constraint check if present. | Pushes error with expected kind or allowed values |
| `product` | Non-null, non-array object | Forces all field thunks (collects all field errors, no short-circuit) |
| `sequence` | `Array.isArray()` | Validates each item (collects all item errors) |
| `map` | Non-null, non-array object | Validates each key's value |
| `sum` (positional) | Tries each variant with error rollback (`errors.length = mark`) | Single "expected one of union variants" error (or "nullable<X>" for nullable sums) |
| `sum` (discriminated) | Object → discriminant exists → discriminant is string → discriminant is known key → validate variant body | Clear error for each failure mode at the discriminant path |
| `annotated` (leaf) | `text` → string, `counter` → number | Error with annotation-qualified expected (e.g. `"string (text)"`) |
| `annotated` (structural) | Delegates to inner thunk | Inner errors propagate |

**Positional sum rollback:** When trying variant `i`, snapshot `const mark = errors.length`. If the variant pushes new errors (`errors.length > mark`), reset `errors.length = mark` to discard them before trying the next variant. If all variants fail, push a single summary error. For nullable sums (detected by the same pattern as `describe()`), the error message is `"nullable<inner>"` rather than generic.

### Readable Types (`src/interpreters/readable.ts`)

This file contains **type-level definitions only** — the runtime implementation has been decomposed into `withReadable` and `withCaching`. `RRef<S>` is a naming-consistent alias for `Readable<S>`, exported from `ref.ts`. No behavioral difference — it exists so the three ref tiers have parallel naming: `RRef`, `RWRef`, `Ref`.

The types that remain:

**`ReadableSequenceRef<T, V>`** — callable + `.at(i)`, `.get(i)`, `.length`, `[Symbol.iterator]`. `T` is the ref type, `V` is the plain value type.

**`ReadableMapRef<T, V>`** — callable + `.at(key)`, `.get(key)`, `.has(key)`, `.keys()`, `.size`, `.entries()`, `.values()`, `[Symbol.iterator]`. All methods non-enumerable.

**`Readable<S>`** — the type-level counterpart to the composed stack. Maps schema nodes to callable ref types with navigation.

**Map and sequence navigation vocabulary:**

| Verb | Operation | Returns | Available on |
|---|---|---|---|
| `.at(key\|index)` | Navigate | `Ref \| undefined` | Maps, Sequences |
| `.get(key\|index)` | Read | `Plain<I> \| undefined` | Maps, Sequences |
| `()` | Fold | `Plain<S>` | All refs |

`.get()` is defined as `.at(x)?.()` — it composes navigation and fold.

**Why `.at()` for navigation:** `.at()` already existed on sequences (matching `Array.prototype.at()` semantics). Extending it to maps creates a uniform navigation verb for all dynamic-key collections.

**Why `.get()` for reading:** Every JavaScript collection API (`Map`, `WeakMap`, `URLSearchParams`, `Headers`, `FormData`) uses `.get()` to return a value. Making `.get()` return a ref violated universal developer expectations, caused type asymmetry with `.set()`, and produced `undefined` from `JSON.stringify()` (since refs are functions).

**Why iteration yields refs, not values:** Refs are the primary currency of the reactive system. In reactive frameworks (e.g. `packages/cast`), iterating over refs to bind them to DOM nodes is the core use case. Plain values are trivially available via fold: `Object.entries(doc.labels())` or `doc.tasks().forEach(...)`.

Sequence iteration follows **Array** semantics (yields bare child refs), while map iteration follows **Map** semantics (yields `[key, ref]` entries).

### Type-Level Interpretation: `Plain<S>`, `Readable<S>`, `Writable<S>`, `SchemaRef<S, M>`, and the Ref Tiers

Several recursive conditional types map schema types to their corresponding value types:

**`Plain<S>`** — the plain JavaScript/JSON type. `Plain<ScalarSchema<"string", "a" | "b">>` = `"a" | "b"`. `Plain<ProductSchema<{ x: ScalarSchema<"number"> }>>` = `{ x: number }`. Used for `toJSON()` return types, validation result types, and serialization boundaries.

**`Seed<S>`** — the deep-partial plain type for document seeds. `Seed<ProductSchema<{ x: ScalarSchema<"number"> }>>` = `{ x?: number }`. Structurally equivalent to a recursive `DeepPartial<Plain<S>>` but decomposed into helper types (`SeedFields`, `SeedAnnotated`) to stay within TS's conditional type depth budget — `Partial<Plain<S>>` triggers TS2589 on complex schemas. Products have all keys optional; scalars and leaf annotations resolve to their `Plain` value type; sequences, maps, and sums delegate to `Plain<S>` (seeds at these positions are atomic — you provide the full value or omit it). Used for seed parameters via `satisfies Seed<typeof mySchema>` at call sites. **Limitation:** `Seed<S>` triggers TS2589 when used as a generic function parameter (e.g. `<S>(schema: S, seed?: Seed<S>)`) — use it for direct type annotations and `satisfies`, not in generic signatures.

**`Readable<S>`** — the callable ref type for read-only stacks. `Readable<ScalarSchema<"number">>` = `(() => number) & { [Symbol.toPrimitive]: ... }`. Used to type refs from `withCaching(withReadable(withNavigation(bottomInterpreter)))` — navigation + reading, no mutation.

**`Writable<S>`** — the mutation-only ref type. `Writable<ScalarSchema<"string">>` = `ScalarRef<string>` (just `.set()`). `Writable<AnnotatedSchema<"text">>` = `TextRef` (just `.insert()`, `.delete()`, `.update()`). `SequenceRef` is mutation-only (`.push()`, `.insert()`, `.delete()`) — navigation lives in `NavigableSequenceRef` / `ReadableSequenceRef`.

**`SchemaRef<S, M>`** — the parameterized recursive core for composed interpreter refs. The mode parameter `M extends RefMode` (`"rw" | "rwc"`) controls which cross-cutting concerns are intersected at every node via `Wrap<T, M>`:

| Mode | `Wrap<T, M>` produces | Cross-cutting concerns |
|---|---|---|
| `"rw"` | `T & HasTransact` | Transaction access |
| `"rwc"` | `T & HasTransact & HasChangefeed` | Transaction access + observation |

Children recurse with the same mode: `SchemaRef<Child, M>` — the mode threads through the entire tree.

Three named aliases provide the user-facing ref tiers:

| Alias | Definition | Produced by |
|---|---|---|
| `RRef<S>` | `Readable<S>` | `.with(readable).done()` |
| `RWRef<S>` | `SchemaRef<S, "rw">` | `.with(readable).with(writable).done()` |
| `Ref<S>` | `SchemaRef<S, "rwc">` | `.with(readable).with(writable).with(changefeed).done()` |

**`Ref<S>`** is the **primary user-facing type** for the full interpreter stack. Unifies navigation, reading, writing, `HasTransact`, and `HasChangefeed` in a single recursive type. Children are `Ref<Child>` — no `Readable<Child> & Writable<Child>` intersection needed. This eliminates the `.at()` overload conflict that plagued `Readable<S> & Writable<S>` on sequences and maps (where `ReadableSequenceRef.at()` returns `Readable<I>` but `SequenceRef.at()` returned `Writable<I>`).

```ts
type Doc = Ref<typeof mySchema>
// doc()           → Plain<typeof mySchema>   (reading)
// doc.title()     → string                   (reading)
// doc.title.set("new")                       (writing)
// doc.items.at(0) → Ref<ItemSchema>          (navigation — unified child type)
// doc[TRANSACT]   → WritableContext           (transaction access)
// doc[CHANGEFEED] → Changefeed               (observation)
```

The type hierarchy for collections:
- `NavigableSequenceRef<T>` / `NavigableMapRef<T>` — pure structural addressing (`.at()`, `.length`, `.keys()`)
- `ReadableSequenceRef<T, V> extends NavigableSequenceRef<T>` — adds call signature `(): V[]` and `.get()`
- `SequenceRef` — mutation only (`.push()`, `.insert()`, `.delete()`) — no `.at()`, no type parameter
- `Ref<SequenceSchema<I>>` = `ReadableSequenceRef<Ref<I>, Plain<I>> & SequenceRef & HasTransact & HasChangefeed`

`RRef<S>` is a naming alias for `Readable<S>` — it is not a `SchemaRef` mode because read-only refs have a fundamentally different structure (no mutation interfaces, no `WithTransact`). `Readable<S>` and `Writable<S>` remain for partial-stack scenarios (read-only documents, mutation-only code paths). All types account for constrained scalars.

`WithTransact<T>` is a deprecated alias for `Wrap<T, "rw">`, kept for backward compatibility.

#### Sum Type Resolution

All four type-level interpretations handle both sum flavors:

**Discriminated sums** — `DiscriminatedSumSchema<D, V>` resolves via `V[number]` dispatch with a **hybrid discriminant** design. `Plain<S>` produces `Plain<V[number]>` (union of variant plain types — already a proper TS discriminated union). The three ref-producing types — `Readable<S>`, `Writable<S>`, and `SchemaRef<S, M>` — use `DiscriminantProductRef` (and its per-tier analogs) to produce hybrid product refs where the discriminant field `D` resolves to `Plain<F[D]>` (a raw string literal), while all other fields remain full recursive refs. This enables standard TypeScript discriminated union narrowing:

```ts
if (doc.content.type === "text") {
  doc.content.body()  // TS narrows — no cast needed
}
switch (doc.content.type) {
  case "text": return doc.content.body()
  case "image": return doc.content.url()  // exhaustiveness via never
}
```

The discriminant is **not writable** — `ref.type` is a plain string with no `.set()` method. This prevents store corruption (changing the discriminant without replacing the entire variant). At runtime, `withNavigation` short-circuits the discriminant field with a raw `readByPath` store read (see [withNavigation](#withnavigation-srcinterpreterswith-navigationts)). The `ProductSchema.discriminantKey` marker tells each interpreter layer which field to special-case (see [`ProductSchema.discriminantKey`](#productschema-discriminantkey)).

TS homomorphic mapped types distribute over union type arguments, so `DiscriminantProductRef<V[number]["fields"], D, M>` correctly produces a union of per-variant product refs — a proper TS discriminated union where each variant has its own field set.

**Nullable sums** — `Schema.nullable(inner)` produces `PositionalSumSchema<[ScalarSchema<"null">, S]>`. Without special handling, distributing over `V[number]` would produce `ScalarRef<null> | ScalarRef<string>`, making `.set()` accept `never` (contravariant parameter intersection). All three ref-producing types detect the nullable pattern at the type level and collapse to a single ref with a nullable value domain:

| Type | Nullable result |
|---|---|
| `SchemaRef<S, M>` | `Wrap<(() => Plain<Inner> \| null) & toPrimitive & ScalarRef<Plain<Inner> \| null>, M>` |
| `Readable<S>` | `(() => Plain<Inner> \| null) & toPrimitive` |
| `Writable<S>` | `ScalarRef<Plain<Inner> \| null>` |

The nullable pattern match is: `V extends readonly [ScalarSchema<"null", any>, infer Inner extends Schema]` — the same shape as the runtime `isNullableSum` check. This is a shallow structural match (not recursive), so it does not affect TS2589 depth thresholds.

**General positional sums** — `Schema.union(a, b, ...)` where the pattern is not nullable distributes normally: `SchemaRef<V[number], M>`, `Readable<V[number]>`, `Writable<V[number]>`. This produces a union of variant ref types where `.set()` parameter types intersect (contravariant). This is correct — for heterogeneous unions like `union(string, struct)`, the distributed union accurately reflects that each variant has a different mutation surface.

## Verified Properties

The spike validates these properties via 2012 tests across 38 test files (1 pre-existing `tsc` TS2589 error in `validate.test.ts`, unrelated to this work):

1. **Laziness**: after `interpret()`, zero thunks are forced. Accessing one field does not force siblings.
2. **Referential identity**: requires `withCaching` — `doc.title === doc.title`, `seq.at(0) === seq.at(0)`, `map.at("k") === map.at("k")`. Without `withCaching`, each access produces a new ref.
3. **Namespace isolation**: `Object.keys(doc)` returns only schema property names (even on function-shaped refs). `Object.keys(mapRef)` returns `[]` (methods are non-enumerable). `CHANGEFEED in doc` is true. `CHANGEFEED` is non-enumerable.
4. **Portable refs**: `const ref = doc.settings.fontSize; bump(ref)` — works outside the tree because context is captured in closures.
5. **Plain round-trip / snapshot isolation**: `interpret(schema, plainInterpreter, store)` produces the identical object tree. Calling `ref()` on any composite also produces a fresh, structurally equal plain object — mutating the returned value does not affect the store. `CHANGEFEED.current` on composites returns the same fresh snapshot (it delegates to `[READ]`). Leaf nodes return immutable primitives in both cases.
6. **Changefeed subscription**: `doc.title[CHANGEFEED].subscribe(cb)` receives `Changeset` objects; unsubscribe stops notifications.
7. **Transaction API**: `beginTransaction()` buffers changes; `commit()` calls `executeBatch` (which calls `prepare` N times + `flush` once, delivering batched `Changeset` to subscribers); `abort()` discards. `ctx.inTransaction` reflects current state.
8. **Constrained scalar defaults**: `Zero.structural(Schema.string("a", "b"))` returns `"a"` (first constraint value).
9. **Validation collects all errors**: `tryValidate` on a value with N type mismatches returns N errors (no short-circuit).
10. **Positional sum rollback**: failed variant errors are discarded; successful variant produces zero spurious errors.
11. **Type narrowing**: `validate(schema, value)` return type is `Plain<typeof schema>` — verified via `expectTypeOf`.
12. **Discriminated sum dispatch**: the composed readable stack reads the discriminant from the store and produces the correct variant's callable ref.
13. **Nullable dispatch**: the composed readable stack checks for `null`/`undefined` and dispatches to the correct positional variant.
14. **Callable refs**: every ref produced by the composed stack is `typeof "function"` and returns its current plain value when called.
15. **`toPrimitive` coercion**: `` `Stars: ${doc.count}` `` works via `[Symbol.toPrimitive]`; counter is hint-aware (number for default, string for string hint).
16. **Read-only documents**: `interpret(schema, withCaching(withReadable(withNavigation(bottomInterpreter))), { store: plainStoreReader(store) })` produces a fully navigable, callable document with no mutation methods.
17. **Change-driven cache invalidation**: `[INVALIDATE](change)` interprets the change surgically — sequence shifts, map key deletes, product clears. Verified via `planCacheUpdate` table tests (31 cases).
18. **Navigate vs Read vocabulary**: map and sequence refs expose two access verbs — `.at(key|index)` for navigation (returns a ref) and `.get(key|index)` for reading (returns a plain value). `.get()` is symmetric with `.set()`. `JSON.stringify(mapRef.get("x"))` returns the serialized value (not `undefined`). Iteration yields refs (not values). Map refs also expose `.has(key)`, `.keys()`, `.size`, `.entries()`, `.values()`, `[Symbol.iterator]`; `.set(key, value)`, `.delete(key)`, `.clear()` for writes. No Proxy, no string index signature. Navigation is provided by `withNavigation`; reading (`.get()`) is provided by `withReadable`.
19. **Sequence `.at()` / `.get()` bounds check**: `.at(100)` on a 2-item array returns `undefined`; `.at(-1)` returns `undefined`. `.get(100)` and `.get(-1)` also return `undefined`. Matches `Array.prototype.at()` semantics.
20. **Capability composition**: `withChangefeed(withWritable(withCaching(withReadable(bottomInterpreter))))` produces refs with all capabilities.
21. **Self-path dispatch**: every mutation dispatches at its own path. Scalar `.set()` dispatches `ReplaceChange` at the scalar's path (not `MapChange` at the parent). Exact-path changefeed subscribers on scalars fire on `.set()`.
22. **Product `.set()`**: `doc.settings.set({ darkMode: true, fontSize: 20 })` dispatches a single `ReplaceChange` at the product's path. The `.set()` method is non-enumerable. Individual field refs still work after product `.set()`. Transactions accumulate one `Op`.
23. **Compile-time composition safety**: `withCaching(bottomInterpreter)` is a compile error — `bottomInterpreter` produces `HasCall`, but `withCaching` requires `HasNavigation`. `withReadable(bottomInterpreter)` is also a compile error (requires `HasNavigation`). `withReadable(plainInterpreter)` is also a compile error.
24. **Prepare-pipeline cache invalidation**: `ctx.prepare(path, change)` triggers surgical cache invalidation at the target path via `withCaching`'s pipeline hook. After `push()` on a cached sequence, `.at(newIndex)` returns the correct ref immediately. Unrelated caches are preserved (path-keyed handlers only fire for affected paths).
25. **Combinatorial stacks**: `withWritable(bottomInterpreter)` produces write-only carriers where `ref()` throws but `.set()` dispatches correctly. `withWritable(withReadable(bottomInterpreter))` produces uncached read+write refs.
26. **`TRANSACT` symbol**: `hasTransact(ref)` returns true for refs produced by `withWritable`. The symbol is `Symbol.for("kyneta:transact")`.
27. **Batched notification**: subscribers receive exactly one `Changeset` per flush cycle per affected path, never partially-applied state. Auto-commit wraps a single change in a degenerate `Changeset` of one. Transactions and `applyChanges` deliver multi-change batches.
28. **Declarative change application round-trips with `change`**: `change(docA, fn)` → ops → `applyChanges(docB, ops)` → `docA()` deep-equals `docB()`. Verified for text, sequence (push/insert/delete), counter, map, and mixed mutations.
29. **`applyChanges` invariants**: throws on non-transactable ref; throws during active transaction; empty ops is a no-op (no subscribers fire); `{origin}` option flows to `Changeset.origin`.
30. **Navigate + write without reading**: `withWritable(withNavigation(bottomInterpreter))` produces carriers where `.at()` reaches children and `.set()` mutates them, but `ref()` throws. Text `.update()` works because it reads the store directly via `readByPath`, not through the carrier's `[CALL]` slot.
31. **Read-only changefeeds**: `withChangefeed(withCaching(withReadable(withNavigation(bottomInterpreter))))` with a plain `RefContext` (no `prepare`/`flush`) produces valid Moore machines — `.current` returns a value, `.subscribe` returns a no-op unsubscribe.
32. **`Ref<S>` type correctness**: `Ref<SequenceSchema<ScalarSchema<"string">>>` has `.at(0)` returning `Ref<ScalarSchema>` with both `.set()` and `()` call signature — no overload conflict. `.push()`, `.insert()`, `.delete()` from `SequenceRef` (mutation-only, no `.at()`). `[TRANSACT]` and `[CHANGEFEED]` present at every level.
33. **`CALL` rename**: the carrier delegation slot is `Symbol.for("kyneta:call")`. The name honestly reflects the abstraction: call delegation, not reading.
34. **`RWRef<S>` type correctness**: `RWRef<S>` has `[TRANSACT]` but not `[CHANGEFEED]`. Children also lack `[CHANGEFEED]` — the mode threads recursively.
35. **Fluent `.done()` inference**: `interpret(schema, ctx).with(readable).with(writable).with(changefeed).done()` infers `Ref<S>` without cast. `.with(readable).with(writable).done()` infers `RWRef<S>`. `.with(readable).done()` infers `RRef<S>`.
36. **Honest transformer returns**: `withWritable` contributes `HasTransact` to `A`. `withChangefeed` contributes `HasChangefeed` to `A`. These are compile-time-verified via `expectTypeOf` on the interpreter return types.
37. **`change()` callback inference**: `change(doc, d => { ... })` infers `d` from the doc ref type — no `(d: any)` annotation needed when `doc` is typed as `Ref<S>` or `RWRef<S>`.
38. **Discriminated sum type resolution**: `Ref<DiscriminatedSumSchema>`, `RRef<DiscriminatedSumSchema>`, `RWRef<DiscriminatedSumSchema>`, and `Writable<DiscriminatedSumSchema>` all resolve to the union of variant ref types (not `unknown`). The discriminant field is a raw string literal (`Plain<F[D]>`), enabling native TS narrowing — see properties 42–45. `Plain<DiscriminatedSumSchema>` was already correct.
39. **Nullable sum type resolution**: `Ref<nullable(string)>` has `.set(string | null)` (not `never`). Call signature returns `string | null`. Nullable composites also work: `Ref<nullable(struct({ x: string() }))>` has `.set({ x: string } | null)` and call returns `{ x: string } | null`. The collapse applies across all tiers: `RRef`, `RWRef`, `Writable`.
40. **General positional sum distribution preserved**: `Ref<union(string, number)>` distributes correctly — the nullable collapse does not over-match. `.set()` parameter type is `never` (contravariant intersection of `string & number`), confirming distribution rather than collapse.
41. **Sum composition through products**: `Ref<struct({ bio: nullable(string) })>` — the `.bio` field correctly has `.set(string | null)`. `Ref<doc({ content: discriminatedUnion(...) })>` — `.content` resolves to the variant union (not `unknown`).
42. **Hybrid discriminant narrowing**: `if (ref.type === "text") { ref.body }` narrows the variant union at the type level. `switch` with exhaustiveness via `default: never` compiles. Standard TS control-flow narrowing works because the discriminant field is a raw string literal, not a callable ref.
43. **Discriminant immutability**: `ref.type.set` does not exist at the type level — the discriminant is `Plain<F[D]>` (a string literal), not a `ScalarRef`. At runtime, `ref.type` is a raw string with no `.set()` method. This prevents store corruption where the discriminant says one variant but the fields belong to another.
44. **Discriminant runtime value**: `typeof ref.type === "string"` (not `"function"`). The value matches the store's discriminant field. After whole-product `.set()` with a different variant, the discriminant reflects the new value immediately (it re-reads from the store on every access).
45. **Discriminant snapshot inclusion**: `ref()` snapshot includes the discriminant as a plain string value. The `withReadable` product snapshot builder handles this via its `typeof child === "function" ? child() : child` check — the raw string flows through as-is.

## File Map

```
packages/schema/
├── theory/
│   └── interpreter-algebra.md   # Full theory document
├── src/
│   ├── schema.ts                # Unified recursive type + constructors + ScalarPlain + buildVariantMap
│   ├── loro-schema.ts           # LoroSchema namespace (Loro annotations + plain)
│   ├── change.ts                # ChangeBase + built-in change types
│   ├── changefeed.ts            # CHANGEFEED symbol, Changeset, Changefeed/ComposedChangefeed, Op
│   ├── step.ts                  # Pure (State, Change) → State transitions
│   ├── zero.ts                  # Zero.structural, Zero.overlay
│   ├── describe.ts              # Human-readable schema tree view
│   ├── interpret.ts             # Interpreter interface + catamorphism + Path types + phantom brands + InterpretBuilder + dispatchSum
│   ├── facade/
│   │   ├── change.ts            # Mutation protocol: change, applyChanges, ApplyChangesOptions
│   │   └── observe.ts           # Observation protocol: subscribe, subscribeNode
│   ├── basic/
│   │   ├── create.ts            # createDoc, createDocFromSnapshot, registerDoc helper, WeakMap substrate tracking
│   │   ├── sync.ts              # version, delta, exportSnapshot — PlainSubstrate sync primitives
│   │   └── index.ts             # Curated barrel for @kyneta/schema/basic
│   ├── layers.ts                # Pre-built InterpreterLayer instances for fluent composition
│   ├── combinators.ts           # product, overlay, firstDefined
│   ├── guards.ts                # Shared type-narrowing utilities (isNonNullObject, isPropertyHost)
│   ├── interpreter-types.ts     # RefContext, Plain<S>, Seed<S> — shared types across interpreters
│   ├── substrate.ts             # SubstratePrepare, Version, SubstratePayload, Substrate<F>, SubstrateFactory<F>
│   ├── store.ts                 # Store type, StoreReader, plainStoreReader, readByPath, writeByPath, applyChangeToStore, pathKey
│   ├── ref.ts                   # SchemaRef<S,M> parameterized core + Ref<S>, RWRef<S>, RRef<S> tier aliases
│   ├── interpreters/
│   │   ├── bottom.ts            # bottomInterpreter, makeCarrier, CALL symbol, capability lattice
│   │   ├── navigable.ts         # Type-only: NavigableSequenceRef, NavigableMapRef
│   │   ├── with-navigation.ts   # withNavigation transformer — structural addressing
│   │   ├── with-readable.ts     # withReadable transformer — fills [CALL], adds .get(), toPrimitive
│   │   ├── with-caching.ts      # withCaching transformer — caching + INVALIDATE + prepare-pipeline
│   │   ├── readable.ts          # Type-only: Readable<S>, ReadableSequenceRef, ReadableMapRef
│   │   ├── writable.ts          # withWritable + TRANSACT + WritableContext + executeBatch
│   │   ├── plain.ts             # plainInterpreter — eager deep snapshot
│   │   ├── with-changefeed.ts   # Changefeed transformer — observation + batched notification
│   │   └── validate.ts          # Validate interpreter + validate/tryValidate
│   ├── substrates/
│   │   └── plain.ts             # PlainVersion, createPlainSubstrate, plainContext, plainSubstrateFactory
│   ├── __tests__/
│   │   ├── basic.test.ts        # Integration tests for @kyneta/schema/basic API
│   │   ├── types.test.ts        # Type-level tests (expectTypeOf)
│   │   ├── interpret.test.ts    # Catamorphism, constructors, LoroSchema
│   │   ├── bottom.test.ts       # Bottom interpreter: carriers, CALL symbol
│   │   ├── with-navigation.test.ts
│   │   ├── with-readable.test.ts
│   │   ├── with-caching.test.ts
│   │   ├── plan-cache-update.test.ts
│   │   ├── plan-notifications.test.ts
│   │   ├── readable.test.ts
│   │   ├── writable.test.ts
│   │   ├── transaction.test.ts
│   │   ├── changefeed.test.ts
│   │   ├── facade.test.ts       # change/applyChanges: round-trip, notification, origin, errors
│   │   ├── fluent.test.ts
│   │   ├── guards.test.ts
│   │   ├── zero.test.ts
│   │   ├── describe.test.ts
│   │   ├── step.test.ts
│   │   ├── validate.test.ts
│   │   └── substrate.test.ts
│   └── index.ts                 # Barrel export (Layer 1 — the full toolkit)
├── example/
│   ├── README.md                # Index pointing to basic/ and advanced/
│   ├── helpers.ts               # Shared helpers (log, section, json)
│   ├── basic/
│   │   ├── main.ts              # Getting-started example (Layer 2 — @kyneta/schema/basic)
│   │   └── README.md            # Beginner-friendly documentation
│   └── advanced/
│       ├── main.ts              # Composition algebra example (Layer 1 — @kyneta/schema)
│       └── README.md            # Advanced documentation
├── package.json                 # No runtime deps, ./basic subpath export
├── tsconfig.json
├── tsup.config.ts               # Two entry points: src/index.ts, src/basic/index.ts
└── TECHNICAL.md                 # This file
```
