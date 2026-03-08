# @loro-extended/schema — Technical Documentation

This package is an **exploratory spike** validating the Schema Interpreter Algebra described in `theory/interpreter-algebra.md`. It has no runtime dependencies and no consumers — it exists to prove architectural primitives in isolation before integrating them into the production codebase.

## The Key Insight: Unified Schema Grammar

The existing `@loro-extended/change` shape system has two separate recursive grammars: **container shapes** (text, counter, list, struct, record, tree, doc) and **value shapes** (string, number, boolean, structValue, arrayValue, recordValue, union, discriminatedUnion, any). These mirror each other structurally — both have products, sequences, and maps.

This dual-layer split is a **Loro implementation detail**, not a schema-structural property. Loro distinguishes "containers" (CRDTs with identity) from "values" (opaque blobs inside containers). But a different backend would draw the boundary differently or not at all.

The spike collapses both layers into **one recursive type** with five structural constructors plus an open annotation mechanism:

```
SchemaF<A> =
  | Scalar(kind)                    — leaf: string, number, boolean, null, bytes, any
  | Product({ k₁: A, k₂: A, … })  — fixed-key record (struct, doc)
  | Sequence(A)                     — ordered collection (list)
  | Map(A)                          — dynamic-key collection (record)
  | Sum(A[])                        — union / discriminated union
  | Annotated(tag, A?)              — semantic enrichment (text, counter, movable, tree, doc)
```

Annotations attach backend semantics without changing the recursive structure. `Schema.text()` is `annotated("text")`. `Schema.counter()` is `annotated("counter")`. `Schema.movableList(item)` is `annotated("movable", sequence(item))`. The annotation set is open — third-party backends define their own tags.

### Composition Constraints Are Backend-Specific

Even with a unified grammar, Loro imposes validity rules (e.g. you can't nest a CRDT container inside a plain value blob). These are **well-formedness rules** — context-sensitive constraints layered on the context-free grammar. The solution: the internal `Schema` type is unconstrained; the developer-facing constructor API (`Schema.text()`, `Schema.struct()`, etc.) uses TypeScript's type system to enforce backend-specific constraints at build time.

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

Developer-facing sugar (`Schema.text()`, `Schema.struct()`, `Schema.doc()`, `Schema.plain.string()`, etc.) produces nodes in this grammar.

### Actions (`src/action.ts`)

Actions are **interpretation-level** — the schema says "sequence," the backend picks the action vocabulary. Built-in action types use the retain/insert/delete cursor encoding:

- `TextAction` — ops over characters
- `SequenceAction<T>` — ops over array items
- `MapAction` — key-level set/delete
- `ReplaceAction<T>` — wholesale scalar swap
- `IncrementAction` — counter delta
- `TreeAction` — create/delete/move tree nodes

Actions are an open protocol (`ActionBase` with string `type` discriminant). Third-party backends extend with their own types.

### Feed (`src/feed.ts`)

A feed is a coalgebra: `{ head: S, subscribe(cb: (action: A) => void): () => void }`. One symbol (`FEED = Symbol.for("kinetic:feed")`) replaces the previous two-symbol `SNAPSHOT` + `REACTIVE` design. WeakMap-based caching preserves referential identity (`ref[FEED] === ref[FEED]`).

### Step (`src/step.ts`)

Pure state transitions: `(State, Action) → State`. Dispatches on the action's `type` discriminant, not on the schema — step is action-driven and schema-agnostic. Enables optimistic UI, time travel, testing without a CRDT runtime, and read-your-writes in batch mode.

### Zero (`src/zero.ts`)

Default values separated from the schema. `Zero.structural(schema)` derives mechanical defaults by walking the grammar. `Zero.overlay(primary, fallback, schema)` performs deep structural merge — products recurse per-key, leaves use `firstDefined`. This replaces the `_placeholder` mechanism on shapes.

### Interpret (`src/interpret.ts`)

The generic catamorphism. `Interpreter<Ctx, A>` has one case per structural kind. The `interpret(schema, interpreter, ctx)` function walks the tree, building:

- **Thunks** (`() => A`) for product fields — laziness preserved
- **Closures** (`(index) => A` / `(key) => A`) for sequence/map children
- **Inner thunks** for annotated nodes

This single walker replaces the 10+ parallel `switch (shape._type)` dispatch sites in the current codebase.

### Interpreters (`src/interpreters/`)

Three built-in interpreters validate the pattern:

| Interpreter | Context | Result | Purpose |
|---|---|---|---|
| `plainInterpreter` | Plain JS object (store) | `unknown` | Read values at each path — equivalent to `toJSON()` / `value()` |
| `zeroInterpreter` | `void` | `unknown` | Produce structural defaults — proven equivalent to `Zero.structural()` |
| `writableInterpreter` | `WritableContext` | Ref-like objects | Mutation methods, namespace isolation, portable refs |

### Writable Interpreter (`src/interpreters/writable.ts`)

The most architecturally significant piece. Validates that writable refs can be expressed through the generic `interpret()` walker backed by a plain JS object store (no CRDT runtime).

**Context design.** `WritableContext` is the *same object* at every tree level — it carries the store, dispatch function, and subscriber map. The "where am I" information comes from the catamorphism's `path` parameter, which narrows automatically as the walker descends. No context re-derivation is needed.

**Product nodes** use `Object.defineProperty` with lazy getters (no Proxy). Each getter forces its thunk on first access, caches the result, and returns the cached value on subsequent accesses. `[FEED]` is attached as a non-enumerable symbol property — `Object.keys()` returns only schema keys.

**Map nodes** use `Proxy` — the one case where Proxy is necessary because keys are not known from the schema. The Proxy intercepts string property access for data and delegates symbol access to the base object for protocol.

**Scalar nodes** demonstrate the "upward reference" pattern: `.set(value)` dispatches a `MapAction` to the *parent* path. The scalar carries no container of its own — it reaches its parent through the accumulated context captured in closures.

**Annotated nodes** dispatch on tag: `"text"` produces a `TextRef` with `.insert()/.delete()/.update()`, `"counter"` produces a `CounterRef` with `.increment()/.decrement()`, `"doc"/"movable"/"tree"` delegate to the inner schema.

**Action dispatch** supports auto-commit (immediate apply + notify) and batched mode (accumulate in `pending`, apply on `flush()`).

## Verified Properties

The spike validates these properties via runtime smoke tests (formal test suite in Phase 6):

1. **Laziness**: after `interpret()`, zero thunks are forced. Accessing one field does not force siblings.
2. **Referential identity**: `doc.title === doc.title` — lazy getters cache on first access.
3. **Namespace isolation**: `Object.keys(doc)` returns only schema property names. `FEED in doc` is true. `FEED` is non-enumerable.
4. **Portable refs**: `const ref = doc.settings.fontSize; bump(ref)` — works outside the tree because context is captured in closures.
5. **Zero equivalence**: `interpret(schema, zeroInterpreter, undefined)` produces output identical to `Zero.structural(schema)`.
6. **Plain round-trip**: `interpret(schema, plainInterpreter, store)` produces the identical object tree.
7. **Feed subscription**: `doc.title[FEED].subscribe(cb)` receives actions; unsubscribe stops notifications.
8. **Batched mode**: `autoCommit: false` accumulates actions; `flush()` applies all at once.

## File Map

```
packages/schema/
├── theory/
│   └── interpreter-algebra.md   # Full theory document
├── src/
│   ├── schema.ts                # Unified recursive type + constructors
│   ├── action.ts                # ActionBase + built-in action types
│   ├── feed.ts                  # FEED symbol, Feed/Feedable, WeakMap cache
│   ├── step.ts                  # Pure (State, Action) → State transitions
│   ├── zero.ts                  # Zero.structural, Zero.overlay
│   ├── interpret.ts             # Interpreter interface + catamorphism
│   ├── interpreters/
│   │   ├── plain.ts             # Read from plain JS object
│   │   ├── zero.ts              # Produce structural defaults
│   │   └── writable.ts          # Ref-like objects with mutation methods
│   └── index.ts                 # Barrel export
├── package.json                 # No runtime deps
├── tsconfig.json
└── tsup.config.ts
```
