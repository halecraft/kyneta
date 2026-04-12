# @kyneta/index — Technical Reference

DBSP-grounded reactive indexing over keyed collections. All operators compute on ℤ-sets internally; the algebra guarantees correctness of incremental maintenance.

---

## 1. DBSP Foundations

The DBSP paper (Budiu, McSherry, Ryzhyk, Tannen) provides the mathematical framework:

- **ℤ-set**: A function K → ℤ with finite support, forming an abelian group under pointwise addition. Elements with weight +1 are "present", −1 are "removed", 0 are pruned.
- **Stream**: ℕ → A — a sequence of values indexed by time. In our system, the changefeed protocol delivers the stream.
- **ℐ (integration)**: Accumulates a stream of deltas into running state. `Collection.from(source)` is ℐ.
- **𝒟 (differentiation)**: Extracts the delta from state. The changefeed emitted by a Collection is 𝒟.
- **Chain rule**: Δ(Q₁ ∘ Q₂) = ΔQ₁ ∘ ΔQ₂ — the incremental version of a composite query decomposes.
- **Linear operator**: Δf = f — filter, projection, union, grouping are their own incremental versions.
- **Bilinear operator**: Δ(a ⋈ b) = Δa ⋈ Δb + ℐ(a) ⋈ Δb + Δa ⋈ ℐ(b).
- **`distinct`**: Clamp positive multiplicities to 1. The only non-linear primitive. Implemented as `positive()`.

---

## 2. Architecture Overview

```
                        ┌───────────────┐
                        │   Source.of   │  High-level entry point
                        │  (exchange +  │  (read-only convenience)
                        │   flatMap)    │
                        └───────┬───────┘
                                │
┌─────────────────────────────────────────────────┐
│  JoinIndex<L, R>                                │
│  Bilinear composition — delegates to two         │
│  SecondaryIndex instances                        │
├─────────────────────────────────────────────────┤
│  SecondaryIndex<V>                              │
│  Gₚ (grouping) — linear for structural deltas,  │
│  FK-mutation watchers as reactive extension       │
├─────────────────────────────────────────────────┤
│  Collection<V>                                  │
│  ℐ (integration) — accumulates source deltas    │
│  into ReactiveMap state. Is a Changefeed.        │
├─────────────────────────────────────────────────┤
│  Source<V>                                      │
│  Consumer-stateless delta producer. NOT a        │
│  Changefeed. Adapters: create, fromRecord,       │
│  fromList, fromExchange. Composition: filter,    │
│  union, map, flatMap.                            │
└─────────────────────────────────────────────────┘
```

| Layer | Changefeed? | `current` | Events |
|---|---|---|---|
| Source | No | N/A | `SourceEvent<V>` (ℤ-set delta + values) |
| Collection | Yes | `ReadonlyMap<string, V>` | `CollectionChange` (`added`/`removed`) |
| SecondaryIndex | Yes | `ReadonlyMap<string, Set<string>>` | `IndexChange` (`group-added`/`group-removed`) |
| JoinIndex | Yes | `null` | `IndexChange` (re-emitted from both sides) |

---

## 3. ZSet — The Abelian Group

`ZSet = ReadonlyMap<string, number>` — key → integer weight with finite support.

**Invariant:** No entry has weight 0 — zero-weight entries are pruned.

**Group operations** (all pure):

| Operation | Description |
|---|---|
| `zero()` | Identity element — empty map |
| `single(key, weight?)` | Singleton (default weight = 1) |
| `add(a, b)` | Pointwise addition |
| `negate(a)` | Pointwise negation |
| `isEmpty(z)` | True if no non-zero entries |
| `positive(z)` | DBSP `distinct` — clamp positive to 1, discard rest |
| `fromKeys(keys)` | Each key → +1 |
| `toAdded(z)` | Keys with weight > 0 |
| `toRemoved(z)` | Keys with weight < 0 |

**Key insight:** `diffKeys(old, new)` and `regroupEntry(old, new)` from the old codebase both collapse to a single `add(fromKeys(new), negate(fromKeys(old)))` call. Set-difference operations disappear into group arithmetic.

---

## 4. Source — Protocol and Adapters

A `Source<V>` has three methods: `subscribe(cb)`, `snapshot()`, `dispose()`.

**`SourceEvent<V>`:** `{ delta: ZSet, values: ReadonlyMap<string, V> }`

The `delta` is the ℤ-set change. The `values` map carries actual `V` values for keys with positive deltas only. Removals carry only the key (weight = −1).

**Representational invariant:** Every key with positive weight in `delta` must have a corresponding entry in `values`. Enforced by `createSourceEvent()` factory.

### Adapters

- **`Source.create<V>()`**: Manual source. `set()` on new key → +1 delta. `set()` on existing → silent replace. `delete()` → −1 delta.
- **`Source.fromRecord(recordRef)`**: Uses `subscribeNode` (NOT `subscribe`) — fires only on structural changes (key add/remove), not descendant mutations.
- **`Source.fromList(listRef, keyFn)`**: Two subscription layers: structural (`subscribeNode` on list) + per-item key (`subscribeNode` on `keyFn(itemRef)`). Key change emits paired −1/+1 delta.
- **`Source.fromExchange(exchange, bound, mapping?)`**: Returns `[Source<V>, ExchangeSourceHandle<V>]`. The `mapping` parameter is optional — defaults to identity (`docId` = key). `ExchangeSourceHandle.delete(key)` calls `exchange.dismiss()` — symmetric with `createDoc`.

### Linear composition

- `Source.filter(source, pred)`: Predicate applied directly to delta entries. ΔFilter = Filter.
- `Source.union(a, b)`: Merges events from both sides.
- `Source.map(source, fn)`: Remaps keys. `fn` returning `null` filters out the entry.

### 4.1 flatMap — Dynamic Union

`Source.flatMap` is the first **stateful** combinator in the Source layer. Unlike `filter`, `union`, and `map` (which are stateless/linear), `flatMap` maintains a live map of inner sources keyed by outer entries.

**Signature:**

```ts
Source.flatMap<Outer, Inner>(
  outer: Source<Outer>,
  fn: (key: string, value: Outer) => Source<Inner>,
  options?: FlatMapOptions,
): Source<Inner>
```

**Semantics.** For each entry `(outerKey, outerValue)` in the outer source, `fn` produces an inner `Source<Inner>`. The flat source is the dynamic union of all live inner sources, with keys namespaced to avoid collision.

**Key namespacing.** Default: `outerKey + "\0" + innerKey` — the same `"\0"` separator used by `field()` for compound keys, ensuring consistent key structure throughout the system. A custom key function can be supplied via `FlatMapOptions.key`.

**Inner source lifecycle:**

| Outer event | Action |
|---|---|
| Arrival (weight > 0) | `fn(outerKey, outerValue)` creates an inner source. Subscribe to it, then emit its `snapshot()` as +1 deltas. |
| Departure (weight < 0) | Snapshot the inner source at departure time (lazy retraction), emit all entries as −1 deltas, unsubscribe, dispose. |

Inner sources are fully independent — an event from inner source A does not affect inner source B.

**No intermediate state stored.** Per outer entry, flatMap keeps only `{ innerSource, innerUnsub }`. It does not cache inner snapshots; retraction at departure time uses a lazy `innerSource.snapshot()` call.

**`remapEvent` — pure FC.** The key-remapping logic is extracted as a pure function:

```ts
function remapEvent<V>(
  event: SourceEvent<V>,
  outerKey: string,
  keyFn: (outerKey: string, innerKey: string) => string,
): SourceEvent<V>
```

This is the functional core of the imperative subscribe/snapshot shell, following the FC/IS decomposition used throughout the codebase.

**`snapshot()` — lazy aggregation.** The flat source's `snapshot()` iterates all live inner sources and remaps keys on the fly. No materialized aggregate is maintained.

**Bootstrap.** On construction, flatMap reads `outer.snapshot()` and creates inner sources for each existing outer entry. During bootstrap, inner sources are subscribed but their snapshots are not eagerly emitted — they are discovered lazily through `snapshot()`. Post-bootstrap, outer arrivals go through `addInner` which does emit inner snapshots as events.

**Relationship to DBSP.** DBSP defines nested stream incrementalization for operators over streams-of-streams. Our `flatMap` is *not* that. It is a simpler construct: a **dynamic union** where each inner source is an independent stream, and the outer source controls which inner streams are active. There is no algebraic nesting — inner streams do not carry incremental structure relative to the outer stream. This is sufficient for our use case (exchange entity discovery) and avoids the complexity of DBSP's full nested incremental theory.

### 4.2 Source.of — Exchange Entity Discovery

`Source.of` is the high-level entry point for discovering and tracking entities across exchange documents. It composes `fromExchange`, `flatMap`, `fromRecord`, and `fromList` into a single convenience with three overloads discriminated by argument count.

**Overloads:**

```ts
// Document-level (2 args)
Source.of<V>(exchange, bound): Source<V>

// Record-level (3 args)
Source.of<V>(exchange, bound, accessor): Source<V>

// List-level (4 args)
Source.of<V>(exchange, bound, accessor, keyFn): Source<V>
```

**Document-level (2 args).** Each document matching `bound` is an entry keyed by `docId`. The value is the document ref itself.

Implementation: `fromExchange(exchange, bound)` → discard `ExchangeSourceHandle` → return `Source<V>`.

**Record-level (3 args).** Each document contains a record (map) ref accessed via `accessor(docRef)`. The entities are the record's keys, namespaced under the document.

Implementation: `flatMap(fromExchange(...), (docId, docRef) => fromRecord(accessor(docRef)))`.

Keys follow flatMap's default namespacing: `docId + "\0" + recordKey`.

**List-level (4 args).** Each document contains a list ref accessed via `accessor(docRef)`. The entities are list items, keyed by `keyFn`, namespaced under the document.

Implementation: `flatMap(fromExchange(...), (docId, docRef) => fromList(accessor(docRef), keyFn))`.

Keys follow flatMap's default namespacing: `docId + "\0" + entityKey`.

**Read-only by design.** All three overloads discard the `ExchangeSourceHandle` returned by `fromExchange`. Writes go through the exchange directly (document-level) or through schema ref mutation (entity-level). This is intentional — `Source.of` is a *discovery* mechanism, not a write API.

**Returns `Source<V>`, not `Collection<V>`.** This preserves composability — the caller can apply `filter`, `union`, `map`, or feed the source into `Collection.from()` as needed.

---

## 5. Collection — The ℐ Operator

`Collection<V> = ReactiveMap<string, V, CollectionChange> & { dispose() }`

`Collection.from(source)` is the **single constructor**:
1. Bootstraps from `source.snapshot()` (ℐ at t=0)
2. Subscribes to `source.subscribe()` — applies ℤ-set delta to internal map
3. Projects delta to `CollectionChange[]` via `toAdded`/`toRemoved`

Collection is **read-only** — no `set`, `delete`, or `createDoc`. Writability lives in the Source layer.

Collection is a full `Changefeed` — `hasChangefeed(collection)` returns `true`.

---

## 6. KeySpec — Partitioning + Differentiation

`KeySpec<V>` bundles two concerns:
- `groupKeys(key, value) → string[]` — the partitioning function
- `watch?(key, value, onRegroup) → () => void` — optional subscription for FK mutation detection

### `field(...accessors)`

- Single: `groupKeys = (k, v) => [String(accessor(v)())]`, `watch = subscribeNode(accessor(v), cb)`
- Compound: `groupKeys = (k, v) => [accessors.map(...).join("\0")]`, `watch` subscribes to all accessors

### `keys(accessor)`

- `groupKeys = (k, v) => [...accessor(v).keys()]`, `watch = subscribeNode(accessor(v), cb)`
- Uses `subscribeNode` — mutations to values inside the record do NOT fire

---

## 7. SecondaryIndex — The Gₚ Operator

DBSP's linearity proof for Gₚ assumes immutable tuples. Our system extends this for mutable refs.

**Structural delta path (pure DBSP):** When a Collection `added`/`removed` event arrives, the partitioning function routes entries directly to groups. This is linear: ΔGₚ = Gₚ.

**FK-mutation path (reactive extension):** When `KeySpec.watch` fires, `regroupDelta(oldKeys, newKeys)` computes the ℤ-set diff: `add(fromKeys(newKeys), negate(fromKeys(oldKeys)))`. This synthetic delta feeds the same linear pipeline. The extension is not a violation of DBSP — it's an additional delta source.

**FC/IS decomposition:** The pure functional core is `regroupDelta(old, new) → ZSet`. Tagged unions (`group-added`/`group-removed`) appear only at the changefeed emission boundary — mirroring how `toAdded`/`toRemoved` project ℤ-set deltas at the Collection boundary.

**Changefeed participation:** `SecondaryIndex<V>` extends `Changefeed<ReadonlyMap<string, Set<string>>, IndexChange>`. `hasChangefeed(index)` returns `true`. `.current` is the group map.

**`get(groupKey)` — reactive group view:** Returns a `ReactiveMap<string, V, IndexChange>` scoped to a single group. This is the ℤ-set integration operator applied to a filtered stream of group deltas. The `ReactiveMap` bootstraps from the current group state, subscribes to the parent index's changefeed filtered by `groupKey`, and maintains itself reactively. An empty group returns an empty `ReactiveMap` that populates when entries arrive. `hasChangefeed(index.get(groupKey))` returns `true`. This replaces the old `lookup` method — `get` subsumes it with strictly more capability (reactive instead of snapshot).

---

## 8. JoinIndex — The Bilinear Operator

`JoinIndex<L, R>` composes two `SecondaryIndex` instances. It subscribes to both changefeeds and re-emits.

- `get(leftKey)` → left's groupKeys → right's entries in those groups, returned as a `ReactiveMap<string, R, IndexChange>`
- `reverse(rightKey)` → right's groupKeys → left's entries in those groups, returned as a `ReactiveMap<string, L, IndexChange>`

Both methods return live reactive maps that update as the underlying indexes change. This replaces the old `lookup`/`reverse` snapshot methods.

`JoinIndex.current` is `null` — a join is a traversal, not a materialized view. But it carries `[CHANGEFEED]` for reactive subscription.

---

## 9. Exchange Integration

`Source.fromExchange(exchange, bound, mapping?)` replaces the old `Catalog.fromExchange`:

- The `mapping` parameter is optional — defaults to identity (`docId` = key), which covers the common case
- Registers schema via `exchange.registerSchema(bound)`
- Bootstraps from `exchange.documentIds()`
- Tracks lifecycle via `exchange.register()` scope (`onDocCreated`, `onDocDismissed`)
- `ExchangeSourceHandle.createDoc(key)` → `exchange.get(toDocId(key), bound)`
- `ExchangeSourceHandle.delete(key)` → `exchange.dismiss(toDocId(key))` — symmetric with create

`Source.of` (§4.2) composes `fromExchange` with `flatMap` to provide higher-level entity discovery without requiring the caller to manage `ExchangeSourceHandle` or inner source wiring.

---

## 10. TS2589 and `any`

`Ref<S>` is a deeply recursive conditional type that exceeds TypeScript's instantiation depth limit. The package uses `any` internally and types at the public API boundary — same pattern as before.

---

## 11. Deferred Concerns

- **Temporal references** — time-windowed collections
- **Value-level reactive joins** — materialize join results, not just traversals
- **Scope/visibility** — access control on collections
- **Lifecycle coupling** — automatic dispose propagation through the pipeline
- **Aggregation** — a clear extension path via DBSP's linear aggregation over groups
- **Bag semantics** — `ZSet` already tracks integer multiplicities; upgrading from sets to bags means removing the `positive`/`distinct` call at the Collection boundary

---

## 12. File Map

| File | Purpose |
|---|---|
| `src/zset.ts` | `ZSet` — abelian group type and operations |
| `src/source.ts` | `Source<V>` — protocol, adapters, composition, `flatMap`, `Source.of` |
| `src/collection.ts` | `Collection<V>` — ℐ operator |
| `src/key-spec.ts` | `KeySpec`, `field`, `keys` — key extraction helpers |
| `src/index-impl.ts` | `SecondaryIndex<V>` — Gₚ operator with reactive `get()` |
| `src/join.ts` | `JoinIndex<L, R>` — bilinear join |
| `src/index.ts` | Barrel exports |
| `src/__tests__/zset.test.ts` | ZSet group axioms and operations |
| `src/__tests__/source.test.ts` | Source adapters and composition |
| `src/__tests__/flatmap.test.ts` | `flatMap` — dynamic union lifecycle, key namespacing, composition |
| `src/__tests__/source-of.test.ts` | `Source.of` — document/record/list-level discovery, dispose |
| `src/__tests__/collection.test.ts` | Collection integration and changefeed |
| `src/__tests__/key-spec.test.ts` | KeySpec helpers and watch behavior |
| `src/__tests__/index.test.ts` | SecondaryIndex grouping scenarios |
| `src/__tests__/join.test.ts` | JoinIndex traversal and incremental updates |