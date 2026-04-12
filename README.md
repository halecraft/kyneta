# Kyneta

Schema-first, local-first. Define your data once — sync, reactivity, validation, and persistence are derived from that single definition. Start on one machine with plain objects. Add peers, CRDTs, transports, and storage as you grow — without rewriting your app.

## Quick Start

```ts
import { Schema, change } from "@kyneta/schema"
import { Exchange, sync } from "@kyneta/exchange"
import { loro } from "@kyneta/loro-schema"
import { createWebsocketClient } from "@kyneta/websocket-transport/client"

// 1. Define your data
const TodoDoc = loro.bind(
  Schema.struct({
    title: Schema.text(),
    items: Schema.list(
      Schema.struct({
        text: Schema.string(),
        done: Schema.boolean(),
      }),
    ),
  })
)

// 2. Create an exchange, one per peer (or server/client)
const exchange = new Exchange({
  identity: { peerId: "alice" },
  transports: [createWebsocketClient({ url: "ws://localhost:3000/ws" })],
})

// 3. Get a document — syncs automatically
const doc = exchange.get("my-todos", TodoDoc)

change(doc, d => {
  d.title.insert(0, "My Todos")
  d.items.push({ text: "Learn Kyneta", done: false })
})

doc.title()  // "My Todos"
await sync(doc).waitForSync()
```

React bindings are available today. It's easy to add other bindings.

```tsx
import { useDocument, useValue } from "@kyneta/react"
import { TodoDoc } from "./schema.js"

function TodoApp() {
  const doc = useDocument("my-todos", TodoDoc)
  const title = useValue(doc.title)

  return (
    <div>
      <h1>{title}</h1>
      <button onClick={() => doc.items.push({ text: "New item", done: false })}>
        Add
      </button>
    </div>
  )
}
```

## Grow Without Rewriting

Every step below is additive — earlier code doesn't change.

| Step | What changes | What stays the same |
|------|-------------|-------------------|
| **Local document** | `createDoc(schema)` — no network, no exchange; type-safe, reactive doc, with validation | — |
| **Two peers, plain sync** | Add `Exchange` + transport | Schema, reads, writes |
| **Switch to CRDTs** | `json.bind(schema)` → `loro.bind(schema)` | Exchange, transport, reads, writes |
| **Add persistence** | Add `stores: [leveldb()]` to exchange config | Everything above |
| **Add presence** | `json.bind(schema, "ephemeral")` alongside your docs | Everything above |
| **Add access control** | Add `route` and `authorize` predicates | Client code unchanged |
| **Add a relay** | One more Exchange with `type: "relay"` | Client code unchanged |

See the [`@kyneta/exchange` README](./packages/exchange/README.md) for the full walkthrough with code.

## Why Kyneta

**Schemas should be walked once.** A schema tree gets traversed for reading, mutation, observation, validation, sync, and more. Most frameworks implement these as parallel switch dispatches that drift apart. Kyneta's schema algebra collapses them into one catamorphism with pluggable interpreters — all capabilities are derived from the same structure. Your schema is the single source of truth not by convention, but by construction. Add a field and every capability follows. There is nothing else to update.

**Collaboration shouldn't require rewriting your app.** Start with plain JS objects and `createDoc()`. When you need concurrent merge, swap to `loro.bind()` or `yjs.bind()` — reads, writes, and observation don't change. The exchange syncs documents via the `Substrate` interface — the exchange doesn't need to understand the inner workings of your CRDT library of choice. This is powerful, because you can mix collaborative CRDTs, authoritative json state, and ephemeral presence in one sync network.

**Local-first means local *first*.** Authority starts local — the hardest configuration to achieve, and the one you get for free. Centralize when your needs call for it. The network is additive, not load-bearing.

## Packages

5,403 tests across the monorepo.

### Foundation

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/changefeed`](./packages/changefeed) | Universal reactive contract — a Moore machine identified by `[CHANGEFEED]`. Zero dependencies. | 24 |
| [`@kyneta/schema`](./packages/schema) | Schema interpreter algebra. One recursive `Schema` type, one generic `interpret()` catamorphism, pluggable interpreters for reading, mutation, observation, and validation. Only dependency is `@kyneta/changefeed`. | 1,540 |
| [`@kyneta/machine`](./packages/machine) | Universal Mealy machine algebra — pure state transitions with effect outputs. Powers the exchange synchronizer and all transport clients. Zero dependencies. | 45 |

### Substrates

A plain JS substrate is built into `@kyneta/schema` — no external package needed to get started. These packages add CRDT backends:

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/loro-schema`](./packages/schema/backends/loro) | Loro CRDT substrate for `@kyneta/schema`. Schema-aware typed reads, `applyDiff`-based writes, and a persistent event bridge. | 163 |
| [`@kyneta/yjs-schema`](./packages/schema/backends/yjs) | Yjs CRDT substrate for `@kyneta/schema`. Same `Substrate` interface as Loro — swap with a one-line import change. `yjs.bind()` validates capability compatibility at compile time via `YjsCaps`. | 159 |

### Sync

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/exchange`](./packages/exchange) | Substrate-agnostic state exchange. Three merge strategies (concurrent, sequential, ephemeral) over a six-message sync protocol. Hosts heterogeneous documents — Loro CRDTs, Yjs CRDTs, plain JS, ephemeral presence — in one sync network. | 316 |
| [`@kyneta/transport`](./packages/transport) | Transport infrastructure — base class, channel types, message vocabulary, and client utilities. | 8 |
| [`@kyneta/wire`](./packages/exchange/wire) | Wire format codecs, framing, and fragmentation. CBOR and JSON codecs, 6-byte binary frames, and a fragmentation protocol for cloud WebSocket gateways. | 195 |

### Transports

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/websocket-transport`](./packages/exchange/transports/websocket) | WebSocket transport. Client, server, and Bun-specific handlers with connection lifecycle, keepalive, and reconnection. | 51 |
| [`@kyneta/sse-transport`](./packages/exchange/transports/sse) | SSE transport. Client, server, and Express integration with reconnection state machine. | 44 |
| [`@kyneta/webrtc-transport`](./packages/exchange/transports/webrtc) | WebRTC data channel transport. BYODC (Bring Your Own Data Channel) with binary CBOR encoding and fragmentation. | 27 |
| [`@kyneta/unix-socket-transport`](./packages/exchange/transports/unix-socket) | Unix domain socket transport. Stream-oriented, backpressure-aware server-to-server sync. | 82 |

### Storage

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/leveldb-store`](./packages/exchange/stores/leveldb) | LevelDB storage backend for `@kyneta/exchange`. Server-side persistent storage. | 24 |

### Indexes

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/index`](./packages/index) | DBSP-grounded reactive indexing — Source, Collection, Index over ℤ-set algebra. | 112 |

### Bindings

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/react`](./packages/react) | React bindings over `@kyneta/schema` + `@kyneta/exchange`. Hooks for document access, sync status, and reactive observation via `useSyncExternalStore`. | 29 |

## Dependencies

```
@kyneta/changefeed                      (standalone — zero dependencies)
    │
    └──► @kyneta/schema                 (the algebra everything builds on)
            │
            ├──► @kyneta/loro-schema    (+ loro-crdt)
            ├──► @kyneta/yjs-schema     (+ yjs)
            │
            ├──► @kyneta/compiler       (+ ts-morph)   ── experimental
            │        └──► @kyneta/cast  (+ unplugin)    ── experimental
            │
            ├──► @kyneta/index          (+ changefeed; optional peer-dep: exchange)
            │
            └──► @kyneta/exchange       (+ transport)
                    │
                    ├──► @kyneta/wire   (+ tiny-cbor)
                    │        ├──► @kyneta/websocket-transport
                    │        ├──► @kyneta/sse-transport
                    │        ├──► @kyneta/webrtc-transport
                    │        └──► @kyneta/unix-socket-transport
                    │
                    ├──► @kyneta/leveldb-store
                    └──► @kyneta/react  (+ react)

@kyneta/machine                         (standalone — used by exchange, transports)
@kyneta/perspective                     (standalone — private, not published)
```

`@kyneta/changefeed` defines the universal reactive contract — the `[CHANGEFEED]` symbol protocol. `@kyneta/schema` builds the interpreter algebra on top of it. Everything else — substrates, exchange, transports, bindings — builds on schema's `Substrate` interface and changefeed's reactive protocol.

## Examples

| Example | Description |
|---------|-------------|
| [`todo`](./examples/todo) | Minimal collaborative todo list — Cast compiler + Exchange + Yjs over WebSocket |
| [`todo-react`](./examples/todo-react) | Same domain, React bindings — proves the sync layer is framework-agnostic |
| [`bumper-cars`](./examples/bumper-cars) | Heterogeneous documents in one Exchange — concurrent CRDTs, sequential server-authoritative state, and ephemeral presence side by side |
| [`unix-socket-sync`](./examples/unix-socket-sync) | Leaderless TUI config sync over Unix sockets — N identical processes, one socket path, Loro CRDT convergence |

## Getting Started

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Run tests for a specific package
cd packages/schema && pnpm test
```

## Experiments

These packages explore ideas at the frontier of the project. They are functional and well-tested, but represent research directions rather than stable APIs.

### Compiled Delta-Driven UI

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/compiler`](./packages/compiler) | Target-agnostic incremental view maintenance compiler. Transforms TypeScript AST into classified IR annotated with binding times, delta kinds, and incremental strategies. | 547 |
| [`@kyneta/cast`](./packages/cast) | Web rendering target (codename Kinetic). Consumes compiler IR and produces DOM manipulation code that directly consumes CRDT deltas — character-level text patches, O(k) list updates, branch swapping — with no virtual DOM and no diffing. | 634 |

CRDTs already know what changed. When you insert a character, the CRDT emits a delta saying exactly where. Traditional UI frameworks ignore this — they diff output to rediscover changes. The compiler transforms natural TypeScript into code that directly consumes these deltas, achieving O(k) DOM updates where k is the number of operations. See the [Kinetic status](./packages/cast/README.md#prototype-status) for details.

### Convergent Constraint Systems

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/perspective`](./packages/perspective) | Constraint-based CRDTs (codename Prism). Agents assert constraints, merge is set union, and a stratified Datalog evaluator derives shared reality. Includes an incremental pipeline based on DBSP. Private — not published to npm. | 1,374 |

Traditional CRDTs couple state representation with merge logic. Perspective separates them: the semilattice moves to constraint sets, and a Datalog solver derives state. Conflict resolution strategies become rules that travel inside the data. See the [Perspective README](./packages/perspective/README.md) for the full treatment.

## Academic Foundations

- **Bananas, Lenses, Envelopes and Barbed Wire** — Meijer, Fokkinga & Paterson, 1991. F-algebras, catamorphisms, and recursion schemes over algebraic data types. The theoretical basis for the schema interpreter algebra.
- **CRDTs** — Shapiro, Preguiça, Baquero & Zawirski, 2011. Conflict-free Replicated Data Types. The merge semantics behind Loro and Yjs substrates.
- **DBSP** — Budiu, McSherry, Ryzhyk & Tannen. Algebraic incremental view maintenance via Z-sets. Foundation for the compiler's incremental pipeline.
- **Concurrent Constraint Programming** — Saraswat, 1993. Theoretical ancestor of Perspective's constraint-based CRDTs.
- **CALM Theorem** — Hellerstein, 2010. Consistency as logical monotonicity.
- **Datalog** — Ullman, 1988. The query language powering Perspective's solver.

## License

MIT — see [LICENSE](./LICENSE).
