# Learnings: @kyneta/datalog

Discoveries from building and optimising the evaluator. Entries about the CCS engine
that runs on it live in `packages/perspective/LEARNINGS.md`.

## The split

### Groundwork with no reader is cost without a check on its correctness

`extractPartitionKey` and `Stratum.partitionKey` — about 350 lines of variable-
reachability analysis — ran on every `stratify()` call, which means on every
`createEvaluator` and every `changeRules`, for the entire life of Plan 007's Phase 1.
Nothing in `src/` ever read the result. The phases that would have read it (007's
Phases 2–3, partitioned evaluation) were never started.

So the package paid for the analysis on every rule change and got nothing, and — worse —
the only thing exercising it was its own unit tests. Code with no consumer has no
feedback loop: it cannot be wrong in a way anything notices, right up until someone
builds on it.

It was deleted at the split, and 007 will rebuild it from `theory/partitioned-settling.md`
alongside its first reader. **Land groundwork with the thing that reads it.**

## Weighted evaluation (Plans 006.1 and 006.2)

### Four Semi-Naive Loops, Not Three — Duplication Compounds Silently

The Plan 006.1 problem statement initially claimed "three places" of duplicated stratum-level logic. A thorough code audit revealed **four**: `evaluatePositiveStratum` and `evaluateStratumWithNegation` in `evaluate.ts` (batch), `evaluateMonotoneStratumIncremental` and `evaluateStratumDRed` in `incremental-evaluate.ts` (incremental), plus `fullRecompute` inside the `createIncrementalDatalogEvaluator` closure (rule-change recovery — itself a near-copy of the batch path). The fourth copy was hidden inside a closure, making it easy to miss during manual inventory.

**Lesson**: When counting duplicated code for a refactor plan, grep for the *algorithm pattern* (e.g., the semi-naive while loop with `evaluateRuleSemiNaive` + `getPositiveAtomIndices`), not just the function names. Closures and inline helpers hide copies that a name-based search misses.

### `Database`/`Relation` Public API Is Asymmetric — Positive-Only by Default

`Relation.tuples()`, `weightedTuples()`, `has()`, and `size` all filter to weight > 0 entries. This is correct for accumulated databases where negative weights are transient (pruned by `distinct`). But when using `Database` as a **delta container** — where −1 entries represent retractions — these methods silently drop half the data.

The fix: add `Relation.allWeightedTuples()` (returns all entries regardless of weight sign) and `Relation.allEntryCount` (counts all stored entries). Delta databases use these methods; accumulated databases continue using the weight > 0 filtered methods. The asymmetry is intentional — it's two different usage patterns for the same type — but it must be documented, because the default API does the wrong thing for deltas.

**Lesson**: When repurposing a data structure for a second role (accumulated state → delta container), audit every public method for implicit assumptions about the first role. Methods that filter silently are more dangerous than methods that throw — at least a throw tells you something is wrong.

### `Database.clone()` Was Silently Flattening Weights

`Database.clone()` iterated `tuples()` (weight > 0 only) and called `add(tuple)` (weight = 1). A database with weight-3 entries would clone to weight-1. In practice, all converged databases have weight-1 entries post-`distinct`, so no test caught this. But any future use of `clone()` mid-evaluation (before `distinct` clamping) would silently corrupt state.

The fix: delegate to `Relation.clone()` per predicate, which copies the internal `Map` directly (preserving all weights including ≤ 0 entries). One-line change, zero behavioral impact on existing code, removes a latent footgun.

**Lesson**: "No test catches it" doesn't mean "it's fine." If a method's contract is "deep copy" but its implementation is "deep copy with silent data loss under conditions that don't currently occur," fix it now. The conditions will occur when you extend the system.

### The `_inputDelta` Bug Was Real and Exactly as Described

`evaluateMonotoneStratumIncremental` accepted an `_inputDelta` parameter but never used it. The initial pass evaluated all rules against the full `db` (both arguments to `evaluateRule` were `db`), making monotone stratum evaluation O(|DB|²) instead of O(|Δ|×|DB|). The underscore prefix was the code telling you it was unused — the evaluator fell back to full re-evaluation every step for monotone strata even when only a small delta arrived.

The unified evaluator fixes this: `evaluatePositiveStratum` seeds semi-naive from `inputDelta` via `evaluateRuleSemiNaive`, matching each rule's positive atoms against the delta while other atoms match against the full db. Batch mode passes all ground facts as the input delta; incremental mode passes only the changed facts.

**Lesson**: When a function parameter has an underscore prefix (`_inputDelta`), treat it as a bug report, not a style choice. Someone intended to use it, couldn't make it work, and left the parameter in place. The fix is often straightforward once the surrounding infrastructure supports it.

### The Dirty Map Is Dual-Purpose Infrastructure — `distinct` + Delta Extraction

The Plan 006.1 architecture identifies a single `Map<string, { fact, preWeight }>` that serves two roles:

1. **Scoped `distinct`**: After each semi-naive iteration, clamp only dirty entries (weight > 1 → 1, weight < 0 → 0). O(|modified|) per iteration instead of O(|relation|).
2. **Delta extraction**: After convergence, compare each entry's `preWeight` to the current weight. Zero-crossings (≤0 → >0 or >0 → ≤0) become the output delta.

The key invariant: `preWeight` is captured on *first touch* and never overwritten. It represents the state before the current stratum evaluation began. Multiple mutations to the same fact during convergence are fine — the dirty map remembers only the starting point, and delta extraction only cares about the net effect.

This eliminates both snapshot-and-diff (no pre-step clone of derived predicates) and per-fact provenance tracking (no derivation DAGs). The dirty map is O(|touched facts|) in memory and O(|touched facts|) in extraction time.

**Lesson**: When you need both "what changed" (for delta output) and "what needs clamping" (for convergence), a single first-touch map serves both purposes. The first-touch-never-overwrite invariant is what makes it work — it decouples the tracking from the number of intermediate mutations.

### `distinct` Destroys Multiplicity — The Three-Value LWW Bug

Plan 006.1's single-weight `Relation` clamped weights to 0/1 via `applyDistinct`. This destroys Z-set multiplicity: a fact derived by two paths has weight 1 after clamping. Retracting one path drops weight to 0 — an incorrect retraction, since alternative support still exists (e.g., `superseded(alice)` derived by both bob and charlie; retracting charlie should not retract `superseded(alice)` because bob still supersedes her).

The fix is dual weights: `weight` stores true Z-set multiplicity, `clampedWeight` stores the post-distinct presence signal. `applyDistinct` becomes negative-floor-only (`max(0, w)`), not 0/1 clamping. This was caught by mathematical review before any code was written — it would have been caught by the three-value LWW test, but only after implementation.

**Lesson**: When extending a data structure with dual-role semantics (accumulated state AND delta container), the invariants of the two roles can conflict. Weight clamping was correct for set-oriented presence but destructive for Z-set multiplicity. The fix isn't choosing one — it's storing both.

### Semi-Naive Self-Join Double-Counting Requires Asymmetric Join

Standard semi-naive iterates delta positions for self-joins: `superseded(A,S) :- active_value(A,...), active_value(B,...), ...`. With delta `{alice, bob}`, both `deltaIdx=0` and `deltaIdx=1` produce `superseded(alice)` — weight 2 for a single genuine derivation. On retraction, only one path reverses, leaving weight 1 — the fact incorrectly survives.

The fix is DBSP's asymmetric join: `ΔA ⋈ B_new + A_old ⋈ ΔB` where `A_old = A_new − ΔA`. Positions before `deltaIdx` use P_new; positions after use P_old. Each derivation path counted exactly once.

A first attempt to use "deferred delta" (don't apply inputDelta to `db` before evaluation, pass P_old and P_new separately) was architecturally cleaner but incompatible with `step()`'s multi-stratum model — the first stratum's inputDelta application would be double-applied by the second stratum. The working approach: `step()` applies ground facts to `db` (= P_new), then `evaluateStratumFromDelta` constructs P_old = P_new − inputDelta. This is O(|delta|) via `constructDbOld()`, not O(|DB|) for cloning.

**Lesson**: DBSP's `distinct` operator is `max(0, w)` (negative floor), NOT `clamp(0, 1, w)`. The 0/1 clamping masks semi-naive double-counting. To use true Z-set multiplicities, the semi-naive evaluation itself must be correct — which requires the asymmetric join formulation. These two fixes (dual-weight + asymmetric join) are co-dependent.

### The Body Element Knows Its Kind — Don't Pass What You Can Read

`evaluateRuleDelta` handles both positive atoms and negation atoms as delta sources without a `deltaKind` parameter. The body element at `deltaIdx` already carries `kind: 'atom' | 'negation'`, so the switch branch dispatches to `evaluatePositiveAtom` or `evaluateDifferentialNegation` by reading the element. One function, one loop, zero parallel code paths.

**Lesson**: When generalizing a function to handle a new case, check if the dispatch information is already in the data. Adding a parameter for information that's already present in the input creates a synchronization obligation that adds no value.

### Dirty Map Should Track Only Derived Facts, Not Input Facts

During implementation, `evaluateStratumFromDelta` initially recorded inputDelta entries in the dirty map (to track pre-delta weights for `extractDelta`). This caused input facts to appear in the output delta — e.g., `base(b): +1` would show up alongside `derived(b): +1`. The stratum's output delta should contain only changes to facts that this stratum *derives*, not changes to its *inputs*.

The fix: don't record inputDelta in the dirty map. Only facts touched by `applyDerivedFact` (i.e., facts this stratum computes) enter the dirty map. Input facts are the responsibility of the caller (`step()`), not the stratum evaluator.

**Lesson**: In a layered pipeline, each stage should report only the changes it *causes*, not echo back changes it *receives*. The dirty map's scope should match the stratum's derivation scope.

### `constructDbOld` vs Deferred Delta — Architecture Meets Multi-Stratum Reality

The plan's original architecture called for `step()` to NOT apply ground facts before stratum evaluation, passing `db` as P_old. This is elegant for a single stratum but breaks for multi-stratum evaluation: each stratum's `evaluateStratumFromDelta` would apply the inputDelta to `db`, but the cumulative inputDelta for stratum 1 includes both ground facts AND stratum 0's output. Ground facts would be double-applied.

The working design inverts the approach: `step()` applies ground facts to `db` (= P_new), and `evaluateStratumFromDelta` subtracts the inputDelta to get P_old. This works cleanly for multi-stratum because each stratum only subtracts its own inputDelta from the already-updated `db`.

**Lesson**: Theoretical designs that work for the single-operator case often break when composed in a pipeline. Test the multi-stratum case early — it's where the abstractions meet reality.

## Datalog evaluator performance

### Four Super-Linear Costs Hid Behind Each Other

The Grame team evaluated this package as a runtime for a generative roguelike and reported one blocking problem: a 100×30 spatial grid took 20 s to flood, with 32× the facts costing ~1,200× the time. They diagnosed it precisely — an unindexed nested-loop join in `evaluatePositiveAtom`.

That diagnosis was correct and incomplete. There were four independent super-linear costs, and fixing only the reported one would have left the benchmark at ~1.3 s rather than 70 ms:

1. **Unpruned delta sources** — the semi-naive loop drove *every* positive body atom as a delta source, including atoms with no facts in the delta. 95% of all unification work, removed by three lines.
2. **Unindexed joins** — the reported cause.
3. **Quadratic Z-set construction** — `zsetAdd(acc, zsetSingleton(...))` folded in a loop. `zsetAdd` copies its larger operand, so building an n-element Z-set was O(n²). Ten call sites.
4. **Fixed left-to-right body order** — a rule whose first atom is unbound scans that whole relation before the delta can narrow it.

**The lesson is about sequencing, not about joins.** Costs 1 and 2 account for 99.995% of the *work*, but until cost 3 was also removed the *clock* barely moved (5,550 ms → 1,275 ms). Any one fix in isolation looks like a disappointment, and it would have been easy to conclude the whole direction was wrong. Static reading found cost 2. Counting unifications found cost 1. Only a profiler run *after each individual fix* found costs 3 and 4 — each of which was invisible while the others dominated.

The practical rule: when a system has multiple super-linear costs, they mask each other. Re-profile after every fix, and do not judge a fix by the clock until the others are gone.

### "The Evaluator Did O(|db|) Work Per Iteration" Has Been the Answer Three Times

Plan 007 replaced an eager `constructDbOld` — a full `db.clone()` per semi-naive iteration — with the lazy `DatabaseView`. Plan 006.1 replaced snapshot-and-diff delta extraction with the dirty map, for the same reason. The join-index work found two more instances: scanning a whole relation per substitution, and `applyDistinct` walking the entire accumulated dirty map per iteration.

Four occurrences of one shape. In a semi-naive loop, *anything* proportional to the database rather than the delta is a bug waiting to be measured, because the loop runs once per iteration and iterations scale with the data. It is worth grepping for the shape directly — a full-collection scan inside the fixpoint — rather than waiting for it to show up in a profile.

(One instance of the shape turned out not to matter: restricting `applyDistinct` to the facts touched in the current iteration is provably equivalent and measured 1,275 ms → 1,268 ms, i.e. nothing, because Z-set construction dominated it. Recorded so the next reader does not re-derive it.)

### Separating Plan from Execution Made the Risky Change Testable

Rule evaluation used to interleave four decisions with the work: source database, delta source, known positions, and order. Lifting them into a pure `planRuleEvaluation` was motivated by wanting the *last* one — join order — to be reviewable, because reordering is the only change in this whole effort that alters the order facts are derived in.

The payoff was concrete rather than aesthetic. Join order became a golden test over relation sizes with no `Database` in sight, which is how the batch-versus-tick conflict got caught: a fixed "delta source first" rule fixes the per-tick case (0.99 ms → 0.030 ms) and *regresses* batch (61 ms → 73 ms), because during a batch seed the "delta" is the entire ground fact set. Neither fixed order wins; a greedy smallest-first rule gets both. That is not something the benchmark would have shown, since it only exercised one of the two shapes.

### The Fifth Cost Was Building Strings, and It Had Always Been There

After the four super-linear costs above were gone, a downstream profile of a 100×30 world said almost none of a tick was logic. A CPU profile of a batch `evaluate` agreed: about two thirds of self time was in `serializeTuple`'s array-and-join and in `serializeValue`, with rule logic under 5%. None of it was new. The serializer had been the same since the first commit; the earlier fixes removed enough algorithmic work to leave it standing alone at the top.

Three habits made it expensive, and none was an algorithm. The serializer allocated an array per tuple. The batch wrappers filled a whole `Database` they then discarded. And the same fact was re-keyed at every hand-off — a ground fact five times per `step`, a derived fact about six times between `groundHead` and the output delta — because each function took a `Fact` and recomputed the key it needed. The fix is a discipline: compute the key where the fact is created and carry it (`factsToZSet`, `WeightedFact.tupleKey`, `Relation.addWeightedByKey`). The flood went from 67 ms to 29 ms.

Two things worth keeping. First, a discipline is easier to erode than an algorithm: any new hand-off that calls `factKey` or `serializeTuple` on a fact the evaluator already holds silently puts the cost back, which is why `evaluator.ts` now says so at the top. Second, the serializer's output format turned out to be a contract with downstream code that sorts and snapshots by it, and nothing had said so; the rewrite is pinned byte-for-byte to the original by test.

### A Write-Only Map Survived Three Plans

`accumulatedGroundFacts` was a map of every ground fact, keyed by `factKey`, updated on every `step`, and read by nothing. It was introduced for the rule-change replay in Plan 006, made redundant when that path started re-reading ground facts from the database itself, and then carried through Plans 006.1, 006.2 and 007 — each of which edited the function it lived in. It cost a serialization and a map insert per ground fact per step, plus a second reference to every ground fact for the life of the evaluator.

It survived because nothing measured it and nothing failed. A write-only field produces no wrong answers, so tests cannot see it; the profile attributed its cost to `factKey` and `Map.set`, which had plenty of legitimate callers. The check that would have caught it is mechanical and cheap: for each piece of mutable state in a closure, find one reader. It is worth doing whenever a plan touches a long-lived function, before profiling.

### Negation Is a Factor, and the Delta Decomposition Does Not Care What It Means

The incremental evaluator pinned negated atoms to P_new, with a comment that read as obviously right: negation-as-failure asks whether a fact is absent *now*, not whether it was absent before the delta. That sentence is true about the semantics of negation and irrelevant to the incremental decomposition, which is the trap.

What the decomposition needs is a telescoping sum over factors, and a negated atom is a factor: the derived set is the join times an indicator. Pinning one factor to a fixed side drops a cross term. The visible symptom needed two changes in one step to appear — retract a fact that supports a derivation, and insert one that makes that derivation's negation newly fail. Driving from the retraction evaluated the negation against the new state and discarded the substitution; driving from the negation evaluated the positive atoms against the new state and never saw the old position. Each drive threw away exactly the evidence the other needed, and the derived fact was stranded. Applying the same move as two steps was exact, which is a good tell for a missing cross term.

The lesson generalizes past this bug: when a rule element is given a special case in an algebraic decomposition, the justification has to be algebraic. "Negation means X" is a statement about semantics; the decomposition only knows about factors.

### A Delta Says "Appeared", the Database Says "Twice"

The same investigation turned up a second defect underneath the first. Stratum output deltas are normalized to ±1 presence flips — that is deliberate, it is what makes `distinct` and the fixpoint terminate. The accumulated database, meanwhile, stores true Z-set multiplicity. `DatabaseView` reconstructed P_old by subtracting one from the other.

Those two encodings agree only while every derived fact has exactly one derivation path. `blocked(1,1)` derived both from a wall and from a solid entity standing on the tile has weight 2, and the stratum reports +1. Subtracting leaves 1, so P_old claims the fact was already present before the step, and every retraction gated on it is silently lost. Rebuilding P_old by undoing the presence flip fixes it, and is well-defined because everything reading P_old reads presence: `weightedTuples` clamps to 1, and negation only asks whether a fact is there.

Worth noticing: the old behavior could produce a P_old entry with weight −1, describing a fact that had been present negative-one times before the step. Two tests asserted that value. An impossible number sitting in a test is a good place to look when something nearby is wrong.

The same mismatch was sitting at the other end of the pipeline, and writing up the theory afterwards is what found it. `step` fed strata a ground fact's raw Z-set weight, while every read of a relation was clamped to presence. A fact inserted at weight 2 derived at count 2; retracting its join partner took back 1; batch said the derived fact was gone. The rule is the same at both boundaries, and it is worth stating as a rule because code that looked locally right violated it twice: a stratum sees presence flips, and nothing else.

Then a third. Every path that derives a stratum again from scratch (aggregation, the retraction-into-recursion recompute, a rule change) wiped a head predicate to zero, and a predicate can be both inserted and derived, so `lit(0, 0)`, the seed of the fire, went with the flood it seeded. The three defects are one shape. The database stores a sum: ground plus derived, multiplicity across derivation paths, a reference count across repeated inserts. Every reader that needed one part of a sum was reading the whole and hoping. Where a part is needed, keep the part: `groundInDerived`, `presenceBefore`, and the presence flip at the ground boundary are the three places that now do.

### Randomized Differential Testing Found What Targeted Tests Could Not

Both defects above had existed through Plans 006, 006.1, 006.2 and 007, under a suite of 1,436 tests including a three-way oracle. They survived because every negation test changed one thing at a time. The bug needs two changes in one step, and the second bug additionally needs a derived fact with two derivation paths.

Forty seeded histories of "move an entity, sometimes toggle a wall, compare against batch after every step" found both within minutes, and then found the cyclic-support limitation as well. The cost was about sixty lines. For an incremental engine whose whole contract is "equals the batch result", the oracle is free and the inputs are the only thing worth designing — the shapes to reach for are concurrent change, multiple derivation paths, and cycles.

### A Stage's Return Type Leaked Into a General Engine

`createEvaluator` was written in Plan 006.1 as the kernel's incremental evaluation stage, and it kept the stage's output: winner and Fugue-pair deltas came out of `step` next to the derived facts, `currentResolution` re-implemented `extractResolution`, and the datalog layer imported kernel types to do it. Nobody noticed for four plans because the stage was the only caller. The first outside consumer, a game engine with no constraints at all, could not use the evaluator without receiving winners it had never asked for, and could not reach it from the root barrel either.

The theory doc had the boundary right the whole time: §5.6 is evaluation, emitting a delta of derived facts, and §5.7 is resolution extraction, a linear stage over that delta. The code had folded 5.7 into 5.6. Moving it back was mostly deletion, and it removed three copies of the winner column layout on the way.

The check worth adopting: before exporting an interface, compare it against the theory's stage boundaries, not against its one existing caller. A caller that is also the author will never ask for less than it gets.

### The Settle Loop Was a Second Stratifier, and the Hard Part Was Not the Code

A downstream engine computed its distance field outside the evaluator: derive, ask which inputs changed, measure, feed the result back as ephemeral facts, derive again, stop when a round measured nothing. Small, correct, and a re-implementation of stratification and change detection with string names and a memo the evaluator could not see. Moving it inside took about forty lines, because every part already existed: the stratifier orders a relation after its inputs, `computeAffectedStrata` knows which strata a change reaches, and the retraction recompute had already made wipe-to-ground, run, diff a single shared path. A foreign relation is that path with a function in place of a rule body.

What took the time was deciding what is data and what is code before writing the API. Rules travel in the store and any two implementations must agree on the reality; a host function cannot travel and can differ between peers. The spec had already faced this for native solvers and answered with an engine version pinned as data. Applying the same split, declaration as data and implementation as registered code joined by a name, meant the registration API was designed as engine configuration from the outset rather than discovered to be that later. The check worth keeping: when something new has to live outside the store, find the precedent for how the spec already keeps such things honest, and copy its shape.
