# @loro-extended/kinetic

> 🧪 **Prototype** — This package is an experimental exploration of compiled delta-driven UI. Not ready for production use.

A compiled delta-driven UI framework for Loro documents.

## Overview

Kinetic transforms natural TypeScript into code that directly consumes Loro CRDT deltas for O(k) DOM updates, where k is the number of operations (not the size of your data).

### The Problem

Traditional UI frameworks, including React, must diff entire data structures to discover what changed. When you add one item to a 1000-item list, they re-render all 1000 items to find the one that's new.

### The Solution

Loro CRDTs already know exactly what changed — they provide deltas like "insert item at index 3". Kinetic's compiler transforms natural TypeScript into code that directly consumes these deltas, updating only the affected DOM nodes.

```typescript
// What you write (natural TypeScript)
div(() => {
  h1("My App")
  
  if (doc.items.length === 0) {
    p("No items yet")
  }
  
  for (const item of doc.items) {
    li(item.text)
  }
})

// What happens at runtime:
// - Insert 1 item → 1 DOM insert (not 1000 re-renders)
// - Delete item at index 5 → 1 DOM remove
// - No diffing, no reconciliation
```

## Server-Side Rendering

Kinetic supports server-side rendering with optional pretty-printing for development:

```typescript
import { renderToDocument } from '@loro-extended/kinetic/server'

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

## Prototype Status

This is an experimental prototype exploring whether compilation can unlock O(k) UI updates from CRDT deltas.

| Feature | Status | Notes |
|---------|--------|-------|
| Package scaffolding | ✅ | Build, test, verify tooling |
| Error taxonomy | ✅ | Typed errors with source locations |
| Type definitions | ✅ | Ambient declarations for LSP |
| Runtime primitives | ✅ | Scope, subscriptions, regions |
| Compiler infrastructure | ✅ | IR, analysis, codegen |
| Static compilation | ✅ | Elements, attributes, text |
| Reactive expressions | ✅ | Type-based ref detection |
| List transform | ✅ | O(k) verified with tests |
| Conditional transform | ✅ | if/else-if/else chains |
| Input binding | ✅ | text, checkbox, numeric |
| Vite plugin | 🔴 | Placeholder only |
| SSR + Hydration | 🔴 | Codegen exists, wiring needed |

**Test coverage**: 588 tests passing

## How It Works

### Compilation Model

Kinetic uses a three-phase compiler:

1. **Analysis** (`analyze.ts`) — Parses TypeScript AST via ts-morph, produces IR
2. **Code Generation** (`codegen/dom.ts`, `codegen/html.ts`) — Transforms IR to JavaScript
3. **Orchestration** (`transform.ts`) — Coordinates the pipeline

The key insight is **type-based reactive detection**: the compiler uses TypeScript's type checker to identify expressions involving Loro ref types (TextRef, ListRef, etc.), then generates appropriate subscriptions.

### Runtime

The compiled code calls into a minimal runtime:

- `Scope` — Ownership tracking with parent-child cleanup
- `__subscribe` / `__subscribeWithValue` — Loro ref subscriptions
- `__listRegion` — Delta-based list updates (retain/insert/delete)
- `__conditionalRegion` — Branch swapping
- `__bindTextValue` / `__bindChecked` — Two-way input binding

### No Runtime Element Factories

Unlike React or Solid, there are no `div()`, `h1()`, etc. functions at runtime. Instead:

- `src/types/elements.d.ts` provides **ambient type declarations** for TypeScript LSP
- The **compiler** transforms builder calls into direct DOM manipulation
- You run the **compiled output**, not the source

This means you cannot currently run Kinetic code without compilation.

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
│                    Kinetic Runtime                          │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐    │
│  │ mount()     │ │ Regions     │ │ Loro Integration    │    │
│  │ dispose()   │ │ Management  │ │ (delta handlers)    │    │
│  └─────────────┘ └─────────────┘ └─────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Running Tests

```bash
# Run all kinetic tests
pnpm turbo run verify --filter=@loro-extended/kinetic -- logic

# Run specific test file
pnpm turbo run verify --filter=@loro-extended/kinetic -- logic -- -t 'list region'
```

## What's Next

The remaining work to complete the prototype:

1. **Phase 9: Vite Plugin** — Enable actual usage in projects
2. **Phase 10: SSR + Hydration** — Server rendering with client hydration
3. **Phase 11: Integration Test** — Full app validation
4. **Phase 12: Documentation** — TECHNICAL.md, API docs

See `.plans/kinetic-delta-driven-ui.md` for the complete plan.

## Comparison

|                    | Uncompiled | Typed | Declarative | Reactive | O(k) Mutations |
|--------------------|------------|-------|-------------|----------|----------------|
| React              | ✅         | ✅    | ~           | ~        | ❌             |
| Solid              | ❌         | ✅    | ✅          | ✅       | ~              |
| Svelte             | ❌         | ~     | ✅          | ✅       | ~              |
| Vue                | ❌         | ~     | ✅          | ✅       | ❌             |
| **Kinetic**        | ~*         | ✅    | ✅          | ✅       | ✅             |

\* Source is valid TypeScript (LSP works), but compilation required for execution

## Related Packages

- [@loro-extended/change](../change) - Schema-driven typed wrapper for Loro CRDTs
- [@loro-extended/react](../react) - React integration (component re-render model)
- [@loro-extended/repo](../repo) - Document synchronization

## License

MIT