# Kyneta — Technical Overview

This monorepo contains the Kyneta framework: a compiled, delta-driven web framework powered by the CHANGEFEED protocol from `@kyneta/schema`.

## Packages

### `@kyneta/schema`

Schema interpreter algebra — pure structure, pluggable interpretations.

Defines a two-namespace grammar (`Schema` for backend-agnostic structure, `LoroSchema` for CRDT-annotated structure) and a fluent `interpret()` builder that composes a five-layer interpreter stack: bottom → navigation → readable → caching → writable → changefeed. The output is a typed `Ref<S>` handle — a callable, navigable, writable, observable document reference.

Zero runtime dependencies. 1000+ tests.

### `@kyneta/core`

Compiled delta-driven web framework.

A multi-phase compiler (analyze → IR → codegen) transforms natural TypeScript builder patterns into direct DOM manipulation or HTML string generation. The compiler detects reactive refs via the `[CHANGEFEED]` protocol and emits delta-aware runtime regions (`textRegion`, `listRegion`, `conditionalRegion`, `valueRegion`) that perform O(k) DOM updates where k is the number of operations in a delta.

Key subsystems:
- **Compiler** (`src/compiler/`) — static analysis, IR, dual-target codegen (DOM + HTML)
- **Runtime** (`src/runtime/`) — mount, scope lifecycle, delta regions, hydration
- **Unplugin** (`src/unplugin/`) — universal build plugin with adapters for Vite, Bun, Rollup, Rolldown, esbuild, Farm
- **Server** (`src/server/`) — SSR rendering utilities (escape-hatch API; the compiler's HTML codegen is the primary SSR path)
- **Reactive** (`src/reactive/`) — `state()` local reactive primitive (`LocalRef<T>`)

860+ tests.

### `@kyneta/perspective`

Convergent Constraint Systems — a constraint-based approach to CRDTs. Research package exploring an alternative theoretical foundation for collaborative state. Independent of the core framework.

## Cross-Package Dependencies

```
@kyneta/schema          (no dependencies)
    │
    ├──► @kyneta/core   (compiler, runtime, unplugin)
    │        │
    │        └──► examples/recipe-book
    │
    └──► @kyneta/perspective
```

`@kyneta/schema` is the foundation — it defines the CHANGEFEED protocol, delta types, and the interpreter algebra that both `core` and `perspective` build upon.

## Key Concepts

### CHANGEFEED Protocol

The universal reactive interface. Any value with a `[CHANGEFEED]` symbol property participates in the observation protocol:

- `ref[CHANGEFEED].current` — read the current value
- `ref[CHANGEFEED].subscribe(cb)` — observe changes as `Changeset` batches

Schema-interpreted refs, `LocalRef<T>` from `state()`, and any custom reactive type can implement this protocol. The compiler's reactive detection checks for `[CHANGEFEED]` at the type level to determine which runtime region to emit.

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

### Build Order

```sh
pnpm -C packages/schema build   # schema first (no deps)
pnpm -C packages/core build     # core depends on schema
```

### Test Commands

```sh
# Per-package
cd packages/schema && pnpm test        # 1000+ tests
cd packages/core && npx vitest run     # 860+ tests
cd examples/recipe-book && pnpm test   # 12 integration tests
```

### Workspace Structure

```
kyneta/
├── packages/
│   ├── schema/       @kyneta/schema
│   ├── core/         @kyneta/core
│   └── perspective/  @kyneta/perspective
├── examples/
│   └── recipe-book/  Full-stack SSR + sync example
├── .plans/           Long-term architectural plans
└── .jj-plans/        Active jj change plans (gitignored)
```

Package manager: **pnpm** with workspace protocol (`workspace:^`).
Runtime: **Bun** for scripts and CLI; **Vite** for dev server and build.
VCS: **jj** (Jujutsu).

## Relationship to Loro

Kyneta was originally developed as `@loro-extended/*` — a set of packages extending the [Loro](https://loro.dev/) CRDT framework. The architecture has since been decoupled:

- `@kyneta/schema` defines a **backend-agnostic** schema grammar (`Schema` namespace). The `LoroSchema` namespace adds Loro-specific annotations (`text`, `counter`, `movableList`, `tree`) via the annotation mechanism — these are markers that a Loro backend would interpret, but the interpreter algebra itself is pure.
- `@kyneta/core` consumes the CHANGEFEED protocol, which is defined in `@kyneta/schema` and has no Loro dependency.
- Historical documents (`LEARNINGS.md`, `theory/interpreter-algebra.md`) retain `@loro-extended` references as they are factually accurate for their era.

The annotation mechanism (`Schema.annotated("text")`, `Schema.annotated("counter")`) is the bridge: it marks schema nodes with backend-specific semantics without coupling the grammar to any particular CRDT implementation.