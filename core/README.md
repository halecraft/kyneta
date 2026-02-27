# @loro-extended/kinetic

> ⚠️ **Experimental** - This package is under active development and not yet ready for production use.

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

## Features

| Feature | Status |
|---------|--------|
| Package scaffolding | ✅ |
| Error taxonomy | ✅ |
| Type definitions | ✅ |
| Runtime primitives | 🔴 Not started |
| Compiler infrastructure | 🔴 Not started |
| Static extraction | 🔴 Not started |
| Reactive expressions | 🔴 Not started |
| List transform | 🔴 Not started |
| Conditional transform | 🔴 Not started |
| Input binding | 🔴 Not started |
| Vite plugin | 🔴 Not started |
| SSR support | 🔴 Not started |

## Installation

```bash
pnpm add @loro-extended/kinetic @loro-extended/change loro-crdt
```

## Quick Start

> Note: The examples below show the intended API. Implementation is in progress.

```typescript
import { div, h1, p, li, mount } from "@loro-extended/kinetic"
import { Shape, createTypedDoc } from "@loro-extended/change"

// Define your schema
const schema = Shape.doc({
  title: Shape.text(),
  items: Shape.list(Shape.struct({
    id: Shape.plain.string(),
    text: Shape.plain.string(),
    done: Shape.plain.boolean(),
  })),
})

// Create a typed document
const doc = createTypedDoc(schema)

// Build your UI with natural TypeScript
const app = div(() => {
  h1(doc.title.toString())
  
  for (const item of doc.items) {
    li({ class: () => item.done ? "completed" : "" }, () => {
      span(item.text)
    })
  }
})

// Mount to DOM
const { dispose } = mount(app, document.getElementById("root")!)

// Cleanup when done
dispose()
```

## Vite Plugin

```typescript
// vite.config.ts
import { defineConfig } from "vite"
import kinetic from "@loro-extended/kinetic/vite"

export default defineConfig({
  plugins: [kinetic()],
})
```

## Server-Side Rendering

```typescript
import { renderToString } from "@loro-extended/kinetic/server"
import { div, h1, p } from "@loro-extended/kinetic"

const html = renderToString(
  div(() => {
    h1("Hello, World!")
    p("Server-rendered content")
  })
)
```

## How It Works

### Compilation

The Kinetic compiler analyzes your TypeScript code and:

1. **Detects builder pattern calls** - `div(() => { ... })` triggers analysis
2. **Identifies reactive expressions** - Uses TypeScript's type system to find Loro ref access
3. **Transforms control flow** - `for` loops become delta-bound regions, `if` statements become conditional regions
4. **Generates efficient code** - Direct DOM manipulation with fine-grained subscriptions

### Runtime

The compiled code uses a minimal runtime (~4KB) that:

- Manages subscriptions to Loro containers
- Handles delta-based list updates (insert, delete, move)
- Swaps conditional regions when conditions change
- Cleans up automatically via scope-based ownership

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
│  │ Analyze     │ │ Transform   │ │ Generate            │    │
│  │ (AST → IR)  │ │ (IR → IR)   │ │ (IR → Code)         │    │
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
