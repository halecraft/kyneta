# Kinetic Consolidation Audit

## Background

Kinetic's rapid prototype development has produced 804 passing tests and a genuinely sound algebra (binding-time lattice, delta kind orthogonality, FC/IS discipline). However, the velocity has introduced duplicated predicates, asymmetric codegen paths, type-safety holes, and structural redundancies that create divergence risk. This plan consolidates those findings into actionable work.

The audit identified issues across three priority tiers. All changes are internal refactors — no public API changes, no new features.

> **Status:** Phases 1 and 3 are complete. Phase 1 extracted shared predicates (PR 1). Phase 3 implemented IR-level dissolution (PR 3). See `.plans/kinetic-ir-dissolution.md`. Test count is now 932. Research audit completed — corrections applied to Tasks 4.1, 5.1, 6.4, 6.5; new learnings §4–§8 added.

## Problem Statement

1. **Predicate duplication**: The "is this an inputTextRegion candidate?" check appears 4 times across 3 files with subtle variant differences. A similar "is this a textRegion content node?" check appears twice. These will diverge.
2. **Codegen path duplication**: `generateReactiveLoop` and `generateReactiveLoopWithMarker` are ~95% identical (same for the conditional pair). Copy-paste with one parameter changed.
3. **Algebraic gap**: Conditional dissolution works on the `createElement` codegen path but is abandoned on the template cloning path, producing semantically different output for the same IR.
4. **Type-safety holes**: Loro binding functions accept `unknown`, use `as` casts, and probe with conditions that are always true (e.g., `typeof x.toString === "function"`).
5. **Transform entry point duplication**: Three transform functions share ~70% structure with copy-pasted parse/analyze/codegen loops.
6. **Runtime/compile-time slot kind mismatch**: `claimSlot` can produce a slot kind that contradicts the compile-time `SlotKind` hint.
7. **Near-identical region functions**: `textRegion` and `inputTextRegion` share the same 3-phase pattern with only the DOM target differing.
8. **HTML escape helper drift**: `generateEscapeHelper()` hard-codes an escape map as a string that can drift from `html-constants.ts`.
9. **Minor hygiene**: deprecated-but-used `generateBranchBody`, dead-code `_reportMismatch` (defined but never called), mutable `activeSubscriptions` export.

## Success Criteria

- All inputTextRegion/textRegion candidate predicates exist in exactly one place each
- `generateReactiveLoop` and `generateReactiveLoopWithMarker` are unified (same for conditional pair)
- Template cloning path attempts conditional dissolution before falling back to `conditionalRegion`
- Loro binding functions use discriminated dispatch instead of structural duck-typing
- Transform entry points share a common analysis helper
- `claimSlot` behavior is documented and consistent with compile-time hints
- All existing 932 tests continue to pass
- TECHNICAL.md updated to reflect architectural corrections

## Gap

The gap is between "working prototype with known duplication" and "consolidated prototype ready for the next feature phase." No new capabilities are added — this is purely about reducing divergence risk, improving type safety, and closing algebraic gaps.

---

## Phase 1: Extract Shared Predicates 🟢

The highest-risk duplication. These predicates gate codegen dispatch and import collection — if they diverge, the compiler emits wrong imports or wrong subscription code.

### Task 1.1: Extract `isTextRegionContent` predicate into `ir.ts` 🟢

Add a pure predicate to `ir.ts` that checks whether a `ContentValue` qualifies for `textRegion` optimization:

```typescript
function isTextRegionContent(node: ContentValue): boolean
```

The condition: `node.bindingTime === "reactive" && !!node.directReadSource && node.dependencies.length === 1 && node.dependencies[0].deltaKind === "text"`.

Replace usages in:
- `codegen/dom.ts` → `generateReactiveContentSubscription` (L193–197)
- `transform.ts` → `collectRequiredImports` content check (L275–278)

### Task 1.2: Extract `isInputTextRegionAttribute` predicate into `ir.ts` 🟢

Add a pure predicate:

```typescript
function isInputTextRegionAttribute(attr: AttributeNode): boolean
```

The condition: `attr.name === "value" && isTextRegionContent(attr.value)`.

Replace usages in:
- `codegen/dom.ts` → `isInputTextRegionCandidate` (L301–309) — replace body, keep function as thin wrapper or remove entirely
- `codegen/dom.ts` → `generateHoleSetup` inline check (L1047–1052)
- `transform.ts` → `collectRequiredImports` attribute check (L261–265)

### Task 1.3: Tests 🟢

Add unit tests in `ir.test.ts`:
- `isTextRegionContent` returns true for qualifying ContentValue, false for non-text deltaKind, false for missing directReadSource, false for multiple dependencies
- `isInputTextRegionAttribute` returns true for `value` attribute wrapping a textRegion content, false for non-`value` attributes, false for non-qualifying content

### Transitive Effects

- `codegen/dom.ts` imports from `ir.ts` (already does)
- `transform.ts` imports from `ir.ts` (already does)
- No new cross-module dependencies introduced
- All existing codegen tests and transform tests exercise these paths and must continue passing

---

## Phase 2: Unify Duplicated Codegen Functions 🔴

### Task 2.1: Merge `generateReactiveLoop` and `generateReactiveLoopWithMarker` 🔴

These two functions differ only in the first argument to the emitted `listRegion(...)` call. Merge into a single function:

```typescript
function generateReactiveLoopBody(
  node: LoopNode,
  mountVar: string,  // either parentVar or markerVar
  state: CodegenState,
): string[]
```

Delete `generateReactiveLoopWithMarker`. Update call sites:
- `generateChild` → `case "loop"` passes `parentVar`
- `generateHoleSetup` → `case "region"` loop branch passes `nodeRef`

### Task 2.2: Merge `generateConditional` marker-based path and `generateConditionalWithMarker` 🔴

> **Updated after Phase 3:** Inline dissolution has been removed from both functions. They are now even more similar — both emit `conditionalRegion(...)` with the only differences being: (1) `generateConditional` creates its own marker variable and appends it to a parent, while `generateConditionalWithMarker` receives a pre-existing marker; (2) `generateConditional` has a render-time dispatch guard.

Extract the shared `conditionalRegion(...)` emission into a helper:

```typescript
function generateConditionalRegionCall(
  node: ConditionalNode,
  markerVar: string,
  state: CodegenState,
): string[]
```

`generateConditional` creates its own marker variable, then delegates to this helper. `generateConditionalWithMarker` delegates directly. The render-time dispatch remains in `generateConditional` as the outer dispatch layer.

### Task 2.2a: Remove `isInputTextRegionCandidate` thin wrapper 🔴

After Phase 1, `isInputTextRegionCandidate` is now a trivial wrapper: `return isInputTextRegionAttribute(attr)`. Its two call sites (`generateAttributeSet`, `generateAttributeSubscription`) should call `isInputTextRegionAttribute` directly. Remove the wrapper function and its JSDoc.

### Task 2.3: Remove deprecated `generateBranchBody` wrapper 🔴

`generateBranchBody` is a trivial wrapper: `return generateBodyWithReturn(body, state)`. Replace the 4 call sites (2 in `generateConditional`, 2 in `generateConditionalWithMarker`) with direct `generateBodyWithReturn` calls. Remove the wrapper function.

### Task 2.4: Tests 🔴

Existing `dom.test.ts` tests cover reactive loops and conditionals extensively. Run the full suite to verify no regressions. No new tests needed — this is a pure refactor with identical output.

### Transitive Effects

- `generateHoleSetup` calls the loop/conditional generators → must use new signatures
- `generateChild` calls the loop/conditional generators → must use new signatures
- Template cloning path and non-cloning path now share code → any future fix applies to both
- `integration.test.ts` exercises compiled output end-to-end → catches output drift

---

## Phase 3: IR-Level Conditional Dissolution 🟢

> **Sub-plan:** See `.plans/kinetic-ir-dissolution.md` for full details.
>
> **Complete.** All 4 phases of the sub-plan are done (dissolveConditionals transform, pipeline wiring, codegen cleanup, documentation). 923 tests passing.

Dissolution is moved from inline codegen logic to a pure IR→IR transform (`dissolveConditionals`), following the `filterTargetBlocks` precedent. This replaces the original Phase 3 approach (DOM surgery in `generateHoleSetup`) which had correctness risks around walk-plan child-index assumptions.

### Task 3.1: Add `dissolveConditionals` IR transform in `ir.ts` 🟢

Pure recursive transform: walks the IR tree, attempts `mergeConditionalBodies` on eligible `ConditionalNode`s (reactive + has else branch), splices merged `ChildNode[]` in place of dissolved conditionals. Non-dissolvable conditionals are left unchanged. Follows the exact structural pattern of `filterTargetBlocks` / `filterChildren` / `filterChildNode`.

### Task 3.2: Wire into transform pipeline in `transform.ts` 🟢

Call `dissolveConditionals` immediately after `filterTargetBlocks` in all three transform entry points (`transformSourceInPlace`, `transformSource`, `transformFile`).

### Task 3.3: Remove inline dissolution from `codegen/dom.ts` 🟢

Remove the `mergeConditionalBodies` attempt in `generateConditional` and the dead dissolution attempt in `generateConditionalWithMarker`. Remove the now-unused `mergeConditionalBodies` import from `codegen/dom.ts`.

### Task 3.4: Tests 🟢

Unit tests for `dissolveConditionals` in `ir.test.ts`: positive cases (2-branch, 3-branch, nested), negative cases (render-time, no else, different tags), edge case (mixed dissolvable + non-dissolvable). Integration tests for the template cloning path. All 923 tests pass (16 new).

### Task 3.5: Update TECHNICAL.md 🟢

Updated "Tree Merge and Conditional Dissolution", "Template Cloning → Region Handling", and added "IR-Level Dissolution" design decision.

### Transitive Effects

- `collectRequiredImports` correctly omits `conditionalRegion` for dissolved conditionals in `transformSource`/`transformFile` — dissolved nodes are no longer `ConditionalNode` in the IR, so the `child.kind === "conditional"` check never fires for them. **However**, `transformSourceInPlace` calls `collectRequiredImports` before dissolution (see Task 5.5), so it may add an unnecessary `conditionalRegion` import for fully-dissolvable files.
- `extractTemplate` / `walkIR` see post-dissolution IR — dissolved content appears as regular elements/content, producing correct template HTML without comment markers
- HTML codegen benefits for free — dissolved conditionals produce ternary interpolations instead of `if` blocks
- No changes needed in `walk.ts`, `template.ts`, `codegen/html.ts`, or `regions.ts`
- Phase 2's Task 2.2 is now simpler — inline dissolution is already gone from both conditional codegen functions

---

## Phase 4: Improve Loro Binding Type Safety 🔴

### Task 4.1: Replace duck-typing in `bindTextValue` with specific checks 🔴

The current `typeof (loroContainer as LoroText).toString === "function"` is always true for **any** object (every object inherits `toString` from `Object.prototype`). This means the `getValue` closure never reaches the `String(loroContainer)` fallback — non-LoroText containers (LoroList, LoroMap, etc.) would silently get their inherited `toString()` called instead of producing an error. The check is completely inert as a discriminator.

Replace with a check for LoroText-specific behavior:

```typescript
if (typeof (loroContainer as LoroText).insert === "function") {
  // This is a LoroText — use .toString()
  return (loroContainer as LoroText).toString()
}
```

This correctly discriminates LoroText from other container types. Non-LoroText containers will now fall through to the `String(loroContainer)` path (or a future explicit error), instead of silently mishandling.

### Task 4.2: Replace duck-typing in `bindChecked` and `bindNumericValue` with narrower checks 🔴

Both `bindChecked` and `bindNumericValue` have an inconsistency: the `getValue` closure uses a loose `.value` property check to detect LoroCounter, but the `handleChange`/`handleInput` handler in the same function uses a stricter `.increment` check. The detection logic should be consistent within each function. Additionally, `.value` is common across many types.

For both functions, unify the LoroCounter detection to require both `.increment` and `.value`:

```typescript
const isCounter = typeof (loroContainer as { increment?: Function }).increment === "function"
  && typeof (loroContainer as { value?: number }).value === "number"
```

Use the `isCounter` flag in both the `getValue` closure and the event handler, eliminating the inconsistency.

### Task 4.3: Add JSDoc warnings about the `unknown` boundary 🔴

Each binding function's `ref: unknown` parameter is intentional (compiled code passes opaque refs). Add a clear doc comment explaining the boundary: "This function operates at the `unknown` boundary because compiled code passes refs without static type information. Runtime dispatch is used to determine the container type."

### Task 4.4: Tests 🔴

The existing `binding.test.ts` and `edit-text.test.ts` cover the happy paths. Add one negative test per binding function verifying that passing a non-Loro value throws a clear error (from the `subscribe` call's reactive validation) rather than silently misbehaving.

### Transitive Effects

- `bindTextValue`, `bindChecked`, `bindNumericValue` are called by compiled code → signature unchanged, behavior unchanged for valid inputs
- `loro()` unwrapper from `@loro-extended/change` is the first line of each function and already validates the input → our changes are in the post-unwrap logic

---

## Phase 5: Consolidate Transform Entry Points 🔴

### Task 5.1: Extract shared `analyzeFile` helper 🔴

`transformSource` and `transformFile` repeat: find calls → iterate → try/catch analyze → collect `BuilderNode[]`. Extract:

```typescript
function analyzeAllBuilders(
  sourceFile: SourceFile,
  filename: string,
): Array<{ call: CallExpression; ir: BuilderNode }>
```

This function encapsulates the find-analyze-error-wrap loop and returns `{ call, ir }` pairs. `transformSourceInPlace` uses the pairs directly (needs `call` for position-based AST replacement). `transformSource`/`transformFile` map to just the IR: `.map(r => r.ir)`.

### Task 5.2: Unify `transformSource` and `transformFile` 🔴

`transformFile` is `transformSource` but skipping the parse step. Make `transformSource` parse and delegate to `transformFile`:

```typescript
export function transformSource(source: string, options: TransformOptions = {}): TransformResult {
  const sourceFile = parseSource(source, options.filename ?? "input.ts")
  return transformFile(sourceFile, options)
}
```

This eliminates the duplicated codegen dispatch logic entirely.

### Task 5.3: Extract shared analysis loop for `transformSourceInPlace` 🔴

Replace the inline analysis loop with a call to `analyzeAllBuilders` (which now returns `{ call, ir }` pairs — see Task 5.1). The replacement-tracking logic (sorting by position, back-to-front replacement) stays in `transformSourceInPlace` since it's unique to the in-place path.

### Task 5.4: Harden `hasBuilderCalls` cleanup with `finally` 🔴

Replace the nested try-catch cleanup pattern with a single try-finally:

```typescript
try {
  const sourceFile = parseSource(source, "check.ts")
  const calls = findBuilderCalls(sourceFile)
  return calls.length > 0
} finally {
  const project = getProject()
  const checkFile = project.getSourceFile("check.ts")
  if (checkFile) project.removeSourceFile(checkFile)
}
```

### Task 5.5: Fix `collectRequiredImports` ordering in `transformSourceInPlace` 🔴

Currently `collectRequiredImports(ir)` is called **before** `filterTargetBlocks` and `dissolveConditionals` in `transformSourceInPlace`. This means it runs on pre-dissolution IR and may add a `conditionalRegion` import for conditionals that will be dissolved away. The import is harmless at runtime (tree-shaking or bundler will remove it), but it's semantically wrong.

Move the `collectRequiredImports` call to **after** the `filterTargetBlocks` + `dissolveConditionals` loop, so it sees the final IR. This is a natural fix during the Task 5.3 refactor.

### Task 5.6: Tests 🔴

Existing `transform.test.ts` covers all three entry points. Run the full suite. No new tests needed — this is a pure refactor. Optionally add a test verifying that `collectRequiredImports` on post-dissolution IR omits `conditionalRegion` when all conditionals are dissolvable.

### Transitive Effects

- `transformSourceInPlace` is the Vite plugin entry point → must preserve its `TransformInPlaceResult` return type exactly
- `transformSource` is used by tests and CLI → must preserve its `TransformResult` return type
- `transformFile` is used by tests that already have a `SourceFile` → unchanged signature
- `hasBuilderCalls` is used by the Vite plugin for quick-skip → unchanged signature and behavior
- `collectRequiredImports` ordering fix (Task 5.5) may change which imports are emitted for fully-dissolvable files — harmless but verifiable

---

## Phase 6: Low-Priority Cleanup 🔴

### Task 6.1: Document `claimSlot` runtime/compile-time kind behavior 🔴

Add a JSDoc comment to `claimSlot` explaining that the runtime may produce a slot of a different kind than the compile-time hint when the hint is overly conservative (e.g., `slotKind: "range"` but fragment has 0 or 1 children). This is intentional — the runtime always produces the minimal slot, and the hint is an optimization for the common case. Document this in TECHNICAL.md under "Region Algebra → The Trackability Invariant."

### Task 6.2: Parameterize `textRegion` / `inputTextRegion` (optional) 🔴

Extract the shared 3-phase pattern into a factory function:

```typescript
function createDeltaTextRegion<T>(
  init: (target: T, value: string) => void,
  patch: (target: T, ops: TextDeltaOp[]) => void,
  fallback: (target: T, value: string) => void,
): (target: T, ref: unknown, scope: Scope) => void
```

Then:
```typescript
export const textRegion = createDeltaTextRegion<Text>(
  (t, v) => { t.textContent = v },
  patchText,
  (t, v) => { t.textContent = v },
)
export const inputTextRegion = createDeltaTextRegion<HTMLInputElement | HTMLTextAreaElement>(
  (t, v) => { t.value = v },
  patchInputValue,
  (t, v) => { t.value = v },
)
```

This is low priority because the current duplication is only two instances and unlikely to diverge. Do this only if a third variant (e.g., `contentEditableTextRegion`) is planned.

### Task 6.3: Align `generateEscapeHelper` with `html-constants.ts` 🔴

Add a comment at the top of `generateEscapeHelper()` cross-referencing `html-constants.ts` and noting that changes to the escape map must be synchronized. Alternatively, generate the function body programmatically from the same `HTML_ESCAPE_MAP` constant — but this adds complexity for minimal benefit at prototype stage.

### Task 6.4: Remove or wire up `_reportMismatch` in `hydrate.ts` 🔴

`_reportMismatch` is **dead code** — it is defined but has zero call sites anywhere in the codebase. The underscore prefix was likely intended to mark it as "not yet wired up" rather than "private."

Options:
- **(a) Remove it entirely.** It's dead code. If hydration mismatch reporting is needed later, it can be re-added with call sites.
- **(b) Wire it up.** The `hydrate()`, `hydrateListRegion()`, and `hydrateConditionalRegion()` functions could call it for mismatch cases (e.g., `items.length !== children.length` in `hydrateListRegion`). This would make hydration error reporting functional.

Prefer (a) unless hydration is being actively developed. If kept, rename to `reportMismatch` (drop the underscore).

### Task 6.5: Make `activeSubscriptions` read-only in the public API 🔴

Export a `getActiveSubscriptions(): ReadonlyMap<...>` function from `subscribe.ts` instead of the raw mutable Map. The `/testing` subpath can still import the mutable version directly for `.clear()` in `beforeEach`.

> **Note:** There are **two** files that re-export `activeSubscriptions`: `src/testing/index.ts` (L32–36) and `src/testing/runtime.ts` (L33–37). Both must be updated to continue exporting the mutable version for test cleanup.

### Task 6.6: Tests 🔴

- Task 6.2: Existing `text-patch.test.ts` tests cover both functions — run to verify
- Task 6.4: Removal of dead code — no test changes (no call sites exist)
- Task 6.5: Update any test that reads `activeSubscriptions.size` to use the getter (if the mutable import path changes)

### Transitive Effects

- Task 6.2: `runtime/index.ts` re-exports `textRegion` and `inputTextRegion` → re-exports unchanged
- Task 6.4: `_reportMismatch` is dead code with no call sites → removal has zero external impact; wiring up would affect hydration behavior
- Task 6.5: Both `testing/index.ts` and `testing/runtime.ts` export `activeSubscriptions` → both must continue to export the mutable version for test cleanup

---

## Phase 7: Documentation Updates 🔴

### Task 7.1: Update TECHNICAL.md 🔴

Sections to update:
- **"Region Algebra → The Trackability Invariant"**: Add note about runtime slot kind potentially differing from compile-time hint (Task 6.1)
- ~~**"Template Cloning Architecture → Region Handling"**: Document that conditional dissolution now works on the template cloning path (Task 3.3)~~ — **Done in Phase 3**
- **"Design Decisions"**: Add a new subsection "Shared Predicate Functions" explaining that codegen dispatch predicates (`isTextRegionContent`, `isInputTextRegionAttribute`) live in `ir.ts` as the single source of truth
- ~~**"Design Decisions" → "IR-Level Dissolution"**: Explain the IR transform design choice~~ — **Done in Phase 3**
- **"Runtime Dependencies → Loro Bindings Subpath"**: Note the runtime dispatch strategy for binding functions and the `unknown` boundary rationale

### Task 7.2: Update file structure section 🔴

The file structure section in TECHNICAL.md should reflect that `ir.ts` now exports predicate functions used by both codegen and transform.

---

## PR Stack

The 7 plan phases collapse into **5 PRs** ordered by dependency. Phases 1, 4, 5 are independent and can land in any order. Phase 2→3 is a chain (prep refactor → behavior change). Phase 6+7 are a trailing cleanup batch.

> **Status:** PRs 1 and 3 are complete. PR 2 now operates on simpler post-dissolution code (the functions it merges no longer contain dissolution logic) and can also remove the `isInputTextRegionCandidate` thin wrapper left by PR 1. PRs 2, 4, 5 remain.

### PR 1: `refactor: extract shared codegen predicates into ir.ts` 🟢

> Plan Phase 1 (Tasks 1.1–1.3)
>
> **Complete.** 9 new tests, 932 total passing.

**Type:** Mechanical refactor (extract + migrate call sites)

- Add `isTextRegionContent()` and `isInputTextRegionAttribute()` to `ir.ts`
- Replace 5 inline predicate copies in `codegen/dom.ts` and `transform.ts`
- `isInputTextRegionCandidate` remains as a thin wrapper (removal deferred to PR 2, Task 2.2a)
- Add predicate unit tests in `ir.test.ts`
- **Files:** `ir.ts`, `ir.test.ts`, `codegen/dom.ts`, `transform.ts`
- **Validates:** all 932 tests pass, no codegen output change

### PR 2: `refactor: unify duplicated codegen loop/conditional functions` 🔴

> Plan Phase 2 (Tasks 2.1–2.4)

**Type:** Mechanical refactor (merge near-identical functions + remove thin wrappers)

- Merge `generateReactiveLoop` + `generateReactiveLoopWithMarker` → `generateReactiveLoopBody`
- Extract `generateConditionalRegionCall` shared helper; `generateConditional` and hole-setup path both delegate to it
- Remove thin wrapper `isInputTextRegionCandidate` (now just delegates to `isInputTextRegionAttribute` from Phase 1)
- Remove thin wrapper `generateBranchBody` (now just delegates to `generateBodyWithReturn`)
- **Files:** `codegen/dom.ts`
- **Validates:** all existing `dom.test.ts` + `integration.test.ts` pass with identical output
- **Why separate from PR 3:** This is a zero-behavior-change refactor. PR 3 adds behavior (dissolution). Keeping them separate means PR 2 can be reviewed as "trust the mechanical diff" and reverted independently.
- **Note:** PR 3 has already landed. The conditional functions no longer contain dissolution logic, making the merge in Task 2.2 cleaner.

### PR 3: `feat: IR-level conditional dissolution` 🟢

> Plan Phase 3 (Tasks 3.1–3.5). Sub-plan: `.plans/kinetic-ir-dissolution.md`
>
> **Complete.** Implemented as 4 commits: IR transform, pipeline wiring, codegen cleanup, documentation. 923 tests passing (16 new).

**Type:** Behavior change (performance optimization) + code removal

- **Order-independent** with PR 2 — touches different lines in `codegen/dom.ts` (PR 2 merges functions, PR 3 removes dissolution logic from within them). PR 3 landed first; PR 2 now operates on simpler post-dissolution code.
- Add `dissolveConditionals` IR→IR transform in `ir.ts` (follows `filterTargetBlocks` precedent)
- Wire into transform pipeline after `filterTargetBlocks` in `transform.ts`
- Remove inline dissolution from `generateConditional` and dead dissolution from `generateConditionalWithMarker` in `codegen/dom.ts`
- Add `dissolveConditionals` unit tests in `ir.test.ts` + integration tests in `dom.test.ts` + pipeline test in `transform.test.ts`
- Update TECHNICAL.md
- **Files:** `ir.ts`, `ir.test.ts`, `transform.ts`, `transform.test.ts`, `codegen/dom.ts`, `codegen/dom.test.ts`, `TECHNICAL.md`
- **Validates:** 16 new tests + all existing 907 tests pass → 923 total

### PR 4: `fix: Loro binding type safety + transform consolidation` 🔴

> Plan Phases 4 + 5 (Tasks 4.1–4.4, 5.1–5.6)

**Type:** Fix + refactor (two independent domains, no cross-dependency)

These are batched because they are both medium-priority internal improvements with no overlap in files touched. Neither is large enough alone to justify a separate review cycle.

**Loro bindings (Phase 4):**
- Replace always-true `toString` check with `insert`-based LoroText detection (fixes silent mishandling of non-LoroText containers)
- Narrow LoroCounter detection in both `bindChecked` and `bindNumericValue` to require both `.increment` and `.value`; unify detection between `getValue` and event handler within each function
- Add JSDoc boundary documentation
- Add negative tests for non-Loro values
- **Files:** `src/loro/binding.ts`, `src/loro/binding.test.ts`

**Transform consolidation (Phase 5):**
- Extract `analyzeAllBuilders()` shared helper (returns `{ call, ir }` pairs)
- Make `transformSource` delegate to `transformFile`
- Use `analyzeAllBuilders` in `transformSourceInPlace`
- Replace nested try-catch in `hasBuilderCalls` with try-finally
- Fix `collectRequiredImports` ordering: call after dissolution, not before
- **Files:** `src/compiler/transform.ts`
- **Validates:** all existing transform + binding tests pass

### PR 5: `docs: consolidation cleanup + TECHNICAL.md updates` 🔴

> Plan Phases 6 + 7 (Tasks 6.1–6.6, 7.1–7.2)

**Type:** Docs + hygiene (no behavior changes)

- Document `claimSlot` runtime/compile-time slot kind divergence (JSDoc + TECHNICAL.md)
- Parameterize `textRegion`/`inputTextRegion` via `createDeltaTextRegion` factory (optional — skip if no third variant is planned)
- Add cross-reference comment in `generateEscapeHelper` → `html-constants.ts`
- Remove dead-code `_reportMismatch` from `hydrate.ts` (or wire it up if hydration is being actively developed)
- Export `getActiveSubscriptions(): ReadonlyMap` from `subscribe.ts`; keep mutable version in both `/testing` re-export files (`testing/index.ts`, `testing/runtime.ts`)
- TECHNICAL.md: shared predicates design decision, file structure update, Loro binding boundary rationale
- **Files:** `text-patch.ts`, `regions.ts`, `subscribe.ts`, `hydrate.ts`, `codegen/html.ts`, `testing/index.ts`, `testing/runtime.ts`, `TECHNICAL.md`
- **Validates:** all tests pass (some test imports may update for `activeSubscriptions` getter)

### Dependency Graph

```
PR 1 (predicates) ✅ DONE ─────────────────────────┐
PR 2 (codegen dedup) ───────────────────────────────┤
PR 3 (IR dissolution) ✅ DONE ─────────────────────┤
PR 4 (bindings + transform) ────────────────────────┤
                                                    └─── PR 5 (cleanup + docs)
```

PRs 1 and 3 are complete. PR 2 and PR 4 can land in parallel. PR 5 waits on all others (docs reference outcomes of prior PRs).

---

## Resources for Implementation Context

When implementing each phase, include these files in context:

| Phase | Files |
|-------|-------|
| 1 | `src/compiler/ir.ts`, `src/compiler/codegen/dom.ts`, `src/compiler/transform.ts`, `src/compiler/ir.test.ts` |
| 2 | `src/compiler/codegen/dom.ts`, `src/compiler/codegen/dom.test.ts` |
| 3 | `src/compiler/codegen/dom.ts`, `src/compiler/ir.ts` (mergeConditionalBodies), `src/compiler/template.ts`, `src/compiler/codegen/dom.test.ts`, `TECHNICAL.md` |
| 4 | `src/loro/binding.ts`, `src/loro/edit-text.ts`, `src/loro/binding.test.ts` |
| 5 | `src/compiler/transform.ts`, `src/compiler/transform.test.ts`, `src/compiler/analyze.ts` |
| 6 | `src/runtime/text-patch.ts`, `src/runtime/regions.ts`, `src/runtime/subscribe.ts`, `src/runtime/hydrate.ts`, `src/compiler/codegen/html.ts`, `src/compiler/html-constants.ts` |
| 7 | `TECHNICAL.md` |

## Learnings

### §1: Phase 1 leaves thin wrappers that Phase 2 should clean up

After Phase 1 extracted `isInputTextRegionAttribute` into `ir.ts`, the local `isInputTextRegionCandidate` in `codegen/dom.ts` became a trivial wrapper (`return isInputTextRegionAttribute(attr)`). Similarly, `generateBranchBody` was already a trivial wrapper around `generateBodyWithReturn`. Phase 2 should remove both wrappers as part of its "unify codegen functions" scope. Added as Task 2.2a.

### §2: `analyzeAllBuilders` can't serve `transformSourceInPlace` as-is — **resolved in Task 5.1**

The plan originally assumed `analyzeAllBuilders` returns `BuilderNode[]`, which works for `transformSource`/`transformFile`. But `transformSourceInPlace` needs `{ call: CallExpression, ir: BuilderNode }[]` — the `call` reference is required for position-based AST replacement. **Resolution:** Task 5.1 now specifies that `analyzeAllBuilders` returns `{ call, ir }` pairs, with callers that only need IR mapping away the calls via `.map(r => r.ir)`.

### §3: Test count progression

| Milestone | Test count |
|-----------|-----------|
| Original audit baseline | 804 |
| Pre-dissolution (after other work) | 907 |
| After Phase 3 (dissolution) | 923 |
| After Phase 1 (predicates) | 932 |

### §4: `_reportMismatch` is dead code, not misnamed

The original audit stated "_reportMismatch is used, the underscore prefix is misleading." Research found that `_reportMismatch` has **zero call sites** in the entire codebase — it is defined but never called. The correct action is removal (or wiring it up into `hydrateListRegion`/`hydrateConditionalRegion` if hydration mismatch reporting is needed). Task 6.4 updated accordingly.

### §5: `bindTextValue`'s `toString` check is completely inert

The `typeof (loroContainer as LoroText).toString === "function"` check was described as "always true" in the original audit, but the consequence is worse than stated: because **every** JavaScript object inherits `toString` from `Object.prototype`, the `getValue` closure in `bindTextValue` can never reach its fallback path. Non-LoroText containers (LoroList, LoroMap) silently get `toString()` called instead of producing an error. Task 4.1 updated to reflect this.

### §6: `bindChecked` and `bindNumericValue` have internal detection inconsistency

Both functions use a loose `.value` check in their `getValue` closure but a stricter `.increment` check in their event handler. The detection strategy should be unified within each function. Task 4.2 expanded to cover `bindNumericValue` as well.

### §7: `collectRequiredImports` runs before dissolution in `transformSourceInPlace`

In `transformSourceInPlace`, `collectRequiredImports(ir)` is called before `filterTargetBlocks` and `dissolveConditionals`. This means it may add a `conditionalRegion` import for conditionals that will be dissolved. The import is harmless at runtime but semantically incorrect. Added as Task 5.5.

### §8: `activeSubscriptions` has two re-export paths in testing

Both `src/testing/index.ts` and `src/testing/runtime.ts` independently re-export `activeSubscriptions` from `../runtime/subscribe.js`. Task 6.5 must update both files if the export changes.

---

## Alternatives Considered

**Full predicate deduplication via an `ir-predicates.ts` module**: Rejected. The predicates are small and closely tied to IR types — putting them in `ir.ts` alongside the types they inspect is more discoverable than a separate file.

**Generating `__escapeHtml` from the `HTML_ESCAPE_MAP` constant**: Rejected for now. The benefit is marginal at prototype stage and the code generation would be harder to read. A cross-reference comment is sufficient. (Research confirmed the two escape maps are currently identical — no drift yet.)

**Making `claimSlot` fully trust the compile-time hint (skip runtime inspection)**: Rejected. The runtime inspection is a safety net for edge cases where the compile-time analysis is conservative. The current approach is correct — just underdocumented.

**Introducing a `ContainerKind` discriminator on Loro typed refs**: This would be the ideal long-term solution for Task 4, but it requires changes to `@loro-extended/change` and `loro-crdt` — out of scope for this consolidation pass. The improved duck-typing checks are sufficient for now.

**Unifying `textRegion`/`inputTextRegion` now**: Deferred to Task 6.2 as optional. Only two instances exist, and a third variant is not yet planned. The factory function adds indirection for minimal deduplication benefit.

**Moving IR transforms to `src/compiler/transforms/`**: The directory exists but is empty. Currently `dissolveConditionals` and `filterTargetBlocks` live in `ir.ts`. Not worth moving for two transforms, but worth noting if more are added.