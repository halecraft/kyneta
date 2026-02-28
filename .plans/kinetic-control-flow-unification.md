# Plan: Control Flow Unification — Binding-Time-Parameterized Loops and Conditionals

## Background

The DOM Algebra work (Phases 0–2) established binding-time analysis as the organizing principle for Kinetic's IR. `ContentValue` unified `TextNode + ExpressionNode` by making binding time explicit rather than encoding it as separate types. This yielded conceptual clarity, implementation simplicity, and enabled tree merge for conditional dissolution.

The same structural duplication now exists one level up — in control flow nodes.

### The Isomorphism

| Before (values) | After (values) | Binding Time |
|---|---|---|
| `TextNode` | `ContentValue { literal }` | ✅ Done |
| `ExpressionNode { static }` | `ContentValue { render }` | ✅ Done |
| `ExpressionNode { reactive }` | `ContentValue { reactive }` | ✅ Done |

| Before (control flow) | After (control flow) | Binding Time |
|---|---|---|
| `StaticLoopNode` | `LoopNode { render }` | This plan |
| `ListRegionNode` | `LoopNode { reactive }` | This plan |
| `StaticConditionalNode` | `ConditionalNode { render }` | This plan |
| `ConditionalRegionNode` | `ConditionalNode { reactive }` | This plan |

A `StaticLoopNode` is a loop whose iterable has render-time binding time. A `ListRegionNode` is a loop whose iterable has reactive binding time. The body structure, item variable, and index variable are identical. The codegen difference (inline `for` vs `__listRegion`) is a codegen dispatch on binding time — the same pattern `ContentValue` already uses.

Similarly, `StaticConditionalNode` and `ConditionalRegionNode` both represent "if this condition, render this body." The reactive version carries runtime metadata (`subscriptionTarget`, `slotKind`, branches as an array), but the *shape* — a control expression plus body — is the same.

### Why This Matters Now

1. **`ChildNode` union has 8 members — should have 6.** Four of the eight are two pairs of duplicates distinguished only by binding time.

2. **Codegen has parallel code paths.** `dom.ts` has `generateStaticLoop` and `generateListRegion` doing structurally similar work. `html.ts` has `generateStaticLoopInline`, `generateStaticLoopBody`, `generateStaticConditionalInline`, `generateStaticConditionalBody` — all parallel to their reactive counterparts. Worse, the body-walking logic in `html.ts` is copy-pasted 4 times across `generateBodyHtml`, `generateStaticLoopBody`, and `generateStaticConditionalBody` (twice for then/else).

3. **`analyzeIfStatement` creates different IR node types** based on a runtime check of `condition.bindingTime`. With unified types, it would set a field — same factory, different binding time.

4. **`collectDependencies` in `createBuilder` has separate branches** for `static-loop`, `static-conditional`, `list-region`, and `conditional-region` that walk the same body structure.

5. **Tree merge's `mergeNode` returns `region-not-mergeable`** for all control flow nodes. With unified types, future work could reason about merging loops/conditionals by their structure, not their kind tag.

6. **`collectRequiredImports` doesn't recurse into static-loop/static-conditional bodies.** If a static loop contains a reactive element with bindings, the import for `__bindTextValue` would be missed. This is a latent bug that the unification naturally fixes.

7. **Three conditional codegen paths in dom.ts.** `generateStaticConditionalNode` (inline `if`), `generateStaticConditional` (`__staticConditionalRegion`), and `generateConditionalRegion` (`__conditionalRegion` with dissolution attempt). After unification, render-time conditionals should emit inline `if` — the `__staticConditionalRegion` path is a vestige of when render-time conditionals were routed through `ConditionalRegionNode` with `subscriptionTarget === null`.

### The Conditional Shape Mismatch

The conditional case requires careful thought because the two types have different branch representations:

- `StaticConditionalNode`: `{ conditionSource: string, thenBody, elseBody }`
- `ConditionalRegionNode`: `{ branches: ConditionalBranch[], subscriptionTarget }`

The unified `ConditionalNode` must use the branches representation (it's strictly more general — it supports if/else-if/else chains). Render-time conditionals will be expressed as branches with `condition.bindingTime !== "reactive"`.

### The Loop Shape Mismatch

The loop case also has a naming difference:

- `StaticLoopNode`: `{ iterableSource: string, ... }`
- `ListRegionNode`: `{ listSource: string, ..., hasReactiveItems, bodySlotKind }`

The unified `LoopNode` uses `iterableSource` (more accurate — not all iterables are lists). The reactive-only fields (`hasReactiveItems`, `bodySlotKind`) become optional or computed annotations.

## Problem Statement

1. **Duplicated structure**: Two IR node types for loops and two for conditionals encode the same concept with different names, duplicating code paths in analysis, codegen, dependency collection, and type guards.

2. **Inconsistent binding-time model**: `ContentValue` makes binding time a field; control flow nodes make it a type-level distinction. The IR is half-unified.

3. **Unnecessary ChildNode complexity**: 8 union members where 6 suffice. Every consumer (codegen switch, tree merge, dependency walker) must handle both variants.

4. **Duplicated body-walking in html.ts**: The pattern "for each child: if statement emit verbatim, if static-loop recurse, if static-conditional recurse, else emit HTML" is copy-pasted 4 times with no shared helper.

5. **Latent bug**: `collectRequiredImports` doesn't recurse into static-loop/static-conditional bodies, potentially missing runtime imports.

6. **Vestigial codegen path**: `__staticConditionalRegion` is emitted for render-time conditionals that happen to go through `ConditionalRegionNode` with `subscriptionTarget === null`. After unification, all render-time conditionals should emit inline `if` statements.

## Success Criteria

1. `StaticLoopNode` and `ListRegionNode` are replaced by a single `LoopNode` with `iterableBindingTime: BindingTime`
2. `StaticConditionalNode` and `ConditionalRegionNode` are replaced by a single `ConditionalNode` using the branches representation, with the condition's `bindingTime` determining codegen path
3. `ChildNode` union has 6 members: `ElementNode | ContentValue | LoopNode | ConditionalNode | BindingNode | StatementNode`
4. `IRNodeKind` has 6 non-root kinds: `"element" | "content" | "loop" | "conditional" | "binding" | "statement"`
5. Codegen dispatches on binding time within each node type, not on the node type itself
6. `analyzeForOfStatement` and `analyzeIfStatement` produce the same node type regardless of binding time
7. Tree merge can inspect loop/conditional structure (even if not yet merging them)
8. HTML codegen body-walking is extracted into a shared `emitBodyChildren` helper — the 4x copy-paste is eliminated
9. `hasReactiveItems` is a pure function `computeHasReactiveItems(body)`, aligned with the `computeSlotKind` pattern
10. Render-time conditionals emit inline `if` statements; `__staticConditionalRegion` codegen path is removed
11. `collectRequiredImports` recurses into all control flow bodies (fixes latent bug)
12. All existing tests pass (578+)
13. TECHNICAL.md reflects the unified IR

## The Gap

| Aspect | Current | Target |
|--------|---------|--------|
| Loop IR types | `StaticLoopNode` + `ListRegionNode` (2 types) | `LoopNode` (1 type, `iterableBindingTime` field) |
| Conditional IR types | `StaticConditionalNode` + `ConditionalRegionNode` (2 types) | `ConditionalNode` (1 type, branches with `bindingTime` on condition) |
| `ChildNode` members | 8 | 6 |
| `IRNodeKind` values | 8 non-root | 6 non-root |
| `analyzeForOfStatement` | Returns different types based on reactivity | Returns `LoopNode` always |
| `analyzeIfStatement` | Returns different types based on reactivity | Returns `ConditionalNode` always |
| Codegen dispatch | On node kind (4 cases for 2 concepts) | On binding time within unified kind (2 cases, each with binding-time dispatch) |
| `collectDependencies` | 4 branches for control flow | 2 branches for control flow |

## Core Type Definitions

### Pure computation functions

```typescript
/**
 * Whether any direct child in a body has reactive content.
 * Shallow check — does not recurse into nested loops/conditionals.
 * Answers: "do items at this level need their own subscriptions?"
 */
function computeHasReactiveItems(body: ChildNode[]): boolean

/** How many DOM nodes a body produces: "single" or "range". */
function computeSlotKind(body: ChildNode[]): SlotKind  // already exists
```

Both are pure functions called by factories and stored on nodes. The logic is testable independently.

### LoopNode (replaces StaticLoopNode + ListRegionNode)

```typescript
interface LoopNode extends IRNodeBase {
  kind: "loop"

  /** The iterable expression source */
  iterableSource: string

  /** Binding time of the iterable — determines codegen strategy */
  iterableBindingTime: BindingTime

  /** The loop variable name */
  itemVariable: string

  /** Optional index variable name */
  indexVariable: string | null

  /** The body of the loop */
  body: ChildNode[]

  /**
   * Whether items have reactive content.
   * Computed via computeHasReactiveItems(body) at IR creation time.
   */
  hasReactiveItems: boolean

  /**
   * Slot kind for the body.
   * Computed via computeSlotKind(body) at IR creation time.
   */
  bodySlotKind: SlotKind

  /**
   * For reactive iterables, the subscription dependencies.
   * Empty for render-time loops.
   */
  dependencies: string[]
}
```

### ConditionalNode (replaces StaticConditionalNode + ConditionalRegionNode)

```typescript
interface ConditionalNode extends IRNodeBase {
  kind: "conditional"

  /** The branches, in order: if, else-if..., else (condition: null) */
  branches: ConditionalBranch[]

  /**
   * For reactive conditions, the ref to subscribe to.
   * Null for render-time conditionals.
   */
  subscriptionTarget: string | null
}
```

`ConditionalBranch` is unchanged — it already uses `ContentValue` for its condition and includes `slotKind`.

### Updated ChildNode

```typescript
type ChildNode =
  | ElementNode
  | ContentValue
  | LoopNode
  | ConditionalNode
  | BindingNode
  | StatementNode
```

### Updated IRNodeKind

```typescript
type IRNodeKind =
  | "builder"
  | "element"
  | "content"
  | "loop"
  | "conditional"
  | "binding"
  | "statement"
```

## Phases and Tasks

### Phase -1: Extract HTML body-walking helper 🔴

**Goal**: Eliminate the 4x copy-paste in `html.ts` before the unification touches those code paths. This makes the subsequent phases smaller and less error-prone. Also add baseline tests for static else-if chains (no coverage exists today).

- 🔴 Task -1.1: Extract `emitBodyChildren(body: ChildNode[], state: CodegenState): string[]` in `html.ts` that walks a body array and returns lines of code (statement source, static-loop/conditional recursion, or `_html += \`...\``). This is the pattern currently duplicated in `generateBodyHtml`, `generateStaticLoopBody`, and `generateStaticConditionalBody` (twice).
- 🔴 Task -1.2: Refactor `generateBodyHtml` to delegate to `emitBodyChildren`
- 🔴 Task -1.3: Refactor `generateStaticLoopBody` to delegate to `emitBodyChildren`
- 🔴 Task -1.4: Refactor `generateStaticConditionalBody` to delegate to `emitBodyChildren`
- 🔴 Task -1.5: Extract `computeHasReactiveItems(body: ChildNode[]): boolean` as a pure function in `ir.ts`, alongside `computeSlotKind`. This is a **shallow** check (direct children only) — it answers "do items at this level need their own subscriptions?" not "does any transitive descendant have reactive content?" Preserve the existing semantics from `createListRegion`'s inline computation. Update `createListRegion` (soon `createLoop`) to call it.
- 🔴 Task -1.6: Add baseline tests for static else-if chains in `analyze.test.ts` and `dom.test.ts`. Currently no tests exercise `if/else-if/else` where all conditions are render-time. This produces nested `StaticConditionalNode` in `elseBody` today — capture that behavior before unification changes it to flat branches. Also add a DOM codegen test and an HTML codegen test for the same pattern.
- 🔴 Task -1.7: Verify all tests pass and build succeeds

### Phase 0: Unify Loops — LoopNode 🔴

**Goal**: Replace `StaticLoopNode` and `ListRegionNode` with a single `LoopNode`.

- 🔴 Task 0.1: Define `LoopNode` interface in `ir.ts` with `kind: "loop"`, `iterableSource`, `iterableBindingTime`, `itemVariable`, `indexVariable`, `body`, `hasReactiveItems`, `bodySlotKind`, `dependencies`
- 🔴 Task 0.2: Replace `createStaticLoop` and `createListRegion` with `createLoop(iterableSource, iterableBindingTime, itemVariable, indexVariable, body, dependencies, span)` — factory calls `computeHasReactiveItems(body)` and `computeSlotKind(body)` always (not just for reactive)
- 🔴 Task 0.3: Update `IRNodeKind` — remove `"list-region"` and `"static-loop"`, add `"loop"`
- 🔴 Task 0.4: Remove `StaticLoopNode` and `ListRegionNode` interfaces
- 🔴 Task 0.5: Update `ChildNode` union — replace `StaticLoopNode | ListRegionNode` with `LoopNode`
- 🔴 Task 0.6: Update type guards — remove `isStaticLoopNode` and `isListRegionNode`, add `isLoopNode`
- 🔴 Task 0.7: Update `analyzeForOfStatement` in `analyze.ts` — always return `createLoop(...)`, passing `"render"` or `"reactive"` based on `expressionIsReactive`
- 🔴 Task 0.8: Update `generateChild` in `codegen/dom.ts` — replace `case "list-region"` and `case "static-loop"` with `case "loop"` that dispatches on `node.iterableBindingTime`
- 🔴 Task 0.9: Update `generateChild` in `codegen/html.ts` — replace `case "list-region"` and `case "static-loop"` with `case "loop"`. Update `emitBodyChildren` (from Phase -1) to handle unified `"loop"` kind.
- 🔴 Task 0.10: Update `collectDependencies` in `createBuilder` — replace separate `list-region` and `static-loop` branches with single `loop` branch
- 🔴 Task 0.11: Update `collectRequiredImports` in `transform.ts` — `case "loop"`: add `__listRegion` when `iterableBindingTime === "reactive"`, and always recurse into `node.body` (fixes latent bug where static-loop bodies were not recursed)
- 🔴 Task 0.12: Update `mergeNode` in tree merge — replace `region-not-mergeable` fallthrough with explicit `case "loop"` (still returns not-mergeable for now, but with structured reason)
- 🔴 Task 0.13: Update `compiler/index.ts` re-exports — replace `ListRegionNode` → `LoopNode`, `isListRegionNode` → `isLoopNode`, `createListRegion` → `createLoop`. (Note: `StaticLoopNode`, `isStaticLoopNode`, `createStaticLoop` were never exported from `index.ts`, so no removal needed for those.)
- 🔴 Task 0.14: Update all tests in `ir.test.ts`, `analyze.test.ts`, `dom.test.ts`, `html.test.ts`, `integration.test.ts`, `transform.test.ts`, `tree-merge.test.ts`
- 🔴 Task 0.15: Verify all tests pass and build succeeds

### Phase 1: Unify Conditionals — ConditionalNode 🔴

**Goal**: Replace `StaticConditionalNode` and `ConditionalRegionNode` with a single `ConditionalNode`. Remove the `__staticConditionalRegion` codegen path.

- 🔴 Task 1.1: Define `ConditionalNode` interface in `ir.ts` with `kind: "conditional"`, `branches`, `subscriptionTarget`
- 🔴 Task 1.2: Replace `createStaticConditional` and `createConditionalRegion` with `createConditional(branches, subscriptionTarget, span)` — `subscriptionTarget` is null for render-time conditionals
- 🔴 Task 1.3: Update `analyzeIfStatement` in `analyze.ts` — always produce `ConditionalNode`. Render-time conditionals create branches with render-time conditions (the condition is already a `ContentValue` from `analyzeExpression`). Static else-if chains produce flat branches, not nested `StaticConditionalNode` in elseBody. The reactive path already produces flat branches. Note: the recursive `analyzeIfStatement` call for `else if` currently checks `nestedIf.kind === "conditional-region"` to decide whether to flatten; after unification, the check becomes `nestedIf.kind === "conditional"` (always true), so flattening always happens — which is exactly what we want.
- 🔴 Task 1.4: Update `IRNodeKind` — remove `"conditional-region"` and `"static-conditional"`, add `"conditional"`
- 🔴 Task 1.5: Remove `StaticConditionalNode` and `ConditionalRegionNode` interfaces
- 🔴 Task 1.6: Update `ChildNode` union — replace `StaticConditionalNode | ConditionalRegionNode` with `ConditionalNode`
- 🔴 Task 1.7: Update type guards — remove `isStaticConditionalNode` and `isConditionalRegionNode`, add `isConditionalNode`
- 🔴 Task 1.8: Update `generateChild` in `codegen/dom.ts` — replace `case "conditional-region"` and `case "static-conditional"` with `case "conditional"` containing a single `generateConditional` function. This function dispatches: `subscriptionTarget === null` → render-time inline `if` from branches (replaces both `generateStaticConditionalNode` and `generateStaticConditional`); `subscriptionTarget !== null` → attempt dissolution, then fallback to `__conditionalRegion`.
- 🔴 Task 1.9: Remove `generateStaticConditional` (emitted `__staticConditionalRegion`) and `generateStaticConditionalNode` (emitted inline `if`) from `dom.ts`. The unified `generateConditional` handles both via binding-time dispatch. Render-time conditionals always emit inline `if` — no `__staticConditionalRegion` runtime call.
- 🔴 Task 1.10: Update `generateChild` in `codegen/html.ts` — replace `case "conditional-region"` and `case "static-conditional"` with `case "conditional"`. Update `emitBodyChildren` for unified `"conditional"` kind. Remove `generateStaticConditionalInline` and `generateStaticConditionalBody`.
- 🔴 Task 1.11: Update `collectDependencies` in `createBuilder` — replace separate `conditional-region` and `static-conditional` branches with single `conditional` branch that walks all branch bodies
- 🔴 Task 1.12: Update `collectRequiredImports` in `transform.ts` — `case "conditional"`: add `__conditionalRegion` when `subscriptionTarget !== null`, always recurse into branch bodies (fixes latent bug). Remove `__staticConditionalRegion` import — it's no longer emitted.
- 🔴 Task 1.13: Update `mergeNode` in tree merge — explicit `case "conditional"` (not-mergeable with structured reason)
- 🔴 Task 1.14: Update `compiler/index.ts` re-exports — replace `ConditionalRegionNode` → `ConditionalNode`, `isConditionalRegionNode` → `isConditionalNode`, `createConditionalRegion` → `createConditional`. (Note: `StaticConditionalNode`, `isStaticConditionalNode`, `createStaticConditional` were never exported from `index.ts`, so no removal needed for those.)
- 🔴 Task 1.15: Remove `__staticConditionalRegion` runtime function from `regions.ts` and its export from `types.ts`. Research confirmed no hand-written application code or integration tests call it directly — it's only referenced via codegen output and one `dom.test.ts` assertion (updated in Task 1.16). The `integration.test.ts` reference is a comment only.
- 🔴 Task 1.16: Update all tests. Specific attention: `dom.test.ts` has a test `"should generate __staticConditionalRegion for static condition"` that manually constructs a `ConditionalRegionNode` with `subscriptionTarget: null` — update to assert inline `if` output instead. Also fix: that test constructs a `ConditionalBranch` object literal missing the required `slotKind` field — use `createConditionalBranch` factory instead.
- 🔴 Task 1.17: Verify all tests pass and build succeeds

### Phase 2: Documentation 🔴

**Goal**: Update documentation to reflect the unified IR and the binding-time principle extended to control flow.

- 🔴 Task 2.1: Update `packages/kinetic/TECHNICAL.md` — replace StaticLoopNode/ListRegionNode/StaticConditionalNode/ConditionalRegionNode sections with LoopNode/ConditionalNode, update ChildNode union, update IRNodeKind
- 🔴 Task 2.2: Add section to TECHNICAL.md explaining the binding-time principle as the organizing pattern: values (ContentValue), loops (LoopNode), conditionals (ConditionalNode) all parameterized by binding time
- 🔴 Task 2.3: Update File Structure section in TECHNICAL.md if any files changed
- 🔴 Task 2.4: Update `packages/kinetic/README.md` test count

## Tests

### Phase -1 tests: HTML body helper

- Existing HTML codegen tests should pass unchanged after `emitBodyChildren` extraction (pure refactor, no behavior change)
- New unit test for `computeHasReactiveItems`: verify it returns true for bodies with reactive content, elements with reactive attributes, nested loops/conditionals; false for purely static bodies. Note: this is a **shallow** check (direct children only), preserving the semantics from `createListRegion`'s inline computation.
- New baseline tests for static else-if chains (Task -1.6): `analyze.test.ts` should verify that `if (a) {...} else if (b) {...} else {...}` with render-time conditions produces a `StaticConditionalNode` with a nested `StaticConditionalNode` in `elseBody`. `dom.test.ts` and `html.test.ts` should capture the generated code. These tests establish the pre-unification behavior so Phase 1 can intentionally change it to flat branches.

### Loop unification tests

Existing tests in `analyze.test.ts`, `dom.test.ts`, `html.test.ts`, and `integration.test.ts` already cover both static and reactive loops. After unification:

- Tests that check `kind === "static-loop"` should check `kind === "loop"` and `iterableBindingTime === "render"`
- Tests that check `kind === "list-region"` should check `kind === "loop"` and `iterableBindingTime === "reactive"`
- Codegen tests should verify identical output before and after unification

### Conditional unification tests

Similarly:

- Tests that check `kind === "static-conditional"` should check `kind === "conditional"` and verify `subscriptionTarget === null`
- Tests that check `kind === "conditional-region"` should check `kind === "conditional"` and verify `subscriptionTarget !== null`
- The tree merge tests should continue passing — `mergeConditionalBodies` already operates on `ConditionalBranch[]`, which is unchanged

### New test: LoopNode factory

```typescript
describe("createLoop", () => {
  it("computes hasReactiveItems and bodySlotKind for reactive loops", ...)
  it("computes hasReactiveItems and bodySlotKind for render loops", ...)
  it("preserves dependencies for reactive loops", ...)
  it("has empty dependencies for render loops", ...)
})
```

### New test: ConditionalNode from static source

```typescript
describe("createConditional", () => {
  it("creates render-time conditional with null subscriptionTarget", ...)
  it("creates reactive conditional with subscriptionTarget", ...)
  it("handles static else-if as flat branches not nested nodes", ...)
})
```

### New test: collectRequiredImports recursion (bug fix verification)

```typescript
describe("collectRequiredImports", () => {
  it("collects __bindTextValue from inside a render-time loop body", ...)
  it("collects __bindTextValue from inside a render-time conditional body", ...)
})
```

## Transitive Effect Analysis

### Direct Dependencies

- `ir.ts` — Type definitions, factory functions, type guards, tree merge
- `analyze.ts` — `analyzeForOfStatement`, `analyzeIfStatement`
- `codegen/dom.ts` — `generateChild`, `generateStaticLoop`, `generateListRegion`, `generateStaticConditionalNode`, `generateConditionalRegion`
- `codegen/html.ts` — `generateChild`, `generateBodyHtml`, `generateStaticLoopInline`, `generateStaticLoopBody`, `generateStaticConditionalInline`, `generateStaticConditionalBody`, `generateListRegion`, `generateConditionalRegion`
- `transform.ts` — `collectRequiredImports`
- `compiler/index.ts` — Re-exports

### Transitive Dependencies

- `types.ts` — `ListRegionHandlers` references `ListRegionNode` by concept but not by import. The handler types are runtime-facing and don't change.
- `runtime/regions.ts` — Uses handler objects at runtime. The runtime is unaffected because the handler shape doesn't change; only codegen changes what handler object it emits.
- `tree-merge.test.ts` — Imports from `ir.ts`. The `mergeNode` function's switch cases change.
- `integration.test.ts` — Exercises full pipeline. Transitively affected by all changes.
- `vite/plugin.ts` — Calls `transformSource`. Not affected (no IR type awareness).

### Breaking Change Assessment

- **IR types are publicly exported and will change**: `compiler/index.ts` exports `ListRegionNode`, `ConditionalRegionNode`, `isListRegionNode`, `isConditionalRegionNode`, `createListRegion`, `createConditionalRegion`, and `ConditionalBranch`. These are replaced by `LoopNode`, `ConditionalNode`, `isLoopNode`, `isConditionalNode`, `createLoop`, `createConditional`. This is acceptable — the package is experimental and the IR is not a stability contract. Note: `StaticLoopNode`, `StaticConditionalNode`, and their factories/guards were **never** exported from `index.ts`, so no external breakage there.
- **Runtime mostly unaffected**: Handler shapes (`ListRegionHandlers`, `ConditionalRegionHandlers`) don't change. Generated code calls the same runtime functions. One exception: `__staticConditionalRegion` will no longer be emitted by codegen and can be removed (confirmed: no hand-written code calls it directly).
- **Build will fail if index.ts re-exports are not updated** (learned from Phase 0 of the DOM Algebra plan).

### Risk: Static conditional branch representation change

`StaticConditionalNode` has `{ conditionSource: string, thenBody, elseBody }` while `ConditionalNode` will use `{ branches: ConditionalBranch[] }`. The codegen for render-time conditionals must reconstruct the `if/else` structure from branches. This is straightforward (branches[0].condition is the if, branches with null condition is the else) but must be carefully tested for the `else-if` case, which `StaticConditionalNode` currently handles by nesting a `StaticConditionalNode` inside the `elseBody`.

The analysis side handles this by changing `analyzeIfStatement`: instead of nesting a `StaticConditionalNode` in the else body, static else-if chains should produce flat branches just like the reactive path already does. The key mechanism: the recursive `analyzeIfStatement` call for `else if` currently checks `nestedIf.kind === "conditional-region"` to flatten branches; after unification the kind is always `"conditional"`, so the check always succeeds and flattening always happens. This eliminates the nesting asymmetry.

**Mitigation**: Phase -1 Task -1.6 adds baseline tests for static else-if chains before unification, so we can verify the behavior change from nested-to-flat is intentional and correct.

### Risk: __staticConditionalRegion removal — RESOLVED

Research confirmed `__staticConditionalRegion` is only called via codegen output. No hand-written application code or integration tests invoke it directly. The only references are:
- `regions.ts` L695: definition
- `dom.ts` L718: codegen emits calls to it
- `transform.ts` L205: import collector adds it
- `dom.test.ts` L620: asserts codegen output contains it (update in Phase 1)
- `integration.test.ts` L1387: comment only
- `TECHNICAL.md` L422: documentation

Safe to remove in Phase 1 Task 1.15 without deprecation.

## Resources for Implementation

### Files to Modify

- `packages/kinetic/src/compiler/ir.ts` — `LoopNode`, `ConditionalNode`, factories, type guards, `IRNodeKind`, `ChildNode`, `mergeNode`, `collectDependencies` in `createBuilder`
- `packages/kinetic/src/compiler/analyze.ts` — `analyzeForOfStatement`, `analyzeIfStatement`
- `packages/kinetic/src/compiler/codegen/dom.ts` — `generateChild`, loop/conditional generators
- `packages/kinetic/src/compiler/codegen/html.ts` — `generateChild`, `generateBodyHtml`, loop/conditional generators
- `packages/kinetic/src/compiler/transform.ts` — `collectRequiredImports`
- `packages/kinetic/src/compiler/index.ts` — Re-exports
- `packages/kinetic/src/compiler/ir.test.ts` — Update factory calls and assertions
- `packages/kinetic/src/compiler/analyze.test.ts` — Update kind checks
- `packages/kinetic/src/compiler/codegen/dom.test.ts` — Update kind checks
- `packages/kinetic/src/compiler/codegen/html.test.ts` — Update kind checks
- `packages/kinetic/src/compiler/integration.test.ts` — Update kind checks
- `packages/kinetic/src/compiler/transform.test.ts` — Update manually-constructed IR
- `packages/kinetic/src/compiler/tree-merge.test.ts` — Update if any tree merge logic changes
- `packages/kinetic/TECHNICAL.md` — Unified IR documentation

### Key Code Sections

- `StaticLoopNode` interface: `ir.ts` L399–413
- `ListRegionNode` interface: `ir.ts` L261–287
- `StaticConditionalNode` interface: `ir.ts` L427–438
- `ConditionalRegionNode` interface: `ir.ts` L318–335
- `ConditionalBranch` interface: `ir.ts` L292–305
- `createListRegion` (inline `hasReactiveItems`): `ir.ts` L1065–1090
- `createStaticLoop`: `ir.ts` L1095–1110
- `createStaticConditional`: `ir.ts` L1115–1128
- `createConditionalRegion`: `ir.ts` L1149–1160
- `analyzeForOfStatement`: `analyze.ts` L585–656
- `analyzeIfStatement`: `analyze.ts` L661–726
- `generateChild` (DOM): `dom.ts` L335–421
- `generateStaticLoop` (DOM): `dom.ts` L765–790
- `generateStaticConditionalNode` (DOM): `dom.ts` L802–832
- `generateStaticConditional` (DOM, emits `__staticConditionalRegion`): `dom.ts` L705–743
- `generateConditionalRegion` (DOM): `dom.ts` L623–700
- `generateListRegion` (DOM): `dom.ts` L583–614
- `generateChild` (HTML): `html.ts` L313–354
- `generateBodyHtml` (HTML): `html.ts` L274–304
- `generateStaticLoopBody` (HTML): `html.ts` L470–501
- `generateStaticLoopInline` (HTML): `html.ts` L508–521
- `generateStaticConditionalBody` (HTML): `html.ts` L532–578
- `generateStaticConditionalInline` (HTML): `html.ts` L585–600
- `collectRequiredImports`: `transform.ts` L188–233
- `collectDependencies` in `createBuilder`: `ir.ts` L1175–1216
- `__staticConditionalRegion` runtime: `regions.ts` L695–725
- `compiler/index.ts` re-exports: `index.ts` (full file, ~170 lines)

### Cross-Reference: Prior Plans

- `.plans/kinetic-dom-algebra.md` — Established the binding-time framework that this plan extends to control flow
- `.plans/kinetic-region-algebra.md` — Established the region/slot architecture that the runtime side uses

## Changeset

```
---
"@loro-extended/kinetic": minor
---

Unify control flow IR nodes via binding-time parameterization

**BREAKING**: IR type exports changed — `ListRegionNode` → `LoopNode`,
`ConditionalRegionNode` → `ConditionalNode`, and corresponding factories/guards.

- Replaced `StaticLoopNode` + `ListRegionNode` with `LoopNode` parameterized
  by `iterableBindingTime`
- Replaced `StaticConditionalNode` + `ConditionalRegionNode` with
  `ConditionalNode` using branches representation with condition binding time
- `ChildNode` union reduced from 8 to 6 members
- `IRNodeKind` reduced from 8 to 6 non-root values
- Static else-if chains now produce flat branches (matching reactive path)
  instead of nested `StaticConditionalNode` in `elseBody`
- Extracted `emitBodyChildren` in HTML codegen (eliminated 4x copy-paste)
- Extracted `computeHasReactiveItems` as pure function
- Render-time conditionals emit inline `if`; `__staticConditionalRegion`
  runtime function and codegen path removed
- Fixed: `collectRequiredImports` now recurses into all control flow bodies
- Analysis produces unified types; codegen dispatches on binding time
- No changes to generated code behavior (output identical)
```

## Learnings

### Binding time is the universal parameterization axis

The ContentValue unification showed that `TextNode` and `ExpressionNode` were the same concept at different binding times. The control flow unification confirms this is a general principle: **every IR node that exists in both static and reactive variants is a candidate for binding-time parameterization.** The test is: "do these two types have the same shape, differing only in how/when their control expression is evaluated?"

### Static else-if chains are a representation accident

`StaticConditionalNode` handles else-if by nesting: `{ thenBody, elseBody: [StaticConditionalNode] }`. The reactive path handles else-if with flat branches: `{ branches: [{condition, body}, ...] }`. The nesting approach is an artifact of following the AST structure too closely. Flat branches are strictly better — they enable uniform iteration, tree merge, and avoid recursive unwinding in codegen.

### The ChildNode taxonomy is now clean

After unification, ChildNode has exactly 6 members in 3 categories:

- **Applicative** (fixed structure): `ElementNode`, `ContentValue`
- **Monadic** (dynamic structure): `LoopNode`, `ConditionalNode`
- **Effects** (side effects): `BindingNode`, `StatementNode`

This is the natural decomposition. Each category has exactly 2 members. Binding time is orthogonal — it's a field on the monadic nodes and on ContentValue, not a type-level distinction.

### Extract shared helpers before unification, not during

The HTML codegen body-walking was copy-pasted 4 times. Attempting to unify loop/conditional kinds while also deduplicating the body walker would mix two concerns in one change. Phase -1 extracts the shared helper first, making the subsequent unification a clean find-and-replace on kind tags. This is the same principle as "refactor to make the change easy, then make the easy change."

### Derived fields should be computed by pure functions

`hasReactiveItems` was computed inline in `createListRegion`. `bodySlotKind` was computed via the standalone `computeSlotKind`. Aligning both as named pure functions (`computeHasReactiveItems`, `computeSlotKind`) makes the IR factory a simple "compute + assemble" step — all logic is testable independently, and the factory is trivially correct by construction.

### collectRequiredImports had a latent bug

`collectRequiredImports` never recursed into `static-loop` or `static-conditional` bodies. A static loop containing a reactive element with bindings would silently fail to import `__bindTextValue`. The unification fixes this naturally because there's now one `"loop"` case that always recurses. This is a concrete example of how type duplication causes bugs: the author handled the two reactive cases but forgot (or didn't know about) the two static cases.

### __staticConditionalRegion was a codegen artifact, not an architectural need

The `__staticConditionalRegion` runtime function exists because `ConditionalRegionNode` with `subscriptionTarget === null` was routed through the reactive codegen path, which expected a region-style handler object. With unified conditionals, render-time branches emit inline `if` — no runtime region needed. Research confirmed no hand-written code calls it — safe to remove outright.

### Static else-if chains have zero test coverage pre-unification

No existing test exercises a static (render-time) `if/else-if/else` chain. The `analyze.test.ts` tests only cover simple `if` and `if/else`. The reactive `else-if` path is well-tested (integration tests cover `if/else-if/else` with reactive conditions), but the static path's nesting behavior (nested `StaticConditionalNode` in `elseBody`) is untested. Phase -1 Task -1.6 adds baseline tests before the unification changes this to flat branches.

### `computeHasReactiveItems` is intentionally shallow

The inline `hasReactiveItems` computation in `createListRegion` checks direct children only — it does not recurse into nested loops or conditionals. This is semantically correct: `hasReactiveItems` answers "do items at this list level need their own subscriptions?" A static loop nested inside a list region body doesn't introduce per-item reactivity. The extracted `computeHasReactiveItems` must preserve this shallow semantics.

### `ConditionalBranch` construction in dom.test.ts is missing `slotKind`

The test at `dom.test.ts` L602–607 constructs a `ConditionalBranch` object literal without the required `slotKind` field (the interface at `ir.ts` L292–305 requires it). This works at runtime because TypeScript is lenient with object literals in test contexts, but it's an interface violation. The `createConditionalBranch` factory correctly computes `slotKind` via `computeSlotKind`. Phase 1 Task 1.16 should fix this by using the factory.

### index.ts export surface is asymmetric

`compiler/index.ts` exports the reactive control flow types (`ListRegionNode`, `ConditionalRegionNode`, `isListRegionNode`, `isConditionalRegionNode`, `createListRegion`, `createConditionalRegion`) but does NOT export the static counterparts (`StaticLoopNode`, `StaticConditionalNode`, `isStaticLoopNode`, `isStaticConditionalNode`, `createStaticLoop`, `createStaticConditional`). This simplifies the Phase 0 and Phase 1 index.ts tasks — we only need to rename/replace the reactive exports, not add or remove static ones.