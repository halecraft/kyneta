// === Stratification Tests ===
// Tests for dependency graph construction, SCC detection, stratification
// validation, cyclic negation rejection, finer-grained stratification,
// and partition key extraction.

import { describe, expect, it } from "vitest"
import {
  buildDefaultFugueRules,
  buildDefaultLWWRules,
  buildDefaultRules,
} from "../../src/bootstrap.js"
import {
  bodyPredicates,
  buildDependencyGraph,
  computeSCCs,
  extractPartitionKey,
  headPredicates,
  stratify,
} from "../../src/datalog/stratify.js"
import type { AggregationClause, Rule } from "../../src/datalog/types.js"
import {
  _,
  aggregation,
  atom,
  constTerm,
  eq,
  gt,
  negation,
  neq,
  positiveAtom,
  rule,
  varTerm,
} from "../../src/datalog/types.js"

// ---------------------------------------------------------------------------
// Dependency Graph Construction
// ---------------------------------------------------------------------------

describe("buildDependencyGraph", () => {
  it("builds graph from positive rules", () => {
    // path(X,Y) :- edge(X,Y).
    // path(X,Z) :- edge(X,Y), path(Y,Z).
    const rules: Rule[] = [
      rule(atom("path", [varTerm("X"), varTerm("Y")]), [
        positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
      ]),
      rule(atom("path", [varTerm("X"), varTerm("Z")]), [
        positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        positiveAtom(atom("path", [varTerm("Y"), varTerm("Z")])),
      ]),
    ]

    const graph = buildDependencyGraph(rules)

    expect(graph.predicates.has("path")).toBe(true)
    expect(graph.predicates.has("edge")).toBe(true)
    expect(graph.predicates.size).toBe(2)

    // path -> edge (positive), path -> path (positive, recursive)
    const pathEdges = graph.adjacency.get("path") ?? []
    expect(pathEdges.length).toBe(3) // edge from rule1, edge+path from rule2
    expect(pathEdges.every(e => !e.negative)).toBe(true)
  })

  it("marks negative edges for negation", () => {
    // filtered(X) :- candidate(X), not rejected(X).
    const rules: Rule[] = [
      rule(atom("filtered", [varTerm("X")]), [
        positiveAtom(atom("candidate", [varTerm("X")])),
        negation(atom("rejected", [varTerm("X")])),
      ]),
    ]

    const graph = buildDependencyGraph(rules)

    expect(graph.predicates.has("filtered")).toBe(true)
    expect(graph.predicates.has("candidate")).toBe(true)
    expect(graph.predicates.has("rejected")).toBe(true)

    const filteredEdges = graph.adjacency.get("filtered") ?? []
    const positiveEdges = filteredEdges.filter(e => !e.negative)
    const negativeEdges = filteredEdges.filter(e => e.negative)

    expect(positiveEdges.length).toBe(1)
    expect(positiveEdges[0]?.to).toBe("candidate")
    expect(negativeEdges.length).toBe(1)
    expect(negativeEdges[0]?.to).toBe("rejected")
  })

  it("marks aggregation source as negative edge (stratified like negation)", () => {
    const aggClause: AggregationClause = {
      fn: "max",
      groupBy: ["Slot"],
      over: "Lamport",
      result: "MaxL",
      source: atom("active_value", [varTerm("Slot"), varTerm("Lamport")]),
    }

    const rules: Rule[] = [
      rule(atom("max_lamport", [varTerm("Slot"), varTerm("MaxL")]), [
        aggregation(aggClause),
      ]),
    ]

    const graph = buildDependencyGraph(rules)

    const edges = graph.adjacency.get("max_lamport") ?? []
    expect(edges.length).toBe(1)
    expect(edges[0]?.to).toBe("active_value")
    expect(edges[0]?.negative).toBe(true) // aggregation treated as negative
  })

  it("handles empty rule set", () => {
    const graph = buildDependencyGraph([])
    expect(graph.predicates.size).toBe(0)
    expect(graph.edges.length).toBe(0)
  })

  it("handles rules with no body elements", () => {
    // axiom(42).
    const rules: Rule[] = [rule(atom("axiom", [constTerm(42)]), [])]

    const graph = buildDependencyGraph(rules)
    expect(graph.predicates.has("axiom")).toBe(true)
    expect(graph.predicates.size).toBe(1)
    expect(graph.edges.length).toBe(0)
  })

  it("handles multiple rules with mixed positive and negative dependencies", () => {
    // a(X) :- b(X), not c(X).
    // d(X) :- a(X), e(X).
    const rules: Rule[] = [
      rule(atom("a", [varTerm("X")]), [
        positiveAtom(atom("b", [varTerm("X")])),
        negation(atom("c", [varTerm("X")])),
      ]),
      rule(atom("d", [varTerm("X")]), [
        positiveAtom(atom("a", [varTerm("X")])),
        positiveAtom(atom("e", [varTerm("X")])),
      ]),
    ]

    const graph = buildDependencyGraph(rules)

    expect(graph.predicates.size).toBe(5) // a, b, c, d, e

    const aEdges = graph.adjacency.get("a") ?? []
    expect(aEdges.length).toBe(2)

    const dEdges = graph.adjacency.get("d") ?? []
    expect(dEdges.length).toBe(2)
    expect(dEdges.every(e => !e.negative)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// SCC Detection
// ---------------------------------------------------------------------------

describe("computeSCCs", () => {
  it("finds trivial SCCs (no cycles)", () => {
    // a -> b -> c (linear, no cycles)
    const rules: Rule[] = [
      rule(atom("b", [varTerm("X")]), [
        positiveAtom(atom("a", [varTerm("X")])),
      ]),
      rule(atom("c", [varTerm("X")]), [
        positiveAtom(atom("b", [varTerm("X")])),
      ]),
    ]

    const graph = buildDependencyGraph(rules)
    const sccs = computeSCCs(graph)

    // Each predicate should be in its own SCC
    expect(sccs.length).toBe(3)
    for (const scc of sccs) {
      expect(scc.length).toBe(1)
    }
  })

  it("finds a positive cycle", () => {
    // path(X,Y) :- edge(X,Y).
    // path(X,Z) :- edge(X,Y), path(Y,Z).
    // path depends on itself (positive cycle)
    const rules: Rule[] = [
      rule(atom("path", [varTerm("X"), varTerm("Y")]), [
        positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
      ]),
      rule(atom("path", [varTerm("X"), varTerm("Z")]), [
        positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        positiveAtom(atom("path", [varTerm("Y"), varTerm("Z")])),
      ]),
    ]

    const graph = buildDependencyGraph(rules)
    const sccs = computeSCCs(graph)

    // 'path' should form an SCC with itself (self-loop), 'edge' is separate
    const pathScc = sccs.find(scc => scc.includes("path"))
    expect(pathScc).toBeDefined()
    expect(pathScc?.includes("path")).toBe(true)
  })

  it("finds mutual recursion SCC", () => {
    // a(X) :- b(X).
    // b(X) :- a(X).
    const rules: Rule[] = [
      rule(atom("a", [varTerm("X")]), [
        positiveAtom(atom("b", [varTerm("X")])),
      ]),
      rule(atom("b", [varTerm("X")]), [
        positiveAtom(atom("a", [varTerm("X")])),
      ]),
    ]

    const graph = buildDependencyGraph(rules)
    const sccs = computeSCCs(graph)

    // a and b should be in the same SCC
    const abScc = sccs.find(scc => scc.includes("a"))
    expect(abScc).toBeDefined()
    expect(abScc?.includes("b")).toBe(true)
    expect(abScc?.length).toBe(2)
  })

  it("handles disconnected components", () => {
    // a(X) :- b(X).   (component 1)
    // c(X) :- d(X).   (component 2)
    const rules: Rule[] = [
      rule(atom("a", [varTerm("X")]), [
        positiveAtom(atom("b", [varTerm("X")])),
      ]),
      rule(atom("c", [varTerm("X")]), [
        positiveAtom(atom("d", [varTerm("X")])),
      ]),
    ]

    const graph = buildDependencyGraph(rules)
    const sccs = computeSCCs(graph)

    // 4 predicates, each in its own SCC
    expect(sccs.length).toBe(4)
    for (const scc of sccs) {
      expect(scc.length).toBe(1)
    }
  })
})

// ---------------------------------------------------------------------------
// Stratification
// ---------------------------------------------------------------------------

describe("stratify", () => {
  it("returns empty strata for empty rules", () => {
    const result = stratify([])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.length).toBe(0)
  })

  it("assigns single stratum for positive rules", () => {
    // path(X,Y) :- edge(X,Y).
    // path(X,Z) :- edge(X,Y), path(Y,Z).
    const rules: Rule[] = [
      rule(atom("path", [varTerm("X"), varTerm("Y")]), [
        positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
      ]),
      rule(atom("path", [varTerm("X"), varTerm("Z")]), [
        positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
        positiveAtom(atom("path", [varTerm("Y"), varTerm("Z")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // All rules should be in a single stratum (or at stratum 0)
    // since there is no negation
    const strata = result.value
    const ruleStrata = strata.filter(s => s.rules.length > 0)
    expect(ruleStrata.length).toBe(1)
    expect(ruleStrata[0]?.rules.length).toBe(2)
  })

  it("puts negated predicate in lower stratum", () => {
    // derived(X) :- base(X).
    // filtered(X) :- candidate(X), not derived(X).
    //
    // derived depends on base (stratum 0).
    // filtered depends negatively on derived → stratum(filtered) > stratum(derived).
    const rules: Rule[] = [
      rule(atom("derived", [varTerm("X")]), [
        positiveAtom(atom("base", [varTerm("X")])),
      ]),
      rule(atom("filtered", [varTerm("X")]), [
        positiveAtom(atom("candidate", [varTerm("X")])),
        negation(atom("derived", [varTerm("X")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value

    // Find which stratum each predicate is in
    const derivedStratum = strata.find(s => s.predicates.has("derived"))
    const filteredStratum = strata.find(s => s.predicates.has("filtered"))

    expect(derivedStratum).toBeDefined()
    expect(filteredStratum).toBeDefined()
    expect(filteredStratum?.index).toBeGreaterThan(derivedStratum?.index)
  })

  it("handles three-level stratification", () => {
    // level0(X) :- base(X).
    // level1(X) :- source(X), not level0(X).
    // level2(X) :- input(X), not level1(X).
    const rules: Rule[] = [
      rule(atom("level0", [varTerm("X")]), [
        positiveAtom(atom("base", [varTerm("X")])),
      ]),
      rule(atom("level1", [varTerm("X")]), [
        positiveAtom(atom("source", [varTerm("X")])),
        negation(atom("level0", [varTerm("X")])),
      ]),
      rule(atom("level2", [varTerm("X")]), [
        positiveAtom(atom("input", [varTerm("X")])),
        negation(atom("level1", [varTerm("X")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value
    const s0 = strata.find(s => s.predicates.has("level0"))
    const s1 = strata.find(s => s.predicates.has("level1"))
    const s2 = strata.find(s => s.predicates.has("level2"))

    expect(s0).toBeDefined()
    expect(s1).toBeDefined()
    expect(s2).toBeDefined()
    expect(s1?.index).toBeGreaterThan(s0?.index)
    expect(s2?.index).toBeGreaterThan(s1?.index)
  })

  it("puts aggregation source in lower stratum", () => {
    const _aggClause: AggregationClause = {
      fn: "max",
      groupBy: ["Slot"],
      over: "Lamport",
      result: "MaxL",
      source: atom("active_value", [varTerm("Slot"), varTerm("Lamport")]),
    }

    // derived(X, Y) :- source(X, Y).
    // max_l(Slot, MaxL) :- <agg over derived>
    //
    // Actually, the agg references active_value directly, which is a base fact.
    // But let's test with a derived predicate as source.
    const derivedAggClause: AggregationClause = {
      fn: "max",
      groupBy: ["Slot"],
      over: "Val",
      result: "MaxVal",
      source: atom("derived", [varTerm("Slot"), varTerm("Val")]),
    }

    const rules: Rule[] = [
      rule(atom("derived", [varTerm("X"), varTerm("Y")]), [
        positiveAtom(atom("source", [varTerm("X"), varTerm("Y")])),
      ]),
      rule(atom("max_derived", [varTerm("Slot"), varTerm("MaxVal")]), [
        aggregation(derivedAggClause),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value
    const derivedStratum = strata.find(s => s.predicates.has("derived"))
    const maxStratum = strata.find(s => s.predicates.has("max_derived"))

    expect(derivedStratum).toBeDefined()
    expect(maxStratum).toBeDefined()
    expect(maxStratum?.index).toBeGreaterThan(derivedStratum?.index)
  })

  it("strata are in evaluation order (lower index first)", () => {
    const rules: Rule[] = [
      rule(atom("a", [varTerm("X")]), [
        positiveAtom(atom("base", [varTerm("X")])),
      ]),
      rule(atom("b", [varTerm("X")]), [
        positiveAtom(atom("src", [varTerm("X")])),
        negation(atom("a", [varTerm("X")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value
    for (let i = 1; i < strata.length; i++) {
      expect(strata[i]?.index).toBeGreaterThanOrEqual(strata[i - 1]?.index)
    }
  })

  it("groups positively-dependent predicates in the same stratum", () => {
    // a(X) :- b(X).
    // b(X) :- a(X).  (mutual positive recursion)
    // c(X) :- a(X), not d(X).
    // d is a base fact.
    const rules: Rule[] = [
      rule(atom("a", [varTerm("X")]), [
        positiveAtom(atom("b", [varTerm("X")])),
      ]),
      rule(atom("b", [varTerm("X")]), [
        positiveAtom(atom("a", [varTerm("X")])),
      ]),
      rule(atom("c", [varTerm("X")]), [
        positiveAtom(atom("a", [varTerm("X")])),
        negation(atom("d", [varTerm("X")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value
    const aStratum = strata.find(s => s.predicates.has("a"))
    const bStratum = strata.find(s => s.predicates.has("b"))

    expect(aStratum).toBeDefined()
    expect(bStratum).toBeDefined()
    // a and b are in the same SCC, so same stratum
    expect(aStratum?.index).toBe(bStratum?.index)
  })

  it("rules are assigned to the correct stratum", () => {
    // r1: a(X) :- base(X).           -> stratum of 'a'
    // r2: b(X) :- src(X), not a(X).  -> stratum of 'b'
    const r1: Rule = rule(atom("a", [varTerm("X")]), [
      positiveAtom(atom("base", [varTerm("X")])),
    ])
    const r2: Rule = rule(atom("b", [varTerm("X")]), [
      positiveAtom(atom("src", [varTerm("X")])),
      negation(atom("a", [varTerm("X")])),
    ])

    const result = stratify([r1, r2])
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value
    const aStratum = strata.find(s => s.predicates.has("a"))
    const bStratum = strata.find(s => s.predicates.has("b"))

    expect(aStratum?.rules).toContain(r1)
    expect(bStratum?.rules).toContain(r2)
    expect(aStratum?.rules).not.toContain(r2)
    expect(bStratum?.rules).not.toContain(r1)
  })
})

// ---------------------------------------------------------------------------
// Cyclic Negation Detection
// ---------------------------------------------------------------------------

describe("cyclic negation detection", () => {
  it("rejects direct cyclic negation (a depends negatively on itself)", () => {
    // a(X) :- b(X), not a(X).
    const rules: Rule[] = [
      rule(atom("a", [varTerm("X")]), [
        positiveAtom(atom("b", [varTerm("X")])),
        negation(atom("a", [varTerm("X")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error.kind).toBe("cyclicNegation")
    expect(result.error.cycle).toContain("a")
  })

  it("rejects mutual cyclic negation", () => {
    // a(X) :- b(X), not c(X).
    // c(X) :- d(X), not a(X).
    const rules: Rule[] = [
      rule(atom("a", [varTerm("X")]), [
        positiveAtom(atom("b", [varTerm("X")])),
        negation(atom("c", [varTerm("X")])),
      ]),
      rule(atom("c", [varTerm("X")]), [
        positiveAtom(atom("d", [varTerm("X")])),
        negation(atom("a", [varTerm("X")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error.kind).toBe("cyclicNegation")
    expect(result.error.cycle.length).toBeGreaterThanOrEqual(2)
  })

  it("rejects cyclic negation through positive intermediate", () => {
    // a(X) :- not b(X), src(X).
    // b(X) :- c(X).
    // c(X) :- a(X).
    //
    // a -> (neg) b -> (pos) c -> (pos) a
    // a, b, c are NOT all in the same SCC because the a->b edge is negative.
    // Actually, let's think about this:
    //   a depends negatively on b.
    //   b depends positively on c.
    //   c depends positively on a.
    // So c -> a -> b (neg) -> c. This IS a cycle with a negative edge.
    // The SCC containing {a, b, c} has a negative edge from a to b.
    //
    // Wait: for Tarjan's SCC, edges are: a->b(neg), a->src(pos), b->c(pos), c->a(pos).
    // There IS a cycle a->b->c->a, and it contains a negative edge.
    const rules: Rule[] = [
      rule(atom("a", [varTerm("X")]), [
        negation(atom("b", [varTerm("X")])),
        positiveAtom(atom("src", [varTerm("X")])),
      ]),
      rule(atom("b", [varTerm("X")]), [
        positiveAtom(atom("c", [varTerm("X")])),
      ]),
      rule(atom("c", [varTerm("X")]), [
        positiveAtom(atom("a", [varTerm("X")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error.kind).toBe("cyclicNegation")
  })

  it("accepts negation on base facts (no cycle)", () => {
    // result(X) :- candidate(X), not excluded(X).
    // excluded is only a base fact — no rule defines it.
    const rules: Rule[] = [
      rule(atom("result", [varTerm("X")]), [
        positiveAtom(atom("candidate", [varTerm("X")])),
        negation(atom("excluded", [varTerm("X")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(true)
  })

  it("accepts negation on a predicate from a lower stratum", () => {
    // low(X) :- base(X).
    // high(X) :- src(X), not low(X).
    // No cycle: low is fully computed before high.
    const rules: Rule[] = [
      rule(atom("low", [varTerm("X")]), [
        positiveAtom(atom("base", [varTerm("X")])),
      ]),
      rule(atom("high", [varTerm("X")]), [
        positiveAtom(atom("src", [varTerm("X")])),
        negation(atom("low", [varTerm("X")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(true)
  })

  it("accepts positive self-recursion", () => {
    // reachable(X) :- start(X).
    // reachable(Y) :- reachable(X), edge(X, Y).
    const rules: Rule[] = [
      rule(atom("reachable", [varTerm("X")]), [
        positiveAtom(atom("start", [varTerm("X")])),
      ]),
      rule(atom("reachable", [varTerm("Y")]), [
        positiveAtom(atom("reachable", [varTerm("X")])),
        positiveAtom(atom("edge", [varTerm("X"), varTerm("Y")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(true)
  })

  it("accepts positive mutual recursion", () => {
    // even(X) :- zero(X).
    // even(X) :- odd(Y), succ(Y, X).
    // odd(X) :- even(Y), succ(Y, X).
    const rules: Rule[] = [
      rule(atom("even", [varTerm("X")]), [
        positiveAtom(atom("zero", [varTerm("X")])),
      ]),
      rule(atom("even", [varTerm("X")]), [
        positiveAtom(atom("odd", [varTerm("Y")])),
        positiveAtom(atom("succ", [varTerm("Y"), varTerm("X")])),
      ]),
      rule(atom("odd", [varTerm("X")]), [
        positiveAtom(atom("even", [varTerm("Y")])),
        positiveAtom(atom("succ", [varTerm("Y"), varTerm("X")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(true)
  })

  it("error includes cycle members", () => {
    // p(X) :- not q(X), r(X).
    // q(X) :- not p(X), s(X).
    const rules: Rule[] = [
      rule(atom("p", [varTerm("X")]), [
        negation(atom("q", [varTerm("X")])),
        positiveAtom(atom("r", [varTerm("X")])),
      ]),
      rule(atom("q", [varTerm("X")]), [
        negation(atom("p", [varTerm("X")])),
        positiveAtom(atom("s", [varTerm("X")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(false)
    if (result.ok) return

    expect(result.error.kind).toBe("cyclicNegation")
    // The cycle should mention both p and q
    expect(result.error.cycle).toContain("p")
    expect(result.error.cycle).toContain("q")
  })
})

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

describe("bodyPredicates", () => {
  it("extracts predicates from positive atoms", () => {
    const body = [
      positiveAtom(atom("a", [varTerm("X")])),
      positiveAtom(atom("b", [varTerm("Y")])),
    ]

    const preds = bodyPredicates(body)
    expect(preds.has("a")).toBe(true)
    expect(preds.has("b")).toBe(true)
    expect(preds.size).toBe(2)
  })

  it("extracts predicates from negated atoms", () => {
    const body = [
      positiveAtom(atom("a", [varTerm("X")])),
      negation(atom("b", [varTerm("X")])),
    ]

    const preds = bodyPredicates(body)
    expect(preds.has("a")).toBe(true)
    expect(preds.has("b")).toBe(true)
  })

  it("extracts predicates from aggregation sources", () => {
    const aggClause: AggregationClause = {
      fn: "sum",
      groupBy: ["G"],
      over: "V",
      result: "R",
      source: atom("data", [varTerm("G"), varTerm("V")]),
    }

    const body = [aggregation(aggClause)]
    const preds = bodyPredicates(body)
    expect(preds.has("data")).toBe(true)
  })

  it("handles empty body", () => {
    const preds = bodyPredicates([])
    expect(preds.size).toBe(0)
  })
})

describe("headPredicates", () => {
  it("extracts head predicates from rules", () => {
    const rules: Rule[] = [
      rule(atom("a", [varTerm("X")]), [
        positiveAtom(atom("b", [varTerm("X")])),
      ]),
      rule(atom("c", [varTerm("X")]), [
        positiveAtom(atom("d", [varTerm("X")])),
      ]),
      rule(atom("a", [varTerm("X")]), [
        positiveAtom(atom("e", [varTerm("X")])),
      ]),
    ]

    const preds = headPredicates(rules)
    expect(preds.has("a")).toBe(true)
    expect(preds.has("c")).toBe(true)
    expect(preds.size).toBe(2) // 'a' appears twice but is deduped
  })

  it("handles empty rules", () => {
    const preds = headPredicates([])
    expect(preds.size).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Complex stratification scenarios
// ---------------------------------------------------------------------------

describe("complex stratification", () => {
  it("handles the LWW pattern from §B.4 (using guards)", () => {
    // superseded(CnId, Slot) :-
    //   active_value(CnId, Slot, _, L1, _),
    //   active_value(CnId2, Slot, _, L2, _),
    //   neq(CnId, CnId2),
    //   gt(L2, L1).
    //
    // superseded(CnId, Slot) :-
    //   active_value(CnId, Slot, _, L1, P1),
    //   active_value(CnId2, Slot, _, L2, P2),
    //   neq(CnId, CnId2),
    //   eq(L2, L1),
    //   gt(P2, P1).
    //
    // winner(Slot, CnId, Value) :-
    //   active_value(CnId, Slot, Value, _, _),
    //   not superseded(CnId, Slot).
    //
    // Guards introduce NO dependency edges, so:
    //   superseded depends only on active_value (positive)
    //   winner negates superseded → must be in a higher stratum
    // This is simpler than the old __neq-as-atom encoding, which
    // would have added spurious edges to nonexistent predicates.

    const supersededByLamport: Rule = rule(
      atom("superseded", [varTerm("CnId"), varTerm("Slot")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            _,
            varTerm("L1"),
            _,
          ]),
        ),
        positiveAtom(
          atom("active_value", [
            varTerm("CnId2"),
            varTerm("Slot"),
            _,
            varTerm("L2"),
            _,
          ]),
        ),
        neq(varTerm("CnId"), varTerm("CnId2")),
        gt(varTerm("L2"), varTerm("L1")),
      ],
    )

    const supersededByPeer: Rule = rule(
      atom("superseded", [varTerm("CnId"), varTerm("Slot")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            _,
            varTerm("L1"),
            varTerm("P1"),
          ]),
        ),
        positiveAtom(
          atom("active_value", [
            varTerm("CnId2"),
            varTerm("Slot"),
            _,
            varTerm("L2"),
            varTerm("P2"),
          ]),
        ),
        neq(varTerm("CnId"), varTerm("CnId2")),
        eq(varTerm("L2"), varTerm("L1")),
        gt(varTerm("P2"), varTerm("P1")),
      ],
    )

    const winnerRule: Rule = rule(
      atom("winner", [varTerm("Slot"), varTerm("CnId"), varTerm("Value")]),
      [
        positiveAtom(
          atom("active_value", [
            varTerm("CnId"),
            varTerm("Slot"),
            varTerm("Value"),
            _,
            _,
          ]),
        ),
        negation(atom("superseded", [varTerm("CnId"), varTerm("Slot")])),
      ],
    )

    const rules = [supersededByLamport, supersededByPeer, winnerRule]
    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value
    const supersededStratum = strata.find(s => s.predicates.has("superseded"))
    const winnerStratum = strata.find(s => s.predicates.has("winner"))

    expect(supersededStratum).toBeDefined()
    expect(winnerStratum).toBeDefined()
    expect(winnerStratum?.index).toBeGreaterThan(supersededStratum?.index)

    // Guards produce no dependency graph edges — verify the graph
    // only has edges for the relational atoms (active_value, superseded)
    const graph = buildDependencyGraph(rules)
    const guardPredicates = ["__neq", "__gt", "__eq"]
    for (const edge of graph.edges) {
      expect(guardPredicates).not.toContain(edge.to)
      expect(guardPredicates).not.toContain(edge.from)
    }

    // superseded rules should be in the superseded stratum
    expect(supersededStratum?.rules).toContain(supersededByLamport)
    expect(supersededStratum?.rules).toContain(supersededByPeer)

    // winner rule should be in the winner stratum
    expect(winnerStratum?.rules).toContain(winnerRule)
  })

  it("handles diamond dependency without negation", () => {
    //       a
    //      / \
    //     b   c
    //      \ /
    //       d (base)
    //
    // b(X) :- d(X).
    // c(X) :- d(X).
    // a(X) :- b(X), c(X).
    const rules: Rule[] = [
      rule(atom("b", [varTerm("X")]), [
        positiveAtom(atom("d", [varTerm("X")])),
      ]),
      rule(atom("c", [varTerm("X")]), [
        positiveAtom(atom("d", [varTerm("X")])),
      ]),
      rule(atom("a", [varTerm("X")]), [
        positiveAtom(atom("b", [varTerm("X")])),
        positiveAtom(atom("c", [varTerm("X")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    // All should be stratifiable. a depends on b and c, which depend on d.
    // All positive, so they can be in the same stratum.
    const strata = result.value
    expect(strata.length).toBeGreaterThan(0)
  })

  it("handles diamond dependency with negation on one branch", () => {
    // b(X) :- d(X).
    // c(X) :- d(X).
    // a(X) :- b(X), not c(X).
    //
    // a negates c → a must be in a higher stratum than c.
    const rules: Rule[] = [
      rule(atom("b", [varTerm("X")]), [
        positiveAtom(atom("d", [varTerm("X")])),
      ]),
      rule(atom("c", [varTerm("X")]), [
        positiveAtom(atom("d", [varTerm("X")])),
      ]),
      rule(atom("a", [varTerm("X")]), [
        positiveAtom(atom("b", [varTerm("X")])),
        negation(atom("c", [varTerm("X")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value
    const cStratum = strata.find(s => s.predicates.has("c"))
    const aStratum = strata.find(s => s.predicates.has("a"))

    expect(cStratum).toBeDefined()
    expect(aStratum).toBeDefined()
    expect(aStratum?.index).toBeGreaterThan(cStratum?.index)
  })
})

// ---------------------------------------------------------------------------
// Finer-Grained Stratification (Plan 007, Phase 1, Task 1.3)
// ---------------------------------------------------------------------------

describe("finer-grained stratification", () => {
  it("default LWW + Fugue rules produce 4 strata instead of 2", () => {
    const rules = buildDefaultRules()
    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value

    // Should produce 4 strata: 2 families × 2 dependency levels.
    const strataWithRules = strata.filter(s => s.rules.length > 0)
    expect(strataWithRules.length).toBe(4)

    // Stratum for superseded: 2 rules (supersededByLamport, supersededByPeer)
    const supersededStratum = strata.find(s => s.predicates.has("superseded"))
    expect(supersededStratum).toBeDefined()
    expect(supersededStratum?.rules.length).toBe(2)

    // Stratum for fugue_child + fugue_descendant: 3 rules
    const fugueChildStratum = strata.find(s => s.predicates.has("fugue_child"))
    expect(fugueChildStratum).toBeDefined()
    expect(fugueChildStratum?.predicates.has("fugue_descendant")).toBe(true)
    expect(fugueChildStratum?.rules.length).toBe(3)

    // Stratum for winner: 1 rule
    const winnerStratum = strata.find(s => s.predicates.has("winner"))
    expect(winnerStratum).toBeDefined()
    expect(winnerStratum?.rules.length).toBe(1)

    // Stratum for fugue_before: 5 rules
    const fugueBeforeStratum = strata.find(s =>
      s.predicates.has("fugue_before"),
    )
    expect(fugueBeforeStratum).toBeDefined()
    expect(fugueBeforeStratum?.rules.length).toBe(5)

    // Ordering: level 0 strata before level 1 strata.
    expect(supersededStratum?.index).toBeLessThan(winnerStratum?.index)
    expect(fugueChildStratum?.index).toBeLessThan(fugueBeforeStratum?.index)

    // LWW and Fugue strata are separate at each level.
    expect(supersededStratum?.index).not.toBe(fugueChildStratum?.index)
    expect(winnerStratum?.index).not.toBe(fugueBeforeStratum?.index)
  })

  it("strata at the same dependency level are independent (no cross-references)", () => {
    const rules = buildDefaultRules()
    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value
    const supersededStratum = strata.find(s => s.predicates.has("superseded"))!
    const fugueChildStratum = strata.find(s => s.predicates.has("fugue_child"))!

    // Verify they are at the same dependency level (both at level 0).
    // They should have separate indices but both come before the level-1 strata.
    const winnerStratum = strata.find(s => s.predicates.has("winner"))!
    const fugueBeforeStratum = strata.find(s =>
      s.predicates.has("fugue_before"),
    )!

    expect(supersededStratum.index).toBeLessThan(winnerStratum.index)
    expect(supersededStratum.index).toBeLessThan(fugueBeforeStratum.index)
    expect(fugueChildStratum.index).toBeLessThan(winnerStratum.index)
    expect(fugueChildStratum.index).toBeLessThan(fugueBeforeStratum.index)

    // No derived predicate from superseded stratum appears in fugue stratum bodies.
    const supersededPreds = supersededStratum.predicates
    for (const r of fugueChildStratum.rules) {
      const bodyPreds = bodyPredicates(r.body)
      for (const bp of bodyPreds) {
        expect(supersededPreds.has(bp)).toBe(false)
      }
    }
  })

  it("adding a cross-family rule merges components into one stratum", () => {
    // Start with LWW + Fugue rules, then add a rule that bridges them.
    const defaultRules = buildDefaultRules()

    // Cross-family rule: references both active_value (LWW input)
    // and fugue_child (Fugue derived) — this creates a derived-predicate
    // link between LWW and Fugue strata at level 0.
    const crossRule: Rule = rule(atom("mixed", [varTerm("S"), varTerm("P")]), [
      positiveAtom(atom("superseded", [varTerm("CnId"), varTerm("S")])),
      positiveAtom(
        atom("fugue_child", [varTerm("P"), varTerm("CnId2"), _, _, _]),
      ),
    ])

    const result = stratify([...defaultRules, crossRule])
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value

    // The cross rule should merge superseded and fugue_child into one
    // component at level 0 (since mixed depends on both derived preds
    // at level 0).
    const supersededStratum = strata.find(s => s.predicates.has("superseded"))!
    const fugueChildStratum = strata.find(s => s.predicates.has("fugue_child"))!
    const mixedStratum = strata.find(s => s.predicates.has("mixed"))!

    // mixed, superseded, and fugue_child should all be in the same stratum
    // because mixed references derived predicates from both families at level 0.
    expect(supersededStratum.index).toBe(fugueChildStratum.index)
    expect(mixedStratum.index).toBe(supersededStratum.index)
  })

  it("single-family rule sets produce same strata as before", () => {
    // LWW rules only — should produce 2 strata (superseded, winner).
    const lwwRules = buildDefaultLWWRules()
    const result = stratify(lwwRules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value
    const strataWithRules = strata.filter(s => s.rules.length > 0)
    expect(strataWithRules.length).toBe(2)

    const supersededStratum = strata.find(s => s.predicates.has("superseded"))
    const winnerStratum = strata.find(s => s.predicates.has("winner"))
    expect(supersededStratum).toBeDefined()
    expect(winnerStratum).toBeDefined()
    expect(winnerStratum?.index).toBeGreaterThan(supersededStratum?.index)
  })

  it("ground predicates do not bridge independent families", () => {
    // Two independent rule families that share a ground predicate.
    // family_a derives from ground_input, family_b derives from ground_input.
    // They should NOT be merged into one stratum.
    const rules: Rule[] = [
      rule(atom("derived_a", [varTerm("X")]), [
        positiveAtom(atom("ground_input", [varTerm("X"), varTerm("Y")])),
      ]),
      rule(atom("derived_b", [varTerm("Y")]), [
        positiveAtom(atom("ground_input", [varTerm("X"), varTerm("Y")])),
      ]),
    ]

    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value
    const aStratum = strata.find(s => s.predicates.has("derived_a"))!
    const bStratum = strata.find(s => s.predicates.has("derived_b"))!

    // They should be in separate strata — ground_input doesn't bridge them.
    expect(aStratum.index).not.toBe(bStratum.index)
  })
})

// ---------------------------------------------------------------------------
// Partition Key Extraction (Plan 007, Phase 1, Tasks 1.5 + 1.6)
// ---------------------------------------------------------------------------

describe("extractPartitionKey", () => {
  it("superseded stratum → PK = {Slot} at correct positions", () => {
    // superseded(CnId, Slot) :- active_value(CnId, Slot, _, L1, _),
    //   active_value(CnId2, Slot, _, L2, _), L2 > L1.
    // superseded(CnId, Slot) :- active_value(CnId, Slot, _, L1, P1),
    //   active_value(CnId2, Slot, _, L2, P2), L2 == L1, P2 > P1.
    const rules = buildDefaultLWWRules().filter(
      r => r.head.predicate === "superseded",
    )
    expect(rules.length).toBe(2)

    const pk = extractPartitionKey(rules)
    expect(pk.variables.length).toBeGreaterThan(0)
    expect(pk.variables).toContain("Slot")

    // Slot is at position 1 in the superseded head: superseded(CnId, Slot)
    const headPos = pk.headPositions.get("superseded")
    expect(headPos).toBeDefined()
    expect(headPos).toContain(1)

    // Slot is at position 1 in active_value: active_value(CnId, Slot, _, L, _)
    const bodyPos = pk.bodyPositions.get("active_value")
    expect(bodyPos).toBeDefined()
    expect(bodyPos).toContain(1)
  })

  it("fugue_before stratum → PK = {Parent}", () => {
    const rules = buildDefaultFugueRules().filter(
      r => r.head.predicate === "fugue_before",
    )
    expect(rules.length).toBe(5)

    const pk = extractPartitionKey(rules)
    expect(pk.variables.length).toBeGreaterThan(0)
    expect(pk.variables).toContain("Parent")

    // Parent is at position 0 in fugue_before head: fugue_before(Parent, A, B)
    const headPos = pk.headPositions.get("fugue_before")
    expect(headPos).toBeDefined()
    expect(headPos).toContain(0)
  })

  it("winner stratum → PK = {Slot}", () => {
    // winner(Slot, CnId, Value) :- active_value(CnId, Slot, Value, _, _),
    //   not superseded(CnId, Slot).
    const rules = buildDefaultLWWRules().filter(
      r => r.head.predicate === "winner",
    )
    expect(rules.length).toBe(1)

    const pk = extractPartitionKey(rules)
    expect(pk.variables).toContain("Slot")

    // Slot is at position 0 in winner head: winner(Slot, CnId, Value)
    const headPos = pk.headPositions.get("winner")
    expect(headPos).toBeDefined()
    expect(headPos).toContain(0)
  })

  it("fugue_child + fugue_descendant stratum → PK = {Parent} (functional-lookup relaxation)", () => {
    // fugue_child's strict per-rule PK would be {CnId} (CnId appears in
    // head and every body atom including constraint_peer). But the cross-
    // rule head intersection is {Parent} — and with functional-lookup
    // relaxation, constraint_peer(CnId, Peer) is PK-covered because CnId
    // is reachable from Parent through active_structure_seq. So the
    // relaxed PK = {Parent} for the combined stratum.
    const rules = buildDefaultFugueRules().filter(
      r =>
        r.head.predicate === "fugue_child" ||
        r.head.predicate === "fugue_descendant",
    )
    expect(rules.length).toBe(3)

    const pk = extractPartitionKey(rules)
    expect(pk.variables).toContain("Parent")

    // Parent is at position 0 in fugue_child head: fugue_child(Parent, CnId, ...)
    const headPos = pk.headPositions.get("fugue_child")
    expect(headPos).toBeDefined()
    expect(headPos).toContain(0)
  })

  it("fugue_descendant rules alone → PK = {Parent}", () => {
    // When fugue_descendant is analyzed independently, Parent appears
    // in the head and every body atom of both rules — no relaxation needed.
    const rules = buildDefaultFugueRules().filter(
      r => r.head.predicate === "fugue_descendant",
    )
    expect(rules.length).toBe(2)

    const pk = extractPartitionKey(rules)
    expect(pk.variables).toContain("Parent")
  })

  it("rule with no shared variable → PK = ∅", () => {
    // result(X) :- source(Y). — X is in head but not in body, Y in body but not head.
    const rules: Rule[] = [
      rule(atom("result", [varTerm("X")]), [
        positiveAtom(atom("source", [varTerm("Y")])),
      ]),
    ]

    const pk = extractPartitionKey(rules)
    expect(pk.variables.length).toBe(0)
    expect(pk.headPositions.size).toBe(0)
    expect(pk.bodyPositions.size).toBe(0)
  })

  it("multi-rule stratum where one rule lacks the shared variable → PK = ∅", () => {
    // r1: out(X) :- in(X, Y).     — X is shared
    // r2: out(Z) :- other(W).     — Z is in head only, W in body only
    // Cross-rule intersection: {X} ∩ ∅ = ∅
    const rules: Rule[] = [
      rule(atom("out", [varTerm("X")]), [
        positiveAtom(atom("in", [varTerm("X"), varTerm("Y")])),
      ]),
      rule(atom("out", [varTerm("Z")]), [
        positiveAtom(atom("other", [varTerm("W")])),
      ]),
    ]

    const pk = extractPartitionKey(rules)
    expect(pk.variables.length).toBe(0)
  })

  it("empty rules → PK = ∅", () => {
    const pk = extractPartitionKey([])
    expect(pk.variables.length).toBe(0)
  })

  it("rule with only guards (no atoms) → PK = ∅", () => {
    // out(X) :- X > 0.  — guard only, no positive/negation body atoms
    const rules: Rule[] = [
      rule(atom("out", [varTerm("X")]), [gt(varTerm("X"), constTerm(0))]),
    ]

    const pk = extractPartitionKey(rules)
    expect(pk.variables.length).toBe(0)
  })

  it("default rules: each stratum has correct partitionKey populated", () => {
    const rules = buildDefaultRules()
    const result = stratify(rules)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const strata = result.value

    // superseded stratum — PK contains Slot
    const supersededStratum = strata.find(s => s.predicates.has("superseded"))!
    expect(supersededStratum.partitionKey.variables).toContain("Slot")

    // fugue_child + fugue_descendant stratum — PK = {Parent} (functional-lookup
    // relaxation: constraint_peer is PK-covered via CnId from active_structure_seq)
    const fugueChildStratum = strata.find(s => s.predicates.has("fugue_child"))!
    expect(fugueChildStratum.partitionKey.variables).toContain("Parent")

    // winner stratum — PK contains Slot
    const winnerStratum = strata.find(s => s.predicates.has("winner"))!
    expect(winnerStratum.partitionKey.variables).toContain("Slot")

    // fugue_before stratum — PK contains Parent
    const fugueBeforeStratum = strata.find(s =>
      s.predicates.has("fugue_before"),
    )!
    expect(fugueBeforeStratum.partitionKey.variables).toContain("Parent")
  })

  it("PK variables are sorted deterministically", () => {
    // Rule with multiple shared variables: result(A, B) :- src(A, B).
    const rules: Rule[] = [
      rule(atom("result", [varTerm("B"), varTerm("A")]), [
        positiveAtom(atom("src", [varTerm("B"), varTerm("A")])),
      ]),
    ]

    const pk = extractPartitionKey(rules)
    // Both A and B are shared — they should be sorted alphabetically.
    expect(pk.variables).toEqual(["A", "B"])
  })

  // -------------------------------------------------------------------------
  // Functional-lookup relaxation edge cases
  //
  // The relaxation classifies body atoms as "PK-covered" (satellite joins)
  // vs "PK-required" (must contain PK vars). These tests exercise the
  // reachability analysis in isolation with synthetic rules.
  // -------------------------------------------------------------------------

  it("disconnected atom is NOT PK-covered → PK narrows away", () => {
    // r1: out(K, V) :- a(K, V, Y), b(W).
    //
    // PK candidate from head: {K, V}.
    // Reachable from {K, V}: start {K, V} → a(K, V, Y) overlaps → add Y → {K, V, Y}.
    // b(W) has zero overlap with {K, V, Y} → PK-required.
    // Intersect {K, V} with {W} → ∅.
    //
    // This is a Cartesian-product join. The atom b(W) genuinely
    // introduces a cross-partition dependency: every partition
    // reads all b facts. The relaxation must NOT cover it.
    const rules: Rule[] = [
      rule(atom("out", [varTerm("K"), varTerm("V")]), [
        positiveAtom(atom("a", [varTerm("K"), varTerm("V"), varTerm("Y")])),
        positiveAtom(atom("b", [varTerm("W")])),
      ]),
    ]

    const pk = extractPartitionKey(rules)
    expect(pk.variables.length).toBe(0)
  })

  it("chained lookup (two hops) is PK-covered → PK = {K}", () => {
    // out(K, V) :- a(K, X), b(X, Y), c(Y, V).
    //
    // Reachable from {K}: K → a → X → b → Y → c → V.
    // All three atoms are PK-covered. No PK-required atoms.
    // PK = {K}.
    //
    // Tests that reachability is transitive (multi-hop), not just
    // one-hop from the PK atom.
    const rules: Rule[] = [
      rule(atom("out", [varTerm("K"), varTerm("V")]), [
        positiveAtom(atom("a", [varTerm("K"), varTerm("X")])),
        positiveAtom(atom("b", [varTerm("X"), varTerm("Y")])),
        positiveAtom(atom("c", [varTerm("Y"), varTerm("V")])),
      ]),
    ]

    const pk = extractPartitionKey(rules)
    expect(pk.variables).toContain("K")
  })

  it("cross-rule narrowing: one rule supports PK, other does not → PK = ∅", () => {
    // r1: out(K, V) :- a(K, X), b(X, V).  — PK = {K} (b is PK-covered via X)
    // r2: out(K, W) :- c(W).               — K is in head but not in body at all
    //
    // r1 validates PK = {K}. r2 has c(W) which is PK-required (W is not
    // reachable from {K} — c has no overlap with any PK-containing atom).
    // K ∉ c → PK narrows to ∅.
    //
    // Tests that cross-rule validation correctly rejects a PK that
    // one rule supports but another doesn't.
    const rules: Rule[] = [
      rule(atom("out", [varTerm("K"), varTerm("V")]), [
        positiveAtom(atom("a", [varTerm("K"), varTerm("X")])),
        positiveAtom(atom("b", [varTerm("X"), varTerm("V")])),
      ]),
      rule(atom("out", [varTerm("K"), varTerm("W")]), [
        positiveAtom(atom("c", [varTerm("W")])),
      ]),
    ]

    const pk = extractPartitionKey(rules)
    expect(pk.variables.length).toBe(0)
  })
})
