# Prism

**Convergent Constraint Systems (CCS) — A constraint-based approach to CRDTs**

Prism is an experimental implementation exploring a new way of thinking about collaborative data structures. Instead of replicating state with merge functions, Prism replicates *constraints* and derives state through deterministic solving.

## Core Ideas

### Constraints as Truth, State as Derived

Traditional CRDTs replicate state and define merge functions. Prism flips this:

```typescript
// Traditional CRDT thinking:
// "The map has key 'name' with value 'Alice'"
map.set("name", "Alice");

// Prism thinking:
// "I assert that 'name' should equal 'Alice'"
doc.tell({ path: ["name"], assertion: { type: "eq", value: "Alice" } });

// State is computed by solving all constraints
const value = doc.ask(["name"]); // Solver determines the answer
```

### Trivial Merge, Complex Solving

Merge becomes set union—commutative, associative, idempotent. All the interesting semantics move to the solver:

```typescript
// Merge is just: A ∪ B
// Convergence comes from deterministic solving, not clever merge functions
```

### Schema as Interpretation

The same constraints can be viewed through different schemas:

```typescript
// V1 view sees: { name: string, age: number }
// V2 view sees: { fullName: string, birthYear: number }
// Same underlying constraints, different interpretations
```

### Introspection

You can always ask "why":

```typescript
const explanation = doc.explain(["user", "name"]);
// {
//   value: "Alice",
//   determinedBy: { peer: "peer1", lamport: 5, assertion: { type: "eq", value: "Alice" } },
//   conflicts: [
//     { peer: "peer2", lamport: 3, assertion: { type: "eq", value: "Bob" } }
//   ],
//   resolution: "LWW: higher lamport wins"
// }
```

## Installation

```bash
bun install
```

## Usage

```typescript
import {
  createConstraintStore,
  createMapHandle,
  createListHandle,
  createTextHandle,
  mergeStores,
} from "prism";

// Create a constraint store and handles
const store = createConstraintStore();

const profile = createMapHandle({
  peerId: "alice",
  store,
  path: ["profile"],
});

// Make changes (creates constraints internally)
profile.set("name", "Alice");
profile.set("age", 30);

// Read values (solves constraints)
console.log(profile.view().getKey("name")); // "Alice"

// Work with lists
const todos = createListHandle({
  peerId: "alice",
  store: profile.getStore(),
  path: ["todos"],
});
todos.push({ text: "Learn CRDTs", done: false });

// Work with text
const doc = createTextHandle({
  peerId: "alice",
  store: todos.getStore(),
  path: ["content"],
});
doc.append("Hello, world!");
console.log(doc.toString()); // "Hello, world!"

// Sync with another peer (merge constraint stores)
const bobStore = createConstraintStore();
const bobProfile = createMapHandle({
  peerId: "bob",
  store: bobStore,
  path: ["profile"],
});
bobProfile.set("name", "Bob");

// Merge: set union of constraints
const merged = mergeStores(profile.getStore(), bobProfile.getStore());
// Both peers converge to the same state
```

## Project Status

🚧 **Experimental** — This is a research project exploring CCS concepts.

### Implemented (Phases 1-5)

- [x] Core constraint types and store
- [x] Map container with LWW resolution
- [x] List container with Fugue-style ordering
- [x] Text container
- [x] Reactive views with subscriptions
- [x] Subscription manager (centralized event coordination)
- [x] Introspection API (explain why a value is what it is)
- [x] Constraint inspector (debugging and JSON export)
- [x] 460 tests including Loro equivalence tests

### Not Yet Implemented (Phase 6)

- [ ] PrismDoc coordinator (unified document interface)
- [ ] Constraint compaction

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                     PrismDoc                        │
│  Manages peers, version vectors, constraint store  │
└─────────────────────────┬───────────────────────────┘
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│ConstraintStore│  │   Solvers    │  │ ViewManager  │
│ - tell()      │  │ - Map (LWW)  │  │ - subscribe()│
│ - ask()       │  │ - List       │  │ - diff()     │
│ - merge()     │  │ - Text       │  │              │
└──────────────┘  └──────────────┘  └──────────────┘
```

## Theoretical Foundation

Prism maintains all CRDT guarantees:

- **Semilattice**: Constraint sets form a semilattice under union (⊆, ∪)
- **Convergence**: Same constraints → same solved state (deterministic solver)
- **Eventual consistency**: Guaranteed by union commutativity

Key terminology from Concurrent Constraint Programming:

- **Tell**: Assert a constraint into the store
- **Ask**: Query the result of solving constraints
- **Solve**: Compute state that satisfies all constraints

## Documentation

- [TECHNICAL.md](./TECHNICAL.md) — Architecture, algorithms, design decisions

## Related Work

- [Loro](https://github.com/loro-dev/loro) — High-performance CRDT library (state-based)
- Concurrent Constraint Programming (Saraswat)
- Fugue (Weidner et al.) — Sequence CRDT interleaving

## License

MIT