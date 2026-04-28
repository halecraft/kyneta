# @kyneta/exchange — Technical Reference

> **Package**: `@kyneta/exchange`
> **Role**: Substrate-agnostic document sync runtime. Orchestrates channel topology, document convergence, and persistence above any transport and any `@kyneta/schema` substrate — via two pure TEA programs (session + sync), a Synchronizer shell that owns the serialized dispatch queue, and an Exchange façade that adds storage, governance, capability negotiation, and reactive peer/document collections.
> **Depends on**: `@kyneta/schema` (peer), `@kyneta/changefeed` (peer), `@kyneta/transport` (direct)
> **Depended on by**: `@kyneta/react` (peer), `@kyneta/leveldb-store`, `@kyneta/indexeddb-store`, application code, every transport package (dev)
> **Canonical symbols**: `Exchange`, `ExchangeParams`, `Synchronizer`, `DocRuntime`, `SessionModel`, `SessionInput`, `SessionEffect`, `SyncModel`, `SyncInput`, `SyncEffect`, `updateSession`, `updateSync`, `Governance`, `Policy`, `composeGate`, `GatePredicate`, `EpochBoundaryPredicate`, `Line`, `LineProtocol`, `Capabilities`, `ReplicaKey`, `DEFAULT_REPLICAS`, `Interpret`, `Replicate`, `Defer`, `Reject`, `Disposition`, `PeerIdentityInput`, `PeerChange`, `DocChange`, `DocInfo`, `PeerState`, `ReadyState`, `PeerDocSyncState`, `Store`, `StoreRecord`, `StoreMeta`, `DocMetadata`, `persistentPeerId`, `releasePeerId`, `resolveLease`, `LeaseState`, `sync` (helper), `SyncProtocol`, `SYNC_COLLABORATIVE`, `SYNC_AUTHORITATIVE`, `SYNC_EPHEMERAL`, `requiresBidirectionalSync`, `BindingTarget`, `createBindingTarget`
> **Key invariant(s)**:
> 1. The exchange never inspects `SubstratePayload` contents. Payloads are opaque blobs carried by `offer` messages; only the substrate produces and consumes them.
> 2. The session program never sees documents. The sync program never sees channels, transports, or connection state. They share a single dispatch queue and communicate exclusively through `sync-event` effects the shell forwards.
> 3. Every reactive output — `exchange.peers`, `exchange.documents`, per-doc ready state — drains at quiescence in snapshot-then-clear order.

A document-sync runtime for arbitrary substrates. Hands back an `Exchange` instance that accepts a schema binding (`Todo = loro.bind(...)`), returns typed document refs (`exchange.get("doc1", Todo)`), routes their changes over any registered transport, and exposes `ReactiveMap`s of peers and documents for observation.

Imported by applications to construct the top-level sync graph; by `@kyneta/react` to bind refs into hooks; by `@kyneta/leveldb-store` to implement persistence. Internally consumes `@kyneta/transport` for transport abstractions and message vocabulary, and `@kyneta/schema` for substrate/replica contracts.

---

## Questions this document answers

- What is the difference between session and sync, and why are they split? → [Two programs, one shell](#two-programs-one-shell)
- How does a local mutation become a wire `offer`? → [The local-write path](#the-local-write-path)
- What does `exchange.get(docId, bound)` actually do? → [`exchange.get` — the four-case classifier](#exchangeget--the-four-case-classifier)
- What does the `resolve` callback decide? → [Document classification on `present`](#document-classification-on-present)
- How do departure and reconnection interact? → [Departure, grace, reconnection](#departure-grace-reconnection)
- How does the exchange hand merge decisions back to the application? → [`Policy` and `Governance`](#policy-and-governance)
- What is a `Line` and when should I use it? → [`Line` — reliable message streams](#line--reliable-message-streams)
- How does compaction interact with sync? → [Compaction and epoch boundaries](#compaction-and-epoch-boundaries)
- What does `peerId` continuity buy me? → [Peer-ID continuity](#peer-id-continuity)
- How do reactive `peers` / `documents` collections behave? → [Reactive collections](#reactive-collections)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `Exchange` | The top-level class. One per participant. Owns transports, stores, governance, capabilities, the `Synchronizer`, and the `ReactiveMap`s of peers/documents. | A message bus, a pub-sub hub, a database |
| `Synchronizer` | The imperative shell that runs the session and sync programs, owns the serialized dispatch queue, executes effects (sends, persistence, callbacks), and drains notifications at quiescence. | The session/sync programs themselves — those are pure data; `Synchronizer` is the runtime |
| Session program | Pure `Program<SessionInput, SessionModel, SessionEffect>` in `src/session-program.ts`. Models channel topology, establish handshake, peer identity, departure. | Sync program |
| Sync program | Pure `Program<SyncInput, SyncModel, SyncEffect>` in `src/sync-program.ts`. Models document convergence: `present`, `interest`, `offer`, `dismiss`, ready states, sync-protocol dispatch. | Session program |
| `sync-event` effect | A `SessionEffect` whose payload is a `SyncInput`. The shell drains it into the sync program's pending-input queue in the same dispatch cycle. The one cross-program channel. | A wire message |
| Dispatch cycle | One inbound input → update → effects executed → (possibly) more inputs queued from `sync-event` effects → update again → … → quiescence. Notifications accumulate throughout, deliver once on drain. | An event-loop tick |
| Quiescence | The state after one dispatch cycle completes: session queue empty, sync queue empty, no pending `sync-event`s. Notifications drain here. | Async settlement |
| `DocRuntime` | Per-doc bundle: `Ref<S>`, the substrate instance, the schema binding, the mode (`interpret \| replicate \| deferred`), the changefeed subscription, and echo-prevention state. Held by the Synchronizer, not by the programs. | A document — a `DocRuntime` *manages* a document |
| `ReactiveMap<K, V, C>` | From `@kyneta/changefeed` — a callable changefeed over a `ReadonlyMap<K, V>` with lifted accessors. | A plain `Map` — this fires the changefeed |
| `Policy` | Interface with gate predicates (`canShare`, `canAccept`, `canConnect`, `canReset`) and document handlers (`resolve`). Multiple policies register into one `Governance`. | An HTTP middleware, an authorization system |
| `Governance` | The composer. Exposes `composeGate` (pure) + the registry (imperative). Every gate evaluates three-valued logic: `false` vetoes, `true` permits, all-`undefined` falls back to default. | `Policy` — `Governance` *composes* policies |
| `composeGate` | Pure function. Takes an iterable of `boolean \| undefined` results and a default. Returns `false` if any is `false`; `true` if any is `true`; otherwise the default. | A synchronous reducer |
| `Capabilities` | Registry of supported `ReplicaType × SyncProtocol` pairs and their bound schemas, keyed by `ReplicaKey`. Conduit participants register only replicas; interpreters register schemas too. | A schema registry |
| `ReplicaKey` | `${replicaName}:${major}:${syncProtocol}` — composite string key into `Capabilities`. | A doc ID |
| `DEFAULT_REPLICAS` | The default replica-factory bundle: plain (authoritative), plain+LWW (ephemeral). Applications extend with Loro / Yjs replica factories as needed. | A per-doc factory |
| `Disposition` | `Interpret \| Replicate \| Defer \| Reject` — the four outcomes of classifying an unknown doc on `present`. | An HTTP status |
| `resolve` callback | Application-supplied function on `ExchangeParams`. Receives a peer + doc metadata; returns a `Disposition`. Runs only when auto-resolution (via `Capabilities`) fails. | A React ref, an async resolver |
| `Interpret(bound)` | Decision: run the full interpreter stack for this doc against `bound`. | `Replicate(replicaBound)` — no schema, no interpreter |
| `Replicate(replicaBound)` | Decision: persist and forward without interpretation. For relays / stores. | `Interpret(bound)` |
| `Defer()` | Decision: accept `present`, don't sync yet. The doc is known but inactive; the app can promote it later. | `Reject()` — defer keeps the peer-doc relationship |
| `Reject()` | Decision: refuse the doc. The peer's `present` for this doc is silently dropped. | `Defer()` |
| `SyncProtocol` | Structured record from `@kyneta/schema` with three orthogonal axes: `writerModel` (`"concurrent" \| "serialized"`), `delivery` (`"delta-capable" \| "snapshot-only"`), `durability` (`"persistent" \| "transient"`). Three named constants: `SYNC_COLLABORATIVE`, `SYNC_AUTHORITATIVE`, `SYNC_EPHEMERAL`. Drives protocol shape via field-level dispatch. | A CRDT algorithm, a string enum |
| `requiresBidirectionalSync(protocol)` | Pure predicate: `true` when `protocol.writerModel === "concurrent" && protocol.delivery === "delta-capable"`. Used to decide whether `interest.reciprocate` should be set. `writerModel` alone is insufficient — ephemeral protocols have `writerModel: "concurrent"` but `delivery: "snapshot-only"`, meaning they do NOT require bidirectional sync. | A single-field check |
| `BindingTarget` | A fixed `(substrate, sync-protocol, supported-laws)` bundle with `.bind()` and `.replica()`. Named targets (`json`, `ephemeral`, `loro`, `yjs`) follow the rename-over-configure ergonomic rule. | A strategy-parameterized namespace |
| `createBindingTarget` | Pure factory for building custom `BindingTarget` objects. | A strategy-dispatching factory |
| `ReadyState` | Per-doc flag visible via `subscribe(exchange.documents)` — whether the local state has converged with at least one peer since the doc was opened. | A HTTP readyState |
| `present` / `interest` / `offer` / `dismiss` | The four sync messages from `@kyneta/transport`. `present` carries `syncProtocol: SyncProtocol` per doc entry. | Lifecycle messages (`establish`, `depart`) |
| Departure | A peer leaving the sync graph. Explicit (`depart` message), channel-drop + expired grace timer, or `destroy()` on a local doc. | Disconnection — channel drop without grace-timer expiry is *disconnection*, not departure |
| Epoch boundary | A merge that discards local state and adopts an incoming entirety — triggered when a remote peer advances past our version via `advance(to)` / compaction. Gated by `Policy.canReset`. | `reset` on a durable log |
| `Line` | A reliable bidirectional message stream between two peers, implemented as two authoritative documents (one per direction) with automatic seqno + ack pruning. | A socket, a channel, a queue |
| `LineProtocol` | The reified schema pair + topic from `Line.protocol(opts)`. Exposes `open(peerId)` (client) and `listen(onLine)` (server). | `Line` — `LineProtocol` *creates* `Line`s |
| `persistentPeerId` | Browser-only helper: assigns each tab a unique `peerId` that survives reload, via a `localStorage` CAS-based lease protocol. | A cookie, a UUID generator |
| `Store` | The persistence interface from this package. Methods: `append`, `loadAll`, `replace`, `delete`, `currentMeta`, `listDocIds`, `close`. A `Store` instance must be owned by exactly one `Exchange` for its entire lifetime. | A reactive store — this is an append/replace log. Not shared across exchanges. |
| `StoreRecord` | Tagged union: `{ kind: "meta", meta: StoreMeta }` or `{ kind: "entry", payload: SubstratePayload, version: string }` — one durably-persisted record of doc state. | A `ChannelMsg` |
| `StoreMeta` | `Omit<DocMetadata, "supportedHashes">` — the metadata subset persisted per-doc in the store. | `DocMetadata` — `StoreMeta` omits `supportedHashes` |

---

## Architecture

**Thesis**: split the problem along the axis of orthogonal failure modes. Connection topology fails one way (channels drop, peers come and go); document convergence fails another (merges conflict, versions diverge, storage is behind). Solve each with its own pure program, hold both in one shell that owns dispatch ordering, and let the shell — not the programs — know about transports, storage, refs, and callbacks.

Four layers:

| Layer | Kind | Source | Role |
|-------|------|--------|------|
| `Exchange` | Class (façade) | `src/exchange.ts` | Public API: `get`, `remove`, `destroy`, `suspend`, `resume`, `addTransport`, `removeTransport`, `peers`, `documents`. Owns `Synchronizer`, `Governance`, `Capabilities`, `Store[]`, `AnyTransport[]`. |
| `Synchronizer` | Class (shell) | `src/synchronizer.ts` | The imperative shell. Owns the dispatch queue, the `DocRuntime` map, the transport adapters, the reactive-collection handles. Runs both programs, interprets effects. |
| Session program | Pure `Program` | `src/session-program.ts` | Channel topology + peer identity + departure. No document knowledge. |
| Sync program | Pure `Program` | `src/sync-program.ts` | Document convergence + merge-strategy dispatch + ready state. No channel knowledge. |

Plus cross-cutting facilities:

| Facility | Source | Role |
|----------|--------|------|
| Governance | `src/governance.ts` | Composable policies (`canShare` / `canAccept` / `canConnect` / `canReset` / `resolve`). |
| Capabilities | `src/capabilities.ts` | Replica-type + schema registry keyed by `ReplicaKey`. |
| Line | `src/line.ts` | Reliable bidirectional message stream built above `exchange.get`. |
| Persistent peer ID | `src/persistent-peer-id.ts` | Browser-only lease protocol for per-tab unique, reload-stable `peerId`. |
| Storage | `src/store/*.ts` | `Store` interface + in-memory implementation; `@kyneta/leveldb-store` is a production impl. |

### What the exchange is NOT

- **Not a message bus.** Applications do not publish/subscribe to arbitrary topics. The only multicast is the document-sync protocol itself; for application-level messaging, use `Line`.
- **Not pub/sub.** There is no broker, no ordering guarantee across unrelated docs, no multi-party fan-out primitive. One doc's sync is one doc's sync.
- **Not a database.** It persists via the `Store` interface, but it is not a store. It writes what the substrate exports; it reads what the substrate can interpret.
- **Not a transport.** Transports are injected (`transports: [...]`) — the exchange does not open sockets.
- **Not thread-safe across processes.** One `Exchange` instance per process. Multiple tabs coordinate via `persistentPeerId`; multiple processes coordinate via distinct peer IDs and a shared transport.

### What the Synchronizer is NOT

- **Not a thread synchronizer.** JavaScript is single-threaded. The name reflects *document synchronization*, not concurrency primitives.
- **Not a barrier or lock.** The dispatch queue is a queue, not a mutex. Re-entrant dispatches enqueue rather than recurse.
- **Not a protocol translator.** It runs the sync protocol by interpreting program effects; it does not adapt between protocols.

---

## Two programs, one shell

Source: `src/session-program.ts`, `src/sync-program.ts`, `src/synchronizer.ts`.

The session and sync programs are pure values of type `Program<Input, Model, Effect>` from `@kyneta/machine`. Each owns its own state and its own message vocabulary.

```
Session program                              Sync program
───────────────                              ────────────
SessionModel                                 SyncModel
├─ identity: PeerIdentityDetails             ├─ identity: PeerIdentityDetails
├─ channels: Map<ChannelId, ChannelEntry>    ├─ documents: Map<DocId, DocEntry>
├─ peers: Map<PeerId, SessionPeer>           ├─ peers: Map<PeerId, SyncPeerState>
└─ departureTimeout: number                  └─ subscriptions: …

SessionInput                                 SyncInput
├─ sess/channel-added                        ├─ sync/doc-ensure
├─ sess/channel-establish                    ├─ sync/doc-destroy
├─ sess/channel-removed                      ├─ sync/doc-suspend / resume
├─ sess/message-received (LifecycleMsg)      ├─ sync/peer-available / unavailable / departed
└─ sess/departure-timer-expired              ├─ sync/message-received (SyncMsg)
                                             └─ sync/local-doc-change

SessionEffect                                SyncEffect
├─ send (LifecycleMsg)                       ├─ send-to-peer (SyncMsg)
├─ reject-channel                            ├─ send-to-peers (SyncMsg × Peer[])
├─ start-departure-timer                     ├─ ensure-doc (callback)
├─ cancel-departure-timer                    └─ import-doc-data (payload → substrate)
└─ sync-event (SyncInput)  ─────────────────►┘ drained into sync program's queue
```

Neither program calls the other. Neither program imports the other. The *only* coupling is the `sync-event` effect: when the session program needs the sync program to hear about a topology change (peer available, peer unavailable, peer departed), it emits a `sync-event` effect whose payload is a `SyncInput`. The shell drains pending `sync-event` effects into the sync program's pending-input queue in the **same dispatch cycle** — so topology changes and the sync state they imply are always co-applied, not interleaved.

### Serialized dispatch

The Synchronizer owns **one** pending-input queue containing items tagged `session` or `sync`. Inbound inputs — channel events from transports, local doc mutations, wire messages — all enter this queue. The dispatch loop pulls items one at a time, routes to the appropriate program, executes the returned effects, and continues until the queue is empty.

This serialization is the reason there are no lock primitives anywhere in the package. A user callback fired from an `ensure-doc` effect may call `exchange.get(...)` or `doc.title.insert(...)` — those calls enqueue inputs rather than recurse, so even re-entrant paths converge. Re-entrancy ordering matches dispatch ordering, which matches the order the queue received inputs.

### Quiescence drain

Notifications accumulate during dispatch. Four drain methods fire in order at quiescence:

| Drain | Scope | Pattern |
|-------|-------|---------|
| `#drainOutbound()` | Outbound wire envelopes | Shift-loop — the queue can grow during sends if a transport synchronously receives |
| `#drainReadyStateChanges()` | Docs whose ready state flipped this cycle | Snapshot-then-clear |
| `#drainStateAdvanced()` | Docs whose state advanced (drives persistence) | Snapshot-then-clear |
| `#drainPeerEvents()` | `PeerChange` emissions to the peers `ReactiveMap` | Snapshot-then-clear |

Snapshot-then-clear: copy the pending set, reset the field to empty, then iterate the copy. If a subscriber's handler re-enqueues dispatch and produces more changes, they accumulate into a fresh empty set — and run on the *next* quiescence, not this one.

### What the programs are NOT

- **Not aware of each other.** Neither can import the other's types without crossing a layer. The `sync-event` effect's payload is `SyncInput` because that's how its union is declared in `session-program.ts`, but the session program does not call the sync program's `update` function.
- **Not aware of substrates.** Neither program imports from `@kyneta/schema`'s substrate module beyond type re-exports. The substrate's `exportSince` / `merge` are called by the shell on behalf of the sync program's effects.
- **Not asynchronous.** `update` is synchronous and pure. All I/O happens in the shell's effect interpretation.

---

## The sync protocol

Source: `src/sync-program.ts` message handlers. The six messages from `@kyneta/transport/messages.ts` split into two lifecycle (`establish`, `depart` — session) and four sync (`present`, `interest`, `offer`, `dismiss` — sync).

### Sync messages

| Message | Category | Direction | Payload | Semantic |
|---------|----------|-----------|---------|----------|
| `establish` | Lifecycle | Symmetric | `{ identity: PeerIdentityDetails }` | Peer identity exchange on connection. Both peers send. |
| `depart` | Lifecycle | One-way | `{}` | Explicit departure — the receiver skips the grace timer. |
| `present` | Sync | One-way | `{ docs: Array<{ docId, replicaType, syncProtocol, schemaHash, supportedHashes? }> }` | "I have these documents." Filtered by `canShare`. |
| `interest` | Sync | One-way | `{ docId, version?, reciprocate? }` | "I want this doc. Here's my version." `reciprocate` asks for the symmetric interest. |
| `offer` | Sync | One-way | `{ docId, payload: SubstratePayload, version, reciprocate? }` | State transfer. `payload.kind` (`"entirety" | "since"`) is substrate-internal. |
| `dismiss` | Sync | One-way | `{ docId }` | "I am leaving the sync graph for this doc." Dual of `present`. |

The six are defined once in `@kyneta/transport`; the wire encoding is defined once in `@kyneta/wire`. This package implements the *semantics*.

### Sync-protocol dispatch

Each `BoundSchema` carries a `SyncProtocol` — a structured record with three orthogonal axes. The sync program dispatches on individual fields, not a monolithic enum:

**Primary dispatch axis: `syncProtocol.delivery`**

| `delivery` | On local change | Primary export |
|-------------|-----------------|----------------|
| `"delta-capable"` | Push delta to synced peers (interest-based routing) | `exportSince(peerVersion)` |
| `"snapshot-only"` | Broadcast entirety to all interested peers | `exportEntirety()` always |

**Secondary dispatch axis: `requiresBidirectionalSync(syncProtocol)`**

| Result | Condition | `interest.reciprocate` on first? | Meaning |
|--------|-----------|----------------------------------|---------|
| `true` | `writerModel === "concurrent" && delivery === "delta-capable"` | `true` (bidirectional exchange) | CRDT — both peers must exchange deltas |
| `false` | all other combinations | `false` (request/response) | One-way push suffices |

**Why `writerModel` alone is insufficient**: Ephemeral protocols have `writerModel: "concurrent"` (any peer can write) but `delivery: "snapshot-only"` (no delta computation). If `requiresBidirectionalSync` checked only `writerModel`, ephemeral docs would trigger reciprocal interest exchange — wasting a round-trip for a protocol that always sends entireties. The conjunction of both fields is the correct discriminant.

**The three named constants map to these dispatch paths:**

| Constant | `writerModel` | `delivery` | `durability` | `requiresBidirectionalSync` | Routing | Use case |
|----------|---------------|------------|--------------|----------------------------|---------|----------|
| `SYNC_COLLABORATIVE` | `concurrent` | `delta-capable` | `persistent` | `true` | Interest-based (synced peers only) | Loro / Yjs CRDTs |
| `SYNC_AUTHORITATIVE` | `serialized` | `delta-capable` | `persistent` | `false` | Interest-based (synced peers only) | Plain JSON, single-writer |
| `SYNC_EPHEMERAL` | `concurrent` | `snapshot-only` | `transient` | `false` | Interest-based (all interested peers) | Presence, cursors, typing |

**Routing fix**: All three protocols now use interest-based routing. Previously, ephemeral docs broadcast to *all* available peers regardless of interest. Now, ephemeral pushes go only to peers who have expressed interest (via the interest-based routing path in `buildPush`), filtered by `canShare`. The `delivery` axis determines *what* is sent (delta vs entirety), but interest registration determines *who* receives it.

The sync protocol is a property of the document, not the substrate — a Loro substrate can host ephemeral docs via `ephemeral.bind(schema)`.

### Document classification on `present`

Source: `src/sync-program.ts` → `handlePresent`, `src/exchange.ts` → `classifyDoc`.

When a peer announces an unknown doc, four checks run in order:

1. **`canShare` / `canAccept` governance check.** `canAccept(peer, docMeta)` → `false` silently drops the `present`. `resolve` never fires.
2. **Schema-hash auto-resolve via `Capabilities`.** If `(schemaHash, replicaType, syncProtocol)` matches a registered `BoundSchema`, the triple auto-classifies as `Interpret(bound)`. `resolve` never fires.
3. **`resolve` callback.** The application's `resolve(peer, docMeta)` runs. It returns one of the four dispositions.
4. **Two-tiered default (no `resolve` callback).** If `replicaType` is supported (present in `Capabilities` as a replica-only entry), default is `Defer()`. Otherwise `Reject()`.

For *known* docs (already in `DocRuntime`), all three metadata fields — `replicaType`, `syncProtocol`, `schemaHash` — are validated against the local entry. Any mismatch (comparing all three `SyncProtocol` axes: `writerModel`, `delivery`, `durability`) skips sync with a console warning. `supportedHashes` admits heterogeneous-schema sync: two peers with different migrated schema versions can sync if their `supportedHashes` sets overlap.

---

## `exchange.get` — the four-case classifier

Source: `src/exchange.ts` → `Exchange.get`.

```
exchange.get<S>(docId: DocId, bound: BoundSchema<S>): Ref<S>
```

Four cases, in order:

| Case | Condition | Effect |
|------|-----------|--------|
| 1. Already interpreted with compatible schema | `DocRuntime.mode === "interpret"` and schema hash compatible | Return existing `Ref<S>`. No substrate reconstruction. |
| 2. Currently replicated (headless) | `DocRuntime.mode === "replicate"` | Upgrade to interpret: construct substrate via `bound.factoryBuilder`, replay stored entries, attach `Ref<S>`. `ready` transitions. |
| 3. Deferred from `present` | `DocRuntime.mode === "deferred"` | Upgrade to interpret; send `interest` to the peer that presented; run sync. |
| 4. New doc | No entry | Create `DocRuntime`, register with `Store[]`, broadcast `present`, return fresh `Ref<S>`. |

The return is always a `Ref<S>` — a typed, callable, navigable, observable, writable reference from the interpreter stack. Application code reads `doc.title()`, writes `change(doc, d => d.title("new"))`, subscribes `subscribe(doc, changeset => …)`. Everything downstream of `get` is identical regardless of which case fired.

### Suspend vs destroy

| Intention | API | Behaviour |
|-----------|-----|-----------|
| Leave sync graph, keep local state | `exchange.suspend(docId)` | Sends `dismiss`. Removes from `exchange.documents`. State remains in `Store`. `exchange.get(docId)` re-hydrates. |
| Permanent removal | `exchange.destroy(docId)` | Sends `dismiss`. Removes from `exchange.documents`, from `Store`, from all peers' views. Fresh `get` constructs a new doc. |
| Temporary local removal | `exchange.remove(docId)` | Removes from `exchange.documents` and local `DocRuntime`. Does not send `dismiss`. State remains in `Store`. |

The three exist because "I'm done with this doc" has three distinct flavours — intent to resume (`suspend`), intent to erase (`destroy`), memory pressure / local detach (`remove`). They differ in what leaves the `Store` and whether the peer graph is notified.

### What `suspend` is NOT

- **Not a disconnect.** Other docs in the same exchange continue syncing.
- **Not destructive.** Local state is preserved. `resume` or `get` restores it.
- **Not idempotent with `destroy`.** Suspending a destroyed doc is a no-op; destroying a suspended doc completes the destruction.

---

## Peer-ID continuity

Source: `src/exchange.ts` → `validatePeerId`, `src/persistent-peer-id.ts`.

The `peerId` in `ExchangeParams.id` is **required** (enforced by the type: `string` or `{ peerId: string, … }`) and must be:

| Invariant | Why |
|-----------|-----|
| Stable across restarts | A CRDT's version vector is indexed by peer. Changing the peer across boot fragments history — the new peer has no relationship with the old peer's ops, so sync starts from scratch and the merged doc "forks" relative to other peers. |
| Unique across concurrent peers | Two peers with the same ID will merge each other's ops as their own, producing incorrect causality. |

The stability requirement is why `new Exchange({ id })` takes a value rather than generating one. The library does not know what counts as "the same participant" across boots — it could be a device, a user, a browser tab, a service replica. The caller decides.

### Browser tabs: `persistentPeerId`

The multi-tab browser case is subtle enough to deserve its own helper. A tab wants a peer ID that:

- Survives reload in this tab.
- Is unique against other concurrent tabs.
- Reuses the stable "device" ID when no other tab is active (so a single-tab user's peer ID is stable across browser sessions).

`persistentPeerId(key)` implements this via a `localStorage` **compare-and-swap** lease, factored as FC/IS:

```
resolveLease(state)        // pure decision: cached | primary | fresh
persistentPeerId(key)      // imperative: gather → plan → execute
releasePeerId(key)         // clears the lease holder (pagehide, testing)
```

The `resolveLease` pure core is independently tested. Storage keys (`key`, `key + ":held"`, sessionStorage equivalents) are documented at the top of `src/persistent-peer-id.ts`.

### What `persistentPeerId` is NOT

- **Not a UUID generator.** The fresh-tab peer uses `randomPeerId()` (from `@kyneta/random`), but the primary case returns a *stable* device-level ID.
- **Not cross-domain.** `localStorage` is origin-scoped. Different domains mean different devices.
- **Not a server-side helper.** Server processes should pass explicit `peerId` strings; the lease protocol assumes `localStorage` / `sessionStorage`.

---

## The local-write path

Source: `src/synchronizer.ts` → `#wireLocalChanges`, `src/exchange.ts` → changefeed subscription.

Every local mutation — `change(doc, fn)`, direct writes on a ref, `applyChanges` — flows through the substrate's changefeed. The Synchronizer subscribes once per `DocRuntime` and filters by `origin`:

```
change(doc, d => d.title.insert(0, "hi"))
  │
  ├─ substrate.prepare → applyChangeToYjs / applyDiff / etc.
  │  onFlush → changefeed emits Changeset with origin: "local"
  │
  ├─ Synchronizer's subscriber checks origin:
  │    if (origin === "sync") return   // echo from remote import; skip
  │    else dispatch sync/local-doc-change
  │
  ├─ sync program update:
  │    emits send-to-peers { docId, payload: exportSince(peerVersion), version }
  │
  ├─ shell interprets: for each peer in synced set,
  │    envelope to that peer's channel, queue outbound
  │
  └─ drain-outbound fires at quiescence:
       transport.send(envelope)
```

### Echo prevention

Remote `offer` messages go through `substrate.merge(payload, "sync")`. The substrate propagates `"sync"` as the `origin` on every `Changeset` emitted during that merge. The Synchronizer's subscriber checks `changeset.origin === "sync"` and **skips** `notifyLocalChange(docId)`. Without this skip, every incoming `offer` would re-emit a local `offer` back to all peers — an infinite feedback loop.

The origin propagation is the substrate's responsibility (every substrate in `@kyneta/schema` correctly threads it through `executeBatch` and `deliverNotifications`). The sync-side check is *this* package's responsibility.

### What the local-write path is NOT

- **Not synchronous with send.** `change(doc, fn)` returns as soon as the substrate's `onFlush` completes. The wire `offer` fires in the next quiescence drain, which may be the same tick or later depending on re-entrant dispatch.
- **Not per-mutation.** A transaction containing N mutations emits one changefeed entry, which produces one `sync/local-doc-change` input, which produces one `exportSince` call (one payload) per synced peer.
- **Not guaranteed-delivery.** The payload is queued on the transport; delivery depends on the transport.

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
  canShare?: GatePredicate       // Should we include this doc in our `present`?
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

### `cohort` — compaction scope governance

The `cohort` gate determines which peers' confirmed versions participate in the LCV (least common version) computation. `Exchange.compact(docId)` uses the LCV as the safe trim point — `replica.advance()` never exceeds the LCV, so cohort members are guaranteed incremental delta sync (never stranded by compaction).

Peers **outside** the cohort sync normally but may be compacted past. When this happens, `exportSince()` returns `null` for the stranded peer, triggering an `exportEntirety()` fallback — an epoch reset. If the stranded peer has unsynced local writes, those writes are lost on reset.

The default (`true`) includes all synced peers in the cohort, matching pre-cohort behavior: the LCV considers every synced peer, and compaction never strands anyone. Set a `cohort` policy to restrict the LCV to durable peers (e.g., `peer.type === "service"`), allowing ephemeral peers (browser tabs, mobile clients) to be compacted past without holding back the frontier.

```ts
new Exchange({
  id: { peerId: "server", type: "service" },
  cohort: (_docId, peer) => peer.type === "service" ? true : false,
})
```

### What `Policy` / `Governance` is NOT

- **Not authorization middleware.** These gates run at protocol points (pre-send, pre-accept), not at application API points.
- **Not synchronous with remote peers.** A policy denying `canShare` silently omits the doc from `present`; no error is sent.
- **Not hierarchical.** Every registered policy is peer to every other. There is no "super-policy" that overrides the rest.
- **Not persistent.** Policies live in memory. Add / remove at runtime.

---

## Reactive collections

Source: `src/exchange.ts` → `createReactiveMap` wiring.

The `Exchange` exposes two `ReactiveMap` instances:

| Collection | Element | Change type | When it fires |
|------------|---------|-------------|---------------|
| `exchange.peers` | `ReactiveMap<PeerId, PeerIdentityDetails, PeerChange>` | `PeerChange = { type: "joined" \| "left" \| "updated" \| … }` | `sync/peer-available`, `sync/peer-unavailable`, `sync/peer-departed`, identity changes |
| `exchange.documents` | `ReactiveMap<DocId, DocInfo, DocChange>` | `DocChange = { type: "added" \| "removed" \| "mode-changed" \| "ready-state-changed" }` | Doc lifecycle transitions |

Both drain at quiescence with batched changesets (one `Changeset` per dispatch cycle per subscription point, not one per individual change). Subscriptions use the standard `@kyneta/changefeed` API: `subscribe(exchange.peers, changeset => { … })`. Calling the map itself returns the current `ReadonlyMap`: `exchange.peers().get("alice")`.

### Ready state

`ReadyState` is a per-doc boolean that flips to `true` the first time the doc's local state has converged with at least one peer since being opened. Before that, the doc is "loading." After, it is "ready."

Observable via `subscribe(exchange.documents, cs => cs.changes.forEach(c => c.type === "ready-state-changed" && …))` or direct `DocInfo.ready` inspection.

This is the reactive surface for `@kyneta/react`'s `useSyncStatus` and similar hooks.

---

## Storage

Source: `src/store/*.ts`, `src/store/store-program.ts`, `src/exchange.ts` → store-program executor.

A `Store` is a persistence interface this package defines. A `Store` instance must be owned by exactly one `Exchange` for its entire lifetime — exclusive ownership ensures that version tracking, append ordering, and compaction are never corrupted by concurrent access from a second exchange.

### `StoreRecord` and `StoreMeta`

```ts
type StoreMeta = Omit<DocMetadata, "supportedHashes">

type StoreRecord =
  | { readonly kind: "meta"; readonly meta: StoreMeta }
  | { readonly kind: "entry"; readonly payload: SubstratePayload; readonly version: string }

interface Store {
  append(docId: DocId, record: StoreRecord): Promise<void>
  loadAll(docId: DocId): AsyncIterable<StoreRecord>
  replace(docId: DocId, records: StoreRecord[]): Promise<void>
  delete(docId: DocId): Promise<void>
  currentMeta(docId: DocId): Promise<StoreMeta | null>
  listDocIds(prefix?: string): AsyncIterable<DocId>
  close(): Promise<void>
}
```

The `StoreRecord` tagged union carries either document metadata (`"meta"`) or a substrate payload with its version tag (`"entry"`). Both record kinds flow through the same `append` / `loadAll` / `replace` pipeline, so metadata and state are always co-located and atomically durable.

`StoreMeta` is `Omit<DocMetadata, "supportedHashes">` — the subset of document metadata that the store persists. `supportedHashes` is runtime-derived from the schema binding and never stored.

### Multi-store semantics

Applications pass zero or more stores in `ExchangeParams.stores`. Writes fan out to all stores. Reads use first-hit: stores are tried in array order; the first store where `currentMeta(docId)` returns non-null is used for hydration. Two production implementations exist: `@kyneta/leveldb-store` for server-side (LevelDB via `classic-level`) and `@kyneta/indexeddb-store` for browser-side (IndexedDB). The in-memory store in `src/store/in-memory-store.ts` is used for tests and browser-ephemeral cases.

### The store-program

Persistence is driven by a pure Mealy machine: `Program<StoreInput, StoreModel, StoreEffect>` in `src/store/store-program.ts`. Like the session and sync programs, the store-program is a pure function; the Exchange constructor instantiates it via `createObservableProgram` and provides an executor that interprets effects as actual store I/O.

**Input vocabulary:**

| Input | Trigger |
|-------|---------|
| `register` | First boot — doc not found in any store during hydration |
| `hydrated` | Re-boot — doc loaded from a store during hydration |
| `state-advanced` | Exchange's `onStateAdvanced` callback fires after a local or remote mutation |
| `compact` | `exchange.compact(docId)` called |
| `destroy` | `exchange.destroy(docId)` called |
| `write-succeeded` | Store `.append()` or `.replace()` resolved successfully |
| `write-failed` | Store `.append()` or `.replace()` rejected |

**Effect vocabulary:**

| Effect | Executed by shell |
|--------|-------------------|
| `persist-append` | Calls `store.append(docId, record)` for each record on each registered store |
| `persist-replace` | Calls `store.replace(docId, records)` on each registered store |
| `persist-delete` | Calls `store.delete(docId)` on each registered store |
| `store-error` | Calls the `onStoreError` callback |

**Composition with the Exchange.** The Exchange constructor registers a listener via `synchronizer.onStateAdvanced(cb)`. The listener does *not* fire inline with the mutation — it fires at quiescence, after the Synchronizer's `#drainStateAdvanced` method processes the dirty set. The full dispatch chain:

1. A local mutation or remote merge causes the sync program to emit a `notify/state-advanced` notification carrying the affected `docId`s.
2. `#accumulateSyncNotification` adds each `docId` to a `Set<DocId>` (`#dirtyStateAdvanced`). The set deduplicates: multiple state advances for the same doc within a single dispatch cycle coalesce into one callback.
3. At quiescence, `#drainPending` calls `#drainStateAdvanced`, which snapshots the dirty set, clears it, and fires each registered listener once per doc.
4. The Exchange's listener computes `exportSince(confirmedVersion)` to get the delta, then dispatches `{ type: 'state-advanced', docId, delta, newVersion }` into the store-program.
5. The store-program emits `persist-append` effects; the Exchange's effect interpreter calls `store.append(docId, record)` on each registered store and feeds back `write-succeeded` or `write-failed`.

**Per-doc phase tracking.** Each document tracked by the store-program is in one of two phases: `idle` (version confirmed, ready for next write) or `writing` (I/O in flight, with an optional queued input). When a `state-advanced` arrives during `writing`, the delta is queued (latest-wins) and replayed on `write-succeeded`. This ensures at most one in-flight write per document.

**Self-healing version tracking.** The store-program's confirmed version only advances on `write-succeeded`. If a write fails, the old version is preserved so the next `exportSince` recomputes the full delta from the last known-good point. This means transient store failures (disk full, `QuotaExceededError` on IndexedDB, network blip on a remote store) self-heal on the next successful write without data loss.

### `onStoreError` callback

`ExchangeParams.onStoreError` is an optional callback invoked for any store operation failure. Signature: `(docId: DocId, operation: string, error: unknown) => void`. Default: `console.warn`. This allows applications to surface persistence failures to monitoring, retry infrastructure, or user-facing error states without coupling the store-program to any particular error-handling strategy.

### Unified persistence via `state-advanced`

Every local mutation and every remote `offer` merge drives the same persistence path. The pipeline (from quiescence drain to durable write):

1. The Synchronizer's `#drainStateAdvanced` fires the Exchange's listener with a `docId` whose state advanced during the just-completed dispatch cycle.
2. The listener reads the store-program's confirmed version for the doc (`phase.version`).
3. It calls `replica.exportSince(confirmedVersion)` to compute the delta since the last persisted point. If the version didn't actually advance (deduplication guard), it returns early.
4. It dispatches `{ type: 'state-advanced', docId, delta, newVersion }` into the store-program.
5. The store-program emits a `persist-append` effect with the delta as an `entry` record.
6. The effect interpreter fans out `store.append(docId, record)` to each registered store.
7. On success, feeds `write-succeeded` back into the store-program, which advances the confirmed version.

Because the dirty set coalesces multiple advances per doc per dispatch cycle, a burst of rapid local edits produces at most one `state-advanced` dispatch (and therefore one write) per quiescence point. This unifies the persistence path: `exportSince` returns entirety or delta as appropriate, and the store's `append` semantic handles both.

### What `Store` is NOT

- **Not a sync primitive.** Stores do not announce themselves on `present`, receive `offer`, or emit `interest`. They are local to the exchange instance.
- **Not a cache.** Every record is durable on return.
- **Not reactive.** No `subscribe`; reactivity lives at the `Ref<S>` / `ReactiveMap` layer.
- **Not shared across exchanges.** Exclusive ownership is required. If two exchanges share a `Store` instance, version-tracking invariants break and data corruption is possible.

---

## `Capabilities`

Source: `src/capabilities.ts`.

The `Capabilities` registry maps `ReplicaKey` (`${name}:${major}:${syncProtocol}`) to `ReplicaEntry`:

```ts
interface ReplicaEntry {
  replica: BoundReplica              // the replica-only factory bundle
  schemas: Map<string /* schemaHash */, BoundSchema>   // interpreter-mode schemas
}
```

Registration happens in three places:

| Who | What | When |
|-----|------|------|
| Exchange constructor | `DEFAULT_REPLICAS` → plain + LWW | Always |
| `exchange.registerReplica(replicaBound)` | Additional replica types | App startup (Loro/Yjs on the server tier, for instance) |
| `exchange.get(docId, bound)` | Auto-registers `bound.schemaHash → bound` | On first use |

On incoming `present`, the sync program's `handlePresent` queries `Capabilities.findSchema(replicaType, syncProtocol, schemaHash)`. If found, the doc auto-resolves to `Interpret(bound)`. If only the replica is registered (not this specific schema hash), the doc qualifies as `Replicate` — the conduit tier. If neither, the exchange consults `resolve` or defaults.

This is how a routing server with `DEFAULT_REPLICAS + loroReplicaFactory` can relay Loro documents for any schema without ever *interpreting* one: all it needs is the replica factory, not the schema.

---

## `Line` — reliable message streams

Source: `src/line.ts`.

`Line` provides a reliable, ordered, bidirectional message stream between two specific peers. Under the hood it composes **two authoritative JSON documents** — one per direction — with an envelope schema that carries `seq`, `ack`, and `payload`. Ack-driven pruning keeps the documents bounded.

```ts
const chatLine = Line.protocol({
  topic: "chat",
  send: ChatMessage,                // BoundSchema<S_send>
  recv: ChatMessage,                 // BoundSchema<S_recv>
})

// Client
const line = chatLine.open(exchange, peerId)
await line.send({ text: "hello" })
for await (const msg of line) {
  console.log(msg)
}

// Server
chatLine.listen(exchange, async (incomingLine, peer) => {
  for await (const msg of incomingLine) {
    await incomingLine.send({ text: `echo: ${msg.text}` })
  }
})
```

Properties:

| Property | Mechanism |
|----------|-----------|
| Reliability | Built on authoritative docs — missed messages replay from the persisted log. |
| Order | Monotone `seq` within a direction; reader consumes in `seq` order. |
| Bounded storage | Receiver's `ack` triggers sender's pruning of acked messages. |
| Multiple peers | Each peer-pair gets its own Line doc; `LineProtocol` creates + tears down as peers come and go. |
| Application payload | User supplies `send` / `recv` schemas. The envelope (`seq`, `ack`, `nextSeq`) is this package's concern. |

### `LineProtocol`: reified protocol objects

`Line.protocol(opts)` captures the `BoundSchema` pair + topic in one `LineProtocol` object. Both `open` and `listen` use those same references, ensuring each doc is interpreted exactly once — building `Line` instances from raw schemas would produce distinct `BoundSchema` values with the same hash, causing reference-equality conflicts in `exchange.get`.

### What a `Line` is NOT

- **Not a socket.** The underlying transport is the exchange's sync channel; a `Line` rides above it.
- **Not a topic.** A `topic` is a routing hint inside a `LineProtocol`; a `Line` is an open connection to one specific peer.
- **Not a queue.** No broker. The pruning is based on the receiver's `ack`, not a central state.
- **Not broadcast-capable.** Each `Line` is peer-to-peer. Broadcast semantics should use standard doc sync.

---

## Compaction and epoch boundaries

Source: `src/sync-program.ts` → `handleOffer`, `governance.ts` → `canReset`.

CRDT state grows monotonically. Eventually peers compact — discarding history ops and snapshotting current state. A post-compaction `exportSince(oldVersion)` may return an entirety payload rather than a delta, because the substrate no longer retains the history needed to compute the delta.

When the receiver encounters an entirety for a doc that already has local state, two things can happen:

1. **Accept the reset.** Discard local state, adopt the incoming entirety. This is safe if the receiver's state was already ahead of compaction (all its ops are already in the sender's snapshot).
2. **Reject the reset.** Keep local state. Sync will diverge from peers that compacted.

`Policy.canReset(docId, peer)` is the gate. It defaults to `true` (accept) for all sync protocols. Applications that need to reject resets for specific docs or peers register a `canReset` policy.

For durability guarantees, use the `cohort` predicate to prevent compaction past critical peers — this is strictly better than receiver-side rejection, which causes permanent divergence with no built-in reconciliation path. The cohort prevents the situation from arising: `Exchange.leastCommonVersion(docId)` computes the LCV over cohort members only, so `compact()` never advances past a cohort member's confirmed version. The default cohort (no policy) includes all synced peers, preserving backward compatibility.

### What an epoch boundary is NOT

- **Not a protocol message.** There is no `reset` opcode. The decision is derived from `offer { payload: { kind: "entirety" } }` + existing local state.
- **Not a synchronization point.** Accepting a reset discards ops that haven't made it to peers; those peers will see the reset when they next sync.
- **Not a rollback.** Local state is replaced, not reverted; there is no undo.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `Exchange` | `src/exchange.ts` | Public façade. Constructor, `get`, `remove`, `destroy`, `suspend`, `resume`, `addTransport`, `removeTransport`, `peers`, `documents`, `registerReplica`, `registerPolicy`. |
| `ExchangeParams` | `src/exchange.ts` | Constructor options: `id`, `transports`, `stores`, `governance`, `policies`, `resolve`, `canShare`, `canAccept`, `departureTimeout`, `replicas`. |
| `PeerIdentityInput` | `src/exchange.ts` | Input variant of `PeerIdentityDetails` with optional `type`. |
| `Disposition` | `src/exchange.ts` | `Interpret \| Replicate \| Defer \| Reject`. |
| `Synchronizer` | `src/synchronizer.ts` | Shell class. Public only for `@kyneta/react`'s internal use; applications never construct one. |
| `DocRuntime` | `src/synchronizer.ts` | Per-doc runtime bundle. Internal. |
| `SessionModel` / `SessionInput` / `SessionEffect` | `src/session-program.ts` | Session-program state + algebra. |
| `updateSession` | `src/session-program.ts` | Pure `(input, model) → [model, ...effects]`. |
| `SyncModel` / `SyncInput` / `SyncEffect` / `DocEntry` / `SyncPeerState` / `PeerDocSyncState` | `src/sync-program.ts` | Sync-program state + algebra. |
| `updateSync` | `src/sync-program.ts` | Pure `(input, model) → [model, ...effects]`. |
| `Policy` / `GatePredicate` / `EpochBoundaryPredicate` | `src/governance.ts` | Policy interface and predicate shapes. |
| `Governance` / `composeGate` | `src/governance.ts` | Composer class + pure composition function. |
| `Capabilities` / `ReplicaKey` / `DEFAULT_REPLICAS` / `createCapabilities` | `src/capabilities.ts` | Replica + schema registry. |
| `Line` / `LineProtocol` / `createLineDocSchema` | `src/line.ts` | Reliable message-stream primitive. |
| `persistentPeerId` / `releasePeerId` / `resolveLease` / `LeaseState` | `src/persistent-peer-id.ts` | Browser-tab peer-ID lease helper + pure core. |
| `Store` / `StoreRecord` / `StoreMeta` / `DocMetadata` | `src/store/store.ts` | Persistence interface. |
| `PeerChange` / `DocChange` / `DocInfo` / `PeerState` / `ReadyState` | `src/types.ts` | Reactive-collection change types and snapshot shapes. |
| `sync(doc)` | `src/sync.ts` | Helper: returns `{ waitForSync }` for imperative test synchronization. |
| `AsyncQueue` | `src/async-queue.ts` | Bounded async producer/consumer queue used inside `Line`. |

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 228 | Public barrel. Re-exports `bind` / `json` / `ephemeral` / `SyncProtocol` / `SYNC_COLLABORATIVE` / `SYNC_AUTHORITATIVE` / `SYNC_EPHEMERAL` / `requiresBidirectionalSync` from `@kyneta/schema`; exports exchange-specific types. |
| `src/exchange.ts` | 1250 | `Exchange` class, `ExchangeParams`, disposition types, `classifyDoc`, `peerId` validation, `registerReplica`, `registerPolicy`, reactive-collection wiring. |
| `src/synchronizer.ts` | 1517 | Shell. Dispatch queue, `DocRuntime` map, effect interpreter, drain methods (`#drainOutbound`, `#drainReadyStateChanges`, `#drainStateAdvanced`, `#drainPeerEvents`), local-change subscription, transport integration, storage integration. |
| `src/session-program.ts` | 543 | Pure session program: `SessionModel`, inputs, effects, `updateSession`, transition collapse. |
| `src/sync-program.ts` | 1127 | Pure sync program: `SyncModel`, `DocEntry`, inputs, effects, `updateSync`, per-message handlers. |
| `src/program-types.ts` | 48 | Shared `Transition` and `collapse` helper for both programs. |
| `src/governance.ts` | 282 | `Policy`, `GatePredicate`, `EpochBoundaryPredicate`, `Governance`, `composeGate`. |
| `src/capabilities.ts` | 284 | `Capabilities`, `ReplicaKey`, `ReplicaEntry`, `DEFAULT_REPLICAS`, `createCapabilities`. |
| `src/line.ts` | 745 | `Line`, `LineProtocol`, envelope schema, ack-based pruning. |
| `src/async-queue.ts` | 69 | Bounded async queue used by `Line`. |
| `src/persistent-peer-id.ts` | 216 | Browser-tab peer-ID lease; FC/IS split. Imports `randomPeerId` and `randomHex` from `@kyneta/random`. |
| `src/sync.ts` | 195 | `sync(doc)` helper + `registerSync`. |
| `src/types.ts` | 134 | `DocChange`, `DocInfo`, `PeerChange`, `PeerDocSyncState`, `PeerState`, `ReadyState`. |
| `src/utils.ts` | 50 | `validatePeerId`. (Random ID generation extracted to `@kyneta/random`.) |
| `src/store/` | — | `Store` interface + in-memory implementation. |
| `src/transport/` | — | Transport-manager glue. |
| `src/testing/` | — | Test-only helpers exported from `@kyneta/exchange/testing`. |
| `src/__tests__/` | 17 files | Full dispatch-loop, governance, capabilities, line, persistent-peer-id, storage, compaction, classification, and end-to-end tests. |

## Testing

Tests use real `BridgeTransport` pairs from `@kyneta/transport` for multi-peer scenarios and in-memory stores for persistence. There are no mocks — the `@kyneta/machine` runtime interprets pure programs against real effects. Per-test exchanges are fully torn down via `await exchange.close()`.

The `line.test.ts` file alone runs ~50 scenarios including relay topology, hub-and-spoke, and one-way flow — validating that `Line`'s durability surface works end-to-end through real transports.

**Tests**: 420 passed, 0 skipped across 17 files (notable files: `line.test.ts` at 50 tests, full doc lifecycle and governance suites). Run with `cd packages/exchange && pnpm exec vitest run`.