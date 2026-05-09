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
>
> **System invariants**:
> 1. **The exchange never inspects `SubstratePayload`.** Transports carry payloads opaquely; only the substrate produces and consumes them (`packages/exchange/src/sync-program.ts`, `packages/schema/src/substrate.ts`).
> 2. **The session program never sees documents; the sync program never sees channels.** Two pure TEA programs, one serialized dispatch queue, one `sync-event` effect as the only coupling (`packages/exchange/src/session-program.ts`, `sync-program.ts`, `synchronizer.ts`).
> 3. **`[CHANGEFEED]` is the universal reactive interface.** Every reactive value in Kyneta — schema refs, `LocalRef`, `ReactiveMap`, `Collection`, `SecondaryIndex`, `exchange.peers`, `exchange.documents` — exposes the same two-method protocol (`packages/changefeed/src/changefeed.ts`).
> 4. **The grammar is closed; composition is open.** `Schema` has ten `[KIND]` values; users compose schemas freely, but do not add kinds (`packages/schema/src/schema.ts`).
> 5. **Composition-law compatibility is checked at compile time.** `bind()` applies `RestrictLaws<S, AllowedLaws>`; binding a `Schema.counter()` to a substrate without `"additive"` in its `[LAWS]` set fails in the type system (`packages/schema/src/bind.ts`).
>
> **Primary substrates**: plain JS (authoritative, ephemeral), Loro (collaborative CRDT), Yjs (collaborative CRDT).
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
| **Substrate** | A backend that stores document state and implements the `Substrate<V>` interface (version, export, merge, reader, writable). Plain JS, Loro, Yjs. |
| **Schema** | A recursive grammar value (`Schema.struct`, `Schema.list`, `Schema.text`, …) describing the shape + capabilities of a document. |
| **Bound schema** | A `(schema, factory-builder, merge-strategy)` triple captured at module scope via `bind()`. Consumed at runtime by `exchange.get`. |
| **Ref** | A typed, callable, navigable, reactive, writable reference to a document or a part of one. The interpreter stack's output. |
| **Changefeed** | The reactive protocol: `{ current, subscribe }` behind the `[CHANGEFEED]` symbol. Every reactive value in Kyneta implements it. |
| **Exchange** | The top-level sync runtime — one per participant. Holds transports, stores, governance, and `DocRuntime`s. |
| **Transport** | The abstract interface between exchange and wire. WebSocket, SSE, WebRTC, Unix socket, in-process bridge — each implements it. |
| **Session / Sync programs** | Two pure TEA programs inside the exchange — session owns channel topology + peers; sync owns document convergence + sync protocols. |
| **Substrate payload** | Opaque state-transfer blob with `kind: "entirety" \| "since"`. Produced by substrates, carried by transports, consumed by substrates. The exchange never opens it. |
| **Sync protocol** | A structured record with `writerModel`, `delivery`, and `durability` axes. Three named constants — `SYNC_COLLABORATIVE`, `SYNC_AUTHORITATIVE`, `SYNC_EPHEMERAL` — tell the exchange which sync shape to run per document. Each binding target (`json`, `ephemeral`, `loro`, `yjs`) has a fixed sync protocol. |

## Package roles

| Package | Role | Key abstractions |
|---------|------|------------------|
| `@kyneta/changefeed` | Universal reactive protocol (tier-0, zero deps). | `CHANGEFEED` symbol, `Changefeed<S, C>`, `Changeset<C>`, `ReactiveMap<K, V, C>`, `Callable` |
| `@kyneta/machine` | Pure Mealy-machine algebra + two runtimes. | `Program<Msg, Model, Fx>`, `runtime`, `createObservableProgram` |
| `@kyneta/schema` | Schema grammar, substrate/replica contracts, interpreter stack, migrations, position algebra. | `Schema`, `Substrate<V>`, `bind()`, `Ref<S>`, `Migration`, `Position` |
| `@kyneta/loro-schema` / `@kyneta/yjs-schema` | CRDT substrate implementations — Loro and Yjs respectively. | `loro.bind()`, `yjs.bind()`, `LoroVersion`, `YjsVersion` |
| `@kyneta/transport` | Abstract transport contract, channel lifecycle, six-message protocol vocabulary. | `Transport<G>`, `Channel`, `ChannelMsg` |
| `@kyneta/wire` | Universal wire format — `Frame<T>`, binary CBOR codec, text JSON codec, fragmentation, stream framing. | `Frame<T>`, `cborCodec`, `textCodec`, `FragmentCollector<T>`, `feedBytes` |
| `@kyneta/bridge-transport` | In-process transport for testing — codec-faithful + alias-aware delivery. | `Bridge`, `BridgeTransport`, `createBridgeTransport` |
| `@kyneta/websocket-transport` | WebSocket transport (browser, server, Bun, service-to-service). Binary CBOR wire. | `createWebsocketClient`, `WebsocketServerTransport` |
| `@kyneta/sse-transport` | Server-Sent Events transport — asymmetric transport, symmetric text encoding. | `createSseClient`, `SseServerTransport`, `createSseExpressRouter` |
| `@kyneta/webrtc-transport` | BYODC WebRTC transport — the application owns the data channel; this attaches. | `createWebrtcTransport`, `DataChannelLike` |
| `@kyneta/unix-socket-transport` | Unix-domain-socket transport for server-to-server sync + leaderless peer negotiation. | `createUnixSocketClient`, `UnixSocketServerTransport`, `createUnixSocketPeer` |
| `@kyneta/leveldb-store` | LevelDB `Store` implementation for server-side persistence. | `createLevelDBStore` |
| `@kyneta/indexeddb-store` | IndexedDB `Store` implementation for browser-side persistence. | `createIndexedDBStore`, `deleteIndexedDBStore` |
| `@kyneta/sqlite-store` | Universal SQLite `Store` — synchronous adapter shape (better-sqlite3, bun:sqlite, future Cloudflare DO). | `SqliteStore`, `createSqliteStore`, `fromBetterSqlite3`, `fromBunSqlite` |
| `@kyneta/sql-store-core` | Pure helpers shared by every SQL-family store — `RowShape`, `toRow`/`fromRow`, `planAppend`/`planReplace`, `failOnNthCall`. | `RowShape`, `toRow`, `fromRow`, `planAppend`, `planReplace` |
| `@kyneta/postgres-store` | Async-native Postgres `Store` over `pg`; `createPostgresStore` validates the canonical schema. | `PostgresStore`, `createPostgresStore` |
| `@kyneta/prisma-store` | `Store` over a caller-supplied `PrismaClient`. Loose `unknown` typing for Prisma-version portability. | `PrismaStore`, `createPrismaStore` |
| `@kyneta/exchange` | Sync runtime — TEA session + sync programs, governance, capabilities, Line, reactive peer/doc collections. | `Exchange`, `Policy`, `Governance`, `Line`, `LineProtocol` |
| `@kyneta/index` | DBSP-grounded reactive indexing — ℤ-set algebra, `Source`, `Collection`, `SecondaryIndex`, `JoinIndex`. | `Source.of`, `Collection.from`, `Index.by`, `Index.join` |
| `@kyneta/react` | React bindings — hooks + text-adapter, all `useSyncExternalStore` over pure stores. | `ExchangeProvider`, `useValue`, `useDocument`, `useSyncStatus`, `useText` |
| `@kyneta/compiler` (exp.) | Target-agnostic IR producer. Parses builder patterns → classified IR for rendering targets. | IR + `analyze`, `walk`, `transforms` |
| `@kyneta/cast` (exp.) | Web rendering target — consumes compiler IR, emits code calling delta regions. | `mount`, `hydrate`, five region primitives, `state()` |
| `@kyneta/perspective` (exp., private) | Convergent Constraint Systems — standalone constraint-based approach to CRDTs. | `createReality`, `solve`, Datalog evaluator |

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

@kyneta/perspective (standalone — private, zero kyneta deps)
```

Two tier-0 packages carry no Kyneta dependencies: `@kyneta/changefeed` (the reactive contract) and `@kyneta/machine` (the state-machine algebra). Everything else composes above them. The exchange sits at the confluence of schema (for substrates), transport (for wires), and changefeed (for reactive collections); the four concrete transports depend on wire and transport but not on exchange — they serve the exchange through the abstract `Transport<G>` contract.

## Vertical slice — the todo example

`examples/todo` exercises the full stack — schema definition through collaborative sync through compiled web UI — in ~280 lines across ~10 packages. The data flow for a single keystroke:

```
User types into <input>                                   (1)
     │
     ▼
useText(doc.title)'s text-adapter captures `input` event  (2)
     │
     ├─ diffText(oldValue, newValue, cursorHint) → TextChange
     ▼
change(doc, d => d.title.insert(...))                     (3)
     │
     ├─ substrate.prepare → applyChangeToYjs → commit inside Y.transact
     ▼
Y.Doc mutates; rootMap.observeDeep fires                  (4)
     │
     ├─ Yjs substrate's event bridge → kyneta Changeset
     ▼
Schema composed changefeed emits Changeset<Op>            (5)
     │
     ├──► @kyneta/react's useValue re-renders dependent components
     ├──► @kyneta/cast regions apply O(k) DOM ops
     │
     └──► Exchange's subscriber filters by origin ≠ "sync"
          │
          ▼
     sync program: local-doc-change → send-to-peers       (6)
          │
          ├─ substrate.exportSince(peerVersion) → SubstratePayload
          │
          └─ for each synced peer:
               envelope { offer, docId, payload, version }
               │
               ▼
          @kyneta/wire encodes: cborCodec → binary frame   (7)
               │
               └─ WebSocket transport: socket.send(frame)
                     │
                     ▼   (across the network)
                  Remote peer's WebSocket onMessage
                     │
                     ▼
               decodeBinaryMessages → ChannelMsg[]         (8)
                     │
                     ▼
               remote Synchronizer's sync program:
                  sync/message-received { offer }
                     │
                     ▼
               substrate.merge(payload, "sync")            (9)
                     │
                     ├─ Y.applyUpdate → observeDeep fires
                     ▼
               changefeed emits Changeset with origin="sync" (10)
                     │
                     ├──► remote React useValue re-renders
                     └──► exchange subscriber: origin === "sync" → skip (no re-broadcast)
```

Ten numbered steps cross eight packages — `@kyneta/react`, `@kyneta/cast`, `@kyneta/schema`, `@kyneta/yjs-schema`, `@kyneta/changefeed`, `@kyneta/exchange`, `@kyneta/wire`, `@kyneta/websocket-transport` — with `@kyneta/transport` and `@kyneta/machine` providing abstract scaffolding underneath. Every boundary is one of the protocols above: a schema `Change`, a substrate `SubstratePayload`, a transport `ChannelMsg`, a wire `Frame`, a changefeed `Changeset`. No package reaches across two boundaries.

## See also

- `TECHNICAL.md` — factual reference: canonical test counts, build commands, workspace tree, per-package summaries.
- Per-package `TECHNICAL.md` — architecture, vocabulary, source-of-truth citations for each package.
