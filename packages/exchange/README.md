# @kyneta/exchange

Substrate-agnostic state exchange for `@kyneta/schema`. Provides sync infrastructure for any substrate type — Loro CRDTs, plain JS objects, LWW ephemeral state — through a unified three-message protocol.

## Getting Started

```ts
import { Exchange, sync, Bridge, BridgeAdapter } from "@kyneta/exchange"
import { Schema, plainSubstrateFactory } from "@kyneta/schema"

// 1. Define your schema
const TodoSchema = Schema.doc({
  title: Schema.string(),
  items: Schema.list(
    Schema.struct({ text: Schema.string(), done: Schema.boolean() }),
  ),
})

// 2. Wrap a SubstrateFactory as an ExchangeSubstrateFactory
const plainFactory = {
  ...plainSubstrateFactory,
  mergeStrategy: { type: "sequential" },
  _initialize() {},
}

// 3. Create an Exchange
const exchange = new Exchange({
  identity: { name: "alice" },
  adapters: [new BridgeAdapter({ adapterType: "peer-a", bridge })],
  substrates: { plain: plainFactory },
})

// 4. Get a typed document
const doc = exchange.get("my-todos", TodoSchema, {
  seed: { title: "My Todos", items: [] },
})

// 5. Read and write
doc.title()  // "My Todos"
change(doc, d => {
  d.title.set("Updated")
  d.items.push({ text: "Learn Exchange", done: false })
})

// 6. Access sync capabilities
await sync(doc).waitForSync()
sync(doc).readyStates
sync(doc).peerId
```

## Core Concepts

### The Exchange

The `Exchange` class is the central orchestrator. It manages document lifecycle, coordinates adapters, and runs sync algorithms on behalf of passive substrates.

```ts
const exchange = new Exchange({
  identity: { peerId: "alice", name: "Alice", type: "user" },
  adapters: [networkAdapter, storageAdapter],
  substrates: { loro: loroFactory, plain: plainFactory },
  defaultSubstrate: "loro",
})
```

### Merge Strategies

Each substrate factory declares a `mergeStrategy` that determines how the exchange syncs documents of that type. These are genuinely different protocols, not transport optimizations:

| Strategy | Protocol | Version Order | Use Case |
|----------|----------|---------------|----------|
| `causal` | Bidirectional exchange | Partial (concurrent possible) | Loro CRDTs |
| `sequential` | Request/response | Total (no concurrency) | Plain substrates |
| `lww` | Unidirectional broadcast | Total (timestamp-based) | Ephemeral/presence |

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
  substrates: {
    loro: loroFactory,     // CRDT collaborative docs
    plain: plainFactory,   // Config/settings
    lww: lwwFactory,       // Ephemeral presence
  },
})

const doc = exchange.get("collab-doc", docSchema, { substrate: "loro" })
const config = exchange.get("settings", configSchema, { substrate: "plain" })
const presence = exchange.get("presence", presenceSchema, { substrate: "lww" })
```

### Factory-Mediated Identity

The exchange has a string `peerId`. During construction, it calls `_initialize({ peerId })` on each factory, allowing the factory to translate the exchange's identity into substrate-native form (e.g. hashing a string into Loro's numeric PeerID).

### The `sync()` Function

Sync capabilities are accessed via the `sync()` function, keeping the common case simple:

```ts
import { sync } from "@kyneta/exchange"

const doc = exchange.get("doc-id", schema)

sync(doc).peerId        // Your peer ID
sync(doc).docId         // Document ID
sync(doc).readyStates   // Sync status with peers

await sync(doc).waitForSync()
await sync(doc).waitForSync({ kind: "storage", timeout: 5000 })

sync(doc).onReadyStateChange(states => {
  console.log("Sync status:", states)
})
```

### Ephemeral State as Substrate

Presence and ephemeral state are modeled as plain-substrate documents with LWW merge strategy. No special subsystem — the exchange's sync machinery handles transport uniformly:

```ts
import { TimestampVersion } from "@kyneta/exchange"

const lwwFactory = {
  mergeStrategy: { type: "lww" },
  _initialize() {},
  // ... (see TECHNICAL.md for full LWW factory implementation)
}

const exchange = new Exchange({
  substrates: { lww: lwwFactory },
})

const presence = exchange.get("room:presence", presenceSchema)
change(presence, d => {
  d.cursor.x.set(100)
  d.cursor.y.set(200)
  d.name.set("Alice")
})
// → Broadcasts snapshot to all connected peers via LWW protocol
```

## API Reference

### Exchange

| Method | Description |
|--------|-------------|
| `get(docId, schema, opts?)` | Get or create a document. Returns `Ref<S>`. |
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

### ExchangeSubstrateFactory

| Property/Method | Description |
|----------------|-------------|
| `mergeStrategy` | `{ type: "causal" }`, `{ type: "sequential" }`, or `{ type: "lww" }` |
| `_initialize(ctx)` | Lifecycle hook called by the exchange with `{ peerId }`. |
| `create(schema, seed?)` | Create a fresh substrate. (From `SubstrateFactory`.) |
| `fromSnapshot(payload, schema)` | Reconstruct from snapshot. (From `SubstrateFactory`.) |
| `parseVersion(serialized)` | Deserialize a version. (From `SubstrateFactory`.) |

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