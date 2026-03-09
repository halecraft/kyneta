# Prism Technical Documentation

## Overview

Prism implements **Convergent Constraint Systems (CCS)** — a framework for collaborative state where constraints are the source of truth and state is derived through deterministic solving. The implementation follows the [Unified CCS Engine Specification](./theory/unified-engine.md).

## Engine Architecture

The engine has exactly two mandatory components (§B.1):

**Layer 0 Kernel** (§B.2): Mechanical algorithms — constraint storage, set union merge, CnId generation, Lamport clocks, ed25519 signatures, authority/validity computation, retraction graph and dominance, version vectors, tree skeleton construction. Given the same store, any two correct implementations produce identical results.

**Datalog Evaluator** (§B.3): Stratified, bottom-up, semi-naive fixed-point evaluation with aggregation. Evaluates rule constraints from the store over facts derived from active constraints. LWW and Fugue are Datalog rules that travel in the store — they are not hardcoded algorithms.

**Native Solvers** (§B.7, optional): Host-language LWW and Fugue implementations as performance optimizations. Must produce identical results to the Datalog rules they replace. Activate only when active rules match known default patterns.

### Key Insight: Rules as Data

LWW value resolution and Fugue sequence ordering are not part of the engine. They are `rule` constraints asserted at reality creation (bootstrap) that travel in the store like any other constraint. An agent with `CreateRule` + `Retract` capabilities can retract the default rules and assert a custom resolution strategy — the reality changes, but no agent updates its code.

---

## Solver Pipeline (§7.2)

The pipeline is a composition of pure functions, each in its own module. `pipeline.ts` is the composition root — it contains no transformation logic itself.

```
Constraint Store (S), Version Vector (V)
    │
    ▼
S_V = filterByVersion(S, V)          // version-vector.ts — filter to causal moment V
    │
    ▼
Valid(S_V) = computeValid(S_V)        // validity.ts — signature + capability check
    │
    ├──→ AllStructure(Valid(S_V))
    │         │
    │         ▼
    │    buildStructureIndex()         // structure-index.ts — slot identity, parent→child
    │
    └──→ Active(Valid(S_V))
              │
              ├──→ projectToFacts()    // projection.ts — active constraints → Datalog facts
              │         │
              │         ▼
              │    evaluate(rules, facts)  // datalog/evaluate.ts — primary resolution
              │         │
              │         ▼
              │    extractResolution()     // resolve.ts — Datalog facts → typed winners/ordering
              │
              └──→ [native fast path]     // §B.7: if rules match defaults, bypass Datalog
                        │
                        ▼
                   buildSkeleton()         // skeleton.ts — reality tree from ResolutionResult
                        │
                        ▼
                     Reality
```

**Datalog evaluation is the primary resolution path** (§B.1). Native solvers are an optional §B.7 fast path that activates only when the active rules structurally match known default patterns. When rules are retracted, replaced, or augmented with custom Layer 2+ rules, the pipeline falls back to Datalog evaluation automatically.

### Pipeline Design Principles

1. **Structure index from Valid, not Active.** The spec's pipeline forks at `Valid(S_V)`: one branch takes all valid structure constraints (immune to retraction), the other takes active constraints for value resolution. The code matches this two-path design.

2. **The skeleton builder is resolution-agnostic.** It receives a `ResolutionResult` (from either Datalog or native solvers) and builds the tree without knowing which path produced it.

3. **`resolve.ts` is the symmetric counterpart of `projection.ts`.** Projection converts kernel types → Datalog facts. Resolution converts Datalog facts → kernel types. The two modules are the boundary between the kernel and Datalog worlds.

---

## Constraint Types (§2)

Six kernel-level constraint types, represented as a TypeScript discriminated union on `type`:

| Type | Payload | Retractable? | Purpose |
|------|---------|-------------|---------|
| `structure` | `Root { containerId, policy }` / `Map { parent, key }` / `Seq { parent, originLeft, originRight }` | Never | Permanent node in the reality tree |
| `value` | `{ target: CnId, content: Value }` | Yes | Content at a node |
| `retract` | `{ target: CnId }` | Yes (enables undo) | Asserts a constraint should be dominated |
| `rule` | `{ layer, head: Atom, body: BodyElement[] }` | Yes | Datalog rule for solver evaluation |
| `authority` | `{ targetPeer, action, capability }` | Via revocation | Capability grant/revoke |
| `bookmark` | `{ name, version: VersionVector }` | Yes | Named point in causal time |

Every constraint carries:
- `id: CnId` — globally unique `(peer, counter)` pair
- `lamport: number` — Lamport timestamp for causal ordering
- `refs: CnId[]` — causal predecessors (frontier-compressed)
- `sig: Uint8Array` — ed25519 signature (stub: always valid)

### Value Domain (§3)

```typescript
type Value =
  | null          // absence (map deletion via LWW)
  | boolean
  | number        // IEEE 754 f64
  | bigint        // arbitrary-precision integer (distinct from number)
  | string
  | Uint8Array    // raw binary (logically immutable)
  | { ref: CnId } // reference to a structure constraint
```

`number` and `bigint` are distinct types that never unify: `int(3n) ≠ float(3.0)`. This prevents precision-loss bugs across language boundaries (JavaScript f64 vs Rust i64).

---

## Slot Identity (§8)

Slot identity determines how constraints map to positions in the reality tree. It is Layer 0 kernel logic — not expressible as a retractable rule.

| Policy | Slot Identity | Why |
|--------|--------------|-----|
| **Map child** | `map:<parentCnIdKey>:<key>` | Context-free identity. Two peers independently creating `structure(map, parent=P, key=K)` get different CnIds but represent the **same logical slot**. |
| **Seq child** | `seq:<ownCnIdKey>` | Causally-bound identity. Each element's CnId is unique — no two elements compete for the same slot. |
| **Root** | `root:<containerId>` | Named top-level container. |

The **Map multi-structure case** is the key subtlety. When Alice creates `structure(map, parent=root@0, key="title")` → `alice@1` and Bob independently creates the same → `bob@1`, their value constraints compete for the same slot via LWW. The `structure-index.ts` module groups them by `(parent, key)`, and `projection.ts` emits both values with the same `Slot` column in the `active_value` relation.

---

## Projection: Constraints → Datalog Facts

`projection.ts` performs a join between active value constraints and the structure index, emitting ground facts with pre-computed slot identity:

| Relation | Columns | Purpose |
|----------|---------|---------|
| `active_value(CnId, Slot, Content, Lamport, Peer)` | 5 | LWW rules group by Slot, pick winner by (Lamport, Peer) |
| `active_structure_seq(CnId, Parent, OriginLeft, OriginRight)` | 4 | Fugue rules build tree structure |
| `constraint_peer(CnId, Peer)` | 2 | Peer tiebreak in Fugue sibling ordering |

Values targeting unknown structures (orphaned) are excluded from projection but tracked in `ProjectionResult.orphanedValues` for diagnostics.

---

## Default Solver Rules (§B.4)

### LWW (3 rules)

```
superseded(CnId, Slot) :-
  active_value(CnId, Slot, _, L1, _),
  active_value(CnId2, Slot, _, L2, _),
  CnId ≠ CnId2, L2 > L1.

superseded(CnId, Slot) :-
  active_value(CnId, Slot, _, L1, P1),
  active_value(CnId2, Slot, _, L2, P2),
  CnId ≠ CnId2, L2 == L1, P2 > P1.

winner(Slot, CnId, Value) :-
  active_value(CnId, Slot, Value, _, _),
  not superseded(CnId, Slot).
```

Higher lamport wins. Peer ID breaks ties (lexicographically greater wins). The `winner` relation picks the sole survivor per slot via stratified negation over `superseded`.

### Fugue (8 rules, 3 predicates)

| Predicate | Rules | Purpose |
|-----------|-------|---------|
| `fugue_child` | 1 | Derives tree structure from `active_structure_seq` + `constraint_peer` |
| `fugue_descendant` | 2 (base + transitive) | Transitive closure of the originLeft tree |
| `fugue_before` | 5 | Parent-before-child, sibling-by-peer, sibling-by-CnId-on-tie, subtree propagation, transitivity |

The critical rule is **subtree propagation**: "if A is a child of X, and X is before B, then A is before B" — but only when B is NOT a descendant of X. Without the `not fugue_descendant(P, B, X)` guard, parent-child ordering combined with propagation creates spurious orderings among siblings. Stratified negation handles this cleanly: `fugue_descendant` depends only on `fugue_child` (a base relation) — no cyclic dependency with `fugue_before`.

### Canonical Source

Both rule sets are defined in `src/bootstrap.ts` and exported as `buildDefaultLWWRules()`, `buildDefaultFugueRules()`, and `buildDefaultRules()`. These are the single source of truth — test files import from bootstrap rather than defining their own copies.

---

## Native Solvers (§B.7)

Native TypeScript implementations that bypass Datalog when the active rules match known default patterns.

**Detection**: `isDefaultRulesOnly()` in `kernel/rule-detection.ts` performs structural matching on rule head/body shapes (not CnIds or lamport values). It checks for `superseded`/`winner` heads reading from `active_value` (LWW) and `fugue_child`/`fugue_before` heads reading from `active_structure_seq` (Fugue). When both patterns match and no Layer 2+ rules exist, native solvers activate. `selectResolutionStrategy()` encapsulates the full decision tree as a pure function.

**Batch LWW** (`solver/lww.ts`): Groups value entries by slot, picks winner by `(lamport DESC, peer DESC)`. O(n) in active value count.

**Batch Fugue** (`solver/fugue.ts`): Tree-based sequence ordering. Builds a tree where each element is a child of its `originLeft`, sorts siblings by Fugue interleaving rules (same `originRight` → lower peer first), depth-first traversal produces total order. O(n log n).

**Incremental LWW** (`solver/incremental-lww.ts`): Per-slot winner tracking. Maintains `Map<slotId, { entries, winner }>`. On insertion, O(1) comparison against current winner. On retraction, O(entries) recomputation for the affected slot only. Emits `ZSet<ResolvedWinner>` deltas.

**Incremental Fugue** (`solver/incremental-fugue.ts`): Per-parent tree maintenance. Correlates `active_structure_seq` and `constraint_peer` facts (may arrive in either order), then recomputes Fugue ordering for the affected parent only using `orderFugueNodes`. Emits `ZSet<FugueBeforePair>` deltas.

**Equivalence**: Batch native solvers are verified against the Datalog rules in `tests/solver/lww-equivalence.test.ts` and `tests/solver/fugue-equivalence.test.ts` (23 Fugue test cases). Incremental native solvers are verified against batch natives via permutation and differential tests.

---

## Authority & Validity (§5)

### Authority Model

- The reality creator holds implicit Admin capability.
- Capabilities propagate via `authority` constraints (grant/revoke).
- Concurrent grant and revoke → revoke wins (conservative).
- Capability attenuation: you can only grant capabilities you hold.
- Authority constraints are immune to retraction (revocation is the dedicated mechanism).

### Validity Filter

`computeValid()` checks every constraint:
1. **Signature** — verifies against `id.peer` (stub: always valid for now)
2. **Capability** — asserting peer must hold the required capability at the constraint's causal moment

Invalid constraints remain in the store for auditability but are excluded from solving. This means multi-agent workflows **must** include authority grants before the second agent creates constraints, or those constraints will be silently filtered.

---

## Retraction & Dominance (§6)

Retraction is an assertion, not removal. A `retract` constraint targets another constraint's CnId and asserts it should be dominated.

### Rules

- **Target must be in refs** (causal safety) — interpreted semantically: a ref `(peer, N)` means "I've observed all of peer's constraints 0..N." This is compatible with the Agent's frontier-compressed refs.
- **Structure constraints are immune** — the skeleton only grows.
- **Authority constraints are immune** — revocation is the dedicated mechanism.
- **Depth limit** (default 2): retract a value (depth 1), retract-the-retract to undo (depth 2).

### Dominance Computation

Memoized reverse topological traversal:
- No retractors → active
- Any active retractor → dominated
- All retractors themselves dominated → active (un-retraction / undo)

---

## Bootstrap (§B.8)

`createReality()` in `bootstrap.ts` emits the initial constraint set for a new reality:

1. **Admin grant** — `authority` constraint granting Admin to the creator (counter 0)
2. **LWW rules** — 3 `rule` constraints at Layer 1 (counters 1–3)
3. **Fugue rules** — 8 `rule` constraints at Layer 1 (counters 4–11)

Total: 12 bootstrap constraints, all from the creator peer.

Bootstrap constructs Layer 1 rule constraints **directly** (not through `Agent.produceRule()`, which enforces `layer >= 2` for user-facing rules). This is architecturally correct: Layers 0–1 are kernel-reserved (§14), and bootstrap is the kernel itself setting up initial state.

The returned `BootstrapResult` includes:
- A pre-populated `ConstraintStore`
- A ready-to-use `Agent` (counter and lamport advanced past bootstrap constraints)
- A `PipelineConfig` with the creator and default retraction depth

---

## Reality Tree (§7.3)

The skeleton builder produces a `Reality` with a synthetic root node (`__reality__@0`, policy `map`) whose children are the top-level containers keyed by `containerId`.

```typescript
interface RealityNode {
  id: CnId;               // representative structure constraint's CnId
  policy: Policy;          // 'map' | 'seq'
  children: Map<string, RealityNode>;  // key = map key or seq index ("0", "1", ...)
  value: Value | undefined;            // LWW-resolved content
}
```

- **Map children**: Keyed by the user-provided map key string. Null-valued keys with no sub-children are excluded (null = deleted).
- **Seq children**: Keyed by positional index ("0", "1", "2"). Elements without an active value (tombstones from value retraction) are excluded from visible children but remain in the ordering tree.

---

## Datalog Evaluator

### Batch Implementation

~1000 lines of TypeScript with zero external dependencies across 5 modules:

| Module | Purpose |
|--------|---------|
| `types.ts` | Atoms, terms (const, var, wildcard), rules, facts, `Relation`, `Database` |
| `unify.ts` | Variable binding, substitution, term matching, guard evaluation |
| `stratify.ts` | Dependency graph, SCC detection, stratum ordering |
| `evaluate.ts` | Bottom-up semi-naive fixed-point evaluation |
| `aggregate.ts` | min, max, count, sum over groups |

`Relation` is backed by `Map<string, FactTuple>` — a single collection serving both O(1) dedup (`has`/`add`) and ordered iteration (`tuples()`). The `remove()` method (used only by the incremental evaluator's DRed phase) is O(1) via `Map.delete`. `Database` delegates to `Relation` per predicate, adding `removeFact()` for the same purpose. The batch evaluator never calls `remove` or `removeFact`.

### Incremental Implementation

`datalog/incremental-evaluate.ts` (~870 LOC) implements cross-time incremental Datalog evaluation following DBSP §4–5. It maintains a persistent `Database` across outer time steps — the same `Database` class the batch evaluator uses. The batch evaluator's per-rule functions (`evaluateRule`, `evaluateRuleSemiNaive`, etc.) are called directly with no adapters.

**Two nested loops:**
- **Outer (cross-time):** Each constraint insertion is one time step. Between steps, the accumulated `Database` persists.
- **Inner (intra-time):** Within one step, semi-naive fixed-point iteration runs from the input delta.

**Monotone strata** (no negation): Initial pass evaluates all rules against the full db, then semi-naive iterates from the initial delta. New derivations are merged into the accumulated db. No facts are ever removed.

**Negation/aggregation strata** (DRed): Delete all derived facts for the stratum, then re-evaluate to a fixed point. This wipe-and-recompute approach is simpler than provenance tracking and efficient because negation strata are bounded by the number of slots/parents, not the total constraint count. Also used for monotone strata when the input delta contains retractions (weight −1).

**Resolution extraction:** Converts `ZSet<Fact>` of `winner`/`fugue_before` deltas to `ZSet<ResolvedWinner>` + `ZSet<FugueBeforePair>`. Handles the winner replacement problem: when a winner changes, +1 and −1 entries for the same slotId would cancel under `zsetMap`. Instead, groups by slotId and applies replacement semantics (emit only +1 for changed winners).

**Rule changes:** On `deltaRules`, restratifies and recomputes all derived facts from accumulated ground facts.

### Key Features

- **Stratified negation**: `not` in rule bodies, safe via stratum ordering (cyclic negation rejected with error)
- **Aggregation**: `min`, `max`, `count`, `sum` — required for LWW (`max` by lamport)
- **Guards**: Typed comparison operators (`eq`, `neq`, `lt`, `gt`, `lte`, `gte`) that filter substitutions without introducing predicate dependencies
- **Wildcards**: `_` matches any value without binding — each occurrence independent
- **Semi-naive evaluation**: Processes deltas rather than recomputing from scratch at each iteration

### Why TypeScript, Not WASM

Evaluated Rust WASM crates (ascent, datafrog, crepe) and npm packages (datascript, @datalogui/datalog). Rejected because:
- Rust proc-macro crates expand rules at compile time — can't evaluate rules-as-data at runtime
- datafrog has no negation or aggregation
- WASM FFI overhead (~100-200ns per boundary crossing) is significant for many small facts
- The native solver optimization (§B.7) means the Datalog evaluator handles only the general case; hot paths bypass it

---

## Store & Sync

### Constraint Store (§4)

A CnId-keyed `Map<string, Constraint>`. Insert is O(1) with idempotent deduplication. The store grows monotonically. Merge is set union — commutative, associative, idempotent.

The `generation` counter increments on every mutation and serves as the cache-invalidation signal. Callers that cache solved results check the generation, not the store reference.

### Delta Sync (§15)

```typescript
// Export constraints the other peer hasn't seen
const delta = exportDelta(myStore, theirVersionVector);

// Import received constraints
importDelta(myStore, delta);  // mutates in place
```

After bidirectional exchange, both stores contain the same constraints → same reality. No ordering or deduplication guarantees needed from the transport — the semilattice handles both.

### Version-Parameterized Solving (§7.1)

```typescript
solve(store, config)          // current reality (all constraints)
solve(store, config, version) // historical reality at version V
```

Time travel is not a special mode. The solver is a pure function; the same `(S, V)` always produces the same reality.

---

## Incremental Pipeline (Plan 005 complete, Plan 006 complete)

The batch `solve()` is O(|S|) per insertion. The incremental pipeline is O(|Δ|) end-to-end — all stages including evaluation are incremental. For the common case (default LWW/Fugue rules), native incremental solvers handle resolution in O(1) per slot. For custom rules, the incremental Datalog evaluator handles resolution with DRed bounded by slot/parent count per step.

### Z-Sets

A Z-set over a universe U is a function `w: U → Z` with finite support. Elements with weight +1 are present; weight −1 are retracted; weight 0 are pruned. Addition is pointwise, negation flips weights. This forms an abelian group — the algebraic foundation for DBSP incremental view maintenance.

Implementation: `base/zset.ts`. `ZSet<T> = ReadonlyMap<string, ZSetEntry<T>>`, keyed by caller-provided string identity. Core algebra: `zsetAdd`, `zsetNegate`, `zsetSingleton`, `zsetEmpty`.

### Not Everything Is a Z-Set

The structure index is append-only (structure constraints are permanent, never retracted). Its output uses `StructureIndexDelta` — a plain map of new/modified `SlotGroup`s with upsert semantics — rather than `ZSet<SlotGroup>`. The reason: a `SlotGroup` has stable identity (`slotId`) but mutable contents (its `structures` array grows when a second peer creates the same map child). Emitting `{old: −1, new: +1}` for the same key would annihilate to zero under `zsetAdd`; emitting only `+1` would inflate weights on accumulation. Neither is correct. The structure index is a monotone operator on a semilattice, not a group operator on Z-sets.

### Incremental DAG

```
Δc ──→ dedup guard (hasConstraint?) ──→ store.insert
  │
  ▼
  C^Δ (validity)              → ZSet<Constraint>
  │
  ├──→ X^Δ (structure index)  → StructureIndexDelta
  │
  └──→ A^Δ (retraction)       → ZSet<Constraint>
        │
        ▼
  P^Δ (projection)            → ZSet<Fact>
        │
        ▼
  E^Δ (evaluation)            → ZSet<ResolvedWinner> + ZSet<FugueBeforePair>
        │                        (native LWW/Fugue or incremental Datalog)
        ▼
  K^Δ (skeleton)              → RealityDelta
```

Each stage follows three conventions: `step(...deltas)` processes input and returns output delta; `current()` returns the full materialized output; `reset()` clears state. The correctness invariant is `current() == Q_batch(accumulated inputs)`.

### Pipeline Composition (`incremental/pipeline.ts`)

The `IncrementalPipeline` interface is the public entry point: `insert(c)` accepts a constraint and returns a `RealityDelta`. Internally it wires all stages into the DAG above and adds a deduplication guard (`hasConstraint` before `store.insert`).

`createIncrementalPipelineFromBootstrap(result)` creates a pipeline pre-populated with bootstrap state by replaying all bootstrap constraints through `insert()`.

The pipeline composition root is pure wiring — ~70 LOC connecting stages and routing deltas. All strategy complexity (native vs Datalog, rule detection, diffing) is encapsulated inside the evaluation stage.

### Evaluation Stage (`incremental/evaluation.ts`)

The evaluation stage is a **strategy wrapper**, not a simple DBSP operator. It delegates to either native incremental solvers (LWW + Fugue) or the incremental Datalog evaluator based on active rules. Its `step()` takes `(deltaFacts, deltaRules, getAccumulatedFacts, getActiveConstraints)` — the lazy getters are only called on strategy switches (bootstrapping the new strategy from accumulated facts).

**Strategy switching:** When a `rule` constraint is added or retracted, the stage re-checks `selectResolutionStrategy`. If the strategy changes:
1. The new strategy is bootstrapped from accumulated ground facts.
2. A diff between old and new strategy's resolution is emitted.
3. `deltaFacts` from the same step are processed through the newly-active strategy and combined with the switch diff.

**Native path** (>99% common case): Routes facts by predicate to `IncrementalLWW` and `IncrementalFugue`. No calls to `projection.current()` or `retraction.current()` — fully O(|Δ|).

**Datalog path** (custom rules): Delegates to `IncrementalDatalogEvaluator`. Also O(|Δ|) per step, with DRed bounded by slot/parent count for negation strata.

`ResolutionResult` is no longer the inter-stage type between evaluation and skeleton — `ZSet<ResolvedWinner>` + `ZSet<FugueBeforePair>` are. `ResolutionResult` remains as a materialization convenience for `current()` and strategy-switch diffing.

### Operator Stages

| Stage | Module | Input(s) | Output | Key design |
|-------|--------|----------|--------|------------|
| Validity | `incremental/validity.ts` | `ZSet<Constraint>` | `ZSet<Constraint>` | Cached `AuthorityState` with full replay on authority changes; per-peer constraint index for targeted re-checking; holds invalid constraints for out-of-order grant arrival |
| Retraction | `incremental/retraction.ts` | `ZSet<Constraint>` | `ZSet<Constraint>` | Persistent retraction graph; two-pass delta processing (non-retracts first); deferred immunity checks for out-of-order arrival |
| Structure Index | `incremental/structure-index.ts` | `ZSet<Constraint>` | `StructureIndexDelta` | Mutable `SlotGroup` builders; append-only; dedup by CnId |
| Projection | `incremental/projection.ts` | `ZSet<Constraint>` × `StructureIndexDelta` | `ZSet<Fact>` | Orphan set (dual-indexed by target key and own key); resolves when target structure arrives |
| Evaluation | `incremental/evaluation.ts` | `ZSet<Fact>` × `ZSet<Rule>` | `ZSet<ResolvedWinner>` × `ZSet<FugueBeforePair>` | Strategy wrapper: native incremental solvers or incremental Datalog; lazy getters for strategy-switch bootstrapping |
| Skeleton | `incremental/skeleton.ts` | `ZSet<ResolvedWinner>` × `ZSet<FugueBeforePair>` × `StructureIndexDelta` | `RealityDelta` | Mutable tree with path tracking; deferred child attachment for out-of-order; seq ordering via accumulated fugue pairs + topological sort |

### Out-of-Order Arrival

CCS stores have no causal delivery guarantees. A retract can arrive before its target; a value before its target structure; a constraint before its enabling authority grant. Every stage that processes a constraint referencing another handles both orderings via standing instructions: when the referrer arrives first, record its effect; when the referent arrives, check for standing instructions. The differential test oracle (`solve(store, config)`) catches all order-dependent bugs mechanically.

| Stage | Referrer | Referent | Standing instruction |
|-------|----------|----------|---------------------|
| Validity | non-authority constraint | authority grant | Hold in invalid set; re-check on grant arrival via per-peer index |
| Retraction | retract constraint | target constraint | Record edge in graph; cascade when target arrives |
| Projection | value constraint | target structure | Hold in orphan set (dual-indexed); project when structure arrives |
| Skeleton | child structure | parent structure | `nodeBySlot` stores node; `attachDeferredChildren` connects when parent created |
| Skeleton | winner | structure (slot) | `accWinners` stores winner; applied when structure node created |

### Validity: Authority Cascade via Full Replay

Authority constraints are rare (single-digit count per reality) but their effects cascade transitively — revoking Admin from peer A invalidates grants A made to peer B. Rather than tracking a dependency DAG, the validity stage replays `computeAuthority()` over all accumulated authority constraints when any authority constraint arrives, then diffs the old vs. new `AuthorityState` to find affected peers. A per-peer constraint index (`Map<PeerID, Set<CnIdKey>>`) enables O(constraints-by-peer) re-checking rather than scanning all constraints.

### Skeleton: Mutable Tree with NodeDelta Emission

The skeleton is the most complex incremental stage. It maintains a mutable reality tree (`MutableNode` type with `nodeBySlot` and `parentBySlot` indexes), processes three input streams, and emits `NodeDelta` entries. Seq children are ordered by accumulated `fugue_before` pairs via `topologicalOrderFromPairs`; retracted seq elements become tombstones (structurally present for ordering, invisible to consumers).

**Map child visibility rule (must match batch exactly):** A map child node is visible in the parent's `children` map unless `value === null && children.size === 0`. This means nodes with `value === undefined` (structure exists but no value constraint resolved yet) *are* visible — `undefined` means "no value yet," while `null` is the LWW deletion sentinel. Retracting a winner sets the value to `undefined`, so the node stays visible and emits `valueChanged`; only an explicit `null` LWW winner triggers `childRemoved`. This matches the batch `buildMapChildren` exclusion rule: `if (node.value === null && node.children.size === 0) continue`.

---

## Module Dependency DAG

```
base/result.ts, base/types.ts, base/zset.ts  (leaves — no deps)
         ↑
datalog/types.ts → evaluate.ts               (Datalog layer — batch)
               → incremental-evaluate.ts      (Datalog layer — incremental, Plan 006)
         ↑
kernel/types.ts → cnid, lamport, vv,         (kernel identity/store layer)
  store, agent, signature
         ↑
authority.ts → validity.ts → retraction.ts    (filters)
         ↑
structure-index.ts → projection.ts            (kernel → Datalog bridge)
                   → resolve.ts               (Datalog → kernel bridge)
                   → skeleton.ts              (tree builder)
         ↑
rule-detection.ts                             (shared strategy selection, Plan 006)
native-resolution.ts                          (shared native resolution, Plan 006)
         ↑
pipeline.ts                                   (batch composition root)
         ↑
bootstrap.ts                                  (reality creation)

solver/
  lww.ts, fugue.ts                            (batch native solvers)
  incremental-lww.ts                          (incremental LWW, Plan 006)
  incremental-fugue.ts                        (incremental Fugue, Plan 006)

kernel/incremental/                           (incremental pipeline)
  types.ts → retraction.ts                    (depends on kernel/ + base/zset)
           → structure-index.ts
           → projection.ts
           → validity.ts                      (depends on kernel/authority)
           → evaluation.ts                    (depends on solver/incremental-*,
                                                datalog/incremental-evaluate,
                                                kernel/rule-detection)
           → skeleton.ts                      (depends on kernel/resolve, structure-index)
           → pipeline.ts                      (incremental composition root — depends on
                                                all above + kernel/store, kernel/pipeline)
  index.ts                                    (barrel export)
```

Dependency direction: `base → datalog → solver → kernel → pipeline → bootstrap`. The incremental modules import from existing kernel modules but do not modify them. The batch pipeline has no knowledge of the incremental modules. No batch evaluator calls remain in the incremental pipeline — all paths are incremental.

---

## Agent (§B.5)

The Agent is the **imperative shell** — the only place where mutable state lives during normal operation:

- **PeerID**: Unique identity
- **Counter**: Monotonically increasing, allocated per constraint
- **Lamport clock**: `max(local, max_received) + 1`
- **Version vector**: Tracks observed constraints (frontier-compressed refs)
- **Private key**: For signing (stub for now)

All `produce*` methods return immutable `Constraint` values. The Agent enforces:
- `layer >= 2` for rule constraints (Layers 0–1 are kernel-reserved)
- Safe-integer bounds on counter and lamport (`<= 2^53 - 1`)
- Refs computed **before** VV update (a constraint can't reference itself)

**Important**: `agent.observe(constraint)` must be called after inserting a constraint to update the agent's version vector and lamport clock. Missing this call breaks causal chains (refs won't include the previous constraint).

---

## Stratification (§14)

| Layer | What | Retractable? |
|-------|------|-------------|
| **0 — Kernel** | CnId, Lamport, signatures, authority, validity, retraction, skeleton | Hardcoded |
| **1 — Default Solver Rules** | LWW, Fugue (emitted by bootstrap) | Yes |
| **2 — Configurable Rules** | Custom resolution, schema mappings, cross-container constraints | Yes |
| **3+ — User Queries** | Application-specific derived relations, views, aggregations | Yes |

Layers 0–1 are the engine. Layers 2+ are data in the store.

---

## Design Decisions

### Why CnId-Based Addressing, Not Path-Based?

The v0 prototype used paths (`["profile", "name"]`). CnId-based addressing (`{peer, counter}` + causal `refs`) enables:
- Retraction (target a specific constraint, not a path)
- Authority (capabilities per peer, not per path)
- Version-parameterized solving (filter by VV, not by timestamp)
- No path-canonicalization bugs

### Why Discriminated Unions for Constraints?

A `Constraint` interface with `type: string` and `payload: any` would compile, but nothing prevents a `type: 'retract'` constraint from carrying a `ValuePayload`. The discriminated union (`type` narrows `payload` in switch/if) eliminates this class of bugs at compile time and gives exhaustive switch checking.

### Why Separate Projection and Resolution Modules?

The skeleton builder should not depend on Datalog types. `projection.ts` sits at the kernel→Datalog boundary (kernel types → flat fact tuples). `resolve.ts` sits at the Datalog→kernel boundary (derived fact tuples → typed winners/ordering). The skeleton reads only kernel-typed `ResolutionResult`, not `Database` or `Relation`.

### Incremental Pipeline: Why a Parallel Code Path?

The batch `solve()` pipeline is preserved unchanged as the correctness oracle. The incremental pipeline (`kernel/incremental/`) is a separate, parallel code path that maintains persistent state and propagates Z-set deltas. This avoids mixing pure batch functions with inherently stateful incremental operators, and lets differential tests compare `incrementalPipeline.current()` against `solve(store, config)` after every insertion. The batch pipeline is never modified — only consumed as a library by the incremental stages.

### Why `number` and `bigint` Are Distinct?

JavaScript's `number` is f64, which can only exactly represent integers up to 2^53 − 1. A Rust agent storing a 64-bit database row ID would lose precision when a JavaScript agent reads it. Splitting numerics into `number` (f64) and `bigint` (arbitrary-precision integer) prevents silent data corruption across language boundaries.

---

## Future Work

### Deferred from the Spec

- **Real ed25519 signatures** — Phase 2 uses a stub that always returns valid
- ~~**Incremental kernel pipeline**~~ (§9) — **Plan 005 complete.** All kernel stages are incremental, pipeline composition wired, 42 differential tests verify equivalence with batch.
- ~~**Incremental Datalog evaluator**~~ (§9) — **Plan 006 complete.** Native incremental LWW/Fugue solvers for default rules (O(|Δ|)), incremental Datalog evaluator with DRed for custom rules, strategy switching between native and Datalog paths. The full pipeline is O(|Δ|) end-to-end. 1198 tests pass.
- **Settled/Working set partitioning** (§11) — Bounds solver cost to recent activity
- **Compaction** (§12) — Requires settled set; tombstone compaction is especially tricky for sequences due to origin references
- **Wire format** (§13) — Batching and compact encoding for sync
- **Full sync protocol** (§15) — Delta sync works; full protocol is future
- **Query layer** (§16) — Level 1/2 queries over store and reality
- **Introspection API** (§17) — explain, conflicts, history, whatIf
- **Bookmark / time-travel UX** (§10) — Snapshots, scrubbing, branching
- **Path-based capability checks** — Currently uses wildcard paths; real checks require the skeleton (circular dependency, likely two-pass)

### Potential Extensions

- **Constraint compaction**: Safe garbage collection of dominated/superseded constraints after all peers have observed them
- **Cross-container constraints**: Referential integrity, computed values spanning multiple containers
- **Rich text marks**: Bold, italic, etc. as mark constraints with anchor resolution
- **Convenience DSL**: `datalog\`p(X) :- q(X, _).\`` instead of deeply nested factory calls

---

## References

1. Saraswat, V. A. (1993). *Concurrent Constraint Programming*. MIT Press.
2. Weidner, M. & Kleppmann, M. (2023). "The Art of the Fugue: Minimizing Interleaving in Collaborative Text Editing." [arXiv:2305.00583](https://arxiv.org/abs/2305.00583).
3. Shapiro, M., et al. (2011). "Conflict-free Replicated Data Types." SSS 2011.
4. Hellerstein, J. M. (2010). "The Declarative Imperative: Experiences and Conjectures in Distributed Logic." SIGMOD Record.
5. Budiu, M. & McSherry, F. (2023). "DBSP: Automatic Incremental View Maintenance."
6. Ullman, J. D. (1988). *Principles of Database and Knowledge-Base Systems*, Vol 1.
7. Apt, K., Blair, H., & Walker, A. (1988). "Towards a Theory of Declarative Knowledge."