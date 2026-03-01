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

## DOM Algebra: Applicative/Monadic Decomposition

Kinetic's compilation pipeline performs **partial evaluation** at three stages, decomposing UI code into Applicative (static structure) and Monadic (dynamic structure) layers.

### Binding-Time Analysis

The compiler classifies values by **when they become known**:

```typescript
type BindingTime = "literal" | "render" | "reactive"
```

- **literal**: Value known at compile time (string literals like `"Hello"`)
- **render**: Value known at render time (static expressions like `42`, `someVar`)
- **reactive**: Value varies at runtime (reactive expressions like `doc.count.get()`)

This classification enables **binding-time promotion**: when branches diverge only in values, literals and render-time values can be promoted to reactive with ternary expressions.

### ContentValue: Unified Content Representation

All content (text, attribute values, etc.) is represented by a single type:

```typescript
interface ContentValue {
  kind: "content"
  source: string              // JSON string for literals, JS expression otherwise
  bindingTime: BindingTime
  dependencies: string[]      // Reactive deps (e.g., ["doc.count"])
  span: SourceSpan
}
```

This replaces the previous `TextNode | ExpressionNode` union, making binding-time explicit and eliminating cross-product complexity in tree merge logic.

### Slots: Trackable DOM Handles

A **Slot** is a runtime handle to DOM content that can be removed:

```typescript
type Slot =
  | { kind: "single"; node: Node }
  | { kind: "range"; startMarker: Comment; endMarker: Comment }
```

**SlotKind** is computed at compile time from IR body structure:

```typescript
type SlotKind = "single" | "range"

function computeSlotKind(body: ChildNode[]): SlotKind {
  // Returns "single" if body produces exactly one DOM node
  // Returns "range" otherwise (zero, multiple, or regions)
}
```

The SlotKind flows from IR → codegen → runtime, enabling optimization:
- When `slotKind: "single"` is provided, `claimSlot()` avoids runtime `nodeType` inspection
- Handler objects include optional `slotKind` field
- Runtime dispatches on compile-time knowledge instead of runtime checks

### Tree Merge and Conditional Dissolution

**Tree merge** recursively compares conditional branches to detect structural equivalence:

```typescript
function mergeConditionalBodies(
  branches: ConditionalBranch[]
): MergeResult<ChildNode[]>
```

When branches have identical structure but different values:
1. Literals/render-time values are promoted to reactive with ternaries
2. The conditional is **dissolved** into pure Applicative code
3. No `__conditionalRegion` call, no marker, no handlers

**Example dissolution:**

```typescript
// Source:
if (doc.count.get() > 0) {
  p("Yes")
} else {
  p("No")
}

// Dissolved output:
const _p0 = document.createElement("p")
const _text1 = document.createTextNode("")
_p0.appendChild(_text1)
__subscribeWithValue(doc.count, () => doc.count.get() > 0 ? "Yes" : "No", (v) => {
  _text1.textContent = String(v)
}, scope)
```

**Mergeability rules:**
- Same element tags ✓
- Same attribute names (different values OK) ✓
- Same child counts ✓
- Identical event handlers ✓
- Different tags ✗
- Reactive content with different dependencies ✗
- No else branch ✗

**N-branch support:** For `if/else-if/else` chains, nested ternaries are synthesized: `a ? X : (b ? Y : Z)`

### Optimization Levels

1. **Direct-return optimization**: Single-element bodies return element directly (no fragment)
2. **Conditional dissolution**: Structurally identical branches dissolved into ternaries
3. **Partial hoisting** (future): Shared prefix hoisted, residual remains as reduced conditional

## Intermediate Representation (IR)

### Core Node Types

#### `ContentValue`
All value-producing content (text, attribute values).

```typescript
interface ContentValue {
  kind: "content"
  source: string
  bindingTime: "literal" | "render" | "reactive"
  dependencies: string[]
  span: SourceSpan
}
```

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



### Control Flow Nodes

Control flow nodes are **parameterized by binding time** — a single type handles both render-time and reactive cases, with codegen dispatching on the binding-time field. This mirrors the `ContentValue` pattern where `bindingTime` determines behavior.

#### `LoopNode`
Unified loop representation for both render-time and reactive iteration.

```typescript
interface LoopNode {
  kind: "loop"
  iterableSource: string              // e.g., "doc.todos", "[1, 2, 3]"
  iterableBindingTime: BindingTime    // "render" or "reactive"
  itemVariable: string                // e.g., "item"
  indexVariable: string | null        // e.g., "i" (optional)
  body: ChildNode[]                   // Template for each item
  hasReactiveItems: boolean           // Computed at IR creation
  bodySlotKind: SlotKind              // Computed at IR creation
  dependencies: string[]              // Empty for render-time
}
```

**Codegen dispatch:**
- `iterableBindingTime === "render"` → inline `for...of` loop
- `iterableBindingTime === "reactive"` → `__listRegion()` with delta handlers

#### `ConditionalNode`
Unified conditional representation for both render-time and reactive branches.

```typescript
interface ConditionalNode {
  kind: "conditional"
  branches: ConditionalBranch[]       // Flat array (else-if chains not nested)
  subscriptionTarget: string | null   // null = render-time, string = reactive
}

interface ConditionalBranch {
  condition: ContentValue | null      // null = else branch
  body: ChildNode[]
  slotKind: SlotKind                  // Computed at IR creation
  span: SourceSpan
}
```

**Codegen dispatch:**
- `subscriptionTarget === null` → inline `if/else-if/else` chain
- `subscriptionTarget !== null` → attempt tree-merge dissolution, fallback to `__conditionalRegion()`

**Note:** Else-if chains always produce flat `branches` arrays, not nested conditionals. The analysis phase flattens AST nesting into the branches array.

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
- `for...of` loops → `LoopNode`
- `if` statements → `ConditionalNode`
- Block statements → recursively analyzed
- Return statements → compile-time error

### Union Type

All child nodes are unified under `ChildNode` (6 members in 3 categories):

```typescript
type ChildNode =
  | ElementNode      // Applicative: fixed structure
  | ContentValue     // Applicative: fixed structure
  | LoopNode         // Monadic: dynamic structure (binding-time parameterized)
  | ConditionalNode  // Monadic: dynamic structure (binding-time parameterized)
  | BindingNode      // Effects: side effects
  | StatementNode    // Effects: side effects
```

The taxonomy reflects the algebraic structure:
- **Applicative** nodes have fixed DOM structure at compile time
- **Monadic** nodes have dynamic structure determined by runtime values
- **Effects** nodes produce side effects without DOM structure

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

The compiler detects reactive types structurally using TypeScript's `isTypeAssignableTo`. A type is reactive if it implements the `Reactive` interface from `@loro-extended/reactive`:

```typescript
// @loro-extended/reactive
export const REACTIVE = Symbol.for("kinetic:reactive")
export type ReactiveSubscribe = (self: unknown, callback: () => void) => () => void
export interface Reactive {
  readonly [REACTIVE]: ReactiveSubscribe
}
```

Detection is implemented in `reactive-detection.ts` and works as follows:

1. **Find the `Reactive` interface** in the project's type graph (cached per project)
2. **Check `isTypeAssignableTo(candidateType, reactiveType)`** — pure structural typing
3. **Handle edge cases**: exclude `any`/`unknown`, check union branches individually

This replaces the previous approach of hardcoding type names (`TextRef`, `CounterRef`, etc.). Any type with a `[REACTIVE]` symbol property is now detected — including `LocalRef` for UI-only state and user-defined reactive types.

### Module Resolution

The compiler uses `skipFileDependencyResolution: true` for fast project creation, then manually resolves `@loro-extended/*` packages via `ts.resolveModuleName()` and `project.addSourceFileAtPath()`. This avoids the ~500ms overhead of `tsConfigFilePath` while still enabling full type analysis of external packages.

### Caveats

- **Cache interface nodes, not compiler types.** `resolveSourceFileDependencies()` invalidates the TypeChecker, making cached `ts.Type` objects stale. The interface `InterfaceDeclaration` node is stable.
- **`any` is assignable to everything.** Undeclared identifiers are `any` and must be explicitly excluded.
- **Union types need branch-level checking.** `LocalRef<T> | null` is not assignable to `Reactive`, but the `LocalRef<T>` branch is.

### Binding-Time Classification

When a reactive type is detected:
- Expressions become `ContentValue` with `bindingTime: "reactive"`
- Loops over reactive iterables become `LoopNode` with `iterableBindingTime: "reactive"`
- Conditionals with reactive conditions become `ConditionalNode` with `subscriptionTarget: string`

Non-reactive equivalents:
- Literal expressions: `bindingTime: "literal"`
- Render-time expressions: `bindingTime: "render"`
- Render-time loops: `LoopNode` with `iterableBindingTime: "render"`
- Render-time conditionals: `ConditionalNode` with `subscriptionTarget: null`

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

### Binding-Time Parameterization

The compiler uses **binding time** as the universal parameterization axis for all value-producing and control-flow constructs:

| Construct | Binding-Time Field | Render-Time | Reactive |
|-----------|-------------------|-------------|----------|
| `ContentValue` | `bindingTime` | `"literal"` or `"render"` | `"reactive"` |
| `LoopNode` | `iterableBindingTime` | `"render"` | `"reactive"` |
| `ConditionalNode` | `subscriptionTarget` | `null` | `string` (ref path) |

Users don't need to know this distinction — both "just work" with natural TypeScript syntax. The compiler analyzes expressions using TypeScript's type system to determine binding time, then generates appropriate code:

- **Render-time**: Inline control flow (`for`, `if/else`), evaluates once
- **Reactive**: Runtime region management (`__listRegion`, `__conditionalRegion`), delta-driven updates

## File Structure

```
packages/kinetic/src/compiler/
├── analyze.ts               # AST → IR analysis (imports isReactiveType)
├── analyze.test.ts          # Analysis unit tests
├── reactive-detection.ts    # Reactive type detection via isTypeAssignableTo
├── ir.ts                    # IR type definitions and factories
├── ir.test.ts               # IR unit tests
├── transform.ts             # Orchestrates analysis + codegen + module resolution
├── transform.test.ts        # Transform tests
├── integration.test.ts      # End-to-end compilation tests
└── codegen/
    ├── dom.ts               # DOM code generation
    ├── dom.test.ts          # DOM codegen tests
    ├── html.ts              # HTML code generation
    └── html.test.ts         # HTML codegen tests
```

### Cross-Package Dependencies

```
@loro-extended/reactive       # REACTIVE symbol, Reactive interface, LocalRef
    ↑
    ├── @loro-extended/change # Implements Reactive on all TypedRefs
    └── @loro-extended/kinetic # Re-exports; compiler detects; runtime subscribes
```

## Runtime Dependencies

Generated code calls these runtime functions:

- `__subscribeWithValue(ref, getter, callback, scope)` — Reactive subscriptions
- `__listRegion(parent, list, handlers, scope)` — Delta-driven list rendering
- `__conditionalRegion(marker, target, condition, handlers, scope)` — Reactive conditionals
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

Every node inserted into the DOM must remain trackable for removal. This is enforced through the `Slot` type:

```typescript
type Slot =
  | { kind: "single"; node: Node }
  | { kind: "range"; startMarker: Comment; endMarker: Comment }
```

**Single elements** (the common case) are tracked directly — no overhead.

**Multi-element fragments** use comment markers to delimit the range:

```html
<!--kinetic:start-->
<span>a</span>
<span>b</span>
<!--kinetic:end-->
```

The `claimSlot()` helper automatically chooses the appropriate strategy. When compile-time `slotKind` is provided, it dispatches directly without runtime inspection. The `releaseSlot()` function handles removal for both cases.

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
  slots: Slot[]
  scopes: Scope[]
  listRef: ListRefLike<T>
}

interface ConditionalRegionState extends RegionStateBase {
  currentBranch: "true" | "false" | null
  currentSlot: Slot | null
  currentScope: Scope | null
}
```

This unified structure makes the region system easier to understand, test, and extend.