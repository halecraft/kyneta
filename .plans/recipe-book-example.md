# Plan: Recipe Book — Best-Practices Example App

## Background

`@kyneta/core` is a compiled delta-driven web framework powered by the `CHANGEFEED` protocol from `@kyneta/schema`. The framework has 844 tests passing across 28 files, a multi-phase compiler pipeline, five region types for O(k) DOM updates, SSR with hydration, a Vite plugin, and a well-defined component model. However, there is no working example app in the repository — the prior `kinetic-todo` example lived in the old `loro-extended` monorepo and was not carried over during the Loro decoupling.

The monorepo's `pnpm-workspace.yaml` defines two workspace globs: `examples/*` and `packages/*`. The example belongs at `examples/recipe-book/` (monorepo root level), not nested under `packages/core/`. This matches the workspace convention and the prior `kinetic-todo`'s location at `loro-extended/examples/kinetic-todo/`.

Both Bun and Node are supported runtimes. The example's server uses only `node:http` and `node:path` (both available in Bun's Node compatibility layer). The dev script uses `tsx` for Node; Bun can run the TypeScript server file directly.

The prior `kinetic-todo` example (at `loro-extended/examples/kinetic-todo`) established a proven architecture:

- **Vite in middleware mode** — custom HTTP server embeds Vite as Connect middleware
- **Dual compilation** — same `app.ts` compiled to DOM (client) and HTML (server) via the Vite plugin's `ssr` flag detection
- **`createApp(doc)` factory** — pure builder function that doesn't own the document lifecycle; server and client both call it with their own doc instance
- **Component extraction** — `TodoItem` (props-based) and `TodoHeader` (closure-based) in separate files
- **`tsx src/server.ts`** as the dev command — runs the SSR server which embeds Vite middleware

That example depended heavily on Loro (`loro-crdt`, `@loro-extended/repo`, `@loro-extended/change`, WebSocket sync, LevelDB storage). The new example replaces all of that with `@kyneta/schema`'s pure interpreter algebra — no CRDT runtime, no WebSocket, no storage adapter. The data layer is a plain JS store interpreted through the schema composition pipeline.

`@kyneta/schema` has its own `packages/schema/example/` with a 722-line `main.ts` demonstrating the schema algebra. It uses a "Facade + App" structure with numbered sections — a proven teaching format. The facade pattern (`createDoc`, `change`, `subscribe`) will be reused.

The framework's distinctive capability is the **delta-kind spectrum**: the same CHANGEFEED protocol carries `text` (surgical character patches), `sequence` (O(k) list ops), `replace` (whole-value swap), and `increment` (counter delta), and the compiler maps each to the optimal DOM region automatically. No existing example demonstrates this spectrum or the natural division between schema-backed document state and local UI state via `state()`.

During the Loro decoupling, `LocalRef` was refactored to use the callable pattern (`ref()` instead of `ref.get()`), aligning with schema's readable interpreter. The root `TECHNICAL.md` is stale (copied from the old `loro-extended` project — it describes a Proxy-based `.get()` API that no longer exists) and the `packages/core/README.md` still references the old `.get()` pattern in several places.

## Problem Statement

A developer encountering `@kyneta/core` has no runnable example to learn from. The integration tests demonstrate individual features in isolation but don't show how the pieces compose into a real application you can see in a browser. The documentation has stale `.get()` references from the pre-callable-ref era. The root `TECHNICAL.md` describes a different project entirely.

## Success Criteria

1. A **runnable** example app at `examples/recipe-book/` — `pnpm dev` starts a server showing a working app with SSR, on both Node and Bun
2. The example exercises every delta kind naturally (text, sequence, replace, increment)
3. The example demonstrates both schema-backed document state and `state()` local UI state with a clear, motivated boundary
4. The example includes both component flavors (props-based and closure-based)
5. A developer can poke at the app in dev mode — edit code, see HMR, interact with the UI
6. All stale `.get()` references in `packages/core/README.md` are updated to the callable pattern
7. The root `TECHNICAL.md` is replaced with project-appropriate content
8. `packages/core/TECHNICAL.md` documents new patterns introduced

## The Gap

| What exists | What's missing |
|---|---|
| Prior `kinetic-todo` at `loro-extended/examples/kinetic-todo/` | No example in this repo; old example depends on Loro |
| `packages/schema/example/` — schema algebra demo (not runnable in browser) | No browser-visible `@kyneta/core` example |
| `pnpm-workspace.yaml` has `examples/*` glob | No `examples/` directory exists yet |
| Vite plugin (`@kyneta/core/vite`) exists and works | No example wiring it up |
| SSR infrastructure (`renderToDocument`, `renderToString`) exists | No example demonstrating SSR |
| `README.md` documents the framework | Stale `.get()` references throughout |
| `packages/core/TECHNICAL.md` — detailed compiler/runtime docs | No "Example Architecture" section |
| Root `TECHNICAL.md` — old `loro-extended` docs | Irrelevant to current project |

## Phases

### Phase 0: Vite + SSR Scaffold 🔴

- **Task 0.1**: Create `examples/recipe-book/` directory (monorepo root — matches `pnpm-workspace.yaml` glob `examples/*`) 🔴
- **Task 0.2**: Create `package.json` — minimal, workspace-linked deps 🔴
- **Task 0.3**: Create `vite.config.ts` — Kinetic Vite plugin, no WASM/Loro plugins 🔴
- **Task 0.4**: Create `tsconfig.json` — ES2022, bundler resolution, DOM lib 🔴
- **Task 0.5**: Create `index.html` — minimal Vite entry shell 🔴
- **Task 0.6**: Create `src/server.ts` — Vite-in-middleware-mode SSR server (using only `node:http` and `node:path` for Bun+Node compatibility) 🔴

The scaffold follows the proven `kinetic-todo` pattern but strips Loro/WebSocket/LevelDB:

```json
// package.json — key fields only
{
  "name": "example-recipe-book",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx src/server.ts",
    "dev:bun": "bun src/server.ts"
  },
  "dependencies": {
    "@kyneta/core": "workspace:^",
    "@kyneta/schema": "workspace:^"
  },
  "devDependencies": {
    "@types/node": "^22",
    "tsx": "^4",
    "typescript": "^5.9",
    "vite": "^6"
  }
}
```

```typescript
// vite.config.ts
import kinetic from "@kyneta/core/vite"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [kinetic()],
})
```

`src/server.ts` follows the three-move pattern from `kinetic-todo`:

1. `createViteServer({ server: { middlewareMode: true } })` — Vite as middleware
2. `vite.ssrLoadModule('/src/app.ts')` — dual-compiles the app to HTML for SSR
3. Route split: `GET /` → SSR render; everything else → `vite.middlewares`

The server creates the document via the facade (`createDoc`), renders it to HTML via `renderToDocument`, and embeds a `<script type="module" src="/src/main.ts">` for client hydration. No WebSocket, no Loro repo, no storage — just schema-interpreted state.

The server uses only `node:http` and `node:path` — both available in Bun's Node compatibility layer. `tsx` handles TypeScript execution on Node; Bun runs `.ts` files natively. The `dev` script uses `tsx` (Node); `dev:bun` runs the same file directly via Bun. No conditional imports or runtime detection needed.

### Phase 1: Schema + Facade 🔴

- **Task 1.1**: Create `src/schema.ts` — `RecipeBookSchema` exercising all delta kinds 🔴
- **Task 1.2**: Create `src/facade.ts` — `createDoc`, `change`, `subscribe` thin wrappers 🔴
- **Task 1.3**: Create `src/types.ts` — typed document type alias (like `kinetic-todo`'s `TodoDoc`) 🔴

The schema definition determines which delta kinds the example can demonstrate:

```typescript
import { Schema, LoroSchema } from "@kyneta/schema"

export const RecipeBookSchema = LoroSchema.doc({
  title: LoroSchema.text(),                     // delta: text (surgical character patches)
  recipes: Schema.list(                          // delta: sequence (O(k) list ops)
    Schema.struct({
      name: LoroSchema.text(),                   // delta: text (within list items)
      vegetarian: LoroSchema.plain.boolean(),    // delta: replace (whole-value swap)
      ingredients: Schema.list(                  // delta: sequence (nested list)
        LoroSchema.plain.string(),
      ),
    }),
  ),
  favorites: LoroSchema.counter(),              // delta: increment
})
```

The Facade layer wraps schema algebra primitives into a developer-friendly API — thin functions, not a framework. This mirrors `packages/schema/example/main.ts` lines 66–192. The facade composes:

```
enrich(withMutation(readableInterpreter), withChangefeed)
```

With context stack: `store → createWritableContext → createChangefeedContext`.

Key facade exports:
- `createDoc(schema, seed?)` → typed, writable, observable document
- `change(doc, fn)` → batched mutations with `changefeedFlush`
- `subscribe(ref, callback)` → changefeed subscription wrapper

### Phase 2: App + Components 🔴

- **Task 2.1**: Create `src/app.ts` — main builder with numbered sections and teaching comments 🔴
- **Task 2.2**: Create `src/components/ingredient-item.ts` — minimal props-based component 🔴
- **Task 2.3**: Create `src/components/recipe-card.ts` — props-based with nested list + conditional 🔴
- **Task 2.4**: Create `src/components/toolbar.ts` — closure-based, captures local state 🔴
- **Task 2.5**: Create `src/main.ts` — client entry point (`mount()`) 🔴

`src/app.ts` exports a `createApp(doc)` factory following the `kinetic-todo` pattern — a pure builder function that doesn't own the document lifecycle. Server and client both call it with their own doc instance.

`app.ts` structure (numbered sections):

| Section | What it demonstrates | Framework features |
|---|---|---|
| 1. Imports & Doc Type | Schema type, component imports | Module organization pattern |
| 2. Local UI State | `state("")` for filter, `state(false)` for veggie toggle | `state()`, callable LocalRef, replace semantics |
| 3. Helper Functions | `addRecipe()`, `removeRecipe()`, `addIngredient()` | Mutations on text, sequence, counter refs |
| 4. The App Builder | Top-level `div(() => { ... })` composing everything | `h1(doc.title)` bare ref → `textRegion`, counter display, list of RecipeCards, empty-state conditional, toolbar |

Components live in `src/components/` (separate files, like `kinetic-todo`'s `todo-item.ts` / `todo-header.ts`):

| Component | Flavor | Key patterns |
|---|---|---|
| `IngredientItem` | Props-based `(props: { text, onRemove }) => Element` | Minimal component, event handler prop |
| `RecipeCard` | Props-based `(props: { recipe, onRemove, onFavorite }) => Element` | `for...of` → listRegion (ingredients), `if` → conditionalRegion (vegetarian badge), bare text ref (recipe name) |
| `Toolbar` | Closure-based `() => Element` (closes over doc + local state) | `state()` in component scope, input binding, filter logic |

`src/main.ts` is the client entry point — calls `createApp(doc)`, mounts to `#root`. For this example (no collaboration/persistence), the client creates its own doc with seed data.

Each section opens with a comment block explaining what it demonstrates and why.

### Phase 3: Documentation 🔴

- **Task 3.1**: Write `examples/recipe-book/README.md` — setup instructions (both Node and Bun), walkthrough, feature coverage matrix 🔴
- **Task 3.2**: Update `packages/core/README.md` — fix all stale `.get()` references to callable pattern, add link to example 🔴
- **Task 3.3**: Replace root `TECHNICAL.md` with project-appropriate content (monorepo overview, package descriptions, cross-package dependency graph) 🔴
- **Task 3.4**: Add "Example Architecture" section to `packages/core/TECHNICAL.md` documenting the Facade pattern, the `createApp(doc)` factory pattern, and the schema/local-state boundary as recommended practices 🔴

The example's `README.md` includes:
- Quick start for Node: `cd examples/recipe-book && pnpm install && pnpm dev`
- Quick start for Bun: `cd examples/recipe-book && bun install && bun run dev:bun`
- Architecture diagram: server.ts → Vite middleware → dual compilation → SSR + client hydration
- Feature coverage matrix mapping each UI element to the delta kind it exercises
- File-by-file walkthrough

### Phase 4: Verification 🔴

- **Task 4.1**: Add a lightweight integration test (`recipe-book.test.ts`) that imports schema + facade, creates a doc, performs mutations, and verifies changefeed notifications fire correctly 🔴
- **Task 4.2**: Run full `packages/core` test suite to verify no regressions 🔴
- **Task 4.3**: Manually verify `pnpm dev` starts the server and the app renders in browser (Node) 🔴
- **Task 4.4**: Manually verify `pnpm dev:bun` starts the server and the app renders in browser (Bun) 🔴

The integration test lives at `examples/recipe-book/recipe-book.test.ts`. It validates the schema → facade → changefeed pipeline without DOM. The example has `vitest` as a devDependency and its own test script.

```typescript
// Shape of the test — validates the facade, not DOM rendering
import { describe, it, expect } from "vitest"

// Test: createDoc returns callable refs with [CHANGEFEED]
// Test: text mutation fires TextChange
// Test: list push fires SequenceChange
// Test: counter increment fires IncrementChange
// Test: batched change() flushes atomically
// Test: boolean set fires ReplaceChange
```

## Transitive Effect Analysis

| Change | Direct impact | Transitive impact |
|---|---|---|
| New `examples/recipe-book/` with own `package.json` | Automatically a workspace member — `pnpm-workspace.yaml` already has `examples/*` glob | No workspace config change needed. `pnpm install` from monorepo root links workspace deps. |
| Vite plugin import `@kyneta/core/vite` | Needs `@kyneta/core` built (`dist/` must exist) | Must run `pnpm -C packages/schema build && pnpm -C packages/core build` before `pnpm dev` in the example — document in README |
| Schema import `@kyneta/schema` | Needs `@kyneta/schema` built | Same as above — schema must build first since core depends on it |
| `renderToDocument` import from `@kyneta/core/server` | Uses the server subpath export | Verify `packages/core/package.json` exports `./server` correctly (it does: `dist/server/index.js`) |
| `node:http` / `node:path` in server.ts | Must work on both Node and Bun | Bun supports `node:http` and `node:path` via its Node compatibility layer — no conditional imports needed |
| Example test file at `examples/recipe-book/recipe-book.test.ts` | Runs via the example's own `vitest` | Isolated from `packages/core`'s test suite — separate workspace package with its own vitest config |
| Updating `README.md` `.get()` → `()` | Documentation only | Developers following the README will use the callable pattern; compiler's `analyze.ts` already handles `ref()` on `LocalRef` (done in the callable-ref refactor) |
| Replacing root `TECHNICAL.md` | Documentation only | No code impact; old content describes a different project |
| Example uses `state()` with callable pattern | Exercises recently refactored `LocalRef` | Validates callable `LocalRef` in a realistic composition context |

## Resources for Implementation Context

These files should be loaded when implementing each phase:

**Phase 0 (Scaffold):**
- Prior `kinetic-todo` files (from `loro-extended` git at `75b37128`): `server.ts`, `vite.config.ts`, `package.json`, `index.html`, `tsconfig.json`, `main.ts` — the patterns to adapt (strip Loro/WebSocket/LevelDB, keep Vite middleware + SSR + dual compilation)
- `packages/core/src/vite/plugin.ts` — Vite plugin API and options
- `packages/core/src/server/render.ts` — `renderToDocument`, `renderToString` signatures
- `packages/core/src/runtime/mount.ts` — `mount()` signature

**Phase 1 (Schema + Facade):**
- `packages/schema/example/main.ts` — the Facade pattern to follow (lines 66–192)
- `packages/schema/src/schema.ts` — schema constructors (`Schema.list`, `Schema.struct`, etc.)
- `packages/schema/src/loro-schema.ts` — `LoroSchema.doc`, `LoroSchema.text`, `LoroSchema.counter`, `LoroSchema.plain`
- `packages/schema/src/interpreters/writable.ts` — `createWritableContext`, `withMutation`, ref interfaces
- `packages/schema/src/interpreters/with-changefeed.ts` — `createChangefeedContext`, `withChangefeed`, `changefeedFlush`
- `packages/schema/src/interpreters/readable.ts` — `readableInterpreter`
- `packages/schema/src/combinators.ts` — `enrich`
- `packages/schema/src/zero.ts` — `Zero.structural`

**Phase 2 (App + Components):**
- `packages/core/src/reactive/local-ref.ts` — `state()`, callable `LocalRef<T>` interface
- `packages/core/src/types.ts` — `ComponentFactory`, `Element`, `Builder`
- Prior `kinetic-todo` files (from `loro-extended` git at `75b37128`): `app.ts`, `todo-item.ts`, `todo-header.ts` — component patterns to adapt
- `packages/core/src/compiler/integration/components.test.ts` — component compilation patterns
- `packages/core/src/compiler/integration/combined.test.ts` — list + conditional + reactive composition
- `packages/core/src/compiler/integration/schema-ssr.test.ts` — real schema ref usage patterns
- `packages/core/TECHNICAL.md` — component model (L1242–1352), delta region algebra (L1387–1455)

**Phase 3 (Documentation):**
- `packages/core/README.md` — current content to update
- `TECHNICAL.md` (root) — current content to replace
- `packages/core/TECHNICAL.md` — add example architecture section
- `packages/schema/example/README.md` — README style to mirror

**Phase 4 (Verification):**
- `packages/core/vitest.config.ts` — test glob configuration
- `packages/schema/src/__tests__/with-changefeed.test.ts` — changefeed testing patterns

## File Inventory

New files:
```
examples/recipe-book/
  package.json             — Workspace-linked deps, "dev": "tsx src/server.ts", "dev:bun": "bun src/server.ts"
  vite.config.ts           — kinetic() plugin, nothing else
  tsconfig.json            — ES2022, bundler resolution, DOM lib
  index.html               — Minimal Vite entry shell (<div id="root">)
  src/
    schema.ts              — RecipeBookSchema definition
    facade.ts              — createDoc, change, subscribe thin wrappers
    types.ts               — Typed document type alias
    app.ts                 — createApp(doc) factory with teaching comments
    main.ts                — Client entry point (mount)
    server.ts              — Vite-in-middleware-mode SSR server (node:http — works on Bun and Node)
    components/
      ingredient-item.ts   — Minimal props-based component
      recipe-card.ts       — Props-based with nested list + conditional
      toolbar.ts           — Closure-based, captures local state
  recipe-book.test.ts      — Integration test (schema + facade pipeline)
  README.md                — Setup (Node + Bun), walkthrough, feature coverage matrix
```

Modified files:
- `packages/core/README.md` — fix `.get()` → `()`, add example link
- `TECHNICAL.md` (root) — replace with monorepo overview
- `packages/core/TECHNICAL.md` — add Example Architecture section

## Alternatives Considered

### Alternative: Source-level example only (no Vite, not runnable)

The schema example (`packages/schema/example/`) works well as a read-only teaching artifact. But `@kyneta/core` is a **visual** framework — its value proposition (surgical DOM updates, SSR, template cloning) is best understood by seeing it work in a browser. A developer should be able to `pnpm dev`, open the page, edit a recipe name, and watch only those characters update in the DOM. The delta-kind spectrum is far more convincing live than described in comments.

### Alternative: Use a Todo app instead of Recipe Book

A todo app is the minimal viable example but only exercises one list + one text field. The recipe book exercises the same patterns (list CRUD) while naturally requiring nested lists (ingredients), mixed delta kinds in one view, and a filter/search pattern that motivates local state. The marginal complexity is justified by the marginal teaching value.

### Alternative: Include Loro/WebSocket collaboration (like `kinetic-todo`)

The prior example's killer demo was two browser tabs collaborating in real-time. But that required `loro-crdt` (3MB WASM), `@loro-extended/repo`, `@loro-extended/adapter-websocket`, `@loro-extended/adapter-leveldb`, `ws`, `classic-level`, `vite-plugin-wasm`, and `vite-plugin-top-level-await`. This example's purpose is to teach `@kyneta/core` patterns, not the collaboration stack. The schema's pure store + interpreter algebra demonstrates the same reactive patterns without any CRDT runtime. Collaboration can be layered on later via a `@kyneta/loro` adapter package.

### Alternative: Skip the Facade layer and use schema primitives directly

Calling `enrich(withMutation(readableInterpreter), withChangefeed)` + `createChangefeedContext(createWritableContext(store))` in the app file would expose the full composition algebra but overwhelm a newcomer. The Facade pattern (proven by schema's example) provides a clean `createDoc(schema, seed)` entry point while the algebra remains visible one function call away. The facade file is ~60 lines — small enough to read in full, large enough to show the composition.

### Alternative: Inline components in `app.ts` (no `components/` directory)

The `kinetic-todo` example started with components inline and later extracted them to separate files (per the showcase plan). Separate files from the start are cleaner: they show the real import pattern, demonstrate that components are ordinary modules, and keep `app.ts` focused on composition rather than component definitions.

### Alternative: Node-only or Bun-only server

The prior `kinetic-todo` used `tsx` (Node) but had `bun-types` in devDependencies, suggesting Bun intent. Since both runtimes are in use, the server uses only `node:http` and `node:path` — available in both via Bun's Node compatibility layer. Two dev scripts (`dev` for Node via `tsx`, `dev:bun` for Bun direct) is simpler than runtime detection or a wrapper script. No Bun-specific APIs are used; no `bun-types` needed.