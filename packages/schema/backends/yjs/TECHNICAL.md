# @kyneta/yjs-schema — Technical Documentation

## Architecture Overview

`@kyneta/yjs-schema` implements `Substrate<YjsVersion>` by wrapping a `Y.Doc` with schema-aware typed reads, writes, versioning, and export/merge. The architecture mirrors `@kyneta/loro-schema` but is structurally simpler due to Yjs's imperative mutation model (no intermediate diff format, no synthetic container IDs).

### Core Design Decisions

1. **Single root `Y.Map`**: All schema fields are children of `doc.getMap("root")`. This enables a single `observeDeep` call that captures all mutations with correct relative paths, and avoids the `_props` split used in the Loro binding.

2. **Imperative local writes**: kyneta `Change` objects are applied imperatively via Yjs API calls (`ytext.applyDelta()`, `yarray.insert()`, `ymap.set()`). No intermediate diff format — `prepare()` accumulates `{ path, change }` pairs, and `onFlush()` applies them all within a single `doc.transact()`.

3. **`instanceof` for type discrimination**: Unlike Loro's `.kind()` method, Yjs shared types are discriminated via `instanceof Y.Map`, `instanceof Y.Array`, `instanceof Y.Text`. This is reliable because Yjs types are native JavaScript classes.

4. **One boolean + one origin check for re-entrancy**: Yjs `transaction.origin` carries the tag set by `doc.transact(fn, origin)`, so our own kyneta flushes are identifiable via `origin === "kyneta-prepare"` without a separate boolean. The single `inOurTransaction` guard prevents `prepare`/`onFlush` from doing Yjs-side work during event bridge replay.

5. **Populate-then-attach for structured inserts**: When creating nested shared types at runtime (e.g., pushing a struct into a Y.Array), fields are populated *before* the shared type is inserted into its parent. This produces a single `observeDeep` event with the complete struct, rather than a cascade of child `MapChange` events.

6. **Shared `populate.ts` module**: Root container population helpers are extracted into a dedicated module imported by both `substrate.ts` and `bind-yjs.ts`, avoiding the duplication present in the Loro binding.

## Root Field Mapping

All fields live in `doc.getMap("root")`:

| Schema type | Root map child | Example |
|---|---|---|
| `annotated("text")` | `Y.Text` | `rootMap.get("title")` → `Y.Text` |
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

`YjsVersion` wraps a Yjs state vector (`Y.encodeStateVector(doc)` → `Uint8Array`).

Yjs does not export a state vector comparison function. We implement standard version-vector partial-order comparison:

```
Y.decodeStateVector(encoded) → Map<clientID, clock>

For each clientID in the union of both maps:
  thisClock = this.get(id) ?? 0
  otherClock = other.get(id) ?? 0

  if thisClock < otherClock → hasLess = true
  if thisClock > otherClock → hasGreater = true

Result:
  hasLess && !hasGreater → "behind"
  hasGreater && !hasLess → "ahead"
  !hasLess && !hasGreater → "equal"
  hasLess && hasGreater   → "concurrent"
```

Serialization uses base64 encoding for text-safe embedding (matching the Loro pattern).

## Diff ↔ Change Type Mapping

### kyneta → Yjs (Direction 1: `applyChangeToYjs`)

| kyneta Change | Yjs API | Notes |
|---|---|---|
| `TextChange` | `ytext.applyDelta(instructions)` | Quill Delta format is structurally identical |
| `SequenceChange` | `yarray.insert()` / `yarray.delete()` | Cursor-based walk |
| `MapChange` | `ymap.set()` / `ymap.delete()` | Deletes first, then sets |
| `ReplaceChange` | `parent.set(key, value)` or `parent.delete(idx) + parent.insert(idx, [value])` | Targets parent container |
| `IncrementChange` | **throws** | Yjs has no native counter |
| `TreeChange` | **throws** | Yjs has no native tree type |

### Yjs → kyneta (Direction 2: `eventsToOps`)

| Yjs Event Target | kyneta Change | Source |
|---|---|---|
| `Y.Text` | `TextChange` | `event.delta` |
| `Y.Array` | `SequenceChange` | `event.changes.delta` |
| `Y.Map` | `MapChange` | `event.changes.keys` |

Container values in events (`instanceof Y.Map` / `Y.Array`) are converted to plain objects via `.toJSON()`.

## Unsupported Annotations

| Annotation | Reason | Error behavior |
|---|---|---|
| `counter` | No native Yjs counter type. Ephemeral semantics would silently lose concurrent increments. | Throws at `populateRoot()` and `applyChangeToYjs()` |
| `movable` | No `Y.MovableList` equivalent in Yjs | Throws at `populateRoot()` |
| `tree` | No `Y.Tree` equivalent in Yjs | Throws at `populateRoot()` and `applyChangeToYjs()` |

## File Map

```
packages/schema/yjs/
├── package.json          # @kyneta/yjs-schema, peerDeps on schema + yjs
├── tsconfig.json         # ESNext + NodeNext
├── tsup.config.ts        # ESM build
├── verify.config.ts      # format → types (tsgo) → logic (vitest)
├── README.md             # User-facing documentation
├── TECHNICAL.md          # This file
└── src/
    ├── index.ts          # Barrel export + text() convenience
    ├── version.ts        # YjsVersion (state vector comparison)
    ├── yjs-resolve.ts    # stepIntoYjs + resolveYjsType (path resolution)
    ├── store-reader.ts   # yjsStoreReader (StoreReader implementation)
    ├── change-mapping.ts # applyChangeToYjs + eventsToOps (bidirectional)
    ├── populate.ts       # populateRoot + recursive helpers (shared)
    ├── substrate.ts      # createYjsSubstrate + yjsSubstrateFactory
    ├── create.ts         # createYjsDoc + createYjsDocFromEntirety
    ├── sync.ts           # version, exportEntirety, exportSince, merge
    ├── bind-yjs.ts       # yjs.bind + hashPeerId (FNV-1a 32-bit)
    ├── yjs-escape.ts     # yjs.unwrap() escape hatch (WeakMap<Substrate, Y.Doc>)
    └── __tests__/
        ├── version.test.ts       # 15 tests
        ├── store-reader.test.ts  # 34 tests
        ├── substrate.test.ts     # 26 tests
        ├── bind-yjs.test.ts      # yjs.bind tests (16 tests)
        └── create.test.ts        # 30 tests
```

## Verified Properties

All 121 tests pass, covering:

1. **Version round-trip**: serialize/parse preserves equality; compare produces correct partial order (equal, behind, ahead, concurrent)
2. **Store reader liveness**: mutations via raw Yjs API are immediately visible through the StoreReader
3. **Write round-trip**: text insert, scalar set, list push all round-trip through prepare/flush
4. **Entirety export/import**: binary payload reconstructs equivalent state
5. **Delta sync**: `exportSince → merge` syncs incremental changes
6. **Concurrent sync**: two substrates with independent mutations converge after bidirectional sync
7. **Changefeed bridge**: fires on `merge`, fires on external Y.Doc mutation, no double-fire on kyneta local writes
8. **Transaction atomicity**: multi-op `change()` applies all mutations in a single Yjs transaction
9. **Nested structures**: push struct into list, read back via navigation
10. **Unsupported annotations**: counter, movable, tree all throw clear errors
11. **Deterministic clientID**: FNV-1a hash of peerId produces consistent uint32
12. **Escape hatch**: `yjs.unwrap(ref)` returns the underlying `Y.Doc`; throws for non-Yjs refs
13. **Bring your own doc**: `createYjsDoc(schema, existingYDoc)` wraps an existing doc
14. **Full workflow**: create → mutate → sync → observe → bidirectional convergence