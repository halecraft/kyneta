# Kinetic IR-Level Conditional Dissolution

## Background

Kinetic's conditional dissolution optimization transforms structurally identical if/else branches into pure Applicative code with ternary expressions, eliminating the need for runtime `conditionalRegion` calls (marker creation, branch swap machinery, scope allocation). This works correctly on the non-cloning codegen path (`generateConditional` in `codegen/dom.ts` L834–846), but is **abandoned** on the template cloning path (`generateConditionalWithMarker` L1210–1218) with the comment "This is complex — for now fall back to conditionalRegion."

The non-cloning path is used by `transformSource`/`transformFile` (via `generateElementFactory` → `generateDOM`). The template cloning path is used by `transformSourceInPlace` (via `generateElementFactoryWithResult` → `generateDOMWithCloning`). The Vite plugin uses `transformSourceInPlace`, so the cloning path is the production-critical one.

The root cause: dissolution was implemented as an inline check inside codegen functions. On the template cloning path, the template HTML has already been extracted with `<!--kinetic:if:N--><!--/kinetic:if-->` comment markers in place. The walker grabbed a reference to the opening comment. Dissolving at this point would require DOM surgery (replacing markers with dissolved content) and would break the walk plan's child-index assumptions.

The clean solution: **move dissolution to the IR level**, following the established precedent of `filterTargetBlocks`. A pure IR→IR transform runs before the walker/template-extraction ever see the tree. After the transform, dissolvable conditionals are replaced by their merged children. The walker sees regular elements/content — no region placeholders, no comment markers, no special handling needed downstream.

## Problem Statement

The template cloning path produces semantically different (worse) output than the non-cloning path for dissolvable conditionals. Both paths should produce identical runtime behavior: dissolved conditionals emit ternary subscriptions, non-dissolvable conditionals emit `conditionalRegion`. Today, the template cloning path always emits `conditionalRegion` even when dissolution is possible.

## Success Criteria

- A new `dissolveConditionals(node: BuilderNode): BuilderNode` pure function in `ir.ts`
- Dissolution runs in the transform pipeline after `filterTargetBlocks`, before codegen
- The inline dissolution check in `generateConditional` (non-cloning path) is removed
- The dead dissolution attempt in `generateConditionalWithMarker` (cloning path) is removed
- Template-cloned output for dissolvable conditionals contains ternary expressions, not `conditionalRegion`
- `collectRequiredImports` correctly omits `conditionalRegion` for dissolved conditionals on the `transformSource`/`transformFile` paths (automatic — dissolved nodes are no longer `ConditionalNode` in the IR). For `transformSourceInPlace`, `conditionalRegion` may appear as an unused import (benign — see Learnings §1).
- All existing 907 tests pass
- New unit tests cover `dissolveConditionals` directly

## Gap

Dissolution exists as ad-hoc inline logic in two codegen functions (one working, one abandoned). It needs to be a proper IR transform that runs once, before any codegen path.

---

## Phase 1: Add `dissolveConditionals` IR Transform 🟢

### Task 1.1: Implement `dissolveConditionals` in `ir.ts` 🟢

Add a pure recursive IR→IR transform following the exact structural pattern of `filterTargetBlocks`:

```typescript
export function dissolveConditionals(node: BuilderNode): BuilderNode
```

The function recursively walks the IR tree. For each `ConditionalNode`:

1. If `subscriptionTarget === null` (render-time conditional): leave unchanged, recurse into branch bodies
2. If no else branch: leave unchanged (dissolution requires all branches covered)
3. Attempt `mergeConditionalBodies(node.branches)`:
   - If success: **splice** the merged `ChildNode[]` in place of the `ConditionalNode` (same splice semantics as `filterTargetBlocks` uses for matching target blocks)
   - If failure: leave the `ConditionalNode` unchanged, recurse into branch bodies

The recursive helpers mirror `filterTargetBlocks`:

```typescript
function dissolveChildren(children: ChildNode[]): ChildNode[]
function dissolveChildNode(node: ChildNode): ChildNode
```

Key structural detail: `dissolveChildren` iterates children. When it encounters a `ConditionalNode` eligible for dissolution, it calls `mergeConditionalBodies` and splices the result (which may be 1 or more children) into the output array. For all other nodes, it calls `dissolveChildNode` to recurse into their sub-trees. `dissolveChildNode` handles `element` (recurse into `children`), `loop` (recurse into `body`), and `conditional` (recurse into branch bodies) — exactly as `filterChildNode` does for `filterTargetBlocks`.

### Task 1.2: Unit tests for `dissolveConditionals` in `ir.test.ts` 🟢

Tests use existing helpers (`createConditional`, `createConditionalBranch`, `createElement`, `createLiteral`, `createContent`, `createBuilder`, `createSpan`, `dep`).

**Positive cases:**
- Two-branch conditional with same-tag elements and different literal text → dissolved into element with ternary content, conditional node gone
- Two-branch conditional with same-tag elements and different literal attributes → dissolved into element with ternary attribute
- Three-branch (if/else-if/else) → dissolved with nested ternary
- Nested: dissolvable conditional inside an element → dissolved, outer element preserved
- Nested: dissolvable conditional inside a loop body → dissolved

**Negative cases (conditional preserved):**
- Render-time conditional (`subscriptionTarget === null`) → unchanged
- No else branch → unchanged
- Different element tags in branches → unchanged
- Different child counts in branches → unchanged

**Edge case:**
- Mixed: builder with one dissolvable and one non-dissolvable conditional → first dissolved, second preserved

### Task 1.3: Integration test for dissolution on the template cloning path 🟢

Add a test in `dom.test.ts` that calls `generateElementFactoryWithResult` with a dissolvable conditional and verifies:
- No `conditionalRegion` in generated code
- No `<!--kinetic:if` in template HTML (check `moduleDeclarations`)
- Ternary expression present in generated code
- `subscribe` or `subscribeWithValue` call present (the dissolved ternary subscription)

This fills a gap: existing dissolution tests only exercise the non-cloning `generateDOM` path. No existing test verifies dissolution behavior through `generateElementFactoryWithResult` → `generateDOMWithCloning` → `extractTemplate` + `generateHoleSetup`.

### Transitive Effects

- `mergeConditionalBodies` is already exported and tested in `tree-merge.test.ts` — no changes needed
- `dissolveConditionals` produces standard `ChildNode` types (elements, content) that all downstream consumers already handle
- The `BuilderNode.allDependencies` and `BuilderNode.isReactive` fields are computed by `createBuilder` at analysis time and are not recomputed by dissolution — this is correct because dissolution doesn't add or remove reactive dependencies, it restructures them

---

## Phase 2: Wire Into Transform Pipeline 🟢

### Task 2.1: Call `dissolveConditionals` in `transformSourceInPlace` 🟢

In `transform.ts`, add `dissolveConditionals` call immediately after `filterTargetBlocks` in the replacement loop:

```typescript
for (const r of replacements) {
  r.ir = filterTargetBlocks(r.ir, target)
  r.ir = dissolveConditionals(r.ir)
}
```

This is the **primary beneficiary** — `transformSourceInPlace` drives the Vite plugin and always uses the template cloning path (`generateElementFactoryWithResult` → `generateDOMWithCloning`).

### Task 2.2: Call `dissolveConditionals` in `transformSource` / `transformFile` 🟢

In both functions, add dissolution after target block filtering:

```typescript
const filteredIr = ir
  .map(builder => filterTargetBlocks(builder, target))
  .map(dissolveConditionals)
```

These functions use the non-cloning path (`generateElementFactory` → `generateDOM`), where dissolution already works via inline logic in `generateConditional`. Adding dissolution here makes the inline logic redundant (enabling Phase 3 removal) and ensures both paths see the same IR shape.

### Task 2.3: Import `dissolveConditionals` in `transform.ts` 🟢

Add to existing import from `./ir.js`.

### Transitive Effects

- **`transformSource`/`transformFile` path**: `generateDOMOutput` calls `collectRequiredImports(ir)` on the `filteredIr` it receives. Since dissolution runs before this call, dissolved conditionals are no longer `ConditionalNode` — `conditionalRegion` is correctly omitted from imports.
- **`transformSourceInPlace` path**: `collectRequiredImports` runs on the **pre-dissolution** IR (L475, before `filterTargetBlocks` and dissolution at ~L497). This means `conditionalRegion` may appear as an unused import for dissolved conditionals. This is **benign** — it matches the existing pattern where `filterTargetBlocks` also runs after import collection (target blocks may contain `conditionalRegion` that gets stripped). See Learnings §1.
- `extractTemplate` (called by `generateDOMWithCloning`) walks the post-dissolution IR. Dissolved content appears as regular elements/content → correct template HTML, correct holes, correct walk plan. No comment markers emitted for dissolved conditionals.
- HTML codegen (`codegen/html.ts`) also benefits: dissolved conditionals produce inline ternary interpolations instead of `if` blocks with hydration markers. This is a free improvement — no changes needed in `html.ts`.

---

## Phase 3: Remove Inline Dissolution from Codegen 🟢

### Task 3.1: Remove dissolution check from `generateConditional` 🟢

In `codegen/dom.ts`, remove lines L834–847 (the `mergeConditionalBodies` attempt and early return). After Phase 2, no `ConditionalNode` reaching `generateConditional` will be dissolvable — they've already been transformed at the IR level. The function's flow becomes: check render-time → emit `conditionalRegion`.

### Task 3.2: Remove dead dissolution attempt from `generateConditionalWithMarker` 🟢

Remove lines L1210–1218 (the `mergeConditionalBodies` call that succeeds but falls through to `conditionalRegion` anyway). Same reasoning — dissolution is handled before codegen.

### Task 3.3: Remove `mergeConditionalBodies` import from `codegen/dom.ts` 🟢

After removing both call sites, the import of `mergeConditionalBodies` from `../ir.js` in `codegen/dom.ts` is unused. Remove it from line 29, leaving `computeSlotKind` as the sole import from that path.

### Transitive Effects

- `generateConditional` still handles render-time conditionals (inline `if` statement) and non-dissolvable reactive conditionals (`conditionalRegion`). No behavioral change.
- `generateConditionalWithMarker` still handles non-dissolvable reactive conditionals on the template cloning path. No behavioral change.
- All existing tests that exercise dissolution (e.g., "should dissolve conditional with identical structure" in `dom.test.ts`) continue to pass because the dissolution now happens at the IR level before codegen is called.

---

## Phase 4: Documentation 🟢

### Task 4.1: Update TECHNICAL.md "Tree Merge and Conditional Dissolution" section 🟢

Add a paragraph explaining that dissolution is now an IR-level transform (`dissolveConditionals`) that runs in the same pipeline slot as `filterTargetBlocks`. Note that this makes dissolution work identically on both the template cloning and non-cloning paths.

### Task 4.2: Update TECHNICAL.md "Template Cloning Architecture → Region Handling" section 🟢

Remove or revise any implication that all conditionals produce region comment markers. Note that dissolvable conditionals are dissolved before template extraction, so their content appears as inline elements/text in the template — no comment markers, no `conditionalRegion` at runtime.

### Task 4.3: Update TECHNICAL.md "Design Decisions" section 🟢

Add a subsection "IR-Level Dissolution" explaining the design choice: dissolution as an IR transform (like `filterTargetBlocks`) rather than inline codegen logic. Reference the precedent and the correctness argument (walker/template-extraction never see dissolvable conditionals).

---

## Transitive Effect Analysis (Summary)

| Module | Effect | Risk |
|--------|--------|------|
| `ir.ts` | New export `dissolveConditionals` | None — additive |
| `transform.ts` | New call in pipeline, new import | Low — follows `filterTargetBlocks` pattern exactly |
| `codegen/dom.ts` | Removal of inline dissolution + dead code + unused import | Low — dissolution now upstream |
| `codegen/html.ts` | Free improvement — dissolved conditionals produce ternary interpolations instead of `if` blocks | None — no code changes in `html.ts` |
| `template.ts` | No changes — sees post-dissolution IR | None |
| `walk.ts` | No changes — sees post-dissolution IR | None |
| `collectRequiredImports` | Correctly omits `conditionalRegion` on `transformSource`/`transformFile` paths; may include unused `conditionalRegion` import on `transformSourceInPlace` path (benign) | None — see Learnings §1 |
| `tree-merge.test.ts` | No changes — tests `mergeConditionalBodies` directly | None |
| `dom.test.ts` | Existing dissolution tests still pass (dissolution happens earlier in pipeline) | Verify |
| `integration.test.ts` | End-to-end compilation tests catch any regressions | Verify |

---

## Resources for Implementation Context

| File | Relevance |
|------|-----------|
| `src/compiler/ir.ts` — `filterTargetBlocks` (L1507–1515), `filterChildren` (L1520–1540), `filterChildNode` (L1545–1582) | Structural precedent to follow exactly |
| `src/compiler/ir.ts` — `mergeConditionalBodies` (L1118–1206), `mergeNode` (L939–1104), `mergeContentValue` (L822–926) | Core merge logic (already implemented, just call it) |
| `src/compiler/ir.ts` — `createElement` (L1266–1302) | Correctly recomputes `isReactive` for merged elements |
| `src/compiler/ir.ts` — `ConditionalNode` (L530–546), `ConditionalBranch` (L496–509), `ChildNode` (L631–638), `BuilderNode` (L656–681) | Types involved |
| `src/compiler/transform.ts` — `transformSourceInPlace` (L431–540) | Primary pipeline insertion point (Vite/cloning path) |
| `src/compiler/transform.ts` — `transformSource` (L617–672), `transformFile` (L683–726) | Secondary pipeline insertion points (non-cloning path) |
| `src/compiler/codegen/dom.ts` — `generateConditional` (L814–881) | Inline dissolution to remove |
| `src/compiler/codegen/dom.ts` — `generateConditionalWithMarker` (L1192–1247) | Dead dissolution to remove |
| `src/compiler/codegen/dom.ts` — import line L29 | `mergeConditionalBodies` import to remove |
| `src/compiler/codegen/dom.ts` — `generateDOMWithCloning` (L1261–1313) | Template cloning entry point (reads post-dissolution IR) |
| `src/compiler/codegen/dom.ts` — `generateHoleSetup` (L1001–1148) | Handles region holes → `generateConditionalWithMarker`; dissolved nodes never reach here |
| `src/compiler/ir.test.ts` | Where to add `dissolveConditionals` tests |
| `src/compiler/codegen/dom.test.ts` | Where to add cloning-path integration test (Task 1.3) |
| `src/compiler/tree-merge.test.ts` | Existing merge tests (don't modify) |
| `src/compiler/walk.ts` — `walkConditional` | Unconditionally emits `regionPlaceholder`; post-dissolution, never sees dissolved nodes |
| `src/compiler/template.ts` — `extractTemplate`, `processEvent` | Template extraction; post-dissolution, no region markers for dissolved nodes |
| `TECHNICAL.md` L118–169 (Tree Merge), L1067–1104 (Region Handling) | Sections to update |

## Alternatives Considered

**Option A: Dissolution in `generateHoleSetup` (runtime DOM surgery).** When dissolution succeeds on the cloning path, use `nodeRef.parentNode` to insert dissolved elements and remove comment markers. Rejected because: (1) the template HTML and generated code would be semantically inconsistent (template says "region" but code says "not a region"), (2) the walk plan's child-index assumptions could break when dissolved content changes the parent's child count, (3) it's effectful compensation for a problem that should be solved by getting the data right in the first place.

**Option B: Make the walker dissolution-aware.** Teach `walkConditional` to attempt dissolution and yield element/content events instead of `regionPlaceholder`. Rejected because: the walker's responsibility is structural traversal, not optimization. Adding dissolution logic there violates separation of concerns and makes the walker harder to reason about. The walker should see clean data.

**Chosen: Option C — IR-level transform.** Follows the `filterTargetBlocks` precedent exactly. Dissolution is a pure data transformation, trivially testable, and invisible to all downstream consumers. The walker, template extraction, codegen, and import collection all "just work" because they never see dissolvable conditionals.

## Learnings

### §1: `collectRequiredImports` timing in `transformSourceInPlace`

In `transformSourceInPlace`, `collectRequiredImports` runs at L475 — **before** `filterTargetBlocks` (L497) and before where dissolution would be inserted. This means the import set is computed from the pre-transform IR. Dissolved conditionals will still contribute `conditionalRegion` to the import set as an unused import.

This is **benign and consistent with existing behavior**: `filterTargetBlocks` also runs after import collection, meaning target blocks that get stripped can leave unused imports. The architecture accepts this tradeoff — computing imports from the raw IR is simpler than introducing a second import-collection pass after transforms.

A future optimization could move `collectRequiredImports` to after all IR transforms, but that's out of scope for this plan.

### §2: `createElement` recomputes `isReactive` for merged elements

When `mergeNode` produces a merged element, it calls `createElement` (L1071–1079 of `ir.ts`), which recomputes `isReactive` from the merged attributes and children. The merged ternary `ContentValue` nodes have `bindingTime: "reactive"`, so `isReactiveContent` returns true → merged elements are correctly marked reactive. This is confirmed in the code and does not require any special handling.

### §3: Transform path topology

| Transform function | Codegen path | Template cloning? | Import handling |
|----|----|----|-----|
| `transformSourceInPlace` | `generateElementFactoryWithResult` → `generateDOMWithCloning` | **Yes** | `collectRequiredImports` on pre-transform IR (may include unused imports) |
| `transformSource` | `generateDOMOutput` → `generateElementFactory` → `generateDOM` | No | `generateDOMImports` → `collectRequiredImports` on post-transform IR (correct) |
| `transformFile` | Same as `transformSource` | No | Same as `transformSource` |

The Vite plugin uses `transformSourceInPlace` — this is the production-critical path and the primary beneficiary of this plan.

### §4: No existing test covers dissolution on the cloning path

Existing dissolution tests in `dom.test.ts` (L970–1035) call `generateDOM` (non-cloning). Integration tests in `integration.test.ts` (L1291–1311) call `transformSource` (also non-cloning). No test calls `generateElementFactoryWithResult` with a dissolvable conditional. Task 1.3 fills this gap.

### §5: The `transforms/` directory is empty

`src/compiler/transforms/` exists but is empty. `dissolveConditionals` should go in `ir.ts` alongside `filterTargetBlocks`, following the established pattern.

---

## PR Stack Context

This plan replaces Phase 3 of the parent plan (`kinetic-consolidation-audit.md`). The PR for this work is:

> **PR 3: `feat: IR-level conditional dissolution for template cloning path`**
>
> Depends on PR 2 (codegen dedup) only if `generateConditionalWithMarker` is being modified in PR 2. If PR 2 merges the conditional codegen functions first, Phase 3 of this plan removes code from the unified function instead. If this PR lands first, Phase 3 removes code from `generateConditionalWithMarker` directly, and PR 2's merge is a subsequent cleanup.
>
> These two PRs are **order-independent** — either can land first without conflict, because this PR removes dissolution logic from codegen while PR 2 merges codegen functions. The two changes touch different lines.