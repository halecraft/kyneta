# @kyneta/exchange

Define your data's shape. Get sync, persistence, and presence — across any number of peers, over any transport, with any CRDT or none.

```ts
import { Exchange, whenSettled } from "@kyneta/exchange"
import { loro } from "@kyneta/loro-schema"
import { batch, Schema } from "@kyneta/schema"
import { createWebsocketClient } from "@kyneta/websocket-transport/browser"

const TodoDoc = loro.bind(
  Schema.struct({
    title: Schema.text(),
    items: Schema.list(
      Schema.struct.json({
        text: Schema.string(),
        done: Schema.boolean(),
      }),
    ),
  }),
)

const exchange = new Exchange({
  id: "alice",
  transports: [
    createWebsocketClient({ url: "ws://localhost:3000/ws", WebSocket }),
  ],
})

const doc = exchange.get("my-todos", TodoDoc)

batch(doc, d => {
  d.title.insert(0, "My Todos")
  d.items.push({ text: "Learn Exchange", done: false })
})

doc.title() // "My Todos"

await whenSettled(doc) // ✓ every truth source has reported
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
  id: "alice",
  transports: [createWebsocketClient({ url: "ws://localhost:3000/ws", WebSocket })],
})

const doc = exchange.get("shared-doc", TodoDoc)
doc.title()  // typed read
batch(doc, d => d.title.insert(0, "Hello"))  // typed write
subscribe(doc, changeset => { /* reactive */ })
```

**The Relay** — headless replication. No schemas, no application types. Just "hold state and forward it."

```ts
import { loro } from "@kyneta/loro-schema"

const relay = new Exchange({
  id: { peerId: "relay", type: "service" },
  transports: [
    createWebsocketClient({ url: "ws://upstream:3000/ws", WebSocket }),
    createWebsocketClient({ url: "ws://downstream:3001/ws", WebSocket }),
  ],
  replicas: [loro.replica()],
  resolve: () => Replicate(),
})
```

> Plain and ephemeral replicas are built-in — `replicas` is only needed when relaying CRDT documents (Loro, Yjs).

**The Application Server** — selective interpretation. Understand some documents, ignore others.

```ts
const server = new Exchange({
  id: "game-server",
  transports: [serverTransport],
  resolve: (docId, peer) => {
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
import { createDoc, Schema } from "@kyneta/schema/basic"

const doc = createDoc(Schema.struct({ theme: Schema.string() }))
doc.theme.set("dark")
doc.theme()  // "dark"
```

The `/basic` entry is the batteries-included one: its `createDoc(schema)` binds
the schema to the plain substrate for you. Everywhere else in this README the
binding is explicit — `json.bind(schema)`, `loro.bind(schema)` — because once an
exchange is involved, which substrate you picked is the whole point.

When you need that document to sync across peers, the exchange wraps the same schema. Your reads and writes don't change.

### Two peers, one writer — the simplest distributed case

```ts
const ConfigDoc = json.bind(Schema.struct({ theme: Schema.string() }))

// Peer A — creates the document and writes
const exchangeA = new Exchange({
  id: "alice",
  transports: [createWebsocketClient({ url: "ws://localhost:3000/ws", WebSocket })],
})
const docA = exchangeA.get("config", ConfigDoc)
docA.theme.set("dark")

// Peer B — opens the same document and waits for data to arrive
const exchangeB = new Exchange({
  id: "bob",
  transports: [createWebsocketClient({ url: "ws://localhost:3000/ws", WebSocket })],
})
const docB = exchangeB.get("config", ConfigDoc)
await whenSettled(docB)
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
  id: "server",
  transports: [serverTransport],
  stores: [await createLevelDBStore("./data/exchange-db")],  // ← new
})
// Durable documents auto-hydrate on restart, auto-persist on mutation.
// Ephemeral ones deliberately do neither — see Storage, below.
```

### Add presence alongside your documents — same exchange

```ts
const PresenceDoc = ephemeral.bind(Schema.struct({
  cursor: Schema.struct({
    x: Schema.number(),
    y: Schema.number()
  }),
  name: Schema.string(),
}))

// Same exchange, same transport connections, different sync mode
const doc = exchange.get("shared-doc", TodoDoc)          // Loro CRDT, concurrent merge
const presence = exchange.get("my-presence", PresenceDoc) // ephemeral broadcast
```

### Add access control — one predicate

```ts
const exchange = new Exchange({
  id: "server",
  transports: [serverTransport],
  canShare: (docId, peer) => {  // ← new: outbound flow control
    if (docId.startsWith("input:")) return peer.peerId === docId.slice(6)
    return undefined
  },
  canAccept: (docId, peer) => {  // ← new: inbound flow control
    if (docId === "game-state") return false  // only server writes
    return undefined
  },
})
```

### Add a relay — no client changes

```ts
// The relay has zero knowledge of your schemas.
// Plain and ephemeral replicas are built-in; add CRDT replicas if relaying Loro/Yjs docs.
const relay = new Exchange({
  id: { peerId: "relay", type: "service" },
  transports: [
    createWebsocketClient({ url: "ws://upstream:3000/ws", WebSocket }),
    createWebsocketClient({ url: "ws://downstream:3001/ws", WebSocket }),
  ],
  replicas: [loro.replica()],
  resolve: () => Replicate(),
})
```

Each step is one or two lines that don't invalidate the previous step. Your reads, writes, subscriptions, and tests survive every transition.

---

## Why This Works

### One declaration, three decisions

A `BoundSchema` captures the three choices that define a document type:

1. **Schema** — what shape is the data?
2. **Factory** — how is the data stored and versioned?
3. **SyncMode** — how does the exchange sync it?

```ts
import { Schema, json, ephemeral } from "@kyneta/schema"
import { loro } from "@kyneta/loro-schema"
import { yjs } from "@kyneta/yjs-schema"

// Collaborative document — Loro CRDT with concurrent merge
const TodoDoc = loro.bind(Schema.struct({
  title: Schema.text(),
  items: Schema.list(Schema.struct.json({ name: Schema.string() })),
}))

// Collaborative text — Yjs CRDT with concurrent merge
const NoteDoc = yjs.bind(Schema.struct({
  body: Schema.text(),
}))

// Config data — plain substrate with sequential sync
const ConfigDoc = json.bind(Schema.struct({ theme: Schema.string() }))

// Ephemeral presence — snapshot broadcast, merged per field on each leaf's timestamp
const PresenceDoc = ephemeral.bind(Schema.struct({
  cursor: Schema.struct({ x: Schema.number(), y: Schema.number() }),
  name: Schema.string(),
}))
```

BoundSchemas are static declarations, defined at module scope. They can be shared across multiple exchange instances — each exchange calls the factory builder independently, producing a fresh factory with the correct peer identity.

For custom substrates, use `bind()` directly as the general primitive, and `createBindingTarget` to build custom binding target objects:

```ts
import { bind, createBindingTarget, SYNC_COLLABORATIVE } from "@kyneta/schema"

// bind() is the general primitive — explicit schema, factory builder, syncMode
const CustomDoc = bind({
  schema: Schema.struct({ data: Schema.string() }),
  factory: (ctx) => createMyFactory(ctx.peerId),
  syncMode: SYNC_COLLABORATIVE,
})

// createBindingTarget builds a binding target like json/ephemeral/loro/yjs
const mySubstrate = createBindingTarget({
  factory: (ctx) => createMyFactory(ctx.peerId),
  replicaFactory: myReplicaFactory,
  syncMode: {
    writerModel: "concurrent",
    delivery: "delta-capable",
    durability: "persistent",
  }
})

const AnotherDoc = mySubstrate.bind(Schema.struct({ data: Schema.string() }))
const replica = mySubstrate.replica()
```

### Three sync modes, one wire format

Each BoundSchema carries a `SyncMode` — a structured record with three orthogonal axes (`writerModel`, `delivery`, `durability`) — that determines how the exchange syncs documents of that type. These are genuinely different sync algorithms, not transport optimizations:

| SyncMode constant | Axes | Protocol | Version Order | Use Case |
|-----------------------|------|----------|---------------|----------|
| `SYNC_COLLABORATIVE` | concurrent + delta-capable + persistent | Bidirectional exchange | Partial (concurrent possible) | Loro / Yjs CRDTs |
| `SYNC_AUTHORITATIVE` | serialized + delta-capable + persistent | Request/response | Total (no concurrency) | Plain substrates |
| `SYNC_EPHEMERAL` | concurrent + snapshot-only + transient | Interest-based broadcast | Total (timestamp-based) | Ephemeral/presence |

All three run over the same five-message sync protocol:

- **`present`** — "I have these documents." Carries `docId`, `replicaType`, `syncMode`, and `schemaHash` so the receiver can validate compatibility before any data exchange.
- **`interest`** — "I want document X. Here's my version." Carries `reciprocate` for collaborative bidirectional exchange.
- **`offer`** — "Here is state for document X." Carries an opaque `SubstratePayload` — the exchange never inspects the bytes.
- **`dismiss`** — "I'm leaving document X."

Two additional messages (`establish-request`, `establish-response`) handle channel handshake. The sync mode's field values determine *when* and *how* these messages are sent, not their shape.

### The exchange never inspects your data

This is the architectural decision that makes substrate agnosticism real. The exchange dispatches on `SyncMode` fields (`delivery`, `writerModel`) to decide protocol behavior, but actual document payloads are opaque `SubstratePayload` values. The exchange moves bytes; the substrate interprets them. This means:

- A Loro document, a Yjs document, a plain JS object, and an ephemeral value all flow through the same protocol.
- A relay can forward documents without knowing what CRDT library produced them.
- You can implement a new substrate by satisfying the `Substrate<V>` interface — no exchange changes needed.

### Four dispositions

When a peer announces a document, your exchange decides how to participate:

| Disposition | What happens | Created by |
|-------------|-------------|------------|
| **Interpret** | Full schema-driven interpretation — `Ref<S>`, changefeed, reads, writes | `exchange.get(docId, bound)` |
| **Replicate** | Headless replication — version tracking, export/import, no schema | `exchange.replicate(docId)` or `resolve: () => Replicate()` |
| **Defer** | Track for routing but don't replicate yet — promotable later | `resolve: () => Defer()` |
| **Reject** | Refuse to track the document at all | `resolve: () => Reject()` |

The two-tiered default (when no `resolve` callback matches): documents whose replica type is supported get **deferred** (promotable via a later `exchange.get()` or `registerSchema()`), while documents with unsupported replica types are silently **rejected**.

---

## Core Concepts

### The Exchange

The `Exchange` class is the central orchestrator. It manages document lifecycle, coordinates transports and stores, and runs sync algorithms on behalf of passive substrates.

```ts
const exchange = new Exchange({
  id: { peerId: "alice", name: "Alice", type: "user" },
  transports: [networkTransport],
  stores: [createInMemoryStore()],
  canShare: (docId, peer) => {
    if (docId.startsWith("input:")) return peer.peerId === docId.slice(6)
    return undefined
  },
  canAccept: (docId, peer) => {
    if (docId === "game-state") return false
    return undefined
  },
})
```

> **Peer identity:** `id` identifies the exchange as a participant in causal history. For browser clients, use `persistentPeerId(storageKey)` as the `id` value — it provides a per-tab unique peerId stable across reloads. For servers, pass an explicit string.

### Heterogeneous Documents

A single exchange hosts documents backed by different substrate types simultaneously:

```ts
const doc = exchange.get("collab-doc", TodoDoc)       // Loro CRDT, concurrent merge
const config = exchange.get("settings", ConfigDoc)     // Plain JSON, sequential sync
const presence = exchange.get("presence", PresenceDoc) // ephemeral broadcast
```

Each document's substrate and sync mode are determined by its BoundSchema. No configuration needed at the exchange level.

### Governance Predicates

Four predicates control information flow. All use three-valued logic (`true` / `false` / `undefined`) for composable policy stacking — `false` short-circuits, `undefined` defers to other policies, and the default when all policies abstain is `true`.

- **`canShare(docId, peer) → boolean | undefined`** — Outbound. Gates every outbound message: present, push, relay. Also gates `resolve` — if `canShare` returns `false` for the announcing peer, the callback never fires.

- **`canAccept(docId, peer) → boolean | undefined`** — Inbound. Gates offer imports. When rejected, the offer is silently dropped.

- **`canReset(docId, peer) → boolean | undefined`** — Epoch boundary. Fires when a peer sends an entirety payload for a document that already has local state — meaning the remote peer has compacted history past our known version. Accepting discards local state and adopts the entirety; rejecting keeps local state and diverges from compacted peers.

- **`canConnect(peer) → boolean | undefined`** — Connection. Gates the `establish` handshake. When rejected, the peer's channel is ignored entirely — no documents are exchanged. Unlike the other predicates, this takes only a peer (no docId).

### Dynamic Document Creation

**`resolve`** fires when a peer announces a document your exchange doesn't know about. Return a disposition:

```ts
import { Interpret, Replicate, Defer, Reject } from "@kyneta/schema"

const gameExchange = new Exchange({
  id: "game-server",
  transports: [serverTransport],
  resolve: (docId, peer, replicaType, syncMode, schemaHash) => {
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
  id: "alice",
  schemas: [TodoDoc, ConfigDoc],  // auto-interpret when peers announce these
})
```

**`onDocCreated`** fires for every document creation — local `get()`, remote auto-resolve, `resolve`, or deferred promotion:

```ts
const exchange = new Exchange({
  id: "server",
  schemas: [PlayerInputDoc],
  onDocCreated(docId, peer, mode, origin) {
    if (origin === "remote" && docId.startsWith("input:")) {
      const inputDoc = exchange.get(docId, PlayerInputDoc)
      registerPlayer(peer.peerId, inputDoc)
    }
  },
})
```

Use `resolve` to decide **what to do**. Use `onDocCreated` to observe **what happened**.

### Storage

Stores are a first-class constructor parameter, separate from transports. Durable documents auto-persist on mutation and auto-hydrate on restart:

```ts
import { createLevelDBStore } from "@kyneta/leveldb-store"

const exchange = new Exchange({
  id: "server",
  stores: [await createLevelDBStore("./data/exchange-db")],
  transports: [networkTransport],
})

const doc = exchange.get("my-doc", TodoDoc)
// Mutations are automatically persisted. On restart, documents hydrate from storage.
```

**Ephemeral documents are never stored.** Anything bound through `ephemeral` declares `durability: "transient"`, and the exchange keeps it out of stores in both directions — no hydrate on open, no write on mutation, no delete on destroy. That is the point of the tier: presence, cursors and live input describe who is here *now*, and a restarted server resurrecting yesterday's cursor positions would be worse than having none. Configuring stores does not change this, and there is no way to opt a transient document into persistence — use a durable binding target instead.

**Store format gate.** On open, every persistent backend stamps a `{ major, minor }` on-disk format version into a dedicated store-metadata namespace (a `kyneta_store_meta` table, an IndexedDB `store_meta` object store, or a `store-meta\x00` key prefix — separate from the per-document `doc_meta` namespace). On a later open it refuses — throwing `StoreFormatVersionError` — a store whose stamped major is incompatible with the running build, or an unversioned store that already holds documents. The gate is a compatibility check only; it performs no automatic migration.

For testing, use `createInMemoryStore()` with shared state to simulate persist → restart → hydrate flows:

```ts
const sharedData: InMemoryStoreData = { entries: new Map(), metadata: new Map() }

const exchange1 = new Exchange({
  id: "server",
  stores: [createInMemoryStore({ sharedData })],
})
const doc = exchange1.get("my-doc", TodoDoc)
doc.title.set("Saved")
await exchange1.shutdown()

const exchange2 = new Exchange({
  id: "server",
  stores: [createInMemoryStore({ sharedData })],
  resolve: () => Interpret(TodoDoc),
})
// "my-doc" is restored from storage automatically
```

### Sync Status

```ts
import { sync } from "@kyneta/exchange"

const doc = exchange.get("doc-id", MyDoc)

sync(doc).peerId        // your peer ID
sync(doc).docId         // document ID
sync(doc).peerStates    // raw per-peer sync state (volatile)
sync(doc).ready         // monotonic readiness latch (the 90% gate)
sync(doc).connectivity  // "online" | "connecting" | "offline"

await whenSettled(doc)

// Settle without throwing: resolves { via: "peer" | "local" | "offline" }
await whenSettled(doc, { offlineAfter: 3000 })

sync(doc).onPeerSyncChange(states => {
  console.log("Per-peer sync state:", states)
})
```

### Peer Lifecycle

`exchange.peers` is a reactive feed of the peers this exchange is connected to — callable as a function, subscribable for changes:

```ts
const peers = exchange.peers()  // ReadonlyMap<PeerId, PeerIdentityDetails>

exchange.peers.subscribe(changeset => {
  for (const change of changeset.changes) {
    switch (change.type) {
      case "peer-established":  // first channel completed the handshake
        console.log(`${change.peer.name ?? change.peer.peerId} connected`)
        break
      case "peer-disconnected": // all channels lost — may still reconnect
        console.log(`${change.peer.name ?? change.peer.peerId} dropped`)
        break
      case "peer-reconnected":  // re-established before the departure timer
        console.log(`${change.peer.name ?? change.peer.peerId} reconnected`)
        break
      case "peer-departed":     // definitively gone
        console.log(`${change.peer.name ?? change.peer.peerId} left`)
        break
    }
  }
})
```

**Connection is not presence.** Losing the last channel to a peer does *not* remove it immediately. The peer first goes `peer-disconnected` and is held for `departureTimeout` (default `30_000` ms); reconnect within that window yields `peer-reconnected`, otherwise the timer expires into `peer-departed`. A graceful `shutdown()` — or a received `depart` message, or `departureTimeout: 0` — skips the grace period and departs at once. Set a short `departureTimeout` when dropped peers should disappear quickly (e.g. a live game roster); keep the default so brief network blips don't churn presence.

Multi-transport deduplication: when a peer is connected through multiple transports (e.g. both WebSocket and SSE), `peer-established` fires once on the first channel, and the disconnect/departure transitions fire only when *all* channels are gone. On `shutdown()` or `reset()`, synthetic `peer-departed` events are emitted for all connected peers.

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

## Document Initialization

A document that has just been created is empty. So is a document whose stored
data is still loading, and one whose server has not answered yet. Telling those
apart is the entire problem: writing defaults into the first is correct, and
writing them into the other two destroys data.

`initialize` waits for every source that could have something to say, and only
then decides:

```ts
import { initialize } from "@kyneta/exchange"

await initialize(doc, d => d.set({ title: "Untitled", posts: [] }))
// → "created" if it wrote the defaults, "loaded" if data was already there
```

The rule it encodes, in one line: **whoever is authoritative seeds when the
document is empty; everyone else waits and reads.**

### The four topologies, one verb

```ts
// Standalone — nothing to wait for
const doc = createDoc(BlogSchema)
await initialize(doc, seedDefaults)

// Local-only, with storage — waits for the load, never for a network
const exchange = new Exchange({ id: "app", stores: [store] })
await initialize(exchange.get("blog", BlogDoc), seedDefaults)

// Server — authoritative. Declared once, at construction.
const server = new Exchange({ id: "server", stores: [store], authority: "self" })
await initialize(server.get("blog", BlogDoc), seedDefaults)

// Client — waits for the server's answer, and gives up after 3s if it never
// comes (offline-first).
const client = new Exchange({
  id: "client",
  transports: [ws],
  authority: p => p.peerId === "server",
})
await initialize(client.get("blog", BlogDoc), seedDefaults, { offlineAfter: 3000 })
```

### Identify the authority by peer ID, not by role

`PeerIdentityDetails.type` is one of `"user" | "bot" | "service"`, so the
tempting client-side check is `p => p.type === "service"`. That is too loose
for anything that gates a write: your server is a service, but so is any other
service peer on the network — including the devtools inspector, which is itself
an Exchange peer. A client using the role check could accept the inspector's
reply as the server's verdict.

```ts
authority: p => p.peerId === "my-server"   // recommended
```

### Reading the status directly

```ts
import { docStatus } from "@kyneta/exchange"

docStatus(doc)  // "pending" | "empty" | "populated"
```

`"pending"` means some source has yet to report. `"empty"` means everything has
reported and there is nothing there — the only state from which writing
defaults is safe. The three states exist so that "we do not know yet" cannot be
mistaken for "there is nothing here".

This works at every layer and never throws, including on a plain `createDoc`
document with no Exchange behind it.

### Writing a concurrency-safe seed

Whether two peers seeding at once causes a problem depends only on which merge
law the seed's writes touch — and every schema constructor already declares its
law:

| Constructor | Law | Two peers seeding the same thing |
| --- | --- | --- |
| `product` / field `.set()` | `lww-per-key` | converge — safe |
| `map` (deterministic key) | `lww-per-key` | converge — safe |
| `set` | `add-wins-per-key` | converge (value-addressed) — safe |
| `sum` | `lww-tag-replaced` | converge — safe |
| `sequence` / `movableList` | `positional-ot` | **duplicate** |
| `counter` | `additive` | **double-count** |
| `text` | `positional-ot` | **duplicate** |

A seed made of scalars, struct fields, deterministically-keyed map entries, or
set members is safe on any number of peers with no configuration at all:

```ts
await initialize(doc, d => {
  d.title.set("Untitled")                 // lww-per-key
  d.settings.theme.set("dark")            // lww-per-key
  d.tags.add("inbox")                     // add-wins, value-addressed
  d.sections.set("intro", { order: 0 })   // lww-per-key, deterministic key
})
```

The unsafe shape is the reflex one — `d.items.push({ id: crypto.randomUUID() })`
— and the fix is usually a one-line reshape to a map keyed by a stable id,
which is often the better model anyway.

If a seed genuinely must be positional, declare an authority so only one peer
writes it. `TECHNICAL.md` covers the remaining options.

### What `initialize` does not do

The seed is an ordinary local write. It broadcasts, it persists, and it passes
the same governance gates as any other mutation — so a restrictive `canShare`
or `canAccept` policy applies to it too. A large default payload therefore
produces a full changeset broadcast.

It also refuses one thing outright: seeding a `writerModel: "serialized"`
document (anything bound with `json.bind`) from a peer that is not the
authority. Concurrent seeds cannot merge on that document type, so rather than
lose the race at runtime, it throws with the fix in the message.

---

## Complexity Gradient

| Level | What you write | What you get |
|-------|----------------|--------------|
| **Trivial** | `exchange.get("doc", MyDoc)` | Typed, syncable, observable document |
| **Standard** | Add `transports`, `stores` | Network sync + persistence |
| **Intermediate** | Add `canShare`, `canAccept`, `resolve` | Information flow control, dynamic doc creation |
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
| `replicate(docId, replicaFactory, syncMode, schemaHash)` | Register a document for headless replication with explicit arguments. |
| `has(docId)` | Check if a document exists (interpret or replicate mode). |
| `deferred` | `ReadonlySet<DocId>` — deferred document IDs. Participate in routing but have no local representation. |
| `dismiss(docId)` | Leave the sync graph — removes locally, broadcasts `dismiss`, deletes from stores. |
| `peers` | `CallableChangefeed<ReadonlyMap<PeerId, PeerIdentityDetails>, PeerChange>` — reactive peer connection lifecycle (established / disconnected / reconnected / departed). |
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
| `id` | `string \| { peerId, name?, type? }` — peer identity. A plain string is shorthand for `{ peerId: string }`. Required for `get()`. |
| `transports` | `TransportFactory[]` — network connectivity. |
| `stores` | `Store[]` — persistent storage backends. |
| `schemas` | `BoundSchema[]` — upfront schema registration for auto-resolution. |
| `replicas` | `BoundReplica[]` — replication modes for headless participation. E.g. `[loro.replica()]`. |
| `canShare` | `(docId, peer) → boolean \| undefined` — outbound flow control. Default: allow. |
| `canAccept` | `(docId, peer) → boolean \| undefined` — inbound flow control. Default: allow. |
| `canReset` | `(docId, peer) → boolean \| undefined` — epoch boundary policy. Default: allow. |
| `canConnect` | `(peer) → boolean \| undefined` — connection-level gate. Default: allow. |
| `resolve` | `(docId, peer, replicaType, syncMode, schemaHash) → Disposition` — policy gate for unknown docs. |
| `departureTimeout` | `number` — ms before a disconnected peer is declared departed. Default: `30_000`. |

### sync()

| Property/Method | Description |
|----------------|-------------|
| `peerId` | The local peer ID. |
| `docId` | The document ID. |
| `peerStates` | `PeerSyncState[]` — raw per-peer sync state. Each entry is `{ docId, peer, state }` where state is `"pending" \| "synced" \| "vacant"`. Volatile — can regress on reconnect. |
| `ready` | `boolean` — monotonic readiness latch: `true` once the doc reconciles with ≥1 peer (data or `vacant`); never regresses. The 90% gate. |
| `readyFor(pred)` | `boolean` — latch restricted to reconciled peers matching `pred` (authority / quorum). |
| `connectivity` | `"online" \| "connecting" \| "offline"`. |
| `whenSettled(doc, opts?)` | Resolve once **every** truth source has reported — stored data loaded and the authority answered. Options: `{ peer?, offlineAfter? }`. Rejects only if the store read failed. |
| `settled(opts?)` | Resolve (never reject) to `{ via: "peer" \| "local" \| "offline" }`. Options: `{ offlineAfter?: number }`. |
| `onPeerSyncChange(cb)` | Subscribe to per-peer sync state changes. Returns unsubscribe function. |

### Bind Functions

| Function | Package | Description |
|----------|---------|-------------|
| `bind({ schema, factory, syncMode })` | `@kyneta/schema` | General primitive — explicit schema, factory builder, sync mode. |
| `json.bind(schema)` | `@kyneta/schema` | Plain substrate + authoritative protocol (`SYNC_AUTHORITATIVE`). |
| `ephemeral.bind(schema)` | `@kyneta/schema` | Field-level LWW CvRDT, snapshot broadcast, never persisted (`SYNC_EPHEMERAL`). Presence, cursors, live input. |
| `loro.bind(schema)` | `@kyneta/loro-schema` | Loro substrate + collaborative protocol (`SYNC_COLLABORATIVE`). |
| `yjs.bind(schema)` | `@kyneta/yjs-schema` | Yjs substrate + collaborative protocol (`SYNC_COLLABORATIVE`). |

### Binding Targets

Each binding target is a fixed `(substrate, sync-mode, supported-laws)` bundle. No strategy parameter — each target has exactly one sync mode.

| Target | Package | `syncMode` | Description |
|--------|---------|----------------|-------------|
| `json.bind(schema)` | `@kyneta/schema` | `SYNC_AUTHORITATIVE` | Plain substrate, sequential sync. |
| `json.replica()` | `@kyneta/schema` | `SYNC_AUTHORITATIVE` | Plain replica for headless replication. |
| `ephemeral.bind(schema)` | `@kyneta/schema` | `SYNC_EPHEMERAL` | Field-level LWW CvRDT, snapshot broadcast. |
| `ephemeral.replica()` | `@kyneta/schema` | `SYNC_EPHEMERAL` | Headless replica for relays; merges snapshots without a schema. |
| `loro.bind(schema)` | `@kyneta/loro-schema` | `SYNC_COLLABORATIVE` | Loro substrate, collaborative CRDT sync. |
| `loro.replica()` | `@kyneta/loro-schema` | `SYNC_COLLABORATIVE` | Loro replica for headless replication. |
| `yjs.bind(schema)` | `@kyneta/yjs-schema` | `SYNC_COLLABORATIVE` | Yjs substrate, collaborative CRDT sync. |
| `yjs.replica()` | `@kyneta/yjs-schema` | `SYNC_COLLABORATIVE` | Yjs replica for headless replication. |
| `createBindingTarget(opts)` | `@kyneta/schema` | (custom) | Build a custom binding target with `.bind()`, `.replica()`. |

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

### Utility

| Export | Description |
|--------|-------------|
| `persistentPeerId(storageKey)` | Browser-only: per-tab unique peerId via localStorage CAS lease. First tab gets the stable device peerId; concurrent tabs get fresh random peerIds. Stable across reloads. |
| `releasePeerId(storageKey)` | Release the peerId lease. Clears only the holder token — `sessionStorage` keys survive for reload stability. Called automatically on `pagehide`. |
| `resolveLease(state)` | Pure decision function for the lease protocol. Exported for testing and advanced use. |

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
