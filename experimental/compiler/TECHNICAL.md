# @kyneta/compiler — Technical Reference

> **Package**: `@kyneta/compiler`
> **Role**: Target-agnostic incremental-view-maintenance compiler. Parses TypeScript source that uses builder patterns over `[CHANGEFEED]`-emitting state, and produces a **classified IR** annotated with per-subscription incremental strategies. Produces no code. Rendering targets (`@kyneta/cast`, and others) consume the IR and emit target-specific output.
> **Depends on**: `@kyneta/schema`, `@kyneta/changefeed`, `ts-morph`
> **Depended on by**: `@kyneta/cast` (web rendering target), any future rendering target (native, terminal, …)
> **Canonical symbols**: `parseSource`, `findBuilderCalls`, `analyze`, `analyzeBuilder`, `IRNode`, `IRNodeKind`, `BuilderNode`, `ElementNode`, `ContentNode`, `LoopNode`, `ConditionalNode`, `BindingNode`, `StatementNode`, `LabeledBlockNode`, `TemplateNode`, `TemplateHole`, `ExpressionIR`, `BindingRefNode`, `CallNode`, `MethodCallNode`, `BinaryNode`, `LiteralNode`, `IdentifierNode`, `DeltaKind`, `BindingTime`, `classifyDependencies`, `ClassifiedDependency`, `DependencyClassification`, `extractTemplate`, `planWalk`, `walk`, `walkEvents`, `WalkEvent`, `dissolveConditionals`, `filterTargetBlocks`, `mergeSiblings`, `BindingScope`, `FilterMetadata`, `detectFilter`, `isDOMProducing`, `escapeHtml`, `VOID_ELEMENTS`
> **Key invariant(s)**:
> 1. **The compiler produces IR, not code.** No template-literal output, no DOM calls, no HTML strings appear in the compiler's output. Targets transform IR into code separately.
> 2. **The IR is serializable and pure-data.** Every node is a plain object; no methods, no closures. `JSON.stringify` round-trips.
> 3. **Classification is sound, not minimal.** Dependencies classified as `item` really do depend on the loop variable; dependencies classified as `external` really are shared across iterations. The classification can err toward `external` (over-conservative — forces shared subscription where per-item would suffice) but never toward `item` (which would be unsound — a missed external update).

A compiler for *reactivity*, not rendering. Takes a builder call like `app(doc => html.div(...))` and produces an IR tree that describes the document's structure, its reactive dependencies, and the incremental strategy each subscription should use (replace, list-splice, per-item, shared-external, etc.). That IR is then consumed by a rendering target — currently only `@kyneta/cast` (web DOM + SSR HTML) — which generates code.

Not imported by application code at runtime. Consumed at build time by `@kyneta/cast/unplugin` and similar target plugins.

---

## Questions this document answers

- Why is this called a "compiler" when it produces IR, not code? → [The IR-as-boundary](#the-ir-as-boundary)
- What does the IR look like and what are the node kinds? → [The IR tree](#the-ir-tree)
- How does the compiler detect reactive references? → [Reactive detection via `[CHANGEFEED]`](#reactive-detection-via-changefeed)
- What is `BindingTime` and why does it have three values? → [Binding time — literal, render, reactive](#binding-time--literal-render-reactive)
- What does `classifyDependencies` do inside a loop? → [Classification — item vs external vs structural](#classification--item-vs-external-vs-structural)
- How does template extraction work? → [Templates and holes](#templates-and-holes)
- What do the IR-to-IR transforms do, and why are they a separate step? → [IR→IR transforms](#iriir-transforms)
- Why is the walker a generator? → [The generator-based walker](#the-generator-based-walker)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| IR (Intermediate Representation) | A classified, serializable tree of plain-data nodes describing the document's structure, dependencies, and incremental strategies. The compiler's output. | LLVM IR, SSA IR — this is an annotated AST for view maintenance, not a general-purpose program representation |
| `IRNode` | Discriminated union of all node kinds: `BuilderNode`, `ElementNode`, `ContentNode`, `LoopNode`, `ConditionalNode`, `BindingNode`, `StatementNode`, `LabeledBlockNode`. | An AST node — IR nodes are *derived* from AST nodes with classification added |
| `ExpressionIR` | Expression-level IR nested inside `ContentNode`, attributes, event handlers, etc. Captures literal / identifier / call / method-call / binary / binding-ref. | `ExpressionStatement` from TypeScript AST |
| `BindingTime` | `"literal" \| "render" \| "reactive"` — when a value becomes known. | Build-time vs runtime — this is an application-level distinction |
| `DeltaKind` | The incremental strategy for a subscription: `"replace"`, `"splice"`, `"ignore"`, etc. | A specific change type from `@kyneta/schema` |
| `Dependency` | A reactive source a node reads from — typically a path into the doc (`"recipe.name"`) or a local binding (`"filterText"`). | A build-time import |
| `ClassifiedDependency` | A `Dependency` plus its classification within a loop: `item`, `external`, or `structural`. | A raw dependency — classification is per-context |
| `BuilderNode` | The root of a compiled unit. The entry `app(...)` / `html.div(...)` call returns one. | A builder pattern in TypeScript |
| `ElementNode` | An HTML/DOM-shaped node (`html.div`, `html.input`) with attributes, event handlers, and children. | A DOM element — this is the IR form, not a runtime handle |
| `ContentNode` | A text or interpolation node. Holds an `ExpressionIR` for the content. | Text in source — this is the parsed form |
| `LoopNode` | A `.forEach` / `for` over a reactive collection. Carries loop-variable name, iterable source, classified dependencies. | A JS `for` loop — this is one particular pattern the compiler recognises |
| `ConditionalNode` | An `if` / `?:` / `&&` pattern that produces/omits subtrees. Carries branches. | A TypeScript `ConditionalExpression` |
| `BindingNode` | A `const x = ...` whose value is used reactively. Carries the expression and the dependencies the binding itself has. | A `let` — bindings are captured when they flow into reactive positions |
| `LabeledBlockNode` | `target: { ... }` syntax used to scope IR to a specific target (e.g., `dom: { ... }` vs `ssr: { ... }`). | A JS labeled statement in control flow |
| `StatementNode` | Non-rendering statements (assignments, side effects) captured for completeness. | Dead code — the walker may emit or skip depending on the target |
| `TemplateNode` | A normalised structural skeleton extracted from a builder tree, with dynamic subtrees replaced by `TemplateHole` markers. | An HTML template — this is the IR-level concept |
| `TemplateHole` | A marker in a template where a dynamic subtree will be filled in: content hole, loop hole, conditional hole. | A source-code template literal |
| `SlotKind` | Classification of a template hole: `"content"`, `"loop"`, `"conditional"`. | `DeltaKind` |
| `FilterMetadata` | Detected filter pattern on a loop (e.g., `.forEach(item => if (!item.done) ...)`) — captured so a target can compile a filtered-list region. | A SQL filter |
| `BindingScope` | The mapping from identifiers visible at a node to their resolving `BindingNode`s and dependencies. | A JavaScript lexical scope — this is the dependency-tracked analog |
| `MergeResult` | Outcome of `mergeSiblings`: either a merged node or a `MergeFailureReason`. | A merge conflict |
| `WalkEvent` | One of the discriminated events yielded by `walk(ir)`: element-open, element-close, content, loop-open, loop-close, etc. | A DOM event |
| `BuilderPattern` | A TypeScript expression shape the analyzer recognises as the entry point for IR production — `app(...)`, `html.tag(...)`, `tag(...)`. | A design pattern in the GoF sense |
| `extractDependencies` | Pure function that walks an `ExpressionIR` and returns the `Dependency[]` that actually drive reactive subscriptions — transitively resolving bindings. | A reference-detection pass on the TypeScript AST |

---

## Architecture

**Thesis**: compile the *reactivity*, not the rendering. The compiler reads builder-pattern TypeScript, figures out what is reactive and how, and produces an IR that rendering targets consume. Targets do code generation; the compiler does classification and structure.

```
TypeScript source
      │
      ▼
┌────────────────────┐
│   project.ts       │  Parse source. Regex pre-scan for `app(` /
│ parseSource        │  `html.` / `tag(` invocations, then ts-morph
│ findBuilderCalls   │  for precise AST access.
└─────────┬──────────┘
          │ Program, builder-call locations
          ▼
┌────────────────────┐
│   analyze.ts       │  AST → IR. Walks each builder call,
│ analyze            │  produces `BuilderNode` trees with
│ analyzeBuilder     │  `ElementNode` / `ContentNode` / etc.
└─────────┬──────────┘
          │ Unclassified IR
          ▼
┌────────────────────┐
│ reactive-detection │  For every expression that reads from a ref,
│ binding-analysis   │  compute `BindingTime`, `Dependency[]`,
│ binding-scope      │  `DeltaKind`. Bindings resolve transitively.
└─────────┬──────────┘
          │ Classified IR
          ▼
┌────────────────────┐
│ classify.ts        │  Within each loop, mark each dependency as
│ patterns.ts        │  item / external / structural. Detect filter
│                    │  patterns.
└─────────┬──────────┘
          │ Final IR (ready for consumption)
          ▼
┌────────────────────┐
│ transforms.ts      │  Optional IR → IR passes: dissolveConditionals,
│                    │  filterTargetBlocks, mergeSiblings.
└─────────┬──────────┘
          │
          ▼
      Target (cast, native, …)
```

The five sub-systems correspond roughly to source files:

| Concern | Primary source |
|---------|----------------|
| Parsing + builder-call discovery | `src/project.ts`, `src/analyze.ts` |
| IR types | `src/ir.ts`, `src/expression-ir.ts` |
| Expression-IR construction | `src/expression-build.ts` |
| Reactive detection & classification | `src/reactive-detection.ts`, `src/binding-scope.ts`, `src/classify.ts`, `src/patterns.ts` |
| Templates, walking, transforms | `src/template.ts`, `src/walk.ts`, `src/transforms.ts` |

### What this package is NOT

- **Not a JS-to-JS transpiler.** No Babel-style transform of arbitrary code. It *recognises* one specific shape — builder calls returning reactive structure — and classifies it.
- **Not a bundler.** It doesn't resolve imports, bundle modules, or handle assets. A host build plugin (e.g. `@kyneta/cast/unplugin`) drives ts-morph over the source files and forwards the IR to the target's codegen.
- **Not a renderer.** It produces no HTML, no DOM code, no runtime anything. Targets do that.
- **Not tied to `@kyneta/cast`.** Cast is currently the only target, but the IR carries no cast-specific vocabulary. A native UI target consuming the same IR is architecturally supported.
- **Not a type-checker.** It uses ts-morph for precise AST access but does not surface type errors. Host build tooling runs `tsc` separately.

---

## The IR-as-boundary

The design decision that drives everything: **the boundary between the compiler and the target is a serializable data structure, not a function call with target-specific parameters**.

Concretely:
- The compiler emits IR.
- A target imports the IR types and walks them to produce code.
- Two targets (say, web DOM and native) consume the same IR and produce different code.
- The IR can be serialised (for snapshot testing, cross-process handoff, tooling) and rehydrated intact.

This decouples the classification algorithms (what's reactive, what's per-item, what's shared) from the codegen algorithms (how to produce DOM mutation code, HTML strings, native view trees). A change to either side ideally doesn't touch the other.

### What the IR is NOT

- **Not a TypeScript AST.** It's produced from one, but has its own node kinds and semantics. Source spans are carried for error reporting; types are not.
- **Not an HTML template AST.** Elements have `kind: "element"` and a `tag` field, but there are also `ContentNode`, `LoopNode`, `ConditionalNode`, `BindingNode`, `StatementNode`, `LabeledBlockNode` — none of which have HTML equivalents.
- **Not executable.** It describes what should happen reactively; it cannot be "run" without a target.

---

## The IR tree

Source: `src/ir.ts`.

### Top-level node kinds

| `kind` | Shape | Role |
|--------|-------|------|
| `"builder"` | `{ children: ChildNode[], … }` | Root of a compiled unit. One per builder call. |
| `"element"` | `{ tag, attributes, eventHandlers, children, span }` | An HTML-shaped node. |
| `"content"` | `{ value: ContentValue, span }` | Text or interpolation. `ContentValue` is literal string or `ExpressionIR`. |
| `"loop"` | `{ iterable: Dependency, loopVariable, body: ChildNode[], classifiedDependencies, filter?: FilterMetadata, span }` | A `.forEach` / `for..of` over a reactive collection. |
| `"conditional"` | `{ branches: ConditionalBranch[], span }` | An `if` / `?:` / `&&` producing zero or more subtrees conditionally. |
| `"binding"` | `{ name, expression: ExpressionIR, dependencies, span }` | `const x = expr` whose `x` is read downstream. |
| `"statement"` | `{ statement, span }` | Non-rendering statement (assignment, side effect). |
| `"labeled-block"` | `{ label, body: ChildNode[], span }` | Target-scoped subtree (`dom: { ... }` / `ssr: { ... }`). |

Every node carries a `span: SourceSpan` for error reporting, diagnostics, and source maps downstream.

### `ContentNode.value` — `ContentValue`

Either a literal string (`"Hello"`) or an `ExpressionIR` (`{{ user.name }}`). The split lets targets skip classification for pure-literal content and emit a single static string at compile time.

### `ExpressionIR` — expression-level IR

Source: `src/expression-ir.ts`, `src/expression-build.ts`.

Every reactive-reading expression in the source is converted to `ExpressionIR`:

| `kind` | Example |
|--------|---------|
| `"literal"` | `42`, `"hello"`, `true`, `null` |
| `"identifier"` | `user` (resolves against `BindingScope`) |
| `"binding-ref"` | Direct reference to a scope-resolved binding (includes the binding's `Dependency[]`) |
| `"call"` | `fn(arg1, arg2)` |
| `"method-call"` | `obj.method(arg)` — discriminated from `call` for targets that compile method calls specially (e.g., `Array.prototype.map` → list construction) |
| `"binary"` | `a + b`, `a === b`, `a && b` |

`ExpressionIR` is closed. Arbitrary TypeScript constructs outside this set are rejected at classification time (the compiler produces a diagnostic and treats the content as `BindingTime: "render"` — computed once at render time, not reactively tracked).

### `BuilderNode` is the only IR root

Every IR tree handed to a target has `kind: "builder"` at the root. `ElementNode`, `ContentNode`, `LoopNode`, `ConditionalNode`, `BindingNode`, `StatementNode`, `LabeledBlockNode` only appear nested inside `BuilderNode.children` (or recursively inside `ElementNode.children`, `LoopNode.body`, `ConditionalBranch.body`, `LabeledBlockNode.body`).

### What IR nodes are NOT

- **Not live.** Classification fields (`dependencies`, `deltaKind`, `classifiedDependencies`) are pre-computed snapshots. Evaluating an IR node doesn't re-compute them.
- **Not parent-linked.** Nodes have children, not parents. Walkers track parents via their own call stack.
- **Not deduplicated.** Identical subtrees appear multiple times as distinct objects — the walker may choose to materialise templates for deduplication, but the raw IR doesn't.

---

## Reactive detection via `[CHANGEFEED]`

Source: `src/reactive-detection.ts`.

An expression is **reactive** if evaluating it reads from something that carries `[CHANGEFEED]`. The compiler doesn't evaluate anything — it uses ts-morph's type information to determine whether a symbol's resolved type has a `[CHANGEFEED]` property.

Concrete patterns:

- `doc.title` — a schema `Ref<S>`. Has `[CHANGEFEED]`. Reactive.
- `state(0)` — a cast `LocalRef<T>`. Has `[CHANGEFEED]`. Reactive.
- `doc.items.forEach(item => ...)` — the iteration is over a `Collection<V>` or a `SequenceRef`. The loop variable `item` is reactive per iteration.
- `filterText` (a plain `const filterText = state("")`) — resolved through `BindingScope`; its definition is reactive.

Non-reactive:
- `"hello"`, `42`, `true` — literals.
- `Math.floor(x)` — pure call over reactive input produces reactive output only if any argument is reactive.
- `props.user` — depends on whether `props` was declared reactive.

The detection is structural: the presence of `[CHANGEFEED]` on the type is the discriminant. There is no pattern list of "known reactive" APIs.

### What reactive detection is NOT

- **Not a taint analysis.** It doesn't track flow of reactive values through arbitrary computation. It tracks dependencies at the granularity of `Dependency` paths (`"doc.title"`, `"filterText"`), recognising common patterns (member access, method calls, operators) and stopping at opaque boundaries.
- **Not type inference.** It reads types already established by TypeScript; it doesn't infer them.
- **Not sound for arbitrary JS.** Higher-order escapes (`.then(cb)`, dynamic `[x]` access with runtime keys) fall back to `BindingTime: "render"` — the expression is treated as non-reactive and re-evaluated on every outer change.

---

## Binding time — literal, render, reactive

Source: `src/ir.ts` → `BindingTime`.

Every `ExpressionIR` has an attached `BindingTime`:

| `BindingTime` | Meaning | Target handling |
|---------------|---------|-----------------|
| `"literal"` | Value is known at compile time. E.g. `"hello"`, `42`. | Emit the literal directly. |
| `"render"` | Value is computed at mount time, from closures over `BindingScope`. Non-reactive — not tracked as a dependency. | Compute once during initial render. |
| `"reactive"` | Value depends on `[CHANGEFEED]`-carrying state. Updates when dependencies change. | Emit a subscription with the classified `DeltaKind`. |

The three-way split lets targets emit minimal code. A literal attribute never subscribes. A render-time expression is inlined. A reactive expression gets a subscribe + update block keyed by its `Dependency[]`.

### What `BindingTime` is NOT

- **Not the same as "run-time".** `"render"` is run-time but non-reactive. `"reactive"` is also run-time but with subscription.
- **Not a compiler toggle.** It's per-expression, determined structurally.

---

## Classification — item vs external vs structural

Source: `src/classify.ts`, `src/patterns.ts`.

Inside a `LoopNode`, every dependency of every descendant expression is one of:

| Classification | Meaning | Target strategy |
|----------------|---------|-----------------|
| `"structural"` | The iterable collection itself. | Handled by the loop's own subscription (add/remove items). |
| `"item"` | Navigates from the loop variable (e.g., `recipe.name` inside `recipes.forEach(recipe => ...)`). | Per-item subscription — one subscriber per iteration. |
| `"external"` | Reactive but not derived from the loop variable (e.g., `filterText` from outer scope). | Shared subscription — one subscriber for the whole loop. |

The classification drives an O(n) vs O(1) decision. Naïve implementations would re-subscribe to `filterText` once per item — O(n) subscribers for one logical subscription. Classification routes it to a single shared subscriber whose fire re-runs every item. Conversely, `recipe.name` is inherently per-item — one subscriber per loop iteration, with the same update logic.

### Algorithm

By the time classification runs, `extractDependencies` has already resolved bindings — transitive dependencies are flattened into leaf `Dependency` objects with string `source` paths. So classification is pure string-prefix matching:

1. `dep.source === iterableSource` → `"structural"`
2. `dep.source` starts with `loopVariable + "."` or equals `loopVariable` → `"item"`
3. Otherwise → `"external"`

### Soundness bias

The classification is sound but conservative. Any ambiguity resolves to `"external"` — forcing a shared subscription when per-item would have sufficed. This produces correct O(n) behaviour where O(1) was possible; the reverse mistake (misclassifying external as item) would miss updates and is unsound.

### Filter patterns

Source: `src/patterns.ts` → `detectFilter`.

The compiler recognises the filter-in-loop pattern:

```ts
recipes.forEach(recipe => {
  if (!matchesFilter(recipe, filterText)) return
  html.li(() => recipe.name)
})
```

This emits a `FilterMetadata` on the `LoopNode` so the target can compile a filtered-list region — only render items passing the predicate, maintain the filtered set incrementally as `filterText` or `recipe` fields change. Without detection, the target would render everything and hide excluded items, paying O(n) DOM cost for a potentially tiny visible set.

### What classification is NOT

- **Not a query optimizer.** It doesn't reorder, combine, or eliminate subscriptions. It labels them so the target can pick the right compilation strategy.
- **Not a constraint solver.** One-pass structural analysis, not iterative.
- **Not dependent on runtime data.** Static over the source text.

---

## Templates and holes

Source: `src/template.ts`.

A **template** is a normalised structural skeleton extracted from the IR, with dynamic subtrees replaced by holes. Two IR subtrees with the same structural skeleton can share a template — different dynamic content, same HTML/DOM shape.

```
<li class="item">
  {{ recipe.name }}    ← ContentHole (reactive)
  <span>
    {{ recipe.servings }}  ← ContentHole
  </span>
</li>
```

becomes:

```
TemplateNode {
  root: ElementNode("li", [], [
    ContentHole(id: 0),
    ElementNode("span", [], [ContentHole(id: 1)])
  ])
}
WalkPlan { holes: [{ id: 0, binding: "recipe.name" }, { id: 1, binding: "recipe.servings" }] }
```

### `SlotKind`

Each hole is classified:

| `SlotKind` | Fills with |
|------------|-----------|
| `"content"` | A reactive expression — subscribe, render, update on change. |
| `"loop"` | A sub-IR that iterates. Reopens classification at the nested level. |
| `"conditional"` | A sub-IR that may or may not be present. |

### `planWalk` — the template + hole plan

`planWalk(node)` walks an IR subtree once, extracting:
- The template (structural skeleton — no dynamic content)
- The hole list with each hole's `SlotKind`, location, and binding

Targets materialise the template as a compile-time string (for SSR) or DOM fragment (for DOM targets), then emit code to walk the holes at mount time and set up per-hole subscriptions.

### What templates are NOT

- **Not HTML templates** in the `<template>` tag sense. The IR-level `TemplateNode` is the concept; targets may or may not materialise it as a DOM `<template>`.
- **Not memoized.** Templates are re-extracted per compilation; deduplication is a target concern.
- **Not required.** A target that doesn't want templates can walk the IR directly and skip template extraction entirely.

---

## IR→IR transforms

Source: `src/transforms.ts`.

Pure, target-agnostic IR-to-IR passes exposed via `@kyneta/compiler/transforms` (an optional subpath export). Targets opt in to the transforms they want before walking.

| Transform | What it does | Why a target wants it |
|-----------|-------------|-----------------------|
| `dissolveConditionals` | Collapses structurally-identical conditional branches into ternaries. `if (x) html.span("a") else html.span("b")` → `html.span(x ? "a" : "b")` | Reduces the number of conditional regions the target must manage; ternaries are cheaper to update than full branch-swap. |
| `filterTargetBlocks` | Given a target label, strip all `LabeledBlockNode`s with non-matching labels and unwrap matching ones. | A `dom:` target removes `ssr:` blocks entirely and unwraps its own; the generated code is target-specific. |
| `mergeSiblings` | Combines adjacent static sibling elements into a single `TemplateNode` when possible. Returns `MergeFailureReason` when not. | Reduces the number of root-level mount points; static text runs emit as one string. |

### `BindingScope`

Source: `src/binding-scope.ts`.

A separate module (not a transform) that tracks identifier → binding resolution with dependency composition. Produced during analysis, consumed during expression construction and classification. Making `BindingScope` explicit means a `const x = doc.a; const y = x.b` resolves `y`'s dependency to `["doc.a.b"]`, not `["x.b"]`.

### What transforms are NOT

- **Not required.** Targets that want raw IR skip the transforms.
- **Not ordered globally.** Each target decides its pipeline.
- **Not semantics-preserving in the reactive sense.** `dissolveConditionals` can change which expressions are evaluated — both branches' expressions become part of one ternary. Targets must understand the tradeoff.

---

## The generator-based walker

Source: `src/walk.ts`.

`walk(ir)` and `walkEvents(ir)` are generator functions that yield a stream of `WalkEvent` values. Consumers handle each event:

| Event | Fires when |
|-------|-----------|
| `element-open` | Entering an `ElementNode`. Tag + attributes. |
| `element-close` | Leaving an `ElementNode`. |
| `content` | Encountering a `ContentNode`. |
| `loop-open` / `loop-close` | Entering / leaving a `LoopNode`. |
| `conditional-open` / `conditional-close` / `conditional-branch` | Conditional boundaries. |
| `binding` | A `BindingNode`. |
| `statement` | A `StatementNode`. |
| `labeled-block-open` / `labeled-block-close` | Entering / leaving a `LabeledBlockNode`. |

Why a generator:

1. **Testability.** Collect events into an array: `[...walkEvents(ir)]` → assert on a flat event list.
2. **Composability.** Filter, transform, or log events without modifying the walker. SSR and template extraction share the same walk.
3. **Single source of truth.** One walker; many consumers. A bug in walk order propagates uniformly and is fixed once.

### Targets use the walker

Cast's SSR uses `walk(ir)` to produce HTML strings — element-open emits `<tag`, attribute events emit attribute fragments, content events emit text (escaped via `escapeHtml`), element-close emits `</tag>` (skipping `VOID_ELEMENTS`). Cast's DOM runtime uses a parallel walker to produce DOM operations.

### What the walker is NOT

- **Not an evaluator.** It emits events describing structure; consumers decide what to do with them.
- **Not recursive in user code.** The walker is recursive internally (via `yield*`), but consumers see a flat event stream.
- **Not parallel.** JavaScript generators are synchronous and single-threaded; events are strictly ordered.

---

## `isDOMProducing`

Source: `src/ir.ts` → `isDOMProducing`.

Predicate: does this IR node produce a DOM/HTML fragment? Used by the walker to filter out non-rendering nodes (bindings, statements) from walks that only care about visible output.

```
isDOMProducing({ kind: "element" })    // true
isDOMProducing({ kind: "content" })    // true
isDOMProducing({ kind: "binding" })    // false
isDOMProducing({ kind: "statement" })  // false
```

### What `isDOMProducing` is NOT

- **Not a visibility predicate.** A DOM-producing node can still be hidden by CSS or conditional branches. The predicate only reflects whether the node would emit DOM given the current compilation path.
- **Not target-specific.** Both DOM and HTML targets treat the same nodes as "producing." Label filtering via `filterTargetBlocks` happens upstream.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `IRNode` / `IRNodeKind` / `IRNodeBase` | `src/ir.ts` | Discriminated union + shared shape. |
| `BuilderNode`, `ElementNode`, `ContentNode`, `LoopNode`, `ConditionalNode`, `ConditionalBranch`, `BindingNode`, `StatementNode`, `LabeledBlockNode`, `ChildNode` | `src/ir.ts` | Per-kind node shapes. |
| `AttributeNode`, `EventHandlerNode` | `src/ir.ts` | Element sub-structure. |
| `ContentValue`, `BindingTime`, `Dependency`, `DeltaKind`, `SlotKind` | `src/ir.ts` | Classification types. |
| `SourceSpan` | `src/ir.ts` | Source location for diagnostics. |
| `FilterMetadata` | `src/ir.ts` | Detected filter pattern on a loop. |
| `TemplateNode`, `TemplateHole`, `TemplateHoleKind` | `src/ir.ts`, `src/template.ts` | Template + hole types. |
| `MergeResult`, `MergeFailureReason` | `src/ir.ts` | `mergeSiblings` outcomes. |
| `ExpressionIR`, `LiteralNode`, `IdentifierNode`, `BindingRefNode`, `CallNode`, `MethodCallNode`, `BinaryNode` | `src/expression-ir.ts` | Expression-level IR. |
| `ClassifiedDependency`, `DependencyClassification` | `src/classify.ts` | Loop-relative classification. |
| `BindingScope` | `src/binding-scope.ts` | Identifier → binding map with dependency composition. |
| `WalkEvent` | `src/walk.ts` | Events yielded by the generator walker. |
| `analyze`, `analyzeBuilder` | `src/analyze.ts` | AST → IR entry points. |
| `parseSource`, `findBuilderCalls` | `src/project.ts` | Source parsing helpers. |
| `classifyDependencies`, `detectFilter` | `src/classify.ts`, `src/patterns.ts` | Classification primitives. |
| `extractTemplate`, `planWalk` | `src/template.ts` | Template extraction. |
| `walk`, `walkEvents`, `isDOMProducing` | `src/walk.ts`, `src/ir.ts` | Walker + predicate. |
| `dissolveConditionals`, `filterTargetBlocks`, `mergeSiblings` | `src/transforms.ts` | IR→IR passes. |
| `escapeHtml`, `VOID_ELEMENTS` | `src/html-constants.ts` | HTML helpers (targets can use; not required). |

## File Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 303 | Public barrel. Exports types, analyzer, walker, transforms, helpers. |
| `src/ir.ts` | 1598 | All IR node types and their predicates. The largest file — every node kind's shape and classification field lives here. |
| `src/expression-ir.ts` | ~ | Expression-level IR types. |
| `src/expression-build.ts` | ~ | AST → `ExpressionIR` construction. |
| `src/analyze.ts` | ~ | AST → IR. Walks builder calls, produces `BuilderNode` trees. |
| `src/project.ts` | 182 | `parseSource`, `findBuilderCalls` — ts-morph wrapper + regex pre-scan. |
| `src/reactive-detection.ts` | 520 | Type-based reactive detection: does this type carry `[CHANGEFEED]`? |
| `src/binding-scope.ts` | ~ | Identifier → binding resolution with dependency composition. |
| `src/classify.ts` | ~ | Loop-relative dependency classification. |
| `src/patterns.ts` | 179 | Filter-pattern detection. |
| `src/template.ts` | 543 | Template extraction + hole plan. |
| `src/walk.ts` | 565 | Generator-based walker + `WalkEvent` types. |
| `src/transforms.ts` | 226 | `dissolveConditionals`, `filterTargetBlocks`, `mergeSiblings`. |
| `src/html-constants.ts` | ~ | `escapeHtml`, `VOID_ELEMENTS`. |
| `src/__tests__/analyze.test.ts` | — | AST → IR: 68 tests covering every node kind + classification path. |
| `src/__tests__/expression-build.test.ts` | — | 80 tests over `ExpressionIR` construction. |
| `src/__tests__/expression-ir.test.ts` | — | 157 tests over expression-level types. |
| `src/__tests__/ir.test.ts` | 954 | Core IR predicates + type guards. |
| `src/__tests__/template.test.ts` | 817 | 49 tests: template extraction, hole assignment, `planWalk`. |
| `src/__tests__/walk.test.ts` | 561 | 27 tests: walker event order for every IR shape. |
| `src/__tests__/transforms.test.ts` | 1050 | 30 tests: `dissolveConditionals`, `filterTargetBlocks`, `mergeSiblings`. |
| `src/__tests__/tree-merge.test.ts` | 560 | Sibling-merge edge cases. |
| `src/__tests__/binding-scope.test.ts` | — | 17 binding-resolution tests (under `binding-analysis.test.ts`). |
| `src/__tests__/binding-analysis.test.ts` | — | Transitive-binding dependency extraction. |
| `src/__tests__/classify.test.ts` | — | Classification: structural / item / external. |
| `src/__tests__/patterns.test.ts` | 575 | 19 filter-pattern detection tests. |
| `src/__tests__/filter-integration.test.ts` | — | 4 end-to-end filter-compilation tests. |

## Testing

Tests exercise each pass in isolation (AST → IR → classification → templates → walk → transforms) plus end-to-end compilation of realistic builder patterns from `examples/`. No rendering target is invoked; the tests assert on IR structure and walker event streams.

The largest suites are `expression-build.test.ts` (80 tests, ~5s) and `analyze.test.ts` (68 tests, ~4s) — they run real TypeScript parsing through ts-morph, so they dominate wall time. All other suites run in milliseconds.

**Tests**: 547 passed, 0 skipped across 13 files (`analyze`: 68, `expression-build`: 80, `expression-ir`: 157, `ir`: core IR type guards, `template`: 49, `walk`: 27, `transforms`: 30, `tree-merge`: ~, `patterns`: 19, `binding-scope`: ~, `binding-analysis`: 17, `filter-integration`: 4, plus classify). Run with `cd experimental/compiler && pnpm exec vitest run`.