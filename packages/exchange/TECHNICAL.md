# @kyneta/exchange — Technical Reference

Substrate-agnostic state exchange for `@kyneta/schema`. Provides sync infrastructure for any substrate type through a unified four-message protocol (`present`, `interest`, `offer`, `dismiss`) dispatched by merge strategy.

---

## 1. Architecture Overview

The exchange operates at the boundary between three algebras defined by `@kyneta/schema`:

| Algebra | Domain | Currency |
|---------|--------|----------|
| **Application** (CHANGEFEED) | Reactive UI, compiler regions | `Op`, `Changeset` |
| **State** (Substrate) | State management, merge semantics | Substrate-native |
| **Replication** (Exchange) | Peer-to-peer data transfer | `SubstratePayload`, `Version` |

> **Package split:** Transport infrastructure (`Transport<G>`, channel types, message vocabulary, identity types, client state machine, reconnection utilities) lives in `@kyneta/transport`. The sync runtime (`Synchronizer`, `Exchange`, `TransportManager`) lives in `@kyneta/exchange`. Transport implementations peer-depend on `@kyneta/transport`, not `@kyneta/exchange`.

The exchange is the active sync algebra. The substrate is the passive state algebra. They compose at the boundary defined by five substrate methods: `version()`, `exportEntirety()`, `exportSince()`, `merge()`, and `context()`.

**Key invariant:** The exchange never inspects `SubstratePayload` contents. It treats payloads as opaque blobs with an encoding hint (`"json" | "binary"`). Only the substrate knows how to produce and consume them.

### The Elm Architecture (TEA)

The synchronizer follows TEA:

- **Model** (`SynchronizerModel`): immutable state — documents, channels, peers
- **Messages** (`SynchronizerMessage`): inputs — channel lifecycle, document lifecycle, received messages
- **Commands** (`Command`): effectful co-product — side effects the runtime executes
- **Notifications** (`Notification`): invalidation co-product — observations about model transitions

The pure update function `(msg, model) → [model, cmd?, notification?]` contains all sync logic. The `Synchronizer` class is the imperative shell that dispatches messages, executes commands, accumulates notifications, and interacts with substrates.

The return type is a **triple** — two orthogonal co-products of the state transition:

- **Commands** change the world: send messages, import data, stop channels, fire callbacks that may trigger reentrant dispatch.
- **Notifications** declare what changed: which parts of the model were invalidated, so the shell can inform external listeners without brute-force diffing.

This is analogous to `Op[]` in the schema changefeed: the changefeed declares what changed so subscribers don't poll; notifications declare what model state was invalidated so the shell doesn't scan.

```
Message → update(msg, model) → [newModel, Command?, Notification?]
                                       ↓                ↓
                               #executeCommand()   #accumulateNotification()
                                       ↓                ↓
                        ┌──────────────┼──────┐    #dirtyDocIds
                        ↓              ↓      ↓         ↓
                   send message   import   build    (at quiescence)
                   (via adapter)  data     offer    #drainReadyStateChanges()
                                                    → targeted emission
```

The TEA algebra is formalized in `@kyneta/machine` as `Program<Msg, Model, Fx>` — a universal Mealy machine with parameterized effect type. The Synchronizer's `update` function conforms to the `Program` shape with `Fx = Command | Notification` and a custom batched interpreter that accumulates notifications and drains at quiescence. The `runtime()` function in `@kyneta/machine` provides a simpler interpreter for programs with closure effects (`Effect<Msg>`) — synchronous dispatch, immediate effect execution, no batching. Programs with data effects (like the peer negotiator) use a custom executor that maps data to I/O, following the free monad interpreter pattern.

The three client transports (WebSocket, SSE, Unix Socket) also use `Program<Msg, Model, Fx>` for their connection lifecycle. Each client transport has a pure Mealy machine program (`client-program.ts`) that produces **data effects** — the transport class interprets these as I/O via `createObservableProgram` from `@kyneta/machine`. This gives every transport observable state, `subscribeToTransitions`, `waitForState`/`waitForStatus`, and deterministic testability (assert on data, no sockets, no timing).

Currently one notification variant exists:

```ts
type Notification =
  | { type: "notify/ready-state-changed"; docIds: ReadonlySet<DocId> }
  | { type: "notify/batch"; notifications: Notification[] }
```

Four handlers emit `notify/ready-state-changed`: `handleDocImported` (peer synced), `handleInterestForKnownDoc` (peer pending), `handleDismiss` (peer departed), and `handleChannelRemoved` (peer disconnected — all its docs affected). All other handlers return `undefined` for the notification element.

### Changefeed ↔ Synchronizer Wiring

The exchange bridges the Application algebra (CHANGEFEED) and the Replication algebra (Synchronizer) bidirectionally:

```
LOCAL MUTATION                              REMOTE MUTATION
─────────────                               ───────────────
change(doc, fn)                             adapter receives offer
  → wrappedFlush()                            → Synchronizer.#executeImportDocData()
    → originalFlush() [substrate committed]     → replica.merge(payload, "sync")
    → deliverNotifications()                      → changefeed fires with origin: "sync"
      → Exchange's subscriber fires                 → UI subscribers see update
        → origin !== "sync" ✓
        → synchronizer.notifyLocalChange(docId)
          → TEA dispatch: local-doc-change
            → cmd/send-offer
              → adapter sends to peers
```

**Echo prevention:** Remote imports arrive through `merge(payload, "sync")`, which propagates `"sync"` as the origin through `executeBatch` → `wrappedFlush` → `deliverNotifications`. The Exchange's changefeed subscriber checks `changeset.origin === "sync"` and skips the `notifyLocalChange` call, preventing a feedback loop where received data would be re-broadcast.

**Timing:** The changefeed fires synchronously within `change()`. By the time the subscriber executes, `originalFlush` has already committed to the substrate, so `substrate.version()` reflects the new state — exactly what `notifyLocalChange` reads.

**`notifyLocalChange` remains public** for edge cases where the substrate is mutated directly via `unwrap(ref)` (bypassing the changefeed). For standard `change()` usage, it is called automatically.

---

## 2. Merge Strategy as Dispatch Key

Each `BoundSchema` declares a `MergeStrategy`:

```ts
type MergeStrategy = "causal" | "sequential" | "lww"
```

These are genuinely different protocols matched to the mathematical properties of the substrate, not transport optimizations:

| Property | Causal | Sequential | LWW |
|----------|--------|------------|-----|
| `compare()` results | `"concurrent"` possible | Never `"concurrent"` | Never `"concurrent"` |
| Sync direction | Bidirectional | Unidirectional per cycle | Unidirectional push |
| `exportSince()` used | Yes (primary) | Yes (when ahead) | Never |
| `exportEntirety()` used | Fallback | Fallback or primary | Always |
| On local change | Push delta to synced peers | Push delta to synced peers | Broadcast entirety to all peers |
| `interest.reciprocate` | `true` (bidirectional) | `false` | N/A (no interest needed after initial) |

### Protocol Shapes

**Causal (Loro):**
1. A sends `interest { docId, version, reciprocate: true }` to B
2. B sends `offer { docId, payload, version }` to A
3. B sends `interest { docId, version, reciprocate: false }` to A (reciprocation)
4. A sends `offer { docId, payload, version }` to B
5. Both converged via CRDT merge.

**Sequential (Plain):**
1. A sends `interest { docId, version }` to B
2. B compares versions → if ahead, sends `offer { docId, payload, version }` to A
3. If B was behind, B would have sent its own interest.

**LWW (Ephemeral):**
1. On connection: both sides send `interest` (version may be absent)
2. Both respond with `offer { docId, payload, version: timestamp }`
3. On local change: broadcast `offer` to all peers (no interest needed)
4. Receiver compares timestamps and discards stale arrivals.

---

## 3. Sync Protocol

Six message types: two for channel establishment, four for document exchange.

### `present`

Document presentation — assertion of document ownership with metadata. Sent after channel establishment to announce all known documents, filtered by the `route` predicate (§16). Each entry carries per-document metadata (`replicaType`, `mergeStrategy`, `schemaHash`) so the receiver can validate compatibility before any binary exchange.

The `present` metadata (`replicaType`, `mergeStrategy`, `schemaHash`) is validated against the Exchange's capability registries (§24). For known docs, all three fields are validated: `replicaType` compatibility via `replicaTypesCompatible()` (same name + same major version), `schemaHash` equality, and `mergeStrategy` equality (previously unchecked). A mismatch on any field skips the doc with a warning.

When the receiver encounters a known doc and all three checks pass, it sends `interest`.

When the receiver encounters an unknown doc ID, the `route` predicate is checked — if it returns `false` for the announcing peer, the doc is silently dropped. Otherwise, a `cmd/request-doc-creation` command is emitted (carrying `schemaHash` through). All unknown docs flow to `onDocCreationRequested` regardless of replica type. The Exchange first attempts schema auto-resolution from the `(schemaHash, replicaType, mergeStrategy)` triple (§24). If no schema matches and a `onUnresolvedDoc` callback is configured, it fires with the doc ID, the announcing peer's identity, `replicaType`, `mergeStrategy`, and `schemaHash`. The callback returns a disposition (`Interpret | Replicate | Defer | Reject`). If no `onUnresolvedDoc` callback matches (or none is configured), the Exchange applies a two-tiered default: supported `replicaType` → Defer; unsupported `replicaType` → Reject (silently). See §15 for details.

```ts
type PresentMsg = {
  type: "present"
  docs: Array<{
    docId: DocId
    replicaType: ReplicaType      // [name, major, minor]
    mergeStrategy: MergeStrategy  // "causal" | "sequential" | "lww"
    schemaHash: string            // schema fingerprint for compatibility check
  }>
}
```

### `interest`

A declaration of sync interest. Carries the sender's current version (serialized string) so the receiver can compute a delta. For LWW substrates, `version` may be absent on initial connection.

```ts
type InterestMsg = {
  type: "interest"
  docId: DocId
  version?: string        // serialized Version, absent for LWW initial
  reciprocate?: boolean   // ask for bidirectional exchange (causal)
}
```

### `offer`

State transfer. Carries an opaque `SubstratePayload` and the sender's version.

```ts
type OfferMsg = {
  type: "offer"
  docId: DocId
  payload: SubstratePayload  // carries its own `kind` discriminant
  version: string            // serialized Version of sender's state
  reciprocate?: boolean      // ask receiver to send interest back
}
```

The payload's `kind` discriminant (`"entirety"` or `"since"`) is the single source of truth for how the data was produced:
- **`"entirety"`**: full state — produced by `exportEntirety()`
- **`"since"`**: incremental — produced by `exportSince(peerVersion)`

The receiver calls `replica.merge(payload, "sync")`, which dispatches internally on `payload.kind`. The exchange never inspects payload contents — only the substrate knows how to produce and consume them.

### `dismiss`

Document departure announcement — the dual of `present`. A peer sends `dismiss` when it's leaving the sync graph for a document. One-way announcement with no response needed.

```ts
type DismissMsg = {
  type: "dismiss"
  docId: DocId
}
```

The receiving exchange fires `onDocDismissed` if configured (§17). The handler also cleans up the dismissing peer's sync state (`docSyncStates`, `subscriptions`) for the document.

### Establishment messages

Two additional messages handle channel handshake:

```ts
type EstablishRequestMsg = { type: "establish-request"; identity: PeerIdentityDetails }
type EstablishResponseMsg = { type: "establish-response"; identity: PeerIdentityDetails }
```

---

## 4. BoundSchema and Factory Builders

### The Three Choices

A `BoundSchema<S>` captures three explicit choices that define a document type:

1. **Schema** — what shape is the data? (a `SchemaNode` from `@kyneta/schema`)
2. **Factory builder** — how to construct the substrate? (a function `(ctx: { peerId }) => SubstrateFactory`)
3. **Merge strategy** — how does the exchange sync it? (`"causal"`, `"sequential"`, or `"lww"`)

```ts
interface BoundSchema<S extends SchemaNode = SchemaNode> {
  readonly _brand: "BoundSchema"
  readonly schema: S
  readonly factory: FactoryBuilder<any>
  readonly strategy: MergeStrategy
}

type FactoryBuilder<V extends Version> = (context: { peerId: string }) => SubstrateFactory<V>
type MergeStrategy = "causal" | "sequential" | "lww"
```

BoundSchemas are static declarations created at module scope via `bind()`, `bindPlain()`, `bindEphemeral()`, or `bindLoro()`. They are consumed at runtime by `exchange.get(docId, boundSchema)`.

A `BoundReplica` is the replication binding — a projection of `BoundSchema` that captures the pair needed for headless replication without schema knowledge:

```ts
interface BoundReplica {
  readonly factory: ReplicaFactory
  readonly strategy: MergeStrategy
}
```

Every `BoundSchema` contains a `BoundReplica` by projection (derived from the `BoundSchema`'s `FactoryBuilder` → `SubstrateFactory` → `ReplicaFactory` and `strategy`). Schemas can be registered on the Exchange via `ExchangeParams.schemas` (at construction) or `exchange.registerSchema(bound)` (at runtime). The Exchange validates `exchange.get()` calls against the capability registries (§24) — the `BoundSchema`'s `replicaType` must be supported.

### Factory Builder Lifecycle

The factory is always a **builder function**, not a static instance. This solves the identity injection problem:

1. **`BoundSchema` is defined at module scope** — it's a static, shareable declaration.
2. **The exchange calls the builder lazily** on first `get()` that uses a given BoundSchema, passing `{ peerId: this.peerId }`.
3. **Each exchange gets a fresh factory** — two exchanges sharing the same BoundSchema produce independent factory instances with their own peer identity.
4. **Factories are cached per-exchange** — a `WeakMap<FactoryBuilder, SubstrateFactory>` ensures the builder is called at most once per exchange.

For Loro substrates, the builder hashes the string peerId to a deterministic numeric Loro PeerID and returns a factory that calls `doc.setPeerId()` on every new LoroDoc. For plain/sequential substrates, the builder ignores the context: `() => plainSubstrateFactory`. For LWW/ephemeral substrates, the builder returns `lwwSubstrateFactory` (which uses the same plain substrate constructors parameterized with `timestampVersionStrategy`).

### Convenience Wrappers

| Function | Package | Factory | Strategy |
|----------|---------|---------|----------|
| `bindPlain(schema)` | `@kyneta/schema` | `() => plainSubstrateFactory` | `"sequential"` |
| `bindEphemeral(schema)` | `@kyneta/schema` | `() => lwwSubstrateFactory` | `"lww"` |
| `bindLoro(schema)` | `@kyneta/loro-schema` | `(ctx) => createLoroFactory(ctx.peerId)` | `"causal"` |

### Why Not `ExchangeSubstrateFactory`?

The previous design used `ExchangeSubstrateFactory` — a `SubstrateFactory` extended with `mergeStrategy` and `_initialize()`. This was replaced by `BoundSchema` because:

1. **Merge strategy was on the wrong entity.** The same `plainSubstrateFactory` can be used with `"sequential"` or `"lww"`. The strategy is a property of *how the exchange uses the factory*, not the factory itself.
2. **`_initialize()` didn't compose.** If a factory was shared across exchanges, it would be initialized with the first exchange's peerId. The builder function pattern produces a fresh factory per exchange.
3. **Boilerplate.** Every usage required wrapping a `SubstrateFactory` to add `mergeStrategy` and `_initialize` — ~10 lines of wrapping per factory.

### Escape Hatches

Two escape hatches provide access to the underlying substrate:

- **`unwrap(ref)`** in `@kyneta/schema` — general, returns `Substrate<any>`. Uses a `WeakMap<object, Substrate>` populated by `registerSubstrate()` (called by the exchange after building the ref).
- **`loro(ref)`** in `@kyneta/loro-schema` — Loro-specific, returns `LoroDoc`. Uses `unwrap()` internally to get the substrate, then a `WeakMap<Substrate, LoroDoc>` populated by `createLoroSubstrate()`.

The two-step approach (ref → substrate → LoroDoc) avoids duplicating tracking WeakMaps and composes cleanly. Currently supports root-level refs only; child-level resolution (e.g. `loro(doc.title)` → `LoroText`) is future work.

---

## 5. Channel and Transport Abstraction

> **Note:** `Transport<G>`, channel types (`Channel`, `ConnectedChannel`, `EstablishedChannel`, `GeneratedChannel`), `ChannelDirectory`, and the message vocabulary (`ChannelMsg`, etc.) are defined in `@kyneta/transport`. `@kyneta/exchange` re-exports them for backwards compatibility.

### Channel Lifecycle

```
GeneratedChannel → ConnectedChannel → EstablishedChannel
     (adapter)       (synchronizer)      (after handshake)
```

- **GeneratedChannel**: created by `Transport.generate()`. Has `send`, `stop`, `transportType`.
- **ConnectedChannel**: registered with the synchronizer. Has `channelId`, `onReceive`.
- **EstablishedChannel**: completed the establish handshake. Has `peerId` of the remote peer.

At establishment time, the synchronizer checks for two identity issues and emits `notify/warning` notifications (not direct `console.warn` — the pure program produces data, the imperative shell handles I/O):

- **Duplicate peerId:** The remote peer's identity already has active channels from a different connection. This indicates two participants sharing the same peerId, which corrupts CRDT state.
- **Self-connection:** The remote peer's peerId matches the local exchange's identity. Syncing with yourself is always a misconfiguration.

### Transport Base Class

Adapters follow a linear lifecycle: **create → initialize → start → stop → discard**. They cannot be restarted after `_stop()` — internal resources (`readonly` reassemblers, state machines) are disposed and not recreated. If you need a new adapter, create a new instance.

1. **`_initialize(context)`**: receives identity and callbacks (onChannelAdded, onChannelRemoved, onChannelReceive, onChannelEstablish)
2. **`_start()`**: begins operation — subclasses create initial channels here
3. **`_stop()`**: cleans up — all channels are removed, reassemblers disposed

Subclasses implement `generate(context)`, `onStart()`, and `onStop()`.

### TransportFactory — Configuration as Description

`ExchangeParams.transports` accepts `TransportFactory[]` — an array of zero-argument functions that each create a fresh adapter instance:

```typescript
type TransportFactory = () => AnyTransport
```

The Exchange calls each factory once during construction. On `reset()`, the adapter instances are stopped and discarded. A new Exchange with the same factories creates fresh instances — no shared mutable state across lifecycles.

This follows the same principle as `BoundSchema.factory` (called per-exchange to produce a fresh `SubstrateFactory`) and React elements (descriptions of what to render, not the rendered thing).

#### The `create*` Helper Convention

Each transport package exports a `create*` helper that captures options and returns an `TransportFactory`:

```typescript
import { createWebsocketClient } from "@kyneta/websocket-transport/client"

const exchange = new Exchange({
  transports: [createWebsocketClient({ url: "ws://localhost:3000/ws" })],
})
```

Available helpers:
- `createWebsocketClient(options)` — browser-to-server WebSocket
- `createServiceWebsocketClient(options)` — service-to-service WebSocket (with headers)
- `createSseClient(options)` — SSE client (EventSource + POST)
- `createBridgeTransport(params)` — in-process testing adapter

The transport classes (`WebsocketClientTransport`, `SseClientTransport`, etc.) remain exported for advanced use cases that need a handle to the instance (e.g. `subscribeToTransitions`, `waitForStatus`).

#### Server Transport Pattern

Server adapters are referenced by HTTP framework integration code (`handleConnection`, `registerConnection`, Express routers, Bun handlers). They use a "pre-created with single-use factory wrapper" pattern:

```typescript
const serverAdapter = new WebsocketServerTransport()
const exchange = new Exchange({
  transports: [() => serverAdapter],
})
// serverAdapter is now available for framework wiring:
// wss.on("connection", ws => serverAdapter.handleConnection({ socket: wrapNodeWebsocket(ws) }))
```

This is safe because server-side Exchanges are typically created once and never reset. The factory returns the same pre-created instance — the Exchange calls it once during construction.

### Transport Client Programs

Each client transport's connection lifecycle is a `Program<Msg, Model, Fx>` from `@kyneta/machine`, instantiated via `createObservableProgram`. The program's `update` function is the single source of truth for valid state transitions — no separate transition map is needed because `update` only produces valid states by construction. The observable handle provides `subscribeToTransitions`, `waitForState`/`waitForStatus`, `getState()`, and `dispose()`.

- **WebSocket** (`createWsClientProgram`) — 5 states (disconnected, connecting, connected, ready, reconnecting)
- **SSE** (`createSseClientProgram`) — 4 states (disconnected, connecting, connected, reconnecting)
- **Unix Socket** (`createUnixSocketClientProgram`) — 4 states (disconnected, connecting, connected, reconnecting)

Reconnection logic (exponential backoff with jitter, max attempts) lives inside each program's `update` function via a `tryReconnect` helper, producing `start-reconnect-timer` and `reconnect-timer-fired` effects/messages. The imperative shell maps timer effects to `setTimeout` calls that dispatch back into the program.

### BridgeTransport

In-process adapter for testing. Messages are delivered asynchronously via `queueMicrotask()` to simulate real network behavior. Two-phase initialization avoids double-establishment:

1. **Phase 1**: Create channels to all existing peers (no establishment)
2. **Phase 2**: Only the joining adapter initiates establishment

### Storage

Storage is a **direct Exchange dependency** — not an adapter, not a channel, not a participant in the sync protocol. The Exchange handles hydration (loading from storage on `get()`/`replicate()`) and persistence (saving on network imports and local changes) directly.

```ts
const exchange = new Exchange({
  stores: [createInMemoryStore()],
})
```

See §18 for the `Store` interface and §19 for the hydration/persistence architecture.

---

## 6. TimestampVersion

`TimestampVersion` implements `Version` using wall-clock timestamps (milliseconds since epoch) for LWW semantics. It is defined in `@kyneta/schema` (in `src/substrates/timestamp-version.ts`) alongside the other version types and re-exported by `@kyneta/exchange` for convenience.

```ts
class TimestampVersion implements Version {
  readonly timestamp: number
  serialize(): string           // decimal string
  compare(other): "behind" | "equal" | "ahead"  // never "concurrent"
  static now(): TimestampVersion
  static parse(s: string): TimestampVersion
}
```

The LWW algorithm depends on honest, time-synchronized senders. The timestamp serves dual purpose:
1. **Out-of-order filtering**: receiver discards arrivals with older timestamps
2. **Compare-once semantics**: no coordination needed — just compare timestamps at destination

### Version on the History Spectrum

Three Version implementations span the full spectrum from causal history to pure present:

| Version Type | Substrate | Order | History |
|---|---|---|---|
| `LoroVersion` (VersionVector) | Loro CRDT | Partial | Full causal oplog |
| `PlainVersion` (monotonic counter) | Plain JS | Total (single-writer) | Limited op log |
| `TimestampVersion` (wall clock) | LWW/Ephemeral | Total (by convention) | None — latest value only |

---

## 7. Merge Dispatch

The synchronizer calls `replica.merge(payload, "sync")`. The substrate dispatches internally on `payload.kind`:

- **Oplog substrates** (Loro): both `"since"` and `"entirety"` payloads are handled identically — Loro's `doc.import()` accepts updates and snapshots uniformly via oplog merge.
- **State-image substrates** (Plain):
  - `"since"` payloads apply ops incrementally (Op[] format, path + change pairs).
  - `"entirety"` payloads decompose to `ReplaceChange` ops through `executeBatch` (preserving ref identity and firing the changefeed). This ensures the interpreter stack, caches, and changefeed subscriptions remain intact.

`exportSince()` returns `null` when there is nothing to export (e.g. the target version equals or exceeds the current version). The synchronizer treats `null` from `exportSince()` as a no-op: it logs a warning and sends nothing, since the version comparison should have caught this case first. The only path to `exportEntirety()` is when `sinceVersion` is absent (LWW pushes, or a peer that has no version to offer).

---

## 8. LWW Substrate Pattern

The LWW substrate pattern is implemented by `lwwSubstrateFactory` in `@kyneta/schema` (`src/substrates/lww.ts`), consumed by `bindEphemeral()`. LWW substrates are plain substrates parameterized with `timestampVersionStrategy` — same state management, same construction functions, different version algebra:

- **State management**: shared with `plainSubstrateFactory` — same `Reader`, `applyChange`, interpreter stack, op log. The `createPlainSubstrate<V>` and `createPlainReplica<V>` constructors accept a `VersionStrategy<V>` parameter; LWW passes `timestampVersionStrategy`.
- **Version tracking**: `TimestampVersion` produced by `strategy.current(flushCount)`. Returns `TimestampVersion(0)` when no flushes have occurred, `TimestampVersion.now()` after the first flush. The flush count parameter is ignored — LWW versions are wall-clock timestamps, not counters.
- **Export**: `strategy.logOffset()` returns `null` (timestamps have no relationship to the op log array index), so the replication core falls back to `exportEntirety()`. The synchronizer never sets `sinceVersion` for LWW docs, so this fallback is unreachable in practice.
- **Import**: same as plain — `merge()` dispatches on `payload.kind` and applies through `executeBatch` (substrate) or `applyChange` (replica).

There is no decorator, no wrapper object, and no `context()` gotcha. Each LWW substrate is a single object produced by a single `createPlainSubstrate(storeObj, timestampVersionStrategy)` call. The `VersionStrategy<V>` interface has three pure members: `zero`, `current(flushCount)`, and `logOffset(since)`.

---

## 9. Serialized Dispatch with Quiescence Drain

> **Historical note:** This section previously documented `ClientStateMachine<S>` and `createReconnectScheduler` as shared infrastructure for transport client reconnection. These have been replaced by `Program`-based transports using `createObservableProgram` from `@kyneta/machine` (see §5 "Transport Client Programs"). The validated transition map is superseded by each program's `update` function (which only produces valid states by construction), and the reconnect scheduler is superseded by reconnection logic in each program's `update` + timer effects.

The `Synchronizer` processes messages one at a time via a serialized dispatch loop:

```
#dispatch(msg):
  pendingMessages.push(msg)
  if already dispatching: return

  dispatching = true
  while pendingMessages.length > 0:
    msg = pendingMessages.shift()
    [newModel, cmd, notification] = updateFn(msg, model)
    model = newModel
    if notification: accumulateNotification(notification)  // collect into typed sets
    if cmd: executeCommand(cmd)                            // may push more messages

  // Quiescence — all messages processed
  #drainOutbound()                  // send accumulated envelopes
  #drainReadyStateChanges()         // emit only for dirtyDocIds
  #drainStateAdvanced()             // emit only for dirtyStateAdvanced
  #drainPeerEvents()                // emit accumulated peer-joined/peer-left
  dispatching = false
```

Commands that produce new messages (e.g. `cmd/dispatch`) are pushed to `pendingMessages` and processed in the same dispatch cycle. Outbound messages are accumulated in a queue and flushed only at quiescence, ensuring consistent model state before any messages leave the exchange.

Notifications are accumulated across the entire dispatch cycle into typed sets. At quiescence, four drain methods fire in order:

1. **`#drainOutbound()`** — sends accumulated wire envelopes. Uses a shift-loop (the outbound queue may grow during sends).
2. **`#drainReadyStateChanges()`** — emits only for docs in `#dirtyDocIds`. O(dirty × peers × listeners). Most dispatch cycles touch zero or one doc, so this is typically O(1) or O(P×L).
3. **`#drainStateAdvanced()`** — emits only for docs in `#dirtyStateAdvanced`. Drives unified persistence via the Exchange's `onStateAdvanced` listener.
4. **`#drainPeerEvents()`** — emits accumulated `PeerChange` events via the peer lifecycle changefeed (§21).

All drain methods (except `#drainOutbound`, which uses a shift-loop) follow the **snapshot-then-clear** pattern: snapshot the pending set, reset the field to empty, then process the snapshot. This ensures the accumulation field is clean before any subscriber code runs — subscribers that trigger reentrant dispatch accumulate into a fresh set, not the one being drained.

---

## 10. File Map

| File | Purpose |
|------|---------|
| `src/types.ts` | Sync-specific types (PeerState, ReadyState, PeerChange) — re-exports transport identity types from `@kyneta/transport` |
| `src/transport/transport-manager.ts` | `TransportManager` — transport lifecycle and message routing |
| `src/utils.ts` | PeerId generation and validation |
| `src/synchronizer-program.ts` | TEA state machine — model, messages, commands, sync algorithms |
| `src/synchronizer.ts` | Synchronizer runtime — dispatch, command execution, substrate interaction |
| `src/exchange.ts` | `Exchange` class — public API, `RoutePredicate`, `AuthorizePredicate`, `OnDocDismissed` types |
| `src/sync.ts` | `sync()` function and `SyncRef` — sync capabilities access |
| `src/store/store.ts` | `Store` interface and `StoreEntry` type |
| `src/store/in-memory-store.ts` | `InMemoryStore` + `createInMemoryStore()` factory |
| `src/store/index.ts` | Storage module barrel export |
| `src/testing/store-conformance.ts` | Reusable `describeStore()` conformance suite (exported via `@kyneta/exchange/testing`) |
| `src/testing/index.ts` | Testing module barrel export |
| `src/index.ts` | Barrel export — re-exports from `@kyneta/transport` and `@kyneta/schema` |

Note: `MergeStrategy`, `BoundSchema`, `bind()`, `bindPlain()`, `bindEphemeral()`, `unwrap()`, `registerSubstrate()`, and `TimestampVersion` are defined in `@kyneta/schema` and re-exported from `@kyneta/exchange` for convenience. `bindLoro()` is defined in `@kyneta/loro-schema`.

### Test Files

| File | Coverage |
|------|----------|
| `src/__tests__/transport-manager.test.ts` | TransportManager lifecycle and message routing |
| `src/__tests__/synchronizer-program.test.ts` | Pure TEA update function — all message types, merge strategies, `cmd/request-doc-creation`, replicate mode |
| `src/__tests__/store-hydration.test.ts` | Exchange-level storage hydration — get/replicate hydration, network import persistence, local change persistence, flush, round-trip restart |
| `src/__tests__/store.test.ts` | InMemoryStore — conformance suite + InMemory-specific sharedData/getStorage tests |
| `src/testing/store-conformance.ts` | Reusable Store contract suite: lookup, ensureDoc, append, loadAll, replace, delete, listDocIds, JSON + binary payload round-trips, StoreEntry shape |
| `src/__tests__/store-integration.test.ts` | End-to-end storage: persist+hydrate for sequential/causal/LWW, replicate mode, dismiss+delete, onUnresolvedDoc+storage |
| `src/__tests__/exchange.test.ts` | Exchange class — get, cache, sync, lifecycle, factory builder lifecycle |
| `src/__tests__/integration.test.ts` | Two-peer sync for sequential, causal, LWW, heterogeneous, and `onUnresolvedDoc` dynamic creation |
| `src/__tests__/sync-invariants.test.ts` | Regression tests: empty-delta fallback, ref identity, LWW stale rejection, causal deltas |
| `src/__tests__/client-state-machine.test.ts` | ClientStateMachine — transitions, subscriptions, waitForState, reset |

---

## 11. Wire Format (`@kyneta/wire`)

The `@kyneta/wire` package provides serialization infrastructure for the exchange's six-message protocol (two establishment + four exchange). It sits between the exchange and transports in the dependency graph:

```
@kyneta/changefeed   @kyneta/schema
   (contract)           (grammar)
        ↑                   ↑
        └───────┬───────────┘
                ↓
@kyneta/exchange  →  @kyneta/wire  →  @kyneta/websocket-transport
   (messages)         (codecs)          (transport)
                                        @kyneta/sse-transport
                                        @kyneta/webrtc-transport
                                        @kyneta/unix-socket-transport
```

### Frame<T> — Universal Abstraction

Every message is wrapped in a `Frame<T>`. A frame carries a protocol version, an optional content hash (reserved for future SHA-256), and content that is either **complete** (the full payload) or a **fragment** (one piece of a larger payload). Binary pipeline: `Frame<Uint8Array>`. Text pipeline: `Frame<string>`.

Batching is **orthogonal to framing**. The frame layer does not distinguish single messages from batches — the payload's own structure (CBOR array vs map, JSON array vs object) determines singular vs plural.

### Two Codec Interfaces

| Interface | Type `T` | Implementation | Transport | Binary Payload |
|-----------|----------|----------------|-----------|----------------|
| **BinaryCodec** | `Uint8Array` | `cborCodec` | WebSocket, WebRTC | Native CBOR byte strings |
| **TextCodec** | JSON-safe objects | `textCodec` | SSE, HTTP | Base64-encoded in JSON |

The `BinaryCodec` operates on raw bytes (`encode`/`decode`/`encodeBatch`/`decodeBatch` with `Uint8Array`). The `TextCodec` operates on JSON-safe objects (`encode` returns `unknown`, `decode` accepts `unknown`).

### Three Pipelines

```
Binary: BinaryCodec (CBOR) → binary frame (7B header) → binary fragmentation → FragmentReassembler
                                                                                 └→ FragmentCollector<Uint8Array>

Text:   TextCodec (JSON)   → text frame ("Vx" prefix) → text fragmentation   → TextReassembler
                                                                                 └→ FragmentCollector<string>

Stream: BinaryCodec (CBOR) → binary frame (7B header) → StreamFrameParser (byte stream → frames)
```

The **Binary** and **Text** pipelines serve message-oriented transports (WebSocket, WebRTC, SSE) where the transport delivers discrete messages with inherent boundaries. The **Stream** pipeline serves stream-oriented transports (Unix domain sockets) where the transport delivers a continuous byte stream with no message boundaries. The `StreamFrameParser` replaces both the fragmentation layer and the `FragmentCollector` — stream transports have no message size limits, so fragmentation is unnecessary. The 7-byte header's payload length field provides all the framing needed to extract messages from the byte stream.

### Binary Frame Format

7-byte header: version (1B, `0x00`) + type (1B, `0x00`=complete / `0x01`=fragment) + hash algorithm (1B, `0x00`=none) + payload length (4B BE). Fragment frames add 20 bytes of metadata (frameId 8B + index 4B + total 4B + totalSize 4B) before the payload. Two transport prefixes: `0x00` (complete) and `0x01` (fragment).

### Text Frame Format

JSON array with a 2-character prefix: position 0 is the version (`'0'`), position 1 encodes type + hash via case (`'c'`=complete, `'C'`=complete+hash, `'f'`=fragment, `'F'`=fragment+hash). Complete frames embed the payload as a native JSON value. Fragment frames carry `frameId`, `index`, `total`, `totalSize`, and a JSON substring chunk.

### FragmentCollector<T>

Generic stateful fragment collector parameterized on chunk type `T`. Uses a pure decision function (`decideFragment`) as the functional core and the `FragmentCollector` class as the imperative shell. Both `FragmentReassembler` (binary) and `TextReassembler` (text) are thin wrappers (~80–100 lines) that handle format-specific parsing and delegate collection to the generic collector.

Fragments are fully self-describing — no separate "fragment header" message. The collector auto-creates tracking state on first contact with a new frame ID. Configurable timeouts (default 10s), max concurrent frames (32), max total size (50MB), and oldest-first eviction.

### Binary Transport Helpers

Two shared helpers eliminate encode/decode duplication across binary transports:

- `encodeBinaryAndSend(msg, fragmentThreshold, sendFn)` — Encode a `ChannelMsg`, optionally fragment, and call `sendFn` for each piece. The FC/IS boundary: pure planning (what bytes to produce) with an injected `sendFn` (the transport-specific effectful operation).
- `decodeBinaryMessages(bytes, reassembler)` — Feed raw transport bytes through the reassembler and decode to `ChannelMsg[]`. Returns the decoded messages, `null` if pending fragments, or throws on error.

Both WebSocket and WebRTC transports use these helpers instead of inline encode/decode logic. Located in `binary-transport.ts`.

### Wire Type Discriminators (CBOR)

`OfferMsg` no longer carries an `offerType` field — the payload's `kind` discriminant (`PayloadKind`) is the single source of truth. On the wire, `pk` (PayloadKind) replaces the former `ot` (OfferType).

| Message | Discriminator | Compact Fields |
|---------|--------------|----------------|
| `establish-request` | `0x01` | `t`, `id`, `n?`, `y` |
| `establish-response` | `0x02` | `t`, `id`, `n?`, `y` |
| `present` | `0x10` | `t`, `docs` (array of `{ d, rt, ms }`) |
| `interest` | `0x11` | `t`, `doc`, `v?`, `r?` |
| `offer` | `0x12` | `t`, `doc`, `pk`, `pe`, `d`, `v`, `r?` |
| `dismiss` | `0x13` | `t`, `doc` |

`PayloadKind` values: `0x00` = `"entirety"`, `0x01` = `"since"`.
`PayloadEncoding` values: `0x00` = `"json"`, `0x01` = `"binary"`.
`MergeStrategyWire` values: `0x00` = `"causal"`, `0x01` = `"sequential"`, `0x02` = `"lww"`.

`present` entries carry `rt` (ReplicaType as `[string, number, number]`) and `ms` (MergeStrategyWire integer) per document.

See `packages/exchange/wire/PROTOCOL.md` for the full wire protocol specification.

---

## 12. Websocket Network Adapter (`@kyneta/websocket-transport`)

The first real transport. Framework-agnostic via the `Socket` interface, with platform-specific wrappers for browser, Node.js `ws`, and Bun. Inline encode/decode logic has been refactored to use the shared binary transport helpers (`encodeBinaryAndSend` / `decodeBinaryMessages`) from `@kyneta/wire`.

### Package Structure

Three subpath exports (no combined `"."` entry) to keep client/server/bun code tree-shakeable:

| Subpath | Entry | Key Exports |
|---------|-------|-------------|
| `./client` | `src/client.ts` | `WebsocketClientTransport`, `createWebsocketClient`, `createServiceWebsocketClient`, `WebsocketClientStateMachine` |
| `./server` | `src/server.ts` | `WebsocketServerTransport`, `WebsocketConnection`, `wrapNodeWebsocket`, `wrapStandardWebsocket` |
| `./bun` | `src/bun.ts` | `BunWebsocketData`, `wrapBunWebsocket`, `createBunWebsocketHandlers` |

### Connection Handshake

The Websocket connection handshake is two-phase to avoid race conditions:

1. **Transport-level**: Server sends text `"ready"` signal after Websocket opens
2. **Protocol-level**: Client creates channel + sends `establish-request` after receiving `"ready"`
3. Server's Synchronizer processes the `establish-request` and responds with `establish-response`

The server does NOT call `establishChannel()` — it waits for the client's establish-request. This prevents a race condition where the server's binary establish-request could arrive before the client has processed `"ready"` and created its channel.

### Client Program (`createWsClientProgram`)

The WebSocket client lifecycle is a pure Mealy machine: `Program<WsClientMsg, WebsocketClientState, WsClientEffect>`. The transport class instantiates it via `createObservableProgram` and interprets data effects as I/O.

**5-state lifecycle** (unique among the three client transports — SSE and Unix Socket have 4 states):

```
disconnected → connecting → connected → ready
                   ↓            ↓         ↓
              reconnecting ← ─ ┴ ─ ─ ─ ─ ┘
```

The extra `ready` state exists because the server sends a text `"ready"` signal after the WebSocket opens, and only then does the client create a channel and start the establishment handshake.

**Ready race condition:** The server may send `"ready"` before the client's `open` event fires (server-ready while still connecting). The program handles this by transitioning directly from `connecting` → `ready`, skipping the `connected` state entirely — both `start-keepalive` and `add-channel-and-establish` effects are produced in a single transition.

**Lifecycle event forwarding:** The transport class subscribes to the program's transitions via `subscribeToTransitions` and forwards them to user-provided callbacks (`onStateChange`, `onDisconnect`, `onReconnecting`, `onReconnected`, `onReady`). The `wasConnectedBefore` flag — used to distinguish initial connection from reconnection — is **observer-local state** (a closure variable in the transition listener), not part of the program model. This keeps the pure program free of presentation concerns.

Reconnection uses exponential backoff with jitter, computed by the pure `tryReconnect` helper inside the program's `update` function.

### Integration Tests

End-to-end tests in `tests/exchange-websocket/` prove the full stack over real Websocket connections for all three merge strategies (sequential, causal, LWW), heterogeneous documents, and large payload fragmentation. These use Bun's built-in Websocket server on random ports.

The `examples/todo-react` example demonstrates the full Yjs + WebSocket + React stack over Vite middleware mode (Node runtime), proving substrate and runtime agnosticism alongside the Loro + Bun-based `examples/todo`.

---

## 13. Verified Properties

1. **Sequential sync converges**: Two exchanges with `bindPlain()`, peer A creates doc with seed, peer B syncs and reads same state. Mutations from A propagate to B after initial sync.

2. **Causal sync converges**: Two exchanges with `bindLoro()`, concurrent edits from both peers produce identical final state on both sides (CRDT merge).

3. **LWW broadcast works**: Peer A sets presence via `change()`, peer B receives snapshot via LWW broadcast, state matches. Updates propagate via subsequent broadcasts.

4. **Heterogeneous documents**: Single exchange hosts both Loro-backed (`bindLoro`) and plain-backed (`bindPlain`) documents. Both sync correctly to a peer through the same adapter infrastructure.

5. **Factory builder isolation**: Two exchanges sharing the same `BoundSchema` get independent factory instances, each with the correct peer identity.

6. **Escape hatches work**: `unwrap(ref)` returns the substrate; `loro(ref)` returns the LoroDoc. Both compose via the `WeakMap` chain (ref → substrate → LoroDoc).

7. **Existing tests unaffected**: `@kyneta/schema` tests (1110) and `@kyneta/loro-schema` tests (92) pass, including new `bind`/`unwrap`/`bindLoro`/`loro` tests. The `SubstrateFactory`, `Substrate`, and `Version` interfaces are unchanged.

8. **Wire codec round-trip**: All 5 message types survive encode → decode through both CBOR and JSON codecs, including `OfferMsg` with binary `SubstratePayload` (38 codec tests, 31 frame tests, 54 fragment tests).

9. **Websocket transport sync**: Sequential, causal, and LWW sync all work over real Websocket connections (Bun server + client adapter). Heterogeneous documents and fragmented large payloads sync correctly (8 integration tests).

10. **Local mutations auto-trigger sync**: `change(doc, fn)` automatically notifies the synchronizer via the changefeed → `notifyLocalChange` wiring. No manual `synchronizer.notifyLocalChange()` call is needed. Echo is prevented by filtering `origin === "sync"` in the changefeed subscriber.

11. **End-to-end in a real app**: The `examples/todo/` app proves the full managed sync path in a running application: `LoroSchema` → `bindLoro` → `Exchange` → `WebsocketServerTransport`/`WebsocketClientTransport` → Cast compiled view → collaborative real-time sync between browser tabs. No hand-rolled WebSocket code — `change(doc, fn)` on any client automatically propagates to all peers via the changefeed → synchronizer → adapter pipeline.

12. **Dynamic document creation via `onUnresolvedDoc`**: Peer A creates a document unknown to peer B. B's `onUnresolvedDoc` callback materializes the document with the correct `BoundSchema`. After sync, B has A's content. Works for sequential (PlainSubstrate) and LWW (`bindEphemeral` / `TimestampVersion`) strategies. Callback returning `Reject()` correctly suppresses creation. When no callback is configured, the Exchange applies a two-tiered default: supported replica type → Defer; unsupported → Reject.

---

## 14. SSE Network Adapter (`@kyneta/sse-transport`)

The SSE adapter uses an **asymmetric transport** (POST for uplink, SSE for downlink) with **symmetric encoding** (text wire format in both directions).

### Package Structure

Three subpath exports (no combined `"."` entry) to keep client/server/express code tree-shakeable:

| Subpath | Entry | Key Exports |
|---------|-------|-------------|
| `./client` | `src/client.ts` | `SseClientTransport`, `createSseClient`, `SseClientStateMachine` |
| `./server` | `src/server.ts` | `SseServerTransport`, `SseConnection` |
| `./express` | `src/express.ts` | `createSseExpressRouter`, `parseTextPostBody`, `SseServerTransport` (re-export) |

### Architecture: Symmetric Encoding, Asymmetric Transport

Unlike the old `@loro-extended/adapter-sse` which used binary CBOR for POST and ad-hoc JSON for SSE, the kyneta SSE adapter uses the **text wire format** (`textCodec` + text framing) in both directions:

```
Client → Server (POST):  encodeTextComplete(textCodec, msg) → text frame string → fetch(url, { body: textFrame })
Server → Client (SSE):   encodeTextComplete(textCodec, msg) → text frame string → sendFn(textFrame) → res.write(`data: ${textFrame}\n\n`)
```

Benefits: single encode/decode path, human-readable debugging, no `express.raw()` needed, text fragmentation works in both directions.

### Why No "Ready" Signal (Unlike WebSocket)

The WebSocket adapter has a two-phase handshake: server sends text `"ready"` → client creates channel. This is necessary because the WebSocket `open` event fires when the TCP connection is established, but the server's message handler may not be fully wired up yet.

SSE doesn't need this. The `EventSource.onopen` event fires only after the server has sent the HTTP response headers, which means the server's route handler is already executing and the connection is registered. The client transitions directly from `connecting` → `connected` and immediately creates its channel.

### Client Program (`createSseClientProgram`) and Custom Reconnection

The SSE client lifecycle is a pure Mealy machine: `Program<SseClientMsg, SseClientState, SseClientEffect>`. The transport class instantiates it via `createObservableProgram` and interprets data effects as I/O.

**4-state lifecycle** (no `ready` state — SSE's `EventSource.onopen` fires only after the server has sent HTTP response headers, so the connection is immediately usable):

```
disconnected → connecting → connected
                   ↓            ↓
              reconnecting ← ─ ─┘
```

The browser's native `EventSource` has built-in reconnection. The adapter **closes the EventSource immediately** on `onerror` and lets the program handle reconnection via its `tryReconnect` logic. This prevents two reconnection systems from fighting and gives full control over:

- Exponential backoff timing with jitter
- Attempt counting and max attempts
- Channel lifecycle (preserve vs. recreate)
- Observable state transitions for UI feedback

On `event-source-error`, the program produces `close-event-source`, `remove-channel`, and `abort-pending-posts` effects (if connected), then transitions to `reconnecting` with a timer effect — the imperative shell never decides reconnection policy.

### The `sendFn` Pattern

`SseConnection.send(msg)` owns encoding and fragmentation. It encodes the `ChannelMsg` to a text frame string, optionally fragments it, and calls `sendFn(textFrame)` for each piece. The injected `sendFn: (textFrame: string) => void` is a pure transport concern:

```
Express: connection.setSendFunction((tf) => res.write(`data: ${tf}\n\n`))
Hono:    connection.setSendFunction((tf) => stream.writeSSE({ data: tf }))
```

This is cleaner than the old pattern where the framework integration had to call `serializeChannelMsg()`.

### Two-Step Decode in `parseTextPostBody`

POST bodies are text wire frame strings. Decoding requires two steps:

1. `TextReassembler.receive(body)` → `Frame<string>` (handles both complete and fragment frames)
2. `JSON.parse(frame.content.payload)` → `textCodec.decode(parsed)` → `ChannelMsg[]`

The `parseTextPostBody` function (functional core) returns a discriminated union result. The framework integration (imperative shell) executes side effects based on the result type (`messages` → deliver, `pending` → 202, `error` → 400).

### Integration Tests

The SSE adapter's functional core (`parseTextPostBody`, `SseConnection.send`) is tested via unit tests that verify text frame round-trips and fragmentation. End-to-end integration tests over real HTTP connections are deferred to the chat example.

---

## 15. Document Classification (`onUnresolvedDoc`)

### Callback Signature

```ts
type Disposition = Interpret | Replicate | Defer | Reject

type OnUnresolvedDoc = (
  docId: DocId,
  peer: PeerIdentityDetails,
  replicaType: ReplicaType,
  mergeStrategy: MergeStrategy,
  schemaHash: string,
) => Disposition
```

The `onUnresolvedDoc` callback is an optional field on `ExchangeParams`. It fires when a peer announces (via `present`) a document the Exchange cannot auto-resolve from its capability registries (§24). Every code path must return an explicit disposition — there is no `undefined` return.

### Four Dispositions

- **`Interpret(bound)`** — full interpretation with schema, ref, changefeed. The `bound` parameter is required — `onUnresolvedDoc` only fires for docs the registry can't resolve, so the caller must supply the `BoundSchema`.
- **`Replicate()`** — parameterless headless replication. The Exchange resolves the `ReplicaFactory` from its replica registry using the `(replicaType, mergeStrategy)` pair from the `present` message. If no matching `BoundReplica` is registered, the Exchange emits a warning and rejects the doc.
- **`Defer()`** — track the document for routing (included in `present` messages to other peers) but do not create a local representation. The doc can be promoted later via `exchange.get(docId, bound)`, `exchange.replicate(docId)`, or auto-promotion when `exchange.registerSchema(bound)` registers a matching schema.
- **`Reject()`** — explicit rejection. The document is dropped and not tracked. Replaces the old `undefined` return.

When no `onUnresolvedDoc` callback matches (or none is configured), the Exchange applies a two-tiered default: if the `replicaType` is supported by the capability set, the doc is **deferred** (promotion is plausible via a later `exchange.get()` or `registerSchema()`); otherwise the doc is **rejected** silently (no evidence the exchange will ever handle this format).

### Auto-Interpretation

When schemas are registered via `ExchangeParams.schemas` or `exchange.registerSchema(bound)`, the Exchange auto-resolves matching docs from `present` metadata — the `(schemaHash, replicaType, mergeStrategy)` triple is looked up in the schema registry. **`onUnresolvedDoc` never fires for auto-resolved docs.** The developer declares schemas once; the Exchange handles discovery automatically.

This means `onUnresolvedDoc` is only needed for:
- Docs whose schema is not (yet) registered — return `Interpret(bound)` with an ad-hoc schema, `Defer()` to wait, or `Reject()`.
- Docs that should be headlessly replicated — return `Replicate()`.
- Dynamic policy decisions based on `docId` or `peer` that go beyond schema matching.

### Protocol Flow

```
Peer A (has doc)               Peer B (doesn't have doc)
     |                                |
     |── present [{ docId:           >|
     |     "input:alice",             |
     |     replicaType: ["loro",1,0], |
     |     mergeStrategy: "causal",   |
     |     schemaHash: "00abc..." }]  |
     |                                | handlePresent: unknown doc
     |                                | ① route(docId, peer)?
     |                                |   No → silently drop
     |                                |   Yes ↓
     |                                | ② cmd/request-doc-creation
     |                                | ③ schema auto-resolve:
     |                                |   resolveSchema(hash, type, strategy)
     |                                |   Match → exchange.get(docId, resolved)
     |                                |   No match ↓
     |                                | ④ onUnresolvedDoc("input:alice", peerA, ...)
     |                                |   → returns Interpret(PlayerInputDoc)
     |                                |   (no callback? two-tiered default:
     |                                |    supported type → Defer,
     |                                |    unsupported type → Reject silently)
     |                                |   → exchange.get("input:alice", PlayerInputDoc)
     |                                |   → storage hydration (if configured)
     |                                |   → registerDoc → doc-ensure dispatched
     |                                |
     | <── present ["input:alice"] ───| doc-ensure: announce + interest
     | <── interest { version: "0" } ─|
     |                                |
     |── offer { payload, version } ─>| handleOffer: import A's state
     |                                |
```

**Storage interaction**: When storage backends are configured, `exchange.get()` hydrates from storage before registering with the synchronizer. The synchronizer only learns about the doc after hydration, so `present`/`interest` messages carry the hydrated version — not an empty one.

### The `cmd/request-doc-creation` Command

When `handlePresent` encounters an unknown doc ID that passes the route check, the pure program emits:

```ts
{ type: "cmd/request-doc-creation", docId: DocId, peer: PeerIdentityDetails, replicaType: ReplicaType, mergeStrategy: MergeStrategy, schemaHash: string }
```

The `Synchronizer` runtime executes this command by calling the `DocCreationCallback` provided by the Exchange. The callback first attempts schema auto-resolution (§24), then falls through to `onUnresolvedDoc` if no schema matches. The callback is fire-and-forget — if it calls `exchange.get()`, the resulting `registerDoc()` → `#dispatch(doc-ensure)` is queued in `#pendingMessages` (because `#dispatching` is true) and processed before quiescence.

### Reentrancy Through the Dispatch Loop

The reentrancy path is safe because of the serialized dispatch architecture (§9):

1. `handlePresent` returns `[model, cmd/request-doc-creation]`
2. `#executeCommand` calls the callback
3. Callback calls `exchange.get()` → `synchronizer.registerDoc()` → `#dispatch(doc-ensure)`
4. `#dispatch` sees `#dispatching === true`, pushes `doc-ensure` to `#pendingMessages`, returns
5. Control returns to the dispatch loop, which processes `doc-ensure` next
6. `doc-ensure` emits `present` + `interest` messages, accumulated in the outbound queue
7. At quiescence, all messages are flushed together

The `Defer` path has its own reentrancy: callback → `synchronizer.deferDoc()` → `#dispatch(synchronizer/doc-defer)` → queued in `#pendingMessages` and processed before quiescence. The deferred doc is announced via `present` (routing participation) but no `interest` is sent.

### `doc-ensure` Sends Both `present` and `interest`

When a document is registered after channels are established (the dynamic creation case), `handleDocEnsure` sends **both** `present` and `interest` to all established channels:

- **`present`**: announces the doc to peers (they may create it via their own `onUnresolvedDoc`)
- **`interest`**: requests data from peers who already have the doc (essential for pulling content into the newly created empty doc)

When `handleDocEnsure` fires for a doc already in `model.documents` with `mode: "deferred"`, it promotes the entry: updates mode to `"interpret"` or `"replicate"`, sets the version, and sends both `present` and `interest`.

### Relationship to the Vendor Pattern

The vendor (`@loro-extended/repo`) handles this in `handleSyncRequest` — when a `sync-request` arrives for an unknown doc, the doc is auto-created, gated by `permissions.creation`. Kyneta's approach differs:

1. **Trigger point**: `present` (not `interest`/`sync-request`), because kyneta's `interest` is only sent for docs the sender already has.
2. **Capability gating**: The `supports` gate has been removed from the synchronizer — all unknown docs reach `onUnresolvedDoc`. The Exchange's two-tiered default uses `supportsReplicaType` to decide between Defer and Reject when no callback matches.
3. **Route gating**: The `route` predicate (§16) is checked before `cmd/request-doc-creation` is emitted. If `route(docId, announcingPeer)` returns `false`, the unknown doc is silently dropped — `onUnresolvedDoc` never fires.
4. **Auto-resolution**: Schema registry lookup happens before `onUnresolvedDoc` — most docs are resolved without any callback.
5. **Gating mechanism**: a callback returning an explicit disposition (`Interpret | Replicate | Defer | Reject`), because the callback must provide the schema/factory/strategy — information a boolean predicate cannot supply.
6. **No separate `creation` permission**: the callback subsumes the permission check. Returning `Reject()` is equivalent to denying creation.

> **Note**: `onUnresolvedDoc` fires for all unresolved docs regardless of replica type — the developer has full control when a callback is provided. The two-tiered default (Defer vs. Reject based on `supportsReplicaType`) only applies when no callback matches.

### Code Example

```ts
const exchange = new Exchange({
  // Declare known schemas — auto-resolved, onUnresolvedDoc never fires for these
  schemas: [PlayerInputDoc, GameStateDoc],

  // Policy for docs not matched by the schema registry
  onUnresolvedDoc: (docId, peer, replicaType, mergeStrategy, schemaHash) => {
    // Ad-hoc interpretation with an unregistered schema
    if (docId.startsWith("debug:")) return Interpret(DebugDoc)
    // Headless replication — Exchange resolves factory from registry
    if (docId.startsWith("relay:")) return Replicate()
    // Track for later promotion
    if (docId.startsWith("line:")) return Defer()
    // Explicit rejection
    return Reject()
  },
})
```

---

## 16. Route and Authorize — Information Flow Control

Two predicates on `ExchangeParams` control information flow through the sync protocol. They replace the vendor's four-predicate model (`visibility`, `mutability`, `creation`, `deletion`) with a cleaner two-axis decomposition: outbound flow (routing) and inbound flow (authority).

The `ExchangeParams` fields (`route`, `authorize`) are syntactic sugar for the initial scope. For dynamic rule composition — where multiple independent concerns register and remove their own predicates at runtime — see §23 (Composable Scope Registration).

### Predicate Signatures

```ts
type RoutePredicate = (docId: DocId, peer: PeerIdentityDetails) => boolean
type AuthorizePredicate = (docId: DocId, peer: PeerIdentityDetails) => boolean
```

Both default to `() => true` (open access).

### `route` — Outbound Flow Control

The `route` predicate gates all outbound messages. It answers: "should this peer participate in the sync graph for this document?"

| Gate | Handler | What `route: false` does |
|------|---------|--------------------------|
| Initial present | `handleEstablishRequest` / `handleEstablishResponse` | Doc omitted from `present` message |
| Doc-ensure broadcast | `handleDocEnsure` | Channel excluded from present+interest |
| Push (local change + relay) | `buildPush` | Channel excluded from offer |
| `onUnresolvedDoc` gating | `handlePresent` | `cmd/request-doc-creation` not emitted |

### `authorize` — Inbound Flow Control

The `authorize` predicate gates inbound data import. It answers: "should this peer's mutations be accepted for this document?"

| Gate | Handler | What `authorize: false` does |
|------|---------|-------------------------------|
| Offer import | `handleOffer` | `cmd/import-doc-data` not emitted; peer sync state still updated |

When `authorize` rejects an offer, the peer's sync state is still updated to prevent re-requesting. Only the data import is suppressed.

### The `route` → `authorize` Invariant

`authorize` implies `route`: if you accept mutations from a peer, that peer must be in the routing topology. The converse is not true — a read-only subscriber is routed but not authorized. The system does not enforce this formally. If a developer sets `authorize: () => true` but `route: () => false`, nothing breaks — inbound data never arrives because the outbound announcement was suppressed.

With composable scopes (§23), the invariant holds *in aggregate* — the composed `authorize` returning `true` only matters if the composed `route` also returns `true` for that peer. Individual scopes can safely have `authorize` without `route` (or vice versa) because the composition evaluates all scopes independently per field. The synchronizer only reaches `authorize` evaluation if the message was already routed.

### Relationship to `onUnresolvedDoc`

Gates are evaluated in order when a peer announces an unknown doc in `handlePresent`:

1. **`route`** — if `route(docId, announcingPeer)` returns `false`, silently drop. `onUnresolvedDoc` never fires.
2. **Schema auto-resolve** — if the `(schemaHash, replicaType, mergeStrategy)` triple matches a registered schema, auto-interpret. `onUnresolvedDoc` never fires.
3. **`onUnresolvedDoc`** — fires for all unresolved docs regardless of replica type. Returns an explicit disposition.
4. **Two-tiered default** — if no `onUnresolvedDoc` callback matches (or none is configured): supported `replicaType` → Defer; unsupported `replicaType` → Reject (silently).

After `onUnresolvedDoc` (or the two-tiered default) returns:
- `Interpret(bound)` → `exchange.get()` creates the doc
- `Replicate()` → `exchange.replicate()` creates the doc (factory from registry)
- `Defer()` → doc tracked for routing, no local representation
- `Reject()` → doc dropped
- Subsequent present/interest/offer flow is subject to `route` normally

This means `onUnresolvedDoc` can assume: the announcing peer already passed the route check and no registered schema matched. The `replicaType` may or may not be supported — the callback has full control regardless.

See `examples/bumper-cars/src/server.ts` for a concrete usage example — `route` restricts input doc visibility to the owning peer, and `authorize` enforces server-only writes to game state.

---

## 17. Dismiss — Leaving the Sync Graph

### The `dismiss` Wire Message

`dismiss` is the dual of `present`: present announces "I have this doc," dismiss announces "I'm leaving this doc." It is a one-way announcement with no response needed.

```ts
type DismissMsg = { type: "dismiss"; docId: DocId }
```

Wire encoding: `Dismiss: 0x13` in the CBOR codec (next after `Offer: 0x12`). Compact wire format: `{ t: 0x13, doc: string }`.

### `exchange.dismiss(docId)`

The single public API for document removal. Replaces the former `exchange.delete(docId)`.

```ts
exchange.dismiss("my-doc")
```

Internally: clears the doc from `#docCache`, then calls `synchronizer.dismissDocument(docId)`, which dispatches `synchronizer/doc-dismiss` to the TEA program. The program removes the doc from `model.documents` and broadcasts `dismiss` to all established channels (filtered by `route`).

For bulk teardown without per-doc notification, use `exchange.reset()` or `exchange.shutdown()`.

### `onDocDismissed` Callback

```ts
type OnDocDismissed = (docId: DocId, peer: PeerIdentityDetails) => void
```

Optional field on `ExchangeParams`. Fires when a peer sends `dismiss` for a document. The callback handles the application-level response — it can call `exchange.dismiss(docId)` to also leave, archive the document, or do nothing.

### Protocol Flow

```
Peer A                            Peer B
  |                                 |
  | exchange.dismiss("doc-1")       |
  | → #docCache.delete("doc-1")    |
  | → synchronizer.dismissDocument  |
  | → dispatch doc-dismiss          |
  | → handleDocDismiss:             |
  |   model.documents.delete        |
  |   cmd/send-message: dismiss     |
  |                                 |
  |── dismiss { docId: "doc-1" } ──>|
  |                                 | handleDismiss:
  |                                 |   clean up peer sync state
  |                                 |   cmd/notify-doc-dismissed
  |                                 |   → onDocDismissed("doc-1", peerA)
  |                                 |
```

### Peer State Cleanup

When `handleDismiss` processes a `dismiss` message from a peer, it removes the document from the peer's `docSyncStates` and `subscriptions`. This ensures:

- Future local changes for this doc are not pushed to the dismissed peer
- The peer's ready state no longer appears in `sync(doc).readyStates`

### The `cmd/notify-doc-dismissed` Command

```ts
{ type: "cmd/notify-doc-dismissed", docId: DocId, peer: PeerIdentityDetails }
```

Follows the same fire-and-forget pattern as `cmd/request-doc-creation`. The Synchronizer runtime calls the `DocDismissedCallback`, which the Exchange wraps to invoke the user's `onDocDismissed` callback.

---

## 18. Store — Direct Exchange Dependency

The exchange supports persistent storage through the `Store` interface. Storage is a **direct Exchange dependency** — not an adapter, not a channel, not a participant in the sync protocol. The Exchange handles hydration (loading from storage on `get()`/`replicate()`) and persistence (saving on network imports and local changes) directly. The synchronizer remains purely network-focused.

### StoreEntry

The unit of persistence:

```ts
type StoreEntry = {
  readonly payload: SubstratePayload
  readonly version: string
}
```

The `payload` carries its own `kind` discriminant (`"entirety"` or `"since"`), so no separate `entryType` field is needed. The `version` string is round-tripped faithfully from the original offer — storage never interprets it.

### DocMetadata

Per-document metadata registered alongside entries:

```ts
type DocMetadata = {
  readonly replicaType: ReplicaType
  readonly mergeStrategy: MergeStrategy
  readonly schemaHash: string
}
```

Registered via `ensureDoc()` before the first `append()`. Returned by `lookup()` for existence + metadata checks. The `schemaHash` field records the schema fingerprint at registration time — used by the synchronizer to validate compatibility on incoming `present` messages (§3).

### Store Interface

Seven document-level operations plus an optional lifecycle hook. Backends need no knowledge of the sync protocol, substrates, or schemas:

```ts
interface Store {
  lookup(docId: DocId): Promise<DocMetadata | null>
  ensureDoc(docId: DocId, metadata: DocMetadata): Promise<void>
  append(docId: DocId, entry: StoreEntry): Promise<void>
  loadAll(docId: DocId): AsyncIterable<StoreEntry>
  replace(docId: DocId, entry: StoreEntry): Promise<void>
  delete(docId: DocId): Promise<void>
  listDocIds(): AsyncIterable<DocId>
  close?(): Promise<void>
}
```

**Design decisions:**

- **`lookup()` replaces `has()`.** Returns `DocMetadata | null` — subsumes the existence check (`lookup(docId) !== null`) and provides metadata for free. This avoids a separate `has()` call followed by a metadata fetch.

- **`ensureDoc()` for metadata registration.** Called once before the first `append()`. Idempotent — calling again with the same metadata is a no-op. For `InMemoryStore`, this is a `Map<DocId, DocMetadata>`. For real backends (Postgres, IndexedDB), it's a single metadata row per document.

- **Document-level, not chunk-level.** The vendor uses `StorageKey = string[]` with `[docId, "update", timestamp]` key-space. This was rejected because timestamp-based keys cause collisions in multi-pod deployments and `removeRange` is unsafe under concurrent writes. The document-level interface operates at the natural granularity.

- **`AsyncIterable` for pagination.** `loadAll` and `listDocIds` return `AsyncIterable` rather than arrays. This supports million-doc stores (S3, Postgres) without loading everything into memory. In-memory backends trivially `yield*` from arrays.

- **Atomic `replace`.** Required for safe compaction. A concurrent reader must never observe an empty intermediate state. Achievable on all target backends: Postgres (transaction), LevelDB (batch), IndexedDB (transaction), Redis (MULTI/EXEC), in-memory (synchronous swap), S3 (write-before-delete).

- **Per-doc serialization.** The Exchange guarantees sequential operations per docId via promise chains (`#enqueueForDoc`) — backends assume single-writer-per-document semantics. Cross-document operations remain concurrent for throughput.

- **Optional `close()`.** Backends with native handles (LevelDB file descriptors, Postgres connections) implement `close()` to release resources. `Exchange.shutdown()` calls `close()` on all storage backends after flushing pending operations. In-memory backends omit it — no ceremony for backends that don't need it.

### InMemoryStore

A `Map<DocId, StoreEntry[]>`-backed implementation for testing. Uses `Map<DocId, DocMetadata>` for per-document metadata. Supports a `sharedData` constructor argument so multiple instances can share the same underlying Maps — useful for simulating persist → restart → hydrate:

```ts
const sharedData: InMemoryStorageData = {
  entries: new Map(),
  metadata: new Map(),
}

// Exchange 1: persist data
const exchange1 = new Exchange({
  stores: [createInMemoryStore({ sharedData })],
})
// ... mutations happen, storage persists ...
await exchange1.shutdown()

// Exchange 2: hydrate from storage
const exchange2 = new Exchange({
  stores: [createInMemoryStore({ sharedData })],
})
// Documents are restored from the shared storage
```

---

## 19. Storage Persistence Architecture

Storage is wired into the Exchange at two points: **hydration** (loading stored data into a fresh replica) and **persistence** (saving data as it changes). The synchronizer program is storage-free — keeping the FC/IS boundary clean. Persistence is unified through a single mechanism: the `notify/state-advanced` notification from the synchronizer program.

### Peer Identity Requirements

The `peerId` in `ExchangeParams.identity` must satisfy two invariants:

1. **Stability:** The same participant must use the same peerId across restarts. Without stability, each boot produces a different clientID/PeerID, the version vector grows unboundedly, and there is no causal continuity across restarts. `exchange.get()` requires an explicit peerId for this reason.

2. **Uniqueness:** Different participants must use different peerIds. Two peers sharing a peerId will silently corrupt CRDT state — the version vector conflates their operations and `exportSince` produces wrong deltas (missing ops, duplicate ops, or cross-client references). There is no error, no exception — just silent data loss.

**Duplicate detection:** The synchronizer detects duplicate peerIds at channel establishment time. When a second channel establishes with a peerId that already has active channels from a different connection, the synchronizer emits a `notify/warning` notification (surfaced as `console.warn` by the imperative shell). This catches the most common case — two browser tabs hitting the same server with the same peerId. The warning is not a rejection: legitimate reconnection (where the old channel hasn't timed out yet) may trigger it transiently.

**Self-connection detection:** When a peer connects to itself (remote peerId matches `model.identity.peerId`), the synchronizer emits a `notify/warning`. This is always a misconfiguration — syncing with yourself produces no useful result.

**Browser clients:** Use `persistentPeerId(storageKey)` from `@kyneta/exchange` to generate a random 16-char hex peerId on first visit and cache it in `localStorage`. This satisfies both stability (survives page reloads) and uniqueness (each browser profile gets its own peerId).

**Servers:** Use an explicit string (e.g. `"my-server"`). Servers don't need generation helpers.

`exchange.replicate()` does NOT require a stable peerId — replicate mode has no local writes and needs no stable identity.

### Hydration Flow — Single Substrate with Structural Merge

When `exchange.get()` is called with storage backends configured, the exchange store path uses a single substrate — no temp/bare replica split. With structural clientID 0 (jj:ptyzqoul), `factory.create(schema)` produces structural ops at `(0, 0..N)` — identical to the structural ops in any stored state. Merging stored entries into this substrate deduplicates structural ops via CRDT semantics and applies application ops into the shared containers.

```
exchange.get(docId, bound)
  → factory.create(schema) — live substrate (structural ops at clientID 0)
  → build interpreter stack from substrate
  → cache ref in #docCache (returned synchronously)
  → async #hydrateAndRegister(docId, substrate, factory, bound):
      1. ensureDoc(docId, metadata) on all backends
      2. loadAll(docId) → merge entries into the live substrate (changefeed fires)
      3. if first boot: append entirety base entry to store
      4. record storeVersion for incremental persistence
      5. registerDoc with synchronizer (version reflects hydrated state)
      6. wire changefeed → synchronizer (sync-only, no persistence)
```

The single-substrate design is enabled by the structural merge protocol (jj:ptyzqoul):
- **Deterministic structural ops:** `factory.create(schema)` with clientID 0 produces ops at `(0, 0), (0, 1), ...` — the same ops present in any stored state that was also created from the same schema. Merging stored data into this substrate is a no-op for structural ops and additive for application ops.
- **No identity conflict:** ClientID 0 is a reserved structural identity. The exchange sets the real peerId-derived clientID after hydration — structural ops remain at 0 regardless.
- **No upgrade step:** The old `#hydrateUpgradeAndRegister` two-phase flow (`createReplica` → hydrate bare → `upgrade` → merge into temp) is replaced by the unified `#hydrateAndRegister`. One substrate, one merge, no intermediate replica.

For `exchange.replicate()`, the flow is similar — no schema or interpreter stack, but the same single-substrate hydration via `#hydrateAndRegister`.

### Persistence — Unified via `notify/state-advanced`

All persistence flows through a single mechanism: the `notify/state-advanced` notification emitted by the synchronizer program at quiescence.

The Exchange subscribes to `synchronizer.onStateAdvanced(docId => ...)` in its constructor. The listener:

```
onStateAdvanced(docId):
  1. Look up storeVersion from #storeVersions
  2. If not found → return (doc still hydrating)
  3. Get runtime from synchronizer.getDocRuntime(docId)
  4. delta = runtime.replica.exportSince(storeVersion)
  5. If delta is null → return (version didn't advance)
  6. newVersion = runtime.replica.version()
  7. #storeVersions.set(docId, newVersion)
  8. #persistToStore(docId, backend.append(docId, { payload: delta, version }))
```

This handles **both** local mutations and network imports:

- **Local mutation:** `change(doc, fn)` → changefeed fires → `notifyLocalChange(docId)` → `handleLocalDocChange` → `notify/state-advanced` → `onStateAdvanced` → `exportSince(storeVersion)` → `append(since delta)`
- **Network import:** adapter receives offer → `#executeImportDocData` → `replica.merge(payload)` → `handleDocImported` → `notify/state-advanced` → `onStateAdvanced` → `exportSince(storeVersion)` → `append(since delta)`

Both paths produce small incremental `since` deltas via `append()` — not full `exportEntirety()` snapshots via `replace()`. The `replace()` operation is reserved for future compaction (collapsing accumulated deltas into a single entirety).

The changefeed subscriber is sync-only — it notifies the synchronizer but performs no persistence:

```ts
subscribe(ref, changeset => {
  if (changeset.origin === "sync") return
  this.#synchronizer.notifyLocalChange(docId)
})
```

### storeVersion Lifecycle

Each document tracks its last-persisted version in `#storeVersions: Map<DocId, Version>`. This is set:
- After hydration completes (to the replica's version post-hydration)
- After each successful `append()` (to the new version from `exportSince`)

The `storeVersion` enables incremental persistence: `exportSince(storeVersion)` produces only the operations not yet stored. Multiple state transitions in one dispatch cycle are batched — the notification fires once at quiescence, and the single `exportSince` covers all transitions.

### Flush Tracking

Every async storage operation is tracked in `#pendingStorageOps: Set<Promise<void>>`. The `flush()` method awaits all pending operations (looping to handle operations that spawn new ones). `shutdown()` flushes storage before disconnecting adapters.

### Per-Doc Sequential Access

The Exchange guarantees sequential backend access per document via `#enqueueForDoc()` — a promise-chain pattern where each new operation for a docId awaits the previous one. Cross-document operations remain concurrent for throughput.

### Backend Lifecycle

`Exchange.shutdown()` calls `backend.close()` on all storage backends (if implemented) after flushing pending operations and disconnecting adapters. This ensures native handles (LevelDB file descriptors, database connections) are released cleanly.

---

## 20. LevelDB Store

The `@kyneta/leveldb-store` package provides a server-side persistent `Store` using [classic-level](https://github.com/Level/classic-level). Located at `packages/exchange/storage-adapters/leveldb/`, imported via `@kyneta/leveldb-store/server`.

```ts
import { createLevelDBStore } from "@kyneta/leveldb-store/server"

const exchange = new Exchange({
  stores: [createLevelDBStore("./data/exchange-db")],
})
```

### Key-Space Design

LevelDB keys use `\x00` (null byte) as the separator — following the FoundationDB tuple-layer convention. Since null bytes cannot appear in valid UTF-8 strings, no docId validation is needed; the key-space imposes zero constraints on callers.

| Prefix | Key format | Value |
|--------|-----------|-------|
| `meta` | `meta\x00{docId}` | JSON-encoded `DocMetadata` |
| `entry` | `entry\x00{docId}\x00{seqNo}` | Binary-encoded `StoreEntry` |

`seqNo` is a zero-padded 10-digit monotonic counter per doc, tracked in an in-memory `Map<DocId, number>`. After a reboot, the max seqNo for a doc is lazily discovered via a single reverse-iterator seek on the first `append()` call — one LevelDB seek per doc, O(log N) in SSTables.

Prefix scans use the `\xff` sentinel pattern: `{ gte: "entry\x00docId\x00", lt: "entry\x00docId\x00\xff" }`.

### Binary Envelope Serialization

`StoreEntry` values are serialized as a compact binary envelope to avoid base64 inflation on binary payloads (Loro/Yjs documents are entirely binary):

1. **1 byte**: flags — bit 0 = kind (0=entirety, 1=since), bit 1 = encoding (0=json, 1=binary), bit 2 = data type (0=string, 1=Uint8Array)
2. **4 bytes**: version string length (uint32 big-endian)
3. **N bytes**: version string (UTF-8)
4. **remaining bytes**: payload data (raw bytes)

`encodeStoreEntry()` and `decodeStoreEntry()` are pure functions with no dependencies — trivially unit-testable.

### Atomicity

`replace()` uses `db.batch()` to atomically delete all existing entry keys and write the single replacement. A concurrent reader never observes an empty intermediate state.

`delete()` similarly uses `db.batch()` to atomically remove both the metadata key and all entry keys.

### Conformance Testing

The `Store` contract is validated by a reusable conformance test suite, available via `@kyneta/exchange/testing`:

```ts
import { describeStore } from "@kyneta/exchange/testing"

describeStore(
  "MyBackend",
  () => new MyBackend(),
  async (backend) => { if (backend.close) await backend.close() },
)
```

Both `InMemoryStore` and `LevelDBStore` pass the same suite. The suite covers lookup, ensureDoc, append, loadAll, replace, delete, listDocIds, and both JSON string and binary `Uint8Array` payload round-trips.

---

## 21. Peer Lifecycle Feed

The exchange exposes a reactive feed of peer presence via `exchange.peers` — a `CallableChangefeed<ReadonlyMap<PeerId, PeerIdentityDetails>, PeerChange>`. Peers join when their first channel completes the establish handshake; they leave when their last channel is removed.

### The `PeerChange` Type

```ts
interface PeerChange extends ChangeBase {
  readonly type: "peer-joined" | "peer-left"
  readonly peer: PeerIdentityDetails
}
```

`PeerChange` is defined in `src/types.ts` alongside the other core identity types. It extends `ChangeBase` from `@kyneta/changefeed`, making it compatible with the standard `Changeset<PeerChange>` envelope.

### The `exchange.peers` Changefeed

`exchange.peers` is a `CallableChangefeed` — callable as a function, with `.current` and `.subscribe()`, and the `[CHANGEFEED]` marker for protocol detection:

```ts
// Read current peers (callable)
const peers = exchange.peers()  // ReadonlyMap<PeerId, PeerIdentityDetails>

// Read current peers (property)
const peers = exchange.peers.current

// Subscribe to changes
const unsub = exchange.peers.subscribe((changeset) => {
  for (const change of changeset.changes) {
    if (change.type === "peer-joined") { /* ... */ }
    else { /* peer-left */ }
  }
})

// Protocol detection
hasChangefeed(exchange.peers) // true
```

The feed is created lazily by `Synchronizer.createPeerFeed()`, which calls `createChangefeed()` with a snapshot function `() => this.#peerMap` and stores the emit callback for later use.

### TEA Flow

Peer lifecycle notifications flow through the standard TEA pipeline:

```
upgradeChannel()          handleChannelRemoved()
  → first channel for        → last channel for
    a new peer                  a departing peer
  → notify/peer-joined       → notify/peer-left
          ↓                           ↓
    #accumulateNotification()
      → push PeerChange to #pendingPeerEvents
          ↓
    (at quiescence)
    #drainPeerEvents()
      → snapshot #pendingPeerEvents, clear field
      → rebuild #peerMap from model.peers (single source of truth)
      → emit Changeset<PeerChange> via the changefeed
```

The `#peerMap` is rebuilt from the model at quiescence rather than maintained incrementally. This ensures the map is always consistent with the model — even if multiple join/leave events occurred within a single dispatch cycle.

### Relationship to `onDocDismissed`

`onDocDismissed` (§17) and `peer-left` operate at different granularities:

| | `onDocDismissed` | `peer-left` |
|---|---|---|
| **Scope** | Per-document | Per-exchange |
| **Trigger** | Peer sends an explicit `dismiss` message for a specific document | All channels for a peer are removed (disconnect, shutdown, etc.) |
| **Requires peer cooperation** | Yes — the remote peer must send `dismiss` | No — fires on any channel loss |
| **Use case** | React to a peer voluntarily leaving a document's sync graph | Track peer presence for UI, cleanup, etc. |

A peer can `dismiss` a document while remaining connected to the exchange (other documents still syncing). Conversely, a peer can vanish (network failure, crash) without sending any `dismiss` — `peer-left` fires but `onDocDismissed` does not.

### Cast Integration

Because `exchange.peers` carries the `[CHANGEFEED]` marker, Cast's automatic changefeed detection wires it into compiled views without explicit configuration. The delta kind falls back to `"replace"` — each changeset triggers a full re-read of the `ReadonlyMap`. This is appropriate because the peer map is small (typically single-digit entries) and changes infrequently.

### Reset and Shutdown — Synthetic Emission

Both `exchange.reset()` and `exchange.shutdown()` call `#emitSyntheticPeerLeftEvents()` before wiping the model. This method:

1. Returns immediately if there are no peers or no emit callback.
2. Builds a `PeerChange[]` array with `type: "peer-left"` for every peer in `model.peers`.
3. Clears `#peerMap` to an empty map (consistent with the about-to-be-wiped model).
4. Emits the full array as a single `Changeset<PeerChange>`.

This guarantees that subscribers always observe a balanced join/leave lifecycle — every `peer-joined` is eventually paired with a `peer-left`, even during teardown. The synthetic events bypass the normal quiescence drain because `reset()` is synchronous and `shutdown()` needs to emit before the model is cleared.

### Multi-Transport Deduplication

A single peer may connect through multiple transports (e.g. both WebSocket and SSE). The model tracks a `channels: Set<ChannelId>` per peer in `model.peers`. The deduplication is straightforward:

- **Join:** `upgradeChannel()` adds the channel to the peer's channel set. If `!existingPeer` (this is the first channel), it emits `notify/peer-joined`. Otherwise, the channel is simply added to the existing set — no notification.
- **Leave:** `handleChannelRemoved()` removes the channel from the set. If `newChannels.size === 0` (last channel gone), it deletes the peer from `model.peers` and emits `notify/peer-left`. Otherwise, only `notify/ready-state-changed` fires for affected docs (the peer lost a transport but is still present).

This means `peer-joined` fires exactly once per peer identity regardless of how many channels connect, and `peer-left` fires only when the peer is truly unreachable.

---

## 22. WebRTC Transport (`@kyneta/webrtc-transport`)

BYODC (Bring Your Own Data Channel) transport for peer-to-peer document synchronization over WebRTC data channels. The application manages WebRTC connections (signaling, ICE, media streams); this transport attaches to already-established data channels for kyneta sync.

### Package Structure

Single `"."` export — WebRTC data channels are symmetric (no client/server distinction):

| Export | Key Exports |
|--------|-------------|
| `"."` | `WebrtcTransport`, `createWebrtcTransport`, `DataChannelLike`, `WebrtcTransportOptions` |

### `DataChannelLike` — Minimal Interface, Not DOM Type

The vendor adapter (`@loro-extended/adapter-webrtc`) types `attachDataChannel` as `(peerId, channel: RTCDataChannel)`. This forces library-specific wrappers to implement `Partial<RTCDataChannel>` (~30 members) and cast via `as unknown as RTCDataChannel`. Analysis of the vendor video-conference example revealed several friction points:

1. **`binaryType` write is silently lost** — the adapter writes `"arraybuffer"` but wrappers often lack this property
2. **`instanceof ArrayBuffer` check fails for `Uint8Array`/`Buffer` data** — simple-peer delivers `Buffer` (a `Uint8Array` subclass) which doesn't pass `instanceof ArrayBuffer`
3. **Single-listener-per-type** — the wrapper's `addEventListener` overwrites previous listeners
4. **~160-line wrapper class** required for simple-peer integration

`DataChannelLike` captures the exact surface the transport uses — 5 members:

| Member | Usage |
|--------|-------|
| `readyState: string` | Read — check `=== "open"` before sending |
| `binaryType: string` | Write — best-effort hint, not a correctness requirement |
| `send(data: Uint8Array)` | Call — deliver encoded wire frames |
| `addEventListener(type, listener)` | Call — register for `"open"`, `"close"`, `"error"`, `"message"` |
| `removeEventListener(type, listener)` | Call — clean up on detach |

Native `RTCDataChannel` satisfies this structurally (no wrapper needed). Libraries like simple-peer can bridge in ~20 lines via a factory function that maps EventEmitter events to `addEventListener` calls.

### `addEventListener` vs `onMessage` Design Asymmetry

The WebSocket transport defines an internal `Socket` interface with `onMessage(handler)` — callback registration. `DataChannelLike` uses `addEventListener` / `removeEventListener` (DOM EventTarget pattern). The difference is intentional:

- `Socket` is an **internal** interface wrapping things the transport creates and owns. Single callback is fine.
- `DataChannelLike` is a **user-provided** interface wrapping things the application creates. The transport needs `removeEventListener` to clean up on detach — something the `onMessage` pattern doesn't support. And native `RTCDataChannel` uses `addEventListener`, so conformance is structural.

### Binary Pipeline

Uses the same shared binary pipeline as the WebSocket transport via `encodeBinaryAndSend` and `decodeBinaryMessages` from `@kyneta/wire`. Zero code duplication.

### Fragment Threshold

Default: 200KB (SCTP's ~256KB message limit). This differs from WebSocket's 100KB default which targets AWS API Gateway's 128KB limit. WebRTC has no such gateway.

### Ownership Contract

The transport does NOT own the data channel. `detachDataChannel()` removes the sync channel and event listeners but does NOT close the data channel or the peer connection. The application manages the WebRTC connection lifecycle independently.

### Robustness: `ArrayBuffer | Uint8Array`

The message handler accepts both `ArrayBuffer` (native `RTCDataChannel` with `binaryType: "arraybuffer"`) and `Uint8Array` (simple-peer and other wrappers). The `binaryType` write on attach is a best-effort hint — the handler does not depend on it being respected.

### Relationship to Video Conference Example

The examples roadmap plans a video-conference example that uses SSE for server-mediated sync and WebRTC for low-latency peer-to-peer sync (dual-transport). Signaling (offer/answer/ICE candidates) flows through the `Line` primitive (§25) — reliable ordered bidirectional messaging between peer pairs, with automatic ack-based pruning. This replaces the earlier ephemeral-document approach, which suffered from signal accumulation and broadcast inefficiency. The `fromSimplePeer()` bridge pattern demonstrated in the test suite shows how to connect `simple-peer` to the transport.

---

## 22. Unix Socket Transport (`@kyneta/unix-socket-transport`)

Stream-oriented server-to-server transport over Unix domain sockets (UDS). Designed for same-machine microservice topologies where TCP/WebSocket overhead is unnecessary. Uses the Stream pipeline (§11) — CBOR encoding with `StreamFrameParser` for byte-stream framing.

### Stream vs Message Transport — Why It Matters

WebSocket, WebRTC, and SSE are **message-oriented** transports: each `send()` delivers a discrete message with inherent boundaries. Unix domain sockets are **stream-oriented**: the kernel coalesces writes and delivers bytes in arbitrary chunks. A single `read()` may contain half of one message, three complete messages, or one and a half messages.

This distinction determines the entire framing strategy. Message-oriented transports need fragmentation (splitting large messages to fit transport limits) and reassembly. Stream transports need the opposite — a parser that extracts message boundaries from a continuous byte stream. Fragmentation is unnecessary because UDS has no message size limits, and the `FragmentCollector` is unnecessary because there are no fragments to collect. The 7-byte binary frame header's payload length field is sufficient: read the header, read that many payload bytes, emit the frame.

### `StreamFrameParser` — FC/IS Design (Pure Step Function `feedBytes`)

The `StreamFrameParser` is implemented as a pure step function in `@kyneta/wire`:

```
feedBytes(state: StreamParserState, chunk: Uint8Array) → { state: StreamParserState, frames: Uint8Array[] }
```

`StreamParserState` is a discriminated union with two phases:

| Phase | Accumulating | Transitions When |
|-------|-------------|-----------------|
| `"header"` | Bytes 0–6 of the next frame | 7 header bytes accumulated → read payload length → enter `"payload"` |
| `"payload"` | Payload bytes (length from header) | All payload bytes accumulated → emit complete frame → enter `"header"` |

The FC/IS boundary is clean:

- **Functional core** (`feedBytes`): pure, no side effects, no mutation of inputs. Accepts the current state and a new chunk, returns the next state and zero or more complete frames. Handles all chunk-boundary scenarios: partial headers, partial payloads, write coalescing (multiple frames in one chunk), empty chunks, byte-at-a-time delivery.
- **Imperative shell** (`UnixSocketConnection.#handleData`): calls `feedBytes` on each socket `data` event, then decodes each emitted frame via `decodeBinaryFrame` + `cborCodec.decode` and delivers the resulting `ChannelMsg` to the channel.

The parser's state is carried explicitly — no closures, no mutable parser object. Each `feedBytes` call returns a fresh state value, making the parser trivially testable and composable.

### No Fragmentation, No Transport Prefixes, No "Ready" Handshake

Three simplifications relative to the WebSocket and WebRTC transports, each with a specific justification:

| Omission | WebSocket/WebRTC Has It Because | UDS Doesn't Need It Because |
|----------|--------------------------------|----------------------------|
| **Fragmentation** | AWS API Gateway: 128KB limit (WS). SCTP: ~256KB limit (WebRTC). | UDS has no message size limits. The kernel handles arbitrarily large writes. |
| **Transport prefix bytes** (`0x00`/`0x01`) | Distinguishes complete vs fragment frames at the transport level, before parsing. | No fragments exist. Every frame is complete. The 7-byte header is the only framing. |
| **"Ready" handshake** | WebSocket's `open` event fires on TCP connect, but the server's message handler may not be wired up yet. The text `"ready"` signal prevents the race. | UDS connections are bidirectionally ready immediately. `connect()` resolves only when the server's `accept()` completes, so both sides are wired up. |

The result is the simplest binary pipeline in the transport family: `encodeComplete(cborCodec, msg)` produces a complete binary frame (7-byte header + CBOR payload), `socket.write()` sends it, `feedBytes` extracts it on the other side.

### `UnixSocket` Interface (Parallel to WebSocket's `Socket` Interface)

The WebSocket transport defines an internal `Socket` interface (message-oriented: `send`, `onMessage`). The unix socket transport defines an analogous `UnixSocket` interface (stream-oriented: `write`, `onData`, `onDrain`):

| Member | Type | Purpose |
|--------|------|---------|
| `write(data: Uint8Array)` | `→ boolean` | Write bytes. Returns `false` when the kernel buffer is full (backpressure). |
| `end()` | `→ void` | Signal end-of-stream and close gracefully. |
| `onData(handler)` | callback | Register handler for incoming byte chunks. |
| `onClose(handler)` | callback | Register handler for connection close. |
| `onError(handler)` | callback | Register handler for errors. |
| `onDrain(handler)` | callback | Register handler for backpressure drain (buffer available again). |

The key difference from `Socket` is the `write` return value and `onDrain` — stream sockets expose kernel buffer pressure, which message-oriented WebSocket APIs abstract away. Platform-specific wrappers (`wrapNodeUnixSocket`, `wrapBunUnixSocket`) adapt concrete implementations to this interface.

### Backpressure Handling (Write Queue + Drain)

`UnixSocketConnection` maintains a write queue for backpressure:

1. `send(msg)` encodes the message to a binary frame and calls `socket.write(frameBytes)`.
2. If `write()` returns `false`, the connection enters **draining mode**. Subsequent `send()` calls queue frames instead of writing.
3. When the kernel buffer drains, the socket emits a `drain` event. The connection's `#flushWriteQueue()` writes queued frames in order until either the queue is empty (exit draining mode) or `write()` returns `false` again (remain in draining mode, wait for next drain).

This is the standard Node.js/Bun backpressure pattern. The write queue is imperative state; encoding is pure. The FC/IS boundary holds: `encodeComplete` (pure) produces bytes, the write queue + drain handler (imperative) manages delivery timing.

### Socket Path Lifecycle (Stale Cleanup, Permissions)

The server transport manages the socket file through its full lifecycle:

- **`onStart()`**: If `cleanup: true` (the default), checks whether a socket file already exists at the configured path. If it does and `stat()` confirms it's a socket, removes it before calling `listen()`. This handles `EADDRINUSE` from a previous process that crashed without cleanup. If the file doesn't exist (`ENOENT`), the cleanup is a no-op.
- **`onStop()`**: Closes all active connections, stops the listener, and `unlink()`s the socket file. Errors during unlink are logged but do not throw — stop should be as graceful as possible.
- **Permissions**: Socket file permissions are inherited from the process `umask`. The transport does not set explicit permissions — the deployer controls access via `umask` or filesystem ACLs.

Client-side, `connect()` failures surface specific `errno` codes (`ENOENT` = no socket file, `ECONNREFUSED` = file exists but no listener, `EACCES` = permission denied) via the `DisconnectReason` discriminated union's `errno` field.

### Node vs Bun API Differences and the Wrapper Pattern

Both the client `connect()` and server `listen()` functions use runtime detection (`typeof globalThis.Bun !== "undefined"`) to select between two implementations:

| Concern | Node.js (`net` module) | Bun (`Bun.connect` / `Bun.listen`) |
|---------|----------------------|-----------------------------------|
| **Socket creation** | `net.createConnection(path)` — returns a `net.Socket` | `Bun.connect({ unix: path, socket: { ... } })` — callbacks in options |
| **Event model** | EventEmitter: `socket.on("data", handler)` | Callback-based: handlers passed at creation time |
| **Backpressure signal** | `socket.write()` returns `boolean` | `socket.write()` returns `number` (bytes written; 0 = full) |
| **Incoming data type** | `Buffer` (a `Uint8Array` subclass) | `Uint8Array` |

The `wrapNodeUnixSocket` wrapper is thin — it maps `socket.on(event, handler)` to the `UnixSocket` interface and wraps `Buffer` → `Uint8Array` on incoming data. The `wrapBunUnixSocket` wrapper is structurally different: because Bun's socket API is callback-based (handlers must be provided at creation time, not registered after), it returns both a `UnixSocket` and a `BunSocketHandlers` object. The caller wires the handlers into Bun's callback structure by storing them on the socket's `data` property.

This dual-wrapper pattern avoids importing either `node:net` or Bun types at the module level — both paths use dynamic `import()` and structural typing (`NodeUnixSocketLike`, `BunUnixSocketLike`) instead of concrete runtime types.

### Package Structure

Single `"."` export — everything available from `@kyneta/unix-socket-transport`:

| Export | Entry | Key Exports |
|--------|-------|-------------|
| `.` | `src/index.ts` | `createUnixSocketPeer`, `UnixSocketPeer`, `UnixSocketServerTransport`, `UnixSocketClientTransport`, `createUnixSocketClient`, `UnixSocketConnection`, `connect`, `listen`, `UnixSocket`, `wrapNodeUnixSocket`, `wrapBunUnixSocket` |

The top-level barrel re-exports server, client, peer negotiation, connection, platform wrappers, and all shared types.

### `createUnixSocketPeer` — Leaderless Topology Negotiation

`createUnixSocketPeer(exchange, { path })` encapsulates the connect-or-listen-then-heal pattern as a `Program<PeerMsg, PeerModel, PeerEffect>` from `@kyneta/machine`. The pure program (`peer-program.ts`) encodes every state transition and effect as data; the imperative shell (`peer.ts`) interprets effects as I/O.

**Pure program (functional core):**

The peer program defines:
- `PeerModel`: `{ role: "negotiating" | "listener" | "connector" | "disposed", transportId: string | undefined }`
- `PeerMsg`: `probe-result`, `transport-added`, `listen-failed`, `transport-disconnected`, `dispose`
- `PeerEffect`: `probe`, `start-listener`, `start-connector`, `remove-transport`, `delay-then-probe`

Every state × event transition is a pure function returning `[PeerModel, ...PeerEffect[]]`. The decision logic formerly in `decideRole` is inlined into the `update` function.

**Effect executor (imperative shell):**

The executor in `peer.ts` pattern-matches each `PeerEffect` and performs I/O:
- `probe` → test-connect to the socket path, dispatch `probe-result`
- `start-listener` → create `UnixSocketServerTransport`, add to Exchange, dispatch `transport-added`
- `start-connector` → create `UnixSocketClientTransport`, subscribe to transitions, add to Exchange, dispatch `transport-added`
- `remove-transport` → `exchange.removeTransport()`
- `delay-then-probe` → `setTimeout` + probe

This follows the same FC/IS split as the Synchronizer's `#executeCommand`. The program uses data effects (not closure effects) because data is inspectable in tests — `expect(effects).toEqual([{ type: "probe", path: "/tmp/test.sock" }])`.

**Negotiation flow:**

1. Init → `{ role: "negotiating" }` + `probe` effect
2. `probe-result "connected"` → `start-connector` effect
3. `probe-result "enoent"/"econnrefused"` → `start-listener` effect
4. `probe-result "eaddrinuse"` → `delay-then-probe` effect (retry)
5. `transport-disconnected` (connector) → `remove-transport` + `probe` (healing)
6. `dispose` → `{ role: "disposed" }` + optional `remove-transport`

The returned `UnixSocketPeer` exposes `role` (reactive `"listener" | "connector" | "negotiating" | "disposed"`) and `dispose()` for cleanup.

### Client Program (`createUnixSocketClientProgram`)

The Unix Socket client lifecycle is a pure Mealy machine: `Program<UnixSocketClientMsg, UnixSocketClientState, UnixSocketClientEffect>`. The transport class instantiates it via `createObservableProgram` and interprets data effects as I/O.

**4-state lifecycle** — identical to SSE, no "ready" phase (UDS connections are bidirectionally ready immediately — `connect()` resolves only when the server's `accept()` completes):

```
disconnected → connecting → connected
                   ↓            ↓
              reconnecting ← ─ ─┘
                   ↓
              connecting (retry)
                   ↓
              disconnected (max retries)
```

Reconnection uses exponential backoff with jitter, computed by the pure `tryReconnect` helper inside the program's `update` function. The `DisconnectReason` discriminated union carries socket-specific `errno` codes (`ENOENT`, `ECONNREFUSED`, `EADDRINUSE`, `EACCES`), enabling callers to distinguish socket-specific failures from generic errors. The `connection-error` message includes an optional `errno` field that the imperative shell extracts from the underlying socket error.

### Benchmarks

Measured on the same-machine path (loopback) comparing unix socket transport to WebSocket transport over `ws://localhost`:

| Message Size | WebSocket (msg/s) | Unix Socket (msg/s) | Speedup |
|-------------|-------------------|---------------------|---------|
| 256 B | baseline | 3.8× | **3.8×** |
| 1 KB | baseline | 1.8× | **1.8×** |

The speedup comes from three sources: (1) no TCP/HTTP upgrade overhead — UDS `connect()` is a single syscall, (2) no per-message WebSocket framing (masking, opcode, extended length) — just the 7-byte binary frame header, and (3) no fragmentation/reassembly overhead. The advantage narrows at larger message sizes because the payload dominates the per-message overhead. For same-machine service-to-service communication, the unix socket transport is the preferred choice.

### Integration Tests

End-to-end tests in `transports/unix-socket/src/__tests__/` prove the full stack over real unix sockets: channel establishment, client reconnection after server restart, stale socket cleanup, `ENOENT` handling (no server), socket file cleanup on shutdown, and multiple simultaneous clients. Tests use `os.tmpdir()` with random suffixes for socket paths to avoid collisions.

---

## 23. Composable Scope Registration

The Exchange accepts `route`, `authorize`, `onUnresolvedDoc`, and `onDocDismissed` as fixed functions in `ExchangeParams`. These work well when all document access rules are known at construction time. But higher-level primitives (Lines, rooms, game loops) need to register their own rules dynamically and remove them when done. The scope registration system generalizes the fixed predicates into a composable, dynamic model.

### The Scope Type

A **Scope** is a bundle of predicates and handlers governing a region of the document space:

```ts
interface Scope {
  name?: string
  route?: RulePredicate
  authorize?: RulePredicate
  onUnresolvedDoc?: OnUnresolvedDoc
  onDocDismissed?: OnDocDismissed
}
```

All fields are optional — a scope only provides the predicates it cares about.

### `RulePredicate` — Three-Valued Logic

```ts
type RulePredicate = (docId: DocId, peer: PeerIdentityDetails) => boolean | undefined
```

- `true` — this scope explicitly allows the operation.
- `false` — this scope explicitly denies the operation (short-circuits evaluation).
- `undefined` — this scope has no opinion (the doc is outside its concern).

The existing `RoutePredicate` and `AuthorizePredicate` types return `boolean`, which is a subtype of `boolean | undefined`. No adapter or wrapper is needed — existing predicates work as scope fields directly.

### `composeRule` — Pure Functional Core

A single pure function handles three-valued predicate composition for both `route` and `authorize`:

```ts
function composeRule(
  scopes: readonly Scope[],
  field: "route" | "authorize",
  docId: DocId,
  peer: PeerIdentityDetails,
  defaultWhenAllUndefined: boolean,
): boolean
```

Evaluation semantics (with short-circuit):

1. If any scope returns `false` → return `false` immediately (deny wins).
2. If at least one scope returns `true` and none return `false` → return `true`.
3. If all scopes return `undefined` → return `defaultWhenAllUndefined`.

### `ScopeRegistry` — Imperative Shell

The `ScopeRegistry` manages the mutable scope list and delegates composition to `composeRule`:

- **`register(scope): () => void`** — adds a scope, returns a dispose function.
- **`route(docId, peer): boolean`** — composed route, defaults to open (`true`).
- **`authorize(docId, peer): boolean`** — composed authorize, defaults to open (`true`).
- **`onUnresolvedDoc(...): Disposition | undefined`** — first non-`undefined` wins (registration order).
- **`docDismissed(docId, peer): void`** — all handlers invoked (broadcast, not gate).
- **`clear(): void`** — removes all scopes. Called during `reset()` and `shutdown()`.
- **`get names: readonly string[]`** — names of all named scopes, in registration order.

### `exchange.register(scope)` — Public API

```ts
const dispose = exchange.register({
  name: "line:bob",
  route: (docId, peer) => docId.startsWith("line:bob:") ? peer.peerId === "bob" : undefined,
  authorize: (docId, peer) => docId.startsWith("line:bob:") ? peer.peerId === "bob" : undefined,
  onUnresolvedDoc: (docId) => docId.startsWith("line:bob:") ? Defer() : undefined,
})

// Later, when the line is no longer needed:
dispose()
```

The dispose function removes the scope from all compositions. After disposal, the composed predicates no longer include that scope's rules.

### Composition Semantics by Field

| Field | Composition | Default (all `undefined`) |
|-------|------------|--------------------------|
| `route` | Deny wins, short-circuit | `true` (open) |
| `authorize` | Deny wins, short-circuit | `true` (open) |
| `onUnresolvedDoc` | First non-`undefined` wins (registration order) | `undefined` (reject with warning) |
| `onDocDismissed` | All handlers invoked (broadcast) | no-op |

### Default Values — Both Open

Both `route` and `authorize` default to `true` (open) when all scopes return `undefined`. This matches the current Exchange behavior where both default to `() => true`. Dynamic scopes that want to restrict access return `false` for specific docs; the open default preserves backward compatibility.

If a future use case requires closed-by-default authorize, register a base scope with `authorize: () => false` and then register permissive scopes for specific docs. The infrastructure supports both patterns; the default matches the existing Exchange contract.

### Named Scopes

If a scope has a `name`:

- **Debuggability**: the Exchange can log which named scope was responsible for a denial.
- **Introspection**: `registry.names` returns the list of registered scope names.
- **Replacement**: registering a scope with a name that already exists replaces the previous scope in-place (preserving its position in the evaluation order). This enables hot-reload patterns where a module re-registers its rules without accumulating stale scopes.

### Relationship to `ExchangeParams`

The constructor fields (`route`, `authorize`, `onUnresolvedDoc`, `onDocDismissed`) are syntactic sugar for the initial scope. At construction time, if any are provided, they are bundled into a `Scope` and registered with the `ScopeRegistry`. This is backward compatible — existing code that passes these params works identically.

The difference: previously, `route: () => true` was the only predicate. Now it's one scope among potentially many. A later `exchange.register({ route: ... })` adds a second scope whose `route` participates in the composition.

### Synchronizer Integration

The `ScopeRegistry` is transparent to the synchronizer layer. The Exchange passes `this.#scopes.route.bind(this.#scopes)` and `this.#scopes.authorize.bind(this.#scopes)` to the Synchronizer constructor. The synchronizer-program's `createSynchronizerUpdate()` closes over these functions and calls them on every message — the handlers don't know or care that the predicate is composed. Dynamic scope registration and disposal are visible through the bound closures without recreating the update function.

### Performance

Scopes scale with the number of *concerns* (typically single digits to low tens), not the number of *documents*. Short-circuit evaluation on the first `false` bounds the per-message cost. The `composeRule` function iterates the scope array once per evaluation — no allocations, no closures created at evaluation time.

### `reset()` and `shutdown()`

Both operations clear all scopes (including the initial one). After either, the Exchange is inert — all scopes are cleared, all transports are torn down, and the Exchange should not be reused.

---

## 24. Capability Registries and Document Classification

The Exchange maintains two capability registries that model what binary formats and schemas it can handle. These registries decouple **capability** (what I understand) from **policy** (what I choose to do), enabling auto-interpretation of known schemas and explicit classification of unknown docs.

### Three Semantic Layers

Document identity decomposes into three layers, each refining the previous:

| Layer | Components | Where it lives | Who needs it |
|-------|-----------|----------------|-------------|
| **Wire metadata** (`DocMetadata`) | `replicaType + mergeStrategy + schemaHash` | `present` messages, `DocEntry` | Everyone — the document's public identity |
| **Replication binding** (`BoundReplica`) | `ReplicaFactory + MergeStrategy` | `ExchangeParams.replicas`, capabilities registry | Relays, storage, any headless participant |
| **Schema binding** (`BoundSchema`) | `schema + FactoryBuilder + strategy + schemaHash` | Module-scope declarations, `ExchangeParams.schemas` | Interpreting participants (clients, app servers) |

`BoundSchema` refines `BoundReplica` with schema knowledge. `BoundReplica` refines wire metadata with a resolved factory. Every `BoundSchema` contains a `BoundReplica` by projection.

`BoundReplica` captures the pair that fully determines headless replication behavior: the `ReplicaFactory` (wire format + version algebra + construction) and the `MergeStrategy` (sync protocol dispatch). This pair must be consistent — `plainReplicaFactory` uses `PlainVersion` (monotonic counter, log-offset-based deltas) while `lwwReplicaFactory` uses `TimestampVersion` (wall clock, entirety-only export). They share the same wire format `["plain", 1, 0]` but differ in version algebra, so `replicaType` alone is not sufficient to identify a replication binding.

### Two Registries

The `Capabilities` object holds both registries in a single nested `Map`:

1. **`schemas`** — indexed by `(schemaHash, replicaType[name, major], mergeStrategy)`. Registers document types the Exchange can interpret. Each `BoundSchema` carries a `schemaHash`, a `FactoryBuilder` (which produces a `ReplicaFactory` with a `replicaType`), and a `MergeStrategy`.

2. **`replicas`** — indexed by `(replicaType[name, major], mergeStrategy)`. Registers replication modes for headless participation. A `schemas` entry implies replica capability — registering `bindLoro(S)` auto-derives the corresponding `BoundReplica`. The reverse is not true.

The internal data structure is a single `Map<ReplicaKey, ReplicaEntry>`:

```ts
type ReplicaKey = string  // `${replicaTypeName}:${replicaTypeMajor}:${mergeStrategy}`
type ReplicaEntry = {
  replica: BoundReplica
  schemas: Map<string /* schemaHash */, BoundSchema>
}
```

Schema lookup is a two-level operation: outer map by `ReplicaKey`, inner map by `schemaHash`. This nesting makes the containment relationship `BoundSchema ⊃ BoundReplica` structurally explicit — a schema entry cannot exist without a corresponding replica entry.

```
Map<ReplicaKey, ReplicaEntry>
  "plain:1:sequential" → { replica: BoundReplica(plainReplicaFactory, "sequential"), schemas: {} }
  "plain:1:lww"        → { replica: BoundReplica(lwwReplicaFactory, "lww"),          schemas: {} }
  "loro:1:causal"      → { replica: BoundReplica(loroReplicaFactory, "causal"),      schemas: { "00abc..." → bindLoro(S) } }
```

Lookup paths:
- **`resolveSchema(schemaHash, replicaType, mergeStrategy)`** — compute `ReplicaKey`, look up outer entry, then `schemaHash` in `entry.schemas`. Two O(1) lookups.
- **`resolveReplica(replicaType, mergeStrategy)`** — compute `ReplicaKey`, look up outer entry, return `entry.replica`. One O(1) lookup.
- **`supportsReplicaType(replicaType)`** — O(1) via a parallel `Set<string>` of `${name}:${major}` values (hot path, called per-doc in `handlePresent`).

### Default Replicas

```ts
const DEFAULT_REPLICAS: readonly BoundReplica[] = [
  BoundReplica(plainReplicaFactory, "sequential"),
  BoundReplica(lwwReplicaFactory, "lww"),
]
```

An Exchange with no explicit configuration can replicate sequential documents (via `plainReplicaFactory`) and LWW/ephemeral documents (via `lwwReplicaFactory`). Both use the `["plain", 1, 0]` wire format but with the correct version algebra for each strategy. Loro documents are registered automatically when `exchange.get()` is called with a Loro `BoundSchema` (which calls `registerSchema()` internally). Explicit upfront registration via `schemas: [bindLoro(S)]` or `replicas: [BoundReplica(loroReplicaFactory, "causal")]` is still valuable for the `present`-before-`get()` race — it ensures the Exchange can auto-resolve or defer remote Loro docs before the application calls `get()`.

### Dynamic Schema Registration

```ts
exchange.registerSchema(bound: BoundSchema): void
```

Registers a `BoundSchema` at runtime. The Exchange:

1. Adds it to the `Capabilities` registry (schema map + auto-derived replica capability).
2. Scans deferred docs in `model.documents` for triple matches.
3. For each match, auto-promotes: internally calls `exchange.get(docId, matchedBound)`.

This is the mechanism that enables higher-level primitives (e.g. Lines) to register their envelope schemas when they're constructed, not when the Exchange is constructed. A deferred doc whose schema didn't exist at discovery time is automatically promoted when the schema becomes available — no manual `exchange.get()` per doc required.

`exchange.get()` calls `registerSchema(bound)` internally, so `ExchangeParams.schemas` is sugar for upfront registration but not required. The role distinction: `schemas:` ensures readiness at construction time (handles the `present`-before-`get()` race — a peer may announce a doc before the local code calls `get()`, and without prior registration the doc would be deferred or rejected rather than auto-interpreted); `get()` expands capabilities at use time.

### The Document Lifecycle State Machine

| State | In `model.documents`? | Has `Replica`? | Sends `present`? | Sends `interest`? |
|-------|----------------------|----------------|-------------------|-------------------|
| **Rejected** | No | No | No | No |
| **Deferred** | Yes (`mode: "deferred"`) | No | Yes (routing) | No |
| **Replicated** | Yes (`mode: "replicate"`) | Yes (headless) | Yes | Yes |
| **Interpreted** | Yes (`mode: "interpret"`) | Yes (`Substrate`) | Yes | Yes |

- **Rejected**: `onUnresolvedDoc` returned `Reject()`, or no callback and unsupported replica type (two-tiered default).
- **Deferred**: Acknowledged for routing. No local representation. Awaiting schema registration or explicit promotion. Also the default when no callback matches and the replica type is supported (two-tiered default).
- **Replicated** / **Interpreted**: Full participation, as today.

Transitions:

| From | To | Trigger |
|------|----|---------|
| — | Rejected | `onUnresolvedDoc` returns `Reject()`, or no callback and unsupported replica type |
| — | Deferred | `onUnresolvedDoc` returns `Defer()`, or no callback and supported replica type |
| — | Replicated | `onUnresolvedDoc` returns `Replicate()`, or `exchange.replicate()` |
| — | Interpreted | Schema auto-resolve, `onUnresolvedDoc` returns `Interpret(bound)`, or `exchange.get()` |
| Deferred | Interpreted | `exchange.get(docId, bound)`, or auto-promoted when `exchange.registerSchema(bound)` matches |
| Deferred | Replicated | `exchange.replicate(docId)` |

Deferred docs participate in routing (`present` is sent) but do not receive data (`interest` is not sent, `handleOffer` and `handleInterest` return early for deferred entries).

### Validation Model

When a peer sends `present` with `{ replicaType, mergeStrategy, schemaHash }`:

**Unknown docs:**

| Scenario | `replicaType` | `mergeStrategy` | `schemaHash` | Result |
|----------|--------------|-----------------|-------------|--------|
| Triple matches a `schemas` entry | ✅ validated | ✅ validated | ✅ validated (lookup key) | Auto-interpreted; `onUnresolvedDoc` does not fire |
| No schema match, `onUnresolvedDoc` configured | ✅ or ⚠ | ⚠ trusted | ⚠ trusted | `onUnresolvedDoc` fires (regardless of replica type support) |
| No schema match, no callback, supported type | ✅ validated | ⚠ trusted | ⚠ trusted | Deferred (two-tiered default) |
| No schema match, no callback, unsupported type | — | — | — | Rejected (two-tiered default) |

**Known docs** (already in `model.documents`): all three fields are validated against the local doc entry — `replicaType` via `replicaTypesCompatible()`, `schemaHash` via equality, and `mergeStrategy` via equality. A mismatch on any field skips sync with a warning.

### `exchange.deferred`

```ts
get deferred(): ReadonlySet<DocId>
```

Returns the set of doc IDs currently in the deferred state. Derived from `#docCache` entries with `mode: "deferred"`. Useful for diagnostic inspection and for higher-level primitives that need to know which docs are awaiting schema registration.

### Trust Model

The two registries create a two-tier trust model:

- **Interpreted docs**: The schema registry provides **local truth**. The `BoundSchema`'s `schemaHash`, `replicaType`, and `mergeStrategy` are computed locally. Peer claims are validated against this local truth. A mismatch means the peers disagree on document structure — sync is skipped.

- **Replicated docs**: The Exchange **trusts peer claims** for `mergeStrategy` and `schemaHash`. The `replicaType` is validated (it must match a registered `BoundReplica`), but the Exchange has no local source of truth for the other fields. A relay forwards `schemaHash` faithfully so interpreting peers on the far side can validate it against their own schemas.

This trust asymmetry is inherent: a relay cannot validate a schema it doesn't understand. The schema registry makes the trust boundary explicit — what's validated vs. what's forwarded is determined by which registry the doc was resolved from.

## 25. Line — Reliable Bidirectional Messaging

The `Line` class provides reliable ordered bidirectional message streams between two Exchange peers. It composes two `bindPlain` sequential documents — one per direction — with automatic sequence numbering and acknowledgement-based pruning.

### Motivation

WebRTC signaling, RPC interactions, and command streams are **reliable ordered messaging** — not state synchronization. Modeling messages as CRDT state (ephemeral presence, LWW docs) creates signal accumulation, broadcast inefficiency, and deduplication overhead. The Line primitive provides message-passing semantics on top of the Exchange's document sync infrastructure, inheriting reconnection, offline resilience, and unified routing for free.

### Document Model

Each Line creates two plain sequential documents:

- `line:${topic}:${a}→${b}` — peer A's outbox (A writes, B reads)
- `line:${topic}:${b}→${a}` — peer B's outbox (B writes, A reads)

Each document has an invariant envelope schema built by `createLineDocSchema(payloadSchema)`:

```
doc {
  messages: list(struct({ seq: number, payload: <application schema> }))
  ack: number
}
```

- `seq` — monotonically increasing per direction, assigned by the sender at `send()` time
- `payload` — the application message, typed by the schema
- `ack` — the highest `seq` processed from the *other* direction's document

### Asymmetric Schemas

Lines support different message types per direction via `{ send, recv }` options:

```typescript
const line = openLine(exchange, {
  peer: "server",
  topic: "rpc",
  send: RequestSchema,
  recv: ResponseSchema,
})
```

The coordination constraint: peer A's `send` schema must match peer B's `recv` schema, and vice versa. Enforced by convention — both peers agree on the protocol.

### Consumer API

Two complementary interfaces share one ack cursor:

**Push-based callback:**
```typescript
const unsub = line.onReceive(msg => { ... })  // msg is Plain<Recv>
```

**Pull-based async generator:**
```typescript
for await (const msg of line) { ... }  // msg is Plain<Recv>
```

Both consumers see every message. The ack advances to the highest delivered seq. If both are active, `onReceive` fires eagerly while the generator yields on `next()`.

### Ack Protocol and Pruning

When the receiver processes messages (seq > lastProcessedSeq), it writes `ack: lastProcessedSeq` to its own outbox. The sender reads this ack from the inbox changefeed and prunes all outbox messages with `seq <= ack`. In steady state, each document holds 0–1 messages.

### Topics

The `topic` field (optional, defaults to `"default"`) distinguishes multiple independent Lines between the same peers:

```typescript
const signaling = openLine(exchange, { peer: "bob", topic: "signaling", schema: S1 })
const rpc = openLine(exchange, { peer: "bob", topic: "rpc", schema: S2 })
```

Each topic produces distinct doc IDs (`line:signaling:...` vs `line:rpc:...`), distinct scopes, and distinct registry entries. Opening a Line with the same peer + topic as an already-open Line throws — close first, then reopen.

### Scope Integration

Line is a standalone class — it composes with the Exchange via public API only (`register()`, `get()`, `dismiss()`). No Exchange modification needed. `Line.open()` no longer needs to call `registerSchema()` explicitly because `exchange.get()` handles schema registration internally.

**Infrastructure scope** (`__line-infrastructure`): Registered on the first `openLine()` call. Provides a `onUnresolvedDoc` handler that returns `Defer()` for Line doc IDs. This handles the early-arrival case — when a remote peer's outbox arrives before the local peer opens a Line. The deferred doc is auto-promoted when `openLine()` calls `get()` (which registers the schema internally).

**Per-line scope** (`line:${topic}:${remotePeerId}`): Registered per `openLine()` call. Provides `authorize` — only the `from` peer can write to each doc. Routing is open by default. Applications that want endpoint-only routing register their own scope using the exported `routeLine` predicate.

### Standalone Design

The Line class has zero coupling to Exchange internals. It uses only:
- `exchange.register()` — scope registration
- `exchange.get()` — document creation (calls `registerSchema()` internally, expanding capabilities and auto-promoting deferred docs)
- `exchange.dismiss()` — document removal on close
- `exchange.peers` — peer lifecycle subscription

This validates the scope + capabilities architecture: higher-level primitives compose cleanly as external consumers of the Exchange's public API.

### Type Safety

The `Line<SendMsg, RecvMsg>` class is parameterized over concrete plain types (not schema types) to avoid deep recursive `Plain<S>` expansion. The `openLine()` function provides the typed entry point — it accepts schema types and returns `Line<Plain<Send>, Plain<Recv>>` using an interface call signature pattern that defers type evaluation.
