# Schema Interpreter Algebra — Spike

## Background

The `interpreter-algebra.md` theory document (in `packages/schema/theory/`) describes a target architecture where schemas are pure structure, interpretations are pluggable, and a small set of composable primitives (Feed, Action, Zero, step, overlay, interpret) unify the 10+ parallel `switch (shape._type)` dispatch sites across the codebase.

Through discussion, the design has converged on several key ideas not yet validated in code:

1. **Feed** (`{ head: S, subscribe(cb) → unsub }`) — a unified reactive protocol behind a single `[FEED]` symbol, replacing the current two-symbol `[SNAPSHOT]` + `[REACTIVE]` design. Uses WeakMap-based caching with no `self` parameter.

2. **Action** — a unified type for both operations (developer → backend) and deltas (backend → observer). Text actions use the retain/insert/delete encoding. The same action flows in both directions.

3. **step** — a pure function `(State, Action) → State` that applies an action to a plain value, requiring no CRDT runtime. This is the backend-independent state transition.

4. **Zero** — default values separated from the schema, composable via overlay. `Zero.structural(schema)` derives mechanical defaults; `Zero.for(schema, value)` provides typed custom defaults.

5. **interpret** — a generic catamorphism over the schema functor with thunk-based fields for laziness. Each use case (plain, writable, feed, path, conversion, etc.) becomes a small interpreter definition.

6. **Open actions** — `ActionBase` with a string `type` discriminant replaces the closed `ReactiveDelta` union. Third-party backends define their own action types.

7. **Writable interpreter** — produces refs with mutation methods (`.set()`, `.insert()`, etc.) that construct and dispatch actions through the context. Products use `Object.defineProperty` lazy getters (not Proxies) for schema property access, validating that the generic walker can produce a complete ref tree without Proxy in the common case.

8. **Unified schema grammar** — the schema is one recursive type, not a dual-layer container/value split. Structural constructors (scalar, product, sequence, map, sum) describe shape; annotations describe backend semantics (collaborative text, counter, movable, tree). The container/value boundary is an interpretation concern, not a grammar concern.

This spike proves out these primitives in isolation, **without modifying any existing packages**. The code lives in `packages/schema/` and has no dependency on `@loro-extended/change` or Loro.

## Problem Statement

The theory document contains numerous design decisions that have not been validated in TypeScript:

- Can a single recursive `Schema` type (with annotations) replace the current dual-layer container/value grammar, while still allowing TypeScript to enforce valid composition at build time?
- Can `Feed<S, A>` be expressed with a WeakMap getter pattern that preserves referential identity?
- Can `Action` unify the operation and delta directions with a single type per structural kind?
- Does `step` compose correctly through nested schemas (product containing sequence containing annotated-text)?
- Can `Zero.structural` derive defaults from a schema without `_placeholder` on shapes?
- Can `interpret(schema, interpreter, ctx)` be expressed with thunk-based fields and still support laziness?
- Does the `enrich` combinator produce correct intersection types?
- Can `overlay(primary, fallback)` handle the deep structural merge at each structural kind?
- **Can a writable interpreter produce refs with mutation methods, namespace isolation (symbol-keyed protocol, string-keyed schema properties), and context accumulation (child refs that reach up to parent containers) — all through the generic `interpret()` walker?**
- **Can `Object.defineProperty` with lazy getters replace Proxy for product property dispatch, given that the schema knows all keys upfront?**
- **For structural kinds with dynamic keys (map) or indexed access (sequence), what is the minimal Proxy surface needed?**

## Success Criteria

1. A unified `Schema` type with one recursive grammar — structural constructors (scalar, product, sequence, map, sum) plus an annotation mechanism — that replaces the dual container/value layer
2. A developer-facing constructor API (`Schema.text()`, `Schema.list()`, `Schema.struct()`, etc.) that produces annotated schema nodes and enforces backend-specific composition rules via TypeScript types
3. A `Feed<S, A>` type with WeakMap caching that passes referential identity tests
4. An `ActionBase` protocol with concrete text, sequence, map, replace action types
5. A `step` function that correctly applies text, sequence, map, and replace actions to plain values
6. Round-trip proof: `step(state, action)` applied to an initial state produces expected results for nested schemas
7. A `Zero.structural` function that derives defaults from a schema (no `_placeholder`)
8. `Zero.overlay` that performs deep structural merge with per-structural-kind awareness
9. An `Interpreter<Ctx, A>` interface with cases per structural kind (not per container-vs-value kind), thunk-based product fields
10. An `interpret()` catamorphism that walks a schema with a given interpreter
11. At least three interpreters (plain, zero, writable) rewritten against the generic `interpret()`
12. An `enrich` combinator that adds `[FEED]` to an interpreted result
13. The writable interpreter produces product results where string keys are schema properties and `[FEED]` is symbol-keyed — namespace isolation validated via `Object.keys()` and `"propName" in result`
14. The writable product uses `Object.defineProperty` lazy getters (no Proxy) and child refs are created on first access, not eagerly
15. Writable ref methods (`.set()`, `.get()`) construct and dispatch actions through context
16. A writable scalar-in-product demonstrates the "upward reference" pattern — it reaches its parent through the accumulated context, not by holding a direct reference to a backend type
17. Map writable demonstrates the minimal Proxy case: dynamic keys not known from schema require a Proxy, but the interpreter still goes through `interpret()`

## Gap

- `packages/schema/` has `package.json`, `tsconfig.json`, `tsup.config.ts` but no source code — only the theory document and scaffold
- The primitives exist only in prose; no TypeScript validation
- The unified grammar (collapsing container/value into one recursive type) has not been attempted
- The `step` function is entirely new — nothing like it exists in the codebase
- The unified `Action` type replacing both operations and deltas is new
- The `Feed` protocol with WeakMap caching is new
- Zero separation from schema has not been attempted
- The writable interpreter has never been expressed through a generic walker — today each ref class is hand-written with its own dispatch
- The Proxy vs `Object.defineProperty` question for products has not been tested

## Phases

### Phase 1: Unified schema grammar and core types 🟢

- Task: Create `packages/schema/src/schema.ts` — a single recursive `Schema` type with structural constructors: 🟢
  - `scalar(kind)` — leaf values: `"string"`, `"number"`, `"boolean"`, `"null"`, `"bytes"`, etc. `ScalarKind` is a simple string union (not a separate recursive grammar)
  - `product(fields)` — fixed-key record: `{ [key: string]: Schema }`
  - `sequence(item)` — ordered collection of `Schema`
  - `map(item)` — dynamic-key collection of `Schema`
  - `sum(variants)` — tagged union of `Schema[]` (or discriminated variant map)
  - `annotated(tag, inner?)` — semantic enrichment. The `tag` is a string; `inner` is an optional `Schema` that the annotation wraps. Annotations are how backends attach meaning: `annotated("text")` means collaborative text, `annotated("counter")` means counter semantics, `annotated("movable", sequence(item))` means move-capable sequence, `annotated("tree", product(nodeFields))` means hierarchical tree
  - The annotation set is **open** — backends define their own tags
- Task: Create a developer-facing constructor API in the same file — `Schema.text()`, `Schema.counter()`, `Schema.list(item)`, `Schema.struct(fields)`, `Schema.doc(fields)`, `Schema.record(item)`, `Schema.movableList(item)`, `Schema.tree(nodeData)`, `Schema.plain.string()`, `Schema.plain.number()`, etc. These are **sugar** that produce annotated schema nodes. The API enforces Loro-compatible composition via TypeScript's type system, but the underlying representation is the unified grammar. 🟢
- Task: Create `packages/schema/src/action.ts` — `ActionBase` interface (`{ readonly type: string }`), concrete action types for **structural kinds** (`TextAction` for annotated-text, `SequenceAction<T>` for sequences, `MapAction` for products/maps, `ReplaceAction<T>` for scalars), action op types using retain/insert/delete encoding. Note: action types are **interpretation-level** — the schema says "sequence," the backend picks the action vocabulary. Built-in actions cover the common cases. 🟢
- Task: Create `packages/schema/src/feed.ts` — `FEED` symbol, `Feed<S, A>` interface, `Feedable<S, A>` interface, `getOrCreateFeed` WeakMap helper, `isFeedable` type guard 🟢
- Task: Create `packages/schema/src/index.ts` barrel export 🟢

### Phase 2: step and Zero 🔴

- Task: Create `packages/schema/src/step.ts` — pure `step` functions per action type: `stepText(state, action)`, `stepSequence(state, action)`, `stepMap(state, action)`, `stepReplace(state, action)`. Also a top-level `step(state, action)` that dispatches on the action's `type` discriminant (not on the schema — step is action-driven, schema-agnostic). 🔴
- Task: Create `packages/schema/src/zero.ts` — `Zero.structural(schema)` that derives defaults by walking the unified schema grammar: scalar→`typeDefault(kind)`, product→recurse fields, sequence→`[]`, map→`{}`, sum→first variant's zero, annotated→delegate to inner or use annotation-specific default (e.g. annotated("text")→`""`). `Zero.for(schema, value)` as a type-checked identity. `Zero.partial(schema, partialValue)`. `Zero.overlay(primary, fallback, schema)` — deep structural merge aware of structural kinds. 🔴

### Phase 3: interpret and read-only interpreters 🔴

- Task: Create `packages/schema/src/interpret.ts` — the `Interpreter<Ctx, A>` interface with one case per structural kind: `scalar`, `product`, `sequence`, `map`, `sum`, `annotated`. Product fields are **thunks** (`() => A`). Sequence/map items are **closures** (`(ctx, key) => A`). The `interpret(schema, interpreter, ctx)` catamorphism walks the unified schema tree. Annotations pass through to the interpreter — the interpreter decides what to do with them (ignore, use for backend dispatch, etc.). 🔴
- Task: Create `packages/schema/src/interpreters/plain.ts` — a `plainInterpreter` that takes a plain JS object as context and reads values at each path. Demonstrates `interpret(schema, plainInterpreter, plainObject)` producing the typed result. Annotations are transparent — the plain interpreter reads the same way regardless of annotation. 🔴
- Task: Create `packages/schema/src/interpreters/zero.ts` — a `zeroInterpreter` that ignores context and produces the structural zero. Show that `interpret(schema, zeroInterpreter, undefined)` equals `Zero.structural(schema)`. 🔴

### Phase 4: Writable interpreter and Proxy investigation 🔴

This phase validates the most architecturally significant question: can the writable interpreter — the thing that becomes `TypedDoc` / `TypedRef` / `PlainRef` in production — be expressed through the generic `interpret()` walker?

The writable interpreter does NOT target Loro. It targets a **plain JS object store** as the backend, proving that the architecture is backend-independent. The store is a simple nested object that the writable refs read from and write to.

The key insight for this phase: the writable interpreter uses **annotations** to decide behavior at each node. A bare `scalar("string")` gets a simple `.get()/.set()` ref. An `annotated("text")` scalar gets `.insert()`, `.delete()`, `.toString()`. An `annotated("counter")` scalar gets `.increment()`, `.decrement()`. The structural recursion (products, sequences, maps) is uniform regardless of annotation — only the leaves and annotation-specific behavior differ.

- Task: Create `packages/schema/src/interpreters/writable.ts` — a writable interpreter that produces ref-like objects at each schema node. The context must accumulate as the walker descends: 🔴
  - **Product nodes**: return an object where schema keys are defined via `Object.defineProperty` with lazy getters (no Proxy). Each getter forces the thunk for that child on first access, caches the result, and returns it on subsequent accesses. The `[FEED]` symbol is attached for namespace isolation.
  - **Annotated "text" nodes**: return an object with `.toString()`, `.insert(index, content)`, `.delete(index, length)`, `.update(content)`. Mutation methods construct a `TextAction` and dispatch it to the context's executor.
  - **Annotated "counter" nodes**: return an object with `.get()`, `.increment(n)`, `.decrement(n)`. Mutation methods construct actions and dispatch.
  - **Scalar nodes (unannotated)**: return an object with `.get()` and `.set(value)`. This is the upward reference case — the scalar has no container of its own. It receives its parent's write function through the accumulated context, and `.set(value)` calls `parentWriter(key, value)`. This proves the context accumulation property.
  - **Sequence nodes**: return an object with `.get(index)`, `.push(value)`, `.insert(index, value)`, `.delete(index, count)`, `.length`, and `[Symbol.iterator]`. Mutation methods construct `SequenceAction` and dispatch. `.get(index)` returns a child ref (writable sub-interpretation of the sequence's item schema).
  - **Map nodes**: return a Proxy wrapping a base object. This is the one case where Proxy is necessary — map keys are not known from the schema. The Proxy intercepts string property access and delegates to the interpreter for child ref creation. Contrast with product (no Proxy needed).

- Task: Define the **context accumulation** protocol — `Ctx` carries a `read(path)` function, a `write(path, action)` function (the executor), and an `autoCommit` flag. At each product level, the interpreter derives a child context that narrows the read/write path. At scalar nodes, `write` dispatches a `MapAction` to the parent's path. 🔴

- Task: Define the **action dispatch** protocol — writable ref methods construct actions and call `ctx.write(path, action)`. The executor in the context applies the action to the backing store (the plain JS object). In auto-commit mode, the executor also fires feed subscribers. In batched mode, actions accumulate and are flushed at the end. 🔴

- Task: Demonstrate **namespace isolation** — the writable product result has string keys for schema properties and symbol keys for `[FEED]`. `Object.keys()` returns only schema keys. `[FEED]` is not enumerable. The map Proxy also maintains this: string keys for data, symbols for protocol. 🔴

- Task: Demonstrate **portable refs** — extract a writable scalar ref from the tree, pass it to a standalone function, call `.get()` and `.set()`. The ref carries its context (parent path, write function) and works correctly outside the tree. 🔴

### Phase 5: Composition combinators 🔴

- Task: Create `packages/schema/src/combinators.ts` — `enrich(base, decorator)` that wraps an interpreter, running the base and then applying the decorator to each result. `product(f, g)` that pairs two interpreters. `overlay(primary, fallback)` as an interpreter combinator (distinct from `Zero.overlay` which operates on values). 🔴
- Task: Demonstrate `enrich(writableInterpreter, withFeed)` producing results that satisfy `Feedable<S, A>` — using the writable interpreter from Phase 4 and a `withFeed` decorator that attaches `[FEED]` via `getOrCreateFeed`. 🔴

### Phase 6: Tests 🔴

All tests live in `packages/schema/src/__tests__/`. They prove the primitives work and compose correctly.

- Task: `schema.test.ts` — the unified grammar: `Schema.text()` produces an annotated scalar, `Schema.struct({...})` produces a product, `Schema.list(Schema.text())` produces a sequence containing an annotated scalar, `Schema.plain.string()` produces a bare scalar. Verify structural kind is recoverable. Verify annotations are accessible. Verify that the developer-facing API composes correctly (nested products, sequences of products, maps of annotated nodes, etc.). 🔴
- Task: `feed.test.ts` — WeakMap caching (referential identity across accesses), `isFeedable` type guard, feed with static head, feed with mutable head (getter reflects changes), subscribe + unsubscribe lifecycle 🔴
- Task: `action.test.ts` — TextAction round-trips (insert, delete, retain combinations), SequenceAction round-trips (insert items, delete range, retain + insert), MapAction (set keys, delete keys), ReplaceAction (scalar replacement) 🔴
- Task: `step.test.ts` — `stepText` applies retain/insert/delete to strings, `stepSequence` applies to arrays, `stepMap` applies to objects, `stepReplace` replaces scalars. **Nested step**: define a schema `Schema.doc({ title: Schema.text(), items: Schema.list(Schema.struct({ name: Schema.plain.string() })) })`, build an initial state via `Zero.structural`, apply a sequence of actions, verify the final state matches expectations 🔴
- Task: `zero.test.ts` — `Zero.structural` produces correct defaults for each structural kind (scalar, product, sequence, map, sum) and for annotated nodes (text→"", counter→0). `Zero.for` type-checks against schema. `Zero.partial` accepts partial values. `Zero.overlay` merges partial over structural with per-structural-kind recursion (product merges per-key, sequence uses fallback length, nested products recurse). 🔴
- Task: `interpret.test.ts` — `interpret` with `zeroInterpreter` matches `Zero.structural`, `interpret` with `plainInterpreter` reads from a nested plain object, thunks are not forced until accessed (verify via side-effect counter), `interpret` with `enrich(mockInterpreter, withFeed)` produces feedable results 🔴
- Task: `writable.test.ts` — the critical integration test for the writable interpreter: 🔴
  - **Product lazy getters**: accessing `result.title` the first time creates the ref; accessing it again returns the same ref (referential identity). Accessing `result.title` does NOT force `result.count` (laziness).
  - **Namespace isolation**: `Object.keys(result)` returns only schema keys. `FEED in result` is true. `"title" in result` is true. `"toJSON" in result` is false (not a schema key).
  - **Scalar ref upward write**: `result.settings.darkMode.set(true)` writes to the backing store at the correct path. `result.settings.darkMode.get()` reads from the backing store.
  - **Portable ref**: extract `result.settings.darkMode`, pass to a function, call `.set()` — the backing store is updated.
  - **Action dispatch**: `.set()` on a scalar ref constructs a `MapAction` and dispatches it through the context. Verify the action structure.
  - **Sequence mutation**: `result.items.push({ name: "test" })` dispatches a `SequenceAction` with the correct structure. `result.items.get(0).name.get()` reads from the backing store.
  - **Map Proxy**: `result.players["alice"]` returns a ref via Proxy. `Object.keys(result.players)` returns the dynamic keys from the backing store.
  - **Batched mode**: create a writable with `autoCommit: false`. Multiple writes accumulate. Flush dispatches all at once.
  - **Product vs Map**: product uses `Object.defineProperty` (no Proxy); map uses Proxy. Both go through `interpret()`. Verify via behavioral contract (not implementation detection).
  - **Annotation-driven behavior**: `Schema.text()` writable has `.insert()`, `.delete()`. `Schema.plain.string()` writable has `.get()`, `.set()` only. Both are scalars; the annotation determines the ref surface.

## Learnings

### The dual-layer grammar is a Loro artifact, not a schema property

The existing `@loro-extended/change` shape system has two separate recursive grammars: **container shapes** (text, counter, list, struct, record, tree, doc) and **value shapes** (string, number, boolean, structValue, arrayValue, recordValue, union, discriminatedUnion, any). These mirror each other structurally — both have products (struct), sequences (list/array), and maps (record). The *only* reason they're separate is that Loro's runtime draws a boundary between "containers" (CRDTs with identity) and "values" (opaque blobs inside containers).

But that boundary is a **backend property**, not a schema property. A `Schema.struct({ name: Schema.text() })` and a `Schema.plain.struct({ name: { valueType: "string" } })` both describe the same recursive shape — a fixed-key product with a string-typed field. The difference is whether the backend gives each node its own CRDT identity. That's interpretation, not structure.

The unified grammar collapses these into one recursive type with five structural constructors (scalar, product, sequence, map, sum) plus an open annotation mechanism. "Container vs. value" becomes a partition that a particular backend's interpreter defines — it's in the interpretation, not the syntax.

### Composition constraints are backend-specific, not grammar-specific

Even with a unified grammar, Loro imposes validity rules: you can't nest a `text()` (CRDT container) inside a plain struct value (opaque blob). These are **well-formedness rules** — context-sensitive constraints layered on the context-free recursive type. A different backend would have different rules.

The solution: the internal `Schema` type is unconstrained (anything can nest in anything). The developer-facing constructor API (`Schema.text()`, `Schema.list()`, etc.) uses TypeScript's type system to enforce backend-specific composition constraints. A Loro builder prevents invalid nestings. A Firestore builder would have different constraints. The interpreter, step, zero, and catamorphism all operate on the unconstrained grammar.

### Annotations unify "leaf CRDTs" and "structural modifiers"

In the old grammar, `text` and `counter` were node kinds alongside `list` and `struct` — all at the same level. But mathematically, `text` is "a string with collaborative editing semantics" and `counter` is "a number with increment semantics." These are annotations on scalars, not distinct structural kinds. Similarly, `movableList` is "a sequence with move semantics" — an annotation on a sequence, not a separate structural constructor. The annotation mechanism captures this uniformly.

### Actions are interpretation-level, not schema-level

The original plan defined action types per "schema node kind" (TextAction, ListAction, MapAction). But with the unified grammar, the schema says "sequence" and the backend picks the action vocabulary. A Loro backend might use cursor-based `SequenceAction` for lists. A Firestore backend might use `ReplaceAction<T[]>` for the same sequence (arrays replaced wholesale). The built-in action types cover the common cases but are not mandated by the grammar.

## Transitive Effect Analysis

This spike is **isolated by design** — `packages/schema/` has no dependents and no dependencies on existing packages.

However, decisions made here will inform future phases that DO have transitive effects:

- **Unifying the schema grammar** means the future migration of `@loro-extended/change`'s shape system will collapse the dual `ContainerShape` / `ValueShape` types into one recursive type. This affects every file that dispatches on `shape._type` (10+ sites).
- **Phase 1 of the algebra** (unify feed protocol) will change `@loro-extended/reactive` exports, affecting `@loro-extended/change` (all TypedRef subclasses, reactive-bridge.ts), `@loro-extended/kinetic` (compiler detection in reactive-detection.ts, runtime subscription), `@loro-extended/react` (useReactive hook), and all adapters.
- **Renaming `PlainValueRef` → `PlainRef`** affects the public API of `@loro-extended/change` and all consumer code.
- **Open action vocabulary** (ActionBase replacing ReactiveDelta) affects the Kinetic compiler's `getDeltaKind()` and runtime dispatch.
- **Proxy removal for products** would simplify the `StructRef` implementation in `@loro-extended/change` and potentially improve performance (no Proxy overhead for the most common ref type). The map Proxy remains.

None of these transitive effects are triggered by this spike. The spike validates the primitives in isolation so that the subsequent production phases can proceed with confidence.

## Resources for Implementation Context

| Resource | Path | Relevance |
|---|---|---|
| Theory document | `packages/schema/theory/interpreter-algebra.md` | The full design — Feed, Action, step, Zero, interpret, enrich, overlay, context accumulation, namespace isolation |
| Current shape system | `packages/change/src/shape.ts` | The dual-layer `ContainerShape` / `ValueShape` types that the unified grammar replaces |
| Current struct ref (Proxy) | `packages/change/src/typed-refs/struct-ref.ts` | The Proxy-based struct — what the spike replaces with `defineProperty` |
| Current record ref (Proxy) | `packages/change/src/typed-refs/record-ref.ts` | The Proxy-based record — the minimal Proxy case the spike preserves |
| Current PlainValueRef | `packages/change/src/plain-value-ref/` | The upward-reference pattern the spike's scalar-in-product nodes replicate |
| Current map-based internals | `packages/change/src/typed-refs/map-based-ref-internals.ts` | Context accumulation via `getChildTypedRefParams` and `buildChildTypedRefParams` |
| Current derive-placeholder | `packages/change/src/derive-placeholder.ts` | The tree walk that `Zero.structural` replaces |
| Current overlay | `packages/change/src/overlay.ts` | The deep structural merge that `Zero.overlay` replaces |
| Current path-builder | `packages/change/src/path-builder.ts` | Example of a simple interpreter (walks shape, produces path selectors) |
| Current reactive types | `packages/reactive/src/index.ts` | `REACTIVE`, `SNAPSHOT`, `ReactiveDelta`, `LocalRef` — what Feed replaces |
| Current reactive-bridge | `packages/change/src/reactive-bridge.ts` | Translation of Loro diffs to deltas — what Action unifies |
| Existing schema fixtures | `packages/change/src/schema.fixtures.ts` | Reusable schema patterns for test construction |
| Reactive package config | `packages/reactive/package.json`, `packages/reactive/tsconfig.json` | Reference for package scaffold |

## Alternatives Considered

### Full reification of mutations (free monad)

We explored making every `ref.set()` / `ref.insert()` produce a data description instead of executing immediately. This would enable pure mutation capture, undo/redo as program inversion, and multi-backend replay. However, it requires either a free monad (hostile devX), a shadow state (duplicated CRDT), or a compiler transform. The read-your-writes property inside `change()` blocks is deeply relied upon. **Rejected** in favor of the hybrid approach: mutations execute immediately, but the Action type unifies the operation vocabulary so that the same action structure flows in both directions (intent and notification).

### Keeping placeholders on shapes

The current `_placeholder` on each shape is convenient for devX (co-located with the shape definition). Separating zeros adds a step. We chose separation because: (a) different contexts need different zeros, (b) it simplifies the Shape interface, (c) `Zero.structural` is always available as a zero-config default, and (d) `Zero.for(schema, value)` preserves the type-safety that `_placeholder` provided.

### Two symbols (`[SNAPSHOT]` + `[REACTIVE]`) vs one (`[FEED]`)

The current two-symbol design was motivated by separation of concerns and the possibility of snapshot-only types. In practice, `[SNAPSHOT]` is always paired with `[REACTIVE]` — there are no snapshot-only types in the codebase. The unified `[FEED]` is simpler (one concept), eliminates the `self` parameter (getter has `this`), and models the feed metaphor cleanly (head + tail).

### Closed vs open delta vocabulary

The current `ReactiveDelta` is a closed union of 5 types. Opening it via `ActionBase` with a string discriminant enables third-party backends to define their own action types (e.g., `IncrementAction` for Firestore counters). The Kinetic compiler emits direct calls for known action types and runtime-dispatched calls for unknown ones, with a replace fallback. This gives zero overhead for built-in types and extensibility for third-party types.

### Proxy for all product nodes vs `Object.defineProperty` lazy getters

Today's `StructRef` and `TypedDoc` use `new Proxy(target, handler)` for property dispatch. This is necessary when keys are unknown at construction time (maps), but products have **fixed keys from the schema**. `Object.defineProperty` with lazy getters achieves the same laziness and namespace isolation without Proxy overhead. The spike validates this by implementing the writable product interpreter with `defineProperty` and the writable map interpreter with Proxy, proving both go through the same `interpret()` walker. If `defineProperty` works for products (the most common case), Proxy usage in the production codebase can be reduced to maps and sequences (bracket access only).

### Keeping the dual-layer container/value grammar

The existing codebase separates container shapes and value shapes into two parallel recursive grammars. We considered preserving this in the spike. **Rejected** because: (a) the two grammars mirror each other structurally (both have products, sequences, maps), (b) the container/value boundary is a Loro-specific backend property, not a schema-structural property, (c) a different backend would draw the boundary differently or not at all, (d) the unified grammar halves the interpreter interface size, and (e) composition constraints can be enforced at the builder API level via TypeScript types without baking them into the grammar.

## Documentation Updates

No README or TECHNICAL.md updates are needed for this spike — it is exploratory and produces no public API changes. The theory document (`packages/schema/theory/interpreter-algebra.md`) may be updated if the spike reveals corrections or new insights, but this is a follow-up, not part of the spike itself.

## Changeset

No changeset needed — `packages/schema` is a new internal package with no consumers.