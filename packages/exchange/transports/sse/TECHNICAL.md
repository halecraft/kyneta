# @kyneta/sse-transport — Technical Reference

> **Package**: `@kyneta/sse-transport`
> **Role**: Server-Sent Events transport for `@kyneta/exchange` — asymmetric transport (SSE downstream, HTTP POST upstream) with a symmetric text wire format. Framework-agnostic server core plus a ready-made Express router.
> **Depends on**: `@kyneta/machine`, `@kyneta/transport`, `@kyneta/wire` (all peer)
> **Depended on by**: `@kyneta/exchange` (through application configuration)
> **Canonical symbols**: `createSseClient`, `SseClientTransport`, `SseClientOptions`, `SseServerTransport`, `SseServerTransportOptions`, `SseConnection`, `SseConnectionConfig`, `createSseClientProgram`, `SseClientMsg`, `SseClientEffect`, `SseClientState`, `parseTextPostBody`, `SsePostResult`, `SsePostResponse`, `createSseExpressRouter`, `SseExpressRouterOptions`, `DEFAULT_FRAGMENT_THRESHOLD`
> **Key invariant(s)**: The wire is asymmetric but the encoding is symmetric — both directions use `@kyneta/wire`'s alias-aware text pipeline (`applyOutboundAliasing → encodeTextWireMessage → text frame`). SSE carries server→client bytes via `EventSource`'s `data:` field; client→server bytes are POSTed to a paired endpoint. The server never `send`s out-of-band; clients never receive via POST.

An SSE transport kit with three entry points — `./client` (browser `EventSource` + `fetch` POST), `./server` (framework-agnostic server core), and `./express` (ready-made Express router + re-exports of the server core). All three share one wire format (alias-aware text pipeline via `@kyneta/wire`) and one client state machine (`createSseClientProgram`).

Imported by applications via the `transports: [...]` array on `new Exchange(...)`. Application code calls `createSseClient({ url, postUrl })` for clients, or mounts `createSseExpressRouter({ transport })` into an Express app for servers.

---

## Questions this document answers

- Why no `"ready"` gate like the WebSocket transport has? → [Why no ready gate](#why-no-ready-gate)
- What is the `sendFn` pattern and why does the server not just own a socket? → [The `sendFn` pattern](#the-sendfn-pattern)
- Why two HTTP endpoints? Can I collapse them into one? → [Two endpoints, one transport](#two-endpoints-one-transport)
- How do I mount this under Express? Hono? Bun? A raw `http.Server`? → [Framework integrations](#framework-integrations)
- How does the client state machine behave during reconnect? → [Client state machine](#client-state-machine)
- What happens to an in-flight POST when the SSE stream drops? → [POST lifecycle and abortion](#post-lifecycle-and-abortion)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| SSE | Server-Sent Events — the `text/event-stream` protocol consumed by `EventSource` in browsers. | WebSockets, long polling, HTTP/2 server push |
| `SseClientTransport` | The client-side `Transport<...>` subclass. Owns one `EventSource` (downstream) and issues `fetch` POSTs (upstream). | `SseServerTransport` |
| `SseServerTransport` | The server-side `Transport<...>` subclass. Accepts registrations via `registerConnection(peerId, sendFn)` and dispatches POST bodies via `deliverPostBody(peerId, body)`. | `SseConnection`, which is one accepted connection on the server |
| `SseConnection` | One accepted peer on the server side. Owns the per-connection `TextReassembler` and channel. | `SseClientTransport` |
| `sendFn` | `(textFrame: string) => void` — a pre-encoded wire-frame sender the framework integration hands to `registerConnection`. The transport never holds an Express `res` or a Bun stream directly. | `socket.send` — this is one level of abstraction higher |
| `createSseClientProgram` | Factory returning a pure `Program<SseClientMsg, SseClientState, SseClientEffect>`. | `SseClientTransport`, which is the imperative shell that *runs* the program |
| `SseClientEffect` | Inspectable data describing an I/O action (`create-event-source`, `close-event-source`, `start-reconnect-timer`, `abort-pending-posts`, etc.). | An `Effect<Msg>` closure — these effects are data |
| `parseTextPostBody` | Pure function that runs an incoming POST body through a connection's `TextReassembler` and returns a discriminated `SsePostResult`. | A framework handler — the caller still has to write the response |
| `SsePostResult` | `{ type: "messages", ... } \| { type: "pending", ... } \| { type: "error", ... }` — tells the framework adapter what to do. | An HTTP response object |
| `SsePostResponse` | `{ status: 200 \| 202 \| 400, body: ... }` — the data the framework should respond with. | The actual HTTP response — still the framework's job to send |
| `TextReassembler` | Per-connection text-fragment reassembler from `@kyneta/wire`. | A protocol-level parser — it only reassembles fragments of one payload |
| `DEFAULT_FRAGMENT_THRESHOLD` | Character threshold (`60_000`) above which an outbound payload is fragmented. | A WebSocket-layer fragmentation boundary — this is application-level |

---

## Architecture

**Thesis**: SSE is already asymmetric; embrace that rather than paper over it. Use the browser's `EventSource` for server→client, plain `fetch` POSTs for client→server, and let the codec handle both directions identically.

Two HTTP endpoints per connection (exact URLs are application choices; defaults below):

| Direction | Endpoint | Method | Framing |
|-----------|----------|--------|---------|
| Server → client | `/sse` (`url`) | `GET` with `Accept: text/event-stream` | `data: <text frame>\n\n` per SSE spec |
| Client → server | `/sse/post` (`postUrl`) | `POST`, `Content-Type: text/plain` | Body is a single text frame string |

The text frame format is the same in both directions: a JSON array or object with a `"0c"`/`"0f"` prefix (see `@kyneta/wire` → `encodeTextFrame` / `decodeTextFrame`). Binary `SubstratePayload` bytes ride through base64-encoded by the text pipeline.

### What this transport is NOT

- **Not an HTTP server.** The application owns Express, Hono, Bun, or raw `http`. The transport registers per-connection sends via `registerConnection(peerId, sendFn)` and receives POST bodies via `deliverPostBody(peerId, body)`.
- **Not bidirectional over one stream.** SSE is strictly server→client. The client cannot push on the `EventSource` — it must POST. Collapsing into a single endpoint would lose server pushability or lose synchronous request/response on the POST side.
- **Not re-stateful across reconnects.** `EventSource`'s built-in reconnection is disabled conceptually; `createSseClientProgram` owns the reconnect state machine with backoff and jitter.

---

## Why no ready gate

The WebSocket transport has a five-state client lifecycle because the server's `open` handler can race ahead of its `onMessage` wiring. That race cannot happen here.

When the client creates an `EventSource`, the server's framework integration (Express route, Hono handler, etc.) runs synchronously: it constructs an `SseConnection`, calls `registerConnection(peerId, sendFn)` on the transport, and writes the response headers. Only *then* does the `EventSource` `open` event fire on the client. By that point the server side is fully wired.

The client program therefore has four states, not five (source: `packages/exchange/transports/sse/src/client-program.ts` → `SseClientState`):

| State | Meaning |
|-------|---------|
| `disconnected` | Initial or terminal |
| `connecting` | `EventSource` created, waiting for `open` |
| `connected` | `EventSource` open, channel created, sending/receiving |
| `reconnecting` | Backoff timer running |

---

## The `sendFn` pattern

The server transport never holds an Express `res`, a Hono stream writer, or a Bun response controller. Instead, the framework integration hands the transport a **send function**:

```
type SendFn = (textFrame: string) => void
```

The framework wraps the text frame in whatever SSE syntax its runtime requires:

| Runtime | `sendFn` body |
|---------|---------------|
| Express | `(text) => res.write(`data: ${text}\n\n`)` |
| Hono | `(text) => stream.writeSSE({ data: text })` |
| Bun / raw `http` | `(text) => controller.enqueue(encoder.encode(`data: ${text}\n\n`))` |
| Test | `(text) => recorded.push(text)` |

Source: `packages/exchange/transports/sse/src/connection.ts` → `SseConnection.#sendFn`. The transport aliases and encodes outbound messages through `@kyneta/wire`'s alias-aware text pipeline, then calls `sendFn` with the pre-encoded text frame (or fragmented variant for large payloads), staying ignorant of the response object.

### What `sendFn` is NOT

- **Not a socket send.** It is invoked once per outbound *text frame* — already encoded, already fragmented if necessary. The framework does not chunk further.
- **Not optional.** Every `SseConnection` must have a `sendFn` registered before any message can be delivered to it; outbound sends before `registerConnection` completes are programmer errors.
- **Not required to be synchronous.** The framework may buffer or backpressure. The transport does not await.

---

## Two endpoints, one transport

The client needs both `url` (GET target for `EventSource`) and `postUrl` (POST target for upstream messages). Source: `packages/exchange/transports/sse/src/client-transport.ts` → `SseClientOptions`.

On the server, the framework integration mounts two routes:

| Route | Handler responsibility |
|-------|------------------------|
| `GET /sse` | Open the SSE stream, call `transport.registerConnection(peerId, sendFn)`, keep the connection alive until client disconnects |
| `POST /sse/post` | Read the body, call `parseTextPostBody(connection.reassembler, body)`, dispatch `messages` to the transport via `deliverPostBody`, return the result's `response` |

`parseTextPostBody` (source: `packages/exchange/transports/sse/src/sse-handler.ts`) is the functional core: it runs the body through the reassembler, decodes on completion, and returns an `SsePostResult` discriminated union telling the framework adapter what to do. The framework adapter is the imperative shell: it acts on the result (dispatch into transport, send HTTP response).

### What `parseTextPostBody` is NOT

- **Not an HTTP handler.** It never calls `res.send()` or returns a `Response`. It returns data; the framework sends the HTTP response.
- **Not a decoder.** It delegates to the `TextReassembler` and the text pipeline (`decodeTextWireMessage`); it only orchestrates them and maps outcomes to the `SsePostResult` variants.
- **Not stateful across calls.** State lives on the connection's `TextReassembler`. The function itself is a pure mapping.

---

## Client state machine

Source: `packages/exchange/transports/sse/src/client-program.ts`. The state machine is `Program<SseClientMsg, SseClientState, SseClientEffect>` — purely data. Interpretation happens in `SseClientTransport` via `createObservableProgram` from `@kyneta/machine`.

| State (`status`) | How it got here | Can transition to |
|------------------|-----------------|-------------------|
| `disconnected` | Initial / terminal; carries optional `DisconnectReason` | `connecting` (on `start`) |
| `connecting` | `create-event-source` effect issued | `connected` (on `event-source-opened`), `reconnecting` (on `event-source-error`) |
| `connected` | `EventSource` open, `add-channel-and-establish` effect issued | `reconnecting` (on error), `disconnected` (on `stop`) |
| `reconnecting` | Waiting for backoff timer | `connecting` (on timer fire), `disconnected` (on max retries or explicit stop) |

Messages (`SseClientMsg`): `start`, `event-source-opened`, `event-source-error`, `stop`, `reconnect-timer-fired`.

Effects (`SseClientEffect`): `create-event-source`, `close-event-source`, `add-channel-and-establish`, `remove-channel`, `start-reconnect-timer`, `cancel-reconnect-timer`, `abort-pending-posts`.

Backoff uses `computeBackoffDelay(attempt, baseDelay, maxDelay, jitter)` from `@kyneta/transport`. Jitter is injected via `jitterFn` (default `() => Math.random() * 1000`) so tests can pin it.

### POST lifecycle and abortion

Upstream POSTs are issued by the imperative shell with `fetch`. When the SSE stream drops (transition to `reconnecting` or `disconnected`), the program emits `abort-pending-posts`. The shell holds the set of `AbortController`s for in-flight POSTs and aborts all of them. This prevents reply messages from being routed to a stale connection after reconnect.

### What `createSseClientProgram` is NOT

- **Not an EventEmitter.** It is a pure `Program`. State is observed via `ObservableHandle.subscribeToTransitions`.
- **Not aware of `EventSource`.** The program emits `create-event-source` / `close-event-source` effects; the shell owns the actual `EventSource` instance.
- **Not responsible for POST I/O.** The shell owns the POST queue and the `AbortController` set; the program only emits `abort-pending-posts` when needed.

---

## Framework integrations

### Browser client

```
import { createSseClient } from "@kyneta/sse-transport/client"

const exchange = new Exchange({
  transports: [createSseClient({
    url: "https://example.com/sse",
    postUrl: "https://example.com/sse/post",
  })],
})
```

### Express server

```
import express from "express"
import { createSseExpressRouter, SseServerTransport } from "@kyneta/sse-transport/express"

const transport = new SseServerTransport()
const app = express()
app.use("/sse", createSseExpressRouter({ transport }))
```

Source: `packages/exchange/transports/sse/src/express-router.ts`. The router mounts both routes internally and handles peer-ID negotiation via query string or cookie (application's choice — the router accepts a `peerIdFromRequest` option).

### Framework-agnostic server

For Hono, Bun, or raw `http.Server`, use `./server` directly:

```
import { SseServerTransport, SseConnection, DEFAULT_FRAGMENT_THRESHOLD } from "@kyneta/sse-transport/server"
import { parseTextPostBody } from "@kyneta/sse-transport/express"  // also exported here

const transport = new SseServerTransport()

// On GET /sse:
const connection = new SseConnection(peerId, channelId)
transport.registerConnection(peerId, textFrame => {
  // Framework-specific SSE write — e.g. stream.writeSSE({ data: textFrame })
})

// On POST /sse/post:
const result = parseTextPostBody(connection.reassembler, body)
if (result.type === "messages") {
  for (const msg of result.messages) transport.deliverPostBody(peerId, msg)
}
// Respond with result.response.status / result.response.body.
```

---

## Key Types

| Type | File | Role |
|------|------|------|
| `SseClientTransport` | `src/client-transport.ts` | The client `Transport<...>` subclass. Runs the client program via `createObservableProgram`. |
| `SseClientOptions` | `src/client-transport.ts` | `{ url, postUrl, reconnect?, fragmentThreshold?, ... }`. |
| `SseClientLifecycleEvents` | `src/client-transport.ts` | Observable lifecycle event shape. |
| `createSseClient` | `src/client-transport.ts` | `TransportFactory` for browser clients. |
| `SseServerTransport` | `src/server-transport.ts` | Server `Transport<...>` subclass. Owns many `SseConnection`s. |
| `SseServerTransportOptions` | `src/server-transport.ts` | Server construction options. |
| `SseConnection` | `src/connection.ts` | Per-peer server-side connection. Owns `TextReassembler` + channel. |
| `SseConnectionConfig` | `src/connection.ts` | Per-connection options (fragment threshold). |
| `createSseClientProgram` | `src/client-program.ts` | Factory for the pure client `Program`. |
| `SseClientMsg` / `SseClientEffect` / `SseClientProgramOptions` | `src/client-program.ts` | Program's messages, effects, options. |
| `SseClientState` / `SseClientStateTransition` | `src/types.ts` | Client state discriminated union + transition alias. |
| `DisconnectReason` | `src/types.ts` | Discriminated union describing why a connection ended. |
| `parseTextPostBody` | `src/sse-handler.ts` | Pure body-parsing function; returns `SsePostResult`. |
| `SsePostResult` / `SsePostResponse` | `src/sse-handler.ts` | Discriminated result + response-data shapes. |
| `createSseExpressRouter` | `src/express-router.ts` | Express `Router` factory for both endpoints. |
| `SseExpressRouterOptions` | `src/express-router.ts` | Express integration options (peer-ID resolution, etc.). |
| `DEFAULT_FRAGMENT_THRESHOLD` | `src/client-transport.ts` / `src/connection.ts` | Character threshold (`60_000`) for text fragmentation. |

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/client.ts` | 36 | `./client` entry — client factory + client types + re-exported machine types. |
| `src/server.ts` | 33 | `./server` entry — server transport + connection + shared types. |
| `src/express.ts` | 29 | `./express` entry — Express router factory + re-exported server + handler primitives. |
| `src/types.ts` | 102 | `SseClientState`, `DisconnectReason`, connection handles. |
| `src/client-program.ts` | 207 | Pure `createSseClientProgram` Mealy machine. |
| `src/client-transport.ts` | 653 | Imperative shell: runs the program, owns `EventSource` + POST queue + `AbortController`s. |
| `src/server-transport.ts` | 225 | Server-side `Transport<...>`: `registerConnection`, `deliverPostBody`, dispatch to `SseConnection`. |
| `src/connection.ts` | 181 | Per-connection text pipeline + `TextReassembler` + channel ownership. |
| `src/sse-handler.ts` | 116 | Pure `parseTextPostBody` + result types — the functional core. |
| `src/express-router.ts` | 231 | Express `Router` factory mounting both endpoints with peer-ID negotiation. |
| `src/__tests__/client-program.test.ts` | 513 | Pure tests: every state transition and effect asserted on data. No `EventSource`. |
| `src/__tests__/connection.test.ts` | 190 | `SseConnection` encoding / fragmentation / reassembly tests. |
| `src/__tests__/sse-handler.test.ts` | 148 | `parseTextPostBody` — every `SsePostResult` variant. |

## Testing

`createSseClientProgram` is a pure `Program`, so `client-program.test.ts` dispatches messages and asserts on the returned `[state, ...effects]` tuple. No real `EventSource`, no real network, no real timers (`vi.useFakeTimers` where time is relevant). `connection.test.ts` verifies encoding, fragmentation, and reassembly through a recorded `sendFn`. `sse-handler.test.ts` exercises every branch of `parseTextPostBody`.

**Tests**: 44 passed, 0 skipped across 3 files (`client-program.test.ts`: 30, `connection.test.ts`: 9, `sse-handler.test.ts`: 5). Run with `cd packages/exchange/transports/sse && pnpm exec vitest run`.