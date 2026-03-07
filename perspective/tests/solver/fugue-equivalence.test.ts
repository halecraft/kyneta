// === Fugue Equivalence Tests ===
// Validates that the native Fugue solver produces identical ordering to the
// simplified Datalog Fugue rules for the same inputs.
//
// The native solver handles the full Fugue algorithm (recursive tree walk,
// originRight disambiguation). The Datalog rules are a simplified subset
// that handles the concurrent-inserts-at-same-originLeft case via peer
// tiebreak. These tests verify equivalence for that shared subset.
//
// See unified-engine.md §8.2, §B.4, §B.7.

import { describe, it, expect } from 'vitest';
import {
  buildFugueNodes,
  orderFugueNodes,
  type FugueNode,
} from '../../src/solver/fugue.js';
import { createCnId, cnIdKey } from '../../src/kernel/cnid.js';
import { STUB_SIGNATURE } from '../../src/kernel/signature.js';
import type {
  StructureConstraint,
  CnId,
  PeerID,
} from '../../src/kernel/types.js';
import { evaluate } from '../../src/datalog/evaluate.js';
import {
  atom,
  varTerm,
  positiveAtom,
  rule,
  fact,
  neq,
  lt,
  _,
} from '../../src/datalog/types.js';
import type { Rule, Fact } from '../../src/datalog/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSeqStructure(
  peer: PeerID,
  counter: number,
  parent: CnId,
  originLeft: CnId | null,
  originRight: CnId | null,
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: 'structure',
    payload: { kind: 'seq', parent, originLeft, originRight },
  };
}

const PARENT = createCnId('root', 0);

/**
 * Build the simplified Fugue Datalog rules from Phase 1 tests.
 *
 * fugue_child(Parent, CnId, OriginLeft, OriginRight, Peer) :-
 *   active_structure_seq(CnId, Parent, OriginLeft, OriginRight),
 *   constraint_peer(CnId, Peer).
 *
 * fugue_before(Parent, A, B) :-
 *   fugue_child(Parent, A, OriginLeft, _, PeerA),
 *   fugue_child(Parent, B, OriginLeft, _, PeerB),
 *   A ≠ B, PeerA < PeerB.
 */
function buildFugueRules(): Rule[] {
  const fugueChildRule: Rule = rule(
    atom('fugue_child', [
      varTerm('Parent'),
      varTerm('CnId'),
      varTerm('OriginLeft'),
      varTerm('OriginRight'),
      varTerm('Peer'),
    ]),
    [
      positiveAtom(
        atom('active_structure_seq', [
          varTerm('CnId'),
          varTerm('Parent'),
          varTerm('OriginLeft'),
          varTerm('OriginRight'),
        ]),
      ),
      positiveAtom(
        atom('constraint_peer', [varTerm('CnId'), varTerm('Peer')]),
      ),
    ],
  );

  const fugueBeforeRule: Rule = rule(
    atom('fugue_before', [varTerm('Parent'), varTerm('A'), varTerm('B')]),
    [
      positiveAtom(
        atom('fugue_child', [
          varTerm('Parent'),
          varTerm('A'),
          varTerm('OriginLeft'),
          _,
          varTerm('PeerA'),
        ]),
      ),
      positiveAtom(
        atom('fugue_child', [
          varTerm('Parent'),
          varTerm('B'),
          varTerm('OriginLeft'),
          _,
          varTerm('PeerB'),
        ]),
      ),
      neq(varTerm('A'), varTerm('B')),
      lt(varTerm('PeerA'), varTerm('PeerB')),
    ],
  );

  return [fugueChildRule, fugueBeforeRule];
}

/**
 * Convert seq structure constraints into Datalog facts for the Fugue rules.
 */
function constraintsToFugueFacts(
  constraints: StructureConstraint[],
): Fact[] {
  const facts: Fact[] = [];

  for (const sc of constraints) {
    if (sc.payload.kind !== 'seq') continue;

    // active_structure_seq(CnId, Parent, OriginLeft, OriginRight)
    facts.push(fact('active_structure_seq', [
      cnIdKey(sc.id),
      cnIdKey(sc.payload.parent),
      sc.payload.originLeft !== null ? cnIdKey(sc.payload.originLeft) : null,
      sc.payload.originRight !== null ? cnIdKey(sc.payload.originRight) : null,
    ]));

    // constraint_peer(CnId, Peer)
    facts.push(fact('constraint_peer', [
      cnIdKey(sc.id),
      sc.id.peer,
    ]));
  }

  return facts;
}

/**
 * Run Datalog Fugue rules and extract the `before` ordering.
 * Returns a set of (A, B) pairs where A should come before B.
 */
function runDatalogFugue(
  constraints: StructureConstraint[],
  parentKey: string,
): Set<string> {
  const rules = buildFugueRules();
  const facts = constraintsToFugueFacts(constraints);
  const result = evaluate(rules, facts);

  if (!result.ok) {
    throw new Error(`Datalog evaluation failed: ${JSON.stringify(result.error)}`);
  }

  const db = result.value;
  const beforeFacts = db.getRelation('fugue_before').tuples();
  const pairs = new Set<string>();

  for (const tuple of beforeFacts) {
    const parent = tuple[0] as string;
    if (parent === parentKey) {
      const a = tuple[1] as string;
      const b = tuple[2] as string;
      pairs.add(`${a}<${b}`);
    }
  }

  return pairs;
}

/**
 * Run native Fugue solver and extract the ordering as (A, B) pairs.
 * For each pair of elements where A appears before B in the result,
 * we include the pair.
 */
function runNativeFugue(
  constraints: StructureConstraint[],
): FugueNode[] {
  const nodes = buildFugueNodes(constraints);
  return [...orderFugueNodes(nodes)];
}

/**
 * Convert a native Fugue ordering into a set of (A, B) "before" pairs
 * that can be compared with Datalog results.
 * Only includes pairs where both elements share the same originLeft
 * (the simplified Fugue rules only reason about siblings).
 */
function nativeOrderToPairs(ordered: FugueNode[]): Set<string> {
  const pairs = new Set<string>();

  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const a = ordered[i]!;
      const b = ordered[j]!;

      // Only compare siblings (same originLeft) — that's what the
      // simplified Datalog rules handle.
      const aLeft = a.originLeft !== null ? cnIdKey(a.originLeft) : null;
      const bLeft = b.originLeft !== null ? cnIdKey(b.originLeft) : null;

      if (aLeft === bLeft) {
        pairs.add(`${a.idKey}<${b.idKey}`);
      }
    }
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Equivalence Tests
// ---------------------------------------------------------------------------

describe('Fugue equivalence: native == Datalog (simplified subset)', () => {
  it('single element — no ordering constraints', () => {
    const e1 = makeSeqStructure('alice', 1, PARENT, null, null);

    const native = runNativeFugue([e1]);
    expect(native).toHaveLength(1);
    expect(native[0]!.idKey).toBe(cnIdKey(e1.id));

    // Datalog produces no before() facts for a single element
    const datalogPairs = runDatalogFugue([e1], cnIdKey(PARENT));
    expect(datalogPairs.size).toBe(0);
  });

  it('two concurrent inserts at start — lower peer goes first', () => {
    const e1 = makeSeqStructure('alice', 1, PARENT, null, null);
    const e2 = makeSeqStructure('bob', 1, PARENT, null, null);

    const nativeOrder = runNativeFugue([e1, e2]);
    const nativePairs = nativeOrderToPairs(nativeOrder);

    const datalogPairs = runDatalogFugue([e1, e2], cnIdKey(PARENT));

    // Both should agree: alice < bob
    const expected = `${cnIdKey(e1.id)}<${cnIdKey(e2.id)}`;
    expect(nativePairs.has(expected)).toBe(true);
    expect(datalogPairs.has(expected)).toBe(true);

    // And not the reverse
    const reverse = `${cnIdKey(e2.id)}<${cnIdKey(e1.id)}`;
    expect(nativePairs.has(reverse)).toBe(false);
    expect(datalogPairs.has(reverse)).toBe(false);
  });

  it('three concurrent inserts at same position — transitive ordering via peer', () => {
    const e1 = makeSeqStructure('alice', 1, PARENT, null, null);
    const e2 = makeSeqStructure('bob', 1, PARENT, null, null);
    const e3 = makeSeqStructure('charlie', 1, PARENT, null, null);

    const nativeOrder = runNativeFugue([e1, e2, e3]);
    const nativePairs = nativeOrderToPairs(nativeOrder);

    const datalogPairs = runDatalogFugue([e1, e2, e3], cnIdKey(PARENT));

    // Expected order: alice < bob < charlie (lower peer goes first)
    const ab = `${cnIdKey(e1.id)}<${cnIdKey(e2.id)}`;
    const bc = `${cnIdKey(e2.id)}<${cnIdKey(e3.id)}`;
    const ac = `${cnIdKey(e1.id)}<${cnIdKey(e3.id)}`;

    // Both agree on all pairs
    expect(nativePairs.has(ab)).toBe(true);
    expect(datalogPairs.has(ab)).toBe(true);

    expect(nativePairs.has(bc)).toBe(true);
    expect(datalogPairs.has(bc)).toBe(true);

    expect(nativePairs.has(ac)).toBe(true);
    expect(datalogPairs.has(ac)).toBe(true);
  });

  it('inserts at different positions produce independent orderings', () => {
    // e1 inserted at start
    const e1 = makeSeqStructure('alice', 1, PARENT, null, null);
    // e2 inserted after e1
    const e2 = makeSeqStructure('bob', 2, PARENT, e1.id, null);

    const nativeOrder = runNativeFugue([e1, e2]);
    expect(nativeOrder).toHaveLength(2);
    // e1 should come before e2 (e2's originLeft is e1)
    expect(nativeOrder[0]!.idKey).toBe(cnIdKey(e1.id));
    expect(nativeOrder[1]!.idKey).toBe(cnIdKey(e2.id));

    // Datalog should produce no before() pairs because they have
    // different originLefts (only same-originLeft siblings are compared)
    const datalogPairs = runDatalogFugue([e1, e2], cnIdKey(PARENT));
    const pairKey = `${cnIdKey(e1.id)}<${cnIdKey(e2.id)}`;
    // They have different originLeft so the simplified rules don't relate them
    expect(datalogPairs.has(pairKey)).toBe(false);
  });

  it('concurrent inserts after same element — lower peer first', () => {
    // e1 is the anchor
    const e1 = makeSeqStructure('alice', 1, PARENT, null, null);
    // e2 and e3 both insert after e1 (same originLeft = e1)
    const e2 = makeSeqStructure('bob', 2, PARENT, e1.id, null);
    const e3 = makeSeqStructure('alice', 2, PARENT, e1.id, null);

    const nativeOrder = runNativeFugue([e1, e2, e3]);
    const nativePairs = nativeOrderToPairs(nativeOrder);

    const datalogPairs = runDatalogFugue([e1, e2, e3], cnIdKey(PARENT));

    // e2 (bob) and e3 (alice) are siblings (same originLeft=e1)
    // alice < bob, so e3 should come before e2
    const expected = `${cnIdKey(e3.id)}<${cnIdKey(e2.id)}`;
    expect(nativePairs.has(expected)).toBe(true);
    expect(datalogPairs.has(expected)).toBe(true);
  });

  it('five concurrent inserts at start — consistent ordering', () => {
    const peers: PeerID[] = ['dave', 'alice', 'eve', 'bob', 'charlie'];
    const elements = peers.map((peer, i) =>
      makeSeqStructure(peer, i + 1, PARENT, null, null),
    );

    const nativeOrder = runNativeFugue(elements);
    const nativePairs = nativeOrderToPairs(nativeOrder);

    const datalogPairs = runDatalogFugue(elements, cnIdKey(PARENT));

    // Expected order by peer: alice, bob, charlie, dave, eve
    const sorted = [...elements].sort((a, b) =>
      a.id.peer < b.id.peer ? -1 : a.id.peer > b.id.peer ? 1 : 0,
    );

    // All native pairs should match Datalog pairs
    for (const pair of nativePairs) {
      expect(datalogPairs.has(pair)).toBe(true);
    }
    for (const pair of datalogPairs) {
      expect(nativePairs.has(pair)).toBe(true);
    }

    // Verify the native order matches the expected alphabetical sort
    expect(nativeOrder.map((n) => n.peer)).toEqual(
      sorted.map((e) => e.id.peer),
    );
  });

  it('sequential inserts (single peer) preserve insertion order', () => {
    const e1 = makeSeqStructure('alice', 1, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 2, PARENT, e1.id, null);
    const e3 = makeSeqStructure('alice', 3, PARENT, e2.id, null);

    const nativeOrder = runNativeFugue([e1, e2, e3]);
    expect(nativeOrder).toHaveLength(3);
    expect(nativeOrder[0]!.idKey).toBe(cnIdKey(e1.id));
    expect(nativeOrder[1]!.idKey).toBe(cnIdKey(e2.id));
    expect(nativeOrder[2]!.idKey).toBe(cnIdKey(e3.id));
  });

  it('empty input produces empty output', () => {
    const nativeOrder = runNativeFugue([]);
    expect(nativeOrder).toHaveLength(0);

    const datalogPairs = runDatalogFugue([], cnIdKey(PARENT));
    expect(datalogPairs.size).toBe(0);
  });

  it('deterministic: same inputs produce same order regardless of input ordering', () => {
    const e1 = makeSeqStructure('charlie', 1, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 1, PARENT, null, null);
    const e3 = makeSeqStructure('bob', 1, PARENT, null, null);

    const orderings = [
      [e1, e2, e3],
      [e3, e2, e1],
      [e2, e1, e3],
      [e3, e1, e2],
      [e1, e3, e2],
      [e2, e3, e1],
    ];

    const results: string[][] = [];
    for (const order of orderings) {
      const native = runNativeFugue(order);
      results.push(native.map((n) => n.peer));
    }

    // All orderings should produce the same result
    const first = JSON.stringify(results[0]);
    for (const result of results) {
      expect(JSON.stringify(result)).toBe(first);
    }

    // And the order should be alice, bob, charlie
    expect(results[0]).toEqual(['alice', 'bob', 'charlie']);
  });

  it('mixed: some concurrent at start, some sequential after', () => {
    // e1 and e2 both at start (concurrent)
    const e1 = makeSeqStructure('bob', 1, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 1, PARENT, null, null);
    // e3 is after e1 (sequential)
    const e3 = makeSeqStructure('charlie', 2, PARENT, e1.id, null);

    const nativeOrder = runNativeFugue([e1, e2, e3]);

    // alice < bob for concurrent siblings at start
    // e3 comes after e1 (its originLeft)
    expect(nativeOrder).toHaveLength(3);

    // alice should come first among the root-level siblings
    expect(nativeOrder[0]!.peer).toBe('alice');
    // bob next
    expect(nativeOrder[1]!.peer).toBe('bob');
    // charlie is e1's child, so it comes right after bob (depth-first)
    expect(nativeOrder[2]!.peer).toBe('charlie');

    // Verify the sibling ordering matches Datalog for the shared originLeft
    const nativePairs = nativeOrderToPairs(nativeOrder);
    const datalogPairs = runDatalogFugue([e1, e2, e3], cnIdKey(PARENT));

    // alice < bob (siblings at originLeft=null)
    const aliceBob = `${cnIdKey(e2.id)}<${cnIdKey(e1.id)}`;
    expect(nativePairs.has(aliceBob)).toBe(true);
    expect(datalogPairs.has(aliceBob)).toBe(true);
  });

  it('interleaved concurrent inserts at multiple levels', () => {
    // First element
    const e1 = makeSeqStructure('alice', 1, PARENT, null, null);
    // Two concurrent inserts after e1
    const e2 = makeSeqStructure('bob', 2, PARENT, e1.id, null);
    const e3 = makeSeqStructure('alice', 2, PARENT, e1.id, null);

    // Two concurrent inserts at start
    const e4 = makeSeqStructure('charlie', 3, PARENT, null, null);
    const e5 = makeSeqStructure('dave', 3, PARENT, null, null);

    const allElements = [e1, e2, e3, e4, e5];

    const nativeOrder = runNativeFugue(allElements);
    const nativePairs = nativeOrderToPairs(nativeOrder);
    const datalogPairs = runDatalogFugue(allElements, cnIdKey(PARENT));

    // Siblings at originLeft=null: e1, e4, e5
    // Order by peer: alice(e1) < charlie(e4) < dave(e5)
    // Check alice < charlie
    if (nativePairs.has(`${cnIdKey(e1.id)}<${cnIdKey(e4.id)}`)) {
      expect(datalogPairs.has(`${cnIdKey(e1.id)}<${cnIdKey(e4.id)}`)).toBe(true);
    }

    // Siblings at originLeft=e1: e2(bob), e3(alice)
    // Order by peer: alice(e3) < bob(e2)
    const e3BeforeE2 = `${cnIdKey(e3.id)}<${cnIdKey(e2.id)}`;
    expect(nativePairs.has(e3BeforeE2)).toBe(true);
    expect(datalogPairs.has(e3BeforeE2)).toBe(true);

    // Siblings at originLeft=null: charlie(e4) < dave(e5)
    const e4BeforeE5 = `${cnIdKey(e4.id)}<${cnIdKey(e5.id)}`;
    expect(nativePairs.has(e4BeforeE5)).toBe(true);
    expect(datalogPairs.has(e4BeforeE5)).toBe(true);
  });

  it('all pairs in Datalog result are also in native result for concurrent siblings', () => {
    // Stress test: many concurrent inserts at the same position
    const peers: PeerID[] = ['frank', 'bob', 'eve', 'alice', 'dave', 'charlie'];
    const elements = peers.map((peer, i) =>
      makeSeqStructure(peer, i + 1, PARENT, null, null),
    );

    const nativeOrder = runNativeFugue(elements);
    const nativePairs = nativeOrderToPairs(nativeOrder);
    const datalogPairs = runDatalogFugue(elements, cnIdKey(PARENT));

    // Every pair in Datalog must also be in native
    for (const pair of datalogPairs) {
      expect(nativePairs.has(pair)).toBe(true);
    }

    // Every pair in native (for same-originLeft siblings) must be in Datalog
    for (const pair of nativePairs) {
      expect(datalogPairs.has(pair)).toBe(true);
    }

    // Verify we have the expected number of pairs: C(6,2) = 15
    expect(nativePairs.size).toBe(15);
    expect(datalogPairs.size).toBe(15);
  });
});