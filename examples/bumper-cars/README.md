# Bumper Cars Arena

A multiplayer bumper cars game demonstrating **heterogeneous documents** in one Exchange — two merge strategies, zero CRDT dependencies.

> **Architectural point:** Different data has different sync requirements. The Exchange handles them transparently — no special "presence" or "ephemeral" API. Ephemeral state is just `bindEphemeral()` + `exchange.get()`, same as everything else.

## How to Run

```sh
cd examples/bumper-cars
pnpm install
bun run dev
```

Open [http://localhost:5173](http://localhost:5173) in multiple tabs. Pick a name and color, then bump into other cars!

**Controls:** WASD / Arrow keys, or drag anywhere (touch joystick). Press Escape to leave.

## Architecture

Two document types, two merge strategies, one Exchange:

| Document | Binding | Strategy | Writer | Purpose |
|----------|---------|----------|--------|---------|
| `game-state` | `bindPlain` | Sequential | Server only | Cars, scores, tick — the server runs physics at 60fps and pushes authoritative state to all clients |
| `input:${peerId}` | `bindEphemeral` | LWW broadcast | One client each | Joystick/keyboard input — each client writes at ~20fps, the server reads all input docs every tick |

### Data Flow

```
  Client A                    Server                     Client B
  ─────────                   ──────                     ─────────
  keyboard/joystick
       │
       ▼
  change(inputDoc)
       │  LWW broadcast
       ▼
  ─────────────────►  read input:A  ◄─────────────────  change(inputDoc)
                      read input:B                           ▲
                           │                            keyboard/joystick
                           ▼
                      tick() ── pure physics
                           │
                           ▼
                      change(gameStateDoc)
                           │  sequential push
                      ┌────┴────┐
                      ▼         ▼
                  useValue   useValue
                  render     render
```

### Exchange Wiring (server.ts)

The server's Exchange uses four callbacks — this is the concrete demonstration of [route/authorize](../../packages/exchange/TECHNICAL.md#16-route-and-authorize--information-flow-control) and [onDocDiscovered](../../packages/exchange/TECHNICAL.md#15-lazy-document-creation-ondocdiscovered):

```ts
route(docId, peer)          // input docs only visible to the owning peer
authorize(docId, peer)      // only the server writes game-state; clients write their own input
onDocDiscovered(docId, peer) // materializes input:${peerId} when a player connects
onDocDismissed(docId, peer)  // removes the player's car when they disconnect
```

## The Core Pattern

**`src/schema.ts`** — the centerpiece file:

```ts
import { Schema, bindPlain, bindEphemeral } from "@kyneta/schema"

// Game state — plain JS, sequential merge, server-authoritative.
// The server is the single writer. Cars, scores, and tick are all
// server-owned state that clients render but never mutate directly.
export const GameStateDoc = bindPlain(Schema.doc({
  cars: Schema.record(Schema.struct({ x, y, vx, vy, rotation, color, name, hitUntil })),
  scores: Schema.record(Schema.struct({ name, color, bumps })),
  tick: Schema.number(),
}))

// Player input — LWW ephemeral, one doc per player.
// Each client writes joystick/keyboard state at ~20fps. The server
// reads all input docs every tick. Only the latest value matters.
export const PlayerInputDoc = bindEphemeral(Schema.doc({
  name, color, force, angle,
}))
```

Two `bind*` calls. Two strategies. That's it.

## What's Here

```
bumper-cars/
├── public/
│   └── index.html              13  lines — HTML shell
├── src/
│   ├── schema.ts               71  lines — Two BoundSchema declarations
│   ├── constants.ts            66  lines — Arena, physics, colors
│   ├── types.ts                42  lines — Plain TS types
│   ├── server.ts              170  lines — Bun entry point + Exchange wiring
│   ├── build.ts               104  lines — Bun.build() client bundler
│   ├── main.tsx                55  lines — Client entry (ExchangeProvider)
│   ├── server/
│   │   ├── tick.ts            121  lines — Pure tick function (functional core)
│   │   ├── game-loop.ts       201  lines — Imperative shell (Gather → Plan → Execute)
│   │   ├── physics.ts         225  lines — Pure physics functions
│   │   ├── tick.test.ts       261  lines — 10 tick tests
│   │   └── physics.test.ts    263  lines — 17 physics tests
│   ├── client/
│   │   ├── bumper-cars-app.tsx 196  lines — Main React component
│   │   ├── logic.ts           125  lines — Pure client logic
│   │   ├── logic.test.ts      264  lines — 24 logic tests
│   │   ├── components/
│   │   │   ├── arena-canvas.tsx  211 lines — Canvas renderer
│   │   │   ├── join-screen.tsx   108 lines — Name/color picker
│   │   │   ├── player-list.tsx    44 lines — Active players
│   │   │   └── scoreboard.tsx     48 lines — Top scores
│   │   └── hooks/
│   │       ├── use-keyboard-input.ts  124 lines — WASD/Arrow keys
│   │       ├── use-joystick.ts         91 lines — Touch joystick (nipplejs)
│   │       └── use-input-sender.ts     85 lines — Throttled input writer
│   └── index.css              310  lines — Styling
├── package.json
├── tsconfig.json
└── README.md
```

**51 tests** — all pure functions, no mocking required.

## Why Is This Interesting?

### No special API for ephemeral state

The vendor example (`@loro-extended/examples/bumper-cars`) uses a dedicated "ephemeral/presence" system baked into the sync engine — `sync(doc).presence.setSelf(...)`, `useEphemeral(...)`, a discriminated union schema for presence types.

Kyneta has none of that. Player input is a regular document bound with `bindEphemeral()`. It goes through the same Exchange, the same WebSocket adapter, the same `change()` / `useValue()` API as everything else. The LWW merge strategy handles the semantics (broadcast snapshot on every change, timestamp-based stale rejection at the receiver).

### The server is the right tool for game state

The scoreboard uses plain numbers (`bumps: Schema.number()`), not CRDT counters. Why? Because the server is the **single writer** for scores. There are no concurrent increments to merge. A plain number with `.set(n + 1)` is simpler and correct.

This eliminates `loro-crdt` (~1MB WASM) from the client bundle entirely. The example has **zero CRDT dependencies**.

### When would you use a CRDT?

If the game were **peer-to-peer** (no authoritative server), you'd need convergent data structures for scores:

```ts
import { LoroSchema, bindLoro } from "@kyneta/loro-schema"

const ScoreboardDoc = bindLoro(LoroSchema.doc({
  scores: LoroSchema.record(Schema.struct({
    name: Schema.string(),
    color: Schema.string(),
    bumps: LoroSchema.counter(),  // concurrent increments converge
  })),
}))
```

`LoroSchema.counter()` handles concurrent increments via the Loro CRDT engine. Multiple peers can call `.increment(1)` simultaneously, and the counter converges to the correct total. But when there's a single authoritative server, that complexity is unnecessary — and kyneta lets you choose the right tool.

### Gather → Plan → Execute

The game loop follows the Functional Core / Imperative Shell principle:

1. **Gather** — read all input docs by calling each ref directly (`inputDoc()`)
2. **Plan** — call `tick()`, a pure function that takes state + inputs and returns new state + collisions
3. **Execute** — write results to the game state doc via `change()`

The pure `tick()` function is tested with 10 tests that exercise the full physics pipeline (input → friction → position → wall bounce → car collision → scoring → cooldown) without any Exchange or WebSocket infrastructure.

## What's NOT Here (Intentionally)

- ❌ Persistence — in-memory only; restart clears all state
- ❌ Authentication — no auth; any client can claim any peerId
- ❌ SSE transport — WebSocket only (see the chat example for SSE)
- ❌ Loro / Yjs / any CRDT — plain substrate only; this is the point
- ❌ Vite — Bun handles React JSX natively; `Bun.build()` bundles in ~20ms