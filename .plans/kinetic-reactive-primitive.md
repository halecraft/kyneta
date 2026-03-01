# Plan: Branded Reactive Primitive and LocalRef

## Background

Kinetic currently detects reactivity by checking if an expression's type matches a hardcoded list of Loro type names (`TextRef`, `CounterRef`, `ListRef`, etc.). This works but has significant limitations:

1. **Tight coupling** — The compiler has hardcoded knowledge of `@loro-extended/change` types
2. **No extensibility** — Users cannot define their own reactive types
3. **No local state** — There's no way to have reactive UI-only state (animation progress, dropdown open state, hover state) without polluting the Loro document
4. **Runtime special-casing** — The `__subscribe` function uses `loro()` to extract Loro containers, creating Loro-specific code paths

This creates a fundamental gap: **reactivity is conflated with data synchronization**. Loro handles synced/persisted state, but UI frameworks also need ephemeral local state that is:
- Reactive (triggers re-renders)
- Not synced (local to this client)
- Not persisted (lost on refresh)

Examples of local reactive state:
- "Is this dropdown open?"
- "Is this animation in progress?"
- "What's the current scroll position?"
- "Is this component mounted?"

### The Solution: Reactive Subscribe Function

Instead of hardcoding type names, use a **symbol-keyed subscribe function** that is both a type-level marker AND a runtime adapter:

```typescript
const REACTIVE = Symbol.for('kinetic:reactive')

/** The subscribe function signature */
type ReactiveSubscribe = (self: unknown, callback: () => void) => () => void

interface Reactive {
  [REACTIVE]: ReactiveSubscribe
}
```

The `[REACTIVE]` property answers one question: **"How do I subscribe to changes on this object?"**

This provides:
1. **Type-level detection** — compiler checks for `[REACTIVE]` property presence
2. **Runtime adaptation** — each type defines how to subscribe to itself
3. **No special cases** — runtime uses the function uniformly, no `loro()` calls
4. **Cross-package compatibility** — shared package ensures same symbol type
5. **Minimal surface** — just a function, not an object with methods

## Problem Statement

1. The compiler's `isReactiveType()` function uses a hardcoded `LORO_REF_TYPES` set
2. There's no `LocalRef<T>` for UI-only reactive state
3. Users cannot integrate their own reactive primitives
4. The runtime has Loro-specific code (`loro()` calls) that should be generalized
5. Declaration merging alone is insufficient — we need runtime behavior, not just types

## Success Criteria

1. `@loro-extended/reactive` package exports `REACTIVE`, `ReactiveSubscribe`, `Reactive`, `LocalRef`, `isReactive`
2. `@loro-extended/kinetic` re-exports from `reactive` and uses for compiler detection
3. `@loro-extended/change` imports from `reactive` and implements `[REACTIVE]` on all refs
4. Compiler detects reactivity via `isTypeAssignableTo(type, Reactive)`
5. Runtime uses `[REACTIVE]` function uniformly — no Loro special cases
6. All existing tests pass
7. New tests verify symbol-based detection and `LocalRef` behavior

## The Gap

| Aspect | Current | Target |
|--------|---------|--------|
| Reactive detection | Hardcoded `LORO_REF_TYPES` set | `isTypeAssignableTo(type, Reactive)` |
| Runtime subscribe | Uses `loro()` for Loro refs | Uses `ref[REACTIVE](ref, callback)` uniformly |
| Local state | None (must use Loro) | `LocalRef<T>` class |
| Custom reactives | Not possible | Any type with `[REACTIVE]` function |
| Type sharing | N/A — types hardcoded | Shared `@loro-extended/reactive` package |

## Core Type Definitions

### Reactive Symbol and Subscribe Function

```typescript
// @loro-extended/reactive/src/index.ts

/**
 * Symbol key for reactive subscribe functions.
 * 
 * Uses Symbol.for() to ensure the same symbol across packages at runtime.
 * The shared package ensures the same TypeScript type across packages.
 */
export const REACTIVE = Symbol.for('kinetic:reactive')

/**
 * Subscribe function signature for reactive types.
 * 
 * @param self - The reactive instance to subscribe to
 * @param callback - Called when the value changes (no arguments)
 * @returns Unsubscribe function
 */
export type ReactiveSubscribe = (
  self: unknown,
  callback: () => void
) => () => void

/**
 * A type that is reactive in Kinetic.
 * 
 * The presence of [REACTIVE] marks the type as reactive for the compiler.
 * The function value provides runtime subscription behavior.
 */
export interface Reactive {
  readonly [REACTIVE]: ReactiveSubscribe
}

/**
 * Type guard for reactive objects.
 */
export function isReactive(value: unknown): value is Reactive {
  return (
    value !== null &&
    typeof value === 'object' &&
    REACTIVE in value &&
    typeof (value as any)[REACTIVE] === 'function'
  )
}
```

### LocalRef

```typescript
// @loro-extended/reactive/src/index.ts (continued)

/**
 * A reactive reference for UI-only state.
 * 
 * Unlike Loro refs, LocalRef is:
 * - Not synced across clients
 * - Not persisted
 * - Purely local to this runtime instance
 * 
 * Use for ephemeral UI state: animation progress, open/closed states,
 * hover states, scroll positions, etc.
 * 
 * @example
 * ```typescript
 * const isOpen = new LocalRef(false)
 * 
 * button({ onClick: () => isOpen.set(!isOpen.get()) }, "Toggle")
 * 
 * if (isOpen.get()) {
 *   dropdown(...)
 * }
 * ```
 */
export class LocalRef<T> implements Reactive {
  readonly [REACTIVE] = (self: LocalRef<T>, callback: () => void) => {
    self.listeners.add(callback)
    return () => self.listeners.delete(callback)
  }
  
  private value: T
  private listeners = new Set<() => void>()
  
  constructor(initial: T) {
    this.value = initial
  }
  
  get(): T {
    return this.value
  }
  
  set(newValue: T): void {
    if (this.value === newValue) return
    this.value = newValue
    for (const listener of this.listeners) {
      listener()
    }
  }
  
  /** Convenience method — equivalent to this[REACTIVE](this, callback) */
  subscribe(callback: () => void): () => void {
    return this[REACTIVE](this, callback)
  }
}
```

### Loro Integration (in @loro-extended/change)

```typescript
// In @loro-extended/change — imports from @loro-extended/reactive
import { REACTIVE, type ReactiveSubscribe } from "@loro-extended/reactive"

// TextRef implementation
export class TextRef extends TypedRef<TextContainerShape> implements Reactive {
  readonly [REACTIVE]: ReactiveSubscribe = (self, callback) => {
    const container = (self as TextRef)[INTERNAL_SYMBOL].getContainer()
    return container.subscribe(() => callback())
  }
  
  // ... rest of implementation
}

// Similar for CounterRef, ListRef, etc.
```

### Runtime Usage

```typescript
// In @loro-extended/kinetic/src/runtime/subscribe.ts
import { REACTIVE, type Reactive } from "@loro-extended/reactive"

export function __subscribe(ref: Reactive, handler: () => void, scope: Scope) {
  const unsubscribe = ref[REACTIVE](ref, handler)
  scope.onDispose(unsubscribe)
  return subscriptionId
}
```

## Phases and Tasks

### Phase 0: Create @loro-extended/reactive Package ✅

**Goal**: Create the shared reactive primitives package.

- ✅ Task 0.1: Create `packages/reactive/` directory structure
- ✅ Task 0.2: Create `packages/reactive/package.json` with minimal deps
- ✅ Task 0.3: Create `packages/reactive/tsconfig.json`
- ✅ Task 0.4: Create `packages/reactive/src/index.ts` with `REACTIVE` symbol
- ✅ Task 0.5: Define `ReactiveSubscribe` type
- ✅ Task 0.6: Define `Reactive` interface
- ✅ Task 0.7: Implement `isReactive()` type guard
- ✅ Task 0.8: Add unit tests for symbol identity and type guard
- ✅ Task 0.9: Add to workspace `pnpm-workspace.yaml` if needed (not needed — `packages/*` already included)

### Phase 1: Implement LocalRef ✅

**Goal**: Provide UI-only reactive state with subscribe function.

- ✅ Task 1.1: Implement `LocalRef<T>` class in `packages/reactive/src/index.ts`
- ✅ Task 1.2: Implement `[REACTIVE]` subscribe function on LocalRef
- ✅ Task 1.3: Implement `get()`, `set()`, `subscribe()` methods
- ✅ Task 1.4: Ensure `set()` only notifies if value changed (`===` check)
- ✅ Task 1.5: Add unit tests for LocalRef behavior (11 tests)

### Phase 2: Update @loro-extended/kinetic (partial) ⚠️

**Goal**: Kinetic re-exports from reactive and uses for detection.

- ✅ Task 2.1: Add `@loro-extended/reactive` as dependency
- ✅ Task 2.2: Re-export `REACTIVE`, `ReactiveSubscribe`, `Reactive`, `LocalRef`, `isReactive` from index
- ⚠️ Task 2.3-2.7: Implemented with symbol property detection (blocked by Phase 3)

**Note**: Phase 2 compiler detection is blocked until Phase 3 adds `[REACTIVE]` to the change package types. The compiler tests import from `@loro-extended/change` which doesn't have `[REACTIVE]` yet.

### Phase 3: Update @loro-extended/change ✅

**Goal**: Loro refs implement Reactive interface from shared package.

- ✅ Task 3.1: Add `@loro-extended/reactive` as dependency
- ✅ Task 3.2: Add `[REACTIVE]` function to `TextRef` (via TypedRef base class)
- ✅ Task 3.3: Add `[REACTIVE]` function to `CounterRef` (via TypedRef base class)
- ✅ Task 3.4: Add `[REACTIVE]` function to `ListRef`, `MovableListRef` (via TypedRef base class)
- ✅ Task 3.5: Add `[REACTIVE]` function to `RecordRef`, `StructRef` (StructRef via Proxy handler)
- ✅ Task 3.6: Add `[REACTIVE]` function to `TreeRef` (via TypedRef base class)
- ✅ Task 3.7: Add `[REACTIVE]` function to `PlainValueRef` (via factory)
- ✅ Task 3.8: Re-export `REACTIVE` from index (for advanced users)
- ✅ Task 3.9: Add tests verifying `[REACTIVE]` presence on all ref types (23 tests)

### Phase 4: Complete Compiler Detection ✅

**Goal**: Pure structural detection using `isTypeAssignableTo`. No fallbacks, no hardcoded type names.

- ✅ Task 4.1: Use `skipFileDependencyResolution: true` + manual `resolveAndAddModule` for external packages
- ✅ Task 4.2: Create `resolveReactiveImports()` to add `@loro-extended/*` declaration files to the project
- ✅ Task 4.3: Find existing `Reactive` interface in project via `getReactiveInterfaceType()`
- ✅ Task 4.4: Use `checker.isTypeAssignableTo(candidateType, reactiveType)` for detection
- ✅ Task 4.5: Cache interface node (not compiler type) to survive TypeChecker invalidation
- ✅ Task 4.6: Handle union types (reactive if any branch is reactive)
- ✅ Task 4.7: Exclude `any`/`unknown` from reactive detection
- ✅ Task 4.8: Update integration tests to import real types from `@loro-extended/change`
- ✅ Task 4.9: Update analyze tests to share a single `Reactive` interface across mock types
- ✅ Task 4.10: All 593 kinetic tests passing, all 935 change tests passing

### Phase 5: Update Runtime Subscribe ⛔ SUPERSEDED

> **Superseded by [delta-driven-reactivity.md](./delta-driven-reactivity.md).**
> The original Phase 5 proposed updating `__subscribe` to use `ref[REACTIVE](ref, () => void)` — a uniform but delta-unaware callback. The delta-driven plan replaces this with a delta-aware callback (`(delta: ReactiveDelta) => void`) that carries structured change information, enabling O(k) DOM patching for text, lists, maps, and trees.

### Phase 6: Documentation ⛔ SUPERSEDED

> **Superseded by [delta-driven-reactivity.md](./delta-driven-reactivity.md) Phase 6.**
> Documentation tasks are covered by the delta-driven plan, which documents the three-level binding-time lattice (`literal < render < reactive`) with delta kind as an **orthogonal property** on reactive dependencies, and the `ReactiveDelta` type system.

## Tests

### Phase 0: Reactive Package

```typescript
// packages/reactive/src/index.test.ts

describe("REACTIVE symbol", () => {
  it("returns same symbol via Symbol.for across modules", () => {
    const sym1 = Symbol.for('kinetic:reactive')
    const sym2 = Symbol.for('kinetic:reactive')
    expect(sym1).toBe(sym2)
    expect(sym1).toBe(REACTIVE)
  })
})

describe("isReactive", () => {
  it("returns true for objects with REACTIVE function", () => {
    const obj = {
      [REACTIVE]: (self: unknown, cb: () => void) => () => {}
    }
    expect(isReactive(obj)).toBe(true)
  })
  
  it("returns false for objects without REACTIVE", () => {
    const obj = { subscribe: () => () => {} }
    expect(isReactive(obj)).toBe(false)
  })
  
  it("returns false for objects with non-function REACTIVE", () => {
    const obj = { [REACTIVE]: true }
    expect(isReactive(obj)).toBe(false)
  })
})
```

### Phase 1: LocalRef

```typescript
// packages/reactive/src/index.test.ts (continued)

describe("LocalRef", () => {
  it("stores and retrieves value", () => {
    const ref = new LocalRef(42)
    expect(ref.get()).toBe(42)
    ref.set(100)
    expect(ref.get()).toBe(100)
  })

  it("has REACTIVE function", () => {
    const ref = new LocalRef("test")
    expect(typeof ref[REACTIVE]).toBe("function")
  })

  it("REACTIVE function subscribes to changes", () => {
    const ref = new LocalRef(0)
    const callback = vi.fn()
    
    const unsub = ref[REACTIVE](ref, callback)
    ref.set(1)
    
    expect(callback).toHaveBeenCalledTimes(1)
    unsub()
  })

  it("notifies subscribers on set", () => {
    const ref = new LocalRef("initial")
    const callback = vi.fn()
    ref.subscribe(callback)
    
    ref.set("updated")
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it("unsubscribes correctly", () => {
    const ref = new LocalRef(0)
    const callback = vi.fn()
    const unsub = ref.subscribe(callback)
    
    unsub()
    ref.set(1)
    
    expect(callback).not.toHaveBeenCalled()
  })

  it("does not notify if value unchanged", () => {
    const ref = new LocalRef("same")
    const callback = vi.fn()
    ref.subscribe(callback)
    
    ref.set("same")
    expect(callback).not.toHaveBeenCalled()
  })
  
  it("implements Reactive interface", () => {
    const ref = new LocalRef(0)
    expect(isReactive(ref)).toBe(true)
  })
})
```

### Phase 2: Compiler Detection

```typescript
// packages/kinetic/src/compiler/analyze.test.ts

describe("symbol-based reactive detection", () => {
  it("detects LocalRef as reactive", () => {
    const source = `
      import { LocalRef } from "@loro-extended/reactive"
      const isOpen = new LocalRef(false)
      div(isOpen.get() ? "Open" : "Closed")
    `
    const ir = compile(source)
    const content = ir[0].children[0]
    expect(content.isReactive).toBe(true)
  })

  it("detects custom type with REACTIVE as reactive", () => {
    const source = `
      import { REACTIVE, type ReactiveSubscribe } from "@loro-extended/reactive"
      
      class MyReactive {
        [REACTIVE]: ReactiveSubscribe = (self, cb) => () => {}
        get() { return 42 }
      }
      
      const custom = new MyReactive()
      div(custom.get())
    `
    const ir = compile(source)
    const content = ir[0].children[0]
    expect(content.isReactive).toBe(true)
  })

  it("does not detect unbranded subscribable as reactive", () => {
    const source = `
      class NotReactive {
        subscribe(cb: () => void) { return () => {} }
        get() { return 42 }
      }
      const obj = new NotReactive()
      div(obj.get())
    `
    const ir = compile(source)
    const content = ir[0].children[0]
    expect(content.isReactive).toBe(false)
  })
})
```

### Phase 3: Runtime Integration

```typescript
// packages/kinetic/src/runtime/subscribe.test.ts

describe("function-based runtime subscription", () => {
  it("__subscribe uses REACTIVE function", () => {
    const ref = new LocalRef(0)
    const scope = new Scope("test")
    const callback = vi.fn()
    
    __subscribe(ref, callback, scope)
    ref.set(1)
    
    expect(callback).toHaveBeenCalled()
  })

  it("cleans up on scope dispose", () => {
    const ref = new LocalRef(0)
    const scope = new Scope("test")
    const callback = vi.fn()
    
    __subscribe(ref, callback, scope)
    scope.dispose()
    ref.set(1)
    
    expect(callback).not.toHaveBeenCalled()
  })

  it("works with custom reactive type", () => {
    const customRef = {
      value: 0,
      listeners: new Set<() => void>(),
      [REACTIVE]: (self: typeof customRef, cb: () => void) => {
        self.listeners.add(cb)
        return () => self.listeners.delete(cb)
      }
    }
    
    const scope = new Scope("test")
    const callback = vi.fn()
    
    __subscribe(customRef, callback, scope)
    customRef.value = 1
    customRef.listeners.forEach(l => l())
    
    expect(callback).toHaveBeenCalled()
  })
})
```

### Phase 4: Loro Integration

```typescript
// packages/change/src/reactive.test.ts

describe("Loro refs have REACTIVE function", () => {
  it("TextRef has REACTIVE", () => {
    const doc = createTypedDoc(Shape.doc({ title: Shape.text() }))
    expect(isReactive(doc.title)).toBe(true)
  })

  it("CounterRef has REACTIVE", () => {
    const doc = createTypedDoc(Shape.doc({ count: Shape.counter() }))
    expect(isReactive(doc.count)).toBe(true)
  })

  it("ListRef has REACTIVE", () => {
    const doc = createTypedDoc(Shape.doc({ items: Shape.list(Shape.plain.string()) }))
    expect(isReactive(doc.items)).toBe(true)
  })

  it("REACTIVE function triggers on changes", () => {
    const doc = createTypedDoc(Shape.doc({ count: Shape.counter() }))
    const callback = vi.fn()
    
    const unsub = doc.count[REACTIVE](doc.count, callback)
    doc.count.increment(1)
    loro(doc).commit()
    
    expect(callback).toHaveBeenCalled()
    unsub()
  })
  
  it("PlainValueRef has REACTIVE", () => {
    const doc = createTypedDoc(Shape.doc({ 
      meta: Shape.struct({ name: Shape.plain.string() }) 
    }))
    expect(isReactive(doc.meta.name)).toBe(true)
  })
})
```

## Transitive Effect Analysis

### Package Dependency Graph (After)

```
@loro-extended/reactive  (NEW - no dependencies)
    ↑
    ├── @loro-extended/change (imports REACTIVE, Reactive)
    │       ↑
    │       └── @loro-extended/kinetic (imports change for tests)
    │
    └── @loro-extended/kinetic (imports REACTIVE, Reactive; re-exports all)
```

### Direct Dependencies

| File | Change | Risk |
|------|--------|------|
| `reactive/src/index.ts` | New file | Low — new package |
| `reactive/package.json` | New file | Low — new package |
| `kinetic/package.json` | Add reactive dep | Low — additive |
| `kinetic/src/index.ts` | Re-export from reactive | Low — additive |
| `kinetic/src/compiler/analyze.ts` | Replace type detection | Medium — core compiler logic |
| `kinetic/src/runtime/subscribe.ts` | Use `[REACTIVE]`, remove `loro()` | Medium — core runtime |
| `change/package.json` | Add reactive dep | Low — additive |
| `change/src/typed-refs/*.ts` | Add `[REACTIVE]` function | Medium — all typed refs |
| `change/src/plain-value-ref/factory.ts` | Add `[REACTIVE]` to Proxy | Medium — Proxy handler |

### Transitive Dependencies

| File | Depends On | Impact |
|------|------------|--------|
| `kinetic/compiler/analyze.test.ts` | `analyze.ts` | Must verify symbol detection |
| `kinetic/compiler/integration.test.ts` | Full pipeline | Must verify LocalRef works end-to-end |
| `kinetic/runtime/subscribe.test.ts` | `subscribe.ts` | Must test function-based subscription |
| `kinetic/runtime/regions.ts` | `subscribe.ts` | Should work unchanged (uses `__subscribe`) |
| `change/src/*.test.ts` | Ref implementations | Must verify `[REACTIVE]` presence |

### Breaking Change Assessment

**No breaking changes to public API.**

- New `@loro-extended/reactive` package is additive
- `REACTIVE`, `ReactiveSubscribe`, `LocalRef` are new exports
- Loro refs gain `[REACTIVE]` property (additive)
- Existing code using Loro refs continues to work

**Internal breaking change:**
- `LORO_REF_TYPES` removal changes compiler internals
- `loro()` removal from subscribe.ts changes runtime internals

### Risk: Loro Container Subscription Signature

Loro's `container.subscribe(callback)` passes an event to the callback. Our `ReactiveSubscribe` uses `() => void`. The Loro implementation must wrap:

```typescript
[REACTIVE] = (self, callback) => {
  const container = this[INTERNAL_SYMBOL].getContainer()
  return container.subscribe(() => callback())  // Wrap to discard event
}
```

### Risk: PlainValueRef Proxy Complexity

`PlainValueRef` is a Proxy-based object. Adding `[REACTIVE]` requires:

1. Adding the symbol to the Proxy `get` trap
2. Implementing subscription that filters by path

```typescript
// In factory.ts proxy handler
get(target, prop) {
  if (prop === REACTIVE) {
    return (self: PlainValueRef<T>, callback: () => void) => {
      const container = target[PARENT_INTERNALS_SYMBOL].getContainer()
      const path = target[PATH_SYMBOL]
      return container.subscribe((event) => {
        // TODO: Filter events by path for efficiency
        callback()
      })
    }
  }
  // ... rest of handler
}
```

## Resources for Implementation

### Files to Create

- `packages/reactive/package.json`
- `packages/reactive/tsconfig.json`
- `packages/reactive/src/index.ts` — `REACTIVE`, `ReactiveSubscribe`, `Reactive`, `LocalRef`, `isReactive`
- `packages/reactive/src/index.test.ts`

### Files to Modify

- `packages/kinetic/package.json` — Add reactive dependency
- `packages/kinetic/src/index.ts` — Re-export from reactive
- `packages/kinetic/src/compiler/analyze.ts` — Symbol-based detection
- `packages/kinetic/src/runtime/subscribe.ts` — Use `[REACTIVE]`, remove `loro()`
- `packages/change/package.json` — Add reactive dependency
- `packages/change/src/typed-refs/text-ref.ts` — Add `[REACTIVE]`
- `packages/change/src/typed-refs/counter-ref.ts` — Add `[REACTIVE]`
- `packages/change/src/typed-refs/list-ref.ts` — Add `[REACTIVE]`
- `packages/change/src/typed-refs/movable-list-ref.ts` — Add `[REACTIVE]`
- `packages/change/src/typed-refs/record-ref.ts` — Add `[REACTIVE]`
- `packages/change/src/typed-refs/struct-ref.ts` — Add `[REACTIVE]`
- `packages/change/src/typed-refs/tree-ref.ts` — Add `[REACTIVE]`
- `packages/change/src/plain-value-ref/factory.ts` — Add `[REACTIVE]` to Proxy
- `packages/change/src/index.ts` — Re-export `REACTIVE`

### Files for Reference

- `packages/change/src/plain-value-ref/types.ts` — PlainValueRef interface
- `packages/change/src/typed-refs/base.ts` — Base ref implementation
- `packages/kinetic/TECHNICAL.md` — Architecture context

### Key Code Section: Current Detection (to be replaced)

```typescript
// packages/kinetic/src/compiler/analyze.ts L197-220
const LORO_REF_TYPES = new Set([
  "TextRef",
  "CounterRef",
  "ListRef",
  // ... etc
])

export function isReactiveType(type: Type): boolean {
  const symbol = type.getSymbol()
  if (symbol) {
    const name = symbol.getName()
    if (LORO_REF_TYPES.has(name)) {
      return true
    }
  }
  // ... more checks
}
```

### Key Code Section: New Detection (target)

```typescript
// packages/kinetic/src/compiler/analyze.ts
import { Reactive } from "@loro-extended/reactive"
import * as ts from "typescript"

// Cache the Reactive interface type
let reactiveType: Type | undefined

function getReactiveType(checker: TypeChecker): ts.Type {
  if (!reactiveType) {
    // Get the Reactive interface type from the project
    // This requires the reactive package to be in the project's dependencies
    // Implementation details TBD based on ts-morph capabilities
  }
  return reactiveType
}

export function isReactiveType(type: Type): boolean {
  const tsChecker = type.compilerType.checker // or however we access it
  const reactiveType = getReactiveType(tsChecker)
  return tsChecker.isTypeAssignableTo(type.compilerType, reactiveType)
}
```

### Key Code Section: Current Subscribe (to be replaced)

```typescript
// packages/kinetic/src/runtime/subscribe.ts
import { loro } from "@loro-extended/change"

export function __subscribe(ref: unknown, handler, scope) {
  const container = loro(ref as any) as Subscribable
  const unsubscribe = container.subscribe(handler)
  // ...
}
```

### Key Code Section: New Subscribe (target)

```typescript
// packages/kinetic/src/runtime/subscribe.ts
import { REACTIVE, type Reactive } from "@loro-extended/reactive"

export function __subscribe(
  ref: Reactive,
  handler: () => void,
  scope: Scope
): SubscriptionId {
  const id = ++subscriptionIdCounter
  
  const unsubscribe = ref[REACTIVE](ref, handler)
  
  __activeSubscriptions.set(id, { ref, unsubscribe })
  scope.onDispose(() => __unsubscribe(id))
  
  return id
}
```

## Changeset

```
---
"@loro-extended/reactive": minor
"@loro-extended/kinetic": minor
"@loro-extended/change": minor
---

Add reactive primitive system for extensible reactivity

@loro-extended/reactive (NEW):
- `REACTIVE` symbol for marking types as Kinetic-reactive
- `ReactiveSubscribe` type defining the subscribe function signature
- `Reactive` interface for reactive types
- `LocalRef<T>` class for UI-only reactive state
- `isReactive()` type guard

@loro-extended/kinetic:
- Re-exports all from `@loro-extended/reactive`
- Updated compiler to detect reactivity via `isTypeAssignableTo(type, Reactive)`
- Updated runtime to use `[REACTIVE]` function uniformly (no Loro special cases)

@loro-extended/change:
- Added `[REACTIVE]` subscribe function to all ref types (TextRef, CounterRef, ListRef, etc.)
- Added `[REACTIVE]` to PlainValueRef via Proxy handler
- Re-exported `REACTIVE` symbol for advanced usage
```

## TECHNICAL.md Updates

Add new section after "Reactive Detection":

```markdown
### Reactive Primitives

Kinetic uses a **reactive subscribe function** pattern to identify and interact with reactive values. The `REACTIVE` symbol marks a type as reactive, and its value is a function that subscribes to changes:

```typescript
import { REACTIVE, type ReactiveSubscribe, type Reactive } from '@loro-extended/kinetic'

// The subscribe function signature
type ReactiveSubscribe = (self: unknown, callback: () => void) => () => void

// A reactive type has a REACTIVE function
interface Reactive {
  readonly [REACTIVE]: ReactiveSubscribe
}
```

The `[REACTIVE]` property answers one question: **"How do I subscribe to changes on this object?"**

#### Why a Function?

The function pattern provides:

1. **Type-level detection** — compiler checks for `[REACTIVE]` property
2. **Runtime behavior** — each type defines its own subscribe logic
3. **No special cases** — runtime uses the function uniformly
4. **Cross-package compatibility** — shared package ensures type identity
5. **Minimal surface** — just a function, not an object with methods

#### Built-in Reactive Types

**Loro refs** — All `@loro-extended/change` ref types have `[REACTIVE]` functions. The function wraps Loro's container subscription internally.

**LocalRef** — For UI-only state:

```typescript
import { LocalRef } from '@loro-extended/kinetic'

const isOpen = new LocalRef(false)

button({ onClick: () => isOpen.set(!isOpen.get()) }, "Menu")

if (isOpen.get()) {
  dropdown(...)
}
```

#### Custom Reactive Types

Create custom reactive types by implementing the `Reactive` interface:

```typescript
import { REACTIVE, type Reactive, type ReactiveSubscribe } from '@loro-extended/kinetic'

class DerivedRef<T> implements Reactive {
  readonly [REACTIVE]: ReactiveSubscribe = (self, callback) => {
    const unsubs = this.sources.map(s => s[REACTIVE](s, callback))
    return () => unsubs.forEach(u => u())
  }
  
  constructor(
    private sources: Reactive[],
    private compute: () => T
  ) {}
  
  get(): T {
    return this.compute()
  }
}
```

#### Runtime Subscription

The runtime uses the function uniformly:

```typescript
function __subscribe(ref: Reactive, handler: () => void, scope: Scope) {
  const unsubscribe = ref[REACTIVE](ref, handler)
  scope.onDispose(unsubscribe)
}
```

No special cases for Loro vs LocalRef vs custom types — the function handles everything.
```

## Learnings

### Symbol.for Solves Runtime Identity, Not Type Identity

We originally assumed that `Symbol.for('kinetic:reactive')` would allow packages to independently define the same symbol and have TypeScript treat them as compatible. **This is false.**

**Runtime**: `Symbol.for()` guarantees the same symbol instance across packages in the same JavaScript realm. ✅

**Compile-time**: TypeScript's `unique symbol` types are nominally typed. Two separate `const REACTIVE = Symbol.for(...)` declarations create incompatible types. ❌

```typescript
// Package A
const REACTIVE = Symbol.for('kinetic:reactive')  // type: unique symbol (A)

// Package B  
const REACTIVE = Symbol.for('kinetic:reactive')  // type: unique symbol (B)

// A ≠ B at compile time, even though they're identical at runtime
```

**Solution**: Extract a shared `@loro-extended/reactive` package that both `kinetic` and `change` import from. This ensures TypeScript sees the exact same symbol type.

### Function > Descriptor Object > Boolean Brand

We iterated through three designs:

1. **Boolean brand** (`[REACTIVE]: true`) — marks type but doesn't tell runtime how to subscribe
2. **Descriptor object** (`[REACTIVE]: { get, subscribe }`) — works but `get()` is unnecessary
3. **Function** (`[REACTIVE]: (self, cb) => unsub`) — minimal, the subscribe function IS the descriptor

The function approach is ideal because:
- Subscription is the only runtime behavior needed
- Value access happens via the type's own `.get()` method (codegen handles this)
- Simpler mental model: "REACTIVE tells you how to subscribe"

### Callback Signature is `() => void`

The subscribe callback takes no arguments. This differs from Loro's event-based subscription and RxJS's value-passing subscription, providing additional disambiguation and simplicity.

Loro's implementation wraps its subscription: `container.subscribe(() => callback())` — discarding the event since Kinetic re-reads via `.get()`.

### Why `self` Parameter?

The subscribe function receives `self` rather than closing over it:

```typescript
// Why this:
[REACTIVE] = (self, callback) => { ... }

// Not this:
[REACTIVE] = (callback) => { /* use `this` */ }
```

This allows the function to be defined once on a prototype and work for all instances, avoiding per-instance function allocation.

### ts-morph `isTypeAssignableTo` for Structural Checking

The compiler can detect reactivity using TypeScript's structural type system:

```typescript
const tsChecker = project.getTypeChecker().compilerObject as ts.TypeChecker
const isReactive = tsChecker.isTypeAssignableTo(exprType, reactiveInterfaceType)
```

This works because:
- Both packages import `Reactive` from the same `@loro-extended/reactive` package
- TypeScript sees the same symbol type in both contexts
- Structural compatibility check confirms the type has `[REACTIVE]`

### Phase Ordering: Types Before Detection

The compiler detection depends on the `@loro-extended/change` types having `[REACTIVE]`. The transform tests use the real filesystem and import real types from `@loro-extended/change`. Until those types have `[REACTIVE]`, the structural detection will fail.

**Correct order** (validated):
1. Phase 3: Add `[REACTIVE]` to `@loro-extended/change` types
2. Phase 4: Complete compiler detection with real types
3. Phase 5: Update runtime to use `[REACTIVE]` uniformly

### Manual Module Resolution for ts-morph

The key discovery: ts-morph with `skipFileDependencyResolution: true` allows fast project creation while still supporting full type analysis. The trick is to manually resolve external packages:

```typescript
const project = new Project({
  useInMemoryFileSystem: false,
  skipFileDependencyResolution: true,
  compilerOptions: { moduleResolution: ts.ModuleResolutionKind.Bundler },
})

// Manually resolve and add external declaration files
const resolved = ts.resolveModuleName(
  "@loro-extended/change",
  sourceFile.getFilePath(),
  compilerOptions,
  project.getModuleResolutionHost()
).resolvedModule

project.addSourceFileAtPath(resolved.resolvedFileName)
project.resolveSourceFileDependencies()
```

This gives us the best of both worlds: fast project creation (no tsconfig loading) and full type analysis of external packages.

### isTypeAssignableTo Works — With Caveats

Using `checker.isTypeAssignableTo(candidateType, reactiveType)` is the correct approach, but with important caveats:

1. **Cache the interface node, not the compiler type.** Calling `resolveSourceFileDependencies()` multiple times invalidates the TypeChecker. Caching the `ts.Type` object makes it stale. Instead, cache the `InterfaceDeclaration` node and call `.getType().compilerType` each time to get a fresh type.

2. **`any` is assignable to everything.** Undeclared identifiers have type `any`, which passes `isTypeAssignableTo`. Explicitly check for and exclude `any` and `unknown`.

3. **Handle unions explicitly.** `LocalRef<T> | null` is not assignable to `Reactive` (because `null` isn't). Check union branches individually.

4. **Find the existing Reactive interface.** Don't create a new probe interface — a re-imported `unique symbol` creates a distinct type. Find the `Reactive` interface that's already in the project's type graph.

### Hybrid Detection is Wrong

**Mistake**: The initial Phase 2 implementation used a "hybrid" approach:
1. Try to detect `[REACTIVE]` via symbol property name heuristics
2. Fall back to hardcoded type names (`KNOWN_REACTIVE_TYPES`)

**Why it's wrong**: If we're still falling back to hardcoded type names, we haven't achieved the goal. The symbol-based design exists precisely to eliminate hardcoded type lists.

**Correct approach**: Use TypeScript's `isTypeAssignableTo` directly. Load the `Reactive` interface type from the project's type system and check if candidate types are assignable to it. No fallbacks, no hardcoded names — pure structural typing.

```typescript
// WRONG (hybrid):
function isReactiveType(type: Type): boolean {
  if (hasSymbolProperty(type, "kinetic:reactive")) return true
  if (KNOWN_REACTIVE_TYPES.has(typeName)) return true  // ❌ Defeats the purpose
  ...
}

// RIGHT (pure structural):
function isReactiveType(type: Type): boolean {
  const reactiveType = getReactiveInterfaceType(project)
  return tsChecker.isTypeAssignableTo(type.compilerType, reactiveType)
}
```

### PlainValueRef Requires Special Handling

`PlainValueRef` is not a class—it's a Proxy created by a factory. Adding `[REACTIVE]` requires:

1. Modifying the Proxy `get` trap to return a subscribe function for `REACTIVE`
2. The subscribe function must access the parent container via `[PARENT_INTERNALS_SYMBOL]`
3. Ideally, filter subscription events by path for efficiency (optional optimization)

This is more complex than class-based refs but follows the same pattern.

### ts-morph External Type Resolution — Solved

When ts-morph creates a Project without `tsConfigFilePath`, it can parse imports but cannot fully resolve external package types. The TypeChecker returns empty results for properties.

**Solution**: Use `skipFileDependencyResolution: true` and manually resolve + add declaration files using `ts.resolveModuleName()`. This is fast (no tsconfig overhead) and gives full type analysis. See "Manual Module Resolution for ts-morph" above.

### ts-morph `type.getProperties()` Does NOT Return Symbol-Keyed Properties

When inspecting types via ts-morph:

```typescript
const type = expr.getType()
type.getProperties()  // Returns [] for symbol-keyed properties!
```

Symbol-keyed properties are hidden from ts-morph's API. To access them, you must use the underlying TypeScript compiler API:

```typescript
const tsChecker = (type as any)._context?.typeChecker?.compilerObject
const properties = tsChecker.getPropertiesOfType(type.compilerType)
```

Symbol properties appear with mangled names like `__@REACTIVE@123` or `__@kinetic@reactive@456`.

**However**, this is fragile and version-dependent. The correct approach is to use `isTypeAssignableTo` instead of inspecting properties directly.

### TypeScript Version Conflicts in ts-morph

ts-morph bundles its own TypeScript version (`@ts-morph/common`). Casting between ts-morph's types and the project's TypeScript types can fail:

```typescript
// This fails with type incompatibility errors:
import type * as ts from "typescript"
const tsType = type.compilerType as ts.Type  // ❌ Type error

// Solution: cast through unknown
const tsType = type.compilerType as unknown
const tsChecker = ... as unknown
```

### JSDoc Nested Comment Pitfall

esbuild's parser fails on nested `/* */` comments in JSDoc:

```typescript
/**
 * @example
 * return () => { /* unsubscribe */ }  // ❌ Parse error
 */
```

Avoid nested block comments in JSDoc examples. Use `// comment` or omit the inner comment.