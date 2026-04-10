# @kyneta/exchange

Define your data's shape. Get sync, persistence, and presence — across any number of peers, over any transport, with any CRDT or none.

```ts
import { Exchange, sync } from "@kyneta/exchange"
import { createWebsocketClient } from "@kyneta/websocket-transport/client"
import { loro } from "@kyneta/loro-schema"
import { Schema, change } from "@kyneta/schema"

const TodoDoc = loro.bind(Schema.struct({
  title: Schema.text(),
  items: Schema.list(
    Schema.struct.json({
      text: Schema.string(),
      done: Schema.boolean(),
    }),
  ),
}))

const exchange = new Exchange({
  identity: { peerId: "alice" },
  transports: [createWebsocketClient({ url: "ws://localhost:3000/ws" })],
})

const doc = exchange.get("my-todos", TodoDoc)

change(doc, d => {
  d.title.insert(0, "My Todos")
  d.items.push({ text: "Learn Exchange", done: false })
})

doc.title()  // "My Todos"

await sync(doc).waitForSync()  // ✓ synced with all connected peers
```

That's a collaborative CRDT document, syncing over WebSocket, with full TypeScript types. Every connected peer running this code converges automatically — concurrent edits merge, no data-level conflicts, no manual resolution.

The same schema works with Loro CRDTs, Yjs CRDTs, plain JS objects, or ephemeral presence state — in the same exchange, over the same connections.

> 314 tests · 4 transport protocols · WebSocket, SSE, WebRTC, Unix socket

---

## The Same App, Three Perspectives

The exchange's key insight is that different participants in a sync network need different levels of involvement with the same data. A client reads and writes. A relay forwards without understanding. A server reads selectively.

One protocol handles all three. The difference is a single line of configuration.

**The Client** — full interpretation. Typed reads, writes, changefeed, the works.

```ts
const exchange = new Exchange({
  identity: { peerId: "alice" },
  transports: [createWebsocketClient({ url: "ws://localhost:3000/ws" })],
})

const doc = exchange.get("shared-doc", TodoDoc)
doc.title()  // typed read
change(doc, d => d.title.insert(0, "Hello"))  // typed write
subscribe(doc, changeset => { /* reactive */ })
```

**The Relay** — headless replication. No schemas, no application types. Just "hold state and forward it."

```ts
import { loro } from "@kyneta/loro-schema"

const relay = new Exchange({
  identity: { peerId: "relay", type: "service" },
  transports: [
    createWebsocketClient({ url: "ws://upstream:3000/ws" }),
    createWebsocketClient({ url: "ws://downstream:3001/ws" }),
  ],
  replicas: [loro.replica()],
  onUnresolvedDoc: () => Replicate(),
})
```

> Plain and ephemeral replicas are built-in — `replicas` is only needed when relaying CRDT documents (Loro, Yjs).

**The Application Server** — selective interpretation. Understand some documents, ignore others.

```ts
const server = new Exchange({
  identity: { peerId: "game-server" },
  transports: [serverTransport],
  onUnresolvedDoc: (docId, peer) => {
    if (docId.startsWith("input:")) return Interpret(PlayerInputDoc)
    return Reject()
  },
})
```

These three peers join the same network. The exchange negotiates the right sync behavior for each — the client gets full CRDT merge, the relay gets opaque binary forwarding, the server gets typed access to just the documents it cares about.

---

## Growing Without Rewriting

Most distributed state systems unintentionally punish exploration. A common story:
- You start with plain JSON messages over WebSocket.
- Then you need durable delivery, offline support, and need to rewrite for persistence.
- Then you need multi-device or multi-player, and conflict resolution, and need to rewrite for CRDTs.
- Then you need a more complex topology for production, perhaps with relay nodes or fan-out, and you need to backtrack to duplicate your types on the server.
- Then you need presence, so it's natural to bolt on a second protocol.
 
But every step invalidates the previous work done, in order to accommodate the new problem space you're exploring.

The exchange is designed so that each capability is additive. You engage the next level when you need it, without rewriting what came before.

### Without an exchange — `@kyneta/schema` on its own

```ts
const doc = createDoc(Schema.struct({ theme: Schema.string() }))
doc.theme.set("dark")
doc.theme()  // "dark"
```

When you need that document to sync across peers, the exchange wraps the same schema. Your reads and writes don't change.

### Two peers, one writer — the simplest distributed case

```ts
const ConfigDoc = json.bind(Schema.struct({ theme: Schema.string() }))

// Peer A — creates the document and writes
const exchangeA = new Exchange({
  identity: { peerId: "alice" },
  transports: [createWebsocketClient({ url: "ws://localhost:3000/ws" })],
})
const docA = exchangeA.get("config", ConfigDoc)
docA.theme.set("dark")

// Peer B — opens the same document and waits for data to arrive
const exchangeB = new Exchange({
  identity: { peerId: "bob" },
  transports: [createWebsocketClient({ url: "ws://localhost:3000/ws" })],
})
const docB = exchangeB.get("config", ConfigDoc)
await sync(docB).waitForSync()
docB.theme()  // "dark"
```

### Switch to multi-writer — change the bind, not the reads/writes

```ts
// Before: plain JS with sequential sync
const ConfigDoc = json.bind(Schema.struct({ theme: Schema.string() }))

// After: Loro CRDT with concurrent merge — concurrent edits converge
const ConfigDoc = loro.bind(Schema.struct({ theme: Schema.string() }))

// Everything else is unchanged:
const doc = exchange.get("config", ConfigDoc)
doc.theme.set("dark")
doc.theme()  // same API, now backed by a CRDT
```

### Add persistence — one line

```ts
const exchange = new Exchange({
  identity: { peerId: "server" },
  transports: [serverTransport],
  stores: [createLevelDBStore("./data/exchange-db")],  // ← new
})
// Documents auto-hydrate on restart, auto-persist on mutation
```

### Add presence alongside your documents — same exchange

```ts
const PresenceDoc = json.bind(Schema.struct({
  cursor: Schema.struct({
    x: Schema.number(),
    y: Schema.number()
  }),
  name: Schema.string(),
}), "ephemeral")

// Same exchange, same transport connections, different sync strategy
const doc = exchange.get("shared-doc", TodoDoc)          // Loro CRDT, concurrent merge
const presence = exchange.get("my-presence", PresenceDoc) // ephemeral broadcast
```

### Add access control — one predicate

```ts
const exchange = new Exchange({
  identity: { peerId: "server" },
  transports: [serverTransport],
  route: (docId, peer) => {  // ← new: outbound flow control
    if (docId.startsWith("input:")) return peer.peerId === docId.slice(6)
    return true
  },
  authorize: (docId, peer) => {  // ← new: inbound flow control
    if (docId === "game-state") return false  // only server writes
    return true
  },
})
```

### Add a relay — no client changes

```ts
// The relay has zero knowledge of your schemas.
// Plain and ephemeral replicas are built-in; add CRDT replicas if relaying Loro/Yjs docs.
const relay = new Exchange({
  identity: { peerId: "relay", type: "service" },
  transports: [
    createWebsocketClient({ url: "ws://upstream:3000/ws" }),
    createWebsocketClient({ url: "ws://downstream:3001/ws" }),
  ],
  replicas: [loro.replica()],
  onUnresolvedDoc: () => Replicate(),
})
```

Each step is one or two lines that don't invalidate the previous step. Your reads, writes, subscriptions, and tests survive every transition.

---

## Why This Works

### One declaration, three decisions

A `BoundSchema` captures the three choices that define a document type:

1. **Schema** — what shape is the data?
2. **Factory** — how is the data stored and versioned?
3. **Strategy** — how does the exchange sync it?

```ts
import { Schema, json } from "@kyneta/schema"
import { loro } from "@kyneta/loro-schema"
import { yjs } from "@kyneta/yjs-schema"

// Collaborative document — Loro CRDT with concurrent merge
const TodoDoc = loro.bind(Schema.struct({
  title: Schema.text(),
  items: Schema.list(Schema.struct.json({ name: Schema.string() })),
}))

// Collaborative text — Yjs CRDT with concurrent merge
const NoteDoc = yjs.bind(Schema.struct({
  body: Schema.annotated("text"),
}))

// Config data — plain substrate with sequential sync
const ConfigDoc = json.bind(Schema.struct({ theme: Schema.string() }))

// Ephemeral presence — ephemeral broadcast, only the latest value matters
const PresenceDoc = json.bind(Schema.struct({
  cursor: Schema.struct({ x: Schema.number(), y: Schema.number() }),
  name: Schema.string(),
}), "ephemeral")
```

BoundSchemas are static declarations, defined at module scope. They can be shared across multiple exchange instances — each exchange calls the factory builder independently, producing a fresh factory with the correct peer identity.

For custom substrates, use `bind()` directly as the general primitive, and `createSubstrateNamespace` to build custom namespace objects:

```ts
import { bind, createSubstrateNamespace } from "@kyneta/schema"

// bind() is the general primitive — explicit schema, factory builder, strategy
const CustomDoc = bind({
  schema: Schema.struct({ data: Schema.string() }),
  factory: (ctx) => createMyFactory(ctx.peerId),
  strategy: "concurrent",
})

// createSubstrateNamespace builds a namespace object like json/loro/yjs
const mySubstrate = createSubstrateNamespace({
  factory: (ctx) => createMyFactory(ctx.peerId),
  strategy: "concurrent",
})

const AnotherDoc = mySubstrate.bind(Schema.struct({ data: Schema.string() }))
const replica = mySubstrate.replica()
```

### Three merge strategies, one protocol

Each BoundSchema declares a merge strategy that determines how the exchange syncs documents of that type. These are genuinely different sync algorithms, not transport optimizations:

| Strategy | Protocol | Version Order | Use Case |
|----------|----------|---------------|----------|
| `"concurrent"` | Bidirectional exchange | Partial (concurrent possible) | Loro / Yjs CRDTs |
| `"sequential"` | Request/response | Total (no concurrency) | Plain substrates |
| `"ephemeral"` | Unidirectional broadcast | Total (timestamp-based) | Ephemeral/presence |

All three run over the same four-message sync protocol:

- **`present`** — "I have these documents." Carries `docId`, `replicaType`, `mergeStrategy`, and `schemaHash` so the receiver can validate compatibility before any data exchange.
- **`interest`** — "I want document X. Here's my version." Carries `reciprocate` for concurrent bidirectional exchange.
- **`offer`** — "Here is state for document X." Carries an opaque `SubstratePayload` — the exchange never inspects the bytes.
- **`dismiss`** — "I'm leaving document X."

Two additional messages (`establish-request`, `establish-response`) handle channel handshake. The merge strategy determines *when* and *how* these messages are sent, not their shape.

### The exchange never inspects your data

This is the architectural decision that makes substrate agnosticism real. The exchange dispatches on `MergeStrategy` to decide protocol behavior, but actual document payloads are opaque `SubstratePayload` values. The exchange moves bytes; the substrate interprets them. This means:

- A Loro document, a Yjs document, a plain JS object, and an ephemeral value all flow through the same protocol.
- A relay can forward documents without knowing what CRDT library produced them.
- You can implement a new substrate by satisfying the `Substrate<V>` interface — no exchange changes needed.

### Four dispositions

When a peer announces a document, your exchange decides how to participate:

| Disposition | What happens | Created by |
|-------------|-------------|------------|
| **Interpret** | Full schema-driven interpretation — `Ref<S>`, changefeed, reads, writes | `exchange.get(docId, bound)` |
| **Replicate** | Headless replication — version tracking, export/import, no schema | `exchange.replicate(docId)` or `onUnresolvedDoc: () => Replicate()` |
| **Defer** | Track for routing but don't replicate yet — promotable later | `onUnresolvedDoc: () => Defer()` |
| **Reject** | Refuse to track the document at all | `onUnresolvedDoc: () => Reject()` |

The two-tiered default (when no `onUnresolvedDoc` callback matches): documents whose replica type is supported get **deferred** (promotable via a later `exchange.get()` or `registerSchema()`), while documents with unsupported replica types are silently **rejected**.

---

## Core Concepts

### The Exchange

The `Exchange` class is the central orchestrator. It manages document lifecycle, coordinates transports and stores, and runs sync algorithms on behalf of passive substrates.

```ts
const exchange = new Exchange({
  identity: { peerId: "alice", name: "Alice", type: "user" },
  transports: [networkTransport],
  stores: [createInMemoryStore()],
  route: (docId, peer) => {
    // Outbound flow control — which peers see which documents
    if (docId.startsWith("input:")) return peer.peerId === docId.slice(6)
    return true
  },
  authorize: (docId, peer) => {
    // Inbound flow control — whose mutations are accepted
    if (docId === "game-state") return false
    return true
  },
})
```

> **Peer identity:** `peerId` identifies this exchange as a participant in causal history and must be stable across restarts for correct CRDT operation. For browser clients, use `persistentPeerId(storageKey)` — it generates a random peerId on first visit and caches it in `localStorage`.

### Heterogeneous Documents

A single exchange hosts documents backed by different substrate types simultaneously:

```ts
const doc = exchange.get("collab-doc", TodoDoc)       // Loro CRDT, concurrent merge
const config = exchange.get("settings", ConfigDoc)     // Plain JSON, sequential sync
const presence = exchange.get("presence", PresenceDoc) // ephemeral broadcast
```

Each document's substrate and sync strategy are determined by its BoundSchema. No configuration needed at the exchange level.

### Route and Authorize

Two predicates control information flow:

- **`route(docId, peer) → boolean`** — Outbound. Which peers participate in the sync graph for each document. Checked at every outbound gate: present, push, relay. Also gates `onUnresolvedDoc` — if route returns `false` for the announcing peer, the callback never fires. Default: `() => true`.

- **`authorize(docId, peer) → boolean`** — Inbound. Whose mutations are accepted. Checked before importing offers. When rejected, the offer is silently dropped. Default: `() => true`.

### Dynamic Document Creation

**`onUnresolvedDoc`** fires when a peer announces a document your exchange doesn't know about. Return a disposition:

```ts
import { Interpret, Replicate, Defer, Reject } from "@kyneta/schema"

const gameExchange = new Exchange({
  identity: { peerId: "game-server" },
  transports: [serverTransport],
  onUnresolvedDoc: (docId, peer, replicaType, mergeStrategy, schemaHash) => {
    if (docId.startsWith("input:")) return Interpret(PlayerInputDoc)
    if (docId.startsWith("ephemeral:")) return Defer()
    return Reject()
  },
})
```

The callback receives the full metadata from the peer's `present` message — so the receiver can make an informed decision without compile-time schema knowledge.

**`schemas`** enables auto-resolve without a callback. Register schemas upfront and the exchange auto-interprets matching documents:

```ts
const exchange = new Exchange({
  identity: { peerId: "alice" },
  schemas: [TodoDoc, ConfigDoc],  // auto-interpret when peers announce these
})
```

**`onDocCreated`** fires for every document creation — local `get()`, remote auto-resolve, `onUnresolvedDoc`, or deferred promotion:

```ts
const exchange = new Exchange({
  identity: { peerId: "server" },
  schemas: [PlayerInputDoc],
  onDocCreated(docId, peer, mode, origin) {
    if (origin === "remote" && docId.startsWith("input:")) {
      const inputDoc = exchange.get(docId, PlayerInputDoc)
      registerPlayer(peer.peerId, inputDoc)
    }
  },
})
```

Use `onUnresolvedDoc` to decide **what to do**. Use `onDocCreated` to observe **what happened**.

### Storage

Stores are a first-class constructor parameter, separate from transports. Documents auto-persist on mutation and auto-hydrate on restart:

```ts
import { createLevelDBStore } from "@kyneta/leveldb-store/server"

const exchange = new Exchange({
  identity: { peerId: "server" },
  stores: [createLevelDBStore("./data/exchange-db")],
  transports: [networkTransport],
})

const doc = exchange.get("my-doc", TodoDoc)
// Mutations are automatically persisted. On restart, documents hydrate from storage.
```

For testing, use `createInMemoryStore()` with shared state to simulate persist → restart → hydrate flows:

```ts
const sharedData: InMemoryStoreData = { entries: new Map(), metadata: new Map() }

const exchange1 = new Exchange({
  identity: { peerId: "server" },
  stores: [createInMemoryStore({ sharedData })],
})
const doc = exchange1.get("my-doc", TodoDoc)
doc.title.set("Saved")
await exchange1.shutdown()

const exchange2 = new Exchange({
  identity: { peerId: "server" },
  stores: [createInMemoryStore({ sharedData })],
  onUnresolvedDoc: () => Interpret(TodoDoc),
})
// "my-doc" is restored from storage automatically
```

### Sync Status

```ts
import { sync } from "@kyneta/exchange"

const doc = exchange.get("doc-id", MyDoc)

sync(doc).peerId        // your peer ID
sync(doc).docId         // document ID
sync(doc).readyStates   // sync status with all peers

await sync(doc).waitForSync()
await sync(doc).waitForSync({ timeout: 5000 })

sync(doc).onReadyStateChange(states => {
  console.log("Sync status:", states)
})
```

### Peer Lifecycle

`exchange.peers` is a reactive feed of connected peers — callable as a function, subscribable for changes:

```ts
const peers = exchange.peers()  // ReadonlyMap<PeerId, PeerIdentityDetails>

exchange.peers.subscribe(changeset => {
  for (const change of changeset.changes) {
    if (change.type === "peer-joined") {
      console.log(`${change.peer.name ?? change.peer.peerId} joined`)
    } else {
      console.log(`${change.peer.name ?? change.peer.peerId} left`)
    }
  }
})
```

Multi-transport deduplication: when a peer connects through multiple transports (e.g. both WebSocket and SSE), `peer-joined` fires once on the first channel, `peer-left` fires only when *all* channels are gone. On `shutdown()` or `reset()`, synthetic `peer-left` events are emitted for all connected peers.

### Escape Hatches

Access the underlying substrate when you need to:

```ts
// General — returns the Substrate<any> backing a ref
import { unwrap } from "@kyneta/schema"
const substrate = unwrap(doc)
substrate.version().serialize()
substrate.exportEntirety()

// Loro-specific — returns the raw LoroDoc
import { loro } from "@kyneta/loro-schema"
const loroDoc = loro.unwrap(doc)
loroDoc.toJSON()
```

---

## Complexity Gradient

| Level | What you write | What you get |
|-------|----------------|--------------|
| **Trivial** | `exchange.get("doc", MyDoc)` | Typed, syncable, observable document |
| **Standard** | Add `transports`, `stores` | Network sync + persistence |
| **Intermediate** | Add `route`, `authorize`, `onUnresolvedDoc` | Information flow control, dynamic doc creation |
| **Advanced** | `register()` scopes, `Line`, custom transports | Composable rules, reliable messaging, custom protocols |
| **Expert** | Custom `Substrate<V>` implementation | New CRDT runtimes, new state models |

You only engage the next level when you need it. Each level is additive — it doesn't rewrite the previous one.

---

## API Reference

### Exchange

| Method / Option | Description |
|----------------|-------------|
| `get(docId, boundSchema)` | Get or create a document in interpret mode. Returns `Ref<S>`. Auto-registers the schema in the capabilities registry. |
| `replicate(docId)` | Promote a deferred document — factory resolved from the capabilities registry. |
| `replicate(docId, replicaFactory, strategy, schemaHash)` | Register a document for headless replication with explicit arguments. |
| `has(docId)` | Check if a document exists (interpret or replicate mode). |
| `deferred` | `ReadonlySet<DocId>` — deferred document IDs. Participate in routing but have no local representation. |
| `dismiss(docId)` | Leave the sync graph — removes locally, broadcasts `dismiss`, deletes from stores. |
| `peers` | `CallableChangefeed<ReadonlyMap<PeerId, PeerIdentityDetails>, PeerChange>` — reactive peer presence. |
| `flush()` | Await all pending storage operations. |
| `shutdown()` | Flush stores, disconnect transports, close handles. The recommended graceful teardown. |
| `reset()` | Disconnect transports and clear state (synchronous). Does NOT flush pending storage. |
| `addTransport(transport)` | Add a transport at runtime. |
| `removeTransport(transportId)` | Remove a transport at runtime. |
| `hasTransport(transportId)` | Check if a transport exists by ID. |
| `getTransport(transportId)` | Get a transport by ID. |
| `register(scope)` | Register a composable scope for dynamic rule composition. Returns a dispose function. |
| `registerSchema(bound)` | Register a BoundSchema at runtime. Auto-promotes matching deferred docs. |

**Constructor options:**

| Option | Description |
|--------|-------------|
| `identity` | `{ peerId, name?, type? }` — peer identity. `peerId` required for `get()`. |
| `transports` | `TransportFactory[]` — network connectivity. |
| `stores` | `Store[]` — persistent storage backends. |
| `schemas` | `BoundSchema[]` — upfront schema registration for auto-resolution. |
| `replicas` | `BoundReplica[]` — replication modes for headless participation. E.g. `[loro.replica()]`. |
| `route` | `(docId, peer) → boolean` — outbound flow control. Default: `() => true`. |
| `authorize` | `(docId, peer) → boolean` — inbound flow control. Default: `() => true`. |
| `onUnresolvedDoc` | `(docId, peer, replicaType, mergeStrategy, schemaHash) → Disposition` — policy gate for unknown docs. |
| `onDocCreated` | `(docId, peer, mode, origin) → void` — lifecycle notification for every doc creation. |
| `onDocDismissed` | `(docId, peer) → void` — react to peer leaving a document. |

### sync()

| Property/Method | Description |
|----------------|-------------|
| `peerId` | The local peer ID. |
| `docId` | The document ID. |
| `readyStates` | `ReadyState[]` — sync status with all peers. Each entry has `{ docId, identity, status }` where status is `"pending" \| "synced" \| "absent"`. |
| `waitForSync(opts?)` | Wait for sync to complete. Options: `{ timeout?: number }` (default 30000ms). |
| `onReadyStateChange(cb)` | Subscribe to sync status changes. Returns unsubscribe function. |

### Bind Functions

| Function | Package | Description |
|----------|---------|-------------|
| `bind({ schema, factory, strategy })` | `@kyneta/schema` | General primitive — explicit schema, factory builder, strategy. |
| `json.bind(schema)` | `@kyneta/schema` | Plain substrate + sequential strategy. |
| `json.bind(schema, "ephemeral")` | `@kyneta/schema` | Plain substrate + ephemeral broadcast strategy. Ideal for presence. |
| `loro.bind(schema)` | `@kyneta/loro-schema` | Loro substrate + concurrent strategy. |
| `yjs.bind(schema)` | `@kyneta/yjs-schema` | Yjs substrate + concurrent strategy. |

### Namespace Objects

| Function | Package | Description |
|----------|---------|-------------|
| `json.bind(schema, strategy?)` | `@kyneta/schema` | Bind a plain substrate. Optional strategy override (`"ephemeral"`). |
| `json.replica()` | `@kyneta/schema` | Create a plain replica for headless replication. |
| `loro.bind(schema)` | `@kyneta/loro-schema` | Bind a Loro substrate with concurrent strategy. |
| `loro.replica()` | `@kyneta/loro-schema` | Create a Loro replica for headless replication. |
| `yjs.bind(schema)` | `@kyneta/yjs-schema` | Bind a Yjs substrate with concurrent strategy. |
| `yjs.replica()` | `@kyneta/yjs-schema` | Create a Yjs replica for headless replication. |
| `createSubstrateNamespace(opts)` | `@kyneta/schema` | Build a custom namespace object with `.bind()`, `.replica()`, `.unwrap()`. |

### Disposition Constructors

| Function | Package | Description |
|----------|---------|-------------|
| `Interpret(bound)` | `@kyneta/schema` | Full interpretation — schema, ref, changefeed. |
| `Replicate()` | `@kyneta/schema` | Headless replication — factory resolved from capabilities. |
| `Defer()` | `@kyneta/schema` | Track for routing, promotable later. |
| `Reject()` | `@kyneta/schema` | Refuse to track the document. |

### Escape Hatches

| Function | Package | Description |
|----------|---------|-------------|
| `unwrap(ref)` | `@kyneta/schema` | Returns the `Substrate<any>` backing a ref. |
| `loro.unwrap(ref)` | `@kyneta/loro-schema` | Returns the `LoroDoc` backing a Loro-backed ref. |
| `yjs.unwrap(ref)` | `@kyneta/yjs-schema` | Returns the `Y.Doc` backing a Yjs-backed ref. |

### Storage

| Export | Description |
|--------|-------------|
| `Store` | Interface for persistent storage backends. |
| `StoreEntry` | `{ payload: SubstratePayload, version: string }` |
| `createInMemoryStore(opts?)` | Map-backed store for testing. Pass `{ sharedData }` for cross-instance persistence. |

### TimestampVersion

| Method | Description |
|--------|-------------|
| `TimestampVersion.now()` | Create from the current wall clock. |
| `TimestampVersion.parse(s)` | Deserialize from string. |
| `serialize()` | Serialize to decimal string. |
| `compare(other)` | `"behind"`, `"equal"`, or `"ahead"` (never `"concurrent"`). |

### Utility

| Export | Description |
|--------|-------------|
| `persistentPeerId(storageKey)` | Browser-only: generate a random peerId on first visit, cache in `localStorage`. |

---

## Transports

Transports provide pluggable network connectivity. They create channels — the communication primitive — which the exchange uses for message routing.

> **Package split:** Transport infrastructure is defined in `@kyneta/transport` and re-exported from `@kyneta/exchange`. Transport authors should depend on `@kyneta/transport`, not `@kyneta/exchange`.

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

The websocket and SSE packages export `/client` and `/server` entry points. The websocket transport also exports `/bun` for Bun-native WebSocket servers. The WebRTC transport uses a BYODC (Bring Your Own Data Channel) pattern — you provide an `RTCDataChannel` and the transport wraps it. The unix socket transport is stream-oriented and backpressure-aware, designed for server-to-server sync.

### Creating Custom Transports

Extend the `Transport<G>` base class. `G` is the type of argument needed to generate a channel:

```ts
import { Transport } from "@kyneta/transport"

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

---

## Peer Dependencies

```json
{
  "peerDependencies": {
    "@kyneta/changefeed": "^1.0.0",
    "@kyneta/schema": "^1.1.0"
  },
  "dependencies": {
    "@kyneta/transport": "^1.0.0"
  }
}
```

## License

MIT
