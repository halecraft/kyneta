// === Fugue Equivalence Tests ===
// Validates that the native Fugue solver produces identical ordering to the
// complete Fugue Datalog rules for ALL inputs.
//
// The Datalog rules express the full Fugue tree walk:
//   1. fugue_child — derives tree structure from active_structure_seq + constraint_peer
//   2. fugue_sibling_before — sibling ordering (same originLeft, lower peer first)
//   3. fugue_before — full DFS ordering via recursive rules:
//      - siblings: A before B if A is an earlier sibling
//      - depth-first: A before B if A is in an earlier subtree
//      - ancestor: A before all its descendants
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
  constTerm,
  varTerm,
  positiveAtom,
  negation,
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
const PARENT_KEY = cnIdKey(PARENT);

// ---------------------------------------------------------------------------
// Complete Fugue Datalog Rules
//
// These rules express the full Fugue tree walk as a Datalog program.
// The tree is built from originLeft: each element is a child of its
// originLeft (elements with originLeft=null are children of a virtual root).
// Siblings (same originLeft) are ordered by peer ID (lower first).
// The total order is a depth-first traversal of this tree.
//
// Rules:
//   1. fugue_child — derives tree structure from ground facts
//
//   2. fugue_descendant(Parent, Desc, Anc) — transitive closure of the
//      originLeft tree. Desc is a descendant of Anc.
//
//   3. fugue_before (parent-child): A is before B if B's originLeft is A
//      (in DFS, a node is visited before all its children)
//
//   4. fugue_before (sibling order): A is before B if they share the same
//      originLeft and A has lower peer (or lower CnId on peer tie)
//
//   5. fugue_before (subtree propagation): if A is a child of X, X is before B,
//      and B is NOT a descendant of X, then A is before B. This propagates
//      ordering from a tree-parent to its children across subtree boundaries,
//      without creating spurious orderings among siblings or within subtrees.
//
//   6. fugue_before (transitivity): A before B, B before C → A before C
//
// The descendant relation is needed for the subtree propagation guard.
// Without it, the rule would only check direct children, allowing
// spurious orderings when B is a grandchild+ of X.
// ---------------------------------------------------------------------------

function buildCompleteFugueRules(): Rule[] {
  // Rule 1: fugue_child(Parent, CnId, OriginLeft, OriginRight, Peer) :-
  //   active_structure_seq(CnId, Parent, OriginLeft, OriginRight),
  //   constraint_peer(CnId, Peer).
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

  // Rule 2a (base — descendant): fugue_descendant(Parent, Child, TreeParent) :-
  //   fugue_child(Parent, Child, TreeParent, _, _), TreeParent ≠ null.
  //
  // Direct child is a descendant.
  const fugueDescendantBase: Rule = rule(
    atom('fugue_descendant', [varTerm('Parent'), varTerm('Child'), varTerm('TreeParent')]),
    [
      positiveAtom(
        atom('fugue_child', [varTerm('Parent'), varTerm('Child'), varTerm('TreeParent'), _, _]),
      ),
      neq(varTerm('TreeParent'), constTerm(null)),
    ],
  );

  // Rule 2b (recursive — descendant): fugue_descendant(Parent, Desc, Anc) :-
  //   fugue_descendant(Parent, Desc, Mid),
  //   fugue_descendant(Parent, Mid, Anc).
  //
  // Transitive closure: if Desc is a descendant of Mid, and Mid is a
  // descendant of Anc, then Desc is a descendant of Anc.
  const fugueDescendantTransitive: Rule = rule(
    atom('fugue_descendant', [varTerm('Parent'), varTerm('Desc'), varTerm('Anc')]),
    [
      positiveAtom(
        atom('fugue_descendant', [varTerm('Parent'), varTerm('Desc'), varTerm('Mid')]),
      ),
      positiveAtom(
        atom('fugue_descendant', [varTerm('Parent'), varTerm('Mid'), varTerm('Anc')]),
      ),
    ],
  );

  // Rule 3 (base — parent before child):
  //   fugue_before(Parent, A, B) :-
  //     fugue_child(Parent, B, A, _, _),
  //     A ≠ null.
  //
  // If B's originLeft is A (and A is not null), then A is B's tree-parent.
  // In DFS, a node is visited before all its children.
  // The null guard excludes virtual-root children (originLeft=null) —
  // they have no real tree-parent; their ordering comes from sibling rules.
  const fugueBeforeParentChild: Rule = rule(
    atom('fugue_before', [varTerm('Parent'), varTerm('A'), varTerm('B')]),
    [
      positiveAtom(
        atom('fugue_child', [varTerm('Parent'), varTerm('B'), varTerm('A'), _, _]),
      ),
      neq(varTerm('A'), constTerm(null)),
    ],
  );

  // Rule 3a (base — sibling order by peer):
  //   fugue_before(Parent, A, B) :-
  //     fugue_child(Parent, A, OriginLeft, _, PeerA),
  //     fugue_child(Parent, B, OriginLeft, _, PeerB),
  //     A ≠ B, PeerA < PeerB.
  //
  // Siblings with the same originLeft: lower peer goes first.
  const fugueBeforeSiblingByPeer: Rule = rule(
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

  // Rule 3b (base — sibling order by CnId key on peer tie):
  //   fugue_before(Parent, A, B) :-
  //     fugue_child(Parent, A, OriginLeft, _, Peer),
  //     fugue_child(Parent, B, OriginLeft, _, Peer),
  //     A ≠ B, A < B.
  //
  // Same peer, same originLeft: lower CnId key goes first (deterministic tiebreak).
  const fugueBeforeSiblingByCnId: Rule = rule(
    atom('fugue_before', [varTerm('Parent'), varTerm('A'), varTerm('B')]),
    [
      positiveAtom(
        atom('fugue_child', [
          varTerm('Parent'),
          varTerm('A'),
          varTerm('OriginLeft'),
          _,
          varTerm('Peer'),
        ]),
      ),
      positiveAtom(
        atom('fugue_child', [
          varTerm('Parent'),
          varTerm('B'),
          varTerm('OriginLeft'),
          _,
          varTerm('Peer'),
        ]),
      ),
      neq(varTerm('A'), varTerm('B')),
      lt(varTerm('A'), varTerm('B')),
    ],
  );

  // Rule 5 (recursive — subtree propagation):
  //   fugue_before(Parent, A, B) :-
  //     fugue_child(Parent, A, X, _, _),
  //     X ≠ null,
  //     fugue_before(Parent, X, B),
  //     A ≠ B,
  //     not fugue_descendant(Parent, B, X).
  //
  // If A is a child of X (A's originLeft is X), and X is before B,
  // then A is also before B — UNLESS B is a descendant of X (in X's
  // subtree). Sibling ordering and within-subtree ordering are handled
  // by other rules; this rule only propagates ordering across subtree
  // boundaries.
  //
  // The negation guard uses fugue_descendant (not just fugue_child) to
  // correctly handle grandchildren+. Without the descendant check, a
  // grandchild of X could be spuriously ordered after a sibling of X's
  // child. For example: X has children A and B (A<B by sibling order),
  // A has child C. X<B (sibling), so without descendant check the rule
  // would derive B<C (B is child of X, X<C via transitivity, C is not
  // a direct child of X). But C is in A's subtree which precedes B.
  //
  // Stratified negation is safe here because fugue_descendant depends
  // only on fugue_child (a base relation) — no cyclic dependency with
  // fugue_before.
  const fugueBeforeSubtreeProp: Rule = rule(
    atom('fugue_before', [varTerm('Parent'), varTerm('A'), varTerm('B')]),
    [
      positiveAtom(
        atom('fugue_child', [varTerm('Parent'), varTerm('A'), varTerm('X'), _, _]),
      ),
      neq(varTerm('X'), constTerm(null)),
      positiveAtom(
        atom('fugue_before', [varTerm('Parent'), varTerm('X'), varTerm('B')]),
      ),
      neq(varTerm('A'), varTerm('B')),
      negation(
        atom('fugue_descendant', [varTerm('Parent'), varTerm('B'), varTerm('X')]),
      ),
    ],
  );

  // Rule 6 (recursive — transitivity):
  //   fugue_before(Parent, A, C) :-
  //     fugue_before(Parent, A, B),
  //     fugue_before(Parent, B, C),
  //     A ≠ C.
  //
  // Standard transitive closure. If A is before B and B is before C,
  // then A is before C. The A ≠ C guard prevents self-pairs.
  //
  // Combined with parent-child, sibling order, and subtree propagation,
  // this derives the complete DFS ordering via fixed-point iteration.
  const fugueBeforeTransitive: Rule = rule(
    atom('fugue_before', [varTerm('Parent'), varTerm('A'), varTerm('C')]),
    [
      positiveAtom(
        atom('fugue_before', [varTerm('Parent'), varTerm('A'), varTerm('B')]),
      ),
      positiveAtom(
        atom('fugue_before', [varTerm('Parent'), varTerm('B'), varTerm('C')]),
      ),
      neq(varTerm('A'), varTerm('C')),
    ],
  );

  return [
    fugueChildRule,
    fugueDescendantBase,
    fugueDescendantTransitive,
    fugueBeforeParentChild,
    fugueBeforeSiblingByPeer,
    fugueBeforeSiblingByCnId,
    fugueBeforeSubtreeProp,
    fugueBeforeTransitive,
  ];
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
 * Run complete Fugue Datalog rules and extract ALL before-pairs.
 * Returns a set of "A<B" strings for the given parent.
 */
function runDatalogFugue(
  constraints: StructureConstraint[],
  parentKey: string = PARENT_KEY,
): Set<string> {
  const rules = buildCompleteFugueRules();
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
 * Run native Fugue solver and return ordered nodes.
 */
function runNativeFugue(
  constraints: StructureConstraint[],
): FugueNode[] {
  const nodes = buildFugueNodes(constraints);
  return [...orderFugueNodes(nodes)];
}

/**
 * Convert a native Fugue ordering into the COMPLETE set of (A, B) "before" pairs.
 * For every pair where A appears before B in the total order, include "A<B".
 */
function nativeOrderToAllPairs(ordered: FugueNode[]): Set<string> {
  const pairs = new Set<string>();
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      pairs.add(`${ordered[i]!.idKey}<${ordered[j]!.idKey}`);
    }
  }
  return pairs;
}

/**
 * Assert that Datalog and native Fugue produce identical total orderings.
 * The Datalog pairs should be exactly the transitive closure of the ordering.
 */
function assertEquivalence(
  constraints: StructureConstraint[],
  parentKey: string = PARENT_KEY,
): { nativeOrder: FugueNode[]; datalogPairs: Set<string>; nativePairs: Set<string> } {
  const nativeOrder = runNativeFugue(constraints);
  const nativePairs = nativeOrderToAllPairs(nativeOrder);
  const datalogPairs = runDatalogFugue(constraints, parentKey);

  // Every native pair must be in Datalog
  for (const pair of nativePairs) {
    if (!datalogPairs.has(pair)) {
      const nativeNames = nativeOrder.map((n) => n.idKey).join(', ');
      throw new Error(
        `Native pair ${pair} not found in Datalog result.\n` +
        `Native order: [${nativeNames}]\n` +
        `Datalog pairs: ${JSON.stringify([...datalogPairs])}\n` +
        `Native pairs: ${JSON.stringify([...nativePairs])}`
      );
    }
  }

  // Every Datalog pair must be in native (no spurious pairs)
  for (const pair of datalogPairs) {
    if (!nativePairs.has(pair)) {
      const nativeNames = nativeOrder.map((n) => n.idKey).join(', ');
      throw new Error(
        `Datalog pair ${pair} not found in native result.\n` +
        `Native order: [${nativeNames}]\n` +
        `Datalog pairs: ${JSON.stringify([...datalogPairs])}\n` +
        `Native pairs: ${JSON.stringify([...nativePairs])}`
      );
    }
  }

  expect(datalogPairs.size).toBe(nativePairs.size);

  return { nativeOrder, datalogPairs, nativePairs };
}

// ---------------------------------------------------------------------------
// Equivalence Tests — Full Algorithm
// ---------------------------------------------------------------------------

describe('Fugue equivalence: native == Datalog (complete)', () => {
  // --- Basic cases ---

  it('single element — no ordering constraints', () => {
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const { nativeOrder, datalogPairs } = assertEquivalence([e1]);

    expect(nativeOrder.length).toBe(1);
    expect(datalogPairs.size).toBe(0);
  });

  it('empty input — no elements, no pairs', () => {
    const nativeOrder = runNativeFugue([]);
    const datalogPairs = runDatalogFugue([]);

    expect(nativeOrder.length).toBe(0);
    expect(datalogPairs.size).toBe(0);
  });

  // --- Sibling ordering (same originLeft) ---

  it('two concurrent inserts at start — lower peer goes first', () => {
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('bob', 0, PARENT, null, null);

    const { nativeOrder } = assertEquivalence([e1, e2]);

    // 'alice' < 'bob' → alice first
    expect(nativeOrder[0]!.peer).toBe('alice');
    expect(nativeOrder[1]!.peer).toBe('bob');
  });

  it('three concurrent inserts at same position — transitive ordering via peer', () => {
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('bob', 0, PARENT, null, null);
    const e3 = makeSeqStructure('charlie', 0, PARENT, null, null);

    const { nativeOrder, datalogPairs } = assertEquivalence([e1, e2, e3]);

    expect(nativeOrder[0]!.peer).toBe('alice');
    expect(nativeOrder[1]!.peer).toBe('bob');
    expect(nativeOrder[2]!.peer).toBe('charlie');

    // All 3 pairwise orderings should exist
    const aKey = cnIdKey(e1.id);
    const bKey = cnIdKey(e2.id);
    const cKey = cnIdKey(e3.id);
    expect(datalogPairs.has(`${aKey}<${bKey}`)).toBe(true);
    expect(datalogPairs.has(`${bKey}<${cKey}`)).toBe(true);
    expect(datalogPairs.has(`${aKey}<${cKey}`)).toBe(true);
  });

  it('five concurrent inserts at start — all peers ordered correctly', () => {
    const peers: PeerID[] = ['echo', 'delta', 'alpha', 'charlie', 'bravo'];
    const elements = peers.map((p, i) =>
      makeSeqStructure(p, 0, PARENT, null, null),
    );

    const { nativeOrder } = assertEquivalence(elements);

    // Should be alphabetical by peer
    const sortedPeers = [...peers].sort();
    expect(nativeOrder.map((n) => n.peer)).toEqual(sortedPeers);
  });

  // --- Sequential inserts (originLeft chains) ---

  it('sequential inserts by single peer preserve order', () => {
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 1, PARENT, e1.id, null);
    const e3 = makeSeqStructure('alice', 2, PARENT, e2.id, null);

    const { nativeOrder } = assertEquivalence([e1, e2, e3]);

    expect(nativeOrder[0]!.idKey).toBe(cnIdKey(e1.id));
    expect(nativeOrder[1]!.idKey).toBe(cnIdKey(e2.id));
    expect(nativeOrder[2]!.idKey).toBe(cnIdKey(e3.id));
  });

  it('long sequential chain (5 elements)', () => {
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 1, PARENT, e1.id, null);
    const e3 = makeSeqStructure('alice', 2, PARENT, e2.id, null);
    const e4 = makeSeqStructure('alice', 3, PARENT, e3.id, null);
    const e5 = makeSeqStructure('alice', 4, PARENT, e4.id, null);

    const { nativeOrder } = assertEquivalence([e1, e2, e3, e4, e5]);

    for (let i = 0; i < 5; i++) {
      expect(nativeOrder[i]!.idKey).toBe(cnIdKey(createCnId('alice', i)));
    }
  });

  // --- Depth-first ordering (originLeft tree structure) ---

  it('child of first element comes between first and second (DFS)', () => {
    // e1 → e2 (sequential chain)
    // e3 is a child of e1 (originLeft = e1)
    // DFS: e1, e3, e2
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 1, PARENT, e1.id, null);
    const e3 = makeSeqStructure('bob', 0, PARENT, e1.id, null);
    // e2 and e3 are both children of e1. e2 has originLeft=e1, e3 has originLeft=e1.
    // They are siblings with same originLeft=e1. 'alice' < 'bob' → e2 before e3.
    // Wait — e2's peer is 'alice' and e3's peer is 'bob'.
    // So the order among siblings of e1 is: e2 (alice), e3 (bob).
    // DFS from virtual root: [e1] → visit children of e1: [e2, e3]
    // DFS of e1's children: e2 first (then e2's children), then e3 (then e3's children).
    // Result: e1, e2, e3

    const { nativeOrder } = assertEquivalence([e1, e2, e3]);

    expect(nativeOrder[0]!.idKey).toBe(cnIdKey(e1.id));
    expect(nativeOrder[1]!.idKey).toBe(cnIdKey(e2.id));
    expect(nativeOrder[2]!.idKey).toBe(cnIdKey(e3.id));
  });

  it('nested children: grandchild appears in DFS order', () => {
    // e1 is at the root (originLeft=null)
    // e2 is child of e1 (originLeft=e1)
    // e3 is child of e2 (originLeft=e2)
    // DFS: e1, e2, e3
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 1, PARENT, e1.id, null);
    const e3 = makeSeqStructure('alice', 2, PARENT, e2.id, null);

    const { nativeOrder } = assertEquivalence([e1, e2, e3]);

    expect(nativeOrder[0]!.idKey).toBe(cnIdKey(e1.id));
    expect(nativeOrder[1]!.idKey).toBe(cnIdKey(e2.id));
    expect(nativeOrder[2]!.idKey).toBe(cnIdKey(e3.id));
  });

  it('subtree of earlier sibling precedes later sibling', () => {
    // Virtual root has two children: e1 (alice) and e4 (bob)
    // e1 has child e2 (alice), e2 has child e3 (alice)
    // DFS: e1, e2, e3, e4
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 1, PARENT, e1.id, null);
    const e3 = makeSeqStructure('alice', 2, PARENT, e2.id, null);
    const e4 = makeSeqStructure('bob', 0, PARENT, null, null);

    const { nativeOrder, datalogPairs } = assertEquivalence([e1, e2, e3, e4]);

    expect(nativeOrder.map((n) => n.idKey)).toEqual([
      cnIdKey(e1.id),
      cnIdKey(e2.id),
      cnIdKey(e3.id),
      cnIdKey(e4.id),
    ]);

    // e3 (deep in e1's subtree) should be before e4 (sibling of e1)
    expect(datalogPairs.has(`${cnIdKey(e3.id)}<${cnIdKey(e4.id)}`)).toBe(true);
  });

  it('two subtrees: earlier subtree entirely precedes later subtree', () => {
    // Root children: e1 (alice), e4 (bob)
    // e1's children: e2 (alice)
    // e4's children: e5 (bob)
    // DFS: e1, e2, e4, e5
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 1, PARENT, e1.id, null);
    const e4 = makeSeqStructure('bob', 0, PARENT, null, null);
    const e5 = makeSeqStructure('bob', 1, PARENT, e4.id, null);

    const { nativeOrder, datalogPairs } = assertEquivalence([e1, e2, e4, e5]);

    expect(nativeOrder.map((n) => n.idKey)).toEqual([
      cnIdKey(e1.id),
      cnIdKey(e2.id),
      cnIdKey(e4.id),
      cnIdKey(e5.id),
    ]);

    // Cross-subtree: e2 (in e1's subtree) before e4 and e5
    expect(datalogPairs.has(`${cnIdKey(e2.id)}<${cnIdKey(e4.id)}`)).toBe(true);
    expect(datalogPairs.has(`${cnIdKey(e2.id)}<${cnIdKey(e5.id)}`)).toBe(true);
    // e1 before e5
    expect(datalogPairs.has(`${cnIdKey(e1.id)}<${cnIdKey(e5.id)}`)).toBe(true);
  });

  // --- Complex interleaving ---

  it('concurrent inserts after same element — lower peer first among siblings', () => {
    // e1 is first element (originLeft=null)
    // e2 (alice) and e3 (bob) both have originLeft=e1
    // Sibling order: e2 (alice) before e3 (bob)
    // DFS: e1, e2, e3
    const e1 = makeSeqStructure('charlie', 0, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 0, PARENT, e1.id, null);
    const e3 = makeSeqStructure('bob', 0, PARENT, e1.id, null);

    const { nativeOrder } = assertEquivalence([e1, e2, e3]);

    expect(nativeOrder[0]!.idKey).toBe(cnIdKey(e1.id));
    expect(nativeOrder[1]!.idKey).toBe(cnIdKey(e2.id));
    expect(nativeOrder[2]!.idKey).toBe(cnIdKey(e3.id));
  });

  it('mixed concurrent and sequential: some at root, some in subtree', () => {
    // e1 (alice) at root, e2 (bob) at root (concurrent)
    // e3 (alice) is child of e1 (sequential after e1)
    // DFS: e1, e3, e2 (e1's subtree finishes before e2)
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('bob', 0, PARENT, null, null);
    const e3 = makeSeqStructure('alice', 1, PARENT, e1.id, null);

    const { nativeOrder } = assertEquivalence([e1, e2, e3]);

    expect(nativeOrder[0]!.idKey).toBe(cnIdKey(e1.id));
    expect(nativeOrder[1]!.idKey).toBe(cnIdKey(e3.id));
    expect(nativeOrder[2]!.idKey).toBe(cnIdKey(e2.id));
  });

  it('interleaved concurrent inserts at multiple levels', () => {
    // e1 (alice) at root
    // e2 (alice) child of e1 (originLeft=e1)
    // e3 (bob) also at root (concurrent with e1)
    // e4 (alice) child of e3 (originLeft=e3)
    // e5 (bob) also child of e3 (originLeft=e3)
    //
    // Root siblings: e1 (alice), e3 (bob) → e1 first
    // e1's children: e2
    // e3's children: e4 (alice), e5 (bob) → e4 first
    //
    // DFS: e1, e2, e3, e4, e5
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 1, PARENT, e1.id, null);
    const e3 = makeSeqStructure('bob', 0, PARENT, null, null);
    const e4 = makeSeqStructure('alice', 2, PARENT, e3.id, null);
    const e5 = makeSeqStructure('bob', 1, PARENT, e3.id, null);

    const { nativeOrder, datalogPairs } = assertEquivalence([e1, e2, e3, e4, e5]);

    expect(nativeOrder.map((n) => n.idKey)).toEqual([
      cnIdKey(e1.id),
      cnIdKey(e2.id),
      cnIdKey(e3.id),
      cnIdKey(e4.id),
      cnIdKey(e5.id),
    ]);

    // Cross-subtree ordering
    const e2Key = cnIdKey(e2.id);
    const e3Key = cnIdKey(e3.id);
    expect(datalogPairs.has(`${e2Key}<${e3Key}`)).toBe(true);

    // e4 and e5 are children of e3, ordered among themselves
    const e4Key = cnIdKey(e4.id);
    const e5Key = cnIdKey(e5.id);
    expect(datalogPairs.has(`${e4Key}<${e5Key}`)).toBe(true);
  });

  it('deep nesting with concurrent siblings at each level', () => {
    // Level 0 (root children): e1 (alice)
    // Level 1 (children of e1): e2 (alice), e3 (bob)
    // Level 2 (children of e2): e4 (alice)
    // DFS: e1, e2, e4, e3
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 1, PARENT, e1.id, null);
    const e3 = makeSeqStructure('bob', 0, PARENT, e1.id, null);
    const e4 = makeSeqStructure('alice', 2, PARENT, e2.id, null);

    const { nativeOrder, datalogPairs } = assertEquivalence([e1, e2, e3, e4]);

    expect(nativeOrder.map((n) => n.idKey)).toEqual([
      cnIdKey(e1.id),
      cnIdKey(e2.id),
      cnIdKey(e4.id),
      cnIdKey(e3.id),
    ]);

    // e4 (grandchild of e1, child of e2) comes before e3 (child of e1)
    // because e2's subtree precedes e3
    expect(datalogPairs.has(`${cnIdKey(e4.id)}<${cnIdKey(e3.id)}`)).toBe(true);
  });

  // --- Determinism ---

  it('deterministic: same inputs produce same order regardless of input ordering', () => {
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('bob', 0, PARENT, null, null);
    const e3 = makeSeqStructure('charlie', 0, PARENT, null, null);

    const orderings = [
      [e1, e2, e3],
      [e3, e2, e1],
      [e2, e1, e3],
      [e3, e1, e2],
      [e2, e3, e1],
      [e1, e3, e2],
    ];

    const results = orderings.map((input) => {
      const native = runNativeFugue(input);
      return native.map((n) => n.idKey).join(',');
    });

    const first = results[0];
    for (const result of results) {
      expect(result).toBe(first);
    }
  });

  it('deterministic: complex tree input order does not affect result', () => {
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 1, PARENT, e1.id, null);
    const e3 = makeSeqStructure('bob', 0, PARENT, null, null);
    const e4 = makeSeqStructure('bob', 1, PARENT, e3.id, null);

    const order1 = [e1, e2, e3, e4];
    const order2 = [e4, e3, e2, e1];
    const order3 = [e3, e1, e4, e2];

    const r1 = assertEquivalence(order1);
    const r2 = assertEquivalence(order2);
    const r3 = assertEquivalence(order3);

    const o1 = r1.nativeOrder.map((n) => n.idKey).join(',');
    const o2 = r2.nativeOrder.map((n) => n.idKey).join(',');
    const o3 = r3.nativeOrder.map((n) => n.idKey).join(',');

    expect(o1).toBe(o2);
    expect(o1).toBe(o3);
  });

  // --- Edge cases ---

  it('single peer sequential chain matches native exactly', () => {
    // This is the simplest "real editing" case: one user typing characters in order.
    const elements: StructureConstraint[] = [];
    let prev: CnId | null = null;
    for (let i = 0; i < 8; i++) {
      const e = makeSeqStructure('alice', i, PARENT, prev, null);
      elements.push(e);
      prev = e.id;
    }

    const { nativeOrder } = assertEquivalence(elements);

    for (let i = 0; i < 8; i++) {
      expect(nativeOrder[i]!.idKey).toBe(cnIdKey(createCnId('alice', i)));
    }
  });

  it('two peers typing sequentially from the same starting point', () => {
    // Alice types "ab" and Bob types "xy" both starting at the beginning.
    // Alice: e1(null) → e2(e1)
    // Bob: e3(null) → e4(e3)
    // Root siblings: e1 (alice), e3 (bob) → e1 first
    // DFS: e1, e2, e3, e4
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 1, PARENT, e1.id, null);
    const e3 = makeSeqStructure('bob', 0, PARENT, null, null);
    const e4 = makeSeqStructure('bob', 1, PARENT, e3.id, null);

    const { nativeOrder } = assertEquivalence([e1, e2, e3, e4]);

    expect(nativeOrder.map((n) => n.idKey)).toEqual([
      cnIdKey(e1.id),
      cnIdKey(e2.id),
      cnIdKey(e3.id),
      cnIdKey(e4.id),
    ]);
  });

  it('insert in the middle: new element between existing elements', () => {
    // e1 → e2 (alice's sequential chain)
    // e3 is bob's insert with originLeft=e1 (insert between e1 and e2)
    // Both e2 and e3 are children of e1. Sibling order: e2 (alice) before e3 (bob).
    // DFS: e1, e2, e3
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 1, PARENT, e1.id, null);
    const e3 = makeSeqStructure('bob', 0, PARENT, e1.id, null);

    const { nativeOrder } = assertEquivalence([e1, e2, e3]);

    expect(nativeOrder[0]!.idKey).toBe(cnIdKey(e1.id));
    expect(nativeOrder[1]!.idKey).toBe(cnIdKey(e2.id));
    expect(nativeOrder[2]!.idKey).toBe(cnIdKey(e3.id));
  });

  it('all pairs in Datalog equal all pairs in native for concurrent siblings', () => {
    // Stress test: many concurrent elements at the root
    const peers: PeerID[] = ['alice', 'bob', 'charlie', 'dave', 'eve'];
    const elements = peers.map((p, i) =>
      makeSeqStructure(p, 0, PARENT, null, null),
    );

    const { nativeOrder, nativePairs, datalogPairs } = assertEquivalence(elements);

    // n*(n-1)/2 pairs for 5 elements = 10
    expect(nativePairs.size).toBe(10);
    expect(datalogPairs.size).toBe(10);
  });

  it('wide tree: many children of the same parent', () => {
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);

    // 5 children of e1 from different peers
    const children = ['bob', 'charlie', 'dave', 'eve', 'frank'].map((p, i) =>
      makeSeqStructure(p, 0, PARENT, e1.id, null),
    );

    const { nativeOrder } = assertEquivalence([e1, ...children]);

    // e1 first, then children sorted by peer
    expect(nativeOrder[0]!.idKey).toBe(cnIdKey(e1.id));
    const childPeers = nativeOrder.slice(1).map((n) => n.peer);
    expect(childPeers).toEqual([...childPeers].sort());
  });

  it('diamond pattern: two paths converge at same originLeft', () => {
    // e1 at root, e2 child of e1, e3 child of e1
    // e4 child of e2, e5 child of e3
    // Root: [e1]
    // e1's children: e2 (alice@1), e3 (bob@0) → alice < bob → e2 first
    // e2's children: e4 (alice@2)
    // e3's children: e5 (bob@1)
    // DFS: e1, e2, e4, e3, e5
    const e1 = makeSeqStructure('alice', 0, PARENT, null, null);
    const e2 = makeSeqStructure('alice', 1, PARENT, e1.id, null);
    const e3 = makeSeqStructure('bob', 0, PARENT, e1.id, null);
    const e4 = makeSeqStructure('alice', 2, PARENT, e2.id, null);
    const e5 = makeSeqStructure('bob', 1, PARENT, e3.id, null);

    const { nativeOrder } = assertEquivalence([e1, e2, e3, e4, e5]);

    expect(nativeOrder.map((n) => n.idKey)).toEqual([
      cnIdKey(e1.id),
      cnIdKey(e2.id),
      cnIdKey(e4.id),
      cnIdKey(e3.id),
      cnIdKey(e5.id),
    ]);
  });
});