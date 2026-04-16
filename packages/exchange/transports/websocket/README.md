# @kyneta/websocket-transport

Websocket transport for `@kyneta/exchange` — browser, server, and Bun integration. Provides bidirectional real-time sync over Websockets using the `@kyneta/wire` binary protocol (CBOR codec + framing + fragmentation).

## Subpath Exports

| Export | Entry point | Environment |
|--------|-------------|-------------|
| `@kyneta/websocket-transport/browser` | `./dist/browser.js` | Browser, Bun, Node.js |
| `@kyneta/websocket-transport/server` | `./dist/server.js` | Bun, Node.js |
| `@kyneta/websocket-transport/bun` | `./dist/bun.js` | Bun only |

## Server Setup

### Bun (recommended)

Use `createBunWebsocketHandlers` for zero-boilerplate integration with `Bun.serve()`:

```/dev/null/bun-server.ts#L1-18
import { Exchange } from "@kyneta/exchange"
import { WebsocketServerAdapter } from "@kyneta/websocket-transport/server"
import { createBunWebsocketHandlers, type BunWebsocketData } from "@kyneta/websocket-transport/bun"

const serverAdapter = new WebsocketServerAdapter()

const exchange = new Exchange({
  identity: { peerId: "server", name: "server", type: "service" },
  adapters: [serverAdapter],
})

Bun.serve<BunWebsocketData>({
  fetch(req, server) {
    server.upgrade(req)
    return new Response("upgrade failed", { status: 400 })
  },
  websocket: createBunWebsocketHandlers(serverAdapter),
})
```

For more control, use `wrapBunWebsocket` directly:

```/dev/null/bun-server-manual.ts#L1-17
import { wrapBunWebsocket, type BunWebsocketData } from "@kyneta/websocket-transport/bun"

Bun.serve<BunWebsocketData>({
  fetch(req, server) {
    server.upgrade(req)
    return new Response("upgrade failed", { status: 400 })
  },
  websocket: {
    open(ws) {
      const socket = wrapBunWebsocket(ws)
      serverAdapter.handleConnection({ socket }).start()
    },
    message(ws, msg) {
      const data = msg instanceof ArrayBuffer ? new Uint8Array(msg) : msg
      ws.data?.handlers?.onMessage?.(data)
    },
    close(ws, code, reason) {
      ws.data?.handlers?.onClose?.(code, reason)
    },
  },
})
```

### Node.js (`ws` library)

Use `wrapNodeWebsocket` to adapt the `ws` library's `WebSocket` to the framework-agnostic `Socket` interface:

```/dev/null/node-server.ts#L1-16
import { WebSocketServer } from "ws"
import { WebsocketServerAdapter, wrapNodeWebsocket } from "@kyneta/websocket-transport/server"

const serverAdapter = new WebsocketServerAdapter()

const exchange = new Exchange({
  identity: { peerId: "server", name: "server", type: "service" },
  adapters: [serverAdapter],
})

const wss = new WebSocketServer({ port: 3000 })

wss.on("connection", (ws) => {
  const { start } = serverAdapter.handleConnection({ socket: wrapNodeWebsocket(ws) })
  start()
})
```

## Client Setup

### Browser

Use `createWebsocketClient` for browser-to-server connections:

```/dev/null/browser-client.ts#L1-13
import { Exchange } from "@kyneta/exchange"
import { createWebsocketClient } from "@kyneta/websocket-transport/browser"

const adapter = createWebsocketClient({
  url: "ws://localhost:3000/ws",
  WebSocket,
  reconnect: { enabled: true },
})

const exchange = new Exchange({
  identity: { peerId: "browser-client", name: "Alice", type: "user" },
  adapters: [adapter],
})
```

### Service-to-Service

Use `createServiceWebsocketClient` for backend connections that need authentication headers during the Websocket upgrade. Headers are a Bun/Node-specific extension — the browser `WebSocket` API does not support custom headers.

```/dev/null/service-client.ts#L1-13
import { createServiceWebsocketClient } from "@kyneta/websocket-transport/server"

const adapter = createServiceWebsocketClient({
  url: "ws://primary-server:3000/ws",
  headers: {
    Authorization: "Bearer <token>",
  },
  reconnect: { enabled: true },
})

const exchange = new Exchange({
  identity: { peerId: "worker-1", name: "worker-1", type: "service" },
  adapters: [adapter],
})
```

> For browser clients, authenticate via URL query parameters instead of headers.

## Connection Lifecycle

The connection lifecycle is a `Program<WsClientMsg, WebsocketClientState, WsClientEffect>` from `@kyneta/machine` — a pure Mealy machine with data effects. The transport class (`WebsocketClientTransport`) is a thin imperative shell that interprets data effects as I/O (FC/IS design). Every state × event combination is covered by pure data tests — no sockets, no timing, never flaky.

The WebSocket client has a **5-state lifecycle** with an extra `ready` state compared to SSE and Unix Socket transports. The server sends a text `"ready"` signal after the TCP connection opens, and only then does the client create a channel and begin the establishment handshake.

```/dev/null/state-machine.txt#L1-8
disconnected → connecting → connected → ready
                   ↓            ↓         ↓
              reconnecting ← ─ ┴ ─ ─ ─ ─ ┘
                   ↓
              connecting (retry)
                   ↓
              disconnected (max retries)
```

| State | Description |
|-------|-------------|
| `disconnected` | No active connection. Optional `reason` field describes why. |
| `connecting` | Websocket handshake in progress. Tracks `attempt` number. |
| `connected` | TCP connection open, waiting for server "ready" signal. |
| `ready` | Server sent `"ready"` text frame — protocol messages can flow. |
| `reconnecting` | Connection lost, scheduling next attempt. Tracks `attempt` and `nextAttemptMs`. |

### Program Architecture

The program (`createWsClientProgram`) encodes all transitions and side effects as inspectable data:

- **Messages** (`WsClientMsg`): `start`, `socket-opened`, `server-ready`, `socket-closed`, `socket-error`, `reconnect-timer-fired`, `stop`
- **Effects** (`WsClientEffect`): `create-websocket`, `close-websocket`, `add-channel-and-establish`, `remove-channel`, `start-reconnect-timer`, `cancel-reconnect-timer`, `start-keepalive`, `stop-keepalive`

The imperative shell interprets each effect as real I/O — creating `WebSocket` instances, scheduling timers, sending keepalive pings. Keepalive is modeled as `start-keepalive` / `stop-keepalive` effects rather than internal timer logic.

### Race Condition Handling

The server may send `"ready"` before the client's `open` event fires (server-ready while still `connecting`). The program handles this by transitioning directly from `connecting` → `ready`, skipping the `connected` state entirely.

### Connection Handshake

1. Client opens Websocket, transitions to `connecting`
2. Websocket `open` event fires, transitions to `connected`
3. Server sends text `"ready"` frame, client transitions to `ready`
4. Client creates its channel, calls `establishChannel()`
5. Synchronizer exchanges `establish-request` / `establish-response`

### Observing State

The public observation API is powered by `createObservableProgram` from `@kyneta/machine`:

```/dev/null/observe-state.ts#L1-18
import { createWebsocketClient } from "@kyneta/websocket-transport/browser"

const adapter = createWebsocketClient({
  url: "ws://localhost:3000/ws",
  lifecycle: {
    onStateChange: ({ from, to }) => console.log(`${from.status} → ${to.status}`),
    onDisconnect: (reason) => console.log("disconnected:", reason.type),
    onReconnecting: (attempt, nextMs) => console.log(`retry #${attempt} in ${nextMs}ms`),
    onReconnected: () => console.log("reconnected"),
    onReady: () => console.log("ready"),
  },
})

// Or subscribe to transitions programmatically
const unsub = adapter.subscribeToTransitions(({ from, to }) => {
  console.log(`${from.status} → ${to.status}`)
})

await adapter.waitForStatus("ready", { timeoutMs: 5000 })
```

## The Socket Interface

`Socket` is the framework-agnostic abstraction that decouples the adapter from any specific Websocket library. Platform-specific wrappers adapt concrete implementations to this interface:

| Wrapper | Input | Export |
|---------|-------|--------|
| `wrapStandardWebsocket(ws)` | Browser `WebSocket` | `./server` |
| `wrapNodeWebsocket(ws)` | Node.js `ws` library | `./server` |
| `wrapBunWebsocket(ws)` | Bun `ServerWebSocket` | `./bun` |

```/dev/null/socket-interface.ts#L1-8
interface Socket {
  send(data: Uint8Array | string): void
  close(code?: number, reason?: string): void
  onMessage(handler: (data: Uint8Array | string) => void): void
  onClose(handler: (code: number, reason: string) => void): void
  onError(handler: (error: Error) => void): void
  readonly readyState: "connecting" | "open" | "closing" | "closed"
}
```

## Configuration

### Client Options

| Option | Default | Description |
|--------|---------|-------------|
| `url` | — | Websocket URL. String or `(peerId) => string` function. |
| `WebSocket` | — | WebSocket constructor (**required**). In browsers, pass `WebSocket`. In Node.js, pass `ws`'s `WebSocket`. |
| `reconnect.enabled` | `true` | Enable automatic reconnection. |
| `reconnect.maxAttempts` | `10` | Maximum reconnection attempts before giving up. |
| `reconnect.baseDelay` | `1000` | Base delay in ms for exponential backoff. |
| `reconnect.maxDelay` | `30000` | Maximum delay cap in ms. |
| `keepaliveInterval` | `30000` | Interval in ms for keepalive ping frames. |
| `fragmentThreshold` | `102400` | Payload size threshold for fragmentation (bytes). |
| `headers` | — | Upgrade headers (`ServiceWebsocketClientOptions` only). |

### Server Options

| Option | Default | Description |
|--------|---------|-------------|
| `fragmentThreshold` | `102400` | Payload size threshold for fragmentation (bytes). |

### Fragment Thresholds by Environment

| Environment | Recommended threshold | Reason |
|-------------|----------------------|--------|
| AWS API Gateway | `100KB` (default) | 128KB frame limit |
| Cloudflare | `500KB` | 1MB frame limit |
| Self-hosted | `0` (disabled) | No infrastructure limits |

### Keepalive

The client sends text `"ping"` frames at the configured interval. The server responds with text `"pong"`. This keeps connections alive through proxies and load balancers that terminate idle connections.

## Runtime Agnosticism

Every entry point (`./browser`, `./server`, `./bun`) is safe to import in any JavaScript runtime — no top-level side effects, no `globalThis` probes. The transport package has zero runtime dependencies; callers provide all implementations:

| Entry Point | Purpose | Caller Provides |
|-------------|---------|----------------|
| `./browser` | Browser-to-server connections | `WebSocket` constructor (the global `WebSocket` in browsers) |
| `./server` | Server transport + service-to-service client | `Socket` wrapper via `wrapNodeWebsocket()` or `wrapStandardWebsocket()` |
| `./bun` | Bun-optimized server handlers | `ServerWebSocket` from Bun's callback API |

This follows the same structural-typing principle used throughout: `wrapNodeWebsocket` takes a `NodeWebsocketLike` — it never imports `ws`. `wrapBunWebsocket` takes a Bun `ServerWebSocket` — it never imports Bun APIs at the top level.

## Peer Dependencies

```/dev/null/package.json#L1-4
{
  "peerDependencies": {
    "@kyneta/exchange": ">=0.0.1",
    "@kyneta/wire": ">=0.0.1"
  }
}
```

## License

MIT