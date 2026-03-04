# Plan: Kinetic SSR — Fix Top-Level Statement Drops + `client:` / `server:` Target Labels

## Background

Kinetic compiles the same builder-pattern source file to two targets:
- **DOM** (client): `(scope) => { createElement... return node }`
- **HTML** (server/SSR): `() => \`<div>...</div>\``

The Vite plugin auto-detects which target to use via `transformOptions.ssr`. The compiler's analysis phase produces an IR tree where arbitrary TypeScript statements inside builder bodies are captured as `StatementNode`. The DOM codegen emits these verbatim. The HTML codegen handles them correctly inside loop and conditional bodies via the `emitBodyChildren` / `generateBodyHtml` accumulation pattern — but **not** at the top level of a builder, and **not** inside nested element children.

Additionally, Kinetic currently has no mechanism to mark code as client-only or server-only. The builder function body is the one place where the same source compiles to both targets, so developers need a way to express "this code should only run on the client" (e.g., `requestAnimationFrame` loops) or "this code should only run on the server" (e.g., logging, timing).

### Prior art in this codebase

- The `kinetic-arbitrary-statements` plan (fully completed ✅) introduced `StatementNode` to IR, statement handling in DOM codegen and in HTML codegen's loop/conditional bodies, and the `emitBodyChildren` shared helper.
- Decision 2 from that plan ("Always Use Block Body in HTML Codegen") established the accumulation pattern (`let _html = ""; ...; return _html`) as the standard approach.
- Decision 8 noted: "All body iteration must go through `generateBodyHtml()` which handles statements correctly."

## Problem Statement

### Bug: Statements silently dropped in HTML codegen (two sites)

**Site 1 — Top-level builder body**: `generateHTML` iterates a `BuilderNode`'s children and calls `generateChild()` for each. `generateChild` returns `""` for `StatementNode`. `generateRenderFunction` wraps the result in `() => { return \`...\` }` — a simple arrow with no room for statements before the template literal.

**Site 2 — Nested element children**: `generateElement` (html.ts) has the *identical* pattern — it iterates `node.children` via `generateChild()`, which also drops statements. A builder like `header(() => { const x = 1; h1(x.toString()) })` would silently lose `const x = 1` during SSR.

**Root cause**: The HTML codegen has two calling conventions that can't interoperate:

1. **Template literal context** (`generateChild` / `generateElement` / `generateHTML`): returns raw HTML fragments like `<p>${__escapeHtml(x)}</p>` that go inside backticks. Cannot express statements.
2. **Accumulation context** (`emitBodyChildren` / `generateBodyHtml`): returns code lines like `_html += \`...\``; `const x = 1`. Can express everything.

Each IR construct has *two* generators — one for each context. For example, `generateReactiveLoop` (template literal context) vs `generateLoopBody` (accumulation context), and `generateConditional` vs `generateConditionalBody`. Statements only work in context 2, but elements and the top-level builder use context 1.

**Result**: `const x = state(0)` is dropped, but `x.get().toString()` is interpolated in the template literal → `ReferenceError: x is not defined` at runtime.

The DOM codegen (`codegen/dom.ts`) does **not** have this bug — it has a single calling convention where `generateChild` returns `string[]` (code lines) and handles all node types including statements.

### Missing feature: Client/server target labels

Developers writing builder functions have no way to mark code as client-only or server-only. Code like `requestAnimationFrame(...)` crashes on the server; server-only logging shouldn't ship to the client bundle.

**Design decision (from discussion)**: Use **labeled blocks** — `client: { ... }` and `server: { ... }` — as target annotations inside builder functions. These are valid TypeScript syntax, self-documenting, symmetric, and trivially detectable via ts-morph (`SyntaxKind.LabeledStatement`).

## Success Criteria

1. **Statements at the top level of a builder are preserved in HTML codegen** — `const x = state(0)` inside a builder body produces working SSR output
2. **Statements inside nested element builders are preserved in HTML codegen** — `header(() => { const x = 1; h1(x.toString()) })` works
3. **`client:` labeled blocks are stripped during HTML (SSR) codegen and preserved during DOM (client) codegen**
4. **`server:` labeled blocks are preserved during HTML (SSR) codegen and stripped during DOM (client) codegen**
5. **Unlabeled code compiles to both targets** (existing behavior, unchanged)
6. **Nested `client:` / `server:` blocks inside loops and conditionals work correctly**
7. **The kinetic-todo example runs without `ReferenceError` on SSR**
8. **All existing tests continue to pass**

## The Gap

| Need | Current State | Solution |
|------|---------------|----------|
| Top-level builder statements in HTML codegen | Silently dropped (dual calling conventions) | Unify HTML codegen to single accumulation-line convention |
| Nested element statements in HTML codegen | Same bug (same dual-convention architecture) | Same fix — unification eliminates the bug everywhere |
| Duplicate generators per construct | `generateReactiveLoop` + `generateLoopBody`, `generateConditional` + `generateConditionalBody`, etc. | Delete template-literal-context variants; keep accumulation variants |
| `client:` blocks | Not recognized | New IR node `TargetBlockNode`; `analyzeStatement` detects `LabeledStatement` with `client` label |
| `server:` blocks | Not recognized | Same IR node with `target: "html"`; symmetric handling |
| Stripping logic | N/A | Pure `filterTargetBlocks` function strips/unwraps before codegen; codegens never see `TargetBlockNode` |

## Architecture Decisions

### Decision A: Unify HTML Codegen to Single Calling Convention

Rather than patching `generateElement` with IIFEs or conditional accumulation, **eliminate the dual-calling-convention architecture entirely**. All HTML codegen functions produce `string[]` (code lines that accumulate into `_html`), matching how the DOM codegen already works.

**Before** (two calling conventions):
- `generateChild` returns template literal content (`string`)
- `generateElement` returns template literal content (`string`)
- `generateHTML` returns a template literal (`string`)
- `generateReactiveLoop` returns template literal content (`string`)
- `generateConditional` returns template literal content (`string`)
- `emitBodyChildren` returns accumulation lines (`string[]`)
- `generateLoopBody` returns accumulation lines (`string`)
- `generateConditionalBody` returns accumulation lines (`string`)

**After** (one calling convention):
- `emitChild` returns accumulation lines (`string[]`)
- `emitElement` returns accumulation lines (`string[]`)
- `emitLoop` returns accumulation lines (`string[]`)
- `emitConditional` returns accumulation lines (`string[]`)
- `emitChildren` iterates children via `emitChild` (`string[]`)

Each construct has one generator, not two. Statements are just lines interleaved with `_html +=` lines.

**Generated output before:**
```
() => {
  return `<ul>${[...items].map((item, _i) => { let _html = ""; _html += `<li>${__escapeHtml(String(item))}</li>`; return _html }).join("")}</ul>`
}
```

**Generated output after:**
```
() => {
  let _html = ""
  _html += `<ul>`
  for (const item of [...items]) {
    _html += `<li>${__escapeHtml(String(item))}</li>`
  }
  _html += `</ul>`
  return _html
}
```

**Benefits:**
- Statements just work everywhere — they're lines interleaved with `_html +=` lines
- One generator per construct instead of two (less code, less maintenance)
- Generated code is more readable and debuggable
- `for` loops replace `.map().join("")` (no intermediate array allocation)
- `if/else` blocks replace ternary-with-IIFE (simpler generated code)
- No IIFEs anywhere in the generated output
- Template literal context variants are deleted, not modified

**Runtime performance**: SSR performance is dominated by I/O, not string ops. `_html += \`...\`` is the same speed as template literal interpolation. The `for` loop replacing `.map().join("")` is actually a minor improvement (no intermediate array).

**Callers of `generateHTML`**: Two call sites in `transform.ts`:
1. `transformSourceInPlace` → `generateRenderFunction` (Vite/SSR path) — already wraps in `() => { ... }`
2. `generateHTMLOutput` → wraps in `const renderN = () => ${html}` — changes to `const renderN = () => { ${html} }`

Both trivially accommodate the block-body change.

### Decision B: Filter Before Codegen (FC/IS)

Rather than modifying every codegen switch site to handle `TargetBlockNode`, adopt a **filter-before-codegen** approach:

Add a pure function `filterTargetBlocks(node: BuilderNode, target: CompileTarget): BuilderNode` that recursively:
- **Strips** `TargetBlockNode` nodes whose target doesn't match (removes them entirely)
- **Unwraps** `TargetBlockNode` nodes whose target matches (replaces the node with its children)
- Recurses into element children, loop bodies, conditional branches

Call this in `transformSourceInPlace` after analysis and before codegen.

**Benefits**:
- Codegens remain pure IR → string transforms with no target awareness
- `walk.ts`, `template.ts`, `computeSlotKind`, `computeHasReactiveItems` need zero changes
- The filter function is trivially testable in isolation
- No new `case "target-block"` in switch sites across two codegens
- The IR union type still includes `TargetBlockNode` (for analysis output / inspection), but codegen receives a filtered view

## PR Stack

The work is arranged as three PRs, each independently buildable, testable, and reviewable. The narrative builds from "unify the architecture (which fixes the bug)" → "add the new capability" → "apply both to the real example and document."

### PR 1: Unify HTML codegen calling convention (refactor + bug fix) 🔴

**Type**: Refactor + bug fix (tests first, then refactor)

This PR eliminates the dual-calling-convention architecture in `codegen/html.ts`, replacing it with a single accumulation-line convention. The statement-dropping bug disappears as a structural consequence — there is no longer a code path that can't express statements. No new IR types, no new features.

**Scope of changes**: `codegen/html.ts` (primary), `transform.ts` (`generateHTMLOutput` wrapping), `codegen/html.test.ts`, `integration.test.ts`.

- **Task 1.1**: Add new unit tests to `codegen/html.test.ts` (initially failing): 🔴
  - Builder with top-level `StatementNode` before and after element children
  - Interleaved statements and elements at builder level
  - Statement-only builder body
  - **Nested element with statements**: `createElement("header", ..., [stmt("const x = 1"), h1Element])` inside a builder
- **Task 1.2**: Add integration test in `integration.test.ts` (initially failing) — compile a builder with `const x = 1; h1(x.toString())` to HTML target, execute the generated function, verify output contains `<h1>1</h1>`. 🔴
- **Task 1.3**: Unify `generateChild` to return `string[]` (accumulation lines) instead of `string` (template literal fragment). Each case emits `_html += \`...\`` lines. The `"statement"` case emits the statement source as a code line (fixing the bug). Rename to `emitChild` for clarity. 🔴
- **Task 1.4**: Unify `generateElement` to return `string[]` — emit `_html += \`<tag attrs>\``; recurse children via `emitChild`; emit `_html += \`</tag>\``. Rename to `emitElement`. 🔴
- **Task 1.5**: Collapse the dual loop generators: delete `generateReactiveLoop` and `generateLoopInline` (template literal context variants). Merge their hydration-marker logic into `generateLoopBody` (accumulation context variant), which becomes the single `emitLoop`. Reactive and render-time loops both produce `for...of` loops with `_html +=` lines; reactive loops additionally emit hydration marker comments. All loops iterate directly with `for (const ${itemVar} of ${iterableSource})` — no spread syntax needed. (The old `generateReactiveLoop` used `[...source].map(...)` to "preserve PlainValueRef", but testing confirms `for...of` on a ListRef produces identical `PlainValueRef` objects via the same `[Symbol.iterator]` → `getMutableItem()` path.) 🔴
- **Task 1.6**: Collapse the dual conditional generators: delete `generateConditional` (template literal context variant with ternaries and IIFEs). Merge hydration-marker logic into `generateConditionalBody` (accumulation context variant), which becomes the single `emitConditional`. Produces `if/else` blocks; reactive conditionals additionally emit hydration markers. 🔴
- **Task 1.7**: Unify `emitBodyChildren` to use `emitChild` (which now returns `string[]` directly). The special-case branches for render-time loops and render-time conditionals in `emitBodyChildren` can be removed — `emitChild` handles all node kinds uniformly. Rename to `emitChildren`. 🔴
- **Task 1.8**: Refactor `generateHTML` to produce accumulation lines. Open/close tags become `_html +=` lines. Children iterated via `emitChildren`. 🔴
- **Task 1.9**: Refactor `generateRenderFunction` to always wrap in block body: `() => { let _html = ""; ...lines...; return _html }`. 🔴
- **Task 1.10**: Update `generateHTMLOutput` in `transform.ts` to wrap in block-body arrow: `const renderN = () => { ${html} }`. 🔴
- **Task 1.11**: Update existing test assertions in `codegen/html.test.ts` that assert on `.map()`, `.join("")`, IIFE patterns, or ternary expressions. The semantic assertions (contains correct HTML, preserves statement order, includes hydration markers) are preserved; only the generated code shape changes. 🔴
- **Task 1.12**: Verify all new and existing tests pass. 🔴

### PR 2: `client:` / `server:` target labels (feature) 🔴

**Type**: Feature (new abstraction + implementation + tests)

This PR adds the full target-label capability in one coherent slice: IR type → analysis detection → pure filter function → wiring in transform pipeline. These pieces are tightly coupled (the IR type has no purpose without the filter; the filter has no input without analysis) so they belong together. The PR is individually testable at every layer (IR unit tests, analysis unit tests, filter unit tests, integration tests).

- **Task 2.1**: Add `TargetBlockNode` to IR in `ir.ts`: 🔴

```typescript
type CompileTarget = "dom" | "html"

interface TargetBlockNode extends IRNodeBase {
  kind: "target-block"
  /** Which compilation target this block is for */
  target: CompileTarget
  /** The analyzed children inside the labeled block */
  children: ChildNode[]
}
```

- **Task 2.2**: Add `"target-block"` to `IRNodeKind` union and `TargetBlockNode` to `ChildNode` union. 🔴
- **Task 2.3**: Add `createTargetBlock` factory function and `isTargetBlockNode` type guard in `ir.ts`. 🔴
- **Task 2.4**: Update `createBuilder`'s `collectDependencies` to recurse into `TargetBlockNode.children`. Dependencies from both `client:` and `server:` blocks should be collected — they inform subscription setup even if one target's code is stripped. 🔴
- **Task 2.5**: Add `filterTargetBlocks(node: BuilderNode, target: CompileTarget): BuilderNode` as a pure function in `ir.ts`. Recursively walks children, element children, loop bodies, and conditional branches. Strips `TargetBlockNode` nodes with non-matching target. Unwraps (splices in children) `TargetBlockNode` nodes with matching target. Returns a new `BuilderNode` with no `TargetBlockNode` in the tree. 🔴
- **Task 2.6**: Add unit tests for `filterTargetBlocks` in `ir.test.ts`: 🔴
  - `client:` block stripped when target is `"html"`
  - `client:` block unwrapped when target is `"dom"`
  - `server:` block stripped when target is `"dom"`
  - `server:` block unwrapped when target is `"html"`
  - Nested target blocks inside loops and conditionals
  - Deeply nested: target block inside element inside loop
- **Task 2.7**: In `analyzeStatement`, add a case for `SyntaxKind.LabeledStatement`. When the label is `"client"` or `"server"`, extract the body (which must be a `Block`), recursively analyze its statements, and wrap the result in a `TargetBlockNode`. If the label is neither `"client"` nor `"server"`, fall through to the existing `createStatement` capture. 🔴
- **Task 2.8**: Add unit tests to `analyze.test.ts`: 🔴
  - `client: { ... }` produces `TargetBlockNode` with `target: "dom"`
  - `server: { ... }` produces `TargetBlockNode` with `target: "html"`
  - Recursive analysis of children inside target block
  - Unknown labels produce `StatementNode`
- **Task 2.9**: In `transformSourceInPlace` (`transform.ts`), call `filterTargetBlocks` on each analyzed `BuilderNode` before passing to codegen. The `target` ("dom" or "html") is already available as `options.target`. 🔴
- **Task 2.10**: Add integration tests in `integration.test.ts` — compile same source to both targets, verify `client:` code appears only in DOM output and `server:` code only in HTML output. 🔴

### PR 3: Apply to kinetic-todo example + documentation 🔴

**Type**: Polish (example fix + docs)

This PR depends on both PR 1 (statement fix) and PR 2 (target labels). It applies the new capabilities to the real example and documents everything. Separately reviewable as a "does this look right to a user?" PR.

- **Task 3.1**: Update `examples/kinetic-todo/src/app.ts` to wrap the `requestAnimationFrame` animation loop in a `client:` block. 🔴
- **Task 3.2**: Verify the example runs without `ReferenceError` by starting the dev server and loading the page. 🔴
- **Task 3.3**: Update `packages/kinetic/TECHNICAL.md` — add "Target Labels" section documenting the `client:` / `server:` labeled block mechanism, IR representation, the filter-before-codegen architecture, and scope of recognition (builder bodies only). Update the "Statement Preservation" section to note the top-level and nested element fix. Replace the HTML codegen section to document the unified accumulation-line architecture. 🔴
- **Task 3.4**: Update `packages/kinetic/README.md` — add a brief section on `client:` / `server:` blocks with example. Update the status table (SSR row). 🔴
- **Task 3.5**: Update `examples/kinetic-todo/src/app.ts` JSDoc to mention `client:` blocks. 🔴

## Unit and Integration Tests

### HTML Codegen — Top-Level and Nested Statements (`codegen/html.test.ts`, PR 1)

```
describe "generateHTML - top-level statements"
  it "should preserve variable declaration before element child"
    → createBuilder("div", [], [], [stmt("const x = 1"), element("h1")], ...)
    → output contains "const x = 1" AND "<h1>"

  it "should preserve interleaved statements and elements"
    → stmt, element, stmt, element ordering preserved in output

  it "should handle statement-only builder body"
    → createBuilder("div", [], [], [stmt("console.log('hi')")], ...)
    → statement appears in generated code, <div></div> still produced

describe "generateElement (html) - nested statements"
  it "should preserve statements in nested element children"
    → createElement("header", [], [], [], [stmt("const x = 1"), h1Element], ...)
    → wrapped in builder, output contains "const x = 1" AND "<h1>"
```

### Existing Test Assertion Adjustments (`codegen/html.test.ts`, PR 1)

The following existing tests will need assertion updates because the generated code shape changes. The *semantic* content is identical — these are shape-only changes:

```
describe "generateHTML - static loops"
  "should generate .map() expression for static loop"
    → assertion changes from `.map` to `for` loop
    → still contains `<li>` and correct content

  "should generate static loop with index variable"
    → still contains destructuring pattern `[i, item]`
    → wrapping changes from `.map` to `for`

describe "generateHTML - static conditionals"
  "should generate IIFE for static conditional"
    → assertion changes from IIFE/ternary to `if` block
    → still contains `<p>` and condition expression

  "should generate static conditional with else branch"
    → ternary becomes if/else
    → still contains both branches' HTML

  "should generate nested if/else-if/else for static else-if chain"
    → already expects if/else-if/else structure — minimal change

describe "generateHTML - code validity"
  "should generate balanced template literal"
    → may need adjustment for accumulation pattern
```

### Analysis — Labeled Blocks (`analyze.test.ts`, PR 2)

```
describe "analyzeStatement - target labels"
  it "should produce TargetBlockNode for client: label"
    → input: "client: { console.log('browser') }"
    → result[0].kind === "target-block", result[0].target === "dom"

  it "should produce TargetBlockNode for server: label"
    → input: "server: { console.log('ssr') }"
    → result[0].kind === "target-block", result[0].target === "html"

  it "should recursively analyze children inside target block"
    → input: "client: { const x = 1; h1(x.toString()) }"
    → result[0].children has StatementNode + ElementNode

  it "should treat unknown labels as verbatim statements"
    → input: "myLabel: { break myLabel }"
    → result[0].kind === "statement"
```

### Filter — Target Block Removal (`ir.test.ts`, PR 2)

```
describe "filterTargetBlocks"
  it "should strip client: blocks when target is html"
  it "should unwrap client: blocks when target is dom"
  it "should strip server: blocks when target is dom"
  it "should unwrap server: blocks when target is html"
  it "should recurse into element children"
  it "should recurse into loop bodies"
  it "should recurse into conditional branches"
  it "should handle nested target blocks"
```

### Integration — Full Pipeline (`integration.test.ts`, PRs 1 & 2)

```
describe "compiler integration - top-level statements (HTML target)"
  it "should compile and execute builder with const + element"
    → source: div(() => { const x = 1; h1(x.toString()) })
    → HTML output contains <h1>1</h1>

describe "compiler integration - target labels"
  it "should compile client: block to DOM but not HTML"
    → source: div(() => { client: { console.log("c") }; h1("hi") })
    → DOM output contains console.log("c"), HTML output does not

  it "should compile server: block to HTML but not DOM"
    → source: div(() => { server: { console.log("s") }; h1("hi") })
    → HTML output contains console.log("s"), DOM output does not
```

## Transitive Effect Analysis

### Direct Dependencies

| File | Change | Risk |
|------|--------|------|
| `codegen/html.ts` | Unified accumulation-line architecture; delete template-literal-context generators | **Medium** — this is the core refactor; existing HTML output must be semantically identical |
| `transform.ts` | `generateHTMLOutput` wrapping changes from expression-body to block-body arrow; add `filterTargetBlocks` call | Low — two small changes |
| `ir.ts` | New `TargetBlockNode` type, updated unions, `filterTargetBlocks` function | Low — additive; filter is pure |
| `analyze.ts` | New `LabeledStatement` case in `analyzeStatement` | Low — new branch, no existing paths affected |

### Transitive Dependencies

| Chain | Risk | Mitigation |
|-------|------|------------|
| `codegen/html.ts` → `transform.ts` (two call sites) | `generateHTML` return type changes from template literal string to accumulation lines string. | Both callers (`generateRenderFunction` and `generateHTMLOutput`) are updated in PR 1 Tasks 1.9 and 1.10. |
| `codegen/html.ts` → `server/render.ts` → `examples/kinetic-todo/src/server.ts` | The server calls `renderToDocument(renderApp, doc, ...)` where `renderApp` is the compiled SSR function. | **No changes to render.ts.** Function signature is unchanged (`() => string`). Only the function body changes internally. |
| `ir.ts` → `walk.ts` → `template.ts` | Walk and template extraction switch on node kind. | **No changes needed.** `filterTargetBlocks` runs before codegen and before any walk/template extraction. Codegens never see `TargetBlockNode`. |
| `ir.ts` → `codegen/dom.ts` → `generateBodyWithReturn` → `checkCanOptimizeDirectReturn` | The direct-return optimization checks `computeSlotKind` and iterates body children. | **No changes needed.** After filtering, all `TargetBlockNode` nodes are gone. `computeSlotKind` never encounters them. |
| `ir.ts` → `ir.test.ts` / `tree-merge.test.ts` | Merge logic (`mergeNode`) switches on `kind`. | **No changes needed.** `mergeNode` already returns `{ success: false, reason: { kind: "different-kinds" } }` for mismatched kinds. Target blocks are filtered before any merge. |
| `analyze.ts` → `transform.ts` → `vite/plugin.ts` | The Vite plugin calls `transformSourceInPlace` which calls `analyzeStatement`. | **No plugin changes needed** — target is already selected by `transformOptions.ssr`. The filter call lives in `transformSourceInPlace`. |
| `codegen/dom.ts` | DOM codegen iterates children through `generateChild` which already handles statements. | **No changes needed.** DOM codegen is entirely unaffected. After filtering, DOM codegen never sees `TargetBlockNode`. |

### No Impact Expected

- `runtime/` — No changes; runtime functions (`mount`, `Scope`, `listRegion`, etc.) are unaffected
- `loro/` — No changes; `bind()`, `isBinding()` unaffected
- `testing/` — No changes to test infrastructure
- `packages/reactive` — No changes; `state()` / `LocalRef` unaffected
- `walk.ts` — No changes; filter runs before walk
- `template.ts` — No changes; filter runs before template extraction
- `codegen/dom.ts` — No changes; DOM codegen handles statements correctly already, and filter removes target blocks
- Other packages (`change`, `repo`, `lens`, adapters) — No relationship to compiler

## Resources for Implementation

### Files to Read/Modify

| File | Read | Modify | Purpose |
|------|------|--------|---------|
| `packages/kinetic/src/compiler/codegen/html.ts` | ✅ | ✅ | Unify to single accumulation-line convention |
| `packages/kinetic/src/compiler/transform.ts` | ✅ | ✅ | Update `generateHTMLOutput` wrapping; add `filterTargetBlocks` call |
| `packages/kinetic/src/compiler/ir.ts` | ✅ | ✅ | Add `TargetBlockNode`, `filterTargetBlocks`, update unions |
| `packages/kinetic/src/compiler/analyze.ts` | ✅ | ✅ | Detect `LabeledStatement` in `analyzeStatement` |
| `packages/kinetic/src/compiler/codegen/html.test.ts` | ✅ | ✅ | New tests + existing assertion adjustments |
| `packages/kinetic/src/compiler/analyze.test.ts` | ✅ | ✅ | New tests |
| `packages/kinetic/src/compiler/ir.test.ts` | ✅ | ✅ | New tests for `filterTargetBlocks` |
| `packages/kinetic/src/compiler/integration.test.ts` | ✅ | ✅ | New tests |
| `examples/kinetic-todo/src/app.ts` | ✅ | ✅ | Add `client:` block |
| `packages/kinetic/TECHNICAL.md` | ✅ | ✅ | Document unified codegen, target labels, filter architecture |
| `packages/kinetic/README.md` | ✅ | ✅ | Brief mention of `client:` / `server:` |

### Reference Files (read-only context)

- `packages/kinetic/src/compiler/codegen/dom.ts` — reference for how the DOM codegen's single-convention architecture works (model for HTML codegen unification)
- `packages/kinetic/src/vite/plugin.ts` — confirms SSR auto-detection via `transformOptions.ssr`
- `packages/kinetic/src/compiler/walk.ts` — confirm no changes needed (filter runs before walk)
- `packages/kinetic/src/compiler/template.ts` — confirm no changes needed (filter runs before extraction)
- `packages/kinetic/src/compiler/ir.test.ts` — existing IR tests for merge, slot kind
- `.plans/kinetic-arbitrary-statements.md` — prior art, design decisions

### Key Design Decisions to Preserve

- **Decision 2** (arbitrary-statements plan): Always use block body in HTML codegen — the unification fully realizes this decision
- **Decision 5**: Statement capture scope — only leaf statements become `StatementNode`; blocks are recursively analyzed
- **Decision 8**: All body iteration should go through a shared child-iteration helper — the unification makes this the only path, not just a recommendation

## Changeset

```
---
"@loro-extended/kinetic": minor
---

Fix: SSR now correctly preserves statements in builder functions and nested element bodies (e.g., `const x = state(0)` no longer causes `ReferenceError` during server-side rendering).

Refactor: HTML codegen unified to single accumulation-line calling convention. All constructs (elements, loops, conditionals) produce `_html +=` code lines. Eliminates dual template-literal/accumulation architecture and the duplicate generators it required. Generated SSR code is more readable and debuggable.

Feature: `client:` and `server:` labeled blocks inside builder functions. Code in `client: { ... }` is stripped during SSR compilation and only runs on the client. Code in `server: { ... }` is stripped during DOM compilation and only runs on the server. Unlabeled code runs in both contexts.
```

## Documentation Updates

### TECHNICAL.md — New Section: "Target Labels"

Add after the "Statement Preservation Nodes" section in IR documentation:

```markdown
### Target Labels: `client:` / `server:` Blocks

Kinetic uses TypeScript's labeled statement syntax to mark code as client-only or server-only
inside builder functions.

#### Syntax

- `client: { ... }` — contents compile to DOM target only, stripped from HTML (SSR) output
- `server: { ... }` — contents compile to HTML target only, stripped from DOM (client) output
- Unlabeled code — compiles to both targets

#### IR Representation

Labeled blocks with `client` or `server` labels produce a `TargetBlockNode`:

    interface TargetBlockNode {
      kind: "target-block"
      target: "dom" | "html"
      children: ChildNode[]
    }

The `target` field maps label names to compilation targets:
- `client` → `"dom"` (the DOM codegen target)
- `server` → `"html"` (the HTML/SSR codegen target)

#### Filter-Before-Codegen Architecture

Target blocks are resolved **before** codegen via a pure filter function:

    filterTargetBlocks(node: BuilderNode, target: CompileTarget): BuilderNode

This function recursively walks the IR tree:
- Strips `TargetBlockNode` whose target doesn't match (removes entirely)
- Unwraps `TargetBlockNode` whose target matches (splices children in place)

After filtering, the IR tree contains no `TargetBlockNode` nodes. Codegens,
`walk.ts`, `template.ts`, `computeSlotKind`, and all other downstream consumers
never encounter `TargetBlockNode` — they remain unchanged.

This follows the Functional Core / Imperative Shell principle: the filter is a
pure function that produces a new tree, trivially testable in isolation.

#### Scope

Target labels are recognized **only inside builder function bodies** — the same scope
where the dual-compilation (DOM vs HTML) occurs. File-level `client:` / `server:` labels
are not recognized by the compiler (they're outside the builder analysis scope).

For client-only module imports, use dynamic `import()` inside a `client:` block.
```

### TECHNICAL.md — Replace HTML Codegen Section

Replace the "HTML Codegen" section to document the unified architecture:

```markdown
### HTML Codegen (`codegen/html.ts`)

Generates JavaScript that produces HTML strings via accumulation into a `_html` variable.

**Output pattern:**

    () => {
      let _html = ""
      _html += `<div class="app">`
      _html += `<h1>${__escapeHtml(String(title))}</h1>`
      _html += `</div>`
      return _html
    }

**Unified calling convention:** All codegen functions return `string[]` (code lines).
There is one generator per IR construct, not two. Statements are lines interleaved with
`_html +=` lines. This mirrors the DOM codegen architecture.

**Loop generation (both reactive and render-time):**

    _html += `<ul>`
    _html += `<!--kinetic:list:1-->`
    for (const itemRef of [...items]) {
      const item = itemRef.get()
      _html += `<li>${__escapeHtml(String(item))}</li>`
    }
    _html += `<!--/kinetic:list-->`
    _html += `</ul>`

**Conditional generation (both reactive and render-time):**

    _html += `<!--kinetic:if:1-->`
    if (condition) {
      _html += `<p>Yes</p>`
    } else {
      _html += `<p>No</p>`
    }
    _html += `<!--/kinetic:if-->`

Reactive constructs include hydration markers; render-time constructs omit them.
The code structure is identical — only the marker comments differ.
```

### README.md — New Section: "Client & Server Code"

Add brief documentation with example showing `client:` / `server:` usage:

```markdown
## Client & Server Code

Inside builder functions, use labeled blocks to mark code as client-only or server-only:

    return div(() => {
      const count = state(0)

      client: {
        // Only runs in the browser — stripped from SSR output
        setInterval(() => count.set(count.get() + 1), 1000)
      }

      server: {
        // Only runs during SSR — stripped from client bundle
        console.log("Rendered at", new Date().toISOString())
      }

      h1(count.get().toString())
    })

- `client: { ... }` — browser only (stripped during SSR)
- `server: { ... }` — SSR only (stripped from client bundle)
- Unlabeled code — runs in both contexts
```

## Learnings

### The dual-calling-convention architecture was the root cause

The HTML codegen had two calling conventions — template literal fragments (`string`) and accumulation lines (`string[]`). Each IR construct needed two generators (one per convention). Statements could only exist in the accumulation convention. The bug wasn't that `generateChild` returned `""` for statements — it was that the template-literal convention *structurally cannot express statements*. Patching individual functions (IIFEs, conditional accumulation) would have been fighting the architecture. Unifying to a single convention eliminates the entire class of bugs.

### The DOM codegen already had the right architecture

The DOM codegen uses a single calling convention: `generateChild` returns `{ code: string[] }`. Statements are just lines. There was never a dual-convention problem in DOM codegen. The HTML codegen unification brings it into alignment with the DOM codegen's existing design.

### Filter-before-codegen eliminates broad surface area changes

The initial plan required modifying `emitBodyChildren`, `generateChild`, `generateBodyWithReturn`, `checkCanOptimizeDirectReturn`, `generateBodyWithFragment`, `computeSlotKind`, `computeHasReactiveItems`, and `walk.ts` — all to handle a new `"target-block"` case. By filtering the IR tree before codegen, all of these modifications become unnecessary. The codegen, walker, template extraction, and IR utility functions remain unchanged.

This is a textbook FC/IS win: the filtering concern (which blocks to keep/strip) is separated from the generation concern (how to produce code from IR).

### Duplicate generators per construct were a code smell

The existence of `generateReactiveLoop` + `generateLoopBody`, `generateConditional` + `generateConditionalBody`, and `generateLoopInline` + `generateLoopBody` — each pair doing essentially the same thing in two different calling conventions — was a signal that the architecture had diverged from its natural form. The unification deletes these duplicates rather than adding more.

### Generated code readability is a feature for SSR

SSR errors are debugged by reading stack traces that point into generated code. Template literals with nested `.map().join("")` and IIFEs are hard to read. The accumulation-line output (`_html += \`...\``) produces generated code where each line does one thing, making stack traces and `console.log` debugging straightforward.

### The "always block body" Decision 2 was not fully applied

Decision 2 from the `kinetic-arbitrary-statements` plan stated "always use block body in HTML codegen." This was applied to loop and conditional bodies but not to `generateRenderFunction`, `generateHTML`, or `generateElement`. The unification completes the application of Decision 2 by making the accumulation pattern the only pattern.

### Spread syntax on ListRef iteration is unnecessary

The old `generateReactiveLoop` used `[...${node.iterableSource}].map((item, _i) => ...)` with a comment that spread "preserves PlainValueRef for value shapes." Empirical testing confirms this is unnecessary: `for (const itemRef of doc.items)` produces identical `PlainValueRef` objects with working `.get()` and `.set()` — both paths go through the ListRef's `[Symbol.iterator]` which calls `getMutableItem()`. The spread allocates an intermediate array for no benefit. The unified `emitLoop` uses plain `for...of` for all loops, which is both simpler and more efficient.