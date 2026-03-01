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
  | { type: 'seq_element';            // For List/Text elements (Fugue)
      value: unknown;                  // The element value (or character)
      originLeft: OpId | null;         // Left neighbor when inserted
      originRight: OpId | null;        // Right neighbor when inserted
    };

// Note: `before` and `after` assertion types from the original Phase 1 design
// have been removed. Fugue requires both origins in a single assertion; see
// Phase 3 design notes.

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

### Phase 2: Map Container ✅

Implement Map as constraints with LWW conflict resolution.

#### Tasks

1. ✅ **Map solver** (`src/solver/map-solver.ts`)
   - LWW conflict resolution (Lamport, then PeerID tiebreaker)
   - Handle `eq` and `deleted` assertions
   - Return conflicts in SolvedValue

2. ✅ **Map view** (`src/views/map-view.ts`)
   - Typed view over map constraints
   - get(key), has(key), entries()
   - toObject() for full materialization

3. ✅ **Map handle** (`src/handles/map-handle.ts`)
   - High-level API: set(key, value), delete(key)
   - Generates constraints internally
   - Manages Lamport clock

4. ✅ **Equivalence tests** (`tests/equivalence/map-equivalence.test.ts`)
   - Compare Prism Map behavior against reference implementation
   - Concurrent writes with same/different Lamport
   - Delete + set interactions
   - Multi-peer scenarios

#### Tests
- ✅ LWW resolution correctness (32 tests)
- ✅ Conflict detection and reporting
- ✅ Equivalence with loro-ts MapState for key scenarios (28 tests)
- ✅ MapView tests (19 tests)
- ✅ MapHandle tests (21 tests)

---

### Phase 3: List Container ✅

Implement List as constraints using Fugue's tree-based interleaving algorithm.

#### Design: `seq_element` Assertion (Hybrid Approach)

Each list element is represented by a **single constraint** containing all Fugue metadata:

```typescript
interface SeqElementAssertion {
  type: 'seq_element';
  value: unknown;              // The element value
  originLeft: OpId | null;     // Element to the left when this was inserted
  originRight: OpId | null;    // Element to the right when this was inserted
}
```

This captures Fugue's semantics because each insert operation in Fugue records exactly
`(id, value, originLeft, originRight)`. The solver reconstructs the Fugue tree from these
constraints and computes the total ordering using Fugue's interleaving rules.

**Deletion** uses a separate `deleted` constraint at the same element path:
`{ path: [listId, elemId], assertion: { type: 'deleted' } }`

**Why not separate ordering constraints (`before`/`after`)?**

The original plan used separate `after` constraints for ordering. Research into the Fugue
paper (Weidner & Kleppmann 2023) and Weidner's CRDT Survey revealed this is insufficient:

- Fugue requires **both** `originLeft` AND `originRight` for interleaving resolution
- When concurrent inserts share the same `originLeft`, Fugue compares their `originRight`
  positions to determine order (the element whose `originRight` is further left goes first)
- If `originRight` values also match, **lower peer ID goes first** (left)
- The "visited set" algorithm handles transitive cases where origins are nested

A single `seq_element` assertion captures all of this in one constraint per element,
avoiding coordination problems between multiple constraints and making the solver
self-contained.

**Constraint path convention:**
- Element constraint: `[listId, "elem", opIdToString(elemId)]`
- Deletion constraint: `[listId, "elem", opIdToString(elemId)]` with `{ type: 'deleted' }`

#### Fugue Solver Algorithm

The solver implements Fugue's tree-based ordering:

1. **Collect** all `seq_element` constraints for the list
2. **Collect** all `deleted` constraints for the list
3. **Build the Fugue tree**: Each element is a node; `originLeft` determines parent/child
   relationships in the tree structure
4. **Order siblings** using Fugue's interleaving rules:
   - Elements with the same `originLeft` are siblings
   - Among siblings with the same `originRight`, lower peer ID goes first (left)
   - Among siblings with different `originRight`, compare `originRight` positions
     (the one whose `originRight` is further left in the current ordering goes first)
   - The "visited set" walk handles cases where `originLeft` values differ but
     one is a descendant of the other
5. **Filter** deleted elements from the result
6. **Return** the ordered array of values

**Note on peer ID tiebreaker direction:** Fugue uses **lower peer ID goes left**, which
is the opposite of Map LWW (higher peer ID wins). This is intentional — for text,
consistent left-to-right ordering of concurrent inserts is more natural.

**Implementation approach:** For the proof-of-concept, the solver rebuilds the tree from
constraints on each solve. Incremental solving (updating the tree when constraints change)
is a future optimization.

#### Tasks

1. ✅ **Add `seq_element` assertion type** (`src/core/assertions.ts`)
   - `SeqElementAssertion` interface with `value`, `originLeft`, `originRight`
   - Constructor: `seqElement(value, originLeft, originRight)`
   - Type guard: `isSeqElementAssertion()`
   - `before`/`after` assertion types removed (no backward compatibility needed in experiment)

2. ✅ **Fugue tree builder** (`src/solver/fugue.ts`)
   - Build tree from `seq_element` constraints: each element is a node, `originLeft` is parent
   - Represent the virtual "start" and "end" sentinels (null originLeft = child of start)
   - Compute sibling ordering using Fugue interleaving rules:
     - Same `originRight`: lower peer ID goes left
     - Different `originRight`: compare positions (further-left `originRight` goes first)
   - Depth-first traversal to produce total order
   - Position-based comparison for originRight using preliminary sort

3. ✅ **List solver** (`src/solver/list-solver.ts`)
   - Use Fugue tree builder for ordering
   - Handle `deleted` constraints (tombstones — elements exist in tree but excluded from output)
   - Return ordered array with conflict info (e.g., concurrent inserts at same position)

4. ✅ **List view** (`src/views/list-view.ts`)
   - Typed array view over solved list
   - get(index), length, toArray()
   - Iteration support (values, entries, forEach)
   - Functional methods (map, filter, find, findIndex, some, every)
   - ReactiveListView with subscription support

5. ✅ **List handle** (`src/handles/list-handle.ts`)
   - insert(index, value): resolves index to current element positions, computes
     `originLeft`/`originRight` from neighbors, creates `seq_element` constraint
   - delete(index): resolves index to element OpId, creates `deleted` constraint at element path
   - push(value), unshift(value), pop(), shift()
   - insertMany, pushMany, unshiftMany, deleteRange
   - Element path convention: [listPath, opIdToString(elemId)]

6. ✅ **Equivalence tests** (`tests/equivalence/list-equivalence.test.ts`)
   - Uses `loro-crdt` as devDependency for source-of-truth comparisons
   - Basic sequential operations match Loro
   - Concurrent inserts produce deterministic ordering
   - Delete interactions verified
   - Merge commutativity, associativity, idempotence verified

#### Tests
- ✅ Fugue tree construction correctness (37 tests)
- ✅ Sibling ordering with all tiebreaker cases
- ✅ Tombstone handling (deleted elements excluded from output but preserved in tree)
- ✅ Edge cases: empty list, single element, insert at start/end, unicode, various types
- ✅ ListView tests (41 tests)
- ✅ ListHandle tests (46 tests)
- ✅ Equivalence tests vs loro-crdt (27 tests, 20 comparing concurrent merge output)

---

### Phase 4: Text Container 🔴

Text is a List where values are characters, with a string-oriented API.

#### Design

Text reuses the List solver (Fugue) with characters as values. Each character in an
insert becomes a separate `seq_element` constraint. For a multi-character insert like
`insert(pos, "Hello")`, five constraints are created — one per character — where each
character's `originLeft` is the previous character in the same insert (forming a
left-to-right chain), and the first character's `originLeft` is the element at `pos - 1`.

The `originRight` for all characters in a contiguous insert is the element that was at
`pos` when the insert began (the element to the right of the cursor).

This matches how Loro's Fugue tracker handles multi-character inserts: each character
gets its own ID (consecutive counters from the same peer), and origins chain left-to-right.

**Future optimization (out of scope for v0.1):** Run-length encoding — store a span of
consecutive characters from the same peer as a single constraint with a string value
instead of individual character constraints. The solver would need to handle splitting
and slicing of spans, similar to `FugueSpan` in loro-ts.

#### Tasks

1. 🔴 **Text solver** (`src/solver/text-solver.ts`)
   - Thin wrapper over List solver
   - Concatenate solved character values into string output
   - Validate that all `seq_element` values are single characters (or strings for spans)

2. 🔴 **Text view** (`src/views/text-view.ts`)
   - toString(): full text content
   - length: character count
   - slice(start, end): substring extraction

3. 🔴 **Text handle** (`src/handles/text-handle.ts`)
   - insert(pos, text): expands multi-character string into per-character `seq_element`
     constraints with chained `originLeft` values
   - delete(pos, length): creates `deleted` constraints for each character in range
   - Resolves position indices to element OpIds using current solved state

4. 🔴 **Equivalence tests** (`tests/equivalence/text-equivalence.test.ts`)
   - Concurrent inserts produce same interleaving as Loro Text
   - Two users typing at same position concurrently
   - One user types while another deletes at overlapping position
   - Sequential typing from same user produces correct chaining
   - Multi-character insert + concurrent single-character insert

#### Tests
- Text interleaving matches Loro Text/Fugue for concurrent scenarios
- Multi-character insert creates correct origin chains
- Delete range + concurrent insert interactions
- Edge cases: empty text, single char, insert at start/end
- Unicode: each Unicode codepoint is one element (not UTF-16 code units)

---

### Phase 5: Subscriptions & Introspection 🔴

Event system and debugging capabilities.

**Note:** ReactiveMapView and ReactiveListView already implement per-view subscription
with `notifyConstraintsChanged()` and `updateStore()`. Phase 5 adds the centralized
coordinator layer. The existing `SolvedValue` type (`determinedBy`, `conflicts`,
`resolution`) already provides the data for `explain()`; this phase adds the formal API.

#### Tasks

1. 🔴 **Subscription manager** (`src/events/subscription-manager.ts`)
   - Centralized subscription registry (currently each view manages its own subscribers)
   - Subscribe to constraint changes (store-level)
   - Subscribe to path-specific state changes
   - Unsubscribe support

2. 🔴 **State diff computation** (`src/events/state-diff.ts`)
   - Compute before/after state for affected paths
   - Replace current `JSON.stringify` comparison with structural diff
   - Emit ViewChangeEvent with both states

3. 🔴 **Conflict subscription** (`src/events/conflict-events.ts`)
   - Emit when new constraints create/resolve conflicts
   - Include conflict details (which constraints, resolution)

4. 🔴 **Introspection API** (`src/introspection/explain.ts`)
   - explain(path): Why does this path have this value? (wraps existing SolvedValue)
   - getConstraintsFor(path): All constraints affecting a path (wraps existing ask/askPrefix)
   - getConflicts(): All current conflicts across all paths

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

**Note:** Handles currently manage their own internal store + counter + lamport state
via closures. `mergeMapHandles`/`mergeListHandles` update the target handle's store
via `_updateStore()`. PrismDoc will own the single shared store and coordinate all
handles' views against it. The dead `HandleContext` abstraction was removed; PrismDoc
will introduce its own coordination layer.

#### Tasks

1. 🔴 **PrismDoc class** (`src/doc/prism-doc.ts`)
   - Container management (getMap, getList, getText)
   - Single shared constraint store ownership
   - Peer ID and clock management
   - Wire handles so mutations to any container are visible to all views
   - Wire ReactiveViews' `updateStore()` and `notifyConstraintsChanged()` automatically

2. 🔴 **Sync simulation** (`src/sync/local-sync.ts`)
   - Simulated peer-to-peer sync
   - Delta computation and application (uses existing `exportDelta`/`importDelta`)
   - Version vector exchange

3. 🔴 **Integration tests** (`tests/integration.test.ts`)
   - Multi-container documents
   - Sync between simulated peers
   - Full convergence verification

#### Tests
- Multi-peer sync converges
- Container isolation (constraints don't leak)
- Complex editing scenarios
- Mutations on one handle visible through another handle's view on same store

---

## Transitive Effect Analysis

Since this is a greenfield project, there are no existing dependencies to break. However, internal dependencies matter:

```
PrismDoc
  └── ConstraintStore
        └── Constraint
              └── Assertion (eq, exists, deleted, seq_element)
              └── OpId
              └── Path
        └── VersionVector
  └── Solvers
        ├── MapSolver (uses eq, deleted assertions)
        ├── ListSolver → FugueTreeBuilder (uses seq_element, deleted assertions)
        └── TextSolver → ListSolver (thin wrapper)
  └── Views
        └── Solvers (read)
        └── SubscriptionManager
  └── Handles
        └── ConstraintStore (write via tell/tellMany)
        └── Views (read, created fresh per access — no caching)
        └── _updateStore() for merge operations
```

**Key dependency chains:**
- Changing `Assertion` type affects: Constraint → ConstraintStore → All Solvers → All Views
- Changing `Path` representation affects: Constraint → ConstraintStore → All queries
- Changing `SolvedValue` affects: All Solvers → All Views → Introspection
- Adding `seq_element` assertion: Assertion → ListSolver → ListView, TextSolver → TextView
- FugueTreeBuilder is internal to solver layer: changes don't propagate to views/handles

**Mitigation:** Define core types carefully in Phase 1 before building on them.

**Phase 3 cleanup (done):** The `before`/`after` assertion types, `HandleContext`/
`MutableHandleContext`, `SolverRegistry`/`createSolverRegistry`/`createNoOpSolver`, and
`MergeResult`/`ListMergeResult` types have all been removed. The Assertion union is now
`eq | exists | deleted | seq_element` only.

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
- For each container type, compare behavior against `loro-crdt` npm package
- All equivalence tests import `loro-crdt` and compare Prism output vs Loro output
- Concurrent merge scenarios are the priority (single-writer is necessary but not sufficient)
- Peer ID mapping must preserve lexicographic ordering (see Learnings below)

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
│   │   ├── assertions.ts          # Assertion types (eq, exists, deleted, seq_element)
│   │   ├── constraint.ts          # Constraint type and creation
│   │   └── version-vector.ts      # VersionVector operations
│   ├── store/
│   │   └── constraint-store.ts    # Constraint storage and query
│   ├── solver/
│   │   ├── solver.ts              # Solver interface and SolvedValue
│   │   ├── map-solver.ts          # LWW Map solver
│   │   ├── fugue.ts               # Fugue tree builder and interleaving algorithm
│   │   ├── list-solver.ts         # List solver (uses fugue.ts)
│   │   └── text-solver.ts         # Text solver (thin wrapper over list-solver)
│   ├── views/
│   │   ├── view.ts                # View interface (MapView extends; ListView standalone)
│   │   ├── map-view.ts            # Map view + ReactiveMapView
│   │   ├── list-view.ts           # List view + ReactiveListView
│   │   └── text-view.ts           # Text view
│   ├── handles/
│   │   ├── handle.ts              # Handle<T, V> interface (path, view(), get())
│   │   ├── map-handle.ts          # Map mutation API + mergeMapHandles
│   │   ├── list-handle.ts         # List mutation API + mergeListHandles
│   │   └── text-handle.ts         # Text mutation API
│   ├── events/                    # Phase 5
│   │   ├── subscription-manager.ts
│   │   ├── state-diff.ts
│   │   └── conflict-events.ts
│   ├── introspection/             # Phase 5
│   │   ├── explain.ts
│   │   └── inspector.ts
│   ├── doc/                       # Phase 6
│   │   └── prism-doc.ts
│   ├── sync/                      # Phase 6
│   │   └── local-sync.ts
│   └── index.ts                   # Public API exports
├── tests/
│   ├── core/
│   │   └── constraint-store.test.ts
│   ├── solver/
│   │   ├── map-solver.test.ts
│   │   ├── list-solver.test.ts
│   │   └── text-solver.test.ts
│   ├── handles/
│   │   ├── map-handle.test.ts
│   │   └── list-handle.test.ts
│   ├── views/
│   │   ├── map-view.test.ts
│   │   └── list-view.test.ts
│   ├── equivalence/               # All use loro-crdt for comparison
│   │   ├── map-equivalence.test.ts
│   │   ├── list-equivalence.test.ts
│   │   └── text-equivalence.test.ts
│   └── integration/
│       └── multi-peer.test.ts
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── LEARNINGS.md
├── README.md
└── TECHNICAL.md
```

## Resources for Implementation

### Loro-ts Reference Files
- `loro-ts/src/containers/map.ts` — MapState, LWW comparison (`mapValueWins`)
- `loro-ts/src/fugue/tracker.ts` — Fugue insert/delete with origins (lines 100-250: insert logic)
- `loro-ts/src/fugue/crdt-rope.ts` — **Critical**: Fugue interleaving algorithm (lines 548-620)
  - `findInsertPosition()` — the core sibling ordering logic
  - `calculateOrigins()` — how originLeft/originRight are computed from position
  - Uses "visited set" to handle transitive origin relationships
- `loro-ts/src/fugue/span.ts` — FugueSpan structure (originLeft, originRight, status fields)
- `loro-ts/src/core/version.ts` — VersionVector implementation
- `loro-ts/src/core/types.ts` — PeerID, Counter, ID types

### Key Algorithms

**LWW Resolution (Map):** Higher Lamport wins; higher PeerID as tiebreaker (lexicographic).

**Fugue Ordering (List/Text):** Each element has `(id, originLeft, originRight)`. The total
order is determined by building a tree where children share the same `originLeft`:

1. Elements with same `originLeft` are siblings
2. Among siblings with same `originRight`: **lower peer ID goes first** (left)
3. Among siblings with different `originRight`: compare `originRight` positions —
   the one whose `originRight` is further left goes first
4. The "visited set" algorithm (crdt-rope.ts L548-568) handles the case where a
   sibling's `originLeft` is not identical to ours but is a descendant of ours

**Important: Peer ID tiebreaker directions differ between Map and List.**
- Map LWW: higher peer ID wins (standard LWW convention)
- List Fugue: lower peer ID goes left (produces natural left-to-right ordering)

**Version Vector Delta:** For each peer, send constraints where `counter >= vv[peer]`.

### Literature
- **Weidner & Kleppmann (2023)** "The Art of the Fugue: Minimizing Interleaving in
  Collaborative Text Editing" — Defines Fugue and FugueMax algorithms, proves maximal
  non-interleaving property. Key sections: Algorithm 1 (pseudocode), Section 3.2
  (interleaving rules), Section 5 (correctness proofs).
- **Weidner (2023)** "CRDT Survey, Part 2: Semantic Techniques" — Excellent overview of
  list CRDT positions, LWW, unique sets, composition. Key insight: CRDTs as "pure function
  of operation history" — directly maps to Prism's solver model.
- **Weidner (2024)** "CRDT Survey, Part 3: Algorithmic Techniques" — Op-based vs state-based
  CRDTs, vector clocks, optimized unique sets. Confirms that operation history + pure function
  is the canonical semantic model.
- **Saraswat (1993)** Concurrent Constraint Programming — CCP ask/tell model.
- **Shapiro et al. (2011)** CRDTs: Consistency without concurrency control.

## Open Questions (To Resolve During Implementation)

1. **Span optimization for Text**: Should we store character runs as single constraints, or
   individual characters? Start with individual characters for correctness, optimize later.
   The `seq_element` assertion could be extended with a `length` field for spans.

2. **Constraint compaction**: When can we safely garbage collect dominated constraints?
   Defer to future work. For List/Text, tombstones (deleted elements) must be preserved
   in the Fugue tree because they may be referenced as `originLeft`/`originRight` by
   future inserts. Compaction requires knowing that no peer will ever reference a
   tombstone again (requires version vector consensus).

3. **Rich text marks**: Out of scope for v0.1, but design should not preclude them.
   Weidner's inline formatting CRDT (Peritext) uses an append-only log of formatting marks
   with anchors. These could naturally become constraints with mark-specific assertions.

4. ~~**`before`/`after` assertion cleanup**~~: ✅ Done. Removed entirely.

5. **Solver/view caching**: Views currently solve fresh on every access (no caching).
   This is correct but expensive for large lists (Fugue tree rebuild is O(n log n)).
   A future optimization could cache solved state and invalidate on store mutation.
   The previous `constraints.size` proxy for cache invalidation was removed as unsound.
   A proper strategy requires either a store generation counter or explicit dirty tracking.

6. **`askPrefix` is O(n) over all constraints**: The `byPath` index is exact-match only.
   For containers with many elements (especially Text), prefix queries scan all constraints.
   A trie or sorted path index would help but is not needed at current scale.

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

### Phase 2 Complete ✅

Map container fully implemented with views and handles:

- **128 tests passing** total
- MapView provides read-only typed projections with conflict tracking
- ReactiveMapView supports subscriptions with before/after state
- MapHandle provides mutation API (set/delete/setMany/deleteMany)
- Full equivalence tests verify LWW semantics match Loro
- Commutativity, associativity, and idempotence verified

### Phase 3 Complete ✅ (with post-Phase-3 cleanup)

List container fully implemented with Fugue-based ordering:

- **281 tests passing** total (after cleanup pass)
- `seq_element` assertion type added with `originLeft`/`originRight`
- Fugue tree builder implements interleaving algorithm
- List solver uses Fugue for ordering, handles tombstones
- ListView provides array operations and iteration
- ReactiveListView supports subscriptions
- ListHandle provides full mutation API (insert, delete, push, pop, etc.)
- Element path convention: `[listPath, opIdToString(elemId)]` for deletion targeting
- `loro-crdt` added as devDependency for equivalence testing
- **All equivalence tests compare against `loro-crdt` output** (Map and List)
- **20 "vs Loro" tests** verify concurrent merge results match Loro exactly

Post-Phase-3 cleanup (done in same commit):
- Removed deprecated `before`/`after` assertion types and all related code
- Removed dead `HandleContext`/`MutableHandleContext`/`createConstraintFromContext`
- Removed unused `SolverRegistry`/`createSolverRegistry`/`createNoOpSolver`/`ContainerType`
- Removed view caching (was using `constraints.size` as invalidation proxy — unsound)
- `mergeMapHandles`/`mergeListHandles` now mutate target handle via `_updateStore()`
- Handles delegate read ops to `view()` (no more duplicated convenience methods)
- Fixed `ListView`/`Handle` type errors (zero `tsc --noEmit` errors)

Key implementation details:
- Sibling ordering uses preliminary position map to resolve originRight comparisons
- Delete constraints target element paths (not element IDs) to avoid deduplication issues
- Lower peer ID goes left (opposite of Map LWW)
- Equivalence tests use order-preserving `peerIdToNum()` mapping (see Learnings)

### Next Steps

1. Implement Text container as thin wrapper over List (Phase 4)
2. Implement subscriptions and introspection (Phase 5)
3. Implement PrismDoc integration (Phase 6)

### Research Completed

Fugue paper (Weidner & Kleppmann 2023) and Weidner's CRDT Survey (Parts 2 & 3) have been
reviewed. Key findings:

- Fugue's semantics are expressible as constraints: each element's `(id, value, originLeft,
  originRight)` is exactly what a `seq_element` assertion captures
- The solver IS the "pure function of the operation history" — Weidner's canonical CRDT
  semantic model maps directly to CCS
- The interleaving algorithm requires both origins (not just `originLeft`), confirming
  that the original `after`-only plan was insufficient
- Lower peer ID goes left in Fugue (opposite of Map LWW's higher-peer-wins)
- The "visited set" walk in crdt-rope.ts handles transitive origin relationships and
  must be ported faithfully for equivalence

## Documentation Updates

### README.md ✅ (created)
- Project overview and goals
- Installation and usage
- Basic examples
- Link to TECHNICAL.md

### TECHNICAL.md ✅ (created)
- CCS theoretical foundation
- Architecture overview
- Constraint schema design decisions
- Solver algorithms
- Sync protocol
- Future directions

## Learnings (from implementation)

### Peer ID Ordering Must Be Consistent Across Systems for Equivalence

Prism uses string peer IDs compared lexicographically. Loro uses numeric (BigInt) peer IDs
compared numerically. When Fugue breaks ties by peer ID (same `originLeft` + same
`originRight`), the two systems will disagree unless the numeric IDs preserve the same
relative ordering as the string IDs.

**Solution:** Equivalence tests use `peerIdToNum()` — a function that encodes the first
6 characters of a string as a base-256 number. Because character codes preserve
lexicographic ordering when interpreted as base-256 digits, `peerIdToNum("alice") <
peerIdToNum("bob")` holds. This is only needed for testing; in production, a single
system would use one ID type consistently.

**Implication for Phase 4 (Text):** The same `peerIdToNum()` helper must be used in
text equivalence tests.

### Views Are Stateless Snapshots, Not Live Projections

Views close over the store reference from construction time. Since the store is immutable
(`tell` returns a new store), a view never sees new constraints. Handles work around this
by creating a fresh view on every `.view()` call. This means:

- `handle.view()` is cheap to call but always re-solves
- Holding a view reference across mutations gives stale data (by design)
- ReactiveViews exist for the "notifiable" pattern but require explicit wiring

This is fine for now. PrismDoc (Phase 6) will manage the wiring.

### Caching Requires a Store Generation Counter

The removed cache used `constraints.size` as an invalidation proxy. This was unsound:
if a constraint were ever replaced (same size) or if caching were per-path, a size check
would miss invalidation. A correct approach needs either:

1. A monotonically increasing generation counter on the store (bumped on every `tell`)
2. Explicit dirty-path tracking (set of paths affected since last solve)
3. Structural sharing (persistent data structure) so identity comparison works

Option 1 is simplest and should be added when caching is reintroduced.

### `askPrefix` Will Be the Performance Bottleneck for Text

`askPrefix` scans all constraints in the store and checks `pathStartsWith` for each.
For a 10,000-character text document, that's 10,000+ constraints scanned linearly.
Combined with the O(n log n) Fugue tree rebuild on every solve, this will dominate
latency. Worth noting for Phase 4 design — but correctness first.