# Incremental View Maintenance Over Structured Deltas

> A compiler for incremental programs over structured deltas, disguised as a web framework.

## 1. The Realization

Kyneta started as a web framework. The early work focused on template cloning, SSR hydration, DOM regions, and reactive subscriptions. But the problems we kept encountering — reactive props across component boundaries, external dependencies in list regions, filter predicates that silently lose reactivity through local variable bindings — are not web problems. They are **incremental view maintenance** problems.

The DOM is one rendering target. The real contribution is the compiler: a system that takes programs written over structured, delta-emitting state and produces **optimal incremental maintenance circuits** that keep a derived view consistent with the source state, doing work proportional to the size of the change rather than the size of the data.

This document describes the compiler's theoretical foundations, its relationship to DBSP and the incremental λ-calculus, the restricted TypeScript sublanguage it analyzes, and the primitive operation algebra it decomposes programs into.

## 2. Theoretical Foundations

### 2.1. DBSP: Streams, Differentiation, Integration

DBSP (Budiu et al.) provides the mathematical framework. The core concepts, adapted to Kyneta's domain:

**Stream.** A Changefeed is a stream: it has a current value (the head) and emits a sequence of deltas (the tail). In DBSP notation, a Changefeed over type `S` emitting changes of type `C` is a stream `s ∈ Stream[S]` where `s[t]` is the state after `t` changes.

**Differentiation (D).** The delta a Changefeed emits is the derivative of the stream: `D(s)[t] = s[t] - s[t-1]`. In Kyneta, `D` produces a `Change` — a `TextChange`, `SequenceChange`, `ReplaceChange`, etc. The change type is the concrete representation of the derivative.

**Integration (I).** The `step()` function in `@kyneta/schema` is integration: `I(changes)[t] = Σ_{i≤t} changes[i]`. Applying a sequence of changes to an initial state reconstructs the current state. `step(state, change)` computes one step of integration.

**Lifting (↑Q).** A pure function `Q: A → B` lifts to a stream operator `↑Q: Stream[A] → Stream[B]` by applying `Q` pointwise: `(↑Q)(s)[t] = Q(s[t])`. In Kyneta, this is what happens when the developer writes a pure expression over reactive values — it's evaluated at each point in time.

**Incrementalization.** The incremental version of a stream operator `S` is `inc(S) = D ∘ S ∘ I`. It computes directly on deltas: given `ΔInput`, produce `ΔOutput` without reconstructing the full state. The key properties:

- **Chain rule:** `inc(S₁ ∘ S₂) = inc(S₁) ∘ inc(S₂)` — decompose complex queries into primitive operators, incrementalize each, compose.
- **Linear operators:** `inc(Q) = Q` — linear operators are their own incremental versions. Map, projection, and concatenation are linear.
- **Bilinear operators:** `inc(a × b) = Δa × Δb + z⁻¹(I(a)) × Δb + Δa × z⁻¹(I(b))` — bilinear operators (joins, filters with external predicates) require maintaining state but still do work proportional to the change size.

### 2.2. Positional vs. Bag Semantics

DBSP operates on **Z-sets** — unordered multisets with integer multiplicities. The group structure `(Z[A], +, 0, -)` enables clean differentiation and integration.

Kyneta operates on **ordered sequences** — lists where position matters. DOM children are ordered. A recipe at index 3 is the third child element. Inserting at position 2 shifts everything after it.

This is the difference between **bag semantics** (DBSP) and **list semantics** (what we need). Kyneta's delta types — `SequenceChange` with `retain/insert/delete` instructions — are richer than Z-set deltas. A `SequenceChange` is a *positional* delta encoding positions directly. DBSP's Z-set delta is positional-agnostic.

The bridge: the compiler reasons about operations using DBSP's algebra (chain rule, linearity, bilinearity) but emits code that works in terms of `SequenceChange` (retain/insert/delete). The translation from algebraic reasoning to positional deltas requires **index maps** — auxiliary state that tracks the correspondence between source positions and view positions.

### 2.3. The Incremental λ-Calculus Connection

The incremental λ-calculus (Cai, Giarrusso, et al.) provides the type-theoretic foundation. Given a function `f : A → B` and a change `Δa : ΔA`, the derivative `Δf(a, Δa) : ΔB` computes the change to the output.

Not all functions have efficient derivatives. The existence of an efficient derivative depends on the function's structure:

- `map` has an O(k) derivative — map the delta
- `filter` has a bilinear derivative — O(k) when the collection changes, O(n) when the predicate changes
- `sort` has an O(n log n) derivative — one insert can shift all indices
- `reduce` depends on the reducer — addition is O(1), arbitrary reducers may be O(n)

Kyneta's `deltaKind` is the concrete representation of this: it declares what change type a ref's derivatives produce. `"text"` means character-level ops; `"sequence"` means structural ops; `"replace"` means no structural delta — just re-read.

### 2.4. The Changefeed as Coalgebra

The Changefeed protocol in `@kyneta/schema` is a coalgebra — the dual of an algebra. In automata-theoretic terms, it's a Moore machine: `S → Output × (Input → S)`. The `current` getter produces the output (the head). The `subscribe` method provides the transition stream (the tail).

The compiler's job: given a program that reads from coalgebras (Changefeeds) and produces a view, decompose the program into an incremental circuit where each node subscribes to exactly the coalgebras it needs and emits exactly the deltas downstream consumers need.

## 3. The Restricted TypeScript Sublanguage

### 3.1. Builder Bodies Are Already Restricted

Today, builder bodies (the arrow functions inside `div(() => { ... })`) are analyzed by a closed set of recognized constructs:

- Element/component calls: `h1(...)`, `RecipeCard(...)`
- `for...of` loops: `for (const item of collection) { ... }`
- `if`/`else` conditionals: `if (pred) { ... } else { ... }`
- Labeled blocks: `client: { ... }`, `server: { ... }`
- Expression content: `doc.title`, `count()`
- Variable declarations: `const x = expr`

Everything else becomes a `StatementNode` — opaque text emitted verbatim, invisible to the reactive system. This is where reactivity goes to die.

### 3.2. The Shift: Total Analysis

The key design principle: **every construct in a builder body has defined incremental semantics, or it is a compile error.** There is no opaque fallback. The developer writes code the compiler fully understands, or they receive a clear error explaining why the construct isn't supported and what to do instead.

This is not "simpler TypeScript" in the sense of fewer features. It's simpler in the sense of **totality** — every expression has a defined reactive classification, and there's no escape hatch where reactivity silently disappears.

### 3.3. What Changes: BindingNode Replaces StatementNode

The primary source of information loss today is **variable declarations**. They launder reactive expressions into opaque names:

```typescript
// Today: these become opaque StatementNodes
const nameMatch = recipe.name().toLowerCase().includes(
  filterText().toLowerCase()
)
const veggieMatch = !veggieOnly() || recipe.vegetarian()

// The compiler sees boolean identifiers, not reactive dependencies
if (nameMatch && veggieMatch) { ... }
```

The fix: replace `StatementNode` with **`BindingNode`** inside builder bodies. A `BindingNode` is a named binding whose initializer is fully analyzed:

```
BindingNode {
  name: "nameMatch",
  value: ContentNode {
    source: "recipe.name().toLowerCase().includes(filterText().toLowerCase())",
    bindingTime: "reactive",
    dependencies: [
      { source: "recipe.name", deltaKind: "text" },
      { source: "filterText", deltaKind: "replace" }
    ]
  }
}
```

The compiler maintains a **BindingScope** during analysis. When it encounters `if (nameMatch && veggieMatch)`, it looks up the bindings and discovers the transitive reactive dependencies. The condition becomes reactive. The reactivity information is preserved through the binding boundary.

This alone — BindingNode + scope tracking — solves the majority of the problems we observed in the recipe-book example. No new runtime needed. The existing `conditionalRegion` and `valueRegion` work correctly once the compiler can see through bindings.

### 3.4. Recognized Constructs and Their Errors

Inside builder bodies, the compiler recognizes:

| Construct | Status | Incremental Semantics | |---|---|---| | Element/component calls | ✅ Existing | Region creation | | `for...of` over Changefeed | ✅ Existing | listRegion / filteredListRegion | | `if`/`else` | ✅ Existing | conditionalRegion / dissolution | | `const x = expr` | 🆕 BindingNode | Dependency-tracked named value | | String/template literals | ✅ Existing | Literal content | | Reactive expressions | ✅ Existing | valueRegion / textRegion | | Pure function calls in expressions | ✅ Allowed | Part of dependency analysis | | Side-effect statements (console.log) | ⚠️ Allowed | SideEffectNode, no reactive implications | | `let` / mutable bindings | ❌ Error | No incremental semantics for mutation | | `while` / `do...while` | ❌ Error | No defined termination in reactive context | | `switch` | ❌ Error | Use `if`/`else-if`/`else` chains | | `try` / `catch` / `finally` | ❌ Error | Exception handling has no reactive semantics | | `return` | ❌ Error | Already rejected today | | `throw` | ❌ Error | No reactive semantics | | `for` (C-style) | ❌ Error | Use `for...of` over a collection | | `for...in` | ❌ Error | Use `for...of` | | `class` / `function` declaration | ❌ Error | Define outside builder body |

The errors are **instructive**, not punitive. Each one tells the developer what the compiler needs and suggests a supported alternative.

## 4. The Primitive Operation Algebra

### 4.1. Operations the Compiler Recognizes from Syntax

The compiler decomposes builder body patterns into incremental operations. Recognition is structural — based on AST patterns with type-level reactive analysis — not heuristic.

#### Filter

**Pattern:**

```typescript
for (const item of collection) {
  // Optional: bindings that compute predicate parts
  const x = f(item.field(), externalRef())
  
  // An `if` with no `else` that wraps ALL DOM-producing content
  if (predicate) {
    // ... DOM content ...
  }
}
```

**Recognition criteria:**

- `for...of` over a reactive iterable (deltaKind: "sequence")
- Loop body contains only bindings and a single `if`-no-`else`
- The `if` wraps all DOM-producing content (no DOM outside the `if`)
- The condition has both item-dependent and external reactive deps

**Decomposition:**

- Classify predicate dependencies as **item-dependent** (navigate from loop variable) or **external** (free variables)
- Emit `filteredListRegion` with:
  - `predicate`: the filter function
  - `itemDeps`: function returning exact leaf refs per item to subscribe to
  - `externalDeps`: array of external Changefeed refs

**DBSP classification:** Bilinear (collection × predicate → collection). O(k) on collection change, O(n) on predicate change, O(1) on individual item field change.

**Subscription architecture (precise, not firehose):**

1. `collection[CHANGEFEED].subscribe` — node-level structural changes
1. Per item: subscribe to exactly the leaf refs that `itemDeps` returns (e.g. `recipe.name`, `recipe.vegetarian` — NOT `subscribeTree`)
1. Per external dep: subscribe to each external ref

The compiler determines the exact per-item subscriptions at compile time by analyzing which fields of the loop variable appear in the predicate expression. This avoids the notification storm that `subscribeTree` would cause — the runtime subscribes to precisely the refs that matter.

When an item-dep fires: re-evaluate predicate for that one item. O(1). When an external dep fires: re-evaluate predicate for all items. O(n). When the collection changes structurally: evaluate predicate for new items, manage per-item subscriptions. O(k).

#### Per-Item Conditional

**Pattern:**

```typescript
for (const item of collection) {
  if (item.type() === "legume") {
    LegumeCard({ item })
  } else {
    IngredientCard({ item })
  }
}
```

**Recognition criteria:**

- `for...of` body contains an `if/else` (or `if/else-if/else`)
- **All branches produce DOM** (this is not a filter — no items excluded)
- Condition depends on the loop variable

**Decomposition:**

- Emit `listRegion` with per-item `conditionalRegion` inside
- Each item's conditional subscribes to its own condition refs

**DBSP classification:** Linear per item. O(1) per item change.

This already composes correctly with existing region algebra. No new runtime needed.

#### Mixed: Filter + Per-Item Conditional

**Pattern:**

```typescript
for (const item of collection) {
  if (item.category() === "legume") {
    LegumeCard({ item })
  } else if (item.inStock()) {
    IngredientCard({ item })
  }
  // No final else — items that match neither are excluded
}
```

**Recognition criteria:**

- `if/else-if` chain with no final `else` — some items excluded
- Multiple branches produce different DOM

**Decomposition:**

- Filter predicate: `item.category() === "legume" || item.inStock()`
- Inner conditional: selects which component to render for surviving items
- Emit `filteredListRegion` with inner `conditionalRegion` per item

#### Chained Filters

**Pattern:**

```typescript
for (const item of collection) {
  if (pred1) {
    if (pred2) {
      if (pred3) {
        // DOM
      }
    }
  }
}
```

**Recognition:** Nested `if`-without-`else` flattened to conjunction: `pred1 && pred2 && pred3`. Single `filteredListRegion` with compound predicate. Dependencies are the union across all predicates.

#### Slice (Future Optimization)

**Pattern:**

```typescript
for (const item of collection) {
  if (idx < 10) { ... }
}
// or
for (const item of collection) {
  if (idx >= page() * pageSize && idx < (page() + 1) * pageSize) { ... }
}
```

**Recognition:** Predicate is a contiguous index range (provable from the condition structure). Could be recognized as a special case of filter with O(1) incremental semantics instead of O(n) on external dep change.

**Decomposition:** `slicedListRegion` — specialized for contiguous ranges. On source structural change: O(1) index arithmetic. On range bound change: O(w) where w is window size.

This is an optimization within the filter algebra, not a separate concept. The filter implementation is always correct; slice is faster for the contiguous case. Ship filter first, add slice recognition later.

### 4.2. Operations Requiring Explicit Building Blocks

Some operations have fundamentally different performance profiles that the developer should be aware of. These are expressed as explicit API calls, not inferred from syntax.

#### Window (Virtualization)

```typescript
window(doc.hugeList, {
  start: derived(() => Math.floor(scrollTop() / rowHeight)),
  size: derived(() => Math.ceil(viewportHeight() / rowHeight) + 1),
}, (item, idx) => {
  Row({ item, style: `top: ${idx * rowHeight}px` })
})
```

**Why explicit:** Virtualization implies a rendering budget determined by viewport physics. A 1M-item list with a scroll-based filter would trigger O(n) predicate re-evaluation on every scroll event. The developer needs to know they're managing a viewport, not filtering data.

**Incremental semantics:** Only create/destroy DOM for items entering/leaving the window. O(w) on window shift, O(1) on in-window item change.

#### Sort

```typescript
sort(doc.recipes, (a, b) => a.name().localeCompare(b.name()))
```

**Why explicit:** Sort has no efficient incremental form in general. One insert can change every item's position. O(n log n) on any structural change. The developer should know this cost.

**Incremental semantics:** Full re-sort on any structural or key-field change. Emit a SequenceChange representing the permutation diff.

#### GroupBy

```typescript
groupBy(doc.recipes, (r) => r.category(), (category, recipes) => {
  h2(category)
  for (const recipe of recipes) {
    RecipeCard({ recipe })
  }
})
```

**Why explicit:** GroupBy produces nested collections — a collection of collections. When an item's group key changes, it moves between groups. The state management is complex and the developer should understand the model.

**Incremental semantics:** O(k) per item change (move between groups). O(n) on group-key change (full re-group). Requires maintaining a per-group index.

### 4.3. Aggregations: Collection → Scalar

Aggregations reduce a collection to a single value. They produce a Changefeed with deltaKind "replace" — the output is a scalar that changes whenever the input collection or predicate changes.

| Operation | Incremental Cost | Example | |---|---|---| | `count(C)` | O(1) | `span(\`${count(filtered)} results\`)`| |`isEmpty(C)`| O(1) |`if (isEmpty(filtered)) { p("No results") }`| |`some(C, p)`| O(1) amortized |`if (some(tasks, t => t.selected())) { ... }`| |`every(C, p)`| O(1) amortized |`if (every(tasks, t => t.completed())) { ... }`| |`sum(C, f)`| O(1) |`span(\`Total: ${sum(items, i => i.price())}\`)`| |`reduce(C, f, init)\` | Depends on f | General-purpose fold |

These are important for a practical reason: they solve the **empty-state problem**. When all items are filtered out, the developer needs to display "No results found." This requires knowing whether the filtered collection is empty — which is an aggregation over the filter's output.

If aggregations produce Changefeeds, they compose with the existing reactive system: `if (isEmpty(filtered)) { ... }` becomes a `conditionalRegion` subscribing to the count's Changefeed.

### 4.4. Value Derivations: Scalar → Scalar

Pure functions over reactive scalars. Already handled today via `valueRegion`, but formalized as part of the algebra:

| Operation | Incremental Cost | Example | |---|---|---| | `derive(deps, f)` | O(1) re-evaluate | `const fullName = \`${first()} ${last()}\````  | | Template literals | O(k) per segment | `` \ ```Hello ${name}!\` \`\` |

With BindingNode, these are recognized automatically from `const` declarations in builder bodies. No explicit API needed.

## 5. Compiler Architecture

### 5.1. Pipeline

```
TypeScript Source (builder bodies)
    │
    ▼
┌──────────────────────────────────┐
│  Stage 1: Parse                  │
│  TS AST → Builder IR             │
│  (existing: analyze.ts)          │
└──────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────┐
│  Stage 2: Analyze                │
│  Dependency tracking through     │
│  bindings via BindingScope       │
│  BindingNode replaces            │
│  StatementNode for const decls   │
└──────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────┐
│  Stage 3: Decompose              │  ← The algebraic core
│  Recognize collection ops        │
│  Classify as DBSP primitives     │
│  Determine incremental strategy  │
│  Classify deps as item-dependent │
│  vs. external                    │
└──────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────┐
│  Stage 4: Optimize               │
│  Conditional dissolution         │
│  Filter → slice promotion        │
│  Target block filtering          │
│  SlotKind hints                  │
└──────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────┐
│  Stage 5: Emit                   │
│  Target-specific codegen         │
│  DOM: template cloning, regions  │
│  HTML: accumulator strings, SSR  │
│  (Future: native, canvas, etc.)  │
└──────────────────────────────────┘
```

Stage 3 is the new intellectual center. It takes the analyzed IR (with full dependency tracking) and classifies each construct into the algebra of incremental operations.

### 5.2. The IR Extension

The existing IR node types are extended, not replaced:

```
ChildNode =
  | ElementNode          (structure — existing)
  | ContentNode          (leaf value — existing)
  | LoopNode             (iteration — extended with filter metadata)
  | ConditionalNode      (branching — existing)
  | BindingNode          (named value — NEW, replaces StatementNode)
  | SideEffectNode       (console.log etc. — NEW, non-reactive)
  | TargetBlockNode      (client:/server: — existing)
```

**LoopNode extension:**

```
LoopNode = {
  kind: "loop"
  iterableSource: string
  iterableBindingTime: BindingTime
  itemVariable: string
  body: ChildNode[]
  dependencies: Dependency[]
  
  // NEW: filter metadata (populated by Stage 3)
  filter?: {
    predicate: ContentNode       // the full predicate expression
    itemDeps: Dependency[]       // deps that navigate from loop variable
    externalDeps: Dependency[]   // deps that are free variables
  }
  
  // Existing
  hasReactiveItems: boolean
  bodySlotKind: SlotKind
}
```

**BindingNode:**

```
BindingNode = {
  kind: "binding"
  name: string                   // "nameMatch"
  value: ContentNode             // analyzed initializer with reactive deps
  span: SourceSpan
}
```

### 5.3. Dependency Classification

Stage 3 classifies each dependency in a loop body relative to the loop variable:

- **Item-dependent:** The dependency navigates from the loop variable. `recipe.name` where `recipe` is the loop var. These require per-item subscriptions.

- **External:** The dependency is a free variable not derived from the loop variable. `filterText`, `veggieOnly`. These require one subscription each, shared across all items.

- **Structural:** The dependency is the iterable itself. `doc.recipes`. Already handled by the existing `listRegion` subscribe.

The classification is determined by tracing the expression AST: does the dependency's source text contain the loop variable name as a prefix? This is a syntactic check backed by type-level verification (the loop variable has a known type from the iterable's element type).

## 6. Runtime: filteredListRegion

### 6.1. Interface

```typescript
function filteredListRegion<T>(
  mountPoint: Node,
  listRef: unknown,           // The source collection Changefeed
  handlers: FilteredListHandlers<T>,
  scope: Scope,
): void

interface FilteredListHandlers<T> {
  /** Evaluate the filter predicate for an item */
  predicate: (item: T) => boolean
  
  /** Return the specific leaf refs to subscribe to for this item */
  itemDeps: (item: T) => unknown[]
  
  /** External refs — re-filter all items when any of these change */
  externalDeps: unknown[]
  
  /** Create the DOM for an item that passes the filter */
  create: (item: T, index: number) => Node
  
  slotKind?: SlotKind
  isReactive?: boolean
}
```

### 6.2. State

```typescript
interface FilteredListState<T> {
  // Source → View mapping
  sourceInView: boolean[]          // sourceInView[i] = item i passes predicate
  viewToSource: number[]           // viewToSource[j] = source index of view item j
  sourceToView: (number | null)[]  // sourceToView[i] = view index or null
  
  // Per-item subscription cleanup
  itemUnsubs: (() => void)[][]     // itemUnsubs[i] = unsub functions for source item i
  
  // The inner list region state (slots, scopes for DOM)
  slots: Slot[]
  scopes: (Scope | null)[]
  
  // References
  listRef: ListRefLike<T>
  parentScope: Scope
  endMarker: Node | null
}
```

### 6.3. Subscription Architecture

Three subscription sources, precisely targeted:

**Source 1: Structural changes** — `listRef[CHANGEFEED].subscribe` (node-level, fires on SequenceChange)

When items are inserted:

1. Get new item ref via `listRef.at(i)`
1. Evaluate predicate — does it pass?
1. If yes: compute view index, emit insert into view
1. Call `itemDeps(itemRef)` to get leaf refs
1. Subscribe to each leaf ref — on change, re-evaluate predicate for this item only
1. Update index maps and per-item unsub arrays
1. Shift all indices after the insertion point

When items are deleted:

1. Unsubscribe all per-item subscriptions for this item
1. If item was in view: compute view index, emit delete
1. Update index maps, shift indices after deletion point

**Source 2: Per-item field changes** — targeted `subscribe` on exactly the leaf refs that matter

For each source item `i`, the runtime subscribes to the refs returned by `itemDeps(listRef.at(i))`. For example, if the predicate uses `recipe.name()` and `recipe.vegetarian()`, the runtime subscribes to `recipe.name[CHANGEFEED].subscribe` and `recipe.vegetarian[CHANGEFEED].subscribe`. NOT `subscribeTree`. NOT the whole item. Just the exact leaves.

When any item-dep fires for source item `i`:

1. Re-evaluate predicate for item `i`
1. Compare with `sourceInView[i]`:
   - pass→pass: no-op (the item's own inner subscriptions handle content updates)
   - fail→fail: no-op
   - pass→fail: compute view index, emit delete, update maps
   - fail→pass: compute insertion point, emit insert, update maps
1. This is O(1) per change

**Source 3: External dep changes** — one `subscribe` per external ref

When any external dep fires (e.g. `filterText.set("new value")`):

1. Snapshot current `sourceInView`
1. Re-evaluate predicate for ALL source items
1. Diff old vs new `sourceInView` arrays
1. Emit batch SequenceChange (retain/insert/delete) representing the diff
1. Manage per-item subscriptions: establish for newly-visible items, tear down for newly-hidden items
1. This is O(n) — but only fires when the external dep changes, not on every collection delta

### 6.4. Why Not subscribeTree

`ComposedChangefeed.subscribeTree` on a sequence ref subscribes to ALL descendant changes — every field of every item. For a list of 100 recipes with 5 fields each, that's 500 subscriptions. Every keystroke in any recipe name, every ingredient edit, every vegetarian toggle fires through the tree subscriber.

The filteredListRegion's predicate may only depend on 2 of those 5 fields. Using `subscribeTree` would process 3x more notifications than necessary, each one requiring a path-match check to determine relevance.

Worse: `subscribeTree`'s `handleStructuralChange` tears down ALL per-item subscriptions and rebuilds them on every structural change (see `with-changefeed.ts` L506-524). For a 100-item list, that's 500 unsubscribes + 500 re-subscribes on every add/remove.

The compiler knows at compile time which fields the predicate touches. The runtime subscribes to exactly those fields. This is the advantage of a compiler over a runtime-only approach: **the subscription set is determined by static analysis, not by runtime observation.**

## 7. Package Architecture

### 7.1. The Three Layers

```
┌──────────────────────────────────────────┐
│  @kyneta/web (or @kyneta/dom)            │
│  Template cloning, DOM regions,          │
│  hydration, SSR codegen                  │
│  Consumes: compiler IR → DOM code        │
├──────────────────────────────────────────┤
│  @kyneta/compiler                        │
│  AST analysis, BindingScope,             │
│  operation decomposition,                │
│  DBSP classification, IR transforms      │
│  Consumes: TypeScript → incremental IR   │
├──────────────────────────────────────────┤
│  @kyneta/schema                          │
│  Changefeed protocol, change types,      │
│  step(), interpreters, substrates        │
│  Provides: structured delta-emitting     │
│  state                                   │
└──────────────────────────────────────────┘
```

**@kyneta/schema** owns the delta algebra — what structured state looks like and how it changes. Change types, the Changefeed protocol, `step()` for pure state transitions, interpreters for different capabilities (readable, writable, changefeed).

**@kyneta/compiler** owns the incremental view maintenance — taking programs over structured state and producing optimal incremental circuits. It knows about DBSP, binding-time analysis, dependency classification, operation decomposition. It does NOT know about DOM. Its output is an IR annotated with incremental strategies.

**@kyneta/web** owns the rendering — consuming the compiler's IR and producing target-specific code. DOM codegen (template cloning, regions, scope management), HTML codegen (SSR accumulators), hydration. This is one rendering backend among potentially many.

### 7.2. What Moves Where

From `@kyneta/cast` to `@kyneta/compiler`:

- `analyze.ts` — AST analysis
- `reactive-detection.ts` — Changefeed type detection
- `ir.ts` — IR type definitions and transforms
- `walk.ts` — template extraction
- `template.ts` — template analysis

From `@kyneta/cast` to `@kyneta/web`:

- `codegen/dom.ts` — DOM code generation
- `codegen/html.ts` — HTML/SSR code generation
- `runtime/regions.ts` — list, conditional, text, value regions
- `runtime/subscribe.ts` — subscription management
- `runtime/scope.ts` — scope lifecycle
- `runtime/mount.ts` — mount/hydrate entry points
- `runtime/hydrate.ts` — SSR hydration

Stays in `@kyneta/schema`:

- Everything. Schema is unchanged.

### 7.3. Migration Path

This restructuring doesn't need to happen all at once. The path:

1. **BindingNode + scope tracking** can be added to the existing `@kyneta/cast` compiler. This is the highest-value, lowest-risk change.

1. **Filter pattern recognition** can be added as a new Stage 3 in the existing transform pipeline.

1. **filteredListRegion** can be added to the existing runtime alongside `listRegion` and `conditionalRegion`.

1. **Package split** happens when the compiler reaches a complexity where the DOM-independence is worth making structural. The compiler's IR should be target-agnostic before the split.

## 8. Design Principles

### 8.1. The Developer Writes Natural TypeScript

The builder body sublanguage looks like TypeScript. The developer uses `for...of`, `if`/`else`, `const` bindings, template literals, function calls. They don't need to learn a new reactive primitive for every use case. The compiler handles the translation.

### 8.2. Errors Are Instructive

When the compiler encounters a construct it can't incrementalize, the error message explains:

- What the construct is
- Why it can't be incrementalized
- What the developer should do instead

Example: "Mutable binding `let count = 0` in builder body at line 42. Builder bodies require `const` bindings for dependency tracking. If you need mutable state, use `state(0)` to create a reactive ref."

### 8.3. The Common Case Is Silent

Filter, per-item conditional, chained conditions, derived bindings — these are recognized automatically. The developer doesn't import anything, doesn't call any combinator, doesn't think about subscriptions. They write a `for...of` loop with an `if`, and the compiler produces optimal incremental code.

### 8.4. Explicit Building Blocks for Semantic Boundaries

`window()`, `sort()`, `groupBy()` — these exist because they have fundamentally different performance characteristics. The developer should know they're opting into a different trade-off. These are not compiler failures; they're **semantic boundaries** where intent can't be inferred from syntax.

The set of explicit building blocks should be small (perhaps 3-5) and each should feel natural to a TypeScript developer. They are the "known unknowns" — the places where the compiler tells the developer "I need more information to choose the right strategy."

### 8.5. Composition Over Enumeration

The primitive operations compose. `filter` + `count` produces an incrementally-maintained count of filtered items. `filter` + per-item conditional works without special-casing. `slice` of a `filter` produces a windowed subset. The algebra is closed under composition.

This means we don't need a `filteredSortedGroupedWindowedListRegion`. We need filter, slice, sort, groupBy, and the composition rules. Each operation transforms one Changefeed into another. Downstream operations consume the output Changefeed without knowing (or caring) what upstream operations produced it.

### 8.6. Correctness First, Performance Second

Every operation in the algebra has a correct fallback: re-evaluate and replace. `valueRegion` is the terminal object — it works for any expression by re-reading on change. The compiler's optimizations (textRegion, listRegion, filteredListRegion) are refinements that preserve correctness while improving performance.

If the compiler can't prove that an optimization is safe, it falls back. The developer always gets correct behavior. Performance refinements are added over time as the compiler's analysis improves.

## 9. Relationship to Prior Art

### 9.1. DBSP (Budiu et al.)

The primary theoretical foundation. Kyneta uses DBSP's:

- Chain rule for compositional incrementalization
- Linear/bilinear classification for cost analysis
- Integration/differentiation framework for relating states and deltas

Kyneta specializes DBSP from Z-sets (bags) to ordered sequences (lists), which adds index management but doesn't invalidate the algebraic properties.

### 9.2. Incremental λ-Calculus (Cai, Giarrusso, et al.)

Provides the type-theoretic view: derivatives of functions, change types as a type-level concept. Kyneta's `deltaKind` is a concrete realization of change types.

### 9.3. Differential Dataflow (McSherry, Abadi)

DBSP simplifies DD. DD's "arrangements" (indexed representations) are relevant for join optimization. Not needed initially but relevant for the cross-list join case (filtering by favorites).

### 9.4. Adapton / Self-Adjusting Computation (Acar et al.)

Runtime fine-grained dependency tracking with memoization. Kyneta's approach is compile-time rather than runtime — the subscription set is determined by static analysis, not by runtime observation. This gives better performance (no tracking overhead) at the cost of less flexibility (can't handle truly dynamic dependency patterns).

### 9.5. React / Signals / Fine-Grained Reactivity (Solid, Vue, Svelte)

These frameworks use replace semantics — re-evaluate and diff. They don't propagate structured deltas. Kyneta's innovation is that the compiler understands the *structure* of changes (text ops, sequence ops, replace) and emits code that exploits that structure for surgical updates.

## 10. Open Questions

### 10.1. Where Do Explicit Building Blocks Live?

`window()`, `sort()`, `groupBy()` need to be importable. Do they live in `@kyneta/compiler` (as compiler-recognized primitives), in `@kyneta/web` (as runtime helpers), or in a separate `@kyneta/reactive` package?

The compiler needs to recognize them (to emit the right codegen), but the runtime needs to execute them. This suggests a split: type-level declarations in the compiler, runtime implementations in the web package.

### 10.2. Aggregation Output as Changefeed

Aggregations like `count(filteredList)` need to produce a Changefeed so they compose with `conditionalRegion` and `valueRegion`. Where is this Changefeed created? It's not backed by a substrate — it's a derived value maintained by the filtered list region.

This suggests that `filteredListRegion` (and other composite regions) may need to produce **side-channel Changefeeds** in addition to DOM. This is a new capability not in the current runtime.

### 10.3. How Deep Does Binding Analysis Go?

BindingNode handles `const x = expr`. But what about:

```typescript
const { name, vegetarian } = recipe  // destructuring
const items = [...doc.recipes]       // spread into array
const first = doc.recipes.at(0)      // navigation
```

Each of these creates bindings with different reactive semantics. Destructuring preserves reactivity (the fields are still refs). Spread loses it (produces a plain array). Navigation preserves it (`.at()` returns a ref). The compiler needs to handle these correctly or reject them with clear errors.

### 10.4. Component Boundary: Props vs. Refs

The current design passes refs across component boundaries for reactivity: `Toolbar({ filterText })` passes the `LocalRef` itself. Should the compiler eventually support reactive props — where `IngredientItem({ value: ingredient() })` works because the compiler wraps the component invocation in a reactive re-instantiation?

This is the React model (re-render on prop change). It's correct but expensive. The "pass the ref" model is more efficient but requires the developer to understand the distinction. Worth further analysis.

### 10.5. Error Recovery and Gradual Adoption

If a developer has a large existing codebase with `StatementNode`-style code in builder bodies, switching to strict mode would produce many errors at once. Should there be a gradual adoption path — a "loose mode" that warns but doesn't error, allowing incremental migration?

### 10.6. Testing the Incremental Circuits

DBSP's functional core / imperative shell pattern suggests that the incremental circuits should be testable independently of the DOM. Given a source list and a sequence of changes, the planning functions should produce the correct view deltas. This is purely algebraic and should have comprehensive property-based tests.

## 11. Implementation Phases

### Phase 1: BindingNode and Scope Tracking

**Goal:** Variable declarations in builder bodies are analyzed, not opaque. Reactive dependencies are tracked through bindings.

**Deliverables:**

- `BindingNode` IR type
- `BindingScope` maintained during analysis
- `expressionIsReactive` and `extractDependencies` consult the binding scope for identifier lookups
- `StatementNode` only used for true side-effects, not variable decls
- Tests: filter condition with reactive deps through bindings is correctly classified as reactive

**Impact:** The recipe-book's `if (nameMatch && veggieMatch)` becomes a reactive conditional. Each recipe card gets its own `conditionalRegion` subscribing to `filterText` and `veggieOnly`. This is the "render all, toggle visibility" solution — O(n) DOM nodes but each with a cheap conditional. Correct behavior with no new runtime.

### Phase 2: Filter Pattern Recognition

**Goal:** The compiler recognizes `for...of + if-no-else` as a filter and classifies dependencies as item-dependent vs. external.

**Deliverables:**

- Stage 3 analysis: detect filter pattern in loop bodies
- Dependency classification (item-dependent, external, structural)
- Extended `LoopNode` with `filter` metadata
- Tests: various filter patterns correctly decomposed

**Impact:** The compiler knows that the recipe-book's loop is a filter with `itemDeps: [recipe.name, recipe.vegetarian]` and `externalDeps: [filterText, veggieOnly]`. Codegen doesn't change yet (still emits listRegion + conditionalRegion) but the IR carries the information needed for Phase 3.

### Phase 3: filteredListRegion Runtime

**Goal:** A new runtime region that subscribes precisely to the refs the filter predicate depends on.

**Deliverables:**

- `filteredListRegion` runtime implementation
- Index mapping (viewToSource, sourceToView, sourceInView)
- Per-item subscription management
- External dep subscription with batch re-filter
- Codegen emits `filteredListRegion` when filter metadata is present
- Tests: unit tests for planning functions, integration tests for DOM behavior

**Impact:** The recipe-book's filter works correctly and efficiently. Typing in the search box re-filters all recipes (O(n)). Adding a recipe evaluates the predicate for the new recipe only (O(1)). Editing a recipe name re-evaluates the predicate for that recipe only (O(1)). The subscription set is minimal — no wasted notifications.

### Phase 4: Builder Body Strictness

**Goal:** Unrecognized constructs in builder bodies produce compile errors instead of opaque `StatementNode` fallbacks.

**Deliverables:**

- Error messages for unsupported constructs
- `SideEffectNode` for allowed non-reactive statements
- Documentation of the builder body sublanguage
- Migration guide for existing code

**Impact:** The developer gets a clear contract: everything in a builder body is understood by the compiler. No silent fallbacks. No "it looks like it should work but doesn't" surprises.

### Phase 5: Aggregations and Composition

**Goal:** `count()`, `isEmpty()`, `some()`, `every()` produce Changefeeds that compose with the existing reactive system.

**Deliverables:**

- Aggregation primitives producing Changefeeds
- Integration with `filteredListRegion` (side-channel outputs)
- Compiler recognition of aggregation patterns
- Empty-state detection via `isEmpty()`

### Future Phases

- Slice optimization for contiguous-range filters
- `window()` for virtualization
- `sort()` with permutation-diff codegen
- `groupBy()` with nested collection management
- Package split: `@kyneta/compiler` + `@kyneta/web`
