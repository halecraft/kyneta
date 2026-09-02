# Future Work Catalog

**Status as of plan creation:** Phases 1–6 of [002-unified-ccs-engine.md](./002-unified-ccs-engine.md) are complete. 759 tests pass across 21 files. The engine implements the core of the [Unified CCS Engine Specification](../theory/unified-engine.md) — Layer 0 kernel, stratified Datalog evaluator, authority/validity, retraction/dominance, solver pipeline, native solver optimization (§B.7), reality bootstrap (§B.8), and multi-agent sync.

This document catalogs what was implemented, what was explicitly deferred, what the spec describes but remains unbuilt, and what extensions have been identified through implementation experience.

---

## 1. What's Done

### 1.1 Layer 0 Kernel (§B.2) — Complete

| Component | Module | Spec Section | Notes |
|-----------|--------|-------------|-------|
| CnId generation | `kernel/cnid.ts` | §1 | `(peer, counter++)`, monotonic |
| Lamport clock | `kernel/lamport.ts` | §1, §B.2 | Standard Lamport timestamp |
| Signature creation/verification | `kernel/signature.ts` | §1, §B.2 | **Stub** — always returns valid (see §2.1) |
| Constraint store | `kernel/store.ts` | §4 | CnId-keyed set, insert, set union merge, O(1) insert, generation counter |
| Version vector | `kernel/version-vector.ts` | §B.2 | Full VV operations, frontier compression, diff/merge |
| Authority replay | `kernel/authority.ts` | §5 | Walk authority constraints ≤ V, compute capabilities. Revoke-wins. |
| Valid(S) | `kernel/validity.ts` | §5.2–5.3 | Signature check + capability check per constraint |
| Retraction graph | `kernel/retraction.ts` | §6 | Graph construction, dominance via reverse topological traversal |
| Active(S) | `kernel/retraction.ts` | §6.3 | `{ c ∈ Valid(S) | dom(c) = active }`, semantic refs interpretation |
| S_V filtering | `kernel/pipeline.ts` | §7.1 | Version-parameterized solving via `filterByVersion` |
| Tree skeleton | `kernel/skeleton.ts` | §7.3 | Build rooted tree from active structure + resolved values + Fugue ordering |
| Structure index | `kernel/structure-index.ts` | §8 | Slot identity (map/seq/root), parent→child indexes |
| Projection | `kernel/projection.ts` | §7.2 | Active constraints → Datalog ground facts |
| Resolution bridge | `kernel/resolve.ts` | §B.4, §B.7 | Datalog derived facts → typed `ResolutionResult` |
| Solver pipeline | `kernel/pipeline.ts` | §7.2 | Full composition: S → S_V → Valid → Active → Index → Project → Evaluate → Resolve → Skeleton → Reality |
| Agent | `kernel/agent.ts` | §B.5 | Stateful constraint factory (counter, lamport, refs, observe) |

### 1.2 Six Constraint Types (§2) — Complete

| Type | Purpose | Retractable | Status |
|------|---------|-------------|--------|
| `structure` | Permanent tree node | Never | ✅ Implemented |
| `value` | Content at a node | Yes | ✅ Implemented |
| `retract` | Dominance assertion | Yes (enables undo/redo) | ✅ Depth-limited (configurable) |
| `rule` | Datalog solver rule | Yes | ✅ Layer 1 (bootstrap) + Layer 2+ (agent) |
| `authority` | Capability grant/revoke | Via revocation | ✅ Admin, Write, CreateRule, Retract, Grant |
| `bookmark` | Named causal moment | Yes | ✅ Type defined, producible, storable |

### 1.3 Datalog Evaluator (§B.3) — Complete

| Feature | Module | Notes |
|---------|--------|-------|
| Positive Datalog | `datalog/evaluate.ts` | Semi-naive fixed-point |
| Stratified negation | `datalog/stratify.ts` | SCC-based dependency graph, stratum ordering |
| Aggregation | `datalog/aggregate.ts` | min, max, count, sum |
| Guards | `datalog/unify.ts` | eq, neq, lt, gt, lte, gte — typed `GuardOp` discriminant |
| Wildcards | `datalog/unify.ts` | Anonymous term, never binds |
| Unification | `datalog/unify.ts` | Term matching with substitution |
| Value types | `base/types.ts` | int (bigint), float (number), string, bool, null, ref (CnId) |

### 1.4 Default Solver Rules (§B.4) — Complete

| Solver | Rules | Module | Notes |
|--------|-------|--------|-------|
| LWW | 3 rules | `bootstrap.ts` | `superseded` (by lamport, by peer tiebreak), `winner` |
| Fugue | 8 rules, 3 predicates | `bootstrap.ts` | `fugue_child`, `fugue_descendant`, `fugue_before` — full tree walk with `originRight` disambiguation |

Rules are canonical in `bootstrap.ts` — all test files import from there.

### 1.5 Native Solver Optimization (§B.7) — Complete

| Solver | Module | Fast-path detection |
|--------|--------|-------------------|
| LWW | `solver/lww.ts` | Activates when active rules match default LWW pattern |
| Fugue | `solver/fugue.ts` | Activates when active rules match default Fugue pattern |

Falls back to Datalog for custom/modified rules. Equivalence tests prove native == Datalog for all tested inputs.

### 1.6 Reality Bootstrap (§B.8) — Complete

`bootstrap.ts` exports `createReality()` which produces:
- Admin grant to creator
- Default LWW rules (3 rule constraints, Layer 1)
- Default Fugue rules (8 rule constraints, Layer 1)
- Configured retraction depth
- Pipeline config with Datalog evaluation enabled by default

### 1.7 Sync — Partial

| Feature | Status | Notes |
|---------|--------|-------|
| Delta computation | ✅ | `exportDelta(store, peerVV)` — constraints the peer hasn't seen |
| Delta import | ✅ | `importDelta(store, delta)` — merge via set union |
| Bidirectional sync | ✅ | Two rounds for concurrent agents (tested in integration) |
| Wire format | ❌ | No serialization — deltas are in-memory `Constraint[]` |
| Causal ordering on wire | ❌ | No topological sort for serialization |
| Full sync protocol | ❌ | No handshake, no version vector exchange protocol |

### 1.8 Test Coverage — 759 tests across 21 files

| Area | File | Tests |
|------|------|-------|
| Datalog | `aggregate.test.ts` | 42 |
| Datalog | `evaluate.test.ts` | 42 |
| Datalog | `rules.test.ts` | 23 |
| Datalog | `stratify.test.ts` | 35 |
| Datalog | `unify.test.ts` | 56 |
| Kernel | `agent.test.ts` | 54 |
| Kernel | `authority.test.ts` | 47 |
| Kernel | `cnid.test.ts` | 33 |
| Kernel | `lamport.test.ts` | 24 |
| Kernel | `pipeline.test.ts` | 29 |
| Kernel | `projection.test.ts` | 26 |
| Kernel | `resolve.test.ts` | 39 |
| Kernel | `retraction.test.ts` | 35 |
| Kernel | `skeleton.test.ts` | 26 |
| Kernel | `store.test.ts` | 56 |
| Kernel | `structure-index.test.ts` | 37 |
| Kernel | `validity.test.ts` | 22 |
| Kernel | `version-vector.test.ts` | 69 |
| Solver | `fugue-equivalence.test.ts` | 23 |
| Solver | `lww-equivalence.test.ts` | 11 |
| Integration | `integration.test.ts` | 30 |

---

## 2. Deferred Spec Features

These are features described in the spec that were intentionally deferred during Plan 002. They are ordered roughly by dependency (earlier items enable later ones).

### 2.1 Real ed25519 Signatures

**Spec:** §1, §B.2
**Current state:** `kernel/signature.ts` is a stub — `sign()` returns empty bytes, `verify()` always returns `true`.
**Impact:** Without real signatures, any peer can forge constraints as any other peer. The authority/validity pipeline is structurally correct but provides no actual security.
**What's needed:**
- ed25519 keypair generation (use a library like `@noble/ed25519` or `tweetnacl`)
- Canonical constraint encoding (deterministic serialization of `(id, lamport, refs, type, payload)`)
- Real `sign()` and `verify()` implementations
- PeerID becomes the public key (or hash thereof)
- Agent construction requires a private key
- Test updates: agents need keypairs, some tests may need to construct valid signatures

**Dependency:** None — self-contained replacement of `signature.ts` + canonical encoding.
**Complexity:** Medium. The interface is already correct; only the implementation changes. The canonical encoding is the hardest part (must be deterministic across languages for interop).

### 2.2 Incremental / Delta Evaluation

**Spec:** §9
**Current state:** Every `solve()` call recomputes the full pipeline from scratch. No delta tracking.
**Impact:** Performance — solving is O(|S|) per call instead of O(|Δ|).
**What's needed:**
- Track which constraints changed since last solve (the store's `generation` counter is a starting point)
- Incremental active set maintenance (§9.3): when a retract arrives, cascade dominance changes without re-walking the entire graph
- Incremental value resolution (§9.2): re-resolve only affected slots
- Incremental Datalog evaluation: semi-naive already computes deltas per stratum iteration; extend this to cross-solve deltas
- Incremental skeleton updates: add/remove nodes rather than rebuilding
- Delta propagation pipeline (§9.6): Δ_active → Δ_values → Δ_queries

**Dependency:** Useful independently, but becomes critical with settled/working sets (§2.3).
**Complexity:** High. Touches every pipeline stage. The naive approach (re-solve from scratch) is correct and serves as the reference — incremental must produce identical results.

### 2.3 Settled / Working Set Partitioning

**Spec:** §11
**Current state:** No stability frontier. No settled/working distinction. The solver examines the entire store on every call.
**Impact:** Performance at scale — without this, solver cost grows linearly with total reality size rather than being bounded to recent activity.
**What's needed:**
- Stability frontier computation (§11.1): exchange version vectors between agents to determine V_stable
- Settled slot detection (§11.2): slots where winning value + all competitors + retraction chains are ≤ V_stable
- Materialized snapshot of settled region
- Working set maintenance: solver operates only on the working set
- Frontier advancement (§11.5): as V_stable advances, move slots from working to settled
- Integration with incremental evaluation (§2.2)

**Dependency:** Requires multi-agent version vector exchange (protocol work). Benefits from incremental evaluation (§2.2). Required by compaction (§2.4).
**Complexity:** High. Requires distributed protocol for frontier computation.

### 2.4 Compaction

**Spec:** §12
**Current state:** The store grows without bound. No garbage collection.
**Impact:** Unbounded memory/storage growth. Not a problem for small realities or short sessions, but fatal for long-lived collaborative documents.
**What's needed:**
- Compaction policy per reality (§12.1): full history, snapshot-preserving, frontier-only
- Safe compaction rules (§12.2):
  - Dominated values below frontier with exhausted retraction depth → removable
  - Superseded values below frontier → removable
  - Retraction pairs below frontier → removable together
  - Structure constraints → **never** compacted (origin references)
  - Authority constraints → **never** compacted (validity depends on full chain)
- Deterministic compaction (§12.3): all agents must compact identically
- Snapshot preservation: compaction must not destroy preserved snapshots
- Tombstone handling for sequences: Fugue origin references may point to compacted constraints

**Dependency:** Requires settled/working set (§2.3) for frontier-based policies. Requires stability frontier protocol.
**Complexity:** Very high. Correctness is subtle — incorrect compaction breaks convergence. Tombstone handling for sequences is identified in LEARNINGS.md Open Question #1 as an unsolved problem.

### 2.5 Batching & Compact Encoding

**Spec:** §13
**Current state:** Constraints are individual in-memory objects. No batch encoding.
**Impact:** Wire efficiency — a text document with 10,000 characters produces 10,000 individual structure constraints and 10,000 value constraints. Batching reduces this to a small number of batches with shared metadata and a single signature.
**What's needed:**
- Batch encoding format (§13.2): shared peer, counter range, lamport range, refs, type; per-constraint payloads
- Batch signature: single ed25519 signature covers the entire batch
- Unbatching: any agent can expand a batch into individual constraints
- Consecutive CnId allocation (already supported — agents control their own counter space)
- Integration with wire format (§2.6)

**Dependency:** Requires real signatures (§2.1) — batching with stub signatures is pointless. Benefits from wire format (§2.6).
**Complexity:** Medium. The theoretical model is clear; the implementation is mostly serialization work.

### 2.6 Wire Format & Full Sync Protocol

**Spec:** §13, §15
**Current state:** `exportDelta()` and `importDelta()` work with in-memory `Constraint[]` arrays. No serialization. No wire protocol.
**Impact:** Cannot communicate with agents in other processes, machines, or languages.
**What's needed:**
- Constraint serialization (CBOR or MessagePack — both natively distinguish int/float, which is required by §3)
- Causal ordering on the wire (§15.2): topological sort so refs precede their dependents
- Delta sync protocol (§15.1): version vector exchange, delta computation, delivery
- Reliability guarantees: at-least-once delivery (the semilattice handles dedup and reordering)
- WebSocket/HTTP transport (application-level concern, not spec-level)

**Dependency:** Benefits from batching (§2.5). Independent of other deferred features.
**Complexity:** Medium-high. Serialization format must be deterministic for signature verification (if real signatures are in place). Protocol design is straightforward given the existing `exportDelta`/`importDelta` API.

### 2.7 Query Layer

**Spec:** §16
**Current state:** No query API. Callers traverse the `Reality` tree directly.
**What's needed:**
- **Level 1 — Queries over the Constraint Store** (§16.1): relational queries over `Constraints(id, type, payload, refs, peer, lamport)`. Standard operations: select, project, join, group, union, difference.
- **Level 2 — Queries over the Reality** (§16.2): `MapEntries(container, key, value, determined_by)`, `SeqElements(container, position, value, determined_by)`. The `determined_by` CnId bridges Level 2 back to Level 1 for provenance.
- **Incremental query evaluation** (§16.3): queries maintained via the delta pipeline. Follows DBSP algebraic framework.
- Version-parameterized queries: `query(S, V)` for historical queries.

**Dependency:** Benefits greatly from incremental evaluation (§2.2). Level 2 queries depend on the existing pipeline.
**Complexity:** Medium for basic queries; high for incremental maintenance.

### 2.8 Introspection API

**Spec:** §17
**Current state:** No introspection. The `ValidationError` and `RetractionViolation` types provide some diagnostic information, but there's no structured API for explain, conflicts, history, etc.
**What's needed:**
- `explain(path)` — why does the reality have this value here?
- `conflicts(path)` — active value constraints competing at a slot
- `history(path)` — all value constraints (active + dominated) for a slot, ordered by lamport
- `whatIf(constraints)` — non-destructive hypothetical solving
- `capabilities(agent)` — effective capabilities at current causal frontier
- `authorityChain(agent, capability)` — trace grant chain back to creator
- `rejected(agent?)` — constraints in S \ Valid(S) with reasons
- `at(V, query)` — any query at a historical version vector
- `diff(V₁, V₂)` — compare realities at two causal moments
- `bookmarks()` — all active bookmark constraints
- `branch(V)` — create virtual agent at historical moment

**Dependency:** Version-parameterized solving already works. `whatIf` and `branch` are straightforward given the pure-function pipeline. Query layer (§2.7) would make these more expressive.
**Complexity:** Medium per function. Large surface area but each function is relatively self-contained.

### 2.9 Bookmark / Time-Travel UX

**Spec:** §10
**Current state:** `bookmark` is a defined constraint type and can be produced/stored. `solve(store, config)` already accepts an optional version vector for time travel. But there is no snapshot caching, no incremental time scrubbing, and no named-bookmark lookup.
**What's needed:**
- **Snapshots** (§10.1): materialized `(V, Reality)` pairs, cached. Nearest-snapshot + incremental delta for efficient historical queries.
- **Incremental time scrubbing** (§10.2): forward scrubbing via deltas, backward via nearest snapshot checkpoint.
- **Named time travel** (§10.4): look up a bookmark constraint, extract its version vector, solve at that moment.
- Snapshot creation policies: on frontier advancement, at lamport intervals, at bookmark creation, on demand.
- Branching UX: wrapping the existing agent-at-historical-VV pattern in a convenient API.

**Dependency:** Benefits from incremental evaluation (§2.2). Named lookup depends on bookmark constraints being queryable (trivial today — filter by type). Snapshots benefit from settled/working sets (§2.3).
**Complexity:** Medium. The core primitive (`solve(S, V)`) already works. This is UX and caching.

### 2.10 Path-Based Capability Checks

**Spec:** §5 (implied)
**Current state:** Authority uses a simplified model — `Admin` covers all paths, capabilities use wildcard paths. The `NOTES.md` entry notes "we're currently using a simplified containment check without wildcards for permissions."
**What's needed:**
- Capability checks that respect the tree structure: "Agent X can write to `/profile/name` but not `/profile/email`"
- This requires the skeleton to resolve a constraint's target path — creating a circular dependency: validity → skeleton → validity
- Likely solution (from LEARNINGS.md Open Question #7): two-pass approach (first pass with simplified checks, build skeleton, second pass with path-aware checks) or use the structure index (which is built from active constraints) for path information without the full skeleton

**Dependency:** Requires the skeleton or structure index (both already exist). Requires design work to resolve the circular dependency.
**Complexity:** Medium-high. The circular dependency is the hard part, not the check itself.

---

## 3. Known Technical Debt & Improvements

Items identified in NOTES.md, LEARNINGS.md, and the plan's own notes that aren't spec features but would improve the codebase.

### 3.1 Convenience DSL for Rule Construction

**Source:** Plan 002 task 6.5 (deferred), API Ergonomics §"Remaining Verbosity"
**Current state:** Rules are constructed via deeply nested factory calls:
```
rule(atom('p', [varTerm('X')]), [positiveAtom(atom('q', [varTerm('X'), _]))])
```
**Desired:** A tagged template literal or parser:
```
datalog`p(X) :- q(X, _).`
```
**Complexity:** Medium. Requires a parser for Datalog syntax → AST. The AST types already exist.

### 3.2 Convergent Insert for Seq-in-Map

**Source:** NOTES.md — "have we solved the convergent insert problem for seq containers inside map containers?"
**Question:** Two peers concurrently insert into a map-contained list that neither knows about. Do both items get inserted?
**Status:** Needs investigation and testing. The structure permanence guarantee means both structure constraints survive, but the interaction between map slot identity and seq ordering in this scenario may have edge cases.

### 3.3 Text as List\<char\> with Myers Diff

**Source:** NOTES.md — "Loro's text.update(str) natively applies Myers diff, that's cool, we should do it too." LEARNINGS.md — "Text Is Truly Just List\<char\> — No Separate Solver Needed."
**Current state:** No text-specific API. Text is theoretically List\<char\> but creating one character constraint per character is verbose.
**What's needed:**
- A `Text` convenience wrapper that produces seq structure + value constraints for each character
- `text.update(newStr)` that computes a Myers diff and emits minimal constraint changes
- Run-length encoding consideration (LEARNINGS.md Open Question #4): storing "hello" as one constraint instead of five would dramatically reduce constraint count, but the solver would need to handle span splitting

**Complexity:** Medium for the wrapper; high for run-length encoding (changes the constraint model).

### 3.4 Algorithm Simplification Opportunities

**Source:** NOTES.md — "are there opportunities for simplification by implementing well-known algorithms? for example reverse topological traversal in computeActive"
**Status:** The current algorithms are correct. This is a code quality pass — replacing ad-hoc traversals with named, well-known algorithms where applicable.

### 3.5 Cross-Container Constraints

**Source:** LEARNINGS.md Open Question #3, TECHNICAL.md Future Work
**Question:** "Can cross-container constraints be made to work? E.g., 'if key X exists in Map A, then key Y must exist in Map B.'"
**Current state:** The solver operates per-container. Cross-container reasoning would require rules that join across containers.
**What's needed:** Solver rules that can reference multiple containers. The Datalog evaluator already supports multi-predicate joins, so this is largely a projection/modeling question.

### 3.6 Rich Text Marks

**Source:** TECHNICAL.md Future Work
**Description:** Bold, italic, etc. as mark constraints with anchor resolution. Requires design work on how marks interact with the Fugue tree (marks span ranges, but ranges are defined by tree positions that may be concurrently modified).

### 3.7 Performance Profiling

**Source:** LEARNINGS.md Open Question #2
**Question:** "What is the performance ceiling? Naive solving is O(n) in constraint count per path query. The Fugue tree rebuild is O(n log n) for n elements."
**Status:** No profiling has been done. The current implementation prioritizes correctness. Performance work should follow profiling, not precede it.
**Related:** `askPrefix` identified as likely bottleneck for text (LEARNINGS.md).

### 3.8 Caching Strategy for Fugue Trees

**Source:** LEARNINGS.md Open Question #5
**Question:** "What's the right caching strategy for Fugue trees? Rebuilding the tree on every solve is expensive for large lists."
**Status:** The store generation counter approach is in place for general cache invalidation, but no Fugue-specific caching exists yet.
**Dependency:** Benefits from incremental evaluation (§2.2).

---

## 4. Spec Sections vs Implementation Status

A section-by-section map of the spec to implementation status.

| Spec Section | Title | Status | Notes |
|-------------|-------|--------|-------|
| §1 | Constraints | ✅ | All fields, CnId, lamport, refs, sig (stub) |
| §2 | Constraint Types | ✅ | All six types implemented |
| §3 | Values | ✅ | int, float, string, bool, null, ref — int/float distinguished |
| §4 | Constraint Store | ✅ | CnId-keyed, insert, merge, O(1) insert |
| §5 | Authority & Validity | ✅ | Simplified path checks (wildcard). Full path-based checks deferred. |
| §6 | Retraction & Dominance | ✅ | Configurable depth, semantic refs, memoized dominance |
| §7 | The Solver | ✅ | Full pipeline, version-parameterized |
| §8 | Policies | ✅ | Map (key-based slots) and Seq (CnId-based slots) |
| §9 | Incremental Maintenance | ❌ | Full re-solve each time (§2.2) |
| §10 | Time Travel | 🟡 | `solve(S, V)` works; no snapshots, scrubbing, or named travel (§2.9) |
| §11 | Settled & Working Sets | ❌ | No stability frontier or partitioning (§2.3) |
| §12 | Compaction | ❌ | Store grows without bound (§2.4) |
| §13 | Batching & Compact Encoding | ❌ | No batch format (§2.5) |
| §14 | Stratification | ✅ | Layer 0 (kernel), Layer 1 (bootstrap rules), Layer 2+ (agent rules) |
| §15 | Messages & Sync | 🟡 | In-memory delta sync works; no wire format or protocol (§2.6) |
| §16 | Query Layer | ❌ | No query API (§2.7) |
| §17 | Introspection | ❌ | No introspection API (§2.8) |
| §18 | Invariants & Guarantees | 🟡 | Core invariants hold; incremental/settled/compaction invariants not yet relevant |
| §B.1 | The Engine | ✅ | Kernel + Datalog evaluator |
| §B.2 | Layer 0 — Kernel | ✅ | All 13 components |
| §B.3 | Datalog Evaluator | ✅ | Stratified, semi-naive, with aggregation |
| §B.4 | Default Solver Rules | ✅ | LWW (3) + Fugue (8), canonical in bootstrap.ts |
| §B.5 | The Minimal Agent | ✅ | Items 1–8 implemented (sig is stub) |
| §B.6 | What Travels in the Store | ✅ | Constraints + rules travel; engine is local |
| §B.7 | Native Solver Optimization | ✅ | LWW + Fugue fast paths with fallback |
| §B.8 | Reality Bootstrap | ✅ | `createReality()` with admin + rules + config |

---

## 5. Suggested Prioritization

Based on dependency ordering and practical impact:

### Tier 1 — Enables Real-World Use

1. **Real ed25519 signatures** (§2.1) — Without this, there is no security. Any peer can impersonate any other. This is the single most important gap for any deployment beyond local testing.
2. **Wire format & sync protocol** (§2.6) — Without this, agents can't communicate across processes. The engine is confined to in-memory, single-process use.
3. **Path-based capability checks** (§2.10) — Without this, authority is all-or-nothing (`Admin` or nothing useful). Fine-grained permissions are needed for multi-user collaboration.

### Tier 2 — Enables Scale

4. **Incremental evaluation** (§2.2) — Required for performance with large realities. Currently the bottleneck.
5. **Settled/working set partitioning** (§2.3) — Bounds solver cost. Requires incremental evaluation.
6. **Compaction** (§2.4) — Required for long-lived realities. Requires settled sets.

### Tier 3 — Enables Rich Applications

7. **Query layer** (§2.7) — Enables application-level queries without manual tree traversal.
8. **Introspection API** (§2.8) — Enables conflict resolution UIs, audit trails, explain.
9. **Time travel UX** (§2.9) — Snapshot caching, named bookmarks, scrubbing.
10. **Convenience DSL** (§3.1) — Developer experience for rule construction.

### Tier 4 — Enables Advanced Use Cases

11. **Batching** (§2.5) — Wire efficiency for text-heavy documents.
12. **Text wrapper / Myers diff** (§3.3) — Ergonomic text editing.
13. **Cross-container constraints** (§3.5) — Referential integrity, computed values.
14. **Rich text marks** (§3.6) — Bold, italic, etc.

---

## 6. Open Questions (from LEARNINGS.md)

These are unresolved design questions that need answers before or during implementation of the deferred features:

1. **Can constraint compaction be made safe in a decentralized system?** Compacting requires knowing what all peers have seen. Tombstone compaction for sequences is especially tricky due to Fugue origin references. (Blocks §2.4)

2. **What is the performance ceiling?** No profiling done. Naive solving is O(n) in constraint count. Fugue tree rebuild is O(n log n). (Informs §2.2 prioritization)

3. **Can cross-container constraints be made to work?** Requires solver reasoning across containers. (§3.5)

4. **How should Text differ from List?** Run-length encoding could dramatically reduce constraint count but changes the solver model. (§3.3)

5. **What's the right caching strategy for Fugue trees?** Invalidation is complex. (§3.8)

7. **When should path-based capability checks be implemented?** Two-pass approach or structure-index-based? (§2.10)

---

## 7. Module Inventory

For reference — the complete set of production and test modules:

### Production Code (22 files)

```
src/
├── base/
│   ├── result.ts              Result<T, E> type
│   └── types.ts               CnId, Value, PeerID, Counter, Lamport, isSafeUint
├── datalog/
│   ├── aggregate.ts           min, max, count, sum
│   ├── evaluate.ts            Semi-naive fixed-point evaluation
│   ├── index.ts               Barrel export
│   ├── stratify.ts            Dependency graph, SCC, stratum ordering
│   ├── types.ts               Atoms, terms, rules, facts, relations
│   └── unify.ts               Unification, substitution, guards
├── kernel/
│   ├── agent.ts               Stateful constraint factory
│   ├── authority.ts           Capability chain replay
│   ├── cnid.ts                CnId creation, comparison, serialization
│   ├── index.ts               Barrel export
│   ├── lamport.ts             Lamport clock operations
│   ├── pipeline.ts            Full solver pipeline composition
│   ├── projection.ts          Active constraints → Datalog facts
│   ├── resolve.ts             Datalog results → ResolutionResult
│   ├── retraction.ts          Retraction graph, dominance, Active(S)
│   ├── signature.ts           Stub ed25519 (always valid)
│   ├── skeleton.ts            Reality tree builder
│   ├── store.ts               Constraint store
│   ├── structure-index.ts     Slot identity, parent→child indexes
│   ├── types.ts               Six constraint types, Reality, etc.
│   ├── validity.ts            Valid(S): sig + capability check
│   └── version-vector.ts      Version vector operations
├── solver/
│   ├── fugue.ts               Native Fugue tree walk
│   └── lww.ts                 Native LWW max_by
├── bootstrap.ts               createReality(), default rules
└── index.ts                   Public API
```

### Test Code (21 files)

```
tests/
├── datalog/
│   ├── aggregate.test.ts      42 tests
│   ├── evaluate.test.ts       42 tests
│   ├── rules.test.ts          23 tests
│   ├── stratify.test.ts       35 tests
│   └── unify.test.ts          56 tests
├── kernel/
│   ├── agent.test.ts          54 tests
│   ├── authority.test.ts      47 tests
│   ├── cnid.test.ts           33 tests
│   ├── lamport.test.ts        24 tests
│   ├── pipeline.test.ts       29 tests
│   ├── projection.test.ts     26 tests
│   ├── resolve.test.ts        39 tests
│   ├── retraction.test.ts     35 tests
│   ├── skeleton.test.ts       26 tests
│   ├── store.test.ts          56 tests
│   ├── structure-index.test.ts 37 tests
│   ├── validity.test.ts       22 tests
│   └── version-vector.test.ts 69 tests
├── solver/
│   ├── fugue-equivalence.test.ts 23 tests
│   └── lww-equivalence.test.ts   11 tests
└── integration.test.ts        30 tests
```
