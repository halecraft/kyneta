# Kinetic Technical Documentation

This document provides technical details about the Kinetic compiler architecture, intermediate representation (IR), and code generation strategies.

## Architecture Overview

Kinetic follows a **Functional Core / Imperative Shell** architecture via an Intermediate Representation (IR):

```
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ analyze.ts      │    │ IR Types        │    │ codegen/*.ts    │
│ (AST → IR)      │ →  │ (Data)          │ →  │ (IR → Code)     │
│ Pure Functions  │    │ Serializable    │    │ Pure Functions  │
└─────────────────┘    └─────────────────┘    └─────────────────┘
```

- **Analysis** (`analyze.ts`): Transforms TypeScript AST into IR nodes
- **IR** (`ir.ts`): Serializable data structures representing the UI
- **Codegen** (`codegen/dom.ts`, `codegen/html.ts`): Transforms IR into JavaScript code

## Intermediate Representation (IR)

### Core Node Types

#### `ElementNode`
Represents an HTML element with attributes, event handlers, and children.

```typescript
interface ElementNode {
  kind: "element"
  tag: string                    // e.g., "div", "p", "input"
  attributes: AttributeNode[]    // Static and reactive attributes
  eventHandlers: EventHandlerNode[]
  children: ChildNode[]
  bindings: ElementBinding[]     // Two-way bindings (bind())
  isReactive: boolean           // Whether any content is reactive
}
```

#### `TextNode`
Static text content.

```typescript
interface TextNode {
  kind: "text"
  value: string
}
```

#### `ExpressionNode`
Dynamic content that may be static or reactive.

```typescript
interface ExpressionNode {
  kind: "expression"
  source: string                 // Original source code
  expressionKind: "static" | "reactive"
  dependencies: string[]         // Reactive dependencies (e.g., "doc.title")
}
```

### Control Flow Nodes

#### `ListRegionNode`
Reactive list iteration (delta-driven updates).

```typescript
interface ListRegionNode {
  kind: "list-region"
  listSource: string            // e.g., "doc.todos"
  itemVariable: string          // e.g., "item"
  indexVariable: string | null  // e.g., "i" (optional)
  body: ChildNode[]             // Template for each item
  hasReactiveItems: boolean
}
```

#### `ConditionalRegionNode`
Reactive conditional rendering.

```typescript
interface ConditionalRegionNode {
  kind: "conditional-region"
  branches: ConditionalBranch[]
  subscriptionTarget: string | null  // Reactive dependency
}

interface ConditionalBranch {
  condition: ExpressionNode | null  // null = else branch
  body: ChildNode[]
}
```

### Statement Preservation Nodes

These nodes support arbitrary TypeScript statements in builder functions.

#### `StatementNode`
Preserves arbitrary TypeScript statements that aren't UI constructs.

```typescript
interface StatementNode {
  kind: "statement"
  source: string  // Original source text, emitted verbatim
}
```

**Examples of captured statements:**
- Variable declarations: `const item = itemRef.get()`
- Expression statements: `console.log("debug")`
- Function calls: `doSomething()`

**Not captured as statements:**
- Element factory calls → `ElementNode`
- Reactive `for...of` → `ListRegionNode`
- Reactive `if` → `ConditionalRegionNode`
- Block statements → recursively analyzed
- Return statements → compile-time error

#### `StaticLoopNode`
Non-reactive `for...of` loops that run once at render time.

```typescript
interface StaticLoopNode {
  kind: "static-loop"
  iterableSource: string        // e.g., "[1, 2, 3]"
  itemVariable: string          // e.g., "x"
  indexVariable: string | null
  body: ChildNode[]
}
```

#### `StaticConditionalNode`
Non-reactive `if` statements that evaluate once at render time.

```typescript
interface StaticConditionalNode {
  kind: "static-conditional"
  conditionSource: string       // e.g., "true", "items.length > 0"
  thenBody: ChildNode[]
  elseBody: ChildNode[] | null
}
```

### Union Type

All child nodes are unified under `ChildNode`:

```typescript
type ChildNode =
  | ElementNode
  | TextNode
  | ExpressionNode
  | ListRegionNode
  | ConditionalRegionNode
  | BindingNode
  | StatementNode
  | StaticLoopNode
  | StaticConditionalNode
```

## Code Generation

### DOM Codegen (`codegen/dom.ts`)

Generates imperative JavaScript that creates and manipulates DOM nodes.

**Output pattern:**
```javascript
(scope) => {
  const _div0 = document.createElement("div")
  const _p1 = document.createElement("p")
  _p1.textContent = "Hello"
  _div0.appendChild(_p1)
  return _div0
}
```

**Statement handling:** Statements are emitted verbatim with proper indentation.

```javascript
// Input: for (const x of [1,2,3]) { const doubled = x * 2; li(doubled) }
// Output:
for (const x of [1, 2, 3]) {
  const doubled = x * 2
  const _li0 = document.createElement("li")
  _li0.textContent = String(doubled)
  _div0.appendChild(_li0)
}
```

### HTML Codegen (`codegen/html.ts`)

Generates JavaScript that produces HTML strings via template literals.

**Output pattern:**
```javascript
() => `<div><p>Hello</p></div>`
```

**Block body accumulation pattern:**

For list regions and conditionals, HTML codegen uses a block body with accumulation:

```javascript
[...items].map((itemRef, _i) => {
  let _html = "";
  const item = itemRef.get();     // statement preserved — unwrap ref
  console.log("before");          // statement preserved
  _html += `<li>${item}</li>`;    // HTML accumulated
  console.log("after");           // statement preserved
  return _html
}).join("")
```

Note: HTML codegen uses spread syntax `[...items]` instead of `.toArray()` to
preserve `PlainValueRef` for value shapes, enabling two-way binding patterns.

This pattern:
1. Enables statements to execute between HTML generation
2. Preserves side effect ordering
3. Works consistently for all body contexts

**Static loop generation:**
```javascript
// Input: for (const x of [1, 2, 3]) { li(x) }
// Output:
${[1, 2, 3].map((x) => { let _html = ""; _html += `<li>${x}</li>`; return _html }).join("")}
```

**Static conditional generation:**
```javascript
// Input: if (condition) { p("yes") } else { p("no") }
// Output:
${(() => { if (condition) { let _html = ""; _html += `<p>yes</p>`; return _html } else { let _html = ""; _html += `<p>no</p>`; return _html } })()}
```

## Reactive Detection

The compiler detects reactive types by analyzing TypeScript's type system:

1. **Direct ref types**: `TextRef`, `CounterRef`, `ListRef<T>`, etc.
2. **Method calls on refs**: `doc.title.get()`, `doc.count.value`
3. **Property access chains**: `doc.items[0].get()`

When a reactive type is detected:
- Expressions become `ExpressionNode` with `expressionKind: "reactive"`
- Loops over `ListRef` become `ListRegionNode`
- Conditionals with reactive conditions become `ConditionalRegionNode`

Non-reactive equivalents:
- Static expressions: `expressionKind: "static"`
- Static loops: `StaticLoopNode`
- Static conditionals: `StaticConditionalNode`

## Design Decisions

### Always Block Body in HTML Codegen

We always use block body (`() => { ... }`) instead of expression body (`() => x`) in HTML codegen, even when there are no statements. Benefits:

1. Single code path (no conditional logic)
2. Preserves interleaving for side effects
3. Consistent with DOM codegen
4. Negligible runtime overhead

### Statement Capture Scope

Only "leaf" statements become `StatementNode`:
- Variable declarations ✓
- Expression statements (non-element) ✓
- Block statements → recursively analyzed (not captured)
- Return statements → compile-time error

### Return Statement Error

Builder functions have a contract: they produce DOM nodes or HTML strings. Early `return` breaks this contract. We emit a compile-time error with line number rather than generating broken code:

```
Kinetic Compiler Error: Return statement not supported in builder function at line 5.
Builder functions must produce DOM elements, not return early.
```

### Static vs Reactive Control Flow

The compiler distinguishes between:
- **Reactive**: Subscribes to changes, delta-driven updates
- **Static**: Evaluates once at render time

Users don't need to know this distinction — both "just work" with natural TypeScript syntax. The compiler analyzes the iterable/condition to determine which to use.

## File Structure

```
packages/kinetic/src/compiler/
├── analyze.ts          # AST → IR analysis
├── analyze.test.ts     # Analysis unit tests
├── ir.ts               # IR type definitions and factories
├── ir.test.ts          # IR unit tests
├── transform.ts        # Orchestrates analysis + codegen
├── transform.test.ts   # Transform tests
├── integration.test.ts # End-to-end compilation tests
└── codegen/
    ├── dom.ts          # DOM code generation
    ├── dom.test.ts     # DOM codegen tests
    ├── html.ts         # HTML code generation
    └── html.test.ts    # HTML codegen tests
```

## Runtime Dependencies

Generated code calls these runtime functions:

- `__subscribeWithValue(ref, getter, callback, scope)` — Reactive subscriptions
- `__listRegion(parent, list, handlers, scope)` — Delta-driven list rendering
- `__conditionalRegion(marker, target, condition, handlers, scope)` — Reactive conditionals
- `__staticConditionalRegion(marker, condition, handlers, scope)` — Static conditionals
- `__bindTextValue(input, ref, scope)` — Two-way text binding
- `__bindChecked(input, ref, scope)` — Two-way checkbox binding

All runtime functions accept a `scope` parameter for cleanup tracking.

### List Region Architecture

The `__listRegion` runtime follows **Functional Core / Imperative Shell** pattern:

**Functional Core** (pure, testable):
- `planInitialRender(listRef)` → `ListRegionOp<T>[]`
- `planDeltaOps(listRef, event)` → `ListRegionOp<T>[]`

**Imperative Shell** (DOM manipulation):
- `executeOp(parent, state, handlers, op)` — applies single operation

Both planning functions use `listRef.get(index)` to obtain refs, ensuring
handlers always receive `PlainValueRef<T>` for value shapes. This enables
the component pattern where refs are passed for two-way binding:

```typescript
for (const itemRef of doc.items) {
  const item = itemRef.get()  // Read current value
  li({ onClick: () => itemRef.set(item.toUpperCase()) }, item)  // Can write!
}
```

**Key design decisions:**
1. Use `listRef.get(index)` instead of `.toArray()` for ref preservation
2. Delta inserts use `listRef.get(index)` (not raw event values)
3. Store `listRef` in state for delta handling
4. HTML codegen uses `[...listSource]` (iterator returns refs)

### Region Algebra

All region types (list, conditional) share a common algebraic structure based on three principles:

#### The Trackability Invariant

Every node inserted into the DOM must remain trackable for removal. This is enforced through the `TrackedNode` type:

```typescript
interface TrackedNode {
  readonly node: Node  // Never an empty DocumentFragment
}
```

When a `DocumentFragment` is inserted, its children are moved to the parent and the fragment becomes empty. The `insertAndTrack()` helper handles this by tracking the first child instead of the empty fragment, guaranteeing the invariant: "The referenced node is a direct child of the parent it was inserted into."

#### Functional Core / Imperative Shell

Both region types follow FC/IS for testability and clarity:

| Region Type | Planning (Pure) | Execution (Imperative) |
|-------------|-----------------|------------------------|
| List | `planInitialRender()`, `planDeltaOps()` | `executeOps()` |
| Conditional | `planConditionalUpdate()` | `executeConditionalOp()` |

The planning functions are pure — they take state and return operations without side effects. The execution functions apply those operations to the DOM.

**Conditional region operations:**
```typescript
type ConditionalRegionOp =
  | { kind: "noop" }
  | { kind: "insert"; branch: "true" | "false" }
  | { kind: "delete" }
  | { kind: "swap"; toBranch: "true" | "false" }
```

#### Unified State Types

Both region types extend `RegionStateBase`:

```typescript
interface RegionStateBase {
  parentScope: Scope
}

interface ListRegionState<T> extends RegionStateBase {
  nodes: TrackedNode[]
  scopes: Scope[]
  listRef: ListRefLike<T>
}

interface ConditionalRegionState extends RegionStateBase {
  currentBranch: "true" | "false" | null
  currentNode: TrackedNode | null
  currentScope: Scope | null
}
```

This unified structure makes the region system easier to understand, test, and extend.