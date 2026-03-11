# Partitioned Settling via Indexed Z-Sets

This document establishes the theoretical foundation for **per-partition
settling** in the Prism CCS engine. It shows how DBSP's indexed Z-sets,
combined with the slot-centric structure of CCS rules, yield per-slot
settling granularity without per-fact provenance tracking.

**Prerequisites:**
- [incremental.md](./incremental.md) — DBSP circuit model, Z-sets, stage incrementalization
- [unified-engine.md](./unified-engine.md) §11 (settled/working sets), §12 (compaction)
- DBSP (Budiu & McSherry, 2023) §3–5 (Z-sets, nested streams)
- Differential Dataflow arrangements (McSherry, 2013)

**Problem addressed:** Plan 007 requires knowing when a derived fact is
stable (will never change due to future constraints). The naïve approaches
are either too coarse (per-stratum settling — one unsettled input blocks
the entire stratum) or too expensive (per-fact provenance DAGs — tracking
which specific ground facts contributed to each derivation). This document
identifies a middle path that is both precise and cheap.

---

## 1. The Settling Problem

### 1.1 What Settling Means

A derived fact `f` in the accumulated database is **settled** at stability
frontier V_stable iff no future constraint can change whether `f` is present.
Operationally, this means: every ground fact that contributed to any
derivation path of `f` comes from a constraint below V_stable whose
retraction status is final (retraction chain is depth-exhausted).

Once `f` is settled, the evaluator need never re-examine it. Its entry
can be migrated from the working set to a frozen partition.

### 1.2 Why Per-Fact Provenance Is Expensive

To settle a fact `f` precisely, you need to know which ground facts
contribute to it. Z-set weights encode **how many** independent derivation
paths exist (the multiplicity), but not **which** ground facts those paths
traverse. A fact `superseded(alice, slot1)` with weight 2 tells you two
independent paths derive it, but not that one path goes through `bob`'s
value constraint and the other through `charlie`'s.

Maintaining this provenance would require:
- A DAG from each derived fact to its contributing ground facts
- Incremental maintenance of this DAG as facts are inserted/retracted
- Consultation of the DAG at settling time

This is the **provenance semiring** approach (Green et al., 2007). It is
mathematically correct but introduces O(|derivation paths|) space and
maintenance cost per derived fact. Plan 006.2 explicitly rejected this
approach in favor of Z-set multiplicities.

### 1.3 Why Per-Stratum Settling Is Too Coarse

The opposite extreme: a stratum is settled when *every* ground fact that
any rule in the stratum reads is settled. For the LWW rules, this means
the `superseded`/`winner` stratum is unsettled if *any* `active_value`
fact in *any* slot is unsettled — even though slots are independent.

For a reality with 10,000 settled slots and 3 active slots, per-stratum
settling keeps all 10,000 slots in the working set. The evaluator must
scan all of them on every delta, even though only 3 can possibly change.

---

## 2. Indexed Z-Sets

### 2.1 Definition

An **indexed Z-set** (DBSP §extensions) over a key set K and a value
domain A is a finite map from K to Z-sets over A:

    IZ(K, A) = K → ℤ[A]

For each key k ∈ K, the value IZ[k] is a Z-set: a function from A to ℤ
with finite support.

Because ℤ[A] is an abelian group (under pointwise addition), IZ(K, A) =
ℤ[A][K] is itself an abelian group:

    (f + g)[k] = f[k] + g[k]     ∀ k ∈ K
    0[k] = 0_{ℤ[A]}               ∀ k ∈ K
    (-f)[k] = -(f[k])             ∀ k ∈ K

All DBSP machinery — streams, lifting, integration, differentiation,
incrementalization — applies to indexed Z-sets without modification.

### 2.2 The Grouping Function

Given a partitioning function p: A → K that assigns a key to each
element, the **grouping function** G_p : ℤ[A] → ℤ[A][K] is:

    G_p(a)[k] = Σ_{x ∈ a, p(x)=k} a[x] · x

This distributes each element of the input Z-set into the group
determined by its key. Crucially:

> **G_p is linear for any p.**

Proof: G_p(a + b)[k] = Σ_{x, p(x)=k} (a+b)[x] · x
                      = Σ_{x, p(x)=k} a[x] · x + Σ_{x, p(x)=k} b[x] · x
                      = G_p(a)[k] + G_p(b)[k].  □

**Consequence (DBSP Theorem on linear operators):** For a linear
time-invariant operator Q, ∆(↑Q) = ↑Q. Grouping is already incremental
with zero overhead. Changes to the input Z-set are routed to the correct
partition by applying p to each changed element — O(|delta|) work.

### 2.3 The Flatmap Function

The inverse of grouping is **flatmap**: ℤ[A][K] → ℤ[A × K], which
flattens an indexed Z-set back into a flat Z-set. Flatmap is a
particular instance of aggregation and is linear. It is the "merge
partitions" step that combines per-partition results into a single
output.

### 2.4 Per-Partition Operators

Given an operator Q : ℤ[A] → ℤ[B] that operates on a single partition,
the **partitioned operator** Q_K : ℤ[A][K] → ℤ[B][K] applies Q
independently to each group:

    Q_K(g)[k] = Q(g[k])

If Q is linear, Q_K is linear (immediate from the definition).

If Q is an arbitrary DBSP circuit (including non-linear operators like
distinct, and feedback loops for recursion), Q_K applies the entire
circuit independently per partition. Each partition has its own
integration state, its own semi-naive loop, and its own convergence.

---

## 3. CCS Rules Have Natural Partition Structure

### 3.1 The Slot-Centric Property

CCS decomposes the reality by **slot** (a unique position in the tree
identified by a slot ID). Every value constraint targets a slot.
Resolution rules operate within a slot. The tree structure connects
slots, but value resolution is per-slot.

This is reflected in the default rules. Consider the LWW rules:

    superseded(A, S) :- active_value(A, S, _, L1, _),
                        active_value(B, S, _, L2, _), L2 > L1.
    superseded(A, S) :- active_value(A, S, _, L, P1),
                        active_value(B, S, _, L, P2), P2 > P1.
    winner(S, B, Content) :- active_value(B, S, Content, _, _),
                             not superseded(B, S).

Variable S appears in:
- Every positive body atom (`active_value`)
- Every negation body atom (`superseded`)
- The head of every rule (`superseded`, `winner`)

Every derivation path for `superseded(alice, slot1)` reads exclusively
from `active_value(_, slot1, _, _, _)` facts. Slot1's derivations are
completely independent of slot2's. The rules are **implicitly partitioned
by S**.

Similarly, the Fugue rules are partitioned by the parent key:

    fugue_child(Child, Parent) :- active_structure_seq(Child, Parent, _, _).
    fugue_descendant(Child, Ancestor) :- fugue_child(Child, Ancestor).
    fugue_descendant(Child, Ancestor) :- fugue_child(Child, Mid),
                                         fugue_descendant(Mid, Ancestor).
    fugue_before(Parent, A, B) :- ... (ordering within a parent's children)

### 3.2 Formal Definition: Partition Key

Given a stratum with rules R₁, …, Rₙ, define the **partition key
variables** as:

    PK = ∩ᵢ (head_vars(Rᵢ) ∩ ∩ⱼ body_atom_vars(Rᵢ, j))

where body_atom_vars(R, j) is the set of variables appearing in the j-th
positive or negation body atom of rule R, and head_vars(R) is the set of
variables in the head atom.

If PK is non-empty, the stratum is **partitionable**: all derivations for
facts sharing the same values of PK variables are independent of
derivations for facts with different PK values.

> **Implementation note — finer-grained stratification required.**
> The definition above assumes each stratum contains rules from a single
> independent rule family. Standard stratification algorithms (including
> the one in `stratify.ts`) group *all* SCCs at the same dependency level
> into a single stratum. For the default CCS rules, this merges LWW
> predicates (`superseded`) with Fugue predicates (`fugue_child`,
> `fugue_descendant`) into stratum 0, and `winner` with `fugue_before`
> into stratum 1. The cross-rule intersection over these mixed strata
> yields PK = ∅ — destroying partitionability.
>
> The fix is to refine stratification Step 4: instead of grouping all
> SCCs at level N into one stratum, compute **connected components**
> among SCCs at the same level. Two SCCs are connected if a **derived**
> predicate produced by one SCC appears in the body of a rule whose
> head is in the other SCC — considering only intra-level edges.
> **Ground predicates** (those that never appear as the head of any
> rule) are excluded from the connectivity test. This is correct
> because ground predicates are inputs, not intermediates — they
> introduce no evaluation dependency between derived-predicate
> families. Without this exclusion, a custom rule that references
> ground predicates from both families (e.g.,
> `debug(S, P) :- active_value(_, S, _, _, _), active_structure_seq(_, P, _, _).`)
> would transitively merge unrelated families into a single stratum
> (PK = ∅), even though `debug` shares no derived predicates with
> either family. Emit one stratum per connected component. For the
> default rules this produces 4 strata instead of 2, recovering
> per-slot (`{S}`) and per-parent (`{Parent}`) partitioning. See
> Plan 007 §Architecture: Finer-Grained Stratification.

**For the LWW stratum:** PK = {S} (S appears in the head and every body
atom of all three rules). Requires that the LWW rules (`superseded`,
`winner`) are in their own strata, separate from Fugue rules.

**For the Fugue stratum:** PK = {Parent} for the `fugue_before` rules.
The transitive closure rules (`fugue_descendant`) partition by {Parent}
within their own stratum. Requires separation from LWW rules.

**For a hypothetical cross-partition rule:**

    global_max(MaxL) :- active_value(_, _, _, L, _), max(L, MaxL).

PK = ∅ (no variable appears in both the head and every body atom).
The stratum is not partitionable — it falls back to per-stratum settling.

### 3.3 The Partitioning Function

For a partitionable stratum with partition key variables {V₁, …, Vₘ}
at head positions {p₁, …, pₘ}, the partitioning function for the
stratum's derived relation is:

    p(tuple) = (tuple[p₁], …, tuple[pₘ])

For input relations (ground facts), the partitioning function extracts
the same key from the corresponding positions. Because every body atom
contains the PK variables, every input relation can be partitioned by
the same key.

### 3.4 Static Extraction at Stratification Time

Partition key analysis is performed once at stratification time (and
re-performed when rules change, which already triggers restratification).

The analysis is:
1. For each rule in the stratum, compute the intersection of variables
   appearing in the head AND in every body element (positive atoms,
   negation atoms).
2. Intersect across all rules in the stratum.
3. If the result is non-empty, the stratum is partitionable. Map the
   PK variables to head tuple positions to define the partitioning
   function.

This is O(|rules| × |body elements|) — negligible compared to evaluation.

Guards are excluded from the intersection because they constrain values
but don't reference predicates. Aggregation body elements are excluded
because they introduce group-by boundaries.

### 3.5 When Rules Change

CCS rules are retractable (rules-as-data). When a rule change triggers
restratification, partition keys are re-extracted. Three cases:

1. **Same partition key:** No settling impact. Existing partitions remain
   valid (the rule change path already wipes and replays derived facts).

2. **Partition key shrinks (e.g., a cross-partition rule is added):**
   Previously independent partitions may now be coupled. All frozen
   partitions for the affected stratum must be unfrozen and merged into
   the working set. The wipe-and-replay on rule change already handles
   this correctly — it replays all strata from scratch.

3. **Partition key grows (e.g., a cross-partition rule is removed):**
   The stratum becomes more partitionable. Newly independent partitions
   can be settled independently. No correctness issue — this is purely
   an opportunity to settle more aggressively.

In all cases, static re-analysis at restratification time is sufficient.
No per-step dynamic analysis is needed.

---

## 4. Partitioned Settling

### 4.1 Per-Partition Settling Criterion

A partition with key value k is **settled** at V_stable iff:

1. **All input ground facts with key k are settled.** A ground fact is
   settled when its source constraint has CnId ≤ V_stable and its
   retraction status is final (retraction chain depth-exhausted below
   V_stable).

2. **No rule change above V_stable could affect this stratum.** (Rule
   constraints are rare; when present, they unsettle all partitions in
   affected strata.)

Condition (1) is checkable without provenance: enumerate the ground facts
in the partition's key group and check their source constraints against
V_stable and the retraction stage's dominance status.

### 4.2 Why This Works Without Provenance

The partition key ensures that derivations within key k depend only on
input facts with key k. Therefore:

- If all inputs with key k are settled, all derivations with key k are
  settled.
- If any input with key k is unsettled, we conservatively keep the
  entire partition k in the working set.

This is exact for partitionable strata (no false negatives, no false
positives within the partition). It is conservative for non-partitionable
strata (the entire stratum is one partition).

The Z-set weight machinery handles the *correctness* of incremental
evaluation (insertions, retractions, multi-path derivations). The
partition key handles the *settling granularity*. These are orthogonal
concerns that compose cleanly.

### 4.3 Settling Propagation Through the Pipeline

Settling propagates through the incremental DAG:

| Stage | What settles | Condition |
|-------|-------------|-----------|
| Validity | A constraint | CnId ≤ V_stable, no future authority change affects it |
| Retraction | A constraint's active/dominated status | CnId ≤ V_stable, retraction chain depth-exhausted below V_stable |
| Structure Index | A SlotGroup | All structure CnIds in group ≤ V_stable (structure is permanent) |
| Projection | A ground fact | Source constraint is settled-active |
| **Evaluation** | **A partition** | All ground facts in the partition are settled |
| Resolution | A winner / fugue pair | The containing partition is settled |
| Skeleton | A node's value + children | The resolution partition is settled |

For partitioned strata, "a partition" replaces "a stratum" in the
evaluation row — yielding per-slot or per-parent granularity instead of
per-stratum.

### 4.4 Monotonicity of Settling

Settling is monotonic: once a partition is settled, it stays settled.

Proof: A partition k is settled when all input facts with key k come from
constraints below V_stable with final retraction status. V_stable only
advances (monotonically). Retraction status finality is permanent once
the chain is depth-exhausted below V_stable (no future constraint can
change it — spec §11.5). Therefore, no future event can unsettle
partition k.

The exception: a rule change that alters the partition structure
(§3.5 case 2) may unsettle partitions. But rule changes trigger
restratification and full replay, which correctly rebuilds the
settled/working partition from scratch. After the rebuild, the
monotonicity invariant is re-established.  □

---

## 5. Connection to Differential Dataflow Arrangements

### 5.1 Arrangements as Indexed State

In Differential Dataflow (McSherry, 2013; McSherry et al., 2020),
an **arrangement** is an indexed, incrementally maintained collection
of `(data, time, diff)` triples. Multiple operators share the same
arrangement, avoiding redundant indexing.

In DBSP terms, an arrangement is the materialized state of the
integration operator I applied to an indexed Z-set stream. It is the
`z⁻¹(I(a))` term in the bilinear join incrementalization:

    ∆(a ⋈ b) = ∆a ⋈ ∆b + z⁻¹(I(a)) ⋈ ∆b + ∆a ⋈ z⁻¹(I(b))

The `z⁻¹(I(a))` and `z⁻¹(I(b))` terms represent the **accumulated
state** of each input — the arrangement that must be maintained for
efficient incremental joins.

### 5.2 Logical Compaction as Settling

DD arrangements support `set_logical_compaction(frontier)`, which tells
the arrangement: "I will never query times before `frontier`." The
arrangement can then:

1. **Merge timestamps** below the frontier (combine entries at
   indistinguishable times by summing their diffs).
2. **Prune zero-weight entries** that result from the merge.
3. **Reduce space** proportional to the number of entries that collapse.

This is exactly the CCS settling operation:

| DD concept | CCS concept |
|------------|-------------|
| `frontier` | V_stable |
| Advancing the frontier | Frontier advancement (spec §11.5) |
| Merging timestamps below frontier | Migrating entries to frozen partition |
| Pruning zero-weight entries | Compaction GC (incremental.md §8.3) |
| Per-arrangement compaction | Per-partition settling |

### 5.3 Per-Key Compaction

When an arrangement is indexed by key (DD's `arrange_by_key()`),
compaction can be performed per key. A key whose entries are all below
the frontier can be compacted independently of other keys.

In CCS terms: a slot whose constraints are all below V_stable can be
settled independently of other slots. This is per-partition settling.

The DD literature doesn't formalize this as "per-key compaction" because
DD's compaction operates uniformly on the arrangement. But the indexed
structure means that keys with all-settled entries naturally have their
timestamps merged on the next compaction pass, regardless of other keys'
frontier status.

### 5.4 Shared Arrangements in CCS

The DBSP bilinear join requires maintaining `I(a)` for the left input.
In the current CCS evaluator, this is the accumulated `Database` — the
`db` parameter to `evaluateStratumFromDelta`. The `constructDbOld`
function (which subtracts inputDelta from db to get P_old for the
asymmetric join) operates on this accumulated state.

With partitioned relations, `constructDbOld` only needs to operate on
affected partitions — O(|delta partitions|) instead of O(|delta entries|).
This is the DD analog of looking up only the relevant keys in an
arrangement during an incremental join.

---

## 6. Partitioned Evaluation

### 6.1 The Partitioned Semi-Naive Loop

For a partitionable stratum with partition key PK and partitioning
function p, the evaluation of `evaluateStratumFromDelta(rules, db,
inputDelta)` can be decomposed:

1. **Route:** Apply G_p to inputDelta, producing per-partition deltas.
   O(|inputDelta|), linear.

2. **Filter:** Skip settled partitions. If partition k is frozen,
   inputDelta should have no entries for key k (settled inputs produce
   no deltas). This is a consistency check, not a computation.

3. **Evaluate:** For each affected partition k, run the semi-naive loop
   on the partition's sub-relation:
   - db_k = db restricted to key k (the partition's accumulated state)
   - delta_k = inputDelta restricted to key k
   - evaluateStratumFromDelta(rules, db_k, delta_k)
   
   Each partition has its own dirty map, its own convergence, its own
   extractDelta. The asymmetric join's constructDbOld operates on db_k
   and delta_k — O(|delta_k|) per partition.

4. **Merge:** Apply flatmap to combine per-partition output deltas into
   the stratum output delta. O(|output delta|), linear.

The total cost is Σ_k O(|delta_k| × |db_k|) over affected partitions,
instead of O(|delta| × |db|) over the entire stratum. For a stratum with
10,000 settled partitions and 3 active partitions, only the 3 active
partitions are evaluated.

### 6.2 Non-Partitionable Strata

For strata where PK = ∅ (no partition key found), the entire stratum is
a single partition. Evaluation proceeds exactly as today. Settling is
per-stratum — the coarsest granularity.

This is correct: if the rules genuinely aggregate across all keys, any
unsettled input can affect any output. Per-stratum settling reflects this
dependency faithfully.

### 6.3 Aggregation Strata

Aggregation strata currently use wipe-and-recompute (Plan 006.2 scoped
limitation). The partition key analysis applies to aggregation strata
as well — if the aggregation is within a partition (e.g., `max` per
slot), the stratum is partitionable and only affected partitions need
recomputation.

Cross-partition aggregation (e.g., `count` over all values) produces
PK = ∅ and falls back to whole-stratum recomputation — which is the
current behavior.

---

## 7. The Arranged Relation

### 7.1 Conceptual Structure

An **arranged relation** is a `Relation` augmented with a partition
index. Conceptually:

    ArrangedRelation<K> = {
      keyExtractor: FactTuple → K,
      partitions: Map<K, Relation>,      // working partitions
      frozenPartitions: Map<K, Relation>, // settled, read-only
    }

The public API is unchanged: `tuples()`, `has()`, `size`,
`weightedTuples()`, `allWeightedTuples()` iterate over all partitions
(frozen ∪ working) transparently.

Mutation operations (`add`, `addWeighted`, `remove`) route to the
correct working partition by key. Attempting to mutate a frozen partition
is a logic error (settled facts should not receive deltas).

### 7.2 Integration with Database

The `Database` maps predicate names to relations. With arrangements:

    ArrangedDatabase = {
      relations: Map<string, ArrangedRelation<K> | Relation>,
      partitionKeys: Map<string, KeyExtractor>,
    }

Relations with known partition keys use `ArrangedRelation`. Relations
without (non-partitionable strata, or ground-fact-only predicates before
stratification) use plain `Relation`.

### 7.3 Settling a Partition

When partition k is determined to be settled:

1. Move `partitions[k]` to `frozenPartitions[k]`.
2. The partition becomes read-only.
3. Future deltas that would touch key k are rejected (consistency check).
4. The evaluator skips key k in the semi-naive loop.
5. Zero-weight entries in the frozen partition can be pruned (compaction).

### 7.4 Unfreezing on Rule Change

When rules change and the partition structure changes (§3.5):

1. All frozen partitions for affected strata are moved back to working.
2. The key extractor is recomputed from the new partition key.
3. The wipe-and-replay path rebuilds the arrangement from scratch.

This is consistent with the existing rule-change path in
`createEvaluator`, which already wipes derived facts and replays all
strata.

---

## 8. Interaction with the Native Fast Path

### 8.1 Native Solvers Are Hand-Optimized Partitioned Evaluators

The native LWW solver (`IncrementalLWW`) maintains a per-slot winner map.
The native Fugue solver (`IncrementalFugue`) maintains a per-parent
ordering structure. Both are already partitioned by their natural keys.

With partitioned Datalog evaluation, the settling granularity is
identical across both paths:

| Path | LWW partition key | Fugue partition key |
|------|-------------------|---------------------|
| Native | slot (per-slot winner map) | parent (per-parent tree) |
| Datalog | S (PK variable from rule analysis) | Parent (PK variable from rule analysis) |

This means the evaluation stage's strategy switching (native ↔ Datalog)
preserves settling boundaries. A slot that is settled under the native
path remains settled if the system switches to Datalog (e.g., due to
a custom rule), and vice versa.

### 8.2 Native Settling Is Simpler

For the native path, settling doesn't require partition key analysis —
the per-slot/per-parent structure is hardcoded in the solver
implementation. The partition key analysis is only needed for the Datalog
path, where the partition structure is derived from user-provided rules.

---

## 9. Compaction

### 9.1 Per-Partition Compaction

Once a partition is settled and frozen, compaction operates on the
source constraints:

1. **Dominated values below frontier** (spec §12.2 rule 1): A value
   constraint for slot k whose retraction chain is depth-exhausted below
   V_stable can be removed from the store.

2. **Superseded values below frontier** (spec §12.2 rule 2): A value
   constraint for slot k that is superseded by a higher-lamport active
   value, both below V_stable, can be removed.

3. **Retraction pairs below frontier** (spec §12.2 rule 3): A retract
   constraint and its target, both below V_stable and both
   dominated/superseded, can be removed together.

Structure and authority constraints are never compacted (spec §12.2).

### 9.2 Compaction Does Not Require Delta Propagation

Compaction removes zero-weight entries from settled partitions. By
definition, these entries have no effect on any stage's output. No delta
flows through the pipeline. No `step()` calls. This is purely a space
reclamation operation on accumulated state — consistent with
incremental.md §8.3.

### 9.3 Compaction Scope

Per-partition compaction allows fine-grained space reclamation:

- A reality with 10,000 slots, 9,997 settled: compact the 9,997 settled
  slots' dominated/superseded constraints while the 3 active slots
  remain in the working set with full history.

- Under snapshot-preserving policy: retain constraints that contributed
  to any preserved snapshot (bookmarked version vectors), even if the
  partition is otherwise settled.

---

## 10. Complexity Analysis

### 10.1 Per-Step Cost

For a partitionable stratum with partition key PK:

| Operation | Cost | Notes |
|-----------|------|-------|
| Route inputDelta by partition | O(\|inputDelta\|) | G_p is linear |
| Skip settled partitions | O(1) per partition | Frozen flag check |
| Evaluate affected partition k | O(\|delta_k\| × \|db_k\|) | Semi-naive within partition |
| Merge output deltas | O(\|outputDelta\|) | Flatmap is linear |
| **Total** | **Σ_k O(\|delta_k\| × \|db_k\|)** | Sum over affected partitions only |

Compare with the current (non-partitioned) cost: O(|delta| × |db|),
where |db| is the size of the entire stratum's accumulated relation.

For the common case where delta affects few partitions and the stratum
has many settled partitions, the partitioned cost is dramatically lower.

### 10.2 Space Cost

| Component | Space | Notes |
|-----------|-------|-------|
| Partition index | O(\|keys\|) | One entry per distinct key value |
| Working partitions | O(\|working entries\|) | Same as current, but only for unsettled keys |
| Frozen partitions | O(\|frozen entries\|) | Read-only; compactable |
| Key extractor | O(1) per stratum | Static, computed at stratification |

The partition index adds O(|keys|) overhead. For CCS with per-slot
partitioning, |keys| = number of slots — typically much smaller than
the number of facts.

### 10.3 Partition Key Analysis Cost

| Operation | Cost | When |
|-----------|------|------|
| Extract PK for all strata | O(\|rules\| × \|body elements\|) | At stratification time |
| Re-extract on rule change | Same | At restratification time |

This is negligible — stratification already does O(|rules|²) work for
SCC detection and stratum assignment.

---

## 11. Relationship to Prior Work

### 11.1 DBSP Indexed Z-Sets (Budiu & McSherry, 2023)

Our arranged relations are indexed Z-sets. The partitioning function is
DBSP's G_p. The flatmap is DBSP's flatmap. The per-partition operator is
DBSP's Agg_Q. The linearity of G_p and flatmap guarantees that
partitioning adds zero overhead to the incremental computation.

DBSP §extensions notes: "our definition of incremental computation is
only concerned with incrementality in the *outermost* structures. We
leave it to future work to explore an appropriate definition of
incremental computation that operates on the *inner* relations."

Our contribution is identifying that CCS rules provide a natural
partitioning that makes inner-relation incrementality unnecessary for
settling: the partition granularity (per-slot) is fine enough that
settling at the partition level is effectively settling at the slot
level.

### 11.2 Differential Dataflow Arrangements (McSherry, 2013)

DD arrangements are physically indexed, shared collections with frontier-
based compaction. Our arranged relations serve the same role: they are
the materialized I(a) state indexed by partition key, with per-partition
settling (logical compaction) and per-partition GC (physical compaction).

The key difference: DD's arrangements are a general-purpose runtime
mechanism with dynamically chosen keys. Our arranged relations have
statically extracted keys derived from rule analysis. This is simpler
(no runtime key selection overhead) and sufficient for CCS (the
partition structure is determined by the rules, not the data).

### 11.3 Provenance Semirings (Green et al., 2007)

Provenance semirings track which inputs contribute to each output
derivation. Z-set weights are the natural numbers semiring (ℕ) —
counting derivation paths without identifying them. The Boolean
semiring (𝔹) tracks only presence/absence. Richer semirings (e.g.,
why-provenance, Trio) track the identity of contributing inputs.

Our approach avoids the need for rich provenance by exploiting the
partition structure: instead of asking "which inputs contributed to
this fact?" (provenance), we ask "are all inputs in this partition
settled?" (partition settling). The partition key analysis replaces
per-fact provenance with a static structural property of the rules.

### 11.4 Materialize's Temporal Filters

Materialize uses `mz_now()` temporal filters to bound the working
dataset. Records that fall outside the time window are automatically
retracted. This is a different mechanism from CCS settling (which is
based on causal stability, not wall-clock time), but serves a similar
purpose: bounding the active dataset that the incremental engine must
maintain.

---

## 12. Summary

The key result of this document:

> **DBSP's indexed Z-sets + CCS's slot-centric rule structure = per-slot
> settling without per-fact provenance tracking.**

The argument:
1. CCS rules have a natural partition key (slot ID for LWW, parent key
   for Fugue) that makes derivations within a partition independent of
   other partitions.
2. DBSP's grouping function G_p is linear, so partitioning adds zero
   incremental overhead.
3. Settling at the partition granularity is exact for partitioned strata:
   a partition is settled iff all its input ground facts come from
   settled constraints.
4. This replaces per-fact provenance (expensive, rejected in Plan 006.2)
   with static rule analysis (cheap, performed once at stratification).
5. Non-partitionable strata (cross-partition rules) fall back to
   per-stratum settling, which is correct for rules that genuinely
   aggregate across partitions.
6. The native fast path already operates per-slot, so both evaluation
   paths (native and Datalog) settle at the same granularity.

---

## References

1. Budiu, M. & McSherry, F. (2023). "DBSP: Automatic Incremental View
   Maintenance." VLDB 2023.
2. McSherry, F. (2013). "Differential Dataflow." CIDR 2013.
3. McSherry, F., Murray, D. G., Isaacs, R., & Isard, M. (2020).
   "Shared Arrangements." VLDB 2020.
4. Green, T. J., Karvounarakis, G., & Tannen, V. (2007). "Provenance
   Semirings." PODS 2007.
5. Apt, K., Blair, H., & Walker, A. (1988). "Towards a Theory of
   Declarative Knowledge."
6. Ullman, J. D. (1988). *Principles of Database and Knowledge-Base
   Systems*, Vol 1.