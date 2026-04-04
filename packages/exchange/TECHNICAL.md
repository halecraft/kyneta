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
                   (via adapter)  data     offer    #emitReadyStateChanges()
                                                    → targeted emission
```

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

When the receiver encounters a known doc, it validates `replicaType` compatibility via `replicaTypesCompatible()` (same name + same major version) and `schemaHash` equality. If both match, it sends `interest`. If either is incompatible, the doc is skipped with a warning — same pattern for both checks.

When the receiver encounters an unknown doc ID, the `route` predicate is checked first — if it returns `false` for the announcing peer, the doc is silently dropped. Otherwise, a `cmd/request-doc-creation` command is emitted (carrying `schemaHash` through). If the Exchange has an `onDocDiscovered` callback configured, the callback fires with the doc ID, the announcing peer's identity, `replicaType`, `mergeStrategy`, and `schemaHash`. The callback returns a disposition (`Interpret | Replicate | undefined`). See §15 for details.

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

### ClientStateMachine\<S\>

Generic observable state machine for transport client reconnection lifecycle. Extracted from the websocket transport to eliminate duplication across adapters.

Parameterized on the state type `S extends { status: string }` and constructed with a transition map. Provides validated transitions, async delivery via microtask queue, `subscribeToTransitions`, `waitForState`/`waitForStatus`, and `reset()`. Both the websocket and SSE adapters instantiate it with their specific state types:

- `WebsocketClientStateMachine extends ClientStateMachine<WebsocketClientState>` — 5 states (disconnected, connecting, connected, ready, reconnecting)
- `SseClientStateMachine extends ClientStateMachine<SseClientState>` — 4 states (disconnected, connecting, connected, reconnecting)

Exported from `@kyneta/exchange` as shared infrastructure.

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

## 9. Serialized Dispatch with Quiescence Flush

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
    if notification: accumulateNotification(notification)  // collect into dirtyDocIds
    if cmd: executeCommand(cmd)                            // may push more messages

  // Quiescence — all messages processed
  flushOutbound()                   // send accumulated envelopes
  emitReadyStateChanges()           // emit only for dirtyDocIds
  dirtyDocIds.clear()
  dispatching = false
```

Commands that produce new messages (e.g. `cmd/dispatch`) are pushed to `pendingMessages` and processed in the same dispatch cycle. Outbound messages are accumulated in a queue and flushed only at quiescence, ensuring consistent model state before any messages leave the exchange.

Notifications are accumulated across the entire dispatch cycle into a `Set<DocId>` (`#dirtyDocIds`). At quiescence, `#emitReadyStateChanges` emits only for docs in the dirty set — O(dirty × peers × listeners) instead of the previous O(docs × peers × listeners). Most dispatch cycles touch zero or one doc, so this is typically O(1) or O(P×L).

---

## 10. File Map

| File | Purpose |
|------|---------|
| `src/types.ts` | Core identity and state types (PeerId, DocId, ChannelId, PeerState, ReadyState) |
| `src/messages.ts` | Sync protocol messages (present, interest, offer, dismiss) + establishment messages |
| `src/channel.ts` | Channel types and lifecycle (GeneratedChannel → ConnectedChannel → EstablishedChannel) |
| `src/channel-directory.ts` | Channel ID generation and lifecycle management |
| `src/transport/transport.ts` | Abstract `Transport` base class |
| `src/transport/transport-manager.ts` | `TransportManager` — transport lifecycle and message routing |
| `src/transport/bridge-transport.ts` | `Bridge` + `BridgeTransport` — in-process testing |
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
| `src/index.ts` | Barrel export (re-exports `bind`, `BoundSchema`, `MergeStrategy`, etc. from `@kyneta/schema`) |

Note: `MergeStrategy`, `BoundSchema`, `bind()`, `bindPlain()`, `bindEphemeral()`, `unwrap()`, `registerSubstrate()`, and `TimestampVersion` are defined in `@kyneta/schema` and re-exported from `@kyneta/exchange` for convenience. `bindLoro()` is defined in `@kyneta/loro-schema`.

### Test Files

| File | Coverage |
|------|----------|
| `src/__tests__/transport.test.ts` | Transport lifecycle, TransportManager, BridgeTransport |
| `src/__tests__/synchronizer-program.test.ts` | Pure TEA update function — all message types, merge strategies, `cmd/request-doc-creation`, replicate mode |
| `src/__tests__/store-hydration.test.ts` | Exchange-level storage hydration — get/replicate hydration, network import persistence, local change persistence, flush, round-trip restart |
| `src/__tests__/store.test.ts` | InMemoryStore — conformance suite + InMemory-specific sharedData/getStorage tests |
| `src/testing/store-conformance.ts` | Reusable Store contract suite: lookup, ensureDoc, append, loadAll, replace, delete, listDocIds, JSON + binary payload round-trips, StoreEntry shape |
| `src/__tests__/store-integration.test.ts` | End-to-end storage: persist+hydrate for sequential/causal/LWW, replicate mode, dismiss+delete, onDocDiscovered+storage |
| `src/__tests__/exchange.test.ts` | Exchange class — get, cache, sync, lifecycle, factory builder lifecycle |
| `src/__tests__/integration.test.ts` | Two-peer sync for sequential, causal, LWW, heterogeneous, and `onDocDiscovered` dynamic creation |
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

### Two Pipelines

```
Binary: BinaryCodec (CBOR) → binary frame (7B header) → binary fragmentation → FragmentReassembler
                                                                                 └→ FragmentCollector<Uint8Array>

Text:   TextCodec (JSON)   → text frame ("Vx" prefix) → text fragmentation   → TextReassembler
                                                                                 └→ FragmentCollector<string>
```

### Binary Frame Format

7-byte header: version (1B, `0x00`) + type (1B, `0x00`=complete / `0x01`=fragment) + hash algorithm (1B, `0x00`=none) + payload length (4B BE). Fragment frames add 20 bytes of metadata (frameId 8B + index 4B + total 4B + totalSize 4B) before the payload. Two transport prefixes: `0x00` (complete) and `0x01` (fragment).

### Text Frame Format

JSON array with a 2-character prefix: position 0 is the version (`'0'`), position 1 encodes type + hash via case (`'c'`=complete, `'C'`=complete+hash, `'f'`=fragment, `'F'`=fragment+hash). Complete frames embed the payload as a native JSON value. Fragment frames carry `frameId`, `index`, `total`, `totalSize`, and a JSON substring chunk.

### FragmentCollector<T>

Generic stateful fragment collector parameterized on chunk type `T`. Uses a pure decision function (`decideFragment`) as the functional core and the `FragmentCollector` class as the imperative shell. Both `FragmentReassembler` (binary) and `TextReassembler` (text) are thin wrappers (~80–100 lines) that handle format-specific parsing and delegate collection to the generic collector.

Fragments are fully self-describing — no separate "fragment header" message. The collector auto-creates tracking state on first contact with a new frame ID. Configurable timeouts (default 10s), max concurrent frames (32), max total size (50MB), and oldest-first eviction.

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

The first real transport. Framework-agnostic via the `Socket` interface, with platform-specific wrappers for browser, Node.js `ws`, and Bun.

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

### Client State Machine

The `WebsocketClientStateMachine` provides validated, observable state transitions:

```
disconnected → connecting → connected → ready
                   ↓            ↓         ↓
              reconnecting ← ─ ┴ ─ ─ ─ ─ ┘
```

Transitions are delivered asynchronously via microtask queue. Reconnection uses exponential backoff with jitter.

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

12. **Dynamic document creation via `onDocDiscovered`**: Peer A creates a document unknown to peer B. B's `onDocDiscovered` callback materializes the document with the correct `BoundSchema`. After sync, B has A's content. Works for sequential (PlainSubstrate) and LWW (`bindEphemeral` / `TimestampVersion`) strategies. Callback returning `undefined` correctly suppresses creation.

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

### Custom Reconnection (No `reconnecting-eventsource`)

The browser's native `EventSource` has built-in reconnection. The adapter **closes the EventSource immediately** on `onerror` and takes over reconnection via the `SseClientStateMachine`'s backoff logic. This prevents two reconnection systems from fighting and gives full control over:

- Exponential backoff timing with jitter
- Attempt counting and max attempts
- Channel lifecycle (preserve vs. recreate)
- Observable state transitions for UI feedback

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

## 15. Lazy Document Creation (`onDocDiscovered`)

### Callback Signature

```ts
type OnDocDiscovered = (
  docId: DocId,
  peer: PeerIdentityDetails,
  replicaType: ReplicaType,
  mergeStrategy: MergeStrategy,
  schemaHash: string,
) => Interpret | Replicate | undefined
```

The `onDocDiscovered` callback is an optional field on `ExchangeParams`. It fires when a peer announces (via `present`) a document the local exchange doesn't have. Return a disposition to determine how the document participates in the sync graph:

- `Interpret(bound)` — full interpretation with schema, ref, changefeed.
- `Replicate(replicaFactory, strategy, schemaHash)` — headless replication (relay, storage). The 3rd parameter forwards the schema fingerprint so it can be re-announced in the relay's own `present` messages.
- `undefined` — ignore the unknown document.

The callback receives `replicaType`, `mergeStrategy`, and `schemaHash` from the `present` message, enabling dynamic factory dispatch based on the remote peer's substrate type and schema fingerprint verification at the interpret peer on the far side.

**Schema fingerprint verification flow:** The interpret peer computes `schemaHash` at bind time (`computeSchemaHash(schema)` → stored on `BoundSchema`). The `present` message carries it. A relay forwards it faithfully (via `Replicate(factory, strategy, schemaHash)`). The interpret peer on the other end compares it against its own `BoundSchema.schemaHash` for the same docId — a mismatch means the two peers disagree on document structure and sync is skipped.

```ts
const exchange = new Exchange({
  onDocDiscovered: (docId, peer, replicaType, mergeStrategy, schemaHash) => {
    if (docId.startsWith("input:")) return Interpret(PlayerInputDoc)
    // Relay server — replicate without schema knowledge, forward schemaHash
    if (replicaType[0] === "loro") return Replicate(loroReplicaFactory, mergeStrategy, schemaHash)
    return undefined
  },
})
```

### Protocol Flow

```
Peer A (has doc)               Peer B (doesn't have doc)
     |                                |
     |── present [{ docId:           >|
     |     "input:alice",             |
     |     replicaType: ["loro",1,0], |
     |     mergeStrategy: "causal" }] |
     |                                | handlePresent: unknown doc
     |                                | → cmd/request-doc-creation
     |                                | → onDocDiscovered("input:alice", peerA, ...)
     |                                | → returns Interpret(PlayerInputDoc)
     |                                | → exchange.get("input:alice", PlayerInputDoc)
     |                                | → storage hydration (if configured)
     |                                | → registerDoc → doc-ensure dispatched
     |                                |
     | <── present ["input:alice"] ───| doc-ensure: announce + interest
     | <── interest { version: "0" } ─|
     |                                |
     |── offer { payload, version } ─>| handleOffer: import A's state
     |                                |
```

**Storage interaction**: When storage backends are configured, `exchange.get()` hydrates from storage before registering with the synchronizer. The synchronizer only learns about the doc after hydration, so `present`/`interest` messages carry the hydrated version — not an empty one.

### The `cmd/request-doc-creation` Command

When `handlePresent` encounters an unknown doc ID, the pure program emits:

```ts
{ type: "cmd/request-doc-creation", docId: DocId, peer: PeerIdentityDetails, replicaType: ReplicaType, mergeStrategy: MergeStrategy, schemaHash: string }
```

The `Synchronizer` runtime executes this command by calling the `DocCreationCallback` provided by the Exchange. The callback is fire-and-forget — if it calls `exchange.get()`, the resulting `registerDoc()` → `#dispatch(doc-ensure)` is queued in `#pendingMessages` (because `#dispatching` is true) and processed before quiescence.

### Reentrancy Through the Dispatch Loop

The reentrancy path is safe because of the serialized dispatch architecture (§9):

1. `handlePresent` returns `[model, cmd/request-doc-creation]`
2. `#executeCommand` calls the callback
3. Callback calls `exchange.get()` → `synchronizer.registerDoc()` → `#dispatch(doc-ensure)`
4. `#dispatch` sees `#dispatching === true`, pushes `doc-ensure` to `#pendingMessages`, returns
5. Control returns to the dispatch loop, which processes `doc-ensure` next
6. `doc-ensure` emits `present` + `interest` messages, accumulated in the outbound queue
7. At quiescence, all messages are flushed together

### `doc-ensure` Sends Both `present` and `interest`

When a document is registered after channels are established (the dynamic creation case), `handleDocEnsure` sends **both** `present` and `interest` to all established channels:

- **`present`**: announces the doc to peers (they may create it via their own `onDocDiscovered`)
- **`interest`**: requests data from peers who already have the doc (essential for pulling content into the newly created empty doc)

### Relationship to the Vendor Pattern

The vendor (`@loro-extended/repo`) handles this in `handleSyncRequest` — when a `sync-request` arrives for an unknown doc, the doc is auto-created, gated by `permissions.creation`. Kyneta's approach differs:

1. **Trigger point**: `present` (not `interest`/`sync-request`), because kyneta's `interest` is only sent for docs the sender already has.
2. **Route gating**: The `route` predicate (§16) is checked before `cmd/request-doc-creation` is emitted. If `route(docId, announcingPeer)` returns `false`, the unknown doc is silently dropped — `onDocDiscovered` never fires.
3. **Gating mechanism**: a callback returning a disposition (`Interpret | Replicate | undefined`), because the callback must provide the schema/factory/strategy — information a boolean predicate cannot supply.
4. **No separate `creation` permission**: the callback subsumes the permission check. Returning `undefined` is equivalent to denying creation.

See `examples/bumper-cars/src/server.ts` for a concrete usage example — the server materializes `input:${peerId}` documents when players connect, and registers them with the game loop via a queued microtask.

---

## 16. Route and Authorize — Information Flow Control

Two predicates on `ExchangeParams` control information flow through the sync protocol. They replace the vendor's four-predicate model (`visibility`, `mutability`, `creation`, `deletion`) with a cleaner two-axis decomposition: outbound flow (routing) and inbound flow (authority).

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
| `onDocDiscovered` gating | `handlePresent` | `cmd/request-doc-creation` not emitted |

### `authorize` — Inbound Flow Control

The `authorize` predicate gates inbound data import. It answers: "should this peer's mutations be accepted for this document?"

| Gate | Handler | What `authorize: false` does |
|------|---------|-------------------------------|
| Offer import | `handleOffer` | `cmd/import-doc-data` not emitted; peer sync state still updated |

When `authorize` rejects an offer, the peer's sync state is still updated to prevent re-requesting. Only the data import is suppressed.

### The `route` → `authorize` Invariant

`authorize` implies `route`: if you accept mutations from a peer, that peer must be in the routing topology. The converse is not true — a read-only subscriber is routed but not authorized. The system does not enforce this formally. If a developer sets `authorize: () => true` but `route: () => false`, nothing breaks — inbound data never arrives because the outbound announcement was suppressed.

### Relationship to `onDocDiscovered`

`route` is checked **before** `onDocDiscovered` fires. When a peer announces an unknown doc in `handlePresent`, the flow is:

1. Check `route(docId, announcingPeer)` — if `false`, silently drop
2. Emit `cmd/request-doc-creation`
3. `onDocDiscovered` callback fires (disposition decision)
4. If callback returns `Interpret(bound)`, `exchange.get()` creates the doc
5. If callback returns `Replicate(factory, strategy)`, `exchange.replicate()` creates the doc
6. Subsequent present/interest/offer flow is subject to `route` normally

This means `onDocDiscovered` can assume the announcing peer already passed the route check.

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
