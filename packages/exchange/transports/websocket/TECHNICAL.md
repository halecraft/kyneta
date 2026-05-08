# @kyneta/websocket-transport — Technical Reference

> **Package**: `@kyneta/websocket-transport`
> **Role**: WebSocket transport for `@kyneta/exchange` — browser client, server, Bun integration, and service-to-service client. Binary CBOR on the wire, a pure Mealy-machine client lifecycle, and a server-sent `"ready"` gate that makes the handshake race-free.
> **Depends on**: `@kyneta/machine`, `@kyneta/transport`, `@kyneta/wire` (all peer)
> **Depended on by**: `@kyneta/exchange` (through application configuration), `tests/integration`
> **Canonical symbols**: `createWebsocketClient`, `WebsocketClientTransport`, `WebsocketClientOptions`, `WebsocketServerTransport`, `WebsocketServerTransportOptions`, `WebsocketConnection`, `WebsocketConnectionConfig`, `createServiceWebsocketClient`, `createWsClientProgram`, `WsClientMsg`, `WsClientEffect`, `WebsocketClientState`, `Socket`, `WebSocketLike`, `WebSocketConstructor`, `wrapStandardWebsocket`, `wrapNodeWebsocket`, `wrapBunWebsocket`, `BunWebsocketData`, `READY_STATE`, `DEFAULT_FRAGMENT_THRESHOLD`
> **Key invariant(s)**: The client creates its exchange channel only after the *server* has sent a text `"ready"` signal — never on `socket.onopen` alone. This is why the client lifecycle has five states (`disconnected → connecting → connected → ready → reconnecting`) rather than four.

A WebSocket transport kit with three entry points — `./browser` (browser-to-server), `./server` (server accept + service-to-service), and `./bun` (Bun-specific wrapper). All three share one wire format (CBOR via `@kyneta/wire`) and one client state machine (`createWsClientProgram`).

Imported by applications via the `transports: [...]` array on `new Exchange(...)`. Application code calls `createWebsocketClient({ url, WebSocket })` or `new WebsocketServerTransport()` and hands the result to the exchange.

---

## Questions this document answers

- Why do I pass a `WebSocket` constructor in `createWebsocketClient` instead of the transport using `globalThis.WebSocket`? → [Runtime-agnostic constructor injection](#runtime-agnostic-constructor-injection)
- What is the server `"ready"` signal and why can't I skip it? → [The ready gate](#the-ready-gate)
- How do I mount this under Bun? Under Node + `ws`? Under a browser? → [Three entry points, one wire](#three-entry-points-one-wire)
- How do I pass auth headers? → [Service-to-service client](#service-to-service-client)
- What is `Socket` vs `WebSocketLike` — why two interfaces? → [`Socket` vs `WebSocketLike`](#socket-vs-websocketlike)
- How does the client state machine behave during reconnect? → [Client state machine](#client-state-machine)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| `WebsocketClientTransport` | The client-side `Transport<...>` subclass. Owns one socket, one channel, and the `createObservableProgram` runtime for its client program. | `WebsocketServerTransport`, which manages many sockets |
| `WebsocketServerTransport` | The server-side `Transport<...>` subclass. One instance per server; accepts many client connections. | `WebsocketConnection`, which is one accepted connection on the server |
| `WebsocketConnection` | One accepted peer connection on the server side. Owns the per-connection CBOR pipeline, fragment reassembler, and channel. | `WebsocketClientTransport` |
| `createWsClientProgram` | Factory returning a pure `Program<WsClientMsg, WebsocketClientState, WsClientEffect>`. | `WebsocketClientTransport`, which is the imperative shell that *runs* the program |
| `WsClientEffect` | Inspectable data describing an I/O action (create-websocket, close-websocket, start-reconnect-timer, etc.). | An `Effect<Msg>` closure — these effects are data |
| `Socket` | Framework-agnostic interface with `send`, `close`, `onMessage`, `onClose`, and a string `readyState`. Server side. | `WebSocketLike`, which is a structural type over real WebSocket *instances* and uses `addEventListener` |
| `WebSocketLike` | Structural type matching browser `WebSocket`, Node's `ws`, and Bun's client `WebSocket` — constructor output used by the client transport. | `Socket` |
| `WebSocketConstructor` | `new (url: string, ...rest: any[]) => WebSocketLike`. The injection point for runtime-agnostic client creation. | A runtime detection helper |
| `"ready"` signal | A single text frame `"ready"` the server sends after wiring up its side of the channel. The client treats socket-open + this signal as the gate for creating its own channel. | The WebSocket `open` event alone |
| `wrapStandardWebsocket` | Adapter from browser-style `WebSocket` (server-side use of `ws`) to `Socket`. | `wrapBunWebsocket`, `wrapNodeWebsocket` |
| `wrapBunWebsocket` | Adapter from Bun's `ServerWebSocket` to `Socket`. Stores handlers in `ws.data`. | `wrapStandardWebsocket` |
| `wrapNodeWebsocket` | Adapter from Node's `ws` `WebSocket` (server side) to `Socket`. | `wrapStandardWebsocket`, which is the simpler browser-spec case |
| `BunWebsocketData` | The shape that `Bun.serve<BunWebsocketData>({...})` stores in `ws.data` so per-socket callbacks can reach their handlers. | Application state per connection |
| `DEFAULT_FRAGMENT_THRESHOLD` | Byte threshold above which a payload is fragmented by `@kyneta/wire`. | A WebSocket protocol-level fragment (`FIN`/`continuation`) — this is application-level |
| `createServiceWebsocketClient` | Backend-only client factory that accepts HTTP headers (e.g. `Authorization`) during upgrade. | `createWebsocketClient` (browser-safe; no headers) |

---

## Architecture

**Thesis**: one WebSocket-shaped wire, three runtime environments, and a pure state machine keeps the client's reconnect logic testable without mocks.

The package is structured around a single shared wire format (CBOR frames via `@kyneta/wire`) and a single shared client state machine (`createWsClientProgram`). The three entry points only differ in which constructor/wrapper they expose:

| Entry | Concrete transport | Consumers |
|-------|--------------------|-----------|
| `./browser` | `WebsocketClientTransport` + `createWebsocketClient` factory | Browser apps, tests |
| `./server` | `WebsocketServerTransport` + `createServiceWebsocketClient` | Node/Bun servers, service-to-service |
| `./bun` | `wrapBunWebsocket` + `BunWebsocketData` | Bun's `Bun.serve<T>` callback style |

All four runtime situations (browser client, Bun server, Node server, server-to-server client) produce and consume bytes in the same `@kyneta/wire` pipeline: `ChannelMsg → cborCodec.encode → encodeBinaryAndSend → socket.send`, reversed on receive through `decodeBinaryMessages + FragmentReassembler`.

### What this transport is NOT

- **Not an HTTP server.** It does not provide upgrade-request handling — the application owns `Bun.serve` / `ws.Server` / Node's `http.Server`. The transport attaches to already-upgraded sockets via `addConnection(socket, peerId?)`.
- **Not a reconnection library.** The reconnect logic is embedded in `createWsClientProgram` (backoff from `@kyneta/transport`, jitter injected for testability). Applications cannot disable it from the outside except by setting `reconnect: { enabled: false }` in `WebsocketClientOptions`.
- **Not polyfilled.** The browser `WebSocket`, Node `ws`, and Bun `WebSocket` constructors are passed in by the caller. The transport never references `globalThis.WebSocket`.

---

## Runtime-agnostic constructor injection

`createWebsocketClient({ url, WebSocket, ... })` requires the WebSocket constructor as an explicit option. Source: `packages/exchange/transports/websocket/src/client-transport.ts` → `WebsocketClientOptions.WebSocket`.

**Why**: there is no runtime default. Browsers provide `globalThis.WebSocket`; Node requires `import { WebSocket } from "ws"`; Bun provides `WebSocket` globally but differs subtly (Bun's client satisfies `WebSocketLike` structurally, no cast needed). Selecting the right one is the caller's concern — the transport does not sniff.

```
import { createWebsocketClient } from "@kyneta/websocket-transport/browser"

const exchange = new Exchange({
  transports: [createWebsocketClient({
    url: "ws://localhost:3000/ws",
    WebSocket,
  })],
})
```

This also means the transport has zero DOM type dependencies — the `WebSocketLike` structural type (source: `src/types.ts`) uses `addEventListener(type, listener: (event: any) => void)` with `any` event types. That looseness is intentional; tightening to DOM types would pin the package to the browser runtime.

---

## The ready gate

When a browser opens a WebSocket, the server's upgrade handler runs asynchronously. There is a window in which `ws.onopen` has fired on the client but the server has not yet wired up its `onMessage` / `onClose` callbacks. If the client sends `establish` immediately, the server may drop it.

The fix: the server sends a single text frame `"ready"` after it finishes wiring up. The client's state machine treats `socket-opened` and `server-ready` as two separate messages; it creates the channel and begins `establish` only after both have arrived.

Source: `packages/exchange/transports/websocket/src/client-program.ts` header comment and state transitions.

The race has a second corner: the server's `"ready"` can arrive *before* the client's own `open` event fires. The program handles this by transitioning directly from `connecting` to `ready`, skipping `connected`.

### What the `"ready"` signal is NOT

- **Not a handshake message in the `establish` sense.** It does not carry identity. It only signals that the server side of the channel is wired up.
- **Not batched.** It is always a single WebSocket text frame containing the literal string `"ready"`.
- **Not codec-routed.** It is intercepted below the CBOR layer — the client recognises it before invoking the codec.

---

## Client state machine

Source: `packages/exchange/transports/websocket/src/client-program.ts`. The state machine is `Program<WsClientMsg, WebsocketClientState, WsClientEffect>` — purely data. Interpretation happens in `WebsocketClientTransport` via `createObservableProgram`.

| State (`status`) | How it got here | Can transition to |
|------------------|-----------------|-------------------|
| `disconnected` | Initial / terminal | `connecting` (on `start`) |
| `connecting` | `create-websocket` effect issued | `connected` (on `socket-opened`), `ready` (if `server-ready` arrives first), `reconnecting` (on `socket-closed`/`socket-error`) |
| `connected` | Socket open event received, awaiting server `"ready"` | `ready` (on `server-ready`), `reconnecting` (on close) |
| `ready` | Server `"ready"` received; `add-channel-and-establish` effect issued | `reconnecting` (on close) |
| `reconnecting` | Waiting for backoff timer | `connecting` (on timer fire), `disconnected` (on max retries or explicit stop) |

Messages (`WsClientMsg`): `start`, `socket-opened`, `server-ready`, `socket-closed`, `socket-error`, `reconnect-timer-fired`, `stop`.

Effects (`WsClientEffect`): `create-websocket`, `close-websocket`, `add-channel-and-establish`, `remove-channel`, `start-reconnect-timer`, `cancel-reconnect-timer`, `start-keepalive`, `stop-keepalive`.

### What `createWsClientProgram` is NOT

- **Not an EventEmitter.** It is a pure `Program`. State is observed via `ObservableHandle.subscribeToTransitions`, not via event listeners.
- **Not a class or constructor.** `createWsClientProgram(options)` returns a plain `Program` value; a runtime interprets it.
- **Not aware of the socket.** The program emits `create-websocket` and `close-websocket` effects; the client transport holds the actual `WebSocketLike` instance and acts on the effects.

### Backoff

Backoff uses `computeBackoffDelay(attempt, baseDelay, maxDelay, jitter)` from `@kyneta/transport`. Jitter is injected into `createWsClientProgram` as `jitterFn` (default `() => Math.random() * 1000`) so tests can pin it to a constant and assert on exact delays.

---

## `Socket` vs `WebSocketLike`

Two interfaces exist because the server and client sides have different natural shapes.

| Interface | File | Used by | Method style |
|-----------|------|---------|--------------|
| `Socket` | `src/types.ts` → `Socket` | Server side (`WebsocketConnection`) | Single-callback registration: `onMessage(fn)`, `onClose(fn)` |
| `WebSocketLike` | `src/types.ts` → `WebSocketLike` | Client side | DOM-spec `addEventListener(type, handler)` with multi-subscriber semantics |

The client transport uses `addEventListener`/`removeEventListener` so it can attach one-shot handlers during the connect phase and remove them on transition — matching the browser `WebSocket` reality. The server transport does not need that; each `Socket` has exactly one consumer (the `WebsocketConnection`).

### Server wrappers

The server side accepts whichever runtime's WebSocket and wraps it to `Socket`:

| Runtime | Wrapper | Source |
|---------|---------|--------|
| `ws` library (Node / server-side browser spec) | `wrapStandardWebsocket(ws)` | `src/types.ts` |
| Node `ws.WebSocket` instance | `wrapNodeWebsocket(ws)` | `src/types.ts` |
| Bun `ServerWebSocket<BunWebsocketData>` | `wrapBunWebsocket(ws)` | `src/bun-websocket.ts` — bridges Bun's server-level callbacks by storing handlers in `ws.data` |

---

## Three entry points, one wire

### Browser client

```
import { createWebsocketClient } from "@kyneta/websocket-transport/browser"

const exchange = new Exchange({
  transports: [createWebsocketClient({ url, WebSocket })],
})
```

### Bun server

```
import { WebsocketServerTransport } from "@kyneta/websocket-transport/server"
import { wrapBunWebsocket, type BunWebsocketData } from "@kyneta/websocket-transport/bun"

const server = new WebsocketServerTransport()

Bun.serve<BunWebsocketData>({
  fetch(req, srv) { if (srv.upgrade(req, { data: { handlers: {} } })) return },
  websocket: {
    open(ws)    { server.addConnection(wrapBunWebsocket(ws)) },
    message(ws, data) { ws.data.handlers.onMessage?.(data) },
    close(ws, code, reason) { ws.data.handlers.onClose?.(code, reason) },
  },
})
```

### Node + `ws`

```
import { WebsocketServerTransport, wrapNodeWebsocket } from "@kyneta/websocket-transport/server"
import { WebSocketServer } from "ws"

const server = new WebsocketServerTransport()
const wss = new WebSocketServer({ port: 3000 })
wss.on("connection", ws => server.addConnection(wrapNodeWebsocket(ws)))
```

### Service-to-service client

```
import { createServiceWebsocketClient } from "@kyneta/websocket-transport/server"
import { WebSocket } from "ws"

const exchange = new Exchange({
  transports: [createServiceWebsocketClient({
    url: "ws://primary:3000/ws",
    WebSocket,
    headers: { Authorization: "Bearer ..." },
  })],
})
```

`createServiceWebsocketClient` lives in `./server` because `headers` is a Node/Bun-only option (the browser `WebSocket` constructor does not accept them). Keeping it out of `./browser` prevents accidental browser bundling.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `WebsocketClientTransport` | `src/client-transport.ts` | The client `Transport<...>` subclass. Runs the client program via `createObservableProgram`. |
| `WebsocketClientOptions` | `src/client-transport.ts` | `{ url, WebSocket, headers?, reconnect?, fragmentThreshold?, ... }`. |
| `WebsocketClientLifecycleEvents` | `src/client-transport.ts` | Observable lifecycle event shape. |
| `DEFAULT_FRAGMENT_THRESHOLD` | `src/client-transport.ts` / `src/connection.ts` | Byte threshold for `@kyneta/wire` fragmentation. |
| `createWebsocketClient` | `src/client-transport.ts` | `TransportFactory` for browser-facing clients. |
| `createServiceWebsocketClient` | `src/service-client.ts` | `TransportFactory` for backend clients with headers. |
| `WebsocketServerTransport` | `src/server-transport.ts` | The server `Transport<...>` subclass. Owns many connections. |
| `WebsocketServerTransportOptions` | `src/server-transport.ts` | Server construction options. |
| `WebsocketConnection` | `src/connection.ts` | One accepted peer connection on the server side. |
| `WebsocketConnectionConfig` | `src/connection.ts` | Per-connection options. |
| `createWsClientProgram` | `src/client-program.ts` | Factory for the pure client `Program`. |
| `WsClientMsg` / `WsClientEffect` / `WsClientProgramOptions` | `src/client-program.ts` | Program's messages, effects, options. |
| `WebsocketClientState` / `WebsocketClientStateTransition` | `src/types.ts` | Client state discriminated union + transition alias. |
| `Socket` / `SocketReadyState` | `src/types.ts` | Server-side framework-agnostic socket interface. |
| `WebSocketLike` / `WebSocketConstructor` | `src/types.ts` | Client-side structural types for real WebSocket objects. |
| `wrapStandardWebsocket` / `wrapNodeWebsocket` / `wrapBunWebsocket` | `src/types.ts`, `src/bun-websocket.ts` | Runtime-specific adapters to `Socket`. |
| `BunWebsocketData` | `src/bun-websocket.ts` | Shape for `ws.data` under `Bun.serve<BunWebsocketData>`. |
| `DisconnectReason` | `src/types.ts` | Discriminated union describing why a connection ended. |
| `READY_STATE` | `src/types.ts` | Spec constants `{ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 }`. |
| `WebSocketMessageEvent` / `WebSocketCloseEvent` | `src/types.ts` | Minimal structural event types (replace DOM). |

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/browser.ts` | 49 | `./browser` entry — client factory + client types. |
| `src/server.ts` | 57 | `./server` entry — server transport + `createServiceWebsocketClient` + wrappers. |
| `src/bun.ts` | 24 | `./bun` entry — Bun wrapper + `BunWebsocketData`. |
| `src/types.ts` | 378 | `Socket`, `WebSocketLike`, wrappers, `DisconnectReason`, state type. |
| `src/client-program.ts` | 272 | Pure `createWsClientProgram` Mealy machine. |
| `src/client-transport.ts` | 602 | Imperative shell: runs the program, owns the socket, runs the CBOR pipeline, fragments. |
| `src/server-transport.ts` | 280 | Server-side `Transport<...>`: accepts connections, dispatches to `WebsocketConnection`. |
| `src/connection.ts` | 206 | Per-connection CBOR pipeline + fragment reassembler + channel ownership. |
| `src/service-client.ts` | 52 | `createServiceWebsocketClient` factory (headers). |
| `src/bun-websocket.ts` | 163 | `wrapBunWebsocket` + `BunWebsocketData`. |
| `src/__tests__/client-program.test.ts` | 760 | Pure tests: every state transition and effect asserted on data. No sockets. |
| `src/__tests__/client-transport.test.ts` | 167 | Imperative-shell tests: socket creation, close, reconnect scheduling. |

## Testing

`createWsClientProgram` is a pure `Program`, so `client-program.test.ts` dispatches messages and asserts on the returned `[state, ...effects]` tuple. No real sockets, no real timers (`vi.useFakeTimers` where time is relevant). `client-transport.test.ts` uses a minimal `WebSocketLike` stub to verify the imperative shell schedules the right effects.

**Tests**: 56 passed, 0 skipped across 2 files (`client-program.test.ts`: 51, `client-transport.test.ts`: 5). Run with `cd packages/exchange/transports/websocket && pnpm exec vitest run`.