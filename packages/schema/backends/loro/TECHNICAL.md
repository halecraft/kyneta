# @kyneta/loro-schema — Technical Reference

> **Package**: `@kyneta/loro-schema`
> **Role**: Loro CRDT substrate for `@kyneta/schema`. Wraps a `LoroDoc` as a `Substrate<LoroVersion>` with schema-guided live navigation, `applyDiff`-based writes, identity-keyed containers for cross-schema sync, and a persistent event bridge so every mutation — local kyneta writes, `merge()`, `doc.import()`, or raw Loro API — fires the kyneta changefeed.
> **Depends on**: `@kyneta/schema` (peer), `@kyneta/changefeed` (peer), `loro-crdt` (peer)
> **Depended on by**: `@kyneta/exchange` (dev), `@kyneta/react` (dev), `@kyneta/cast` (dev), application code that wants collaborative documents
> **Canonical symbols**: `loro` (binding target: `loro.bind`, `loro.replica`), `LoroLaws`, `LoroNativeMap`, `createLoroSubstrate`, `loroSubstrateFactory`, `loroReplicaFactory`, `LoroVersion`, `LoroPosition`, `loroReader`, `resolveContainer`, `stepIntoLoro`, `PROPS_KEY`, `changeToDiff`, `batchToOps`, `hasKind`, `isLoroContainer`, `isLoroDoc`, `fromLoroSide`, `toLoroSide`
> **Key invariant(s)**: Subscribing to the kyneta doc observes **every** mutation to the underlying `LoroDoc`, regardless of source — local writes, `merge()`, `doc.import()`, or raw Loro API calls. The persistent `doc.subscribe()` event bridge is the enforcement mechanism; two re-entrancy guards (`inOurCommit`, `inEventHandler`) prevent double-notification.

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

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `LoroDoc` | Loro's top-level document handle (from `loro-crdt`). Owns peers, operations, version vector. | A kyneta `DocRef` — the `LoroDoc` is the substrate-native backing; `DocRef` is the interpreter-stack handle |
| `LoroLaws` | The composition-law set `"lww" \| "additive" \| "positional-ot" \| "positional-ot-move" \| "lww-per-key" \| "tree-move" \| "lww-tag-replaced"`. The algebraic merge properties Loro faithfully implements. | Loro's own feature set — this is the subset kyneta exposes via law tags |
| `LoroNativeMap` | The `NativeMap` functor mapping schema kinds to Loro container types (`text → LoroText`, `list → LoroList`, `struct → LoroMap`, etc.). | A JS `Map` — this is a type-level functor, not a runtime object |
| `LoroVersion` | `@kyneta/schema`'s `Version` implementation wrapping Loro's `VersionVector`. | Loro's `Frontiers` (DAG leaf ops for checkpoints) — `VersionVector` is the full peer-state vector used for sync diffing |
| `LoroPosition` | `Position` implementation wrapping Loro's `Cursor`. Stateless `transform` — resolution queries the CRDT directly. | A numeric index |
| `resolveContainer` | Pure left-fold over path segments accumulating `(currentContainer, currentSchema)`. The navigation primitive for every read. | A cache lookup — resolution happens on every read |
| `stepIntoLoro` | One step of `resolveContainer`: given `(container, childSchema, key)`, return the child container or scalar value. | `stepFromDoc`, which is the root-level variant |
| `stepFromDoc` | Root-level dispatch: given a `LoroDoc` and a field schema, return the typed root container (`doc.getMap(key)`, `doc.getText(key)`, etc.). | `stepIntoLoro` |
| `PROPS_KEY` | The string `"_props"` — the reserved LoroMap key under which every root-level scalar and sum field is stored. | An application field name — reserved |
| `changeToDiff` | Pure: turn a kyneta `Change` + path + schema into a `[ContainerID, Diff][]` tuple list. | Loro's own `Diff` construction — we translate from kyneta's vocabulary |
| `batchToOps` | Inverse: turn Loro event-emitted `Diff[]` (after `doc.import` or external mutation) into kyneta `Op[]`. | `changeToDiff` — opposite direction |
| `loroReader` | `Reader` implementation that reads by resolving the container at `path` and extracting its value. | Substrate state — the reader is a live view |
| `applyDiff` | Loro's bulk-write API. The substrate prepares `Diff[]` during `prepare()` and applies them in one call during `onFlush`. | `doc.import` — imports a binary update; `applyDiff` applies structural diffs |
| `inOurCommit` / `inEventHandler` | Two boolean guards on the substrate. The first suppresses event-bridge reprocessing when we applied the diff ourselves; the second suppresses recursive `applyDiff` calls from event handlers. | Mutex locks — these are single-threaded flags |
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

Every read (`doc.title()`, `doc.items.at(0).body()`, `ref.current`) resolves its container on demand by left-folding over the path. No preflight container cache, no materialized tree.

```
resolveContainer(doc, schema, path, binding) =
  fold(stepIntoLoro, (doc, schema, []), path.segments)
```

Source: `packages/schema/backends/loro/src/loro-resolve.ts`.

The fold accumulator is `(currentContainer, currentSchema, absPath)`. At each step:

1. `advanceSchema(schema, segment)` → pure schema descent (from `@kyneta/schema`). Produces the child schema.
2. `stepIntoLoro(container, currentSchema, childSchema, segment, binding?)` → Loro-specific: dispatches on the container's Loro kind and the child schema's `[KIND]`, returning the child container or scalar.

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

### Why live navigation

The predecessor design held a static container map built at `bind()`. It broke three ways:

- **Structural inserts move indices.** An insert at `items[0]` invalidates every cached `items[1..]` reference.
- **External mutations don't update the cache.** `doc.import(update)` can create, delete, or re-parent containers outside kyneta's write path.
- **Map keys are unbounded.** A precomputed map would need to be rebuilt on every key mutation.

Live navigation pays a small cost per read (one container lookup per segment) but has no invalidation burden and is transparent to any source of mutation. Memoization happens at the **interpreter-stack** level (`withCaching` from `@kyneta/schema`), not the substrate level — and that cache invalidates on every kyneta-observed change via the changefeed pipeline.

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

Source: `packages/schema/backends/loro/src/substrate.ts` → `LoroSubstrate.prepare` / `onFlush`; `src/change-mapping.ts` → `changeToDiff`.

```
change(doc, d => { d.title.insert(0, "hi"); d.items.push(x) })
  │
  ├─ prepare phase (per mutation):
  │    kyneta Change (Text / Sequence / Map / Replace / Increment / Tree)
  │      └─ changeToDiff(change, path, schema, binding) ──► [ContainerID, Diff][]
  │         └─ accumulate into pending groups (one group per transaction step)
  │
  └─ flush phase (on commit):
       inOurCommit = true
       └─ mergePendingGroups — fuse single-MapDiff groups on the same container
          └─ for each group: doc.applyDiff(group)
       inOurCommit = false
```

`changeToDiff` is **pure** (source: `src/change-mapping.ts`). Given a kyneta `Change` + path + schema + binding, it produces the Loro `Diff[]` that reproduces the change. It handles every built-in change type:

| kyneta `Change.type` | Loro diff |
|-----------------------|-----------|
| `"text"` | `TextDiff` with retain/insert/delete runs |
| `"sequence"` | `ListDiff` with splice ops |
| `"map"` | `MapDiff` with `updated` record |
| `"tree"` | `TreeDiff` with create/move/delete |
| `"replace"` | Container-level replacement (varies by kind) |
| `"increment"` | `CounterDiff` with delta |

`mergePendingGroups` is a pure optimisation: when a transaction mutates multiple fields of the same struct (`d.settings.a.set(1); d.settings.b.set(2)`), both preparations target the same `LoroMap` with a single-key `MapDiff`. Merging them reduces N `applyDiff` calls to one.

### The `onFlush` commit

`onFlush` runs once per transaction, after every prepared `Diff`:

1. `inOurCommit = true` — suppress the event bridge for this commit.
2. `doc.applyDiff(groups)` for each merged group — Loro generates ops, advances the version vector.
3. `inOurCommit = false`.
4. Notifications produced during `prepare` are already delivered to subscribers by the interpreter stack; no additional notification fires from the event bridge for this commit (it was suppressed in step 1).

The suppression prevents double-notification: we know what changed because we caused it, and the interpreter-stack notification pipeline already fired.

### What the write path is NOT

- **Not a streaming write.** Each transaction is one `applyDiff` call (or one per container group). We don't write one op per mutation.
- **Not transactional in Loro's sense.** Loro has its own transaction semantics; kyneta's `change(doc, fn)` is an interpreter-stack transaction that commits a bundle of Loro writes atomically *from kyneta's perspective*. Loro ops can still interleave concurrently with other peers.
- **Not reversible from the substrate.** There is no undo buffer in the substrate. Undo is an application concern.

---

## The event bridge

Source: `packages/schema/backends/loro/src/substrate.ts` → `doc.subscribe` handler.

The persistent `doc.subscribe()` callback is the enforcement mechanism for the key invariant: *every* mutation to the underlying `LoroDoc` fires the kyneta changefeed, regardless of source. Mutation sources include:

- Local kyneta writes via `change(doc, fn)` — suppressed by `inOurCommit` (we already notified).
- `exchange.merge(payload)` from remote peers — not suppressed; kyneta subscribers must see it.
- `doc.import(update)` from application code directly — not suppressed; kyneta subscribers must see it.
- Raw Loro API writes (`doc.getText(key).insert(0, "x")`) bypassing kyneta — not suppressed; kyneta subscribers must see it.

The handler:

1. If `inOurCommit` is true → skip (we already notified during `prepare`).
2. Otherwise, set `inEventHandler = true` to block recursive `applyDiff` calls from triggering the handler again.
3. Call `batchToOps(event.diffs, schema, binding)` → pure conversion from Loro `Diff[]` to kyneta `Op[]`.
4. Dispatch the ops through the interpreter stack's notification pipeline.
5. Clear `inEventHandler`.

### Why two guards

`inOurCommit` prevents the event bridge from double-notifying when *we* applied the diff. `inEventHandler` prevents a subscriber — who during its callback might happen to trigger another `applyDiff` through some indirect path — from recursively re-entering the bridge within the same tick. The two flags address independent failure modes; neither subsumes the other.

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

`loro` is a `BindingTarget<LoroLaws, LoroNativeMap>` — a fixed bundle of `(factory, syncProtocol, allowedLaws)` built via `createBindingTarget` from `@kyneta/schema`. The ergonomic API:

```
import { loro } from "@kyneta/loro-schema"
import { Schema } from "@kyneta/schema"

const Todo = loro.bind(Schema.struct({
  title: Schema.text(),
  items: Schema.list(Schema.struct({ body: Schema.text(), done: Schema.boolean() })),
}))
```

`loro.bind(schema)` returns a `BoundSchema<S, LoroNativeMap>`. Under the hood it delegates to `@kyneta/schema`'s `bind({ schema, factory: loroFactoryBuilder, syncProtocol: SYNC_COLLABORATIVE })`. The `LoroLaws` set (`"lww" | "additive" | "positional-ot" | "positional-ot-move" | "lww-per-key" | "tree-move" | "lww-tag-replaced"`) is applied as `RestrictLaws<S, LoroLaws>`, so binding a schema that requires a composition law Loro doesn't support (e.g. `"add-wins-per-key"` from `Schema.set()`) fails at compile time.

`loro.replica()` produces a `BoundReplica<LoroVersion>` — the replication-only variant for sync conduits that don't need to interpret state.

### What `loro.bind` is NOT

- **Not a factory.** It returns a `BoundSchema`, not a substrate. The substrate is constructed by `createDoc(bound)` at runtime.
- **Not asynchronous.** Fully synchronous; the schema and the Loro factory builder are captured at call time.
- **Not overridable.** The sync protocol for `loro` is always `SYNC_COLLABORATIVE`. For different sync semantics, use `@kyneta/schema`'s lower-level `bind()` directly.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `loro` | `src/bind-loro.ts` | The binding target: `.bind(schema)`, `.replica()`. |
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

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 63 | Public barrel. Re-exports generic API from `@kyneta/schema`; exports Loro-specific symbols. |
| `src/bind-loro.ts` | 174 | `loro.bind` / `loro.replica` binding target; `LoroLaws`. |
| `src/substrate.ts` | 671 | `LoroSubstrate`, factories, prepare/flush, event bridge, `ensureLoroContainers`, `mergePendingGroups`. |
| `src/change-mapping.ts` | 866 | Pure `changeToDiff` + `batchToOps` for every kyneta change type and every Loro container kind. |
| `src/loro-resolve.ts` | 221 | `resolveContainer`, `stepIntoLoro`, `stepFromDoc`, `PROPS_KEY`. |
| `src/reader.ts` | 139 | `loroReader` — reads via `resolveContainer` + container-kind extraction. |
| `src/loro-guards.ts` | 85 | `hasKind` / `isLoroContainer` / `isLoroDoc` runtime guards. |
| `src/version.ts` | 103 | `LoroVersion` (wraps `VersionVector`). |
| `src/position.ts` | 61 | `LoroPosition` (wraps `Cursor`), `fromLoroSide`, `toLoroSide`. |
| `src/native-map.ts` | 45 | `LoroNativeMap` type-level functor. |
| `src/__tests__/create.test.ts` | 339 | End-to-end: `createDoc(loro.bind(schema))` → read/write round-trips. |
| `src/__tests__/substrate.test.ts` | 788 | Substrate contract conformance (subset of the `@kyneta/schema` suite). |
| `src/__tests__/reader.test.ts` | 487 | `loroReader` over every container kind + scalar variants. |
| `src/__tests__/record-counter-spike.test.ts` | 588 | Focus tests for `Schema.record(Schema.counter())` and related combinations. |
| `src/__tests__/structural-merge.test.ts` | 214 | `merge()` and `applyDiff` round-trips; identity-keyed container compatibility. |
| `src/__tests__/position.test.ts` | 361 | `LoroPosition` cursor stability across concurrent edits. |
| `src/__tests__/bind-constraints.test.ts` | 315 | Compile-time composition-law enforcement (schemas outside `LoroLaws` are rejected). |
| `src/__tests__/bind-loro.test.ts` | 131 | `loro.bind` API surface. |
| `src/__tests__/native.test.ts` | 102 | `unwrap(ref)` returns the right native container at every depth. |
| `src/__tests__/loro-guards.test.ts` | 47 | `hasKind`, `isLoroContainer`, `isLoroDoc` runtime behaviour. |
| `src/__tests__/version.test.ts` | 231 | `LoroVersion` serialize/parse, `compare`, `meet` algebraic properties. |

## Testing

Tests use real `LoroDoc` instances from `loro-crdt` — no mocks. Two-peer scenarios simulate collaborative editing by constructing two `LoroDoc`s, mutating them independently, and merging via `exportSince` + `merge`. The substrate contract suite from `@kyneta/schema` is replayed against `loroSubstrateFactory` for conformance.

**Tests**: 203 passed, 4 skipped across 11 files (`bind-constraints`: 27, `bind-loro`: 9, `create`: 20, `loro-guards`: included in `native`/`reader`, `native`: 10, `position`: 27 passed + 4 skipped, `reader`: 29, `record-counter-spike`: 26, `structural-merge`: 7, `substrate`: 30, `version`: 18 — approximate per-file breakdown). Run with `cd packages/schema/backends/loro && pnpm exec vitest run`.

## `richtext` support

`richtext` uses the same `LoroText` container as `text`. The difference is in how change-mapping preserves mark attributes:

- **Outbound** (`richTextChangeToDiff`): `format(N, marks)` → `{ retain: N, attributes: marks }`. `insert(text, marks)` → `{ insert: text, attributes: marks }`.
- **Inbound** (`richTextDiffToChange`): `{ retain: N, attributes }` → `{ format: N, marks: attributes }`. Discriminates `retain` vs `format` by the presence of `attributes`.

`configTextStyle()` is called once during `ensureLoroContainers` with the merged `MarkConfig` from all richtext fields in the schema. Conflicting expand values for the same mark name are caught at bind time.

The `resolveContainer` function returns `{ container, schema }` — this enables the reader to dispatch `LoroText` → `.toString()` (text) vs `.toDelta()` (richtext) based on the schema kind.