# @kyneta/unix-socket-transport — Technical Reference

> **Package**: `@kyneta/unix-socket-transport`
> **Role**: Unix domain socket transport for `@kyneta/exchange` — stream-oriented framing with backpressure, a pure client lifecycle, a pure leaderless-peer negotiator, and runtime-neutral `UnixSocket` wrappers for Node and Bun.
> **Depends on**: `@kyneta/machine`, `@kyneta/transport`, `@kyneta/wire` (all peer)
> **Depended on by**: `@kyneta/exchange` (through application configuration)
> **Canonical symbols**: `createUnixSocketClient`, `UnixSocketClientTransport`, `UnixSocketClientOptions`, `UnixSocketServerTransport`, `UnixSocketServerOptions`, `UnixSocketListener`, `UnixSocketConnection`, `connect`, `listen`, `createUnixSocketPeer`, `UnixSocketPeer`, `UnixSocketPeerOptions`, `createPeerProgram`, `PeerMsg`, `PeerEffect`, `PeerModel`, `createUnixSocketClientProgram`, `UnixSocketClientMsg`, `UnixSocketClientEffect`, `UnixSocketClientState`, `UnixSocket`, `wrapNodeUnixSocket`, `wrapBunUnixSocket`, `ProbeResult`
> **Key invariant(s)**: Unix sockets are byte streams, not message streams — every outbound payload is length-prefixed by the binary frame header and every inbound chunk flows through `feedBytes` from `@kyneta/wire`. There is no fragmentation layer (no gateway cap); a single message is one frame regardless of size.

A Unix-domain-socket transport kit for server-to-server sync. It runs the same binary CBOR codec as the WebSocket and WebRTC transports, but replaces message-oriented framing with pure stream framing (`feedBytes` / `StreamParserState`) because stream transports coalesce writes and split reads at arbitrary boundaries.

Imported by server-side applications that want sync to flow over a local filesystem socket rather than a TCP connection. The package also exports a leaderless-peer negotiator so two processes sharing a socket path can cooperate without either being pre-designated the server.

---

## Questions this document answers

- Why stream framing instead of `@kyneta/wire`'s fragment protocol? → [Stream framing, not fragmentation](#stream-framing-not-fragmentation)
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
| `UnixSocketConnection` | Per-peer connection — owns the stream-frame parser, the CBOR codec, and the outbound write queue. | `UnixSocket`, which is the raw byte pipe |
| `UnixSocketPeer` | A peer running in leaderless mode. Chooses at runtime whether to listen or connect based on probing the socket path. | A regular client or server transport instance |
| `createPeerProgram` | Factory returning a pure `Program<PeerMsg, PeerModel, PeerEffect>` that encodes the listen-or-connect decision. | `createUnixSocketClientProgram`, which is for the client lifecycle only |
| `ProbeResult` | `"connected" \| "enoent" \| "econnrefused" \| "eaddrinuse"` — the outcome of probing a socket path. | A TCP probe or port scan |
| `createUnixSocketClientProgram` | Factory returning a pure `Program<UnixSocketClientMsg, ...>` that owns the client connect / reconnect lifecycle. | The peer program |
| `PeerEffect` | Inspectable data describing an I/O action the peer needs (`probe`, `start-listener`, `start-connector`, `remove-transport`, `delay-then-probe`). | An `Effect<Msg>` closure |
| `UnixSocketClientEffect` | Inspectable data for client-side I/O (`connect`, `close-connection`, `add-channel-and-establish`, `remove-channel`, `start-reconnect-timer`, `cancel-reconnect-timer`). | `PeerEffect` |
| Backpressure | `write()` returns `false` — kernel buffer is full. Caller waits for `onDrain` before resuming. | A timeout, a rate-limit |
| `feedBytes` | Pure stream-frame parser from `@kyneta/wire`. Takes accumulated state + a chunk; returns new state + extracted frames. | `FragmentReassembler` — stream framing and fragment reassembly are orthogonal |

---

## Architecture

**Thesis**: Unix sockets are fundamentally different from WebSockets and SSE — they are byte streams, not message streams, and both ends are symmetric peers of a filesystem path rather than client-and-server. Both facts reshape the transport.

Two structural differences from the WebSocket transport:

| Dimension | WebSocket | Unix socket |
|-----------|-----------|-------------|
| Framing | Protocol-native (WebSocket frame) | Application-level (`@kyneta/wire` binary header + `feedBytes`) |
| Coalescing | Impossible — each WS message is atomic | Normal — writes may merge; reads may split |
| Size limit | Gateway-imposed (e.g. AWS 128 KB) | None — kernel buffer only, drained via backpressure |
| Fragmentation | Required above gateway cap | Not used — one frame per message, any size |
| Topology | Client ↔ Server | Leaderless peer (optional) or Client ↔ Server |
| Ready gate | Yes (server sends `"ready"`) | No (stream is bidirectionally ready on connect) |

All else — the binary CBOR codec, the `createObservableProgram` runtime, the exchange's six-message protocol, the channel lifecycle — is identical.

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
           └─ cborCodec.decode(frame.content.payload) ──► ChannelMsg[]
              └─ onChannelReceive(channelId, msg)
```

`feedBytes` is pure — it takes the parser's current state (either accumulating a 7-byte header or accumulating the declared payload), consumes bytes from the chunk, and emits any complete frames. The `StreamParserState` discriminated union makes every partial state representable.

The outbound pipeline is similarly direct:

```
ChannelMsg
  └─ cborCodec.encode ──► Uint8Array (payload)
     └─ encodeBinaryFrame(complete(WIRE_VERSION, payload)) ──► Uint8Array (framed)
        └─ connection.write(framed)
```

There is no `fragmentPayload` call. Every message is one complete frame with a 7-byte header. The kernel splits writes across chunks based on its own buffering; `feedBytes` reassembles them from length alone.

### Why no fragmentation layer

Cloud gateways (AWS API Gateway, Cloudflare Workers) enforce per-message size caps — that is why `@kyneta/wire` ships a fragmentation protocol and why the WebSocket transport uses it. Unix sockets have no such gateway. The only limit is the kernel send buffer, which is drained via backpressure, not exceeded.

Adding fragmentation here would be dead weight: every message would pay the 28-byte fragment overhead with nothing to gain.

### What stream framing is NOT

- **Not a decoder.** `feedBytes` emits raw frame bytes; the pipeline feeds them into `decodeBinaryFrame` + `cborCodec.decode`.
- **Not a fragment reassembler.** The `FragmentReassembler` from `@kyneta/wire` is not used here. Stream framing and payload fragmentation address different problems.
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

Backoff uses `computeBackoffDelay` from `@kyneta/transport` with injected jitter (`jitterFn`, default `() => Math.random() * 1000`) for deterministic testing.

### What `createUnixSocketClientProgram` is NOT

- **Not aware of the socket.** It emits `connect` / `close-connection` effects; the shell holds the actual `UnixSocket` instance.
- **Not aware of the filesystem.** It knows its `path` as a string; the actual `net.connect(path)` / `Bun.connect({ unix: path })` happens in the shell.
- **Not re-used by the peer program.** The peer program sits above it; see next section.

---

## Leaderless peer negotiation

Source: `packages/exchange/transports/unix-socket/src/peer-program.ts`, `src/peer.ts`.

Two processes sharing a socket path sometimes need to cooperate without either being pre-designated the server. Example: a dev tool and a CLI both mounted against the same socket, where whichever starts first should listen and whichever starts second should connect.

`createUnixSocketPeer({ path, ... })` produces a `UnixSocketPeer` that:

1. **Probes** the socket path with a short connection attempt.
2. Based on the `ProbeResult`, decides:
   | Probe result | Decision |
   |--------------|----------|
   | `connected` | Something is already listening — become the connector |
   | `enoent` / `econnrefused` | No server / nothing listening — become the listener |
   | `eaddrinuse` | Race: another process is in the middle of becoming the listener — retry probe after `retryDelayMs` |
3. **Instantiates** either a `UnixSocketClientTransport` (connector) or a `UnixSocketServerTransport` (listener).
4. **Re-probes** on transport disconnect — if the listener dies, the connector re-probes and may become the new listener.

The `ProbeResult` and the role-choosing logic are encoded in the pure `Program<PeerMsg, PeerModel, PeerEffect>` (`createPeerProgram`). Every decision — "probe returned `connected`, so emit `start-connector`"; "listener failed, so delay and re-probe" — is data. Tests assert on the effects.

### What leaderless peer negotiation is NOT

- **Not a consensus protocol.** There is no leader election, no quorum. At any instant, exactly one peer is the listener.
- **Not suitable for more than two peers.** The model is pairwise. Multi-peer topologies should use a dedicated sync server.
- **Not the same as the client transport.** `createUnixSocketClient` + `createUnixSocketServer` give fixed roles. `createUnixSocketPeer` adds the probing + fallback dance on top.

### Two programs, not one

`createPeerProgram` and `createUnixSocketClientProgram` are separate for a reason: the peer program's concern is *which role to play* (listener or connector); the client program's concern is *when to reconnect* if I'm a connector. Collapsing them would merge the "probe / become listener" state machine with the "connect / reconnect with backoff" state machine — two independent responsibilities.

The client program is therefore reused by the peer program's `start-connector` effect (running as a child) and directly by applications that already know their role.

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

Identical to the WebSocket transport's binary pipeline, minus the fragmentation layer:

```
Outbound:
  ChannelMsg
    └─ cborCodec.encode ──► Uint8Array
       └─ encodeBinaryFrame(complete(...)) ──► framed bytes
          └─ UnixSocket.write (with backpressure queue)

Inbound:
  onData(chunk)
    └─ feedBytes(parserState, chunk) ──► frames
       └─ decodeBinaryFrame(frame)
          └─ cborCodec.decode(payload) ──► ChannelMsg[]
             └─ onChannelReceive
```

The `WIRE_VERSION`, `HEADER_SIZE`, and binary frame type constants all come from `@kyneta/wire` — no Unix-socket-specific protocol.

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
| `UnixSocketConnection` | `src/connection.ts` | Per-peer pipeline: parser state, CBOR codec, write queue, channel. |
| `UnixSocketPeer` | `src/peer.ts` | Leaderless peer — imperative shell around `createPeerProgram`. |
| `UnixSocketPeerOptions` | `src/peer.ts` | `{ path, reconnect?, retryDelayMs? }`. |
| `createUnixSocketPeer` | `src/peer.ts` | `TransportFactory` for leaderless peers. |
| `createPeerProgram` | `src/peer-program.ts` | Pure `Program<PeerMsg, PeerModel, PeerEffect>`. |
| `PeerModel` / `PeerMsg` / `PeerEffect` / `PeerProgramOptions` | `src/peer-program.ts` | Peer program's types. |
| `ProbeResult` | `src/peer-program.ts` | `"connected" \| "enoent" \| "econnrefused" \| "eaddrinuse"`. |
| `createUnixSocketClientProgram` | `src/client-program.ts` | Pure client `Program`. |
| `UnixSocketClientMsg` / `UnixSocketClientEffect` | `src/client-program.ts` | Client program's messages / effects. |
| `UnixSocketClientState` / `UnixSocketClientStateTransition` | `src/types.ts` | Client state discriminated union. |
| `DisconnectReason` | `src/types.ts` | Discriminated union describing why a connection was lost. |
| `UnixSocket` | `src/types.ts` | Runtime-neutral socket interface. |
| `NodeUnixSocketLike` / `BunUnixSocketLike` / `BunSocketHandlers` | `src/types.ts` | Runtime-specific structural shapes. |
| `wrapNodeUnixSocket` / `wrapBunUnixSocket` | `src/types.ts` | Wrappers to `UnixSocket`. |
| `connect` | `src/connect.ts` | Runtime-detected connect helper. |
| `listen` | `src/listen.ts` | Runtime-detected listen helper. |

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 47 | Public exports. |
| `src/types.ts` | 222 | `UnixSocket`, client state, disconnect reason, runtime wrappers. |
| `src/client-program.ts` | 211 | Pure `createUnixSocketClientProgram` Mealy machine. |
| `src/client-transport.ts` | 341 | Imperative shell: runs client program, owns `UnixSocket`, runs CBOR + stream-frame pipeline. |
| `src/server-transport.ts` | 272 | Server-side `Transport<...>`: listens, accepts, dispatches to `UnixSocketConnection`. |
| `src/connection.ts` | 234 | Per-connection parser state, write queue, channel ownership. |
| `src/peer-program.ts` | 151 | Pure `createPeerProgram` Mealy machine for leaderless negotiation. |
| `src/peer.ts` | 222 | Imperative shell for the peer program: probes, spawns client/server, handles disposal. |
| `src/connect.ts` | 105 | Runtime-detected connect helper. |
| `src/listen.ts` | 128 | Runtime-detected listen helper. |
| `src/__tests__/client-program.test.ts` | 574 | Pure tests: every client state transition and effect asserted on data. |
| `src/__tests__/peer-program.test.ts` | 327 | Pure tests: every peer state transition and effect asserted on data. |
| `src/__tests__/connection.test.ts` | 339 | Stream framing round-trips, backpressure, write queue. |
| `src/__tests__/peer.test.ts` | 132 | Imperative peer tests: probe outcomes drive correct transport spawning. |
| `src/__tests__/unix-socket-transport.test.ts` | 360 | End-to-end tests with real Unix sockets: client reconnects after server restart, full sync round-trips. |
| `src/__tests__/mock-unix-socket.ts` | 130 | A test-only `UnixSocket` with scripted behaviour and backpressure control. |

## Testing

The two pure programs (`createUnixSocketClientProgram`, `createPeerProgram`) are tested by dispatching messages and asserting on the returned `[state, ...effects]` tuples — no sockets, no real timers (`vi.useFakeTimers` where time is relevant). The connection tests use a scripted mock `UnixSocket`. The `unix-socket-transport.test.ts` file runs real Unix-socket servers for end-to-end verification (including reconnect after server restart).

**Tests**: 82 passed, 0 skipped across 5 files (`client-program.test.ts`: 37, `peer-program.test.ts`: 23, `connection.test.ts`: 13, `peer.test.ts`: 3, `unix-socket-transport.test.ts`: 6). Run with `cd packages/exchange/transports/unix-socket && pnpm exec vitest run`.