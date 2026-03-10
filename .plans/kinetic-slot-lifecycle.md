# Plan: Slot Lifecycle — Deferred Removal and Enter/Exit Hooks

## Background

Animation in React-style frameworks is notoriously awkward. The fundamental tension: declarative UI says "UI = f(state)" but animation requires temporal continuity where old and new states coexist during transitions. This creates the well-known asymmetry:

- **Animate-in** works naturally (element exists, animate from initial to final state)
- **Animate-out** breaks (element "shouldn't exist" per state, but must remain for animation)

Libraries like `react-transition-group`, `framer-motion`, and `react-spring` exist to work around this. They all use wrapper components that intercept unmount and defer it.

Kinetic's Slot abstraction provides a cleaner foundation. A Slot is already a "trackable DOM handle" — extending it with lifecycle hooks enables **deferred removal** as a first-class primitive. Animation becomes one use case of this primitive, not a special feature.

### The Core Insight

The primitive isn't "animation" — it's **decoupled lifetimes**:

```
Logical:  ████████████|
DOM:      ████████████░░░░░░|
          ^ insert    ^ exit  ^ remove
                      begins
```

The `░░░░░░` period is the **exit phase** — logically gone, physically present.

### Prior Art in Kinetic

The Region Algebra work established:
- `Slot` type with `kind: "single" | "range"`
- `claimSlot()` / `releaseSlot()` for insertion/removal
- `SlotKind` flowing from IR → codegen → runtime
- FC/IS pattern for region operations

This plan extends that foundation with temporal semantics.

## Problem Statement

Currently, `releaseSlot()` removes DOM content immediately. There's no mechanism to:
1. Defer removal until an async operation completes
2. Run code during the exit phase (animations, measurements, cleanup)
3. Handle interruption when conditions change mid-exit
4. Coordinate enter/exit timing during swaps

## Success Criteria

1. `SlotLifecycle` type with `enter` and `exit` callbacks
2. Both callbacks receive `Slot` and `AbortSignal` for interruption handling
3. `Slot` gains `elements()` method for consistent iteration
4. `swapMode: 'sequential' | 'parallel'` controls swap coordination
5. `lifecycle()` source-level wrapper recognized by analyzer
6. IR representation on `ConditionalBranch` and `LoopNode`
7. Codegen emits lifecycle configuration in handler objects
8. Runtime awaits lifecycle callbacks before DOM mutations
9. Interruption via `AbortSignal` when conditions change mid-transition
10. All existing tests pass; new tests cover lifecycle scenarios

## The Gap

| Aspect | Current | Target |
|--------|---------|--------|
| Removal timing | Immediate | Deferred via async `exit` |
| Enter behavior | None | Optional async `enter` before subscriptions |
| Interruption | N/A | `AbortSignal` passed to callbacks |
| Slot iteration | Manual | `slot.elements()` helper |
| Swap coordination | N/A | `swapMode: 'sequential' \| 'parallel'` |
| Source syntax | None | `lifecycle({ enter, exit }, () => { ... })` |
| IR representation | None | `lifecycle` field on branches/loops |

## Core Type Definitions

### SlotLifecycle

```typescript
/**
 * Lifecycle hooks for slot enter/exit phases.
 * 
 * These hooks decouple DOM lifetime from logical lifetime, enabling
 * animations, measurements, cleanup, and other deferred operations.
 */
interface SlotLifecycle {
  /** 
   * Called after DOM insertion, before subscriptions activate.
   * If async, subscriptions wait for completion.
   * Signal aborts if element needs to exit before enter completes.
   */
  enter?: (slot: Slot, signal: AbortSignal) => Promise<void> | void
  
  /** 
   * Called when logical lifetime ends, before DOM removal.
   * If async, removal waits for completion.
   * Signal aborts if element needs to re-enter before exit completes.
   */
  exit?: (slot: Slot, signal: AbortSignal) => Promise<void> | void
  
  /** 
   * For swaps: run exit/enter sequentially or in parallel.
   * - 'sequential': old exits completely, then new enters
   * - 'parallel': both run concurrently (enables crossfade)
   * @default 'parallel'
   */
  swapMode?: 'sequential' | 'parallel'
}
```

### Extended Slot

```typescript
interface Slot {
  kind: 'single' | 'range'
  node?: Node
  startMarker?: Comment
  endMarker?: Comment
  
  /** 
   * Iterate all Element nodes in this slot.
   * For single slots, yields the node if it's an Element.
   * For range slots, yields all Elements between markers.
   */
  elements(): Iterable<Element>
}
```

### IR Extensions

```typescript
interface ConditionalBranch {
  condition: ContentValue | null
  body: ChildNode[]
  slotKind: SlotKind
  lifecycle?: SlotLifecycleIR  // NEW
  span: SourceSpan
}

interface LoopNode {
  // ... existing fields
  bodySlotKind: SlotKind
  itemLifecycle?: SlotLifecycleIR  // NEW
}

/**
 * IR representation of lifecycle hooks.
 * Source strings are emitted verbatim in codegen.
 */
interface SlotLifecycleIR {
  enterSource?: string   // Source text of enter callback
  exitSource?: string    // Source text of exit callback
  swapMode?: 'sequential' | 'parallel'
}
```

## Phases and Tasks

### Phase 0: Slot.elements() Helper 🔴

**Goal**: Add consistent element iteration to Slot type.

- 🔴 Task 0.1: Add `elements(): Iterable<Element>` to `Slot` type in `types.ts`
- 🔴 Task 0.2: Implement `slotElements()` generator function in `regions.ts`
- 🔴 Task 0.3: Update `claimSlot()` to attach `elements` method to returned Slot
- 🔴 Task 0.4: Add unit tests for `slot.elements()` with single and range slots

### Phase 1: SlotLifecycle Type and Runtime Support 🔴

**Goal**: Runtime can await enter/exit callbacks with interruption support.

- 🔴 Task 1.1: Define `SlotLifecycle` interface in `types.ts`
- 🔴 Task 1.2: Add `lifecycle?: SlotLifecycle` to `ListRegionHandlers` and `ConditionalRegionHandlers`
- 🔴 Task 1.3: Create `runEnterLifecycle(slot, lifecycle, signal)` async helper
- 🔴 Task 1.4: Create `runExitLifecycle(slot, lifecycle, signal)` async helper
- 🔴 Task 1.5: Update `executeConditionalOp` to await lifecycle callbacks
- 🔴 Task 1.6: Update `executeOp` (list region) to await lifecycle callbacks
- 🔴 Task 1.7: Implement `AbortController` management for interruption
- 🔴 Task 1.8: Implement `swapMode` coordination logic in conditional swap

### Phase 2: IR Representation 🔴

**Goal**: Lifecycle hooks represented in IR for codegen.

- 🔴 Task 2.1: Define `SlotLifecycleIR` interface in `ir.ts`
- 🔴 Task 2.2: Add `lifecycle?: SlotLifecycleIR` to `ConditionalBranch`
- 🔴 Task 2.3: Add `itemLifecycle?: SlotLifecycleIR` to `LoopNode`
- 🔴 Task 2.4: Update `createConditionalBranch()` factory to accept lifecycle
- 🔴 Task 2.5: Update `createLoop()` factory to accept lifecycle

### Phase 3: Analysis — Recognize `lifecycle()` Calls 🔴

**Goal**: Analyzer extracts lifecycle from `lifecycle()` wrapper calls.

- 🔴 Task 3.1: Define `lifecycle()` function signature in `types.ts` (user-facing API)
- 🔴 Task 3.2: Add `analyzeLifecycleCall()` to recognize `lifecycle(config, builder)` pattern
- 🔴 Task 3.3: Update `analyzeIfStatement()` to detect and extract lifecycle from branch bodies
- 🔴 Task 3.4: Update `analyzeForOfStatement()` to detect and extract lifecycle from loop bodies
- 🔴 Task 3.5: Handle nested lifecycle calls (innermost wins, or error?)

### Phase 4: Codegen — Emit Lifecycle Configuration 🔴

**Goal**: Generated code includes lifecycle in handler objects.

- 🔴 Task 4.1: Update `generateConditional()` to emit `lifecycle` in handlers
- 🔴 Task 4.2: Update `generateReactiveLoop()` to emit `lifecycle` in handlers
- 🔴 Task 4.3: Ensure lifecycle source is emitted as function, not string

### Phase 5: Documentation 🔴

**Goal**: Document lifecycle feature for users and maintainers.

- 🔴 Task 5.1: Add "Slot Lifecycle" section to TECHNICAL.md
- 🔴 Task 5.2: Add user-facing documentation with examples
- 🔴 Task 5.3: Document interruption patterns (ignore, cancel, reverse)

## Tests

### Phase 0: Slot.elements()

```typescript
describe("slot.elements()", () => {
  it("yields single element for single slot", () => {
    const div = document.createElement("div")
    const slot = claimSlot(parent, div, null)
    expect([...slot.elements()]).toEqual([div])
  })

  it("yields nothing for single slot with text node", () => {
    const text = document.createTextNode("hello")
    const slot = claimSlot(parent, text, null)
    expect([...slot.elements()]).toEqual([])
  })

  it("yields all elements for range slot", () => {
    const frag = document.createDocumentFragment()
    const span1 = document.createElement("span")
    const span2 = document.createElement("span")
    frag.append(span1, document.createTextNode("x"), span2)
    const slot = claimSlot(parent, frag, null)
    expect([...slot.elements()]).toEqual([span1, span2])
  })
})
```

### Phase 1: Runtime Lifecycle

```typescript
describe("lifecycle callbacks", () => {
  it("awaits exit before removal", async () => {
    const events: string[] = []
    const handlers = {
      whenTrue: () => document.createElement("div"),
      lifecycle: {
        exit: async () => {
          events.push("exit-start")
          await delay(50)
          events.push("exit-end")
        }
      }
    }
    // Setup region with condition true, then flip to false
    // Assert: exit-start, exit-end, then DOM removal
  })

  it("passes AbortSignal that aborts on interruption", async () => {
    let aborted = false
    const handlers = {
      whenTrue: () => document.createElement("div"),
      lifecycle: {
        exit: async (slot, signal) => {
          signal.addEventListener("abort", () => { aborted = true })
          await delay(100)
        }
      }
    }
    // Flip condition false (start exit), then true again at 50ms
    // Assert: aborted === true
  })

  it("swapMode sequential waits for exit before enter", async () => {
    const events: string[] = []
    // ... test sequential ordering
  })

  it("swapMode parallel runs exit and enter concurrently", async () => {
    const events: string[] = []
    // ... test parallel execution
  })
})
```

### Phase 3: Analysis

```typescript
describe("lifecycle() analysis", () => {
  it("extracts lifecycle from conditional branch", () => {
    const source = `
      if (doc.show.get()) {
        lifecycle({
          exit: async (slot) => { /* fade out */ }
        }, () => {
          div("content")
        })
      }
    `
    const ir = analyzeBuilder(source)
    const conditional = ir.children[0] as ConditionalNode
    expect(conditional.branches[0].lifecycle).toEqual({
      exitSource: "async (slot) => { /* fade out */ }"
    })
  })
})
```

### Phase 4: Codegen

```typescript
describe("lifecycle codegen", () => {
  it("emits lifecycle in conditional handlers", () => {
    const branch = createConditionalBranch(
      condition,
      body,
      span,
      { exitSource: "(slot) => fadeOut(slot)" }
    )
    const code = generateConditional(createConditional([branch], "ref", span), parent, state)
    expect(code).toContain("lifecycle: {")
    expect(code).toContain("exit: (slot) => fadeOut(slot)")
  })
})
```

## Transitive Effect Analysis

### Direct Dependencies

| File | Change | Risk |
|------|--------|------|
| `types.ts` | Add `SlotLifecycle`, extend `Slot` | Low — additive |
| `runtime/regions.ts` | Async execution, AbortController | Medium — core runtime |
| `compiler/ir.ts` | Add `SlotLifecycleIR`, extend branches/loops | Low — additive |
| `compiler/analyze.ts` | Recognize `lifecycle()` calls | Medium — new pattern |
| `compiler/codegen/dom.ts` | Emit lifecycle in handlers | Low — additive |

### Transitive Dependencies

| File | Depends On | Impact |
|------|------------|--------|
| `runtime/regions.test.ts` | `regions.ts` | Must add lifecycle tests |
| `compiler/integration.test.ts` | Full pipeline | Must verify lifecycle flow |
| `compiler/codegen/html.ts` | `ir.ts` | Lifecycle is DOM-only, no SSR impact |
| `runtime/hydrate.ts` | `regions.ts` | May need lifecycle support for hydration |

### Breaking Change Assessment

**No breaking changes.** All additions are optional:
- `SlotLifecycle` is optional on handlers
- `lifecycle` field is optional on IR nodes
- `slot.elements()` is additive
- Existing code without lifecycle works unchanged

### Risk: Async Execution Changes

The execution functions (`executeConditionalOp`, `executeOp`) become async. This is the highest-risk change:

1. **Subscription timing**: Subscriptions should activate after `enter` completes
2. **Rapid updates**: Multiple condition changes during async exit need AbortController coordination
3. **Error handling**: Lifecycle callback errors should not break region state

Mitigation: Comprehensive tests for interruption scenarios.

### Risk: HTML Codegen

Lifecycle is inherently a DOM/runtime concern. HTML codegen should:
- Ignore lifecycle (SSR has no animation)
- Or emit markers for hydration to pick up lifecycle

Decision: Ignore for now. Hydration can be extended later if needed.

## Resources for Implementation

### Files to Modify

- `packages/kinetic/src/types.ts` — `SlotLifecycle`, `Slot.elements()`
- `packages/kinetic/src/runtime/regions.ts` — Async execution, lifecycle helpers
- `packages/kinetic/src/compiler/ir.ts` — `SlotLifecycleIR`, branch/loop extensions
- `packages/kinetic/src/compiler/analyze.ts` — `lifecycle()` call recognition
- `packages/kinetic/src/compiler/codegen/dom.ts` — Emit lifecycle config

### Files for Reference

- `packages/kinetic/TECHNICAL.md` — Architecture context
- `.plans/kinetic-region-algebra.md` — Slot/region foundations
- `.plans/kinetic-patterns.md` — Original observations about trackability

### Key Code Sections

- `claimSlot()`: `regions.ts` L66-139
- `releaseSlot()`: `regions.ts` L152-182
- `executeConditionalOp()`: `regions.ts` L562-604
- `executeOp()` (list): `regions.ts` L347-389
- `ConditionalBranch` type: `ir.ts` L307-320
- `LoopNode` type: `ir.ts` L266-302

## Changeset

```
---
"@loro-extended/kinetic": minor
---

Add Slot Lifecycle for deferred removal and enter/exit hooks

- Added `SlotLifecycle` type with `enter` and `exit` callbacks
- Lifecycle callbacks receive `Slot` and `AbortSignal` for interruption handling
- Added `slot.elements()` for consistent element iteration across single/range slots
- Added `swapMode: 'sequential' | 'parallel'` for swap coordination
- Added `lifecycle()` wrapper function for source-level lifecycle declaration
- Extended `ConditionalBranch` and `LoopNode` IR with lifecycle representation
- No changes to public API surface (lifecycle is opt-in)
```

## TECHNICAL.md Updates

Add new section after "Region Algebra":

```markdown
### Slot Lifecycle

Slots support **lifecycle hooks** that decouple DOM lifetime from logical lifetime:

```typescript
interface SlotLifecycle {
  enter?: (slot: Slot, signal: AbortSignal) => Promise<void> | void
  exit?: (slot: Slot, signal: AbortSignal) => Promise<void> | void
  swapMode?: 'sequential' | 'parallel'
}
```

**Use cases:**
- Animation (fade, slide, FLIP)
- Measurement before removal
- Cleanup with DOM still present
- Debugging / pausing transitions

**Source syntax:**

```typescript
if (doc.show.get()) {
  lifecycle({
    enter: (slot) => fadeIn(slot, 300),
    exit: (slot) => fadeOut(slot, 300),
    swapMode: 'parallel'
  }, () => {
    div("Animated content")
  })
}
```

**Interruption:** If the condition changes while a lifecycle callback is in progress, the `AbortSignal` aborts. The callback can:
- Ignore the signal (complete animation, then handle new state)
- Cancel via `signal.addEventListener('abort', () => animation.cancel())`
- Reverse via `signal.addEventListener('abort', () => animation.reverse())`

**Swap modes:**
- `'sequential'`: Old content fully exits before new content enters
- `'parallel'`: Exit and enter run concurrently (enables crossfade effects)

**Composable helpers:**

```typescript
const fade = (duration: number): SlotLifecycle => ({
  enter: async (slot, signal) => {
    for (const el of slot.elements()) {
      const anim = el.animate({ opacity: [0, 1] }, duration)
      signal.addEventListener('abort', () => anim.cancel())
      await anim.finished.catch(() => {})
    }
  },
  exit: async (slot, signal) => {
    for (const el of slot.elements()) {
      const anim = el.animate({ opacity: [1, 0] }, duration)
      signal.addEventListener('abort', () => anim.cancel())
      await anim.finished.catch(() => {})
    }
  }
})

// Usage
lifecycle(fade(300), () => div("content"))
```
```

## Open Questions (Resolved)

1. **Nested lifecycles**: Parent wins. If parent is exiting, children go with it.

2. **Interruption model**: `AbortSignal` passed to callbacks. User decides behavior via event listener.

3. **HTML codegen**: Ignore lifecycle. SSR doesn't animate; hydration can be extended later.

4. **`swapMode` default**: `'parallel'` — more useful default, sequential is easy to achieve.