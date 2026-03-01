# Prism Foundation Plan

## Background

### What is Prism?

Prism is an experimental implementation of **Convergent Constraint Systems (CCS)**—a new way of thinking about CRDTs where:

1. **Constraints are truth, state is derived**: Instead of replicating state and defining merge functions, we replicate constraints and derive state through a deterministic solver
2. **Merge is trivial**: Constraint sets merge via set union (commutative, associative, idempotent)—all complexity moves to the solver
3. **Schema as interpretation**: The same constraints can be viewed through different schemas without data migration
4. **Introspectable**: We can ask "why is this value X?" and get an answer tracing back to constraints

### Theoretical Foundation

CCS maintains all CRDT guarantees:
- **Semilattice structure**: On constraint sets (P(C), ⊆, ∪) rather than states
- **Convergence**: Same constraints → same solved state (deterministic solver)
- **Eventual consistency**: Guaranteed by constraint union commutativity

Key terminology (from Concurrent Constraint Programming):
- **Tell**: Assert a constraint into the store
- **Ask**: Query if a constraint is entailed by the store
- **Solve**: Compute the state that satisfies all constraints

### Relationship to Loro

Prism is a **standalone experiment**—no code sharing with Loro. The goal is to prove CCS concepts can achieve equivalent merge semantics for Map, List, and Text containers, validating the theoretical framework before considering integration.

## Problem Statement

We need to build a minimal but rigorous implementation of CCS that:

1. Demonstrates constraint-based merge produces identical results to state-based CRDTs
2. Proves the approach works for non-trivial data structures (List, Text with ordering)
3. Provides a foundation for exploring schema evolution, IVM, and intention preservation

## Success Criteria

1. **Map equivalence**: Prism Map with LWW resolution produces identical results to Loro Map for any sequence of concurrent operations
2. **List equivalence**: Prism List with Fugue-style ordering produces identical interleaving to Loro List
3. **Text equivalence**: Prism Text produces identical merge results to Loro Text
4. **Introspection works**: Can query "why" any value has its current state
5. **Subscriptions work**: Can subscribe to state changes (before/after), constraint changes, and conflicts
6. **Tests pass**: Deterministic correctness tests demonstrate convergence properties

## Gap Analysis

### What Exists
- Theoretical framework from discussion (CCS, constraint union, deterministic solving)
- Reference implementation in loro-ts for comparison (Fugue tracker, MapState, etc.)
- Clear API direction (constraint-native with typed views)

### What's Missing
- Everything—this is greenfield

## Core Type Definitions

```typescript
// === Identity ===
type PeerID = string;  // Human-readable for debugging
type Counter = number;
type Lamport = number;

interface OpId {
  peer: PeerID;
  counter: Counter;
}

// === Paths ===
type PathSegment = string | number;
type Path = PathSegment[];

// === Version Tracking ===
type VersionVector = Map<PeerID, Counter>;

// === Assertions ===
type Assertion =
  | { type: 'eq'; value: unknown }
  | { type: 'exists' }
  | { type: 'deleted' }
  | { type: 'before'; target: OpId }   // For ordering
  | { type: 'after'; target: OpId };   // For ordering

// === Constraints ===
interface Constraint {
  id: OpId;                    // Unique identifier (peer + counter)
  path: Path;                  // What this constrains
  assertion: Assertion;        // The constraint itself
  metadata: {
    peer: PeerID;
    lamport: Lamport;
    wallTime?: number;         // Optional, for debugging
  };
}

// === Solver Interface ===
interface Solver {
  solve(constraints: Constraint[], path: Path): SolvedValue;
}

interface SolvedValue {
  value: unknown;
  determinedBy: Constraint;
  conflicts: Constraint[];
}

// === View Interface ===
interface View<T> {
  get(): T;
  subscribe(callback: (event: ViewChangeEvent<T>) => void): () => void;
}

interface ViewChangeEvent<T> {
  before: T;
  after: T;
  constraints: {
    added: Constraint[];
    // Future: retracted: Constraint[];
  };
}
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         PrismDoc                            │
│  - Manages peers, version vectors, constraint store        │
│  - Coordinates tell/ask/solve                              │
└─────────────────────────┬───────────────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        │                 │                 │
        ▼                 ▼                 ▼
┌───────────────┐ ┌───────────────┐ ┌───────────────┐
│ ConstraintStore│ │    Solver     │ │  ViewManager  │
│ - Storage      │ │ - MapSolver   │ │ - Subscriptions│
│ - Query by path│ │ - ListSolver  │ │ - Projections  │
│ - Version track│ │ - TextSolver  │ │ - Diff compute │
└───────────────┘ └───────────────┘ └───────────────┘
```

## Phases and Tasks

### Phase 1: Core Infrastructure ✅

Foundation types, constraint store, and basic solver framework.

#### Tasks

1. ✅ **Project setup**
   - Initialize bun project with TypeScript
   - Configure tsconfig for strict mode, ESM
   - Set up vitest for testing
   - Create directory structure

2. ✅ **Core types** (`src/core/types.ts`)
   - PeerID, Counter, Lamport, OpId
   - Path, PathSegment
   - VersionVector with comparison operations

3. ✅ **Assertion types** (`src/core/assertions.ts`)
   - Assertion union type
   - Assertion equality comparison
   - Assertion helpers (eq, exists, deleted, before, after)

4. ✅ **Constraint type** (`src/core/constraint.ts`)
   - Constraint interface
   - Constraint creation helpers
   - Constraint ID generation

5. ✅ **Constraint store** (`src/store/constraint-store.ts`)
   - Add constraint (tell)
   - Query constraints by path (ask)
   - Merge constraint stores (union)
   - Version vector tracking
   - Delta computation (constraints since VV)

6. ✅ **Solver interface** (`src/solver/solver.ts`)
   - Solver interface definition
   - SolvedValue type with conflict tracking
   - Solver registry pattern

#### Tests
- ✅ Constraint store: add, query, merge, delta computation (28 tests)
- ✅ Version vector: comparison, merge
- ✅ Constraint equality and deduplication

---

### Phase 2: Map Container 🟡

Implement Map as constraints with LWW conflict resolution.

#### Tasks

1. ✅ **Map solver** (`src/solver/map-solver.ts`)
   - LWW conflict resolution (Lamport, then PeerID tiebreaker)
   - Handle `eq` and `deleted` assertions
   - Return conflicts in SolvedValue

2. 🔴 **Map view** (`src/views/map-view.ts`)
   - Typed view over map constraints
   - get(key), has(key), entries()
   - toObject() for full materialization

3. 🔴 **Map handle** (`src/handles/map-handle.ts`)
   - High-level API: set(key, value), delete(key)
   - Generates constraints internally
   - Manages Lamport clock

4. 🔴 **Equivalence tests** (`tests/map-equivalence.test.ts`)
   - Compare Prism Map behavior against reference implementation
   - Concurrent writes with same/different Lamport
   - Delete + set interactions
   - Multi-peer scenarios

#### Tests
- ✅ LWW resolution correctness (32 tests)
- ✅ Conflict detection and reporting
- ✅ Equivalence with loro-ts MapState for key scenarios

---

### Phase 3: List Container 🔴

Implement List with ordering constraints (Fugue-style).

#### Tasks

1. 🔴 **List constraint design** (`src/containers/list-constraints.ts`)
   - Element existence: `{ path: [listId, elemId], assertion: { type: 'eq', value } }`
   - Ordering: `{ path: [listId, elemId], assertion: { type: 'after', target: leftOrigin } }`
   - Deletion: `{ path: [listId, elemId], assertion: { type: 'deleted' } }`

2. 🔴 **List solver** (`src/solver/list-solver.ts`)
   - Build partial order from before/after constraints
   - Topological sort with Fugue-style tiebreaking
   - Handle deletions (tombstones)

3. 🔴 **List view** (`src/views/list-view.ts`)
   - Typed array view
   - get(index), length, toArray()
   - Iteration support

4. 🔴 **List handle** (`src/handles/list-handle.ts`)
   - insert(index, value), delete(index)
   - push(value), pop()
   - Generates ordering constraints from current state

5. 🔴 **Equivalence tests** (`tests/list-equivalence.test.ts`)
   - Concurrent inserts at same position
   - Interleaving behavior matches Fugue
   - Delete + insert interactions

#### Tests
- Ordering constraint resolution
- Fugue interleaving equivalence
- Tombstone handling

---

### Phase 4: Text Container 🔴

Text as character-level List with string optimizations.

#### Tasks

1. 🔴 **Text solver** (`src/solver/text-solver.ts`)
   - Reuse List solver logic
   - String concatenation of solved characters
   - Run-length encoding for efficiency (optional optimization)

2. 🔴 **Text view** (`src/views/text-view.ts`)
   - toString()
   - length
   - slice(start, end)

3. 🔴 **Text handle** (`src/handles/text-handle.ts`)
   - insert(pos, text)
   - delete(pos, length)
   - Generates per-character constraints (or spans)

4. 🔴 **Equivalence tests** (`tests/text-equivalence.test.ts`)
   - Concurrent inserts produce same interleaving as Loro
   - Various edit patterns
   - Unicode handling

#### Tests
- Text interleaving matches Loro Text/Fugue
- Multi-character insert/delete
- Edge cases (empty, single char, etc.)

---

### Phase 5: Subscriptions & Introspection 🔴

Event system and debugging capabilities.

#### Tasks

1. 🔴 **Subscription manager** (`src/events/subscription-manager.ts`)
   - Subscribe to constraint changes
   - Subscribe to path-specific state changes
   - Unsubscribe support

2. 🔴 **State diff computation** (`src/events/state-diff.ts`)
   - Compute before/after state for affected paths
   - Emit ViewChangeEvent with both states

3. 🔴 **Conflict subscription** (`src/events/conflict-events.ts`)
   - Emit when new constraints create/resolve conflicts
   - Include conflict details (which constraints, resolution)

4. 🔴 **Introspection API** (`src/introspection/explain.ts`)
   - explain(path): Why does this path have this value?
   - getConstraintsFor(path): All constraints affecting a path
   - getConflicts(): All current conflicts

5. 🔴 **Constraint inspector** (`src/introspection/inspector.ts`)
   - Debug utility for visualizing constraint store
   - Export to JSON for external tooling

#### Tests
- Subscription callbacks fire correctly
- Before/after state accuracy
- Conflict detection and resolution reporting

---

### Phase 6: PrismDoc Integration 🔴

Top-level document API tying everything together.

#### Tasks

1. 🔴 **PrismDoc class** (`src/doc/prism-doc.ts`)
   - Container management (getMap, getList, getText)
   - Peer ID and clock management
   - Constraint store ownership

2. 🔴 **Sync simulation** (`src/sync/local-sync.ts`)
   - Simulated peer-to-peer sync
   - Delta computation and application
   - Version vector exchange

3. 🔴 **Integration tests** (`tests/integration.test.ts`)
   - Multi-container documents
   - Sync between simulated peers
   - Full convergence verification

#### Tests
- Multi-peer sync converges
- Container isolation (constraints don't leak)
- Complex editing scenarios

---

## Transitive Effect Analysis

Since this is a greenfield project, there are no existing dependencies to break. However, internal dependencies matter:

```
PrismDoc
  └── ConstraintStore
        └── Constraint
              └── Assertion
              └── OpId
              └── Path
        └── VersionVector
  └── Solvers (Map, List, Text)
        └── Constraint (read)
        └── SolvedValue
  └── Views
        └── Solvers (read)
        └── SubscriptionManager
  └── Handles
        └── ConstraintStore (write)
        └── Views (read)
```

**Key dependency chains:**
- Changing `Assertion` type affects: Constraint → ConstraintStore → All Solvers → All Views
- Changing `Path` representation affects: Constraint → ConstraintStore → All queries
- Changing `SolvedValue` affects: All Solvers → All Views → Introspection

**Mitigation:** Define core types carefully in Phase 1 before building on them.

## Testing Strategy

### Unit Tests (per module)
- Constraint creation and comparison
- Version vector operations
- Each solver in isolation

### Property Tests
- Constraint union is commutative: `merge(A, B) === merge(B, A)`
- Constraint union is associative: `merge(merge(A, B), C) === merge(A, merge(B, C))`
- Constraint union is idempotent: `merge(A, A) === A`
- Solve is deterministic: `solve(constraints) === solve(shuffle(constraints))`

### Equivalence Tests
- For each container type, compare behavior against loro-ts reference
- Use shared test vectors where possible

### Integration Tests
- Multi-peer scenarios with simulated network
- Convergence verification after sync

## Directory Structure

```
prism/
├── .plans/
│   └── 001-prism-foundation.md    # This plan
├── src/
│   ├── core/
│   │   ├── types.ts               # PeerID, Counter, Lamport, OpId, Path
│   │   ├── assertions.ts          # Assertion types and helpers
│   │   ├── constraint.ts          # Constraint type and creation
│   │   └── version-vector.ts      # VersionVector operations
│   ├── store/
│   │   └── constraint-store.ts    # Constraint storage and query
│   ├── solver/
│   │   ├── solver.ts              # Solver interface
│   │   ├── map-solver.ts          # LWW Map solver
│   │   ├── list-solver.ts         # Ordered List solver
│   │   └── text-solver.ts         # Text solver
│   ├── views/
│   │   ├── view.ts                # View interface
│   │   ├── map-view.ts            # Map view
│   │   ├── list-view.ts           # List view
│   │   └── text-view.ts           # Text view
│   ├── handles/
│   │   ├── map-handle.ts          # Map mutation API
│   │   ├── list-handle.ts         # List mutation API
│   │   └── text-handle.ts         # Text mutation API
│   ├── events/
│   │   ├── subscription-manager.ts
│   │   ├── state-diff.ts
│   │   └── conflict-events.ts
│   ├── introspection/
│   │   ├── explain.ts
│   │   └── inspector.ts
│   ├── doc/
│   │   └── prism-doc.ts           # Top-level document
│   ├── sync/
│   │   └── local-sync.ts          # Simulated sync
│   └── index.ts                   # Public API exports
├── tests/
│   ├── core/
│   │   ├── constraint-store.test.ts
│   │   └── version-vector.test.ts
│   ├── solver/
│   │   ├── map-solver.test.ts
│   │   ├── list-solver.test.ts
│   │   └── text-solver.test.ts
│   ├── equivalence/
│   │   ├── map-equivalence.test.ts
│   │   ├── list-equivalence.test.ts
│   │   └── text-equivalence.test.ts
│   └── integration/
│       └── multi-peer.test.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
└── TECHNICAL.md
```

## Resources for Implementation

### Loro-ts Reference Files
- `loro-ts/src/containers/map.ts` - MapState, LWW comparison
- `loro-ts/src/fugue/tracker.ts` - Fugue insert/delete with origins
- `loro-ts/src/fugue/span.ts` - FugueSpan structure
- `loro-ts/src/core/version.ts` - VersionVector implementation
- `loro-ts/src/core/types.ts` - PeerID, Counter, ID types

### Key Algorithms
- **LWW Resolution**: Higher Lamport wins; PeerID as tiebreaker
- **Fugue Ordering**: Left/right origins determine position; peer/counter as tiebreaker for concurrent inserts at same position
- **Version Vector Delta**: For each peer, send constraints where `counter > vv[peer]`

### Literature
- Concurrent Constraint Programming (Saraswat)
- Fugue paper (Weidner et al.) for sequence CRDT interleaving
- CRDTs: Consistency without concurrency control (Shapiro et al.)

## Open Questions (To Resolve During Implementation)

1. **Span optimization for Text**: Should we store character runs as single constraints, or individual characters? Start with characters, optimize later.

2. **Constraint compaction**: When can we safely garbage collect dominated constraints? Defer to future work.

3. **Rich text marks**: Out of scope for v0.1, but design should not preclude them.

## Changeset

Not applicable—new project, no changelog to update.

## Implementation Progress

### Phase 1 Complete ✅

All core infrastructure is implemented and tested:

- **60 tests passing** across constraint store and map solver
- Core types fully implemented with comprehensive utilities
- Constraint store supports tell/ask/merge/delta operations
- Version vector tracking works correctly
- Map solver implements LWW with full conflict tracking

### Next Steps

1. Implement Map view and handle (remaining Phase 2)
2. Implement List container with Fugue-style ordering (Phase 3)
3. Implement Text container (Phase 4)

## Documentation Updates

### README.md (to create)
- Project overview and goals
- Installation and usage
- Basic examples
- Link to TECHNICAL.md

### TECHNICAL.md (to create)
- CCS theoretical foundation
- Architecture overview
- Constraint schema design decisions
- Solver algorithms
- Sync protocol
- Future directions