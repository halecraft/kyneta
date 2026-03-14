# Plan: Recipe Book — Best-Practices Example App

## Background

`@kyneta/core` is a compiled delta-driven web framework powered by the `CHANGEFEED` protocol from `@kyneta/schema`. The framework has 844 tests passing across 28 files, a multi-phase compiler pipeline, five region types for O(k) DOM updates, SSR with hydration, a Vite plugin (via unplugin), and a well-defined component model. However, there is no working example app in the repository — the prior `kinetic-todo` example lived in the old `loro-extended` monorepo and was not carried over during the Loro decoupling.

The monorepo's `pnpm-workspace.yaml` defines two workspace globs: `examples/*` and `packages/*`. The example belongs at `examples/recipe-book/` (monorepo root level), not nested under `packages/core/`. This matches the workspace convention and the prior `kinetic-todo`'s location at `loro-extended/examples/kinetic-todo/`.

**Runtime**: Bun is the primary runtime. The server uses only `node:http`, `node:path`, and `ws` — all available in Bun's Node compatibility layer. Bun runs `.ts` files natively with no additional tooling. Node users can run the same server via `npx tsx src/server.ts` (documented in the README, not a primary script).

**Build tooling**: Vite serves as the dev server in middleware mode. This is not a casual choice — Vite is the only tool in the ecosystem that provides `ssrLoadModule`, which enables automatic dual compilation: the same `app.ts` is compiled to DOM code (client) and HTML code (server) without separate build configs or processes. The Kyneta compiler integrates via the unplugin-based Vite adapter at `@kyneta/core/vite`.

The prior `kinetic-todo` example established a proven architecture:

- **Vite in middleware mode** — custom HTTP server embeds Vite as Connect middleware
- **Dual compilation** — same `app.ts` compiled to DOM (client) and HTML (server) via the Vite plugin's `ssr` flag detection
- **`createApp(doc)` factory** — pure builder function that doesn't own the document lifecycle; server and client both call it with their own doc instance
- **Component extraction** — `TodoItem` (props-based) and `TodoHeader` (closure-based) in separate files
- **WebSocket sync** — two-tab collaboration via `@loro-extended/repo`
- **SSR state handoff** — server serialized a full Loro snapshot into `window.__KINETIC_STATE__`; client imported it for hydration

That example depended heavily on Loro (`loro-crdt`, `@loro-extended/repo`, `@loro-extended/change`, `@loro-extended/adapter-websocket`, `@loro-extended/adapter-leveldb`, `ws`, `classic-level`, `vite-plugin-wasm`, `vite-plugin-top-level-await`). The new example replaces all of that with `@kyneta/schema`'s pure interpreter algebra and a minimal frontier-based sync protocol — no CRDT runtime, no storage adapter, no WASM.

### The Sync Architecture: From Loro Snapshots to Frontier-Based Deltas

The old `kinetic-todo` shipped a full Loro document snapshot (binary, base64-encoded) alongside the SSR HTML — duplicating the data (once as rendered HTML, once as serialized state). This worked but was not parsimonious: the CRDT snapshot included operation history, version vectors, and peer IDs irrelevant to hydration, and the payload grew with document size regardless of what was visible.

Analysis of what hydration _actually_ requires reveals that the client needs document state for two reasons: (1) so reactive subscriptions read correct initial values, and (2) so `step(currentState, change)` has the right base when the first mutation arrives. But the _timing_ of state acquisition need not be immediate — the server-rendered HTML is already correct, and state can arrive asynchronously via the sync protocol.

The key mathematical insight: in the single-peer case (one server, no concurrent editing), a full CRDT version vector collapses to a **single monotonic integer** — the number of change batches applied since document creation. This integer is the **frontier**: a compact reference to "everything I've seen up to this point." Given two frontiers (client's and server's), the delta is computed by slicing the operation log — no full-state serialization needed.

The recipe book demonstrates this degenerate-but-complete sync protocol:

- The **facade** maintains a version counter and an append-only change log
- The **server** embeds only the version integer in the SSR HTML (not the full state)
- The **client** creates a doc from the same seed, connects via WebSocket, sends its version
- The **server** computes `delta(doc, clientVersion)` and pushes the missing operations
- **Two-tab sync** works: edits in one tab flow through the server to the other

This is the smallest working demonstration of frontier-based sync. The upgrade path is clear: the integer becomes a version vector, the plain store becomes a CRDT, and the `delta` function gains causal ordering — but the protocol shape, the WebSocket wiring, and the CHANGEFEED-driven DOM updates remain identical.

### Three-Flow SSR Architecture

The example demonstrates a principled decomposition of SSR data flows:

| Flow                  | Content                               | Size                                   | Timing                                      |
| --------------------- | ------------------------------------- | -------------------------------------- | ------------------------------------------- |
| **1. Rendered HTML**  | Visual projection of document state   | Proportional to _view_                 | Initial page payload                        |
| **2. Frontier**       | Version integer (the sync coordinate) | O(1) — a single number                 | Inline in HTML (meta tag or data attribute) |
| **3. Sync bootstrap** | Delta of operations since frontier    | Proportional to _changes since render_ | Async, post-hydration, via WebSocket        |

This replaces the old two-payload approach (HTML + full state blob) with a parsimonious architecture where the SSR payload is the HTML plus a single integer. Full document state arrives via the sync protocol after the page is interactive.

`@kyneta/schema` has its own `packages/schema/example/` with a 722-line `main.ts` demonstrating the schema algebra. It uses a "Facade + App" structure with numbered sections — a proven teaching format. The facade pattern (`createDoc`, `change`, `subscribe`) will be reused and extended with sync primitives (`version`, `delta`, `applyChanges`). Note: the library-level `change` and `applyChanges` now exist in `@kyneta/schema/src/facade.ts` — the recipe-book facade can import them directly rather than reimplementing.

The framework's distinctive capability is the **delta-kind spectrum**: the same CHANGEFEED protocol carries `text` (surgical character patches), `sequence` (O(k) list ops), `replace` (whole-value swap), and `increment` (counter delta), and the compiler maps each to the optimal DOM region automatically. No existing example demonstrates this spectrum or the natural division between schema-backed document state and local UI state via `state()`.

During the Loro decoupling, `LocalRef` was refactored to use the callable pattern (`ref()` instead of `ref.get()`), aligning with schema's readable interpreter. The `packages/core/README.md` still references the old `.get()` pattern in several places (specifically in the `state()` examples at L126–127 and client/server block examples at L142, L151). The `packages/schema/example/README.md` still references `@loro-extended/schema` in 4 places.

## Problem Statement

A developer encountering `@kyneta/core` has no runnable example to learn from. The integration tests demonstrate individual features in isolation but don't show how the pieces compose into a real application you can see in a browser — SSR, hydration, reactive updates, multi-tab sync. The documentation has stale `.get()` references from the pre-callable-ref era. There is no root-level `TECHNICAL.md` for the monorepo.

## Success Criteria

1. A **runnable** example app at `examples/recipe-book/` — `bun run dev` starts a server showing a working app with SSR
2. The example exercises every delta kind naturally (text, sequence, replace, increment)
3. The example demonstrates both schema-backed document state and `state()` local UI state with a clear, motivated boundary
4. The example includes both component flavors (props-based and closure-based)
5. A developer can open the app **in two tabs** and see edits sync between them via WebSocket
6. SSR payload is parsimonious — rendered HTML plus a version integer, no full-state serialization
7. A developer can poke at the app in dev mode — edit code, see HMR, interact with the UI
8. All stale `.get()` references in `packages/core/README.md` are updated to the callable pattern
9. Root `TECHNICAL.md` is created with project-appropriate content
10. `packages/core/TECHNICAL.md` documents the three-flow SSR architecture, frontier-based sync model, and example patterns

## The Gap

| What exists                                                                     | What's missing                                       |
| ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Prior `kinetic-todo` at `loro-extended/examples/kinetic-todo/`                  | No example in this repo; old example depends on Loro |
| `packages/schema/example/` — schema algebra demo (not runnable in browser)      | No browser-visible `@kyneta/core` example            |
| `pnpm-workspace.yaml` has `examples/*` glob                                     | No `examples/` directory exists yet                  |
| Vite plugin (`@kyneta/core/vite`, re-exported from unplugin) exists and works   | No example wiring it up                              |
| SSR infrastructure (`renderToDocument`, `renderToString`) exists                | No example demonstrating SSR                         |
| CHANGEFEED protocol carries typed deltas (`TextChange`, `SequenceChange`, etc.) | No sync protocol uses them for replication           |
| `step(state, change) → state` is a pure state transition function               | No operation log or version tracking exists          |
| `README.md` documents the framework                                             | Stale `.get()` references in `state()` examples      |
| `packages/core/TECHNICAL.md` — detailed compiler/runtime docs                   | No "Example Architecture" or sync model section      |
| No root `TECHNICAL.md`                                                          | Needed for monorepo overview                         |
| `packages/schema/example/README.md` references `@loro-extended/schema`          | Stale branding from pre-rename                       |

## Phases

### Phase 0: Vite + SSR + WebSocket Scaffold 🔴

- **Task 0.1**: Create `examples/recipe-book/` directory (monorepo root — matches `pnpm-workspace.yaml` glob `examples/*`) 🔴
- **Task 0.2**: Create `package.json` — Bun-primary, workspace-linked deps 🔴
- **Task 0.3**: Create `vite.config.ts` — Kyneta Vite plugin 🔴
- **Task 0.4**: Create `tsconfig.json` — ES2022, bundler resolution, DOM lib 🔴
- **Task 0.5**: Create `index.html` — minimal Vite entry shell 🔴
- **Task 0.6**: Create `src/server.ts` — Vite-in-middleware-mode SSR server with WebSocket sync endpoint 🔴
- **Task 0.7**: SSR smoke test — verify a minimal `div(() => { h1("hello") })` compiles and renders through the full SSR pipeline before writing components 🔴

The scaffold follows the proven `kinetic-todo` pattern but replaces Loro/Repo with a minimal frontier-based sync protocol:

```json
// package.json — key fields only
{
  "name": "example-recipe-book",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun src/server.ts"
  },
  "dependencies": {
    "@kyneta/core": "workspace:^",
    "@kyneta/schema": "workspace:^"
  },
  "devDependencies": {
    "@types/node": "^22",
    "typescript": "^5.9",
    "vite": "^6",
    "ws": "^8"
  }
}
```

Note: `tsx` is not needed — Bun runs TypeScript natively. Node users can install `tsx` independently and run `npx tsx src/server.ts` (documented in README).

```typescript
// vite.config.ts
import kyneta from "@kyneta/core/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [kyneta()],
});
```

The `@kyneta/core/vite` path re-exports from the unplugin Vite adapter. The canonical import for new consumers is `@kyneta/core/unplugin/vite`, but the `/vite` shorthand is supported and documented.

`src/server.ts` has four parts:

**Part 1: Vite dev server in middleware mode**

```
createViteServer({ root, server: { middlewareMode: true } })
```

**Part 2: SSR request handler**

```
GET / → acquireDoc() → vite.ssrLoadModule('/src/app.ts') → createApp(doc) → renderToDocument()
```

The server embeds the version integer in the HTML response:

```html
<meta name="kyneta-version" content="3" />
<script type="module" src="/src/main.ts"></script>
```

No `window.__KYNETA_STATE__` — the frontier replaces full-state serialization.

**Part 3: Vite middleware fallthrough**

```
All non-/ requests → vite.middlewares (serves client JS, assets, HMR)
```

**Part 4: WebSocket sync endpoint**

```
WebSocketServer on /ws:
  on connection:
    receive { type: "sync", version: N }
    compute delta(doc, N)
    send { type: "delta", ops: [...], version: currentVersion }
    track client's version for future pushes
  on message from client:
    applyChanges(doc, ops, { origin: "sync" }) → version increments
    broadcast delta to all OTHER connected clients
  on local doc change (from another client):
    push delta to this client
```

The WebSocket protocol has two message types:

| Direction       | Type    | Payload                                             |
| --------------- | ------- | --------------------------------------------------- |
| Client → Server | `sync`  | `{ type: "sync", version: number }`                 |
| Bidirectional   | `delta` | `{ type: "delta", ops: Change[], version: number }` |

The `sync` message is sent once on connection. The `delta` message flows in both directions: server → client for remote changes, client → server for local mutations.

**Task 0.7 (SSR smoke test)** is a risk-mitigation step. The full SSR chain — `vite.ssrLoadModule` → Kyneta plugin detects SSR → compiles to HTML target → `renderToDocument` — has not been tested end-to-end outside of unit tests. A minimal smoke test before Phase 2 prevents discovering compilation issues after 200 lines of component code are written.

### Phase 1: Schema + Facade with Sync Primitives 🔴

- **Task 1.1**: Create `src/schema.ts` — `RecipeBookSchema` exercising all delta kinds 🔴
- **Task 1.2**: Create `src/facade.ts` — `createDoc`, `subscribe` + sync primitives (`version`, `delta`). Import `change` and `applyChanges` from `@kyneta/schema`. 🔴
- **Task 1.3**: Create `src/seed.ts` — shared initial data, imported by both server and client 🔴
- **Task 1.4**: Create `src/types.ts` — typed document type alias 🔴

The schema definition determines which delta kinds the example can demonstrate:

```typescript
import { Schema, LoroSchema } from "@kyneta/schema";

export const RecipeBookSchema = LoroSchema.doc({
  title: LoroSchema.text(), // delta: text (surgical character patches)
  recipes: Schema.list(
    // delta: sequence (O(k) list ops)
    Schema.struct({
      name: LoroSchema.text(), // delta: text (within list items)
      vegetarian: LoroSchema.plain.boolean(), // delta: replace (whole-value swap)
      ingredients: Schema.list(
        // delta: sequence (nested list)
        LoroSchema.plain.string(),
      ),
    }),
  ),
  favorites: LoroSchema.counter(), // delta: increment
});
```

The Facade layer wraps schema algebra primitives into a developer-friendly API. This mirrors `packages/schema/example/main.ts` lines 66–192 and extends it with sync primitives. The facade composes:

```
withChangefeed(withWritable(withCaching(withReadable(bottomInterpreter))))
```

Or via the fluent API:

```
interpret(schema, ctx).with(readable).with(writable).with(changefeed).done()
```

With context: `createWritableContext(store)`.

The facade imports `change` and `applyChanges` directly from `@kyneta/schema` (they live in `src/facade.ts`). The recipe-book facade only needs to add `version`, `delta`, and `createDoc` on top. The public surface is ~5 functions; the implementation is ~80 lines.

#### Sync Primitives

The facade extends the schema example's `createDoc`/`change`/`subscribe` with three sync primitives:

```typescript
// Reading the frontier
version(doc)                    → number     // current version (monotonic integer)

// Computing deltas
delta(doc, fromVersion)         → PendingChange[]  // operations since fromVersion

// Applying remote deltas — uses library-level applyChanges from @kyneta/schema
applyChanges(doc, ops, { origin: "sync" })  → PendingChange[]  // apply, invalidate caches, notify
```

**Implementation**: The facade maintains two additional structures per document (stored alongside the existing `DOC_INTERNALS` symbol):

1. **Version counter** (`number`, starts at 0) — incremented on each flush cycle (both local mutations via `change()` and remote deltas via `applyChanges()`).

2. **Change log** (`Array<PendingChange>`) — appended during each flush. The log entries are `{ path: Path, change: ChangeBase }` — the same `PendingChange` type used by `change()` and `applyChanges()`.

`delta(doc, fromVersion)` returns `log.slice(fromVersion)` — the suffix of operations the caller hasn't seen. This is O(1) to compute (array slice) and O(k) in payload size where k is the number of missed operations.

Remote delta application uses the library-level `applyChanges(doc, ops, { origin: "sync" })` from `@kyneta/schema`. This calls `executeBatch` under the hood — `prepare` × N (cache invalidation + store mutation + notification accumulation) then `flush` × 1 (batched `Changeset` delivery to subscribers). The `origin: "sync"` option flows through to `Changeset.origin`, which the runtime's `inputTextRegion` uses for cursor management (local → move to end, remote → preserve position). The facade hooks into the flush cycle (via `subscribeTree` on the root) to append to the log and increment the version.

#### Seed Data

`src/seed.ts` exports the shared initial state:

```typescript
export const SEED = {
  title: "My Recipe Book",
  recipes: [
    {
      name: "Pasta Carbonara",
      vegetarian: false,
      ingredients: ["spaghetti", "eggs", "guanciale", "pecorino", "black pepper"],
    },
    {
      name: "Garden Stir Fry",
      vegetarian: true,
      ingredients: ["tofu", "broccoli", "bell pepper", "soy sauce", "rice"],
    },
  ],
  favorites: 0,
};
```

Both server and client import `SEED` and call `createDoc(RecipeBookSchema, SEED)`. In the zero-mutation case (no server-side changes before render), both start at version 0 from the same seed. The delta is empty. This is the degenerate frontier: both peers at genesis, nothing to sync.

#### Document Acquisition

Both server and client acquire documents through async functions that accommodate future backends:

```typescript
// Server: acquireDoc() → creates doc from seed
// Today: immediate (plain store from seed data)
// Future: load from storage, import snapshot, compute from frontier exchange
async function acquireDoc() {
  return createDoc(RecipeBookSchema, SEED);
}
```

```typescript
// Client: acquireDoc() → creates doc from seed, then syncs
// Today: creates from seed, WebSocket delivers delta
// Future: could receive delta from any SyncSource
async function acquireDoc() {
  return createDoc(RecipeBookSchema, SEED);
}
```

### Phase 2: App + Components 🔴

- **Task 2.1**: Create `src/app.ts` — main builder with numbered sections and teaching comments 🔴
- **Task 2.2**: Create `src/components/ingredient-item.ts` — minimal props-based component 🔴
- **Task 2.3**: Create `src/components/recipe-card.ts` — props-based with nested list + conditional 🔴
- **Task 2.4**: Create `src/components/toolbar.ts` — closure-based, captures local state 🔴
- **Task 2.5**: Create `src/main.ts` — client entry point with DOM adoption + WebSocket sync 🔴

`src/app.ts` exports a `createApp(doc)` factory following the `kinetic-todo` pattern — a pure builder function that doesn't own the document lifecycle. Server and client both call it with their own doc instance.

`app.ts` structure (numbered sections):

| Section               | What it demonstrates                                     | Framework features                                                                                              |
| --------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 1. Imports & Doc Type | Schema type, component imports                           | Module organization pattern                                                                                     |
| 2. Local UI State     | `state("")` for filter, `state(false)` for veggie toggle | `state()`, callable LocalRef, replace semantics                                                                 |
| 3. Helper Functions   | `addRecipe()`, `removeRecipe()`, `addIngredient()`       | Mutations on text, sequence, counter refs                                                                       |
| 4. The App Builder    | Top-level `div(() => { ... })` composing everything      | `h1(doc.title)` bare ref → `textRegion`, counter display, list of RecipeCards, empty-state conditional, toolbar |

Note on callable refs: the runtime reads schema refs via `read(ref)` (the type-safe helper from `@kyneta/core`) rather than direct `ref()` calls, because the `callable-refs.md` plan Phases 2–6 are still incomplete and TypeScript types don't fully express the callable nature. The compiler handles reactive detection via the CHANGEFEED protocol regardless.

Components live in `src/components/` (separate files, like `kinetic-todo`'s `todo-item.ts` / `todo-header.ts`):

| Component        | Flavor                                                             | Key patterns                                                                                                    |
| ---------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `IngredientItem` | Props-based `(props: { text, onRemove }) => Element`               | Minimal component, event handler prop                                                                           |
| `RecipeCard`     | Props-based `(props: { recipe, onRemove, onFavorite }) => Element` | `for...of` → listRegion (ingredients), `if` → conditionalRegion (vegetarian badge), bare text ref (recipe name) |
| `Toolbar`        | Closure-based `() => Element` (closes over doc + local state)      | `state()` in component scope, input binding, filter logic                                                       |

`src/main.ts` is the client entry point with three phases:

**Phase A: DOM adoption + doc creation**

```typescript
const doc = await acquireDoc(); // creates from seed, version 0
const app = createApp(doc);
mount(app, document.getElementById("root")!);
```

**Phase B: WebSocket sync**

```typescript
const ws = new WebSocket(`ws://${location.host}/ws`);

ws.onopen = () => {
  // Send our frontier: "I'm at version N"
  ws.send(JSON.stringify({ type: "sync", version: version(doc) }));
};

ws.onmessage = (event) => {
  const msg = JSON.parse(event.data);
  if (msg.type === "delta" && msg.ops.length > 0) {
    applyChanges(doc, msg.ops, { origin: "sync" });
    // Changeset fires → subscriptions fire → DOM patches surgically
  }
};
```

**Phase C: Local mutations → server**
The facade's `change()` function is wrapped (or a subscription is added) to also send local deltas to the server:

```typescript
// After a local change(doc, fn) call:
ws.send(JSON.stringify({ type: "delta", ops: localOps, version: version(doc) }));
```

The browser's native `WebSocket` API is used — no client library needed.

Each section opens with a comment block explaining what it demonstrates and why.

### Phase 3: Documentation 🔴

- **Task 3.1**: Write `examples/recipe-book/README.md` — setup instructions, architecture walkthrough, feature coverage matrix 🔴
- **Task 3.2**: Update `packages/core/README.md` — fix stale `.get()` references to callable pattern, add link to example 🔴
- **Task 3.3**: Create root `TECHNICAL.md` with project-appropriate content (monorepo overview, package descriptions, cross-package dependency graph) 🔴
- **Task 3.4**: Add "Example Architecture" section to `packages/core/TECHNICAL.md` documenting the three-flow SSR model, frontier-based sync, the `createApp(doc)` factory pattern, and the schema/local-state boundary as recommended practices 🔴
- **Task 3.5**: Fix stale `@loro-extended/schema` references in `packages/schema/example/README.md` and `packages/schema/example/main.ts` header comment 🔴

The example's `README.md` includes:

- Quick start: `cd examples/recipe-book && bun install && bun run dev`
- Alternative for Node: `cd examples/recipe-book && pnpm install && npx tsx src/server.ts`
- Architecture diagram: server.ts → Vite middleware → dual compilation → SSR + frontier → WebSocket sync
- Feature coverage matrix mapping each UI element to the delta kind it exercises
- File-by-file walkthrough
- "Open in two tabs" instructions demonstrating live sync

The `.get()` fixes in `packages/core/README.md` are specifically:

- L126–127: `count.get()` → `count()` in `state()` example
- L142, L151: `count.get()` → `count()` in client/server block examples

The TECHNICAL.md additions document:

**Three-flow SSR architecture:**

1. Rendered HTML (visual projection, proportional to view)
2. Frontier (version integer, O(1))
3. Sync bootstrap (delta of operations, async post-hydration)

**Frontier-based sync model:**

- Single-peer degenerate case: version vector → integer
- Upgrade path: integer → version vector → full CRDT
- The coalgebraic structure: `(S, V, δ)` where S is state, V is version (join-semilattice element), δ is the delta function

**Parsimony principle:**

- SSR payloads should be the minimal data needed for the rendered view
- Full document sync is a separate, async, post-hydration concern
- The old `kinetic-todo`'s full-snapshot approach (HTML + `__KINETIC_STATE__`) was expedient but not parsimonious

### Phase 4: Verification 🔴

- **Task 4.1**: Add a lightweight integration test (`recipe-book.test.ts`) that imports schema + facade, creates a doc, performs mutations, and verifies changefeed notifications fire correctly 🔴
- **Task 4.2**: Add sync primitive tests — `version()` increments, `delta()` returns correct suffix, `applyChanges()` reproduces state from seed 🔴
- **Task 4.3**: Run full `packages/core` test suite to verify no regressions 🔴
- **Task 4.4**: Manually verify `bun run dev` starts the server and the app renders in browser 🔴
- **Task 4.5**: Manually verify two-tab sync — open two tabs, edit in one, see update in the other 🔴
- **Task 4.6**: Manually verify SSR — view source shows server-rendered HTML with `<meta name="kyneta-version">`, no `__KYNETA_STATE__` blob 🔴

The integration test lives at `examples/recipe-book/recipe-book.test.ts`. It validates the schema → facade → changefeed → sync pipeline without DOM. The example has `vitest` as a devDependency and its own test script.

```typescript
// Shape of the test — validates facade + sync primitives
import { describe, it, expect } from "vitest";

// Facade basics:
// Test: createDoc returns callable refs with [CHANGEFEED]
// Test: text mutation fires TextChange
// Test: list push fires SequenceChange
// Test: counter increment fires IncrementChange
// Test: batched change() flushes atomically
// Test: boolean set fires ReplaceChange

// Sync primitives:
// Test: version(doc) starts at 0 for a seed-created doc
// Test: version(doc) increments on each change() call
// Test: delta(doc, 0) returns all operations since creation
// Test: delta(doc, version(doc)) returns empty array (up to date)
// Test: applyChanges on a fresh doc reproduces the state of the mutated doc
// Test: applyChanges fires changefeed notifications with origin "sync"
// Test: round-trip: create doc A from seed, mutate, delta(A, 0) → applyChanges on doc B → B matches A
```

## Transitive Effect Analysis

| Change                                                          | Direct impact                                                                          | Transitive impact                                                                                                                                    |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| New `examples/recipe-book/` with own `package.json`             | Automatically a workspace member — `pnpm-workspace.yaml` already has `examples/*` glob | No workspace config change needed. `pnpm install` from monorepo root links workspace deps.                                                           |
| Vite plugin import `@kyneta/core/vite`                          | Needs `@kyneta/core` built (`dist/` must exist)                                        | Must run `pnpm -C packages/schema build && pnpm -C packages/core build` before `bun run dev` in the example — document in README                     |
| Schema import `@kyneta/schema`                                  | Needs `@kyneta/schema` built                                                           | Same as above — schema must build first since core depends on it                                                                                     |
| `renderToDocument` import from `@kyneta/core/server`            | Uses the server subpath export                                                         | Verified: `packages/core/package.json` exports `./server` → `dist/server/index.js`                                                                   |
| `node:http` / `node:path` / `ws` in server.ts                   | Must work on Bun                                                                       | Bun supports `node:http` and `node:path` natively; `ws` works via Node compat layer                                                                  |
| WebSocket sync endpoint on `/ws`                                | New server capability                                                                  | No conflict with Vite's HMR WebSocket (Vite uses its own internal WS server in middleware mode)                                                      |
| Example test file at `examples/recipe-book/recipe-book.test.ts` | Runs via the example's own `vitest`                                                    | Isolated from `packages/core`'s test suite — separate workspace package with its own vitest config                                                   |
| Updating `README.md` `.get()` → `()`                            | Documentation only                                                                     | Developers following the README will use the callable pattern; compiler's `analyze.ts` already handles `ref()` on `LocalRef`                         |
| Creating root `TECHNICAL.md`                                    | Documentation only                                                                     | No code impact; fills a gap (no root-level TECHNICAL.md currently exists)                                                                            |
| Fixing `packages/schema/example/README.md`                      | Documentation only                                                                     | Corrects stale `@loro-extended/schema` references (4 occurrences)                                                                                    |
| Facade maintains version counter + change log                   | New state per document                                                                 | Minimal memory overhead; log grows linearly with mutations. For a demo app this is negligible. Production apps would bound the log via snapshotting. |
| `applyChanges` with `{ origin: "sync" }` fires changefeed      | `Changeset.origin` is `"sync"` (provenance on batch, not individual changes)           | `inputTextRegion` already distinguishes local vs remote via `origin` for cursor management                                                           |

## Resources for Implementation Context

These files should be loaded when implementing each phase:

**Phase 0 (Scaffold):**

- Prior `kinetic-todo` `server.ts` (from `loro-extended` git at `b959ace8`): the Vite middleware + SSR + WebSocket pattern to adapt
- `packages/core/src/vite/plugin.ts` — Vite plugin re-export from unplugin (`@kyneta/core/vite`)
- `packages/core/src/unplugin/index.ts` — unplugin factory, SSR target auto-detection in Vite escape hatch
- `packages/core/src/unplugin/adapters/vite.ts` — documented import: `import kyneta from "@kyneta/core/unplugin/vite"`
- `packages/core/src/server/render.ts` — `renderToDocument`, `renderToString` signatures
- `packages/core/src/runtime/mount.ts` — `mount()` signature

**Phase 1 (Schema + Facade + Sync):**

- `packages/schema/example/main.ts` — the Facade pattern to follow (lines 66–192: `createDoc`, `change`, `subscribe`)
- `packages/schema/src/schema.ts` — schema constructors (`Schema.list`, `Schema.struct`, etc.)
- `packages/schema/src/loro-schema.ts` — `LoroSchema.doc`, `LoroSchema.text`, `LoroSchema.counter`, `LoroSchema.plain.*`
- `packages/schema/src/interpreters/writable.ts` — `createWritableContext`, `withMutation`, ref interfaces
- `packages/schema/src/interpreters/with-changefeed.ts` — `createChangefeedContext`, `withChangefeed`, `changefeedFlush`
- `packages/schema/src/interpreters/readable.ts` — `readableInterpreter`
- `packages/schema/src/combinators.ts` — `enrich`
- `packages/schema/src/zero.ts` — `Zero.structural`, `Zero.overlay`
- `packages/schema/src/store.ts` — `applyChangeToStore`, `pathKey` (used by prepare pipeline)
- `packages/schema/src/facade.ts` — `change`, `applyChanges` (library-level API)
- `packages/schema/src/step.ts` — `step(state, change)` pure state transitions
- `packages/schema/src/change.ts` — `ChangeBase`, `TextChange`, `SequenceChange`, etc. (the `origin` field)

**Phase 2 (App + Components):**

- `packages/core/src/reactive/local-ref.ts` — `state()`, callable `LocalRef<T>` interface
- `packages/core/src/types.ts` — `ComponentFactory`, `Element`, `Builder`
- `packages/core/src/runtime/subscribe.ts` — `read()` helper (type-safe ref reading)
- Prior `kinetic-todo` `app.ts`, `main.ts` (from `loro-extended` git at `b959ace8`): component patterns to adapt
- `packages/core/src/compiler/integration/components.test.ts` — component compilation patterns
- `packages/core/src/compiler/integration/combined.test.ts` — list + conditional + reactive composition
- `packages/core/src/compiler/integration/schema-ssr.test.ts` — real schema ref usage patterns
- `packages/core/TECHNICAL.md` — component model (L1242–1352), delta region algebra (L1387–1455)

**Phase 3 (Documentation):**

- `packages/core/README.md` — current content to update (`.get()` at L126–127, L142, L151)
- `packages/core/TECHNICAL.md` — add example architecture section
- `packages/schema/example/README.md` — fix `@loro-extended` references (4 occurrences)
- `packages/schema/example/main.ts` — fix header comment `@loro-extended/schema` branding

**Phase 4 (Verification):**

- `packages/core/vitest.config.ts` — test glob configuration
- `packages/schema/src/__tests__/with-changefeed.test.ts` — changefeed testing patterns

## File Inventory

New files:

```
examples/recipe-book/
  package.json             — Workspace-linked deps, "dev": "bun src/server.ts"
  vite.config.ts           — kyneta() plugin
  tsconfig.json            — ES2022, bundler resolution, DOM lib
  index.html               — Minimal Vite entry shell (<div id="root">)
  src/
    schema.ts              — RecipeBookSchema definition (all delta kinds)
    seed.ts                — Shared initial data (imported by server + client)
    facade.ts              — createDoc, subscribe + version, delta (imports change/applyChanges from @kyneta/schema)
    types.ts               — Typed document type alias
    app.ts                 — createApp(doc) factory with teaching comments
    main.ts                — Client entry: DOM adoption + WebSocket sync
    server.ts              — Vite middleware + SSR (frontier in HTML) + WebSocket sync endpoint
    components/
      ingredient-item.ts   — Minimal props-based component
      recipe-card.ts       — Props-based with nested list + conditional
      toolbar.ts           — Closure-based, captures local state
  recipe-book.test.ts      — Integration test (facade + sync primitives)
  README.md                — Setup, architecture, feature matrix, two-tab sync instructions
```

Modified files:

- `packages/core/README.md` — fix `.get()` → `()` in state() examples, add example link
- `packages/core/TECHNICAL.md` — add three-flow SSR architecture, frontier-based sync model, example patterns
- `packages/schema/example/README.md` — fix `@loro-extended/schema` → `@kyneta/schema` (4 occurrences)
- `packages/schema/example/main.ts` — fix header comment branding

New files (root):

- `TECHNICAL.md` — monorepo overview, package descriptions, cross-package dependency graph

## Alternatives Considered

### Alternative: Source-level example only (no Vite, not runnable)

The schema example (`packages/schema/example/`) works well as a read-only teaching artifact. But `@kyneta/core` is a **visual** framework — its value proposition (surgical DOM updates, SSR, template cloning) is best understood by seeing it work in a browser. A developer should be able to `bun run dev`, open the page, edit a recipe name, and watch only those characters update in the DOM. The delta-kind spectrum is far more convincing live than described in comments.

### Alternative: Use a Todo app instead of Recipe Book

A todo app is the minimal viable example but only exercises one list + one text field. The recipe book exercises the same patterns (list CRUD) while naturally requiring nested lists (ingredients), mixed delta kinds in one view, and a filter/search pattern that motivates local state. The marginal complexity is justified by the marginal teaching value.

### Alternative: Serialize full state into SSR payload (like `kinetic-todo`)

The prior example shipped a full Loro document snapshot as `window.__KINETIC_STATE__` — duplicating the rendered HTML with a binary state blob. This was expedient for Loro (which needed CRDT history for sync), but analysis shows the duplication is unnecessary: hydration needs only DOM adoption + wiring, and full state acquisition can happen async via the sync protocol. The frontier-based approach ships O(1) metadata (a version integer) instead of O(state) data.

### Alternative: Skip WebSocket sync (seed-only, no live demo)

Without WebSocket sync, the example can't demonstrate multi-tab collaboration — the feature that made `kinetic-todo` compelling. The sync protocol adds ~40 lines to `server.ts` and ~15 lines to `main.ts`, and demonstrates that the CHANGEFEED protocol's typed deltas (`TextChange`, `SequenceChange`, etc.) are sufficient for replication, not just local reactivity. This is the key architectural insight the example teaches.

### Alternative: Use Bun.serve() instead of Vite middleware

Bun's `Bun.serve()` with HTML imports would eliminate Vite as a dependency. However, Bun's dev server explicitly lists SSR as a "Current Limitation" in its docs. Vite's `ssrLoadModule` is the only tool that provides automatic dual compilation (same source → DOM and HTML targets) in a single process. Farm was also evaluated but requires two separate build configs and two running processes for SSR. Vite is the pragmatic choice; Bun serves as the runtime executing the Vite-based server.

### Alternative: Skip the Facade layer and use schema primitives directly

Calling `enrich(withMutation(readableInterpreter), withChangefeed)` + `createChangefeedContext(createWritableContext(store))` in the app file would expose the full composition algebra but overwhelm a newcomer. The Facade pattern (proven by schema's example) provides a clean `createDoc(schema, seed)` entry point while the algebra remains visible one function call away. The facade file is ~100 lines — small enough to read in full, large enough to show the composition and the sync primitives.

### Alternative: Inline components in `app.ts` (no `components/` directory)

The `kinetic-todo` example started with components inline and later extracted them to separate files (per the showcase plan). Separate files from the start are cleaner: they show the real import pattern, demonstrate that components are ordinary modules, and keep `app.ts` focused on composition rather than component definitions.

### Alternative: Use full CRDT (Loro) for sync instead of integer versioning

The recipe book intentionally uses the degenerate single-peer case (version integer, not vector) to demonstrate the sync architecture at minimal complexity. This is an honest representation of what `@kyneta/schema`'s plain store can do today. The upgrade path to full CRDT sync (Loro, Perspective, or a future `@kyneta/sync`) is documented: the integer becomes a version vector, the plain store becomes a CRDT, `delta()` gains causal ordering, and everything else — the facade API, the WebSocket protocol, the CHANGEFEED subscriptions, the DOM patching — stays the same.
