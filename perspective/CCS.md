> I'd like to explore constraint-based perspective on CRDTs and collaboration in general. What if we re-envision our current CRDTs (Text, List, MovableList, Map) as expressing constraints? What would that look like?

This is a beautiful reframing. Let me think through what it means to view CRDTs not as "data structures with merge functions" but as "constraint systems with satisfaction algorithms."

## The Paradigm Shift

Current view:
> "A CRDT is a data structure where concurrent operations converge to the same state."

Constraint view:
> "A CRDT is a constraint system where each operation adds constraints, and the state is the minimal satisfying assignment."

```/dev/null/paradigm-shift.ts#L1-30
// Current mental model:
// State × Operation → State'
// Merge: State × State → State
// Convergence: Merge(Apply(S, op1), Apply(S, op2)) = Merge(Apply(S, op2), Apply(S, op1))

// Constraint mental model:
// Each operation adds constraints to a growing constraint set
// State = Solve(Constraints)
// Convergence: Same constraints → Same solution (deterministic solver)

// The key insight:
// What we call "CRDT merge semantics" is actually
// "how to combine constraints and find a satisfying assignment"
```

## Text/List as Constraints

Let's start with Fugue/RGA-style text. What constraints do operations express?

```/dev/null/text-constraints.ts#L1-80
// Current view: Insert(id, char, leftOrigin, rightOrigin)
// Creates an element that appears between leftOrigin and rightOrigin

// Constraint view:
interface TextConstraints {
  // Existence constraints: "This character exists in the document"
  exists: Map<ElementId, {
    char: string;
    assertedBy: OpId;
  }>;
  
  // Deletion constraints: "This character should not appear"
  deleted: Map<ElementId, {
    assertedBy: OpId;
  }>;
  
  // Ordering constraints: "A must come before B"
  // (These form a partial order)
  before: Array<{
    left: ElementId;
    right: ElementId;
    assertedBy: OpId;
    // Origin information becomes constraint metadata
    isLeftOrigin: boolean;  // "A was the left neighbor when B was inserted"
    isRightOrigin: boolean; // "B was the right neighbor when A was inserted"
  }>;
}

// An insert operation adds constraints:
function insertAsConstraints(
  op: InsertOp
): Constraint[] {
  return [
    // "This element exists"
    { type: 'exists', element: op.id, char: op.char },
    
    // "This element comes after its left origin"
    { type: 'before', left: op.leftOrigin, right: op.id, isLeftOrigin: true },
    
    // "This element comes before its right origin"
    { type: 'before', left: op.id, right: op.rightOrigin, isRightOrigin: true },
  ];
}

// A delete operation adds a constraint:
function deleteAsConstraints(op: DeleteOp): Constraint[] {
  return [
    { type: 'deleted', element: op.target }
  ];
}

// The "state" is a solution to:
// 1. Find a total order consistent with all 'before' constraints
// 2. Include characters from 'exists' that aren't in 'deleted'
// 3. Render in that order

// Fugue's interleaving semantics become:
// "When constraints are ambiguous (A < C and B < C, but no A-B relation),
//  use (peer, counter) as tiebreaker"
```

This reframing reveals something: **Fugue is a constraint solver** with a specific algorithm for resolving ambiguity in partial orders.

## Map as Constraints

Maps become even more interesting:

```/dev/null/map-constraints.ts#L1-70
// Current view: Set(key, value) with Last-Writer-Wins by Lamport timestamp

// Constraint view:
interface MapConstraints {
  // Value assertions: "Key K should have value V"
  assertions: Array<{
    key: string;
    value: any;
    lamport: number;
    peer: PeerID;
    opId: OpId;
  }>;
  
  // Deletion assertions: "Key K should not exist"
  deletions: Array<{
    key: string;
    lamport: number;
    peer: PeerID;
    opId: OpId;
  }>;
}

// The constraint solver for Map:
function solveMapConstraints(constraints: MapConstraints): Map<string, any> {
  const result = new Map();
  
  for (const key of allKeys(constraints)) {
    // Gather all constraints for this key
    const assertions = constraints.assertions.filter(a => a.key === key);
    const deletions = constraints.deletions.filter(d => d.key === key);
    
    // Find the "winning" constraint
    // LWW: highest lamport wins; peer breaks ties
    const allConstraints = [...assertions, ...deletions];
    const winner = maxBy(allConstraints, c => [c.lamport, c.peer]);
    
    if (winner && 'value' in winner) {
      result.set(key, winner.value);
    }
    // If winner is a deletion, key is absent
  }
  
  return result;
}

// Key insight: LWW is a CONFLICT RESOLUTION STRATEGY for constraints
// Other strategies are possible:
// - Multi-value: keep ALL assertions (like Riak)
// - Merge function: combine conflicting values
// - Priority: certain peers' constraints take precedence
```

## MovableList as Constraints

MovableList is where this gets really interesting—it has more complex constraints:

```/dev/null/movable-list-constraints.ts#L1-100
// Current view: Elements with positions, move operations relocate elements

// Constraint view:
interface MovableListConstraints {
  // Element existence
  elements: Map<ElementId, {
    value: any;
    createdBy: OpId;
  }>;
  
  // Position assertions: "Element E should be at position P"
  // (But what IS a position? This is the crux!)
  positionAssertions: Array<{
    element: ElementId;
    position: PositionDescriptor;
    assertedBy: OpId;
    lamport: number;
  }>;
  
  // Deletion assertions
  deletions: Map<ElementId, OpId>;
}

// The deep question: What is a PositionDescriptor?
// Option 1: Absolute index (bad—doesn't survive concurrent edits)
// Option 2: Fractional index (Loro's approach)
// Option 3: Relational constraints!

type PositionDescriptor =
  // "E should be immediately after A"
  | { type: 'after'; anchor: ElementId }
  // "E should be immediately before B"
  | { type: 'before'; anchor: ElementId }
  // "E should be between A and B"
  | { type: 'between'; left: ElementId; right: ElementId }
  // "E should be at the start"
  | { type: 'first' }
  // "E should be at the end"
  | { type: 'last' }
  // "E should be at fractional position F" (for dense ordering)
  | { type: 'fractional'; index: FractionalIndex };

// A move operation adds a position assertion:
function moveAsConstraints(op: MoveOp): Constraint[] {
  return [{
    type: 'position',
    element: op.element,
    position: op.targetPosition,
    lamport: op.lamport,
  }];
}

// Solving MovableList constraints:
// 1. For each element, find the winning position assertion (LWW)
// 2. Build a constraint graph from position descriptors
// 3. Topologically sort to get final order
// 4. Handle cycles (conflicting constraints) with tiebreakers
```

## The Revelation: CRDTs Are Constraint Solvers with Specific Strategies

Every CRDT can be decomposed into:

1. **Constraint Language**: What constraints can be expressed?
2. **Conflict Detection**: When do constraints conflict?
3. **Resolution Strategy**: How are conflicts resolved?
4. **Solver Algorithm**: How is the satisfying state computed?

```/dev/null/crdt-decomposition.ts#L1-60
interface CRDTAsConstraintSystem<C, S> {
  // The constraint language
  constraintType: C;
  
  // How operations become constraints
  operationToConstraints: (op: Operation) => C[];
  
  // Detect conflicts between constraints
  detectConflicts: (c1: C, c2: C) => Conflict | null;
  
  // Resolve conflicts (this is the "CRDT semantics")
  resolveConflict: (conflict: Conflict) => C;
  
  // Solve constraints to produce state
  solve: (constraints: C[]) => S;
}

// Example: LWW-Register
const lwwRegister: CRDTAsConstraintSystem<ValueAssertion, Value> = {
  constraintType: { value: any, lamport: number, peer: PeerID },
  
  operationToConstraints: (op) => [{
    value: op.value,
    lamport: op.lamport,
    peer: op.peer
  }],
  
  detectConflicts: (c1, c2) => 
    c1.value !== c2.value ? { c1, c2 } : null,
  
  resolveConflict: (conflict) =>
    // LWW resolution
    conflict.c1.lamport > conflict.c2.lamport ? conflict.c1 :
    conflict.c2.lamport > conflict.c1.lamport ? conflict.c2 :
    conflict.c1.peer > conflict.c2.peer ? conflict.c1 : conflict.c2,
  
  solve: (constraints) => {
    // Find the winning constraint
    return constraints.reduce((winner, c) => 
      resolveConflict({ c1: winner, c2: c })
    ).value;
  }
};
```

## What New Possibilities Does This Open?

### 1. Custom Conflict Resolution

Instead of hardcoding LWW, users declare their resolution strategy:

```/dev/null/custom-resolution.ts#L1-50
// A Map where conflicts are resolved by merge function
const mergingMap = createConstraintCRDT({
  conflictResolution: (assertions: ValueAssertion[]) => {
    // Instead of picking one winner, merge all values
    if (assertions.every(a => typeof a.value === 'number')) {
      return { value: sum(assertions.map(a => a.value)) };
    }
    if (assertions.every(a => Array.isArray(a.value))) {
      return { value: union(assertions.map(a => a.value)) };
    }
    // Fall back to LWW for other types
    return maxBy(assertions, a => a.lamport);
  }
});

// A List where position conflicts prefer certain peers
const hierarchicalList = createConstraintCRDT({
  conflictResolution: (positionAssertions) => {
    // Admin's position assertions take precedence
    const adminAssertion = positionAssertions.find(a => a.peer.isAdmin);
    if (adminAssertion) return adminAssertion;
    // Otherwise LWW
    return maxBy(positionAssertions, a => a.lamport);
  }
});
```

### 2. Constraint Introspection

Users can query the constraint state, not just the solved state:

```/dev/null/constraint-introspection.ts#L1-45
// "Show me all conflicts in this document"
const conflicts = doc.getActiveConflicts();
// [
//   { key: 'title', assertions: [
//     { value: 'Hello', by: 'alice', lamport: 5 },
//     { value: 'Hi', by: 'bob', lamport: 5 }  // Same lamport!
//   ], resolution: 'alice wins (peer tiebreaker)' }
// ]

// "Show me the history of constraints on this key"
const history = doc.getConstraintHistory('users.0.name');
// [
//   { type: 'set', value: 'Alice', by: 'alice', lamport: 1 },
//   { type: 'set', value: 'Alicia', by: 'alice', lamport: 3 },
//   { type: 'set', value: 'Bob', by: 'bob', lamport: 2 },  // Concurrent!
//   // Resolution: lamport 3 > 2, so 'Alicia' wins
// ]

// "What would happen if we re-resolved with different strategy?"
const alternative = doc.resolveWith('multi-value');
// { 'users.0.name': ['Alicia', 'Bob'] }  // Both values kept
```

### 3. Soft Constraints and Preferences

Not all constraints are hard requirements—some are preferences:

```/dev/null/soft-constraints.ts#L1-55
interface SoftConstraint extends Constraint {
  // How important is this constraint? (0-1)
  weight: number;
  
  // Is this a hard requirement or a preference?
  hardness: 'hard' | 'soft';
}

// Example: Text formatting
const formattingConstraints = [
  // Hard: these characters exist
  { type: 'exists', char: 'H', hardness: 'hard' },
  { type: 'exists', char: 'i', hardness: 'hard' },
  
  // Soft: prefer this formatting
  { type: 'format', range: [0, 2], style: 'bold', 
    hardness: 'soft', weight: 0.8 },
  
  // Soft: conflicting preference from another user
  { type: 'format', range: [0, 2], style: 'italic', 
    hardness: 'soft', weight: 0.6 },
];

// Solver satisfies all hard constraints,
// then maximizes satisfaction of soft constraints
// Result: "Hi" in bold (higher weight wins)
```

### 4. Constraint-Based Undo

Undo becomes "retract a constraint" rather than "apply inverse operation":

```/dev/null/constraint-undo.ts#L1-50
// Current undo: Generate inverse operation, apply it
// Problem: Inverse of concurrent operations is complex

// Constraint undo: Mark constraint as retracted
interface RetractableConstraint extends Constraint {
  status: 'active' | 'retracted';
  retractedBy?: OpId;
}

function undo(opId: OpId) {
  // Find all constraints added by this operation
  const constraints = getConstraintsByOp(opId);
  
  // Mark them as retracted
  for (const c of constraints) {
    addConstraint({
      type: 'retraction',
      target: c.id,
      retractedBy: newOpId()
    });
  }
  
  // Re-solve without retracted constraints
  // Other users' constraints are unaffected!
}

// This handles concurrent undo beautifully:
// Alice: set(x, 1) → constraint C1
// Bob: set(x, 2) → constraint C2
// Alice: undo() → retract C1
// 
// Result: C2 wins, x = 2
// No need to reason about inverse operations!
```

### 5. Cross-Container Constraints

This is where it gets powerful—constraints that span multiple containers:

```/dev/null/cross-container-constraints.ts#L1-70
// "The total of all counters must not exceed budget"
interface CrossContainerConstraint {
  type: 'invariant';
  expression: (state: DocState) => boolean;
  enforcement: 'reject' | 'clamp' | 'warn';
}

const budgetConstraint: CrossContainerConstraint = {
  type: 'invariant',
  expression: (state) => {
    const total = state.getCounter('expenses').value;
    const budget = state.getMap('settings').get('budget');
    return total <= budget;
  },
  enforcement: 'clamp'  // Auto-adjust to satisfy
};

// "Items in list A must not also be in list B"
const exclusivityConstraint: CrossContainerConstraint = {
  type: 'invariant',
  expression: (state) => {
    const a = new Set(state.getList('listA').toArray());
    const b = new Set(state.getList('listB').toArray());
    return intersection(a, b).size === 0;
  },
  enforcement: 'reject'  // Reject operations that violate
};

// "Parent reference in tree must point to existing node"
const referentialIntegrity: CrossContainerConstraint = {
  type: 'invariant',
  expression: (state) => {
    const tree = state.getTree('tree');
    for (const node of tree.nodes()) {
      if (node.parent && !tree.hasNode(node.parent)) {
        return false;
      }
    }
    return true;
  },
  enforcement: 'repair'  // Auto-repair (e.g., reparent to root)
};
```

## The Deep Insight: State vs. Constraints as Primary

There are two philosophical approaches:

### State-Primary (Current CRDTs)
- State is the truth
- Operations modify state
- Constraints are implicit in merge functions
- History is auxiliary

### Constraint-Primary (This Reframing)
- Constraints are the truth
- Operations add constraints
- State is derived (solved from constraints)
- History IS the constraint set

```/dev/null/state-vs-constraint.ts#L1-45
// State-primary:
interface StatePrimaryCRDT {
  state: State;
  apply(op: Operation): void;  // Mutates state
  merge(other: State): void;   // Mutates state
  getState(): State;           // Returns state
}

// Constraint-primary:
interface ConstraintPrimaryCRDT {
  constraints: Constraint[];
  assert(constraint: Constraint): void;  // Adds constraint
  retract(constraintId: Id): void;       // Marks retracted
  solve(): State;                        // Computes state from constraints
  
  // Rich queries that state-primary can't do:
  getConstraintsFor(path: Path): Constraint[];
  getConflicts(): Conflict[];
  whatIf(additionalConstraints: Constraint[]): State;
  why(path: Path): Explanation;  // "Why does this have this value?"
}
```

## What Would Loro Look Like as Constraint-Primary?

```/dev/null/loro-constraint-primary.ts#L1-100
class ConstraintLoroDoc {
  private constraints: ConstraintStore;
  private solver: ConstraintSolver;
  private cachedState: WeakRef<DocState> | null = null;
  
  // Operations become constraint assertions
  getText(name: string): ConstraintText {
    return new ConstraintText(this, ['root', name]);
  }
  
  // Inserting text = asserting existence + ordering constraints
  // (Implementation in ConstraintText)
  
  // The state is computed, not stored
  getState(): DocState {
    if (this.cachedState?.deref()) {
      return this.cachedState.deref()!;
    }
    const state = this.solver.solve(this.constraints.getActive());
    this.cachedState = new WeakRef(state);
    return state;
  }
  
  // Sync transmits constraints, not state
  export(): ConstraintBundle {
    return this.constraints.export();
  }
  
  import(bundle: ConstraintBundle): void {
    this.constraints.merge(bundle);
    this.cachedState = null;  // Invalidate cache
  }
  
  // Rich introspection
  explain(path: Path): Explanation {
    const relevantConstraints = this.constraints.getFor(path);
    const conflicts = this.solver.findConflicts(relevantConstraints);
    const resolution = this.solver.explainResolution(conflicts);
    return { constraints: relevantConstraints, conflicts, resolution };
  }
  
  // Hypothetical queries
  whatIf(hypotheticalOps: Operation[]): DocState {
    const hypotheticalConstraints = hypotheticalOps.flatMap(
      op => this.operationToConstraints(op)
    );
    return this.solver.solve([
      ...this.constraints.getActive(),
      ...hypotheticalConstraints
    ]);
  }
  
  // Constraint-based subscriptions (for IVM!)
  subscribeToConstraints(
    filter: (c: Constraint) => boolean,
    callback: (delta: ConstraintDelta) => void
  ): Subscription {
    // This is more fundamental than state subscriptions!
    // IVM can work directly on constraint deltas
  }
}

class ConstraintText {
  constructor(
    private doc: ConstraintLoroDoc,
    private path: Path
  ) {}
  
  insert(pos: number, text: string): void {
    // Generate element IDs
    const elements = text.split('').map((char, i) => ({
      id: this.doc.generateId(),
      char
    }));
    
    // Find anchors (existing elements at pos-1 and pos)
    const state = this.doc.getState();
    const leftAnchor = state.getElementAt(this.path, pos - 1);
    const rightAnchor = state.getElementAt(this.path, pos);
    
    // Assert constraints
    for (let i = 0; i < elements.length; i++) {
      const elem = elements[i];
      const left = i === 0 ? leftAnchor : elements[i - 1].id;
      const right = i === elements.length - 1 ? rightAnchor : elements[i + 1].id;
      
      this.doc.assertConstraints([
        { type: 'exists', path: this.path, element: elem.id, char: elem.char },
        { type: 'after', element: elem.id, anchor: left },
        { type: 'before', element: elem.id, anchor: right },
      ]);
    }
  }
}
```

## The Payoff for IVM

With constraint-primary CRDTs, IVM becomes much more natural:

```/dev/null/ivm-constraint-based.ts#L1-60
// Views are ALSO constraint systems!
// A view is a set of derived constraints computed from source constraints

interface ConstraintView<SourceC, ViewC, ViewState> {
  // How to derive view constraints from source constraints
  derive: (source: SourceC) => ViewC[];
  
  // How to solve view constraints
  solve: (viewConstraints: ViewC[]) => ViewState;
  
  // Incremental: how does a source constraint delta affect view?
  propagate: (delta: ConstraintDelta<SourceC>) => ConstraintDelta<ViewC>;
}

// Example: "join" view
const joinView: ConstraintView<TextConstraint, JoinConstraint, string> = {
  derive: (source) => {
    if (source.type === 'exists') {
      return [{
        type: 'fragment',
        element: source.element,
        text: source.char
      }];
    }
    if (source.type === 'after') {
      return [{
        type: 'fragment-order',
        before: source.anchor,
        after: source.element
      }];
    }
    // Separators are derived constraints!
    // "There is a separator between adjacent elements"
    return [];
  },
  
  propagate: (delta) => {
    if (delta.type === 'add' && delta.constraint.type === 'exists') {
      // New element → new fragment + maybe new separator
      return {
        type: 'add',
        constraints: [
          { type: 'fragment', element: delta.constraint.element, text: delta.constraint.char },
          // Separator constraints derived from ordering
        ]
      };
    }
    // ...
  },
  
  solve: (viewConstraints) => {
    // Sort fragments by order constraints
    // Insert separators between adjacent pairs
    // Return joined string
  }
};
```

## Summary: The Constraint Lens

Viewing CRDTs as constraint systems:

| Aspect | State-Primary | Constraint-Primary |
|--------|--------------|-------------------|
| **Truth** | Current state | Constraint set |
| **Operations** | State mutations | Constraint assertions |
| **Merge** | State combination | Constraint union + re-solve |
| **History** | Auxiliary log | IS the constraints |
| **Conflicts** | Implicit in merge | Explicit, queryable |
| **Undo** | Inverse operations | Constraint retraction |
| **Views (IVM)** | State transformation | Constraint derivation |
| **Explanation** | Not possible | "Why is X = Y?" answerable |

The constraint view doesn't change what CRDTs *do*—it changes how we *think* about them, and that thinking opens up new capabilities (introspection, custom resolution, cross-container invariants, cleaner IVM).

> Let's discuss collaboration. How does this constraint-based CRDT enable collaboration? How is it the same as state-based, and how is it different? Do we still have a mathematical guarantee of convergence (and eventual consistency)? Is it still a semi-join lattice?

## First: What Makes CRDTs Work?

The fundamental theorem behind CRDTs is:

> **If (S, ⊔) is a join-semilattice and all operations are monotonic (inflationary), then all replicas converge.**

Let's unpack this:

```/dev/null/crdt-foundations.ts#L1-35
// A join-semilattice (S, ⊔) requires:
// 1. Commutativity: a ⊔ b = b ⊔ a
// 2. Associativity: (a ⊔ b) ⊔ c = a ⊔ (b ⊔ c)
// 3. Idempotence: a ⊔ a = a

// These guarantee:
// - Order of message delivery doesn't matter (commutativity)
// - Grouping of merges doesn't matter (associativity)  
// - Duplicate delivery is harmless (idempotence)

// Monotonicity means:
// For any operation op: apply(s, op) ⊒ s
// (State only moves "up" in the lattice, never down)

// The join operation ⊔ gives us the supremum (least upper bound)
// of any two states, which is the "merged" state.
```

## State-Based CRDTs: The Lattice Structure

In state-based CRDTs, the lattice structure is explicit:

```/dev/null/state-based-lattice.ts#L1-50
// G-Counter example
// State: Map<PeerID, number>
// Lattice order: a ⊑ b iff ∀p: a[p] ≤ b[p]
// Join: (a ⊔ b)[p] = max(a[p], b[p])

type GCounter = Map<PeerID, number>;

function join(a: GCounter, b: GCounter): GCounter {
  const result = new Map(a);
  for (const [peer, count] of b) {
    result.set(peer, Math.max(result.get(peer) ?? 0, count));
  }
  return result;
}

// LWW-Register example
// State: (value, timestamp)
// Lattice order: a ⊑ b iff a.timestamp ≤ b.timestamp
// Join: pick the one with higher timestamp

type LWWRegister<T> = { value: T; timestamp: number; peer: PeerID };

function join<T>(a: LWWRegister<T>, b: LWWRegister<T>): LWWRegister<T> {
  if (a.timestamp > b.timestamp) return a;
  if (b.timestamp > a.timestamp) return b;
  // Tiebreaker for equal timestamps
  return a.peer > b.peer ? a : b;
}

// Loro's Text (Fugue-based)
// State: Set of (element, char, leftOrigin, rightOrigin) + tombstones
// Lattice order: a ⊑ b iff a.elements ⊆ b.elements ∧ a.tombstones ⊆ b.tombstones
// Join: union of elements, union of tombstones
```

## Constraint-Based CRDTs: What's the Lattice?

Here's the key insight: **the constraint set itself forms a lattice!**

```/dev/null/constraint-lattice.ts#L1-70
// Constraints form a lattice under set inclusion
// 
// Let C be the universe of all possible constraints
// Let P(C) be the powerset (all subsets of C)
// 
// (P(C), ⊆) is a lattice where:
// - Join (⊔) is set union: A ⊔ B = A ∪ B
// - Meet (⊓) is set intersection: A ⊓ B = A ∩ B
// - Bottom (⊥) is the empty set: {}
// - Top (⊤) is the full set: C

// This immediately gives us:
// 1. Commutativity: A ∪ B = B ∪ A ✓
// 2. Associativity: (A ∪ B) ∪ C = A ∪ (B ∪ C) ✓
// 3. Idempotence: A ∪ A = A ✓

// Monotonicity:
// Adding a constraint is inflationary: 
// add(S, c) = S ∪ {c} ⊇ S ✓

// Therefore: CONSTRAINT SETS ARE ALREADY A SEMILATTICE!

type ConstraintSet = Set<Constraint>;

function join(a: ConstraintSet, b: ConstraintSet): ConstraintSet {
  return new Set([...a, ...b]);  // Union!
}

// The merge operation is trivial: just union the constraints.
// All the "interesting" CRDT semantics move to the SOLVER.
```

This is a profound simplification. Let me draw the picture:

```/dev/null/architecture-comparison.ts#L1-40
// STATE-BASED CRDT:
// 
//   Operations ──→ State ←──┬──→ State ←── Operations
//                           │
//                     merge (⊔)
//                           │
//                           ▼
//                    Merged State
//
// The lattice structure is in the STATE.
// Merge function encodes CRDT semantics.

// CONSTRAINT-BASED CRDT:
//
//   Operations ──→ Constraints ←──┬──→ Constraints ←── Operations  
//                                 │
//                           union (∪)
//                                 │
//                                 ▼
//                        All Constraints
//                                 │
//                            solve()
//                                 │
//                                 ▼
//                          Derived State
//
// The lattice structure is in the CONSTRAINT SET.
// Merge is trivial (union).
// Solver encodes CRDT semantics.
```

## The Solver Must Be Deterministic

For convergence, we need one more property: **the solver must be a deterministic function**.

```/dev/null/deterministic-solver.ts#L1-55
// Given the same constraint set, every replica must compute the same state.
// 
// solve: P(C) → S
// 
// This must be a FUNCTION (deterministic, total):
// ∀ constraints: solve(constraints) has exactly one result

// This is where CRDT semantics now live:

function solveLWWMap(constraints: MapConstraint[]): Map<string, any> {
  const result = new Map();
  
  // Group by key
  const byKey = groupBy(constraints, c => c.key);
  
  for (const [key, keyConstraints] of byKey) {
    // Deterministic resolution: highest lamport, then highest peer
    const winner = keyConstraints.reduce((best, c) => {
      if (c.lamport > best.lamport) return c;
      if (c.lamport < best.lamport) return best;
      return c.peer > best.peer ? c : best;
    });
    
    if (winner.type === 'set') {
      result.set(key, winner.value);
    }
    // If winner is 'delete', key is absent
  }
  
  return result;
}

// The solver MUST be:
// 1. Deterministic: same input → same output
// 2. Total: defined for all possible constraint sets
// 3. Consistent with constraint semantics
```

## Formal Proof of Convergence

Let me prove that constraint-based CRDTs converge:

```/dev/null/convergence-proof.ts#L1-80
// THEOREM: Constraint-based CRDTs achieve eventual consistency.
//
// PROOF:
//
// Let R₁, R₂ be two replicas.
// Let C₁, C₂ be their respective constraint sets.
// Let solve: P(C) → S be a deterministic solver.
//
// After all operations are delivered to both replicas:
//   C₁ = C₂ = C (same constraints, due to reliable delivery)
//
// Since solve is deterministic:
//   solve(C₁) = solve(C₂) = solve(C)
//
// Therefore both replicas have the same derived state. ∎
//
// KEY INSIGHT: We don't need a lattice on STATES anymore!
// The lattice is on CONSTRAINTS, and states are derived.

// COROLLARY: The state space doesn't need to be a lattice.
//
// In state-based CRDTs, we need (S, ⊔) to be a semilattice.
// This restricts what data structures we can represent.
//
// In constraint-based CRDTs, states can be ARBITRARY.
// Only the constraint set needs lattice structure.
// And powerset-with-union is always a lattice!

// This means we can have:
// - Richer conflict resolution strategies
// - Cross-container constraints
// - Soft constraints with priorities
// - Constraints that would break lattice structure in state-based model

// Example: A "minimum" constraint
// "x should be at least 5"
// 
// In state-based: min constraints don't form a lattice!
//   min(x, 5) ⊔ min(x, 3) = ??? (no natural join)
//
// In constraint-based: just add both constraints!
//   { min(x, 5), min(x, 3) } 
//   Solver computes: x ≥ 5 (satisfies both)
```

## The Solver as the New "Merge Function"

The complexity that was in the merge function moves to the solver:

```/dev/null/solver-complexity.ts#L1-65
// State-based: Merge encodes semantics
// 
// function merge(a: FugueState, b: FugueState): FugueState {
//   // Complex logic for:
//   // - Combining element sets
//   // - Resolving ordering conflicts
//   // - Handling tombstones
//   // - Interleaving rules
// }

// Constraint-based: Solver encodes semantics
//
// function solve(constraints: FugueConstraint[]): string {
//   // Same complex logic, but structured differently:
//   
//   // 1. Extract existence constraints
//   const elements = constraints.filter(c => c.type === 'exists');
//   
//   // 2. Extract deletion constraints  
//   const deletions = constraints.filter(c => c.type === 'deleted');
//   
//   // 3. Extract ordering constraints
//   const orderings = constraints.filter(c => c.type === 'before');
//   
//   // 4. Build a partial order from ordering constraints
//   const partialOrder = buildPartialOrder(orderings);
//   
//   // 5. Topologically sort with tiebreakers for ambiguity
//   const totalOrder = topologicalSort(partialOrder, tiebreakerFn);
//   
//   // 6. Filter out deleted elements
//   const live = totalOrder.filter(e => !deletions.has(e.id));
//   
//   // 7. Render to string
//   return live.map(e => e.char).join('');
// }

// The key difference:
// - In state-based, merge happens incrementally as messages arrive
// - In constraint-based, solve can see ALL constraints at once

// This enables global reasoning that's hard in state-based:
// - "Given all constraints, what's the optimal solution?"
// - "Are there any conflicts I should warn about?"
// - "What constraints are redundant?"
```

## What About Efficiency?

A naive constraint-based system would be expensive:

```/dev/null/efficiency-concerns.ts#L1-50
// Naive approach: Store all constraints, re-solve on every read
// 
// Problems:
// 1. Constraint set grows forever (every operation adds constraints)
// 2. Solve() may be expensive (depends on constraint language)
// 3. Merging large constraint sets is memory-intensive

// Solutions:

// 1. CONSTRAINT COMPACTION
// Constraints can be compacted when they don't affect the solution.
// 
// Example: For LWW, only keep the winning constraint per key
// { set(x, 1, t=1), set(x, 2, t=2), set(x, 3, t=3) }
// Compacts to: { set(x, 3, t=3) }
// 
// This is safe because set(x, 3, t=3) dominates the others.

// 2. INCREMENTAL SOLVING
// Don't re-solve from scratch; update solution incrementally.
//
// When new constraint c is added:
// - If c doesn't conflict with current solution, extend solution
// - If c conflicts, re-solve only affected region
//
// This is exactly what state-based CRDTs do implicitly!

// 3. MATERIALIZED STATE
// Cache the solved state; invalidate on constraint changes.
//
// This gives us the same performance as state-based,
// with the flexibility of constraint-based.
```

## The Deep Equivalence

Here's the beautiful insight: **state-based and constraint-based CRDTs are duals**.

```/dev/null/duality.ts#L1-70
// CLAIM: Every state-based CRDT can be viewed as a constraint-based CRDT,
//        and vice versa.

// STATE → CONSTRAINTS:
// Given state-based CRDT (S, ⊔, operations)
// Define constraint c_s for each state s ∈ S:
//   c_s = "state must be ⊒ s"
// Solver: solve(C) = ⊔ { s | c_s ∈ C }
// 
// This recovers the original CRDT exactly.

// CONSTRAINTS → STATE:
// Given constraint-based CRDT (C, solve)
// Define state as (constraint_set, cached_solution)
// Merge: (C₁, _) ⊔ (C₂, _) = (C₁ ∪ C₂, solve(C₁ ∪ C₂))
//
// This gives a state-based CRDT.

// The difference is PERSPECTIVE, not CAPABILITY.

// But the perspectives enable different things:

// STATE-BASED perspective enables:
// - Compact representation (just the state)
// - Efficient incremental updates
// - Simple mental model

// CONSTRAINT-BASED perspective enables:
// - Introspection (why is state X?)
// - Alternative resolution strategies
// - Cross-constraint reasoning
// - Constraint retraction (clean undo)
// - Soft constraints and preferences
```

## Is It Still a Semilattice?

Yes, but the semilattice is on different objects:

| Aspect | State-Based | Constraint-Based |
|--------|-------------|------------------|
| **Semilattice on** | States | Constraint sets |
| **Join operation** | Merge function | Set union |
| **Order relation** | Domain-specific (e.g., set inclusion) | Subset relation |
| **Complexity** | In the join | In the solver |
| **Derived state** | IS the lattice element | Computed from constraints |

```/dev/null/semilattice-comparison.ts#L1-45
// State-based: (S, ⊑, ⊔)
// Example: G-Counter
//   S = Map<PeerID, Nat>
//   a ⊑ b iff ∀p: a[p] ≤ b[p]
//   (a ⊔ b)[p] = max(a[p], b[p])

// Constraint-based: (P(C), ⊆, ∪)
// Example: G-Counter expressed as constraints
//   C = { increment(peer, amount, lamport) }
//   P(C) = all subsets of C
//   A ⊆ B is the order
//   A ∪ B is the join
//
//   solve(constraints) = 
//     for each peer p:
//       value[p] = sum of all increment(p, amount, _) in constraints

// Both are semilattices. 
// Both converge.
// The constraint-based version has a TRIVIAL lattice structure
// (powerset with union is always a semilattice).
// All the "interesting" semantics are in solve().
```

## What New Guarantees Can We Get?

The constraint-based view enables new consistency properties:

```/dev/null/new-guarantees.ts#L1-80
// 1. EXPLANATION CONSISTENCY
// All replicas can explain WHY the state is what it is.
// 
// In state-based: State is opaque. Why is x = 5? Who knows.
// In constraint-based: We can trace back to the winning constraint.

function explain(path: Path): Explanation {
  const constraints = getConstraintsAffecting(path);
  const winner = getWinningConstraint(constraints);
  const losers = constraints.filter(c => c !== winner);
  
  return {
    currentValue: solve(constraints),
    determinedBy: winner,
    conflictedWith: losers,
    resolution: 'LWW with lamport timestamp'
  };
}

// 2. HYPOTHETICAL CONSISTENCY
// All replicas can compute "what if" scenarios identically.
//
// "What would happen if we added constraint C?"
// Since solve() is deterministic, all replicas agree on hypotheticals.

function whatIf(hypotheticalConstraint: Constraint): State {
  const hypotheticalSet = union(currentConstraints, [hypotheticalConstraint]);
  return solve(hypotheticalSet);
}

// 3. CONFLICT VISIBILITY
// Conflicts are first-class, visible objects, not hidden in merge.
//
// In state-based: Conflict resolution happens implicitly.
// In constraint-based: Conflicts are explicit constraint relationships.

function getConflicts(): Conflict[] {
  const constraints = getAllConstraints();
  const conflicts = [];
  
  for (const [c1, c2] of pairs(constraints)) {
    if (areConflicting(c1, c2)) {
      conflicts.push({
        constraint1: c1,
        constraint2: c2,
        resolution: howResolved(c1, c2),
        winner: getWinner(c1, c2)
      });
    }
  }
  
  return conflicts;
}

// 4. CONSTRAINT PROVENANCE
// We can track where constraints came from.
//
// "Which user added this constraint? When? As part of what operation?"
// This enables richer collaboration features.

interface ConstraintWithProvenance extends Constraint {
  addedBy: PeerID;
  addedAt: HLC;
  operation: OperationID;
  intention?: string;  // Optional semantic annotation
}
```

## The Collaboration Model

How does collaboration work in each model?

```/dev/null/collaboration-models.ts#L1-75
// STATE-BASED COLLABORATION:
// 
// 1. Each replica maintains state
// 2. Operations modify local state
// 3. State (or delta) is broadcast
// 4. Recipients merge received state with local state
// 5. Convergence: same operations → same merged state
//
// The "collaboration protocol" is: exchange states/deltas, merge.

// CONSTRAINT-BASED COLLABORATION:
//
// 1. Each replica maintains constraint set
// 2. Operations add constraints
// 3. Constraints are broadcast
// 4. Recipients add received constraints to local set
// 5. Each replica solves locally
// 6. Convergence: same constraints → same solved state
//
// The "collaboration protocol" is: exchange constraints, solve locally.

// KEY DIFFERENCE: When is semantics applied?
//
// State-based: At merge time (distributed, incremental)
// Constraint-based: At solve time (local, can be batch or incremental)

// This has implications:

// LATE BINDING of semantics:
// In constraint-based, you could (theoretically) change the solver
// and get a different state from the same constraints.
// This enables "resolution strategy as configuration."

const sameConstraints = getCurrentConstraints();

const lwwState = solveWithLWW(sameConstraints);      // Last writer wins
const mvState = solveWithMV(sameConstraints);        // Multi-value (keep all)
const customState = solveWithCustom(sameConstraints); // Domain-specific

// CAUTION: All replicas must use the same solver for convergence!
// But the solver can be versioned/negotiated.
```

## Summary: Same Guarantees, Different Perspective

```/dev/null/summary-table.ts#L1-50
// ┌─────────────────────┬───────────────────┬────────────────────┐
// │ Property            │ State-Based       │ Constraint-Based   │
// ├─────────────────────┼───────────────────┼────────────────────┤
// │ Semilattice?        │ Yes (on states)   │ Yes (on constraints)│
// │ Convergence?        │ Yes               │ Yes                │
// │ Eventual consistency│ Yes               │ Yes                │
// │ Commutativity?      │ Yes (merge)       │ Yes (union)        │
// │ Associativity?      │ Yes (merge)       │ Yes (union)        │
// │ Idempotence?        │ Yes (merge)       │ Yes (union)        │
// │ Monotonicity?       │ Yes (operations)  │ Yes (add constraint)│
// ├─────────────────────┼───────────────────┼────────────────────┤
// │ Where is complexity?│ Merge function    │ Solver             │
// │ Introspection?      │ Limited           │ Rich               │
// │ Conflict visibility?│ Implicit          │ Explicit           │
// │ Custom resolution?  │ Hard to change    │ Configurable       │
// │ Undo model?         │ Inverse operations│ Constraint retract │
// │ Cross-container?    │ Difficult         │ Natural            │
// └─────────────────────┴───────────────────┴────────────────────┘

// The mathematical guarantees are IDENTICAL.
// The capabilities and ergonomics are DIFFERENT.

// Think of it like:
// - State-based is "imperative CRDT" (apply operations, merge states)
// - Constraint-based is "declarative CRDT" (assert constraints, derive state)

// Just like imperative and functional programming:
// - Same computational power
// - Different strengths and weaknesses
// - Different ways of thinking about problems
```

## The Punchline

**Yes, constraint-based CRDTs still have all the mathematical guarantees of state-based CRDTs.** The semilattice structure is on the constraint sets (with union as join), and the solver is a deterministic function that derives state.

The shift in perspective moves complexity from the merge function to the solver, but the total complexity is conserved. What we gain is:

1. **Introspection**: We can see *why* the state is what it is
2. **Flexibility**: Conflict resolution becomes configurable
3. **Composability**: Cross-container constraints are natural
4. **Clean undo**: Retracting constraints is simpler than inverse operations
5. **IVM foundation**: Views can be expressed as constraint derivations

What we potentially lose (without careful implementation):
1. **Efficiency**: Naive solve() may be expensive
2. **Space**: Constraint sets can grow large
3. **Simplicity**: Solver design requires care

But these losses can be mitigated with incremental solving, constraint compaction, and materialized state caching—essentially recovering the efficiency of state-based CRDTs while keeping the conceptual benefits of constraint-based thinking.

> What would this mean for schema evolution? For example, it is traditionally a "hard problem" to move many peers from one schema to the next.

This is where the constraint-based perspective gets *really* interesting. Schema evolution is indeed one of the hardest problems in distributed systems, and I think constraints offer a fundamentally different approach.

## The Traditional Schema Evolution Problem

```/dev/null/traditional-problem.ts#L1-45
// The nightmare scenario:
//
// Time T1: All peers on Schema V1
//   { name: string, age: number }
//
// Time T2: We want Schema V2
//   { fullName: string, birthYear: number }
//
// Problems:
// 1. COORDINATION: How do we get all peers to upgrade?
// 2. TRANSLATION: How do we convert V1 data to V2?
// 3. CONCURRENCY: What if peer A (V1) sends data while peer B upgraded to V2?
// 4. ROLLBACK: What if V2 has bugs and we need to go back?
// 5. COMPATIBILITY: What about offline peers that rejoin later?

// Traditional solutions:

// A) Big Bang Migration
// - Stop the world
// - Upgrade everyone simultaneously
// - Convert all data
// Reality: Impossible for distributed/offline-first systems

// B) Versioned Protocols
// - Peers negotiate version
// - Translate at boundaries
// Reality: Combinatorial explosion of version pairs

// C) Always-Compatible Evolution
// - Only add optional fields
// - Never remove or rename
// Reality: Schema becomes a graveyard of deprecated fields

// D) Multi-Version Support
// - Application understands all versions
// - Converts on read
// Reality: Massive complexity, bugs, technical debt
```

## The State-Based CRDT Schema Problem

In state-based CRDTs, schema is deeply embedded in the state structure:

```/dev/null/state-based-schema.ts#L1-55
// State-based CRDT ties schema to state representation:

// V1 State:
interface UserStateV1 {
  name: LWWRegister<string>;
  age: LWWRegister<number>;
}

// V2 State:
interface UserStateV2 {
  fullName: LWWRegister<string>;
  birthYear: LWWRegister<number>;
}

// The MERGE function is schema-specific!
function mergeV1(a: UserStateV1, b: UserStateV1): UserStateV1 {
  return {
    name: mergeLWW(a.name, b.name),
    age: mergeLWW(a.age, b.age)
  };
}

// What happens when V1 peer sends state to V2 peer?
// 
// V1 sends: { name: "Alice", age: 30 }
// V2 expects: { fullName: "???", birthYear: "???" }
//
// Options:
// 1. Crash (not great for UX)
// 2. Ignore unknown fields (lose data)
// 3. Store unknown fields opaquely (can't merge them properly)
// 4. Require version negotiation (complex protocol)

// The fundamental issue:
// STATE STRUCTURE IS LOAD-BEARING FOR MERGE SEMANTICS
```

## The Constraint-Based Schema Revolution

Here's where constraints change everything. **Constraints don't have a fixed schema—they're self-describing assertions.**

```/dev/null/constraint-schema.ts#L1-70
// Instead of structured state, we have a bag of constraints:

type Constraint = {
  id: ConstraintId;
  type: string;           // Self-describing!
  path: Path;             // What this constrains
  assertion: Assertion;   // The actual constraint
  metadata: Metadata;     // Lamport, peer, etc.
};

// V1 peer creates constraints:
const v1Constraints = [
  { type: 'value', path: ['user', 'name'], assertion: { eq: 'Alice' }, ... },
  { type: 'value', path: ['user', 'age'], assertion: { eq: 30 }, ... },
];

// V2 peer creates constraints:
const v2Constraints = [
  { type: 'value', path: ['user', 'fullName'], assertion: { eq: 'Alice Smith' }, ... },
  { type: 'value', path: ['user', 'birthYear'], assertion: { eq: 1994 }, ... },
];

// MERGE IS STILL JUST UNION!
const allConstraints = [...v1Constraints, ...v2Constraints];

// The solver sees ALL constraints, regardless of "schema version"
// It doesn't care about schema—it just solves constraints!

// The magic: Schema becomes a LENS for viewing constraints
interface Schema {
  version: string;
  // How to interpret constraints into typed structure
  project: (constraints: Constraint[]) => TypedState;
  // How to create constraints from typed operations
  inject: (operation: TypedOperation) => Constraint[];
}

const schemaV1: Schema = {
  version: 'v1',
  project: (constraints) => {
    const name = solveForPath(constraints, ['user', 'name']);
    const age = solveForPath(constraints, ['user', 'age']);
    return { name, age };
  },
  inject: (op) => { /* ... */ }
};

const schemaV2: Schema = {
  version: 'v2',
  project: (constraints) => {
    const fullName = solveForPath(constraints, ['user', 'fullName']);
    const birthYear = solveForPath(constraints, ['user', 'birthYear']);
    return { fullName, birthYear };
  },
  inject: (op) => { /* ... */ }
};
```

## Schema as Constraint Interpretation

The key insight: **schema is not in the data—schema is in the interpretation**.

```/dev/null/schema-as-interpretation.ts#L1-80
// The constraint store is SCHEMA-AGNOSTIC
// It just holds constraints about paths and values

class ConstraintStore {
  private constraints: Constraint[] = [];
  
  // Add constraint - no schema validation!
  add(constraint: Constraint): void {
    this.constraints.push(constraint);
  }
  
  // Merge - no schema awareness needed!
  merge(other: ConstraintStore): void {
    for (const c of other.constraints) {
      this.add(c);
    }
  }
  
  // Query - schema-agnostic
  getConstraintsForPath(path: Path): Constraint[] {
    return this.constraints.filter(c => pathMatches(c.path, path));
  }
}

// Schema is a VIEW over constraints
class SchemaView<T> {
  constructor(
    private store: ConstraintStore,
    private schema: Schema<T>
  ) {}
  
  // Project constraints into typed state
  getState(): T {
    return this.schema.project(this.store.getAllConstraints());
  }
  
  // Apply typed operation by creating constraints
  apply(operation: Operation<T>): void {
    const constraints = this.schema.inject(operation);
    for (const c of constraints) {
      this.store.add(c);
    }
  }
}

// DIFFERENT PEERS CAN USE DIFFERENT SCHEMAS OVER THE SAME CONSTRAINTS!

// Peer A (using V1):
const peerA = new SchemaView(sharedStore, schemaV1);
console.log(peerA.getState()); // { name: "Alice", age: 30 }

// Peer B (using V2):
const peerB = new SchemaView(sharedStore, schemaV2);
console.log(peerB.getState()); // { fullName: "Alice Smith", birthYear: 1994 }

// Both are viewing the SAME constraints!
// They just interpret them differently!
```

## Migration as Constraint Mapping

Instead of migrating data, we create **mapping constraints** that relate old and new paths:

```/dev/null/migration-constraints.ts#L1-95
// Traditional migration: Transform data
// Constraint migration: Add mapping constraints

interface MappingConstraint extends Constraint {
  type: 'mapping';
  from: Path;
  to: Path;
  transform: TransformId;  // Reference to a transform function
}

// Migration from V1 to V2:
const migrationConstraints: MappingConstraint[] = [
  {
    type: 'mapping',
    from: ['user', 'name'],
    to: ['user', 'fullName'],
    transform: 'identity',  // For now, just copy
  },
  {
    type: 'mapping',
    from: ['user', 'age'],
    to: ['user', 'birthYear'],
    transform: 'ageToYear',  // age → currentYear - age
  },
];

// The solver understands mappings:
function solveWithMappings(constraints: Constraint[]): Solution {
  const mappings = constraints.filter(c => c.type === 'mapping');
  const values = constraints.filter(c => c.type === 'value');
  
  // Build a constraint graph including mappings
  const graph = new ConstraintGraph();
  
  for (const v of values) {
    graph.addValueConstraint(v);
  }
  
  for (const m of mappings) {
    // Mapping creates a derived constraint:
    // "If 'from' has value X, then 'to' should have value transform(X)"
    graph.addDerivedConstraint(m.to, () => {
      const sourceValue = graph.solve(m.from);
      return transforms[m.transform](sourceValue);
    });
  }
  
  return graph.solve();
}

// Now the magic happens:
// 
// 1. V1 peer adds: { path: ['user', 'name'], value: 'Alice' }
// 2. Migration constraint says: name → fullName
// 3. V2 peer queries ['user', 'fullName']
// 4. Solver follows mapping, returns 'Alice'
//
// NO DATA MIGRATION NEEDED! The mapping IS the migration!

// What about conflicts?
// 
// V1 peer sets: name = 'Alice'
// V2 peer sets: fullName = 'Alice Smith'
// 
// Now we have:
// - Direct constraint on fullName: 'Alice Smith'
// - Derived constraint on fullName (from name mapping): 'Alice'
//
// Conflict resolution:
// - Direct constraints could take precedence over derived
// - Or use lamport timestamps as usual
// - Or mark derived constraints with lower priority
```

## Bidirectional Schema Evolution

The constraint model naturally supports bidirectional evolution:

```/dev/null/bidirectional-evolution.ts#L1-80
// Mappings can be bidirectional!

interface BidirectionalMapping {
  pathA: Path;
  pathB: Path;
  aToB: TransformId;
  bToA: TransformId;
  priority: 'a' | 'b' | 'latest';  // Which wins on conflict
}

const nameMigration: BidirectionalMapping = {
  pathA: ['user', 'name'],
  pathB: ['user', 'fullName'],
  aToB: 'identity',
  bToA: 'takeFirstWord',  // "Alice Smith" → "Alice"
  priority: 'latest'      // Most recent write wins
};

// Scenario:
// 
// T1: V1 peer writes name = "Alice"
// T2: V2 peer reads fullName, gets "Alice" (via mapping)
// T3: V2 peer writes fullName = "Alice Smith"
// T4: V1 peer reads name, gets "Alice" (via reverse mapping)
//
// Both peers see consistent (though lossy) views!

// The system AUTOMATICALLY handles:
// - Forward migration (V1 data visible to V2)
// - Backward compatibility (V2 data visible to V1)
// - Conflict resolution (via priority rules)

// This is like database views, but distributed!
```

## Schema Evolution as Constraint Evolution

New schemas don't replace old schemas—they add new constraints about interpretation:

```/dev/null/schema-evolution-constraints.ts#L1-100
// Schema versions are themselves constraints!

interface SchemaConstraint extends Constraint {
  type: 'schema';
  version: string;
  paths: PathDefinition[];
  mappingsFrom: { version: string; mappings: Mapping[] }[];
}

// V1 schema definition (as a constraint):
const schemaV1Constraint: SchemaConstraint = {
  type: 'schema',
  version: 'v1',
  paths: [
    { path: ['user', 'name'], type: 'string' },
    { path: ['user', 'age'], type: 'number' },
  ],
  mappingsFrom: []  // No previous version
};

// V2 schema definition (as a constraint):
const schemaV2Constraint: SchemaConstraint = {
  type: 'schema',
  version: 'v2',
  paths: [
    { path: ['user', 'fullName'], type: 'string' },
    { path: ['user', 'birthYear'], type: 'number' },
  ],
  mappingsFrom: [{
    version: 'v1',
    mappings: [
      { from: ['user', 'name'], to: ['user', 'fullName'], transform: 'identity' },
      { from: ['user', 'age'], to: ['user', 'birthYear'], transform: 'ageToYear' },
    ]
  }]
};

// V3 schema (adds a field):
const schemaV3Constraint: SchemaConstraint = {
  type: 'schema',
  version: 'v3',
  paths: [
    { path: ['user', 'fullName'], type: 'string' },
    { path: ['user', 'birthYear'], type: 'number' },
    { path: ['user', 'email'], type: 'string' },  // New field!
  ],
  mappingsFrom: [{
    version: 'v2',
    mappings: [
      // Identity mappings (fields carry over)
      { from: ['user', 'fullName'], to: ['user', 'fullName'], transform: 'identity' },
      { from: ['user', 'birthYear'], to: ['user', 'birthYear'], transform: 'identity' },
      // New field has no mapping (it's new!)
    ]
  }]
};

// These schema constraints are ALSO replicated!
// All peers eventually see all schema definitions.
// Each peer chooses which schema to use for their view.

// The solver can answer:
// - "What schemas are defined?" (query schema constraints)
// - "What version is peer X using?" (if they annotate operations)
// - "Can I interpret V1 data as V3?" (follow mapping chain)
```

## Graceful Degradation and Progressive Enhancement

The constraint model enables graceful handling of unknown schemas:

```/dev/null/graceful-degradation.ts#L1-85
// Peer on V1 receives constraints from V3 peer (unknown schema)

// Traditional approach: 
// - Crash, or
// - Ignore unknown data, or
// - Store opaquely (can't merge)

// Constraint approach:
// Constraints are self-describing! V1 peer can still store them.

// V3 peer sends:
const v3Constraint = {
  type: 'value',
  path: ['user', 'email'],  // Unknown to V1!
  assertion: { eq: 'alice@example.com' },
  metadata: { lamport: 5, peer: 'v3peer' }
};

// V1 peer receives it:
class GracefulConstraintStore {
  add(constraint: Constraint): void {
    // Don't validate against schema!
    // Just store it.
    this.constraints.push(constraint);
    
    // Optionally track that this path is unknown to our schema
    if (!this.schema.knows(constraint.path)) {
      this.unknownPaths.add(constraint.path);
    }
  }
}

// V1 peer's view ignores the email constraint (not in V1 schema)
// But the constraint is preserved and replicated!

// Later, V1 peer upgrades to V3:
// - Already has the email constraint
// - Just changes their view schema
// - Email immediately appears!

// NO DATA LOSS. NO MIGRATION. Just change the lens.

// Progressive enhancement:
// - V1 peers see V1 view
// - V3 peers see V3 view
// - Both are consistent with their understanding
// - Both preserve all data for future use
```

## Conflict Detection Across Schema Versions

Cross-version conflicts become visible and resolvable:

```/dev/null/cross-version-conflicts.ts#L1-70
// Scenario:
// V1 peer sets: name = "Alice"
// V2 peer sets: fullName = "Bob Smith"
// 
// These are "the same field" according to the mapping.
// This is a conflict!

function detectCrossSchemaConflicts(constraints: Constraint[]): Conflict[] {
  const conflicts: Conflict[] = [];
  const mappings = buildMappingGraph(constraints);
  
  // Group constraints by their canonical path (following mappings)
  const byCanonical = new Map<CanonicalPath, Constraint[]>();
  
  for (const c of constraints.filter(c => c.type === 'value')) {
    const canonical = mappings.getCanonicalPath(c.path);
    const group = byCanonical.get(canonical) ?? [];
    group.push(c);
    byCanonical.set(canonical, group);
  }
  
  // Find groups with multiple conflicting constraints
  for (const [canonical, group] of byCanonical) {
    if (group.length > 1) {
      const values = group.map(c => resolveValue(c, mappings));
      if (!allEqual(values)) {
        conflicts.push({
          canonical,
          constraints: group,
          values,
          resolution: resolveConflict(group)
        });
      }
    }
  }
  
  return conflicts;
}

// UI can show:
// "Conflict on 'user name':
//   - V1 peer set name = 'Alice' (maps to fullName)
//   - V2 peer set fullName = 'Bob Smith'
//   - Resolution: 'Bob Smith' wins (higher lamport)"
//
// User can understand and potentially override!
```

## The Ultimate Vision: Schema as Living Document

```/dev/null/living-schema.ts#L1-90
// Schema isn't a static thing defined at deploy time.
// Schema is part of the collaborative document!

class CollaborativeSchemaDocument {
  private constraints: ConstraintStore;
  
  // Schema definitions are constraints like any other
  defineSchema(schema: SchemaDefinition): void {
    this.constraints.add({
      type: 'schema-definition',
      version: schema.version,
      definition: schema,
      // Schema constraints use CRDT semantics too!
      metadata: { lamport: this.nextLamport(), peer: this.peerId }
    });
  }
  
  // Schema mappings are constraints
  defineMigration(from: string, to: string, mappings: Mapping[]): void {
    this.constraints.add({
      type: 'schema-migration',
      fromVersion: from,
      toVersion: to,
      mappings,
      metadata: { lamport: this.nextLamport(), peer: this.peerId }
    });
  }
  
  // Peers can propose schema changes collaboratively!
  proposeSchemaChange(change: SchemaChange): void {
    this.constraints.add({
      type: 'schema-proposal',
      change,
      status: 'proposed',
      proposedBy: this.peerId,
      metadata: { lamport: this.nextLamport(), peer: this.peerId }
    });
  }
  
  // Peers can vote/approve schema changes
  approveSchemaChange(proposalId: ConstraintId): void {
    this.constraints.add({
      type: 'schema-approval',
      proposal: proposalId,
      approvedBy: this.peerId,
      metadata: { lamport: this.nextLamport(), peer: this.peerId }
    });
  }
  
  // Solver can determine "active" schema based on approval constraints
  getActiveSchema(): SchemaDefinition {
    const proposals = this.constraints.filter(c => c.type === 'schema-proposal');
    const approvals = this.constraints.filter(c => c.type === 'schema-approval');
    
    // Find proposals with sufficient approvals
    // (Could use different consensus mechanisms)
    for (const proposal of proposals.sortByLamport().reverse()) {
      const approvalCount = approvals.filter(a => a.proposal === proposal.id).length;
      if (approvalCount >= this.approvalThreshold) {
        return proposal.change;
      }
    }
    
    return this.defaultSchema;
  }
}

// This enables:
// - Decentralized schema evolution
// - No single point of control
// - Gradual rollout (peers adopt when ready)
// - Automatic backward compatibility
// - Full history of schema changes
```

## Summary: Schema Evolution Transformed

| Aspect | Traditional | Constraint-Based |
|--------|-------------|------------------|
| **Schema location** | Hardcoded in application | Constraints in document |
| **Migration** | Transform all data | Add mapping constraints |
| **Multi-version** | Complex translation layer | Multiple views, same constraints |
| **Unknown fields** | Error or drop | Preserve, ignore in view |
| **Rollback** | Restore backup | Change view schema |
| **Coordination** | Big bang or negotiation | Eventually consistent |
| **Offline peers** | Nightmare | Just works™ |
| **Conflicts** | Hidden in translation | Visible, resolvable |

The fundamental insight: **Schema is interpretation, not structure.** 

In constraint-based CRDTs:
- The constraint set is schema-agnostic
- Merge is always union (trivially works across versions)
- Schema is a lens/view over constraints
- Migration is adding mapping constraints, not transforming data
- Multiple schema versions can coexist indefinitely
- Peers upgrade their view independently, without coordination

This doesn't make schema evolution *trivial*—you still need to think carefully about mappings and conflict resolution. But it removes the *coordination* problem entirely, which is the hardest part in distributed systems.


## The Universal CRDT Property

**All convergent systems decompose into:**

```
result = solve(⋃ constraints)
```

Where:
- **⋃ (collection)** is commutative, associative, idempotent (set union)
- **solve** is a deterministic function

**Convergence comes from collection. Semantics live in solve.**

—

**What distinguishes CRDTs is not whether this decomposition exists—it always does—but whether `solve` is compositional:**

| System               | solve(A ∪ B) = ?          | Property          |
| -------------------- | ------------------------- | ----------------- |
| Counter              | solve(A) + solve(B)       | Compositional     |
| Fugue                | merge(solve(A), solve(B)) | Compositional     |
| LWW-Map              | merge(solve(A), solve(B)) | Compositional     |
| Dependent predicates | must recompute from A ∪ B | Non-compositional |
| Timestamped mult/add | must recompute from A ∪ B | Non-compositional |

**Compositional solve enables incremental updates.**
**Non-compositional solve requires full recomputation but still converges.**

—

The Applicative/Monadic distinction is really:
- **Applicative**: `solve` is compositional (incremental)
- **Monadic**: `solve` requires the complete constraint set (batch)

Both converge. CRDTs optimize for the Applicative case.

—

#  Constraints must be replicated data, not application logic

When constraints live in application code:
- Different peers/versions check different rules
- Validity diverges even when data converges
- No introspection ("why is this invalid?")
- No solver assistance
- Schema evolution means code deploys, not data sync

When constraints are replicated data:
- All peers agree on what's valid (convergent validity)
- Constraints sync like any other data
- Introspection works (constraints are queryable)
- Solvers can help (they see the full constraint set)
- Schema evolution is just adding constraints

---

**Where solving happens is flexible. Where constraints live is not.**

```
┌─────────────────────────────────────┐
│           Replicated Data           │
│  ┌───────────┐    ┌──────────────┐  │
│  │  Values   │    │ Constraints  │  │  ← Both must be here
│  └───────────┘    └──────────────┘  │
└─────────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────┐
│   Solver (internal or external)     │  ← This can be anywhere
└─────────────────────────────────────┘
```
