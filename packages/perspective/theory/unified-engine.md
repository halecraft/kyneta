# Unified CCS Engine Specification

## Overview

A CCS reality is a shared state constructed from the subjective assertions of independent agents. Each agent asserts **constraints** — declarations about what should be true — which are delivered to other agents as **messages**. Each agent accumulates received constraints in a local **store**. The store grows monotonically; merge between replicas is set union. A deterministic, version-parameterized **solver** examines the store and constructs the reality — a rooted tree where nodes differ only in their policy for child identity and sibling ordering. What we call a Map, List, or Text is a choice of policy, not a distinct data structure. Retraction, undo, deletion, schema evolution, authority, time travel, and branching are all expressed as constraints in the same store.

---

## 1. Constraints

A **constraint** is the atomic unit of the system. It is a subjective assertion by an agent about what should be true. Every entity — structure, values, retractions, solver rules, authority grants — is a constraint.

```
Constraint {
  id:      CnId          // (peer: PeerID, counter: safe_uint) — globally unique
  lamport: safe_uint     // Lamport timestamp
  refs:    CnId[]        // constraints this one has observed (causal predecessors)
  type:    ConstraintType // see §2
  payload: Payload       // type-specific assertion
  sig:     Signature     // ed25519 signature over (id, lamport, refs, type, payload)
}
```

**CnId** (Constraint Id) uniquely identifies a constraint. It is the pair `(peer, counter)` where `peer` is the asserting agent's public key (or hash thereof) and `counter` is a monotonically increasing local sequence number.

**Structural integer fields** (`counter`, `lamport`, `RulePayload.layer`) use `safe_uint` — a non-negative integer that MUST be representable as an IEEE 754 double-precision float without precision loss. The maximum conforming value is 2^53 − 1 (9,007,199,254,740,991). This constraint exists because JavaScript — a mandatory implementation target — represents all `number` values as f64. A Rust or C++ implementation using `u64` for these fields MUST NOT produce values exceeding this bound. In practice, no single agent will assert 9 quadrillion constraints, and Lamport clocks grow as `max(all_received) + 1`, so this bound is not operationally limiting. Implementations MUST validate this bound at the store insertion boundary and reject constraints with out-of-range structural fields.

**Invariants:**
- `id` is globally unique (enforced by (peer, counter) pair).
- `id.peer` is the public key (or hash thereof) of the asserting agent.
- `id.counter` is a `safe_uint` (≤ 2^53 − 1).
- `lamport` is a `safe_uint` (≤ 2^53 − 1).
- `sig` is verifiable against `id.peer`. Constraints with invalid signatures are discarded on receipt.
- Every CnId in `refs` identifies a constraint that causally precedes this one.
- Constraints are immutable once asserted.

---

## 2. Constraint Types

There are exactly six kernel-level constraint types.

### 2.1 `structure` — Structural Assertion

Asserts the permanent existence of a node in the reality and its position relative to other nodes. Never retractable.

**Payloads by policy:**

```
StructurePayload::Map {
  parent: CnId,         // the map node this key belongs to
  key:    string        // user-provided key (context-free identity)
}

StructurePayload::Seq {
  parent:       CnId,   // the sequence node this element belongs to
  origin_left:  CnId,   // left neighbor at assertion time (causal binding)
  origin_right: CnId    // right neighbor at assertion time (causal binding)
}

StructurePayload::Root {
  container_id: string, // top-level name ("profile", "todos", etc.)
  policy:       Policy  // Map | Seq
}
```

**Key property:** `structure` constraints are permanent. They define the skeleton of the reality. The skeleton only grows.

**Why Map and Seq are not further unified:** Map keys use context-free identity — two agents who have never communicated can independently target the same slot by using the same key string. Seq elements use causally-bound identity — each element's CnId captures its birth context, making it inherently unique. These are the only two identity semantics, and one cannot be reduced to the other. (Modeling a map key as "a sequence of characters" would cause independently-created identical keys to become distinct slots, breaking the Map contract.)

### 2.2 `value` — Content Assertion

Asserts content at a node. Retractable.

```
ValuePayload {
  target: CnId,         // the structure constraint this value is for
  content: Value         // the asserted value (see §3)
}
```

**Value resolution is universal.** Any node — regardless of policy — can be the target of `value` constraints. When multiple active `value` constraints target the same node (or the same logical slot in a Map), they are resolved by LWW (highest lamport; peer ID breaks ties). This is not a policy; it is a property of the solver.

For **Map** nodes: multiple `value` constraints may target different `structure` constraints that share the same `(parent, key)`. The solver groups by `(parent, key)` and resolves by LWW across all active value constraints for that slot.

For **Seq** nodes: each `structure` constraint has a unique identity (its CnId), so there is at most one `value` constraint per node (from the creating agent). Deletion is retraction of the `value` constraint; the `structure` remains for ordering.

### 2.3 `retract` — Retraction

Asserts that a target constraint should be dominated — that the asserting agent believes it should no longer participate in the shared reality.

```
RetractPayload {
  target: CnId          // the constraint being retracted
}
```

**Rules:**
- `target` must be in `refs` (you can only retract what you've observed). Enforced by the kernel.
- `target` must not be a `structure` constraint. Structural assertions are permanent.

Retractions may target other retractions (retraction depth ≥ 2 enables undo-of-undo). See §6.

### 2.4 `rule` — Solver Rule (Layer 2+)

Asserts a Datalog rule that participates in solving or query evaluation. Rules are meta-constraints: assertions about how other constraints should be resolved.

```
RulePayload {
  layer:      u8,       // stratification layer (must be ≥ 2)
  head:       Atom,     // the derived relation
  body:       Atom[],   // conditions
}
```

Rule constraints are retractable. Retracting a rule changes solver behavior — it is an assertion that a previous resolution strategy should no longer apply.

*Note: the initial implementation may hard-code Layer 1–2 solvers and defer rule-as-data to a later phase. The architecture must not preclude it.*

### 2.5 `authority` — Capability Assertion

Asserts a change to an agent's capabilities within the reality. Authority constraints are kernel-level (Layer 0).

```
AuthorityPayload {
  target_peer: PeerID,         // the agent whose capabilities change
  action:      Grant | Revoke, // grant or revoke
  capability:  Capability      // the capability being granted/revoked
}
```

**Capabilities:**

```
Capability =
  | Write(path_pattern)         // assert value constraints under matching paths
  | CreateNode(path_pattern)    // assert structure constraints under matching paths
  | Retract(scope)              // retract constraints (Own | ByPath(pattern) | Any)
  | CreateRule(min_layer)       // assert rule constraints at layer ≥ min_layer
  | Authority(capability)       // grant/revoke a specific capability to others
  | Admin                       // all capabilities (includes Authority(Admin))
```

**Rules:**
- The asserting agent must hold `Authority(C)` (or `Admin`) at the causal moment of assertion to grant or revoke capability C. Enforced by the kernel.
- `authority` constraints are **not retractable** via `retract`. Revocation is the dedicated mechanism for removing capabilities. This prevents retraction from being used to circumvent the authority model.
- **Capability attenuation**: An agent can only grant capabilities they hold, and only equal or weaker ones. `Write(["docs", "*"])` can grant `Write(["docs", "readme"])` but not `Write(["*"])`.

**Bootstrap:** The reality creation constraint implicitly grants `Admin` to the creating agent. This is the root of all authority chains.

### 2.6 `bookmark` — Named Point in Causal Time

Asserts a human-readable name for a specific version vector — a point in causal time. Bookmarks bridge the gap between the system's causal coordinate system (version vectors) and human temporal concepts ("v1.0", "before refactor", "Tuesday's draft").

```
BookmarkPayload {
  name:    string,          // human-readable label
  version: VersionVector    // the causal moment this names
}
```

Bookmarks are constraints like any other — they enter the store, are replicated to all agents, and are queryable. They can be retracted (removing the name, not the historical moment).

**Automatic bookmarks:** The system may automatically create bookmarks at significant moments: when the stability frontier advances, when a new agent joins, or at regular Lamport intervals. These carry system-generated names.

**Agent bookmarks:** Agents may explicitly bookmark the current version vector, giving it a meaningful name. This is analogous to tagging a commit in version control.

---

## 3. Values

A `value` constraint asserts a **Value** as the content of a node. Values are scalars or references — compound structures (objects, arrays) are expressed through the tree itself, not through compound value payloads.

```
Value =
  | null                // absence (for Map deletion via LWW)
  | bool                // true / false
  | int                 // arbitrary-precision signed integer
  | float               // IEEE 754 double-precision float
  | string              // UTF-8 encoded text
  | bytes               // raw binary (Uint8Array)
  | ref(CnId)           // reference to a structure constraint (for nesting)
```

**Why separate `int` and `float`?** A single `f64` type (as in earlier drafts) creates a cross-language interoperability hazard. JavaScript represents all numbers as IEEE 754 f64, which can only exactly represent integers up to 2^53 − 1. A Rust agent storing a 64-bit database row ID as a user value would silently lose precision when a JavaScript agent reads it — and the two agents would compute different realities from the same store, breaking convergence.

The solution: values distinguish integers from floats at the type level.

- **`int`** is an arbitrary-precision signed integer. In JavaScript, this maps to `bigint`. In Rust, this maps to `i64` (or `i128` / BigInt for larger values). On the wire (§15.2), integers are encoded with their full precision — CBOR and MessagePack both natively distinguish integers from floats.
- **`float`** is IEEE 754 double-precision. In JavaScript, this maps to `number`. In Rust, this maps to `f64`.
- **Comparison semantics:** `int(3)` and `float(3.0)` are **distinct values**. They do not compare as equal. This avoids a class of subtle bugs where integer identity is lost through float coercion. Solver rules that need to compare across numeric types must do so explicitly.

Note: structural fields on constraints (`counter`, `lamport`, `layer`) are NOT `Value` instances. They are `safe_uint` — non-negative integers guaranteed to fit in f64 (see §1). The `int` type in `Value` has no such restriction and supports the full precision of the host language.

**Why no compound values?** In CCS, all structure is expressed through `structure` constraints. An "object" is a Map-policy node; an "array" is a Seq-policy node. Allowing compound values (nested objects, arrays) inside a single `value` constraint would create structure outside the constraint model — structure that cannot be individually addressed, retracted, or resolved by the solver. The `ref(CnId)` type is the bridge: it lets a value point to a subtree, keeping all structure in the tree.

**Nesting example:**

```
// A map key "todos" whose value is a sequence:
structure: { parent: profile_map, key: "todos" }           // map slot
structure: { container_id: "profile.todos", policy: Seq }   // sequence root
value:     { target: map_slot, content: ref(seq_root) }     // link
```

---

## 4. The Constraint Store

Each agent maintains a local **store** — the set of all constraints it has received (including its own assertions). The store grows monotonically.

**Merge** between two stores A and B:

```
merge(A, B) = A ∪ B
```

This is the join operation of the semilattice. It is:
- Commutative: A ∪ B = B ∪ A
- Associative: (A ∪ B) ∪ C = A ∪ (B ∪ C)
- Idempotent: A ∪ A = A

The store only grows. No constraint is ever removed (until compaction — see §12).

**Causal structure** emerges from the `refs` fields: if constraint b references constraint a, then a causally precedes b. The resulting graph is a DAG (acyclicity guaranteed by causality — you can only reference what you've observed). This causal graph is not a built artifact; it is a property of the communication history.

---

## 5. Authority & Validity

### 5.1 The Authority Chain

Every `authority` constraint traces a chain of grants back to the reality's creator (who holds implicit `Admin`). At any causal moment T (defined by a version vector), an agent P's **effective capabilities** are computed by replaying all `authority` constraints causally preceding T:

```
capabilities(P, T) =
  { Admin }                                    if P is the reality creator
  { C | ∃ grant(P, C) in constraints preceding T
        ∧ ¬∃ revoke(P, C) causally after the grant and preceding T }  otherwise
```

When multiple grants and revocations of the same capability exist, the **last-writer-wins by causal order** among authority constraints determines the effective state. Concurrent grant and revoke of the same capability resolves as **revoke-wins** (conservative).

### 5.2 Constraint Validity

A constraint c is **valid** if:
1. `c.sig` verifies against `c.id.peer`. (Cryptographic authenticity.)
2. `c.id.peer` held the required capability at c's causal moment. (Authorization.)

Required capabilities by constraint type:

| Constraint Type | Required Capability                                  |
| --------------- | ---------------------------------------------------- |
| `structure`     | `CreateNode(path)` where path matches the parent     |
| `value`         | `Write(path)` where path matches the target          |
| `retract`       | `Retract(scope)` covering the target constraint      |
| `rule`          | `CreateRule(layer)` where layer ≥ the rule's layer   |
| `authority`     | `Authority(C)` where C is the granted/revoked capability |

### 5.3 The Valid Set

```
Valid(S) = { c ∈ S | valid(c, S) }
```

**Properties:**
- Deterministic: same S → same Valid(S). (Authority chain replay is deterministic.)
- Invalid constraints remain in the store for auditability but do not participate in solving.
- Introspection can report: "constraint c₁₇ by agent X was not admitted because X lacked Write(['profile']) at that causal moment."

### 5.4 Interaction with Retraction

Authority and retraction are independent filters applied in sequence:

```
Solvable(S) = Active(Valid(S))
```

Retraction operates only on valid constraints. An invalid constraint cannot be "activated" by retracting something — it fails the Valid filter before retraction is even considered. An invalid `retract` constraint has no dominance effect.

---

## 6. Retraction & Dominance

### 6.1 The Retraction Graph

The retraction graph is the subgraph induced by `retract` targeting:
- Nodes: all constraints in the store.
- Edges: r → c iff r is a `retract` constraint targeting c.

This graph is acyclic (inherited from the causal structure of the store).

### 6.2 Dominance

The dominance function `dom: Constraint → {active, dominated}` is defined over Valid(S):

1. If c has no valid `retract` constraints targeting it → `dom(c) = active`.
2. If c has at least one valid targeting `retract` r where `dom(r) = active` → `dom(c) = dominated`.
3. If all valid `retract` constraints targeting c are themselves dominated → `dom(c) = active`.

**Theorem.** `dom` is well-defined and unique (computed by reverse topological traversal of the acyclic retraction graph).

### 6.3 The Active Set

```
Active(S) = { c ∈ Valid(S) | dom(c) = active }
```

**Properties:**
- Deterministic: same S → same Active(S).
- Commutativity/idempotence inherited from set union on S.
- Adding a `retract` constraint cascades through the retraction graph in O(chain depth), typically O(1).

### 6.4 Retraction Depth

The system may impose a maximum retraction depth d:

| d   | Meaning                                       |
| --- | --------------------------------------------- |
| 0   | No retraction. Monotonic constraint growth.   |
| 1   | Retract values only. No undo-of-undo.         |
| 2   | Undo + redo. Recommended default.             |
| ∞   | Unlimited retraction chains.                  |

Depth is a per-reality configuration, not a kernel constraint.

---

## 7. The Solver

The solver examines active, valid constraints and constructs the reality. It is **version-parameterized**: it accepts an optional version vector V that restricts the store to constraints at or before V, enabling time travel.

### 7.1 Version-Parameterized Solving

```
solve(S)    = solve(S, V_current)     // current reality (default)
solve(S, V) = solve(Active(S_V), AllStructure(Valid(S_V)))

where S_V = { c ∈ S | c.id ≤ V }     // the store "at time V"
```

When V is omitted, the solver uses the agent's current version vector (all constraints in the local store). When V is provided, the solver filters to constraints that existed at causal moment V.

**This is the time travel primitive.** Every historical reality is computable by supplying a version vector. The solver is a pure function; the same (S, V) always produces the same reality.

The solver receives:
- **All valid `structure` constraints in S_V** (regardless of dominance — structural assertions are permanent, but must be authorized).
- **Active `value` constraints in S_V** only (dominated values are excluded from the reality at V).
- **No `retract` constraints** (retraction is fully resolved by the Active computation over S_V).

### 7.2 Solver Pipeline

```
Constraint Store (S), Version Vector (V)
    │
    ▼
S_V = { c ∈ S | c.id ≤ V }           // filter to causal moment V
    │
    ▼
Valid(S_V)                            // authority filter (deterministic, §5)
    │
    ├──→ AllStructure(Valid(S_V))         // all valid structure constraints at V
    │         │
    │         ▼
    │    Build skeleton                   // the tree structure at V
    │
    └──→ Active(Valid(S_V))              // dominance computation at V (§6)
              │
              ▼
         Active values                    // filter to value constraints only
              │
              ▼
         Resolve                          // apply policies to populate skeleton
              │
              ▼
         Reality at V                     // the shared reality at causal moment V
```

### 7.3 The Reality

The shared reality is a rooted tree:

```
Reality {
  root: Node
}

Node {
  id:       CnId            // the structure constraint that created this
  policy:   Policy          // Map | Seq
  children: OrderedMap<ChildKey, Node>
  value:    Value | null    // resolved content (LWW across active value constraints)
}
```

`ChildKey` depends on policy:
- **Map**: the user-provided key string.
- **Seq**: the position index (determined by Fugue ordering).

---

## 8. Policies

Policies parameterize two behaviors at each node: **child identity** and **sibling ordering**. They are the ONLY thing that differs between Map and Sequence. Value resolution (LWW) is universal and orthogonal to policy.

### 8.1 Map Policy

- **Child identity**: context-free. Determined by `(parent, key)`.
- **Sibling ordering**: deterministic but semantically unimportant (e.g., lexicographic by key).
- **Conflict resolution**: Multiple active `value` constraints for the same `(parent, key)` slot → LWW (highest lamport; peer ID breaks ties).
- **Deletion**: A `value` constraint with `content = null` competes via LWW. If the null-valued constraint wins, the key is absent from the reality.

Multiple `structure` constraints may exist for the same `(parent, key)`. They represent the same logical slot. The solver groups them by `(parent, key)` and collects all active `value` constraints across all such nodes for conflict resolution.

### 8.2 Sequence Policy

- **Child identity**: causally bound. Each `structure` constraint has a unique CnId as its identity.
- **Sibling ordering**: Fugue interleaving. Determined by `(origin_left, origin_right)` and CnId tiebreaking (lower peer ID goes left, per Fugue).
- **Conflict resolution**: N/A — identities are always unique, so no two elements compete for the same slot.
- **Deletion**: Retract the `value` constraint for a sequence node. The `structure` constraint persists in the ordering tree. The element is structurally present but invisible in the reality.

---

## 9. Incremental Maintenance

When a new constraint c is received and added to the store:

The engine first checks `valid(c, S)`. If invalid, c is stored (for auditability) but does not enter the solver pipeline. If valid:

### 9.1 If c is a `structure` constraint

- Add c to the skeleton.
- Recompute sibling ordering for c's parent (Seq: insert into Fugue tree; Map: insert into key set).
- No existing node changes status.
- **Cost**: O(1) amortized for Map; O(log n) for Seq (Fugue tree insertion).

### 9.2 If c is a `value` constraint

- c is active (no retractors yet).
- Add c to the active values for c.target's slot.
- Re-resolve the slot (LWW comparison — universal for all nodes).
- Emit a state-change delta if the resolved value changed.
- **Cost**: O(1) for Seq; O(competing values) for Map, typically O(1).

### 9.3 If c is a `retract` constraint

- Compute dominance cascade from c.target:
  - c is active → c.target becomes dominated.
  - If c.target was a retraction, c.target's own target may become active (un-retraction).
  - Cascade through retraction graph.
- For each constraint whose status changed, update the active value set for its slot.
- Re-resolve affected slots.
- Emit state-change deltas.
- **Cost**: O(retraction chain depth), typically O(1).

### 9.4 If c is an `authority` constraint

- Recompute `capabilities(target_peer, T)` for affected causal moments.
- Re-evaluate `valid(c', S)` for any constraint c' by `target_peer` that was previously valid/invalid and whose status may have changed.
- Cascade: re-evaluate Active set for any constraints whose validity changed.
- Emit state-change deltas for affected paths.
- **Cost**: O(constraints by target_peer after the authority constraint), but bounded in practice by the stability frontier — only recent constraints need re-evaluation.

### 9.5 If c is a `rule` constraint

- Determine the **scope** of the rule: which paths/patterns/slots does it affect?
- Re-solve only the affected region of the reality.
- The solver tracks **provenance**: which rules contributed to which slots. When a rule is added or retracted, only the slots that depended on the changed rule (or could now be affected by the new rule) need re-solving.
- Emit state-change deltas for affected paths.
- **Cost**: O(affected region), not O(total reality). Bounded by rule scope.

### 9.6 Delta Propagation

```
Constraint received
    │
    ▼
Δ_active = changed constraints in Active set  // from retraction/authority cascade
    │
    ▼
Δ_values = changed slot resolutions           // from re-resolving affected slots
    │
    ▼
Δ_queries = changed query results             // propagated through user queries
```

Each layer produces a bounded delta proportional to what changed, not to the size of the reality.

---

## 10. Time Travel

The version-parameterized solver (§7.1) makes any historical reality computable: `solve(S, V)` for any version vector V ≤ V_current. This section defines the mechanisms built on top of this primitive.

### 10.1 Snapshots

A **snapshot** is a materialized (V, Reality) pair — the reality at a specific version vector, pre-computed and cached.

```
Snapshot {
  version:   VersionVector,   // the causal moment
  reality:   Reality,         // the full solved tree at this moment
  bookmark:  CnId | null      // the bookmark constraint that names this moment, if any
}
```

**Purpose:** Computing `solve(S, V)` from scratch is O(|S_V|). Snapshots amortize this cost. A time-travel query finds the nearest snapshot V_snap ≤ V and incrementally applies the delta:

```
reality_at(V) =
  let V_snap = nearest_snapshot(V)
  let Δ = { c ∈ S_V | c.id > V_snap }     // constraints between snapshot and target
  incrementally_apply(snapshot(V_snap).reality, Δ)
```

This turns an O(|S_V|) re-solve into an O(|Δ|) incremental update.

**Snapshot creation:** Snapshots may be created:
- Automatically when the stability frontier advances (§11).
- Automatically at regular Lamport intervals.
- Explicitly when an agent creates a `bookmark` constraint (§2.6).
- On demand for frequently-accessed historical points.

### 10.2 Incremental Time Scrubbing

When a user scrubs through history (e.g., a slider UI), each step is a small causal delta from the previous version vector. Rather than re-solving at each position, the system processes deltas incrementally:

```
// Moving forward in time: V₁ → V₂ where V₁ ≤ V₂
Δ_forward = { c ∈ S | V₁ < c.id ≤ V₂ }
reality_at(V₂) = incrementally_apply(reality_at(V₁), Δ_forward)

// Moving backward in time: V₂ → V₁ where V₁ ≤ V₂
// Reverse is harder — must either:
//   (a) revert from nearest snapshot before V₁, or
//   (b) maintain an undo log during forward scrubbing
```

Forward scrubbing is O(|Δ|) per step. Backward scrubbing requires snapshots as checkpoints, making snapshot density a performance/space tradeoff.

### 10.3 Branching

A **branch** is an agent whose initial version vector is a historical point V. No store is copied. Since constraints are immutable, the branch shares the underlying store and simply views it through V:

```
// A branch is an agent:
branch.version_vector = V              // "I have observed constraints up to V"
branch.local_store = {}                // new assertions go here

// The branch's effective store is a view, not a copy:
branch.effective_store = { c ∈ S | c.id ≤ V } ∪ branch.local_store

// The branch's reality:
branch.reality = solve(branch.effective_store)
```

**Branches are agents. Agents are branches.** An agent who goes offline at version vector V, makes assertions, and comes back online is indistinguishable from a "branch from V." A network partition that splits two groups of agents is indistinguishable from two branches diverging. The system already handles all of this — it is the normal operation of CCS.

```
// These are the same thing:
//
//   "Alice went offline and made edits"
//   = Alice's version vector stopped advancing; she asserted
//     constraints with refs ≤ V; when she syncs, her constraints
//     are delivered as messages and merged via ∪.
//
//   "Create a branch from V"
//   = A (real or virtual) agent starts with version vector V;
//     it asserts constraints with refs ≤ V; when it merges,
//     its constraints are delivered as messages and merged via ∪.
```

**Use cases:**
- **"What if" exploration**: Create a virtual agent at V, make experimental assertions, examine the resulting reality. Discard if unwanted (simply don't deliver the constraints).
- **Conflict resolution**: Examine the reality at the point of divergence between two agents. Understand both perspectives in their original context. Issue a resolution constraint in the main store.
- **Parallel drafts**: Multiple agents (real or virtual) start from the same V, develop independently, then selectively deliver constraints to each other.

**Merging a branch is sync.** Deliver the branch's constraints to other agents as messages. The solver resolves any conflicts using the same mechanisms it always does (LWW, Fugue, etc.). There is no special merge operation for branches — it is the same ∪ that handles all message delivery.

**There is no "branch" concept in the kernel.** There are only agents with version vectors. Branching is an emergent property of the existing model, just as the causal graph is an emergent property of message delivery.

### 10.4 Named Time Travel

Bookmarks (§2.6) let agents name version vectors. Time-travel queries can use names instead of raw version vectors:

```
reality_at("v1.0")                 →  look up bookmark  →  solve(S, V_bookmark)
reality_at("before-alice-refactor") →  look up bookmark  →  solve(S, V_bookmark)
diff("v1.0", "v2.0")              →  compare two named realities
```

This bridges human temporal concepts ("go back to version 1.0") and the causal coordinate system.

---

## 11. Settled & Working Sets

The solver need not re-examine the entire store on every new constraint. The store partitions into two regions with different computational roles.

### 11.1 Causal Stability Frontier

The **stability frontier** V_stable is a version vector such that all agents have received all constraints with CnIds ≤ V_stable. Computed by periodic exchange of version vectors between agents.

### 11.2 Settled Set

**Definition.** A slot in the reality is **settled** at V_stable iff:

1. The winning value constraint and all competing constraints for the slot are ≤ V_stable.
2. The retraction status of all relevant constraints is final: their retraction chains are entirely below V_stable and depth-exhausted (no future retraction can change their dominance status).
3. No active `rule` constraint above V_stable could affect this slot's resolution.

**Property:** A settled slot's contribution to the reality is **frozen**. No future constraint can change the solver's output for this slot. The solver's output can be cached indefinitely and never re-examined.

### 11.3 Working Set

**Definition.** The **working set** is everything not settled — parts of the reality where new constraints could change the solver's output.

The working set includes:
- Slots with active constraints above V_stable.
- Slots with active constraints below V_stable but whose retraction status is not yet final (e.g., retraction depth has not been exhausted and re-retraction is possible from above V_stable).
- Slots affected by `rule` constraints above V_stable.

### 11.4 The Solver Boundary

```
┌──────────────────────────────────────────────────────┐
│                  Constraint Store (S)                │
│                                                      │
│   ┌────────────────────┐   ┌──────────────────────┐  │
│   │   ≤ V_stable       │   │   > V_stable         │  │
│   │   All agents have  │   │   Still propagating  │  │
│   │   observed these   │   │   between agents     │  │
│   └────────────────────┘   └──────────────────────┘  │
└──────────────────────────────────────────────────────┘
             │                         │
             ▼                         ▼
  ┌────────────────────┐   ┌──────────────────────────┐
  │   Settled region   │   │   Working set            │
  │                    │   │                          │
  │   Materialized     │   │   Solver operates here.  │
  │   snapshot.        │   │   Incrementally updated  │
  │   Never re-solved. │   │   as constraints arrive. │
  │   Read-only cache. │   │                          │
  └────────────────────┘   └──────────────────────────┘
```

**Tractability guarantee:** The solver's cost is proportional to the working set, not to the total reality. For a large reality with many agents, most slots are settled at any given moment. The solver processes only the leading edge — recent constraints that have not yet stabilized.

### 11.5 Frontier Advancement

As agents exchange version vectors, V_stable advances. When V_stable advances:

1. Constraints that were > V_stable may now be ≤ V_stable.
2. Slots that were in the working set may now be settled.
3. Newly settled slots are materialized into the snapshot and removed from solver consideration.
4. The working set shrinks.

This is a monotonic process: once a slot is settled, it stays settled (unless the reality's retraction depth is ∞ and V_stable alone cannot guarantee finality — see §6.4).

---

## 12. Compaction

The constraint store grows without bound. Compaction reclaims space by removing constraints that can never affect future solving — but it trades history for space. The compaction policy determines this tradeoff.

### 12.1 Compaction Policy

Compaction is configured per-reality. Each agent may choose its own policy (subject to the constraint that all agents in a sync group must agree on the minimum retention level for convergence).

| Policy | Retains | Time Travel | Storage Cost |
| --- | --- | --- | --- |
| **Full history** | All constraints, forever | Any version vector | Highest |
| **Snapshot-preserving** | Compact freely, but preserve snapshots at bookmarked version vectors | At snapshot granularity only | Medium |
| **Frontier-only** | Compact below V_stable aggressively | Only above V_stable | Lowest |

**Full history** is appropriate for realities where auditability, legal compliance, or rich time-travel UX are required.

**Snapshot-preserving** is the recommended default. Historical realities are available at bookmark granularity. Between bookmarks, the exact historical state may not be reconstructable, but the bookmarked points are preserved.

**Frontier-only** is appropriate for high-throughput, space-constrained environments where history beyond the stability frontier is not needed.

### 12.2 Safe Compaction Rules

A constraint c is **safe to compact** if:

1. **Dominated value below frontier**: c is a `value` constraint, `dom(c) = dominated`, and both c and all its retractors are ≤ V_stable. Additionally, retraction depth limit ensures no future un-retraction (or: c's retractor is also below frontier and the retraction depth for the chain is exhausted).

2. **Superseded value below frontier**: c is a `value` constraint for a slot, and a higher-lamport active `value` constraint for the same slot exists, and both are ≤ V_stable. (c can never win again.)

3. **Retraction pair below frontier**: c is a `retract` constraint, its target t is also ≤ V_stable, both are dominated or both are compactable by rules 1–2. Remove both c and t.

`structure` constraints are **never compacted** (they are permanent and may be referenced by future assertions' origin_left/origin_right).

`authority` constraints are **never compacted** (they define the validity of all subsequent constraints and must be replayable).

**Snapshot-preserving exception:** Under the snapshot-preserving policy, a constraint that is otherwise safe to compact MUST be retained if it contributed to any preserved snapshot. The snapshot's reality depends on it; removing it would make the snapshot non-reconstructable.

### 12.3 Compaction as Rewriting

Compaction does not change the reality. It is a transformation S → S' where:
- S' ⊂ S
- solve(Active(S'), AllStructure(S')) = solve(Active(S), AllStructure(S))
- All agents must compact identically (deterministic compaction, coordinated via V_stable).

---

## 13. Batching & Compact Encoding

### 13.1 Theoretical Model

The theoretical model is: **one constraint per assertion**. Each character in a text sequence is its own constraint with its own CnId, signature, and causal context. This is the model the solver operates on.

### 13.2 Batch Encoding

For efficiency, consecutive constraints from the same agent may be **batched** — encoded as a single unit in storage and on the wire.

```
Batch {
  peer:         PeerID,
  counter_start: u64,          // first CnId counter in the batch
  count:        u64,           // number of constraints in the batch
  lamport_start: u64,          // first Lamport timestamp
  refs:         CnId[],        // shared causal context (refs for the first constraint)
  type:         ConstraintType, // all constraints in the batch share a type
  payloads:     Payload[],     // one per constraint, compressible
  sig:          Signature      // single signature covering the entire batch
}
```

**Properties:**
- A batch of N constraints has CnIds `(peer, counter_start)` through `(peer, counter_start + N - 1)`.
- Lamport timestamps are `lamport_start` through `lamport_start + N - 1`.
- For sequential Seq insertions, `refs` for constraint K+1 can be inferred: it includes constraint K's CnId plus the shared `refs`. This avoids repeating causal context per constraint.
- A single signature covers the batch, replacing N individual signatures.

**Invariant:** A batch MUST be semantically equivalent to the individual constraints it encodes. Any agent can "unbatch" on receipt. The solver never sees batches — it sees individual constraints.

### 13.3 Design Consequence

CnId counters must support efficient **consecutive allocation** — agents must be able to pre-allocate a range of counters for a batch without coordination. This is satisfied by the (peer, counter) design, since each agent controls its own counter space.

---

## 14. Stratification

The system is organized in layers. Each layer is evaluated using only the layers below it.

### Layer 0 — Kernel (hardcoded, not retractable)

- Constraint identity, causal ordering, and signatures.
- Set union as merge.
- Authority model and validity computation.
- Retraction and dominance computation.
- Stratified rule evaluation.

Layer 0 is the "physics" of the system. It cannot be modified from within the system. Authority is Layer 0 — it cannot be overridden by `rule` constraints at any layer.

### Layer 1 — Default Solver Rules

- LWW value resolution (Datalog rules over active value constraints).
- Fugue sequence ordering (recursive Datalog rules over structure constraints).
- Map grouping by `(parent, key)`.

These are `rule` constraints asserted at reality creation (§B.8). They are replicated data in the store, not hardcoded algorithms. They can be retracted and replaced by any agent with the appropriate capabilities. Agents MAY implement native equivalents as an optimization (§B.7), but the rules in the store are the source of truth for semantics.

### Layer 2 — Configurable Rules

- Schema definitions and mappings.
- Custom conflict resolution strategies.
- Cross-container constraints (referential integrity, computed values).
- Soft constraints and preferences.

Expressed as `rule` constraints in the store. Retractable. Evolvable. Replicated. These are how agents assert not just what should be true, but how disagreements about what should be true should be resolved.

### Layer 3+ — User Queries

- Application-specific derived relations.
- Views, aggregations, joins across containers.
- Live/reactive: incrementally maintained as the store grows.

---

## 15. Messages & Sync

Constraints are delivered between agents as **messages**. A message is the wire encoding of one or more constraints (possibly batched per §12). The message is ephemeral (delivery mechanism); the constraint is persistent (enters the store).

### 15.1 Delta Sync

An agent computes a delta for a peer based on the peer's known version vector:

```
delta(S, V_peer) = { c ∈ S | c.id > V_peer }
```

The receiving agent merges:

```
S_peer' = S_peer ∪ delta
```

Convergence: after bidirectional message exchange, both agents have the same store.

### 15.2 Wire Format

Constraints are serialized with their full payload, individually or in batches (§13). Ordering on the wire must respect causality: if constraint a is in `refs` of constraint b, then a must precede b in the serialized stream. (Topological sort.)

### 15.3 Consistency Guarantee

Two agents that have received the same set of constraints compute:
1. The same authority chains and Valid set.
2. The same retraction graph (over valid constraints).
3. The same dominance function.
4. The same Active set.
5. The same reality.

Convergence requires only reliable delivery (every constraint is eventually delivered to every agent). No ordering or deduplication guarantees are needed from the transport — the semilattice handles both.

---

## 16. Query Layer

Queries operate at two levels, connected by provenance.

### 16.1 Level 1 — Queries over the Constraint Store

The constraint store is a relation:

```
Constraints(id, type, payload, refs, peer, lamport)
```

Standard relational operations (σ, π, ⋈, γ, ∪, −) apply directly. These queries answer questions about history, authorship, causality, conflicts, and retractions.

### 16.2 Level 2 — Queries over the Reality

The reality exposes relations per policy:

```
MapEntries(container, key, value, determined_by)
SeqElements(container, position, value, determined_by)
```

The `determined_by` column is a CnId — the bridge to Level 1. A Level 2 query can join back to Level 1 to answer "why does the reality look this way?"

### 16.3 Incremental Evaluation

Queries are incrementally maintained via the delta pipeline (§9.6). Queries may also be parameterized by version vector, enabling historical queries (e.g., "what did this join return at V?"). When a new constraint enters the store, the delta propagates through:

1. Active set update (O(retraction depth))
2. Slot re-resolution (O(affected slots))
3. Query re-evaluation (O(query-specific, typically proportional to delta size))

This follows the DBSP (Database Stream Processing) algebraic framework: every relational operator has an incremental counterpart that processes deltas rather than full relations.

---

## 17. Introspection

Because all state is derived from constraints, introspection is a query over the store:

**explain(path)**: "Why does the reality have this value here?"
→ Find the winning `value` constraint. Report its provenance (agent, lamport). Report all competing constraints and why they lost (lower lamport, retracted, not admitted by authority, etc.).

**conflicts(path)**: "Are there unresolved perspectives at this path?"
→ Find all active `value` constraints for the slot. If more than one, report them with their resolution.

**history(path)**: "What has been asserted about this path?"
→ All `value` constraints (active and dominated) for the slot, ordered by lamport.

**whatIf(constraints)**: "What would the reality be if these hypothetical constraints were asserted?"
→ Compute solve(Active(S ∪ hypothetical), AllStructure(S ∪ hypothetical)). Non-destructive.

**capabilities(agent)**: "What can this agent assert right now?"
→ Replay the authority chain for agent P at the current causal frontier. Return the set of effective capabilities.

**authorityChain(agent, capability)**: "How did this agent get this capability?"
→ Trace the chain of `authority` constraints from the grant of C to agent P back to the reality's creator. Return the full chain with each grantor, timestamp, and capability.

**rejected(agent?)**: "What assertions were not admitted, and why?"
→ All constraints in S \ Valid(S), optionally filtered by agent. For each, report the missing capability and the authority state at the causal moment of assertion.

**at(V, query)**: "What was the answer to this query at causal moment V?"
→ Run any introspection query against `solve(S, V)` instead of `solve(S)`. This is the general time-travel query — every query above is implicitly parameterizable by version vector.

**diff(V₁, V₂)**: "What changed between two points in causal time?"
→ Compare `solve(S, V₁)` and `solve(S, V₂)`. Report added, removed, and changed slots. If V₁ and V₂ are named bookmarks, use names.

**bookmarks()**: "What named points in time exist?"
→ All active `bookmark` constraints, with their names and version vectors.

**branch(V)**: "Create a virtual agent at causal moment V."
→ Create an agent whose version vector is V, sharing the existing store. Return a handle for making assertions and queries against the branched reality. Merging back is message delivery.

---

## 18. Invariants & Guarantees

| Property                    | Guarantee                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------- |
| **Convergence**             | Same constraints → same reality. Always.                                               |
| **Semilattice**             | Constraint stores under ∪. Commutative, associative, idempotent.                       |
| **Monotonic growth**        | The store only grows (pre-compaction).                                                 |
| **Structural permanence**   | `structure` constraints are never retracted or compacted.                               |
| **Authority**               | Capabilities are enforced by the kernel. No self-escalation. Revoke-wins on concurrency. |
| **Auditability**            | Invalid constraints are stored. Every capability traces to the reality's creator.       |
| **Causal retraction**       | You can only retract what you've observed. The retraction graph is always acyclic.      |
| **Solver independence**     | Solvers never see retractions or invalid constraints. Active(Valid(S)) is the interface. |
| **Incremental maintenance** | Cost proportional to the working set, not total reality.                               |
| **Full introspection**      | Every value in the reality is traceable to the constraint(s) that produced it.          |
| **Schema evolution**        | Changing solver rules changes the reality, not the constraints.                         |
| **Coordination-free**       | Monotonic assertions need no coordination (CALM). Stratification handles the rest.      |
| **Tractable solvability**   | The settled/working partition bounds solver cost to the leading edge of activity.        |
| **Time travel**             | Any historical reality is computable via `solve(S, V)`. Snapshots amortize cost.        |
| **Branching**               | A branch is an agent at a historical version vector. No copy. Merging is sync. |

---

## Addendum: Design Rationale

This addendum explains the reasoning behind the spec's key design choices. The spec says *what*; this section says *why*.

### A.1 Why "Constraints," Not "Events" or "Operations"

An operation says "do this." An event says "this happened." A constraint says "this should be true." The distinction matters because it reflects the epistemology of a distributed system.

In a distributed system, there is no shared clock, no global state, no omniscient observer. Each agent has its own subjective experience — its own partial view of the world, its own intentions. What one agent knows is different from what another knows. There is no pre-existing shared reality to "edit."

A constraint is the right primitive because it maps to this subjective condition. When an agent asserts "name should be Alice," they are not claiming a global fact. They are expressing their perspective — what they believe should be true, given what they know. Another agent may simultaneously assert "name should be Bob." Neither is wrong. They are independent perspectives that have not yet been reconciled.

The shared reality *emerges* when the solver examines all perspectives and constructs a state that accounts for them. It is not discovered; it is synthesized. This is why the spec uses "constraint" (a subjective assertion about what could be) rather than "event" (a claim about what happened in a shared spacetime that doesn't exist).

### A.2 Why "Messages," Not "Sync" or "Replication"

A message is something one agent sends to another, carrying their assertion. It is inherently perspectival — it comes *from* someone, carrying *their* constraint. "Replication" and "sync" imply copying a shared object between locations. But there is no shared object being copied. There are independent agents communicating their perspectives. Messages capture this.

The causal graph (what the previous literature calls an "event DAG") is not a built artifact. It is what emerges from the pattern of messages between agents — a property of the communication history, not a thing anyone constructs. The spec describes it as emergent (§4) rather than primary.

### A.3 Why "Reality," Not "Document" or "State"

"Document" implies a pre-existing artifact being edited — a thing with an identity independent of its contents. "State" is neutral but suggests a machine's internal condition. "Reality" captures the key insight: the shared state is *constructed* from independent perspectives by a deterministic process. It is intersubjective — not objective (existing independent of observers) and not merely subjective (existing only for one observer), but arising from the combination of multiple subjective viewpoints.

### A.4 Why the Structure/Value Decomposition

Traditional CRDTs treat insertion and deletion as operations on a monolithic element. A Fugue element is a single record containing both its position (origins) and its content (the character). Deleting it creates a "tombstone" — a special status meaning "structurally present but invisible."

The spec decomposes this into two independent constraints: a `structure` constraint (permanent, defines position) and a `value` constraint (retractable, defines content). This makes tombstones disappear as a concept. A "deleted" element is simply one whose `value` constraint has been retracted — its `structure` constraint remains, keeping the ordering tree intact. There is no special "tombstone" status; there are just constraints, some active, some not.

This decomposition has a practical consequence: the ordering tree is immutable once built. Deletion only changes the visibility filter, never the tree structure. Undo-of-delete is O(1) — retract the retraction, and the element reappears at its original position because the `structure` constraint never moved.

### A.5 Why Only Two Policies

Maps and Sequences appear to be fundamentally different data structures. But they are the same tree shape — a node with child edges — differentiated by a single question: **how are children identified?**

- **Map (context-free identity)**: Two agents who have never communicated can independently target the same slot by using the same key string. The key's meaning is independent of when or by whom it was created. This is why Map entries can conflict — two agents targeting "name" are competing for the same slot.

- **Sequence (causally-bound identity)**: Each element's identity encodes the state of the world at its creation — specifically, which elements were to its left and right. No two agents can create the same element, because no two creation moments have identical causal context. This is why Sequence insertions never conflict — they interleave.

There is no third option. Every child edge is either context-free (its identity is its content) or causally-bound (its identity is its birth context). The spec has two policies because there are exactly two identity semantics.

Value resolution (LWW) is orthogonal to policy — it applies universally to any node with competing `value` constraints. What was previously called a "Register" is simply any node with values and no children. It needs no policy of its own.

### A.6 Why Retraction Is an Assertion, Not Removal

Removing a constraint from the store would break the semilattice. If replica A removes constraint c and replica B hasn't, then A ∪ B puts c back. Convergence is lost.

Instead, retraction is a *new* constraint — an assertion that a previous assertion should no longer participate in the shared reality. The store still only grows. The Active set (what the solver sees) may shrink, but the store itself is monotonic.

This has a precise algebraic structure. The retraction graph is acyclic (you can only retract what you've observed — causality prevents cycles). The dominance function has a unique fixed point (computable by topological traversal). Retraction of retraction gives undo/redo via parity. Multiple concurrent retractions of the same target require each to be individually addressed. The solver never sees retractions — it operates on Active(Valid(S)), which is the store with validity and dominance already resolved.

### A.7 Why Authority Is in the Kernel

If authority rules were `rule` constraints (Layer 2+), a malicious agent could add a rule asserting "all my constraints are authorized." Authority checking must be prior to rule evaluation — it determines which constraints (including rules) are admitted to the store's active set. This is why authority is Layer 0: it is part of the physics of the system, not a configurable policy.

The model frames authority not as "who can create events" but as "whose perspective is admitted to the consensus." An unauthorized agent can still assert constraints — their assertions are received and stored (for auditability) — but they are excluded from the Valid set and do not influence the reality.

### A.8 The Settled/Working Boundary

A naive solver would re-examine the entire store on every new constraint. The settled/working partition makes this unnecessary.

A slot is *settled* when all constraints that could affect it are below the stability frontier (all agents have seen them) and their retraction status is final. Once settled, the solver's output for that slot is frozen — no future constraint can change it. The solver only processes the *working set*: the leading edge of recent activity where new constraints are still arriving and retraction status is not yet final.

This is the tractability guarantee that makes CCS practical for large realities. The solver's cost is proportional to the working set (recent, unsettled activity), not to the total size of the reality. For a reality with millions of settled constraints and a handful of active collaborators, the solver processes only the handful.

### A.9 Relationship to Prior Work

**Concurrent Constraint Programming (Saraswat, 1993):** CCS takes its tell/ask vocabulary and monotonic store model from CCP. The constraint store grows monotonically; agents tell constraints and ask the store for derived state. CCS extends CCP with causal ordering, retraction, authority, and a distributed replication model.

**CRDTs (Shapiro et al., 2011):** CCS maintains all CRDT guarantees — commutativity, associativity, idempotence, convergence. The constraint store under union is a join-semilattice. The solver is a deterministic function. The key shift: CRDTs put complexity in the merge function; CCS puts it in the solver. Same guarantees, different decomposition.

**Fugue (Weidner & Kleppmann, 2023):** The Sequence policy's ordering algorithm is Fugue. CCS reframes Fugue as a solver over structural constraints (origin_left, origin_right) rather than as a merge function over operation logs.

**CALM Theorem (Hellerstein, 2010; Ameloot et al., 2011):** "A distributed program is eventually consistent without coordination iff it is monotonic." CCS's store growth is monotonic (coordination-free). The solver uses negation (retraction) and aggregation (LWW), which are non-monotonic — CALM tells us these require stratification, which the spec provides.

**Dedalus (Alvaro et al., 2011):** A temporal extension of Datalog for distributed systems. CCS can be viewed as a Dedalus program where constraints are extensional facts, the solver is intensional rules, and time is the causal partial order. The `rule` constraint type (§2.4) makes this connection explicit: solver rules as replicated Datalog facts.

**DBSP (Budiu & McSherry, 2023):** The algebraic framework for incremental view maintenance. The delta propagation pipeline (§9.6) follows DBSP: each layer produces bounded deltas that feed the next. This is the mechanism by which the solver avoids recomputation.

### A.10 Why Time Travel Is Not a Special Mode

In many systems, "history" is a separate subsystem — a log, a version control layer, an undo stack bolted onto the side. In CCS, time travel falls out of the existing architecture with zero new mechanisms.

The store already contains all historical constraints (pre-compaction). The solver is already a pure function. The version vector already parameterizes "which constraints have been observed." Combining these: `solve(S, V)` computes the reality at any historical moment V. No special mode, no separate history log, no undo stack. Just the solver, applied to a filtered store.

Snapshots and bookmarks are optimizations and UX, not new semantics. Incremental scrubbing reuses the same DBSP delta pipeline that handles live constraint arrival.

This is a consequence of the constraint-first design. Because the store is append-only and the solver is stateless, the past is always accessible. A system that mutates state in place must explicitly preserve history; a system that derives state from accumulated constraints gets history for free.

The tradeoff is compaction: preserving history means retaining constraints that a compaction-aggressive system would discard. The compaction policy (§12.1) makes this an explicit, per-reality choice rather than a global architectural constraint.

### A.11 Why Branching Is Not a Feature

Branching is perhaps the most striking example of an emergent property in CCS. It is not implemented, designed, or specified as a feature. It falls out of three pre-existing properties:

1. Constraints are immutable (so the store can be shared, not copied).
2. An agent is defined by its version vector (which constraints it has observed).
3. Sync is set union (delivering constraints from one agent to another).

A "branch from V" is just "an agent whose version vector is V." The agent makes assertions based on what it sees at V. Those assertions have `refs ≤ V`. When the agent delivers its constraints to others, the receivers merge via ∪ and the solver resolves any conflicts. This is identical to an agent who went offline at V, made edits, and came back online.

The system doesn't distinguish between "real" agents and "branches" because there is no distinction to make. An offline agent IS a branch. A network partition IS a fork. Reconnection IS a merge. These are all the same operation (set union) applied to the same objects (constraints) mediated by the same mechanism (message delivery). Branching is not a feature of CCS; it is a description of what CCS already does.

---

## Addendum B: Implementation & Interoperability Contract

This addendum defines what an agent must implement to participate in a CCS reality. It separates the **engine** (algorithms that must be implemented per-language) from the **data** (constraints that travel in the store, including solver rules). Two agents interoperate if they implement the same engine and exchange data via messages.

### B.1 The Engine

The engine is the local runtime that every agent executes. It consists of exactly two mandatory components:

```
┌─────────────────────────────────────────────────┐
│  Datalog Evaluator (mandatory)                  │
│  Stratified, bottom-up, semi-naive.             │
│  Evaluates all rule constraints in the store,   │
│  including the default solvers (LWW, Fugue).    │
├─────────────────────────────────────────────────┤
│  Layer 0: Kernel (mandatory)                    │
│  Constraint storage. Set union. CnId generation.│
│  Lamport clocks. Signatures. Authority/validity.│
│  Retraction/dominance. Version vectors.         │
└─────────────────────────────────────────────────┘
         ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄ ┄
┌─────────────────────────────────────────────────┐
│  Native Solvers (optional optimization)         │
│  Host-language LWW, Fugue, tree construction.   │
│  Must produce identical results to the Datalog  │
│  rules. Requires engine versioning.             │
└─────────────────────────────────────────────────┘
```

The key insight: **LWW and Fugue are not part of the engine.** They are Datalog rules that travel in the constraint store. The engine is Layer 0 (kernel) + a Datalog evaluator. Everything else is data.

### B.2 Layer 0 — Kernel (mandatory)

Every agent must implement these components. They are mechanical algorithms — no logic programming, no inference, no search. Given the same store, any two correct implementations produce identical results.

| Component | Algorithm | Notes |
| --- | --- | --- |
| CnId generation | `(peer, counter++)` | counter is per-agent, monotonically increasing |
| Lamport clock | `lamport = max(local, max_received) + 1` | standard Lamport timestamp |
| Signature creation | ed25519 sign `(id, lamport, refs, type, payload)` | standard library |
| Signature verification | ed25519 verify against `id.peer` | standard library |
| Store | set of constraints; insert; set union for merge | hash set by CnId |
| Version vector | `Map<PeerID, u64>`; track max counter per peer | updated on insert |
| Authority replay | walk `authority` constraints ≤ V; compute `capabilities(P, V)` | linear scan, cacheable |
| Valid(S) | for each `c ∈ S`: check `sig` + check capability at causal moment | per-constraint |
| Retraction graph | for each `retract` in Valid(S): add edge `r → target` | graph construction |
| Dominance | reverse topological traversal of retraction graph | O(\|retraction edges\|) |
| Active(S) | `{ c ∈ Valid(S) \| dom(c) = active }` | set filter |
| S_V filtering | `{ c ∈ S \| c.id ≤ V }` | for version-parameterized solving |
| Tree skeleton | build rooted tree from active `structure` constraints | mechanical graph construction |

**Correctness criterion:** Two implementations are compatible iff, for any store S, they compute the same `Active(Valid(S))` and the same tree skeleton.

### B.3 Datalog Evaluator (mandatory)

Every agent must implement a stratified Datalog evaluator. This is the solver. It evaluates rule constraints from the store over the facts derived from active constraints, producing the reality.

**Why Datalog and not Prolog:**

| Property | Prolog | Datalog |
| --- | --- | --- |
| Termination | Not guaranteed | Always terminates |
| Determinism | Non-deterministic (cut, order-dependent) | Deterministic (unique minimal model) |
| Negation | Negation-as-failure (order-dependent) | Stratified (order-independent) |
| Function symbols | Yes (infinite terms) | No (finite, flat facts) |
| Evaluation | Top-down, backtracking | Bottom-up, fixed-point |
| Result | Depends on rule order | Independent of rule order |

Datalog is chosen because convergence requires determinism. Two agents evaluating the same Datalog program over the same facts are guaranteed to produce the same minimal model. This is a theorem of Datalog's fixed-point semantics, not a property that implementations must carefully maintain — it is inherent.

**What the evaluator must support:**

1. **Positive Datalog:** Rules with conjunction in the body, no negation. Evaluated by iterated fixed-point (semi-naive).
2. **Stratified negation:** Rules may use `not` in the body, but only in ways that respect stratification — negated predicates must be fully computed at a lower stratum. The spec's stratification (§14) determines strata.
3. **Aggregation:** `min`, `max`, `count`, `sum` over groups of facts. Required for LWW (`max` by lamport) and other resolution strategies. Must be deterministic (well-defined for the value types in §3).
4. **Incremental evaluation:** Semi-naive evaluation processes deltas rather than recomputing from scratch. Required for the delta pipeline (§9.6) but correctness does not depend on it — a non-incremental evaluator produces the same result, just slower.

**Correctness criterion:** Two evaluators are compatible iff, for any set of Datalog rules and ground facts, they compute the same minimal model.

### B.4 Default Solver Rules

LWW and Fugue are not hardcoded algorithms. They are **Datalog rules that travel in the store** as `rule` constraints. A newly created reality includes these rules as part of its bootstrap constraints (alongside the creation constraint that grants `Admin` to the creator).

**LWW as Datalog:**

```
% The winning value for a slot is the one with the highest (lamport, peer).
winner(Slot, CnId, Value) :-
  active_value(CnId, Slot, Value, Lamport, Peer),
  not superseded(CnId, Slot).

superseded(CnId, Slot) :-
  active_value(CnId, Slot, _, L1, P1),
  active_value(CnId2, Slot, _, L2, P2),
  CnId \= CnId2,
  (L2 > L1 ; (L2 = L1, P2 > P1)).
```

**Fugue as Datalog (sketch):**

```
% An element's position is determined by its origins and the
% recursive structure of the Fugue tree.
fugue_child(Parent, CnId, OriginLeft, OriginRight, Peer) :-
  active_structure_seq(CnId, Parent, OriginLeft, OriginRight),
  constraint_peer(CnId, Peer).

% Left subtree: elements whose origin_left is this element.
% Right subtree: elements whose origin_right is this element.
% Tiebreak: lower peer goes left.
fugue_before(Parent, A, B) :-
  fugue_child(Parent, A, OriginLeft, _, PeerA),
  fugue_child(Parent, B, OriginLeft, _, PeerB),
  PeerA < PeerB.

% (Full specification requires the complete Fugue tree walk with
% transitive ordering. The recursive relation converges to a
% fixed point that defines the total order.)
```

Fugue's tree walk is more complex than LWW but is a finite, recursive computation over finite facts — exactly what Datalog computes.

**Because these rules are in the store:**
- A new agent joining the reality receives them via normal message delivery.
- No agent needs to independently implement LWW or Fugue.
- The rules can be retracted and replaced (e.g., switching from LWW to priority-based resolution) without any agent updating its code.
- All agents evaluate the same rules over the same facts → same reality. Convergence is guaranteed by Datalog's fixed-point semantics.

### B.5 The Minimal Agent

The minimal agent — one that can participate in any CCS reality — must implement:

1. Parse and serialize the constraint wire format.
2. Generate CnIds and maintain a Lamport clock.
3. Sign and verify ed25519 signatures.
4. Store constraints in a set; merge via union.
5. Compute Valid(S) by replaying authority chains and checking capabilities.
6. Compute Active(Valid(S)) by building and traversing the retraction graph.
7. Build a tree skeleton from active structure constraints.
8. Evaluate stratified Datalog with aggregation.

Items 1-7 are the kernel (Layer 0). Item 8 is the Datalog evaluator. **This is the complete engine.** There is no item 9. LWW, Fugue, custom resolution strategies, schema mappings, cross-container constraints — all are Datalog rules in the store.

The interoperability surface is correspondingly small:

```
Interoperable agents must agree on:

  1. The constraint wire format (serialization/deserialization)
  2. Layer 0 kernel algorithms (same Valid, same Active, same skeleton)
  3. Datalog semantics (same minimal model from same rules + facts)
```

That's it. Two agents — one in TypeScript, one in Rust — that implement the same kernel and the same Datalog semantics will compute the same reality from the same store, regardless of what solver rules the reality uses.

### B.6 What Travels in the Store

**What is implemented per-language (the engine):**
- Layer 0: kernel algorithms (~13 components, all mechanical)
- Stratified Datalog evaluator with aggregation

**What travels in the store (the data):**
- All constraints (structure, value, retract, authority, bookmark)
- Default solver rules (LWW, Fugue) — asserted at reality creation
- Custom resolution strategies — asserted by agents with `CreateRule` capability
- Schema definitions and mappings
- Cross-container constraints
- Any future solver extension

**What does NOT need to be implemented per-language:**
- LWW (it's a rule in the store)
- Fugue (it's a rule in the store)
- Any conflict resolution strategy (it's a rule in the store)
- Any schema mapping (it's a rule in the store)
- Any future solver behavior (it's a rule in the store)

### B.7 Native Solver Optimization

Evaluating LWW via Datalog is correct but inefficient — a native `max` comparison is faster than Datalog fixed-point iteration for a simple aggregation. Similarly, a native Fugue implementation outperforms Datalog evaluation of recursive ordering rules.

An agent MAY implement **native solvers** as an optimization:

```
// Instead of evaluating the LWW Datalog rules:
native_lww(slot) = max_by(active_values(slot), (c) => (c.lamport, c.peer))

// Instead of evaluating the Fugue Datalog rules:
native_fugue(parent) = fugue_tree_walk(active_structure_seq(parent))
```

**Constraints on native solvers:**

1. **Semantic equivalence:** A native solver MUST produce identical results to the Datalog rules it replaces, for all possible inputs. This must be proven or exhaustively tested.
2. **Engine versioning:** Because native solvers are per-language code (not replicated data), two agents with different native implementations could diverge. The reality's creation constraint specifies an **engine version** that pins the native solver behavior. Agents must implement the specified version.
3. **Fallback:** If the reality's solver rules are retracted and replaced with custom rules, native solvers must fall back to Datalog evaluation for the replacement rules. Native solvers are a fast path for known rules, not a bypass of the rule system.
4. **Transparency:** From the perspective of any other component (queries, introspection, incremental maintenance), a native solver is indistinguishable from Datalog evaluation. The optimization is internal to the agent.

**Engine version scope:** Only native solvers require versioning. The kernel (Layer 0) is specified by this document and does not vary. The Datalog evaluator is specified by Datalog's fixed-point semantics and does not vary. Native solvers are the only component where implementation choice could affect results — hence the version pin.

### B.8 Reality Bootstrap

When a new reality is created, the creation constraint carries:

1. **Admin grant** to the creating agent (as specified in §2.5).
2. **Default solver rules** — LWW and Fugue as `rule` constraints.
3. **Engine version** (optional) — if native solver optimization is intended.
4. **Compaction policy** — full history, snapshot-preserving, or frontier-only (§12.1).
5. **Retraction depth** — the maximum retraction chain depth (§6.4).

The default solver rules are ordinary `rule` constraints. They can be retracted and replaced by any agent with the appropriate `CreateRule` and `Retract` capabilities. Changing the solver rules changes the reality — not the engine, not the agents' code. Just the data.
