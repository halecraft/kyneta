# Plan 008: Retire the §B.7 Native Fast Path

## Background

§B.7 of the Unified CCS Engine Specification permits _native solvers_ — host-language implementations of LWW and Fugue that a peer may run in place of the Datalog rules, provided they produce identical output. The justification it gives is performance: _"Evaluating LWW via Datalog is correct but inefficient."_ This package took that permission and built the machinery: hand-written solvers, a rule-shape detector that decides when they are safe, and a switching layer that keeps both implementations interchangeable at runtime.

That justification has since been measured and does not hold. The quadratic cost attributed to the `superseded` rule was a planner bug in `@kyneta/datalog` — a delta-driven negation binds its atom's variables, but the planner recorded it as binding nothing, so the atom beside it fell back to a full scan per substitution. With that fixed, the full LWW program over 8,000 values went from ~1,190 ms to ~63 ms and became linear in the store. `tests/negation-scaling.test.ts` in `@kyneta/datalog` holds it there.

What survives of the original claim is narrower than it looked: a single slot with _n_ concurrent writers genuinely gives `superseded` n² answers, and that is a property of the rule that no evaluator can plan away. With writers per slot bounded — the shape real stores have — pure-Datalog LWW is linear and needs no native solver.

So the performance argument for §B.7 is gone. This plan is about what to do with the machinery it justified, and the answer is **not** simply "delete it," because the investigation below found the native solvers are load-bearing in ways the performance framing obscured.

## What the investigation found

The native solvers were described in `TECHNICAL.md` as an optimization layered over the Datalog path. They are not. **Native is the default and Datalog is the exception**, in both pipelines.

`selectResolutionStrategy` (`kernel/rule-detection.ts`) returns `"native"` in three cases and `"datalog"` in one:

| condition | strategy | why it exists |
| --- | --- | --- |
| `enableDatalogEvaluation === false` | native | testing / benchmark mode |
| `rules.length === 0` | native | the store before bootstrap injects rules |
| `isDefaultRulesOnly(rules, active)` | native | **the §B.7 fast path** |
| otherwise (custom or Layer 2+ rules) | datalog | the primary path, per the spec |

`createIncrementalEvaluation` likewise initialises `strategy = "native"` and creates the Datalog `Evaluator` lazily, only on a switch. A store that never installs a custom rule never runs Datalog at all.

Beyond strategy selection there are four further consumers, and only the third row of that table is the one the performance work invalidated:

1. **Graceful degradation.** `kernel/pipeline.ts` falls back to `buildNativeResolution` when `evaluate()` returns an error — e.g. custom rules that fail to stratify through cyclic negation. This is error recovery, not optimization.
2. **`skeleton.ts`'s LWW fallback.** `resolveSlotValue` calls `resolveLWWSlot` only when no `ResolutionResult` was passed. `kernel/pipeline.ts` — the sole production caller of `buildSkeleton` — always passes one, in every branch. This path is reached by **tests only**: 23 two-argument calls in `tests/kernel/skeleton.test.ts` against 4 three-argument ones.
3. **`skeleton.ts`'s Fugue fallback.** `orderSeqElements` falls through to `buildFugueNodes` / `orderFugueNodes` **even when a `ResolutionResult` is present**, whenever a parent has no derived `fuguePairs` and more than one element. Unlike the LWW case this is reachable in production, and whether it is ever _taken_ in production is the open question this plan has to settle.
4. **Equivalence-test oracles.** `tests/solver/{lww,fugue}-equivalence.test.ts` import `evaluate` from `@kyneta/datalog`, `buildDefaultLWWRules` from bootstrap, and the solver directly, then compare. They never touch `rule-detection.ts` or the switching layer, so they survive its removal unchanged.

## The decision this plan takes

**Delete the switching machinery. Keep the batch solvers as test oracles.**

Deleting the solvers outright is the wrong trade. Once the fast path stops being live, the Datalog rules become the _only_ implementation of LWW and Fugue; discarding the independent implementation you check them against, at exactly the moment it becomes your only cross-check, buys ~560 lines and costs the oracle. Demoting is nearly free and keeps it.

Put structurally, this machinery is a familiar shape: **two implementations of one decision, with nothing enforcing that they agree.** The same shape produced both evaluator bugs fixed in the run-up to this plan — `estimateCost` knowing that a delta-driven negation binds while `bindVariables` did not, and a seed condition that did not know which pass it was in. In each case the halves drifted because agreement was a convention rather than a structure, and in each case nothing failed loudly, because the wrong answer degraded into something that looked safe.

Here the enforcement mechanism is the equivalence suite — and that is precisely the part being kept. **The plan deletes the thing that requires agreement and retains the thing that checks it.** That is a better reason to demote rather than delete than the performance argument is, and it generalises: it is the same move as replacing four drifting delta loops with one `ruleDeltaShape`, and the same move as Phase 4 turning an unreachable fallback into an assertion rather than a deletion.

There is a third argument, independent of performance. §B.7 requires an **engine version** pinned in the reality's creation constraint, because two peers running different native implementations diverge silently from the same store. `bootstrap.ts` has never emitted one — the mechanism whose entire purpose is preventing divergence is specified and not built. If no native code is live at runtime, there is nothing for two peers to disagree about and that gap closes by construction, rather than by building the versioning machinery to protect an optimization that is no longer needed.

## Accounting

Measured, not estimated.

**Removed** (~1,960 lines):

| file | lines | why |
| --- | --- | --- |
| `src/kernel/rule-detection.ts` | 211 | the sniffer; nothing to decide once there is one path |
| `src/solver/incremental-lww.ts` | 191 | exists only to be live at runtime |
| `src/solver/incremental-fugue.ts` | 257 | likewise |
| `src/kernel/native-resolution.ts` | 113 | packages solver output as a `ResolutionResult` |
| `tests/solver/incremental-lww.test.ts` | 532 | tests deleted code |
| `tests/solver/incremental-fugue.test.ts` | 416 | tests deleted code |
| part of `src/kernel/incremental/evaluation.ts` | ≤558 | see Phase 3 |

**Retained, demoted to test-only** (~1,661 lines):

| file                                     | lines |
| ---------------------------------------- | ----- |
| `src/solver/lww.ts`                      | 184   |
| `src/solver/fugue.ts`                    | 380   |
| `tests/solver/lww-equivalence.test.ts`   | 456   |
| `tests/solver/fugue-equivalence.test.ts` | 641   |

These two test files are the §B.7 correctness contract — they run inputs through both `evaluate()` and the native solver and assert identical output. The similarly-named `tests/solver/incremental-{lww,fugue}.test.ts` are **not** the same thing despite what `TECHNICAL.md` claimed until this plan was written: they compare the incremental native solver against the batch native solver across insertion orderings and never invoke Datalog. That is why the pair above is kept and the pair above that is deleted, and it is worth checking against the files rather than the prose before touching either.

**The tail in `resolve.ts` (488 lines), not previously accounted.** Nothing here is named by the phases above, and all of it dies with them:

| symbol | why it dies |
| --- | --- |
| `parseLWWFact` | sole consumer was `incremental-lww.ts` |
| `parseSeqStructureFact` | sole consumer was `incremental-fugue.ts` |
| `allPairsFromOrdered` | consumers were `incremental-fugue.ts` and `native-resolution.ts` |
| `nativeResolution` | consumers were `native-resolution.ts` and `incremental/evaluation.ts` |
| `ResolutionResult.fromDatalog` | becomes permanently `true` |
| `diffResolution` (in `evaluation.ts`) | exists only to diff across a strategy flip |

Two notes. `nativeResolution` lives in `resolve.ts`, **not** in `native-resolution.ts` — the 113 lines in the removal table do not include it. And the doc comment on `parseLWWFact` claims it is used by "the incremental Datalog evaluator's resolution extraction"; it is not. The Datalog path uses `extractWinners` / `extractFugueOrdering` and `winnerDeltas` / `fuguePairDeltas` and never touches the parsers. Both of these are the same species of drift as the `TECHNICAL.md` misattribution above: prose that makes dead code look load-bearing.

`fromDatalog` deserves its own line. A boolean that is now always `true` is exactly the kind of vestigial field that survives a decade and accretes dead branches on the false side. Remove it with the rest rather than leaving it for a later pass.

**Blast radius outside the package: none.** `packages/`, `examples/`, `experimental/`, `internal/` and the root `tests/` workspace were searched for `nativeFastPath`, `buildNativeResolution`, `selectResolutionStrategy`, `hasDefaultLWWRules`, `enableDatalogEvaluation`, `fromDatalog` and `nativeResolution`. Nothing outside `packages/perspective` references any of them, so Phase 5's break is contained to this package's own tests.

Note this corrects the figure quoted when the question was first raised. "About 3,000 lines, all of which exist to avoid running the rules" was wrong on both counts: the surface is ~3,830 lines, and a third of it is doing something other than avoiding the rules.

## Phases

Ordered so that each phase leaves the tree green and the riskiest question is answered before anything irreversible happens.

### Phase 0 — Settle the Fugue fallback — **DONE, plan proceeds**

The question that could have invalidated this plan: `orderSeqElements` falls through to the native Fugue solver when `resolution.fuguePairs` has no entry for a parent with >1 element, and unlike the LWW fallback that is reachable with a `ResolutionResult` present. Either it is dead in practice, or the Fugue rules have a coverage gap the native solver has been quietly compensating for.

**Result: the fallback is dead once the §B.7 branch is removed, and the Datalog Fugue rules cover the case themselves.** Method and evidence:

1. Made the fallthrough `throw`, ran the suite as-is: 981/981 passed. Not yet conclusive — the default strategy is `native`, so most tests never produce a Datalog-derived resolution at all.
2. Forced `selectResolutionStrategy` to return `"datalog"` unconditionally: 38 failures, several with `FUGUE_FALLBACK_TAKEN elements=3 pairs=undefined`. This looked like the feared coverage gap but was an artefact of the blunt probe — it also forced Datalog for stores holding **no rules at all**, where an empty rule set correctly derives nothing. The accompanying `simple map` failures have the same single cause and are the `rules.length === 0` case of Phase 1, not a Fugue problem.
3. Disabled **only** the `isDefaultRulesOnly` branch — the actual §B.7 fast path, leaving the no-rules and native-only branches intact. **The probe never fires.** 977/981 pass.
4. Guarded against a vacuous result by moving the probe to the _success_ branch: `topologicalOrderFromPairs` is reached **32 times**, on real multi-element sequences (`elements=3 pairs=3`, `elements=2 pairs=1`). The path is covered and the rules derive the ordering.

The four remaining failures in step 3 are all tests asserting the fast path exists, and are expected to be rewritten or deleted by this plan:

- `integration.test.ts` — "native fast path activates for default rules"
- `resolve.test.ts` — "default LWW + Fugue rules trigger native fast path"
- `resolve.test.ts` — "native fast path sets fromDatalog=false in resolution result"
- `incremental/evaluation.test.ts` — "rule retraction mid-stream: values re-resolved under restored defaults". This one is worth reading before Phase 3: it retracts custom rules and expects a flip back to native, but its hand-built rule delta never _adds_ the default rules, so with one path the evaluator is left holding zero rules. Production does not have this hole — `extractRuleDeltasFromActive` derives rule deltas from the active-constraint delta, so bootstrap's defaults enter the evaluator when they become active and remain after the custom rules retract. It is a test artefact, but it is evidence that **tests have been leaning on the native path to supply default semantics without installing default rules**, and Phase 3 should expect more of that shape.

Consequence for Phase 4: `orderSeqElements`'s fallthrough becomes unreachable and should be replaced by an assertion rather than silently deleted — if a parent with >1 element ever has no derived pairs, that is a rules bug and should say so.

### Phase 0b — Catalogue of tests that lean on the native path — **DONE**

Phase 0 turned up one test leaning on the native path to supply default semantics. A sweep found it is not one test, it is a pattern, and it reaches the file that is supposed to be this package's primary pipeline test.

**Method.** Force `selectResolutionStrategy` to return `"datalog"` unconditionally — the strongest form of the post-plan world — and run the whole suite. Every failure is a test whose result currently depends on the native solver. **37 of 981 tests fail**, in four files.

**The headline.** `tests/kernel/pipeline.test.ts` holds **29 tests and zero rule constraints**. It asserts "concurrent writes to same key resolved by LWW (higher lamport wins)", "concurrent seq inserts at same position: lower peer goes first", "retracted value does not participate in LWW" — and its stores contain no LWW or Fugue rules at all. `buildStore([root, child, grant, val1, val2])`, then assert Bob wins on lamport. That outcome comes entirely from `resolveLWW` in the native solver. 23 of its 29 tests fail when Datalog is the only path.

Its config makes the intent explicit, and the comment is wrong:

```ts
const DEFAULT_CONFIG: PipelineConfig = {
  creator: "alice",
  enableDatalogEvaluation: true, // Match production default: Datalog is primary
};
```

With `enableDatalogEvaluation: true` and no rules in the store, `selectResolutionStrategy` returns `"native"` through its `rules.length === 0` branch. The file believes it is exercising the primary path and is exercising the one this plan deletes. That is worth stating plainly: **the engine's central claim is that conflict resolution is data — rules in the store, replaceable by anyone with permission — and the primary pipeline test never puts a rule in the store.**

**Classification of the 37.**

_A — semantics asserted with no rules installed (24 tests)._ The real gap. These must install the default rules so the store actually describes the behaviour being asserted. They are not currently wrong, but they test the solver rather than the engine.

- `pipeline.test.ts` — 20: simple map (6), simple sequence (3), nested containers (2), retraction (2), version-parameterized solving (3), `solveFull` intermediate stages, determinism, agent integration (2)
- `resolve.test.ts` — 4: authority constraint immunity, structure index from valid set, `solveFull` exposes resolutionResult, resolution result contains correct LWW winner data

_B — deliberately assert the two-path contrast or fast-path metadata (12 tests)._ Correct today, deleted or halved by this plan. No hidden work.

- `resolve.test.ts` — 8: native fast path detection (3), `fromDatalog=false` (2), backwards compatibility with `NATIVE_CONFIG` (3)
- `pipeline.test.ts` — 3: native-only bypass
- `integration.test.ts` — 1: native fast path activates for default rules
- plus `resolve.test.ts`'s "custom lowest-lamport-wins rule replaces default LWW", which asserts _both_ paths (`NATIVE_CONFIG` → Alice, `DATALOG_CONFIG` → Bob). The Datalog half is a genuinely good test and stays; only the native contrast goes.

_C — test artefact (1 test)._ `incremental/evaluation.test.ts`, as analysed in Phase 0.

**A related shape the sweep does not catch.** Some tests "force the Datalog path" by adding an irrelevant Layer 2 rule rather than installing real semantics. `"Datalog path sets fromDatalog=true in resolution result"` installs a winner-only rule with no `superseded`, and asserts only the metadata flags — never the resolved value. It passes, and exercises no resolution semantics at all. These do not fail under the probe because they already take the Datalog path; they are invisible to it. Worth a manual pass over every `makeRuleConstraint(..., 2, ...)` in the suite.

**The fix is cheaper than the count suggests.** `resolve.test.ts` already has the helper:

```ts
function defaultRuleConstraints(
  peer: PeerID,
  startCounter: number,
): RuleConstraint[] {
  const rules = buildDefaultRules();
  return rules.map((r, i) => makeRuleConstraint(peer, startCounter + i, 1, r));
}
```

Most of category A is adding `...defaultRuleConstraints("alice", 100)` to a `buildStore` call. The helper should move somewhere shared — `tests/kernel/pipeline.test.ts` cannot reach it today, which is plausibly how the gap opened in the first place.

**`integration.test.ts` is the model.** 30 tests, 13 of which bootstrap rules, 1 failure. It is the only file in the suite that consistently puts rules in the store before asserting what the rules do. Category A should be brought up to that standard.

**Do this before Phase 1, not after.** If the tests are corrected first, Phase 1 is a change with a green suite on both sides of it. If Phase 1 lands first, 24 tests go red at once and it will not be obvious which are genuine regressions and which were never testing what they claimed.

### Phase 1 — Make the Datalog path the only strategy

- `kernel/pipeline.ts` and `kernel/incremental/pipeline.ts` always evaluate through `@kyneta/datalog`.
- Delete `selectResolutionStrategy`, `isDefaultRulesOnly`, `hasDefaultLWWRules`, `hasDefaultFugueRules` and the `ResolutionStrategy` type.
- Keep `extractRules` — it is rule-set plumbing, not detection, and the Datalog path needs it.
- Decide the two non-§B.7 strategy cases explicitly rather than by omission:
  - **`rules.length === 0`**: Datalog over an empty rule set derives no winners, so a pre-bootstrap store resolves to an empty reality. This is arguably the correct reading — no rules means no resolution semantics — but it is a behaviour change and needs a test that says so on purpose.
  - **`enableDatalogEvaluation: false`**: the flag's only remaining meaning is "produce no resolution at all". Remove the flag rather than leave it as a switch with one live position.

### Phase 2 — Decide what a stratification failure does

Removing the native path removes the graceful-degradation branch. Custom rules that fail to stratify currently fall back to native solvers and produce a reality; afterwards they must do something else. The options, in the order I would defend them:

1. **Surface the error.** A rule set that cannot be stratified is a constraint-store error, and silently resolving it with rules the agent did not ask for is arguably worse than failing: the peer computes a reality that its own store does not describe.
2. Fall back to the last-good rule set.
3. Keep native solvers live purely for this path — which reintroduces the divergence liability and is listed only to be rejected.

This is a spec-semantics decision, not a refactor, and should be settled before Phase 3 rather than discovered during it.

### Phase 3 — Collapse `incremental/evaluation.ts`

558 lines that hold both implementations, decide which is live, and — on a strategy flip — rebuild the newly-chosen one from scratch and diff it against what the old one produced so downstream sees a clean delta. With one implementation, the flip handling, `nativeCurrentResolution` and `diffResolution` all go; what remains is `routeFactsByPredicate`, `extractRuleDeltasFromActive`, `resolutionDeltas` and a thin `step`. Expect the file to lose well over half its length, but the exact figure depends on Phase 2.

**The outcome to aim for is the `step` signature, not the line count.** Today:

```ts
step(
  deltaFacts: ZSet<Fact>,
  deltaRules: ZSet<Rule>,
  getAccumulatedFacts: () => Fact[],                 // "Only called on strategy switches"
  getActiveConstraints: () => readonly Constraint[], // "Only called on rule changes"
)
```

Both closures exist solely for strategy switching — their own doc comments say so. `incremental/pipeline.ts` supplies them as `() => projection.current()` and `() => retraction.current()`: closures over **two other stages' mutable accumulated state**, threaded into the evaluation stage so that a flip can re-bootstrap the newly-chosen implementation from the whole world.

That is imperative shell reaching across stage boundaries into what is supposed to be a pure delta transform, and it is the one place in the incremental pipeline where a stage needs more than its own delta and its own state. With one implementation it becomes:

```ts
step(deltaFacts: ZSet<Fact>, deltaRules: ZSet<Rule>)
```

— a genuine delta → delta function, and the cross-stage coupling disappears entirely. This is the strongest functional-core argument in the plan and the most visible improvement to callers; treat the signature as the acceptance criterion for the phase.

Note what is being given up in exchange, so it is a choice and not an accident: `selectResolutionStrategy` is a _well-built_ pure decision function, and its own doc records that it removed an identical if/else chain duplicated across both pipelines. It goes because the question it answers disappears, not because the abstraction was wrong.

### Phase 4 — Demote the batch solvers

- Move `src/solver/lww.ts` and `src/solver/fugue.ts` out of `src/`, to `tests/oracles/` or equivalent, so they cannot be imported by shipping code.
- Remove `skeleton.ts`'s two fallbacks; make `resolution` a required parameter of `buildSkeleton`.
- Rewrite the 23 two-argument `buildSkeleton` calls in `tests/kernel/skeleton.test.ts` to pass a `ResolutionResult`. This is the bulk of the mechanical work and is why it comes last.
- `kernel/resolve.ts` imports the `LWWEntry` _type_ only; move the type rather than keeping a source dependency on a test directory.

### Phase 5 — Public API and documentation

Breaking, and it should be a `feat!` with the removals named. The root barrel currently exports `buildNativeResolution`, `buildNativeFuguePairs`, `nativeResolution`, `selectResolutionStrategy`, `ResolutionStrategy`, `hasDefaultLWWRules` and `hasDefaultFugueRules`; all go. The package is 0.x under independent versioning and documents itself as not production-ready, so the cost is low — but it is a real break and belongs in the changelog, not a footnote.

`TECHNICAL.md` needs more than an edit to the §B.7 section: its framing of native solvers as an optimization over a primary Datalog path is the opposite of how the code currently behaves, and that mis-description is part of why the entanglement went unnoticed.

## Risks

- ~~**The Fugue fallback is live** (Phase 0).~~ **Retired.** Measured dead once the §B.7 branch alone is removed, with the success path shown to be covered 32 times over multi-element sequences. This was the plan's main exposure.
- **Losing the equivalence oracles by accident.** The retained tests must keep running in CI after the move; a test directory that nothing imports is easy to orphan. Verify the suite count before and after.
- **`enableDatalogEvaluation: false` has users.** It is public and appears in `tests/integration.test.ts`, `tests/kernel/pipeline.test.ts` and `tests/kernel/host.test.ts`. Removing a config flag is a break beyond the §B.7 surface.
- **Retraction-into-recursion still recomputes** (`retractsIntoRecursion`, Plan 006.3). Removing the native path makes every store depend on the Datalog evaluator's incremental behaviour, including that stopgap. This plan does not make it worse, but it removes the escape hatch that made it tolerable.

## What this plan does not do

- It does not touch §B.7 in the specification. The spec _permits_ native solvers; it does not require them. Retiring this implementation is a choice this package makes, and a future peer may still make the other one — which is precisely why the equivalence oracles are worth keeping.
- It does not build the engine-version pinning §B.7 requires. That obligation disappears with the live native code; if the fast path is ever revived, it comes back with it.
