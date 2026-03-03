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

## Components

Kinetic supports user-defined components via the `ComponentFactory` type. The compiler uses TypeScript's type system to detect component functions — no special syntax or naming conventions required.

```typescript
import type { ComponentFactory } from "@loro-extended/kinetic"

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
| Template cloning | ✅ | 3-10× faster DOM creation |
| Batch list operations | ✅ | O(1) DOM ops for contiguous changes |
| Component model | ✅ | Type-based ComponentFactory detection |
| Lazy scopes | ✅ | Skip allocation for static list items |
| Vite plugin | 🔴 | Placeholder only |
| SSR + Hydration | 🔴 | Codegen exists, wiring needed |

**Test coverage**: 760 tests passing

## How It Works

### Compilation Model

Kinetic uses a multi-phase compiler:

1. **Analysis** (`analyze.ts`) — Parses TypeScript AST via ts-morph, produces IR
2. **Walking** (`walk.ts`) — Generator-based IR traversal yields structural events
3. **Template Extraction** (`template.ts`) — Collects static HTML + dynamic hole positions
4. **Walk Planning** (`template.ts`) — Converts hole paths to optimal DOM navigation ops
5. **Code Generation** (`codegen/dom.ts`, `codegen/html.ts`) — Transforms IR to JavaScript
6. **Orchestration** (`transform.ts`) — Coordinates the pipeline, hoists template declarations

The key insight is **type-based reactive detection**: the compiler uses TypeScript's type checker to identify expressions involving Loro ref types (TextRef, ListRef, etc.), then generates appropriate subscriptions. Component functions are also detected via type inspection (`ComponentFactory`).

### Runtime

The compiled code calls into a minimal runtime:

- `Scope` — Ownership tracking with parent-child cleanup (lazy allocation, numeric IDs)
- `subscribe` / `subscribeWithValue` — Loro ref subscriptions (delta-aware)
- `listRegion` — Delta-based list updates with batch insert/delete
- `conditionalRegion` — Branch swapping
- `textRegion` — Character-level text patching via `insertData`/`deleteData`
- `bindTextValue` / `bindChecked` — Two-way input binding

### Template Cloning

Static DOM trees are created via `<template>.content.cloneNode(true)` instead of per-element `createElement` calls. The compiler extracts static HTML, emits a module-level `<template>` declaration, and generates a walker that grabs references to dynamic "holes" in a single pass.

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

## Migration Notes

### Scope.id type change (string → number)

`Scope.id` changed from `string` to `number` for performance (avoids string allocation in tight loops). If you were comparing scope IDs to strings like `"scope-1"`, use numeric comparisons instead:

```typescript
// Before
expect(scope.id).toBe("scope-1")

// After
expect(scope.id).toBe(1)
```

## What's Next

The remaining work to complete the prototype:

1. **Vite Plugin** — Enable actual usage in projects
2. **SSR + Hydration** — Server rendering with client hydration
3. **Integration Test** — Full app validation
4. **Component builder callbacks** — Passing children to components

See `.plans/kinetic-delta-driven-ui.md` for the complete plan.

## Comparison

|                    | Uncompiled | Typed | Declarative | Reactive | O(k) Mutations | Template Cloning |
|--------------------|------------|-------|-------------|----------|----------------|------------------|
| React              | ✅         | ✅    | ~           | ~        | ❌             | ❌               |
| Solid              | ❌         | ✅    | ✅          | ✅       | ~              | ✅               |
| Svelte             | ❌         | ~     | ✅          | ✅       | ~              | ~                |
| Vue                | ❌         | ~     | ✅          | ✅       | ❌             | ❌               |
| **Kinetic**        | ~*         | ✅    | ✅          | ✅       | ✅             | ✅               |

\* Source is valid TypeScript (LSP works), but compilation required for execution

## Related Packages

- [@loro-extended/change](../change) - Schema-driven typed wrapper for Loro CRDTs
- [@loro-extended/react](../react) - React integration (component re-render model)
- [@loro-extended/repo](../repo) - Document synchronization

## License

MIT