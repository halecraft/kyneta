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
  | { type: 'seq_element';              // Sequence element (List/Text via Fugue)
      value: unknown;                    // The element value (or character for Text)
      originLeft: OpId | null;           // Element to the left when this was inserted
      originRight: OpId | null;          // Element to the right when this was inserted
    };
```

**Design decision**: The `seq_element` assertion is a compound type that captures all
information needed for Fugue's interleaving algorithm in a single assertion. An earlier
design used separate `before`/`after` assertions for ordering, but research into the
Fugue paper (Weidner & Kleppmann 2023) revealed this is insufficient: Fugue requires
both `originLeft` AND `originRight` to resolve concurrent insert ordering. The compound
assertion avoids coordination problems between multiple constraints per element.

**Future extensions**:
- Type constraints: `{ type: 'hasType'; typeId: string }`
- Range constraints: `{ type: 'inRange'; min: number; max: number }`
- Reference constraints: `{ type: 'references'; target: Path }`
- Rich text marks: `{ type: 'mark'; key: string; value: unknown; start: Anchor; end: Anchor }`

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

**Constraint representation** (hybrid `seq_element` approach):
- Each element: `{ path: [listId, "elem", elemIdStr], assertion: { type: 'seq_element', value, originLeft, originRight } }`
- Deletion: `{ path: [listId, "elem", elemIdStr], assertion: { type: 'deleted' } }`

Each `seq_element` constraint captures all Fugue metadata in a single assertion:
the element's value, its left origin (the element to the left when inserted), and its
right origin (the element to the right when inserted). This eliminates the need for
separate ordering constraints and ensures the solver has all information needed for
Fugue's interleaving algorithm.

**Why `seq_element` instead of separate `before`/`after` constraints:**

The Fugue paper (Weidner & Kleppmann 2023) and analysis of Loro's implementation
(`loro-ts/src/fugue/crdt-rope.ts` lines 548-620) revealed that Fugue's interleaving
requires **both** `originLeft` AND `originRight` for correct ordering. When concurrent
inserts share the same `originLeft`, Fugue compares their `originRight` positions.
Separate `after` constraints only capture `originLeft`, which is insufficient for
Fugue-equivalent interleaving. A compound `seq_element` assertion avoids coordination
problems between multiple constraints and makes the solver self-contained.

**Algorithm** (Fugue tree-based ordering):
1. Collect all `seq_element` constraints for the list
2. Build a Fugue tree: each element is a node; elements with the same `originLeft`
   are siblings (children of the node identified by `originLeft`)
3. Order siblings using Fugue's interleaving rules:
   - Same `originRight`: **lower peer ID goes first** (left)
   - Different `originRight`: compare `originRight` positions in the current tree
     ordering — the element whose `originRight` is further left goes first
   - "Visited set" walk: when a sibling's `originLeft` differs from ours but is a
     descendant of ours, continue scanning (do not break). This handles transitive
     origin relationships from nested concurrent inserts.
4. Depth-first traversal of the tree produces the total order
5. Filter out elements that have `deleted` constraints
6. Return ordered array of values

**Peer ID tiebreaker direction:** Fugue uses **lower peer ID goes left**, which is the
opposite of Map LWW (higher peer ID wins). This is intentional — for text and lists,
consistent left-to-right ordering of concurrent inserts is more natural. This difference
is confirmed in `loro-ts/src/fugue/crdt-rope.ts` line 590: "Lower peer ID wins (goes
first/left). If existing element has HIGHER peer ID than new content, break (insert
before it)."

**Tombstone preservation:** Deleted elements remain in the Fugue tree because future
inserts from other peers may reference them as `originLeft` or `originRight`. The solver
must maintain tombstones in the tree structure but exclude them from the output array.

**Equivalence**: Matches Loro's Fugue interleaving semantics when the same operations
are applied. The solver is a deterministic function of the constraint set, matching
Weidner's canonical CRDT semantic model ("pure function of the operation history").

**Reference implementation**: Port interleaving logic from
`loro-ts/src/fugue/crdt-rope.ts` `findInsertPosition()` (lines 548-620) and
`calculateOrigins()` (lines 460-530).

### Text Solver

**Implementation**: Thin wrapper over List Solver where each `seq_element` value is a
single character. The solver concatenates the ordered characters into a string.

**Multi-character inserts**: When a user inserts "Hello" at position 3, five `seq_element`
constraints are created — one per character. The characters chain left-to-right:
- First character: `originLeft` = element at position 2, `originRight` = element at position 3
- Second character: `originLeft` = first character's OpId, `originRight` = element at position 3
- Third through fifth: continue the chain

This matches how Loro's Fugue tracker handles multi-character inserts: each character gets
its own ID (consecutive counters from the same peer), and origins chain left-to-right.

**Future optimization**: Run-length encoding — store a span of consecutive characters from
the same peer as a single constraint with a string value. The solver would handle splitting
and slicing of spans, similar to `FugueSpan` in `loro-ts/src/fugue/span.ts`.

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

### Why compound `seq_element` instead of separate `before`/`after`?

**Original design**: Separate `after` assertion for ordering (`{ type: 'after', target: leftOrigin }`).

**Revised to compound `seq_element`** after researching the Fugue paper, because:
1. Fugue requires **both** `originLeft` and `originRight` for interleaving resolution
2. When concurrent inserts share the same `originLeft`, Fugue compares `originRight`
   positions — separate `after` constraints only capture `originLeft`
3. A single compound assertion per element avoids the need to correlate multiple
   constraints and ensures atomicity
4. The solver has all information needed for the Fugue algorithm in one place
5. Matches Fugue's `FugueSpan` structure: `(id, content, originLeft, originRight, status)`

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

2. **Fugue**: Weidner, M. & Kleppmann, M. (2023). "The Art of the Fugue: Minimizing Interleaving in Collaborative Text Editing." IEEE TPDS, vol. 36, no. 11. [arXiv:2305.00583](https://arxiv.org/abs/2305.00583). Defines the Fugue and FugueMax algorithms and proves the maximal non-interleaving property. Key reference for the List/Text solver.

3. **CRDT Survey (Semantic Techniques)**: Weidner, M. (2023). "CRDT Survey, Part 2: Semantic Techniques." [Blog post](https://mattweidner.com/2023/09/26/crdt-survey-2.html). Describes CRDTs as "pure function of operation history" — the canonical semantic model that maps directly to Prism's solver approach. Covers list CRDT positions, LWW, unique sets, composition techniques.

4. **CRDT Survey (Algorithmic Techniques)**: Weidner, M. (2024). "CRDT Survey, Part 3: Algorithmic Techniques." [Blog post](https://mattweidner.com/2023/09/26/crdt-survey-3.html). Covers op-based vs state-based CRDTs, vector clocks (dot IDs), optimized state-based unique sets.

5. **CRDTs**: Shapiro, M., et al. (2011). "Conflict-free Replicated Data Types." SSS 2011.

6. **Delta CRDTs**: Almeida, P. S., et al. (2018). "Delta State Replicated Data Types." Journal of Parallel and Distributed Computing.

7. **Peritext**: Litt, S., et al. (2021). "Peritext: A CRDT for Collaborative Rich Text Editing." Relevant for future rich text mark support.