# @kyneta/exchange — Technical Reference

> **Package**: `@kyneta/exchange`
> **Role**: Substrate-agnostic document sync runtime. Orchestrates channel topology, document convergence, and persistence above any transport and any `@kyneta/schema` substrate — via pure programs (session and sync, held by a Synchronizer shell that owns the serialized dispatch queue; store and lifecycle, held by a **Runtime**, the local imperative shell: documents + store + lease + clock), and an **Exchange** façade (the network shell: transports + peers + governance) that composes a Runtime.
> **Depends on**: `@kyneta/schema` (peer), `@kyneta/changefeed` (peer), `@kyneta/transport` (direct)
> **Depended on by**: `@kyneta/react` (peer), `@kyneta/leveldb-store`, `@kyneta/indexeddb-store`, `@kyneta/sqlite-store`, `@kyneta/postgres-store`, `@kyneta/prisma-store`, `@kyneta/sql-store-core`, application code, every transport package (dev)
> **Canonical symbols**: `Exchange`, `ExchangeParams`, `Runtime`, `RuntimeParams`, `RuntimeHooks`, `DocReadyInfo`, `lifecycleProgram`, `Lifecycle`, `Synchronizer`, `SessionModel`, `SessionInput`, `SessionEffect`, `SyncModel`, `SyncInput`, `SyncEffect`, `createSessionUpdate`, `createSyncUpdate`, `planLeave`, `Governance`, `Policy`, `composeGate`, `GatePredicate`, `EpochBoundaryPredicate`, `Line`, `LineProtocol`, `Capabilities`, `ReplicaLike`, `ReplicaFactoryLike`, `ReplicaKey`, `DEFAULT_REPLICAS`, `Interpret`, `Replicate`, `Defer`, `Reject`, `Disposition`, `PeerNaming`, `PeerChange`, `DocChange`, `DocInfo`, `PeerState`, `PeerSyncState`, `PeerDocSyncState`, `Connectivity`, `deriveConnectivity`, `Store`, `StoreRecord`, `StoreMeta`, `DocMetadata`, `whenPeer`, `sync` (helper), `SyncMode`, `SYNC_COLLABORATIVE`, `SYNC_AUTHORITATIVE`, `SYNC_EPHEMERAL`, `requiresBidirectionalSync`, `BindingTarget`, `createBindingTarget`
> **Key invariant(s)**:
> 1. The exchange never inspects `SubstratePayload` contents. Payloads are opaque blobs carried by `offer` messages; only the substrate produces and consumes them.
> 2. The session program never sees documents. The sync program never sees channels, transports, or connection state. They share a single dispatch queue and communicate exclusively through `sync-event` effects the shell forwards.
> 3. Every reactive output — `exchange.peers`, `exchange.documents`, per-doc ready state — drains at quiescence in snapshot-then-clear order.
> 4. **FC/IS boundary:** The `Runtime` is the local imperative shell (each document's lifecycle and live objects, store, hydration, lease, tick clock). The `Exchange` is the network shell (transports, synchronizer, peers). The `Runtime` can be used standalone for local-first apps without any network. Substrates are pure math; the clock (`setInterval`) lives in the Runtime, not in substrates.
> 5. **Runtime hooks bridge local→network:** The Runtime fires `onDocReady`, `onDocChangeset`, `onDocAdvanced`, `onDocDestroyed`, `onDocSuspended`, `onDocResumed`. The Exchange wires these into the Synchronizer, and `onDocInterpreted` attaches each interpreted ref's network terms (`sync()`, its authority, the peer settle term; see [Document readiness](#document-readiness--a-conjunction-over-layers)). `setHooks` backfills both for documents that exist already (`onDocReady` only for those that have loaded), so a standalone Runtime wrapped later (`new Exchange(runtime, params)`) gives its documents the same capabilities as ones created through `exchange.get()`. A standalone Runtime (no Exchange) leaves them unset — docs work fully without a network. Changesets feed observation only; a local change leaves the process through `onDocAdvanced`, which the Runtime fires from the substrate's local-update signal, and from a compaction that took in records another instance stored. It is named for an advance, not a local write: both are ways the replica moves without the network. `onDocReady` hands the Synchronizer the Runtime's own `DocReadyInfo` record, which the Synchronizer reads and never replaces: it asks the Runtime to rebuild a replica (`rebuildReplica`). Two calls run the other way: `rebuildReplica`, and `Runtime.onStateAdvanced(docId)`, which the Exchange invokes when the network advanced a document's version. That call carries a `docId` and nothing else — the Runtime resolves the document's current instance itself, so the network shell never needs to hold local bookkeeping in order to make the call.

A document-sync runtime for arbitrary substrates. Hands back an `Exchange` instance that accepts a schema binding (`Todo = loro.bind(...)`), returns typed document refs (`exchange.get("doc1", Todo)`), routes their changes over any registered transport, and exposes `ReactiveMap`s of peers and documents for observation.

Imported by applications to construct the top-level sync graph; by `@kyneta/react` to bind refs into hooks; by `@kyneta/leveldb-store` to implement persistence. Internally consumes `@kyneta/transport` for transport abstractions and message vocabulary, and `@kyneta/schema` for substrate/replica contracts.

---

## Questions this document answers

- What is the difference between session and sync, and why are they split? → [Four programs, two shells](#four-programs-two-shells)
- How does a document load, become ready and close, and what is a generation? → [How a document becomes ready](#how-a-document-becomes-ready)
- How do I take a document out of memory and keep it stored, and what reaches peers meanwhile? → [Suspend, unload, destroy](#suspend-unload-destroy)
- How does a local mutation become a wire `offer`? → [The local-write path](#the-local-write-path)
- Why does a local write reach peers only once it is stored? → [Store-first](#store-first)
- What does `exchange.get(docId, bound)` actually do? → [`exchange.get` — phase in, action out](#exchangeget--phase-in-action-out)
- What does the `resolve` callback decide? → [Document classification on `present`](#document-classification-on-present)
- How do departure and reconnection interact? → [Departure, grace, reconnection](#departure-grace-reconnection)
- How does the exchange hand merge decisions back to the application? → [`Policy` and `Governance`](#policy-and-governance)
- What is a `Line` and when should I use it? → [`Line` — reliable message streams](#line--reliable-message-streams)
- How does compaction interact with sync? → [Compaction and lineage boundaries](#compaction-and-lineage-boundaries)
- Why is `peerId` issued, and what is a principal? → [Seats and principals](#seats-and-principals)
- Why does a stored peer keep its `peerId` across restarts, and what stops two tabs sharing one? → [Durable seats](#durable-seats)
- Why can only one of two tabs write a `json` document? → [Serialized documents: one writer seat per storage](#serialized-documents-one-writer-seat-per-storage)
- How do reactive `peers` / `documents` collections behave? → [Reactive collections](#reactive-collections)
- How do I tell an empty document from one that has not loaded? → [Document readiness](#document-readiness--a-conjunction-over-layers)
- How do I write a document's defaults exactly once? → [Document readiness](#document-readiness--a-conjunction-over-layers)
- How does undo span documents, survive a reload, and survive a crash mid-undo? → [Undo stacks](#undo-stacks)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `Exchange` | The top-level class. One per participant. Owns transports, a store, governance, capabilities, the `Synchronizer`, and the `ReactiveMap`s of peers/documents. | A message bus, a pub-sub hub, a database |
| `Synchronizer` | The imperative shell that runs the session and sync programs, owns the serialized dispatch queue, executes effects (sends, persistence, callbacks), and drains notifications at quiescence. | The session/sync programs themselves — those are pure data; `Synchronizer` is the runtime |
| Session program | Pure `Program<SessionInput, SessionModel, SessionEffect>` in `src/session-program.ts`. Models channel topology, establish handshake, peer identity, departure. | Sync program |
| Sync program | Pure `Program<SyncInput, SyncModel, SyncEffect>` in `src/sync-program.ts`. Models document convergence: `present`, `interest`, `offer`, `dismiss`, `vacant`, peer-sync state + the monotonic readiness accumulator, sync-mode dispatch. | Session program |
| `sync-event` effect | A `SessionEffect` whose payload is a `SyncInput`. The shell drains it into the sync program's pending-input queue in the same dispatch cycle. The one cross-program channel. | A wire message |
| Dispatch cycle | One inbound input → update → effects executed → (possibly) more inputs queued from `sync-event` effects → update again → … → quiescence. Notifications accumulate throughout, deliver once on drain. | An event-loop tick |
| Quiescence | The state after one dispatch cycle completes: session queue empty, sync queue empty, no pending `sync-event`s. Notifications drain here. | Async settlement |
| `DocReadyInfo` | The one record of a registered document: its replica and replica factory (the variance-safe `-Like` interfaces from `@kyneta/schema`, so no `Replica<any>`), the mode, sync mode and schema hash, discriminated by mode so an interpreted document's `replica` is its `Substrate`. Owned by the Runtime, which is the only one to replace its replica; the Synchronizer holds the same object, read-only. Never seen by the programs. | A document's sync state — that is `DocEntry`, in the sync program's model |
| Phase (`DocPhase`) | Which tier a document sits in: `deferred` (announced by a peer, nothing held), `replicate` (a bare `Replica`, no schema), `interpret` (substrate + `Ref<S>`), or `unloaded` (out of memory, kept in the store). `planInterpretation` (`src/interpret.ts`) classifies on it. Not a fixed classification: `interpret` is reachable from every other phase via `get()`. The reverse is reachable only for a stored document, by `unload`, which takes it out of memory; loading it again restores the tier it had. | **Suspension** — an orthogonal flag about sync-graph membership, not a phase. A suspended document is still in interpret phase, and an unloaded one keeps the flag. The lifecycle's phases, which say where a held document's load and unload stand. |
| Lifecycle phase | Where the lifecycle program (`src/lifecycle-program.ts`) has a document: `deferred`, `loading`, `ready` (loaded, or nothing to load), `failed` (its load failed), `unloading` (leaving memory) or `unloaded` (kept in the store, no instance); absent is no entry. Each held phase records the `BuildSpec` that built its instance, and so its tier. See [How a document becomes ready](#how-a-document-becomes-ready). | The tier (`DocPhase`) |
| Generation | The number the lifecycle model issues each instance of a document (a create, a load, a promotion), never reused. A completion carries it, so one that returns for an instance no longer current is ignored. | A version — a generation names an instance in this process, not a state of the document |
| `Instance` | The Runtime's live objects for one generation: replica, ref, refusals, publication record, wiring and the callbacks observing the values the model decides of it (its load, its unloading refusal). What a pure model cannot hold. `Runtime.instanceOf(docId)` returns the current one. | The document's lifecycle (`Runtime.lifecycleOf`), which is data |
| `Refusal` | Why the lifecycle program refused a request (`not-hydrated`, `load-failed`, `mismatch`, `not-held`, `not-suspended`, `already-held`, `not-stored`, `unloading`). Data: each door decides whether to throw it (`refusalError`) or skip it. | An error — `refusalError` makes one |
| `Disposition` vs `InterpretAction` | `Disposition` (`Interpret \| Replicate \| Defer \| Reject`) decides which tier a *newly discovered* document should enter. `InterpretAction` decides how an *existing* document is raised to interpret. | Each other — adjacent, and neither supersedes the other. |
| `ReactiveMap<K, V, C>` | From `@kyneta/changefeed` — a callable changefeed over a `ReadonlyMap<K, V>` with lifted accessors. | A plain `Map` — this fires the changefeed |
| `Policy` | Interface with gate predicates (`canShare`, `canAccept`, `canConnect`, `canReset`) and document handlers (`resolve`). Multiple policies register into one `Governance`. | An HTTP middleware, an authorization system |
| `Governance` | The composer. Exposes `composeGate` (pure) + the registry (imperative). Every gate evaluates three-valued logic: `false` vetoes, `true` permits, all-`undefined` falls back to default. | `Policy` — `Governance` *composes* policies |
| `composeGate` | Pure function. Takes an iterable of `boolean \| undefined` results and a default. Returns `false` if any is `false`; `true` if any is `true`; otherwise the default. | A synchronous reducer |
| `Capabilities` | Registry of supported `ReplicaType × SyncMode` pairs and their bound schemas, keyed by `ReplicaKey`. Conduit participants register only replicas; interpreters register schemas too. | A schema registry |
| `ReplicaKey` | `${replicaName}:${major}:${syncMode}` — composite string key into `Capabilities`. | A doc ID |
| `DEFAULT_REPLICAS` | The default replica-factory bundle: plain (authoritative) and ephemeral (transient CvRDT). Applications extend with Loro / Yjs replica factories as needed. | A per-doc factory |
| `Disposition` | `Interpret \| Replicate \| Defer \| Reject` — the four outcomes of classifying an unknown doc on `present`. | An HTTP status |
| `resolve` callback | Application-supplied function on `ExchangeParams`. Receives a peer + doc metadata; returns a `Disposition`. Runs only when auto-resolution (via `Capabilities`) fails. | A React ref, an async resolver |
| `Interpret(bound)` | Decision: run the full interpreter stack for this doc against `bound`. | `Replicate(replicaBound)` — no schema, no interpreter |
| `Replicate(replicaBound)` | Decision: persist and forward without interpretation. For relays / stores. | `Interpret(bound)` |
| `Defer()` | Decision: accept `present`, don't sync yet. The doc is known but inactive; the app can promote it later. | `Reject()` — defer keeps the peer-doc relationship |
| `Reject()` | Decision: refuse the doc. The peer's `present` for this doc is silently dropped. | `Defer()` |
| `SyncMode` | Structured record from `@kyneta/schema` with two orthogonal axes: `writerModel` (`"concurrent" \| "serialized"`), `durability` (`"persistent" \| "transient"`). Three named constants: `SYNC_COLLABORATIVE`, `SYNC_AUTHORITATIVE`, `SYNC_EPHEMERAL`. Drives protocol shape via field-level dispatch. | A CRDT algorithm, a string enum |
| `requiresBidirectionalSync(protocol)` | Pure predicate: `true` when `protocol.writerModel === "concurrent"`. Decides whether `interest.reciprocate` is set. | A check on what is stored rather than who writes |
| `BindingTarget` | A fixed `(substrate, sync-mode, supported-laws)` bundle with `.bind()` and `.replica()`. Named targets (`json`, `ephemeral`, `loro`, `yjs`) follow the rename-over-configure ergonomic rule. | A strategy-parameterized namespace |
| `createBindingTarget` | Pure factory for building custom `BindingTarget` objects. | A strategy-dispatching factory |
| `PeerSyncState` | The raw per-peer, per-doc projection (`{ docId, peer, state: "pending" \| "synced" \| "vacant" }`) surfaced by `sync(doc).peerStates`. Volatile — can regress on reconnect. | The monotonic `sync(doc).ready` latch |
| `ready` latch | Monotonic doc-level readiness — `sync(doc).ready` flips `true` on first reconciliation (`synced` or `vacant`) and never regresses. Backed by the `reconciledIdentities` accumulator. | `PeerSyncState[]` (volatile); a web `readyState` (connection lifecycle) |
| `present` / `interest` / `offer` / `accept` / `dismiss` / `vacant` | The six sync messages from `@kyneta/transport`. `present` carries `syncMode: SyncMode` per doc entry; `accept` says which of an offerer's versions the receiver now holds; `vacant` is the terminal negative ack to interest. | Lifecycle messages (`establish`, `depart`) |
| `ourVersionTheyHold` / `theirVersionWeHold` | The two versions `PeerDocSyncState` keeps per peer and document, independent of its `status`: the latest of *our* versions the peer holds (from its `accept`s and interests; what compaction trims to), and the latest of *its* versions we have applied (what our interests quote back as `since`). | One `lastKnownVersion` — the field they replace, which mixed the two |
| Departure | A peer leaving the sync graph. Explicit (`depart` message), or channel-drop + expired grace timer. | Disconnection — channel drop without grace-timer expiry is *disconnection*, not departure. A *document* leaving the sync graph (`suspend`, `unload`, `destroy`), which is `planLeave`'s |
| Lineage boundary | A merge that discards local state and adopts an incoming entirety — triggered when a remote peer advances past our version via `advance(to)` / compaction, **or** when the incoming version's explicit `Version.lineage` differs from ours (e.g. a writer restart with no persisted store mints a fresh `PlainVersion` lineage). Gated by `Policy.canReset`. | `reset` on a durable log |
| `Line` | A reliable bidirectional message stream between two peers, implemented as two authoritative documents (one per direction) with automatic seqno + ack pruning. | A socket, a channel, a queue |
| `LineProtocol` | The reified schema pair + topic from `Line.protocol(opts)`. Exposes `sender(exchange, peerId)`, `claimReceiver(exchange, peerId)`, `manager(exchange, peerId)` (client), addressed by the remote seat, and `listen(exchange)` (server). | `Line` — `LineProtocol` *creates* `Line` capabilities |
| Seat | A replica's `peerId`: issued fresh by each Runtime, never chosen, so no other writer holds it. | The principal |
| Principal | Who a peer says it is (`ExchangeParams.principal`, `PeerIdentityDetails.principal`). Several seats may share one; policies key on it. Not verified. | The seat |
| `Store` | The persistence interface from this package. Methods: `append`, `loadAll`, `mark`, `compact`, `delete`, `currentMeta`, `listDocIds`, `close`. An instance is owned by one Runtime; several instances may open one storage. | A reactive store — this is an append log with compaction by mark. |
| `StoreRecord` | Tagged union: `{ kind: "meta", meta: StoreMeta }` or `{ kind: "entry", payload: SubstratePayload, version: string }` — one durably-persisted record of doc state. | A `ChannelMsg` |
| `StoreMeta` | `Omit<DocMetadata, "supportedHashes">` — the metadata subset persisted per-doc in the store. | `DocMetadata` — `StoreMeta` omits `supportedHashes` |

---

## Architecture

**Thesis**: split the problem along the axis of orthogonal failure modes. Connection topology fails one way (channels drop, peers come and go); document convergence fails another (merges conflict, versions diverge, storage is behind). Solve each with its own pure program, hold both in one shell that owns dispatch ordering, and let the shell — not the programs — know about transports, storage, refs, and callbacks.

Layers:

| Layer | Kind | Source | Role |
|-------|------|--------|------|
| `Exchange` | Class (façade) | `src/exchange.ts` | Public API: `get`, `destroy`, `suspend`, `resume`, `addTransport`, `removeTransport`, `peers`, `documents`. Owns `Synchronizer`, `Governance`, `Capabilities`, `AnyTransport[]`, and a `Runtime`, which owns the `Store`. |
| `Synchronizer` | Class (shell) | `src/synchronizer.ts` | The network shell. Owns the dispatch queue, the map of registered documents (the Runtime's `DocReadyInfo` records, read-only), the transport adapters, the reactive-collection handles. Runs the session and sync programs, interprets effects. |
| Session program | Pure `Program` | `src/session-program.ts` | Channel topology + peer identity + departure. No document knowledge. |
| Sync program | Pure `Program` | `src/sync-program.ts` | Document convergence + merge-strategy dispatch + ready state. No channel knowledge. |
| `Runtime` | Class (shell) | `src/runtime.ts` | The local shell. Holds each document's instances by generation, the store, the lease and the tick clock. Runs the store and lifecycle programs, interprets effects. |
| Store program | Pure `Program` | `src/store/store-program.ts` | Which write each document owes, and from what base. |
| Lifecycle program | Pure `Program` | `src/lifecycle-program.ts` | Each document's tier, load, registration and generation; every door's request and every load's completion. |

Plus cross-cutting facilities:

| Facility | Source | Role |
|----------|--------|------|
| Governance | `src/governance.ts` | Composable policies (`canShare` / `canAccept` / `canConnect` / `canReset` / `resolve`). |
| Capabilities | `src/capabilities.ts` | Replica-type + schema registry keyed by `ReplicaKey`. |
| Line | `src/line.ts` | Reliable bidirectional message stream built above `exchange.get`. |
| Seats | `src/store/seats.ts`, `src/store/store-open.ts`, `src/runtime.ts`, `src/when-peer.ts` | A store issues its Runtime's seat from a locked, fenced pool, or the Runtime mints a session seat without one; `whenPeer` finds a peer's seat by predicate. |
| Storage | `src/store/*.ts` | `Store` interface, in-memory implementation, shared utilities (`validateAppend`, `resolveMetaFromBatch`); production impls in `@kyneta/leveldb-store`, `@kyneta/indexeddb-store`, `@kyneta/sqlite-store`, `@kyneta/postgres-store`, `@kyneta/prisma-store`. SQL-family stores share pure helpers (`toRow`, `fromRow`, `planAppend`, `planCompact`) via `@kyneta/sql-store-core`. |

### What the exchange is NOT

- **Not a message bus.** Applications do not publish/subscribe to arbitrary topics. The only multicast is the document-sync protocol itself; for application-level messaging, use `Line`.
- **Not pub/sub.** There is no broker, no ordering guarantee across unrelated docs, no multi-party fan-out primitive. One doc's sync is one doc's sync.
- **Not a database.** It persists via the `Store` interface, but it is not a store. It writes what the substrate exports; it reads what the substrate can interpret.
- **Not a transport.** Transports are injected (`transports: [...]`) — the exchange does not open sockets.
- **Not thread-safe across processes.** One `Exchange` instance per process. Tabs and processes each hold their own seat and meet over a shared transport.

### What the Synchronizer is NOT

- **Not a thread synchronizer.** JavaScript is single-threaded. The name reflects *document synchronization*, not concurrency primitives.
- **Not a barrier or lock.** The dispatch queue is a queue, not a mutex. Re-entrant dispatches enqueue rather than recurse.
- **Not a protocol translator.** It runs the sync protocol by interpreting program effects; it does not adapt between protocols.

---

## Four programs, two shells

Source: `src/session-program.ts`, `src/sync-program.ts`, `src/synchronizer.ts`; `src/store/store-program.ts`, `src/lifecycle-program.ts`, `src/runtime.ts`.

Every stateful protocol in the package is a pure value of type `Program<Input, Model, Effect>` from `@kyneta/machine`: its own state and message vocabulary, a pure `update(input, model) → [model, ...effects]` tested as a table, and effects that are data. A shell executes them.

| Program | Source | States | Shell | Run by |
|---|---|---|---|---|
| Session | `src/session-program.ts` | Channel topology, the establish handshake, peer identity, departure. | `Synchronizer` | `createObservableProgram`, behind the outer coordinator |
| Sync | `src/sync-program.ts` | Document convergence: `present`, `interest`, `offer`, `accept`, `dismiss`, `vacant`, per-peer sync state, sync-mode dispatch. | `Synchronizer` | `createObservableProgram`, behind the outer coordinator |
| Store | `src/store/store-program.ts` | Which write each document owes the store, and from what base. | `Runtime` | `createObservableProgram` |
| Lifecycle | `src/lifecycle-program.ts` | Each document's tier, load, registration and generation. | `Runtime` | `Runtime.#step`, synchronously, as a transaction |

The undo program (`src/undo/undo-program.ts`) has the same shape, with its own shell ([Undo stacks](#undo-stacks)).

The Synchronizer holds the session and sync programs on one dispatch queue (below). The Runtime holds the store and lifecycle programs: the lifecycle's `store` effects are store-program inputs, which the Runtime dispatches. The lifecycle program alone is not run on a `@kyneta/machine` runtime, because its doors must return a ref from inside a nested step, which a queued dispatch cannot; see [How a document becomes ready](#how-a-document-becomes-ready).

### Session and sync: one queue

The session program models channels and peers; the sync program models documents. Neither calls the other. Neither imports the other. The *only* coupling is the `sync-event` effect: when the session program needs the sync program to hear about a topology change (peer available, peer unavailable, peer departed), it emits a `sync-event` effect whose payload is a `SyncInput`. The shell drains pending `sync-event` effects into the sync program's pending-input queue in the **same dispatch cycle** — so topology changes and the sync state they imply are always co-applied, not interleaved.

The keys in `SessionModel.channels` are minted by the Synchronizer via `TransportContext.mintChannelId` (a private per-instance counter, reset on `Synchronizer.reset()`). The invariant: **`channelId` is unique across every transport this synchronizer owns**. The transport package's `ChannelDirectory` is a pure tracking structure that accepts the caller-supplied id; it does not mint. Pushing id issuance to the synchronizer is what lets a relay hub or multi-bridge client work — see `jj:plooolsx` for the regression that motivated the move.

### Serialized dispatch

The Synchronizer hosts two `ObservableHandle`s — one per program — and a third dispatcher, the **outer coordinator**, built on `createDispatcher` from `@kyneta/machine`. All inbound inputs (channel events from transports, local doc mutations, wire messages, internal cross-program `sync-event` effects) route through the outer coordinator's single pending queue. The coordinator pops each msg, dispatches it to the appropriate program handle, then dispatches a `tick`. The tick re-enters the queue; if more `route` messages arrived during program processing (or during emit-* subscriber callbacks), they are interleaved in arrival order. The drain runs to quiescence — until the queue is empty.

All three dispatchers (outer, session, sync) share one `Lease`. A subscriber-induced A↔B cascade between session and sync is bounded by `lease.budget`; a runaway cascade raises `BudgetExhaustedError` whose message carries the cascade's entry-point stack, a label-type histogram, and a recent-event tail — see `@kyneta/machine`'s TECHNICAL.md for the projection shapes (`jj:tozwpvuu`).

The outer coordinator coalesces pending ticks: every `route` queues at most one `tick` (held in a closure-scoped `tickPending` flag), since the tick-quiescent handlers are idempotent when their accumulators are empty. This bounds the iteration count of long cascades by ~⅓ and keeps the diagnostic histogram dominated by *route* and *changefeed* entries rather than tick housekeeping. The flag is cleared at the start of tick processing so a subscriber-induced re-entry inside `emit-*` effects can correctly queue a fresh tick.

This serialization is the reason there are no lock primitives anywhere in the package. A user callback fired from an `ensure-doc` effect (or any other) may call `exchange.get(...)`, `doc.title.insert(...)`, or `room.participants.delete(...)` — those calls enqueue inputs rather than recurse, and the outer coordinator's drain-to-quiescence loop catches the re-entry. **Re-entrant paths converge at every layer**: inputs converge via the per-handle pending queues; tick-induced re-entry from subscribers converges via the outer coordinator's loop; the shared `Lease` bounds the whole cascade.

### Quiescence drain

Reactive outputs (peer events, doc events, ready-state changes, state-advanced docs) are accumulated as model state on the two pure programs. A `tick-quiescent` message is self-dispatched by the outer coordinator after a `route` — at most one tick is pending in the outer queue at any time, not one per route (`jj:tozwpvuu`); the dispatched tick's handler drains the accumulated state into `emit-*` effects, which the executor interprets as `emit` calls on the corresponding `ReactiveMap`s and listener sets.

| Effect | Scope | Pattern |
|--------|-------|---------|
| `emit-peer-events` (Session) | `PeerChange` emissions to the peers `ReactiveMap` | model.pendingPeerEvents → effect → executor rebuilds map + emits |
| `emit-ready-state-changes` (Sync) | Docs whose per-peer sync state flipped this cycle | model.pendingPeerSyncDocIds → effect → executor fires `#peerSyncListeners` |
| `emit-state-advanced` (Sync) | Docs whose state advanced (drives persistence) | model.pendingStateAdvancedDocIds → effect → executor fires listeners |
| `emit-doc-events` (Sync) | `DocChange` emissions to the documents `ReactiveMap` | model.pendingDocEvents → effect → executor rebuilds map + emits |
| `#drainOutboundOnce` (shell) | Outbound wire envelopes | Shift-loop — the queue can grow during sends if a transport synchronously receives |

Outbound coalescing remains a shell-only concern (transport routing + channelId selection) and is not modelled as program state. The outer coordinator's `tick` handler flushes `#outboundQueue` after both programs' tick handlers run.

There is no longer a "second world" of accumulator drains outside the algebra — every reactive output is a Mealy effect.

### What the programs are NOT

- **Not aware of each other.** The session and sync programs cannot import each other's types without crossing a layer. The `sync-event` effect's payload is `SyncInput` because that's how its union is declared in `session-program.ts`, but the session program does not call the sync program's `update` function. The lifecycle program names store-program inputs in its `store` effects, and never runs the store program.
- **Not aware of substrates.** No program calls a substrate. The substrate's `exportSince` / `merge` are called by the shell on behalf of the sync program's effects. The lifecycle program carries a `BoundSchema` or a replica factory as a value in a `build` effect, and the Runtime builds.
- **Not asynchronous.** `update` is synchronous and pure. All I/O happens in the shell's effect interpretation.

---

## The sync protocol

Source: `src/sync-program.ts` message handlers. The eight messages from `@kyneta/transport/messages.ts` split into two lifecycle (`establish`, `depart` — session) and six sync (`present`, `interest`, `offer`, `accept`, `dismiss`, `vacant` — sync).

### Sync messages

| Message | Category | Direction | Payload | Semantic |
|---------|----------|-----------|---------|----------|
| `establish` | Lifecycle | Symmetric | `{ identity, features?, protocolVersion? }` | Peer identity exchange on connection. Both peers send. `protocolVersion` drives establish-time compatibility detection (see below). |
| `depart` | Lifecycle | One-way | `{}` | Explicit departure — the receiver skips the grace timer. |
| `present` | Sync | One-way | `{ docs: Array<{ docId, replicaType, syncMode, schemaHash, supportedHashes? }> }` | "I have these documents." Filtered by `canShare`. |
| `interest` | Sync | One-way | `{ docId, version?, reciprocate?, since? }` | "I want this doc. Here's my version." Answered with `offer`, or with `vacant` if `canShare` denies the requester. Receiving one marks the sender `pending` and emits `classify-peer-version`; the sender becomes `synced` only when the shell finds its version not ahead of ours, or when its own `offer` merges. `reciprocate` asks for the symmetric interest and prevents an interest loop; it carries no other meaning. |
| `offer` | Sync | One-way | `{ docId, payload: SubstratePayload, version }` | State transfer, and nothing else. `payload.kind` (`"entirety" | "since"`) is substrate-internal. |
| `accept` | Sync | One-way | `{ docId, version }` | "I now hold your version `version`." Sent once per offer held — our version, after taking it in, reaches the offer's (imported, already held, or taken by a reset) — quoting the offer's `version`. Not sent for a history-free document, a refused offer, a failed import, or an offer that left us short. See §"What each side knows about the other". |
| `dismiss` | Sync | One-way | `{ docId }` | "I am leaving the sync graph for this doc." Dual of `present`. Receiver deletes its per-peer entry; its own replica stays. |
| `vacant` | Sync | Point-to-point | `{ docId }` | "You asked, and I will not serve you this doc." Two producers, both via the shared `vacantReply` builder: `declareVacant` from `onEnsureDoc`'s terminal non-serve branches (we don't have it), and `handleInterest` on a `canShare` denial (we won't share it). Identical on the wire, deliberately — see §"Every path a document can leave by". Consumed by `handleVacant` (sets the peer `vacant`; our replica stays). |

The eight are defined once in `@kyneta/transport`; the wire encoding is defined once in `@kyneta/wire`. This package implements the *semantics*.

### What each side knows about the other

Source: `src/types.ts` → `PeerDocSyncState`, `src/sync-program.ts` → `setPeerDocState`, `handleAccept`, `handleDocImported`, `buildPush`, `handleOffersSent`, `src/synchronizer.ts` → `#acceptIfOwed`, `#senderWillHold`, `leastCommonVersion`.

Per peer and document the sync model keeps a `status`, three versions, and `offerOwed`, an offer emitted to the peer and not yet reported sent:

| Event | `status` | `ourVersionTheyHold` | `ourVersionTheyWillHold` | `theirVersionWeHold` | `offerOwed` |
|---|---|---|---|---|---|
| interest received | `pending` | := its `since ?? version` | cleared | kept | := from its `since ?? version` |
| `accept` received | kept | := its `version` | kept | kept | kept |
| offer held | `synced` | kept | := joined with the offer's `version` | := the offer's `version` | kept |
| offer not held | `pending` | kept | := joined with the offer's `version` | kept | kept |
| offer across a lineage, asking for the whole | `pending` | kept | := joined with the offer's `version` | cleared, so the interest quotes no `since` | kept |
| offer from a lineage ours supersedes | `synced` | kept | cleared | kept | := the whole document |
| a push emitted to it | kept | kept | kept | kept | := from its baseline, unless already owed |
| an offer reported sent | kept | kept | := the version the offer carried | kept | cleared |
| version check finds no gap | `synced` | kept | kept | := the peer's stated version | kept |
| peer's channel returns | kept | cleared | cleared | kept | cleared |
| our document leaves the sync graph | the whole record is forgotten | | | | |

- **`theirVersionWeHold` is quoted back as an interest's `since`.** It is always a version the peer minted, which matters where versions are private: the ephemeral substrate's is an install counter, and a reconnecting peer that quoted its own counter used to be answered with the whole document.
- **`ourVersionTheyHold` is what compaction trims to.** Nothing else tells an offer's sender which of its versions a receiver holds, because a peer that only reads never offers anything back; before `accept`, the record of such a peer stayed at its handshake and `compact` trimmed nothing. An interest's `since` names one of our versions, so it wins over the peer's own `version`.
- **`ourVersionTheyWillHold` is where each push to the peer starts.** It is optimistic: it moves when the shell reports the offer sent (`sync/offers-sent`), not when the peer acknowledges, so it never lags an offer in flight (an earlier per-peer baseline that waited for acknowledgement resent every one) and never falls behind `ourVersionTheyHold`, which is why compaction never trims past a push baseline. It does not move when the push is emitted, because the shell may withhold the offer at the export (see [Store-first](#store-first)); a baseline moved at emission would claim the peer holds what it was never sent, and every later push to it would start past what it holds.
- **`offerOwed` is an offer the shell has not reported sent**, with `since`, where it starts. A push records it only if none is owed, since within a connection a baseline only grows and the earliest starting point covers every later one. When a withheld document may leave again, `sync/doc-publishable` re-emits each owed offer from its `since`. Any offer reported sent clears it: every offer exports our live state from a version the peer holds, so it carries whatever an earlier owed one would have.
- **An interest clears the baseline** until its answer is reported sent, so no push reaches the peer from a version it may not hold; the answer exports our live state, which carries anything a push would. The interest's own version is where the answer starts, not the baseline: a history-free peer's version is its private counter, not one of ours, and a baseline set to it would make every push a whole document. When a peer offers us its version, it holds that version, so its baseline joins it (`#senderWillHold`, computed by the shell from the value the `import-doc-data` effect carries): a push after an import sends its sender only what it lacks, never its own import back. After a reset the baseline is the offered version alone; a history-free document's versions do not join across replicas, so an import leaves it unchanged. A peer whose baseline is unknown, one that has just come back or whose interest has not been answered, is not pushed to; the answer to its interest catches it up.
- **A reconnecting peer's holding is forgotten**, because it may have restarted without its state. Its interest restates it.
- **A document leaving the sync graph forgets every peer's record of it**, however it leaves (`suspend`, `unload`, `destroy`; `forgetPeerStates`). What holds the id next (the same document resumed or loaded again, or a new one created under the id) starts from each peer's interest: a baseline kept from before could start a push from a version the new instance never held, and a `synced` kept would read as settled before any peer had answered it.
- **`leastCommonVersion` counts every peer we push to** (`pending` or `synced`) whose holding is known, filtered by `cohort`. Leaving out a `pending` peer could trim past what it holds.
- **`leastCommonVersion` is met with our own version.** A peer's first interest carries no cursor, so its holding is recorded as its whole version, including its own operations we do not hold yet, and until its `accept` arrives it is concurrent with ours (Yjs, Loro) or ahead of it (plain). Starting the meet from our own version keeps what the peer holds of ours and drops what we lack, so the least common version is always at or below ours, and always a version our replica can place. A meet can only lower it.

**`accept` is decided by the program and sent by the shell.** `handleOffer` puts `accept: boolean` on the `import-doc-data` effect: true unless the document is history-free (`ReplicaFactoryLike.historyFree`, which never compacts) or `canShare` vetoes the peer. The shell sends it as soon as the offer is held, before dispatching the import's outcome. Sending it from `handleDocImported` put it behind whatever the import made this peer send: a `Line` receiver's ack is written by a subscriber during the merge, so the writer heard the ack, pruned and compacted before hearing the `accept`, and trimmed nothing.

**An offer is held when our version reaches it.** After taking an offer in, the shell asks `reaches(ours, offered)` and reports `held` on `sync/doc-imported`. An offer can leave us short: a plain delta that does not continue our log applies nothing; a CRDT holds back ops whose dependencies are missing; and a Yjs delta merges cleanly while its sender held a third peer's op we lack. An offer not held is not accepted, its sender stays `pending`, and the program sends it an interest quoting our version and `theirVersionWeHold`; its answer is the catch-up. A delta that crosses a lineage boundary toward a lineage that supersedes ours is reported not held too, but its interest quotes no cursor, so the sender answers with its whole document (see [Compaction and lineage boundaries](#compaction-and-lineage-boundaries)). A history-free document's offer is held once merged, since its versions do not compare across replicas.

**Taking in an offer is a plan and an executor.** `#executeImportDocData` gathers the facts — the version comparison (`#classifyPeer`), the reset trigger (`classifyResetTrigger`), and, for a reset, the `canReset` policy — and `planImport` (pure) names one action: `unreadable`, `already-held`, `refused`, `outrank`, `ask-whole`, `reset` or `merge`. The executor performs it, `reportImport` (pure) derives `changed` and `held` from the versions around it, and `crossingOf` (pure) names the lineage boundary crossed, if any. `#took` is the one exit of every offer with a gap, except a refused compaction reset: it sends the owed `accept` only when held, then dispatches `sync/doc-imported`, which carries the crossing. `import-plan.test.ts` tables both decisions.

### Establish-time protocol-version compatibility

`establish` carries a required `protocolVersion` (`{ major, minor }`, from `@kyneta/transport`) — sparse on the wire (absent `pv` ⇒ `BASELINE_PROTOCOL_VERSION = (1, 0)`, defaulted at the inbound transform, and never the current revision: otherwise every older peer that omits the field would be read as current). The session program records the peer's value on `ChannelEntry.peerProtocolVersion` (optional — unknown until the remote `establish` arrives) and, at `completeEstablish`, runs `detectProtocolVersionDiagnostic` alongside `detectPeerIdentityWarning`. The pure classifier `classifyProtocolSkew` (`src/protocol-version.ts`) is the comparison core:

- differing `major` → `"major-mismatch"` → `diagnostic` effect with `code: "protocol-mismatch"`, `severity: "error"`.
- same major, differing `minor` → `"minor-skew"` → `diagnostic` with `code: "protocol-skew"`, `severity: "warning"` (backward-compatible refinement; informational only).
- equal / absent → silent.

**Warn/error-only — it never gates.** The peer's `syncEffect` is emitted unchanged, so an incompatible peer remains observable and enters the sync graph (data simply will not converge). This deliberately avoids inventing a "visible-but-inert" peer state — the per-doc schema-hash mismatch path (`sync-program.ts`) already establishes the precedent of *skipping work*, never withholding the peer, so the frozen `SyncRef`/`peerStates` surface is untouched. `PROTOCOL_VERSION` is `(2, 0)`, the first real major: 2.0 added `accept` and removed `offer.reciprocate`, so a 1.x peer neither acknowledges what it applies nor understands being told. Such a peer gets the error diagnostic and still enters the sync graph; refusing to sync with it remains a separate decision.

Both programs emit one unified `diagnostic` effect carrying a structured `Diagnostic` (`src/types.ts`) — a discriminated union keyed on `code` (`self-connection`, `protocol-skew`, `protocol-mismatch`, `replica-type-mismatch`, `schema-hash-mismatch`, `sync-mode-mismatch`, `lineage-collision`, `unloaded-doc-reloaded`) with `severity`, `message`, `peer`, and — per variant — `local`/`remote` and `docId`. **No optionals:** each cause carries exactly its fields, and deferred causes (`store-error`, `wire-reassembly`) become new variants, never new optionals on the existing ones. The shell maps `severity` to `console.error`/`console.warn` for both programs. `code` is the programmatic `kind` the planned structured `onProtocolWarning` callback (jj:wkwskqsy) would expose. This folds in the former `SyncEffect` `{ type: "warning" }` (schema-hash / replica-type / syncMode mismatches), now `severity: "error"` since they prevent convergence. Context: jj:nztkqwpm.

### Sync-mode dispatch

Each `BoundSchema` carries a `SyncMode` — a structured record with two orthogonal axes. The sync program dispatches on individual fields, not a monolithic enum:

| Constant | `writerModel` | `durability` | `requiresBidirectionalSync` | Use case |
|----------|---------------|--------------|-----------------------------|----------|
| `SYNC_COLLABORATIVE` | `concurrent` | `persistent` | `true` | Loro / Yjs CRDTs |
| `SYNC_AUTHORITATIVE` | `serialized` | `persistent` | `false` | Plain JSON, single-writer |
| `SYNC_EPHEMERAL` | `concurrent` | `transient` | `true` | Presence, cursors, typing |

`requiresBidirectionalSync` is `writerModel === "concurrent"`: two peers that both write have to hear each other, whatever they are storing. Authoritative is request/response, not exchange.

**There was a third axis, `delivery`.** It separated substrates that could compute a delta from those that could only send a snapshot, and only `SYNC_EPHEMERAL` was ever `"snapshot-only"`. Once the ephemeral substrate gained `exportSince` the axis had one value and discriminated nothing, so it is gone. The two sites that branched on it wanted `durability`, which is what they had been reaching for through it: `syncModeToWire` and `syncModeName` now test `durability === "transient"` directly.

Deleting it is not cosmetic. `syncModeToWire` tested `delivery` **before** falling through to `Ephemeral`, so flipping the axis without removing it would have announced ephemeral documents as `Collaborative`; the peer decodes that as `SYNC_COLLABORATIVE` with `durability: "persistent"`, `mismatchOnSharedAxes` refuses it, and ephemeral sync stops with an error naming the wrong thing. The round-trip test in `cbor.test.ts` is the guard — it fails first and by name.

All modes use interest-based routing: a push goes only to peers who have expressed interest, filtered by `canShare`.

The sync mode is a property of the document, not of the exchange: one exchange hosts documents of all three modes at once, dispatching per document on the axes above.

**Only these three modes are network-expressible.** The wire carries a single 3-valued enum: `syncModeToWire` (`wire/src/wire-types.ts`) collapses any `writerModel: "serialized"` to `Authoritative`, any remaining `durability: "transient"` to `Ephemeral`, and everything else to `Collaborative`; the decode side maps that enum straight back to one of the three constants above. With two axes of two values there are four combinations and three names, so a custom mode built with `createBindingTarget` — `{serialized, transient}` — **cannot survive a round trip**: it is announced as `Authoritative` and arrives as `SYNC_AUTHORITATIVE`, persistent.

Two consequences worth knowing:

- `replicaKey`'s 3-way collapse in `Capabilities` is not a lossy shortcut. It is exactly as granular as the wire, and `resolveSchema` — whose only caller is `onEnsureDoc`, i.e. always a wire-decoded mode — can never be handed a fourth possibility. (It verifies the full triple anyway, so the guarantee lives in the function rather than three layers away in the codec.)
- Custom `SyncMode`s are usable **locally** — a standalone `Runtime`, a single-process test — but two peers cannot agree on one. Anyone extending the mode space has to extend the wire enum with it.

### Document classification on `present`

Source: `src/sync-program.ts` → `handlePresent`, `src/exchange.ts` → the `onEnsureDoc` hook.

When a peer announces an unknown doc, four checks run in order:

1. **`canShare` governance check.** `canShare(docId, peer)` → `false` silently drops the `present` for that document. `resolve` never fires, so no replica is created. (`canAccept` is not consulted here; it gates the inbound *offer*, one step later. Gating replica creation on the outbound predicate is the existing convention — a document we would not share with this peer is one we have no reason to create on its word.)
2. **Schema-hash auto-resolve via `Capabilities`.** If `(schemaHash, replicaType, syncMode)` matches a registered `BoundSchema`, the triple auto-classifies as `Interpret(bound)`. `resolve` never fires.
3. **`resolve` callback.** The application's `resolve(peer, docMeta)` runs. It returns one of the four dispositions.
4. **Two-tiered default (no `resolve` callback).** If `replicaType` is supported (present in `Capabilities` as a replica-only entry), default is `Defer()`. Otherwise `Reject()`.

For *known* docs (already registered), all three metadata fields — `replicaType`, `syncMode`, `schemaHash` — are validated against the local entry via `mismatchForSync` from `@kyneta/schema`. Any mismatch skips sync, surfacing a structured `diagnostic` (`code: "replica-type-mismatch" | "schema-hash-mismatch" | "sync-mode-mismatch"`, `severity: "error"`, carrying `peer`/`docId`/`local`/`remote`) logged via `console.error`. The axis→code translation is the layer boundary: `@kyneta/schema` names the axes, the exchange names the diagnostics.

**A known document this peer has unloaded** (`DocEntry.mode: "unloaded"`) keeps its metadata, so a peer's `present` is checked against it like any other. After the check, a `present` or an `interest` for it loads it again only where this peer serves the documents it holds: the sync program's `servesUnloaded()`, which the Exchange answers with `Policy.authority === "self"`. The first such request marks the entry `reloading`, emits `reload-doc` (the Exchange steps the Runtime's `reload`, an `open` from the document's own spec) and an `unloaded-doc-reloaded` diagnostic (`severity: "warning"`, naming the peer); every later one does nothing. The request is not answered then: once loaded, the document announces itself and sends its own interest, and the peer's interest follows. A suspended unloaded document answers no peer, and neither does any unloaded document on a peer that does not serve, which is what keeps a client's closed cards closed: every reconnect brings a host's `present` for each.

`supportedHashes` admits heterogeneous-schema sync: two peers with different migrated schema versions can sync if their `supportedHashes` sets overlap. Note that this — *intersection*, symmetric — is the sync question. Deciding whether a *local schema can interpret a given document* is a different, directional question (`mismatchForInterpretation`, membership), and the two are deliberately separate functions. See §"The two laws over `supportedHashes`" in `packages/schema/TECHNICAL.md`.

**Every site that asks the interpretation question now asks it the same way**, and that invariant is worth stating because the bug it rules out is invisible from any single call site. `resolveSchema` (on `present`) and `registerSchema`'s deferred sweep (when a schema is registered later) are two entries to one question. They used to disagree — `resolveSchema` matched through `supportedHashes`, the sweep compared hashes for equality — so whether a deferred document was ever promoted depended on *when* its schema was registered. Register before the peer's `present` and the document was interpreted; register after and it stayed deferred permanently, because the sweep is the only thing besides a door naming the document that ever re-examines a deferred one, and it had already run.

---

## `Line` — the CQRS bidirectional stream

Source: `src/line.ts`.

The `Line` class provides a reliable bidirectional message stream between two Exchange peers. It is implemented over two `json.bind()` authoritative documents (one outbox, one inbox) with sequence numbers and ack-based pruning.

### The Capability Model

Bidirectional streams in component-based UI frameworks (like React) follow a Command Query Responsibility Segregation (CQRS) pattern:
- **Sending (Command):** Highly distributed. Any button, form, or component might need to send a message.
- **Receiving (Query/Event):** Highly centralized. Incoming messages are usually routed to a central store, a reducer, or a global state manager.

`LineProtocol` exposes three capabilities:

- **`sender(exchange, peer)`** → `LineSender<SendMsg>` — the **shared write** capability. Reference-counted: multiple calls for the same `(topic, peerId)` return the same underlying `Line` instance. Any component can obtain a sender and call `send(msg)`. The Line safely multiplexes writes into the shared outbox document.
- **`claimReceiver(exchange, peer)`** → `LineReceiver<RecvMsg>` — the **exclusive read** capability. `LineReceiver` extends `AsyncIterable`, so you iterate with `for await (const msg of receiver)`. Only one iterator may be active at a time — calling `[Symbol.asyncIterator]()` a second time throws (`"Line is already being iterated"`). This structurally guarantees that messages aren't accidentally load-balanced (stolen) across two components that both try to iterate the line.
- **`manager(exchange, peer)`** → `LineManager` — permanent destruction via `destroy()`.

### Lifecycle

Each capability handle's `close()` decrements the reference count. The underlying documents and policies are only torn down when the count reaches 0. `manager.destroy()` forces the count to 0 and performs permanent teardown.

### Writer restarts and lineage

`Line`'s outbox/inbox documents are ordinary `json.bind()` (`SYNC_AUTHORITATIVE`) docs, so they're backed by `PlainVersion` — which carries an `lineage` (see `@kyneta/schema`'s [`PlainVersion`](../schema/TECHNICAL.md#plainversion); `lineage` is a universal `Version` property, not Plain-specific). An outbox gets a fresh lineage when its side of the `Line` is destroyed and reopened, restarting at `seq` 1. A process restart does not do it. A stored process returns with its seat and resumes its outbox from the store; a store-less one is a new seat and writes a new outbox.

**A `Line` resumes only once its documents have loaded.** Its cursors (`nextSeq`, `ackSeq`, `ackLineage`) live in its stored documents, so a `Line` opened on a stored Exchange reads them after `whenHydrated` of both. Read earlier, they would be an empty document's, and every stored message would be delivered again. A message sent before then is appended once they have loaded. `Line` reads the lineage via the substrate-agnostic `version(doc).lineage` — no knowledge of `PlainVersion` or any concrete substrate, and no `as any` casts.

`Line`'s own envelope schema carries its sequence cursor paired with the lineage it was computed against: `ackSeq: number` + `ackLineage: string` (replacing the bare `ack: number`, and renamed from `ackIncarnation`). This is necessary because `Line`'s hand-rolled `seq`/`ack` counters are well-ordered *only within one lineage* of the doc they're stamped on — exactly the same category error `PlainVersion` itself avoids by carrying lineage alongside value. Both comparison sites that trusted a bare counter — `#processInbox`'s dedup guard (`msg.seq <= #lastProcessedSeq`) and `#pruneOutbox`'s prune guard (`msg.seq <= remoteAck`) — detect a peer-lineage mismatch and reset safely: the receiver's `#lastProcessedSeq` resets to `0` when the inbox's lineage changes (a fresh lineage has no history to have "already processed"), and the sender's `#pruneOutbox` refuses to prune anything unless `ackLineage` matches its own outbox's current lineage (an ack from before the sender's own restart cannot certify anything about messages minted after it). The `""` structural default for `ackLineage` is the "never acked" sentinel — real lineages are always non-empty. This fix is entirely contained within `Line` and `packages/exchange/src/line.ts`; the sync layer above needs no changes.

**Future direction (considered and deferred):** retiring `seq`/`ack` entirely in favor of substrate-level `PlainVersion`/`advance()`/`exportSince` comparisons was considered and rejected for two concrete reasons — (1) stamping a message with "the version this write will produce" requires predicting the substrate's flush-counting behavior before the write that produces it (chicken-and-egg, or else doubles write cost per `send()`); (2) the outbox document's version stream interleaves two unrelated kinds of writes (sending a message, acknowledging the peer's messages via the piggyback), so a flush count no longer corresponds 1:1 to a message count once ack-writes share the same document. A legitimate unification would require splitting the consumption-cursor write onto its own document with a version stream that only advances on message-pushes — a materially bigger reshape than this bug warranted.

---

## `exchange.get` — phase in, action out

Source: `src/interpret.ts` → `planInterpretation`; `src/lifecycle-program.ts` → the `get` row; `src/exchange.ts` → `Exchange.get`, `#getImpl`.

```
exchange.get<S>(docId: DocId, bound: BoundSchema<S>): Ref<S>
```

Two questions decide the outcome, and keeping them apart is what makes the
behaviour predictable. **Phase** determines *what* `get()` does. **Reconcilability**
determines *whether* it does anything at all. Suspension participates in neither.

| Phase | Effect |
|-------|--------|
| absent | Create the document, register with `Store[]`, broadcast `present`, return a fresh `Ref<S>`. |
| interpret | Return the existing `Ref<S>`. No substrate reconstruction. |
| deferred | Promote to interpret; send `interest` to the peer that presented; run sync. |
| replicate | Promote to interpret over the *same* accumulated state — see below. |
| unloaded | Load it again from `Store[]` under the caller's schema, suspended if it was, and return a new `Ref<S>`. |

A document still unloading answers by its stage: before the store holds everything, `get()` cancels the unload and answers as for its tier; after, as for `unloaded` ([Suspend, unload, destroy](#suspend-unload-destroy)).

Reconcilability is `mismatchForInterpretation` (`@kyneta/schema`) over the three
axes a document is identified by: `replicaType`, `syncMode`, `schemaHash`. Every
phase that holds a document is checked against it, including `interpret` — being
already open is not an exemption. For a document no peer has announced, the
document's own metadata is the `BoundSchema` it was created with, which carries
those same three fields; for an unloaded one, the metadata recorded when it was
held, refused on all three. A
disagreement on the first two is refused outright — they decide whether bytes
can be exchanged at all, and no local intent makes an undecodable format
decodable. A `schemaHash` disagreement on a *deferred* document is the one
exception: `get()` promotes anyway and warns. That is defensive, not permissive
— a deferred document arrived from a peer, so refusing would let any peer break
a local `get()` by announcing a colliding `docId`. It is written at `#getImpl`
rather than in the classifier, because it is the only door that holds it.

**The Runtime answers every door.** `get`, `open`, `onEnsureDoc` and
`registerSchema`'s sweep each step one `get` request through the lifecycle
program, whose `get` row asks `planInterpretation` with the phase, the metadata
the Runtime recorded for the document, and where its load stands ([How a
document becomes ready](#how-a-document-becomes-ready)). The Exchange's
`#getImpl` keeps only the deferred policy above, checked against the metadata
the synchronizer holds, which the Runtime does not; every other refusal, and
its message (`refusalError`), is the Runtime's. `get` and `open` throw a
refusal; `onEnsureDoc` and the sweep skip it.

**Totality is over *phase*.** `get()` never refuses a document for being
deferred, interpreted, suspended, unloading or unloaded. It still throws for an incoherent
*request* — a schema that cannot read what is there — and that is about the
arguments, not the document's state.

Note what that does *not* include: which `BoundSchema` object the caller held.
Two `bind()` calls over one schema are interchangeable, and a schema whose
migration chain reaches the document's shape can read it. Both are accepted.

### `exchange.open` — `get`, never creating

Source: `src/exchange.ts` → `open`, `#openImpl`, `#getImpl`; `src/lifecycle-program.ts` → `Intent`, the `get` row, `finishLoad`.

```
exchange.open<S>(docId: DocId, bound: BoundSchema<S>): Promise<Ref<S> | undefined>
```

`get` answers "give me this document" and may create it. `open` answers "give me this document if it is here": open, replicated, or in the Store. It never creates, writes or announces one, and resolves `undefined` instead. An undo stack opens the documents its steps name this way, so an undo never brings a destroyed document back.

**It is `get` with another intent, through the same load**, not a Store read followed by a `get`. `#getImpl` steps a `get` request with the intent's kind; the loading document records an `Intent` (`create`, or `open` with `replaced`); `finishLoad` decides from what the load found (see [How a document becomes ready](#how-a-document-becomes-ready)). An `open` whose load finds nothing is closed in the step that records it, before anything registers, writes or announces it. An `open` that can load nothing at all (no store, or a transient document) builds nothing, and resolves `undefined` at once. There is no gap between a check and a `get` for a destroy to fall into: a destroy while `open` loads closes the document like any destroy, and the `open` rejects with its `DocumentClosedError`.

- **A destroyed document is not held**, including while its delete is in flight: the Runtime orders a load after the delete ([One document's store calls, in order](#one-documents-store-calls-in-order)).
- **A deferred document** opens if the Store holds it. Otherwise it stays deferred: the deferred entry holds nothing, so `intent.replaced` alone puts it back, in the same step as the close.
- **A `get` while an `open` loads** makes the intent `create`: the `get` caller holds that ref.
- **A failed read rejects**; it is not an absent document. A schema that cannot read the document throws, as with `get`.
- **While `open` loads**, the Runtime holds the document like any loading one (`exchange.has` is true), but it is not in `exchange.documents`, which it joins only when ready.

### Promoting a replicate document

A `replicate` document is a bare `Replica` — it accumulates state, computes
per-peer deltas and relays bytes, but has no schema, no substrate and no ref.
The one thing it lacks is exactly what `get(docId, bound)` supplies, so the
call is not a request for something the peer cannot do; it is the peer being
handed the missing piece.

`SubstrateFactory.upgrade(replica, schema)` performs it, wrapping the *same*
backing document. Accumulated state carries across rather than being rebuilt —
a promotion that produced a fresh empty substrate would be indistinguishable
from success by any structural check, which is why the tests assert on content.
History carries across too, and so does the version: the promoted document
publishes the version the replica held. For plain, whose replica *is* an op
log, `upgrade` hands that log to the substrate; a promotion that restarted it
would publish a regressed version and could no longer serve deltas.

Three preconditions, and together they are the whole contract:

1. **The caller supplies a schema.** Promotion never happens without one.
2. **The schema is compatible on all three counts** — `replicaType`, `syncMode`,
   `schemaHash`, via `mismatchForInterpretation`. Note the deferred-document
   exception below does *not* apply here.
3. **The document has finished loading.** `upgrade()` claims this peer's stable
   identity on the backing document, and a CRDT addressing operations by
   `(peer, counter)` silently drops one of a colliding pair. Claiming while the
   document's own history is still arriving is that collision. A caller that
   gets `Document '…' is still loading` should `await exchange.whenHydrated(docId)`
   — the docId-keyed accessor exists because a replicate document has no ref
   for the ref-keyed `whenHydrated` to take. A replica whose load *failed* never
   finishes arriving, so `get` throws the load's error instead.

**The cost is that promotion is one-way.** There is no `demote()`, so a peer
that promotes a document it was only relaying keeps the full substrate for the
rest of the process. That is why it happens only where a caller named both a
`docId` and a `BoundSchema`. The one way back is `unload`, for a stored
document: it leaves memory altogether, and a `replicate` loads it again as a
replica.

**No blanket path promotes, and that asymmetry is the safety property.**
`registerSchema`'s deferred sweep and the `onEnsureDoc` network route both
raise documents to interpret without any caller naming one. Neither may promote
a replicate document: registering a single schema would otherwise convert every
matching replicate document at once, and a relay that registered a schema to
read *one* document would acquire full substrates for all of them, irreversibly.
The sweep's own comment refuses to widen for this reason. A named `docId` plus a
`BoundSchema` is a deliberate act; a sweep is not.

Otherwise the return is always a `Ref<S>` — a typed, callable, navigable,
observable, writable reference from the interpreter stack. Application code
reads `doc.title()`, writes `batch(doc, d => d.title("new"))`, subscribes
`subscribe(doc, changeset => …)`. Everything downstream of `get` is identical
regardless of which case fired.

**This table describes `Exchange.get()`.** `Runtime.get()` is the same step
without the Exchange's deferred policy: a standalone Runtime holds a deferred
document only if something called `defer`, since deferral is a sync-graph
concept, and promotes it whatever the announcement said.

### Suspend, unload, destroy

| Intention | API | Behaviour |
|-----------|-----|-----------|
| Leave sync graph, keep local state | `exchange.suspend(docId)` | Sends `dismiss`. **Stays in `exchange.documents`**, as `{ mode: "interpret", suspended: true }`. State remains in memory and in `Store`. `exchange.get(docId)` still returns the ref — **without** resuming. |
| Leave memory, keep the stored document | `exchange.unload(docId)` | Once the store holds all of it: closes the document, sends `dismiss`, and releases its native document. **Stays in `exchange.documents`**, as `{ mode: "unloaded", suspended }`. `get` or `open` loads it again from `Store`, in the tier it had, suspended if it was. |
| Permanent removal | `exchange.destroy(docId)` | Sends `dismiss`. Closes the document and releases its native document. Removes from `exchange.documents`, from `Store`, from all peers' views. Fresh `get` constructs a new doc, even while the delete is in flight; `open` resolves `undefined`. |

"I'm done with this doc" has three flavours: intent to resume (`suspend`), intent to open again later (`unload`), and intent to erase (`destroy`). They differ in what leaves memory, the `Store` and the exchange's document map.

**A destroyed document is closed and disposed** (the lifecycle's `close` and `dispose` effects, `Runtime.#close` and `#dispose`, in order): its wiring is undone; its terms close ([Closing never invents an answer](#closing-never-invents-an-answer)); the observers of its load are told; then its replica is disposed, which releases the native document (`ReplicaLike.dispose`, `@kyneta/schema` TECHNICAL.md §Release), and the instance goes. `reset()` and `shutdown()` close every document the same way, with reason `"disposed"` rather than `"destroyed"`. A ref the application still holds afterwards:

- reads its last value: σ is not released;
- throws `DocumentClosedError` on an authored write, on `unwrap`/`[NATIVE]`, on the sync functions (`version`, `exportEntirety`, `exportSince`, `merge`), and on a position, devtools history or undo record made before the close;
- reports the `DocumentClosedError` through `writeRefusal`, and `writeRefusalFeed` subscribers hear the close;
- keeps reachable only σ, its trie and subscribers, and its closed terms: not the native document, the Runtime or the Exchange. Once the application lets go of its refs, the document is collected.

**An unload has three moments**, and each ends one thing:

1. **`unload`** ends the ref's writes. The lifecycle commits `unloading` (stage `storing`), and the owner's refusal is derived from that phase (`unloadingOf`), so an authored write throws `DocumentClosedError` (reason `"unloaded"`) from then on. Then, in order: `drain` commits what the native document holds uncommitted and requests persistence and a push for it; `leaving` puts the sync entry in its leaving state (`sync/doc-unloading`), in which it still sends (pushes, owed offers, answers to interests) and takes nothing in (no import, no `accept`, no interest on a `present`, a reciprocal interest or a reset); `state-advanced` requests a write; and `release` asks the store program to report when it holds everything.
2. **`released`** ends the ref. The store program emits it once the document's phase is `storedEntirely` (see [The store-program](#the-store-program)), after the `persisted` of the same write, so store-first's own path has already sent the offers held back for the last writes ([Store-first](#store-first)). The lifecycle closes the instance (its terms keep the answers they had, readiness and peer states included) and then leaves the sync graph (`leave` → `onDocUnload` → `leaveDocument(docId, "unload", left)`), which sends `dismiss` and clears the readiness latch.
3. **`left`** ends the memory. The Synchronizer lets go of the record once everything queued before the leave has read it, and calls `left`; the lifecycle disposes the replica and records `unloaded`, with the `BuildSpec` that loads it again (`from: "hydration"` for an interpreted document) and `suspended`.

A document that was never registered (a standalone Runtime) has no sync graph to leave: `released` closes, disposes and records `unloaded` at once.

**Why the write before the release.** Changes merged from peers reach the store program only at the Synchronizer's next quiet point (`emit-state-advanced`), so a release from `idle` could fire before them, and the stored document would miss what this replica took in. The `state-advanced` the unload requests is a write that reads the replica when it starts. A write always completes after the current synchronous cascade, so every merge queued before `leaving` is in the replica by then, and the release waits for that write. A write with nothing new touches no store.

**Why the document leaves only once the store holds everything.** Leaving drops what is owed: `handleDocPublishable` returns nothing for a document the sync model no longer holds. Store-first holds back every offer carrying an own write until the store confirms it, and the confirmation (`persisted` → `#confirmed` → `onDocPublishable` → `sync/doc-publishable`) precedes `released` in the store program's transition. The Synchronizer processes its input first in, first out, so even when it is busy and the leave is queued, the owed offers are queued ahead of it. A peer therefore receives every write made before `unload` without the unloading peer opening the document again. Leaving any earlier (dismissing at `unload`) would strand those writes; staying fully in the sync graph until `released` would let merges keep joining the store queue, so a document peers keep writing might never be released. A leaving document takes nothing in, so its store queue only shrinks.

**A document never leaves memory while the store could lose it.** Only an `idle` phase without failures is `storedEntirely`: `unwritten` holds nothing confirmed, a phase with failures has a retry scheduled, and after `seat-lost` nothing more can be stored. A document whose writes keep failing stays in memory, unloading, and `flush()` resolves without waiting for it.

**Two windows for a door.**

- **Before `released`** (stage `storing`): `get` or `open` cancels the unload and is answered as for a ready document, returning the same ref. The store program keeps tracking it (`keep`), the leaving state is cleared, which asks every peer again for what was ignored meanwhile, and the derived refusal lifts with the phase. A cancelled unload registers the way a load does, so one begun before an Exchange set hooks is registered then. A promotion of an unloading replica is a cancel followed by the promotion, in one step. `suspend` and `resume` refuse `unloading`, so the flag a cancel restores is the flag the unload began with; `replicate` refuses `already-held`, since a refusal commits nothing and could not also cancel.
- **After `released`** (stage `leaving`, and `unloaded`): the store holds everything, so a door loads a new instance from it, under a new generation. The departing instance, already closed, is disposed at its own `left` (`LifecycleModel.departing`). Its leave was queued before the new load began, and a load completes asynchronously, so its `doc-left` runs before the new instance registers.

**A release is an offer.** A door called from a `persisted` listener can cancel the unload in the very store transition that emitted `released`, its `keep` queued behind it. The lifecycle then finds the document `ready` and hands the release back with `store { type: "hydrated", version }`, so the store program tracks it again from the version it holds, and any write since is owed from there. Ignoring it would leave the document untracked, and every later write unstored.

**`planLeave`, one way to leave the sync graph.** `suspend`, `unload` and `destroy` are one input, `sync/doc-leave { docId, as, metadata? }`, and one pure function decides it from `as` and the document's sync mode (`"absent"` for a suspended document, which has no entry):

| `as` | sync entry | `dismiss` | readiness latch | event |
|---|---|---|---|---|
| `suspend` | deleted | unless absent or unloaded | kept, for `resume` | `doc-suspended` |
| `unload` | `unloaded`, with the document's metadata and `suspended` | unless absent or unloaded | cleared | `doc-unloaded` |
| `destroy` | deleted | unless absent or unloaded | cleared | `doc-removed` |

Its effects are `dismiss` (when it applies), then `doc-left`, at which the Synchronizer lets go of the record it captured at `leaveDocument` (unless suspending), only if it is still the same object: a record a later registration put under the id stays. Every leave forgets the per-peer state ([What each side knows about the other](#what-each-side-knows-about-the-other)). Clearing the latch on unload is what makes the next load start unsettled, settled only once a peer answers it; a ref held across the unload keeps the readiness it had because its instance closed at `released`, before the leave. A leave for a document neither the sync model nor the Synchronizer knows records no event.

**An unloaded document** is a phase of its own, not a deferred one: it is never announced, `registerSchema`'s sweep (over deferred documents only) never promotes it, and its metadata is our own record, so a `get` whose schema cannot read it refuses on every axis (`planInterpretation`'s `unloaded` arm), without the deferred exception. `destroy` deletes it from the store. A peer's request loads it again only where this peer serves ([Document classification on `present`](#document-classification-on-present)). An `open` or a reload that finds it deleted from the store (another seat destroyed it) removes it everywhere: the load's intent recorded `replaced: "unloaded"`, so the not-held rule removes the entry and emits `notify destroyed`, whose leave as `destroy` removes the `unloaded` sync entry.

### What `suspend` is NOT

- **Not a disconnect.** Other docs in the same exchange continue syncing.
- **Not destructive.** Local state is preserved — `suspend` sets a flag and sends `dismiss`; the ref and substrate are untouched. `get(docId)` therefore keeps working and returns the same ref, but it does **not** un-suspend: only `resume` re-enters the sync graph. That separation is deliberate, so an unrelated read can never restart traffic peers observe: **`get()` never takes a suspended document into the sync graph.** That includes a `get` that promotes a suspended replica, or loads a suspended document that was unloaded: a suspended instance registers without being announced (`register` carries `suspended`, and `handleDocEnsure` records the event and keeps no sync entry).
- **Not a removal.** The document stays in `exchange.documents` with `suspended: true` — which is what that field is for, and what makes `doc-suspended` / `doc-resumed` meaningful events. `destroy` is what takes a document out of the map. Reading the suspend row as "it left the exchange" is the mistake to avoid: `@kyneta/index` once filtered suspended documents out of exchange-backed sources on that belief, which made pausing sync delete rows from every derived view.
- **Not a memory release.** That is `unload`, which a suspended document can also do: it then leaves no sync entry to dismiss, and loads again suspended.
- **Not a way around `destroy`.** Suspending a destroyed doc throws, since it does not exist; destroying a suspended doc completes the destruction.

---

## Seats and principals

Source: `src/runtime.ts` → `Runtime.seat`, `Runtime.peerId`; `src/store/seats.ts`, `src/store/store-open.ts`; `src/exchange.ts` → `ExchangeParams.principal`, `validatePrincipal`; `src/when-peer.ts`.

A peer's identity does two jobs, and each has its own field.

| Field | Job | Chosen by |
|-------|-----|-----------|
| `peerId`, the **seat** | The address of one replica. It keys the session and sync peer tables and the transports' connection maps, and the Yjs and Loro bindings hash it into the CRDT peer number, so it decides which addresses the replica's operations occupy. | The store, which issues `Store.seat` when it opens. Without a store, the Runtime: `randomPeerId()`, 128 bits, fresh per Runtime. Never the caller. |
| `principal` | Who the peer says it is: a user, a service, a server fleet. Policies key on it. Several seats may share one. Carried in `establish`; not verified. | The application: `new Exchange({ principal })`. |

The seat carries an invariant a CRDT depends on:

> A replica may issue operations under identity `c` only if (1) it is the only live writer holding `c`, and (2) its state contains every operation ever issued under `c` for that document.

When the caller chose the peer id, callers broke it in ordinary use. A store-less page that reloaded kept its id but not its documents, so it wrote at addresses its earlier session had already used; a duplicated tab copied the id through `sessionStorage`, so two live pages wrote under one. Either way the replicas reached equal version vectors over different contents, and never synced again. A caller cannot check the invariant, so the caller never chooses.

A Runtime without a store issues itself a **session seat**, a fresh random id that no one has written under. A fresh id has no history, so it satisfies both halves with no coordination. The cost is one version-vector entry per writing session per CRDT document, and a new peer in every peer list. That is the lower bound for state that dies with the process: a replica that writes before it can prove (2) for an existing id must write under a fresh one.

A Runtime with a store takes its seat from the store: `this.seat = store?.seat ?? sessionSeat()`. The store holds the state that proves (2), so its seat can outlive the process. See [Durable seats](#durable-seats).

Which one to read:

- **Who** (governance, authority, display): `principal`. `p => p.principal === "my-server"`.
- **Which replica** (`exchange.peers` keys, `sync(doc).peerStates`, a `Line`'s remote): `peerId`. A stored peer keeps its seat across restarts over the same storage; a store-less one does not, and several processes over one store hold different seats. To find one by principal, use `whenPeer(exchange, p => p.principal === "server")`, which resolves with the first matching peer in `exchange.peers`, including one in its grace period.

Two live peers never share a seat, so a second channel for a connected seat is one peer connected over several transports (or a reconnect overlapping its predecessor's dead connection), which the session model supports. `self-connection` remains: a remote peer presenting this exchange's own seat means a transport looped back to its own Exchange. One Runtime cannot back two Exchanges either: `Runtime.setHooks` refuses a second owner, before the second Exchange starts any transport.

### Durable seats

A **durable seat** is an identity together with the lifetime of the storage that proves it. Each half of the invariant has its own mechanism:

- **(2) holds by store-first.** An own operation leaves the process only once the store has confirmed it ([Store-first](#store-first)). So a Runtime that hydrates a document from the storage and then claims the seat (`beginHydration` → `adopt()`, the load's `adopt` effect) holds every operation ever issued under it. **Reuse is sound only because of store-first**: without it, a crashed writer's unconfirmed operation could be on a peer but not in the storage, and the next holder would reissue its address.
- **(1) needs exclusivity per storage.** Several writers can open one storage at once: tabs, server processes, Runtimes over one `sharedData`. So the storage keeps a **pool** of seats in its store-wide metadata (`store_meta`, key `seats`, beside the format marker), and each open store holds one seat exclusively for its lifetime. Deleting the database deletes the ids that vouched for its history; a pool kept anywhere else (such as `localStorage`) would vouch for history held in a different place.

**The seat model.** Ids are seats, and holding a seat's lock is sitting in it. The pool is every seat the storage has issued. A writer sits in the oldest free seat, and adds a seat only when all are taken. Nobody can sit in an occupied seat, and the platform clears a seat when its holder dies. Which writer sat there last does not matter: reuse is safe for any writer that hydrates first. A single-tab user keeps one seat across reloads, and the pool never exceeds the peak number of writers open at once (a reload that overlaps its predecessor counts twice).

**Three kinds of seat.** How a storage makes a seat exclusive decides what it needs:

| kind | stores | exclusivity | fence |
|---|---|---|---|
| `session` | Prisma, and IndexedDB without Web Locks | a fresh id per open | none: a fresh id has no history |
| `owned` | SQLite, LevelDB | a file lock held by the connection that writes | none: a write cannot outlive the lock |
| `pooled` | in-memory, IndexedDB, Postgres | a lock the platform releases when its holder dies | yes |

A pooled lock and the writes are separate things: a Web Lock is released at unload while the page's IndexedDB transaction may still commit; a Postgres seat lock lives on a dedicated connection while writes go through pooled ones. An owned lock is the writing connection itself, so a fence would check nothing (and LevelDB's write-only `batch` could not read one).

**Governing invariant, for pooled seats: a seat lock is only ever acquired while holding the pool's allocation lock.** While one writer holds it, the set of held seats can shrink but not grow, so a snapshot of held seats taken under it is authoritative: a seat it shows free stays free until taken. Allocation is then one gather, one pure decision, and one lock request that cannot be refused. Every pooled backend allocates this way:

1. **Gather**, under the allocation lock: the store-wide metadata (format marker, pool) and the held seat locks (`navigator.locks.query()` for IndexedDB, `pg_locks` for Postgres, the `held` set in `sharedData` for in-memory).
2. **Plan**: `planStoreOpen` (`src/store/store-open.ts`), which makes the format decision and the seat decision (`allocateSeat` in `src/store/seats.ts`) together. It refuses a fresh id whose 53-bit peer number an existing seat shares, and takes the next.
3. **Execute**: take the chosen seat's lock without waiting (a refusal means the invariant was broken, so the open fails rather than return a seat another holder may have), then write the marker and the pool.

Session and owned stores run the same `planStoreOpen`, with `session` or `owned` seating, so every backend's open is one read of its store-wide metadata, one plan, one write.

**Fencing.** Each pooled claim increments the seat's **fence** in the pool, and every pooled write (`append`, `compact`, `delete`) reads the pool inside its own transaction and calls `assertSeatHeld`, which throws `SeatLostError` when the stored fence is not the seat's. Nothing in the Web Locks or IndexedDB specifications orders a dying page's last transaction before its lock release; without the fence, a late commit from the previous holder could land after the new holder hydrated, and the storage would hold two different operations at one address. With it, the stale write fails and changes nothing.

**Per backend:**

- **In-memory**: `InMemoryStoreData.seats` holds the pool and the `held` set; the constructor allocates synchronously, `close()` releases, and `abandonSeat` (from `@kyneta/exchange/testing`) releases without closing, as a dying holder's platform would. A closed store refuses every operation.
- **IndexedDB**: Web Locks, shared by every page and worker of an origin, named `kyneta:${dbName}:alloc` and `kyneta:${dbName}:seat:${peerId}`. The seat lock's `request()` promise settles only on release, so the grant is reported through a promise of its own. `createIndexedDBStore(name, { locks })` takes the lock manager; the default is `navigator.locks`.
- **Postgres**: session-level advisory locks in the two-key space, `(hashtext(<store-meta table>), hashtext(peerId))`, on a connection the store holds for its lifetime (`PgAdapter.dedicated()`). Postgres releases them when that connection ends, so a dead process frees its seat. The allocation lock is the pool's row, `SELECT … FOR UPDATE`; writers read it `FOR SHARE`, so an allocation and a stale write cannot interleave.
- **SQLite**: one owner per database. The built-in file adapters take `PRAGMA locking_mode = EXCLUSIVE` and `BEGIN EXCLUSIVE; COMMIT` when they wrap the connection; a Durable Object's adapter needs nothing, since the platform makes it the only owner.
- **LevelDB**: `classic-level` refuses a second open of a directory.
- **Prisma**: Prisma pins a connection only inside an interactive transaction, so it cannot hold a lock for a store's lifetime. Every open issues a session seat: one version-vector entry per process start per document written.

**Losing the seat is final, and store-wide.** A `SeatLostError` means another writer now holds this Runtime's identity, so every later write of every document would fail the same way. The executor turns it into the store-program input `seat-lost`; the model becomes terminal (`StoreModel.seatLost`): no writes, no retries, every document settled, so `flush()` and `shutdown()` resolve. `onStoreError` fires once. `persistenceError(doc)` is derived from the model, so every stored document reports the `SeatLostError`, including one opened after the loss. Own writes made afterwards are under an identity another Runtime holds; the store never confirms them, so the publish gate never opens and none leaves the process. **The application recovers by opening a new store — in a browser, by reloading.**

**Gotchas:**

- **Back/forward cache.** A page holding a Web Lock is usually not eligible for the bfcache. Pages with an open IndexedDB connection already pay this in several engines.
- **Insecure origins.** Web Locks exist only in secure contexts (Chrome 69+, Firefox 96+, Safari 15.4+). Without them, IndexedDB warns once and issues a session seat: unique, not stable.
- **Workers.** Web Locks are shared by an origin's pages and workers, so a store opened in a worker takes a seat like a tab.
- **`sessionStorage` is never used**: browsers copy it into duplicated tabs.

### The substrate's own copy of the invariant

Each substrate translates the seat into whatever its CRDT uses to attribute operations — Yjs a numeric `clientID`, Loro a `PeerID` — and *when* that translation is claimed matters as much as its value.

The translation is a hash, `peerNumber` from `@kyneta/schema` (53 bits for Yjs, 64 for Loro), so two distinct seats can still collide after it. At 53 bits that takes about 13 million writing peers for a 1% chance. See §"Peer identity and when a substrate may claim it" in `packages/schema/TECHNICAL.md`.

Because a CRDT addresses operations by `(peer, counter)` and the counter restarts at zero on a fresh document, a peer that claims an identity with stored history before loading that history writes to addresses the history already occupies. The merge deduplicates by address and one of the two operations is silently dropped. A session seat has no stored history, but a durable seat has.

So a **store-backed document claims its substrate identity after hydration, not at construction**. The Runtime builds it with `beginHydration` from `@kyneta/schema` when a store is configured, and calls the returned `adopt()` once the load resolves (the `adopt` effect) — before `register`, so peers never see the transient identity in an announcement. Without a store there is nothing to import and identity is claimed immediately.

One consequence worth knowing: a document written to *before* it has hydrated contributes its early operations under a transient identity, which shows up as one extra version-vector entry that never grows. Waiting for the document to settle avoids it, which the readiness layer already asks for on independent grounds. See §"Peer identity and when a substrate may claim it" in `packages/schema/TECHNICAL.md` for the rule and which backends need it.

## Serialized documents: one writer seat per storage

Source: `src/store/seats.ts` → `planWriter`, `WriterRefusedError`; `src/runtime.ts` → `#adopt`, `#authored`, `#rebuild`; `src/persistence.ts` → `writeRefusal`; `src/sync-program.ts` → `handleDocReset`.

A serialized document (`writerModel: "serialized"`: every `json.bind` document) has one identity, its **lineage**, minted by its first authored write, and every write extends it at `(lineage, n + 1)`. Seats give each CRDT writer an identity of its own; they do nothing here, because any writer extends the same lineage. Two seats over one storage that both write one plain document store two different operations at one position, and the next load keeps one of them. Across the network that is already out of contract (see "Plain lineage vectors" below): two peers authoring one authoritative document is misuse, settled by the reset machinery. The storage is new ground: several seats of one deployment share it, tabs of a browser profile or processes of a server fleet.

> **Of the seats sharing one storage, at most one authors each serialized document. The storage records which one.**

- **It only takes permission away.** It never makes a Runtime a writer, and decides only between seats that share a storage, which are the same deployment in the same role. A server and its clients never share one. Who may write across the network stays with governance (`canAccept`, `Authority`).
- **Authorship claims the document, not loading.** The store write carrying a seat's first own operation (`WriteOptions.authored`, set by `#authored` while the document has own writes unconfirmed, `ownHigh`) records the seat as the writer if none is, and is refused (`WriterRefusedError`) if another is. A seat that only reads, or only persists what the network sends, never claims: claiming on load would make a reader tab own a document it never writes, and make a fleet's writer whichever process loaded first.
- **Loading reads the claim.** `#hydrate` reads `store.writerOf(docId)`. If another seat writes the document, the `adopt` effect sets its seat refusal (`#refuse`), before the store program hears of the load, and authored writes throw synchronously from then on. The document still receives and persists what the network sends. A document promoted from a relay is refused the same way: the lifecycle model keeps the writer read when the replica loaded, and the promotion's `adopt` carries it.
- **The refusal is the Runtime's, not the substrate's.** Each interpreted instance builds its owner refusal as `firstDefined(seat, network)`, two `settableFeed`s, and passes it to `createRef` as `refusal`. The document's context answers `firstDefined(substrate's, owner's)` (`@kyneta/schema` TECHNICAL.md §Refusal), which `prepare` throws for every authored op. `WriterRefusedError` extends `WriteRefusal`. `#authored` asks whether the seat refusal is set. A closed document needs no owner answer: its substrate's slot answers `DocumentClosedError` first, and closing empties the network refusal, letting go of whatever filled it.
- **A lost race never leaves the process.** When two seats both loaded an unclaimed document and both wrote, the loser's store write is refused. Under [store-first](#store-first) nothing of it was sent. The executor maps `WriterRefusedError` to the store-program input `writer-refused`, never to `write-failed`, which would retry a write that is not this seat's to make. The program stops tracking the document, owed write included, emits `store-error` once and a `rebuild` effect. `#rebuild`:
  1. refuses further authored writes;
  2. reads the store and takes it into a fresh document of the same schema, toward the latest stored lineage. Not into the live replica, which, when both seats extended one lineage from one position, reaches the winner's version and would skip its entries as held. Not into a bare replica, whose entirety omits fields at their defaults, which the reset would then keep;
  3. replaces the live document with it (`resetFromEntirety`), discarding the refused write;
  4. calls `onDocReset`, which the Exchange forwards as `sync/doc-reset` (below);
  5. hands the document back with `hydrated`. The write that owes finds nothing new and confirms at once, and its confirmation reopens the gate: the rebuilt version reaches `ownHigh`, or lies on another lineage. Offers owed meanwhile go out, carrying the winner's state.

  It stops at the read if the document is destroyed meanwhile. The late refusal happens only when both seats wrote before either had claimed; otherwise the loser learns at load.
- **`sync/doc-reset` voids what we told peers we hold.** A merge that arrived while the rebuild read the store went into the live replica, and the reset discarded it. The sending peer believes we hold it, and our next interest would quote `theirVersionWeHold`, claiming it, so the gap would stay. `sync/doc-reset` clears `theirVersionWeHold` for every peer of the document and sends each synced one an interest quoting only our new version, so each answers with what we lack.
- **Writership moves only with the seat.** A live Runtime never takes a document over. When the writer seat's holder dies, the seat returns to the pool, and the next Runtime to open takes it (the oldest free seat) and so is the writer. Everything the previous holder sent had been confirmed first, and the fence rejects its late writes, so the new holder's state holds every operation under the lineage.
- **A refusal is reported by `writeRefusal(doc)`**, and observed through `writeRefusalFeed(doc)`, so a UI can disable editing: `@kyneta/react`'s `useText` keeps its element read-only while it is set, and `useWriteRefusal` gives it to other editors. Both read the document's context (`ref[TRANSACT].refusal`), the one answer the write path throws, so they report every refusal: a seat refusal, plain's `DocumentLoadingError` while a stored `json` document loads, and `DocumentClosedError` once it closes. Narrow with `instanceof`. A seat refusal is set at load or after a lost race, and kept for the session. It is not a `persistenceError`: a document refused at load never failed a write, and a refused document's unauthored writes succeed.
- **Deleting is authoring.** `delete` is refused when another seat writes the document. A reader's `destroy()` still evicts the document locally and dismisses it from the sync graph; the writer's stored copy stays, and the refusal goes to `onStoreError`. A document nobody claimed, such as a `Line` inbox, stays deletable by any seat.
- **Only pooled seats are recorded** (in-memory, IndexedDB, Postgres). An `owned` seat (SQLite, LevelDB) is the storage's only one, so the rule holds by construction. A `session` seat (Prisma, IndexedDB without Web Locks) is never held again, so a record naming it would lock the document for good; the rule is not enforced there, and serialized writes must be routed to one process.
- **`Line`s never contend.** An outbox is written only by the seat its id names, and a later session on that seat is the same writer; an inbox is only persisted, never authored.

---

## The local-write path

Source: `src/runtime.ts` → `#wire`, `#markLocalChangeDirty`, `#drainLocalChanges`, `#drainLocal`; `src/exchange.ts` → the `onDocAdvanced` hook.

A local write is anything this peer authors on a document: `batch(doc, fn)`, a write on a ref, `applyChanges`, and a write made directly on the native document reached through `unwrap`, which is how editor bindings (y-prosemirror, y-codemirror, loro-prosemirror) write. Every one of them leaves the process the same way. The substrate reports it through `subscribeLocalUpdates`, the Runtime marks the document dirty, and one drain per microtask asks for each dirty document to be persisted and pushed. With a store, the push leaves once the store has confirmed the write ([Store-first](#store-first)).

```
batch(doc, fn)  |  unwrap(doc.title).insert(…)  |  an editor binding's transaction
  │
  ├─ the substrate's local-update signal fires (Yjs: a local transaction's
  │  `update`; Loro: `subscribeLocalUpdates`; plain, ephemeral: `afterBatch`)
  │
  ├─ #markLocalChangeDirty(docId): add to the dirty set, schedule one microtask
  │
  └─ #drainLocalChanges, once per microtask, #drainLocal for each dirty document:
       ├─ commitPending(): a pending native write reports itself now
       ├─ with a store: ownHigh := the replica's version
       ├─ onStateAdvanced(docId) → store program `state-advanced` → persist
       └─ onDocAdvanced(docId) → synchronizer.notifyAdvanced
            → sync/doc-advanced → a push to each synced peer, starting
              from what that peer will hold, owed until reported sent
            → #executeSendOffers: publishable(docId)?
                 yes → export, queue offers, sync/offers-sent
                 no  → nothing leaves; the store's confirmation re-sends
```

**Why not changesets.** The path used to hang off the changefeed: each changeset with `replay: false` was pushed and persisted. A changeset is the schema's account of a write, and not every local write has one:

- a write on the native document arrived through the event bridge as an announcement, and was treated as not local;
- a Yjs write to a top-level type outside the schema's root map, or a Loro write to a root container the schema does not declare, produces no changeset at all;
- a native write that shares a transaction or commit with a Kyneta batch is hidden by the batch's own-commit mark.

The local-update signal is the CRDT's own account, so it sees all three. Changesets still reach the `onDocChangeset` hook, which feeds only the observation bus.

**Why one deferred drain.** The signal fires synchronously, sometimes inside a native commit or a merge, and sometimes several times for one batch. The drain keeps the store program and the Synchronizer out of those callbacks, and turns any number of signals, batches and documents in one tick into one persist and one push per document. It is also the one place the order of persist and push is decided. Re-entrancy is not a reason: the Synchronizer's dispatcher already queues re-entrant input.

**Persist, then push.** The drain requests persistence before the push. Without a store the push leaves at the Synchronizer's next quiescence. With one it is held at the export until the store confirms the write, and sent when it does; see [Store-first](#store-first).

### Echo prevention

A merge fires the local-update signal only for a local write it causes, never for what it brings in, so what arrives from a peer is never sent back as if it were local. Echo prevention is structural: no exchange decision reads `Changeset.replay`. The local writes a merge can cause are real, and are pushed like any other:

- Loro's `import` commits pending native ops before it applies the payload;
- an observer may write in reaction to what arrived;
- the Yjs delete clock ticks for a delete that arrived without a tick, which only a plain Yjs peer (through a provider) sends. A Kyneta delete carries its author's tick, so a merge of Kyneta writes never ticks.

A push starts from what each peer will hold (`ourVersionTheyWillHold`), which already includes what that peer just offered us, so a local write made while taking in a peer's offer is pushed to that peer without the offer itself.

Before the signal, the filter was a changeset's `replay` flag, and before that `changeset.origin === "sync"` — fragile because `origin` is a free-vocabulary app label, so a `batch(doc, fn, { origin: "sync" })` was suppressed and a `doc.import(payload, "from-some-other-pubsub")` echoed. Context: jj:qpultxsw.

#### Line: no inbox echo filter needed

`Line` (`packages/exchange/src/line.ts`) subscribes to its inbox doc's changefeed to dispatch incoming messages. There is **no echo filter** on this subscription — by design, the Line only writes locally to its `outbox`, never to its own `inbox`. Inbox changes are delivered exclusively by merges of remote peer writes, which arrive as announcements (`replay: true`). A previous `changeset.origin === "local"` filter (pre-jj:wpvtoxmw) was dead code — the convention it pinned had no writer in the exchange package — and was removed.

The "exchange never branches on `origin`'s value" invariant holds globally, and neither does any exchange decision branch on `replay`: what leaves the process follows the local-update signal, and the Line relies on the absence of local inbox writes. `replay` is for readers such as the observation bus.

### Same-doc re-entry inside subscribers (post-1.6.0)

`batch(doc, fn)` called from inside a `subscribe(doc, ...)` / `subscribeNode(doc.field, ...)` callback no longer requires `queueMicrotask` (`jj:yksllknw`). The per-doc changefeed dispatcher in `@kyneta/schema` shares the Exchange's `Lease` (`jj:qlvnvxox` extended this slice), so re-entrant doc-layer mutations drain in a fresh sub-tick of the same outer dispatch call, while the cascade is budget-bounded.

This closes the third instance of the "one-pass-only drain" structural flaw called out in `jj:qlvnvxox`'s Learnings — input-phase synchronizer (#1), output-phase synchronizer (#2), and now the doc layer (#3). A `BudgetExhaustedError` emitted anywhere in the stack carries history entries labeled `"synchronizer:session"`, `"synchronizer:sync"`, `"synchronizer:outer"`, and `"changefeed"` — the label set is the cascade topology.

### What the local-write path is NOT

- **Not synchronous with send.** `batch(doc, fn)` returns as soon as the substrate's `onFlush` completes. The wire `offer` fires in the next quiescence drain, which may be the same tick or later depending on re-entrant dispatch, and with a store not before the store has confirmed the write.
- **Not per-mutation.** However many writes, batches and signals a document sees in one microtask, the drain runs once for it: one `sync/doc-advanced` input, and one export per distinct baseline among the synced peers.
- **Not guaranteed-delivery.** The payload is queued on the transport; delivery depends on the transport.

---

## Store-first

Source: `src/runtime.ts` → `publishable`, `#drainLocal`, `#gateOpen`, `#confirmed`; `src/publish-gate.ts` → `gateOpen`; `src/synchronizer.ts` → `#executeSendOffers`; `src/sync-program.ts` → `handleOffersSent`, `handleDocPublishable`; `src/persistence.ts`.

> With a store, an own operation leaves the process only after the store has confirmed it.

**Why.** Yjs and Loro address an operation by `(peer, counter)`, and plain by `(lineage, n)`, and a counter means something only relative to the history a replica has loaded. A replica may issue operations under an identity only if its state holds every operation ever issued under it. A store-backed document claims its identity after hydration, which assumes the store holds everything the identity issued. Before store-first it need not have: the drain asked for the store write and the push together, the push left at the next quiescence, and the store write completed later. A crash in between left operations only the network had. The next session hydrated without them, wrote at the addresses they occupy, and the peers holding the old ones deduplicated the new ones away. The divergence was permanent and silent on every backend. With store-first, "hydrated" implies "the clock is known", and the `createForHydration`/`adopt` path is sound as it stands.

**The gate.** The Runtime keeps, per interpreted document:

- `ownHigh`: the replica's version when the drain last found own writes, with a store;
- the store's confirmed version, read from the store program's model (`confirmedVersion`: `idle`'s version, or a write in flight's `revertTo`).

The document may leave the process when `ownHigh` is unset, when the confirmed version `reaches` it, or when the replica itself no longer reaches it (`gateOpen`). The last is a lineage reset: a replica's version only grows otherwise, so its own writes are gone, nothing of them is left to confirm, and the store will only ever confirm versions of the new lineage. `reaches` is the generic test of holding a version, so the gate needs no backend-specific notion of an own component. Plain and Loro versions advance on every own operation; a Yjs version advances on a delete only through the delete clock, which is what makes a delete-only write one the store must confirm.

**Checked at the export.** `#executeSendOffers` asks `runtime.publishable(docId)` immediately before exporting. `publishable` first runs `#drainLocal`: it commits whatever the native document holds uncommitted (`Substrate.commitPending`), and drains the document if that, or anything earlier, left it dirty. Then it evaluates the gate. The drain, the check and the export are consecutive synchronous calls, so nothing can write between them. A gate decided anywhere earlier is bypassed two ways:

- a Loro native write left uncommitted fires no signal until something commits it, and an `export` does, so the write would be sent by the export that should have been refused;
- the sync dispatcher is first in, first out, so an `interest` queued earlier can be answered after a merge whose subscriber wrote, before any message saying the gate had closed.

**The whole document is held back.** Yjs cannot export an upper-bounded range, so there is no way to send everything except the unconfirmed operations. Filtering own structs out of an update is unsound: the delete set can reference own items that were never stored, and after a crash those ids are reissued, so a peer holding the pending delete would apply it to the new item. So while a document has unconfirmed own operations, no message carrying its content leaves: not a push, not a relay of another peer's operations, not an answer to an interest.

**Owed, then reported.** The sync program emits `send-offers` as before, but records `offerOwed` instead of moving the recipient's baseline ([What each side knows about the other](#what-each-side-knows-about-the-other)). The executor either sends and reports each recipient it queued with `sync/offers-sent`, carrying the version the offer carried, or sends nothing. When the store confirms, the store program's `persisted` effect runs `#confirmed`, which clears `ownHigh` once the confirmed version reaches it and calls `onDocPublishable`: the gate was shut exactly while `ownHigh` was set, so clearing it is the opening. The Exchange forwards it as `sync/doc-publishable`, which re-emits every owed offer from its `since`.

**The opening is an effect.** `write-succeeded` emits `persisted` before the `persist` of any write owed behind it, so the gate opens against the version just confirmed. An effect runs after the model updates, however dispatches nest, so the executor always reads the current phase; a check placed after a `dispatch` call would depend on whether that dispatch was nested. It also keeps every gate transition in the store program's effects.

**Two kinds of document need no gate.**

- Writes made before `adopt()`. A stored CRDT document writes under a throwaway id until hydration claims the real one, and nothing else will ever write under it. These writes happen before the `wire` effect subscribes the local-update signal, so the gate never sees them.
- Replicate-mode documents make no operations of their own; `publishable` answers `true` for them, as for any document without a store.

**Announcements need not lag.** `interest` and `present` carry `DocEntry.version`, which includes unconfirmed own operations. A peer's own operations held back, announced, then dropped by a crash, and a new session writing something else under the same identity: Yjs, Loro and plain all converge. No peer ever held the dropped operations, so a version that claimed them misled no peer about what to send.

**Persistence is observable.** `persisted(doc)`, `persistedFeed(doc)`, `whenPersisted(doc)` and `persistenceError(doc)` (`src/persistence.ts`) answer whether every own write is confirmed, and why not. A document with a write the drain has not reached yet is not persisted either. `persistenceError` covers every store write, including one that stores only imported operations, so it can be set while `persisted` is true. `whenPersisted` checks in `whenHydrated`'s order: resolve if persisted, reject if an error is recorded, otherwise wait; a document closed with own writes unconfirmed rejects with its `DocumentClosedError`. It is not a settle term: `settled` asks whether every source has reported, and a write waiting on the store is not a source.

**Costs.**

- **Latency:** own operations reach peers one store write later.
- **Liveness:** writes arriving faster than the store confirms them hold content back until they pause. The store program collapses writes requested during a write into one owed write, so any pause longer than one store write opens the gate.
- **Relays:** a document holding its own unconfirmed write relays nothing until the next opening.
- **A failed store write** keeps the gate shut until a write succeeds. The store program retries with a capped backoff (250 ms, doubling to 30 s), and `persistenceError` reports the failure meanwhile.
- **Duplicate payloads:** between emission and the report, a second push to the same peer can resend bytes; merges are idempotent.

---

## Departure, grace, reconnection

Source: `src/session-program.ts` → departure handlers, `src/exchange.ts` → `departureTimeout` default.

Channel drop and peer departure are different. A peer can be temporarily disconnected (flaky network, tab backgrounded) and return with the same identity; treating every channel drop as a full departure would thrash document state. The session program distinguishes:

| Event | Session-model update | Emitted `sync-event` |
|-------|----------------------|----------------------|
| All channels to peer removed | Peer stays in session map with `channels.size === 0`. A `start-departure-timer` effect fires (default `departureTimeout = 30000` ms). | `sync/peer-unavailable` |
| Reconnection before timer expires | Peer transitions back to `channels.size > 0`. `cancel-departure-timer` effect. | `sync/peer-available` (re-sync begins) |
| Timer expires with no reconnection | Peer is deleted from session map. | `sync/peer-departed` |
| Explicit `depart` message received | Peer is deleted from session map. No grace timer. | `sync/peer-departed` |

Setting `departureTimeout: 0` in `ExchangeParams` disables the grace period — useful for tests where "disconnected" and "departed" are the same thing.

### What departure is NOT

- **Not the end of a document.** Other peers' copies survive. The local exchange's doc refs are unaffected unless the app calls `destroy`.
- **Not the same as disconnection.** Disconnection is `channels.size === 0` within the grace window; departure is after.
- **Not acknowledged.** A sender of `depart` doesn't wait for a receiver ack. The message is one-way and best-effort.

---

## `Policy` and `Governance`

Source: `src/governance.ts`.

A `Policy` is an interface with **optional** gate predicates and handlers. Any field that's absent is treated as "no opinion" for that operation.

```ts
interface Policy {
  canShare?: GatePredicate       // May this peer receive this doc at all? Gates
                                  // present, push, relay, and the answer to a
                                  // direct request.
  canAccept?: GatePredicate       // Should we accept a peer's `present` for this doc?
  canReset?: EpochBoundaryPredicate     // Accept compaction-induced state discard?
  cohort?: GatePredicate         // Does this peer's version constrain compaction?
  canConnect?: (peer) => boolean | undefined   // Should we accept this peer at all?
  resolve?: (peer, docMeta) => Disposition      // Classify an unknown doc
}
```

The `Governance` class holds an ordered list of policies and composes their gates via the pure `composeGate` function:

```
composeGate([pred1(...), pred2(...), ...], default)
  → false if any result is false     (short-circuit veto)
  → true  if any result is true      (with no vetoes)
  → default otherwise                (all undefined)
```

The default differs per gate:

| Gate | All-`undefined` default |
|------|------------------------|
| `canShare` / `canAccept` / `canConnect` / `canReset` | `true` (open) |
| `cohort` | `true` (all synced peers in the cohort) |

Three-valued logic is the composition mechanism. One `false` vetoes; one `true` permits (with no vetoes); all-undefined falls through to default. This lets a feature (a `Line`, a room, a game loop, a user-supplied policy) register its own gates without coordinating with the rest of the system — policies are independent concerns that unify cleanly.

### Every path a document can leave by

A document can reach a peer four ways, and **all four consult `canShare`**:

| Path | Handler | Effect |
|------|---------|--------|
| Announce | `handlePeerAvailable`, `handleDocEnsure` / `handleDocDefer` → `announceDoc` | `present` |
| Push | `handleDocAdvanced` → `buildPush` | `send-offers`, one recipient per peer, each from its own baseline |
| Relay | `handleDocImported` → `buildPush` | `send-offers`, likewise |
| Answer a request | `handleInterest` → `handleInterestForKnownDoc` | `send-offers` with one recipient |

The first three filter recipients through `filterPeersByShare`. The fourth is a single-peer check inside `handleInterest`.

**An unloaded document is never announced**: `buildPresent` skips its entry, so a peer that becomes available is not told of it, and it has no instance to push or relay from. **A leaving document still sends** (pushes, owed offers, and answers to interests) and takes nothing in: see [Suspend, unload, destroy](#suspend-unload-destroy).

The last three carry content, and all three become one `send-offers` effect. Its executor asks the Runtime's publish gate immediately before exporting, so with a store none of them sends while the document has own writes the store has not confirmed; see [Store-first](#store-first). The re-send when the gate opens, `sync/doc-publishable`, filters its recipients through `canShare` too.

**The fourth shipped ungated through 3.0.0.** `canShare` therefore decided only whether a peer was *told about* a document, not whether it could *have* one: any peer that knew or guessed a document id could pull its full state by calling `get(docId, schema)`, which sends `interest` to everyone. The leak was the initial state rather than a live subscription — subsequent pushes were filtered by `buildPush` — which is part of why it went unnoticed. `handlePresent`'s known-document branch was ungated for the same reason and is now checked too; without it, a denied peer's own `present` would still draw an `interest` naming our version.

**The denial reply does not depend on whether we hold the document.** The `canShare` check in `handleInterest` sits *above* the document lookup, so a denied peer gets `vacant` either way. If it were below, a denied peer would get a prompt `vacant` for documents we hold and silence for ones we do not — an existence oracle, a way to ask yes/no questions about our data without being permitted to read any of it. The reply is also a reply rather than silence for a related reason: silence leaves the requester's `whenSettled` pending until `offlineAfter`, and how long a peer waits before giving up is itself observable. Both producers of `vacant` go through one `vacantReply` builder, which is where the reasoning is recorded in the source.

**The test lesson.** Both pre-existing `canShare` tests asserted `exchange.has(docId) === false` after an announce. That proves a peer was not *told*; it does not prove it could not *ask*, and nothing in the suite ever asked. A gate needs every door tried — and because the sync program is pure, they can all be tried in one test: `sync-program.test.ts` §"canShare — no outbound effect reaches a vetoed peer" drives every outbound-capable `SyncInput` and asserts nothing naming the vetoed document reaches the vetoed peer except `vacant`. That test, not this paragraph, is what fails when a fifth path is added.

### `cohort` — compaction scope governance

The `cohort` gate determines which peers' holdings (`ourVersionTheyHold`, from their `accept`s and interests) participate in the LCV (least common version) computation. `Exchange.compact(docId)` passes the LCV to `Runtime.compact(docId, trimTo)` as the trim point — `replica.advance()` never exceeds it, so cohort members are guaranteed incremental delta sync (never stranded by compaction).

**`compact()` always compacts storage, and trims memory only where a replica can.** `Runtime.compact` owns the trim, since it owns the document's record: it advances the replica to `trimTo` (or entirely, for a standalone Runtime with no network to bound it), then has the store program replace what is stored with the whole document. A live Yjs or Loro document trims nothing in memory (see [Compaction and lineage boundaries](#compaction-and-lineage-boundaries)); plain documents and relay replicas trim. Without a store, only the trim happens.

Peers **outside** the cohort sync normally but may be compacted past. When this happens, `exportSince()` returns `null` for the stranded peer, triggering an `exportEntirety()` fallback — an lineage reset. If the stranded peer has unsynced local writes, those writes are lost on reset.

The default (`true`) includes every peer we push to in the cohort: the LCV considers each one's holding, and compaction never strands anyone. Set a `cohort` policy to restrict the LCV to durable peers (e.g., `peer.type === "service"`), allowing ephemeral peers (browser tabs, mobile clients) to be compacted past without holding back the frontier.

```ts
new Exchange({
  principal: "server",
  type: "service",
  cohort: (_docId, peer) => peer.type === "service" ? true : false,
})
```

### What `Policy` / `Governance` is NOT

- **Not authorization middleware.** These gates run at protocol points (pre-send, pre-accept), not at application API points.
- **Not synchronous with remote peers.** A policy denying `canShare` silently omits the doc from `present`; no error is sent. A peer that asks for the doc *directly* does get a reply — `vacant` — but that is a protocol answer, not an error, and it is exactly the reply it would get for a doc we do not have.
- **Not hierarchical.** Every registered policy is peer to every other. There is no "super-policy" that overrides the rest.
- **Not persistent.** Policies live in memory. Add / remove at runtime.

---

## Reactive collections

Source: `src/exchange.ts` → `createReactiveMap` wiring.

The `Exchange` exposes two `ReactiveMap` instances:

| Collection | Element | Change type | When it fires |
|------------|---------|-------------|---------------|
| `exchange.peers` | `ReactiveMap<PeerId, PeerIdentityDetails, PeerChange>` | `PeerChange = { type: "joined" \| "left" \| "updated" \| … }` | `sync/peer-available`, `sync/peer-unavailable`, `sync/peer-departed`, identity changes |
| `exchange.documents` | `ReactiveMap<DocId, DocInfo, DocChange>` | `DocChange.type ∈ { "doc-created", "doc-removed", "doc-deferred", "doc-promoted", "doc-suspended", "doc-resumed" }` | Doc lifecycle transitions |

Both drain at quiescence with batched changesets (one `Changeset` per dispatch cycle per subscription point, not one per individual change). `exchange.documents` updates only the documents a drain's events name (`docInfoChanges`, pure, over `#docs` and the sync model), so its cost is the size of the change, not of every document held. An undo stack follows it the same way (`followChanges`). Subscriptions use the standard `@kyneta/changefeed` API: `subscribe(exchange.peers, changeset => { … })`. Calling the map itself returns the current `ReadonlyMap`: `exchange.peers().get("alice")`.

### Ready state — two folds of one transition

A peer's per-doc sync transition is a single event with **two folds**, both advanced at the single fold point `setPeerDocState` (`src/sync-program.ts`):

1. **Volatile state** — `SyncModel.peers[*].docSyncStates: Map<DocId, PeerDocSyncState>` (`status ∈ {pending, synced, vacant}`). Drives routing (`getSyncedPeers`) and the raw per-peer view `sync(doc).peerStates: PeerSyncState[]`. **Can regress** — a reconnecting peer's reciprocal `interest` flips `synced → pending`, and flips back once the shell has compared its version: in the same drain if the peer is at or behind our version, or when its offer merges if it is ahead or concurrent. An observer sees the `pending` only in the latter case.
2. **Monotonic latch** — `SyncModel.reconciledIdentities: Map<DocId, Map<PeerId, PeerIdentityDetails>>`, a grow-only accumulator of reconciled peer **identities**. `setPeerDocState` folds the peer's identity in whenever `next.status ∈ {synced, vacant}`; `pending` never touches it. This is the monotonic complement that volatile state lacks — the same shape as `@kyneta/schema`'s `populated`/`populated` set, lifted to the sync layer. Storing identities (not just `PeerId`) is what lets `readyFor(pred)` work and lets the latch **survive the reconciled peer leaving `model.peers`**.

`sync(doc).ready` is `hasReconciled(model, docId)` (accumulator non-empty) — monotonic, connection-independent. `sync(doc).readyFor(pred)` is `reconciledMatching(model, docId, pred)`. The latch is cleared only on *our* doc removal (`handleDocDismiss` **only when `msg.event?.type !== "doc-suspended"`** — suspend keeps the runtime/data alive, so its latch survives `resume`) and on `initSync` (so `reset()`/`shutdown()` clear it). An inbound `dismiss` clears the peer's *volatile* entry but **not** the accumulator.

**Every `synced` transition is downstream of a version comparison in the shell.** Two inputs produce it — `sync/doc-imported` after a merge or a reset, and `sync/peer-synced` when a comparison found nothing to import — and `sync/peer-synced` has exactly one producer, `Synchronizer.#classifyPeer`, which both the offer path and the interest path call. (`vacant` also latches reconciliation, and is comparison-free by design: the peer has said it will not serve the doc, so there is nothing to compare.) The pure decision it delegates to, `transitionForPeerVersion`, is what says a peer that is behind, equal, or version-less is `synced`, and a peer that is ahead, concurrent, or unreadable stays `pending`. The comparison itself is `compareHoldings(ours, theirs)`, pure over values `#classifyPeer` gathers (each side's version and digest): equal when both sides send a digest and the digests match, otherwise what the versions say. Only a format whose version cannot answer equality sends a digest (the ephemeral install counter), and every replica of such a format sends one, a relay's headless replica included, so a relay holding what a peer holds marks it `synced` without importing.

That is a by-construction property because of what the second fold means. An inbound `interest` used to mark its sender `synced` whenever `reciprocate` was false — reading a loop-prevention flag as "this peer has nothing for me" — and that transition also latched reconciliation, which is what `whenSettled` reads. A client therefore settled on its authority's *request* for state, before the authority's offer had arrived. Any future producer of `synced` must go through the comparison, or it reintroduces that.

Two distinct "has-synced" questions, deliberately **not** unified. Is the offer's sender `synced` right now (the status alone, read inline in `#executeImportDocData`)? That gates compaction-reset detection. Has anyone ever reconciled this document with us (`hasReconciled`, monotonic and connection-independent)? That gates `ready`.

There used to be a third, `#isReady` — connection-aware, reachable only through `waitUntilReady` and then `waitForSync`, a strictly linear chain. Removing `waitForSync` in 3.0 took the whole chain with it.

Note also that `sync(doc).ready` now reports `true` when no transports are configured, matching the carve-out the settle conjunction already had — with nothing that could ever answer, waiting is waiting forever. `readyFor(pred)` deliberately does *not* get that carve-out: it asserts a specific peer was consulted, and with no transports none was.

`ready` is the *network* latch and stays authority-agnostic: it answers "did anyone reconcile?", not "did the right peer reconcile?". Authority is a settle-layer concept, so code that needs it reads `docStatus` or `whenSettled` rather than `ready`. This is why `authority: "self"` does **not** make `ready` true on a server with a transport and no clients — and why `useDocReady` is defined over `docStatus` rather than over `ready`.

### Connectivity & settling

- `deriveConnectivity({ establishedPeers, transportCount })` — pure classifier: `online` (≥1 established peer), `offline` (no transports), else `connecting`. `synchronizer.connectivity()` / `sync(doc).connectivity` gather the counts (`TransportManager.size`, session peers with a live channel) and delegate.
- `awaitReconciliation(docId, isReady, timeoutMs, signal?)` (`synchronizer.ts`) — shared listener+timeout+cleanup core whose **resolve predicate is a parameter**, so it stays a pure wait mechanism with no opinion about readiness; an aborted `signal` lets go of the listener. `whenSettled` — its only caller, through the document's narrow `SyncSource` — passes the document's settle conjunction, `settledWith(ref, authority)`. It resolves `{ via: "local" }` (nothing upstream had to answer: no transports, or `authority: "self"`), `{ via: "peer" }` (the authority answered), or `{ via: "offline" }` (after `offlineAfter` ms). It rejects only for a failed load, or for a document closed before its peers answered.

This is the reactive surface for `@kyneta/react`'s `useDocReady` / `useSyncState` and similar hooks.

---

## Document readiness — a conjunction over layers

Source: `src/settle.ts`, `src/doc-status.ts`, `src/initialize.ts`, `src/doc-meta.ts`.

A document sits at one of four layers, and each adds exactly one thing worth
waiting for:

| Layer | Construction | Adds |
| --- | --- | --- |
| Ref | `doc.field` | — (inherits the document's; see below) |
| Document | `createDoc(bound)` | — nothing to await |
| + Runtime | a store configured | the stored data finishing its load |
| + Exchange | transports configured | the authoritative peer answering |

**Everything kept per document is one record, `DocumentTerms`** (`src/document-terms.ts`), in one weak registry:

```ts
interface LocalTerms   { syncMode; hydration: Settable<Hydration>; persistence: Settable<Persistence> }
interface NetworkTerms { peer: Settable<Peer>; authority: Settable<Authority>; sync: Settable<Sync> }
interface DocumentTerms { local: LocalTerms; network: Settable<NetworkTerms | undefined> }
```

The Runtime attaches `local` as it creates an interpreted document (`registerLocalTerms`), and the Exchange attaches `network` through `onDocInterpreted` (`registerNetworkTerms`); a document no Exchange syncs keeps `network` empty. A term's value carries its own error (`Hydration` is `pending`, `loaded`, or `failed` with its error), so one `set` changes both. The read functions (`settled`, `settledWith`, `hydrated`, `whenHydrated`, `persisted`, `whenPersisted`, `persistenceError`, `docSyncMode`, `writerModelOf`, `authorityFor`, `sync`, `whenSettled`) read fields of `termsOf(ref)`. A new kind of per-document state is a new field, and `closedTerms` must close it, or it does not type-check.

A ref inherits its document's terms because the registry is keyed by the document's shared context, which every writable ref carries under `[TRANSACT]` (`documentKey`), so `docStatus(doc.items)` and `useText(doc.title)` see what the root sees. Keyed by the root ref, as they once were, a child ref found nothing and reported "nothing to wait for" while its document was still loading.

**The registry being weak does not make the document collectable**, and was never what kept one alive. A registration in `@kyneta/schema`'s ref registry whose held value reached the ref was: the held value, a path, reached the context, which keyed these terms, whose live feeds closed over the Runtime's entry and the root ref. Safety comes from two facts: that registry is per trie, so only the document reaches it (`@kyneta/schema` TECHNICAL.md §"How long a ref lives"), and a closed document's terms are constants, so a ref held after the close reaches nothing of the Runtime or the Exchange.

**`settled(ref)` is two named terms**: `local.hydration` loaded, and `network.peer` settled. A document with no terms is the empty conjunction, which is `true`, so a standalone document and a transportless, storeless daemon are settled by construction. One with no network part waits on its hydration alone. The transportless case therefore needs no carve-out anywhere: it falls out of the algebra.

A term is a `[CHANGEFEED]` carrier, not a bespoke interface — the universality
rule in `packages/changefeed/TECHNICAL.md` ("every reactive surface in Kyneta
goes through this one symbol"), and the same insight `jj:mltppspx` recorded as
"The Universality of CHANGEFEED". Every term is a `settableFeed`
(`@kyneta/changefeed`) following a live `signalFeed` over the Runtime or the
Exchange, and the public feeds (`hydratedFeed`, `persistedFeed`,
`settledFeed`) derive from the terms, the same shape as `populatedFeed(ref)`,
composing with `useChangefeed`, `@kyneta/reactive`, and `@kyneta/index` with no
new plumbing. That is why the React binding is a one-line adapter rather than a
store core.

### Closing never invents an answer

Source: `src/document-terms.ts` → `snapshotOf`, `closedHydration`, `closedTerms`, `closeTerms`; `src/runtime.ts` → `#close`.

When a document closes (destroyed, reset, shut down, or an `open` that found nothing), the Runtime's `#close` reads each term's value (`TermsSnapshot`), taking hydration from the lifecycle (the model no longer holds the document, so the term cannot read it), computes the closed values with one pure function, `closedTerms(snapshot, error)`, and sets each term. Each term keeps the answer it had; a term still pending closes as failed with the `DocumentClosedError`:

| Term | At the close | Closed |
|---|---|---|
| hydration | `loaded` / `failed` | as it was |
| hydration | `pending` | `failed` with the close error: `hydrated` stays `false`, `whenHydrated` rejects |
| persistence | confirmed | as it was |
| persistence | own writes unconfirmed | `persisted: false`, error the close error: `whenPersisted` rejects |
| peer | settled or not | as it was, by any authority, judged from the peers the document had reconciled with |
| authority | its value | as it was |
| sync | live `SyncRef` | its state at the close; its source reports the stored connectivity, and its waits reject with the close error |

`settableFeed` notifies on `set` and drops the live feed, with its closure over the Runtime or the Exchange. So a feed or a wait obtained before the close follows it with no second notification path: a pending `whenHydrated` or `whenPersisted` settles by the table, and a pending `whenSettled` lets go of the Synchronizer's wait and asks the closed source, which rejects. `whenSettled` after the close resolves only if the peer term had settled, with the `via` it would have had; otherwise it rejects. Resolving `{ via: "local" }` instead would let `initialize` conclude "empty" for a document the authority never answered for, the negative verdict the next section forbids. A never-synced, empty, closed document keeps `docStatus` at `"pending"`.

`#close` closes the hydration once, with `closedHydration`, which `closedTerms` also uses, and tells the instance's waiters that same value: `Runtime.whenHydrated(docId)` rejects with the error `whenHydrated(ref)` rejects with.

### One predicate, one wait

Every readiness surface — `settled`, `settledWith`, `docStatus`, `docStatusFeed`, `whenSettled`, `initialize`, and the React hooks over them — derives its peer half from **one** function: `derivePeerSettled` (`synchronizer.ts`), reached through the peer settle term. None of them re-implements it. The boolean forms read the term directly; `whenSettled` waits on `settledWith(ref, authority)`, which is the same term with the authority supplied by the caller.

That is an invariant rather than a stylistic preference, and it is written down because 3.0.0 shipped without it. `whenSettled` had a second, private copy of "has the authority answered?" that checked only `hasReconciled` (or `reconciledMatching`, when the caller passed a `peer` predicate, an option since removed in favour of `authority`). It never consulted `Policy.authority`. The two copies disagreed in both directions:

- **Over-waiting.** A server declaring `authority: "self"` with a transport configured — the normal shape of a server, since it has to listen for clients — hung forever inside `initialize`. `settled(doc)` was already `true` and `docStatus(doc)` already read `"empty"`; only the promise disagreed. The `"self"` rule exists precisely to say "my own storage is the last word, there is nobody to wait for", and the wait ignored it.
- **Under-waiting.** A client declaring `authority: p => p.principal === "server"` resolved as soon as *any* peer reconciled, including another equally-empty client. `initialize` then returned `"loaded"` — "the document already had data" — on the word of a peer that had never seen it.

The test gap that hid this is worth naming, because it is the reusable lesson: **every** `authority` scenario in the suite was transportless, and with no transports configured every rule in `derivePeerSettled` short-circuits to `true` via the `isOffline` branch. The truth table was exhaustive and the integration tests were green, yet nothing exercised the authority rules against a live transport. Tests for a rule with a short-circuit have to defeat the short-circuit, or they test only the short-circuit. The cases in `__tests__/authority.test.ts` and `__tests__/integration.test.ts` §"whenSettled — authority" now configure a bridge transport for exactly this reason.

A corollary for `initialize`: the authority is resolved **before** the wait, not after. It decides what is being waited for, so reading it afterwards meant an explicit `initialize(doc, seed, { authority: "self" })` could not stop a wait that had already started.

### The gate guards only the negative verdict

`docStatus` returns `"pending" | "empty" | "populated"`, computed by the pure
`deriveDocStatus`:

- `populated` wins regardless of settledness. Content is monotonic and arrives
  from any source, so data that has already arrived is not made less real by
  another source still being in flight. Disjunctive.
- `empty` requires every source to have reported. It is a claim about absence,
  and absence of evidence is not evidence of absence until everything has been
  consulted. Conjunctive.

The three states exist so that "we do not know yet" cannot be mistaken for
"there is nothing here" — the distinction that decides whether writing defaults
destroys data.

### The `x` / `xFeed` naming rule

The short name is the plain value; the `*Feed` suffix is the observable
carrier. Reading is routine and gets the short name; subscribing is the
specialist move and pays the suffix.

The hazard the rule guards against is concrete: a carrier is a callable,
so `if (populatedFeed(ref))` is **always truthy**, silently the opposite of
the truth for an empty document. Call the feed, or use the short name.

### The limits of the claim

"Every truth source has reported" is decidable only for sources on this
machine. The storage load is a promise we hold; the transport count is a local
number; `authority: "self"` waits for nobody. Whether a *remote* authority will
ever reply is not decidable — a slow peer and an absent peer are
indistinguishable, which is a standing result in distributed systems rather
than something an API can fix.

The design stays sound because it only ever concludes `"empty"` from local
evidence. Giving up on a remote peer produces `waitOutcome: "offline"`, which
`planInitialization` takes as a separate input and never becomes a status:
`docStatus` still reads `"pending"`, truthfully, and the decision to act anyway
is visible at the point it is made.

This is also why `offlineAfter` applies to the peer wait and never to
hydration. `whenSettled` is two sequential steps — storage without a timeout,
then peers with one — so there is nowhere for a deadline on a disk read to be
introduced. A missing peer may genuinely never arrive, so abandoning that wait
is the only option; a slow disk is a local fault we can observe, and abandoning
it would mean writing defaults over data we merely failed to load. A failed
store read makes `whenSettled` reject rather than resolve.

### Why the cross-peer version of the race does not occur

A reader will ask: what stops a server that has a document on disk, but has not
opened it, from replying "I do not have this" and inviting the client to seed
over it? Two independent mechanisms.

First, a document with a store does not enter the sync graph until it has
hydrated — its `register` effect comes from the load's end (`finishLoad`), so a
server never announces a half-loaded document. That holds for a standalone
Runtime wrapped by an Exchange too: `setHooks` registers only documents that
have loaded, and one still loading registers when it finishes. See
[How a document becomes ready](#how-a-document-becomes-ready).

Second, the default disposition for an unrecognised document is `defer`, not
`vacant` (`exchange.ts`, the discovery handler): "NOT terminal, so no `vacant`
— the peer's interest stays live." A terminal `vacant` is sent only when the
replica type is genuinely unsupported.

The residual hazard is an application returning `Reject()` from its own
`resolve` callback for a document it does hold on disk. That peer will be told
the document is empty. Worth knowing, because `initialize` makes the
consequence larger than it used to be.

### Identify the authority by principal, not role

`PeerIdentityDetails.type` has three values, so `p => p.type === "service"` is
the tempting check. It is too loose for anything gating a write: the multi-peer
devtools inspector described in `PRODUCT.md` is itself an Exchange peer and
would very likely identify as a service. Prefer
`p => p.principal === "my-server"`. Not `peerId`: that is the server's seat,
which a store-less server changes on every restart, and which several server
processes over one store hold one each of.

### When a seed must be positional

`README.md` covers the law table that makes most seeds concurrency-safe without
configuration. When a seed genuinely must touch a positional or additive law in
a mesh topology, four options, cheapest first:

1. Declare an authority, even an intermittent one, with `offlineAfter` as the
   fallback.
2. Elect one at the call site from `exchange.peers` and pass it as
   `initialize`'s `authority` option — the reason a call-site override exists
   at all, since a policy fixed at construction could not express it.
3. Bind the document as serialized (`json.bind`), so the guard in
   `planInitialization` refuses client seeds outright.
4. Claim with an LWW register and let the winner do the positional part. This
   is timing-sensitive (the register has to converge before the winner is
   read), which is why it belongs here rather than in the README.

A future affordance worth recording rather than losing: `ExtractLaws<S>` is a
type-level law accumulator, so "is this seed concurrency-safe?" is in principle
a compile-time question. It is currently single-level and non-recursive, so a
real check would need work.

### `hydrated` vs `flush`

`hydrated(doc)` / `whenHydrated(doc)` is the storage gate. `exchange.flush()`
drains pending *writes* and only happens to await hydration as an
implementation detail — using it as a load gate tests a coincidence rather than
a contract.

`persisted(doc)` / `whenPersisted(doc)` is the other direction: whether the
store has confirmed every write this peer made. `exchange.flush()` waits for
the store to settle and then for the transports to drain, so it resolves after
the offers the store's confirmations released have gone out; a store that keeps
failing holds up neither.

The per-document hydration term is a different mechanism from the `Store.initialize?()`
lifecycle hook rejected in "Async-factory pattern" below. That hook was about
store *construction*; this is about one document's load completing, and it does
not gate the executor.

---

## Storage

Source: `src/store/*.ts`, `src/store/store-program.ts`, `src/exchange.ts` → store-program executor.

A `Store` is a persistence interface this package defines. A Runtime takes one (`ExchangeParams.store`, `RuntimeParams.store`), and an instance is owned by that Runtime, which calls it sequentially per document and writes under its `seat`. (How: see [One document's store calls, in order](#one-documents-store-calls-in-order).) Several instances may open one storage: tabs over one IndexedDB database, processes over one Postgres schema. See [Several instances over one storage](#several-instances-over-one-storage).

**`Store.seat`** is the identity the store issues its Runtime, taken when the store opens and released by `close()` or by the platform when the holder dies ([Durable seats](#durable-seats)). A **pooled** seat is fenced: `append`, `compact` and `delete` read the pool inside their own transaction and call `assertSeatHeld`, which throws `SeatLostError`, changing nothing, once another store has claimed the seat. A pooled store also records which seat writes each serialized document: an authored `append` or `compact` (`WriteOptions.authored`) claims an unclaimed one and is refused with `WriterRefusedError` for another seat's, checked after the fence, and `writerOf(docId)` reads the record ([Serialized documents](#serialized-documents-one-writer-seat-per-storage)). **A closed store refuses every operation.**

### One document's store calls, in order

Source: `src/store/serial-store.ts` → `serialStore`; `src/runtime.ts` → the constructor, `storeWrite`, `#quiesce`.

A Store need not finish one call before a later one starts: a pooled backend (Postgres, Prisma) may run them at once. The store program keeps one write in flight per document, but a destroy's `delete`, a load and a rebuild are issued outside it. Unordered, a `delete` could finish before a write already sent (a first write, meta and the whole document, then stores the destroyed document again), and a `get` after a `destroy` could load what the `delete` removes.

The Runtime therefore never holds the Store it is given: its constructor wraps it once in `serialStore`, which runs each document's calls one at a time, in the order they were made (different documents run at once). A failed call rejects its caller and does not stop the queue. A `loadAll` holds the queue for its whole iteration. `idle()` resolves when every queue is empty; `#quiesce` awaits it, so `flush` counts a delete as pending work, and `close()` awaits it too, so `shutdown` waits for deletes. Store backends order nothing themselves.

- **It cannot deadlock, by construction.** A queued step is one Store call, and a Store call never calls back into the Runtime, so no call waits for one queued after it. A queue of *operations* (`#hydrate`, `#persist`, `#compact` …) would deadlock the first time one operation ran another of the same document (`#persist`'s compact arm calls `#compact`), and avoiding that would be a rule kept by discipline.
- **Ordering calls, not operations, is enough**, for two reasons. Every write is one Store call: `storeWrite` takes a `Prepared` (`whole` by `compact`, `delta` by `append`, or `none`), so a write is never split around a `delete`. And every sequence of several reads checks the document's generation again before acting on what it read: the lifecycle program ignores a load whose instance is no longer current, `#compact` throws "document not held" after its read and before its write, and `#rebuild` stops at its read. A `delete` that runs between a read and the write depending on it is caught there.

### How a document becomes ready

Source: `src/lifecycle-program.ts` → `lifecycleProgram`, `finishLoad`; `src/runtime.ts` → `#step`, `#build`, `#execute`, `#hydrate`.

A document's lifecycle in the Runtime is one pure program, `lifecycleProgram: Program<LifecycleInput, LifecycleModel, LifecycleEffect>`. Its `update` answers every request a door makes and every completion it started (a load's, a release's, a leave's), in every phase, refusals included. The Runtime is its shell: it keeps the model, holds each instance's live objects (`Instance`: replica, ref, refusals, publication record, wiring, observers) by generation, and executes the effects. `lifecycle-program.test.ts` steps every input in every phase, and fails to compile when a phase or an input is added without a sample.

**Phases.** One entry per document id; absent is no entry.

| Phase | Means |
|---|---|
| `deferred` | A peer announced it; this Runtime holds nothing. |
| `loading` | Built, and loading from the store. Its `Intent` is `create` (`get`) or `open`, which records in `replaced` whether it replaced a deferred entry. |
| `ready` | Loaded, or had nothing to load. Records the writer the store recorded, and whether `onDocReady` has fired (`registered`). |
| `failed` | Its load failed. Held, never registered, its writes refused. |
| `unloading` | Leaving memory, its writes refused. Stage `storing`: waiting for the store to hold everything. Stage `leaving`: released and closed, leaving the sync graph. |
| `unloaded` | Out of memory, kept in the store. No instance and no generation; records the `BuildSpec` that loads it again, and whether it is suspended. |

Every held phase (`loading`, `ready`, `failed`, `unloading`: `isHeld`) records its generation, the `BuildSpec` that built its instance, and whether it is suspended. The spec says the tier (`spec.tier`) and the metadata (`metadataOfSpec`: replica type, sync mode, schema hash), so neither is stored twice. Suspension is a flag, not a phase: it says whether the document is in the sync graph, not which tier holds it, so it survives promotion and an unload. Instances a door replaced while they left the sync graph are `departing`, disposed at their `left`.

**Transitions.** Requests come from doors; completions from the loads the program started.

| Input | absent | deferred | loading | ready | failed | unloading | unloaded |
|---|---|---|---|---|---|---|---|
| `get`, `create` | build; load, or finish at once | the same | interpret: an `open` becomes `create`; replica: refuse `not-hydrated` | interpret: nothing; replica: promote | interpret: nothing; replica: refuse `load-failed` | `storing`: cancel, then as `ready`; `leaving`: as `unloaded` | build from the store, `suspended` carried |
| `get`, `open` | stored: build and load; otherwise nothing | the same, `replaced: "deferred"` | interpret: nothing; replica: refuse `not-hydrated` | as `create` | as `create` | as `create`, `replaced: "unloaded"` | as `create`, `replaced: "unloaded"` |
| `replicate` | build a replica; load, or finish at once | the same | refuse `already-held` | refuse `already-held` | refuse `already-held` | refuse `already-held` | replica: build from the store; interpret: refuse `already-held` |
| `defer` | `deferred` | nothing | nothing | nothing | nothing | nothing | nothing |
| `destroy` | delete from the store | delete from the store | close; delete if stored | close; delete if stored | close; delete if stored | close (unless closed); delete | delete from the store |
| `suspend`, `resume` | refuse `not-held` | refuse `not-held` | set the flag | set the flag | set the flag | refuse `unloading` | refuse `not-held` |
| `unload` | refuse `not-held` | refuse `not-held` | refuse `not-hydrated` | stored: `unloading`; otherwise refuse `not-stored` | refuse `load-failed` | nothing | nothing |
| `reload` | nothing | nothing | nothing | nothing | nothing | nothing | as `get`, `open`, from its own spec |
| `hooked` | — | — | registers when loaded | `register`, once | never registers | never registers | — |
| `close-all` | — | removed | close | close | close | close (unless closed) | removed |
| `loaded` | ignored | ignored | `finishLoad` | ignored | ignored | ignored | ignored |
| `load-failed` | ignored | ignored | `failed` | ignored | ignored | ignored | ignored |
| `released` | ignored | ignored | ignored | hand back (`hydrated`) | ignored | `storing`: close, then leave; never registered: close, dispose, `unloaded` | ignored |
| `left` | dispose a departing instance | the same | the same | the same | the same | `leaving`: dispose, `unloaded` | the same as absent |

"Close" in this table is `close` then `dispose`, except where an unload separates them: `released` closes, and `left` disposes. A schema that cannot read a held or unloaded document refuses `mismatch` (`planInterpretation`, see [`exchange.get`](#exchangeget--phase-in-action-out)). A completion whose generation is not current is ignored in every phase. `destroy` always ends with `onDocDestroyed`; `suspend` on a suspended document does nothing, and `resume` on one that is not refuses `not-suspended`. The unload's rows are explained in [Suspend, unload, destroy](#suspend-unload-destroy).

**A load's end** (`finishLoad`). One helper for every way a load ends, including having nothing to load (no store, a transient document, or a promotion whose replica already loaded). `#hydrate` only gathers: it reads the store and returns a `LoadOutcome`, `stored` with the version the store holds, `empty`, or `none`.

| outcome | `create` | `open` |
|---|---|---|
| `stored` | ready; `hydrated` to the store program | the same |
| `empty` | ready; `register` to the store program | closed, "not held here" |
| `none` | ready; nothing to tell | closed, "not held here" |

An `open` that found nothing closes and disposes its instance in the same step that puts back the deferred entry it replaced, or removes the entry: nothing was registered, written or announced. One that replaced an unloaded entry also emits `notify destroyed`, since the store no longer holds the document. See [`exchange.open`](#exchangeopen--get-never-creating). A document that is ready runs, in order:

1. `adopt` claims the peer identity (Yjs, Loro) and lifts plain's loading refusal. A serialized document whose stored writer is another seat of the storage is refused instead (its seat refusal is set, `#refuse`); see [Serialized documents: one writer seat per storage](#serialized-documents-one-writer-seat-per-storage).
2. `store` tells the store program what the store holds. `hydrated` and `register` each start a write, so this comes after `adopt`: the seat refusal is set before any write starts, and `#authored` never treats a document another seat writes as this seat's to claim.
3. `register` publishes the document to the sync graph (`onDocReady`), once an Exchange has set hooks. It carries `suspended`, and a suspended document registers without being announced. A cancelled unload registers by the same rule (`registration`).
4. `wire` (`#wire`) subscribes its local-update signal, which marks it dirty for the drain (see [The local-write path](#the-local-write-path)), and sends its changesets to the observation hook.

`adopt` and `wire` are an interpreted document's: a replica claims no identity and makes no writes of its own. A failed load is only recorded: its state is unknown, so the document is not registered, announced or given a stable identity.

**Generations.** Each instance (a create, a load, a promotion) is issued a generation from the model's `nextGen`, which is never reused. A completion carries the generation its load was started for, and `update` ignores one that is not current: a load that returns after its document was destroyed, created again, closed or promoted changes nothing. Every effect after the commit names the generation it acts on; the executor looks the instance up once and skips the effect if it is gone. `#compact` and `#rebuild` record the generation when they start to read, and stop if it changed. No method compares entries by identity.

**A step is a transaction** (`Runtime.#step`):

1. `update` computes the next model and the effects. Those that can fail (`refuse`, `build`) lead the list.
2. A refusal is returned, and nothing is committed.
3. Each `build` constructs its instance: the factory, `beginHydration` (to load into) or `upgradeReplica` (an empty replica, or the promoted one), the ref, refusals, publication record and local terms. A throw disposes what the step built and propagates: nothing is committed, and the generation is never used.
4. The model is committed, and the built instances join `#instances`. A promotion's build took the promoted replica, so that instance leaves without being disposed.
5. The remaining effects run in order. `interpreted` comes first, firing `onDocInterpreted`, so the network terms attach before the document can register.
6. The observers of each document whose observed values changed are told (below).

**Nothing between `update` and the commit calls out of the Runtime.** A build calls only constructors; `onDocInterpreted` is an effect after the commit. So no door can step in between, a failed `get` leaves nothing behind, and no generation is issued twice.

**The one limit: a promotion's build is transactional up to `upgradeReplica`'s take.** `createRef` needs the substrate, so it cannot run first. Every check that depends on the input runs before the take: the factory, the replica's origin (`upgrade` checks it before it takes), and the schema's fit, which `update` already decided. After the take only a bug can throw. Should one, nothing is committed, and the model records a ready replica over a closed one, whose every use throws `DocumentClosedError`: loud, not silent. Recovering would mean unloading the consumed instance, which needs the store to hold everything the replica held, and a failed build cannot assure that.

**Why synchronous, and why nesting is safe.** Both `@kyneta/machine` runtimes queue a re-entrant dispatch, and a door reached from inside an effect (`onDocReady` → `onEnsureDoc` → `get`) must return its ref. So the Runtime steps the program directly. A nested step runs against the committed model; an outer effect it made stale finds no instance under its generation and is skipped. A `get` returns the ref its own step built, so one whose document a nested step destroyed returns that closed ref, not nothing.

**Refusals are data.** `update` answers the facts, and each door decides what a refusal means. `get`, `open`, `replicate`, `suspend` and `resume` throw `refusalError(refusal)`, the one place a refusal becomes a message. `onEnsureDoc` and `registerSchema`'s sweep step the same requests (`Runtime.request`) and skip a refusal: "first writer wins" for a peer's announcement is the door's choice, not a row of the table.

**Observers belong to the instance; the phase belongs to the model.** Callbacks are not data. An instance's observers follow the values the model decides of it (`Observed`: its hydration, and its unloading refusal): `whenHydrated(docId)`, the hydration term's subscribers and the unloading refusal's. After a step's effects run, the shell compares each named document's `Observed` before and after, by value (`status`, and `error` and the refusal by identity), and tells the current instance's observers when it changed. So a subscriber hears `loaded` once the document is adopted, registered and wired: one that writes on the signal finds it writable, and its write leaves like any other. A step that only registers a document wakes nobody. `close` fixes the unloading refusal at its closing value, closes the hydration once (`closedHydration`: pending fails with the close error, an answer given stands), passes it to `closeTerms`, and tells every observer the same values, so `whenHydrated(ref)` and `whenHydrated(docId)` reject with one error object. An observer that re-read the model after a close would find the id absent, read "nothing to load", and resolve.

**The unloading refusal is derived from the phase.** The owner's refusal is `firstDefined(unloading, seat, network)`. `unloading` is a feed over the model: `DocumentClosedError("unloaded")` while `unloadingOf(model, docId, gen)`: the instance is current and `unloading`. An instance that stops being current is closed, and closing fixes its refusal at its closing value, which an unload keeps until the replica is disposed. The phase is the one record: a cancel changes it, and the refusal lifts with it, so there is no on/off pair of effects to keep matched.

`hydrated(docId)` reads the model: `true` for a ready document or one with nothing to load, `false` while it loads and after it failed, the same answer `hydrated(ref)` gives.

**A store in a format the replica cannot read is a failed read.** `#hydrate` compares the stored meta's `replicaType` with the replica factory's (`replicaTypesCompatible`) before loading any record. An incompatible store is treated like one that threw: it could not answer, and the load fails. Reading it anyway would misparse it — the case when plain's payloads gained their log positions and its replica type moved to `["plain", 2, 0]`.

**The store's confirmed version is read from the store.** Every stored entry records the version the store reached with it, and `hydrated` carries the join of the versions of the entries the replica reaches (`takeStoredEntries`'s `stored`). Not the last entry's: once several instances append to one stream, the last may be another's, concurrent with earlier ones. Not an entry the replica could not take in either: a plain version is one counter, and counting an entry past a gap claims positions the store does not hold, so the next own write there would be confirmed without being stored. It used to carry the replica's live version, which already includes anything written while the document loaded; every later `since` write then started past that write, and it was never stored. `hydrated` now owes a `since` write from the stored version: when nothing arrived during loading the executor finds the versions equal and touches no store.

**Loading does not depend on record order.** Records of several instances reach a loader in an order no single writer chose, and a compaction appends its whole document after records it did not delete. `takeStoredEntries` (`src/stored-entries.ts`, shared by hydration and compaction) therefore decides per entry, against a lineage to load toward:

- An entry of that lineage, or of genesis, which every lineage continues, is taken in. One the replica already reaches is skipped, so a whole document stored after newer entries never rolls the replica back. A whole document it does not reach is taken with `resetFromEntirety`; a delta with `merge`.
- A delta that does not continue what is loaded is held, and retried after each entry taken. Whatever is still held at the end is *untaken*, and warned about. CRDTs already hold operations whose dependencies are missing; this gives plain the same order-independence.
- An entry of a lineage the target supersedes is skipped as dead history, not untaken.
- An entry of a lineage that supersedes the target is untaken.

Hydration loads toward the latest stored lineage (`latestLineage`): nothing live is there to protect. A plain whole-document payload carries the log position it represents, so a reloaded plain document's version equals the store's; Yjs and Loro implement `resetFromEntirety` as a merge. A load with nothing new therefore writes nothing on every substrate, including after a compaction (`store-hydration.test.ts`, "a load with nothing new writes nothing"). `stored-entries.test.ts` loads the same entries in several orders on every backend.

**Writing before a document has loaded.** On a concurrent-writer substrate (Yjs, Loro) a write made during loading merges with the loaded history whenever it arrives, and is stored. A serialized-writer (plain) document with a store refuses authored writes until `adopt`: its merge does not commute with a local write, so the loaded state would overwrite the write, and the write would mint a lineage the store does not know. The write throws "still loading"; `await whenHydrated(doc)` first, or seed with `initialize`. After a failed load `adopt` never runs, and writes stay refused.

### `StoreRecord` and `StoreMeta`

```ts
type StoreMeta = Omit<DocMetadata, "supportedHashes">

type StoreRecord =
  | { readonly kind: "meta"; readonly meta: StoreMeta }
  | { readonly kind: "entry"; readonly payload: SubstratePayload; readonly version: string }

type StoreMark = number

interface Store {
  readonly seat: Seat  // SessionSeat | OwnedSeat | PooledSeat
  append(docId: DocId, record: StoreRecord, options: WriteOptions): Promise<void>
  loadAll(docId: DocId): AsyncIterable<StoreRecord>
  mark(docId: DocId): Promise<StoreMark | null>
  compact(docId: DocId, records: StoreRecord[], through: StoreMark | null, options: WriteOptions): Promise<void>
  delete(docId: DocId): Promise<void>
  writerOf(docId: DocId): Promise<PeerId | null>
  currentMeta(docId: DocId): Promise<StoreMeta | null>
  listDocIds(prefix?: string): AsyncIterable<DocId>
  close(): Promise<void>
}
```

The `StoreRecord` tagged union carries either document metadata (`"meta"`) or a substrate payload with its version tag (`"entry"`). Both record kinds flow through the same `append` / `loadAll` / `compact` pipeline, so metadata and state are always co-located and atomically durable.

`StoreMeta` is `Omit<DocMetadata, "supportedHashes">` — the subset of document metadata that the store persists. `supportedHashes` is runtime-derived from the schema binding and never stored.

### Several instances over one storage

A Runtime takes one store. Several instances may open one storage, and the contract (`src/store/store.ts`) says what that asks:

- **Interleaved appends each succeed.** A record's position comes from the storage, never from a counter one instance keeps: IndexedDB's autoincrement key; SQL's `MAX(seq) + 1`, read inside the write transaction (under a Postgres advisory lock per document; for Prisma, which has no portable lock, by trying again on a `(docId, seq)` violation, each of which means another writer committed).
- **Owned storages have one instance.** SQLite and LevelDB refuse a second open while one holds the storage, so their instance is the only writer: SQLite's `MAX(seq)` needs no lock, and LevelDB keeps its counter in memory.
- **Compaction removes only what its caller has read.** `mark(docId)` is the position of the document's last record; `compact(docId, records, through)` deletes the records at or before `through` and appends `records` after every record that remains, atomically. A compaction takes the mark, reads, takes everything it read into its replica, and deletes through the mark (see [The store-program](#the-store-program)). A record another instance appended after the mark survives; one before it was read and is now held. Two compactions through one mark both append after it, so neither deletes the other's output.
- **Readers do not depend on record order.** See [How a document becomes ready](#how-a-document-becomes-ready).

The conformance suite's seat section (`describeStore`'s `seats`, one declaration per backend: `pooled` with an `abandon`, `owned` or `session`) checks that every store issues the declared kind; that pooled seats are exclusive, reused, and fenced; that an owned storage reopens with the same seat and refuses a second open; that a closed store refuses every operation; for pooled backends, the writer record (an authored write claims, another seat's authored write and delete are refused and change nothing, unauthored writes succeed, and the writer seat taken again after its holder died may author); for owned and session backends, that no writer is recorded; and, for pooled and session backends, interleaved appends and compactions from two instances. `UNAUTHORED` and `AUTHORED` (`@kyneta/exchange/testing`) keep the suite's call sites short.

**A destroyed docId must not be reused.** `destroy` deletes the stored operations, but peers keep theirs, so a document recreated under the id would restart its clocks at 0 under an identity peers still hold. Nothing enforces this yet: `Line.destroy` followed by a new `Line` to the same seat reuses its document ids, so a tombstone needs a design for that case first.

Five production implementations exist:

- `@kyneta/leveldb-store` — server-side (LevelDB via `classic-level`).
- `@kyneta/indexeddb-store` — browser-side (IndexedDB).
- `@kyneta/sqlite-store` — universal SQLite (thin synchronous adapter; supports `better-sqlite3`, `bun:sqlite`, and is shaped to also fit Cloudflare DO `ctx.storage.sql` when a factory ships).
- `@kyneta/postgres-store` — async-native Postgres backend over `pg`.
- `@kyneta/prisma-store` — backend that takes a caller-supplied `PrismaClient`.

The three SQL-family backends share pure helpers (`toRow`, `fromRow`, `planAppend`, `planCompact`) via `@kyneta/sql-store-core` — preserving round-trip portability of a `StoreRecord` stream across SQL backends. The in-memory store in `src/store/in-memory-store.ts` is used for tests and browser-ephemeral cases.

For the conformance suite's fault-injection atomicity property, `@kyneta/exchange/testing` exports `makeArmedFault` — a shared op-weighted, deferred-arm write-fault primitive that a backend's `faultFactory` wraps around its write seam (LevelDB `put`/`batch` weighted by op count; the SQLite adapter's `exec`; a checked-out Postgres client's `query` via `fromClient`). Its `fired()` says whether the armed fault was reached, and the suite sweeps `n = 1, 2, …` until a write completes without reaching it, so every step of a write — the fence read included — is failed in turn on every backend, with no step numbers to keep in sync.

### Async-factory pattern for stores requiring async setup

`Store` instances handed to `Exchange` must be ready by construction, holding their seat — the `Store` members are all that the Exchange knows about; there is no lifecycle hook and no orchestration of readiness. Backends needing async setup (open a connection, validate a schema, probe connectivity) expose **async factory functions** returning `Promise<Store>`. The Exchange takes ready stores; readiness is a per-backend concern, surfacing curated errors at the right altitude.

A store is born holding its seat, so every backend whose open is asynchronous opens only through its factory: `createIndexedDBStore` / `IndexedDBStore.open` (opens the IDB database, allocates under Web Locks), `createPostgresStore` / `PostgresStore.open` (validates the schema via `information_schema.columns`, allocates on a dedicated connection), `createLevelDBStore` / `LevelDBStore.open`, `createPrismaStore` / `PrismaStore.open`. Their constructors are private. `SqliteStore` keeps a public constructor because SQLite is synchronous: it does its DDL and takes its seat in the constructor, and `createSqliteStore` exists for symmetry.

Earlier planning briefly considered adding a `Store.initialize?(): Promise<void>` lifecycle hook to the Exchange. Rejected: the Exchange's effect interpreter only handles writes; reads (`loadAll`, `currentMeta`, `listDocIds`) are called imperatively during hydration and bypass the executor entirely. Gating writes only leaves reads racing pre-init; gating both invasively introduces an `#initReady` mechanism whose purpose duplicates what an async factory already does cleanly. The honest factoring is "async factory, ready stores in." See the SQL-store-family plan's Learnings for the full reasoning.

### Shared store utilities

Patterns common to all store backends are extracted into shared utilities in `src/store/`:

- **`prefixSuccessor(prefix, order)`** (`src/store/store.ts`) — the upper bound of a prefix scan: the least string greater than every string starting with `prefix`, in the order the storage compares keys (`"code-point"` for UTF-8 bytes: Postgres under `COLLATE "C"`, SQLite's binary collation, LevelDB; `"code-unit"` for IndexedDB). `listDocIds(prefix)` scans `[prefix, prefixSuccessor(prefix, order))` on its key index. Every backend used to hand-write this, and most got it wrong: SQLite's `LIKE` ignored case, LevelDB's `prefix + "\xff"` (the bytes `C3 BF` in UTF-8) cut off ids continuing with any character from U+0100 on, IndexedDB's `prefix + "\uffff"` cut off a U+FFFF continuation, and Postgres depended on the database's collation. The store conformance suite now checks `listDocIds(prefix)` against `startsWith` over ids built to catch each of these.
- **`validateAppend`** (`src/store/store.ts`) — shared meta-first invariant guard. Validates that an `entry` record is not appended before a `meta` record exists, and resolves metadata for `meta` records via `resolveMetaFromBatch`. Used by `InMemoryStore`, `LevelDBStore`, and `SqliteStore`. The IndexedDB store has its own inline variant that calls `tx.abort()` before throwing.
- **`planStoreOpen`** (`src/store/store-open.ts`) — the one pure decision every backend's open makes, from one read of its store-wide metadata: the format (stamp, accept or refuse, through `decideStoreFormat`) and the seat (`session`, `owned` or `pooled` seating). The backend writes what it says in one step.
- **`parseSeatPool`, `allocateSeat`, `assertSeatHeld`, `sessionSeat`, `freshPeerIds`, `SeatLostError`** (`src/store/seats.ts`) — the seat pool, decoded totally; the oldest free seat or a fresh one, refusing a fresh id whose 53-bit peer number a seat shares; the fence check a pooled write runs in its transaction.

### The store-program

Persistence is driven by a pure Mealy machine: `Program<StoreInput, StoreModel, StoreEffect>` in `src/store/store-program.ts`. Like the session and sync programs, the store-program is a pure function; the Exchange constructor instantiates it via `createObservableProgram` and provides an executor that interprets effects as actual store I/O.

**Input vocabulary:**

| Input | Trigger |
|-------|---------|
| `register` | First boot — doc not found in any store during hydration |
| `hydrated` | Re-boot — doc loaded from a store; carries the version the store holds, and owes a `since` write from it |
| `state-advanced` | `Runtime.onStateAdvanced` — from the Runtime's local-change drain, or from the Synchronizer after a network import. Carries only the `docId`. |
| `compact` | `exchange.compact(docId)` called. Carries only the `docId`. |
| `destroy` | `exchange.destroy(docId)` called |
| `write-succeeded` | Store `.append()` or `.compact()` resolved successfully |
| `write-failed` | Store `.append()` or `.compact()` rejected |
| `writer-refused` | A write was refused: another seat of the storage writes the serialized document |
| `seat-lost` | A write found the store's seat claimed by another writer |
| `release` | `exchange.unload(docId)`: report `released` once the store holds all of the document. Carries the unload's generation |
| `keep` | An unload cancelled before its release |

**Effect vocabulary:**

| Effect | Executed by shell |
|--------|-------------------|
| `persist` | Cancels the document's retry timer, reads the replica, builds the records for its `write`, and writes them to the store (a compaction reads the store first) |
| `persisted` | The store holds the document at `version`. Opens the publish gate if the version reaches the document's own writes, and clears its recorded error ([Store-first](#store-first)). `#confirmed` takes the version from the effect, since the store program may no longer track the document by the time it runs (a release in the same transition) |
| `released` | The store holds all of the document, at `version`, and the program stopped tracking it. Steps the lifecycle's `released`, with the generation the `release` carried |
| `retry` | A write failed and none is owed. Starts a timer for `afterMs` that dispatches `state-advanced` |
| `persist-delete` | Cancels the retry timer, and calls `store.delete(docId)` on each registered store |
| `store-error` | Records a failed write's error for the document, and calls the `onStoreError` callback |

**Confirmation and retry are effects.** They run after the model updates, however the dispatch that caused them was nested, so the executor always reads the phase the transition produced. A `write-succeeded` dispatched from inside the store executor, as when a write finds nothing new, is queued behind the current dispatch, and a check placed straight after the call would read the phase before it.

**Composition with the Exchange.** Each cause of a write reaches the store program by one path. A local change comes from the Runtime's own drain (see [The local-write path](#the-local-write-path)), which calls `onStateAdvanced` directly. A network import comes through the Synchronizer: the Exchange constructor registers a listener via `synchronizer.onStateAdvanced(cb)`, which does *not* fire inline with the merge — it fires at quiescence, after the Synchronizer's `#drainStateAdvanced` method processes the dirty set. The full dispatch chain for an import:

1. A remote merge that changed the document causes the sync program to emit a `notify/state-advanced` notification carrying the affected `docId`s. A local change never does.
2. `#accumulateSyncNotification` adds each `docId` to a `Set<DocId>` (`#dirtyStateAdvanced`). The set deduplicates: multiple state advances for the same doc within a single dispatch cycle coalesce into one callback.
3. At quiescence, `#drainPending` calls `#drainStateAdvanced`, which snapshots the dirty set, clears it, and fires each registered listener once per doc.
4. The Exchange's listener forwards the `docId` to `Runtime.onStateAdvanced`, which dispatches `{ type: 'state-advanced', docId }` into the store-program and does nothing else.
5. The store-program decides which write, if any, to start, and emits a `persist` effect naming it. The Runtime's executor resolves the replica from the document's current instance, builds the records, calls the stores, and feeds back `write-succeeded` or `write-failed`.

**Transient documents are never offered to a store.** A document whose `SyncMode` carries `durability: "transient"` — today that is anything bound through `ephemeral` — is never registered, never hydrated, and never deleted. One predicate decides this, `storedOf(model, syncMode)` in the lifecycle program, and every storage decision consults it: which substrate to build, whether to hydrate on creation, whether to dispatch a delete on `destroy`, and, in the Runtime, whether the persistence term and the publish gate wait for the store.

Those decisions have to agree. A document built to hydrate is `loading` until its load completes, so a document that is set up to hydrate and then never does stays `pending` forever — `whenSettled` never returns and `docStatus` never leaves `pending`. That is why the rule is one predicate rather than a condition repeated at each site.

The rule is *declared*, read off the type, rather than emergent. Previously nothing told the store a document was transient: it simply could not persist updates, because the ephemeral substrate always returned `null` from `exportSince`. That kept later writes off disk by accident and did nothing about the creation-time write — and it would have reversed silently the day a transient substrate learned delta export. **That day came.** The substrate now produces deltas, the accident is gone, and the declared rule carried the behaviour across unchanged: `store-integration.test.ts` asserts the contract rather than the mechanism and did not need touching.

Two asymmetries in the same area, both deliberate:

- **`compact` needs no guard.** The store-program returns unchanged for a document it does not know, and a transient document is never registered, so it is never known. The safety is the store-program's rather than the runtime's.
- **The store-program's `destroy` case still emits `persist-delete` unconditionally**, where its `compact` case guards on `!existing`. Making them symmetric would break deleting a document that is on disk but was not opened this session — the contract `Exchange.destroy` advertises. The lifecycle's `destroy` row filters on the document's lifecycle instead, and treats "no entry" and "deferred" as "we do not know enough to skip".

**Per-doc phase tracking.** Each document tracked by the store-program is in one of three phases:

| Phase | Means |
|-------|-------|
| `unwritten` | The store has never acknowledged anything for this document. Reached when its first write failed. |
| `idle` | A version is confirmed, and named. Ready for the next write. |
| `writing` | I/O in flight, with a `revertTo` and at most one write `owed` after it. |

Both settled phases carry `failures`, the count of writes that have failed in a row, which sets the next retry's delay; a success clears it.

`unwritten` and `idle` are the two *settled* phases — nothing in flight — and `writing` carries one of them as `revertTo`: where to fall back if this write fails. Storing the fallback rather than deriving it is what keeps `writing` a single phase. The alternative, a separate status for "writing with nothing behind it", would fall silently out of every `status === "writing"` check, including the one that acknowledges a *successful* write — leaving the document mid-write forever and hanging every `flush()`.

`flush()` and `shutdown()` block on `allDocsSettled` — no document `writing`. An `unwritten` document satisfies it.

**The program holds no payloads.** It decides which write a document owes and from what base; the executor reads the replica when that write *starts*. A `persist` effect names one of three writes:

| `write` | Records | Store call |
|---|---|---|
| `register` | `meta` + the whole document | `compact` with no mark, which only appends |
| `since`, with the confirmed `version` | the delta since `version` | append |
| `compact` | `meta` + the whole document | `compact` through the mark it took |

**A compaction subsumes what it deletes** (`Runtime.#compact`):

1. Read the store's `mark`, then every entry.
2. Stop if the document is no longer the one held when the read began: nothing is merged into, or pushed from, a document that is gone. The write is reported failed, which the store program ignores for a document it no longer knows.
3. Take what was read into the live replica (`takeStoredEntries`), toward the replica's own lineage, or toward the latest stored lineage while the replica is still at genesis. Joining a lineage from genesis is not a crossing; moving a live replica to another lineage is, and is the network's to make, with `canReset` and the `lineage-collision` report ([Compaction and lineage boundaries](#compaction-and-lineage-boundaries)). Records other instances appended are now held here. A merge that moved the replica calls `onDocAdvanced`, so the Synchronizer pushes it: an instance that stored its writes and crashed before sending them leaves them reachable only through the store.
4. Prepare and write the whole document, deleting through the mark.

If the replica could not take everything in (an entry that does not continue, or one of a lineage that supersedes its own), deleting would lose it. The compaction then warns, deletes nothing, and writes what a `since` write would: the delta from the confirmed version, or with none the whole document with its meta. It succeeds and confirms as usual. It is not a failed write: under store-first a failed write sets `persistenceError` and schedules retries, and a stray record would then surface as a storage failure on every compaction while every append succeeds.

A request that arrives during `writing` is recorded as `owed` — `advance` or `compact`, with `compact` absorbing `advance` because a compaction writes everything an advance would. Any number of requests during one write collapse into one owed write, started in the same transition as the `write-succeeded` or `write-failed` that ends the first, so a document with a write owed is never observably settled and `flush()` cannot resolve in between.

This is what keeps records disjoint. A delta computed when the request *arrived* would start from the version confirmed before the write in flight, and so repeat every operation that write carries — a record per request, each as large as the write it queued behind. Computed when the owed write *starts*, it begins exactly where the store's confirmed state ends.

An `advance` on an `unwritten` document is a `register` — the whole document again, since there is no confirmed version to diff against. That includes an advance owed behind a first write that is still in flight: it becomes a `since` if that write lands and a `register` if it fails, and is never dropped.

**`null` from `exportSince` means "cannot serve"**, not "nothing". It happens when `since` is behind the replica's trimmed base: after a compaction trims history and then fails to write, the document falls back to a confirmed version the replica can no longer diff from. A current cursor gets an empty delta. So a `since` write first compares versions — equal means nothing to write, and the executor reports success at `version` without touching a store — and otherwise appends the delta, or the whole document when the delta cannot be computed.

**Self-healing version tracking.** The store-program's confirmed version only advances on `write-succeeded`. A failed write falls back to whatever the phase it started from was — carried on the `writing` phase as `revertTo`, decided when the write began by the code that knew which case it was in. Temporary store failures (disk full, `QuotaExceededError` on IndexedDB, a network blip on a remote store) therefore recover on the next write, without data loss, and the program asks for that write itself.

*Temporary* here means the failure, not the document. `durability: "transient"` is an unrelated property described above — a transient document never reaches a store at all, so none of this applies to it.

Recovery takes one of two shapes, and which one depends on whether anything was ever written:

| Failed write | Falls back to | Next write |
|---|---|---|
| incremental (`since`, `compact`) | `idle` at the last confirmed version | a `since` from that point, covering the failed write's changes |
| the document's first (`register`) | `unwritten` | a fresh `register` carrying the whole document |

The second exists because a delta is defined relative to a version the store acknowledged, and a first write has none. Without the distinction there is nothing to recompute from, and the document would stay unpersisted until the process restarted — which is what `version: ""` used to cause, by making "no confirmed version" indistinguishable from "a confirmed version" at the type level.

**A release waits until the store holds everything.** `release` records the unload's generation in `releasing`, and `keep` deletes it. After every transition one check (`releaseStored`) emits `released`, with the recorded generation and the confirmed version, for each releasing document whose phase is `storedEntirely`, and drops the document from `docs` and `releasing`. That one check is every path to a release: at once from `idle`, at the end of a write chain, and when a retry finally succeeds. `released` comes after the transition's own effects, so a write's `persisted` is acted on first. Only `idle` without `failures` is `storedEntirely`: `unwritten` holds nothing confirmed, a phase with failures has a retry scheduled, and a writing one has something in flight or owed. A `writer-refused` on a releasing document rebuilds as for any document, and the rebuild's `hydrated` lets the check release it; `destroy` drops the record; `seat-lost` is terminal and releases nothing, so the document stays in memory, unloading, and `persistenceError` reports the `SeatLostError`. The program only echoes the generation: the lifecycle tells a stale `released` by the rule it applies to every completion, and hands back one it does not take ([Suspend, unload, destroy](#suspend-unload-destroy)). `withDoc` keeps the rest of the model, so `releasing` survives every transition.

**A refused writer is not a failed write either.** A `WriterRefusedError` becomes `writer-refused`, which stops tracking the one document and asks the executor to `rebuild` it; see [Serialized documents: one writer seat per storage](#serialized-documents-one-writer-seat-per-storage).

**Losing the seat is not a failed write.** A `SeatLostError` becomes `seat-lost`, which makes the model terminal (`seatLost`): it tracks no document and answers every later input with nothing, so no write and no retry follows, and `flush()` and `shutdown()` resolve. It emits `store-error` once, and the executor cancels every retry timer. See [Durable seats](#durable-seats).

A failed write is retried. If a write is owed it starts at once and is the retry; otherwise the program emits `retry` with `retryDelay(failures)`: 250 ms, doubling with each failure in a row, up to 30 s. The Runtime keeps one timer per document, which dispatches `state-advanced` when it fires, and any write that starts cancels it. Under store-first a failed write stops the document syncing as well as persisting, so a retry that waited for the next mutation would leave an idle user's last write stranded on this peer. The bound is the backoff: one attempt per 30 s against a persistently failing store. A failed compaction is retried as an ordinary write (`state-advanced`), not as a compaction; compaction only saves space, so nothing is lost. A document waiting to retry is settled, so `flush()` and `shutdown()` do not wait on a failing store. Applications that want to act on failures have `onStoreError` and `persistenceError`.

### `onStoreError` callback

`ExchangeParams.onStoreError` is an optional callback invoked for any store operation failure. Signature: `(docId: DocId, operation: string, error: unknown) => void`. Default: `console.warn`. This allows applications to surface persistence failures to monitoring or user-facing error states; the store program retries failed writes itself. `persistenceError(doc)` reports the same failures per document. A `SeatLostError` is reported once, and `persistenceError` then reports it for every stored document, including those opened later; the application recovers by opening a new store (in a browser, by reloading).

### Unified persistence via `state-advanced`

Every local change and every remote `offer` merge drives the same persistence path, from its own drain. The pipeline (from drain to durable write):

1. The Runtime's local-change drain, or the Synchronizer's `#drainStateAdvanced` for a network import, names a `docId` whose state advanced.
2. `Runtime.onStateAdvanced(docId)` dispatches `{ type: 'state-advanced', docId }` into the store-program.
3. If no write is in flight, the store-program emits `persist` with a `since` write from the confirmed version; otherwise it records the advance as owed.
4. The executor reads the replica, computes `exportSince(confirmedVersion)`, and appends the record to the store.
5. On success it feeds `write-succeeded` back, which advances the confirmed version and starts any owed write from there.

Because each drain's dirty set coalesces multiple advances per doc, and the store-program collapses requests made during a write, a burst of edits produces at most one write in flight and one owed behind it, however long the burst.

### What `Store` is NOT

- **Not a sync primitive.** Stores do not announce themselves on `present`, receive `offer`, or emit `interest`. They are local to the exchange instance.
- **Not a cache.** Every record is durable on return.
- **Not reactive.** No `subscribe`; reactivity lives at the `Ref<S>` / `ReactiveMap` layer.
- **Not shared between Runtimes as an instance.** An instance is owned by one Runtime, which calls it sequentially per document and writes under its one seat. A *storage* may be shared, unless its seat is owned: open one instance over it per Runtime.

---

## `Capabilities`

Source: `src/capabilities.ts`.

The `Capabilities` registry maps `ReplicaKey` (`${name}:${major}:${syncMode}`) to `ReplicaEntry`:

```ts
interface ReplicaEntry {
  replica: BoundReplica              // the replica-only factory bundle
  schemas: Map<string /* schemaHash */, BoundSchema>   // interpreter-mode schemas
}
```

Registration happens in three places:

| Who | What | When |
|-----|------|------|
| Exchange constructor | `ExchangeParams.replicas`, `DEFAULT_REPLICAS` unless given (Loro/Yjs on the server tier, for instance), and `ExchangeParams.schemas` | Always |
| `exchange.registerSchema(bound)` | Auto-registers `bound.schemaHash → bound` | Any time; `exchange.get(docId, bound)` calls it on first use |

On incoming `present` for an unknown document, the sync program emits `ensure-doc`, and the Exchange's `onEnsureDoc` hook asks `Capabilities.resolveSchema(schemaHash, replicaType, syncMode)`. If found, the doc auto-resolves to `Interpret(bound)`. Otherwise the exchange consults `resolve`; a `Replicate()` answer is served by the registered replica factory for the document's replica type and sync mode (`Capabilities.resolveReplica`), the conduit tier. With no answer, a supported replica type is deferred, and an unsupported one is declared vacant ([Document classification on `present`](#document-classification-on-present)).

This is how a routing server with `DEFAULT_REPLICAS + loroReplicaFactory` and a `resolve` that answers `Replicate()` can relay Loro documents for any schema without ever *interpreting* one: all it needs is the replica factory, not the schema.

---

## `Line` — reliable message streams

Source: `src/line.ts`.

`Line` provides a reliable, ordered, bidirectional message stream between two specific peers. Under the hood it composes **two authoritative JSON documents** — one per direction — with an envelope schema that carries `seq`, `ack`, and `payload`. Ack-driven pruning keeps the documents bounded.

```ts
const chatLine = Line.protocol({
  topic: "chat",
  schema: ChatMessage,               // BoundSchema<S>
})

// Client: a Line is addressed by the remote seat, found by principal
const server = await whenPeer(exchange, p => p.principal === "server")
const sender = chatLine.sender(exchange, server.peerId)
const receiver = chatLine.claimReceiver(exchange, server.peerId)
sender.send({ text: "hello" })
for await (const msg of receiver) {
  console.log(msg)
}

// Server
const listener = chatLine.listen(exchange)
listener.onReceive((sender, receiver) => {
  ;(async () => {
    for await (const msg of receiver) {
      sender.send({ text: `echo: ${msg.text}` })
    }
  })()
})
```

Properties:

| Property | Mechanism |
|----------|-----------|
| Reliability | Built on authoritative docs — missed messages replay from the persisted log. Each outbox has one writer, the seat its id names, so two Exchanges for one principal (React StrictMode's double mount) write two outboxes. |
| Order | Monotone `seq` within a direction; reader consumes in `seq` order. |
| Bounded storage | Receiver's `ack` triggers sender's pruning of acked messages. |
| Multiple peers | Each peer-pair gets its own Line doc; `LineProtocol` creates + tears down as peers come and go. |
| Application payload | User supplies `send` / `recv` schemas. The envelope (`seq`, `ackSeq`, `ackLineage`, `nextSeq`) is this package's concern. |

**Addressed by seat.** Each outbox is written only by the seat its id names (`lineDocId(topic, from, to)`). Addressed by principal, a user's two tabs would share one outbox and the second could not send. Pass a `peerId`, never a principal.

**A `Line` to a stored peer survives its restart.** The peer returns with the same seat and resumes its documents from its store, so a client's `Line` carries on: nothing sent is lost or processed twice. A store-less peer is a new seat after a restart; clients find it with `whenPeer` and open new `Line`s, and anything in flight to the old seat is lost. So is one whose store issues session seats (Prisma).

One limitation, until a retention policy:

- **`Line` documents to a seat that never returns stay stored** on its peer, and every store-less session is a new seat. A server cannot observe a session seat's end: a crashed process, a killed tab and a sleeping laptop all look like silence. A leftover `Line` loses nothing and takes storage, so removing it is a retention policy, designed separately.

### `LineProtocol`: reified protocol objects

`Line.protocol(opts)` captures the `BoundSchema` pair + topic in one `LineProtocol` object. `sender()`, `claimReceiver()`, `manager()`, and `listen()` all use those same references, ensuring each doc is interpreted exactly once — building `Line` instances from raw schemas would produce distinct `BoundSchema` values with the same hash, causing reference-equality conflicts in `exchange.get`.

### What a `Line` is NOT

- **Not a socket.** The underlying transport is the exchange's sync channel; a `Line` rides above it.
- **Not a topic.** A `topic` is a routing hint inside a `LineProtocol`; a `Line` is an open connection to one specific peer.
- **Not a queue.** No broker. The pruning is based on the receiver's `ack`, not a central state.
- **Not broadcast-capable.** Each `Line` is peer-to-peer. Broadcast semantics should use standard doc sync.

---

## Undo stacks

Source: `src/undo/schema.ts`, `src/undo/undo-program.ts`, `src/undo/stack.ts`. Each substrate's undo (`Substrate.revertible`) is `@kyneta/schema`'s TECHNICAL.md § Undo; this is the stack over it.

```ts
const stack = await createUndoStack({ exchange, docId: "undo:tab-1", key: "cards", scope: id => id.startsWith("card:") })
stack.gesture(() => { batch(card, …); batch(places, …) })   // one step
stack.typing(() => batch(text, …))                          // joins the step before by the typing policy
await stack.undo()                                           // false when nothing stands
await stack.undo({ docs: ["card:x"] })                       // the newest step that wrote card:x
stack.top("undo", ["card:x"])                                // the step that undo tries first
```

- **A step is one gesture across documents**: a list of parts, one per commit, each a document id, what opens it again (schema hash, replica type, sync mode, resolved through the Exchange's Capabilities registry), the substrate's record in its codec, and the record's footprint, as the substrate stated it on the commit (`RevertibleCommit.footprint`, `@kyneta/schema` TECHNICAL.md § Undo). Undo reverts a step's parts last first, and pushes what that returned as the step to redo; a redo part keeps its undo part's footprint.
- **Scope is explicit.** The stack hears the local commits of every interpreted document in `scope`, but only inside `gesture`/`typing`, or on a document it `follow`s (an editor binding's direct writes, grouped by the typing policy). A commit anywhere else is someone else's write to rebase over. The stack's own document is never in scope. Capturing every revertible document would catch `Line` outboxes and the writes subscribers make in reaction, which react again to the undo.
- **Grouping is the stack's**, not a native manager's: time windows would merge distinct gestures, and a step across documents needs exactly one native step per gesture per document. The open step stays in memory and is written when another step starts, before an undo or redo, and when the typing gap elapses. A typing step never spans documents: `Edit.path` is a path inside one document, so the same path in another document is another text.
- **Steps conflict by what they write.** A step's region is its parts' footprints, per document (`regionOf`): a document, down to the record keys, `.json()` values and lists it wrote, or the whole of a plain document. Two steps whose regions do not overlap commute, so either may be undone or redone first; two that overlap must go in stack order. The stack reads only footprints, never a schema.
- **Undo by document.** `undo({ docs })` and `redo({ docs })` take the newest step that wrote any of `docs` and that no step after it in its list overlaps; without `docs`, the newest step, which nothing follows. So a step is never taken from under a newer one it conflicts with, and restricted to any one region the stack behaves as that region's own stack. `undo({ docs })` can be `false` while those documents have steps, and `top` agrees: undoing the blocking step, where it was made, frees it. A step taken is undone whole, its parts in other documents too. A plain document's footprint is the whole document, so its steps are taken strictly in order, as its substrate reverts them, and a step is never half undone because a plain part refused. `topStep` walks the list from its end, carrying the union of the regions passed, since overlapping a union is overlapping one of its steps. One stack per tab, with each editor passing its own document, then serves as one stack per document.
- **Redo is cleared by conflict, transitively.** Pushing a step clears the redo steps that build on it: each one that overlaps it, and each one redone after a cleared step that overlaps that step (`clearDependents`, which walks the redo list from the step redone first, carrying the union of what it cleared). The rest commute with everything cleared, so they stay, and an unfiltered `redo()` can redo a step after a new step elsewhere. Undo past an item's creation (its key in `index`, its text in `text:a`) and the typing in `text:a` made after it, then create another item: the new item writes another key and another text, so both redo steps stay. If the new step typed into `text:a`, it would clear the creation and, with it, the typing made on it, which would otherwise write text for an item that does not exist. A redo step dropped because nothing of it stands clears the same way; an undo step dropped clears nothing, since what it did is already gone.
- **`depth` bounds each list**, in every transition (`bounded`). Clearing by conflict keeps redo steps, so the two lists together can exceed `depth`, and a redo step for a document nobody writes again stays until `depth` trims it.
- **`top(direction, docs?)` is how an app reads what there is to undo**, typed as `Step`. The stored read is not (its replica type is `any[]`, its writer model a `string`), which is why `read()` casts once. `top` reads through refs, so a reactive thunk that calls it (`useSelector(() => stack.top("undo", [id]) !== undefined)`) is tracked. The undo document itself is not on the `UndoStack`.
- **The stack lives in a serialized document** (`UndoDoc`, `json.bind`), so the Store stores, syncs and compacts it, and the one-writer rule of [Serialized documents](#serialized-documents-one-writer-seat-per-storage) guarantees one runtime pops a stack: per tab or per device is only which document id the app gives it. Without a Store the stack lasts the session. Every transition is a pure function of the stored stack (`pushStep` and `moveStep`, each `bounded`, clearing through `clearDependents`; the lists are read through `listOf`, `touches` and `topStep`, over regions: `regionOf`, `regionUnion`, `regionsOverlap`), and is written as Kyneta ops: `stackOps(at, before, after)` takes each list's shortest edit (`diffSequence`) and replaces the note if it changed, and `applyChanges` writes them in one batch. So a write to the undo document is as large as what changed: pushing a step inserts that step, and a revert rewrites only the steps whose records its remap changed. The undo document is compacted every `COMPACT_EVERY` (200) writes, which bounds its log.
- **Every revert's remap rewrites the records left**, in the step being undone (`revertStep` from `@kyneta/schema`) and in both lists, in the same write that moves the step. Records always name live identities; nothing global is kept.
- **A step nothing of which still stands is dropped silently**, and the step `topStep` takes next for the same `docs` is tried.
- **A part stands only if its document is held here**: open, or in the Store. The stack opens a step's documents with `exchange.open`, never `get`, so an undo never creates a document, and a part whose document is not open when it is used (destroyed, here or by another runtime on the Store, before or during the undo) does not stand. No lifecycle event is needed: a stack names only documents its own runtime wrote, and with a Store those are all in it (own writes are stored before they are published); without one, the stack lasts the session. A destroyed document's parts stay in the stored stack until an undo meets them, bounded by `depth`, like any step that stopped standing. **Every part goes through the door, and stands only while its document accepts writes.** The stack opens each part's document with `exchange.open`, never by reading the Runtime's instance, so a held document is returned, an unload not yet released is cancelled, and an unloaded document is loaded again from the Store. When the part is used, it stands only if its document's `writeRefusal` is unset: a revert writes natively, below the refusal, so a document that refuses writes (unloading, closed, another seat's) must not be reached at all, and its part is skipped like a destroyed document's while the rest of the step reverts.

### Crash safety: the write-ahead note

Undoing a step writes a note first (the step, the direction, and each document's `revertible.position()`), waits until the undo document is stored (`whenPersisted`), then reverts every part and, in one write, moves the step and clears the note. A load that finds a note finishes it: each document that has authored anything since its noted position was reverted (nothing else authors between the note and the revert, and each CRDT's causality means its clock cannot pass the position without the revert's own op), so the part is taken from `revertible.recovered`; a document that has not is reverted now. No step is applied twice. If the user writes to a document during the store write, a crash then drops that step instead of reverting it: the safe direction.

### The program and its shell

The decisions are `undoProgram`, a pure program in the manner of the store program: grouping, depth, skipping, the order of an undo (`begin` → `note` → `revert` → `resolve`) and recovery, with effects as data. `stack.ts` executes them. Commits are heard inside their substrate's commit, where nothing may write, so they are queued and fed to the program once `gesture`/`typing` returns, or in a microtask for a followed document.

---

## Compaction and lineage boundaries

Source: `src/synchronizer.ts` → `#executeImportDocData`, `governance.ts` → `canReset`.

**Which replicas trim.** `advance(to)` follows one decision, `planAdvance` from `@kyneta/schema`: throw only for a `to` beyond the current version, trim for one between the base and the current version, and trim nothing otherwise. A relay's Yjs replica trims by re-projecting into a fresh `Y.Doc`, and only at its current version; a relay's Loro replica trims to a shallow snapshot at `to`; plain trims its log. A live Yjs or Loro substrate trims nothing: trimming means swapping the native document, and editor bindings and `unwrap` callers hold its types. So a live CRDT document's history stays in memory, and compaction still replaces its storage with the whole document.

**Two triggers, one path.** `#executeImportDocData` asks a single question of every inbound offer — *is this a reset, and if so which kind?* — via the pure, unit-tested `classifyResetTrigger(...)`, which returns `"none" | "lineage" | "compaction"`. Keeping the whole decision in one classifier is what lets the outcomes be tested directly; the branch it feeds sits in a private method that otherwise needs a full sync scenario to reach.

| Trigger | Fires for | Meaning |
|---|---|---|
| `"lineage"` | `json` only | **Identity** discontinuity — the sender authors a different `Version.lineage` than we do, and its lineage supersedes ours (`supersedes`: minted later). Typically a serialized writer that restarted with no persisted store and minted a fresh one. We reset to it. |
| `"stale-lineage"` | `json` only | The same discontinuity the other way: ours supersedes the sender's. Nothing is reset; the plan is `outrank`, and the sender is owed our whole document, to which it resets. |
| `"compaction"` | `json`, `loro`, `yjs` | **History** gap within one lineage — the sender trimmed past our version, so its `exportSince()` fell back to a whole-state image. |

The lineage triggers require a REAL lineage on *both* sides; `DEFAULT_LINEAGE` is excluded as the normal lazy-mint/first-sync path, already handled by `merge()`. It fires independent of `payload.kind`, which is what lets it catch an identity discontinuity even when the offending offer carries a `"since"` payload. Only `PlainVersion` ever mints a real lineage — `LoroVersion`, `YjsVersion` and `StateVersion` all report `DEFAULT_LINEAGE` — so in practice this trigger belongs to `json`.

The compaction trigger is the *only* signal for a same-lineage history gap, since there is no lineage mismatch to find. It requires a whole-state image from a peer already marked synced: a first entirety is just initial sync. **History-free documents are excluded from it entirely** (`ReplicaFactoryLike.historyFree`) — the heuristic presumes a sender that can trim history, and such a format keeps no trimmable log: it carries its whole meaning in its state, so every cursor stays serviceable and there is no compaction to detect. The exclusion used to test `durability === "transient"`, which is a different axis (whether a document is stored) that happened to coincide for the four built-in bindings.

Those two facts compose into an invariant worth stating plainly, because it is what makes item 1 below safe: **a history-free document reaches neither trigger.** `historyFree` excludes it from compaction, and `StateVersion` reporting `DEFAULT_LINEAGE` excludes it from lineage. The two halves are pinned in `reset-trigger.test.ts` and `@kyneta/schema`'s `ephemeral-lattice.test.ts` respectively.

Both triggers converge on the same `offer { payload: { kind: "entirety" | "since" } }` handling, gated by the same `canReset` policy: when the receiver encounters a boundary for a doc that already has local state, two things can happen:

1. **Accept the reset.** Discard local state, adopt the incoming entirety/lineage. For interpret-mode substrates, this calls `Substrate.resetFromEntirety(payload, options)` (the payload says everything the replica takes on, its version included) — a dedicated method, decoupled from the routine `merge()` path (which now assumes shared causal ancestry and never adopts across lineages on its own). For replicate-mode substrates (headless replicas), `ReplicaFactory.fromEntirety()` rebuilds the whole replica. The Synchronizer asks the Runtime to do it (`rebuildReplica`), because the Runtime owns the document's `DocReadyInfo`: the rebuilt replica replaces the one in that record, which the Synchronizer, the store executor and promotion all read, so a relay persists and promotes what it rebuilt.

   Rebuilding rather than merging is correct for **both** triggers, for the same underlying reason: the incoming image is not a continuation of what we hold. Under `"compaction"` the sender genuinely rewrote its history — `LoroReplica.advance()` exports a `mode: "shallow-snapshot"` and rebuilds via `LoroDoc.fromSnapshot`, and `YjsReplica.advance()` re-projects into a fresh `Y.Doc` because Yjs has no trim primitive at all — so merging keeps local ops whose causal anchors the image no longer carries. Under `"lineage"` there is no shared ancestry to reconcile against in the first place.

   This is only safe because the branch is unreachable for a history-free document, per the invariant above. For a field-level LWW merge, rebuilding *would* be wrong: it drops concurrent field writes the sender has not seen. Note also that `ReplicaLike.resetFromEntirety` exists and three of its four implementations delegate to `merge()` — but those are scoped to the lineage trigger, which never fires for Loro or Yjs. Pointing the replicate arm at them would route the compaction trigger into a merge and reintroduce the dangling-anchor hazard. A rebuilt plain replica starts at the sender's log position, because a plain whole-document payload carries it.
2. **Reject the reset.** Keep local state. Sync will diverge from peers that compacted.

`Policy.canReset(docId, peer)` is the gate. It defaults to `true` (accept) for all sync modes. Applications that need to reject resets for specific docs or peers register a `canReset` policy. `outrank` does not ask it: nothing of ours is discarded.

**Every lineage crossing is reported.** `sync/doc-imported` carries `crossing: { local, remote, response }`, with `response` one of `adopted` (a reset), `asking` (a delta, which no reset can take), `outranking` or `refused` (`canReset` vetoed). `handleDocImported` holds the policy in one place: it emits a `lineage-collision` diagnostic, severity `error`, for every crossing, then:

- `adopted`: as any held offer;
- `asking`: an interest that quotes no `since`, and `theirVersionWeHold` for the sender is cleared. Any cursor of the sender's we hold is from before the crossing, and a genesis one, the usual after an empty first sync, is served with a delta from the start of the sender's log, which we cannot take either; asking with it looped forever. With no cursor the interest states only our version, of another lineage, which the sender cannot serve, so it answers with its entirety;
- `outranking`: the sender's baseline is cleared, it is owed our whole document (`offerOwed: { since: undefined }`), and `send-offers` sends it, through the store-first gate like any other offer;
- `refused`: nothing more. Asking again would draw the same lineage, refused again.

A refused *compaction* reset crosses no lineage and stays silent, for the same reason. While a peer holding the earlier lineage vetoes resets, each of its pushes draws another whole document and another diagnostic; that is bounded by its writes, the divergence is the one the application chose, and the diagnostic is not deduplicated.

For durability guarantees, use the `cohort` predicate to prevent compaction past critical peers — this is strictly better than receiver-side rejection, which causes permanent divergence with no built-in reconciliation path. The cohort prevents the situation from arising: `Exchange.leastCommonVersion(docId)` computes the LCV over cohort members only, so `compact()` never advances past a cohort member's confirmed version. The default cohort (no policy) includes all synced peers, preserving backward compatibility. The cohort predicate does not help with the lineage-mismatch trigger — a writer restart with no persisted store is an identity discontinuity, not a version the cohort could have been ahead of.

**Plain lineage vectors (jj:kxswmuzx).** `PlainVersion` is a single-entry version vector with genesis (`DEFAULT_LINEAGE`) as the empty vector ⊥, so a **fresh peer joining an incumbent is a VV subset (`behind`) and syncs via the ordinary `merge()` path — not a reset** (a replay of the log from genesis while it is untrimmed, the whole document once compaction has moved the base past genesis, and either way it ends at the sender's position), and two independently-created fresh peers are `equal` (no false lineage rivalry). The lineage triggers therefore fire only for a genuine identity discontinuity between two *authored* REAL lineages.

**Crossing goes toward the later lineage, on every peer.** Two lineages meet when a serialized writer restarts without its store and mints a fresh one, or when two writers author one document. The reset used to go receiver→sender unconditionally, and since each peer receives the other's lineage, both reset and the replicas swapped: the restarted writer ended with the old state and the server with the new, for good. Now every peer crosses toward the lineage `supersedes` names, the one minted later, so all of them converge on it. For the restart that is the fresh lineage, as intended. The case against a version-intrinsic winner assumed a counter, which a no-store restart forgets; a mint time is read from the clock and survives it. The cost is clock skew: a restarted writer whose clock is behind the lineage it replaces loses to it. Two writers authoring one document are still misuse of the single-writer model (`writerModel: "serialized"`): they now converge on the later writer, the other's writes are gone, and every peer that meets both reports a `lineage-collision` error rather than swapping silently. `canReset` remains the per-peer permission veto.

### What an lineage boundary is NOT

- **Not a protocol message.** There is no `reset` opcode. The decision is derived from an explicit `Version.lineage` comparison and/or `offer { payload: { kind: "entirety" } }` + existing local state.
- **Not inferred from payload shape alone.** The lineage is an explicit property of the payload and the version — the receiver compares lineages directly, independent of whether the payload happens to be an entirety or a since-delta.
- **Not a synchronization point.** Accepting a reset discards ops that haven't made it to peers; those peers will see the reset when they next sync.
- **Not a rollback.** Local state is replaced, not reverted; there is no undo.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `Exchange` | `src/exchange.ts` | Public façade. Constructor, `get`, `open`, `replicate`, `destroy`, `suspend`, `resume`, `unload`, `addTransport`, `removeTransport`, `peers`, `documents`, `registerSchema`, `register`. |
| `ExchangeParams` | `src/exchange.ts` | Constructor options: `principal`, `type`, `transports`, `store`, `schemas`, `replicas`, `departureTimeout`, the local concerns (`lease`, `tickInterval`, `onStoreError`), and one initial `Policy` (`resolve`, `canShare`, `canAccept`, …). |
| `PeerNaming` | `src/exchange.ts` | `{ principal, type? }`: who an Exchange says it is. Its seat comes from the Runtime. |
| `Disposition` | `src/exchange.ts` | `Interpret \| Replicate \| Defer \| Reject`. |
| `Synchronizer` | `src/synchronizer.ts` | Shell class. Public only for `@kyneta/react`'s internal use; applications never construct one. |
| `DocReadyInfo` | `src/runtime.ts` | The one record of a registered document, owned by the Runtime and read by the Synchronizer. |
| `Instance` | `src/runtime.ts` | One generation's live objects. `Runtime.instanceOf(docId)` returns the current one. Not exported from the package. |
| `lifecycleProgram` / `LifecycleModel` / `LifecycleInput` / `LifecycleEffect` / `Lifecycle` / `Refusal` | `src/lifecycle-program.ts` | Lifecycle-program state + algebra. `Runtime.lifecycleOf(docId)` returns a document's `Lifecycle`. |
| `SessionModel` / `SessionInput` / `SessionEffect` | `src/session-program.ts` | Session-program state + algebra. |
| `createSessionUpdate` | `src/session-program.ts` | Makes the pure `(input, model) → [model, ...effects]` from its predicates. |
| `SyncModel` / `SyncInput` / `SyncEffect` / `DocEntry` / `SyncPeerState` / `PeerDocSyncState` | `src/sync-program.ts` | Sync-program state + algebra. |
| `createSyncUpdate` | `src/sync-program.ts` | Makes the pure `(input, model) → [model, ...effects]` from `canShare`, `canAccept` and `servesUnloaded`. |
| `planLeave` | `src/sync-program.ts` | Pure: how our document leaves the sync graph, for `suspend`, `unload` or `destroy`. |
| `Policy` / `GatePredicate` / `EpochBoundaryPredicate` | `src/governance.ts` | Policy interface and predicate shapes. |
| `Governance` / `composeGate` | `src/governance.ts` | Composer class + pure composition function. |
| `Capabilities` / `ReplicaKey` / `DEFAULT_REPLICAS` / `createCapabilities` | `src/capabilities.ts` | Replica + schema registry. |
| `Line` / `LineProtocol` / `createLineDocSchema` | `src/line.ts` | Reliable message-stream primitive. |
| `whenPeer` | `src/when-peer.ts` | Resolves with the first peer in `exchange.peers` matching a predicate. |
| `Store` / `StoreRecord` / `StoreMeta` / `DocMetadata` | `src/store/store.ts` | Persistence interface. |
| `validateAppend` | `src/store/store.ts` | Shared meta-first invariant guard for `append` implementations. |
| `PeerChange` / `DocChange` / `DocInfo` / `PeerState` / `PeerSyncState` / `PeerDocSyncState` / `Connectivity` | `src/types.ts` | Reactive-collection change types and snapshot shapes. |
| `sync(doc)` | `src/sync.ts` | Helper: returns `SyncRef` (`peerStates`, `ready`, `readyFor`, `connectivity`, `onPeerSyncChange`). |
| `AsyncQueue` | `src/async-queue.ts` | Bounded async producer/consumer queue used inside `Line`. |

## File Map

| File | Role |
|------|------|
| `src/index.ts` | Public barrel. Re-exports `bind` / `json` / `ephemeral` / `SyncMode` / `SYNC_COLLABORATIVE` / `SYNC_AUTHORITATIVE` / `SYNC_EPHEMERAL` / `requiresBidirectionalSync` from `@kyneta/schema`; exports exchange-specific types. |
| `src/exchange.ts` | `Exchange` class, `ExchangeParams`, disposition types, the deferred policy (`#deferredMismatch`), principal validation, `registerSchema`, `register`, reactive-collection wiring. |
| `src/runtime.ts` | `Runtime`, the local shell: `#step` (a lifecycle step as a transaction), `#build`, the effect executors (`#execute`, `#close`, `#dispose`), `Instance` and its observers, the derived unloading refusal, `refusalError`, `#hydrate`, the store program's executor, the publish gate, the tick clock. |
| `src/lifecycle-program.ts` | Pure lifecycle program: `Lifecycle`, `LifecycleModel`, `LifecycleInput`, `LifecycleEffect`, `Refusal`, `Intent`, `BuildSpec`, `finishLoad`, the unload's rows (`unload`, `released`, `left`, `cancel`, `loadAgain`), and the queries (`isHeld`, `phaseOf`, `currentGen`, `hydrationOf`, `deferredIds`, `storedOf`, `metadataOfSpec`, `unloadingOf`, which the Runtime asks too). |
| `src/synchronizer.ts` | Shell. Dispatch queue, registered-document map, effect interpreter, emit methods (`#emitPeerSyncChanges`, `#emitStateAdvanced`, `#emitDocEvents`, `#emitPeerEvents`), `declareVacant` / `hasReconciled` / `reconciledMatching` / `connectivity` / `awaitReconciliation`, transport + storage integration. |
| `src/session-program.ts` | Pure session program: `SessionModel`, inputs, effects, `createSessionUpdate`, transition collapse. |
| `src/sync-program.ts` | Pure sync program: `SyncModel`, `DocEntry`, inputs, effects, `createSyncUpdate`, per-message handlers, and `planLeave`, how our document leaves the sync graph. |
| `src/governance.ts` | `Policy`, `GatePredicate`, `EpochBoundaryPredicate`, `Governance`, `composeGate`. |
| `src/capabilities.ts` | `Capabilities`, `ReplicaKey`, `ReplicaEntry`, `DEFAULT_REPLICAS`, `createCapabilities`. |
| `src/line.ts` | `Line`, `LineProtocol`, envelope schema, ack-based pruning. |
| `src/async-queue.ts` | Bounded async queue used by `Line`. |
| `src/when-peer.ts` | `whenPeer`: find a peer's seat by predicate. |
| `src/undo/schema.ts` | `UndoSchema`, `UndoDoc`: the document an undo stack lives in; `Part`, `Step`, `Note`. |
| `src/undo/undo-program.ts` | `undoProgram`: an undo stack's decisions, pure. |
| `src/undo/stack.ts` | `createUndoStack`: the shell; `pushStep` and `moveStep`, the stack's transitions, each kept to `depth` by `bounded`, clearing what builds on a step through `clearDependents`; `topStep`, the step a request takes, the newest that nothing after it overlaps; the regions both read (`regionOf`); and `stackOps`, the ops that write one. |
| `src/interpret.ts` | Pure phase classifier: `DocPhase`, `LoadStatus`, `InterpretAction`, `planInterpretation`. The rule the lifecycle program's `get` row consults, for every door, and the Exchange's deferred policy. |
| `src/sync.ts` | `sync(doc)`, `whenSettled`, and `liveSync`, a document's live sync handle and `SyncSource`. |
| `src/document-terms.ts` | `DocumentTerms`, the one per-document record: `documentKey`, `termsOf`, `registerLocalTerms`, `registerNetworkTerms`, and closing (`snapshotOf`, `closedHydration`, `closedTerms`, `closeTerms`). |
| `src/settle.ts` | `settled`, `settledFeed`, `settledWith`, `hydrated`, `hydratedFeed`, `hydrationError`, `whenHydrated`. |
| `src/persistence.ts` | `persisted`, `persistedFeed`, `persistenceError`, `whenPersisted`, `writeRefusal`, `writeRefusalFeed`. |
| `src/doc-meta.ts` | `docSyncMode`, `writerModelOf`, `authorityFor`. |
| `src/types.ts` | `DocChange`, `DocInfo`, `PeerChange`, `PeerDocSyncState`, `PeerState`, `PeerSyncState`, `Connectivity`. |
| `src/observe.ts` | DevTools observation protocol (`ObsEvent`), bus (`createObservationBus`), and pure effect/msg/changeset/frame mappers. Experimental. |
| `src/utils.ts` | `validatePrincipal`. |
| `src/store/` | `Store` interface, in-memory implementation, the store program, shared utilities (`validateAppend` in `store.ts`), seats and the seat pool (`seats.ts`), the open plan every backend runs (`store-open.ts`), and `serialStore`, which orders one document's calls (`serial-store.ts`). |
| `src/transport/` | Transport-manager glue. |
| `src/testing/` | Test-only helpers exported from `@kyneta/exchange/testing`. |
| `src/__tests__/` | Full dispatch-loop, governance, capabilities, line, seats, storage, compaction, classification, and end-to-end tests. |

## Observation bus (experimental)

Source: `src/observe.ts`, `src/synchronizer.ts`. DevTools observability is a
**tee on the effect/message stream**, not publish calls scattered through the
shell. The Synchronizer already routes everything through pure data seams — the
two program executors (`#executeSessionEffect`/`#executeSyncEffect`) and the
outer coordinator's `route` branch — so observation is *another interpreter of
that data stream*. `src/observe.ts` holds the protocol (`ObsEvent` + bodies),
the bus (`createObservationBus`), and **pure** mappers
(`observeSessionEffect`/`observeSyncEffect`/`observeInput`/`summarizeChangeset`/
`frameTraceToBody`) that are unit-tested with effect/msg literals — no Exchange.

`exchange.observe(sink)` (→ `synchronizer.observe`) streams a correlated
`ObsEvent` across six layers:

| Layer | Source seam |
|-------|-------------|
| `engine` | both handles' `subscribeToTransitions` (coalesced; `from !== to`) |
| `protocol` | OUT = `send`/`send-to-peer(s)`/`send-offers` effects (one observation per recipient, with its own baseline); IN = the `route` input tap |
| `directory` | `emit-peer-events`/`emit-doc-events` effects, plus the authoritative per-peer-doc **`sync-state`** event teed in `#emitPeerSyncChanges` (`observePeerSyncState`) — the reconciliation result a consumer must not re-derive (jj:pusmrzuy) |
| `doc` | the Runtime's changeset subscription on every interpreted document, through the `onDocChangeset` hook (local and replay alike, so auto-resolved docs are covered) |
| `diagnostic` | the unified `diagnostic` effect (both programs) carrying a structured `Diagnostic` — see below |
| `wire` | `TransportContext.onFrame` ← each transport's `Pipeline.onFrame`/`FrameTrace` (carries `frameSeq`, a per-(channel,direction) trace id — deliberately *not* the envelope's monotonic `seq`, and not a sound cross-peer key; the cross-peer key is the reserved `Frame.hash`) |

Invariants: **zero cost when unobserved** (every tee call site is guarded by
`bus.enabled` before any mapper runs); **fire-and-forget** — the bus swallows
sink errors and never calls `dispatch`, so it is a passive side-output, never a
Mealy effect and never inside the shared `Lease` budget (mirrors
`@kyneta/machine`'s `notifyTransition`). `ObsEvent` is experimental (`v: 1`).

The `diagnostic` body aliases the producer-side `Diagnostic` discriminated union
(`src/types.ts`, jj:nztkqwpm): `DiagnosticBody = { layer: "diagnostic"; kind:
"diagnostic" } & Diagnostic`, keyed on `code` with `severity`/`message`/`peer`
and per-variant `local`/`remote` + `docId` — so a renderer can attribute, group,
and severity-gate diagnostics without parsing the message string. Aliasing (not
re-declaring) is sound because `PeerId`/`DocId` are plain `string`; the spine
guard still holds (`Diagnostic` declares `peer`, never the envelope's `peerId`).

`exchange.docHistory(docId)` is the orthogonal **pull** surface: it reads the
optional `DEVTOOLS_HISTORY` capability (`@kyneta/schema`) off the doc's
substrate — Loro implements it deeply (version/op summary + `fork()`-based
`valueAt` time-travel), Yjs gives a summary, plain returns `undefined`.

Product rationale (why a bus, why renderers are deferred): `PRODUCT.md`.

## Testing

Tests use real `BridgeTransport` pairs from `@kyneta/bridge-transport` for multi-peer scenarios and in-memory stores for persistence, and a `ScriptedPeer` (`__tests__/scripted-peer.ts`) where a test must send or observe exactly what crosses the wire. Stores are wrapped rather than mocked (`__tests__/wrap-store.ts`: `gated` holds or fails a store method). Per-test exchanges come from `exchangesPerTest()` (`__tests__/exchanges.ts`), which shuts each down after its test.

The pure programs are tested as tables, with no shell: `lifecycle-program.test.ts` steps every input in every lifecycle phase, and fails to compile when a phase or an input lacks a sample; `sync-program.test.ts` and `store/__tests__/store-program.test.ts` do the same for their programs. `unload.test.ts` and `unload-sync.test.ts` run an unload end to end: its three moments, the doors in each window, and its order against store-first, over a bridge and a hub.

The `line-*.test.ts` files cover relay topology, hub-and-spoke and one-way flow, validating that `Line`'s durability surface works end-to-end through real transports.

**Run tests**: `cd packages/exchange && pnpm exec vitest run`

Cross-package integration tests live in `tests/integration/` (workspace
package `@kyneta/test-integration`, private). Files in that suite use
`.node.test.ts` (vitest) or `.bun.test.ts` (bun test) suffixes to declare
their runtime contract; `verify.config.ts` runs both runners as parallel
children of one `logic` task. Today's coverage: WebSocket sync (Node and
Bun) and SQLite-backed sync + restart over WebSocket (Node only).