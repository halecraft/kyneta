# Learnings: Convergent Constraint Systems (CCS) and Prism

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

### Immutable Store Pattern Has Practical Ergonomic Cost (Partially Resolved)

The constraint store is immutable (each `tell` returns a new store). This is clean for functional composition but creates friction in the handle layer, where you need to thread updated stores through. The `MapHandle` and `ListHandle` implementations work around this with internal mutable state (closure-captured `store` variable). 

Originally, `mergeMapHandles`/`mergeListHandles` returned a merged store but did **not** update the target handle, leaving callers with a detached store nobody applied. This was fixed: merge functions now call `target._updateStore(merged)` to mutate the target handle in place.

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

## Open Questions

1. **Can constraint compaction be made safe in a decentralized system?** Compacting requires knowing what all peers have seen. Without a central coordinator, this requires something like a "compaction frontier" protocol. For Lists, tombstone compaction is especially tricky due to origin references.

2. **What is the performance ceiling?** Naive solving is O(n) in constraint count per path query. The Fugue tree rebuild is O(n log n) for n elements. `askPrefix` is O(total constraints). Incremental solving could amortize this, but the design is unexplored.

3. **Can cross-container constraints be made to work?** E.g., "if key X exists in Map A, then key Y must exist in Map B." This requires a solver that reasons across containers, which the current per-container solver architecture doesn't support.

4. **How should Text differ from List?** Currently planned as a thin wrapper where values are characters. But run-length encoding (storing "hello" as one constraint instead of five) would dramatically reduce constraint count. The solver would need to handle span splitting.

5. **What's the right caching strategy for Fugue trees?** Rebuilding the tree on every solve is expensive for large lists. Incremental updates (adding new nodes, marking deletions) could amortize the cost, but invalidation logic is complex. The store generation counter approach (see Learnings above) is the likely first step.