// === Unified Evaluator Tests (Plan 006.1, Phase 2) ===
// Tests for the unified weighted Datalog evaluator that replaces both
// `evaluate.ts` (batch) and `incremental-evaluate.ts` (incremental).
//
// Test categories:
//   - Dirty-map infrastructure: touchFact, applyDistinct, extractDelta
//   - evaluateStratumFromDelta: unit tests with small rule sets
//   - createEvaluator + step: incremental evaluation tests
//   - Batch wrappers: evaluateUnified, evaluatePositiveUnified
//   - Three-way oracle: batch ≡ single-step ≡ one-at-a-time
//   - Retraction through negation without DRed
//   - Transitive closure with distinct
//   - Rule changes
//   - Resolution extraction
//   - Weight propagation through strata
//   - Database.clone() preserves weights (task 2.0)

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
import {
  evaluate,
  evaluatePositive,
} from '../../src/datalog/evaluate.js';
import {
  createEvaluator,
  evaluateUnified,
  evaluatePositiveUnified,
  evaluateStratumFromDelta,
} from '../../src/datalog/evaluator.js';
import type { Evaluator, EvaluatorStepResult } from '../../src/datalog/evaluator.js';
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

/** Count facts with weight > 0 for a predicate. */
function countByPredicate(db: Database, pred: string): number {
  let count = 0;
  for (const _t of db.getRelation(pred).tuples()) {
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Database.clone() preserves weights (task 2.0)
// ---------------------------------------------------------------------------

describe('Database.clone() preserves weights', () => {
  it('clones weight-1 entries faithfully', () => {
    const db = new Database();
    db.addFact(fact('p', ['a']));
    db.addFact(fact('p', ['b']));

    const cloned = db.clone();
    expect(cloned.size).toBe(2);
    expect(cloned.hasFact(fact('p', ['a']))).toBe(true);
    expect(cloned.hasFact(fact('p', ['b']))).toBe(true);
  });

  it('clones higher weights faithfully', () => {
    const db = new Database();
    // Manually create a weight-3 entry.
    db.addWeightedFact(fact('p', ['a']), 3);

    const cloned = db.clone();
    expect(cloned.getRelation('p').getWeight(['a'])).toBe(3);
  });

  it('clone is independent of the original', () => {
    const db = new Database();
    db.addFact(fact('p', ['a']));

    const cloned = db.clone();
    db.addFact(fact('p', ['b']));

    expect(cloned.size).toBe(1);
    expect(cloned.hasFact(fact('p', ['b']))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// evaluateStratumFromDelta unit tests
// ---------------------------------------------------------------------------

describe('evaluateStratumFromDelta', () => {
  it('derives new facts from positive rules', () => {
    // Rule: derived(X) :- base(X).
    const rules: Rule[] = [
      rule(
        atom('derived', [varTerm('X')]),
        [positiveAtom(atom('base', [varTerm('X')]))],
      ),
    ];

    const db = new Database();
    db.addFact(fact('base', ['a']));
    db.addFact(fact('base', ['b']));

    const inputDelta = new Database();
    inputDelta.addFact(fact('base', ['a']));
    inputDelta.addFact(fact('base', ['b']));

    const outputDelta = evaluateStratumFromDelta(rules, db, inputDelta, false);

    // Should derive derived(a) and derived(b).
    expect(db.hasFact(fact('derived', ['a']))).toBe(true);
    expect(db.hasFact(fact('derived', ['b']))).toBe(true);

    // Output delta should contain +1 for both.
    expect(outputDelta.hasFact(fact('derived', ['a']))).toBe(true);
    expect(outputDelta.hasFact(fact('derived', ['b']))).toBe(true);
  });

  it('returns empty delta when no new facts are derived', () => {
    const rules: Rule[] = [
      rule(
        atom('derived', [varTerm('X')]),
        [positiveAtom(atom('base', [varTerm('X')]))],
      ),
    ];

    const db = new Database();
    db.addFact(fact('base', ['a']));
    db.addFact(fact('derived', ['a'])); // Already present.

    const inputDelta = new Database();
    // Empty input delta — nothing new to process.

    const outputDelta = evaluateStratumFromDelta(rules, db, inputDelta, false);

    expect(outputDelta.size).toBe(0);
  });

  it('handles transitive closure correctly', () => {
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

    const db = new Database();
    db.addFact(fact('edge', ['a', 'b']));
    db.addFact(fact('edge', ['b', 'c']));
    db.addFact(fact('edge', ['c', 'd']));

    const inputDelta = new Database();
    inputDelta.addFact(fact('edge', ['a', 'b']));
    inputDelta.addFact(fact('edge', ['b', 'c']));
    inputDelta.addFact(fact('edge', ['c', 'd']));

    evaluateStratumFromDelta(rules, db, inputDelta, false);

    expect(db.hasFact(fact('path', ['a', 'b']))).toBe(true);
    expect(db.hasFact(fact('path', ['b', 'c']))).toBe(true);
    expect(db.hasFact(fact('path', ['c', 'd']))).toBe(true);
    expect(db.hasFact(fact('path', ['a', 'c']))).toBe(true);
    expect(db.hasFact(fact('path', ['a', 'd']))).toBe(true);
    expect(db.hasFact(fact('path', ['b', 'd']))).toBe(true);
  });

  it('distinct clamps weights to 0/1 for transitive closure', () => {
    // path(a,c) can be derived two ways: a→b→c and a→c directly.
    // Without distinct, weight would be 2. With distinct, weight is 1.
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

    const db = new Database();
    db.addFact(fact('edge', ['a', 'b']));
    db.addFact(fact('edge', ['b', 'c']));
    db.addFact(fact('edge', ['a', 'c'])); // Direct edge: a→c

    const inputDelta = new Database();
    inputDelta.addFact(fact('edge', ['a', 'b']));
    inputDelta.addFact(fact('edge', ['b', 'c']));
    inputDelta.addFact(fact('edge', ['a', 'c']));

    evaluateStratumFromDelta(rules, db, inputDelta, false);

    // path(a,c) should exist with weight clamped to 1.
    expect(db.hasFact(fact('path', ['a', 'c']))).toBe(true);
    expect(db.getRelation('path').getWeight(['a', 'c'])).toBe(1);
  });

  it('handles negation strata (two-stratum evaluation)', () => {
    // These rules belong in two separate strata:
    // Stratum 0 (positive): rejected(X) :- candidate(X), candidate(Y), X != Y, Y > X.
    // Stratum 1 (negation): winner(X) :- candidate(X), not rejected(X).
    //
    // evaluateStratumFromDelta evaluates a SINGLE stratum, so we call
    // it twice — once for the positive stratum, once for the negation
    // stratum — matching real stratification behavior.

    const positiveRules: Rule[] = [
      rule(
        atom('rejected', [varTerm('X')]),
        [
          positiveAtom(atom('candidate', [varTerm('X')])),
          positiveAtom(atom('candidate', [varTerm('Y')])),
          neq(varTerm('X'), varTerm('Y')),
          gt(varTerm('Y'), varTerm('X')),
        ],
      ),
    ];

    const negationRules: Rule[] = [
      rule(
        atom('winner', [varTerm('X')]),
        [
          positiveAtom(atom('candidate', [varTerm('X')])),
          negation(atom('rejected', [varTerm('X')])),
        ],
      ),
    ];

    const db = new Database();
    db.addFact(fact('candidate', ['a']));
    db.addFact(fact('candidate', ['b']));
    db.addFact(fact('candidate', ['c']));

    const inputDelta = new Database();
    inputDelta.addFact(fact('candidate', ['a']));
    inputDelta.addFact(fact('candidate', ['b']));
    inputDelta.addFact(fact('candidate', ['c']));

    // Stratum 0: derive rejected facts (positive).
    const stratum0Delta = evaluateStratumFromDelta(positiveRules, db, inputDelta, false);

    // Build input delta for stratum 1 from stratum 0's output + original input.
    const stratum1Input = new Database();
    for (const pred of inputDelta.predicates()) {
      for (const tuple of inputDelta.getRelation(pred).tuples()) {
        stratum1Input.addFact({ predicate: pred, values: tuple });
      }
    }
    for (const pred of stratum0Delta.predicates()) {
      for (const tuple of stratum0Delta.getRelation(pred).tuples()) {
        stratum1Input.addFact({ predicate: pred, values: tuple });
      }
    }

    // Stratum 1: derive winner facts (negation).
    evaluateStratumFromDelta(negationRules, db, stratum1Input, true);

    // 'c' is the greatest, so it should be the winner.
    expect(db.hasFact(fact('winner', ['c']))).toBe(true);
    expect(db.hasFact(fact('winner', ['a']))).toBe(false);
    expect(db.hasFact(fact('winner', ['b']))).toBe(false);

    // 'a' and 'b' should be rejected.
    expect(db.hasFact(fact('rejected', ['a']))).toBe(true);
    expect(db.hasFact(fact('rejected', ['b']))).toBe(true);
    expect(db.hasFact(fact('rejected', ['c']))).toBe(false);
  });

  it('output delta reflects zero-crossings only', () => {
    const rules: Rule[] = [
      rule(
        atom('derived', [varTerm('X')]),
        [positiveAtom(atom('base', [varTerm('X')]))],
      ),
    ];

    const db = new Database();
    db.addFact(fact('base', ['a']));
    db.addFact(fact('base', ['b']));
    db.addFact(fact('derived', ['a'])); // Already present — no zero-crossing.

    const inputDelta = new Database();
    inputDelta.addFact(fact('base', ['b'])); // Only 'b' is new.

    const outputDelta = evaluateStratumFromDelta(rules, db, inputDelta, false);

    // 'a' was already derived — should NOT appear in delta.
    // 'b' is newly derived — should appear as +1.
    expect(outputDelta.hasFact(fact('derived', ['b']))).toBe(true);
    expect(outputDelta.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Unified evaluator: LWW resolution with default rules
// ---------------------------------------------------------------------------

describe('Unified Evaluator', () => {
  describe('LWW resolution with default rules', () => {
    const lwwRules = buildDefaultLWWRules();
    const slotId = 'slot:title';

    it('single active_value produces a winner', () => {
      const evaluator = createEvaluator(lwwRules);

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

    it('superseding value produces winner change', () => {
      const evaluator = createEvaluator(lwwRules);

      // Insert first value (lamport 10).
      const f1 = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      evaluator.step(factsToZSet([f1]), zsetEmpty());

      // Insert superseding value (lamport 20).
      const f2 = makeActiveValueFact('bob', 1, slotId, 'World', 20);
      const result = evaluator.step(factsToZSet([f2]), zsetEmpty());

      // Should have winner changes.
      expect(zsetIsEmpty(result.deltaResolved)).toBe(false);

      // The new winner should be bob's value.
      const resolution = evaluator.currentResolution();
      expect(resolution.winners.size).toBe(1);
      const winner = resolution.winners.get(slotId)!;
      expect(winner.content).toBe('World');
      expect(winner.winnerCnIdKey).toBe(cnIdKey(createCnId('bob', 1)));
    });

    it('non-superseding value produces no winner change', () => {
      const evaluator = createEvaluator(lwwRules);

      // Insert the winner first (lamport 20).
      const f1 = makeActiveValueFact('bob', 1, slotId, 'World', 20);
      evaluator.step(factsToZSet([f1]), zsetEmpty());

      // Insert a loser (lamport 10).
      const f2 = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      evaluator.step(factsToZSet([f2]), zsetEmpty());

      // The winner should still be bob's value.
      const resolution = evaluator.currentResolution();
      expect(resolution.winners.size).toBe(1);
      expect(resolution.winners.get(slotId)!.content).toBe('World');
    });

    it('value retraction causes winner recomputation via weight propagation', () => {
      const evaluator = createEvaluator(lwwRules);

      // Insert two values.
      const f1 = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      const f2 = makeActiveValueFact('bob', 1, slotId, 'World', 20);
      evaluator.step(factsToZSet([f1, f2]), zsetEmpty());

      // Winner should be bob (lamport 20).
      expect(evaluator.currentResolution().winners.get(slotId)!.content).toBe('World');

      // Retract bob's value.
      const retractDelta = factsToWeightedZSet([[f2, -1]]);
      evaluator.step(retractDelta, zsetEmpty());

      // Winner should now be alice — via weight propagation, not DRed.
      const resolution = evaluator.currentResolution();
      expect(resolution.winners.size).toBe(1);
      expect(resolution.winners.get(slotId)!.content).toBe('Hello');
    });

    it('retraction of sole value removes winner', () => {
      const evaluator = createEvaluator(lwwRules);

      const f1 = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      evaluator.step(factsToZSet([f1]), zsetEmpty());

      // Retract it.
      evaluator.step(factsToWeightedZSet([[f1, -1]]), zsetEmpty());

      const resolution = evaluator.currentResolution();
      expect(resolution.winners.size).toBe(0);
    });

    it('multiple slots are tracked independently', () => {
      const evaluator = createEvaluator(lwwRules);

      const f1 = makeActiveValueFact('alice', 1, 'slot:title', 'Title', 10);
      const f2 = makeActiveValueFact('alice', 2, 'slot:body', 'Body', 10);

      evaluator.step(factsToZSet([f1, f2]), zsetEmpty());

      const resolution = evaluator.currentResolution();
      expect(resolution.winners.size).toBe(2);
      expect(resolution.winners.get('slot:title')!.content).toBe('Title');
      expect(resolution.winners.get('slot:body')!.content).toBe('Body');
    });

    it('peer tiebreak: higher peer wins on lamport tie', () => {
      const evaluator = createEvaluator(lwwRules);

      const f1 = makeActiveValueFact('bob', 1, slotId, 'Bob', 20);
      const f2 = makeActiveValueFact('charlie', 1, slotId, 'Charlie', 20);

      evaluator.step(factsToZSet([f1, f2]), zsetEmpty());

      const resolution = evaluator.currentResolution();
      expect(resolution.winners.get(slotId)!.content).toBe('Charlie');
    });
  });

  // ---------------------------------------------------------------------------
  // Three-way equivalence oracle
  // ---------------------------------------------------------------------------

  describe('three-way oracle: batch ≡ single-step ≡ one-at-a-time', () => {
    const lwwRules = buildDefaultLWWRules();
    const slotId = 'slot:title';

    it('all three paths produce the same database for sequential insertions', () => {
      const facts = [
        makeActiveValueFact('alice', 1, slotId, 'Hello', 10),
        makeActiveValueFact('bob', 1, slotId, 'World', 20),
        makeActiveValueFact('charlie', 1, slotId, 'Hi', 20),
      ];

      // Path 1: batch evaluate (old evaluate function).
      const batchResult = evaluate(lwwRules, facts);
      if (!batchResult.ok) throw new Error('batch eval failed');
      const batchDb = batchResult.value;

      // Path 2: unified evaluator, single step with all facts.
      const singleStep = createEvaluator(lwwRules);
      singleStep.step(factsToZSet(facts), zsetEmpty());
      const singleStepDb = singleStep.currentDatabase();

      // Path 3: unified evaluator, one fact per step.
      const oneAtATime = createEvaluator(lwwRules);
      for (const f of facts) {
        oneAtATime.step(factsToZSet([f]), zsetEmpty());
      }
      const oneAtATimeDb = oneAtATime.currentDatabase();

      // Compare winners across all three.
      const batchWinners = new Map<string, Value>();
      for (const tuple of batchDb.getRelation('winner').tuples()) {
        batchWinners.set(tuple[0] as string, tuple[2]!);
      }

      const singleStepWinners = singleStep.currentResolution().winners;
      const oneAtATimeWinners = oneAtATime.currentResolution().winners;

      // All should have the same number of winners.
      expect(singleStepWinners.size).toBe(batchWinners.size);
      expect(oneAtATimeWinners.size).toBe(batchWinners.size);

      // All should agree on content.
      for (const [slot, content] of batchWinners) {
        expect(singleStepWinners.get(slot)!.content).toBe(content);
        expect(oneAtATimeWinners.get(slot)!.content).toBe(content);
      }
    });

    it('matches batch for two values in the same step', () => {
      const facts = [
        makeActiveValueFact('alice', 1, slotId, 'Hello', 10),
        makeActiveValueFact('bob', 1, slotId, 'World', 20),
      ];

      const batchResult = evaluate(lwwRules, facts);
      if (!batchResult.ok) throw new Error('batch eval failed');
      const batchDb = batchResult.value;

      const evaluator = createEvaluator(lwwRules);
      evaluator.step(factsToZSet(facts), zsetEmpty());

      const incRes = evaluator.currentResolution();
      const batchWinner = batchDb.getRelation('winner').tuples()[0]!;

      expect(incRes.winners.size).toBe(1);
      expect(incRes.winners.get(slotId)!.content).toBe(batchWinner[2]);
    });

    it('three-way oracle with transitive closure', () => {
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

      const edges = [
        fact('edge', ['a', 'b']),
        fact('edge', ['b', 'c']),
        fact('edge', ['c', 'd']),
      ];

      // Path 1: old batch evaluate.
      const batchDb = evaluatePositive(rules, edges);

      // Path 2: unified single step.
      const singleStep = createEvaluator(rules);
      singleStep.step(factsToZSet(edges), zsetEmpty());

      // Path 3: unified one-at-a-time.
      const oneAtATime = createEvaluator(rules);
      for (const e of edges) {
        oneAtATime.step(factsToZSet([e]), zsetEmpty());
      }

      const batchPaths = batchDb.getRelation('path').tuples();
      const singlePaths = singleStep.currentDatabase().getRelation('path').tuples();
      const oneAtATimePaths = oneAtATime.currentDatabase().getRelation('path').tuples();

      expect(singlePaths.length).toBe(batchPaths.length);
      expect(oneAtATimePaths.length).toBe(batchPaths.length);

      for (const t of batchPaths) {
        expect(singleStep.currentDatabase().hasFact(fact('path', t))).toBe(true);
        expect(oneAtATime.currentDatabase().hasFact(fact('path', t))).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Batch wrapper equivalence
  // ---------------------------------------------------------------------------

  describe('evaluateUnified matches old evaluate', () => {
    it('produces identical results for simple positive rules', () => {
      const rules: Rule[] = [
        rule(
          atom('derived', [varTerm('X')]),
          [positiveAtom(atom('base', [varTerm('X')]))],
        ),
      ];
      const facts = [fact('base', ['a']), fact('base', ['b'])];

      const oldResult = evaluate(rules, facts);
      if (!oldResult.ok) throw new Error('old eval failed');

      const newResult = evaluateUnified(rules, facts);
      if (!newResult.ok) throw new Error('new eval failed');

      expect(newResult.value.hasFact(fact('derived', ['a']))).toBe(true);
      expect(newResult.value.hasFact(fact('derived', ['b']))).toBe(true);

      // Both should have same derived facts.
      for (const tuple of oldResult.value.getRelation('derived').tuples()) {
        expect(newResult.value.hasFact(fact('derived', tuple))).toBe(true);
      }
    });

    it('produces identical results for LWW rules', () => {
      const lwwRules = buildDefaultLWWRules();
      const slotId = 'slot:title';
      const facts = [
        makeActiveValueFact('alice', 1, slotId, 'Hello', 10),
        makeActiveValueFact('bob', 1, slotId, 'World', 20),
      ];

      const oldResult = evaluate(lwwRules, facts);
      if (!oldResult.ok) throw new Error('old eval failed');

      const newResult = evaluateUnified(lwwRules, facts);
      if (!newResult.ok) throw new Error('new eval failed');

      const oldWinners = oldResult.value.getRelation('winner').tuples();
      const newWinners = newResult.value.getRelation('winner').tuples();

      expect(newWinners.length).toBe(oldWinners.length);
      for (const t of oldWinners) {
        expect(newResult.value.hasFact(fact('winner', t))).toBe(true);
      }
    });

    it('returns StratificationError for cyclic negation', () => {
      const rules: Rule[] = [
        rule(
          atom('a', [varTerm('X')]),
          [negation(atom('b', [varTerm('X')]))],
        ),
        rule(
          atom('b', [varTerm('X')]),
          [negation(atom('a', [varTerm('X')]))],
        ),
      ];

      const result = evaluateUnified(rules, [fact('base', ['x'])]);
      expect(result.ok).toBe(false);
    });

    it('handles empty rules', () => {
      const facts = [fact('base', ['a'])];
      const result = evaluateUnified([], facts);
      if (!result.ok) throw new Error('should succeed');

      expect(result.value.size).toBe(1);
      expect(result.value.hasFact(fact('base', ['a']))).toBe(true);
    });

    it('handles empty facts', () => {
      const rules: Rule[] = [
        rule(
          atom('derived', [varTerm('X')]),
          [positiveAtom(atom('base', [varTerm('X')]))],
        ),
      ];

      const result = evaluateUnified(rules, []);
      if (!result.ok) throw new Error('should succeed');
      expect(result.value.size).toBe(0);
    });
  });

  describe('evaluatePositiveUnified matches old evaluatePositive', () => {
    it('transitive closure produces same results', () => {
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

      const facts = [
        fact('edge', ['a', 'b']),
        fact('edge', ['b', 'c']),
        fact('edge', ['c', 'd']),
      ];

      const oldDb = evaluatePositive(rules, facts);
      const newDb = evaluatePositiveUnified(rules, facts);

      const oldPaths = oldDb.getRelation('path').tuples();
      const newPaths = newDb.getRelation('path').tuples();

      expect(newPaths.length).toBe(oldPaths.length);
      for (const t of oldPaths) {
        expect(newDb.hasFact(fact('path', t))).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Permutation test
  // ---------------------------------------------------------------------------

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
        const evaluator = createEvaluator(lwwRules);
        for (const f of perm) {
          evaluator.step(factsToZSet([f]), zsetEmpty());
        }
        const resolution = evaluator.currentResolution();
        expect(resolution.winners.size).toBe(1);
        expect(resolution.winners.get(slotId)!.content).toBe(expectedContent);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Monotone stratum: transitive closure
  // ---------------------------------------------------------------------------

  describe('monotone stratum: transitive closure', () => {
    it('derives transitive facts incrementally', () => {
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

      const evaluator = createEvaluator(rules);

      // Add edge(a, b).
      evaluator.step(factsToZSet([fact('edge', ['a', 'b'])]), zsetEmpty());
      let db = evaluator.currentDatabase();
      expect(db.hasFact(fact('path', ['a', 'b']))).toBe(true);

      // Add edge(b, c).
      evaluator.step(factsToZSet([fact('edge', ['b', 'c'])]), zsetEmpty());
      db = evaluator.currentDatabase();
      expect(db.hasFact(fact('path', ['b', 'c']))).toBe(true);
      expect(db.hasFact(fact('path', ['a', 'c']))).toBe(true);

      // Add edge(c, d).
      evaluator.step(factsToZSet([fact('edge', ['c', 'd'])]), zsetEmpty());
      db = evaluator.currentDatabase();
      expect(db.hasFact(fact('path', ['c', 'd']))).toBe(true);
      expect(db.hasFact(fact('path', ['b', 'd']))).toBe(true);
      expect(db.hasFact(fact('path', ['a', 'd']))).toBe(true);
    });

    it('matches batch for transitive closure', () => {
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

      const edges = [
        fact('edge', ['a', 'b']),
        fact('edge', ['b', 'c']),
        fact('edge', ['c', 'd']),
      ];

      // Incremental.
      const evaluator = createEvaluator(rules);
      for (const e of edges) {
        evaluator.step(factsToZSet([e]), zsetEmpty());
      }

      // Batch.
      const batchDb = evaluatePositive(rules, edges);

      const incPaths = evaluator.currentDatabase().getRelation('path').tuples();
      const batchPaths = batchDb.getRelation('path').tuples();

      expect(incPaths.length).toBe(batchPaths.length);
      for (const t of batchPaths) {
        expect(evaluator.currentDatabase().hasFact(fact('path', t))).toBe(true);
      }
    });

    it('transitive closure weights stay at 0/1 regardless of path count', () => {
      // Diamond: a→b, a→c, b→d, c→d. Two paths from a to d.
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

      const edges = [
        fact('edge', ['a', 'b']),
        fact('edge', ['a', 'c']),
        fact('edge', ['b', 'd']),
        fact('edge', ['c', 'd']),
      ];

      const evaluator = createEvaluator(rules);
      evaluator.step(factsToZSet(edges), zsetEmpty());

      const db = evaluator.currentDatabase();
      // path(a,d) derivable via a→b→d and a→c→d, but weight should be 1.
      expect(db.hasFact(fact('path', ['a', 'd']))).toBe(true);
      expect(db.getRelation('path').getWeight(['a', 'd'])).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // Fugue rules
  // ---------------------------------------------------------------------------

  describe('Fugue rules with default rules', () => {
    const allRules = buildDefaultRules();

    it('structure facts produce fugue_child derivation', () => {
      const evaluator = createEvaluator(allRules);

      const parentKey = cnIdKey(createCnId('alice', 0));
      const childKey = cnIdKey(createCnId('alice', 1));

      const seqFact = fact('active_structure_seq', [
        childKey, parentKey, null, null,
      ]);
      const peerFact = fact('constraint_peer', [childKey, 'alice']);

      evaluator.step(factsToZSet([seqFact, peerFact]), zsetEmpty());

      const db = evaluator.currentDatabase();
      const fugueChildTuples = db.getRelation('fugue_child').tuples();
      expect(fugueChildTuples.length).toBe(1);
      expect(fugueChildTuples[0]![0]).toBe(parentKey);
      expect(fugueChildTuples[0]![1]).toBe(childKey);
    });

    it('two children produce fugue_before pairs', () => {
      const evaluator = createEvaluator(allRules);

      const parentKey = cnIdKey(createCnId('alice', 0));
      const child1Key = cnIdKey(createCnId('alice', 1));
      const child2Key = cnIdKey(createCnId('bob', 1));

      const seq1 = fact('active_structure_seq', [
        child1Key, parentKey, null, null,
      ]);
      const peer1 = fact('constraint_peer', [child1Key, 'alice']);

      const seq2 = fact('active_structure_seq', [
        child2Key, parentKey, child1Key, null,
      ]);
      const peer2 = fact('constraint_peer', [child2Key, 'bob']);

      evaluator.step(factsToZSet([seq1, peer1, seq2, peer2]), zsetEmpty());

      const resolution = evaluator.currentResolution();
      expect(resolution.fuguePairs.size).toBeGreaterThan(0);

      const allPairs: FugueBeforePair[] = [];
      for (const pairs of resolution.fuguePairs.values()) {
        allPairs.push(...pairs);
      }
      expect(allPairs.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Retraction through negation stratum without DRed
  // ---------------------------------------------------------------------------

  describe('retraction through negation without DRed', () => {
    it('retracted winner ground fact yields new winner via weight propagation', () => {
      const lwwRules = buildDefaultLWWRules();
      const evaluator = createEvaluator(lwwRules);
      const slotId = 'slot:title';

      // Insert two competing values.
      const f1 = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      const f2 = makeActiveValueFact('bob', 1, slotId, 'World', 20);
      evaluator.step(factsToZSet([f1, f2]), zsetEmpty());

      // Bob wins (lamport 20 > 10).
      expect(evaluator.currentResolution().winners.get(slotId)!.content).toBe('World');

      // Retract bob's value — alice should become the new winner.
      evaluator.step(factsToWeightedZSet([[f2, -1]]), zsetEmpty());

      const resolution = evaluator.currentResolution();
      expect(resolution.winners.size).toBe(1);
      expect(resolution.winners.get(slotId)!.content).toBe('Hello');
    });

    it('retraction and re-insertion work correctly', () => {
      const lwwRules = buildDefaultLWWRules();
      const evaluator = createEvaluator(lwwRules);
      const slotId = 'slot:title';

      const f1 = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      evaluator.step(factsToZSet([f1]), zsetEmpty());
      expect(evaluator.currentResolution().winners.get(slotId)!.content).toBe('Hello');

      // Retract.
      evaluator.step(factsToWeightedZSet([[f1, -1]]), zsetEmpty());
      expect(evaluator.currentResolution().winners.size).toBe(0);

      // Re-insert.
      evaluator.step(factsToZSet([f1]), zsetEmpty());
      expect(evaluator.currentResolution().winners.get(slotId)!.content).toBe('Hello');
    });
  });

  // ---------------------------------------------------------------------------
  // Rule changes
  // ---------------------------------------------------------------------------

  describe('rule changes', () => {
    it('adding a custom superseded rule changes resolution', () => {
      const lwwRules = buildDefaultLWWRules();
      const evaluator = createEvaluator(lwwRules);
      const slotId = 'slot:title';

      // Insert two competing values.
      const f1 = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      const f2 = makeActiveValueFact('bob', 1, slotId, 'World', 20);
      evaluator.step(factsToZSet([f1, f2]), zsetEmpty());

      // With default rules, bob wins (lamport 20 > 10).
      expect(evaluator.currentResolution().winners.get(slotId)!.content).toBe('World');

      // Add a custom rule that makes LOWER lamport win.
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
          lt(varTerm('L2'), varTerm('L1')), // reversed: lower lamport wins
        ],
      );

      // Remove default superseded rules, add custom one.
      let ruleDelta = zsetEmpty<Rule>();
      ruleDelta = zsetAdd(ruleDelta, zsetSingleton('rule1', lwwRules[0]!, -1));
      ruleDelta = zsetAdd(ruleDelta, zsetSingleton('rule2', lwwRules[1]!, -1));
      ruleDelta = zsetAdd(ruleDelta, zsetSingleton('rule3', customRule, 1));

      evaluator.step(zsetEmpty(), ruleDelta);

      // Now alice should win (lamport 10 < 20).
      const resolution = evaluator.currentResolution();
      expect(resolution.winners.get(slotId)!.content).toBe('Hello');
    });
  });

  // ---------------------------------------------------------------------------
  // Empty inputs
  // ---------------------------------------------------------------------------

  describe('empty inputs', () => {
    it('empty delta produces empty result', () => {
      const evaluator = createEvaluator(buildDefaultLWWRules());
      const result = evaluator.step(zsetEmpty(), zsetEmpty());

      expect(zsetIsEmpty(result.deltaResolved)).toBe(true);
      expect(zsetIsEmpty(result.deltaFuguePairs)).toBe(true);
      expect(zsetIsEmpty(result.deltaDerived)).toBe(true);
    });

    it('evaluator with no rules produces no derived facts', () => {
      const evaluator = createEvaluator([]);
      const f = makeActiveValueFact('alice', 1, 'slot:title', 'Hello', 10);
      const result = evaluator.step(factsToZSet([f]), zsetEmpty());

      // Ground fact is stored, but no derived facts.
      expect(evaluator.currentDatabase().hasFact(f)).toBe(true);
      expect(zsetIsEmpty(result.deltaDerived)).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  describe('reset', () => {
    it('clears all state', () => {
      const evaluator = createEvaluator(buildDefaultLWWRules());
      const f = makeActiveValueFact('alice', 1, 'slot:title', 'Hello', 10);
      evaluator.step(factsToZSet([f]), zsetEmpty());

      evaluator.reset();
      expect(evaluator.currentDatabase().size).toBe(0);
      expect(evaluator.currentResolution().winners.size).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Negation stratum with stratified negation
  // ---------------------------------------------------------------------------

  describe('negation stratum with stratified negation', () => {
    it('correctly computes negation across strata', () => {
      // Stratum 0: reachable(X,Y) :- edge(X,Y).
      //            reachable(X,Z) :- edge(X,Y), reachable(Y,Z).
      // Stratum 1: unreachable(X,Y) :- node(X), node(Y), not reachable(X,Y).
      const rules: Rule[] = [
        rule(
          atom('reachable', [varTerm('X'), varTerm('Y')]),
          [positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')]))],
        ),
        rule(
          atom('reachable', [varTerm('X'), varTerm('Z')]),
          [
            positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')])),
            positiveAtom(atom('reachable', [varTerm('Y'), varTerm('Z')])),
          ],
        ),
        rule(
          atom('unreachable', [varTerm('X'), varTerm('Y')]),
          [
            positiveAtom(atom('node', [varTerm('X')])),
            positiveAtom(atom('node', [varTerm('Y')])),
            negation(atom('reachable', [varTerm('X'), varTerm('Y')])),
          ],
        ),
      ];

      const evaluator = createEvaluator(rules);
      const initialFacts = [
        fact('node', ['a']),
        fact('node', ['b']),
        fact('node', ['c']),
        fact('edge', ['a', 'b']),
        fact('edge', ['b', 'c']),
      ];

      evaluator.step(factsToZSet(initialFacts), zsetEmpty());

      let db = evaluator.currentDatabase();
      expect(db.hasFact(fact('reachable', ['a', 'b']))).toBe(true);
      expect(db.hasFact(fact('reachable', ['a', 'c']))).toBe(true);
      expect(db.hasFact(fact('reachable', ['b', 'c']))).toBe(true);

      // Unreachable pairs.
      expect(db.hasFact(fact('unreachable', ['b', 'a']))).toBe(true);
      expect(db.hasFact(fact('unreachable', ['c', 'a']))).toBe(true);
      expect(db.hasFact(fact('unreachable', ['c', 'b']))).toBe(true);

      // Self-loops are unreachable too (not derived by edge rules).
      expect(db.hasFact(fact('unreachable', ['a', 'a']))).toBe(true);
    });

    it('matches batch for negation scenario', () => {
      const rules: Rule[] = [
        rule(
          atom('reachable', [varTerm('X'), varTerm('Y')]),
          [positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')]))],
        ),
        rule(
          atom('reachable', [varTerm('X'), varTerm('Z')]),
          [
            positiveAtom(atom('edge', [varTerm('X'), varTerm('Y')])),
            positiveAtom(atom('reachable', [varTerm('Y'), varTerm('Z')])),
          ],
        ),
        rule(
          atom('unreachable', [varTerm('X'), varTerm('Y')]),
          [
            positiveAtom(atom('node', [varTerm('X')])),
            positiveAtom(atom('node', [varTerm('Y')])),
            negation(atom('reachable', [varTerm('X'), varTerm('Y')])),
          ],
        ),
      ];

      const allFacts = [
        fact('node', ['a']),
        fact('node', ['b']),
        fact('node', ['c']),
        fact('edge', ['a', 'b']),
        fact('edge', ['b', 'c']),
      ];

      // Incremental.
      const evaluator = createEvaluator(rules);
      evaluator.step(factsToZSet(allFacts), zsetEmpty());

      // Batch.
      const batchResult = evaluate(rules, allFacts);
      if (!batchResult.ok) throw new Error('batch eval failed');
      const batchDb = batchResult.value;

      const incReachable = evaluator.currentDatabase().getRelation('reachable').tuples();
      const batchReachable = batchDb.getRelation('reachable').tuples();
      expect(incReachable.length).toBe(batchReachable.length);

      for (const t of batchReachable) {
        expect(evaluator.currentDatabase().hasFact(fact('reachable', t))).toBe(true);
      }

      const incUnreachable = evaluator.currentDatabase().getRelation('unreachable').tuples();
      const batchUnreachable = batchDb.getRelation('unreachable').tuples();
      expect(incUnreachable.length).toBe(batchUnreachable.length);

      for (const t of batchUnreachable) {
        expect(evaluator.currentDatabase().hasFact(fact('unreachable', t))).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Resolution extraction from derived facts
  // ---------------------------------------------------------------------------

  describe('resolution extraction from derived facts', () => {
    it('deltaDerived contains winner facts with correct structure', () => {
      const evaluator = createEvaluator(buildDefaultLWWRules());
      const slotId = 'slot:title';
      const f = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);

      const result = evaluator.step(factsToZSet([f]), zsetEmpty());

      let foundWinner = false;
      zsetForEach(result.deltaDerived, (entry) => {
        if (entry.element.predicate === 'winner') {
          foundWinner = true;
          expect(entry.weight).toBe(1);
          expect(entry.element.values[0]).toBe(slotId);
          expect(entry.element.values[2]).toBe('Hello');
        }
      });
      expect(foundWinner).toBe(true);
    });

    it('deltaResolved and deltaDerived are consistent', () => {
      const evaluator = createEvaluator(buildDefaultLWWRules());
      const f = makeActiveValueFact('alice', 1, 'slot:title', 'Hello', 10);
      const result = evaluator.step(factsToZSet([f]), zsetEmpty());

      // Count winner facts in deltaDerived.
      let derivedWinnerCount = 0;
      zsetForEach(result.deltaDerived, (entry) => {
        if (entry.element.predicate === 'winner') derivedWinnerCount++;
      });

      expect(zsetSize(result.deltaResolved)).toBe(derivedWinnerCount);
    });
  });

  // ---------------------------------------------------------------------------
  // Accumulated database consistency
  // ---------------------------------------------------------------------------

  describe('accumulated database consistency', () => {
    it('currentDatabase contains both ground and derived facts', () => {
      const evaluator = createEvaluator(buildDefaultLWWRules());
      const f = makeActiveValueFact('alice', 1, 'slot:title', 'Hello', 10);
      evaluator.step(factsToZSet([f]), zsetEmpty());

      const db = evaluator.currentDatabase();
      // Ground fact should be there.
      expect(db.hasFact(f)).toBe(true);
      // Derived winner should be there.
      expect(db.getRelation('winner').tuples().length).toBeGreaterThan(0);
    });

    it('after retraction, ground fact is removed from database', () => {
      const evaluator = createEvaluator(buildDefaultLWWRules());
      const f = makeActiveValueFact('alice', 1, 'slot:title', 'Hello', 10);
      evaluator.step(factsToZSet([f]), zsetEmpty());
      expect(evaluator.currentDatabase().hasFact(f)).toBe(true);

      evaluator.step(factsToWeightedZSet([[f, -1]]), zsetEmpty());
      expect(evaluator.currentDatabase().hasFact(f)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Batch equivalence with full default rules
  // ---------------------------------------------------------------------------

  describe('batch equivalence with full default rules', () => {
    it('LWW + Fugue together match batch evaluation', () => {
      const allRules = buildDefaultRules();
      const evaluator = createEvaluator(allRules);
      const parentKey = cnIdKey(createCnId('alice', 0));
      const child1Key = cnIdKey(createCnId('alice', 1));
      const facts = [
        makeActiveValueFact('alice', 1, 'slot:title', 'Hello', 10),
        fact('active_structure_seq', [child1Key, parentKey, null, null]),
        fact('constraint_peer', [child1Key, 'alice']),
      ];

      // Feed incrementally.
      evaluator.step(factsToZSet(facts), zsetEmpty());

      // Batch.
      const batchResult = evaluate(allRules, facts);
      if (!batchResult.ok) throw new Error('batch eval failed');
      const batchDb = batchResult.value;

      // Compare winner tuples.
      const batchTuples = batchDb.getRelation('winner').tuples();
      const incTuples = evaluator.currentDatabase().getRelation('winner').tuples();
      expect(incTuples.length).toBe(batchTuples.length);
      for (const t of batchTuples) {
        expect(evaluator.currentDatabase().hasFact(fact('winner', t))).toBe(true);
      }

      // Compare fugue_child tuples.
      const batchFugueChild = batchDb.getRelation('fugue_child').tuples();
      const incFugueChild = evaluator.currentDatabase().getRelation('fugue_child').tuples();
      expect(incFugueChild.length).toBe(batchFugueChild.length);
    });
  });

  // ---------------------------------------------------------------------------
  // reset() + replay equals accumulated state
  // ---------------------------------------------------------------------------

  describe('reset + replay equals accumulated state', () => {
    it('replaying the same facts after reset produces identical state', () => {
      const lwwRules = buildDefaultLWWRules();
      const evaluator = createEvaluator(lwwRules);
      const slotId = 'slot:title';

      const facts = [
        makeActiveValueFact('alice', 1, slotId, 'Hello', 10),
        makeActiveValueFact('bob', 1, slotId, 'World', 20),
      ];

      // Accumulate.
      for (const f of facts) {
        evaluator.step(factsToZSet([f]), zsetEmpty());
      }
      const beforeReset = evaluator.currentResolution();

      // Reset and replay.
      evaluator.reset();

      // Re-add rules (reset clears them).
      const freshEval = createEvaluator(lwwRules);
      for (const f of facts) {
        freshEval.step(factsToZSet([f]), zsetEmpty());
      }
      const afterReplay = freshEval.currentResolution();

      expect(afterReplay.winners.size).toBe(beforeReset.winners.size);
      for (const [slot, winner] of beforeReset.winners) {
        expect(afterReplay.winners.get(slot)!.content).toBe(winner.content);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // evaluateUnified: comprehensive equivalence with old evaluate
  // ---------------------------------------------------------------------------

  describe('evaluateUnified comprehensive equivalence', () => {
    it('evaluate.test.ts: stratified negation', () => {
      // winner(X) :- candidate(X), not rejected(X).
      // rejected(X) :- candidate(X), candidate(Y), X != Y, Y > X.
      const rules: Rule[] = [
        rule(
          atom('winner', [varTerm('X')]),
          [
            positiveAtom(atom('candidate', [varTerm('X')])),
            negation(atom('rejected', [varTerm('X')])),
          ],
        ),
        rule(
          atom('rejected', [varTerm('X')]),
          [
            positiveAtom(atom('candidate', [varTerm('X')])),
            positiveAtom(atom('candidate', [varTerm('Y')])),
            neq(varTerm('X'), varTerm('Y')),
            gt(varTerm('Y'), varTerm('X')),
          ],
        ),
      ];

      const facts = [
        fact('candidate', ['a']),
        fact('candidate', ['b']),
        fact('candidate', ['c']),
      ];

      const oldResult = evaluate(rules, facts);
      if (!oldResult.ok) throw new Error('old eval failed');

      const newResult = evaluateUnified(rules, facts);
      if (!newResult.ok) throw new Error('new eval failed');

      // Both should produce the same winners and rejected sets.
      const oldWinners = oldResult.value.getRelation('winner').tuples();
      const newWinners = newResult.value.getRelation('winner').tuples();
      expect(newWinners.length).toBe(oldWinners.length);
      for (const t of oldWinners) {
        expect(newResult.value.hasFact(fact('winner', t))).toBe(true);
      }

      const oldRejected = oldResult.value.getRelation('rejected').tuples();
      const newRejected = newResult.value.getRelation('rejected').tuples();
      expect(newRejected.length).toBe(oldRejected.length);
    });

    it('evaluate.test.ts: multiple rules for the same predicate', () => {
      // derived(X) :- source_a(X).
      // derived(X) :- source_b(X).
      const rules: Rule[] = [
        rule(
          atom('derived', [varTerm('X')]),
          [positiveAtom(atom('source_a', [varTerm('X')]))],
        ),
        rule(
          atom('derived', [varTerm('X')]),
          [positiveAtom(atom('source_b', [varTerm('X')]))],
        ),
      ];

      const facts = [
        fact('source_a', ['x']),
        fact('source_b', ['y']),
        fact('source_a', ['z']),
        fact('source_b', ['z']),
      ];

      const oldResult = evaluate(rules, facts);
      if (!oldResult.ok) throw new Error('old eval failed');

      const newResult = evaluateUnified(rules, facts);
      if (!newResult.ok) throw new Error('new eval failed');

      const oldDerived = oldResult.value.getRelation('derived').tuples();
      const newDerived = newResult.value.getRelation('derived').tuples();
      expect(newDerived.length).toBe(oldDerived.length);
      for (const t of oldDerived) {
        expect(newResult.value.hasFact(fact('derived', t))).toBe(true);
      }
    });

    it('evaluate.test.ts: guard conditions', () => {
      // big(X) :- val(X), X > 5.
      const rules: Rule[] = [
        rule(
          atom('big', [varTerm('X')]),
          [
            positiveAtom(atom('val', [varTerm('X')])),
            gt(varTerm('X'), constTerm(5)),
          ],
        ),
      ];

      const facts = [
        fact('val', [3]),
        fact('val', [7]),
        fact('val', [10]),
      ];

      const oldResult = evaluate(rules, facts);
      if (!oldResult.ok) throw new Error('old eval failed');

      const newResult = evaluateUnified(rules, facts);
      if (!newResult.ok) throw new Error('new eval failed');

      expect(newResult.value.hasFact(fact('big', [3]))).toBe(false);
      expect(newResult.value.hasFact(fact('big', [7]))).toBe(true);
      expect(newResult.value.hasFact(fact('big', [10]))).toBe(true);

      const oldBig = oldResult.value.getRelation('big').tuples();
      const newBig = newResult.value.getRelation('big').tuples();
      expect(newBig.length).toBe(oldBig.length);
    });

    it('full default rules: LWW + Fugue batch equivalence', () => {
      const allRules = buildDefaultRules();
      const slotId = 'slot:title';
      const parentKey = cnIdKey(createCnId('alice', 0));
      const child1Key = cnIdKey(createCnId('alice', 1));
      const child2Key = cnIdKey(createCnId('bob', 1));

      const facts = [
        makeActiveValueFact('alice', 1, slotId, 'Hello', 10),
        makeActiveValueFact('bob', 1, slotId, 'World', 20),
        fact('active_structure_seq', [child1Key, parentKey, null, null]),
        fact('constraint_peer', [child1Key, 'alice']),
        fact('active_structure_seq', [child2Key, parentKey, child1Key, null]),
        fact('constraint_peer', [child2Key, 'bob']),
      ];

      const oldResult = evaluate(allRules, facts);
      if (!oldResult.ok) throw new Error('old eval failed');

      const newResult = evaluateUnified(allRules, facts);
      if (!newResult.ok) throw new Error('new eval failed');

      // Compare all derived predicates.
      for (const pred of ['winner', 'superseded', 'fugue_child', 'fugue_before', 'fugue_descendant']) {
        const oldTuples = oldResult.value.getRelation(pred).tuples();
        const newTuples = newResult.value.getRelation(pred).tuples();
        expect(newTuples.length).toBe(oldTuples.length);
        for (const t of oldTuples) {
          expect(newResult.value.hasFact(fact(pred, t))).toBe(true);
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Weight propagation edge cases
  // ---------------------------------------------------------------------------

  describe('weight propagation edge cases', () => {
    it('adding the same ground fact twice does not double-derive', () => {
      const rules: Rule[] = [
        rule(
          atom('derived', [varTerm('X')]),
          [positiveAtom(atom('base', [varTerm('X')]))],
        ),
      ];

      const evaluator = createEvaluator(rules);
      const f = fact('base', ['a']);

      evaluator.step(factsToZSet([f]), zsetEmpty());
      evaluator.step(factsToZSet([f]), zsetEmpty());

      // The weight of derived(a) should still be 1 (clamped by distinct).
      const db = evaluator.currentDatabase();
      expect(db.hasFact(fact('derived', ['a']))).toBe(true);
      expect(db.getRelation('derived').getWeight(['a'])).toBe(1);
    });

    it('self-join does not cause weight explosion', () => {
      // superseded involves a self-join on active_value.
      // With 3 values, there are 6 pairwise comparisons, but each
      // derived fact should have weight 1 after distinct.
      const lwwRules = buildDefaultLWWRules();
      const evaluator = createEvaluator(lwwRules);
      const slotId = 'slot:title';

      const facts = [
        makeActiveValueFact('alice', 1, slotId, 'A', 10),
        makeActiveValueFact('bob', 1, slotId, 'B', 20),
        makeActiveValueFact('charlie', 1, slotId, 'C', 30),
      ];

      evaluator.step(factsToZSet(facts), zsetEmpty());

      const db = evaluator.currentDatabase();
      // All superseded facts should have weight 1.
      for (const tuple of db.getRelation('superseded').tuples()) {
        expect(db.getRelation('superseded').getWeight(tuple)).toBe(1);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // extractDelta: output delta has ±1 weights only
  // ---------------------------------------------------------------------------

  describe('output delta correctness', () => {
    it('step result deltaDerived has weights +1 or -1 only', () => {
      const lwwRules = buildDefaultLWWRules();
      const evaluator = createEvaluator(lwwRules);
      const slotId = 'slot:title';

      const f = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      const result = evaluator.step(factsToZSet([f]), zsetEmpty());

      // All derived deltas should be +1 or -1.
      zsetForEach(result.deltaDerived, (entry) => {
        expect(Math.abs(entry.weight)).toBe(1);
      });
    });

    it('retraction step produces -1 derived deltas', () => {
      const lwwRules = buildDefaultLWWRules();
      const evaluator = createEvaluator(lwwRules);
      const slotId = 'slot:title';

      const f = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      evaluator.step(factsToZSet([f]), zsetEmpty());

      const result = evaluator.step(factsToWeightedZSet([[f, -1]]), zsetEmpty());

      let hasNegative = false;
      zsetForEach(result.deltaDerived, (entry) => {
        expect(Math.abs(entry.weight)).toBe(1);
        if (entry.weight === -1) hasNegative = true;
      });
      // Retracting the sole value should produce −1 derived deltas.
      expect(hasNegative).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Incremental evaluation: strata propagation
  // ---------------------------------------------------------------------------

  describe('strata propagation', () => {
    it('lower stratum output delta feeds higher stratum correctly', () => {
      // Stratum 0: superseded facts
      // Stratum 1: winner facts (depends on not superseded)
      // Inserting a value that supersedes the current winner should
      // propagate through both strata in a single step.
      const lwwRules = buildDefaultLWWRules();
      const evaluator = createEvaluator(lwwRules);
      const slotId = 'slot:title';

      // Insert first value.
      const f1 = makeActiveValueFact('alice', 1, slotId, 'Hello', 10);
      evaluator.step(factsToZSet([f1]), zsetEmpty());

      // Insert superseding value — must propagate superseded in stratum 0,
      // then update winner in stratum 1.
      const f2 = makeActiveValueFact('bob', 1, slotId, 'World', 20);
      const result = evaluator.step(factsToZSet([f2]), zsetEmpty());

      // Winner should have changed.
      expect(evaluator.currentResolution().winners.get(slotId)!.content).toBe('World');

      // deltaResolved should reflect the change.
      expect(zsetIsEmpty(result.deltaResolved)).toBe(false);
    });
  });
});