// === Incremental Fugue Tests ===
// Validates that the native incremental Fugue solver produces correct
// ZSet<FugueBeforePair> deltas and that its accumulated state matches
// the batch `buildNativeFuguePairs` for all insertion orderings.

import { describe, it, expect } from 'vitest';
import { createIncrementalFugue } from '../../src/solver/incremental-fugue.js';
import { createCnId, cnIdKey } from '../../src/kernel/cnid.js';
import { STUB_SIGNATURE } from '../../src/kernel/signature.js';
import { buildStructureIndex } from '../../src/kernel/structure-index.js';
import { buildNativeFuguePairs } from '../../src/kernel/native-resolution.js';
import { fuguePairKey } from '../../src/kernel/resolve.js';
import { ACTIVE_STRUCTURE_SEQ, CONSTRAINT_PEER } from '../../src/kernel/projection.js';
import { fact } from '../../src/datalog/types.js';
import type { Fact } from '../../src/datalog/types.js';
import type { FugueBeforePair } from '../../src/kernel/resolve.js';
import {
  zsetSingleton,
  zsetIsEmpty,
  zsetSize,
  zsetAdd,
  zsetEmpty,
  zsetForEach,
} from '../../src/base/zset.js';
import type { ZSet } from '../../src/base/zset.js';
import type {
  StructureConstraint,
  Constraint,
  CnId,
  PeerID,
} from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PARENT = createCnId('root', 0);
const PARENT_KEY = cnIdKey(PARENT);

const PARENT2 = createCnId('root', 1);
const PARENT2_KEY = cnIdKey(PARENT2);

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

/**
 * Build the active_structure_seq + constraint_peer facts for a seq constraint.
 * Returns two facts that should be fed into the incremental Fugue solver.
 */
function seqToFacts(sc: StructureConstraint): [Fact, Fact] {
  if (sc.payload.kind !== 'seq') throw new Error('not a seq constraint');
  const idKey = cnIdKey(sc.id);
  const structFact = fact(ACTIVE_STRUCTURE_SEQ.predicate, [
    idKey,
    cnIdKey(sc.payload.parent),
    sc.payload.originLeft !== null ? cnIdKey(sc.payload.originLeft) : null,
    sc.payload.originRight !== null ? cnIdKey(sc.payload.originRight) : null,
  ]);
  const peerFact = fact(CONSTRAINT_PEER.predicate, [
    idKey,
    sc.id.peer,
  ]);
  return [structFact, peerFact];
}

/**
 * Insert a seq constraint's facts into the incremental Fugue solver.
 * Both the structure and peer fact are inserted in a single step.
 */
function insertSeq(
  fugue: ReturnType<typeof createIncrementalFugue>,
  sc: StructureConstraint,
): ZSet<FugueBeforePair> {
  const [structFact, peerFact] = seqToFacts(sc);
  const structKey = ACTIVE_STRUCTURE_SEQ.predicate + '|' + cnIdKey(sc.id);
  const peerKey = CONSTRAINT_PEER.predicate + '|' + cnIdKey(sc.id);
  const delta = zsetAdd(
    zsetSingleton(structKey, structFact, 1),
    zsetSingleton(peerKey, peerFact, 1),
  );
  return fugue.step(delta);
}

/**
 * Build batch Fugue pairs from constraints for comparison.
 */
function batchPairs(
  rootStructure: StructureConstraint,
  seqs: StructureConstraint[],
): ReadonlyMap<string, readonly FugueBeforePair[]> {
  const all: Constraint[] = [rootStructure, ...seqs];
  const index = buildStructureIndex(all);
  return buildNativeFuguePairs(all, index);
}

/** Flatten a grouped pairs map to a set of pair keys. */
function pairKeySet(
  grouped: ReadonlyMap<string, readonly FugueBeforePair[]>,
): Set<string> {
  const keys = new Set<string>();
  for (const pairs of grouped.values()) {
    for (const p of pairs) {
      keys.add(fuguePairKey(p));
    }
  }
  return keys;
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

// We need a root structure to make buildStructureIndex happy for batch comparison.
const rootStructure: StructureConstraint = {
  id: PARENT,
  lamport: 0,
  refs: [],
  sig: STUB_SIGNATURE,
  type: 'structure',
  payload: { kind: 'root', containerId: 'list', policy: 'seq' },
};

const rootStructure2: StructureConstraint = {
  id: PARENT2,
  lamport: 1,
  refs: [],
  sig: STUB_SIGNATURE,
  type: 'structure',
  payload: { kind: 'root', containerId: 'list2', policy: 'seq' },
};

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

// Simple linear sequence: A → B → C (each element's originLeft is the previous)
const elemA = makeSeqStructure('alice', 1, PARENT, null, null);
const elemB = makeSeqStructure('alice', 2, PARENT, elemA.id, null);
const elemC = makeSeqStructure('alice', 3, PARENT, elemB.id, null);

// Concurrent insertion: D and E both have originLeft = A (siblings)
const elemD = makeSeqStructure('alice', 4, PARENT, elemA.id, null);
const elemE = makeSeqStructure('bob', 1, PARENT, elemA.id, null);

// Second parent
const elemF = makeSeqStructure('alice', 5, PARENT2, null, null);
const elemG = makeSeqStructure('alice', 6, PARENT2, elemF.id, null);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IncrementalFugue', () => {
  describe('single element', () => {
    it('emits no pairs for first element', () => {
      const fugue = createIncrementalFugue();
      const delta = insertSeq(fugue, elemA);
      expect(zsetIsEmpty(delta)).toBe(true);

      const pairs = fugue.current();
      // No pairs — only one element
      expect(pairs.size).toBe(0);
    });
  });

  describe('two elements', () => {
    it('emits one (a, b) pair when second element arrives', () => {
      const fugue = createIncrementalFugue();
      insertSeq(fugue, elemA);
      const delta = insertSeq(fugue, elemB);

      expect(zsetSize(delta)).toBe(1);
      const entry = [...delta.values()][0]!;
      expect(entry.weight).toBe(1);
      expect(entry.element.parentKey).toBe(PARENT_KEY);

      // current() should have one pair
      const pairs = fugue.current();
      expect(pairs.get(PARENT_KEY)?.length).toBe(1);
    });
  });

  describe('three elements (linear)', () => {
    it('emits correct pair deltas for third element', () => {
      const fugue = createIncrementalFugue();
      insertSeq(fugue, elemA);
      insertSeq(fugue, elemB);
      const delta = insertSeq(fugue, elemC);

      // Adding C to [A, B] → [A, B, C]
      // New pairs: (A,C), (B,C) — pair (A,B) already existed
      expect(zsetSize(delta)).toBe(2);

      // All pairs should be positive
      zsetForEach(delta, (entry) => {
        expect(entry.weight).toBe(1);
      });

      // current() should have 3 pairs total: (A,B), (A,C), (B,C)
      const pairs = fugue.current();
      expect(pairs.get(PARENT_KEY)?.length).toBe(3);
    });
  });

  describe('concurrent siblings', () => {
    it('handles concurrent insertions at same originLeft', () => {
      const fugue = createIncrementalFugue();
      insertSeq(fugue, elemA);
      insertSeq(fugue, elemD); // alice@4, originLeft=A
      insertSeq(fugue, elemE); // bob@1, originLeft=A

      // All three elements should be ordered
      const pairs = fugue.current();
      const pairCount = pairs.get(PARENT_KEY)?.length ?? 0;
      // 3 elements → 3 pairs: (first, second), (first, third), (second, third)
      expect(pairCount).toBe(3);
    });
  });

  describe('ignores non-structure facts', () => {
    it('skips active_value facts', () => {
      const fugue = createIncrementalFugue();
      const otherFact = fact('active_value', ['cn1', 'slot1', 'val', 10, 'alice']);
      const delta = fugue.step(zsetSingleton('other|key', otherFact, 1));
      expect(zsetIsEmpty(delta)).toBe(true);
    });
  });

  describe('ignores retractions', () => {
    it('ignores weight −1 facts (structure is permanent)', () => {
      const fugue = createIncrementalFugue();
      insertSeq(fugue, elemA);

      const [structFact, peerFact] = seqToFacts(elemA);
      const retractDelta = zsetAdd(
        zsetSingleton('s|' + cnIdKey(elemA.id), structFact, -1),
        zsetSingleton('p|' + cnIdKey(elemA.id), peerFact, -1),
      );
      const delta = fugue.step(retractDelta);
      expect(zsetIsEmpty(delta)).toBe(true);

      // Element should still be in state
      expect(fugue.current().size).toBe(0); // 1 element = no pairs, but node exists
    });
  });

  describe('out-of-order: peer fact before structure fact', () => {
    it('completes node when structure arrives after peer', () => {
      const fugue = createIncrementalFugue();

      // Insert peer fact first, then structure fact (in separate steps)
      const [structFact, peerFact] = seqToFacts(elemA);
      const peerKey = CONSTRAINT_PEER.predicate + '|' + cnIdKey(elemA.id);
      fugue.step(zsetSingleton(peerKey, peerFact, 1));

      // Now the structure fact
      const structKey = ACTIVE_STRUCTURE_SEQ.predicate + '|' + cnIdKey(elemA.id);
      fugue.step(zsetSingleton(structKey, structFact, 1));

      // Insert a second element to verify A is in state
      const delta = insertSeq(fugue, elemB);
      expect(zsetSize(delta)).toBe(1); // one pair (A, B)
    });
  });

  describe('multi-parent', () => {
    it('changes to one parent do not affect another', () => {
      const fugue = createIncrementalFugue();

      // Insert into parent 1
      insertSeq(fugue, elemA);
      insertSeq(fugue, elemB);

      // Insert into parent 2
      insertSeq(fugue, elemF);
      const delta = insertSeq(fugue, elemG);

      // Delta should only contain pairs for parent 2
      zsetForEach(delta, (entry) => {
        expect(entry.element.parentKey).toBe(PARENT2_KEY);
      });

      // Both parents should have pairs
      const pairs = fugue.current();
      expect(pairs.has(PARENT_KEY)).toBe(true);
      expect(pairs.has(PARENT2_KEY)).toBe(true);
      expect(pairs.get(PARENT_KEY)!.length).toBe(1); // (A, B)
      expect(pairs.get(PARENT2_KEY)!.length).toBe(1); // (F, G)
    });
  });

  describe('differential: incremental matches batch', () => {
    it('matches batch for linear sequence', () => {
      const seqs = [elemA, elemB, elemC];
      const expected = batchPairs(rootStructure, seqs);
      const expectedKeys = pairKeySet(expected);

      const fugue = createIncrementalFugue();
      for (const sc of seqs) {
        insertSeq(fugue, sc);
      }

      const incKeys = pairKeySet(fugue.current());
      expect(incKeys).toEqual(expectedKeys);
    });

    it('matches batch for concurrent siblings', () => {
      const seqs = [elemA, elemD, elemE];
      const expected = batchPairs(rootStructure, seqs);
      const expectedKeys = pairKeySet(expected);

      const fugue = createIncrementalFugue();
      for (const sc of seqs) {
        insertSeq(fugue, sc);
      }

      const incKeys = pairKeySet(fugue.current());
      expect(incKeys).toEqual(expectedKeys);
    });

    it('matches batch for multi-parent', () => {
      const seqs1 = [elemA, elemB];
      const seqs2 = [elemF, elemG];
      // Need both root structures for batch
      const allStructures: Constraint[] = [rootStructure, rootStructure2, ...seqs1, ...seqs2];
      const index = buildStructureIndex(allStructures);
      const expected = buildNativeFuguePairs(allStructures, index);
      const expectedKeys = pairKeySet(expected);

      const fugue = createIncrementalFugue();
      for (const sc of [...seqs1, ...seqs2]) {
        insertSeq(fugue, sc);
      }

      const incKeys = pairKeySet(fugue.current());
      expect(incKeys).toEqual(expectedKeys);
    });
  });

  describe('permutation: all orderings produce same current()', () => {
    it('3 elements — all 6 orderings match', () => {
      const seqs = [elemA, elemB, elemC];
      const expected = batchPairs(rootStructure, seqs);
      const expectedKeys = pairKeySet(expected);

      for (const perm of permutations(seqs)) {
        const fugue = createIncrementalFugue();
        for (const sc of perm) {
          insertSeq(fugue, sc);
        }
        const incKeys = pairKeySet(fugue.current());
        expect(incKeys).toEqual(expectedKeys);
      }
    });

    it('concurrent siblings — all orderings match', () => {
      const seqs = [elemA, elemD, elemE];
      const expected = batchPairs(rootStructure, seqs);
      const expectedKeys = pairKeySet(expected);

      for (const perm of permutations(seqs)) {
        const fugue = createIncrementalFugue();
        for (const sc of perm) {
          insertSeq(fugue, sc);
        }
        const incKeys = pairKeySet(fugue.current());
        expect(incKeys).toEqual(expectedKeys);
      }
    });
  });

  describe('reset', () => {
    it('clears all state', () => {
      const fugue = createIncrementalFugue();
      insertSeq(fugue, elemA);
      insertSeq(fugue, elemB);
      expect(fugue.current().size).toBe(1); // 1 parent with pairs

      fugue.reset();
      expect(fugue.current().size).toBe(0);
    });
  });
});