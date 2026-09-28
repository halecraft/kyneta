# @kyneta/loro-schema — Technical Reference

> **Package**: `@kyneta/loro-schema`
> **Role**: Loro CRDT substrate for `@kyneta/schema`. Wraps a `LoroDoc` as a `Substrate<LoroVersion>` with schema-guided live navigation, `applyDiff`-based writes, identity-keyed containers for cross-schema sync, and a persistent event bridge so every mutation — local kyneta writes, `merge()`, `doc.import()`, or raw Loro API — fires the kyneta changefeed.
> **Depends on**: `@kyneta/schema` (peer), `@kyneta/changefeed` (peer), `loro-crdt` (peer)
> **Depended on by**: `@kyneta/exchange` (dev), `@kyneta/react` (dev), `@kyneta/cast` (dev), application code that wants collaborative documents
> **Canonical symbols**: `loro` (binding target: `loro.bind`, `loro.replica`), `LoroLaws`, `LoroNativeMap`, `createLoroSubstrate`, `loroSubstrateFactory`, `loroReplicaFactory`, `LoroVersion`, `LoroPosition`, `loroReader`, `resolveContainer`, `stepIntoLoro`, `PROPS_KEY`, `changeToDiff`, `batchToOps`, `hasKind`, `isLoroContainer`, `isLoroDoc`, `fromLoroSide`, `toLoroSide`
> **Key invariant(s)**: Subscribing to the kyneta doc observes **every** mutation to the underlying `LoroDoc`, regardless of source — local writes, `merge()`, `doc.import()`, or raw Loro API calls. The persistent `doc.subscribe()` event bridge is the enforcement mechanism; bridge batches are announced (`ingress: "announce"`) after the shadow is re-materialized, so they never reach `prepare`/`afterBatch`; and a pre-commit-hook discriminator (`subscribePreCommit` captures the in-flight commit's identity; the subscribe handler matches via `batch.to`) prevents the bridge from reprocessing commits we just issued ourselves, leaving the user-facing `batch.origin` slot free for `options.origin` round-trip.

The Loro backend for Kyneta. Hands you a substrate instance — stored state, versioning, export/import, and a `Reader` — in exchange for a `LoroDoc`. Every ref produced by the interpreter stack reads through schema-guided container resolution; every write produces a `Diff` applied via `doc.applyDiff`; every Loro-visible mutation surfaces as a `Changeset` on the kyneta changefeed.

Consumed by applications that bind schemas with `loro.bind(schema)`. Not imported by any other Kyneta package at runtime — `@kyneta/exchange`, `@kyneta/react`, and `@kyneta/cast` depend on it only in dev/test.

---

## Questions this document answers

- How does a read traverse the Loro container tree? → [Live navigation](#live-navigation)
- Why not a static container map built at `bind()` time? → [Why live navigation](#why-live-navigation)
- How does a kyneta `Change` become a Loro `applyDiff` call? → [The write path](#the-write-path)
- What is `PROPS_KEY` and why do root scalars live inside one map? → [The `_props` container](#the-_props-container)
- How are containers keyed across schema versions? → [Identity-keyed containers](#identity-keyed-containers)
- Why `.kind()` instead of `instanceof` to discriminate containers? → [Container discrimination across the WASM boundary](#container-discrimination-across-the-wasm-boundary)
- How does an external `doc.import()` notify kyneta subscribers? → [The event bridge](#the-event-bridge)
- How do cursors stay stable across concurrent edits? → [`LoroPosition`](#loroposition)
- Why is a `PeerID` 64 bits wide, past what a JS number holds? → [`PeerID` width](#peerid-width)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `LoroDoc` | Loro's top-level document handle (from `loro-crdt`). Owns peers, operations, version vector. | A kyneta `DocRef` — the `LoroDoc` is the substrate-native backing; `DocRef` is the interpreter-stack handle |
| `LoroLaws` | The composition-law set `"lww" \| "additive" \| "positional-ot" \| "positional-ot-move" \| "lww-per-key" \| "tree-move" \| "lww-tag-replaced"`. The algebraic merge properties Loro faithfully implements. | Loro's own feature set — this is the subset kyneta exposes via law tags |
| `LoroNativeMap` | The `NativeMap` functor mapping schema kinds to Loro container types (`text → LoroText`, `list → LoroList`, `struct → LoroMap`, etc.). | A JS `Map` — this is a type-level functor, not a runtime object |
| `LoroVersion` | `@kyneta/schema`'s `Version` implementation wrapping Loro's `VersionVector`. | Loro's `Frontiers` (DAG leaf ops for checkpoints) — `VersionVector` is the full peer-state vector used for sync diffing |
| `LoroPosition` | `Position` implementation wrapping Loro's `Cursor`. Stateless `transform` — resolution queries the CRDT directly. | A numeric index |
| `resolveContainer` | Thin wrapper over the core `foldPath(stepIntoLoro, ...)` primitive (from `@kyneta/schema`). The two semantic invariants (identity-keying, opaque-boundary stop) live in `@kyneta/schema/src/fold-path.ts`, not here. | A cache lookup — resolution happens on every read |
| `stepIntoLoro` | The Loro `PathStepper`: per-step substrate dispatch. Given `(current, nextSchema, segment, identity)` returns the child container or scalar. Driven by `foldPath`. | `stepFromDoc`, which is the root-level variant |
| `stepFromDoc` | Root-level dispatch: given a `LoroDoc` and a field schema, return the typed root container (`doc.getMap(key)`, `doc.getText(key)`, etc.). | `stepIntoLoro` |
| `PROPS_KEY` | The string `"_props"` — the reserved LoroMap key under which every root-level scalar and sum field is stored. | An application field name — reserved |
| `changeToDiff` | Pure: turn a kyneta `Change` + path + schema into a `[ContainerID, Diff][]` tuple list. | Loro's own `Diff` construction — we translate from kyneta's vocabulary |
| `batchToOps` | Inverse: turn Loro event-emitted `Diff[]` (after `doc.import` or external mutation) into kyneta `Op[]`. | `changeToDiff` — opposite direction |
| `loroReader` | `Reader` implementation that reads by resolving the container at `path` and extracting its value. | Substrate state — the reader is a live view |
| `applyDiff` | Loro's bulk-write API. `prepare()` applies structural diffs at once and coalesces plain map diffs, which `afterBatch()` applies in one call. | `doc.import` — imports a binary update; `applyDiff` applies structural diffs |
| `subscribePreCommit / ourCommits` | Loro's pre-commit hook fires synchronously inside `doc.commit()`, before the subscribe event. The substrate uses it to capture the in-flight commit's identity `(peer, counter+length-1)` into a closure-scoped `Set<string>`; the subscribe handler consumes the matching entry via `delete`-as-predicate against `batch.to` entries. A `capture` state (`"off" | "open" | "closing"`) gates it: every commit from the start of `work()` through the pre-commit of `runBatch`'s final commit is ours (see [Why the pre-commit hook](#why-the-pre-commit-hook)). | `inOurCommit` — the old ambient boolean flag |
| `ctx.announce(ops, origin)` | How the event bridge reports ops the LoroDoc already holds, after re-materializing the shadow. An announcement never reaches `substrate.prepare` or `afterBatch`. Retires the earlier global `inEventHandler` flag. | `batch()` — an authored write, which does reach `prepare` |
| Identity hash | Content-addressed 128-bit hex derived from `(path, generation)` via FNV-1a-128. The Loro container key for every product-field boundary. | A field name |
| `SchemaBinding` | `{ forward: Map<string, Hash>, backward: Map<Hash, string> }` from `@kyneta/schema`. Threaded through `resolveContainer` so every key lookup uses identity, not name. | A validation rule |

---

## Architecture

**Thesis**: Loro already stores the state. This package is a thin, substrate-shaped lens that translates between kyneta's schema-guided API and Loro's container-and-diff reality — with zero caching of its own and one event subscription that makes the substrate transparent to external mutations.

Four responsibilities:

| Responsibility | Primary source |
|----------------|----------------|
| Navigation (schema → container) | `src/loro-resolve.ts` — `resolveContainer`, `stepIntoLoro`, `stepFromDoc` |
| Reads (container → value) | `src/reader.ts` — `loroReader` |
| Writes (kyneta `Change` → Loro `Diff`) | `src/change-mapping.ts` — `changeToDiff`, `batchToOps` |
| Substrate orchestration (prepare/flush, merge, events) | `src/substrate.ts` — `LoroSubstrate`, `loroSubstrateFactory` |

The interpreter stack (from `@kyneta/schema`) sits above. Loro sits below. This package is the bidirectional translator.

### What `@kyneta/loro-schema` is NOT

- **Not a `LoroDoc` wrapper or subclass.** It accepts a user-owned or factory-created `LoroDoc` and adapts it to `Substrate<LoroVersion>`. The `LoroDoc` is still usable directly — `unwrap(doc)` returns it.
- **Not a query layer.** There are no indexes, no selectors, no precomputed views. All reads resolve containers on demand.
- **Not a Loro adapter library.** It is specific to `@kyneta/schema`'s substrate contract.
- **Not a sync engine.** The exchange runs sync; this package only exports/imports `SubstratePayload` when the exchange asks.

---

## Live navigation

Every read (`doc.title()`, `doc.items.at(0).body()`, `ref.current`) resolves its container on demand. No preflight container cache, no materialized tree.

```
resolveContainer(doc, schema, path, binding) =
  foldPath(doc, schema, path, stepIntoLoro, binding)
```

Source: `packages/schema/backends/loro/src/loro-resolve.ts`.

`foldPath` is the schema-guided path-fold primitive in `@kyneta/schema` (see [§foldPath](../../TECHNICAL.md#foldpath--schema-guided-path-resolution)). It owns the fold skeleton, the identity-keying rule (only at `seg.role === "field"`), and the opaque-boundary stop. `stepIntoLoro` is the only Loro-specific piece: given `(current, nextSchema, segment, identity)` it dispatches on `isLoroDoc(current)` (root → `stepFromDoc`) or container `.kind()` (non-root), returning the child container or scalar.

**Opaque boundary.** When the fold lands on a sum or a `.json()` node, `foldPath` short-circuits: the boundary's plain value (stored via `_props` or a parent map) is descended via plain JS property access for any remaining segments. This is sound because neither can contain a Loro container — sum variants are always `PlainSchema`, and a `.json()` subtree is one inert blob.

### `stepFromDoc` — root dispatch

The root case is different because `LoroDoc` is not itself a container. `stepFromDoc(doc, fieldSchema, key)` reads the field schema's `[KIND]` and calls the matching typed accessor:

| Field `[KIND]` | Accessor | Returns |
|----------------|----------|---------|
| `text` | `doc.getText(key)` | `LoroText` |
| `counter` | `doc.getCounter(key)` | `LoroCounter` |
| `movable` | `doc.getMovableList(key)` | `LoroMovableList` |
| `tree` | `doc.getTree(key)` | `LoroTree` |
| `product`, `set` | `doc.getMap(key)` | `LoroMap` |
| `sequence` | `doc.getList(key)` | `LoroList` |
| `map` | `doc.getMap(key)` | `LoroMap` |
| `scalar`, `sum` (no container) | `doc.getMap(PROPS_KEY).get(key)` | Plain value |

`key` is the identity hash (see [Identity-keyed containers](#identity-keyed-containers)).

### Tree node containers — step into `.data`

The `Tree` case in `stepFromContainer` is the one container that doesn't simply hand back its child node. An entry segment that names a `TreeID` resolves via `LoroTree.getNodeByID(id)` to a `LoroTreeNode`, but **`LoroTreeNode` is not a Loro container**: it has no `.kind()` method, and its `.id` is a `TreeID` (`${counter}@${peerID}`), not a `ContainerID`. The only true Loro container reachable from a tree node is `node.data: LoroMap` — the per-node metadata map.

The fold therefore steps into `node.data` on the Tree case:

```ts
case "Tree": {
  const node = container.getNodeByID(id)
  return node?.data  // LoroMap, the per-node metadata container
}
```

This makes per-node field paths (`d.tree.node(id).label`) discriminate as normal map navigation: `.data` exposes `.kind() === "Map"` and a real `ContainerID`, so the next segment dispatches via the Map branch. Returning the raw `LoroTreeNode` would short-circuit `foldPath` to `undefined` at the next step (no `.kind()`) and route per-node MapChange writes to the parent `LoroTree`'s container ID — which Loro rejects (the WASM decoder panics with "Invalid diff type for tree container").

The corollary for the `unwrap()` escape hatch: `unwrap(d.tree)` returns a `LoroTree`, but `unwrap(d.tree.node(id))` returns the node's `LoroMap` — not the `LoroTreeNode` wrapper. Callers that want the wrapper can recover it via `tree.getNodeByID(id)` on the LoroTree handle.

### Why live navigation

**Note:** The reader no longer navigates live Loro containers for ordinary reads. All reads go through `plainReader(shadow)`, where `shadow` is a `PlainState` object maintained by the substrate (see [§The functional shadow](../../TECHNICAL.md#the-functional-shadow)). `resolveContainer` remains essential for four purposes: `materializeLoroShadow` (the materializer that builds the shadow itself), `nativeResolver` (escape hatch to raw Loro containers), `positionResolver` (cursor operations that require CRDT structure), and `changeToDiff` (translating kyneta `Change` values into Loro `Diff[]` during the write path).

The predecessor design held a static container map built at `bind()`. It broke three ways:

- **Structural inserts move indices.** An insert at `items[0]` invalidates every cached `items[1..]` reference.
- **External mutations don't update the cache.** `doc.import(update)` can create, delete, or re-parent containers outside kyneta's write path.
- **Map keys are unbounded.** A precomputed map would need to be rebuilt on every key mutation.

Live navigation pays a small cost per access (one container lookup per segment) but has no invalidation burden and is transparent to any source of mutation. Memoization happens at the **interpreter-stack** level (`withCaching` from `@kyneta/schema`), not the substrate level — and that cache invalidates on every kyneta-observed change via the changefeed pipeline.

### What live navigation is NOT

- **Not a proxy.** No ES6 `Proxy`, no intercepted property access. Every ref method calls `resolveContainer` explicitly.
- **Not a static map.** Nothing is precomputed at `bind()` time beyond the schema binding (an identity hash lookup table).
- **Not memoized at the substrate level.** Caching is an interpreter-stack concern.

---

## The `_props` container

Source: `packages/schema/backends/loro/src/loro-resolve.ts` → `PROPS_KEY`, `stepFromDoc`.

Loro exposes typed root container accessors (`doc.getText`, `doc.getMap`, `doc.getCounter`, etc.) but has no "bare scalar" at the root — every top-level entity must be a container. For a root-level `Schema.string()` or `Schema.number()` field, creating a container would be wasteful and semantically wrong.

**Solution**: one reserved root `LoroMap` named `"_props"` holds every non-container scalar and sum field.

```
doc.getText(identityHash("title"))       // text field → its own LoroText
doc.getMap(identityHash("settings"))     // product field → its own LoroMap
doc.getMap(PROPS_KEY).get(identityHash("userName"))   // scalar field → _props map entry
```

`PROPS_KEY` is a reserved identifier. Applications cannot use `"_props"` as a schema field name — the identity hash for any user-facing field will never collide (hashes are 128-bit FNV-1a, `"_props"` is a literal string).

**Note:** Root-level scalar and sum fields in `_props` are no longer eagerly initialized with structural zeros. The materializer's zero fallback produces the correct default on read. `_props` itself is still lazily created by `doc.getMap(PROPS_KEY)` in `resolveContainer`, but scalar values are only written when explicitly set by user code.

### What `_props` is NOT

- **Not a global kitchen sink.** It only holds *root-level* scalar/sum fields. Nested scalars live inside their parent's own `LoroMap` or struct container.
- **Not user-visible.** The key is internal; the user writes `doc.userName.set("alice")` and the substrate resolves to `doc.getMap(PROPS_KEY).set(identityHash("userName"), "alice")`.
- **Not a migration concern.** Adding a new scalar field creates a new entry in `_props`; the old ones stay untouched.

---

## Identity-keyed containers

Source: `packages/schema/backends/loro/src/loro-resolve.ts` (accepts `SchemaBinding`), `src/substrate.ts` (`deriveSchemaBinding` + `ensureLoroContainers`).

Every product-field boundary keys its Loro container by the field's **identity hash** from the `SchemaBinding`, not by the field's display name.

| Schema field | Old (name-keyed) | Current (identity-keyed) |
|--------------|------------------|--------------------------|
| `doc.title` | `doc.getText("title")` | `doc.getText("7a3f9b1c…")` |
| `doc.settings.darkMode` | `doc.getMap("settings").get("darkMode")` | `doc.getMap("4e8d2a…").get("9b1c3a…")` |

This is what makes cross-schema-version sync work. If schema v1 renames `title → heading`, v2's binding maps `heading` to the same identity hash that v1 mapped `title` to. Both versions address the same Loro container; the display name is an interpreter-level concern that never reaches the substrate.

The identity hash is 128-bit FNV-1a-128 (from `@kyneta/schema`'s `hash.ts`) over `originPath + ":" + generation` — deterministic, content-addressed, unique per schema evolution step.

### `ensureLoroContainers` — conditional creation

On substrate construction (`loroSubstrateFactory.upgrade(replica, schema)`), the factory walks the schema and ensures every non-`_props` field has a container. The walk is **conditional**:

- If `doc.getMap(identityHash("settings"))` returns an empty map (no ops yet), create it with the field's `Zero` default.
- If the map already has entries (hydrated from storage or a merge), leave it alone — structure is preserved.

This is why hydration from stored state and fresh document creation both land in the same code path, and why adding a new field to an existing schema doesn't clobber the data on peers that already have a container for the old fields.

**Note:** Only Loro containers (Map, Text, List, Counter, Tree, MovableList) are created during the walk — scalar and sum fields are no longer written during container creation. The `case "scalar"` / `case "sum"` branches in `ensureLoroContainers` are explicit no-ops to preserve switch exhaustiveness.

### What identity-keying is NOT

- **Not a hash of the field value.** It is a hash of the field's origin — `(path, generation)` — derived from the migration chain. The same field has the same identity hash across every document that uses the schema.
- **Not user-visible.** `unwrap(doc.title)` returns a `LoroText`; the key isn't part of the surface.
- **Not reversible in the app layer.** The `SchemaBinding.backward` map reverses hash → path *for one specific schema version*. Applications don't use it directly.

---

## Container discrimination across the WASM boundary

Source: `packages/schema/backends/loro/src/loro-guards.ts` → `hasKind`, `isLoroContainer`, `isLoroDoc`.

Loro container instances are **WASM-backed**. They cross a boundary where `instanceof` checks are unreliable: two modules may share the same container object but see different class constructors (one for each wrapper build). The kyneta codebase therefore never uses `instanceof LoroText`. It uses:

```
if (hasKind(c) && c.kind() === "Text") { ... }
```

`hasKind(c)` is a structural type guard that asserts `c` has a `.kind()` method. `.kind()` returns one of Loro's own discriminant strings (`"Text"`, `"Map"`, `"List"`, `"MovableList"`, `"Counter"`, `"Tree"`). This is safe across the WASM boundary because it depends only on the presence of a method, not on a JS class identity.

### What `.kind()` discrimination is NOT

- **Not a substitute for TypeScript typing.** The Loro types from `loro-crdt` are precise; `hasKind` is the runtime check for when we've lost the type (e.g., reading from `.get()` which returns `unknown`).
- **Not Kyneta-specific.** Loro itself exports `.kind()` as a stable API. We consume it.
- **Not cheap at scale.** It is a method call. For hot paths, the dispatch happens once per resolution step, not per-value access.

---

## The write path

Source: `packages/schema/backends/loro/src/substrate.ts` → `LoroSubstrate.prepare` / `afterBatch` / `runBatch`; `src/change-mapping.ts` → `changeToDiff`.

```
batch(doc, d => { d.title.insert(0, "hi"); d.items.push(x) })
  │
  ├─ runBatch opens its commit bracket (depth 0→1)
  │
  ├─ prepare phase (per mutation, applies to both σ and λ EAGERLY):
  │    1. applyChange(shadow, path, change)        ── σ advances
  │    2. findOpaqueBoundary(path) ─► boundary?
  │       ├─ yes: stage the full σ-snapshot at the boundary key
  │       │       (MapDiff for map parents, ListDiff replace for list
  │       │       parents) in the per-CID coalescing buffer
  │       └─ no:  a record clear? → flushBuffer() first
  │               changeToDiff(...) ─► [ContainerID, Diff][]
  │                ├─ single MapDiff, no JsonCID refs → coalesce
  │                │   into buffer (merge `updated` by spread)
  │                ├─ structural insert (multi-tuple, or single tuple
  │                │   with 🦜:JsonContainerID) → flushBuffer() then
  │                │   doc.applyDiff(group) immediately
  │                └─ other (text / counter / non-structural seq) →
  │                    doc.applyDiff(group) immediately
  │
  ├─ seal phase (afterBatch, at the depth 1→0 release):
  │    flushCoalesceBuffer() — apply each buffered MapDiff via
  │    doc.applyDiff([[cid, {type:"map", updated}]])
  │
  ├─ runBatch finally:
  │    capture = "closing"
  │    └─ doc.commit({ origin }) ── one commit per outermost batch(), also
  │                       when the body threw; fires one doc.subscribe
  │                       batch for the whole logical action
  │    capture = "off"
  │
  └─ after the commit: the sealed changeset is delivered. A batch() a
       subscriber issues is its own outermost block and its own commit.
```

The write path advances **both** σ (the shadow) and λ (the LoroDoc tree) at every prepare boundary. PlainSubstrate has σ ≡ λ; CRDT substrates generalise to the two-store product where `applyDiff` is called eagerly inside `prepare` (immediately for structural inserts, via the coalescing buffer for plain MapDiff writes that drain in `afterBatch`). The projection law `σ ≡ Π(λ)` (the naturality condition of `materializeLoroShadow`) is preserved at every prepare return. It is pinned by `projectionConformance` (`@kyneta/schema/testing`), run from `src/__tests__/eager-write-coherence.test.ts`, which compares the substrate's shadow against a fresh `materializeLoroShadow` after each write.

`changeToDiff` is **pure** (source: `src/change-mapping.ts`). Given a kyneta `Change` + path + schema + binding, it produces the Loro `Diff[]` that reproduces the change. It handles every built-in change type:

| kyneta `Change.type` | Loro diff |
|-----------------------|-----------|
| `"text"` | `TextDiff` with retain/insert/delete runs |
| `"sequence"` | `ListDiff` with splice ops |
| `"map"` | `MapDiff` with `updated` record |
| `"tree"` | `TreeDiff` with move/delete; **create items are filtered** because `TREE_NODE_ALLOCATE` calls `LoroTree.createNode(parent, index)` during prepare to mint a peer-stamped `TreeID` and position the node natively. Per-node data dispatches as `MapDiff` against `node.data` (the per-node `LoroMap`), not against the parent `LoroTree`. See [Tree write path](#tree-write-path) below. |
| `"replace"` | Container-level replacement (varies by kind) |
| `"increment"` | `CounterDiff` with delta |

Non-replace change types can and do originate at sum paths, and the claim previously made here — that they cannot, because sum variants are constrained to `PlainSchema` — was wrong. `Schema.list(...).nullable()` is a plain sequence inside a sum, so `d.maybeList.push(x)` produces a `SequenceChange` targeting the sum itself; `Schema.record(...).nullable()` does the same with a `MapChange`. Both used to reach the direct write path and look for a Loro container that was never created, because a sum is stored as one plain value.

These are now routed through `findOpaqueBoundary` like any other boundary write, and widened into a whole-value write of the variant. `stepSchema`'s "cannot advance through a sum" mismatch is unreachable from any traversal, but that is because `walkPath` stops at the boundary — not because such paths do not arise.

**Whole-value materialization is shared.** When a change carries a structured value (a struct written into a record entry, a struct pushed onto a list, or a whole-struct `.set({...})`), the value is turned into an identity-keyed container tree by the shared `materializeValue` unfold (`@kyneta/schema/src/materialize-value.ts` — the write-side counterpart to `foldPath`), then realized into `applyDiff` tuples by `realizeLoro` (`src/change-mapping.ts`, pre-order: parent map/list diff before descendants; synthetic `cid:` ContainerIDs minted only here, keeping `materializeValue` pure). The former `materializeValueDiffs` / `materializeCIDForSchema` / `needsContainer` / `kindToContainerType` helpers are gone. `replaceChangeToDiff` sets a **container** field's contents on the field's own container (a root-level container cannot be swapped; nested ones are reused in place) and only stores a **plain** scalar/sum value in the parent `_props`/map.

> **Invariant (jj:vlnkqyvq).** A container field's whole-value replace sets that container's own contents through `realizeLoro`, and both `replaceChangeToDiff` and `mapChangeToDiff` key product fields through the single `containerKey` producer — so structured writes land under the identity hashes the reader resolves and converge to peers. The subtlety this guards: storing the struct as an opaque plain blob (or keying its fields literally) in the parent is invisible to the identity-keyed reader. `src/__tests__/struct-replace-convergence.test.ts` guards it.

### The coalescing buffer

When a transaction mutates multiple fields of the same struct (`d.settings.a.set(1); d.settings.b.set(2)`), each prepare produces a single-tuple `[ContainerID, MapDiff]` group with one key in `updated`. The per-CID coalescing buffer merges these via spread so all sibling-key writes flush as a single `doc.applyDiff([[cid, {type:"map", updated:{...}}]])` in `afterBatch`. Last-write-wins per key. Multi-tuple structural inserts (which carry `🦜:JsonContainerID` references that must stay intact for CID resolution) force-flush the buffer first and then apply immediately — never coalesce.

A record clear force-flushes the buffer too, before its diff is computed. A `MapChange` with `clear` removes the keys the container holds when it is applied (`mapChangeEffects` expanded against `LoroMap.keys()`), which is Loro's own observed-remove. A key written earlier in the same batch is still in the buffer rather than the container, so without the flush the clear would miss it, and the coalesced diff would keep a key σ removed. `projectionConformance` pins it: "record set, cleared and set again in one batch" fails without the flush.

The buffer ALSO handles `struct.json` / `list.json` / `record.json` boundary writes: any write into a json subtree stages the full σ snapshot at the boundary segment in the parent CRDT container, instead of generating per-leaf diffs that would have to navigate non-existent nested CRDT containers. Map-shaped parents coalesce with sibling writes; list-shaped parents force-flush and apply a list-replace immediately (ListDiffs are positional, not key-addressed).

### Tree write path

`Schema.tree` is the one CRDT kind where the kyneta and Loro write paths can't share a uniform `Change → Diff` translation. The substrate splits responsibility:

- **Topology (create-then-position).** The `TREE_NODE_ALLOCATE` capability hook calls `LoroTree.createNode(parent, index)` during `prepare`, before any diff dispatches. The peer-stamped `TreeID` (`${counter}@${peerID}`) is returned synchronously so the kyneta interpreter can record it in the `TreeChange.create` instruction. Loro's native call positions the node fully (parent + index) in one shot — no follow-up move.
- **`create` diff items are filtered.** `treeChangeToDiff` checks `tree.getNodeByID(target)` against the live tree. If the node already exists (the local-prepare case, after `TREE_NODE_ALLOCATE`), the create item is dropped — re-applying `create` against an extant `TreeID` panics Loro's WASM with a locking-order violation in `handler.rs:236`. `move` and `delete` items pass through unchanged.
- **Per-node data writes target `node.data`'s CID.** When `d.tree.create({ data })` is called, the interpreter emits a `MapChange` at `path.node(id)`. `stepFromContainer`'s Tree case steps into `node.data` (a `LoroMap`), so `changeToDiff` resolves to the per-node map's `ContainerID` — not the parent `LoroTree`'s CID, which would be rejected by Loro.

**Substrate-semantics consequence: tree topology does not travel through `applyChanges`.** Peer replay via kyneta's `Op` vocabulary is broken for tree creates by construction: a remote `TreeChange.create` instruction names a `TreeID` minted by another peer, and `applyDiff` rejects foreign `TreeID`s. Tree mutations replicate through Loro's **binary sync** (`exportSince` / `merge` / `doc.import`), which carries the native CRDT ops with peer attribution. Subsequent `move` / `delete` on a peer that has imported the binary sync work normally (the node already exists locally).

In practice: use `exportEntirety` / `exportSince` + `merge` for replication. The Loro substrate's event bridge translates incoming binary updates into kyneta `Op` events via `batchToOps`, so subscribers still see `TreeChange` deliveries for remote mutations — but the inbound path is binary, not Op-replay.

Subscriber semantics (topology fan-out, per-node forwarders, terminal-on-delete) are substrate-agnostic and live in the schema-layer interpreter transformer. See `packages/schema/TECHNICAL.md` §Tree-observable changefeeds (§Dynamic-collection changefeed factories, §Terminal-on-delete).

### Nested-commit semantics under re-entry

Under the three-primitive substrate contract (jj:ryquprut), the Loro substrate no longer carries its own depth counter — ctx-level outermost detection (`frameStarts.length === 0`) handles invocation timing. The substrate `runBatch` is the minimal shape:

```ts
runBatch(work, options) {
  capture = "open"
  try {
    try {
      work()
    } finally {
      capture = "closing"
      doc.commit(options.origin !== undefined ? { origin: options.origin } : undefined)
    }
  } finally {
    capture = "off"
  }
}
```

The ctx-level `WritableContext.runBatch` invokes `substrate.runBatch` only at the depth-0 transition. Within a single outermost `batch(doc, fn)`, the substrate sees exactly one bracket: prepares, then `afterBatch`, then `doc.commit`. Inner ctx-level frames (nested `batch()` inside `batch()`'s `fn`) push/pop without re-entering substrate.runBatch — they just contribute prepares to the outer's pending applyDiff queue.

**The commit runs in a `finally`.** When `work()` throws, the bracket has already applied the block's compensations, which net to zero but are pending ops. Left uncommitted they would join the next commit, under the next batch's origin.

**Subscriber re-entry produces a separate outermost commit.** Changesets are delivered after the commit closes (`packages/schema/TECHNICAL.md` §"The batch lifecycle"), so a `batch()` a subscriber issues opens its own outermost bracket — its own substrate.runBatch → its own `doc.commit()`, carrying its own origin and only its own ops. Each block is its own atomic abort unit. This replaced the pre-jj:ryquprut depth-counter design, which collapsed re-entries into one commit; one commit per `batch()` block is chattier Loro commit attribution, with cleaner per-block abort semantics. `src/__tests__/delivery-after-commit.test.ts` pins the origins and contents.

### Load-bearing Loro invariants

`doc.applyDiff(group)` does NOT fire `doc.subscribe` events; only `doc.commit()` does. This is what lets the substrate apply diffs throughout `prepare` without emitting intermediate events — only the outermost `runBatch` release commits and emits the single batched event. If a future Loro version were to fire subscribe events on `applyDiff`, the eager-prepare model would need per-prepare suppression flags or a different structure. Flag this invariant explicitly so any future Loro upgrade triggers a review of this assumption.

**`loro-crdt >= 1.13.4`, and the peer range says so.** Through `1.13.3`, building the event for a commit that changed *k* map keys was O(k²) — but only when a subscriber was attached, which for this substrate is always: the event bridge registers one at construction. Lists were unaffected, and the map's existing size was irrelevant; the cost was in the number of keys touched by a single commit. Filling a record with 8 000 entries in one batch cost ~1 100 ms of wasm time on `1.13.3` and ~17 ms on `1.13.4`. The floor is a peer *dependency* rather than a note because nothing in this package's behaviour reveals the difference — a consumer on an older Loro gets a quadratic write path and no signal.

### What the write path is NOT

- **Not a streaming write.** Each transaction is at most a handful of `applyDiff` calls (structural inserts apply immediately; plain MapDiffs coalesce into one per container per batch).
- **Not transactional in Loro's sense.** Loro has its own transaction semantics; kyneta's `batch(doc, fn)` is an interpreter-stack transaction that commits a bundle of Loro writes atomically *from kyneta's perspective*. Loro ops can still interleave concurrently with other peers.
- **Not reversible from the substrate.** There is no undo buffer in the substrate. Undo is an application concern.

---

## The event bridge

Source: `packages/schema/backends/loro/src/substrate.ts` → `doc.subscribe` handler.

The persistent `doc.subscribe()` callback is the enforcement mechanism for the key invariant: *every* mutation to the underlying `LoroDoc` fires the kyneta changefeed, regardless of source. Mutation sources include:

- Local kyneta writes via `batch(doc, fn)` — suppressed by the pre-commit-hook discriminator (we already notified).
- `substrate.merge(payload)` with a peer's update — announced with `local: false`.
- `doc.import(update)` from application code directly — announced with `local: false`.
- Raw Loro API writes (`doc.getText(key).insert(0, "x")`) bypassing kyneta, such as an editor binding's (loro-prosemirror) — announced with `local: true`, so subscribers receive them with `replay: false`.

A write to a root container the schema does not declare raises no changeset, since the schema has no place for it. It is still pushed and persisted, through `subscribeLocalUpdates`.

A raw write nobody commits stays pending, and fires nothing until something commits it: an `export` or an `import` does so implicitly. `substrate.commitPending()` commits it on demand, when `getPendingTxnLength() > 0`; the commit is a native local commit like any other, so the handler below announces it and `subscribeLocalUpdates` fires. `@kyneta/exchange` calls it before every export, to peers and to a store, so a pending write is held back until the store has confirmed it rather than sent by the export that commits it.

The handler:

1. If `batch.by === "local"` and matches an entry in `ourCommits` (via `delete`-as-predicate) → skip (we already notified during `prepare`).
2. Skip `batch.by === "checkout"` events — version travel, not mutations.
3. Call `batchToOps(event.diffs, schema, binding)` → pure conversion from Loro `Diff[]` to kyneta `Op[]`.
4. Re-materialize the shadow from the LoroDoc (`syncShadow(shadow, materializeLoroShadow(...))`), which already holds these changes.
5. `ctx.announce(ops, { origin, local: batch.by === "local" })`. The announcement never reaches `substrate.prepare` or `afterBatch`, and subscribers receive it with `replay: !local`. `loro-crdt` has no import-with-origin, so `merge` stashes its `options.origin` while it imports; the stash applies to `import` batches only. `import` implicitly commits pending local ops first, and that commit is a local batch with its own origin, not the merge's.

### Why the pre-commit hook

Loro fires `doc.subscribe` events synchronously inside `doc.commit()`, with nested events from re-entrant commits queued and drained after the current handler exits but still inside the outer commit call.

The pre-commit hook (`subscribePreCommit`) provides a race-free, re-entrancy-safe discriminator. It fires synchronously for *every* commit (including raw external ones), and records the commit's identity while `capture` is not `"off"`:

- `runBatch` sets `"open"` before `work()`. Any commit inside the body is ours: an `export` or `import` in a `batch()` body commits the pending Kyneta ops implicitly, and there may be several.
- It sets `"closing"` just before its final `doc.commit()`, whose pre-commit returns `capture` to `"off"`. Commits that raw listeners make while reacting to our commit happen after that pre-commit, so they are announced.
- An empty final commit fires no pre-commit, so `runBatch`'s `finally` returns `capture` to `"off"`.

The captured identity `(peer, counter+length-1)` is intrinsic to the commit and travels via the queued subscribe event's `batch.to` vector, allowing the subscribe handler to match and consume it.

Three properties this gives us:
1. `batch.origin` is preserved as a transparent pass-through for `options.origin`.
2. The persistent `message` slot is untouched.
3. Round-trip integrity is preserved.

### Known limitation: mixed mode

Mixing raw CRDT mutations with `batch()` calls inside the same atomic unit (such as Loro pending ops accumulated before a kyneta-issued commit) is unsupported. The raw mutations will be silently absorbed into kyneta's own-commit skip and not bridged to the kyneta changefeed, so σ misses them. They are still pushed and persisted: the local-update signal covers the whole commit. To intermix, use separate commits for raw mutations. This is a fundamental limit of commit-level discrimination.

The earlier `inEventHandler` flag (which protected substrate-write skipping during event-bridge replay) was retired in favor of a per-batch parameter, now `ingress`: a bridge batch is an announcement and never reaches the substrate's `prepare`/`afterBatch`, while a re-entrant `batch(doc, ...)` from inside a subscriber is an ordinary authored batch and lands in the substrate. An ambient global swallowed that write. Context: jj:qpultxsw.

Before announcing, the bridge re-materialises the `PlainState` shadow from the `LoroDoc` via `materializeLoroShadow` (using the shared `syncShadow` helper from `@kyneta/schema`'s `reader`), so `ctx.reader` — which reads through `plainReader(shadow)` — already reflects the merged CRDT state when any subscriber runs. The bridge is the only place that re-materialises; on local writes σ tracks each prepare incrementally.

**Note:** `materializeLoroShadow` now uses the generic `createMaterializeInterpreter` from `@kyneta/schema` core with a Loro-specific `MaterializeResolver` (created by `createLoroResolver`), rather than defining a bespoke 370-line `loroMaterializeInterpreter`. The resolver (~50 lines) handles only CRDT-specific value extraction; all structural recursion and zero fallback is handled by the generic interpreter.

### What the event bridge is NOT

- **Not a polling loop.** `doc.subscribe()` is Loro's own push-based event API.
- **Not ordered against the event loop.** Loro emits events synchronously from the call site that caused them. The bridge fires in whatever JavaScript microtask / stack frame Loro used.
- **Not filtered.** Every diff Loro emits reaches `batchToOps`; filtering happens at the interpreter-stack subscription level.

---

## `LoroVersion`

Source: `packages/schema/backends/loro/src/version.ts`.

`LoroVersion` implements `@kyneta/schema`'s `Version` by wrapping Loro's `VersionVector`:

| Method | Delegates to |
|--------|--------------|
| `serialize()` | `uint8ArrayToBase64(vv.encode())` — base64 for text-safe embedding |
| `compare(other)` | `vv.compare(other.vv)` mapped to `"behind" \| "equal" \| "ahead" \| "concurrent"` |
| `meet(other)` | Component-wise minimum via `versionVectorMeet` from `@kyneta/schema` |
| `LoroVersion.parse(str)` | `VersionVector.decode(base64ToUint8Array(str))` |

The choice of `VersionVector` (not `Frontiers`) is deliberate: `VersionVector` tracks the *complete* peer state — which ops from each peer have been observed. This is exactly what `exportSince(version)` needs. `Frontiers` are DAG leaf ops, used for local checkpoints but insufficient for sync diffing.

### What `LoroVersion` is NOT

- **Not `Frontiers`.** Loro's `Frontiers` and `VersionVector` are different concepts. This package uses the latter.
- **Not a wall-clock timestamp.** Loro version vectors are CRDT causal history, not physical time.
- **Not totally ordered.** Two concurrent peers' versions can be mutually `"concurrent"`. `compare` returns the full partial order.

---

## `advance`: the replica trims, the live substrate does not

Source: `src/substrate.ts` → `advance` on `createLoroSubstrate` and `createLoroReplica`.

Both follow `planAdvance` from `@kyneta/schema`, and throw only for a target beyond the current version. A relay's replica trims to a shallow snapshot at the target's frontiers; its `baseVersion()` is then `shallowSinceVV()`, at or just behind the target. A target behind or concurrent with the base cannot be placed, and trims nothing. A live substrate never trims: importing a shallow snapshot means a new `LoroDoc`, and editor bindings and `unwrap` callers hold its containers. Its `baseVersion()` is `shallowSinceVV()` of the document it holds, which is shallow only if it loaded a shallow snapshot. Compacting a live document still replaces its storage with the whole document.

---

## `LoroPosition`

Source: `packages/schema/backends/loro/src/position.ts`.

Loro has a first-class `Cursor` type that survives concurrent edits by anchoring to an op ID, not an index. `LoroPosition` wraps it:

```
class LoroPosition implements Position {
  constructor(private cursor: Cursor, private container: LoroText | LoroList | LoroMovableList) {}

  resolve(): number {
    return this.container.getCursorPos(this.cursor).offset
  }

  transform(change: Change): void {
    // no-op — resolution queries the CRDT directly
  }
}
```

`resolve()` asks Loro for the cursor's current index. `transform()` is a no-op because Loro maintains the mapping internally; we don't need the position to track incoming changes explicitly.

`fromLoroSide` / `toLoroSide` translate between kyneta's `Side = "left" | "right"` and Loro's own boundary-bias enum.

### What `LoroPosition` is NOT

- **Not a numeric index.** `resolve()` returns one, but the underlying cursor is anchored to a Loro op ID and survives edits that would shift any raw index.
- **Not stateful on the kyneta side.** All state lives in Loro. `transform` does nothing by design.
- **Not serializable directly.** Loro `Cursor` is not a public serialisable type; applications that need to persist positions across sessions must store them at the Loro layer.

---

## `loro.bind` and `loro.replica`

Source: `packages/schema/backends/loro/src/bind-loro.ts`.

`loro` is a `BindingTarget<LoroLaws, LoroNativeMap>` — a fixed bundle of `(factory, syncMode, allowedLaws)` built via `createBindingTarget` from `@kyneta/schema`. The ergonomic API:

```
import { loro } from "@kyneta/loro-schema"
import { Schema } from "@kyneta/schema"

const Todo = loro.bind(Schema.struct({
  title: Schema.text(),
  items: Schema.list(Schema.struct({ body: Schema.text(), done: Schema.boolean() })),
}))
```

`loro.bind(schema)` returns a `BoundSchema<S, LoroNativeMap>`. Under the hood it delegates to `@kyneta/schema`'s `bind({ schema, factory: loroFactoryBuilder, syncMode: SYNC_COLLABORATIVE })`. The `LoroLaws` set (`"lww" | "additive" | "positional-ot" | "positional-ot-move" | "lww-per-key" | "tree-move" | "lww-tag-replaced"`) is applied as `RestrictLaws<S, LoroLaws>`, so binding a schema that requires a composition law Loro doesn't support (e.g. `"add-wins-per-key"` from `Schema.set()`) fails at compile time.

**`Schema.set` is not supported by Loro.** The `case "set"` and `case "set-op"` branches in `change-mapping.ts` are unreachable from any bound Loro substrate (set schemas fail at compile time via the law restriction above). They are kept as explicit throws for defense-in-depth and as a clear extension point should `"add-wins-per-key"` ever be added to `LoroLaws`. See [§Set: value-addressed leaf](../../TECHNICAL.md#set-value-addressed-leaf) for the kyneta-level set semantics.

`loro.replica()` produces a `BoundReplica<LoroVersion>` — the replication-only variant for sync conduits that don't need to interpret state.

### What `loro.bind` is NOT

- **Not a factory.** It returns a `BoundSchema`, not a substrate. The substrate is constructed by `createDoc(bound)` at runtime.
- **Not asynchronous.** Fully synchronous; the schema and the Loro factory builder are captured at call time.
- **Not overridable.** The sync mode for `loro` is always `SYNC_COLLABORATIVE`. For different sync semantics, use `@kyneta/schema`'s lower-level `bind()` directly.

## `PeerID` width

Source: `src/bind-loro.ts` → `loroPeerId`.

A peer's `PeerID` is `loroPeerId(peerId)`, which is `peerNumber(peerId, 64)` from `@kyneta/schema` as a decimal string. Loro's `PeerID` is a u64, passed to `setPeerId` as a numeric string, and it round-trips through `export`, `import` and `oplogVersion()` at the full width, so nothing is gained by narrowing it to 53 bits. Two peer ids that share a `PeerID` write different operations at the same `(peer, counter)` addresses on every document they both touch, and a merge keeps only one of each pair. `src/__tests__/wide-peer-id.test.ts` checks a `PeerID` above 2⁵³ through updates and `LoroVersion`.

The low 53 bits of the `PeerID` are the same peer id's Yjs `clientID` (`yjsClientId` in `@kyneta/yjs-schema`); see §"Peer identity and when a substrate may claim it" in `packages/schema/TECHNICAL.md`.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `loro` | `src/bind-loro.ts` | The binding target: `.bind(schema)`, `.replica()`. |
| `loroPeerId` | `src/bind-loro.ts` | A peer id's `PeerID`: `peerNumber(peerId, 64)` as a decimal string. See [`PeerID` width](#peerid-width). |
| `LoroLaws` | `src/bind-loro.ts` | `"lww" \| "additive" \| "positional-ot" \| "positional-ot-move" \| "lww-per-key" \| "tree-move" \| "lww-tag-replaced"`. |
| `LoroNativeMap` | `src/native-map.ts` | The `NativeMap` functor for Loro. |
| `LoroVersion` | `src/version.ts` | `Version` over `VersionVector`. |
| `LoroPosition` | `src/position.ts` | `Position` over Loro `Cursor`. |
| `loroSubstrateFactory` / `loroReplicaFactory` | `src/substrate.ts` | Factory instances. |
| `createLoroSubstrate` | `src/substrate.ts` | Construct a `Substrate<LoroVersion>` from a `LoroDoc` and schema. |
| `loroReader` | `src/reader.ts` | `Reader` via live container navigation. |
| `resolveContainer` / `stepIntoLoro` | `src/loro-resolve.ts` | The navigation primitives. |
| `PROPS_KEY` | `src/loro-resolve.ts` | `"_props"` — reserved root map for scalars. |
| `changeToDiff` / `batchToOps` | `src/change-mapping.ts` | Pure translators between kyneta and Loro vocabularies. |
| `hasKind` / `isLoroContainer` / `isLoroDoc` | `src/loro-guards.ts` | Runtime container guards using `.kind()`. |
| `fromLoroSide` / `toLoroSide` | `src/position.ts` | `Side` conversions. |

## File Map

| File | Role |
|------|------|
| `src/index.ts` | Public barrel. Re-exports generic API from `@kyneta/schema`; exports Loro-specific symbols. |
| `src/bind-loro.ts` | `loro.bind` / `loro.replica` binding target; `LoroLaws`; `loroPeerId`. |
| `src/substrate.ts` | `LoroSubstrate`, factories, prepare/flush, event bridge, `ensureLoroContainers`, `mergePendingGroups`. |
| `src/change-mapping.ts` | Pure `changeToDiff` + `batchToOps` for every kyneta change type and every Loro container kind. |
| `src/loro-resolve.ts` | `stepIntoLoro`, `stepFromDoc`, `PROPS_KEY`; `resolveContainer` is a thin wrapper over the core `foldPath` primitive. |
| `src/reader.ts` | `loroReader` — reads via `resolveContainer` + container-kind extraction. |
| `src/loro-guards.ts` | `hasKind` / `isLoroContainer` / `isLoroDoc` runtime guards. |
| `src/version.ts` | `LoroVersion` (wraps `VersionVector`). |
| `src/position.ts` | `LoroPosition` (wraps `Cursor`), `fromLoroSide`, `toLoroSide`. |
| `src/native-map.ts` | `LoroNativeMap` type-level functor. |
| `src/__tests__/create.test.ts` | End-to-end: `createDoc(loro.bind(schema))` → read/write round-trips. |
| `src/__tests__/substrate.test.ts` | Substrate contract conformance (subset of the `@kyneta/schema` suite). |
| `src/__tests__/reader.test.ts` | `loroReader` over every container kind + scalar variants. |
| `src/__tests__/record-counter-spike.test.ts` | Focus tests for `Schema.record(Schema.counter())` and related combinations. |
| `src/__tests__/structural-merge.test.ts` | `merge()` and `applyDiff` round-trips; identity-keyed container compatibility. |
| `src/__tests__/position.test.ts` | `LoroPosition` cursor stability across concurrent edits. |
| `src/__tests__/bind-constraints.test.ts` | Compile-time composition-law enforcement (schemas outside `LoroLaws` are rejected). |
| `src/__tests__/bind-loro.test.ts` | `loro.bind` API surface. |
| `src/__tests__/wide-peer-id.test.ts` | A `PeerID` above 2⁵³ round-trips through updates and versions. |
| `src/__tests__/native.test.ts` | `unwrap(ref)` returns the right native container at every depth. |
| `src/__tests__/loro-guards.test.ts` | `hasKind`, `isLoroContainer`, `isLoroDoc` runtime behaviour. |
| `src/__tests__/version.test.ts` | `LoroVersion` serialize/parse, `compare`, `meet` algebraic properties. |

## Testing

Tests use real `LoroDoc` instances from `loro-crdt` — no mocks. Two-peer scenarios simulate collaborative editing by constructing two `LoroDoc`s, mutating them independently, and merging via `exportSince` + `merge`. The substrate contract suite from `@kyneta/schema` is replayed against `loroSubstrateFactory` for conformance.

Run with `cd packages/schema/backends/loro && pnpm exec vitest run`.

## `richtext` support

`richtext` uses the same `LoroText` container as `text`. The difference is in how change-mapping preserves mark attributes:

- **Outbound** (`richTextChangeToDiff`): `format(N, marks)` → `{ retain: N, attributes: marks }`. `insert(text, marks)` → `{ insert: text, attributes: marks }`.
- **Inbound** (`richTextDiffToChange`): `{ retain: N, attributes }` → `{ format: N, marks: attributes }`. Discriminates `retain` vs `format` by the presence of `attributes`.

`configTextStyle()` is called once during `ensureLoroContainers` with the merged `MarkConfig` from all richtext fields in the schema. Conflicting expand values for the same mark name are caught at bind time.

The `resolveContainer` function returns `{ container, schema }` — this enables the reader to dispatch `LoroText` → `.toString()` (text) vs `.toDelta()` (richtext) based on the schema kind.