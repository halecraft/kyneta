# @kyneta/schema-loro

Loro CRDT substrate for `@kyneta/schema`. Provides collaborative data types with typed refs — same schema, same API, but backed by a [Loro](https://loro.dev) document with automatic conflict resolution and sync.

## Getting Started

```ts
import { createLoroDoc, change, subscribe, LoroSchema, Schema } from "@kyneta/schema-loro"

// Define a schema using Loro-aware annotations
const schema = LoroSchema.doc({
  title: LoroSchema.text(),
  count: LoroSchema.counter(),
  items: Schema.list(
    Schema.struct({ name: Schema.string(), done: Schema.boolean() }),
  ),
})

// Create a live, collaborative document
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

## Bring Your Own LoroDoc

If you already have a `LoroDoc` (e.g. from a state bus), pass it directly:

```ts
import { LoroDoc } from "loro-crdt"
import { createLoroDoc, subscribe, LoroSchema } from "@kyneta/schema-loro"

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
  LoroSchema
} from "@kyneta/schema-loro"

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
import { exportSnapshot, createLoroDocFromSnapshot } from "@kyneta/schema-loro"

const snapshot = exportSnapshot(docA)
const docB = createLoroDocFromSnapshot(mySchema, snapshot)
```

## API Reference

### Bind & Escape Hatch

| Export | Description |
|--------|-------------|
| `bindLoro(schema)` | Bind a schema to the Loro CRDT substrate with causal merge strategy. Returns a `BoundSchema<S>` for use with `exchange.get()`. The factory builder injects a deterministic numeric Loro PeerID derived from the exchange's string peerId. |
| `loro(ref)` | Escape hatch — returns the `LoroDoc` backing a root document ref. Throws if the ref is not backed by a Loro substrate. Currently supports root refs only; child-level resolution is future work. |

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
| `LoroSchema` | Schema constructors with Loro annotations. *(re-exported from `@kyneta/schema`)* |
| `Schema` | Backend-agnostic schema constructors. *(re-exported from `@kyneta/schema`)* |

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
