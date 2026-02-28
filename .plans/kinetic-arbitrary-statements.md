# Plan: Kinetic — Support Arbitrary TypeScript Statements in Builder Functions

## Background

Kinetic's core promise is **"Write natural TypeScript. Compile to O(k) delta-driven DOM."** The framework explicitly rejects ceremony and escape hatches — users should write idiomatic TypeScript and the compiler handles the rest.

From the original Kinetic plan:

> **No Escape Hatches, No Ceremony**
> - ❌ "Use `for` for simplicity, `each()` for speed" — cognitive load
> - ❌ "Wrap reactive expressions in `$()`" — ceremony
> - ✅ "Write `if`/`for`. It's fast." — beautiful
>
> The user writes idiomatic code. The compiler does the work.

The compiler currently follows a Functional Core / Imperative Shell architecture via an Intermediate Representation (IR):

```
┌─────────────────┐    ┌─────────────┐    ┌─────────────────┐
│ analyze.ts      │    │ IR Types    │    │ codegen/*.ts    │
│ (AST → IR)      │ →  │ (Data)      │ →  │ (IR → Code)     │
│ Pure Functions  │    │ Serializable│    │ Pure Functions  │
└─────────────────┘    └─────────────┘    └─────────────────┘
```

## Problem Statement

The Kinetic compiler **silently drops** arbitrary TypeScript statements that aren't recognized UI constructs. The `analyzeStatement()` function only handles:

1. Expression statements that are element factory calls (`div()`, `li()`, etc.)
2. `for...of` statements (for list regions)
3. `if` statements (for conditional regions)
4. Block statements (for nesting)

Everything else returns `null` and is silently ignored:
- Variable declarations (`const x = ...`, `let y = ...`)
- Function declarations
- Non-element expression statements (`console.log()`, `count.get()`)
- While/switch/try-catch statements
- Return statements (in some contexts)

This causes runtime errors when users write valid TypeScript like:

```typescript
for (const itemRef of doc.todos) {
  const item = itemRef.get()  // ← Silently dropped!
  li(item)                    // ← Uses undefined `item`
}
```

The user sees no compile-time warning. At runtime, `item is not defined` crashes the app.

**This violates Kinetic's core promise.** Users expect any valid TypeScript to work.

## Success Criteria

1. **All valid TypeScript statements compile** — No silent dropping of code
2. **Runtime behavior matches source semantics** — Variables declared in source are available where expected
3. **Statement/element interleaving preserved** — Side effects execute in source order
4. **Static loops and conditionals work** — Non-reactive `for...of` and `if` create elements correctly
5. **Existing tests continue to pass** — No regression in current functionality
6. **Both DOM and HTML targets work** — Statement preservation works for client and SSR
7. **Clear error messages** — Unsupported constructs (e.g., `return`) emit compile-time errors, not silent failures

## The Gap

| Aspect | Current State | Target State |
|--------|---------------|--------------|
| Variable declarations | Silently dropped | Preserved in output |
| Arbitrary expressions | Silently dropped | Preserved in output |
| Loop body statements | Only element calls | All statements |
| Conditional body statements | Only element calls | All statements |
| Static `for...of` loops | Silently dropped (returns `null`) | Analyzed and rendered once |
| Static `if` statements | Silently dropped (returns `null`) | Analyzed and rendered conditionally |
| `return` statements | Would become broken `StatementNode` | Compile-time error with clear message |
| Failure mode | Silent runtime crash | Compile-time error or success |
| Code duplication | `generateListRegion` ≈ `generateBranchBody` | Shared helper functions |

## Architecture Decisions

### Decision 1: Expand IR with `StatementNode`

Add a `StatementNode` to the IR that captures any statement's source text. This:
- Preserves the existing FC/IS architecture
- Keeps IR inspectable and testable
- Requires minimal structural changes
- Allows codegen to emit statements verbatim

### Decision 2: Always Use Block Body in HTML Codegen

Rather than conditionally switching between expression body and block body based on statement presence, **always use block body** with HTML accumulation:

```typescript
// Always generate this pattern:
items.map((item) => {
  let _html = "";
  console.log("before");      // statements execute in order
  _html += `<li>${item}</li>`;
  console.log("after");
  return _html
}).join("")
```

**Rationale**:
- Single code path (no conditional logic)
- Preserves statement/element interleaving for side effects
- Consistent with DOM codegen's existing block body approach
- Negligible runtime overhead

### Decision 4: Remove Single-Element Optimization

Current code has optimization: `if (body.length === 1 && body[0].kind === "element")`. This becomes complex with statements. Instead, always use the fragment/accumulation path — the optimization provides negligible benefit.

### Decision 5: Statement Capture Scope

Only capture as `StatementNode` statements that can't be analyzed deeper. Preserve existing recursive handling of block statements so nested elements are still discovered.

### Decision 6: Static Loops and Conditionals — Analyze and Generate Static Code

Currently, non-reactive `for...of` loops and static `if` statements return `null` from analysis, which would cause them to become `StatementNode` with unanalyzed element calls inside (breaking at runtime).

**Decision**: Analyze the body anyway and generate static code that runs once at render time.

```typescript
// User writes static loop:
for (const x of [1, 2, 3]) {
  li(x)
}

// DOM codegen generates (runs once):
for (const x of [1, 2, 3]) {
  const _li = document.createElement("li")
  _li.textContent = String(x)
  _parent.appendChild(_li)
}

// HTML codegen generates:
[1, 2, 3].map((x) => { let _html = ""; _html += `<li>${x}</li>`; return _html }).join("")
```

**Rationale** (Principle of Least Surprise):
- User expectation: "My loop iterates and creates elements" — this should work
- Semantics match TypeScript: A static loop runs once, creating elements
- No false errors: User doesn't have to change working code
- Correct behavior: Static content isn't reactive — and shouldn't be

This requires adding `StaticLoopNode` and `StaticConditionalNode` to the IR, or reusing existing nodes with a `reactive: boolean` flag.

### Decision 7: Return Statements — Compile-Time Error

Early `return` statements in builder functions break the factory contract (must return a DOM node). Rather than silently emit broken code:

**Decision**: Detect `return` statements and emit a clear compile-time error.

```
Kinetic Compiler Error: Return statement not supported in builder function at line 42.
Builder functions must produce DOM elements, not return early.
```

### Decision 8: HTML generateChild for Statements — Consistent Handling

The HTML `generateChild()` function is called from multiple places (`generateElement`, `generateListRegion`, etc.). Returning empty string for statements would silently drop them in some contexts.

**Decision**: All body iteration must go through `generateBodyHtml()` which handles statements correctly. Update `generateElement` to use `generateBodyHtml` for its children when statements may be present (or always, for consistency).

## IR Type Addition

```typescript
// New IR node type in ir.ts
export interface StatementNode extends IRNodeBase {
  kind: "statement"
  /** The original source text of the statement */
  source: string
}

// Update ChildNode union
export type ChildNode =
  | ElementNode
  | TextNode
  | ExpressionNode
  | ListRegionNode
  | ConditionalRegionNode
  | BindingNode
  | StatementNode  // NEW
  | StaticLoopNode  // NEW
  | StaticConditionalNode  // NEW

// New: Static loop (non-reactive for...of)
export interface StaticLoopNode extends IRNodeBase {
  kind: "static-loop"
  /** The iterable expression source (e.g., "[1, 2, 3]", "someArray") */
  iterableSource: string
  /** The loop variable name */
  itemVariable: string
  /** Optional index variable */
  indexVariable: string | null
  /** The analyzed body — elements are still discovered */
  body: ChildNode[]
  hasStatements: boolean
}

// New: Static conditional (non-reactive if)
export interface StaticConditionalNode extends IRNodeBase {
  kind: "static-conditional"
  /** The condition expression source */
  conditionSource: string
  /** Then branch body */
  thenBody: ChildNode[]
  /** Else branch body (if present) */
  elseBody: ChildNode[] | null
  hasStatements: boolean
}

```

## Phases and Tasks

### Phase 0: Refactor — Extract Shared Helpers ✅

Extract duplicate code into shared helpers before adding new functionality.

- ✅ **Task 0.1**: Extract `generateBodyWithReturn()` in DOM codegen (`codegen/dom.ts`)
  - Consolidates logic from `generateListRegion()` and `generateBranchBody()`
  - Handles: emit children, wrap in fragment if needed, return
  - Remove single-element optimization (always use fragment path)

- ✅ **Task 0.2**: Extract `generateBodyHtml()` in HTML codegen (`codegen/html.ts`)
  - Consolidates body iteration from `generateListRegion()` and `generateConditionalRegion()`
  - Uses block body with HTML accumulation pattern
  - Returns string suitable for block body: `let _html = ""; _html += ...; return _html`

- ✅ **Task 0.3**: Verify existing tests still pass after refactor
  - Run `pnpm turbo run verify --filter=@loro-extended/kinetic`
  - Updated one test that expected single-element optimization (now uses fragment path)
  - All 471 tests pass

### Phase 1: IR and Analysis Updates ✅

Update the IR types and analysis to capture arbitrary statements, static loops, and static conditionals.

- ✅ **Task 1.1**: Add `StatementNode` to IR types (`ir.ts`)
  - Add interface definition
  - Update `ChildNode` union type
  - Add `isStatementNode()` type guard
  - Add `createStatement()` factory function

- ✅ **Task 1.2**: Add `StaticLoopNode` and `StaticConditionalNode` to IR types (`ir.ts`)
  - Add interface definitions (see IR Type Addition section)
  - Update `ChildNode` union type
  - Add type guards and factory functions

- ✅ **Task 1.3**: Update `analyzeStatement()` to capture unrecognized statements (`analyze.ts`)
  - Instead of returning `null` for unrecognized statements, create `StatementNode`
  - Preserve original source text via `stmt.getText()`
  - Keep existing block statement recursion (don't capture blocks as statements)
  - Variable declarations, non-element expression statements → `StatementNode`
  - **Detect `return` statements → emit compile-time error**

- ✅ **Task 1.4**: Update `analyzeForOfStatement()` for static loops (`analyze.ts`)
  - When `!expressionIsReactive(iterExpr)`, still analyze body
  - Create `StaticLoopNode` instead of returning `null`
  - Body analysis discovers elements inside static loops

- ✅ **Task 1.5**: Update `analyzeIfStatement()` for static conditionals (`analyze.ts`)
  - When condition is static and no reactive subscription target, still analyze branches
  - Create `StaticConditionalNode` instead of returning `null`
  - Branch analysis discovers elements inside static conditionals

- ✅ **Task 1.6**: Write analysis unit tests (10 new tests, 481 total tests pass)
  - Test: `const x = 1` inside builder → captured as `StatementNode`
  - Test: `console.log("debug")` inside builder → captured as `StatementNode`
  - Test: Variable declaration inside `for...of` body → captured as `StatementNode`
  - Test: Variable declaration inside `if` body → captured as `StatementNode`
  - Test: Multiple statements in sequence → all captured in order
  - Test: Block statement still recursively analyzed (not captured as single statement)
  - Test: `return` statement → compile-time error
  - Test: Static `for...of` → `StaticLoopNode` with analyzed body
  - Test: Static `if` → `StaticConditionalNode` with analyzed branches

### Phase 2: DOM Codegen Updates ✅

Update DOM code generation to emit statements and static loops/conditionals.

- ✅ **Task 2.1**: Update `generateChild()` to handle `StatementNode` (`codegen/dom.ts`)
  - Emit statement source verbatim with proper indentation
  - Return `{ code: [indented statement] }` (no DOM node produced)

- ✅ **Task 2.2**: Update `generateChild()` to handle `StaticLoopNode` (`codegen/dom.ts`)
  - Added `generateStaticLoop()` function
  - Generates regular `for...of` loop with elements appended to parent
  - Supports index variable via array destructuring pattern

- ✅ **Task 2.3**: Update `generateChild()` to handle `StaticConditionalNode` (`codegen/dom.ts`)
  - Added `generateStaticConditionalNode()` function
  - Generates regular `if` statement with optional `else` branch
  - Elements created and appended to parent in each branch

- ✅ **Task 2.4**: Write DOM codegen unit tests (9 new tests, 490 total tests pass)
  - Test: Statement emitted verbatim in output
  - Test: Statement inside list region `create` callback
  - Test: Interleaved statements and elements preserve order
  - Test: Static loop generates `for...of` with element creation inside
  - Test: Static loop with index variable
  - Test: Static conditional generates `if` with element creation inside
  - Test: Static conditional with else branch
  - Test: Statements inside static loop body
  - Test: Statements inside static conditional branches

Note: `generateBodyWithReturn()` was extracted in Phase 0 and already iterates children via `generateChild()`, so statements automatically work in list regions and conditional branches.

### Phase 3: HTML Codegen Updates ✅

Update HTML code generation to handle new node types. Note: Phase 0 already implemented `generateBodyHtml()` with block body and accumulation pattern, and updated `generateListRegion()` and `generateConditionalRegion()` to use it.

- ✅ **Task 3.1**: `generateBodyHtml()` with accumulation pattern — **Done in Phase 0**
  - Already implemented: `let _html = ""; _html += ...; return _html`
  - List regions and conditionals already use block body syntax

- ✅ **Task 3.2**: Update `generateBodyHtml()` and `generateChild()` to handle `StatementNode` (`codegen/html.ts`)
  - `generateBodyHtml()` checks for statement nodes and emits source verbatim
  - `generateChild()` returns empty string for statements (handled by body context)

- ✅ **Task 3.3**: Update `generateChild()` to handle `StaticLoopNode` (`codegen/html.ts`)
  - Added `generateStaticLoopInline()` — generates `.map()` with block body
  - Added `generateStaticLoopBody()` — generates `for...of` for body accumulation context

- ✅ **Task 3.4**: Update `generateChild()` to handle `StaticConditionalNode` (`codegen/html.ts`)
  - Added `generateStaticConditionalInline()` — generates IIFE with `if` statement
  - Added `generateStaticConditionalBody()` — generates `if` for body accumulation context

- ✅ **Task 3.5**: Write HTML codegen unit tests (13 new tests, 503 total tests pass)
  - Created `codegen/html.test.ts` with comprehensive test coverage
  - Test: Statement emitted in list region body
  - Test: Statement emitted in conditional region body
  - Test: Interleaved statements and elements preserve order
  - Test: Static loop generates `.map()` expression
  - Test: Static loop with index variable
  - Test: Statements inside static loop
  - Test: Static conditional generates IIFE
  - Test: Static conditional with else branch
  - Test: Statements inside static conditional
  - Test: Code validity (balanced braces, parentheses, backticks)

### Phase 4: Integration Testing 🔴

End-to-end tests with real compilation and execution.

- 🔴 **Task 4.1**: Integration test: variable declaration in for-of body
  - Source: `for (const ref of list) { const val = ref.get(); li(val) }`
  - Verify DOM output renders correctly
  - Verify HTML output renders correctly

- 🔴 **Task 4.2**: Integration test: multiple statements in builder
  - Source with `const`, function call, element calls
  - Verify all execute in correct order

- 🔴 **Task 4.3**: Integration test: interleaved statements and elements
  - Source: `for (const item of list) { console.log("a"); li(item); console.log("b") }`
  - Verify side effects execute in correct order (DOM and HTML)

- 🔴 **Task 4.4**: Integration test: static loop
  - Source: `for (const x of [1, 2, 3]) { li(x) }`
  - Verify DOM creates three `<li>` elements
  - Verify HTML outputs three `<li>` elements

- 🔴 **Task 4.5**: Integration test: static conditional
  - Source: `if (true) { p("shown") }` and `if (false) { p("hidden") }`
  - Verify correct rendering in DOM and HTML

- 🔴 **Task 4.6**: Integration test: return statement error
  - Source: `div(() => { if (x) return; p("hello") })`
  - Verify compile-time error is emitted

- 🔴 **Task 4.7**: Fix the original bug
  - Update `kinetic-todo` example's `app.ts` to use `const item = itemRef.get()`
  - Verify the app works with SSR and client-side hydration

### Phase 5: Documentation 🔴

- 🔴 **Task 5.1**: Update kinetic plan with learnings
  - Document the statement support addition
  - Note the "any valid TypeScript" principle

- 🔴 **Task 5.2**: Add to TECHNICAL.md
  - Document IR node types including StatementNode
  - Document HTML codegen block body / accumulation pattern


## Unit and Integration Tests

### Analysis Tests (Phase 1)

```typescript
describe("analyzeStatement - arbitrary statements", () => {
  it("should capture variable declarations as StatementNode", () => {
    // const x = 1 inside builder → StatementNode with source "const x = 1"
  })

  it("should capture expression statements as StatementNode", () => {
    // console.log("debug") → StatementNode
  })

  it("should preserve statement order", () => {
    // Multiple statements → captured in source order
  })

  it("should still recursively analyze block statements", () => {
    // { const x = 1; p(x) } → block contains StatementNode + ElementNode
    // NOT: block captured as single StatementNode
  })

  it("should emit compile-time error for return statements", () => {
    // return inside builder → error, not StatementNode
  })

  it("should create StaticLoopNode for non-reactive for...of", () => {
    // for (const x of [1,2,3]) { li(x) } → StaticLoopNode with ElementNode in body
  })

  it("should create StaticConditionalNode for static if", () => {
    // if (true) { p("yes") } → StaticConditionalNode with ElementNode in thenBody
  })
})
```

### DOM Codegen Tests (Phase 2)

```typescript
describe("generateDOM - statements", () => {
  it("should emit statement source verbatim", () => {
    const stmt = createStatement("const x = 1", span(...))
    const builder = createBuilder("div", [], [], [stmt, element], span(...))
    const code = generateDOM(builder)
    expect(code).toContain("const x = 1")
  })

  it("should emit statements in list region create callback", () => {
    // List with statement in body → statement appears in create handler
  })

  it("should preserve interleaving", () => {
    // [stmt1, element, stmt2] → emitted in that order
  })

  it("should generate static loop as for...of with body", () => {
    // StaticLoopNode → for (const x of iterable) { createElement... }
  })

  it("should generate static conditional as if statement", () => {
    // StaticConditionalNode → if (cond) { createElement... }
  })
})
```

### HTML Codegen Tests (Phase 3)

```typescript
describe("generateHTML - statements", () => {
  it("should emit statement in list body via generateChild", () => {
    // StatementNode in list body → statement source emitted in block body
  })

  it("should preserve interleaving for side effects", () => {
    // [log("a"), element, log("b")] → log("a"); _html += ...; log("b"); return _html
  })

  it("should generate static loop as .map() with block body", () => {
    // StaticLoopNode → iterable.map((x) => { let _html = ""; ... return _html }).join("")
  })

  it("should generate static conditional as IIFE with if", () => {
    // StaticConditionalNode → (() => { if (cond) { ... } else { ... } })()
  })
})
```

### Integration Tests (Phase 4)

```typescript
describe("compiler integration - statements", () => {
  it("should compile and execute variable declaration in for-of", () => {
    const source = `
      for (const itemRef of doc.items) {
        const item = itemRef.get()
        li(item)
      }
    `
    // Compile to DOM, execute, verify rendering
    // Compile to HTML, execute, verify output
  })

  it("should preserve side effect order", () => {
    // Verify console.log order matches source order
  })

  it("should render static loops correctly", () => {
    // for (const x of [1,2,3]) { li(x) } → three <li> elements
  })

  it("should render static conditionals correctly", () => {
    // if (true) { p("yes") } → <p>yes</p>
    // if (false) { p("no") } → (nothing)
  })

  it("should emit error for return statements", () => {
    // return in builder → compile error
  })
})
```

## Transitive Effect Analysis

### Direct Dependencies

1. **`ir.ts`** — New `StatementNode`, `StaticLoopNode`, `StaticConditionalNode` types (Phase 1 ✅)
2. **`analyze.ts`** — Updated `analyzeStatement()`, `analyzeForOfStatement()`, `analyzeIfStatement()` (Phase 1 ✅)
3. **`codegen/dom.ts`** — `generateBodyWithReturn()` extracted (Phase 0 ✅), `generateChild()` needs updates for new node types (Phase 2)
4. **`codegen/html.ts`** — `generateBodyHtml()` with block body (Phase 0 ✅), `generateChild()` needs updates for new node types (Phase 3)

### Transitive Dependencies

1. **`transform.ts`** — Orchestrates analysis and codegen; no changes needed (passes IR through)
2. **`vite/plugin.ts`** — Uses `transform.ts`; no changes needed
3. **Integration tests** — Some already updated in Phase 0 (block body change); may need more updates in Phase 2/3
4. **`kinetic-todo` example** — Will work correctly after Phase 4 fix

### No Impact Expected

- Runtime (`regions.ts`, `scope.ts`) — Unchanged; generated code calls same runtime functions
- Type declarations (`elements.d.ts`) — Unchanged
- Server utilities (`serialize.ts`, `render.ts`) — Unchanged

## Resources for Implementation

### Files to Read/Modify

1. `packages/kinetic/src/compiler/ir.ts` — Add StatementNode, hasStatements
2. `packages/kinetic/src/compiler/analyze.ts` — Update analyzeStatement()
3. `packages/kinetic/src/compiler/codegen/dom.ts` — Extract helper, update generateChild()
4. `packages/kinetic/src/compiler/codegen/html.ts` — Extract helper, block body pattern
5. `packages/kinetic/src/compiler/analyze.test.ts` — Add statement tests
6. `packages/kinetic/src/compiler/codegen/dom.test.ts` — Add statement tests
7. `examples/kinetic-todo/src/app.ts` — Fix to use variable declaration pattern

### Reference Files

1. `.plans/kinetic-delta-driven-ui.md` — Original architecture and design principles
2. `packages/kinetic/src/compiler/ir.test.ts` — IR test patterns
3. `packages/kinetic/src/compiler/integration.test.ts` — Integration test patterns

## Changeset

A patch changeset is appropriate since this is a bug fix that enables documented behavior:

```
---
"@loro-extended/kinetic": patch
---

Fix: Support arbitrary TypeScript statements in builder functions

Previously, variable declarations and other non-element statements inside
builder functions were silently dropped, causing runtime errors. Now all
valid TypeScript statements are preserved in the compiled output.

This fixes the "item is not defined" error when using patterns like:

    for (const itemRef of doc.todos) {
      const item = itemRef.get()
      li(item)
    }
```

## Documentation Updates

### TECHNICAL.md Addition

Add to Kinetic section:

```markdown
### Kinetic Compiler — Statement Preservation

The Kinetic compiler preserves all TypeScript statements in builder functions,
not just element calls and control flow. This includes:

- Variable declarations (`const`, `let`, `var`)
- Expression statements (`console.log()`, function calls)
- Any other valid TypeScript statement

**IR Representation**: Statements are captured as `StatementNode` in the IR.
The `hasStatements` boolean on `ListRegionNode` and `ConditionalBranch` is
computed during IR creation (FC/IS principle — keep codegen pure).

**DOM Codegen**: Statements are emitted verbatim in source order.

**HTML Codegen**: Uses block body with accumulation pattern to preserve
statement/element interleaving:

    // Generated code pattern:
    items.map((item) => {
      let _html = "";
      console.log("before");      // statement
      _html += `<li>${item}</li>`;  // HTML accumulation
      console.log("after");       // statement
      return _html
    }).join("")
```

## Learnings

### Block Body Consistency

During planning, we considered conditionally using block body vs expression body based on statement presence. Analysis revealed that **always using block body** is superior:

1. Single code path eliminates conditional complexity
2. Preserves statement/element interleaving for side effects
3. Consistent with DOM codegen's existing approach
4. Negligible runtime overhead (`=> { return x }` vs `=> x`)

This decision also meant `hasStatements` flag was unnecessary — we removed it from the plan before implementing Phase 1.

### Statement Capture Scope

Not all statements should be captured as `StatementNode`. Block statements must still be recursively analyzed to discover nested elements. Only "leaf" statements (variable declarations, expression statements that aren't element calls) become `StatementNode`.

### Phase 0 Did More Than Expected

When extracting `generateBodyHtml()` in Phase 0, we implemented the full block body + accumulation pattern and updated both `generateListRegion()` and `generateConditionalRegion()` to use it. This means Phase 3 is simpler than originally planned — we only need to:
1. Handle `StatementNode` in `generateChild()` (emit source for accumulation)
2. Handle `StaticLoopNode` and `StaticConditionalNode` in `generateChild()`

### HTML Codegen Generates JavaScript

A key insight: HTML codegen produces **JavaScript template literals**, not pure HTML. The generated code like:
```javascript
items.map((item) => { let _html = ""; _html += `<li>${item}</li>`; return _html }).join("")
```
...is JavaScript that runs at render time to produce HTML strings. This means statements can exist inside callbacks — they're JavaScript code, not embedded in HTML templates.

### Static Loops and Conditionals — Principle of Least Surprise

The original implementation returned `null` for non-reactive `for...of` and static `if` statements, intending to "handle them differently later." With our `StatementNode` addition, these would become verbatim statements with unanalyzed element calls inside — causing runtime errors like "li is not a function."

The principle of least surprise dictates: **the user's TypeScript should just work**. A static loop like `for (const x of [1,2,3]) { li(x) }` should create three `<li>` elements. The fact that it's not "reactive" is an implementation detail the user shouldn't need to know.

Solution: Analyze the body regardless of reactivity, and generate static code (regular `for` loop or `.map()`) that runs once at render time. This required new IR nodes (`StaticLoopNode`, `StaticConditionalNode`) to distinguish from delta-driven reactive regions.

### Return Statements — Contract Violation

Builder functions have a contract: they return a DOM node (or HTML string). An early `return` statement breaks this contract. Rather than emit broken code that fails at runtime, we emit a compile-time error. This is one of the few cases where we restrict TypeScript — but with a clear error message explaining why.

### HTML generateChild Context Sensitivity

The HTML `generateChild()` function is called from multiple contexts. Initially, we planned to return empty string for `StatementNode` and handle statements specially in `generateBodyHtml()`. However, this would silently drop statements when `generateChild()` is called from `generateElement()`.

Solution: Route all body/children iteration through `generateBodyHtml()`, which uses the accumulation pattern and handles statements correctly. This ensures consistent behavior regardless of where children appear.