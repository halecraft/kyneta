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

Three built-in interpreters plus a decorator:

| Interpreter | Context | Result | Purpose |
|---|---|---|---|
| `plainInterpreter` | Plain JS object (store) | `unknown` | Read values at each path — equivalent to `toJSON()` / `value()` |
| `writableInterpreter` | `WritableContext` | Ref-like objects | Mutation methods, namespace isolation, portable refs |
| `validateInterpreter` | `ValidateContext` | `unknown` | Validate plain values against schema, collect errors |
| `withChangefeed` (decorator) | `ChangefeedContext` | Enriched refs | Adds `[CHANGEFEED]` subscription to writable refs |

Note: an earlier version of the spike included a `zeroInterpreter` that proved `Zero.structural(schema)` is expressible as `interpret(schema, zeroInterpreter, undefined)`. This equivalence is mathematically interesting (documented in the theory) but the runtime artifact was redundant — `Zero.structural` is simpler and canonical. The zero interpreter was removed.

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

### Writable Interpreter (`src/interpreters/writable.ts`)

The most architecturally significant piece. Validates that writable refs can be expressed through the generic `interpret()` walker backed by a plain JS object store (no CRDT runtime).

**Context design.** `WritableContext` is the *same object* at every tree level — it carries the store, dispatch function, and subscriber map. The "where am I" information comes from the catamorphism's `path` parameter, which narrows automatically as the walker descends. No context re-derivation is needed.

**Product nodes** use `Object.defineProperty` with lazy getters (no Proxy). Each getter forces its thunk on first access, caches the result, and returns the cached value on subsequent accesses. `[CHANGEFEED]` is attached as a non-enumerable symbol property — `Object.keys()` returns only schema keys.

**Map nodes** use `Proxy` — the one case where Proxy is necessary because keys are not known from the schema. The Proxy intercepts string property access for data and delegates symbol access to the base object for protocol.

**Scalar nodes** demonstrate the "upward reference" pattern: `.set(value)` dispatches a `MapChange` to the *parent* path. The scalar carries no container of its own — it reaches its parent through the accumulated context captured in closures.

**Annotated nodes** dispatch on tag: `"text"` produces a `TextRef` with `.insert()/.delete()/.update()`, `"counter"` produces a `CounterRef` with `.increment()/.decrement()`, `"doc"/"movable"/"tree"` delegate to the inner schema.

**Change dispatch** supports auto-commit (immediate apply + notify) and batched mode (accumulate in `pending`, apply on `flush()`).

**Sum nodes** dispatch based on runtime store state:
- **Discriminated sums:** read the discriminant key from the store value and dispatch to the matching variant via `variants.byKey()`. Falls back to the first variant if the value is missing, not an object, or the discriminant is unrecognized.
- **Nullable sums** (positional, 2 variants, first is `scalar("null")`): check whether the store value is `null`/`undefined` and dispatch to the null variant (index 0) or the inner variant (index 1) accordingly.
- **General positional sums:** no runtime discriminator is available without backend-specific type information, so the first variant is used as a fallback.

### Type-Level Interpretation: `Plain<S>` and `Writable<S>`

Two recursive conditional types map schema types to their corresponding value types:

**`Plain<S>`** — the plain JavaScript/JSON type. `Plain<ScalarSchema<"string", "a" | "b">>` = `"a" | "b"`. `Plain<ProductSchema<{ x: ScalarSchema<"number"> }>>` = `{ x: number }`. Used for `toJSON()` return types, validation result types, and serialization boundaries.

**`Writable<S>`** — the ref type. `Writable<ScalarSchema<"string">>` = `ScalarRef<string>`. `Writable<AnnotatedSchema<"text">>` = `TextRef`. Used to type the result of `interpret(schema, writableInterpreter, ctx)`.

Both types account for constrained scalars: when `ScalarSchema<K, V>` has a narrowed `V`, `Plain` yields `V` (not `ScalarPlain<K>`) and `Writable` yields `ScalarRef<V>`.

## Verified Properties

The spike validates these properties via 398 tests:

1. **Laziness**: after `interpret()`, zero thunks are forced. Accessing one field does not force siblings.
2. **Referential identity**: `doc.title === doc.title` — lazy getters cache on first access.
3. **Namespace isolation**: `Object.keys(doc)` returns only schema property names. `CHANGEFEED in doc` is true. `CHANGEFEED` is non-enumerable.
4. **Portable refs**: `const ref = doc.settings.fontSize; bump(ref)` — works outside the tree because context is captured in closures.
5. **Plain round-trip**: `interpret(schema, plainInterpreter, store)` produces the identical object tree.
6. **Changefeed subscription**: `doc.title[CHANGEFEED].subscribe(cb)` receives changes; unsubscribe stops notifications.
7. **Deep subscriptions**: `subscribeDeep(cfCtx, path, cb)` receives changes at the path and all descendants, with relative `origin` paths.
8. **Batched mode**: `autoCommit: false` accumulates changes; `flush()` applies all at once.
9. **Constrained scalar defaults**: `Zero.structural(Schema.string("a", "b"))` returns `"a"` (first constraint value).
10. **Validation collects all errors**: `tryValidate` on a value with N type mismatches returns N errors (no short-circuit).
11. **Positional sum rollback**: failed variant errors are discarded; successful variant produces zero spurious errors.
12. **Type narrowing**: `validate(schema, value)` return type is `Plain<typeof schema>` — verified via `expectTypeOf`.
13. **Discriminated sum dispatch**: writable interpreter reads the discriminant from the store and produces the correct variant's ref.
14. **Nullable dispatch**: writable interpreter checks for `null`/`undefined` and dispatches to the correct positional variant.

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
│   ├── guards.ts                # Shared type-narrowing utilities (isNonNullObject)
│   ├── store.ts                 # Store type, readByPath, writeByPath, applyChangeToStore
│   ├── interpreters/
│   │   ├── plain.ts             # Read from plain JS object
│   │   ├── writable.ts          # Ref-like objects + Plain<S> + Writable<S>
│   │   ├── with-changefeed.ts   # Changefeed decorator (observation layer)
│   │   └── validate.ts          # Validate interpreter + validate/tryValidate
│   ├── __tests__/
│   │   ├── types.test.ts        # Type-level tests (expectTypeOf)
│   │   ├── interpret.test.ts    # Catamorphism, constructors, LoroSchema
│   │   ├── writable.test.ts     # Writable refs, actions, portable refs
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
