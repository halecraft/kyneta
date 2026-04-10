# @kyneta/loro-schema

Loro CRDT substrate for `@kyneta/schema`. Provides collaborative data types with typed refs — same schema, same API, but backed by a [Loro](https://loro.dev) document with automatic conflict resolution and sync.

Schemas are defined once with `Schema.*`, then bound to Loro via `loro.bind()`. Write once, bind anywhere.

## Getting Started

```ts
import { Schema } from "@kyneta/schema"
import { createLoroDoc, change, subscribe, loro } from "@kyneta/loro-schema"

// Define a schema using Schema.* — the universal grammar
const schema = Schema.struct({
  title: Schema.text(),
  count: Schema.counter(),
  items: Schema.list(
    Schema.struct.json({ name: Schema.string(), done: Schema.boolean() }),
  ),
})

// Bind to Loro and create a live, collaborative document
const bound = loro.bind(schema)
const doc = createLoroDoc(schema, { title: "Hello" })

// Read and write through the typed ref API
doc.title()  // "Hello"

change(doc, d => {
  d.title.insert(5, " World")
  d.count.increment(1)
  d.items.push({ name: "First task", done: false })
})

doc.title()              // "Hello World"
doc.count()              // 1
doc.items.at(0).name()   // "First task"

// Observe all mutations (local, remote, or external)
subscribe(doc, changeset => {
  console.log("Changed:", changeset)
})
```

## Write Once, Bind Anywhere

Schemas are backend-agnostic. The same `Schema.*` definition works with any substrate — Loro, Yjs, or plain JSON:

```ts
import { Schema } from "@kyneta/schema"
import { loro } from "@kyneta/loro-schema"
import { json } from "@kyneta/schema"

const schema = Schema.struct({
  title: Schema.text(),
  count: Schema.counter(),
  items: Schema.list(
    Schema.struct.json({ name: Schema.string(), done: Schema.boolean() }),
  ),
})

// Bind to Loro for collaborative editing
const loroBound = loro.bind(schema)

// Bind to JSON for server-side or non-collaborative use
const jsonBound = json.bind(schema)
```

`loro.bind()` enforces Loro's capability constraints at compile time via `LoroCaps`. If your schema uses a capability Loro doesn't support (e.g. `Schema.set()`), `loro.bind()` produces a type error.

## Bring Your Own LoroDoc

If you already have a `LoroDoc` (e.g. from a state bus), pass it directly:

```ts
import { LoroDoc } from "loro-crdt"
import { createLoroDoc, subscribe } from "@kyneta/loro-schema"

const loroDoc = new LoroDoc()
const doc = createLoroDoc(mySchema, loroDoc)

// External mutations to the LoroDoc fire kyneta subscribers
subscribe(doc, () => console.log("Something changed"))

loroDoc.getText("title").insert(0, "External edit")
loroDoc.commit()
// → "Something changed"
```

## Sync

Two peers exchange state via `exportSince` / `importDelta`:

```ts
import {
  createLoroDoc, change, subscribe,
  version, exportSince, importDelta,
} from "@kyneta/loro-schema"

// Peer A
const docA = createLoroDoc(mySchema)
change(docA, d => d.title.insert(0, "Hello from A"))

// Peer B
const docB = createLoroDoc(mySchema)
subscribe(docB, () => console.log("B updated"))

// Sync A → B
const sinceVersion = version(docB)
const delta = exportSince(docA, sinceVersion)
importDelta(docB, delta!, "sync")
// → "B updated"
// docB.title() === "Hello from A"
```

For full state transfer (SSR, reconnection), use snapshots:

```ts
import { exportSnapshot, createLoroDocFromSnapshot } from "@kyneta/loro-schema"

const snapshot = exportSnapshot(docA)
const docB = createLoroDocFromSnapshot(mySchema, snapshot)
```

## API Reference

### Bind & Escape Hatch

| Export | Description |
|--------|-------------|
| `loro.bind(schema)` | Bind a schema to the Loro CRDT substrate. Enforces `LoroCaps` constraints at compile time — schemas containing unsupported capabilities (e.g. `Schema.set()`) are rejected. Returns a `BoundSchema<S>` for use with `exchange.get()`. The factory builder injects a deterministic numeric Loro PeerID derived from the exchange's string peerId. |
| `loro.unwrap(ref)` | Escape hatch — returns the `LoroDoc` backing a root document ref. Throws if the ref is not backed by a Loro substrate. Currently supports root refs only; child-level resolution is future work. |

### Batteries-Included (most users)

| Export | Description |
|--------|-------------|
| `createLoroDoc(schema, docOrSeed?)` | Create a live Loro-backed document. Pass a `LoroDoc` to wrap it, or a seed object (or nothing) to create a fresh one. |
| `createLoroDocFromSnapshot(schema, payload)` | Reconstruct a document from a snapshot payload. |
| `version(doc)` | Current version as a `LoroVersion`. |
| `exportSnapshot(doc)` | Full state as a binary `SubstratePayload`. |
| `exportSince(doc, since)` | Delta payload since a version. |
| `importDelta(doc, payload, origin?)` | Apply a delta from another peer. |
| `change(doc, fn)` | Run mutations in a transaction. *(re-exported from `@kyneta/schema`)* |
| `subscribe(doc, cb)` | Observe all mutations. *(re-exported from `@kyneta/schema`)* |
| `applyChanges(doc, ops, opts?)` | Apply a list of ops declaratively. *(re-exported from `@kyneta/schema`)* |

### Schema Constructors

Schemas are defined with `Schema.*` from `@kyneta/schema`. All constructors are backend-agnostic:

| Constructor | Description |
|-------------|-------------|
| `Schema.struct(fields)` | Product type → `LoroMap` container |
| `Schema.list(item)` | Sequence type → `LoroList` container |
| `Schema.record(item)` | Map type → `LoroMap` container |
| `Schema.text()` | Collaborative text → `LoroText` |
| `Schema.counter()` | CRDT counter → `LoroCounter` |
| `Schema.movableList(item)` | Movable list → `LoroMovableList` |
| `Schema.tree(nodeData)` | Tree → `LoroTree` |
| `Schema.struct.json(fields)` | JSON merge boundary — struct stored as opaque JSON in parent container |
| `Schema.list.json(item)` | JSON merge boundary — array stored as opaque JSON |
| `Schema.record.json(item)` | JSON merge boundary — record stored as opaque JSON |
| `Schema.string()` | Plain string scalar (stored in `_props` at root) |
| `Schema.number()` | Plain number scalar |
| `Schema.boolean()` | Plain boolean scalar |
| `Schema.nullable(inner)` | Nullable wrapper |

### Low-Level Primitives (power users)

| Export | Description |
|--------|-------------|
| `createLoroSubstrate(doc, schema)` | Wrap a `LoroDoc` in a `Substrate<LoroVersion>`. |
| `loroSubstrateFactory` | `SubstrateFactory<LoroVersion>` with `create`, `fromSnapshot`, `parseVersion`. |
| `loroStoreReader(doc, schema)` | Create a `StoreReader` over a Loro container tree. |
| `resolveContainer(doc, schema, path)` | Resolve a Loro container at a kyneta path. |
| `changeToDiff(path, change, schema, doc)` | Convert a kyneta Change to Loro `[ContainerID, Diff][]` tuples. |
| `batchToOps(batch, schema)` | Convert a Loro event batch to kyneta `Op[]`. |
| `LoroVersion` | `Version` implementation wrapping Loro's `VersionVector`. |
| `LoroCaps` | Capability type: `"text" | "counter" | "movable" | "tree" | "json"`. |

## Event Bridge Contract

Wrapping a `LoroDoc` in a kyneta substrate means `subscribe()` observes **all** mutations to the underlying doc, regardless of source:

- Mutations via `change()` — the normal path
- Mutations via `importDelta()` — remote sync
- External `doc.import()` — e.g. from a state bus
- External raw Loro API calls + `doc.commit()` — e.g. from another library

## Peer Dependencies

```json
{
  "peerDependencies": {
    "@kyneta/schema": ">=0.0.1",
    "loro-crdt": ">=1.8.0"
  }
}
```

## License

MIT