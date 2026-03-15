# Kyneta Technical Documentation

This document provides technical details about the Kyneta compiler architecture, intermediate representation (IR), and code generation strategies.

## Architecture Overview

Kyneta follows a **Functional Core / Imperative Shell** architecture via an Intermediate Representation (IR):

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

Kyneta's compilation pipeline performs **partial evaluation** at three stages, decomposing UI code into Applicative (static structure) and Monadic (dynamic structure) layers.

### Binding-Time Analysis

The compiler classifies values by **when they become known**:

```typescript
type BindingTime = "literal" | "render" | "reactive"
```

- **literal**: Value known at compile time (string literals like `"Hello"`)
- **render**: Value known at render time (static expressions like `42`, `someVar`)
- **reactive**: Value varies at runtime (reactive expressions like `doc.count`)

This classification enables **binding-time promotion**: when branches diverge only in values, literals and render-time values can be promoted to reactive with ternary expressions.

### Delta Kind: An Orthogonal Property

For reactive dependencies, the compiler also tracks **delta kind** — what kind of structured change information the source provides. Named change types are defined in `@kyneta/schema`:

```typescript
type DeltaKind = "replace" | "text" | "sequence" | "map" | "tree" | "increment"

// Named change types (each is one member of the BuiltinChange union)
type ReplaceChange<T> = { type: "replace"; value: T }
type TextChange = { type: "text"; ops: TextChangeOp[] }
type SequenceChange<T> = { type: "sequence"; ops: SequenceChangeOp<T>[] }
type MapChange = { type: "map"; set?: Record<string, unknown>; delete?: string[] }
type TreeChange = { type: "tree"; ops: TreeChangeOp[] }
type IncrementChange = { type: "increment"; amount: number }
```

Delta kind is **orthogonal to binding time**, not a fourth level. All reactive values change at runtime (same *when*), but they differ in *how much structural information* accompanies the notification:

```
literal  <  render  <  reactive
                         ├── replace (re-read + replace)
                         ├── text (character-level patch)
                         ├── sequence (structural sequence ops)
                         ├── map (key-level patch)
                         ├── tree (hierarchical ops)
                         └── increment (counter delta)
```

Each reactive dependency is represented as:

```typescript
interface Dependency {
  source: string      // e.g., "doc.title", "doc.items"
  deltaKind: DeltaKind
}
```

The `deltaKind` is an **optimization hint** that codegen can dispatch on. When the expression is a "direct read" and the delta kind is rich (text, sequence, etc.), codegen can emit specialized patch code. Otherwise it falls back to replace semantics. The fallback is always safe.

### ContentValue: Unified Content Representation

All content (text, attribute values, etc.) is represented by a single type:

```typescript
interface ContentValue {
  kind: "content"
  source: string              // JSON string for literals, JS expression otherwise
  bindingTime: BindingTime
  dependencies: Dependency[]  // Reactive deps with delta kind
  span: SourceSpan
}
```

This replaces the previous `TextNode | ExpressionNode` union, making binding-time explicit and eliminating cross-product complexity in tree merge logic. Each dependency now carries both the source expression and its delta kind, enabling codegen to make optimization decisions.

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
if (doc.count() > 0) {
  p("Yes")
} else {
  p("No")
}

// Dissolved output:
const _p0 = document.createElement("p")
const _text1 = document.createTextNode("")
_p0.appendChild(_text1)
valueRegion([doc.count], () => read(doc.count) > 0 ? "Yes" : "No", (v) => {
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

**IR-level transform:** Dissolution runs as a pure IR→IR transform (`dissolveConditionals`) in the same pipeline slot as `filterTargetBlocks` — after analysis, before codegen. This means the walker, template extraction, and all codegen paths (both template cloning and `createElement`) never see dissolvable conditionals. They see regular elements and content nodes with ternary reactive values. This eliminates the need for dissolution logic in codegen functions and ensures both the template cloning path and the non-cloning path produce identical dissolved output.

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
- `client:` / `server:` labeled blocks → `TargetBlockNode`
- Block statements → recursively analyzed
- Return statements → compile-time error
- Unknown labeled blocks → captured verbatim as `StatementNode`

**Statement preservation works everywhere:**
- Top-level builder body
- Nested element children (e.g., `header(() => { const x = 1; h1(x) })`)
- Loop bodies
- Conditional branches
- Inside `client:` / `server:` target blocks

#### `TargetBlockNode`
A labeled block that targets a specific compilation target.

```typescript
interface TargetBlockNode {
  kind: "target-block"
  target: "dom" | "html"  // Which compilation target this block is for
  children: ChildNode[]   // Recursively analyzed contents
}
```

Used for `client: { ... }` and `server: { ... }` blocks inside builder
functions. See [Target Labels](#target-labels-client--server-blocks) below
for the full architecture.

### Target Labels: `client:` / `server:` Blocks

Kyneta uses TypeScript's labeled statement syntax to mark code as client-only
or server-only inside builder functions.

#### Syntax

- `client: { ... }` — contents compile to DOM target only, stripped from HTML (SSR) output
- `server: { ... }` — contents compile to HTML target only, stripped from DOM (client) output
- Unlabeled code — compiles to both targets

```typescript
div(() => {
  const count = state(0)

  client: {
    // Only runs in the browser — stripped from SSR output
    requestAnimationFrame(() => count.set(count() + 1))
  }

  server: {
    // Only runs during SSR — stripped from client bundle
    console.log("Rendered at", new Date().toISOString())
  }

  h1(`${count}`)  // both targets
})
```

#### IR Representation

The `target` field maps label names to compilation targets:
- `client` → `"dom"` (the DOM codegen target)
- `server` → `"html"` (the HTML/SSR codegen target)

Unknown labels (e.g., `myLabel: { ... }`) are **not** recognized as target
blocks — they are captured verbatim as `StatementNode`.

#### Filter-Before-Codegen Architecture

Target blocks are resolved **before** codegen via a pure filter function:

```typescript
filterTargetBlocks(node: BuilderNode, target: CompileTarget): BuilderNode
```

This function recursively walks the IR tree:
- **Strips** `TargetBlockNode` whose target doesn't match (removes entirely)
- **Unwraps** `TargetBlockNode` whose target matches (splices children in place)

After filtering, the IR tree contains no `TargetBlockNode` nodes. Codegens,
`walk.ts`, `template.ts`, `computeSlotKind`, and all other downstream consumers
never encounter `TargetBlockNode` — they remain unchanged.

This follows the Functional Core / Imperative Shell principle: the filter is a
pure function that produces a new tree, trivially testable in isolation.

**Dependency collection**: `createBuilder`'s `collectDependencies` recurses into
target block children regardless of target. Dependencies from both `client:` and
`server:` blocks are collected — they inform subscription setup even if one
target's code is stripped later.

#### Scope

Target labels are recognized **only inside builder function bodies** — the same
scope where the dual-compilation (DOM vs HTML) occurs. File-level `client:` /
`server:` labels are not recognized by the compiler (they're outside the builder
analysis scope).

For client-only module imports, use dynamic `import()` inside a `client:` block.

### Union Type

All child nodes are unified under `ChildNode` (7 members in 3 categories):

```typescript
type ChildNode =
  | ElementNode       // Applicative: fixed structure
  | ContentValue      // Applicative: fixed structure
  | LoopNode          // Monadic: dynamic structure (binding-time parameterized)
  | ConditionalNode   // Monadic: dynamic structure (binding-time parameterized)
  | BindingNode       // Effects: side effects
  | StatementNode     // Effects: side effects
  | TargetBlockNode   // Meta: target-conditional wrapper (filtered before codegen)
```

The taxonomy reflects the algebraic structure:
- **Applicative** nodes have fixed DOM structure at compile time
- **Monadic** nodes have dynamic structure determined by runtime values
- **Effects** nodes produce side effects without DOM structure
- **Meta** nodes are structural wrappers resolved before codegen

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

Generates JavaScript that produces HTML strings via accumulation into a `_html` variable.

**Unified calling convention:** All codegen functions return `string[]` (code lines).
There is one generator per IR construct, not two. Statements are lines interleaved with
`_html +=` lines. This mirrors the DOM codegen architecture.

**Output pattern:**
```javascript
() => {
  let _html = ""
  _html += `<div class="app">`
  _html += `<h1>${__escapeHtml(String(title))}</h1>`
  _html += `</div>`
  return _html
}
```

**Statement handling:** Statements are emitted as lines interleaved with `_html +=` lines.
This works at every level — top-level builder body, nested element children, loop bodies,
and conditional branches.

```javascript
// Input: div(() => { const x = 1; h1(String(x)) })
// Output:
() => {
  let _html = ""
  _html += `<div>`
  const x = 1
  _html += `<h1>${__escapeHtml(String(x))}</h1>`
  _html += `</div>`
  return _html
}
```

**Loop generation (both reactive and render-time):**
```javascript
_html += `<ul>`
_html += `<!--kyneta:list:0-->`
for (const itemRef of [...items]) {
  const item = itemRef.get()
  _html += `<li>${__escapeHtml(String(item))}</li>`
}
_html += `<!--/kyneta:list-->`
_html += `</ul>`
```

Reactive loops include hydration markers; render-time loops omit them.
Reactive loops use spread syntax `[...items]` to preserve ref objects.

**Conditional generation (both reactive and render-time):**
```javascript
_html += `<!--kyneta:if:0-->`
if (condition) {
  _html += `<p>yes</p>`
} else {
  _html += `<p>no</p>`
}
_html += `<!--/kyneta:if-->`
```

The code structure is identical for reactive and render-time — only the marker comments differ.

## Reactive Detection

The compiler detects reactive types by checking whether a candidate type has a property keyed by the `CHANGEFEED` unique symbol from `@kyneta/schema`:

```typescript
// @kyneta/schema
export const CHANGEFEED = Symbol.for("kyneta:changefeed")
export interface Changefeed<S = unknown, C extends ChangeBase = ChangeBase> {
  readonly current: S
  subscribe(callback: (change: C) => void): () => void
}
export interface HasChangefeed<S = unknown, C extends ChangeBase = ChangeBase> {
  readonly [CHANGEFEED]: Changefeed<S, C>
}
```

### Symbol Detection (`isWellKnownSymbolProperty`)

Detection is implemented in `reactive-detection.ts` using a three-layer strategy. The core function `isWellKnownSymbolProperty(compilerSymbol, symbolForKey, declarationName, mangledPrefix)` checks for the `CHANGEFEED` symbol:

| Parameter | Value |
|-----------|-------|
| `symbolForKey` | `"kyneta:changefeed"` |
| `declarationName` | `"CHANGEFEED"` |
| `mangledPrefix` | `"__@CHANGEFEED@"` |

The three layers, from most to least robust:

1. **Symbol.for() tracing** — When the symbol's declaration has an initializer (source files), walk the AST to verify it's `Symbol.for(symbolForKey)`. This is the most robust check.
2. **Symbol declaration name** — In `.d.ts` files the initializer is erased, but the `unique symbol` type still carries a reference back to the variable that declared it. Check that variable's `escapedName` matches `declarationName`.
3. **Property escaped name** — As a last-resort fallback, check the property's own mangled name starts with `mangledPrefix`.

All three layers are necessary. Layer 1 works in source `.ts` files, layer 2 in `.d.ts` (built packages), and layer 3 handles edge cases where the type system loses the symbol reference chain. The mock `.d.ts` files in `analyze.test.ts` exercise layer 2 specifically.

The delegate function:
- `isChangefeedSymbolProperty(sym)` → `isWellKnownSymbolProperty(sym, "kyneta:changefeed", "CHANGEFEED", "__@CHANGEFEED@")`

Additionally: exclude `any`/`unknown`, check union branches individually.

This approach replaced an earlier `isTypeAssignableTo(candidate, Reactive)` strategy. That broke when the reactive interface gained a generic parameter — TypeScript's `getType()` on a generic interface returns a type with an unresolved type parameter, which fails assignability checks. The property-level approach is immune to changes in the interface's generic signature.

### Type Detection Functions

| Function | Checks For | Used By |
|----------|-----------|---------|
| `isChangefeedType(type)` | `[CHANGEFEED]` property | `expressionIsReactive`, `extractDependencies`, `analyzeExpression` |
| `getDeltaKind(type)` | Delta kind from `Changefeed<S, C>`'s `C` type parameter | Codegen optimization dispatch |

`isChangefeedType` excludes `any`/`unknown`, handles union types (checks each branch), and uses property-level detection via `isChangefeedSymbolProperty`.

### Module Resolution

The compiler uses `skipFileDependencyResolution: true` for fast project creation, then manually resolves `@kyneta/schema` via `ts.resolveModuleName()` and `project.addSourceFileAtPath()`. This avoids the ~500ms overhead of `tsConfigFilePath` while still enabling full type analysis of external packages.

### Delta Kind Extraction (`getDeltaKind`)

Once a type is confirmed as a Changefeed, the compiler extracts its **delta kind** via `getDeltaKind()` in `reactive-detection.ts`. This determines what optimizations codegen can apply:

1. Find the `[CHANGEFEED]` property on the type
2. Get the `Changefeed<S, C>` type
3. Extract the `subscribe` method's callback parameter type `C`
4. Read the `type` property from `C`
5. If it's a single string literal (`"text"`, `"sequence"`, etc.), return it as the `DeltaKind`
6. Otherwise fall back to `"replace"`

**Critical requirement:** Step 5 only works when `C` is a **narrowed** single-member type (e.g., `TextChange`), not the full `BuiltinChange` union. If `C` defaults to `ChangeBase`, the `type` property resolves to `string` — not a string literal — and `isStringLiteral()` returns false, causing a silent fallback to `"replace"`.

Each typed ref must therefore declare its specific change type:

```typescript
// TextRef narrows C to TextChange — getDeltaKind returns "text"
readonly [CHANGEFEED]: Changefeed<string, TextChange>

// Without narrowing, C defaults to ChangeBase — getDeltaKind returns "replace"
readonly [CHANGEFEED]: Changefeed<string, ChangeBase>  // ← WRONG: silently breaks delta dispatch
```

### Caveats

- **`any` is assignable to everything.** Undeclared identifiers are `any` and must be explicitly excluded.
- **Union types need branch-level checking.** `LocalRef<T> | null` doesn't itself have a `[CHANGEFEED]` property, but the `LocalRef<T>` branch does.
- **`links.nameType` is a TypeScript internal.** It has been stable across TS 4.x–6.x and is fundamental to computed property name handling, but layers 2 and 3 serve as fallbacks if it ever changes.
- **Types are resolved from `dist/`, not source files.** `transformSource` uses `useInMemoryFileSystem: false` and resolves `@kyneta/schema` via `ts.resolveModuleName()`, which follows `package.json` exports to the built `dist/index.d.ts`. After changing type declarations (e.g., adding a `[CHANGEFEED]` property), you must rebuild `@kyneta/schema` (`pnpm run build`) before compiler tests will see the changes.
- **`toContain` on generated code can give false positives.** Generated code includes import statements listing all runtime functions. `expect(code).toContain("valueRegion")` will match the import `import { valueRegion, textRegion } from ...` even when `valueRegion` is never called. Use more specific patterns like `toContain("textRegion(")` or `not.toMatch(/valueRegion\(/)`.

### Changefeed-Native Expression Analysis

The compiler determines whether an expression qualifies for surgical delta patching via a single type-level question: **"is this expression itself a Changefeed?"**

**The user controls the boundary** between surgical deltas and replace semantics:

| User writes | Expression type | Compiler emits | Semantics |
|---|---|---|---|
| `doc.title` | Has `[CHANGEFEED]` with `TextChange` | `textRegion(node, doc.title, scope)` | Surgical O(k) |
| `doc.title()` | `string` | `valueRegion(...)` | Replace O(n) |
| `doc.title.get()` | `string` | `valueRegion(...)` | Replace O(n) |
| `doc.title.get().toUpperCase()` | `string` | `valueRegion(...)` | Replace O(n) |
| `doc.items` | Has `[CHANGEFEED]` with `SequenceChange` | `listRegion(...)` | Surgical O(k) |
| `doc.count` | Has `[CHANGEFEED]` with `IncrementChange` | `valueRegion(...)` | Replace (no surgical counter region) |

This is **explicit and predictable** — pass the Changefeed itself for delta support, or extract a value for replace. No heuristics, no method-name recognition, no peeking into expressions.

**Detection algorithm** (implemented in `analyzeExpression`):
1. Check `expressionIsReactive(expr)` — does any part of the expression depend on a Changefeed?
2. If reactive, extract dependencies via `extractDependencies(expr)`
3. Check `isChangefeedType(expr.getType())` — is this expression *itself* a Changefeed?
4. If yes: set `directReadSource = expr.getText()`, synthesize `source = "read(expr.getText())"`
5. If no: `directReadSource` is not set, `source = expr.getText()` (user's expression as-is)

**The `read()` helper:** When the expression IS a Changefeed, the compiler synthesizes `read(ref)` instead of the bare ref. The `read` function is the observation morphism of the coalgebra — it extracts `ref[CHANGEFEED].current`. This avoids embedding the `[CHANGEFEED]` symbol access in generated code (which would require importing the symbol).

**Examples:**
| Expression | `isChangefeedType`? | `directReadSource` | `source` |
|---|---|---|---|
| `doc.title` (text ref) | ✅ Yes | `"doc.title"` | `"read(doc.title)"` |
| `count` (counter ref) | ✅ Yes | `"count"` | `"read(count)"` |
| `doc.title()` | ❌ No (returns `string`) | not set | `"doc.title()"` |
| `doc.title.get()` | ❌ No (returns `string`) | not set | `"doc.title.get()"` |
| `count > 0` | ❌ No (returns `boolean`) | not set | `"count > 0"` |
| `` `Hello ${doc.title}` `` | ❌ No (returns `string`) | not set | `` "`Hello ${doc.title}`" `` |

**Why this replaces the old `detectDirectRead`:** The old approach recognized `.get()` and `.toString()` as "direct reads" via AST pattern matching — a syntactic heuristic pretending to be a semantic question. It couldn't recognize `ref()` (callable refs from `@kyneta/schema`), and it created a hidden coupling between the compiler and specific ref method names. The new approach asks the correct algebraic question: is this expression a coalgebra (Changefeed), or has the user already extracted a value?

**Behavioral change from the old approach:** `doc.title.get()` previously triggered `textRegion` (via `detectDirectRead`). Now it triggers `valueRegion` (because the expression returns `string`, not a Changefeed). This is intentionally correct — for `LocalRef`, `textRegion`'s surgical path was never invoked anyway (`LocalRef` emits `ReplaceChange`, which hits the `else` fallback). For schema text refs, the user writes bare `doc.title` to get surgical support.

### Dependency Extraction (`extractDependencies`)

The `extractDependencies` visitor walks the expression AST and captures reactive dependencies. It has four cases:

1. **PropertyAccess on reactive object** — `doc.title.get()` → captures `doc.title` (the object has `[CHANGEFEED]`)
2. **PropertyAccess whose result type is reactive** — `doc.title` where `doc` is not a Changefeed but `doc.title` is → captures `doc.title`
3. **Call on reactive object** — captures the callee's receiver
4. **Identifier that is reactive** — captures itself (skips identifiers that are property names in a PropertyAccess)

Case 2 was added in Phase 4 to fix a pre-existing bug: when `doc` is not reactive but `doc.title` is, none of the other cases fired. The `depsMap` deduplication (keyed by source text) prevents double-capture when both the object and result are reactive.

**Dependency subsumption:** After collecting all dependencies, `extractDependencies` applies a subsumption rule: any dependency whose source is a strict prefix of another dependency's source (at a dot boundary) is removed. For example, if both `"doc"` (deltaKind `"map"`) and `"doc.title"` (deltaKind `"text"`) are captured, `"doc"` is dropped because `"doc.title"` is more specific. The dot-boundary check ensures `"d"` is NOT subsumed by `"doc"` — the character after the prefix must be `"."`. This rule became necessary when a document type exposes `[CHANGEFEED]` on the root: without it, `doc.title.toString()` would produce two dependencies, breaking the `isTextRegionContent` check (`dependencies.length === 1 && deltaKind === "text"`) and degrading from `textRegion` (surgical DOM patching) to `valueRegion` (full replacement).

### Binding-Time Classification

When a Changefeed type is detected:
- Expressions become `ContentValue` with `bindingTime: "reactive"`
- Loops over reactive iterables become `LoopNode` with `iterableBindingTime: "reactive"`
- Conditionals with reactive conditions become `ConditionalNode` with `subscriptionTarget: string`

Non-reactive equivalents:
- Literal expressions: `bindingTime: "literal"`
- Render-time expressions: `bindingTime: "render"`
- Render-time loops: `LoopNode` with `iterableBindingTime: "render"`
- Render-time conditionals: `ConditionalNode` with `subscriptionTarget: null`

## Design Decisions

### Shared Predicate Functions

Codegen dispatch predicates — `isTextRegionContent()` and `isInputTextRegionAttribute()` — live in `ir.ts` as the single source of truth. These predicates gate both codegen dispatch (which runtime function to emit) and import collection (which runtime imports are needed). Having them in one place prevents the subtle divergence that occurs when the same condition is copy-pasted across `codegen/dom.ts` and `transform.ts`.

Both predicates are pure functions of their IR node arguments, with no codegen state dependency. This makes them testable in isolation (`ir.test.ts`) and safe to call from any compilation phase.

### IR-Level Dissolution

Conditional dissolution is implemented as a pure IR→IR transform (`dissolveConditionals` in `ir.ts`) rather than inline logic in codegen functions. This follows the precedent set by `filterTargetBlocks`, which also transforms the IR before codegen sees it.

The key correctness argument: the walker (`walk.ts`) and template extraction (`template.ts`) consume post-dissolution IR. Dissolvable conditionals are replaced by their merged children (elements/content with ternary values) before any downstream consumer runs. This means:

- The walker never emits `regionPlaceholder` events for dissolved conditionals
- Template extraction never generates `<!--kyneta:if:N-->` comment markers for them
- The walk plan's child-index assumptions are never violated by dissolution
- Codegen (both `generateConditional` and `generateConditionalWithMarker`) only sees non-dissolvable `ConditionalNode` instances

The alternative — dissolution inside codegen — worked for the non-cloning path (`generateConditional`) but was abandoned on the template cloning path (`generateConditionalWithMarker`) because the template HTML and walk plan had already been computed with region markers in place. Moving dissolution upstream eliminates this problem entirely.

### Explicit Scope Passing

`Element = (scope: ScopeInterface) => Node` is the universal shape for compiled DOM output. The compiler transforms builder calls like `div(() => { h1("Hello") })` into `(scope) => { ... return _div0 }`, where `scope` is load-bearing: reactive subscriptions use it to register cleanup handlers and manage lifecycle. `mount()` creates a root scope and passes it to the element factory; components receive child scopes via `scope.createChild()`.

SSR render functions have a separate type (`SSRRenderFunction = (ctx: SSRContext) => string`) because server-side rendering doesn't need scope — there are no subscriptions to manage, no cleanup to track. The HTML codegen produces `() => string` (zero parameters). This is a deliberate divergence, not an oversight: the two targets have fundamentally different lifecycle requirements.

### Unified Accumulation-Line Architecture in HTML Codegen

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
Kyneta Compiler Error: Return statement not supported in builder function at line 5.
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
packages/core/src/compiler/
├── analyze.ts               # AST → IR analysis (imports isReactiveType)
├── analyze.test.ts          # Analysis unit tests
├── reactive-detection.ts    # Reactive type + ComponentFactory detection
├── html-constants.ts        # Shared HTML constants (VOID_ELEMENTS, escapeHtml)
├── ir.ts                    # IR types, factories, predicates, and IR→IR transforms
├── ir.test.ts               # IR unit tests (includes predicate + dissolution tests)
├── walk.ts                  # Generator-based IR walker (WalkEvent stream)
├── walk.test.ts             # Walker unit tests
├── template.ts              # Template extraction + walk planning (NavOp)
├── template.test.ts         # Template extraction tests
├── transform.ts             # Orchestrates analysis + codegen + import collection
├── transform.test.ts        # Transform tests
├── integration.test.ts      # End-to-end compilation tests
└── codegen/
    ├── dom.ts               # DOM code generation (template cloning + createElement)
    ├── dom.test.ts          # DOM codegen tests
    ├── html.ts              # HTML code generation (SSR)
    └── html.test.ts         # HTML codegen tests
```

### Child Type

The `Child` type union in `types.ts` accepts `HasChangefeed`, enabling bare reactive refs in content position (e.g., `p(doc.title)` where `doc.title` has `[CHANGEFEED]`). This is safe because the Kyneta compiler intercepts the call and synthesizes `read()` in the IR before codegen — the raw ref never reaches `textContent`. The `Child` type exists only for TypeScript's authoring-time benefit.

### Cross-Package Dependencies


```
@kyneta/schema       # CHANGEFEED symbol, Changefeed interface, change types
    ↑
    └── @kyneta/core # Compiler detects [CHANGEFEED]; runtime subscribes via it
```

## Runtime Dependencies

> **`CHANGEFEED` Protocol in the Runtime:** Both `textRegion` and `inputTextRegion` read initial state via the `read()` helper (`ref[CHANGEFEED].current`). The `subscribe()` function gates on the presence of `[CHANGEFEED]` at runtime. `listRegion` is the exception — it uses `ListRefLike<T>` because the functional-core planning functions need `{ length, at(i) }`.


Generated code imports runtime functions from `@kyneta/core/runtime`:

- `subscribe(ref, handler, scope)` — CHANGEFEED-based subscription (delta-aware, Changeset-unwrapping)
- `valueRegion(refs, getValue, onValue, scope)` — Replace-semantic updates for any Changefeed(s)
- `listRegion(parent, list, handlers, scope)` — Delta-driven list rendering
- `conditionalRegion(marker, target, condition, handlers, scope)` — Reactive conditionals
- `textRegion(textNode, ref, scope)` — Surgical text patching for direct text Changefeed reads
- `inputTextRegion(input, ref, scope)` — Surgical `<input>`/`<textarea>` value patching via `setRangeText`
- `read(ref)` — Universal value accessor: `ref[CHANGEFEED].current`

All runtime functions accept a `scope` parameter for cleanup tracking.

### Delta-Aware Subscription

The core `subscribe` function uses the `CHANGEFEED` symbol from `@kyneta/schema`. The changefeed protocol delivers `Changeset` batches (one or more changes with optional provenance metadata), not individual changes. Core's `subscribe` **unwraps** these batches so handlers receive individual `ChangeBase` objects with the batch's `origin` propagated as a second argument:

```typescript
function subscribe(
  ref: unknown,
  handler: (change: ChangeBase, origin?: string) => void,
  scope: Scope,
): SubscriptionId {
  if (!hasChangefeed(ref)) {
    throw new Error("subscribe called with non-reactive value")
  }
  // Changefeed delivers Changeset batches; unwrap into individual changes
  const unsubscribeFn = ref[CHANGEFEED].subscribe((changeset: Changeset) => {
    for (const change of changeset.changes) {
      handler(change, changeset.origin)
    }
  })
  scope.onDispose(() => unsubscribeFn())
  return id
}
```

This unwrapping is why core's `subscribe` differs from schema's facade `subscribeNode` (which passes the raw `Changeset` to the callback). Core handlers receive individual `ChangeBase` objects, which enables pattern-matching on `change.type`:

- **Sequence regions**: Extract `change.ops` for O(k) DOM updates
- **Text regions**: Use `insertData`/`deleteData` for O(k) surgical text updates
- **Fallback**: For `"replace"` changes or complex expressions, re-read the entire value

The `origin` field propagates from `Changeset.origin` to the handler's second argument. Most handlers ignore it; `inputTextRegion` uses it for cursor-mode dispatch (see below).

### Backend-Agnostic Core Runtime

The core runtime (`@kyneta/core/runtime`) depends only on `@kyneta/schema` for the `CHANGEFEED` symbol and change types. It has no backend-specific imports. This enables:

1. **Custom reactive types** — `LocalRef` and user-defined Changefeeds work without any specific CRDT backend
2. **Future extensibility** — Any CRDT library or state management system can provide Changefeed-compatible refs
3. **Clear dependency graph** — Core runtime is minimal and portable

### List Region Architecture

The `listRegion` runtime follows **Functional Core / Imperative Shell** pattern:

**Functional Core** (pure, testable):
- `planInitialRender(listRef)` → `ListRegionOp<T>[]`
- `planDeltaOps(listRef, deltaOps: SequenceChangeOp<T>[])` → `ListRegionOp<T>[]`

**Imperative Shell** (DOM manipulation):
- `executeOp(parent, state, handlers, op)` — applies single operation

The `listRegion` subscribe callback receives a change and dispatches:

```typescript
subscribe(listRef, (change: ChangeBase) => {
  if (change.type === "sequence") {
    // O(k) update where k = number of changed items
    const ops = planDeltaOps(state.listRef, change.ops)
    executeOps(parent, state, handlers, ops)
  } else {
    // Fallback: full re-render for "replace" or other change types
    clearAll(state)
    const ops = planInitialRender(state.listRef)
    executeOps(parent, state, handlers, ops)
  }
}, scope)
```

Both planning functions use `listRef.at(index)` to obtain refs, ensuring
handlers always receive refs for value shapes. This enables the component
pattern where refs are passed for two-way binding:

```typescript
for (const itemRef of doc.items) {
  const item = itemRef.get()  // Read current value
  li({ onClick: () => itemRef.set(item.toUpperCase()) }, item)  // Can write!
}
```

**Key design decisions:**
1. Use `listRef.at(index)` instead of `.toArray()` for ref preservation
2. Delta inserts use count only — `listRef.at(index)` fetches actual values
3. Store `listRef` in state for delta handling
4. Non-sequence deltas (e.g., `"replace"`) trigger full re-render as fallback
5. HTML codegen uses `[...listSource]` (iterator returns refs)

### Text Region Architecture

The `textRegion` runtime enables **O(k) surgical text updates** for direct text Changefeed reads, where k is the edit size rather than the full string length.

**When it applies:**
- Expression is itself a Changefeed (bare ref like `doc.title`)
- The dependency has `deltaKind: "text"`
- The expression has not been transformed (e.g., `.toUpperCase()`) or combined with other deps

**Functional Core** (pure, testable):
- `planTextPatch(ops: TextDeltaOp[])` → `TextPatchOp[]` — converts cursor-based deltas to offset-based ops

**Imperative Shell** (DOM manipulation):
- `patchText(textNode, ops)` — applies patches via `insertData`/`deleteData`
- `textRegion(textNode, ref, scope)` — subscription-aware wrapper

The `textRegion` function reads initial state via the `CHANGEFEED` protocol:

```typescript
function textRegion(textNode: Text, ref: unknown, scope: Scope): void {
  const changefeedRef = ref as HasChangefeed<string>
  const readValue = () => read(changefeedRef)

  textNode.textContent = readValue()  // Initial value via read() helper

  subscribe(ref, (change: ChangeBase) => {
    if (isTextChange(change)) {
      // O(k) surgical update
      patchText(textNode, change.ops)
    } else {
      // Fallback for non-text changes (e.g., "replace")
      textNode.textContent = readValue()
    }
  }, scope)
}
```

**Delta cursor model:**
Text deltas use cursor-based operations applied left-to-right:
- `retain: n` — advance cursor by n (no output)
- `insert: s` — insert at cursor, cursor advances by `s.length`
- `delete: n` — delete n chars at cursor, **cursor does NOT advance**

The "cursor doesn't advance on delete" is critical — subsequent ops apply at the same position.

**Codegen dispatch:**
```typescript
// In generateReactiveContentSubscription:
if (directReadSource && deps.length === 1 && deps[0].deltaKind === "text") {
  // Direct text Changefeed read — surgical patching
  emit: textRegion(textVar, directReadSource, scopeVar)
} else {
  // Single or multi-dep — full replacement via valueRegion
  emit: valueRegion(...)
}
```

**Key design decisions:**
1. `CHANGEFEED` protocol keeps runtime backend-agnostic — `textRegion` reads initial state via the `read()` helper (`ref[CHANGEFEED].current`) instead of ad-hoc interface casts. (`ListRefLike<T>` remains for `listRegion` because the planning functions need `{ length, at(i) }`.)
2. Non-text changes (e.g., `"replace"` from `LocalRef`) trigger full `textContent` replacement via `read()`
3. Multi-dep expressions use `valueRegion` with all deps in the `refs` array — change describes one source, not output
4. Bare refs (`p(doc.title)`) produce the same codegen as explicit reads (`p(doc.title())`) — the compiler synthesizes `read()` in the IR source, but `textRegion` reads initial state via `read()` internally

### Input Text Region Architecture

The `inputTextRegion` runtime enables **O(k) surgical value updates** for `<input>` and `<textarea>` elements backed by a text Changefeed. It is the input-element analog of `textRegion` (which targets Text nodes).

**When it applies (codegen dispatch):**
- Attribute name is `value`
- Expression is itself a Changefeed (`directReadSource` is set)
- The dependency has `deltaKind: "text"`

Both the createElement path (`generateAttributeSubscription`) and the template cloning path (`generateHoleSetup`) check via `isInputTextRegionCandidate()`. When the condition is met:
1. `generateAttributeSet` **skips** the initial `.value =` (inputTextRegion handles initialization)
2. `generateAttributeSubscription` emits `inputTextRegion(el, ref, scope)` instead of a naive `subscribe`

**DOM API:** `setRangeText(text, start, end, selectMode)`

Unlike `textRegion` which uses `insertData`/`deleteData` on Text nodes, input elements have no character-level DOM API. `setRangeText` provides equivalent surgical editing. The `selectMode` parameter controls cursor adjustment:

- `"preserve"` — Attempts to keep the cursor where it was. Correct for **remote** edits (inserts before cursor shift it right, deletes before cursor shift it left). **Incorrect** for local edits at the cursor position — see caveat below.
- `"end"` — Moves cursor to end of the replacement range.

**`setRangeText("preserve")` cursor caveat:** Per the HTML spec, `"preserve"` adjusts `selectionStart` only when it is *strictly greater than* the replacement range endpoints. When inserting at the cursor position (`start === end === selectionStart`), neither adjustment branch fires — the cursor stays put. This means typing "Hello" character by character produces "olleH" because each character is inserted at position 0 (the cursor never advances). `"preserve"` was designed for edits happening *elsewhere* in the text, not at the cursor.

**Origin-driven selectMode dispatch:** `inputTextRegion` dispatches selectMode based on the `origin` parameter — the second argument to the `subscribe` handler, propagated from `Changeset.origin` during batch unwrapping:

- **`origin === "local"`** → `setRangeText(..., "end")` — cursor advances past inserts, stays at delete point. Correct for local typing, undo, and redo.
- **anything else** (`"import"`, `undefined`) → `setRangeText(..., "preserve")` — cursor shifts relative to remote edits. Correct for remote collaborator edits.

No active-edit flags, cursor arithmetic, or cross-module coordination needed. The `origin` field on `Changeset` (from `@kyneta/schema`) is the sole discriminant — it arrives as the handler's second argument after batch unwrapping. Backend adapters (e.g., a future Loro adapter) forward provenance info into this field.

**Functional Core** (shared with `textRegion`):
- `planTextPatch(ops: TextDeltaOp[])` → `TextPatchOp[]` — converts cursor-based deltas to offset-based ops

**Imperative Shell:**
- `patchInputValue(input, ops, selectMode?)` — applies patches via `setRangeText(selectMode)` (default `"preserve"`)
- `inputTextRegion(input, ref, scope)` — subscription-aware wrapper, dispatches selectMode on `origin` (from `Changeset.origin`)

```typescript
function inputTextRegion(
  input: HTMLInputElement | HTMLTextAreaElement,
  ref: unknown,
  scope: Scope,
): void {
  const changefeedRef = ref as HasChangefeed<string>
  const readValue = () => read(changefeedRef)

  input.value = readValue()  // Initial value via read() helper

  subscribe(ref, (change: ChangeBase, origin?: string) => {
    if (isTextChange(change)) {
      const mode = origin === "local" ? "end" : "preserve"
      patchInputValue(input, change.ops, mode)  // O(k) surgical update
    } else {
      input.value = readValue()       // Fallback via read()
    }
  }, scope)
}
```

**The `setAttribute` fix:** The `generateAttributeUpdateCode` helper was extracted as the single source of truth for attribute→DOM-API mapping. This fixed a latent bug in the template cloning path where `setAttribute("value", x)` was used instead of `.value =`. After user interaction, `setAttribute` only changes the HTML default attribute — not the live DOM property. The same fix covers `checked`, `disabled`, `class`, `style`, and `data-*` in both the createElement and cloneNode codegen paths.

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
<!--kyneta:start-->
<span>a</span>
<span>b</span>
<!--kyneta:end-->
```

The `claimSlot()` helper automatically chooses the appropriate strategy. When compile-time `slotKind` is provided, it dispatches directly without runtime inspection. The `releaseSlot()` function handles removal for both cases.

**Runtime vs compile-time slot kind:** The compile-time `slotKind` hint is an optimization, not a contract. The runtime may produce a slot of a *different* kind than the hint when the hint is overly conservative. For example, `slotKind: "range"` with a fragment containing 0 or 1 children will produce a `"single"` slot (empty placeholder or direct child tracking). This is intentional — the runtime always produces the **minimal** slot representation, and the compile-time hint is a fast-path for the common case. The `computeSlotKind()` function in `ir.ts` is deliberately conservative (it doesn't evaluate expressions), so this divergence is expected and safe.

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

## Template Cloning Architecture

Template cloning provides 3-10× faster DOM creation compared to imperative `createElement` chains by leveraging the browser's native `<template>.content.cloneNode(true)` implementation.

### Four-Layer Design

The template cloning system follows a clean separation of concerns:

| Layer | Module | Input | Output |
|-------|--------|-------|--------|
| **Walker** | `walk.ts` | IR tree | `WalkEvent` stream |
| **Extractor** | `template.ts` | `WalkEvent` stream | `TemplateNode` |
| **Planner** | `template.ts` | `TemplateHole[]` | `NavOp[]` |
| **Codegen** | `dom.ts` | `NavOp[]` | JavaScript code |

### Template Extraction

The extractor consumes walker events and produces a `TemplateNode`:

```typescript
interface TemplateNode {
  /** Static HTML string for template.innerHTML */
  html: string
  /** Ordered list of dynamic holes with walk paths */
  holes: TemplateHole[]
  /** Counter for unique region marker IDs */
  markerIdCounter: number
}

interface TemplateHole {
  /** Path from root: indices into children arrays */
  path: number[]
  /** Hole type: text, attribute, event, binding, region */
  kind: TemplateHoleKind
  /** Original IR node for codegen */
  contentNode?: ContentNode
  regionNode?: LoopNode | ConditionalNode
}
```

### Walk Planning

The planner converts hole paths to optimal DOM navigation:

```typescript
type NavOp =
  | { op: "down" }   // .firstChild
  | { op: "right" }  // .nextSibling
  | { op: "up" }     // .parentNode
  | { op: "grab"; holeIndex: number }

// Example: holes at [0,0] and [1,0]
const ops = planWalk(holes)
// [down, down, grab(0), up, right, down, grab(1)]
```

Holes are visited in document order (depth-first), so the walk never backtracks past already-grabbed holes.

### Generated Code Pattern

Template cloning generates code like:

```typescript
// Module-level template declaration (hoisted)
const _tmpl_0 = document.createElement("template")
_tmpl_0.innerHTML = "<div><span></span><p></p></div>"

// Element factory function
(scope) => {
  const _root = _tmpl_0.content.cloneNode(true).firstChild
  
  // Walk to grab hole references
  const _holes = new Array(2)
  let _n = _root
  _n = _n.firstChild          // span
  _n = _n.firstChild          // text inside span
  _holes[0] = _n
  _n = _n.parentNode          // span
  _n = _n.nextSibling         // p
  _holes[1] = _n
  
  // Wire up reactivity to grabbed references
  subscribe(dep, (delta) => {
    _holes[0].textContent = value
  }, scope)
  
  return _root
}
```

### Region Handling

Regions (loops and non-dissolvable conditionals) become comment placeholder holes in the template:

```html
<ul><!--kyneta:list:1--><!--/kyneta:list--></ul>
```

The walker grabs the opening comment node, which is passed to `listRegion()` or `conditionalRegion()` as the mount point. This format matches SSR hydration markers, ensuring template-cloned and SSR-rendered DOM are structurally identical.

**Dissolvable conditionals** (structurally identical branches) are resolved at the IR level by `dissolveConditionals` before template extraction runs. Their content appears as inline elements and text in the template — no comment markers, no `conditionalRegion` at runtime. Only non-dissolvable conditionals (different tags, different child counts, no else branch) produce region comment markers.

### Template Deduplication

List region item templates are deduplicated via hash:

```typescript
// Codegen maintains: Map<htmlHash, templateVarName>
// Same template HTML reuses same declaration
const _tmpl_item = document.createElement("template")
_tmpl_item.innerHTML = "<li></li>"

// All list items clone from same template
create: (item) => _tmpl_item.content.cloneNode(true).firstChild
```

### Integration with CodegenResult

The `CodegenResult` type supports returning module declarations:

```typescript
interface CodegenResult {
  code: string
  moduleDeclarations: string[]
}
```

The `transformSourceInPlace` function collects all `moduleDeclarations` and inserts them at the top of the transformed file.

## Batch List Operations

List regions exploit CRDT delta structure to perform batch DOM operations, reducing O(N) individual operations to O(1) batch operations for contiguous inserts/deletes.

### Batch Operation Types

The `ListRegionOp` type includes batch variants:

```typescript
type ListRegionOp<T> =
  | { kind: "insert"; index: number; item: T }
  | { kind: "delete"; index: number }
  | { kind: "batch-insert"; index: number; count: number }
  | { kind: "batch-delete"; index: number; count: number }
```

Note: `batch-insert` carries `count`, not `items: T[]`. The executor calls `listRef.get(index + i)` during execution. This keeps the planning function pure (no item fetching) and avoids allocating a large intermediate array for big batches.

### Planning: Emit Batch Ops for Contiguous Operations

The `planDeltaOps` function emits batch operations when count > 1:

```typescript
// For delta { delete: 50 } → single batch-delete
ops.push({ kind: "batch-delete", index, count: 50 })

// For delta { insert: 100 } → single batch-insert  
ops.push({ kind: "batch-insert", index, count: 100 })

// For delta { delete: 1 } or { insert: 1 } → individual ops
ops.push({ kind: "delete", index })
ops.push({ kind: "insert", index, item })
```

### Execution: O(1) DOM Operations

**Batch Insert** uses DocumentFragment:
```typescript
// Create all items, collect into fragment
const fragment = document.createDocumentFragment()
for (let i = 0; i < op.count; i++) {
  const item = listRef.get(op.index + i)
  const node = handlers.create(item, op.index + i)
  fragment.appendChild(node)
}
// Single DOM insertion
parent.insertBefore(fragment, referenceNode)
```

**Batch Delete** uses Range API:
```typescript
const range = document.createRange()
range.setStartBefore(startSlot.node)
range.setEndAfter(endSlot.node)
// Single DOM operation removes all content
range.deleteContents()
```

### Performance Characteristics

| Operation | Without Batching | With Batching |
|-----------|------------------|---------------|
| Insert 100 items | 100 `insertBefore` calls | 1 `insertBefore` call |
| Delete 50 items | 50 `removeChild` calls | 1 `deleteContents` call |
| State updates | 100 `splice` calls | 1 `splice` call |

This is especially valuable for CRDT synchronization where remote peers may send large batches of changes.

## Component Model

Kyneta supports user-defined components alongside HTML element factories. Components are ordinary TypeScript functions typed as `ComponentFactory` — the compiler recognizes them via the type system.

### ComponentFactory Type

```typescript
type ComponentFactory<P extends Record<string, unknown> = {}> =
  | ((props: P, builder: Builder) => Element)
  | ((props: P) => Element)
  | ((builder: Builder) => Element)
  | (() => Element)
```

A component is any function whose type satisfies `ComponentFactory`: it returns an `Element` (which is `(scope: Scope) => Node`), and optionally accepts props and/or a builder callback.

### Two-Tier Detection

The compiler uses a two-tier strategy in `checkElementOrComponent()`:

1. **HTML tag check** — If the callee name is in `ELEMENT_FACTORIES` (130 known HTML tags), it's an HTML element. Fast path, no type checking.
2. **Type-based check** — Otherwise, `isComponentFactoryType()` inspects the callee's TypeScript type via call signatures. If the return type is a function returning `Node`, it's recognized as a component.

This means component detection is purely type-driven — no naming conventions required (though PascalCase is idiomatic).

### IR Representation

Components reuse `ElementNode` with an optional `factorySource` field rather than introducing a new `ChildNode` variant:

```typescript
interface ElementNode {
  kind: "element"
  tag: string              // "Avatar", "Card", etc.
  factorySource?: string   // "Avatar" — present for components, absent for HTML
  attributes: AttributeNode[]
  eventHandlers: EventHandlerNode[]
  // ...
}
```

This avoids a cascade of changes through every `switch (node.kind)` site in codegen, slot computation, and tree merging.

### Codegen Output

For an HTML element:
```typescript
const _div0 = document.createElement("div")
```

For a component:
```typescript
const _Avatar0 = Avatar({ src: "photo.jpg" })(scope.createChild())
```

The component factory is called with props, returning an `Element` (a scope-accepting function), which is immediately called with a child scope. The returned `Node` is then `appendChild`-ed to its parent.

### Builder Components

A **Builder Component** is a function that returns a builder expression. The builder expression _is_ the template — no JSX, no virtual DOM, no separate render function. The compiler handles scope threading transparently, transforming the builder into `(scope) => Node` inside the closure. The call site emits `Factory(props)(scope.createChild())`, but the user never writes or sees the double invocation.

Two idiomatic flavors:

- **Props-based** — receives data via a typed props object. The standard pattern for reusable, self-contained components:
  ```typescript
  const TodoItem: (props: { label: string; onRemove: () => void }) => Element = (props) =>
    li({ class: "todo-item" }, () => {
      label(props.label)
      button({ class: "destroy", onClick: props.onRemove }, "×")
    })
  ```

- **Props-based with `editText`** — text input components can use `editText` as a plain function prop. Unlike `bind()`, `editText` doesn't require compiler recognition and works in any component flavor:
  ```typescript
  const TodoHeader: (props: { doc: TodoDoc }) => Element = ({ doc }) =>
    header(() => {
      h1(doc.title.toString())
      input({ value: doc.newTodoText.toString(), onBeforeInput: editText(doc.newTodoText) })
    })
  ```

Both compile identically — the compiler doesn't distinguish them. Detection is structural: any function whose return type has call signatures returning `Node` is recognized as a component by `isComponentFactoryType()`.

**Props are not reactive.** They are captured at instantiation time. If a prop value changes, the component must be destroyed and recreated. This happens naturally for list items (the reactive loop handles insert/delete) but would not work for in-place prop updates.

**Calling convention — proven end-to-end.** DOM: `Factory(props)(scope.createChild())`. SSR: `Factory(props)()` (no scope — SSR has no subscriptions to manage). Both paths are covered by integration tests in `integration.test.ts` under "Component compilation".

**Type annotation note.** The `ComponentFactory<P>` type is a 4-member union of function types. TypeScript cannot resolve which union member to invoke at call sites, so components should be annotated with their specific overload (`(props: P) => Element` or `() => Element`). The compiler's type detection works on structural call signatures, not on the `ComponentFactory` name, so the specific overload is fully equivalent.

### Template Cloning Interaction

Components cannot be serialized into `template.innerHTML` — the browser would create an unknown element like `<Avatar>`, not a component invocation. The walker yields a `componentPlaceholder` event instead of walking component children as HTML:

```typescript
// Walker sees ElementNode with factorySource → yields placeholder
yield { type: "componentPlaceholder", node, path: [...pathStack] }
```

The template extractor emits a `<!---->` comment placeholder and records a `{ kind: "component", elementNode }` hole. At runtime, the codegen instantiates the component via `generateElement()` and replaces the comment:

```typescript
// Generated code for a component hole
const _Avatar0 = Avatar({ src: "photo.jpg" })(scope.createChild())
_holes[0].parentNode.replaceChild(_Avatar0, _holes[0])
```

### Current Limitations

- **Builder callbacks not wired**: The `ComponentFactory` type supports `(props, builder) => Element`, but the compiler does not yet pass children as a builder callback at call sites. Components must manage their own children internally.
- **Bindings through props unsupported**: `bind()` values cannot be passed as component props. The `Binding<T>` type is recognized at the element level (e.g., `input({ value: bind(ref) })`), but the component codegen does not unwrap or forward bindings. Components that need two-way binding must accept the raw ref and call `bind()` internally.

## Conditional Scope Creation

List regions can skip per-item scope allocation when items contain no reactive content, reducing overhead for static list rendering.

### Mechanism

The IR computes `LoopNode.hasReactiveItems` at analysis time via `computeHasReactiveItems(body)`. The codegen emits this as `isReactive: true/false` in the `ListRegionHandlers` object:

```typescript
listRegion(parent, doc.items, {
  create: (item, _index) => {
    const _li0 = document.createElement("li")
    _li0.textContent = String(item.get())
    return _li0
  },
  slotKind: "single",
  isReactive: false,  // No reactive content → skip scope allocation
}, scope)
```

### Runtime Behavior

When `isReactive` is `false`, the `executeOp` function stores `null` instead of creating a child scope:

```typescript
const needsScope = handlers.isReactive !== false
const itemScope = needsScope ? state.parentScope.createChild() : null
```

The `scopes` array is typed as `(Scope | null)[]`. Delete and batch-delete paths already guard with `if (scope)` before calling `scope.dispose()`, so null entries are handled safely.

### When It Matters

This optimization is most valuable for large static lists — e.g., rendering 1000 items where each item is a simple `<li>` with no subscriptions. Without this optimization, 1000 `Scope` objects would be allocated (each with a `Set` for children tracking in the parent). With it, zero scopes are allocated for the items.

## Delta Region Algebra

Text patching, input text patching, list regions, and conditional regions all follow the same **Functional Core / Imperative Shell** pattern, forming a unified "delta region" algebra.

### The Pattern

Every delta region has three phases:

1. **Initial render** — Read current value, create DOM
2. **Subscribe** — Register for delta notifications
3. **Delta dispatch** — Apply surgical updates or fall back to full re-render

| Region Type | Planning (Pure) | Execution (Imperative) | Delta Type | DOM Target |
|-------------|-----------------|------------------------|------------|------------|
| Text | `planTextPatch(ops)` | `patchText(node, ops)` | `"text"` | Text node |
| Input Text | `planTextPatch(ops)` | `patchInputValue(input, ops)` | `"text"` | `<input>` / `<textarea>` value |
| Sequence | `planDeltaOps(ref, ops)` | `executeOp(parent, state, handlers, op)` | `"sequence"` | Parent element children |
| Conditional | `planConditionalUpdate(...)` | `executeConditionalOp(...)` | via condition ref | Branch swap |
| Value | — | `onValue(getValue())` | any (re-read) | Text node, attribute, etc. |

`valueRegion` is the **terminal object** in the delta region algebra — a region whose delta dispatch strategy is always "replace." It re-reads via `getValue()` and applies via `onValue()` on every change from any subscribed ref. It unifies the previous `subscribeWithValue` (single ref) and `subscribeMultiple` + manual init (multiple refs) into one function with a uniform three-phase pattern. All Changefeed → DOM wiring functions are now named as "regions."

The `read()` runtime helper is the universal value accessor for Changefeeds in generated code: `read(ref)` returns `ref[CHANGEFEED].current`. It keeps the `CHANGEFEED` symbol internal to the runtime, avoiding a cross-package import in every compiled component.

### Delta Provenance

`Changeset` carries an optional `origin` field (`"local"` | `"import"` | undefined). Backend adapters forward provenance information into this field (e.g., a Loro adapter would map `LoroEventBatch.by` to `origin`). This is a **provenance dimension** of the delta algebra — it describes *who caused the change*, not just *what changed*.

Most region types ignore provenance (Text nodes, lists, conditionals have no ephemeral local state affected by origin). The exception is `inputTextRegion`, where cursor management depends on whether the edit is local or remote. See **Input Text Region Architecture** above.

**Design principle:** Provenance is batch-level metadata on the `Changeset`, not per-change metadata. Core's `subscribe` unwraps batches and passes `changeset.origin` as the handler's second argument: `(change: ChangeBase, origin?: string) => void`. This lets consumers opt in to origin-awareness via the second parameter. Non-backend reactive types (e.g., `LocalRef`) omit the field — consumers treat `undefined` as "unknown origin" and fall back to safe defaults.

**Origin semantics:** `"local"` origin fires for both user input and local undo/redo operations. For `inputTextRegion`, this is correct — both user typing and local undo/redo want `"end"` selectMode (cursor follows the edit). Remote edits want `"preserve"` selectMode (cursor stays put relative to surrounding text).

### Delta Dispatch Strategy

Each region type handles its matching delta surgically:

- **Text deltas** → `insertData` / `deleteData` on Text nodes (character-level)
- **Input text deltas** → `patchInputValue` via `setRangeText` with origin-driven selectMode: `"end"` for local edits (cursor follows edit), `"preserve"` for remote edits (cursor preserves position)
- **Sequence deltas** → `insertBefore` / `removeChild` on parent (element-level)
- **Condition changes** → `replaceChild` for branch swapping

When a delta type doesn't match the region type (e.g., a "replace" delta arrives at a sequence region), the region falls back to full re-render — clear all items and re-create from scratch.

### Composability

Delta regions compose naturally:

```
┌─ div (template clone) ─────────────────────────────┐
│  ┌─ h1 ─────────────────────────────────────────┐   │
│  │  textRegion(doc.title)  ← text deltas        │   │
│  └───────────────────────────────────────────────┘   │
│  ┌─ input ───────────────────────────────────────┐   │
│  │  inputTextRegion(doc.search) ← text deltas    │   │
│  │  onBeforeInput: editText(doc.search) → CRDT   │   │
│  └───────────────────────────────────────────────┘   │
│  ┌─ conditionalRegion(doc.showDetails) ──────────┐   │
│  │  ┌─ listRegion(doc.items) ─────────────────┐  │   │
│  │  │  ┌─ li ────────────────────────────┐    │  │   │
│  │  │  │  textRegion(item.text)          │    │  │   │
│  │  │  └─────────────────────────────────┘    │  │   │
│  │  └─────────────────────────────────────────┘  │   │
│  └────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────┘
```

## Example Architecture

The `examples/recipe-book/` app is the reference implementation for the patterns described above. It exercises all four delta kinds, three component complexity levels, and the full SSR → hydration → sync lifecycle.

### Three-Flow SSR

Traditional SSR ships rendered HTML plus the full serialized state for hydration. Kyneta's approach decomposes this into three independent flows:

| # | Flow | Size | Delivery | Purpose |
|---|------|------|----------|---------|
| 1 | **Rendered HTML** | O(view) | Inline in response body | Immediate visual content — no JS execution needed |
| 2 | **Frontier** | O(1) | `<meta name="kyneta-version" content="N">` | Version integer: what the server already rendered |
| 3 | **Sync bootstrap** | O(missed ops) | WebSocket `{ type: "delta", ops, version }` | Operations since the frontier — async, post-hydration |

The key insight: **Flow 2 decouples Flow 1 from Flow 3.** The client reads the frontier from the `<meta>` tag, sends it to the server as the starting point, and only receives operations that occurred *after* the SSR snapshot. If nothing changed between SSR and WebSocket connection, the delta is empty.

This eliminates the "double data" problem (serialized state duplicating what's already in the HTML) and makes the SSR payload proportional to the *view*, not the *state*.

### Frontier-Based Sync Model

The recipe-book uses the degenerate single-peer case of a version vector:

```
version(doc) → number          Monotonic integer, increments on each flush cycle
delta(doc, fromVersion) → ops  log.slice(fromVersion).flat() → PendingChange[]
```

Sync state is stored per-document via `WeakMap<object, SyncState>`:

```typescript
interface SyncState {
  version: number
  log: PendingChange[][]   // log[i] = batch from version i → i+1
}
```

The version counter increments on every `subscribe(doc, ...)` delivery — both local `change()` calls and remote `applyChanges()` calls. This is correct for the single-server-authority model.

**Upgrade path:** The integer becomes a version vector, `delta()` computes the set difference, and the wire format (`{ type, ops, version }`) remains compatible. The same `PendingChange` type (`{ path: PathSegment[], change: ChangeBase }`) carries operations regardless of the sync topology.

### The `createApp(doc)` Factory Pattern

The app factory is a pure builder function:

```typescript
function createApp(doc: RecipeBookDoc) {
  const filterText = state("")       // local UI state
  const veggieOnly = state(false)    // local UI state

  return div({ class: "recipe-book" }, () => {
    h1(doc.title)                    // textRegion (delta: text)
    Toolbar({ doc, filterText, veggieOnly })
    for (const recipe of doc.recipes) {  // listRegion (delta: sequence)
      RecipeCard({ recipe, onRemove: ... })
    }
  })
}
```

Key properties:

- **Does not own the document lifecycle** — server and client both call it with their own doc instance
- **Isomorphic** — the Kyneta compiler transforms the same source to DOM factories (client, via `target: "dom"`) or HTML accumulators (server, via `target: "html"` auto-detected from Vite's `transformOptions.ssr`)
- **Does not know about transport** — mutations via `change()` are forwarded by the caller's sync wiring, not the app

### Schema / Local-State Boundary

The recipe-book demonstrates a motivated boundary between two kinds of reactive state:

| Kind | Created by | Reactive? | Synced? | Example |
|------|-----------|-----------|---------|---------|
| **Document state** | `createDoc(schema, seed)` → `Ref<S>` | Yes (`[CHANGEFEED]`) | Yes (via `PendingChange[]`) | Recipe data, favorites counter |
| **Local state** | `state(initial)` → `LocalRef<T>` | Yes (`[CHANGEFEED]`) | No | Search filter, veggie-only toggle |

Both participate in the `[CHANGEFEED]` protocol, so the compiler treats them identically for reactive detection — the same `valueRegion`, `conditionalRegion`, etc. are emitted regardless of the state's provenance. The distinction is purely at the sync layer: `subscribe(doc, ...)` captures document mutations as `PendingChange[]` for WebSocket transport; `LocalRef` changes stay local.

The boundary is domain-motivated: filter preferences are per-user-session (local), while recipe data is shared (document). This pattern generalizes to any app with collaborative + private state.


Each region independently subscribes to its own reactive source. Parent disposal cascades to children via the `Scope` tree. Template cloning provides the static structure; delta regions fill in the dynamic holes.