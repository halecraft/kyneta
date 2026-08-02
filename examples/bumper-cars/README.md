# Bumper Cars Arena

A multiplayer bumper cars game demonstrating **heterogeneous documents** in one Exchange — two binding targets, zero CRDT dependencies.

> **Architectural point:** Different data has different sync requirements. The Exchange handles them transparently — no special "presence" or "ephemeral" API. Ephemeral state is just `ephemeral.bind(schema)` + `exchange.get()`, same as everything else.

## How to Run

```sh
cd examples/bumper-cars
pnpm install
bun run dev
```

Open [http://localhost:5173](http://localhost:5173) in multiple tabs. Pick a name and color, then bump into other cars!

**Controls:** WASD / Arrow keys, or drag anywhere (touch joystick). Press Escape to leave.

## Architecture

Two document types, two binding targets, one Exchange:

| Document | Binding | Strategy | Writer | Purpose |
|----------|---------|----------|--------|---------|
| `game-state` | `json.bind` | Sequential | Server only | Cars, scores, tick — the server runs physics at 60fps and pushes authoritative state to all clients |
| `input:${peerId}` | `ephemeral.bind(schema)` | Ephemeral broadcast | One client each | Joystick/keyboard input — each client writes at ~20fps, the server reads all input docs every tick |

### Data Flow

```
  Client A                    Server                     Client B
  ─────────                   ──────                     ─────────
  keyboard/joystick
       │
       ▼
  batch(inputDoc)
       │  ephemeral broadcast
       ▼
  ─────────────────►  read input:A  ◄─────────────────  batch(inputDoc)
                      read input:B                           ▲
                           │                            keyboard/joystick
                           ▼
                      tick() ── pure physics
                           │
                           ▼
                      batch(gameStateDoc)
                           │  sequential push
                      ┌────┴────┐
                      ▼         ▼
                  useValue   useValue
                  render     render
```

### Exchange Wiring (server.ts)

The server's Exchange uses two callbacks — this is the concrete demonstration of [information flow control](../../packages/exchange/TECHNICAL.md#16-route-and-authorize--information-flow-control):

```ts
canShare(docId, peer)   // input docs only visible to the owning peer
canAccept(docId, peer)  // only the server writes game-state; clients write their own input
```

Player lifecycle is handled by **reactive feeds**, not policy hooks:

```ts
exchange.documents.subscribe(...) // doc-created → addPlayer, doc-removed → removePlayer
exchange.peers.subscribe(...)       // peer-departed → removePlayer + destroy input doc
```

The `peers.subscribe` feed replaces the old `onDocDismissed` proxy, which failed on ungraceful disconnect (no dismiss wire message when a browser tab closes). The reactive peer feed fires immediately when the transport detects a dropped connection, so cleanup is reliable.

### When to use `useDocument` vs imperative `exchange.get/destroy`

`useDocument(docId, bound)` is designed for **persistent documents** whose lifetime matches the component mount or the application session. It memoizes the ref and returns a stable reference.

For **ephemeral documents** with explicit user-initiated create/destroy semantics (join/leave, presence, temporary sessions), the correct primitives are **imperative**:
- `exchange.get(docId, bound)` to create and obtain a typed `Ref`.
- `exchange.destroy(docId)` to signal departure, which emits `doc-removed` on the local documents feed and sends a dismiss wire message to peers.

Using data writes (`d.name.set("")`) to encode "left" intent is an anti-pattern. It couples meaning to values, creates guard bugs (falsy checks rejecting empty strings), and leaves the doc in the sync graph as a ghost. The server should not need to interpret `""` as a lifecycle signal; it should react to `doc-removed` or `peer-departed`.

## The Core Pattern

**`src/schema.ts`** — the centerpiece file:

```ts
import { Schema, json, ephemeral } from "@kyneta/schema"

// Game state — plain JS, sequential merge, server-authoritative.
// The server is the single writer. Cars, scores, and tick are all
// server-owned state that clients render but never mutate directly.
export const GameStateDoc = json.bind(Schema.struct({
  cars: Schema.record(Schema.struct({ x, y, vx, vy, rotation, color, name, hitUntil })),
  scores: Schema.record(Schema.struct({ name, color, bumps })),
  tick: Schema.number(),
}))

// Player input — ephemeral, one doc per player.
// Each client writes joystick/keyboard state at ~20fps. The server
// reads all input docs every tick. Only the latest value matters.
export const PlayerInputDoc = ephemeral.bind(Schema.struct({
  name, color, force, angle,
}))
```

Two bind calls. Two binding targets. That's it.

## What's Here

```
bumper-cars/
├── public/
│   └── index.html              13  lines — HTML shell
├── src/
│   ├── schema.ts               71  lines — Two BoundSchema declarations
│   ├── constants.ts            69  lines — Arena, physics, colors, cooldown retention
│   ├── types.ts                42  lines — Plain TS types
│   ├── server.ts              121  lines — Bun entry point + Exchange wiring
│   ├── build.ts                 3  lines — Standalone client build (calls buildClient)
│   ├── main.tsx                58  lines — Client entry (ExchangeProvider)
│   ├── server/
│   │   ├── tick.ts            134  lines — Pure tick function (functional core)
│   │   ├── game-loop.ts       275  lines — Imperative shell (Gather → Plan → Execute)
│   │   ├── physics.ts         281  lines — Pure physics functions
│   │   ├── tick.test.ts       234  lines — 10 tick tests
│   │   ├── physics.test.ts    244  lines — 17 physics tests
│   │   └── test-helpers.ts    47  lines — Shared test fixtures
│   ├── client/
│   │   ├── bumper-cars-app.tsx 203  lines — Main React component
│   │   ├── logic.ts           126  lines — Pure client logic
│   │   ├── logic.test.ts      264  lines — 24 logic tests
│   │   ├── components/
│   │   │   ├── arena-canvas.tsx  239 lines — Canvas renderer with true linear interpolation
│   │   │   ├── join-screen.tsx   108 lines — Name/color picker
│   │   │   ├── player-list.tsx    44 lines — Active players
│   │   │   └── scoreboard.tsx     48 lines — Top scores
│   │   └── hooks/
│   │       ├── use-keyboard-input.ts  133 lines — WASD/Arrow keys
│   │       ├── use-joystick.ts         89  lines — Touch joystick (nipplejs)
│   │       └── use-input-sender.ts     90  lines — Throttled input writer
│   └── index.css              310  lines — Styling
├── package.json
├── tsconfig.json
└── README.md
```

**51 tests** — all pure functions, no mocking required.

## Why Is This Interesting?

### No special API for ephemeral state

Previously, in `@loro-extended` (see `@loro-extended/examples/bumper-cars`) we used a dedicated "ephemeral/presence" system baked into the sync engine — `sync(doc).presence.setSelf(...)`, `useEphemeral(...)`, a discriminated union schema for presence types.

Kyneta has none of that. Player input is a regular document bound with `ephemeral.bind(schema)`. It goes through the same Exchange, the same WebSocket adapter, the same `batch()` / `useValue()` API as everything else. The ephemeral sync mode handles the semantics: every change broadcasts a whole snapshot, and the receiver merges it field by field on each leaf's own timestamp. Nothing is persisted, and no offer is discarded as stale — a snapshot that is older overall may still carry the newest value for some individual field.

### The server is the right tool for game state

The scoreboard uses plain numbers (`bumps: Schema.number()`), not CRDT counters. Why? Because the server is the **single writer** for scores. There are no concurrent increments to merge. A plain number with `.set(n + 1)` is simpler and correct.

This eliminates `loro-crdt` (~1MB WASM) from the client bundle entirely. The example has **zero CRDT dependencies**.

### When would you use a CRDT?

If the game were **peer-to-peer** (no authoritative server), you'd need convergent data structures for scores:

```ts
import { Schema } from "@kyneta/schema"
import { loro } from "@kyneta/loro-schema"

const ScoreboardDoc = loro.bind(Schema.struct({
  scores: Schema.record(Schema.struct({
    name: Schema.string(),
    color: Schema.string(),
    bumps: Schema.counter(),  // concurrent increments converge
  })),
}))
```

`Schema.counter()` handles concurrent increments via the Loro CRDT engine. Multiple peers can call `.increment(1)` simultaneously, and the counter converges to the correct total. But when there's a single authoritative server, that complexity is unnecessary — and kyneta lets you choose the right tool.

### Gather → Plan → Execute

The game loop follows the Functional Core / Imperative Shell principle:

1. **Gather** — read all input docs by calling each ref directly (`inputDoc()`)
2. **Plan** — call `tick()`, a pure function that takes state + inputs and returns new state + collisions
3. **Execute** — write results to the game state doc via `batch()`

The pure `tick()` function is tested with 10 tests that exercise the full physics pipeline (input → friction → position → wall bounce → car collision → scoring → cooldown) without any Exchange or WebSocket infrastructure.

## What's NOT Here (Intentionally)

- ❌ Server persistence — game state and scores are **in-memory only**; restarting the server clears everything.
- ❌ Client persistence — **not** in-memory only. Client identity (name, color, peerId) is **persisted in `localStorage`** so reconnecting browsers retain the same appearance. Scores of departed players survive in the server's memory until restart; this is not persisted to disk and will be lost on server restart.
- ❌ Authentication — no auth; any client can claim any peerId
- ❌ SSE transport — WebSocket only (see the chat example for SSE)
- ❌ Loro / Yjs / any CRDT — plain substrate only; this is the point
- ❌ Vite — Bun handles React JSX natively; `Bun.build()` bundles in ~20ms
