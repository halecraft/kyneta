# Unified CCS Engine Implementation Plan

## Background

Prism began as an exploratory prototype (Plan 001) that validated the core CCS thesis: constraints as truth, state as derived. That prototype succeeded — 476 tests confirm convergence, Fugue interleaving, LWW resolution, and Loro equivalence. However, it predates the Unified CCS Engine Specification (`theory/unified-engine.md`), which defines a far more rigorous and complete architecture.

The spec introduces several concepts absent from the prototype:

- **Six typed constraints** (`structure`, `value`, `retract`, `rule`, `authority`, `bookmark`) replacing the prototype's path-based assertions (`eq`, `exists`, `deleted`, `seq_element`)
- **CnId-based addressing** with causal predecessors (`refs`) replacing path-based indexing
- **Authority model** (Layer 0) — capability-based access control baked into the kernel
- **Retraction as assertion** — retraction graph with dominance computation, enabling undo/redo
- **Stratified Datalog evaluator** — solver rules (LWW, Fugue) travel as data in the constraint store, not as hardcoded algorithms
- **Version-parameterized solving** — time travel falls out naturally from `solve(S, V)`
- **Settled/Working set partitioning** — tractability guarantee that bounds solver cost to recent activity
- **Native solver optimizations** (§B.7) — host-language fast paths for known rules, with semantic equivalence to the Datalog rules

The spec's Addendum B defines the interoperability contract: an engine is Layer 0 (kernel) + a Datalog evaluator. Everything else — LWW, Fugue, custom resolution, schema mappings — is Datalog rules in the store.

### Key Specification References

All section references below refer to `theory/unified-engine.md`:

- §1–§3: Constraints, constraint types, values
- §4: The constraint store (set union merge)
- §5: Authority & validity (`Valid(S)`)
- §6: Retraction & dominance (`Active(S)`)
- §7: The solver (version-parameterized pipeline)
- §8: Policies (Map, Seq)
- §9: Incremental maintenance
- §14: Stratification (Layers 0–3+)
- §B.1–B.8: Implementation contract (kernel, evaluator, rules, bootstrap)

## Problem Statement

The prototype's architecture cannot evolve into the spec's engine. The prototype uses path-based constraint addressing, has no concept of retraction as assertion, has no authority model, and hardcodes solver logic rather than expressing it as Datalog rules. We need a clean implementation of the Unified CCS Engine spec, starting from the two mandatory components defined in §B.1: the Layer 0 kernel and the Datalog evaluator.

## Success Criteria

1. **Layer 0 kernel** passes deterministic equivalence tests: given the same store S, the kernel computes identical `Active(Valid(S))` and identical tree skeletons.
2. **Datalog evaluator** passes fixed-point equivalence tests: given the same rules and ground facts, it computes the same minimal model.
3. **LWW resolution** expressed as Datalog rules (§B.4) produces identical results to the native LWW solver.
4. **Fugue ordering** expressed as Datalog rules (§B.4) produces identical results to the native Fugue solver.
5. **Retraction** supports depth-2 (undo + redo) with correct dominance computation.
6. **Version-parameterized solving** enables `solve(S, V)` for any V ≤ V_current.
7. **Reality bootstrap** (§B.8) creates a reality with default solver rules, admin grant, and configuration.
8. **All tests pass** — kernel tests, evaluator tests, integration tests, and native solver equivalence tests.

## Gap Analysis

### What the Prototype Provides (and We Keep Conceptually)

- Validated understanding of CCS convergence properties
- Working Fugue interleaving algorithm (to be ported as native solver)
- Working LWW resolution (to be ported as native solver)
- Version vector implementation (to be updated for new CnId scheme)
- Familiarity with the constraint store abstraction

### What's Missing (the Full Spec)

- Six typed constraint types with CnId + refs + signature
- Authority model and validity computation
- Retraction graph and dominance computation
- Stratified Datalog evaluator with negation and aggregation
- Rules-as-data (LWW, Fugue as Datalog rules in the store)
- Solver pipeline (§7.2): S → S_V → Valid → Active → skeleton → resolve → reality
- Tree skeleton builder from structure constraints
- Reality bootstrap
- Incremental maintenance / delta propagation
- Time travel (version-parameterized solving)

## Core Type Definitions

These types implement the spec's §1–§3 directly. All types are immutable (readonly).

**Convention: `Uint8Array` immutability.** `Uint8Array` is inherently mutable in JavaScript. All code in this codebase treats `Uint8Array` values as logically immutable — never call `.set()`, `.fill()`, or mutate buffer contents after construction. This is enforced by convention, not the type system.

```typescript
// === Identity (§1) ===

type PeerID = string; // public key or hash thereof

// Structural integer fields use plain `number` with a safe-integer invariant.
// MUST satisfy: Number.isSafeInteger(x) && x >= 0 (i.e., 0 ≤ x ≤ 2^53 − 1).
// Enforced at the Agent (construction) and store.insert() (receipt) boundaries.
// See unified-engine.md §1 for rationale: JavaScript's f64 number type cannot
// exactly represent integers > 2^53 − 1, so cross-language interop requires this bound.
type Counter = number; // safe_uint: non-negative integer ≤ Number.MAX_SAFE_INTEGER
type Lamport = number; // safe_uint: non-negative integer ≤ Number.MAX_SAFE_INTEGER

interface CnId {
  readonly peer: PeerID;
  readonly counter: Counter;
}

// === Constraint Types (§2) ===

type Policy = 'map' | 'seq';

// §2.1
type StructurePayload =
  | { readonly kind: 'map'; readonly parent: CnId; readonly key: string }
  | { readonly kind: 'seq'; readonly parent: CnId; readonly originLeft: CnId | null; readonly originRight: CnId | null }
  | { readonly kind: 'root'; readonly containerId: string; readonly policy: Policy };

// §2.2
interface ValuePayload {
  readonly target: CnId;
  readonly content: Value;
}

// §2.3
interface RetractPayload {
  readonly target: CnId;
}

// §2.4
interface RulePayload {
  readonly layer: number; // must be ≥ 2
  readonly head: Atom;
  readonly body: readonly BodyElement[]; // supports atoms, negation, aggregation
}

// §2.5 — Capabilities (recursive discriminated union)
type Capability =
  | { readonly kind: 'write'; readonly pathPattern: readonly string[] }
  | { readonly kind: 'createNode'; readonly pathPattern: readonly string[] }
  | { readonly kind: 'retract'; readonly scope: RetractScope }
  | { readonly kind: 'createRule'; readonly minLayer: number }
  | { readonly kind: 'authority'; readonly capability: Capability } // recursive
  | { readonly kind: 'admin' };

type RetractScope =
  | { readonly kind: 'own' }
  | { readonly kind: 'byPath'; readonly pattern: readonly string[] }
  | { readonly kind: 'any' };

type AuthorityAction = 'grant' | 'revoke';
interface AuthorityPayload {
  readonly targetPeer: PeerID;
  readonly action: AuthorityAction;
  readonly capability: Capability;
}

// §2.6
interface BookmarkPayload {
  readonly name: string;
  readonly version: VersionVector;
}

// §1: The atomic unit — discriminated union on `type` field.
// `type` narrows `payload` so switch/if-narrowing works without casts.
interface ConstraintBase {
  readonly id: CnId;
  readonly lamport: Lamport;
  readonly refs: readonly CnId[];
  readonly sig: Uint8Array; // ed25519 signature
}

type Constraint =
  | (ConstraintBase & { readonly type: 'structure'; readonly payload: StructurePayload })
  | (ConstraintBase & { readonly type: 'value'; readonly payload: ValuePayload })
  | (ConstraintBase & { readonly type: 'retract'; readonly payload: RetractPayload })
  | (ConstraintBase & { readonly type: 'rule'; readonly payload: RulePayload })
  | (ConstraintBase & { readonly type: 'authority'; readonly payload: AuthorityPayload })
  | (ConstraintBase & { readonly type: 'bookmark'; readonly payload: BookmarkPayload });

// §3: Values
// `number` and `bigint` are distinct types with distinct comparison semantics.
// int(3) and float(3.0) are NOT equal — this avoids precision-loss bugs across
// language boundaries. See unified-engine.md §3 for full rationale.
type Value =
  | null
  | boolean
  | number    // IEEE 754 f64 — use for floats and integers ≤ MAX_SAFE_INTEGER
  | bigint    // arbitrary-precision integer — use for integers that need exact precision
  | string
  | Uint8Array  // logically immutable — see convention above
  | { readonly ref: CnId };

// === Datalog Types (§B.3) ===

interface Atom {
  readonly predicate: string;
  readonly terms: readonly Term[];
}

type Term =
  | { readonly kind: 'const'; readonly value: Value }
  | { readonly kind: 'var'; readonly name: string }
  | { readonly kind: 'wildcard' };  // anonymous: matches anything, binds nothing, each occurrence independent

interface Rule {
  readonly head: Atom;
  readonly body: readonly BodyElement[];
}

type GuardOp = 'eq' | 'neq' | 'lt' | 'gt' | 'lte' | 'gte';

type BodyElement =
  | { readonly kind: 'atom'; readonly atom: Atom }
  | { readonly kind: 'negation'; readonly atom: Atom }
  | { readonly kind: 'aggregation'; readonly agg: AggregationClause }
  | { readonly kind: 'guard'; readonly op: GuardOp; readonly left: Term; readonly right: Term };

interface AggregationClause {
  readonly fn: 'min' | 'max' | 'count' | 'sum';
  readonly groupBy: readonly string[];  // variable names
  readonly over: string;                // variable name
  readonly result: string;              // variable name for output
  readonly source: Atom;
}

// === Reality (§7.3) ===

interface RealityNode {
  readonly id: CnId;
  readonly policy: Policy;
  readonly children: ReadonlyMap<string, RealityNode>; // keyed by ChildKey
  readonly value: Value | undefined;
}

interface Reality {
  readonly root: RealityNode;
}

// === Error Handling ===
// Kernel functions return Result types for expected failures.
// Unexpected failures (programmer errors) throw.

type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

type InsertError =
  | { readonly kind: 'invalidSignature'; readonly constraintId: CnId }
  | { readonly kind: 'outOfRange'; readonly field: string; readonly value: number }  // counter/lamport > MAX_SAFE_INTEGER
  | { readonly kind: 'malformed'; readonly reason: string };

type ValidationError =
  | { readonly kind: 'invalidSignature'; readonly constraintId: CnId }
  | { readonly kind: 'missingCapability'; readonly constraintId: CnId; readonly required: Capability };
```

## Architecture

```
Engine
├── kernel/                  (Layer 0 — mandatory, §B.2)
│   ├── types.ts             CnId, Constraint (discriminated union), Value, Capability, Result
│   ├── cnid.ts              CnId generation, comparison, serialization
│   ├── lamport.ts           Lamport clock
│   ├── version-vector.ts    Version vector (track, filter, compare)
│   ├── signature.ts         ed25519 sign/verify (stub initially, real later)
│   ├── store.ts             Constraint store: insert, union merge, CnId-keyed
│   ├── agent.ts             Agent: stateful constraint factory (counter, lamport, refs, key)
│   ├── authority.ts         Authority chain replay, capability computation
│   ├── validity.ts          Valid(S) — signature check + capability check
│   ├── retraction.ts        Retraction graph, dominance, Active(S)
│   ├── structure-index.ts   Slot identity, structure grouping (shared by projection + skeleton)
│   ├── projection.ts        Active constraints → Datalog ground facts (via structure index join)
│   ├── skeleton.ts          Tree skeleton builder from structure constraints
│   └── pipeline.ts          Solver pipeline composition root (imports + composes, never implements)
│
├── datalog/                 (Datalog evaluator — mandatory, §B.3)
│   ├── types.ts             Atom, Rule, Term, Fact, Relation, BodyElement
│   ├── unify.ts             Variable binding / substitution
│   ├── stratify.ts          Stratification of rules with negation
│   ├── evaluate.ts          Bottom-up, semi-naive fixed-point evaluation
│   └── aggregate.ts         min, max, count, sum aggregation operators
│
├── solver/                  (Native optimizations — optional, §B.7)
│   ├── lww.ts               Native LWW: max_by(active_values, (lamport, peer))
│   └── fugue.ts             Native Fugue: tree walk over structure constraints
│
├── bootstrap.ts             Reality creation (§B.8): default rules, admin grant
└── index.ts                 Public API
```

**`structure-index.ts` computes slot identity.** The spec (§8.1) says multiple `structure` constraints can share the same `(parent, key)` in a Map — they represent the same logical slot. The structure index groups map children by `(parent, key)`, resolves each value constraint's `target` CnId to its slot identity, and provides the indexes that both `projection.ts` and `skeleton.ts` consume. This is Layer 0 logic (kernel), not Layer 1 (rules) — slot identity is a property of the policy, not something a Datalog rule should be able to retract or redefine.

**`projection.ts` denormalizes constraints into Datalog ground facts.** It consumes the structure index to join value constraints with their target structure constraints, computing the `Slot` column that the LWW rules (§B.4) group by. For Map nodes, Slot = `(parent, key)`. For Seq nodes, Slot = the target CnId (unique by definition). For Root nodes, Slot = `containerId`. The projection is a pre-processing step — the `active_value(CnId, Slot, Value, Lamport, Peer)` relation is a ground input to the Datalog evaluator, not derived by it.

**`pipeline.ts` is a composition root.** It imports pure functions from `validity.ts`, `retraction.ts`, `structure-index.ts`, `projection.ts`, `skeleton.ts`, and the Datalog evaluator, then composes them into `solve(S, V?) → Reality`. It never implements transformation logic itself — every step is a call to a function that lives in its own module.

**`agent.ts` is the imperative shell.** An `Agent` encapsulates the stateful parts of constraint creation: CnId counter, Lamport clock, observed refs (version vector), and private key. It produces immutable `Constraint` values. This is the only place where mutable state lives during normal operation. The store itself is grow-only (append-only set).

## Phases and Tasks

### Phase 1: Datalog Evaluator 🟢

The Datalog evaluator is the single most important new component. Everything else builds on it. We implement it first so we can validate LWW and Fugue rules before building the kernel.

#### Tasks

- 1.1 Implement `datalog/types.ts` — Atom, Term (const, var, wildcard), Rule, BodyElement (atom, negation, aggregation, guard), Fact, Relation, Substitution, AggregationClause, GuardOp; `Value` terms include both `number` (f64) and `bigint` (int) 🟢
- 1.2 Implement `datalog/unify.ts` — variable binding, substitution application, term matching against facts (including wildcard support); includes `compareValues(a: Value, b: Value): number` that handles `number` vs `bigint` correctly (`number` and `bigint` are distinct types that never unify with each other); guard evaluation via `evaluateGuard()` 🟢
- 1.3 Implement `datalog/evaluate.ts` — bottom-up semi-naive fixed-point evaluation for positive Datalog (no negation yet) 🟢
- 1.4 Implement `datalog/stratify.ts` — dependency graph construction, SCC detection, stratification validation, stratum ordering; return `Result` with context-rich error on cyclic negation; guards introduce no dependency edges 🟢
- 1.5 Extend `datalog/evaluate.ts` — stratified evaluation that processes strata in order, with negation between strata 🟢
- 1.6 Implement `datalog/aggregate.ts` — min, max, count, sum operators; integrate into evaluator as a special body element; aggregation over `number` and `bigint` values must handle each type correctly (sum of bigints returns bigint, sum of numbers returns number; mixed-type aggregation is a type error) 🟢
- 1.7 Validate LWW rules from §B.4 produce correct results against hand-computed expected values 🟢
- 1.8 Validate Fugue rules (simplified subset) produce correct ordering against hand-computed expected values 🟢

**Note on Phase 1 test strategy:** Phase 1 tests use ad-hoc ground facts that *simulate* kernel-domain relations (e.g., `active_value(CnId, Slot, Value, Lamport, Peer)`). These are test doubles — simple tuples — not real kernel types (which don't exist until Phase 2). In Phase 4, equivalence tests verify that the real kernel→Datalog projection (`kernel/projection.ts`) produces facts the evaluator handles identically. This "test double → real integration" bridge is intentional.

**Ergonomic conventions established in Phase 1** (all later phases should follow):
- **Guards over magic strings.** Comparison constraints use typed `guard` body elements (`neq(X, Y)`) — not magic-string predicates (`positiveAtom(atom('__neq', [...]))`). The old `__eq`/`__neq`/`__gt`/`__lt` built-in predicates still work for backward compatibility but are deprecated. New code must use `eq()`, `neq()`, `lt()`, `gt()`, `lte()`, `gte()`.
- **Wildcards over dummy variables.** Use `_` (or `wildcard()`) instead of `varTerm('_Unused')` for positions you don't care about. Each wildcard is independent — two wildcards never unify, unlike two variables with the same name.
- **Positional tuples remain for now.** Facts are flat positional tuples (`['cn1', 'title', 'Hello', 1, 'alice']`). Phase 4's `projection.ts` will give these named structure, but within the Datalog layer, tuples are the correct abstraction.

#### Tests

- Positive Datalog: transitive closure (classic `path(X,Z) :- edge(X,Y), path(Y,Z)`) reaches fixed point
- Semi-naive: delta-only processing produces same result as naive recomputation
- Stratified negation: `not` predicates respect stratum boundaries; cyclic negation rejected with `Result` error
- Aggregation: `max(lamport)` over groups produces correct LWW winners (lamport values are `number`, not `bigint`)
- Value comparison: `number(3.0)` and `bigint(3n)` do not unify; they are distinct types
- LWW rules: concurrent writes resolved correctly by (lamport, peer) ordering
- Empty relation handling: rules over empty facts produce empty results
- Multiple rules for same head predicate: all rules contribute facts
- Guards: `neq()`, `gt()`, `lt()`, `eq()`, `lte()`, `gte()` filter substitutions correctly; guards introduce no predicate dependencies in stratification
- Wildcards: `_` matches any value without binding; multiple wildcards are independent; wildcards work in aggregation sources

### Phase 2: Kernel Types and Store 🟢

The new constraint types and CnId-based store, replacing the prototype's path-based system.

#### Tasks

- 2.1 Implement `kernel/types.ts` — all types from Core Type Definitions section: discriminated union `Constraint`, `Capability` (recursive), `Value` (with `bigint`), `Counter`/`Lamport` (safe-integer branded types), `Result<T,E>`, error types; re-export Datalog types (`Rule`, `BodyElement` including `GuardElement`, `Term` including `WildcardTerm`) so that `RulePayload` is properly typed 🟢
- 2.2 Implement `kernel/cnid.ts` — CnId creation, equality, comparison (peer then counter), string serialization 🟢
- 2.3 Implement `kernel/lamport.ts` — Lamport clock: local tick, merge on receive 🟢
- 2.4 Implement `kernel/version-vector.ts` — port and adapt existing version-vector.ts for new CnId scheme 🟢
- 2.5 Implement `kernel/signature.ts` — stub implementation (always valid) with real ed25519 interface; real crypto deferred 🟢
- 2.6 Implement `kernel/store.ts` — CnId-keyed Map, insert (returns `Result<void, InsertError>`, dedup by CnId, validates safe-integer invariant on counter/lamport), set union merge, version vector maintenance 🟢
- 2.7 Implement `kernel/agent.ts` — Agent: encapsulates CnId counter, Lamport clock, observed version vector, private key; produces immutable `Constraint` values with correct id, lamport, refs, and sig; enforces safe-integer invariant on counter/lamport at construction 🟢

#### Tests

- CnId: equality, comparison ordering (peer lex, then counter numeric)
- Lamport: tick monotonicity, merge takes max+1
- Version vector: extend, merge, compare (equal/less/greater/concurrent), S_V filtering
- Store: insert deduplication, set union merge (commutative, associative, idempotent), version vector updated on insert
- Store: insert with invalid signature returns `InsertError` (once real signatures exist; stub always succeeds)
- Store: insert with counter or lamport > MAX_SAFE_INTEGER returns `InsertError`
- Store generation counter increments on mutation
- Agent: produces constraints with monotonically increasing counters and lamport; refs track observed constraints
- Agent: counter and lamport never exceed MAX_SAFE_INTEGER (assert/throw on overflow — this is a programmer error, not an expected condition)
- Constraint discriminated union: narrowing on `type` correctly narrows `payload` in switch/if

### Phase 2.5: Remove Prototype Code 🟢

The old prototype (`src/core/`, `src/store/`, `src/solver/`, `src/doc/`, `src/handles/`, `src/views/`, `src/events/`, `src/introspection/`, old `src/index.ts`) is completely isolated from the new engine — zero cross-imports in either direction (verified). Its 476 tests exercise the old path-based architecture, not the new CnId-based engine, so they provide no safety net for forward progress. Carrying two parallel type systems (`OpId`/`Assertion` vs. `CnId`/`Constraint`) through Phases 3–5 adds cognitive load and risks accidental imports.

The Fugue algorithm implementation (`src/solver/fugue.ts`) is the one piece worth preserving as reference for the Phase 4 native solver port.

#### Tasks

- 2.5.1 Copy `src/solver/fugue.ts` to `reference/fugue-v0.ts` as porting reference for Phase 4 🟢
- 2.5.2 Delete old source directories: `src/core/`, `src/store/`, `src/solver/`, `src/doc/`, `src/handles/`, `src/views/`, `src/events/`, `src/introspection/` 🟢
- 2.5.3 Delete old test directories: `tests/core/`, `tests/solver/`, `tests/equivalence/`, `tests/events/`, `tests/handles/`, `tests/views/`, `tests/introspection/`, old `tests/integration.test.ts` 🟢
- 2.5.4 Replace `src/index.ts` with a minimal re-export of `kernel/index.ts` and `datalog/index.ts` (the new public API surface; will be expanded in Phase 5) 🟢
- 2.5.5 Remove legacy `__eq`/`__neq`/`__gt`/`__lt`/`__lte`/`__gte` built-in predicate support from `datalog/unify.ts` (`isBuiltinPredicate`, `evaluateBuiltin`, `tryEvaluateBuiltin`, `BUILTIN_PREDICATES`) and the call site in `datalog/evaluate.ts` (`evaluatePositiveAtom`). Also update surviving Datalog tests: delete `tests/datalog/unify.test.ts` `isBuiltinPredicate` and `evaluateBuiltin` describe blocks; delete `tests/datalog/evaluate.test.ts` `legacy __builtin predicates` describe block; rewrite `tests/datalog/stratify.test.ts` LWW pattern test to use `guard` body elements instead of `__neq`/`__gt`/`__eq` atoms (note: guards introduce no dependency edges, so the test's expected stratification may simplify — verify and adjust expectations accordingly) 🟢
- 2.5.6 Remove `loro-crdt` from `devDependencies` in `package.json` (only used by old equivalence tests being deleted) 🟢
- 2.5.7 Verify: `npx tsc --noEmit` clean, `npx vitest run` passes (only datalog + kernel tests remain) 🟢

#### Tests

No new tests. The verification is that surviving datalog tests (222 minus deleted legacy-builtin tests, plus any rewritten stratify tests) and kernel (236) tests still pass, and the project compiles cleanly.

### Phase 3: Authority, Validity, and Retraction 🟢

The three filters in the solver pipeline: Valid(S) and Active(Valid(S)).

#### Tasks

- 3.1 Implement `kernel/authority.ts` — authority chain replay: walk authority constraints ≤ V, compute capabilities(P, V); revoke-wins on concurrent grant/revoke; capability attenuation validation 🟢
- 3.2 Implement `kernel/validity.ts` — Valid(S): for each constraint, check signature (via signature.ts) + check capability at causal moment; return filtered set 🟢
- 3.3 Implement `kernel/retraction.ts` — build retraction graph (edges from retract → target), enforce target-in-refs rule, enforce no-structure-retraction rule; compute dominance by reverse topological traversal; return Active(S) 🟢
- 3.4 Enforce retraction depth limit (configurable, default 2) 🟢

#### Tests

- Authority: creator has Admin; grant propagates capability; revoke removes capability; revoke-wins on concurrency; capability attenuation (can't escalate)
- Validity: invalid signature → excluded from Valid(S); missing capability → excluded; invalid constraints stored for auditability
- Retraction: retract(value) → value dominated; retract(retract) → undo; depth-2 chain; structure constraints immune to retraction
- Active(S) determinism: same S → same Active(S) regardless of insertion order

### Phase 3.5: Extract Shared Base Types 🟢

The `base/` module currently holds only `Result<T,E>`, extracted during Phase 2 so that `datalog/` and `kernel/` could share it without depending on each other. Post-Phase-3 review revealed that `CnId`, `Value`, and their supporting identity types (`PeerID`, `Counter`) are in the same situation: both layers define structurally identical but nominally separate copies.

This duplication is a build-order artifact, not a deliberate design choice. Phase 1 built the Datalog evaluator before the kernel existed, so `datalog/types.ts` defined its own lightweight `CnIdRef` and `Value`. Phase 2 then defined `CnId` and `Value` independently in `kernel/types.ts`. The premise was "no cross-dependency between kernel and datalog" — but that premise is already violated: `kernel/types.ts` imports 14 types from `datalog/types.ts` (for `RulePayload`). The actual dependency direction is `kernel → datalog`, which is fine. The reverse (`datalog → kernel`) remains clean.

Extracting the shared identity and value types to `base/` follows the `Result` precedent, eliminates the drift hazard flagged in Learnings (Dual Value Types), and removes the need for the compile-time compatibility assertion hack that was planned for `projection.ts`. It also simplifies Phase 4: `projection.ts` will work with a single `Value` type instead of bridging two structurally-compatible-but-nominally-distinct copies.

#### Tasks

- 3.5.1 Create `base/types.ts` — extract `PeerID`, `Counter`, `Lamport`, `CnId`, `isSafeUint()`, and `Value` as the shared type definitions. These are pure data shapes with no behavioral logic and no dependencies beyond each other. 🟢
- 3.5.2 Update `datalog/types.ts` — remove `CnIdRef` interface and local `Value` type definition. Import `CnId`, `PeerID`, `Counter`, and `Value` from `base/types.ts`. Re-export them for downstream consumers. Update all internal references (`CnIdRef` → `CnId`). 🟢
- 3.5.3 Update `kernel/types.ts` — remove local `PeerID`, `Counter`, `Lamport`, `CnId`, `isSafeUint()`, and `Value` definitions. Import them from `base/types.ts`. Re-export them for downstream consumers. 🟢
- 3.5.4 Update `datalog/types.ts` functions — `serializeValue()`, `compareValues()`, `valuesEqual()`, and `compareSameType()` reference `CnIdRef` in type assertions and casts. Update these to use `CnId`. 🟢
- 3.5.5 Update `base/result.ts` — no changes needed (it remains independent). 🟢
- 3.5.6 Update index files — `datalog/index.ts` stops exporting `CnIdRef` (it no longer exists); exports `CnId` from the re-export. `kernel/index.ts` re-exports from `kernel/types.ts` as before (which now delegates to `base/types.ts`). `src/index.ts` removes the `CnIdRef` export from the Datalog section (it's now just `CnId` everywhere). 🟢
- 3.5.7 Update test files — any test that imports `CnIdRef` directly updates to use `CnId`. Grep for `CnIdRef` across all test files. (No tests imported `CnIdRef` — no changes needed.) 🟢
- 3.5.8 Verify: `npx tsc --noEmit` clean, `npx vitest run` passes, all 532 tests still pass. 🟢

#### Tests

No new tests. This is a pure refactor — the verification is that all existing tests pass and the project compiles cleanly. The test count should remain exactly 532.

### Phase 4: Skeleton, Pipeline, and Reality 🟢

Wiring the solver pipeline from §7.2 and constructing the reality tree.

#### Tasks

- 4.1 Implement `kernel/structure-index.ts` — builds indexes over valid structure constraints that both `projection.ts` and `skeleton.ts` consume. Core responsibilities: (a) `Map<cnIdKey, StructureConstraint>` for O(1) target lookup; (b) **slot identity computation** — for Map children, group structure constraints by `(parent, key)` so that independently-created structures for the same map key are recognized as the same logical slot (§8.1: "Multiple `structure` constraints may exist for the same `(parent, key)`. They represent the same logical slot."); (c) for Seq children, slot = the target's own CnId (unique by definition); (d) for Root, slot = `containerId`. Exports a `StructureIndex` type consumed by downstream modules. This is Layer 0 (kernel) logic — slot identity derives from policy semantics and must not be expressible as a retractable rule. 🟢
- 4.2 Implement `kernel/projection.ts` — consumes the `StructureIndex` and active value constraints to produce Datalog ground facts. The key operation is a **join**: each `ValueConstraint`'s `target` CnId is resolved through the structure index to obtain slot identity, then emitted as `active_value(CnId, Slot, Content, Lamport, Peer)`. Also emits `active_structure_seq(CnId, Parent, OriginLeft, OriginRight)` for Fugue rules and `constraint_peer(CnId, Peer)` for peer tiebreak. Document the column-name→position mapping for each projected relation so that rule authors don't need to count tuple positions. (Note: the compile-time type-compatibility assertion originally planned here is no longer needed — Phase 3.5 unified `Value` and `CnId` into a single shared definition in `base/types.ts`.) 🟢
- 4.3 Implement `kernel/skeleton.ts` — build rooted tree from the `StructureIndex`: Root nodes define containers; Map children grouped by (parent, key) via the index's slot grouping; Seq children ordered by Fugue interleaving; value resolution via native LWW 🟢
- 4.4 Port native Fugue solver to `solver/fugue.ts` — adapt from path-based seq_element to CnId-based structure(seq) constraints, using `reference/fugue-v0.ts` as guide 🟢
- 4.5 Port native LWW solver from prototype to `solver/lww.ts` — adapt from path-based to slot-based value resolution 🟢
- 4.6 Implement `kernel/pipeline.ts` — composition root only: imports and composes `filterByVersion()`, `computeValid()`, `computeActive()`, `buildStructureIndex()`, `projectToFacts()`, `buildSkeleton()`, `resolveValues()` from their respective modules into `solve(S, V?) → Reality`. Contains no transformation logic of its own. 🟢
- 4.7 Implement version-parameterized solving: `solve(S, V)` for historical queries (§7.1) 🟢

*Note: Phase 4 intentionally used native solvers as the sole resolution path — the Datalog evaluator runs but its results are discarded. Phase 4.5 corrects this to match the spec's architecture, where Datalog evaluation IS the resolution and native solvers are an optional fast path.*

**Note on the projection design (from pre-Phase-4 research):** The spec's LWW rule `active_value(CnId, Slot, Value, Lamport, Peer)` treats `Slot` as a pre-computed ground term, not something derived by Datalog. This is deliberate — slot identity is Layer 0 kernel logic (§8 Policies), not Layer 1 rule logic. If the slot join were expressed as a Datalog rule, an agent with `CreateRule` + `Retract` capabilities could retract it and break the reality. The projection pre-computes slot identity outside Datalog so that the LWW and Fugue rules receive ready-to-use ground facts. This also means Phase 1's test doubles (which hardcode `'title'` as a string slot) match the real projection's output shape — the "test-double → real integration" bridge works.

**The Map multi-structure case is the key subtlety.** When Alice creates `structure(map, parent=root@0, key="title")` getting CnId `alice@1` and Bob independently creates `structure(map, parent=root@0, key="title")` getting CnId `bob@1`, then `value(target=alice@1, content="Hello")` and `value(target=bob@1, content="World")` compete for the **same slot**. The projection must emit both with the same `Slot` value. The structure index handles this grouping.

#### Tests

- Structure index: map children with same (parent, key) grouped into same slot; map children with different keys are distinct slots; seq children each have unique slot identity; root slot = containerId
- Structure index: concurrent map structure creation — two peers independently create structure(map, parent=P, key=K) → same slot
- Projection: active value constraints → Datalog `active_value` facts with correct Slot derived from structure index
- Projection: value targeting a map structure → Slot is `(parent, key)`, not the target CnId
- Projection: two values targeting different structure constraints for the same `(parent, key)` → same Slot in projected facts
- Projection: value targeting a seq structure → Slot is the target CnId
- Projection: orphaned value (target not in valid structures) → excluded from projection
- Projection: structure constraints → `active_structure_seq` and `constraint_peer` facts with correct fields
- Projection roundtrip: Phase 1 test doubles match the shape of real projected facts (validates the test-double→real bridge)
- Skeleton: root nodes created from Root structure constraints; map children grouped by (parent, key) via structure index; seq children ordered correctly
- Pipeline: end-to-end from constraints → reality for simple map, simple sequence, nested containers
- Native solver equivalence: LWW native == LWW Datalog rules (from Phase 1) for same inputs
- Native solver equivalence: Fugue native == Fugue Datalog rules for same inputs (scoped to simplified subset — full Fugue tree walk is native-only)
- Version-parameterized: solve(S, V_past) returns historical reality; solve(S, V_current) returns current reality
- Retraction + pipeline: retracted value excluded from reality; un-retracted value reappears

### Phase 4.5: Datalog-Driven Resolution 🟢

Phase 4's pipeline runs the Datalog evaluator but discards the results — the skeleton is built entirely by native solvers that bypass the rule system. This contradicts the spec's core architecture: "LWW and Fugue are not part of the engine. They are Datalog rules that travel in the constraint store. The engine is Layer 0 (kernel) + a Datalog evaluator. Everything else is data." (§B.1)

The consequence: rules-as-data is inert. An agent that retracts the default LWW rules and asserts a custom resolution strategy would have no effect on the reality — the native LWW solver runs unconditionally. §B.7 constraint #3 says: "If the reality's solver rules are retracted and replaced with custom rules, native solvers must fall back to Datalog evaluation for the replacement rules." There is no fallback mechanism.

Phase 4.5 restructures the pipeline so that Datalog evaluation is the **primary** resolution path, with native solvers as an **optional optimization** that activates only when the active rules match known patterns. This also fixes two spec compliance gaps discovered during post-Phase-4 review.

#### Tasks

- 4.5.1 Implement `kernel/resolve.ts` — a resolution module that reads Datalog-derived facts and produces the data the skeleton builder needs. For LWW: reads the `winner(Slot, CnId, Value)` relation from the evaluated database and produces a `Map<slotId, LWWWinner>`. For Fugue: reads the `fugue_before(Parent, A, B)` relation and produces a total order per parent. This module bridges Datalog output → skeleton input. It does NOT contain resolution logic itself — it reads what Datalog derived. 🟢
- 4.5.2 Refactor `kernel/skeleton.ts` — the skeleton builder currently calls native `resolveLWWSlot()` and `orderFugueNodes()` directly. Refactor to accept a `ResolutionResult` (from `resolve.ts`) that provides pre-resolved winners and orderings. The skeleton builder becomes policy-agnostic — it reads the resolution result instead of running solvers inline. When a `ResolutionResult` is provided, use it. When absent (legacy/test path), fall back to native solvers. 🟢
- 4.5.3 Implement native solver detection in `kernel/pipeline.ts` — before evaluating rules via Datalog, inspect the active rule constraints. If they are exactly the known default LWW and Fugue rules (matched by structure, not by CnId), use native solvers as a fast path (§B.7). If the rules have been modified, retracted, or augmented with custom rules, fall back to Datalog evaluation. This is the §B.7 optimization with §B.7 constraint #3 (fallback). 🟢
- 4.5.4 Wire the Datalog-primary path in `pipeline.ts` — when the native fast path is NOT active: (a) extract rules from active constraints, (b) evaluate against projected facts, (c) pass the evaluated `Database` to `resolve.ts` to extract `winner` and `fugue_before` facts, (d) pass the `ResolutionResult` to the skeleton builder. The Datalog evaluation result is no longer discarded — it feeds directly into reality construction. 🟢
- 4.5.5 Fix structure index source (§7.2 compliance) — change `pipeline.ts` to build the structure index from `validityResult.valid` (all valid structure constraints) instead of `retractionResult.active`. The spec's pipeline forks at `Valid(S_V)`: one branch takes `AllStructure(Valid(S_V))` for the skeleton, the other takes `Active(Valid(S_V))` for value resolution. Structure constraints are immune to retraction, so this is currently equivalent — but the code should match the spec's two-path design to prevent regressions if the retraction module ever has a bug that incorrectly dominates a structure constraint. 🟢
- 4.5.6 Fix authority retraction immunity (§2.5 compliance) — add a `targetIsAuthority` case to `RetractionViolationReason` in `retraction.ts` and enforce it in `computeActive()`. The spec says: "`authority` constraints are not retractable via `retract`. Revocation is the dedicated mechanism for removing capabilities." Currently only `structure` constraints are protected. 🟢
- 4.5.7 Expose resolution metadata in `PipelineResult` — add the `ResolutionResult` and whether the native fast path was used to `PipelineResult` for introspection and testing. 🟢
- 4.5.8 Verify: `npx tsc --noEmit` clean, `npx vitest run` passes. Existing pipeline tests continue to produce identical realities (the native solvers and Datalog rules are equivalent by the Phase 4 equivalence tests — this phase changes *which path* produces the reality, not the result). 🟢

**Design note on native solver detection (task 4.5.3):** The detection must be structural — comparing the rule's `head` and `body` shapes, not CnIds or lamport values. A bootstrap LWW rule created by Alice and one created by Bob are semantically identical even though they have different CnIds. The detection function should be a pure predicate: `isDefaultLWWRules(rules): boolean`, `isDefaultFugueRules(rules): boolean`. When both return true and no additional Layer 2+ rules exist, the native fast path is safe.

**Design note on the Datalog→skeleton bridge (task 4.5.1):** The `winner(Slot, CnId, Value)` relation is the LWW output. The Datalog evaluator produces this as a `Relation` in its `Database`. `resolve.ts` reads this relation and converts each fact tuple back into typed data (`slotId`, `winnerId`, `content`). This is the inverse of what `projection.ts` does — projection converts kernel types to Datalog facts, resolution converts Datalog facts back to kernel types. The two modules are symmetric.

**Why not just make the skeleton read the Database directly?** Because the skeleton builder should not depend on Datalog types. The dependency direction is `kernel → datalog` for projection (kernel types → Datalog facts), and the reverse path should go through `resolve.ts` as a boundary module. This keeps the skeleton as a pure kernel module that knows about `SlotGroup`, `RealityNode`, and `Value` — not about `Relation` or `Fact`.

#### Tests

- Datalog-primary path: pipeline with LWW rules in store (as `rule` constraints) produces identical reality to native-only path for same inputs
- Datalog-primary path: pipeline with Fugue rules in store produces identical seq ordering to native-only path
- Native fast path detection: default LWW + Fugue rules → native path detected; modified rules → Datalog path used
- Native fast path detection: additional Layer 2 rules alongside defaults → Datalog path used (custom rules might interact)
- Custom resolution: replace default LWW with a custom rule (e.g., `lowest_lamport_wins`) → reality reflects the custom resolution, not native LWW
- Custom resolution: retract default LWW rules, assert priority-based rules → reality uses priority resolution
- Authority retraction immunity: retract targeting an authority constraint → violation, constraint remains active
- Structure index source: structure index built from valid set, not active set (verify structurally — possibly via spy/mock or by checking that structure constraints with retracted siblings still appear)
- `PipelineResult` exposes resolution metadata and fast-path flag
- All existing pipeline tests still pass with identical results

### Phase 4.6: Pre-Bootstrap Correctness 🟢

Post-Phase-4.5 research revealed four gaps that must be closed before bootstrap can emit correct default rules and integration tests can exercise realistic Agent workflows. Each is a correctness issue, not a feature — leaving any unfixed would mean Phase 5 builds on a broken foundation.

#### Motivation

1. **Retraction target-in-refs is broken for Agent-produced constraints.** The Agent compresses causal refs to the version-vector frontier (one CnId per peer — the highest counter). But `computeActive()` checks the *literal* presence of the target CnId in the `refs` array. An agent retracting a non-frontier constraint (e.g., counter 5 when the frontier is counter 10) will have the retraction silently rejected as a `targetNotInRefs` violation. Every existing retraction test passes only because it hand-constructs refs arrays with the exact target CnId. Phase 5 task 5.4 (retraction sync integration test) would fail immediately.

2. **The Fugue Datalog rules are incomplete.** The current "default" Fugue rules handle only one case: two siblings sharing the same `originLeft` are ordered by peer ID. The native solver handles the full algorithm (recursive tree walk, `originRight` disambiguation, depth-first traversal). The equivalence tests are explicitly scoped to the "shared subset." If bootstrap emits these simplified rules, the core Datalog path produces wrong results for non-trivial sequences — and the native fast-path optimization papers over the problem. This is the exact anti-pattern Phase 4.5 fixed for the pipeline wiring: "we've proven the optimization matches the core, but the core is incomplete." Success Criterion #4 says Fugue Datalog must match native for *all* inputs, not just a subset.

3. **`store.insert()` clones the entire constraint Map on every single insert.** `new Map(store.constraints)` is O(n). For a bootstrap that emits ~10 constraints sequentially, this means 10 full map copies. For any realistic store with thousands of constraints, single inserts are prohibitively expensive. This is not a premature optimization concern — it's an O(n²) algorithm where O(n) is trivially achievable by switching to mutate-in-place.

4. **`skeleton.test.ts` was listed as a Phase 4 deliverable but never created.** The skeleton builder has subtle logic (slot group merging, seq tombstone detection, map null-deletion, ResolutionResult vs. native fallback) that is only tested indirectly through `pipeline.test.ts`. A pipeline failure doesn't localize the bug. Edge cases like deeply nested maps, mixed map-in-seq, and seq-in-seq have no focused coverage.

5. **Pipeline tests default to `enableDatalogEvaluation: false`.** All 25 pipeline tests run through the native path exclusively. The resolve tests (Phase 4.5) test the Datalog path separately, and equivalence tests prove the two paths agree — but the pipeline tests themselves never exercise the Datalog primary path. For Phase 5 and beyond, the default should be `enableDatalogEvaluation: true`, matching the spec's architecture. A small number of tests should explicitly test native-only mode.

#### Tasks

- 4.6.1 Fix retraction `target-in-refs` to use semantic interpretation — change `computeActive()` in `retraction.ts` to interpret a ref `(peer, N)` as "I've observed all of peer's constraints 0..N" rather than requiring the literal target CnId to appear. Specifically: a retract constraint's target `(peer, T)` is considered "in refs" if any ref `(peer, N)` exists with `N ≥ T`. This matches how version vectors work everywhere else in the system and doesn't require the Agent to special-case retraction. Update the existing `target-in-refs` tests and add a new test: Agent produces a value, produces several more constraints, then retracts the earlier value — the retraction succeeds despite the target not being on the frontier. 🟢
- 4.6.2 Implement complete Fugue Datalog rules — express the full Fugue tree walk in Datalog with recursive rules. The simplified rules only handle the same-`originLeft` peer-tiebreak case. The complete rules must handle: (a) tree construction from `originLeft` chains (an element is a child of its `originLeft`); (b) `originRight` disambiguation when siblings have different right neighbors; (c) transitive ordering via recursive `fugue_before`. Datalog's fixed-point evaluation supports recursion natively — this is exactly what it's for. The result may be 5–8 rules instead of 2, and slower than native (quadratic vs. O(n log n)), but it must be *correct* for all inputs. The native fast path (§B.7) still activates for the default pattern, so performance is not affected in the common case. 🟢
- 4.6.3 Update Fugue equivalence tests — expand `tests/solver/fugue-equivalence.test.ts` to cover the full algorithm, not just the "shared subset." Add tests for: non-trivial `originLeft` chains (elements whose `originLeft` is not the start), `originRight` disambiguation, three-way concurrent inserts at different positions, and interleaved insert sequences. The existing "simplified subset" comment should be removed — the Datalog rules and native solver must now agree on *all* inputs. 🟢
- 4.6.4 Fix `store.insert()` to mutate in place — change `ConstraintStore` to use internal mutation with a generation counter for cache invalidation instead of cloning the entire Map on every insert. `insert()` returns `Result<void, InsertError>` (mutates on success) rather than `Result<ConstraintStore, InsertError>` (returns a new store). The `generation` counter already exists for this purpose. `insertMany()` and `mergeStores()` similarly mutate in place. Update all call sites (store tests, pipeline, agent tests) to reflect the new mutation semantics. 🟢
- 4.6.5 Add `tests/kernel/skeleton.test.ts` — focused tests for the skeleton builder with hand-constructed `StructureIndex` and `ResolutionResult` inputs. Cover: map children with null values (deletion exclusion), seq tombstone detection, slot group merging (multiple peers creating same map key), mixed nesting (map-in-seq, seq-in-map, seq-in-seq), the `ResolutionResult` path vs. native fallback path, and empty containers. 🟢
- 4.6.6 Flip pipeline tests to `enableDatalogEvaluation: true` — change the `DEFAULT_CONFIG` in `pipeline.test.ts` to enable Datalog evaluation (matching the spec's architecture where Datalog is primary). Add a small focused test group that explicitly sets `enableDatalogEvaluation: false` to verify the native-only bypass still works. All existing pipeline tests must produce identical results with Datalog enabled. 🟢
- 4.6.7 Verify: `npx tsc --noEmit` clean, `npx vitest run` passes. Existing tests produce identical realities. The native fast-path detection in `pipeline.ts` must still recognize the new (complete) Fugue rules as default patterns — update `hasDefaultFugueRules()` if the additional rules introduce new head predicates. 🟢

**Design note on semantic refs (task 4.6.1):** The spec (§6) says: "A `retract` constraint's `refs` must contain its `target`." The Agent's frontier compression is a compact representation of the full causal history — `(peer, 10)` in refs logically implies all of `(peer, 0)` through `(peer, 9)` were observed. The semantic interpretation preserves the spec's causal safety guarantee (you can only retract what you've observed) while being compatible with the Agent's representation. A retract with no ref for the target's peer, or a ref with `N < target.counter`, is still a violation.

**Design note on complete Fugue rules (task 4.6.2):** The implementation uses 7 rules across 3 predicates: `fugue_child` (1 rule — derives tree structure, unchanged), `fugue_descendant` (2 rules — transitive closure of the originLeft tree), and `fugue_before` (4 rules — parent-before-child, sibling-by-peer, sibling-by-CnId-on-tie, subtree propagation with descendant negation guard, and transitivity). The key challenge was the subtree propagation rule: "if A is a child of X, and X is before B, then A is before B" — but only when B is NOT a descendant of X. Without the descendant guard, parent-child ordering combined with subtree propagation creates spurious orderings among siblings and within subtrees. The `fugue_descendant` relation provides the correct guard via stratified negation (`not fugue_descendant(P, B, X)`), which is safe because `fugue_descendant` depends only on `fugue_child` (a base relation) with no cyclic dependency on `fugue_before`. The native fast-path detector checks for `fugue_child` and `fugue_before` head predicates, which both the old simplified and new complete rules contain — no changes needed to `hasDefaultFugueRules()`.

**Design note on store mutation (task 4.6.4):** The current `insert()` returning `Result<ConstraintStore, InsertError>` suggests a functional API where the caller gets a new store on success. But this is O(n) per insert without persistent data structures. The simpler fix is to acknowledge that the store is a mutable container (like a `Map` or `Set`) and mutate in place. The `generation` counter already serves as the change-detection signal — callers that cache solved results check the generation, not the store reference. `mergeStores` becomes a mutating `importFrom` or stays as a function that returns a new store (since both inputs survive). The key constraint: `insert()` must still be idempotent (inserting the same constraint twice is a no-op).

#### Tests

- Semantic refs: Agent produces value, then several more constraints, then retracts value — retraction succeeds with frontier-compressed refs
- Semantic refs: retract with no ref for target's peer → still a violation (causal safety preserved)
- Semantic refs: retract with ref `(peer, N)` where `N < target.counter` → violation
- Semantic refs: retract with ref `(peer, N)` where `N == target.counter` → succeeds (implies target observed)
- Semantic refs: retract with ref `(peer, N)` where `N > target.counter` → succeeds (frontier implies all prior)
- Complete Fugue Datalog: non-trivial `originLeft` chains produce correct ordering (matches native)
- Complete Fugue Datalog: `originRight` disambiguation produces correct ordering (matches native)
- Complete Fugue Datalog: complex interleaved concurrent inserts match native ordering
- Complete Fugue Datalog: single element, empty sequence edge cases
- Store mutation: `insert()` mutates in place, returns `Result<void, InsertError>`
- Store mutation: `insert()` idempotency preserved — inserting same constraint twice is a no-op
- Store mutation: `insertMany()` mutates in place
- Store mutation: generation counter increments on each mutation
- Store mutation: all existing store tests adapted and passing
- Skeleton focused: map null-deletion, seq tombstone, slot group merge, mixed nesting, empty containers
- Skeleton focused: ResolutionResult path vs. native fallback produce same tree for same inputs
- Pipeline with Datalog: all existing pipeline tests pass with `enableDatalogEvaluation: true`
- Pipeline native-only: small test group verifies native bypass still works with `enableDatalogEvaluation: false`
- All existing tests pass with identical results

### Phase 5: Reality Bootstrap and Integration 🟢

Creating realities, the bootstrap process, and the public API.

#### Tasks

- 5.1 Implement `bootstrap.ts` — reality creation: generate creation constraint with Admin grant to creator; emit default LWW rules as rule constraints (using `guard` body elements, not legacy `__neq`/`__gt`); emit default Fugue rules as rule constraints (the complete rules from Phase 4.6.2, using wildcards for unused positions); set compaction policy and retraction depth (§B.8). Canonical rule builders (`buildDefaultLWWRules`, `buildDefaultFugueRules`, `buildDefaultRules`) are exported and serve as the single source of truth — test files that previously duplicated these rules now import from `bootstrap.ts`. Bootstrap constructs Layer 1 rule constraints directly (bypassing `Agent.produceRule()`'s layer ≥ 2 guard, which is correct for user-facing rules but not kernel bootstrap). 🟢
- 5.2 Implement `index.ts` — public API: `createReality`, `solve`, `solveFull`, `insert`, `exportDelta`, `importDelta`, plus full re-exports of kernel types, authority, validity, retraction, structure index, projection, resolution, skeleton, and Datalog evaluator. No `assertConstraint` wrapper — callers use the Agent directly (the Agent IS the constraint factory per §B.5). Introspection deferred to future plan. 🟢
- 5.3 Integration test: two agents create constraints, sync via delta, both compute identical reality (includes three-agent pairwise sync, concurrent LWW resolution, concurrent Fugue seq ordering) 🟢
- 5.4 Integration test: agent retracts a value, syncs, both see retraction reflected in reality (includes undo via retract-of-retract, seq tombstone via value retraction, semantic refs for non-frontier targets) 🟢
- 5.5 Integration test: bootstrap a reality, verify default solver rules are in the store and produce correct results (includes constraint count, admin grant, LWW rules, Fugue rules, monotonic counters/lamport, agent initialization, pipeline config, empty reality, map resolution, seq ordering) 🟢

#### Tests

- Bootstrap: new reality has creation constraint, admin grant, LWW rules, Fugue rules in store
- Two-agent sync: bidirectional delta exchange → convergent realities
- Retraction sync: retract propagates via delta; reality reflects dominance
- Multi-container: reality with both map and seq containers resolves correctly
- Constraint auditability: invalid constraints remain in store, queryable but excluded from solving

### Phase 6: Documentation and Cleanup 🟢

#### Tasks

- 6.1 Rewrite README.md to reflect new architecture (engine = kernel + Datalog evaluator) — added Quick Start with working code example, updated project status table showing all phases complete, replaced architecture diagram with full directory tree, moved theoretical foundation inline, updated test count to 759 🟢
- 6.2 Rewrite TECHNICAL.md to document the new architecture, spec alignment, and design decisions — removed all v0 prototype sections (Architecture, Core Types, Solvers, Constraint Store, Sync Protocol, Subscriptions, Introspection, v0 Design Decisions), consolidated into a single cohesive document covering: engine architecture, solver pipeline, constraint types, slot identity, projection, default solver rules (LWW + Fugue with rule details), native solvers, authority/validity, retraction/dominance, bootstrap, reality tree, Datalog evaluator, store/sync, module dependency DAG, agent, stratification, design decisions, future work 🟢
- 6.3 Update LEARNINGS.md with findings from the new implementation — Phase 5 learnings already added (canonical rule definitions, CnId collisions, bootstrap layer semantics, authority prerequisite, agent observe pattern, bidirectional sync). No additional updates needed for Phase 6. 🟢
- 6.4 Remove `reference/fugue-v0.ts` (no longer needed after Phase 4 port) — deleted file and empty `reference/` directory 🟢
- 6.5 *(Deferred)* Add a convenience DSL for rule construction. The current factory-call API (`rule(atom('p', [varTerm('X')]), [positiveAtom(atom('q', [varTerm('X'), _]))]))`) is verbose but correct and fully typed. A DSL (`datalog\`p(X) :- q(X, _).\``) would improve ergonomics but is not a correctness issue. Deferred to a future plan. 🟡

*Note: Tasks 6.3 (remove old prototype) and 6.5 (remove legacy builtins) from the original plan were moved to Phase 2.5 and executed immediately after Phase 2.*

## Transitive Effect Analysis

### Complete Replacement — No Backwards Compatibility

The old prototype code is removed in Phase 2.5 (immediately after Phase 2), not deferred to Phase 6. The old and new code are fully isolated (zero cross-imports verified), so removal is safe as soon as the new kernel exists. The Fugue algorithm is preserved in `reference/fugue-v0.ts` as a porting guide for Phase 4.

### Internal Dependency Chain (New Code)

The new code has a strict dependency DAG:

```
base/result.ts          (no deps — shared by datalog and kernel)
base/types.ts           (no deps — shared PeerID, Counter, Lamport, CnId, Value, isSafeUint)
datalog/types.ts        → base/result.ts, base/types.ts
kernel/types.ts         → base/result.ts, base/types.ts, datalog/types.ts (re-exports only)
kernel/cnid.ts          → kernel/types.ts
kernel/lamport.ts       (no deps)
kernel/version-vector.ts → kernel/types.ts
kernel/signature.ts     → kernel/types.ts
kernel/agent.ts         → kernel/types.ts, cnid.ts, lamport.ts, version-vector.ts, signature.ts
kernel/store.ts         → kernel/types.ts, cnid.ts, lamport.ts, version-vector.ts
kernel/authority.ts     → kernel/types.ts, store.ts, version-vector.ts
kernel/validity.ts      → kernel/types.ts, store.ts, authority.ts, signature.ts
kernel/retraction.ts    → kernel/types.ts, validity.ts
kernel/structure-index.ts → kernel/types.ts, cnid.ts
kernel/projection.ts    → kernel/types.ts, base/types.ts, structure-index.ts
kernel/resolve.ts       → kernel/types.ts, datalog/types.ts (Datalog Database → typed resolution result)
kernel/skeleton.ts      → kernel/types.ts, structure-index.ts, resolve.ts (optionally)
kernel/pipeline.ts      → kernel/types.ts, store.ts, validity.ts, retraction.ts, structure-index.ts, projection.ts, resolve.ts, skeleton.ts, datalog/evaluate.ts, solver/lww.ts, solver/fugue.ts
datalog/unify.ts        → datalog/types.ts
datalog/stratify.ts     → datalog/types.ts
datalog/aggregate.ts    → datalog/types.ts
datalog/evaluate.ts     → datalog/types.ts, unify.ts, stratify.ts, aggregate.ts
solver/lww.ts           → kernel/types.ts
solver/fugue.ts         → kernel/types.ts
bootstrap.ts            → kernel/types.ts, store.ts, agent.ts, datalog/types.ts
index.ts                → everything
```

A change to `base/types.ts` affects nearly everything (it defines `CnId`, `Value`, and the identity types used everywhere). A change to `kernel/types.ts` affects all kernel modules and anything downstream. Changes to leaf modules (datalog/aggregate.ts, solver/lww.ts) are isolated. `kernel/projection.ts` depends on both `kernel/types.ts` and `base/types.ts` — but since Phase 3.5 unified `Value` and `CnId` into `base/types.ts`, it no longer bridges two separate type systems. `kernel/structure-index.ts` is a shared dependency of both `projection.ts` and `skeleton.ts` — it computes the slot identity and structure grouping that both modules need.

### Test Dependency Chain

Tests for Phase N depend on code from Phases 1..N. Phase 1 (Datalog) tests are self-contained. Phase 2 (kernel types/store) tests are self-contained. Phase 3 tests depend on Phase 2 code. Phase 3.5 is a pure refactor — all existing tests must still pass. Phase 4 tests depend on Phases 1–3.5. Phase 4.5 tests depend on Phases 1–4 (and critically, the equivalence tests from Phase 4 validate that the Datalog-primary path produces the same results as the native-only path). Phase 5 tests depend on all prior phases. This means a type change in `base/types.ts` may break all tests transitively.

### External Dependencies

- **ed25519 library**: deferred (stub in Phase 2, real crypto in a future plan). When added, it will affect `kernel/signature.ts` and transitively `kernel/validity.ts`.
- **loro-crdt**: devDependency used only by old equivalence tests. Removed in Phase 2.5 (task 2.5.6). If future equivalence tests against Loro are needed, re-add at that time.
- **No other new dependencies**. The Datalog evaluator, kernel, and native solvers are all pure TypeScript with zero external deps.

## Testing Strategy

### Unit Tests (per module)

Each module in `kernel/` and `datalog/` gets its own test file. Tests are pure functions: construct inputs, call function, assert outputs. No shared mutable state.

### Equivalence Tests

The most important tests in this plan:
- **Native LWW vs. Datalog LWW**: same inputs → same outputs. This validates that the native optimization (§B.7) is semantically equivalent to the rules-as-data evaluator.
- **Native Fugue vs. Datalog Fugue**: same inputs → same outputs.
- These tests serve as the spec's correctness criterion (§B.7): "A native solver MUST produce identical results to the Datalog rules it replaces."

### Integration Tests

End-to-end tests that exercise the full pipeline:
- Create reality → assert constraints → solve → verify reality
- Two-agent sync → convergent realities
- Retraction → value disappears → un-retraction → value reappears
- Version-parameterized solving → historical reality matches expectations

### Property Tests (if time permits)

- Merge commutativity: solve(merge(A, B)) == solve(merge(B, A))
- Merge associativity: solve(merge(merge(A, B), C)) == solve(merge(A, merge(B, C)))
- Merge idempotence: solve(merge(A, A)) == solve(A)
- Retraction involution: retract(retract(x)) restores x

## Directory Structure

After Phase 2.5 (prototype removal):

```
prism/
├── src/
│   ├── base/
│   │   ├── result.ts           Shared Result<T,E> type
│   │   └── types.ts            Shared PeerID, Counter, Lamport, CnId, Value, isSafeUint (Phase 3.5)
│   ├── kernel/
│   │   ├── types.ts
│   │   ├── cnid.ts
│   │   ├── lamport.ts
│   │   ├── version-vector.ts
│   │   ├── signature.ts
│   │   ├── store.ts
│   │   ├── agent.ts
│   │   ├── index.ts
│   │   ├── authority.ts         (Phase 3)
│   │   ├── validity.ts          (Phase 3)
│   │   ├── retraction.ts        (Phase 3)
│   │   ├── structure-index.ts   (Phase 4)
│   │   ├── projection.ts        (Phase 4)
│   │   ├── resolve.ts           (Phase 4.5 — Datalog derived facts → typed resolution result)
│   │   ├── skeleton.ts          (Phase 4, refactored in 4.5)
│   │   └── pipeline.ts          (Phase 4, refactored in 4.5)
│   ├── datalog/
│   │   ├── types.ts
│   │   ├── unify.ts
│   │   ├── stratify.ts
│   │   ├── evaluate.ts
│   │   ├── aggregate.ts
│   │   └── index.ts
│   ├── solver/                   (Phase 4)
│   │   ├── lww.ts
│   │   └── fugue.ts
│   ├── bootstrap.ts              (Phase 5)
│   └── index.ts
├── tests/
│   ├── datalog/
│   │   ├── unify.test.ts
│   │   ├── evaluate.test.ts
│   │   ├── stratify.test.ts
│   │   ├── aggregate.test.ts
│   │   └── rules.test.ts       (LWW + Fugue rules validation)
│   ├── kernel/
│   │   ├── cnid.test.ts
│   │   ├── lamport.test.ts
│   │   ├── version-vector.test.ts
│   │   ├── store.test.ts
│   │   ├── agent.test.ts
│   │   ├── authority.test.ts     (Phase 3)
│   │   ├── validity.test.ts      (Phase 3)
│   │   ├── retraction.test.ts    (Phase 3)
│   │   ├── structure-index.test.ts (Phase 4)
│   │   ├── projection.test.ts    (Phase 4)
│   │   ├── skeleton.test.ts      (Phase 4.6)
│   │   └── pipeline.test.ts      (Phase 4)
│   ├── solver/                    (Phase 4)
│   │   ├── lww-equivalence.test.ts
│   │   └── fugue-equivalence.test.ts
│   └── integration.test.ts       (Phase 5)
├── reference/
│   └── fugue-v0.ts              (prototype Fugue, porting guide for Phase 4)
├── theory/
│   ├── unified-engine.md      (the spec — source of truth)
│   ├── CCS.md
│   └── causal-retraction.md
├── .plans/
│   ├── 001-prism-foundation.md (archived — previous prototype)
│   └── 002-unified-ccs-engine.md (this plan)
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
├── TECHNICAL.md
└── LEARNINGS.md
```

## Resources for Implementation

### Primary Specification

- `theory/unified-engine.md` — the authoritative spec. Every design decision should trace back to a section here.

### Key Sections by Phase

| Phase | Spec Sections |
|---|---|
| Phase 1 (Datalog) | §B.3 (evaluator requirements), §B.4 (LWW/Fugue rules), §14 (stratification) |
| Phase 2 (Types/Store) | §1 (constraints), §2 (constraint types), §3 (values), §4 (store), §13 (batching) |
| Phase 2.5 (Remove Prototype) | N/A — housekeeping, no new spec coverage |
| Phase 3 (Auth/Retract) | §5 (authority & validity), §6 (retraction & dominance) |
| Phase 4 (Pipeline) | §7 (solver pipeline), §8 (policies) |
| Phase 4.5 (Datalog-Driven Resolution) | §B.1 (engine = kernel + Datalog), §B.4 (rules as data), §B.7 (native optimization + fallback), §7.2 (pipeline two-path fork), §2.5 (authority non-retractability) |
| Phase 4.6 (Pre-Bootstrap Correctness) | §6 (retraction causal safety — semantic refs), §B.4 (complete Fugue rules), §B.7 (native equivalence for full algorithm), §4 (store performance) |
| Phase 5 (Bootstrap) | §B.8 (reality bootstrap), §15 (messages & sync), §9 (incremental maintenance) |

### Datalog Algorithm References

- Semi-naive evaluation: Ullman, "Principles of Database and Knowledge-Base Systems" Vol 1, Ch 3
- Stratified negation: Apt, Blair, Walker, "Towards a Theory of Declarative Knowledge" (1988)
- DBSP (incremental): Budiu & McSherry, "DBSP: Automatic Incremental View Maintenance" (2023) — for future Phase optimization

### Existing Code to Port

- ~~`src/core/version-vector.ts`~~ — ✅ ported as `kernel/version-vector.ts` in Phase 2
- `reference/fugue-v0.ts` — working Fugue interleaving; adapt from path-based to CnId-based structure(seq) constraints in Phase 4
- LWW comparison logic (was in `src/core/constraint.ts`) — the pattern is simple (`max(lamport, peer)`) and documented in the spec §B.4; re-derive from spec rather than porting

## Alternatives Considered

### Use an existing Datalog library (npm or Rust WASM)

**Evaluated**: datascript (npm), @datalogui/datalog (npm), datafrog (Rust), ascent (Rust), crepe (Rust).

**Rejected because**:
- npm packages either impose their own storage model (datascript), are abandoned (@datalogui/datalog), or use wrong evaluation model (datalogia — top-down, not bottom-up).
- Rust crates use proc macros that expand rules at compile time (ascent, crepe), making runtime rule evaluation impossible. datafrog has no negation or aggregation.
- The spec requires rules-as-data evaluated at runtime. No existing package supports this cleanly.
- A custom TypeScript evaluator is ~800–1200 lines, with zero external dependencies and full control over the integration surface.
- The spec's §B.7 native solver optimization means the Datalog evaluator handles only the general case (custom rules, schema mappings); hot paths (LWW, Fugue) bypass it via native TypeScript.

### Use Rust WASM for the Datalog evaluator

**Rejected because**:
- Would need a custom runtime evaluator in Rust anyway (proc-macro crates can't do runtime rule evaluation)
- FFI overhead (~100-200ns per boundary crossing) is significant for many small facts
- Separate build chain (cargo + wasm-pack) increases complexity
- 20-40 KB gzipped bundle size is acceptable but adds to page weight for no clear gain
- The spec already provides the performance escape hatch: native solvers (§B.7) handle the hot paths in pure TypeScript
- WASM can be reconsidered later as a §B.7-style optimization if Datalog evaluation becomes a measured bottleneck

### Incrementally evolve the prototype

**Rejected because**:
- The prototype uses path-based addressing; the spec uses CnId-based addressing with causal refs
- The prototype has 4 assertion types; the spec has 6 constraint types with fundamentally different structure
- The prototype hardcodes solver logic; the spec requires rules-as-data
- Attempting to incrementally migrate would produce a chimera — half old model, half new — that's harder to reason about than a clean implementation
- The prototype's value is in the *knowledge gained*, not the code. That knowledge transfers to the new implementation.

## Changeset

This plan replaces the entire `src/` directory and `tests/` directory. The old code is removed in Phase 2.5 (immediately after kernel types and store are established). The Fugue algorithm is preserved in `reference/fugue-v0.ts` as a porting guide. New files are created in Phases 1–5 as listed in the Directory Structure section.

## Notes

### Deferred to Future Plans

The following spec features are intentionally deferred:
- **Real ed25519 signatures** (Phase 2 uses a stub)
- **Incremental/delta evaluation** (§9) — correctness first, then performance
- **Settled/Working set partitioning** (§11) — optimization for large realities
- **Compaction** (§12) — requires settled set first
- **Batching & compact encoding** (§13) — wire format optimization
- **Messages & sync protocol** (§15) — delta sync works; full protocol is future
- **Query layer** (§16) — Level 1 and Level 2 queries over store/reality
- **Full introspection API** (§17) — explain, conflicts, history, whatIf, etc.
- **Bookmark / time-travel UX** (§10) — snapshots, scrubbing, branching
- **Full Fugue as Datalog** — ~~deferred~~ **moved to Phase 4.6** (task 4.6.2). The complete Fugue tree walk must be expressed in Datalog before bootstrap can emit correct default rules. The simplified subset validated in Phase 1 is insufficient — it only handles same-`originLeft` peer tiebreak, not the full recursive tree walk with `originRight` disambiguation.

### Signature Stub Strategy

Phase 2 implements `kernel/signature.ts` with an interface that matches ed25519 semantics but always returns valid. This lets the entire authority/validity pipeline work correctly without a crypto dependency. The interface is:

```typescript
function sign(data: Uint8Array, privateKey: Uint8Array): Uint8Array;
function verify(data: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean;
```

When real ed25519 is added later, only `signature.ts` changes. Nothing else in the codebase touches crypto directly.

### Error Handling Strategy

The codebase uses a two-tier error strategy aligned with the spec:

1. **Signature-invalid constraints** — rejected at the store boundary (`store.insert()` returns `Result<void, InsertError>`). These never enter the store. This matches §1: "Constraints with invalid signatures are discarded on receipt."

2. **Capability-invalid constraints** — enter the store but are filtered by `Valid(S)`. This matches §5.3: "Invalid constraints remain in the store for auditability but do not participate in solving." The `validity.ts` module returns the valid set plus a list of `ValidationError` values for introspection.

3. **Structural violations** (retract targets a structure constraint, retract target not in refs, rule layer < 2) — rejected at the `Agent` construction boundary. The `Agent` enforces these invariants when producing constraints, so they cannot enter the store in the first place. If received from a remote agent, they fail signature or validity checks.

4. **Programmer errors** (e.g., passing `undefined` where a `CnId` is expected) — throw. These are bugs, not expected conditions.

All expected-failure functions use `Result<T, E>` return types. Error types are discriminated unions with `kind` discriminants and context fields. No `any`. No swallowed exceptions.

## API Ergonomics

Observations from Phase 1 implementation, applied as a refactor before Phase 2.

### Guards Replace Magic-String Predicates

The initial Phase 1 implementation encoded comparison constraints as magic-string predicates: `positiveAtom(atom('__neq', [varTerm('CnId'), varTerm('CnId2')]))`. This was a 1970s-Prolog idiom wearing TypeScript clothes — untyped, invisible to the dependency graph, and confusing (guards aren't relational lookups, but they were dressed up as atoms).

The fix: a dedicated `guard` body element with a typed `GuardOp` discriminant. Now comparisons are `neq(varTerm('CnId'), varTerm('CnId2'))` — shorter, type-safe (the compiler catches typos in operator names), and honest about what they are. Guards introduce no predicate dependency edges in the stratification graph, which was a latent bug in the old encoding (the old approach would have added a spurious edge to a predicate named `__neq` that doesn't exist as a relation).

The old `__eq`/`__neq`/etc. built-in predicates still work via a legacy compatibility shim in `unify.ts`. They should be removed in Phase 6.

### Wildcards Prevent a Class of Accidental-Unification Bugs

Using `varTerm('_Value')` for "I don't care about this position" is a trap. If two body atoms both use `varTerm('_Value')`, they'll unify — silently constraining positions that were meant to be independent. This is exactly the kind of bug that looks correct in a code review.

The fix: `wildcard()` (aliased as `_`) is a proper anonymous term. Each occurrence is independent and never binds. The evaluator matches it against any value without extending the substitution. Using `_` makes intent clear: "this position exists in the schema but I don't need its value."

### Remaining Verbosity (Deferred)

The rule DSL is still verbose: `rule(atom('p', [varTerm('X')]), [positiveAtom(atom('q', [varTerm('X'), _]))])`. This is ~40 characters of ceremony for what Datalog writes as `p(X) :- q(X, _).` The ceremony comes from three sources:

1. **`positiveAtom(atom(...))`** — the common case (positive body atom) requires the most wrapping. A future improvement could make `atom(...)` itself usable in body position.
2. **`varTerm('X')`** — every variable mention is 12+ characters. A future DSL could use JS proxies or tagged templates to make variables implicit.
3. **No rule parser** — rules are constructed as data structures, not parsed from text.

These are developer-experience issues, not correctness issues. They're deferred to Phase 6 (task 6.6). The current API is correct, fully typed, and adequate for programmatic rule construction (which is the primary use case for bootstrap and projection).

### Refs Must Be Computed Before VV Update

When implementing the Agent (task 2.7), we discovered that the order of side effects in `nextIdAndLamport()` matters: the agent must snapshot causal refs *before* mutating the version vector with the new constraint's CnId. Otherwise, the constraint's own CnId appears in its own `refs` — a causal impossibility. The fix: capture `currentRefs()` first, then allocate CnId and update VV. General principle for stateful factories: **snapshot dependent state before mutating it.** This bug was caught immediately by the simplest test (`expect(c.refs).toEqual([])` for the first constraint) but would have been subtle in multi-agent scenarios.

### Shared Types Need a Dedicated Base Module

`Result<T,E>` is needed by both `datalog/types.ts` and `kernel/types.ts`. The plan's dependency DAG says both have "no deps." Importing from one into the other creates an unintended architectural dependency. Extracting to `base/result.ts` costs one file and ensures clean layering. This also makes prototype removal (Phase 2.5) safe — nothing in `kernel/` or `datalog/` depends on the old code.

### Named Discriminated Union Variants Improve Ergonomics

Giving each `Constraint` variant a named interface (`StructureConstraint`, `ValueConstraint`, etc.) enables: (1) precise return types on produce functions (`produceStructure() → StructureConstraint`), (2) TypeScript's `Extract<>` utility works correctly in `constraintsByType()`, and (3) tests can declare expected types without `as` casts.

## Learnings

### Discriminated Unions Prevent a Class of Bugs at the Plan Stage

The initial plan used a `Constraint` interface with a `type: ConstraintType` string field and a separate `payload: Payload` union. This is stringly-typed — nothing in the type system prevents a `type: 'retract'` constraint from carrying a `ValuePayload`. Engineering review caught this before any code was written. The fix — making `Constraint` itself a discriminated union where `type` narrows `payload` — eliminates all "wrong payload for this type" bugs at compile time and gives exhaustive switch checking for free. This is a good example of why type modeling deserves careful attention in the plan phase, not just during implementation.

### The Kernel↔Datalog Bridge Is a Distinct Responsibility

The initial plan had the Datalog evaluator and the kernel as separate modules (correct) but didn't describe how active constraints become Datalog ground facts. This projection step — converting `Constraint` records into flat `Fact` tuples like `active_value(CnId, Slot, Value, Lamport, Peer)` — is a distinct transformation that deserves its own module (`kernel/projection.ts`). Without it, the pipeline has a hidden coupling: either `pipeline.ts` does the projection inline (violating SRP) or the Datalog evaluator must know about kernel types (violating dependency direction). The projection module sits at the boundary and depends on both type systems, keeping everything else clean.

### Agents Are the Imperative Shell

The initial plan had no concept of "who constructs a Constraint." Without a factory, callers would manually assemble `Constraint` objects — getting lamport wrong, forgetting refs, computing CnIds incorrectly. The `Agent` concept is the natural imperative shell: it holds mutable state (counter, clock, observed version vector) and produces immutable `Constraint` values. Everything else in the codebase is a pure function over immutable data. This cleanly separates the stateful "assertion" act from the stateless "solving" act — which is exactly the CCS model (agents *tell*, solvers *compute*).

### Numeric Types Must Distinguish Integers from Floats for Cross-Language Interop

The original spec used `f64` as the sole numeric type ("all numbers"). This creates a silent data integrity hazard: JavaScript's `number` is f64, which can only exactly represent integers up to 2^53 − 1. A Rust agent storing a 64-bit database row ID would lose precision when a JavaScript agent reads it — and the two agents would compute different realities from the same store.

The fix splits numerics into two concerns:

1. **Structural fields** (counter, lamport, layer) — `safe_uint`: plain `number` in JS, constrained to ≤ 2^53 − 1. Enforced at Agent construction and store insertion. This bound is not operationally limiting (9 quadrillion operations from a single agent).

2. **User values** — `int` (maps to `bigint` in JS, `i64` in Rust) and `float` (maps to `number` in JS, `f64` in Rust). These are distinct types that do not compare as equal: `int(3)` ≠ `float(3.0)`. This prevents a class of bugs where integer identity is lost through float coercion.

The complexity is contained to three modules: `datalog/unify.ts` (term matching), `datalog/aggregate.ts` (numeric aggregation), and `kernel/projection.ts` (fact assembly). Everything else passes `Value` through opaquely. Wire formats (CBOR, MessagePack) natively distinguish integers from floats, so serialization maps directly.

### Magic Strings Are Bugs Waiting to Happen — Use the Type System

The initial Phase 1 implementation encoded comparison constraints as magic-string predicates stuffed into the relational atom wrapper: `positiveAtom(atom('__neq', [varTerm('CnId'), varTerm('CnId2')]))`. This had three problems: (1) nothing in the type system catches a typo like `'__nneq'` — it silently compiles as a lookup against a nonexistent relation; (2) guards aren't relational lookups, but the code dressed them up as atoms, confusing anyone reading the rule; (3) the dependency graph builder would add a spurious edge to a predicate named `__neq` that doesn't exist as a stored relation. The fix was a dedicated `guard` body element with a typed `GuardOp` discriminant (`'eq' | 'neq' | 'lt' | 'gt' | 'lte' | 'gte'`). Now the compiler catches typos, the stratifier correctly ignores guards (no dependency edges), and the code reads like what it means: `neq(varTerm('CnId'), varTerm('CnId2'))`.

The broader lesson: whenever a domain concept is semantically distinct from existing concepts, give it its own discriminated-union variant rather than encoding it as a special case of something else. The extra 20 lines of type definitions pay for themselves in every file that touches the concept.

### Anonymous Variables Need Language-Level Support, Not Naming Conventions

Using `varTerm('_Value')` for "I don't care about this position" is a correctness trap. If two body atoms both mention `varTerm('_Value')`, they silently unify — constraining positions that were meant to be independent. This looks correct in review because the underscore prefix *suggests* "don't care" without *enforcing* it. The fix was a `wildcard` term kind that the unifier always matches without extending the substitution. Each wildcard occurrence is independent by construction, not by convention.

### Review Your API As If You Were a New Hire

After completing Phase 1, we stepped back and asked "what would a modern TypeScript developer think of this API?" The answer was unflattering: the rule construction DSL was verbose and full of 1970s Prolog idioms. This review — done *between* phases rather than after all phases — was cheap (one refactor pass) and caught issues that would have metastasized across Phases 2–5 if left unchecked. The lesson: schedule ergonomic reviews at phase boundaries, not just at the end.

### Legacy Shims Infect Surviving Tests — Audit Before Deletion

Phase 2.5 task 2.5.5 originally said "remove legacy built-in predicate support from `datalog/unify.ts`; audit `datalog/evaluate.ts`." Post-Phase-2 research revealed that the legacy `__neq`/`__gt`/`__eq` predicates are also exercised by *surviving* Datalog test files — not just old prototype tests. Specifically: `tests/datalog/unify.test.ts` has `isBuiltinPredicate` and `evaluateBuiltin` describe blocks; `tests/datalog/evaluate.test.ts` has a `legacy __builtin predicates` describe block; and `tests/datalog/stratify.test.ts` has an LWW pattern test that encodes guards as `positiveAtom(atom('__neq', ...))` atoms. Deleting the shim without updating these tests would break the surviving test suite. The task has been expanded to include these test updates.

The `stratify.test.ts` case is particularly subtle: the old encoding treats `__neq` as a predicate, so the stratifier adds dependency edges to it. With the `guard` body element, no edges are added. The test's expected stratification behavior changes — it doesn't just need a syntax swap, it needs new expectations.

### Dual Value Types Are Structurally Compatible but Nominally Separate — Resolved in Phase 3.5

`datalog/types.ts` originally defined `Value` with `{ readonly ref: CnIdRef }` and `kernel/types.ts` independently defined `Value` with `{ readonly ref: CnId }`. These were structurally identical (`CnIdRef` and `CnId` both have `peer: string, counter: number`), so TypeScript's structural typing made them assignment-compatible. However, if either was modified independently, the bridge would break silently — no compile error until the structural shapes diverged.

Post-Phase-3 analysis revealed this duplication is a **build-order artifact**, not a deliberate architectural choice. Phase 1 defined `CnIdRef` and `Value` in `datalog/types.ts` because the kernel didn't exist yet. Phase 2 defined `CnId` and `Value` in `kernel/types.ts` independently. The "no cross-dependency" premise that justified the split was already violated by the time Phase 2 completed — `kernel/types.ts` imports 14 Datalog types for `RulePayload`.

**Resolution:** Phase 3.5 extracts `CnId`, `Value`, `PeerID`, `Counter`, `Lamport`, and `isSafeUint` into `base/types.ts`, following the precedent set by `base/result.ts`. Both `datalog/types.ts` and `kernel/types.ts` import from `base/types.ts` instead of defining their own copies. `CnIdRef` is deleted. The compile-time compatibility assertion originally planned for `projection.ts` is no longer needed — there's only one `Value` and one `CnId` now.

### Build-Order Artifacts Should Be Cleaned Up at Phase Boundaries

When phases are implemented sequentially and a later phase introduces a concept that an earlier phase had to approximate (e.g., Phase 1's `CnIdRef` approximating Phase 2's `CnId`), the approximation becomes dead weight once the real thing exists. If left uncleaned, these artifacts accumulate: two nominally-separate types that are "structurally compatible," workarounds like compatibility assertions, and comments explaining why the duplication is "acceptable." The fix is cheap — extract to a shared module — and the right time to do it is the next phase boundary, before downstream code (like `projection.ts`) has to bridge the gap. This is the same lesson as "Legacy Shims Infect Surviving Tests" applied to types rather than test code.

### Slot Identity Is a Kernel Concern, Not a Datalog Concern

Pre-Phase-4 research revealed that the `Slot` column in the spec's `active_value(CnId, Slot, Value, Lamport, Peer)` relation (§B.4) is not a mechanical flattening of a value constraint's `target` field. Slot identity depends on the **policy** of the parent node:

- **Map**: Slot = `(parent, key)`. Multiple `structure` constraints can independently create the same `(parent, key)` — they represent the same logical slot (§8.1). Value constraints targeting *any* of those structure constraints compete for the same slot via LWW.
- **Seq**: Slot = the target structure's own CnId (unique by definition). No competition between values.
- **Root**: Slot = `containerId`.

This means `projection.ts` must **join** each value constraint with its target structure constraint to derive the slot identity. Two approaches were considered: (A) compute the join in `projection.ts` as a kernel-side pre-processing step, emitting pre-flattened `active_value` tuples for Datalog; (B) emit raw relations and let Datalog rules perform the join. Approach A is correct because:

1. The spec's LWW rules treat `active_value` as a ground (input) relation, not a derived one.
2. Slot identity is Layer 0 (kernel policy semantics, §8) — it must not be expressible as a retractable Layer 1 rule, or an agent with `CreateRule` + `Retract` capabilities could break the reality.
3. The Phase 1 test doubles (which hardcode string slots like `'title'`) already assume pre-computed slots — the projection is the bridge that makes the test-double shape match the real shape.

The shared `structure-index.ts` module was introduced to compute slot groupings once and serve both `projection.ts` (slot identity for value resolution) and `skeleton.ts` (tree construction).

### Agent Refs Use Frontier Compression — Retraction Target-in-Refs Needs Care

The `Agent.currentRefs()` implementation compresses causal predecessors to the version vector frontier: one CnId per peer (the highest counter seen). This is semantically correct — the frontier implies the full causal history — and space-efficient. However, the retraction module's `target-in-refs` check verifies that the retraction's `target` CnId is literally present in the `refs` array. If an agent retracts a constraint at counter 5 but the frontier ref for that peer is at counter 10, the literal CnId `(peer, 5)` won't appear in refs.

This doesn't cause failures today because retraction tests use manually-constructed constraints with explicit refs. But Phase 5 integration tests — where an Agent produces a retraction constraint via `produceRetract()` — will exercise this path. The fix is either: (a) change `computeActive` to interpret refs semantically (any ref `(peer, N)` with `N ≥ target.counter` implies the target was observed), or (b) have `produceRetract()` explicitly add the target CnId to refs alongside the frontier. Option (a) is more principled; option (b) is simpler. **Decision: Option (a), implemented in Phase 4.6 task 4.6.1.** Semantic interpretation matches how version vectors work throughout the codebase and doesn't require special-casing in the Agent.

### Native Solvers Replaced the Datalog Path Instead of Optimizing It

Phase 4 implemented the pipeline with native LWW and Fugue solvers as the **sole** resolution path. The Datalog evaluator runs (when `enableDatalogEvaluation` is true) but its output is computed and discarded — the skeleton builder calls native `resolveLWWSlot()` and `orderFugueNodes()` directly and never consults Datalog-derived facts. The equivalence tests prove that both paths produce identical results, which masked the architectural problem: the implementation is not "native solvers as optimization" (§B.7) but "native solvers as replacement."

This contradicts the spec's fundamental architecture (§B.1): "LWW and Fugue are not part of the engine. They are Datalog rules that travel in the constraint store." The practical consequence is that rules-as-data is inert — retracting the default LWW rules and asserting custom resolution rules has no effect on the reality, because the native solver runs unconditionally. §B.7 constraint #3 explicitly requires: "If the reality's solver rules are retracted and replaced with custom rules, native solvers must fall back to Datalog evaluation for the replacement rules."

The root cause was a build-order artifact: Phase 4 needed the skeleton builder before bootstrap (Phase 5) could inject rules into the store, so the skeleton was written to use native solvers directly. The intent was to wire Datalog later, but the pipeline was declared complete without the wiring. Phase 4.5 corrects this by making Datalog evaluation the primary resolution path, with native solvers as a detected fast path (§B.7) that activates only when the active rules match known default patterns.

The broader lesson: when a spec says "X is data, not code," verify that the implementation actually reads X from the data path. An optimization that bypasses the data path entirely is not an optimization — it's a parallel implementation that breaks the data path's contract. Equivalence tests can prove the two paths agree but cannot prove the data path is actually wired into the output.

### Proving the Optimization Is Not Proving the Core

Phase 4.5 fixed the pipeline wiring so Datalog is primary and native solvers are a fast path. But post-Phase-4.5 research revealed the same structural problem one layer down: the Fugue *Datalog rules themselves* are a simplified subset (same-`originLeft` peer tiebreak only), while the native solver implements the full algorithm. The equivalence tests explicitly scope themselves to the "shared subset" and pass. This is the same anti-pattern in a different guise — the test proves that the optimization agrees with the core, but the core is incomplete.

The consequence is concrete: if bootstrap emits these simplified rules as the "default Fugue solver," the system's primary Datalog path produces wrong results for non-trivial sequence interleaving. The native fast path papers over the problem because it activates for default rules. But an agent that retracts the default rules and asserts *no* replacement falls back to Datalog with *no* Fugue rules at all — sequences become unordered. An agent that writes custom Fugue rules would need to independently discover the full algorithm, because the defaults don't demonstrate it.

Success Criterion #4 ("Fugue ordering expressed as Datalog rules produces identical results to the native Fugue solver") cannot be satisfied by subset equivalence. Phase 4.6 closes this gap by implementing complete Fugue rules and expanding equivalence tests to cover the full algorithm.

### Immutable API + Mutable Internals = Hidden O(n²)

The `ConstraintStore` was designed with an immutable external API (`insert()` returns a new store) backed by a clone-on-write internal strategy (`new Map(store.constraints)` on every mutation). This is a common functional-programming pattern, but without persistent data structures (structural sharing), it's O(n) per insert — and O(n²) for n sequential inserts. The `insertMany()` function mitigates this for batch operations (clone once, insert all), but the single-insert path is the one callers naturally reach for.

The `generation` counter already exists for cache invalidation, which means callers don't rely on reference identity to detect changes. This makes the switch to mutate-in-place safe: the store is logically a mutable container (like `Map` or `Set`), and the generation counter is the change-detection signal. The functional return-a-new-store API was unnecessary ceremony that imposed a real performance cost.

### Missing Test Files Are Technical Debt, Not Deferred Work

The plan listed `tests/kernel/skeleton.test.ts` as a Phase 4 deliverable (Directory Structure section). It was never created. The skeleton builder's behavior is tested indirectly through `pipeline.test.ts`, which is adequate for the happy path but doesn't localize bugs or cover edge cases (deeply nested maps, mixed map-in-seq, seq-in-seq, slot group merging across multiple peers). When a pipeline test fails, the developer must binary-search across 7 pipeline stages to find the bug. A focused skeleton test with hand-constructed inputs narrows the search to one module. Phase 4.6 adds it retroactively.

### Test Configs Should Match Production Defaults

All 25 pipeline tests set `enableDatalogEvaluation: false` in their `DEFAULT_CONFIG`, meaning they exercise only the native solver path. The Datalog-primary path — which is the spec's architecture and the production default — is tested only in the Phase 4.5 resolve tests. This means the most important code path (the one users will actually run) has the least integration-level coverage. Phase 4.6 flips the default to `true`, so every pipeline test exercises the real production path. A small focused group tests the native-only bypass explicitly.

### Canonical Rule Definitions Must Live in Production Code, Not Tests

Before Phase 5, the default LWW and Fugue rules were defined independently in four test files (`tests/datalog/rules.test.ts`, `tests/kernel/resolve.test.ts`, `tests/solver/lww-equivalence.test.ts`, `tests/solver/fugue-equivalence.test.ts`). Each copy was structurally identical but maintained separately. When the complete Fugue rules were introduced in Phase 4.6, only the equivalence test was updated — `resolve.test.ts` still used the old simplified 2-rule Fugue. This caused a subtle counter-collision bug during Phase 5 when the rule count changed from 5 to 11 (the custom Layer 2 rule in a fast-path detection test shared a CnId with the last default rule, silently deduplicating it away).

The fix: `bootstrap.ts` exports `buildDefaultLWWRules()`, `buildDefaultFugueRules()`, and `buildDefaultRules()` as the single source of truth. All test files import from bootstrap instead of defining their own copies. This is the same principle as Phase 3.5's shared type extraction — when multiple modules need the same definition, extract it to a shared location rather than maintaining parallel copies.

### Bootstrap Constructs Layer 1 Rules Directly — Agent Layer Guard Is Correct

`Agent.produceRule()` enforces `layer >= 2`, which initially appeared to be a blocker for bootstrap (which needs Layer 1 default rules). But this guard is architecturally correct: Layer 0–1 are kernel-reserved (§14), and user-facing Agents should not be able to create Layer 1 rules. Bootstrap is not a user action — it is the kernel itself setting up initial state. The solution is simple: `bootstrap.ts` constructs `RuleConstraint` objects directly with `layer: 1`, bypassing the Agent entirely. The `RulePayload.layer` type is `number` with no compile-time constraint, so the guard is purely runtime in `Agent.produceRule()`. The comment on `RulePayload` was updated to document both valid ranges: Layer 1 for bootstrap, Layer ≥ 2 for Agent-produced rules.
