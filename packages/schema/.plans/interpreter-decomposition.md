# Interpreter Decomposition

## Background

The `@kyneta/schema` package implements a schema interpreter algebra where a recursive schema type is walked by a generic catamorphism (`interpret`), producing refs at each node. Today, three building blocks compose to form the full ref surface:

1. **`readableInterpreter`** — callable function-shaped refs with store reading, structural navigation, child caching, and the `INVALIDATE` composability hook
2. **`withMutation(base)`** — interpreter transformer adding `.set()`, `.insert()`, `.increment()`, etc., and calling `INVALIDATE` after mutations
3. **`withChangefeed`** — `enrich` decorator attaching `[CHANGEFEED]` observation protocol (transitional scaffolding; replaced by `withCompositionalChangefeed` in the compositional-changefeeds plan)

The compositional-changefeeds plan (Phases 3–6) requires a cleaner interpreter stack. During planning for that work, analysis revealed several architectural issues with the current decomposition that must be resolved first.

### Entangled Concerns in `readableInterpreter`

`readableInterpreter` fuses three distinct responsibilities:

1. **Carrier creation** — producing a callable function at each node
2. **Store reading** — `ref()` returns `readByPath(store, path)`, structural navigation (`.at(i)`, `.keys()`, lazy product getters)
3. **Child caching** — `childCache` maps on sequences/maps, `resolved`/`cached` flags on product fields, and the `INVALIDATE` hook

These concerns have different consumers. Store reading is consumed by developers and by the mutation layer (e.g., `update()` reads current text length). Caching is consumed by the mutation layer (which calls `INVALIDATE`) and by the future compositional changefeed (which needs stable ref identity for subscription management). The carrier is consumed by every layer above.

Fusing them means:
- Caching cannot be omitted (write-only stacks, ephemeral drafts don't need it)
- `readableInterpreter` cannot serve as a true bottom of the stack — it has too many opinions
- The `INVALIDATE` hook has a timing problem: `withMutation` calls it *after* dispatch, but the compositional changefeed's dispatch wrapper fires subscribers *during* dispatch, before `INVALIDATE` runs. Subscribers see a stale cache.

### INVALIDATE Timing

When `withMutation`'s `.push()` calls `ctx.dispatch(path, change)`, the compositional changefeed's dispatch wrapper fires subscribers synchronously during that call. Then `.push()` calls `result[INVALIDATE]()` *after* dispatch returns. This means tree subscribers that call `.at()` during notification see stale cache entries for shifted indices.

The fix requires the mutation layer to invalidate *before* dispatching, which is natural — the mutation method has the change in hand and knows the structural impact. But today, `INVALIDATE` is a blunt `clear(key?)` that only understands "remove one entry" or "remove all." Structural mutations (insert-in-middle, delete-in-middle) don't invalidate data — they shift the mapping between indices and data. A smarter API is needed.

### The Change as Universal Language

A `Change` object already encodes exactly what happened: `SequenceChange` carries retain/insert/delete ops, `MapChange` carries set/delete keys, `ReplaceChange` carries the new value. Rather than inventing a separate cache-operation vocabulary (`shift`/`unshift`/`clear`), the cache layer should accept the change itself and interpret it against its own structure. The change is a morphism applied to two parallel state carriers — the store (by `applyChangeToStore`) and the cache (by `INVALIDATE`). They are homomorphic: the same change description produces consistent results on both.

### No True Bottom Interpreter

The stack currently has no universal foundation. `readableInterpreter` is the de facto bottom, but it produces opinionated carriers (callable, store-reading, caching). Other interpreters (`plainInterpreter`, `validateInterpreter`) are standalone — they don't participate in the transformer stack. There is no inert carrier that transformers can uniformly build upon.

A `bottomInterpreter` that produces callable no-op carriers at every node would let each transformer add exactly one capability. Stacks that don't need reading (write-only event sourcing), caching (ephemeral drafts), or observation (batch transforms) simply omit those layers.

### Symbol-Keyed Composability Hooks

The existing `INVALIDATE` symbol is a composability hook — a contract between two layers expressed as a symbol-keyed property on the carrier. This pattern generalizes:

| Symbol | Defined by | Filled/called by | Purpose |
|--------|-----------|-------------------|---------|
| `READ` | `bottomInterpreter` | `withReadable` | What happens when you call `ref()` |
| `INVALIDATE` | `withCaching` | `withWritable` | Cache update in response to a change |
| `CHANGEFEED` | `withCompositionalChangefeed` | Consumers | Observation protocol |
| `TRANSACT` | `withWritable` (or context layer) | `change()` and other utilities | Transaction lifecycle |

Each hook is owned by one layer, consumed by another. The carrier is the communication medium.

### Capability-Branded Interpreter Lattice

Each transformer in the stack has distinct composition semantics:

| Layer | Morphism Class | What it does |
|-------|---------------|--------------|
| `bottomInterpreter` | **Foundation** | Creates callable carriers with a `READ` slot |
| `withReadable` | **Refinement** | Fills the `READ` slot, adds structural navigation |
| `withCaching` | **Interposition** | Wraps existing navigation with memoization |
| `withWritable` | **Extension** | Bolts on mutation methods |

These are not interchangeable — `withCaching` requires navigation to exist (it wraps `.at()`), while `withWritable` works with any carrier. The ordering constraints must be enforced at compile time, not discovered at runtime.

The `Interpreter<Ctx, A>` interface has a single type parameter `A` for the result at every node. By branding `A` with capability markers, we create a lattice that TypeScript's structural subtyping enforces:

```ts
// Runtime symbols — present on carriers
export const READ: unique symbol = Symbol.for("kyneta:read") as any
export const INVALIDATE: unique symbol = Symbol.for("schema:invalidate") as any

// Phantom brand symbols — compile-time only, zero runtime cost
declare const NAVIGATION: unique symbol
declare const CACHING: unique symbol

// Capability interfaces — each extends its prerequisite
interface HasRead {
  readonly [READ]: (...args: unknown[]) => unknown
}

interface HasNavigation extends HasRead {
  /** @internal phantom brand */
  readonly [NAVIGATION]: true
}

interface HasCaching extends HasNavigation {
  readonly [INVALIDATE]?: (change: ChangeBase) => void
  /** @internal phantom brand */
  readonly [CACHING]: true
}
```

`HasCaching extends HasNavigation extends HasRead` — the `extends` chain encodes ordering constraints. Transformer signatures use `A extends X` bounds to express preconditions:

```ts
declare const bottomInterpreter: Interpreter<unknown, HasRead>

declare function withReadable<A extends HasRead>(
  base: Interpreter<RefContext, A>
): Interpreter<RefContext, A & HasNavigation>

declare function withCaching<A extends HasNavigation>(
  base: Interpreter<RefContext, A>
): Interpreter<RefContext, A & HasCaching>

declare function withWritable<A>(
  base: Interpreter<RefContext, A>
): Interpreter<WritableContext, A>
```

Invalid compositions become compile errors:

```ts
withCaching(bottomInterpreter)
// ❌ TS2345: Property '[NAVIGATION]' is missing in type 'HasRead'
//    but required in type 'HasNavigation'.

withCaching(withWritable(bottomInterpreter))
// ❌ TS2345: Property '[NAVIGATION]' is missing in type 'HasRead'
//    but required in type 'HasNavigation'.
```

Valid compositions typecheck and accumulate capabilities:

```ts
withReadable(bottomInterpreter)                            // HasRead & HasNavigation
withCaching(withReadable(bottomInterpreter))               // HasRead & HasNavigation & HasCaching
withWritable(withReadable(bottomInterpreter))               // HasRead & HasNavigation (no caching)
withWritable(withCaching(withReadable(bottomInterpreter)))  // full stack
withWritable(bottomInterpreter)                             // HasRead (write-only, ref() throws)
```

**Invariance and the `enrich` downcast.** The `Interpreter<Ctx, A>` interface has `A` in invariant position (covariant in return types, contravariant in thunk/closure arguments). Each transformer's implementation downcasts thunks from `() => (A & NewCap)` to `() => A` before passing to the base — one cast per case. This is the same pattern `enrich` already uses and is safe because `A & P` is a subtype of `A`.

**`INVALIDATE` is optional (`?`).** Not every node kind gets a cache — scalars, text, and counters don't. The type says "this carrier *may* have `INVALIDATE`" and `withWritable` guards at runtime: `if (INVALIDATE in result)`. This is strictly more informative than the current `unknown`.

**`withWritable` has no bound on `A`.** It works with any carrier — pure extension. This enables write-only stacks (`withWritable(bottomInterpreter)`) where `ref()` throws but `.set()` dispatches correctly.

### Naming: `CONTEXT` → `TRANSACT`

Phase 2 of the compositional-changefeeds plan introduced a `CONTEXT` symbol for `change()` to discover transaction methods. Lined up alongside `READ`, `INVALIDATE`, and `CHANGEFEED`, `CONTEXT` is the odd one out — those names describe *capabilities*, while `CONTEXT` describes what the value *is*. The hook provides `beginTransaction`, `commit`, `abort` — the capability is transacting. `TRANSACT` aligns with the naming convention. `CONTEXT` is not in any release, is not yet attached to refs at runtime, and all consumers are internal.

### Naming: `withMutation` → `withWritable`

The transformer naming convention is capability-oriented: `withReadable`, `withCaching`, `withChangefeed`. `withMutation` describes a mechanism rather than a capability. `withWritable` aligns with the convention and mirrors the type-level interpretation: `Readable<S>` ↔ `withReadable`, `Writable<S>` ↔ `withWritable`.

### Adding `inTransaction` to `WritableContext`

The compositional changefeed's dispatch wrapper needs to suppress notification during transaction buffering. Currently `inTransaction` is a private closure variable inside `createWritableContext`. Adding a read-only `inTransaction` getter to `WritableContext` solves this cleanly.

### Functional Core: Cache Invalidation Planning

The `INVALIDATE(change)` logic — parsing a `SequenceChange` to compute index shifts, parsing a `MapChange` to identify deleted keys — is a pure function hidden inside an impure operation. Separating it into a **plan** (pure, testable) and **execution** (trivial mutation) follows the Functional Core / Imperative Shell principle:

```ts
// Functional core — pure function, easily table-tested
type CacheOp<K> =
  | { type: "clear" }
  | { type: "delete"; keys: K[] }
  | { type: "shift"; from: K; delta: number }

function planCacheUpdate(change: ChangeBase, kind: "sequence" | "map" | "product"): CacheOp<number | string>[]

// Imperative shell — trivial application to a Map
function applyCacheOps<K>(cache: Map<K, unknown>, ops: CacheOp<K>[]): void
```

`planCacheUpdate` can be tested with table-driven tests:

```ts
// Given: sequenceChange([{ retain: 2 }, { insert: ["x"] }])
// Expect: [{ type: "shift", from: 2, delta: 1 }]

// Given: sequenceChange([{ retain: 1 }, { delete: 1 }])
// Expect: [{ type: "delete", keys: [1] }, { type: "shift", from: 2, delta: -1 }]

// Given: replaceChange({...})
// Expect: [{ type: "clear" }]
```

Note: `planCacheUpdate` inspects only the *structural* impact of changes (retain counts, insert lengths, delete counts). It never reads the actual inserted item values — per the "two-layer model" from LEARNINGS.md, the change layer carries plain values while the ref layer carries reactive handles.

### No Backward Compatibility

None of the APIs being replaced (`readableInterpreter`, `withMutation`, `CONTEXT`, `HasContext`, `hasContext`) are in any release. All consumers are internal:

- `readable.test.ts`, `writable.test.ts`, `transaction.test.ts`, `with-changefeed.test.ts` — rewritten as part of the decomposition
- `schema-ssr.test.ts` in `@kyneta/core` — one-line import update
- `example/main.ts` — already broken from prior work

No deprecated aliases. No re-exports. Clean break.

## Problem Statement

1. `readableInterpreter` fuses carrier creation, store reading, and caching into one monolithic interpreter. This prevents omitting caching for lightweight stacks, creates the INVALIDATE timing bug, and blocks the compositional changefeed work.
2. There is no bottom interpreter. Every transformer stack must start from `readableInterpreter`, even stacks that don't need reading.
3. `INVALIDATE` is a blunt `clear(key?)` API that forces full cache invalidation on structural mutations. It should accept a `Change` and perform surgical updates.
4. `INVALIDATE` is called *after* dispatch, but dispatch wrapper subscribers fire *during* dispatch. This ordering makes subscribers see stale caches.
5. Invalid transformer compositions (e.g. `withCaching(bottomInterpreter)`) are not caught at compile time. The `Interpreter` type parameter `A` is `unknown` everywhere.
6. `CONTEXT` is a naming outlier among the symbol-keyed composability hooks. It should be `TRANSACT`.
7. `withMutation` is a naming outlier among the interpreter transformers. It should be `withWritable`.
8. `WritableContext` does not expose `inTransaction` state, which the compositional changefeed's dispatch wrapper needs to suppress notification during buffering.
9. Sum dispatch logic is duplicated between `readableInterpreter` and `plainInterpreter`.
10. `isNonNullObject` from `guards.ts` is used inconsistently — `readable.ts` inlines the equivalent check in 4+ places.

## Success Criteria

1. A `bottomInterpreter` exists that produces callable no-op carriers at every node, typed as `Interpreter<unknown, HasRead>`.
2. `withReadable` is a refinement transformer typed as `<A extends HasRead>(base) => Interpreter<RefContext, A & HasNavigation>`. It fills the `READ` hook. It adds structural navigation. It does not cache.
3. `withCaching` is an interposition transformer typed as `<A extends HasNavigation>(base) => Interpreter<RefContext, A & HasCaching>`. It wraps navigation with memoization. It exposes `INVALIDATE(change)` via the Functional Core pattern (`planCacheUpdate` + `applyCacheOps`).
4. `withWritable` is an extension transformer typed as `<A>(base) => Interpreter<WritableContext, A>`. It calls `INVALIDATE(change)` *before* `ctx.dispatch(path, change)`, guarding with `if (INVALIDATE in result)`.
5. Invalid compositions are compile-time errors. `withCaching(bottomInterpreter)` fails because `HasRead` does not satisfy `extends HasNavigation`.
6. `CONTEXT` is renamed to `TRANSACT`. `HasContext` → `HasTransact`, `hasContext()` → `hasTransact()`.
7. `withMutation` is renamed to `withWritable`. No deprecated alias.
8. `readableInterpreter` is removed. No deprecated alias. Tests rewritten.
9. `WritableContext` exposes a read-only `inTransaction` getter.
10. Sum dispatch is extracted into a shared pure function used by both `withReadable` and `plainInterpreter`.
11. All null-guard patterns use `isNonNullObject` from `guards.ts` consistently.

## Gap

- No `bottomInterpreter` exists. No `READ` symbol exists. No capability interfaces exist.
- `readableInterpreter` fuses reading, navigation, and caching. There is no `withReadable` transformer or `withCaching` transformer.
- `INVALIDATE` accepts `(key?: string | number)`, not `(change: ChangeBase)`.
- `withMutation` calls `INVALIDATE` after dispatch, not before.
- The `Interpreter` type parameter `A` is `unknown` in all transformers — no compile-time composition checks.
- `CONTEXT` symbol, `HasContext`, `hasContext` need renaming to `TRANSACT`, `HasTransact`, `hasTransact`.
- `WritableContext` has no `inTransaction` getter.
- Sum dispatch is duplicated between `readable.ts` and `plain.ts`.
- `isNonNullObject` usage is inconsistent.

## Design Decisions

### `READ` Symbol and Carrier Indirection

`bottomInterpreter` produces a callable function at every node. The function delegates to a `READ` symbol-keyed property: `(...args) => ref[READ](...args)`. By default, `READ` throws an informative error ("No reader configured — add withReadable to enable reading"). `withReadable` replaces `ref[READ]` with `() => readByPath(store, path)`.

This preserves carrier identity through the entire transformer stack — the same function object is returned by bottom and augmented by every layer above. No layer needs to replace the carrier. The indirection cost is one symbol lookup per call.

```ts
export const READ: unique symbol = Symbol.for("kyneta:read") as any

interface HasRead {
  readonly [READ]: (...args: unknown[]) => unknown
}
```

### Capability Lattice via Structural Subtyping

The capability interfaces form a lattice enforced by TypeScript's structural type system:

```
HasRead                    (foundation — READ slot)
  ↑
HasNavigation              (extends HasRead — phantom NAVIGATION brand)
  ↑
HasCaching                 (extends HasNavigation — phantom CACHING brand, optional INVALIDATE)
```

Two runtime symbols (`READ`, `INVALIDATE`) carry real behavior. Two phantom brand symbols (`NAVIGATION`, `CACHING`) are `declare const` — zero runtime footprint, compile-time distinctness only.

Optional properties cannot create structural distinctness in TypeScript (a type without an optional property satisfies one that has it). The phantom brands use **required** symbol-keyed properties to force compile-time differentiation.

`withWritable` is independent — no `extends` bound on `A`, no brand. It composes freely with any carrier. Mutation methods are kind-specific (no universal property), and no downstream layer checks for mutation. If a future layer needs to detect mutation capability, a `MUT_BRAND` can be added without breaking existing code.

Each transformer's implementation requires one downcast per case to pass thunks to the base interpreter. This follows the precedent established by `enrich` in `combinators.ts`:

```ts
// The catamorphism builds thunks that produce A & HasNavigation.
// The base interpreter expects thunks that produce A.
// Safe because A & HasNavigation is a subtype of A.
const baseFields = fields as Readonly<Record<string, () => A>>
```

### `INVALIDATE(change)` — Change-Driven Cache Updates

`withCaching` exposes `INVALIDATE` with a new signature: it accepts a `ChangeBase` and interprets it against the node's cache structure. The implementation separates into Functional Core and Imperative Shell:

**Functional Core — `planCacheUpdate`** (pure, table-testable):

- **Sequence + `SequenceChange`**: parse retain/insert/delete ops. For insert-at-index: emit `shift(from, +count)`. For delete-at-index: emit `delete(keys)` then `shift(from, -count)`. For append (retain-all + insert): emit nothing (no existing entries affected).
- **Sequence + `ReplaceChange`**: emit `clear`.
- **Map + `MapChange`**: emit `delete(deletedKeys)`. Set keys need no cache action.
- **Map + `ReplaceChange`**: emit `clear`.
- **Product + `ReplaceChange`**: emit `clear`.
- **Any node + unrecognized change type**: emit `clear` (safe fallback).

`planCacheUpdate` inspects only the structural impact of changes (retain counts, insert lengths, delete counts). It never reads inserted item values — per the "two-layer model" from `@kyneta/core` LEARNINGS.md.

**Imperative Shell — `applyCacheOps`** (trivial `Map` mutation):

Applies the planned operations to the actual `Map<K, unknown>`. `clear` → `map.clear()`. `delete` → iterate keys, `map.delete(k)`. `shift` → re-key entries: build new entries array, clear affected range, set shifted entries.

### `withWritable` Invalidates Before Dispatch

Today:
```
result.push = (...items) => {
  ctx.dispatch(path, change)     // store updates, subscribers fire (stale cache)
  result[INVALIDATE]()           // cache cleared (too late)
}
```

After:
```
result.push = (...items) => {
  const change = sequenceChange([...])
  if (INVALIDATE in result) result[INVALIDATE](change)  // cache updated surgically
  ctx.dispatch(path, change)     // store updates, subscribers fire (cache consistent)
}
```

When caching is absent from the stack (e.g. `withWritable(withReadable(bottomInterpreter))`), `INVALIDATE` is not present on the carrier and the `in` check skips it. Zero overhead.

### `bottomInterpreter` as Universal Foundation

`bottomInterpreter` produces a callable carrier at every node. For `annotated` nodes with an inner schema, it delegates to the inner thunk (preserving the catamorphism's recursive structure). For all other cases, it returns a fresh carrier.

The carrier is a regular JavaScript function (not a Proxy) with a `READ` symbol-keyed slot. Functions are objects — properties can be defined on them, making them attachable-to by every transformer above.

Product field thunks, sequence item closures, and map item closures from the catamorphism are ignored by bottom — it doesn't force them. Transformers above receive these same thunks via the standard transformer wrapping pattern.

### Shared Sum Dispatch

The discriminated sum dispatch algorithm (read discriminant from store → check string → dispatch to `byKey()` → fall back to first variant) and the nullable positional sum algorithm (check null/undefined → dispatch to variant 0 or 1) are currently duplicated between `readableInterpreter.sum()` and `plainInterpreter.sum()`.

Extract a shared pure function `dispatchSum(value: unknown, schema: SumSchema, variants: SumVariants<A>): A | undefined` into `store.ts` (or a new `sum-dispatch.ts`). Both `withReadable` and `plainInterpreter` call it. This eliminates the duplication and makes the dispatch logic independently testable.

### Combinatorial Stacks

The decomposition enables stacks that were previously impossible:

| Stack | Type `A` | Use Case |
|-------|----------|----------|
| `bottomInterpreter` | `HasRead` | Inert carriers. Schema-walking, metadata. |
| `withReadable(bottom)` | `HasRead & HasNavigation` | Read-only, no caching. SSR snapshots, ephemeral reads. |
| `withCaching(withReadable(bottom))` | `... & HasCaching` | Read-only with stable identity. |
| `withWritable(withReadable(bottom))` | `HasRead & HasNavigation` | Read-write, no caching. Quick transforms. |
| `withWritable(withCaching(withReadable(bottom)))` | `... & HasCaching` | Read-write with stable refs. |
| `withChangefeed(withWritable(withCaching(withReadable(bottom))))` | full | Full reactive stack. |
| `withWritable(bottom)` | `HasRead` | Write-only. Event sourcing. `ref()` throws. |

### `TRANSACT` Replaces `CONTEXT`

`CONTEXT` → `TRANSACT`, `HasContext` → `HasTransact`, `hasContext()` → `hasTransact()`. The symbol string changes from `"kyneta:context"` to `"kyneta:transact"`. Note: `CONTEXT` / `TRANSACT` is defined on refs but not yet attached at runtime — attachment happens in the compositional-changefeeds plan's Phase 3 (`withCompositionalChangefeed`). This plan renames the type-level definitions.

### `inTransaction` on `WritableContext`

`WritableContext` gains a read-only `inTransaction` getter. `createWritableContext` exposes the internal `inTransaction` flag as a getter on the returned context object.

```ts
interface WritableContext extends RefContext {
  readonly dispatch: (path: Path, change: ChangeBase) => void
  readonly inTransaction: boolean
  beginTransaction(): void
  commit(): PendingChange[]
  abort(): void
}
```

### Product Caching vs Collection Caching

Product caching and sequence/map caching are distinct patterns that `withCaching` handles separately:

- **Product fields**: thunk memoization. Each field thunk is evaluated at most once (`resolved`/`cached` closure pattern). The set of keys is statically known from the schema. `INVALIDATE` with `ReplaceChange` clears all fields.
- **Sequence/Map children**: identity-preserving lookup table. A `Map<K, unknown>` serves as a child cache, populated on-demand via `.at()`. `INVALIDATE` with structural changes (`SequenceChange`, `MapChange`) performs surgical updates via `planCacheUpdate` + `applyCacheOps`. `INVALIDATE` with `ReplaceChange` clears the entire map.

The `planCacheUpdate` / `applyCacheOps` decomposition applies to collections. Product invalidation is simpler (always full clear) and doesn't need the planning abstraction.

## Phases

### Phase 1: Foundation — `bottomInterpreter`, `READ`, Capability Types 🟢

Introduce the universal foundation and the compile-time capability lattice.

- Task: Create `src/interpreters/bottom.ts`. 🟢
- Task: Define runtime symbols: `READ = Symbol.for("kyneta:read")`. 🟢
- Task: Define phantom brand symbols: `declare const NAVIGATION: unique symbol`, `declare const CACHING: unique symbol`. Export the symbol *types* (not values — they're `declare const`). 🟢
- Task: Define capability interfaces: `HasRead` (has `[READ]`), `HasNavigation extends HasRead` (has `[NAVIGATION]: true`), `HasCaching extends HasNavigation` (has optional `[INVALIDATE]`, has `[CACHING]: true`). 🟢
- Task: Implement `makeCarrier(): HasRead`. The carrier is `(...args: unknown[]) => ref[READ](...args)` where `READ` defaults to a function that throws `"No reader configured — compose with withReadable to enable reading"`. 🟢
- Task: Implement `bottomInterpreter: Interpreter<unknown, HasRead>`. Each case returns `makeCarrier()`. The `annotated` case delegates to `inner()` when present. The `product`, `sequence`, `map`, and `sum` cases ignore field thunks / item closures / variants. 🟢
- Task: Export `READ`, `NAVIGATION`, `CACHING`, `HasRead`, `HasNavigation`, `HasCaching`, `makeCarrier`, `bottomInterpreter` from `index.ts`. 🟡 (`NAVIGATION` and `CACHING` phantom type re-exports from `index.ts` missing — exported from `bottom.ts` only. Minor: consumers use the interfaces, not the raw phantom symbols.)
- Task: Tests in `bottom.test.ts`: 🟢
  - Every schema kind produces a callable function carrier.
  - Calling a bottom carrier throws `"No reader configured"`.
  - `READ` symbol is present on every carrier.
  - Properties can be attached to carriers (they are real function objects).
  - Annotated nodes with inner schemas delegate correctly.
  - **Type-level tests**: `typeof bottomInterpreter` is `Interpreter<unknown, HasRead>`. The result extends `HasRead`. The result does NOT extend `HasNavigation` (using `expectTypeOf` negative assertion).

### Phase 2: Refinement — `withReadable` Transformer 🟢

Extract store reading and structural navigation from `readableInterpreter` into a standalone transformer.

- Task: Extract shared sum dispatch into `dispatchSum(value, schema, variants)` in `src/store.ts`. Update `plainInterpreter` to use it. 🟡 (`dispatchSum` extracted and exported. `plainInterpreter` NOT yet updated to use it — still has inline sum dispatch logic.)
- Task: Create `src/interpreters/with-readable.ts`. Implement `withReadable<A extends HasRead>(base: Interpreter<RefContext, A>): Interpreter<RefContext, A & HasNavigation>`. 🟢
- Task: **Scalar case**: call base, set `ref[READ] = () => readByPath(store, path)`. Add `[Symbol.toPrimitive]`. 🟢
- Task: **Product case**: call base, set `ref[READ] = () => readByPath(store, path)`. Define enumerable lazy getters that force the thunk on *every* access (no caching). Use `isNonNullObject` from `guards.ts` consistently. 🟢
- Task: **Sequence case**: call base, set `ref[READ]`. Attach `.at(i)` (calls `item(i)` fresh each time), `.get(i)`, `.length`, `[Symbol.iterator]`. 🟢
- Task: **Map case**: call base, set `ref[READ]`. Attach `.at(key)`, `.get(key)`, `.has(key)`, `.keys()`, `.size`, `.entries()`, `.values()`, `[Symbol.iterator]`. Use `isNonNullObject` consistently. 🟢
- Task: **Sum case**: call base, then use `dispatchSum` for store-driven variant resolution. 🟢
- Task: **Annotated case**: dispatch on tag. `"text"` → set `READ` to text-coercing reader + `toPrimitive`. `"counter"` → set `READ` to number-coercing reader + hint-aware `toPrimitive`. `"doc"`, `"movable"`, `"tree"` → delegate to inner. Default → delegate to inner or treat as scalar. 🟢
- Task: Each case downcasts thunks/closures: `const baseFields = fields as Readonly<Record<string, () => A>>` before passing to `base`. 🟢
- Task: Export `withReadable` from `index.ts`. 🟢
- Task: Tests in `with-readable.test.ts`: 🟢
  - `withReadable(bottomInterpreter)` produces callable refs that return store values.
  - Product field navigation: `ref.title()` returns the field value.
  - Sequence `.at(i)`, `.length`, `.get(i)`, iterator all work.
  - Map `.at(key)`, `.has(key)`, `.keys()`, `.size`, `.get(key)`, `.entries()`, `.values()`, iterator all work.
  - **No referential identity**: `ref.title !== ref.title`. `seq.at(0) !== seq.at(0)`. `map.at("k") !== map.at("k")`.
  - `toPrimitive` for text and counter annotations.
  - Sum dispatch: discriminated sum reads discriminant, nullable sum checks null.
  - Bounds checking: `.at(-1)` and `.at(outOfBounds)` return `undefined`.
  - **Type-level tests**: result of `withReadable(bottomInterpreter)` extends `HasNavigation`. `withReadable(bottomInterpreter)` extends `HasRead`.
  - **Compile-time negative test**: `// @ts-expect-error` on `withReadable(plainInterpreter)` — `plainInterpreter` is `Interpreter<unknown, unknown>`, not `Interpreter<_, HasRead>`.
- Task: Tests for `dispatchSum` in `store.test.ts` (or `sum-dispatch.test.ts`): discriminated dispatch, nullable dispatch, fallback to first variant, missing discriminant. 🟢 (9 tests in `with-readable.test.ts`)

### Phase 3: Interposition — `withCaching` Transformer and New `INVALIDATE` 🟢

Extract caching from `readableInterpreter` into a standalone transformer. Redefine `INVALIDATE` to accept changes.

- Task: Create `src/interpreters/with-caching.ts`. Implement `withCaching<A extends HasNavigation>(base: Interpreter<RefContext, A>): Interpreter<RefContext, A & HasCaching>`. 🟢
- Task: Move `INVALIDATE` symbol definition from `readable.ts` into `with-caching.ts`. The symbol string `"schema:invalidate"` does not change. 🟢 (`readable.ts` now imports from `with-caching.ts` and re-exports for backward compat.)
- Task: Implement `planCacheUpdate(change: ChangeBase, kind: "sequence" | "map" | "product"): CacheOp[]` as a pure function. Export for testing. 🟢
- Task: Implement `applyCacheOps<K>(cache: Map<K, unknown>, ops: CacheOp<K>[]): void`. Export for testing. 🟢
- Task: **Product case**: call base, wrap field getters with `resolved`/`cached` memoization. Expose `INVALIDATE(change)`: delegates to `planCacheUpdate(change, "product")` → always `clear` for `ReplaceChange`, then clears all `resolved` flags. 🟢
- Task: **Sequence case**: call base, wrap `.at(i)` with `childCache: Map<number, unknown>`. Expose `INVALIDATE(change)`: delegates to `planCacheUpdate(change, "sequence")` → `applyCacheOps(childCache, ops)`. 🟢
- Task: **Map case**: call base, wrap `.at(key)` with `childCache: Map<string, unknown>`. Expose `INVALIDATE(change)`: delegates to `planCacheUpdate(change, "map")` → `applyCacheOps(childCache, ops)`. 🟢
- Task: **Scalar, sum, annotated cases**: delegate to base (no caching needed at leaves). 🟢
- Task: Each case downcasts thunks/closures before passing to base. 🟢
- Task: Export `withCaching`, `INVALIDATE`, `planCacheUpdate`, `applyCacheOps` from `index.ts`. 🟢
- Task: Tests in `with-caching.test.ts`: 🟢
  - `withCaching(withReadable(bottomInterpreter))` produces refs with referential identity (`ref.title === ref.title`, `seq.at(0) === seq.at(0)`, `map.at("k") === map.at("k")`).
  - After `INVALIDATE` with `sequenceChange`, `.at()` returns fresh refs.
  - After `INVALIDATE` with `mapChange({ delete: ["k"] })`, `map.at("k")` returns a fresh ref.
  - After `INVALIDATE` with `replaceChange` on a product, all field caches cleared.
  - After `INVALIDATE` with an unrecognized change type, full clear.
  - **Type-level tests**: result extends `HasCaching`. `// @ts-expect-error` on `withCaching(bottomInterpreter)`.
- Task: Table-driven tests for `planCacheUpdate` in `plan-cache-update.test.ts`: 🟢
  - Sequence insert-at-middle: `[{ retain: 2 }, { insert: ["x"] }]` → `[{ type: "shift", from: 2, delta: 1 }]`.
  - Sequence delete: `[{ retain: 1 }, { delete: 1 }]` → `[{ type: "delete", keys: [1] }, { type: "shift", from: 2, delta: -1 }]`.
  - Sequence append: `[{ retain: N }, { insert: items }]` → `[]` (no existing entries affected).
  - Sequence replace: `replaceChange(...)` → `[{ type: "clear" }]`.
  - Map delete: `mapChange(undefined, ["k"])` → `[{ type: "delete", keys: ["k"] }]`.
  - Map replace: `replaceChange(...)` → `[{ type: "clear" }]`.
  - Product replace: `replaceChange(...)` → `[{ type: "clear" }]`.
  - Unrecognized change: `{ type: "unknown" }` → `[{ type: "clear" }]`.

### Phase 4: Extension — `withWritable` (Rename + Invalidate-Before-Dispatch) 🟢

Rename `withMutation` to `withWritable`. Change to invalidate before dispatch. Guard for stacks without caching.

- Task: Rename `withMutation` to `withWritable` in `writable.ts`. Update the function signature to `<A>(base: Interpreter<RefContext, A>): Interpreter<WritableContext, A>`. Update all JSDoc and comments. 🟢
- Task: Update every mutation method to: (1) construct the change, (2) call `if (INVALIDATE in result) result[INVALIDATE](change)`, (3) call `ctx.dispatch(path, change)`. Remove all post-dispatch `INVALIDATE` calls. 🟢
- Task: For scalar, text, and counter — `INVALIDATE` is not present (`withCaching` doesn't add it to leaves), so the guard skips it. Verify no regression. 🟢
- Task: Remove `withMutation` export. Export only `withWritable`. 🟢
- Task: Import `INVALIDATE` from `with-caching.ts` (instead of `readable.ts`). 🟢
- Task: Update `index.ts`: export `withWritable` (remove `withMutation`). 🟢
- Task: Tests in `writable.test.ts` (rewritten): 🟢
  - `withWritable(withReadable(bottomInterpreter))` (no caching): `push()` works, store updated, no crash from missing `INVALIDATE`.
  - `withWritable(withCaching(withReadable(bottomInterpreter)))`: after `push()`, `.at(newIndex)` returns the correct ref immediately (cache pre-updated before dispatch).
  - After `insert(1, item)` on a 3-item cached list: `.at(1)` is a new ref, `.at(2)` is fresh (shifted), not the stale cached ref.
  - After `delete(0, 1)` on a cached list: `.at(0)` returns what was formerly at index 1.
  - Scalar `.set()`, product `.set()`, text `.insert()`/`.delete()`/`.update()`, counter `.increment()`/`.decrement()`, map `.set()`/`.delete()`/`.clear()` all work.
  - Product lazy getters, namespace isolation, portable refs.
  - Discriminated sum, nullable sum.
  - `withWritable(bottomInterpreter)` (write-only): `.set()` dispatches, `ref()` throws.

### Phase 5: Rename `CONTEXT` → `TRANSACT`, Add `inTransaction`, Remove Old API 🟢

- Task: In `writable.ts`: rename `CONTEXT` → `TRANSACT`, `HasContext` → `HasTransact`, `hasContext` → `hasTransact`. Change the symbol string from `"kyneta:context"` to `"kyneta:transact"`. 🟢
- Task: Add `readonly inTransaction: boolean` to `WritableContext` interface. In `createWritableContext`, expose the internal `inTransaction` flag as a getter. 🟢
- Task: Update `index.ts` exports: remove `CONTEXT`, `HasContext`, `hasContext`. Add `TRANSACT`, `HasTransact`, `hasTransact`. 🟢
- Task: Delete the monolithic `readableInterpreter` implementation from `readable.ts`. Keep type exports only: `Readable<S>`, `ReadableSequenceRef<T, V>`, `ReadableMapRef<T, V>`. Move `INVALIDATE` re-export to import from `with-caching.ts`. 🟢
- Task: Update `index.ts`: remove `readableInterpreter` export. Remove `withMutation` export (already done in Phase 4 but verify). Remove `CONTEXT`, `HasContext`, `hasContext` exports. 🟢
- Task: Rewrite `readable.test.ts` to test `withCaching(withReadable(bottomInterpreter))` directly. Same behavioral coverage, new import names. 🟢
- Task: Rewrite `transaction.test.ts`: use `withWritable` + composed stacks. Add `ctx.inTransaction` tests (`false` by default, `true` after `beginTransaction`, `false` after `commit`, `false` after `abort`). Add `TRANSACT` symbol identity test. 🟢
- Task: Rewrite `with-changefeed.test.ts`: use `withWritable` + composed stacks + `enrich`. 🟢
- Task: Update `schema-ssr.test.ts` in `@kyneta/core`: replace `readableInterpreter` → `withCaching(withReadable(bottomInterpreter))`, `withMutation` → `withWritable`, update imports. 🟢
- Task: Update the compositional-changefeeds plan: replace all `CONTEXT` → `TRANSACT`, `HasContext` → `HasTransact`, `hasContext` → `hasTransact`, `withMutation` → `withWritable`, `readableInterpreter` → `withCaching(withReadable(bottomInterpreter))`. Update "Sequence Subscription Timing" section to reflect cache-consistent-at-notification-time. 🟢

### Phase 6: Documentation 🔴

- Task: **Fix pre-existing TECHNICAL.md staleness.** The following are stale from the compositional-changefeeds Phase 2 work and must be fixed regardless of this plan: 🔴
  - Remove entire "Deep Subscriptions" section (L176–211) — `subscribeDeep`, `DeepEvent`, `notifyAll`, `createChangefeedContext`, `changefeedFlush` are all removed.
  - Fix context hierarchy (L274) — remove `ChangefeedContext { subscribers, deepSubscribers }`, remove `autoCommit`/`pending` from `WritableContext`, describe current `RefContext → WritableContext` with `beginTransaction`/`commit`/`abort`.
  - Fix dispatch model (L349) — replace "auto-commit / batched mode" with transaction API.
  - Fix interpreter table (L253) — `withChangefeed` context is `WritableContext`, not `ChangefeedContext`.
  - Fix Verified Properties #7 (deep subscriptions → removed) and #8 (batched mode → transaction API).
  - Add `transaction.test.ts` to File Map.
- Task: Update `TECHNICAL.md` § "Interpreters": document the four-layer stack, the capability lattice with compile-time enforcement, symbol-keyed composability hooks (`READ`, `INVALIDATE`, `CHANGEFEED`, `TRANSACT`), the combinatorial stack table, and the three morphism classes (foundation, refinement + interposition, extension). 🔴
- Task: Update `TECHNICAL.md` § "Readable Interpreter": remove description of monolithic implementation. Document `withReadable` and `withCaching` as decomposed layers. Note that `Readable<S>`, `ReadableSequenceRef`, `ReadableMapRef` types remain in `readable.ts`. 🔴
- Task: Update `TECHNICAL.md` § "Mutation Layer": rename to "Writable Layer" (`withWritable`). Document invalidate-before-dispatch ordering, `INVALIDATE(change)` contract, Functional Core pattern (`planCacheUpdate` + `applyCacheOps`). 🔴
- Task: Update `TECHNICAL.md` § "Verified Properties": update property 2 (referential identity requires `withCaching`). Add properties for compile-time composition safety. 🔴
- Task: Update `TECHNICAL.md` § "File Map": add `bottom.ts`, `with-readable.ts`, `with-caching.ts` and their test files. Remove `readable.ts` implementation description (file still exists for types). 🔴
- Task: Fix stale comment in `interpreter-types.ts` (L33–34) that references `ChangefeedContext`. 🔴

## Tests

### Phase 1 Tests (`bottom.test.ts`)

- Every schema kind (scalar, product, sequence, map, sum, annotated) produces a callable function carrier.
- Calling a bottom carrier throws `"No reader configured"`.
- `READ` symbol is present on every carrier.
- Properties can be attached to carriers (they are real function objects).
- Annotated nodes with inner schemas delegate correctly (inner thunk is forced).
- **Type-level**: result is `HasRead`, not `HasNavigation`.

### Phase 2 Tests (`with-readable.test.ts`)

- `withReadable(bottomInterpreter)` produces refs where `ref()` returns the store value.
- Product field navigation: `ref.title()` returns the field value.
- Sequence `.at(i)` returns a callable child ref. `.length` reflects store array length. Iterator yields refs.
- Map `.at(key)` returns a callable child ref. `.has(key)`, `.keys()`, `.size`, `.get(key)`, `.entries()`, `.values()`, iterator all work.
- **No referential identity**: `ref.title !== ref.title` (product getters force thunks on each access). `seq.at(0) !== seq.at(0)`. `map.at("k") !== map.at("k")`.
- `toPrimitive` for text and counter annotations.
- Sum dispatch: discriminated sum reads discriminant, nullable sum checks null.
- Bounds checking: `.at(-1)` and `.at(outOfBounds)` return `undefined`.
- **Type-level**: result extends `HasNavigation`.
- **Compile-time negative**: `withReadable(plainInterpreter)` is a type error.

### Phase 2 Tests (`dispatchSum` — in `store.test.ts` or standalone)

- Discriminated sum: correct variant dispatched for known discriminant.
- Discriminated sum: fallback to first variant for missing discriminant.
- Nullable sum: null → variant 0, non-null → variant 1.
- General positional sum: first variant by default.

### Phase 3 Tests (`with-caching.test.ts`)

- `withCaching(withReadable(bottomInterpreter))` produces refs with referential identity.
- `seq.at(0) === seq.at(0)`, `map.at("k") === map.at("k")`, `ref.title === ref.title`.
- `INVALIDATE` with various changes clears / shifts caches correctly.
- After `INVALIDATE`, `.at()` returns fresh refs.
- **Type-level**: result extends `HasCaching`.
- **Compile-time negative**: `withCaching(bottomInterpreter)` is a type error.

### Phase 3 Tests (`plan-cache-update.test.ts`)

Table-driven pure-function tests for `planCacheUpdate`:
- Sequence insert-at-middle → shift ops.
- Sequence delete → delete + shift ops.
- Sequence append → no ops.
- Sequence replace → clear.
- Map delete → delete ops.
- Map replace → clear.
- Product replace → clear.
- Unrecognized change → clear.

### Phase 4 Tests (`writable.test.ts` — rewritten)

- All mutation methods work with full stack (`withWritable(withCaching(withReadable(bottomInterpreter)))`).
- All mutation methods work without caching (`withWritable(withReadable(bottomInterpreter))`).
- Write-only stack works (`withWritable(bottomInterpreter)`): `.set()` dispatches, `ref()` throws.
- Invalidate-before-dispatch: after `push()` on cached sequence, `.at(newIndex)` is correct immediately.
- Insert-at-middle: shifted indices produce fresh refs, not stale cached ones.
- Delete: shifted indices produce correct refs.
- Product lazy getters, namespace isolation, portable refs.
- Discriminated sum, nullable sum.
- Scalar, text, counter, sequence, map, product mutation methods.
- Transaction lifecycle.

### Phase 5 Tests (rewritten existing tests)

- `readable.test.ts` rewritten to use `withCaching(withReadable(bottomInterpreter))`. Same behavioral assertions.
- `transaction.test.ts` rewritten to use `withWritable`. Added `inTransaction` and `TRANSACT` tests.
- `with-changefeed.test.ts` rewritten to use `withWritable` + composed stacks.
- `schema-ssr.test.ts` in `@kyneta/core` updated to use new imports.

## Transitive Effect Analysis

### `src/interpreters/bottom.ts` (new)

New file. Defines `READ`, `HasRead`, `HasNavigation`, `HasCaching`, phantom brand symbols, `makeCarrier`, `bottomInterpreter`.

### `src/interpreters/with-readable.ts` (new)

New file. Defines `withReadable`. Imports `HasRead`, `HasNavigation` from `bottom.ts`.

### `src/interpreters/with-caching.ts` (new)

New file. Defines `withCaching`, takes ownership of `INVALIDATE`, exports `planCacheUpdate`, `applyCacheOps`. The `INVALIDATE` symbol string (`"schema:invalidate"`) does not change — same `Symbol.for` identity.

### `src/interpreters/readable.ts`

The monolithic `readableInterpreter` implementation is removed. The file retains only type exports: `Readable<S>`, `ReadableSequenceRef<T, V>`, `ReadableMapRef<T, V>`. `INVALIDATE` is re-exported from `with-caching.ts`. `RefContext` re-export from `interpreter-types.ts` remains.

### `src/interpreters/writable.ts`

`withMutation` renamed to `withWritable` with generic signature. Invalidate-before-dispatch ordering. `CONTEXT` → `TRANSACT` rename. `inTransaction` added to `WritableContext`. `INVALIDATE` imported from `with-caching.ts`. `PendingChange`, `WritableContext`, `HasTransact`, `hasTransact`, `TRANSACT`, `withWritable` exported. No deprecated aliases.

### `src/interpreters/plain.ts`

Updated to use shared `dispatchSum` from `store.ts` instead of inline sum dispatch.

### `src/store.ts`

Gains `dispatchSum` — shared pure function for store-driven sum variant resolution. Used by `withReadable` and `plainInterpreter`.

### `src/interpreters/with-changefeed.ts`

No changes in this plan. The transitional `withChangefeed` continues to work — it wraps `ctx.dispatch` for notification and doesn't interact with `INVALIDATE` or `READ`. Phase 3 of compositional-changefeeds replaces it.

### `src/index.ts`

**New exports**: `READ`, `HasRead`, `HasNavigation`, `HasCaching`, `NAVIGATION` (type), `CACHING` (type), `makeCarrier`, `bottomInterpreter`, `withReadable`, `withCaching`, `withWritable`, `planCacheUpdate`, `applyCacheOps`, `TRANSACT`, `HasTransact`, `hasTransact`, `dispatchSum`.

**Removed exports**: `readableInterpreter`, `withMutation`, `CONTEXT`, `HasContext`, `hasContext`.

**Moved exports**: `INVALIDATE` source changes from `readable.ts` to `with-caching.ts`.

### `@kyneta/core` runtime (`subscribe.ts`, `regions.ts`, `text-patch.ts`)

**Zero changes required.** The runtime consumes only `ref[CHANGEFEED].subscribe()` and `ref[CHANGEFEED].current`. It does not import any interpreter, `INVALIDATE`, `CONTEXT`, or `READ`.

### `@kyneta/core` compiler (`reactive-detection.ts`, `dom.ts`)

**Zero changes required.** The compiler detects reactivity via the `[CHANGEFEED]` symbol.

### `@kyneta/core` integration test (`schema-ssr.test.ts`)

Updated in Phase 5 to use `withWritable`, `withCaching`, `withReadable`, `bottomInterpreter` instead of `readableInterpreter` and `withMutation`.

### `example/main.ts`

Already broken from Phase 2 of compositional-changefeeds. This plan adds more stale references but the file is already non-functional. Deferred to Phase 5 of the compositional-changefeeds plan.

### Compositional-changefeeds plan

Phase 3 of that plan (`withCompositionalChangefeed`) depends on this decomposition:
- It wraps `ctx.dispatch` for notification, checking `ctx.inTransaction` to suppress during buffering.
- It attaches `[CHANGEFEED]` and `[TRANSACT]` to carriers.
- It composes child changefeeds using stable ref identity from `withCaching`.
- The INVALIDATE timing is no longer its concern — `withWritable` handles it before dispatch.
- The cache is consistent at notification time — the "Sequence Subscription Timing" section's timing constraints are simplified.

References updated in Phase 5: `CONTEXT` → `TRANSACT`, `withMutation` → `withWritable`, `readableInterpreter` → composed stack.

## Resources for Implementation Context

| Resource | Path | Relevance |
|----------|------|-----------|
| Current readable interpreter | `src/interpreters/readable.ts` | Source of code to extract into `withReadable` and `withCaching` |
| Current writable interpreter | `src/interpreters/writable.ts` | `withMutation` → `withWritable` rename, INVALIDATE ordering, CONTEXT → TRANSACT rename, add inTransaction |
| Catamorphism | `src/interpret.ts` | `Interpreter<Ctx, A>` interface — the `A` parameter carries capability types |
| `enrich` combinator | `src/combinators.ts` | Precedent for thunk downcast pattern (`fields as Record<string, () => A>`) |
| Change types | `src/change.ts` | `SequenceChange`, `MapChange`, `ReplaceChange` — consumed by `planCacheUpdate` |
| Change type guards | `src/change.ts` | `isSequenceChange`, `isMapChange`, `isReplaceChange` — used in `planCacheUpdate` |
| Store utilities | `src/store.ts` | `readByPath` — used by `withReadable`. Home for `dispatchSum`. |
| Guards | `src/guards.ts` | `isNonNullObject` — use consistently, stop inlining equivalent checks |
| Plain interpreter | `src/interpreters/plain.ts` | Has duplicated sum dispatch — update to use shared `dispatchSum` |
| Index barrel | `src/index.ts` | Export updates — clean break, no aliases |
| Core SSR integration | `packages/core/src/compiler/integration/schema-ssr.test.ts` | Update imports |
| Core LEARNINGS.md | `packages/core/LEARNINGS.md` | "two-layer model" insight — `planCacheUpdate` ignores inserted item values |
| Compositional changefeeds plan | `packages/schema/.plans/compositional-changefeeds.md` | Dependent plan — update references |
| TECHNICAL.md | `packages/schema/TECHNICAL.md` | Documentation updates + fix pre-existing staleness |

## Alternatives Considered

### Keep `readableInterpreter` Monolithic, Fix INVALIDATE Timing Only

Move the `INVALIDATE` call before dispatch but keep caching fused into `readableInterpreter`. This fixes the timing bug but doesn't enable cacheless stacks, doesn't introduce `bottomInterpreter`, and doesn't create the capability lattice. Rejected as a tactical fix that misses the architectural improvement.

### `INVALIDATE` Takes Structured Cache Operations (`shift`/`unshift`/`clear`)

Define a `CacheControl` interface with `shift(index, count)`, `unshift(index, count)`, `clear(key?)`. The writable layer translates changes into cache operations. This separates concerns cleanly but the operations are sequence-biased (maps don't shift), and it forces the writable layer to duplicate change-interpretation logic that the cache layer already needs. Using the `Change` directly is more uniform — one interface for all node kinds, and the cache layer owns the interpretation. The Functional Core `planCacheUpdate` function captures the same separation internally without exposing it as a cross-layer contract.

### `bottomInterpreter` Returns Plain Objects, Not Callables

Bottom returns `Object.create(null)` at every node. `withReadable` replaces the carrier with a function. This breaks the transformer contract — layers between bottom and readable lose their contributions when the carrier is replaced. The `READ` symbol indirection preserves carrier identity through the stack.

### `withReadable` Ignores Bottom's Carrier, Creates Its Own Function

`withReadable` discards the base result and creates a fresh callable. This works if nothing sits between bottom and readable, but it means `withReadable` is not a true refinement — it's a replacement. If a future layer (e.g., `withDebugInfo`) sits between bottom and readable, its contributions are lost. The `READ` slot approach preserves the transformer contract uniformly.

### Make `READ` Mutable via a Closure Slot Instead of a Symbol

Bottom captures a `let impl` in a closure; `withReadable` calls `ref._setImpl(fn)`. This works but introduces a magic method name in string-key namespace. The symbol approach is consistent with `INVALIDATE`, `CHANGEFEED`, and `TRANSACT` — all composability hooks are symbol-keyed.

### Optional Properties for Capability Brands (No Phantom Symbols)

Use `readonly __nav?: true` as the brand on `HasNavigation`. TypeScript treats optional properties as structurally compatible with types that lack them — `HasRead` would satisfy `HasNavigation`, defeating the purpose. Required properties keyed by `unique symbol` are the minimum structure needed for compile-time distinctness.

### Encode Per-Kind Capabilities in `A` (Not Per-Layer)

Make `A` represent node-specific capabilities (e.g., `SequenceCarrier` vs `ScalarCarrier`). This conflicts with the catamorphism's requirement that `A` is uniform — thunks are `() => A` and item closures are `(index) => A`. The uniform `A` must represent the *minimum guaranteed capabilities*, not kind-specific surfaces. Per-layer capability markers are the natural fit.

### Backward-Compatible Aliases for `readableInterpreter`, `withMutation`, `CONTEXT`

Re-export deprecated aliases. None of these APIs are in any release. All consumers are internal. Deprecated aliases add maintenance burden (two names for one thing), clutter the public API, and make dead code harder to identify. Clean break is strictly superior when there are no external consumers.

### Don't Rename `CONTEXT` to `TRANSACT`

Keep `CONTEXT` as-is. The naming inconsistency is cosmetic and doesn't affect functionality. However, the hook naming convention (`READ`, `INVALIDATE`, `CHANGEFEED`) describes capabilities, and `CONTEXT` is the outlier. `CONTEXT` is not yet attached to refs at runtime, is not in any release, and all consumers are internal. The cost of renaming now is near zero; the cost increases with every consumer that adopts `CONTEXT`.

### Don't Rename `withMutation` to `withWritable`

Keep `withMutation` as-is. The transformer naming convention is capability-oriented (`withReadable`, `withCaching`, `withChangefeed`), and `withMutation` describes a mechanism rather than a capability. It also breaks the correspondence with the type-level interpretation (`Readable<S>` ↔ `withReadable`, `Writable<S>` ↔ `withWritable`). Like `CONTEXT`, `withMutation` is not in any release and all consumers are internal.

### Expose `inTransaction` via a Separate Symbol Instead of on `WritableContext`

Define a `TRANSACTION_STATE` symbol on the context. This is over-engineered — `inTransaction` is a simple boolean property of the context, not a composability hook on a ref. A getter on the interface is the straightforward solution.

### Inline Cache Update Logic Instead of Functional Core Split

Put the `SequenceChange` → cache-ops parsing directly in the `INVALIDATE` handler closure, mutating the `Map` inline. This works but makes the most complex logic in the system (sequence index shifting) untestable without setting up full interpreter stacks. The Functional Core split (`planCacheUpdate` → pure, `applyCacheOps` → trivial) enables table-driven testing of every edge case.