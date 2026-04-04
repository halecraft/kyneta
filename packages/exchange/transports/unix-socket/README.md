# @kyneta/unix-socket-transport

Stream-oriented Unix domain socket transport for `@kyneta/exchange` — server-to-server communication for co-located services, bypassing the TCP/IP stack. ~3.8× faster than TCP localhost for small messages.

## Overview

- **Stream-oriented** — unlike the WebSocket transport (message-oriented), `write()` returns a boolean backpressure signal and `onDrain` notifies when the kernel buffer is available again.
- **Binary CBOR encoding** with stream framing via `StreamFrameParser` from `@kyneta/wire`. No fragmentation — UDS has no message size limits.
- **No transport prefixes** — stream framing handles message boundaries directly.
- **No "ready" handshake** — UDS connections are bidirectionally ready immediately (unlike WebSocket which needs a text `"ready"` signal). The client calls `establishChannel` directly after connect.
- **Leaderless topology** — `createUnixSocketPeer` handles connect-or-listen negotiation automatically. First peer listens, subsequent peers connect, survivors heal when the listener dies.
- **FC/IS boundary** — `feedBytes` (pure) produces frames from the byte stream; connection handlers (imperative) dispatch decoded messages and manage the write queue.

## Export

| Export | Entry point |
|--------|-------------|
| `@kyneta/unix-socket-transport` | `./dist/index.js` |

Everything is available from the top-level import — server, client, peer negotiation, connection, types, and platform wrappers.

## Install

```/dev/null/install.sh#L1
pnpm add @kyneta/unix-socket-transport
```

## Quick Start

### Leaderless Peer (Recommended)

The simplest way to use the transport — `createUnixSocketPeer` handles role negotiation, transport swaps, and healing automatically:

```/dev/null/peer-example.ts#L1-14
import { Exchange } from "@kyneta/exchange"
import { createUnixSocketPeer } from "@kyneta/unix-socket-transport"

const exchange = new Exchange({
  identity: { peerId: "service-a", name: "Service A" },
})

const peer = createUnixSocketPeer(exchange, {
  path: "/tmp/kyneta.sock",
})

// peer.role is "listener" | "connector" | "negotiating"
// Kill the listener → a connector re-negotiates and takes over
// No code changes needed — healing is automatic
```

### Explicit Server + Client

For cases where you need direct control over server and client roles:

#### Server

```/dev/null/server-example.ts#L1-12
import { Exchange } from "@kyneta/exchange"
import { UnixSocketServerTransport } from "@kyneta/unix-socket-transport"

const serverTransport = new UnixSocketServerTransport({
  path: "/tmp/kyneta.sock",
  cleanup: true,
})

const exchange = new Exchange({
  identity: { peerId: "server", name: "server", type: "service" },
  transports: [() => serverTransport],
})
```

#### Client

```/dev/null/client-example.ts#L1-13
import { Exchange } from "@kyneta/exchange"
import { createUnixSocketClient } from "@kyneta/unix-socket-transport"

const exchange = new Exchange({
  identity: { peerId: "service-a", name: "Service A", type: "service" },
  transports: [
    createUnixSocketClient({ path: "/tmp/kyneta.sock" }),
  ],
})

// Wait for the connection to be established
const client = exchange.getTransport("unix-socket-client")
await client.waitForStatus("connected")
```

## API Reference

### `createUnixSocketPeer(exchange, options)`

Create a leaderless unix socket peer that manages topology negotiation automatically.

The first peer to start becomes the listener; subsequent peers become connectors. If the listener dies, a connector re-negotiates and becomes the new listener. Uses `exchange.addTransport()` / `exchange.removeTransport()` to swap transports at runtime — the Exchange, all documents, and all CRDT state survive across transport swaps.

Returns a `UnixSocketPeer`.

#### `UnixSocketPeerOptions`

| Option | Default | Description |
|--------|---------|-------------|
| `path` | — | Path to the unix socket file. |
| `reconnect.enabled` | `true` | Enable automatic reconnection (for connector role). |
| `reconnect.maxAttempts` | `5` | Maximum reconnection attempts before re-negotiating. |
| `reconnect.baseDelay` | `1000` | Base delay in ms for exponential backoff. |
| `reconnect.maxDelay` | `30000` | Maximum delay cap in ms. |

#### `UnixSocketPeer`

| Member | Type | Description |
|--------|------|-------------|
| `role` | `"listener" \| "connector" \| "negotiating"` | Current role — changes over time as healing occurs. |
| `dispose()` | `() => Promise<void>` | Remove the transport from the Exchange and clean up the socket file. |

#### `decideRole(probe)`

Pure decision function: given a `ProbeResult` (`"connected"` | `"enoent"` | `"econnrefused"` | `"eaddrinuse"`), returns a `NegotiationDecision` (`{ action: "connect" }` | `{ action: "listen" }` | `{ action: "retry" }`).

### `UnixSocketServerOptions`

| Option | Default | Description |
|--------|---------|-------------|
| `path` | — | Path to the unix socket file. |
| `cleanup` | `true` | Remove stale socket file on start. |

### `UnixSocketClientOptions`

| Option | Default | Description |
|--------|---------|-------------|
| `path` | — | Path to the unix socket file. |
| `reconnect.enabled` | `true` | Enable automatic reconnection. |
| `reconnect.maxAttempts` | `10` | Maximum reconnection attempts before giving up. |
| `reconnect.baseDelay` | `1000` | Base delay in ms for exponential backoff. |
| `reconnect.maxDelay` | `30000` | Maximum delay cap in ms. |

### `UnixSocketServerTransport`

| Method | Signature | Description |
|--------|-----------|-------------|
| `getConnection` | `(peerId: string) => UnixSocketConnection \| undefined` | Get an active connection by peer ID. |
| `getAllConnections` | `() => UnixSocketConnection[]` | Get all active connections. |
| `isConnected` | `(peerId: string) => boolean` | Check if a peer is connected. |
| `unregisterConnection` | `(peerId: string) => void` | Remove a connection and its channel. |
| `broadcast` | `(msg: ChannelMsg) => void` | Send a message to all connected peers. |
| `connectionCount` | `number` (getter) | Number of connected peers. |

### `UnixSocketClientTransport`

| Method | Signature | Description |
|--------|-----------|-------------|
| `getState` | `() => UnixSocketClientState` | Get the current connection state. |
| `waitForStatus` | `(status, options?) => Promise<UnixSocketClientState>` | Wait for a specific status. |
| `waitForState` | `(predicate, options?) => Promise<UnixSocketClientState>` | Wait for a state matching a predicate. |
| `subscribeToTransitions` | `(listener) => () => void` | Subscribe to state transitions. Returns unsubscribe function. |
| `isConnected` | `boolean` (getter) | Whether the client is connected. |

### `createUnixSocketClient(options)`

Factory function returning a `TransportFactory`. Pass directly to `Exchange({ transports: [...] })`.

### `UnixSocket`

Framework-agnostic stream-oriented socket interface. Unlike WebSocket's `send()`, `write()` returns `false` when the kernel buffer is full.

```/dev/null/unix-socket-interface.ts#L1-8
interface UnixSocket {
  write(data: Uint8Array): boolean
  end(): void
  onData(handler: (data: Uint8Array) => void): void
  onClose(handler: () => void): void
  onError(handler: (error: Error) => void): void
  onDrain(handler: () => void): void
}
```

### Platform Wrappers

| Wrapper | Input |
|---------|-------|
| `wrapNodeUnixSocket(socket)` | Node.js `net.Socket` |
| `wrapBunUnixSocket(socket)` | Bun unix socket |

`wrapBunUnixSocket` returns `{ unixSocket, handlers }` — the caller wires `handlers` into Bun's callback-based socket structure.

## Connection Lifecycle

The client uses a 4-state machine (no "ready" phase — UDS connections are bidirectionally ready immediately):

```/dev/null/state-machine.txt#L1-7
disconnected → connecting → connected
                   ↓            ↓
              reconnecting ← ─ ─┘
                   ↓
              connecting (retry)
                   ↓
              disconnected (max retries)
```

| State | Description |
|-------|-------------|
| `disconnected` | No active connection. Optional `reason` field describes why. |
| `connecting` | Socket handshake in progress. Tracks `attempt` number. |
| `connected` | Connection open, messages can flow immediately. |
| `reconnecting` | Connection lost, scheduling next attempt. Tracks `attempt` and `nextAttemptMs`. |

### Peer Negotiation Lifecycle

`createUnixSocketPeer` layers on top of the client state machine:

```/dev/null/peer-lifecycle.txt#L1-8
negotiate → probe socket path
             ├── connected     → become connector (add client transport)
             ├── enoent        → become listener  (add server transport)
             ├── econnrefused  → become listener  (add server transport)
             └── eaddrinuse    → retry after delay

connector: client disconnects (max retries) → re-negotiate
listener:  runs until dispose
```

### Observing State

```/dev/null/observe-state.ts#L1-12
import { createUnixSocketClient } from "@kyneta/unix-socket-transport"

const transport = createUnixSocketClient({
  path: "/tmp/kyneta.sock",
  reconnect: { enabled: true },
})

// Subscribe to transitions programmatically
const unsub = transport.subscribeToTransitions(({ from, to }) => {
  console.log(`${from.status} → ${to.status}`)
})
```

## Backpressure

`UnixSocket.write()` returns `false` when the kernel buffer is full. The `UnixSocketConnection` manages a write queue:

1. `send(msg)` encodes via `encodeComplete(cborCodec, msg)` → `socket.write(frameBytes)`.
2. If `write()` returns `false`, the connection enters draining mode — subsequent frames are queued.
3. When the `drain` event fires, queued frames are flushed in order.
4. If any flush write returns `false`, the connection waits for the next `drain`.

## Stale Socket Cleanup

When `cleanup: true` (the default), the server transport removes leftover socket files on start. This prevents `EADDRINUSE` after a crash where the previous process didn't clean up.

On stop, the server always unlinks the socket file.

## Reconnection

The client uses the shared `createReconnectScheduler` from `@kyneta/exchange` — the same exponential backoff with jitter used by the WebSocket and SSE transports.

The `DisconnectReason` discriminated union carries socket-specific context:

| Variant | Fields | Description |
|---------|--------|-------------|
| `intentional` | — | Clean shutdown via `onStop()`. |
| `error` | `error`, `errno?` | Socket error. `errno` carries codes like `ENOENT`, `ECONNREFUSED`, `EADDRINUSE`, `EACCES`. |
| `closed` | — | Server closed the connection. |
| `max-retries-exceeded` | `attempts` | Reconnect limit reached. |

## Design

### Why No Fragmentation?

WebSocket and WebRTC transports use `@kyneta/wire`'s fragmentation layer to stay within infrastructure limits (128KB for AWS API Gateway, ~256KB for SCTP). Unix domain sockets have no such limits — they transfer data as a byte stream. `StreamFrameParser` handles message boundary extraction; `encodeComplete` writes complete frames directly.

### Why No Transport Prefixes?

WebSocket multiplexes text and binary frames and uses a text `"ready"` signal. UDS is a raw byte stream with a single purpose — there's nothing to multiplex and no handshake phase.

### Why No "Ready" Handshake?

WebSocket connections need a server-sent `"ready"` signal after the HTTP upgrade completes. UDS connections are bidirectionally ready the moment `connect` resolves — the client sends `establish-request` immediately.

### Why Leaderless?

Fixed server/client roles require external coordination — someone decides who listens. `createUnixSocketPeer` eliminates this: every peer runs the same code, the first one to arrive listens, and survivors heal when the listener dies. This makes the topology symmetric and self-organizing.

## Peer Dependencies

```/dev/null/package.json#L1-4
{
  "peerDependencies": {
    "@kyneta/exchange": "^1.1.0",
    "@kyneta/wire": "^1.1.0"
  }
}
```

## License

MIT