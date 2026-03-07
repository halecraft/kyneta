# Prism

**Unified CCS Engine — A constraint-based collaborative state system**

Prism implements the [Unified CCS Engine Specification](./theory/unified-engine.md), a rigorous architecture for building collaborative realities where independent agents assert **constraints** about what should be true, and a deterministic **solver** constructs shared state from those perspectives.

## Core Ideas

### Constraints, Not Operations

An operation says "do this." A constraint says "this should be true." Each agent asserts constraints from its own subjective perspective. The shared reality *emerges* when the solver examines all perspectives and constructs a state that accounts for them.

### Engine = Kernel + Datalog Evaluator

The engine has exactly two mandatory components:

- **Layer 0 Kernel** — Constraint storage, set union merge, CnId generation, Lamport clocks, signatures, authority/validity, retraction/dominance, version vectors. Mechanical algorithms — no inference, no search.
- **Datalog Evaluator** — Stratified, bottom-up, semi-naive. Evaluates rule constraints from the store over facts derived from active constraints, producing the reality.

Everything else — LWW value resolution, Fugue sequence ordering, custom conflict resolution, schema mappings — is expressed as Datalog rules that travel in the constraint store.

### Six Constraint Types

| Type | Purpose | Retractable? |
|------|---------|-------------|
| `structure` | Permanent node in the reality tree | Never |
| `value` | Content at a node | Yes |
| `retract` | Asserts a constraint should be dominated | Yes (enables undo) |
| `rule` | Datalog rule for solver/query evaluation | Yes |
| `authority` | Capability grant/revoke | Via revocation only |
| `bookmark` | Named point in causal time | Yes |

### Trivial Merge, Complex Solving

Merge is set union — commutative, associative, idempotent. The solver pipeline does the work:

```
Constraint Store (S) → filter by Version (S_V) → Valid(S_V) → Active(Valid(S_V)) → Build Skeleton → Resolve Values → Reality
```

### Time Travel Is Free

The solver is a pure function parameterized by a version vector. `solve(S, V)` computes the reality at any historical moment V. No special mode, no undo stack — just the solver applied to a filtered store.

## Project Status

🚧 **Active Development** — Phases 1–4 complete (kernel, Datalog evaluator, solver pipeline). Phases 5–6 remaining (bootstrap, documentation).

See [.plans/002-unified-ccs-engine.md](./.plans/002-unified-ccs-engine.md) for the implementation plan.

### Architecture

```
Engine
├── base/             Shared types: CnId, Value, PeerID, Counter, Result<T,E>
├── kernel/           Layer 0 — Constraint store, authority, validity,
│   ├── store.ts        retraction/dominance, version vectors
│   ├── pipeline.ts     Solver composition root: solve(S, V?) → Reality
│   ├── structure-index.ts  Slot identity + parent→child indexes
│   ├── projection.ts   Active constraints → Datalog ground facts
│   └── skeleton.ts     Reality tree builder (uses native solvers)
├── datalog/          Stratified bottom-up evaluator with negation & aggregation
├── solver/           Native LWW + Fugue (optional optimization, §B.7)
└── bootstrap.ts      Reality creation with default solver rules (Phase 5)
```

### What Works Today

The full solver pipeline: `Store → Version Filter → Valid(S) → Active(S) → Structure Index → Projection → Skeleton → Reality`. Two agents can create constraints, sync via delta, and both compute identical realities. Version-parameterized solving (`solve(S, V)`) enables time travel. 643 tests pass.

### Previous Prototype

The `v0` prototype (Plan 001) validated the CCS thesis with 476 tests confirming convergence, Fugue interleaving, LWW resolution, and Loro equivalence. The current implementation is a ground-up rewrite aligned with the formal spec.

## Installation

```bash
bun install
```

## Development

```bash
bun install          # Install dependencies
bun run test         # Run tests in watch mode
bun run test:run     # Run tests once
bun run typecheck    # TypeScript type checking
```

## Documentation

- [Unified CCS Engine Spec](./theory/unified-engine.md) — The authoritative specification
- [TECHNICAL.md](./TECHNICAL.md) — Architecture, algorithms, design decisions
- [LEARNINGS.md](./LEARNINGS.md) — Discoveries, corrections, and open questions
- [Implementation Plan](./.plans/002-unified-ccs-engine.md) — Phased plan with status tracking

## Theoretical Foundation

Prism maintains all CRDT guarantees:

- **Semilattice**: Constraint stores under ∪. Commutative, associative, idempotent.
- **Convergence**: Same constraints → same reality. Always.
- **Monotonic growth**: The store only grows (pre-compaction).
- **Structural permanence**: `structure` constraints are never retracted.
- **Causal retraction**: You can only retract what you've observed.
- **Solver independence**: Solvers never see retractions or invalid constraints.

## Related Work

- Concurrent Constraint Programming (Saraswat, 1993)
- CRDTs (Shapiro et al., 2011)
- Fugue (Weidner & Kleppmann, 2023)
- CALM Theorem (Hellerstein, 2010)
- Dedalus (Alvaro et al., 2011)
- DBSP (Budiu & McSherry, 2023)

## License

MIT