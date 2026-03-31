# @kyneta/exchange — Technical Reference

Substrate-agnostic state exchange for `@kyneta/schema`. Provides sync infrastructure for any substrate type through a unified three-message protocol dispatched by merge strategy.

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
- **Commands** (`Command`): outputs — side effects the runtime executes

The pure update function `(msg, model) → [model, cmd?]` contains all sync logic. The `Synchronizer` class is the imperative shell that dispatches messages, executes commands, and interacts with substrates.

```
Message → update(msg, model) → [newModel, Command?]
                                       ↓
                               Synchronizer.#executeCommand()
                                       ↓
                        ┌──────────────┼──────────────┐
                        ↓              ↓              ↓
                   send message   import data    build offer
                   (via adapter)  (via substrate) (via substrate)
```

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

Each `ExchangeSubstrateFactory<V>` declares a `MergeStrategy`:

```ts
type MergeStrategy =
  | { type: "causal" }      // bidirectional exchange, concurrent possible
  | { type: "sequential" }  // request/response, total order
  | { type: "lww" }         // unidirectional broadcast, timestamp-based
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

### `discover`

Document existence announcement. Sent after channel establishment to announce all known documents, filtered by the `route` predicate (§16). The receiver sends `interest` messages for docs it also has.

When the receiver encounters an unknown doc ID, the `route` predicate is checked first — if it returns `false` for the announcing peer, the doc is silently dropped. Otherwise, a `cmd/request-doc-creation` command is emitted. If the Exchange has an `onDocDiscovered` callback configured, the callback fires with the doc ID and the announcing peer's identity. If the callback returns a `BoundSchema`, the Exchange creates the document and the normal interest → offer flow proceeds. See §15 for details.

```ts
type DiscoverMsg = {
  type: "discover"
  docIds: DocId[]
}
```

Future work: `docIds` may be replaced or augmented with query predicates (glob patterns, schema-based filters).

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

Document departure announcement — the dual of `discover`. A peer sends `dismiss` when it's leaving the sync graph for a document. One-way announcement with no response needed.

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

For Loro substrates, the builder hashes the string peerId to a deterministic numeric Loro PeerID and returns a factory that calls `doc.setPeerId()` on every new LoroDoc. For plain/sequential substrates, the builder ignores the context: `() => plainSubstrateFactory`. For LWW/ephemeral substrates, the builder returns `lwwSubstrateFactory` (which wraps `plainSubstrateFactory` with `TimestampVersion`).

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

## 5. Channel and Adapter Abstraction

### Channel Lifecycle

```
GeneratedChannel → ConnectedChannel → EstablishedChannel
     (adapter)       (synchronizer)      (after handshake)
```

- **GeneratedChannel**: created by `Adapter.generate()`. Has `send`, `stop`, `kind`, `adapterType`.
- **ConnectedChannel**: registered with the synchronizer. Has `channelId`, `onReceive`.
- **EstablishedChannel**: completed the establish handshake. Has `peerId` of the remote peer.

### Adapter Base Class

Adapters follow a linear lifecycle: **create → initialize → start → stop → discard**. They cannot be restarted after `_stop()` — internal resources (`readonly` reassemblers, state machines) are disposed and not recreated. If you need a new adapter, create a new instance.

1. **`_initialize(context)`**: receives identity and callbacks (onChannelAdded, onChannelRemoved, onChannelReceive, onChannelEstablish)
2. **`_start()`**: begins operation — subclasses create initial channels here
3. **`_stop()`**: cleans up — all channels are removed, reassemblers disposed

Subclasses implement `generate(context)`, `onStart()`, and `onStop()`.

### AdapterFactory — Configuration as Description

`ExchangeParams.adapters` accepts `AdapterFactory[]` — an array of zero-argument functions that each create a fresh adapter instance:

```typescript
type AdapterFactory = () => AnyAdapter
```

The Exchange calls each factory once during construction. On `reset()`, the adapter instances are stopped and discarded. A new Exchange with the same factories creates fresh instances — no shared mutable state across lifecycles.

This follows the same principle as `BoundSchema.factory` (called per-exchange to produce a fresh `SubstrateFactory`) and React elements (descriptions of what to render, not the rendered thing).

#### The `create*` Helper Convention

Each adapter package exports a `create*` helper that captures options and returns an `AdapterFactory`:

```typescript
import { createWebsocketClient } from "@kyneta/websocket-network-adapter/client"

const exchange = new Exchange({
  adapters: [createWebsocketClient({ url: "ws://localhost:3000/ws" })],
})
```

Available helpers:
- `createWebsocketClient(options)` — browser-to-server WebSocket
- `createServiceWebsocketClient(options)` — service-to-service WebSocket (with headers)
- `createSseClient(options)` — SSE client (EventSource + POST)
- `createBridgeAdapter(params)` — in-process testing adapter

The adapter classes (`WebsocketClientAdapter`, `SseClientAdapter`, etc.) remain exported for advanced use cases that need a handle to the instance (e.g. `subscribeToTransitions`, `waitForStatus`).

#### Server Adapter Pattern

Server adapters are referenced by HTTP framework integration code (`handleConnection`, `registerConnection`, Express routers, Bun handlers). They use a "pre-created with single-use factory wrapper" pattern:

```typescript
const serverAdapter = new WebsocketServerAdapter()
const exchange = new Exchange({
  adapters: [() => serverAdapter],
})
// serverAdapter is now available for framework wiring:
// wss.on("connection", ws => serverAdapter.handleConnection({ socket: wrapNodeWebsocket(ws) }))
```

This is safe because server-side Exchanges are typically created once and never reset. The factory returns the same pre-created instance — the Exchange calls it once during construction.

### ClientStateMachine\<S\>

Generic observable state machine for network adapter client reconnection lifecycle. Extracted from the websocket adapter to eliminate duplication across adapters.

Parameterized on the state type `S extends { status: string }` and constructed with a transition map. Provides validated transitions, async delivery via microtask queue, `subscribeToTransitions`, `waitForState`/`waitForStatus`, and `reset()`. Both the websocket and SSE adapters instantiate it with their specific state types:

- `WebsocketClientStateMachine extends ClientStateMachine<WebsocketClientState>` — 5 states (disconnected, connecting, connected, ready, reconnecting)
- `SseClientStateMachine extends ClientStateMachine<SseClientState>` — 4 states (disconnected, connecting, connected, reconnecting)

Exported from `@kyneta/exchange` as shared infrastructure.

### BridgeAdapter

In-process adapter for testing. Messages are delivered asynchronously via `queueMicrotask()` to simulate real network behavior. Two-phase initialization avoids double-establishment:

1. **Phase 1**: Create channels to all existing peers (no establishment)
2. **Phase 2**: Only the joining adapter initiates establishment

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

The LWW substrate pattern is implemented by `lwwSubstrateFactory` in `@kyneta/schema` (`src/substrates/lww.ts`), consumed by `bindEphemeral()`. The internal `wrapWithTimestamp()` helper uses the decorator pattern to wrap a `PlainSubstrate` with `TimestampVersion`:

- **State management**: delegates to the inner `PlainSubstrate` (same `StoreReader`, `applyChangeToStore`, interpreter stack)
- **Version tracking**: `TimestampVersion` bumped on every `onFlush()` and `merge()`
- **Export**: always `exportEntirety()` (full state). `exportSince()` delegates to `inner.exportEntirety()` for defensive correctness, but is never called in practice — the synchronizer never sets `sinceVersion` for LWW docs, so the runtime always falls through to `exportEntirety()`.
- **Import**: delegates to inner `PlainSubstrate`

**Critical:** The LWW substrate must override `context()` to return a `WritableContext` built from the **wrapper** substrate, not the inner one. This ensures `onFlush()` (which bumps the timestamp version) is called during `change()`. This is correct-by-construction in `wrapWithTimestamp` — the extracted helper eliminates the risk of copy-paste errors:

```ts
context(): WritableContext {
  if (!cachedCtx) {
    cachedCtx = buildWritableContext(substrate)  // the wrapper, NOT inner
  }
  return cachedCtx
}
```

If `context()` delegated to `inner.context()`, the inner plain substrate's `onFlush` would run but the wrapper's version would never be bumped, causing LWW timestamp comparison to use stale timestamps.

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
    [newModel, cmd] = updateFn(msg, model)
    model = newModel
    if cmd: executeCommand(cmd)     // may push more messages

  // Quiescence — all messages processed
  flushOutbound()                   // send accumulated envelopes
  emitReadyStateChanges()           // notify listeners
  dispatching = false
```

Commands that produce new messages (e.g. `cmd/dispatch`) are pushed to `pendingMessages` and processed in the same dispatch cycle. Outbound messages are accumulated in a queue and flushed only at quiescence, ensuring consistent model state before any messages leave the exchange.

---

## 10. File Map

| File | Purpose |
|------|---------|
| `src/types.ts` | Core identity and state types (PeerId, DocId, ChannelId, PeerState, ReadyState) |
| `src/messages.ts` | Sync protocol messages (discover, interest, offer, dismiss) + establishment messages |
| `src/channel.ts` | Channel types and lifecycle (GeneratedChannel → ConnectedChannel → EstablishedChannel) |
| `src/channel-directory.ts` | Channel ID generation and lifecycle management |
| `src/adapter/adapter.ts` | Abstract `Adapter` base class |
| `src/adapter/adapter-manager.ts` | `AdapterManager` — adapter lifecycle and message routing |
| `src/adapter/bridge-adapter.ts` | `Bridge` + `BridgeAdapter` — in-process testing |

| `src/utils.ts` | PeerId generation and validation |
| `src/synchronizer-program.ts` | TEA state machine — model, messages, commands, sync algorithms |
| `src/synchronizer.ts` | Synchronizer runtime — dispatch, command execution, substrate interaction |
| `src/exchange.ts` | `Exchange` class — public API, `RoutePredicate`, `AuthorizePredicate`, `OnDocDismissed` types |
| `src/sync.ts` | `sync()` function and `SyncRef` — sync capabilities access |
| `src/index.ts` | Barrel export (re-exports `bind`, `BoundSchema`, `MergeStrategy`, etc. from `@kyneta/schema`) |

Note: `MergeStrategy`, `BoundSchema`, `bind()`, `bindPlain()`, `bindEphemeral()`, `unwrap()`, `registerSubstrate()`, and `TimestampVersion` are defined in `@kyneta/schema` and re-exported from `@kyneta/exchange` for convenience. `bindLoro()` and `loro()` are defined in `@kyneta/loro-schema`.

### Test Files

| File | Coverage |
|------|----------|
| `src/__tests__/adapter.test.ts` | Adapter lifecycle, AdapterManager, BridgeAdapter (13 tests) |
| `src/__tests__/synchronizer-program.test.ts` | Pure TEA update function — all message types, merge strategies, and `cmd/request-doc-creation` (28 tests) |
| `src/__tests__/exchange.test.ts` | Exchange class — get, cache, sync, lifecycle, factory builder lifecycle (24 tests) |
| `src/__tests__/integration.test.ts` | Two-peer sync for sequential, causal, LWW, heterogeneous, and `onDocDiscovered` dynamic creation (12 tests) |
| `src/__tests__/sync-invariants.test.ts` | Regression tests: empty-delta fallback, ref identity, LWW stale rejection, causal deltas (6 tests) |

---

## 11. Wire Format (`@kyneta/wire`)

The `@kyneta/wire` package provides serialization infrastructure for the exchange's 6-message protocol. It sits between the exchange and network adapters in the dependency graph:

```
@kyneta/exchange  →  @kyneta/wire  →  @kyneta/websocket-network-adapter
   (messages)         (codecs)          (network adapter)
                                        @kyneta/sse-network-adapter
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
| `discover` | `0x10` | `t`, `docs` |
| `interest` | `0x11` | `t`, `doc`, `v?`, `r?` |
| `offer` | `0x12` | `t`, `doc`, `pk`, `pe`, `d`, `v`, `r?` |

`PayloadKind` values: `0x00` = `"entirety"`, `0x01` = `"since"`.

See `packages/exchange/wire/PROTOCOL.md` for the full wire protocol specification.

---

## 12. Websocket Network Adapter (`@kyneta/websocket-network-adapter`)

The first real network adapter. Framework-agnostic via the `Socket` interface, with platform-specific wrappers for browser, Node.js `ws`, and Bun.

### Package Structure

Three subpath exports (no combined `"."` entry) to keep client/server/bun code tree-shakeable:

| Subpath | Entry | Key Exports |
|---------|-------|-------------|
| `./client` | `src/client.ts` | `WebsocketClientAdapter`, `createWebsocketClient`, `createServiceWebsocketClient`, `WebsocketClientStateMachine` |
| `./server` | `src/server.ts` | `WebsocketServerAdapter`, `WebsocketConnection`, `wrapNodeWebsocket`, `wrapStandardWebsocket` |
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

11. **End-to-end in a real app**: The `examples/todo/` app proves the full managed sync path in a running application: `LoroSchema` → `bindLoro` → `Exchange` → `WebsocketServerAdapter`/`WebsocketClientAdapter` → Cast compiled view → collaborative real-time sync between browser tabs. No hand-rolled WebSocket code — `change(doc, fn)` on any client automatically propagates to all peers via the changefeed → synchronizer → adapter pipeline.

12. **Dynamic document creation via `onDocDiscovered`**: Peer A creates a document unknown to peer B. B's `onDocDiscovered` callback materializes the document with the correct `BoundSchema`. After sync, B has A's content. Works for sequential (PlainSubstrate) and LWW (`bindEphemeral` / `TimestampVersion`) strategies. Callback returning `undefined` correctly suppresses creation.

---

## 14. SSE Network Adapter (`@kyneta/sse-network-adapter`)

The SSE adapter uses an **asymmetric transport** (POST for uplink, SSE for downlink) with **symmetric encoding** (text wire format in both directions).

### Package Structure

Three subpath exports (no combined `"."` entry) to keep client/server/express code tree-shakeable:

| Subpath | Entry | Key Exports |
|---------|-------|-------------|
| `./client` | `src/client.ts` | `SseClientAdapter`, `createSseClient`, `SseClientStateMachine` |
| `./server` | `src/server.ts` | `SseServerAdapter`, `SseConnection` |
| `./express` | `src/express.ts` | `createSseExpressRouter`, `parseTextPostBody`, `SseServerAdapter` (re-export) |

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
type OnDocDiscovered = (docId: DocId, peer: PeerIdentityDetails) => BoundSchema | undefined
```

The `onDocDiscovered` callback is an optional field on `ExchangeParams`. It fires when a peer announces (via `discover`) a document the local exchange doesn't have. Return a `BoundSchema` to auto-create the document and begin sync, or `undefined` to ignore it.

```ts
const exchange = new Exchange({
  onDocDiscovered: (docId, peer) => {
    if (docId.startsWith("input:")) return PlayerInputDoc
    return undefined
  },
})
```

### Protocol Flow

```
Peer A (has doc)               Peer B (doesn't have doc)
     |                                |
     |── discover ["input:alice"] ──> |
     |                                | handleDiscover: unknown doc
     |                                | → cmd/request-doc-creation
     |                                | → onDocDiscovered("input:alice", peerA)
     |                                | → returns PlayerInputDoc
     |                                | → exchange.get("input:alice", PlayerInputDoc)
     |                                | → registerDoc → doc-ensure dispatched
     |                                |
     | <── discover ["input:alice"] ──| doc-ensure: announce + interest
     | <── interest { version: "0" } ─|
     |                                |
     |── offer { snapshot, data } ──> | handleOffer: import A's state
     |                                |
```

### The `cmd/request-doc-creation` Command

When `handleDiscover` encounters an unknown doc ID, the pure program emits:

```ts
{ type: "cmd/request-doc-creation", docId: DocId, peer: PeerIdentityDetails }
```

The `Synchronizer` runtime executes this command by calling the `DocCreationCallback` provided by the Exchange. The callback is fire-and-forget — if it calls `exchange.get()`, the resulting `registerDoc()` → `#dispatch(doc-ensure)` is queued in `#pendingMessages` (because `#dispatching` is true) and processed before quiescence.

### Reentrancy Through the Dispatch Loop

The reentrancy path is safe because of the serialized dispatch architecture (§9):

1. `handleDiscover` returns `[model, cmd/request-doc-creation]`
2. `#executeCommand` calls the callback
3. Callback calls `exchange.get()` → `synchronizer.registerDoc()` → `#dispatch(doc-ensure)`
4. `#dispatch` sees `#dispatching === true`, pushes `doc-ensure` to `#pendingMessages`, returns
5. Control returns to the dispatch loop, which processes `doc-ensure` next
6. `doc-ensure` emits `discover` + `interest` messages, accumulated in the outbound queue
7. At quiescence, all messages are flushed together

### `doc-ensure` Sends Both `discover` and `interest`

When a document is registered after channels are established (the dynamic creation case), `handleDocEnsure` sends **both** `discover` and `interest` to all established channels:

- **`discover`**: announces the doc to peers (they may create it via their own `onDocDiscovered`)
- **`interest`**: requests data from peers who already have the doc (essential for pulling content into the newly created empty doc)

Previously, `doc-ensure` only sent `discover` to network channels and `interest` to storage channels. This was insufficient for dynamic creation — the newly created doc was empty, and the `discover` → `interest` → `offer` round-trip resulted in the empty doc offering its empty state, rather than pulling the remote peer's data.

### Relationship to the Vendor Pattern

The vendor (`@loro-extended/repo`) handles this in `handleSyncRequest` — when a `sync-request` arrives for an unknown doc, the doc is auto-created, gated by `permissions.creation`. Kyneta's approach differs:

1. **Trigger point**: `discover` (not `interest`/`sync-request`), because kyneta's `interest` is only sent for docs the sender already has.
2. **Route gating**: The `route` predicate (§16) is checked before `cmd/request-doc-creation` is emitted. If `route(docId, announcingPeer)` returns `false`, the unknown doc is silently dropped — `onDocDiscovered` never fires.
3. **Gating mechanism**: a callback returning `BoundSchema | undefined` (not a boolean permission predicate), because the callback must provide the schema/factory/strategy — information a boolean predicate cannot supply.
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

Both default to `() => true` (open access), preserving backward compatibility.

### `route` — Outbound Flow Control

The `route` predicate gates all outbound messages. It answers: "should this peer participate in the sync graph for this document?"

| Gate | Handler | What `route: false` does |
|------|---------|--------------------------|
| Initial discover | `handleEstablishRequest` / `handleEstablishResponse` | Doc omitted from `discover` message |
| Doc-ensure broadcast | `handleDocEnsure` | Channel excluded from discover+interest |
| Push (local change + relay) | `buildPush` | Channel excluded from offer |
| `onDocDiscovered` gating | `handleDiscover` | `cmd/request-doc-creation` not emitted |

### `authorize` — Inbound Flow Control

The `authorize` predicate gates inbound data import. It answers: "should this peer's mutations be accepted for this document?"

| Gate | Handler | What `authorize: false` does |
|------|---------|-------------------------------|
| Offer import | `handleOffer` | `cmd/import-doc-data` not emitted; peer sync state still updated |

When `authorize` rejects an offer, the peer's sync state is still updated to prevent re-requesting. Only the data import is suppressed.

### Storage Channel Bypass

Both predicates are skipped for storage channels (`channel.kind === "storage"`). Storage is local infrastructure, not a policy boundary — you always want to persist and load your own docs. The predicates govern the network boundary only.

Implementation: `filterChannelsByRoute(model, channelIds, docId, route)` encapsulates the storage-bypass + route-check pattern. For each channel ID, if `kind === "storage"`, keep unconditionally. Otherwise, resolve peer identity and call `route(docId, peer)`.

### The `route` → `authorize` Invariant

`authorize` implies `route`: if you accept mutations from a peer, that peer must be in the routing topology. The converse is not true — a read-only subscriber is routed but not authorized. The system does not enforce this formally. If a developer sets `authorize: () => true` but `route: () => false`, nothing breaks — inbound data never arrives because the outbound announcement was suppressed.

### Relationship to `onDocDiscovered`

`route` is checked **before** `onDocDiscovered` fires. When a peer announces an unknown doc in `handleDiscover`, the flow is:

1. Check `route(docId, announcingPeer)` — if `false`, silently drop
2. Emit `cmd/request-doc-creation`
3. `onDocDiscovered` callback fires (factory decision)
4. If callback returns `BoundSchema`, `exchange.get()` creates the doc
5. Subsequent discover/interest/offer flow is subject to `route` normally

This means `onDocDiscovered` can assume the announcing peer already passed the route check.

See `examples/bumper-cars/src/server.ts` for a concrete usage example — `route` restricts input doc visibility to the owning peer, and `authorize` enforces server-only writes to game state.

---

## 17. Dismiss — Leaving the Sync Graph

### The `dismiss` Wire Message

`dismiss` is the dual of `discover`: discover announces "I have this doc," dismiss announces "I'm leaving this doc." It is a one-way announcement with no response needed.

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
