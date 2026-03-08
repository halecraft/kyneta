# Plan 005: Incremental Kernel Pipeline

## Background

The Prism CCS engine (Plans 001–002, complete) implements the full solver pipeline
from the [Unified CCS Engine Specification](../theory/unified-engine.md). Every
call to `solve(store, config)` recomputes the entire pipeline from scratch:
version filter → validity → structure index → retraction → projection → evaluation
→ resolution → skeleton → reality. For a store with |S| constraints, every
insertion costs O(|S|).

[theory/incremental.md](../theory/incremental.md) establishes that this pipeline
is a DBSP circuit — a DAG of operators connected by streams — and that each
operator can be incrementalized independently. The DBSP chain rule and circuit
incrementalization guarantee that the composition of incremental operators produces
the same result as the batch pipeline.

This plan covers the **kernel stages** of that circuit: everything except the
Datalog evaluator (Plan 006). After this plan, inserting a constraint propagates
through the kernel in O(|Δ|) rather than O(|S|). The Datalog evaluator remains
batch during this plan — it is the remaining bottleneck that Plan 006 eliminates.

### Key Specification References

- unified-engine.md §7.2 (Solver Pipeline)
- unified-engine.md §9 (Incremental Maintenance)
- unified-engine.md §5 (Authority & Validity)
- unified-engine.md §6 (Retraction & Dominance)
- unified-engine.md §8 (Policies / Slot Identity)
- theory/incremental.md §2–§6, §10–§11

## Problem Statement

The batch pipeline is O(|S|) per insertion. A collaborative document with 10,000
constraints re-walks all 10,000 through validity, retraction, projection,
evaluation, and skeleton building every time a single character is typed. This
makes the engine unusable for real-time collaboration on non-trivial documents.

## Success Criteria

1. An `IncrementalPipeline` exists that accepts single-constraint insertions and
   produces reality deltas.
2. `incrementalPipeline.current()` produces a `Reality` identical to
   `solve(store, config)` for any sequence of constraint insertions. Verified by
   differential testing.
3. The kernel stages (validity, structure index, retraction, projection, skeleton)
   process only the delta, not the full store.
4. The Datalog evaluator and native solvers are called with accumulated facts
   (batch fallback) — correctness preserved, evaluation stage not yet incremental.
5. Reality deltas are emitted as a structured type describing what changed.
6. All existing tests continue to pass (currently 759 across 21 files).
7. New tests cover: Z-set algebra, incremental retraction cascades, incremental
   projection with orphaned values, incremental validity with authority changes,
   incremental skeleton updates, pipeline differential equivalence.

## Gap Analysis

### What Exists

- Batch pipeline (`pipeline.ts`) — full recomputation, correctness oracle.
- All kernel modules (validity, retraction, structure-index, projection,
  resolve, skeleton) — pure functions over full constraint sets.
- Native solvers (`solver/lww.ts`, `solver/fugue.ts`) — batch.
- Datalog evaluator (`datalog/evaluate.ts`) — batch, semi-naive.
- Store with `generation` counter for cache invalidation.
- 759 passing tests across 21 files (count may drift; not a fixed target).

### What's Missing

- Z-set type and algebraic utilities.
- Incremental operator conventions (step/current/reset per concrete module).
- Persistent (mutable, accumulated) versions of each kernel stage.
- Persistent authority data structure (replacing replay-from-scratch).
- Reality delta type.
- DAG wiring that routes deltas through stages in topological order.
- Incremental pipeline composition root (`IncrementalPipeline`).
- Differential tests comparing incremental vs batch.

## Core Type Definitions

### Z-Set

```typescript
// base/zset.ts

/**
 * A Z-set entry: an element with an integer weight.
 * +1 = present/inserted, −1 = removed/retracted, 0 = not stored.
 */
interface ZSetEntry<T> {
  readonly element: T;
  readonly weight: number;
}

/**
 * A Z-set over elements of type T, keyed by string identity.
 * Invariant: no entry has weight 0 (zero-weight entries are pruned).
 */
type ZSet<T> = ReadonlyMap<string, ZSetEntry<T>>;

// Core algebra
function zsetEmpty<T>(): ZSet<T>;
function zsetSingleton<T>(key: string, element: T, weight?: number): ZSet<T>;
function zsetAdd<T>(a: ZSet<T>, b: ZSet<T>): ZSet<T>;
function zsetNegate<T>(a: ZSet<T>): ZSet<T>;
function zsetFromEntries<T>(entries: Iterable<[string, ZSetEntry<T>]>): ZSet<T>;

// Queries
function zsetIsEmpty<T>(zs: ZSet<T>): boolean;
function zsetSize<T>(zs: ZSet<T>): number;
function zsetGet<T>(zs: ZSet<T>, key: string): ZSetEntry<T> | undefined;
function zsetHas<T>(zs: ZSet<T>, key: string): boolean;
function zsetPositive<T>(zs: ZSet<T>): ZSet<T>;  // entries with weight > 0
function zsetNegative<T>(zs: ZSet<T>): ZSet<T>;  // entries with weight < 0

// Iteration
function zsetForEach<T>(zs: ZSet<T>, fn: (entry: ZSetEntry<T>, key: string) => void): void;
function zsetMap<T, U>(zs: ZSet<T>, keyFn: (e: T) => string, mapFn: (e: T) => U): ZSet<U>;
```

#### Z-Set Key Conventions

The Z-set is keyed by string. The caller provides the key when creating entries
(`zsetSingleton`, `zsetFromEntries`). The algebra (`zsetAdd`, `zsetNegate`)
operates on existing keys and never derives new ones. Correctness requires that
two semantically identical elements always produce the same key — otherwise +1
and −1 entries won't cancel.

Each element type has a single canonical key function:

| Element type | Key function | Defined in |
|---|---|---|
| `Constraint` | `cnIdKey(c.id)` | `kernel/cnid.ts` (exists) |
| `SlotGroup` | `group.slotId` | `kernel/structure-index.ts` (exists) |
| `Fact` | `factKey(f)` | `datalog/types.ts` (new — Phase 5) |
| `ResolvedWinner` | `winner.slotId` | `kernel/resolve.ts` (exists) |
| `FugueBeforePair` | `` `${p.parentKey}|${p.a}|${p.b}` `` | inline (trivial) |

The only new code needed is `factKey()`: a deterministic serialization of
`predicate + terms` for Datalog facts. Added in Phase 5 (Projection) since
that is where `ZSet<Fact>` first appears.

### Operator Conventions (No Shared Interface)

Each incremental stage is a **concrete module** with its own specific `step`
signature (single-input, two-input, or three-input depending on the operator's
arity). There is no shared `IncrementalStage<In, Out>` interface — multi-input
stages like projection and skeleton cannot conform to a single-input generic.

All stages follow three shared conventions:

1. **`step(...deltas)`** — process input delta(s), update internal state, return
   output delta. Arity varies by stage.
2. **`current()`** — return the full materialized output (equal to the batch
   operator applied to the sum of all inputs seen so far).
3. **`reset()`** — return to empty state (for cold start or testing).

Internal state (retraction graph, orphan set, authority index, etc.) is private
to each implementation. Only the materialized output is exposed via `current()`.
This matches DBSP's model: the operator's externally-visible state is the
integration of its output stream.

**Correctness invariant** (applies to all stages regardless of arity):

```
current() == Q_batch(accumulated inputs)
```

Stage arities:

| Stage | Inputs | step signature |
|-------|--------|---------------|
| Version filter | 1 | `step(Δ_store: ZSet<Constraint>): ZSet<Constraint>` |
| Validity | 1 | `step(Δ_filtered: ZSet<Constraint>): ZSet<Constraint>` |
| Structure index | 1 | `step(Δ_valid: ZSet<Constraint>): ZSet<SlotGroup>` |
| Retraction | 1 | `step(Δ_valid: ZSet<Constraint>): ZSet<Constraint>` |
| Projection | 2 | `step(Δ_active: ZSet<Constraint>, Δ_index: ZSet<SlotGroup>): ZSet<Fact>` |
| Skeleton | 3 | `step(Δ_resolved, Δ_fuguePairs, Δ_index): RealityDelta` |

### Reality Delta

```typescript
// kernel/incremental/types.ts

type NodeDelta =
  | { readonly kind: 'nodeAdded'; readonly path: readonly string[]; readonly node: RealityNode }
  | { readonly kind: 'nodeRemoved'; readonly path: readonly string[] }
  | { readonly kind: 'valueChanged'; readonly path: readonly string[]; readonly oldValue: Value | undefined; readonly newValue: Value | undefined }
  | { readonly kind: 'childAdded'; readonly path: readonly string[]; readonly key: string; readonly child: RealityNode }
  | { readonly kind: 'childRemoved'; readonly path: readonly string[]; readonly key: string }
  | { readonly kind: 'childrenReordered'; readonly path: readonly string[]; readonly keys: readonly string[] };

interface RealityDelta {
  readonly changes: readonly NodeDelta[];
  readonly isEmpty: boolean;
}
```

### Incremental Pipeline

```typescript
// kernel/incremental/pipeline.ts

interface IncrementalPipeline {
  /** Insert a single constraint. Returns what changed in the reality. */
  insert(constraint: Constraint): RealityDelta;

  /** Insert multiple constraints (batch). Returns combined delta. */
  insertMany(constraints: readonly Constraint[]): RealityDelta;

  /** The current full reality (accumulated from all deltas). */
  current(): Reality;

  /** Full batch recomputation for verification. */
  recompute(): Reality;

  /** The underlying store (for sync, export, etc). */
  readonly store: ConstraintStore;

  /** The pipeline config. */
  readonly config: PipelineConfig;
}

function createIncrementalPipeline(config: PipelineConfig): IncrementalPipeline;
function createIncrementalPipelineFromBootstrap(result: BootstrapResult): IncrementalPipeline;
```

## Architecture

The version filter stage (F^Δ) is identity for the common case — solving at
current time with no version parameter. It is not implemented as a separate
module; the pipeline composition root passes the constraint directly to the
validity stage. Version-parameterized solving (time travel) uses the batch
pipeline.

```
Δc ──→ store.insert
  │
  ▼
  F^Δ (version filter — identity; not a separate module)
  │
  ▼
  C^Δ (validity — check against accumulated AuthorityState)
  │
  ├──→ X^Δ (structure index — append-only slot group updates)
  │     │
  │     └──→ Δ_index
  │
  └──→ A^Δ (retraction — dominance cascade, emit active-set Z-set delta)
        │
        └──→ Δ_active
              │
              ▼
        P^Δ (projection — join Δ_active × acc. index + acc. active × Δ_index)
              │
              ▼
        Δ_facts (accumulated and passed to batch evaluator)
              │
              ▼
        E (BATCH — evaluate(rules, allFacts))  ← Plan 006 replaces with E^Δ
              │
              ▼
        R^Δ (resolution extraction)
              │
              ▼
        K^Δ (skeleton — apply resolution + index deltas to mutable tree)
              │
              ▼
        RealityDelta
```

Each stage is a separate module in `kernel/incremental/`. The pipeline composition
root (`kernel/incremental/pipeline.ts`) wires the DAG.

The batch pipeline (`kernel/pipeline.ts`) is preserved unchanged and serves as the
correctness oracle.

### Out-of-Order Arrival Invariant

CCS constraint stores have no causal delivery guarantees. During sync,
`importDelta()` inserts constraints in whatever order they appear in the delta
array. Two constraints that are causally related (one references the other via
`refs` or `payload.target`) can arrive in either order. A retract can arrive
before its target. A value can arrive before its target structure. A child
structure can arrive before its parent. A non-authority constraint can arrive
before the authority grant that authorizes it.

DBSP's correctness theorem is robust to this: Z-set addition is commutative, so
the accumulated input `s[0] + s[1] + ... + s[t]` is the same regardless of
arrival order. The theorem requires that after each `step()` call, `current()`
equals the batch operator applied to the accumulated input. It does **not**
require any particular arrival ordering.

The implementation consequence is that every stage processing a constraint that
**references** another constraint (by CnId or by peer identity) must handle both
orderings — referrer-first and referent-first:

| Stage | Referrer | Referent | Pattern |
|-------|----------|----------|---------|
| Validity | non-authority constraint | authority grant enabling it | Hold in invalid set; re-check on grant arrival |
| Retraction | retract constraint | target constraint | Record edge in graph; check graph when target arrives |
| Projection | value constraint | target structure | Hold in orphan set; re-project on structure arrival |
| Skeleton | child structure | parent structure | Index children; attach when parent node is created |

The general pattern: when the referrer arrives first, record its effect as a
**standing instruction** indexed by the referent's CnId. When the referent
arrives later, check for standing instructions and apply them. This is not a
patch on DBSP — it is the natural consequence of correctly implementing the
DBSP invariant (`current() == Q_batch(accumulated input)`) in a system without
causal delivery.

The differential test oracle (`solve(store, config)`) implicitly handles all
orderings because the batch pipeline sees the full store simultaneously.

## Phases and Tasks

### Phase 1: Z-Set Foundation ✅

#### Tasks

- 1.1 Create `base/zset.ts` with `ZSet<T>` type and algebraic operations (`zsetEmpty`, `zsetSingleton`, `zsetAdd`, `zsetNegate`, `zsetFromEntries`). ✅
- 1.2 Add query utilities (`zsetIsEmpty`, `zsetSize`, `zsetGet`, `zsetPositive`, `zsetNegative`). ✅
- 1.3 Add mapping/iteration utilities (`zsetForEach`, `zsetMap`, `zsetFilter`). ✅
- 1.4 Export from `base/` barrel. ✅ (No barrel — follows existing `base/` convention of direct imports. Added `zsetElements`, `zsetKeys` convenience functions beyond plan.)

#### Tests

- Z-set algebra: `add` is commutative, associative; `add(a, negate(a)) = empty`; zero-weight entries pruned. ✅
- Singleton fast path: `zsetSingleton` creates a single-entry map. ✅
- `zsetPositive` / `zsetNegative` partition correctly. ✅
- `zsetMap` transforms elements while re-keying. ✅
- 61 tests in `tests/base/zset.test.ts`. 820 total tests passing (759 existing + 61 new).

### Phase 2: Incremental Types and Infrastructure 🔴

#### Tasks

- 2.1 Create `kernel/incremental/types.ts` with `NodeDelta`, `RealityDelta` types (no shared `IncrementalStage` interface — each stage is a concrete module; see Core Type Definitions § Operator Conventions). 🔴
- 2.2 Create `realityDeltaEmpty()` and `realityDeltaFrom(changes)` constructors. 🔴
- 2.3 Create `kernel/incremental/` directory and barrel export (`kernel/incremental/index.ts`). 🔴

#### Tests

- `RealityDelta` construction: empty delta has `isEmpty: true`. 🔴
- `NodeDelta` discriminated union exhaustiveness check. 🔴

### Phase 3: Incremental Retraction 🔴

The retraction stage is the highest-impact kernel stage — the dominance cascade
over the full constraint set is the most expensive batch operation in stores with
retractions. The incremental version maintains the retraction graph as persistent
state and cascades only from the new constraint.

#### Tasks

- 3.1 Create `kernel/incremental/retraction.ts` as a concrete module exporting `step(Δ_valid: ZSet<Constraint>): ZSet<Constraint>`, `current(): Constraint[]`, and `reset(): void`. Internal state (retraction graph, dominance cache, depth cache, accumulated active/dominated sets) is private. 🔴
- 3.2 `step(Δ_valid)`: for each new valid constraint c in the delta: 🔴
  - **If c is not a retract:** Check the accumulated retraction graph for active retractors targeting c. If none exist, c is active — emit `{c: +1}`. If an active retractor exists, c is immediately dominated — emit nothing in Δ_active (c enters the dominated set directly). This handles the out-of-order case where a retract arrived before its target (see Architecture § Out-of-Order Arrival Invariant).
  - **If c is a retract:** Validate structural rules (target-in-refs, no-structure, no-authority). Add edge to graph. If c's target is already in the accumulated set, cascade dominance and emit Z-set delta of all status changes. If c's target has not arrived yet, the edge is recorded as a standing instruction — it will take effect when the target arrives.
- 3.3 Handle the case where a retract constraint itself enters as part of a multi-element Z-set delta (e.g., from authority re-validation emitting multiple newly-valid constraints including a retract). Process all non-retracts first (adding them to the accumulated set), then process retracts (so that edges can find their targets within the same delta). 🔴
- 3.4 `current()`: return the current accumulated active constraint set. 🔴

#### Tests

- Single non-retract insertion: emits `{c: +1}` in active delta. 🔴
- Retract a value: target becomes dominated (`{target: −1}`), retract itself active (`{retract: +1}`). 🔴
- Undo (retract-the-retract): original target re-activates (`{target: +1}`). 🔴
- Depth limit: retract at depth > maxDepth is ignored. 🔴
- Structure immunity: retract targeting structure → violation, no graph change. 🔴
- Authority immunity: retract targeting authority → violation. 🔴
- **Out-of-order: retract before target.** Insert retract R (targeting V) first, then insert V. Verify V is dominated immediately upon arrival, matching batch `computeActive([R, V])`. 🔴
- **Out-of-order: undo before retract.** Insert undo U (targeting R), then insert retract R (targeting V), then insert V. Verify R is dominated (U dominates it), V is active (R's edge exists but R is dominated so V is not affected). Matches batch. 🔴
- **Out-of-order: retract before target in multi-element delta.** Authority re-validation emits `{R: +1, V: +1}` in a single delta where R targets V. Verify V is dominated in the output. 🔴
- Differential: accumulated active set after N insertions equals `computeActive(allValid)`. 🔴

### Phase 4: Incremental Structure Index 🔴

Structure constraints are permanent (never retracted). The structure index is
append-only: each new structure constraint either creates a new SlotGroup or
joins an existing one (map child with same parent+key from another peer).

#### Tasks

- 4.1 Create `kernel/incremental/structure-index.ts` as a concrete module exporting `step(Δ_valid: ZSet<Constraint>): ZSet<SlotGroup>`, `current(): StructureIndex`, and `reset(): void`. Internal state is the mutable `StructureIndex` (private). 🔴
- 4.2 `step(Δ_valid)`: filter to structure constraints; for each, compute slot identity and either create or update SlotGroup. Emit the new/modified SlotGroup as a Z-set delta (always +1 — structure only grows). Update `byId`, `slotGroups`, `structureToSlot`, `roots`, `childrenOf` indexes in place. 🔴
- 4.3 `current()`: return the current accumulated `StructureIndex`. 🔴

#### Tests

- New root structure: creates SlotGroup, appears in `roots`. 🔴
- New map child: creates SlotGroup, appears in `childrenOf` for parent. 🔴
- Duplicate map child (same parent+key, different peer): joins existing SlotGroup. 🔴
- New seq child: creates unique SlotGroup (CnId-keyed). 🔴
- Differential: accumulated index equals `buildStructureIndex(allValid)`. 🔴

### Phase 5: Incremental Projection 🔴

Projection is a bilinear join between the active set and the structure index.
The incremental version handles three cases: new active constraints projected
against the accumulated index, existing orphaned values re-projected when their
target structure arrives, and the cross-term.

#### Tasks

- 5.1 Create `kernel/incremental/projection.ts` as a concrete two-input module exporting `step(Δ_active: ZSet<Constraint>, Δ_index: ZSet<SlotGroup>): ZSet<Fact>`, `current(): Fact[]`, and `reset(): void`. 🔴
- 5.1a Add `factKey(f: Fact): string` to `datalog/types.ts` — deterministic serialization of `predicate + terms` for use as Z-set map key. See Core Type Definitions § Z-Set Key Conventions. 🔴
- 5.2 Maintain an orphaned set: value constraints whose target is not yet in the structure index. When `Δ_index` arrives, check orphans against new structures and emit previously-orphaned facts. 🔴
- 5.3 For `{c: +1}` in `Δ_active` where c is a value: look up target in accumulated index → emit `active_value` fact with weight +1. If target not found, add to orphan set. 🔴
- 5.4 For `{c: −1}` in `Δ_active` where c is a value: emit `active_value` fact with weight −1. Remove from orphan set if present. 🔴
- 5.5 For `{c: +1}` in `Δ_active` where c is a seq structure: emit `active_structure_seq` and `constraint_peer` facts with weight +1. 🔴
- 5.6 For `{c: −1}` in `Δ_active` where c is a seq structure: emit same facts with weight −1. (Seq structures are permanent, so this is defensive only.) 🔴
- 5.7 Accumulate the full set of projected facts (for passing to the batch evaluator during this plan). 🔴

#### Tests

- New value constraint with existing target: emits `active_value` fact. 🔴
- Value constraint with missing target: added to orphan set, no fact emitted. 🔴
- Structure arrives after orphaned value: orphan re-projected, fact emitted. 🔴
- Retracted value (weight −1): anti-fact emitted. 🔴
- New seq structure: emits `active_structure_seq` + `constraint_peer`. 🔴
- Differential: accumulated facts equal `projectToFacts(allActive, index)`. 🔴

### Phase 6: Incremental Validity 🔴

Validity checking is O(1) for non-authority constraints but requires re-evaluating
affected peers when an authority constraint arrives. The current `computeAuthority`
replays from scratch. This phase replaces it with a persistent authority state.

#### Tasks

- 6.1 Create `kernel/incremental/validity.ts` as a concrete module exporting `step(Δ_filtered: ZSet<Constraint>): ZSet<Constraint>`, `current(): Constraint[]`, and `reset(): void`. Internal state (persistent `AuthorityState`, per-peer constraint index, accumulated valid/invalid sets) is private. 🔴
- 6.2 Incremental authority update: when a new authority constraint arrives, update the persistent `AuthorityState` in place. Revoke-wins: a new grant adds a capability, a new revoke removes one. The update path must handle the causal ordering of concurrent grant/revoke correctly — the key insight is that authority constraints are processed in insertion order (which respects causality because refs are validated), so the persistent state can be maintained as an append-only replay with memoized results. 🔴
- 6.3 For non-authority Δc: check signature + capability against accumulated state → emit `{c: +1}` in Δ_valid or record as invalid. O(1). 🔴
- 6.4 For authority Δc: update authority state, then re-check all constraints by the target peer. For each constraint whose validity status changed, emit `{c': +1}` (newly valid) or `{c': −1}` (newly invalid) in Δ_valid. 🔴
- 6.5 `current()`: return the accumulated valid constraint set. 🔴

#### Tests

- Non-authority constraint from authorized peer: emits `{c: +1}`. 🔴
- Non-authority constraint from unauthorized peer: recorded as invalid, nothing in Δ_valid. 🔴
- Authority grant enables previously-invalid constraints: emits `{c': +1}` for each. 🔴
- Authority revoke disables previously-valid constraints: emits `{c': −1}` for each. 🔴
- Concurrent grant+revoke (revoke wins): capability is removed. 🔴
- Creator's constraints always valid (implicit Admin). 🔴
- Differential: accumulated valid set equals `computeValid(allConstraints, creator)`. 🔴

### Phase 7: Incremental Skeleton and Reality Deltas 🔴

The skeleton builder maintains a mutable reality tree and applies deltas from the
resolution stage and structure index stage. It emits `RealityDelta` describing
what changed.

Because the structure index records `childrenOf` entries even when the parent
hasn't arrived yet, the skeleton must handle the child-before-parent case: when
a parent structure arrives, check `childrenOf` for pre-existing children and
attach them (see Architecture § Out-of-Order Arrival Invariant).

#### Tasks

- 7.1 Create `kernel/incremental/skeleton.ts` maintaining a mutable `Reality` tree. 🔴
- 7.2 `applyResolutionDelta(Δ_resolved, Δ_index, Δ_active)`: process resolution changes (new/changed winners, new/removed fugue pairs), structure changes (new nodes), and active-set changes (tombstoned seq elements). Mutate the tree and emit `NodeDelta` entries. 🔴
- 7.3 New map structure → create child node in parent's children map. Emit `childAdded`. If the parent node does not yet exist in the tree (child arrived before parent), defer — the child will be attached when the parent is created (task 7.3a). 🔴
- 7.3a When creating a new node (root or child), check the accumulated structure index (`childrenOf`) for pre-existing children of this node. Recursively attach them and emit `childAdded` for each. This handles the out-of-order case where children arrived before their parent. 🔴
- 7.4 New seq structure → create child node, insert at Fugue-ordered position. Emit `childAdded` (or `childrenReordered` if position changes affect existing children). 🔴
- 7.5 Changed winner → update node's value field. Emit `valueChanged`. 🔴
- 7.6 Removed winner (retraction) → for map, value becomes undefined/null; for seq, element becomes tombstone and is removed from visible children. Emit `valueChanged` or `childRemoved`. 🔴
- 7.7 `current()`: return the accumulated `Reality`. 🔴

#### Tests

- New map container + value: `childAdded` + `valueChanged`. 🔴
- LWW winner change: `valueChanged` with old and new values. 🔴
- Value retraction on map node: `valueChanged` to undefined (or `childRemoved` if no children). 🔴
- Value retraction on seq node: `childRemoved` (tombstone). 🔴
- New seq element: `childAdded` at correct position. 🔴
- **Out-of-order: child before parent.** Insert a map child structure before its parent root structure. When the root arrives, both the root and its pre-existing child appear in the reality. Matches batch. 🔴
- **Out-of-order: grandchild before parent.** Insert grandchild, then child, then root. All three levels appear correctly in the reality once the root arrives. 🔴
- Differential: `current()` equals `solve(store, config)`. 🔴

### Phase 8: Pipeline Composition and Differential Testing 🔴

Wire all stages into the DAG, expose the `IncrementalPipeline` interface, and
run comprehensive differential tests.

#### Tasks

- 8.1 Create `kernel/incremental/pipeline.ts` implementing `IncrementalPipeline`. Wire the DAG: `insert(c)` → store.insert → F^Δ → C^Δ → fan-out(X^Δ, A^Δ) → P^Δ → batch E → R^Δ → K^Δ → RealityDelta. 🔴
- 8.2 `createIncrementalPipeline(config)`: create all stages, wire them, return the pipeline. 🔴
- 8.3 `createIncrementalPipelineFromBootstrap(result)`: create pipeline pre-populated with bootstrap constraints. Each bootstrap constraint is fed through `insert()` to build up accumulated state. 🔴
- 8.4 `recompute()`: call batch `solve(store, config)` and return the result. For differential testing. 🔴
- 8.5 `insertMany()`: process constraints sequentially through `insert()`, accumulate deltas, return combined delta. 🔴
- 8.6 Export `IncrementalPipeline` and construction functions from `kernel/incremental/index.ts` and from `src/index.ts`. 🔴

#### Tests

- **Differential equivalence**: replay every existing integration test scenario through both `IncrementalPipeline` and batch `solve()`. After each insertion, verify `pipeline.current()` deeply equals `solve(store, config)`. This is the core correctness test. 🔴
- **Multi-agent sync**: two incremental pipelines, bidirectional delta exchange, both converge to same reality. 🔴
- **Retraction cascade**: insert value, retract it, undo retraction — verify reality deltas at each step and final state matches batch. 🔴
- **Authority change cascade**: grant capability to peer, peer's queued constraints become valid, reality updates. 🔴
- **Orphaned value resolution**: value constraint arrives before its target structure — structure arrives later, value appears in reality. 🔴
- **Out-of-order sync**: construct a scenario where sync delivers constraints in non-causal order (retract before target, child before parent, value before structure, constraint before enabling grant). Verify incremental pipeline produces same reality as batch after all constraints are inserted. 🔴
- **Bootstrap warm-start**: `createIncrementalPipelineFromBootstrap()` produces the same initial reality as batch `solve()` on the bootstrap store. 🔴
- **Empty delta**: inserting a duplicate constraint produces an empty `RealityDelta`. 🔴

### Phase 9: Documentation and Cleanup 🔴

#### Tasks

- 9.1 Update TECHNICAL.md: add "Incremental Pipeline" section documenting the DAG architecture, Z-set algebra, stage interface, reality deltas, and the relationship to the batch pipeline. Remove or update the "Why Not Incremental Evaluation?" design decision. 🔴
- 9.2 Update README.md: update project status table to show Plan 005 complete, mention incremental pipeline capability in Quick Start or Core Ideas. 🔴
- 9.3 Update `.plans/004-incremental-roadmap.md` to mark Plan 005 as complete. 🔴
- 9.4 Add LEARNINGS.md entries for discoveries during implementation. 🔴

## Transitive Effect Analysis

### The Batch Pipeline Is Preserved — No Backwards Compatibility Risk

The existing `pipeline.ts` (`solve`, `solveFull`) is untouched. All existing
tests continue to use it. The incremental pipeline is a new, parallel code path.
No existing module is modified in a way that could break existing behavior.

### New Module Dependency Chain

```
base/zset.ts                          (leaf — no deps beyond base/types.ts)
     ↑
kernel/incremental/types.ts           (depends on kernel/types.ts, base/zset.ts)
     ↑
kernel/incremental/retraction.ts      (depends on types, base/zset, kernel/retraction types)
kernel/incremental/structure-index.ts (depends on types, base/zset, kernel/structure-index)
kernel/incremental/validity.ts        (depends on types, base/zset, kernel/authority, kernel/validity)
kernel/incremental/projection.ts      (depends on types, base/zset, kernel/projection)
kernel/incremental/skeleton.ts        (depends on types, base/zset, kernel/skeleton types)
     ↑
kernel/incremental/pipeline.ts        (composition root — depends on all above + kernel/store,
                                       kernel/pipeline for batch fallback, datalog/evaluate)
     ↑
kernel/incremental/index.ts           (barrel export)
```

**Direction:** `base → kernel/incremental → (uses kernel/ and datalog/ as libraries)`.
The incremental modules import from the existing kernel modules but do not modify
them. The batch modules have no knowledge of the incremental modules.

### Store Mutation

The `IncrementalPipeline.insert()` method calls `store.insert()` internally,
mutating the store. This means the store is shared state between the incremental
pipeline and any code that holds a reference to it. The `generation` counter
increments on mutation, which is the existing cache-invalidation signal. The
batch pipeline can be called against the same store at any time for verification.

### Export Surface

New exports are added to `src/index.ts`:
- `IncrementalPipeline`, `createIncrementalPipeline`, `createIncrementalPipelineFromBootstrap`
- `RealityDelta`, `NodeDelta`
- `ZSet`, `ZSetEntry`, and Z-set algebra functions
- `factKey` (from `datalog/types.ts`)

No shared `IncrementalStage` interface is exported — each stage is a concrete
module with its own specific API. Existing exports are unchanged.

### Batch Evaluator as Bottleneck

During this plan, the Datalog evaluator is called in batch mode on every
`insert()`. The incremental stages produce accumulated projected facts, which
are passed to `evaluate(rules, allFacts)`. This means the evaluation stage is
still O(|S|) — the kernel stages around it are O(|Δ|). The overall pipeline
is O(|S|) until Plan 006 replaces the batch evaluator with an incremental one.

However, when the native fast path is active (default rules, no custom rules),
the Datalog evaluator is bypassed and native solvers are used instead. The native
solvers are also batch during this plan, but they are much faster than Datalog
(simple comparison / tree walk). Plan 006 will make them incremental as well.

## Testing Strategy

### Unit Tests (per stage)

Each incremental stage has focused unit tests that:
1. Test the delta-in / delta-out behavior for specific constraint types.
2. Verify that accumulated state matches batch computation after N insertions.
3. Test edge cases (orphaned values, authority cascades, retraction chains).

### Differential Tests

The core correctness strategy: after each insertion, compare
`incrementalPipeline.current()` against `solve(store, config)`. This is run
against every scenario from the existing integration tests plus new scenarios
designed to exercise incremental-specific edge cases.

### Existing Tests

All existing tests (currently 759) are expected to pass without modification.
They test the batch pipeline, which is unchanged. The incremental pipeline is
tested by its own test suite plus differential equivalence.

## Directory Structure

```
src/
├── base/
│   ├── zset.ts                  NEW — Z-set type and algebra
│   ├── result.ts
│   └── types.ts
├── kernel/
│   ├── incremental/             NEW — all incremental pipeline code
│   │   ├── index.ts               barrel export
│   │   ├── types.ts               NodeDelta, RealityDelta
│   │   ├── retraction.ts          incremental retraction (concrete module)
│   │   ├── structure-index.ts     incremental structure index (concrete module)
│   │   ├── projection.ts          incremental projection (concrete module)
│   │   ├── validity.ts            incremental validity (concrete module)
│   │   ├── skeleton.ts            incremental skeleton (concrete module)
│   │   └── pipeline.ts            DAG composition root
│   ├── pipeline.ts              UNCHANGED — batch pipeline (correctness oracle)
│   ├── retraction.ts            UNCHANGED
│   ├── validity.ts              UNCHANGED
│   ├── structure-index.ts       UNCHANGED
│   ├── projection.ts            UNCHANGED
│   ├── skeleton.ts              UNCHANGED
│   └── ... (all other kernel modules unchanged)
└── index.ts                     UPDATED — new exports added

tests/
├── base/
│   └── zset.test.ts             NEW
├── kernel/
│   ├── incremental/             NEW
│   │   ├── retraction.test.ts
│   │   ├── structure-index.test.ts
│   │   ├── projection.test.ts
│   │   ├── validity.test.ts
│   │   ├── skeleton.test.ts
│   │   └── pipeline.test.ts       differential equivalence tests
│   └── ... (all existing test files unchanged)
└── integration.test.ts          UNCHANGED
```

## Resources for Implementation

### Primary Theory

- [theory/incremental.md](../theory/incremental.md) — §2 (DAG circuit), §3 (operator classification), §4 (stage interface), §5 (stage-by-stage), §6 (correctness), §10 (reality deltas)

### Existing Code (to read, not modify)

- `kernel/pipeline.ts` — the batch pipeline composition; understand the DAG topology
- `kernel/retraction.ts` — batch `computeActive()`; the incremental version mirrors its logic
- `kernel/validity.ts` + `kernel/authority.ts` — batch validity; the persistent authority structure replaces `computeAuthority()`
- `kernel/structure-index.ts` — batch `buildStructureIndex()`; the incremental version is append-only
- `kernel/projection.ts` — batch `projectToFacts()`; the incremental version adds the orphan set
- `kernel/skeleton.ts` — batch `buildSkeleton()`; the incremental version mutates in place
- `kernel/resolve.ts` — `extractResolution()` and `nativeResolution()`; used as-is by the incremental pipeline
- `kernel/store.ts` — `insert()`, `allConstraints()`, `getGeneration()`
- `bootstrap.ts` — `createReality()`, `BOOTSTRAP_CONSTRAINT_COUNT`

### DBSP Paper

- §2: Streams and stream operators (the foundational model)
- §3: Incremental view maintenance over Z-sets
- §4: Recursive queries and semi-naive evaluation
- Proposition 4.3: Chain rule `(Q₁ ∘ Q₂)^Δ = Q₁^Δ ∘ Q₂^Δ`

## Alternatives Considered

### Mutable batch pipeline with caching

Instead of a separate incremental pipeline, modify the batch pipeline to cache
intermediate results and invalidate based on the `generation` counter. Rejected
because: (a) cache invalidation is all-or-nothing — a single insertion invalidates
everything; (b) the batch functions are pure and the incremental stages are
inherently stateful — mixing these concerns in one module violates SRP; (c) the
batch pipeline is the correctness oracle and should remain untouched.

### Event-sourced stages (constraint stream → state)

Model each stage as a reducer `(state, constraint) → state` without Z-sets.
Rejected because: (a) retraction cascades produce multi-element deltas (a single
retract can change the status of multiple constraints) — a single-constraint
reducer can't express this; (b) Z-sets compose algebraically (the chain rule),
ad-hoc deltas do not; (c) the Z-set foundation is shared with Plan 006
(incremental Datalog), so building it now avoids duplication.

### Incremental Datalog first

Build the incremental Datalog evaluator (Plan 006) before the kernel stages.
Rejected because: (a) the kernel stages are simpler and provide immediate value
(even with batch Datalog, the kernel stages are O(|Δ|)); (b) the Z-set type
and stage interface need to be validated on simpler stages before tackling the
Datalog evaluator's complexity; (c) the kernel stages are the foundation that
Plan 006 plugs into — building them first provides the scaffolding.

## Learnings

### DBSP Is Robust to Arrival Order — But Implementations Must Be Explicit

The DBSP chain rule and circuit incrementalization theorem hold regardless of
the order in which elements arrive in the input stream, because Z-set addition
is commutative. The theorem's correctness invariant (`current() == Q_batch(Σ inputs)`)
is order-independent by construction.

However, a naive implementation of any stage that processes a constraint referencing
another constraint can silently violate the invariant if it assumes the referent
has already been seen. The pattern is always the same: the referrer arrives, the
stage makes a decision based on the *absence* of the referent in accumulated state,
and that decision is wrong (it would be different if the referent were present).

Every such stage needs a two-phase approach: (1) when the referrer arrives first,
record its effect as a standing instruction indexed by the referent's CnId;
(2) when the referent arrives later, check for standing instructions. This applies
to validity (invalid set as pending queue), retraction (graph edges as standing
dominance), projection (orphan set), and skeleton (deferred children).

The differential test oracle catches all such bugs mechanically — but designing
the stages correctly upfront avoids discovering them one test failure at a time.

### Authority Incrementalization Is Simpler Than It Appears

The batch `computeAuthority()` replays all authority constraints from scratch,
which sounds expensive to replace. But the actual resolution logic is a per-key
max-Lamport accumulator with a revoke-wins tiebreak at the top Lamport. This is
trivially incremental: maintain a map of `(targetPeer, capabilityKey) → { maxLamport, action }`,
compare the new authority constraint's Lamport to the existing max, and update if
higher (or equal and revoke). The design-intensive part is not the authority state
update — it's the re-checking of affected peer's constraints when capabilities change.

## Changeset

- **New files:** `base/zset.ts`, `kernel/incremental/types.ts`,
  `kernel/incremental/retraction.ts`, `kernel/incremental/structure-index.ts`,
  `kernel/incremental/projection.ts`, `kernel/incremental/validity.ts`,
  `kernel/incremental/skeleton.ts`, `kernel/incremental/pipeline.ts`,
  `kernel/incremental/index.ts`
- **New test files:** `tests/base/zset.test.ts`,
  `tests/kernel/incremental/retraction.test.ts`,
  `tests/kernel/incremental/structure-index.test.ts`,
  `tests/kernel/incremental/projection.test.ts`,
  `tests/kernel/incremental/validity.test.ts`,
  `tests/kernel/incremental/skeleton.test.ts`,
  `tests/kernel/incremental/pipeline.test.ts`
- **Modified files:** `src/index.ts` (new exports), `TECHNICAL.md`, `README.md`,
  `LEARNINGS.md`, `.plans/004-incremental-roadmap.md`
- **No files deleted.**
- **No existing files modified in ways that affect behavior.**