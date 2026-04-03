# @kyneta/exchange

Substrate-agnostic state exchange for `@kyneta/schema`. Provides sync infrastructure for any substrate type — Loro CRDTs, Yjs CRDTs, plain JS objects, LWW ephemeral state — through a four-message sync protocol (`present`, `interest`, `offer`, `dismiss`) over a two-message handshake (`establish-request`, `establish-response`).

## Getting Started

```ts
import { Exchange, sync } from "@kyneta/exchange"
import { createWebsocketClient } from "@kyneta/websocket-transport/client"
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
  identity: { peerId: "alice", name: "Alice" },
  transports: [createWebsocketClient({ url: "ws://localhost:3000/ws" })],
})

// 3. Get a typed document
const doc = exchange.get("my-todos", TodoDoc)

// 4. Read and write (starts with Zero defaults — empty strings, 0, false, [])
change(doc, d => {
  d.title.set("My Todos")
  d.items.push({ text: "Learn Exchange", done: false })
})

doc.title()  // "My Todos"

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
import { Schema, bindPlain, bindEphemeral } from "@kyneta/schema"
import { bindLoro, LoroSchema } from "@kyneta/loro-schema"
import { bindYjs } from "@kyneta/yjs-schema"

// Collaborative text — Loro CRDT with causal merge
const TodoDoc = bindLoro(LoroSchema.doc({
  title: LoroSchema.text(),
  items: Schema.list(Schema.struct({ name: Schema.string() })),
}))

// Collaborative text — Yjs CRDT with causal merge
const NoteDoc = bindYjs(Schema.doc({
  body: Schema.annotated("text"),
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
| `"causal"` | Bidirectional exchange | Partial (concurrent possible) | Loro / Yjs CRDTs |
| `"sequential"` | Request/response | Total (no concurrency) | Plain substrates |
| `"lww"` | Unidirectional broadcast | Total (timestamp-based) | Ephemeral/presence |

### Sync Protocol

Four exchange message types handle document sync:

- **`present`** — "I have these documents." Each entry carries `docId`, `replicaType`, `mergeStrategy`, and `schemaHash` so the receiver can validate compatibility before any binary exchange. Filtered by `route`.
- **`interest`** — "I want document X. Here's my version." Carries `reciprocate` for causal bidirectional exchange.
- **`offer`** — "Here is state for document X." Carries an opaque `SubstratePayload` (the exchange never inspects it). Gated by `authorize`.
- **`dismiss`** — "I'm leaving document X." Triggers `onDocDismissed`.

Two additional messages (`establish-request`, `establish-response`) handle channel handshake. The merge strategy determines *when* and *how* messages are sent, not their shape.

### Heterogeneous Documents

A single exchange can host documents backed by different substrate types simultaneously:

```ts
const exchange = new Exchange({
  identity: { peerId: "alice", name: "Alice" },
  transports: [networkTransport],
})

const doc = exchange.get("collab-doc", TodoDoc)       // Loro CRDT
const config = exchange.get("settings", ConfigDoc)     // Plain sequential
const presence = exchange.get("presence", PresenceDoc) // LWW broadcast
```

No `substrates` record needed — each document's substrate is determined by its BoundSchema.

### The Exchange

The `Exchange` class is the central orchestrator. It manages document lifecycle, coordinates transports and stores, and runs sync algorithms on behalf of passive substrates.

```ts
const exchange = new Exchange({
  identity: { peerId: "alice", name: "Alice", type: "user" },
  transports: [networkTransport],
  stores: [createInMemoryStore()],
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

> **Note:** `exchange.get()` requires an explicit `peerId` in the identity. The peerId identifies this exchange as a participant in causal history and must be stable across restarts for correct CRDT operation. For browser clients, use `persistentPeerId(storageKey)` — it generates a random peerId on first visit and caches it in `localStorage`.

### Route and Authorize

Two predicates control information flow through the sync protocol:

- **`route(docId, peer) → boolean`** — Outbound flow control. Determines which peers participate in the sync graph for each document. Checked at every outbound gate: initial `present`, doc-ensure broadcast, relay push, local change push. Also gates `onDocDiscovered` — if `route` returns `false` for the announcing peer, the callback never fires. Defaults to `() => true`.

- **`authorize(docId, peer) → boolean`** — Inbound flow control. Determines whose mutations are accepted. Checked before importing offers from network peers. When rejected, the offer is silently dropped but peer sync state is still updated to prevent re-requesting. Defaults to `() => true`.

### Interpret vs. Replicate

Documents participate in the exchange at one of two tiers:

- **Interpret** — Full schema-driven interpretation with `Ref<S>`, changefeed, reads and writes. Created via `exchange.get(docId, bound)`. This is the default for client apps and application servers.

- **Replicate** — Headless replication with a bare `Replica<V>`: version tracking, export/import, per-peer delta computation — but no schema, no ref, no changefeed. Created via `exchange.replicate(docId, replicaFactory, strategy, schemaHash)`. This is the correct tier for relay servers, routing servers, and storage services.

```ts
import { Interpret, Replicate } from "@kyneta/schema"
import { loroReplicaFactory } from "@kyneta/loro-schema"

// Client — full interpretation
exchange.get("shared-doc", TodoDoc)

// Relay server — headless replication (no schema knowledge needed)
exchange.replicate("shared-doc", loroReplicaFactory, "causal", schemaHash)
```

### Dynamic Document Creation (`onDocDiscovered`)

When a peer announces a document your exchange doesn't have, the `onDocDiscovered` callback lets you create it on demand. Return a disposition — `Interpret(bound)` for full interpretation, `Replicate(replicaFactory, strategy, schemaHash)` for headless replication, or `undefined` to ignore:

```ts
import { Interpret, Replicate } from "@kyneta/schema"
import { loroReplicaFactory } from "@kyneta/loro-schema"

const PlayerInputDoc = bindEphemeral(Schema.doc({
  force: Schema.number(),
  angle: Schema.number(),
}))

// Game server — interpret player inputs
const gameExchange = new Exchange({
  identity: { peerId: "game-server", name: "server" },
  transports: [serverTransport],
  onDocDiscovered: (docId, peer) => {
    if (docId.startsWith("input:")) return Interpret(PlayerInputDoc)
    return undefined
  },
})

// Relay server — replicate everything without schema knowledge
const relayExchange = new Exchange({
  identity: { peerId: "relay", name: "relay", type: "service" },
  transports: [upstreamTransport, downstreamTransport],
  onDocDiscovered: (docId, peer, replicaType, mergeStrategy, schemaHash) => {
    return Replicate(loroReplicaFactory, mergeStrategy, schemaHash)
  },
})
```

The `onDocDiscovered` callback receives `(docId, peer, replicaType, mergeStrategy, schemaHash)` — the full metadata from the peer's `present` message — so the receiver can make an informed decision without compile-time schema knowledge.

### Storage

The exchange supports persistent storage through **stores** — a first-class constructor parameter, separate from transports. Documents are automatically persisted on mutation and hydrated on restart — no manual save/load needed.

```ts
import { Exchange, createInMemoryStore } from "@kyneta/exchange"

const exchange = new Exchange({
  identity: { peerId: "server", name: "server" },
  transports: [networkTransport],
  stores: [createInMemoryStore()],
})

const doc = exchange.get("my-doc", TodoDoc)
// Mutations are automatically persisted via onStateAdvanced
```

For testing persist → restart → hydrate flows, use `sharedData` to share storage state between exchange instances:

```ts
import type { InMemoryStoreData } from "@kyneta/exchange"

const sharedData: InMemoryStoreData = {
  entries: new Map(),
  metadata: new Map(),
}

// Exchange 1: create and mutate a document
const exchange1 = new Exchange({
  identity: { peerId: "server", name: "server" },
  stores: [createInMemoryStore({ sharedData })],
})
const doc = exchange1.get("my-doc", TodoDoc)
change(doc, d => d.title.set("Saved"))
await exchange1.shutdown()

// Exchange 2: hydrate from storage
const exchange2 = new Exchange({
  identity: { peerId: "server", name: "server" },
  stores: [createInMemoryStore({ sharedData })],
  onDocDiscovered: (docId) => Interpret(TodoDoc),
})
// "my-doc" is restored from storage automatically
```

For production persistence, implement the `Store` interface for your backend (Postgres, IndexedDB, S3, etc.) or use `@kyneta/leveldb-store` for server-side LevelDB storage:

```ts
import { createLevelDBStore } from "@kyneta/leveldb-store/server"

const exchange = new Exchange({
  identity: { peerId: "server", name: "server" },
  stores: [createLevelDBStore("./data/exchange-db")],
  transports: [networkTransport],
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
await sync(doc).waitForSync({ timeout: 5000 })

sync(doc).onReadyStateChange(states => {
  console.log("Sync status:", states)
})
```

### Peer Lifecycle

The exchange tracks which peers are currently connected via `exchange.peers` — a `CallableChangefeed` that emits join/leave events. A peer "joins" when its first channel completes the establish handshake; it "leaves" when its last channel is removed.

```ts
// Read current peers
const peers = exchange.peers()  // ReadonlyMap<PeerId, PeerIdentityDetails>

// Subscribe to changes
exchange.peers.subscribe((changeset) => {
  for (const change of changeset.changes) {
    if (change.type === "peer-joined") {
      console.log(`${change.peer.name ?? change.peer.peerId} joined`)
    } else {
      console.log(`${change.peer.name ?? change.peer.peerId} left`)
    }
  }
})
```

When a peer connects through multiple transports (e.g. both WebSocket and SSE), the exchange deduplicates at the peer level — `peer-joined` fires once on the first channel, and `peer-left` fires only when *all* channels for that peer are gone.

On `exchange.shutdown()` or `exchange.reset()`, synthetic `peer-left` events are emitted for all currently connected peers before state is wiped, so subscribers always see a clean leave for every join.

### Escape Hatches

Two escape hatches provide access to the underlying substrate:

```ts
// General — returns the Substrate<any> backing a ref
import { unwrap } from "@kyneta/schema"
const substrate = unwrap(doc)
substrate.version().serialize()  // current version string
substrate.exportEntirety()       // full state payload

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
| `get(docId, boundSchema)` | Get or create a document in interpret mode. Returns `Ref<S>`. Requires explicit `peerId`. |
| `replicate(docId, replicaFactory, strategy, schemaHash)` | Register a document for headless replication. No schema, no ref, no changefeed. |
| `has(docId)` | Check if a document exists (interpret or replicate mode). |
| `dismiss(docId)` | Leave the sync graph — removes locally, broadcasts `dismiss`, deletes from stores. |
| `peers` | `CallableChangefeed<ReadonlyMap<PeerId, PeerIdentityDetails>, PeerChange>` — reactive peer presence feed. Callable as a function, subscribable for changes. |
| `flush()` | Await all pending storage operations without disconnecting. |
| `shutdown()` | Flush stores, disconnect transports, close store handles. The recommended graceful teardown. |
| `reset()` | Disconnect transports and clear state (synchronous). Does NOT flush pending storage. |
| `addTransport(transport)` | Add a transport at runtime. |
| `removeTransport(transportId)` | Remove a transport at runtime. |
| `hasTransport(transportId)` | Check if a transport exists by ID. |
| `getTransport(transportId)` | Get a transport by ID. |
| `identity` | Constructor option. `{ peerId, name?, type? }` — peer identity. `peerId` required for `get()`. |
| `transports` | Constructor option. `TransportFactory[]` — network connectivity. |
| `stores` | Constructor option. `Store[]` — persistent storage backends. |
| `route` | Constructor option. `(docId, peer) → boolean` — outbound flow control. Default: `() => true`. |
| `authorize` | Constructor option. `(docId, peer) → boolean` — inbound flow control. Default: `() => true`. |
| `onDocDiscovered` | Constructor option. `(docId, peer, replicaType, mergeStrategy, schemaHash) → Interpret \| Replicate \| undefined`. |
| `onDocDismissed` | Constructor option. `(docId, peer) → void` — react to peer leaving a document. |

### sync()

| Property/Method | Description |
|----------------|-------------|
| `peerId` | The local peer ID. |
| `docId` | The document ID. |
| `readyStates` | Current `ReadyState[]` — sync status with all peers. Each entry has `{ docId, identity, status }` where status is `"pending" \| "synced" \| "absent"`. |
| `waitForSync(opts?)` | Wait for sync to complete. Options: `{ timeout?: number }` (default 30000ms). |
| `onReadyStateChange(cb)` | Subscribe to sync status changes. Returns unsubscribe function. |

### Bind Functions

| Function | Package | Description |
|----------|---------|-------------|
| `bind({ schema, factory, strategy })` | `@kyneta/schema` | General primitive — explicit schema, factory builder, strategy. |
| `bindPlain(schema)` | `@kyneta/schema` | Plain substrate + sequential strategy. |
| `bindEphemeral(schema)` | `@kyneta/schema` | LWW substrate (TimestampVersion) + LWW broadcast strategy. Ideal for ephemeral/presence state. |
| `bindLoro(schema)` | `@kyneta/loro-schema` | Loro substrate + causal strategy. |
| `bindYjs(schema)` | `@kyneta/yjs-schema` | Yjs substrate + causal strategy. |

### Disposition Constructors

| Function | Package | Description |
|----------|---------|-------------|
| `Interpret(bound)` | `@kyneta/schema` | Full interpretation — schema, ref, changefeed. For `onDocDiscovered`. |
| `Replicate(replicaFactory, strategy, schemaHash)` | `@kyneta/schema` | Headless replication — no schema, no ref. For `onDocDiscovered`. |

### Escape Hatches

| Function | Package | Description |
|----------|---------|-------------|
| `unwrap(ref)` | `@kyneta/schema` | Returns the `Substrate<any>` backing a ref. |
| `loro(ref)` | `@kyneta/loro-schema` | Returns the `LoroDoc` backing a Loro-backed ref. |

### Transports

| Export | Description |
|--------|-------------|
| `Transport<G>` | Abstract base class for transports. |
| `TransportManager` | Manages transport lifecycle and message routing. |
| `TransportFactory` | `() => Transport<any>` — factory function for lazy construction. |
| `BridgeTransport` | In-process transport for testing. |
| `Bridge` | Message router connecting BridgeTransports. |
| `createBridgeTransport(params)` | Factory function for `BridgeTransport`. |
| `ClientStateMachine` | Reconnecting client state machine (connect → open → closed → reconnect). |

### Storage

| Export | Description |
|--------|-------------|
| `Store` | Interface for persistent storage backends (8 methods: `lookup`, `ensureDoc`, `append`, `loadAll`, `replace`, `delete`, `listDocIds`, `close?`). |
| `StoreEntry` | Type for stored entries: `{ payload: SubstratePayload, version: string }`. |
| `InMemoryStore` | Map-backed store for testing. |
| `InMemoryStoreData` | Shared data type (`{ entries, metadata }`) for cross-instance persistence in tests. |
| `createInMemoryStore(opts?)` | Factory returning a `Store`. Pass `{ sharedData }` for shared state. |

### TimestampVersion

| Method | Description |
|--------|-------------|
| `new TimestampVersion(ts)` | Create from a millisecond timestamp. |
| `TimestampVersion.now()` | Create from the current wall clock. |
| `TimestampVersion.parse(s)` | Deserialize from string. |
| `serialize()` | Serialize to decimal string. |
| `compare(other)` | `"behind"`, `"equal"`, or `"ahead"` (never `"concurrent"`). |

### Utility

| Export | Description |
|--------|-------------|
| `persistentPeerId(storageKey)` | Browser-only: generate a random peerId on first visit, cache in `localStorage` for stability across reloads. |

## Transports

Transports provide pluggable network connectivity. They create channels — the communication primitive — which the exchange uses for message routing. Storage is handled separately via the `stores` constructor parameter.

### Built-in

| Transport | Use Case |
|-----------|----------|
| `BridgeTransport` | In-process testing of multi-peer scenarios |

### Network Transports

| Package | Protocol | Encoding |
|---------|----------|----------|
| `@kyneta/websocket-transport` | WebSocket | Binary CBOR via `@kyneta/wire` |
| `@kyneta/sse-transport` | SSE + HTTP POST | Text JSON via `@kyneta/wire` |
| `@kyneta/webrtc-transport` | WebRTC Data Channel | Binary CBOR via `@kyneta/wire` |
| `@kyneta/unix-socket-transport` | Unix Domain Socket | Binary CBOR via `@kyneta/wire` |

The websocket and SSE packages export `/client` and `/server` entry points. The websocket transport also exports `/bun` for Bun-native WebSocket servers. The WebRTC transport uses a BYODC (Bring Your Own Data Channel) pattern — you provide an `RTCDataChannel` and the transport wraps it as an exchange channel. The unix socket transport exports `/client` and `/server` entry points — stream-oriented, backpressure-aware, no fragmentation. Designed for server-to-server sync over Unix domain sockets.

### Creating Custom Transports

Extend the `Transport<G>` base class. The generic parameter `G` represents the arguments needed to generate a channel — for example, `@kyneta/webrtc-transport` uses `G = RTCDataChannel`, implementing the BYODC (Bring Your Own Data Channel) pattern where callers supply an externally-negotiated data channel:

```ts
import { Transport } from "@kyneta/exchange"

class MyTransport extends Transport<void> {
  constructor() {
    super({ transportType: "my-transport" })
  }

  generate() {
    return {
      transportType: this.transportType,
      send: (msg) => { /* send over your wire */ },
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
    "@kyneta/schema": "^1.1.0"
  }
}
```

## License

MIT