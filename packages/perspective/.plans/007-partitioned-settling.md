# Plan 007: Partitioned Settling, Working Sets, and Compaction

## Background

Plans 005–006.2 delivered an end-to-end incremental pipeline where every
stage — including Datalog evaluation — processes deltas in O(|Δ|) per step.
The pipeline's accumulated state, however, grows without bound. Every
constraint ever seen remains in the store; every derived fact remains in
the evaluator's `Database`; every node remains in the skeleton's mutable
tree. The cost of operations like `constructDbOld` (asymmetric join) and
`evaluateStratumFromDelta` (semi-naive loop) is proportional to the
*entire* accumulated relation, not just the recently-changed portion.

The spec (§11, §12) defines the **settled/working partition** and
**compaction** as the mechanisms to bound this cost. A slot is *settled*
when all constraints that affect it are below the stability frontier
V_stable and their retraction status is final. Settled slots are frozen
— the solver never re-examines them. Compaction removes constraints that
can never affect future solving, reclaiming storage.

The naïve approach to settling derived facts requires per-fact provenance
tracking (which specific ground facts contributed to each derivation).
Plan 006.2 rejected provenance DAGs as too expensive. The theoretical
work in `theory/partitioned-settling.md` identifies a middle path:
**DBSP indexed Z-sets combined with CCS's slot-centric rule structure
yield per-slot settling without per-fact provenance tracking.** The
DBSP grouping function G_p is linear, so partitioning adds zero overhead
to incremental computation. CCS rules have natural partition keys (slot
ID for LWW, parent key for Fugue) discoverable by static variable
intersection analysis at stratification time — provided that strata
are fine-grained enough to separate independent rule families. The
current `stratify()` merges independent SCCs at the same dependency
level into a single stratum, which destroys partitionability when
LWW and Fugue rules coexist. Finer-grained stratification (one stratum
per connected component of SCCs at the same level) recovers per-slot
and per-parent partitioning.

### Key References

- `theory/partitioned-settling.md` — full theoretical foundation
- `theory/incremental.md` §7 (settled/working), §8 (compaction)
- `theory/unified-engine.md` §11 (settled/working sets), §12 (compaction)
- DBSP (Budiu & McSherry, 2023) §extensions (indexed Z-sets, grouping)
- Differential Dataflow arrangements (McSherry, 2013)

---

## Problem Statement

1. **Accumulated state grows without bound.** The evaluator's `Database`,
   the retraction stage's graph, the projection stage's fact set, and the
   skeleton's tree all grow monotonically. For a reality with 100,000
   historical slots and 5 active collaborators, the evaluator scans all
   100,000 slots' facts on every delta — even though only a handful of
   slots can possibly change.

2. **No stability frontier.** The system has no concept of V_stable.
   There is no way to determine which constraints all agents have
   observed, and therefore no way to determine which slots are settled.

3. **No settling granularity for derived facts.** Even with V_stable,
   the evaluator cannot settle individual slots because it doesn't know
   which ground facts contribute to which derived facts. The only option
   without provenance tracking would be per-stratum settling — too coarse.

4. **No compaction.** Dominated and superseded constraints below the
   frontier accumulate forever. The store grows without bound.

5. **No fact→constraint tracing utility.** The constraint CnIdKey is
   embedded in fact tuples (position 0), but there is no utility to
   extract it. Settling requires tracing from facts back to source
   constraints to check whether they are below V_stable.

---

## Success Criteria

1. **Per-slot settling for default rules.** For the LWW/Fugue default
   rules, individual slots settle independently. A reality with 10,000
   settled slots and 3 active slots processes deltas in O(|Δ| × |db_active|),
   not O(|Δ| × |db_total|).

2. **Per-partition settling for custom rules.** The Datalog evaluator
   automatically extracts partition keys from custom rules at
   stratification time. Partitioned strata settle at the partition
   granularity. Non-partitionable strata fall back to per-stratum settling.

3. **Stability frontier computation.** `advanceFrontier(peerVVs)` computes
   V_stable as the component-wise minimum of all agent version vectors.
   Single-agent: V_stable = store VV. Multi-agent: V_stable = min(VVs).

4. **Fact→constraint tracing.** A `constraintKeyFromFact` utility
   extracts the source constraint CnIdKey from the fact tuple (already
   embedded at position 0). No new indexes needed for the primary
   settling direction. A lightweight reverse index
   (`constraintToFacts`) supports compaction.

5. **Per-partition frozen/working split in the evaluator.** The evaluator
   skips frozen partitions during `evaluateStratumFromDelta`. Frozen
   partitions participate in `current()` but not in delta processing.

6. **Compaction of dominated/superseded constraints.** Constraints below
   V_stable with exhausted retraction chains can be removed from the store
   without changing any stage's output.

7. **All existing tests pass.** The three-way oracle (batch ≡ single-step
   ≡ one-at-a-time) continues to hold. The settled/working partition is
   an optimization — the system produces identical results with or without it.

8. **Differential testing.** After every frontier advancement, verify that
   `current()` for every stage equals the batch oracle.

---

## Gap Analysis

### What Exists

- **Version vectors:** `version-vector.ts` has `vvGet`, `vvCompare`,
  `vvIncludes`, `vvMerge`, `vvHasSeenCnId`. Component-wise minimum
  (`vvMin`) is not implemented but is trivial.
- **Per-stage accumulated state:** Every incremental stage holds mutable
  state (`allByKey`, `domStatus`, `accFacts`, `db`, mutable tree, etc.).
- **Retraction depth:** `maxDepth: 2` default. Makes settling decidable —
  once a chain is depth-exhausted below V_stable, no future constraint
  can change dominance.
- **CnId ordering:** `vvHasSeenCnId(V_stable, c.id)` checks if a
  constraint is below the frontier.
- **Stratification:** `stratify.ts` builds dependency graphs, SCCs,
  stratum assignments. However, Step 4 of `stratify()` groups ALL SCCs
  at the same dependency level into a single stratum. For the default
  rules, this merges LWW predicates (`superseded`) with Fugue predicates
  (`fugue_child`, `fugue_descendant`) into stratum 0, and `winner` with
  `fugue_before` into stratum 1. Cross-rule partition key intersection
  over these mixed strata produces PK = ∅. Finer-grained stratification
  (splitting independent components) is needed before partition key
  extraction can succeed.
- **Dual-weight Relations:** `weight` / `clampedWeight` correctly track
  Z-set multiplicities for incremental evaluation.

### What's Missing

- `vvMin` (component-wise minimum of version vectors).
- Stability frontier type and `advanceFrontier` computation.
- Finer-grained stratification: split independent SCCs at the same
  dependency level into separate strata so partition key extraction
  succeeds on the default LWW + Fugue rules.
- Partition key extraction from rules (variable intersection analysis).
- Optional partition index inside `Relation` (arranged relation mode).
- Per-partition `evaluateStratumFromDelta` routing.
- `constraintKeyFromFact` utility for fact→constraint tracing (the CnIdKey
  is already embedded in fact tuples at position 0 — no new index needed).
- Per-stage settled detection and frozen/working partition.
- Frontier advancement protocol with functional core / imperative shell
  separation (`computeSettled` → `applySettling`).
- Compaction rules and store `compact()` operation.
- Multi-agent VV exchange (deferred — requires sync protocol).

---

## Architecture

### Stability Frontier

```typescript
// version-vector.ts — new export
function vvMin(vvs: readonly VersionVector[]): VersionVector;
```

For multi-agent: `V_stable = vvMin([vv_alice, vv_bob, ...])`. For
single-agent: `V_stable = store.versionVector` (everything is observed).

The pipeline accepts `advanceFrontier(V_stable)` which propagates to
all stages. Stages use `vvHasSeenCnId(V_stable, c.id)` to check whether
a constraint is below the frontier.

### Finer-Grained Stratification

The current `stratify()` groups all SCCs at the same dependency level
into a single stratum. For the default LWW + Fugue rules this produces:

| Stratum | Predicates | Rules |
|---------|-----------|-------|
| 0 | `superseded`, `fugue_child`, `fugue_descendant` | 5 |
| 1 | `winner`, `fugue_before` | 6 |

Partition key extraction over these mixed strata yields PK = ∅ because
LWW rules partition by `{Slot}` while Fugue rules partition by
`{Parent}`, and the cross-rule intersection is empty.

**Fix:** In Step 4 of `stratify()`, instead of grouping all SCCs at
level N into one stratum, compute **connected components** among SCCs
at the same level. Two SCCs are connected if a **derived** predicate
produced by one SCC appears in the body of a rule whose head is in the
other SCC — considering only intra-level edges. **Ground predicates**
(those that never appear as the head of any rule) are excluded from
the connectivity test; they do not bridge SCCs. This is correct because
ground predicates introduce no evaluation dependency between derived-
predicate families — they are inputs, not intermediates. Emit one
stratum per connected component. SCCs that share no derived predicates
become separate strata with distinct indices.

> **Why ground predicates must be excluded:** Both LWW and Fugue rules
> reference ground predicates in their bodies (`active_value` for LWW,
> `active_structure_seq` / `constraint_peer` for Fugue). Although the
> default rules happen not to share any ground predicates across
> families, a custom rule like
> `debug(S, P) :- active_value(_, S, _, _, _), active_structure_seq(_, P, _, _).`
> references ground predicates from both families. Including ground
> predicates in the connectivity test would transitively merge the LWW
> and Fugue components into a single mega-stratum (PK = ∅). Excluding
> them keeps `debug` in its own independent stratum — which is correct,
> because `debug` doesn't interact with `superseded` or `fugue_child`
> derivations.

For the default rules, this produces **4 strata** instead of 2:

| Stratum | Predicates | Rules | PK |
|---------|-----------|-------|----|
| 0 | `superseded` | 2 | `{Slot}` ✅ |
| 1 | `fugue_child`, `fugue_descendant` | 3 | `{Parent}` ✅ |
| 2 | `winner` | 1 | `{Slot}` ✅ |
| 3 | `fugue_before` | 5 | `{Parent}` ✅ |

Strata 0–1 are at dependency level 0 (no negative deps) and can be
evaluated in any order. Strata 2–3 are at level 1 (negative deps on
level 0) and can also be evaluated in any order relative to each other.
The evaluator's bottom-up loop already processes strata in ascending
index order, which respects level ordering.

**Stratum count analysis:** The number of strata is bounded by the
number of independent derived-predicate families × the number of
dependency levels. In practice:
- Default rules: 4 strata (2 families × 2 levels).
- N independent custom rules at the same level: N additional strata.
  Each is smaller and independently partitionable — the alternative
  (one mega-stratum, PK = ∅) is strictly worse.
- Interconnected custom rules form connected components and stay together.
  Stratum count doesn't explode for complex rule graphs.

**Evaluation order within a level:** Strata at the same dependency level
are independent by construction (no predicate references between them).
They can be evaluated in any order. The current sequential bottom-up loop
handles this correctly without modification — it just processes more,
smaller strata.

**Performance note:** The evaluator's `computeAffectedStrata` and
`strata.find()` should use Map lookups (not linear search) to avoid
O(|strata|²) overhead when stratum count grows. This is a minor code
quality fix, not an architectural change.

### Partition Key Extraction

At stratification time, for each stratum, compute:

```typescript
// stratify.ts — new export
interface PartitionKeyInfo {
  /** Variable names that form the partition key (empty = not partitionable). */
  readonly variables: readonly string[];
  /** For each derived predicate, the tuple positions of PK variables. */
  readonly headPositions: ReadonlyMap<string, readonly number[]>;
  /** For each input predicate, the tuple positions of PK variables. */
  readonly bodyPositions: ReadonlyMap<string, readonly number[]>;
}

function extractPartitionKey(rules: readonly Rule[]): PartitionKeyInfo;
```

Algorithm: for each rule, intersect the set of variables appearing in the
head with those appearing in every positive/negation body atom. Intersect
across all rules in the stratum. Map surviving variables to tuple positions
in each predicate. Because strata are now fine-grained (one connected
component per stratum), the cross-rule intersection operates over rules
that share predicates, not over unrelated rule families.

### Partition-Aware Relation (Arranged Mode)

Rather than introducing a parallel `PartitionedRelation` type that
duplicates `Relation`'s ~220 lines of dual-weight logic, `Relation`
itself gains an **optional** internal partition index. A `Relation` with
no key extractor behaves exactly as today (single flat map). A `Relation`
with a key extractor stores entries in per-key sub-maps internally.

The public API does not change — `tuples()`, `addWeighted()`, `has()`,
etc. all work transparently. The only new methods are partition-specific:

```typescript
// types.ts — additions to the existing Relation class
type PartitionKey = string; // serialized key tuple

class Relation {
  // ... all existing methods unchanged ...

  // --- New: optional partition mode ---

  /** Enable partitioning. Reorganizes existing entries by key. */
  enablePartitioning(keyPositions: readonly number[]): void;

  /** Whether this relation is partitioned. */
  get isPartitioned(): boolean;

  /** Get a read-only sub-relation for a specific partition key. */
  partition(key: PartitionKey): Relation | undefined;

  /** Iterate only the working (non-frozen) partition keys. */
  workingKeys(): Iterable<PartitionKey>;

  /** Iterate only tuples for a specific partition key. */
  partitionWeightedTuples(key: PartitionKey): readonly { tuple: FactTuple; weight: number }[];
  partitionAllWeightedTuples(key: PartitionKey): readonly { tuple: FactTuple; weight: number }[];

  /** Freeze a partition (settled — no further mutations). */
  freeze(key: PartitionKey): void;
  isFrozen(key: PartitionKey): boolean;
  unfreeze(key: PartitionKey): void;
  unfreezeAll(): void;

  /** All partition keys (frozen + working). */
  partitionKeys(): Iterable<PartitionKey>;
}
```

Internally, when `enablePartitioning` is called, entries are reorganized
from the flat `_map` into a `Map<PartitionKey, Map<string, RelationEntry>>`
plus a `Set<PartitionKey>` for frozen keys. The existing `_map` becomes
null (or is replaced by the partitioned structure). All existing methods
(`add`, `addWeighted`, `has`, `tuples`, etc.) check `isPartitioned` and
delegate to the correct path — flat or per-partition.

This means:
- **Zero duplication.** One class, one set of dual-weight logic.
- **`Database` is unchanged.** It still holds `Map<string, Relation>`.
  `Database.relation(pred)`, `Database.clone()`, etc. work as-is.
- **Evaluator functions are unaware of partitioning.** They receive a
  `Relation` and call the same methods. Partition routing happens at the
  `evaluateStratumFromDelta` level, which passes partition sub-relations
  (via `partitionWeightedTuples`) to the semi-naive loop.

### Constraint→Fact Provenance (Via Tuple Data)

The constraint key is **already embedded in the fact tuple**. The
projection stage creates `active_value` facts with `cnIdKey(vc.id)` at
position 0, and `active_structure_seq` facts with `cnIdKey(sc.id)` at
position 0. No new index is needed for the fact→constraint direction.

Add a utility function:

```typescript
// kernel/projection.ts — new export
function constraintKeyFromFact(f: Fact): string | null;
```

This reads `f.values[0]` for known fact predicates (`active_value`,
`active_structure_seq`, `constraint_peer`). O(1), no state, can't go
stale.

For the reverse direction (constraint→facts), the projection stage gains
a lightweight index for use by compaction:

```typescript
// incremental/projection.ts — internal addition
// CnIdKey → Set<factKey> of facts it produced
let constraintToFacts: Map<string, Set<string>>;
```

Updated on project/retract. Exposed as:

```typescript
interface IncrementalProjection {
  // ... existing ...
  /** Get all factKeys produced by a given constraint CnIdKey. */
  factsForConstraint(constraintKey: string): ReadonlySet<string> | undefined;
}
```

### Per-Stage Settling (Functional Core / Imperative Shell)

Settling follows the functional core / imperative shell pattern used
throughout the codebase. The *decision* of what to settle is a pure
function; the *execution* of freezing is the imperative part.

```typescript
// New: settling.ts — functional core (pure, testable)
interface SettlingPlan {
  /** Constraint CnIdKeys that are settled. */
  readonly settledConstraints: ReadonlySet<string>;
  /** Per-stratum: partition keys whose input facts are all settled. */
  readonly settledPartitions: ReadonlyMap<number, ReadonlySet<PartitionKey>>;
}

function computeSettlingPlan(
  V_stable: VersionVector,
  retraction: { allByKey: ..., domStatus: ..., config: ... },
  projection: { constraintKeyFromFact: ..., accFacts: ... },
  strata: readonly Stratum[],
): SettlingPlan;
```

The pipeline applies the plan imperatively:

```typescript
interface IncrementalPipeline {
  // ... existing ...
  advanceFrontier(V_stable: VersionVector): void;
}
```

Internally, `advanceFrontier` calls `computeSettlingPlan` (pure), then
applies it to each stage (imperative: freeze partitions, mark entries).
The plan is directly testable: assert properties of `SettlingPlan`
without executing any mutations.

Settling propagates **bottom-up through strata**, mirroring evaluation
order. After settling stratum 0's partitions, stratum 1 checks: "for
each partition key k, is the lower stratum's derived predicate's
partition k frozen?" This is `relation.isFrozen(k)` — a direct read
of the lower stratum's state after its settling is applied.

### Compaction

```typescript
interface IncrementalPipeline {
  // ... existing ...
  compact(V_stable: VersionVector, policy: CompactionPolicy): CompactionResult;
}

type CompactionPolicy = 'frontier-only' | 'snapshot-preserving' | 'full-history';

interface CompactionResult {
  readonly removedCount: number;
  readonly removedConstraints: readonly CnId[];
}
```

Compaction removes constraints from the store and cleans up per-stage
frozen partitions. No delta propagation — purely space reclamation on
zero-weight/settled entries.

---

## Phases and Tasks

### Phase 1: Frontier Infrastructure 🔴

Foundation: V_stable computation, finer-grained stratification, partition
key extraction, fact→constraint tracing. No behavioral changes to the
pipeline beyond stratification producing more strata.

#### Tasks

- **1.1** Add `vvMin(vvs: readonly VersionVector[]): VersionVector` to
  `version-vector.ts`. Component-wise minimum across all VVs. Empty input
  returns empty VV. 🔴

- **1.2** Add `isConstraintBelowFrontier(c: Constraint, frontier: VersionVector): boolean`
  to `version-vector.ts`. Delegates to `vvHasSeenCnId`. Semantic wrapper
  for readability. 🔴

- **1.3** Refine `stratify()` Step 4 to produce **finer-grained strata**.
  After computing SCC stratum levels, compute connected components among
  SCCs at the same level. Two SCCs are connected if a **derived**
  predicate (one that appears as a head in the rule set) produced by one
  SCC appears in the body of a rule whose head is in the other SCC.
  Ground predicates (those never appearing as a rule head) are excluded
  from the connectivity test — they are inputs, not intermediates, and
  do not create evaluation dependencies between derived-predicate
  families. Emit one `Stratum` per connected component instead of one
  per level. Assign sequential indices that respect level ordering.
  Verify the default LWW + Fugue rules produce 4 strata instead of 2. 🔴

- **1.4** Fix `strata.find()` in the evaluator's `step()` hot loop to
  use a `Map<number, Stratum>` lookup instead of linear search. This is
  a prerequisite for finer stratification — more strata means
  `strata.find()` cost matters. 🔴

- **1.5** Implement `extractPartitionKey(rules: readonly Rule[]): PartitionKeyInfo`
  in `stratify.ts`. For each rule, compute the intersection of variables
  in the head with variables in every positive/negation body atom.
  Intersect across all rules in the stratum. Map to tuple positions.
  Because strata are now fine-grained, this operates over rules that
  share predicates — the cross-rule intersection succeeds for the
  default rules. 🔴

- **1.6** Extend `Stratum` interface with `readonly partitionKey: PartitionKeyInfo`.
  Populate during `stratify()`. 🔴

- **1.7** Add `constraintKeyFromFact(f: Fact): string | null` to
  `kernel/projection.ts`. Reads `f.values[0]` for known fact predicates.
  O(1), no state. 🔴

- **1.8** Add `constraintToFacts: Map<string, Set<string>>` reverse index
  to the incremental projection stage. Update on project/retract. Expose
  `factsForConstraint(constraintKey)`. 🔴

- **1.9** Add `CompactionPolicy` type and `FrontierConfig` to
  `kernel/types.ts`. 🔴

#### Tests

- Finer stratification: `stratify(buildDefaultRules())` produces 4 strata.
  Stratum 0 contains only `superseded` (2 rules). Stratum 1 contains
  `fugue_child` + `fugue_descendant` (3 rules). Stratum 2 contains
  `winner` (1 rule). Stratum 3 contains `fugue_before` (5 rules).
- Finer stratification: strata at the same dependency level are
  independent (no cross-references). Adding a cross-family rule merges
  the components.
- Finer stratification: all existing stratify tests pass unchanged
  (single-family rule sets produce the same strata as before).
- Finer stratification: evaluator produces identical results with
  finer strata (three-way oracle still holds).
- `vvMin` with 0, 1, 2, 3 VVs; with non-overlapping peer sets.
- `extractPartitionKey` on the `{superseded}` stratum → PK = {S} at
  correct positions.
- `extractPartitionKey` on the `{fugue_before}` stratum → PK = {Parent}.
- `extractPartitionKey` on a rule with no shared variable → PK = ∅.
- `extractPartitionKey` on multi-rule stratum where one rule lacks the
  shared variable → PK = ∅ (correct fallback).
- `constraintKeyFromFact` on `active_value` fact → correct CnIdKey.
- `constraintKeyFromFact` on unknown predicate → null.
- Projection `factsForConstraint`: insert a value constraint, verify
  returns the correct factKey set. Retract, verify cleanup.

### Phase 2: Partition-Aware Relation 🔴

Add optional partitioning support to the existing `Relation` class. No
behavioral changes to evaluation yet — this phase extends and tests the
data structure.

#### Tasks

- **2.1** Add internal partition state to `Relation`: optional
  `_partitions: Map<PartitionKey, Map<string, RelationEntry>> | null`,
  `_frozen: Set<PartitionKey>`, `_keyPositions: readonly number[] | null`,
  and `_keyFn: ((tuple: FactTuple) => PartitionKey) | null`. Default null
  (unpartitioned). 🔴

- **2.2** Implement `enablePartitioning(keyPositions)`. Reorganizes
  existing entries from the flat `_map` into per-key sub-maps. Sets
  `_keyFn` to a serializer based on `keyPositions`. 🔴

- **2.3** Implement `freeze(key)`, `isFrozen(key)`, `unfreeze(key)`,
  `unfreezeAll()`. Freeze adds key to `_frozen` set. Mutation attempts
  (`addWeighted`, `add`, `remove`) on a frozen key throw (invariant
  violation). 🔴

- **2.4** Update all existing `Relation` methods to branch on
  `_partitions !== null`. When partitioned: `add()`, `addWeighted()`,
  `remove()` route to the correct sub-map by key. `tuples()`,
  `weightedTuples()`, `allWeightedTuples()` iterate all sub-maps
  (frozen + working). `has()`, `getWeight()` look up in the correct
  sub-map. `size`, `allEntryCount`, `isEmpty()` aggregate across
  sub-maps. 🔴

- **2.5** Add partition-scoped iteration: `partitionWeightedTuples(key)`,
  `partitionAllWeightedTuples(key)`. These return tuples for a single
  partition — the entry point for per-partition evaluation. 🔴

- **2.6** Update `clone()` to deep-clone partition structure (including
  frozen set) when partitioned. 🔴

- **2.7** Implement `serializePartitionKey(tuple, positions)` utility
  for extracting and serializing the key from a tuple. 🔴

#### Tests

- Relation without partitioning: all existing behavior unchanged (this is
  a regression gate — run existing Relation tests).
- `enablePartitioning` on a relation with existing entries: verify entries
  are redistributed correctly into sub-maps.
- Insert tuples with different keys into a partitioned relation. Verify
  `partitionWeightedTuples(k)` returns correct subset.
- Freeze a partition, verify `isFrozen` returns true. Verify `tuples()`
  still includes frozen entries. Verify `addWeighted` on a frozen key
  throws.
- Unfreeze, verify mutation works again.
- `clone()` produces independent copy with correct frozen/working split.
- Weight semantics: dual-weight (weight/clampedWeight) works identically
  within partitions — `addWeighted`, `getWeight` route correctly.
- `size`, `allEntryCount`, `isEmpty` aggregate across all partitions.

### Phase 3: Partitioned Evaluation 🔴

Wire partition-aware `Relation` into the evaluator. The evaluator
enables partitioning on relations for partitionable strata, routing
deltas and evaluation per-partition. `Database` itself is unchanged.

Because strata are now fine-grained (Phase 1, Task 1.3), partition
routing happens per-stratum — each stratum has a single partition key
(or PK = ∅). The evaluator's `step()` already processes strata
bottom-up; the partition routing is an inner loop within each stratum's
evaluation.

#### Tasks

- **3.1** In `createEvaluator`, after `restratify()`, call
  `relation.enablePartitioning(keyPositions)` on each stratum's derived
  predicates and input predicates using the stratum's `partitionKey`.
  `Database` requires no modification — `relation(pred)` returns the
  same `Relation` object, which is now partitioned internally. 🔴

- **3.2** Add partition routing in the evaluator's `step()` function,
  wrapping the call to `evaluateStratumFromDelta`. When a stratum has a
  non-empty `partitionKey`: split `inputDelta` by partition key, call
  `evaluateStratumFromDelta` for each affected partition with a
  partition-scoped delta and a partition-scoped db view (via
  `partitionWeightedTuples` / `partitionAllWeightedTuples`). The inner
  loop code (evaluateRuleDelta, evaluatePositiveAtom, etc.) is unchanged
  — it receives fewer tuples, scoped to the partition. When PK is empty:
  evaluate the entire stratum as today. 🔴

- **3.3** Replace `db.clone()` in `constructDbOld` with scoped cloning.
  For partitioned strata: clone only the affected partitions' sub-maps,
  not the entire DB. For non-partitioned strata: clone only the
  predicates that appear in the delta (the current code clones ALL
  predicates including those untouched by the delta — wasteful). This
  is both a correctness fix for the partitioned case and a performance
  fix for the general case. Fix the misleading "O(|delta|)" comment. 🔴

- **3.4** Skip frozen partitions in the evaluation loop. If inputDelta
  has entries for a frozen key, this is a consistency error (settled inputs
  should not produce deltas). Log a warning in debug mode. Do NOT throw
  — use a soft guard to avoid corrupting partially-applied mutations. 🔴

- **3.5** Wire partition key info through `step()` so that each stratum
  evaluation receives its `PartitionKeyInfo`. 🔴

- **3.6** On rule change (restratification), call `unfreezeAll()` on all
  partitioned relations, then re-extract partition keys from new strata
  and re-enable partitioning with new key positions. The existing
  wipe-and-replay path handles the data; partition metadata needs
  resetting alongside it. 🔴

#### Tests

- Three-way oracle (batch ≡ single-step ≡ one-at-a-time) continues to
  hold for all existing test scenarios. This is the primary correctness
  gate — partitioned evaluation MUST produce identical results.
- LWW with 3 slots: insert values for all 3, freeze slot 1, insert a
  new value for slot 2. Verify only slot 2's partition is evaluated.
  Verify slot 1's winner is unchanged. Verify slot 3's winner is
  unchanged.
- Fugue with 2 parents: insert children under both, freeze parent 1,
  insert a child under parent 2. Verify parent 1's ordering is
  unchanged. Verify parent 2 is correctly ordered.
- LWW and Fugue partitions are independent: settling slot 1 (LWW) does
  not affect parent 1 (Fugue), and vice versa — they are in different
  strata with different partition keys.
- Transitive closure with partition key: `reachable(X,Z) :- edge(X,Y),
  reachable(Y,Z)` — PK analysis finds no shared variable across all body
  atoms (X in head, X in edge, Y in reachable — not the same). Falls
  back to per-stratum. Verify correctness.
- Retraction in one partition doesn't affect another partition's derived
  facts.
- `constructDbOld` only builds P_old for affected partition keys (verify
  via a test that the frozen partition is not cloned/subtracted).
- Permutation test: all orderings of 3 values across 2 slots produce
  same resolution, with and without partition freezing.

### Phase 4: Settling Protocol 🔴

Implement settling as a two-phase protocol: `computeSettlingPlan` (pure
functional core, testable) and `applySettling` (imperative shell, mutates
stage state). The pipeline orchestrates frontier advancement.

#### Tasks

- **4.1** Create `src/kernel/settling.ts` with `computeSettlingPlan`
  pure function. Inputs: V_stable, retraction stage state (read-only),
  projection accumulated facts + `constraintKeyFromFact`, strata with
  partition keys. Output: `SettlingPlan` describing which constraints
  are settled, which fact partition keys are settled per-stratum.
  Settling propagates bottom-up through strata: after determining
  stratum 0's settled partitions, stratum 1 checks whether its input
  partitions (from stratum 0's derived predicates) are all settled
  via `relation.isFrozen(k)`. 🔴

- **4.2** Add `applySettling(plan: SettlingPlan)` to
  `IncrementalRetraction`. Marks settled constraints. 🔴

- **4.3** Add `applySettling(plan: SettlingPlan)` to
  `IncrementalProjection`. Marks settled facts (via the reverse
  `constraintToFacts` index). 🔴

- **4.4** Add `applySettling(plan: SettlingPlan)` to the Evaluator.
  For each stratum with a partition key: freeze the partitions identified
  in the plan. 🔴

- **4.5** Add `applySettling` to the evaluation stage wrapper
  (`incremental/evaluation.ts`). For the native path: settle per-slot
  state in `IncrementalLWW` and `IncrementalFugue`. For the Datalog
  path: delegate to the evaluator's `applySettling`. 🔴

- **4.6** Add `applySettling` to the incremental skeleton. Settled
  nodes are frozen (value and children won't change). No behavioral
  effect — purely a future optimization point for the query layer. 🔴

- **4.7** Wire `advanceFrontier(V_stable)` into `IncrementalPipeline`.
  Calls `computeSettlingPlan` (pure), then `applySettling` on each stage
  in DAG order. For now, called manually by the application. 🔴

- **4.8** Add `settledSlots(): ReadonlySet<string>` to the pipeline
  interface. Returns the set of slot IDs whose partitions are frozen in
  the evaluator. Useful for introspection and testing. 🔴

#### Tests

- Single-agent settling: create pipeline, insert 3 constraints for slot A,
  advance frontier to store VV. Verify slot A is settled.
- Multi-agent settling: two agents, agent A has VV {a:3, b:0}, agent B
  has VV {a:0, b:5}. V_stable = {a:0, b:0}. Nothing settles.
  Exchange VVs: agent A has {a:3, b:5}, agent B has {a:3, b:5}.
  V_stable = {a:3, b:5}. Everything below settles.
- Retraction chain prevents settling: insert value, retract it, but
  retraction chain not depth-exhausted (depth 1 of maxDepth 2 — a
  re-retraction is still possible above V_stable). Verify not settled.
- Retraction chain exhausted: depth 2 of maxDepth 2 with all constraints
  below V_stable. Verify settled.
- Rule constraint above V_stable prevents settling of affected strata.
- After settling, insert a new value for a different slot. Verify settled
  slot is skipped in evaluation (partition frozen). Verify the new slot
  is correctly evaluated.
- Differential test: after `advanceFrontier`, verify
  `pipeline.current()` === `pipeline.recompute()`.

### Phase 5: Compaction 🔴

Remove settled constraints from the store. Purely a space-reclamation
operation — no delta propagation.

#### Tasks

- **5.1** Implement `identifyCompactable(store, V_stable, retraction, policy): CnId[]`
  as a pure function. Applies spec §12.2 safe compaction rules:
  dominated values below frontier with exhausted chains, superseded
  values below frontier, retraction pairs below frontier. Structure and
  authority constraints are never compacted. 🔴

- **5.2** Add `removeConstraints(store, ids: CnId[])` to `store.ts`.
  Removes constraints from the store's map. Does NOT update VV or
  lamport (those only grow). Increments generation. 🔴

- **5.3** Implement `compact(V_stable, policy)` on `IncrementalPipeline`.
  Calls `identifyCompactable`, then `removeConstraints`, then cleans up
  per-stage frozen state (removes entries from frozen partitions in
  retraction, projection, evaluation). 🔴

- **5.4** Under `snapshot-preserving` policy: consult bookmark constraints
  to find preserved version vectors. Retain constraints that contributed
  to any preserved snapshot even if otherwise compactable. 🔴

- **5.5** Verify `pipeline.current()` is unchanged after compaction.
  Verify `pipeline.recompute()` equals `pipeline.current()` after
  compaction. 🔴

#### Tests

- Compact dominated value: insert value A (L=10), insert value B (L=20)
  for same slot. Both below V_stable. Compact. Verify A is removed from
  store. Verify reality unchanged.
- Compact retraction pair: insert value, retract it. Both below V_stable,
  chain exhausted. Compact. Verify both removed. Verify reality unchanged.
- Structure and authority constraints survive compaction.
- Snapshot-preserving: bookmark at V1. Insert more constraints. Advance
  frontier past V1. Compact with `snapshot-preserving`. Verify constraints
  needed for V1 snapshot are retained.
- Differential test: `solve(store, config)` after compaction produces
  same reality as `pipeline.current()`.

### Phase 6: Documentation and Verification 🔴

#### Tasks

- **6.1** Run full test suite. Verify all tests pass. 🔴

- **6.2** Update `TECHNICAL.md`: add "Settled/Working Partition" section
  describing per-partition settling, partition key extraction, arranged
  relations, and compaction. Update "Future Work" to mark 007 complete.
  Update "Incremental Pipeline" section to describe frontier advancement. 🔴

- **6.3** Update `LEARNINGS.md` with discoveries from implementation. 🔴

- **6.4** Update `.plans/004-incremental-roadmap.md`: add Plan 006.2
  (missing), update Plan 006.1 status to complete, add Plan 007 status,
  update dependency graph. 🔴

- **6.5** Update `theory/incremental.md` §7: replace placeholder text
  with concrete description of per-partition settling as implemented. 🔴

---

## Transitive Effect Analysis

### `Relation` gains optional partition mode

**Direct:** `Relation`'s internal storage structure changes when
`enablePartitioning` is called. All methods (`add`, `addWeighted`, `has`,
`tuples`, `weightedTuples`, `allWeightedTuples`, `size`, `allEntryCount`,
`isEmpty`, `getWeight`, `remove`, `clone`, `union`, `difference`) must
branch on `isPartitioned`.

**Transitive:** All consumers of `Relation` —
`evaluateStratumFromDelta`, `evaluateRule`, `evaluateRuleDelta`,
`evaluatePositiveAtom`, `evaluateNegation`,
`evaluateDifferentialNegation`, `recomputeAggregationStratum`,
`applyDerivedFact`, `touchFact`, `applyDistinct`, `extractDelta` — call
the same methods. Because the public API is unchanged, they work
transparently. The partition routing happens at the evaluator's `step()`
level, which passes partition-scoped views to `evaluateStratumFromDelta`.

**Risk:** The `union()` and `difference()` methods (used by batch
`evaluateNaive` oracle) currently create new `Relation` instances. With
partitioning, these must correctly propagate partition state. However,
`evaluateNaive` creates fresh `Relation`s (never partitioned), so this is
a non-issue in practice. The partitioned path is only used by the
incremental evaluator.

**Mitigation:** Regression gate: all existing `Relation` unit tests and
the three-way oracle must pass unchanged. An unpartitioned `Relation`
(the default) follows the exact same code path as before.

### `stratify()` produces finer-grained strata; `Stratum` gains `partitionKey`

**Direct:** `stratify()` produces more strata (4 instead of 2 for the
default rules). All consumers — `createEvaluator`, `computeAffectedStrata`,
`buildPredicateToAffectedStrata`, `stratumDerivedPredicates` — receive
more strata with different index values. `Stratum` gains a `partitionKey`
field.

**Transitive:** Tests that assert specific stratum counts or indices for
the default rules need updating. The evaluator's `strata.find()` linear
search becomes a performance concern with more strata — replaced by Map
lookup (Task 1.4). `computeAffectedStrata` correctly handles the finer
strata because it propagates via predicate dependencies, which are
unchanged.

**Risk:** Code that assumes stratum indices are dense (0, 1, 2, ...) or
that the number of strata equals the number of negation levels. The
current code uses `strata.find()` by index, not array indexing, so
non-dense indices are already handled.

**Mitigation:** All existing stratify and evaluator tests must pass.
The three-way oracle catches any evaluation divergence. `partitionKey`
is a new readonly field with a sensible default
(`{ variables: [], headPositions: new Map(), bodyPositions: new Map() }`
for non-partitionable strata). Existing code that doesn't use the field
is unaffected.

### Projection stage gains reverse index and `constraintKeyFromFact`

**Direct:** `constraintToFacts` map added to projection internal state.
`constraintKeyFromFact` added to `kernel/projection.ts` as a pure utility.

**Transitive:** `reset()` must clear the new map. `current()` is
unaffected (returns facts, not provenance). `constraintKeyFromFact`
depends on knowing the fact predicate names (`ACTIVE_VALUE`,
`ACTIVE_STRUCTURE_SEQ`, `CONSTRAINT_PEER`) — these are already exported
constants in `kernel/projection.ts`.

**Mitigation:** Purely additive. `constraintKeyFromFact` is stateless.
The reverse index is internal state with one new public method.

### Store gains `removeConstraints`

**Direct:** The store's `constraints` map and `generation` counter
are mutated.

**Transitive:** Anything that caches based on `generation` will
invalidate. The incremental pipeline's `recompute()` (which calls
`solve(store, config)`) must produce correct results after compaction.
The dedup guard (`hasConstraint`) will allow re-insertion of compacted
constraints if they arrive via sync — but compaction only removes
constraints below V_stable, which by definition all agents have
observed, so re-insertion from sync should not occur.

**Mitigation:** `removeConstraints` only runs during `compact()`, which
is called explicitly. The VV is not reduced (it only grows), so
`filterByVersion` and `vvHasSeenCnId` remain correct.

### Pipeline gains `advanceFrontier` and `compact`

**Direct:** New methods on `IncrementalPipeline`. Not called by existing
code.

**Transitive:** `createIncrementalPipelineFromBootstrap` does not call
`advanceFrontier` during bootstrap replay — frontier advancement is
deferred to the application. If automatic advancement is added later,
bootstrap must skip it (no V_stable during replay).

---

## Testing Strategy

### Differential Testing (primary gate)

After every operation (insert, advanceFrontier, compact), verify:
```
pipeline.current() === solve(store, config)
```

This is the existing `recompute()` oracle extended to cover settling
and compaction. It catches any divergence between the incremental path
(with frozen partitions) and the batch path (which sees all constraints
remaining in the store).

### Partition Key Oracle

For each stratum with a non-empty partition key, verify that evaluating
the stratum partitioned produces identical results to evaluating it
non-partitioned. This is the per-stratum analog of the three-way oracle.

### Settling Monotonicity

After `advanceFrontier`, record the settled set. Insert a non-related
constraint. Call `advanceFrontier` again with the same V_stable. Verify
the settled set only grew (or stayed the same).

---

## Resources for Implementation

### Files to Read

| File | Why |
|------|-----|
| `theory/partitioned-settling.md` | Full theoretical foundation |
| `theory/incremental.md` §7, §8 | Settled/working theory |
| `theory/unified-engine.md` §11, §12 | Spec for settled sets and compaction |
| `src/datalog/types.ts` | `Relation`, `Database`, `RelationEntry` |
| `src/datalog/evaluator.ts` | `createEvaluator`, `evaluateStratumFromDelta`, `step()` |
| `src/datalog/evaluate.ts` | `evaluateRuleDelta`, `evaluatePositiveAtom` |
| `src/datalog/stratify.ts` | `stratify()`, `Stratum`, `bodyPredicates`, `headPredicates` |
| `src/kernel/version-vector.ts` | VV algebra |
| `src/kernel/retraction.ts` | `RetractionConfig`, `computeActive`, dominance |
| `src/kernel/incremental/retraction.ts` | `IncrementalRetraction`, `domStatus`, graph |
| `src/kernel/incremental/projection.ts` | `IncrementalProjection`, fact accumulation |
| `src/kernel/incremental/evaluation.ts` | Strategy wrapper, native/Datalog delegation |
| `src/kernel/incremental/pipeline.ts` | Pipeline composition, `processConstraint` |
| `src/kernel/incremental/skeleton.ts` | `IncrementalSkeleton`, mutable tree |
| `src/kernel/store.ts` | `ConstraintStore`, `insert`, `allConstraints` |
| `src/solver/incremental-lww.ts` | Native LWW solver (per-slot state) |
| `src/solver/incremental-fugue.ts` | Native Fugue solver (per-parent state) |

### Files to Modify

| File | Changes |
|------|---------|
| `src/kernel/version-vector.ts` | Add `vvMin`, `isConstraintBelowFrontier` |
| `src/datalog/stratify.ts` | Finer-grained stratification (split independent SCCs), add `extractPartitionKey`, extend `Stratum` |
| `src/datalog/types.ts` | Add partition mode to `Relation` (enablePartitioning, freeze/unfreeze, partition-scoped iteration) |
| `src/datalog/evaluator.ts` | Partition routing in `step()`, scoped `constructDbOld`, partition setup in `createEvaluator`, `strata.find()` → Map lookup, rule-change `unfreezeAll` |
| `src/kernel/projection.ts` | Add `constraintKeyFromFact` utility |
| `src/kernel/incremental/projection.ts` | `constraintToFacts` reverse index, `factsForConstraint` |
| `src/kernel/incremental/retraction.ts` | `applySettling`, settled detection, `isDepthExhausted` query |
| `src/kernel/incremental/evaluation.ts` | `applySettling` delegation |
| `src/kernel/incremental/skeleton.ts` | `applySettling` (node freezing) |
| `src/kernel/incremental/pipeline.ts` | `advanceFrontier`, `compact`, `settledSlots` |
| `src/kernel/store.ts` | `removeConstraints` |
| `src/kernel/types.ts` | `CompactionPolicy`, `FrontierConfig` |
| `src/solver/incremental-lww.ts` | Per-slot settling |
| `src/solver/incremental-fugue.ts` | Per-parent settling |
| `theory/partitioned-settling.md` | Amend §3.2 to note finer-grained stratification requirement |
| `TECHNICAL.md` | Settled/working section, pipeline updates |
| `LEARNINGS.md` | Implementation discoveries |
| `.plans/004-incremental-roadmap.md` | Status updates, 006.2 addition |

### Files to Add

| File | Purpose |
|------|---------|
| `src/kernel/settling.ts` | `computeSettlingPlan` pure function (functional core) |

### Test Files to Add/Modify

| File | Changes |
|------|---------|
| `tests/kernel/version-vector.test.ts` | `vvMin` tests |
| `tests/datalog/stratify.test.ts` | Finer-grained stratification tests, `extractPartitionKey` tests |
| `tests/datalog/evaluator.test.ts` | Partitioned evaluation, freezing, rule-change unfreeze tests, evaluator correctness with finer strata |
| `tests/kernel/projection.test.ts` | `constraintKeyFromFact` tests |
| `tests/kernel/incremental/projection.test.ts` | `constraintToFacts` reverse index tests |
| `tests/kernel/settling.test.ts` | New: `computeSettlingPlan` pure function tests |
| `tests/kernel/incremental/pipeline.test.ts` | `advanceFrontier`, `compact`, settling tests |

---

## Alternatives Considered

### Per-Fact Provenance DAGs (Rejected)

Maintain a DAG from each derived fact to its contributing ground facts.
Settle individual facts when all leaves are settled.

**Why rejected:** O(|derivation paths|) space and maintenance cost per
derived fact. Plan 006.2 explicitly rejected this in favor of Z-set
multiplicities. The partition-based approach achieves the same granularity
(per-slot) for CCS rules without tracking individual derivation paths.

### Per-Stratum Settling Only (Rejected)

Settle an entire stratum when all its input predicates have only settled
entries.

**Why rejected:** Too coarse. One unsettled slot blocks all 10,000 other
slots in the same stratum. The partition approach achieves per-slot
granularity with minimal additional complexity (partition key extraction
is O(|rules|), partition-aware `Relation` is a branch in existing methods).

### Sub-Program Decomposition Within Strata (Rejected)

Rather than refining stratification, add a `SubProgram` type within each
`Stratum`. Each sub-program would be a connected component of rules
sharing predicates. Partition keys would be extracted per sub-program.

**Why rejected:** Adds an architectural concept (`SubProgram`) that
doesn't exist in standard Datalog. Creates a three-level hierarchy
(strata → sub-programs → partition keys) and requires running separate
semi-naive loops per sub-program within a single stratum — changing the
evaluation architecture more than necessary. Finer-grained stratification
achieves the same decomposition at the stratification level, where the
evaluator already has a natural per-stratum loop. No new types needed.

### Per-Derived-Predicate Partition Keys (Rejected)

Compute partition keys per head predicate rather than per stratum or
sub-program.

**Why rejected:** Doesn't enforce independence — two predicates in the
same stratum could have different partition keys but still reference
each other's derived facts. The mechanism would hope for independence
rather than guaranteeing it. Finer stratification guarantees independence
structurally (separate strata share no predicates by construction).

### Dynamic Partition Key Extraction (Deferred)

Re-analyze partition structure per-step based on data-dependent
relationships (e.g., cross-container link constraints).

**Why deferred:** Static extraction at stratification time is sufficient
for all current and foreseeable CCS rules. Data-dependent partitioning
(where the partition structure changes based on which links exist in the
data) doesn't exist in CCS yet. When it does, static analysis correctly
falls back to per-stratum settling (conservative but correct). See
`theory/partitioned-settling.md` §3.5 for the full analysis.

### Automatic Frontier Advancement (Deferred)

Call `advanceFrontier` automatically after every `insert()`.

**Why deferred:** For single-agent, V_stable = store VV, so this is
trivially computable. But the cost of `advanceFrontier` (scanning all
constraints for settling eligibility) may not be worth paying on every
insertion. A configurable policy (every N insertions, or on explicit
request) is more practical. The pipeline exposes `advanceFrontier` as a
manual operation; automatic policies can be added as a wrapper.

### Full Differential Dataflow Arrangement Sharing (Deferred)

Share the same indexed collection across multiple operators (DD's
`arrange_by_key` shared across multiple `join_core` calls).

**Why deferred:** The current evaluator creates separate `Database`
instances per evaluation context. Arrangement sharing would require
a more fundamental architectural change to the evaluator (shared
mutable state across operators). The per-partition settling benefit
is achievable without this — the partition-aware `Relation` provides
the indexed structure; sharing is a future optimization.

### Separate `PartitionedRelation` Type (Rejected)

Create a new type alongside `Relation` that wraps
`Map<PartitionKey, Relation>` and matches the `Relation` public API.

**Why rejected:** This duplicates ~220 lines of dual-weight logic
(`add`, `addWeighted`, `getWeight`, `remove`, `clone`, etc.) and every
iteration method. Changes to one (e.g., a weight-clamping adjustment)
must be propagated to both. Making `Relation` itself optionally
partition-aware avoids this entirely — one class, one set of logic, with
a branch on `isPartitioned` in each method. `Database` is unchanged.

---

## Learnings

### Mixed Strata Destroy Partitionability — Finer Stratification Recovers It

The default LWW + Fugue rules produce 2 strata where LWW and Fugue
predicates are mixed. Cross-rule partition key intersection over mixed
strata yields PK = ∅. The theory document (§3.2) implicitly assumed
LWW and Fugue rules were in separate strata, but the actual stratifier
merges independent SCCs at the same dependency level.

The fix is not to add sub-program decomposition *within* strata, but to
refine stratification *itself* to separate independent rule families.
This is standard Datalog — finer stratification is well-understood and
provably correct. The key insight: two SCCs at the same dependency level
that share no predicates are independent by construction and can safely
become separate strata.

This was caught during pre-implementation code review (Plan 007 research
phase). The theory document `theory/partitioned-settling.md` §3.2 should
be amended to note this requirement.

### The Constraint Key Is Already in the Tuple — Don't Index What You Have

The projection stage creates `active_value` facts with `cnIdKey(vc.id)`
at tuple position 0. A separate `factToConstraint: Map<string, string>`
index would duplicate this information, add maintenance cost, and risk
going stale. A stateless `constraintKeyFromFact(f)` utility that reads
`f.values[0]` is strictly better for the fact→constraint direction.

The reverse direction (constraint→facts) does need an index, because
you can't efficiently ask "which facts have this value at position 0?"
without scanning all facts. The lightweight `constraintToFacts` map
serves this purpose for compaction.

### `constructDbOld` Clones the Entire Database — Not O(|delta|)

The current `constructDbOld` calls `db.clone()` which copies all
predicates, all entries — O(|db|). The code comment claims "O(|delta|),
not O(|DB|)" but this refers only to the subtraction step; the clone
dominates. Furthermore, `constructDbOld` is called at least twice per
stratum per step (seed + each iteration of the convergence loop). For a
reality with 100k facts and 5 active slots, every delta triggers 100k+
entry clones. The fix has two levels: (1) clone only predicates that
appear in the delta (a pre-007 win), (2) clone only affected partitions
(the full fix in Phase 3).

### Cross-Stratum Settling Must Be Explicit

Per-partition settling within a stratum is straightforward: check if all
input facts for key k are settled. But cross-stratum settling requires
checking the *lower* stratum's derived predicates: "is stratum 0's
output partition for key k frozen?" This must propagate bottom-up through
strata in evaluation order, and the `computeSettlingPlan` function must
process strata sequentially (not independently) to read lower-stratum
frozen state.

### Rule Changes Must Reset Partition State

When rules change, the partition structure may change (different partition
keys, or a previously partitionable stratum becoming non-partitionable).
The existing wipe-and-replay on rule change handles the *data* correctly,
but the *partition metadata* (key extractors, frozen sets) must also be
reset. `unfreezeAll()` + re-`enablePartitioning()` with new key positions
handles this.