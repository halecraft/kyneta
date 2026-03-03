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
import { createPrismDoc, syncDocs } from "prism";

// Create a document
const alice = createPrismDoc({ peerId: "alice" });

// Get typed handles — all share the same constraint store
const profile = alice.getMap("profile");
const todos = alice.getList<string>("todos");
const notes = alice.getText("notes");

// Make changes (creates constraints internally)
profile.set("name", "Alice");
profile.set("age", 30);
todos.push("Learn CRDTs");
notes.append("Hello, world!");

// Read values (solves constraints)
console.log(profile.get());          // { name: "Alice", age: 30 }
console.log(todos.get());            // ["Learn CRDTs"]
console.log(notes.toString());       // "Hello, world!"

// Mutations through any handle are visible to all views
const profile2 = alice.getMap("profile");
console.log(profile2.get());         // { name: "Alice", age: 30 }

// Subscribe to changes
alice.onStateChanged(["profile", "name"], (event) => {
  console.log("Changed:", event.before, "→", event.after);
});

// Introspection: why is this value what it is?
const explanation = alice.introspect().explain(["profile", "name"]);
console.log(explanation.resolution); // "single constraint from alice"

// Sync with another peer
const bob = createPrismDoc({ peerId: "bob" });
bob.getMap("profile").set("name", "Bob");

syncDocs(alice, bob);
// Both docs converge to the same state
```

## Project Status

🚧 **Experimental** — This is a research project exploring CCS concepts.

### Implemented (Phases 1-6) ✅

- [x] Core constraint types and store
- [x] Map container with LWW resolution
- [x] List container with Fugue-style ordering
- [x] Text container
- [x] Reactive views with subscriptions
- [x] Subscription manager (centralized event coordination)
- [x] Introspection API (explain why a value is what it is)
- [x] Constraint inspector (debugging and JSON export)
- [x] PrismDoc coordinator (unified document interface)
- [x] Sync via delta export/import and direct merge
- [x] 476 tests including Loro equivalence and integration tests

### Future Work

- [ ] Constraint compaction
- [ ] Run-length encoding for Text
- [ ] Cross-container constraints

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                        PrismDoc                          │
│  Owns shared ConstraintStore, peer ID, clocks            │
│  Creates doc-bound handles (getMap, getList, getText)    │
│  Wires subscriptions, sync (delta/merge), introspection  │
└───────────────────────────┬──────────────────────────────┘
                            │
       ┌────────────────────┼────────────────────┐
       ▼                    ▼                    ▼
┌──────────────┐  ┌──────────────────┐  ┌────────────────┐
│ConstraintStore│  │    Solvers       │  │ Subscription   │
│ - tell/ask    │  │ - Map (LWW)     │  │ Manager        │
│ - merge       │  │ - List (Fugue)  │  │ - state CB     │
│ - delta sync  │  │ - (Text = List) │  │ - conflict CB  │
│ - generation  │  │                 │  │ - constraint CB│
└──────────────┘  └──────────────────┘  └────────────────┘
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

## Development

```bash
bun install          # Install dependencies
bun run test         # Run tests in watch mode
bun run test:run     # Run tests once
bun run typecheck    # TypeScript type checking
```

Key testing patterns:
- **Loro equivalence tests** compare Prism output against `loro-crdt` for identical interleaving
- `peerIdToNum()` ensures Loro's numeric peer IDs preserve the same ordering as Prism's string peer IDs
- Integration tests in `tests/integration.test.ts` cover the full PrismDoc stack

## Documentation

- [TECHNICAL.md](./TECHNICAL.md) — Architecture, algorithms, design decisions
- [LEARNINGS.md](./LEARNINGS.md) — Discoveries, corrections, and open questions from implementation

## Related Work

- [Loro](https://github.com/loro-dev/loro) — High-performance CRDT library (state-based)
- Concurrent Constraint Programming (Saraswat)
- Fugue (Weidner et al.) — Sequence CRDT interleaving

## License

MIT