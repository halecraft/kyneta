# @kyneta/exchange

Substrate-agnostic state exchange for `@kyneta/schema`. Provides sync infrastructure for any substrate type — Loro CRDTs, plain JS objects, LWW ephemeral state — through a unified three-message protocol.

## Getting Started

```ts
import { Exchange, sync } from "@kyneta/exchange"
import { Schema, bindPlain, change } from "@kyneta/schema"

// 1. Define your document type (schema + substrate + strategy)
const TodoDoc = bindPlain(Schema.doc({
  title: Schema.string(),
  items: Schema.list(
    Schema.struct({ text: Schema.string(), done: Schema.boolean() }),
  ),
}))

// 2. Create an Exchange
const exchange = new Exchange({
  identity: { name: "alice" },
  adapters: [networkAdapter],
})

// 3. Get a typed document
const doc = exchange.get("my-todos", TodoDoc, {
  seed: { title: "My Todos", items: [] },
})

// 4. Read and write
doc.title()  // "My Todos"
change(doc, d => {
  d.title.set("Updated")
  d.items.push({ text: "Learn Exchange", done: false })
})

// 5. Access sync capabilities
await sync(doc).waitForSync()
sync(doc).readyStates
sync(doc).peerId
```

## Core Concepts

### BoundSchema — The Single Document Definition

A `BoundSchema` captures three choices that define a document type:

1. **Schema** — what shape is the data?
2. **Factory** — how is the data stored and versioned?
3. **Strategy** — how does the exchange sync it?

BoundSchemas are defined at module scope and passed to `exchange.get()`:

```ts
import { bindPlain, bindLww } from "@kyneta/schema"
import { bindLoro } from "@kyneta/loro-schema"

// Collaborative text — Loro CRDT with causal merge
const TodoDoc = bindLoro(LoroSchema.doc({
  title: LoroSchema.text(),
  items: Schema.list(Schema.struct({ name: Schema.string() })),
}))

// Config data — plain substrate with sequential sync
const ConfigDoc = bindPlain(Schema.doc({ theme: Schema.string() }))

// Ephemeral presence — plain substrate with LWW broadcast
const PresenceDoc = bindLww(Schema.doc({
  cursor: Schema.struct({ x: Schema.number(), y: Schema.number() }),
  name: Schema.string(),
}))
```

A BoundSchema can safely be shared across multiple Exchange instances. Each exchange calls the factory builder independently, producing a fresh factory with the correct peer identity.

### The `bind()` Primitive

For custom substrates, use `bind()` directly:

```ts
import { bind } from "@kyneta/schema"

const CustomDoc = bind({
  schema: Schema.doc({ data: Schema.string() }),
  factory: (ctx) => createMyFactory(ctx.peerId),
  strategy: "causal",
})
```

The `factory` is always a builder function `(context: { peerId: string }) => SubstrateFactory`. The exchange calls it lazily on first use, passing its peer identity. This ensures each exchange gets a fresh factory instance.

### Merge Strategies

Each BoundSchema declares a merge strategy that determines how the exchange syncs documents of that type. These are genuinely different protocols, not transport optimizations:

| Strategy | Protocol | Version Order | Use Case |
|----------|----------|---------------|----------|
| `"causal"` | Bidirectional exchange | Partial (concurrent possible) | Loro CRDTs |
| `"sequential"` | Request/response | Total (no concurrency) | Plain substrates |
| `"lww"` | Unidirectional broadcast | Total (timestamp-based) | Ephemeral/presence |

### Three-Message Protocol

All sync communication uses three message types:

- **`discover`** — "What documents exist?" / "I have these documents."
- **`interest`** — "I want document X. Here's my version."
- **`offer`** — "Here is state for document X."

The merge strategy determines *when* and *how* these messages are sent, not their shape. The protocol is uniform across all substrate types.

### Heterogeneous Documents

A single exchange can host documents backed by different substrate types simultaneously:

```ts
const exchange = new Exchange({
  identity: { name: "alice" },
  adapters: [networkAdapter],
})

const doc = exchange.get("collab-doc", TodoDoc)       // Loro CRDT
const config = exchange.get("settings", ConfigDoc)     // Plain sequential
const presence = exchange.get("presence", PresenceDoc) // LWW broadcast
```

No `substrates` record needed — each document's substrate is determined by its BoundSchema.

### The Exchange

The `Exchange` class is the central orchestrator. It manages document lifecycle, coordinates adapters, and runs sync algorithms on behalf of passive substrates.

```ts
const exchange = new Exchange({
  identity: { peerId: "alice", name: "Alice", type: "user" },
  adapters: [networkAdapter, storageAdapter],
  permissions: {
    visibility: (ctx) => true,
    mutability: (ctx) => true,
    deletion: (ctx) => true,
  },
})
```

### The `sync()` Function

Sync capabilities are accessed via the `sync()` function:

```ts
import { sync } from "@kyneta/exchange"

const doc = exchange.get("doc-id", MyDoc)

sync(doc).peerId        // Your peer ID
sync(doc).docId         // Document ID
sync(doc).readyStates   // Sync status with peers

await sync(doc).waitForSync()
await sync(doc).waitForSync({ kind: "storage", timeout: 5000 })

sync(doc).onReadyStateChange(states => {
  console.log("Sync status:", states)
})
```

### Escape Hatches

Two escape hatches provide access to the underlying substrate:

```ts
// General — returns the Substrate<any> backing a ref
import { unwrap } from "@kyneta/schema"
const substrate = unwrap(doc)
substrate.frontier().serialize()  // current version
substrate.exportSnapshot()       // full state

// Loro-specific — returns the LoroDoc backing a ref
import { loro } from "@kyneta/loro-schema"
const loroDoc = loro(doc)
loroDoc.toJSON()                 // raw Loro state
loroDoc.version()                // VersionVector
```

## API Reference

### Exchange

| Method | Description |
|--------|-------------|
| `get(docId, boundSchema, opts?)` | Get or create a document. Returns `Ref<S>`. |
| `has(docId)` | Check if a document exists. |
| `delete(docId)` | Delete a document. |
| `flush()` | Await all pending storage operations. |
| `shutdown()` | Flush + disconnect all adapters. |
| `reset()` | Disconnect adapters and clear state (synchronous). |
| `addAdapter(adapter)` | Add an adapter at runtime. |
| `removeAdapter(adapterId)` | Remove an adapter at runtime. |

### sync()

| Property/Method | Description |
|----------------|-------------|
| `peerId` | The local peer ID. |
| `docId` | The document ID. |
| `readyStates` | Current sync status with all peers. |
| `waitForSync(opts?)` | Wait for sync with a peer of the specified kind. |
| `onReadyStateChange(cb)` | Subscribe to sync status changes. Returns unsubscribe function. |

### Bind Functions

| Function | Package | Description |
|----------|---------|-------------|
| `bind({ schema, factory, strategy })` | `@kyneta/schema` | General primitive — explicit schema, factory builder, strategy. |
| `bindPlain(schema)` | `@kyneta/schema` | Plain substrate + sequential strategy. |
| `bindLww(schema)` | `@kyneta/schema` | Plain substrate + LWW broadcast strategy. |
| `bindLoro(schema)` | `@kyneta/loro-schema` | Loro substrate + causal strategy. |

### Escape Hatches

| Function | Package | Description |
|----------|---------|-------------|
| `unwrap(ref)` | `@kyneta/schema` | Returns the `Substrate<any>` backing a ref. |
| `loro(ref)` | `@kyneta/loro-schema` | Returns the `LoroDoc` backing a Loro-backed ref. |

### Adapters

| Export | Description |
|--------|-------------|
| `Adapter<G>` | Abstract base class for adapters. |
| `AdapterManager` | Manages adapter lifecycle and message routing. |
| `BridgeAdapter` | In-process adapter for testing. |
| `Bridge` | Message router connecting BridgeAdapters. |

### TimestampVersion

| Method | Description |
|--------|-------------|
| `new TimestampVersion(ts)` | Create from a millisecond timestamp. |
| `TimestampVersion.now()` | Create from the current wall clock. |
| `TimestampVersion.parse(s)` | Deserialize from string. |
| `serialize()` | Serialize to decimal string. |
| `compare(other)` | `"behind"`, `"equal"`, or `"ahead"` (never `"concurrent"`). |

## Adapters

Adapters provide pluggable network and storage connectivity. They create channels — the communication primitive — which the exchange uses for message routing.

### Built-in

| Adapter | Kind | Use Case |
|---------|------|----------|
| `BridgeAdapter` | Network | In-process testing of multi-peer scenarios |

### Creating Custom Adapters

Extend the `Adapter<G>` base class:

```ts
import { Adapter } from "@kyneta/exchange"

class MyAdapter extends Adapter<void> {
  constructor() {
    super({ adapterType: "my-adapter" })
  }

  generate() {
    return {
      kind: "network",
      adapterType: this.adapterType,
      send: (msg) => { /* send over your transport */ },
      stop: () => { /* cleanup */ },
    }
  }

  async onStart() {
    const channel = this.addChannel(undefined)
    this.establishChannel(channel.channelId)
  }

  async onStop() {
    // cleanup
  }
}
```

## Peer Dependencies

```json
{
  "peerDependencies": {
    "@kyneta/schema": ">=0.0.1"
  }
}
```

## License

MIT