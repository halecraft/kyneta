# @kyneta/datalog

A stratified, semi-naive, incremental Datalog evaluator. Rules and facts in, derived facts out.

## Overview

You give it **facts** — ground tuples — and **rules** that derive more facts from them. It runs the rules to a fixed point and hands back everything that follows.

```ts
import {
  atom, evaluate, fact, positiveAtom, rule, varTerm as $,
} from "@kyneta/datalog"

// Fire spreads to any adjacent flammable cell. Recursive.
const fireSpread = rule(atom("lit", [$("X2"), $("Y2")]), [
  positiveAtom(atom("lit", [$("X1"), $("Y1")])),
  positiveAtom(atom("adj", [$("X1"), $("Y1"), $("X2"), $("Y2")])),
  positiveAtom(atom("flammable", [$("X2"), $("Y2")])),
])

const world = [
  fact("flammable", [0, 0]), fact("flammable", [1, 0]), fact("flammable", [2, 0]),
  fact("adj", [0, 0, 1, 0]), fact("adj", [1, 0, 2, 0]),
  fact("lit", [0, 0]),                                   // the spark
]

const result = evaluate([fireSpread], world)
if (result.ok) {
  result.value.getRelation("lit").tuples()   // [[0,0], [1,0], [2,0]]
}
```

Rules are **data**, not code: they are values you build, pass around, store, and change at runtime. That is what makes the engine useful as a rules layer rather than a compiler target.

## Install

```sh
pnpm add @kyneta/datalog
```

## Running it incrementally

`evaluate` is a batch. For a world that ticks, `createEvaluator` holds a database across calls and returns only what changed:

```ts
import { createEvaluator, factsToZSet, fact } from "@kyneta/datalog"
import { zsetAdd } from "@kyneta/zset"

const evaluator = createEvaluator([fireSpread])
evaluator.step(factsToZSet(world))            // load: derived facts come back

// A tick is new minus old. Facts that did not change cancel and never
// reach the evaluator.
const delta = evaluator.step(
  zsetAdd(
    factsToZSet([fact("flammable", [2, 0])], -1),  // this tile burned away
    factsToZSet([fact("flammable", [3, 0])]),      // this one appeared
  ),
)
```

```ts
interface Evaluator {
  step(delta: ZSet<Fact>): ZSet<Fact>         // ground facts in, derived facts out
  changeRules(delta: ZSet<Rule>): ZSet<Fact>  // every stratum derived again
  currentDatabase(): Database                 // live, not a snapshot
}
```

A one-fact tick over an 18,000-fact database costs about **0.016 ms**.

## What the language has

- **Positive atoms** — the joins. `positiveAtom(atom("adj", [$("X"), $("Y")]))`
- **Negation** — `negation(atom("lit", [$("X"), $("Y")]))`, stratified: a negated predicate is fully computed in a lower stratum first. Cyclic negation is rejected up front, as a value, not an exception.
- **Guards** — `eq`, `neq`, `lt`, `lte`, `gt`, `gte` over bound terms.
- **Aggregation** — `min`, `max`, `count`, `sum`, grouped by variables.
- **Wildcards** — `_` matches anything and binds nothing. Each occurrence is independent, unlike a named variable.
- **One arity per predicate** — a predicate has one width, and every mention of it must agree. `foo(X, Y)` in one rule and `foo(X, Y, Z)` in another is refused up front, as a value. Datalog usually treats those as two predicates; this engine keys relations by name alone, so a mixed-width relation would just be rows nothing matches.

## Values

```ts
type Value =
  | null | boolean | number | bigint | string | Uint8Array
  | { readonly ref: ValueRef }     // ValueRef = { peer: string; counter: number }
```

The union is closed, and `number` and `bigint` are **distinct** — `3` and `3n` never unify. That is deliberate: a 64-bit id stored as a double silently loses precision above 2^53, and two peers that disagree about a value compute different answers from the same facts.

`ValueRef` is an opaque composite identity — the engine serializes, orders and compares one, and never looks inside. It is there so a caller can put an identity in a fact without it colliding with a bare string.

## Host code

Some relations cannot be written as rules: a breadth-first distance field, a keyed hash per tile. Register those as **foreign relations** and the evaluator treats each as a stratum of its own, placed after its inputs and before its readers, re-run only when an input changes:

```ts
const host = {
  relations: [{
    predicate: "dist",
    arity: 3,
    inputs: ["origin", "adj", "blocked"],
    version: "1",
    compute(read, changed) { /* yield [x, y, d] tuples */ },
  }],
  functions: {
    hash: { arity: 3, version: "1", apply: (args) => /* … */ },
  },
}

const evaluator = createEvaluator(rules, host)
```

Both halves are **declared**, not just registered. `arity` is how wide the thing is — how many columns a relation holds, how many arguments a function takes — and it turns a shape mistake into a link error: a body reading `dist(X, Y)` when `dist` holds 3-tuples, or a call passing 3 arguments to a 4-argument function, is refused before anything runs rather than quietly matching nothing or returning `NaN`. `version` is a claim about *meaning*, for the thing the engine genuinely cannot check: two machines register their own code under the same name, and if that code differs they compute different answers from the same facts. Comparing versions makes the disagreement visible; `declarationErrors` is where a consumer checks a pack's expectations against a host.

Rules reference host code **by name only** — the declaration can travel, the code cannot.

## Who uses it

`@kyneta/perspective` — a constraint-based CRDT engine — runs its conflict-resolution rules on this evaluator, and was where it was first written. Nothing in this package knows about that: its input is facts and its output is derived facts.

## Documentation

- [TECHNICAL.md](./TECHNICAL.md) — the value domain, the evaluation plan, the join index, performance, and gotchas.
- [LEARNINGS.md](./LEARNINGS.md) — what the performance work taught, including what was measured and discarded.

## License

MIT
