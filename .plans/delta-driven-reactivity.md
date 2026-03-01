# Plan: Delta-Driven Reactivity

## Background

Kinetic's compiler performs partial evaluation at three binding-time levels: `literal`, `render`, and `reactive`. The `reactive` level currently means "something changed, re-read the entire value and replace." This is the same model as React, Solid, and every other reactive framework.

But Loro CRDTs provide structured deltas — not just "something changed" but "here's exactly what changed." A text edit produces `{ retain: 5, insert: "x" }`. A list mutation produces `{ retain: 2, delete: 1, insert: 3 }`. Today, Kinetic already exploits list deltas in `__listRegion` for O(k) DOM updates — but this capability is:

1. **Hard-coded** — only lists get delta-driven rendering
2. **Loro-specific** — the runtime directly consumes `LoroEventBatch`, coupling it to Loro's event format
3. **Invisible to the IR** — the IR says `"reactive"` for lists and text alike; only the runtime knows lists are special

Meanwhile, the existing `[REACTIVE]` subscribe function uses a `() => void` callback signature, which structurally prevents delta information from flowing to consumers. This forces the runtime to either (a) re-read entire values or (b) bypass `[REACTIVE]` entirely for delta-aware code paths (which is what `__listRegion` does today via `__subscribe` + `LoroEventBatch`).

### The Insight: Delta Kind Is a Refinement of Reactive

The three binding-time levels are temporal — *when* does the value become known:

1. **literal**: compile time
2. **render**: mount time
3. **reactive**: runtime (repeatedly, on change)

Delta information arrives at the same *time* as reactive — when the source changes. The difference is *how much structural information* accompanies the notification. That's a property of the *source*, not a separate temporal level.

So `BindingTime` stays as `"literal" | "render" | "reactive"`. But reactive dependencies carry a `DeltaKind` that tells codegen *how* to subscribe and update:

- `"replace"`: re-read entire value, replace DOM content (the default, equivalent to every other reactive framework)
- `"text"`: character-level ops — enables `textNode.insertData(offset, chars)`
- `"list"`: structural list ops — enables `__listRegion` with insert/delete at indices
- `"map"`: key-level ops — enables patching only changed entries (future)
- `"tree"`: hierarchical ops — enables structural tree updates (future)

`DeltaKind` is an optimization hint that codegen dispatches on. When the expression is a "direct read" and the delta kind is rich (text, list, etc.), codegen can emit specialized patch code. Otherwise it falls back to replace semantics. The fallback is always safe.

### Relationship to Prior Work

The [kinetic-reactive-primitive.md](./kinetic-reactive-primitive.md) plan (Phases 0–4 complete) established:

- `@loro-extended/reactive` package with `REACTIVE` symbol, `Reactive` interface, `LocalRef`
- Structural compiler detection via property-level symbol check (originally `isTypeAssignableTo`, replaced — see Learnings)
- `[REACTIVE]` on all `@loro-extended/change` refs

Phases 5–6 of that plan are **superseded by this plan**. The original Phase 5 proposed updating `__subscribe` to use `ref[REACTIVE](ref, () => void)` — a uniform but delta-unaware callback. This plan replaces that with a delta-aware callback that carries structured change information.

## Problem Statement

1. The `ReactiveSubscribe` callback signature is `() => void` — it cannot carry delta information
2. The runtime's `__subscribe` uses `loro()` to get Loro containers and passes raw `LoroEventBatch` — coupling the runtime to Loro's event format
3. `__listRegion` already consumes structured deltas but the IR doesn't carry delta kind — it's classified as `"reactive"` like everything else
4. Text content always re-reads and replaces the entire string, even for single-character edits
5. There is no mechanism for `LocalRef` or custom reactive types to express structured deltas
6. The IR lacks delta kind information on dependencies, preventing the compiler from generating delta-specialized code

## Success Criteria

1. `ReactiveSubscribe` callback receives a `ReactiveDelta` discriminated union describing what changed
2. Every `[REACTIVE]` implementation translates its native events into `ReactiveDelta` — no Loro types leak to consumers
3. The IR carries delta kind on dependencies (not just `string[]` but `{ source, deltaKind }[]`)
4. `BindingTime` remains `"literal" | "render" | "reactive"` — delta kind is an orthogonal property on dependencies, not a fourth binding time
5. Codegen dispatches on delta kind to emit specialized code (list deltas today, text deltas as next target)
6. `__subscribe` uses `ref[REACTIVE](ref, callback)` uniformly — no `loro()` calls in subscribe.ts
7. `__listRegion` consumes list deltas via the `[REACTIVE]` path instead of raw `LoroEventBatch`
8. `LocalRef<T>` emits `{ type: "replace" }` deltas and works end-to-end
9. All existing tests pass (598 kinetic, 964 change, 46 reactive)

## The Gap

| Aspect | Current | Target |
|--------|---------|--------|
| `ReactiveSubscribe` callback | `() => void` | `(delta: ReactiveDelta) => void` |
| Codegen dispatch | Uniform `__subscribeWithValue` | Dispatches on `DeltaKind` per dependency |
| IR dependencies | `string[]` | `Array<{ source: string; deltaKind: DeltaKind }>` |
| `__subscribe` | Uses `loro()`, passes `LoroEventBatch` | Uses `ref[REACTIVE]`, receives `ReactiveDelta` |
| `__listRegion` | Consumes `LoroEventBatch` directly | Consumes `ReactiveDelta` of type `"list"` |
| Text updates | `textNode.textContent = newValue` | `textNode.insertData(offset, chars)` (when direct read) |
| `LocalRef` runtime | Not tested end-to-end in compiler | Emits `{ type: "replace" }`, works in all contexts |
| Loro bindings | In core runtime (`kinetic/src/runtime/binding.ts`) | Separate subpath (`@loro-extended/kinetic/loro`) |

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

### BindingTime (Unchanged)

```typescript
export type BindingTime = "literal" | "render" | "reactive"
```

`BindingTime` is not extended. Delta kind is an orthogonal property carried on each `Dependency`, not a fourth binding-time level. Whether codegen can exploit structured deltas is a codegen optimization decision based on the dependency's `deltaKind` and whether the expression is a direct read — not a binding-time classification.

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

### Phase 2: Update @loro-extended/change [REACTIVE] Implementations ✅

**Goal**: Each ref's `[REACTIVE]` translates `LoroEventBatch` → `ReactiveDelta`. No Loro types leak.

- ✅ Task 2.1: Create `translateDiff(diff: Diff): ReactiveDelta` helper in a new `reactive-bridge.ts` module
- ✅ Task 2.2: Update `TypedRef` base class `[REACTIVE]` to translate events via `translateEventBatch`
- ✅ Task 2.3: `TextRef` emits `{ type: "text", ops }` — via base class + `translateDiff` dispatching on `Diff.type`
- ✅ Task 2.4: `CounterRef` emits `{ type: "replace" }` — `translateDiff` maps `CounterDiff` → replace
- ✅ Task 2.5: `ListRef` emits `{ type: "list", ops }` — insert carries count, not values
- ✅ Task 2.6: `MovableListRef` emits `{ type: "list", ops }` — same translation via base class
- ✅ Task 2.7: `RecordRef` and `StructRef` emit `{ type: "map", ops }` — StructRef Proxy handler updated
- ✅ Task 2.8: `TreeRef` emits `{ type: "tree", ops }` — via base class
- ✅ Task 2.9: `PlainValueRef` emits `{ type: "replace" }` — factory updated
- ✅ Task 2.10: Update existing reactive.test.ts — 5 new delta-specific tests (28 total)
- ✅ Task 2.11: Add translation unit tests in `reactive-bridge.test.ts` (24 tests)

Note: `TypedRef` base class currently has a single `[REACTIVE]` implementation that calls `container.subscribe(() => callback())`. After this phase, the base class implementation should translate the Loro event through `translateDiff`. Subclass-specific behavior (TextRef emitting text deltas vs CounterRef emitting replace) is determined by the `Diff.type` field in the Loro event, not by overriding `[REACTIVE]`. The `StructRef` Proxy handler and `PlainValueRef` factory have their own implementations that must also be updated.

### Phase 3: Update Kinetic Runtime Subscribe ✅

**Goal**: `__subscribe` uses `ref[REACTIVE](ref, callback)` uniformly. No `loro()` calls in core runtime. Loro-specific bindings move to `@loro-extended/kinetic/loro` subpath.

#### Part A: Move Loro Bindings to Subpath

- ✅ Task 3.1: Create `packages/kinetic/src/loro/` directory
- ✅ Task 3.2: Move `binding.ts` → `src/loro/binding.ts`
- ✅ Task 3.3: Move `binding.test.ts` → `src/loro/binding.test.ts`
- ✅ Task 3.4: Create `src/loro/index.ts` exporting `__bindTextValue`, `__bindChecked`, `__bindNumericValue`
- ✅ Task 3.5: Update `package.json` exports: add `"./loro": "./src/loro/index.ts"`
- ✅ Task 3.6: Update any internal imports that reference the old `binding.ts` path

#### Part B: Decouple Core Runtime from Loro

- ✅ Task 3.7: Import `REACTIVE`, `isReactive`, `ReactiveDelta` from `@loro-extended/reactive` in subscribe.ts
- ✅ Task 3.8: Update `__subscribe` signature: `handler` becomes `(delta: ReactiveDelta) => void`
- ✅ Task 3.9: Implement `__subscribe` body: `ref[REACTIVE](ref, handler)` — no `loro()` import
- ✅ Task 3.10: Update `__subscribeWithValue` to ignore delta (re-reads value regardless)
- ✅ Task 3.11: Update `__subscribeMultiple` for new signature
- ✅ Task 3.12: Remove `loro` import from subscribe.ts
- ✅ Task 3.13: Remove `LoroEventBatch` type from subscribe.ts
- ✅ Task 3.14: Verify `src/runtime/` has no imports from `@loro-extended/change`

#### Part C: Update List Regions for ReactiveDelta

- ✅ Task 3.15: Update `__listRegion` in regions.ts to receive `ReactiveDelta` and extract list ops
- ✅ Task 3.16: Update `planDeltaOps` to accept Kinetic's `ListDeltaOp[]` instead of `LoroEventBatch`
- ✅ Task 3.17: Add fallback: if `delta.type !== "list"`, trigger full re-render
- ✅ Task 3.18: Update `ListDeltaEvent` test helper interface to match new delta shape

#### Part D: Update Loro Bindings Subscribe Path

- ✅ Task 3.19: Update `src/loro/binding.ts` subscribe calls to use `[REACTIVE]` path
- ✅ Task 3.20: Verify write path retains `loro()` for mutations

#### Part E: Tests

- ✅ Task 3.21: Add runtime tests: `LocalRef` with `__subscribe` emits `{ type: "replace" }`
- ✅ Task 3.22: Add runtime tests: custom reactive type works with `__subscribe`
- ✅ Task 3.23: Verify all existing subscribe.test.ts and regions.test.ts tests pass
- ✅ Task 3.24: Verify `src/loro/binding.test.ts` tests pass

### Phase 4: Update Compiler IR and Analysis 🔴

**Goal**: IR carries delta kind on dependencies. `BindingTime` is unchanged.

- 🔴 Task 4.1: Add `DeltaKind` type to ir.ts (imported from `@loro-extended/reactive` or redefined)
- 🔴 Task 4.2: Add `Dependency` interface to ir.ts (`{ source: string; deltaKind: DeltaKind }`)
- 🔴 Task 4.3: Update `ContentValue.dependencies` from `string[]` to `Dependency[]`
- 🔴 Task 4.4: Add `getDeltaKind(type: Type): DeltaKind` to reactive-detection.ts — inspects the `[REACTIVE]` property's type to determine delta kind (see Learnings: "getDeltaKind Must Use Property Type Inspection, Not Interface Type Parameter Extraction")
- 🔴 Task 4.5: Update `extractDependencies` in analyze.ts to return `Dependency[]` with delta kind
- 🔴 Task 4.6: Update `LoopNode.dependencies` to `Dependency[]`
- 🔴 Task 4.7: Update `ConditionalNode` to store dependency with delta kind
- 🔴 Task 4.8: Update all IR factory functions (`createContent`, `createLoop`, etc.) for new types
- 🔴 Task 4.9: Update all IR tests
- 🔴 Task 4.10: Update all analyze tests for `Dependency[]` format
- 🔴 Task 4.11: Add analyze test: `TextRef` dependency has `deltaKind: "text"`
- 🔴 Task 4.12: Add analyze test: `ListRef` dependency has `deltaKind: "list"`
- 🔴 Task 4.13: Add analyze test: `LocalRef<boolean>` dependency has `deltaKind: "replace"`

### Phase 5: Update Codegen for Delta Dispatch 🔴

**Goal**: Codegen dispatches on delta kind. List regions use delta path. Text patching prepared but not yet wired. Loro binding imports use `@loro-extended/kinetic/loro` subpath.

- 🔴 Task 5.1: Update DOM codegen to read `Dependency` objects instead of `string` for subscription generation
- 🔴 Task 5.2: Update `generateAttributeSubscription` to extract `.source` from `Dependency`
- 🔴 Task 5.3: Update reactive text content generation to extract `.source` from `Dependency`
- 🔴 Task 5.4: Update `generateReactiveLoop` to pass delta kind through
- 🔴 Task 5.5: Update HTML codegen for `Dependency[]`
- 🔴 Task 5.6: Track whether component uses Loro bindings (`bind:value`, etc.)
- 🔴 Task 5.7: Generate `import { __bindX } from "@loro-extended/kinetic/loro"` when bindings are used
- 🔴 Task 5.8: Keep core runtime imports as `import { __subscribe } from "@loro-extended/kinetic"`
- 🔴 Task 5.9: Update all codegen tests for new dependency format
- 🔴 Task 5.10: Update transform.test.ts for new dependency format
- 🔴 Task 5.11: Update integration.test.ts — verify list regions still work with delta path
- 🔴 Task 5.12: Add integration test: `LocalRef` in conditional region end-to-end
- 🔴 Task 5.13: Add integration test: `LocalRef` as text content end-to-end
- 🔴 Task 5.14: Add integration test: component with `bind:value` imports from `kinetic/loro`
- 🔴 Task 5.15: Verify all 598+ kinetic tests pass

### Phase 6: Documentation 🔴

**Goal**: Document the delta-driven reactivity model and the `kinetic/loro` subpath architecture.

- 🔴 Task 6.1: Update `packages/reactive/README.md` with `ReactiveDelta` types and contract
- 🔴 Task 6.2: Update `packages/kinetic/TECHNICAL.md` — update "Binding-Time Analysis" section with delta kind as orthogonal property
- ✅ Task 6.3: ~~Update `packages/kinetic/TECHNICAL.md` — update "Reactive Detection" section~~ (done in compiler fix commit)
- 🔴 Task 6.4: Update `packages/kinetic/TECHNICAL.md` — update "Runtime Dependencies" for delta-aware subscribe
- 🔴 Task 6.5: Update `packages/kinetic/TECHNICAL.md` — document `kinetic/loro` subpath and binding architecture
- 🔴 Task 6.6: Update `packages/change/TECHNICAL.md` — document `reactive-bridge.ts` and delta translation
- 🔴 Task 6.7: Update root `TECHNICAL.md` — update symbol table for `REACTIVE` with delta callback
- 🔴 Task 6.8: Document how to create custom reactive types with delta support
- 🔴 Task 6.9: Update `kinetic-reactive-primitive.md` — mark Phases 5–6 as superseded by this plan
- 🔴 Task 6.10: Add `packages/kinetic/src/loro/README.md` explaining Loro-specific bindings

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

describe("kinetic/loro subpath", () => {
  it("binding functions are exported from @loro-extended/kinetic/loro", () => {
    // import { __bindTextValue, __bindChecked, __bindNumericValue } from "@loro-extended/kinetic/loro"
    expect(typeof __bindTextValue).toBe("function")
    expect(typeof __bindChecked).toBe("function")
    expect(typeof __bindNumericValue).toBe("function")
  })

  it("core runtime does not export binding functions", () => {
    // import * as kinetic from "@loro-extended/kinetic"
    // Binding functions should NOT be present
    expect("__bindTextValue" in kinetic).toBe(false)
  })

  it("core runtime has no @loro-extended/change imports", () => {
    // Verify src/runtime/ files don't import from @loro-extended/change
    // This is a static analysis / build verification test
  })
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

  it("TextRef expression is reactive with deltaKind 'text' on dependency", () => {
    // h1(doc.title.toString()) → bindingTime: "reactive", dep.deltaKind: "text"
  })

  it("derived expression is reactive with deltaKind 'text' on dependency", () => {
    // h1(doc.title.toString().toUpperCase()) → bindingTime: "reactive", dep.deltaKind: "text"
    // (codegen decides whether to exploit delta based on expression shape)
  })

  it("template literal with reactive interpolation is reactive", () => {
    // p(`Count: ${doc.count.get()}`) → bindingTime: "reactive", dep.deltaKind: "replace"
  })
})
```

## Learnings

### Three Levels, Not Four

We initially framed delta as a fourth binding-time level. After discussion, we concluded this is wrong. Binding-time levels are temporal — *when* does information become available. `literal` = compile time, `render` = mount time, `reactive` = runtime. Delta information arrives at runtime, the same moment as reactive. The difference is *how much* structural information accompanies the notification, not *when* it arrives.

`DeltaKind` is an orthogonal property on reactive dependencies — a refinement that tells codegen what optimizations are possible. The lattice remains three levels; the third level is parameterized:

```
literal  <  render  <  reactive
                         ├── replace (re-read + replace)
                         ├── text (character-level patch)
                         ├── list (structural list ops)
                         ├── map (key-level patch)
                         └── tree (hierarchical ops)
```

### `translateEventBatch` Calls Back Per-Diff, Not Per-Batch

A `LoroEventBatch` can contain multiple `LoroEvent` entries. The `[REACTIVE]` implementation calls the subscriber once per diff, not once per batch. This was a conscious design decision — merging diffs would complicate the delta types for no clear consumer benefit.

### reactive-bridge Uses Local Interfaces, Not Loro Imports

`reactive-bridge.ts` defines its own `LoroDelta`, `LoroListDiff`, etc. interfaces. This keeps the module's import boundary clean — it depends only on `@loro-extended/reactive` types, not `loro-crdt`. The `translateDiff` function accepts `unknown` and casts internally.

### `isTypeAssignableTo` Breaks on Generic Interfaces

Adding `Reactive<D extends ReactiveDelta = ReactiveDelta>` broke the compiler's `isReactiveType()` function. The root cause: `InterfaceDeclaration.getType().compilerType` on a generic interface returns the **generic type constructor** with an unresolved type parameter `D`, not an instantiation with the default. `isTypeAssignableTo(ListRef<string>, Reactive<D>)` then fails because TypeScript can't prove the assignment with `D` unresolved.

**Fix**: Replaced the entire detection strategy with property-level symbol checking. Instead of finding the `Reactive` interface and checking assignability, we check whether the **candidate type itself** has a property keyed by the `[REACTIVE]` unique symbol. This uses a three-layer approach:

1. **Symbol.for() tracing** — walk the property key's `nameType.symbol.valueDeclaration` AST to find `Symbol.for("kinetic:reactive")`. Works for `.ts` source files.
2. **Symbol declaration name** — check `nameType.symbol.escapedName === "REACTIVE"`. Works for `.d.ts` files where the initializer is erased.
3. **Property escaped name** — fallback to `compilerSymbol.escapedName.startsWith("__@REACTIVE@")`.

This approach is immune to changes in the `Reactive` interface's generic signature. The `getReactiveInterfaceType()` function and `reactiveInterfaceCache` were removed entirely.

**Key API detail**: `compilerSymbol.links.nameType` is TypeScript-internal but has been stable across TS 4.x–6.x. It's fundamental to computed property name handling. Layers 2 and 3 serve as fallbacks.

### `getDeltaKind` Must Use Property Type Inspection, Not Interface Type Parameter Extraction

Phase 4's Task 4.4 originally proposed extracting `D` from `Reactive<D>` to determine delta kind. This won't work for the same reason `isTypeAssignableTo` failed — the generic parameter isn't easily extractable from an instantiated type in the `.d.ts` context.

Instead, `getDeltaKind` should inspect the **type of the `[REACTIVE]` property** on the candidate type. For example, `ListRef`'s `[REACTIVE]` property has type `ReactiveSubscribe<{ type: "list"; ops: ListDeltaOp[] }>`. The delta kind can be extracted from the callback parameter's type. Alternatively, since the `[REACTIVE]` property type is `ReactiveSubscribe<D>` which is `(self, callback: (delta: D) => void) => () => void`, we can:

1. Get the `[REACTIVE]` property type on the candidate
2. Get its call signature's second parameter (the callback)
3. Get the callback's first parameter type (the delta type `D`)
4. Read the `type` discriminant from that delta type

If this proves too fragile, a simpler alternative: map known type names to delta kinds at the IR level (`TextRef` → `"text"`, `ListRef` → `"list"`, `LocalRef` → `"replace"`, etc.), with `"replace"` as the default for unknown reactive types. This is less general but sufficient for the current set of reactive types.

### binding.ts Write Path Needs `loro()` — Only Subscribe Side Can Be Updated

The plan's Task 3.11 originally said "remove `loro()` usage" from `binding.ts`. In reality, the three binding functions (`__bindTextValue`, `__bindChecked`, `__bindNumericValue`) use `loro()` for two purposes:

1. **Subscribe side**: `__subscribe(ref, handler, scope)` — this can and should use `[REACTIVE]`
2. **Write side**: direct Loro container mutation on input events (e.g., `textRef.delete(0, len)` + `textRef.insert(0, newValue)`) — this **must** retain `loro()` because the binding needs the raw Loro container to perform mutations

Task 3.11 has been updated to reflect this: update the subscribe calls, keep `loro()` for the write path.

### Loro Bindings Are a Loro-Specific Feature — Separate Subpath

Two-way bindings (`bind:value`, `bind:checked`) are fundamentally about syncing DOM inputs with Loro collaborative state. They require direct access to Loro containers for mutations. This is intentionally asymmetric with the read path:

- **Read path (subscribe)**: Fully decoupled via `[REACTIVE]`. Any type implementing `Reactive` can participate. `LocalRef`, custom reactive types, and Loro refs all work uniformly.
- **Write path (bindings)**: Loro-specific. Uses `loro()` to get the raw container for mutations like `textRef.delete()` + `textRef.insert()`.

Rather than hiding this asymmetry, we make it explicit by moving Loro bindings to a separate subpath:

```
@loro-extended/kinetic          # Core runtime — Loro-agnostic
├── __subscribe (uses [REACTIVE])
├── __subscribeWithValue
├── __listRegion (receives ReactiveDelta)
└── __conditionalRegion

@loro-extended/kinetic/loro     # Loro-specific extensions
├── __bindTextValue
├── __bindChecked
└── __bindNumericValue
```

Benefits:
1. **Clear separation of concerns** — the core runtime has no Loro imports
2. **Explicit in imports** — `import { __bindX } from "@loro-extended/kinetic/loro"` makes the Loro dependency visible
3. **Enables future extensibility** — other CRDT libraries could have their own binding subpaths
4. **`LocalRef` story is clear** — it works for rendering via `[REACTIVE]`, but doesn't participate in `bind:value` (use event handlers instead)

### Test File Paths Affect Module Resolution

`ts.resolveModuleName` uses the source file's path to locate `node_modules`. Creating test source files at `/tmp/...` or `/path/to/file.ts` causes module resolution to fail silently — types resolve to `any` with zero properties. Test source files must use paths relative to the project root (e.g., `"component.ts"`) so that `node_modules` is reachable via the standard resolution algorithm.

### `__listRegion` Will Receive One Delta Per Call, Not a Batch

Because `translateEventBatch` calls the subscriber once per diff (not once per batch), and `__subscribe` will forward `ReactiveDelta` directly, the `__listRegion` subscriber will receive exactly **one** `ReactiveDelta` per invocation. This simplifies `planDeltaOps`: it receives a single `ReactiveDelta` and extracts `ops` if `type === "list"`. For non-list deltas (e.g., `"replace"` from a transaction touching the container's parent), it should trigger a full re-render.

### `planDeltaOps` Signature Simplification

The original `planDeltaOps` signature was `planDeltaOps(listRef, event: ListDeltaEvent | LoroEventBatch)` which required parsing `event.events[].diff.diff`. After Phase 3, the signature is `planDeltaOps(listRef, deltaOps: ListDeltaOp[])` — the caller (`__listRegion`) extracts `delta.ops` before calling. This is cleaner and more testable. The `ListDeltaEvent` interface was removed entirely.

### Non-List Deltas Trigger Full Re-Render

When `__listRegion` receives a `ReactiveDelta` with `type !== "list"` (e.g., `"replace"` from a transaction affecting the container's parent), it clears all items and re-renders from scratch. This is the safe fallback — the delta vocabulary doesn't have a "list was wholesale replaced" variant, so `"replace"` serves as the catch-all.

### Handler Signature Compatibility

When updating `__subscribe` from `handler: (event: LoroEventBatch) => void` to `handler: (delta: ReactiveDelta) => void`, existing code that passed `() => void` handlers (like in `__subscribeWithValue`) continued to work. TypeScript allows a function that ignores its parameter to be assigned to a signature that provides one. This is intentional — don't add unnecessary wrapper functions.

### `isReactive` Validation Is Essential

Adding an explicit `isReactive()` check in `__subscribe` with a clear error message helps catch bugs during development. The error message `"__subscribe called with non-reactive value. Expected a value with [REACTIVE] property."` provides actionable feedback when something goes wrong.

### Test Files Can Still Import Loro

The goal of Phase 3 was to remove Loro imports from *runtime source files*, not test files. Tests for `subscribe.ts` and `regions.ts` still import from `@loro-extended/change` to create test fixtures — that's expected and correct. The constraint is on the production code path, not the test infrastructure.

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

| File | Change | Risk | Status |
|------|--------|------|--------|
| `reactive/src/index.ts` | Add `ReactiveDelta`, update `ReactiveSubscribe<D>`, `Reactive<D>` | ~~Medium~~ Low — generic param risk resolved | ✅ |
| `change/src/typed-refs/base.ts` | `[REACTIVE]` translates `LoroEventBatch` → `ReactiveDelta` | Medium — base class change affects all refs | ✅ |
| `change/src/typed-refs/struct-ref.ts` | Proxy handler `[REACTIVE]` translates events | Medium — Proxy-specific implementation | ✅ |
| `change/src/plain-value-ref/factory.ts` | Factory `[REACTIVE]` emits `{ type: "replace" }` | Low | ✅ |
| `kinetic/src/compiler/reactive-detection.ts` | Replaced `isTypeAssignableTo` with property-level detection | ~~Medium~~ Low — resolved | ✅ |
| `kinetic/src/runtime/subscribe.ts` | Uses `ref[REACTIVE]`, removes `loro()` import | High — core runtime change | ✅ |
| `kinetic/src/runtime/regions.ts` | `__listRegion` consumes `ReactiveDelta` not `LoroEventBatch` | High — delta format change | ✅ |
| `kinetic/src/runtime/binding.ts` | **Moved** to `src/loro/binding.ts` | Medium — file move | ✅ |
| `kinetic/src/loro/index.ts` | **New** — exports Loro-specific bindings | Low — new file | ✅ |
| `kinetic/package.json` | Add `"./loro"` subpath export | Low | ✅ |
| `kinetic/src/compiler/ir.ts` | `Dependency` type, `DeltaKind` | High — IR schema change | 🔴 |
| `kinetic/src/compiler/analyze.ts` | `extractDependencies` returns `Dependency[]`, delta kind extraction | High | 🔴 |
| `kinetic/src/compiler/reactive-detection.ts` | Add `getDeltaKind()` | Medium | 🔴 |
| `kinetic/src/compiler/codegen/dom.ts` | Read `Dependency` objects, dispatch on delta kind | High | 🔴 |
| `kinetic/src/compiler/codegen/html.ts` | Read `Dependency` objects | Medium | 🔴 |

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
| `kinetic/src/runtime/subscribe.test.ts` | `subscribe.ts` | Handler signature changes — ✅ updated |
| `kinetic/src/runtime/regions.test.ts` | `regions.ts` | Delta event format changes — ✅ updated |
| `kinetic/src/loro/binding.test.ts` | `binding.ts` | Moved from `src/runtime/`, path updates — ✅ done |
| `kinetic/src/runtime/index.ts` | Exports | Remove binding exports (moved to `kinetic/loro`) — ✅ done |
| `kinetic/src/compiler/tree-merge.test.ts` | `ir.ts` | Dependencies format in test data |

### Breaking Change Assessment

**All changes are internal.** No public API changes to end users.

- `ReactiveSubscribe` signature changes — but this is `0.0.1` experimental, no backward compat needed
- `Reactive` interface gains a generic parameter — default `= ReactiveDelta` preserves existing usage
- IR types change — these are internal compiler types, not public
- Runtime subscribe signatures change — called by generated code, not users

### Risk: Generic Type Parameter Inference ✅ RESOLVED

Adding `Reactive<D>` broke `isTypeAssignableTo` checks because `getType()` on a generic interface returns a type with unresolved parameters. **Fixed by replacing with property-level detection** — see Learnings: "`isTypeAssignableTo` Breaks on Generic Interfaces".

### Risk: `planDeltaOps` Format Change ✅ RESOLVED

`planDeltaOps` now accepts `ListDeltaOp[]` directly instead of `LoroEventBatch`. The caller (`__listRegion`) extracts `delta.ops` from the `ReactiveDelta` before calling. The `ListDeltaEvent` interface was removed. All region tests were updated to pass `ListDeltaOp[]` arrays.

### Risk: Multi-Event Batches ✅ RESOLVED

`translateEventBatch` calls the subscriber once per diff, not once per batch. Each `[REACTIVE]` callback invocation delivers exactly one `ReactiveDelta`. This is already implemented and tested.

## Resources for Implementation

### Files to Create

- ✅ `packages/change/src/reactive-bridge.ts` — `translateDiff()` helper
- ✅ `packages/change/src/reactive-bridge.test.ts` — translation unit tests
- ✅ `packages/kinetic/src/loro/index.ts` — Loro-specific binding exports
- ✅ `packages/kinetic/src/loro/binding.ts` — moved from `src/runtime/binding.ts`
- ✅ `packages/kinetic/src/loro/binding.test.ts` — moved from `src/runtime/binding.test.ts`

### Files to Modify

| File | Summary |
|------|---------|
| File | Summary | Status |
|------|---------|--------|
| `packages/reactive/src/index.ts` | `ReactiveDelta`, updated `ReactiveSubscribe<D>`, `Reactive<D>`, `LocalRef` | ✅ |
| `packages/reactive/src/index.test.ts` | Delta assertion tests | ✅ |
| `packages/change/src/typed-refs/base.ts` | `[REACTIVE]` emits translated delta | ✅ |
| `packages/change/src/typed-refs/struct-ref.ts` | Proxy handler `[REACTIVE]` emits translated delta | ✅ |
| `packages/change/src/plain-value-ref/factory.ts` | `[REACTIVE]` emits `{ type: "replace" }` with delta callback | ✅ |
| `packages/change/src/typed-refs/reactive.test.ts` | Assert delta payloads | ✅ |
| `packages/kinetic/src/compiler/reactive-detection.ts` | Property-level detection replacing `isTypeAssignableTo` | ✅ |
| `packages/kinetic/src/compiler/analyze.test.ts` | Updated stubs for `Reactive<D>` | ✅ |
| `packages/kinetic/src/compiler/integration.test.ts` | Fixed `./loro-types` → `@loro-extended/change` imports | ✅ |
| `packages/kinetic/src/vite/plugin.test.ts` | Fixed file path for module resolution | ✅ |
| `packages/kinetic/TECHNICAL.md` | Updated Reactive Detection section | ✅ |
| `packages/kinetic/src/runtime/subscribe.ts` | Use `[REACTIVE]`, remove `loro()` | ✅ |
| `packages/kinetic/src/runtime/regions.ts` | Consume `ReactiveDelta` in `__listRegion` | ✅ |
| `packages/kinetic/src/runtime/index.ts` | Remove binding exports (moved to `kinetic/loro`) | ✅ |
| `packages/kinetic/package.json` | Add `"./loro"` export | ✅ |
| `packages/kinetic/src/compiler/ir.ts` | `Dependency`, `DeltaKind` | 🔴 |
| `packages/kinetic/src/compiler/analyze.ts` | `extractDependencies` → `Dependency[]`, delta classification | 🔴 |
| `packages/kinetic/src/compiler/reactive-detection.ts` | `getDeltaKind()` (Phase 4 addition) | 🔴 |
| `packages/kinetic/src/compiler/codegen/dom.ts` | Read `Dependency` objects | 🔴 |
| `packages/kinetic/src/compiler/codegen/html.ts` | Read `Dependency` objects | 🔴 |
| `packages/kinetic/src/compiler/transform.ts` | Pass through new types | 🔴 |
| All test files in kinetic/src/compiler/ and kinetic/src/runtime/ | Update dependency format and delta assertions | 🔴 |

### Files for Reference

- `global-docs/loro-wasm.d.ts` — Loro's `Diff`, `ListDiff`, `TextDiff`, `MapDiff`, `TreeDiff`, `CounterDiff`, `LoroEventBatch`, `LoroEvent` types
- `global-docs/loro-index.md` — Loro documentation links
- `.plans/kinetic-reactive-primitive.md` — Prior plan (Phases 0–4 complete, 5–6 superseded)

### Key Code Section: [REACTIVE] on TypedRef ✅ DONE

```typescript
// packages/change/src/typed-refs/base.ts — CURRENT (updated in Phase 2)
readonly [REACTIVE]: ReactiveSubscribe = (
  self: unknown,
  callback: (delta: ReactiveDelta) => void,
) => {
  const ref = self as TypedRef<Shape>
  const container = ref[INTERNAL_SYMBOL].getContainer()
  const unsubscribe = container.subscribe(event => {
    translateEventBatch(event, callback)
  })
  return unsubscribe
}
```

### Key Code Section: Current planDeltaOps (to be simplified in Phase 3)

```typescript
// packages/kinetic/src/runtime/regions.ts — current (still consuming LoroEventBatch)
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

Target: receives a single `ReactiveDelta`. If `delta.type === "list"`, extract `delta.ops` as `ListDeltaOp[]`. If `delta.type === "replace"`, trigger full re-render. Other delta types are ignored.

### Key Code Section: Current __subscribe (to be replaced in Phase 3)

```typescript
// packages/kinetic/src/runtime/subscribe.ts — current (still using loro())
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
- `BindingTime` unchanged — delta kind is an orthogonal optimization hint
- `LocalRef` works end-to-end in all reactive contexts
```

## TECHNICAL.md Updates

### Root TECHNICAL.md

Update the symbol table entry for `REACTIVE`:

| Symbol | Function | Purpose |
|--------|----------|---------|
| `REACTIVE` | `isReactive()` | Reactive subscribe function with delta callback (from `@loro-extended/reactive`) |

### packages/kinetic/TECHNICAL.md

**Update section: "Binding-Time Analysis"** — add delta kind as orthogonal property:

The compiler classifies values by **when they become known**:

```
literal  <  render  <  reactive
```

- **literal**: Value known at compile time. Residualize to constant.
- **render**: Value known at mount time. Residualize to one-shot evaluation.
- **reactive**: Value varies at runtime. Residualize to subscribe + update.

Reactive dependencies carry an additional `DeltaKind` property describing what kind of structured change the source provides. This is an orthogonal optimization hint — not a fourth binding-time level — because delta information arrives at the same *time* as reactive (when the source changes). The difference is *how much structural information* accompanies the notification.

| DeltaKind | Source Types | DOM Strategy |
|-----------|-------------|---------------------|
| `"replace"` | `LocalRef`, `CounterRef`, `PlainValueRef` | Re-read + replace (default) |
| `"text"` | `TextRef` | `textNode.insertData()` / `deleteData()` (when direct read) |
| `"list"` | `ListRef`, `MovableListRef` | `__listRegion` with structural ops |
| `"map"` | `RecordRef`, `StructRef` | (future) patch changed keys only |
| `"tree"` | `TreeRef` | (future) structural tree ops |

Codegen dispatches on `DeltaKind` to choose the update strategy. Whether the delta can actually be exploited depends on the expression shape — a direct read like `doc.title.toString()` is delta-eligible, while a derived expression like `doc.title.toString().toUpperCase()` falls back to replace semantics. This is a codegen decision, not a binding-time classification.

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