# @kyneta/sse-network-adapter

SSE (Server-Sent Events) adapter for `@kyneta/exchange` — client, server, and Express integration. Provides real-time sync using SSE for server→client messages and HTTP POST for client→server messages, both encoded with the `@kyneta/wire` text protocol (JSON codec + text framing + text fragmentation).

## Subpath Exports

| Export | Entry point | Environment |
|--------|-------------|-------------|
| `@kyneta/sse-network-adapter/client` | `./dist/client.js` | Browser, Bun, Node.js |
| `@kyneta/sse-network-adapter/server` | `./dist/server.js` | Bun, Node.js |
| `@kyneta/sse-network-adapter/express` | `./dist/express.js` | Node.js (Express) |

## Server Setup

### Express (recommended)

Use `createSseExpressRouter` for zero-boilerplate integration with Express:

```/dev/null/express-server.ts#L1-20
import { Exchange } from "@kyneta/exchange"
import { SseServerAdapter } from "@kyneta/sse-network-adapter/server"
import { createSseExpressRouter } from "@kyneta/sse-network-adapter/express"
import express from "express"

const app = express()

const serverAdapter = new SseServerAdapter()

const exchange = new Exchange({
  identity: { peerId: "server", name: "server", type: "service" },
  adapters: [() => serverAdapter],
})

app.use("/sse", createSseExpressRouter(serverAdapter, {
  syncPath: "/sync",
  eventsPath: "/events",
  heartbeatInterval: 30000,
}))

app.listen(3000)
```

### Hono

For Hono or other frameworks, use `parseTextPostBody` and `SseServerAdapter.registerConnection` directly:

```/dev/null/hono-server.ts#L1-45
import { SseServerAdapter } from "@kyneta/sse-network-adapter/server"
import { parseTextPostBody } from "@kyneta/sse-network-adapter/express"
import { Hono } from "hono"
import { streamSSE } from "hono/streaming"

const sseAdapter = new SseServerAdapter()

const app = new Hono()

app.get("/sse/events", async (c) => {
  const peerId = c.req.query("peerId")
  if (!peerId) return c.json({ error: "peerId required" }, 400)

  return streamSSE(c, async (stream) => {
    const connection = sseAdapter.registerConnection(peerId)

    // sendFn receives pre-encoded text frame strings
    connection.setSendFunction((textFrame) => {
      stream.writeSSE({ data: textFrame })
    })

    stream.onAbort(() => {
      sseAdapter.unregisterConnection(peerId)
    })

    await new Promise(() => {}) // keep alive
  })
})

app.post("/sse/sync", async (c) => {
  const peerId = c.req.header("x-peer-id")
  if (!peerId) return c.json({ error: "x-peer-id required" }, 400)

  const connection = sseAdapter.getConnection(peerId)
  if (!connection) return c.json({ error: "Not connected" }, 404)

  const body = await c.req.text()
  const result = parseTextPostBody(connection.reassembler, body)

  if (result.type === "messages") {
    for (const msg of result.messages) {
      connection.receive(msg)
    }
  }

  return c.json(result.response.body, result.response.status)
})
```

## Client Setup

### Browser

Use `createSseClient` for browser-to-server connections:

```/dev/null/browser-client.ts#L1-13
import { Exchange } from "@kyneta/exchange"
import { createSseClient } from "@kyneta/sse-network-adapter/client"

const exchange = new Exchange({
  identity: { peerId: "browser-client", name: "Alice", type: "user" },
  adapters: [createSseClient({
    postUrl: "/sse/sync",
    eventSourceUrl: (peerId) => `/sse/events?peerId=${peerId}`,
    reconnect: { enabled: true },
  })],
})
```

## Connection Lifecycle

The client adapter manages connection state through a validated state machine. Unlike the WebSocket adapter, SSE has no separate "ready" signal — the connection is usable as soon as `EventSource.onopen` fires.

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
| `connecting` | EventSource being created. Tracks `attempt` number. |
| `connected` | EventSource open — protocol messages can flow. |
| `reconnecting` | Connection lost, scheduling next attempt. Tracks `attempt` and `nextAttemptMs`. |

### Connection Handshake

1. Client creates `EventSource`, transitions to `connecting`
2. `EventSource.onopen` fires, transitions to `connected`
3. Client creates its channel, calls `establishChannel()`
4. Synchronizer exchanges `establish-request` / `establish-response`

### EventSource Reconnection

On `EventSource.onerror`, the adapter **closes the EventSource immediately** and takes over reconnection via the state machine's backoff logic. This prevents the browser's built-in `EventSource` reconnection from running, giving full control over backoff timing and attempt counting.

### Observing State

```/dev/null/observe-state.ts#L1-18
import { createSseClient } from "@kyneta/sse-network-adapter/client"

const adapter = createSseClient({
  postUrl: "/sse/sync",
  eventSourceUrl: (peerId) => `/sse/events?peerId=${peerId}`,
  lifecycle: {
    onStateChange: ({ from, to }) => console.log(`${from.status} → ${to.status}`),
    onDisconnect: (reason) => console.log("disconnected:", reason.type),
    onReconnecting: (attempt, nextMs) => console.log(`retry #${attempt} in ${nextMs}ms`),
    onReconnected: () => console.log("reconnected"),
  },
})

// Or subscribe to transitions programmatically
const unsub = adapter.subscribeToTransitions(({ from, to }) => {
  console.log(`${from.status} → ${to.status}`)
})

await adapter.waitForStatus("connected", { timeoutMs: 5000 })
```

## Wire Format

Both directions use the `@kyneta/wire` text pipeline — symmetric encoding with asymmetric transport:

| Direction | Transport | Wire format |
|-----------|-----------|-------------|
| Client → Server | HTTP POST (`text/plain`) | Text frame (`["0c", <payload>]`) |
| Server → Client | SSE `data:` event | Text frame (`["0c", <payload>]`) |

### Text Frames

Every message is wrapped in a text frame — a JSON array with a 2-character prefix:

```/dev/null/text-frame-example.txt#L1-5
Complete frame:  ["0c", {"type":"discover","docIds":["doc-1"]}]
Fragment frame:  ["0f", "a1b2c3d4", 0, 3, 1500, "{\"type\":\"offer\"..."]
```

The `"0c"` prefix means "version 0, complete, no hash". Fragments use `"0f"` and carry `frameId`, `index`, `total`, `totalSize`, and a JSON substring chunk.

### Why Text Instead of Binary?

The old `@loro-extended/adapter-sse` used an asymmetric format: binary CBOR for POST, ad-hoc JSON for SSE. The new adapter uses uniform text encoding because:

- Single code path for encode/decode on both client and server
- Human-readable POST bodies and SSE events for debugging
- No need for `express.raw()` with `application/octet-stream`
- Text fragmentation works in both directions

The ~33% bandwidth overhead of base64 for binary payloads (vs. native CBOR byte strings) is acceptable for SSE's use case (chat, presence, signaling). For bandwidth-sensitive workloads, use the WebSocket adapter.

## Configuration

### Client Options

| Option | Default | Description |
|--------|---------|-------------|
| `postUrl` | — | POST URL. String or `(peerId) => string` function. |
| `eventSourceUrl` | — | SSE URL. String or `(peerId) => string` function. |
| `reconnect.enabled` | `true` | Enable automatic reconnection. |
| `reconnect.maxAttempts` | `10` | Maximum reconnection attempts. |
| `reconnect.baseDelay` | `1000` | Base delay in ms for exponential backoff. |
| `reconnect.maxDelay` | `30000` | Maximum delay cap in ms. |
| `postRetry.maxAttempts` | `3` | Maximum POST retry attempts. |
| `postRetry.baseDelay` | `1000` | Base delay in ms for POST retry backoff. |
| `postRetry.maxDelay` | `10000` | Maximum POST retry delay in ms. |
| `fragmentThreshold` | `60000` | Character threshold for text fragmentation. |

### Server Options

| Option | Default | Description |
|--------|---------|-------------|
| `fragmentThreshold` | `60000` | Character threshold for text fragmentation. |

### Express Router Options

| Option | Default | Description |
|--------|---------|-------------|
| `syncPath` | `"/sync"` | Path for POST endpoint. |
| `eventsPath` | `"/events"` | Path for SSE endpoint. |
| `heartbeatInterval` | `30000` | Heartbeat interval in ms. |
| `getPeerIdFromSyncRequest` | reads `x-peer-id` header | Custom peerId extraction for POST. |
| `getPeerIdFromEventsRequest` | reads `peerId` query param | Custom peerId extraction for SSE. |

### Heartbeat

The Express router sends SSE comment heartbeats (`: heartbeat\n\n`) at the configured interval. SSE comments are silently ignored by `EventSource` clients. This keeps connections alive through proxies and load balancers that terminate idle connections.

## Custom Framework Integration

The `parseTextPostBody` function provides a framework-agnostic handler for POST requests:

```/dev/null/custom-framework.ts#L1-13
import { parseTextPostBody } from "@kyneta/sse-network-adapter/express"

// In your framework's request handler
const result = parseTextPostBody(connection.reassembler, bodyAsString)

if (result.type === "messages") {
  for (const msg of result.messages) {
    connection.receive(msg)
  }
}

// Send response
response.status(result.response.status).json(result.response.body)
```

### Response Types

| Result Type | HTTP Status | Meaning |
|-------------|-------------|---------|
| `messages` | 200 | Message(s) decoded successfully |
| `pending` | 202 | Fragment received, waiting for more |
| `error` | 400 | Decode or reassembly error |

### The `sendFn` Pattern

`SseConnection.send()` handles encoding and fragmentation internally. The injected `sendFn` receives pre-encoded text frame strings — the framework integration just wraps them in transport syntax:

```/dev/null/sendfn-pattern.ts#L1-8
// Express
connection.setSendFunction((textFrame) => {
  res.write(`data: ${textFrame}\n\n`)
})

// Hono
connection.setSendFunction((textFrame) => {
  stream.writeSSE({ data: textFrame })
})
```

## Architecture

```/dev/null/architecture.txt#L1-17
┌──────────────────────────────────────────────────────────┐
│                        Client                            │
│  ┌──────────────────┐        ┌───────────────────┐       │
│  │ SseClientAdapter │        │ EventSource       │       │
│  │ (text POST)      │───────▶│ (text receive)    │       │
│  └──────────────────┘        └───────────────────┘       │
└──────────────────────────────────────────────────────────┘
         │                             ▲
         │ HTTP POST                   │ SSE
         │ (text wire frame)           │ (text wire frame)
         ▼                             │
┌──────────────────────────────────────────────────────────┐
│                        Server                            │
│  ┌──────────────────┐        ┌───────────────────┐       │
│  │ Express Router   │        │ SSE Writer        │       │
│  │ (parseTextPost)  │───────▶│ (sendFn)          │       │
│  └──────────────────┘        └───────────────────┘       │
│           │                             ▲                │
│           ▼                             │                │
│  ┌───────────────────────────────────────────────────┐   │
│  │          SseServerAdapter                         │   │
│  │  ┌────────────────────────────────────────────┐   │   │
│  │  │ SseConnection (per peer)                   │   │   │
│  │  │ - TextReassembler (handles fragmented POST)│   │   │
│  │  │ - textCodec encoding (handles outbound SSE)│   │   │
│  │  │ - Channel reference                        │   │   │
│  │  └────────────────────────────────────────────┘   │   │
│  └───────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────┘
```

## Peer Dependencies

```/dev/null/package.json#L1-4
{
  "peerDependencies": {
    "@kyneta/exchange": ">=0.0.1",
    "@kyneta/wire": ">=0.0.1"
  }
}
```

Express is an optional peer dependency — only needed if using `@kyneta/sse-network-adapter/express`.

## License

MIT