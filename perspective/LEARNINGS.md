# Learnings: Convergent Constraint Systems (CCS) and Prism

## Architectural Shift: v0 → Unified CCS Engine

### The Prototype's Value Was Knowledge, Not Code

The v0 prototype (Plan 001, 476 tests) validated the CCS thesis conclusively. But when the Unified CCS Engine Specification was written, it became clear that evolving the prototype incrementally would produce a chimera — half path-based addressing, half CnId-based; half hardcoded solvers, half rules-as-data. A clean rewrite aligned with the formal spec is the correct path. The prototype's lasting contribution is the *understanding* it produced, not the code.

### Rules-as-Data Eliminates Most of the Existing Ecosystem

We evaluated every plausible Datalog implementation in both the npm and Rust/WASM ecosystems. The spec's requirement that solver rules (LWW, Fugue) travel in the constraint store as data — and are evaluated at runtime by new agents joining a reality — eliminates all compile-time/proc-macro approaches (Rust's `ascent`, `crepe`) and all packages that impose their own storage model (DataScript). A custom ~800-1200 line TypeScript evaluator is the right answer: zero external deps, full control, and the spec's native solver optimization (§B.7) means it only handles the general case anyway.

### WASM Datalog Is Premature Optimization

Rust WASM was seriously evaluated. The FFI boundary cost (~100-200ns per crossing) is significant when iterating over many small Datalog tuples. You'd need to batch the entire evaluation on the WASM side, duplicating the constraint store in WASM memory. The spec already provides the performance escape hatch: native TypeScript solvers (§B.7) for LWW and Fugue, which handle 99% of evaluation time. WASM should only be reconsidered if general-case Datalog evaluation (custom rules, schema mappings) becomes a measured bottleneck.

### CnId-Based Addressing Changes Everything

The shift from path-based addressing (`["profile", "name"]`) to CnId-based addressing (`{peer, counter}` with causal `refs`) is not incremental — it changes the fundamental data model. Paths are human-readable but conflate identity with location. CnIds are opaque but uniquely identify each assertion in the causal history. This enables retraction-as-assertion (you retract a specific CnId, not "the value at a path"), authority checking (you verify the asserter of a specific CnId had capability at that causal moment), and time travel (you filter the store to CnIds ≤ a version vector).

### f64-Only Numerics Break Cross-Language Convergence

The original spec used `f64` as the sole numeric type for user values ("all numbers"). This creates a silent convergence hazard. JavaScript's `number` is IEEE 754 f64, which can only exactly represent integers up to 2^53 − 1. A Rust agent storing a 64-bit database row ID (e.g., `2^53 + 1`) as a user value would have it silently truncated to `2^53` by a JavaScript agent — and the two agents would compute *different realities from the same store*. Convergence broken.

The fix splits numeric concerns in two:

- **Structural fields** (counter, lamport, layer): `safe_uint` — plain `number` in JS, constrained to ≤ 2^53 − 1. No single agent will assert 9 quadrillion constraints, so this is not operationally limiting. Enforced at Agent construction and store insertion.
- **User values**: `int` (maps to `bigint` in JS, `i64`+ in Rust) and `float` (maps to `number` in JS, `f64` in Rust). These are **distinct types** — `int(3)` ≠ `float(3.0)`. This avoids a class of bugs where integer identity is lost through float coercion. Wire formats (CBOR, MessagePack) natively distinguish integers from floats.

The complexity is contained to three modules: `datalog/unify.ts` (term matching must not unify `number` with `bigint`), `datalog/aggregate.ts` (sum/max/min must handle each type; mixed-type aggregation is a type error), and `kernel/projection.ts` (assembles Datalog facts from constraint fields). Everything else passes `Value` through opaquely. This discovery prompted an update to unified-engine.md §3 to replace the single `f64` type with separate `int` and `float`.

### Retraction-as-Assertion Is More Powerful Than Deletion

The prototype used a `deleted` assertion at a path, competing via LWW with non-deleted values. The spec's `retract` constraint targets a specific CnId and creates a dominance relationship in an acyclic retraction graph. This gives: (1) undo via retract-of-retract, (2) causal retraction (you can only retract what you've observed — `target` must be in `refs`), (3) the solver never sees retractions — it operates on `Active(Valid(S))` which has already resolved all dominance. Much cleaner separation of concerns.

## Facts

### The Duality Between State-Based and Constraint-Based CRDTs

State-based CRDTs and constraint-based CRDTs are mathematically dual. They have identical expressive power and identical convergence guarantees. The difference is where complexity lives:

- **State-based**: Complex merge function, simple state access
- **Constraint-based**: Trivial merge (set union), complex solver

Every state-based CRDT can be mechanically rewritten as a constraint-based one and vice versa. This was confirmed empirically: Prism's Map solver with LWW resolution produces identical results to Loro's `MapState` for all tested operation sequences, including concurrent writes, deletions, resurrections, and multi-peer merge orderings.

### The Semilattice Doesn't Disappear—It Moves

A common misconception: "constraint-based means we don't need a lattice." Wrong. CCS still requires a join-semilattice. The difference is that the lattice is on **constraint sets** (powerset with union: `(P(C), ⊆, ∪)`) rather than on states. This lattice is trivially valid for any set of constraints, which is why merge becomes trivial. But the *solver* must be deterministic and total, or convergence breaks.

### Merge Is Genuinely Trivial—281 Tests Confirm It

Constraint union is commutative, associative, and idempotent by construction. We tested this with all permutations of 5-peer concurrent writes for both Map and List containers. Every merge order produces the same result. This is not a property we had to "engineer"—it falls directly from set union semantics. The 281 passing tests include explicit commutativity, associativity, and idempotence assertions for both container types.

### Fugue Semantics Are Fully Expressible as Constraints

The Fugue sequence CRDT (Weidner & Kleppmann 2023) can be implemented in a constraint-based system. Each list element becomes a `seq_element` constraint containing:

```typescript
interface SeqElementAssertion {
  type: 'seq_element';
  value: unknown;              // The element value
  originLeft: OpId | null;     // Element to the left when inserted
  originRight: OpId | null;    // Element to the right when inserted
}
```

The solver reconstructs the Fugue tree from these constraints and computes the total ordering. This proves that even sophisticated interleaving algorithms like Fugue fit the CCS model—the algorithm moves entirely into the solver.

### Peer ID Tiebreakers Go Opposite Directions for Map vs List

This is a critical detail that's easy to get wrong:

- **Map (LWW)**: Higher peer ID wins (standard LWW convention)
- **List (Fugue)**: Lower peer ID goes left (first)

The reasoning: for text, consistent left-to-right ordering of concurrent inserts is more natural. If Alice and Bob both type at the same position, having Alice's text consistently appear first (assuming "alice" < "bob" lexicographically) produces predictable results.

## New Findings and Insights

### Intention Preservation Is Orthogonal to Convergence

We explored how "intentions" (e.g., "lowercase this word" vs. "delete and reinsert lowercase") are lost in syntactic CRDTs. Key finding: **intentions are fractal**—they exist at every scale from keystrokes to architectural decisions. There is no natural "right scale" for an intention algebra.

CRDTs (both state-based and constraint-based) operate at the syntactic level. Intentions can be layered on top via:
1. **Inference** (heuristic, lossy)
2. **Tagged operations** (metadata alongside syntactic ops)
3. **A separate intention log** (synced as a parallel CRDT)
4. **Scoped intentions** with explicit violation policies

None of these approaches require changes to the convergence substrate.

### Constraints Enable Introspection That State-Based CRDTs Cannot

Because constraints are preserved (not collapsed into state), you can answer "why is this value X?" by tracing back to the winning constraint and its losers. This is implemented in the `SolvedValue` type:

```typescript
interface SolvedValue<T> {
  value: T | undefined;
  determinedBy: Constraint | undefined;  // The winner
  conflicts: readonly Constraint[];       // The losers
  resolution: string;                     // Human-readable explanation
}
```

State-based CRDTs lose this information during merge. Once two states are joined, you cannot reconstruct which peer contributed which value or what was overwritten.

### Schema Evolution Becomes Radically Simpler

In the constraint model, schema is *interpretation*, not structure. The constraint store is schema-agnostic—it holds path/assertion pairs. A "schema" is just a lens/view over those constraints. This means:

- Multiple schema versions can coexist indefinitely
- Migration = adding mapping constraints (not transforming data)
- Unknown fields from newer schemas are preserved by older peers
- Peers upgrade their view independently, without coordination

This eliminates the hardest part of distributed schema evolution: **coordination**.

### Element Paths Must Include Element IDs for Deletion to Work

A critical implementation detail for List containers: **element paths must encode the element's OpId**.

The naive approach—using the list path for all elements—fails because:
1. The constraint store deduplicates by OpId
2. A delete constraint needs a unique ID (it's a new operation)
3. But it must target a specific element

The solution is to include the element's OpId in its path:

```typescript
// Element path: [listPath, opIdToString(elemId)]
const elemPath = [...listPath, `${peer}@${counter}`];

// Insert constraint at element path
createConstraint(peer, counter, lamport, elemPath, seqElement(value, originLeft, originRight));

// Delete constraint also at element path (but with its own new OpId)
createConstraint(deletingPeer, newCounter, newLamport, elemPath, deleted());
```

This allows multiple constraints (the original `seq_element` and any `deleted` assertions) to coexist at the same logical element.

### Fugue's originRight Comparison Creates a Circular Dependency

When sorting siblings in the Fugue tree, you compare their `originRight` positions. But the position of an `originRight` element depends on how *its* siblings are sorted—which may include the elements you're currently trying to sort.

The solution is a **preliminary position map**: first sort siblings using a simpler heuristic (originRight's counter as proxy for position), then use that ordering to resolve the actual comparisons. This breaks the circularity while preserving correctness for well-formed constraint sets.

```typescript
function sortSiblings(siblings, nodeMap) {
  // Build preliminary positions first
  const positionMap = buildPositionMap(siblings, nodeMap);
  // Then sort using those positions for originRight comparison
  siblings.sort((a, b) => compareFugueNodes(a, b, nodeMap, positionMap));
}
```

### The "Visited Set" Algorithm Is Not Always Necessary

The full Fugue algorithm includes a "visited set" walk for handling cases where one sibling's `originLeft` is a descendant of another's. In practice, for constraints generated by a well-behaved handle (which always uses the current solved state to compute origins), this case doesn't arise.

We implemented a simpler comparison that handles:
1. Same originRight → lower peer ID goes left
2. Different originRight → compare positions (further-left originRight goes first)
3. Null originRight (end of list) → goes after non-null

This passes all equivalence tests against `loro-crdt`. The full visited-set algorithm would be needed for adversarial or malformed constraint sets.

### CCP "Ask/Tell" Terminology Maps Cleanly

From Concurrent Constraint Programming (Saraswat): `tell` adds constraints, `ask` queries entailment. This maps directly to our API:
- `tell(store, constraint)` → adds a constraint, returns updated store
- `ask(store, path)` → returns constraints for a path
- `solve(constraints, path)` → computes the satisfying state

The CCP literature (especially around monotonic stores) is the most relevant theoretical foundation for CCS, more so than OT or even traditional CRDT papers.

## Corrections to Previous Assumptions

### "Conflict Resolution" and "Merge Strategy" Are Different Things

Early in exploration, we conflated these. They are distinct:

- **Merge strategy**: How constraint sets are combined. In CCS, this is **always** set union. It is not configurable—it *is* the definition.
- **Conflict resolution**: How the *solver* picks a winner when constraints disagree. This is pluggable (LWW, multi-value, Fugue interleaving, etc.).

Getting confused here leads to architecturally wrong decisions. Merge is fixed; resolution is flexible.

### Ordering Guarantees Are Not Needed for Correctness

Initial instinct was that we might need causal ordering for constraint delivery. We don't. Because merge is set union (commutative, associative, idempotent), constraints can arrive in **any order**, **any number of times**, and the result is identical. This is a significant simplification over systems that require causal delivery.

Version vectors are still useful for *sync efficiency* (computing deltas), but they are not required for *correctness*.

### The Constraint Store Grows Unboundedly (Without Compaction)

Every operation adds constraints that are never removed. For a production system, constraint compaction is essential. For LWW Maps, dominated constraints (lower Lamport for the same path) can be safely removed *after* all peers have seen them. But:

- Compaction must be deterministic across replicas
- Introspection loses history after compaction
- Conflict visibility disappears when losers are compacted

For Lists, tombstones (deleted elements) **cannot be compacted** if any peer might still reference them as `originLeft` or `originRight` in a future insert. This is a fundamental constraint of Fugue's design.

### Separate `before`/`after` Assertions Are Insufficient for Lists

The original plan used separate `after` constraints for ordering. Research into the Fugue paper revealed this is insufficient:

- Fugue requires **both** `originLeft` AND `originRight` for interleaving resolution
- When concurrent inserts share the same `originLeft`, Fugue compares their `originRight` positions
- Separate constraints would require correlating two constraints per element, with atomicity concerns

The solution is a compound `seq_element` assertion that captures all Fugue metadata in one constraint. This matches Fugue's `FugueSpan` structure: `(id, content, originLeft, originRight, status)`.

### Immutable Store Pattern Has Practical Ergonomic Cost ✅ (Resolved in Phase 4.6)

The v0 constraint store was immutable (each `tell` returns a new store), which created friction in the handle layer. The unified engine initially continued this pattern: `insert()` returned `Result<ConstraintStore, InsertError>`, cloning the entire `Map` on every insert — O(n) per operation, O(n²) for n sequential inserts.

**Resolved**: Phase 4.6 switched to mutate-in-place. `insert()` returns `Result<void, InsertError>` and mutates the store directly. The `generation` counter (which already existed for cache invalidation) serves as the change-detection signal. `mergeStores()` still returns a new store (both inputs survive). This eliminated the clone cost and simplified all call sites — no more `store = insert(store, c).value!` threading.

### Views Are Stateless Snapshots, Not Live Projections

Views close over the store reference from construction time. Since the store is immutable (`tell` returns a new store), a view never sees new constraints. Handles work around this by creating a fresh view on every `.view()` call (no cached view). This means:

- `handle.view()` always re-solves (correct but potentially expensive)
- Holding a view reference across mutations gives stale data (by design)
- ReactiveViews exist for the "notifiable" pattern but require explicit `updateStore()` + `notifyConstraintsChanged()` wiring

This is acceptable for the experimental phase. PrismDoc (Phase 6) will manage the wiring.

### ReactiveView Needs Explicit Store Updates

The reactive view pattern requires the caller to explicitly call `updateStore(newStore)` and `notifyConstraintsChanged(added)` after mutations. It does **not** automatically observe the constraint store. This is intentional (the store is immutable and has no built-in observation), but it means the "reactive" label is slightly misleading—it's more "notifiable" than "reactive." A future `PrismDoc` coordinator will automate this wiring.

### Peer ID Ordering Must Be Consistent Across Systems for Equivalence

Prism uses string peer IDs compared lexicographically. Loro uses numeric (BigInt) peer IDs compared numerically. When Fugue breaks ties by peer ID (same `originLeft` + same `originRight`), the two systems will disagree unless the numeric IDs preserve the same relative ordering as the string IDs.

This was discovered when we added true Loro comparison to concurrent list tests: Prism produced `["A", "B"]` (alice < bob lexicographically) while Loro produced `["B", "A"]` (because `hashPeerId("bob") < hashPeerId("alice")` numerically with the original hash function).

**Solution:** Equivalence tests use `peerIdToNum()` — a function that encodes the first 6 characters of a string as a base-256 number. Because character codes preserve lexicographic ordering when interpreted as base-256 digits, `peerIdToNum("alice") < peerIdToNum("bob")` holds. This is only needed for testing; in production, a single system would use one ID type consistently.

**Implication for Phase 4 (Text):** The same `peerIdToNum()` helper must be used in text equivalence tests.

### Caching Requires a Store Generation Counter ✅ (Implemented)

The original view cache used `constraints.size` as an invalidation proxy. This was unsound: if a constraint were ever replaced (same size) or if caching were per-path, a size check would miss invalidation. The cache was removed entirely in favor of fresh solves on every access.

**Solution implemented:** The `ConstraintStore` now has a `generation: number` field that increments on every mutation (`tell()`, `tellMany()`, `mergeStores()`). Use `getGeneration(store)` to compare against a cached generation value. If they differ, the cache is stale.

```typescript
// Caching pattern
let cachedGeneration = getGeneration(store);
let cachedValue: T | null = null;

function getValue(): T {
  if (getGeneration(store) !== cachedGeneration) {
    cachedValue = computeExpensiveValue(store);
    cachedGeneration = getGeneration(store);
  }
  return cachedValue!;
}
```

This enables correct caching when performance optimization is needed.

### `askPrefix` Will Be the Performance Bottleneck for Text

`askPrefix` scans all constraints in the store and checks `pathStartsWith` for each. The `byPath` index is exact-match only. For a 10,000-character text document, that's 10,000+ constraints scanned linearly on every solve. Combined with the O(n log n) Fugue tree rebuild, this will dominate latency. A trie or sorted path index would help but is not needed at current scale. Worth noting for Phase 4 design.

### Dead Abstractions Should Be Removed Immediately in Experiments

The `HandleContext`/`MutableHandleContext` abstraction was designed for a future `PrismDoc` that didn't exist yet. It sat unused while both `MapHandle` and `ListHandle` implemented their own internal state management with closures. Similarly, `SolverRegistry`/`createSolverRegistry`/`createNoOpSolver` were designed for a PrismDoc-level solver dispatch that was never built. Both were dead code that added confusion. In an experiment, delete speculative abstractions rather than leaving them for "when we need them" — if the need arises, they can be rebuilt to fit the actual shape of the problem.

### Text Is Truly Just List<char> — No Separate Solver Needed

The original plan called for a `TextSolver` that wraps `ListSolver`. In practice, this was unnecessary indirection. `TextView` can use `ListSolver` directly and join the character values into a string. The "solver" for text IS the list solver — the only difference is presentation (array vs string). This reinforces the principle: don't add abstractions until you have a concrete reason.

### Unicode Requires Codepoint Iteration, Not String Indexing

JavaScript's `string[i]` gives UTF-16 code units, not Unicode codepoints. For emoji like "🎉" (which is two UTF-16 code units), this would create two constraints instead of one. The solution is to use `[...text]` spread syntax, which iterates by codepoint:

```typescript
// Wrong: "🎉".length === 2, and "🎉"[0] === "\uD83C"
for (let i = 0; i < text.length; i++) { ... }

// Correct: [...\"🎉\"].length === 1, and [...\"🎉\"][0] === "🎉"
for (const char of [...text]) { ... }
```

This matches Loro's behavior where each Unicode codepoint is one element.

### Replace Semantics Can Differ Between Implementations

A `replace(pos, len, text)` operation is semantically "delete range, then insert". However, the order of constraint creation (all deletes first, then all inserts) can affect interleaving with concurrent operations. In testing, we found one edge case where Prism and Loro produced different results for a concurrent replace + insert scenario. This isn't a bug — it's a consequence of `replace` being a compound operation. For equivalence testing, we focused on primitive operations (insert, delete) which have unambiguous semantics.

## Phase 2: Kernel Types and Store

### Refs Must Be Computed Before VV Update — Ordering of Side Effects Matters

When an Agent produces a constraint, it must (1) compute the causal refs (what it has observed), (2) allocate a CnId, (3) tick the Lamport clock, and (4) update its own version vector. The initial implementation did steps 2–4 *before* step 1, meaning the new constraint's own CnId appeared in its own `refs` — a causal impossibility (a constraint cannot observe itself). The fix: capture refs *before* any state mutation. This is a general principle for stateful factories: **snapshot dependent state before mutating it.** The bug was caught by the first test (`expect(c.refs).toEqual([])` for the very first constraint), but it would have been subtle in multi-agent scenarios where refs are non-empty.

### Shared Types Should Live in a Dedicated Base Module, Not in Either Consumer

`Result<T,E>` is needed by both the Datalog evaluator (`datalog/types.ts`) and the kernel (`kernel/types.ts`). The plan's dependency DAG says both have "no deps." Three options: (1) duplicate the 3-line type in both, (2) have one import from the other (creates an unintended dependency), (3) extract to a shared `base/result.ts`. We chose option 3. This seems obvious in hindsight, but the temptation to "just import from datalog" is strong when you're building kernel types and the Datalog layer already has the type defined. The problem: that creates a dependency from kernel→datalog that the architecture explicitly forbids. The shared base module costs one file and pays for itself in clean layering — especially when the old prototype code is eventually deleted, nothing in `kernel/` breaks.

### Safe-Integer Validation Is a Boundary Concern, Not a Type Concern

TypeScript's type system cannot express "a number that is a non-negative safe integer." The plan calls these `Counter` and `Lamport`, but they're both just `number` — the safe-integer invariant is behavioral. We enforce it at exactly two boundaries: `store.insert()` (receipt of external constraints) and `Agent.nextIdAndLamport()` (production of new constraints). Everything in between passes `number` through without checking. This is intentional: pervasive runtime checks would add overhead to every operation for a condition that, in practice, can only occur from a bug or a malicious peer. The boundary-enforcement pattern means the invariant is easy to grep for, easy to test, and impossible to accidentally skip.

The `isSafeUint()` function validates `Number.isSafeInteger(x) && x >= 0`, which catches: negative numbers, floats (1.5), NaN, Infinity, and values > 2^53 − 1. Tests exercise all these cases explicitly, including the boundary values 0 and MAX_SAFE_INTEGER.

### Two Codebases Can Coexist Cleanly If Directory Boundaries Are Respected

Phase 2 creates `src/kernel/` alongside the existing `src/core/`, `src/store/`, `src/solver/`, etc. Both define concepts like "constraint," "version vector," and "peer ID," but with fundamentally different shapes. This works because: (1) the new kernel modules never import from the old code, (2) the old code never imports from the new kernel, (3) the old tests keep running against old code, (4) new tests only exercise new code. The two trees are fully independent. This makes Phase 6 cleanup (delete old code) a safe, mechanical operation — just remove directories and their tests. The cost is carrying dead weight temporarily; the benefit is zero-risk incremental progress.

### Discriminated Union Ergonomics Improve When You Name the Variants

The plan's `Constraint` union is:

```typescript
type Constraint =
  | (ConstraintBase & { readonly type: 'structure'; readonly payload: StructurePayload })
  | (ConstraintBase & { readonly type: 'value'; readonly payload: ValuePayload })
  | ...
```

In implementation, we gave each variant a named interface (`StructureConstraint`, `ValueConstraint`, etc.). This has two practical benefits: (1) functions that accept or return only one variant (e.g., `produceStructure() → StructureConstraint`) get precise types instead of the full union, and (2) `constraintsByType(store, 'structure')` can return `StructureConstraint[]` using TypeScript's `Extract<Constraint, { type: T }>`, which narrows correctly because the variants are named. Without named variants, you'd need manual type assertions.

### Store Merge Needs Generation Bump Even When Constraints Don't Change

The store's `generation` counter is used for cache invalidation. Initially, `mergeStores` only bumped generation when new constraints were added. But a merge could change the version vector (peer A has `{alice:3}`, peer B has `{alice:3, bob:1}` — same constraints but different VVs). Any downstream logic that depends on the VV (like `filterByVersion`) would get stale results if generation didn't change. The fix: always bump generation on merge unless the stores are provably identical (same constraints AND same VV AND same lamport). This is why the `cloneStore` helper unconditionally increments generation.

### Agent Refs Are a Version Vector Frontier, Not a Full Causal History

The spec says `refs` are "constraints this one has observed (causal predecessors)." Naively, this could mean *all* observed CnIds — potentially thousands. Instead, the Agent compresses refs to the **frontier**: one CnId per observed peer, representing the highest counter seen from each. This is the minimal set that, combined with the version vector semantics, fully recovers the causal past. It's the same compression that version vectors provide, but expressed as CnId references rather than counters. The frontier approach keeps refs arrays small (one entry per known peer) regardless of how many constraints have been exchanged.

### The `VersionVector` Type Alias Belongs with the Identity Types

`BookmarkPayload` contains a `version: VersionVector` field. If `VersionVector` were defined in `kernel/version-vector.ts`, then `kernel/types.ts` would need to import from `version-vector.ts`, but `version-vector.ts` also imports types from `kernel/types.ts` — a circular dependency. The solution: define `VersionVector = ReadonlyMap<PeerID, Counter>` as a type alias in `kernel/types.ts` alongside `PeerID` and `Counter`, and keep only the *functions* (create, extend, merge, compare, filter) in `kernel/version-vector.ts`. This pattern — types in a central module, functions in specialized modules — prevents circular imports and is worth establishing as a project convention early.

## Phase 2.5: Prototype Removal

### Stale Counts in Plan Documents Are a Real Hazard

The plan documented "698 old prototype tests." The actual number at removal time was **476** — the discrepancy originated from a test pruning commit (37 tests removed) and the addition of 222 Datalog tests that were incorrectly counted as "original." The commit description for Phase 2 also carried the stale "698" figure. This matters because Phase 2.5's verification step ("only datalog + kernel tests remain") would have been confusing if someone expected 698 tests to disappear and only 476 did. **Audit numeric claims in plan documents whenever you touch the thing they count.** Counts go stale silently.

### Legacy Compatibility Shims Have Tendrils in Tests You Intend to Keep

The plan said "remove legacy `__neq`/`__gt` built-in predicates from `datalog/unify.ts`; audit `datalog/evaluate.ts`." What it missed: the *surviving* Datalog test files also exercised the legacy shim. Specifically:
- `tests/datalog/unify.test.ts` had `isBuiltinPredicate` and `evaluateBuiltin` describe blocks.
- `tests/datalog/evaluate.test.ts` had a `legacy __builtin predicates` describe block.
- `tests/datalog/stratify.test.ts` had an LWW pattern test that used `positiveAtom(atom('__neq', ...))`.

The first two were a straightforward delete. The third was subtle: the old encoding treated `__neq` as a predicate, so the stratifier added dependency edges to it. With the `guard` body element replacement, those edges disappear entirely. The test needed not just a syntax swap but *new expectations* — we added an assertion verifying that guards produce zero dependency graph edges.

**Lesson:** When removing a compatibility shim, grep for it in the entire test suite, not just the modules the plan mentions. Tests are often the last consumers of deprecated APIs.

### Removing Dead Code Immediately After Isolation Is Confirmed Pays Off

The plan originally deferred prototype removal to Phase 6 (the final phase). Research after Phase 2 confirmed zero cross-imports between old and new code. We moved removal to Phase 2.5 — immediately after the new kernel existed. This eliminated 7,264 lines of source and 476 tests in one commit, reducing the project from 26 test files to 10 and making `tsc` noticeably faster. More importantly, it removed the cognitive overhead of two parallel type systems (`OpId`/`Assertion` vs `CnId`/`Constraint`) before Phase 3 introduced authority, validity, and retraction — modules that would have been confusing to implement with two "Constraint" types in scope.

### DevDependencies Used Only by Deleted Tests Should Be Removed in the Same Pass

`loro-crdt` was a devDependency used exclusively by the old `tests/equivalence/` directory. The original plan didn't mention removing it. We added it as an explicit task (2.5.6). Leaving stale devDependencies creates confusion for future contributors who wonder "are we using Loro?" and costs CI time installing packages that nothing imports. Clean up the dependency manifest in the same commit as the code deletion.

## Phase 3: Authority, Validity, and Retraction

### Path-Based Capability Checks Require the Skeleton — Which Doesn't Exist Yet

The spec (§5.2) says a `value` constraint requires `Write(path)` where path matches the target node. But computing the target's path requires the skeleton tree — which is built in Phase 4 *after* validity filtering. This creates a chicken-and-egg problem: you need the skeleton to check validity, but you need validity to build the skeleton.

Our solution: Phase 3 uses a **simplified capability model** where Admin covers everything, and non-Admin capability checks verify the capability *kind* (`write`, `createNode`, `retract`, `createRule`, `authority`) without verifying the *path pattern*. The `requiredCapability()` function returns a wildcard path pattern (`['*']`), and `capabilityCovers()` checks exact path match. Since Admin trivially covers all paths, and the simplified grant path `['*']` matches the simplified required path `['*']`, the system works correctly for the common case (creator has Admin, grants broad capabilities to collaborators).

A future plan should implement real path-based capability resolution once the skeleton exists. The interface is designed for this: `requiredCapability()` is the only function that would need to change — everything else already supports path pattern comparison.

### Revoke-Wins Is Simpler Than LWW for Authority

The spec says concurrent grant and revoke resolve as "revoke-wins." This is simpler than LWW (which would need a peer tiebreak) and more conservative (ambiguity defaults to denial). The implementation collects all authority events for each `(targetPeer, capabilityKey)` pair, finds the maximum lamport, and checks if any event at that maximum lamport is a revoke. If so, revoke. This means a grant at lamport 5 and a revoke at lamport 5 (concurrent) resolves to revoke — even if the grant has a "higher" peer ID. The peer ID is irrelevant for authority resolution, unlike LWW value conflicts.

### The Retraction Depth Limit Is Not About the Retract Constraint's Depth — It's About the Chain Depth to the Original Target

Initial intuition: "depth 2 means you can retract things that are at most 2 levels deep in the tree." Wrong. Depth measures the *retraction chain*:
- Depth 1: `retract(value)` — simple retraction.
- Depth 2: `retract(retract(value))` — undo.
- Depth 3: `retract(retract(retract(value)))` — redo.

With `maxDepth: 2`, the depth-3 retraction (redo) is ignored. This means at depth 2 you get retract + undo, but no redo. The `computeDepth()` function walks the retraction chain: if the target is a non-retract constraint, depth is 1; if the target is itself a retract, depth is `1 + depth(target's target)`.

A subtle consequence: a retraction that *exceeds* the depth limit is still an active constraint in the store — it just has no dominance effect. It doesn't produce a violation; it's silently impotent. This is intentional: the retraction is structurally valid (correct refs, non-structure target), it just exceeds the policy limit.

### Structure Constraint Immunity Simplifies the Retraction Graph

Structure constraints (nodes in the reality tree) can never be retracted. This is a hard rule from the spec (§2.1, §6), and we enforce it by checking the target's type before adding edges to the retraction graph. The consequence: structure constraints don't participate in dominance computation at all. They're always active. This simplifies the retraction graph significantly — only value, retract, rule, authority, and bookmark constraints can be dominated.

Attempted retractions of structure constraints are recorded as *violations* (not errors) — the retract constraint itself remains active, it just has no effect. This is important for auditability: you can see that a peer tried to retract a structure node.

### Target-in-Refs Is a Causal Safety Net, Not a Security Feature

The rule that a retract's target must appear in its `refs` (causal predecessors) prevents a class of bugs where a retraction arrives before the thing it retracts. Without this rule, a peer could retract a constraint it hasn't seen yet — which is causally incoherent. The Agent enforces this by construction (refs are computed from the observed version vector), so in normal operation this rule is always satisfied. It's a defensive check that catches: (1) manually constructed test constraints with wrong refs, (2) malformed constraints from a buggy remote peer, (3) race conditions in sync protocols.

**Update (Phase 4.6):** The check now uses semantic interpretation rather than literal CnId matching. A ref `(peer, N)` with `N ≥ target.counter` satisfies the check, because the per-peer monotonic counter guarantee means observing `peer@N` implies observing all of `peer@0..peer@N`. This makes the check compatible with the Agent's frontier-compressed refs without requiring any special-casing in the Agent.

### Memoized Dominance Avoids Exponential Blowup in Deep Chains

The dominance function is recursive: to know if constraint C is dominated, you need to know if each of its retractors is active, which requires computing *their* dominance, and so on. Without memoization, this is exponential in chain depth. The `domCache` map ensures each constraint's dominance is computed exactly once. The `computing` set detects cycles (which shouldn't exist in valid causal data, but defensive programming matters). In practice, with `maxDepth: 2`, the recursion depth is at most 2 — but the memoization makes the general case safe.

### `readonly` Return Types Require Spreading at Convenience Boundaries

`computeValid()` returns `{ readonly valid: readonly Constraint[] }`. The convenience function `filterValid()` wants to return `Constraint[]` (mutable) for caller flexibility. TypeScript won't assign `readonly Constraint[]` to `Constraint[]` — you need `[...result.valid]`. This is a minor annoyance but affects every "convenience wrapper that returns a subset" pattern. We encountered it in both `filterValid()` and `filterActive()`. The alternative — making the core return type mutable — weakens the contract. The spread is the correct trade-off.

## Phase 3.5: Extract Shared Base Types

### Build-Order Artifacts Should Be Cleaned Up at Phase Boundaries

Phase 1 defined `CnIdRef` in `datalog/types.ts` because the kernel didn't exist yet. Phase 2 defined `CnId` in `kernel/types.ts` independently. These were structurally identical (`{ peer: string, counter: number }`) and TypeScript's structural typing made them assignment-compatible — but they were nominally separate types. The plan called for a "compile-time compatibility assertion" hack in the future `projection.ts` to guard against drift.

Post-Phase-3 review revealed the "no cross-dependency" premise that justified the duplication was already violated: `kernel/types.ts` imports 14 types from `datalog/types.ts` for `RulePayload`. The fix was cheap — extract `CnId`, `Value`, `PeerID`, `Counter`, `Lamport`, and `isSafeUint` into `base/types.ts` (following the `base/result.ts` precedent). `CnIdRef` was deleted. Both layers now import from `base/`.

General principle: when a later phase introduces a concept that an earlier phase approximated, clean up the approximation at the next phase boundary — before downstream code makes the drift load-bearing.

### Dual Type Definitions Mask Themselves as "Acceptable Trade-offs"

The Learnings section originally said the dual `Value`/`CnIdRef` types were "an acceptable trade-off given the no-cross-dependency architecture." This framing was wrong — the architecture premise it depended on was already violated. The lesson: when you document a trade-off, also document the premise. When the premise changes, the trade-off must be re-evaluated.

## Phase 4–4.6: Skeleton, Pipeline, Reality, and Pre-Bootstrap Correctness

### The Validity Filter Is the First Integration Gate — Test Helpers Must Account For It

The single most time-consuming bug in Phase 4 was that multi-peer pipeline tests failed silently because the validity filter excluded non-creator peers' constraints. The creator has implicit Admin, but everyone else has nothing. Test helpers that construct raw constraints (bypassing Agent) must include explicit `authority` grants for non-creator peers, or their constraints vanish from the active set without error. This was not a bug in the code — it was the authority system working exactly as designed. The fix: a `grantAdmin()` test helper that every multi-peer pipeline test uses.

Broader lesson: when a filter silently excludes data (validity, retraction), your integration tests must supply the inputs that pass the filter. Unit tests that construct data below the filter boundary won't catch this.

### Slot Identity Is a Pre-Computed Join, Not a Datalog Derivation

The spec's `active_value(CnId, Slot, Value, Lamport, Peer)` treats `Slot` as a ground term. Pre-Phase-4 research established that slot identity must be computed outside Datalog (Layer 0 kernel logic, not a retractable rule). Phase 4 confirmed this works: `projection.ts` joins each value constraint with its target structure constraint via the structure index to derive the slot, then emits it as a string in the projected fact. Phase 1's test doubles (which hardcoded `'title'` as a string slot) match the real projection's output shape exactly.

The structure index is the shared dependency that makes this efficient: computed once from active structure constraints, consumed by both `projection.ts` (slot identity for Datalog facts) and `skeleton.ts` (tree construction).

### The Map Multi-Structure Case Is Real and Must Be Tested

When Alice creates `structure(map, parent=root@0, key="title")` and Bob independently creates the same, they get different CnIds but represent the same logical slot. The structure index groups them by `(parent, key)`, and `getChildrenOfSlotGroup()` merges children from all structures in the group. Without this, each peer's sub-keys would be invisible to the other peer's tree branch. The equivalence tests confirmed that native LWW and Datalog LWW agree on the winner even when values target different structure CnIds for the same slot.

### The Skeleton Needs a Synthetic Root

The spec says `Reality { root: Node }` but a reality can have multiple top-level containers (e.g., "profile" and "settings"). The skeleton builder creates a synthetic root (`__reality__@0`, policy `map`) whose children are the containers keyed by `containerId`. This is invisible to users (they navigate by container name) and avoids special-casing the root in tree traversal code.

### Pipeline Is Composition, Not Transformation

`pipeline.ts` is intentionally anemic — it calls `filterByVersion()`, `computeValid()`, `computeActive()`, `buildStructureIndex()`, `projectToFacts()`, `buildSkeleton()` in sequence and returns the result. Every transformation lives in its own module. This makes each stage independently testable and replaceable. The `solveFull()` variant exposes all intermediate stages, which proved essential for debugging the validity-filter issue.

### Native Solvers Are Primary, Datalog Is Validation ✅ (Corrected in Phase 4.5)

**Corrected**: Phase 4.5 restructured the pipeline so Datalog evaluation is the **primary** resolution path. The skeleton builder now receives a `ResolutionResult` (from either Datalog or native solvers) and is resolution-agnostic. `resolve.ts` bridges Datalog output → kernel types (symmetric counterpart of `projection.ts`). Native solvers activate as a §B.7 fast path only when `isDefaultRulesOnly()` detects that active rules structurally match the known LWW + Fugue patterns. Custom or modified rules automatically fall back to Datalog evaluation. The `enableDatalogEvaluation` flag still exists for testing/benchmarking but defaults to `true`.

### Fugue Equivalence Is Scoped to the Simplified Subset ✅ (Resolved in Phase 4.6)

**Resolved**: Phase 4.6 implemented complete Fugue Datalog rules (7 rules across 3 predicates: `fugue_child`, `fugue_descendant`, `fugue_before`) that express the full Fugue tree walk. The key was a subtree propagation rule with a `not fugue_descendant(P, B, X)` negation guard — without it, parent-child ordering combined with propagation creates spurious orderings among siblings. Equivalence tests now cover 23 cases including DFS ordering, originLeft chains, nested children, cross-subtree ordering, wide trees, and diamond patterns. The Datalog rules and native solver agree on ALL inputs, not just a simplified subset.

### The `childrenOf` Index Keys by Parent CnId, Not Slot

A subtle detail: the structure index's `childrenOf` map keys by the parent structure constraint's CnId key (e.g., `alice@0`), not by the parent's slot identity. This is correct because a child's `parent` field in the constraint payload points to a specific structure CnId, not to a slot. When a Map slot has multiple structure constraints (concurrent creation), `getChildrenOfSlotGroup()` iterates all structure CnIds in the group and merges their children. This ensures that children created under any peer's version of the parent are visible in the merged reality.

## Phase 5: Reality Bootstrap and Integration

### Canonical Rule Definitions Must Live in Production Code, Not Tests

Before Phase 5, the default LWW and Fugue Datalog rules were defined independently in four test files. Each copy was structurally identical but maintained separately — a classic violation of DRY that went unnoticed because each file "owned" its own rules for its own tests. When the complete Fugue rules were introduced in Phase 4.6 (growing from 2 to 8 rules), only the equivalence test was updated. The resolve test still used the old simplified 2-rule Fugue, silently producing a different rule count.

This caused a real bug during Phase 5: the resolve test's `defaultRuleConstraints()` allocated CnId counters 10–14 for 5 rules, with a custom Layer 2 rule at counter 20. After switching to the 11-rule canonical set, counters became 10–20 — and the custom rule at counter 20 shared a CnId with the last default rule. Store deduplication silently dropped the custom rule, making the native fast-path detection test pass when it should have failed (no Layer 2 rule present → native path activates).

**Lesson**: When multiple test files construct the same domain object (rules, fixtures, configs), extract the canonical version to production code and import it. This is the same principle as Phase 3.5's shared type extraction. Test-local definitions are fine for test-specific variants (e.g., a "lowest-lamport-wins" custom rule), but the defaults should have a single source of truth. `bootstrap.ts` now exports `buildDefaultLWWRules()`, `buildDefaultFugueRules()`, and `buildDefaultRules()` — four test files import from it instead of maintaining parallel copies.

### CnId Counter Collisions Are Silent — Deduplication Masks the Bug

The store's CnId-based deduplication is a correctness feature: inserting the same constraint twice is a no-op. But it also means that if two *different* constraints are accidentally assigned the same `(peer, counter)` pair, the second one is silently discarded. No error, no warning — just a missing constraint.

In practice this manifests as tests that *pass when they should fail*. The custom Layer 2 rule that was supposed to trigger the Datalog path was simply gone from the store. The native fast-path detection test passed because it saw only Layer 1 rules. The reality was correct (the custom rule was irrelevant to the map resolution), so no output assertion caught it either.

**Lesson**: When constructing constraints with manually-assigned counters in tests, leave generous gaps between counter ranges for different "groups" of constraints (e.g., structure at 0–9, default rules at 10–30, custom rules at 50+). Better: use an agent (which auto-increments) instead of manual counter assignment. The integration tests use agents exclusively and never hit this issue.

### Bootstrap Is the Kernel Speaking, Not a User Action — Layer Guards Are Correct

`Agent.produceRule()` enforces `layer >= 2`, which initially appeared to block bootstrap from emitting Layer 1 default rules. Three options were considered: (a) add a bootstrap-only method to Agent, (b) add a `force` parameter to bypass the check, (c) construct rule constraints directly in bootstrap.

Option (c) is correct. The layer guard exists because Layer 0–1 are kernel-reserved (spec §14). User-facing Agents *should not* be able to create Layer 1 rules — that's the whole point of the stratification. Bootstrap is not a user action; it is the kernel itself setting up initial state. Constructing `RuleConstraint` objects directly with `layer: 1` is the right abstraction: bootstrap has kernel-level authority, Agent has user-level authority.

The `RulePayload` type is `{ layer: number; ... }` with no compile-time enforcement of layer bounds. This is intentional — the type system describes the wire format (any layer value is structurally valid), while runtime guards enforce semantic invariants at the appropriate boundary (Agent for users, bootstrap for the kernel).

### Integration Tests Reveal Authority as the Hidden Prerequisite

The first integration test failure was: "Bob's map key doesn't appear in Alice's reality after sync." The constraint was in the store, the structure was valid, the value was correct — but Bob had no capabilities. `computeValid()` filtered out all of Bob's constraints because Alice never granted Bob admin.

This is the authority model working as designed, but it's invisible in unit tests because pipeline tests hand-construct constraints with the creator's peer ID (bypassing validity) or test with `enableDatalogEvaluation: false` (bypassing rules). Integration tests that use realistic multi-agent workflows are the first place where the authority model actually matters.

**Pattern for multi-agent integration tests**: Always grant capabilities *before* the second agent creates constraints. The sequence is: (1) bootstrap reality, (2) creator grants admin/capabilities to other peers, (3) sync the grant to the other peer's store, (4) other peer creates constraints. Missing step 2 or 3 produces constraints that are silently filtered by validity.

### The Agent Must Observe Its Own Constraints for Refs to Work

A subtlety in the Agent API: producing a constraint with `agent.produceValue(...)` returns the constraint but does **not** automatically add it to the agent's version vector. If you don't call `agent.observe(constraint)` after inserting it into the store, the agent's next constraint won't include the previous one in its refs. This means the causal chain is broken — the new constraint doesn't declare that it observed the previous one.

In bootstrap, this is handled by `agent.observeMany(constraints)` after all bootstrap constraints are inserted. In integration tests, the pattern is:

```
const c = agent.produceValue(targetId, 'hello');
insert(store, c);
agent.observe(c);
```

All three lines are required. Missing the `observe` call doesn't cause an immediate error — it causes downstream causal issues (e.g., retraction's target-in-refs check failing, or version vectors being stale for delta sync).

### Bidirectional Sync Requires Two Rounds When Agents Are Concurrent

The `bidirectionalSync` helper does A→B then B→A in one pass. This works because delta computation is based on version vectors: A exports everything B hasn't seen, then B exports everything A hasn't seen (including B's own new constraints). After one round, both stores contain the union.

But if both agents *continue producing constraints* after sync, a second round is needed. The version vectors captured at sync time reflect the state *before* the sync — they don't include constraints the other peer produced during the sync. In practice, integration tests sync at quiescent points (both agents have finished their writes), so one round suffices. A production system would need continuous sync or a retry loop.

## Plan 005: Incremental Kernel Pipeline

### Authority Revocation Cascades Transitively — A Flat Accumulator Is Wrong

A naive incremental authority state — maintaining a flat `Map<(peer, capability), granted|revoked>` — misses transitive cascades. If peer A holds `Authority(Write)` and grants Write to peer B, then A's authority is revoked, B's Write capability must also disappear. The batch `computeAuthority` handles this implicitly by replaying all authority constraints from scratch. A flat accumulator only sees "A lost Authority(Write)" and doesn't know to also invalidate B's Write.

The correct incremental approach is: on any authority constraint arrival, recompute the full `AuthorityState` via `computeAuthority` over all accumulated authority constraints, then diff against the previous state. This is O(authority constraints), which is negligible because authority constraints are rare (typically single-digit count per reality). The diff catches all transitive cascades. A more sophisticated dependency DAG approach produces identical correctness but adds significant complexity for no practical gain.

### Private Functions in Existing Modules Are Often Exactly What You Need

During planning, we identified `factKey(f: Fact): string` as "new code needed" for the incremental projection stage. Research revealed it already exists as a private function in `datalog/evaluate.ts` — a deterministic serialization of `predicate + terms` using `serializeValue` joined by `|`. The implementation task is just relocation and export, not new logic.

**Lesson**: Before specifying "new function X" in a plan, grep the codebase for private functions doing the same thing. Batch implementations often contain exactly the utility functions that incremental implementations need — they're just not exported because the batch code only uses them internally.

### The Skeleton Should Not Know About Fugue — Design for the Next Plan's World

A key design tension: the skeleton builder needs Fugue-ordered children for seq containers, and during Plan 005 the evaluator is batch (producing a full `ResolutionResult`, not deltas). Two approaches: (a) the skeleton maintains its own Fugue tree and re-orders on each step, or (b) the skeleton accepts Z-set deltas of `ResolvedWinner` and `FugueBeforePair` and the pipeline produces those deltas.

Option (b) is correct. It keeps Datalog as the canonical resolution path, with native solvers as a pipeline-level optimization only. The skeleton never calls native solvers and never understands the Fugue algorithm. During Plan 005, the pipeline composition root diffs the previous `ResolutionResult` against the new one to produce Z-set deltas — a temporary shim that Plan 006 eliminates when the incremental evaluator produces deltas directly. The diff cost is O(|winners| + |fuguePairs|) per insertion, which is noise next to the batch evaluator's O(|allFacts|).

**Lesson**: When building infrastructure that will be consumed by a later plan, design the interface for the later plan's world. A temporary shim at the current plan's composition root is cheaper than redesigning the stage interface later.

### Affected-Set Expansion Must Walk Both Directions in the Retraction Graph

The incremental retraction stage recomputes dominance only for "affected" constraints — those whose status might have changed due to a new insertion. The initial intuition is to walk downward: a new retract affects its target, and if the target is itself a retract, its target too. But this misses cases.

Consider: constraint V is dominated by retract R₁. A new retract R₂ arrives targeting R₁ (an undo). Walking downward from R₂ finds R₁ (correct) but not V. Yet V's status changes — R₁ is now dominated, so V becomes active. The fix: expand the affected set by walking *both* directions — downward (retract → target) and upward (target → its retractors). In practice this means: for each affected key, add its retraction targets AND all constraints that retract it. The expansion is bounded by `maxDepth` (default 2), so it's typically 2–3 constraints.

### Deferred Immunity Checks Are a Distinct Out-of-Order Pattern

The plan's out-of-order arrival invariant describes the general pattern: "when the referrer arrives first, record its effect as a standing instruction; when the referent arrives, apply standing instructions." For retraction, we discovered a second pattern: *deferred validation*.

When a retract arrives before its target, we can validate `target-in-refs` (because refs are self-contained) but we *cannot* validate structure/authority immunity (because we don't yet know the target's type). The retract's graph edge is recorded as a standing instruction. When the target arrives and turns out to be a structure or authority constraint, we must retroactively invalidate the edge — remove it from the graph, record a violation, and recompute affected dominance.

This is not the same as "standing instruction applied on referent arrival." It's "standing instruction *revoked* on referent arrival because the referent turns out to be immune." Any stage that validates properties of a referenced constraint must handle this deferred-validation pattern when the referenced constraint hasn't arrived yet.

### Two-Pass Delta Processing Solves Intra-Delta Ordering Without Sorting

When a multi-element Z-set delta contains both a retract R and its target V (e.g., from authority re-validation emitting multiple newly-valid constraints), processing order matters: R must find V in the index to create the graph edge. Rather than topologically sorting the delta (which would require understanding the retraction graph structure within the delta), a simpler approach works: process all non-retracts first (pass 1), then all retracts (pass 2). This ensures targets are indexed before edges are created, without any sorting or dependency analysis.

This generalizes: any stage processing a multi-element delta where some elements reference others should process non-referencing elements first. The two-pass pattern is O(n) and avoids the complexity of topological sorting within deltas.

### The Batch Oracle Makes Permutation Testing Trivial

The most powerful test pattern for incremental stages: take N constraints, compute the batch result once, then verify that the incremental stage produces the same `current()` for all N! permutations of insertion order. For the retraction stage with 3 constraints (value + retract + undo), this means 6 permutations — each creating a fresh stage, inserting in that order, and comparing against the single batch result. This mechanically catches every out-of-order bug.

The cost is manageable because N is small for unit tests (3–5 constraints), and the batch oracle (`computeActive`) is a pure function that's already tested independently. The test doesn't need to know *what* the correct answer is — it just asserts incremental == batch.

## Plan 006: Incremental Datalog Evaluator

### The Actual Stratification Is Simpler Than Hand Analysis Suggests

Reading the 11 default rules individually, one might expect 4–5 strata: `fugue_child` → `fugue_descendant` → `superseded` → `fugue_before`/`winner`. Running the actual stratifier (`stratify(buildDefaultRules())`) produces **two strata**:

- Stratum 0: `active_value`, `superseded`, `active_structure_seq`, `constraint_peer`, `fugue_child`, `fugue_descendant` (5 rules, all positive)
- Stratum 1: `winner`, `fugue_before` (6 rules, both use negation)

Tarjan's SCC algorithm collapses all purely-positive predicates into stratum 0 regardless of their inter-dependencies, and puts everything that negates a stratum-0 predicate into stratum 1. This makes the affected-stratum computation trivial for the incremental evaluator — any ground-fact change affects stratum 0, and any stratum-0 output change propagates to stratum 1.

**Lesson**: Always verify stratifier output empirically. The algorithm produces a more collapsed layout than manual reasoning suggests because it only creates stratum boundaries at negation edges, not at positive dependency edges.

### The Theory's Claim That Fugue Rules Are All Positive Is Wrong

theory/incremental.md §9.5 states: "Our Fugue rules (`fugue_child`, `fugue_descendant`, `fugue_before`) are all positive." This is incorrect. Rule 5 (`fugueBeforeSubtreeProp`) uses `not fugue_descendant(Parent, B, X)` — the subtree propagation guard. The `fugue_before` predicate lands in a negation stratum (stratum 1), not a monotone one.

The practical impact is nil for the common case because the native fast path handles default Fugue rules without Datalog. But for the incremental Datalog evaluator, this means `fugue_before` requires the DRed (delete-and-rederive) pattern, not simple monotone delta propagation.

**Lesson**: Check negation usage in actual rule definitions, not just the theory's characterization of them. A single `not` in one rule out of eight changes the entire stratum's incrementalization strategy.

### `ZSet<Fact>` Is the Right Unification Point — Don't Invent `WeightedRelation`

The initial Plan 006 design proposed a separate `WeightedRelation` type (`Map<string, { tuple: FactTuple, weight: number }>` keyed by `serializeTuple`) for the incremental Datalog evaluator's internal state. This overlaps almost entirely with `ZSet<Fact>`, which is already `ReadonlyMap<string, { element: Fact, weight: number }>` keyed by `factKey`. Both are weighted sets of facts. The only differences were per-predicate scoping (solved by `Map<string, ZSet<Fact>>`) and storing `FactTuple` vs `Fact` (trivial wrapping).

The `wrToZSet` and `wrFromZSet` conversion functions were a code smell — converting between isomorphic types at every stage boundary. Unifying on `ZSet<Fact>` eliminated ~100 LOC of duplicate algebra, removed two conversion functions, avoided exporting the private `serializeTuple`, and made the entire pipeline speak one type language from projection through evaluation to skeleton.

The one concern — semi-naive iteration needing `readonly FactTuple[]` arrays — is solved by a private `CachedRelation` wrapper inside the evaluator that lazily materializes tuples from positive-weight Z-set entries. This is an implementation detail, not a type-level concern.

**Lesson**: When two components exchange a type and one proposes a different internal type with bidirectional conversion, question whether the internal type is justified. Conversion functions between isomorphic types are a code smell.

### Semi-Naive Read/Write Separation Dictates Caching Strategy

Within one semi-naive pass, the accumulated database (`fullDb`) is read-only — queried many times via `tuples()`, never written. The delta (`currentDelta`) is also read-only. Only `nextDelta` is written to, and it's never read until the next iteration. This means lazy caching (build the tuples array on first access, invalidate on mutation) is optimal — the cache is built once per Z-set version and hit N times during iteration. Eagerly maintaining a parallel array on every `zsetAdd` would waste work because `nextDelta` gets many additions but its tuples are never read until it becomes `currentDelta`.

**Lesson**: The caching strategy for a data structure depends on the access pattern (read/write interleaving), not the data structure's API surface.

### Duplicated Code Cascades — Extract Canonical Functions Before They Triple

Phase 1 discovered six functions duplicated byte-for-byte between `kernel/pipeline.ts` and `kernel/incremental/pipeline.ts`: `extractRules`, `isDefaultRulesOnly`, `hasDefaultLWWRules`, `hasDefaultFugueRules`, `buildNativeResolution`, `buildNativeFuguePairs`. Additionally, the "ordered nodes → all-pairs" nested loop inside `buildNativeFuguePairs` would have been reimplemented a third time in incremental Fugue, and the `pairKey` closure inside `diffResolution` would have been reimplemented in both incremental Fugue and incremental Datalog resolution extraction.

The fix: place canonical functions in the right modules (key functions in `resolve.ts`, detection in `rule-detection.ts`, native building in `native-resolution.ts`) before building consumers. ~500 LOC of duplication eliminated, and later phases (2–7) compose these functions rather than reinventing them.

**Lesson**: When planning an extraction refactor, look not just at the obvious duplicates but at inline patterns (local closures, nested loops) that will be needed by future consumers. Extract them at the same time — the marginal cost is low and the prevented duplication is multiplicative.

### The Resolution Strategy Decision Tree Is a Pure Function

The `if (!enableDatalog) → native; else if (rules.length === 0) → native; else if (isDefaultRulesOnly) → native; else → datalog` chain appeared identically in both pipeline composition roots and would have been needed a third time by the evaluation stage. Extracting it as `selectResolutionStrategy(enableDatalog, rules, active) → 'native' | 'datalog'` makes the strategy choice independently testable and composes cleanly with the evaluation stage's strategy-switching logic.

**Lesson**: Multi-branch decision trees that appear in composition roots (imperative shells) are often pure functions in disguise. Extracting them improves testability and prevents drift between copies.

## Open Questions

1. **Can constraint compaction be made safe in a decentralized system?** Compacting requires knowing what all peers have seen. Without a central coordinator, this requires something like a "compaction frontier" protocol. For Lists, tombstone compaction is especially tricky due to origin references.

2. ~~**What is the performance ceiling?**~~ **Partially resolved in Plan 005.** The incremental kernel pipeline reduces per-insertion cost from O(|S|) to O(|Δ|) for all stages except the Datalog evaluator (which remains batch until Plan 006). The native fast path (LWW comparison + Fugue tree walk) is already fast for the default case. The remaining bottleneck is the batch evaluator, which Plan 006 addresses.

3. **Can cross-container constraints be made to work?** E.g., "if key X exists in Map A, then key Y must exist in Map B." This requires a solver that reasons across containers, which the current per-container solver architecture doesn't support.

4. **How should Text differ from List?** Currently planned as a thin wrapper where values are characters. But run-length encoding (storing "hello" as one constraint instead of five) would dramatically reduce constraint count. The solver would need to handle span splitting.

5. ~~**What's the right caching strategy for Fugue trees?**~~ **Resolved in Plan 005 design.** The incremental skeleton receives Fugue ordering as Z-set deltas of `FugueBeforePair` — it doesn't maintain or rebuild Fugue trees. During Plan 005, the pipeline diffs batch resolution results to produce these deltas. During Plan 006, the incremental evaluator produces them directly. The skeleton applies deltas to its mutable reality tree without understanding the Fugue algorithm.

6. ~~**When should the prototype code be removed?**~~ **Resolved in Phase 2.5.** Removed immediately after Phase 2 confirmed zero cross-imports. The answer: as soon as isolation is verified, not at the end. Carrying dead code through subsequent phases was pure cognitive overhead with no safety benefit.

7. **When should path-based capability checks be implemented?** Phase 3 uses a simplified model (Admin covers all, wildcard paths). Real path-based checks require the skeleton tree (Phase 4) to resolve a constraint's target path. This is a circular dependency: validity → skeleton → validity. Now that Phase 4 has implemented the skeleton builder, the skeleton *is* available — but it's built *after* validity filtering. The likely solution is a two-pass approach: first pass with simplified checks (current behavior), build skeleton, second pass with path-aware checks. Alternatively, the structure index (which is built from active constraints) could provide enough path information without the full skeleton.

8. ~~**Should the `Constraint[]` store cloning strategy be replaced?**~~ **Resolved in Phase 4.6.** Switched to mutate-in-place. `insert()` returns `Result<void, InsertError>` and mutates the store directly. The `generation` counter serves as the cache-invalidation signal. O(1) per insert instead of O(n). No persistent data structure needed — the functional API was unnecessary ceremony.

9. ~~**Should Datalog-derived facts feed back into the skeleton?**~~ **Resolved in Phase 4.5.** Yes. The skeleton builder now receives a `ResolutionResult` (from Datalog via `resolve.ts` or from native solvers). It is resolution-agnostic — it reads pre-resolved winners and Fugue ordering without knowing which path produced them. Custom Layer 2+ rules flow through Datalog evaluation → `extractResolution()` → skeleton automatically.

10. ~~**How should the Agent's frontier-compressed refs interact with retraction's target-in-refs check?**~~ **Resolved in Phase 4.6 (option a).** `computeActive()` now interprets refs semantically: a ref `(peer, N)` means "I've observed all of peer's constraints 0..N." A retract targeting `(peer, T)` passes if any ref for the same peer has `counter ≥ T`. This is mathematically sound because per-peer counters are gap-free and monotonically increasing, and causal delivery ensures observing `B@N` implies observing `B@0..B@N-1`. The Agent needs no special-casing.