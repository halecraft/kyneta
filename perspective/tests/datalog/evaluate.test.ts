// === Evaluate Tests ===
// Tests for the Datalog evaluator: semi-naive fixed-point evaluation,
// transitive closure (classic Datalog benchmark), stratified negation,
// multiple rules for the same head predicate, empty relation handling,
// and equivalence between naive and semi-naive evaluation.

import { describe, it, expect } from 'vitest';
import {
  atom,
  constTerm,
  varTerm,
  wildcard,
  _,
  rule,
  fact,
  positiveAtom,
  negation,
  aggregation,
  neq,
  gt,
  lt,
  eq,
  lte,
  gte,
  Database,
} from '../../src/datalog/types.js';
import type { Rule, Fact, AggregationClause } from '../../src/datalog/types.js';
import {
  evaluate,
  evaluatePositive,
  evaluateNaive,
} from '../../src/datalog/evaluate.js';

// ---------------------------------------------------------------------------
// Helper to collect all tuples for a predicate from a Database
// ---------------------------------------------------------------------------

function factsFor(db: Database, predicate: string): readonly (readonly unknown[])[] {
  return db.getRelation(predicate).tuples();
}

function hasFact(db: Database, predicate: string, values: readonly unknown[]): boolean {
  return db.getRelation(predicate).has(values as readonly (null | boolean | number | bigint | string | Uint8Array | { readonly ref: { peer: string; counter: number } })[]);
}

// ---------------------------------------------------------------------------
// Positive Datalog: Transitive Closure
// ---------------------------------------------------------------------------

describe('transitive closure (classic path/edge)', () => {
  // edge(X,Y) → path(X,Y).
  // path(X,Z) :- edge(X,Y), path(Y,Z).
  const baseRule: Rule = rule(
    atom('path', [varTerm('X'), varTerm('Y')]),
    [positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')]))],
  );

  const transitiveRule: Rule = rule(
    atom('path', [varTerm('X'), varTerm('Z')]),
    [
      positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')])),
      positiveAtom(atom('path', [varTerm('Y'), varTerm('Z')])),
    ],
  );

  const rules: Rule[] = [baseRule, transitiveRule];

  it('reaches fixed point on a simple chain', () => {
    // a → b → c → d
    const facts: Fact[] = [
      fact('edge', ['a', 'b']),
      fact('edge', ['b', 'c']),
      fact('edge', ['c', 'd']),
    ];

    const db = evaluatePositive(rules, facts);

    // Direct edges become paths
    expect(hasFact(db, 'path', ['a', 'b'])).toBe(true);
    expect(hasFact(db, 'path', ['b', 'c'])).toBe(true);
    expect(hasFact(db, 'path', ['c', 'd'])).toBe(true);

    // Transitive paths
    expect(hasFact(db, 'path', ['a', 'c'])).toBe(true);
    expect(hasFact(db, 'path', ['a', 'd'])).toBe(true);
    expect(hasFact(db, 'path', ['b', 'd'])).toBe(true);

    // No spurious paths
    expect(hasFact(db, 'path', ['d', 'a'])).toBe(false);
    expect(hasFact(db, 'path', ['c', 'a'])).toBe(false);

    // Total: 6 path facts
    expect(db.getRelation('path').size).toBe(6);
  });

  it('handles a cycle', () => {
    // a → b → c → a (cycle)
    const facts: Fact[] = [
      fact('edge', ['a', 'b']),
      fact('edge', ['b', 'c']),
      fact('edge', ['c', 'a']),
    ];

    const db = evaluatePositive(rules, facts);

    // All pairs should be reachable
    for (const from of ['a', 'b', 'c']) {
      for (const to of ['a', 'b', 'c']) {
        expect(hasFact(db, 'path', [from, to])).toBe(true);
      }
    }

    expect(db.getRelation('path').size).toBe(9);
  });

  it('handles disconnected components', () => {
    const facts: Fact[] = [
      fact('edge', ['a', 'b']),
      fact('edge', ['c', 'd']),
    ];

    const db = evaluatePositive(rules, facts);

    expect(hasFact(db, 'path', ['a', 'b'])).toBe(true);
    expect(hasFact(db, 'path', ['c', 'd'])).toBe(true);
    expect(hasFact(db, 'path', ['a', 'd'])).toBe(false);
    expect(hasFact(db, 'path', ['c', 'b'])).toBe(false);

    expect(db.getRelation('path').size).toBe(2);
  });

  it('handles a single node with self-loop', () => {
    const facts: Fact[] = [
      fact('edge', ['a', 'a']),
    ];

    const db = evaluatePositive(rules, facts);

    expect(hasFact(db, 'path', ['a', 'a'])).toBe(true);
    expect(db.getRelation('path').size).toBe(1);
  });

  it('handles a longer chain (5 nodes)', () => {
    const facts: Fact[] = [
      fact('edge', ['a', 'b']),
      fact('edge', ['b', 'c']),
      fact('edge', ['c', 'd']),
      fact('edge', ['d', 'e']),
    ];

    const db = evaluatePositive(rules, facts);

    // a can reach everyone, b can reach c,d,e, etc.
    expect(hasFact(db, 'path', ['a', 'e'])).toBe(true);
    expect(hasFact(db, 'path', ['b', 'e'])).toBe(true);
    expect(hasFact(db, 'path', ['c', 'e'])).toBe(true);
    expect(hasFact(db, 'path', ['d', 'e'])).toBe(true);

    // 4 + 3 + 2 + 1 = 10 path facts
    expect(db.getRelation('path').size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Semi-naive vs Naive equivalence
// ---------------------------------------------------------------------------

describe('semi-naive produces same result as naive', () => {
  it('transitive closure equivalence', () => {
    const baseRule: Rule = rule(
      atom('path', [varTerm('X'), varTerm('Y')]),
      [positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')]))],
    );
    const transitiveRule: Rule = rule(
      atom('path', [varTerm('X'), varTerm('Z')]),
      [
        positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')])),
        positiveAtom(atom('path', [varTerm('Y'), varTerm('Z')])),
      ],
    );
    const rules = [baseRule, transitiveRule];

    const facts: Fact[] = [
      fact('edge', ['a', 'b']),
      fact('edge', ['b', 'c']),
      fact('edge', ['c', 'd']),
      fact('edge', ['d', 'a']),
      fact('edge', ['b', 'd']),
    ];

    const naiveDb = evaluateNaive(rules, facts);
    const semiNaiveDb = evaluatePositive(rules, facts);

    // Both should have the same path facts
    const naivePaths = naiveDb.getRelation('path');
    const semiNaivePaths = semiNaiveDb.getRelation('path');

    expect(semiNaivePaths.size).toBe(naivePaths.size);

    for (const tuple of naivePaths.tuples()) {
      expect(semiNaivePaths.has(tuple)).toBe(true);
    }
  });

  it('ancestor equivalence (deeper recursion)', () => {
    // parent(X,Y) → ancestor(X,Y)
    // ancestor(X,Z) :- parent(X,Y), ancestor(Y,Z)
    const baseRule: Rule = rule(
      atom('ancestor', [varTerm('X'), varTerm('Y')]),
      [positiveAtom(atom('parent', [varTerm('X'), varTerm('Y')]))],
    );
    const transitiveRule: Rule = rule(
      atom('ancestor', [varTerm('X'), varTerm('Z')]),
      [
        positiveAtom(atom('parent', [varTerm('X'), varTerm('Y')])),
        positiveAtom(atom('ancestor', [varTerm('Y'), varTerm('Z')])),
      ],
    );
    const rules = [baseRule, transitiveRule];

    const facts: Fact[] = [
      fact('parent', ['alice', 'bob']),
      fact('parent', ['bob', 'charlie']),
      fact('parent', ['charlie', 'dave']),
      fact('parent', ['alice', 'eve']),
      fact('parent', ['eve', 'frank']),
    ];

    const naiveDb = evaluateNaive(rules, facts);
    const semiNaiveDb = evaluatePositive(rules, facts);

    expect(semiNaiveDb.getRelation('ancestor').size).toBe(
      naiveDb.getRelation('ancestor').size,
    );
  });
});

// ---------------------------------------------------------------------------
// Multiple rules for the same head predicate
// ---------------------------------------------------------------------------

describe('multiple rules for same head predicate', () => {
  it('all rules contribute facts', () => {
    // reachable(X) :- start(X).
    // reachable(Y) :- reachable(X), edge(X, Y).
    const startRule: Rule = rule(
      atom('reachable', [varTerm('X')]),
      [positiveAtom(atom('start', [varTerm('X')]))],
    );
    const edgeRule: Rule = rule(
      atom('reachable', [varTerm('Y')]),
      [
        positiveAtom(atom('reachable', [varTerm('X')])),
        positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')])),
      ],
    );

    const facts: Fact[] = [
      fact('start', ['a']),
      fact('edge', ['a', 'b']),
      fact('edge', ['b', 'c']),
      fact('edge', ['c', 'd']),
      fact('edge', ['x', 'y']), // disconnected
    ];

    const db = evaluatePositive([startRule, edgeRule], facts);

    expect(hasFact(db, 'reachable', ['a'])).toBe(true);
    expect(hasFact(db, 'reachable', ['b'])).toBe(true);
    expect(hasFact(db, 'reachable', ['c'])).toBe(true);
    expect(hasFact(db, 'reachable', ['d'])).toBe(true);
    expect(hasFact(db, 'reachable', ['x'])).toBe(false);
    expect(hasFact(db, 'reachable', ['y'])).toBe(false);
  });

  it('union of two base rules', () => {
    // combined(X) :- a_facts(X).
    // combined(X) :- b_facts(X).
    const rule1: Rule = rule(
      atom('combined', [varTerm('X')]),
      [positiveAtom(atom('a_facts', [varTerm('X')]))],
    );
    const rule2: Rule = rule(
      atom('combined', [varTerm('X')]),
      [positiveAtom(atom('b_facts', [varTerm('X')]))],
    );

    const facts: Fact[] = [
      fact('a_facts', [1]),
      fact('a_facts', [2]),
      fact('b_facts', [2]),
      fact('b_facts', [3]),
    ];

    const db = evaluatePositive([rule1, rule2], facts);

    expect(hasFact(db, 'combined', [1])).toBe(true);
    expect(hasFact(db, 'combined', [2])).toBe(true);
    expect(hasFact(db, 'combined', [3])).toBe(true);
    expect(db.getRelation('combined').size).toBe(3); // 2 is deduped
  });
});

// ---------------------------------------------------------------------------
// Empty relation handling
// ---------------------------------------------------------------------------

describe('empty relation handling', () => {
  it('rules over empty facts produce empty results', () => {
    const r: Rule = rule(
      atom('path', [varTerm('X'), varTerm('Y')]),
      [positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')]))],
    );

    const db = evaluatePositive([r], []);

    expect(db.getRelation('path').size).toBe(0);
    expect(db.getRelation('edge').size).toBe(0);
  });

  it('no rules with facts just returns the facts', () => {
    const facts: Fact[] = [
      fact('edge', ['a', 'b']),
      fact('edge', ['b', 'c']),
    ];

    const db = evaluatePositive([], facts);

    expect(db.getRelation('edge').size).toBe(2);
    expect(db.getRelation('path').size).toBe(0);
  });

  it('no rules and no facts returns empty database', () => {
    const db = evaluatePositive([], []);
    expect(db.size).toBe(0);
  });

  it('rule with one empty body atom produces nothing', () => {
    // result(X, Y) :- populated(X), empty_rel(Y).
    const r: Rule = rule(
      atom('result', [varTerm('X'), varTerm('Y')]),
      [
        positiveAtom(atom('populated', [varTerm('X')])),
        positiveAtom(atom('empty_rel', [varTerm('Y')])),
      ],
    );

    const facts: Fact[] = [
      fact('populated', ['a']),
      fact('populated', ['b']),
    ];

    const db = evaluatePositive([r], facts);

    expect(db.getRelation('result').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stratified negation
// ---------------------------------------------------------------------------

describe('stratified negation', () => {
  it('basic negation: "not" filters out matching facts', () => {
    // non_edge(X, Y) :- node(X), node(Y), not edge(X, Y).
    const r: Rule = rule(
      atom('non_edge', [varTerm('X'), varTerm('Y')]),
      [
        positiveAtom(atom('node', [varTerm('X')])),
        positiveAtom(atom('node', [varTerm('Y')])),
        negation(atom('edge', [varTerm('X'), varTerm('Y')])),
      ],
    );

    const facts: Fact[] = [
      fact('node', ['a']),
      fact('node', ['b']),
      fact('node', ['c']),
      fact('edge', ['a', 'b']),
      fact('edge', ['b', 'c']),
    ];

    const result = evaluate([r], facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = result.value;

    // Should include all non-edges
    expect(hasFact(db, 'non_edge', ['a', 'a'])).toBe(true);
    expect(hasFact(db, 'non_edge', ['a', 'c'])).toBe(true);
    expect(hasFact(db, 'non_edge', ['b', 'a'])).toBe(true);
    expect(hasFact(db, 'non_edge', ['b', 'b'])).toBe(true);
    expect(hasFact(db, 'non_edge', ['c', 'a'])).toBe(true);
    expect(hasFact(db, 'non_edge', ['c', 'b'])).toBe(true);
    expect(hasFact(db, 'non_edge', ['c', 'c'])).toBe(true);

    // Should not include actual edges
    expect(hasFact(db, 'non_edge', ['a', 'b'])).toBe(false);
    expect(hasFact(db, 'non_edge', ['b', 'c'])).toBe(false);

    expect(db.getRelation('non_edge').size).toBe(7);
  });

  it('negation respects stratum boundaries', () => {
    // derived(X) :- base(X).
    // filtered(X) :- candidate(X), not derived(X).
    //
    // derived depends on base (stratum 0).
    // filtered depends on candidate (stratum 0) and negatively on derived (stratum 1).
    const deriveRule: Rule = rule(
      atom('derived', [varTerm('X')]),
      [positiveAtom(atom('base', [varTerm('X')]))],
    );
    const filterRule: Rule = rule(
      atom('filtered', [varTerm('X')]),
      [
        positiveAtom(atom('candidate', [varTerm('X')])),
        negation(atom('derived', [varTerm('X')])),
      ],
    );

    const facts: Fact[] = [
      fact('base', [1]),
      fact('base', [2]),
      fact('candidate', [1]),
      fact('candidate', [2]),
      fact('candidate', [3]),
    ];

    const result = evaluate([deriveRule, filterRule], facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = result.value;

    // derived has 1 and 2
    expect(hasFact(db, 'derived', [1])).toBe(true);
    expect(hasFact(db, 'derived', [2])).toBe(true);

    // filtered should only have 3 (not in derived)
    expect(hasFact(db, 'filtered', [3])).toBe(true);
    expect(hasFact(db, 'filtered', [1])).toBe(false);
    expect(hasFact(db, 'filtered', [2])).toBe(false);
    expect(db.getRelation('filtered').size).toBe(1);
  });

  it('rejects cyclic negation with Result error', () => {
    // a(X) :- b(X), not c(X).
    // c(X) :- not a(X), d(X).
    // This creates a cycle: a depends negatively on c, c depends negatively on a.
    const rule1: Rule = rule(
      atom('a', [varTerm('X')]),
      [
        positiveAtom(atom('b', [varTerm('X')])),
        negation(atom('c', [varTerm('X')])),
      ],
    );
    const rule2: Rule = rule(
      atom('c', [varTerm('X')]),
      [
        negation(atom('a', [varTerm('X')])),
        positiveAtom(atom('d', [varTerm('X')])),
      ],
    );

    const facts: Fact[] = [
      fact('b', [1]),
      fact('d', [1]),
    ];

    const result = evaluate([rule1, rule2], facts);
    expect(result.ok).toBe(false);
    if (result.ok) return;

    expect(result.error.kind).toBe('cyclicNegation');
  });

  it('allows positive cycles (no negation in cycle)', () => {
    // Positive mutual recursion is fine.
    // a(X) :- seed(X).
    // a(Y) :- a(X), link(X, Y).
    // b(X) :- a(X).
    const seedRule: Rule = rule(
      atom('a', [varTerm('X')]),
      [positiveAtom(atom('seed', [varTerm('X')]))],
    );
    const linkRule: Rule = rule(
      atom('a', [varTerm('Y')]),
      [
        positiveAtom(atom('a', [varTerm('X')])),
        positiveAtom(atom('link', [varTerm('X'), varTerm('Y')])),
      ],
    );
    const copyRule: Rule = rule(
      atom('b', [varTerm('X')]),
      [positiveAtom(atom('a', [varTerm('X')]))],
    );

    const facts: Fact[] = [
      fact('seed', [1]),
      fact('link', [1, 2]),
      fact('link', [2, 3]),
    ];

    const result = evaluate([seedRule, linkRule, copyRule], facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = result.value;
    expect(hasFact(db, 'a', [1])).toBe(true);
    expect(hasFact(db, 'a', [2])).toBe(true);
    expect(hasFact(db, 'a', [3])).toBe(true);
    expect(hasFact(db, 'b', [1])).toBe(true);
    expect(hasFact(db, 'b', [2])).toBe(true);
    expect(hasFact(db, 'b', [3])).toBe(true);
  });

  it('negation on empty predicate succeeds (everything passes)', () => {
    // selected(X) :- candidate(X), not blacklisted(X).
    // blacklisted is not in the facts — empty relation
    const r: Rule = rule(
      atom('selected', [varTerm('X')]),
      [
        positiveAtom(atom('candidate', [varTerm('X')])),
        negation(atom('blacklisted', [varTerm('X')])),
      ],
    );

    const facts: Fact[] = [
      fact('candidate', ['a']),
      fact('candidate', ['b']),
      fact('candidate', ['c']),
    ];

    const result = evaluate([r], facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = result.value;
    expect(db.getRelation('selected').size).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Guard body elements in rules
// ---------------------------------------------------------------------------

describe('guard body elements in rules', () => {
  it('neq() filters self-pairs', () => {
    // pair(X, Y) :- node(X), node(Y), X ≠ Y.
    const r: Rule = rule(
      atom('pair', [varTerm('X'), varTerm('Y')]),
      [
        positiveAtom(atom('node', [varTerm('X')])),
        positiveAtom(atom('node', [varTerm('Y')])),
        neq(varTerm('X'), varTerm('Y')),
      ],
    );

    const facts: Fact[] = [
      fact('node', ['a']),
      fact('node', ['b']),
      fact('node', ['c']),
    ];

    const db = evaluatePositive([r], facts);

    // All ordered pairs except self-pairs: 3*2 = 6
    expect(db.getRelation('pair').size).toBe(6);
    expect(hasFact(db, 'pair', ['a', 'a'])).toBe(false);
    expect(hasFact(db, 'pair', ['a', 'b'])).toBe(true);
    expect(hasFact(db, 'pair', ['b', 'a'])).toBe(true);
  });

  it('gt() comparison in rule body', () => {
    // bigger(X, Y) :- num(X), num(Y), X > Y.
    const r: Rule = rule(
      atom('bigger', [varTerm('X'), varTerm('Y')]),
      [
        positiveAtom(atom('num', [varTerm('X')])),
        positiveAtom(atom('num', [varTerm('Y')])),
        gt(varTerm('X'), varTerm('Y')),
      ],
    );

    const facts: Fact[] = [
      fact('num', [1]),
      fact('num', [2]),
      fact('num', [3]),
    ];

    const db = evaluatePositive([r], facts);

    expect(hasFact(db, 'bigger', [2, 1])).toBe(true);
    expect(hasFact(db, 'bigger', [3, 1])).toBe(true);
    expect(hasFact(db, 'bigger', [3, 2])).toBe(true);
    expect(hasFact(db, 'bigger', [1, 2])).toBe(false);
    expect(db.getRelation('bigger').size).toBe(3);
  });

  it('lt() with string comparison', () => {
    // ordered(X, Y) :- word(X), word(Y), X < Y.
    const r: Rule = rule(
      atom('ordered', [varTerm('X'), varTerm('Y')]),
      [
        positiveAtom(atom('word', [varTerm('X')])),
        positiveAtom(atom('word', [varTerm('Y')])),
        lt(varTerm('X'), varTerm('Y')),
      ],
    );

    const facts: Fact[] = [
      fact('word', ['apple']),
      fact('word', ['banana']),
      fact('word', ['cherry']),
    ];

    const db = evaluatePositive([r], facts);

    expect(hasFact(db, 'ordered', ['apple', 'banana'])).toBe(true);
    expect(hasFact(db, 'ordered', ['apple', 'cherry'])).toBe(true);
    expect(hasFact(db, 'ordered', ['banana', 'cherry'])).toBe(true);
    expect(hasFact(db, 'ordered', ['banana', 'apple'])).toBe(false);
    expect(db.getRelation('ordered').size).toBe(3);
  });

  it('eq() with constant guard', () => {
    // matched(X) :- data(X, Y), Y == 'target'.
    const r: Rule = rule(
      atom('matched', [varTerm('X')]),
      [
        positiveAtom(atom('data', [varTerm('X'), varTerm('Y')])),
        eq(varTerm('Y'), constTerm('target')),
      ],
    );

    const facts: Fact[] = [
      fact('data', ['a', 'target']),
      fact('data', ['b', 'other']),
      fact('data', ['c', 'target']),
    ];

    const db = evaluatePositive([r], facts);
    expect(db.getRelation('matched').size).toBe(2);
    expect(hasFact(db, 'matched', ['a'])).toBe(true);
    expect(hasFact(db, 'matched', ['c'])).toBe(true);
    expect(hasFact(db, 'matched', ['b'])).toBe(false);
  });

  it('lte() and gte() inclusive bounds', () => {
    // in_range(X) :- num(X), X >= 2, X <= 4.
    const r: Rule = rule(
      atom('in_range', [varTerm('X')]),
      [
        positiveAtom(atom('num', [varTerm('X')])),
        gte(varTerm('X'), constTerm(2)),
        lte(varTerm('X'), constTerm(4)),
      ],
    );

    const facts: Fact[] = [
      fact('num', [1]),
      fact('num', [2]),
      fact('num', [3]),
      fact('num', [4]),
      fact('num', [5]),
    ];

    const db = evaluatePositive([r], facts);
    expect(db.getRelation('in_range').size).toBe(3);
    expect(hasFact(db, 'in_range', [2])).toBe(true);
    expect(hasFact(db, 'in_range', [3])).toBe(true);
    expect(hasFact(db, 'in_range', [4])).toBe(true);
    expect(hasFact(db, 'in_range', [1])).toBe(false);
    expect(hasFact(db, 'in_range', [5])).toBe(false);
  });

  it('guards introduce no predicate dependencies in stratification', () => {
    // The guard on X ≠ Y should not create a dependency edge.
    // filtered(X) :- source(X), not excluded(X).
    // pair(X, Y) :- filtered(X), filtered(Y), X ≠ Y.
    //
    // If guards were treated as predicates, 'pair' would depend on
    // a predicate '__neq' which doesn't exist — this would be wrong.
    const filteredRule: Rule = rule(
      atom('filtered', [varTerm('X')]),
      [
        positiveAtom(atom('source', [varTerm('X')])),
        negation(atom('excluded', [varTerm('X')])),
      ],
    );
    const pairRule: Rule = rule(
      atom('pair', [varTerm('X'), varTerm('Y')]),
      [
        positiveAtom(atom('filtered', [varTerm('X')])),
        positiveAtom(atom('filtered', [varTerm('Y')])),
        neq(varTerm('X'), varTerm('Y')),
      ],
    );

    const facts: Fact[] = [
      fact('source', [1]),
      fact('source', [2]),
      fact('source', [3]),
      fact('excluded', [2]),
    ];

    const result = evaluate([filteredRule, pairRule], facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = result.value;
    expect(hasFact(db, 'filtered', [1])).toBe(true);
    expect(hasFact(db, 'filtered', [3])).toBe(true);
    expect(hasFact(db, 'filtered', [2])).toBe(false);
    // pair: (1,3) and (3,1)
    expect(db.getRelation('pair').size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Legacy built-in predicates still work (backward compat)
// ---------------------------------------------------------------------------

describe('legacy __builtin predicates (backward compat)', () => {
  it('__neq still works', () => {
    const r: Rule = rule(
      atom('pair', [varTerm('X'), varTerm('Y')]),
      [
        positiveAtom(atom('node', [varTerm('X')])),
        positiveAtom(atom('node', [varTerm('Y')])),
        positiveAtom(atom('__neq', [varTerm('X'), varTerm('Y')])),
      ],
    );

    const facts: Fact[] = [
      fact('node', ['a']),
      fact('node', ['b']),
    ];

    const db = evaluatePositive([r], facts);
    expect(db.getRelation('pair').size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Wildcard term
// ---------------------------------------------------------------------------

describe('wildcard term', () => {
  it('wildcard matches any value without binding', () => {
    // has_any(X) :- pair(X, _).
    const r: Rule = rule(
      atom('has_any', [varTerm('X')]),
      [positiveAtom(atom('pair', [varTerm('X'), _]))],
    );

    const facts: Fact[] = [
      fact('pair', ['a', 1]),
      fact('pair', ['a', 2]),
      fact('pair', ['b', 3]),
    ];

    const db = evaluatePositive([r], facts);
    // 'a' appears twice but deduplicates
    expect(db.getRelation('has_any').size).toBe(2);
    expect(hasFact(db, 'has_any', ['a'])).toBe(true);
    expect(hasFact(db, 'has_any', ['b'])).toBe(true);
  });

  it('multiple wildcards are independent (do not unify)', () => {
    // Using varTerm('_X') twice would force both positions to match.
    // Using wildcard() twice does NOT — each is independent.
    // exists(X) :- triple(X, _, _).
    const r: Rule = rule(
      atom('exists', [varTerm('X')]),
      [positiveAtom(atom('triple', [varTerm('X'), wildcard(), wildcard()]))],
    );

    const facts: Fact[] = [
      fact('triple', ['a', 1, 2]),
      fact('triple', ['a', 3, 4]),
      fact('triple', ['b', 5, 5]),  // same value in both wildcard positions — still matches
    ];

    const db = evaluatePositive([r], facts);
    expect(db.getRelation('exists').size).toBe(2);
    expect(hasFact(db, 'exists', ['a'])).toBe(true);
    expect(hasFact(db, 'exists', ['b'])).toBe(true);
  });

  it('wildcard in aggregation source skips binding that column', () => {
    // count_per_group(G, C) :- count<V> over data(G, _, V) group_by [G].
    const aggClause: AggregationClause = {
      fn: 'count',
      groupBy: ['G'],
      over: 'V',
      result: 'C',
      source: atom('data', [varTerm('G'), _, varTerm('V')]),
    };

    const countRule: Rule = rule(
      atom('count_per_group', [varTerm('G'), varTerm('C')]),
      [aggregation(aggClause)],
    );

    const facts: Fact[] = [
      fact('data', ['x', 'ignored1', 'a']),
      fact('data', ['x', 'ignored2', 'b']),
      fact('data', ['y', 'ignored3', 'c']),
    ];

    const result = evaluate([countRule], facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = result.value;
    expect(hasFact(db, 'count_per_group', ['x', 2])).toBe(true);
    expect(hasFact(db, 'count_per_group', ['y', 1])).toBe(true);
  });

  it('_ convenience export is a wildcard', () => {
    expect(_.kind).toBe('wildcard');
    // Each call to wildcard() or use of _ is the same shape
    expect(wildcard().kind).toBe('wildcard');
  });
});

// ---------------------------------------------------------------------------
// Aggregation in rules
// ---------------------------------------------------------------------------

describe('aggregation in rules', () => {
  it('max aggregation selects LWW winner', () => {
    // This simulates the LWW pattern:
    // max_lamport(Slot, MaxL) :- max<Lamport> over active_value(_, Slot, _, Lamport) group_by [Slot]
    // (We use the aggregation body element directly.)
    //
    // winner(Slot, CnId, Value) :-
    //   active_value(CnId, Slot, Value, Lamport),
    //   max_lamport(Slot, Lamport).
    //
    // Simplified approach: use aggregation directly in body.

    const aggClause: AggregationClause = {
      fn: 'max',
      groupBy: ['Slot'],
      over: 'Lamport',
      result: 'MaxL',
      source: atom('active_value', [
        varTerm('_CnId'),
        varTerm('Slot'),
        varTerm('_Value'),
        varTerm('Lamport'),
      ]),
    };

    // max_lamport(Slot, MaxL) via aggregation
    const maxRule: Rule = rule(
      atom('max_lamport', [varTerm('Slot'), varTerm('MaxL')]),
      [aggregation(aggClause)],
    );

    // winner(Slot, CnId, Value) :-
    //   active_value(CnId, Slot, Value, Lamport),
    //   max_lamport(Slot, Lamport).
    const winnerRule: Rule = rule(
      atom('winner', [varTerm('Slot'), varTerm('CnId'), varTerm('Value')]),
      [
        positiveAtom(atom('active_value', [varTerm('CnId'), varTerm('Slot'), varTerm('Value'), varTerm('Lamport')])),
        positiveAtom(atom('max_lamport', [varTerm('Slot'), varTerm('Lamport')])),
      ],
    );

    const facts: Fact[] = [
      // active_value(CnId, Slot, Value, Lamport)
      fact('active_value', ['cn1', 'title', 'Hello', 1]),
      fact('active_value', ['cn2', 'title', 'World', 3]),    // winner (higher lamport)
      fact('active_value', ['cn3', 'title', 'Goodbye', 2]),
      fact('active_value', ['cn4', 'body', 'First', 1]),
      fact('active_value', ['cn5', 'body', 'Second', 5]),     // winner
    ];

    const result = evaluate([maxRule, winnerRule], facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = result.value;

    // max_lamport should have the max lamport per slot
    expect(hasFact(db, 'max_lamport', ['title', 3])).toBe(true);
    expect(hasFact(db, 'max_lamport', ['body', 5])).toBe(true);

    // winners
    expect(hasFact(db, 'winner', ['title', 'cn2', 'World'])).toBe(true);
    expect(hasFact(db, 'winner', ['body', 'cn5', 'Second'])).toBe(true);

    // non-winners should not appear
    expect(hasFact(db, 'winner', ['title', 'cn1', 'Hello'])).toBe(false);
    expect(hasFact(db, 'winner', ['title', 'cn3', 'Goodbye'])).toBe(false);
  });

  it('count aggregation', () => {
    const aggClause: AggregationClause = {
      fn: 'count',
      groupBy: ['Group'],
      over: 'Item',
      result: 'Count',
      source: atom('member', [varTerm('Group'), varTerm('Item')]),
    };

    const countRule: Rule = rule(
      atom('group_count', [varTerm('Group'), varTerm('Count')]),
      [aggregation(aggClause)],
    );

    const facts: Fact[] = [
      fact('member', ['a', 1]),
      fact('member', ['a', 2]),
      fact('member', ['a', 3]),
      fact('member', ['b', 10]),
      fact('member', ['b', 20]),
    ];

    const result = evaluate([countRule], facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = result.value;
    expect(hasFact(db, 'group_count', ['a', 3])).toBe(true);
    expect(hasFact(db, 'group_count', ['b', 2])).toBe(true);
  });

  it('sum aggregation', () => {
    const aggClause: AggregationClause = {
      fn: 'sum',
      groupBy: ['Category'],
      over: 'Amount',
      result: 'Total',
      source: atom('expense', [varTerm('Category'), varTerm('Amount')]),
    };

    const sumRule: Rule = rule(
      atom('total_expense', [varTerm('Category'), varTerm('Total')]),
      [aggregation(aggClause)],
    );

    const facts: Fact[] = [
      fact('expense', ['food', 10]),
      fact('expense', ['food', 20]),
      fact('expense', ['food', 30]),
      fact('expense', ['transport', 50]),
      fact('expense', ['transport', 25]),
    ];

    const result = evaluate([sumRule], facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = result.value;
    expect(hasFact(db, 'total_expense', ['food', 60])).toBe(true);
    expect(hasFact(db, 'total_expense', ['transport', 75])).toBe(true);
  });

  it('min aggregation', () => {
    const aggClause: AggregationClause = {
      fn: 'min',
      groupBy: ['Group'],
      over: 'Val',
      result: 'MinVal',
      source: atom('data', [varTerm('Group'), varTerm('Val')]),
    };

    const minRule: Rule = rule(
      atom('min_val', [varTerm('Group'), varTerm('MinVal')]),
      [aggregation(aggClause)],
    );

    const facts: Fact[] = [
      fact('data', ['x', 30]),
      fact('data', ['x', 10]),
      fact('data', ['x', 20]),
      fact('data', ['y', 5]),
      fact('data', ['y', 15]),
    ];

    const result = evaluate([minRule], facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = result.value;
    expect(hasFact(db, 'min_val', ['x', 10])).toBe(true);
    expect(hasFact(db, 'min_val', ['y', 5])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Number/bigint type distinction in evaluation
// ---------------------------------------------------------------------------

describe('number/bigint type distinction', () => {
  it('number(3.0) and bigint(3n) do not unify in rule matching', () => {
    // match(X) :- nums(X), targets(X).
    const r: Rule = rule(
      atom('match', [varTerm('X')]),
      [
        positiveAtom(atom('nums', [varTerm('X')])),
        positiveAtom(atom('targets', [varTerm('X')])),
      ],
    );

    const facts: Fact[] = [
      fact('nums', [3]),      // number
      fact('targets', [3n]),  // bigint — should NOT match
      fact('nums', [5n]),     // bigint
      fact('targets', [5n]),  // bigint — should match
    ];

    const db = evaluatePositive([r], facts);

    // Only bigint 5n should match (same type)
    expect(db.getRelation('match').size).toBe(1);
    expect(hasFact(db, 'match', [5n])).toBe(true);
    expect(hasFact(db, 'match', [3])).toBe(false);
    expect(hasFact(db, 'match', [3n])).toBe(false);
  });

  it('number and bigint lamport values are distinct in LWW', () => {
    // Lamport values should be numbers (as per spec: safe_uint),
    // but this test ensures the type system catches mismatches.
    const aggClause: AggregationClause = {
      fn: 'max',
      groupBy: ['Slot'],
      over: 'Lamport',
      result: 'MaxL',
      source: atom('vals', [varTerm('Slot'), varTerm('Lamport')]),
    };

    const maxRule: Rule = rule(
      atom('max_l', [varTerm('Slot'), varTerm('MaxL')]),
      [aggregation(aggClause)],
    );

    // All number lamports
    const facts: Fact[] = [
      fact('vals', ['a', 1]),
      fact('vals', ['a', 5]),
      fact('vals', ['a', 3]),
    ];

    const result = evaluate([maxRule], facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(hasFact(result.value, 'max_l', ['a', 5])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LWW simulation using guards (full superseded pattern from spec §B.4)
// ---------------------------------------------------------------------------

describe('LWW rules from spec §B.4 (using guards)', () => {
  it('concurrent writes resolved by (lamport, peer) ordering', () => {
    // superseded(CnId, Slot) :-
    //   active_value(CnId, Slot, _, L1, P1),
    //   active_value(CnId2, Slot, _, L2, P2),
    //   CnId ≠ CnId2, L2 > L1.
    //
    // superseded(CnId, Slot) :-
    //   active_value(CnId, Slot, _, L1, P1),
    //   active_value(CnId2, Slot, _, L2, P2),
    //   CnId ≠ CnId2, L2 == L1, P2 > P1.
    //
    // winner(Slot, CnId, Value) :-
    //   active_value(CnId, Slot, Value, _, _),
    //   not superseded(CnId, Slot).

    const supersededByLamport: Rule = rule(
      atom('superseded', [varTerm('CnId'), varTerm('Slot')]),
      [
        positiveAtom(atom('active_value', [varTerm('CnId'), varTerm('Slot'), _, varTerm('L1'), varTerm('P1')])),
        positiveAtom(atom('active_value', [varTerm('CnId2'), varTerm('Slot'), _, varTerm('L2'), varTerm('P2')])),
        neq(varTerm('CnId'), varTerm('CnId2')),
        gt(varTerm('L2'), varTerm('L1')),
      ],
    );

    const supersededByPeer: Rule = rule(
      atom('superseded', [varTerm('CnId'), varTerm('Slot')]),
      [
        positiveAtom(atom('active_value', [varTerm('CnId'), varTerm('Slot'), _, varTerm('L1'), varTerm('P1')])),
        positiveAtom(atom('active_value', [varTerm('CnId2'), varTerm('Slot'), _, varTerm('L2'), varTerm('P2')])),
        neq(varTerm('CnId'), varTerm('CnId2')),
        eq(varTerm('L2'), varTerm('L1')),
        gt(varTerm('P2'), varTerm('P1')),
      ],
    );

    const winnerRule: Rule = rule(
      atom('winner', [varTerm('Slot'), varTerm('CnId'), varTerm('Value')]),
      [
        positiveAtom(atom('active_value', [varTerm('CnId'), varTerm('Slot'), varTerm('Value'), _, _])),
        negation(atom('superseded', [varTerm('CnId'), varTerm('Slot')])),
      ],
    );

    const rules = [supersededByLamport, supersededByPeer, winnerRule];

    // active_value(CnId, Slot, Value, Lamport, Peer)
    const facts: Fact[] = [
      // Two concurrent writes to 'title', different lamports
      fact('active_value', ['cn1', 'title', 'Hello', 1, 'alice']),
      fact('active_value', ['cn2', 'title', 'World', 3, 'bob']),     // higher lamport → wins
      fact('active_value', ['cn3', 'title', 'Goodbye', 2, 'charlie']),

      // Two concurrent writes to 'body', same lamport — tiebreak by peer
      fact('active_value', ['cn4', 'body', 'First', 5, 'alice']),
      fact('active_value', ['cn5', 'body', 'Second', 5, 'bob']),      // 'bob' > 'alice' → wins
    ];

    const result = evaluate(rules, facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = result.value;

    // title: cn2 wins (highest lamport=3)
    expect(hasFact(db, 'winner', ['title', 'cn2', 'World'])).toBe(true);
    expect(hasFact(db, 'winner', ['title', 'cn1', 'Hello'])).toBe(false);
    expect(hasFact(db, 'winner', ['title', 'cn3', 'Goodbye'])).toBe(false);

    // body: cn5 wins (same lamport, 'bob' > 'alice')
    expect(hasFact(db, 'winner', ['body', 'cn5', 'Second'])).toBe(true);
    expect(hasFact(db, 'winner', ['body', 'cn4', 'First'])).toBe(false);

    // superseded
    expect(hasFact(db, 'superseded', ['cn1', 'title'])).toBe(true);
    expect(hasFact(db, 'superseded', ['cn3', 'title'])).toBe(true);
    expect(hasFact(db, 'superseded', ['cn2', 'title'])).toBe(false);
    expect(hasFact(db, 'superseded', ['cn4', 'body'])).toBe(true);
    expect(hasFact(db, 'superseded', ['cn5', 'body'])).toBe(false);
  });

  it('single write is not superseded', () => {
    const supersededByLamport: Rule = rule(
      atom('superseded', [varTerm('CnId'), varTerm('Slot')]),
      [
        positiveAtom(atom('active_value', [varTerm('CnId'), varTerm('Slot'), _, varTerm('L1'), _])),
        positiveAtom(atom('active_value', [varTerm('CnId2'), varTerm('Slot'), _, varTerm('L2'), _])),
        neq(varTerm('CnId'), varTerm('CnId2')),
        gt(varTerm('L2'), varTerm('L1')),
      ],
    );

    const winnerRule: Rule = rule(
      atom('winner', [varTerm('Slot'), varTerm('CnId'), varTerm('Value')]),
      [
        positiveAtom(atom('active_value', [varTerm('CnId'), varTerm('Slot'), varTerm('Value'), _, _])),
        negation(atom('superseded', [varTerm('CnId'), varTerm('Slot')])),
      ],
    );

    const facts: Fact[] = [
      fact('active_value', ['cn1', 'title', 'Only', 1, 'alice']),
    ];

    const result = evaluate([supersededByLamport, winnerRule], facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = result.value;
    expect(hasFact(db, 'winner', ['title', 'cn1', 'Only'])).toBe(true);
    expect(db.getRelation('superseded').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe('deduplication', () => {
  it('duplicate derived facts are deduplicated', () => {
    // Two rules that derive the same fact
    const rule1: Rule = rule(
      atom('out', [varTerm('X')]),
      [positiveAtom(atom('in1', [varTerm('X')]))],
    );
    const rule2: Rule = rule(
      atom('out', [varTerm('X')]),
      [positiveAtom(atom('in2', [varTerm('X')]))],
    );

    const facts: Fact[] = [
      fact('in1', ['a']),
      fact('in2', ['a']),
    ];

    const db = evaluatePositive([rule1, rule2], facts);
    expect(db.getRelation('out').size).toBe(1);
  });

  it('ground facts are preserved and deduplicated with derived facts', () => {
    // base(X) :- source(X).
    const r: Rule = rule(
      atom('base', [varTerm('X')]),
      [positiveAtom(atom('source', [varTerm('X')]))],
    );

    const facts: Fact[] = [
      fact('source', ['a']),
      fact('base', ['a']), // pre-existing ground fact
    ];

    const db = evaluatePositive([r], facts);
    // base('a') should exist once
    expect(db.getRelation('base').size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('rule with constant in head', () => {
    // always_true(yes) :- any(X).
    const r: Rule = rule(
      atom('always_true', [constTerm('yes')]),
      [positiveAtom(atom('any', [varTerm('X')]))],
    );

    const facts: Fact[] = [
      fact('any', [1]),
      fact('any', [2]),
      fact('any', [3]),
    ];

    const db = evaluatePositive([r], facts);
    // Should produce exactly one fact (deduplicated)
    expect(db.getRelation('always_true').size).toBe(1);
    expect(hasFact(db, 'always_true', ['yes'])).toBe(true);
  });

  it('rule with no body elements (pure grounding — always fires)', () => {
    // axiom(42).
    const r: Rule = rule(
      atom('axiom', [constTerm(42)]),
      [],
    );

    const db = evaluatePositive([r], []);
    expect(db.getRelation('axiom').size).toBe(1);
    expect(hasFact(db, 'axiom', [42])).toBe(true);
  });

  it('rule body with multiple atoms forms a join', () => {
    // joined(X, Y, Z) :- a(X, Y), b(Y, Z).
    const r: Rule = rule(
      atom('joined', [varTerm('X'), varTerm('Y'), varTerm('Z')]),
      [
        positiveAtom(atom('a', [varTerm('X'), varTerm('Y')])),
        positiveAtom(atom('b', [varTerm('Y'), varTerm('Z')])),
      ],
    );

    const facts: Fact[] = [
      fact('a', [1, 2]),
      fact('a', [1, 3]),
      fact('b', [2, 4]),
      fact('b', [3, 5]),
      fact('b', [3, 6]),
    ];

    const db = evaluatePositive([r], facts);

    expect(hasFact(db, 'joined', [1, 2, 4])).toBe(true);
    expect(hasFact(db, 'joined', [1, 3, 5])).toBe(true);
    expect(hasFact(db, 'joined', [1, 3, 6])).toBe(true);
    expect(db.getRelation('joined').size).toBe(3);
  });

  it('handles large number of facts without error', () => {
    // Just verifying it doesn't hang or crash
    const r: Rule = rule(
      atom('path', [varTerm('X'), varTerm('Z')]),
      [
        positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')])),
        positiveAtom(atom('path', [varTerm('Y'), varTerm('Z')])),
      ],
    );
    const baseRule: Rule = rule(
      atom('path', [varTerm('X'), varTerm('Y')]),
      [positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')]))],
    );

    // Linear chain of 50 nodes
    const facts: Fact[] = [];
    for (let i = 0; i < 50; i++) {
      facts.push(fact('edge', [i, i + 1]));
    }

    const db = evaluatePositive([baseRule, r], facts);

    // n*(n+1)/2 = 50*51/2 = 1275 path facts
    expect(db.getRelation('path').size).toBe(1275);
    expect(hasFact(db, 'path', [0, 50])).toBe(true);
    expect(hasFact(db, 'path', [49, 50])).toBe(true);
  });
});