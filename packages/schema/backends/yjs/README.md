# @kyneta/yjs-schema

Yjs CRDT substrate for `@kyneta/schema` — collaborative data types with typed refs.

Wraps a `Y.Doc` with schema-aware typed reads, writes, versioning, and export/import through the standard `Substrate<YjsVersion>` interface. Adding a Yjs substrate proves the schema algebra's portability beyond Loro and opens the door to the entire Yjs ecosystem (y-websocket, y-indexeddb, y-webrtc, Hocuspocus, Liveblocks, etc.).

## Quick Start

```ts
import {
  createDoc,
  change,
  subscribe,
  Schema,
  text,
  yjs,
  version,
  exportSnapshot,
  exportSince,
  importDelta,
} from "@kyneta/yjs-schema"

// Define a schema and bind to Yjs substrate
const TodoDoc = yjs.bind(Schema.struct({
  title: text(),
  items: Schema.list(
    Schema.struct({
      name: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
}))

// Create a document with optional seed values
const doc = createDoc(TodoDoc, {
  title: "My Todos",
  items: [{ name: "Buy milk", done: false }],
})

// Read
doc.title()           // "My Todos"
doc.items.length      // 1

// Write
change(doc, (d) => {
  d.title.insert(9, " (v2)")
  d.items.push({ name: "Walk dog", done: false })
})

// Observe
subscribe(doc, (changeset) => {
  console.log("Changed:", changeset.ops.length, "ops")
})
```

## Schema Types Supported

| Schema type | Yjs backing type | Notes |
|---|---|---|
| `text()` | `Y.Text` | Character-level collaborative editing |
| `Schema.struct({...})` | `Y.Map` | Fixed-key product type |
| `Schema.list(item)` | `Y.Array` | Ordered sequence |
| `Schema.record(item)` | `Y.Map` | Dynamic-key map |
| `Schema.string()` | Plain value | Stored in parent `Y.Map` |
| `Schema.number()` | Plain value | Stored in parent `Y.Map` |
| `Schema.boolean()` | Plain value | Stored in parent `Y.Map` |

### Unsupported

- **`Schema.counter()`** — Yjs has no native counter type. Use `Schema.number()` with `ReplaceChange` instead. Attempting to use a counter annotation will throw at construction time.
- **`Schema.movableList()`** — Yjs has no native movable list. Will throw at construction time.
- **`Schema.tree()`** — Yjs has no native tree type. Will throw at construction time.

## Sync

```ts
import {
  createDoc,
  yjs,
  version,
  exportSnapshot,
  exportSince,
  importDelta,
  change,
} from "@kyneta/yjs-schema"

const MyDoc = yjs.bind(MySchema)

// Peer A creates a doc
const docA = createDoc(MyDoc, { title: "Draft" })

// Peer B bootstraps from a full snapshot
const snapshot = exportSnapshot(docA)
const docB = createDoc(MyDoc, snapshot)

// After mutations on A, sync incrementally
const vBefore = version(docB)
change(docA, (d) => d.title.insert(5, " v2"))

const delta = exportSince(docA, vBefore)
importDelta(docB, delta!)
// docB.title() === "Draft v2"
```

## Exchange Integration

```ts
import { yjs } from "@kyneta/yjs-schema"
import { Schema, text } from "@kyneta/yjs-schema"

const TodoDoc = yjs.bind(Schema.struct({
  title: text(),
  items: Schema.list(Schema.struct({
    name: Schema.string(),
    done: Schema.boolean(),
  })),
}))

// Use with @kyneta/exchange
const doc = exchange.get("my-todos", TodoDoc)
```

`yjs.bind()` produces a `BoundSchema` with the collaborative `SyncProtocol`, which the exchange uses for bidirectional CRDT sync.

## Escape Hatch

Access the underlying `Y.Doc` for direct Yjs API usage:

```ts
import { yjs, createDoc } from "@kyneta/yjs-schema"

const MyDoc = yjs.bind(MySchema)
const doc = createDoc(MyDoc)
const yjsDoc = yjs(doc)

// Use with Yjs ecosystem
// y-websocket, y-indexeddb, y-webrtc, Hocuspocus, etc.
yjsDoc.getMap("root").toJSON()  // raw state
yjsDoc.clientID                  // client ID
```

## Yjs Ecosystem Compatibility

Because `yjs(doc)` returns a standard `Y.Doc`, the entire Yjs provider ecosystem works out of the box:

- **y-websocket** — WebSocket sync
- **y-indexeddb** — Local persistence
- **y-webrtc** — Peer-to-peer sync
- **Hocuspocus** — Scalable Yjs server
- **Liveblocks** — Managed collaboration infrastructure
- **y-prosemirror** / **y-codemirror** — Rich text editor bindings

## API Reference

### Batteries-included (most users)

| Export | Description |
|---|---|
| `createDoc(schema, docOrSeed?)` | Create a live Yjs-backed document *(re-exported from `@kyneta/schema`)* |
| `version(doc)` | Current `YjsVersion` |
| `exportEntirety(doc)` | Full state as `SubstratePayload` |
| `exportSince(doc, since)` | Delta since version |
| `merge(doc, payload, origin?)` | Apply delta from peer |
| `change(doc, fn)` | Transactional mutation |
| `subscribe(doc, callback)` | Observe changes |
| `yjs.bind(schema)` | Bind schema for exchange use |
| `yjs(ref)` | Escape hatch → `Y.Doc` |
| `text()` | `Schema.text()` convenience — collaborative text schema kind |

### Low-level primitives (power users)

| Export | Description |
|---|---|
| `YjsVersion` | Version class wrapping Yjs state vectors |
| `yjsReader(doc, schema)` | Live `StoreReader` over Yjs types |
| `resolveYjsType(rootMap, schema, path)` | Path resolution |
| `applyChangeToYjs(rootMap, schema, path, change)` | kyneta → Yjs |
| `eventsToOps(events)` | Yjs → kyneta |
| `ensureContainers(doc, schema, seed)` | Root container population |
| `createYjsSubstrate(doc, schema)` | Low-level substrate construction |
| `yjsSubstrateFactory` | `SubstrateFactory<YjsVersion>` |

## License

MIT
