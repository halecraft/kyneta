# Incremental Evaluation for CCS

## Overview

This document provides the theoretical foundation for incremental evaluation
in the Prism CCS engine.  It maps the solver pipeline defined in
[unified-engine.md](./unified-engine.md) §7.2 onto the algebraic framework
of DBSP (Budiu & McSherry, 2023), proving that the pipeline can be
incrementalized stage-by-stage while preserving correctness.

The key result: inserting a constraint into a store of size |S| produces
a reality update in O(|Δ|) work, where |Δ| is the number of affected slots,
rather than O(|S|) full recomputation.

### Notation

We follow the DBSP paper's notation throughout:

| Symbol | Meaning |
|--------|---------|
| S_A | The type of streams over values in A |
| s[t] | The value of stream s at time t |
| ↑Q | Lift: apply scalar operator Q pointwise to a stream |
| z⁻¹ | Delay: (z⁻¹(s))[t] = s[t−1], with s[−1] = 0 |
| I | Integration: I(s)[t] = Σ_{i≤t} s[i] |
| D | Differentiation: D(s)[t] = s[t] − s[t−1] |
| Q^Δ | Incrementalization of Q: Q^Δ = D ∘ Q ∘ I |

---

## 1. The Group Structure: Z-Sets over Constraints

DBSP requires values to live in an abelian group — a set with an
associative, commutative addition operator and inverses.  Databases are
not groups (sets have no subtraction), so DBSP uses Z-sets: functions
from elements to integer weights, with pointwise addition.

### 1.1 Definition

A **Z-set** over a universe U is a function w: U → Z with finite support
(only finitely many elements have non-zero weight).

```
ZSet<U> = { w: U → Z | support(w) is finite }
```

Addition is pointwise: `(a + b)(x) = a(x) + b(x)`.
Negation flips weights: `(−a)(x) = −a(x)`.
The zero element maps everything to 0.

This forms an abelian group.  Z-sets generalize both sets (all weights
are 0 or 1) and multisets (all weights are ≥ 0).  Negative weights
represent deletions — an element with weight −1 is "anti-data" that
cancels a +1 when summed.

### 1.2 The `distinct` Operator

The **distinct** operator clamps negative weights to zero, recovering a
set from a Z-set:

```
distinct(w)(x) = max(0, w(x))
```

Note: `distinct` is not linear (it doesn't distribute over +), but it
is monotone and positive (preserves non-negative weights).  This matters
for the treatment of negation in Datalog.

### 1.3 Z-Sets for CCS

In CCS, the universe U is the set of all possible constraints.
A constraint store S at time t is a Z-set where every present constraint
has weight 1:

```
S[t](c) = 1   if c ∈ store at time t
S[t](c) = 0   otherwise
```

An insertion of constraint c is the delta `δ_c` where `δ_c(c) = 1` and
`δ_c(x) = 0` for all x ≠ c.

The store at time t is the integration of all deltas:

```
S[t] = I(δ)[t] = δ[0] + δ[1] + ... + δ[t]
```

This is a Z-set with weight 1 for every constraint inserted up to time t.
Because constraints are immutable and the store grows monotonically
(pre-compaction), all weights are 0 or 1 — no negative weights appear
in the store itself.  Negative weights arise in intermediate pipeline
stages (e.g., retraction flipping a constraint from active to dominated).

---

## 2. The Pipeline as a DBSP Circuit

### 2.1 Current Pipeline

The solver pipeline (§7.2) is not a linear chain — it is a **directed
acyclic graph** (DAG) with fan-out and multi-input joins:

```
S ──→ F ──→ C ──┬──→ X ──────────────┬──→ K ──→ Reality
                │                     │
                └──→ A ──┬──→ P ──→ E ──→ R ─┘
                         │    ↑
                         │    │
                         │    X (structure index, read)
                         │
                         └──→ K (active constraints, read)
```

The validity output **fans out** to three consumers: the structure index
builder X, the retraction stage A, and (via A) the projection stage P.
The projection stage P takes **two inputs**: the active set from A and
the structure index from X (it joins each value constraint with the
index to derive slot identity).  The skeleton builder K takes **three
inputs**: the structure index, the active constraints, and the resolution
result.

Writing each stage as a named operator with its actual inputs:

```
F = Filter_V          S → S_V                  version-parameterized filter
C = Valid             S_V → V                  validity filter
X = StructIndex       V → X                    structure index (from valid set)
A = Active            V → A                    retraction / dominance
P = Project           (A, X) → Facts           projection (join: active × index)
E = Evaluate          (Facts, Rules) → DB      Datalog fixed-point evaluation
R = Resolve           DB → Res                 extract winners + fugue ordering
K = Skeleton          (X, A, Res) → T          build reality tree
```

In the current implementation, every `solve()` call evaluates this entire
DAG from scratch over all |S| constraints.  Cost: O(|S|) per call.

### 2.2 As a Lifted Circuit

In DBSP terms, time t corresponds to the t-th constraint insertion.
The stream of store snapshots is:

```
S ∈ S_{ZSet<Constraint>}
S[t] = the full store after t insertions
```

The pipeline is a lifted DBSP **circuit** — a DAG of operators connected
by streams — applied to this input stream.  DBSP's computational model
is explicitly circuits with fan-out and multi-input operators, not just
linear composition (see DBSP §2, "computational circuits").  Each wire
in the circuit carries a stream; each box is a stream operator.

### 2.3 Incrementalization of Circuits

DBSP incrementalizes circuits by incrementalizing each operator
independently.  The chain rule `(Q₁ ∘ Q₂)^Δ = Q₁^Δ ∘ Q₂^Δ` handles
linear composition; for multi-input operators and fan-out, the general
circuit incrementalization applies:

- **Fan-out:** A shared wire that feeds multiple downstream operators
  delivers the same delta to each.  When the validity stage emits
  Δ_valid, both the structure index stage and the retraction stage
  receive it.

- **Multi-input operators (joins):** An operator Q(a, b) with two inputs
  receives deltas from both.  Its incremental version maintains the
  accumulated value of each input and computes:
  `Q^Δ(Δa, Δb) = Q(Δa, b[t-1]) + Q(a[t-1], Δb) + Q(Δa, Δb)`.
  This is the standard DBSP bilinear treatment (§3.2 below).

- **Synchronization:** In our pipeline, all deltas originate from a
  single event (one constraint insertion).  The delta propagates
  through the DAG in topological order.  There is no issue of
  asynchronous arrival — each stage processes its input deltas in
  a well-defined order within a single synchronous step.

The incremental circuit:

```
Δc ──→ F^Δ ──→ C^Δ ──┬──→ X^Δ ─────────────────┬──→ K^Δ ──→ ΔReality
                      │                          │
                      └──→ A^Δ ──┬──→ P^Δ ──→ E^Δ ──→ R^Δ ─┘
                                 │    ↑
                                 │    │
                                 │    X (accumulated index)
                                 │
                                 └──→ K^Δ (active constraints)
```

Each stage processes only the delta from its upstream inputs, not the
full accumulated state.  Multi-input stages (P, K) receive deltas from
all their inputs and join them against accumulated state from the others.

---

## 3. Classifying Pipeline Stages

DBSP distinguishes three classes of operators based on their
incrementalization cost:

### 3.1 Linear Operators

An operator Q is **linear** if `Q(a + b) = Q(a) + Q(b)`.

**Property:** Linear operators are self-incremental: `Q^Δ = Q`.
Processing a delta through a linear operator produces the correct output
delta directly, with no accumulated state.

The following pipeline stages are linear (single-input, no joins):

| Stage | Why Linear |
|-------|-----------|
| Filter_V (no-version case) | Selection σ_P is linear over Z-sets: σ_P(a + b) = σ_P(a) + σ_P(b) |
| StructIndex (structure grouping) | Groups structure constraints by slot identity; each constraint contributes independently |
| Resolve | Per-fact extraction from Datalog derived database to typed result |

For these stages, the incremental version is trivial: apply the same
function to the delta.  A new seq structure constraint produces one new
slot group entry.  A new `winner` derived fact produces one new
`ResolvedWinner`.

### 3.2 Bilinear and Stateful Operators

An operator Q is **bilinear** if it is linear in each argument separately:
`Q(a + b, c) = Q(a, c) + Q(b, c)` and `Q(a, b + c) = Q(a, b) + Q(a, c)`.

Joins are the canonical bilinear operator.  For a join Q(a, b), the
incremental version is:

```
Q^Δ(Δa, Δb) = Q(Δa, b[t-1]) + Q(a[t-1], Δb) + Q(Δa, Δb)
```

This requires storing the previous accumulated values of both inputs
(`a[t-1]` and `b[t-1]`), but processes work proportional to |Δa| + |Δb|,
not |a| + |b|.

The following stages are bilinear or stateful:

**Validity** (C): This stage is **stateful with a non-trivial update
path**.  Checking a single new non-authority constraint is O(1) (check
its signature and look up capability in the accumulated AuthorityState).
But the AuthorityState itself is not a simple append-only accumulator.

The current implementation (`computeAuthority`) replays all authority
constraints from scratch on every call.  The revoke-wins semantics for
concurrent grant/revoke means the authority state at any causal moment
depends on the full causal ordering of authority constraints — adding a
new authority constraint can retroactively change the capability set at
causal moments between existing constraints.

Incremental validity therefore requires a **persistent authority data
structure** that can be updated without full replay.  The design:
- Maintain an accumulated `AuthorityState` as persistent state.
- On non-authority Δc: check validity of c against accumulated
  AuthorityState → emit c in Δ_valid or Δ_invalid.  O(1).
- On authority Δc: incrementally update the AuthorityState.  Because
  authority uses revoke-wins (not LWW), a new grant can only *add*
  capabilities and a new revoke can only *remove* them.  The update
  is: apply the grant/revoke action, then re-check validity of
  constraints by the target peer whose status may have changed.
  Emit changes to Δ_valid.  O(affected constraints by target peer).
- Index: maintain a per-peer index of constraints for efficient
  re-checking when that peer's capabilities change.

This is the most design-intensive kernel stage to incrementalize —
the replay-from-scratch architecture must be replaced with a
persistent structure.

**Retraction** (A): The retraction graph is accumulated state.
A new retract constraint triggers a dominance cascade — changing some
constraints from active→dominated or dominated→active.  This is the
DBSP pattern for a stateful operator with a delta trigger:
- Maintain the retraction graph and dominance cache.
- On Δc: if c is a retract, cascade from c.target.  Emit the set of
  constraints whose active/dominated status changed as a Z-set delta
  (newly-dominated = weight −1 in active set, newly-active = weight +1).
- On Δc: if c is not a retract, c enters as active (weight +1 in active set).
- Cost: O(retraction chain depth), typically O(1).

**Projection** (P): Projection is a **join** between the active set and
the structure index — each value constraint's `target` CnId is resolved
through the structure index to derive its slot identity.  This makes P
bilinear over (active constraints × structure index):

```
P^Δ(Δ_active, Δ_index) =
    P(Δ_active, index[t-1])         // project new/removed active constraints against current index
  + P(active[t-1], Δ_index)         // re-project existing active values whose target appears in new index entries
  + P(Δ_active, Δ_index)            // cross-term (new constraint targeting a simultaneously new structure)
```

In practice, the first term dominates: a new active value constraint is
projected against the existing index.  The second term handles the case
where a structure constraint arrives *after* a value constraint targeting
it — the previously-orphaned value becomes projectable.  The third term
handles the rare case where both arrive in the same delta batch.

State: accumulated active set (for re-projection on index changes),
accumulated structure index (for projection of new active constraints).

### 3.3 Recursive Operators

**Datalog evaluation** (E) is a recursive fixed-point computation.
DBSP §4–5 shows that:

1. Naive Datalog evaluation is a circuit with a feedback loop
   (δ₀ → I → ↑R → ↑distinct → D → ∫).
2. Semi-naive evaluation is the incrementalization of naive evaluation —
   the circuit is transformed by the chain rule into
   (δ₀ → R^Δ → distinct^Δ → ∫), which is exactly the standard
   semi-naive algorithm.
3. Incremental recursive evaluation (§5) uses nested streams: the outer
   stream represents changes to input relations across time, and the
   inner stream represents fixed-point iterations within one time step.

Our evaluator already implements semi-naive (point 2).  For full
incrementalization (point 3), we need:

- **Accumulated derived database**: keep the Datalog `Database` across
  `solve()` calls instead of rebuilding from scratch.
- **Delta input**: feed only the changed ground facts (from P^Δ) into
  the evaluator.
- **Delta output**: the evaluator produces only the changed derived facts.

For **monotone rules** (no negation, no aggregation): new input facts can
only produce new derived facts, never retract old ones.  The incremental
evaluation adds the new input facts to the accumulated database and runs
semi-naive from the delta, producing new derived facts.  This is correct
because Datalog's T_P operator is monotone — more input → more output.

For **stratified negation** (our LWW `superseded`/`winner` rules): a new
input fact might change a negated condition, invalidating previously
derived facts.  DBSP handles this via Z-sets: the incremental evaluator
tracks fact weights, and a new fact that satisfies a previously-failed
negation produces a −1 weight for the invalidated derivation plus a +1
for the new derivation.  The net delta propagates through.

For the **specific case of LWW + Fugue** (our default rules): the
structure is constrained enough that the delta is small:

- A new `active_value` fact either supersedes the current winner (one
  slot changes) or doesn't (no change).  Delta: at most 2 facts
  (one new `winner`, one removed `winner`).  O(1).
- A new `active_structure_seq` fact adds one element to the Fugue tree.
  Delta: O(siblings) new `fugue_before` pairs for the parent, typically
  O(1) for append-style insertion.

### 3.4 The Skeleton Builder

The skeleton builder (K) is the final stage.  It constructs a tree from
the structure index, resolved values, and Fugue ordering.  Incrementally:

- **New map child**: insert into parent's children map.  O(1).
- **New seq child**: insert into parent's children at the position
  determined by Fugue ordering.  O(1) for tree update, but O(n)
  if children are stored as an array that must shift (implementation
  concern, not algorithmic).
- **Changed value**: update the node's value field.  O(1).
- **Removed value** (retraction of a value constraint): clear the
  node's value or, for seq, mark as tombstone and remove from
  visible children.  O(1).

The skeleton maintains accumulated state (the current reality tree)
and applies deltas to it.

---

## 4. The Incremental Stage Interface

Each pipeline stage is modeled as a **stateful operator** that
maintains its accumulated state (the I in DBSP's D ∘ Q ∘ I) and
exposes a delta-in / delta-out interface.

### 4.1 The Z-Set Type

```
interface ZSetEntry<T> {
  readonly element: T;
  readonly weight: number;    // +1 = inserted, −1 = removed
}

// A Z-set is a collection of (element, weight) pairs with non-zero weight.
// Keyed by a string identity function for O(1) lookup.
type ZSet<T> = ReadonlyMap<string, ZSetEntry<T>>;
```

Operations:

```
// Pointwise addition of two Z-sets.
add(a, b) → c  where  c(x) = a(x) + b(x), dropping zeros.

// Negation: flip all weights.
negate(a) → b   where  b(x) = −a(x)

// The zero Z-set (empty map).
zero<T>() → ZSet<T>

// Create a singleton Z-set.
singleton(key, element, weight) → ZSet<T>
```

### 4.2 The Stage Interface

```
interface IncrementalStage<In, Out> {
  // Process a delta and return the output delta.
  // Updates internal accumulated state as a side effect.
  step(delta: ZSet<In>): ZSet<Out>;

  // Return the current full materialized output.
  // Equal to I(all previous output deltas).
  current(): Out;

  // Reset to empty state (for cold start or testing).
  reset(): void;
}
```

**Invariant:** For any sequence of deltas d₀, d₁, ..., d_t:

```
current() = Q(d₀ + d₁ + ... + d_t)
```

where Q is the stage's batch (non-incremental) operator.  This is the
fundamental correctness criterion — the accumulated incremental result
must equal the batch result over the accumulated input.

### 4.3 Pipeline Composition

The incremental pipeline is a DAG of stages, not a linear chain:

```
interface IncrementalPipeline {
  // Insert a constraint and return the reality delta.
  insert(c: Constraint): RealityDelta;

  // Get the current full reality.
  current(): Reality;

  // Full recomputation (for verification).
  recompute(): Reality;
}
```

Internally, `insert(c)` propagates the delta through the DAG in
topological order.  Note how the validity delta fans out to two
consumers, and how multi-input stages receive deltas alongside
accumulated state from their other inputs:

```
// 1. Linear prefix
Δ_filtered  = filterStage.step(singleton(c))
Δ_valid     = validityStage.step(Δ_filtered)

// 2. Fan-out: Δ_valid feeds both structure index and retraction
Δ_index     = structIndexStage.step(Δ_valid)
Δ_active    = retractionStage.step(Δ_valid)

// 3. Projection: join of (Δ_active × accumulated index) ∪ (accumulated active × Δ_index)
Δ_facts     = projectionStage.step(Δ_active, Δ_index)

// 4. Evaluation: recursive fixed-point over delta facts
Δ_derived   = evaluationStage.step(Δ_facts)

// 5. Resolution extraction: linear over derived delta
Δ_resolved  = resolutionStage.step(Δ_derived)

// 6. Skeleton: multi-input join of (Δ_resolved, Δ_index, Δ_active)
Δ_reality   = skeletonStage.step(Δ_resolved, Δ_index, Δ_active)
```

Each stage processes only the delta from its upstream inputs.  Fan-out
is handled by delivering the same delta to multiple stages.  Multi-input
stages (projection, skeleton) maintain accumulated state for each input
and join deltas against it, following the DBSP bilinear incrementalization
pattern (§3.2).

The topological ordering guarantees that every stage's inputs are
available before it executes.  Because all deltas originate from a
single event (one constraint insertion), the entire DAG is evaluated
synchronously within a single `insert()` call.

---

## 5. Stage-by-Stage Incrementalization

### 5.1 Version Filter (F)

**Batch:** `F(S, V) = { c ∈ S | c.id ≤ V }`

**Incremental:** For the common case (no version parameter, solving at
current time), this is the identity — every new constraint passes.
For version-parameterized solving (time travel), the filter checks
`c.id ≤ V` and either passes (+1) or blocks (zero delta).

**State:** None (stateless, linear).

**Cost:** O(1) per constraint.

### 5.2 Validity (C)

**Batch:** `C(S_V) = { c ∈ S_V | sig_ok(c) ∧ capable(c, auth(S_V)) }`

**Incremental:**

Case 1 — Δc is not an authority constraint:
  - Check sig_ok(c): O(1).
  - Look up required capability in accumulated AuthorityState: O(1).
  - Emit {c: +1} in Δ_valid if valid, else {c: +1} in Δ_invalid.
  - Total: O(1).

Case 2 — Δc is an authority constraint:
  - Update accumulated AuthorityState with the new grant/revoke.
  - Re-check validity of constraints by the target peer:
    For each constraint c' by target_peer in the accumulated valid/invalid sets,
    recompute `capable(c', auth')`.  If status changed, emit
    {c': +1} (newly valid) or {c': −1} (newly invalid) in Δ_valid.
  - Total: O(constraints by target_peer).
  - Bounded by the stability frontier in practice.

**State:** Accumulated AuthorityState, accumulated valid set, accumulated
invalid set (for re-checking on authority changes).

**Cost:** O(1) typical; O(affected constraints) for authority changes.

### 5.3 Structure Index (X)

**Batch:** `X(V) = buildStructureIndex(V)`

**Incremental:**

The structure index is built from structure constraints, which are
permanent (never retracted).  A new structure constraint either:
  - Creates a new SlotGroup (new root, new map key, new seq element).
  - Joins an existing SlotGroup (map child with same parent+key from
    another peer).

The delta is the new or modified SlotGroup.

**State:** The mutable StructureIndex.

**Cost:** O(1) per structure constraint.

### 5.4 Retraction (A)

**Batch:** `A(V) = { c ∈ V | dom(c) = active }`

**Incremental:**

Case 1 — Δc is not a retract:
  - c is active (no retractors yet).
  - Emit {c: +1} in Δ_active.
  - O(1).

Case 2 — Δc is a retract:
  - Validate structural rules (target-in-refs, no-structure, no-authority).
  - If valid: add edge to retraction graph, cascade dominance.
  - Cascade: c.target becomes dominated ({target: −1} in Δ_active).
    If target was itself a retract, target's own target may become
    active ({target.target: +1}).  Continue until cascade terminates.
  - Also emit {c: +1} in Δ_active (the retract constraint itself is active).
  - O(retraction chain depth), bounded by maxDepth (default 2).

The output Δ_active is a Z-set: +1 for newly active constraints,
−1 for newly dominated constraints.

**State:** The retraction graph (edges), dominance cache, depth cache.

**Cost:** O(chain depth), typically O(1).

### 5.5 Projection (P)

**Batch:** `P(A, X) = projectToFacts(A, X)`

**Incremental:**

Projection is a join between the active set and the structure index
(see §3.2).  The incremental version handles three cases:

Case 1 — Δ_active arrives (new/removed active constraints):
  - For each (c, +1) in Δ_active: look up c's target in the
    accumulated structure index.  If found, emit the corresponding
    active_value / active_structure_seq / constraint_peer facts with
    weight +1.  If not found, record c as orphaned (pending re-projection
    if the structure arrives later).
  - For each (c, −1) in Δ_active: emit the same facts with weight −1.
    Remove from orphaned set if present.

Case 2 — Δ_index arrives (new structure constraints):
  - For each new structure in Δ_index: check the orphaned set for
    value constraints whose target matches the new structure's CnId.
    For each match, project and emit the fact with weight +1.
    Remove from orphaned set.

Case 3 — Both arrive simultaneously (same insertion triggers both):
  - Process Δ_index first (add to accumulated index), then Δ_active
    (project against the now-updated index).  This naturally handles
    the cross-term.

**State:** Accumulated structure index (for projecting new active
constraints), accumulated active value constraints (the orphaned set,
for re-projection when structures arrive).

**Cost:** O(|Δ_active| + |Δ_index| × orphaned matches), typically O(1).

### 5.6 Datalog Evaluation (E)

**Batch:** `E(Facts, Rules) = evaluate(Rules, Facts)`

**Incremental:**

This is the most sophisticated stage.  DBSP §4–5 provides the
theoretical framework; the practical implementation is:

**Maintain the accumulated Database across calls.**  The Database
contains both ground facts (from projection) and derived facts (from
rule evaluation).

When Δ_facts arrives (a Z-set of changed ground facts):

1. Apply Δ_facts to the accumulated Database:
   - +1 entries: add the fact.
   - −1 entries: remove the fact.

2. Determine affected strata.  A changed ground fact affects stratum k
   if stratum k's rules reference the fact's predicate.

3. For each affected stratum (in order):
   - Run semi-naive evaluation from the changed facts as the initial
     delta.
   - For strata with negation: check if any negated condition's truth
     value changed.  If so, recompute derivations that depended on
     that negation.  This may produce −1 entries (retracting previously
     derived facts) and +1 entries (new derivations).
   - Collect Δ_derived: the net change to derived facts.

4. If a lower stratum's output changed, propagate the delta to higher
   strata.

**The LWW/Fugue fast path:** When the native solver fast path is active
(default rules, no custom Layer 2+ rules), the Datalog evaluator is
bypassed entirely.  The incremental version of the native solver is
even simpler:

  - LWW: compare the new value's (lamport, peer) against the current
    winner for the slot.  If it wins, emit {old_winner: −1, new_winner: +1}.
    O(1).
  - Fugue: insert the new element into the Fugue tree, derive the
    new before-pairs for its siblings.  O(siblings), typically O(1).

**State:** Accumulated Database (ground + derived facts), or native
solver state (per-slot winners, Fugue trees).

**Cost:** O(|Δ_facts| × rule fan-out), typically O(1) for LWW/Fugue.

### 5.7 Resolution Extraction (R)

**Batch:** `R(DB) = extractResolution(DB)`

**Incremental:**

Resolution extraction is linear: each derived fact maps independently
to a typed result.  For a Z-set delta of derived facts:

  - A new `winner(Slot, CnId, Value)` fact with weight +1: update the
    winners map.  A `winner` fact with weight −1: remove from winners map.
  - A new `fugue_before(Parent, A, B)` fact with weight +1: add to
    the pairs for that parent.  Weight −1: remove.

**State:** Accumulated ResolutionResult (winners map, fuguePairs map).

**Cost:** O(|Δ_derived|), typically O(1).

### 5.8 Skeleton / Reality Tree (K)

**Batch:** `K(X, A, Res) = buildSkeleton(X, A, Res)`

**Incremental:**

The skeleton maintains the reality tree as mutable state and applies
deltas:

  - **New map structure** (from Δ_index): create a new child node in
    the parent's children map.  O(1).
  - **New seq structure** (from Δ_index): create a new child node,
    insert at the position determined by Fugue ordering from Δ_resolved.
    O(1) for tree update.
  - **Changed winner** (from Δ_resolved): update the node's value
    field.  O(1).
  - **Removed winner** (weight −1 in Δ_resolved): for map nodes, the
    value becomes undefined or null (possibly triggering removal if
    no children exist).  For seq nodes, the element becomes a tombstone
    and is removed from visible children.  O(1).

**State:** The mutable Reality tree.

**Cost:** O(|Δ_resolved| + |Δ_index|), typically O(1).

---

## 6. Correctness

### 6.1 The Verification Oracle

The existing batch pipeline (`solveFull`) serves as the correctness
oracle.  For any sequence of constraint insertions, the incremental
pipeline's `current()` must produce an identical Reality to the batch
pipeline's `solve()`.

This is the DBSP correctness guarantee: for any operator Q and any
stream s, `I(Q^Δ(D(s))) = ↑Q(s)`.  The integration of incremental
outputs equals the lifted batch computation.

### 6.2 Testing Strategy

1. **Differential testing:** After each insertion, compare
   `incrementalPipeline.current()` against `solve(store, config)`.
   Any divergence is a bug in the incremental stage.

2. **Z-set invariant testing:** For each stage, verify that
   `I(all output deltas) = batch(accumulated input)`.  This catches
   weight-tracking bugs.

3. **Round-trip testing:** Insert constraints, retract some, undo
   retractions, and verify that the incremental pipeline handles all
   transitions correctly (active→dominated→active).

4. **Stress testing with the existing 759 tests:** Run every existing
   pipeline and integration test through the incremental path and
   verify identical results.

### 6.3 Commutativity

CCS stores are commutative (set union).  The incremental pipeline must
produce the same **final reality** regardless of insertion order.

**Final-state commutativity (guaranteed):**  The accumulated state after
processing deltas d₀, ..., d_t is the same regardless of permutation.
This follows from DBSP's construction: each stage's batch operator is
defined over sets (order-independent), and the incremental version
produces accumulated output equal to the batch output over accumulated
input.

**Delta-stream commutativity (NOT guaranteed):**  The sequence of
intermediate deltas may differ under different insertion orderings.
Insert value A then B may produce deltas `{A: winner}` then
`{A: −winner, B: winner}`, while B then A produces `{B: winner}` then
`{B: −winner, A: winner}`.  The final state is identical, but the delta
stream differs.

**Consequence for downstream consumers:**  Any consumer that depends on
the *current state* (via `current()`) sees consistent results regardless
of insertion order.  Any consumer that subscribes to *delta events*
(e.g., a reactive UI) may observe different intermediate states under
different orderings.  This is inherent to any incremental system —
the intermediate path through state space depends on the order of
mutations, even though the destination does not.

Downstream consumers should be designed to tolerate reordering of
intermediate deltas.  If a consumer requires a specific delta ordering,
it should derive that ordering from the accumulated state, not from the
delta stream.

---

## 7. Settled/Working Sets as Memoization Boundaries

### 7.1 Connection to DBSP

DBSP's integration operator I accumulates all past deltas.  Over time,
the accumulated state grows.  The settled/working partition (§11 of the
spec) is an optimization that divides this accumulated state into two
regions:

- **Settled (frozen):** Entries whose weight will never change again.
  These can be materialized as a snapshot and excluded from delta
  processing.
- **Working (live):** Entries that may still change due to future
  constraint insertions.

This is a **memoization boundary** within each incremental stage.  The
stage's `current()` output is:

```
current() = frozen_snapshot ∪ working_state
```

When the stability frontier V_stable advances, entries migrate from
working to frozen.  The delta pipeline only processes entries in the
working set.

### 7.2 The Stability Frontier

The stability frontier V_stable is a version vector such that all agents
have received all constraints with CnIds ≤ V_stable.  Operationally:

```
V_stable = min(VV_alice, VV_bob, VV_charlie, ...)
```

where VV_x is agent x's version vector and min is the component-wise
minimum.

In a single-agent scenario (or when all agents are synchronized),
V_stable = the store's version vector — everything is below the frontier.
This means everything is potentially settleable.

### 7.3 Settled Slot Detection

A slot is settled at V_stable iff:

1. The winning value constraint and all competing constraints for the
   slot have CnIds ≤ V_stable.
2. The retraction chains for all relevant constraints are entirely
   below V_stable and depth-exhausted.
3. No rule constraint above V_stable could affect this slot.

In the incremental pipeline, each stage can independently track which
of its accumulated entries are below V_stable.  When V_stable advances,
entries that newly satisfy the settled criteria move to the frozen
partition.

### 7.4 Per-Stage Settling

| Stage | What settles | Condition |
|-------|-------------|-----------|
| Validity | A constraint's valid/invalid status | Its CnId ≤ V_stable AND no future authority constraint can change its status |
| Retraction | A constraint's active/dominated status | Its CnId ≤ V_stable AND its retraction chain is depth-exhausted below V_stable |
| Structure Index | A SlotGroup | All structure CnIds in the group ≤ V_stable (and structure is permanent) |
| Projection | A ground fact | The source constraint is settled-active |
| Evaluation | A derived fact | All ground facts it depends on are settled |
| Resolution | A winner / fugue pair | The underlying derived facts are settled |
| Skeleton | A node's value + children | The winner and children structure are settled |

The settling is monotonic: once an entry is settled, it stays settled
(assuming finite retraction depth).  This is the monotonic frontier
advancement property from §11.5 of the spec.

---

## 8. Compaction as Garbage Collection

### 8.1 Connection to Settled Sets

Compaction (§12 of the spec) removes constraints from the store that
can never affect future solving.  In the incremental framework,
compaction is garbage collection of the frozen partition:

```
compaction: S → S'  where  S' ⊂ S  and  current(S') = current(S)
```

A constraint c is safe to compact if:

1. c is in the settled partition of every stage.
2. Removing c does not change `current()` for any stage.
3. No preserved snapshot depends on c.

### 8.2 Safe Compaction in Z-Set Terms

A dominated value constraint c below V_stable with an exhausted
retraction chain has weight 0 in the active set's Z-set and will never
have non-zero weight again.  Removing it from the store removes a
zero-weight entry — no effect on any stage's output.

A superseded value constraint c (lower lamport than the settled winner
for the same slot, both below V_stable) will never win again.  It has
weight 0 in the `winner` relation's Z-set and can be removed.

Structure and authority constraints are never compacted because they
have permanent effects: structure constraints define the tree shape
(and are referenced by Fugue origins), and authority constraints
define the validity of all subsequent constraints.

### 8.3 Compaction Does Not Require Special Incremental Machinery

Because compaction only removes zero-weight entries from settled
partitions, it requires no delta propagation — no stage's output
changes.  The compaction operation is:

1. Identify settled constraints that are compactable (§12.2 rules).
2. Remove them from the store.
3. Remove their entries from each stage's frozen partition.

No delta flows through the pipeline.  No `step()` calls.  This is
purely a space reclamation operation on accumulated state.

---

## 9. The Incremental Datalog Evaluator in Detail

The Datalog evaluator is the most complex stage to incrementalize.
This section provides additional detail on how DBSP's nested-stream
construction maps to our evaluator.

### 9.1 Why Incremental Datalog Is a First-Class Concern

The Datalog evaluator serves five purposes in the spec (§B.1, §B.3,
§B.4, §14, §16):

1. **Default value resolution** (Layer 1) — LWW rules.
2. **Default sequence ordering** (Layer 1) — Fugue rules.
3. **Custom conflict resolution** (Layer 2) — retract default rules,
   assert replacements (e.g., priority-based, merge-by-concatenation).
4. **User queries** (Layer 3+) — application-specific derived relations,
   views, aggregations, cross-container joins.
5. **Cross-container constraints** (Layer 2) — referential integrity,
   computed values spanning multiple containers.

Purposes 1–2 have native fast paths (§B.7) that bypass Datalog for the
default rule patterns.  But purposes 3–5 are the *architectural reason*
Datalog exists — they are what makes CCS a programmable reality engine
rather than a CRDT library.  An incremental pipeline that only handles
the native fast path would incrementalize the system as it exists today;
an incremental pipeline that handles Datalog incrementalizes the system
as it is *designed to become*.

The incremental Datalog evaluator is therefore not a deferred
optimization — it is essential infrastructure for the rules-as-data
architecture.  We build it properly, grounded in DBSP's nested-stream
construction, so that custom rules, user queries, and cross-container
constraints all inherit incremental evaluation for free.

### 9.2 Current Architecture

The current evaluator (`datalog/evaluate.ts`) implements:

1. Stratify rules by dependency analysis.
2. For each stratum, run semi-naive fixed-point evaluation:
   - Initial pass: evaluate all rules against full database.
   - Iterate: evaluate rules against delta (new facts from previous
     iteration), collecting newly derived facts.
   - Terminate when delta is empty.

This is the standard semi-naive algorithm, which DBSP §4 shows is the
incrementalization of naive evaluation within a single time step.

### 9.3 Extending to Cross-Time Incrementality

The current evaluator is incremental within a single `evaluate()` call
(semi-naive), but not across calls.  Each call starts from scratch with
a fresh Database.

The extension, following DBSP §5 (nested streams):

- **Outer stream**: time steps where input facts change (constraint
  insertions).
- **Inner stream**: fixed-point iterations within one time step.

The nested incremental circuit:

```
At outer time t:
  1. Receive Δ_facts[t] (changed ground facts).
  2. Apply Δ_facts[t] to the accumulated Database.
  3. For each affected stratum:
     a. Compute which previously derived facts are invalidated by
        the input changes (using Z-set arithmetic).
     b. Run semi-naive from the delta, collecting new derived facts.
     c. Combine invalidations and new derivations into Δ_derived[t].
  4. Update accumulated Database with Δ_derived[t].
  5. Output Δ_derived[t].
```

### 9.4 The Provenance Requirement

Step 3a above — "compute which previously derived facts are invalidated"
— requires **provenance tracking**: knowing which ground facts
contributed to each derivation.

**Status: Implemented in Plan 006.1** via Z-set weights with `distinct`.

DBSP's approach uses Z-set multiplicities: a derived fact's weight
encodes how many independent derivation paths lead to it.  When an
input fact is removed (weight −1), the weight of every derivation that
used it decrements.  If the weight reaches 0, the derived fact is
retracted.

The implementation delivers:

1. **Z-set-aware relations**: `Relation` tracks integer weights per
   fact via `Map<string, { tuple, weight }>`.  `addWeighted(tuple, w)`
   sums weights; zero-weight entries are pruned eagerly.  `tuples()`
   returns weight > 0 entries (backward-compatible).

2. **Weighted semi-naive evaluation**: `Substitution` carries a
   `weight` field through evaluation.  Positive atom join multiplies
   weights (`sub.weight × tuple.weight`, the provenance semiring
   product of Green et al., 2007).  Negation and guards are boolean
   filters (weight preserved on pass).  Aggregation resets weight to 1
   (group-by boundary).  `groundHead` sums weights for duplicate facts
   (Z-set addition).

3. **`distinct` after each iteration**: A dirty map
   (`Map<string, { fact, preWeight }>`) tracks facts modified during
   stratum evaluation.  After each semi-naive iteration, weights are
   clamped to 0/1 on dirty entries only — O(|modified|) per iteration,
   not O(|relation|).  This prevents weight explosion from transitive
   closure and preserves the binary present/absent signal for negation.

4. **Per-stratum accumulated state**: The unified evaluator
   (`createEvaluator`) maintains an accumulated `Database` across
   `step()` calls.  Delta extraction compares each dirty entry's
   `preWeight` (captured on first touch, never overwritten) to the
   current weight after convergence — zero-crossings become the output
   delta.  No snapshot-and-diff needed.

**Differential negation (Plan 006.2):** True incremental retraction
propagation through negation is now implemented.  The unified
semi-naive loop treats negation atoms as delta sources alongside
positive atoms.  `evaluateDifferentialNegation` processes delta
entries with sign inversion: `output_weight = sub.weight × (−deltaWeight)`.
Appearance of a negated fact blocks derivations (→ −1); disappearance
unblocks (→ +1).  The dual-weight `Relation` (`weight` for true Z-set
multiplicity, `clampedWeight` for post-distinct presence) ensures
facts with multiple derivation paths survive partial retraction.
The asymmetric join (`ΔA ⋈ P_new + P_old ⋈ ΔB`) prevents self-join
double-counting.  All non-aggregation strata use the unified
O(|Δ|×|DB|) loop.  Only aggregation strata retain wipe-and-recompute
(scoped limitation — no default rules use aggregation).

### 9.5 Monotone Strata (Fugue Rules)

For strata with only positive rules (no negation, no aggregation),
the incremental update is simple and does not require provenance
tracking:

- New input facts can only produce new derived facts.
- No existing derived facts are invalidated.
- Run semi-naive from the new input facts as the initial delta.
- All newly derived facts have weight +1.

This is because monotone Datalog's T_P operator satisfies: more
input → more output, never less.  The Z-set weights are always ≥ 0,
so the `distinct` operator is a no-op and provenance tracking is
unnecessary.

**Correction:** The Fugue rules are NOT all positive.  Rule 5
(`fugueBeforeSubtreeProp`) uses `not fugue_descendant(Parent, B, X)` —
the subtree propagation guard.  Running the actual stratifier
(`stratify(buildDefaultRules())`) produces **two strata**, not the
four or five that hand analysis might suggest:

- **Stratum 0** (positive): `active_value`, `superseded`,
  `active_structure_seq`, `constraint_peer`, `fugue_child`,
  `fugue_descendant` — 5 rules, all purely positive.
- **Stratum 1** (negation): `winner`, `fugue_before` — 6 rules.
  `winner` negates `superseded`; `fugue_before` negates
  `fugue_descendant`.

This means `fugue_before` requires the DRed (delete-and-rederive)
pattern, not simple monotone delta propagation.  However, the native
fast path bypasses Datalog entirely for default Fugue rules, so the
practical impact on the common case is nil.

The `fugue_child` and `fugue_descendant` predicates ARE purely positive
(stratum 0).  Their incremental evaluation is efficient:

A new `active_structure_seq` fact produces:
- New `fugue_child` facts (one per new element).  O(1).
- New `fugue_descendant` facts (transitive closure extension).  O(depth).

`fugue_before` facts are derived in stratum 1 (negation) and require
DRed when evaluated via Datalog.  The native Fugue solver handles this
more efficiently by recomputing ordering for the affected parent only.

Positive join-based rules over active constraints (the stratum
structure most likely for Layer 2 custom rules) inherit monotone
incremental evaluation without provenance tracking.

### 9.6 Stratified Negation Strata (LWW Rules)

The LWW rules use stratified negation:

```
superseded(CnId, Slot) :-
  active_value(CnId, Slot, _, L1, P1),
  active_value(CnId2, Slot, _, L2, P2),
  CnId ≠ CnId2,
  (L2 > L1 ; (L2 = L1, P2 > P1)).

winner(Slot, CnId, Value) :-
  active_value(CnId, Slot, Value, Lamport, Peer),
  not superseded(CnId, Slot).
```

When a new `active_value(c)` fact arrives for slot S:

1. In the `superseded` stratum (positive, lower stratum):
   - Derive new `superseded` facts: c supersedes existing values with
     lower (lamport, peer), and existing values with higher (lamport, peer)
     supersede c.  This produces only +1 entries.

2. In the `winner` stratum (negation over `superseded`):
   - If c is superseded: no change to `winner`.  The current winner
     is unchanged.
   - If c supersedes the current winner w: `superseded(w, S)` is now
     derived (from step 1), so `winner(S, w, ...)` is invalidated
     (weight −1).  And `superseded(c, S)` is not derived, so
     `winner(S, c, ...)` is newly derived (weight +1).
   - Net delta: {winner(S, w, v_old): −1, winner(S, c, v_new): +1}.

This is exactly the Z-set arithmetic for stratified negation described
in DBSP §3.2 and §5.

### 9.7 The Native Solver Fast Path

When the native fast path is active (default rules detected), the
incremental Datalog evaluator can be bypassed.  The native solvers
provide their own incremental logic that produces semantically identical
output deltas:

- **Native LWW**: maintain a per-slot winner.  On new value, compare
  (lamport, peer) with current winner.  O(1).  Emit winner change
  as a Z-set delta if the winner changed.

- **Native Fugue**: maintain per-parent Fugue trees.  On new seq
  structure, insert into the tree and derive ordering changes.  Emit
  changed `fugue_before` pairs as a Z-set delta.

The native fast path is an optimization for the default rules, not an
alternative architecture.  When default rules are retracted and replaced
with custom Layer 2 rules, the pipeline falls back to the incremental
Datalog evaluator (§9.3–9.6).  The native fast path and the incremental
Datalog evaluator share the same stage interface (§4.2) — the skeleton
builder receives the same delta type regardless of which path produced it.

The §B.7 constraint is preserved: native solvers are transparent.
Switching from native to Datalog (because rules changed) produces the
same accumulated state, and subsequent deltas are consistent regardless
of which path computed previous state.  The accumulated state is the
ResolutionResult (winners + fugue pairs), which is the same data
structure for both paths.

---

## 10. Reality Deltas

### 10.1 The Output Type

The final output of the incremental pipeline is a **reality delta** —
a description of what changed in the reality tree.

```
RealityDelta = {
  changedNodes: Map<path, NodeDelta>
}

NodeDelta =
  | { kind: 'added', node: RealityNode }
  | { kind: 'removed' }
  | { kind: 'valueChanged', oldValue: Value, newValue: Value }
  | { kind: 'childAdded', key: string, child: RealityNode }
  | { kind: 'childRemoved', key: string }
  | { kind: 'childReordered', children: string[] }  // seq reorder
```

### 10.2 Downstream Consumers

Reality deltas enable:

- **Reactive UI updates**: a subscriber receives the delta and updates
  only the affected DOM nodes.
- **Incremental query maintenance** (§16 of the spec): queries over the
  reality are themselves DBSP operators that receive reality deltas as
  input and produce query result deltas as output.
- **Delta sync** (§15): the reality delta is the "what changed" signal
  that tells other agents what to re-examine.

---

## 11. Implementation Strategy

### 11.1 Preserving the Batch Pipeline

The batch pipeline (`solveFull`) is kept unchanged as the correctness
oracle.  The incremental pipeline is an alternative code path that
produces identical results.  This mirrors the existing pattern where
native solvers coexist with Datalog evaluation and equivalence tests
verify agreement.

### 11.2 Phased Implementation

The stages can be incrementalized independently because the DBSP
circuit incrementalization applies to each operator in the DAG.  A
partially-incremental pipeline where some stages are incremental and
others fall back to batch is correct (though slower than full
incrementalization):

```
Δ_valid = validityStage.step(Δc)
// If retraction stage is not yet incremental, fall back:
active = batch_computeActive(validityStage.current())
Δ_active = diff(active, previous_active)
// Continue with incremental projection:
Δ_facts = projectionStage.step(Δ_active)
...
```

This allows incremental development: implement and test one stage at
a time, with the batch pipeline filling gaps.

Recommended order (foundation first, then the full circuit):

1. **Z-set type and utilities** — the shared algebraic foundation.
2. **Retraction** — highest standalone impact; dominance cascade is
   the most expensive batch operation for stores with retractions.
3. **Projection** — bilinear (join), validates the Z-set plumbing
   and the orphaned-value re-projection pattern.
4. **Validity** — requires the persistent authority data structure
   (§3.2); design-intensive but needed for authority constraint
   handling.
5. **Datalog evaluator** — the core of the architecture.  Monotone
   strata first (Fugue rules — no provenance needed), then stratified
   negation (LWW rules — requires Z-set-weighted relations and
   provenance tracking).  The native fast path serves as the
   correctness oracle during development.
6. **Native LWW/Fugue as incremental fast path** — implements the
   same stage interface as the incremental Datalog evaluator, with
   O(1) fast paths for detected default rule patterns.
7. **Skeleton** — the final tree update, consuming resolution deltas.
8. **Settled/working partitioning** — the memoization boundary,
   layered over the accumulated state in each stage.
9. **Compaction** — garbage collection of frozen state.

### 11.3 The Z-Set as the Integration Point

The Z-set type is the single abstraction that flows between all stages.
It replaces ad-hoc representations:

| Current | Z-set replacement |
|---------|------------------|
| `Constraint[]` (active set) | `ZSet<Constraint>` with weight +1 for active |
| `Fact[]` (projected facts) | `ZSet<Fact>` with weight +1 for present |
| `Database` (Datalog state) | `ZSet<Fact>` per relation (weighted) |
| `ResolutionResult` | `ZSet<ResolvedWinner>` + `ZSet<FugueBeforePair>` |
| `Reality` (tree) | Accumulated tree + `RealityDelta` for changes |

This uniformity reduces cognitive load: every inter-stage communication
uses the same type, and the algebra (add, negate, zero) is the same
everywhere.

Note: the Z-set is the *algebraic* type.  The *runtime* representation
should be efficient for the common case.  Since the overwhelming
majority of deltas are singleton insertions (weight +1), the
implementation can use a fast path for single-element positive deltas
and fall back to the full Z-set Map representation for multi-element or
negative-weight deltas (retraction cascades, authority re-evaluation).
The algebraic properties hold regardless of the runtime representation.

---

## 12. Summary of Complexity

| Operation | Batch (current) | Incremental |
|-----------|----------------|-------------|
| Insert value constraint | O(\|S\|) | O(1) |
| Insert structure constraint | O(\|S\|) | O(1) map, O(log n) seq |
| Insert retract constraint | O(\|S\|) | O(chain depth), typically O(1) |
| Insert authority constraint | O(\|S\|) | O(affected peer's constraints) |
| Insert rule constraint | O(\|S\|) | O(affected region) |
| Frontier advancement | N/A | O(newly settled entries) |
| Compaction | N/A | O(compactable entries) |

The common case — inserting a value or structure constraint into a
reality with no custom rules — drops from O(|S|) to O(1).

---

## References

1. Budiu, M., McSherry, F., Ryzhyk, L., & Tannen, V. (2023). "DBSP:
   Automatic Incremental View Maintenance for Rich Query Languages."
   arXiv:2203.16684.

2. Unified CCS Engine Specification, §7 (Solver Pipeline), §9
   (Incremental Maintenance), §11 (Settled/Working Sets), §12
   (Compaction).  [unified-engine.md](./unified-engine.md).

3. Green, T.J., Karvounarakis, G., & Tannen, V. (2007). "Provenance
   Semirings."  PODS.  (Foundational work on Z-sets / provenance
   polynomials.)

4. McSherry, F., Murray, D.G., Isaacs, R., & Isard, M. (2013).
   "Differential Dataflow."  CIDR.  (The system that DBSP formalizes.)