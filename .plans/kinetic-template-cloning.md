# Plan: Template Cloning & Component Unification

## Background

Kinetic currently generates imperative `document.createElement()` + `appendChild()` chains for every element in a tree. For a tree with N elements and M text leaves, this produces N+M creation calls and ~N+M `appendChild` calls — roughly 2(N+M) DOM API bridge crossings.

Browser engines implement `<template>.content.cloneNode(true)` as a native C++ tree copy that bypasses the JS↔C++ bridge per-node. In benchmarks (js-framework-benchmark, Krausest), template cloning is 3–10× faster than equivalent imperative chains, with the gap widening as tree depth grows. This is the strategy used by Solid.js, Svelte 5, Inferno, and every top-performing framework.

Kinetic already has both halves of this approach but hasn't married them:

- **HTML codegen** (`codegen/html.ts`) already produces the exact HTML string that would go into `template.innerHTML`
- **DOM codegen** (`codegen/dom.ts`) already separates static structure from dynamic "holes" via binding-time analysis (`literal`/`render`/`reactive`)

Additionally, Kinetic's CRDT delta system provides structural change information that no other framework has access to. List deltas carry insert counts and positions, enabling batch DOM operations (fragment insert, range delete) that compound the template cloning advantage.

### The Component Insight

If DOM creation is unified around template cloning, then a "component" and an "HTML element tree" become the same thing at the codegen level: both are a template string + a walker that pokes dynamic values into holes. The `ELEMENT_FACTORIES` hardcoded set in `analyze.ts` becomes unnecessary — any function the compiler can analyze as "returns a static DOM tree with reactive holes" is a component.

## Problem Statement

1. **Slow initial creation**: `createElement` × N is 3–10× slower than `cloneNode(true)` × 1 for static subtrees.
2. **No component model**: The compiler only recognizes ~130 hardcoded HTML tag names. User-defined components are impossible.
3. **Suboptimal batch operations**: CRDT deltas provide batch boundaries (insert count, contiguous delete range) that the runtime doesn't exploit — items are inserted/deleted one at a time.
4. **O(n) state bookkeeping**: `Array.splice` in list region slot/scope tracking shifts the entire tail on every insert/delete.

## Success Criteria

1. Static subtrees are created via `template.cloneNode(true)` instead of imperative `createElement` chains.
2. User-defined component functions are recognized by the compiler and compiled the same way as HTML element trees.
3. List region batch inserts use `DocumentFragment` for a single `insertBefore` per contiguous insert group.
4. List region batch deletes use `Range.deleteContents()` for contiguous removals.
5. All 662+ existing tests continue to pass.
6. New benchmarks demonstrate measurable improvement on creation-heavy workloads.

## The Gap

| Aspect | Current | Target |
|--------|---------|--------|
| DOM creation | `createElement` × N per tree | `cloneNode(true)` × 1 + walk for holes |
| Component recognition | `ELEMENT_FACTORIES.has(name)` — 130 hardcoded tags | Type-based: any function matching `ComponentFactory` signature |
| HTML string for client | Only used in SSR codegen | Reused as `template.innerHTML` for client-side cloning |
| Batch insert | N × `insertBefore` | 1 × `insertBefore` with `DocumentFragment` |
| Batch delete | N × `removeChild` + N × `splice` | 1 × `Range.deleteContents()` + 1 × `splice` |
| Slot/scope tracking | `Array` with O(n) `splice` | Single `splice` per batch op |
| Scope per list item | Allocated unconditionally | Lazy: allocated on first `onDispose` call |
| Scope IDs | String template literal per scope | Numeric counter (no string allocation) |

## PR Stack

### Dependency Graph

```
PR 1 (shared constants)              — foundation (VOID_ELEMENTS, escapeHtml, marker helpers)
  ↓
PR 2 (generator walker)              — WalkEvent stream, walkIR() generator
  ↓
PR 3 (template extraction)           — TemplateNode/TemplateHole types, extractTemplate()
  ↓
PR 4 (template-cloning codegen)      — planWalk(), CodegenResult, module declarations

PR 5 (lazy scope / numeric IDs)      — INDEPENDENT of 1–4
PR 6 (CRDT batch ops)                — INDEPENDENT of 1–5

PR 7 (component recognition)         — soft dep on PR 2 (walker); no hard dep on 3–4

PR 8 (conditional scope creation)    — INDEPENDENT (uses existing LoopNode.hasReactiveItems)

PR 9 (README / package.json)         — after all features land
```

PRs 5, 6, and 7 can merge in any order relative to each other and to PRs 3–4. Two parallel tracks converge: "compiler gets template cloning" and "runtime gets batch ops + lighter scopes." PR 7 (components) is the marquee user-facing feature and could be prioritized ahead of PRs 3–4 if desired — components work with `createElement` codegen; template cloning makes them faster later.

### PR 1: refactor(packages/kinetic): extract shared HTML constants ✅

Extract duplicated HTML constants and escape functions into a shared module. Pure mechanical refactor, zero behavior change.

**Tasks:**

1. Create `compiler/html-constants.ts` exporting: ✅
   - `VOID_ELEMENTS` set (currently duplicated in `codegen/html.ts` L150–165 and `server/render.ts` L142–157)
   - `escapeHtml(str: string): string` function (currently `escapeStatic` in `codegen/html.ts` and `escapeHtml` in `server/render.ts` — same logic, different implementations)
   - `generateRegionMarkers(type: "list" | "if", id: number): { open: string, close: string }` helper for consistent marker format across SSR and template extraction
2. Update `codegen/html.ts` to import `VOID_ELEMENTS` and `escapeHtml` from `html-constants.ts`, removing its private `VOID_ELEMENTS` and `escapeStatic` ✅
3. Update `server/render.ts` to import `VOID_ELEMENTS` and `escapeHtml` from `html-constants.ts`, removing its private copies (keep re-exporting `escapeHtml` from server subpath for public API compatibility) ✅
4. Verify all existing tests pass after extraction ✅

*Files: `compiler/html-constants.ts` (new), `codegen/html.ts`, `server/render.ts`*

### PR 2: refactor(packages/kinetic): generator-based IR walker 🔴

Implement a generator-based IR walker that yields structural events. This creates a clean separation: the walker describes structure, consumers decide what to do with each event. SSR codegen and template extraction become thin consumers of the same event stream.

**Design: Generator Walker with Event Types**

The walker yields events describing the tree structure. Each consumer processes events via a switch statement, accumulating their desired output.

```typescript
type WalkEvent =
  | { type: "elementStart"; tag: string; path: number[] }
  | { type: "elementEnd"; tag: string }
  | { type: "staticAttribute"; name: string; value: string }
  | { type: "dynamicAttribute"; attr: AttributeNode; path: number[] }
  | { type: "eventHandler"; handler: EventHandlerNode; path: number[] }
  | { type: "staticText"; text: string }
  | { type: "dynamicContent"; node: ContentNode; path: number[] }
  | { type: "regionPlaceholder"; node: LoopNode | ConditionalNode; path: number[] }

function* walkIR(node: ChildNode, pathStack?: number[]): Generator<WalkEvent>
```

**Why generator over callbacks:**
1. **Separation of concerns** — walker describes structure, consumers decide what to do
2. **Testability** — collect events into array and assert, no mocking
3. **Composability** — can filter, transform, or log events without modifying walker
4. **Path optimization** — uses mutable path stack internally, copies only when yielding

**Tasks:**

1. Create `compiler/walk.ts` with `WalkEvent` type union and `walkIR` generator function 🔴
2. Implement `walkElement`, `walkContent`, `walkChild` as internal generators that yield events 🔴
3. Use mutable `pathStack: number[]` internally, copy to `[...pathStack]` only when yielding events that need paths 🔴
4. Walker performs HTML escaping for static text/attributes (consumer doesn't need to) 🔴
5. Use shared `VOID_ELEMENTS` from `html-constants.ts` for void element handling 🔴
6. Unit tests for walker: verify event sequence for various IR structures; verify paths are correct; verify static values are escaped 🔴
7. Rewrite `generateElement` / `generateChild` in `codegen/html.ts` as a consumer of `walkIR` events 🔴
8. Existing HTML codegen tests pass unchanged (same output, different internal structure) 🔴

*Files: `compiler/walk.ts` (new), `compiler/walk.test.ts` (new), `codegen/html.ts`*

### PR 3: feat(packages/kinetic): template extraction from IR 🔴

Add `TemplateNode` / `TemplateHole` types and implement `extractTemplate` as a consumer of `walkIR` events. This is the core abstraction that enables both template cloning (client) and HTML string generation (SSR) from the same representation.

**Tasks:**

1. Add `TemplateNode` and `TemplateHole` types to `ir.ts` 🔴

   ```typescript
   interface TemplateHole {
     /** Walk path from template root: e.g., [0, 1] = firstChild.children[1] */
     path: number[]
     /** What kind of hole */
     kind: "text" | "attribute" | "event" | "binding" | "region"
     /** For attribute holes: the attribute name */
     attributeName?: string
     /** For event holes: the event name */
     eventName?: string
   }

   interface TemplateNode {
     /** Static HTML string for innerHTML / SSR */
     html: string
     /** Ordered list of dynamic holes with walk paths */
     holes: TemplateHole[]
   }
   ```

2. Implement `extractTemplate` in `compiler/template.ts` as a consumer of `walkIR` events that accumulates HTML into a string and records `TemplateHole` entries 🔴
3. Region mount points (list/conditional children) use `generateRegionMarkers()` from `html-constants.ts` to emit `<!--kinetic:list:N--><!--/kinetic:list-->` or `<!--kinetic:if:N--><!--/kinetic:if-->` placeholders — same format as SSR hydration markers for compatibility 🔴
4. Unit tests for `extractTemplate`: static trees produce correct HTML and zero holes; mixed trees produce correct holes with accurate walk paths; nested elements produce correct multi-level paths; region-containing subtrees produce comment placeholders with region holes 🔴
5. Hydration invariant test: for any given IR subtree, `TemplateNode.html` (with dynamic holes filled in) must equal the SSR output for that same subtree, ensuring hydration compatibility 🔴

*Files: `ir.ts`, `compiler/template.ts`, `compiler/template.test.ts` (new)*

### PR 4: feat(packages/kinetic): template-cloning DOM codegen 🔴

Emit `cloneNode(true)` + tree walker instead of `createElement` chains. First consumer of `TemplateNode`.

**Design: Four-Layer Architecture**

Template cloning codegen follows a clean four-layer design:

| Layer | Input | Output | Responsibility |
|-------|-------|--------|----------------|
| **Walker** (PR 2) | IR tree | `WalkEvent` stream | Describe structure |
| **Extractor** (PR 3) | `WalkEvent` stream | `TemplateNode { html, holes }` | Collect static HTML + hole positions |
| **Planner** (PR 4) | `TemplateHole[]` | `NavOp[]` | Optimal traversal order |
| **Codegen** (PR 4) | `NavOp[]` | JavaScript code | Emit DOM navigation |

The walk planner converts hole paths to an optimal single-pass traversal:

```typescript
type NavOp = 
  | { op: "down" }      // .firstChild
  | { op: "right" }     // .nextSibling  
  | { op: "up" }        // .parentNode
  | { op: "grab"; holeIndex: number }  // save current node for hole N

function planWalk(holes: TemplateHole[]): NavOp[]
```

Holes are visited in document order (depth-first), so the walk never backtracks past already-grabbed holes.

**Tasks:**

1. Implement `planWalk(holes: TemplateHole[]): NavOp[]` in `compiler/template.ts` — converts paths to optimal traversal 🔴
2. Implement `generateWalkCode(plan: NavOp[], holeCount: number): string[]` — emits DOM navigation code 🔴
3. Modify codegen return type to include module-level declarations: 🔴
   ```typescript
   interface CodegenResult {
     code: string
     moduleDeclarations: string[]
   }
   ```
4. Add `generateTemplateDeclaration(template: TemplateNode, state: CodegenState): string` that emits `const _tmpl_N = document.createElement("template"); _tmpl_N.innerHTML = "..."` 🔴
5. Template deduplication via hash: maintain `Map<string, string>` of `htmlHash → templateVarName` in codegen state. Same template HTML reuses same declaration 🔴
6. Update `transformSourceInPlace` to collect `moduleDeclarations` from all replacements and insert at top of file 🔴
7. Wire reactive subscriptions to grabbed hole references instead of newly-created elements 🔴
8. Region holes: pass the cloned comment node to `listRegion` / `conditionalRegion` as the mount point 🔴
9. Unit tests: generated code uses `cloneNode`; walk plan is optimal; walker paths match expected hole positions; reactive subscriptions target correct nodes 🔴
10. Integration tests: compile + execute static trees, verify DOM structure is identical to imperative approach; compile + execute reactive trees, verify subscriptions work with cloned nodes 🔴
11. Update `TECHNICAL.md` with Template Cloning architecture section 🔴

*Files: `compiler/template.ts`, `codegen/dom.ts`, `transform.ts`, `integration.test.ts`, `TECHNICAL.md`*

### PR 5: perf(packages/kinetic): lazy scope allocation and numeric IDs 🔴

*Independent of PRs 1–4. Can merge at any point.*

Reduce per-item allocation costs. Performance-only, no behavior change.

**Tasks:**

1. Make `Scope` lazy: don't allocate `cleanups` array or `children` set until first use. Use `null` sentinel and allocate on demand in `onDispose` and `createChild` 🔴
2. Change scope IDs from string template literals to numeric counters — `id: number` instead of `id: string`. Eliminates string allocation in tight loops 🔴
3. Update `ScopeDisposedError` and test assertions that match on scope ID strings 🔴
4. Unit tests: verify lazy scope doesn't allocate until needed; verify numeric IDs work; verify dispose handles `null` cleanups/children without crashing 🔴

*Files: `scope.ts`, `scope.test.ts`, `errors.ts`, `types.ts`, `testing/runtime.ts`*

### PR 6: feat(packages/kinetic): CRDT-aware batch list operations 🔴

*Independent of PRs 1–5. Can merge at any point.*

Exploit the structural information in CRDT deltas for batched DOM operations.

**Tasks:**

1. Add `batch-insert` and `batch-delete` op types to `ListRegionOp` 🔴

   ```typescript
   type ListRegionOp<T> =
     | { kind: "insert"; index: number; item: T }
     | { kind: "delete"; index: number }
     | { kind: "batch-insert"; index: number; count: number }
     | { kind: "batch-delete"; index: number; count: number }
   ```

   Note: `batch-insert` carries `count`, not `items: T[]`. The executor calls `listRef.get(index + i)` during execution. This keeps the planning function pure (no item fetching) and avoids allocating a large intermediate array for big batches.

2. Modify `planDeltaOps` to emit batch ops for contiguous `{ insert: N }` (N > 1) and contiguous `{ delete: N }` (N > 1) 🔴
3. In `executeOp`, handle `batch-insert` by: fetching items via `listRef.get()`, creating all items via the `create` handler, collecting into a `DocumentFragment`, and performing a single `parent.insertBefore(fragment, referenceNode)` — one DOM insertion for the entire batch 🔴
4. In `executeOp`, handle `batch-delete` by: using `Range` API (`setStartBefore` / `setEndAfter` / `deleteContents()`) for contiguous slot removal — one DOM operation instead of N 🔴
5. Optimize `slots.splice` for batch operations: single `splice(index, 0, ...newSlots)` for batch insert; single `splice(index, count)` for batch delete 🔴
6. Unit tests for `planDeltaOps`: verify batch ops are emitted for contiguous operations, individual ops for non-contiguous 🔴
7. Integration tests: insert 100 items at once via Loro transaction, verify DOM correctness and that batch code path is exercised 🔴
8. Update `TECHNICAL.md` with Batch Operations section 🔴

*Files: `regions.ts`, `regions.test.ts`, `types.ts`, `TECHNICAL.md`*

### PR 7: feat(packages/kinetic): component recognition via ComponentFactory 🔴

*Soft dependency on PR 2 (parameterized walk for HTML codegen). No hard dependency on PRs 3–4 (template cloning). Can be prioritized ahead of template cloning if desired.*

Extend element recognition to support user-defined component functions alongside HTML tags.

**Tasks:**

1. Define `ComponentFactory` type in `types.ts` that the compiler recognizes 🔴

   ```typescript
   /** A component is a function that takes optional props + optional builder and returns an Element. */
   type ComponentFactory<P extends Record<string, unknown> = {}> =
     | ((props: P, builder: Builder) => Element)
     | ((props: P) => Element)
     | ((builder: Builder) => Element)
     | (() => Element)
   ```

2. In `analyze.ts`, replace the `ELEMENT_FACTORIES.has(name)` check with a two-tier detection: first check if the name is a known HTML tag (lowercase, in a set), then check if the callee's TypeScript type satisfies `ComponentFactory` via property-level type inspection (similar pattern to `isReactiveType`) 🔴
3. Extend `ElementNode` with an optional `factorySource?: string` field instead of adding a new `ComponentNode` variant to `ChildNode`. When `factorySource` is present, the node represents a component invocation (codegen emits a function call); when absent, it's a plain HTML element (codegen emits `createElement`). This avoids the transitive effect cascade of a new `ChildNode` variant through `computeSlotKind`, `mergeNode`, `generateChild` (both codegens), `collectRequiredImports`, and `createBuilder` 🔴
4. In DOM codegen, when `node.factorySource` is present, emit a component call as `const _node = factorySource(scope.createChild())` for prop-less components, or with a props object argument when props are present. The component returns a `Node` that gets `appendChild`-ed to the parent 🔴
5. In HTML codegen, when `node.factorySource` is present, emit a component call the same way — the component's SSR variant returns an HTML string that gets concatenated 🔴
6. Keep `elements.d.ts` global ambient declarations as-is — globals for HTML tags and explicit imports for components can coexist. Add `ComponentFactory` as a new export from `types.ts`. Revisit global removal later based on community preference 🔴
7. Unit tests: PascalCase functions with `ComponentFactory` type are recognized as components; lowercase HTML tags still work; components receive props correctly; components can contain children via builder pattern 🔴
8. Integration tests: compile a component definition + usage site, execute, verify DOM output 🔴
9. Update `TECHNICAL.md` with Component Model section 🔴

*Files: `types.ts`, `ir.ts`, `analyze.ts`, `reactive-detection.ts`, `codegen/dom.ts`, `codegen/html.ts`, `TECHNICAL.md`*

### PR 8: perf(packages/kinetic): conditional scope creation for static list items 🔴

*Independent of PR 7. Can merge whenever ready.*

Skip scope allocation for list items that have no reactive content.

**Note:** The IR already computes `LoopNode.hasReactiveItems` at creation time via `computeHasReactiveItems(body)`. This PR simply wires that existing value through to the runtime.

**Tasks:**

1. Add `isReactive` field to `ListRegionHandlers` 🔴
2. Codegen emits `isReactive: ${node.hasReactiveItems}` — no new analysis needed, just emit existing IR field 🔴
3. `executeOp` skips `createChild()` when `isReactive` is false 🔴
4. Unit tests: static items get no scope, reactive items get scope 🔴

*Files: `regions.ts`, `types.ts`, `codegen/dom.ts`*

### PR 9: docs(packages/kinetic): README and package.json updates 🔴

*After all feature PRs have landed.*

1. Update `README.md`: document `ComponentFactory`, update feature table, add component examples 🔴
2. Update `package.json` exports if subpath changes are needed for component type imports 🔴

*Files: `README.md`, `package.json`*

### PR Stack Rationale

| # | PR | Type | Why here |
|---|-----|------|----------|
| 1 | Shared constants | refactor | Foundation: eliminates duplication before any new consumer is added |
| 2 | Generator-based walker | refactor | Prep: creates event stream that both SSR and template extraction consume |
| 3 | Template extraction | feat (infra) | Core abstraction: `TemplateNode` type exists, no consumers yet |
| 4 | Template-cloning codegen | feat | First consumer of `TemplateNode`; user-visible perf improvement |
| 5 | Lazy scope / numeric IDs | perf | Independent, low-risk, ships whenever ready |
| 6 | CRDT batch ops | feat | Independent, high-value, ships whenever ready |
| 7 | Component recognition | feat | Marquee user-facing feature; benefits from templates but doesn't require them |
| 8 | Conditional scope creation | perf | Independent; uses existing `LoopNode.hasReactiveItems` from IR |
| 9 | README / package.json | docs | Final polish after all features land |

## Transitive Effect Analysis

### Compiler Changes (PRs 1–4, 7)

- **`codegen/html.ts`** and **`server/render.ts`** — PR 1 extracts shared constants. Both files lose private `VOID_ELEMENTS` and escape functions, gaining imports from `html-constants.ts`. Low-risk mechanical change.
- **`codegen/html.ts`** — PR 2 refactors `generateElement` to consume events from the new `walkIR` generator. The existing public interface is unchanged; internally it iterates over `WalkEvent`s and builds the template literal string.
- **`compiler/walk.ts`** (new) — PR 2 adds the generator-based walker. This is a new file with no dependencies on existing code except `ir.ts` types and `html-constants.ts`.
- **`ir.ts`** — Adding `TemplateNode` type (PR 3) and optional `factorySource` field on `ElementNode` (PR 7). No new `ChildNode` variant, so no cascade through pattern-match sites. The `factorySource` field is optional, so existing code that doesn't check it continues to work unchanged.
- **`analyze.ts`** — Changing the recognition logic (PR 7) affects `findBuilderCalls`, `isNestedBuilderCall`, `analyzeElementCall`, `analyzeBuilder`, `analyzeStatement`. All callers of `ELEMENT_FACTORIES` are affected. The set remains for HTML tags; type-based detection is additive.
- **`elements.d.ts`** — Unchanged. Global declarations remain.

### Runtime Changes (PRs 5–6, 8)

- **`regions.ts`** — New op types in `ListRegionOp` (PR 6) affect `executeOp`, `executeOps`. `ListRegionHandlers` gains optional `isReactive` field (PR 8).
- **`scope.ts`** — Changing `id` from `string` to `number` (PR 5) affects:
  - `ScopeDisposedError` (accepts scope ID)
  - Test assertions that match on scope ID strings (e.g., `"scope-1"`)
  - `resetScopeIdCounter` (unchanged semantics, different type)
- **`types.ts`** — `ListRegionOp` type expansion is internal; `ScopeInterface.id` type changes from `string` to `number`.
- **`testing/runtime.ts`** and **`testing/counting-dom.ts`** — May need updates for scope ID type change.

### Test Impact

- Integration tests (`todo.test.ts`, `ssr.test.ts`) hand-write "compiled output" using `document.createElement`. These tests validate the *runtime*, not the *codegen*, so they remain valid — template cloning is a codegen optimization, not a runtime API change.
- Compiler integration tests (`integration.test.ts`) will need updates in PR 4 to expect `cloneNode`-based output instead of `createElement`-based output.
- Scope-related tests that assert on string IDs (`"scope-1"`) will need updating in PR 5 for numeric IDs.

### Package Boundary

- `@loro-extended/reactive` — **No changes**. Template cloning is purely a kinetic compiler/runtime concern.
- `@loro-extended/change` — **No changes**. The reactive bridge and delta translation are unaffected.
- Vite plugin (`vite/plugin.ts`) — **No changes needed**. The plugin calls `transformSourceInPlace` which will automatically produce template-cloning output once codegen is updated. SSR target detection (`transformOptions?.ssr`) continues to work unchanged.

## Key Resources for Implementation

These files should be in context during implementation:

| PR | Files |
|----|-------|
| PR 1 | `src/compiler/html-constants.ts` (new), `src/compiler/codegen/html.ts`, `src/server/render.ts` |
| PR 2 | `src/compiler/walk.ts` (new), `src/compiler/walk.test.ts` (new), `src/compiler/codegen/html.ts` |
| PR 3 | `src/compiler/ir.ts`, `src/compiler/template.ts` (new), `src/compiler/template.test.ts` (new) |
| PR 4 | `src/compiler/template.ts`, `src/compiler/codegen/dom.ts`, `src/compiler/transform.ts`, `src/compiler/integration.test.ts`, `TECHNICAL.md` |
| PR 5 | `src/runtime/scope.ts`, `src/runtime/scope.test.ts`, `src/errors.ts`, `src/types.ts`, `src/testing/runtime.ts` |
| PR 6 | `src/runtime/regions.ts`, `src/runtime/regions.test.ts`, `src/types.ts`, `TECHNICAL.md` |
| PR 7 | `src/types.ts`, `src/compiler/ir.ts`, `src/compiler/analyze.ts`, `src/compiler/reactive-detection.ts`, `src/compiler/codegen/dom.ts`, `src/compiler/codegen/html.ts`, `TECHNICAL.md` |
| PR 8 | `src/runtime/regions.ts`, `src/types.ts`, `src/compiler/codegen/dom.ts` |
| PR 9 | `README.md`, `package.json` |

Additionally, the incremental view maintenance ideas doc (`ideas/incremental-view-maintenance.md`) provides forward-looking context for how template regions compose with delta propagation strategies.

## Plan Review

### Duplication Check

**1. `VOID_ELEMENTS` is already duplicated — the plan would have added a third copy.**

`VOID_ELEMENTS` exists identically in both `codegen/html.ts` (L150–165) and `server/render.ts` (L152–167). The original plan's Phase 1 said "reuse the `VOID_ELEMENTS` set from `codegen/html.ts`" but that set is module-private (`const`, not exported).

**2. `escapeStatic` in `codegen/html.ts` duplicates `escapeHtml` in `server/render.ts`.**

Both do identical `&<>"'` replacement. `server/render.ts` exports `escapeHtml`; `codegen/html.ts` has a private `escapeStatic`. The plan's `extractTemplate` in Phase 1 will need HTML escaping for literal attribute values and text content baked into the template string. If we don't extract this, we'll have a third copy. Recommendation: export the compile-time escaping function from the shared constants module alongside `VOID_ELEMENTS`.

**3. `ComponentNode` nearly duplicates `ElementNode`.**

The proposed `ComponentNode` has the same fields as `ElementNode` (`props`, `eventHandlers`, `children`, `isReactive`) plus `factorySource` instead of `tag`, minus `bindings`. This is not a separate concept — it's an `ElementNode` with a different creation strategy. A cleaner approach: add an optional `factorySource?: string` to `ElementNode` and use `tag` for the HTML fallback. Codegen dispatches on `factorySource != null` → component call, else → `createElement(tag)`. This avoids adding a new variant to the `ChildNode` union (which touches every `switch` and pattern-match site listed in the transitive effects) and keeps the tree-merge algorithm working without a new case.

**Resolution:** PR 7 extends `ElementNode` with optional `factorySource` instead of adding `ComponentNode`. This eliminates the transitive effect cascade through `computeSlotKind`, `mergeNode`, `generateChild` (both codegens), `collectRequiredImports`, and `createBuilder`.

### Overlap & Reuse Opportunities

**1. `extractTemplate` (Phase 1) overlaps heavily with `generateElement` in `codegen/html.ts`.**

The existing `generateElement` in `codegen/html.ts` already walks an `ElementNode`, emits opening tags with attributes, recurses into children, and emits closing tags. The proposed `extractTemplate` does the exact same walk but additionally records holes and skips dynamic content. Rather than writing a parallel walker from scratch, refactor `generateElement` in `codegen/html.ts` into a parameterized walk:

```typescript
interface HtmlWalkCallbacks {
  onStaticText(text: string): void
  onDynamicContent(node: ContentNode, path: number[]): void
  onDynamicAttribute(attr: AttributeNode, path: number[]): void
  onEventHandler(handler: EventHandlerNode, path: number[]): void
  onRegionMount(node: LoopNode | ConditionalNode, path: number[]): void
}
```

- **SSR codegen** provides callbacks that emit template literal interpolations (current behavior).
- **Template extraction** provides callbacks that accumulate the HTML string and record holes.
- **DOM codegen** (PR 4) doesn't use this walk — it consumes the `TemplateNode` output.

This avoids two independent tree walkers that must stay in sync when the IR changes.

**2. `generateHTML` / `generateRenderFunction` in `codegen/html.ts` vs. template HTML for DOM cloning.**

The plan says "HTML codegen already produces the exact HTML string that would go into `template.innerHTML`" — but this is only true for fully-static trees. For trees with dynamic content, the HTML codegen emits `${...}` template literal interpolations. The template cloning path needs the static skeleton only (dynamic parts become empty text nodes or placeholder comments). These are different strings from the same IR. The shared walker approach above handles this cleanly — SSR callbacks emit interpolations, template extraction callbacks emit placeholders.

**3. `generateDOM` and `generateElement` (Phase 2) internal duplication.**

Currently `generateDOM` (for `BuilderNode`) and `generateElement` (for child `ElementNode`) contain near-identical logic: create element, set attributes, set up subscriptions, attach handlers, generate children. After template cloning, they would BOTH need to be updated to detect "can this subtree be templated?" and emit clone+walk. Recommendation: unify them. `generateDOM` should construct a synthetic `ElementNode` from the `BuilderNode`'s fields and delegate to `generateElement`. The only difference is that `generateDOM` wraps the result in `return`. This already could have been done (the IR types are structurally identical).

### Functional Core / Imperative Shell Adherence

**1. Phase 1 (Template Extraction) — Good.**

`extractTemplate` is described as a pure function `(ElementNode | BuilderNode) → TemplateNode`. This is correct FC/IS — the template extraction is the functional core, and the codegen that emits `cloneNode` calls is the imperative shell. Testable by asserting on the `TemplateNode` data structure without any DOM.

**2. Phase 2 (DOM Codegen) — Good, but watch the template hoisting.**

Template declarations are hoisted to module scope ("module-level `const _tmpl_N = ...`"). The plan describes this in `generateTemplateDeclaration` — but the hoisting itself is a side effect (mutating a collection of module-level declarations). This should be modeled as a pure accumulation: `generateDOM` returns both the function body code AND a list of template declarations to hoist. The imperative shell (`transformSourceInPlace`) collects and emits them. Don't have codegen functions mutate shared state.

**3. Phase 4 (Batch Ops) — Good FC/IS, but the plan mixes planning and execution in the type.**

The `ListRegionOp` type expansion with `batch-insert` and `batch-delete` is correct — these are pure plan operations. The execution in `executeOp` is the imperative shell. This follows the existing pattern well.

However: the plan puts `items: T[]` on `batch-insert`. This means `planDeltaOps` must eagerly fetch all N items via `listRef.get(index)` to build the array. Currently, single `insert` ops carry one `item: T`. For batch, consider carrying `{ index: number; count: number }` instead and having the executor call `listRef.get()` during execution. This keeps the planning function pure and avoids the eager fetch. The current single-item `insert` already carries the item (fetched during planning), so this is a design choice — but for large batches (1000 items), deferring the fetch to the execution shell avoids allocating a 1000-element intermediate array in the pure layer.

**4. Phase 5 (Lazy Scope) — Fine, but test the boundary carefully.**

Making `cleanups` and `children` lazy (`null` until first use) is a refactor internal to the `Scope` class. The external interface doesn't change. The risk is in the `dispose()` path — it must handle `null` cleanups/children without crashing. The plan correctly calls for unit tests.

### Trenchant Observations

**1. The original plan removed `elements.d.ts` global declarations in Phase 3, Task 6 — this was premature and unnecessary.**

Global ambient declarations are orthogonal to the component model. Users can have both: globals for HTML tags (convenient for small projects) AND explicit imports for components. Removing globals has high migration cost with zero performance benefit.

**Resolution:** PR 7 keeps `elements.d.ts` as-is and adds `ComponentFactory` as a new additive export.

**2. The template cloning boundary decision (Phase 2, Task 5) is under-specified.**

The original plan said "fall back to imperative creation for subtrees that contain regions (list/conditional) as direct children." But consider: `div(() => { h1("Title"); for (const item of list) { li(item) } })`. The `<div>` has a static child (`<h1>Title</h1>`) and a region. The optimal strategy is to template the `<div><h1>Title</h1></div>` part (with a comment placeholder for the region mount point) and then attach the region to the placeholder after cloning. This is what Solid does — regions are mounted at comment marker positions within the cloned template.

**Resolution:** PRs 3 and 4 specify that regions inside a template become **comment placeholder holes** (`<!--kinetic:region-->`) in the template HTML string, with a hole descriptor of `kind: "region"`. After cloning, the walker grabs the comment node and passes it to `listRegion` / `conditionalRegion` as the mount point.

**3. The plan doesn't address hydration compatibility.**

Template-cloned DOM and SSR-rendered DOM must produce identical structure for hydration to work. Currently, SSR hydration (`hydrate.ts`) walks existing DOM and attaches subscriptions. If template cloning produces the DOM client-side, the structure must match what SSR would have produced. This is naturally true if both paths use the same HTML string (from `TemplateNode.html`), but the plan should explicitly state this invariant and test it: `TemplateNode.html` for a given IR subtree must equal the SSR output for that same subtree.

**4. `Array.splice` optimization (Phase 4, Task 5) is sufficient; gap buffer is overkill.**

The gap table says "Gap buffer or direct splice optimization" but the plan's tasks only do the splice optimization (single `splice(index, 0, ...newSlots)` for batch insert). This is the right call. A gap buffer adds complexity and its benefit only manifests for very high-frequency mid-array mutations. CRDT operations are typically append-heavy (new list items added at end) or transaction-batched (handled by the new batch ops). Drop the "gap buffer" mention from the gap table to avoid confusion.

## Learnings

### Delta Region Algebra

During research, we identified that text patching, list regions, and conditional regions all follow the same **Functional Core / Imperative Shell** pattern:

| Region Type | Planning Function | Execution Function | Delta Type |
|-------------|-------------------|-------------------|------------|
| Text | `planTextPatch(ops)` | `patchText(node, ops)` | `"text"` |
| List | `planDeltaOps(ref, ops)` | `executeOp(parent, state, handlers, op)` | `"list"` |
| Conditional | `planConditionalUpdate(...)` | `executeConditionalOp(...)` | via condition ref |

All three are **delta regions** — DOM subtrees that update via structured deltas:

1. **Initial render**: Read current value, create DOM
2. **Subscribe**: Register for delta notifications
3. **Delta dispatch**: 
   - If delta matches region type → surgical update (O(k) where k = change size)
   - Otherwise → full re-render fallback (O(n) where n = data size)

The text patching work (recently completed) serves as a proof-of-concept for this pattern. Template cloning extends this by ensuring the initial DOM creation is also optimal.

**TECHNICAL.md should document this unified "Delta Region Algebra"** as part of PR 4 or PR 6 updates.

### Existing Infrastructure

Several pieces already exist that simplify implementation:

1. **`LoopNode.hasReactiveItems`** — already computed at IR creation time, can be emitted as `isReactive` flag for PR 8
2. **`LoopNode.bodySlotKind`** — already computed, used for slot tracking
3. **`Dependency.deltaKind`** — already on IR, enables detecting when surgical updates are possible
4. **`claimSlot` / `releaseSlot`** — already handle DocumentFragment edge cases, will work with template cloning

### File Locations Clarified

- `elements.d.ts` is at `src/types/elements.d.ts` — provides global ambient declarations for HTML element factories
- The globals coexist with explicit imports; no changes needed for component support

## Changeset

This plan constitutes a **minor** version bump for `@loro-extended/kinetic`:

- **New feature**: Template cloning for fast DOM creation
- **New feature**: User-defined component support via `ComponentFactory` type
- **New feature**: CRDT-aware batch DOM operations
- **Performance**: Lazy scopes, numeric IDs, reduced per-item overhead
- No breaking changes (global element declarations retained)
