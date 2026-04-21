# Kyneta — Technical Reference

> **Monorepo**: kyneta
> **Packages**: 15 stable + 3 experimental + 1 internal
> **Source lines**: ~76,000 (excluding tests)
> **Test lines**: ~109,000
> **Total tests**: 6,087 passed + 16 skipped across 18 packages
> **Build**: `pnpm install && pnpm build`
> **Verify**: `pnpm verify` (format → types → logic)
> **Runtime**: TypeScript 5.9+; Bun 1.3+ or Node 22+; supports browser, Bun, and Node runtimes

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the 30,000-foot design — thesis, principles, package roles, dependency flow, and the end-to-end todo vertical slice. This document is the factual reference: per-package summaries, test counts, build commands, and workspace tree.

---

## Questions this document answers

- What does each package do, in one paragraph? → [Packages](#packages)
- How do I build and verify? → [Development](#development)
- What's in `examples/`? → [Examples](#examples)
- Where does each package live? → [Workspace structure](#workspace-structure)
- Why Loro, and how does kyneta relate to it? → [Relationship to Loro](#relationship-to-loro)
- How many tests does the project have, per package? → [Canonical test counts](#canonical-test-counts)

## Canonical test counts

Every test count in every per-package `TECHNICAL.md` agrees with this table. Run dates: 2026-04-20.

| Package | Passed | Skipped | Files |
|---------|-------:|--------:|------:|
| `@kyneta/changefeed` | 47 | 0 | 2 |
| `@kyneta/machine` | 45 | 0 | 2 |
| `@kyneta/schema` | 1,901 | 8 | 59 |
| `@kyneta/loro-schema` | 201 | 4 | 11 |
| `@kyneta/yjs-schema` | 217 | 4 | 9 |
| `@kyneta/transport` | 8 | 0 | 1 |
| `@kyneta/wire` | 233 | 0 | 9 |
| `@kyneta/websocket-transport` | 56 | 0 | 2 |
| `@kyneta/sse-transport` | 44 | 0 | 3 |
| `@kyneta/webrtc-transport` | 27 | 0 | 2 |
| `@kyneta/unix-socket-transport` | 82 | 0 | 5 |
| `@kyneta/leveldb-store` | 34 | 0 | 1 |
| `@kyneta/indexeddb-store` | 23 | 0 | 1 |
| `@kyneta/exchange` | 449 | 0 | 17 |
| `@kyneta/index` | 143 | 0 | 8 |
| `@kyneta/react` | 84 | 0 | 7 |
| `@kyneta/compiler` (exp.) | 547 | 0 | 13 |
| `@kyneta/cast` (exp.) | 634 | 0 | 27 |
| `@kyneta/perspective` (exp., private) | 1,374 | 0 | 35 |
| **Total** | **6,149** | **16** | **214** |

Two additional test suites live outside the main package graph:
- `tests/exchange-websocket` — E2E WebSocket sync over `bun test` (separate runtime).
- `examples/bumper-cars` — integration suite exercising the full ephemeral + collaborative sync stack.

---

## Packages

### Core (tier-0)

**`@kyneta/changefeed`** — The universal reactive contract. One symbol (`CHANGEFEED`), one coalgebra (`{ current, subscribe }`), one batch envelope (`Changeset<C>`). Every reactive value in Kyneta — schema refs, `LocalRef`, `ReactiveMap`, `Collection`, `SecondaryIndex`, `exchange.peers`, `exchange.documents` — implements it. Zero runtime dependencies. 47 tests. → `packages/changefeed/TECHNICAL.md`.

**`@kyneta/machine`** — Pure Mealy-machine algebra. `Program<Msg, Model, Fx>` is a value with `init` + `update` + optional `done`; two runtimes (`runtime` for closure effects, `createObservableProgram` for data effects) interpret it. Used by every exchange transport for connection lifecycle and by the exchange itself for its session + sync programs. Zero runtime dependencies. 45 tests. → `packages/machine/TECHNICAL.md`.

### Schema + substrates

**`@kyneta/schema`** — The algebraic core. One recursive grammar (`Schema` with eleven `[KIND]` values: five structural + six CRDT), a reactive observation surface (`[CHANGEFEED]` on every ref, composed changefeeds for composites), a substrate/replica boundary (five-method interface), a six-layer interpreter stack (navigation → readable → addressing → caching → writable → observation), a migration system that derives content-addressed identity, a position algebra for cursor stability, and a plain substrate reference implementation. Composition-law compatibility is enforced at compile time via `bind()` and phantom `[LAWS]` brands. Four named binding targets (`json`, `ephemeral`, `loro`, `yjs`) each bundle a substrate factory, a `SyncProtocol`, and a closed set of allowed laws — no strategy parameter. Depends on `@kyneta/changefeed`. 1,901 + 8 skipped tests across 59 files. → `packages/schema/TECHNICAL.md`.

**`@kyneta/loro-schema`** — Loro CRDT substrate. Wraps a `LoroDoc` as `Substrate<LoroVersion>` with live navigation, `applyDiff`-based writes, identity-keyed containers for cross-schema sync, and a persistent `doc.subscribe()` event bridge. `LoroLaws = "lww" | "additive" | "positional-ot" | "positional-ot-move" | "lww-per-key" | "tree-move" | "lww-tag-replaced"`. Peer deps: `@kyneta/schema`, `@kyneta/changefeed`, `loro-crdt`. 201 + 4 skipped tests. → `packages/schema/backends/loro/TECHNICAL.md`.

**`@kyneta/yjs-schema`** — Yjs CRDT substrate. Wraps a `Y.Doc` as `Substrate<YjsVersion>` with a single-root-`Y.Map` design, `instanceof` container discrimination, imperative writes inside `Y.transact`, identity-keyed containers, and a persistent `observeDeep` event bridge. `YjsLaws = "lww" | "positional-ot" | "lww-per-key" | "lww-tag-replaced"`. Peer deps: `@kyneta/schema`, `@kyneta/changefeed`, `yjs`. 217 + 4 skipped tests. → `packages/schema/backends/yjs/TECHNICAL.md`.

### Transport + wire

**`@kyneta/transport`** — Abstract transport contract. `abstract class Transport<G>`, channel lifecycle (`Generated → Connected → Established`), six-message protocol vocabulary (two lifecycle — `establish`, `depart`; four sync — `present`, `interest`, `offer`, `dismiss`), identity types, and an in-process `Bridge` transport for testing. Peer deps: `@kyneta/machine`, `@kyneta/schema`. 8 tests. → `packages/transport/TECHNICAL.md`.

**`@kyneta/wire`** — Universal wire format. One `Frame<T>` abstraction (Complete or Fragment), two codecs (binary CBOR, text JSON), two framings (7-byte binary header, 2-char text prefix), fragmentation for cloud gateway limits, and a pure `feedBytes` stream-frame parser for stream-oriented transports. Internal CBOR encoder fixes a UTF-8 byte-length bug that plagued `@levischuck/tiny-cbor`. Peer dep: `@kyneta/transport`. 233 tests across 9 files. → `packages/exchange/wire/TECHNICAL.md`.

**`@kyneta/websocket-transport`** — WebSocket transport with three entry points (`./browser`, `./server`, `./bun`). Binary CBOR on the wire, a five-state TEA client lifecycle with a server-sent `"ready"` gate, and runtime-agnostic constructor injection (the `WebSocket` constructor is passed in; there is no `globalThis.WebSocket` default). Peer deps: `@kyneta/machine`, `@kyneta/transport`, `@kyneta/wire`. 56 tests. → `packages/exchange/transports/websocket/TECHNICAL.md`.

**`@kyneta/sse-transport`** — Server-Sent Events transport — asymmetric transport (SSE downstream, HTTP POST upstream), symmetric text wire format. Framework-agnostic via the `sendFn` pattern; ships a ready-made Express router. Four-state client lifecycle (no ready gate — `EventSource.onopen` fires only after the server is fully wired). Peer deps: `@kyneta/machine`, `@kyneta/transport`, `@kyneta/wire`. 44 tests. →
 `packages/exchange/transports/sse/TECHNICAL.md`.

**`@kyneta/webrtc-transport`** — BYODC (Bring Your Own Data Channel) transport. The application owns `RTCPeerConnection`, signalling, ICE, and media; this transport attaches to an already-established data channel for document sync via a five-member `DataChannelLike` contract. Default 200 KB fragmentation threshold (SCTP max message size). Peer deps: `@kyneta/transport`, `@kyneta/wire`. 27 tests. → `packages/exchange/transports/webrtc/TECHNICAL.md`.

**`@kyneta/unix-socket-transport`** — Unix-domain-socket transport for server-to-server sync. Stream-oriented framing via `feedBytes` (no gateway caps, no fragmentation). Two pure programs: a client lifecycle + a leaderless-peer negotiator that chooses listen-or-connect based on probing the socket path. Node + Bun wrappers. Peer deps: `@kyneta/machine`, `@kyneta/transport`, `@kyneta/wire`. 82 tests across 5 files. → `packages/exchange/transports/unix-socket/TECHNICAL.md`.

**`@kyneta/leveldb-store`** — LevelDB persistence backend. Implements the `Store` interface using `classic-level`. FoundationDB-style null-byte-separated key space; zero-padded monotonic `seqNo` per doc; binary envelope for `StoreRecord`; atomic `replace` via LevelDB batch. Peer deps: `@kyneta/exchange`, `@kyneta/schema`; runtime dep: `classic-level`. 34 tests. → `packages/exchange/stores/leveldb/TECHNICAL.md`.

**`@kyneta/indexeddb-store`** — IndexedDB persistence backend for browser-side storage. Implements the `Store` interface using the browser's native IndexedDB API. Two object stores (`meta`, `records`) with structured clone — no binary envelope, no key engineering. Auto-increment keys preserve insertion order; single `readwrite` transactions guarantee atomicity. Zero runtime dependencies. Peer deps: `@kyneta/exchange`, `@kyneta/schema`. 23 tests. → `packages/exchange/stores/indexeddb/TECHNICAL.md`.

### Exchange + reactive surface

**`@kyneta/exchange`** — Substrate-agnostic document sync runtime. Two pure TEA programs (session + sync) sharing one serialized dispatch queue, a `Synchronizer` shell, and an `Exchange` façade adding storage, governance (composable `Policy`), capability negotiation, reactive `peers` + `documents` collections, a `Line` primitive for reliable peer-to-peer message streams, and `persistentPeerId` for browser-tab-unique IDs via a `localStorage` CAS lease. Invariants: the exchange never inspects `SubstratePayload`; session never sees documents; sync never sees channels. Peer deps: `@kyneta/schema`, `@kyneta/changefeed`; direct dep: `@kyneta/transport`. 420 tests across 17 files. → `packages/exchange/TECHNICAL.md`.

**`@kyneta/index`** — DBSP-grounded reactive indexing over keyed collections. Three-layer pipeline: `Source<V>` (consumer-stateless delta producer) → `Collection<V>` (stateful ℐ integrator, *is* a `Changefeed`) → `SecondaryIndex` / `JoinIndex`. All internal algebra on ℤ-sets; `Source.flatMap` for bilinear composition; `Index.by` for grouping with reactive field-mutation watchers; `Index.join` for bilinear incremental joins. Five `Source` constructors (`create`, `fromRecord`, `fromList`, `fromExchange`, `of`). Dep: `@kyneta/changefeed`. 143 tests. → `packages/index/TECHNICAL.md`.

**`@kyneta/react`** — Thin React bindings. `ExchangeProvider` + `useExchange` for context; `useDocument` for ref access; `useValue` for reactive reads (with snapshot caching for referential stability); `useSyncStatus` for per-peer readiness; `useText` for uncontrolled `<input>` / `<textarea>` binding with selection-stable patching through remote edits. Two pure store factories (`createChangefeedStore`, `createSyncStore`) form the functional core; hooks are thin `useSyncExternalStore` wrappers. Text-adapter (`attach`, `diffText`, `transformSelection`) is framework-agnostic. Peer deps: `@kyneta/schema`, `@kyneta/changefeed`, `@kyneta/exchange`, `react` ≥ 18. 84 tests. → `packages/react/TECHNICAL.md`.

### Experimental

**`@kyneta/compiler`** — Target-agnostic incremental-view-maintenance compiler. Parses builder-pattern TypeScript, produces classified IR with `BindingTime` (`literal` / `render` / `reactive`), per-loop dependency classification (`structural` / `item` / `external`), filter-pattern detection, and IR→IR transforms (`dissolveConditionals`, `filterTargetBlocks`, `mergeSiblings`). Generator-based walker; template + hole extraction. Does not generate code — rendering targets consume the IR. Deps: `@kyneta/schema`, `@kyneta/changefeed`, `ts-morph`. 547 tests across 13 files. → `experimental/compiler/TECHNICAL.md`.

**`@kyneta/cast`** — Web rendering target for `@kyneta/compiler`. Compiled delta-driven UI framework. Runtime is five region primitives (`listRegion`, `filteredListRegion`, `conditionalRegion`, `textRegion`, `valueRegion`) + `mount` / `hydrate` / `scope` / `subscribe` — O(k) DOM updates per delta, no VDOM. Universal build plugin (`unplugin`) for Vite, Rollup, Rolldown, esbuild, Bun, Farm, webpack. Local reactive primitive (`state()` → `LocalRef<T>`). `inputTextRegion` for selection-stable text-input binding. Deps: `@kyneta/compiler`, `@kyneta/schema`, `@kyneta/changefeed`, `ts-morph`, `unplugin`. 634 tests across 27 files. → `experimental/cast/TECHNICAL.md`.

**`@kyneta/perspective`** — Standalone experimental package: Convergent Constraint Systems (CCS). Agents assert constraints; merge is set union; a stratified Datalog evaluator derives the shared reality. LWW and Fugue are Datalog rules that travel in the store — not hardcoded algorithms. Two-layer engine (Layer 0 kernel + Layer 1 Datalog evaluator), §B.7 native-solver fast paths, incremental pipeline with ℤ-set algebra for O(|Δ|) updates. Zero runtime dependencies, zero Kyneta dependencies. Private — not published to npm. 1,374 tests across 35 files. → `experimental/perspective/TECHNICAL.md`.

### Internal

**`@kyneta/bun-server`** (`internal/bun-server`) — Shared Bun build + static serving utility for examples. Not published. No dedicated TECHNICAL.md.

---

## Examples

**`examples/todo`** — Minimal vertical slice. Collaborative todo list using Loro + WebSocket + Cast. ~280 lines exercising ~10 packages end-to-end. Served by a Bun HTTP server with WebSocket upgrade; client bundles with `@kyneta/cast/unplugin/bun`. See [`ARCHITECTURE.md`](./ARCHITECTURE.md) → *Vertical slice* for the data flow.

**`examples/todo-react`** — Same collaborative todo list rendered with React + `@kyneta/react` instead of Cast. Proves substrate-and-rendering-target agnosticism. Uses Vite in middleware mode against a Node HTTP server.

**`examples/bumper-cars`** — Multi-peer ephemeral + collaborative hybrid. Per-peer input docs (ephemeral, LWW) drive shared game state (collaborative CRDT). Demonstrates `canShare` / `canAccept` policies restricting input-doc visibility to the owning peer, and server-only writes to game state.

**`examples/unix-socket-sync`** — Minimal demonstration of `createUnixSocketPeer` — two processes sharing a socket path, leaderless role negotiation, bidirectional sync.

---

## Development

### Build & verify

```bash
# install + build all packages
pnpm install
pnpm build

# full verify: format (biome) → types (tsc) → tests (vitest)
pnpm verify

# per-package
cd packages/schema && pnpm verify

# tests only
cd packages/schema && pnpm exec vitest run
```

`pnpm build` runs via turbo; it builds every package's `dist/` output using `tsdown` (migrated from `tsup` on 2026-04-19 — see `jj:rqqtpktt`). Build output is required for cross-package dependencies during development because `@kyneta/compiler` (and other consumers) resolve module types from `dist/*.d.ts`, not source.

### Turbo tasks

| Task | Runs |
|------|------|
| `build` | `tsdown` in every package |
| `verify` | `biome check` → `tsgo` (or `tsc`) → `vitest run` |
| `test` | `vitest run` (alias for `verify logic`) |
| `clean` | Remove `dist/` |

### Workspace scripts

`package.json` at the repo root exposes:

| Script | Behaviour |
|--------|-----------|
| `pnpm build` | `turbo run build` across all workspaces |
| `pnpm verify` | `turbo run verify` |
| `pnpm test` | `turbo run test` (same as `verify logic`) |

### Package manager

**pnpm is required.** Workspace references (`workspace:^`), peer-dep hoisting, and the `pnpm-workspace.yaml` glob configuration all assume pnpm. Bun and npm do not work for the monorepo build — use Bun to *run* published packages, but use pnpm for development here.

### Runtime

TypeScript 5.9 or newer (the `tsgo` preview compiler is used for dev-mode type checking where supported; `tsc` is the production check). Bun 1.3+ covers most runtime needs in examples and tests; Node 22+ is supported for consumers who prefer it. Node < 22 is unsupported.

---

## Workspace structure

```
kyneta/
├── ARCHITECTURE.md           # 30,000-foot system overview
├── TECHNICAL.md              # (this file) dense factual reference
├── README.md                 # public-facing entry point
├── CHANGELOG.md
├── LICENSE
├── biome.json                # formatter / linter config
├── package.json              # root scripts, turbo config
├── pnpm-workspace.yaml       # workspace glob config
├── pnpm-lock.yaml
├── turbo.json                # turbo task graph
│
├── packages/                 # published packages
│   ├── changefeed/           # @kyneta/changefeed
│   ├── machine/              # @kyneta/machine
│   ├── schema/               # @kyneta/schema
│   │   └── backends/
│   │       ├── loro/         # @kyneta/loro-schema
│   │       └── yjs/          # @kyneta/yjs-schema
│   ├── transport/            # @kyneta/transport
│   ├── exchange/             # @kyneta/exchange
│   │   ├── wire/             # @kyneta/wire
│   │   ├── transports/
│   │   │   ├── websocket/    # @kyneta/websocket-transport
│   │   │   ├── sse/          # @kyneta/sse-transport
│   │   │   ├── webrtc/       # @kyneta/webrtc-transport
│   │   │   └── unix-socket/  # @kyneta/unix-socket-transport
│   │   └── stores/
│   │       └── leveldb/      # @kyneta/leveldb-store
│   ├── index/                # @kyneta/index
│   └── react/                # @kyneta/react
│
├── experimental/             # experimental packages (public surface may shift)
│   ├── compiler/             # @kyneta/compiler
│   ├── cast/                 # @kyneta/cast
│   └── perspective/          # @kyneta/perspective (private)
│
├── examples/                 # runnable examples
│   ├── todo/                 # Loro + WebSocket + Cast
│   ├── todo-react/           # Loro + WebSocket + React
│   ├── bumper-cars/          # Ephemeral + collaborative hybrid
│   └── unix-socket-sync/     # createUnixSocketPeer demo
│
├── internal/                 # unpublished shared utilities
│   └── bun-server/           # shared Bun build + static serving for examples
│
├── tests/                    # cross-package test harnesses
│   └── exchange-websocket/   # E2E WebSocket sync via bun test
│
├── scripts/                  # build/release/maintenance scripts
├── papers/                   # drafts, notes, theory docs
└── .jj-plan/                 # plan documents for jj stack
```

---

## Relationship to Loro

Kyneta is deeply indebted to Loro. The `@kyneta/schema` interpreter algebra + substrate boundary owe their shape to what fits Loro cleanly; `@kyneta/loro-schema` is the reference CRDT substrate; the collaborative todo example uses Loro by default.

However, kyneta is **not** "a framework on top of Loro." Three things matter:

1. **Loro is one substrate among several.** `@kyneta/schema` factors state management + replication into an interface that four named binding targets — `json` (authoritative, serialized writer), `ephemeral` (LWW-only, transient), `loro`, and `yjs` — all implement. Each target bundles a substrate factory, a `SyncProtocol`, and a closed set of allowed composition laws. Applications pick per document.
2. **The grammar is backend-agnostic.** `@kyneta/schema`'s `Schema` type was derived by *collapsing* Loro's container/value split into one recursive grammar. First-class CRDT types (`text`, `counter`, `set`, `tree`, `movable`, `richtext`) are grammar nodes with `[LAWS]` phantom brands — not Loro-specific annotations. Each CRDT kind carries a composition law (`"additive"`, `"positional-ot"`, `"tree-move"`, etc.) describing how concurrent operations merge; `bind()` enforces at compile time that the target's law set covers every law the schema requires. A schema whose laws are a subset of `"lww" | "lww-per-key" | "lww-tag-replaced"` binds to any target; a schema containing `Schema.counter()` (law: `"additive"`) is rejected by `ephemeral` and `yjs` at the type level.
3. **The sync protocol is substrate-neutral.** The exchange's six-message protocol (`establish`, `depart`, `present`, `interest`, `offer`, `dismiss`) carries `SubstratePayload` blobs opaquely. Loro-specific concerns — version vectors, WASM discrimination via `.kind()`, `applyDiff`-based writes — are confined to `@kyneta/loro-schema`.

The practical consequence: Loro-backed documents and plain-JSON documents coexist in a single `Exchange`. A Yjs document synced over WebSocket and a Loro document synced over WebRTC are both just `DocRuntime`s to the synchronizer. Swapping substrates is a `bind()` change, not a framework migration.

---

## See also

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — thesis, design principles, system invariants, package roles, dependency flow, todo vertical slice.
- Each package's `TECHNICAL.md` — architecture, vocabulary, source-of-truth citations, file map.
- `.jj-plan/` — plan documents for active work.
- `papers/` — theory documents, design notes, and CCS specifications (for `@kyneta/perspective`).