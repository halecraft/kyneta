# unix-socket-sync

N identical processes, one socket path, shared live config. Start as many peers as you want — the first one listens, the rest connect. Kill any peer (including the listener) and the survivors heal automatically. Uses Loro CRDT for crash-tolerant convergence: every peer holds a full replica, so no data is lost when a peer dies.

## Quick Start

```/dev/null/quickstart.sh#L1-9
pnpm install

# Terminal 1:
bun run peer

# Terminal 2:
bun run peer

# Terminal 3:
bun run peer
```

## What You'll See

Each peer renders a TUI — a boxed config editor with 6 fields:

```/dev/null/tui-screenshot.txt#L1-14
  ╭─── unix-socket-sync ───╮  (listening)
  │                         │
  │  Dark Mode     ● on     │
  │  Log Level     info     │
  │  Region        us-east  │
  │  Maintenance   ○ off    │
  │  Max Requests  1000     │
  │  Rate Limit    100      │
  │                         │
  ╰─────────────────────────╯
  3 peers: peer-a1b2c3, peer-d4e5f6, peer-g7h8i9

  ↑↓/jk navigate  ←→/hl change  q quit
```

Arrow keys (or vim-style `hjkl`) navigate and change values. The footer shows the live peer count and peer IDs. Changes propagate instantly — edit a field in one terminal and watch it update in every other.

## Architecture

- **Star topology**: the first peer probes the socket path, finds nothing, and becomes the listener. Subsequent peers probe, find a listener, and connect as clients.
- **`createUnixSocketPeer`** handles all negotiation automatically — probe, decide, connect-or-listen, and heal on failure. One function call, no manual transport wiring.
- **Kill any peer** (including the listener) and the survivors heal. When the listener dies, a connector detects the broken connection, re-probes, and promotes itself to listener. Other connectors then reconnect to the new listener.
- **Loro CRDT** means every peer holds a full replica of the config document. When peers reconnect after a failure, the Exchange handshake merges their Loro documents — all writes converge, no data lost.
- **`exchange.peers` changefeed** drives presence cleanup. When a peer departs, survivors receive a `peer-left` event and remove the departed peer from the shared document's `peers` record.

## The Schema

```examples/unix-socket-sync/src/schema.ts#L11-20
const ConfigSchema = LoroSchema.doc({
  darkMode:    Schema.boolean(),       // toggle
  logLevel:    Schema.string(),        // cycles: debug → info → warn → error
  region:      Schema.string(),        // cycles: us-east → eu-west → ap-south
  maintenance: Schema.boolean(),       // toggle
  maxRequests: Schema.number(),        // step ±100, range [0, 10000]
  rateLimit:   Schema.number(),        // step ±10,  range [0, 1000]
  peers:       LoroSchema.record(Schema.boolean()),  // presence map: peerId → alive
})
```

Each field type has a pure step function (`stepBoolean`, `stepString`, `stepNumber`) that computes the next value given a direction — no mutation, no side effects.

## File Structure

```/dev/null/file-structure.txt#L1-9
examples/unix-socket-sync/
├── src/
│   ├── peer.ts      — entry point (Exchange, unix socket peer, TUI loop)
│   ├── schema.ts    — Loro CRDT config document schema
│   ├── fields.ts    — field descriptors and pure step functions
│   └── tui.ts       — ANSI terminal renderer + keyboard input
├── package.json
├── tsconfig.json
└── README.md
```

## Why This Is Interesting

- **Leaderless topology** — no peer is special. Any peer can die and be replaced. The listener role is emergent, not assigned.
- **Dynamic transport swap** — `exchange.addTransport()` / `exchange.removeTransport()` at runtime. When healing occurs, the Exchange, all documents, and all CRDT state survive across transport swaps.
- **Loro CRDT convergence** — concurrent edits to different fields merge correctly. Two peers editing different config values at the same instant produces the union of both changes.
- **Zero infrastructure** — one socket file, no HTTP, no ports, no coordination service.

## What's NOT Here

- **No persistence** — state is in-memory only. Kill all peers and the config resets.
- **No authentication** — any process that can reach the socket file can join.
- **No browser UI** — this is a terminal-only demo. See the `todo-react` example for browser-based sync.