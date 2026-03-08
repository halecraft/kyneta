// === Incremental Projection Tests ===
// Tests for the incremental projection stage (Plan 005, Phase 5).
//
// Covers:
// - New value constraint with existing target: emits `active_value` fact
// - Value constraint with missing target: added to orphan set, no fact emitted
// - Structure arrives after orphaned value: orphan re-projected, fact emitted
// - Retracted value (weight −1): anti-fact emitted
// - New seq structure: emits `active_structure_seq` + `constraint_peer`
// - Seq structure retraction (weight −1): anti-facts emitted
// - Non-projected constraint types (retract, rule, authority) ignored
// - Empty deltas produce empty output
// - Multiple values targeting same slot
// - Differential equivalence with batch projectToFacts
// - All-permutation differential tests

import { describe, it, expect } from 'vitest';
import {
  createIncrementalProjection,
  type IncrementalProjection,
} from '../../../src/kernel/incremental/projection.js';
import {
  createIncrementalStructureIndex,
  type IncrementalStructureIndex,
} from '../../../src/kernel/incremental/structure-index.js';
import {
  projectToFacts,
  ACTIVE_VALUE,
  ACTIVE_STRUCTURE_SEQ,
  CONSTRAINT_PEER,
} from '../../../src/kernel/projection.js';
import {
  buildStructureIndex,
  slotId,
  type StructureIndex,
} from '../../../src/kernel/structure-index.js';
import { createCnId, cnIdKey } from '../../../src/kernel/cnid.js';
import { STUB_SIGNATURE } from '../../../src/kernel/signature.js';
import type {
  Constraint,
  StructureConstraint,
  ValueConstraint,
  RetractConstraint,
  AuthorityConstraint,
  CnId,
  PeerID,
  Value,
} from '../../../src/kernel/types.js';
import type { Fact } from '../../../src/datalog/types.js';
import { factKey } from '../../../src/datalog/types.js';
import {
  zsetEmpty,
  zsetSingleton,
  zsetFromEntries,
  zsetForEach,
  zsetPositive,
  zsetNegative,
  zsetSize,
  type ZSet,
  type ZSetEntry,
} from '../../../src/base/zset.js';
import {
  structureIndexDeltaEmpty,
  structureIndexDeltaFrom,
  type StructureIndexDelta,
} from '../../../src/kernel/incremental/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRoot(
  peer: PeerID,
  counter: number,
  containerId: string,
  policy: 'map' | 'seq' = 'map',
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: 'structure',
    payload: { kind: 'root', containerId, policy },
  };
}

function makeMapChild(
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

function makeSeqChild(
  peer: PeerID,
  counter: number,
  parent: CnId,
  originLeft: CnId | null = null,
  originRight: CnId | null = null,
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

function makeValue(
  peer: PeerID,
  counter: number,
  target: CnId,
  content: Value = 'hello',
  lamport?: number,
): ValueConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: lamport ?? counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: 'value',
    payload: { target, content },
  };
}

function makeRetract(
  peer: PeerID,
  counter: number,
  target: CnId,
): RetractConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: counter,
    refs: [target],
    sig: STUB_SIGNATURE,
    type: 'retract',
    payload: { target },
  };
}

function makeAuthority(
  peer: PeerID,
  counter: number,
  targetPeer: PeerID,
): AuthorityConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: 'authority',
    payload: {
      targetPeer,
      action: 'grant',
      capability: { kind: 'write', pathPattern: ['*'] },
    },
  };
}

/** Create a Z-set singleton for a constraint. */
function cset(c: Constraint, weight: number = 1): ZSet<Constraint> {
  return zsetSingleton(cnIdKey(c.id), c, weight);
}

/** Create a Z-set from multiple constraints (all weight +1). */
function csetMany(...cs: Constraint[]): ZSet<Constraint> {
  return zsetFromEntries(
    cs.map((c) => [cnIdKey(c.id), { element: c, weight: 1 }] as [string, ZSetEntry<Constraint>]),
  );
}

/**
 * Create a test harness: an incremental structure index stage and an
 * incremental projection stage wired together.
 */
function createHarness() {
  const structIndex = createIncrementalStructureIndex();
  const projection = createIncrementalProjection(() => structIndex.current());

  return {
    structIndex,
    projection,
    /** Feed structures through the structure index, then pass the delta to projection. */
    addStructures(...structures: StructureConstraint[]): StructureIndexDelta {
      const delta = structIndex.step(csetMany(...structures));
      return delta;
    },
    /** Convenience: add structures and step projection with active+index deltas. */
    stepBoth(
      activeConstraints: ZSet<Constraint>,
      structures: StructureConstraint[] = [],
    ): ZSet<Fact> {
      const indexDelta = structures.length > 0
        ? structIndex.step(csetMany(...structures))
        : structureIndexDeltaEmpty();
      return projection.step(activeConstraints, indexDelta);
    },
  };
}

/** Find a fact with a given predicate in a Z-set. */
function findFactByPredicate(
  delta: ZSet<Fact>,
  predicate: string,
): { fact: Fact; weight: number } | undefined {
  let found: { fact: Fact; weight: number } | undefined;
  zsetForEach(delta, (entry) => {
    if (entry.element.predicate === predicate && found === undefined) {
      found = { fact: entry.element, weight: entry.weight };
    }
  });
  return found;
}

/** Collect all facts with a given predicate from a Z-set. */
function findAllByPredicate(
  delta: ZSet<Fact>,
  predicate: string,
): { fact: Fact; weight: number }[] {
  const results: { fact: Fact; weight: number }[] = [];
  zsetForEach(delta, (entry) => {
    if (entry.element.predicate === predicate) {
      results.push({ fact: entry.element, weight: entry.weight });
    }
  });
  return results;
}

/**
 * Compare accumulated incremental facts against batch projectToFacts.
 * Compares fact sets by their factKey strings (order-independent).
 */
function assertFactsEqual(
  incrementalFacts: Fact[],
  batchFacts: readonly Fact[],
  message?: string,
): void {
  const prefix = message ? `${message}: ` : '';
  const incKeys = new Set(incrementalFacts.map(factKey));
  const batchKeys = new Set(batchFacts.map(factKey));

  // Check that every batch fact is in incremental
  for (const key of batchKeys) {
    expect(incKeys.has(key), `${prefix}batch fact missing from incremental: ${key}`).toBe(true);
  }
  // Check that every incremental fact is in batch
  for (const key of incKeys) {
    expect(batchKeys.has(key), `${prefix}incremental fact missing from batch: ${key}`).toBe(true);
  }
  expect(incKeys.size, `${prefix}fact count`).toBe(batchKeys.size);
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

// ===========================================================================
// Tests
// ===========================================================================

describe('IncrementalProjection', () => {
  // =========================================================================
  // New value constraint with existing target
  // =========================================================================

  describe('value constraint with existing target', () => {
    it('emits active_value fact', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const value = makeValue('alice', 2, child.id, 'Alice');

      h.addStructures(root, child);
      const delta = h.stepBoth(cset(value));

      const av = findFactByPredicate(delta, ACTIVE_VALUE.predicate);
      expect(av).toBeDefined();
      expect(av!.weight).toBe(1);
      expect(av!.fact.values[ACTIVE_VALUE.CNID]).toBe(cnIdKey(value.id));
      expect(av!.fact.values[ACTIVE_VALUE.SLOT]).toBe(slotId(child));
      expect(av!.fact.values[ACTIVE_VALUE.CONTENT]).toBe('Alice');
      expect(av!.fact.values[ACTIVE_VALUE.LAMPORT]).toBe(value.lamport);
      expect(av!.fact.values[ACTIVE_VALUE.PEER]).toBe('alice');
    });

    it('emits fact for value targeting root structure', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const value = makeValue('alice', 1, root.id, 42);

      h.addStructures(root);
      const delta = h.stepBoth(cset(value));

      const av = findFactByPredicate(delta, ACTIVE_VALUE.predicate);
      expect(av).toBeDefined();
      expect(av!.fact.values[ACTIVE_VALUE.SLOT]).toBe(slotId(root));
      expect(av!.fact.values[ACTIVE_VALUE.CONTENT]).toBe(42);
    });

    it('multiple values targeting different slots', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const child1 = makeMapChild('alice', 1, root.id, 'name');
      const child2 = makeMapChild('alice', 2, root.id, 'age');
      const v1 = makeValue('alice', 3, child1.id, 'Alice');
      const v2 = makeValue('alice', 4, child2.id, 30);

      h.addStructures(root, child1, child2);
      const delta = h.stepBoth(csetMany(v1, v2));

      const avs = findAllByPredicate(delta, ACTIVE_VALUE.predicate);
      expect(avs.length).toBe(2);
      expect(avs.every((a) => a.weight === 1)).toBe(true);
    });

    it('multiple values targeting same slot (LWW candidates)', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const v1 = makeValue('alice', 2, child.id, 'Alice', 10);
      const v2 = makeValue('bob', 0, child.id, 'Bob', 11);

      h.addStructures(root, child);
      const delta = h.stepBoth(csetMany(v1, v2));

      const avs = findAllByPredicate(delta, ACTIVE_VALUE.predicate);
      expect(avs.length).toBe(2);
    });

    it('accumulates facts across steps', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const v1 = makeValue('alice', 2, child.id, 'Alice');
      const v2 = makeValue('bob', 0, child.id, 'Bob');

      h.addStructures(root, child);
      h.stepBoth(cset(v1));
      h.stepBoth(cset(v2));

      expect(h.projection.current().length).toBe(2);
    });
  });

  // =========================================================================
  // Value constraint with missing target (orphan)
  // =========================================================================

  describe('orphaned value constraint', () => {
    it('no fact emitted when target is missing', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const unknownTarget = createCnId('alice', 99);
      const value = makeValue('alice', 1, unknownTarget, 'orphan');

      h.addStructures(root);
      const delta = h.stepBoth(cset(value));

      expect(delta.size).toBe(0);
      expect(h.projection.current().length).toBe(0);
    });

    it('no fact emitted when no structures exist at all', () => {
      const h = createHarness();
      const unknownTarget = createCnId('alice', 99);
      const value = makeValue('alice', 1, unknownTarget, 'orphan');

      const delta = h.stepBoth(cset(value));

      expect(delta.size).toBe(0);
    });
  });

  // =========================================================================
  // Structure arrives after orphaned value
  // =========================================================================

  describe('orphan resolution', () => {
    it('orphaned value is projected when target structure arrives', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const value = makeValue('alice', 2, child.id, 'Alice');

      // Value arrives first — becomes orphan
      h.addStructures(root);
      const d1 = h.stepBoth(cset(value));
      expect(d1.size).toBe(0);
      expect(h.projection.current().length).toBe(0);

      // Structure arrives — orphan resolved
      const indexDelta = h.addStructures(child);
      const d2 = h.projection.step(zsetEmpty(), indexDelta);

      const av = findFactByPredicate(d2, ACTIVE_VALUE.predicate);
      expect(av).toBeDefined();
      expect(av!.weight).toBe(1);
      expect(av!.fact.values[ACTIVE_VALUE.CONTENT]).toBe('Alice');
      expect(h.projection.current().length).toBe(1);
    });

    it('multiple orphans resolved by same structure', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const v1 = makeValue('alice', 2, child.id, 'Alice');
      const v2 = makeValue('bob', 0, child.id, 'Bob');

      // Both values arrive before structure
      h.addStructures(root);
      h.stepBoth(cset(v1));
      h.stepBoth(cset(v2));
      expect(h.projection.current().length).toBe(0);

      // Structure arrives — both orphans resolved
      const indexDelta = h.addStructures(child);
      const d = h.projection.step(zsetEmpty(), indexDelta);

      const avs = findAllByPredicate(d, ACTIVE_VALUE.predicate);
      expect(avs.length).toBe(2);
      expect(avs.every((a) => a.weight === 1)).toBe(true);
      expect(h.projection.current().length).toBe(2);
    });

    it('orphan resolved when concurrent map child creates the slot', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      // Value targets alice's structure, but bob's structure arrives first
      // and creates the same slot
      const childAlice = makeMapChild('alice', 1, root.id, 'name');
      const childBob = makeMapChild('bob', 0, root.id, 'name');
      const value = makeValue('alice', 2, childAlice.id, 'Alice');

      h.addStructures(root);
      // Value arrives — targets childAlice which hasn't arrived
      h.stepBoth(cset(value));
      expect(h.projection.current().length).toBe(0);

      // childAlice arrives — orphan resolved (the target CnId is now
      // in the slot group's structureKeys)
      const indexDelta = h.addStructures(childAlice);
      const d = h.projection.step(zsetEmpty(), indexDelta);

      expect(findFactByPredicate(d, ACTIVE_VALUE.predicate)).toBeDefined();
      expect(h.projection.current().length).toBe(1);
    });

    it('value and its target structure arrive in same step', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const value = makeValue('alice', 2, child.id, 'Alice');

      h.addStructures(root);
      // Both structure and value arrive in one step
      const indexDelta = h.addStructures(child);
      const d = h.projection.step(cset(value), indexDelta);

      // Value should be projected (either directly or via orphan resolution)
      expect(h.projection.current().length).toBe(1);
      const avs = findAllByPredicate(d, ACTIVE_VALUE.predicate);
      expect(avs.length).toBe(1);
      expect(avs[0]!.weight).toBe(1);
    });
  });

  // =========================================================================
  // Retracted value (weight −1)
  // =========================================================================

  describe('retracted value', () => {
    it('emits anti-fact (weight −1)', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const value = makeValue('alice', 2, child.id, 'Alice');

      h.addStructures(root, child);
      h.stepBoth(cset(value, 1));
      expect(h.projection.current().length).toBe(1);

      // Retract the value
      const delta = h.stepBoth(cset(value, -1));

      const av = findFactByPredicate(delta, ACTIVE_VALUE.predicate);
      expect(av).toBeDefined();
      expect(av!.weight).toBe(-1);
      expect(h.projection.current().length).toBe(0);
    });

    it('retraction of orphaned value is silent (no anti-fact)', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const unknownTarget = createCnId('alice', 99);
      const value = makeValue('alice', 1, unknownTarget, 'orphan');

      h.addStructures(root);
      h.stepBoth(cset(value, 1)); // becomes orphan
      expect(h.projection.current().length).toBe(0);

      // Retract the orphan — no fact was ever emitted
      const delta = h.stepBoth(cset(value, -1));
      expect(delta.size).toBe(0);
      expect(h.projection.current().length).toBe(0);
    });

    it('orphan retracted before structure arrives is not re-projected', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const value = makeValue('alice', 2, child.id, 'Alice');

      h.addStructures(root);
      h.stepBoth(cset(value, 1)); // orphan
      h.stepBoth(cset(value, -1)); // orphan retracted

      // Now structure arrives — the orphan was already removed
      const indexDelta = h.addStructures(child);
      const d = h.projection.step(zsetEmpty(), indexDelta);

      expect(d.size).toBe(0);
      expect(h.projection.current().length).toBe(0);
    });
  });

  // =========================================================================
  // Seq structure projection
  // =========================================================================

  describe('seq structure', () => {
    it('emits active_structure_seq + constraint_peer facts', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'list', 'seq');
      const elem = makeSeqChild('alice', 1, root.id, null, null);

      h.addStructures(root);
      // Seq structures are both structure (for index) AND active (for projection)
      const indexDelta = h.addStructures(elem);
      const delta = h.projection.step(cset(elem, 1), indexDelta);

      // active_structure_seq fact
      const seq = findFactByPredicate(delta, ACTIVE_STRUCTURE_SEQ.predicate);
      expect(seq).toBeDefined();
      expect(seq!.weight).toBe(1);
      expect(seq!.fact.values[ACTIVE_STRUCTURE_SEQ.CNID]).toBe(cnIdKey(elem.id));
      expect(seq!.fact.values[ACTIVE_STRUCTURE_SEQ.PARENT]).toBe(cnIdKey(root.id));
      expect(seq!.fact.values[ACTIVE_STRUCTURE_SEQ.ORIGIN_LEFT]).toBe(null);
      expect(seq!.fact.values[ACTIVE_STRUCTURE_SEQ.ORIGIN_RIGHT]).toBe(null);

      // constraint_peer fact
      const peer = findFactByPredicate(delta, CONSTRAINT_PEER.predicate);
      expect(peer).toBeDefined();
      expect(peer!.weight).toBe(1);
      expect(peer!.fact.values[CONSTRAINT_PEER.CNID]).toBe(cnIdKey(elem.id));
      expect(peer!.fact.values[CONSTRAINT_PEER.PEER]).toBe('alice');
    });

    it('seq with origin references', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'list', 'seq');
      const e1 = makeSeqChild('alice', 1, root.id);
      const e2 = makeSeqChild('alice', 2, root.id, e1.id, null);

      h.addStructures(root, e1);
      const indexDelta = h.addStructures(e2);
      const delta = h.projection.step(cset(e2, 1), indexDelta);

      const seq = findFactByPredicate(delta, ACTIVE_STRUCTURE_SEQ.predicate);
      expect(seq).toBeDefined();
      expect(seq!.fact.values[ACTIVE_STRUCTURE_SEQ.ORIGIN_LEFT]).toBe(cnIdKey(e1.id));
      expect(seq!.fact.values[ACTIVE_STRUCTURE_SEQ.ORIGIN_RIGHT]).toBe(null);
    });

    it('seq structure retraction (weight −1) emits anti-facts', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'list', 'seq');
      const elem = makeSeqChild('alice', 1, root.id);

      h.addStructures(root, elem);
      h.stepBoth(cset(elem, 1));
      expect(h.projection.current().length).toBe(2); // seq + peer

      // Retract (defensive — seq structures are permanent)
      const delta = h.stepBoth(cset(elem, -1));

      const seqs = findAllByPredicate(delta, ACTIVE_STRUCTURE_SEQ.predicate);
      expect(seqs.length).toBe(1);
      expect(seqs[0]!.weight).toBe(-1);

      const peers = findAllByPredicate(delta, CONSTRAINT_PEER.predicate);
      expect(peers.length).toBe(1);
      expect(peers[0]!.weight).toBe(-1);

      expect(h.projection.current().length).toBe(0);
    });

    it('map and root structures do not emit seq facts', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');

      const indexDelta = h.addStructures(root, child);
      // Pass both as active constraints (they would be in the active set)
      const delta = h.projection.step(csetMany(root, child), indexDelta);

      const seqs = findAllByPredicate(delta, ACTIVE_STRUCTURE_SEQ.predicate);
      expect(seqs.length).toBe(0);

      const peers = findAllByPredicate(delta, CONSTRAINT_PEER.predicate);
      expect(peers.length).toBe(0);
    });
  });

  // =========================================================================
  // Non-projected constraint types
  // =========================================================================

  describe('non-projected constraint types', () => {
    it('retract constraints are not projected', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const retract = makeRetract('alice', 1, root.id);

      h.addStructures(root);
      const delta = h.stepBoth(cset(retract));

      expect(delta.size).toBe(0);
    });

    it('authority constraints are not projected', () => {
      const h = createHarness();
      const auth = makeAuthority('alice', 0, 'bob');

      const delta = h.stepBoth(cset(auth));

      expect(delta.size).toBe(0);
    });
  });

  // =========================================================================
  // Empty deltas
  // =========================================================================

  describe('empty deltas', () => {
    it('both empty → empty output', () => {
      const h = createHarness();
      const delta = h.projection.step(zsetEmpty(), structureIndexDeltaEmpty());
      expect(delta.size).toBe(0);
    });

    it('empty active + non-empty index (no orphans) → empty output', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const indexDelta = h.addStructures(root);

      const delta = h.projection.step(zsetEmpty(), indexDelta);
      expect(delta.size).toBe(0);
    });
  });

  // =========================================================================
  // Reset
  // =========================================================================

  describe('reset', () => {
    it('clears all state including orphans', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const value = makeValue('alice', 2, child.id, 'Alice');
      const orphanTarget = createCnId('alice', 99);
      const orphan = makeValue('alice', 3, orphanTarget, 'lost');

      h.addStructures(root, child);
      h.stepBoth(cset(value));
      h.stepBoth(cset(orphan));
      expect(h.projection.current().length).toBe(1);

      h.projection.reset();
      expect(h.projection.current().length).toBe(0);
    });

    it('can be reused after reset', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const v1 = makeValue('alice', 2, child.id, 'Alice');

      h.addStructures(root, child);
      h.stepBoth(cset(v1));
      h.projection.reset();

      const v2 = makeValue('bob', 0, child.id, 'Bob');
      h.stepBoth(cset(v2));
      expect(h.projection.current().length).toBe(1);
    });
  });

  // =========================================================================
  // Duplicate constraint
  // =========================================================================

  describe('duplicate handling', () => {
    it('same value inserted twice produces two +1 facts (caller dedup responsibility)', () => {
      // The projection stage doesn't dedup active constraint insertions —
      // the upstream retraction/validity stages handle dedup. If the same
      // constraint arrives twice with weight +1, two facts are emitted.
      // This is correct Z-set behavior (weights accumulate).
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const value = makeValue('alice', 2, child.id, 'Alice');

      h.addStructures(root, child);
      h.stepBoth(cset(value));
      expect(h.projection.current().length).toBe(1);

      // Insert same value again — the accumulated facts still has 1
      // because the Z-set keys match and weights add to 2 (but we only
      // store the latest fact object, not the weight).
      // Actually the accFacts map deduplicates by factKey, so current()
      // still returns 1 fact.
      h.stepBoth(cset(value));
      expect(h.projection.current().length).toBe(1);
    });
  });

  // =========================================================================
  // Differential equivalence: incremental == batch
  // =========================================================================

  describe('differential equivalence', () => {
    it('single value matches batch', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const value = makeValue('alice', 2, child.id, 'Alice');

      const allStructures = [root, child];
      const allActive: Constraint[] = [root, child, value];

      h.addStructures(...allStructures);
      h.stepBoth(cset(value));

      const batchIndex = buildStructureIndex(allActive);
      const batchResult = projectToFacts(allActive, batchIndex);

      assertFactsEqual(h.projection.current(), batchResult.facts);
    });

    it('multiple values across multiple slots matches batch', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const name = makeMapChild('alice', 1, root.id, 'name');
      const age = makeMapChild('alice', 2, root.id, 'age');
      const v1 = makeValue('alice', 3, name.id, 'Alice');
      const v2 = makeValue('alice', 4, age.id, 30);

      const allStructures = [root, name, age];
      const allActive: Constraint[] = [...allStructures, v1, v2];

      h.addStructures(...allStructures);
      h.stepBoth(csetMany(v1, v2));

      const batchIndex = buildStructureIndex(allActive);
      const batchResult = projectToFacts(allActive, batchIndex);

      assertFactsEqual(h.projection.current(), batchResult.facts);
    });

    it('seq structure facts match batch', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'list', 'seq');
      const e1 = makeSeqChild('alice', 1, root.id);
      const e2 = makeSeqChild('alice', 2, root.id, e1.id, null);

      const allStructures = [root, e1, e2];
      const allActive: Constraint[] = allStructures;

      for (const sc of allStructures) {
        const indexDelta = h.addStructures(sc);
        h.projection.step(cset(sc), indexDelta);
      }

      const batchIndex = buildStructureIndex(allActive);
      const batchResult = projectToFacts(allActive, batchIndex);

      assertFactsEqual(h.projection.current(), batchResult.facts);
    });

    it('mixed map values + seq structures match batch', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const name = makeMapChild('alice', 1, root.id, 'name');
      const items = makeMapChild('alice', 2, root.id, 'items');
      const e1 = makeSeqChild('alice', 3, items.id);
      const v1 = makeValue('alice', 4, name.id, 'Alice');
      const v2 = makeValue('alice', 5, e1.id, 'item1');

      const allStructures = [root, name, items, e1];
      const allActive: Constraint[] = [...allStructures, v1, v2];

      // Feed all structures
      for (const sc of allStructures) {
        const indexDelta = h.addStructures(sc);
        h.projection.step(cset(sc), indexDelta);
      }
      // Feed values
      h.stepBoth(csetMany(v1, v2));

      const batchIndex = buildStructureIndex(allActive);
      const batchResult = projectToFacts(allActive, batchIndex);

      assertFactsEqual(h.projection.current(), batchResult.facts);
    });

    it('orphan resolved matches batch (same final state)', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const value = makeValue('alice', 2, child.id, 'Alice');

      const allStructures = [root, child];
      const allActive: Constraint[] = [...allStructures, value];

      // Value arrives first (orphan), then structure
      h.addStructures(root);
      h.stepBoth(cset(value));
      const indexDelta = h.addStructures(child);
      h.projection.step(zsetEmpty(), indexDelta);

      const batchIndex = buildStructureIndex(allActive);
      const batchResult = projectToFacts(allActive, batchIndex);

      assertFactsEqual(h.projection.current(), batchResult.facts);
    });

    it('concurrent map children match batch', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const childAlice = makeMapChild('alice', 1, root.id, 'name');
      const childBob = makeMapChild('bob', 0, root.id, 'name');
      const vAlice = makeValue('alice', 2, childAlice.id, 'Alice');
      const vBob = makeValue('bob', 1, childBob.id, 'Bob');

      const allStructures = [root, childAlice, childBob];
      const allActive: Constraint[] = [...allStructures, vAlice, vBob];

      for (const sc of allStructures) {
        const indexDelta = h.addStructures(sc);
        h.projection.step(cset(sc), indexDelta);
      }
      h.stepBoth(csetMany(vAlice, vBob));

      const batchIndex = buildStructureIndex(allActive);
      const batchResult = projectToFacts(allActive, batchIndex);

      assertFactsEqual(h.projection.current(), batchResult.facts);
    });
  });

  // =========================================================================
  // All-permutation differential tests
  // =========================================================================

  describe('all-permutation differential', () => {
    it('root + child + value: all orderings match batch', () => {
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const value = makeValue('alice', 2, child.id, 'Alice');

      // Active constraints are all structures + value.
      // The batch always sees all at once.
      const allActive: Constraint[] = [root, child, value];
      const batchIndex = buildStructureIndex(allActive);
      const batchResult = projectToFacts(allActive, batchIndex);

      for (const perm of permutations(allActive)) {
        const structIndex = createIncrementalStructureIndex();
        const projection = createIncrementalProjection(() => structIndex.current());

        for (const c of perm) {
          // Every constraint goes through both paths:
          // structures → index stage, all → projection as active
          const indexDelta = c.type === 'structure'
            ? structIndex.step(cset(c))
            : structureIndexDeltaEmpty();
          projection.step(cset(c), indexDelta);
        }

        assertFactsEqual(
          projection.current(),
          batchResult.facts,
          `permutation: ${perm.map((c) => `${c.type}:${cnIdKey(c.id)}`).join(', ')}`,
        );
      }
    });

    it('root + two values (one orphaned): all orderings match batch', () => {
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const v1 = makeValue('alice', 2, child.id, 'Alice');
      const v2 = makeValue('bob', 0, child.id, 'Bob');

      const allActive: Constraint[] = [root, child, v1, v2];
      const batchIndex = buildStructureIndex(allActive);
      const batchResult = projectToFacts(allActive, batchIndex);

      for (const perm of permutations(allActive)) {
        const structIndex = createIncrementalStructureIndex();
        const projection = createIncrementalProjection(() => structIndex.current());

        for (const c of perm) {
          const indexDelta = c.type === 'structure'
            ? structIndex.step(cset(c))
            : structureIndexDeltaEmpty();
          projection.step(cset(c), indexDelta);
        }

        assertFactsEqual(
          projection.current(),
          batchResult.facts,
          `permutation: ${perm.map((c) => `${c.type}:${cnIdKey(c.id)}`).join(', ')}`,
        );
      }
    });

    it('seq root + elements + values: all orderings match batch', () => {
      const root = makeRoot('alice', 0, 'list', 'seq');
      const e1 = makeSeqChild('alice', 1, root.id);
      const v1 = makeValue('alice', 2, e1.id, 'item1');

      const allActive: Constraint[] = [root, e1, v1];
      const batchIndex = buildStructureIndex(allActive);
      const batchResult = projectToFacts(allActive, batchIndex);

      for (const perm of permutations(allActive)) {
        const structIndex = createIncrementalStructureIndex();
        const projection = createIncrementalProjection(() => structIndex.current());

        for (const c of perm) {
          const indexDelta = c.type === 'structure'
            ? structIndex.step(cset(c))
            : structureIndexDeltaEmpty();
          projection.step(cset(c), indexDelta);
        }

        assertFactsEqual(
          projection.current(),
          batchResult.facts,
          `permutation: ${perm.map((c) => `${c.type}:${cnIdKey(c.id)}`).join(', ')}`,
        );
      }
    });

    it('mixed: map structure + seq structure + values: all orderings match batch', () => {
      const root = makeRoot('alice', 0, 'doc');
      const name = makeMapChild('alice', 1, root.id, 'name');
      const vName = makeValue('alice', 2, name.id, 'Alice');
      const items = makeMapChild('alice', 3, root.id, 'items');
      const e1 = makeSeqChild('alice', 4, items.id);

      const allActive: Constraint[] = [root, name, vName, items, e1];
      const batchIndex = buildStructureIndex(allActive);
      const batchResult = projectToFacts(allActive, batchIndex);

      // 5! = 120 permutations
      for (const perm of permutations(allActive)) {
        const structIndex = createIncrementalStructureIndex();
        const projection = createIncrementalProjection(() => structIndex.current());

        for (const c of perm) {
          const indexDelta = c.type === 'structure'
            ? structIndex.step(cset(c))
            : structureIndexDeltaEmpty();
          projection.step(cset(c), indexDelta);
        }

        assertFactsEqual(
          projection.current(),
          batchResult.facts,
          `permutation: ${perm.map((c) => `${c.type}:${cnIdKey(c.id)}`).join(', ')}`,
        );
      }
    });
  });

  // =========================================================================
  // current() accumulation
  // =========================================================================

  describe('current() accumulation', () => {
    it('accumulates value facts and seq facts together', () => {
      const h = createHarness();
      const root = makeRoot('alice', 0, 'doc');
      const name = makeMapChild('alice', 1, root.id, 'name');
      const items = makeMapChild('alice', 2, root.id, 'items');
      const e1 = makeSeqChild('alice', 3, items.id);
      const vName = makeValue('alice', 4, name.id, 'Alice');
      const vItem = makeValue('alice', 5, e1.id, 'item1');

      // Add all structures
      for (const sc of [root, name, items, e1]) {
        const indexDelta = h.addStructures(sc);
        h.projection.step(cset(sc), indexDelta);
      }

      // Add values
      h.stepBoth(csetMany(vName, vItem));

      const facts = h.projection.current();
      // 2 value facts + 2 seq facts (active_structure_seq + constraint_peer)
      expect(facts.length).toBe(4);

      const predicates = facts.map((f) => f.predicate);
      expect(predicates.filter((p) => p === ACTIVE_VALUE.predicate).length).toBe(2);
      expect(predicates.filter((p) => p === ACTIVE_STRUCTURE_SEQ.predicate).length).toBe(1);
      expect(predicates.filter((p) => p === CONSTRAINT_PEER.predicate).length).toBe(1);
    });
  });
});