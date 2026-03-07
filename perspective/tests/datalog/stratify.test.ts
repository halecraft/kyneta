// === Stratification Tests ===
// Tests for dependency graph construction, SCC detection, stratification
// validation, and cyclic negation rejection.

import { describe, it, expect } from 'vitest';
import {
  atom,
  constTerm,
  varTerm,
  rule,
  positiveAtom,
  negation,
  aggregation,
} from '../../src/datalog/types.js';
import type { Rule, AggregationClause } from '../../src/datalog/types.js';
import {
  buildDependencyGraph,
  computeSCCs,
  stratify,
  bodyPredicates,
  headPredicates,
} from '../../src/datalog/stratify.js';
import type { DependencyGraph, Stratum } from '../../src/datalog/stratify.js';

// ---------------------------------------------------------------------------
// Dependency Graph Construction
// ---------------------------------------------------------------------------

describe('buildDependencyGraph', () => {
  it('builds graph from positive rules', () => {
    // path(X,Y) :- edge(X,Y).
    // path(X,Z) :- edge(X,Y), path(Y,Z).
    const rules: Rule[] = [
      rule(
        atom('path', [varTerm('X'), varTerm('Y')]),
        [positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')]))],
      ),
      rule(
        atom('path', [varTerm('X'), varTerm('Z')]),
        [
          positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')])),
          positiveAtom(atom('path', [varTerm('Y'), varTerm('Z')])),
        ],
      ),
    ];

    const graph = buildDependencyGraph(rules);

    expect(graph.predicates.has('path')).toBe(true);
    expect(graph.predicates.has('edge')).toBe(true);
    expect(graph.predicates.size).toBe(2);

    // path -> edge (positive), path -> path (positive, recursive)
    const pathEdges = graph.adjacency.get('path') ?? [];
    expect(pathEdges.length).toBe(3); // edge from rule1, edge+path from rule2
    expect(pathEdges.every((e) => !e.negative)).toBe(true);
  });

  it('marks negative edges for negation', () => {
    // filtered(X) :- candidate(X), not rejected(X).
    const rules: Rule[] = [
      rule(
        atom('filtered', [varTerm('X')]),
        [
          positiveAtom(atom('candidate', [varTerm('X')])),
          negation(atom('rejected', [varTerm('X')])),
        ],
      ),
    ];

    const graph = buildDependencyGraph(rules);

    expect(graph.predicates.has('filtered')).toBe(true);
    expect(graph.predicates.has('candidate')).toBe(true);
    expect(graph.predicates.has('rejected')).toBe(true);

    const filteredEdges = graph.adjacency.get('filtered') ?? [];
    const positiveEdges = filteredEdges.filter((e) => !e.negative);
    const negativeEdges = filteredEdges.filter((e) => e.negative);

    expect(positiveEdges.length).toBe(1);
    expect(positiveEdges[0]!.to).toBe('candidate');
    expect(negativeEdges.length).toBe(1);
    expect(negativeEdges[0]!.to).toBe('rejected');
  });

  it('marks aggregation source as negative edge (stratified like negation)', () => {
    const aggClause: AggregationClause = {
      fn: 'max',
      groupBy: ['Slot'],
      over: 'Lamport',
      result: 'MaxL',
      source: atom('active_value', [varTerm('Slot'), varTerm('Lamport')]),
    };

    const rules: Rule[] = [
      rule(
        atom('max_lamport', [varTerm('Slot'), varTerm('MaxL')]),
        [aggregation(aggClause)],
      ),
    ];

    const graph = buildDependencyGraph(rules);

    const edges = graph.adjacency.get('max_lamport') ?? [];
    expect(edges.length).toBe(1);
    expect(edges[0]!.to).toBe('active_value');
    expect(edges[0]!.negative).toBe(true); // aggregation treated as negative
  });

  it('handles empty rule set', () => {
    const graph = buildDependencyGraph([]);
    expect(graph.predicates.size).toBe(0);
    expect(graph.edges.length).toBe(0);
  });

  it('handles rules with no body elements', () => {
    // axiom(42).
    const rules: Rule[] = [
      rule(atom('axiom', [constTerm(42)]), []),
    ];

    const graph = buildDependencyGraph(rules);
    expect(graph.predicates.has('axiom')).toBe(true);
    expect(graph.predicates.size).toBe(1);
    expect(graph.edges.length).toBe(0);
  });

  it('handles multiple rules with mixed positive and negative dependencies', () => {
    // a(X) :- b(X), not c(X).
    // d(X) :- a(X), e(X).
    const rules: Rule[] = [
      rule(
        atom('a', [varTerm('X')]),
        [
          positiveAtom(atom('b', [varTerm('X')])),
          negation(atom('c', [varTerm('X')])),
        ],
      ),
      rule(
        atom('d', [varTerm('X')]),
        [
          positiveAtom(atom('a', [varTerm('X')])),
          positiveAtom(atom('e', [varTerm('X')])),
        ],
      ),
    ];

    const graph = buildDependencyGraph(rules);

    expect(graph.predicates.size).toBe(5); // a, b, c, d, e

    const aEdges = graph.adjacency.get('a') ?? [];
    expect(aEdges.length).toBe(2);

    const dEdges = graph.adjacency.get('d') ?? [];
    expect(dEdges.length).toBe(2);
    expect(dEdges.every((e) => !e.negative)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SCC Detection
// ---------------------------------------------------------------------------

describe('computeSCCs', () => {
  it('finds trivial SCCs (no cycles)', () => {
    // a -> b -> c (linear, no cycles)
    const rules: Rule[] = [
      rule(
        atom('b', [varTerm('X')]),
        [positiveAtom(atom('a', [varTerm('X')]))],
      ),
      rule(
        atom('c', [varTerm('X')]),
        [positiveAtom(atom('b', [varTerm('X')]))],
      ),
    ];

    const graph = buildDependencyGraph(rules);
    const sccs = computeSCCs(graph);

    // Each predicate should be in its own SCC
    expect(sccs.length).toBe(3);
    for (const scc of sccs) {
      expect(scc.length).toBe(1);
    }
  });

  it('finds a positive cycle', () => {
    // path(X,Y) :- edge(X,Y).
    // path(X,Z) :- edge(X,Y), path(Y,Z).
    // path depends on itself (positive cycle)
    const rules: Rule[] = [
      rule(
        atom('path', [varTerm('X'), varTerm('Y')]),
        [positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')]))],
      ),
      rule(
        atom('path', [varTerm('X'), varTerm('Z')]),
        [
          positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')])),
          positiveAtom(atom('path', [varTerm('Y'), varTerm('Z')])),
        ],
      ),
    ];

    const graph = buildDependencyGraph(rules);
    const sccs = computeSCCs(graph);

    // 'path' should form an SCC with itself (self-loop), 'edge' is separate
    const pathScc = sccs.find((scc) => scc.includes('path'));
    expect(pathScc).toBeDefined();
    expect(pathScc!.includes('path')).toBe(true);
  });

  it('finds mutual recursion SCC', () => {
    // a(X) :- b(X).
    // b(X) :- a(X).
    const rules: Rule[] = [
      rule(
        atom('a', [varTerm('X')]),
        [positiveAtom(atom('b', [varTerm('X')]))],
      ),
      rule(
        atom('b', [varTerm('X')]),
        [positiveAtom(atom('a', [varTerm('X')]))],
      ),
    ];

    const graph = buildDependencyGraph(rules);
    const sccs = computeSCCs(graph);

    // a and b should be in the same SCC
    const abScc = sccs.find((scc) => scc.includes('a'));
    expect(abScc).toBeDefined();
    expect(abScc!.includes('b')).toBe(true);
    expect(abScc!.length).toBe(2);
  });

  it('handles disconnected components', () => {
    // a(X) :- b(X).   (component 1)
    // c(X) :- d(X).   (component 2)
    const rules: Rule[] = [
      rule(
        atom('a', [varTerm('X')]),
        [positiveAtom(atom('b', [varTerm('X')]))],
      ),
      rule(
        atom('c', [varTerm('X')]),
        [positiveAtom(atom('d', [varTerm('X')]))],
      ),
    ];

    const graph = buildDependencyGraph(rules);
    const sccs = computeSCCs(graph);

    // 4 predicates, each in its own SCC
    expect(sccs.length).toBe(4);
    for (const scc of sccs) {
      expect(scc.length).toBe(1);
    }
  });
});

// ---------------------------------------------------------------------------
// Stratification
// ---------------------------------------------------------------------------

describe('stratify', () => {
  it('returns empty strata for empty rules', () => {
    const result = stratify([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.length).toBe(0);
  });

  it('assigns single stratum for positive rules', () => {
    // path(X,Y) :- edge(X,Y).
    // path(X,Z) :- edge(X,Y), path(Y,Z).
    const rules: Rule[] = [
      rule(
        atom('path', [varTerm('X'), varTerm('Y')]),
        [positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')]))],
      ),
      rule(
        atom('path', [varTerm('X'), varTerm('Z')]),
        [
          positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')])),
          positiveAtom(atom('path', [varTerm('Y'), varTerm('Z')])),
        ],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // All rules should be in a single stratum (or at stratum 0)
    // since there is no negation
    const strata = result.value;
    const ruleStrata = strata.filter((s) => s.rules.length > 0);
    expect(ruleStrata.length).toBe(1);
    expect(ruleStrata[0]!.rules.length).toBe(2);
  });

  it('puts negated predicate in lower stratum', () => {
    // derived(X) :- base(X).
    // filtered(X) :- candidate(X), not derived(X).
    //
    // derived depends on base (stratum 0).
    // filtered depends negatively on derived → stratum(filtered) > stratum(derived).
    const rules: Rule[] = [
      rule(
        atom('derived', [varTerm('X')]),
        [positiveAtom(atom('base', [varTerm('X')]))],
      ),
      rule(
        atom('filtered', [varTerm('X')]),
        [
          positiveAtom(atom('candidate', [varTerm('X')])),
          negation(atom('derived', [varTerm('X')])),
        ],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const strata = result.value;

    // Find which stratum each predicate is in
    const derivedStratum = strata.find((s) => s.predicates.has('derived'));
    const filteredStratum = strata.find((s) => s.predicates.has('filtered'));

    expect(derivedStratum).toBeDefined();
    expect(filteredStratum).toBeDefined();
    expect(filteredStratum!.index).toBeGreaterThan(derivedStratum!.index);
  });

  it('handles three-level stratification', () => {
    // level0(X) :- base(X).
    // level1(X) :- source(X), not level0(X).
    // level2(X) :- input(X), not level1(X).
    const rules: Rule[] = [
      rule(
        atom('level0', [varTerm('X')]),
        [positiveAtom(atom('base', [varTerm('X')]))],
      ),
      rule(
        atom('level1', [varTerm('X')]),
        [
          positiveAtom(atom('source', [varTerm('X')])),
          negation(atom('level0', [varTerm('X')])),
        ],
      ),
      rule(
        atom('level2', [varTerm('X')]),
        [
          positiveAtom(atom('input', [varTerm('X')])),
          negation(atom('level1', [varTerm('X')])),
        ],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const strata = result.value;
    const s0 = strata.find((s) => s.predicates.has('level0'));
    const s1 = strata.find((s) => s.predicates.has('level1'));
    const s2 = strata.find((s) => s.predicates.has('level2'));

    expect(s0).toBeDefined();
    expect(s1).toBeDefined();
    expect(s2).toBeDefined();
    expect(s1!.index).toBeGreaterThan(s0!.index);
    expect(s2!.index).toBeGreaterThan(s1!.index);
  });

  it('puts aggregation source in lower stratum', () => {
    const aggClause: AggregationClause = {
      fn: 'max',
      groupBy: ['Slot'],
      over: 'Lamport',
      result: 'MaxL',
      source: atom('active_value', [varTerm('Slot'), varTerm('Lamport')]),
    };

    // derived(X, Y) :- source(X, Y).
    // max_l(Slot, MaxL) :- <agg over derived>
    //
    // Actually, the agg references active_value directly, which is a base fact.
    // But let's test with a derived predicate as source.
    const derivedAggClause: AggregationClause = {
      fn: 'max',
      groupBy: ['Slot'],
      over: 'Val',
      result: 'MaxVal',
      source: atom('derived', [varTerm('Slot'), varTerm('Val')]),
    };

    const rules: Rule[] = [
      rule(
        atom('derived', [varTerm('X'), varTerm('Y')]),
        [positiveAtom(atom('source', [varTerm('X'), varTerm('Y')]))],
      ),
      rule(
        atom('max_derived', [varTerm('Slot'), varTerm('MaxVal')]),
        [aggregation(derivedAggClause)],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const strata = result.value;
    const derivedStratum = strata.find((s) => s.predicates.has('derived'));
    const maxStratum = strata.find((s) => s.predicates.has('max_derived'));

    expect(derivedStratum).toBeDefined();
    expect(maxStratum).toBeDefined();
    expect(maxStratum!.index).toBeGreaterThan(derivedStratum!.index);
  });

  it('strata are in evaluation order (lower index first)', () => {
    const rules: Rule[] = [
      rule(
        atom('a', [varTerm('X')]),
        [positiveAtom(atom('base', [varTerm('X')]))],
      ),
      rule(
        atom('b', [varTerm('X')]),
        [
          positiveAtom(atom('src', [varTerm('X')])),
          negation(atom('a', [varTerm('X')])),
        ],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const strata = result.value;
    for (let i = 1; i < strata.length; i++) {
      expect(strata[i]!.index).toBeGreaterThanOrEqual(strata[i - 1]!.index);
    }
  });

  it('groups positively-dependent predicates in the same stratum', () => {
    // a(X) :- b(X).
    // b(X) :- a(X).  (mutual positive recursion)
    // c(X) :- a(X), not d(X).
    // d is a base fact.
    const rules: Rule[] = [
      rule(
        atom('a', [varTerm('X')]),
        [positiveAtom(atom('b', [varTerm('X')]))],
      ),
      rule(
        atom('b', [varTerm('X')]),
        [positiveAtom(atom('a', [varTerm('X')]))],
      ),
      rule(
        atom('c', [varTerm('X')]),
        [
          positiveAtom(atom('a', [varTerm('X')])),
          negation(atom('d', [varTerm('X')])),
        ],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const strata = result.value;
    const aStratum = strata.find((s) => s.predicates.has('a'));
    const bStratum = strata.find((s) => s.predicates.has('b'));

    expect(aStratum).toBeDefined();
    expect(bStratum).toBeDefined();
    // a and b are in the same SCC, so same stratum
    expect(aStratum!.index).toBe(bStratum!.index);
  });

  it('rules are assigned to the correct stratum', () => {
    // r1: a(X) :- base(X).           -> stratum of 'a'
    // r2: b(X) :- src(X), not a(X).  -> stratum of 'b'
    const r1: Rule = rule(
      atom('a', [varTerm('X')]),
      [positiveAtom(atom('base', [varTerm('X')]))],
    );
    const r2: Rule = rule(
      atom('b', [varTerm('X')]),
      [
        positiveAtom(atom('src', [varTerm('X')])),
        negation(atom('a', [varTerm('X')])),
      ],
    );

    const result = stratify([r1, r2]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const strata = result.value;
    const aStratum = strata.find((s) => s.predicates.has('a'));
    const bStratum = strata.find((s) => s.predicates.has('b'));

    expect(aStratum!.rules).toContain(r1);
    expect(bStratum!.rules).toContain(r2);
    expect(aStratum!.rules).not.toContain(r2);
    expect(bStratum!.rules).not.toContain(r1);
  });
});

// ---------------------------------------------------------------------------
// Cyclic Negation Detection
// ---------------------------------------------------------------------------

describe('cyclic negation detection', () => {
  it('rejects direct cyclic negation (a depends negatively on itself)', () => {
    // a(X) :- b(X), not a(X).
    const rules: Rule[] = [
      rule(
        atom('a', [varTerm('X')]),
        [
          positiveAtom(atom('b', [varTerm('X')])),
          negation(atom('a', [varTerm('X')])),
        ],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('cyclicNegation');
    expect(result.error.cycle).toContain('a');
  });

  it('rejects mutual cyclic negation', () => {
    // a(X) :- b(X), not c(X).
    // c(X) :- d(X), not a(X).
    const rules: Rule[] = [
      rule(
        atom('a', [varTerm('X')]),
        [
          positiveAtom(atom('b', [varTerm('X')])),
          negation(atom('c', [varTerm('X')])),
        ],
      ),
      rule(
        atom('c', [varTerm('X')]),
        [
          positiveAtom(atom('d', [varTerm('X')])),
          negation(atom('a', [varTerm('X')])),
        ],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('cyclicNegation');
    expect(result.error.cycle.length).toBeGreaterThanOrEqual(2);
  });

  it('rejects cyclic negation through positive intermediate', () => {
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
      rule(
        atom('a', [varTerm('X')]),
        [
          negation(atom('b', [varTerm('X')])),
          positiveAtom(atom('src', [varTerm('X')])),
        ],
      ),
      rule(
        atom('b', [varTerm('X')]),
        [positiveAtom(atom('c', [varTerm('X')]))],
      ),
      rule(
        atom('c', [varTerm('X')]),
        [positiveAtom(atom('a', [varTerm('X')]))],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('cyclicNegation');
  });

  it('accepts negation on base facts (no cycle)', () => {
    // result(X) :- candidate(X), not excluded(X).
    // excluded is only a base fact — no rule defines it.
    const rules: Rule[] = [
      rule(
        atom('result', [varTerm('X')]),
        [
          positiveAtom(atom('candidate', [varTerm('X')])),
          negation(atom('excluded', [varTerm('X')])),
        ],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(true);
  });

  it('accepts negation on a predicate from a lower stratum', () => {
    // low(X) :- base(X).
    // high(X) :- src(X), not low(X).
    // No cycle: low is fully computed before high.
    const rules: Rule[] = [
      rule(
        atom('low', [varTerm('X')]),
        [positiveAtom(atom('base', [varTerm('X')]))],
      ),
      rule(
        atom('high', [varTerm('X')]),
        [
          positiveAtom(atom('src', [varTerm('X')])),
          negation(atom('low', [varTerm('X')])),
        ],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(true);
  });

  it('accepts positive self-recursion', () => {
    // reachable(X) :- start(X).
    // reachable(Y) :- reachable(X), edge(X, Y).
    const rules: Rule[] = [
      rule(
        atom('reachable', [varTerm('X')]),
        [positiveAtom(atom('start', [varTerm('X')]))],
      ),
      rule(
        atom('reachable', [varTerm('Y')]),
        [
          positiveAtom(atom('reachable', [varTerm('X')])),
          positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')])),
        ],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(true);
  });

  it('accepts positive mutual recursion', () => {
    // even(X) :- zero(X).
    // even(X) :- odd(Y), succ(Y, X).
    // odd(X) :- even(Y), succ(Y, X).
    const rules: Rule[] = [
      rule(
        atom('even', [varTerm('X')]),
        [positiveAtom(atom('zero', [varTerm('X')]))],
      ),
      rule(
        atom('even', [varTerm('X')]),
        [
          positiveAtom(atom('odd', [varTerm('Y')])),
          positiveAtom(atom('succ', [varTerm('Y'), varTerm('X')])),
        ],
      ),
      rule(
        atom('odd', [varTerm('X')]),
        [
          positiveAtom(atom('even', [varTerm('Y')])),
          positiveAtom(atom('succ', [varTerm('Y'), varTerm('X')])),
        ],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(true);
  });

  it('error includes cycle members', () => {
    // p(X) :- not q(X), r(X).
    // q(X) :- not p(X), s(X).
    const rules: Rule[] = [
      rule(
        atom('p', [varTerm('X')]),
        [
          negation(atom('q', [varTerm('X')])),
          positiveAtom(atom('r', [varTerm('X')])),
        ],
      ),
      rule(
        atom('q', [varTerm('X')]),
        [
          negation(atom('p', [varTerm('X')])),
          positiveAtom(atom('s', [varTerm('X')])),
        ],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('cyclicNegation');
    // The cycle should mention both p and q
    expect(result.error.cycle).toContain('p');
    expect(result.error.cycle).toContain('q');
  });
});

// ---------------------------------------------------------------------------
// Utility functions
// ---------------------------------------------------------------------------

describe('bodyPredicates', () => {
  it('extracts predicates from positive atoms', () => {
    const body = [
      positiveAtom(atom('a', [varTerm('X')])),
      positiveAtom(atom('b', [varTerm('Y')])),
    ];

    const preds = bodyPredicates(body);
    expect(preds.has('a')).toBe(true);
    expect(preds.has('b')).toBe(true);
    expect(preds.size).toBe(2);
  });

  it('extracts predicates from negated atoms', () => {
    const body = [
      positiveAtom(atom('a', [varTerm('X')])),
      negation(atom('b', [varTerm('X')])),
    ];

    const preds = bodyPredicates(body);
    expect(preds.has('a')).toBe(true);
    expect(preds.has('b')).toBe(true);
  });

  it('extracts predicates from aggregation sources', () => {
    const aggClause: AggregationClause = {
      fn: 'sum',
      groupBy: ['G'],
      over: 'V',
      result: 'R',
      source: atom('data', [varTerm('G'), varTerm('V')]),
    };

    const body = [aggregation(aggClause)];
    const preds = bodyPredicates(body);
    expect(preds.has('data')).toBe(true);
  });

  it('handles empty body', () => {
    const preds = bodyPredicates([]);
    expect(preds.size).toBe(0);
  });
});

describe('headPredicates', () => {
  it('extracts head predicates from rules', () => {
    const rules: Rule[] = [
      rule(atom('a', [varTerm('X')]), [positiveAtom(atom('b', [varTerm('X')]))]),
      rule(atom('c', [varTerm('X')]), [positiveAtom(atom('d', [varTerm('X')]))]),
      rule(atom('a', [varTerm('X')]), [positiveAtom(atom('e', [varTerm('X')]))]),
    ];

    const preds = headPredicates(rules);
    expect(preds.has('a')).toBe(true);
    expect(preds.has('c')).toBe(true);
    expect(preds.size).toBe(2); // 'a' appears twice but is deduped
  });

  it('handles empty rules', () => {
    const preds = headPredicates([]);
    expect(preds.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Complex stratification scenarios
// ---------------------------------------------------------------------------

describe('complex stratification', () => {
  it('handles the LWW pattern from §B.4', () => {
    // superseded(CnId, Slot) :-
    //   active_value(CnId, Slot, _, L1, P1),
    //   active_value(CnId2, Slot, _, L2, P2),
    //   __neq(CnId, CnId2),
    //   __gt(L2, L1).
    //
    // superseded(CnId, Slot) :-
    //   active_value(CnId, Slot, _, L1, P1),
    //   active_value(CnId2, Slot, _, L2, P2),
    //   __neq(CnId, CnId2),
    //   __eq(L2, L1),
    //   __gt(P2, P1).
    //
    // winner(Slot, CnId, Value) :-
    //   active_value(CnId, Slot, Value, _, _),
    //   not superseded(CnId, Slot).
    //
    // superseded is in stratum 0 (positive only, depends on base facts + builtins)
    // winner is in stratum 1 (negates superseded)

    const supersededByLamport: Rule = rule(
      atom('superseded', [varTerm('CnId'), varTerm('Slot')]),
      [
        positiveAtom(atom('active_value', [varTerm('CnId'), varTerm('Slot'), varTerm('V1'), varTerm('L1'), varTerm('P1')])),
        positiveAtom(atom('active_value', [varTerm('CnId2'), varTerm('Slot'), varTerm('V2'), varTerm('L2'), varTerm('P2')])),
        positiveAtom(atom('__neq', [varTerm('CnId'), varTerm('CnId2')])),
        positiveAtom(atom('__gt', [varTerm('L2'), varTerm('L1')])),
      ],
    );

    const supersededByPeer: Rule = rule(
      atom('superseded', [varTerm('CnId'), varTerm('Slot')]),
      [
        positiveAtom(atom('active_value', [varTerm('CnId'), varTerm('Slot'), varTerm('V1'), varTerm('L1'), varTerm('P1')])),
        positiveAtom(atom('active_value', [varTerm('CnId2'), varTerm('Slot'), varTerm('V2'), varTerm('L2'), varTerm('P2')])),
        positiveAtom(atom('__neq', [varTerm('CnId'), varTerm('CnId2')])),
        positiveAtom(atom('__eq', [varTerm('L2'), varTerm('L1')])),
        positiveAtom(atom('__gt', [varTerm('P2'), varTerm('P1')])),
      ],
    );

    const winnerRule: Rule = rule(
      atom('winner', [varTerm('Slot'), varTerm('CnId'), varTerm('Value')]),
      [
        positiveAtom(atom('active_value', [varTerm('CnId'), varTerm('Slot'), varTerm('Value'), varTerm('L'), varTerm('P')])),
        negation(atom('superseded', [varTerm('CnId'), varTerm('Slot')])),
      ],
    );

    const rules = [supersededByLamport, supersededByPeer, winnerRule];
    const result = stratify(rules);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const strata = result.value;
    const supersededStratum = strata.find((s) => s.predicates.has('superseded'));
    const winnerStratum = strata.find((s) => s.predicates.has('winner'));

    expect(supersededStratum).toBeDefined();
    expect(winnerStratum).toBeDefined();
    expect(winnerStratum!.index).toBeGreaterThan(supersededStratum!.index);

    // superseded rules should be in the superseded stratum
    expect(supersededStratum!.rules).toContain(supersededByLamport);
    expect(supersededStratum!.rules).toContain(supersededByPeer);

    // winner rule should be in the winner stratum
    expect(winnerStratum!.rules).toContain(winnerRule);
  });

  it('handles diamond dependency without negation', () => {
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
      rule(atom('b', [varTerm('X')]), [positiveAtom(atom('d', [varTerm('X')]))]),
      rule(atom('c', [varTerm('X')]), [positiveAtom(atom('d', [varTerm('X')]))]),
      rule(
        atom('a', [varTerm('X')]),
        [
          positiveAtom(atom('b', [varTerm('X')])),
          positiveAtom(atom('c', [varTerm('X')])),
        ],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // All should be stratifiable. a depends on b and c, which depend on d.
    // All positive, so they can be in the same stratum.
    const strata = result.value;
    expect(strata.length).toBeGreaterThan(0);
  });

  it('handles diamond dependency with negation on one branch', () => {
    // b(X) :- d(X).
    // c(X) :- d(X).
    // a(X) :- b(X), not c(X).
    //
    // a negates c → a must be in a higher stratum than c.
    const rules: Rule[] = [
      rule(atom('b', [varTerm('X')]), [positiveAtom(atom('d', [varTerm('X')]))]),
      rule(atom('c', [varTerm('X')]), [positiveAtom(atom('d', [varTerm('X')]))]),
      rule(
        atom('a', [varTerm('X')]),
        [
          positiveAtom(atom('b', [varTerm('X')])),
          negation(atom('c', [varTerm('X')])),
        ],
      ),
    ];

    const result = stratify(rules);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const strata = result.value;
    const cStratum = strata.find((s) => s.predicates.has('c'));
    const aStratum = strata.find((s) => s.predicates.has('a'));

    expect(cStratum).toBeDefined();
    expect(aStratum).toBeDefined();
    expect(aStratum!.index).toBeGreaterThan(cStratum!.index);
  });
});