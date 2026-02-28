# Plan: Kinetic Todo — Real User-Facing Example

## Background

The Kinetic framework has a complete compiler pipeline, runtime, Vite plugin, and SSR infrastructure with 453 passing tests. However, the `examples/kinetic-todo` example **does not demonstrate the actual user experience**. Instead of using the Vite plugin to compile builder-pattern code, it contains hand-written "compiled output" that manually calls runtime primitives.

### Critical Discovery: Type Resolution Gap

During plan review, we discovered that the Kinetic compiler **cannot resolve types from `node_modules`** because it uses `useInMemoryFileSystem: true` in ts-morph. This means:

- Imports like `import { ListRef } from "@loro-extended/change"` resolve to `any`
- The `isReactiveType()` function fails to detect reactive types
- `for..of` loops don't become `__listRegion`, conditionals don't become `__conditionalRegion`
- **The compiler silently produces static DOM code instead of reactive code**

This was tested empirically: without type stubs, `doc.items` has type `any` and reactive detection returns `false`. With type stubs injected into the in-memory filesystem, types resolve correctly and reactive detection works.

From the example's own documentation:

> This simulates what the Kinetic compiler would generate for a todo app. It manually constructs DOM and wires up subscriptions using the runtime primitives, since the compiler is not yet integrated into a build pipeline.

This is misleading because the Vite plugin **is** functional and tested. The example fails to demonstrate:

1. Writing natural TypeScript with builder patterns (`div(() => { h1("...") })`)
2. Automatic compilation via Vite plugin
3. The dev workflow (edit source → see changes)
4. TypeScript LSP support for element factories

Additionally, the kinetic README status table claims "Vite plugin 🔴 Placeholder only" which is incorrect — the plugin is fully implemented with 7 test groups covering file filtering, in-place replacement, import handling, and error cases.

## Problem Statement

Users exploring Kinetic have no reference for how to actually use the framework. The current example:

- Shows what the compiler **produces**, not what users **write**
- Has no `vite.config.ts` demonstrating plugin setup
- Doesn't use the ambient type declarations (`div`, `h1`, etc.)
- Uses `bun run src/server.ts` directly instead of Vite

## Success Criteria

1. **Builder pattern source code** — Example contains `.ts` files with `div(() => { ... })` syntax
2. **Working Vite dev server** — `pnpm dev` starts Vite with automatic compilation
3. **TypeScript LSP support** — Editor shows proper types for element factories
4. **Client-side reactivity** — Adding/removing todos updates DOM via O(k) deltas
5. **Live collaboration** — Two browser tabs sync via Repo + WebSocket adapter
6. **SSR + Hydration** — Server renders initial HTML from the same `app.ts` via dual compilation, client hydrates
7. **Minimal boilerplate** — Example is easy to understand and copy

## The Gap

| Need | Current State | Solution |
|------|---------------|----------|
| Builder pattern code | Hand-written DOM calls | Write actual builder patterns |
| Vite integration | Bun server only | Add vite.config.ts with kinetic() |
| Type definitions | Not configured | Add typeRoots or triple-slash |
| Dev workflow | `bun run src/server.ts` | `pnpm dev` starts server with embedded Vite |
| Live sync | Standalone LoroDoc, no networking | Repo + WebSocket adapter |
| SSR | Hand-written `parts.push()` HTML | Same `app.ts` compiled to HTML via `vite.ssrLoadModule()` |
| Documentation | Explains "simulation" | Explains actual usage |

## Architecture

```
examples/kinetic-todo/
├── index.html              # Vite entry point
├── vite.config.ts          # Vite + kinetic plugin
├── tsconfig.json           # TypeScript with ambient types
├── package.json            # Scripts: dev, build, preview
├── src/
│   ├── schema.ts           # Shared Loro document schema (keep)
│   ├── app.ts              # Builder pattern code (NEW)
│   ├── main.ts             # Client entry: Repo + mount
│   └── server.ts           # Repo server: WS + LevelDB + Vite middleware
└── README.md               # Usage documentation
```

The killer demo: open two browser tabs → add a todo in one → see it appear in the other, with O(k) DOM updates and no diffing.

### How Repo Fits In

```
┌─────────────────────┐         ┌─────────────────────┐
│   Browser Tab A     │         │   Browser Tab B      │
│                     │         │                      │
│  Repo (client)      │         │  Repo (client)       │
│    ↕ WS adapter     │         │    ↕ WS adapter      │
│  Kinetic runtime    │         │  Kinetic runtime     │
│    (delta → DOM)    │         │    (delta → DOM)     │
└─────────┬───────────┘         └──────────┬───────────┘
          │         WebSocket              │
          └────────────┬───────────────────┘
                       │
          ┌────────────┴───────────────────┐
          │   Server                       │
          │   Repo (service)               │
          │     ↕ WS adapter               │
          │     ↕ LevelDB storage adapter  │
          └────────────────────────────────┘
```

The client never calls `new LoroDoc()` directly. Instead, `repo.get(docId, schema)` returns a `Doc` that is automatically synced. When another client pushes changes, Repo delivers Loro deltas to the document, and Kinetic's `__listRegion` / `__conditionalRegion` / `__subscribeWithValue` consume those deltas to update the DOM.

## Phases and Tasks

### Phase 0: Type Stub Injection (Prerequisite) ✅

The compiler must be able to resolve `@loro-extended/change` types for reactive detection to work. Without this phase, all subsequent phases will fail silently.

- ✅ **Task 0.1**: Create `packages/kinetic/src/compiler/type-stubs.ts`
  - Define minimal interface stubs for all Loro ref types
  - Include: `TextRef`, `CounterRef`, `ListRef<T>`, `MovableListRef<T>`, `RecordRef<T>`, `StructRef<T>`, `MapRef<K,V>`, `TreeRef<T>`, `PlainValueRef<T>`
  - Include minimal `Shape` builder stubs and `createTypedDoc<T>` signature
  - Export as a single string constant `LORO_CHANGE_TYPE_STUBS`
  - Stubs only need interface names and method signatures for type checking:
    ```typescript
    export const LORO_CHANGE_TYPE_STUBS = `
    export interface TextRef {
      toString(): string
      insert(pos: number, text: string): void
      delete(pos: number, len: number): void
    }
    export interface CounterRef {
      get(): number
      increment(delta?: number): void
      decrement(delta?: number): void
    }
    export interface ListRef<T> {
      toArray(): T[]
      push(item: T): void
      delete(index: number, len?: number): void
    }
    export interface MovableListRef<T> extends ListRef<T> {}
    export interface RecordRef<T> {}
    export interface StructRef<T> {}
    export interface MapRef<K, V> {}
    export interface TreeRef<T> {}
    export interface PlainValueRef<T> {
      get(): T
      set(value: T): void
    }
    export declare function createTypedDoc<T>(schema: T, options?: unknown): T
    export declare const Shape: {
      doc<T>(schema: T): T
      text(): TextRef
      counter(): CounterRef
      list<T>(itemShape: T): ListRef<T>
      plain: { string(): string; number(): number; boolean(): boolean }
    }
    `
    ```

- ✅ **Task 0.2**: Modify `packages/kinetic/src/compiler/transform.ts`
  - In `getProject()`, after creating the Project, inject type stubs:
    ```typescript
    project.createSourceFile(
      "node_modules/@loro-extended/change/index.d.ts",
      LORO_CHANGE_TYPE_STUBS
    )
    ```

- ✅ **Task 0.3**: Add test for type resolution with real imports
  - Create test in `packages/kinetic/src/compiler/transform.test.ts`
  - Verify that `import { ListRef } from "@loro-extended/change"` resolves correctly
  - Verify that `for (const item of doc.items)` produces `__listRegion` in output

### Phase 1: Delete and Scaffold ✅

- ✅ **Task 1.1**: Delete `examples/kinetic-todo/src/app.ts` (the hand-written "compiled" code)
- ✅ **Task 1.2**: Keep `examples/kinetic-todo/src/schema.ts` (already correct)
- ✅ **Task 1.3**: Create `examples/kinetic-todo/vite.config.ts` with kinetic plugin
- ✅ **Task 1.4**: Create `examples/kinetic-todo/index.html` (Vite entry)
- ✅ **Task 1.5**: Update `examples/kinetic-todo/package.json` with Vite scripts and deps
  - Add devDependencies: `vite`, `vite-plugin-wasm`, `vite-plugin-top-level-await`
  - Update scripts: `dev` → `vite`, `build` → `vite build`, `preview` → `vite preview`
  - Keep `serve:ssr` → `bun run src/server.ts` for SSR demo
- ✅ **Task 1.6**: Update `examples/kinetic-todo/tsconfig.json` for ambient types
- ✅ **Task 1.7**: Add `./types/elements` export to `packages/kinetic/package.json`

### Phase 2: Builder Pattern Client Code ✅

- ✅ **Task 2.1**: Create `src/app.ts` with builder pattern code
  - Use `div`, `h1`, `ul`, `li`, `input`, `button` factories
  - Use `for..of` for todo list (compiles to `__listRegion`)
  - Use `if` for empty state (compiles to `__conditionalRegion`)
  - Use `bind()` for input binding
  - Export factory function for mounting

- ✅ **Task 2.2**: Create `src/main.ts` as client entry
  - Import from `@loro-extended/change` and `@loro-extended/kinetic`
  - Create LoroDoc and typed document
  - Call `mount()` with app factory

### Phase 3: Repo Integration + Live Collaboration + SSR ✅

Replace the standalone `LoroDoc` with `Repo` for server↔client sync, and add SSR using dual compilation. The same `app.ts` is compiled to DOM code for the client and HTML template literals for the server — no hand-written render functions, no duplication.

The complete flow:

1. Server starts Repo with LevelDB storage
2. Browser requests `/` → server calls `repo.get()` then `await sync(doc).waitForSync({ kind: "storage" })` to load persisted state → calls `vite.ssrLoadModule('/src/app.ts')` which compiles to HTML target automatically → renders fully-loaded doc to HTML with serialized Loro state
3. Client loads, Kinetic plugin compiles same `app.ts` to DOM target → deserializes embedded state into doc → hydrates existing DOM
4. Client Repo connects via WebSocket, deltas flow both directions with O(k) updates
5. Open second tab → same flow → both tabs collaborate in real-time

- ✅ **Task 3.1**: Refactor `src/app.ts` to accept `doc` as a parameter
  - Change from module-level `const doc = ...` to an exported function that receives `doc`
  - The function returns a builder call: `div({ class: "todo-app" }, () => { ... })`
  - Server calls it → gets HTML render function. Client calls it → gets DOM factory.
  - Helper functions (`addTodo`, `removeTodo`) move inside or accept `doc` as closure

- ✅ **Task 3.2**: Rewrite `src/server.ts` with Repo + SSR + Vite middleware
  - Create `Repo` with `WsServerNetworkAdapter` + `LevelDBStorageAdapter`
  - Create HTTP server with Vite dev middleware (follows `todo-websocket` pattern)
  - Attach `WebSocketServer` to the HTTP server
  - Seed initial data only if document doesn't exist in storage
  - On `GET /`:
    - `const doc = repo.get("kinetic-todo", TodoSchema)`
    - `await sync(doc).waitForSync({ kind: "storage" })` — **critical**: waits for LevelDB to load persisted state before rendering, otherwise the doc is empty
    - Load `app.ts` via `vite.ssrLoadModule()` (compiled to HTML target automatically)
    - Call the app function with the fully-loaded doc to get an HTML render function
    - Execute render function, wrap with `renderToDocument()` + `generateStateScript()`
  - All other requests fall through to Vite middleware (serves client JS, assets, etc.)

- ✅ **Task 3.3**: Rewrite `src/main.ts` with client-side Repo + hydration
  - Create `Repo` with `WsClientNetworkAdapter` pointing to `ws://${location.host}/ws`
  - `repo.get("kinetic-todo", TodoSchema)` to get a synced `Doc`
  - Import `createApp` from `./app.ts` (compiled to DOM target by Vite plugin)
  - If SSR state exists on `window.__KINETIC_STATE__`:
    - Deserialize into the Doc (instant — no network wait needed for first paint)
    - Hydrate existing DOM with the compiled app factory
  - Otherwise, mount fresh (fallback for direct client-side navigation)
  - WebSocket sync connects in the background — subsequent deltas update the DOM via Kinetic's reactive runtime

- ✅ **Task 3.4**: Update `package.json` with Repo + adapter dependencies
  - Add: `@loro-extended/repo`, `@loro-extended/adapter-websocket`, `@loro-extended/adapter-leveldb`
  - Add: `ws`, `classic-level`
  - Update `dev` script to `tsx src/server.ts` (server embeds Vite, no separate Vite process)

### Phase 4: Documentation and Cleanup 🔴

- 🔴 **Task 4.1**: Rewrite `examples/kinetic-todo/README.md`
  - Explain the builder pattern
  - Show vite.config.ts setup
  - Document dev workflow (`pnpm dev` → open two tabs → collaborate)
  - Explain Repo + WebSocket architecture
  - Explain SSR → hydration → live sync flow

- 🔴 **Task 4.2**: Update `packages/kinetic/README.md` status table
  - Change Vite plugin from 🔴 to ✅
  - Change SSR + Hydration from 🔴 to ✅
  - Update test count to 466

- 🔴 **Task 4.3**: Add TECHNICAL.md section for example patterns
  - Document ambient type configuration
  - Document triple-slash directive approach
  - Document `enforce: "pre"` requirement
  - Document dual compilation via `vite.ssrLoadModule()`
  - Document Repo integration pattern for Kinetic

## Key Implementation Details

### vite.config.ts

```typescript
import kinetic from "@loro-extended/kinetic/vite"
import { defineConfig } from "vite"
import topLevelAwait from "vite-plugin-top-level-await"
import wasm from "vite-plugin-wasm"

export default defineConfig({
  plugins: [kinetic(), wasm(), topLevelAwait()],
  optimizeDeps: {
    exclude: ["loro-crdt"],
  },
})
```

### Ambient Type Configuration

TypeScript needs to know about the `div`, `h1`, etc. global factories. The kinetic package must first export the type declarations.

**Required package.json export** (in `packages/kinetic/package.json`):
```json
{
  "exports": {
    "./types/elements": {
      "types": "./src/types/elements.d.ts"
    }
  }
}
```

Note: We use `./src/types/elements.d.ts` (source) rather than `./dist/types/elements.d.ts` because tsup may not copy `.d.ts` files to dist. The source file is included via the `"files": ["dist", "src"]` field.

**Triple-slash directive** (recommended for clarity):
```typescript
/// <reference types="@loro-extended/kinetic/types/elements" />
```

This approach is preferred in examples because it's explicit about where the types come from.

### Builder Pattern Source (src/app.ts)

With Phase 0 complete, the compiler can resolve types from `@loro-extended/change` imports. No inline type declarations needed.

```typescript
/// <reference types="@loro-extended/kinetic/types/elements" />

import { createTypedDoc } from "@loro-extended/change"
import { bind, mount } from "@loro-extended/kinetic"
import { LoroDoc } from "loro-crdt"
import { TodoSchema } from "./schema.js"

// Create the document
const loroDoc = new LoroDoc()
const doc = createTypedDoc(TodoSchema, { doc: loroDoc })

// Seed with initial data
if (doc.title.toString() === "") {
  doc.title.insert(0, "My Todos")
}

// Helper functions
function addTodo() {
  const text = doc.newTodoText.toString().trim()
  if (text) {
    doc.todos.push(text)
    // Clear input
    doc.newTodoText.delete(0, doc.newTodoText.toString().length)
    loroDoc.commit()
  }
}

function removeTodo(item: string) {
  const index = doc.todos.toArray().indexOf(item)
  if (index >= 0) {
    doc.todos.delete(index, 1)
    loroDoc.commit()
  }
}

// The app - this is what the compiler transforms
export const app = div({ class: "todo-app" }, () => {
  header(() => {
    h1(doc.title.toString())

    div({ class: "new-todo-wrapper" }, () => {
      input({ 
        type: "text", 
        placeholder: "What needs to be done?",
        value: bind(doc.newTodoText) 
      })
      button({ onClick: addTodo }, "Add")
    })
  })

  section({ class: "main" }, () => {
    if (doc.todos.toArray().length > 0) {
      ul({ class: "todo-list" }, () => {
        for (const item of doc.todos) {
          li({ class: "todo-item" }, () => {
            label(item)
            button({ class: "destroy", onClick: () => removeTodo(item) }, "×")
          })
        }
      })
    } else {
      p({ class: "empty-state" }, "No todos yet. Add one above!")
    }
  })

  footer({ class: "footer" }, () => {
    span({ class: "todo-count" }, `${doc.todos.toArray().length} items`)
  })
})

// Mount the app
const container = document.getElementById("root")
if (container) {
  mount(() => app, container)
}
```

Note: Event handlers use `onClick` (camelCase) not `onclick` — the compiler's `isEventHandlerProp()` expects the third character to be uppercase.

### Package.json Changes

**Current** (bun-only):
```json
{
  "scripts": {
    "dev": "bun run src/server.ts"
  },
  "devDependencies": {
    "bun-types": "latest"
  }
}
```

**Updated** (Vite-powered):
```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build", 
    "preview": "vite preview",
    "serve:ssr": "bun run src/server.ts",
    "test": "verify logic",
    "verify": "verify"
  },
  "devDependencies": {
    "@typescript/native-preview": "7.0.0-dev.20260103.1",
    "bun-types": "latest",
    "typescript": "~5.8.3",
    "vite": "^6.1.1",
    "vite-plugin-top-level-await": "^1.6.0",
    "vite-plugin-wasm": "^3.5.0",
    "vitest": "^3.2.4"
  }
}
```

## Tests

The example itself doesn't need extensive tests — it's a demonstration. The existing import smoke test (`imports.test.ts`) should be updated to verify:

1. Builder pattern code compiles without errors
2. Vite plugin transforms the source correctly
3. Runtime imports are properly added

**Test file**: `examples/kinetic-todo/src/app.test.ts`

```typescript
import { describe, it, expect } from "vitest"
import { hasBuilderCalls, transformSourceInPlace } from "@loro-extended/kinetic/compiler"
import { readFileSync } from "fs"

describe("kinetic-todo compilation", () => {
  it("should detect builder calls in app.ts", () => {
    const source = readFileSync("./src/app.ts", "utf-8")
    expect(hasBuilderCalls(source)).toBe(true)
  })

  it("should compile app.ts without errors", () => {
    const source = readFileSync("./src/app.ts", "utf-8")
    const result = transformSourceInPlace(source, { filename: "app.ts" })
    expect(result.ir.length).toBeGreaterThan(0)
    expect(result.sourceFile.getFullText()).toContain("document.createElement")
  })
})
```

## Transitive Effect Analysis

| Change | Direct Impact | Transitive Impact |
|--------|---------------|-------------------|
| **Type stub injection** | Compiler resolves types | All reactive detection now works |
| **`enforce: "pre"`** | Plugin receives raw TS | No impact on other plugins |
| **Dual compilation (SSR)** | `vite.ssrLoadModule()` gets HTML target | Eliminates hand-written server render functions |
| **`declare global` in elements.d.ts** | Factories are global | Projects using triple-slash get globals |
| **hasBuilderCalls cleanup** | No leaked check.ts | Fixes duplicate type interference |
| Delete old `app.ts` | None — example only | None |
| Add vite.config.ts | Example builds with Vite | None — new file |
| Import kinetic/vite | Uses existing plugin | None — read-only |
| Ambient type directive | TypeScript understands elements | None — compile-time only |
| **Repo + WS adapter** | Example gains live sync | None — read-only dependency on repo/adapter |
| Update README status | Documentation accuracy | None |

**Risk Assessment**: 

- **Phase 0** has **medium risk** — modifying the compiler's project initialization could affect existing tests. However, injecting type stubs into the in-memory FS should be additive and not break existing behavior (tests use inline declarations which will shadow the stubs).
- **Phase 3** has **medium risk** — introducing Repo + WebSocket adds moving parts (server process, WS connection, storage). But this follows the exact pattern of `todo-websocket` example, which is proven and stable.
- All other phases have **low risk** — isolated example changes.

## Resources for Implementation

### Files to Reference

1. **Vite plugin**: `packages/kinetic/src/vite/plugin.ts` — plugin implementation
2. **Ambient types**: `packages/kinetic/src/types/elements.d.ts` — factory declarations
3. **SSR utilities**: `packages/kinetic/src/server/render.ts` — HTML generation
4. **Existing schema**: `examples/kinetic-todo/src/schema.ts` — keep this
5. **todo-websocket server**: `examples/todo-websocket/src/server.ts` — Repo + WS + Vite middleware pattern
6. **todo-websocket client**: `examples/todo-websocket/src/app.tsx` — Repo client pattern (React, but structure is transferable)
7. **Repo class**: `packages/repo/src/repo.ts` — `repo.get(docId, schema)` API
8. **sync() function**: `packages/repo/src/sync.ts` — `sync(doc).waitForSync()` API

### Package Exports

Current `packages/kinetic/package.json` exports (verified):
- `@loro-extended/kinetic` — main runtime ✅
- `@loro-extended/kinetic/vite` — Vite plugin ✅
- `@loro-extended/kinetic/server` — SSR utilities ✅
- `@loro-extended/kinetic/compiler` — for tests only ✅
- `@loro-extended/kinetic/types/elements` — **MISSING, must add**

### Critical: Add Type Export

The triple-slash directive requires adding this export to `packages/kinetic/package.json`:

```json
{
  "exports": {
    "./types/elements": {
      "types": "./src/types/elements.d.ts"
    }
  }
}
```

Use source path (`./src/`) because the file is a `.d.ts` declaration that tsup doesn't process into dist.

## Changeset

Not required for the example changes. However, the `enforce: "pre"`, `declare global` elements.d.ts, type stub injection, `hasBuilderCalls` cleanup, and dual compilation support are changes to `@loro-extended/kinetic` that affect all users. These should be included in a changeset for the kinetic package (patch bump).

## README Updates

**packages/kinetic/README.md** — Update status table:

```markdown
| Feature | Status | Notes |
|---------|--------|-------|
| ... | ... | ... |
| Vite plugin | ✅ | In-place builder replacement |
| SSR + Hydration | ✅ | Complete with hydration markers |
```

**Test coverage**: Update from "269 tests" to "453 tests"

## TECHNICAL.md Updates

Add to `.plans/kinetic-delta-driven-ui.md` under Implementation Learnings:

### Ambient Type Configuration for Builder Patterns

Kinetic's element factories (`div`, `h1`, etc.) are ambient declarations with no runtime implementation. TypeScript needs explicit configuration to recognize them:

**Triple-slash directive** (recommended for clarity):
```typescript
/// <reference types="@loro-extended/kinetic/types/elements" />

// Now div, h1, etc. are recognized
const app = div(() => { h1("Hello") })
```

**tsconfig.json types array** (project-wide):
```json
{
  "compilerOptions": {
    "types": ["@loro-extended/kinetic/types/elements"]
  }
}
```

The triple-slash approach is preferred in examples because it's explicit about where the types come from.

### Vite Plugin Requires wasm + topLevelAwait

Loro CRDT uses WebAssembly, which requires additional Vite plugins:

```typescript
import kinetic from "@loro-extended/kinetic/vite"
import topLevelAwait from "vite-plugin-top-level-await"
import wasm from "vite-plugin-wasm"

export default defineConfig({
  plugins: [kinetic(), wasm(), topLevelAwait()],
  optimizeDeps: {
    exclude: ["loro-crdt"], // Required for WASM
  },
})
```

### Example Structure Best Practice

A Kinetic example should have:
1. `vite.config.ts` — with kinetic() plugin and wasm support
2. `index.html` — Vite entry point with `<div id="root">` and `<script src="/src/main.ts">`
3. `src/schema.ts` — Loro document schema (shared server/client)
4. `src/app.ts` — Builder pattern UI code with triple-slash directive; exports a function that accepts `doc` and returns a builder call
5. `src/main.ts` — Client entry: Repo + mount or hydrate
6. `src/server.ts` — Repo server with Vite middleware, SSR via `vite.ssrLoadModule()`

## Learnings

### The Intended Architecture: Kinetic + Repo

Kinetic is not a standalone framework — it's the UI layer for Loro documents managed by `@loro-extended/repo`. The intended architecture is:

1. **Server**: `Repo` with storage adapter (LevelDB) + network adapter (WebSocket)
2. **Client**: `Repo` with network adapter (WebSocket) → `repo.get(docId, schema)` returns a synced `Doc`
3. **UI**: Kinetic builder patterns compile to delta-driven DOM code that subscribes to the `Doc`

The client never calls `new LoroDoc()` directly. The `Doc` from `repo.get()` is a TypedDoc that automatically receives deltas from other peers. Kinetic's runtime (`__listRegion`, `__conditionalRegion`, `__subscribeWithValue`) subscribes to these deltas and updates the DOM in O(k).

This means the killer demo isn't a single-tab todo app — it's two tabs collaborating in real-time with zero-diff DOM updates.

### SSR via Dual Compilation (No Hand-Written HTML)

SSR isn't a separate concern from Repo integration — it's the natural starting state. The server already has the document in storage. Rendering it to HTML before the client connects means:

- First paint is instant (no waiting for WebSocket + sync)
- The client hydrates the existing DOM instead of rebuilding it
- The transition from SSR → live collaboration is seamless

Previously, SSR required hand-written `parts.push()` render functions that duplicated the UI from `app.ts`. This was eliminated by enabling dual compilation:

- `transformSourceInPlace` now respects `options.target`, calling `generateRenderFunction` (HTML) or `generateElementFactory` (DOM)
- The Vite plugin auto-detects the target from `transformOptions.ssr` — when the server calls `vite.ssrLoadModule('/src/app.ts')`, Vite passes `ssr: true` and the plugin compiles to HTML target automatically
- One `app.ts`, two outputs, zero duplication

```typescript
// server.ts — no parts.push(), no manual HTML
const doc = repo.get("kinetic-todo", TodoSchema)
await sync(doc).waitForSync({ kind: "storage" })  // load from LevelDB first!

const { createApp } = await vite.ssrLoadModule('/src/app.ts')
// createApp is compiled to HTML target: (doc) => () => `<div>...</div>`
const renderApp = createApp(doc)
const html = renderApp()  // HTML string with fully-loaded data
```

### Repo Document Loading Lifecycle

`repo.get()` returns a Doc immediately, but it may be empty. Storage adapters load data asynchronously. The lifecycle is:

1. `repo.get(docId, schema)` → returns Doc (synchronous, potentially empty)
2. Storage adapter begins loading persisted data in the background
3. `await sync(doc).waitForSync({ kind: "storage" })` → resolves when storage load completes (or confirms doc is absent)
4. Doc now has full persisted state — safe to read/render

**Server** must await storage before SSR, otherwise it renders empty HTML.

**Client** has two paths:
- **With SSR state**: Deserialize `window.__KINETIC_STATE__` into the doc immediately (no await needed — the data is already in the page). Hydrate, then let `waitForSync({ kind: "network" })` catch up in the background.
- **Without SSR state**: Either `await sync(doc).waitForSync({ kind: "network" })` before mounting (slower first paint), or mount optimistically and let the UI update reactively as data arrives (faster first paint, content pops in).

### Vite Strips TypeScript Before Plugin Transform (Critical)

**Problem**: By default, Vite uses esbuild to strip TypeScript types before passing code to plugin `transform` hooks. This means `interface`, `type` imports, and type annotations are removed before the Kinetic compiler sees them. Since reactive detection depends on type information (`ListRef`, `TextRef`, etc.), the compiler produces static (non-reactive) output.

**Symptoms**: The compiled output has no `__listRegion`, `__conditionalRegion`, or `__subscribeWithValue` calls — only `__bindTextValue` (which uses name-based detection on `bind()`, not type-based).

**Solution**: Add `enforce: "pre"` to the Vite plugin. This ensures the kinetic transform runs before esbuild strips types:

```typescript
return {
  name: "kinetic",
  enforce: "pre",  // Must run before esbuild strips TypeScript types
  // ...
}
```

### hasBuilderCalls Leaks Files Into Shared Project

**Problem**: `hasBuilderCalls()` calls `parseSource(source, "check.ts")` which creates a file in the shared ts-morph Project. This file was never removed, causing potential duplicate type declarations when `transformSourceInPlace` later creates another file in the same project.

**Solution**: Remove the `check.ts` file after `hasBuilderCalls` completes. This prevents duplicate interfaces from confusing the type checker.

### Ambient Types Must Use declare global

**Problem**: The `elements.d.ts` file originally used `declare const div: ElementFactory` at module scope with exports. This made them module-scoped, not global — users would have to import each element factory.

**Solution**: Wrap all declarations in `declare global { }` and export only the `ElementFactory` type to keep the file a module. This enables `div`, `h1`, etc. to be available as globals via a triple-slash directive.

### Explicit Type Annotation Required for Reactive Detection

**Problem**: `createTypedDoc(TodoSchema, { doc: loroDoc })` returns a complex inferred type that the compiler's type stubs can't fully resolve. The compiler sees `doc.todos` as `any`.

**Solution**: Users declare an explicit interface with imported ref types and annotate the variable:

```typescript
import { type ListRef, type TextRef } from "@loro-extended/change"

interface TodoDoc {
  title: TextRef
  todos: ListRef<string>
}

const doc: TodoDoc = createTypedDoc(TodoSchema, { doc: loroDoc }) as TodoDoc
```

This is a known limitation: the type stubs provide interface names but not the full generic type machinery of `@loro-extended/change`. The explicit interface is the documented workaround.

### Type Stubs Needed for All Import Sources

The in-memory filesystem needs stubs not just for `@loro-extended/change`, but also for `@loro-extended/kinetic` (for `bind`, `Scope`, etc.) and `loro-crdt` (for `LoroDoc`). Without these, unresolved imports cause cascading `any` types that degrade the entire type system.

### Server Pattern: Repo + Vite Middleware + SSR

The `todo-websocket` example establishes the proven pattern for a Kinetic server. With dual compilation, we extend it with SSR:

```typescript
// 1. Create Repo with adapters
const wsAdapter = new WsServerNetworkAdapter()
const storageAdapter = new LevelDBStorageAdapter("data.db")
new Repo({ adapters: [wsAdapter, storageAdapter] })

// 2. Create HTTP + Vite
const httpServer = http.createServer()
const vite = await createViteServer({
  root,
  server: { middlewareMode: { server: httpServer } },
})

// 3. SSR: intercept GET / before Vite middleware
httpServer.on("request", async (req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    // Wait for storage to load persisted state — without this, doc is empty
    const doc = repo.get("kinetic-todo", TodoSchema)
    await sync(doc).waitForSync({ kind: "storage" })

    // vite.ssrLoadModule compiles app.ts with target: "html"
    const { createApp } = await vite.ssrLoadModule('/src/app.ts')
    const renderApp = createApp(doc)
    const html = renderToDocument(renderApp, doc, { ... })
    res.end(html)
  } else {
    vite.middlewares(req, res)
  }
})

// 4. WebSocket for Loro sync
new WebSocketServer({ server: httpServer, path: "/ws" }).on(
  "connection", ws => {
    wsAdapter.handleConnection({ socket: wrapWsSocket(ws) }).start()
  },
)

httpServer.listen(5173)
```

Two key insights:
1. `vite.ssrLoadModule()` runs the same `app.ts` through the kinetic Vite plugin with `ssr: true`, which auto-selects the HTML target. No separate server render file needed.
2. `await sync(doc).waitForSync({ kind: "storage" })` must be called before rendering — `repo.get()` returns a doc immediately but the LevelDB adapter loads persisted data asynchronously. Without the await, the server renders an empty document.

### Type Resolution in ts-morph In-Memory Filesystem

**Problem**: ts-morph with `useInMemoryFileSystem: true` cannot resolve imports from `node_modules`. All external types become `any`.

**Discovery process**: We wrote a test script that compared type resolution across different ts-morph configurations:
- In-memory FS: `doc.items` → `any` (reactive detection fails)
- In-memory FS + manual stubs: `doc.items` → `ListRef<string>` (reactive detection works)
- Real FS + path mappings: `doc.items` → full type (reactive detection works)

**Solution**: Inject minimal type stubs for `@loro-extended/change` into the in-memory filesystem before parsing user code. The stubs only need interface names and key method signatures — just enough for the type checker to identify reactive types.

**Why not use real filesystem?**: 
- Slower (filesystem access on every transform)
- Path resolution varies by project structure
- Issues with symlinked node_modules (pnpm workspaces)
- The in-memory approach is simpler and sufficient

### Event Handler Prop Naming

The compiler's `isEventHandlerProp()` function expects camelCase event names where the third character is uppercase:
- ✅ `onClick`, `onInput`, `onChange`
- ❌ `onclick`, `oninput`, `onchange`

This matches React conventions but differs from native DOM attributes.

### Type Stub Maintenance

The type stubs in `type-stubs.ts` must be kept in sync with `@loro-extended/change`'s public API. However:
- The stubs only need interface names and method signatures
- Implementation details don't matter
- The public API surface is stable
- Consider generating stubs from the actual types in a build step (future enhancement)