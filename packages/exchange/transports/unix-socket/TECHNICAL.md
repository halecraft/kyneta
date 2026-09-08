# @kyneta/unix-socket-transport — Technical Reference

> **Package**: `@kyneta/unix-socket-transport`
> **Role**: Unix domain socket transport for `@kyneta/exchange` — stream-oriented framing with backpressure, a pure client lifecycle, a pure leaderless-peer negotiator, and runtime-neutral `UnixSocket` wrappers for Node and Bun.
> **Depends on**: `@kyneta/machine`, `@kyneta/transport` (all peer)
> **Depended on by**: `@kyneta/exchange` (through application configuration)
> **Canonical symbols**: `createUnixSocketClient`, `UnixSocketClientTransport`, `UnixSocketClientOptions`, `UnixSocketServerTransport`, `UnixSocketServerOptions`, `UnixSocketListener`, `UnixSocketConnection`, `connect`, `listen`, `createUnixSocketPeer`, `UnixSocketPeerHandle`, `UnixSocketPeerTransport`, `UnixSocketPeerOptions`, `createPeerProgram`, `PeerMsg`, `PeerEffect`, `PeerModel`, `PeerRole`, `createUnixSocketClientProgram`, `UnixSocketClientMsg`, `UnixSocketClientEffect`, `UnixSocketClientState`, `UnixSocket`, `wrapNodeUnixSocket`, `wrapBunUnixSocket`, `ProbeResult`
> **Internal (not exported)**: `SocketTransport`, `ChannelSink`, `attachSocket`, `ConnectorDriver`, `ListenerDriver`, `probe`
> **Key invariant(s)**: Unix sockets are byte streams, not message streams — every outbound payload is length-prefixed by the binary frame header and every inbound chunk flows through `FrameStreamParser` from `@kyneta/transport`. There is no fragmentation layer (no gateway cap); a single message is one frame regardless of size.

A Unix-domain-socket transport kit for server-to-server sync. It runs the same binary `Pipeline` (from `@kyneta/transport`) as the WebSocket and WebRTC transports, but replaces message-oriented framing with `FrameStreamParser` (from `@kyneta/transport`) because stream transports coalesce writes and split reads at arbitrary boundaries.

Imported by server-side applications that want sync to flow over a local filesystem socket rather than a TCP connection. The package also exports a leaderless-peer negotiator so two processes sharing a socket path can cooperate without either being pre-designated the server.

---

## Questions this document answers

- Why stream framing instead of `the `Pipeline`'s fragment protocol? → [Stream framing, not fragmentation](#stream-framing-not-fragmentation)
- What does "leaderless topology" mean and when do I want it? → [Leaderless peer negotiation](#leaderless-peer-negotiation)
- How does backpressure work? → [Backpressure and the write queue](#backpressure-and-the-write-queue)
- What does the client state machine look like? → [Client state machine](#client-state-machine)
- Why two separate programs (client + peer) instead of one? → [Two programs, not one](#two-programs-not-one)
- How do I mount this under Node? Under Bun? → [Runtime wrappers](#runtime-wrappers)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| Unix socket | A filesystem-path-addressed byte-stream socket (`AF_UNIX`, `SOCK_STREAM`). | A TCP socket, a named pipe, shared memory, a POSIX message queue |
| `UnixSocket` | Framework-agnostic interface: `write` (returns backpressure bool), `end`, `onData`, `onClose`, `onError`, `onDrain`. | The runtime's raw `net.Socket` or Bun socket |
| `UnixSocketClientTransport` | The client-side `Transport<...>` subclass. Owns one outbound connection. | `UnixSocketServerTransport` |
| `UnixSocketServerTransport` | The server-side `Transport<...>` subclass. Accepts inbound connections via a listener. | `UnixSocketListener`, which is the platform listening object |
| `UnixSocketConnection` | Per-peer connection — owns the stream-frame parser, the alias-aware binary pipeline, and the outbound write queue. | `UnixSocket`, which is the raw byte pipe |
| `UnixSocketPeerTransport` | The leaderless peer — a single `Transport` that swaps its socket mode (listener ↔ connector) in place. | A regular client or server transport instance |
| `UnixSocketPeerHandle` | What `createUnixSocketPeer` returns: a `TransportFactory` augmented with `role` / `subscribe`. Passed to `new Exchange({ transports: [peer] })`. | The transport instance it creates |
| `createPeerProgram` | Factory returning a pure `Program<PeerMsg, PeerModel, PeerEffect>` that encodes the listen-or-connect decision. Model is `{ role }`. | `createUnixSocketClientProgram`, which is for the client lifecycle only |
| `ProbeResult` | `"connected" \| "enoent" \| "econnrefused" \| "eaddrinuse"` — the outcome of probing a socket path. | A TCP probe or port scan |
| `createUnixSocketClientProgram` | Factory returning a pure `Program<UnixSocketClientMsg, ...>` that owns the client connect / reconnect lifecycle. | The peer program |
| `PeerEffect` | Inspectable data describing what the peer needs (`probe`, `start-listener`, `start-connector`, `teardown`, `delay-then-probe`) — interpreted by starting/stopping internal drivers, never by touching the Exchange. | An `Effect<Msg>` closure |
| `ConnectorDriver` / `ListenerDriver` | Transport-free imperative shells that acquire sockets (connect+reconnect / listen+accept) and turn them into channels via `attachSocket`. Shared by the fixed-role transports and the peer. | A `Transport` — drivers have no lifecycle of their own |
| `UnixSocketClientEffect` | Inspectable data for client-side I/O (`connect`, `close-connection`, `add-channel-and-establish`, `remove-channel`, `start-reconnect-timer`, `cancel-reconnect-timer`). | `PeerEffect` |
| Backpressure | `write()` returns `false` — kernel buffer is full. Caller waits for `onDrain` before resuming. | A timeout, a rate-limit |
| `feedBytes` | Pure stream-frame parser from `@kyneta/transport` (`FrameStreamParser`). Takes accumulated state + a chunk; returns new state + extracted frames. | `FragmentReassembler` — stream framing and fragment reassembly are orthogonal |

---

## Architecture

**Thesis**: Unix sockets are fundamentally different from WebSockets and SSE — they are byte streams, not message streams, and both ends are symmetric peers of a filesystem path rather than client-and-server. Both facts reshape the transport.

Two structural differences from the WebSocket transport:

| Dimension | WebSocket | Unix socket |
|-----------|-----------|-------------|
| Framing | Protocol-native (WebSocket frame) | Application-level (binary frame header + `FrameStreamParser`) |
| Coalescing | Impossible — each WS message is atomic | Normal — writes may merge; reads may split |
| Size limit | Gateway-imposed (e.g. AWS 128 KB) | None — kernel buffer only, drained via backpressure |
| Fragmentation | Required above gateway cap | Not used — one frame per message, any size |
| Topology | Client ↔ Server | Leaderless peer (optional) or Client ↔ Server |
| Ready gate | Yes (server sends `"ready"`) | No (stream is bidirectionally ready on connect) |

All else — the binary `Pipeline` (from `@kyneta/transport`), the `createObservableProgram` runtime, the exchange's six-message protocol, the channel lifecycle — is identical.

### What this transport is NOT

- **Not IPC in the OS-semaphore or shared-memory sense.** `AF_UNIX`/`SOCK_STREAM` is a byte-stream socket. There are no mutexes, no shared pages, no ring buffers exposed to user code.
- **Not message-oriented.** There is no datagram mode (`SOCK_DGRAM`) in this transport. One send on one side may arrive as several reads on the other; two sends may arrive as one read.
- **Not cross-machine.** Unix sockets are local to a host. Use `@kyneta/websocket-transport` or `@kyneta/webrtc-transport` for remote peers.
- **Not suitable under most serverless runtimes.** Many serverless environments disable or restrict `AF_UNIX`. This transport targets long-running server processes (Node, Bun) sharing a filesystem.

### What `UnixSocket` is NOT

- **Not `net.Socket`.** It is a structural subset — `write`, `end`, plus four event callbacks. Node's `net.Socket` satisfies it via `wrapNodeUnixSocket`; Bun's API does via `wrapBunUnixSocket`.
- **Not bound to a specific runtime.** Code that uses `UnixSocket` runs under both Node and Bun without change.
- **Not synchronous.** `write(data)` may return `false` indicating the kernel buffer is full; in that case the caller must wait for `onDrain` before writing more.

---

## Stream framing, not fragmentation

Source: `packages/exchange/transports/unix-socket/src/connection.ts`.

The inbound pipeline:

```
onData(chunk)
  └─ feedBytes(parserState, chunk) ──► { state, frames: Uint8Array[] }
     └─ for each frame:
        └─ decodeBinaryFrame(frame) ──► Frame<Uint8Array>
           └─ decodeWireMessage(frame.content.payload) ──► WireMessage
              └─ applyInboundAliasing ──► ChannelMsg[]
                └─ onChannelReceive(channelId, msg)
```

`feedBytes` is pure — it takes the parser's current state (either accumulating a 6-byte header or accumulating the declared payload), consumes bytes from the chunk, and emits any complete frames. The `StreamParserState` discriminated union makes every partial state representable.

The outbound pipeline is similarly direct:

```
ChannelMsg
  └─ applyOutboundAliasing ──► WireMessage
     └─ encodeWireMessage ──► Uint8Array (payload)
        └─ encodeBinaryFrame(complete(WIRE_VERSION, seq, payload)) ──► Uint8Array (framed)
           └─ connection.write(framed)
```

There is no `fragmentPayload` call. Every message is one complete frame with a 10-byte header. The kernel splits writes across chunks based on its own buffering; `feedBytes` reassembles them from length alone.

### Why no fragmentation layer

Cloud gateways (AWS API Gateway, Cloudflare Workers) enforce per-message size caps — that is why `@kyneta/transport`'s `Pipeline` includes a fragmentation layer and why the WebSocket transport uses it. Unix sockets have no such gateway. The only limit is the kernel send buffer, which is drained via backpressure, not exceeded.

Adding fragmentation here would be dead weight: every message would pay the 28-byte fragment overhead with nothing to gain.

### What stream framing is NOT

- **Not a decoder.** `feedBytes` emits raw frame bytes; the pipeline feeds them into `decodeBinaryFrame` + `decodeWireMessage`.
- **Not a fragment reassembler.** The `Pipeline`'s fragment reassembler is not used here (threshold = 0). Stream framing and payload fragmentation address different problems.
- **Not lossy.** Unix sockets are reliable; if the kernel buffer overflows, `write` returns `false` and the producer waits. `feedBytes` never drops bytes.

---

## Backpressure and the write queue

Source: `packages/exchange/transports/unix-socket/src/connection.ts` → `write` queue + `onDrain` handler.

When `UnixSocket.write(data)` returns `false`, the kernel buffer is full. The connection queues subsequent writes in an internal FIFO and drains them when `onDrain` fires:

```
send(msg)
  └─ frame = encode(msg)
     └─ if queue is empty and channel.write(frame) returned true:
           continue — buffer accepted it
        else:
           push frame to queue
  onDrain:
    └─ while queue not empty and channel.write(head) returned true:
          shift head
```

Producer code (the exchange's sync program) never sees the queue or the drain — it calls `channel.send(msg)` and the connection handles the rest. If the process ends while the queue is non-empty, those messages are lost; this is acceptable because exchange re-sync on reconnect fills any gap.

---

## Client state machine

Source: `packages/exchange/transports/unix-socket/src/client-program.ts`, `src/types.ts`.

The client program is a pure `Program<UnixSocketClientMsg, UnixSocketClientState, UnixSocketClientEffect>`. Interpretation happens in `UnixSocketClientTransport` via `createObservableProgram`.

| State (`status`) | How it got here | Can transition to |
|------------------|-----------------|-------------------|
| `disconnected` | Initial / terminal | `connecting` (on `start`) |
| `connecting` | `connect` effect issued | `connected` (on `connection-opened`), `reconnecting` (on error or close) |
| `connected` | Connection opened; `add-channel-and-establish` effect issued | `reconnecting` (on close), `disconnected` (on `stop`) |
| `reconnecting` | Waiting for backoff timer | `connecting` (on timer fire), `disconnected` (on max retries or explicit `stop`) |

Messages (`UnixSocketClientMsg`): `start`, `connection-opened`, `connection-closed`, `connection-error`, `reconnect-timer-fired`, `stop`.

Effects (`UnixSocketClientEffect`): `connect`, `close-connection`, `add-channel-and-establish`, `remove-channel`, `start-reconnect-timer`, `cancel-reconnect-timer`.

Four states, not five — there is no server `"ready"` gate because Unix-socket connections are bidirectionally established the moment `accept()` returns (no out-of-band handler wiring is possible under stream semantics).

Backoff uses `shouldReconnect` from `@kyneta/transport` (which internally calls `computeBackoffDelay`). Jitter is proportional (0–20% of the raw delay); the random source is `randomFn` on `UnixSocketClientProgramOptions` (default `Math.random`, pinned to `() => 0` in tests).

### What `createUnixSocketClientProgram` is NOT

- **Not aware of the socket.** It emits `connect` / `close-connection` effects; the shell holds the actual `UnixSocket` instance.
- **Not aware of the filesystem.** It knows its `path` as a string; the actual `net.connect(path)` / `Bun.connect({ unix: path })` happens in the shell.
- **Not re-used by the peer program.** The peer program sits above it; see next section.

---

## Leaderless peer negotiation

Source: `packages/exchange/transports/unix-socket/src/peer-program.ts`, `src/peer-transport.ts`, `src/peer.ts`.

Two processes sharing a socket path sometimes need to cooperate without either being pre-designated the server. Example: a dev tool and a CLI both mounted against the same socket, where whichever starts first should listen and whichever starts second should connect.

**The peer is a single `Transport`, not an Exchange consumer.** `createUnixSocketPeer({ path })` returns a `TransportFactory` (augmented with `role` / `subscribe`); you hand it to `new Exchange({ transports: [peer] })` like every other transport. It does **not** receive or call the `Exchange` — earlier versions took `createUnixSocketPeer(exchange, …)` and swapped whole child transports via `exchange.addTransport()` / `removeTransport()`; that inverted the dependency direction and dragged the `Exchange` *class* into the package's public `.d.ts`, where its `#private` field created a dual-package nominal mismatch for any cross-package consumer. The peer is now `UnixSocketPeerTransport` (`src/peer-transport.ts`), a `SocketTransport` that:

1. **Probes** the socket path with a short connection attempt.
2. Based on the `ProbeResult`, decides:
   | Probe result | Decision |
   |--------------|----------|
   | `connected` | Something is already listening — become the connector |
   | `enoent` / `econnrefused` | No server / nothing listening — become the listener |
   | `eaddrinuse` | Race: another process is mid-bind — retry probe after `retryDelayMs` |
3. **Starts an internal driver** — a `ListenerDriver` (binds, accepts N inbound channels) or a `ConnectorDriver` (connects, one outbound channel). Both feed the shared `attachSocket`, which adds/establishes channels on *this* transport via its `ChannelSink`.
4. **Heals in place.** If the listener dies, the connector's socket closes → the connector gives up (it does not reconnect to a dead listener; see below) → the program re-probes → it either reconnects to the new listener or **binds the socket itself**, swapping its socket *mode* under one stable `transportId`. The Exchange only ever observes channel add/remove — never a transport remove/add — so documents and CRDT state survive a heal.

The `ProbeResult` and the role-choosing logic are encoded in the pure `Program<PeerMsg, PeerModel, PeerEffect>` (`createPeerProgram`). The model is just `{ role }`; effects name the drivers (`start-listener`, `start-connector`, `teardown`). Every decision is data; tests assert on the effects.

### Recovery is re-negotiation, not reconnection

The peer's connector defaults to **no reconnect** (`{ enabled: false }`). In a leaderless topology, re-negotiation already subsumes reconnection: on disconnect the connector re-probes, which finds the new listener (→ connect) or finds nothing (→ become the listener). Reconnecting to the *old, dead* listener would only add latency (the default 1s base backoff × 5 attempts ≈ 31s before giving up). The fixed-role `UnixSocketClientTransport` keeps full reconnect — it has an authoritative server that is expected to return. A caller may still opt the peer into bounded reconnect via `UnixSocketPeerOptions.reconnect`.

### Gotchas

- **Teardown must close sockets, not just drop channels.** A driver's `stop()` calls `connection.close()` (and `listener.stop()` + unlink). If it only called `removeChannel`, a *co-located* peer (same process, e.g. in tests) would never observe the disconnect at the OS level and would never re-negotiate — the heal silently never fires. `channel.stop()` is **not** a substitute: nothing in the runtime invokes it.
- **Probes are silent at the peer layer.** A `probe()` opens-and-immediately-ends a connection. On a listener this is a brief inbound accept that creates a channel but never sends `establish` — so it produces an `addChannel`/`removeChannel` pair with **no** peer-level event. Don't key presence off raw channel count.

### What leaderless peer negotiation is NOT

- **Not a consensus protocol.** There is no leader election, no quorum. At any instant, exactly one peer is the listener.
- **Not suitable for more than two peers.** The model is pairwise. Multi-peer topologies should use a dedicated sync server. (Mechanically the listener hosts N channels, but the negotiation is designed for pairwise heal.)
- **Not the same as the fixed-role transports.** `createUnixSocketClient` + `UnixSocketServerTransport` give fixed roles. `createUnixSocketPeer` adds the probing + in-place role-switch on top, reusing the same drivers.

### Two programs, not one

Now composed inside one transport. `createPeerProgram` and `createUnixSocketClientProgram` stay separate: the peer program's concern is *which role to play*; the client program's concern is *the connect/reconnect lifecycle once connecting*. The `ConnectorDriver` composes the client program inside the peer's connector mode (and is reused verbatim by the fixed-role `UnixSocketClientTransport`). The split is preserved — it just lives behind the driver seam rather than spawning child transports.

### Drivers and the channel seam

`SocketTransport` (`src/socket-transport.ts`) is the base for all three roles: it is a `Transport<UnixSocketConnection>` — each channel's `send`/`stop` binds straight to its connection via `generate`, so there is **no `peerId`→connection map**. It lends its protected channel ops to a driver as a `ChannelSink`. `attachSocket` (`src/attach-socket.ts`) is the single place a raw socket becomes a live channel (`new UnixSocketConnection(socket)` → `addChannel` → `setChannel` → `start` → optional `establish`); the two drivers differ only in how they acquire sockets and handle close.

---

## Runtime wrappers

Two wrappers adapt runtime-specific socket implementations to `UnixSocket`:

| Runtime | Wrapper | Source |
|---------|---------|--------|
| Node `net.Socket` | `wrapNodeUnixSocket(socket)` | `src/types.ts` |
| Bun unix socket | `wrapBunUnixSocket(bunSocket, handlers)` | `src/types.ts` |

`connect(path)` and `listen(path, { onConnection })` (`src/connect.ts`, `src/listen.ts`) detect the runtime and route to the right wrapper. Applications generally do not call the wrappers directly.

### Node

```
import { createUnixSocketClient } from "@kyneta/unix-socket-transport"

const exchange = new Exchange({
  transports: [createUnixSocketClient({ path: "/tmp/kyneta.sock" })],
})
```

### Bun

Same call; runtime detection picks the Bun path. Applications that pre-instantiate their own `UnixSocket`-like object can hand it in directly through the lower-level `UnixSocketConnection` API, but this is rarely necessary.

### Server

```
import { UnixSocketServerTransport } from "@kyneta/unix-socket-transport"

const server = new UnixSocketServerTransport({ path: "/tmp/kyneta.sock" })

const exchange = new Exchange({ transports: [() => server] })
```

### Peer (leaderless)

```
import { createUnixSocketPeer } from "@kyneta/unix-socket-transport"

const peer = createUnixSocketPeer({ path: "/tmp/kyneta.sock" })

const exchange = new Exchange({ transports: [peer] })
```

---

## Wire pipeline

Uses `new Pipeline({ send: "binary" })` from `@kyneta/transport`, with no fragmentation (threshold = 0). The stream framing layer (`FrameStreamParser`) extracts complete frames from the byte stream before feeding them to the pipeline:

```/dev/null/unix-socket-pipeline.txt#L1-9
Outbound:
  ChannelMsg
    └─ pipeline.send(msg) → Result<Uint8Array, WireError>[]
       └─ UnixSocket.write(piece) (with backpressure queue)

Inbound:
  onData(chunk)
    └─ frameStreamParser.feed(chunk) → Result<Uint8Array, WireError>[]
       └─ pipeline.receive(frame) → Result<ChannelMsg, WireError>[]
          └─ onChannelReceive(channelId, msg)
```

---

## Key Types

| Type | File | Role |
|------|------|------|
| `UnixSocketClientTransport` | `src/client-transport.ts` | Client-side `Transport<...>` subclass. Runs the client program via `createObservableProgram`. |
| `UnixSocketClientOptions` | `src/client-transport.ts` | `{ path, reconnect?, ... }`. |
| `createUnixSocketClient` | `src/client-transport.ts` | `TransportFactory` for clients. |
| `UnixSocketServerTransport` | `src/server-transport.ts` | Server-side `Transport<...>` subclass. Accepts inbound connections via a listener. |
| `UnixSocketServerOptions` | `src/server-transport.ts` | `{ path, ... }`. |
| `UnixSocketListener` | `src/server-transport.ts` | The platform listening object (wraps Node's `net.Server` or Bun's equivalent). |
| `OnConnectionCallback` | `src/server-transport.ts` | `(socket: UnixSocket) => void` — fired per inbound accept. |
| `UnixSocketConnection` | `src/connection.ts` | Per-connection pipeline: parser state, alias-aware binary pipeline, write queue. Constructed `(socket)`; its channel is wired via `setChannel`. |
| `SocketTransport` | `src/socket-transport.ts` | Internal base: `Transport<UnixSocketConnection>` for all three roles; `generate` binds send to the connection; lends a `ChannelSink`. |
| `ChannelSink` / `attachSocket` | `src/socket-transport.ts` / `src/attach-socket.ts` | The channel-lifecycle seam a driver uses, and the one routine that turns a socket into a live channel. |
| `ConnectorDriver` / `ListenerDriver` | `src/connector-driver.ts` / `src/listener-driver.ts` | Transport-free shells: connect+reconnect (1 channel) / listen+accept (N channels). |
| `UnixSocketPeerTransport` | `src/peer-transport.ts` | Leaderless peer — one `SocketTransport` that swaps socket mode in place by driving a connector/listener driver. |
| `UnixSocketPeerHandle` | `src/peer.ts` | `TransportFactory` + `role` / `subscribe`, returned by `createUnixSocketPeer`. |
| `UnixSocketPeerOptions` | `src/peer-transport.ts` | `{ path, reconnect?, retryDelayMs? }`. |
| `createUnixSocketPeer` | `src/peer.ts` | Factory returning a `UnixSocketPeerHandle`. |
| `createPeerProgram` | `src/peer-program.ts` | Pure `Program<PeerMsg, PeerModel, PeerEffect>`; model is `{ role }`. |
| `PeerModel` / `PeerMsg` / `PeerEffect` / `PeerRole` / `PeerProgramOptions` | `src/peer-program.ts` | Peer program's types. |
| `ProbeResult` | `src/peer-program.ts` | `"connected" \| "enoent" \| "econnrefused" \| "eaddrinuse"`. |
| `createUnixSocketClientProgram` | `src/client-program.ts` | Pure client `Program`. |
| `UnixSocketClientMsg` / `UnixSocketClientEffect` | `src/client-program.ts` | Client program's messages / effects. |
| `UnixSocketClientState` | `src/types.ts` | Client state discriminated union. |
| `DisconnectReason` | `src/types.ts` | Discriminated union describing why a connection was lost. |
| `UnixSocket` | `src/types.ts` | Runtime-neutral socket interface. |
| `NodeUnixSocketLike` / `BunUnixSocketLike` / `BunSocketHandlers` | `src/types.ts` | Runtime-specific structural shapes. |
| `wrapNodeUnixSocket` / `wrapBunUnixSocket` | `src/types.ts` | Wrappers to `UnixSocket`. |
| `connect` | `src/connect.ts` | Runtime-detected connect helper. |
| `listen` | `src/listen.ts` | Runtime-detected listen helper. |

## File Map

| File | Role |
|------|------|
| `src/index.ts` | Public exports. |
| `src/types.ts` | `UnixSocket`, client state, disconnect reason, runtime wrappers. |
| `src/socket-transport.ts` | `SocketTransport` base + `ChannelSink` (no `peerId` map; `generate` binds send to the connection). |
| `src/attach-socket.ts` | The one socket → live-channel routine, shared by both drivers. |
| `src/connection.ts` | Per-connection parser state, write queue. Constructed `(socket)`. |
| `src/client-program.ts` | Pure `createUnixSocketClientProgram` Mealy machine. |
| `src/connector-driver.ts` | Connect + bounded reconnect; one outbound channel; `onExhausted`. |
| `src/listener-driver.ts` | Listen + accept; N inbound channels; socket-file lifecycle. |
| `src/client-transport.ts` | Fixed-role client: thin `SocketTransport` over `ConnectorDriver`. |
| `src/server-transport.ts` | Fixed-role server: thin `SocketTransport` over `ListenerDriver`. |
| `src/peer-program.ts` | Pure `createPeerProgram` Mealy machine (`{ role }` model). |
| `src/peer-transport.ts` | `UnixSocketPeerTransport`: drives a connector/listener driver per role, in place. |
| `src/peer.ts` | `createUnixSocketPeer` factory → `UnixSocketPeerHandle`. |
| `src/probe.ts` | Classify a socket path (`connected`/`enoent`/`econnrefused`/`eaddrinuse`). |
| `src/connect.ts` | Runtime-detected connect helper. |
| `src/listen.ts` | Runtime-detected listen helper. |
| `src/__tests__/client-program.test.ts` | Pure tests: every client state transition and effect asserted on data. |
| `src/__tests__/peer-program.test.ts` | Pure tests: every peer state transition and effect asserted on data. |
| `src/__tests__/connection.test.ts` | Stream framing round-trips, backpressure, write queue. |
| `src/__tests__/peer-role-flip.test.ts` | E2E: the in-place connector→listener heal (transportId stable, docs survive, probe silence). |
| `src/__tests__/unix-socket-transport.test.ts` | E2E with real Unix sockets: client reconnects after server restart, full sync round-trips. |
| `src/__tests__/mock-unix-socket.ts` | A test-only `UnixSocket` with scripted behaviour and backpressure control. |

## Testing

The two pure programs (`createUnixSocketClientProgram`, `createPeerProgram`) are tested by dispatching messages and asserting on the returned `[state, ...effects]` tuples — no sockets. The connection tests use a scripted mock `UnixSocket`. The drivers are not unit-tested directly: they are imperative shells over the already-tested pure programs + `UnixSocketConnection`, and the real-socket E2E suites exercise their composition. `unix-socket-transport.test.ts` covers the fixed-role transports (incl. reconnect after server restart); `peer-role-flip.test.ts` covers the leaderless peer's in-place heal.

**Tests**: 77 passed, 0 skipped across 5 files (`client-program.test.ts`: 37, `peer-program.test.ts`: 20, `connection.test.ts`: 13, `unix-socket-transport.test.ts`: 6, `peer-role-flip.test.ts`: 1). Run with `cd packages/exchange/transports/unix-socket && pnpm exec vitest run`.