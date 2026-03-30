# Examples Roadmap

## Intent

Kyneta's examples serve two audiences: developers evaluating whether to use the framework, and search engines indexing concrete collaborative app code. Each example is a complete, opinionated, runnable app that makes one architectural point. Together, the five examples tell a progressive story — from "look how little code" to "the server is optional."

The examples are NOT a configuration matrix or example builder. They are concrete apps with concrete choices. The composability of the underlying architecture (transport × backend × framework × runtime) is demonstrated implicitly by the shared domain code and variant files within each example, and explicitly by documentation.

## What Each Example Demonstrates

| # | Example | Point | Key concepts |
|---|---------|-------|-------------|
| 1 | **todo** | Minimal code, instant sync | Cast compiler, WebSocket, Loro, single merge strategy |
| 2 | **todo-react** | Framework-agnostic sync layer | Same server as todo, React client, proves Exchange doesn't care about UI |
| 3 | **chat** | Rich data types, different transport | Text CRDTs, presence, SSE transport, AI streaming |
| 4 | **bumper-cars** | Heterogeneous documents, right tool for each job | Three merge strategies in one Exchange: causal (scoreboard counters), sequential (server-authoritative physics), LWW (player input). Demonstrates that ephemeral state is just another merge strategy, and that server-authoritative state doesn't need a CRDT. |
| 5 | **video-conference** | Serverless P2P sync | Stacked adapters (SSE + WebRTC). Server bootstraps discovery, WebRTC carries sync. Kill the server — peers keep syncing. |

## Stack Choices Per Example

Each example picks one concrete stack. Variant files (e.g. `server-node.ts` alongside `server.ts`) show alternative runtime choices without creating separate packages.

| Example | Framework | Transport | Backend | Runtime | Server |
|---------|-----------|-----------|---------|---------|--------|
| todo | Cast | WebSocket | Loro | Bun | `Bun.serve()` |
| todo-react | React | WebSocket | Loro | Bun | shared with todo |
| chat | React | SSE | Loro | Node | Express |
| bumper-cars | React | WebSocket | Loro + Plain | Bun | `Bun.serve()` |
| video-conference | React | SSE + WebRTC | Loro | Node | Express |

## Composition Axes (For Documentation, Not Code)

The four axes of variation exist in the architecture. Each example exercises specific cells; documentation covers the rest.

- **Framework** (Cast, React, Hono): Cast and React are demonstrated by examples. Hono is covered in a guide — the hono-counter vendor example provides reference.
- **Transport** (WebSocket, SSE, HTTP-poll): WebSocket and SSE are demonstrated. HTTP-poll is documented as a guide once the adapter is ported.
- **Backend** (Loro, Yjs, Plain): Loro and Plain are demonstrated. Yjs is a one-line swap documented in the todo README ("change `bindLoro` to `bindYjs`").
- **Runtime** (Bun, Node): Both are demonstrated. Each example that uses Bun includes a `server-node.ts` variant.

## Prerequisites — What Must Be Built First

### Network adapters

The vendor `@loro-extended` has SSE, HTTP-polling, and WebRTC adapters. Kyneta currently has only WebSocket (`@kyneta/websocket-network-adapter`). The following must be ported to the `@kyneta/exchange` adapter interface:

1. **`@kyneta/sse-network-adapter`** — Required by chat, video-conference. Port from `@loro-extended/adapter-sse`. Both server (Express integration) and client (EventSource + POST) sides.
2. **`@kyneta/webrtc-network-adapter`** — Required by video-conference. Port from `@loro-extended/adapter-webrtc`. BYODC (Bring Your Own Data Channel) design. Uses `@kyneta/wire` for encoding/fragmentation.

HTTP-polling is not required by any example and can be deferred.

### React bindings

The vendor has `@loro-extended/react` providing `RepoProvider`, `useDocument`, `useValue`, `change()`, `useDocIdFromHash`. Kyneta needs an equivalent:

3. **`@kyneta/react`** — Thin React bindings over `@kyneta/exchange` and `@kyneta/schema`. Provides hooks for document access, reactive subscriptions, and the Exchange provider context. Required by todo-react, chat, bumper-cars, video-conference.

### Exchange integration in recipe-book

The existing `recipe-book` example hand-rolls WebSocket sync. It should either be updated to use `@kyneta/exchange` or left as-is with a note. New examples must use Exchange.

## Sequence

### Phase 1: Foundation (todo)

Port the todo example using Cast + WebSocket + Loro + Bun. This validates the full vertical slice: `@kyneta/schema` → `bindLoro` from `@kyneta/loro-schema` → `@kyneta/exchange` → `@kyneta/websocket-network-adapter` → `@kyneta/cast` view → running app.

- Domain: schema, mutations, types, seed data
- Server: Bun entry point with `Bun.serve()`, `WebsocketServerAdapter`, `Exchange`
- Client: Cast view compiled by the unplugin, `WebsocketClientAdapter`, `Exchange`
- Variant: `server-node.ts` using `ws` + `wrapNodeWebsocket`
- README: includes "swap Yjs" one-line guide

### Phase 2: React bindings (todo-react)

Build `@kyneta/react` and the todo-react example. Shares the todo's schema and server. Proves the sync layer is framework-agnostic.

- Build `@kyneta/react` with `ExchangeProvider`, `useDocument`, `useValue`
- Client: React view using hooks, same WebSocket transport
- Server: reuse or symlink from todo

### Phase 3: SSE transport + chat

Port `@kyneta/sse-transport` and build the chat example. Introduces text CRDTs, the SSE transport, and a richer domain.

- Port `@kyneta/sse-transport` (Express server integration, EventSource client)
- Domain: chat schema with text fields, message list, presence
- Server: Node + Express + SSE
- Client: React + SSE
- Optional: AI streaming integration (demonstrates server-side mutations)

### Phase 4: Bumper-cars

Build the bumper-cars example. Demonstrates heterogeneous merge strategies: causal (Loro scoreboard with counters), sequential (Plain server-authoritative game state), LWW (Plain ephemeral player input).

- Domain: three schemas, three `BoundSchema` declarations, physics engine
- Server: Bun, game loop at 60fps mutating the sequential game-state doc, reading LWW input docs
- Client: React, joystick input writing to LWW doc, rendering from sequential game-state doc, scoreboard from causal doc
- Key point: no special "presence" or "ephemeral" API — LWW is `bindLww()` + `exchange.get()`, same as everything else

### Phase 5: WebRTC transport + video-conference

Port `@kyneta/webrtc-transport` and build the video-conference example. Demonstrates stacked adapters and serverless sync.

- Port `@kyneta/webrtc-transport` (BYODC adapter, binary CBOR over data channels)
- Domain: room schema, participant list, WebRTC signaling via LWW docs
- Server: Node + Express + SSE (thin — just bootstrap and signaling relay)
- Client: React, dual adapters (SSE + WebRTC), WebRTC mesh for video + data
- README: "Now kill the server" walkthrough demonstrating P2P sync continuity

## Non-Goals

- **No example builder / generator CLI.** Each example is a complete app in its own directory.
- **No exhaustive matrix coverage.** Five examples × specific stack choices. Other combinations are documented, not built.
- **No abstraction layer between examples.** Shared domain code is shared via co-location or re-export, not via a shared library package.
- **No Hono example in the initial set.** Hono is documented as a guide. The vendor `hono-counter` serves as reference. A Hono example may be added later if demand warrants it.