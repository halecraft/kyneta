# Plan 006: Incremental Datalog Evaluator

## Background

Plan 005 (complete) transformed the solver pipeline from full recomputation to
delta-driven for all Layer 0 kernel stages. After Plan 005, inserting a constraint
propagates through validity, structure index, retraction, projection, and skeleton
in O(|Δ|). However, the evaluation stage — the Datalog evaluator and native
solvers — remains batch. On every insertion, the pipeline calls
`evaluate(rules, allFacts)` or `buildNativeResolution(allActive, index)` over the
full accumulated state, then diffs the result against a cached previous
`ResolutionResult` to produce Z-set deltas for the skeleton.

This is the remaining O(|S|) bottleneck. Plan 006 eliminates it.

### Key Specification References

- unified-engine.md §9.5 (rule constraint incremental handling)
- unified-engine.md §9.6 (delta propagation)
- unified-engine.md §14 (stratification layers)
- unified-engine.md §B.3 (Datalog evaluator requirements)
- unified-engine.md §B.4 (default solver rules as data)
- unified-engine.md §B.7 (native solver optimization)
- theory/incremental.md §9 (incremental Datalog evaluator in detail)
- theory/incremental.md §4 (stage interface)
- theory/incremental.md §5.6 (Datalog evaluation stage)
- theory/incremental.md §5.7 (resolution extraction stage)
- theory/incremental.md §9.7 (native solver fast path)

## Problem Statement

The incremental pipeline's evaluation stage calls the batch Datalog evaluator (or
batch native solvers) on every constraint insertion. For a store with |S| active
constraints, the evaluation cost is O(|S|) per insertion regardless of how small
the actual change is. The kernel stages upstream produce O(|Δ|) deltas, but the
evaluation stage discards this work by materializing full accumulated state and
recomputing from scratch.

The diffing shim (`diffResolution`) that converts batch `ResolutionResult` into
Z-set deltas for the skeleton is an additional O(|winners| + |fuguePairs|) per
insertion — a cost that exists solely because the evaluator doesn't produce
deltas natively.

## Success Criteria

1. The incremental pipeline processes constraint insertions end-to-end in O(|Δ|)
   for the common case (default LWW/Fugue rules, single value or structure
   insertion).
2. An incremental evaluation stage exists that receives `ZSet<Fact>` deltas from
   projection and produces `ZSet<ResolvedWinner>` + `ZSet<FugueBeforePair>`
   deltas for the skeleton.
3. Native incremental solvers (LWW per-slot winner tracking, Fugue per-parent
   tree maintenance) activate when default rules are detected and produce the
   same delta types as the incremental Datalog path.
4. When a `rule` constraint is added or retracted, the affected strata are
   re-evaluated and the pipeline produces correct deltas without full
   recomputation of unaffected regions.
5. `incrementalPipeline.current()` continues to produce a `Reality` identical to
   `solve(store, config)` — verified by the existing differential tests plus new
   ones.
6. The `diffResolution` shim is eliminated from the pipeline composition root.
   Calls to `retraction.current()` / `projection.current()` for evaluation
   purposes are eliminated when the native path is active (Phase 4) and for all
   paths once the incremental Datalog evaluator replaces the batch fallback
   (Phase 7).
7. All existing 1098 tests continue to pass.

## Gap Analysis

### What Exists

- **Z-set type and algebra** (`base/zset.ts`) — complete, used by all kernel stages.
- **Batch Datalog evaluator** (`datalog/evaluate.ts`) — stratified, semi-naive,
  with negation and aggregation. ~400 LOC. No weight tracking, no cross-time
  state.
- **Batch native solvers** (`solver/lww.ts`, `solver/fugue.ts`) — correct,
  equivalence-tested against Datalog.
- **`Relation` and `Database` classes** (`datalog/types.ts`) — set-based (boolean
  membership), no integer weights. `Relation` is backed by `Set<string>` +
  `FactTuple[]`.
- **Resolution bridge** (`kernel/resolve.ts`) — `extractResolution`,
  `nativeResolution`, `topologicalOrderFromPairs`. Clean typed boundary.
- **Incremental pipeline composition** (`kernel/incremental/pipeline.ts`) —
  wires all kernel stages, calls batch evaluator, uses `diffResolution` shim.
- **`diffResolution`** — temporary shim that compares old/new `ResolutionResult`
  to produce Z-set deltas. Has a known key-collision hazard for changed winners.
  Contains reusable Fugue pair diffing logic that should be extracted.
- **Default rule definitions** (`bootstrap.ts`) — 3 LWW rules + 8 Fugue rules
  at Layer 1, exported as `buildDefaultLWWRules()` / `buildDefaultFugueRules()`.
- **Rule pattern detection** — `isDefaultRulesOnly`, `hasDefaultLWWRules`,
  `hasDefaultFugueRules` duplicated in both `pipeline.ts` and
  `incremental/pipeline.ts`.
- **Equivalence tests** — 23 Fugue + 11 LWW tests verifying native ≡ Datalog.
- **Differential tests** — 42 incremental pipeline tests using `recompute()` as
  oracle.

### What's Missing

1. **Per-predicate Z-set accumulated state** — the batch evaluator creates a
   fresh `Database` per call. The incremental evaluator must maintain derived
   relations as `Map<string, ZSet<Fact>>` across `step()` calls, reusing the
   existing Z-set algebra (`zsetAdd`, `zsetNegate`, etc.) rather than introducing
   a parallel weighted type.
2. **Cross-time semi-naive** — the batch evaluator is semi-naive within a single
   call but not across calls. The incremental evaluator must use new input facts
   (the delta from projection) as the initial delta for semi-naive iteration,
   computing only what changed.
3. **Delta-aware negation** — when a new fact satisfies a previously-failed
   negation (e.g., a new `superseded` fact invalidates a `winner`), the evaluator
   must retract dependent derivations and rederive.
4. **Native incremental LWW** — per-slot winner tracking with O(1) comparison
   and Z-set delta emission.
5. **Native incremental Fugue** — per-parent tree maintenance with delta
   emission of changed `fugue_before` pairs.
6. **Incremental resolution extraction** — convert derived-fact deltas to typed
   `ZSet<ResolvedWinner>` + `ZSet<FugueBeforePair>` directly, without
   materializing a full `ResolutionResult`.
7. **Rule addition/retraction handling** — when a `rule` constraint becomes
   active or dominated, re-evaluate affected strata.
8. **Pipeline rewiring** — replace the batch evaluator call + diffResolution shim
   with the incremental evaluation stage.
9. **Shared rule-detection utilities** — deduplicate `extractRules`,
   `isDefaultRulesOnly`, etc.

## Core Type Definitions

### WeightedDatabase (Per-Predicate Z-Sets)

The incremental Datalog evaluator's accumulated state is `Map<string, ZSet<Fact>>`
— one Z-set per predicate. This reuses the existing Z-set algebra entirely.
No new weighted-relation type is needed.

```typescript
// Used inline — not a separate module. Type alias for clarity.
type WeightedDatabase = Map<string, ZSet<Fact>>;

// Utility functions (in datalog/incremental-evaluate.ts, not exported)
function wdbGetTuples(wdb: WeightedDatabase, predicate: string): readonly FactTuple[];
function wdbApplyDelta(wdb: WeightedDatabase, delta: ZSet<Fact>): void;
function wdbHasFact(wdb: WeightedDatabase, f: Fact): boolean;
```

### CachedRelation (Semi-Naive Performance)

The batch evaluator's rule-eval functions (`evaluateRule`, `evaluateRuleSemiNaive`,
`evaluatePositiveAtom`, `evaluateNegation`) ultimately call
`matchAtomAgainstRelation(atom, tuples, sub)` which takes `readonly FactTuple[]`.
During semi-naive iteration, the accumulated state (`fullDb`) is read many times
but never mutated — mutations go to `nextDelta` which is only read in the next
iteration.

A lazily-cached tuples array avoids rebuilding on every access:

```typescript
// Private to datalog/incremental-evaluate.ts — not exported.
interface CachedRelation {
  readonly predicate: string;
  zset: ZSet<Fact>;                    // authoritative state
  _cachedTuples: FactTuple[] | null;   // invalidated on mutation
}

function crTuples(cr: CachedRelation): readonly FactTuple[] {
  if (cr._cachedTuples === null) {
    cr._cachedTuples = [];
    for (const entry of cr.zset.values()) {
      if (entry.weight > 0) cr._cachedTuples.push(entry.element.values);
    }
  }
  return cr._cachedTuples;
}

function crApply(cr: CachedRelation, delta: ZSet<Fact>): void {
  if (delta.size === 0) return;
  cr.zset = zsetAdd(cr.zset, delta);
  cr._cachedTuples = null;  // invalidate
}
```

This is correct because:
- During semi-naive, `fullDb`'s relations are stable → cache built once, hit N times.
- `currentDelta` is fresh each iteration → cache built once, hit N times.
- `nextDelta` is write-only within an iteration → no cache needed.

### Incremental Evaluation Stage

```typescript
// kernel/incremental/evaluation.ts

interface IncrementalEvaluation {
  /**
   * Process a delta of projected facts and return resolution deltas.
   *
   * @param deltaFacts - Z-set delta from the projection stage.
   * @param deltaRules - Changed rules (weight +1 = added, −1 = retracted).
   *                     Empty on most insertions.
   * @returns Resolution deltas for the skeleton stage.
   */
  step(
    deltaFacts: ZSet<Fact>,
    deltaRules: ZSet<Rule>,
  ): {
    deltaResolved: ZSet<ResolvedWinner>;
    deltaFuguePairs: ZSet<FugueBeforePair>;
  };

  /** Full materialized resolution result. */
  current(): ResolutionResult;

  /** Reset to empty state. */
  reset(): void;
}
```

### Native Incremental LWW

```typescript
// solver/incremental-lww.ts

interface IncrementalLWW {
  /** Process active_value fact deltas, return winner deltas. */
  step(deltaFacts: ZSet<Fact>): ZSet<ResolvedWinner>;

  /** Current winners map. */
  current(): ReadonlyMap<string, ResolvedWinner>;

  reset(): void;
}
```

### Native Incremental Fugue

```typescript
// solver/incremental-fugue.ts

interface IncrementalFugue {
  /**
   * Process structure/peer fact deltas, return ordering pair deltas.
   * Consumes active_structure_seq and constraint_peer facts.
   */
  step(deltaFacts: ZSet<Fact>): ZSet<FugueBeforePair>;

  /** Current fugue pairs by parent. */
  current(): ReadonlyMap<string, readonly FugueBeforePair[]>;

  reset(): void;
}
```

## Architecture

The evaluation stage sits between projection and skeleton in the incremental
DAG. It replaces the batch evaluator call + diffResolution shim:

```
        P^Δ (projection)
          │
          ▼
        Δ_facts: ZSet<Fact>
          │
          ▼
    ┌─────────────────────────────────────────────┐
    │  E^Δ (incremental evaluation)               │
    │                                             │
    │  ┌─ isDefaultRulesOnly? ───┐                │
    │  │                         │                │
    │  YES                       NO               │
    │  │                         │                │
    │  ▼                         ▼                │
    │  Native incremental        Incremental      │
    │  LWW + Fugue               Datalog          │
    │  │                         │                │
    │  └─────────┬───────────────┘                │
    │            │                                │
    │            ▼                                │
    │  { Δ_resolved, Δ_fuguePairs }               │
    └─────────────────────────────────────────────┘
          │
          ▼
        K^Δ (skeleton)
```

The evaluation stage is a **strategy wrapper** that delegates to either the
native incremental solvers or the incremental Datalog evaluator based on rule
detection. Both paths produce the same delta types. The strategy can switch
mid-stream when rules are added or retracted.

### Functional Core / Imperative Shell Separation

The evaluation stage has three responsibilities that should be separated:

1. **Strategy selection** (pure): `(rules, activeConstraints) → 'native' | 'datalog'`
2. **Fact routing** (pure): `(ZSet<Fact>) → { lwwFacts, fugueFacts, otherFacts }`
   — splitting by predicate via `zsetFilter`
3. **Strategy state management** (imperative): hold native solver state or Datalog
   state, delegate `step()` calls

Functions 1 and 2 should be independently testable pure functions. Function 3 is
the imperative shell that composes them. The existing `isDefaultRulesOnly` (once
extracted in Phase 1) serves as function 1. Function 2 is a `zsetFilter` by
predicate — trivial but worth extracting for test clarity.

### Strategy Switching on Rule Change

When a `rule` constraint is added or retracted:

1. The retraction stage emits the rule constraint in its `Δ_active` output.
2. The pipeline detects the rule change and passes it as `deltaRules` to the
   evaluation stage.
3. The evaluation stage re-checks `isDefaultRulesOnly`:
   - If switching **from native to Datalog** (custom rule added): bootstrap the
     Datalog evaluator from accumulated ground facts, then continue
     incrementally.
   - If switching **from Datalog to native** (custom rule retracted, defaults
     restored): bootstrap native solvers from accumulated ground facts, then
     continue incrementally.
4. On strategy switch, compute the diff between the old strategy's accumulated
   resolution and the new strategy's resolution. Emit the diff as a delta.

This is the rare path. The common path is: no rule change, same strategy,
process `deltaFacts` through the active strategy's `step()`.

### Stratum Structure for Default Rules

Running the actual stratifier (`stratify(buildDefaultRules())`) produces this
layout:

| Stratum | Predicates | Rules | Negation? | Notes |
|---------|-----------|-------|-----------|-------|
| 0 | `active_value`, `superseded`, `active_structure_seq`, `constraint_peer`, `fugue_child`, `fugue_descendant` | 5 | No | All positive: joins, self-joins with guards, transitive closure |
| 1 | `winner`, `fugue_before` | 6 | **Yes** | `winner` negates `superseded`; `fugue_before` negates `fugue_descendant` |

Only **two strata**, not five. This is simpler than anticipated: the stratifier
puts all purely-positive predicates (including `superseded` and
`fugue_descendant`) into stratum 0, and everything that negates a stratum-0
predicate into stratum 1.

**Consequence for affected-stratum tracking:** A change to `active_value` affects
stratum 0 (where `superseded` is derived) and propagates to stratum 1 (where
`winner` negates `superseded`). A change to `active_structure_seq` or
`constraint_peer` affects stratum 0 (where `fugue_child`, `fugue_descendant` are
derived) and propagates to stratum 1 (where `fugue_before` negates
`fugue_descendant`). The "which strata are affected" computation is trivial with
only two strata.

**Correction to theory/incremental.md §9.5:** The theory claims Fugue rules are
all positive (monotone). This is incorrect — rule 5 (`fugueBeforeSubtreeProp`)
uses `not fugue_descendant(Parent, B, X)`. The `fugue_before` stratum requires
negation handling, not simple monotone evaluation. However, `fugue_descendant`
is in a lower stratum (purely positive), so the negation is well-stratified and
the DRed approach applies.

This correction does not change the architecture — it means the incremental
Datalog evaluator needs negation handling for Fugue rules too, not just LWW.
The native fast path bypasses this entirely, so the practical impact on the
common case is nil.

### Incremental Datalog: The Nested-Stream Construction

Following DBSP §4–5 and theory/incremental.md §9.3:

**Outer stream** (cross-time): Each constraint insertion is one time step.
Between steps, the evaluator maintains accumulated derived relations per stratum
as `Map<string, ZSet<Fact>>`.

**Inner stream** (intra-time): Within one time step, semi-naive fixed-point
iteration runs from the input delta to convergence.

At outer time t, when `Δ_facts[t]` arrives:

1. Apply `Δ_facts[t]` to the accumulated ground facts (via `zsetAdd` per
   predicate).
2. For each affected stratum (bottom-up):
   a. **Monotone strata** (no negation): run semi-naive from the input delta.
      New derived facts have weight +1. No retractions possible.
   b. **Negation strata**: run the DRed pattern — delete derivations whose
      support was removed, then rederive from the updated database. Net delta
      may contain both +1 and −1 entries.
3. Update accumulated derived relations with the step's delta (via `zsetAdd`).
4. Output `Δ_derived[t]`.

### Why Native Fast Path First

The native incremental solvers (LWW per-slot tracking, Fugue per-parent tree)
are:
- Simpler to implement (O(1) LWW comparison, standard Fugue tree insert)
- Sufficient for the common case (default rules, no custom Layer 2+ rules)
- Independently verifiable against the batch native solvers and batch Datalog
- A correctness oracle for the incremental Datalog evaluator

The incremental Datalog evaluator is:
- Essential for custom rules, user queries, cross-container constraints
- The architecturally important piece (it's what makes CCS programmable)
- More complex (DRed for negation, cross-time semi-naive)

Building native first gives us end-to-end incremental performance for the
common case and a three-way oracle (batch Datalog ≡ batch native ≡ incremental
native) before tackling the harder problem.

## Phases and Tasks

### Phase 1: Shared Utilities Extraction 🔴

Extract duplicated code from `kernel/pipeline.ts` and
`kernel/incremental/pipeline.ts` into shared modules. Both files contain
identical copies of `extractRules`, `isDefaultRulesOnly`, `hasDefaultLWWRules`,
`hasDefaultFugueRules`, `buildNativeResolution`, and `buildNativeFuguePairs`.

Also extract reusable patterns that are currently inline or will be needed by
multiple consumers in later phases:
- The Fugue pair diffing logic from `diffResolution`.
- The "ordered nodes → all-pairs" loop (duplicated in both `buildNativeFuguePairs`
  copies, needed again by incremental Fugue in Phase 3).
- A canonical `fuguePairKey` function (currently an inline closure in
  `diffResolution`, needed by incremental Fugue and incremental Datalog
  resolution extraction).
- The resolution strategy decision tree (identical `if/else` chain in both
  pipelines, needed by the evaluation stage in Phase 4).

#### Tasks

- 1.1 Create `kernel/rule-detection.ts` with the shared functions: `extractRules`,
  `isDefaultRulesOnly`, `hasDefaultLWWRules`, `hasDefaultFugueRules`,
  `selectResolutionStrategy(enableDatalog, rules, activeConstraints) → 'native' | 'datalog'`
  (the pure strategy selector — currently an identical if/else chain in both
  pipeline files). 🔴
- 1.2 Add `fuguePairKey(p: FugueBeforePair) → string` to `kernel/resolve.ts`,
  following the Z-set key convention (alongside `cnIdKey` for constraints,
  `factKey` for facts, `slotId` for winners). 🔴
- 1.3 Add `allPairsFromOrdered(parentKey: string, ordered: readonly FugueNode[]) → FugueBeforePair[]`
  to `kernel/resolve.ts`. This is the "ordered nodes → all-pairs" nested loop
  that is currently duplicated in both `buildNativeFuguePairs` copies and will be
  needed by incremental Fugue. 🔴
- 1.4 Create `kernel/native-resolution.ts` with `buildNativeResolution` and
  `buildNativeFuguePairs` (refactored to use `allPairsFromOrdered`). 🔴
- 1.5 Extract `diffFuguePairs(oldPairs, newPairs) → ZSet<FugueBeforePair>` from
  the Fugue pair section of `diffResolution` into `kernel/native-resolution.ts`,
  refactored to use `fuguePairKey`. Reused by incremental Fugue in Phase 3. 🔴
- 1.6 Update `kernel/pipeline.ts` to import from the shared modules instead of
  defining its own copies. 🔴
- 1.7 Update `kernel/incremental/pipeline.ts` to import from the shared modules
  instead of defining its own copies. 🔴
- 1.8 Verify all 1098 existing tests still pass. 🔴

#### Tests

No new tests — this is a pure refactor. Existing tests are the verification.

### Phase 2: Native Incremental LWW 🔴

Implement per-slot winner tracking that receives `active_value` fact deltas and
emits `ZSet<ResolvedWinner>` deltas. This is the O(1) fast path for LWW
resolution described in theory/incremental.md §9.7.

#### Design

Maintain a `Map<slotId, { entries: Map<cnIdKey, LWWEntry>, winner: LWWEntry | null }>`.
On each fact delta:

- **+1 (new active_value):** Parse the fact tuple into an `LWWEntry`. Add to the
  slot's entries. Compare against current winner. If it wins, emit
  `{old winner: −1, new winner: +1}` — but keyed by slotId, so emit as a single
  +1 replacement (matching the skeleton's contract from Plan 005).
- **−1 (retracted active_value):** Remove from the slot's entries. If it was the
  winner, recompute winner from remaining entries. Emit delta.

The fact format is `active_value(CnId, Slot, Content, Lamport, Peer)` — columns
defined in `kernel/projection.ts` as `ACTIVE_VALUE`. Parsing a fact tuple into
an `LWWEntry` is the inverse of what `projectValue` does in `projection.ts`.
This parser (`parseLWWFact`) should live in `kernel/resolve.ts` alongside
`extractWinners` (which does the same parsing from Datalog `Database` tuples)
— it will be reused by the incremental Datalog evaluator's resolution extraction
(Phase 6, task 6.9).

#### Tasks

- 2.1 Add `parseLWWFact(f: Fact) → LWWEntry` to `kernel/resolve.ts`. Parses an
  `active_value` fact tuple using `ACTIVE_VALUE` column positions. 🔴
- 2.2 Create `solver/incremental-lww.ts` implementing `IncrementalLWW`. 🔴
- 2.3 Add slot-level entry tracking with O(1) winner comparison on insertion. 🔴
- 2.4 Handle fact retraction (weight −1): remove entry, recompute winner if
  needed. 🔴
- 2.5 Emit `ZSet<ResolvedWinner>` deltas following the skeleton's +1-only
  contract for changed winners (see Plan 005 Learnings: Resolution Diffing). 🔴

#### Tests

- Incremental LWW produces same winners as batch `resolveLWW` for arbitrary
  insertion sequences (differential test). 🔴
- Single value insertion: winner delta is `{slot: +1}`. 🔴
- Superseding value: winner delta is `{slot: +1}` (replacement, not −1 then +1). 🔴
- Value retraction when it was the winner: delta is either `{slot: +1}` (new
  winner) or `{slot: −1}` (no winner left). 🔴
- Value retraction when it was NOT the winner: empty delta. 🔴
- Permutation test: all orderings of 3 values produce same `current()`. 🔴

### Phase 3: Native Incremental Fugue 🔴

Implement per-parent Fugue tree maintenance that receives `active_structure_seq`
and `constraint_peer` fact deltas and emits `ZSet<FugueBeforePair>` deltas.

#### Design

Maintain a `Map<parentKey, { nodes: FugueNode[], orderedKeys: string[], pairs: Map<pairKey, FugueBeforePair> }>`.
On each new seq structure fact:

1. Parse the fact tuple into a `FugueNode`.
2. Add to the parent's node set.
3. Recompute Fugue ordering for the parent (using existing `orderFugueNodes`).
4. Diff old pairs vs new pairs using `diffFuguePairs` (extracted in Phase 1).
5. Emit added pairs as +1, removed pairs as −1.

This is O(n²) in the parent's element count for the pair diff (where n is the
number of children of that specific parent). For a full incremental Fugue tree
with O(1) pair emission, we would need to track exactly which pairs change on
insertion — but this requires deep Fugue algorithm changes. Since the native
fast path is already dramatically faster than batch Datalog (we only recompute
one parent's ordering, not all parents), and n is typically small (a single
parent's direct children), the simpler approach is correct and practical.

Fugue facts never arrive with weight −1 because structure constraints are
immune to retraction. The step function can assert this invariant.

#### Tasks

- 3.1 Add `parseSeqStructureFact(f: Fact) → { cnIdKey, parentKey, originLeft, originRight }`
  to `kernel/resolve.ts`. Parses an `active_structure_seq` fact tuple using
  `ACTIVE_STRUCTURE_SEQ` column positions. Reused by incremental Datalog
  resolution extraction (Phase 6). 🔴
- 3.2 Create `solver/incremental-fugue.ts` implementing `IncrementalFugue`. 🔴
- 3.3 Maintain per-parent `FugueNode[]` and accumulated pair set. 🔴
- 3.4 On new seq structure fact: recompute ordering for affected parent only
  using `orderFugueNodes`, compute pairs via `allPairsFromOrdered` (from
  Phase 1), diff against accumulated pairs via `diffFuguePairs` (from Phase 1),
  emit delta. 🔴
- 3.5 Handle `constraint_peer` facts: correlate with pending structure facts
  (a structure fact and its peer fact may arrive in either order within a
  single delta). 🔴

#### Tests

- Incremental Fugue produces same pairs as batch `buildNativeFuguePairs` for
  arbitrary insertion sequences (differential test). 🔴
- Single element insertion: emits no pairs (only one element). 🔴
- Second element: emits one `(a, b)` pair. 🔴
- Third element at different positions: correct pair deltas. 🔴
- Permutation test: all orderings produce same `current()`. 🔴
- Multi-parent: changes to one parent don't affect another. 🔴

### Phase 4: Evaluation Stage Wrapper and Pipeline Rewiring 🔴

Create the `IncrementalEvaluation` stage that wraps native solvers (and later,
incremental Datalog), wire it into the pipeline, and eliminate the batch
evaluator call + diffResolution shim.

#### Design

The evaluation stage:
1. Receives `ZSet<Fact>` from projection and `ZSet<Rule>` from rule detection.
2. Uses a pure **fact router** to split `ZSet<Fact>` by predicate (LWW facts
   vs Fugue facts vs other).
3. Uses the pure **strategy selector** (`selectResolutionStrategy` from Phase 1)
   to pick native vs Datalog path.
4. Delegates to native incremental LWW + Fugue when strategy is `'native'`.
5. Falls back to batch Datalog (existing `evaluate()`) when strategy is
   `'datalog'` (the incremental Datalog evaluator replaces this in Phase 7).
6. Produces `{ deltaResolved, deltaFuguePairs }` directly — no diffing shim.

The pipeline composition root changes:
- Remove `cachedResolution` state.
- Remove `diffResolution()` call.
- When native path is active: no calls to `retraction.current()` /
  `projection.current()` for evaluation.
- When batch Datalog fallback is active (custom rules, until Phase 7): still
  calls `projection.current()` for the batch evaluator.
- The `enableDatalogEvaluation` config flag is superseded by the evaluation
  stage's strategy selector for the incremental pipeline. The evaluation stage
  always attempts the best strategy based on active rules — `enableDatalog`
  remains in `PipelineConfig` for the batch pipeline but the incremental
  pipeline stops reading it.
- Route `Δ_facts` from projection directly to the evaluation stage's `step()`.
- Route rule changes (detected from the active-set delta) to `step()` as
  `deltaRules`.

#### Rule Change Detection

The pipeline inspects `Δ_active` (output of retraction) for rule constraints:
```typescript
// In processConstraint():
const ruleDeltas: ZSet<Rule> = extractRuleDeltasFromActive(activeDelta);
```
A rule constraint appearing with weight +1 in `Δ_active` means a new rule
became active. Weight −1 means a rule was dominated (retracted). These are
passed to the evaluation stage, which decides whether to switch strategy.

#### Tasks

- 4.1 Create `kernel/incremental/evaluation.ts` implementing
  `IncrementalEvaluation`. 🔴
- 4.2 Implement the pure fact router: split `ZSet<Fact>` by predicate into LWW
  input (`active_value`) and Fugue input (`active_structure_seq`,
  `constraint_peer`). Independently testable. 🔴
- 4.3 Implement native-path delegation: route split fact deltas to
  `IncrementalLWW` and `IncrementalFugue`. 🔴
- 4.4 Implement batch-Datalog fallback for custom rules (call `evaluate()` on
  full accumulated facts, then diff — same as current behavior but encapsulated
  within the evaluation stage). 🔴
- 4.5 Implement strategy detection: check `isDefaultRulesOnly` on rule changes,
  switch between native and Datalog paths. 🔴
- 4.6 Implement strategy switching: on switch, compute resolution from the new
  strategy over accumulated facts, diff against old strategy's accumulated
  resolution, emit delta. 🔴
- 4.7 Rewire `kernel/incremental/pipeline.ts`: remove `cachedResolution`,
  `diffResolution`, batch evaluator call. Wire evaluation stage into the
  DAG. 🔴
- 4.8 Pass rule deltas from retraction output to evaluation stage. 🔴

#### Tests

- All 42 existing differential pipeline tests pass with the rewired pipeline. 🔴
- Native path produces identical results to old batch+diff path. 🔴
- Pure fact router: correctly splits mixed `ZSet<Fact>` by predicate. 🔴
- Pipeline with custom Layer 2 rule falls back to batch Datalog, produces
  correct reality. 🔴
- Rule addition: default rules → custom rule added → Datalog path activates,
  correct reality. 🔴
- Rule retraction: custom rule retracted → native path reactivates, correct
  reality. 🔴

### Phase 5: Z-Set Utilities for Datalog 🔴

Add utility functions over `ZSet<Fact>` that the incremental Datalog evaluator
needs. No new type — the evaluator uses `Map<string, ZSet<Fact>>` (a
`WeightedDatabase`) for its accumulated state, reusing the existing Z-set
algebra directly.

#### Design

The incremental evaluator needs a small set of operations that compose existing
Z-set primitives with Datalog-specific concerns:

- **Per-predicate grouping**: split a mixed `ZSet<Fact>` into per-predicate
  Z-sets (for applying deltas to the right relation).
- **Positive-weight tuple extraction**: get `readonly FactTuple[]` from a
  `ZSet<Fact>` (for feeding to `matchAtomAgainstRelation`).
- **Fact membership check**: `zsetHas` with `factKey` as key.
- **`distinct` operator**: clamp negative weights to zero, cap positive weights
  at 1 (DBSP §1.2). Needed after recursive semi-naive steps.

These are utility functions in `datalog/incremental-evaluate.ts`, not a public
module. The `CachedRelation` wrapper (see Core Type Definitions) is also defined
here — private to the evaluator, providing lazy tuples-array caching for
semi-naive performance.

#### Tasks

- 5.1 Implement `groupByPredicate(zs: ZSet<Fact>) → Map<string, ZSet<Fact>>`
  — splits a mixed fact Z-set into per-predicate Z-sets. 🔴
- 5.2 Implement `positiveTuples(zs: ZSet<Fact>) → readonly FactTuple[]` —
  extracts tuples from positive-weight entries. 🔴
- 5.3 Implement `zsetDistinct(zs: ZSet<Fact>) → ZSet<Fact>` — clamps weights
  (negative → 0, positive → 1). 🔴
- 5.4 Implement the `CachedRelation` interface and `crTuples` / `crApply`
  functions for lazy tuple caching during semi-naive iteration. 🔴

#### Tests

- `groupByPredicate` correctly splits mixed facts. 🔴
- `positiveTuples` returns only weight > 0 entries. 🔴
- `zsetDistinct` clamps correctly: negative removed, positive capped at 1. 🔴
- `CachedRelation`: tuples cache is built on first access, invalidated on
  `crApply`, rebuilt on next access. 🔴

### Phase 6: Incremental Datalog Evaluator 🔴

Implement the cross-time incremental Datalog evaluator. This is the core of
Plan 006 — the component that makes custom rules, user queries, and
cross-container constraints incremental.

#### Design

The evaluator maintains:
- **Accumulated ground facts**: `Map<string, CachedRelation>` — per-predicate
  Z-sets with lazy tuple caching.
- **Accumulated derived facts**: `Map<string, CachedRelation>` — per stratum
  per predicate.
- **The current stratification** (recomputed when rules change).

On `step(deltaFacts)`:

1. Apply `deltaFacts` to accumulated ground facts (via `crApply` per predicate).
2. Determine affected strata: a predicate that changed affects every stratum
   whose rules reference that predicate (directly or transitively). With only
   two strata for default rules, this is trivial — any ground-fact change
   affects stratum 0, and any stratum-0 output change affects stratum 1.
3. For each affected stratum, bottom-up:

   **Monotone strata** (no negation, no aggregation):
   - Use the delta as the initial delta for semi-naive iteration.
   - Run semi-naive: for each rule, for each positive body atom index, evaluate
     the rule with that atom matched against the delta (via `crTuples`), others
     against full accumulated relations (via `crTuples` — cache hit).
   - New derivations have weight +1 (monotone — can't retract).
   - Merge new derivations into accumulated derived facts (via `crApply`).

   **Negation/aggregation strata** (DRed pattern):
   - **Delete phase**: For each retracted input fact (weight −1 in delta),
     identify derived facts that depended on it. Tentatively retract them
     (weight −1). For negation: if a new fact now satisfies a previously-failed
     `not P(...)`, the derivations that relied on that negation are invalidated.
   - **Rederive phase**: Run semi-naive from the combined delta (new +1 facts
     and tentatively retracted −1 facts). Some tentatively retracted facts may
     be rederived via alternative derivation paths.
   - Net delta: the +1 and −1 entries that survived after rederivation.

4. If a lower stratum's output changed, propagate the delta upward.
5. Output the net `Δ_derived`.

**Reusing batch evaluator internals:** The rule-eval functions (`evaluateRule`,
`evaluateRuleSemiNaive`, `evaluatePositiveAtom`, `evaluateNegation`,
`evaluateGuardElement`, `evaluateAggregationElement`, `groundHead`) are currently
private in `datalog/evaluate.ts`. They take `Database` parameters, and
`evaluatePositiveAtom` calls `db.getRelation(pred).tuples()`.

The incremental evaluator bridges this by building a lightweight `Database`
adapter from its `CachedRelation` state — presenting only positive-weight tuples
as `Relation.tuples()`. Since the accumulated state is stable during semi-naive
(mutations go to `nextDelta`), this adapter is built once per semi-naive pass.
Alternatively, the internal functions could be extracted into a
`datalog/rule-eval.ts` module that takes a tuple-lookup function instead of
`Database`. The simpler adapter approach is preferred initially.

**Simplification for our default rules:** The DRed pattern is general-purpose,
but our LWW rules have a specific structure: `superseded` is monotone (only
produces +1), and `winner` negates `superseded`. When a new `superseded` fact
arrives, the only effect on `winner` is: the old winner (if superseded) gets
−1, the new winner gets +1. We implement the general DRed pattern, but the
specific structure of LWW means the delete phase is bounded to O(1) per slot.

#### Tasks

- 6.1 Create `datalog/incremental-evaluate.ts` with the core evaluator. 🔴
- 6.2 Export the batch evaluator's rule-eval helpers from `datalog/evaluate.ts`
  (or extract into `datalog/rule-eval.ts`): `evaluateRule`,
  `evaluateRuleSemiNaive`, `evaluatePositiveAtom`, `evaluateNegation`,
  `evaluateGuardElement`, `evaluateAggregationElement`, `groundHead`,
  `getPositiveAtomIndices`. 🔴
- 6.3 Implement accumulated state management: ground facts and derived facts
  per stratum, using `CachedRelation` (per-predicate Z-sets with lazy tuple
  caching). 🔴
- 6.4 Implement the `Database` adapter: build a read-only `Database` from
  `CachedRelation` state (positive-weight tuples only) for passing to the
  batch evaluator's rule-eval functions. 🔴
- 6.5 Implement cross-time semi-naive for monotone strata: receive delta,
  run semi-naive from delta, merge new derivations. 🔴
- 6.6 Implement DRed for negation strata: delete phase (identify invalidated
  derivations from input retractions and newly-satisfied negations), rederive
  phase (semi-naive from combined delta). 🔴
- 6.7 Implement stratum dependency tracking: when stratum 0's output changes,
  propagate to stratum 1. 🔴
- 6.8 Implement rule change handling: on `deltaRules`, restratify and
  recompute affected strata from accumulated ground facts. 🔴
- 6.9 Add incremental resolution extraction: convert `Δ_derived` (containing
  `winner` and `fugue_before` fact deltas) directly to
  `ZSet<ResolvedWinner>` + `ZSet<FugueBeforePair>` via `zsetMap` on the
  per-predicate Z-sets. Reuse `parseLWWFact` (Phase 2) for winner facts and
  `fuguePairKey` (Phase 1) for pair keying. 🔴

#### Tests

- Monotone stratum: new `active_structure_seq` fact produces correct
  `fugue_child` derivation. 🔴
- Monotone transitive closure: new `fugue_child` produces correct
  `fugue_descendant` chain. 🔴
- Negation stratum (LWW): new `active_value` that supersedes current winner
  produces `{old winner: −1, new winner: +1}` delta. 🔴
- Negation stratum (LWW): new `active_value` that does NOT supersede produces
  empty winner delta. 🔴
- Negation stratum (Fugue): new element with subtree propagation guard
  produces correct `fugue_before` deltas. 🔴
- Fact retraction: retracted `active_value` causes winner recomputation. 🔴
- Three-way equivalence: incremental Datalog ≡ batch Datalog ≡ native solver
  for all default-rule test cases. 🔴
- Permutation test: all orderings produce same `current()`. 🔴
- Rule addition: adding a custom superseded rule changes resolution. 🔴

### Phase 7: Wire Incremental Datalog into Evaluation Stage 🔴

Replace the batch Datalog fallback in the evaluation stage with the incremental
Datalog evaluator from Phase 6. After this phase, all paths are incremental —
no batch evaluator calls remain in the incremental pipeline.

#### Tasks

- 7.1 Update `kernel/incremental/evaluation.ts`: when custom rules are detected,
  delegate to incremental Datalog evaluator instead of batch `evaluate()`. 🔴
- 7.2 Implement strategy switch from native to incremental Datalog: bootstrap
  the Datalog evaluator from accumulated ground facts on first switch. 🔴
- 7.3 Implement strategy switch from incremental Datalog back to native:
  discard Datalog state, bootstrap native solvers from accumulated facts. 🔴
- 7.4 Remove all remaining batch evaluator calls and `projection.current()`
  calls from the incremental pipeline (the batch pipeline in
  `kernel/pipeline.ts` remains unchanged). 🔴
- 7.5 Full end-to-end differential testing: every insertion verified against
  `solve(store, config)`. 🔴

#### Tests

- Pipeline with custom LWW rule (e.g., priority-based instead of lamport-based):
  incremental produces correct reality. 🔴
- Rule addition mid-stream: existing values re-resolved under new rules. 🔴
- Rule retraction mid-stream: values re-resolved under restored defaults. 🔴
- Pipeline with aggregation rule (e.g., count-based resolution): correct. 🔴

### Phase 8: Documentation and Cleanup 🔴

#### Tasks

- 8.1 Update TECHNICAL.md: document the incremental evaluation stage, native
  incremental solvers, strategy switching, `ZSet<Fact>` as the unified type for
  weighted Datalog relations. Correct the "Incremental Pipeline" section to
  reflect Plan 006 changes. Note that `ResolutionResult` is no longer the
  inter-stage type between evaluation and skeleton — `ZSet<ResolvedWinner>` +
  `ZSet<FugueBeforePair>` are. `ResolutionResult` remains as a materialization
  convenience for `current()`, `PipelineResult`, and strategy switching. 🔴
- 8.2 Update theory/incremental.md §9.5: correct the claim that Fugue rules are
  all positive (rule 5 uses negation). Note the actual two-stratum layout. 🔴
- 8.3 Update `.plans/004-incremental-roadmap.md`: mark Plan 005 complete, mark
  Plan 006 complete. 🔴
- 8.4 Add LEARNINGS.md entries for discoveries during implementation. 🔴
- 8.5 Complete Plan 005 Phase 9 (documentation cleanup) if still pending. 🔴

## Transitive Effect Analysis

### The Batch Pipeline Is Preserved — No Backwards Compatibility Risk

`kernel/pipeline.ts` (`solve`, `solveFull`) is unchanged. All existing tests
that use the batch pipeline continue to work. The incremental pipeline is a
separate code path that happens to call the batch pipeline via `recompute()` for
differential testing.

### Incremental Pipeline Composition Changes

`kernel/incremental/pipeline.ts` is the primary modified module. The changes
are:
- Remove: `cachedResolution`, `diffResolution()`, calls to `retraction.current()`
  and `projection.current()` for evaluation (native path in Phase 4; all paths
  in Phase 7), `buildNativeResolution()` inline calls.
- Add: `IncrementalEvaluation` stage creation, rule delta extraction from
  `Δ_active`, evaluation `step()` call.
- The `processConstraint()` function body changes significantly but its external
  contract (insert → RealityDelta) is identical.

### Skeleton Contract Preserved

The skeleton stage already consumes `ZSet<ResolvedWinner>` and
`ZSet<FugueBeforePair>`. The evaluation stage produces these same types. The
skeleton is not modified.

### New Module Dependency Chain

```
base/zset.ts                              (existing — unchanged, reused everywhere)
     ↑
datalog/types.ts                          (existing — factKey, Fact, serializeValue)
datalog/evaluate.ts                       (existing — exports rule-eval helpers)
     ↑
datalog/incremental-evaluate.ts           (NEW — CachedRelation, Database adapter,
                                           cross-time semi-naive, DRed. Depends on
                                           datalog/types, datalog/evaluate, datalog/stratify,
                                           datalog/unify, base/zset)
     ↑
solver/incremental-lww.ts                 (NEW — depends on base/zset, kernel/resolve types,
                                           kernel/projection constants, solver/lww)
solver/incremental-fugue.ts               (NEW — depends on base/zset, kernel/resolve types,
                                           solver/fugue)
     ↑
kernel/rule-detection.ts                  (NEW — depends on kernel/types, datalog/types)
kernel/native-resolution.ts              (NEW — depends on solver/lww, solver/fugue,
                                           kernel/resolve, kernel/structure-index)
     ↑
kernel/incremental/evaluation.ts          (NEW — depends on all above + kernel/resolve)
     ↑
kernel/incremental/pipeline.ts            (composition root — updated, not new)
```

**Direction**: `base → datalog → solver → kernel/incremental`. No circular
dependencies. The incremental Datalog evaluator imports from the batch
evaluator's rule evaluation functions but does not modify them.

### Export Surface Changes

New exports added to `src/index.ts`:
- `IncrementalEvaluation`, `createIncrementalEvaluation`
- `IncrementalLWW`, `createIncrementalLWW`
- `IncrementalFugue`, `createIncrementalFugue`
- `extractRules`, `isDefaultRulesOnly`, `selectResolutionStrategy` (from shared module)
- `fuguePairKey`, `allPairsFromOrdered`, `parseLWWFact`, `parseSeqStructureFact`
  (canonical utilities in `kernel/resolve.ts`)

No new public type for weighted relations — `ZSet<Fact>` is the type.

Existing exports unchanged.

### Re-use of Batch Evaluator Internals

The incremental Datalog evaluator reuses the batch evaluator's per-rule
evaluation logic (`evaluateRule`, `evaluateRuleSemiNaive`,
`evaluatePositiveAtom`, `evaluateNegation`, `evaluateGuardElement`,
`evaluateAggregationElement`, `groundHead`). These are currently private
functions in `datalog/evaluate.ts`. Phase 6 exports them (or extracts them
into a shared `datalog/rule-eval.ts` module). The batch evaluator's
`evaluate()`, `evaluatePositive()`, and `evaluateNaive()` public functions
remain unchanged.

The bridge between the incremental evaluator's `ZSet<Fact>` state and the batch
evaluator's `Database`-typed parameters is a lightweight adapter that presents
positive-weight tuples as a `Database`. This adapter is internal to the
incremental evaluator — not a public type.

## Testing Strategy

### Three-Way Oracle

For default rules, every test verifies:
```
incrementalNative.current() == incrementalDatalog.current() == solve(store, config)
```

### Differential Tests (per stage)

Each new stage (`IncrementalLWW`, `IncrementalFugue`, `IncrementalEvaluation`)
has its own differential tests comparing `current()` against the batch
equivalent after each insertion.

### Permutation Tests

For small constraint sets (3–5 constraints), verify that all insertion orderings
produce the same `current()`. This catches order-dependent bugs in accumulated
state management.

### Existing Tests

All 1098 existing tests continue to pass. The 42 incremental pipeline
differential tests exercise the new code path after Phase 4.

### Custom Rule Tests

New tests for rule addition/retraction mid-stream, verifying that strategy
switching produces correct deltas and that the final reality matches batch.

## Directory Structure

```
src/
  base/
    zset.ts                          (existing — unchanged)
  datalog/
    types.ts                         (existing — unchanged)
    evaluate.ts                      (existing — exports rule-eval helpers in Phase 6)
    stratify.ts                      (existing — unchanged)
    unify.ts                         (existing — unchanged)
    aggregate.ts                     (existing — unchanged)
    incremental-evaluate.ts          (NEW — Phase 5 utilities + Phase 6 evaluator)
  solver/
    lww.ts                           (existing — unchanged)
    fugue.ts                         (existing — unchanged)
    incremental-lww.ts               (NEW — Phase 2)
    incremental-fugue.ts             (NEW — Phase 3)
  kernel/
    resolve.ts                       (existing — gains fuguePairKey, allPairsFromOrdered,
                                      parseLWWFact, parseSeqStructureFact in Phase 1–3)
    rule-detection.ts                (NEW — Phase 1)
    native-resolution.ts             (NEW — Phase 1)
    pipeline.ts                      (existing — modified in Phase 1 only)
    incremental/
      evaluation.ts                  (NEW — Phase 4, updated Phase 7)
      pipeline.ts                    (existing — modified in Phase 4)
      types.ts                       (existing — unchanged)
      ...                            (other incremental stages — unchanged)

tests/
  datalog/
    incremental-evaluate.test.ts     (NEW — Phase 5 + 6)
  solver/
    incremental-lww.test.ts          (NEW — Phase 2)
    incremental-fugue.test.ts        (NEW — Phase 3)
  kernel/
    incremental/
      evaluation.test.ts             (NEW — Phase 4)
      pipeline.test.ts               (existing — gains new tests in Phase 4, 7)
```

## Resources for Implementation

### Primary Theory

- `theory/incremental.md` §9 — all subsections (incremental Datalog in detail)
- `theory/incremental.md` §4 — stage interface and pipeline composition
- `theory/incremental.md` §5.6–5.7 — Datalog evaluation and resolution extraction
- DBSP paper (Budiu & McSherry, 2023) §4–5 — nested streams for recursive queries

### Existing Code (to read, not modify unless specified)

- `datalog/evaluate.ts` — batch evaluator (reuse rule-eval internals)
- `datalog/types.ts` — `Relation`, `Database`, `factKey`, `serializeValue`
- `datalog/stratify.ts` — stratification (reuse for incremental evaluator)
- `datalog/unify.ts` — term matching (reuse for rule evaluation)
- `kernel/incremental/pipeline.ts` — composition root (modify in Phase 4)
- `kernel/incremental/projection.ts` — reference for stage patterns
- `kernel/resolve.ts` — `ResolvedWinner`, `FugueBeforePair`, `ResolutionResult`,
  `fuguePairKey`, `allPairsFromOrdered`, `parseLWWFact`, `parseSeqStructureFact`
- `kernel/projection.ts` — `ACTIVE_VALUE`, `ACTIVE_STRUCTURE_SEQ`, `CONSTRAINT_PEER`
- `solver/lww.ts` — `lwwCompare`, `LWWEntry` (reuse for incremental LWW)
- `solver/fugue.ts` — `buildFugueNodes`, `orderFugueNodes` (reuse for incremental Fugue)
- `bootstrap.ts` — `buildDefaultLWWRules`, `buildDefaultFugueRules` (rule definitions)

### Test Helpers (to reuse)

- `tests/kernel/incremental/pipeline.test.ts` — existing differential test patterns
- `tests/solver/lww-equivalence.test.ts` — native ≡ Datalog equivalence pattern
- `tests/solver/fugue-equivalence.test.ts` — same

### Key Constants

- `ACTIVE_VALUE.predicate` = `'active_value'`
- `ACTIVE_STRUCTURE_SEQ.predicate` = `'active_structure_seq'`
- `CONSTRAINT_PEER.predicate` = `'constraint_peer'`
- Fact column positions defined in `kernel/projection.ts`

## Alternatives Considered

### Incremental Datalog First, Native Fast Path Later

The theory (§11.2) recommends building the incremental Datalog evaluator first.
We invert this order because:
1. Native incremental solvers are simpler and cover the common case (>99% of
   insertions use default rules).
2. They serve as a correctness oracle for the incremental Datalog evaluator.
3. They deliver end-to-end O(|Δ|) performance immediately, without waiting for
   the more complex Datalog work.
4. The evaluation stage wrapper (Phase 4) encapsulates the strategy choice, so
   the pipeline doesn't care which path is active.

### Provenance Semiring Instead of DRed

DBSP's theory uses Z-set multiplicities (the provenance semiring of Green et
al., 2007) where a derived fact's weight is the product of its input weights.
This elegantly handles retraction via weight arithmetic without explicit
dependency tracking. However:
1. Weight products can grow large for rules with many joins (our Fugue transitive
   closure would produce factorial weights).
2. The `distinct` operator is needed after every recursive step to clamp weights,
   which is not free.
3. DRed (delete and rederive) is operationally simpler for our specific rule
   patterns and avoids the weight-explosion problem.

We use DRed for negation strata and simple delta propagation for monotone strata.
This is equivalent to the Z-set semiring approach for our rule patterns but
avoids the implementation complexity of true provenance tracking.

### Separate `WeightedRelation` Type Instead of `ZSet<Fact>`

We initially planned a dedicated `WeightedRelation` type:
`Map<string, { tuple: FactTuple, weight: number }>` keyed by `serializeTuple`.
This was rejected because it significantly overlaps with `ZSet<Fact>`, which is
already `ReadonlyMap<string, { element: Fact, weight: number }>` keyed by
`factKey`. Both are weighted sets of facts. The only differences were
per-predicate scoping (solved by `Map<string, ZSet<Fact>>`) and storing
`FactTuple` vs `Fact` (a trivial wrapping difference). Unifying on `ZSet<Fact>`:
- Eliminates ~100 LOC of duplicate algebra (`wrAdd`/`wrNegate` = `zsetAdd`/`zsetNegate`)
- Removes conversion functions (`wrToZSet`, `wrFromZSet`)
- Avoids exporting the private `serializeTuple` function
- Makes the entire pipeline speak one type language: Z-sets from projection
  through evaluation to skeleton

The `CachedRelation` wrapper (lazy tuple-array cache for semi-naive performance)
is an internal implementation detail of the incremental evaluator, not a public
type.

### Modify `Relation` Class Instead of New Type

The existing `Relation` could be extended with an optional weight field. Rejected
because:
1. The batch evaluator depends on `Relation`'s set semantics (boolean add/has).
   Adding weights would change the contract for all consumers.
2. `ZSet<Fact>` has fundamentally different algebra (pointwise addition with
   cancellation) vs `Relation` (set union with deduplication).
3. Keeping both representations makes the distinction explicit — batch code uses
   `Database`/`Relation`, incremental code uses `ZSet<Fact>`. No confusion.

### Skip Incremental Datalog, Only Implement Native Fast Path

This would cover the default-rules case but not custom rules (Layer 2+), user
queries (Layer 3+), or cross-container constraints. These are the architectural
reason Datalog exists — they are what makes CCS a programmable reality engine
rather than a CRDT library. An incremental pipeline that only handles native
fast paths incrementalizes the system as it exists today; an incremental pipeline
that handles Datalog incrementalizes the system as it is designed to become.
The native fast path is built first for pragmatic reasons, but the incremental
Datalog evaluator is essential infrastructure.

## Learnings

### Canonical Key/Parse/Pair Functions Prevent Duplication Cascade

The `FugueBeforePair` key function (`${p.parentKey}|${p.a}|${p.b}`) was an
inline closure in `diffResolution`. The "ordered nodes → all-pairs" nested loop
existed in two identical copies of `buildNativeFuguePairs`. The fact-tuple-to-
typed-entry parsing (e.g., `active_value` tuple → `LWWEntry`) was done
differently by the batch Datalog path (`extractWinners` reads from `Database`)
vs the native path (receives `ValueConstraint[]` directly, bypassing facts).

Without extraction, each of these patterns would be reimplemented a third or
fourth time across incremental LWW, incremental Fugue, and incremental Datalog
resolution extraction. The fix is to place canonical functions in
`kernel/resolve.ts` — the existing Datalog↔kernel bridge module — where both
batch and incremental code can import them. This follows the Plan 005 learning
about `factKey`: "private functions in existing modules are often exactly what
you need."

### `ResolutionResult` Shifts from Inter-Stage Type to Materialization Convenience

Before Plan 006, `ResolutionResult` was the data flow type between evaluation and
skeleton — the batch evaluator produced one, `diffResolution` consumed it. After
Plan 006, the inter-stage types are `ZSet<ResolvedWinner>` and
`ZSet<FugueBeforePair>` — the evaluation stage produces them directly, the
skeleton already consumes them. `ResolutionResult` persists for three purposes:
(1) the evaluation stage's `current()` method (materializes for differential
testing), (2) `PipelineResult.resolutionResult` in the batch pipeline, (3)
strategy switching (diff old vs new accumulated resolution). The `fromDatalog`
field becomes less meaningful when the evaluation stage switches strategies
transparently. This is not actionable yet, but worth noting when Plan 008
(Query & Introspection) designs the introspection API over resolution state.

### The Resolution Strategy Decision Tree Is a Pure Function Worth Extracting

The `if (!enableDatalog) → native; else if (rules.length === 0) → native; else if
(isDefaultRulesOnly) → native; else → datalog` decision chain appears identically
in `solveFull` (batch) and `processConstraint` (incremental). The evaluation
stage (Phase 4) needs the same logic. Extracting it as
`selectResolutionStrategy()` eliminates triple-maintenance and makes the strategy
choice independently testable — a direct application of the functional core /
imperative shell principle.


### The Actual Stratification Is Simpler Than the Theory Suggests

Running `stratify(buildDefaultRules())` produces **two strata**, not the five
suggested by reading the rules individually. The stratifier collapses all
purely-positive predicates (`active_value`, `superseded`, `active_structure_seq`,
`constraint_peer`, `fugue_child`, `fugue_descendant`) into stratum 0, and both
negation predicates (`winner`, `fugue_before`) into stratum 1. This means the
affected-stratum computation is trivial (any ground-fact change → stratum 0 →
stratum 1), and the incremental evaluator needs only handle two strata for
default rules.

**Lesson**: Always verify the stratifier's output empirically rather than
hand-computing strata from rule structure. Tarjan's SCC algorithm + stratum
assignment produces a more collapsed layout than manual analysis suggests.

### `ZSet<Fact>` Is the Right Unification Point for Stream Processor and Datalog

The projection stage already emits `ZSet<Fact>` keyed by `factKey`. The initial
plan proposed a separate `WeightedRelation` type for the Datalog evaluator's
internal state, with conversion functions in both directions. This is the wrong
boundary. The evaluator's accumulated state should be `Map<string, ZSet<Fact>>`
— one Z-set per predicate — reusing all existing Z-set algebra. The only
Datalog-specific addition is a `CachedRelation` wrapper that lazily materializes
a `FactTuple[]` array for the semi-naive inner loop. This is an internal
performance optimization, not a type-level concern.

**Lesson**: When two components exchange a type (projection → evaluation), and
one proposes a different internal type with bidirectional conversion, question
whether the internal type is justified. Conversion functions between isomorphic
types are a code smell.

### Semi-Naive Read/Write Separation Dictates the Caching Strategy

Within one semi-naive pass, the accumulated database (`fullDb`) is read-only —
queried many times via `tuples()`, never written. The delta (`currentDelta`) is
also read-only. Only `nextDelta` is written to, and it's never read via
`tuples()` in the same iteration. This clean separation means lazy caching (build
the tuples array on first access, invalidate on mutation) is optimal: the cache
is built once per Z-set version and hit N times during iteration. Maintaining a
parallel array on every `zsetAdd` would do unnecessary work — `nextDelta` gets
many additions but its tuples are never read until the next iteration.

**Lesson**: The caching strategy for a data structure depends on the access
pattern, not the data structure's API surface. Analyze the actual read/write
interleaving before choosing between lazy invalidation and eager maintenance.

## Changeset

- **New files:** `kernel/rule-detection.ts`, `kernel/native-resolution.ts`,
  `solver/incremental-lww.ts`, `solver/incremental-fugue.ts`,
  `datalog/incremental-evaluate.ts`,
  `kernel/incremental/evaluation.ts`
- **New test files:** `tests/solver/incremental-lww.test.ts`,
  `tests/solver/incremental-fugue.test.ts`,
  `tests/datalog/incremental-evaluate.test.ts`,
  `tests/kernel/incremental/evaluation.test.ts`
- **Modified files:** `kernel/pipeline.ts` (import from shared modules),
  `kernel/incremental/pipeline.ts` (rewired composition root),
  `kernel/resolve.ts` (gains canonical utility functions),
  `datalog/evaluate.ts` (export rule-eval helpers),
  `src/index.ts` (new exports), `TECHNICAL.md`, `LEARNINGS.md`,
  `theory/incremental.md` (§9.5 correction),
  `.plans/004-incremental-roadmap.md`
- **No files deleted.**
