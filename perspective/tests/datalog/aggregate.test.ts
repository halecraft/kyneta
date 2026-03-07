// === Aggregation Tests ===
// Tests for min, max, count, sum aggregation operators.
// Validates correct handling of number vs bigint types (§3).

import { describe, it, expect } from 'vitest';
import {
  atom,
  constTerm,
  varTerm,
  rule,
  fact,
  positiveAtom,
  negation,
  aggregation,
  Database,
} from '../../src/datalog/types.js';
import type { Rule, Fact, AggregationClause, Substitution, Value } from '../../src/datalog/types.js';
import { EMPTY_SUBSTITUTION, extendSubstitution } from '../../src/datalog/unify.js';
import { evaluateAggregation, evaluateAggregationForSubs } from '../../src/datalog/aggregate.js';
import { evaluate } from '../../src/datalog/evaluate.js';

// ---------------------------------------------------------------------------
// Helper: build a Database from facts
// ---------------------------------------------------------------------------

function dbFromFacts(facts: readonly Fact[]): Database {
  const db = new Database();
  for (const f of facts) {
    db.addFact(f);
  }
  return db;
}

function hasFact(db: Database, predicate: string, values: readonly unknown[]): boolean {
  return db.getRelation(predicate).has(
    values as readonly (null | boolean | number | bigint | string | Uint8Array | { readonly ref: { peer: string; counter: number } })[],
  );
}

// ---------------------------------------------------------------------------
// evaluateAggregation — unit tests
// ---------------------------------------------------------------------------

describe('evaluateAggregation', () => {
  describe('count', () => {
    it('counts tuples per group', () => {
      const agg: AggregationClause = {
        fn: 'count',
        groupBy: ['Group'],
        over: 'Item',
        result: 'Count',
        source: atom('member', [varTerm('Group'), varTerm('Item')]),
      };

      const db = dbFromFacts([
        fact('member', ['a', 1]),
        fact('member', ['a', 2]),
        fact('member', ['a', 3]),
        fact('member', ['b', 10]),
        fact('member', ['b', 20]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(2);

      const groupA = results.find((s) => s.get('Group') === 'a');
      const groupB = results.find((s) => s.get('Group') === 'b');
      expect(groupA).toBeDefined();
      expect(groupB).toBeDefined();
      expect(groupA!.get('Count')).toBe(3);
      expect(groupB!.get('Count')).toBe(2);
    });

    it('count always returns a number', () => {
      const agg: AggregationClause = {
        fn: 'count',
        groupBy: ['G'],
        over: 'V',
        result: 'C',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', 1n]),
        fact('data', ['x', 2n]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(1);
      const c = results[0]!.get('C');
      expect(typeof c).toBe('number');
      expect(c).toBe(2);
    });

    it('count with a single group', () => {
      const agg: AggregationClause = {
        fn: 'count',
        groupBy: ['G'],
        over: 'V',
        result: 'C',
        source: atom('items', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('items', ['only', 'a']),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(1);
      expect(results[0]!.get('C')).toBe(1);
    });

    it('count with no matching tuples returns no groups', () => {
      const agg: AggregationClause = {
        fn: 'count',
        groupBy: ['G'],
        over: 'V',
        result: 'C',
        source: atom('empty', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(0);
    });

    it('count with non-numeric values', () => {
      const agg: AggregationClause = {
        fn: 'count',
        groupBy: ['G'],
        over: 'V',
        result: 'C',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['g1', 'hello']),
        fact('data', ['g1', 'world']),
        fact('data', ['g1', null]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(1);
      expect(results[0]!.get('C')).toBe(3);
    });
  });

  describe('sum', () => {
    it('sums numbers', () => {
      const agg: AggregationClause = {
        fn: 'sum',
        groupBy: ['Category'],
        over: 'Amount',
        result: 'Total',
        source: atom('expense', [varTerm('Category'), varTerm('Amount')]),
      };

      const db = dbFromFacts([
        fact('expense', ['food', 10]),
        fact('expense', ['food', 20]),
        fact('expense', ['food', 30]),
        fact('expense', ['transport', 50]),
        fact('expense', ['transport', 25]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(2);

      const food = results.find((s) => s.get('Category') === 'food');
      const transport = results.find((s) => s.get('Category') === 'transport');
      expect(food!.get('Total')).toBe(60);
      expect(transport!.get('Total')).toBe(75);
    });

    it('sum of numbers returns number', () => {
      const agg: AggregationClause = {
        fn: 'sum',
        groupBy: ['G'],
        over: 'V',
        result: 'S',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', 1.5]),
        fact('data', ['x', 2.5]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(1);
      const s = results[0]!.get('S');
      expect(typeof s).toBe('number');
      expect(s).toBe(4);
    });

    it('sum of bigints returns bigint', () => {
      const agg: AggregationClause = {
        fn: 'sum',
        groupBy: ['G'],
        over: 'V',
        result: 'S',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', 100n]),
        fact('data', ['x', 200n]),
        fact('data', ['x', 300n]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(1);
      const s = results[0]!.get('S');
      expect(typeof s).toBe('bigint');
      expect(s).toBe(600n);
    });

    it('mixed number/bigint sum is a type error (skips group)', () => {
      const agg: AggregationClause = {
        fn: 'sum',
        groupBy: ['G'],
        over: 'V',
        result: 'S',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', 1]),   // number
        fact('data', ['x', 2n]),  // bigint — type conflict!
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      // Mixed types → type error → group is skipped
      expect(results.length).toBe(0);
    });

    it('sum of non-numeric values is a type error', () => {
      const agg: AggregationClause = {
        fn: 'sum',
        groupBy: ['G'],
        over: 'V',
        result: 'S',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', 'hello']),
        fact('data', ['x', 'world']),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(0);
    });

    it('sum with empty group returns 0', () => {
      const agg: AggregationClause = {
        fn: 'sum',
        groupBy: ['G'],
        over: 'V',
        result: 'S',
        source: atom('empty', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(0); // no groups at all
    });

    it('sum with negative numbers', () => {
      const agg: AggregationClause = {
        fn: 'sum',
        groupBy: ['G'],
        over: 'V',
        result: 'S',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', -10]),
        fact('data', ['x', 5]),
        fact('data', ['x', -3]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(1);
      expect(results[0]!.get('S')).toBe(-8);
    });
  });

  describe('max', () => {
    it('selects maximum number per group', () => {
      const agg: AggregationClause = {
        fn: 'max',
        groupBy: ['Slot'],
        over: 'Lamport',
        result: 'MaxL',
        source: atom('vals', [varTerm('Slot'), varTerm('Lamport')]),
      };

      const db = dbFromFacts([
        fact('vals', ['title', 1]),
        fact('vals', ['title', 5]),
        fact('vals', ['title', 3]),
        fact('vals', ['body', 2]),
        fact('vals', ['body', 8]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(2);

      const title = results.find((s) => s.get('Slot') === 'title');
      const body = results.find((s) => s.get('Slot') === 'body');
      expect(title!.get('MaxL')).toBe(5);
      expect(body!.get('MaxL')).toBe(8);
    });

    it('selects maximum bigint per group', () => {
      const agg: AggregationClause = {
        fn: 'max',
        groupBy: ['G'],
        over: 'V',
        result: 'M',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', 100n]),
        fact('data', ['x', 999n]),
        fact('data', ['x', 50n]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(1);
      expect(results[0]!.get('M')).toBe(999n);
    });

    it('selects maximum string per group', () => {
      const agg: AggregationClause = {
        fn: 'max',
        groupBy: ['G'],
        over: 'V',
        result: 'M',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', 'apple']),
        fact('data', ['x', 'cherry']),
        fact('data', ['x', 'banana']),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(1);
      expect(results[0]!.get('M')).toBe('cherry');
    });

    it('max with mixed number/bigint is a type error', () => {
      const agg: AggregationClause = {
        fn: 'max',
        groupBy: ['G'],
        over: 'V',
        result: 'M',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', 3]),
        fact('data', ['x', 5n]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(0);
    });

    it('max with single element returns that element', () => {
      const agg: AggregationClause = {
        fn: 'max',
        groupBy: ['G'],
        over: 'V',
        result: 'M',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', 42]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(1);
      expect(results[0]!.get('M')).toBe(42);
    });

    it('max with no matching tuples returns no groups', () => {
      const agg: AggregationClause = {
        fn: 'max',
        groupBy: ['G'],
        over: 'V',
        result: 'M',
        source: atom('empty', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(0);
    });

    it('max with negative numbers', () => {
      const agg: AggregationClause = {
        fn: 'max',
        groupBy: ['G'],
        over: 'V',
        result: 'M',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', -10]),
        fact('data', ['x', -5]),
        fact('data', ['x', -20]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(1);
      expect(results[0]!.get('M')).toBe(-5);
    });
  });

  describe('min', () => {
    it('selects minimum number per group', () => {
      const agg: AggregationClause = {
        fn: 'min',
        groupBy: ['Group'],
        over: 'Val',
        result: 'MinVal',
        source: atom('data', [varTerm('Group'), varTerm('Val')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', 30]),
        fact('data', ['x', 10]),
        fact('data', ['x', 20]),
        fact('data', ['y', 5]),
        fact('data', ['y', 15]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(2);

      const x = results.find((s) => s.get('Group') === 'x');
      const y = results.find((s) => s.get('Group') === 'y');
      expect(x!.get('MinVal')).toBe(10);
      expect(y!.get('MinVal')).toBe(5);
    });

    it('selects minimum bigint per group', () => {
      const agg: AggregationClause = {
        fn: 'min',
        groupBy: ['G'],
        over: 'V',
        result: 'M',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', 100n]),
        fact('data', ['x', 50n]),
        fact('data', ['x', 200n]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(1);
      expect(results[0]!.get('M')).toBe(50n);
    });

    it('selects minimum string per group', () => {
      const agg: AggregationClause = {
        fn: 'min',
        groupBy: ['G'],
        over: 'V',
        result: 'M',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', 'cherry']),
        fact('data', ['x', 'apple']),
        fact('data', ['x', 'banana']),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(1);
      expect(results[0]!.get('M')).toBe('apple');
    });

    it('min with mixed number/bigint is a type error', () => {
      const agg: AggregationClause = {
        fn: 'min',
        groupBy: ['G'],
        over: 'V',
        result: 'M',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', 3]),
        fact('data', ['x', 5n]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(0);
    });

    it('min with single element returns that element', () => {
      const agg: AggregationClause = {
        fn: 'min',
        groupBy: ['G'],
        over: 'V',
        result: 'M',
        source: atom('data', [varTerm('G'), varTerm('V')]),
      };

      const db = dbFromFacts([
        fact('data', ['x', 77]),
      ]);

      const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
      expect(results.length).toBe(1);
      expect(results[0]!.get('M')).toBe(77);
    });
  });
});

// ---------------------------------------------------------------------------
// evaluateAggregationForSubs
// ---------------------------------------------------------------------------

describe('evaluateAggregationForSubs', () => {
  it('extends multiple base substitutions', () => {
    const agg: AggregationClause = {
      fn: 'count',
      groupBy: ['G'],
      over: 'V',
      result: 'C',
      source: atom('member', [varTerm('G'), varTerm('V')]),
    };

    const db = dbFromFacts([
      fact('member', ['a', 1]),
      fact('member', ['a', 2]),
      fact('member', ['b', 10]),
    ]);

    // Two base substitutions — neither constrains groupBy variable G
    const sub1 = extendSubstitution(EMPTY_SUBSTITUTION, 'Extra', 'val1');
    const sub2 = extendSubstitution(EMPTY_SUBSTITUTION, 'Extra', 'val2');

    const results = evaluateAggregationForSubs(agg, db, [sub1, sub2]);

    // Each base sub should produce 2 groups (a, b) → 4 total
    expect(results.length).toBe(4);
  });

  it('respects pre-bound groupBy variables in base sub', () => {
    const agg: AggregationClause = {
      fn: 'sum',
      groupBy: ['G'],
      over: 'V',
      result: 'S',
      source: atom('data', [varTerm('G'), varTerm('V')]),
    };

    const db = dbFromFacts([
      fact('data', ['a', 10]),
      fact('data', ['a', 20]),
      fact('data', ['b', 100]),
      fact('data', ['b', 200]),
    ]);

    // Pre-bind G to 'a' — should only aggregate group 'a'
    const sub = extendSubstitution(EMPTY_SUBSTITUTION, 'G', 'a');

    const results = evaluateAggregationForSubs(agg, db, [sub]);
    expect(results.length).toBe(1);
    expect(results[0]!.get('G')).toBe('a');
    expect(results[0]!.get('S')).toBe(30);
  });

  it('returns empty for empty substitution list', () => {
    const agg: AggregationClause = {
      fn: 'count',
      groupBy: ['G'],
      over: 'V',
      result: 'C',
      source: atom('data', [varTerm('G'), varTerm('V')]),
    };

    const db = dbFromFacts([
      fact('data', ['x', 1]),
    ]);

    const results = evaluateAggregationForSubs(agg, db, []);
    expect(results.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple groupBy variables
// ---------------------------------------------------------------------------

describe('multiple groupBy variables', () => {
  it('groups by two variables', () => {
    const agg: AggregationClause = {
      fn: 'sum',
      groupBy: ['A', 'B'],
      over: 'V',
      result: 'S',
      source: atom('data', [varTerm('A'), varTerm('B'), varTerm('V')]),
    };

    const db = dbFromFacts([
      fact('data', ['x', 'p', 1]),
      fact('data', ['x', 'p', 2]),
      fact('data', ['x', 'q', 10]),
      fact('data', ['y', 'p', 100]),
    ]);

    const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
    expect(results.length).toBe(3);

    const xp = results.find((s) => s.get('A') === 'x' && s.get('B') === 'p');
    const xq = results.find((s) => s.get('A') === 'x' && s.get('B') === 'q');
    const yp = results.find((s) => s.get('A') === 'y' && s.get('B') === 'p');
    expect(xp!.get('S')).toBe(3);
    expect(xq!.get('S')).toBe(10);
    expect(yp!.get('S')).toBe(100);
  });

  it('groups by zero variables (global aggregate)', () => {
    const agg: AggregationClause = {
      fn: 'count',
      groupBy: [],
      over: 'V',
      result: 'C',
      source: atom('data', [varTerm('V')]),
    };

    const db = dbFromFacts([
      fact('data', [1]),
      fact('data', [2]),
      fact('data', [3]),
      fact('data', [4]),
      fact('data', [5]),
    ]);

    const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
    // Single group (no groupBy variables → one global group)
    expect(results.length).toBe(1);
    expect(results[0]!.get('C')).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Integration: aggregation in full evaluation via evaluate()
// ---------------------------------------------------------------------------

describe('aggregation in full evaluation', () => {
  it('max aggregation produces LWW winner via evaluate()', () => {
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

    const maxRule: Rule = rule(
      atom('max_lamport', [varTerm('Slot'), varTerm('MaxL')]),
      [aggregation(aggClause)],
    );

    const winnerRule: Rule = rule(
      atom('winner', [varTerm('Slot'), varTerm('CnId'), varTerm('Value')]),
      [
        positiveAtom(atom('active_value', [varTerm('CnId'), varTerm('Slot'), varTerm('Value'), varTerm('Lamport')])),
        positiveAtom(atom('max_lamport', [varTerm('Slot'), varTerm('Lamport')])),
      ],
    );

    const facts: Fact[] = [
      fact('active_value', ['cn1', 'title', 'Hello', 1]),
      fact('active_value', ['cn2', 'title', 'World', 3]),
      fact('active_value', ['cn3', 'title', 'Goodbye', 2]),
      fact('active_value', ['cn4', 'body', 'First', 1]),
      fact('active_value', ['cn5', 'body', 'Second', 5]),
    ];

    const result = evaluate([maxRule, winnerRule], facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = result.value;

    expect(hasFact(db, 'max_lamport', ['title', 3])).toBe(true);
    expect(hasFact(db, 'max_lamport', ['body', 5])).toBe(true);
    expect(hasFact(db, 'winner', ['title', 'cn2', 'World'])).toBe(true);
    expect(hasFact(db, 'winner', ['body', 'cn5', 'Second'])).toBe(true);
    expect(hasFact(db, 'winner', ['title', 'cn1', 'Hello'])).toBe(false);
    expect(hasFact(db, 'winner', ['title', 'cn3', 'Goodbye'])).toBe(false);
  });

  it('sum aggregation via evaluate()', () => {
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

  it('min aggregation via evaluate()', () => {
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

  it('count aggregation via evaluate()', () => {
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

  it('aggregation combined with positive body atoms', () => {
    // active(CnId, Slot, Value, Lamport) :- raw(CnId, Slot, Value, Lamport), not retracted(CnId).
    // max_l(Slot, MaxL) :- max<Lamport> over active(_, Slot, _, Lamport) group_by [Slot].
    //
    // This tests aggregation over a derived predicate with negation
    // in a lower stratum.

    const activeRule: Rule = rule(
      atom('active', [varTerm('CnId'), varTerm('Slot'), varTerm('Value'), varTerm('Lamport')]),
      [
        positiveAtom(atom('raw', [varTerm('CnId'), varTerm('Slot'), varTerm('Value'), varTerm('Lamport')])),
        negation(atom('retracted', [varTerm('CnId')])),
      ],
    );

    const aggClause: AggregationClause = {
      fn: 'max',
      groupBy: ['Slot'],
      over: 'Lamport',
      result: 'MaxL',
      source: atom('active', [
        varTerm('_CnId'),
        varTerm('Slot'),
        varTerm('_Value'),
        varTerm('Lamport'),
      ]),
    };

    const maxRule: Rule = rule(
      atom('max_l', [varTerm('Slot'), varTerm('MaxL')]),
      [aggregation(aggClause)],
    );

    const facts: Fact[] = [
      fact('raw', ['cn1', 'title', 'A', 1]),
      fact('raw', ['cn2', 'title', 'B', 5]),
      fact('raw', ['cn3', 'title', 'C', 3]),
      fact('retracted', ['cn2']),  // cn2 is retracted, so B (lamport 5) is gone
    ];

    const result = evaluate([activeRule, maxRule], facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = result.value;

    // active should have cn1 and cn3 (cn2 is retracted)
    expect(hasFact(db, 'active', ['cn1', 'title', 'A', 1])).toBe(true);
    expect(hasFact(db, 'active', ['cn3', 'title', 'C', 3])).toBe(true);
    expect(hasFact(db, 'active', ['cn2', 'title', 'B', 5])).toBe(false);

    // max lamport for title should be 3 (from cn3), not 5 (cn2 retracted)
    expect(hasFact(db, 'max_l', ['title', 3])).toBe(true);
  });

  it('aggregation over empty derived relation produces no groups', () => {
    const aggClause: AggregationClause = {
      fn: 'count',
      groupBy: ['G'],
      over: 'V',
      result: 'C',
      source: atom('derived', [varTerm('G'), varTerm('V')]),
    };

    const countRule: Rule = rule(
      atom('result', [varTerm('G'), varTerm('C')]),
      [aggregation(aggClause)],
    );

    // derived has a rule but no matching input facts
    const derivedRule: Rule = rule(
      atom('derived', [varTerm('G'), varTerm('V')]),
      [positiveAtom(atom('source', [varTerm('G'), varTerm('V')]))],
    );

    const result = evaluate([derivedRule, countRule], []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const db = result.value;
    expect(db.getRelation('result').size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('aggregation edge cases', () => {
  it('aggregation with constant in source atom', () => {
    // Only aggregate items from group "special"
    const agg: AggregationClause = {
      fn: 'sum',
      groupBy: [],
      over: 'V',
      result: 'S',
      source: atom('data', [constTerm('special'), varTerm('V')]),
    };

    const db = dbFromFacts([
      fact('data', ['special', 10]),
      fact('data', ['special', 20]),
      fact('data', ['other', 100]),
      fact('data', ['other', 200]),
    ]);

    const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
    expect(results.length).toBe(1);
    expect(results[0]!.get('S')).toBe(30);
  });

  it('aggregation with duplicate over values counts each occurrence', () => {
    const agg: AggregationClause = {
      fn: 'count',
      groupBy: ['G'],
      over: 'V',
      result: 'C',
      source: atom('data', [varTerm('G'), varTerm('V')]),
    };

    // Note: facts are deduplicated, so ('x', 1) appears once
    const db = dbFromFacts([
      fact('data', ['x', 1]),
      fact('data', ['x', 1]),  // duplicate — will be deduped by Relation
      fact('data', ['x', 2]),
    ]);

    const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
    expect(results.length).toBe(1);
    // Only 2 unique tuples match, not 3
    expect(results[0]!.get('C')).toBe(2);
  });

  it('sum aggregation with all zeros', () => {
    const agg: AggregationClause = {
      fn: 'sum',
      groupBy: ['G'],
      over: 'V',
      result: 'S',
      source: atom('data', [varTerm('G'), varTerm('V')]),
    };

    const db = dbFromFacts([
      fact('data', ['x', 0]),
      fact('data', ['y', 0]),
    ]);

    const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
    // Each group has sum 0, but note ('x', 0) is group x and ('y', 0) is group y
    expect(results.length).toBe(2);
    const x = results.find((s) => s.get('G') === 'x');
    const y = results.find((s) => s.get('G') === 'y');
    expect(x!.get('S')).toBe(0);
    expect(y!.get('S')).toBe(0);
  });

  it('max over booleans (false < true)', () => {
    const agg: AggregationClause = {
      fn: 'max',
      groupBy: ['G'],
      over: 'V',
      result: 'M',
      source: atom('data', [varTerm('G'), varTerm('V')]),
    };

    const db = dbFromFacts([
      fact('data', ['x', false]),
      fact('data', ['x', true]),
    ]);

    const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
    expect(results.length).toBe(1);
    expect(results[0]!.get('M')).toBe(true);
  });

  it('min over booleans (false < true)', () => {
    const agg: AggregationClause = {
      fn: 'min',
      groupBy: ['G'],
      over: 'V',
      result: 'M',
      source: atom('data', [varTerm('G'), varTerm('V')]),
    };

    const db = dbFromFacts([
      fact('data', ['x', false]),
      fact('data', ['x', true]),
    ]);

    const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
    expect(results.length).toBe(1);
    expect(results[0]!.get('M')).toBe(false);
  });

  it('sum of bigint zero values', () => {
    const agg: AggregationClause = {
      fn: 'sum',
      groupBy: ['G'],
      over: 'V',
      result: 'S',
      source: atom('data', [varTerm('G'), varTerm('V')]),
    };

    const db = dbFromFacts([
      fact('data', ['x', 0n]),
      fact('data', ['x', 0n]), // deduped
    ]);

    const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
    expect(results.length).toBe(1);
    const s = results[0]!.get('S');
    expect(typeof s).toBe('bigint');
    expect(s).toBe(0n);
  });

  it('aggregation with many groups', () => {
    const agg: AggregationClause = {
      fn: 'count',
      groupBy: ['G'],
      over: 'V',
      result: 'C',
      source: atom('data', [varTerm('G'), varTerm('V')]),
    };

    const facts: Fact[] = [];
    for (let i = 0; i < 100; i++) {
      facts.push(fact('data', [`group_${i}`, i]));
      facts.push(fact('data', [`group_${i}`, i + 1000]));
    }

    const db = dbFromFacts(facts);
    const results = evaluateAggregation(agg, db, EMPTY_SUBSTITUTION);
    expect(results.length).toBe(100);

    // Each group should have count 2
    for (const r of results) {
      expect(r.get('C')).toBe(2);
    }
  });
});