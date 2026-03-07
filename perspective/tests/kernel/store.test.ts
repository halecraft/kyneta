// === Constraint Store Tests ===
// Tests for the kernel constraint store: insert deduplication,
// safe-integer validation, set union merge properties, generation
// counter, and version vector maintenance.

import { describe, it, expect } from 'vitest';
import {
  createStore,
  insert,
  insertMany,
  getConstraint,
  hasConstraint,
  constraintCount,
  allConstraints,
  constraintsByType,
  mergeStores,
  exportDelta,
  importDelta,
  getVersionVector,
  getLamport,
  getGeneration,
} from '../../src/kernel/store.js';
import { createCnId } from '../../src/kernel/cnid.js';
import { vvFromObject, vvGet } from '../../src/kernel/version-vector.js';
import { STUB_SIGNATURE } from '../../src/kernel/signature.js';
import type {
  Constraint,
  StructureConstraint,
  ValueConstraint,
  RetractConstraint,
  CnId,
} from '../../src/kernel/types.js';
import type { ConstraintStore } from '../../src/kernel/store.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeStructure(
  peer: string,
  counter: number,
  lamport: number = 1,
  containerId: string = 'test',
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport,
    refs: [],
    sig: STUB_SIGNATURE,
    type: 'structure',
    payload: { kind: 'root', containerId, policy: 'map' },
  };
}

function makeValue(
  peer: string,
  counter: number,
  lamport: number,
  target: CnId,
  content: string,
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

function makeRetract(
  peer: string,
  counter: number,
  lamport: number,
  target: CnId,
): RetractConstraint {
  return {
    id: createCnId(peer, counter),
    lamport,
    refs: [],
    sig: STUB_SIGNATURE,
    type: 'retract',
    payload: { target },
  };
}

/** Insert and assert success. Returns the same store (mutated in place). */
function mustInsert(store: ConstraintStore, c: Constraint): ConstraintStore {
  const result = insert(store, c);
  expect(result.ok).toBe(true);
  return store;
}

/** Insert many and assert success. Returns the same store (mutated in place). */
function mustInsertMany(store: ConstraintStore, cs: readonly Constraint[]): ConstraintStore {
  const result = insertMany(store, cs);
  expect(result.ok).toBe(true);
  return store;
}

describe('Constraint Store', () => {
  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  describe('createStore', () => {
    it('creates an empty store', () => {
      const store = createStore();
      expect(constraintCount(store)).toBe(0);
      expect(getLamport(store)).toBe(0);
      expect(getGeneration(store)).toBe(0);
      expect(getVersionVector(store).size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Insert
  // -------------------------------------------------------------------------

  describe('insert', () => {
    it('inserts a constraint (mutates store in place)', () => {
      const store = createStore();
      const c = makeStructure('alice', 0);
      const result = insert(store, c);

      expect(result.ok).toBe(true);

      expect(constraintCount(store)).toBe(1);
      expect(hasConstraint(store, c.id)).toBe(true);
    });

    it('retrieves inserted constraint by CnId', () => {
      const c = makeStructure('alice', 0, 5);
      const store = mustInsert(createStore(), c);

      const retrieved = getConstraint(store, c.id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.id.peer).toBe('alice');
      expect(retrieved!.id.counter).toBe(0);
      expect(retrieved!.lamport).toBe(5);
      expect(retrieved!.type).toBe('structure');
    });

    it('deduplicates by CnId — same constraint inserted twice', () => {
      const c = makeStructure('alice', 0);
      const store = mustInsert(createStore(), c);
      const gen1 = getGeneration(store);

      mustInsert(store, c);
      // Store unchanged — no new generation bump
      expect(constraintCount(store)).toBe(1);
      expect(getGeneration(store)).toBe(gen1);
    });

    it('deduplication is idempotent — insert returns ok(void)', () => {
      const c = makeStructure('alice', 0);
      const store = mustInsert(createStore(), c);

      const result = insert(store, c);
      expect(result.ok).toBe(true);

      // Store unchanged
      expect(constraintCount(store)).toBe(1);
    });

    it('updates version vector on insert', () => {
      const c1 = makeStructure('alice', 0);
      const c2 = makeStructure('alice', 1);
      const c3 = makeStructure('bob', 0);

      const store = createStore();
      mustInsert(store, c1);
      expect(vvGet(getVersionVector(store), 'alice')).toBe(1);

      mustInsert(store, c2);
      expect(vvGet(getVersionVector(store), 'alice')).toBe(2);

      mustInsert(store, c3);
      expect(vvGet(getVersionVector(store), 'bob')).toBe(1);
      expect(vvGet(getVersionVector(store), 'alice')).toBe(2);
    });

    it('updates Lamport high-water mark on insert', () => {
      const c1 = makeStructure('alice', 0, 5);
      const c2 = makeStructure('bob', 0, 10);
      const c3 = makeStructure('charlie', 0, 3);

      const store = createStore();
      mustInsert(store, c1);
      expect(getLamport(store)).toBe(5);

      mustInsert(store, c2);
      expect(getLamport(store)).toBe(10);

      // Lamport should not decrease
      mustInsert(store, c3);
      expect(getLamport(store)).toBe(10);
    });

    it('increments generation on every mutation', () => {
      const c1 = makeStructure('alice', 0);
      const c2 = makeStructure('alice', 1);

      const store = createStore();
      expect(getGeneration(store)).toBe(0);

      mustInsert(store, c1);
      expect(getGeneration(store)).toBe(1);

      mustInsert(store, c2);
      expect(getGeneration(store)).toBe(2);
    });

    it('mutates the store in place', () => {
      const store = createStore();
      const c = makeStructure('alice', 0);
      insert(store, c);

      // Store is mutated — constraint is in the same object
      expect(constraintCount(store)).toBe(1);
      expect(hasConstraint(store, c.id)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Safe-integer validation
  // -------------------------------------------------------------------------

  describe('safe-integer validation', () => {
    it('rejects counter > MAX_SAFE_INTEGER', () => {
      const c: StructureConstraint = {
        id: createCnId('alice', Number.MAX_SAFE_INTEGER + 1),
        lamport: 1,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'structure',
        payload: { kind: 'root', containerId: 'test', policy: 'map' },
      };

      const result = insert(createStore(), c);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('outOfRange');
      expect(result.error).toHaveProperty('field', 'id.counter');
    });

    it('rejects lamport > MAX_SAFE_INTEGER', () => {
      const c: StructureConstraint = {
        id: createCnId('alice', 0),
        lamport: Number.MAX_SAFE_INTEGER + 1,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'structure',
        payload: { kind: 'root', containerId: 'test', policy: 'map' },
      };

      const result = insert(createStore(), c);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('outOfRange');
      expect(result.error).toHaveProperty('field', 'lamport');
    });

    it('rejects negative counter', () => {
      const c: StructureConstraint = {
        id: createCnId('alice', -1),
        lamport: 1,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'structure',
        payload: { kind: 'root', containerId: 'test', policy: 'map' },
      };

      const result = insert(createStore(), c);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('outOfRange');
    });

    it('rejects negative lamport', () => {
      const c: StructureConstraint = {
        id: createCnId('alice', 0),
        lamport: -1,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'structure',
        payload: { kind: 'root', containerId: 'test', policy: 'map' },
      };

      const result = insert(createStore(), c);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('outOfRange');
    });

    it('rejects non-integer counter (float)', () => {
      const c: StructureConstraint = {
        id: createCnId('alice', 1.5),
        lamport: 1,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'structure',
        payload: { kind: 'root', containerId: 'test', policy: 'map' },
      };

      const result = insert(createStore(), c);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('outOfRange');
    });

    it('rejects NaN counter', () => {
      const c: StructureConstraint = {
        id: createCnId('alice', NaN),
        lamport: 1,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'structure',
        payload: { kind: 'root', containerId: 'test', policy: 'map' },
      };

      const result = insert(createStore(), c);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('outOfRange');
    });

    it('rejects Infinity lamport', () => {
      const c: StructureConstraint = {
        id: createCnId('alice', 0),
        lamport: Infinity,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'structure',
        payload: { kind: 'root', containerId: 'test', policy: 'map' },
      };

      const result = insert(createStore(), c);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.kind).toBe('outOfRange');
    });

    it('accepts counter = 0 (boundary)', () => {
      const c = makeStructure('alice', 0);
      const result = insert(createStore(), c);
      expect(result.ok).toBe(true);
    });

    it('accepts counter = MAX_SAFE_INTEGER (boundary)', () => {
      const c: StructureConstraint = {
        id: createCnId('alice', Number.MAX_SAFE_INTEGER),
        lamport: 1,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'structure',
        payload: { kind: 'root', containerId: 'test', policy: 'map' },
      };

      const result = insert(createStore(), c);
      expect(result.ok).toBe(true);
    });

    it('accepts lamport = 0 (boundary)', () => {
      const c: StructureConstraint = {
        id: createCnId('alice', 0),
        lamport: 0,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'structure',
        payload: { kind: 'root', containerId: 'test', policy: 'map' },
      };

      const result = insert(createStore(), c);
      expect(result.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Insert Many
  // -------------------------------------------------------------------------

  describe('insertMany', () => {
    it('inserts multiple constraints at once', () => {
      const constraints = [
        makeStructure('alice', 0),
        makeStructure('alice', 1),
        makeStructure('bob', 0),
      ];

      const store = mustInsertMany(createStore(), constraints);
      expect(constraintCount(store)).toBe(3);
    });

    it('succeeds for empty array (no mutation)', () => {
      const store = createStore();
      const gen = getGeneration(store);
      const result = insertMany(store, []);
      expect(result.ok).toBe(true);
      expect(getGeneration(store)).toBe(gen);
    });

    it('no generation bump when all are duplicates', () => {
      const c = makeStructure('alice', 0);
      const store = mustInsert(createStore(), c);
      const gen = getGeneration(store);

      const result = insertMany(store, [c, c]);
      expect(result.ok).toBe(true);
      expect(getGeneration(store)).toBe(gen);
    });

    it('fails fast on first invalid constraint', () => {
      const good = makeStructure('alice', 0);
      const bad: StructureConstraint = {
        id: createCnId('alice', -1),
        lamport: 1,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'structure',
        payload: { kind: 'root', containerId: 'test', policy: 'map' },
      };

      const result = insertMany(createStore(), [good, bad]);
      expect(result.ok).toBe(false);
    });

    it('updates version vector for all inserted constraints', () => {
      const constraints = [
        makeStructure('alice', 0),
        makeStructure('alice', 1),
        makeStructure('bob', 0),
      ];

      const store = createStore();
      mustInsertMany(store, constraints);
      expect(vvGet(getVersionVector(store), 'alice')).toBe(2);
      expect(vvGet(getVersionVector(store), 'bob')).toBe(1);
    });

    it('updates Lamport to max across all constraints', () => {
      const constraints = [
        makeStructure('alice', 0, 3),
        makeStructure('bob', 0, 10),
        makeStructure('charlie', 0, 5),
      ];

      const store = createStore();
      mustInsertMany(store, constraints);
      expect(getLamport(store)).toBe(10);
    });

    it('increments generation only once', () => {
      const constraints = [
        makeStructure('alice', 0),
        makeStructure('bob', 0),
        makeStructure('charlie', 0),
      ];

      const store = createStore();
      mustInsertMany(store, constraints);
      expect(getGeneration(store)).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------

  describe('query', () => {
    it('getConstraint returns undefined for missing CnId', () => {
      const store = createStore();
      expect(getConstraint(store, createCnId('alice', 0))).toBeUndefined();
    });

    it('hasConstraint returns false for missing CnId', () => {
      const store = createStore();
      expect(hasConstraint(store, createCnId('alice', 0))).toBe(false);
    });

    it('allConstraints returns all inserted constraints', () => {
      const c1 = makeStructure('alice', 0);
      const c2 = makeStructure('bob', 0);
      const store = mustInsertMany(createStore(), [c1, c2]);

      const all = allConstraints(store);
      expect(all).toHaveLength(2);
    });

    it('constraintsByType filters by type', () => {
      const root = createCnId('alice', 0);
      const s = makeStructure('alice', 0);
      const v = makeValue('alice', 1, 2, root, 'hello');
      const r = makeRetract('alice', 2, 3, root);

      const store = mustInsertMany(createStore(), [s, v, r]);

      const structures = constraintsByType(store, 'structure');
      expect(structures).toHaveLength(1);
      expect(structures[0]!.type).toBe('structure');

      const values = constraintsByType(store, 'value');
      expect(values).toHaveLength(1);
      expect(values[0]!.type).toBe('value');

      const retracts = constraintsByType(store, 'retract');
      expect(retracts).toHaveLength(1);
      expect(retracts[0]!.type).toBe('retract');

      const rules = constraintsByType(store, 'rule');
      expect(rules).toHaveLength(0);
    });

    it('constraintsByType narrows the return type', () => {
      const s = makeStructure('alice', 0);
      const store = mustInsert(createStore(), s);

      const structures = constraintsByType(store, 'structure');
      // TypeScript should narrow this to StructureConstraint[]
      const first = structures[0]!;
      expect(first.payload.kind).toBe('root');
      // If narrowing works, we can access StructurePayload fields directly
      if (first.payload.kind === 'root') {
        expect(first.payload.containerId).toBe('test');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Merge (set union)
  // -------------------------------------------------------------------------

  describe('mergeStores', () => {
    it('produces union of both stores', () => {
      const c1 = makeStructure('alice', 0);
      const c2 = makeStructure('bob', 0);

      const storeA = mustInsert(createStore(), c1);
      const storeB = mustInsert(createStore(), c2);

      const merged = mergeStores(storeA, storeB);
      expect(constraintCount(merged)).toBe(2);
      expect(hasConstraint(merged, c1.id)).toBe(true);
      expect(hasConstraint(merged, c2.id)).toBe(true);
    });

    it('is commutative: merge(A, B) has same constraints as merge(B, A)', () => {
      const c1 = makeStructure('alice', 0, 3);
      const c2 = makeStructure('bob', 0, 5);

      const storeA = mustInsert(createStore(), c1);
      const storeB = mustInsert(createStore(), c2);

      const ab = mergeStores(storeA, storeB);
      const ba = mergeStores(storeB, storeA);

      expect(constraintCount(ab)).toBe(constraintCount(ba));
      expect(hasConstraint(ab, c1.id)).toBe(true);
      expect(hasConstraint(ab, c2.id)).toBe(true);
      expect(hasConstraint(ba, c1.id)).toBe(true);
      expect(hasConstraint(ba, c2.id)).toBe(true);
    });

    it('is associative: merge(merge(A, B), C) has same constraints as merge(A, merge(B, C))', () => {
      const c1 = makeStructure('alice', 0);
      const c2 = makeStructure('bob', 0);
      const c3 = makeStructure('charlie', 0);

      const storeA = mustInsert(createStore(), c1);
      const storeB = mustInsert(createStore(), c2);
      const storeC = mustInsert(createStore(), c3);

      const ab_c = mergeStores(mergeStores(storeA, storeB), storeC);
      const a_bc = mergeStores(storeA, mergeStores(storeB, storeC));

      expect(constraintCount(ab_c)).toBe(3);
      expect(constraintCount(a_bc)).toBe(3);
      expect(hasConstraint(ab_c, c1.id)).toBe(true);
      expect(hasConstraint(ab_c, c2.id)).toBe(true);
      expect(hasConstraint(ab_c, c3.id)).toBe(true);
      expect(hasConstraint(a_bc, c1.id)).toBe(true);
      expect(hasConstraint(a_bc, c2.id)).toBe(true);
      expect(hasConstraint(a_bc, c3.id)).toBe(true);
    });

    it('is idempotent: merge(A, A) has same constraints as A', () => {
      const c1 = makeStructure('alice', 0, 5);
      const c2 = makeStructure('bob', 0, 3);

      const store = mustInsertMany(createStore(), [c1, c2]);
      const merged = mergeStores(store, store);

      expect(constraintCount(merged)).toBe(constraintCount(store));
      expect(hasConstraint(merged, c1.id)).toBe(true);
      expect(hasConstraint(merged, c2.id)).toBe(true);
    });

    it('merges version vectors (max per peer)', () => {
      const storeA = mustInsertMany(createStore(), [
        makeStructure('alice', 0),
        makeStructure('alice', 1),
      ]);
      const storeB = mustInsertMany(createStore(), [
        makeStructure('bob', 0),
        makeStructure('bob', 1),
        makeStructure('bob', 2),
      ]);

      const merged = mergeStores(storeA, storeB);
      expect(vvGet(getVersionVector(merged), 'alice')).toBe(2);
      expect(vvGet(getVersionVector(merged), 'bob')).toBe(3);
    });

    it('merges Lamport (takes max)', () => {
      const storeA = mustInsert(createStore(), makeStructure('alice', 0, 5));
      const storeB = mustInsert(createStore(), makeStructure('bob', 0, 10));

      const merged = mergeStores(storeA, storeB);
      expect(getLamport(merged)).toBe(10);
    });

    it('merge with empty store returns equivalent store', () => {
      const c = makeStructure('alice', 0);
      const store = mustInsert(createStore(), c);
      const empty = createStore();

      const merged = mergeStores(store, empty);
      expect(constraintCount(merged)).toBe(1);
      expect(hasConstraint(merged, c.id)).toBe(true);
    });

    it('merge of two empty stores is empty', () => {
      const merged = mergeStores(createStore(), createStore());
      expect(constraintCount(merged)).toBe(0);
    });

    it('handles overlapping constraints (dedup)', () => {
      const c1 = makeStructure('alice', 0);
      const c2 = makeStructure('alice', 1);
      const c3 = makeStructure('bob', 0);

      const storeA = mustInsertMany(createStore(), [c1, c2]);
      const storeB = mustInsertMany(createStore(), [c2, c3]);

      const merged = mergeStores(storeA, storeB);
      // c1 only in A, c2 in both, c3 only in B → 3 unique constraints
      expect(constraintCount(merged)).toBe(3);
    });

    it('increments generation on merge with new constraints', () => {
      const storeA = mustInsert(createStore(), makeStructure('alice', 0));
      const storeB = mustInsert(createStore(), makeStructure('bob', 0));

      const genA = getGeneration(storeA);
      const merged = mergeStores(storeA, storeB);
      expect(getGeneration(merged)).toBeGreaterThan(genA);
    });
  });

  // -------------------------------------------------------------------------
  // Delta computation
  // -------------------------------------------------------------------------

  describe('exportDelta / importDelta', () => {
    it('exports constraints the other peer has not seen', () => {
      const c1 = makeStructure('alice', 0);
      const c2 = makeStructure('alice', 1);
      const c3 = makeStructure('bob', 0);

      const store = mustInsertMany(createStore(), [c1, c2, c3]);
      const theirVV = vvFromObject({ alice: 1 }); // they've seen alice@0 only

      const delta = exportDelta(store, theirVV);
      expect(delta.constraints).toHaveLength(2); // alice@1 and bob@0

      const ids = delta.constraints.map(c => `${c.id.peer}@${c.id.counter}`).sort();
      expect(ids).toEqual(['alice@1', 'bob@0']);
    });

    it('exports empty delta when other has seen everything', () => {
      const c = makeStructure('alice', 0);
      const store = mustInsert(createStore(), c);

      const theirVV = vvFromObject({ alice: 1 });
      const delta = exportDelta(store, theirVV);
      expect(delta.constraints).toHaveLength(0);
    });

    it('exports all when other has empty VV', () => {
      const c1 = makeStructure('alice', 0);
      const c2 = makeStructure('bob', 0);
      const store = mustInsertMany(createStore(), [c1, c2]);

      const delta = exportDelta(store, new Map());
      expect(delta.constraints).toHaveLength(2);
    });

    it('importDelta applies a delta to a store', () => {
      const c1 = makeStructure('alice', 0);
      const c2 = makeStructure('bob', 0);

      const storeA = mustInsertMany(createStore(), [c1, c2]);
      const storeB = mustInsert(createStore(), c1);

      const delta = exportDelta(storeA, getVersionVector(storeB));
      const result = importDelta(storeB, delta);

      expect(result.ok).toBe(true);

      // storeB should now have both constraints (mutated in place)
      expect(constraintCount(storeB)).toBe(2);
      expect(hasConstraint(storeB, c1.id)).toBe(true);
      expect(hasConstraint(storeB, c2.id)).toBe(true);
    });

    it('two-way sync produces identical stores', () => {
      const c1 = makeStructure('alice', 0);
      const c2 = makeStructure('alice', 1, 5);
      const c3 = makeStructure('bob', 0);
      const c4 = makeStructure('bob', 1, 10);

      const storeA = mustInsertMany(createStore(), [c1, c2]);
      const storeB = mustInsertMany(createStore(), [c3, c4]);

      // A → B (mutates storeB in place)
      const deltaAtoB = exportDelta(storeA, getVersionVector(storeB));
      const resultB = importDelta(storeB, deltaAtoB);
      expect(resultB.ok).toBe(true);

      // B → A (mutates storeA in place)
      const deltaBtoA = exportDelta(storeB, getVersionVector(storeA));
      const resultA = importDelta(storeA, deltaBtoA);
      expect(resultA.ok).toBe(true);

      // Both should have all 4 constraints
      expect(constraintCount(storeA)).toBe(4);
      expect(constraintCount(storeB)).toBe(4);

      expect(hasConstraint(storeA, c1.id)).toBe(true);
      expect(hasConstraint(storeA, c2.id)).toBe(true);
      expect(hasConstraint(storeA, c3.id)).toBe(true);
      expect(hasConstraint(storeA, c4.id)).toBe(true);

      expect(hasConstraint(storeB, c1.id)).toBe(true);
      expect(hasConstraint(storeB, c2.id)).toBe(true);
      expect(hasConstraint(storeB, c3.id)).toBe(true);
      expect(hasConstraint(storeB, c4.id)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Generation counter
  // -------------------------------------------------------------------------

  describe('generation counter', () => {
    it('starts at 0', () => {
      expect(getGeneration(createStore())).toBe(0);
    });

    it('increments on each single insert of a new constraint', () => {
      const store = createStore();
      mustInsert(store, makeStructure('alice', 0));
      expect(getGeneration(store)).toBe(1);

      mustInsert(store, makeStructure('alice', 1));
      expect(getGeneration(store)).toBe(2);

      mustInsert(store, makeStructure('bob', 0));
      expect(getGeneration(store)).toBe(3);
    });

    it('does not increment on duplicate insert', () => {
      const c = makeStructure('alice', 0);
      const store = mustInsert(createStore(), c);
      const gen = getGeneration(store);

      mustInsert(store, c);
      expect(getGeneration(store)).toBe(gen);
    });

    it('increments once for insertMany', () => {
      const constraints = [
        makeStructure('alice', 0),
        makeStructure('bob', 0),
        makeStructure('charlie', 0),
      ];

      const store = createStore();
      mustInsertMany(store, constraints);
      expect(getGeneration(store)).toBe(1);
    });

    it('does not increment for insertMany with all duplicates', () => {
      const c = makeStructure('alice', 0);
      const store = mustInsert(createStore(), c);
      const gen = getGeneration(store);
      mustInsertMany(store, [c, c]);
      expect(getGeneration(store)).toBe(gen);
    });
  });

  // -------------------------------------------------------------------------
  // Multiple constraint types
  // -------------------------------------------------------------------------

  describe('multiple constraint types', () => {
    it('stores all six constraint types', () => {
      const rootId = createCnId('alice', 0);

      const constraints: Constraint[] = [
        {
          id: createCnId('alice', 0),
          lamport: 1,
          refs: [],
          sig: STUB_SIGNATURE,
          type: 'structure',
          payload: { kind: 'root', containerId: 'test', policy: 'map' },
        },
        {
          id: createCnId('alice', 1),
          lamport: 2,
          refs: [],
          sig: STUB_SIGNATURE,
          type: 'value',
          payload: { target: rootId, content: 'hello' },
        },
        {
          id: createCnId('alice', 2),
          lamport: 3,
          refs: [],
          sig: STUB_SIGNATURE,
          type: 'retract',
          payload: { target: rootId },
        },
        {
          id: createCnId('alice', 3),
          lamport: 4,
          refs: [],
          sig: STUB_SIGNATURE,
          type: 'rule',
          payload: {
            layer: 2,
            head: { predicate: 'test', terms: [] },
            body: [],
          },
        },
        {
          id: createCnId('alice', 4),
          lamport: 5,
          refs: [],
          sig: STUB_SIGNATURE,
          type: 'authority',
          payload: {
            targetPeer: 'bob',
            action: 'grant',
            capability: { kind: 'admin' },
          },
        },
        {
          id: createCnId('alice', 5),
          lamport: 6,
          refs: [],
          sig: STUB_SIGNATURE,
          type: 'bookmark',
          payload: {
            name: 'v1.0',
            version: new Map([['alice', 5]]),
          },
        },
      ];

      const store = mustInsertMany(createStore(), constraints);
      expect(constraintCount(store)).toBe(6);

      // Verify each type can be retrieved and narrowed
      const structure = getConstraint(store, createCnId('alice', 0));
      expect(structure?.type).toBe('structure');

      const value = getConstraint(store, createCnId('alice', 1));
      expect(value?.type).toBe('value');

      const retract = getConstraint(store, createCnId('alice', 2));
      expect(retract?.type).toBe('retract');

      const rule = getConstraint(store, createCnId('alice', 3));
      expect(rule?.type).toBe('rule');

      const authority = getConstraint(store, createCnId('alice', 4));
      expect(authority?.type).toBe('authority');

      const bookmark = getConstraint(store, createCnId('alice', 5));
      expect(bookmark?.type).toBe('bookmark');
    });

    it('Constraint discriminated union narrows on type in switch', () => {
      const rootId = createCnId('alice', 0);

      // Use a function that accepts Constraint (the union) to test narrowing
      function checkNarrowing(c: Constraint): string {
        switch (c.type) {
          case 'structure':
            // payload is StructurePayload here
            return c.payload.kind;
          case 'value':
            // payload is ValuePayload here
            return String(c.payload.content);
          case 'retract':
            return String(c.payload.target.peer);
          case 'rule':
            return String(c.payload.layer);
          case 'authority':
            return c.payload.targetPeer;
          case 'bookmark':
            return c.payload.name;
        }
      }

      const c: Constraint = {
        id: createCnId('alice', 1),
        lamport: 2,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'value',
        payload: { target: rootId, content: 42 },
      };

      expect(checkNarrowing(c)).toBe('42');
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles many constraints from a single peer', () => {
      const constraints: Constraint[] = [];
      for (let i = 0; i < 100; i++) {
        constraints.push(makeStructure('alice', i, i + 1, `container-${i}`));
      }

      const store = mustInsertMany(createStore(), constraints);
      expect(constraintCount(store)).toBe(100);
      expect(vvGet(getVersionVector(store), 'alice')).toBe(100);
      expect(getLamport(store)).toBe(100);
    });

    it('handles many peers with one constraint each', () => {
      const constraints: Constraint[] = [];
      for (let i = 0; i < 50; i++) {
        constraints.push(makeStructure(`peer-${i}`, 0, 1, `container-${i}`));
      }

      const store = mustInsertMany(createStore(), constraints);
      expect(constraintCount(store)).toBe(50);
      expect(getVersionVector(store).size).toBe(50);
    });

    it('insert after merge works correctly', () => {
      const storeA = mustInsert(createStore(), makeStructure('alice', 0));
      const storeB = mustInsert(createStore(), makeStructure('bob', 0));

      const merged = mergeStores(storeA, storeB);
      mustInsert(merged, makeStructure('charlie', 0));

      expect(constraintCount(merged)).toBe(3);
      expect(hasConstraint(merged, createCnId('alice', 0))).toBe(true);
      expect(hasConstraint(merged, createCnId('bob', 0))).toBe(true);
      expect(hasConstraint(merged, createCnId('charlie', 0))).toBe(true);
    });
  });
});