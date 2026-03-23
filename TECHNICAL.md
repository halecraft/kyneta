# Kyneta — Technical Overview

This monorepo contains the Kyneta framework: a compiled, delta-driven web framework powered by the CHANGEFEED protocol from `@kyneta/schema`.

## Packages

### `@kyneta/schema`

Schema interpreter algebra — pure structure, pluggable interpretations.

Defines a two-namespace grammar (`Schema` for backend-agnostic structure, `LoroSchema` for CRDT-annotated structure) and a fluent `interpret()` builder that composes a five-layer interpreter stack: bottom → navigation → readable → caching → writable → changefeed. The output is a typed `Ref<S>` handle — a callable, navigable, writable, observable document reference. A `Substrate` interface abstracts state management and transfer semantics, enabling different backing stores (plain JS objects, CRDTs) behind the same interpreter stack.

Zero runtime dependencies. 1000+ tests.

### `@kyneta/compiler`

Target-agnostic incremental view maintenance compiler.

Takes TypeScript source with builder patterns over Changefeed-emitting state and produces a classified IR annotated with incremental strategies. Does not generate code for any specific rendering target — rendering targets (`@kyneta/core`, future `@kyneta/native`, etc.) consume the IR and produce target-specific output.

Key subsystems:
- **Analysis** (`analyze.ts`) — AST → IR via ts-morph, reactive detection, expression classification
- **IR** (`ir.ts`) — types, factories, guards, merge algebra, slot computation
- **Walker & Template** (`walk.ts`, `template.ts`) — generator-based IR walker, template extraction + walk planning
- **Binding Scope** (`binding-scope.ts`) — dependency-tracked variable bindings
- **Classification** (`classify.ts`, `patterns.ts`) — dependency classification, filter pattern recognition
- **Transforms** (`transforms.ts`, optional `./transforms` subpath) — IR→IR pipeline transforms for rendering targets: `dissolveConditionals` (merge structurally-identical conditional branches into ternaries) and `filterTargetBlocks` (strip/unwrap labeled blocks by target)

330+ tests.

### `@kyneta/core`

Web rendering target — compiled delta-driven web framework.

Consumes annotated IR from `@kyneta/compiler` and produces DOM manipulation or HTML string generation. The compiler detects reactive refs via the `[CHANGEFEED]` protocol and the runtime emits delta-aware regions (`textRegion`, `listRegion`, `conditionalRegion`, `valueRegion`) that perform O(k) DOM updates where k is the number of operations in a delta.

Key subsystems:
- **Codegen** (`src/compiler/`) — IR → DOM/HTML code generation, transform orchestration
- **Runtime** (`src/runtime/`) — mount, scope lifecycle, delta regions, hydration
- **Unplugin** (`src/unplugin/`) — universal build plugin with adapters for Vite, Bun, Rollup, Rolldown, esbuild, Farm
- **Reactive** (`src/reactive/`) — `state()` local reactive primitive (`LocalRef<T>`)

560+ tests.

### `@kyneta/perspective`

Convergent Constraint Systems — a constraint-based approach to CRDTs. Research package exploring an alternative theoretical foundation for collaborative state. Independent of the core framework.

## Cross-Package Dependencies

```
@kyneta/schema              (no dependencies)
    │
    ├──► @kyneta/compiler   (AST → IR analysis, IR transforms)
    │        │
    │        └──► @kyneta/core   (IR → DOM/HTML codegen, runtime, unplugin)
    │                 │
    │                 └──► examples/recipe-book
    │
    └──► @kyneta/perspective
```

`@kyneta/schema` is the foundation — it defines the CHANGEFEED protocol, delta types, and the interpreter algebra that `compiler`, `core`, and `perspective` build upon. `@kyneta/compiler` is the intermediate layer — it produces target-agnostic annotated IR. `@kyneta/core` is the web rendering target that consumes compiler IR and produces DOM/HTML output. The `/transforms` subpath (`@kyneta/compiler/transforms`) provides optional IR→IR pipeline transforms that rendering targets apply before codegen.

## Key Concepts

### CHANGEFEED Protocol

The universal reactive interface. Any value with a `[CHANGEFEED]` symbol property participates in the observation protocol:

- `ref[CHANGEFEED].current` — read the current value
- `ref[CHANGEFEED].subscribe(cb)` — observe changes as `Changeset` batches

Schema-interpreted refs, `LocalRef<T>` from `state()`, and any custom reactive type can implement this protocol. The compiler's reactive detection checks for `[CHANGEFEED]` at the type level to determine which runtime region to emit.

### Auto-Read Insertion and the `()` Snapshot Convention

The compiler supports a **bare-ref developer experience**: developers write `recipe.name.toLowerCase()` and the compiler auto-inserts `()` reads at the ref/value boundary, emitting `recipe.name().toLowerCase()`. This is implemented via the `ExpressionIR` tree — a structured representation of expressions where `RefReadNode` renders as `source()` (the observation morphism).

- **Bare ref access**: `recipe.name.toLowerCase()` → compiler detects `recipe.name` is a changefeed, wraps in `RefReadNode`, renders as `recipe.name().toLowerCase()`
- **Explicit snapshot**: `recipe.name()` → developer writes `()` explicitly, compiler produces `SnapshotNode` — same rendering, distinct semantics (developer intent)
- **Binding expansion**: `const nameMatch = recipe.name.toLowerCase().includes(filterText.toLowerCase())` — the `nameMatch` binding carries its full expression tree. In reactive closures, the codegen expands the binding inline for self-contained re-evaluation from live refs.

The `reactive-view` type augmentations (`@kyneta/core/types/reactive-view`) widen `TextRef extends String` and `CounterRef extends Number` so that value-type methods (`.toLowerCase()`, `.toFixed()`, etc.) are visible at the type level. `LocalRef<T> = Widen<T> & LocalRefBase<T>` gives the same widening via intersection. These are compile-time illusions — the compiler transforms the code before it runs.

### Delta Kinds

Four categories of structured change, each with a specialized runtime region:

| Delta Kind | Change Type | Runtime Region | DOM Strategy |
|------------|------------|----------------|-------------|
| **text** | `TextChange` (retain/insert/delete ops) | `textRegion` | Surgical `insertData`/`deleteData` on text nodes |
| **sequence** | `SequenceChange` (retain/insert/delete ops) | `listRegion` | O(1) `insertBefore`/`removeChild` per op |
| **replace** | `ReplaceChange` (whole-value swap) | `valueRegion` / `conditionalRegion` | Re-read and apply, or swap DOM branches |
| **increment** | `IncrementChange` (counter delta) | `valueRegion` | Re-read and apply |

### Interpreter Algebra

`@kyneta/schema`'s core abstraction. A schema is a recursive grammar; an interpreter is a function from schema nodes to runtime values. Interpreters compose via the fluent builder:

```typescript
interpret(schema, ctx)
  .with(readable)     // adds callable () → value
  .with(writable)     // adds .set(), .push(), .insert(), etc.
  .with(changefeed)   // adds [CHANGEFEED] observation
  .done()             // → Ref<S>
```

Each `.with(layer)` wraps the previous result, adding capabilities. The type system tracks which capabilities are present via `Ref<S>` (full stack), `RWRef<S>` (read-write), and `RRef<S>` (read-only).

### Functional Core / Imperative Shell

The runtime follows FC/IS throughout:
- **Functional core** — pure planning functions (`planInitialRender`, `planDeltaOps`, `planConditionalUpdate`) produce operation lists
- **Imperative shell** — `executeOp` applies operations to the DOM

This separation enables testing without a DOM and ensures the planning logic is independent of the rendering target.

## Development

### Build & Verification

The monorepo uses **Turborepo** for cross-package task orchestration with content-hash caching, and **@halecraft/verify** for intra-package verification pipelines.

```sh
# Build all packages in dependency order (schema → compiler → core)
pnpm build                              # alias for: turbo build

# Verify all main packages (format → types → logic)
pnpm verify                             # alias for: turbo verify --filter='!@kyneta/perspective'

# Test a single package (auto-builds upstream deps if stale)
npx turbo test --filter=@kyneta/core    # builds schema + compiler first, then runs core tests

# Verify perspective separately (opt-in, not in default pipeline)
npx turbo verify --filter=@kyneta/perspective
```

**Turbo tasks** (`turbo.json`):
- `build` — depends on `^build` (upstream builds), caches `dist/**`
- `verify` — depends on `^build`, runs the package's `verify` script
- `test` — depends on `^build`, runs the package's `test` script (which calls `verify logic`)

**Verify pipeline** (`verify.config.ts` in each package):
1. **format** — `biome check --write .` (auto-fixes formatting, reports lint issues)
2. **types** — `tsgo --noEmit --skipLibCheck` (fast Rust-based type checking)
3. **logic** — `vitest run` (unit + integration tests)

Each step depends on the previous: types won't run if format fails, logic won't run if types fail.

**Per-package test counts:**

| Package | Tests | Notes |
|---------|-------|-------|
| `@kyneta/schema` | 1050+ | Interpreter algebra, changefeeds, substrates |
| `@kyneta/compiler` | 504 | AST analysis, ExpressionIR, reactive detection |
| `@kyneta/core` | 609 | Codegen, runtime regions, integration tests |
| `examples/recipe-book` | 18 | Full-stack SSR + sync integration |
| `@kyneta/perspective` | 1374 | CCS kernel, Datalog evaluator, incremental pipeline |

### Workspace Structure

```
kyneta/
├── packages/
│   ├── schema/       @kyneta/schema
│   ├── compiler/     @kyneta/compiler
│   ├── core/         @kyneta/core
│   └── perspective/  @kyneta/perspective
├── examples/
│   └── recipe-book/  Full-stack SSR + sync example
├── .plans/           Long-term architectural plans
└── .jj-plans/        Active jj change plans (gitignored)
```

Package manager: **pnpm** with workspace protocol (`workspace:^`).
Task runner: **Turborepo** for cross-package build/test orchestration.
Verification: **@halecraft/verify** for intra-package format → types → logic pipelines.
Linter/Formatter: **Biome** (root `biome.json`, 2-space indent, no semicolons).
Type checker: **tsgo** (`@typescript/native-preview`) — Rust-based TypeScript compiler for fast verification.
Runtime: **Bun** for scripts and CLI; **Vite** for dev server and build.
VCS: **jj** (Jujutsu).

## Relationship to Loro

Kyneta was originally developed as `@loro-extended/*` — a set of packages extending the [Loro](https://loro.dev/) CRDT framework. The architecture has since been decoupled:

- `@kyneta/schema` defines a **backend-agnostic** schema grammar (`Schema` namespace). The `LoroSchema` namespace adds Loro-specific annotations (`text`, `counter`, `movableList`, `tree`) via the annotation mechanism — these are markers that a Loro backend would interpret, but the interpreter algebra itself is pure.
- `@kyneta/core` consumes the CHANGEFEED protocol, which is defined in `@kyneta/schema` and has no Loro dependency.
- Historical documents (`LEARNINGS.md`, `theory/interpreter-algebra.md`) retain `@loro-extended` references as they are factually accurate for their era.

The annotation mechanism (`Schema.annotated("text")`, `Schema.annotated("counter")`) is the bridge: it marks schema nodes with backend-specific semantics without coupling the grammar to any particular CRDT implementation.