# @kyneta/loro-schema — Technical Reference

Loro CRDT substrate for `@kyneta/schema`. Wraps a `LoroDoc` with schema-aware typed reads, writes, versioning, and export/import through the standard `Substrate<LoroVersion>` interface.

---

## 1. Architecture Overview

`LoroStoreReader` performs **schema-guided live navigation** of the Loro container tree. There is no static container map or registry — every `read()`, `arrayLength()`, `keys()`, and `hasKey()` call resolves containers on demand by folding over path segments.

The fold pattern uses two collaborating functions:

- **`advanceSchema(schema, segment)`** — pure schema descent. Given a schema node and a path segment, returns the child schema. No Loro side effects. Imported from `@kyneta/schema`.
- **`stepIntoLoro(current, currentSchema, nextSchema, segment)`** — Loro-specific navigation. Given the current position (LoroDoc or container), the schemas at both levels, and a segment, returns the child container or scalar value.

`resolveContainer` is the full left-fold:

```ts
let current: unknown = doc
let schema = rootSchema
for (const seg of path) {
  const nextSchema = advanceSchema(schema, seg)
  current = stepIntoLoro(current, schema, nextSchema, seg)
  schema = nextSchema
}
return current
```

The reader is a **live view** — mutations to the underlying `LoroDoc` (via `applyDiff` + `commit`, `doc.import`, or raw Loro API calls) are immediately visible through subsequent reads. No cache invalidation required.

---

## 2. Container Discrimination

Runtime container type is determined exclusively via the **`.kind()` method**, never `instanceof`. The `.kind()` return type is:

```
"Map" | "List" | "Text" | "Counter" | "MovableList" | "Tree"
```

The `hasKind` guard used throughout the codebase:

```ts
function hasKind(value: unknown): value is { kind(): string } {
  return (
    value !== null &&
    value !== undefined &&
    typeof value === "object" &&
    "kind" in value &&
    typeof (value as any).kind === "function"
  )
}
```

This is necessary because Loro container objects are opaque handles, not class instances from the JS perspective. `instanceof` checks against imported classes are unreliable across module boundaries and bundler configurations; `.kind()` is the stable contract.

Value extraction from containers by kind:

| `.kind()` | Extraction |
|---|---|
| `"Text"` | `.toString()` → `string` |
| `"Counter"` | `.value` → `number` |
| `"Map"` | `.toJSON()` → plain object, or `.get(key)` for navigation |
| `"List"` | `.toJSON()` → plain array, `.get(index)` for navigation, `.length` for count |
| `"MovableList"` | Same interface as `"List"` |
| `"Tree"` | `.toJSON()` → tree snapshot |

---

## 3. Static Zone vs Dynamic Zone

The Loro container tree divides into two zones with different identity characteristics.

### Static Zone

**Root products and nested structs.** Container paths are deterministic — they derive entirely from the schema field names.

- Root field `title` (annotated `"text"`) → `doc.getText("title")`, CID is `cid:root-title:Text`.
- Nested struct field `items[0].metadata` → resolved by walking `doc.getList("items").get(0).get("metadata")`.

Static-zone containers have **stable ContainerIDs** that are independent of which peer created them, because the schema defines their position.

### Dynamic Zone

**List items and map entries.** Container IDs are **peer-dependent** — they include the creating peer's ID and a counter (`cid:{counter}@{peerID}:{Type}`).

When a peer inserts a struct into a list, the `LoroMap` container for that struct gets a CID like `cid:42@abc123:Map`. A different peer inserting the same logical value would get a different CID. This is fundamental to CRDTs — concurrent inserts produce distinct containers that can be independently merged.

Implication: code must never hardcode or cache dynamic-zone CIDs across operations. Always resolve via path navigation.

---

## 4. applyDiff-based Local Writes

Local writes follow a two-phase protocol: **prepare** accumulates, **onFlush** applies.

### `prepare(path, change)`

Converts a kyneta `Change` to Loro diff tuples via `changeToDiff()`. Returns `[ContainerID, Diff | JsonDiff][]` — one or more container-targeted diffs. These are accumulated in `pendingGroups` (an array of groups, one group per `prepare()` call).

**`prepare` has zero Loro side effects.** The LoroDoc is read-only during prepare (only for container ID resolution via `resolveContainer`). No mutations occur.

### `onFlush(origin?)`

Applies accumulated diff groups to the LoroDoc:

```
for each group in pendingGroups:
    doc.applyDiff(group)
pendingGroups = []
doc.setNextCommitMessage(origin)   // if origin provided
doc.commit()
```

Each group is applied as a **single `applyDiff()` call**. Groups from different `prepare()` calls are applied separately — Loro cannot handle duplicate ContainerIDs in a single batch (e.g., two `TextDiff`s for the same container from a multi-op transaction). Within a group, entries may cross-reference via `JsonContainerID` and must be in the same `applyDiff()` call (see §5).

### inEventHandler bypass

When `inEventHandler` is true (during event bridge replay), both `prepare` and `onFlush` skip their Loro-side work. The changes are already applied by Loro; the calls exist only so the changefeed layer (`wrappedPrepare`/`wrappedFlush`) can buffer and deliver notifications.

---

## 5. Structured Inserts via JsonContainerID

Inserting a struct into a list or map requires creating new Loro containers within an `applyDiff` batch. This uses Loro's **`JsonContainerID`** mechanism.

### The `🦜:` prefix

A `JsonContainerID` is a string of the form `🦜:cid:{counter}@{peer}:{Type}`. When Loro encounters this string as a value in a `JsonDiff`, it treats it as a **reference to another container** in the same `applyDiff` batch rather than a literal string.

### Synthetic CID generation

```ts
let syntheticCounter = 0
function syntheticCID(containerType): ContainerID {
    return `cid:${syntheticCounter++}@0:${containerType}`
}
function jsonCID(cid: ContainerID): JsonContainerID {
    return `🦜:${cid}`
}
```

Synthetic CIDs use peer `0` and a module-scoped monotonic counter. They are **batch-local** — Loro remaps them to real peer-scoped IDs when applying the diff. Collisions between batches are harmless since remapping is per-call.

### Example: inserting `{name: "x", done: false}` into a list

`changeToDiff` produces a group like:

```
[
  [listCID,       { type: "list", diff: [{ retain: N }, { insert: ["🦜:cid:7@0:Map"] }] }],
  ["cid:7@0:Map", { type: "map",  updated: { name: "x", done: false } }]
]
```

The list diff references the synthetic map CID via the `🦜:` prefix. The second tuple defines the map's contents. Both tuples **must be in the same `applyDiff()` call** or the cross-reference is dangling.

### Recursive materialization

`materializeValueDiffs` recursively walks a plain JS value against the schema. For each nested object whose schema is `product` or `map`, it allocates a synthetic CID, emits a `[syntheticCID, MapJsonDiff]` tuple, and replaces the value in the parent with `🦜:syntheticCID`.

---

## 6. Event Bridge

A **persistent `doc.subscribe()`** handler is registered at `createLoroSubstrate()` construction time. It bridges all non-kyneta mutations to the kyneta changefeed.

### Discrimination logic

```ts
doc.subscribe((batch) => {
    if (batch.by === "local" && inOurCommit) return   // kyneta's own commit
    if (batch.by === "checkout") return                // version travel, not mutation

    const ops = batchToOps(batch, schema)
    if (ops.length === 0) return

    const origin = pendingImportOrigin ?? batch.origin

    inEventHandler = true
    try {
        executeBatch(ctx, ops, origin)
    } finally {
        inEventHandler = false
    }
})
```

`LoroEventBatch.by` values:

| `batch.by` | Meaning | Action |
|---|---|---|
| `"local"` + `inOurCommit` | kyneta's own `doc.commit()` | **Ignore** — changefeed already captured via `wrappedPrepare` |
| `"local"` + `!inOurCommit` | External code called Loro API directly + committed | **Bridge** via `executeBatch` |
| `"import"` | `doc.import()` or `doc.merge()` | **Bridge** via `executeBatch` |
| `"checkout"` | Version travel (time-travel) | **Ignore** |

### Origin threading

For `merge` calls, the kyneta-level `origin` string is stashed in `pendingImportOrigin` before calling `doc.import()`. The subscriber picks it up and passes it to `executeBatch`, falling back to `batch.origin` for non-kyneta imports.

---

## 7. Re-entrancy Guards

Two boolean flags prevent infinite loops and duplicate work:

### `inOurCommit`

Set `true` around `doc.commit()` inside `onFlush`. Purpose: when `doc.commit()` triggers the `doc.subscribe()` handler with `by: "local"`, the subscriber sees `inOurCommit === true` and returns early. Without this, every kyneta write would double-fire the changefeed.

```ts
inOurCommit = true
try { doc.commit() }
finally { inOurCommit = false }
```

### `inEventHandler`

Set `true` around `executeBatch()` inside the subscriber. Purpose: `executeBatch` calls `substrate.prepare()` and `substrate.onFlush()` to feed ops through the changefeed machinery. These calls must be **no-ops on the Loro side** (the changes are already applied). The `inEventHandler` flag makes `prepare` skip `changeToDiff` accumulation and `onFlush` skip `applyDiff`/`commit`.

```ts
inEventHandler = true
try { executeBatch(ctx, ops, origin) }
finally { inEventHandler = false }
```

---

## 8. Event Bridge Contract

> **Wrapping a `LoroDoc` in a kyneta substrate means all mutations — regardless of source — fire kyneta changefeed subscribers.**

Mutation sources and their paths to the changefeed:

| Source | Mechanism |
|---|---|
| kyneta `change()` / `batch()` | `prepare` → `onFlush` → `doc.applyDiff` + `doc.commit` → changefeed via `wrappedPrepare`/`wrappedFlush` (subscriber ignores via `inOurCommit`) |
| `substrate.merge()` | `doc.import()` → subscriber fires → `batchToOps` → `executeBatch` → changefeed |
| External `doc.import()` | subscriber fires → `batchToOps` → `executeBatch` → changefeed |
| External raw Loro API (`getText().insert()` + `doc.commit()`) | subscriber fires with `by: "local"`, `inOurCommit` is false → `batchToOps` → `executeBatch` → changefeed |

This contract is tested by the `changefeed fires on merge`, `changefeed fires on external import`, and `changefeed fires on external local write` test suites.

---

## 9. The changeToDiff / batchToOps Boundary

These are **conceptual inverses** mapping between kyneta's `Change` types and Loro's `Diff` types at the substrate boundary.

| Direction | Function | Input | Output |
|---|---|---|---|
| kyneta → Loro | `changeToDiff(path, change, schema, doc)` | `Path` + `ChangeBase` | `[ContainerID, Diff \| JsonDiff][]` |
| Loro → kyneta | `batchToOps(batch, schema)` | `LoroEventBatch` | `Op[]` (each `Op` = `{path, change}`) |

### Diff ↔ Change type mapping

| Loro Diff type | kyneta Change type | Notes |
|---|---|---|
| `TextDiff` (`type: "text"`) | `TextChange` (`type: "text"`) | Delta shapes are structurally identical: `{insert, delete, retain}` |
| `ListDiff` / `ListJsonDiff` (`type: "list"`) | `SequenceChange` (`type: "sequence"`) | Insert deltas carry plain values or `JsonContainerID` refs (→Loro) / container handles (←Loro, `.toJSON()`'d) |
| `MapDiff` / `MapJsonDiff` (`type: "map"`) | `MapChange` (`type: "map"`) | `updated` entries with `undefined` values → `delete` keys; container values → `.toJSON()` on read-back |
| `CounterDiff` (`type: "counter"`) | `IncrementChange` (`type: "increment"`) | Single `increment` / `amount` field |
| `TreeDiff` (`type: "tree"`) | `TreeChange` (`type: "tree"`) | Action mapping: `create`→`create`, `delete`→`delete`, `move`→`move` |

### ReplaceChange special case

`ReplaceChange` (`type: "replace"`) does not map to a single Loro diff type. It targets the **parent container**:

- Parent is a `Map` → emits `MapDiff` with `updated: { [lastSegKey]: value }`.
- Parent is a `List` → emits `ListDiff` with `[retain(N), delete(1), insert([value])]`.
- Parent is root LoroDoc for a scalar field → targets the `_props` map.

`changeToDiff` dispatches `ReplaceChange` before resolving the target container, since it needs the parent, not the scalar itself.

---

## 10. Version Semantics

`LoroVersion` wraps Loro's **`VersionVector`**, not `Frontiers`.

| Loro concept | What it tracks | kyneta use |
|---|---|---|
| `VersionVector` | Complete peer state — which ops from each peer have been observed | `LoroVersion` wraps this. Used for `exportSince(since)` to compute minimal update payloads. |
| `Frontiers` | DAG leaf ops (compact checkpoint representation) | **Not used** by `LoroVersion`. Frontiers are for checkout/time-travel, not sync diffing. |

### Serialization

`LoroVersion.serialize()` encodes as **base64**:

```
VersionVector.encode() → Uint8Array → base64 string
```

`LoroVersion.parse()` is the inverse:

```
base64 string → Uint8Array → VersionVector.decode()
```

Base64 encoding is text-safe for embedding in HTML meta tags, URL parameters, script tags, etc. The implementation uses platform-agnostic `btoa`/`atob` (no Node.js `Buffer` dependency).

### Comparison

`LoroVersion.compare(other)` delegates to `VersionVector.compare()` and maps:

| `VV.compare()` return | `LoroVersion.compare()` return |
|---|---|
| `-1` | `"behind"` |
| `0` | `"equal"` |
| `1` | `"ahead"` |
| `undefined` | `"concurrent"` |

---

## 11. Root Scalar Fields

Root-level fields with non-container schema types (`Schema.string()`, `Schema.number()`, `Schema.boolean()`, sum types) do **not** get their own root Loro container. Instead, they are stored as entries in a single root `LoroMap` keyed by `PROPS_KEY = "_props"`.

```
doc.getMap("_props").get("theme")   → "dark"
doc.getMap("_props").get("count")   → 42
```

This avoids creating a separate root container per scalar field. The `_props` map is accessed:

- **On read:** `stepFromDoc` detects `scalar` or `sum` schema kind → reads from `doc.getMap(PROPS_KEY).get(key)`.
- **On write:** `ReplaceChange` at a root scalar path → emits `MapDiff` targeting the `_props` container's CID.
- **On init:** `populateRootField` detects `scalar` or `sum` → calls `doc.getMap(PROPS_KEY).set(key, value)`.

Container-typed root fields (`text`, `counter`, `product`, `sequence`, `map`, `movable`, `tree`) each get their own root container via `doc.getText(key)`, `doc.getMap(key)`, etc.

---

## 12. File Map

```
src/
├── index.ts              Public API surface. Re-exports from all modules.
│
├── substrate.ts          createLoroSubstrate() — Substrate<LoroVersion> implementation.
│                         loroSubstrateFactory — SubstrateFactory (create, fromEntirety, parseVersion).
│                         populateRootField / populateMap / populateList — seed initialization.
│
├── store-reader.ts       loroStoreReader() — StoreReader via live schema-guided navigation.
│                         read(), arrayLength(), keys(), hasKey() implementations.
│                         extractValue() — container kind → scalar extraction.
│
├── loro-resolve.ts       resolveContainer() — left-fold path resolution over Loro tree.
│                         stepIntoLoro() — single fold step (LoroDoc root vs container child).
│                         stepFromDoc() — root-level dispatch by schema annotation tag.
│                         stepFromContainer() — child dispatch by .kind().
│                         PROPS_KEY constant ("_props").
│
├── change-mapping.ts     changeToDiff() — kyneta Change → Loro [ContainerID, Diff][] groups.
│                         batchToOps() — Loro LoroEventBatch → kyneta Op[].
│                         Per-type converters in both directions.
│                         syntheticCID / jsonCID — 🦜: prefix mechanism.
│                         materializeValueDiffs — recursive structured insert expansion.
│
├── version.ts            LoroVersion class — wraps VersionVector.
│                         serialize/parse (base64), compare (partial order).
│
└── __tests__/
    ├── store-reader.test.ts   StoreReader navigation and read tests.
    ├── substrate.test.ts      Full substrate lifecycle: create, seed, write round-trip,
    │                          version tracking, snapshot export/import, delta sync,
    │                          concurrent sync, changefeed bridge (import, external, local),
    │                          no-double-fire, transactions, nested structures.
    └── version.test.ts        LoroVersion serialize/parse/compare tests.
```
