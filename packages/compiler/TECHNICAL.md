# @kyneta/compiler — Technical Documentation

Target-agnostic incremental view maintenance compiler. Takes TypeScript source with builder patterns over Changefeed-emitting state and produces a classified IR annotated with incremental strategies. Does not generate code for any specific rendering target — rendering targets (`@kyneta/core`, future `@kyneta/native`, etc.) consume the IR and produce target-specific output.

## Architecture

The compiler is a functor from TypeScript ASTs to annotated IR. Rendering targets are natural transformations from that IR to target-specific effects. The compiler never references DOM, HTML, or any rendering vocabulary.

```
TypeScript source
    │
    ▼
┌──────────────────────────────────┐
│  project.ts                      │  Parse source, find builder calls
│  parseSource / findBuilderCalls  │  (regex pre-scan + ts-morph)
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  analyze.ts                      │  AST → IR
│  analyzeBuilder / analyzeElement │  Expression classification,
│  analyzeExpression               │  dependency extraction,
│  reactive-detection.ts           │  reactive type detection
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  ir.ts                           │  Annotated IR
│  BuilderNode, ElementNode, etc.  │  Types, factories, guards,
│  mergeConditionalBodies          │  merge algebra, slot computation
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  walk.ts / template.ts           │  IR consumption utilities
│  walkIR / extractTemplate        │  Walker events, template holes,
│  planWalk / generateWalkCode     │  walk planning (NavOp)
└──────────────────────────────────┘

Optional (./transforms subpath):
┌──────────────────────────────────┐
│  transforms.ts                   │  IR→IR pipeline transforms
│  dissolveConditionals            │  for rendering targets
│  filterTargetBlocks              │
└──────────────────────────────────┘
```

## Core Export (`.`)

The main `@kyneta/compiler` export provides everything needed to analyze TypeScript source and produce annotated IR.

### IR Types & Factories (`ir.ts`)

The intermediate representation is a tree of typed nodes:

| Node Type | Purpose |
|-----------|---------|
| `BuilderNode` | Root: a single builder call (e.g., `div(() => { ... })`) |
| `ElementNode` | HTML element with tag, attributes, events, children |
| `ContentNode` | Text content (literal or reactive `ContentValue`) |
| `ConditionalNode` | `if`/`else` branches with optional reactive subscription |
| `LoopNode` | `for...of` iteration with iterable binding time |
| `StatementNode` | Preserved non-UI statements (side effects, logging) |
| `BindingNode` | Dependency-tracked variable binding (`const x = expr`) |
| `LabeledBlockNode` | `client:`/`server:` target-specific blocks |

Factory functions (`createBuilder`, `createElement`, `createContent`, etc.) enforce structural invariants. Type guards (`isElementNode`, `isConditionalNode`, etc.) enable safe narrowing.

**Merge algebra**: `mergeConditionalBodies` attempts to merge structurally-identical conditional branches into a single set of children with ternary `ContentValue` expressions. `mergeNode` and `mergeContentValue` implement the recursive structural comparison. Returns `MergeResult<T>` — either `{ success: true, value: T }` or `{ success: false, reason: MergeFailureReason }`.

**Slot computation**: `computeSlotKind` determines the update strategy for a content slot (`"static"`, `"reactive-replace"`, `"reactive-text"`, etc.) based on its `ContentValue`'s binding time and delta kind.

### Analysis Pipeline (`analyze.ts`)

The main entry points:

- `analyzeSourceFile(sourceFile)` — analyze all builder calls in a source file
- `analyzeBuilder(callExpr)` — analyze a single builder call expression
- `analyzeElementCall(callExpr)` — analyze an element factory call (e.g., `div(...)`)
- `analyzeExpression(expr)` — classify an expression's binding time and extract dependencies
- `findBuilderCalls(source)` — regex pre-scan for builder patterns (fast rejection)

The analysis walks the TypeScript AST via ts-morph, classifying each expression as `"static"` or `"reactive"` based on whether its type (or any transitive dependency's type) implements the `[CHANGEFEED]` protocol.

**Dependency extraction** (`extractDependencies`): Walks an expression tree and collects all reactive leaf dependencies as `Dependency` objects with `source` (the expression text) and `deltaKind` (the change granularity: `"replace"`, `"text"`, `"sequence"`, `"increment"`).

### Reactive Detection (`reactive-detection.ts`)

Detects reactive types by checking for the `[CHANGEFEED]` symbol property at the TypeScript type level:

- `isChangefeedType(type)` — does this type have `[CHANGEFEED]`?
- `isComponentFactoryType(type)` — is this a `ComponentFactory<T>`?
- `getDeltaKind(type)` — extract the delta kind from a `Changefeed<V, C>` type parameter
- `resolveReactiveImports(sourceFile)` — resolve which imported modules provide reactive types

### Binding Scope (`binding-scope.ts`)

Tracks variable bindings and their dependencies through scope chains. `createBindingScope()` returns a `BindingScope` that:

- Records `const x = expr` bindings with their resolved dependencies
- Resolves transitive dependencies (if `x = a.b` and `y = x.c`, then `y`'s leaf dep is `a.b.c`)
- Integrates with the analysis pipeline to flatten dependency chains before IR construction

### Dependency Classification (`classify.ts`)

`classifyDependencies(deps, loopVariable, iterableSource)` classifies each dependency relative to a loop variable:

- **`"item"`** — navigates from the loop variable (e.g., `recipe.name` where `recipe` is the loop var). Requires per-item subscription.
- **`"external"`** — reactive but not derived from the loop variable (e.g., `filterText`). Requires one shared subscription across all items.
- **`"structural"`** — the iterable collection itself (e.g., `doc.recipes`). Already handled by the existing listRegion subscription.

The algorithm is pure string-prefix matching on flattened leaf dependencies. This is sound because `extractDependencies` has already resolved all bindings — transitive deps are flattened to leaves. Classification never misclassifies external as item; uncertain cases default to `"external"` (safe but conservative).

### Filter Pattern Recognition (`patterns.ts`)

`detectFilterPattern(loop)` recognizes when a reactive loop body represents a filter pattern — a common UI idiom where items are conditionally shown based on a reactive predicate.

The 6 criteria:
1. The loop iterates a reactive collection (`iterableBindingTime === "reactive"`)
2. The body contains only `BindingNode`s and exactly one `ConditionalNode`
3. The conditional has no else branch (single `if`)
4. The conditional is reactive (`subscriptionTarget !== null`)
5. The conditional wraps ALL DOM-producing content
6. The condition has at least one item-dependent dependency

Returns `FilterMetadata` (with classified dependencies and the conditional reference) or `null`. Returning `null` is always safe — the fallback produces correct behavior without subscription precision optimization.

Chained filters (e.g., `if (a) { if (b) { ... } }`) are automatically flattened: the function looks through single-child-conditional chains and merges their condition dependencies.

### Walker (`walk.ts`)

Generator-based IR walker that produces a stream of `WalkEvent` objects:

- `ElementStartEvent` / `ElementEndEvent` — element boundaries
- `StaticTextEvent` / `DynamicContentEvent` — content nodes
- `StaticAttributeEvent` / `DynamicAttributeEvent` — element attributes
- `EventHandlerEvent` — event listener registrations
- `RegionPlaceholderEvent` — markers for reactive regions (loops, conditionals)
- `ComponentPlaceholderEvent` — markers for component instantiation

`walkIR(builder)` yields events in document order. `collectEvents(builder)` materializes the stream into an array. The walker is the primary consumption interface for rendering targets that need ordered traversal.

### Template Extraction (`template.ts`)

`extractTemplate(builder)` converts a `BuilderNode` into a `TemplateNode` — a static HTML string with `TemplateHole` markers for dynamic content:

- `TemplateHole` records the kind (`"text"`, `"attribute"`, `"event"`, `"region"`, `"component"`), the DOM path, and a reference to the source IR node
- `planWalk(holes)` computes a minimal sequence of `NavOp` instructions (`firstChild`, `nextSibling`, `parentNode`) to reach each hole from a cloned template
- `generateWalkCode(ops)` produces JavaScript that walks the cloned DOM tree
- `generateTemplateDeclaration(template)` produces the `_tmpl` variable declaration

Templates enable the "clone and patch" optimization: instead of creating elements one by one, the rendering target clones a pre-parsed HTML template and patches only the dynamic holes.

### Project Management (`project.ts`)

- `parseSource(code, filename)` — parse source into a ts-morph `SourceFile`
- `hasBuilderCalls(code)` — fast regex pre-scan (avoids full parse for non-builder files)
- `analyzeAllBuilders(sourceFile, filename)` — analyze all builder calls, returns `{ callExpr, ir }[]`
- `resetProject()` — reset the shared ts-morph project (for test isolation)

### HTML Constants (`html-constants.ts`)

Shared utilities used by both the compiler and rendering targets:

- `VOID_ELEMENTS` — set of self-closing HTML elements
- `isVoidElement(tag)` — check if tag is void
- `escapeHtml(str)` — escape HTML special characters
- `generateMarkerId(prefix, index)` — generate unique marker IDs for reactive regions
- `generateRegionMarkers(type, index)` — generate comment marker pairs for SSR hydration

## Transforms Export (`./transforms`)

The `@kyneta/compiler/transforms` subpath provides optional IR→IR pipeline transforms. These are separated from the core export because they serve the consumer (rendering target), not the producer (analysis pipeline). The compiler's analysis pipeline does not depend on them.

### `filterTargetBlocks(builder, target)`

Resolves `client:`/`server:` labeled blocks based on the active compilation target:

- **Matching target** (e.g., `client:` when target is `"dom"`) → **unwrap**: splice the block's children into the parent
- **Non-matching target** → **strip**: remove the block entirely

After filtering, the returned `BuilderNode` contains no `LabeledBlockNode` nodes. Codegens, walkers, and template extraction never see them.

Label-to-target mapping: `client` → `"dom"`, `server` → `"html"`.

### `dissolveConditionals(builder)`

Replaces dissolvable reactive conditionals with merged children containing ternary expressions.

A conditional is dissolvable when:
1. It has a reactive subscription target (`subscriptionTarget !== null`)
2. It has an else branch (all branches covered)
3. `mergeConditionalBodies` succeeds (branches are structurally identical)

After dissolution, the returned `BuilderNode` contains no dissolvable `ConditionalNode` nodes. Non-dissolvable conditionals (different structure, missing else, static) are preserved unchanged. The walker, template extraction, and codegen see regular elements/content with ternary values instead of conditional branching — enabling the "dissolve to ternary" optimization that avoids runtime conditional regions.

## File Structure

```
packages/compiler/src/
├── index.ts                    # Core barrel — analysis pipeline, IR, utilities
├── ir.ts                       # IR types, factories, guards, merge algebra
├── ir.test.ts                  # IR unit tests (predicates, merge, dissolution)
├── analyze.ts                  # AST → IR analysis pipeline
├── analyze.test.ts             # Analysis unit tests
├── reactive-detection.ts       # CHANGEFEED type detection, delta kind extraction
├── binding-scope.ts            # Dependency-tracked variable binding scopes
├── binding-scope.test.ts       # Binding scope unit tests
├── binding-analysis.test.ts    # Binding → dependency resolution integration tests
├── classify.ts                 # Dependency classification (item/external/structural)
├── classify.test.ts            # Classification unit tests
├── patterns.ts                 # Filter pattern recognition (6 criteria)
├── patterns.test.ts            # Pattern recognition unit tests
├── filter-integration.test.ts  # Classification + pattern integration tests
├── walk.ts                     # Generator-based IR walker (WalkEvent stream)
├── walk.test.ts                # Walker unit tests
├── template.ts                 # Template extraction + walk planning (NavOp)
├── template.test.ts            # Template extraction unit tests
├── html-constants.ts           # Shared HTML utilities (escaping, void elements)
├── project.ts                  # ts-morph project management, builder call detection
├── transforms.ts               # IR→IR pipeline transforms (./transforms subpath)
└── transforms.test.ts          # Transforms unit tests
```

## Cross-Package Dependencies

```
@kyneta/schema       # CHANGEFEED protocol, delta types
    ↑
@kyneta/compiler     # AST → IR analysis, IR transforms (/transforms)
    ↑
@kyneta/core         # IR → DOM/HTML codegen, runtime, build plugins
```

The compiler depends only on `@kyneta/schema` (for the `CHANGEFEED` symbol and change types used in reactive detection) and `ts-morph` (for TypeScript AST analysis). It has no runtime, DOM, or rendering dependencies.

## Design Principles

1. **Target-agnostic IR**: The compiler produces IR annotated with binding times, delta kinds, and structural metadata — but never commits to a rendering strategy. `SlotKind` tells you *what* changes and *how*; it doesn't tell you *what to do about it*.

2. **Sound-and-conservative classification**: Dependency classification and pattern recognition are designed to never produce false positives. If uncertain, they fall back to the general case (which is always correct, just less optimized). This means a rendering target can trust the compiler's annotations without defensive checks.

3. **Transforms as optional consumer-side operations**: `dissolveConditionals` and `filterTargetBlocks` are structurally part of the rendering pipeline, not the analysis pipeline. They transform IR that has already been produced. A rendering target that doesn't want dissolution or target-block filtering simply doesn't call them.

4. **Flattened dependencies**: By the time dependencies reach the IR, all bindings have been resolved to leaf sources. This simplifies all downstream consumers — classification is string-prefix matching, not scope walking.