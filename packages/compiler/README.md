# @kyneta/compiler

Target-agnostic incremental view maintenance compiler for structured deltas. Takes TypeScript source with builder patterns over Changefeed-emitting state and produces a classified IR annotated with incremental strategies.

The compiler never references DOM, HTML, or any rendering vocabulary — rendering targets consume the IR and produce target-specific output.

Used primarily by `@kyneta/cast` web framework to build SSR and live DOM sync with automatic reactive dependency awareness.

## Install

```sh
npm install @kyneta/compiler
```

## Overview

The compiler is a functor from TypeScript ASTs to annotated IR. Rendering targets are natural transformations from that IR to target-specific effects.

```
TypeScript source → parse → analyze (AST → IR) → Annotated IR → rendering target
```

1. **Parse** — Find builder calls in TypeScript source via regex pre-scan + ts-morph
2. **Analyze** — Transform AST into IR nodes with binding-time classification, delta kinds, and dependency extraction
3. **Consume** — Walk the IR or extract templates for code generation

## Exports

### `.` (core)

The main export provides the full analysis pipeline and IR types:

- **`analyzeSourceFile`** / **`analyzeBuilder`** — AST → IR analysis
- **`parseSource`** / **`findBuilderCalls`** — Source parsing and builder detection
- **IR types** — `BuilderNode`, `ElementNode`, `ContentNode`, `ConditionalNode`, `LoopNode`, `StatementNode`, `BindingNode`, `LabeledBlockNode`
- **ExpressionIR** — Structured expression trees with auto-read insertion, binding expansion, and dependency derivation as structural folds
- **`buildExpressionIR`** — Single-pass AST → ExpressionIR tree builder
- **`walkIR`** / **`extractTemplate`** — Generator-based IR walker and template extraction with walk planning
- **`classifyDependencies`** — Dependency classification into "item", "external", or "structural"
- **`detectFilterPattern`** — Six-criteria filter pattern recognition for list optimizations
- **Reactive detection** — `isChangefeedType`, `getDeltaKind`, `resolveReactiveImports`

### `./transforms`

Optional IR→IR pipeline transforms for rendering targets:

- **`dissolveConditionals(builder)`** — Replaces structurally-identical conditional branches with merged children containing ternary expressions. Eliminates conditional regions when branches differ only in values.
- **`filterTargetBlocks(builder, target)`** — Resolves `client:` / `server:` labeled blocks by stripping or unwrapping them based on the rendering target.

## Key Concepts

### Binding-Time Analysis

The compiler classifies every value by when it becomes known:

| Binding Time | When Known | Example |
|---|---|---|
| `literal` | Compile time | `"Hello"`, `42` |
| `render` | Render time | `props.name`, `someVar` |
| `reactive` | Runtime (varies) | `doc.count`, `recipe.name` |

### Delta Kind

For reactive dependencies, the compiler tracks the kind of structured change the source provides — `replace`, `text`, `sequence`, `map`, `tree`, or `increment`. This is orthogonal to binding time: all reactive values change at runtime, but they differ in how much structural information accompanies the notification.

### ExpressionIR

Expressions are represented as typed trees (`RefReadNode`, `MethodCallNode`, `TernaryNode`, etc.) rather than strings. This enables:

- **Auto-read insertion** — `recipe.name.toLowerCase()` becomes `recipe.name().toLowerCase()` via `RefReadNode`
- **Binding expansion** — Variable bindings carry their full expression tree for inline re-evaluation
- **Dependency extraction** — A fold over the tree, not string parsing

### Bare-Ref Developer Experience

Developers write natural TypeScript — `recipe.name.toLowerCase()` — and the compiler detects that `recipe.name` is a Changefeed, inserts the read boundary, and classifies dependencies. No special syntax required.

## Cross-Package Position

```
@kyneta/schema       →  CHANGEFEED protocol, delta types
    ↓
@kyneta/compiler     →  AST → IR analysis, IR transforms
    ↓
@kyneta/cast         →  IR → DOM/HTML codegen, runtime, build plugins
```

The compiler depends on `@kyneta/schema` for the `CHANGEFEED` symbol and change types used in reactive detection, and on `ts-morph` for TypeScript AST analysis.

## Peer Dependencies

| Package | Version |
|---------|---------|
| `@kyneta/schema` | `>=0.0.1` |

## License

MIT
