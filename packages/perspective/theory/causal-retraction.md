# Causal Retraction

## The Monotonic Growth Paradox

CCS derives its convergence guarantee from a single, beautiful fact: constraint sets form a join-semilattice under union (∪). Merge is commutative, associative, and idempotent. Constraint sets only grow.

But real systems need constraints to become _inactive_:

- **Undo**: "I retract my assertion that x = 5"
- **Schema evolution**: "The mapping from `name` to `fullName` supersedes the old `name` path"
- **Compaction**: "These 10,000 dominated constraints can be garbage-collected"
- **Soft constraints**: "This preference has been overridden"

If we simply remove constraints from the set, we break the semilattice. Removal is not monotonic under union: if replica A removes constraint c and replica B hasn't, then A ∪ B puts c back. We've lost convergence.

The standard CRDT solution is tombstones — but CCS can do something more principled. Because constraints are first-class replicated data with causal metadata, we can define _retraction as a constraint_, with dominance determined by causal ordering.

## Retractions as First-Class Constraints

A retraction is not the removal of a constraint. It is the _addition_ of a new constraint that asserts: "constraint c should not participate in solving."

```/dev/null/retraction-definition.ts#L1-25
// A retraction is a constraint like any other.
// It carries the same metadata (OpId, Lamport, PeerID).
// Its assertion targets another constraint by ID.

interface Retraction {
  type: 'retract';
  target: OpId;        // The constraint being retracted
  id: OpId;            // This retraction's own identity
  peer: PeerID;
  lamport: Lamport;
}

// The constraint set still only grows:
//   C' = C ∪ { retract(c₁₇) }
//
// Union still works:
//   (C ∪ {retract(c₁₇)}) ∪ C = C ∪ {retract(c₁₇)}  ✓ idempotent
//   A ∪ B = B ∪ A                                       ✓ commutative
//   (A ∪ B) ∪ C = A ∪ (B ∪ C)                           ✓ associative
//
// The semilattice is preserved. We have not removed anything.
// We have added information: "c₁₇ is retracted."
```

The constraint set grows monotonically. What changes is the **active set** — the subset of constraints the solver actually considers.

## The Retraction DAG

Retractions induce a directed graph over the constraint set.

**Definition.** The _retraction DAG_ over a constraint set C is a directed graph G = (C, E) where there is an edge r → c iff r ∈ C is a retraction targeting c ∈ C.

```/dev/null/retraction-dag.ts#L1-30
// Example:
//
//   c₁: set(x, 5)          — value constraint
//   c₂: set(x, 7)          — value constraint
//   r₃: retract(c₁)        — retraction of c₁
//   r₄: retract(r₃)        — retraction of the retraction
//   r₅: retract(c₁)        — concurrent retraction of c₁ (from another peer)
//
// DAG:
//
//   r₄ ──→ r₃ ──→ c₁
//                  ↑
//           r₅ ───┘
//
//   c₂  (no retractors)
```

**Lemma (Acyclicity).** The retraction DAG is acyclic.

_Proof._ A retraction r can only target a constraint c whose OpId is known to the peer that created r. Since a peer must have _observed_ c before it can reference c's OpId, and observation implies causal precedence, every edge r → c satisfies r ≻ c in the causal order. The causal order is a strict partial order (irreflexive, transitive), so the retraction DAG inherits acyclicity. ∎

This acyclicity is not a design choice — it is a _consequence_ of causality. You cannot retract what you have not yet seen.

## The Dominance Relation

Given the retraction DAG, we want to determine which constraints are "active" (should participate in solving) and which are "dominated" (should be ignored).

**Definition.** Let G = (C, E) be a retraction DAG. The _dominance function_ dom: C → {active, dominated} is defined recursively:

1. If c has no retractors in C, then dom(c) = active.
2. If c has at least one retractor r with dom(r) = active, then dom(c) = dominated.
3. If c has retractors but all of them are dominated, then dom(c) = active.

**Theorem (Unique Fixed Point).** The dominance function is well-defined and unique.

_Proof._ Since the retraction DAG is acyclic (by the Acyclicity Lemma), it has a topological order. We compute dom by traversing nodes in reverse topological order (sinks first):

- Nodes with no outgoing retraction edges and no incoming retraction edges are value constraints with no retractors → active.
- Nodes with no incoming retraction edges but with outgoing retraction edges are "leaf" retractions → active.
- For each subsequent node c in reverse topological order, all of c's retractors have already been assigned a status. Apply rules (1)–(3) deterministically.

Since each node's status depends only on its retractors' statuses, and all retractors are computed before their targets, the function is total and deterministic. ∎

**Corollary (Convergence).** If two replicas have the same constraint set C, they compute the same dominance function, the same active set, and therefore (given a deterministic solver) the same state.

## The Active Set

**Definition.** The _active set_ of a constraint set C is:

$$\text{Active}(C) = \{ c \in C \mid \text{dom}(c) = \text{active} \wedge c \text{ is not a retraction} \}$$

The solver receives only the active set:

```/dev/null/active-set.ts#L1-15
// The solver contract becomes:
//
//   state = solve(Active(C))
//
// Where Active(C) filters out:
//   1. Dominated constraints (retracted and not un-retracted)
//   2. Retractions themselves (they are meta-constraints, not value constraints)
//
// The solver never sees retractions. It sees the same types of
// constraints it always did — just fewer of them.
```

This separation is crucial: **the solver is unchanged**. All retraction logic lives in the Active computation, which is a preprocessing step. The LWW solver, the Fugue solver, any future solver — none of them need to understand retraction.

## Parity: Why Retraction of Retraction Works

The dominance relation has an elegant parity structure. Consider a retraction chain:

```parity.ts
// Chain of length 0: c₁ (value constraint, no retractors)
//   dom(c₁) = active
//
// Chain of length 1: r₂ → c₁
//   dom(r₂) = active (no retractors)
//   dom(c₁) = dominated (has active retractor r₂)
//
// Chain of length 2: r₃ → r₂ → c₁
//   dom(r₃) = active
//   dom(r₂) = dominated (retracted by active r₃)
//   dom(c₁) = active (all retractors are dominated)
//
// Chain of length 3: r₄ → r₃ → r₂ → c₁
//   dom(r₄) = active
//   dom(r₃) = dominated
//   dom(r₂) = active (r₃ is dominated, so r₂ "comes back")
//   dom(c₁) = dominated (r₂ is active)

// In a pure chain, the parity of the distance to the chain tip
// determines status:
//   even distance from tip → active
//   odd distance from tip  → dominated
//
// This gives us undo/redo for free:
//   c₁         → x = 5 is asserted         (active)
//   retract(c₁) → undo: x = 5 is retracted (c₁ dominated)
//   retract(retract(c₁)) → redo: x = 5 is back (c₁ active)
```

But real systems have DAGs, not chains. A constraint may have multiple concurrent retractors.

## Concurrent Retraction: The DAG Cases

The dominance relation handles concurrency naturally. Let's examine the key cases:

**Case 1: Concurrent retraction (convergent).**
Alice and Bob both retract c₁.

```/dev/null/concurrent-retract-1.ts#L1-15
//   rₐ ──→ c₁ ←── r_b
//
//   dom(rₐ) = active (no retractors)
//   dom(r_b) = active (no retractors)
//   dom(c₁) = dominated (has active retractors rₐ AND r_b)
//
// Both retractions agree. c₁ is dominated regardless of
// message delivery order. ✓ Convergent.
```

**Case 2: Retraction and re-retraction (undo survives).**
Alice adds c₁. Bob retracts it (r₂). Alice retracts the retraction (r₃).

```concurrent-retract-2.ts
//   r₃ ──→ r₂ ──→ c₁
//
//   dom(r₃) = active
//   dom(r₂) = dominated (retracted by active r₃)
//   dom(c₁) = active (only retractor r₂ is dominated)
//
// Alice's "undo of undo" restores c₁. ✓
```

**Case 3: Concurrent retraction with partial undo.**
Alice adds c₁. Bob retracts it (r_b). Carol retracts it (r_c). Alice un-retracts Bob's retraction (r_b').

```concurrent-retract-3.ts
//   r_b' ──→ r_b ──→ c₁ ←── r_c
//
//   dom(r_b') = active
//   dom(r_b) = dominated (retracted by active r_b')
//   dom(r_c) = active (no retractors)
//   dom(c₁) = dominated (r_c is active)
//
// Even though Alice un-retracted Bob's retraction,
// Carol's retraction still stands. c₁ remains dominated.
//
// This is the correct semantics: un-retracting one retraction
// does not cancel other independent retractions.
// Each retraction is an independent assertion that must be
// independently addressed.
```

**Case 4: Full concurrent undo.**
Same as Case 3, but Alice also un-retracts Carol's retraction (r_c').

```/dev/null/concurrent-retract-4.ts#L1-16
//   r_b' ──→ r_b ──→ c₁ ←── r_c ←── r_c'
//
//   dom(r_b') = active
//   dom(r_c') = active
//   dom(r_b) = dominated
//   dom(r_c) = dominated
//   dom(c₁) = active (all retractors are dominated)
//
// Both retractions have been un-retracted. c₁ is restored. ✓
```

**Case 5: The diamond — concurrent undo of the same retraction.**
Alice and Bob both un-retract r₂.

```/dev/null/concurrent-retract-5.ts#L1-15
//   r₃ₐ ──→ r₂ ──→ c₁
//   r₃_b ──↗
//
//   dom(r₃ₐ) = active
//   dom(r₃_b) = active
//   dom(r₂) = dominated (has active retractors)
//   dom(c₁) = active (r₂ is dominated)
//
// Redundant un-retractions are harmless. ✓ Idempotent convergence.
```

## Formal Properties

**Theorem (Retraction Monotonicity).** Adding a retraction to the constraint set can only change the target's status from active to dominated, or leave it unchanged. It cannot change an unrelated constraint's status.

_Proof sketch._ Adding retraction r targeting c adds one edge in the DAG. This can only affect dom(c) directly and dom(c') for constraints c' that c is a retractor of (transitively). Constraints not in the retraction subgraph of c are unaffected. ∎

**Theorem (Retraction Commutativity).** For any two retractions r₁, r₂ added to constraint set C:

Active(C ∪ {r₁} ∪ {r₂}) = Active(C ∪ {r₂} ∪ {r₁})

_Proof._ Active is a deterministic function of the constraint set. Set union is commutative. ∎

**Theorem (Retraction Idempotence).** Adding a retraction twice has no effect:

Active(C ∪ {r} ∪ {r}) = Active(C ∪ {r})

_Proof._ Set union is idempotent. ∎

These three properties — monotonicity, commutativity, and idempotence — mean that **the Active function preserves the semilattice guarantees**. Retraction doesn't break CCS convergence; it is _subsumed_ by it.

## The Solver Contract, Revised

With causal retraction, the system architecture gains a new layer:

```revised-architecture.ts
// Before retraction:
//   state = solve(C)
//
// With retraction:
//   state = solve(Active(C))
//
// Where:
//   C is the full constraint set (monotonically growing, semilattice under ∪)
//   Active(C) is the set of non-retraction, non-dominated constraints
//   solve is the same deterministic solver as before
//
// The pipeline:
//
//   Constraint Set C          ← semilattice under ∪ (convergence source)
//        │
//        ▼
//   Retraction DAG            ← acyclic (causality guarantees this)
//        │
//        ▼
//   Dominance computation     ← deterministic (unique fixed point)
//        │
//        ▼
//   Active(C)                 ← what the solver sees
//        │
//        ▼
//   solve(Active(C))          ← the derived state
```

Each step is deterministic. The composition of deterministic functions is deterministic. Same C → same Active(C) → same state. **Convergence is preserved end-to-end.**

## Interaction with Existing Constraint Types

How does retraction interact with the constraint types Prism already implements?

### Map (LWW) + Retraction

```map-retraction.ts
// Without retraction, Map conflict resolution is LWW:
//   c₁: set("name", "Alice", lamport=3, peer=alice)
//   c₂: set("name", "Bob", lamport=5, peer=bob)
//   Winner: c₂ (higher lamport)
//
// With retraction:
//   c₁: set("name", "Alice", lamport=3)
//   c₂: set("name", "Bob", lamport=5)
//   r₃: retract(c₂)
//
//   Active = { c₁ }  (c₂ is dominated by r₃)
//   Winner: c₁
//
// Retraction overrides LWW! The lamport-5 constraint is gone,
// so the lamport-3 constraint wins by default.
//
// This gives us "undo" for Map:
//   1. Bob sets name = "Bob" (lamport 5, wins over Alice's lamport 3)
//   2. Bob retracts his own set
//   3. Alice's original value "Alice" is restored
//
// Note: Bob could also just set name = "Alice" at lamport 7.
// Retraction is for when you want to WITHDRAW your assertion
// without making a new one — letting other constraints determine
// the value.
```

### List (Fugue) + Retraction

```list-retraction.ts
// List constraints are seq_element assertions:
//   c₁: seq_element(id=a, value="X", originLeft=ROOT, originRight=ROOT)
//   c₂: seq_element(id=b, value="Y", originLeft=a, originRight=ROOT)
//
// List state: ["X", "Y"]
//
// Retraction of c₁:
//   r₃: retract(c₁)
//   Active = { c₂ }
//
// But wait — c₂ references c₁ as its originLeft!
// If c₁ is retracted, what happens to c₂'s ordering constraint?
//
// Two options:
//
// Option A: Retraction = deletion (treat retracted element as tombstone)
//   c₂ still uses c₁ as an anchor, but c₁ doesn't appear in output.
//   This is equivalent to the existing delete semantics.
//   List state: ["Y"]
//
// Option B: Retraction = never existed (remove from ordering graph)
//   c₂'s originLeft falls back to c₁'s originLeft (ROOT).
//   This is "as if c₁ was never inserted."
//   List state: ["Y"]  (same in this case, but different in general)
//
// Option A is simpler and consistent with how Fugue handles deletion.
// Option B is more "pure" but requires the solver to handle missing anchors.
//
// RECOMMENDATION: For seq_element constraints, retraction should behave
// as Option A (tombstone semantics). The retracted element remains in
// the ordering graph but is excluded from the visible output.
// This means retraction of a seq_element is equivalent to deletion —
// which is already a constraint type we support.
```

This raises an important design principle:

**Not all constraint types benefit equally from retraction.** For sequence elements, deletion is already the right primitive. Retraction is most powerful for:

- Value assertions (Map entries)
- Schema/mapping constraints
- Policy constraints (conflict resolution preferences)
- Cross-container invariants

## Undo as Retraction

With causal retraction, undo becomes a precise operation with clean semantics:

```undo-retraction.ts
// User action: Alice sets name = "Alice"
//   → c₁: { path: ["name"], assertion: { eq: "Alice" }, peer: alice, lamport: 1 }
//
// User action: Alice sets age = 30
//   → c₂: { path: ["age"], assertion: { eq: 30 }, peer: alice, lamport: 2 }
//
// User action: Bob sets name = "Bob"
//   → c₃: { path: ["name"], assertion: { eq: "Bob" }, peer: bob, lamport: 3 }
//
// State: { name: "Bob", age: 30 }  (c₃ wins by LWW over c₁)
//
// User action: Bob undoes his set
//   → r₄: retract(c₃)
//
// Active = { c₁, c₂ }
// State: { name: "Alice", age: 30 }
//
// Alice's original assertion is RESTORED, not because we computed
// an inverse operation, but because Bob's competing assertion was
// removed from consideration.
//
// User action: Bob redoes
//   → r₅: retract(r₄)
//
// Active = { c₁, c₂, c₃ }  (r₄ is dominated by r₅, so c₃ is active)
// State: { name: "Bob", age: 30 }
//
// Clean undo/redo with no inverse operations, no transformation,
// no complexity. Just retraction and re-retraction.
```

### Undo Scoping

A practical question: what does "undo" mean in a collaborative context? There are several possible scopes, all expressible as retraction:

```undo-scoping.ts
// 1. RETRACT LAST OWN CONSTRAINT
//    "Undo my last action"
//    → retract(myLastConstraint)
//    This is local undo. It never affects other peers' constraints.
//
// 2. RETRACT ALL OWN CONSTRAINTS IN A BATCH
//    "Undo my last transaction" (e.g., a paste that created 50 constraints)
//    → retract(c₁), retract(c₂), ..., retract(c₅₀)
//    Batch retraction. All are independent retractions issued together.
//
// 3. RETRACT ANOTHER PEER'S CONSTRAINT
//    "Reject Bob's edit"
//    → retract(bob's constraint)
//    This is a moderation/review action. The retraction is issued by
//    a different peer than the original constraint's author.
//    Causally valid: the retracting peer has observed the constraint.
//
// 4. SELECTIVE RETRACTION
//    "Undo all my changes to path ['name']"
//    → retract all own constraints matching a path filter
//    This requires querying the constraint store, not a new primitive.
```

All four scopes use the same primitive (retraction). The _policy_ of what to retract is application-level; the _mechanism_ is uniform.

## Compaction Under Causal Retraction

Compaction — garbage collecting constraints that can never affect future solving — is critical for practical systems. Causal retraction makes compaction analysis precise.

**Definition.** A constraint c ∈ C is _permanently dominated_ if:

1. dom(c) = dominated, AND
2. No future constraint can change dom(c) to active.

Condition (2) requires that no peer will ever issue a retraction targeting c's active retractors. This is hard to guarantee in general, but there is a sufficient condition:

**Definition.** The _causal stability frontier_ is a version vector V_stable such that all peers have observed all constraints with OpIds ≤ V_stable. (This is computable if peers periodically exchange version vectors.)

**Theorem (Safe Compaction).** Let c be a constraint dominated by retraction r. If both c and r are causally stable (their OpIds are ≤ V_stable), and retraction-of-retraction is disallowed for causally stable constraints, then {c, r} can be safely removed from C without affecting any future Active computation.

```compaction.ts
// Compaction scenarios:
//
// SAFE: Both c and retract(c) are below the stability frontier.
//   All peers have seen both. No peer can un-retract.
//   → Remove both c and retract(c).
//
// SAFE: Value constraint c is dominated by retract(c), and
//   a newer constraint c' (same path, higher lamport) is also
//   below the stability frontier.
//   → Even if retract(c) is later un-retracted, c would lose
//     to c' anyway. Remove c.
//
// UNSAFE: retract(c) exists but is not yet stable.
//   → Some peer might not have seen retract(c) yet.
//     That peer's Active set still includes c.
//     Cannot remove c.
//
// UNSAFE: retract(c) is stable but another peer might un-retract it.
//   → Must wait for stability of the "no un-retraction" condition.
//     In practice: wait for one more round of stability exchange
//     after retract(c) becomes stable.
```

**The pragmatic approach**: In many applications, retraction-of-retraction (undo-of-undo) is rare. A system could impose a **retraction depth limit** — e.g., "retractions cannot be retracted after they are causally stable" — which makes compaction straightforward without losing practical expressiveness.

## The Algebra of Retraction Depth

We can parameterize CCS by the maximum retraction depth d:

| Depth | Meaning                         | Properties                                                      |
| ----- | ------------------------------- | --------------------------------------------------------------- |
| d = 0 | No retraction                   | Monotonic constraint growth. Simplest model.                    |
| d = 1 | Retract value constraints only  | Undo, but no undo-of-undo. 2P-Set-like. Simple compaction.      |
| d = ∞ | Unlimited retraction depth      | Full undo/redo chains. Most expressive. Hardest to compact.     |
| d = k | Retraction chains up to depth k | Bounded expressiveness. Compactable after stability at depth k. |

```depth-algebra.ts
// At depth d = 1:
//   - Value constraints can be retracted.
//   - Retractions cannot be retracted.
//   - Once retracted, a constraint is permanently dominated
//     (after causal stability).
//   - Undo: retract the constraint. Redo: issue a NEW constraint.
//   - This is the SIMPLEST useful model.
//
// At depth d = ∞:
//   - Any constraint (including retractions) can be retracted.
//   - Undo/redo chains of arbitrary length.
//   - A constraint's status can oscillate between active and
//     dominated as retractions and un-retractions arrive.
//   - Compaction requires causal stability of the ENTIRE chain.
//   - This is the MOST EXPRESSIVE model.
//
// At depth d = 2:
//   - Value constraints can be retracted (undo).
//   - Retractions can be retracted (redo).
//   - Re-retractions cannot be retracted.
//   - Enough for undo + redo. Compaction at stability + 2 rounds.
//   - A GOOD PRACTICAL DEFAULT.
//
// The depth parameter does not affect convergence.
// It only affects what constraints peers are allowed to create.
// All depths produce a valid semilattice.
```

**Recommendation for Prism**: Start with d = 1 (retractions are permanent). This gives undo support with simple compaction semantics. If undo-of-undo proves necessary, upgrade to d = 2.

## Relationship to Existing CRDT Constructions

Causal retraction is not new in isolation — it connects to several well-studied CRDT constructions:

**Observed-Remove Sets (OR-Sets).** An OR-Set allows adding and removing elements, where concurrent add and remove of the same element resolves in favor of the add ("add-wins"). The causal retraction model generalizes this: retraction is "remove," and the dominance relation determines whether a remove wins.

The key difference: OR-Sets hardcode the "add-wins on concurrency" policy. In CCS, the interaction between retraction and the solver is explicit and configurable.

**Multi-Value Registers (MV-Registers).** An MV-Register keeps all concurrently written values. Retraction in CCS achieves something similar but more structured: instead of keeping all concurrent values, the solver resolves them — but you can _retract_ the winner to let a loser through.

**Enable-Wins / Disable-Wins Flags.** The CRDT literature studies flags where concurrent enable/disable operations must be resolved. CCS's retraction depth parameter recasts this: at d = 1 with no undo-of-undo, disable (retraction) wins permanently. At d = ∞, the last operation in the causal chain determines the outcome.

```crdt-connections.ts
// OR-Set ≅ CCS with:
//   - Value constraints as "add"
//   - Retractions as "remove"
//   - "add-wins" policy: if add and remove are concurrent
//     (neither causally precedes the other), add wins
//
// In CCS terms: a retraction only dominates if it causally
// follows the target. Concurrent retraction + value assertion
// means the retraction does NOT dominate (it couldn't have
// observed the assertion). The value assertion is active.
//
// This is precisely the OR-Set semantics, DERIVED from
// the causal dominance definition rather than hardcoded.

// But CCS can also express "remove-wins" by changing the policy:
//   - A retraction dominates its target even if concurrent,
//     as long as they share the same path/key.
//   - This gives "disable-wins" flag semantics.
//
// The causal retraction framework SUBSUMES these CRDT-specific
// constructions as policy choices within a uniform mechanism.
```

## Retraction and the Solver: Separation of Concerns

A critical architectural property: **the solver never sees retractions**. The Active(C) computation strips them out. This means:

1. Existing solvers work unchanged.
2. Retraction logic is a single, shared preprocessing step.
3. New solvers don't need to re-implement retraction handling.
4. The retraction DAG can be optimized independently of solving.

```separation.ts
// Architecture:
//
// ┌────────────────────────────────────────────────┐
// │              Constraint Set C                  │
// │  { c₁, c₂, c₃, r₄, r₅, c₆, r₇, ... }       │
// │  Grows monotonically. Semilattice under ∪.     │
// └────────────────┬───────────────────────────────┘
//                  │
//                  ▼
// ┌────────────────────────────────────────────────┐
// │          Active(C) computation                 │
// │  Build retraction DAG.                         │
// │  Compute dominance (topological traversal).    │
// │  Filter to non-dominated, non-retraction.      │
// └────────────────┬───────────────────────────────┘
//                  │
//                  ▼
// ┌────────────────────────────────────────────────┐
// │          Active constraints only               │
// │  { c₂, c₆, ... }                              │
// │  Solver-ready. No retractions.                 │
// └────────────────┬───────────────────────────────┘
//                  │
//         ┌───────┴────────┐
//         ▼                ▼
// ┌──────────────┐ ┌──────────────┐
// │  Map Solver  │ │  List Solver │  ...
// │  (LWW)       │ │  (Fugue)     │
// └──────────────┘ └──────────────┘
```

## Incremental Active Set Maintenance

Computing Active(C) from scratch on every query is O(|C|). For large constraint sets, we want incremental maintenance:

```incremental-active.ts
// When a new constraint c_new is added to C:
//
// Case 1: c_new is a value constraint (not a retraction).
//   → c_new has no retractors yet, so dom(c_new) = active.
//   → Add c_new to Active set.
//   → No existing constraints change status.
//   Cost: O(1)
//
// Case 2: c_new is a retraction targeting c_target.
//   → dom(c_new) = active (it's new, no retractors).
//   → c_target may become dominated (if it wasn't already).
//   → If c_target was a retraction, c_target's OWN targets may
//     become active (their retractor is now dominated).
//   → This cascades through the retraction DAG rooted at c_target.
//   Cost: O(chain length from c_target to leaves)
//
// In practice, retraction chains are short (depth 1-3),
// so the cascade is O(1) amortized.

// Data structure for incremental maintenance:
//
// For each constraint c, maintain:
//   - retractors: Set<ConstraintId>    (who retracts me)
//   - activeRetractorCount: number     (how many are active)
//   - status: 'active' | 'dominated'
//
// On adding retraction r targeting c:
//   c.retractors.add(r)
//   if dom(r) = active:
//     c.activeRetractorCount++
//     if c.activeRetractorCount === 1:  // just became dominated
//       c.status = 'dominated'
//       // cascade: for each constraint that c retracts,
//       //   decrement their activeRetractorCount
//       propagateDominanceChange(c)
```

## Retraction and Introspection

Retraction enriches the introspection API. Instead of just "who wrote the winning constraint," we can now answer:

```retraction-introspection.ts
// "Why is name = 'Alice'?"
// {
//   value: "Alice",
//   determinedBy: c₁ (alice, lamport 3),
//   activeConstraints: [c₁],
//   retractedConstraints: [
//     {
//       constraint: c₃ (bob, lamport 5, "Bob"),
//       retractedBy: r₄ (bob, lamport 6),
//       note: "Would have won by LWW if not retracted"
//     }
//   ],
//   explanation: "Bob's higher-lamport assertion was retracted.
//                 Alice's assertion wins by default."
// }

// "What would happen if we un-retracted Bob's constraint?"
// whatIf(retract(r₄)):
// {
//   value: "Bob",
//   explanation: "Bob's lamport-5 assertion wins over Alice's lamport-3"
// }

// "Show me the full retraction history for this path"
// retractionHistory(["name"]):
// [
//   { t=1, constraint: c₁, set name="Alice", status: active },
//   { t=3, constraint: c₃, set name="Bob", status: dominated },
//   { t=4, retraction: r₄, retract c₃, status: active },
// ]
```

## Open Questions

Several questions remain open and are worth future investigation:

**1. Retraction and Intention Preservation.** If Alice retracts her constraint c₁ on path P, should this be interpreted as "I no longer assert this specific value" or "I want path P to be determined by others"? The current model implements the former. The latter might require a "yield" constraint type distinct from retraction.

**2. Transitive Retraction.** Should retracting a "batch" constraint (one that created multiple sub-constraints) automatically retract all sub-constraints? This is a convenience question, not a semantic one — the application can always issue individual retractions — but batch retraction would be ergonomically useful. A `retract_batch(batchId)` constraint type could target all constraints sharing a batch identifier.

**3. Retraction and Schema Mappings.** If a mapping constraint M (mapping path A to path B) is retracted, what happens to the derived values that M produced? They disappear from the active set, which is correct. But if constraints were _created_ based on M's derived values (by peers who observed them), those constraints persist. The retraction of a mapping doesn't retract downstream constraints — only the mapping itself. This is arguably the right semantics (constraints are independent), but deserves careful analysis.

**4. Retraction Cost in the Constraint Set.** Each retraction is a constraint that persists forever (until compacted). A system with frequent undo/redo accumulates retraction constraints. Is there a way to "fold" a retraction chain into a single "net status" constraint once all peers have observed the full chain? This is related to compaction but specific to retraction chains.

## Summary: Causal Retraction

| Property                  | Guarantee                                                                |
| ------------------------- | ------------------------------------------------------------------------ |
| **Semilattice preserved** | Constraint set still grows monotonically under ∪                         |
| **Convergence preserved** | Active(C) is deterministic; solve(Active(C)) converges                   |
| **Causality enforced**    | You can only retract what you've observed (DAG is acyclic)               |
| **Undo**                  | Retract a constraint → it leaves the active set                          |
| **Redo**                  | Retract the retraction → original constraint returns (depth ≥ 2)         |
| **Concurrent retraction** | Multiple retractions of same target: all must be un-retracted to restore |
| **Solver unchanged**      | Solver sees Active(C), never sees retractions directly                   |
| **Compaction**            | Safe once constraint + retraction are causally stable                    |
| **Incremental**           | Adding a retraction cascades O(chain depth), typically O(1)              |

The key insight: **retraction is not the opposite of assertion. It is a new assertion — an assertion about the status of a previous assertion.** The constraint set only grows. The Active set may shrink. And the semilattice guarantees hold throughout.
