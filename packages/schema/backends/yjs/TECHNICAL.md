# @kyneta/yjs-schema — Technical Documentation

## Architecture Overview

`@kyneta/yjs-schema` implements `Substrate<YjsVersion>` by wrapping a `Y.Doc` with schema-aware typed reads, writes, versioning, and export/merge. The architecture mirrors `@kyneta/loro-schema` but is structurally simpler due to Yjs's imperative mutation model (no intermediate diff format, no synthetic container IDs). `YjsCaps = "text" | "json"` — Yjs supports only text and JSON merge boundaries. The `YjsNativeMap` functor maps schema kinds to Yjs shared types, threading typed `[NATIVE]` access through every ref.

### Core Design Decisions

1. **Single root `Y.Map`**: All schema fields are children of `doc.getMap("root")`. This enables a single `observeDeep` call that captures all mutations with correct relative paths, and avoids the `_props` split used in the Loro binding.

2. **Imperative local writes**: kyneta `Change` objects are applied imperatively via Yjs API calls (`ytext.applyDelta()`, `yarray.insert()`, `ymap.set()`). No intermediate diff format — `prepare()` accumulates `{ path, change }` pairs, and `onFlush()` applies them all within a single `doc.transact()`.

3. **`instanceof` for type discrimination**: Unlike Loro's `.kind()` method, Yjs shared types are discriminated via `instanceof Y.Map`, `instanceof Y.Array`, `instanceof Y.Text`. This is reliable because Yjs types are native JavaScript classes.

4. **One boolean + one origin check for re-entrancy**: Yjs `transaction.origin` carries the tag set by `doc.transact(fn, origin)`, so our own kyneta flushes are identifiable via `origin === "kyneta-prepare"` without a separate boolean. The single `inOurTransaction` guard prevents `prepare`/`onFlush` from doing Yjs-side work during event bridge replay.

5. **Populate-then-attach for structured inserts**: When creating nested shared types at runtime (e.g., pushing a struct into a Y.Array), fields are populated *before* the shared type is inserted into its parent. This produces a single `observeDeep` event with the complete struct, rather than a cascade of child `MapChange` events.

6. **Shared `populate.ts` module**: Root container population helpers are extracted into a dedicated module imported by both `substrate.ts` and `bind-yjs.ts`, avoiding the duplication present in the Loro binding.

7. **`YjsNativeMap` functor**: The `NativeMap` implementation for Yjs maps schema kinds to Yjs shared types (`text → Y.Text`, `list → Y.Array`, `struct → Y.Map`, etc.). `yjs.bind(schema)` produces `BoundSchema<S, YjsNativeMap>`, threading typed `[NATIVE]` access through `DocRef<S, YjsNativeMap>` and all child refs. `unwrap(ref)` reads `ref[NATIVE]` at any depth — no per-substrate escape hatch needed.

## Root Field Mapping

All fields live in `doc.getMap("root")`:

| Schema type | Root map child | Example |
|---|---|---|
| `text` (`TextSchema`) | `Y.Text` | `rootMap.get("title")` → `Y.Text` |
| `product` (struct) | `Y.Map` | `rootMap.get("profile")` → `Y.Map` |
| `sequence` (list) | `Y.Array` | `rootMap.get("items")` → `Y.Array` |
| `map` (record) | `Y.Map` | `rootMap.get("labels")` → `Y.Map` |
| `scalar` / `sum` | Plain value | `rootMap.get("count")` → `42` |

Unlike the Loro binding, there is no `_props` or `_scalars` map for root-level scalars. Plain values and shared types coexist as children of the single root `Y.Map`.

## Container Discrimination

```
// Yjs: instanceof (reliable for native JS classes)
if (resolved instanceof Y.Map) { ... }
if (resolved instanceof Y.Array) { ... }
if (resolved instanceof Y.Text) { ... }

// Loro: .kind() method (needed for WASM boundary)
if (resolved.kind() === "Map") { ... }
```

## Imperative Local Writes

The prepare/flush pipeline:

```
change(doc, fn)
  → ctx.beginTransaction()
  → fn(doc) calls ctx.dispatch() for each mutation
    → ctx.dispatch() buffers { path, change } (transaction mode)
  → ctx.commit()
    → executeBatch(ctx, pending)
      → ctx.prepare(path, change) × N  [changefeed layer accumulates]
        → substrate.prepare() pushes to pendingChanges[]
      → ctx.flush()
        → substrate.onFlush()
          → doc.transact(() => {
              for each { path, change }:
                applyChangeToYjs(rootMap, schema, path, change)
            }, "kyneta-prepare")
          → observeDeep fires (suppressed: origin === "kyneta-prepare")
        → changefeed layer delivers Changeset to subscribers
```

Compare with Loro:
- Loro's `prepare` converts `Change → Diff` via `changeToDiff()` (~300 lines, synthetic CIDs)
- Yjs's `prepare` just pushes `{ path, change }` to a buffer
- Loro's `onFlush` calls `doc.applyDiff()` then `doc.commit()`
- Yjs's `onFlush` calls `doc.transact()` with imperative mutations

## Structured Inserts

When inserting an object into a Y.Array where the schema says `product`:

```
// Populate-then-attach: correct order
const newMap = new Y.Map()
newMap.set("name", "Alice")       // populate unattached type
newMap.set("done", false)
yarray.insert(index, [newMap])    // single observeDeep event

// Attach-then-populate: incorrect (produces extra events)
const newMap = new Y.Map()
yarray.insert(index, [newMap])    // one event
newMap.set("name", "Alice")       // another event
newMap.set("done", false)         // another event
```

No synthetic CID mechanism (Loro's `🦜:` / `JsonContainerID`) is needed. Yjs handles nested shared types natively.

## Event Bridge

A single `rootMap.observeDeep(callback)` registered at construction time:

```
rootMap.observeDeep((events, transaction) => {
  // 1. Suppress our own transactions
  if (transaction.origin === "kyneta-prepare") return

  // 2. Convert Yjs events → kyneta Ops
  const ops = eventsToOps(events)

  // 3. Determine origin (from merge or transaction)
  const origin = pendingMergeOrigin ?? transaction.origin

  // 4. Feed through executeBatch for changefeed delivery
  inOurTransaction = true
  executeBatch(ctx, ops, origin)
  inOurTransaction = false
})
```

`event.path` from `observeDeep` is **relative to the observed type** (the root map), which maps directly to kyneta `PathSegment[]`. This is simpler than Loro's absolute paths.

## Re-entrancy

```
                    Loro                          Yjs
Guards:        inOurCommit (bool)            inOurTransaction (bool)
               inEventHandler (bool)         transaction.origin check
Echo filter:   batch.by === "local"          origin === "kyneta-prepare"
               && inOurCommit
Event bridge:  doc.subscribe()               rootMap.observeDeep()
```

Yjs's `transaction.origin` carries the tag set by `doc.transact(fn, origin)`, eliminating the need for a second boolean guard.

## Version Semantics

`YjsVersion` wraps a Yjs **snapshot** (state vector + delete set), not just a state vector.

### Why snapshots, not state vectors

Yjs's state vector (`Map<clientID, clock>`) only counts *inserted* items. It does **not** advance when items are deleted (tombstoned). A version based on the state vector alone cannot detect delete-only changes — the sync protocol would see `"equal"` and skip pushing deletes to peers.

The Yjs `Snapshot` is the correct complete version: `(stateVector, deleteSet)`. Two documents are in the same state only when both their inserts and deletes match.

### Data model

`YjsVersion` carries two fields:

- **`sv: Uint8Array`** — encoded state vector, used by `exportSince()` to compute the minimal update payload via `Y.encodeStateAsUpdate(doc, sv)`.
- **`snapshotBytes: Uint8Array`** — encoded Yjs snapshot (state vector + delete set), used for equality comparison.

### Comparison

```
compare(other):
  svResult = versionVectorCompare(this.sv, other.sv)
  if svResult !== "equal": return svResult    // behind/ahead/concurrent on inserts
  if snapshotBytes are identical: return "equal"
  return "concurrent"                          // same inserts, divergent deletes
```

"concurrent" when SVs match but delete sets differ correctly triggers the sync protocol to push — `encodeStateAsUpdate` includes delete-set diffs in its output.

### Incremental delete set tracking

The full delete set is derived from the struct store (`Y.createDeleteSetFromStructStore(doc.store)`) — an O(n) walk. To avoid this on every `version()` call, the substrate maintains `accumulatedDs` incrementally:

1. Initialized once from the struct store at construction time (O(n)).
2. Updated by merging `transaction.deleteSet` on each transaction:
   - In the `observeDeep` handler (remote mutations) — before `executeBatch`.
   - In an `afterTransaction` listener (local mutations) — before `onFlush` returns.
3. `version()` encodes the SV + `accumulatedDs` into snapshot bytes — no struct-store walk per keystroke.

### Serialization

Format: `base64(sv) + "." + base64(snapshotBytes)`.

Legacy format (no `.`): base64(sv) only. Parsed as SV-only — when compared against a new-format version with matching SVs, the differing snapshot bytes yield `"concurrent"`, triggering a redundant but safe sync push.

### Meet

`meet(other)` computes the component-wise minimum of the state vectors. The resulting version uses only the meet SV as its snapshot (no delete-set info) — a conservative lower bound. This is safe because `meet()` feeds into `advance()`, which Yjs doesn't support.

## Position Conformance

`YjsPosition` wraps Yjs's `RelativePosition` to implement `@kyneta/schema`'s `Position` interface.

| kyneta `Side` | Yjs `assoc` |
|---|---|
| `"left"` | `-1` (left-sticky) |
| `"right"` | `0` (right-sticky, default) |

- `resolve()` → `Y.createAbsolutePositionFromRelativePosition(rpos, doc)` — stateless query against the document's item graph.
- `encode()` → `Y.encodeRelativePosition(rpos)`.
- `transform()` → no-op. Yjs relative positions resolve statelessly; explicit transform is only needed by `PlainPosition`.

The `positionResolver` on the Yjs substrate's `WritableContext` resolves paths to `Y.Text` shared types via `resolveYjsType`, then creates positions via `Y.createRelativePositionFromTypeIndex`.

## Diff ↔ Change Type Mapping

### kyneta → Yjs (Direction 1: `applyChangeToYjs`)

| kyneta Change | Yjs API | Notes |
|---|---|---|
| `TextChange` | `ytext.applyDelta(instructions)` | Quill Delta format is structurally identical |
| `SequenceChange` | `yarray.insert()` / `yarray.delete()` | Cursor-based walk |
| `MapChange` | `ymap.set()` / `ymap.delete()` | Deletes first, then sets |
| `ReplaceChange` | `parent.set(key, value)` or `parent.delete(idx) + parent.insert(idx, [value])` | Targets parent container |
| `IncrementChange` | **throws** | `CounterSchema` not in `YjsCaps` |
| `TreeChange` | **throws** | `TreeSchema` not in `YjsCaps` |

### Yjs → kyneta (Direction 2: `eventsToOps`)

| Yjs Event Target | kyneta Change | Source |
|---|---|---|
| `Y.Text` | `TextChange` | `event.delta` |
| `Y.Array` | `SequenceChange` | `event.changes.delta` |
| `Y.Map` | `MapChange` | `event.changes.keys` |

Container values in events (`instanceof Y.Map` / `Y.Array`) are converted to plain objects via `.toJSON()`.

## Unsupported Types

Yjs declares `YjsCaps = "text" | "json"`. The following first-class types are rejected at compile time by `yjs.bind()` (via `ExtractCaps<S> ⊆ YjsCaps` constraint) and at runtime by populate/apply:

| Type | Reason | Error behavior |
|---|---|---|
| `CounterSchema` | No native Yjs counter type. Ephemeral semantics would silently lose concurrent increments. | Compile error at `yjs.bind()`. Throws at `populateRoot()` and `applyChangeToYjs()` |
| `MovableSequenceSchema` | No `Y.MovableList` equivalent in Yjs | Compile error at `yjs.bind()`. Throws at `populateRoot()` |
| `TreeSchema` | No `Y.Tree` equivalent in Yjs | Compile error at `yjs.bind()`. Throws at `populateRoot()` and `applyChangeToYjs()` |
| `SetSchema` | No `Y.Set` equivalent in Yjs | Compile error at `yjs.bind()`. Throws at `populateRoot()` |

## `YjsNativeMap` — The Yjs Functor

`YjsNativeMap` is the concrete `NativeMap` implementation for Yjs, mapping each schema kind to its Yjs shared type:

| NativeMap slot | Yjs type | Schema kind |
|---|---|---|
| `root` | `Y.Doc` | Root document |
| `text` | `Y.Text` | `Schema.text()` |
| `counter` | `undefined` | Not supported by Yjs (`YjsCaps` excludes `"counter"`) |
| `list` | `Y.Array<unknown>` | `Schema.list(item)` |
| `movableList` | `undefined` | Not supported by Yjs |
| `struct` | `Y.Map<unknown>` | `Schema.struct(fields)` |
| `map` | `Y.Map<unknown>` | `Schema.record(item)` |
| `tree` | `undefined` | Not supported by Yjs |
| `set` | `undefined` | Not supported by Yjs |
| `scalar` | `undefined` | Scalars have no dedicated shared type |
| `sum` | `undefined` | Sums are stored as plain values |

`yjs.bind(schema)` produces `BoundSchema<S, YjsNativeMap>`, which flows through `DocRef<S, YjsNativeMap>` and all child `SchemaRef<S, M, YjsNativeMap>` refs. This enables fully typed native access:

```
const doc = createDoc(yjs.bind(schema))
unwrap(doc)           // Y.Doc         (typed via N["root"])
unwrap(doc.title)     // Y.Text        (typed via N["text"])
unwrap(doc.items)     // Y.Array       (typed via N["list"])
unwrap(doc.profile)   // Y.Map         (typed via N["struct"])
unwrap(doc.theme)     // undefined     (scalar — no shared type)
```

`unwrap(ref)` reads `ref[NATIVE]` — the symbol property set during interpretation by the `nativeResolver` protocol. This replaces the previous `yjs.unwrap()` function and its `WeakMap<Substrate, Y.Doc>` tracking.

## File Map

```
packages/schema/yjs/
├── package.json          # @kyneta/yjs-schema, peerDeps on schema + yjs
├── tsconfig.json         # ESNext + NodeNext
├── tsdown.config.ts      # ESM build
├── verify.config.ts      # format → types (tsgo) → logic (vitest)
├── README.md             # User-facing documentation
├── TECHNICAL.md          # This file
└── src/
    ├── index.ts          # Barrel export + text() convenience
    ├── native-map.ts     # YjsNativeMap — NativeMap functor mapping schema kinds to Yjs types
    ├── version.ts        # YjsVersion (state vector comparison)
    ├── position.ts       # YjsPosition (relative position wrapping)
    ├── yjs-resolve.ts    # stepIntoYjs + resolveYjsType (path resolution)
    ├── reader.ts         # yjsStoreReader (StoreReader implementation)
    ├── change-mapping.ts # applyChangeToYjs + eventsToOps (bidirectional)
    ├── populate.ts       # populateRoot + recursive helpers (shared)
    ├── substrate.ts      # createYjsSubstrate + yjsSubstrateFactory
    ├── bind-yjs.ts       # yjs.bind — SubstrateNamespace<CrdtStrategy, YjsCaps, YjsNativeMap> + hashPeerId (FNV-1a 32-bit)
    └── __tests__/
        ├── version.test.ts       # YjsVersion serialize/parse/compare tests
        ├── reader.test.ts        # StoreReader navigation and read tests
        ├── substrate.test.ts     # Full substrate lifecycle tests
        ├── bind-yjs.test.ts      # yjs.bind tests, capability constraints, deterministic clientID
        └── create.test.ts        # createDoc with BoundSchema, hydration from payload
```

## Verified Properties

Tests cover:

1. **Version round-trip**: serialize/parse preserves equality; compare produces correct partial order (equal, behind, ahead, concurrent)
2. **Store reader liveness**: mutations via raw Yjs API are immediately visible through the StoreReader
3. **Write round-trip**: text insert, scalar set, list push all round-trip through prepare/flush
4. **Entirety export/import**: binary payload reconstructs equivalent state
5. **Delta sync**: `exportSince → merge` syncs incremental changes
6. **Concurrent sync**: two substrates with independent mutations converge after bidirectional sync
7. **Changefeed bridge**: fires on `merge`, fires on external Y.Doc mutation, no double-fire on kyneta local writes
8. **Transaction atomicity**: multi-op `change()` applies all mutations in a single Yjs transaction
9. **Nested structures**: push struct into list, read back via navigation
10. **Unsupported types**: counter, movable, tree, set all throw clear errors; `yjs.bind()` rejects them at compile time via `YjsCaps`
11. **Deterministic clientID**: FNV-1a hash of peerId produces consistent uint32
12. **Escape hatch**: `unwrap(ref)` returns the typed substrate-native container via `ref[NATIVE]`; works at any depth (root → `Y.Doc`, child text → `Y.Text`, etc.)
13. **NativeMap typing**: `DocRef<S, YjsNativeMap>` provides correct `[NATIVE]` types at every node
14. **Full workflow**: create → mutate → sync → observe → bidirectional convergence
15. **Version: delete detection**: version changes after a delete-only mutation (snapshot-based comparison detects delete set divergence even when state vector is unchanged)
16. **Position conformance**: shared conformance suite passes for `YjsPosition` — stability, sticky-side, deletion resolution, encode/decode round-trip, sequential agreement
17. **Position: concurrent edits**: positions resolve correctly after multi-peer sync with concurrent inserts/deletes
18. **Delete sync**: text deletes propagate through Exchange to remote peers (Yjs-specific regression test)