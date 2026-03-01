# Plan: Reactive Enhancements

## Background

The delta-driven reactivity system is now complete (Phases 1-6 of `delta-driven-reactivity.md`). The infrastructure exists for surgical DOM updates based on structured deltas (`ReactiveDelta`), but several optimizations and API improvements are ready to be implemented:

1. **`LocalRef` API** — Currently requires `new LocalRef(value)`, which is verbose and unfamiliar to React users
2. **Unified scalar read interface** — `TextRef` uses `.toString()` while other types use `.get()`, creating inconsistency
3. **Multi-dependency subscriptions** — Codegen only subscribes to `dependencies[0]`, missing updates from other dependencies
4. **Text patching** — `TextRef` emits `{ type: "text", ops }` deltas but codegen always does full `textContent` replacement
5. **Runtime naming convention** — The `__` prefix on runtime functions is ugly and inconsistent; a separate entry point is cleaner

> **Future direction**: These enhancements lay groundwork for **incremental view maintenance** — understanding expression semantics to derive minimal DOM updates from CRDT deltas. See [packages/kinetic/ideas/incremental-view-maintenance.md](../packages/kinetic/ideas/incremental-view-maintenance.md) for the full vision.

## Problem Statement

1. **API ergonomics**: `new LocalRef(false)` is verbose compared to `state(false)` or `signal(false)`. React users expect function-based state primitives.

2. **Inconsistent read interface**: Scalar reactive types lack a unified "get the value" method:
   - `CounterRef` → `.get()` returns `number`
   - `TextRef` → `.toString()` returns `string` (no `.get()`)
   - `LocalRef` → `.get()` returns `T`
   
   This inconsistency prevents generic "direct read" detection in the compiler.

3. **Correctness**: Expressions like `firstName.get() + " " + lastName.get()` have two dependencies but only subscribe to the first. Changes to `lastName` don't trigger updates.

4. **Text performance**: For a `TextRef` with 10,000 characters, a single character edit triggers `textNode.textContent = entireString` — an O(n) operation. The DOM provides `insertData`/`deleteData` for O(k) updates where k is the edit size.

5. **Runtime naming**: The `__subscribe`, `__listRegion`, etc. naming convention is ugly in generated code and stack traces. A separate entry point (`@loro-extended/kinetic/runtime`) provides cleaner separation.

## Success Criteria

1. `state(initial)` function exported from `@loro-extended/reactive`
2. `TextRef` has `.get()` method as alias for `.toString()`
3. Expressions with multiple dependencies subscribe to all of them
4. Reactive text content with `deltaKind: "text"` uses `insertData`/`deleteData` when the expression is a direct `.get()` call
5. Runtime functions moved to `@loro-extended/kinetic/runtime` subpath with clean names (no `__` prefix)
6. Common incremental subscription pattern extracted as `subscribeIncremental`
7. All existing tests pass (602 kinetic, 964 change, 46 reactive)

## The Gap

| Aspect | Current | Target |
|--------|---------|--------|
| Local state API | `new LocalRef(value)` | `state(value)` |
| TextRef read method | `.toString()` only | `.get()` (alias) |
| Multi-dependency | Subscribe to `deps[0]` only | Subscribe to all deps |
| Text update strategy | `textNode.textContent = value` | `insertData()`/`deleteData()` for direct reads |
| Runtime imports | `import { __subscribe } from "@loro-extended/kinetic"` | `import { subscribe } from "@loro-extended/kinetic/runtime"` |
| Incremental pattern | Duplicated in `listRegion`, soon `textRegion` | Extracted `subscribeIncremental` |
| Direct-read detection | Not tracked | Structural AST analysis |

## Core Type Changes

### IR Extension for Direct Reads

```typescript
interface ContentValue {
  kind: "content"
  source: string
  bindingTime: BindingTime
  dependencies: Dependency[]
  span: SourceSpan
  /** Source ref name if this is a direct read (e.g., "title" for `title.get()`), undefined otherwise */
  directReadSource?: string
}
```

Using `directReadSource?: string` instead of `isDirectRead?: boolean` provides more information and extends better for future optimizations.

### Incremental Subscription Pattern

```typescript
interface IncrementalHandler<T> {
  /** Compute initial value */
  initial: () => T
  /** Render initial value to DOM */
  render: (value: T) => void
  /** Try to apply delta incrementally. Returns true if handled. */
  patch: (delta: ReactiveDelta) => boolean
  /** Fallback: full re-render when patch returns false */
  fallback: () => void
}

function subscribeIncremental<T>(
  ref: unknown,
  handler: IncrementalHandler<T>,
  scope: Scope,
): void
```

This pattern is shared by `listRegion` and the new `textRegion`.

### Runtime Subpath Exports

```typescript
// @loro-extended/kinetic/runtime
export {
  subscribe,
  subscribeWithValue,
  subscribeMultiple,
  subscribeIncremental,
  listRegion,
  conditionalRegion,
  textRegion,
  patchText,
  // ... other runtime functions
}
```

## Phases and Tasks

### Implementation Order

The phases are numbered for reference but should be implemented in the following order to respect dependencies and minimize rework:

| Order | Phase | Rationale |
|-------|-------|-----------|
| 1st | Phase 1 | No dependencies; unblocks Phase 4's direct-read detection (needs `.get()` on TextRef) |
| 2nd | Phase 3 | No dependencies; fixes a **correctness bug** where only `deps[0]` is subscribed |
| 3rd | Phase 0 | Establish runtime subpath structure before adding new functions in Phases 2 & 4 |
| 4th | Phase 2 | Prerequisite for Phase 4; pure refactoring after structure is in place |
| 5th | Phase 4 | Depends on Phases 1 and 2; most complex phase |
| 6th | Phase 5 | Documents all features after implementation |

### Phase 1: Unify Scalar Read Interface & state() API ✅

**Goal**: Establish `.get()` as the universal read method for scalar reactives, and provide ergonomic `state()` function.

- ✅ Task 1.1: Add `.get(): string` method to `TextRef` as alias for `.toString()`
- ✅ Task 1.2: Add tests for `TextRef.get()`
- ✅ Task 1.3: Add `state<T>(initial: T): LocalRef<T>` function to `@loro-extended/reactive`
- ✅ Task 1.4: Export `state` from `@loro-extended/reactive` index
- ✅ Task 1.5: Export `state` from `@loro-extended/kinetic` index
- ✅ Task 1.6: Update `reactive/README.md` to prefer `state()` in examples
- ✅ Task 1.7: Update `kinetic/src/loro/README.md` to use `state()` in examples
- ✅ Task 1.8: Add JSDoc note to `LocalRef` constructor suggesting `state()` as preferred API
- ✅ Task 1.9: Add tests for `state()` function

### Phase 3: Multi-Dependency Subscriptions 🔴

**Goal**: Subscribe to all dependencies in an expression, not just the first one.

> **Note**: `__subscribeMultiple` already exists and is tested. This phase only requires codegen changes to use it.

- 🔴 Task 3.1: Update `generateAttributeSubscription` in `dom.ts` to use `subscribeMultiple` when `deps.length > 1`
- 🔴 Task 3.2: Update reactive text content generation in `generateChild` to use `subscribeMultiple` when `deps.length > 1`
- 🔴 Task 3.3: Update `generateBodyWithReturn` for multi-dependency text content
- 🔴 Task 3.4: Add codegen tests for multi-dependency attributes
- 🔴 Task 3.5: Add codegen tests for multi-dependency text content
- 🔴 Task 3.6: Add integration test: expression with two reactive dependencies updates on either change

### Phase 0: Runtime Subpath Refactor 🔴

**Goal**: Move runtime functions to `@loro-extended/kinetic/runtime` with clean names.

> **Note**: `packages/kinetic/src/runtime/index.ts` already exists. This phase adds a package.json export and renames functions.

- 🔴 Task 0.1: Update `package.json` exports to add `"./runtime"` subpath pointing to `dist/runtime/index.js`
- 🔴 Task 0.2: Rename exports: `__subscribe` → `subscribe`, `__subscribeWithValue` → `subscribeWithValue`, etc.
- 🔴 Task 0.3: Rename exports: `__listRegion` → `listRegion`, `__conditionalRegion` → `conditionalRegion`
- 🔴 Task 0.4: Keep `__reset*` and `__activeSubscriptions` as internal (testing utilities, not generated code)
- 🔴 Task 0.5: Update `collectRequiredImports` in `transform.ts` to use new names
- 🔴 Task 0.6: Update `mergeImports` to import from `@loro-extended/kinetic/runtime` instead of main entry
- 🔴 Task 0.7: Update codegen in `dom.ts` to emit new function names
- 🔴 Task 0.8: Update all tests importing runtime functions
- 🔴 Task 0.9: Deprecate old `__*` exports from main entry (keep for backward compat, add JSDoc deprecation)

### Phase 2: Extract Incremental Subscription Pattern 🔴

**Goal**: Extract common pattern from `listRegion` into reusable `subscribeIncremental`.

- 🔴 Task 2.1: Define `IncrementalHandler<T>` interface in `runtime/subscribe.ts`
- 🔴 Task 2.2: Implement `subscribeIncremental<T>(ref, handler, scope)` function
- 🔴 Task 2.3: Refactor `listRegion` to use `subscribeIncremental` internally
- 🔴 Task 2.4: Add unit tests for `subscribeIncremental` with mock handlers
- 🔴 Task 2.5: Verify all existing `listRegion` tests still pass

### Phase 4: Text Patching 🔴

**Goal**: Use surgical DOM updates for direct TextRef reads.

#### Part A: IR Extension & Direct-Read Detection

- 🔴 Task 4.1: Add `directReadSource?: string` field to `ContentValue` interface
- 🔴 Task 4.2: Update `createContent` factory to accept `directReadSource` parameter
- 🔴 Task 4.3: Implement structural AST direct-read detection in `analyze.ts` (see algorithm below)
- 🔴 Task 4.4: Add analyze tests for direct-read detection (positive and negative cases)

#### Part B: Runtime Text Patching

- 🔴 Task 4.5: Implement `planTextPatch(ops: TextDeltaOp[]): TextPatchOp[]` — pure function converting deltas to offset-based ops
- 🔴 Task 4.6: Implement `executePatch(textNode: Text, op: TextPatchOp)` — applies single patch to DOM
- 🔴 Task 4.7: Implement `patchText(textNode: Text, ops: TextDeltaOp[])` — composes plan + execute
- 🔴 Task 4.8: Implement `textRegion(textNode, ref, scope)` using `subscribeIncremental`
- 🔴 Task 4.9: Add unit tests for `planTextPatch` with various delta patterns
- 🔴 Task 4.10: Add unit tests for `patchText` end-to-end
- 🔴 Task 4.11: Add unit tests for `textRegion` with mock TextRef

#### Part C: Codegen Updates

- 🔴 Task 4.12: Update `generateChild` to emit `textRegion` when `directReadSource && deltaKind === "text"`
- 🔴 Task 4.13: Update `generateBodyWithReturn` for text patching
- 🔴 Task 4.14: Add codegen tests for direct TextRef read generating `textRegion`
- 🔴 Task 4.15: Add codegen tests for non-direct TextRef read falling back to `subscribeWithValue`

#### Part D: Integration

- 🔴 Task 4.16: Add integration test: TextRef direct read with character insertion
- 🔴 Task 4.17: Add integration test: TextRef direct read with character deletion
- 🔴 Task 4.18: Add integration test: TextRef indirect read (e.g., `.toUpperCase()`) uses fallback
- 🔴 Task 4.19: Add integration test: multi-dep text expression (not direct) uses replace semantics

### Phase 5: Documentation 🔴

**Goal**: Update documentation to reflect new APIs and optimizations.

- 🔴 Task 5.1: Update `packages/reactive/README.md` — `state()` as primary API
- 🔴 Task 5.2: Update `packages/kinetic/TECHNICAL.md` — document runtime subpath architecture
- 🔴 Task 5.3: Update `packages/kinetic/TECHNICAL.md` — document text patching optimization
- 🔴 Task 5.4: Update `packages/kinetic/TECHNICAL.md` — document multi-dependency subscriptions
- 🔴 Task 5.5: Update `packages/kinetic/TECHNICAL.md` — document `subscribeIncremental` pattern
- 🔴 Task 5.6: Update root `TECHNICAL.md` if needed

## Direct-Read Detection Algorithm

Direct-read detection uses **structural AST analysis**, not string pattern matching. A direct read is when the `.get()` call IS the content expression, not nested inside a transformation.

```typescript
function detectDirectRead(contentExpr: Expression): string | undefined {
  // 1. Must be a CallExpression
  if (contentExpr.getKind() !== SyntaxKind.CallExpression) {
    return undefined
  }
  
  const call = contentExpr as CallExpression
  const callee = call.getExpression()
  
  // 2. Must be a PropertyAccessExpression (receiver.method)
  if (callee.getKind() !== SyntaxKind.PropertyAccessExpression) {
    return undefined
  }
  
  const propAccess = callee as PropertyAccessExpression
  const methodName = propAccess.getName()
  
  // 3. Method must be .get() or .toString()
  if (methodName !== "get" && methodName !== "toString") {
    return undefined
  }
  
  // 4. Receiver must be reactive
  const receiver = propAccess.getExpression()
  const receiverType = receiver.getType()
  
  if (!isReactiveType(receiverType)) {
    return undefined
  }
  
  // 5. Return the source ref name
  return receiver.getText()
}
```

**Key insight**: We check that the CallExpression IS the content expression (the root), not a sub-expression. This is implicit — if `title.get().toUpperCase()` is the content expression, then `title.get()` is nested inside it and won't match at the root level.

**Examples**:
- `title.get()` → returns `"title"` (direct read)
- `title.get().toUpperCase()` → returns `undefined` (root is a different CallExpression)
- `title.get() + subtitle.get()` → returns `undefined` (root is BinaryExpression)
- `` `Hello ${title.get()}` `` → returns `undefined` (root is TemplateExpression)

## Tests

Tests are organized by implementation order (not phase number).

### Phase 1: state() Function (1st)

```typescript
describe("state()", () => {
  it("creates a LocalRef with initial value", () => {
    const s = state(42)
    expect(s.get()).toBe(42)
  })

  it("is reactive (has [REACTIVE])", () => {
    const s = state(false)
    expect(isReactive(s)).toBe(true)
  })

  it("notifies subscribers on change", () => {
    const s = state(0)
    const deltas: ReactiveDelta[] = []
    s.subscribe(d => deltas.push(d))
    s.set(1)
    expect(deltas).toEqual([{ type: "replace" }])
  })
})

describe("TextRef.get()", () => {
  it("returns same value as toString()", () => {
    const doc = createTypedDoc(Shape.doc({ title: Shape.text() }))
    doc.title.insert(0, "Hello")
    expect(doc.title.get()).toBe("Hello")
    expect(doc.title.get()).toBe(doc.title.toString())
  })
})
```

### Phase 3: Multi-Dependency Subscriptions (2nd)

```typescript
describe("multi-dependency codegen", () => {
  it("generates subscribeMultiple for two-dep expression", () => {
    const expr = createContent(
      "first.get() + last.get()",
      "reactive",
      [dep("first"), dep("last")],
      span(),
    )
    const builder = createBuilder("p", [], [], [expr], span())
    const code = generateDOM(builder)

    expect(code).toContain("subscribeMultiple")
    expect(code).toContain("[first, last]")
  })
  
  it("generates subscribe for single-dep expression", () => {
    const expr = createContent(
      "title.get()",
      "reactive",
      [dep("title")],
      span(),
    )
    const builder = createBuilder("p", [], [], [expr], span())
    const code = generateDOM(builder)

    expect(code).toContain("subscribe")
    expect(code).not.toContain("subscribeMultiple")
  })
})

describe("multi-dependency integration", () => {
  it("updates when any dependency changes", () => {
    const first = state("John")
    const last = state("Doe")
    // ... mount component with `${first.get()} ${last.get()}`
    // Verify DOM updates when `last.set("Smith")` is called
  })
})
```

### Phase 0: Runtime Subpath (3rd)

```typescript
describe("runtime subpath exports", () => {
  it("exports subscribe from @loro-extended/kinetic/runtime", async () => {
    const { subscribe } = await import("@loro-extended/kinetic/runtime")
    expect(typeof subscribe).toBe("function")
  })
  
  it("deprecated __subscribe still works from main entry", async () => {
    const { __subscribe } = await import("@loro-extended/kinetic")
    expect(typeof __subscribe).toBe("function")
  })
})
```

### Phase 2: Incremental Subscription (4th)

```typescript
describe("subscribeIncremental", () => {
  it("calls initial and render on setup", () => {
    const ref = state(0)
    const scope = new Scope()
    const calls: string[] = []
    
    subscribeIncremental(ref, {
      initial: () => { calls.push("initial"); return ref.get() },
      render: (v) => { calls.push(`render:${v}`) },
      patch: () => false,
      fallback: () => { calls.push("fallback") },
    }, scope)
    
    expect(calls).toEqual(["initial", "render:0"])
  })
  
  it("calls fallback when patch returns false", () => {
    const ref = state(0)
    const scope = new Scope()
    const calls: string[] = []
    
    subscribeIncremental(ref, {
      initial: () => ref.get(),
      render: () => {},
      patch: () => { calls.push("patch"); return false },
      fallback: () => { calls.push("fallback") },
    }, scope)
    
    ref.set(1)
    expect(calls).toEqual(["patch", "fallback"])
  })
  
  it("does not call fallback when patch returns true", () => {
    const ref = state(0)
    const scope = new Scope()
    const calls: string[] = []
    
    subscribeIncremental(ref, {
      initial: () => ref.get(),
      render: () => {},
      patch: () => { calls.push("patch"); return true },
      fallback: () => { calls.push("fallback") },
    }, scope)
    
    ref.set(1)
    expect(calls).toEqual(["patch"])
  })
})
```

### Phase 4: Text Patching (5th)

```typescript
describe("planTextPatch", () => {
  it("converts retain + insert to offset-based op", () => {
    const ops = planTextPatch([{ retain: 5 }, { insert: " World" }])
    expect(ops).toEqual([{ kind: "insert", offset: 5, text: " World" }])
  })
  
  it("converts delete to offset-based op", () => {
    const ops = planTextPatch([{ retain: 5 }, { delete: 6 }])
    expect(ops).toEqual([{ kind: "delete", offset: 5, count: 6 }])
  })
})

describe("patchText", () => {
  it("applies insert delta", () => {
    const text = document.createTextNode("Hello")
    patchText(text, [{ retain: 5 }, { insert: " World" }])
    expect(text.textContent).toBe("Hello World")
  })

  it("applies delete delta", () => {
    const text = document.createTextNode("Hello World")
    patchText(text, [{ retain: 5 }, { delete: 6 }])
    expect(text.textContent).toBe("Hello")
  })

  it("applies complex delta sequence", () => {
    const text = document.createTextNode("abcdef")
    patchText(text, [{ retain: 2 }, { delete: 2 }, { insert: "XY" }])
    expect(text.textContent).toBe("abXYef")
  })
})

describe("direct-read detection", () => {
  it("detects title.get() as direct read", () => {
    // Analyze `title.get()` where title is TextRef
    // Verify directReadSource === "title"
  })

  it("rejects title.get().toUpperCase() as not direct", () => {
    // Analyze `title.get().toUpperCase()`
    // Verify directReadSource === undefined
  })
  
  it("rejects title.get() + subtitle.get() as not direct", () => {
    // Multi-dep expression
    // Verify directReadSource === undefined
  })
  
  it("rejects template literal as not direct", () => {
    // Analyze `Hello ${title.get()}`
    // Verify directReadSource === undefined
  })
})
```

## Learnings

### Implementation Order Matters

Dependency analysis revealed the optimal order differs from the phase numbering:

1. **Phase 1 before Phase 4**: Direct-read detection in Phase 4 assumes `.get()` exists on all scalar refs. Without `TextRef.get()`, the detection logic would need to handle both `.get()` and `.toString()`, then be simplified later.

2. **Phase 0 before Phases 2 & 4**: If runtime subpath refactoring happens after adding `subscribeIncremental`, `textRegion`, and `patchText`, those functions would be added with `__` prefixes and immediately renamed—wasteful churn.

3. **Phase 3 is independent**: The `__subscribeMultiple` runtime function already exists and is tested. Only codegen needs updating. This can be done at any point but fixes a correctness bug, so it should be early.

### Runtime Subpath Entry Point Already Exists

The plan originally said to "Create `packages/kinetic/src/runtime/index.ts`" but this file already exists. What's missing is:
- The `"./runtime"` export in `package.json`
- Renaming functions from `__*` to clean names
- Updating codegen to import from the subpath

### Multi-Dependency Bug Confirmed

The codegen has an explicit TODO comment at `dom.ts:193`:
```
// TODO: Handle multiple dependencies with __subscribeMultiple
```
This confirms the plan's assessment. The fix is straightforward since `__subscribeMultiple` already works.

### Runtime Naming Convention

The `__` prefix was established early to signal "compiler-internal, don't call directly." However:
- It's ugly in generated code and stack traces
- Inconsistent boundary — some `__` functions ARE public API
- Doesn't actually prevent misuse

**Solution**: Separate entry points provide cleaner separation:
- `@loro-extended/kinetic` — user API (state, types, etc.)
- `@loro-extended/kinetic/runtime` — compiler runtime (subscribe, listRegion, etc.)
- `@loro-extended/kinetic/loro` — Loro-specific bindings

### Incremental Subscription Pattern

Both `listRegion` and `textRegion` follow the same pattern:
1. Compute initial state
2. Render initial state  
3. Subscribe to deltas
4. On delta: try to apply incrementally, else fallback to full re-render

Extracting this as `subscribeIncremental` with an `IncrementalHandler` interface:
- Makes the pattern explicit and testable
- Enables pure functional handlers (the "plan")
- Separates concerns (subscription management vs. rendering logic)

### Direct-Read Detection Must Be Structural

Pattern matching on source text (e.g., "ends with `.get()`") is fragile. Structural AST analysis is more robust:
- Check the expression's AST node type, not its text representation
- Verify the CallExpression is the root, not nested
- Use ts-morph's type system to confirm the receiver is reactive

## Transitive Effect Analysis

### Package Dependency Graph

```
@loro-extended/reactive  ← state() function added here
       ↓
@loro-extended/kinetic   ← re-exports state(), runtime subpath, codegen changes
       ↓
@loro-extended/change    ← TextRef.get() added
```

### Direct Impact

| Package | Changes |
|---------|---------|
| `@loro-extended/reactive` | Add `state()` function |
| `@loro-extended/change` | Add `TextRef.get()` method |
| `@loro-extended/kinetic` | Runtime subpath, IR extension, codegen updates, new runtime functions |

### Transitive Impact

| Affected | Via | Risk |
|----------|-----|------|
| Examples using `LocalRef` | API change | Low — `LocalRef` still works, `state()` is additive |
| Examples using `__subscribe` | Runtime rename | Medium — deprecation warnings, need to update imports |
| Compiled components | Codegen output | Medium — imports change, must verify all test suites pass |

### Breaking Change Assessment

**Soft breaking** (deprecation, not removal):
- `__subscribe`, `__listRegion`, etc. still exported from main entry with deprecation warnings
- Users should migrate to `@loro-extended/kinetic/runtime` imports

**Non-breaking**:
- `LocalRef` class remains exported and functional
- `state()` is purely additive
- `TextRef.get()` is purely additive
- Existing codegen patterns remain valid as fallback

## Resources for Implementation

### Files to Create

| File | Purpose |
|------|---------|
| (none) | `packages/kinetic/src/runtime/index.ts` already exists |

### Files to Modify

**Phase 1 (state() + TextRef.get())**:
| File | Changes |
|------|---------|
| `packages/reactive/src/index.ts` | Add `state<T>(initial: T): LocalRef<T>` function |
| `packages/reactive/src/index.test.ts` | Add `state()` tests |
| `packages/change/src/typed-refs/text-ref.ts` | Add `.get(): string` method as alias for `.toString()` |
| `packages/change/src/typed-refs/text-ref.test.ts` | Add `TextRef.get()` tests |
| `packages/kinetic/src/index.ts` | Re-export `state` from `@loro-extended/reactive` |

**Phase 3 (Multi-Dependency Subscriptions)**:
| File | Changes |
|------|---------|
| `packages/kinetic/src/compiler/codegen/dom.ts` | Update `generateAttributeSubscription`, `generateChild`, `generateBodyWithReturn` to use `__subscribeMultiple` when `deps.length > 1` |
| `packages/kinetic/src/compiler/codegen/dom.test.ts` | Add tests for multi-dep codegen |

**Phase 0 (Runtime Subpath Refactor)**:
| File | Changes |
|------|---------|
| `packages/kinetic/package.json` | Add `"./runtime"` export pointing to `dist/runtime/index.js` |
| `packages/kinetic/src/runtime/index.ts` | Export clean names (`subscribe`, `listRegion`, etc.) alongside `__*` versions |
| `packages/kinetic/src/runtime/subscribe.ts` | Add clean-name exports |
| `packages/kinetic/src/runtime/regions.ts` | Add clean-name exports |
| `packages/kinetic/src/index.ts` | Add deprecation JSDoc to `__*` re-exports |
| `packages/kinetic/src/compiler/transform.ts` | Update `collectRequiredImports` and `mergeImports` to use `/runtime` subpath and clean names |
| `packages/kinetic/src/compiler/codegen/dom.ts` | Emit clean function names instead of `__*` |

**Phase 2 (Extract subscribeIncremental)**:
| File | Changes |
|------|---------|
| `packages/kinetic/src/runtime/subscribe.ts` | Add `IncrementalHandler<T>` interface and `subscribeIncremental` function |
| `packages/kinetic/src/runtime/subscribe.test.ts` | Add `subscribeIncremental` tests |
| `packages/kinetic/src/runtime/regions.ts` | Refactor `listRegion` to use `subscribeIncremental` internally |

**Phase 4 (Text Patching)**:
| File | Changes |
|------|---------|
| `packages/kinetic/src/compiler/ir.ts` | Add `directReadSource?: string` to `ContentValue` |
| `packages/kinetic/src/compiler/analyze.ts` | Implement structural AST direct-read detection |
| `packages/kinetic/src/compiler/analyze.test.ts` | Add direct-read detection tests |
| `packages/kinetic/src/runtime/subscribe.ts` | Add `planTextPatch`, `patchText`, `textRegion` functions |
| `packages/kinetic/src/runtime/subscribe.test.ts` | Add text patching tests |
| `packages/kinetic/src/compiler/codegen/dom.ts` | Emit `textRegion` when `directReadSource && deltaKind === "text"` |
| `packages/kinetic/src/compiler/codegen/dom.test.ts` | Add text patching codegen tests |

### Key Type Definitions

```typescript
// IncrementalHandler for subscribeIncremental
interface IncrementalHandler<T> {
  initial: () => T
  render: (value: T) => void
  patch: (delta: ReactiveDelta) => boolean
  fallback: () => void
}

// TextPatchOp for planTextPatch
type TextPatchOp =
  | { kind: "insert"; offset: number; text: string }
  | { kind: "delete"; offset: number; count: number }

// Updated ContentValue
interface ContentValue {
  kind: "content"
  source: string
  bindingTime: BindingTime
  dependencies: Dependency[]
  span: SourceSpan
  directReadSource?: string  // NEW
}
```

## Changeset

```markdown
---
"@loro-extended/reactive": minor
"@loro-extended/kinetic": minor
"@loro-extended/change": minor
---

feat: Add state() function, runtime subpath, and reactive optimizations

- `state(initial)` — ergonomic function for creating local reactive state
- `TextRef.get()` — unified scalar read interface across all reactive types
- `@loro-extended/kinetic/runtime` — new subpath for compiler runtime functions
- `subscribeIncremental` — extracted pattern for delta-aware subscriptions  
- Multi-dependency subscriptions — expressions with multiple reactive deps now update correctly
- Text patching — direct `ref.get()` calls with text delta kind use surgical DOM updates
- Deprecate `__subscribe`, `__listRegion`, etc. in favor of `/runtime` subpath
```
