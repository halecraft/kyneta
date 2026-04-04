# Kyneta

A collaborative-first application platform where CRDTs meet compiled UI. Kyneta explores three ideas in parallel: a constraint-based CRDT engine where merge is trivially set union and complexity lives in a Datalog solver; a schema algebra that collapses parallel tree walkers into a single generic catamorphism; and a compiled UI framework that exploits CRDT deltas for O(k) DOM updates.

## Packages

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/schema`](./packages/schema) | Schema interpreter algebra. One recursive `Schema` type, one generic `interpret()` catamorphism, pluggable interpreters for reading, mutation, observation, and validation. Zero runtime dependencies. | 1,447 |
| [`@kyneta/compiler`](./packages/compiler) | Target-agnostic incremental view maintenance compiler. Transforms TypeScript AST into classified IR annotated with binding times, delta kinds, and incremental strategies. | 547 |
| [`@kyneta/cast`](./packages/cast) (Kinetic) | Compiled delta-driven UI framework. Transforms natural TypeScript into code that directly consumes CRDT deltas — character-level text patches, O(k) list updates, branch swapping — with no virtual DOM and no diffing. | 634 |
| [`@kyneta/exchange`](./packages/exchange) | Substrate-agnostic state exchange. Three merge strategies (causal, sequential, LWW) dispatched over a four-message sync protocol (discover, interest, offer, dismiss) with a two-message handshake (establish-request, establish-response). Hosts heterogeneous documents — Loro CRDTs, Yjs CRDTs, plain JS, ephemeral presence — in one sync network. | 127 |
| [`@kyneta/react`](./packages/react) | Thin React bindings over `@kyneta/schema` + `@kyneta/exchange`. Hooks for document access, sync status, and reactive value observation via `useSyncExternalStore`. | 29 |
| [`@kyneta/loro-schema`](./packages/schema/backends/loro) | Loro CRDT substrate for `@kyneta/schema`. Wraps a `LoroDoc` with schema-aware typed reads, `applyDiff`-based writes, and a persistent event bridge that observes all mutations regardless of source. | 134 |
| [`@kyneta/yjs-schema`](./packages/schema/backends/yjs) | Yjs CRDT substrate for `@kyneta/schema`. Wraps a `Y.Doc` with schema-aware typed reads, Yjs-native writes, and a persistent event bridge. | 143 |
| [`@kyneta/wire`](./packages/exchange/wire) | Wire format codecs, framing, and fragmentation for `@kyneta/exchange`. CBOR and JSON codecs, 6-byte binary frames, and a fragmentation protocol for cloud WebSocket gateways. | 187 |
| [`@kyneta/websocket-network-adapter`](./packages/exchange/network-adapters/websocket) | WebSocket network adapter for `@kyneta/exchange`. Client, server, and Bun-specific handlers with connection lifecycle, keepalive, and reconnection. | 41 |
| [`@kyneta/sse-network-adapter`](./packages/exchange/network-adapters/sse) | SSE network adapter for `@kyneta/exchange`. Client, server, and Express integration with text wire format and custom reconnection state machine. | 33 |
| [`@kyneta/webrtc-transport`](./packages/exchange/transports/webrtc) | WebRTC data channel transport for `@kyneta/exchange`. BYODC (Bring Your Own Data Channel) with `DataChannelLike` minimal interface. Binary CBOR encoding with transport-level fragmentation. | 27 |
| [`@kyneta/unix-socket-transport`](./packages/exchange/transports/unix-socket) | Unix domain socket transport for `@kyneta/exchange`. Stream-oriented, backpressure-aware server-to-server sync with no fragmentation. Client/server entry points. | 42 |

## Examples

| Example | Description |
|---------|-------------|
| [`bumper-cars`](./examples/bumper-cars) | Ephemeral presence demo — animated peers bouncing around a shared canvas |
| [`todo`](./examples/todo) | Minimal collaborative todo list with Exchange + Loro CRDT |
| [`todo-react`](./examples/todo-react) | React-based collaborative todo list with `@kyneta/react` bindings |
| [`unix-socket-sync`](./examples/unix-socket-sync) | Leaderless TUI config sync over unix sockets with Loro CRDT — N identical processes sharing state through a single socket path |

### Dependencies

```
@kyneta/schema                          (standalone — no runtime dependencies)
    │
    ├──► @kyneta/compiler               (+ ts-morph)
    │        │
    │        └──► @kyneta/cast          (+ unplugin)
    │
    ├──► @kyneta/exchange
    │        │
    │        ├──► @kyneta/wire          (+ tiny-cbor)
    │        │        │
    │        │        ├──► @kyneta/websocket-network-adapter
    │        │        ├──► @kyneta/sse-network-adapter
    │        │        ├──► @kyneta/webrtc-transport
    │        │        └──► @kyneta/unix-socket-transport
    │        │
    │        └──► @kyneta/react         (+ react)
    │
    ├──► @kyneta/loro-schema            (+ loro-crdt)
    └──► @kyneta/yjs-schema             (+ yjs)
```

`@kyneta/schema` is the foundational algebra — it defines the CHANGEFEED protocol, delta types, the interpreter algebra, and the `Substrate` interface. Everything else builds on it.

## Why Kyneta

**CRDTs already know what changed.** When you insert a character, the CRDT emits a delta saying exactly where. Traditional UI frameworks ignore this — they diff output to rediscover changes. Kyneta's compiler (Kinetic) transforms TypeScript into code that directly consumes these deltas, achieving O(k) DOM updates where k is the number of operations.

**Collaboration needs more than merge functions.** Traditional CRDTs couple state representation with merge logic. Kyneta's constraint engine (Prism) separates them: the semilattice moves to constraint sets (merge = set union), and a Datalog solver derives state. Conflict resolution strategies become rules that travel *inside* the data — change the rules, change reality, without touching the engine.

**Schemas should be walked once.** A schema tree gets traversed for serialization, validation, mutation, observation, and more — often 10+ parallel switch dispatches. Kyneta's schema algebra collapses them into one catamorphism with pluggable interpreters.

## Academic Foundations

- **DBSP** — Budiu, McSherry, Ryzhyk & Tannen. Algebraic incremental view maintenance via Z-sets, integration, and differentiation operators. Foundation for the incremental pipeline.
- **Concurrent Constraint Programming** — Saraswat, 1993. The theoretical ancestor of constraint-based CRDTs.
- **CRDTs** — Shapiro, Preguiça, Baquero & Zawirski, 2011. Conflict-free Replicated Data Types.
- **Fugue** — Weidner & Kleppmann, 2023. A sequence CRDT with optimal performance, expressed as Datalog rules in Prism.
- **CALM Theorem** — Hellerstein, 2010. Consistency as logical monotonicity — monotonic programs are eventually consistent without coordination.
- **Datalog** — Ullman, 1988; Apt, Blair & Walker, 1988. The query language powering Prism's solver.

## Getting Started

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Run tests for a specific package
cd packages/schema && pnpm test
```

## Project Status

The core ideas are validated with 3,300+ tests across the monorepo. See each package's README for detailed status:
- [Kinetic status](./packages/cast/README.md#prototype-status)
- [Schema status](./packages/schema/README.md)

## License

MIT — see [LICENSE](./LICENSE).

| Package | License |
|---------|---------|
| `@kyneta/schema` | MIT |
| `@kyneta/compiler` | MIT |
| `@kyneta/cast` | MIT |
| `@kyneta/exchange` | MIT |
| `@kyneta/react` | MIT |
| `@kyneta/loro-schema` | MIT |
| `@kyneta/yjs-schema` | MIT |
| `@kyneta/wire` | MIT |
| `@kyneta/websocket-network-adapter` | MIT |
| `@kyneta/sse-network-adapter` | MIT |
| `@kyneta/webrtc-transport` | MIT |
| `@kyneta/unix-socket-transport` | MIT |