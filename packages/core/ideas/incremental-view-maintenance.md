# Incremental View Maintenance for Kinetic

## Overview

This document explores how **incremental view maintenance** — a well-studied technique from database systems — could be applied to Kinetic's reactive rendering. The goal is to derive surgical DOM updates from CRDT deltas by understanding the **semantics** of expressions, not just their dependencies.

## The Current Model

Today, Kinetic tracks reactive dependencies and re-evaluates expressions when they change:

```typescript
p(title.get().toUpperCase())
```

When `title` changes:
1. Re-evaluate `title.get().toUpperCase()`
2. Replace `textNode.textContent` with the new value

This is O(n) where n is the length of the result, regardless of how small the actual change was.

## The Opportunity

Loro CRDTs emit **structured deltas** describing exactly what changed:
- Text: `{ retain: 5, insert: "X", retain: 10 }` — "X" inserted at position 5
- List: `{ retain: 3, delete: 1, insert: 2 }` — item at index 3 deleted, 2 items inserted
- Map: `{ keys: ["name", "age"] }` — these keys changed

If the compiler understands the **semantics** of the expression, it can propagate these deltas through the computation to derive minimal DOM updates.

## Semantic Primitives

Instead of treating expressions as opaque strings, define a library of **semantic primitives** with known delta propagation rules:

### String Operations

```typescript
// Concatenation — each part contributes a segment
concat(...parts: Reactive<string>[]): SemanticExpr<string>

// Template literals — interpolations are segments
template`Hello, ${name}!`: SemanticExpr<string>

// Join — list elements become segments with separators
join(list: ListRef<string>, separator: string): SemanticExpr<string>
```

### List Operations

```typescript
// Map — list deltas become mapped-value deltas
map<T, U>(list: ListRef<T>, fn: (item: T) => U): SemanticExpr<U[]>

// Filter — requires virtual index mapping
filter<T>(list: ListRef<T>, predicate: (item: T) => boolean): SemanticExpr<T[]>

// Slice — offset adjustment for deltas
slice<T>(list: ListRef<T>, start: number, end?: number): SemanticExpr<T[]>
```

### Aggregations (Collapse to Replace)

Some operations don't have incremental strategies — they collapse to "replace" semantics:

```typescript
reduce<T, U>(list: ListRef<T>, fn: (acc: U, item: T) => U, initial: U): SemanticExpr<U>
length(list: ListRef<T>): SemanticExpr<number>
sum(list: ListRef<number>): SemanticExpr<number>
```

## Delta Propagation Rules

Each semantic primitive has rules for how source deltas map to output deltas.

### Join Example

```typescript
join(list, ", ")
// list = ["a", "b", "c"] → "a, b, c"
```

**Source delta**: `{ retain: 1, insert: 1 }` (item inserted at index 1)

**Propagation**:
1. Compute character offset for index 1: `len("a") + len(", ") = 3`
2. New item value: `list.get(1)` → "X"
3. Output text delta: `{ retain: 3, insert: ", X" }`

**DOM update**: `textNode.insertData(3, ", X")`

### Template Literal Example

```typescript
template`Hello, ${name}!`
// name = "Alice" → "Hello, Alice!"
```

**Source delta**: `name` changed from "Alice" to "Bob"

**Propagation**:
1. Segment 0: "Hello, " (static, offset 0, length 7)
2. Segment 1: name (reactive, offset 7, length varies)
3. Segment 2: "!" (static)

**DOM update**: 
```typescript
textNode.deleteData(7, 5)    // Remove "Alice"
textNode.insertData(7, "Bob") // Insert "Bob"
```

### Composed Example

```typescript
join(map(items, item => item.name), " • ")
```

**Source delta**: `items[2].name` changed from "X" to "XYZ"

**Propagation through `map`**:
- `items` delta: none (structure unchanged)
- `items[2].name` delta: text replacement

**Propagation through `join`**:
1. Compute character offset for mapped item 2
2. Old segment: "X", new segment: "XYZ"
3. Output: delete 1 char, insert 3 chars at computed offset

## Compiler Architecture

### Expression Tree Analysis

Instead of just extracting dependencies, build a **semantic expression tree**:

```typescript
type SemanticNode =
  | { kind: "literal"; value: unknown }
  | { kind: "ref"; source: string; deltaKind: DeltaKind }
  | { kind: "get"; receiver: SemanticNode }
  | { kind: "call"; fn: SemanticPrimitive; args: SemanticNode[] }
  | { kind: "template"; parts: SemanticNode[] }
  | { kind: "unknown"; source: string; deps: Dependency[] }  // Fallback
```

### Pattern Catalog

A registry of recognized patterns with their rendering strategies:

```typescript
interface Pattern {
  match: (node: SemanticNode) => boolean
  strategy: RenderStrategy
  emit: (node: SemanticNode, state: CodegenState) => string[]
}

const patterns: Pattern[] = [
  // Direct text read
  {
    match: (n) => n.kind === "get" && n.receiver.deltaKind === "text",
    strategy: "text-patch",
    emit: (n, s) => [`__textRegion(${s.textVar}, ${n.receiver.source}, ${s.scope})`]
  },
  
  // Join over list
  {
    match: (n) => n.kind === "call" && n.fn === "join" && n.args[0].deltaKind === "list",
    strategy: "join-region",
    emit: (n, s) => [`__joinRegion(${s.textVar}, ${n.args[0].source}, ${n.args[1].value}, ${s.scope})`]
  },
  
  // Template literal
  {
    match: (n) => n.kind === "template",
    strategy: "template-region",
    emit: (n, s) => [`__templateRegion(${s.textVar}, [${n.parts.map(emitPart).join(", ")}], ${s.scope})`]
  },
  
  // Fallback: re-evaluate and replace
  {
    match: () => true,
    strategy: "replace",
    emit: (n, s) => [`__subscribeWithValue(${deps}, () => ${n.source}, v => ${s.textVar}.textContent = v, ${s.scope})`]
  }
]
```

### Runtime Helpers

Each strategy has a corresponding runtime helper:

```typescript
// Direct text patching
function __textRegion(textNode: Text, ref: TextRef, scope: Scope): void {
  textNode.textContent = ref.get()
  __subscribe(ref, (delta) => {
    if (delta.type === "text") {
      __patchText(textNode, delta.ops)
    } else {
      textNode.textContent = ref.get()
    }
  }, scope)
}

// Join with index→offset tracking
function __joinRegion(textNode: Text, list: ListRef<string>, sep: string, scope: Scope): void {
  // Maintain offset table: index → character offset
  const offsets: number[] = []
  
  function rebuild() {
    const items = [...list]
    let offset = 0
    offsets.length = 0
    for (let i = 0; i < items.length; i++) {
      offsets.push(offset)
      offset += items[i].length + (i < items.length - 1 ? sep.length : 0)
    }
    textNode.textContent = items.join(sep)
  }
  
  rebuild()
  
  __subscribe(list, (delta) => {
    if (delta.type === "list") {
      // Apply surgical updates based on list delta and offset table
      applyJoinDelta(textNode, list, sep, offsets, delta.ops)
    } else {
      rebuild()
    }
  }, scope)
}

// Template literal with segment tracking
function __templateRegion(textNode: Text, segments: Segment[], scope: Scope): void {
  // Each segment: { value: string | Reactive, offset: number, length: number }
  // Subscribe to reactive segments, update offsets on change
}
```

## The Algebra

This forms an **algebra of incremental computations**:

1. **Identity**: Direct reads propagate deltas unchanged
2. **Composition**: `f(g(x))` composes delta propagation rules
3. **Product**: Multiple inputs (concat, template) track segment boundaries
4. **Collapse**: Some operations (reduce, length) have no incremental form

The compiler's job is to:
1. Parse the expression into a semantic tree
2. Walk the tree, composing delta propagation rules
3. Emit the most specific runtime helper that applies
4. Fall back to replace semantics when no incremental strategy exists

## Relationship to Prior Art

### Incremental View Maintenance (Databases)
- Materialized views update incrementally when base tables change
- Delta rules: `Δ(A ⋈ B) = (ΔA ⋈ B) ∪ (A ⋈ ΔB)`
- We're applying the same principle to UI rendering

### Differential Dataflow (Materialize, Naiad)
- Propagates deltas through arbitrary dataflow graphs
- Supports iteration, aggregation, joins
- More general than what we need, but same conceptual foundation

### Incremental Computation (Adapton, Salsa)
- Fine-grained dependency tracking
- Memoization with automatic invalidation
- Runtime approach vs. our compile-time approach

### Virtual DOM (React, Vue)
- Crude form of incrementality at DOM level
- Diff the output, not the computation
- Our approach: diff the input (CRDT deltas), derive output changes

## Implementation Phases

### Phase 0: Foundation
- Unify `.get()` for scalar reactive types
- Direct text patching for `textRef.get()`
- Multi-dependency subscriptions

### Phase 1: Template Literals
- Parse template literals into segment structure
- Implement `__templateRegion` runtime
- Track segment offsets, patch on change

### Phase 2: Join
- Introduce `join(list, sep)` semantic primitive
- Implement `__joinRegion` with offset table
- Handle list deltas → text splices

### Phase 3: Generalize
- Build semantic expression tree analyzer
- Implement pattern catalog
- Make it extensible for custom primitives

### Phase 4: Composition
- Delta propagation through `map`, `filter`
- Nested region strategies
- Optimization: fuse adjacent regions

## Open Questions

1. **How deep should analysis go?** Analyzing `item.name.get().trim()` requires understanding that `trim()` doesn't change string length proportionally to input.

2. **Custom primitives?** Should users be able to define their own semantic primitives with delta rules?

3. **Debugging?** How do we help users understand why an expression fell back to replace semantics?

4. **Performance tradeoff?** Maintaining offset tables has overhead. At what data size does surgical patching win over replace?

5. **Server rendering?** These optimizations only matter for client-side updates. How do we ensure the same code works for SSR?

## Conclusion

Incremental view maintenance offers a path to **optimal reactive rendering** — updates proportional to the change size, not the data size. By understanding expression semantics at compile time, Kinetic can emit specialized runtime code that propagates CRDT deltas through computations to derive minimal DOM mutations.

This is the logical endpoint of delta-driven reactivity: not just knowing *that* something changed, but understanding *how* it changed and *what that means* for the rendered output.