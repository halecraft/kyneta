# @kyneta/datalog — Technical Reference

> **Package**: `@kyneta/datalog`
> **Role**: A stratified, semi-naive, incremental Datalog evaluator. Rules and ground facts in, derived facts out — as a batch, or as deltas over a long-lived database.
> **Depends on**: `@kyneta/zset`
> **Depended on by**: `@kyneta/perspective`
> **Canonical symbols**: `Value`, `ValueRef`, `Term`, `Atom`, `Rule`, `BodyElement`, `Fact`, `FactTuple`, `Database`, `Relation`, `Probe`, `Evaluator`, `evaluate`, `evaluatePositive`, `createEvaluator`, `factsToZSet`, `stratify`, `Stratum`, `Host`, `ForeignRelation`, `HostFunction`, `hostErrors`, `declarationErrors`, `Result`
> **Key invariant(s)**: The evaluator knows nothing about its caller's domain. Its input is facts, its output is derived facts, and every extension point — foreign relations, host functions — is referenced from a rule **by name only**.

The engine that `@kyneta/perspective` runs its solver rules on, extracted so that it can be used on its own. Nothing here mentions a constraint, a peer or a reality; those are one consumer's vocabulary.

---

## Questions this document answers

- How do I run rules over facts, once or incrementally? → [Using the evaluator on its own](#using-the-evaluator-on-its-own)
- What can a `Value` be, and why is there a `ref` case? → [The value domain](#the-value-domain)
- Why was this slow, and what made it fast? → [Evaluator performance](#evaluator-performance)
- How does a rule reach code the host supplies? → [Host relations and functions](#host-relations-and-functions)
- What will bite me? → [Gotchas](#gotchas)

## What this is

Source: `src/`.

Standard Datalog — Horn clauses over ground facts, evaluated bottom-up to a
fixed point — plus stratified negation, bag aggregation, guards, and host-supplied
relations. Finite Herbrand universe, so evaluation always terminates.

## The value domain

Source: `src/types.ts` → `Value`, `ValueRef`, `serializeValue`, `compareValues`, `valuesEqual`.

```ts
interface ValueRef {
  readonly peer: string
  readonly counter: number
}

type Value =
  | null | boolean | number | bigint | string | Uint8Array
  | { readonly ref: ValueRef }
```

The union is **closed**. A caller cannot add a case, and that is the point: identity, ordering and equality over values are decided here, by code the compiler checks, rather than by something registered at runtime.

**`number` and `bigint` are distinct.** `3` and `3n` never unify and never compare equal. This is not fussiness — a 64-bit id stored as an IEEE 754 double silently loses bits above 2^53, and two peers that disagree about a value compute different answers from the same facts.

**`ValueRef` is an opaque composite identity.** The engine never destructures one: it serializes it, orders it, and compares it. It exists so that a caller can put an identity in a fact without that identity unifying with a bare string. The field names `peer` and `counter` are a deliberate contract with `@kyneta/perspective`, whose `CnId` has exactly that shape — so a `{ ref: CnId }` is a `Value` by structure, with no conversion and no import in either direction. That is the spec's `ref(CnId)` (`packages/perspective/theory/unified-engine.md` §3), the sole mechanism by which a CCS document nests, realised without either package depending on the other's types. `packages/perspective/tests/kernel/value-ref.test.ts` is what fails if a field is ever renamed.

**The key format is frozen.** `serializeValue` tags every case (`N`, `T`/`F`, `f:`, `i:`, `s:`, `b:`, `r:`) and gives strings an explicit length, which is what makes `serializeTuple`'s concatenation uniquely decodable. Downstream code sorts facts by these strings and snapshots them, so the output is pinned byte-for-byte by `tests/types.test.ts` against a reference implementation. Changing it reorders other people's output.

### Why the union is closed

An **open** value domain was designed and measured before this package shipped, and deliberately left out.

Making `valuesEqual` and `serializeValue` indirect at every call site — passing a codec, as a `Value<V>` parameterisation would — costs about **+3.5 %** per call with one codec in the process, **+10 %** with two distinct codec functions, and **+35–40 %** with five. The penalty tracks callee identity, not object shape: five codec instances sharing one hidden class but holding five different functions cost the same as five different shapes. In `@kyneta/perspective`'s LWW rule program, `valuesEqual` runs 48 million times over 8,000 facts and is roughly half the wall clock, so that is +1.9 % / +5 % / +20 % end to end there.

A **hybrid** — closed fast core, plus one final branch dispatching through a symbol protocol on the value itself — measures under 1 % when unused (+0.4–1.9 % on `valuesEqual`, within noise on `serializeValue`) and 1.7–2.5× per extension value when used. That is the right shape if a consumer ever needs non-scalar values: users of the feature pay for the feature. It is purely additive — one union member and one branch in three functions — so it costs exactly as much to add later as it would have cost to add now.

It is not here because its injectivity contract needs designing against a real requirement. An extension whose key collided with the `s:` prefix would silently conflate two facts in the join index, so the engine would have to wrap rather than trust (`x:${len}:${key}`). And for a CRDT consumer the value must also survive a wire format, which a method-bearing object does not. No consumer needs it yet. The fallthrough branch in each of the three handlers is where it goes.


## The evaluator in detail

### Rule structure

```
type Rule = {
  head: PositiveAtom
  body: Array<PositiveAtom | Negation | Aggregation | Comparison>
}
```

Constructors: `rule`, `atom`, `positiveAtom`, `negation`, `eq`, `neq`, `lt`, `gt`, `varTerm`, `constTerm`, `_` (wildcard).

### Evaluation phases

1. **Stratify** — partition rules into strata. Within a stratum, rules are purely positive. Negation only across strata (a negated atom in stratum N queries relations computed by strata < N).
2. **Seed** — populate the initial fact database from projected constraints.
3. **Semi-naïve fixed point** — for each stratum in order:
   - Compute new facts using only facts derived in the previous iteration.
   - Add new facts to the database.
   - Repeat until no new facts.
4. **Output** — the final database is the solve output.

### Aggregation

`count`, `min`, `max`, `sum`, `collect(x)`. Used sparingly in the default rule set — primarily for compaction policy and Fugue-position tie-breaking.

### The rule evaluation plan — the evaluator's functional core

Source: `src/evaluate.ts` → `planRuleEvaluation`.

Evaluating a rule body involves four decisions, and none of them needs to look at a tuple:

| Decision | Answer lives in |
|----------|-----------------|
| Which database does this element read? | `step.source` — `"delta"`, `"new"` (P_new) or `"old"` (P_old) |
| Which element does the delta drive? | `step.isDeltaSource` |
| Which of an atom's positions are already known? | `step.mask` — a bitmask over the tuple arity |
| In what order should elements be visited? | the plan's order |

All four follow from the rule's shape plus relation *sizes*, so they are lifted into a pure function: **GATHER** (sizes) → **PLAN** (`EvalStep[]`) → **EXECUTE** (a fold over the steps). `evaluateRuleDelta` and `evaluateRule` are both folds and contain no decisions; they differ only in which plan they ask for (`evaluateRule` passes `deltaIdx = -1`).

Two things this buys beyond tidiness. The mask is computed once per rule instead of rediscovered per substitution. And join order — the one decision that is a genuine judgement call, and the only one that changes the order facts are derived in — becomes directly testable without constructing a `Database` (`tests/plan.test.ts`).

**Negation participates in the asymmetric join.** A negated atom is a factor like any other — the derived set is the join times an indicator, and the same telescoping applies — so its `source` follows the same rule as a positive atom: before the delta source reads P_new, after it reads P_old. Pinning negation to P_new instead (on the reasoning that negation-as-failure asks about *now*) drops a cross term. When one step both retracts a fact and inserts one that makes a negation newly fail, each drive discards the other's evidence and the derivation is never retracted. That was a real defect, found downstream as a monster hunting from tiles it had already left; `tests/evaluator.test.ts` guards it with randomized differential sweeps.

**Precondition, now explicit.** A static mask is correct only if every substitution arriving at a step has the same set of bound variables. That holds because binding is structural: a positive atom binds all its variables or the substitution is discarded, negation and guards bind nothing, aggregation binds `groupBy` plus `result`. This was always true and never written down.

**Ordering is smallest-first, greedily.** An atom with no known position enumerates its whole relation; one with a known position is an indexed lookup. So the planner repeatedly takes whichever element is cheapest right now, since each choice binds variables that make the rest cheaper. Neither fixed order works: leading with the delta is right for a one-fact tick but wrong during a batch seed, where the "delta" is every ground fact. A body containing an `aggregation` keeps source order — aggregation is a group-by boundary that resets provenance weight and does not commute with joins.

### Using the evaluator on its own

Source: `src/evaluator.ts` → `createEvaluator`, `factsToZSet`; both exported from the barrel.

The evaluator is a Datalog engine with no knowledge of constraints. `evaluate(rules, facts)` runs a batch. `createEvaluator(rules)` holds a database across calls:

```ts
interface Evaluator {
  step(delta: ZSet<Fact>): ZSet<Fact>         // ground facts in, derived facts out
  changeRules(delta: ZSet<Rule>): ZSet<Fact>  // every stratum derived again
  currentDatabase(): Database                 // live, not a snapshot
}
```

The tick shape: build the delta as new minus old (`factsToZSet(retracted, -1)` added to `factsToZSet(inserted)`), so facts that did not change cancel and never reach the evaluator; call `step`; read either the returned delta or `currentDatabase()`. A rule change is `changeRules`, a separate method because it costs a full recompute and returns a full diff, which an optional parameter on `step` would hide. Winners and Fugue ordering are the kernel's reading of the derived delta (`winnerDeltas`, `fuguePairDeltas`, `extractResolution` in `@kyneta/perspective`'s `kernel/resolve.ts`) and are not part of this interface.

### Host relations and functions

Source: `src/host.ts`; the stratifier and `evaluator.ts` for placement and running.

Some relations cannot be written as rules: a breadth-first distance field, a keyed hash per tile. The host supplies them as code, and the evaluator treats them as one of two things.

**A foreign relation is a stratum whose body is a function.** It is declared with its name, the relations it reads, and a version, and registered with a `compute(read, changed)` that returns the whole relation for the current inputs. The stratifier gives it strict edges in both directions, to its inputs and from its readers, so it is alone in its stratum, fully computed before any reader runs and never inside a recursion. It runs at construction, on every step in which an input's presence changes, and on a rule change. It is incremental the way an aggregation stratum is, because an opaque operator has no algebraic delta: wipe the relation to its ground part, run the function, and one `extractDelta` over the dirty map is the presence diff, so only what changed propagates. `changed` names the inputs that flipped and is a hint for a memo inside the function, never something the output may depend on. The function reads through a view scoped to its declared inputs; anything else throws.

**A compute element is a guard that binds.** `compute("hash", [T, X, Y], V)` in a rule body applies the named function to bound arguments and unifies the value with `result`: an unbound variable is bound, a bound variable or constant is compared and the row kept on equality, a wildcard keeps the row. It is linear per row, preserves weight, reads no relation, is never a delta source, and so takes part in the incremental decomposition with no new theory. Rules with compute elements never recompute.

**The demand pattern needs nothing from the engine.** Hoist the body before a field atom into an ordinary rule, `origin(X, Y) :- player(P), at(P, X, Y)`, and declare `origin` as an input. A demand tuple that disappears takes its outputs with it through the diff.

**What the engine checks, and what it does not.** `hostErrors(rules, host)` runs before evaluation, on construction and on every rule change: a function the host lacks, a rule deriving a foreign predicate, or a compute argument nothing binds (computed to a fixed point, so computes may feed each other in any order) is a stratification error, and `createEvaluator` throws on it. `declarationErrors(declarations, host)` is the consumer's check when it links a pack that declared what it expects. Purity and determinism are the author's obligations, stated once in `host.ts`. In the CCS pipeline these are solve-time errors and deliberately not validity-time ones: validity is a Layer 0 algorithm every implementation must compute identically, and letting it consult the local host registry would make validity itself peer-dependent. A rule constraint naming an unregistered function is valid everywhere and fails to solve here, and the batch pipeline then degrades to native resolution as it does for any Datalog error.

```ts
createEvaluator(rules, { relations: [distField], functions: { hash } })
solve(store, { creator, host })          // the same registry, through PipelineConfig
```

`tests/fields.ts` is the worked example: a breadth-first `dist` over `adj` honouring `blocked`, reading adjacency through `Relation.candidates` with a probe rather than a scan. On a 100×30 world a player moving every tick, which flips `origin` and re-runs the field over about 3,000 tiles with a hunt rule reading it, measured about 8 ms p50 and 10 ms p95.

### Evaluator performance

The Datalog evaluator had **four independent super-linear costs**, found while the Grame team was evaluating this package as a game runtime. A 100×30 grid with materialized 4-neighbour adjacency (14,741 facts) took **32 s** to flood; it now takes **~70 ms**. Per-tick incremental cost — one ground fact in, one derived fact out, over an 18k-fact database — went from 0.83 ms to **0.016 ms**.

Unification counts for the full three-rule program on a 50×30 grid, after each fix cumulatively:

| Fix | Unifications | Wall clock |
|---|---|---|
| baseline | 379,327,971 | 5,550 ms |
| Prune empty delta sources | 20,006,843 | 1,515 ms |
| Join index | 19,335 | 1,275 ms |
| Linear Z-set construction | 19,335 | **44 ms** |
| Selectivity ordering | — | tick: 0.99 → 0.03 ms |

1. **Unpruned delta sources.** `evaluateStratumFromDelta` drove *every* positive body atom as a semi-naive delta source, including atoms whose predicate had no facts in the delta — a full cross-product scan per iteration that derived nothing. The negation path had always guarded this; the positive path had not.
2. **Unindexed joins.** See below.
3. **Quadratic Z-set construction.** Z-sets were built by folding `zsetAdd(acc, zsetSingleton(...))`. `zsetAdd` copies its larger operand, so building an n-element Z-set cost O(n²). This was 90% of the remaining runtime once the joins were fast — and completely invisible before that.
4. **Fixed left-to-right body order.** See the rule evaluation plan above.

**The sequencing is the lesson.** Fixes 1 and 2 account for 99.995% of the *work*, but until fix 3 also landed the *clock* barely moved. Any one of them alone looks like a disappointment. A profiler run after each change was worth more than the static reading that found the first one.

5. **String keys rebuilt at every hand-off.** Once the four fixes above had removed the algorithmic waste, a CPU profile of a batch `evaluate` over the 100×30 world was about two thirds string building: the native `join` inside `serializeTuple` (38% of self time), `serializeValue` (23%), and the wrappers around them (4%). Map operations were 12% and the actual rule logic under 5%. The serializer allocated an array per tuple, the batch wrappers filled a whole `Database` they then discarded, and the same fact was re-serialized at every hand-off: a ground fact five times per `step`, a derived fact about six times between `groundHead` and the output delta. A write-only map of every ground fact (`accumulatedGroundFacts`) had also survived three plans because nothing measured it and nothing failed.

   The fix is a discipline, not an algorithm: **a fact's key is computed once, where the fact is created, and travels with it.** Ground facts arrive keyed by `factKey` in the Z-set (`factsToZSet` is the blessed constructor); derived facts carry `WeightedFact.tupleKey` from `groundHead`; `Relation` exposes `addWeightedByKey` / `getWeightByKey` / `forEachEntry` for callers that hold the key; `Database.addAllWeighted` merges deltas without re-keying. The serializer itself lost its intermediate array and gained an int32 fast path, with its output pinned byte-for-byte to the original by test because downstream code sorts and snapshots by it.

   | Shape (vitest on Node, medians) | Before | After |
   |---|---|---|
   | Batch `evaluate`, 100×30 fire flood | 67 ms | 29 ms |
   | Batch `evaluate`, fire + spores + negation stratum | 74 ms | 31 ms |
   | Long-lived evaluator, initial load of the world | 15 ms | 7 ms |
   | 3,000 facts retracted + 3,000 inserted in one step | 4 ms | 2 ms |
   | One-fact step | 0.01 ms | 0.01 ms |

   Two key spaces now exist and their names keep them apart: a **tuple key** (`serializeTuple(values)`) identifies a tuple inside one relation and is what `Relation`, the dirty map and `WeightedFact.tupleKey` use; a **fact key** (`predicate|tupleKey`, built by `factKeyFromTupleKey`) identifies a fact across relations and is what Z-sets use. `tupleKeyFromFactKey` recovers one from the other by length, so a `|` in a predicate name is harmless.

6. **A delta-driven negation planned as binding nothing.** `bindVariables` recorded every negation as a pure filter. That is right for `evaluateNegation`, and wrong for `evaluateDifferentialNegation` — the form a negation takes when the delta drives it — which matches the negated atom against each delta tuple and carries the bindings forward exactly as a positive atom does. So every element planned after such a negation saw an empty binding set, took `mask = 0`, and scanned its relation once per substitution.

   `estimateCost` had priced this correctly all along ("a delta-driven negation must read the delta and can bind through it, so it is priced like an atom"); only the plan disagreed. Nothing failed, because a stale mask degrades to a full scan, which is correct at any cost.

   Last-writer-wins is where it showed: `winner(Slot, CnId, Value) :- active_value(...), not superseded(CnId, Slot)` cost |superseded| × |active_value| per round — 48M unifications at 8k values, and the reason this package's own documentation claimed pure-Datalog LWW was inherently quadratic. It is not.

   | Shape (medians, 4 writers per slot) | Before | After |
   |---|---|---|
   | `winner` alone, 8k values | 1,160 ms | **29 ms** |
   | Full LWW program, 8k values | 1,188 ms | **63 ms** |
   | Growth per 4× the facts | ×14.7 | **×4.0** |

   `tests/negation-scaling.test.ts` and the mask cases in `tests/plan.test.ts` hold this. Both assert ratios rather than wall-clock ceilings, so they mean the same thing on a loaded machine.

### The join index

Source: `src/types.ts` → `Relation.candidates`.

`Relation` is a `Map` keyed by the *whole* serialized tuple, so a partially-bound atom like `adj(X1, Y1, _, _)` had no way to find its matches except by walking every tuple. The index answers that question directly: for a set of known positions (a bitmask), it maps the values at those positions to the entries carrying them.

- **Lazy and self-maintaining.** Built on first use for a given mask, maintained on insert/delete after that. A relation nothing joins on never builds one. Below `MIN_INDEXED_SIZE` (16 entries) a scan is cheaper, so `candidates()` falls back to one — most kernel relations (LWW slots, Fugue siblings) never cross it.
- **Bounded in count.** Masks are structural, not data-dependent, so a relation accumulates only as many indexes as the rule set has distinct binding patterns for it. One or two, in practice.
- **Superset contract.** `candidates()` returns a superset of the true matches and the caller unifies each one exactly as before, so the index can only narrow the search — never change an answer. That is why correctness never depends on an index existing.
- **Order-preserving.** A bucket is built by scanning the map in order and appended to at the same moment the map is, so bucket order is always map order restricted to the bucket's members. Candidates arrive in exactly the relative order a full scan would produce, which is why indexing perturbs no array downstream of `tuples()`.
- **One equality notion.** Index keys come from `serializeTuple(tuple, mask)` — the same function that builds the relation's own tuple keys, `factKey`, and aggregation's group keys. The index introduces no new notion of equality, only a coarser one.

Every mutation of a relation's membership funnels through two private methods (`putEntry` / `dropEntry`), so index maintenance has exactly one insert point and one delete point. Adding a new `Relation` factory that writes the backing map directly would silently break the index; do not.

### Gotchas

- **`step` takes the Z-set key as the fact key.** A `ZSet<Fact>` passed to `Evaluator.step` should be keyed by `factKey` — the evaluator slices the tuple key out of it instead of re-serializing. Build inputs with `factsToZSet` (or `zsetSingleton(factKey(f), f, w)` for one fact). A key in any other shape is detected by a prefix check and serialized the slow way, so the result is still correct; the fast path is simply lost. The check is not optional politeness: without it a foreign key becomes a relation key, and two different facts can collapse into one entry.
- **`currentDatabase()` is the live database, not a snapshot.** The next `step` mutates it. Read what you need, or keep the returned delta, before stepping again; anything that holds two databases to compare them is comparing one object with itself.
- **A rule with an empty body fires on every seed of its stratum.** Its fact holds from construction, and its count goes up by one each time the stratum is touched. Presence is unaffected and a recompute resets the count. Pre-existing and harmless; noted so the number does not surprise anyone reading weights.
- **P_old is rebuilt from presence, not by subtracting weights.** A delta says a fact appeared or disappeared, always ±1, while the database stores true multiplicity. A fact with two derivation paths has weight 2 and still arrives as +1, so `base − delta` would leave 1 and claim it was there before the step. `Relation.presenceBefore` undoes the presence flip instead, and is what `DatabaseView` calls. Everything that reads P_old reads presence, so this is both sufficient and correct.
- **Ground relations are sets at the stratum boundary.** A ground fact's Z-set weight is a reference count, and strata are told only when it crosses zero: `step` feeds them the presence flip, never the raw weight. A fact inserted at weight 2 used to derive at count 2, and retracting its join partner could take back only 1.
- **A predicate can be both inserted and derived.** `lit(0, 0)` seeds the fire that derives the rest of `lit`, and the database holds the sum. `createEvaluator` keeps the ground part of every predicate rules have ever derived, so that a recompute, whether for aggregation, for retraction into recursion, or for a rule change, wipes only the derived part and the ground part seeds the replay. Before this, all three paths wiped the ground facts too.
- **A foreign relation cannot be a rule head, and may read only its inputs.** The first is a stratification error; the second throws from the scoped view with the predicate named, because an undeclared read would see a relation the stratifier never ordered before it and fail silently and late otherwise.
- **A foreign function's output must be total over its current inputs.** `changed` only says what a memo may keep. A function that returns different values for equal arguments, or a relation that depends on anything but its declared inputs, diverges peers silently and no test here can see it.
- **`Relation.size` is O(n), not `Map.size`.** It counts present tuples by iterating, because presence is derived from each entry's clamp rather than stored. Use `allEntryCount` when you want the O(1) count and do not care about presence — query planning does exactly that.
- **A `Value` placed in a relation is owned by the relation.** Mutating it afterwards corrupts tuple identity: `has` / `getWeight` / `remove` recompute the key from the mutated bytes and miss. Only `Uint8Array` values are mutable, so this is the only way to hit it. Pre-existing, but the join index makes the failure quieter — a stale bucket entry yields a wrong candidate set rather than a missed lookup.
- **Per-iteration `applyDistinct` was measured and does not help.** `applyDistinct` walks the *whole accumulated* dirty map on every semi-naive iteration — O(|dirty| × iterations), 384k `getWeight` calls on a 100×30 flood — and looks like an obvious win in a profile. Restricting it to the facts touched in the current iteration is provably equivalent (after iteration *k* every dirty weight is ≥ 0, so only facts touched in *k+1* can go negative). Prototyped, measured, effect on this workload: **none** (1,275 ms → 1,268 ms). It may still matter where iterations are many and Z-set construction is not dominating.

### Known follow-ups

The first three are visible in the post-change profile and are deliberately not done. The fourth is a stopgap with a plan to replace it.

- `weightedTuples()` allocates a fresh array per call, and after indexing the unbound path (delta scans) is its only heavy user. An iterator variant removes it but changes a public array-returning method that tests index into. (`forEachEntry` is the callback-style read for internal merges; the public array methods are unchanged.)
- `extendSubstitution` does `new Map(sub.bindings)` per bound variable, so a 4-arity atom copies the map four times per candidate. The fix is slot arrays instead of `Map`s, and the rule evaluation plan is its prerequisite — which is the argument for having built the plan.
- The rule-change path in `step` (a rule added or retracted mid-stream) derives every stratum again from scratch, through the same per-stratum recompute the stopgap below uses. It is rare and was left at that.
- **Retraction into a recursive stratum recomputes the stratum.** A derived fact's weight is a one-step support count, and a count cannot tell real support from circular support: over a symmetric `adj`, `reach(a)` and `reach(b)` hold each other up after the path to both is cut, and counting never retracts them. So `evaluateStratumFromDelta` dispatches to `recomputeStratum` whenever a delta can remove a derivation of a recursive stratum (a retraction from a positively read predicate, or an insertion into a negated one): wipe, derive again, emit the presence diff. Correct everywhere, at the stratum's cost instead of the delta's. On the 100×30 world a solid entity moving through a 3,000-cell spread stratum costs about 13 ms p50 and 16 ms p95 per tick, against 0.03 ms for the same move with no recursive stratum, and against 23 ms for one batch evaluate of the whole world. The fix proper is per-round counts, which is how DBSP's nested streams avoid circular support: a fact carries the round it appeared in and support only counts from earlier rounds. That is Plan 006.3 in `.plans/004-incremental-roadmap.md`. When it lands, delete `retractsIntoRecursion`, `retractsInto` and their dispatch, and keep `recomputeStratum`, which is also how aggregation strata are evaluated; the cyclic sweep in `tests/evaluator.test.ts` is the test that must still pass.

### What the evaluator is NOT

- **Not Prolog.** No SLD resolution; no cuts; no unification in the first-order-logic sense. Datalog is a strict subset.
- **Not Turing-complete.** Finite Herbrand universe → always terminating.
- **Not a query planner.** Join order is one greedy pass over relation sizes, not a cost model with statistics. It is enough to turn every scan the rule set actually performs into a lookup; it does not attempt anything a real optimiser would.
- **Not worst-case-optimal.** Cyclic queries (triangle-finding and friends) would want Leapfrog Triejoin and ordered indexes. The workloads here are acyclic star-shaped joins, where a hash index is already the right answer.
- **Not incremental for retraction into a recursive stratum.** Counting is sound for non-recursive strata, for recursion over acyclic data, and for any additive workload (fire spreading, a reachable set that only grows). Retraction from recursion over cyclic data is where a count cannot see that the remaining support is circular, so the evaluator recomputes such a stratum instead (see "Known follow-ups"). The answer is right; the cost is the stratum's.

## Testing

Every test file is pure — no I/O, no timers.

**Performance is asserted as a ratio, never as a clock.** `tests/negation-scaling.test.ts`
is the pattern: it measures the same program at 2k and 8k facts and asserts the *growth*,
because a shape reads the same on a loaded CI box as on an idle laptop. The package used
to carry a `roguelike-bench.test.ts` full of wall-clock ceilings instead, and it taught
the opposite lesson — it failed under `turbo test`'s parallelism while the code was fine,
and it passed unchanged straight through a 40× planner regression. Ceilings measure the
machine; ratios measure the code. It imports through this package's barrel on purpose, so
it exercises the surface a consumer can actually reach.

`tests/types.test.ts` pins `serializeValue` and `serializeTuple` byte-for-byte against a
reference implementation. If a change makes that test need editing, it is changing a
format other packages sort and snapshot by.

## See also

- `README.md` — the introduction, with a worked example.
- `LEARNINGS.md` — what the performance work actually taught, and what was measured and
  discarded.
- `packages/perspective/theory/unified-engine.md` §B.3 — the evaluator requirements this
  package was first written against, and §B.4 for the rule program its first consumer
  ships.
- `packages/perspective/theory/incremental.md` §5.6 — this engine as a stage in a larger
  incremental circuit.

