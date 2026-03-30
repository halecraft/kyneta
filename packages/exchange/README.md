# @kyneta/exchange

Substrate-agnostic state exchange for `@kyneta/schema`. Provides sync infrastructure for any substrate type — Loro CRDTs, plain JS objects, LWW ephemeral state — through a four-message sync protocol (discover, interest, offer, dismiss) over a two-message handshake (establish-request, establish-response).

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
  adapters: [createWebsocketClient({ url: "ws://localhost:3000/ws" })],
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
import { bindPlain, bindEphemeral } from "@kyneta/schema"
import { bindLoro } from "@kyneta/loro-schema"

// Collaborative text — Loro CRDT with causal merge
const TodoDoc = bindLoro(LoroSchema.doc({
  title: LoroSchema.text(),
  items: Schema.list(Schema.struct({ name: Schema.string() })),
}))

// Config data — plain substrate with sequential sync
const ConfigDoc = bindPlain(Schema.doc({ theme: Schema.string() }))

// Ephemeral presence — plain substrate with LWW broadcast
const PresenceDoc = bindEphemeral(Schema.doc({
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

### Sync Protocol

Four exchange message types handle document sync:

- **`discover`** — "I have these documents." (filtered by `route`)
- **`interest`** — "I want document X. Here's my version."
- **`offer`** — "Here is state for document X." (gated by `authorize`)
- **`dismiss`** — "I'm leaving document X." (triggers `onDocDismissed`)

Two additional messages (`establish-request`, `establish-response`) handle channel handshake. The merge strategy determines *when* and *how* messages are sent, not their shape.

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
  route: (docId, peer) => {
    // Control which peers see which documents
    if (docId.startsWith("input:")) return peer.peerId === docId.slice(6)
    return true
  },
  authorize: (docId, peer) => {
    // Control whose mutations are accepted
    if (docId === "game-state") return false // only server writes
    return true
  },
})
```

### Route and Authorize

Two predicates control information flow through the sync protocol:

- **`route(docId, peer) → boolean`** — Outbound flow control. Determines which peers participate in the sync graph for each document. Checked at every outbound gate: initial discover, doc-ensure broadcast, relay push, local change push. Also gates `onDocDiscovered` — if `route` returns `false` for the announcing peer, the callback never fires. Storage channels bypass this check. Defaults to `() => true`.

- **`authorize(docId, peer) → boolean`** — Inbound flow control. Determines whose mutations are accepted. Checked before importing offers from network peers. When rejected, the offer is silently dropped but peer sync state is still updated to prevent re-requesting. Storage channels bypass this check. Defaults to `() => true`.

### Dynamic Document Creation (`onDocDiscovered`)

When a peer announces a document your exchange doesn't have, the `onDocDiscovered` callback lets you create it on demand. Return a `BoundSchema` to auto-create and sync, or `undefined` to ignore:

```ts
const PlayerInputDoc = bindEphemeral(Schema.doc({
  force: Schema.number(),
  angle: Schema.number(),
}))

const exchange = new Exchange({
  identity: { name: "server" },
  adapters: [serverAdapter],
  onDocDiscovered: (docId, peer) => {
    if (docId.startsWith("input:")) return PlayerInputDoc
    return undefined
  },
})
```

This enables patterns where clients create per-peer documents (e.g. `input:${peerId}`) and the server materializes them automatically when the client connects. No pre-coordination required — the `route` predicate is checked first (the callback only fires if routing allows it), then returning `undefined` is equivalent to denying creation.

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

| Method / Option | Description |
|----------------|-------------|
| `get(docId, boundSchema)` | Get or create a document. Returns `Ref<S>`. |
| `has(docId)` | Check if a document exists. |
| `dismiss(docId)` | Leave the sync graph for a document — removes locally and broadcasts `dismiss` to peers. |
| `flush()` | Await all pending storage operations. |
| `shutdown()` | Flush + disconnect all adapters. |
| `reset()` | Disconnect adapters and clear state (synchronous). |
| `addAdapter(adapter)` | Add an adapter at runtime. |
| `removeAdapter(adapterId)` | Remove an adapter at runtime. |
| `route` | Constructor option. `(docId, peer) → boolean` — outbound flow control. Default: `() => true`. |
| `authorize` | Constructor option. `(docId, peer) → boolean` — inbound flow control. Default: `() => true`. |
| `onDocDiscovered` | Constructor option. `(docId, peer) → BoundSchema \| undefined` — dynamic doc creation. |
| `onDocDismissed` | Constructor option. `(docId, peer) → void` — react to peer leaving a document. |

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
| `bindEphemeral(schema)` | `@kyneta/schema` | LWW substrate (TimestampVersion) + LWW broadcast strategy. Ideal for ephemeral/presence state. |
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

### Network Adapters

| Adapter | Transport | Package |
|---------|-----------|---------|
| `@kyneta/websocket-network-adapter` | WebSocket (binary CBOR) | `packages/exchange/network-adapters/websocket` |
| `@kyneta/sse-network-adapter` | SSE + HTTP POST (text JSON) | `packages/exchange/network-adapters/sse` |

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