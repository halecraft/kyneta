# Kyneta — Technical Overview

This monorepo contains the Kyneta framework: a compiled, delta-driven web framework powered by the CHANGEFEED protocol from `@kyneta/schema`, with substrate-agnostic CRDT synchronization via `@kyneta/exchange`.

## Packages

### `@kyneta/schema`

Schema interpreter algebra — pure structure, pluggable interpretations.

Defines a two-namespace grammar (`Schema` for backend-agnostic structure, `LoroSchema` for CRDT-annotated structure) and a fluent `interpret()` builder that composes a five-layer interpreter stack: bottom → navigation → readable → caching → writable → changefeed. The output is a typed `Ref<S>` handle — a callable, navigable, writable, observable document reference. A `Substrate` interface abstracts state management and transfer semantics, enabling different backing stores (plain JS objects, CRDTs) behind the same interpreter stack.

Zero runtime dependencies. 1,384 tests.

### `@kyneta/loro-schema`

Loro CRDT substrate for `@kyneta/schema`. Wraps a `LoroDoc` with schema-aware typed reads, `applyDiff`-based writes, and a persistent event bridge that observes all mutations regardless of source. Supports Loro-specific annotations: `text`, `counter`, `movableList`, `tree`.

97 tests.

### `@kyneta/yjs-schema`

Yjs CRDT substrate for `@kyneta/schema`. Wraps a `Y.Doc` with the same `Substrate` interface as the Loro backend — `exportSnapshot()`, `exportSince()`, `importDelta()`, `version()`. Deterministic `clientID` via FNV-1a hash of the exchange's string `peerId`.

123 tests.

### `@kyneta/compiler`

Target-agnostic incremental view maintenance compiler.

Takes TypeScript source with builder patterns over Changefeed-emitting state and produces a classified IR annotated with incremental strategies. Does not generate code for any specific rendering target — rendering targets (`@kyneta/cast`, future `@kyneta/native`, etc.) consume the IR and produce target-specific output.

Key subsystems:
- **Analysis** (`analyze.ts`) — AST → IR via ts-morph, reactive detection, expression classification
- **IR** (`ir.ts`) — types, factories, guards, merge algebra, slot computation
- **Walker & Template** (`walk.ts`, `template.ts`) — generator-based IR walker, template extraction + walk planning
- **Binding Scope** (`binding-scope.ts`) — dependency-tracked variable bindings
- **Classification** (`classify.ts`, `patterns.ts`) — dependency classification, filter pattern recognition
- **Transforms** (`transforms.ts`, optional `./transforms` subpath) — IR→IR pipeline transforms for rendering targets: `dissolveConditionals` (merge structurally-identical conditional branches into ternaries) and `filterTargetBlocks` (strip/unwrap labeled blocks by target)

547 tests.

### `@kyneta/cast`

Web rendering target — compiled delta-driven web framework.

Consumes annotated IR from `@kyneta/compiler` and produces DOM manipulation or HTML string generation (SSR). The compiler detects reactive refs via the `[CHANGEFEED]` protocol and the runtime emits delta-aware regions (`textRegion`, `listRegion`, `filteredListRegion`, `conditionalRegion`, `valueRegion`) that perform O(k) DOM updates where k is the number of operations in a delta.

Key subsystems:
- **Codegen** (`src/compiler/`) — IR → DOM/HTML code generation, transform orchestration
- **Runtime** (`src/runtime/`) — mount, scope lifecycle, delta regions, hydration
- **Unplugin** (`src/unplugin/`) — universal build plugin with adapters for Vite, Bun, Rollup, Rolldown, esbuild, Farm
- **Reactive** (`src/reactive/`) — `state()` local reactive primitive (`LocalRef<T>`)

634 tests.

### `@kyneta/exchange`

Transport-agnostic, substrate-agnostic, topology-flexible (p2p, server/client, etc) state exchange.

Manages document lifecycle, coordinates adapters, and synchronizes state across peers. Three merge strategies (causal, sequential, LWW) dispatched by a TEA (The Elm Architecture) state machine over a uniform five-message protocol (establish-request, establish-response, discover, interest, offer). Hosts heterogeneous documents — Loro CRDTs, Yjs CRDTs, plain JS objects, ephemeral presence — in one sync network.

Sub-packages:
- **`@kyneta/wire`** (`exchange/wire/`) — binary wire protocol. CBOR codec with compact field names, 6-byte binary frame headers, and a fragmentation protocol for cloud WebSocket gateways (AWS API Gateway 128KB limit, Cloudflare Workers 1MB limit). JSON codec for debugging. See `PROTOCOL.md` for the full specification. 122 tests.
- **`@kyneta/websocket-network-adapter`** (`exchange/network-adapters/websocket/`) — WebSocket network adapters. Client adapter (browser `WebSocket`), server adapter (abstract), and Bun-specific handlers (`createBunWebsocketHandlers`). Handles connection lifecycle, keepalive pings, ready signaling, and reconnection. 41 tests.

90 tests (+ 122 wire + 41 websocket-network-adapter).

### `@kyneta/perspective`

Convergent Constraint Systems — a constraint-based approach to CRDTs. Agents assert constraints, merge is set union, and a stratified Datalog evaluator derives shared reality. Includes an incremental pipeline based on DBSP for O(|Δ|) updates. Zero runtime dependencies. Independent of the core framework.

1,374 tests.

## Cross-Package Dependencies

```
@kyneta/schema                          (no runtime dependencies)
    │
    ├──► @kyneta/loro-schema            (+ loro-crdt)
    ├──► @kyneta/yjs-schema             (+ yjs)
    │
    ├──► @kyneta/compiler               (+ ts-morph)
    │        │
    │        └──► @kyneta/cast          (+ unplugin)
    │
    ├──► @kyneta/exchange
    │        ├──► @kyneta/wire          (+ tiny-cbor)
    │        └──► @kyneta/websocket-network-adapter
    │
    └──► @kyneta/perspective            (standalone, no @kyneta deps)
```

`@kyneta/schema` is the foundation — it defines the CHANGEFEED protocol, delta types, the interpreter algebra, and the `Substrate` interface. `@kyneta/loro-schema` and `@kyneta/yjs-schema` are CRDT substrate backends that implement `Substrate` for Loro and Yjs respectively. `@kyneta/compiler` is the intermediate layer — it produces target-agnostic annotated IR. `@kyneta/cast` is the web rendering target that consumes compiler IR and produces DOM/HTML output. `@kyneta/exchange` orchestrates sync via adapters and the synchronizer state machine; its sub-packages `@kyneta/wire` (binary encoding and framing) and `@kyneta/websocket-network-adapter` (WebSocket adapter pair) live under the exchange directory. The `/transforms` subpath (`@kyneta/compiler/transforms`) provides optional IR→IR pipeline transforms that rendering targets apply before codegen.

The `examples/todo` app exercises the full vertical slice:

```
@kyneta/schema → @kyneta/yjs-schema → @kyneta/exchange
→ @kyneta/websocket-network-adapter → @kyneta/cast → running app
```

## Key Concepts

### CHANGEFEED Protocol

The universal reactive interface. Any value with a `[CHANGEFEED]` symbol property participates in the observation protocol:

- `ref[CHANGEFEED].current` — read the current value
- `ref[CHANGEFEED].subscribe(cb)` — observe changes as `Changeset` batches

Schema-interpreted refs, `LocalRef<T>` from `state()`, and any custom reactive type can implement this protocol. The compiler's reactive detection checks for `[CHANGEFEED]` at the type level to determine which runtime region to emit.

### BoundSchema and Substrate Swapping

A `BoundSchema<S>` captures three choices that define a document type:

1. **Schema** — what shape is the data? (`Schema.doc({ ... })`)
2. **Factory** — how is the data stored and versioned? (`SubstrateFactory`)
3. **Strategy** — how does the exchange sync it? (`"causal"` | `"sequential"` | `"lww"`)

Convenience wrappers make this a one-liner:
- `bindLoro(schema)` — Loro CRDT substrate, causal merge
- `bindYjs(schema)` — Yjs CRDT substrate, causal merge
- `bindPlain(schema)` — plain JS substrate, sequential merge
- `bindEphemeral(schema)` — LWW substrate (TimestampVersion), ephemeral/presence state

Swapping CRDT backends is a one-import change. Everything downstream — the Exchange sync protocol, the Cast view, the WebSocket transport, the wire format — stays identical because they depend on the `Substrate` interface, not on any particular CRDT library.

### Auto-Read Insertion and the `()` Snapshot Convention

The compiler supports a **bare-ref developer experience**: developers write `recipe.name.toLowerCase()` and the compiler auto-inserts `()` reads at the ref/value boundary, emitting `recipe.name().toLowerCase()`. This is implemented via the `ExpressionIR` tree — a structured representation of expressions where `RefReadNode` renders as `source()` (the observation morphism).

- **Bare ref access**: `recipe.name.toLowerCase()` → compiler detects `recipe.name` is a changefeed, wraps in `RefReadNode`, renders as `recipe.name().toLowerCase()`
- **Explicit snapshot**: `recipe.name()` → developer writes `()` explicitly, compiler produces `SnapshotNode` — same rendering, distinct semantics (developer intent)
- **Binding expansion**: `const nameMatch = recipe.name.toLowerCase().includes(filterText.toLowerCase())` — the `nameMatch` binding carries its full expression tree. In reactive closures, the codegen expands the binding inline for self-contained re-evaluation from live refs.

The `reactive-view` type augmentations (`@kyneta/cast/types/reactive-view`) widen `TextRef extends String` and `CounterRef extends Number` so that value-type methods (`.toLowerCase()`, `.toFixed()`, etc.) are visible at the type level. `LocalRef<T> = Widen<T> & LocalRefBase<T>` gives the same widening via intersection. These are compile-time illusions — the compiler transforms the code before it runs.

### Delta Kinds

Four categories of structured change, each with a specialized runtime region:

| Delta Kind | Change Type | Runtime Region | DOM Strategy |
|------------|------------|----------------|-------------|
| **text** | `TextChange` (retain/insert/delete ops) | `textRegion` | Surgical `insertData`/`deleteData` on text nodes |
| **sequence** | `SequenceChange` (retain/insert/delete ops) | `listRegion` | O(1) `insertBefore`/`removeChild` per op |
| **sequence (filtered)** | `SequenceChange` + item/external refs | `filteredListRegion` | Separated subscription layers: external O(n), item O(1) |
| **replace** | `ReplaceChange` (whole-value swap) | `valueRegion` / `conditionalRegion` | Re-read and apply, or swap DOM branches |
| **increment** | `IncrementChange` (counter delta) | `valueRegion` | Re-read and apply |

### Interpreter Algebra

`@kyneta/schema`'s core abstraction. A schema is a recursive grammar; an interpreter is an F-algebra from schema nodes to runtime values. Interpreters compose via the fluent builder:

```
interpret(schema, ctx)
  .with(readable)     // adds callable () → value
  .with(writable)     // adds .set(), .push(), .insert(), etc.
  .with(changefeed)   // adds [CHANGEFEED] observation
  .done()             // → Ref<S>
```

Each `.with(layer)` wraps the previous result, adding capabilities. The type system tracks which capabilities are present via `Ref<S>` (full stack), `RWRef<S>` (read-write), and `RRef<S>` (read-only).

The Exchange builds the full interpreter stack automatically:

```
interpret(schema, substrate.context())
  .with(readable)
  .with(writable)
  .with(changefeed)
  .done()
```

### Exchange Sync Protocol

The Exchange coordinates sync between peers via a five-message protocol:

1. **establish-request / establish-response** — peer identity handshake
2. **discover** — announce document IDs available for sync
3. **interest** — request a specific document's state (with optional version for delta)
4. **offer** — deliver document state (snapshot or delta payload)

The synchronizer is a TEA state machine — pure model updates, command outputs. Three sync algorithms are dispatched by the `BoundSchema`'s merge strategy:
- **Causal**: bidirectional exchange, concurrent versions possible (Loro, Yjs)
- **Sequential**: request/response, total order (Plain)
- **LWW**: unidirectional push/broadcast, timestamp-based (ephemeral/presence)

Multi-hop relay: when the synchronizer imports a delta from peer A, it relays to all other synced peers (excluding A) via `buildRelayPush`.

### Functional Core / Imperative Shell

The runtime follows FC/IS throughout:
- **Functional core** — pure planning functions (`planInitialRender`, `planDeltaOps`, `planConditionalUpdate`) produce operation lists
- **Imperative shell** — `executeOp` applies operations to the DOM

This separation enables testing without a DOM and ensures the planning logic is independent of the rendering target.

## Examples

### `examples/todo`

Collaborative todo app — the full vertical slice proof. ~200 lines of application code (schema + view + client bootstrap + server) backed by ~40,000 lines of framework infrastructure across 7 packages. Real-time sync between browser tabs via WebSocket.

Demonstrates: Cast compiler (template cloning + reactive regions), Exchange sync protocol, Yjs CRDT substrate (swappable to Loro with one import change), Bun server with `Bun.build()` + unplugin, brotli pre-compression (59KB compressed bundle).

### `examples/recipe-book`

Full-stack SSR + sync example. Demonstrates Cast SSR (HTML string generation + hydration), all four delta kinds (text, sequence, replace, increment), `state()` for local reactive UI state, filtered list regions. Uses hand-rolled WebSocket sync (predates the Exchange).

18 integration tests.

## Development

### Build & Verification

The monorepo uses **Turborepo** for cross-package task orchestration with content-hash caching, and **@halecraft/verify** for intra-package verification pipelines.

```sh
# Build all packages in dependency order
pnpm build                              # alias for: turbo build

# Verify all main packages (format → types → logic)
pnpm verify                             # alias for: turbo verify --filter='!@kyneta/perspective'

# Test a single package (auto-builds upstream deps if stale)
npx turbo test --filter=@kyneta/cast    # builds schema + compiler first, then runs cast tests

# Verify perspective separately (opt-in, not in default pipeline)
npx turbo verify --filter=@kyneta/perspective
```

**Turbo tasks** (`turbo.json`):
- `build` — depends on `^build` (upstream builds), caches `dist/**`
- `verify` — depends on `^build`, runs the package's `verify` script
- `test` — depends on `^build`, runs the package's `test` script (which calls `verify logic`)

**Verify pipeline** (`verify.config.ts` in each package):
1. **format** — `biome check --write .` (auto-fixes formatting, reports lint issues)
2. **types** — `tsgo --noEmit --skipLibCheck` (fast Rust-based type checking)
3. **logic** — `vitest run` (unit + integration tests)

Each step depends on the previous: types won't run if format fails, logic won't run if types fail.

**Per-package test counts:**

| Package | Tests | Notes |
|---------|-------|-------|
| `@kyneta/schema` | 1,384 | Interpreter algebra, changefeeds, substrates, zero, step, validate |
| `@kyneta/loro-schema` | 97 | Loro substrate, change mapping, sync, event bridge |
| `@kyneta/yjs-schema` | 123 | Yjs substrate, change mapping, sync, version |
| `@kyneta/compiler` | 547 | AST analysis, ExpressionIR, reactive detection, classification, transforms |
| `@kyneta/cast` | 634 | Codegen, runtime regions, unplugin, integration tests |
| `@kyneta/exchange` | 90 | Synchronizer state machine, three merge strategies, multi-hop relay |
| `@kyneta/wire` | 122 | CBOR/JSON codecs, framing, fragmentation, reassembly |
| `@kyneta/websocket-network-adapter` | 41 | Client/server adapters, Bun handlers, connection lifecycle |
| `@kyneta/perspective` | 1,374 | CCS kernel, Datalog evaluator, incremental pipeline |
| `examples/recipe-book` | 18 | Full-stack SSR + sync integration |
| `tests/exchange-websocket` | 9 | End-to-end Exchange sync over real Bun WebSocket connections |
| **Total** | **4,439** | |

### Workspace Structure

```
kyneta/
├── packages/
│   ├── schema/                   @kyneta/schema
│   │   └── backends/
│   │       ├── loro/             @kyneta/loro-schema
│   │       └── yjs/              @kyneta/yjs-schema
│   ├── compiler/                 @kyneta/compiler
│   ├── cast/                     @kyneta/cast
│   ├── exchange/                 @kyneta/exchange
│   │   ├── wire/                 @kyneta/wire
│   │   └── network-adapters/
│   │       └── websocket/        @kyneta/websocket-network-adapter
│   └── perspective/              @kyneta/perspective
├── examples/
│   ├── todo/                     Collaborative todo (Cast + Exchange + Yjs)
│   └── recipe-book/              SSR + sync (Cast + hand-rolled WebSocket)
├── tests/
│   └── exchange-websocket/       E2E Exchange sync over real WebSockets
├── .plans/                       Long-term architectural plans
└── .jj-plan/                     Active jj change plans (gitignored)
```

Package manager: **pnpm** with workspace protocol (`workspace:^`).
Task runner: **Turborepo** for cross-package build/test orchestration.
Verification: **@halecraft/verify** for intra-package format → types → logic pipelines.
Linter/Formatter: **Biome** (root `biome.json`, 2-space indent, no semicolons).
Type checker: **tsgo** (`@typescript/native-preview`) — Rust-based TypeScript compiler for fast verification.
Runtime: **Bun** for scripts and CLI; **Vite** for dev server and build.
VCS: **jj** (Jujutsu).

## Relationship to Loro

Kyneta was originally developed as `@loro-extended/*` — a set of packages extending the [Loro](https://loro.dev/) CRDT framework. The architecture has since been decoupled:

- `@kyneta/schema` defines a **backend-agnostic** schema grammar (`Schema` namespace). The `LoroSchema` namespace adds Loro-specific annotations (`text`, `counter`, `movableList`, `tree`) via the annotation mechanism — these are markers that a Loro or Yjs backend interprets, but the interpreter algebra itself is pure.
- `@kyneta/loro-schema` and `@kyneta/yjs-schema` are peer substrate backends behind the same `Substrate` interface. The todo example demonstrates swapping between them with a one-line import change.
- `@kyneta/cast` consumes the CHANGEFEED protocol, which is defined in `@kyneta/schema` and has no CRDT dependency.
- `@kyneta/exchange` syncs documents via the `Substrate` interface — it never imports a CRDT library directly.
- Historical documents (`LEARNINGS.md`, `theory/interpreter-algebra.md`) retain `@loro-extended` references as they are factually accurate for their era.

The annotation mechanism (`Schema.annotated("text")`, `Schema.annotated("counter")`) is the bridge: it marks schema nodes with backend-specific semantics without coupling the grammar to any particular CRDT implementation.
