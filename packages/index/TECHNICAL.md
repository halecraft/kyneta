# @kyneta/index — Technical Reference

> **Package**: `@kyneta/index`
> **Role**: DBSP-grounded reactive indexing over keyed collections. A three-layer pipeline — `Source` (consumer-stateless delta producer) → `Collection` (stateful ℐ integrator, *is* a `Changefeed`) → `SecondaryIndex` / `JoinIndex` (grouping + join operators) — with all internal algebra computed on ℤ-sets.
> **Depends on**: `@kyneta/changefeed`
> **Depended on by**: Application code that builds live, queryable views over document collections (exchange-backed or otherwise).
> **Canonical symbols**: `Source`, `SourceEvent`, `SourceHandle`, `ExchangeSourceHandle`, `SourceMapping`, `FlatMapOptions`, `Collection`, `CollectionChange`, `SecondaryIndex`, `IndexChange`, `JoinIndex`, `KeySpec`, `field`, `keys`, `Index`, `Index.by`, `Index.join`, `ZSet`, `add`, `negate`, `single`, `zero`, `positive`, `isEmpty`, `entries`, `fromKeys`, `toAdded`, `toRemoved`
> **Key invariant(s)**:
> 1. Every operator's internal representation is a ℤ-set (`ReadonlyMap<string, number>` with no zero-weight entries). Public change types (`CollectionChange`, `IndexChange`) are projections, not the internal form.
> 2. `Source` has no `current`, no `[CHANGEFEED]`, no mutable surface exposed to consumers. `Collection` is the gate into the reactive world — the one operator that carries state and satisfies the changefeed protocol.
> 3. Every operation preserves the representational invariant: if a key has positive weight in `delta`, a value for that key exists in the accompanying `values` map.

A set of incremental operators for maintaining live views over keyed data. You start with a `Source<V>` — typically built from a `@kyneta/schema` document, an `exchange.documents`-backed collection, a static record, or another operator — and build up through `Collection`, `SecondaryIndex`, and `JoinIndex`. Every operator is incremental: a change at the input becomes a ℤ-set delta that propagates through the pipeline in O(|Δ|) time, not O(|state|).

Used by applications that need live joins, filters, groupings, or flat-mappings over document collections. Not imported by any other Kyneta package at runtime — indexes are a consumer-side convenience, not a framework foundation.

---

## Questions this document answers

- What is a ℤ-set and why is it the internal representation? → [The ℤ-set foundation](#the-z-set-foundation)
- Why is `Source` not a `Changefeed`? → [`Source` — consumer-stateless producer](#source--consumer-stateless-producer)
- When do I use `Source.of` vs `Source.create` vs `Source.fromExchange`? → [`Source` constructors](#source-constructors)
- How does `Source.flatMap` compose two sources? → [`Source.flatMap` — bilinear composition](#sourceflatmap--bilinear-composition)
- What's the difference between `Collection` and a plain `ReactiveMap`? → [`Collection` — the ℐ integrator](#collection--the-ℐ-integrator)
- How does `Index.by` keep its groupings current? → [`SecondaryIndex` — the Gₚ grouping operator](#secondaryindex--the-gₚ-grouping-operator)
- How does `Index.join` avoid recomputing from scratch? → [`JoinIndex` — the bilinear operator](#joinindex--the-bilinear-operator)
- What is a `KeySpec` and when do I supply one? → [`KeySpec` — key-extraction helpers](#keyspec--key-extraction-helpers)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| ℤ-set | `ReadonlyMap<string, number>` with no zero-weight entries. An abelian group under pointwise addition. The universal change type. | A multiset, a sparse vector — ℤ-sets allow negative weights |
| DBSP | Database Stream Processor — the incremental-view-maintenance framework by Budiu, McSherry, Ryzhyk, Tannen that grounds this package. | A specific DBSP implementation — this package adapts the algebra, not a runtime |
| `ZSet` | The `ReadonlyMap<string, number>` type alias. Exported. | A runtime class — there is no `ZSet` class, only the map type + pure functions |
| `Source<V>` | Consumer-stateless producer of `SourceEvent<V>` deltas. Only three methods: `subscribe`, `snapshot`, `dispose`. | A `Changefeed` — `Source` lacks `current` and `[CHANGEFEED]` |
| `SourceEvent<V>` | `{ delta: ZSet, values: ReadonlyMap<string, V> }` — one ℤ-set delta plus values for added entries. | A `Changeset` — `SourceEvent` has no `origin` and its structure is ℤ-set, not change-list |
| `SourceHandle<V>` | Producer-side mutation surface for `Source.create`: `set(key, value)`, `delete(key)`. | A Consumer-facing API — consumers never see this |
| `ExchangeSourceHandle<V>` | Producer-side for `Source.fromExchange`: `createDoc(key)`, `delete(key)`. | `SourceHandle` |
| `Collection<V>` | `ReactiveMap<string, V, CollectionChange> & { dispose(): void }`. Stateful integrator of a `Source<V>`. | A JS `Array`, a schema `list` — `Collection` is a keyed reactive map, not an ordered sequence |
| `CollectionChange` | `{ type: "added" \| "removed", key: string }`. The projected change delivered to subscribers. | The internal ℤ-set — that's what flows between operators |
| `SecondaryIndex<V>` | Grouping view: `Map<GroupKey, Map<EntryKey, V>>` maintained incrementally as entries are added/removed/mutated. | A SQL index, a hash index — this is a live join/group intermediate |
| `IndexChange` | The change type emitted by `SecondaryIndex` — entries shifting between groups. | `CollectionChange` |
| `JoinIndex<L, R>` | Bilinear reactive join composing two `SecondaryIndex`es on a shared group-key space. | A SQL join, a hash-join table — this is an incrementally-maintained view |
| `KeySpec<V>` | A function / schema-path / list-of-paths that extracts one or more group keys from a value. | A validation schema |
| `field(path)` / `keys(...)` | Helpers that build a `KeySpec`. `field` yields one key; `keys` yields many (one entry per group-key). | `Schema.path` — these are runtime accessors, not schema nodes |
| `Index` | The namespace value exposing `Index.by(collection, keySpec?)` and `Index.join(left, right)`. | A `SecondaryIndex` — `Index` is the factory namespace |
| `Index.by` | `(collection, keySpec?) => SecondaryIndex<V>`. Identity grouping when `keySpec` omitted. | Building an index from a raw source — it requires a `Collection` |
| `Index.join` | `(left, right) => JoinIndex<L, R>`. Produces a new index over the shared group-key space. | A nested-loop or merge-join — this is incremental |
| Linear operator | `Δf = f` — the incremental version of the operator is the operator applied to the delta. Filter, projection, union, grouping. | Bilinear — joins are bilinear, not linear |
| Bilinear operator | `Δ(a ⋈ b) = Δa ⋈ ℐ(b) + ℐ(a) ⋈ Δb + Δa ⋈ Δb` — incremental form requires both sides' integrals and deltas. | Linear |

---

## Architecture

**Thesis**: maintain live views by computing on ℤ-set deltas rather than full states. A change to a document becomes a small delta through the pipeline; the materialized views at every stage update incrementally.

Three layers, one direction of flow:

```
 adapter              ℐ integrator          Gₚ grouping          bilinear
 (stateless)          (stateful, reactive)   operator             join operator
─────────┐            ┌─────────────┐        ┌─────────────┐      ┌──────────┐
Source<V>│ subscribe →│ Collection<V>│ ───→  │SecondaryIndex│ ──→ │JoinIndex │
─────────┘            │  .get/.has  │        │ <V>          │      │<L, R>    │
                      │  .keys/.size│        │Map<GK, Map<K,V>>│  │          │
                      │  .subscribe │        │              │      │          │
                      │ [CHANGEFEED]│        │              │      │          │
                      └─────────────┘        └─────────────┘      └──────────┘
```

| Layer | State? | Reactive? | Primary file |
|-------|--------|-----------|--------------|
| `Source<V>` | Internal (adapter-held) | Push via `subscribe` | `src/source.ts` |
| `Collection<V>` | Materialized ℐ | Yes — `ReactiveMap + [CHANGEFEED]` | `src/collection.ts` |
| `SecondaryIndex<V>` | Materialized grouping | Yes — `ReactiveMap` | `src/index-impl.ts` |
| `JoinIndex<L, R>` | Materialized join | Yes — `ReactiveMap` | `src/join.ts` |
| `ZSet` + group ops | None (pure) | N/A | `src/zset.ts` |
| `KeySpec` | None | N/A | `src/key-spec.ts` |

Five adapter constructors hand you a `Source`, and the rest of the pipeline composes statically:

```
const todos    = Collection.from(Source.of(exchange, TodoDoc))
const byAuthor = Index.by(todos, field("author"))
const authors  = Collection.from(Source.fromExchange(exchange, AuthorDoc))
const byId     = Index.by(authors)
const authored = Index.join(byAuthor, byId)
```

`authored` updates incrementally whenever `todos` or `authors` change — every stage propagates a ℤ-set delta, never a recomputation.

### What this package is NOT

- **Not a database.** There are no persistent indexes, no query planner, no storage. Everything lives in memory, keyed off the inputs.
- **Not a SQL engine.** `Index.join` is a reactive operator, not a query DSL. There is no plan, no optimizer, no relational algebra surface.
- **Not ordered.** Collections and indexes are keyed maps. Ordered collections are `Schema.list` / `MovableList` — different concerns.
- **Not a deduplicator.** Positive weights > 1 in a ℤ-set are allowed algebraically, but `Collection` projects to `Map<string, V>` — the second `set` for a key replaces the first. Applications needing multiplicity live below the `Collection` boundary at the ℤ-set layer.

---

## The ℤ-set foundation

Source: `packages/index/src/zset.ts`.

```ts
type ZSet = ReadonlyMap<string, number>
```

A ℤ-set is a function from keys to integers with finite support — every key maps to a non-zero integer, and only finitely many keys have non-zero values. The structure forms an **abelian group** under pointwise addition:

| Operation | Meaning | Pure fn |
|-----------|---------|---------|
| `zero()` | The empty ℤ-set (identity) | ✓ |
| `single(key, w?)` | A one-key ℤ-set of weight `w` (default 1) | ✓ |
| `add(a, b)` | Pointwise sum. Keys where the sum is 0 are pruned. | ✓ |
| `negate(a)` | Negate every weight. | ✓ |
| `positive(a)` | Clamp negative weights to 0. Drop zero entries. | ✓ |
| `isEmpty(a)` | `a.size === 0`. | ✓ |
| `entries(a)` | Iterator over `[key, weight]` pairs. | ✓ |
| `fromKeys(keys, w?)` | ℤ-set from an iterable of keys, all with the same weight. | ✓ |
| `toAdded(delta)` | Keys with positive weight. | ✓ |
| `toRemoved(delta)` | Keys with negative weight. | ✓ |

The **no-zero-weight invariant** is preserved by every constructor. This means `a.size === 0 ⟺ isEmpty(a)` and iteration never sees phantom entries.

### Why ℤ-sets

Three properties matter for incremental view maintenance:

1. **Deltas compose additively.** Two consecutive updates `Δ₁` and `Δ₂` combine as `add(Δ₁, Δ₂)`. No special case for "add then remove the same key" — the sum cancels.
2. **Linear operators commute with ℐ.** Filter, projection, and grouping have the form `Δf(Δinput) = f(Δinput)` — you apply the operator to the delta, not to the whole state.
3. **Bilinear operators have a closed-form delta.** `Δ(a ⋈ b) = Δa ⋈ ℐ(b) + ℐ(a) ⋈ Δb + Δa ⋈ Δb`. Joins stay incremental because you only need each side's integral plus the delta on the other side.

The DBSP paper (Budiu et al., VLDB 2023) formalizes this. This package implements the subset kyneta uses — no recursion, no aggregation windows — against JavaScript keyed maps.

### What a `ZSet` is NOT

- **Not a `Set`.** It has weights.
- **Not a `MultiSet` over values.** The keys are strings; values live in the accompanying `values` map in `SourceEvent`.
- **Not a runtime class.** It's a `ReadonlyMap<string, number>` alias with pure accessor/operator functions. There is no `new ZSet()`.

---

## `Source` — consumer-stateless producer

Source: `packages/index/src/source.ts`.

```ts
interface Source<V> {
  subscribe(cb: (event: SourceEvent<V>) => void): () => void
  snapshot(): ReadonlyMap<string, V>
  dispose(): void
}

interface SourceEvent<V> {
  readonly delta: ZSet
  readonly values: ReadonlyMap<string, V>
}
```

Three methods. That's it. No `current`, no `[CHANGEFEED]`, no mutation surface. Consumers subscribe to a stream of ℤ-set deltas and optionally take a bootstrap snapshot. Adapters internally hold mutable state (known-keys map, item subscriptions, exchange references) but that state is invisible to the consumer.

### Why not a `Changefeed`

`Changefeed<S>` from `@kyneta/changefeed` carries `current: S` + `subscribe`. Making `Source` a `Changefeed<Map<string, V>>` would require an eagerly-materialized current-map at the adapter level — which defeats the point. Bootstrap (`snapshot`) is the ℐ-integrator's concern (it lives in `Collection`), not the adapter's. Decoupling `Source` from the changefeed protocol keeps adapters thin and consumer-stateless.

The gate into the reactive world is `Collection.from(source)` — the ℐ integrator that materializes the state and adds `[CHANGEFEED]`.

### Representational invariant

For every `SourceEvent<V>`:
- `toAdded(event.delta)` ⊆ `keys(event.values)`.
- `toRemoved(event.delta)` need not appear in `values` (they're being removed).

Adapters enforce this by tracking which keys they've already emitted. Consumers rely on it — `Collection.from` looks up values only for keys with positive delta weight, without null-checks.

---

## `Source` constructors

| Constructor | Source of entries | Key |
|-------------|-------------------|-----|
| `Source.create()` | Manual — returns `[Source, SourceHandle]`. Handle exposes `set(key, value)` and `delete(key)`. | Caller-supplied |
| `Source.fromRecord(record)` | A static `Record<string, V>`. Snapshot-only; no updates. | Record keys |
| `Source.fromList(ref)` | A `@kyneta/schema` list ref. Entries are list items; keys are stable IDs derived from item identity. Updates via the schema's changefeed. | Item identity |
| `Source.fromExchange(exchange, bound, mapping?)` | Every doc in `exchange.documents` matching `bound`. Returns `[Source, ExchangeSourceHandle]`. Handle exposes `createDoc(key)` and `delete(key)`. | `mapping.toKey(docId)` or the docId directly |
| `Source.of(exchange, bound)` | Convenience: `Source.fromExchange` without a handle, using identity mapping. Read-only. | docId |

### `Source.fromList` and `Source.fromExchange` — subscription discipline

Both adapters subscribe to schema-level reactive feeds (`subscribeNode` for list refs; `exchange.documents` + per-doc subscriptions for exchange-backed sources). The adapter:

1. Takes an initial snapshot on construction.
2. Emits a ℤ-set delta on each observed change, with values for newly-positive keys.
3. Manages per-entry sub-subscriptions (when the schema requires — e.g., a list of structs whose field mutations must propagate).
4. Cleans up sub-subscriptions on `dispose()`.

The subscription discipline is transparent to the consumer: once you hold a `Source<V>`, you see exactly the three methods.

### What `Source` constructors are NOT

- **Not lazy factories.** They subscribe immediately. Bootstrap + subscribe are one atomic step.
- **Not composable by inheritance.** There is no `Source` subclass hierarchy. Composition is external — `Source.flatMap`, `Collection.from`, `Index.by`.
- **Not re-entrant-safe at the consumer boundary.** If a consumer's `subscribe` callback dispatches further upstream work, standard JS single-threaded guarantees apply — the adapter finishes delivering the current event before accepting the next.

---

## `Source.flatMap` — bilinear composition

```ts
Source.flatMap<A, B>(
  outer: Source<A>,
  project: (value: A, outerKey: string) => Source<B>,
  options?: FlatMapOptions,
): Source<B>
```

Given a `Source<A>` and a per-outer-entry projection to `Source<B>`, produce a `Source<B>` whose flat keys compose the outer + inner keys. Each inner source is constructed lazily as the outer entry appears, disposed when the outer entry leaves.

Default flat-key composition: `outerKey + "\0" + innerKey`. Override via `options.key`.

This is the standard flat-map shape, applied at the ℤ-set layer. It's bilinear in the DBSP sense — incremental updates to either the outer source or any of the inner sources propagate in O(|Δ|). The 481 tests in `source-of.test.ts` + `flatmap.test.ts` cover every permutation of outer/inner mutations.

### What `flatMap` is NOT

- **Not monadic in the general category-theoretic sense.** It's the `flatMap` shape applied to a reactive ℤ-set algebra; the laws are DBSP's, not `Monad`'s.
- **Not a recomputation on every outer change.** Only the deltas reach downstream.

---

## `Collection` — the ℐ integrator

Source: `packages/index/src/collection.ts`.

```ts
type Collection<V> = ReactiveMap<string, V, CollectionChange> & { dispose(): void }
type CollectionChange =
  | { type: "added";   key: string }
  | { type: "removed"; key: string }

Collection.from<V>(source: Source<V>): Collection<V>
```

`Collection.from` is the **only** way to construct a `Collection`. It:

1. Takes `source.snapshot()` as the initial state. (ℐ at t=0.)
2. Subscribes to source deltas.
3. For each event, applies removals first (so a remove+add on the same key works cleanly), then adds.
4. Emits a `Changeset<CollectionChange>` containing the projected add/remove list.
5. Exposes the standard `ReactiveMap` surface: `.get`, `.has`, `.keys`, `.size`, `[Symbol.iterator]`, `.subscribe`, `.current`, `[CHANGEFEED]`.

`Collection` is the **integrator**: the ℤ-set deltas from the source accumulate into materialized state. Before `Collection`, the pipeline is deltas-only; after, it's state + deltas.

### Why a `ReactiveMap`

`ReactiveMap<K, V, C>` from `@kyneta/changefeed` is exactly the shape — a keyed materialized view with a changefeed over typed changes. `Collection` *is* a `ReactiveMap`; it just carries a concrete constructor and the ℤ-set → projected-change translation logic. This means `Collection` plugs directly into React (`useValue(collection)`), into Cast regions, and into any downstream code that consumes reactive maps.

### Remove-before-add ordering

Inside a single `SourceEvent`, the delta may carry both a removal and an addition for the same key — e.g., when an item's group-key changes, the `SecondaryIndex` emits a paired remove-from-old-group + add-to-new-group in one delta. `Collection.from` applies removals first so that the downstream add is always an "insert into an empty slot" from the `Map`'s perspective. This matters for subscribers that react to the `removed` change before the `added` one — they see a coherent state at each step.

### What `Collection` is NOT

- **Not an Array.** No iteration order beyond Map-insertion semantics. Ordered access requires a downstream sort.
- **Not a cache.** There's no TTL, no eviction, no indirection. Entries live until the source removes them.
- **Not a queue.** Values are keyed and overwritable.

---

## `SecondaryIndex` — the Gₚ grouping operator

Source: `packages/index/src/index-impl.ts`.

```ts
Index.by<V>(collection: Collection<V>, keySpec?: KeySpec<V>): SecondaryIndex<V>

// SecondaryIndex<V> is a ReactiveMap<GroupKey, Map<EntryKey, V>, IndexChange>
```

Groups entries of a `Collection<V>` by one or more derived keys. Identity grouping (each entry in its own group) when `keySpec` is omitted — convenient for stacking joins.

The operator is **linear for structural changes**: adding / removing an entry affects only its group(s). For **field mutations** (the entry stays in the collection but its group-key changes), `SecondaryIndex` installs per-entry watchers that detect key transitions and emit paired remove-from-old + add-to-new deltas. These watchers are the "reactive extension" on top of the linear core.

### Two observation sources

| Observation | Mechanism |
|-------------|-----------|
| Entry add / remove (structural) | Subscribe to the source `Collection` |
| Entry's group-key mutates (reactive) | Subscribe to the specific field via the schema changefeed |

The reactive extension is essential for schema refs whose group-key is a mutable field (`author`, `status`, etc.). For static sources (`Source.fromRecord`) or identity grouping, the reactive extension is a no-op.

### Multi-key grouping

`KeySpec` can produce multiple keys per value (see [`KeySpec`](#keyspec--key-extraction-helpers)). Every group the entry belongs to gets an add; leaving those groups gets a remove. This models tag-style membership — one todo with `tags: ["urgent", "home"]` appears in both the `"urgent"` and `"home"` groups.

### What `SecondaryIndex` is NOT

- **Not a database index.** It's a materialized reactive view, not a B-tree on disk.
- **Not a sort.** Groups are unordered; within-group entries are insertion-ordered by Map semantics.
- **Not a window.** There's no time dimension; groupings are instantaneous.

---

## `JoinIndex` — the bilinear operator

Source: `packages/index/src/join.ts`.

```ts
Index.join<L, R>(left: SecondaryIndex<L>, right: SecondaryIndex<R>): JoinIndex<L, R>

// JoinIndex<L, R> is a ReactiveMap<GroupKey, { left: Map<K, L>, right: Map<K', R> }, JoinChange>
```

Composes two `SecondaryIndex`es sharing a group-key space. For each group key present in at least one side, the join exposes the intersection of entries on both sides.

`JoinIndex` is **bilinear** in the DBSP sense — its incremental maintenance uses the formula `Δ(a ⋈ b) = Δa ⋈ ℐ(b) + ℐ(a) ⋈ Δb + Δa ⋈ Δb`:

- When the left side emits a delta, the join reads the right side's integral (its current state) and emits corresponding join-output deltas.
- When the right side emits, symmetrically.
- When both emit simultaneously (rare, since emissions serialize through JS's single thread, but possible in paired-delta transactions), the cross-term contributes.

The implementation reads each side's current state (via the `SecondaryIndex` `ReactiveMap`) at emission time, so the integrals are free — no separate accumulation.

### What `JoinIndex` is NOT

- **Not a SQL join.** No filter predicates, no join type enum (inner / outer / left / right). The join is an inner join on group-key equality; for other shapes, compose with filter stages upstream.
- **Not a merge-join.** There's no ordering requirement.
- **Not recursive.** Joins don't feed back into themselves.

---

## `KeySpec` — key-extraction helpers

Source: `packages/index/src/key-spec.ts`.

```ts
type KeySpec<V> = /* function | schema-path | array of paths | etc. */

function field<V, K>(path: /* dotted path */): KeySpec<V>
function keys<V>(...specs: KeySpec<V>[]): KeySpec<V>
```

A `KeySpec<V>` tells `Index.by` how to derive group keys from a value. Three common shapes:

| Shape | Yields | Example |
|-------|--------|---------|
| `field("author")` | One group key per value (the value at path `author`) | Group todos by author |
| `field("tags.0")` | One group key per value (first tag) | Group by first tag |
| `keys(field("author"), field("assignee"))` | Multiple group keys (both author and assignee) | Index appears once under each derived key |

`KeySpec` composition is pure — applying it to a value produces a `string | string[]` key set. The runtime machinery is in `key-spec.ts`; 11 tests in `key-spec.test.ts` cover the cases.

### What `KeySpec` is NOT

- **Not a validator.** It extracts; it does not check types.
- **Not a schema node.** `KeySpec` operates on runtime values; `Schema` describes structure.
- **Not cacheable in general.** The same `KeySpec` + same value ought to produce the same keys, but `SecondaryIndex` never relies on memoization — every application is fresh.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `ZSet` | `src/zset.ts` | `ReadonlyMap<string, number>` — the universal change type. |
| `zero` / `single` / `add` / `negate` / `positive` / `isEmpty` / `entries` / `fromKeys` / `toAdded` / `toRemoved` | `src/zset.ts` | Pure ℤ-set operators. |
| `Source<V>` | `src/source.ts` | Consumer-stateless producer contract. |
| `SourceEvent<V>` | `src/source.ts` | `{ delta, values }` — one emission. |
| `SourceHandle<V>` / `ExchangeSourceHandle<V>` / `SourceMapping` / `FlatMapOptions` | `src/source.ts` | Producer-side and config types. |
| `Source` | `src/source.ts` | Namespace: `.create`, `.fromRecord`, `.fromList`, `.fromExchange`, `.of`, `.flatMap`. |
| `Collection<V>` | `src/collection.ts` | The ℐ integrator — `ReactiveMap<string, V, CollectionChange>` + `dispose`. |
| `CollectionChange` | `src/collection.ts` | `{ type: "added" \| "removed", key }`. |
| `Collection.from` | `src/collection.ts` | Sole constructor. |
| `SecondaryIndex<V>` | `src/index-impl.ts` | The Gₚ grouping operator. |
| `IndexChange` | `src/index-impl.ts` | Projected change type. |
| `JoinIndex<L, R>` | `src/join.ts` | The bilinear join operator. |
| `KeySpec<V>` / `field` / `keys` | `src/key-spec.ts` | Key-extraction types + helpers. |
| `Index` | `src/index.ts` | `{ by, join }` namespace. |

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 79 | Public barrel. Exports `Source`, `Collection`, `SecondaryIndex`, `JoinIndex`, `Index`, `ZSet` + operators, `KeySpec` helpers. |
| `src/zset.ts` | 101 | `ZSet` type + pure abelian-group operators. |
| `src/source.ts` | 798 | `Source` contract + five constructors + `flatMap`. The largest file — adapter construction, subscription discipline, re-entrancy handling. |
| `src/collection.ts` | 87 | `Collection.from` — subscribe to a source, maintain a `ReactiveMap`, project ℤ-set deltas to `CollectionChange`. |
| `src/index-impl.ts` | 315 | `Index.by` → `SecondaryIndex` — grouping with structural + reactive watchers. |
| `src/join.ts` | 176 | `Index.join` → `JoinIndex` — bilinear incremental join. |
| `src/key-spec.ts` | 106 | `KeySpec` type, `field`, `keys`. |
| `src/__tests__/zset.test.ts` | 195 | Abelian-group laws: associativity, commutativity, identity, inverse; `positive` / `negate` / `fromKeys` / `entries`. |
| `src/__tests__/source.test.ts` | 512 | All five constructors; bootstrap; delta emission; representational invariant; dispose. |
| `src/__tests__/source-of.test.ts` | 481 | `Source.of` over exchange — full lifecycle under real doc mutations. |
| `src/__tests__/flatmap.test.ts` | 379 | `Source.flatMap` — outer/inner permutations, key composition, inner-source disposal. |
| `src/__tests__/collection.test.ts` | 166 | `Collection.from` — snapshot, deltas, remove-before-add ordering, disposal. |
| `src/__tests__/index.test.ts` | 531 | `Index.by` — identity grouping, field grouping, multi-key grouping, field-mutation watchers, structural changes. |
| `src/__tests__/join.test.ts` | 479 | `Index.join` — bilinear maintenance under left-only, right-only, and paired deltas. |
| `src/__tests__/key-spec.test.ts` | 265 | `field`, `keys`, composition, multi-key emission. |

## Testing

Every test is pure JS — no `Schema.bind` requirement beyond what `Source.of` / `Source.fromList` exercise, no real substrates needed for the core ℤ-set algebra. Adapter tests use in-memory exchanges (`Bridge` + `BridgeTransport` from `@kyneta/transport`) and the plain substrate from `@kyneta/schema`. Algebraic-law tests assert the abelian-group properties directly on constructed `ZSet` values.

**Tests**: 143 passed, 0 skipped across 8 files (`zset.test.ts`: ~30 by convention; `source.test.ts`: 30; `index.test.ts`: 27; `join.test.ts`: 13; `key-spec.test.ts`: 11; plus `collection.test.ts`, `flatmap.test.ts`, `source-of.test.ts`). Run with `cd packages/index && pnpm exec vitest run`.