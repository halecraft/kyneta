# Kyneta

Your schema is your sync engine — a framework for collaborative, local-first apps.

Define your data once — sync, reactivity, validation, and persistence are derived from that single definition. Start on one machine with plain objects. Add peers, CRDTs, transports, and storage as you grow — without rewriting your app.

## Quick Start

```ts
import { Exchange, whenSettled } from "@kyneta/exchange"
import { loro } from "@kyneta/loro-schema"
import { batch, Schema } from "@kyneta/schema"
import { createWebsocketClient } from "@kyneta/websocket-transport/browser"

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
  }),
)

// 2. Create an exchange, one per peer (or server/client)
const exchange = new Exchange({
  principal: "alice",
  transports: [
    createWebsocketClient({ url: "ws://localhost:3000/ws", WebSocket }),
  ],
})

// 3. Get a document — syncs automatically
const doc = exchange.get("my-todos", TodoDoc)

batch(doc, d => {
  d.title.insert(0, "My Todos")
  d.items.push({ text: "Learn Kyneta", done: false })
})

doc.title() // "My Todos"

// Resolves once storage has loaded and the authority has answered — so you
// know you're looking at the whole document, not just the part that arrived
// first. (Nobody to wait for if this peer is itself the authority.)
await whenSettled(doc)
```

React bindings are available today. It's easy to add other bindings.

<!-- Not compiled: imports your own schema module, which is illustrative. -->
<!-- ts-docs-verifier:ignore -->

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

## Upgrading from 3.x

4.0 is a breaking release, and every peer and store upgrades together: the sync
protocol and the stored formats changed. [docs/upgrading-4.0.md](docs/upgrading-4.0.md)
covers every change with a before/after, starting with the ones your compiler
will not catch. Coming from 2.x, read [docs/upgrading-3.0.md](docs/upgrading-3.0.md)
first.

## Grow Without Rewriting

Every step below is additive — earlier code doesn't change.

| Step | What changes | What stays the same |
|------|-------------|-------------------|
| **Local document** | `createDoc(schema)` — no network, no exchange; type-safe, reactive doc, with validation | — |
| **Two peers, plain sync** | Add `Exchange` + transport | Schema, reads, writes |
| **Switch to CRDTs** | `json.bind(schema)` → `loro.bind(schema)` | Exchange, transport, reads, writes |
| **Add persistence** | Add `store: await createLevelDBStore("./data")` to exchange config | Everything above |
| **Add presence** | `ephemeral.bind(schema)` alongside your collaborative docs | Everything above |
| **Add access control** | Add a `Policy` with `canShare` / `canAccept` gates | Client code unchanged |
| **Add a relay** | One more Exchange with `resolve: () => Replicate()` | Client code unchanged |

See the [`@kyneta/exchange` README](./packages/exchange/README.md) for the full walkthrough with code.

## Observability (experimental)

Subscribe to a correlated event stream across every layer — engine (sync
state), protocol (the message vocabulary), doc (changesets), directory
(peers/documents), diagnostics (silent failures), and wire (frames):

<!-- Not compiled: a fragment; `exchange` is the one built in the Quick Start. -->
<!-- ts-docs-verifier:ignore -->

```ts
const stop = exchange.observe(ev => console.log(ev.peerId, ev.layer, ev))
// later: exchange.docHistory("my-todos")?.summary()  // version + op counts
```

Opt-in and zero-cost when no sink is attached. The `ObsEvent` shape is
experimental (`v: 1`) and may change. See `packages/exchange/PRODUCT.md`.

The stream is also serializable: `@kyneta/devtools` can tail, pipe, or record
it as NDJSON and fold it back into a reactive world model **without an
Exchange** (the observation plane is location-independent; doc *values* stay
in-process). Experimental.

## Why Kyneta

**Schemas should be walked once.** A schema tree gets traversed for reading, mutation, observation, validation, sync, and more. Most frameworks implement these as parallel switch dispatches that drift apart. Kyneta's schema algebra collapses them into one catamorphism with pluggable interpreters — all behaviors are derived from the same structure. Your schema is the single source of truth not by convention, but by construction. Add a field and every behavior follows. There is nothing else to update.

**Collaboration shouldn't require rewriting your app.** Start with plain JS objects and `createDoc()`. When you need concurrent merge, swap to `loro.bind()` or `yjs.bind()` — reads, writes, and observation don't change. The exchange syncs documents via the `Substrate` interface — the exchange doesn't need to understand the inner workings of your CRDT library of choice. This is powerful, because you can mix collaborative CRDTs, authoritative json state, and ephemeral presence in one sync network.

**Local-first means local *first*.** Authority starts local — the hardest configuration to achieve, and the one you get for free. Centralize when your needs call for it. The network is additive, not load-bearing.

## Packages

9,877 tests across the monorepo.

### Foundation

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/changefeed`](./packages/changefeed) | Universal reactive contract — a Moore machine identified by `[CHANGEFEED]`. Zero dependencies. | 60 |
| [`@kyneta/schema`](./packages/schema) | Schema algebra. One recursive `Schema` type; typed refs for reading, mutation and observation; one generic `interpret()` catamorphism for materializing, validation and defaults; selective undo. | 2,721 |
| [`@kyneta/machine`](./packages/machine) | Universal Mealy machine algebra — pure state transitions with effect outputs. Powers the exchange synchronizer and all transport clients. Zero dependencies. | 72 |
| [`@kyneta/random`](./packages/random) | Random identifiers — peer ids and document ids — that need no secure context. Zero dependencies. | 5 |

### Substrates

A plain JS substrate is built into `@kyneta/schema` — no external package needed to get started. These packages add CRDT backends:

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/loro-schema`](./packages/schema/backends/loro) | Loro CRDT substrate for `@kyneta/schema`. Schema-aware typed reads, `applyDiff`-based writes, and a persistent event bridge. | 486 |
| [`@kyneta/yjs-schema`](./packages/schema/backends/yjs) | Yjs CRDT substrate for `@kyneta/schema`. Same `Substrate` interface as Loro — swap with a one-line import change. `yjs.bind()` validates composition-law compatibility at compile time via `YjsLaws`. | 492 |

### Sync

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/exchange`](./packages/exchange) | Substrate-agnostic state exchange. Four named binding targets (`json`, `ephemeral`, `loro`, `yjs`) with fixed sync modes over a seven-message sync protocol. Hosts heterogeneous documents — Loro CRDTs, Yjs CRDTs, plain JS, ephemeral presence — in one sync network, with policies, durable storage and undo across documents. | 2,165 |
| [`@kyneta/transport`](./packages/transport) | Transport infrastructure — base class, channel types, message vocabulary, wire pipeline, alias transformer, and client utilities. | 76 |
| [`@kyneta/wire`](./packages/exchange/wire) | Wire format codecs, framing, generic fragmentation, reassembly, and validation. CBOR binary codec, JSON text codec, `Reassembler<T>`, and substrate-agnostic `fragmentGeneric<T>`. | 266 |

### Transports

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/websocket-transport`](./packages/exchange/transports/websocket) | WebSocket transport. Client, server, and Bun-specific handlers with connection lifecycle, keepalive, and reconnection. | 68 |
| [`@kyneta/sse-transport`](./packages/exchange/transports/sse) | SSE transport. Client, server, and Express integration with reconnection state machine. | 47 |
| [`@kyneta/webrtc-transport`](./packages/exchange/transports/webrtc) | WebRTC data channel transport. BYODC (Bring Your Own Data Channel) with binary CBOR encoding and fragmentation. | 27 |
| [`@kyneta/unix-socket-transport`](./packages/exchange/transports/unix-socket) | Unix domain socket transport. Stream-oriented, backpressure-aware server-to-server sync. | 78 |
| [`@kyneta/bridge-transport`](./packages/exchange/transports/bridge) | In-process transport for tests: several Exchanges in one process, over the production wire pipeline. | 4 |

### Storage

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/indexeddb-store`](./packages/exchange/stores/indexeddb) | IndexedDB storage for the browser. Tabs over one database each hold their own durable identity. | 49 |
| [`@kyneta/leveldb-store`](./packages/exchange/stores/leveldb) | LevelDB storage for a single server process. | 54 |
| [`@kyneta/sqlite-store`](./packages/exchange/stores/sqlite) | SQLite storage over `better-sqlite3`, `bun:sqlite` or a Durable Object. One process owns a database. | 40 |
| [`@kyneta/postgres-store`](./packages/exchange/stores/postgres) | Postgres storage over `pg`. Many processes may share one schema. | 9 |
| [`@kyneta/prisma-store`](./packages/exchange/stores/prisma) | Storage through a Prisma client you supply. | 39 |
| [`@kyneta/sql-store-core`](./packages/exchange/stores/sql-core) | The helpers the SQL stores share; for writing a SQL store of your own. | 25 |

### Indexes

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/index`](./packages/index) | DBSP-grounded reactive indexing — Source, Collection, Index over ℤ-set algebra. | 183 |

### Bindings

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/reactive`](./packages/reactive) | Fine-grained reactive computations over the changefeed, with automatic dependency tracking. | 14 |
| [`@kyneta/react`](./packages/react) | React bindings over `@kyneta/schema` + `@kyneta/exchange`. Hooks for document access, sync status, text editing with undo, and reactive observation via `useSyncExternalStore`. | 105 |

### Observability (experimental)

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/devtools`](./packages/devtools) | Reactive world model over `exchange.observe()` (`ObsEvent`), composed from `@kyneta/index` + `@kyneta/changefeed`. One pure classifier; cross-peer correlation by `docId`. NDJSON egress/ingest, a `convergence` rollup, and a diagnostics-loud log. Experimental. | 38 |

## Dependencies

```
@kyneta/changefeed · @kyneta/machine · @kyneta/random   (zero dependencies)
    │
    └──► @kyneta/schema                      (the algebra everything builds on)
            ├──► @kyneta/loro-schema         (+ loro-crdt)
            ├──► @kyneta/yjs-schema          (+ yjs)
            ├──► @kyneta/reactive
            ├──► @kyneta/compiler ──► @kyneta/cast            ── experimental
            │
            └──► @kyneta/wire
                    └──► @kyneta/transport
                            ├──► websocket · sse · webrtc · unix-socket · bridge transports
                            └──► @kyneta/exchange
                                    ├──► indexeddb · leveldb · sqlite · postgres · prisma stores
                                    ├──► @kyneta/index       (exchange optional)
                                    ├──► @kyneta/react       (+ react, reactive)
                                    └──► @kyneta/devtools    (+ index) ── experimental

@kyneta/zset ──► @kyneta/datalog ──► @kyneta/perspective
                                        (standalone chain — independent versioning)
```

`@kyneta/changefeed` defines the universal reactive contract — the `[CHANGEFEED]` symbol protocol. `@kyneta/schema` builds the interpreter algebra on top of it. Everything else — substrates, exchange, transports, bindings — builds on schema's `Substrate` interface and changefeed's reactive protocol.

## Examples

| Example | Description |
|---------|-------------|
| [`todo`](./examples/todo) | Minimal collaborative todo list — Cast compiler + Exchange + Yjs over WebSocket |
| [`todo-react`](./examples/todo-react) | Same domain, React bindings — proves the sync layer is framework-agnostic |
| [`bumper-cars`](./examples/bumper-cars) | Heterogeneous documents in one Exchange — collaborative CRDTs, authoritative server state, and ephemeral presence side by side |
| [`unix-socket-sync`](./examples/unix-socket-sync) | Leaderless TUI config sync over Unix sockets — N identical processes, one socket path, Loro CRDT convergence |
| [`prisma-counter`](./examples/prisma-counter) | Collaborative Loro counter with Prisma/Postgres persistence — survives server restart |

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
| [`@kyneta/compiler`](./experimental/compiler) | Target-agnostic incremental view maintenance compiler. Transforms TypeScript AST into classified IR annotated with binding times, delta kinds, and incremental strategies. | 547 |
| [`@kyneta/cast`](./experimental/cast) | Web rendering target (codename Kinetic). Consumes compiler IR and produces DOM manipulation code that directly consumes CRDT deltas — character-level text patches, O(k) list updates, branch swapping — with no virtual DOM and no diffing. | 634 |

CRDTs already know what changed. When you insert a character, the CRDT emits a delta saying exactly where. Traditional UI frameworks ignore this — they diff output to rediscover changes. The compiler transforms natural TypeScript into code that directly consumes these deltas, achieving O(k) DOM updates where k is the number of operations. See the [Kinetic status](./experimental/cast/README.md#prototype-status) for details.

### Convergent Constraint Systems

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/perspective`](./packages/perspective) | Constraint-based CRDTs (codename Prism). Agents assert constraints, merge is set union, and a stratified Datalog evaluator derives shared reality. Includes an incremental pipeline based on DBSP. Versioned independently of the core packages. | 933 |
| [`@kyneta/datalog`](./packages/datalog) | The evaluator, as its own package. Stratified, semi-naive, incremental: rules and facts in, derived facts out, as a batch or as deltas over a long-lived database. Negation, aggregation, guards, a join index, host-computed relations. Knows nothing about constraints — a game runtime uses it without any CRDT in sight. | 424 |
| [`@kyneta/zset`](./packages/zset) | The DBSP ℤ-set both of the above are built on — a weighted set keyed by string identity, and the algebra over it. Zero dependencies. | 61 |

Traditional CRDTs couple state representation with merge logic. Perspective separates them: the semilattice moves to constraint sets, and a Datalog solver derives state. Conflict resolution strategies become rules that travel inside the data. See the [Perspective README](./packages/perspective/README.md) for the full treatment.

Because conflict resolution is Datalog rather than code, the evaluator that runs it turned out to be useful on its own — it is now `@kyneta/datalog`, and a generative roguelike uses it as a rules engine with no CRDT anywhere. See the [Datalog README](./packages/datalog/README.md).

## Academic Foundations

- **Bananas, Lenses, Envelopes and Barbed Wire** — Meijer, Fokkinga & Paterson, 1991. F-algebras, catamorphisms, and recursion schemes over algebraic data types. The theoretical basis for the schema interpreter algebra.
- **CRDTs** — Shapiro, Preguiça, Baquero & Zawirski, 2011. Conflict-free Replicated Data Types. The merge semantics behind Loro and Yjs substrates.
- **DBSP** — Budiu, McSherry, Ryzhyk & Tannen. Algebraic incremental view maintenance via Z-sets. Foundation for the compiler's incremental pipeline.
- **Concurrent Constraint Programming** — Saraswat, 1993. Theoretical ancestor of Perspective's constraint-based CRDTs.
- **CALM Theorem** — Hellerstein, 2010. Consistency as logical monotonicity.
- **Datalog** — Ullman, 1988. The query language powering Perspective's solver.

## License

MIT — see [LICENSE](./LICENSE).
