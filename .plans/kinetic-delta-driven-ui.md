# Plan: Kinetic — Compiled Delta-Driven UI Framework

## Background

Through extensive research and iteration, we've discovered a novel UI paradigm that combines five properties no existing framework achieves simultaneously:

| Property | How Kinetic Achieves It |
|----------|-------------------------|
| **Valid Source** | Standard TypeScript with full LSP support (compilation required for execution) |
| **Perfectly Typed** | Function overloads, inference, editor understands everything |
| **Declarative** | Native `if`/`for` control flow, reads like a template |
| **Reactive** | Compiler extracts dependencies, generates subscriptions |
| **O(1) to O(k) mutations** | Loro deltas → direct DOM ops, no diffing |

The key insight: **Loro CRDT operations provide exact deltas**, not snapshots. While every other UI framework must diff to discover what changed, Loro *tells us* what changed. The compiler transforms natural TypeScript into code that directly consumes these deltas.

### The Core Promise

**Write natural TypeScript. Compile to O(k) delta-driven DOM.**

```typescript
// What you write (beautiful, natural)
div(() => {
  h1("My App")
  
  if (doc.items.length === 0) {
    p("No items yet")
  }
  
  for (const item of doc.items) {
    li(item.text)
  }
})

// What it compiles to (fast, delta-driven)
// You never see or think about this
```

### No Escape Hatches, No Ceremony

Previous iterations considered `each()`, `when()`, `$()` as "opt-in performance" markers. We reject this:

- ❌ "Use `for` for simplicity, `each()` for speed" — cognitive load
- ❌ "Wrap reactive expressions in `$()`" — ceremony  
- ✅ "Write `if`/`for`. It's fast." — beautiful

The user writes idiomatic code. The compiler does the work.

### Comparison with Existing Frameworks

```
                    Valid TS*  Typed  Declarative  Reactive  O(k) Mutations
─────────────────────────────────────────────────────────────────────────────
React                  ✓         ✓         ~          ~           ✗
Solid (JSX)            ✗         ✓         ✓          ✓           ~
Svelte                 ✗         ~         ✓          ✓           ~
DLight                 ✗         ✓         ✓          ✓           ~
Vue (SFC)              ✗         ~         ✓          ✓           ✗
Van.js                 ✓         ~         ✗          ✓           ✗
─────────────────────────────────────────────────────────────────────────────
Kinetic                ✓         ✓         ✓          ✓           ✓

* "Valid TS" = Source code is standard TypeScript that IDE/LSP understands without plugins.
  All frameworks except React/Van.js require compilation, but Kinetic source is valid TS
  (not JSX, not .svelte, not .vue) so standard TypeScript tooling works out of the box.
```

### How the Compiler Enables O(k) Updates

```typescript
// Source: natural for loop
for (const item of doc.items) {
  li(item.text)
}

// Compiled: delta-bound region
__listRegion(container, doc.items, {
  create: (item, index) => {
    const _li = document.createElement("li")
    _li.textContent = item.text
    return _li
  },
  // Deletes handled automatically by runtime
}, scope)
```

The compiler:
1. Detects `for..of` over a Loro list ref
2. Extracts the loop body into insert/delete handlers
3. Subscribes to Loro deltas (not snapshots)
4. Generates direct DOM operations

Result: Insert 1 item into 1000-item list = O(1), not O(1000).

## Problem Statement

LoroExtended provides excellent data layer abstractions (`@loro-extended/change`, `@loro-extended/repo`), but the UI integration relies on React hooks that:

1. **Discard delta information** — `useValue()` triggers re-render but doesn't pass the delta
2. **Require framework overhead** — React's reconciliation runs even though we know exactly what changed
3. **Can't leverage Loro's operation semantics** — List inserts/deletes could be O(1) but become O(n)
4. **Impose ceremony** — JSX, hooks rules, component boundaries

We need a UI layer purpose-built for CRDT documents that compiles natural TypeScript into delta-consuming DOM operations.

## Success Criteria

1. **Natural Syntax** — Users write `if`/`for`, not framework-specific constructs
2. **Full LSP Support** — Editor understands the code without compilation
3. **Delta-Based Lists** — `for` loops compile to O(k) Loro delta handlers
4. **Reactive Expressions** — Ref access in expressions compiles to fine-grained subscriptions
5. **Vite Integration** — Plugin enables seamless dev/prod workflow
6. **Proof of Concept Demo** — A working todo app demonstrates all capabilities

## The Gap

| Need | Current State | Kinetic Solution |
|------|---------------|------------------|
| Delta-driven updates | Hooks discard deltas | Compiler generates delta handlers |
| Native control flow | `{condition && <X/>}` | Plain `if`/`for` compiled to regions |
| No ceremony | JSX, hooks, memo | Just TypeScript functions |
| Fine-grained reactivity | Component re-render | Expression-level subscriptions |
| Two-way CRDT binding | Manual event handlers | `bind(ref)` on inputs |

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      User Source Code                        │
│   div(() => { if (x) { p("yes") } for (i of list) { ... } })│
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    ts-morph Compiler                         │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐    │
│  │ Static      │ │ Reactive    │ │ Control Flow        │    │
│  │ Analysis    │ │ Boundaries  │ │ Transformation      │    │
│  └─────────────┘ └─────────────┘ └─────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Compiled Output                           │
│   Static DOM creation + delta subscriptions + region mgmt   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Kinetic Runtime                           │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────┐    │
│  │ mount()     │ │ Regions     │ │ Loro Integration    │    │
│  │ dispose()   │ │ Management  │ │ (delta handlers)    │    │
│  └─────────────┘ └─────────────┘ └─────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

## Core Type Definitions

These types define the **source-level API** that TypeScript/LSP understands. Element factories 
(`div`, `h1`, etc.) exist only for type checking—the compiler transforms them away. Users never 
import these at runtime; they're ambient types that make the source code valid TypeScript:

```typescript
// An Element is a function that produces a DOM node
type Element = () => Node

// Props for HTML elements
type Props = Record<string, unknown> & {
  class?: string | (() => string)
  style?: string | Record<string, string | (() => string)>
  // ... standard HTML attributes
  // Event handlers
  onClick?: (e: MouseEvent) => void
  onInput?: (e: InputEvent) => void
  // etc.
}

// Valid children
type Child = string | number | Element | Binding<unknown>

// Binding connects Loro ref to DOM (for inputs)
interface Binding<T> {
  __brand: "binding"
  ref: TypedRef<T>
}

// Element factory signature (dual-mode via overloads)
// These are TYPE declarations only - no runtime implementation
// The compiler transforms calls to direct DOM creation
declare function div(builder: () => void): Element
declare function div(props: Props, builder: () => void): Element
declare function div(props: Props, ...children: Child[]): Element
declare function div(...children: Child[]): Element
```

The `declare` keyword indicates these are ambient declarations. The Vite plugin provides these 
types automatically; users don't need to import them. At compile time, `div(() => {...})` is 
transformed to `document.createElement("div")` + child handling.

## Compiler Transformations

### 1. Static Extraction

Elements with no ref access become one-time creation:

```typescript
// Source
div(() => {
  h1("Static Title")
  p("Static content")
})

// Compiled
(() => {
  const _div = document.createElement("div")
  const _h1 = document.createElement("h1")
  _h1.textContent = "Static Title"
  const _p = document.createElement("p")
  _p.textContent = "Static content"
  _div.appendChild(_h1)
  _div.appendChild(_p)
  return _div
})()
```

### 2. Reactive Expressions

Expressions accessing refs become fine-grained subscriptions:

```typescript
// Source
p(`Count: ${doc.count.get()}`)

// Compiled
(() => {
  const _p = document.createElement("p")
  const _text = document.createTextNode(`Count: ${doc.count.get()}`)
  _p.appendChild(_text)
  __subscribe(doc.count, () => {
    _text.data = `Count: ${doc.count.get()}`
  })
  return _p
})()
```

### 3. List Transformation

`for` loops over Loro lists become delta-bound regions:

```typescript
// Source
ul(() => {
  for (const item of doc.items) {
    li(item.text)
  }
})

// Compiled
(() => {
  const _ul = document.createElement("ul")
  __listRegion(_ul, doc.items, {
    create: (item) => {
      const _li = document.createElement("li")
      _li.textContent = item.text
      return _li
    },
  }, scope)
  return _ul
})()
```

### 4. Conditional Transformation

`if` statements become managed regions:

```typescript
// Source
div(() => {
  if (doc.isEmpty.get()) {
    p("No items")
  } else {
    p("Has items")
  }
})

// Compiled
(() => {
  const _div = document.createElement("div")
  const _marker = document.createComment("if")
  _div.appendChild(_marker)
  
  __conditionalRegion(_marker, doc.isEmpty, () => doc.isEmpty.get(), {
    whenTrue: () => {
      const _p = document.createElement("p")
      _p.textContent = "No items"
      return _p
    },
    whenFalse: () => {
      const _p = document.createElement("p")
      _p.textContent = "Has items"
      return _p
    },
  }, scope)
  return _div
})()
```

## Phases and Tasks

### Phase Ordering Rationale

The phases are ordered to:
1. Build runtime first (Phase 2) — tests serve as **specification** for what compiler must generate
2. Build compiler infrastructure with IR (Phase 3) — foundation for all transforms
3. **Spike list transform early** (Phase 6) — de-risk the core innovation before completing other transforms
4. Complete all transforms (Phases 4-8) — builds on proven IR foundation
5. Validate client-side fully (Phase 9) — before building SSR
6. Add SSR/hydration (Phase 10-11) — builds on working client foundation

### Phase 1: Package Scaffolding ✅

Set up the new package with proper TypeScript configuration and build tooling.

- ✅ **Task 1.1**: Create `packages/kinetic/` directory structure
- ✅ **Task 1.2**: Create `package.json` with dependencies:
  - `@loro-extended/change` (peer)
  - `loro-crdt` (peer)
  - `ts-morph` (dependency for compiler)
- ✅ **Task 1.3**: Create `tsconfig.json` extending monorepo base config
- ✅ **Task 1.4**: Create `tsup.config.ts` for ESM build (runtime + compiler separate entry points)
- ✅ **Task 1.5**: Create `verify.config.ts` for format/types/logic checks
- ✅ **Task 1.6**: Create `vitest.config.ts` for testing
- ✅ **Task 1.7**: Create `src/errors.ts` with error taxonomy
  - `KineticError` base class with error code
  - `CompilerError` with source location
  - `HydrationMismatchError` for SSR issues
  - `ScopeDisposedError` for use-after-dispose

### Phase 2: Runtime Primitives ✅

Implement the minimal runtime that compiled code calls into.

- ✅ **Task 2.1**: Create `src/runtime/mount.ts`
  - `mount(element, container)` — render to DOM
  - `dispose()` — cleanup all subscriptions
- ✅ **Task 2.2**: Create `src/runtime/subscribe.ts`
  - `__subscribe(ref, handler)` — subscribe to Loro ref changes
  - `__unsubscribe(id)` — cleanup subscription
  - Subscription registry for disposal
- ✅ **Task 2.3**: Create `src/runtime/regions.ts`
  - `__listRegion(parent, list, handlers)` — delta-based list management
  - `__conditionalRegion(marker, condition, branches)` — conditional swap
  - Region lifecycle (create, update, dispose)
- ✅ **Task 2.4**: Create `src/runtime/scope.ts`
  - `Scope` class for ownership tracking
  - Nested scopes for nested reactive regions
  - Automatic cleanup on scope disposal
  - Subscription counter for testing verification
- ✅ **Task 2.5**: Create `src/testing/counting-dom.ts`
  - DOM proxy that counts insertBefore, removeChild operations
  - Used to verify O(k) behavior in tests
- ✅ **Task 2.6**: Write unit tests for runtime primitives
  - Subscription lifecycle
  - List region delta handling **with real Loro documents** (not mocked deltas)
  - Conditional region swapping
  - Scope disposal cascades **with subscription counter verification**
  
  **Note**: These tests use hand-written "compiled-style" code that calls runtime functions directly.
  This is intentional — the tests serve as the **specification** that the compiler must match.
  When the compiler is built, its output should look like these test fixtures.

### Phase 3: Compiler Infrastructure 🔴

Set up ts-morph compiler foundation with type-based reactive detection.

**Architecture**: Functional Core / Imperative Shell separation via Intermediate Representation (IR).
Analysis produces IR (pure), code generation consumes IR (pure), orchestration is the shell.

- 🔴 **Task 3.1**: Create `src/compiler/index.ts` entry point
- 🔴 **Task 3.2**: Create `src/compiler/ir.ts` — Intermediate Representation types
  - `BuilderNode` — analyzed builder function
  - `StaticElementNode` — element with no reactive deps
  - `ReactiveElementNode` — element with reactive content/attrs
  - `ListRegionNode` — for-loop over Loro list
  - `ConditionalRegionNode` — if statement with branches
  - `BindingNode` — two-way input binding
- 🔴 **Task 3.3**: Create `src/compiler/analyze.ts` — AST → IR (pure functions)
  - `analyzeBuilder(node): BuilderNode` — main analysis entry
  - `findBuilderCalls(node)` — locate element function calls with builders
  - `isReactiveType(type)` — check if type includes any Ref type
  - `expressionIsReactive(expr)` — use TypeScript type checker to determine reactivity
  - `classifyExpression(node)` — static vs reactive based on types
  - `traceVariableReactivity(identifier)` — follow variable definitions to initializers
- 🔴 **Task 3.4**: Create `src/compiler/codegen/dom.ts` — IR → DOM code (pure functions)
  - `generateDOM(ir: BuilderNode): string`
  - createElement, appendChild, subscription generation
- 🔴 **Task 3.5**: Create `src/compiler/codegen/html.ts` — IR → HTML code (pure functions)
  - `generateHTML(ir: BuilderNode): string`
  - Template literals, escaping, hydration markers
- 🔴 **Task 3.6**: Create `src/compiler/transform.ts` — orchestration (imperative shell)
  - `transformFile(sourceFile)` — main transformation entry
  - Source map support for debugging
  - Dual output mode selection (DOM vs HTML)
- 🔴 **Task 3.7**: Write unit tests for analysis (IR output)
  - Detects builder pattern calls → correct IR nodes
  - Type-based ref detection (direct access, function args, variables)
  - Classifies static vs reactive correctly
  - Handles closures in same file
  - **Snapshot tests for IR** (readable, stable, catches regressions)
- 🔴 **Task 3.8**: Create `src/types/elements.d.ts` — Ambient element factory declarations
  - `declare function div(...)`, `declare function h1(...)`, etc. for all HTML elements
  - No runtime implementation — purely for TypeScript type checking
  - Vite plugin auto-injects these declarations into user code
  - Full `Props` and `Child` type support for autocomplete

### Phase 4: Static Extraction Transform 🔴

Compile static elements to direct DOM creation.

- 🔴 **Task 4.1**: Create `src/compiler/transforms/static.ts`
  - Transform StaticElementNode IR to DOM/HTML code
  - Handle nested static structures
  - Preserve non-builder mode (expression children)
- 🔴 **Task 4.2**: Write unit tests
  - Simple static element
  - Nested static elements
  - Mixed static children
  - **Snapshot tests for generated code** (both DOM and HTML output)

### Phase 5: Reactive Expression Transform 🔴

Compile reactive expressions to subscriptions.

- 🔴 **Task 5.1**: Create `src/compiler/transforms/reactive.ts`
  - Transform ReactiveElementNode IR to DOM/HTML code
  - Generate `__subscribe()` calls for DOM output
  - Inline evaluation for HTML output
- 🔴 **Task 5.2**: Handle reactive attributes
  - `class: () => expr` → subscription
  - `style: { prop: () => expr }` → subscription
- 🔴 **Task 5.3**: Write unit tests
  - Reactive text content
  - Reactive attributes
  - Multiple refs in one expression
  - **Snapshot tests for generated code**
- 🔴 **Task 5.4**: Create vertical slice checkpoint
  - Minimal "hello counter" example: `p(\`Count: ${doc.count.get()}\`)`
  - Compile with Vite plugin (minimal version)
  - Run in browser, verify reactive updates work
  - **Validates full pipeline before proceeding**

### Phase 6: List Transform (Core Innovation) 🔴

**Note**: The runtime `__listRegion()` is complete and O(k) verified (see Learnings section). 
This phase focuses on the **compiler transform**—detecting `for` loops over Loro lists and 
generating correct `__listRegion()` calls.

Compile `for` loops to delta-bound list regions.

- 🔴 **Task 6.1**: Create `src/compiler/transforms/list.ts`
  - Transform ListRegionNode IR to DOM/HTML code
  - Generate `__listRegion()` call with delta handlers (DOM)
  - Generate map+join pattern (HTML)
- 🔴 **Task 6.2**: Generate `create` handler and scope management
  - `create(item, index)` — return DOM node for item
  - Runtime handles insert/delete position tracking via delta processing
  - `move` support for MovableList (runtime handles DOM reordering)
  - Each item gets a child scope for cleanup on delete
- 🔴 **Task 6.3**: Handle reactive content within list items
  - Detect ref access within loop body (via IR)
  - Generate per-item subscriptions for nested reactive expressions
  - Clean up item subscriptions when item is deleted
- 🔴 **Task 6.4**: Write unit tests
  - Simple list compilation
  - List with reactive item content
  - Nested lists
  - MovableList move operations
  - **Snapshot tests for generated code**
- 🔴 **Task 6.5**: Write O(k) verification tests
  - Use counting DOM proxy from Phase 2
  - Insert into 1000-item list → assert 1 DOM insert
  - Delete from middle → assert 1 DOM remove
  - Move operation → assert reorder, not delete+insert

### Phase 7: Conditional Transform 🔴

Compile `if` statements to conditional regions.

- 🔴 **Task 7.1**: Create `src/compiler/transforms/conditional.ts`
  - Transform ConditionalRegionNode IR to DOM/HTML code
  - Generate `__conditionalRegion()` call (DOM)
  - Generate ternary with markers (HTML)
  - **Note**: Subscription target must be a container ref (TextRef, CounterRef, etc.)
    - If condition uses PlainValueRef, subscribe to parent container instead
    - Use `whenTrue`/`whenFalse` properties (not `then`/`else` - biome lint)
- 🔴 **Task 7.2**: Handle else/else-if chains
- 🔴 **Task 7.3**: Write unit tests
  - Simple if
  - If-else
  - If-else-if-else
  - Nested conditionals
  - **Snapshot tests for generated code**

### Phase 8: Input Binding Transform 🔴

Implement two-way binding for form inputs. This is a transform like the others.

- 🔴 **Task 8.1**: Create `src/runtime/binding.ts`
  - `bind(ref)` — create binding marker
  - Runtime handling for input elements
- 🔴 **Task 8.2**: Create `src/compiler/transforms/binding.ts`
  - Detect `bind()` in props
  - Generate event handler + subscription
- 🔴 **Task 8.3**: Support input types
  - `<input type="text">` — value binding
  - `<input type="checkbox">` — checked binding
  - `<select>` — value binding
- 🔴 **Task 8.4**: Write unit tests
  - **Snapshot tests for generated code**

### Phase 9: Vite Plugin + Client Integration 🔴

Enable seamless development workflow and **validate full client-side flow** before building SSR.

- 🔴 **Task 9.1**: Create `src/vite/plugin.ts`
  - Transform `.ts`/`.tsx` files containing kinetic imports
  - Hot module replacement support
  - Source map passthrough
- 🔴 **Task 9.2**: Create `vite-plugin-kinetic` package export
- 🔴 **Task 9.3**: Write integration test with Vite
- 🔴 **Task 9.4**: Create `tests/compiler-runtime.test.ts`
  - Compile small snippets, execute in happy-dom
  - Mutate Loro refs, assert DOM state changes
  - Verifies compiler output + runtime work together
  - Covers: static, reactive, list, conditional, binding patterns
- 🔴 **Task 9.5**: Create `tests/integration/todo.test.ts` (client-side)
  - Full todo app with all features (list, conditionals, bindings)
  - **Must pass before proceeding to SSR**
  - Verifies client-side is production-ready
- 🔴 **Task 9.6**: Create `examples/kinetic-todo/` (client-only version)
  - Working example developers can run and modify

### Phase 10: SSR and Hydration 🔴

Server-side rendering via dual compilation (no jsdom dependency) with CRDT-based hydration.

- 🔴 **Task 10.1**: Create `src/server/render.ts`
  - `renderToString(element)` — execute server-compiled output (pure string concat)
  - No jsdom or DOM simulation required
  - HTML escaping for dynamic content
  - Hydration markers: `<!--kinetic:if:id-->`, `<!--kinetic:list:id-->`
- 🔴 **Task 10.2**: Create `src/server/serialize.ts`
  - `serializeState(doc)` — export Loro snapshot + version
  - Embed in script tag format
- 🔴 **Task 10.3**: Create `src/runtime/hydrate.ts`
  - `hydrate(element, container, { doc })` — attach to existing DOM
  - Walk and adopt existing nodes (no creation)
  - Locate regions via hydration markers
  - Attach subscriptions to adopted nodes
  - Merge server state via `loro(doc).import()`
- 🔴 **Task 10.4**: Ensure source maps work for server code
  - Error stack traces point to original source
- 🔴 **Task 10.5**: Write unit tests
  - Server output matches expected HTML (**snapshot tests**)
  - Hydration attaches without DOM modification
  - Post-hydration updates work correctly
  - State merge handles concurrent edits
- 🔴 **Task 10.6**: Write hydration resilience tests
  - Handles whitespace differences in server HTML
  - Throws `HydrationMismatchError` on missing marker
  - Throws `HydrationMismatchError` on structure mismatch
  - Handles different attribute ordering

### Phase 11: SSR Integration Test 🔴

Validate SSR + hydration with full application.

- 🔴 **Task 11.1**: Create `tests/integration/ssr.test.ts`
  - Server render todo app
  - Hydrate on client
  - Verify no DOM thrashing
  - Verify post-hydration updates work
- 🔴 **Task 11.2**: Update `examples/kinetic-todo/` with SSR support
  - Server entry point
  - Hydration in client entry
  - Full SSR example

### Phase 12: Documentation 🔴

- 🔴 **Task 12.1**: Create `packages/kinetic/README.md`
- 🔴 **Task 12.2**: Create `packages/kinetic/TECHNICAL.md`
- 🔴 **Task 12.3**: Add changeset for initial release
- 🔴 **Task 12.4**: Update root `README.md` to mention kinetic

## Tests

### Unit Tests

| File | Test Focus |
|------|------------|
| `runtime/subscribe.test.ts` | Subscription lifecycle, cleanup |
| `runtime/regions.test.ts` | List delta handling (real Loro docs), conditional swap |
| `runtime/scope.test.ts` | Nested scopes, cascade disposal, subscription counting |
| `compiler/analyze.test.ts` | Ref access detection, classification, **IR snapshots** |
| `compiler/transforms/static.test.ts` | Static element compilation, **code snapshots** |
| `compiler/transforms/reactive.test.ts` | Expression subscription generation, **code snapshots** |
| `compiler/transforms/list.test.ts` | For-loop to delta-region, O(k) verification, **code snapshots** |
| `compiler/transforms/conditional.test.ts` | If-statement to region, **code snapshots** |
| `compiler/transforms/binding.test.ts` | Input binding, **code snapshots** |
| `compiler-runtime.test.ts` | End-to-end: compile → execute → mutate → assert DOM |
| `vite/plugin.test.ts` | Vite integration, HMR |
| `integration/todo.test.ts` | Full client-side app (before SSR) |
| `server/render.test.ts` | SSR output correctness, **HTML snapshots** |
| `runtime/hydrate.test.ts` | Hydration adoption, resilience tests, error cases |
| `integration/ssr.test.ts` | Full SSR + hydration flow |

### Integration Test

**Client-side (Phase 9)**: Full todo app verifying:
- Compilation produces valid JavaScript
- List operations are O(k) (counting DOM proxy)
- Conditional regions swap correctly
- Bindings sync both directions
- Disposal cleans up all subscriptions

**SSR (Phase 11)**: Same app with:
- Server rendering to HTML string
- Hydration attaches without DOM modification
- Post-hydration reactivity works

## Transitive Effect Analysis

| Change | Direct Impact | Transitive Impact |
|--------|---------------|-------------------|
| New `kinetic` package | None — new addition | None — no existing code depends on it |
| Import `@loro-extended/change` | Uses TypedRef, loro() | None — read-only dependency |
| Import `loro-crdt` | Uses LoroList delta events | Must match version in pnpm overrides (1.10.6) |
| Import `ts-morph` | AST transformation | Build-time only, not runtime |

**Risk Assessment**: Low. Kinetic is a new package with no dependents. It only reads from existing packages.

## Resources for Implementation

### LoroExtended Files

```
packages/change/src/loro.ts              # loro() function for raw access
packages/change/src/typed-refs/base.ts   # TypedRef base class
packages/change/src/typed-refs/list-ref.ts  # ListRef implementation
packages/change/src/types.ts             # TypedRef type definitions (for compiler detection)
packages/change/TECHNICAL.md             # Ref internals documentation
```

### Loro Delta Structure

```typescript
// LoroList subscription provides deltas:
loro(listRef).subscribe((event) => {
  for (const diff of event.diff) {
    if (diff.type === "list") {
      // diff.diff is array of: { retain?: number, insert?: T[], delete?: number }
      let index = 0
      for (const op of diff.diff) {
        if (op.retain) index += op.retain
        if (op.insert) { /* insert items at index */ }
        if (op.delete) { /* delete count items at index */ }
      }
    }
  }
})
```

### ts-morph Resources

```typescript
import { Project, SyntaxKind } from "ts-morph"

const project = new Project()
const sourceFile = project.createSourceFile("temp.ts", sourceCode)

// Find all call expressions
sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)

// Check if function is arrow with block body (builder pattern)
callExpr.getArguments()[0].getKind() === SyntaxKind.ArrowFunction

// Transform and emit
sourceFile.replaceWithText(newCode)
project.emit()
```

## File Structure

```
packages/kinetic/
├── src/
│   ├── index.ts              # Public API (mount, bind, runtime internals)
│   ├── errors.ts             # Error taxonomy (KineticError, CompilerError, etc.)
│   ├── types.ts              # Runtime type definitions (Props, Child, Binding, etc.)
│   ├── types/
│   │   └── elements.d.ts     # Ambient element factory declarations (div, h1, etc.)
│   ├── runtime/
│   │   ├── index.ts          # Runtime exports
│   │   ├── mount.ts          # mount(), dispose()
│   │   ├── subscribe.ts      # __subscribe(), subscription registry
│   │   ├── regions.ts        # __listRegion(), __conditionalRegion()
│   │   ├── scope.ts          # Scope ownership tracking
│   │   └── binding.ts        # bind() runtime support
│   ├── compiler/
│   │   ├── index.ts          # Compiler entry point
│   │   ├── ir.ts             # Intermediate Representation types
│   │   ├── analyze.ts        # AST → IR (pure functions)
│   │   ├── transform.ts      # Orchestration (imperative shell)
│   │   ├── transforms/
│   │   │   ├── static.ts     # StaticElementNode handling
│   │   │   ├── reactive.ts   # ReactiveElementNode handling
│   │   │   ├── list.ts       # ListRegionNode handling
│   │   │   ├── conditional.ts # ConditionalRegionNode handling
│   │   │   └── binding.ts    # BindingNode handling
│   │   └── codegen/
│   │       ├── dom.ts        # IR → DOM code (pure)
│   │       └── html.ts       # IR → HTML code (pure)
│   ├── testing/
│   │   └── counting-dom.ts   # DOM proxy for O(k) verification
│   ├── vite/
│   │   └── plugin.ts         # Vite plugin
│   └── server/
│       ├── render.ts         # renderToString()
│       └── serialize.ts      # serializeState()
├── tests/
│   ├── runtime/
│   │   ├── subscribe.test.ts
│   │   ├── regions.test.ts
│   │   └── scope.test.ts
│   ├── compiler/
│   │   ├── analyze.test.ts
│   │   └── transforms/
│   │       ├── static.test.ts
│   │       ├── reactive.test.ts
│   │       ├── list.test.ts
│   │       └── conditional.test.ts
│   ├── server/
│   │   └── render.test.ts
│   ├── vite/
│   │   └── plugin.test.ts
│   └── integration/
│       ├── todo.test.ts      # Client-side (Phase 9)
│       └── ssr.test.ts       # SSR + hydration (Phase 11)
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── verify.config.ts
├── vitest.config.ts
├── README.md
└── TECHNICAL.md
```

## Changeset

Required — new package introduction.

```markdown
---
"@loro-extended/kinetic": minor
---

Initial release of Kinetic — a compiled delta-driven UI framework for Loro documents.

Key features:
- Write natural TypeScript with `if`/`for` control flow
- Compiles to O(k) delta-driven DOM operations
- No virtual DOM, no diffing, no framework overhead
- Full LSP support — editor understands uncompiled source
- Vite plugin for seamless development workflow
- Seamless integration with @loro-extended/change
```

## README Updates

Add to root README.md package table:

```markdown
| **[`@loro-extended/kinetic`](./packages/kinetic)** | **The UI Layer (Experimental).** Compiles natural TypeScript to delta-driven DOM operations. Write `if`/`for`, get O(k) updates. |
```

## TECHNICAL.md Updates

Add new section to root TECHNICAL.md:

```markdown
## Kinetic Architecture

Kinetic is a compiled UI layer that transforms natural TypeScript into delta-driven DOM operations.

### Why Compilation?

Traditional reactive frameworks must *discover* what changed by comparing state snapshots (O(n) diffing).
Loro *provides* what changed as operation deltas. Kinetic's compiler bridges this gap by:

1. Analyzing which Loro refs are accessed in each expression
2. Generating fine-grained subscriptions for reactive expressions
3. Transforming `for` loops into delta-bound list regions
4. Transforming `if` statements into managed conditional regions

### The Builder Pattern

Element functions accept either children or a builder callback:

```typescript
// Children mode (compiled to static DOM creation)
div(h1("Title"), p("Content"))

// Builder mode (enables control flow)
div(() => {
  h1("Title")
  if (condition) { p("Conditional") }
  for (const item of list) { li(item.text) }
})
```

Both are valid TypeScript with full LSP support. The builder mode is what enables natural control flow.

### Delta-Based List Updates

When the compiler sees `for (const item of doc.items)`:

1. It detects `doc.items` is a Loro list ref
2. It extracts the loop body into create/update handlers
3. It generates a `__listRegion()` call that subscribes to Loro deltas
4. Deltas like `[{ retain: 2 }, { insert: [item] }]` map directly to DOM operations

This is O(k) where k = number of operations, not O(n) where n = list length.

### Scope-Based Cleanup

Each reactive region (list, conditional) creates a `Scope` that owns its subscriptions.
When a region is destroyed (item deleted, condition becomes false), its scope disposes
all nested subscriptions automatically. This prevents memory leaks without manual cleanup.
```

## Open Questions (To Resolve During Implementation)

1. **Contenteditable binding**: Full text editing with Loro Text is complex (IME, selection, etc.). 
   Start with `<input>` binding only. Defer contenteditable to future work or separate package.

2. **TypeScript version**: ts-morph requires specific TS version compatibility.
   Pin to version matching monorepo.

## Compiler Limitations (Document in TECHNICAL.md)

The compiler uses TypeScript's type system for reactive detection. Known limitations:

1. **Imported functions**: If a function is imported from another module and its body accesses refs, 
   the compiler cannot see this. Conservative approach: treat as reactive if any argument is a ref type.

2. **Dynamic property access**: `doc[someKey]` cannot be statically analyzed. 
   Treat as reactive (subscribe to entire doc).

3. **Type assertions**: `as any` or `as unknown` breaks type tracking.
   Avoid type assertions on reactive values.

4. **External libraries**: Functions from non-kinetic libraries that return ref values work correctly
   (type is preserved), but functions that *accept* refs and return derived values may need annotation.

## Learnings

### CRDT Hydration Eliminates State Divergence

Traditional SSR hydration suffers from state divergence: the server renders with state S₁, but by the time the client hydrates, its state may be S₂. This causes hydration mismatches and visual flicker.

With CRDTs, this problem disappears:

```
Server renders HTML with doc at version V₁
        ↓
HTML travels over network (includes V₁ snapshot)
        ↓
Client receives HTML + V₁
Client has doc at version V₀ (empty or cached)
        ↓
Client merges: V₀ ∪ V₁ = V₁ (Loro handles this)
        ↓
Client doc is now IDENTICAL to server render state
```

The client doesn't have "different state"—it has "less state" that gets merged to the exact same version. Hydration mismatch is impossible by construction.

If changes occurred during network transit (e.g., another user added an item), those changes arrive via sync *after* hydration completes, and apply as normal delta updates. The user sees the server-rendered content, then sees the new content appear—which is the **correct** behavior.

### Partial Hydration for Free

Because kinetic compiles to fine-grained subscriptions, we get partial hydration naturally:

- Static regions (no ref access) → zero subscriptions attached
- Reactive regions → only those subscriptions attached

We're not "hydrating the whole app"—we're attaching subscriptions only where reactivity exists. This is what frameworks like Astro and Qwik work hard to achieve; we get it from the compiler's static analysis.

### Functional Core / Imperative Shell in Compiler

The compiler follows FC/IS strictly via an Intermediate Representation (IR):

```
┌─────────────────┐    ┌─────────────┐    ┌─────────────────┐
│ analyze.ts      │    │ IR Types    │    │ codegen/*.ts    │
│ (AST → IR)      │ →  │ (Data)      │ →  │ (IR → Code)     │
│ Pure Functions  │    │ Serializable│    │ Pure Functions  │
└─────────────────┘    └─────────────┘    └─────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │ transform.ts    │
                    │ (Orchestration) │
                    │ Imperative Shell│
                    └─────────────────┘
```

Benefits:
- **Unit test analysis**: "Does this source produce this IR?" (snapshot tests)
- **Unit test codegen**: "Does this IR produce this output?" (snapshot tests)
- **IR is inspectable**: Debugging shows the intermediate structure
- **Add new targets**: New codegen without touching analysis

### Runtime Tests as Specification

Phase 2 runtime tests use hand-written "compiled-style" code:

```typescript
// Test code looks like what compiler will generate
test("list region handles insert", () => {
  const container = document.createElement("ul")
  __listRegion(container, doc.items, {
    create: (item) => {
      const li = document.createElement("li")
      li.textContent = item.text
      return li
    },
  })
  // ... assertions
})
```

This is intentional:
1. Tests define the **contract** that runtime expects
2. Compiler must generate code matching this pattern
3. When compiler is built, its output should match test fixtures
4. Any mismatch reveals either a compiler bug or a spec change

### Risk Mitigation: Early List Transform Spike

**Update (Post-Phase 2)**: The runtime `__listRegion()` implementation is complete and verified with 
real Loro documents. The O(k) behavior test passes:

```typescript
// Insert ONE item into 100-item list
doc.items.insert(50, "new-item")
loro(doc).commit()

// Verify O(1) DOM operations
assertMaxMutations(counts, 1)
expect(counts.insertBefore).toBe(1)
```

The **remaining risk** is purely in the compiler's AST analysis—can we correctly detect `for` loops 
over Loro lists and generate the right `__listRegion()` calls? This is similar in complexity to 
all other transforms, so the original "spike Phase 6 early" advice can be relaxed. The delta-to-DOM 
approach is proven; now we need the compiler to generate the proven patterns.

### Hydration Implementation is ~400 Lines

Unlike React's complex hydration (~thousands of lines), kinetic's hydration is simple:

| Component | Lines |
|-----------|-------|
| `renderToString()` | ~150 |
| `serializeState()` | ~10 |
| `hydrate()` | ~200 |
| Text node handling | ~50 |
| **Total** | ~400 |

The simplicity comes from:
1. CRDT merge guarantees state identity (no mismatch handling)
2. Compiler knows exact structure (no runtime discovery)
3. We walk and adopt, then attach—no reconciliation needed

### Type-Based Reactive Detection

The compiler uses TypeScript's type checker (via ts-morph) to determine reactivity, not syntax patterns.
This enables correct handling of complex cases:

```typescript
// All correctly detected as reactive:
p(`Count: ${doc.count.get()}`)           // Direct ref access
p(formatTitle(doc.title))                 // Function with ref argument
const count = doc.count.get()
p(`Value: ${count}`)                      // Variable assigned from ref
```

The key insight: if a value's type includes any Ref type (TextRef, ListRef, PlainValueRef, etc.),
expressions using that value are reactive. The type system already tracks this information—we just ask it.

Implementation uses `Type.getText()` to check for ref type names, plus `getDefinitionNodes()` to
trace variable initializers. For closures in the same file, we analyze the function body.

### Dual Compilation for SSR

The compiler generates two outputs from the same analysis:

| Output | Target | Generated Code |
|--------|--------|----------------|
| DOM | Client | `createElement`, `appendChild`, `__subscribe()` |
| HTML | Server | Template literals, `escapeHtml()`, hydration markers |

This eliminates the need for jsdom or any DOM simulation on the server. SSR is pure string
concatenation, which is faster and has zero runtime dependencies.

Hydration markers (`<!--kinetic:if:1-->`, `<!--kinetic:list:2-->`) allow the client to locate
regions without re-parsing the component tree.

### List Length vs List Iteration

The compiler distinguishes two subscription strategies for the same list ref:

```typescript
if (doc.items.length === 0) { ... }  // Snapshot subscription (re-evaluate on any change)
for (const item of doc.items) { ... } // Delta subscription (onInsert, onDelete, onMove)
```

The AST context (property access vs `for..of` iterator) determines which strategy to use.
This is detected during analysis, not code generation.

### Implementation Learnings (Phase 1-2)

#### Compile-Time Element Transformation (Decision)

Element factories (`div()`, `h1()`, `p()`, etc.) are **compile-time constructs only**—they do not 
exist at runtime. The compiler transforms them to direct DOM creation:

```typescript
// User writes:
div(() => {
  h1("Hello")
  p(`Count: ${doc.count.get()}`)
})

// Compiler outputs:
const _div = document.createElement("div")
const _h1 = document.createElement("h1")
_h1.textContent = "Hello"
_div.appendChild(_h1)
const _p = document.createElement("p")
__subscribeWithValue(doc.count, () => doc.count.get(), (v) => {
  _p.textContent = `Count: ${v}`
}, scope)
_div.appendChild(_p)
return _div
```

**Why not runtime factories?**

1. **Reactive detection requires compilation** — At runtime, `p(\`Count: ${doc.count.get()}\`)` 
   receives a string (`"Count: 5"`). The reactive information is lost. Only the compiler can see 
   that `doc.count` has type `CounterRef` and generate subscriptions.

2. **Zero overhead** — No function call indirection, no factory library to bundle.

3. **Aligns with "natural TypeScript" promise** — Users don't wrap expressions in `() =>` for 
   reactivity; the compiler detects it via type analysis.

**Trade-off accepted**: Code requires compilation to run (no REPL/console usage). This is acceptable 
because modern frontend development universally uses build tools (Vite), and source maps provide 
good debugging experience.

#### Biome Lint: Avoid `then` as Property Name

Biome's `noThenProperty` rule flags objects with a `then` property because it makes the object
thenable (Promise-like), causing unexpected behavior with `await`. Use alternative names:

```typescript
// ❌ Biome error
{ then: () => ..., else: () => ... }

// ✅ Renamed
{ whenTrue: () => ..., whenFalse: () => ... }
```

#### PlainValueRef Cannot Be Subscribed Directly

`PlainValueRef` (for primitive values inside structs) cannot be used as a subscription target.
The `__conditionalRegion` function requires a container ref (TextRef, CounterRef, ListRef, etc.):

```typescript
// ❌ PlainValueRef - not subscribable
const schema = Shape.doc({
  wrapper: Shape.struct({ visible: Shape.plain.boolean() })
})
__conditionalRegion(marker, doc.wrapper.visible, ...)  // ERROR

// ✅ Use a container type
const schema = Shape.doc({ count: Shape.counter() })
__conditionalRegion(marker, doc.count, () => doc.count.get() > 0, ...)
```

This affects compiler design: conditionals over plain values must subscribe to the parent container.

#### Loro Delta Event Structure

The actual delta structure from `loro(listRef).subscribe()`:

```typescript
event.events[].diff.type === "list"
event.events[].diff.diff  // Array of Delta<T[]>

// Delta operations (processed sequentially)
{ retain?: number }  // Skip items (advance index)
{ insert?: T[] }     // Insert at current index (then advance)
{ delete?: number }  // Delete at current index (don't advance)
```

#### Scope Cleanup Order

JavaScript `Set` iteration is insertion order. When a parent scope disposes:
1. Children dispose in insertion order (not reverse)
2. Parent's own cleanups call in LIFO order

#### DOM Testing Without jsdom Environment

Direct jsdom usage is lighter than vitest's `environment: "jsdom"`:

```typescript
import { JSDOM } from "jsdom"
const dom = new JSDOM("<!DOCTYPE html><body></body></html>")
global.document = dom.window.document
```

#### TypedRef Not Exported

`@loro-extended/change` exports specific ref types but not the base `TypedRef`:

```typescript
// ✅ Available
import type { TextRef, CounterRef, ListRef, ... } from "@loro-extended/change"

// ❌ Internal only
import type { TypedRef } from "@loro-extended/change"
```