# @kyneta/transport — Technical Reference

> **Package**: `@kyneta/transport`
> **Role**: The abstract transport contract — an `abstract class Transport<G>`, the channel lifecycle, the six-message protocol vocabulary, identity types, the wire pipeline (`Pipeline<S, R>`), alias transformer, stream frame parser, and reconnection utilities.
> **Depends on**: `@kyneta/wire` (workspace), `@kyneta/machine`, `@kyneta/schema`
> **Depended on by**: `@kyneta/exchange`, `@kyneta/websocket-transport`, `@kyneta/sse-transport`, `@kyneta/unix-socket-transport`, `@kyneta/webrtc-transport`, `@kyneta/bridge-transport`
> **Canonical symbols**: `Transport<G>`, `TransportFactory`, `TransportContext`, `Channel`, `ConnectedChannel`, `EstablishedChannel`, `GeneratedChannel`, `ChannelDirectory<G>`, `ChannelMsg`, `LifecycleMsg`, `SyncMsg`, `EstablishMsg`, `DepartMsg`, `PresentMsg`, `InterestMsg`, `OfferMsg`, `DismissMsg`, `AddressedEnvelope`, `ReturnEnvelope`, `PeerIdentityDetails`, `WireFeatures`, `Pipeline`, `Encoding`, `PayloadOf`, `WireOpts`, `FrameStreamParser`, `computeBackoffDelay`, `DEFAULT_RECONNECT`. Re-exports: `Result`, `Ok`, `Err`, `ok`, `err`, `WireError`.
> **Key invariant(s)**: The protocol is exactly six messages. Two lifecycle (`establish`, `depart`) for channel presence, four sync (`present`, `interest`, `offer`, `dismiss`) for document exchange. The `Pipeline` is the single wire orchestrator — all concrete transports use it rather than calling `@kyneta/wire` directly.

A small kit of shared types, one abstract base class, and one wire pipeline that every concrete transport extends and uses. It fixes the shape of a channel, the vocabulary of messages, the split between "channel created" / "channel connected" / "channel established", and the `ChannelMsg ↔ wire` transformation — so that the runtime in `@kyneta/exchange` can drive any transport without caring whether bytes flow over a WebSocket, an SSE stream, a Unix socket, or an in-process bridge.

Imported by `@kyneta/exchange` (which owns the sync runtime) and by every concrete transport package. Application code never imports from here directly.

---

## Questions this document answers

- What are the six messages and why exactly six? → [Message vocabulary](#message-vocabulary)
- What does a channel's lifecycle look like? → [Channel lifecycle](#channel-lifecycle)
- How do I write a new transport? → [Writing a transport](#writing-a-transport)
- Why a `TransportFactory` instead of a `Transport` instance? → [Factories, not instances](#factories-not-instances)
- How does the wire pipeline work? → [Wire pipeline](#wire-pipeline)
- What is `FrameStreamParser` for? → [Stream-substrate boundary discovery](#stream-substrate-boundary-discovery)
- How do I test two peers without real network? → [`BridgeTransport` (moved)](#bridgetransport-moved) — in `@kyneta/bridge-transport`
- What is `computeBackoffDelay` for? → [Reconnection utilities](#reconnection-utilities)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `Transport<G>` | The abstract base class a concrete transport extends. `G` is the transport's per-channel context type (e.g. `{ url: string }`, `{ socket: WebSocket }`). | A network library, a raw socket abstraction — it's an *exchange*-level contract |
| `Channel` | A single bidirectional message path to one remote peer. Moves through `Generated → Connected → Established`. | A Go-style channel, a WebSocket, a pub-sub topic |
| `GeneratedChannel` | A channel that has actions (`send`, `stop`) but has not yet been registered with the synchronizer. | `ConnectedChannel` |
| `ConnectedChannel` | A generated channel that now has a `channelId` and an `onReceive` handler but has not completed `establish`. May only send `LifecycleMsg`. | `EstablishedChannel` |
| `EstablishedChannel` | A connected channel that has completed the `establish` handshake and knows its remote `peerId`. May only send `SyncMsg`. | `ConnectedChannel` |
| `ChannelDirectory<G>` | The per-transport map from `channelId` to `Channel`, owner of the monotonic channel-ID counter. | A service discovery, a routing table — it is local to one transport instance |
| `ChannelMsg` | `LifecycleMsg \| SyncMsg` — every message that ever crosses the wire. | A wire frame (wrapped separately by the Pipeline) |
| `Pipeline<S, R>` | The single wire pipeline: `ChannelMsg → alias → encode → fragment → wire pieces` (send) and the reverse (receive). | A UNIX pipe, a CI/CD pipeline |
| `Encoding` | `"binary" \| "text"` — determines the wire substrate type. | Character encoding (UTF-8, etc.) |
| `PayloadOf<E>` | `{ binary: Uint8Array; text: string }[E]` — the wire piece type for a given encoding. | A message payload |
| `FrameStreamParser` | Stateful byte-stream → binary-frame extractor for stream-oriented transports. | `Reassembler`, which handles fragmentation (orthogonal concern) |
| `AddressedEnvelope` | `{ toChannelIds: number[], message: ChannelMsg }` — an outbound message plus routing. | `ReturnEnvelope`, which is the inbound counterpart |
| `TransportFactory` | `() => AnyTransport` — a zero-arg function returning a fresh transport instance. | A `Transport` instance itself |
| `TransportContext` | The callback bundle the exchange injects via `_initialize` (identity + four callbacks). | A Node.js context, a React context |

---

## Architecture

**Thesis**: freeze the interface between the sync runtime and every concrete wire, so that substrate-agnostic sync logic lives in one place (`@kyneta/exchange`) and wire-specific logic lives in another (the transport packages).

A transport is:

1. An **abstract base class** (`Transport<G>` in `packages/transport/src/transport.ts`) that owns a `ChannelDirectory`, a lifecycle state machine (`created → initialized → started → stopped`), and `_initialize` / `_start` / `_stop` / `_send` internal methods the exchange calls.
2. A **channel abstraction** (`packages/transport/src/channel.ts`) that narrows what can be sent based on state: a `ConnectedChannel`'s `send` accepts only `LifecycleMsg`; an `EstablishedChannel`'s `send` accepts only `SyncMsg`.
3. A **fixed message vocabulary** (`packages/transport/src/messages.ts`) used by every transport and understood by the runtime without per-transport knowledge.
4. A **wire pipeline** (`Pipeline<S, R>` in `packages/transport/src/pipeline.ts`) that handles the `ChannelMsg ↔ wire` transformation — alias resolution, codec invocation, fragmentation, validation.

The generic parameter `G` is the transport's own per-channel context (e.g. the browser `WebSocket` object, a `{ targetTransportType }` for the bridge). `@kyneta/transport` never inspects it — only the concrete subclass's `generate(context: G)` does.

### What a `Transport` is NOT

- **Not a network library.** It does not open sockets, buffer bytes, or retry connections. Those are the concrete transport's concerns. `Transport<G>` is an adapter boundary — not WebSocket, not HTTP, not anything specific.
- **Not a socket abstraction.** A single `Transport` instance typically has many channels (one per peer). A socket abstraction has one connection.
- **Not running code without the exchange.** `_initialize` injects identity and callbacks. Without those, `addChannel` throws. The class is inert until the exchange wires it up.

### What a `Channel` is NOT

- **Not a Go-style channel.** It is not a synchronization primitive; there is no blocking read. Messages arrive via an injected `onReceive` callback.
- **Not a WebSocket.** A channel is a logical message path to one peer. A WebSocket transport may implement a channel over a socket, but SSE implements it over `EventSource + POST`, and the bridge transport implements it over `queueMicrotask`.
- **Not persistent.** A channel disappears on disconnect. Persistence across reconnects is the exchange's concern (via `peerId` continuity), not the channel's.

### What a `ChannelDirectory` is NOT

- **Not service discovery.** It never learns about remote peers; it only tracks the local transport's own channels.
- **Not a routing table.** Routing (which peers receive which message) is done in the exchange. The directory is a plain `Map<ChannelId, Channel>` with id issuance.

---

## Message vocabulary

Exactly six messages (source: `packages/transport/src/messages.ts`). Two groups:

| Message | Group | Sender | Payload | Purpose |
|---------|-------|--------|---------|---------|
| `establish` | Lifecycle | Both peers, on connect | `{ identity: PeerIdentityDetails }` | Symmetric handshake — no request/response, both peers send |
| `depart` | Lifecycle | Departing peer | `{}` | Intentional, explicit departure — the receiver skips any disconnect-grace timer |
| `present` | Sync | Either peer | `{ docs: Array<{ docId, replicaType, syncProtocol, schemaHash, supportedHashes? }> }` | "I hold these documents" |
| `interest` | Sync | Either peer | `{ docId, version?, reciprocate? }` | "I want this document; here is my version" |
| `offer` | Sync | Either peer | `{ docId, payload: SubstratePayload, version, reciprocate? }` | "Here is state for this document" |
| `dismiss` | Sync | Leaving peer | `{ docId }` | "I am leaving the sync graph for this document" — dual of `present` |

`isLifecycleMsg` and `isSyncMsg` type-narrow a `ChannelMsg`. A `ConnectedChannel` may only send `LifecycleMsg`; an `EstablishedChannel` may only send `SyncMsg`. The type system enforces the ordering constraint — no sync message can be sent before `establish` completes.

### What "message" means here (and does NOT mean)

- **Not a wire frame.** `ChannelMsg` is the abstract shape. The `Pipeline` transforms it through aliasing, codec encoding, and framing before it reaches the wire. A transport sends wire pieces, not messages directly.
- **Not addressed.** A `ChannelMsg` has no `to` or `from` field. Routing information lives in `AddressedEnvelope` / `ReturnEnvelope`, or implicitly in the channel the message flowed through.

### Why `OfferMsg.payload` is opaque

`payload: SubstratePayload` is declared in `@kyneta/schema`. Its internal `kind` discriminant (`"entirety"` or `"since"`) is meaningful to the substrate, not to the transport. The exchange hands the payload to `substrate.merge(payload)` without inspection. This keeps `@kyneta/transport` free of any Loro / Yjs / JSON-specific logic — the same message vocabulary carries every substrate type.

---

## Channel lifecycle

A channel moves through three states (source: `packages/transport/src/channel.ts`):

```/dev/null/channel-lifecycle.txt#L1-3
Generated  ──generate()──►  Connected  ──establish handshake──►  Established
```

| State | How it got here | What it can do |
|-------|-----------------|----------------|
| `GeneratedChannel` | Concrete transport's `generate(context)` returned it | Has `send` and `stop` actions; not yet registered |
| `ConnectedChannel` | `ChannelDirectory.create` assigned it a `channelId` and wired `onReceive` | Can send `LifecycleMsg` only |
| `EstablishedChannel` | `establish` handshake completed; remote `peerId` is known | Can send `SyncMsg` only |

`isEstablished(channel)` is the type guard for the post-handshake state.

### Transport lifecycle

The `Transport<G>` base class enforces a four-state lifecycle (source: `packages/transport/src/transport.ts` → `AdapterLifecycleState`):

| State | Entry point | Exit |
|-------|-------------|------|
| `created` | Constructor | `_initialize` |
| `initialized` | `_initialize(context)` injects identity + callbacks | `_start` |
| `started` | `_start()` calls `onStart()`; channels may now be added | `_stop` |
| `stopped` | `_stop()` calls `onStop()` and clears the directory | terminal; re-initialization is allowed (for HMR) |

`addChannel`, `removeChannel`, and `establishChannel` throw outside the `started` state.

### `generate` vs `addChannel`

`generate(context: G)` (protected, abstract) produces a `GeneratedChannel` — the raw send/stop actions for one peer. `addChannel(context)` wraps it: assigns a `channelId`, wires `onReceive` to the injected `onChannelReceive` callback, fires `onChannelAdded`, and returns the `ConnectedChannel`. A concrete transport implements `generate` and calls `addChannel` from `onStart`.

---

## Writing a transport

A concrete transport must:

1. Subclass `Transport<G>` and supply its per-channel context type.
2. Implement `generate(context: G): GeneratedChannel` — create the raw send/stop closure for one peer.
3. Implement `onStart(): Promise<void>` — open listeners, create initial channels via `addChannel`, call `establishChannel(channelId)` once ready.
4. Implement `onStop(): Promise<void>` — close listeners, call `removeChannel` for each open channel.
5. Export a `TransportFactory` (zero-arg function returning a fresh instance) as its public entry point.

Everything else — the lifecycle state machine, channel directory, the six-message vocabulary, the send/receive typing narrow, the `_send(envelope)` fan-out — is inherited from `Transport<G>`.

### Factories, not instances

Every transport package exports `createXxxTransport(params): TransportFactory` rather than returning an instance directly. A factory is a zero-arg function that constructs a fresh `Transport`. The exchange calls it on construction and again on reset (e.g. React StrictMode double-mount). Passing an instance would share mutable state across lifecycles; passing a factory guarantees a clean slate.

### What the base class gives you for free

- Channel-ID issuance (monotonic counter in `ChannelDirectory`).
- Lifecycle-state guards on `addChannel` / `removeChannel` / `establishChannel`.
- Send fan-out: `_send(envelope)` iterates `envelope.toChannelIds` and calls each channel's `send`.
- Re-initialization for HMR: a second `_initialize` call resets the directory and re-enters `initialized`.
- Type-safe `send`: the compiler forbids sending `SyncMsg` on a `ConnectedChannel` and `LifecycleMsg` on an `EstablishedChannel`.

---

## `BridgeTransport` (moved)

In-process testing is provided by `@kyneta/bridge-transport` (`packages/exchange/transports/bridge`). Consumers import directly from `@kyneta/bridge-transport`. See that package's docs for usage.

The bridge transport lives outside `@kyneta/transport` for historical reasons — it was originally extracted to break a circular peer-dependency when `@kyneta/wire` had a peer-dep on `@kyneta/transport`. That cycle is now resolved (wire is a leaf, transport depends on wire), but the bridge remains in its own package because it has grown its own test surface and is a natural boundary.

---

## Canonical symbols

| Symbol | Source | Role |
|--------|--------|------|
| `Pipeline<S, R>` | `src/pipeline.ts` | The single wire pipeline. `S` = send encoding, `R` = receive encoding. |
| `Encoding` | `src/pipeline-core.ts` | `"binary" \| "text"`. |
| `PayloadOf<E>` | `src/pipeline-core.ts` | `{ binary: Uint8Array; text: string }[E]`. |
| `WireOpts` | `src/pipeline.ts` | Optional pipeline configuration (threshold, reassembly limits, `onError`). |
| `FrameStreamParser` | `src/frame-stream-parser.ts` | Stateful byte-stream → binary-frame extractor. |

Re-exports from `@kyneta/wire`:

| Symbol | Original source | Role |
|--------|----------------|------|
| `Result<T, E>`, `Ok<T>`, `Err<E>` | `wire/src/result.ts` | Typed success/failure union. |
| `ok`, `err` | `wire/src/result.ts` | Constructors. |
| `WireError` | `wire/src/wire-error.ts` | Discriminated union of all pipeline errors. |

---

## Wire pipeline

Source: `packages/transport/src/pipeline.ts`, `packages/transport/src/pipeline-core.ts`.

### Alias-table architecture

The alias transformer (`applyOutboundAliasing` / `applyInboundAliasing` in `src/alias-table.ts`) is the single `ChannelMsg ⇄ WireMessage` conversion layer. It compresses repeated doc IDs and schema hashes into integer aliases that are learned by both peers during the `present` phase. The `AliasState` record tracks both outbound (doc → alias) and inbound (alias → doc) mappings.

Alias state is owned per-Pipeline (and therefore per-channel). When a channel closes, its aliases are discarded. This is why there is no parallel-keyed map to keep in sync — the alias lifecycle is the channel lifecycle.

### FC/IS split

The pipeline follows a functional core / imperative shell design:

- **Functional core**: `sendStep` and `receiveStep` (in `pipeline-core.ts`) are pure step functions. They take immutable state and return new state + a list of `Result<T, WireError>` outputs.
- **Imperative shell**: `Pipeline` (in `pipeline.ts`) owns mutable state (alias table, reassembler, frame ID counter) and delegates all logic to the step functions. It also routes errors through the `onError` callback for observability.

### Pipeline lifecycle

```/dev/null/pipeline-lifecycle.txt#L1-7
ChannelMsg ──► applyOutboundAliasing ──► WireMessage
                                          │
                encodeWire ──► payload ──► fragment if > threshold
                                          │
                encodeFrame ──► wire pieces ──► transport.send()

wire piece ──► reassembler ──► decodeWire ──► applyInboundAliasing ──► ChannelMsg
```

`pipeline.send(msg)` returns `Result<PayloadOf<S>, WireError>[]` — zero or more wire pieces (one for unfragmented, many for fragmented). `pipeline.receive(piece)` returns `Result<ChannelMsg, WireError>[]` — zero (fragment pending) or one (complete message).

### Asymmetric `AliasState` invariant

For asymmetric pipelines (SSE: send text, receive binary), the alias table is shared across both directions. Both `sendStep` and `receiveStep` read and write the same `AliasState`. This works because alias assignments are deterministic and both peers learn aliases through the same `present` messages regardless of the encoding used in each direction.

---

## Stream-substrate boundary discovery

Source: `packages/transport/src/frame-stream-parser.ts`, `packages/transport/src/frame-stream-parser-core.ts`.

Unix sockets and any stream-oriented transport deliver bytes as a coalesced stream. Writes may merge; reads deliver arbitrary chunks. `FrameStreamParser` is the stateful class that extracts complete binary frames from the stream:

```/dev/null/frame-stream-parser-api.txt#L1-4
const parser = new FrameStreamParser()
const frames: Result<Uint8Array, WireError>[] = parser.feed(chunk)
// Each frame in `frames` is ok(complete binary wire frame)
parser.reset()
```

Internally, `feedBytesStep(state, chunk)` is the pure step function (FC/IS pattern). `StreamParserState` is a two-phase discriminated union: `{ phase: "header" }` while the 6-byte header accumulates, then `{ phase: "payload" }` while the declared payload accumulates. When a payload completes, the parser emits the full frame bytes (header + payload) and resets to `"header"`.

### What stream framing is NOT

- **Not a decoder.** `FrameStreamParser` emits raw frame bytes; the caller pipes them through the pipeline's `receive` method.
- **Not a fragment collector.** Stream framing and payload fragmentation are orthogonal — a Unix-socket transport uses stream framing because it has no gateway cap, and does not use fragmentation at all.
- **Not a parser for the text pipeline.** SSE has its own event-boundary framing; the text pipeline uses `Pipeline.receive` directly on each event's `data:` field.

---

## Reconnection utilities

`packages/transport/src/reconnect.ts` exports two items and no state.

| Export | Type | Purpose |
|--------|------|---------|
| `DEFAULT_RECONNECT` | `ReconnectOptions` | `{ enabled: true, maxAttempts: 10, baseDelay: 1000, maxDelay: 30000 }` |
| `computeBackoffDelay(attempt, baseDelay, maxDelay, jitter)` | `(n, n, n, n) => number` | Pure: `min(baseDelay × 2^(attempt−1) + jitter, maxDelay)`. Jitter is injected, not generated internally — for testability. |

Scheduling (`setTimeout`, retry on failure) happens inside each concrete transport's client program. `@kyneta/transport` only owns the pure backoff math.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `Transport<G>` | `src/transport.ts` | Abstract base class — concrete transports extend. |
| `AnyTransport` | `src/transport.ts` | `Transport<any>` — for heterogeneous collections. |
| `TransportFactory` | `src/transport.ts` | `() => AnyTransport`. |
| `TransportContext` | `src/transport.ts` | `{ identity, onChannelReceive, onChannelAdded, onChannelRemoved, onChannelEstablish }`. |
| `Channel` | `src/channel.ts` | `ConnectedChannel \| EstablishedChannel`. |
| `GeneratedChannel` | `src/channel.ts` | Pre-registration; has `send` + `stop` + `transportType`. |
| `ConnectedChannel` | `src/channel.ts` | Post-registration, pre-handshake; `send: (LifecycleMsg) => void`. |
| `EstablishedChannel` | `src/channel.ts` | Post-handshake; `send: (SyncMsg) => void`; `peerId` is known. |
| `ChannelDirectory<G>` | `src/channel-directory.ts` | Per-transport channel store, owns ID issuance. |
| `ChannelMsg` / `LifecycleMsg` / `SyncMsg` | `src/messages.ts` | Message unions. |
| `EstablishMsg`, `DepartMsg`, `PresentMsg`, `InterestMsg`, `OfferMsg`, `DismissMsg` | `src/messages.ts` | Individual message types. |
| `AddressedEnvelope` / `ReturnEnvelope` | `src/messages.ts` | Outbound / inbound routing wrappers. |
| `PeerIdentityDetails` | `src/types.ts` | `{ peerId, name?, type }`. |
| `PeerId` / `DocId` / `ChannelId` / `TransportType` | `src/types.ts` | String / string / number / string identity aliases. |
| `Pipeline<S, R>` | `src/pipeline.ts` | The single wire pipeline. |
| `WireOpts` | `src/pipeline.ts` | Pipeline configuration. |
| `Encoding` / `PayloadOf<E>` | `src/pipeline-core.ts` | Encoding discriminant and payload type mapping. |
| `FrameStreamParser` | `src/frame-stream-parser.ts` | Byte-stream → binary-frame extractor. |
| `AliasState` / `applyOutboundAliasing` / `applyInboundAliasing` / `emptyAliasState` | `src/alias-table.ts` | Alias transformer (internal to pipeline). |
| `ReconnectOptions` / `DEFAULT_RECONNECT` / `computeBackoffDelay` | `src/reconnect.ts` | Pure backoff math. |
| `StateTransition` / `TransitionListener` | re-exported from `@kyneta/machine` | Surfaced for consumers observing client-program state. |

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | ~110 | Public exports + re-exports from `@kyneta/wire`. |
| `src/types.ts` | ~32 | Identity type aliases and `PeerIdentityDetails`. |
| `src/messages.ts` | ~165 | The six-message vocabulary, unions, type guards, envelopes. |
| `src/channel.ts` | ~115 | Channel lifecycle types and `isEstablished` guard. |
| `src/channel-directory.ts` | ~79 | `ChannelDirectory<G>` — channel store with monotonic ID issuance. |
| `src/transport.ts` | ~266 | `Transport<G>` abstract class, lifecycle, internal `_initialize` / `_start` / `_stop` / `_send`. |
| `src/pipeline.ts` | ~115 | `Pipeline<S, R>` — imperative shell wrapping step functions. |
| `src/pipeline-core.ts` | ~130 | `sendStep` / `receiveStep` — pure step functions (functional core). |
| `src/alias-table.ts` | ~510 | `AliasState`, `applyOutboundAliasing`, `applyInboundAliasing` — ChannelMsg ↔ WireMessage. |
| `src/frame-stream-parser.ts` | ~30 | `FrameStreamParser` — imperative shell for stream parsing. |
| `src/frame-stream-parser-core.ts` | ~155 | `feedBytesStep` — pure stream frame extraction. |
| `src/reconnect.ts` | ~53 | `computeBackoffDelay`, `DEFAULT_RECONNECT`. |

## Testing

Tests run in-process using a minimal in-test `TestAdapter`. The bridge transport now lives in `@kyneta/bridge-transport` and has its own test suite. Real transport packages maintain their own test suites with their own integration harnesses; this package's tests only exercise the abstract contract.

Run with `cd packages/transport && pnpm exec vitest run`.
