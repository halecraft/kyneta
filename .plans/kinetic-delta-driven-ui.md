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

### Phase 3: Compiler Infrastructure ✅

Set up ts-morph compiler foundation with type-based reactive detection.

**Architecture**: Functional Core / Imperative Shell separation via Intermediate Representation (IR).
Analysis produces IR (pure), code generation consumes IR (pure), orchestration is the shell.

- ✅ **Task 3.1**: Create `src/compiler/index.ts` entry point
- ✅ **Task 3.2**: Create `src/compiler/ir.ts` — Intermediate Representation types
  - `BuilderNode` — analyzed builder function
  - `ElementNode` — element with attributes, handlers, children
  - `TextNode`, `ExpressionNode` — content types
  - `ListRegionNode` — for-loop over Loro list
  - `ConditionalRegionNode` — if statement with branches
  - `BindingNode` — two-way input binding
- ✅ **Task 3.3**: Create `src/compiler/analyze.ts` — AST → IR (pure functions)
  - `analyzeBuilder(node): BuilderNode` — main analysis entry
  - `findBuilderCalls(node)` — locate element function calls with builders
  - `isReactiveType(type)` — check if type includes any Ref type
  - `expressionIsReactive(expr)` — use TypeScript type checker to determine reactivity
  - `extractDependencies(expr)` — extract reactive ref sources
  - `analyzeStatement()` — statement analysis for control flow
- ✅ **Task 3.4**: Create `src/compiler/codegen/dom.ts` — IR → DOM code (pure functions)
  - `generateDOM(ir: BuilderNode): string`
  - createElement, appendChild, subscription generation
- ✅ **Task 3.5**: Create `src/compiler/codegen/html.ts` — IR → HTML code (pure functions)
  - `generateHTML(ir: BuilderNode): string`
  - Template literals, escaping, hydration markers
- ✅ **Task 3.6**: Create `src/compiler/transform.ts` — orchestration (imperative shell)
  - `transformFile(sourceFile)` — main transformation entry
  - `transformSource(source)` — string input entry point
  - `hasBuilderCalls()` — quick detection for Vite plugin
  - Dual output mode selection (DOM vs HTML)
- ✅ **Task 3.7**: Write unit tests for analysis (IR output)
  - Detects builder pattern calls → correct IR nodes
  - Type-based ref detection (direct access, function args, variables)
  - Classifies static vs reactive correctly
  - IR serialization tests (JSON.stringify works)
  - 55 new tests covering analysis and codegen
- ✅ **Task 3.8**: Create `src/types/elements.d.ts` — Ambient element factory declarations
  - `declare function div(...)`, `declare function h1(...)`, etc. for all HTML elements
  - No runtime implementation — purely for TypeScript type checking
  - Full `Props` and `Child` type support for autocomplete

### Phase 4: Vertical Slice — Static Compilation ✅

**Note**: Phase 3 already created `codegen/dom.ts` and `codegen/html.ts` which handle all IR node 
types. Phases 4-7 are now about **validation and refinement**, not creating new transform files.

Validate static element compilation end-to-end.

- ✅ **Task 4.1**: Create compiler integration test with real TypeScript source
  - Compile `div(() => { h1("Hello") })` → verify DOM output
  - Compile same source with `target: "html"` → verify HTML output
  - Verify both outputs are syntactically valid
- ✅ **Task 4.2**: Test nested static structures
  - Deeply nested elements preserve structure
  - Mixed text and element children
  - Props/attributes applied correctly
- ✅ **Task 4.3**: Fix any issues discovered in codegen
  - Fixed `findBuilderCalls` to only return top-level builders, not nested ones
  - Fixed `analyzeProps` to strip quotes from property names like `"data-testid"`

### Phase 5: Vertical Slice — Reactive Expressions ✅

Validate reactive expression compilation with real Loro types.

- ✅ **Task 5.1**: Create test fixture with Loro type definitions
  - Mock `@loro-extended/change` types already exist in `addLoroTypes()` test helper
  - Verified `isReactiveType()` correctly identifies refs (existing tests)
- ✅ **Task 5.2**: Test reactive text content
  - `p(doc.count.get())` → generates `__subscribeWithValue` call
  - Template literal `p(\`Count: ${doc.count.get()}\`)` → same
  - **Bug fix**: Non-element CallExpression args were being dropped; now fall back to expression analysis
- ✅ **Task 5.3**: Test reactive attributes
  - `div({ class: doc.className.toString() })` → attribute subscription
- ✅ **Task 5.4**: Reactive integration tests (extend Phase 4 pattern)
  - Added 9 reactive tests to `integration.test.ts` using real Loro documents
  - Tests cover: counter increment, text updates, subscription cleanup, multiple reactive expressions
  - **Note**: Browser validation deferred to Phase 9 when Vite plugin is ready

### Phase 6: Vertical Slice — List Regions ✅

**Note**: Runtime `__listRegion()` is complete and O(k) verified. This phase validates the 
compiler correctly generates calls to it.

Validate list region compilation.

- ✅ **Task 6.1**: Test for-of detection
  - `for (const item of doc.items)` → `ListRegionNode` in IR
  - Verified `listSource` and `itemVariable` captured correctly
  - Tested with index: `for (const [i, item] of doc.items.entries())`
- ✅ **Task 6.2**: Test generated `__listRegion` call
  - Verified `create` handler body matches loop body
  - Verified scope parameter passed correctly
  - Verified index variable name used when provided
- ✅ **Task 6.3**: Test nested reactive content in list items
  - Static content in list items works correctly
  - Item variable treated as expression in list body
- ✅ **Task 6.4**: O(k) verification with compiled code
  - Verified initial rendering of list items
  - Insert into list → confirmed O(1) DOM operation (1 insertBefore)
  - Delete from list → confirmed O(1) DOM operation (1 removeChild)
  - Item scope cleanup verified on delete

### Phase 7: Vertical Slice — Conditional Regions ✅

Validate conditional region compilation.

- ✅ **Task 7.1**: Test if detection
  - `if (doc.count.get() > 0)` → `ConditionalRegionNode` in IR
  - Verified `subscriptionTarget` extracted from condition
  - Verified condition expression source captured correctly
- ✅ **Task 7.2**: Test generated `__conditionalRegion` call
  - Verified `whenTrue`/`whenFalse` handlers match branches
  - Verified marker comment created (`document.createComment("kinetic:if")`)
- ✅ **Task 7.3**: Test else/else-if chains
  - `if/else` → two branches (verified)
  - `if/else if/else` → three branches with correct conditions (verified)
  - Branch body content captured correctly
- ✅ **Task 7.4**: Compile-and-execute integration
  - Verifies full pipeline: source → IR → codegen → execute
  - Reactive branch switching with real Loro document
  - Generated code structure matches expected pattern
  - **Note**: Runtime behavior tests are in `regions.test.ts` (not duplicated here)

### Phase 8: Input Binding Transform 🔴

Implement two-way binding for form inputs.

- 🔴 **Task 8.1**: Create `src/runtime/binding.ts`
  - `bind(ref)` — create binding marker object
  - Runtime handling for attaching input listeners
- 🔴 **Task 8.2**: Add binding detection to `analyze.ts`
  - Detect `bind()` calls in props
  - Create `BindingNode` in IR
- 🔴 **Task 8.3**: Add binding codegen to `codegen/dom.ts`
  - Generate event handler (onInput/onChange)
  - Generate subscription for initial value
- 🔴 **Task 8.4**: Support input types
  - `<input type="text">` — value binding via `onInput`
  - `<input type="checkbox">` — checked binding via `onChange`
  - `<select>` — value binding via `onChange`
- 🔴 **Task 8.5**: Write unit tests

### Phase 9: Vite Plugin + Client Integration 🔴

Enable seamless development workflow and **validate full client-side flow** before building SSR.

- 🔴 **Task 9.1**: Create `src/vite/plugin.ts`
  - Transform `.ts`/`.tsx` files containing kinetic imports
  - Hot module replacement support
  - Source map passthrough
- 🔴 **Task 9.2**: Create `vite-plugin-kinetic` package export
- 🔴 **Task 9.3**: Write integration test with Vite
- 🔴 **Task 9.4**: Extend `integration.test.ts` for full coverage
  - Phase 4 established the compile-and-execute test pattern
  - Add tests for binding patterns (Phase 8 feature)
  - Verify all patterns work together in combined scenarios
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

**Current test count**: 240 tests (as of Phase 7)

### Unit Tests

| File | Test Focus |
|------|------------|
| `runtime/subscribe.test.ts` | Subscription lifecycle, cleanup |
| `runtime/regions.test.ts` | List delta handling, conditional swap (**canonical runtime tests**) |
| `runtime/scope.test.ts` | Nested scopes, cascade disposal, subscription counting |
| `compiler/ir.test.ts` | IR node creation, dependency collection |
| `compiler/analyze.test.ts` | AST → IR analysis, reactive detection |
| `compiler/codegen/dom.test.ts` | IR → DOM code generation |
| `compiler/transform.test.ts` | Full pipeline orchestration tests |
| `compiler/integration.test.ts` | Compile → execute (Phases 4-7), **IR structure, codegen patterns** |
| `testing/counting-dom.test.ts` | DOM proxy for O(k) verification |
| `vite/plugin.test.ts` | Vite integration, HMR (Phase 9) |
| `tests/integration/todo.test.ts` | Full client-side app (Phase 9) |
| `server/render.test.ts` | SSR output correctness, **HTML snapshots** (Phase 10) |
| `runtime/hydrate.test.ts` | Hydration adoption, resilience tests (Phase 10) |
| `tests/integration/ssr.test.ts` | Full SSR + hydration flow (Phase 11) |

### Test Organization Guidance

**Avoid duplication**: Runtime behavior tests belong in `regions.test.ts`, not `integration.test.ts`.
Integration tests should verify:
1. **IR structure** — Does analysis produce correct nodes?
2. **Codegen patterns** — Does output contain expected code?
3. **End-to-end** — One test proving compiled code executes correctly

**Type definitions**: Source string compilation tests need inline type declarations
(see Phase 7 learnings). Runtime tests can use real Loro documents directly.

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

**Note**: The `src/compiler/transforms/` directory was originally planned but is not needed.
All transformation logic is organized within `analyze.ts` (AST → IR) and `codegen/*.ts` (IR → output).
This simpler structure works well at the current scale.

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
│   │   └── codegen/
│   │       ├── dom.ts        # IR → DOM code (pure) - handles all node types
│   │       └── html.ts       # IR → HTML code (pure) - handles all node types
│   ├── testing/
│   │   └── counting-dom.ts   # DOM proxy for O(k) verification
│   ├── vite/
│   │   └── plugin.ts         # Vite plugin
│   └── server/
│       ├── render.ts         # renderToString()
│       └── serialize.ts      # serializeState()
├── src/                        # Tests colocated with source (*.test.ts)
│   ├── runtime/*.test.ts       # Runtime unit tests
│   ├── compiler/
│   │   ├── ir.test.ts          # IR dependency collection tests
│   │   ├── analyze.test.ts     # AST analysis tests
│   │   ├── transform.test.ts   # Full pipeline integration tests
│   │   └── codegen/
│   │       └── dom.test.ts     # DOM codegen tests
│   └── testing/*.test.ts       # Testing utility tests
├── tests/                      # Integration tests (separate directory)
│   ├── integration/
│   │   ├── todo.test.ts        # Client-side (Phase 9)
│   │   └── ssr.test.ts         # SSR + hydration (Phase 11)
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

### Implementation Learnings (Phase 3)

#### ts-morph Node Type Guards Require Value Import

```typescript
// ❌ Wrong - Node is type-only, causes ReferenceError at runtime
import { type Node } from "ts-morph"
if (Node.isExpression(x)) { ... }  // ReferenceError: Node is not defined

// ✅ Correct - Node must be value import for type guards
import { Node } from "ts-morph"
if (Node.isExpression(x)) { ... }  // Works
```

#### ts-morph `getArguments()` Returns `Node[]`, Not `Expression[]`

```typescript
// ❌ Type error - Node doesn't satisfy Expression
const args = call.getArguments()
for (const arg of args) {
  if (expressionIsReactive(arg)) { ... }  // Error
}

// ✅ Cast explicitly when you know they're expressions
const args = call.getArguments() as Expression[]
```

#### Block Body Access Requires Type Narrowing

ts-morph's `Statement` base type doesn't have `getStatements()`. You must narrow first:

```typescript
// ❌ Type error - Statement doesn't have getStatements()
if (stmt.getKind() === SyntaxKind.Block) {
  for (const s of stmt.getStatements()) { ... }  // Error
}

// ✅ Narrow the type first
if (stmt.getKind() === SyntaxKind.Block) {
  const block = stmt as Block
  for (const s of block.getStatements()) { ... }
}
```

Same pattern applies to `ArrayBindingPattern.getElements()`, `ExpressionStatement.getExpression()`, etc.

#### IR Node Types Simplified from Plan

**Original plan**: Separate `StaticElementNode` and `ReactiveElementNode` types.

**Actual implementation**: Single `ElementNode` type with `isReactive: boolean` flag computed from 
children and attributes. This simplifies IR handling—no type-switching needed.

#### IR Invariant to Maintain

The `createBuilder` function maintains a critical invariant that should be tested explicitly:

```typescript
builder.isReactive === (builder.allDependencies.length > 0)
```

A violation causes either unnecessary subscriptions (performance) or missing subscriptions (stale UI).

#### Balanced Delimiter Check as Syntax Validity Proxy

Testing generated code for valid JavaScript without parsing:

```typescript
const openBraces = (code.match(/{/g) || []).length
const closeBraces = (code.match(/}/g) || []).length
expect(openBraces).toBe(closeBraces)

// Also check for string concatenation errors
expect(code).not.toContain("undefined")
expect(code).not.toContain("[object Object]")
```

#### Don't Test Exact Generated Code

Generated variable names (`_el0`, `_el1`) and whitespace are implementation details:

```typescript
// ❌ Fragile - breaks on any formatting change
expect(code).toBe(`const _div0 = document.createElement("div")\n...`)

// ✅ Robust - tests structural correctness
expect(code).toContain('document.createElement("div")')
expect(code).toContain("appendChild")
```

#### Biome Flags Template Strings in Test Data

When test data contains template literal syntax (as source code representation):

```typescript
// ⚠️ Biome warning: Unexpected template string placeholder
const expr = createReactiveExpression("`Count: ${count.get()}`", ...)

// ✅ Suppress when intentional
// biome-ignore lint/suspicious/noTemplateCurlyInString: source code representation
const expr = createReactiveExpression("`Count: ${count.get()}`", ...)
```

### Implementation Learnings (Phase 4)

#### `findBuilderCalls` Must Filter Nested Calls

The initial implementation of `findBuilderCalls` returned ALL element factory calls with builders,
including nested ones. This caused each nested element to be compiled as a separate top-level
builder instead of being a child of its parent.

```typescript
// ❌ Wrong - returns all builder calls including nested
const allCalls = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)
for (const call of allCalls) {
  if (isElementFactory(call) && hasBuilder(call)) {
    calls.push(call)  // Includes nested calls!
  }
}

// ✅ Correct - filter out calls nested inside other builders
function isNestedBuilderCall(call: CallExpression): boolean {
  let current = call.getParent()
  while (current) {
    if (current.getKind() === SyntaxKind.ArrowFunction) {
      const funcParent = current.getParent()
      if (funcParent?.getKind() === SyntaxKind.CallExpression) {
        const parentCallee = (funcParent as CallExpression).getExpression()
        if (ELEMENT_FACTORIES.has(parentCallee.getText())) {
          return true  // This call is inside another builder
        }
      }
    }
    current = current.getParent()
  }
  return false
}
```

#### Property Names May Include Quotes

When using string keys in object literals like `{ "data-testid": "value" }`, ts-morph's
`getText()` returns the name WITH quotes. These must be stripped for setAttribute calls.

```typescript
// Source: div({ "data-testid": "my-id" }, () => { ... })

// ❌ Wrong - includes quotes
const name = prop.getChildAtIndex(0)?.getText()  // '"data-testid"'
_div.setAttribute(name, "my-id")  // InvalidCharacterError!

// ✅ Correct - strip quotes
let name = prop.getChildAtIndex(0)?.getText() ?? ""
if ((name.startsWith('"') && name.endsWith('"')) ||
    (name.startsWith("'") && name.endsWith("'"))) {
  name = name.slice(1, -1)
}
```

#### Integration Tests Need eval() for Generated Code

To execute generated DOM code in tests, we need to use `eval()`. This requires a biome
lint suppression since eval is flagged as a security risk.

```typescript
// biome-ignore lint/security/noGlobalEval: Test utility for executing generated code
const fn = eval(`(${generatedCode})`)
const node = fn(scope)
```

#### Multi-Line Function Extraction from Generated Code

Generated code spans multiple lines. Naive regex matching fails:

```typescript
// ❌ Wrong - only matches first line
const match = code.match(/const element\d+ = (.*)/)  // Gets "(scope) => {"

// ✅ Correct - find assignment, slice the rest
const match = code.match(/const element\d+ = /)
if (!match || match.index === undefined) throw new Error(...)
const fnCode = code.slice(match.index + match[0].length).trim()
```

#### ts-morph Property Access Indices

For `PropertyAssignment` nodes like `{ name: value }`:
- `getChildAtIndex(0)` = property name (may include quotes for string keys)
- `getChildAtIndex(1)` = colon token
- `getChildAtIndex(2)` = value expression

### Implementation Learnings (Phase 5)

#### Non-Element CallExpression Arguments Were Being Dropped

When analyzing `p(count.get())`, the `count.get()` argument is a `CallExpression`. The original
code assumed all CallExpressions were nested element calls and discarded them if `analyzeElementCall`
returned null.

```typescript
// ❌ Wrong - drops non-element call expressions like count.get()
else if (arg.getKind() === SyntaxKind.CallExpression) {
  const nestedElement = analyzeElementCall(arg as CallExpression)
  if (nestedElement) {
    children.push(nestedElement)
  }
  // If not an element call, the argument is lost!
}

// ✅ Correct - fall back to expression analysis
else if (arg.getKind() === SyntaxKind.CallExpression) {
  const nestedElement = analyzeElementCall(arg as CallExpression)
  if (nestedElement) {
    children.push(nestedElement)
  } else {
    // Not an element call - treat as expression (e.g., count.get())
    const content = analyzeExpression(arg)
    children.push(content)
  }
}
```

#### Shape.plain Types Cannot Be Used at Top Level

`Shape.plain.boolean()`, `Shape.plain.string()`, etc. can only be used inside lists or structs,
not directly at the document root level.

```typescript
// ❌ Wrong - plain values can't be at root
const schema = Shape.doc({
  isActive: Shape.plain.boolean(),  // Error!
})

// ✅ Correct - use container types at root
const schema = Shape.doc({
  isActive: Shape.counter(),  // Use counter for boolean-like behavior
  // OR wrap in a struct
  settings: Shape.struct({
    isActive: Shape.plain.boolean(),  // OK inside struct
  }),
})
```

#### Reactive Integration Tests Use Manual DOM Construction

Since executing compiled code with reactive refs requires those refs to be in scope,
the integration tests construct DOM manually and call runtime functions directly.
This validates the runtime behavior without needing to inject variables into eval scope.

```typescript
// Create real Loro document
const doc = createTypedDoc(schema)

// Create DOM manually (simulating compiled code)
const scope = new Scope("test")
const textNode = document.createTextNode("")

// Call runtime function directly
__subscribeWithValue(
  doc.counter,
  () => doc.counter.get(),
  (v) => { textNode.textContent = String(v) },
  scope,
)

// Now mutations to doc will update textNode
doc.counter.increment(1)
loro(doc).commit()
expect(textNode.textContent).toBe("1")
```

### Implementation Learnings (Phase 7)

#### Source String Compilation Requires Inline Type Definitions

When testing compiler transforms with source code strings, ts-morph's type checker resolves
types to `any` unless type definitions are explicitly available. This breaks reactive detection:

```typescript
// ❌ Types resolve to `any` - reactive detection fails
const source = `
  import { Shape, createTypedDoc } from "@loro-extended/change"
  const doc = createTypedDoc(Shape.doc({ count: Shape.counter() }))
  div(() => { if (doc.count.get() > 0) { p("Yes") } })
`
transformSource(source)  // doc.count is `any`, not detected as CounterRef

// ✅ Include inline type declarations
const source = `
  interface CounterRef { get(): number }
  declare const doc: { count: CounterRef }
  div(() => { if (doc.count.get() > 0) { p("Yes") } })
`
transformSource(source)  // CounterRef matches LORO_REF_TYPES, detected as reactive
```

**Why**: ts-morph uses an in-memory file system with no access to `node_modules`. Types
are only resolved from files explicitly added to the Project.

**Pattern**: For IR structure tests, use inline type declarations. For runtime integration
tests, use real Loro documents directly (bypassing compilation).

#### Test Separation: Compiler vs Runtime

Integration tests should NOT duplicate runtime behavior tests:

| Test File | Purpose | Example |
|-----------|---------|---------|
| `regions.test.ts` | Test runtime functions directly | `__conditionalRegion` branch swapping |
| `integration.test.ts` | Test compiler output | IR structure, generated code patterns |

**Mistake made**: Phase 7 initially added 7 tests calling `__conditionalRegion` directly,
duplicating coverage from `regions.test.ts`. These were consolidated into 1 end-to-end test.

**Guidance**: Compiler integration tests should verify:
1. IR structure is correct
2. Generated code contains expected patterns
3. One end-to-end test proving compiled code executes correctly

#### Boolean Simulation with Counter

Since `Shape.plain.boolean()` cannot be used at document root, tests use counters:

```typescript
// In tests needing boolean-like behavior
const schema = Shape.doc({ visible: Shape.counter() })
doc.visible.increment(1)  // true
doc.visible.increment(-1) // false (back to 0)

// In condition
() => doc.visible.get() > 0  // boolean expression
```

#### Phase Validation vs Implementation

Phase 7 was marked 🔴 (not started) but codegen was already complete from Phase 3.
The actual work was **validation through tests**, not implementation.

**Guidance for future phases**: Before starting, check if codegen/runtime was built
in earlier phases. The phase may be "validation only."

---

## Amendment: Engineering Improvements

**Discovered during**: Phase 6 (List Region Validation)  
**Target phase**: Phase 7 or standalone refactoring phase before Phase 9

### Preamble

After completing Phases 1-6, a comprehensive engineering review revealed several opportunities to improve code quality, reduce cognitive load, and prevent future maintenance burden. While the core architecture (Functional Core / Imperative Shell) is well-implemented, test organization and some code patterns have accumulated technical debt as the codebase grew.

The `integration.test.ts` file has grown to 1200+ lines spanning four phases (4-7). This violates the Single Responsibility Principle and makes navigation difficult. Additionally, duplicated test setup code and magic numbers in ts-morph tests create maintenance burden.

**Update after Phase 7**: Test duplication was identified and addressed—7 redundant runtime tests were removed, reducing the test count from 246 to 240 while maintaining coverage.

### Tasks

#### A.1: Split Integration Tests by Feature

**Problem**: `integration.test.ts` combines Phase 4, 5, 6 tests in one file (1130+ lines).

**Solution**: Split into feature-focused files:
```
src/compiler/integration/
  static-compilation.test.ts    # Phase 4 tests
  reactive-expressions.test.ts  # Phase 5 tests  
  list-regions.test.ts          # Phase 6 tests
  conditional-regions.test.ts   # Phase 7 tests
```

**Note**: After Phase 7 consolidation, conditional region tests are now minimal (10 tests).
Consider whether splitting is still necessary, or if the single file is manageable.

#### A.2: Create Shared Test Setup Utility

**Problem**: JSDOM setup is duplicated in `integration.test.ts`, `regions.test.ts`, `mount.test.ts`.

**Solution**: Create `testing/setup-dom.ts`:
```typescript
export function setupDOMGlobals() {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>")
  Object.assign(global, {
    document: dom.window.document,
    Node: dom.window.Node,
    Element: dom.window.Element,
    Comment: dom.window.Comment,
    Text: dom.window.Text,
  })
  return dom
}
```

#### A.3: Replace Magic Numbers with SyntaxKind Enum

**Problem**: Tests use opaque numbers like `213`, `228` for AST node kinds.

**Solution**: Use `SyntaxKind` enum:
```typescript
// ❌ Wrong
const callExpr = sourceFile.getDescendantsOfKind(213)[0]

// ✅ Correct
import { SyntaxKind } from "ts-morph"
const callExpr = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)[0]
```

#### A.4: Use IR Type Guards Instead of `as any`

**Problem**: Tests cast to `any` instead of using existing type guards.

**Solution**: Use the type guards already defined in `ir.ts`:
```typescript
// ❌ Wrong
const listRegion = result.ir[0].children[0] as any
expect(listRegion.kind).toBe("list-region")

// ✅ Correct
import { isListRegionNode } from "../ir.js"
const child = result.ir[0].children[0]
if (isListRegionNode(child)) {
  expect(child.listSource).toBe("items")
}
```

#### A.5: Refactor Attribute Handling to Lookup Table

**Problem**: `generateAttributeSet` in `codegen/dom.ts` has repetitive if/else chains.

**Solution**: Use a lookup table pattern:
```typescript
const SPECIAL_ATTRIBUTES: Record<string, (el: string, code: string) => string> = {
  class: (el, code) => `${el}.className = ${code}`,
  value: (el, code) => `${el}.value = ${code}`,
  checked: (el, code) => `${el}.checked = ${code}`,
  disabled: (el, code) => `${el}.disabled = ${code}`,
}
```

#### A.6: Add Development-Mode IR Validation

**Problem**: IR factory functions silently accept invalid inputs.

**Solution**: Add assertions in development:
```typescript
export function createTextNode(value: string, span: SourceSpan): TextNode {
  if (process.env.NODE_ENV !== "production") {
    if (typeof value !== "string") {
      throw new Error(`createTextNode: value must be string, got ${typeof value}`)
    }
  }
  return { kind: "text", value, span }
}
```

### Priority

| Task | Priority | Effort | Impact |
|------|----------|--------|--------|
| A.1 | High | Medium | Reduces cognitive load significantly |
| A.2 | High | Low | Eliminates duplication, easier test maintenance |
| A.3 | Medium | Low | Prevents fragile tests breaking on ts-morph updates |
| A.4 | Medium | Low | Better type safety, uses existing code |
| A.5 | Low | Low | Cleaner code, easier to add attributes |
| A.6 | Low | Low | Catches bugs earlier in development |

### Implementation Notes

- A.1 requires moving tests to a subdirectory, updating imports
- A.2 should be done first as A.1 depends on it
- A.3 and A.4 can be done incrementally as tests are touched
- A.5 and A.6 are independent refactors

These improvements should be completed before Phase 9 (Vite Plugin) when external developers will start using the package.