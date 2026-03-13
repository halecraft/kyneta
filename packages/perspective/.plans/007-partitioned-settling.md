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
**compaction** as the mechanisms to bound this cost. However, analysis
of the spec's settling predicate revealed a fundamental problem: with
`maxDepth ≥ 1`, the "depth-exhausted retraction chain" requirement
means **almost no constraint ever qualifies as settled**. An un-retracted
value constraint at depth 0 can always be retracted by any agent in the
future. A depth-1 retraction can always be un-retracted (depth 2). Only
constraints whose retraction chains have been played out to exactly
`maxDepth` qualify — the rare undo-then-redo case.

The solution decomposes the problem into three independent concerns:

1. **Evaluation performance** (Phases 2–3): Per-partition evaluation
   via DBSP indexed Z-sets. The DBSP grouping function G_p is linear,
   so partitioning adds zero overhead. CCS rules have natural partition
   keys discoverable at stratification time. The evaluator processes
   only affected partitions — O(|Δ| × |db_partition|) per step.
   **No settling concept needed for this.**

2. **Working-set tracking** (Phase 4): Revocable dormancy instead of
   irrevocable settling. A partition with no recent deltas is dormant
   (skipped during evaluation). A future delta wakes it. This achieves
   the performance goal of §11 without requiring the impossible
   depth-exhaustion predicate.

3. **Space reclamation** (Phase 5): Compaction of dominated/superseded
   constraints below V_stable. This is the only operation that needs
   an irreversibility guarantee — and the safe compaction rules from
   §12.2 provide it for the common cases (superseded values, exhausted
   retraction pairs) without requiring depth-exhaustion of un-retracted
   constraints.

The theoretical work in `theory/partitioned-settling.md` establishes
that CCS rules have natural partition keys (slot ID for LWW, parent key
for Fugue) discoverable by static variable intersection analysis at
stratification time — provided that strata are fine-grained enough to
separate independent rule families. The current `stratify()` merges
independent SCCs at the same dependency level into a single stratum,
which destroys partitionability when LWW and Fugue rules coexist.
Finer-grained stratification (one stratum per connected component of
SCCs at the same level) recovers per-slot and per-parent partitioning.

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
   observed, and therefore no way to determine which slots can be
   considered dormant or compactable.

3. **No partition routing for derived facts.** The evaluator evaluates
   all strata across all data on every delta. Even though LWW slots
   and Fugue parents are independent, the evaluator cannot route deltas
   per-partition because strata are too coarse and `Relation` has no
   partition index.

4. **No compaction.** Dominated and superseded constraints below the
   frontier accumulate forever. The store grows without bound.

5. **No fact→constraint tracing utility.** The constraint CnIdKey is
   embedded in fact tuples (position 0), but there is no utility to
   extract it. Compaction requires tracing from facts back to source
   constraints to determine compactability.

---

## Success Criteria

1. **Per-partition evaluation for default rules.** For the LWW/Fugue
   default rules, individual slots are evaluated independently. A
   reality with 10,000 dormant slots and 3 active slots processes deltas
   in O(|Δ| × |db_active|), not O(|Δ| × |db_total|).

2. **Per-partition evaluation for custom rules.** The Datalog evaluator
   automatically extracts partition keys from custom rules at
   stratification time. Partitioned strata evaluate at the partition
   granularity. Non-partitionable strata fall back to per-stratum
   evaluation.

3. **Stability frontier computation.** `advanceFrontier(peerVVs)` computes
   V_stable as the component-wise minimum of all agent version vectors.
   Single-agent: V_stable = store VV. Multi-agent: V_stable = min(VVs).

4. **Fact→constraint tracing.** A `constraintKeyFromFact` utility
   extracts the source constraint CnIdKey from the fact tuple (already
   embedded at position 0). No new indexes needed for the primary
   direction. A lightweight reverse index (`constraintToFacts`) supports
   compaction.

5. **Dormancy tracking with revocable wake.** The evaluator tracks which
   partitions are dormant (no deltas since last frontier advancement).
   Dormant partitions are skipped during `evaluateStratumFromDelta` but
   participate in `current()`. A future delta for a dormant partition
   wakes it — this is NOT an error, just a transition back to active.

6. **Compaction of dominated/superseded constraints.** Dominated values
   and superseded values below V_stable can be removed from the store
   without changing any stage's output. Depth-exhausted retraction pairs
   can be removed. Structure and authority constraints are never compacted.

7. **All existing tests pass.** The three-way oracle (batch ≡ single-step
   ≡ one-at-a-time) continues to hold. Partitioned evaluation and
   dormancy are optimizations — the system produces identical results
   with or without them.

8. **Differential testing.** After every frontier advancement and
   compaction, verify that `current()` for every stage equals the batch
   oracle.

---

## Gap Analysis

### What Exists

- **Version vectors:** `version-vector.ts` has `vvGet`, `vvCompare`,
  `vvIncludes`, `vvMerge`, `vvHasSeenCnId`, `vvMin` (component-wise
  minimum), and `isConstraintBelowFrontier` (semantic wrapper).
- **Per-stage accumulated state:** Every incremental stage holds mutable
  state (`allByKey`, `domStatus`, `accFacts`, `db`, mutable tree, etc.).
- **Retraction depth:** `maxDepth: 2` default. Used by compaction to
  identify depth-exhausted retraction pairs that are safe to remove.
- **CnId ordering:** `vvHasSeenCnId(V_stable, c.id)` checks if a
  constraint is below the frontier.
- **Stratification:** `stratify.ts` builds dependency graphs, SCCs,
  stratum assignments. Step 4 splits independent SCCs at the same
  dependency level into separate strata via connected-component analysis
  (Phase 1, Task 1.3). Ground predicates are excluded from connectivity.
  For the default LWW + Fugue rules, this produces 4 strata (2 families
  × 2 levels), each with a non-empty partition key.
- **Partition key extraction:** `extractPartitionKey()` computes the
  cross-rule head variable intersection and validates per-rule using a
  functional-lookup relaxation (reachability-based PK-coverage). Each
  `Stratum` carries a `partitionKey: PartitionKeyInfo` field.
- **Dual-weight Relations:** `weight` / `clampedWeight` correctly track
  Z-set multiplicities for incremental evaluation.
- **Fact↔constraint tracing:** `constraintKeyFromFact(f)` reads
  `f.values[0]` for known predicates (O(1), stateless). The incremental
  projection stage maintains a `constraintToFacts` reverse index with
  `factsForConstraint(constraintKey)` for compaction.
- **Evaluator stratum lookup:** `strataByIndex: Map<number, Stratum>`
  replaces linear `strata.find()` search.
- **Type scaffolding:** `CompactionPolicy`, `FrontierConfig` types
  defined in `kernel/types.ts`.

### What's Missing

- Stability frontier type and `advanceFrontier` computation.
- Optional partition index inside `Relation` (arranged relation mode).
- Per-partition `evaluateStratumFromDelta` routing.
- Working-set tracking (dormant/active partition management).
- Frontier advancement protocol with dormancy trimming.
- Compaction rules and store `compact()` / `removeConstraints` operation.
- Multi-agent VV exchange (deferred — requires sync protocol).

---

## Architecture

### Stability Frontier

```typescript
// version-vector.ts — implemented (Phase 1, Tasks 1.1–1.2)
function vvMin(vvs: readonly VersionVector[]): VersionVector;
function isConstraintBelowFrontier(c: Constraint, frontier: VersionVector): boolean;
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

All four strata are partitionable. Stratum 1 requires the **functional-
lookup relaxation** described below.

> **Implementation note — functional-lookup relaxation (Phase 1):** A
> naive per-rule variable intersection would give `fugue_child` PK =
> `{CnId}` (not `{Parent}`), because `constraint_peer(CnId, Peer)`
> lacks `Parent`. The cross-rule intersection `{CnId} ∩ {Parent} = ∅`
> would then kill partitionability for the combined stratum. However,
> `constraint_peer` is a **functional lookup** keyed by `CnId`, and
> `CnId` is already bound by `active_structure_seq(CnId, Parent, ...)`
> which does contain `Parent`. For a fixed `Parent`, the set of matching
> `constraint_peer` facts is fully determined — it introduces no cross-
> partition dependencies. The `extractPartitionKey` algorithm recognizes
> this pattern: it computes the cross-rule head intersection (`{Parent}`)
> first, then validates each rule using a reachability analysis that
> classifies `constraint_peer` as "PK-covered" (all its variables are
> reachable from `{Parent}` through other body atoms). Only PK-required
> atoms (those NOT fully covered) must contain the PK variables.

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

**Performance note:** The evaluator's `strata.find()` has been replaced
with `strataByIndex: Map<number, Stratum>` for O(1) lookup (Phase 1,
Task 1.4).

### Partition Key Extraction

At stratification time, for each stratum, `extractPartitionKey()` computes
the partition key. The interface and function are exported from
`stratify.ts` (implemented in Phase 1):

```typescript
// stratify.ts — implemented
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

Algorithm (cross-rule-head-first with functional-lookup relaxation):

1. Compute the **cross-rule head intersection** — variables that appear
   in every rule's head. This is the maximum possible PK.
2. For each rule, **validate** the candidate against body atoms. A body
   atom is **PK-covered** if all its variables are reachable from the PK
   candidate through other body atoms (transitive closure). PK-covered
   atoms are satellite joins (functional lookups) that don't introduce
   cross-partition dependencies. Only **PK-required** atoms (those with
   unreachable variables) must contain the PK variables.
3. Narrow the candidate if any PK-required atom lacks a candidate
   variable. Re-validate until stable.
4. Map surviving variables to tuple positions in each predicate.

The functional-lookup relaxation is critical for the `fugue_child` +
`fugue_descendant` stratum: `constraint_peer(CnId, Peer)` lacks `Parent`
but is PK-covered because `CnId` is reachable from `{Parent}` through
`active_structure_seq`. Without the relaxation, this stratum would have
PK = ∅. See § Learnings: Functional-Lookup Relaxation.

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

  /** Iterate only the active (non-dormant) partition keys. */
  activeKeys(): Iterable<PartitionKey>;

  /** Iterate only tuples for a specific partition key. */
  partitionWeightedTuples(key: PartitionKey): readonly { tuple: FactTuple; weight: number }[];
  partitionAllWeightedTuples(key: PartitionKey): readonly { tuple: FactTuple; weight: number }[];

  /** Mark a partition as dormant (no recent deltas — skip during eval). */
  markDormant(key: PartitionKey): void;
  isDormant(key: PartitionKey): boolean;
  wake(key: PartitionKey): void;
  wakeAll(): void;

  /** All partition keys (dormant + active). */
  partitionKeys(): Iterable<PartitionKey>;
}
```

Internally, when `enablePartitioning` is called, entries are reorganized
from the flat `_map` into a `Map<PartitionKey, Map<string, RelationEntry>>`
plus a `Set<PartitionKey>` for dormant keys. The existing `_map` becomes
null (or is replaced by the partitioned structure). All existing methods
(`add`, `addWeighted`, `has`, `tuples`, etc.) check `isPartitioned` and
delegate to the correct path — flat or per-partition. **Mutations on a
dormant partition auto-wake it** — this is the revocable dormancy
contract.

This means:
- **Zero duplication.** One class, one set of dual-weight logic.
- **`Database` is unchanged.** It still holds `Map<string, Relation>`.
  `Database.relation(pred)`, `Database.clone()`, etc. work as-is.
- **Evaluator functions are unaware of partitioning.** They receive a
  `Relation` and call the same methods. Partition routing happens at the
  `evaluateStratumFromDelta` level, which passes partition sub-relations
  (via `partitionWeightedTuples`) to the semi-naive loop.
- **Auto-wake on mutation.** Unlike the original "freeze" design where
  mutation on a frozen key threw, dormant partitions silently wake when
  mutated. This is a performance hint, not an invariant.

### Constraint→Fact Provenance (Via Tuple Data)

The constraint key is **already embedded in the fact tuple**. The
projection stage creates `active_value` facts with `cnIdKey(vc.id)` at
position 0, and `active_structure_seq` facts with `cnIdKey(sc.id)` at
position 0. No new index is needed for the fact→constraint direction.

**Implemented (Phase 1):**

```typescript
// kernel/projection.ts — implemented
function constraintKeyFromFact(f: Fact): string | null;
```

Reads `f.values[0]` for known fact predicates (`active_value`,
`active_structure_seq`, `constraint_peer`). O(1), no state, can't go
stale.

For the reverse direction (constraint→facts), the incremental projection
stage maintains a lightweight index for use by compaction:

```typescript
// incremental/projection.ts — implemented
// CnIdKey → Set<factKey> of facts it produced
let constraintToFacts: Map<string, Set<string>>;
```

Updated on project/retract. Exposed on `IncrementalProjection`:

```typescript
interface IncrementalProjection {
  // ... existing ...
  /** Get all factKeys produced by a given constraint CnIdKey. */
  factsForConstraint(constraintKey: string): ReadonlySet<string> | undefined;
}
```

### Lazy-View `constructDbOld` (Pre-Partition Optimization)

The current `constructDbOld` calls `db.clone()` — an O(|db|) deep copy
of every predicate's entire relation — then subtracts the delta. This is
called **1 + N times per stratum evaluation** (once for the seed phase,
once per fixpoint iteration), and the evaluator processes S affected
strata per `step()`. Total clone cost per step:
**(1 + N₁) + (1 + N₂) + ... + (1 + Nₛ)** full O(|db|) clones.

For the default rules, only 2 of 4 strata are recursive (`fugue_child` +
`fugue_descendant` via transitive closure, `fugue_before` via transitive
closure + subtree propagation). Non-recursive strata (`superseded`,
`winner`) converge in 1 seed pass with 0 iterations. But for recursive
strata, N scales as ~log₂(K) where K is the partition size (the
semi-naive "doubling" strategy roughly doubles the reachable set each
iteration). Under a single parent with 100 children, N ≈ 7 — meaning
~8 full O(|db|) clones for that one stratum.

**Note:** For the default rules, the native `IncrementalLWW` +
`IncrementalFugue` solvers bypass `evaluateStratumFromDelta` entirely,
so `constructDbOld` cost is zero on the native path. This optimization
targets the Datalog path (activated by custom rules).

**Fix (Phase 1.5):** Replace eager cloning with a **lazy view**. A
`DatabaseView` reads from the underlying `db` and materializes
differences only for predicates present in the delta. For a delta
touching 2 of 20 predicates, this is O(|delta|) instead of O(|db|) —
and crucially, the cost is O(|delta|) per iteration, not O(|db|).

```typescript
// evaluator.ts — replaces constructDbOld
class DatabaseView implements ReadonlyDatabase {
  constructor(
    private readonly base: Database,
    private readonly delta: Database,
  ) {}

  /** Return P_old for a predicate: base − delta. Lazily materialized. */
  getRelation(pred: string): Relation {
    const baseRel = this.base.getRelation(pred);
    const deltaRel = this.delta.getRelation(pred);
    if (deltaRel.allEntryCount === 0) return baseRel; // no delta → share
    return baseRel.subtract(deltaRel);                 // materialize once
  }
}
```

The key property: `evaluateRuleDelta` only reads predicates that appear
in the rule's body atoms. Most predicates are untouched by any given
delta, so the view short-circuits for them. The materialized subtractions
can be cached within the view for repeated access to the same predicate
within one evaluation pass.

**Layering with partitioned evaluation (Phase 3):** Phase 1.5's lazy
view is independent of partitioning and delivers the first-order win
(O(|delta|) instead of O(|db|)). Phase 3's partition-scoped cloning
adds a second-order win: the fixpoint iteration count N becomes
per-partition, and each partition's view materializes only that
partition's entries. The two optimizations compose multiplicatively.

### Three-Level Stability Model

The plan decomposes stability into three independent levels, each with
different guarantees and costs. This replaces the spec's single "settled"
concept, which required depth-exhausted retraction chains — a predicate
that almost nothing satisfies under `maxDepth ≥ 1`.

**Why the spec's settling predicate fails:** With `maxDepth = 2`, an
un-retracted value constraint (depth 0) can always be retracted (depth 1)
by any agent. A depth-1 retraction can always be un-retracted (depth 2).
Only depth-2 chains (the undo-then-redo case) are "exhausted." Since the
vast majority of constraints are never retracted, the vast majority can
never settle under the spec's definition. The spec's §11.5 monotonicity
guarantee ("once settled, stays settled") is vacuously true because
nothing qualifies.

```typescript
// Three-level stability:

// Level 0: EVALUATION-STABLE (partition routing)
// "No delta has arrived for this partition in this step."
// Tracked by: delta routing layer in evaluateStratumFromDelta.
// Revocable: yes (next delta wakes it). Cost: O(1) per partition.
// → Provides per-step evaluation skip. Always available.

// Level 1: DORMANT (working-set tracking)
// "No constraint above V_stable contributes to this partition."
// Tracked by: trimWorkingSet() on frontier advancement.
// Revocable: yes (future constraint wakes partition). Cost: O(|active set|).
// → Provides cross-step evaluation skip and query-time optimization.

// Level 2: COMPACT-SAFE (space reclamation)
// "This constraint can be permanently removed from the store."
// Per spec §12.2: dominated/superseded below V_stable, or
//   depth-exhausted retraction pair below V_stable.
// Revocable: NO. Cost: O(|compaction candidates|).
// → Provides garbage collection. Applied selectively.
```

The key insight from DBSP: **the grouping function G_p is linear**
(Budiu & McSherry, 2023, §extensions). Partitioning by key adds zero
overhead to incremental computation. Combined with the evaluator's
existing `computeAffectedStrata`, partition routing at Level 0 already
gives O(|Δ| × |db_partition|) per step — no settling or dormancy needed.
Levels 1 and 2 are layered optimizations.

### Working-Set Tracking (Dormancy)

Dormancy replaces the spec's irrevocable "settled" concept with a
revocable "nothing is happening here" signal. The functional core /
imperative shell pattern applies:

```typescript
// New: working-set.ts — functional core (pure, testable)
interface DormancyPlan {
  /** Per-stratum: partition keys that became dormant. */
  readonly newlyDormant: ReadonlyMap<number, ReadonlySet<PartitionKey>>;
  /** Per-stratum: partition keys that woke up (received deltas above V_stable). */
  readonly newlyWoken: ReadonlyMap<number, ReadonlySet<PartitionKey>>;
}

function computeDormancyPlan(
  V_stable: VersionVector,
  projection: { accFacts: ..., constraintKeyFromFact: ... },
  strata: readonly Stratum[],
  store: { constraints: ..., versionVector: ... },
): DormancyPlan;
```

The pipeline applies the plan:

```typescript
interface IncrementalPipeline {
  // ... existing ...
  advanceFrontier(V_stable: VersionVector): void;
}
```

Internally, `advanceFrontier` calls `computeDormancyPlan` (pure), then
applies it to each stage (imperative: mark partitions as dormant).
Dormant partitions are skipped during `evaluateStratumFromDelta` but
participate in `current()`. The plan is directly testable.

**Dormancy vs. settling:**

| Property | Spec's "settled" | Dormancy |
|----------|-----------------|----------|
| Revocable | No | Yes |
| Requires depth-exhaustion | Yes | No |
| Coverage (typical) | ~0% of partitions | ~99% of partitions |
| Monotonic | Yes (vacuously) | No (by design) |
| Performance benefit | Theoretical | Practical |

When a delta arrives for a dormant partition, the partition wakes up.
This is not an error — it's the normal lifecycle. The wake cost is
O(|new_delta| × |partition_size|), no worse than if it had never been
dormant.

Dormancy propagates **bottom-up through strata**, mirroring evaluation
order. After marking stratum 0's dormant partitions, stratum 1 checks:
"for each partition key k, are all of stratum 0's derived predicates
for key k dormant?" This is a read of the lower stratum's dormancy
state after it is applied.

### Compaction (Level 2 — Irreversible)

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

Compaction removes constraints from the store. This is the only
irreversible operation and the only one that requires a strong safety
guarantee. The safe compaction rules from spec §12.2 provide this
**without requiring depth-exhaustion of un-retracted constraints**:

1. **Superseded value below frontier:** A value A with lamport 3 for
   slot S, when an active value B with lamport 5 for the same slot
   also exists below V_stable. A can never win again regardless of
   future retractions of B (any new value would get lamport ≥ 6).
   **No depth-exhaustion needed.** This is the common compaction case.

2. **Dominated value with exhausted chain:** A dominated value whose
   retraction chain has reached maxDepth below V_stable. This IS the
   depth-exhaustion case, but it only applies to constraints that have
   actually been retracted and un-retracted to maxDepth — the rare
   undo-then-redo scenario.

3. **Retraction pair below frontier:** A retract and its target, both
   below V_stable, when the retraction chain is depth-exhausted.

Compaction injects synthetic anti-facts (weight −1) for each compacted
constraint's projected facts into the evaluator, then removes the
constraint from the store. This ensures the evaluator's accumulated
`db` stays consistent with the post-compaction store, so
`pipeline.recompute()` (which calls `solve(store, config)`) continues
to equal `pipeline.current()`.

---

## Phases and Tasks

### Phase 1: Frontier Infrastructure 🟢 (complete)

Foundation: V_stable computation, finer-grained stratification, partition
key extraction, fact→constraint tracing. No behavioral changes to the
pipeline beyond stratification producing more strata.

#### Tasks

- **1.1** Add `vvMin(vvs: readonly VersionVector[]): VersionVector` to
  `version-vector.ts`. Component-wise minimum across all VVs. Empty input
  returns empty VV. 🟢

- **1.2** Add `isConstraintBelowFrontier(c: Constraint, frontier: VersionVector): boolean`
  to `version-vector.ts`. Delegates to `vvHasSeenCnId`. Semantic wrapper
  for readability. 🟢

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
  Verify the default LWW + Fugue rules produce 4 strata instead of 2. 🟢

- **1.4** Fix `strata.find()` in the evaluator's `step()` hot loop to
  use a `Map<number, Stratum>` lookup instead of linear search. This is
  a prerequisite for finer stratification — more strata means
  `strata.find()` cost matters. 🟢

- **1.5** Implement `extractPartitionKey(rules: readonly Rule[]): PartitionKeyInfo`
  in `stratify.ts`. For each rule, compute the intersection of variables
  in the head with variables in every positive/negation body atom.
  Intersect across all rules in the stratum. Map to tuple positions.
  Because strata are now fine-grained, this operates over rules that
  share predicates — the cross-rule intersection succeeds for the
  default rules. 🟢

- **1.6** Extend `Stratum` interface with `readonly partitionKey: PartitionKeyInfo`.
  Populate during `stratify()`. 🟢

- **1.7** Add `constraintKeyFromFact(f: Fact): string | null` to
  `kernel/projection.ts`. Reads `f.values[0]` for known fact predicates.
  O(1), no state. 🟢

- **1.8** Add `constraintToFacts: Map<string, Set<string>>` reverse index
  to the incremental projection stage. Update on project/retract. Expose
  `factsForConstraint(constraintKey)`. 🟢

- **1.9** Add `CompactionPolicy` type and `FrontierConfig` to
  `kernel/types.ts`. 🟢

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

### Phase 1.5: Lazy-View `constructDbOld` 🟢 (complete)

Replace the eager O(|db|) `constructDbOld` with a lazy `DatabaseView`
that materializes P_old = P_new − Δ only for predicates actually
accessed during rule evaluation. This is independent of partitioning
and delivers the first-order performance win for the Datalog evaluation
path.

**Motivation:** `constructDbOld` is called (1 + N) times per stratum
evaluation, where N is the fixpoint iteration count. For recursive
strata (transitive closure), N ≈ log₂(K). Each call currently clones
every predicate in the database — including predicates untouched by the
delta. A lazy view avoids this by sharing unchanged predicates and only
materializing the subtraction for predicates present in the delta.

#### Tasks

- **1.5.1** Introduce a `ReadonlyDatabase` interface in `types.ts` with
  `getRelation(pred): Relation`, `predicates(): Iterable<string>`, and
  `hasFact(f): boolean`. `Database` implements it. The evaluator
  functions (`evaluateRuleDelta`, `evaluatePositiveAtom`, etc.) already
  take `Database` — widen their parameter types to `ReadonlyDatabase`
  where they only read. 🟢

- **1.5.2** Implement `DatabaseView` in `evaluator.ts`. Constructor
  takes `(base: Database, delta: Database)`. `getRelation(pred)` returns
  `base.getRelation(pred)` when `delta.getRelation(pred).allEntryCount
  === 0` (zero-copy share), otherwise computes and caches
  `base.getRelation(pred).subtract(delta.getRelation(pred))`. The cache
  is a `Map<string, Relation>` local to the view instance. 🟢

- **1.5.3** Add `Relation.subtract(other: Relation): Relation` utility.
  Returns a new `Relation` with weights `this.weight − other.weight` for
  each entry. Entries with resulting weight 0 are pruned. This replaces
  the inline loop in the current `constructDbOld`. 🟢

- **1.5.4** Replace both call sites of `constructDbOld` in
  `evaluateStratumFromDelta` (seed phase + iteration loop) with
  `new DatabaseView(db, delta)`. Remove the `constructDbOld` function.
  Update the comment that incorrectly claims O(|delta|). 🟢

- **1.5.5** Verify that all existing tests pass unchanged — the lazy
  view is a pure performance optimization with identical semantics. 🟢

#### Tests

- `DatabaseView.getRelation` returns the base relation unchanged when
  delta has no entries for that predicate (identity — verify same object
  reference).
- `DatabaseView.getRelation` returns the correct P_old when delta has
  entries for that predicate (verify weights are subtracted).
- `DatabaseView` caches materialized relations (second call to
  `getRelation` for the same predicate returns the cached result).
- Three-way oracle (batch ≡ single-step ≡ one-at-a-time) continues to
  hold — primary correctness gate.
- Performance: for a database with 10 predicates and a delta touching 1,
  only 1 relation is materialized (the other 9 are shared).

### Phase 2: Partition-Aware Relation 🔴

Add optional partitioning support to the existing `Relation` class. No
behavioral changes to evaluation yet — this phase extends and tests the
data structure.

#### Tasks

- **2.1** Add internal partition state to `Relation`: optional
  `_partitions: Map<PartitionKey, Map<string, RelationEntry>> | null`,
  `_dormant: Set<PartitionKey>`, `_keyPositions: readonly number[] | null`,
  and `_keyFn: ((tuple: FactTuple) => PartitionKey) | null`. Default null
  (unpartitioned). 🔴

- **2.2** Implement `enablePartitioning(keyPositions)`. Reorganizes
  existing entries from the flat `_map` into per-key sub-maps. Sets
  `_keyFn` to a serializer based on `keyPositions`. 🔴

- **2.3** Implement `markDormant(key)`, `isDormant(key)`, `wake(key)`,
  `wakeAll()`. Dormancy adds key to `_dormant` set. Mutation attempts
  (`addWeighted`, `add`, `remove`) on a dormant key **auto-wake** the
  partition first, then proceed normally. This is revocable dormancy —
  not an invariant violation. 🔴

- **2.4** Update all existing `Relation` methods to branch on
  `_partitions !== null`. See the exhaustive `_map`-access checklist
  in Transitive Effect Analysis § "`Relation` gains optional partition
  mode" — 15 methods, 18 access sites. When partitioned: `add()`,
  `addWeighted()`, `remove()` route to the correct sub-map by key
  (auto-waking dormant partitions on mutation). `tuples()`,
  `weightedTuples()`, `allWeightedTuples()` iterate all sub-maps
  (dormant + active). `has()`, `getWeight()` look up in the correct
  sub-map. `size`, `allEntryCount`, `isEmpty()` aggregate across
  sub-maps. `subtract()` and `clone()` also branch. `union()` and
  `difference()` are batch-oracle-only (never partitioned in practice)
  but must not crash if called on a partitioned relation. 🔴

- **2.5** Add partition-scoped iteration: `partitionWeightedTuples(key)`,
  `partitionAllWeightedTuples(key)`. These return tuples for a single
  partition — the entry point for per-partition evaluation. 🔴

- **2.6** Update `clone()` to deep-clone partition structure (including
  dormant set) when partitioned. 🔴

- **2.7** Implement `serializePartitionKey(tuple, positions)` utility
  for extracting and serializing the key from a tuple. 🔴

#### Tests

- Relation without partitioning: all existing behavior unchanged (this is
  a regression gate — run existing Relation tests).
- `enablePartitioning` on a relation with existing entries: verify entries
  are redistributed correctly into sub-maps.
- Insert tuples with different keys into a partitioned relation. Verify
  `partitionWeightedTuples(k)` returns correct subset.
- Mark a partition dormant, verify `isDormant` returns true. Verify
  `tuples()` still includes dormant entries. Verify `addWeighted` on a
  dormant key auto-wakes it and succeeds (not throws).
- After auto-wake, verify `isDormant` returns false.
- `clone()` produces independent copy with correct dormant/active split.
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

Phase 1.5's lazy `DatabaseView` is the foundation here. Partition
routing composes with the lazy view: each partition's evaluation
creates a `DatabaseView` scoped to that partition's entries, so the
per-iteration materialization cost is O(|partition_delta|) instead of
O(|db|). For recursive strata, the fixpoint iteration count N also
becomes per-partition — a parent with 100 children iterates ~7 times
on its own partition, while a parent with 2 children iterates ~1 time,
rather than both paying for ~7 iterations over the full database.

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
  `partitionWeightedTuples` / `partitionAllWeightedTuples`). Skip
  dormant partitions — if inputDelta has entries for a dormant key,
  auto-wake the partition first (this is the revocable dormancy
  lifecycle). The inner loop code (evaluateRuleDelta,
  evaluatePositiveAtom, etc.) is unchanged — it receives fewer tuples,
  scoped to the partition. When PK is empty: evaluate the entire stratum
  as today. 🔴

- **3.3** Extend `DatabaseView` (Phase 1.5) with partition-scoped
  construction. For partitioned strata: the view wraps partition
  sub-relations, so `getRelation(pred)` returns only entries matching
  the current partition key. This composes with the lazy materialization
  — unchanged predicates are still zero-copy shared, and subtraction
  is scoped to the partition's entries. For non-partitioned strata:
  `DatabaseView` works as-is from Phase 1.5. 🔴

- **3.4** Skip dormant partitions in the evaluation loop. If inputDelta
  has entries for a dormant key, auto-wake the partition and evaluate
  normally. This is the expected lifecycle for revocable dormancy — not
  an error. 🔴

- **3.5** Wire partition key info through `step()` so that each stratum
  evaluation receives its `PartitionKeyInfo`. 🔴

- **3.6** On rule change (restratification), call `wakeAll()` on all
  partitioned relations BEFORE the wipe-and-replay path, then re-extract
  partition keys from new strata and re-enable partitioning with new key
  positions. The ordering matters: wake all → wipe derived → restratify →
  re-enable partitions → replay. This ensures the wipe doesn't attempt
  to mutate dormant partitions. 🔴

#### Tests

- Three-way oracle (batch ≡ single-step ≡ one-at-a-time) continues to
  hold for all existing test scenarios. This is the primary correctness
  gate — partitioned evaluation MUST produce identical results.
- LWW with 3 slots: insert values for all 3, mark slot 1 dormant,
  insert a new value for slot 2. Verify only slot 2's partition is
  evaluated. Verify slot 1's winner is unchanged. Verify slot 3's
  winner is unchanged.
- Fugue with 2 parents: insert children under both, mark parent 1
  dormant, insert a child under parent 2. Verify parent 1's ordering
  is unchanged. Verify parent 2 is correctly ordered.
- LWW and Fugue partitions are independent: making slot 1 (LWW) dormant
  does not affect parent 1 (Fugue), and vice versa — they are in
  different strata with different partition keys.
- Transitive closure with partition key: `reachable(X,Z) :- edge(X,Y),
  reachable(Y,Z)` — PK analysis finds no shared variable across all body
  atoms (X in head, X in edge, Y in reachable — not the same). Falls
  back to per-stratum. Verify correctness.
- Retraction in one partition doesn't affect another partition's derived
  facts.
- Partition-scoped `DatabaseView` only materializes P_old for the
  current partition's predicates (verify via a test that the dormant
  partition's relations are not materialized).
- Auto-wake on dormant partition: mark partition dormant, then insert a
  delta for it. Verify it wakes and evaluates correctly.
- Permutation test: all orderings of 3 values across 2 slots produce
  same resolution, with and without dormancy.

### Phase 4: Working-Set Tracking (Dormancy Protocol) 🔴

Implement dormancy as a two-phase protocol: `computeDormancyPlan` (pure
functional core, testable) and `applyDormancy` (imperative shell, mutates
stage state). The pipeline orchestrates frontier advancement. Dormancy
is revocable — a partition that receives a future delta wakes up.

This replaces the spec's irrevocable "settling" concept. See
§ Architecture: Three-Level Stability Model for the rationale.

#### Tasks

- **4.1** Create `src/kernel/working-set.ts` with `computeDormancyPlan`
  pure function. Inputs: V_stable, projection accumulated facts +
  `constraintKeyFromFact`, strata with partition keys, store constraints.
  Output: `DormancyPlan` describing which partition keys per-stratum
  became dormant (all contributing constraints below V_stable) and which
  woke up (new constraints above V_stable since last call).
  Dormancy propagates bottom-up through strata: after determining
  stratum 0's dormant partitions, stratum 1 checks whether its input
  partitions (from stratum 0's derived predicates) are all dormant. 🔴

- **4.2** Add `applyDormancy(plan: DormancyPlan)` to the Evaluator.
  For each stratum with a partition key: mark the identified partitions
  as dormant. Dormant partitions are skipped in the partition routing
  loop (Phase 3, Task 3.2). When a delta arrives for a dormant
  partition, automatically wake it (move back to active set). 🔴

- **4.3** Add `applyDormancy` to the evaluation stage wrapper
  (`incremental/evaluation.ts`). For the native path: mark per-slot
  state in `IncrementalLWW` and per-parent state in `IncrementalFugue`
  as dormant. For the Datalog path: delegate to the evaluator's
  `applyDormancy`. 🔴

- **4.4** Wire `advanceFrontier(V_stable)` into `IncrementalPipeline`.
  Calls `computeDormancyPlan` (pure), then `applyDormancy` on the
  evaluation stage. For now, called manually by the application. 🔴

- **4.5** Add `dormantPartitions(): ReadonlyMap<number, ReadonlySet<string>>`
  to the pipeline interface. Returns per-stratum dormant partition keys.
  Useful for introspection and testing. 🔴

- **4.6** Add `wakePartition(stratumIndex, key)` internal method to the
  evaluator. Called automatically by the partition routing layer (Phase 3,
  Task 3.2) when a delta arrives for a dormant partition. O(1). 🔴

#### Tests

- Single-agent dormancy: create pipeline, insert 3 constraints for
  slot A, advance frontier to store VV. Verify slot A is dormant.
- Multi-agent dormancy: two agents, agent A has VV {a:3, b:0}, agent B
  has VV {a:0, b:5}. V_stable = {a:0, b:0}. Nothing dormant (all
  constraints above frontier). Exchange VVs: V_stable = {a:3, b:5}.
  Everything below becomes dormant.
- Retracted value still becomes dormant: insert value, retract it,
  retraction chain at depth 1 (not exhausted). Both below V_stable.
  Verify partition IS dormant — dormancy doesn't require depth-exhaustion.
- Wake on new delta: dormant slot A, insert a new value for slot A above
  V_stable. Verify slot A wakes up and is correctly evaluated. Verify
  other dormant slots remain dormant.
- Rule constraint above V_stable prevents dormancy of affected strata.
- After dormancy, insert a new value for a different slot. Verify
  dormant slot is skipped in evaluation. Verify the new slot is
  correctly evaluated.
- Differential test: after `advanceFrontier`, verify
  `pipeline.current()` === `pipeline.recompute()`.
- Dormancy is not monotonic: advance frontier, verify dormant. Insert
  new constraint for dormant slot above frontier. Verify it wakes.
  Advance frontier again. Verify it goes dormant again.

### Phase 5: Compaction 🔴

Remove compactable constraints from the store. This is the only
irreversible operation and uses the spec §12.2 safe compaction rules.
Unlike dormancy, compaction requires a strong safety guarantee — but
the common case (superseded values) does NOT require depth-exhaustion.

#### Tasks

- **5.1** Implement `identifyCompactable(store, V_stable, retraction, policy): CnId[]`
  as a pure function. Applies spec §12.2 safe compaction rules:
  - **Superseded values below frontier:** Value A with lower lamport than
    active value B for the same slot, both below V_stable. A can never
    win again regardless of future retractions of B (any new value gets
    lamport ≥ max + 1). **No depth-exhaustion needed.**
  - **Dominated values with exhausted chains:** Dominated value whose
    retraction chain has reached maxDepth below V_stable.
  - **Retraction pairs below frontier:** Retract + target, both below
    V_stable, chain depth-exhausted.
  - Structure and authority constraints are never compacted. 🔴

- **5.2** Add `removeConstraints(store, ids: CnId[])` to `store.ts`.
  Removes constraints from the store's map. Does NOT update VV or
  lamport (those only grow). Increments generation. 🔴

- **5.3** Implement `compact(V_stable, policy)` on `IncrementalPipeline`.
  Calls `identifyCompactable`, then for each compacted constraint:
  inject synthetic weight −1 deltas through the projection and
  evaluation stages (via the `constraintToFacts` reverse index) to
  remove the compacted constraint's derived facts from the evaluator's
  accumulated `db`. Then call `removeConstraints` on the store. This
  ensures `pipeline.recompute()` (which calls `solve(store, config)`)
  continues to equal `pipeline.current()`. 🔴

- **5.4** Under `snapshot-preserving` policy: consult bookmark constraints
  to find preserved version vectors. Retain constraints that contributed
  to any preserved snapshot even if otherwise compactable. 🔴

- **5.5** Verify `pipeline.current()` is unchanged after compaction.
  Verify `pipeline.recompute()` equals `pipeline.current()` after
  compaction. 🔴

#### Tests

- Compact superseded value (common case): insert value A (L=10), insert
  value B (L=20) for same slot. Both below V_stable, both un-retracted.
  Compact. Verify A is removed from store (A is superseded — no depth-
  exhaustion needed). Verify reality unchanged.
- Compact dominated value with exhausted chain: insert value, retract it,
  un-retract the retraction (depth 2 = maxDepth). All below V_stable.
  Compact. Verify dominated constraints removed. Verify reality unchanged.
- Compact retraction pair: insert value, retract it. Both below V_stable,
  chain at depth 1 of maxDepth 2. Compact. Verify ONLY the superseded-
  value rule applies (if another value exists); the retraction pair is
  NOT compactable (depth not exhausted). Verify reality unchanged.
- Un-retracted value is NOT compactable via dominated-value rule: insert
  single value for a slot, below V_stable, no retraction. Verify it is
  NOT removed (it's the only value — not superseded, not dominated).
- Structure and authority constraints survive compaction.
- Snapshot-preserving: bookmark at V1. Insert more constraints. Advance
  frontier past V1. Compact with `snapshot-preserving`. Verify constraints
  needed for V1 snapshot are retained.
- Differential test: `solve(store, config)` after compaction produces
  same reality as `pipeline.current()`.
- Compaction + dormancy interaction: compact a superseded value in a
  dormant partition. Verify partition remains dormant. Verify evaluator
  state is consistent.

### Phase 6: Documentation and Verification 🔴

#### Tasks

- **6.1** Run full test suite. Verify all tests pass. 🔴

- **6.2** Update `TECHNICAL.md`: add "Partitioned Evaluation and
  Working Sets" section describing per-partition evaluation, dormancy
  tracking, partition key extraction, arranged relations, and compaction.
  Update "Future Work" to mark 007 complete. Update "Incremental
  Pipeline" section to describe frontier advancement. 🔴

- **6.3** Update `LEARNINGS.md` with discoveries from implementation. 🔴

- **6.4** Update `.plans/004-incremental-roadmap.md`: add Plan 006.2
  (missing), update Plan 006.1 status to complete, add Plan 007 status,
  update dependency graph. 🔴

- **6.5** Update `theory/incremental.md` §7: replace placeholder text
  with concrete description of per-partition evaluation and the three-level
  stability model (evaluation-stable, dormant, compact-safe). Amend the
  settled/working discussion to reflect revocable dormancy replacing
  irrevocable settling. 🔴

- **6.6** Update `theory/unified-engine.md` §11: add a note that the
  "depth-exhausted" predicate in §11.2 condition 2 is impractical for
  un-retracted constraints under `maxDepth ≥ 1`, and that the
  implementation uses revocable dormancy for the evaluation performance
  guarantee, reserving the strong settling predicate for compaction
  (§12) only. 🔴

---

## Transitive Effect Analysis

### `computeSettlingPlan` replaced by `computeDormancyPlan`

**Direct:** The settling protocol is replaced with dormancy tracking.
`src/kernel/settling.ts` becomes `src/kernel/working-set.ts`. The output
type `SettlingPlan` becomes `DormancyPlan`. The `applySettling` methods
on each stage become `applyDormancy` on the evaluation stage only
(retraction, projection, and skeleton do not need dormancy tracking —
dormancy is an evaluation-layer optimization).

**Transitive:** Tests that assert "settled" must be rewritten to assert
"dormant." Tests that assert "never unsettles" must be removed or
converted to "dormant → wake → dormant" lifecycle tests. The dormancy
protocol is simpler than settling because it doesn't need to check
retraction chain depth — only whether constraints are below V_stable.

**Risk:** The `Relation.markDormant()` / `isDormant()` / `wake()` API
uses revocable dormancy semantics — mutation attempts on a dormant
partition **auto-wake and proceed** rather than throw. This is
fundamentally different from the original "freeze" design. Task 2.3
implements this: `addWeighted` on a dormant key calls `wake(key)` first,
then mutates normally. No code should ever assume dormancy prevents
mutation.

### `constructDbOld` replaced by lazy `DatabaseView`

**Direct:** `constructDbOld` (which calls `db.clone()`) is removed.
Both call sites in `evaluateStratumFromDelta` — seed phase and
per-iteration — are replaced with `new DatabaseView(db, delta)`.
`evaluateRuleDelta`, `evaluatePositiveAtom`, and other functions that
accept a `Database` parameter are widened to accept `ReadonlyDatabase`.
`Relation` gains a `subtract(other)` method.

**Transitive:** The `DatabaseView` is a read-only wrapper — it never
mutates `db`. Functions that previously received a `Database` (for
`dbOld`) only ever read from it (calling `getRelation`, `hasFact`),
so widening to `ReadonlyDatabase` is safe. The batch oracle
(`evaluateNaive`) does not use `constructDbOld` and is unaffected.

**Risk:** If any code path writes to `dbOld` (calling `addWeightedFact`,
`addFact`, etc.), the `ReadonlyDatabase` interface would catch this at
compile time — that's the point of the interface. Inspection of
`evaluateStratumFromDelta` confirms `dbOld` is only read: it's passed
as the `dbOld` argument to `evaluateRuleDelta`, which uses it for
lookups in the asymmetric join (positions after `deltaIdx` read from
`dbOld`).

**Performance semantics:** The lazy view caches materialized
subtractions in a per-instance `Map<string, Relation>`. Within a
single `evaluateStratumFromDelta` invocation, each predicate is
subtracted at most once per view instance. Across fixpoint iterations,
each iteration creates a fresh `DatabaseView` with a new (typically
small) `currentDelta`, so caching does not leak across iterations.

**Mitigation:** Three-way oracle (batch ≡ single-step ≡ one-at-a-time)
is the primary correctness gate. `DatabaseView.getRelation` must
return the same results as the old `constructDbOld` for all predicates
— this is verified by the existing evaluator test suite.

### `Relation` gains optional partition mode (with dormancy, not freeze)

**Direct:** `Relation`'s internal storage structure changes when
`enablePartitioning` is called. Every method that accesses `_map`
directly must branch on `isPartitioned`. Mutation of a dormant
partition auto-wakes it rather than throwing. Exhaustive checklist of
`_map`-accessing methods (18 access sites across 15 methods):

| Method | Access pattern | Notes |
|--------|---------------|-------|
| `size` | iterate values | aggregate across partitions |
| `allEntryCount` | `.size` | sum partition map sizes |
| `tuples()` | iterate values | concatenate partitions |
| `weightedTuples()` | iterate values | concatenate partitions |
| `allWeightedTuples()` | iterate values | concatenate partitions |
| `add()` | get/set/delete by key | route by partition key |
| `has()` | get by key | route by partition key |
| `addWeighted()` | get/set/delete by key | route by partition key |
| `getWeight()` | get by key | route by partition key |
| `remove()` | get/delete by key | route by partition key |
| `union()` | iterate + set on result | batch oracle only (never partitioned) |
| `difference()` | iterate + set on result | batch oracle only (never partitioned) |
| `isEmpty()` | iterate values | short-circuit across partitions |
| `subtract()` | iterate + get on both | Phase 1.5 addition; see note below |
| `clone()` | iterate entries | deep-clone partition structure |

**`subtract` note:** Added in Phase 1.5, after the original transitive
analysis. Only called from `DatabaseView.getRelation()`. In the Phase 3
design, partition routing happens *above* `evaluateStratumFromDelta`, so
`subtract` always receives unpartitioned relations (base flat relation or
per-partition slice). Nevertheless, the method must branch for
defensive correctness — a partitioned `Relation` passed to `subtract`
must not silently read an empty `_map`.

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

### Compaction injects synthetic anti-deltas

**Direct:** When a constraint is compacted, its projected facts must be
removed from the evaluator's accumulated `db`. This is done by injecting
weight −1 deltas for each of the constraint's facts (found via
`constraintToFacts` reverse index) through the projection and evaluation
stages. This is conceptually equivalent to the constraint being retracted,
except that the store entry is also removed.

**Transitive:** The anti-deltas flow through the normal pipeline path
(projection → evaluation → skeleton). The evaluator processes them as
it would any retraction delta. The skeleton may emit `valueChanged` or
`childRemoved` deltas — but for a superseded value (the common
compaction case), the fact has weight 0 in the derived relations already,
so the anti-delta propagation is a no-op (removing a zero-weight entry).

**Risk:** For dominated values being compacted, the fact IS present with
non-zero weight in intermediate stages (the retraction stage suppressed
it from the active set, but the projection stage still has the fact
accumulated). The anti-delta injection must target the projection stage,
not the evaluation stage, to properly cascade through the pipeline.

**Mitigation:** Differential testing after compaction: verify
`pipeline.current() === pipeline.recompute()`. This catches any
inconsistency between the incremental state and the post-compaction store.

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

This is the existing `recompute()` oracle extended to cover dormancy
and compaction. It catches any divergence between the incremental path
(with dormant partitions) and the batch path (which sees all constraints
remaining in the store).

### Partition Key Oracle

For each stratum with a non-empty partition key, verify that evaluating
the stratum partitioned produces identical results to evaluating it
non-partitioned. This is the per-stratum analog of the three-way oracle.

### Dormancy Lifecycle

Dormancy is explicitly **not** monotonic. Verify the full lifecycle:
1. `advanceFrontier` — record dormant set. Verify expected partitions dormant.
2. Insert a new constraint for a dormant partition above V_stable. Verify
   the partition wakes (moves to active).
3. `advanceFrontier` again with a higher V_stable covering the new
   constraint. Verify the partition goes dormant again.
4. Insert a constraint for a *different* slot. Verify the previously
   dormant partition remains dormant (no cross-partition wake).

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

| File | Changes | Status |
|------|---------|--------|
| `src/kernel/version-vector.ts` | Add `vvMin`, `isConstraintBelowFrontier` | ✅ Phase 1 |
| `src/datalog/stratify.ts` | Finer-grained stratification (split independent SCCs), add `extractPartitionKey`, extend `Stratum` | ✅ Phase 1 |
| `src/datalog/types.ts` | Add `ReadonlyDatabase` interface, `Relation.subtract()` (Phase 1.5); add partition mode with dormancy to `Relation` (Phase 2) | ⚬ `ReadonlyDatabase` + `subtract()` done (Phase 1.5); partition mode in Phase 2 |
| `src/datalog/evaluator.ts` | `DatabaseView` lazy-view replacement for `constructDbOld` (Phase 1.5); partition routing in `step()`, partition-scoped `DatabaseView`, partition setup in `createEvaluator`, rule-change `wakeAll` (Phase 3) | ⚬ `strataByIndex` Map done (Phase 1); `DatabaseView` done (Phase 1.5); partition routing in Phase 3 |
| `src/datalog/evaluate.ts` | Widen `Database` params to `ReadonlyDatabase` where read-only | ✅ Phase 1.5 |
| `src/datalog/aggregate.ts` | Widen `Database` params to `ReadonlyDatabase` where read-only | ✅ Phase 1.5 |
| `src/kernel/projection.ts` | Add `constraintKeyFromFact` utility | ✅ Phase 1 |
| `src/kernel/incremental/projection.ts` | `constraintToFacts` reverse index, `factsForConstraint` | ✅ Phase 1 |
| `src/kernel/incremental/evaluation.ts` | `applyDormancy` delegation | Phase 4 |
| `src/kernel/incremental/pipeline.ts` | `advanceFrontier`, `compact`, `dormantPartitions` | Phases 4–5 |
| `src/kernel/store.ts` | `removeConstraints` | Phase 5 |
| `src/kernel/types.ts` | `CompactionPolicy`, `FrontierConfig` | ✅ Phase 1 |
| `src/solver/incremental-lww.ts` | Per-slot dormancy tracking | Phase 4 |
| `src/solver/incremental-fugue.ts` | Per-parent dormancy tracking | Phase 4 |
| `theory/partitioned-settling.md` | Amend §3.2 to note finer-grained stratification requirement; add §3.4 functional-lookup relaxation | ✅ Phase 1 |
| `theory/incremental.md` | §7: three-level stability model, dormancy replacing settling | Phase 6 |
| `theory/unified-engine.md` | §11: note on depth-exhaustion impracticality | Phase 6 |
| `TECHNICAL.md` | Partitioned evaluation and working sets section | Phase 6 |
| `LEARNINGS.md` | Implementation discoveries | Phase 6 |
| `.plans/004-incremental-roadmap.md` | Status updates, 006.2 addition | Phase 6 |

### Files to Add

| File | Purpose |
|------|---------|
| `src/kernel/working-set.ts` | `computeDormancyPlan` pure function (functional core) |

### Test Files to Add/Modify

| File | Changes |
|------|---------|
| `tests/kernel/version-vector.test.ts` | `vvMin` tests |
| `tests/datalog/stratify.test.ts` | Finer-grained stratification tests, `extractPartitionKey` tests |
| `tests/datalog/database-view.test.ts` | New: `Relation.subtract`, `DatabaseView`, `ReadonlyDatabase` conformance, integration tests |
| `tests/datalog/evaluator.test.ts` | Partitioned evaluation, dormancy, rule-change unfreeze tests (Phase 3); evaluator correctness with finer strata |
| `tests/kernel/projection.test.ts` | `constraintKeyFromFact` tests |
| `tests/kernel/incremental/projection.test.ts` | `constraintToFacts` reverse index tests |
| `tests/kernel/working-set.test.ts` | New: `computeDormancyPlan` pure function tests |
| `tests/kernel/incremental/pipeline.test.ts` | `advanceFrontier`, `compact`, dormancy lifecycle tests |

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

### Depth-Exhaustion Is the Wrong Settling Predicate — Dormancy Replaces It

The spec §11.2 defines settling as requiring "retraction chains are
depth-exhausted below V_stable." Analysis reveals this is impractical:
with `maxDepth = 2`, an un-retracted value constraint (depth 0) can
always be retracted (depth 1) by any agent. A depth-1 retraction can
always be un-retracted (depth 2). Only the rare undo-then-redo case
(depth 2 = maxDepth) qualifies. The vast majority of constraints —
simple writes that are never retracted — can never settle.

The fix decomposes the problem into three levels:
1. **Evaluation-stable:** No delta for this partition this step. Free.
2. **Dormant:** No constraint above V_stable for this partition. Revocable.
3. **Compact-safe:** Constraint can be permanently removed. Irreversible.

Level 1 provides the evaluation skip that the spec attributes to settling.
Level 2 provides cross-step dormancy. Level 3 provides space reclamation.
Only Level 3 needs an irreversibility guarantee — and the common case
(superseded values) satisfies it without depth-exhaustion.

The key DBSP insight: partition routing (the linear grouping function G_p)
already gives O(|Δ| × |db_partition|) per step at Level 0, with no
settling or dormancy concept at all. Levels 1-2 are layered optimizations.

The spec's "once settled, stays settled" monotonicity property (§11.5)
was vacuously true (nothing qualified) and operationally useless. Dormancy
is explicitly non-monotonic: a partition can go dormant → active → dormant.
This is a feature, not a defect — it reflects the reality that any agent
can create new constraints at any time.

### Correctness vs. Performance vs. Space Are Three Independent Concerns

The original plan conflated three concerns under "settling":
- **Correctness** of incremental evaluation (Z-set algebra handles this)
- **Performance** of skipping unchanged data (partition routing handles this)
- **Space** reclamation (compaction handles this)

Each has a different mechanism and different requirements:
- Correctness needs nothing new (Plans 005–006.2 deliver it).
- Performance needs partition routing + delta-driven wake/sleep (Phases 2–4).
- Space needs targeted GC of zero-weight entries (Phase 5).

Trying to solve all three with one concept ("settling") led to a predicate
so strong (depth-exhaustion) that it was useless in practice. Decomposing
into layers lets each layer use the weakest predicate that works.

### Superseded Values Don't Need Depth-Exhaustion for Compaction

The spec §12.2 compaction rule for superseded values: "c is a value
constraint for a slot, and a higher-lamport active value constraint for
the same slot exists, and both are below V_stable." This rule does NOT
require depth-exhaustion. Value A (lamport 3) is permanently superseded
by value B (lamport 5) regardless of what happens to B — even if B is
retracted, any future value gets lamport ≥ 6. A can never win again.

This is the common compaction case: most slots have one current winner
and zero or more historical losers. The losers are compactable as soon
as they're below V_stable, without waiting for retraction chains to
exhaust. This observation makes compaction practically useful even
without the depth-exhaustion predicate working for the general case.

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
phase). The theory document `theory/partitioned-settling.md` §3.2 has
been amended with an implementation note describing the finer-grained
stratification requirement and the ground-predicate exclusion rule.

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
dominates. Furthermore, `constructDbOld` is called **(1 + N) times per
stratum evaluation** — once in the seed phase, once per fixpoint
iteration — where N is the fixpoint iteration count. Across S affected
strata, total clone cost per `step()` is:

  **(1 + N₁) + (1 + N₂) + ... + (1 + Nₛ)** full O(|db|) clones

For non-recursive strata (`superseded`, `winner`), N = 0 — exactly 1
clone each. For recursive strata (`fugue_child` + `fugue_descendant`,
`fugue_before`), N ≈ log₂(K) where K is the partition size under the
semi-naive doubling strategy. A parent with 100 children means ~8 clones
of the entire database for one stratum evaluation.

**Important caveat:** For the default rules, the native `IncrementalLWW`
+ `IncrementalFugue` solvers bypass the Datalog evaluator entirely, so
`constructDbOld` cost is zero on the native path. This cost only
manifests when custom rules push the system onto the Datalog path.

The fix has two independent, composable levels:

1. **Lazy-view `DatabaseView` (Phase 1.5):** Replace `db.clone()` with
   a lazy view that shares unchanged predicates and only materializes
   P_old for predicates present in the delta. Cost drops from O(|db|)
   to O(|delta|) per invocation. This is independent of partitioning.

2. **Partition-scoped views (Phase 3):** The `DatabaseView` wraps
   partition sub-relations, so materialization is scoped to one
   partition's entries. Additionally, fixpoint iteration count N becomes
   per-partition — a parent with 100 children iterates ~7 times on its
   own partition, a parent with 2 children iterates ~1 time, rather
   than both paying for the maximum.

For 10,000 settled slots and 3 active slots, the combined effect is
dramatic: Phase 1.5 eliminates cloning of untouched predicates;
Phase 3 ensures each iteration only touches the active partition.

### Cross-Stratum Dormancy Must Be Explicit

Per-partition dormancy within a stratum is straightforward: check if all
input facts for key k come from constraints below V_stable. But cross-
stratum dormancy requires checking the *lower* stratum's derived
predicates: "is stratum 0's output partition for key k dormant?" This
must propagate bottom-up through strata in evaluation order, and the
`computeDormancyPlan` function must process strata sequentially (not
independently) to read lower-stratum dormancy state.

### Functional-Lookup Relaxation Recovers Fugue Partitionability

The `fugue_child` rule joins `active_structure_seq(CnId, Parent, OL, OR)`
with `constraint_peer(CnId, Peer)`. A naive per-rule variable intersection
gives PK = `{CnId}` for `fugue_child` (since `Parent` is absent from
`constraint_peer`), while `fugue_descendant` gives PK = `{Parent}`. The
cross-rule intersection `{CnId} ∩ {Parent} = ∅` — apparently destroying
partitionability.

The fix: recognize that `constraint_peer` is a **functional lookup**. Its
join variable `CnId` is already bound by `active_structure_seq`, which
contains `Parent`. For a fixed `Parent`, the matching `constraint_peer`
facts are fully determined — no cross-partition dependency exists. The
`extractPartitionKey` algorithm now computes the cross-rule head
intersection first (`{Parent}`), then validates each rule using a
reachability analysis: starting from `{Parent}`, it traces through atoms
that contain PK variables to determine which other atoms are "PK-covered"
(all their variables are reachable). `constraint_peer` is PK-covered
because `CnId` reaches it from `active_structure_seq`. Only PK-required
atoms must contain the PK. Result: all 4 strata are partitionable.

### Enumerate Over Abstract for Representation Swaps

Phase 2 will swap `Relation`'s internal storage from a flat `_map` to
a partitioned `Map<PartitionKey, Map<string, RelationEntry>>`. Every
method that accesses `_map` directly (18 access sites across 15 methods)
must branch on `isPartitioned`. This is a classic shotgun-surgery risk.

We considered introducing a storage abstraction (e.g., a `RelationStorage`
interface with `get`, `set`, `delete`, `values`, `size` that both flat
and partitioned implementations satisfy). Every method would delegate to
this instead of `_map` directly, and Phase 2 would just swap the
implementation.

We rejected this because the access patterns are too varied to abstract
cleanly — some methods iterate all entries, some do keyed lookups, some
do both, some create new Relations and write into their `_map` directly.
A bad abstraction boundary would be worse than no abstraction. And the
refactor would touch every method today for a benefit that only
materializes in Phase 2.

Instead, we maintain an **exhaustive checklist** of `_map`-accessing
methods in the Transitive Effect Analysis (§ "`Relation` gains optional
partition mode"). Phase 2 works against this checklist rather than
relying on grep-at-implementation-time. This also caught `subtract()`
(added in Phase 1.5, after the original analysis) — any new method
that touches `_map` gets added to the table immediately.

The general principle: when a future phase will swap a representation,
and the access surface is wide but the change is one-shot, an
enumerated checklist is cheaper and more reliable than a speculative
abstraction layer.

### Rule Changes Must Reset Partition State

When rules change, the partition structure may change (different partition
keys, or a previously partitionable stratum becoming non-partitionable).
The existing wipe-and-replay on rule change handles the *data* correctly,
but the *partition metadata* (key extractors, dormancy sets) must also be
reset. `wakeAll()` + re-`enablePartitioning()` with new key positions
handles this. Note: `wakeAll()` must run BEFORE the wipe-and-replay
path in `step()` — otherwise the wipe would attempt to mutate dormant
partitions. The ordering is: wake all → wipe derived → restratify →
re-enable partitions → replay.