# Kyneta

> 🧪 **Experimental** — All packages are v0.0.1 prototypes. Not ready for production use.

A collaborative-first application platform where CRDTs meet compiled UI. Kyneta explores three ideas in parallel: a constraint-based CRDT engine where merge is trivially set union and complexity lives in a Datalog solver; a schema algebra that collapses parallel tree walkers into a single generic catamorphism; and a compiled UI framework that exploits CRDT deltas for O(k) DOM updates.

## Packages

| Package | Description | Tests |
|---------|-------------|-------|
| [`@kyneta/core`](./packages/core) (Kinetic) | Compiled delta-driven UI framework. Transforms natural TypeScript into code that directly consumes Loro CRDT deltas — character-level text patches, O(k) list updates, branch swapping — with no virtual DOM and no diffing. | ~1,000 |
| [`@kyneta/perspective`](./packages/perspective) (Prism) | Convergent Constraint Systems engine. Agents assert constraints, merge is set union, and a stratified Datalog evaluator derives shared reality. Includes an incremental pipeline based on DBSP for O(\|Δ\|) updates. Zero runtime dependencies. | 1,304 |
| [`@kyneta/schema`](./packages/schema) | Schema interpreter algebra. One recursive `Schema` type, one generic `interpret()` catamorphism, pluggable interpreters for reading, mutation, observation, and validation. Zero runtime dependencies. | 538 |

### Dependencies

```
@kyneta/core ──depends on──▶ @kyneta/schema
@kyneta/perspective          (standalone)
@kyneta/schema               (standalone)
```

The three packages are being built in parallel. They share a monorepo but are not yet integrated into a unified stack.

## Why Kyneta

**CRDTs already know what changed.** When you insert a character, the CRDT emits a delta saying exactly where. Traditional UI frameworks ignore this — they diff output to rediscover changes. Kyneta's compiler (Kinetic) transforms TypeScript into code that directly consumes these deltas, achieving O(k) DOM updates where k is the number of operations.

**Collaboration needs more than merge functions.** Traditional CRDTs couple state representation with merge logic. Kyneta's constraint engine (Prism) separates them: the semilattice moves to constraint sets (merge = set union), and a Datalog solver derives state. Conflict resolution strategies become rules that travel *inside* the data — change the rules, change reality, without touching the engine.

**Schemas should be walked once.** A schema tree gets traversed for serialization, validation, mutation, observation, and more — often 10+ parallel switch dispatches. Kyneta's schema algebra collapses them into one catamorphism with pluggable interpreters.

## Academic Foundations

- **DBSP** — Budiu, McSherry, Ryzhyk & Tannen. Algebraic incremental view maintenance via Z-sets, integration, and differentiation operators. Foundation for the incremental pipeline.
- **Concurrent Constraint Programming** — Saraswat, 1993. The theoretical ancestor of constraint-based CRDTs.
- **CRDTs** — Shapiro, Preguiça, Baquero & Zawirski, 2011. Conflict-free Replicated Data Types.
- **Fugue** — Weidner & Kleppmann, 2023. A sequence CRDT with optimal performance, expressed as Datalog rules in Prism.
- **CALM Theorem** — Hellerstein, 2010. Consistency as logical monotonicity — monotonic programs are eventually consistent without coordination.
- **Datalog** — Ullman, 1988; Apt, Blair & Walker, 1988. The query language powering Prism's solver.

## Getting Started

```bash
# Install dependencies
pnpm install

# Run tests per package
cd packages/core && pnpm test
cd packages/perspective && pnpm run test:run
cd packages/schema && pnpm test
```

## Project Status

All three packages are experimental prototypes at v0.0.1. The core ideas are validated with 2,800+ tests across the monorepo, but APIs are unstable and integration between packages is incomplete.

See each package's README for detailed status:
- [Kinetic status](./packages/core/README.md#prototype-status)
- [Prism status](./packages/perspective/README.md#project-status)

## License

Each package is independently licensed. See the LICENSE file in each package directory.

| Package | License |
|---------|---------|
| `@kyneta/core` | MIT |
| `@kyneta/perspective` | BSD-3-Clause |
| `@kyneta/schema` | GPL-3.0-only |