# @kyneta/perspective — Technical Reference

> **Package**: `@kyneta/perspective`
> **Role**: Convergent Constraint Systems (CCS) — a constraint-based approach to CRDTs. Agents assert constraints; merge is pure set union; a stratified Datalog evaluator derives the shared reality. Ships with an incremental DBSP-grounded pipeline for O(|Δ|) updates.
> **Depends on**: zero runtime dependencies
> **Depended on by**: Standalone experimental package — not imported by any other Kyneta package. Not published to npm.
> **Canonical symbols**: `createReality`, `solve`, `insert`, `produceRoot`, `produceMapChild`, `produceSeqChild`, `produceValue`, `retract`, `ConstraintStore`, `createStore`, `Constraint`, `Rule`, `Agent`, `createAgent`, `CnId`, `createCnId`, `PeerID`, `VersionVector`, `AuthorityConstraint`, `PipelineConfig`, `RetractionConfig`, `evaluate`, `stratify`, `unify`, `aggregate`, `Fugue`, `LWW`, `incrementalFugue`, `incrementalLWW`, `ZSet` + operators, `STUB_SIGNATURE`
> **Key invariant(s)**:
> 1. **Rules are data, not code.** LWW value resolution and Fugue sequence ordering are ordinary `rule` constraints asserted at reality bootstrap. They travel in the store. Any agent with `CreateRule + Retract` capabilities can replace them — the reality changes, the engine doesn't.
> 2. **Given the same store, any two correct implementations produce identical results.** Layer 0 (kernel) algorithms are mechanical; Layer 1 (Datalog evaluator) is deterministic. Implementation languages and optimization strategies are free to vary; the resolved reality is not.
> 3. **Merge is set union.** Two constraint stores combine via pointwise set union — no ordering, no conflict resolution at merge time. All resolution happens at solve time.

A self-contained experimental implementation of the Unified CCS Engine Specification (see `theory/unified-engine.md`). Every structural or content change is modeled as a *constraint* — a signed, CnId-addressed assertion. Stores merge via set union. To compute the current state, the solver runs a Datalog program over the constraints; the default LWW + Fugue rules are themselves constraints in the store.

Standalone — does not integrate with `@kyneta/schema`, `@kyneta/exchange`, or the rest of the framework. Lives in the monorepo for shared tooling and review; ships as a private package.

---

## Questions this document answers

- What is a constraint, and how does it differ from a CRDT operation? → [Constraints as the source of truth](#constraints-as-the-source-of-truth)
- Why is set-union merge sufficient? → [Set-union merge](#set-union-merge)
- What is the two-layer engine and why that split? → [Two layers — kernel and Datalog](#two-layers--kernel-and-datalog)
- What does the solver pipeline look like? → [The solver pipeline](#the-solver-pipeline)
- Why are rules in the store, not in the code? → [Rules as data](#rules-as-data)
- What does the native-solver fast path do? → [Native solvers — the §B.7 fast path](#native-solvers--the-b7-fast-path)
- How does the incremental pipeline work? → [The incremental pipeline](#the-incremental-pipeline)
- What does a CnId identify? → [CnId — content-addressed identity](#cnid--content-addressed-identity)

## Vocabulary

| Term | Means | Not to be confused with |
|------|-------|-------------------------|
| CCS | Convergent Constraint Systems — the framework. Constraints are the source of truth; state is derived by solving. | CRDT in the operational-transform sense; strict LWW |
| Constraint | A signed, CnId-addressed assertion. Six kernel-level types: `structure`, `value`, `retract`, `authority`, `revoke`, `rule`. Merge is set union. | A CRDT operation in the usual sense — a constraint is declarative, not operational |
| `ConstraintStore` | `Set<Constraint>` plus indexes. The data. | A database — no queries beyond the solver |
| CnId | Content-addressed identity: hash of the constraint's immutable core. Stable across peers; never reassigned. | A UUID, a Lamport timestamp |
| Reality | The derived output of `solve(store, config)` — a materialised tree with resolved values at each node. | The store — the store is the truth; the reality is a view |
| Agent | A signing identity. Every constraint is signed by an agent; the agent's capabilities gate which constraint types it may assert. | A peer, a user — agents are the cryptographic principal; peers are network identity |
| Layer 0 Kernel | Mechanical algorithms: storage, CnId computation, Lamport clocks, signatures, authority, retraction, version vectors, tree skeleton. Pure, deterministic. | A "kernel" in the OS sense |
| Layer 1 Datalog Evaluator | Stratified, bottom-up, semi-naïve fixed-point evaluation with aggregation. Evaluates `rule` constraints from the store over facts derived from active constraints. | Prolog, SQL — Datalog is strictly less expressive and always terminating |
| Layer 2+ Rules | Application-specific rules (app-authored). Extend the default LWW + Fugue rules. | Default rules — those are the bootstrap set |
| §B.7 Native Solvers | Host-language LWW and Fugue implementations. Activate only when active rules match known default patterns; must produce identical results to the Datalog rules they replace. | A replacement for the Datalog evaluator — they are a fast path |
| `Rule` | A Datalog rule: head + body (positive and negative atoms, comparison predicates, aggregations). Stored as a `rule` constraint. | A `Policy` in `@kyneta/exchange` |
| Fact | A ground atom — no variables. Produced by projecting constraints; consumed by the evaluator. | A theorem; a premise |
| Active constraints | Constraints that are valid (well-formed, signed, within-capability) and not dominated by a retraction. | Valid constraints — "valid" is necessary; "active" is valid + not-retracted |
| Version vector | Per-peer Lamport clock map; defines the causal moment at which the solver should evaluate. | A state vector in Yjs terms — similar role, different implementation |
| Projection | `active constraints → Datalog facts`. Pure. | A database projection — similar name, different operation |
| Resolution | `Datalog-evaluated facts → typed winners + ordering`. Pure. | Resolution in the dispute sense |
| Skeleton | Tree structure derived from *all* valid structure constraints (immune to retraction). The permanent backbone of the reality. | The reality — the reality attaches values; the skeleton is just the tree |
| Authority / capability | `AuthorityConstraint` grants an agent a named capability (e.g., `CreateRule`, `Retract`). Gates what the agent may assert. | A scope, a policy — capabilities are the primitive |
| Retraction | A `retract` constraint targeting another constraint's CnId. Dominates the target; the target becomes inactive. | A CRDT delete — retractions can themselves be retracted, enabling undo |
| ℤ-set | `Map<Key, number>` with no zero entries. Abelian group under pointwise addition. Powers the incremental pipeline. | A multiset |
| Stratification | Partitioning a Datalog program into layers s.t. negation is only across strata; enables semi-naïve evaluation. | Rule prioritisation |
| Semi-naïve evaluation | Fixed-point evaluation using only newly-derived facts at each step. O(|output|) instead of O(|output|²). | Magic-set transformation |

---

## Architecture

**Thesis**: give agents one primitive (assert a constraint), one merge rule (set union), and one definition of truth (solve the store). Everything else — value resolution, sequence ordering, capabilities, retractions — is expressed *inside* the primitive, not around it.

Four sub-systems:

| Sub-system | Source | Role |
|------------|--------|------|
| Kernel (Layer 0) | `src/kernel/` | Storage, CnId, signatures, authority, validity, retraction, version vectors, skeleton, pipeline composition. Mechanical. |
| Datalog Evaluator (Layer 1) | `src/datalog/` | Stratified bottom-up fixed-point evaluation with aggregation and negation. Evaluates `rule` constraints. |
| Native Solvers (§B.7) | `src/solver/` | Host-language LWW and Fugue. Optional fast paths; activate only on default rules. |
| Base Algebra | `src/base/` | `ZSet`, `Result` helpers, shared types. Powers the incremental pipeline. |

Plus a top-level bootstrap (`src/bootstrap.ts`) that creates a new reality with the default constraint set — admin grant + default LWW + default Fugue rules + compaction/retraction config.

### What this package is NOT

- **Not a CRDT library.** It implements a *framework* for building CRDTs. Individual CRDTs (LWW-register, Fugue sequence) are expressed as sets of Datalog rules. The engine doesn't know LWW from Fugue except as rule patterns.
- **Not integrated with the rest of Kyneta.** Separate dependency graph, separate experimental status. Designed to be evaluated in isolation.
- **Not a database.** No query language beyond the solver. No indexes for arbitrary lookup.
- **Not production-ready.** Marked experimental in `package.json`; private (no npm publish). The Unified CCS Engine Specification is the authoritative document — this is its reference implementation.
- **Not performant at scale without the §B.7 fast paths.** Pure Datalog evaluation of LWW over 10⁴ values is O(n²) without the native solver shortcut.

---

## Constraints as the source of truth

Source: `src/kernel/types.ts`, `src/kernel/store.ts`.

A constraint is a signed assertion. The kernel defines six types (discriminated union on `type`):

| Type | Payload shape | Semantics |
|------|---------------|-----------|
| `structure` | `Root { containerId, policy }` / `Map { parent, key }` / `Seq { parent, originLeft, originRight }` | Permanent node in the reality tree. Never retractable. |
| `value` | `{ target: CnId, content: Value }` | Content at a node. Retractable. |
| `retract` | `{ target: CnId }` | Dominates the target constraint; enables undo by retracting the retraction. |
| `authority` | `{ grantee: PeerID, capability: string, scope: Scope }` | Grants a capability. Retractable only by a revocation. |
| `revoke` | `{ target: CnId }` | Terminal revocation of an authority grant. |
| `rule` | `Rule` | A Datalog rule. Drives resolution. Retractable. |

Every constraint carries:
- A **CnId** — content-addressed identity, computed from the immutable core.
- A **signature** — ed25519 (or `STUB_SIGNATURE` in tests) over the payload.
- A **Lamport timestamp** — the asserting peer's logical clock value.
- An **agent ID** (peer + keypair pointer) — the signer.

The store is a `Set<Constraint>` plus derived indexes (by-target, by-type, by-peer).

### Set-union merge

Source: `src/kernel/store.ts` → `merge` / `insert`.

Two stores merge by combining their constraint sets. There is no conflict resolution at merge time — two different constraints with the same target simply both exist in the merged store. Resolution happens later, at solve time, when the Datalog evaluator decides which constraints "win."

This is the key architectural move: merge is **pure** (commutative, associative, idempotent) because it only combines *evidence*. Resolution is a pure function of the combined evidence. Two peers who have exchanged all constraints compute the same reality regardless of merge order.

### What a constraint is NOT

- **Not an operation.** Operational CRDTs specify transformations; constraints specify facts. A `value` constraint says "X is the value at CnId Y" — not "set the value at CnId Y to X."
- **Not automatically ordered.** A store is an unordered set. Ordering (causality, Lamport precedence, rule stratification) is applied by the solver.
- **Not free of cost.** Every constraint is permanent. Retractions reduce the *active* set but don't delete from the store. Compaction (configured via `RetractionConfig`) allows bounded garbage collection.

---

## CnId — content-addressed identity

Source: `src/kernel/cnid.ts`.

A CnId is a hash over a constraint's immutable core — its type, payload, peer, Lamport value. Two agents asserting constraints with identical semantics produce identical CnIds only if their Lamport+peer fields match — which they won't under normal sync. In practice every distinct assertion has a distinct CnId.

Three properties follow:

1. **Stable across peers.** A constraint's CnId is the same in every store that holds it. Cross-store references (retraction targets, value targets, rule references) work seamlessly.
2. **Never reassigned.** The CnId is the constraint's identity. Two constraints with the same CnId are the same constraint.
3. **Cheap to compute.** FNV-1a-128 over a deterministic byte serialisation; no cryptographic-hash cost outside signing.

### What a CnId is NOT

- **Not a UUID.** UUIDs are random; CnIds are content-addressed.
- **Not a Lamport timestamp.** Lamport timestamps order events within a peer; CnIds identify constraints globally.
- **Not collision-proof against adversaries.** FNV-1a is not cryptographic. Adversarial collisions could in principle be constructed; the cryptographic integrity is carried by the signature.

---

## Two layers — kernel and Datalog

The Unified CCS Engine Specification splits engine responsibilities:

### Layer 0 Kernel

Source: `src/kernel/*.ts`.

Mechanical algorithms that any correct implementation must produce identical outputs for, given the same store:

| Module | Role |
|--------|------|
| `store.ts` | `ConstraintStore`, `createStore`, `insert`, `merge`. The data structure. |
| `cnid.ts` | `createCnId`. Content addressing. |
| `lamport.ts` | Per-peer logical clocks. |
| `signature.ts` | ed25519 signing + verification; `STUB_SIGNATURE` for tests. |
| `authority.ts` | Capability resolution. Which constraints is an agent allowed to assert at a given moment? |
| `validity.ts` | Signature + capability check. Produces the `Valid(S)` subset. |
| `retraction.ts` | Retraction graph + dominance. Produces the `Active(Valid(S))` subset. |
| `version-vector.ts` | Per-peer Lamport-clock maps; defines the causal moment. |
| `structure-index.ts` | Slot identity + parent→child relationships from structure constraints. |
| `skeleton.ts` | Builds the reality tree from valid structure + a `ResolutionResult`. |
| `projection.ts` | Active constraints → Datalog facts. The kernel→Datalog boundary. |
| `resolve.ts` | Datalog-evaluated facts → typed winners/ordering. The Datalog→kernel boundary. |
| `pipeline.ts` | Composition root. Composes all of the above into `solve(store, config)`. |
| `incremental/` | Incremental variants of the kernel algorithms. Powers O(|Δ|) updates. |

Layer 0 is **pure and deterministic**. Given the same store + version vector + rule set, every call produces the same output, in any implementation, in any language.

### Layer 1 Datalog Evaluator

Source: `src/datalog/*.ts`.

Stratified, bottom-up, semi-naïve fixed-point evaluation with aggregation and negation.

| Module | Role |
|--------|------|
| `types.ts` | `Rule`, `Atom`, `Term`, `PositiveAtom`, `Negation`, `Aggregation` + constructors (`rule`, `atom`, `eq`, `neq`, `lt`, `gt`, `positiveAtom`, `negation`, `varTerm`, `constTerm`, `_`). |
| `stratify.ts` | Partitions rules into strata where negation is only across strata. |
| `unify.ts` | Unification of terms against ground facts. |
| `aggregate.ts` | `count`, `min`, `max`, `sum`, `collect` aggregations. |
| `evaluator.ts` | Semi-naïve fixed-point loop. At each step, derives facts using only newly-added facts from the previous step. |
| `evaluate.ts` | Top-level `evaluate(rules, facts)` entry point. |

The evaluator is data-driven. The rules it runs come from the store (`rule` constraints). Changing the rules changes the reality.

### Why the split

Because rules are data, the engine must be able to run arbitrary Datalog. The kernel can't be parameterised by rules — the rules live in the store, not in compile-time configuration. So the engine has a *fixed* Datalog evaluator (Layer 1) that executes *variable* rules (from the store).

Conversely, the Datalog evaluator doesn't know about constraints, CnIds, signatures, or capabilities. Its input is facts; its output is derived facts. The kernel owns that translation.

### What the layers are NOT

- **Not coupled.** The kernel defines `projection` and `resolve` as pure functions. The Datalog evaluator has no knowledge of kernel types.
- **Not replaceable independently.** Both layers together define the semantics. A different kernel or a different evaluator produces a different reality.
- **Not complete without §B.7 fast paths for performance.** Pure Datalog LWW over large stores is O(n²); the native solvers bring it to O(n log n).

---

## The solver pipeline

Source: `src/kernel/pipeline.ts`.

```
ConstraintStore (S) + VersionVector (V)
    │
    ├─ filterByVersion(S, V)                      ── version-vector.ts
    │    └─ causal-moment cut
    ▼
  S_V
    │
    ├─ computeValid(S_V)                          ── validity.ts
    │    └─ signature + capability check
    ▼
  Valid(S_V)
    │
    ├─ AllStructure(Valid(S_V))                   (structure survives retraction)
    │    │
    │    └─ buildStructureIndex                   ── structure-index.ts
    │
    └─ Active(Valid(S_V))                         (retraction + dominance)
         │
         ├─ projectToFacts                        ── projection.ts
         │    └─ active constraints → Datalog facts
         │
         ├─ EITHER evaluate(rules, facts)         ── datalog/evaluate.ts
         │         └─ Datalog fixed-point
         │
         │         OR native fast path            ── §B.7, when rules match
         │
         └─ extractResolution                     ── resolve.ts
              └─ Datalog facts → typed winners
                  │
                  ▼
              buildSkeleton(structureIndex, res)  ── skeleton.ts
                  │
                  ▼
                Reality
```

### Why structure goes directly from `Valid`

Structure constraints are **permanent** — they cannot be retracted. A `structure` constraint defining the existence of a map entry or a sequence position stands forever (given its signature is valid and the asserting agent had capability).

If structure went through `Active` (which applies retraction), a retracted subtree would disappear from the reality tree — but values *within* that subtree might still be valid elsewhere. Separating the paths matches the specification's intent: "structure is the skeleton; values are the flesh."

### Why `resolve.ts` is the symmetric counterpart of `projection.ts`

`projection.ts` converts kernel types → Datalog facts. `resolve.ts` converts Datalog facts → kernel types. Together they form the boundary between the two worlds. Everything else (Datalog evaluation, skeleton building) operates in one world.

### What the pipeline is NOT

- **Not serial top-to-bottom at every solve.** The incremental variant (below) reuses previous-solve state and applies deltas; only `solve` proper walks the pipeline from the start.
- **Not mutable.** Every stage returns new data. The original store is never modified.
- **Not interleaved with I/O.** The pipeline is pure. Sync / persistence happens outside.

---

## Rules as data

Source: `src/bootstrap.ts`.

At reality creation, `createReality({ creator })` returns `{ store, agent, config }`. The initial store contains:

1. An `authority` constraint granting the creator admin capability.
2. Three LWW `rule` constraints (see below).
3. Eight Fugue `rule` constraints.
4. Compaction policy + retraction-depth configuration.

The LWW rules implement last-writer-wins value resolution. They are ordinary Datalog:

```
superseded(CnId, Slot) :-
  value(CnId, Slot, _, _, _),
  value(Other, Slot, _, _, _),
  lamport(Other, LO),
  lamport(CnId, LC),
  (LO > LC; LO = LC, peer(Other) > peer(CnId)).

winner(CnId, Slot) :-
  value(CnId, Slot, _, _, _),
  negation superseded(CnId, Slot).
```

The Fugue rules implement Yjs-style fractional indexing for ordered sequences.

An agent with `CreateRule + Retract` capabilities can:
1. Retract the default LWW rules.
2. Assert custom rules implementing, say, first-writer-wins.

The engine doesn't change. The reality does.

### What "rules as data" is NOT

- **Not unrestricted eval.** Rules must pass Datalog's stratification check — no arbitrary recursion with negation. Malformed rules are rejected at validity time.
- **Not a scripting language.** Rules are pure Datalog — no side effects, no I/O.
- **Not free.** Every rule is evaluated at every solve. Complex rules cost solve time.

---

## Native solvers — the §B.7 fast path

Source: `src/solver/`.

The Datalog evaluator is correct but slow for the common cases: plain LWW over `n` values is O(n²) because every value pairs against every other to compute `superseded`. Fugue over `n` ordered inserts is similarly quadratic.

The specification's §B.7 permits *native solvers* — host-language implementations of LWW / Fugue that produce identical outputs to the Datalog rules they replace. A native solver activates only when:

1. The active rule set structurally matches a known default pattern.
2. `PipelineConfig.enableNativeSolvers` is true.

```
if (rulesMatchDefaultLWW(activeRules) && config.enableNativeSolvers) {
  return nativeLWW(valueFacts)             // O(n log n)
} else {
  return evaluate(activeRules, valueFacts) // O(n²) but general
}
```

When custom rules are present, the pipeline falls back to Datalog automatically. No rule changes; no code changes.

| Module | Role |
|--------|------|
| `src/solver/lww.ts` | Batch LWW — full resolve. |
| `src/solver/incremental-lww.ts` | Incremental LWW — `O(|Δ|)` update given previous state + delta. |
| `src/solver/fugue.ts` | Batch Fugue — full sequence resolve. |
| `src/solver/incremental-fugue.ts` | Incremental Fugue — `O(|Δ|)` update. |

### What native solvers are NOT

- **Not a replacement.** The Datalog evaluator is the primary path; native solvers are fast paths under constraint.
- **Not silently divergent.** Every native solver is tested against its Datalog equivalent over randomized inputs. If they diverge, the test fails.
- **Not user-extensible via code.** Adding new fast paths means adding new Rust/TypeScript — not new store constraints. User-added rules without matching native solvers run in Datalog.

---

## The incremental pipeline

Source: `src/kernel/incremental/`, `src/base/zset.ts`.

For agents that re-solve on every change, the batch pipeline is wasteful: a single inserted constraint shouldn't trigger a full re-evaluation. The incremental pipeline maintains previous-solve state and applies deltas in O(|Δ|) time.

### ℤ-set algebra

`ZSet<K>` is `Map<K, number>` with no zero entries — the standard DBSP ℤ-set. Operations:

| Operation | Meaning |
|-----------|---------|
| `zsetAdd(a, b)` | Pointwise sum. |
| `zsetNegate(a)` | Pointwise negate. |
| `zsetFilter(a, pred)` | Filter by key. |
| `zsetMap(a, fn)` | Rekey. |
| `zsetFromEntries`, `zsetElements`, `zsetGet`, `zsetHas`, `zsetIsEmpty`, `zsetKeys`, `zsetForEach` | Iteration + accessors. |

### Incremental variants

Each kernel algorithm has an incremental counterpart in `src/kernel/incremental/`:

| Module | Incremental of |
|--------|---------------|
| `incremental/validity.ts` | `validity.ts` — deltas in the store produce deltas in `Valid(S)`. |
| `incremental/retraction.ts` | `retraction.ts` — retraction-graph updates. |
| `incremental/projection.ts` | `projection.ts` — fact deltas from constraint deltas. |
| `incremental/evaluate.ts` | `datalog/evaluate.ts` — semi-naïve variant over deltas. |
| `incremental/resolve.ts` | `resolve.ts` — delta-aware resolution extraction. |

Composing them: `updateReality(prevState, constraintDelta) → (nextState, realityDelta)`. Application code maintains `prevState` and feeds new constraints in.

### What the incremental pipeline is NOT

- **Not lossy.** An incremental solve produces the same reality a batch solve would (given the same final constraint set).
- **Not required for correctness.** Applications that can afford batch solve every frame don't need the incremental path.
- **Not faster unconditionally.** For small constraint sets, the batch path wins on constant factors.

---

## The Datalog evaluator in detail

Source: `src/datalog/`.

Standard Datalog + stratified negation + bag aggregation.

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

### What the evaluator is NOT

- **Not Prolog.** No SLD resolution; no cuts; no unification in the first-order-logic sense. Datalog is a strict subset.
- **Not Turing-complete.** Finite Herbrand universe → always terminating.
- **Not indexed.** Linear scan of facts per atom. Optimisation is future work.

---

## Key Types

| Type | File | Role |
|------|------|------|
| `Constraint` / `ConstraintBase` / `StructureConstraint` / `ValueConstraint` / `RetractConstraint` / `AuthorityConstraint` / `RevokeConstraint` / `RuleConstraint` | `src/kernel/types.ts` | The six constraint types (discriminated union). |
| `CnId` / `createCnId` | `src/kernel/cnid.ts` | Content-addressed identity. |
| `PeerID` / `Lamport` / `VersionVector` | `src/kernel/types.ts`, `src/kernel/lamport.ts`, `src/kernel/version-vector.ts` | Causal-clock primitives. |
| `ConstraintStore` / `createStore` / `insert` / `merge` | `src/kernel/store.ts` | The data. |
| `Agent` / `createAgent` | `src/kernel/agent.ts` | Signing identity. |
| `Rule` / `Atom` / `PositiveAtom` / `Negation` / `Aggregation` / `Term` / `VarTerm` / `ConstTerm` | `src/datalog/types.ts` | Datalog language. |
| `rule` / `atom` / `positiveAtom` / `negation` / `eq` / `neq` / `lt` / `gt` / `varTerm` / `constTerm` / `_` | `src/datalog/types.ts` | Datalog constructors. |
| `evaluate` | `src/datalog/evaluate.ts` | Top-level Datalog fixed-point entry. |
| `stratify` | `src/datalog/stratify.ts` | Rule stratification. |
| `unify` | `src/datalog/unify.ts` | Term unification. |
| `ResolutionResult` / `extractResolution` | `src/kernel/resolve.ts` | Datalog facts → typed winners. |
| `StructureIndex` / `buildStructureIndex` | `src/kernel/structure-index.ts` | Tree structure from structure constraints. |
| `Skeleton` / `buildSkeleton` | `src/kernel/skeleton.ts` | Reality tree construction. |
| `PipelineConfig` | `src/kernel/pipeline.ts` | Solver configuration. |
| `RetractionConfig` | `src/kernel/retraction.ts` | Retraction-depth config. |
| `solve` | `src/kernel/pipeline.ts` | Batch solve entry point. |
| `createReality` | `src/bootstrap.ts` | Reality-creation factory: initial store + default rules + admin grant. |
| `STUB_SIGNATURE` | `src/kernel/signature.ts` | Test-only signature value. |
| `ZSet<K>` + operators (`zsetAdd`, `zsetNegate`, `zsetFilter`, `zsetMap`, `zsetFromEntries`, `zsetElements`, `zsetGet`, `zsetHas`, `zsetIsEmpty`, `zsetKeys`, `zsetForEach`, `zsetEmpty`) | `src/base/zset.ts` | DBSP ℤ-set algebra. |
| `produceRoot` / `produceMapChild` / `produceSeqChild` / `produceValue` / `retract` | `src/index.ts` (re-exports) | High-level constraint-construction helpers. |

## File Map

| Path | Role |
|------|------|
| `src/index.ts` | Public barrel. Re-exports kernel, datalog, solver, base, plus high-level producers (`produceRoot`, `produceMapChild`, `produceValue`, `retract`). |
| `src/bootstrap.ts` | `createReality` — creates a fresh reality with admin grant + default LWW + default Fugue rules + retraction config. |
| `src/kernel/types.ts` | `Constraint` union + all per-type shapes. |
| `src/kernel/cnid.ts` | Content-addressed identity. |
| `src/kernel/store.ts` | `ConstraintStore`, `createStore`, `insert`, `merge`. |
| `src/kernel/agent.ts` | `Agent` + `createAgent`. |
| `src/kernel/lamport.ts` | Per-peer logical clocks. |
| `src/kernel/version-vector.ts` | Version-vector primitives + `filterByVersion`. |
| `src/kernel/signature.ts` | Ed25519 sign/verify + `STUB_SIGNATURE`. |
| `src/kernel/authority.ts` | Capability resolution. |
| `src/kernel/validity.ts` | `computeValid` — signature + capability check. |
| `src/kernel/retraction.ts` | Retraction graph + dominance. |
| `src/kernel/structure-index.ts` | Tree-structure index. |
| `src/kernel/projection.ts` | Active constraints → Datalog facts. |
| `src/kernel/resolve.ts` | Datalog facts → typed winners. |
| `src/kernel/rule-detection.ts` | Pattern match for §B.7 native-solver dispatch. |
| `src/kernel/native-resolution.ts` | Native-solver entry. |
| `src/kernel/skeleton.ts` | Skeleton construction. |
| `src/kernel/pipeline.ts` | Composition root — `solve(store, config)`. |
| `src/kernel/index.ts` | Kernel barrel. |
| `src/kernel/incremental/` | Incremental variants of the kernel algorithms. |
| `src/datalog/types.ts` | Datalog language + constructors. |
| `src/datalog/stratify.ts` | Rule stratification. |
| `src/datalog/unify.ts` | Unification. |
| `src/datalog/aggregate.ts` | Aggregation operators. |
| `src/datalog/evaluator.ts` | Semi-naïve fixed-point loop. |
| `src/datalog/evaluate.ts` | Top-level `evaluate`. |
| `src/datalog/index.ts` | Datalog barrel. |
| `src/solver/lww.ts` / `incremental-lww.ts` | Native LWW fast paths. |
| `src/solver/fugue.ts` / `incremental-fugue.ts` | Native Fugue fast paths. |
| `src/base/zset.ts` | ℤ-set algebra. |
| `src/base/result.ts` | `Result<T, E>` helper. |
| `src/base/types.ts` | Shared base types. |
| `theory/unified-engine.md` | The authoritative specification. This package is its reference implementation. |
| `tests/kernel/` | 35+ test files covering pipeline, authority, validity, cnid, Lamport, retraction, skeleton, projection, resolve, structure-index, version-vector, incremental variants. |
| `tests/datalog/` | Evaluator, stratification, unification, aggregation, database views. |
| `tests/solver/` | Native LWW + Fugue (batch + incremental), cross-validated against Datalog. |

## Testing

Every test file is pure — no I/O, no timers. The cross-validation suites (`tests/solver/incremental-lww.test.ts`, `tests/solver/incremental-fugue.test.ts`) run randomized inputs through both the Datalog evaluator and the native solver, asserting identical outputs — this is the §B.7 correctness contract in test form. `STUB_SIGNATURE` is used throughout so tests don't require key generation; real-signature round-trips live in the dedicated signature suite.

The Unified CCS Engine Specification in `theory/unified-engine.md` is the reference document. Every invariant in this TECHNICAL.md traces to a `§` reference there; the specification overrules this document wherever they differ.

**Tests**: 1,374 passed, 0 skipped across 35 files. Run with `cd experimental/perspective && pnpm exec vitest run`.