# Recipe Book

A best-practices example for **@kyneta/core** — demonstrating SSR, hydration, multi-tab sync via WebSocket, and all four delta kinds in a single application.

## Quick Start

```sh
# 1. Build dependencies (from monorepo root)
pnpm -C packages/schema build
pnpm -C packages/core build

# 2. Install and run
cd examples/recipe-book
pnpm install
bun run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

## Prerequisites

- [Bun](https://bun.sh/) ≥ 1.0 (or Node ≥ 20 with `npx tsx src/server.ts`)
- [pnpm](https://pnpm.io/) ≥ 10

## Architecture

```
                        ┌─────────────────────────────────────────┐
                        │              server.ts                  │
                        │                                         │
  Browser GET /  ──────►│  Vite middleware mode                   │
                        │    ├─ ssrLoadModule("/src/app.ts")      │
                        │    │    └─ Kyneta plugin: HTML target   │
                        │    └─ transformIndexHtml                │
                        │                                         │
                        │  createDoc(RecipeBookSchema, SEED)      │
                        │    └─ authoritative server-side doc     │
                        │                                         │
  WebSocket /ws ───────►│  Sync endpoint                          │
                        │    ├─ sync: client sends frontier       │
                        │    ├─ delta: server sends missed ops    │
                        │    └─ delta: client sends local ops     │
                        └─────────────────────────────────────────┘

                        ┌─────────────────────────────────────────┐
                        │              main.ts (client)           │
                        │                                         │
                        │  createDoc(RecipeBookSchema, SEED)      │
                        │    └─ local client-side doc             │
                        │                                         │
                        │  mount(createApp(doc), root)            │
                        │    └─ Kyneta plugin: DOM target         │
                        │                                         │
                        │  WebSocket connection                   │
                        │    ├─ on open: send { sync, version }   │
                        │    ├─ on delta: applyChanges(doc, ops)  │
                        │    └─ on local change: send delta       │
                        └─────────────────────────────────────────┘
```

### Three-Flow SSR

The server delivers three distinct data flows on each page load:

| # | Flow | Size | Mechanism | Purpose |
|---|------|------|-----------|---------|
| 1 | **Rendered HTML** | Proportional to view | `<!--ssr-->` placeholder in `index.html` | Immediate visual content — no JS needed to see the page |
| 2 | **State + Frontier** | Proportional to state | `<script id="kyneta-state">` + `<meta name="kyneta-version">` | Client reconstructs equivalent substrate from snapshot |
| 3 | **Sync bootstrap** | Proportional to missed ops | WebSocket `{ type: "delta", ops, version }` | Catches the client up to ops applied after SSR render |

The client reads the embedded snapshot from `<script id="kyneta-state" type="application/json">` and reconstructs a `PlainSubstrate` via `createDocFromSnapshot()`. The frontier from `<meta name="kyneta-version">` is sent to the server via WebSocket so the client only receives operations that occurred *after* the SSR snapshot was captured. If no snapshot is present (e.g. direct JS load without SSR), the client falls back to creating a doc from `SEED`.

## Delta Kind Spectrum

This example exercises every delta kind the framework supports:

| Delta Kind | Schema Construct | UI Element | Runtime Region |
|------------|-----------------|------------|----------------|
| **text** | `LoroSchema.text()` | Recipe book title, recipe names | `textRegion` — surgical `insertData`/`deleteData` on DOM text nodes |
| **sequence** | `Schema.list(...)` | Recipe list, ingredient lists | `listRegion` — O(k) `insertBefore`/`removeChild` per operation |
| **replace** | `LoroSchema.plain.boolean()` | Vegetarian badge toggle | `conditionalRegion` — branch swap on value change |
| **increment** | `LoroSchema.counter()` | Favorites counter | `valueRegion` — re-read and update on each delta |

## Component Architecture

Three `ComponentFactory`-style components at increasing complexity levels:

| Component | Props | Demonstrates |
|-----------|-------|-------------|
| `IngredientItem` | Plain values (`text: string`) | Leaf component — parent reads refs, child is pure |
| `RecipeCard` | Schema ref (`recipe: RecipeRef`) | Nested regions: `textRegion` + `listRegion` + `conditionalRegion` |
| `Toolbar` | Doc ref + `LocalRef`s | Schema/local-state boundary: synced favorites vs. local filter |

### Schema vs. Local State

The app demonstrates a motivated boundary between document state and local UI state:

- **Document state** (`Ref<S>` via `createDoc`) — synced across tabs via WebSocket. Recipe data, favorites count.
- **Local state** (`state()` → `LocalRef<T>`) — per-tab, not synced. Search filter text, veggie-only toggle.

Both participate in the `[CHANGEFEED]` protocol, so the compiler treats them identically for reactive detection.

## Styling

A single static `style.css` file provides all visual design — no build step, no preprocessor, no CSS-in-JS. The stylesheet targets the semantic class names already emitted by the compiled component output (`.recipe-card`, `.ingredient-item`, `.toolbar-section`, etc.), demonstrating that Kyneta's compiled HTML is designer-friendly: stable class names, no framework-specific selectors.

Key design patterns:

- **Four-tier button hierarchy** — `.add-btn` (primary, filled accent), `.toggle-btn` (secondary, outlined), `.remove-btn` (destructive, icon-only circle), `.fav-btn` (stepper, small outlined square)
- **Flexbox label+action rows** — ingredient items and recipe headers use flex with the label growing and the action button pinned right, eliminating ragged edges
- **Responsive layout** — toolbar sections stack vertically below 600px, cards reduce padding, footer buttons go full-width
- **Kitchen-friendly touch targets** — all interactive elements meet the 44px minimum for use on mobile devices

The CSS is linked from `index.html` as a static asset, so it works with SSR (the page is styled before JavaScript loads).

## File Walkthrough

```
examples/recipe-book/
├── index.html               HTML shell with <!--ssr--> placeholder
├── style.css                Kitchen-friendly stylesheet (static, no build step)
├── package.json             Dependencies: @kyneta/core, @kyneta/schema, zod
├── vite.config.ts           Kyneta Vite plugin (auto-detects SSR target)
├── vitest.config.ts         Test runner config
├── recipe-book.test.ts      15 integration tests (facade + sync + SSR snapshot round-trip)
└── src/
    ├── schema.ts            RecipeBookSchema — all 4 delta kinds
    ├── types.ts             RecipeBookDoc, RecipeBookSnapshot, RecipeBookSeed
    ├── seed.ts              Shared initial data (server + client start identical)
    ├── facade.ts            createDoc + version/delta sync primitives
    ├── protocol.ts          Zod v4 wire schemas for WebSocket messages
    ├── app.ts               createApp(doc) — the isomorphic app factory
    ├── main.ts              Client entry: mount + WebSocket sync
    ├── server.ts            HTTP + Vite middleware + WebSocket sync endpoint
    └── components/
        ├── ingredient-item.ts   Leaf component (plain values)
        ├── recipe-card.ts       Mid-complexity (schema refs, nested regions)
        └── toolbar.ts           Complex (doc state + local state in props)
```

## Two-Tab Sync

To verify multi-tab collaboration:

1. Start the dev server: `bun run dev`
2. Open [http://localhost:3000](http://localhost:3000) in **Tab A**
3. Open the same URL in **Tab B**
4. In Tab A, click **"+ New Recipe"** — observe it appear in Tab B
5. In Tab A, click **"+"** next to Favorites — observe the counter update in Tab B
6. In Tab B, click **"Mark Vegetarian"** on Pasta Carbonara — observe the 🌱 badge appear in Tab A

Each tab creates its own local document from the same seed. The WebSocket sync protocol forwards mutations between tabs via the server's authoritative document. The `origin: "sync"` flag prevents echo loops.

## Tests

```sh
pnpm test
```

Runs 15 integration tests covering:
- **Facade basics** (5 tests) — `createDoc`, text/list/counter/boolean mutations
- **Sync primitives** (7 tests) — version tracking, delta computation, round-trip replication
- **SSR snapshot round-trip** (3 tests) — `exportSnapshot` → `createDocFromSnapshot` → state equality, fresh epoch frontier, up-to-date delta

## Frontier-Based Sync Protocol

The sync model is the **degenerate single-peer case** of a version vector:

- `version(doc)` → monotonic integer, increments on each flush cycle
- `delta(doc, fromVersion)` → `log.slice(fromVersion).flat()` → `Op[]`

The upgrade path to full CRDT sync preserves the same protocol shape — the integer becomes a version vector, and `delta()` computes the set difference. The wire format (`{ type, ops, version }`) remains compatible.
