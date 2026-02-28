# Plan: Kinetic — Consistent ListRef Iteration with Ref Preservation

## Background

Kinetic's promise is "Write natural TypeScript. Compile to O(k) delta-driven DOM." When users write:

```typescript
for (const itemRef of doc.todos) {
  const item = itemRef.get()
  li({ onClick: () => itemRef.set(item.toUpperCase()) }, item)
}
```

They expect `itemRef` to be a `PlainValueRef<string>` that supports both reading (`.get()`) and writing (`.set()`). This pattern is essential for:

1. **Component composition**: Passing refs to child components for two-way binding
2. **Event handlers**: Modifying the item without needing the root `doc` object
3. **Encapsulation**: Components don't need to know their position in the document tree

The `@loro-extended/change` package correctly implements this — iterating over a `ListRef<T>` with `for...of` returns `PlainValueRef<T>` (outside of `change()` blocks) or the raw value (inside `change()` blocks for ergonomic mutation).

## Problem Statement

The Kinetic runtime and HTML codegen **break this contract** by using `.toArray()` instead of the typed ref's API:

**DOM Runtime (`packages/kinetic/src/runtime/regions.ts`):**
```typescript
const loroList = loro(listRef)  // Unwraps to raw LoroList
const initialItems = loroList.toArray() as T[]  // Returns raw values!
for (let i = 0; i < initialItems.length; i++) {
  const item = initialItems[i]  // Plain string, not PlainValueRef
  handlers.create(item, i)
}
```

**HTML Codegen (`packages/kinetic/src/compiler/codegen/html.ts`):**
```typescript
// Generates:
${doc.todos.toArray().map((itemRef, _i) => { ... })}
// itemRef is a plain string, not a PlainValueRef!
```

**Additionally**, delta inserts pass raw values from Loro events:
```typescript
const items = delta.insert as T[]  // Raw values from Loro
insertItemAt(parent, state, handlers, items[i], index + i)  // Inconsistent!
```

**Consequences:**
1. `itemRef.get()` fails at runtime: "itemRef.get is not a function"
2. Type system lies: TypeScript says `PlainValueRef<string>`, runtime gives `string`
3. Component pattern broken: Can't pass refs for two-way binding
4. **Inconsistent API**: Initial render and delta inserts provide different types

## Success Criteria

1. **Consistent ref type**: Both initial render AND delta inserts provide `PlainValueRef<T>` for value shapes
2. **Iterator not needed**: Use `listRef.get(index)` which returns the correct type
3. **Existing tests pass**: No regression in current functionality
4. **kinetic-todo works**: The example app compiles and runs with `itemRef.get()` pattern
5. **Testable pure functions**: Separate planning logic from DOM manipulation (FC/IS)

## The Gap

| Aspect | Current State | Target State |
|--------|---------------|--------------|
| DOM initial render | `loroList.toArray()` → raw values | `listRef.get(i)` → refs |
| DOM delta insert | Raw values from event | `listRef.get(index)` → refs |
| HTML codegen | `.toArray().map()` → raw values | `[...listRef].map()` → refs |
| Architecture | Mixed pure/imperative | FC/IS separation |
| Type/runtime match | Types say ref, runtime gives raw | Types and runtime match |

## Architecture Decision: Functional Core / Imperative Shell

The current `__listRegion` mixes concerns:
- Data transformation (iterating items)
- DOM manipulation (appendChild)
- Subscription management (__subscribe)

We will refactor to separate:
1. **Functional Core**: Pure functions that compute operations
2. **Imperative Shell**: Executes operations against the DOM

### Operation Type

```typescript
type ListRegionOp<T> = 
  | { kind: "insert"; index: number; item: T }
  | { kind: "delete"; index: number }
```

### Pure Planning Functions

```typescript
// Pure: Plan initial render
function planInitialRender<T>(listRef: { length: number; get(i: number): T }): ListRegionOp<T>[]

// Pure: Plan delta operations
function planDeltaOps<T>(
  listRef: { get(i: number): T },
  event: LoroEventBatch
): ListRegionOp<T>[]
```

### Benefits

1. **Testability**: Plan functions are pure — test without DOM
2. **Consistency**: Both initial and delta use `listRef.get(index)`
3. **Clarity**: Separation between "what to do" and "how to do it"
4. **Debugging**: Log ops to see exactly what's happening

## Phases and Tasks

### Phase 0: Refactor to FC/IS Architecture ✅

Extract pure planning functions from imperative DOM manipulation.

- ✅ **Task 0.1**: Define `ListRegionOp<T>` type
  - `insert`: index + item (ref)
  - `delete`: index only
  - Export from `regions.ts` for testing

- ✅ **Task 0.2**: Extract `planInitialRender<T>` function
  - Pure function: takes listRef, returns `ListRegionOp<T>[]`
  - Uses `listRef.get(i)` to get refs (not `.toArray()`)

- ✅ **Task 0.3**: Extract `planDeltaOps<T>` function
  - Pure function: takes listRef + event, returns `ListRegionOp<T>[]`
  - Uses `listRef.get(index)` after inserts to get refs
  - Only needs insert count from delta, not the raw values

- ✅ **Task 0.4**: Create `executeOp<T>` function
  - Imperative: executes single op against DOM
  - Handles insert (create node, appendChild) and delete (removeChild, dispose)

- ✅ **Task 0.5**: Update `__listRegion` to use new architecture
  - Plan initial render, execute ops
  - Subscribe: plan delta ops, execute ops

- ✅ **Task 0.6**: Write unit tests for pure planning functions
  - Test `planInitialRender` with mock listRef
  - Test `planDeltaOps` with various delta scenarios
  - No DOM needed — pure function tests

### Phase 1: Store listRef in State ✅

- ✅ **Task 1.1**: Add `listRef` to `ListRegionState` interface
  - Required for delta handling to call `listRef.get(index)`

- ✅ **Task 1.2**: Update runtime tests
  - Test: Initial render receives `PlainValueRef` for value shapes
  - Test: Delta insert receives `PlainValueRef` (same type!)
  - Test: `.get()` and `.set()` work on received refs

### Phase 2: HTML Codegen — Use Iterator ✅

- ✅ **Task 2.1**: Update `generateListRegion` in `codegen/html.ts`
  - Change from: `${listSource}.toArray().map((item, i) => { ... })`
  - Change to: `${[...listSource].map((item, i) => { ... })}`
  - Spread syntax uses iterator, which returns refs

- ✅ **Task 2.2**: Write HTML codegen tests
  - Test: Generated code uses spread (not `.toArray()`)
  - Test: Verify code structure is valid JavaScript

### Phase 3: Integration Verification ✅

- ✅ **Task 3.1**: Update kinetic-todo example
  - Restore `const item = itemRef.get()` pattern in `app.ts`
  - Verify SSR renders correctly
  - Verify client-side hydration works
  - Verify event handlers can call `itemRef.set()`

- ✅ **Task 3.2**: Add integration test for ref-based iteration
  - Source: `for (const ref of list) { const v = ref.get(); li(v) }`
  - Verify DOM creates elements with correct content
  - Verify HTML output is correct

## Unit and Integration Tests

### Pure Function Tests (Phase 0)

```typescript
describe("planInitialRender", () => {
  it("should create insert ops for each item", () => {
    const mockListRef = {
      length: 3,
      get: (i: number) => ({ index: i, value: `item${i}` })  // Mock ref
    }
    
    const ops = planInitialRender(mockListRef)
    
    expect(ops).toEqual([
      { kind: "insert", index: 0, item: { index: 0, value: "item0" } },
      { kind: "insert", index: 1, item: { index: 1, value: "item1" } },
      { kind: "insert", index: 2, item: { index: 2, value: "item2" } },
    ])
  })
})

describe("planDeltaOps", () => {
  it("should use listRef.get() for inserts, not raw delta values", () => {
    const mockListRef = {
      get: (i: number) => ({ index: i, isRef: true })
    }
    const event = createMockDeltaEvent([
      { insert: ["raw1", "raw2"] }  // Raw values we should NOT use
    ])
    
    const ops = planDeltaOps(mockListRef, event)
    
    // Should use listRef.get(), not the raw values
    expect(ops[0].item).toEqual({ index: 0, isRef: true })
    expect(ops[1].item).toEqual({ index: 1, isRef: true })
  })
})
```

### Runtime Tests (Phase 1)

```typescript
describe("__listRegion - ref preservation", () => {
  it("should pass PlainValueRef to create handler for initial render", () => {
    // Verify item has .get() and .set() methods
  })

  it("should pass PlainValueRef to create handler for delta inserts", () => {
    // Same type as initial render — consistency!
  })
})
```

### Integration Tests (Phase 3)

```typescript
describe("compiler integration - ref iteration", () => {
  it("should compile and execute ref.get() pattern", () => {
    const source = `
      for (const itemRef of doc.items) {
        const item = itemRef.get()
        li(item)
      }
    `
    // Verify compiles without error
    // Verify DOM renders correctly
  })
})
```

## Transitive Effect Analysis

### Direct Dependencies

1. **`packages/kinetic/src/runtime/regions.ts`** — Major refactor to FC/IS
2. **`packages/kinetic/src/compiler/codegen/html.ts`** — `generateListRegion` function
3. **`packages/kinetic/src/types.ts`** — `ListRegionOp<T>` type addition

### Transitive Dependencies

1. **Compiled code** — All existing compiled Kinetic code calls `__listRegion`. Handlers will now receive refs instead of raw values. **Impact**: Code using `.get()` will now work; code assuming raw values needs update.

2. **kinetic-todo example** — Currently broken. After fix, `itemRef.get()` will work.

3. **Integration tests** — Tests that mock `create` handlers may need updates.

### No Impact Expected

1. **Conditional regions** — Don't iterate over lists
2. **Static loops** — Iterate over non-reactive iterables (not ListRef)
3. **Analysis/IR** — No changes to how list regions are analyzed

## Resources for Implementation

### Files to Modify

1. `packages/kinetic/src/runtime/regions.ts` — FC/IS refactor + ref preservation
2. `packages/kinetic/src/compiler/codegen/html.ts` — `generateListRegion` function
3. `packages/kinetic/src/types.ts` — Add `ListRegionOp<T>` type
4. `examples/kinetic-todo/src/app.ts` — Restore `itemRef.get()` pattern

### Reference Files

1. `packages/change/src/typed-refs/list-ref-base.ts` — `.get(index)` implementation
2. `packages/change/TECHNICAL.md` — PlainValueRef behavior documentation
3. `packages/kinetic/TECHNICAL.md` — Runtime function documentation

## Documentation Updates

### TECHNICAL.md Update (packages/kinetic)

Add to "Runtime Dependencies" section:

```markdown
### List Region Architecture

The `__listRegion` runtime follows Functional Core / Imperative Shell:

**Functional Core** (pure, testable):
- `planInitialRender(listRef)` → `ListRegionOp<T>[]`
- `planDeltaOps(listRef, event)` → `ListRegionOp<T>[]`

**Imperative Shell** (DOM manipulation):
- `executeOp(parent, state, handlers, op)` — applies single operation

Both planning functions use `listRef.get(index)` to obtain refs, ensuring
handlers always receive `PlainValueRef<T>` for value shapes. This enables
the component pattern where refs are passed for two-way binding:

```typescript
for (const itemRef of doc.items) {
  TodoItem({ item: itemRef })  // Component can read AND write
}
```
```

## Changeset

```markdown
---
"@loro-extended/kinetic": minor
---

feat: Preserve PlainValueRef when iterating over ListRef in list regions

List region rendering now uses `listRef.get(index)` instead of `.toArray()`.
This ensures handlers receive `PlainValueRef<T>` for value shapes, enabling
two-way binding patterns:

```typescript
for (const itemRef of doc.todos) {
  const item = itemRef.get()  // Read current value
  li({ onClick: () => itemRef.set(item.toUpperCase()) }, item)  // Can also write!
}
```

**Breaking change**: If your code assumed handlers receive raw values,
you now receive refs. Use `.get()` to access the value.

Architecture improvement: `__listRegion` now uses Functional Core / Imperative
Shell pattern with pure planning functions (`planInitialRender`, `planDeltaOps`)
that are independently testable.
```

## Learnings

### Use `listRef.get(index)`, Not Iterator

Initially we considered using the `for...of` iterator. However, `listRef.get(index)` is better because:
1. Works for both initial render AND delta inserts
2. No need to track iteration state
3. Directly returns the correct type (ref outside `change()`, raw inside)

### Delta Inserts Don't Need Raw Values

The raw values in `delta.insert` are unnecessary — we only need the **count** of inserted items. Then we use `listRef.get(index)` to get refs. This ensures type consistency between initial render and delta handling.

### FC/IS Enables Pure Function Testing

By extracting `planInitialRender` and `planDeltaOps` as pure functions, we can test the planning logic without any DOM. The imperative shell (`executeOp`) is minimal and well-defined.