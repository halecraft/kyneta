# @kyneta/cast

> 🧪 **Prototype** — This package is an experimental exploration of compiled delta-driven UI. Not ready for production use.

A compiled delta-driven UI framework powered by the CHANGEFEED protocol from `@kyneta/schema`.

## Overview

Kyneta transforms natural TypeScript into code that directly consumes structured deltas for O(k) DOM updates, where k is the number of operations (not the size of your data).

### The Problem

Traditional UI frameworks, including React, must diff entire data structures to discover what changed. When you add one item to a 1000-item list, they re-render all 1000 items to find the one that's new.

### The Solution

Reactive data sources that implement the `CHANGEFEED` protocol already know exactly what changed — they provide deltas like "insert item at index 3". Kyneta's compiler transforms natural TypeScript into code that directly consumes these deltas, updating only the affected DOM nodes.

```typescript
// What you write (natural TypeScript)
div(() => {
  h1(doc.title)              // Bare reactive ref — no explicit call needed
  
  if (doc.items.length === 0) {
    p("No items yet")
  }
  
  for (const item of doc.items) {
    li(item.text)
  }
})

// What happens at runtime:
// - Edit title → O(k) character-level DOM patch (not full replacement)
// - Insert 1 item → 1 DOM insert (not 1000 re-renders)
// - Delete item at index 5 → 1 DOM remove
// - No diffing, no reconciliation
```

### Bare Reactive Refs

Kyneta supports passing reactive refs directly as children — no explicit call required:

```typescript
// All three produce identical compiled output:
p(doc.title)              // ← Preferred: bare ref (toPrimitive coercion)
p(`${doc.title}`)         // Also works: template literal interpolation
p(doc.title())            // Also works: explicit call
```

The compiler detects that `doc.title` implements `CHANGEFEED` (reactive + observable), synthesizes the value read internally, and routes it to `textRegion` for O(k) surgical text patching. For non-text refs, the compiler synthesizes a value read and uses `valueRegion` for full-replacement updates.

## Server-Side Rendering

Kyneta supports server-side rendering with optional pretty-printing for development:

```typescript
import { renderToDocument } from '@kyneta/cast/server'

// Load compiled app (Vite plugin auto-compiles to HTML target for SSR)
const { createApp } = await vite.ssrLoadModule('/src/app.ts')
const renderApp = createApp(doc)

// Minified output (default, for production)
const html = renderToDocument(renderApp, doc, {
  title: 'My App',
  head: '<style>...</style>',
  scripts: '<script type="module" src="/src/main.ts"></script>',
})

// Pretty-printed output (for development/debugging)
const prettyHtml = renderToDocument(renderApp, doc, {
  title: 'My App',
  pretty: true,  // Formats the rendered content with indentation
})
```

### SSR Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `hydratable` | `boolean` | `true` | Include hydration markers for client rehydration |
| `pretty` | `boolean` | `false` | Format HTML with indentation (useful for debugging) |
| `title` | `string` | - | Document title |
| `head` | `string` | - | Additional content for `<head>` (styles, meta tags) |
| `scripts` | `string` | - | Scripts to include before closing `</body>` |

## Components

Kyneta supports user-defined components via the `ComponentFactory` type. The compiler uses TypeScript's type system to detect component functions — no special syntax or naming conventions required.

```typescript
import type { ComponentFactory } from "@kyneta/cast"

// Define a component
const Card: ComponentFactory<{ title: string }> = (props) => {
  return div(() => {
    h2(props.title)
    p("Card content")
  })
}

// Use it like any HTML element
div(() => {
  Card({ title: "Hello" })
  Card({ title: "World" })
})
```

Components:
- Are ordinary functions typed as `ComponentFactory`
- Receive their own `Scope` for subscription cleanup
- Work with template cloning (serialized as placeholders, instantiated at runtime)
- Can accept props, a builder callback, both, or neither

## Local Reactive State

Use `state()` to create local reactive refs that participate in the CHANGEFEED protocol:

```typescript
import { state } from "@kyneta/cast"

const count = state(0)

div(() => {
  p(`Count: ${count}`)
  button({ onClick: () => count.set(count() + 1) }, "Increment")
})
```

`state()` returns a `LocalRef<T>` — a lightweight callable reactive primitive that implements the `CHANGEFEED` symbol from `@kyneta/schema`. Call `count()` to read the current value, or use `${count}` in template literals (refs implement `Symbol.toPrimitive`). The compiler detects it via the same type-level mechanism used for any Changefeed-bearing ref.

## Client & Server Code

Inside builder functions, use labeled blocks to mark code as client-only or server-only:

```typescript
return div(() => {
  const count = state(0)

  client: {
    // Only runs in the browser — stripped from SSR output
    setInterval(() => count.set(count() + 1), 1000)
  }

  server: {
    // Only runs during SSR — stripped from client bundle
    console.log("Rendered at", new Date().toISOString())
  }

  h1(`${count}`)
})
```

- `client: { ... }` — browser only (stripped during SSR compilation)
- `server: { ... }` — SSR only (stripped from client bundle)
- Unlabeled code — runs in both contexts

These are standard TypeScript [labeled statements](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/label) — no custom syntax, no build tool magic. The compiler recognizes `client` and `server` labels inside builder functions and filters the IR tree before code generation.

## Prototype Status

This is an experimental prototype exploring whether compilation can unlock O(k) UI updates from structured deltas.

| Feature | Status | Notes |
|---------|--------|-------|
| Package scaffolding | ✅ | Build, test, verify tooling |
| Error taxonomy | ✅ | Typed errors with source locations |
| Type definitions | ✅ | Ambient declarations for LSP |
| Runtime primitives | ✅ | Scope, subscriptions, regions |
| Compiler infrastructure | ✅ | IR, analysis, codegen |
| Static compilation | ✅ | Elements, attributes, text |
| Reactive expressions | ✅ | CHANGEFEED-based type detection, bare-ref support |
| List transform | ✅ | O(k) verified with tests |
| Conditional transform | ✅ | if/else-if/else chains |
| Input binding | ✅ | text, checkbox, numeric |
| Template cloning | ✅ | 3-10× faster DOM creation |
| Batch list operations | ✅ | O(1) DOM ops for contiguous changes |
| Component model | ✅ | Type-based ComponentFactory detection |
| Lazy scopes | ✅ | Skip allocation for static list items |
| Target labels | ✅ | `client:` / `server:` blocks |
| Local reactive state | ✅ | `state()` / `LocalRef` via CHANGEFEED |
| Vite plugin | 🔴 | Placeholder only |
| SSR + Hydration | 🟡 | Codegen + target labels done, hydration wiring needed |

## How It Works

### Compilation Model

Kyneta uses a multi-phase compiler:

1. **Analysis** (`analyze.ts`) — Parses TypeScript AST via ts-morph, produces IR
2. **Walking** (`walk.ts`) — Generator-based IR traversal yields structural events
3. **Template Extraction** (`template.ts`) — Collects static HTML + dynamic hole positions
4. **Walk Planning** (`template.ts`) — Converts hole paths to optimal DOM navigation ops
5. **Code Generation** (`codegen/dom.ts`, `codegen/html.ts`) — Transforms IR to JavaScript
6. **Orchestration** (`transform.ts`) — Coordinates the pipeline, hoists template declarations

The key insight is **CHANGEFEED-based reactive detection**: the compiler uses TypeScript's type checker to identify expressions whose types carry the `CHANGEFEED` symbol (from `@kyneta/schema`), then generates appropriate subscriptions. The delta kind (text, sequence, etc.) is extracted from the `Changefeed`'s change type to dispatch to the optimal region handler. Component functions are also detected via type inspection (`ComponentFactory`).

### Runtime

The compiled code calls into a minimal runtime:

- `Scope` — Ownership tracking with parent-child cleanup (lazy allocation, numeric IDs)
- `subscribe` — CHANGEFEED-based subscription (delta-aware)
- `valueRegion` — Replace-semantic updates for any Changefeed or computed expression
- `listRegion` — Delta-based list updates with batch insert/delete
- `conditionalRegion` — Branch swapping
- `textRegion` — Character-level text patching via `insertData`/`deleteData`
- `inputTextRegion` — Surgical `<input>`/`<textarea>` value patching via `setRangeText`
- `read(ref)` — Universal value accessor: `ref[CHANGEFEED].current`

### Template Cloning

Static DOM trees are created via `<template>.content.cloneNode(true)` instead of per-element `createElement` calls. The compiler extracts static HTML, emits a module-level `<template>` declaration, and generates a walker that grabs references to dynamic "holes" in a single pass.

### No Runtime Element Factories

Unlike React or Solid, there are no `div()`, `h1()`, etc. functions at runtime. Instead:

- `src/types/elements.d.ts` provides **ambient type declarations** for TypeScript LSP
- The **compiler** transforms builder calls into direct DOM manipulation
- You run the **compiled output**, not the source

This means you cannot currently run Kyneta code without compilation.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                      User Source Code                       │
│   div(() => { if (x) { p("yes") } for (i of list) { ... } })│
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    ts-morph Compiler                        │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐    │
│  │ Analyze     │ │    IR       │ │ Generate            │    │
│  │ (AST → IR)  │ │  (data)     │ │ (IR → Code)         │    │
│  └─────────────┘ └─────────────┘ └─────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Compiled Output                          │
│   Static DOM creation + delta subscriptions + region mgmt   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Kyneta Runtime                           │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐    │
│  │ mount()     │ │ Regions     │ │ CHANGEFEED Protocol │    │
│  │ dispose()   │ │ Management  │ │ (delta handlers)    │    │
│  └─────────────┘ └─────────────┘ └─────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Example App

See [`examples/recipe-book/`](../../examples/recipe-book/) — a runnable example demonstrating SSR, hydration, multi-tab sync via WebSocket, and all four delta kinds (text, sequence, replace, increment).

## Running Tests

```bash
pnpm turbo run verify --filter=@kyneta/cast -- logic
# Run all tests
cd packages/cast && npx vitest run

# Run specific test file
pnpm turbo run verify --filter=@kyneta/cast -- logic -- -t 'list region'
```

## Migration Notes

### Scope.id type change (string → number)

`Scope.id` changed from `string` to `number` for performance (avoids string allocation in tight loops). If you were comparing scope IDs to strings like `"scope-1"`, use numeric comparisons instead:

```typescript
// Before
expect(scope.id).toBe("scope-1")

// After
expect(scope.id).toBe(1)
```

### CHANGEFEED protocol (replaces REACTIVE + SNAPSHOT)

The reactive protocol has been unified from two symbols (`REACTIVE` + `SNAPSHOT`) to a single `CHANGEFEED` symbol from `@kyneta/schema`:

```typescript
// Old (two-symbol design from the predecessor reactive package)
ref[REACTIVE](ref, callback)   // subscribe
ref[SNAPSHOT](ref)              // read current value

// New (single-symbol CHANGEFEED coalgebra from @kyneta/schema)
ref[CHANGEFEED].subscribe(cb)  // subscribe
ref[CHANGEFEED].current        // read current value
```

The compiler, runtime, and all region handlers now use this single protocol. Any object implementing `CHANGEFEED` is automatically detected as reactive.

## What's Next

The remaining work to complete the prototype:

1. **Vite Plugin** — Enable actual usage in projects
2. **SSR + Hydration** — Server rendering with client hydration
3. **Integration Test** — Full app validation
4. **Component builder callbacks** — Passing children to components

## Comparison

|                    | Uncompiled | Typed | Declarative | Reactive | O(k) Mutations | Template Cloning |
|--------------------|------------|-------|-------------|----------|----------------|------------------|
| React              | ✅         | ✅    | ~           | ~        | ❌             | ❌               |
| Solid              | ❌         | ✅    | ✅          | ✅       | ~              | ✅               |
| Svelte             | ❌         | ~     | ✅          | ✅       | ~              | ~                |
| Vue                | ❌         | ~     | ✅          | ✅       | ❌             | ❌               |
| **Kyneta**         | ~*         | ✅    | ✅          | ✅       | ✅             | ✅               |

\* Source is valid TypeScript (LSP works), but compilation required for execution

## License

MIT
