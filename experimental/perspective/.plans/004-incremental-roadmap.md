# Incremental Evaluation Roadmap

This document partitions the incremental evaluation effort into a sequence
of implementation plans.  Each plan is a self-contained body of work with
its own theory, deliverables, and test strategy.  The plans build on each
other — each one's output is the next one's input — but each delivers
standalone value.  Plan 006.1 is a refinement inserted between 006 and 007
that elevates the Datalog evaluator from ad-hoc DRed to principled Z-set
weight propagation.

**Theoretical foundation:** [theory/incremental.md](../theory/incremental.md)
**Spec sections covered:** §9, §11, §12, §16, §17
**Predecessor:** [002-unified-ccs-engine.md](./002-unified-ccs-engine.md) (complete)

---

## The Four Plans

```
Plan 005                    Plan 006                  006.1                  Plan 007               Plan 008
─────────────────────────   ────────────────────────  ─────────────────────  ──────────────────     ──────────────────
Incremental Kernel          Incremental Datalog       Unified Weighted       Settled / Working /    Query &
Pipeline                    Evaluator                 Evaluator              Compaction             Introspection

Z-set type + utilities      Monotone strata (Fugue)   Weighted Relation      Stability frontier     Level 1 queries
Incremental retraction      Stratified neg. (LWW)     Weighted semi-naive    Settled slot detect.   Level 2 queries
Incremental projection      DRed for negation         distinct operator      Per-stage freezing     Incremental queries
Incremental validity        Native fast path           Unified eval. entry   Frontier advancement   Introspection API
Incremental skeleton        Rule addition/retraction   Eliminate DRed        Compaction policy      explain / conflicts
Reality deltas              Strategy switching         Eliminate snap-diff    Safe compaction        history / whatIf
Batch pipeline preserved    Evaluation stage wrapper   Dead code removal     Snapshot caching       diff / branch
                                                                                                    Bookmark UX
```

---

## Plan 005: Incremental Kernel Pipeline ✅

**Spec:** §9.1–9.4, §9.6
**Theory:** incremental.md §2–§5 (DAG circuit), §6 (correctness)
**Status:** Complete. All 9 phases done. 1143 tests at completion.

### Goal

Transform the solver pipeline from full-recomputation to delta-driven
for all Layer 0 (kernel) stages.  After this plan, inserting a constraint
into a store of size |S| propagates through the kernel in O(|Δ|) rather
than O(|S|) — without touching the Datalog evaluator.

### Scope

1. **Z-set type and algebraic utilities** (`base/zset.ts`).  The shared
   foundation: `ZSet<T>`, `add`, `negate`, `zero`, `singleton`.  Runtime
   fast path for the common singleton-insert case.

2. **Incremental stage interface** (`IncrementalStage<In, Out>`).  The
   `step(delta) → delta` contract that every stage implements.

3. **Incremental retraction** — maintain the retraction graph and
   dominance cache as persistent state.  On a new constraint, cascade
   dominance and emit a Z-set delta of active-set changes.
   (incremental.md §3.2, §5.4)

4. **Incremental projection** — the bilinear join between active
   constraints and the structure index.  Handles orphaned values that
   become projectable when their target structure arrives later.
   (incremental.md §3.2, §5.5)

5. **Incremental validity** — persistent authority data structure
   replacing replay-from-scratch.  O(1) for non-authority constraints;
   re-check affected peers on authority changes.
   (incremental.md §3.2, §5.2)

6. **Incremental structure index** — append-only; each new structure
   constraint creates or joins a SlotGroup.
   (incremental.md §3.1, §5.3)

7. **Incremental skeleton** — mutable reality tree updated by
   resolution deltas and structure index deltas.
   (incremental.md §3.4, §5.8)

8. **Reality deltas** — the output type describing what changed in the
   tree (node added/removed, value changed, child reordered).
   (incremental.md §10)

9. **Incremental pipeline composition** — the DAG wiring that routes
   deltas from insertion through all stages in topological order.
   (incremental.md §4.3)

10. **Differential testing** — after every insertion, compare
    `incrementalPipeline.current()` against `solve(store, config)`.
    The batch pipeline is the correctness oracle.

### What this plan does NOT include

- Incremental Datalog evaluation (Plan 006).
- Native solver incremental fast path as a stage (Plan 006).
- Settled/working partitioning (Plan 007).
- Compaction (Plan 007).

### Datalog handling during this plan

The Datalog evaluator and native solvers remained batch during Plan 005.
The incremental pipeline called the batch evaluator on every insertion.
This was correct but not yet efficient for the evaluation stage — the
kernel stages around it were incremental, and the evaluation stage was
the remaining O(|S|) bottleneck.  Plan 006 eliminated this bottleneck
with native incremental solvers and an incremental Datalog evaluator.

### Key risk

The persistent authority data structure (item 5) is the most
design-intensive piece.  Revoke-wins semantics with causal ordering
makes incremental updates non-trivial.  The plan should prototype this
early and may need to iterate on the design.

---

## Plan 006: Incremental Datalog Evaluator ✅

**Spec:** §9.5, §9.6, §B.3, §B.4, §B.7, §14 (Layers 1–3)
**Theory:** incremental.md §9 (all subsections)
**Status:** Complete. All 7 phases done. 1198 tests at completion.

### Goal

Extend the Datalog evaluator from a batch engine to an incremental
stream processor.  After this plan, the full solver pipeline — kernel
stages and Datalog evaluation — is incremental end-to-end.  Any rule
(default, custom, or user query) automatically benefits.

### Scope

1. **Z-set-weighted relations** — extend `Relation` to track integer
   weights per fact.  Addition and negation become Z-set operations.
   (incremental.md §9.4)

2. **Incremental monotone strata** — for strata with only positive
   rules (no negation, no aggregation), run semi-naive from the input
   delta.  No provenance tracking needed.  Covers Fugue rules.
   (incremental.md §9.5)

3. **Provenance tracking** — weighted semi-naive evaluation where
   derived fact weights are products of input fact weights (provenance
   semiring).  Required for strata with negation.
   (incremental.md §9.4)

4. **Delta-aware negation** — when a new fact satisfies a previously-
   failed negation, retract the dependent derivations (weight −1) and
   rederive (DRed pattern).  Covers LWW `superseded`/`winner` rules.
   (incremental.md §9.6)

5. **Per-stratum accumulated state** — each stratum maintains its
   derived relations across `step()` calls.  Deltas from one step
   are computed relative to the previous step's output.
   (incremental.md §9.3)

6. **Native solver incremental fast path** — `IncrementalStage`
   implementations for LWW (per-slot winner tracking) and Fugue
   (per-parent tree maintenance) that produce the same delta type as
   the incremental Datalog evaluator.  Activates when default rules
   are detected; falls back to incremental Datalog when custom rules
   are present.
   (incremental.md §9.7)

7. **Rule addition/retraction** — when a `rule` constraint is added
   or retracted (active→dominated), re-evaluate affected strata.
   This is the mechanism that makes custom Layer 2 rules work
   incrementally: retract the default LWW rules, assert a custom
   resolution strategy, and the pipeline switches to Datalog
   evaluation for the new rules without full recomputation.
   (incremental.md §9.3)

8. **Equivalence testing** — for every input, verify that the
   incremental Datalog evaluator produces the same derived database
   as the batch evaluator.  Run the existing 759 tests through both
   paths.

### What this plan does NOT include

- Settled/working partitioning (Plan 007).
- Compaction (Plan 007).
- Query layer (Plan 008).

### Key risk

Provenance tracking for stratified negation (items 3–4) is the hardest
implementation task in the entire incremental effort.  The plan should
implement monotone strata first (item 2) — this covers Fugue rules and
validates the cross-time semi-naive pattern — before tackling negation.
The native fast path (item 6) serves as a correctness oracle: its
output must match the incremental Datalog output for default rules.

---

## Plan 006.1: Unified Weighted Datalog Evaluator

**Spec:** §B.3 (evaluator requirements), §B.4 (default rules), §B.7 (native optimization)
**Theory:** incremental.md §9.4 (provenance requirement), DBSP §3.2 (Z-set joins), §4–5 (nested streams)
**Status:** Not started.
**Full plan:** [006.1-unified-weighted-evaluator.md](./006.1-unified-weighted-evaluator.md)

### Goal

Unify the batch and incremental Datalog evaluators into a single
weighted evaluator. Replace DRed (wipe-and-recompute) and
snapshot-and-diff with Z-set weight propagation through the
semi-naive loop, making the Datalog path truly O(|Δ|) for all
strata — monotone and negation alike.

### Scope

1. **Weighted `Relation` and `Database`** — each fact carries an
   integer weight. `addWeighted(tuple, weight)` sums weights.
   `distinct()` clamps to 0/1. `tuples()` returns weight > 0
   (backward compatible with all existing consumers).

2. **Weighted substitutions and rule evaluation** — `WeightedSub`
   threads weights through joins (multiply), negation (filter),
   and guards (filter). `groundHead` sums weights for duplicate
   derivations.

3. **Unified evaluator** — one `createEvaluator(rules)` entry
   point. `step(delta)` is the general incremental case.
   `evaluate(rules, facts)` is a convenience wrapper that creates
   a fresh evaluator and steps with all facts as +1.  No DRed, no
   snapshot-and-diff, no `fullRecompute`.

4. **Pipeline rewiring** — the evaluation stage and batch pipeline
   both use the unified evaluator. Dead code removed.

### What this plan does NOT include

- Changes to the native LWW/Fugue solvers (unchanged).
- Changes to the evaluation stage's strategy switching logic
  (unchanged — it delegates to either native or the evaluator).
- Settled/working partitioning (Plan 007).
- Query layer (Plan 008).

### Key insight

DRed was chosen in Plan 006 because the batch evaluator had no weight
infrastructure and the bounded-cost argument held for default rules.
Plan 006.1 observes that Z-set weights with `distinct` are the
principled DBSP approach — the same algebra used everywhere else in
the pipeline — and that unifying the evaluators is the right moment
to add weights.  The `distinct` operator (clamp to 0/1 after each
semi-naive iteration) prevents weight explosion from transitive
closure, making weights safe for the `fugue_descendant` rules.

### Dependencies

- Plan 006 (complete — provides the incremental evaluation stage,
  native solvers, strategy switching, and the code to be unified).

---

## Plan 007: Settled Sets, Working Sets, and Compaction

**Spec:** §11, §12
**Theory:** incremental.md §7 (settled/working), §8 (compaction)

### Goal

Bound the incremental pipeline's cost to the working set (recent,
unsettled activity) rather than the total reality.  Reclaim storage
from constraints that can never affect future solving.

### Scope

1. **Stability frontier computation** — V_stable = component-wise
   minimum of all agents' version vectors.  For single-agent use,
   V_stable = the store's VV.  For multi-agent, requires periodic
   VV exchange.
   (spec §11.1)

2. **Per-stage settled detection** — each incremental stage tracks
   which accumulated entries are below V_stable and meet the settled
   criteria (no future constraint can change their status).
   (incremental.md §7.4)

3. **Frozen/working partition** — each stage splits its accumulated
   state into a frozen snapshot (never re-examined) and a working set
   (delta-processed).  `current() = frozen ∪ working`.
   (incremental.md §7.1)

4. **Frontier advancement** — when V_stable advances, newly-settled
   entries migrate from working to frozen.  The working set shrinks
   monotonically.
   (spec §11.5)

5. **Compaction policy** — per-reality configuration: full history,
   snapshot-preserving, or frontier-only.
   (spec §12.1)

6. **Safe compaction rules** — identify and remove compactable
   constraints: dominated values below frontier with exhausted
   retraction chains, superseded values below frontier, retraction
   pairs below frontier.  Structure and authority constraints are
   never compacted.
   (spec §12.2)

7. **Snapshot preservation** — under snapshot-preserving policy,
   retain constraints that contributed to any preserved snapshot
   (at bookmark granularity).
   (spec §12.1, §12.2)

8. **Compaction as GC** — remove zero-weight entries from frozen
   partitions.  No delta propagation — purely a space reclamation
   operation.
   (incremental.md §8.3)

### What this plan does NOT include

- Time travel UX (snapshots, scrubbing, named bookmarks) — the
  primitives are here (solve(S, V) already works, snapshots are
  materialized), but the user-facing API is Plan 008.
- Query layer (Plan 008).

### Dependencies

- Plan 005 (incremental kernel pipeline — provides per-stage
  accumulated state to partition).
- Plan 006 (incremental Datalog — provides per-stratum accumulated
  state).
- Multi-agent VV exchange (for distributed V_stable computation;
  single-agent V_stable works without it).

### Key risk

Compaction safety for sequences: Fugue origin references may point to
compacted structure constraints.  Structure constraints are never
compacted (spec §12.2), but the tombstone interaction needs careful
testing.  This is LEARNINGS.md Open Question #1.

---

## Plan 008: Query Layer and Introspection

**Spec:** §16, §17
**Theory:** incremental.md §10.2 (downstream consumers)

### Goal

Give applications a structured way to query the reality and the
constraint store, with incremental maintenance so queries update as
constraints arrive.  Provide introspection functions for debugging,
conflict resolution UIs, and audit trails.

### Scope

1. **Level 1 queries** — relational queries over the constraint store
   as a relation `Constraints(id, type, payload, refs, peer, lamport)`.
   Standard operations: select, project, join, group, aggregate.
   (spec §16.1)

2. **Level 2 queries** — queries over the reality as relations
   `MapEntries(container, key, value, determined_by)` and
   `SeqElements(container, position, value, determined_by)`.
   The `determined_by` CnId bridges back to Level 1 for provenance.
   (spec §16.2)

3. **Incremental query evaluation** — queries are DBSP operators that
   receive reality deltas (from Plan 005) as input and produce query
   result deltas as output.  Uses the same Z-set algebra and stage
   interface as the solver pipeline.
   (spec §16.3, incremental.md §10.2)

4. **Introspection API** — structured functions over the store and
   reality:
   - `explain(path)` — why does the reality have this value?
   - `conflicts(path)` — competing active values at a slot
   - `history(path)` — all value constraints for a slot
   - `whatIf(constraints)` — hypothetical non-destructive solving
   - `capabilities(agent)` — effective capabilities at current frontier
   - `authorityChain(agent, capability)` — trace grant chain to creator
   - `rejected(agent?)` — invalid constraints with reasons
   - `diff(V₁, V₂)` — compare realities at two causal moments
   - `bookmarks()` — all active bookmark constraints
   - `branch(V)` — virtual agent at a historical moment
   (spec §17)

5. **Version-parameterized queries** — `at(V, query)` runs any query
   against `solve(S, V)`.  Combined with snapshot caching from
   Plan 007, this enables efficient historical queries.
   (spec §17)

6. **Time travel UX** — named bookmarks, snapshot-based scrubbing,
   branching API.  The primitives exist (solve(S, V), bookmark
   constraints); this plan wraps them in a user-facing API.
   (spec §10)

### Dependencies

- Plan 005 (reality deltas — the input to incremental queries).
- Plan 006 (incremental Datalog — queries may be expressed as rules).
- Plan 007 (snapshots and frontier — enables efficient historical
  queries and time travel UX).

### Prep work (from Plan 006 review)

- ~~**Fix `evaluateMonotoneStratumIncremental` to use its `_inputDelta`
  parameter.**~~ **Resolved by Plan 006.1.** The unified weighted
  evaluator seeds semi-naive from the input delta for all strata,
  making the `_inputDelta` fix a natural consequence of the design
  rather than a targeted patch.

### Key risk

The scope is large.  The introspection functions are individually
simple (most are queries over already-computed data), but there are
many of them.  The plan should prioritize the functions most needed
by application developers: `explain`, `conflicts`, `history`, and
`diff` first; `whatIf`, `branch`, and `authorityChain` later.

---

## Plan Dependencies

```
005 Incremental Kernel Pipeline
 │
 ├──→ 006 Incremental Datalog Evaluator
 │     │
 │     └──→ 006.1 Unified Weighted Evaluator
 │            │
 │            ├──→ 007 Settled / Working / Compaction
 │            │     │
 │            │     └──→ 008 Query & Introspection
 │            │
 │            └──→ 008 Query & Introspection
 │
 └──→ 007 Settled / Working / Compaction
```

Plans 005 and 006 are strictly sequential — 006 builds on 005's stage
interface and Z-set types.

Plan 006.1 depends on 006 (it refines the evaluator 006 built).  It
should be completed before Plan 007, because weighted relations make
per-stratum settling well-defined (a stratum's derived facts have
stable weights once inputs are settled), and before Plan 008, because
the query layer will exercise the Datalog path with potentially large
derived relations where DRed's O(|stratum|) cost is unacceptable.

Plan 007 depends on 005, 006, and 006.1 (it partitions their
accumulated state), but could begin design work (stability frontier,
compaction rules) in parallel with 006.1.

Plan 008 depends on 005 (reality deltas) and benefits from 006.1
(truly O(|Δ|) Datalog for query rules) and 007 (snapshots for time
travel), but basic introspection functions (explain, conflicts,
history) could start after 006.1.

---

## What These Plans Do NOT Cover

The following items from the [future work catalog](./003-future-work-catalog.md)
are **not** part of the incremental evaluation effort.  They are
independent workstreams that can proceed in parallel:

- **Real ed25519 signatures** — self-contained replacement of
  `signature.ts` + canonical encoding.  No dependency on incremental
  evaluation.

- **Wire format & sync protocol** — serialization (CBOR/MessagePack)
  and transport.  Orthogonal to incremental evaluation, though
  reality deltas (Plan 005) inform what needs to be communicated.

- **Path-based capability checks** — requires the skeleton (which
  exists) and a design for the circular dependency (validity →
  skeleton → validity).  Independent of incremental evaluation.

- **Convenience DSL** — Datalog rule parser.  Independent.

- **Text wrapper / Myers diff** — application-level convenience.
  Independent.

- **Rich text marks** — design work on mark constraints.  Independent.

- **Batching & compact encoding** (§13) — wire format optimization.
  Benefits from, but does not require, incremental evaluation.