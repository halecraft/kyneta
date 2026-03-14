# @loro-extended/schema — Technical Documentation

This package is an **exploratory spike** validating the Schema Interpreter Algebra described in `theory/interpreter-algebra.md`. It has no runtime dependencies and no consumers — it exists to prove architectural primitives in isolation before integrating them into the production codebase.

## The Key Insight: Unified Schema Grammar

The existing `@loro-extended/change` shape system has two separate recursive grammars: **container shapes** (text, counter, list, struct, record, tree, doc) and **value shapes** (string, number, boolean, structValue, arrayValue, recordValue, union, discriminatedUnion, any). These mirror each other structurally — both have products, sequences, and maps.

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

This mirrors the approach in `@loro-extended/change`, where `Shape.plain.struct<T extends Record<string, ValueShape>>` constrains to `ValueShape` (excluding `ContainerShape`), while `Shape.struct<T extends Record<string, ContainerOrValueShape>>` accepts both.

### Annotations Unify Leaf CRDTs and Structural Modifiers

In the old grammar, `text` and `counter` were node kinds alongside `list` and `struct`. Mathematically, `text` is "a string with collaborative editing semantics" — an annotation on a scalar, not a distinct structural kind. Similarly, `movableList` is "a sequence with move semantics." The annotation mechanism captures this uniformly.

## Architecture

### Schema (`src/schema.ts`)

One recursive `Schema` type discriminated by `_kind`:

| `_kind` | Constructor | Description |
|---|---|---|
| `scalar` | `Schema.scalar("string")` | Terminal value — `ScalarKind` is a string union, not a recursive type |
| `product` | `Schema.product({ x: ..., y: ... })` | Fixed-key record |
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

- `TextChange` — ops over characters
- `SequenceChange<T>` — ops over array items
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

**`TreeEvent<C>` — relative path for tree observation.** Composite refs (products, sequences, maps) implement `ComposedChangefeed`, which adds `subscribeTree(cb: (changeset: Changeset<TreeEvent<C>>) => void)`. Each `TreeEvent` carries `{ path: Path, change: C }` — the path is relative from the subscription point to where the change occurred. `subscribeTree` is a strict superset of `subscribe` (tree subscribers also see own-path changes with `path: []`).

**`Changeset<TreeEvent>` ≅ `(PendingChange[], origin)` isomorphism.** When subscribing at the root, `TreeEvent.path` equals the absolute path. The output of `subscribeTree` can be round-tripped as input to `applyChanges` (modulo path relativity for subtree subscriptions). This is a powerful property for sync: capture tree events on one document, reconstruct `PendingChange[]`, apply to another. Note: tree subscribers receive one `Changeset<TreeEvent>` per affected child path (not one combined changeset per flush), so reconstruction uses `flatMap` across changesets.

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

The generic catamorphism. `Interpreter<Ctx, A>` has one case per structural kind. The `interpret(schema, interpreter, ctx)` function walks the tree, building:

- **Thunks** (`() => A`) for product fields — laziness preserved
- **Closures** (`(index) => A` / `(key) => A`) for sequence/map children
- **Inner thunks** for annotated nodes
- **Sum variants** via `SumVariants<A>` — `byIndex(i)` for positional, `byKey(k)` for discriminated

This single walker replaces the 10+ parallel `switch (shape._type)` dispatch sites in the current codebase.

### Interpreters: The Four-Layer Decomposed Stack

The interpreter system is built from four composable transformer layers that stack on a universal foundation. Each layer adds exactly one capability:

| Layer | Kind | Input → Output | Purpose |
|---|---|---|---|
| `bottomInterpreter` | Foundation | `Interpreter<unknown, HasRead>` | Callable function carriers with `[READ]` slot |
| `withReadable(base)` | Refinement | `HasRead → HasNavigation` | Store reading + structural navigation |
| `withCaching(base)` | Interposition | `HasNavigation → HasCaching` | Identity-preserving child memoization + `[INVALIDATE]` |
| `withWritable(base)` | Extension | `A → A` | Mutation methods (`.set()`, `.insert()`, etc.) |

The standard composition:
```ts
const interp = withWritable(withCaching(withReadable(bottomInterpreter)))
```

Each layer is independently useful. Combinatorial stacks produce valid interpreters at every level:

| Stack | Capabilities | Use case |
|---|---|---|
| `bottomInterpreter` | Carriers only | Foundation for custom transformers |
| `withReadable(bottom)` | Reading + navigation (no caching) | Throwaway reads, tests |
| `withCaching(withReadable(bottom))` | Reading + navigation + caching | Read-only documents |
| `withWritable(bottom)` | Write-only (ref() throws) | Mutation dispatch without reading |
| `withWritable(withReadable(bottom))` | Read + write (no caching) | Ephemeral documents |
| `withWritable(withCaching(withReadable(bottom)))` | Full stack | Standard composition |

#### Capability Lattice

Compile-time composition safety is enforced via a capability lattice using phantom-branded interfaces:

```
HasRead  ←  HasNavigation  ←  HasCaching
```

- **`HasRead`** — has a `[READ]` slot. Produced by `bottomInterpreter`.
- **`HasNavigation extends HasRead`** — has structural navigation (product getters, `.at()`, etc.). Branded with phantom `[NAVIGATION]: true`. Produced by `withReadable`.
- **`HasCaching extends HasNavigation`** — has child caching and `[INVALIDATE]`. Branded with phantom `[CACHING]: true`. Produced by `withCaching`.

TypeScript's structural subtyping enforces valid ordering: `withCaching` requires `HasNavigation` input, so `withCaching(bottomInterpreter)` is a compile error. `withWritable` has no bound on `A` — it works with any carrier.

#### Symbol-Keyed Composability Hooks

Cross-layer communication uses four well-known symbols:

| Symbol | Module | Purpose |
|---|---|---|
| `READ` (`kyneta:read`) | `bottom.ts` | Controls what `carrier()` does — default throws, `withReadable` fills it |
| `INVALIDATE` (`kyneta:invalidate`) | `with-caching.ts` | Change-driven cache invalidation — refs carry it for direct use; `prepare` pipeline fires it automatically |
| `CHANGEFEED` (`kyneta:changefeed`) | `changefeed.ts` | Observation coalgebra — `withChangefeed` attaches it |
| `TRANSACT` (`kyneta:transact`) | `writable.ts` | Context discovery — refs carry a reference to their `WritableContext` |

All use `Symbol.for()` so multiple copies of the module share identity.

#### Bottom Interpreter (`src/interpreters/bottom.ts`)

The universal foundation. Every schema node produces a callable **function carrier** via `makeCarrier()`. The carrier delegates to its `[READ]` slot: `(...args) => carrier[READ](...args)`. By default, `READ` throws `"No reader configured"`.

The carrier is a real `Function` object, so any layer can attach properties (navigation, caching, mutation methods) without replacing the carrier identity. This identity-preserving property is critical — `withReadable`, `withCaching`, and `withWritable` all mutate the same carrier object.

The `product`, `sequence`, `map`, and `sum` cases ignore their thunks/closures/variants — bottom produces inert carriers. The `annotated` case delegates to `inner()` when present.

#### withReadable (`src/interpreters/with-readable.ts`)

The refinement transformer. Fills the `[READ]` slot and adds structural navigation:

- **Scalar:** `READ` returns `readByPath(store, path)` (immutable primitive). Hint-aware `[Symbol.toPrimitive]`.
- **Product:** `READ` folds child values through the carrier's property getters (`result[key]()` for each field), producing a **fresh plain object**. This composes with `withCaching`'s memoized getters — the fold reuses cached child refs but always produces a distinct snapshot. Enumerable lazy getters for each field. **No caching** — each access forces the thunk afresh.
- **Sequence:** `READ` folds child values via the raw `item(i)()` closure (not `result.at()`), producing a **fresh array**. Uses `readByPath` for structure discovery (array length) but never returns the store array directly. The raw closure is used instead of the cached `.at()` because `withCaching`'s cache shifting can leave refs with stale paths after insert/delete. `.at(i)`, `.get(i)`, `.length`, `[Symbol.iterator]`.
- **Map:** `READ` folds child values via the raw `item(key)()` closure, producing a **fresh record**. Same design as sequence — `readByPath` for key discovery, raw closure for values. `.at(key)`, `.get(key)`, `.has(key)`, `.keys()`, `.size`, `.entries()`, `.values()`, `[Symbol.iterator]`. All non-enumerable.
- **Sum:** Uses `dispatchSum(value, schema, variants)` from `store.ts` for store-driven variant resolution.
- **Annotated:** `"text"` → string-coercing reader + toPrimitive. `"counter"` → number-coercing reader + hint-aware toPrimitive. `"doc"`/`"movable"`/`"tree"` → delegate to inner.

**Snapshot isolation.** Composite `ref()` always returns a fresh plain object — mutating the returned value does not affect the store. `ref()` and `plainInterpreter` produce extensionally equal output for the same store state. Both are F-algebras over the schema functor; `ref()` folds through the carrier stack (benefiting from child ref caching), while `plainInterpreter` is a standalone eager fold with no carrier overhead.

**Identity is not preserved at this layer.** `ref.title !== ref.title` — each property access produces a new child ref. Use `withCaching` for identity.

#### withCaching (`src/interpreters/with-caching.ts`)

The interposition transformer. Wraps navigation with memoization:

- **Product:** field getters use `resolved`/`cached` memoization pattern. `ref.title === ref.title`.
- **Sequence:** `Map<number, A>` child cache wrapping `.at(i)`. `seq.at(0) === seq.at(0)`.
- **Map:** `Map<string, A>` child cache wrapping `.at(key)`. `map.at("k") === map.at("k")`.
- **Scalar, sum, annotated:** pass through (no caching needed at leaves).

**Change-driven `[INVALIDATE]`:** Each structural node gets an `[INVALIDATE](change: ChangeBase)` method that interprets the change surgically:

- `SequenceChange` → shift/delete cached entries via `planCacheUpdate` + `applyCacheOps`
- `MapChange` → delete affected keys (both set and delete keys)
- `ReplaceChange` → clear all
- Unknown → clear all (safe fallback)

The invalidation logic is split into **Functional Core** (`planCacheUpdate` — pure, table-testable) and **Imperative Shell** (`applyCacheOps` — trivial `Map` mutation). Both are exported for testing.

`CacheOp` is the instruction set: `clear` (drop all), `delete` (drop specific keys), `shift` (re-key numeric entries by delta).

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

An extension transformer: `withWritable(base)` takes `Interpreter<RefContext, A>` and returns `Interpreter<WritableContext, A>`. It adds mutation methods at each case:

- **Scalar:** `.set(value)` — dispatches `ReplaceChange` at own path.
- **Product:** `.set(plainObject)` — dispatches `ReplaceChange` at own path. Non-enumerable. Enables atomic subtree replacement.
- **Text:** `.insert(index, content)`, `.delete(index, length)`, `.update(content)` — dispatches `TextChange`. `update()` reads current text via `ref()` (the callable read from the base) to compute the delete length.
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
  commit(origin?: string): PendingChange[]
  abort(): void
  readonly inTransaction: boolean
}
```

**Context hierarchy:** `RefContext { store }` → `WritableContext { prepare, flush, dispatch, beginTransaction, commit, abort, inTransaction }`. Each layer adds only what it needs.

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

#### Facade (`src/facade.ts`)

The library-level API for change capture, declarative application, and observation:

- **`change(ref, fn) → PendingChange[]`** — imperative mutation capture. Runs `fn` inside a transaction, returns the captured changes. Aborts on error.
- **`applyChanges(ref, ops, {origin?}) → PendingChange[]`** — declarative application. Applies a list of changes via `executeBatch`, triggering the full prepare pipeline (cache invalidation + store mutation + notification accumulation) then flush (batched `Changeset` delivery). Empty ops is a no-op.
- **`subscribe(ref, cb) → () => void`** — node-level observation. Callback receives `Changeset`. For leaf refs, fires on any mutation. For composite refs, fires only on node-level changes (e.g. product `.set()`), not child mutations.
- **`subscribeTree(ref, cb) → () => void`** — tree-level observation. Callback receives `Changeset<TreeEvent>` with relative paths. Only works on composite refs (products, sequences, maps). A strict superset of `subscribe` — tree subscribers also see own-path changes with `path: []`.

`change` and `applyChanges` are symmetric duals: `change` produces `PendingChange[]`, `applyChanges` consumes them. Round-trip correctness is verified: `change(docA, fn)` → ops → `applyChanges(docB, ops)` → `docA()` deep-equals `docB()`.

All four functions discover capabilities via symbols on refs (`[TRANSACT]` for `change`/`applyChanges`, `[CHANGEFEED]` for `subscribe`/`subscribeTree`). All throw clear errors when the ref lacks the required symbol.

#### Changefeed Transformer (`src/interpreters/with-changefeed.ts`)

An interpreter transformer that attaches `[CHANGEFEED]` to every node in the interpreted tree. For leaf refs, attaches a plain `Changefeed` with `subscribe`. For composite refs (product, sequence, map), attaches a `ComposedChangefeed` with both `subscribe` (node-level) and `subscribeTree` (tree-level observation via subscription composition).

**Notification flow:** `withChangefeed` wraps `ctx.prepare` to accumulate `{path, change}` entries without firing subscribers. It wraps `ctx.flush` to group accumulated entries by `pathKey` (via `planNotifications` — pure FC) and deliver one `Changeset` per subscriber (via `deliverNotifications` — imperative shell). This follows the same FC/IS pattern as `planCacheUpdate`/`applyCacheOps` in `withCaching`.

**Tree notification** propagates via subscription composition (children → parent), not a flat subscriber map. When a leaf's changefeed fires, its parent's `subscribeTree` callback re-prefixes the path and propagates upward. Each child path produces its own `Changeset<TreeEvent>` — so a transaction touching N different paths delivers N tree changesets to the parent (each with the correct relative path prefix).

**Composition:** `withChangefeed(withWritable(withCaching(withReadable(bottomInterpreter))))`

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

This file contains **type-level definitions only** — the runtime implementation has been decomposed into `withReadable` and `withCaching`. The types that remain:

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

**Why iteration yields refs, not values:** Refs are the primary currency of the reactive system. In reactive frameworks (e.g. `packages/core`), iterating over refs to bind them to DOM nodes is the core use case. Plain values are trivially available via fold: `Object.entries(doc.labels())` or `doc.tasks().forEach(...)`.

Sequence iteration follows **Array** semantics (yields bare child refs), while map iteration follows **Map** semantics (yields `[key, ref]` entries).

### Type-Level Interpretation: `Plain<S>`, `Readable<S>`, and `Writable<S>`

Three recursive conditional types map schema types to their corresponding value types:

**`Plain<S>`** — the plain JavaScript/JSON type. `Plain<ScalarSchema<"string", "a" | "b">>` = `"a" | "b"`. `Plain<ProductSchema<{ x: ScalarSchema<"number"> }>>` = `{ x: number }`. Used for `toJSON()` return types, validation result types, and serialization boundaries.

**`Readable<S>`** — the callable ref type. `Readable<ScalarSchema<"number">>` = `(() => number) & { [Symbol.toPrimitive]: ... }`. `Readable<ProductSchema<{ x: ScalarSchema<"number"> }>>` = `(() => { x: number }) & { readonly x: Readable<ScalarSchema<"number">> }`. Used to type the result of interpretation with the composed readable stack.

**`Writable<S>`** — the mutation-only ref type. `Writable<ScalarSchema<"string">>` = `ScalarRef<string>` (just `.set()`). `Writable<ProductSchema<{ x: ScalarSchema<"number"> }>>` = `{ readonly x: ScalarRef<number> } & ProductRef<{ x: number }>` (field refs + `.set()`). `Writable<AnnotatedSchema<"text">>` = `TextRef` (just `.insert()`, `.delete()`, `.update()`). Consumer code that composes both uses `Readable<S> & Writable<S>`.

All three types account for constrained scalars: when `ScalarSchema<K, V>` has a narrowed `V`, `Plain` yields `V`, `Readable` yields `(() => V) & { toPrimitive }`, and `Writable` yields `ScalarRef<V>`.

## Verified Properties

The spike validates these properties via 835 schema tests + 869 core tests:

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
16. **Read-only documents**: `interpret(schema, withCaching(withReadable(bottomInterpreter)), { store })` produces a fully navigable, callable document with no mutation methods.
17. **Change-driven cache invalidation**: `[INVALIDATE](change)` interprets the change surgically — sequence shifts, map key deletes, product clears. Verified via `planCacheUpdate` table tests (31 cases).
18. **Navigate vs Read vocabulary**: map and sequence refs expose two access verbs — `.at(key|index)` for navigation (returns a ref) and `.get(key|index)` for reading (returns a plain value). `.get()` is symmetric with `.set()`. `JSON.stringify(mapRef.get("x"))` returns the serialized value (not `undefined`). Iteration yields refs (not values). Map refs also expose `.has(key)`, `.keys()`, `.size`, `.entries()`, `.values()`, `[Symbol.iterator]`; `.set(key, value)`, `.delete(key)`, `.clear()` for writes. No Proxy, no string index signature.
19. **Sequence `.at()` / `.get()` bounds check**: `.at(100)` on a 2-item array returns `undefined`; `.at(-1)` returns `undefined`. `.get(100)` and `.get(-1)` also return `undefined`. Matches `Array.prototype.at()` semantics.
20. **Capability composition**: `withChangefeed(withWritable(withCaching(withReadable(bottomInterpreter))))` produces refs with all capabilities.
21. **Self-path dispatch**: every mutation dispatches at its own path. Scalar `.set()` dispatches `ReplaceChange` at the scalar's path (not `MapChange` at the parent). Exact-path changefeed subscribers on scalars fire on `.set()`.
22. **Product `.set()`**: `doc.settings.set({ darkMode: true, fontSize: 20 })` dispatches a single `ReplaceChange` at the product's path. The `.set()` method is non-enumerable. Individual field refs still work after product `.set()`. Transactions accumulate one `PendingChange`.
23. **Compile-time composition safety**: `withCaching(bottomInterpreter)` is a compile error — `bottomInterpreter` produces `HasRead`, but `withCaching` requires `HasNavigation`. `withReadable(plainInterpreter)` is also a compile error.
24. **Prepare-pipeline cache invalidation**: `ctx.prepare(path, change)` triggers surgical cache invalidation at the target path via `withCaching`'s pipeline hook. After `push()` on a cached sequence, `.at(newIndex)` returns the correct ref immediately. Unrelated caches are preserved (path-keyed handlers only fire for affected paths).
25. **Combinatorial stacks**: `withWritable(bottomInterpreter)` produces write-only carriers where `ref()` throws but `.set()` dispatches correctly. `withWritable(withReadable(bottomInterpreter))` produces uncached read+write refs.
26. **`TRANSACT` symbol**: `hasTransact(ref)` returns true for refs produced by `withWritable`. The symbol is `Symbol.for("kyneta:transact")`.
27. **Batched notification**: subscribers receive exactly one `Changeset` per flush cycle per affected path, never partially-applied state. Auto-commit wraps a single change in a degenerate `Changeset` of one. Transactions and `applyChanges` deliver multi-change batches.
28. **Declarative change application round-trips with `change`**: `change(docA, fn)` → ops → `applyChanges(docB, ops)` → `docA()` deep-equals `docB()`. Verified for text, sequence (push/insert/delete), counter, map, and mixed mutations.
29. **`applyChanges` invariants**: throws on non-transactable ref; throws during active transaction; empty ops is a no-op (no subscribers fire); `{origin}` option flows to `Changeset.origin`.

## File Map

```
packages/schema/
├── theory/
│   └── interpreter-algebra.md   # Full theory document
├── src/
│   ├── schema.ts                # Unified recursive type + constructors + ScalarPlain + buildVariantMap
│   ├── loro-schema.ts           # LoroSchema namespace (Loro annotations + plain)
│   ├── change.ts                # ChangeBase + built-in change types
│   ├── changefeed.ts            # CHANGEFEED symbol, Changeset, Changefeed/ComposedChangefeed, TreeEvent
│   ├── step.ts                  # Pure (State, Change) → State transitions
│   ├── zero.ts                  # Zero.structural, Zero.overlay
│   ├── describe.ts              # Human-readable schema tree view
│   ├── interpret.ts             # Interpreter interface + catamorphism + Path types
│   ├── facade.ts                # Library-level change, applyChanges, subscribe, subscribeTree
│   ├── layers.ts                # Pre-built InterpreterLayer instances for fluent composition
│   ├── combinators.ts           # product, overlay, firstDefined
│   ├── guards.ts                # Shared type-narrowing utilities (isNonNullObject, isPropertyHost)
│   ├── interpreter-types.ts     # RefContext, Plain<S> — shared types across interpreters
│   ├── store.ts                 # Store type, readByPath, writeByPath, applyChangeToStore, pathKey, dispatchSum
│   ├── interpreters/
│   │   ├── bottom.ts            # bottomInterpreter, makeCarrier, READ symbol, capability lattice
│   │   ├── with-readable.ts     # withReadable transformer — store reading + structural navigation
│   │   ├── with-caching.ts      # withCaching transformer — caching + INVALIDATE + prepare-pipeline hooks
│   │   ├── readable.ts          # Type-only: Readable<S>, ReadableSequenceRef, ReadableMapRef
│   │   ├── writable.ts          # withWritable transformer + TRANSACT + WritableContext + executeBatch
│   │   ├── plain.ts             # Read from plain JS object (eager deep snapshot)
│   │   ├── with-changefeed.ts   # Changefeed transformer — compositional observation + batched notification
│   │   └── validate.ts          # Validate interpreter + validate/tryValidate
│   ├── __tests__/
│   │   ├── types.test.ts        # Type-level tests (expectTypeOf)
│   │   ├── interpret.test.ts    # Catamorphism, constructors, LoroSchema
│   │   ├── bottom.test.ts       # Bottom interpreter: carriers, READ symbol, capability types
│   │   ├── with-readable.test.ts # withReadable: reading, navigation, no caching, sum dispatch
│   │   ├── with-caching.test.ts # withCaching: referential identity, INVALIDATE, prepare-pipeline
│   │   ├── plan-cache-update.test.ts # planCacheUpdate: table-driven cache op tests
│   │   ├── plan-notifications.test.ts # planNotifications: table-driven notification grouping tests
│   │   ├── readable.test.ts     # Composed stack: full read surface via composed interpreters
│   │   ├── writable.test.ts     # withWritable: mutation, cache invalidation, stacks
│   │   ├── transaction.test.ts  # Transaction lifecycle, inTransaction, TRANSACT symbol
│   │   ├── changefeed.test.ts   # Changefeed: subscription, batched notification, tree, origin
│   │   ├── facade.test.ts       # change/applyChanges: round-trip, notification, origin, errors
│   │   ├── fluent.test.ts       # Fluent interpret builder API
│   │   ├── guards.test.ts       # isPropertyHost, isNonNullObject, hasChangefeed
│   │   ├── zero.test.ts         # Zero.structural, Zero.overlay
│   │   ├── describe.test.ts     # Schema tree view rendering
│   │   ├── step.test.ts         # Pure state transitions
│   │   └── validate.test.ts     # Validation: all kinds, errors, type narrowing
│   └── index.ts                 # Barrel export
├── example/
│   ├── main.ts                  # Showcase of the full @kyneta/schema API surface (no local facade)
│   └── README.md                # Example documentation
├── package.json                 # No runtime deps
├── tsconfig.json
├── tsup.config.ts
└── TECHNICAL.md                 # This file
```
