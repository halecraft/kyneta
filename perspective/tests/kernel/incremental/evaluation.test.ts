// === Incremental Evaluation Stage Tests ===
// Tests for the evaluation stage wrapper (Plan 006, Phase 4).
//
// Covers:
// - Pure fact router: correctly splits mixed ZSet<Fact> by predicate
// - Rule delta extraction from active-set delta
// - Native path produces correct resolution deltas
// - Strategy switching: native → datalog on custom rule, datalog → native on retraction
// - Batch Datalog fallback produces correct results

import { describe, it, expect } from 'vitest';
import {
  createIncrementalEvaluation,
  routeFactsByPredicate,
  extractRuleDeltasFromActive,
} from '../../../src/kernel/incremental/evaluation.js';
import { createCnId, cnIdKey } from '../../../src/kernel/cnid.js';
import { STUB_SIGNATURE } from '../../../src/kernel/signature.js';
import { buildStructureIndex } from '../../../src/kernel/structure-index.js';
import { ACTIVE_VALUE, ACTIVE_STRUCTURE_SEQ, CONSTRAINT_PEER } from '../../../src/kernel/projection.js';
import { fact } from '../../../src/datalog/types.js';
import type { Fact, Rule } from '../../../src/datalog/types.js';
import {
  zsetEmpty,
  zsetSingleton,
  zsetAdd,
  zsetIsEmpty,
  zsetSize,
  zsetForEach,
} from '../../../src/base/zset.js';
import type { ZSet } from '../../../src/base/zset.js';
import type {
  Constraint,
  StructureConstraint,
  ValueConstraint,
  RuleConstraint,
  CnId,
  PeerID,
  Value,
} from '../../../src/kernel/types.js';
import type { ResolvedWinner, FugueBeforePair } from '../../../src/kernel/resolve.js';
import {
  buildDefaultLWWRules,
  buildDefaultFugueRules,
} from '../../../src/bootstrap.js';
import {
  atom,
  varTerm,
  constTerm,
  positiveAtom,
  negation,
  neq,
  gt,
  eq,
  rule as makeRule,
} from '../../../src/datalog/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStructureRoot(
  peer: PeerID,
  counter: number,
  containerId: string,
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: 'structure',
    payload: { kind: 'root', containerId, policy: 'map' },
  };
}

function makeStructureMap(
  peer: PeerID,
  counter: number,
  parent: CnId,
  key: string,
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: 'structure',
    payload: { kind: 'map', parent, key },
  };
}

function makeValue(
  peer: PeerID,
  counter: number,
  target: CnId,
  content: Value,
  lamport: number,
): ValueConstraint {
  return {
    id: createCnId(peer, counter),
    lamport,
    refs: [],
    sig: STUB_SIGNATURE,
    type: 'value',
    payload: { target, content },
  };
}

function makeRuleConstraint(
  peer: PeerID,
  counter: number,
  layer: number,
  rule: Rule,
): RuleConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: 'rule',
    payload: { layer, head: rule.head, body: rule.body },
  };
}

function makeActiveValueFact(
  peer: PeerID,
  counter: number,
  slotId: string,
  content: Value,
  lamport: number,
): Fact {
  const id = createCnId(peer, counter);
  return fact(ACTIVE_VALUE.predicate, [
    cnIdKey(id),
    slotId,
    content,
    lamport,
    peer,
  ]);
}

function makeSeqStructureFact(
  peer: PeerID,
  counter: number,
  parentKey: string,
  originLeft: string | null,
  originRight: string | null,
): Fact {
  const id = createCnId(peer, counter);
  return fact(ACTIVE_STRUCTURE_SEQ.predicate, [
    cnIdKey(id),
    parentKey,
    originLeft,
    originRight,
  ]);
}

function makePeerFact(
  peer: PeerID,
  counter: number,
): Fact {
  const id = createCnId(peer, counter);
  return fact(CONSTRAINT_PEER.predicate, [
    cnIdKey(id),
    peer,
  ]);
}

// Fixtures
const root = makeStructureRoot('alice', 0, 'doc');
const child1 = makeStructureMap('alice', 1, root.id, 'title');
const structures = [root, child1];

function buildSlotId(): string {
  const all: Constraint[] = [...structures];
  const index = buildStructureIndex(all);
  return index.structureToSlot.get(cnIdKey(child1.id))!;
}

const slotId = buildSlotId();

// ---------------------------------------------------------------------------
// routeFactsByPredicate tests
// ---------------------------------------------------------------------------

describe('routeFactsByPredicate', () => {
  it('routes active_value facts to lwwFacts', () => {
    const f = makeActiveValueFact('alice', 3, slotId, 'Hello', 10);
    const zs = zsetSingleton('k1', f, 1);
    const { lwwFacts, fugueFacts, otherFacts } = routeFactsByPredicate(zs);

    expect(zsetSize(lwwFacts)).toBe(1);
    expect(zsetIsEmpty(fugueFacts)).toBe(true);
    expect(zsetIsEmpty(otherFacts)).toBe(true);
  });

  it('routes active_structure_seq facts to fugueFacts', () => {
    const f = makeSeqStructureFact('alice', 5, 'parent1', null, null);
    const zs = zsetSingleton('k2', f, 1);
    const { lwwFacts, fugueFacts, otherFacts } = routeFactsByPredicate(zs);

    expect(zsetIsEmpty(lwwFacts)).toBe(true);
    expect(zsetSize(fugueFacts)).toBe(1);
    expect(zsetIsEmpty(otherFacts)).toBe(true);
  });

  it('routes constraint_peer facts to fugueFacts', () => {
    const f = makePeerFact('alice', 5);
    const zs = zsetSingleton('k3', f, 1);
    const { lwwFacts, fugueFacts, otherFacts } = routeFactsByPredicate(zs);

    expect(zsetIsEmpty(lwwFacts)).toBe(true);
    expect(zsetSize(fugueFacts)).toBe(1);
    expect(zsetIsEmpty(otherFacts)).toBe(true);
  });

  it('routes unknown predicates to otherFacts', () => {
    const f = fact('some_custom_predicate', ['a', 'b']);
    const zs = zsetSingleton('k4', f, 1);
    const { lwwFacts, fugueFacts, otherFacts } = routeFactsByPredicate(zs);

    expect(zsetIsEmpty(lwwFacts)).toBe(true);
    expect(zsetIsEmpty(fugueFacts)).toBe(true);
    expect(zsetSize(otherFacts)).toBe(1);
  });

  it('correctly splits a mixed delta', () => {
    const valFact = makeActiveValueFact('alice', 3, slotId, 'Hello', 10);
    const seqFact = makeSeqStructureFact('alice', 5, 'parent1', null, null);
    const peerFact = makePeerFact('alice', 5);

    let zs = zsetEmpty<Fact>();
    zs = zsetAdd(zs, zsetSingleton('v1', valFact, 1));
    zs = zsetAdd(zs, zsetSingleton('s1', seqFact, 1));
    zs = zsetAdd(zs, zsetSingleton('p1', peerFact, 1));

    const { lwwFacts, fugueFacts, otherFacts } = routeFactsByPredicate(zs);

    expect(zsetSize(lwwFacts)).toBe(1);
    expect(zsetSize(fugueFacts)).toBe(2); // seq + peer
    expect(zsetIsEmpty(otherFacts)).toBe(true);
  });

  it('returns all empty for empty input', () => {
    const { lwwFacts, fugueFacts, otherFacts } = routeFactsByPredicate(zsetEmpty());
    expect(zsetIsEmpty(lwwFacts)).toBe(true);
    expect(zsetIsEmpty(fugueFacts)).toBe(true);
    expect(zsetIsEmpty(otherFacts)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// extractRuleDeltasFromActive tests
// ---------------------------------------------------------------------------

describe('extractRuleDeltasFromActive', () => {
  it('extracts rule constraints from active delta', () => {
    const lwwRules = buildDefaultLWWRules();
    const rc = makeRuleConstraint('alice', 10, 1, lwwRules[0]!);
    const activeDelta: ZSet<Constraint> = zsetSingleton(cnIdKey(rc.id), rc, 1);

    const ruleDeltas = extractRuleDeltasFromActive(activeDelta);
    expect(zsetSize(ruleDeltas)).toBe(1);

    const entry = [...ruleDeltas.values()][0]!;
    expect(entry.weight).toBe(1);
    expect(entry.element.head.predicate).toBe(lwwRules[0]!.head.predicate);
  });

  it('ignores non-rule constraints', () => {
    const val = makeValue('alice', 3, child1.id, 'Hello', 10);
    const activeDelta: ZSet<Constraint> = zsetSingleton(cnIdKey(val.id), val, 1);

    const ruleDeltas = extractRuleDeltasFromActive(activeDelta);
    expect(zsetIsEmpty(ruleDeltas)).toBe(true);
  });

  it('preserves weight for retracted rules', () => {
    const lwwRules = buildDefaultLWWRules();
    const rc = makeRuleConstraint('alice', 10, 1, lwwRules[0]!);
    const activeDelta: ZSet<Constraint> = zsetSingleton(cnIdKey(rc.id), rc, -1);

    const ruleDeltas = extractRuleDeltasFromActive(activeDelta);
    expect(zsetSize(ruleDeltas)).toBe(1);
    const entry = [...ruleDeltas.values()][0]!;
    expect(entry.weight).toBe(-1);
  });

  it('extracts multiple rules from mixed delta', () => {
    const lwwRules = buildDefaultLWWRules();
    const rc1 = makeRuleConstraint('alice', 10, 1, lwwRules[0]!);
    const rc2 = makeRuleConstraint('alice', 11, 1, lwwRules[1]!);
    const val = makeValue('alice', 3, child1.id, 'Hello', 10);

    let activeDelta: ZSet<Constraint> = zsetEmpty();
    activeDelta = zsetAdd(activeDelta, zsetSingleton(cnIdKey(rc1.id), rc1, 1));
    activeDelta = zsetAdd(activeDelta, zsetSingleton(cnIdKey(rc2.id), rc2, 1));
    activeDelta = zsetAdd(activeDelta, zsetSingleton(cnIdKey(val.id), val, 1));

    const ruleDeltas = extractRuleDeltasFromActive(activeDelta);
    expect(zsetSize(ruleDeltas)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// IncrementalEvaluation — native path tests
// ---------------------------------------------------------------------------

describe('IncrementalEvaluation', () => {
  describe('native path', () => {
    it('produces winner delta for a single active_value fact', () => {
      const evaluation = createIncrementalEvaluation();
      const f = makeActiveValueFact('alice', 3, slotId, 'Hello', 10);
      const deltaFacts = zsetSingleton('v|' + cnIdKey(createCnId('alice', 3)), f, 1);

      const { deltaResolved, deltaFuguePairs } = evaluation.step(
        deltaFacts,
        zsetEmpty(),
        () => [],
        () => [],
        () => buildStructureIndex([]),
      );

      expect(zsetSize(deltaResolved)).toBe(1);
      const winnerEntry = [...deltaResolved.values()][0]!;
      expect(winnerEntry.weight).toBe(1);
      expect(winnerEntry.element.slotId).toBe(slotId);
      expect(winnerEntry.element.content).toBe('Hello');

      expect(zsetIsEmpty(deltaFuguePairs)).toBe(true);
    });

    it('superseding value produces +1 replacement delta', () => {
      const evaluation = createIncrementalEvaluation();

      const f1 = makeActiveValueFact('alice', 3, slotId, 'Hello', 10);
      const f2 = makeActiveValueFact('bob', 1, slotId, 'World', 20);

      evaluation.step(
        zsetSingleton('v|' + cnIdKey(createCnId('alice', 3)), f1, 1),
        zsetEmpty(),
        () => [],
        () => [],
        () => buildStructureIndex([]),
      );

      const { deltaResolved } = evaluation.step(
        zsetSingleton('v|' + cnIdKey(createCnId('bob', 1)), f2, 1),
        zsetEmpty(),
        () => [],
        () => [],
        () => buildStructureIndex([]),
      );

      expect(zsetSize(deltaResolved)).toBe(1);
      const entry = [...deltaResolved.values()][0]!;
      expect(entry.weight).toBe(1);
      expect(entry.element.content).toBe('World');
    });

    it('empty delta produces empty result', () => {
      const evaluation = createIncrementalEvaluation();
      const { deltaResolved, deltaFuguePairs } = evaluation.step(
        zsetEmpty(),
        zsetEmpty(),
        () => [],
        () => [],
        () => buildStructureIndex([]),
      );
      expect(zsetIsEmpty(deltaResolved)).toBe(true);
      expect(zsetIsEmpty(deltaFuguePairs)).toBe(true);
    });

    it('current() returns materialized ResolutionResult', () => {
      const evaluation = createIncrementalEvaluation();

      const f = makeActiveValueFact('alice', 3, slotId, 'Hello', 10);
      evaluation.step(
        zsetSingleton('v|' + cnIdKey(createCnId('alice', 3)), f, 1),
        zsetEmpty(),
        () => [],
        () => [],
        () => buildStructureIndex([]),
      );

      const result = evaluation.current();
      expect(result.winners.size).toBe(1);
      expect(result.winners.get(slotId)!.content).toBe('Hello');
    });

    it('processes Fugue facts through native solver', () => {
      const evaluation = createIncrementalEvaluation();
      const parentKey = cnIdKey(createCnId('root', 0));

      const elem1 = createCnId('alice', 1);
      const elem2 = createCnId('alice', 2);

      // First element: structure + peer
      const sf1 = makeSeqStructureFact('alice', 1, parentKey, null, null);
      const pf1 = makePeerFact('alice', 1);
      let delta1 = zsetEmpty<Fact>();
      delta1 = zsetAdd(delta1, zsetSingleton('s|' + cnIdKey(elem1), sf1, 1));
      delta1 = zsetAdd(delta1, zsetSingleton('p|' + cnIdKey(elem1), pf1, 1));

      const r1 = evaluation.step(
        delta1,
        zsetEmpty(),
        () => [],
        () => [],
        () => buildStructureIndex([]),
      );

      // First element alone — no pairs
      expect(zsetIsEmpty(r1.deltaFuguePairs)).toBe(true);

      // Second element
      const sf2 = makeSeqStructureFact('alice', 2, parentKey, cnIdKey(elem1), null);
      const pf2 = makePeerFact('alice', 2);
      let delta2 = zsetEmpty<Fact>();
      delta2 = zsetAdd(delta2, zsetSingleton('s|' + cnIdKey(elem2), sf2, 1));
      delta2 = zsetAdd(delta2, zsetSingleton('p|' + cnIdKey(elem2), pf2, 1));

      const r2 = evaluation.step(
        delta2,
        zsetEmpty(),
        () => [],
        () => [],
        () => buildStructureIndex([]),
      );

      // Should have one pair
      expect(zsetSize(r2.deltaFuguePairs)).toBe(1);
      const pairEntry = [...r2.deltaFuguePairs.values()][0]!;
      expect(pairEntry.weight).toBe(1);
      expect(pairEntry.element.parentKey).toBe(parentKey);
    });
  });

  describe('strategy switching', () => {
    // Build a custom Layer 2 rule that overrides LWW — e.g., always pick
    // the value with the lowest lamport instead of highest.
    const customSupersededRule = makeRule(
      atom('superseded', [varTerm('CnId'), varTerm('Slot')]),
      [
        positiveAtom(
          atom('active_value', [
            varTerm('CnId'), varTerm('Slot'), varTerm('_V1'), varTerm('L1'), varTerm('_P1'),
          ]),
        ),
        positiveAtom(
          atom('active_value', [
            varTerm('CnId2'), varTerm('Slot'), varTerm('_V2'), varTerm('L2'), varTerm('_P2'),
          ]),
        ),
        neq(varTerm('CnId'), varTerm('CnId2')),
        // REVERSED: L2 < L1 means higher lamport gets superseded (lowest wins)
        gt(varTerm('L1'), varTerm('L2')),
      ],
    );

    it('switches to datalog when custom Layer 2 rule is added', () => {
      const evaluation = createIncrementalEvaluation();

      // Insert a value via native path
      const f = makeActiveValueFact('alice', 3, slotId, 'Hello', 10);
      evaluation.step(
        zsetSingleton('v|' + cnIdKey(createCnId('alice', 3)), f, 1),
        zsetEmpty(),
        () => [],
        () => [],
        () => buildStructureIndex([]),
      );

      // Now add a custom rule — create all needed default + custom rules
      const allDefaultRules = [...buildDefaultLWWRules(), ...buildDefaultFugueRules()];
      const defaultRuleConstraints: RuleConstraint[] = allDefaultRules.map((r, i) =>
        makeRuleConstraint('alice', 100 + i, 1, r),
      );
      const customRuleConstraint = makeRuleConstraint('alice', 200, 2, customSupersededRule);

      const allActiveConstraints: Constraint[] = [
        ...defaultRuleConstraints,
        customRuleConstraint,
      ];

      // The active_value fact for projection.current()
      const accFacts = [f];

      // Create rule delta (custom rule became active)
      const ruleDelta: ZSet<Rule> = zsetSingleton(
        cnIdKey(customRuleConstraint.id),
        customSupersededRule,
        1,
      );

      // This should trigger a strategy switch to datalog
      const { deltaResolved } = evaluation.step(
        zsetEmpty(),
        ruleDelta,
        () => accFacts,
        () => allActiveConstraints,
        () => buildStructureIndex([]),
      );

      // After strategy switch, the result should still have a winner
      // (the custom rule changes WHICH value wins, but with one value it's the same)
      const current = evaluation.current();
      expect(current.winners.size).toBe(1);
    });

    it('switches back to native when custom rule is retracted', () => {
      const evaluation = createIncrementalEvaluation();

      // Start with default + custom rules (strategy = datalog)
      const allDefaultRules = [...buildDefaultLWWRules(), ...buildDefaultFugueRules()];
      const defaultRuleConstraints: RuleConstraint[] = allDefaultRules.map((r, i) =>
        makeRuleConstraint('alice', 100 + i, 1, r),
      );
      const customRuleConstraint = makeRuleConstraint('alice', 200, 2, customSupersededRule);

      const allWithCustom: Constraint[] = [
        ...defaultRuleConstraints,
        customRuleConstraint,
      ];

      // Force into datalog mode by adding the custom rule
      evaluation.step(
        zsetEmpty(),
        zsetSingleton(cnIdKey(customRuleConstraint.id), customSupersededRule, 1),
        () => [],
        () => allWithCustom,
        () => buildStructureIndex([]),
      );

      // Now retract the custom rule — should switch back to native
      const allDefaultOnly: Constraint[] = [...defaultRuleConstraints];

      evaluation.step(
        zsetEmpty(),
        zsetSingleton(cnIdKey(customRuleConstraint.id), customSupersededRule, -1),
        () => [],
        () => allDefaultOnly,
        () => buildStructureIndex([]),
      );

      // Verify we can insert a value fact and get a native-path delta
      const f = makeActiveValueFact('alice', 3, slotId, 'Hello', 10);
      const { deltaResolved } = evaluation.step(
        zsetSingleton('v|' + cnIdKey(createCnId('alice', 3)), f, 1),
        zsetEmpty(),
        () => [f],
        () => allDefaultOnly,
        () => buildStructureIndex([]),
      );

      expect(zsetSize(deltaResolved)).toBe(1);
      expect([...deltaResolved.values()][0]!.element.content).toBe('Hello');
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      const evaluation = createIncrementalEvaluation();

      const f = makeActiveValueFact('alice', 3, slotId, 'Hello', 10);
      evaluation.step(
        zsetSingleton('v|' + cnIdKey(createCnId('alice', 3)), f, 1),
        zsetEmpty(),
        () => [],
        () => [],
        () => buildStructureIndex([]),
      );

      expect(evaluation.current().winners.size).toBe(1);

      evaluation.reset();
      expect(evaluation.current().winners.size).toBe(0);
    });
  });
});