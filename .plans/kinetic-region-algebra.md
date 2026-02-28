# Plan: Kinetic Region Algebra — TrackedNode, FC/IS Conditionals, Unified State

## Background

During debugging of a delete-not-working bug in the kinetic-todo example, we discovered that `DocumentFragment` nodes become empty after DOM insertion, losing their `parentNode` reference. This made removal impossible because the runtime tracked the empty fragment instead of the actual inserted element.

The fix revealed a deeper architectural insight: **trackability is the core invariant** for all region types. Both list regions and conditional regions must:
1. Insert DOM content
2. Track what was inserted
3. Remove it later (on delete, branch swap, or dispose)

Currently, this invariant is maintained through:
- Runtime defense (`insertAndTrack` helper)
- Codegen optimization (`checkCanOptimizeDirectReturn`)
- Implicit state tracking (`state.nodes[]`, `state.currentNode`)

But the code has structural issues:
- List regions follow FC/IS pattern; conditional regions don't
- State types are similar but not unified
- The "tracked node" concept is implicit, not a first-class type

## Problem Statement

The region runtime has:
1. **Implicit trackability** — The invariant "inserted content can be removed" is enforced by convention, not types
2. **Inconsistent FC/IS** — List regions have pure planning functions; conditional regions mix planning and execution
3. **Duplicate patterns** — Both region types track nodes, scopes, and parent scope with similar but separate structures

## Success Criteria

1. `TrackedNode` is an explicit type returned by `insertAndTrack`
2. Conditional regions have `planConditionalUpdate()` pure function mirroring list regions
3. Both region types share a common `RegionState` base structure
4. All existing tests pass
5. New tests verify the planning functions in isolation

## The Gap

| Aspect | List Region | Conditional Region |
|--------|-------------|-------------------|
| Planning | `planInitialRender()`, `planDeltaOps()` | None (inline in `updateConditionalRegion`) |
| Execution | `executeOp()`, `executeOps()` | Mixed into `updateConditionalRegion` |
| State | `ListRegionState<T>` | `ConditionalRegionState` |
| Tracked Node | Implicit `Node` in `nodes[]` | Implicit `Node | null` in `currentNode` |

## Core Type Definitions

### TrackedNode

```typescript
/**
 * A node that was inserted into the DOM and can be reliably removed.
 * 
 * This type exists because DocumentFragment nodes become empty after insertion,
 * making them untrackable. TrackedNode guarantees the invariant:
 * "The referenced node is a direct child of the parent it was inserted into."
 */
export interface TrackedNode {
  /** The actual DOM node to track (never a DocumentFragment) */
  readonly node: Node
}

/**
 * Insert content into the DOM and return a trackable reference.
 * 
 * Handles DocumentFragment by tracking firstChild instead of the empty fragment.
 */
export function insertAndTrack(
  parent: Node,
  content: Node,
  referenceNode: Node | null,
): TrackedNode
```

### Conditional Region Operations (FC/IS)

```typescript
/**
 * Operations for conditional region updates.
 * Output of pure planning function, input to imperative executor.
 */
export type ConditionalRegionOp =
  | { kind: "noop" }
  | { kind: "insert"; branch: "true" | "false" }
  | { kind: "delete" }
  | { kind: "swap"; toBranch: "true" | "false" }

/**
 * Pure planning function for conditional region updates.
 */
export function planConditionalUpdate(
  currentBranch: "true" | "false" | null,
  newCondition: boolean,
  hasWhenFalse: boolean,
): ConditionalRegionOp
```

### Unified Region State Base

```typescript
/**
 * Base state shared by all region types.
 */
interface RegionStateBase {
  /** The parent scope that owns this region */
  parentScope: Scope
}

/**
 * State for list regions.
 */
interface ListRegionState<T> extends RegionStateBase {
  /** Tracked nodes for each item, in order */
  nodes: TrackedNode[]
  /** Scopes for each item */
  scopes: Scope[]
  /** The list ref for delta handling */
  listRef: ListRefLike<T>
}

/**
 * State for conditional regions.
 */
interface ConditionalRegionState extends RegionStateBase {
  /** Current branch: "true", "false", or null (neither) */
  currentBranch: "true" | "false" | null
  /** The tracked node for current content */
  currentNode: TrackedNode | null
  /** Scope for current branch */
  currentScope: Scope | null
}
```

## Phases and Tasks

### Phase 1: Extract TrackedNode Type ✅

**Goal**: Make the trackability invariant explicit with a dedicated type.

- ✅ Task 1.1: Define `TrackedNode` interface in `types.ts`
- ✅ Task 1.2: Update `insertAndTrack` return type to `TrackedNode`
- ✅ Task 1.3: Update `ListRegionState.nodes` to `TrackedNode[]`
- ✅ Task 1.4: Update `ConditionalRegionState.currentNode` to `TrackedNode | null`
- ✅ Task 1.5: Update all usages to access `.node` property
- ✅ Task 1.6: Add JSDoc explaining the trackability invariant

### Phase 2: Apply FC/IS to Conditional Regions 🔴

**Goal**: Separate planning from execution for conditional regions.

- 🔴 Task 2.1: Define `ConditionalRegionOp` discriminated union type
- 🔴 Task 2.2: Implement `planConditionalUpdate()` pure function
- 🔴 Task 2.3: Implement `executeConditionalOp()` imperative function
- 🔴 Task 2.4: Refactor `updateConditionalRegion` to use plan + execute
- 🔴 Task 2.5: Add unit tests for `planConditionalUpdate()` (pure function testing)

### Phase 3: Unify State Types 🔴

**Goal**: Extract common structure into a base type for clarity.

- 🔴 Task 3.1: Define `RegionStateBase` interface
- 🔴 Task 3.2: Update `ListRegionState` to extend `RegionStateBase`
- 🔴 Task 3.3: Update `ConditionalRegionState` to extend `RegionStateBase`
- 🔴 Task 3.4: Change `currentBranch` from `boolean | null` to `"true" | "false" | null` for clarity

### Phase 4: Documentation 🔴

**Goal**: Update technical documentation to reflect the new architecture.

- 🔴 Task 4.1: Update TECHNICAL.md with Region Algebra section
- 🔴 Task 4.2: Add JSDoc to all new types and functions
- 🔴 Task 4.3: Document the FC/IS pattern for both region types

## Tests

### Unit Tests for `planConditionalUpdate` (Pure Function)

```typescript
describe("planConditionalUpdate", () => {
  it("returns noop when condition unchanged (true → true)", () => {
    const op = planConditionalUpdate("true", true, true)
    expect(op).toEqual({ kind: "noop" })
  })

  it("returns noop when condition unchanged (false → false)", () => {
    const op = planConditionalUpdate("false", false, true)
    expect(op).toEqual({ kind: "noop" })
  })

  it("returns insert when going from null to true", () => {
    const op = planConditionalUpdate(null, true, true)
    expect(op).toEqual({ kind: "insert", branch: "true" })
  })

  it("returns insert when going from null to false with whenFalse", () => {
    const op = planConditionalUpdate(null, false, true)
    expect(op).toEqual({ kind: "insert", branch: "false" })
  })

  it("returns noop when going from null to false without whenFalse", () => {
    const op = planConditionalUpdate(null, false, false)
    expect(op).toEqual({ kind: "noop" })
  })

  it("returns swap when going from true to false", () => {
    const op = planConditionalUpdate("true", false, true)
    expect(op).toEqual({ kind: "swap", toBranch: "false" })
  })

  it("returns delete when going from true to false without whenFalse", () => {
    const op = planConditionalUpdate("true", false, false)
    expect(op).toEqual({ kind: "delete" })
  })

  it("returns swap when going from false to true", () => {
    const op = planConditionalUpdate("false", true, true)
    expect(op).toEqual({ kind: "swap", toBranch: "true" })
  })
})
```

### Integration Tests (Existing)

All existing region tests in `regions.test.ts` should continue to pass, including:
- `should delete items when create handler returns DocumentFragment`
- `should swap branches when handlers return DocumentFragment`
- `should remove node on scope dispose when handler returns DocumentFragment`

## Transitive Effect Analysis

### Direct Dependencies

| File | Change | Risk |
|------|--------|------|
| `runtime/regions.ts` | Type changes, refactor | Medium - core runtime |
| `types.ts` | New types | Low - additive |

### Transitive Dependencies

| File | Depends On | Impact |
|------|------------|--------|
| `runtime/regions.test.ts` | `regions.ts` | Must update to use `.node` accessor |
| `compiler/integration.test.ts` | `regions.ts` (via runtime) | Should pass unchanged |
| `runtime/subscribe.ts` | `Scope` | No change needed |
| Compiled user code | `__listRegion`, `__conditionalRegion` | No change - public API unchanged |

### Breaking Change Assessment

**No breaking changes to public API.** The changes are internal to the runtime:
- `TrackedNode` is `@internal`
- Planning functions are `@internal`
- State types are `@internal`
- Public function signatures (`__listRegion`, `__conditionalRegion`) unchanged

## Resources for Implementation

### Files to Modify

- `packages/kinetic/src/runtime/regions.ts` — Main implementation
- `packages/kinetic/src/types.ts` — Type definitions
- `packages/kinetic/src/runtime/regions.test.ts` — Tests

### Files for Reference

- `packages/kinetic/TECHNICAL.md` — Current architecture docs
- `.plans/kinetic-delta-driven-ui.md` — Original plan with FC/IS discussion
- `packages/kinetic/src/runtime/scope.ts` — Scope implementation

### Key Code Sections

- `insertAndTrack` function: `regions.ts` L59-84
- `ListRegionState` type: `regions.ts` L122-133
- `ConditionalRegionState` type: `regions.ts` L363-374
- `planDeltaOps` function: `regions.ts` L168-218 (FC example)
- `updateConditionalRegion` function: `regions.ts` L427-469 (to be refactored)

## Changeset

```
---
"@loro-extended/kinetic": patch
---

Internal refactor: Extract TrackedNode type, apply FC/IS to conditional regions

- Added explicit `TrackedNode` type for DOM insertion tracking
- Added `planConditionalUpdate()` pure function for conditional region state transitions  
- Unified region state types with common `RegionStateBase`
- No changes to public API
```

## TECHNICAL.md Updates

Add new section after "List Region Architecture":

```markdown
### Region Algebra

All region types (list, conditional) share a common algebraic structure:

**The Trackability Invariant**: Every node inserted into the DOM must remain trackable for removal. This is enforced through the `TrackedNode` type, which guarantees the referenced node is a direct child of its parent (never an empty DocumentFragment).

**Functional Core / Imperative Shell**: Both region types follow FC/IS:

| Region Type | Planning (Pure) | Execution (Imperative) |
|-------------|-----------------|------------------------|
| List | `planInitialRender()`, `planDeltaOps()` | `executeOps()` |
| Conditional | `planConditionalUpdate()` | `executeConditionalOp()` |

**State Types**: Both extend `RegionStateBase`:
- `ListRegionState<T>` — Manages array of tracked nodes and scopes
- `ConditionalRegionState` — Manages single tracked node and scope

This unified structure makes the region system easier to understand, test, and extend.
```
