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

**Discriminated sum** — `DiscriminatedSumSchema` with a `discriminant: string` key and `variantMap: Record<string, Schema>`. Created by `Schema.discriminatedUnion(key, map)`. The validate interpreter reads the discriminant value and dispatches to the matching variant in O(1).

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

The `readByPath(store, path)` utility (exported from `writable.ts`) accepts `unknown` as its first parameter so all interpreters — including `plainInterpreter` with its `unknown` context and `validateInterpreter` with its `ValidateContext` — can use it without casts.

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

A changefeed is a coalgebra: `{ current: S, subscribe(cb: (change: C) => void): () => void }`. One symbol (`CHANGEFEED = Symbol.for("kinetic:changefeed")`) replaces the previous two-symbol `SNAPSHOT` + `REACTIVE` design. WeakMap-based caching preserves referential identity (`ref[CHANGEFEED] === ref[CHANGEFEED]`).

### Deep Subscriptions (`subscribeDeep` in `src/interpreters/with-changefeed.ts`)

The `Changefeed` interface provides **exact-path** subscription: a callback on `doc.title[CHANGEFEED].subscribe(cb)` fires only for changes dispatched at path `["title"]`. This is the node-level reactive protocol — a pure Moore machine, unchanged.

**`subscribeDeep`** is **context-level** observation infrastructure that adds subtree subscription without touching the `Changefeed` coalgebra. It lives in `with-changefeed.ts` alongside the other observation infrastructure (`createChangefeedContext`, `changefeedFlush`, `withChangefeed`).

```ts
function subscribeDeep(
  ctx: ChangefeedContext,
  path: Path,
  callback: (event: DeepEvent) => void,
): () => void
```

The callback receives a `DeepEvent`:

```ts
interface DeepEvent {
  readonly origin: Path    // relative path from subscriber to dispatch point
  readonly change: ChangeBase
}
```

**Relative origin:** If you subscribe at `["settings"]` and a change dispatches at `["settings", "darkMode"]`, `origin` is `[{type:"key", key:"darkMode"}]`. If the change dispatches at `["settings"]` itself, `origin` is `[]`. A deep subscriber is a strict superset of an exact subscriber — it sees everything an exact subscriber sees, plus descendants.

**`notifyAll` — the single notification engine.** When a change dispatches at path `P`:

1. **Exact subscribers:** look up `pathKey(P)` in `ctx.subscribers`, invoke matches with the change.
2. **Deep subscribers:** walk `i` from `P.length` down to `0`, compute `pathKey(P.slice(0, i))`, look up in `ctx.deepSubscribers`, invoke matches with `{ origin: P.slice(i), change }`.

This replaces the previous `notifySubscribers` function. Both `createChangefeedContext`'s dispatch wrapper and `changefeedFlush` call `notifyAll` — one function to reason about all dispatch notification.

**Performance:** O(depth) per dispatch for the ancestor walk, where depth is typically 3–5. Zero overhead when no deep subscribers are registered (the map lookups return `undefined`).

**Additive:** `subscribeDeep` is purely additive. The `Changefeed` interface, `HasChangefeed`, `CHANGEFEED` symbol, exact-path `subscribe`, and all ref types are unchanged.

### Step (`src/step.ts`)

Pure state transitions: `(State, Change) → State`. Dispatches on the change's `type` discriminant, not on the schema — step is change-driven and schema-agnostic. Enables optimistic UI, time travel, testing without a CRDT runtime, and read-your-writes in batch mode.

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

### Interpreters (`src/interpreters/`)

Three orthogonal building blocks compose to produce the full developer-facing ref tree:

| Building block | Kind | Context | Purpose |
|---|---|---|---|
| `readableInterpreter` | Interpreter | `RefContext` | Callable function-shaped refs — the foundational read surface |
| `withMutation(base)` | Interpreter transformer | `RefContext → WritableContext` | Adds mutation methods (`.set()`, `.insert()`, `.increment()`, etc.) |
| `withChangefeed` | Decorator (via `enrich`) | `ChangefeedContext` | Adds `[CHANGEFEED]` observation protocol |

Plus two standalone interpreters:

| Interpreter | Context | Result | Purpose |
|---|---|---|---|
| `plainInterpreter` | Plain JS object (store) | `unknown` | Eager deep snapshot — equivalent to `toJSON()` / `value()` |
| `validateInterpreter` | `ValidateContext` | `unknown` | Validate plain values against schema, collect errors |

**Composition:** `enrich(withMutation(readableInterpreter), withChangefeed)`

Each concern is independently useful:
- **Read-only document:** `interpret(schema, readableInterpreter, { store })` — callable refs, no mutation, no dispatch context needed.
- **Read + write:** `interpret(schema, withMutation(readableInterpreter), writableCtx)` — callable refs with mutation methods.
- **Full stack:** `interpret(schema, enrich(withMutation(readableInterpreter), withChangefeed), cfCtx)` — callable refs + mutation + observation.

**Context hierarchy:** `RefContext { store }` → `WritableContext { dispatch, autoCommit, pending }` → `ChangefeedContext { subscribers, deepSubscribers }`. Each layer adds only what it needs.

Note: an earlier version of the spike included a monolithic `writableInterpreter` that fused reading and writing. This was decomposed into `readableInterpreter` + `withMutation` when we recognized that reading is the foundational capability — mutation depends on reading (e.g. `update()` reads current text length), but reading does not depend on mutation. An even earlier version included a `zeroInterpreter` that was also removed as redundant.

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

### Readable Interpreter (`src/interpreters/readable.ts`)

The foundational building block. Every ref is an **arrow function**: `ref()` returns the current plain value at that path via `readByPath(ctx.store, path)`. This is a live read — the value reflects the current store state at call time.

**Product nodes** use `Object.defineProperty` with lazy getters on the function. Each getter forces its thunk on first access, caches the result, and returns the cached value on subsequent accesses. `Object.keys(fn)` returns only schema field names (arrow functions' built-in `name` and `length` are non-enumerable and can be shadowed by `configurable: true` getters).

**Map nodes** (`ReadableMapRef<T, V>`) are arrow functions with **Map-like methods** attached as non-enumerable properties via `Object.defineProperty`. No Proxy is used. Two access verbs provide non-overlapping semantics (see *Design Decision: Navigate vs Read* below):
- `.at(key)` — **navigate**: checks store existence before creating a child ref; returns `undefined` for missing keys. Caches child refs for referential identity: `mapRef.at("x") === mapRef.at("x")`.
- `.get(key)` — **read**: returns the plain value at the key (`Plain<I> | undefined`). Implemented as `.at(key)?.()` — navigate then fold. Symmetric with `.set(key, value)`. `JSON.stringify(mapRef.get("x"))` works correctly (returns data, not `undefined`).
- `.has(key)` — checks if a key exists in the store.
- `.keys()` — returns current store keys.
- `.size` — getter returning the number of store entries.
- `.entries()` — yields `[key, childRef]` pairs (matches `Map` iteration semantics).
- `.values()` — yields child refs.
- `[Symbol.iterator]` — yields `[key, childRef]` pairs (matches `Map`, not `Array`).

All methods are non-enumerable, so `Object.keys(mapRef)` returns `[]` — matching `Object.keys(new Map())` behavior. The type parameter `T` is the ref type (used by `.at()`, iteration), while `V` is the plain value type (used by `.get()`, the call signature). In `Readable<S>`, these are wired as `ReadableMapRef<Readable<I>, Plain<I>>`.

**Sequence nodes** (`ReadableSequenceRef<T, V>`) are callable functions with `.at(i)` for child navigation, `.get(i)` for plain value reads, `.length` getter, and `[Symbol.iterator]` generator. `.at(i)` **checks bounds** — it reads the store array length and returns `undefined` for out-of-bounds indices (including negative indices), matching `Array.prototype.at()` semantics. `.get(i)` returns the plain value at the index (`Plain<I> | undefined`), implemented as `.at(i)?.()`. Note that sequence iteration follows **Array** semantics (yields bare child refs), while map iteration follows **Map** semantics (yields `[key, ref]` entries). In `Readable<S>`, wired as `ReadableSequenceRef<Readable<I>, Plain<I>>`.

**Annotated nodes** dispatch on tag: `"text"` produces a callable ref with text-specific `[Symbol.toPrimitive]` (always returns string); `"counter"` produces a callable ref with hint-aware `[Symbol.toPrimitive]` (number for `"default"`/`"number"`, string for `"string"`); `"doc"`/`"movable"`/`"tree"` delegate to `inner()`. Unannotated scalars get a generic hint-aware `[Symbol.toPrimitive]`.

**Sum nodes** dispatch based on runtime store state (discriminated sums read the discriminant, nullable sums check for null/undefined, general positional sums fall back to first variant).

**Composability hooks:** The readable interpreter exposes one well-known symbol for inter-layer communication:
- `[INVALIDATE](key?)` on sequence/map refs — mutation layer calls this to clear child caches after writes.

### Mutation Layer (`withMutation` in `src/interpreters/writable.ts`)

An interpreter transformer: `withMutation(base)` takes `Interpreter<RefContext, A>` and returns `Interpreter<WritableContext, A>`. It adds mutation methods at each case:

- **Scalar:** `.set(value)` — dispatches `ReplaceChange` at own path.
- **Product:** `.set(plainObject)` — dispatches `ReplaceChange` at own path. Attached as a non-enumerable method via `Object.defineProperty` (same pattern as map refs). Enables atomic subtree replacement: one change instead of N per-leaf operations. `Writable<ProductSchema<F>>` = `{ readonly [K in keyof F]: Writable<F[K]> } & ProductRef<{ [K in keyof F]: Plain<F[K]> }>`.
- **Text:** `.insert(index, content)`, `.delete(index, length)`, `.update(content)` — dispatches `TextChange`. Note: `update()` reads the current text via `ref()` (the callable read from the base) to compute the delete length.
- **Counter:** `.increment(n?)`, `.decrement(n?)` — dispatches `IncrementChange`.
- **Sequence:** `.push(...items)`, `.insert(index, ...items)`, `.delete(index, count?)` — dispatches `SequenceChange`. Calls `[INVALIDATE]()` to clear the full child cache after each mutation.
- **Map:** attaches `.set(key, value)`, `.delete(key)`, and `.clear()` directly to the map ref as non-enumerable methods via `Object.defineProperty`. `.set()` dispatches `MapChange` and calls `[INVALIDATE](key)` for per-key cache invalidation. `.delete()` dispatches `MapChange` with a delete list and calls `[INVALIDATE](key)`. `.clear()` reads all current keys from the store, dispatches a single `MapChange` deleting all of them, and calls `[INVALIDATE]()` (full cache clear). This is a compound operation — there is no primitive "clear" change type.
- **Sum:** pure structural dispatch — delegates to the base interpreter.

#### Dispatch Model

**Every node dispatches at its own path.** This is a universal invariant with no exceptions. Scalar `.set()` dispatches `ReplaceChange` at `["settings", "darkMode"]`, not `MapChange` at `["settings"]`. Product `.set()` dispatches `ReplaceChange` at `["settings"]`. Text `.insert()` dispatches `TextChange` at `["title"]`. The dispatch path always equals the node's path in the schema tree.

This design gives developers two mutation granularities:

- **Leaf `.set()`** for surgical edits — one scalar, one `ReplaceChange`, one notification at the leaf path.
- **Product `.set()`** for bulk replacement — one struct, one `ReplaceChange`, one notification at the product path.

For future Loro integration, a `ReplaceChange` at a product path maps naturally to a single `LoroMap.set(key, entireBlob)` operation. The Loro-specific interpreter (when built) will translate `ReplaceChange` at a plain subtree path into the appropriate Loro API calls. The base library stays backend-agnostic — it models the clean case where every node owns its own dispatch.

> **Historical note:** An earlier version used an "upward reference" pattern where scalar `.set()` dispatched `MapChange` to the parent path. This was a Loro-ism (Loro stores plain values inside `LoroMap` containers, so setting a boolean means calling `loroMap.set("key", true)` on the parent). The upward dispatch broke exact-path subscribers on scalars, conflated change types, and prevented product-level `.set()`. It was removed in favor of self-path dispatch.

**Change dispatch** supports auto-commit (immediate apply + notify) and batched mode (accumulate in `pending`, apply on `flush()`).

**Why `withMutation` is not a `Decorator`:** The `Decorator<Ctx, A, P>` type receives `(result, ctx, path)` but no schema information. Mutation is tag-dependent (text gets `.insert()`, counter gets `.increment()`), so it needs `schema.tag` in the `annotated` case. This makes it an interpreter transformer (wraps the full 6-case interpreter) rather than a decorator.

### Type-Level Interpretation: `Plain<S>`, `Readable<S>`, and `Writable<S>`

Three recursive conditional types map schema types to their corresponding value types:

**`Plain<S>`** — the plain JavaScript/JSON type. `Plain<ScalarSchema<"string", "a" | "b">>` = `"a" | "b"`. `Plain<ProductSchema<{ x: ScalarSchema<"number"> }>>` = `{ x: number }`. Used for `toJSON()` return types, validation result types, and serialization boundaries.

**`Readable<S>`** — the callable ref type. `Readable<ScalarSchema<"number">>` = `(() => number) & { [Symbol.toPrimitive]: ... }`. `Readable<ProductSchema<{ x: ScalarSchema<"number"> }>>` = `(() => { x: number }) & { readonly x: Readable<ScalarSchema<"number">> }`. Used to type the result of `interpret(schema, readableInterpreter, ctx)`.

**`Writable<S>`** — the mutation-only ref type. `Writable<ScalarSchema<"string">>` = `ScalarRef<string>` (just `.set()`). `Writable<ProductSchema<{ x: ScalarSchema<"number"> }>>` = `{ readonly x: ScalarRef<number> } & ProductRef<{ x: number }>` (field refs + `.set()`). `Writable<AnnotatedSchema<"text">>` = `TextRef` (just `.insert()`, `.delete()`, `.update()`). Consumer code that composes both uses `Readable<S> & Writable<S>`.

All three types account for constrained scalars: when `ScalarSchema<K, V>` has a narrowed `V`, `Plain` yields `V`, `Readable` yields `(() => V) & { toPrimitive }`, and `Writable` yields `ScalarRef<V>`.

### Design Decision: Navigate vs Read

Collections support two distinct operations that were originally conflated under a single `.get()` verb on maps:

1. **Navigate** — descend the schema tree to obtain a **ref** (a handle with identity, subscriptions, mutation capabilities).
2. **Read** — extract the current **plain value** at a position.

For products, these are cleanly separated: `doc.settings` navigates (property access → ref), `doc.settings()` reads (call → plain value). For collections, the vocabulary is:

| Verb | Operation | Returns | Available on |
|---|---|---|---|
| `.at(key\|index)` | Navigate | `Ref \| undefined` | Maps, Sequences |
| `.get(key\|index)` | Read | `Plain<I> \| undefined` | Maps, Sequences |
| `()` | Fold | `Plain<S>` | All refs |

`.get()` is defined as `.at(x)?.()` — it composes navigation and fold. This avoids duplicating store-reading logic and automatically benefits from cache invalidation (after mutation, `[INVALIDATE]` clears the child cache → `.get()` calls `.at()` → cache miss → fresh ref → fresh value).

**Why `.at()` for navigation:** `.at()` already existed on sequences (matching `Array.prototype.at()` semantics). Extending it to maps creates a uniform navigation verb for all dynamic-key collections.

**Why `.get()` for reading:** Every JavaScript collection API (`Map`, `WeakMap`, `URLSearchParams`, `Headers`, `FormData`) uses `.get()` to return a value. Making `.get()` return a ref violated universal developer expectations, caused type asymmetry with `.set()`, and produced `undefined` from `JSON.stringify()` (since refs are functions).

**Why iteration yields refs, not values:** Refs are the primary currency of the reactive system. In reactive frameworks (e.g. `packages/kinetic`), iterating over refs to bind them to DOM nodes is the core use case. Plain values are trivially available via fold: `Object.entries(doc.labels())` or `doc.tasks().forEach(...)`.

## Verified Properties

The spike validates these properties via 538 tests:

1. **Laziness**: after `interpret()`, zero thunks are forced. Accessing one field does not force siblings.
2. **Referential identity**: `doc.title === doc.title` — lazy getters cache on first access. `mapRef.at("x") === mapRef.at("x")` — map child refs are cached.
3. **Namespace isolation**: `Object.keys(doc)` returns only schema property names (even on function-shaped refs). `Object.keys(mapRef)` returns `[]` (methods are non-enumerable). `CHANGEFEED in doc` is true. `CHANGEFEED` is non-enumerable.
4. **Portable refs**: `const ref = doc.settings.fontSize; bump(ref)` — works outside the tree because context is captured in closures.
5. **Plain round-trip**: `interpret(schema, plainInterpreter, store)` produces the identical object tree.
6. **Changefeed subscription**: `doc.title[CHANGEFEED].subscribe(cb)` receives changes; unsubscribe stops notifications.
7. **Deep subscriptions**: `subscribeDeep(cfCtx, path, cb)` receives changes at the path and all descendants, with relative `origin` paths.
8. **Batched mode**: `autoCommit: false` accumulates changes; `flush()` applies all at once.
9. **Constrained scalar defaults**: `Zero.structural(Schema.string("a", "b"))` returns `"a"` (first constraint value).
10. **Validation collects all errors**: `tryValidate` on a value with N type mismatches returns N errors (no short-circuit).
11. **Positional sum rollback**: failed variant errors are discarded; successful variant produces zero spurious errors.
12. **Type narrowing**: `validate(schema, value)` return type is `Plain<typeof schema>` — verified via `expectTypeOf`.
13. **Discriminated sum dispatch**: readable interpreter reads the discriminant from the store and produces the correct variant's callable ref.
14. **Nullable dispatch**: readable interpreter checks for `null`/`undefined` and dispatches to the correct positional variant.
15. **Callable refs**: every ref produced by `readableInterpreter` is `typeof "function"` and returns its current plain value when called.
16. **`toPrimitive` coercion**: `` `Stars: ${doc.count}` `` works via `[Symbol.toPrimitive]`; counter is hint-aware (number for default, string for string hint).
17. **Read-only documents**: `interpret(schema, readableInterpreter, { store })` produces a fully navigable, callable document with no mutation methods.
18. **Cache invalidation**: `[INVALIDATE]()` clears full cache; `[INVALIDATE](key)` clears single entry. Verified on both sequence and map refs.
19. **Navigate vs Read vocabulary**: map and sequence refs expose two access verbs — `.at(key|index)` for navigation (returns a ref) and `.get(key|index)` for reading (returns a plain value). `.get()` is symmetric with `.set()`. `JSON.stringify(mapRef.get("x"))` returns the serialized value (not `undefined`). Iteration yields refs (not values). Map refs also expose `.has(key)`, `.keys()`, `.size`, `.entries()`, `.values()`, `[Symbol.iterator]`; `.set(key, value)`, `.delete(key)`, `.clear()` for writes. No Proxy, no string index signature.
20. **Sequence `.at()` / `.get()` bounds check**: `.at(100)` on a 2-item array returns `undefined`; `.at(-1)` returns `undefined`. `.get(100)` and `.get(-1)` also return `undefined`. Matches `Array.prototype.at()` semantics.
21. **Capability composition**: `enrich(withMutation(readableInterpreter), withChangefeed)` produces refs with all three capabilities.
22. **Self-path dispatch**: every mutation dispatches at its own path. Scalar `.set()` dispatches `ReplaceChange` at the scalar's path (not `MapChange` at the parent). Exact-path changefeed subscribers on scalars fire on `.set()`.
23. **Product `.set()`**: `doc.settings.set({ darkMode: true, fontSize: 20 })` dispatches a single `ReplaceChange` at the product's path. The `.set()` method is non-enumerable. Individual field refs still work after product `.set()`. Batched mode accumulates one `PendingChange`.

## File Map

```
packages/schema/
├── theory/
│   └── interpreter-algebra.md   # Full theory document
├── src/
│   ├── schema.ts                # Unified recursive type + constructors + ScalarPlain
│   ├── loro-schema.ts           # LoroSchema namespace (Loro annotations + plain)
│   ├── change.ts                # ChangeBase + built-in change types
│   ├── changefeed.ts            # CHANGEFEED symbol, Changefeed/HasChangefeed, WeakMap cache
│   ├── step.ts                  # Pure (State, Change) → State transitions
│   ├── zero.ts                  # Zero.structural, Zero.overlay
│   ├── describe.ts              # Human-readable schema tree view
│   ├── interpret.ts             # Interpreter interface + catamorphism + Path types
│   ├── combinators.ts           # enrich, product, overlay, firstDefined
│   ├── guards.ts                # Shared type-narrowing utilities (isNonNullObject, isPropertyHost)
│   ├── interpreter-types.ts     # RefContext, Plain<S> — shared types across interpreters
│   ├── store.ts                 # Store type, readByPath, writeByPath, applyChangeToStore
│   ├── interpreters/
│   │   ├── readable.ts          # Callable function-shaped refs + Readable<S> + composability symbols
│   │   ├── writable.ts          # withMutation transformer + mutation-only ref interfaces + Writable<S>
│   │   ├── plain.ts             # Read from plain JS object (eager deep snapshot)
│   │   ├── with-changefeed.ts   # Changefeed decorator (observation layer)
│   │   └── validate.ts          # Validate interpreter + validate/tryValidate
│   ├── __tests__/
│   │   ├── types.test.ts        # Type-level tests (expectTypeOf)
│   │   ├── interpret.test.ts    # Catamorphism, constructors, LoroSchema
│   │   ├── readable.test.ts     # Read-only callable refs, toPrimitive, navigation, hooks
│   │   ├── writable.test.ts     # Mutation + read integration via withMutation(readableInterpreter)
│   │   ├── guards.test.ts       # isPropertyHost, isNonNullObject, hasChangefeed
│   │   ├── with-changefeed.test.ts # Changefeed subscription, batched mode
│   │   ├── zero.test.ts         # Zero.structural, Zero.overlay
│   │   ├── describe.test.ts     # Schema tree view rendering
│   │   ├── step.test.ts         # Pure state transitions
│   │   └── validate.test.ts     # Validation: all kinds, errors, type narrowing
│   └── index.ts                 # Barrel export
├── example/
│   ├── main.ts                  # Self-contained mini-app
│   └── README.md                # Example documentation
├── package.json                 # No runtime deps
├── tsconfig.json
├── tsup.config.ts
└── TECHNICAL.md                 # This file
```
