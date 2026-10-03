# Kyneta — Architecture

> **Thesis**: A schema is a structure; a substrate stores it; a transport moves it; the exchange keeps peers convergent; the reactive contract observes it — each concern lives in exactly one place.
>
> **Design principles**:
> - **Functional Core / Imperative Shell.** Every non-trivial module splits pure state transitions from I/O and effect interpretation. Pure cores are tested without mocks; shells are thin.
> - **Symbol protocols over base classes.** `[CHANGEFEED]`, `[NATIVE]`, `[SUBSTRATE]`, `[KIND]`, `[LAWS]`, `[POSITION]`, `[TRANSACT]` let any value participate in a protocol without subclassing. Structural typing over nominal.
> - **The Elm Architecture (TEA).** State machines are pure `Program<Msg, Model, Fx>` values; runtimes interpret their effects. `@kyneta/machine` is the algebra; every transport's client lifecycle and the exchange's session/sync programs are instances.
> - **Substrate agnosticism.** `@kyneta/schema` defines the boundary; substrates (plain, Loro, Yjs) implement it. The exchange never inspects substrate-native state; transports never inspect substrate payloads.
> - **Content-addressed identity.** Schema identities, document hashes, and CnIds are all derived from content — renames change display names, not stored data.
> - **Delta-driven reactivity.** Every update flows as a typed change through `[CHANGEFEED]`. Subscribers compute the minimum necessary work from the change, not by re-running queries.
> - **Observation is a passive side-output, not convergence state.** DevTools observability (`exchange.observe`, experimental) tees the exchange's existing effect/message streams into an `ObsEvent` bus — fire-and-forget, zero-cost when unobserved, never a Mealy effect and never re-entering dispatch. Distinct from `[CHANGEFEED]` reactive convergence.
>
> **System invariants**:
> 1. **The exchange never inspects `SubstratePayload`.** Transports carry payloads opaquely; only the substrate produces and consumes them (`packages/exchange/src/sync-program.ts`, `packages/schema/src/substrate.ts`).
> 2. **The session program never sees documents; the sync program never sees channels.** Two pure TEA programs, one serialized dispatch queue, one `sync-event` effect as the only coupling (`packages/exchange/src/session-program.ts`, `sync-program.ts`, `synchronizer.ts`).
> 3. **`[CHANGEFEED]` is the universal reactive interface.** Every reactive value in Kyneta — schema refs, `LocalRef`, `ReactiveMap`, `Collection`, `SecondaryIndex`, `exchange.peers`, `exchange.documents` — exposes the same two-method protocol (`packages/changefeed/src/changefeed.ts`).
> 4. **The grammar is closed; composition is open.** `Schema` has eleven `[KIND]` values; users compose schemas freely, but do not add kinds (`packages/schema/src/schema.ts`).
> 5. **Composition-law compatibility is checked at compile time.** `bind()` applies `RestrictLaws<S, AllowedLaws>`; binding a `Schema.counter()` to a substrate without `"additive"` in its `[LAWS]` set fails in the type system (`packages/schema/src/bind.ts`).
>
> **Primary substrates**: plain JS (authoritative), ephemeral (transient field-level CvRDT), Loro (collaborative CRDT), Yjs (collaborative CRDT).
> **Primary transports**: WebSocket, SSE, WebRTC, Unix socket, in-process bridge.
> **Primary consumer**: React (+ any framework via `[CHANGEFEED]`).

Kyneta is a framework for collaborative, substrate-agnostic documents. You define a schema once, pick a substrate (plain JS for authoritative data, Loro or Yjs for collaborative CRDTs), and receive a typed, reactive, writable reference to the document. Peer-to-peer sync happens over any registered transport; reactive bindings deliver changes to your UI through one observation protocol; incremental indexes build live joins and filters on top of collections. Everything composes through small symbol-keyed protocols, with no framework runtime beyond the primitives each layer provides.

---

## Questions this document answers

- What does Kyneta *do* in one sentence? → [Thesis](#thesis) above
- How do the packages relate? → [Package roles](#package-roles) + [Dependency flow](#dependency-flow)
- Where does the `[CHANGEFEED]` protocol live and who speaks it? → [Package roles](#package-roles), `@kyneta/changefeed`
- How does a local mutation reach a remote peer? → [Vertical slice](#vertical-slice--the-todo-example)
- Why are session and sync separate? → [System invariants](#thesis), invariant 2
- Where does substrate choice happen, and what does it constrain? → [Package roles](#package-roles), `@kyneta/schema`
- What's the relationship between `@kyneta/compiler` and `@kyneta/cast`? → [Package roles](#package-roles)

## Vocabulary

| Term | Means |
|------|-------|
| **Substrate** | The store of one document's state, behind `Substrate<V>`: a replica, plus what a ref needs (a reader, the prepare pipeline, a write context, the local-update signal). Plain JS, ephemeral, Loro, Yjs. |
| **Replica** | The headless half of a substrate (`Replica<V>`): versions, export, merge, digest, dispose. No schema and no ref; what a relay holds (`exchange.replicate`). |
| **Schema** | A recursive grammar value (`Schema.struct`, `Schema.list`, `Schema.text`, …) describing the shape + capabilities of a document. |
| **Bound schema** | What `bind()` (and `json.bind`, `loro.bind`, …) returns at module scope: a schema, a substrate factory builder and a sync mode, with what follows from them (replica type, schema hash, identity binding, migration chain, supported hashes). Consumed at runtime by `exchange.get` / `open` and the `schemas` option. |
| **Ref** | A typed, callable, navigable, reactive, writable reference to one coordinate of a document. `createRef` builds the root over a substrate; what a ref does is built once per schema node and position, and each coordinate is one bound function and one state record. |
| **Changefeed** | The reactive protocol: `{ current, subscribe }` behind the `[CHANGEFEED]` symbol. Every reactive value in Kyneta implements it. A `Feed` is a function that reads a value and carries the protocol, the shape of a document's terms (`settledFeed`, `writeRefusalFeed`, …). |
| **Exchange** | The network shell, one per participant: transports, governance (`Policy`), and the Synchronizer, over a `Runtime`. |
| **Runtime** | The local shell: the documents (their lifecycle program), the store (its store program), and the lease. An Exchange wraps one; it also runs standalone, without a network. |
| **Transport** | The abstract interface between exchange and wire. WebSocket, SSE, WebRTC, Unix socket, in-process bridge — each implements it. |
| **Session / Sync programs** | Two pure TEA programs inside the exchange — session owns channel topology + peers; sync owns document convergence + sync modes. The Runtime's lifecycle and store programs are pure TEA programs too. |
| **Substrate payload** | Opaque state-transfer blob with `kind: "entirety" \| "since"`. Produced by substrates, carried by transports, consumed by substrates. The exchange never opens it. |
| **Sync mode** | A structured record with `writerModel` and `durability` axes. Three named constants — `SYNC_COLLABORATIVE`, `SYNC_AUTHORITATIVE`, `SYNC_EPHEMERAL` — tell the exchange which sync shape to run per document. Each binding target (`json`, `ephemeral`, `loro`, `yjs`) has a fixed sync mode. |

## Package roles

| Package | Role | Key abstractions |
|---------|------|------------------|
| `@kyneta/changefeed` | Universal reactive protocol (tier-0, zero deps). | `CHANGEFEED` symbol, `Changefeed<S, C>`, `Changeset<C>`, `ReactiveMap<K, V, C>`, `Callable` |
| `@kyneta/machine` | Pure Mealy-machine algebra + two runtimes. | `Program<Msg, Model, Fx>`, `runtime`, `createObservableProgram` |
| `@kyneta/schema` | Schema grammar, substrate/replica contracts, refs and interpreters (folds over the grammar), migrations, position algebra. | `Schema`, `Substrate<V>`, `bind()`, `Ref<S>`, `Migration`, `Position` |
| `@kyneta/loro-schema` / `@kyneta/yjs-schema` | CRDT substrate implementations — Loro and Yjs respectively. | `loro.bind()`, `yjs.bind()`, `LoroVersion`, `YjsVersion` |
| `@kyneta/transport` | Abstract transport contract, channel lifecycle, nine-message protocol vocabulary, wire pipeline, alias transformer, frame-stream parser. | `Transport<G>`, `Channel`, `ChannelMsg`, `Pipeline`, `FrameStreamParser` |
| `@kyneta/wire` | Universal wire format — `Frame<T>`, binary CBOR codec, text JSON codec, generic fragmentation, reassembly, validation. | `Frame<T>`, `BINARY_CODEC`, `TEXT_CODEC`, `Reassembler<T>`, `fragmentGeneric<T>`, `validateWireMessage` |
| `@kyneta/bridge-transport` | In-process transport for testing — codec-faithful + alias-aware delivery. | `Bridge`, `BridgeTransport`, `createBridgeTransport` |
| `@kyneta/websocket-transport` | WebSocket transport (browser, server, Bun, service-to-service). Binary CBOR wire. | `createWebsocketClient`, `WebsocketServerTransport` |
| `@kyneta/sse-transport` | Server-Sent Events transport — asymmetric transport, symmetric text encoding. | `createSseClient`, `SseServerTransport`, `createSseExpressRouter` |
| `@kyneta/webrtc-transport` | BYODC WebRTC transport — the application owns the data channel; this attaches. | `createWebrtcTransport`, `DataChannelLike` |
| `@kyneta/unix-socket-transport` | Unix-domain-socket transport for server-to-server sync + leaderless peer negotiation. | `createUnixSocketClient`, `UnixSocketServerTransport`, `createUnixSocketPeer` |
| `@kyneta/leveldb-store` | LevelDB `Store` implementation for server-side persistence. | `createLevelDBStore` |
| `@kyneta/indexeddb-store` | IndexedDB `Store` implementation for browser-side persistence. | `createIndexedDBStore`, `deleteIndexedDBStore` |
| `@kyneta/sqlite-store` | Universal SQLite `Store` — synchronous adapter shape (better-sqlite3, bun:sqlite, future Cloudflare DO). | `SqliteStore`, `createSqliteStore`, `fromBetterSqlite3`, `fromBunSqlite` |
| `@kyneta/sql-store-core` | Pure helpers shared by every SQL-family store — `RowShape`, `toRow`/`fromRow`, `planAppend`/`planReplace`. | `RowShape`, `toRow`, `fromRow`, `planAppend`, `planReplace` |
| `@kyneta/postgres-store` | Async-native Postgres `Store` over `pg`; `createPostgresStore` validates the canonical schema. | `PostgresStore`, `createPostgresStore` |
| `@kyneta/prisma-store` | `Store` over a caller-supplied `PrismaClient`. Loose `unknown` typing for Prisma-version portability. | `PrismaStore`, `createPrismaStore` |
| `@kyneta/exchange` | Sync runtime — TEA session + sync programs, governance, capabilities, Line, reactive peer/doc collections. | `Exchange`, `Policy`, `Governance`, `Line`, `LineProtocol` |
| `@kyneta/index` | DBSP-grounded reactive indexing — ℤ-set algebra, `Source`, `Collection`, `SecondaryIndex`, `JoinIndex`. | `Source.of`, `Collection.from`, `Index.by`, `Index.join` |
| `@kyneta/react` | React bindings — hooks + text-adapter, `useSyncExternalStore` over `@kyneta/reactive` computations and changefeeds; a hook's value keeps its identity until what it read changes. | `ExchangeProvider`, `useValue`, `useSelector`, `useTracked`, `useDocument`, `useDocReady`, `useSyncState`, `useText` |
| `@kyneta/devtools` (exp.) | Observability aggregation — a world model folded from `exchange.observe()` (`ObsEvent`), composed from `@kyneta/index` + `@kyneta/changefeed`. One pure classifier; the rest is reused machinery. | `createWorldModel`, `attach`, `classify`, `docView` |
| `@kyneta/compiler` (exp.) | Target-agnostic IR producer. Parses builder patterns → classified IR for rendering targets. | IR + `analyze`, `walk`, `transforms` |
| `@kyneta/cast` (exp.) | Web rendering target — consumes compiler IR, emits code calling delta regions. | `mount`, `hydrate`, five region primitives, `state()` |
| `@kyneta/zset` (0.x, independent) | DBSP ℤ-set type and algebra — weighted sets keyed by string identity. Tier-0, zero deps. | `ZSet<T>`, `zsetAdd`, `zsetNegate`, `zsetPositive`, `zsetMap` |
| `@kyneta/datalog` (0.x, independent) | Stratified, semi-naive, incremental Datalog evaluator. Negation, aggregation, guards, host-computed relations. Knows nothing about constraints. | `Rule`, `Atom`, `Value`, `evaluate`, `createEvaluator`, `stratify`, `Host` |
| `@kyneta/perspective` (0.x, independent) | Convergent Constraint Systems — standalone constraint-based approach to CRDTs. | `createReality`, `solve`, `Constraint`, `Reality` |

## Dependency flow

```
@kyneta/changefeed (zero deps)
   │
   ├─► @kyneta/schema ──► @kyneta/loro-schema
   │      │              @kyneta/yjs-schema
   │      │              @kyneta/index
   │      │              @kyneta/compiler ──► @kyneta/cast
   │      │
   │      ▼
   │  @kyneta/transport (+ @kyneta/machine) ──► @kyneta/wire
   │      │                                           │
   │      ▼                                           ├─► @kyneta/websocket-transport
   │   @kyneta/exchange ◄─────────────────────────────┤
   │      │                                           ├─► @kyneta/sse-transport
   │      ├─► @kyneta/leveldb-store                   ├─► @kyneta/webrtc-transport
   │      ├─► @kyneta/indexeddb-store                 └─► @kyneta/unix-socket-transport
   │      ├─► @kyneta/sqlite-store ──┐
   │      ├─► @kyneta/postgres-store ├──► @kyneta/sql-store-core (pure helpers)
   │      ├─► @kyneta/prisma-store ──┘
   │      └─► @kyneta/react (+ react)
   │
@kyneta/machine (zero deps) ─► @kyneta/transport + the four transport clients

@kyneta/zset ─► @kyneta/datalog ─► @kyneta/perspective
   (standalone chain — no other kyneta deps, each versioned independently)
```

Two tier-0 packages carry no Kyneta dependencies: `@kyneta/changefeed` (the reactive contract) and `@kyneta/machine` (the state-machine algebra). Everything else composes above them. The exchange sits at the confluence of schema (for substrates), transport (for wires), and changefeed (for reactive collections); the four concrete transports depend on wire and transport but not on exchange — they serve the exchange through the abstract `Transport<G>` contract.

## Vertical slice — the todo example

`examples/todo` exercises the full stack — schema definition through collaborative sync through compiled web UI — in ~280 lines of TypeScript. Each browser tab links to one Bun server over WebSocket; the server holds the document and relays between tabs. The schema is bound with `loro.bind` (swapping in `yjs.bind` changes nothing below). The data flow for adding one todo:

```
User submits the form; onSubmit calls doc.todos.push(…)   (1)
     │
     ├─ a bare helper call opens and closes its own batch
     ▼
WritableContext.prepare: locate, complete, then           (2)
  substrate.prepare
     │
     ├─ σ (the shadow) updated; changeToDiff → LoroDoc.applyDiff
     ├─ one doc.commit() per outermost batch; the pre-commit hook
     │  marks it ours, so the event bridge does not announce it again
     ▼
Sealed batch delivered as a Changeset (replay: false)     (3)
     │
     ├──► @kyneta/cast's listRegion inserts one <li>
     └──► Runtime → Exchange onDocChangeset: observation only
     │
     ▼
LoroDoc local-update signal (subscribeLocalUpdates)       (4)
     │
     ├─ Runtime marks the doc dirty; one microtask drains every dirty doc
     ▼
Runtime #drainLocal → onDocAdvanced → sync/doc-advanced   (5)
     │
     ├─ buildPush: each peer we push to, shared with (canShare) and not
     │  refusing our operations, from its own baseline
     ▼
send-offers executor                                      (6)
     │
     ├─ publish gate (store-first; the todo has no store, so open)
     ├─ exportSince(baseline) → SubstratePayload, per peer
     ├─ offer { docId, payload, version } → sync/offers-sent moves baselines
     ▼
Pipeline (@kyneta/transport): alias transformer           (7)
  → @kyneta/wire CBOR encode → binary frame
     │
     └─ WebSocket client: socket.send(frame)
           │
           ▼   (across the network)
        Server's WebSocket handler → Pipeline decode     (8)
           │
           ├─ frame → WireMessage (validated) → inbound alias → ChannelMsg
           ▼
        session program → sync/message-received { offer } (9)
           │
           ├─ handleOffer: held, not leaving, canAccept ∧ canWrite
           ▼
        import-doc-data executor                          (10)
           │
           ├─ compare versions → planImport → "merge"
           ├─ replica.merge(payload, { origin: "sync" }): LoroDoc.import
           │    └─ event bridge announces the ops (replay: true)
           ├─ accept { docId, version } back to the tab
           └─ sync/doc-imported (changed) → buildPush relays to the
              other tabs, never back to the sender                (11)
                    │
                    ▼
              each other tab: steps (8)–(10) again; its listRegion
              inserts the <li>, and an import fires no local-update
              signal, so nothing is sent back
```

Eleven numbered steps cross nine packages — `@kyneta/cast`, `@kyneta/schema`, `@kyneta/loro-schema`, `@kyneta/changefeed`, `@kyneta/exchange`, `@kyneta/transport`, `@kyneta/wire`, `@kyneta/websocket-transport` and `@kyneta/machine`, whose dispatchers serialize the exchange's programs — with `@kyneta/bun-server` serving the built client. Every boundary is one of the protocols above: a schema `Change`, a substrate `SubstratePayload`, a transport `ChannelMsg`, a wire `Frame`, a changefeed `Changeset`. Two decisions keep the path one-directional: what leaves the process follows the substrate's local-update signal, never a changeset (a native write outside the schema produces none), and only an import that changed something is relayed, and never to its sender.

## See also

- `TECHNICAL.md` — factual reference: canonical test counts, build commands, workspace tree, per-package summaries.
- Per-package `TECHNICAL.md` — architecture, vocabulary, source-of-truth citations for each package.
