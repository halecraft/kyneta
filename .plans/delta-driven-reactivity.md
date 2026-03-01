# Plan: Delta-Driven Reactivity

## Background

Kinetic's compiler performs partial evaluation at three binding-time levels: `literal`, `render`, and `reactive`. The `reactive` level currently means "something changed, re-read the entire value and replace." This is the same model as React, Solid, and every other reactive framework.

But Loro CRDTs provide structured deltas — not just "something changed" but "here's exactly what changed." A text edit produces `{ retain: 5, insert: "x" }`. A list mutation produces `{ retain: 2, delete: 1, insert: 3 }`. Today, Kinetic already exploits list deltas in `__listRegion` for O(k) DOM updates — but this capability is:

1. **Hard-coded** — only lists get delta-driven rendering
2. **Loro-specific** — the runtime directly consumes `LoroEventBatch`, coupling it to Loro's event format
3. **Invisible to the IR** — the IR says `"reactive"` for lists and text alike; only the runtime knows lists are special

Meanwhile, the existing `[REACTIVE]` subscribe function uses a `() => void` callback signature, which structurally prevents delta information from flowing to consumers. This forces the runtime to either (a) re-read entire values or (b) bypass `[REACTIVE]` entirely for delta-aware code paths (which is what `__listRegion` does today via `__subscribe` + `LoroEventBatch`).

### The Insight: Delta Is a Fourth Binding-Time Level

Partial evaluation theory says: the more you know statically, the more you can specialize. Today's lattice:

```
literal  <  render  <  reactive
```

The `reactive` level means "value varies at runtime, changes opaque." But when the source provides structured deltas, we know *more* — we know the shape of the change. This enables a strictly more specialized residualization:

- **reactive** ("replace"): re-read entire value, replace DOM content
- **delta**: apply structured patch to DOM content directly

This is a genuine fourth level because the **residualized code is structurally different**:

- `reactive` generates: `subscribe → re-read → textNode.textContent = newValue`
- `delta("text")` generates: `subscribe → textNode.insertData(offset, chars)`

The delta level is parameterized by *kind* (text, list, map, tree), where `"replace"` is the degenerate case equivalent to level 3.

### Relationship to Prior Work

The [kinetic-reactive-primitive.md](./kinetic-reactive-primitive.md) plan (Phases 0–4 complete) established:

- `@loro-extended/reactive` package with `REACTIVE` symbol, `Reactive` interface, `LocalRef`
- Structural compiler detection via `isTypeAssignableTo`
- `[REACTIVE]` on all `@loro-extended/change` refs

Phases 5–6 of that plan are **superseded by this plan**. The original Phase 5 proposed updating `__subscribe` to use `ref[REACTIVE](ref, () => void)` — a uniform but delta-unaware callback. This plan replaces that with a delta-aware callback that carries structured change information.

## Problem Statement

1. The `ReactiveSubscribe` callback signature is `() => void` — it cannot carry delta information
2. The runtime's `__subscribe` uses `loro()` to get Loro containers and passes raw `LoroEventBatch` — coupling the runtime to Loro's event format
3. `__listRegion` already operates at the "delta" level but the IR doesn't reflect this — it's classified as `"reactive"` like everything else
4. Text content always re-reads and replaces the entire string, even for single-character edits
5. There is no mechanism for `LocalRef` or custom reactive types to express structured deltas
6. The binding-time lattice lacks a fourth level, preventing the compiler from generating delta-specialized code

## Success Criteria

1. `ReactiveSubscribe` callback receives a `ReactiveDelta` discriminated union describing what changed
2. Every `[REACTIVE]` implementation translates its native events into `ReactiveDelta` — no Loro types leak to consumers
3. The IR carries delta kind on dependencies (not just `string[]` but `{ source, deltaKind }[]`)
4. `BindingTime` becomes `"literal" | "render" | "reactive" | "delta"` in the IR
5. Codegen dispatches on delta kind to emit specialized code (list deltas today, text deltas as next target)
6. `__subscribe` uses `ref[REACTIVE](ref, callback)` uniformly — no `loro()` calls in subscribe.ts
7. `__listRegion` consumes list deltas via the `[REACTIVE]` path instead of raw `LoroEventBatch`
8. `LocalRef<T>` emits `{ type: "replace" }` deltas and works end-to-end
9. All existing tests pass (593 kinetic, 935 change, 25 reactive)

## The Gap

| Aspect | Current | Target |
|--------|---------|--------|
| `ReactiveSubscribe` callback | `() => void` | `(delta: ReactiveDelta) => void` |
| IR binding time | `"literal" \| "render" \| "reactive"` | `"literal" \| "render" \| "reactive" \| "delta"` |
| IR dependencies | `string[]` | `Array<{ source: string; deltaKind: DeltaKind }>` |
| `__subscribe` | Uses `loro()`, passes `LoroEventBatch` | Uses `ref[REACTIVE]`, receives `ReactiveDelta` |
| `__listRegion` | Consumes `LoroEventBatch` directly | Consumes `ReactiveDelta` of type `"list"` |
| Text updates | `textNode.textContent = newValue` | `textNode.insertData(offset, chars)` (when direct read) |
| `LocalRef` runtime | Not tested end-to-end in compiler | Emits `{ type: "replace" }`, works in all contexts |

## Core Type Definitions

### ReactiveDelta

Defined in `@loro-extended/reactive`. This is Kinetic's own delta vocabulary — not a mirror of Loro's.

```typescript
export type TextDeltaOp =
  | { retain: number }
  | { insert: string }
  | { delete: number }

export type ListDeltaOp =
  | { retain: number }
  | { insert: number }   // count only — consumer calls ref.get(index) for values
  | { delete: number }

export type MapDeltaOp = {
  keys: string[]          // which keys changed — consumer re-reads them
}

export type TreeDeltaOp =
  | { action: "create"; index: number }
  | { action: "delete"; index: number }
  | { action: "move"; fromIndex: number; toIndex: number }

export type ReactiveDelta =
  | { type: "replace" }
  | { type: "text"; ops: TextDeltaOp[] }
  | { type: "list"; ops: ListDeltaOp[] }
  | { type: "map"; ops: MapDeltaOp }
  | { type: "tree"; ops: TreeDeltaOp[] }

export type DeltaKind = ReactiveDelta["type"]
```

Design notes:
- `list.insert` carries a **count**, not values — `planDeltaOps` already ignores inserted values and re-reads via `listRef.get(index)`
- `"replace"` is the degenerate case — equivalent to current `() => void` semantics
- `CounterRef` emits `"replace"`, not `"counter"` — Kinetic can't exploit counter increments at the DOM level
- `PlainValueRef` emits `"replace"` — scalar value changed
- `"text"` and `"map"` carry structural information that enables surgical DOM patching

### Updated ReactiveSubscribe

```typescript
export type ReactiveSubscribe<D extends ReactiveDelta = ReactiveDelta> = (
  self: unknown,
  callback: (delta: D) => void,
) => () => void

export interface Reactive<D extends ReactiveDelta = ReactiveDelta> {
  readonly [REACTIVE]: ReactiveSubscribe<D>
}
```

The generic parameter `D` lets the type system express what kind of delta a specific type emits. The compiler can inspect this to determine delta kind at compile time.

### Updated IR Dependencies

```typescript
// In ir.ts
export type DeltaKind = "replace" | "text" | "list" | "map" | "tree"

export interface Dependency {
  /** Source expression text (e.g., "doc.title", "doc.items") */
  source: string
  /** What kind of delta this dependency emits */
  deltaKind: DeltaKind
}
```

### Updated BindingTime

```typescript
export type BindingTime = "literal" | "render" | "reactive" | "delta"
```

Where `"reactive"` means "value changes at runtime, but the expression is derived (transformed) so deltas can't be applied directly" and `"delta"` means "value changes at runtime, expression is a direct read of the source, and deltas can be applied surgically."

## Phases and Tasks

### Phase 1: Define ReactiveDelta Type System ✅

**Goal**: Establish the delta vocabulary in `@loro-extended/reactive`.

- ✅ Task 1.1: Define `ReactiveDelta` discriminated union (all variants)
- ✅ Task 1.2: Define `DeltaKind` type alias (`ReactiveDelta["type"]`)
- ✅ Task 1.3: Define individual op types (`TextDeltaOp`, `ListDeltaOp`, `MapDeltaOp`, `TreeDeltaOp`)
- ✅ Task 1.4: Update `ReactiveSubscribe` to `(self, callback: (delta: D) => void) => () => void`
- ✅ Task 1.5: Update `Reactive` interface to `Reactive<D extends ReactiveDelta = ReactiveDelta>`
- ✅ Task 1.6: Update `isReactive` type guard (unchanged behavior, updated generics)
- ✅ Task 1.7: Update `LocalRef` to emit `{ type: "replace" }` in its `[REACTIVE]` callback
- ✅ Task 1.8: Add tests for `ReactiveDelta` type discriminants (21 new tests)
- ✅ Task 1.9: Update existing `LocalRef` tests to assert delta payload

### Phase 2: Update @loro-extended/change [REACTIVE] Implementations 🔴

**Goal**: Each ref's `[REACTIVE]` translates `LoroEventBatch` → `ReactiveDelta`. No Loro types leak.

- 🔴 Task 2.1: Create `translateDiff(diff: Diff): ReactiveDelta` helper in a new `reactive-bridge.ts` module
- 🔴 Task 2.2: Update `TypedRef` base class `[REACTIVE]` to translate events and pass `ReactiveDelta` to callback
- 🔴 Task 2.3: `TextRef` emits `{ type: "text", ops }` — translate Loro's `TextDiff` → `TextDeltaOp[]`
- 🔴 Task 2.4: `CounterRef` emits `{ type: "replace" }` — counter increment not useful for DOM
- 🔴 Task 2.5: `ListRef` emits `{ type: "list", ops }` — translate Loro's `ListDiff` → `ListDeltaOp[]` (insert carries count, not values)
- 🔴 Task 2.6: `MovableListRef` emits `{ type: "list", ops }` — same translation as ListRef
- 🔴 Task 2.7: `RecordRef` and `StructRef` emit `{ type: "map", ops }` — translate Loro's `MapDiff` → `MapDeltaOp`
- 🔴 Task 2.8: `TreeRef` emits `{ type: "tree", ops }` — translate Loro's `TreeDiff` → `TreeDeltaOp[]`
- 🔴 Task 2.9: `PlainValueRef` emits `{ type: "replace" }` — scalar value, no structural delta
- 🔴 Task 2.10: Update existing reactive.test.ts to assert delta payloads for each ref type
- 🔴 Task 2.11: Add translation unit tests in `reactive-bridge.test.ts`

Note: `TypedRef` base class currently has a single `[REACTIVE]` implementation that calls `container.subscribe(() => callback())`. After this phase, the base class implementation should translate the Loro event through `translateDiff`. Subclass-specific behavior (TextRef emitting text deltas vs CounterRef emitting replace) is determined by the `Diff.type` field in the Loro event, not by overriding `[REACTIVE]`. The `StructRef` Proxy handler and `PlainValueRef` factory have their own implementations that must also be updated.

### Phase 3: Update Kinetic Runtime Subscribe 🔴

**Goal**: `__subscribe` uses `ref[REACTIVE](ref, callback)` uniformly. No `loro()` calls.

- 🔴 Task 3.1: Import `REACTIVE`, `Reactive`, `ReactiveDelta` from `@loro-extended/reactive`
- 🔴 Task 3.2: Update `__subscribe` signature: `handler` becomes `(delta: ReactiveDelta) => void`
- 🔴 Task 3.3: Implement `__subscribe` body: `ref[REACTIVE](ref, handler)` — no `loro()` import
- 🔴 Task 3.4: Update `__subscribeWithValue` to ignore delta (re-reads value regardless)
- 🔴 Task 3.5: Update `__subscribeMultiple` for new signature
- 🔴 Task 3.6: Remove `loro` import from subscribe.ts
- 🔴 Task 3.7: Remove `LoroEventBatch` type from subscribe.ts
- 🔴 Task 3.8: Update `__listRegion` in regions.ts to receive `ReactiveDelta` and extract list ops
- 🔴 Task 3.9: Update `planDeltaOps` to accept Kinetic's `ListDeltaOp[]` instead of `LoroEventBatch`
- 🔴 Task 3.10: Update `ListDeltaEvent` test helper interface to match new delta shape
- 🔴 Task 3.11: Update `binding.ts` to remove `loro()` usage (bindings still use `__subscribe` with `"replace"` semantics)
- 🔴 Task 3.12: Add runtime tests: `LocalRef` with `__subscribe` emits `{ type: "replace" }`
- 🔴 Task 3.13: Add runtime tests: custom reactive type works with `__subscribe`
- 🔴 Task 3.14: Verify all existing subscribe.test.ts and regions.test.ts tests pass

### Phase 4: Update Compiler IR and Analysis 🔴

**Goal**: IR carries delta kind. Compiler distinguishes `"reactive"` from `"delta"` binding time.

- 🔴 Task 4.1: Add `DeltaKind` type to ir.ts
- 🔴 Task 4.2: Add `Dependency` interface to ir.ts (`{ source: string; deltaKind: DeltaKind }`)
- 🔴 Task 4.3: Update `ContentValue.dependencies` from `string[]` to `Dependency[]`
- 🔴 Task 4.4: Add `"delta"` to `BindingTime` type
- 🔴 Task 4.5: Add `getDeltaKind(type: Type): DeltaKind` to reactive-detection.ts — inspects type parameter of `Reactive<D>` to determine delta kind
- 🔴 Task 4.6: Update `extractDependencies` in analyze.ts to return `Dependency[]` with delta kind
- 🔴 Task 4.7: Update `analyzeExpression` to classify as `"delta"` when: single dependency, direct read expression, delta kind is not `"replace"`
- 🔴 Task 4.8: Update `LoopNode.dependencies` to `Dependency[]`
- 🔴 Task 4.9: Update `ConditionalNode` to store dependency with delta kind
- 🔴 Task 4.10: Update all IR factory functions (`createContent`, `createLoop`, etc.) for new types
- 🔴 Task 4.11: Update all IR tests
- 🔴 Task 4.12: Update all analyze tests for `Dependency[]` format
- 🔴 Task 4.13: Add analyze test: `TextRef` expression classified as `deltaKind: "text"`
- 🔴 Task 4.14: Add analyze test: `doc.title.toString().toUpperCase()` degrades to `"reactive"` (derived expression)
- 🔴 Task 4.15: Add analyze test: `LocalRef<boolean>` classified as `deltaKind: "replace"`
- 🔴 Task 4.16: Add analyze test: template literal with reactive interpolation degrades to `"reactive"`

### Phase 5: Update Codegen for Delta Dispatch 🔴

**Goal**: Codegen dispatches on delta kind. List regions use delta path. Text patching prepared but not yet wired.

- 🔴 Task 5.1: Update DOM codegen to read `Dependency` objects instead of `string` for subscription generation
- 🔴 Task 5.2: Update `generateAttributeSubscription` to extract `.source` from `Dependency`
- 🔴 Task 5.3: Update reactive text content generation to extract `.source` from `Dependency`
- 🔴 Task 5.4: Update `generateReactiveLoop` to pass delta kind through
- 🔴 Task 5.5: Update HTML codegen for `Dependency[]`
- 🔴 Task 5.6: Update all codegen tests for new dependency format
- 🔴 Task 5.7: Update transform.test.ts for new dependency format
- 🔴 Task 5.8: Update integration.test.ts — verify list regions still work with delta path
- 🔴 Task 5.9: Add integration test: `LocalRef` in conditional region end-to-end
- 🔴 Task 5.10: Add integration test: `LocalRef` as text content end-to-end
- 🔴 Task 5.11: Verify all 593+ kinetic tests pass

### Phase 6: Documentation 🔴

**Goal**: Document the delta-driven reactivity model.

- 🔴 Task 6.1: Update `packages/reactive/README.md` with `ReactiveDelta` types and contract
- 🔴 Task 6.2: Update `packages/kinetic/TECHNICAL.md` — new "Binding-Time Lattice" section documenting four levels
- 🔴 Task 6.3: Update `packages/kinetic/TECHNICAL.md` — update "Reactive Detection" section for delta kind extraction
- 🔴 Task 6.4: Update `packages/kinetic/TECHNICAL.md` — update "Runtime Dependencies" for delta-aware subscribe
- 🔴 Task 6.5: Update `packages/change/TECHNICAL.md` — document `reactive-bridge.ts` and delta translation
- 🔴 Task 6.6: Update root `TECHNICAL.md` — update symbol table for `REACTIVE` with delta callback
- 🔴 Task 6.7: Document how to create custom reactive types with delta support
- 🔴 Task 6.8: Update `kinetic-reactive-primitive.md` — mark Phases 5–6 as superseded by this plan

## Tests

### Phase 1: ReactiveDelta Types

```typescript
describe("ReactiveDelta", () => {
  it("replace delta has no ops", () => {
    const d: ReactiveDelta = { type: "replace" }
    expect(d.type).toBe("replace")
  })

  it("text delta carries ops", () => {
    const d: ReactiveDelta = { type: "text", ops: [{ retain: 5 }, { insert: "x" }] }
    expect(d.ops).toHaveLength(2)
  })

  it("list delta insert carries count not values", () => {
    const d: ReactiveDelta = { type: "list", ops: [{ retain: 2 }, { insert: 3 }] }
    expect(d.ops[1]).toEqual({ insert: 3 })
  })
})

describe("LocalRef emits replace delta", () => {
  it("callback receives { type: 'replace' } on set", () => {
    const ref = new LocalRef(0)
    let receivedDelta: ReactiveDelta | null = null
    ref[REACTIVE](ref, (delta) => { receivedDelta = delta })
    ref.set(1)
    expect(receivedDelta).toEqual({ type: "replace" })
  })
})
```

### Phase 2: Delta Translation

```typescript
describe("translateDiff", () => {
  it("translates TextDiff to text delta", () => {
    const loroDiff = { type: "text", diff: [{ retain: 3 }, { insert: "abc" }] }
    const delta = translateDiff(loroDiff)
    expect(delta).toEqual({ type: "text", ops: [{ retain: 3 }, { insert: "abc" }] })
  })

  it("translates ListDiff to list delta with counts", () => {
    const loroDiff = { type: "list", diff: [{ retain: 2 }, { insert: [["a", "b", "c"]] }] }
    const delta = translateDiff(loroDiff)
    expect(delta).toEqual({ type: "list", ops: [{ retain: 2 }, { insert: 3 }] })
  })

  it("translates CounterDiff to replace", () => {
    const loroDiff = { type: "counter", increment: 5 }
    const delta = translateDiff(loroDiff)
    expect(delta).toEqual({ type: "replace" })
  })

  it("translates MapDiff to map delta with changed keys", () => {
    const loroDiff = { type: "map", updated: { name: "Alice", age: undefined } }
    const delta = translateDiff(loroDiff)
    expect(delta).toEqual({ type: "map", ops: { keys: ["name", "age"] } })
  })
})

describe("TextRef [REACTIVE] emits text delta", () => {
  it("emits text delta on insert", () => {
    const doc = createTypedDoc(Shape.doc({ title: Shape.text() }))
    let receivedDelta: ReactiveDelta | null = null
    doc.title[REACTIVE](doc.title, (delta) => { receivedDelta = delta })
    doc.title.insert(0, "Hello")
    loro(doc).commit()
    expect(receivedDelta?.type).toBe("text")
  })
})
```

### Phase 3: Runtime Subscribe

```typescript
describe("__subscribe with REACTIVE", () => {
  it("LocalRef works with __subscribe", () => {
    const ref = new LocalRef(0)
    const scope = new Scope("test")
    let receivedDelta: ReactiveDelta | null = null
    __subscribe(ref, (delta) => { receivedDelta = delta }, scope)
    ref.set(1)
    expect(receivedDelta).toEqual({ type: "replace" })
    scope.dispose()
  })

  it("Loro TextRef works with __subscribe", () => {
    const doc = createTypedDoc(Shape.doc({ title: Shape.text() }))
    const scope = new Scope("test")
    let receivedDelta: ReactiveDelta | null = null
    __subscribe(doc.title, (delta) => { receivedDelta = delta }, scope)
    doc.title.insert(0, "Hi")
    loro(doc).commit()
    expect(receivedDelta?.type).toBe("text")
    scope.dispose()
  })

  it("custom reactive type works with __subscribe", () => {
    const custom = {
      listeners: new Set(),
      [REACTIVE]: (self, cb) => {
        self.listeners.add(cb)
        return () => self.listeners.delete(cb)
      }
    }
    const scope = new Scope("test")
    const received = []
    __subscribe(custom, (delta) => received.push(delta), scope)
    custom.listeners.forEach(cb => cb({ type: "replace" }))
    expect(received).toEqual([{ type: "replace" }])
    scope.dispose()
  })
})

describe("__listRegion with delta path", () => {
  // Existing list region tests should continue passing
  // with the delta flowing through [REACTIVE] instead of raw LoroEventBatch
})
```

### Phase 4: Compiler Analysis

```typescript
describe("delta kind extraction", () => {
  it("TextRef dependency has deltaKind 'text'", () => {
    // import { TextRef } from "@loro-extended/change"
    // declare const title: TextRef
    // → extractDependencies returns [{ source: "title", deltaKind: "text" }]
  })

  it("ListRef dependency has deltaKind 'list'", () => {
    // import { ListRef } from "@loro-extended/change"
    // declare const items: ListRef<string>
    // → extractDependencies returns [{ source: "items", deltaKind: "list" }]
  })

  it("LocalRef dependency has deltaKind 'replace'", () => {
    // import { LocalRef } from "@loro-extended/reactive"
    // declare const isOpen: LocalRef<boolean>
    // → extractDependencies returns [{ source: "isOpen", deltaKind: "replace" }]
  })

  it("direct read of TextRef classified as delta binding time", () => {
    // h1(doc.title.toString()) → bindingTime: "delta", deltaKind: "text"
  })

  it("derived expression degrades to reactive", () => {
    // h1(doc.title.toString().toUpperCase()) → bindingTime: "reactive"
  })

  it("template literal with reactive interpolation degrades to reactive", () => {
    // p(`Count: ${doc.count.get()}`) → bindingTime: "reactive"
  })
})
```

## Transitive Effect Analysis

### Package Dependency Graph

```
@loro-extended/reactive  (ReactiveDelta types, updated Reactive<D> interface)
    ↑
    ├── @loro-extended/change (translates LoroEventBatch → ReactiveDelta in [REACTIVE])
    │       ↑
    │       └── @loro-extended/kinetic (runtime consumes ReactiveDelta)
    │
    └── @loro-extended/kinetic (compiler extracts DeltaKind from Reactive<D> type param)
```

### Direct Impact

| File | Change | Risk |
|------|--------|------|
| `reactive/src/index.ts` | Add `ReactiveDelta`, update `ReactiveSubscribe<D>`, `Reactive<D>` | Medium — generic type parameter may affect downstream inference |
| `change/src/typed-refs/base.ts` | `[REACTIVE]` translates `LoroEventBatch` → `ReactiveDelta` | Medium — base class change affects all refs |
| `change/src/typed-refs/struct-ref.ts` | Proxy handler `[REACTIVE]` translates events | Medium — Proxy-specific implementation |
| `change/src/plain-value-ref/factory.ts` | Factory `[REACTIVE]` emits `{ type: "replace" }` | Low |
| `kinetic/src/runtime/subscribe.ts` | Uses `ref[REACTIVE]`, removes `loro()` import | High — core runtime change |
| `kinetic/src/runtime/regions.ts` | `__listRegion` consumes `ReactiveDelta` not `LoroEventBatch` | High — delta format change |
| `kinetic/src/runtime/binding.ts` | Remove `loro()` usage | Medium |
| `kinetic/src/compiler/ir.ts` | `Dependency` type, `"delta"` binding time | High — IR schema change |
| `kinetic/src/compiler/analyze.ts` | `extractDependencies` returns `Dependency[]`, delta kind extraction | High |
| `kinetic/src/compiler/reactive-detection.ts` | Add `getDeltaKind()` | Medium |
| `kinetic/src/compiler/codegen/dom.ts` | Read `Dependency` objects, dispatch on delta kind | High |
| `kinetic/src/compiler/codegen/html.ts` | Read `Dependency` objects | Medium |

### Transitive Impact

| File | Depends On | Impact |
|------|------------|--------|
| `kinetic/src/compiler/transform.ts` | `analyze.ts`, `ir.ts` | Must pass through new dependency format |
| `kinetic/src/compiler/transform.test.ts` | Full pipeline | Tests reference `dependencies` — must update format |
| `kinetic/src/compiler/integration.test.ts` | Full pipeline + runtime | Must verify delta path end-to-end |
| `kinetic/src/compiler/analyze.test.ts` | `analyze.ts` | Must update dependency assertions |
| `kinetic/src/compiler/codegen/dom.test.ts` | `dom.ts` | Must update dependency format in test IR |
| `kinetic/src/compiler/codegen/html.test.ts` | `html.ts` | Must update dependency format in test IR |
| `kinetic/src/compiler/ir.test.ts` | `ir.ts` | Factory function signatures change |
| `kinetic/src/runtime/subscribe.test.ts` | `subscribe.ts` | Handler signature changes |
| `kinetic/src/runtime/regions.test.ts` | `regions.ts` | Delta event format changes |
| `kinetic/src/runtime/binding.test.ts` | `binding.ts` | May need updates if `loro()` removal affects setup |
| `kinetic/src/compiler/tree-merge.test.ts` | `ir.ts` | Dependencies format in test data |

### Breaking Change Assessment

**All changes are internal.** No public API changes to end users.

- `ReactiveSubscribe` signature changes — but this is `0.0.1` experimental, no backward compat needed
- `Reactive` interface gains a generic parameter — default `= ReactiveDelta` preserves existing usage
- IR types change — these are internal compiler types, not public
- Runtime subscribe signatures change — called by generated code, not users

### Risk: Generic Type Parameter Inference

Adding `Reactive<D>` where `D extends ReactiveDelta` could affect `isTypeAssignableTo` checks if the compiler doesn't resolve the default type parameter correctly. Mitigation: the compiler checks assignability to `Reactive` (with default), not to a specific `Reactive<TextDelta>`.

### Risk: `planDeltaOps` Format Change

`planDeltaOps` currently parses `LoroEventBatch` with its `events[].diff.type === "list"` structure. After the change, it receives `ListDeltaOp[]` directly — a much simpler input. But all existing region tests construct `ListDeltaEvent` objects in the old format. These must be updated.

### Risk: Multi-Event Batches

A `LoroEventBatch` can contain multiple events (e.g., a transaction touching multiple containers). The `[REACTIVE]` implementation on a specific ref only receives events for its own container, but the `LoroEventBatch` wraps them in an array. The `translateDiff` helper must handle the case where `events` contains zero relevant diffs (emit no callback) or multiple (emit one delta per diff, or merge).

## Resources for Implementation

### Files to Create

- `packages/change/src/reactive-bridge.ts` — `translateDiff()` helper
- `packages/change/src/reactive-bridge.test.ts` — translation unit tests

### Files to Modify

| File | Summary |
|------|---------|
| `packages/reactive/src/index.ts` | `ReactiveDelta`, updated `ReactiveSubscribe<D>`, `Reactive<D>`, `LocalRef` |
| `packages/reactive/src/index.test.ts` | Delta assertion tests |
| `packages/change/src/typed-refs/base.ts` | `[REACTIVE]` emits translated delta |
| `packages/change/src/typed-refs/struct-ref.ts` | Proxy handler `[REACTIVE]` emits translated delta |
| `packages/change/src/plain-value-ref/factory.ts` | `[REACTIVE]` emits `{ type: "replace" }` with delta callback |
| `packages/change/src/typed-refs/reactive.test.ts` | Assert delta payloads |
| `packages/kinetic/src/runtime/subscribe.ts` | Use `[REACTIVE]`, remove `loro()` |
| `packages/kinetic/src/runtime/regions.ts` | Consume `ReactiveDelta` in `__listRegion` |
| `packages/kinetic/src/runtime/binding.ts` | Remove `loro()` usage |
| `packages/kinetic/src/compiler/ir.ts` | `Dependency`, `DeltaKind`, `"delta"` binding time |
| `packages/kinetic/src/compiler/analyze.ts` | `extractDependencies` → `Dependency[]`, delta classification |
| `packages/kinetic/src/compiler/reactive-detection.ts` | `getDeltaKind()` |
| `packages/kinetic/src/compiler/codegen/dom.ts` | Read `Dependency` objects |
| `packages/kinetic/src/compiler/codegen/html.ts` | Read `Dependency` objects |
| `packages/kinetic/src/compiler/transform.ts` | Pass through new types |
| All test files in kinetic/src/compiler/ and kinetic/src/runtime/ | Update dependency format and delta assertions |

### Files for Reference

- `global-docs/loro-wasm.d.ts` — Loro's `Diff`, `ListDiff`, `TextDiff`, `MapDiff`, `TreeDiff`, `CounterDiff`, `LoroEventBatch`, `LoroEvent` types
- `global-docs/loro-index.md` — Loro documentation links
- `.plans/kinetic-reactive-primitive.md` — Prior plan (Phases 0–4 complete, 5–6 superseded)

### Key Code Section: Current [REACTIVE] on TypedRef (to be updated)

```typescript
// packages/change/src/typed-refs/base.ts
readonly [REACTIVE]: ReactiveSubscribe = (
  self: unknown,
  callback: () => void,
) => {
  const ref = self as TypedRef<Shape>
  const container = ref[INTERNAL_SYMBOL].getContainer()
  const unsubscribe = container.subscribe(() => callback())
  return unsubscribe
}
```

Target: translate `LoroEventBatch` through `translateDiff`, pass `ReactiveDelta` to `callback`.

### Key Code Section: Current planDeltaOps (to be simplified)

```typescript
// packages/kinetic/src/runtime/regions.ts — current
export function planDeltaOps<T>(
  listRef: ListRefLike<T>,
  event: ListDeltaEvent | LoroEventBatch,
): ListRegionOp<T>[] {
  for (const diff of event.events) {
    if (diff.diff.type !== "list") continue
    const deltas = diff.diff.diff as Array<{ retain?; delete?; insert? }>
    // ...
  }
}
```

Target: receives `ListDeltaOp[]` directly — no unwrapping, no type filtering.

### Key Code Section: Current __subscribe (to be replaced)

```typescript
// packages/kinetic/src/runtime/subscribe.ts — current
import { loro } from "@loro-extended/change"
export function __subscribe(ref: unknown, handler: (event: LoroEventBatch) => void, scope: Scope) {
  const container = loro(ref as any) as Subscribable
  const unsubscribe = container.subscribe(handler)
  // ...
}
```

Target:
```typescript
import { REACTIVE, type Reactive, type ReactiveDelta } from "@loro-extended/reactive"
export function __subscribe(ref: Reactive, handler: (delta: ReactiveDelta) => void, scope: Scope) {
  const unsubscribe = ref[REACTIVE](ref, handler)
  // ...
}
```

### Key Code Section: Loro Diff Types (reference for translateDiff)

```typescript
// From global-docs/loro-wasm.d.ts
type Diff = ListDiff | TextDiff | MapDiff | TreeDiff | CounterDiff

type ListDiff = { type: "list"; diff: Delta<(Value | Container)[]>[] }
type TextDiff = { type: "text"; diff: Delta<string>[] }
type MapDiff  = { type: "map"; updated: Record<string, Value | Container | undefined> }
type TreeDiff = { type: "tree"; diff: TreeDiffItem[] }
type CounterDiff = { type: "counter"; increment: number }

type Delta<T> =
  | { insert: T; attributes?: Record<string, Value> }
  | { delete: number }
  | { retain: number; attributes?: Record<string, Value> }
```

## Changeset

```
---
"@loro-extended/reactive": minor
"@loro-extended/kinetic": minor
"@loro-extended/change": minor
---

Delta-driven reactivity: structured change propagation

@loro-extended/reactive:
- `ReactiveDelta` discriminated union: replace, text, list, map, tree
- `ReactiveSubscribe<D>` callback now receives delta describing what changed
- `Reactive<D>` interface generic over delta type
- `LocalRef<T>` emits `{ type: "replace" }` deltas

@loro-extended/change:
- All ref `[REACTIVE]` implementations translate `LoroEventBatch` → `ReactiveDelta`
- New `reactive-bridge.ts` module with `translateDiff()` helper
- No Loro event types leak through the reactive interface

@loro-extended/kinetic:
- `__subscribe` uses `ref[REACTIVE]` uniformly — no `loro()` calls in runtime
- `__listRegion` consumes `ReactiveDelta` list deltas instead of raw `LoroEventBatch`
- IR carries `DeltaKind` on dependencies for compile-time delta dispatch
- `BindingTime` extended with `"delta"` level for direct-read expressions
- `LocalRef` works end-to-end in all reactive contexts
```

## TECHNICAL.md Updates

### Root TECHNICAL.md

Update the symbol table entry for `REACTIVE`:

| Symbol | Function | Purpose |
|--------|----------|---------|
| `REACTIVE` | `isReactive()` | Reactive subscribe function with delta callback (from `@loro-extended/reactive`) |

### packages/kinetic/TECHNICAL.md

**New section: "Binding-Time Lattice"** (replace current "Binding-Time Analysis"):

The compiler classifies values by **when they become known** and **how much is known about changes**:

```
literal  <  render  <  reactive  <  delta
```

- **literal**: Value known at compile time. Residualize to constant.
- **render**: Value known at mount time. Residualize to one-shot evaluation.
- **reactive**: Value varies at runtime, change is opaque or expression is derived. Residualize to subscribe + re-read + replace.
- **delta**: Value varies at runtime, expression is a direct read, source provides structured deltas. Residualize to subscribe + apply patch.

The `delta` level is parameterized by `DeltaKind`:

| DeltaKind | Source Types | DOM Residualization |
|-----------|-------------|---------------------|
| `"replace"` | `LocalRef`, `CounterRef`, `PlainValueRef` | Re-read + replace (same as reactive) |
| `"text"` | `TextRef` | `textNode.insertData()` / `deleteData()` |
| `"list"` | `ListRef`, `MovableListRef` | `__listRegion` with structural ops |
| `"map"` | `RecordRef`, `StructRef` | (future) patch changed keys only |
| `"tree"` | `TreeRef` | (future) structural tree ops |

An expression degrades from `delta` to `reactive` when:
- It has multiple dependencies
- The expression transforms the value (e.g., `.toUpperCase()`)
- The expression interpolates into a template literal

**Update section: "Reactive Detection"**:

Add `getDeltaKind(type: Type): DeltaKind` — inspects the type parameter of `Reactive<D>` to determine what kind of delta the type emits. This information flows into the IR as `Dependency.deltaKind`.

**Update section: "Runtime Dependencies"**:

All runtime subscribe functions receive `ReactiveDelta` instead of `LoroEventBatch`. The `[REACTIVE]` function on each ref translates Loro events into Kinetic's delta vocabulary. This decouples the runtime from Loro's event format.

### packages/change/TECHNICAL.md

**New section: "Reactive Bridge"**:

The `reactive-bridge.ts` module translates Loro's `Diff` types into Kinetic's `ReactiveDelta` vocabulary. Each `[REACTIVE]` implementation on typed refs uses this to convert `LoroEventBatch` events before passing them to subscribers. No Loro event types are exposed through the reactive interface.

Key translation rules:
- `TextDiff` → `{ type: "text", ops }` (retain/insert/delete preserved)
- `ListDiff` → `{ type: "list", ops }` (insert carries **count**, not values)
- `MapDiff` → `{ type: "map", ops: { keys } }` (changed key names only)
- `TreeDiff` → `{ type: "tree", ops }` (create/delete/move actions)
- `CounterDiff` → `{ type: "replace" }` (increment not useful for DOM)

### packages/reactive/README.md

Document `ReactiveDelta` as the universal change vocabulary. Any type implementing `Reactive<D>` must emit the appropriate delta variant through its `[REACTIVE]` callback. `{ type: "replace" }` is the minimum viable delta — it means "something changed, re-read if you care."