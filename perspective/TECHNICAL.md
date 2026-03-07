# Prism Technical Documentation

> **Note**: The v0 prototype sections (Architecture, Core Types, Solvers, Constraint Store, etc.) below the "New Architecture" section are retained for historical reference. The authoritative architecture is described in [New Architecture](#new-architecture-unified-ccs-engine) and implemented in Phases 1–4.

## Overview

Prism implements **Convergent Constraint Systems (CCS)**, a theoretical framework for building collaborative data structures where constraints are the source of truth and state is derived through deterministic solving.

## New Architecture (Unified CCS Engine)

The v0 prototype validated the CCS thesis. The new implementation follows the formal spec (`theory/unified-engine.md`) with two mandatory components:

### Engine = Layer 0 Kernel + Datalog Evaluator

**Layer 0 Kernel** (§B.2): Mechanical algorithms — constraint storage, set union merge, CnId generation, Lamport clocks, ed25519 signatures, authority/validity computation, retraction graph and dominance, version vectors, tree skeleton construction. Given the same store, any two correct implementations produce identical results.

**Datalog Evaluator** (§B.3): Stratified, bottom-up, semi-naive fixed-point evaluation with aggregation. Evaluates rule constraints from the store over facts derived from active constraints. LWW and Fugue are Datalog rules that travel in the store — they are not hardcoded algorithms.

**Native Solvers** (§B.7, optional): Host-language LWW and Fugue implementations as performance optimizations. Must produce identical results to the Datalog rules they replace.

### Key Architectural Differences from v0

| Dimension | v0 Prototype | Unified Engine |
|-----------|-------------|----------------|
| Constraint addressing | Path-based (`["profile", "name"]`) | CnId-based (`{peer, counter}` + causal `refs`) |
| Constraint types | 4 assertions (`eq`, `exists`, `deleted`, `seq_element`) | 6 typed constraints (`structure`, `value`, `retract`, `rule`, `authority`, `bookmark`) |
| Solver logic | Hardcoded TypeScript (MapSolver, ListSolver) | Datalog rules in the store; native solvers as optional optimization |
| Deletion | `deleted` assertion at path | `retract` constraint targeting a `value` constraint's CnId |
| Authority | None | Layer 0 capability model with grant/revoke chains |
| Time travel | Not supported | `solve(S, V)` for any version vector V — falls out of architecture |
| Undo/redo | Not supported | Retraction depth (retract-of-retract) |
| Store indexing | By path (byPath Map) | By CnId (hash map) |

### Solver Pipeline (§7.2) — Implemented in Phase 4

The pipeline is a composition of pure functions, each in its own module. `pipeline.ts` is the composition root — it contains no transformation logic.

```
Constraint Store (S), Version Vector (V)
    │
    ▼
S_V = filterByVersion(S, V)          // version-vector.ts — filter to causal moment V
    │
    ▼
Valid(S_V) = computeValid(S_V)        // validity.ts — signature + capability check
    │
    ▼
Active(Valid(S_V)) = computeActive()  // retraction.ts — dominance filter
    │
    ├──→ buildStructureIndex()        // structure-index.ts — slot identity, parent→child indexes
    │         │
    │         ├──→ projectToFacts()   // projection.ts — active constraints → Datalog ground facts
    │         │         │
    │         │         ▼
    │         │    evaluate(rules, facts)  // datalog/evaluate.ts — optional rule evaluation
    │         │
    │         └──→ buildSkeleton()    // skeleton.ts — reality tree with native LWW + Fugue
    │                    │
    ▼                    ▼
                    Reality
```

**Key insight**: The structure index is the shared dependency. It computes slot identity once (grouping Map structures by `(parent, key)`) and serves both `projection.ts` (for Datalog fact emission) and `skeleton.ts` (for tree construction). This avoids redundant joins.

### Slot Identity (§8 — the Map Multi-Structure Case)

When two peers independently create `structure(map, parent=P, key=K)`, they get different CnIds but represent the **same logical slot**. The structure index groups them by `(parent, key)` so that value constraints targeting either structure compete via LWW for the same position in the reality.

Slot identity by policy:
- **Map child**: `map:<parentCnIdKey>:<key>` — multiple structures can share a slot
- **Seq child**: `seq:<ownCnIdKey>` — always unique (CnId identity)
- **Root**: `root:<containerId>`

This is Layer 0 kernel logic (not expressible as a retractable rule) because slot identity derives from policy semantics.

### Projection: Constraints → Datalog Facts

`projection.ts` performs a join between active value constraints and the structure index to emit ground facts with pre-computed slot identity:

| Relation | Columns | Purpose |
|----------|---------|---------|
| `active_value(CnId, Slot, Content, Lamport, Peer)` | 5 | Value resolution by LWW rules |
| `active_structure_seq(CnId, Parent, OriginLeft, OriginRight)` | 4 | Fugue ordering rules |
| `constraint_peer(CnId, Peer)` | 2 | Peer tiebreak in Fugue |

Values targeting unknown structures (orphaned) are excluded from projection but tracked for diagnostics.

### Native Solvers (§B.7)

Native TypeScript implementations of LWW and Fugue that bypass Datalog for performance. They **must** produce identical results to the Datalog rules they replace.

**LWW** (`solver/lww.ts`): Groups value entries by slot, picks winner by `(lamport DESC, peer DESC)`. Equivalence verified against the §B.4 Datalog rules in `tests/solver/lww-equivalence.test.ts`.

**Fugue** (`solver/fugue.ts`): Tree-based sequence ordering adapted from `reference/fugue-v0.ts` for CnId-based constraints. Builds a tree rooted at `originLeft`, sorts siblings by Fugue interleaving rules (same `originRight` → lower peer first; different `originRight` → further-left goes first), depth-first traversal produces total order. Equivalence verified for the simplified sibling-ordering subset in `tests/solver/fugue-equivalence.test.ts`.

### Reality Tree Structure

The skeleton builder produces a `Reality` with a synthetic root node (`__reality__@0`, policy `map`) whose children are the top-level containers keyed by `containerId`. Each container node has:
- `id`: The representative structure constraint's CnId
- `policy`: `map` or `seq`
- `children`: Recursively built child nodes
- `value`: LWW-resolved content (or `undefined` if no active values)

For Map parents, children with a null-resolved value and no sub-children are excluded (null = deleted). For Seq parents, elements without an active value (tombstones) are excluded from visible children.

### Why TypeScript for the Datalog Evaluator

Evaluated Rust WASM crates (ascent, datafrog, crepe) and npm packages (datascript, @datalogui/datalog). All were rejected:

- **Rust proc-macro crates** (ascent, crepe) expand rules at compile time — can't evaluate rules-as-data at runtime
- **datafrog** has no negation or aggregation
- **npm packages** impose their own storage models or are abandoned
- **WASM FFI overhead** (~100-200ns per boundary crossing) is significant for many small facts
- The spec's native solver optimization (§B.7) means the Datalog evaluator handles only the general case; hot paths (LWW, Fugue) bypass it entirely

A custom TypeScript evaluator is ~800-1200 lines with zero external dependencies and full control over the integration surface.

### Shared Base Types (`base/`)

`CnId`, `Value`, `PeerID`, `Counter`, `Lamport`, and `isSafeUint` live in `base/types.ts` — shared by both `datalog/` and `kernel/`. `Result<T,E>` lives in `base/result.ts`. This avoids the duplicate-type drift hazard that existed when Phase 1 (Datalog) defined `CnIdRef` and Phase 2 (kernel) independently defined `CnId`. Since `kernel/types.ts` already imports from `datalog/types.ts` (for `RulePayload`), the "no cross-dependency" premise that originally justified the duplication doesn't hold.

### Authority Gates All Peers

The validity filter (`validity.ts`) checks that every constraint's asserting peer holds the required capability. Only the reality creator has implicit Admin. Other peers need explicit authority grants. This means pipeline tests (and eventually real usage) must include authority constraints granting capabilities to non-creator peers, or their constraints will be silently excluded from the active set.

### Module Dependency DAG

```
base/result.ts, base/types.ts              (leaves — no deps)
         ↑
datalog/types.ts → evaluate.ts             (Datalog layer)
         ↑
kernel/types.ts → cnid, lamport, vv,       (kernel identity/store layer)
  store, agent, signature
         ↑
authority.ts → validity.ts → retraction.ts  (filters)
         ↑
structure-index.ts → projection.ts          (kernel↔Datalog bridge)
                   → skeleton.ts            (tree builder, uses solver/)
         ↑
pipeline.ts                                 (composition root — imports only)
```

---

## v0 Prototype Architecture (Historical)

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
│  - Single shared constraint store ownership                    │
│  - Peer identity and clock management (counter, lamport)       │
│  - Doc-bound handle creation (getMap, getList, getText)        │
│  - Sync coordination (exportDelta, importDelta, merge)         │
│  - Wires SubscriptionManager automatically on mutations        │
└────────────────────────────────┬────────────────────────────────┘
                                 │
       ┌─────────────────────────┼─────────────────────────┐
       │                         │                         │
       ▼                         ▼                         ▼
┌───────────────┐    ┌─────────────────────┐    ┌─────────────────┐
│ConstraintStore│    │      Solvers        │    │ Subscription    │
│               │    │                     │    │ Manager         │
│ - Storage     │    │ - MapSolver (LWW)   │    │                 │
│ - Indexing    │    │ - ListSolver (Fugue) │    │ - Constraint CB │
│ - VV tracking │    │ - (Text uses List)  │    │ - State CB      │
│ - Delta export│    │                     │    │ - Conflict CB   │
│ - Generation  │    │                     │    │                 │
└───────────────┘    └─────────────────────┘    └─────────────────┘
       │                         │                         │
       └─────────────────────────┴─────────────────────────┘
                                 │
       ┌─────────────────────────┼─────────────────────────┐
       │                         │                         │
       ▼                         ▼                         ▼
┌───────────────┐    ┌─────────────────────┐    ┌─────────────────┐
│  Views        │    │   Introspection     │    │   Inspector     │
│               │    │                     │    │                 │
│ - MapView     │    │ - explain(path)     │    │ - exportJSON()  │
│ - ListView    │    │ - getConflicts()    │    │ - getStatistics │
│ - TextView    │    │ - formatExplanation │    │ - dump/summarize│
└───────────────┘    └─────────────────────┘    └─────────────────┘
```

Note: There is no separate TextSolver. TextView uses ListSolver directly and
joins the character values into a string. Text is conceptually `List<char>`.

### Data Flow

1. **Mutation**: User calls `handle.set("key", value)` on a doc-bound handle
2. **Constraint Generation**: PrismDoc creates constraint with current Lamport clock
3. **Tell**: Constraint added to the shared ConstraintStore (immutable; returns new store)
4. **Store Update**: PrismDoc replaces its store reference with the new store
5. **Notification**: PrismDoc calls SubscriptionManager with new constraints + previous state
6. **Emit**: Subscribers receive before/after state change and conflict events
7. **Views**: Fresh views created on demand via `handle.view()` close over the current store

The same flow applies to `importDelta` and `merge`: constraints are applied to the
store, and subscribers are notified with the set of newly-added constraints.

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

### Text (No Separate Solver)

Text has no dedicated solver. `TextView` uses `ListSolver` directly and joins the
character values into a string. This was a deliberate simplification: the original plan
called for a `TextSolver` wrapper, but since the only difference is presentation
(array vs string), the indirection was unnecessary.

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
interface ConstraintStore {
  // Primary storage: all constraints
  readonly constraints: ReadonlyMap<string, Constraint>;  // opIdString -> constraint
  
  // Index: constraints by path (for efficient solving)
  readonly byPath: ReadonlyMap<string, ReadonlySet<string>>;  // pathKey -> opIdStrings
  
  // Version tracking
  readonly versionVector: VersionVector;  // ReadonlyMap<PeerID, Counter>
  
  // Lamport clock
  readonly lamport: Lamport;
  
  // Cache invalidation (monotonically increasing on every mutation)
  readonly generation: number;
}
```

The store is **immutable**: `tell()` and `tellMany()` return a new store. PrismDoc
manages the mutable store reference internally. `tellMany()` avoids cloning when all
constraints are duplicates (generation is not bumped).

### Version Vector Operations

**Tracking**: Each constraint updates the version vector:
```typescript
vv[constraint.id.peer] = max(vv[constraint.id.peer] ?? 0, constraint.id.counter + 1)
```

**Delta computation**: For sync, compute constraints where:
```typescript
constraint.id.counter >= (theirVV[constraint.id.peer] ?? 0)
```

### Caching Strategy

Caching is not yet implemented. Views re-solve on every access. The `generation`
counter on `ConstraintStore` enables correct cache invalidation when caching is added:

```typescript
let cachedGeneration = getGeneration(store);
let cachedValue: T | null = null;

function getValue(): T {
  if (getGeneration(store) !== cachedGeneration) {
    cachedValue = solve(store);
    cachedGeneration = getGeneration(store);
  }
  return cachedValue!;
}
```

An earlier cache used `constraints.size` as invalidation proxy, which was unsound
(same size doesn't mean same content). The generation counter is correct and cheap.

## Sync Protocol

### Sync Mechanisms

PrismDoc supports three sync approaches:

1. **Delta sync**: `exportDelta(theirVV)` / `importDelta(delta)` — sends only unseen constraints
2. **Direct merge**: `doc.merge(other)` — set union of two stores
3. **Bidirectional**: `syncDocs(a, b)` — convenience that exchanges deltas in both directions

```typescript
// Delta sync
const delta = alice.exportDelta(bob.getVersionVector());
bob.importDelta(delta);

// Direct merge
alice.merge(bob);

// Bidirectional convenience
syncDocs(alice, bob);
```

All three approaches fire subscription callbacks on the receiving doc.

### Delta Format

```typescript
interface ConstraintDelta {
  constraints: Constraint[];
  fromVV: VersionVector;  // Sender's VV at time of export
}
```

### Convergence Guarantee

Since merge is constraint union and solve is deterministic:
- Order of delta application doesn't matter
- Duplicate deltas are idempotent (tellMany skips known constraints)
- All replicas converge to same state
- Verified with 3-peer convergence tests and all merge-order permutations

## Subscriptions

Centralized event delivery via `SubscriptionManager`. PrismDoc wires this
automatically—subscribers are notified on local mutations, imports, and merges.

### Event Types

```typescript
interface ConstraintAddedEvent {
  type: "constraint_added";
  constraints: readonly Constraint[];
  affectedPaths: readonly Path[];
  generation: number;
}

interface StateChangedEvent<T> {
  type: "state_changed";
  path: Path;
  before: T | undefined;
  after: T | undefined;
  causingConstraints: readonly Constraint[];
  solved: SolvedValue<T>;
}

interface ConflictEvent {
  type: "conflict_detected" | "conflict_resolved";
  path: Path;
  winner: Constraint | undefined;
  losers: readonly Constraint[];
  resolution: string;
}
```

### Subscription Scopes

- **`onConstraintAdded`**: All constraint additions (store-level)
- **`onStateChanged(path)`**: State changes at an exact path
- **`onStateChangedPrefix(prefix)`**: State changes under a path prefix (includes exact match)
- **`onConflict`**: Conflict detection and resolution events

State change callbacks only fire when the value actually changes (compared via
`JSON.stringify`). Conflict tracking is stateful per path: `conflict_detected` fires
when losers first appear, `conflict_resolved` when they disappear.

## Introspection

Accessed via `doc.introspect()` (IntrospectionAPI) and `doc.inspector()` (ConstraintInspector).

### Explain API

```typescript
interface Explanation<T> {
  path: Path;
  value: T | undefined;
  hasValue: boolean;
  determinedBy: ConstraintInfo | undefined;  // Winning constraint
  conflicts: readonly ConstraintInfo[];       // Losing constraints
  hasConflicts: boolean;
  resolution: string;                         // Human-readable explanation
  allConstraints: readonly ConstraintInfo[];  // All constraints at this path
}

// ConstraintInfo wraps Constraint with display-friendly fields
interface ConstraintInfo {
  id: OpId;
  idString: string;       // e.g. "alice@5"
  peer: string;
  lamport: number;
  assertionType: string;
  value: unknown;
  path: Path;
  pathString: string;
  constraint: Constraint;  // Original object
}
```

Additional methods: `getConstraintsFor(path)`, `getConstraintsUnder(prefix)`,
`getConflicts()` (store-wide conflict report), `hasConflictsAt(path)`,
`formatExplanation()`, `formatConflictReport()`.

### Constraint Inspector

Debug utility for visualizing and exporting constraint store state:

```typescript
inspector.exportSnapshot()    // JSON-serializable StoreSnapshot
inspector.exportJSON()        // String (pretty or compact)
inspector.getStatistics()     // Counts by type, peer, path; max constrained path
inspector.listConstraints()   // All constraints as summary lines
inspector.listConstraintsAt(path)   // Filter by path
inspector.listConstraintsFrom(peer) // Filter by peer
inspector.summarize()         // Human-readable summary string
inspector.dump()              // Detailed constraint dump string
```

Convenience functions: `dumpStore(store)`, `summarizeStore(store)`, `exportStoreJSON(store)`.

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

### Why doc-bound handles instead of standalone handles with shared store?

**Context**: Phases 1-4 used standalone handles (MapHandle, ListHandle, TextHandle) that each
owned their own store reference, counter, and lamport via closures. Merge required explicit
`_updateStore()` calls. This was ergonomically painful and error-prone.

**Decided**: PrismDoc creates lightweight "doc-bound handles" (DocMapHandle, DocListHandle,
DocTextHandle) that delegate all state management to PrismDoc. Handles are thin wrappers
that generate constraints and call `applyConstraint()` on the doc's shared state.

**Benefits**:
1. Mutations via any handle are immediately visible through any other handle or view
2. No `_updateStore()` wiring needed
3. Subscriptions fire automatically on any mutation
4. Single source of truth for counter and lamport (no drift between handles)

The standalone handles still exist and are useful for testing in isolation.

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