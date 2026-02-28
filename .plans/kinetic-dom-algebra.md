# Plan: Kinetic DOM Algebra — Applicative/Monadic Decomposition

## Background

Through a series of explorations starting from `kinetic-patterns.md` and the `InsertionResult` work, we discovered a deep mathematical structure underlying Kinetic's compile-time and runtime handling of DOM content.

### The Original Observation

The codegen and runtime have parallel structures that both solve the same problem: **a body that produces DOM nodes must be trackable for later removal**. The codegen solves it at compile time (`checkCanOptimizeDirectReturn`), the runtime re-discovers it at execution time (`insertAndTrack` inspecting `nodeType`). This parallelism is a code smell — knowledge computed at compile time is discarded, forcing the runtime to re-derive it.

### The Allocation Insight

Analyzing how different IR node types behave at runtime reveals an analogy to memory allocation:

| Strategy | Node created by | Reference | Removal |
|----------|----------------|-----------|---------|
| **Fixed** | Codegen | None needed | Parent dies |
| **In-place** | Codegen | Direct (JS variable) | Parent dies |
| **Allocated** | Runtime handler | Indirect (Slot) | Explicit via Slot |

- **Fixed**: Static elements, text nodes. Created once, never change, never tracked.
- **In-place**: Reactive elements/expressions. The node is stable (codegen holds a direct variable reference), but content updates via subscriptions. No positional tracking needed.
- **Allocated**: List items, conditional branches. Nodes are created and destroyed by runtime handlers. The runtime doesn't have a compile-time variable for them — it needs an indirect handle (a **Slot**) to find and remove them later.

A Slot is the runtime cost of content whose identity isn't known at compile time. `SingleSlot` tracks one node; `RangeSlot` uses comment markers to delimit multiple nodes.

### The Applicative/Monadic Decomposition

This maps precisely to a well-known distinction from functional programming:

- **Applicative**: The *structure* is static (known at compile time); only *values* vary at runtime. A reactive expression like `span(doc.title.get())` has a fixed DOM shape (one `<span>` with one text node) — only the text content changes in place.

- **Monadic**: The *structure itself* varies at runtime. A list region adds/removes items; a conditional with structurally different branches swaps entirely different DOM trees.

The key optimization principle: **maximize the Applicative layer, minimize the Monadic layer**. Every piece of structure the compiler can prove is shared across branches can be hoisted out of the Monadic layer into the Applicative layer — created once and updated in-place rather than allocated and freed.

### Structural Hoisting via Tree Merge

Consider a conditional where both branches produce the same DOM shape:

```typescript
if (doc.isAdmin.get()) {
  span("Admin")
  span(doc.name.get())
} else {
  span("User")
  span(doc.name.get())
}
```

Today, a branch swap removes both spans and creates two new ones (fully Monadic). But the compiler can see that both branches have identical structure: two `<span>` elements. It can **merge** the two branch trees into a single tree where diverging values become conditional expressions:

```javascript
const _span0 = document.createElement("span")
const _span1 = document.createElement("span")
parent.appendChild(_span0)
parent.appendChild(_span1)
// Diverging text → conditional subscription:
__subscribeWithValue(doc.isAdmin, () => doc.isAdmin.get(), (v) => {
  _span0.textContent = v ? "Admin" : "User"
}, scope)
// Identical text → unconditional subscription (same in both branches):
__subscribeWithValue(doc.name, () => doc.name.get(), (v) => {
  _span1.textContent = v
}, scope)
```

The conditional region disappears entirely — no Slot, no markers, no remove/insert.

The key insight: **a dissolved conditional is not a new IR node type.** The IR already represents "a value that may vary" — `ExpressionNode` with `expressionKind: "reactive"`. A conditional at a value position is just a reactive expression whose source happens to be a ternary. The optimization pass merges two branch trees into one, synthesizing `ExpressionNode`s at points of divergence using existing IR types.

### Binding-Time Analysis

This is an instance of **binding-time analysis** from partial evaluation theory:

- **Literal**: Value known at compile time (e.g., `"Admin"`)
- **Render**: Value known at render time (e.g., `someVar`)
- **Reactive**: Value changes at runtime (e.g., `doc.title.get()`)

The current IR represents these three binding times across two separate types (`TextNode` for literals, `ExpressionNode` with `expressionKind` for render/reactive). Unifying them into a single `ContentValue` type with an explicit `bindingTime` field makes the binding-time structure visible in the type system and simplifies all downstream operations — codegen dispatches on one field instead of two types, and tree merge has a single mergeability check instead of combinatorial cross-cases.

The tree merge is then precisely **binding-time promotion**: a literal value gets promoted to reactive when it needs to vary based on a condition.

### Optimization Levels

| Level | Description | Slots needed |
|-------|-------------|-------------|
| **0** | No analysis. Every conditional/list is fully allocated. Runtime inspects `nodeType`. | Maximum |
| **1** | Annotate `SlotKind` at compile time. Runtime skips `nodeType` check. | Same count, faster |
| **2** | Full structural equivalence. Identical branches dissolve into in-place updates via tree merge. | Fewer (zero for identical branches) |
| **3** | Partial structural hoisting. Shared prefix promoted to Applicative; only differing residual remains Monadic. | Minimum |

This plan implements **Levels 0–2**. Level 3 (partial hoisting) is deferred to a future plan — the `mergeConditionalBodies` function provides the foundation, and partial hoisting is a generalization that can be assessed once Level 2 is in production.

## Problem Statement

**Foundation**: Kinetic already has binding-time analysis via the type system (`ExpressionKind = "static" | "reactive"`), slot abstraction (`InsertionResult`), and FC/IS region architecture. This plan builds on that foundation.

**Remaining gaps**:

1. **Content values have implicit binding times**: `TextNode` and `ExpressionNode` represent the same concept (a value at a content position) at different binding times, but the IR encodes this as two separate types. This creates parallel code paths throughout analysis, codegen, and makes tree merge logic complex (handling cross-product of type combinations).

2. **Terminology obscures intent**: `InsertionResult` describes the mechanism (insertion), not the role (removable handle). The conceptual framework of "slots" is clearer and aligns with DOM literature.

3. **Conditional branches always fully allocate/free**: Even when both branches of a conditional produce identical DOM structure, the runtime removes all content and creates it fresh on every swap. This is pure waste when only values differ.

4. **No tree merge algorithm**: Structurally identical conditional branches cannot be dissolved into the Applicative layer because no algorithm exists to detect structural equivalence and promote diverging values to reactive.

5. **Compile-time body analysis not fully leveraged**: `checkCanOptimizeDirectReturn` computes body cardinality but this knowledge stays in codegen. The runtime re-discovers it by inspecting `node.nodeType`. A full `SlotKind` bridge would eliminate this duplication.

## Success Criteria

1. **ContentValue unification**: `TextNode` and `ExpressionNode` are replaced by a single `ContentValue` interface with explicit `bindingTime: "literal" | "render" | "reactive"`. All parallel code paths in analyze.ts and codegen are collapsed into binding-time dispatch.

2. **Slot terminology**: `InsertionResult` is renamed to `Slot` throughout the codebase (types.ts, regions.ts, all call sites). `insertAndTrack` becomes `claimSlot`, `removeInsertionResult` becomes `releaseSlot`.

3. **SlotKind bridge**: `computeSlotKind(body: ChildNode[]): SlotKind` computes slot kind from IR body structure. Region nodes (`ListRegionNode`, `ConditionalBranch`) store computed `slotKind` field. Codegen emits it in handler objects. Runtime `claimSlot()` accepts optional `slotKind` parameter.

4. **Tree merge algorithm**: `mergeConditionalBodies(branches): MergeResult<ChildNode[]>` recursively merges structurally-equivalent branches, promoting diverging literal/render values to reactive with ternary sources. Returns structured failure reasons via `MergeResult<T>` type.

5. **Conditional dissolution**: When tree merge succeeds, `generateConditionalRegion()` emits pure Applicative code (direct element creation with ternary subscriptions) — no `__conditionalRegion()` call, no marker comment. When merge fails, falls back to standard region codegen.

6. **Test coverage**: Unit tests for `ContentValue` factories, `computeSlotKind`, tree merge functions, and `MergeResult` outcomes. Codegen tests verify dissolved output (no runtime call) and fallback output. Integration tests verify DOM updates in-place without node replacement.

7. **Documentation**: TECHNICAL.md updated with DOM Algebra section, Applicative/Monadic framework, binding-time analysis, and slot vocabulary. Region Algebra section updated to use new terminology.

8. **Regression safety**: All existing tests pass without modification (except for terminology updates in assertions).

## The Gap

| Aspect | Current State | This Plan |
|--------|---------------|-----------|
| Content value representation | `TextNode \| ExpressionNode` (union, binding time implicit in type) | `ContentValue` (unified interface, explicit `bindingTime` field) |
| Binding-time classification | `ExpressionKind = "static" \| "reactive"` (exists but incomplete—missing compile-time literals) | `BindingTime = "literal" \| "render" \| "reactive"` (complete three-stage spectrum) |
| Slot terminology | `InsertionResult` (mechanism-focused) | `Slot` (role-focused, aligns with DOM literature) |
| Body cardinality | `checkCanOptimizeDirectReturn()` computes in codegen, not stored | `computeSlotKind()` computes in IR, stored as `slotKind` field, flows to runtime |
| Runtime insertion | `insertAndTrack()` inspects `node.nodeType` dynamically | `claimSlot()` dispatches on compile-time `slotKind` annotation |
| Conditional optimization | Always emit `__conditionalRegion()`, full remove+insert on swap | Tree merge dissolves identical structure into Applicative code with in-place value updates |
| Structural comparison | Nonexistent | `mergeConditionalBodies()` with `MergeResult<T>` type for structured outcomes |
| IR documentation | Region Algebra documented, ChildNode taxonomy undocumented | Full Applicative/Monadic framework documented with binding-time analysis |

## Vocabulary

These terms establish a consistent vocabulary for the DOM algebra framework. Some map to existing implementations (for clarity), others are new (for tree merge):

- **ContentValue**: The unified IR type for all value-producing content. Unifies `TextNode` and `ExpressionNode` (currently separate). Has a `bindingTime` field.
- **BindingTime**: `"literal" | "render" | "reactive"` — when a value becomes known. Maps to existing `ExpressionKind = "static" | "reactive"` but makes the three-stage spectrum explicit.
- **Slot**: A runtime handle to DOM content that can be removed. Renames `InsertionResult` (currently implemented) for conceptual clarity.
- **SingleSlot**: Tracks one DOM node directly. `{ kind: "single"; node: Node }` (exists as `InsertionResult`)
- **RangeSlot**: Tracks multiple sibling nodes via comment markers. `{ kind: "range"; startMarker: Comment; endMarker: Comment }` (exists as `InsertionResult`)
- **SlotKind**: `"single" | "range"` — compile-time annotation that determines which Slot strategy to use. Will be computed from IR body structure.
- **Applicative Layer**: DOM structure that is fixed at compile time; only values change at runtime (via subscriptions). No Slot needed.
- **Monadic Layer**: DOM structure that varies at runtime (items added/removed, branches swapped). Requires Slots.
- **Tree merge**: The operation that takes N structurally-equivalent branch bodies and produces a single merged body, promoting literal/render values to reactive at divergence points. Either succeeds completely or fails at the first incompatible position. **New contribution of this plan.**
- **Dissolution**: When tree merge succeeds for all branches of a conditional, the conditional is eliminated — dissolved into the Applicative layer. **New optimization enabled by tree merge.**
- **Binding-time promotion**: The tree merge operation at a divergence point: a literal or render-time value is promoted to reactive with a ternary source expression.

## Core Type Definitions

### ContentValue (unifies TextNode + ExpressionNode)

```typescript
/**
 * A value at a content position, annotated with its binding time.
 *
 * This is the universal representation of "something that produces a value"
 * across all stages of the Kinetic pipeline:
 *
 * - Analysis (Stage 1): classifies binding time from source types
 * - Optimization (Stage 2): may promote binding time (literal → reactive via ternary)
 * - Codegen (Stage 3): selects strategy based on binding time
 *
 * Replaces the former TextNode + ExpressionNode split. The source field
 * is always valid JavaScript source code:
 * - For literals: a JSON string literal (e.g., '"Admin"')
 * - For render-time: an expression (e.g., 'someVar')
 * - For reactive: an expression with deps (e.g., 'doc.title.get()')
 *
 * @internal
 */
interface ContentValue extends IRNodeBase {
  kind: "content"

  /** JavaScript source code that produces the value */
  source: string

  /** When this value becomes known */
  bindingTime: BindingTime

  /** For reactive content: the refs to subscribe to. Empty for literal/render. */
  dependencies: string[]
}

type BindingTime = "literal" | "render" | "reactive"

/**
 * ContentNode is now just ContentValue.
 * Kept as an alias for migration clarity.
 */
type ContentNode = ContentValue
```

### SlotKind (compile-time annotation)

```typescript
/**
 * Describes the cardinality of DOM content produced by a region body or branch.
 *
 * Determined at compile time by analyzing body structure. Flows to the runtime
 * to select the appropriate Slot strategy.
 *
 * - "single": Body produces exactly one DOM node. No markers needed.
 * - "range": Body produces zero or more DOM nodes. Marker-bounded.
 *
 * @internal
 */
type SlotKind = "single" | "range"

function computeSlotKind(body: ChildNode[]): SlotKind {
  // Returns "single" if body produces exactly one DOM node
  // Returns "range" otherwise (zero, multiple, or regions)
  // Implementation will analyze body structure
}
```

### Slot (runtime handle, renamed from InsertionResult)

```typescript
/**
 * A Slot is a tracked location in the DOM where content was placed.
 *
 * Slots exist because dynamically-inserted content (list items, conditional
 * branches) must be removable. A Slot is the handle that enables removal.
 *
 * This is the Monadic layer's runtime mechanism: content whose structure
 * varies at runtime needs an indirect reference for lifecycle management.
 *
 * @internal
 */
type Slot =
  | { kind: "single"; node: Node }
  | { kind: "range"; startMarker: Comment; endMarker: Comment }
```

### SlotKind computation (pure function on IR)

```typescript
/**
 * Compute the SlotKind for a body (array of ChildNodes).
 *
 * Returns "single" when the body produces exactly one DOM node:
 * - Exactly one DOM-producing node (element or content)
 * - Only leading effects (statements/bindings before the DOM node)
 * - No trailing effects, no nested regions, no control flow
 *
 * Returns "range" otherwise.
 *
 * @internal
 */
function computeSlotKind(body: ChildNode[]): SlotKind
```

### Tree merge (pure function on IR)

```typescript
/**
 * Attempt to merge N conditional branch bodies into a single body.
 *
 * Walks all branches in parallel. At each position:
 * - If all branches have identical nodes → keep as-is
 * - If all branches have same structure but differing liftable values →
 *   promote to reactive ContentValue with nested ternary source
 * - If structure differs or non-liftable values diverge → return null
 *
 * Mergeability is determined by binding time:
 * - ContentValue with bindingTime "literal" or "render" → liftable (can be merged via ternary)
 * - ContentValue with bindingTime "reactive" → must have identical source and deps
 * - EventHandler sources must be identical
 * - Statement sources must be identical
 * - Bindings must be identical
 * - Regions, loops, conditionals → NOT mergeable (Monadic by nature)
 *
 * This is the core of the Applicative/Monadic decomposition. It simultaneously
 * checks structural equivalence, identifies divergence points, and produces the
 * merged result — or fails at the first incompatible position.
 *
 * @param branches - Array of branch bodies (must have length >= 2)
 * @param conditions - Array of condition expressions (parallel to branches)
 * @param subscriptionTarget - The ref to subscribe to for condition changes
 * @returns Merged body using existing IR node types, or null if not mergeable
 *
 * @internal
 */
function mergeConditionalBodies(
  branches: ChildNode[][],
  conditions: Array<{ source: string; isElse: boolean }>,
  subscriptionTarget: string,
): ChildNode[] | null
```

### Updated handler types

```typescript
interface ListRegionHandlers<T> {
  /** Compile-time SlotKind for each item's DOM production */
  slotKind: SlotKind
  create: (item: T, index: number) => Node
  update?: (item: T, index: number, node: Node) => void
  move?: (fromIndex: number, toIndex: number) => void
}

interface ConditionalRegionHandlers {
  /** Compile-time SlotKind for each branch's DOM production */
  slotKind: SlotKind
  whenTrue: () => Node
  whenFalse?: () => Node
}
```

### MergeResult type for tree merge outcomes

```typescript
type MergeResult<T> =
  | { success: true; value: T }
  | { success: false; reason: MergeFailureReason }

type MergeFailureReason =
  | { kind: "different-kinds"; aKind: IRNodeKind; bKind: IRNodeKind }
  | { kind: "different-tags"; aTag: string; bTag: string }
  | { kind: "different-child-counts"; aCount: number; bCount: number }
  | { kind: "different-attribute-sets"; aAttrs: string[]; bAttrs: string[] }
  | { kind: "different-event-handlers"; aHandlers: string[]; bHandlers: string[] }
  | { kind: "incompatible-binding-times"; aTime: BindingTime; bTime: BindingTime }
  | { kind: "different-dependencies"; aDeps: string[]; bDeps: string[] }
  | { kind: "different-statement-sources"; aSource: string; bSource: string }
  | { kind: "region-not-mergeable" }
  | { kind: "child-merge-failed"; index: number; childReason: MergeFailureReason }
```

**Purpose**: Expresses the outcome of tree merge attempts with structured failure reasons for debugging and optimization metrics.

**Success case**: Returns the merged IR node.

**Failure cases**: Returns a tagged reason indicating why the merge failed. This enables:
- Better error messages during development
- Metrics collection (which merge patterns fail most often)
- Future optimization: partial hoisting when only some children merge

### Slot-aware insertion (replaces insertAndTrack)

```typescript
/**
 * Insert content into the DOM and return a Slot for later removal.
 *
 * Uses SlotKind to select the insertion strategy without runtime
 * nodeType inspection.
 *
 * When slotKind is omitted, falls back to nodeType inspection
 * for backward compatibility with hand-written test handlers.
 *
 * @internal
 */
function claimSlot(
  parent: Node,
  content: Node,
  before: Node | null,
  slotKind?: SlotKind,
): Slot

/**
 * Remove all content tracked by a Slot.
 *
 * @internal
 */
function releaseSlot(parent: Node, slot: Slot): void
```

## Phases and Tasks

**Note**: Phases 0 and 1 are primarily unification and renaming for conceptual clarity. Phase 2 (tree merge) is the novel contribution that enables conditional dissolution.

### Phase 0: Unify TextNode + ExpressionNode into ContentValue 🔴

**Goal**: Replace the two-type content representation with a single `ContentValue` type annotated with `bindingTime`. This collapses parallel code paths throughout the IR, analysis, and codegen layers, and establishes the foundation for binding-time-based tree merge.

- 🔴 Task 0.1: Define `BindingTime` type (`"literal" | "render" | "reactive"`) in `ir.ts`
- 🔴 Task 0.2: Define `ContentValue` interface in `ir.ts` with `kind: "content"`, `source: string`, `bindingTime: BindingTime`, `dependencies: string[]`
- 🔴 Task 0.3: Update `ContentNode` to alias `ContentValue` (was `TextNode | ExpressionNode`)
- 🔴 Task 0.4: Replace factory functions:
  - Remove `createTextNode`, `createStaticExpression`, `createReactiveExpression`
  - Add `createContent(source: string, bindingTime: BindingTime, dependencies: string[], span: SourceSpan): ContentValue`
  - Add convenience wrapper `createLiteral(value: string, span: SourceSpan)` that calls `createContent(JSON.stringify(value), "literal", [], span)`
- 🔴 Task 0.5: Update `IRNodeKind` — remove `"text"` and `"expression"`, add `"content"`
- 🔴 Task 0.6: Remove `TextNode` and `ExpressionNode` interfaces (or keep as deprecated aliases for `ContentValue` during migration)
- 🔴 Task 0.7: Update `ExpressionKind` references — `"static" | "reactive"` is replaced by `bindingTime` on `ContentValue`
- 🔴 Task 0.8: Update `ChildNode` union — replace `TextNode | ExpressionNode` with `ContentValue`
- 🔴 Task 0.9: Update type guards:
  - `isTextNode` → `isLiteralContent(node): node is ContentValue` (checks `kind === "content" && bindingTime === "literal"`)
  - `isExpressionNode` → `isContent(node): node is ContentValue` (checks `kind === "content"`)
  - `isReactiveContent` → check `node.kind === "content" && node.bindingTime === "reactive"`
  - `isReactiveExpression` → removed (was `ExpressionNode`-specific)
- 🔴 Task 0.10: Update `AttributeNode.value` type from `ContentNode` to `ContentValue`
- 🔴 Task 0.11: Update `analyze.ts` — `analyzeExpression` returns `ContentValue`:
  - String literal → `createContent(JSON.stringify(stripped), "literal", [], span)`
  - Template literal (no substitution) → same as string literal
  - Reactive expression → `createContent(source, "reactive", deps, span)`
  - Other expression → `createContent(source, "render", [], span)`
- 🔴 Task 0.12: Update `codegen/dom.ts` — collapse `case "text"` and `case "expression"` into `case "content"` that dispatches on `bindingTime`:
  - `"literal"`: `document.createTextNode(source)` (source is already a JS string literal)
  - `"render"`: `document.createTextNode(String(source))`
  - `"reactive"`: empty text node + `__subscribeWithValue` subscription
- 🔴 Task 0.13: Update `codegen/dom.ts` — collapse `generateTextContent` and `generateExpression` into `generateContent` dispatching on `bindingTime`
- 🔴 Task 0.14: Update `codegen/dom.ts` — update `generateAttributeSet` and `generateAttributeSubscription` to check `bindingTime` instead of `kind === "expression" && expressionKind === "reactive"`
- 🔴 Task 0.15: Update `codegen/dom.ts` — update `checkCanOptimizeDirectReturn` to check `kind === "content"` instead of `kind === "text" || kind === "expression"`
- 🔴 Task 0.16: Update `codegen/html.ts` — collapse `case "text"` and `case "expression"` into `case "content"`, and update `_generateContent` to dispatch on `bindingTime`
- 🔴 Task 0.17: Update `ir.ts` — update `isReactiveContent`, `createElement` (the `isReactive` computation), `createListRegion` (the `hasReactiveItems` check), and `createBuilder` (dependency collection) to use `bindingTime` instead of `expressionKind`
- 🔴 Task 0.18: Update all tests in `ir.test.ts`, `analyze.test.ts`, `dom.test.ts`, `html.test.ts`, and `integration.test.ts` to use `ContentValue` and `createContent` (or wrapper factories)
- 🔴 Task 0.19: Verify all existing tests pass
- 🔴 Task 0.20: Remove `TextNode`, `ExpressionNode`, `ExpressionKind` types

### Phase 1: Slot Vocabulary and SlotKind Bridge 🔴

**Goal**: Rename `InsertionResult` to `Slot`, introduce `SlotKind`, flow it from IR through codegen to runtime. This establishes the vocabulary and the Level 1 bridge in one coherent change — every rename immediately has meaning.

- 🔴 Task 1.1: Rename `InsertionResult` to `Slot` in `types.ts`
- 🔴 Task 1.2: Rename `insertAndTrack` to `claimSlot` in `regions.ts`
- 🔴 Task 1.3: Rename `removeInsertionResult` to `releaseSlot` in `regions.ts`
- 🔴 Task 1.4: Update all internal references (`ListRegionState.nodes` → `ListRegionState.slots`, etc.)
- 🔴 Task 1.5: Add `SlotKind` type to `ir.ts`
- 🔴 Task 1.6: Implement `computeSlotKind(body: ChildNode[]): SlotKind` as a pure function in `ir.ts`
- 🔴 Task 1.7: Add `bodySlotKind: SlotKind` to `ListRegionNode`
- 🔴 Task 1.8: Add `slotKind: SlotKind` to `ConditionalBranch`
- 🔴 Task 1.9: Update `createListRegion` and `createConditionalBranch` factory functions to compute `SlotKind`
- 🔴 Task 1.10: Refactor `checkCanOptimizeDirectReturn` to delegate to `computeSlotKind` (eliminate duplication)
- 🔴 Task 1.11: Update `generateListRegion` and `generateConditionalRegion` in `dom.ts` to emit `slotKind` property in handler objects
- 🔴 Task 1.12: Update handler type definitions in `types.ts` to include optional `slotKind?: SlotKind`
- 🔴 Task 1.13: Update `claimSlot(parent, content, before, slotKind?)` signature to accept optional `slotKind` parameter
- 🔴 Task 1.13a: Implement `SlotKind` dispatch in `claimSlot` with fallback to `nodeType` inspection when omitted
- 🔴 Task 1.14: Update `executeOp`, `executeConditionalOp`, and `__staticConditionalRegion` to pass `handlers.slotKind` to `claimSlot`
- 🔴 Task 1.15: Update all test references in `regions.test.ts`
- 🔴 Task 1.16: Add unit tests for `computeSlotKind` (all body patterns)
- 🔴 Task 1.17: Add unit tests for `claimSlot` with explicit `SlotKind`
- 🔴 Task 1.18: Add integration test verifying `slotKind` appears in codegen output
- 🔴 Task 1.19: Update TECHNICAL.md vocabulary (Slot, SlotKind, claimSlot, releaseSlot)
- 🔴 Task 1.20: Verify all existing tests pass

### Phase 2: Tree Merge for Conditional Dissolution (Level 2) 🔴

**Goal**: Implement the recursive tree merge that dissolves structurally-equivalent conditional branches into existing IR node types. When the merge succeeds, codegen emits Applicative code (direct element creation + conditional subscriptions) with no `__conditionalRegion` call. The `ContentValue` unification from Phase 0 makes the merge logic clean: mergeability is a single check on `bindingTime`, not a cross-product of type combinations.

**Decision (Question 5)**: Dissolution will inline directly (Option B) — no marker comment. This achieves true dissolution with no runtime overhead. Generated code is indistinguishable from hand-written optimal code.

- 🔴 Task 2.1: Define `MergeResult<T>` discriminated union type for expressing merge outcomes with reason for failure
- 🔴 Task 2.2: Implement `mergeContentValue(a: ContentValue, b: ContentValue, condition: ExpressionNode): MergeResult<ContentValue>` — the core merge for content positions. If `a` and `b` are identical, return as-is. If both have liftable binding times (`"literal"` or `"render"`), promote to `"reactive"` with ternary source. Otherwise return failure with reason.
- 🔴 Task 2.3: Implement `mergeNode(a: ChildNode, b: ChildNode, condition: ExpressionNode): MergeResult<ChildNode>` — the recursive pairwise merge function that delegates to `mergeContentValue` for content positions. Core rules:
  - Both `kind: "content"` → delegate to `mergeContentValue`
  - Both `kind: "element"` with same tag, same attribute names, same event names, same child count → recurse into attributes (merge content values), children (merge nodes), check event handlers identical
  - Both `kind: "statement"` with identical source → keep as-is
  - Both `kind: "statement"` with different source → null
  - Different kinds → null
  - Region, loop, conditional → null
- 🔴 Task 2.4: Implement `mergeConditionalBodies(branches: ConditionalBranch[]): MergeResult<ChildNode[]>` — walks N branch bodies in parallel, calling `mergeNode` for each position. For N > 2, synthesizes nested ternaries (`a ? X : b ? Y : Z`).
- 🔴 Task 2.5: Update `generateConditionalRegion` in `dom.ts` to attempt tree merge before emitting `__conditionalRegion`. If merge succeeds, generate the merged body as standard Applicative code (direct inline, no marker comment, no handler object, no runtime call).
- 🔴 Task 2.6: Ensure conditionals without an else branch are not merge candidates (one branch may produce zero nodes — not structurally equivalent to producing some nodes)
- 🔴 Task 2.7: Add unit tests for `MergeResult` type and helpers
- 🔴 Task 2.8: Add unit tests for `mergeContentValue`:
  - Two literals with same value → kept as-is
  - Two literals with different values → promoted to reactive with ternary
  - Literal + render-time → promoted to reactive with ternary
  - Two render-time with different sources → promoted to reactive with ternary
  - Two reactive with same source and deps → kept as-is
  - Two reactive with different deps → null
  - Reactive + literal → null
- 🔴 Task 2.9: Add unit tests for `mergeNode`:
  - Same element, different content children → merged with promoted ContentValue
  - Same element, different static attribute values → merged with promoted ContentValue in attribute
  - Same element, identical reactive content → kept as-is
  - Same element, different event handler sources → null
  - Different element tags → null
  - Different child counts → null
  - Nested elements with mergeable children → recursively merged
  - Statement with identical source → kept as-is
  - Statement with different source → null
  - Region node → null
- 🔴 Task 2.10: Add unit tests for `mergeConditionalBodies`:
  - Two branches, fully mergeable → merged body
  - Two branches, not mergeable → null
  - Three branches (if/else if/else), all mergeable → nested ternaries
  - Three branches, one incompatible → null
  - Branches with mixed identical and diverging positions → correct merge
- 🔴 Task 2.11: Add codegen tests verifying dissolved output:
  - No `__conditionalRegion` in output
  - No marker comment in output
  - Direct `createElement` calls present
  - Ternary expression in subscription callback
  - Correct subscription target
- 🔴 Task 2.12: Add codegen tests verifying fallback when merge fails:
  - Different tags → standard `__conditionalRegion` output
  - No else branch → standard `__conditionalRegion` output
  - Reactive content with different deps → standard `__conditionalRegion` output
- 🔴 Task 2.13: Add integration tests: compile a conditional with identical branches, execute it, verify DOM updates in-place on condition change without node replacement
- 🔴 Task 2.14: Verify all existing tests pass

### Phase 3: Documentation 🔴

**Goal**: Document the DOM Algebra, Applicative/Monadic framework, binding-time analysis, tree merge, and the ChildNode taxonomy.

- 🔴 Task 3.1: Add "DOM Algebra" section to TECHNICAL.md (see TECHNICAL.md Updates below)
- 🔴 Task 3.2: Add "ChildNode Taxonomy" section to TECHNICAL.md documenting Applicative/Monadic/ControlFlow/Effect categories
- 🔴 Task 3.3: Add "ContentValue and Binding Time" section to TECHNICAL.md
- 🔴 Task 3.4: Update "Region Algebra" section to use Slot vocabulary
- 🔴 Task 3.5: Document tree merge algorithm and mergeability rules
- 🔴 Task 3.6: Document the optimization cascade: tree merge → standard codegen

## Tests

### Unit Tests for `ContentValue` and factory functions

```typescript
describe("ContentValue", () => {
  const s = createSpan(0, 0, 0, 0)

  it("creates literal content for string values", () => {
    const node = createContent('"Admin"', "literal", [], s)
    expect(node.kind).toBe("content")
    expect(node.bindingTime).toBe("literal")
    expect(node.source).toBe('"Admin"')
    expect(node.dependencies).toEqual([])
  })

  it("creates render-time content for static expressions", () => {
    const node = createContent("someVar", "render", [], s)
    expect(node.kind).toBe("content")
    expect(node.bindingTime).toBe("render")
  })

  it("creates reactive content with dependencies", () => {
    const node = createContent("doc.title.get()", "reactive", ["doc.title"], s)
    expect(node.kind).toBe("content")
    expect(node.bindingTime).toBe("reactive")
    expect(node.dependencies).toEqual(["doc.title"])
  })

  it("createLiteral wraps value in JSON.stringify", () => {
    const node = createLiteral("Admin", s)
    expect(node.source).toBe('"Admin"')
    expect(node.bindingTime).toBe("literal")
  })
})
```

### Unit Tests for `computeSlotKind`

```typescript
describe("computeSlotKind", () => {
  const s = createSpan(0, 0, 0, 0)

  it('returns "single" for body with one element', () => {
    const body = [createElement("span", [], [], [], [], s)]
    expect(computeSlotKind(body)).toBe("single")
  })

  it('returns "single" for body with leading statements then one element', () => {
    const body = [createStatement("const x = 1", s), createElement("span", [], [], [], [], s)]
    expect(computeSlotKind(body)).toBe("single")
  })

  it('returns "range" for body with two elements', () => {
    const body = [createElement("span", [], [], [], [], s), createElement("span", [], [], [], [], s)]
    expect(computeSlotKind(body)).toBe("range")
  })

  it('returns "range" for body with statement after element', () => {
    const body = [createElement("span", [], [], [], [], s), createStatement("console.log()", s)]
    expect(computeSlotKind(body)).toBe("range")
  })

  it('returns "range" for body containing a list region', () => {
    const body = [createListRegion("doc.items", "item", null, [], s)]
    expect(computeSlotKind(body)).toBe("range")
  })

  it('returns "range" for empty body', () => {
    expect(computeSlotKind([])).toBe("range")
  })

  it('returns "single" for single content node', () => {
    const body = [createLiteral("hello", s)]
    expect(computeSlotKind(body)).toBe("single")
  })

  it('returns "single" for single reactive content', () => {
    const body = [createContent("doc.title.get()", "reactive", ["doc.title"], s)]
    expect(computeSlotKind(body)).toBe("single")
  })
})
```

### Unit Tests for Tree Merge

```typescript
const s = createSpan(0, 0, 0, 0)

describe("mergeContentValue", () => {
  const cond = { source: "doc.isAdmin.get()", target: "doc.isAdmin" }

  it("keeps identical literals as-is", () => {
    const a = createLiteral("Admin", s)
    const result = mergeContentValue(a, a, cond)
    expect(result).not.toBeNull()
    expect(result!.bindingTime).toBe("literal")
  })

  it("promotes different literals to reactive with ternary", () => {
    const a = createLiteral("Admin", s)
    const b = createLiteral("User", s)
    const result = mergeContentValue(a, b, cond)
    expect(result).not.toBeNull()
    expect(result!.bindingTime).toBe("reactive")
    expect(result!.source).toContain("?")
    expect(result!.dependencies).toEqual(["doc.isAdmin"])
  })

  it("promotes literal + render to reactive", () => {
    const a = createLiteral("Admin", s)
    const b = createContent("userName", "render", [], s)
    const result = mergeContentValue(a, b, cond)
    expect(result).not.toBeNull()
    expect(result!.bindingTime).toBe("reactive")
  })

  it("keeps identical reactive expressions as-is", () => {
    const a = createContent("doc.name.get()", "reactive", ["doc.name"], s)
    const result = mergeContentValue(a, a, cond)
    expect(result).not.toBeNull()
    expect(result!.source).toBe("doc.name.get()")
  })

  it("returns null for reactive with different deps", () => {
    const a = createContent("doc.adminName.get()", "reactive", ["doc.adminName"], s)
    const b = createContent("doc.userName.get()", "reactive", ["doc.userName"], s)
    expect(mergeContentValue(a, b, cond)).toBeNull()
  })

  it("returns null for reactive + literal", () => {
    const a = createContent("doc.name.get()", "reactive", ["doc.name"], s)
    const b = createLiteral("User", s)
    expect(mergeContentValue(a, b, cond)).toBeNull()
  })
})

describe("mergeNode", () => {
  const cond = { source: "doc.isAdmin.get()", target: "doc.isAdmin" }

  it("merges same element with different literal content children", () => {
    const a = createElement("span", [], [], [], [createLiteral("Admin", s)], s)
    const b = createElement("span", [], [], [], [createLiteral("User", s)], s)
    const result = mergeNode(a, b, cond)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe("element")
    const child = (result as ElementNode).children[0] as ContentValue
    expect(child.kind).toBe("content")
    expect(child.bindingTime).toBe("reactive")
    expect(child.source).toContain("?")
  })

  it("merges same element with different static attribute values", () => {
    const attrA = [{ name: "class", value: createContent('"admin"', "literal", [], s) }]
    const attrB = [{ name: "class", value: createContent('"user"', "literal", [], s) }]
    const a = createElement("span", attrA, [], [], [], s)
    const b = createElement("span", attrB, [], [], [], s)
    const result = mergeNode(a, b, cond)
    expect(result).not.toBeNull()
    const attr = (result as ElementNode).attributes[0]
    expect(attr.value.bindingTime).toBe("reactive")
  })

  it("keeps identical reactive content as-is", () => {
    const expr = createContent("doc.name.get()", "reactive", ["doc.name"], s)
    const a = createElement("span", [], [], [], [expr], s)
    const b = createElement("span", [], [], [], [expr], s)
    const result = mergeNode(a, b, cond)
    expect(result).not.toBeNull()
    const child = (result as ElementNode).children[0] as ContentValue
    expect(child.source).toBe("doc.name.get()")
  })

  it("returns null for reactive content with different deps", () => {
    const a = createElement("span", [], [], [], [createContent("doc.a.get()", "reactive", ["doc.a"], s)], s)
    const b = createElement("span", [], [], [], [createContent("doc.b.get()", "reactive", ["doc.b"], s)], s)
    expect(mergeNode(a, b, cond)).toBeNull()
  })

  it("returns null for different element tags", () => {
    const a = createElement("span", [], [], [], [], s)
    const b = createElement("div", [], [], [], [], s)
    expect(mergeNode(a, b, cond)).toBeNull()
  })

  it("returns null for different child counts", () => {
    const a = createElement("div", [], [], [], [createLiteral("a", s)], s)
    const b = createElement("div", [], [], [], [createLiteral("a", s), createLiteral("b", s)], s)
    expect(mergeNode(a, b, cond)).toBeNull()
  })

  it("returns null for different event handler sources", () => {
    const handlersA = [{ event: "click", handlerSource: "handleAdmin", span: s }]
    const handlersB = [{ event: "click", handlerSource: "handleUser", span: s }]
    const a = createElement("span", [], handlersA, [], [], s)
    const b = createElement("span", [], handlersB, [], [], s)
    expect(mergeNode(a, b, cond)).toBeNull()
  })

  it("returns null for different attribute name sets", () => {
    const a = createElement("span", [{ name: "class", value: createLiteral("x", s) }], [], [], [], s)
    const b = createElement("span", [{ name: "id", value: createLiteral("x", s) }], [], [], [], s)
    expect(mergeNode(a, b, cond)).toBeNull()
  })

  it("returns null for region nodes", () => {
    const a = createListRegion("doc.a", "item", null, [], s)
    const b = createListRegion("doc.b", "item", null, [], s)
    expect(mergeNode(a, b, cond)).toBeNull()
  })

  it("keeps identical statements as-is", () => {
    const a = createStatement("const x = itemRef.get()", s)
    const b = createStatement("const x = itemRef.get()", s)
    const result = mergeNode(a, b, cond)
    expect(result).not.toBeNull()
    expect(result!.kind).toBe("statement")
  })

  it("returns null for different statement sources", () => {
    const a = createStatement("console.log('admin')", s)
    const b = createStatement("console.log('user')", s)
    expect(mergeNode(a, b, cond)).toBeNull()
  })

  it("recursively merges nested elements", () => {
    const a = createElement("div", [], [], [], [
      createElement("span", [], [], [], [createLiteral("Admin", s)], s),
    ], s)
    const b = createElement("div", [], [], [], [
      createElement("span", [], [], [], [createLiteral("User", s)], s),
    ], s)
    const result = mergeNode(a, b, cond)
    expect(result).not.toBeNull()
    const innerSpan = (result as ElementNode).children[0] as ElementNode
    expect(innerSpan.tag).toBe("span")
    expect((innerSpan.children[0] as ContentValue).bindingTime).toBe("reactive")
  })
})

describe("mergeConditionalBodies", () => {
  it("merges two fully compatible branches", () => {
    const bodyA = [createElement("span", [], [], [], [createLiteral("Admin", s)], s)]
    const bodyB = [createElement("span", [], [], [], [createLiteral("User", s)], s)]
    const result = mergeConditionalBodies(
      [bodyA, bodyB],
      [{ source: "doc.isAdmin.get()", isElse: false }, { source: "", isElse: true }],
      "doc.isAdmin",
    )
    expect(result).not.toBeNull()
    expect(result!.length).toBe(1)
  })

  it("returns null when branches are not compatible", () => {
    const bodyA = [createElement("span", [], [], [], [], s)]
    const bodyB = [createElement("div", [], [], [], [], s)]
    const result = mergeConditionalBodies(
      [bodyA, bodyB],
      [{ source: "doc.isAdmin.get()", isElse: false }, { source: "", isElse: true }],
      "doc.isAdmin",
    )
    expect(result).toBeNull()
  })

  it("merges three branches with nested ternaries", () => {
    const bodyA = [createElement("span", [], [], [], [createLiteral("Admin", s)], s)]
    const bodyB = [createElement("span", [], [], [], [createLiteral("Mod", s)], s)]
    const bodyC = [createElement("span", [], [], [], [createLiteral("User", s)], s)]
    const result = mergeConditionalBodies(
      [bodyA, bodyB, bodyC],
      [
        { source: "doc.role.get() === 'admin'", isElse: false },
        { source: "doc.role.get() === 'mod'", isElse: false },
        { source: "", isElse: true },
      ],
      "doc.role",
    )
    expect(result).not.toBeNull()
    const child = (result![0] as ElementNode).children[0] as ContentValue
    expect(child.kind).toBe("content")
    expect(child.bindingTime).toBe("reactive")
    expect(child.source).toContain("?")
  })

  it("returns null when bodies have different lengths", () => {
    const bodyA = [createElement("span", [], [], [], [], s)]
    const bodyB = [createElement("span", [], [], [], [], s), createElement("div", [], [], [], [], s)]
    const result = mergeConditionalBodies(
      [bodyA, bodyB],
      [{ source: "cond", isElse: false }, { source: "", isElse: true }],
      "doc.cond",
    )
    expect(result).toBeNull()
  })
})
```

### Integration Tests for Structural Hoisting

```typescript
describe("structural hoisting", () => {
  it("dissolves identical branches into in-place updates (Level 2)", () => {
    const source = `
      div(() => {
        if (doc.isAdmin.get()) {
          span("Admin")
        } else {
          span("User")
        }
      })
    `
    const result = transformSource(source, { target: "dom" })
    // Should NOT contain __conditionalRegion — fully dissolved
    expect(result.code).not.toContain("__conditionalRegion")
    // Should contain direct element creation
    expect(result.code).toContain('createElement("span")')
    // Should contain conditional value in subscription
    expect(result.code).toContain("?")
  })

  it("dissolves if/else-if/else with identical structure", () => {
    const source = `
      div(() => {
        if (doc.role.get() === 'admin') {
          span("Admin")
        } else if (doc.role.get() === 'mod') {
          span("Mod")
        } else {
          span("User")
        }
      })
    `
    const result = transformSource(source, { target: "dom" })
    expect(result.code).not.toContain("__conditionalRegion")
    expect(result.code).toContain('createElement("span")')
  })

  it("falls back to standard codegen when no structural overlap", () => {
    const source = `
      div(() => {
        if (doc.isAdmin.get()) {
          span("Admin")
        } else {
          div("Container")
        }
      })
    `
    const result = transformSource(source, { target: "dom" })
    // Different tags — no hoisting possible
    expect(result.code).toContain("__conditionalRegion")
  })

  it("falls back when no else branch exists", () => {
    const source = `
      div(() => {
        if (doc.isAdmin.get()) {
          span("Admin")
        }
      })
    `
    const result = transformSource(source, { target: "dom" })
    expect(result.code).toContain("__conditionalRegion")
  })

  it("falls back when branches have reactive expressions with different deps", () => {
    const source = `
      div(() => {
        if (doc.isAdmin.get()) {
          span(doc.adminName.get())
        } else {
          span(doc.userName.get())
        }
      })
    `
    const result = transformSource(source, { target: "dom" })
    // Different reactive deps — can't merge (would lose inner subscriptions)
    expect(result.code).toContain("__conditionalRegion")
  })
})
```

### Unit Tests for `claimSlot` with explicit SlotKind

```typescript
describe("claimSlot", () => {
  it("inserts single node directly when slotKind is 'single'", () => {
    const parent = document.createElement("div")
    const child = document.createElement("span")
    const slot = claimSlot(parent, child, null, "single")

    expect(slot.kind).toBe("single")
    expect(parent.childNodes.length).toBe(1)
  })

  it("inserts fragment with markers when slotKind is 'range'", () => {
    const parent = document.createElement("div")
    const frag = document.createDocumentFragment()
    frag.appendChild(document.createElement("span"))
    frag.appendChild(document.createElement("span"))
    const slot = claimSlot(parent, frag, null, "range")

    expect(slot.kind).toBe("range")
    // startMarker, span, span, endMarker
    expect(parent.childNodes.length).toBe(4)
  })

  it("falls back to nodeType inspection when slotKind omitted", () => {
    const parent = document.createElement("div")
    const frag = document.createDocumentFragment()
    frag.appendChild(document.createElement("span"))
    frag.appendChild(document.createElement("span"))
    const slot = claimSlot(parent, frag, null)

    expect(slot.kind).toBe("range")
  })

  it("optimizes single-child fragment to single slot when slotKind is 'range'", () => {
    const parent = document.createElement("div")
    const frag = document.createDocumentFragment()
    frag.appendChild(document.createElement("span"))
    const slot = claimSlot(parent, frag, null, "range")

    // Runtime optimization: single-child fragment can use SingleSlot
    expect(slot.kind).toBe("single")
    expect(parent.childNodes.length).toBe(1)
  })
})
```

## Transitive Effect Analysis

### Direct Dependencies

| File | Change | Risk |
|------|--------|------|
| `ir.ts` | Replace `TextNode` + `ExpressionNode` with `ContentValue`, add `SlotKind`, `computeSlotKind`, `mergeConditionalBodies`, `mergeNode`, region node fields | High — foundational IR change |
| `types.ts` | Rename `InsertionResult` → `Slot`, add `SlotKind`, update handler types | Medium — many internal consumers |
| `analyze.ts` | Update `analyzeExpression` to return `ContentValue` | Medium — core analysis |
| `codegen/dom.ts` | Collapse text/expression codegen, emit `slotKind`, attempt tree merge in conditional codegen | High — significant codegen changes |
| `codegen/html.ts` | Collapse text/expression codegen | Medium — parallel changes to dom.ts |
| `runtime/regions.ts` | Rename functions, use `SlotKind` dispatch | Medium — core runtime |

### Transitive Dependencies

| File | Depends On | Impact |
|------|------------|--------|
| `runtime/regions.test.ts` | `regions.ts`, `types.ts` | Must update all `InsertionResult` → `Slot`, `insertAndTrack` → `claimSlot`, `removeInsertionResult` → `releaseSlot` references |
| `compiler/codegen/dom.test.ts` | `codegen/dom.ts`, `ir.ts` | Must update to use `ContentValue`/`createContent`; add dissolved conditional output tests |
| `compiler/codegen/html.test.ts` | `codegen/html.ts`, `ir.ts` | Must update to use `ContentValue`/`createContent` |
| `compiler/integration.test.ts` | `codegen/dom.ts` via `transform.ts` | Tests that inspect generated code may need updates for `ContentValue` codegen patterns; new hoisting integration tests |
| `compiler/ir.test.ts` | `ir.ts` | Must update for `ContentValue`; new `computeSlotKind`, `mergeNode`, `mergeConditionalBodies` tests |
| `compiler/analyze.test.ts` | `analyze.ts`, `ir.ts` | Must update assertions from `TextNode`/`ExpressionNode` to `ContentValue` |
| `compiler/index.ts` | `ir.ts` | Must update re-exported types |
| `codegen/html.ts` | `ir.ts` | No new IR node types; collapses text/expression handling. Dissolution is DOM-codegen-local, so HTML codegen is unaffected by tree merge. |
| `compiler/analyze.ts` | `ir.ts` (calls factory functions) | Factory function signatures change. `analyzeExpression` return type changes. |
| `runtime/hydrate.ts` | No `InsertionResult` references | No change needed |

### Breaking Change Assessment

**No breaking changes to public API.** All changes are `@internal`:
- `ContentValue` replaces `TextNode` + `ExpressionNode` (all `@internal`)
- `Slot` replaces `InsertionResult` (both `@internal`)
- `SlotKind` is new, `@internal`
- Handler type changes are `@internal` (consumed by generated code only)
- No new IR node types — tree merge produces existing node types
- Public function signatures (`__listRegion`, `__conditionalRegion`) unchanged in behavior

Hand-written test code that creates handler objects will need `slotKind` added. The backward-compatible fallback in `claimSlot` handles this gracefully.

### Risk: Phase 0 Blast Radius

The `ContentValue` unification (Phase 0) touches every layer of the compiler: IR types, analysis, both codegen targets, and all test files. This is the highest-risk phase. Mitigation: keep old factory names (`createTextNode`, `createStaticExpression`, `createReactiveExpression`) as thin deprecated wrappers during migration, ensuring existing code continues to work while migrating incrementally.

## Resources for Implementation

### Files to Modify

- `packages/kinetic/src/compiler/ir.ts` — `ContentValue`, `BindingTime`, `computeSlotKind`, `mergeConditionalBodies`, `mergeNode`, `mergeContentValue`, region node fields, updated factory functions and type guards
- `packages/kinetic/src/compiler/analyze.ts` — `analyzeExpression` returns `ContentValue`
- `packages/kinetic/src/compiler/codegen/dom.ts` — Collapsed content codegen, emit `slotKind`, attempt tree merge in conditional codegen
- `packages/kinetic/src/compiler/codegen/html.ts` — Collapsed content codegen
- `packages/kinetic/src/compiler/index.ts` — Updated type re-exports
- `packages/kinetic/src/types.ts` — `Slot`, `SlotKind`, handler types
- `packages/kinetic/src/runtime/regions.ts` — `claimSlot`, `releaseSlot`, state types
- `packages/kinetic/src/runtime/regions.test.ts` — Rename references, new `claimSlot` tests
- `packages/kinetic/src/compiler/ir.test.ts` — `ContentValue` tests, `computeSlotKind`, `mergeNode`, `mergeConditionalBodies` tests
- `packages/kinetic/src/compiler/analyze.test.ts` — Updated for `ContentValue`
- `packages/kinetic/src/compiler/codegen/dom.test.ts` — Collapsed content codegen tests, dissolved conditional output tests
- `packages/kinetic/src/compiler/codegen/html.test.ts` — Collapsed content codegen tests
- `packages/kinetic/src/compiler/integration.test.ts` — Hoisting integration tests
- `packages/kinetic/TECHNICAL.md` — DOM Algebra documentation

### Key Code Sections

- `TextNode` interface: `ir.ts` L95–100 (replaced by `ContentValue`)
- `ExpressionNode` interface: `ir.ts` L72–86 (replaced by `ContentValue`)
- `ContentNode` type alias: `ir.ts` L105 (updated)
- `createTextNode` factory: `ir.ts` L535–537 (becomes wrapper)
- `createStaticExpression` factory: `ir.ts` L542–553 (becomes wrapper)
- `createReactiveExpression` factory: `ir.ts` L558–570 (becomes wrapper)
- `analyzeExpression`: `analyze.ts` L446–472 (returns `ContentValue`)
- `generateChild` case "text" and case "expression": `dom.ts` L380–415 (collapsed to case "content")
- `generateTextContent` / `generateExpression` / `generateContent`: `dom.ts` L120–150 (collapsed)
- `generateAttributeSubscription`: `dom.ts` L210–250 (checks `bindingTime` instead of `expressionKind`)
- `checkCanOptimizeDirectReturn`: `dom.ts` L551–597 (checks `kind === "content"`)
- `insertAndTrack` function: `regions.ts` L65–99 (becomes `claimSlot`)
- `removeInsertionResult` function: `regions.ts` L112–145 (becomes `releaseSlot`)
- `generateListRegion`: `dom.ts` L630–657 (emit `slotKind`)
- `generateConditionalRegion`: `dom.ts` L666–717 (tree merge decision point)
- `ListRegionState.nodes`: `regions.ts` L197–204 (rename to `.slots`)
- `executeOp`: `regions.ts` L310–353 (use `handlers.slotKind`)
- `executeConditionalOp`: `regions.ts` L526–563 (use `handlers.slotKind`)
- `ConditionalBranch` interface: `ir.ts` L227–235 (add `slotKind`)
- `ListRegionNode` interface: `ir.ts` L202–222 (add `bodySlotKind`)

### Cross-Reference: Prior Plans

- `.plans/kinetic-insertion-result.md` — Introduced `InsertionResult` (being renamed to `Slot`)
- `.plans/kinetic-region-algebra.md` — Established FC/IS and unified state types
- `.plans/kinetic-patterns.md` — Original observations about parallel structures and the DOMProducer functor

## Changeset

```
---
"@loro-extended/kinetic": minor
---

Introduce Slot-based DOM Algebra with Applicative/Monadic decomposition

- Unified TextNode + ExpressionNode into ContentValue with explicit bindingTime
  ("literal" | "render" | "reactive") — collapses parallel code paths across IR,
  analysis, and both codegen targets
- Renamed `InsertionResult` to `Slot` (reflects role as removable content handle)
- Renamed `insertAndTrack` to `claimSlot`, `removeInsertionResult` to `releaseSlot`
- Added `SlotKind` ("single" | "range") computed at compile time from body structure
- Codegen emits `slotKind` in handler objects; runtime dispatches on it
- Structurally equivalent conditional branches dissolved via tree merge —
  literal/render values promoted to reactive with ternary source at divergence points,
  using existing IR node types (no new node types)
- Supports if/else and if/else-if/else chains (N-branch merge)
- Documented Applicative/Monadic DOM Algebra framework in TECHNICAL.md
- No changes to public API
```

## TECHNICAL.md Updates

### New Section: DOM Algebra

Add after the existing "Region Algebra" section:

```markdown
### DOM Algebra: Applicative/Monadic Decomposition

Kinetic's DOM handling is organized around a fundamental distinction from
functional programming: **Applicative** vs **Monadic** structure.

#### ContentValue and Binding Time

All value-producing content in the IR is represented by `ContentValue`, which
carries an explicit binding time:

- `"literal"` — value known at compile time (e.g., `"Admin"`)
- `"render"` — value known at render time (e.g., `someVar`)
- `"reactive"` — value that changes at runtime (e.g., `doc.title.get()`)

The binding time determines codegen strategy:
- Literal: inline string in generated code
- Render: evaluate once at render time
- Reactive: subscription that updates on data change

This unification replaces the former `TextNode` + `ExpressionNode` split.
The `source` field is always valid JavaScript source code (for literals,
it's a JSON-stringified string like `'"Admin"'`).

#### Applicative Layer (static structure, dynamic values)

Content where the DOM node tree is fixed at compile time. Only values
(text content, attributes) change at runtime via subscriptions. Examples:

- A reactive expression: `span(doc.title.get())` — one `<span>`, text updates in-place
- A reactive attribute: `div({ class: () => doc.theme.get() })` — one `<div>`, class updates
- A dissolved conditional where both branches have the same DOM shape

The compiler creates these nodes directly (codegen holds a JS variable reference).
No Slot needed — the node lives or dies with its parent.

This is analogous to **stack allocation**: size known at compile time, automatically
freed when the parent scope exits, no tracking needed.

#### Monadic Layer (dynamic structure)

Content where the DOM node tree itself changes at runtime. Nodes are
created and destroyed by runtime handlers. Examples:

- List items: added/removed as CRDT data changes
- Conditional branches with different DOM structure: swapped on condition change

These need **Slots** — indirect handles for content whose identity isn't
known at compile time. This is analogous to **heap allocation**: size unknown
at compile time, must be explicitly freed, needs a pointer (Slot) to find it.

#### Slots

A Slot is a tracked location in the DOM where dynamically-inserted content lives.
It enables removal of content that the compiler doesn't have a direct reference to.

- `SingleSlot { node }` — tracks one node directly
- `RangeSlot { startMarker, endMarker }` — tracks multiple siblings via comment markers

#### SlotKind Bridge

`SlotKind` is determined at compile time by `computeSlotKind(body)` and flows
to the runtime via the `slotKind` property on handler objects:

- `"single"`: Body produces exactly one DOM node → `SingleSlot`
- `"range"`: Body produces zero or more nodes → `RangeSlot`

This eliminates runtime `nodeType` inspection for codegen-produced code.

#### Tree Merge and Conditional Dissolution

The compiler can promote Monadic code to Applicative by merging conditional
branches with identical DOM structure. The `mergeConditionalBodies` function
walks all branches in parallel and, at each divergence point, performs
**binding-time promotion**: a literal or render-time `ContentValue` is promoted
to reactive with a ternary source expression.

No new IR node types are introduced — the merged tree uses existing
`ContentValue` nodes with promoted binding times at positions where
branches diverged. The codegen already knows how to generate subscriptions
for reactive content.

Mergeability is determined by binding time:
- **Liftable** (`"literal"`, `"render"`) — may differ between branches, merged via ternary
- **Effectful** (`"reactive"`) — must have identical source and dependencies
- **Event handlers** — must have identical source
- **Statements** — must have identical source
- **Regions, loops, conditionals** — not mergeable (Monadic by nature)

The effectful-value restriction prevents a subtle bug: dissolving reactive
expressions with different dependency sets into a single ternary would
subscribe only to the condition ref, losing reactivity to the inner refs.

Example:
```typescript
// Source
if (doc.isAdmin.get()) { span("Admin") } else { span("User") }

// Compiled (no __conditionalRegion!)
const _span0 = document.createElement("span")
__subscribeWithValue(doc.isAdmin, () => doc.isAdmin.get(), (v) => {
  _span0.textContent = v ? "Admin" : "User"
}, scope)
```

#### Optimization Cascade

The codegen applies optimizations in order:

1. **Tree merge** (`mergeConditionalBodies`) — if all branches are mergeable,
   dissolve the conditional into Applicative code
2. **Standard codegen** — emit `__conditionalRegion` with `slotKind` annotation
```

### Update Section: Region Algebra

Replace all occurrences of `InsertionResult` with `Slot`, `insertAndTrack` with `claimSlot`, `removeInsertionResult` with `releaseSlot`. Update the state type examples to use `slots: Slot[]`.

### New Section: ChildNode Taxonomy

Add to the IR documentation:

```markdown
### ChildNode Taxonomy

IR nodes fall into four categories by runtime behavior:

**Applicative** (structure fixed at compile time, no Slot needed):
- `ElementNode` — one DOM element (static or reactive attributes/children)
- `ContentValue` — one text node (literal, render-time, or reactive content)

**Monadic** (structure varies at runtime, Slot required):
- `ListRegionNode` — dynamic iteration, items come and go
- `ConditionalRegionNode` — branch swapping (when not dissolvable via tree merge)

**Control Flow** (compile-time expansion, no runtime identity):
- `StaticLoopNode` — expands into inline JS `for` loop
- `StaticConditionalNode` — expands into inline JS `if`

**Effects** (no DOM production):
- `StatementNode` — arbitrary JS executed for side effects
- `BindingNode` — two-way binding wiring
```

### New Section: ContentValue and Binding Time

Add to the IR documentation:

```markdown
### ContentValue and Binding Time

All value-producing content uses a single type, `ContentValue`, with an explicit
`bindingTime` field that classifies when the value becomes known:

| Binding Time | Source Example | Codegen Strategy |
|-------------|---------------|-----------------|
| `"literal"` | `'"Admin"'` | Inline in generated code |
| `"render"` | `'someVar'` | Evaluate once at render time |
| `"reactive"` | `'doc.title.get()'` | Empty node + subscription |

This replaces the former `TextNode` + `ExpressionNode` split. The `source` field
is always valid JavaScript source code. For literals, this means the value is
JSON-stringified (e.g., the string `Admin` becomes source `'"Admin"'`).

The binding-time model is an instance of **binding-time analysis** from partial
evaluation theory. The tree merge optimization performs **binding-time promotion**:
a literal value is promoted to reactive when it needs to vary based on a condition.
```

## Learnings

These insights emerged during the design process and research phase, and informed the final architecture. They are recorded here for reference during implementation and future design work.

### Research findings: Most foundational types already exist

Deep-dive research revealed that the conceptual framework of binding-time analysis, slots, and region algebra is already partially implemented:

1. **Binding-time analysis exists implicitly**: `ExpressionKind = "static" | "reactive"` already performs binding-time classification via the type system. The unification into `ContentValue` makes this explicit and eliminates cross-product complexity.

2. **InsertionResult is the slot abstraction**: The existing `InsertionResult` type with `single | range` kinds already models slots. Renaming to `Slot` improves conceptual clarity and mathematical precision.

3. **Region Algebra with FC/IS is complete**: Recent work (kinetic-region-algebra plan) implemented the trackability invariant, unified state types, and FC/IS pattern for both list and conditional regions.

4. **Direct-return optimization exists**: `checkCanOptimizeDirectReturn()` in dom.ts already implements Level 1 optimization (avoiding fragment overhead for single-element bodies).

**Impact on plan**: Phase 0 and Phase 1 are primarily unification and renaming for conceptual clarity, not new functionality. Phase 2 (tree merge) is the genuine innovation — no conditional dissolution exists today.

### The plan is about conceptual clarity, not just optimization

The DOM algebra framework provides:
- **Simplicity**: Unified types eliminate parallel code paths
- **Mathematical correctness**: Binding-time analysis has formal semantics from partial evaluation theory
- **Maintainability**: Clear vocabulary (Slot, ContentValue, binding time) makes the system easier to understand and extend

These benefits matter even when existing code "works" — this is foundational infrastructure that will pay dividends in future optimization work.

### The pipeline is three stages of partial evaluation

The Kinetic pipeline performs partial evaluation at three stages, and all three follow the same principle — materialize what's known, defer what's unknown:

1. **Analysis** (source → IR): TypeScript syntax and types are known; data values are unknown. Structure is materialized into IR nodes; values are deferred as `ContentValue`.
2. **Optimization** (IR → IR): Branch structure equivalence is known; which branch is active is unknown. Shared structure is materialized into fixed nodes; varying values are promoted to reactive `ContentValue` with ternary sources.
3. **Runtime** (IR → DOM): Current ref values are known; future changes are unknown. Current values are materialized into DOM nodes; future changes are deferred as subscriptions.

The `ContentValue` type with `bindingTime` survives all three stages because it's parameterized by when the value becomes known, not by which stage produced it.

### ExpressionNode was already the Varying type

The IR already had a representation for "a value that may change" — `ExpressionNode` with `expressionKind: "reactive"`. The separate `TextNode` type was just a degenerate case (a value known at compile time). Unifying them into `ContentValue` makes the binding-time structure explicit and eliminates an entire class of cross-product bugs in the tree merge.

### Tree merge is binding-time promotion

The merge operation at a divergence point is precisely binding-time promotion: a literal or render-time value is promoted to reactive when it needs to vary based on a condition. The ternary expression is the residual computation (in PE terms). The `mergeContentValue` function is a one-liner check: if both values are liftable (literal or render), promote; otherwise fail.

### Tree merge is the right primitive, not separate analysis + extraction

Early designs proposed three separate functions: `structurallyEquivalent` (check), `extractValueMap` (extract), and `alignBodies` (align). These were collapsed into one recursive `mergeConditionalBodies` function that simultaneously checks equivalence, identifies divergence, and produces the merged result — or fails at the first incompatible position. This is simpler, has no intermediate data structures, and is impossible to use incorrectly.

### Mergeability requires distinguishing liftable vs effectful values

Dissolving a conditional by creating ternary expressions is only safe when the diverging values are **liftable** (literal or render-time binding time). Reactive values with different dependency sets cannot be merged into a ternary because the resulting subscription would only observe the condition ref, silently losing reactivity to the inner refs. This constraint maps directly to the congruence rule from partial evaluation theory.

### Event handlers with different sources are not mergeable

Unlike text content and attributes, event listeners cannot be updated via ternary expressions. Swapping a handler would require `removeEventListener` + `addEventListener` on every condition change. For simplicity and correctness, the initial implementation treats differing event handler sources as non-equivalent. This is conservative and covers the common case.

### Dissolution is a codegen-local optimization, not an IR transformation

The tree merge produces standard IR nodes, but the decision to attempt dissolution belongs in `dom.ts` (the DOM codegen), not as a general IR-to-IR pass. HTML codegen (SSR) doesn't need dissolution — it renders a static snapshot. This means HTML codegen is unaffected, and the optimization is contained to one codegen path.

### Partial hoisting is deferred but architecturally supported

Level 3 (partial hoisting — shared prefix promoted, residual remains as a reduced conditional) was explored in depth but deferred from this plan. The `mergeConditionalBodies` function provides the foundation: if modified to return partial results (merged prefix + residual), the codegen can emit Applicative code for the prefix and a standard `__conditionalRegion` for the residual. This is the polyvariant generalization (in PE terms) of our monovariant Level 2.

### N-branch merge generalizes naturally

The tree merge function accepts N branches (not just two), supporting `if/else if/else` chains. At divergence points, it synthesizes nested ternaries (`a ? X : b ? Y : Z`). This fell out of the design naturally once `mergeConditionalBodies` was parameterized over an array of branches rather than hard-coded for two.

### Dissolution inlines directly without markers

After analyzing trade-offs, dissolution will emit pure Applicative code with no marker comments. This achieves true zero-overhead dissolution where generated code is indistinguishable from hand-written optimal code. Source maps provide debugging context, and the generated code can include a comment if needed. The alternative (keeping marker comments) would contradict the optimization's goal of eliminating runtime overhead.