# Prism Technical Documentation

## Overview

Prism implements **Convergent Constraint Systems (CCS)**, a theoretical framework for building collaborative data structures where constraints are the source of truth and state is derived through deterministic solving.

## Theoretical Foundation

### From State-Based to Constraint-Based CRDTs

Traditional CRDTs define:
- A state space S
- A merge function ⊔: S × S → S forming a join-semilattice
- Operations that are monotonic (inflationary)

CCS reframes this:
- A constraint space C (all possible constraints)
- Merge is set union: A ∪ B (trivially a semilattice on P(C))
- A deterministic solver: solve: P(C) → S

**Key insight**: The semilattice structure moves from states to constraint sets. Merge becomes trivial; complexity moves to the solver.

### Convergence Proof

**Theorem**: CCS achieves eventual consistency.

**Proof**:
1. Let R₁, R₂ be two replicas with constraint sets C₁, C₂
2. After all constraints are exchanged: C₁ = C₂ = C
3. Since `solve` is deterministic: solve(C₁) = solve(C₂)
4. Therefore both replicas derive the same state. ∎

### Terminology

From Concurrent Constraint Programming (CCP):

| Term | Meaning |
|------|---------|
| **Tell** | Assert a constraint into the store |
| **Ask** | Query if a constraint is entailed |
| **Solve** | Compute state satisfying all constraints |
| **Entailment** | A constraint is entailed if it must hold given other constraints |

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                           PrismDoc                              │
│  - Peer identity and clock management                          │
│  - Container registry                                           │
│  - Sync coordination                                            │
└────────────────────────────────┬────────────────────────────────┘
                                 │
         ┌───────────────────────┼───────────────────────┐
         │                       │                       │
         ▼                       ▼                       ▼
┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
│ ConstraintStore │    │     Solvers     │    │   ViewManager   │
│                 │    │                 │    │                 │
│ - Storage       │    │ - MapSolver     │    │ - Subscriptions │
│ - Indexing      │    │ - ListSolver    │    │ - Diff compute  │
│ - VV tracking   │    │ - TextSolver    │    │ - Caching       │
│ - Delta export  │    │                 │    │                 │
└─────────────────┘    └─────────────────┘    └─────────────────┘
         │                       │                       │
         └───────────────────────┴───────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                          Handles                                │
│  MapHandle, ListHandle, TextHandle                              │
│  - User-facing mutation API                                     │
│  - Constraint generation                                        │
│  - View projection                                              │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Mutation**: User calls `handle.set("key", value)`
2. **Constraint Generation**: Handle creates constraint with current Lamport clock
3. **Tell**: Constraint added to ConstraintStore
4. **Notification**: SubscriptionManager notified of new constraint
5. **Solve**: Affected paths re-solved (or cache invalidated)
6. **Emit**: Subscribers receive before/after state change events

## Core Types

### Identity

```typescript
type PeerID = string;      // Human-readable, e.g., "alice", "peer-1"
type Counter = number;     // Monotonically increasing per-peer
type Lamport = number;     // Logical clock for ordering

interface OpId {
  peer: PeerID;
  counter: Counter;
}
```

**Design decision**: PeerID as string (not bigint like Loro) for debugging clarity in this experimental phase.

### Paths

```typescript
type PathSegment = string | number;
type Path = PathSegment[];

// Examples:
// ["users", "alice", "name"]     - Map key access
// ["todos", 0, "text"]           - List index access (logical, not physical)
// ["document", "content"]        - Text container
```

**Design decision**: Array paths (not dot-separated strings) for:
- Type safety
- No escaping needed for keys containing dots
- Natural nesting representation

### Assertions

```typescript
type Assertion =
  | { type: 'eq'; value: unknown }      // Path equals value
  | { type: 'exists' }                   // Path exists (for containers)
  | { type: 'deleted' }                  // Path is deleted (tombstone)
  | { type: 'after'; target: OpId }      // Ordering: this comes after target
  | { type: 'before'; target: OpId };    // Ordering: this comes before target
```

**Design decision**: Minimal assertion types to start. Future extensions:
- Type constraints: `{ type: 'hasType'; typeId: string }`
- Range constraints: `{ type: 'inRange'; min: number; max: number }`
- Reference constraints: `{ type: 'references'; target: Path }`

### Constraints

```typescript
interface Constraint {
  id: OpId;                 // Unique identifier
  path: Path;               // What this constrains
  assertion: Assertion;     // The constraint itself
  metadata: {
    peer: PeerID;           // Author
    lamport: Lamport;       // Logical timestamp
    wallTime?: number;      // Optional wall clock (debugging only)
  };
}
```

**Design decision**: ID is `OpId` (peer + counter), not content-addressed hash. Rationale:
- We need version vectors for sync anyway
- Deduplication based on content semantics is not yet well-understood
- Peer+counter provides clear provenance

## Solvers

### Solver Interface

```typescript
interface SolvedValue {
  value: unknown;                    // The resolved value
  determinedBy: Constraint;          // Winning constraint
  conflicts: Constraint[];           // Constraints that lost
}

interface Solver {
  solve(constraints: Constraint[], path: Path): SolvedValue | undefined;
}
```

### Map Solver (LWW)

**Algorithm**:
1. Filter constraints for exact path match
2. Separate into value assertions (`eq`) and deletions (`deleted`)
3. Find winner: highest Lamport, then highest PeerID as tiebreaker
4. If winner is `deleted`, return undefined
5. Otherwise return value with conflict information

**Equivalence**: Matches Loro's MapState LWW semantics exactly.

### List Solver (Fugue-style)

**Constraint representation**:
- Each element: `{ path: [listId, elemId], assertion: { type: 'eq', value } }`
- Ordering: `{ path: [listId, elemId], assertion: { type: 'after', target: leftOrigin } }`
- Deletion: `{ path: [listId, elemId], assertion: { type: 'deleted' } }`

**Algorithm**:
1. Collect all element constraints for the list
2. Build partial order graph from `after` constraints
3. Topological sort with Fugue tiebreaking:
   - When ambiguous (multiple elements after same origin), use:
     - First: compare peer ID (higher wins)
     - Then: compare counter (higher wins)
4. Filter out deleted elements
5. Return ordered array of values

**Equivalence**: Matches Loro's Fugue interleaving semantics.

### Text Solver

**Implementation**: Thin wrapper over List Solver where values are characters (or strings for optimization).

**Future optimization**: Run-length encoding for character spans.

## Constraint Store

### Storage Strategy

```typescript
class ConstraintStore {
  // Primary storage: all constraints
  private constraints: Map<string, Constraint>;  // id -> constraint
  
  // Index: constraints by path (for efficient solving)
  private byPath: Map<string, Set<string>>;      // pathKey -> constraint ids
  
  // Version tracking
  private versionVector: Map<PeerID, Counter>;
  
  // Lamport clock
  private lamport: Lamport;
}
```

### Version Vector Operations

**Tracking**: Each constraint updates the version vector:
```typescript
vv[constraint.id.peer] = max(vv[constraint.id.peer] ?? 0, constraint.id.counter + 1)
```

**Delta computation**: For sync, compute constraints where:
```typescript
constraint.id.counter >= (theirVV[constraint.id.peer] ?? 0)
```

### Caching Strategy (v0.1)

Simple memoization with full invalidation:

```typescript
class CachedSolver {
  private cache: Map<string, SolvedValue>;
  
  solve(path: Path): SolvedValue {
    const key = pathToKey(path);
    if (this.cache.has(key)) return this.cache.get(key)!;
    
    const result = this.solver.solve(this.store.getConstraints(path), path);
    this.cache.set(key, result);
    return result;
  }
  
  invalidate(affectedPaths: Path[]): void {
    for (const path of affectedPaths) {
      this.cache.delete(pathToKey(path));
    }
  }
}
```

**Future optimization**: Incremental solving—update cache directly when possible.

## Sync Protocol

### Local Simulation

For this experimental phase, sync is simulated locally:

```typescript
function sync(doc1: PrismDoc, doc2: PrismDoc): void {
  // Bidirectional delta exchange
  const delta1to2 = doc1.exportDelta(doc2.versionVector());
  const delta2to1 = doc2.exportDelta(doc1.versionVector());
  
  doc2.importDelta(delta1to2);
  doc1.importDelta(delta2to1);
}
```

### Delta Format

```typescript
interface Delta {
  constraints: Constraint[];
  fromVV: VersionVector;  // Sender's VV at time of export
}
```

### Convergence Guarantee

Since merge is constraint union and solve is deterministic:
- Order of delta application doesn't matter
- Duplicate deltas are idempotent
- All replicas converge to same state

## Subscriptions

### Event Types

```typescript
// State change event
interface StateChangeEvent<T> {
  path: Path;
  before: T | undefined;
  after: T | undefined;
  triggeredBy: Constraint[];
}

// Constraint change event
interface ConstraintChangeEvent {
  added: Constraint[];
  // Future: retracted: Constraint[];
}

// Conflict event
interface ConflictEvent {
  path: Path;
  winner: Constraint;
  losers: Constraint[];
  resolution: string;  // Human-readable explanation
}
```

### Subscription Scopes

- **Document-level**: All changes
- **Path-level**: Changes to specific path (exact or prefix match)
- **Constraint-level**: Raw constraint additions

## Introspection

### Explain API

```typescript
interface Explanation {
  path: Path;
  currentValue: unknown;
  determinedBy: Constraint;
  conflicts: Constraint[];
  resolution: string;
  allConstraints: Constraint[];  // All constraints affecting this path
}

function explain(store: ConstraintStore, path: Path): Explanation;
```

### Constraint Inspector

For debugging, export full constraint store state:

```typescript
interface InspectorSnapshot {
  constraints: Constraint[];
  versionVector: Record<PeerID, Counter>;
  solvedPaths: Array<{
    path: Path;
    value: unknown;
    constraintCount: number;
  }>;
}
```

## Design Decisions Log

### Why not content-addressed constraints?

**Considered**: Hash constraint content for ID, enabling automatic deduplication.

**Decided against** because:
1. Version vectors already needed for sync
2. "Same content = same constraint" semantics unclear (is re-asserting the same value intentional?)
3. Simpler to start with explicit IDs

**May revisit** if deduplication becomes important.

### Why Lamport clocks, not HLC?

**Considered**: Hybrid Logical Clocks for better wall-clock correlation.

**Decided** Lamport is sufficient because:
1. Wall time only needed for debugging (optional field)
2. Simpler implementation
3. HLC adds complexity without clear benefit for our use case

### Why separate assertion types for `before`/`after`?

**Considered**: Single `order: { left: OpId, right: OpId }` constraint.

**Decided** separate types because:
1. Matches Fugue's left-origin model
2. Simpler constraint generation on insert
3. More natural for the constraint language

### Why typed views instead of typed constraints?

**Decided**: Constraints are untyped; types are added at the view layer.

**Rationale**: Aligns with CCS philosophy—constraints are primitive assertions, interpretation (including types) is separate. This also enables schema evolution without changing stored constraints.

## Future Work

### Constraint Compaction

When can we safely garbage collect constraints?

**Safe cases**:
- For LWW Map: Keep only winning constraint per path (if no active conflicts needed)
- For List: Tombstones can be compacted after all peers have seen them

**Challenges**:
- Must ensure all replicas compact identically
- Introspection may want historical constraints
- Conflicts become invisible after compaction

### Rich Text Marks

Text styling (bold, italic, etc.) would require:
- Mark constraints: `{ path: [textId, 'mark', markId], assertion: { type: 'markRange', start: OpId, end: OpId, style: Style } }`
- Mark anchor resolution in solver
- Mark expansion semantics (bold-like vs link-like)

### Cross-Container Constraints

Constraints spanning multiple containers:
- Referential integrity: "If X exists, Y must exist"
- Computed values: "Z = sum of all elements in list L"
- Mutual exclusion: "At most one of A, B, C can be true"

### Intention Preservation

Higher-level constraints capturing user intent:
- "Lowercase this selection" vs "delete + insert lowercase"
- "Move element" vs "delete + insert"
- Scoped intentions with violation policies

## References

1. **Concurrent Constraint Programming**: Saraswat, V. A. (1993). *Concurrent Constraint Programming*. MIT Press.

2. **Fugue**: Weidner, M., et al. (2023). "The Art of the Fugue: Minimizing Interleaving in Collaborative Text Editing."

3. **CRDTs**: Shapiro, M., et al. (2011). "Conflict-free Replicated Data Types." SSS 2011.

4. **Delta CRDTs**: Almeida, P. S., et al. (2018). "Delta State Replicated Data Types." Journal of Parallel and Distributed Computing.