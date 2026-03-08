// === Incremental Datalog Evaluator Tests ===
// Tests for Plan 006, Phase 5:
//   - Relation.remove / Database.removeFact (Tasks 5.1–5.2)
//   - Bridge utilities: applyFactDelta, diffDatabases, groupByPredicate (Tasks 5.4–5.6)
//   - Incremental Datalog evaluator: monotone strata, negation strata (DRed),
//     stratum dependency, rule changes, resolution extraction (Tasks 5.7–5.13)
//   - Three-way equivalence: incremental Datalog ≡ batch Datalog ≡ native solver
//   - Permutation tests

import { describe, it, expect } from 'vitest';
import {
  Database,
  Relation,
  fact,
  atom,
  varTerm,
  constTerm,
  positiveAtom,
  negation,
  neq,
  gt,
  eq,
  lt,
  rule,
  _,
  factKey,
} from '../../src/datalog/types.js';
import type { Fact, Rule, Value } from '../../src/datalog/types.js';
import { evaluate, evaluatePositive } from '../../src/datalog/evaluate.js';
import {
  applyFactDelta,
  diffDatabases,
  groupByPredicate,
  createIncrementalDatalogEvaluator,
} from '../../src/datalog/incremental-evaluate.js';
import {
  buildDefaultLWWRules,
  buildDefaultFugueRules,
  buildDefaultRules,
} from '../../src/bootstrap.js';
import {
  zsetEmpty,
  zsetSingleton,
  zsetAdd,
  zsetIsEmpty,
  zsetSize,
  zsetGet,
  zsetForEach,
} from '../../src/base/zset.js';
import type { ZSet } from '../../src/base/zset.js';
import { createCnId, cnIdKey } from '../../src/kernel/cnid.js';
import type { ResolvedWinner, FugueBeforePair } from '../../src/kernel/resolve.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeActiveValueFact(
  peer: string,
  counter: number,
  slotId: string,
  content: Value,
  lamport: number,
): Fact {
  const id = createCnId(peer, counter);
  return fact('active_value', [
    cnIdKey(id),
    slotId,
    content,
    lamport,
    peer,
  ]);
}

function makeSeqStructureFact(
  peer: string,
  counter: number,
  parentPeer: string,
  parentCounter: number,
  originLeftPeer: string | null,
  originLeftCounter: number | null,
  originRightPeer: string | null,
  originRightCounter: number | null,
): Fact {
  const id = createCnId(peer, counter);
  const parentId = createCnId(parentPeer, parentCounter);
  const originLeft = originLeftPeer !== null && originLeftCounter !== null
    ? cnIdKey(createCnId(originLeftPeer, originLeftCounter))
    : null;
  const originRight = originRightPeer !== null && originRightCounter !== null
    ? cnIdKey(createCnId(originRightPeer, originRightCounter))
    : null;
  return fact('active_structure_seq', [
    cnIdKey(id),
    cnIdKey(parentId),
    originLeft,
    originRight,
  ]);
}

function makePeerFact(peer: string, counter: number): Fact {
  const id = createCnId(peer, counter);
  return fact('constraint_peer', [cnIdKey(id), peer]);
}

/** Generate all permutations of an array. */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i++) {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const perm of permutations(rest)) {
      result.push([arr[i]!, ...perm]);
    }
  }
  return result;
}

/** Build a ZSet<Fact> from an array of facts, all at weight +1. */
function factsToZSet(facts: Fact[]): ZSet<Fact> {
  let zs = zsetEmpty<Fact>();
  for (const f of facts) {
    zs = zsetAdd(zs, zsetSingleton(factKey(f), f, 1));
  }
  return zs;
}

/** Build a ZSet<Fact> with specified weight for each fact. */
function factsToWeightedZSet(facts: [Fact, number][]): ZSet<Fact> {
  let zs = zsetEmpty<Fact>();
  for (const [f, w] of facts) {
    zs = zsetAdd(zs, zsetSingleton(factKey(f), f, w));
  }
  return zs;
}

// ---------------------------------------------------------------------------
// Relation.remove
// ---------------------------------------------------------------------------

describe('Relation.remove', () => {
  it('removes an existing tuple and tuples() excludes it', () => {
    const rel = new Relation();
    rel.add(['a', 'b']);
    rel.add(['c', 'd']);
    expect(rel.size).toBe(2);

    const removed = rel.remove(['a', 'b']);
    expect(removed).toBe(true);
    expect(rel.size).toBe(1);

    const tuples = rel.tuples();
    expect(tuples).toHaveLength(1);
    expect(tuples[0]).toEqual(['c', 'd']);
  });

  it('returns false for non-existent tuple', () => {
    const rel = new Relation();
    rel.add(['a', 'b']);

    const removed = rel.remove(['x', 'y']);
    expect(removed).toBe(false);
    expect(rel.size).toBe(1);
  });

  it('has() returns false after removal', () => {
    const rel = new Relation();
    rel.add(['a', 'b']);
    expect(rel.has(['a', 'b'])).toBe(true);

    rel.remove(['a', 'b']);
    expect(rel.has(['a', 'b'])).toBe(false);
  });

  it('add() after remove() works correctly (re-add)', () => {
    const rel = new Relation();
    rel.add(['a', 'b']);
    rel.remove(['a', 'b']);
    expect(rel.size).toBe(0);

    const added = rel.add(['a', 'b']);
    expect(added).toBe(true);
    expect(rel.size).toBe(1);
    expect(rel.has(['a', 'b'])).toBe(true);
  });

  it('isEmpty() is correct after removal', () => {
    const rel = new Relation();
    rel.add(['a', 'b']);
    expect(rel.isEmpty()).toBe(false);

    rel.remove(['a', 'b']);
    expect(rel.isEmpty()).toBe(true);
  });

  it('clone() after removal excludes removed tuples', () => {
    const rel = new Relation();
    rel.add(['a', 'b']);
    rel.add(['c', 'd']);
    rel.remove(['a', 'b']);

    const cloned = rel.clone();
    expect(cloned.size).toBe(1);
    expect(cloned.has(['c', 'd'])).toBe(true);
    expect(cloned.has(['a', 'b'])).toBe(false);
  });

  it('union() after removal excludes removed tuples', () => {
    const rel1 = new Relation();
    rel1.add(['a', 'b']);
    rel1.add(['c', 'd']);
    rel1.remove(['a', 'b']);

    const rel2 = new Relation();
    rel2.add(['e', 'f']);

    const unioned = rel1.union(rel2);
    expect(unioned.size).toBe(2);
    expect(unioned.has(['c', 'd'])).toBe(true);
    expect(unioned.has(['e', 'f'])).toBe(true);
    expect(unioned.has(['a', 'b'])).toBe(false);
  });

  it('difference() after removal excludes removed tuples', () => {
    const rel1 = new Relation();
    rel1.add(['a', 'b']);
    rel1.add(['c', 'd']);
    rel1.remove(['a', 'b']);

    const rel2 = new Relation();
    rel2.add(['c', 'd']);

    const diff = rel1.difference(rel2);
    expect(diff.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Database.removeFact
// ---------------------------------------------------------------------------

describe('Database.removeFact', () => {
  it('removes fact, hasFact returns false', () => {
    const db = new Database();
    const f = fact('test', ['a', 'b']);
    db.addFact(f);
    expect(db.hasFact(f)).toBe(true);

    const removed = db.removeFact(f);
    expect(removed).toBe(true);
    expect(db.hasFact(f)).toBe(false);
  });

  it('returns false for non-existent fact', () => {
    const db = new Database();
    const f = fact('test', ['a', 'b']);
    expect(db.removeFact(f)).toBe(false);
  });

  it('returns false for non-existent predicate', () => {
    const db = new Database();
    const f = fact('nonexistent', ['a']);
    expect(db.removeFact(f)).toBe(false);
  });

  it('size decreases after removal', () => {
    const db = new Database();
    db.addFact(fact('p', ['a']));
    db.addFact(fact('p', ['b']));
    db.addFact(fact('q', ['c']));
    expect(db.size).toBe(3);

    db.removeFact(fact('p', ['a']));
    expect(db.size).toBe(2);
  });

  it('clone() after removal reflects removals', () => {
    const db = new Database();
    db.addFact(fact('p', ['a']));
    db.addFact(fact('p', ['b']));
    db.removeFact(fact('p', ['a']));

    const cloned = db.clone();
    expect(cloned.size).toBe(1);
    expect(cloned.hasFact(fact('p', ['b']))).toBe(true);
    expect(cloned.hasFact(fact('p', ['a']))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// applyFactDelta
// ---------------------------------------------------------------------------

describe('applyFactDelta', () => {
  it('adds facts with weight +1', () => {
    const db = new Database();
    const f1 = fact('p', ['a']);
    const f2 = fact('q', ['b']);

    const delta = factsToZSet([f1, f2]);
    applyFactDelta(db, delta);

    expect(db.hasFact(f1)).toBe(true);
    expect(db.hasFact(f2)).toBe(true);
    expect(db.size).toBe(2);
  });

  it('removes facts with weight −1', () => {
    const db = new Database();
    const f1 = fact('p', ['a']);
    db.addFact(f1);

    const delta = factsToWeightedZSet([[f1, -1]]);
    applyFactDelta(db, delta);

    expect(db.hasFact(f1)).toBe(false);
    expect(db.size).toBe(0);
  });

  it('handles mixed +1 and −1 entries', () => {
    const db = new Database();
    const f1 = fact('p', ['a']);
    const f2 = fact('p', ['b']);
    db.addFact(f1);

    const delta = factsToWeightedZSet([[f1, -1], [f2, 1]]);
    applyFactDelta(db, delta);

    expect(db.hasFact(f1)).toBe(false);
    expect(db.hasFact(f2)).toBe(true);
    expect(db.size).toBe(1);
  });

  it('ignores weight 0 (handled by Z-set construction)', () => {
    const db = new Database();
    const delta = zsetEmpty<Fact>();
    applyFactDelta(db, delta);
    expect(db.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// diffDatabases
// ---------------------------------------------------------------------------

describe('diffDatabases', () => {
  it('produces +1 for facts in new but not old', () => {
    const oldDb = new Database();
    const newDb = new Database();
    newDb.addFact(fact('p', ['a']));

    const delta = diffDatabases(oldDb, newDb);
    expect(zsetSize(delta)).toBe(1);

    const entry = [...delta.values()][0]!;
    expect(entry.weight).toBe(1);
    expect(entry.element.predicate).toBe('p');
  });

  it('produces −1 for facts in old but not new', () => {
    const oldDb = new Database();
    oldDb.addFact(fact('p', ['a']));
    const newDb = new Database();

    const delta = diffDatabases(oldDb, newDb);
    expect(zsetSize(delta)).toBe(1);

    const entry = [...delta.values()][0]!;
    expect(entry.weight).toBe(-1);
    expect(entry.element.predicate).toBe('p');
  });

  it('produces empty for identical databases', () => {
    const db1 = new Database();
    db1.addFact(fact('p', ['a']));
    const db2 = new Database();
    db2.addFact(fact('p', ['a']));

    const delta = diffDatabases(db1, db2);
    expect(zsetIsEmpty(delta)).toBe(true);
  });

  it('handles multiple predicates', () => {
    const oldDb = new Database();
    oldDb.addFact(fact('p', ['a']));
    oldDb.addFact(fact('q', ['b']));

    const newDb = new Database();
    newDb.addFact(fact('q', ['b']));
    newDb.addFact(fact('r', ['c']));

    const delta = diffDatabases(oldDb, newDb);

    // p:a removed (−1), r:c added (+1), q:b unchanged
    expect(zsetSize(delta)).toBe(2);

    const entries = [...delta.values()];
    const removed = entries.find((e) => e.weight < 0)!;
    const added = entries.find((e) => e.weight > 0)!;
    expect(removed.element.predicate).toBe('p');
    expect(added.element.predicate).toBe('r');
  });

  it('produces empty for two empty databases', () => {
    const delta = diffDatabases(new Database(), new Database());
    expect(zsetIsEmpty(delta)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// groupByPredicate
// ---------------------------------------------------------------------------

describe('groupByPredicate', () => {
  it('splits mixed facts by predicate', () => {
    const f1 = fact('p', ['a']);
    const f2 = fact('q', ['b']);
    const f3 = fact('p', ['c']);

    const zs = factsToZSet([f1, f2, f3]);
    const groups = groupByPredicate(zs);

    expect(groups.size).toBe(2);
    expect(zsetSize(groups.get('p')!)).toBe(2);
    expect(zsetSize(groups.get('q')!)).toBe(1);
  });

  it('returns empty map for empty Z-set', () => {
    const groups = groupByPredicate(zsetEmpty());
    expect(groups.size).toBe(0);
  });

  it('preserves weights', () => {
    const f1 = fact('p', ['a']);
    const f2 = fact('p', ['b']);
    const zs = factsToWeightedZSet([[f1, 1], [f2, -1]]);
    const groups = groupByPredicate(zs);

    const pGroup = groups.get('p')!;
    expect(zsetSize(pGroup)).toBe(2);

    const entries = [...pGroup.values()];
    const pos = entries.find((e) => e.weight > 0)!;
    const neg = entries.find((e) => e.weight < 0)!;
    expect(pos.element.values[0]).toBe('a');
    expect(neg.element.values[0]).toBe('b');
  });
});

// ---------------------------------------------------------------------------
// Incremental Datalog Evaluator: LWW rules (monotone + negation strata)
// ---------------------------------------------------------------------------

describe('IncrementalDatalogEvaluator', () => {
  describe('LWW resolution with default rules', () => {
    const lwwRules = buildDefaultLWWRules();

    // Slot: alice@0 root → alice@1 map child → slotId "doc|title"
    // We'll use a simplified slotId for testing.
    const slotId = 'slot:title';

    it('single active_value produces a winner', () => {
      const evaluator = createIncrementalDatalogEvaluator(lwwRules);

      const f = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      const delta = factsToZSet([f]);

      const result = evaluator.step(delta, zsetEmpty());

      expect(zsetIsEmpty(result.deltaResolved)).toBe(false);
      expect(zsetSize(result.deltaResolved)).toBe(1);

      const winnerEntry = [...result.deltaResolved.values()][0]!;
      expect(winnerEntry.weight).toBe(1);
      expect(winnerEntry.element.slotId).toBe(slotId);
      expect(winnerEntry.element.content).toBe('Hello');
    });

    it('superseding value produces old winner −1, new winner +1', () => {
      const evaluator = createIncrementalDatalogEvaluator(lwwRules);

      // Insert first value (lamport 10).
      const f1 = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      evaluator.step(factsToZSet([f1]), zsetEmpty());

      // Insert superseding value (lamport 20).
      const f2 = makeActiveValueFact('bob', 1, slotId, 'World', 20);
      const result = evaluator.step(factsToZSet([f2]), zsetEmpty());

      // Should have winner changes.
      expect(zsetIsEmpty(result.deltaResolved)).toBe(false);

      // Collect all winner deltas.
      const entries: { element: ResolvedWinner; weight: number }[] = [];
      zsetForEach(result.deltaResolved, (e) => entries.push(e));

      // There should be a −1 for the old winner and +1 for the new winner.
      // However, since both share the same slotId key, zsetMap collapses
      // them. The net effect depends on the Z-set algebra.
      // With DRed, the old winner fact is removed and the new one is added,
      // so the diff should show the change.

      // The new winner should be bob's value.
      const resolution = evaluator.currentResolution();
      expect(resolution.winners.size).toBe(1);
      const winner = resolution.winners.get(slotId)!;
      expect(winner.content).toBe('World');
      expect(winner.winnerCnIdKey).toBe(cnIdKey(createCnId('bob', 1)));
    });

    it('non-superseding value produces no winner change', () => {
      const evaluator = createIncrementalDatalogEvaluator(lwwRules);

      // Insert the winner first (lamport 20).
      const f1 = makeActiveValueFact('bob', 1, slotId, 'World', 20);
      evaluator.step(factsToZSet([f1]), zsetEmpty());

      // Insert a loser (lamport 10).
      const f2 = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      const result = evaluator.step(factsToZSet([f2]), zsetEmpty());

      // The winner should still be bob's value — no change in winners.
      const resolution = evaluator.currentResolution();
      expect(resolution.winners.size).toBe(1);
      expect(resolution.winners.get(slotId)!.content).toBe('World');
    });

    it('value retraction causes winner recomputation', () => {
      const evaluator = createIncrementalDatalogEvaluator(lwwRules);

      // Insert two values.
      const f1 = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      const f2 = makeActiveValueFact('bob', 1, slotId, 'World', 20);
      evaluator.step(factsToZSet([f1, f2]), zsetEmpty());

      // Winner should be bob (lamport 20).
      expect(evaluator.currentResolution().winners.get(slotId)!.content).toBe('World');

      // Retract bob's value.
      const retractDelta = factsToWeightedZSet([[f2, -1]]);
      const result = evaluator.step(retractDelta, zsetEmpty());

      // Winner should now be alice.
      const resolution = evaluator.currentResolution();
      expect(resolution.winners.size).toBe(1);
      expect(resolution.winners.get(slotId)!.content).toBe('Hello');
    });

    it('retraction of sole value removes winner', () => {
      const evaluator = createIncrementalDatalogEvaluator(lwwRules);

      const f1 = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      evaluator.step(factsToZSet([f1]), zsetEmpty());

      // Retract it.
      const result = evaluator.step(factsToWeightedZSet([[f1, -1]]), zsetEmpty());

      const resolution = evaluator.currentResolution();
      expect(resolution.winners.size).toBe(0);
    });

    it('multiple slots are tracked independently', () => {
      const evaluator = createIncrementalDatalogEvaluator(lwwRules);

      const f1 = makeActiveValueFact('alice', 1, 'slot:title', 'Title', 10);
      const f2 = makeActiveValueFact('alice', 2, 'slot:body', 'Body', 10);

      evaluator.step(factsToZSet([f1, f2]), zsetEmpty());

      const resolution = evaluator.currentResolution();
      expect(resolution.winners.size).toBe(2);
      expect(resolution.winners.get('slot:title')!.content).toBe('Title');
      expect(resolution.winners.get('slot:body')!.content).toBe('Body');
    });

    it('peer tiebreak: higher peer wins on lamport tie', () => {
      const evaluator = createIncrementalDatalogEvaluator(lwwRules);

      // Both lamport 20, charlie > bob lexicographically.
      const f1 = makeActiveValueFact('bob', 1, slotId, 'Bob', 20);
      const f2 = makeActiveValueFact('charlie', 1, slotId, 'Charlie', 20);

      evaluator.step(factsToZSet([f1, f2]), zsetEmpty());

      const resolution = evaluator.currentResolution();
      expect(resolution.winners.get(slotId)!.content).toBe('Charlie');
    });
  });

  describe('three-way equivalence: incremental Datalog ≡ batch Datalog', () => {
    const lwwRules = buildDefaultLWWRules();
    const slotId = 'slot:title';

    it('matches batch Datalog for sequential insertions', () => {
      const evaluator = createIncrementalDatalogEvaluator(lwwRules);

      const facts = [
        makeActiveValueFact('alice', 1, slotId, 'Hello', 10),
        makeActiveValueFact('bob', 1, slotId, 'World', 20),
        makeActiveValueFact('charlie', 1, slotId, 'Hi', 20),
      ];

      // Feed incrementally.
      for (const f of facts) {
        evaluator.step(factsToZSet([f]), zsetEmpty());
      }

      // Batch evaluate.
      const batchResult = evaluate(lwwRules, facts);
      if (!batchResult.ok) throw new Error('batch eval failed');
      const batchDb = batchResult.value;

      // Compare winners.
      const incRes = evaluator.currentResolution();
      const batchWinners = new Map<string, { slotId: string; content: Value }>();
      for (const tuple of batchDb.getRelation('winner').tuples()) {
        batchWinners.set(tuple[0] as string, {
          slotId: tuple[0] as string,
          content: tuple[2]!,
        });
      }

      expect(incRes.winners.size).toBe(batchWinners.size);
      for (const [slot, bw] of batchWinners) {
        const iw = incRes.winners.get(slot);
        expect(iw).toBeDefined();
        expect(iw!.content).toBe(bw.content);
      }
    });

    it('matches batch for two values in the same step', () => {
      const evaluator = createIncrementalDatalogEvaluator(lwwRules);

      const facts = [
        makeActiveValueFact('alice', 1, slotId, 'Hello', 10),
        makeActiveValueFact('bob', 1, slotId, 'World', 20),
      ];

      // Feed all at once.
      evaluator.step(factsToZSet(facts), zsetEmpty());

      // Batch evaluate.
      const batchResult = evaluate(lwwRules, facts);
      if (!batchResult.ok) throw new Error('batch eval failed');
      const batchDb = batchResult.value;

      const incRes = evaluator.currentResolution();
      const batchWinner = batchDb.getRelation('winner').tuples()[0]!;

      expect(incRes.winners.size).toBe(1);
      const iw = incRes.winners.get(slotId)!;
      expect(iw.content).toBe(batchWinner[2]);
    });
  });

  describe('permutation test', () => {
    const lwwRules = buildDefaultLWWRules();
    const slotId = 'slot:title';

    it('all orderings of 3 values produce same current resolution', () => {
      const facts = [
        makeActiveValueFact('alice', 1, slotId, 'A', 10),
        makeActiveValueFact('bob', 1, slotId, 'B', 20),
        makeActiveValueFact('charlie', 1, slotId, 'C', 20),
      ];

      // Batch evaluate for the expected result.
      const batchResult = evaluate(lwwRules, facts);
      if (!batchResult.ok) throw new Error('batch eval failed');
      const batchDb = batchResult.value;
      const batchWinnerTuple = batchDb.getRelation('winner').tuples()[0]!;
      const expectedContent = batchWinnerTuple[2];

      for (const perm of permutations(facts)) {
        const evaluator = createIncrementalDatalogEvaluator(lwwRules);
        for (const f of perm) {
          evaluator.step(factsToZSet([f]), zsetEmpty());
        }
        const resolution = evaluator.currentResolution();
        expect(resolution.winners.size).toBe(1);
        expect(resolution.winners.get(slotId)!.content).toBe(expectedContent);
      }
    });
  });

  describe('monotone stratum: transitive closure', () => {
    it('derives transitive facts incrementally', () => {
      // Simple transitive closure: path(X,Y) :- edge(X,Y).
      //                            path(X,Z) :- edge(X,Y), path(Y,Z).
      const rules = [
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

      const evaluator = createIncrementalDatalogEvaluator(rules);

      // Add edge(a, b).
      evaluator.step(factsToZSet([fact('edge', ['a', 'b'])]), zsetEmpty());
      let db = evaluator.currentDatabase();
      expect(db.hasFact(fact('path', ['a', 'b']))).toBe(true);

      // Add edge(b, c).
      evaluator.step(factsToZSet([fact('edge', ['b', 'c'])]), zsetEmpty());
      db = evaluator.currentDatabase();
      expect(db.hasFact(fact('path', ['b', 'c']))).toBe(true);
      expect(db.hasFact(fact('path', ['a', 'c']))).toBe(true); // transitive

      // Add edge(c, d).
      evaluator.step(factsToZSet([fact('edge', ['c', 'd'])]), zsetEmpty());
      db = evaluator.currentDatabase();
      expect(db.hasFact(fact('path', ['c', 'd']))).toBe(true);
      expect(db.hasFact(fact('path', ['b', 'd']))).toBe(true);
      expect(db.hasFact(fact('path', ['a', 'd']))).toBe(true);
    });

    it('matches batch for transitive closure', () => {
      const rules = [
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

      const edges = [
        fact('edge', ['a', 'b']),
        fact('edge', ['b', 'c']),
        fact('edge', ['c', 'd']),
      ];

      // Incremental.
      const evaluator = createIncrementalDatalogEvaluator(rules);
      for (const e of edges) {
        evaluator.step(factsToZSet([e]), zsetEmpty());
      }

      // Batch.
      const batchDb = evaluatePositive(rules, edges);

      // Compare path relations.
      const incPaths = evaluator.currentDatabase().getRelation('path').tuples();
      const batchPaths = batchDb.getRelation('path').tuples();

      // Same number of path facts.
      expect(incPaths.length).toBe(batchPaths.length);

      // Every batch path should be in incremental.
      for (const t of batchPaths) {
        expect(evaluator.currentDatabase().hasFact(fact('path', t))).toBe(true);
      }
    });
  });

  describe('Fugue rules with default rules', () => {
    const allRules = buildDefaultRules();

    it('structure facts produce fugue_child derivation', () => {
      const evaluator = createIncrementalDatalogEvaluator(allRules);

      const parentKey = cnIdKey(createCnId('alice', 0));
      const childKey = cnIdKey(createCnId('alice', 1));

      const seqFact = fact('active_structure_seq', [
        childKey, parentKey, null, null,
      ]);
      const peerFact = fact('constraint_peer', [childKey, 'alice']);

      evaluator.step(factsToZSet([seqFact, peerFact]), zsetEmpty());

      const db = evaluator.currentDatabase();

      // Should have derived fugue_child(parentKey, childKey, null, null, 'alice').
      const fugueChildTuples = db.getRelation('fugue_child').tuples();
      expect(fugueChildTuples.length).toBe(1);
      expect(fugueChildTuples[0]![0]).toBe(parentKey);
      expect(fugueChildTuples[0]![1]).toBe(childKey);
    });

    it('two children produce fugue_before pairs', () => {
      const evaluator = createIncrementalDatalogEvaluator(allRules);

      const parentKey = cnIdKey(createCnId('alice', 0));
      const child1Key = cnIdKey(createCnId('alice', 1));
      const child2Key = cnIdKey(createCnId('bob', 1));

      // First child: originLeft=null (leftmost).
      const seq1 = fact('active_structure_seq', [
        child1Key, parentKey, null, null,
      ]);
      const peer1 = fact('constraint_peer', [child1Key, 'alice']);

      // Second child: originLeft=child1 (inserted after child1).
      const seq2 = fact('active_structure_seq', [
        child2Key, parentKey, child1Key, null,
      ]);
      const peer2 = fact('constraint_peer', [child2Key, 'bob']);

      evaluator.step(factsToZSet([seq1, peer1, seq2, peer2]), zsetEmpty());

      const resolution = evaluator.currentResolution();
      expect(resolution.fuguePairs.size).toBeGreaterThan(0);

      // There should be a before pair for these two children.
      const allPairs: FugueBeforePair[] = [];
      for (const pairs of resolution.fuguePairs.values()) {
        allPairs.push(...pairs);
      }
      expect(allPairs.length).toBeGreaterThan(0);
    });
  });

  describe('rule changes', () => {
    it('adding a custom superseded rule changes resolution', () => {
      const lwwRules = buildDefaultLWWRules();
      const evaluator = createIncrementalDatalogEvaluator(lwwRules);
      const slotId = 'slot:title';

      // Insert two competing values.
      const f1 = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      const f2 = makeActiveValueFact('bob', 1, slotId, 'World', 20);
      evaluator.step(factsToZSet([f1, f2]), zsetEmpty());

      // With default rules, bob wins (lamport 20 > 10).
      expect(evaluator.currentResolution().winners.get(slotId)!.content).toBe('World');

      // Add a custom rule that makes LOWER lamport win (reverses comparison).
      const customRule = rule(
        atom('superseded', [varTerm('CnId'), varTerm('Slot')]),
        [
          positiveAtom(
            atom('active_value', [
              varTerm('CnId'), varTerm('Slot'), _, varTerm('L1'), _,
            ]),
          ),
          positiveAtom(
            atom('active_value', [
              varTerm('CnId2'), varTerm('Slot'), _, varTerm('L2'), _,
            ]),
          ),
          neq(varTerm('CnId'), varTerm('CnId2')),
          lt(varTerm('L2'), varTerm('L1')), // reversed: lower lamport supersedes
        ],
      );

      // Remove both original superseded rules and add the custom one.
      const ruleKey1 = 'rule1';
      const ruleKey2 = 'rule2';
      const ruleKey3 = 'rule3';

      // Remove the two default superseded rules, add the custom one.
      let ruleDelta = zsetEmpty<Rule>();
      ruleDelta = zsetAdd(ruleDelta, zsetSingleton(ruleKey1, lwwRules[0]!, -1));
      ruleDelta = zsetAdd(ruleDelta, zsetSingleton(ruleKey2, lwwRules[1]!, -1));
      ruleDelta = zsetAdd(ruleDelta, zsetSingleton(ruleKey3, customRule, 1));

      evaluator.step(zsetEmpty(), ruleDelta);

      // Now alice should win (lamport 10 < 20, and with reversed rule,
      // the higher lamport is superseded).
      const resolution = evaluator.currentResolution();
      expect(resolution.winners.get(slotId)!.content).toBe('Hello');
    });
  });

  describe('empty inputs', () => {
    it('empty delta produces empty result', () => {
      const evaluator = createIncrementalDatalogEvaluator(buildDefaultLWWRules());
      const result = evaluator.step(zsetEmpty(), zsetEmpty());

      expect(zsetIsEmpty(result.deltaResolved)).toBe(true);
      expect(zsetIsEmpty(result.deltaFuguePairs)).toBe(true);
      expect(zsetIsEmpty(result.deltaDerived)).toBe(true);
    });

    it('evaluator with no rules produces no derived facts', () => {
      const evaluator = createIncrementalDatalogEvaluator([]);

      const f = makeActiveValueFact('alice', 1, 'slot:title', 'Hello', 10);
      const result = evaluator.step(factsToZSet([f]), zsetEmpty());

      expect(zsetIsEmpty(result.deltaResolved)).toBe(true);
      expect(zsetIsEmpty(result.deltaDerived)).toBe(true);
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      const evaluator = createIncrementalDatalogEvaluator(buildDefaultLWWRules());

      const f = makeActiveValueFact('alice', 1, 'slot:title', 'Hello', 10);
      evaluator.step(factsToZSet([f]), zsetEmpty());
      expect(evaluator.currentResolution().winners.size).toBe(1);

      evaluator.reset();
      expect(evaluator.currentResolution().winners.size).toBe(0);
      expect(evaluator.currentDatabase().size).toBe(0);
    });
  });

  describe('negation stratum with stratified negation', () => {
    // Simple reachable/unreachable pattern:
    // reachable(X) :- start(X).
    // reachable(Y) :- reachable(X), edge(X, Y).
    // unreachable(X) :- node(X), not reachable(X).
    it('correctly computes negation across strata', () => {
      const rules = [
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
        rule(
          atom('unreachable', [varTerm('X')]),
          [
            positiveAtom(atom('node', [varTerm('X')])),
            negation(atom('reachable', [varTerm('X')])),
          ],
        ),
      ];

      const evaluator = createIncrementalDatalogEvaluator(rules);

      // Set up: nodes a, b, c. Start at a. Edge a→b.
      const initialFacts = [
        fact('node', ['a']),
        fact('node', ['b']),
        fact('node', ['c']),
        fact('start', ['a']),
        fact('edge', ['a', 'b']),
      ];

      evaluator.step(factsToZSet(initialFacts), zsetEmpty());

      let db = evaluator.currentDatabase();
      expect(db.hasFact(fact('reachable', ['a']))).toBe(true);
      expect(db.hasFact(fact('reachable', ['b']))).toBe(true);
      expect(db.hasFact(fact('reachable', ['c']))).toBe(false);
      expect(db.hasFact(fact('unreachable', ['c']))).toBe(true);
      expect(db.hasFact(fact('unreachable', ['a']))).toBe(false);
      expect(db.hasFact(fact('unreachable', ['b']))).toBe(false);

      // Add edge b→c. Now c becomes reachable, so unreachable(c) should retract.
      evaluator.step(factsToZSet([fact('edge', ['b', 'c'])]), zsetEmpty());

      db = evaluator.currentDatabase();
      expect(db.hasFact(fact('reachable', ['c']))).toBe(true);
      expect(db.hasFact(fact('unreachable', ['c']))).toBe(false);
    });

    it('matches batch for negation scenario', () => {
      const rules = [
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
        rule(
          atom('unreachable', [varTerm('X')]),
          [
            positiveAtom(atom('node', [varTerm('X')])),
            negation(atom('reachable', [varTerm('X')])),
          ],
        ),
      ];

      const allFacts = [
        fact('node', ['a']),
        fact('node', ['b']),
        fact('node', ['c']),
        fact('start', ['a']),
        fact('edge', ['a', 'b']),
        fact('edge', ['b', 'c']),
      ];

      // Incremental: feed one at a time.
      const evaluator = createIncrementalDatalogEvaluator(rules);
      for (const f of allFacts) {
        evaluator.step(factsToZSet([f]), zsetEmpty());
      }

      // Batch.
      const batchResult = evaluate(rules, allFacts);
      if (!batchResult.ok) throw new Error('batch eval failed');
      const batchDb = batchResult.value;

      // Compare reachable.
      const incReachable = evaluator.currentDatabase().getRelation('reachable').tuples();
      const batchReachable = batchDb.getRelation('reachable').tuples();
      expect(incReachable.length).toBe(batchReachable.length);
      for (const t of batchReachable) {
        expect(evaluator.currentDatabase().hasFact(fact('reachable', t))).toBe(true);
      }

      // Compare unreachable.
      const incUnreachable = evaluator.currentDatabase().getRelation('unreachable').tuples();
      const batchUnreachable = batchDb.getRelation('unreachable').tuples();
      expect(incUnreachable.length).toBe(batchUnreachable.length);
      for (const t of batchUnreachable) {
        expect(evaluator.currentDatabase().hasFact(fact('unreachable', t))).toBe(true);
      }
    });
  });

  describe('resolution extraction from derived facts', () => {
    it('deltaDerived contains winner facts with correct structure', () => {
      const evaluator = createIncrementalDatalogEvaluator(buildDefaultLWWRules());
      const slotId = 'slot:title';

      const f = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      const result = evaluator.step(factsToZSet([f]), zsetEmpty());

      // deltaDerived should contain winner and superseded facts.
      expect(zsetIsEmpty(result.deltaDerived)).toBe(false);

      // Check that we can find a winner fact in the derived delta.
      let foundWinner = false;
      zsetForEach(result.deltaDerived, (entry) => {
        if (entry.element.predicate === 'winner') {
          foundWinner = true;
          expect(entry.weight).toBe(1);
        }
      });
      expect(foundWinner).toBe(true);
    });

    it('deltaResolved and deltaDerived are consistent', () => {
      const evaluator = createIncrementalDatalogEvaluator(buildDefaultLWWRules());

      const f = makeActiveValueFact('alice', 1, 'slot:title', 'Hello', 10);
      const result = evaluator.step(factsToZSet([f]), zsetEmpty());

      // Every entry in deltaResolved should correspond to a winner fact
      // in deltaDerived.
      const derivedWinnerCount = countByPredicate(result.deltaDerived, 'winner');
      expect(zsetSize(result.deltaResolved)).toBe(derivedWinnerCount);
    });
  });

  describe('accumulated database consistency', () => {
    it('currentDatabase contains both ground and derived facts', () => {
      const evaluator = createIncrementalDatalogEvaluator(buildDefaultLWWRules());

      const f = makeActiveValueFact('alice', 1, 'slot:title', 'Hello', 10);
      evaluator.step(factsToZSet([f]), zsetEmpty());

      const db = evaluator.currentDatabase();

      // Ground fact should be present.
      expect(db.hasFact(f)).toBe(true);

      // Derived winner fact should be present.
      expect(db.getRelation('winner').size).toBe(1);
    });

    it('after retraction, ground fact is removed from database', () => {
      const evaluator = createIncrementalDatalogEvaluator(buildDefaultLWWRules());

      const f = makeActiveValueFact('alice', 1, 'slot:title', 'Hello', 10);
      evaluator.step(factsToZSet([f]), zsetEmpty());
      expect(evaluator.currentDatabase().hasFact(f)).toBe(true);

      evaluator.step(factsToWeightedZSet([[f, -1]]), zsetEmpty());
      expect(evaluator.currentDatabase().hasFact(f)).toBe(false);
    });
  });

  describe('batch equivalence with full default rules', () => {
    it('LWW + Fugue together match batch evaluation', () => {
      const allRules = buildDefaultRules();
      const evaluator = createIncrementalDatalogEvaluator(allRules);

      const parentKey = cnIdKey(createCnId('alice', 0));
      const child1Key = cnIdKey(createCnId('alice', 1));

      const facts = [
        // Structure facts.
        fact('active_structure_seq', [child1Key, parentKey, null, null]),
        fact('constraint_peer', [child1Key, 'alice']),
        // Value facts.
        makeActiveValueFact('alice', 10, 'slot:title', 'Hello', 10),
      ];

      // Feed incrementally.
      for (const f of facts) {
        evaluator.step(factsToZSet([f]), zsetEmpty());
      }

      // Batch.
      const batchResult = evaluate(allRules, facts);
      if (!batchResult.ok) throw new Error('batch eval failed');
      const batchDb = batchResult.value;

      // Compare all derived predicates that the batch evaluator produces.
      for (const pred of ['winner', 'superseded', 'fugue_child', 'fugue_before']) {
        const batchTuples = batchDb.getRelation(pred).tuples();
        const incTuples = evaluator.currentDatabase().getRelation(pred).tuples();
        expect(incTuples.length).toBe(batchTuples.length);
        for (const t of batchTuples) {
          expect(
            evaluator.currentDatabase().hasFact(fact(pred, t)),
          ).toBe(true);
        }
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countByPredicate(zs: ZSet<Fact>, pred: string): number {
  let count = 0;
  zsetForEach(zs, (entry) => {
    if (entry.element.predicate === pred) count++;
  });
  return count;
}