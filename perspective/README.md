# Prism

**Convergent Constraint Systems — where constraints are truth and state is derived**

Prism implements the [Unified CCS Engine Specification](./theory/unified-engine.md), an architecture for collaborative realities where independent agents assert **constraints** about what should be true, and a deterministic **solver** constructs shared state from those assertions.

## Quick Start

```typescript
import {
  createReality, solve, insert,
  produceRoot, produceMapChild, produceSeqChild,
  exportDelta, importDelta, createStore, createAgent,
  getVersionVector,
} from 'prism';

// 1. Bootstrap a reality — emits admin grant + default solver rules
const { store, agent: alice, config } = createReality({ creator: 'alice' });

// 2. Create structure
const { constraint: rootC, id: rootId } = produceRoot(alice, 'profile', 'map');
insert(store, rootC);
alice.observe(rootC);

const { constraint: nameC, id: nameId } = produceMapChild(alice, rootId, 'name');
insert(store, nameC);
alice.observe(nameC);

// 3. Assert a value
const nameVal = alice.produceValue(nameId, 'Alice');
insert(store, nameVal);
alice.observe(nameVal);

// 4. Solve — deterministic reality from constraints
const reality = solve(store, config);
// reality.root.children.get('profile').children.get('name').value === 'Alice'

// 5. Sync — another agent joins
const bobStore = createStore();
importDelta(bobStore, exportDelta(store, getVersionVector(bobStore)));
// Bob now has the same constraints → same reality
```

## Core Ideas

### Constraints, Not Operations

An operation says "do this." A constraint says "this should be true." Each agent asserts constraints from its own perspective. The shared reality *emerges* when the solver examines all perspectives and derives state that accounts for them.

### Engine = Kernel + Datalog Evaluator

The engine has exactly two mandatory components:

- **Layer 0 Kernel** — Constraint storage, set union merge, CnId generation, Lamport clocks, signatures, authority/validity, retraction/dominance, version vectors. Mechanical algorithms — no inference, no search.
- **Datalog Evaluator** — Stratified, bottom-up, semi-naive. Evaluates rule constraints from the store over facts derived from active constraints, producing the reality.

Everything else — LWW value resolution, Fugue sequence ordering, custom conflict resolution — is expressed as **Datalog rules that travel in the constraint store**. Changing the rules changes the reality, not the engine.

### Six Constraint Types

| Type | Purpose | Retractable? |
|------|---------|-------------|
| `structure` | Permanent node in the reality tree | Never |
| `value` | Content at a node | Yes |
| `retract` | Asserts a constraint should be dominated | Yes (enables undo) |
| `rule` | Datalog rule for solver evaluation | Yes |
| `authority` | Capability grant/revoke | Via revocation only |
| `bookmark` | Named point in causal time | Yes |

### Trivial Merge, Complex Solving

Merge is set union — commutative, associative, idempotent. The solver pipeline does the work:

```
Store (S) → Version Filter (S_V) → Valid(S_V) → Active(Valid(S_V))
  → Structure Index → Projection → Datalog Evaluation → Skeleton → Reality
```

### Time Travel Is Free

The solver is a pure function parameterized by a version vector. `solve(S, V)` computes the reality at any historical moment V. No special mode, no undo stack — just the solver applied to a filtered store.

## Project Status

**Phases 1–5 complete.** The full Unified CCS Engine is implemented and tested. **Plan 005 (Incremental Kernel Pipeline) is in progress** — kernel stages are being incrementalized one by one while preserving the batch pipeline as a correctness oracle.

| Phase | Status | What |
|-------|--------|------|
| 1. Datalog Evaluator | ✅ | Stratified bottom-up evaluation with negation, aggregation, guards, wildcards |
| 2. Kernel Types & Store | ✅ | CnId, Lamport, version vectors, constraint store with O(1) insert |
| 2.5 Prototype Removal | ✅ | Clean break from v0 codebase |
| 3. Authority & Retraction | ✅ | Capability model, validity filter, retraction graph with dominance |
| 3.5 Shared Base Types | ✅ | `CnId`, `Value`, `PeerID` extracted to `base/` |
| 4. Skeleton & Pipeline | ✅ | Full solver pipeline, structure index, projection, skeleton builder |
| 4.5 Datalog-Driven Resolution | ✅ | Datalog as primary path; native solvers as §B.7 fast path |
| 4.6 Pre-Bootstrap Correctness | ✅ | Semantic refs, complete Fugue rules, store O(1), skeleton tests |
| 5. Bootstrap & Integration | ✅ | `createReality()`, default rules, multi-agent sync, 30 integration tests |
| **Plan 005: Incremental Kernel** | 🚧 | Z-set algebra, incremental retraction/structure-index/projection (Phases 1–5 of 9) |

**960 tests across 26 files, all passing.**

See [.plans/002-unified-ccs-engine.md](./.plans/002-unified-ccs-engine.md) for the batch engine plan and [.plans/005-incremental-kernel-pipeline.md](./.plans/005-incremental-kernel-pipeline.md) for the incremental pipeline plan.

## Architecture

```
prism/
├── src/
│   ├── base/                 Shared types and algebra
│   │   ├── types.ts            CnId, Value, PeerID
│   │   ├── result.ts           Result<T, E>
│   │   └── zset.ts             Z-set type and algebra (DBSP foundation)
│   ├── kernel/               Layer 0 — the engine's mandatory kernel
│   │   ├── types.ts            Six constraint types (discriminated union)
│   │   ├── store.ts            CnId-keyed set, insert, set union merge
│   │   ├── agent.ts            Stateful constraint factory (counter, lamport, refs)
│   │   ├── authority.ts        Capability chain replay
│   │   ├── validity.ts         Valid(S): signature + capability check
│   │   ├── retraction.ts       Retraction graph, dominance, Active(S)
│   │   ├── structure-index.ts  Slot identity, parent→child indexes
│   │   ├── projection.ts       Active constraints → Datalog ground facts
│   │   ├── resolve.ts          Datalog derived facts → typed resolution result
│   │   ├── skeleton.ts         Reality tree builder (reads ResolutionResult)
│   │   ├── pipeline.ts         Batch composition root: solve(S, V?) → Reality
│   │   └── incremental/        Incremental pipeline (Plan 005)
│   │       ├── types.ts          StructureIndexDelta, NodeDelta, RealityDelta
│   │       ├── retraction.ts     Persistent retraction graph, dominance cascade
│   │       ├── structure-index.ts  Append-only slot group accumulator
│   │       ├── projection.ts     Bilinear join with orphan resolution
│   │       └── index.ts          Barrel export
│   ├── datalog/              Stratified bottom-up evaluator
│   │   ├── types.ts            Atoms, terms, rules, facts, relations, factKey
│   │   ├── unify.ts            Variable binding, substitution, guards
│   │   ├── stratify.ts         Dependency graph, SCC, stratum ordering
│   │   ├── evaluate.ts         Semi-naive fixed-point evaluation
│   │   └── aggregate.ts        min, max, count, sum
│   ├── solver/               Native optimizations (§B.7, optional)
│   │   ├── lww.ts              Native LWW: max_by(lamport, peer)
│   │   └── fugue.ts            Native Fugue: tree walk over structure(seq)
│   ├── bootstrap.ts          Reality creation + default solver rules (§B.8)
│   └── index.ts              Public API
├── tests/                    960 tests across 26 files
│   ├── base/                 Z-set algebra
│   ├── datalog/              Evaluator, unification, stratification, rules
│   ├── kernel/               Store, agent, authority, pipeline, skeleton, ...
│   │   └── incremental/        Incremental retraction, structure-index, projection
│   ├── solver/               LWW and Fugue equivalence (native == Datalog)
│   └── integration.test.ts   Multi-agent bootstrap, sync, retraction, time travel
└── theory/
    └── unified-engine.md     The authoritative specification
```

## Theoretical Foundation

Prism maintains all CRDT guarantees:

- **Semilattice**: Constraint stores under ∪. Commutative, associative, idempotent.
- **Convergence**: Same constraints → same reality. Always. (Deterministic solver over identical sets.)
- **Monotonic growth**: The store only grows (pre-compaction).
- **Structural permanence**: `structure` constraints are never retracted or compacted.
- **Causal retraction**: You can only retract what you've observed. The retraction graph is always acyclic.
- **Solver independence**: Solvers never see retractions or invalid constraints. `Active(Valid(S))` is the interface.

### From State-Based to Constraint-Based CRDTs

Traditional CRDTs define a state space S, a merge function ⊔ forming a join-semilattice, and monotonic operations. CCS reframes this: the semilattice moves from states to constraint sets (merge = set union), and a deterministic solver maps constraint sets to state. Merge becomes trivial; complexity moves to the solver.

## Installation

```bash
bun install
```

## Development

```bash
bun install          # Install dependencies
bun run test         # Run tests in watch mode
bun run test:run     # Run tests once (960 tests)
bun run typecheck    # TypeScript type checking
```

## Documentation

- [Unified CCS Engine Spec](./theory/unified-engine.md) — The authoritative specification
- [Incremental Theory](./theory/incremental.md) — DBSP foundation for incremental evaluation
- [TECHNICAL.md](./TECHNICAL.md) — Architecture, solver pipeline, design decisions
- [LEARNINGS.md](./LEARNINGS.md) — Discoveries, corrections, and open questions
- [Batch Engine Plan](./.plans/002-unified-ccs-engine.md) — Phased plan with status tracking
- [Incremental Pipeline Plan](./.plans/005-incremental-kernel-pipeline.md) — Plan 005: kernel stage incrementalization

## Related Work

- Concurrent Constraint Programming (Saraswat, 1993)
- CRDTs (Shapiro et al., 2011)
- Fugue (Weidner & Kleppmann, 2023)
- CALM Theorem (Hellerstein, 2010)
- Dedalus (Alvaro et al., 2011)
- DBSP (Budiu & McSherry, 2023)
- Datalog (Ullman, 1988; Apt, Blair & Walker, 1988)

## License

MIT