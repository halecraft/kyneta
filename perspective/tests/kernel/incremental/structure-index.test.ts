// === Incremental Structure Index Tests ===
// Tests for the incremental structure index stage (Plan 005, Phase 4).
//
// Covers:
// - New root structure: creates SlotGroup, appears in `roots`
// - New map child: creates SlotGroup, appears in `childrenOf` for parent
// - Duplicate map child (same parent+key, different peer): joins existing SlotGroup
// - New seq child: creates unique SlotGroup (CnId-keyed)
// - Non-structure constraints are silently ignored
// - Weight −1 entries are ignored (structure is permanent)
// - Empty deltas produce empty output
// - Duplicate structure constraint (same CnId) is a no-op
// - Differential equivalence with batch buildStructureIndex
// - All-permutation differential tests

import { describe, it, expect } from 'vitest';
import {
  createIncrementalStructureIndex,
  type IncrementalStructureIndex,
} from '../../../src/kernel/incremental/structure-index.js';
import {
  buildStructureIndex,
  slotId,
  childKey,
  getChildren,
  getChildrenOfSlotGroup,
  type StructureIndex,
  type SlotGroup,
} from '../../../src/kernel/structure-index.js';
import { createCnId, cnIdKey } from '../../../src/kernel/cnid.js';
import { STUB_SIGNATURE } from '../../../src/kernel/signature.js';
import type {
  Constraint,
  StructureConstraint,
  ValueConstraint,
  RetractConstraint,
  CnId,
  PeerID,
} from '../../../src/kernel/types.js';
import {
  zsetEmpty,
  zsetSingleton,
  zsetFromEntries,
  type ZSet,
  type ZSetEntry,
} from '../../../src/base/zset.js';
import {
  structureIndexDeltaEmpty,
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
  content: unknown = 'v',
): ValueConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: counter,
    refs: [],
    sig: STUB_SIGNATURE,
    type: 'value',
    payload: { target, content: content as any },
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
 * Compare two StructureIndex instances for equivalence.
 * We compare the semantic content, not object identity.
 */
function assertIndexEquals(
  actual: StructureIndex,
  expected: StructureIndex,
  message?: string,
): void {
  const prefix = message ? `${message}: ` : '';

  // Compare byId
  expect(actual.byId.size, `${prefix}byId.size`).toBe(expected.byId.size);
  for (const [key, sc] of expected.byId) {
    expect(actual.byId.has(key), `${prefix}byId has ${key}`).toBe(true);
    expect(cnIdKey(actual.byId.get(key)!.id)).toBe(cnIdKey(sc.id));
  }

  // Compare slotGroups
  expect(actual.slotGroups.size, `${prefix}slotGroups.size`).toBe(expected.slotGroups.size);
  for (const [sid, expectedGroup] of expected.slotGroups) {
    const actualGroup = actual.slotGroups.get(sid);
    expect(actualGroup, `${prefix}slotGroups has ${sid}`).toBeDefined();
    assertSlotGroupEquals(actualGroup!, expectedGroup, `${prefix}slotGroup[${sid}]`);
  }

  // Compare structureToSlot
  expect(actual.structureToSlot.size, `${prefix}structureToSlot.size`).toBe(expected.structureToSlot.size);
  for (const [key, sid] of expected.structureToSlot) {
    expect(actual.structureToSlot.get(key), `${prefix}structureToSlot[${key}]`).toBe(sid);
  }

  // Compare roots
  expect(actual.roots.size, `${prefix}roots.size`).toBe(expected.roots.size);
  for (const [cid, expectedGroup] of expected.roots) {
    const actualGroup = actual.roots.get(cid);
    expect(actualGroup, `${prefix}roots has ${cid}`).toBeDefined();
    assertSlotGroupEquals(actualGroup!, expectedGroup, `${prefix}root[${cid}]`);
  }

  // Compare childrenOf
  expect(actual.childrenOf.size, `${prefix}childrenOf.size`).toBe(expected.childrenOf.size);
  for (const [parentKey, expectedChildren] of expected.childrenOf) {
    const actualChildren = actual.childrenOf.get(parentKey);
    expect(actualChildren, `${prefix}childrenOf has ${parentKey}`).toBeDefined();
    expect(actualChildren!.size, `${prefix}childrenOf[${parentKey}].size`).toBe(expectedChildren.size);
    for (const [sid, expectedGroup] of expectedChildren) {
      const actualGroup = actualChildren!.get(sid);
      expect(actualGroup, `${prefix}childrenOf[${parentKey}] has ${sid}`).toBeDefined();
      assertSlotGroupEquals(actualGroup!, expectedGroup, `${prefix}childrenOf[${parentKey}][${sid}]`);
    }
  }
}

function assertSlotGroupEquals(
  actual: SlotGroup,
  expected: SlotGroup,
  message?: string,
): void {
  const prefix = message ? `${message}: ` : '';
  expect(actual.slotId, `${prefix}slotId`).toBe(expected.slotId);
  expect(actual.policy, `${prefix}policy`).toBe(expected.policy);
  expect(actual.childKey, `${prefix}childKey`).toBe(expected.childKey);

  // Compare structure keys (order-independent)
  const actualKeys = new Set(actual.structureKeys);
  const expectedKeys = new Set(expected.structureKeys);
  expect(actualKeys, `${prefix}structureKeys`).toEqual(expectedKeys);

  // Compare structures count
  expect(actual.structures.length, `${prefix}structures.length`).toBe(expected.structures.length);
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
// New root structure
// ===========================================================================

describe('IncrementalStructureIndex', () => {
  describe('new root structure', () => {
    it('creates a SlotGroup and appears in roots', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');

      const delta = stage.step(cset(root));

      expect(delta.isEmpty).toBe(false);
      expect(delta.updates.size).toBe(1);

      const sid = slotId(root);
      const group = delta.updates.get(sid);
      expect(group).toBeDefined();
      expect(group!.slotId).toBe(sid);
      expect(group!.policy).toBe('map');
      expect(group!.childKey).toBe('doc');
      expect(group!.structures.length).toBe(1);
      expect(cnIdKey(group!.structures[0]!.id)).toBe(cnIdKey(root.id));
      expect(group!.structureKeys.has(cnIdKey(root.id))).toBe(true);

      // Also in current()
      const index = stage.current();
      expect(index.roots.has('doc')).toBe(true);
      expect(index.roots.get('doc')!.slotId).toBe(sid);
    });

    it('creates a seq root', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'list', 'seq');

      const delta = stage.step(cset(root));

      expect(delta.isEmpty).toBe(false);
      const sid = slotId(root);
      const group = delta.updates.get(sid)!;
      expect(group.policy).toBe('seq');
      expect(group.childKey).toBe('list');
    });

    it('creates multiple roots in a single delta', () => {
      const stage = createIncrementalStructureIndex();
      const root1 = makeRoot('alice', 0, 'doc');
      const root2 = makeRoot('alice', 1, 'config');

      const delta = stage.step(csetMany(root1, root2));

      expect(delta.isEmpty).toBe(false);
      expect(delta.updates.size).toBe(2);
      expect(delta.updates.has(slotId(root1))).toBe(true);
      expect(delta.updates.has(slotId(root2))).toBe(true);

      const index = stage.current();
      expect(index.roots.size).toBe(2);
    });

    it('creates multiple roots across separate steps', () => {
      const stage = createIncrementalStructureIndex();
      const root1 = makeRoot('alice', 0, 'doc');
      const root2 = makeRoot('alice', 1, 'config');

      const d1 = stage.step(cset(root1));
      expect(d1.isEmpty).toBe(false);
      expect(d1.updates.size).toBe(1);

      const d2 = stage.step(cset(root2));
      expect(d2.isEmpty).toBe(false);
      expect(d2.updates.size).toBe(1);

      const index = stage.current();
      expect(index.roots.size).toBe(2);
      expect(index.byId.size).toBe(2);
    });
  });

  // ===========================================================================
  // New map child
  // ===========================================================================

  describe('new map child', () => {
    it('creates a SlotGroup, appears in childrenOf for parent', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');

      stage.step(cset(root));
      const delta = stage.step(cset(child));

      expect(delta.isEmpty).toBe(false);
      expect(delta.updates.size).toBe(1);

      const sid = slotId(child);
      const group = delta.updates.get(sid)!;
      expect(group.slotId).toBe(sid);
      expect(group.policy).toBe('map');
      expect(group.childKey).toBe('name');
      expect(group.structures.length).toBe(1);

      // Check childrenOf
      const index = stage.current();
      const parentKey = cnIdKey(root.id);
      const children = index.childrenOf.get(parentKey);
      expect(children).toBeDefined();
      expect(children!.has(sid)).toBe(true);
    });

    it('child arriving before parent still indexes correctly', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');

      // Child first, then parent
      const d1 = stage.step(cset(child));
      expect(d1.isEmpty).toBe(false);

      const d2 = stage.step(cset(root));
      expect(d2.isEmpty).toBe(false);

      const index = stage.current();
      expect(index.roots.has('doc')).toBe(true);
      const parentKey = cnIdKey(root.id);
      const children = index.childrenOf.get(parentKey);
      expect(children).toBeDefined();
      expect(children!.has(slotId(child))).toBe(true);
    });

    it('multiple map children under same parent', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const child1 = makeMapChild('alice', 1, root.id, 'name');
      const child2 = makeMapChild('alice', 2, root.id, 'age');

      stage.step(cset(root));
      stage.step(cset(child1));
      const delta = stage.step(cset(child2));

      expect(delta.isEmpty).toBe(false);

      const index = stage.current();
      const parentKey = cnIdKey(root.id);
      const children = index.childrenOf.get(parentKey)!;
      expect(children.size).toBe(2);
      expect(children.has(slotId(child1))).toBe(true);
      expect(children.has(slotId(child2))).toBe(true);
    });

    it('nested map children (grandchild)', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'profile');
      const grandchild = makeMapChild('alice', 2, child.id, 'name');

      stage.step(csetMany(root, child, grandchild));

      const index = stage.current();
      expect(index.byId.size).toBe(3);
      expect(index.slotGroups.size).toBe(3);

      // Root → child
      const rootChildren = index.childrenOf.get(cnIdKey(root.id))!;
      expect(rootChildren.size).toBe(1);
      expect(rootChildren.has(slotId(child))).toBe(true);

      // Child → grandchild
      const childChildren = index.childrenOf.get(cnIdKey(child.id))!;
      expect(childChildren.size).toBe(1);
      expect(childChildren.has(slotId(grandchild))).toBe(true);
    });
  });

  // ===========================================================================
  // Duplicate map child (same parent+key, different peer)
  // ===========================================================================

  describe('duplicate map child', () => {
    it('joins existing SlotGroup (concurrent map child creation)', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const child1 = makeMapChild('alice', 1, root.id, 'name');
      const child2 = makeMapChild('bob', 0, root.id, 'name'); // same parent+key

      stage.step(cset(root));
      const d1 = stage.step(cset(child1));

      expect(d1.updates.size).toBe(1);
      const sid = slotId(child1);
      expect(d1.updates.get(sid)!.structures.length).toBe(1);

      // Second peer creates same map child
      const d2 = stage.step(cset(child2));

      expect(d2.isEmpty).toBe(false);
      expect(d2.updates.size).toBe(1);

      // Same slot ID — the group was modified, not a new group
      expect(slotId(child2)).toBe(sid);
      const updatedGroup = d2.updates.get(sid)!;
      expect(updatedGroup.structures.length).toBe(2);
      expect(updatedGroup.structureKeys.size).toBe(2);
      expect(updatedGroup.structureKeys.has(cnIdKey(child1.id))).toBe(true);
      expect(updatedGroup.structureKeys.has(cnIdKey(child2.id))).toBe(true);

      // Current index has one slot group with two structures
      const index = stage.current();
      const parentKey = cnIdKey(root.id);
      const children = index.childrenOf.get(parentKey)!;
      expect(children.size).toBe(1); // still one slot
      const group = children.get(sid)!;
      expect(group.structures.length).toBe(2);
    });

    it('both children in same delta', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const child1 = makeMapChild('alice', 1, root.id, 'name');
      const child2 = makeMapChild('bob', 0, root.id, 'name');

      stage.step(cset(root));
      const delta = stage.step(csetMany(child1, child2));

      const sid = slotId(child1);
      expect(delta.updates.size).toBe(1); // one slot, two structures
      expect(delta.updates.get(sid)!.structures.length).toBe(2);
    });

    it('structureToSlot maps both CnIds to same slot', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const child1 = makeMapChild('alice', 1, root.id, 'name');
      const child2 = makeMapChild('bob', 0, root.id, 'name');

      stage.step(csetMany(root, child1, child2));

      const index = stage.current();
      const sid = slotId(child1);
      expect(index.structureToSlot.get(cnIdKey(child1.id))).toBe(sid);
      expect(index.structureToSlot.get(cnIdKey(child2.id))).toBe(sid);
    });
  });

  // ===========================================================================
  // New seq child
  // ===========================================================================

  describe('new seq child', () => {
    it('creates unique SlotGroup (CnId-keyed)', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'list', 'seq');
      const elem1 = makeSeqChild('alice', 1, root.id);
      const elem2 = makeSeqChild('alice', 2, root.id, elem1.id, null);

      stage.step(cset(root));
      const d1 = stage.step(cset(elem1));
      const d2 = stage.step(cset(elem2));

      // Each seq element gets its own slot
      expect(d1.updates.size).toBe(1);
      expect(d2.updates.size).toBe(1);

      const sid1 = slotId(elem1);
      const sid2 = slotId(elem2);
      expect(sid1).not.toBe(sid2);

      expect(d1.updates.has(sid1)).toBe(true);
      expect(d2.updates.has(sid2)).toBe(true);

      const index = stage.current();
      const parentKey = cnIdKey(root.id);
      const children = index.childrenOf.get(parentKey)!;
      expect(children.size).toBe(2);
    });

    it('seq elements from different peers are distinct slots', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'list', 'seq');
      const elem1 = makeSeqChild('alice', 1, root.id);
      const elem2 = makeSeqChild('bob', 0, root.id);

      stage.step(csetMany(root, elem1, elem2));

      const index = stage.current();
      const sid1 = slotId(elem1);
      const sid2 = slotId(elem2);
      expect(sid1).not.toBe(sid2);
      expect(index.slotGroups.size).toBe(3); // root + 2 seq elements
    });

    it('seq child has policy "seq"', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'list', 'seq');
      const elem = makeSeqChild('alice', 1, root.id);

      stage.step(csetMany(root, elem));

      const index = stage.current();
      const group = index.slotGroups.get(slotId(elem))!;
      expect(group.policy).toBe('seq');
    });

    it('seq child childKey is CnId key string', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'list', 'seq');
      const elem = makeSeqChild('alice', 1, root.id);

      stage.step(csetMany(root, elem));

      const index = stage.current();
      const group = index.slotGroups.get(slotId(elem))!;
      expect(group.childKey).toBe(cnIdKey(elem.id));
    });
  });

  // ===========================================================================
  // Non-structure constraints ignored
  // ===========================================================================

  describe('non-structure constraints', () => {
    it('value constraints are silently ignored', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const value = makeValue('alice', 1, root.id, 'hello');

      stage.step(cset(root));
      const delta = stage.step(cset(value));

      expect(delta.isEmpty).toBe(true);
      expect(stage.current().byId.size).toBe(1); // only root
    });

    it('retract constraints are silently ignored', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const retract = makeRetract('alice', 1, root.id);

      stage.step(cset(root));
      const delta = stage.step(cset(retract));

      expect(delta.isEmpty).toBe(true);
    });

    it('mixed delta with structure and non-structure', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const value = makeValue('alice', 1, root.id, 'hello');

      const delta = stage.step(csetMany(root, value));

      expect(delta.isEmpty).toBe(false);
      expect(delta.updates.size).toBe(1); // only root
      expect(stage.current().byId.size).toBe(1);
    });
  });

  // ===========================================================================
  // Weight −1 ignored
  // ===========================================================================

  describe('weight −1 ignored', () => {
    it('structure constraint with weight −1 is ignored', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');

      // First add it
      stage.step(cset(root, 1));
      expect(stage.current().byId.size).toBe(1);

      // Try to remove it (should be ignored — structure is permanent)
      const delta = stage.step(cset(root, -1));
      expect(delta.isEmpty).toBe(true);
      expect(stage.current().byId.size).toBe(1); // still there
    });
  });

  // ===========================================================================
  // Empty deltas
  // ===========================================================================

  describe('empty deltas', () => {
    it('empty input produces empty output', () => {
      const stage = createIncrementalStructureIndex();
      const delta = stage.step(zsetEmpty());

      expect(delta.isEmpty).toBe(true);
      expect(delta.updates.size).toBe(0);
    });

    it('structureIndexDeltaEmpty returns singleton', () => {
      const d1 = structureIndexDeltaEmpty();
      const d2 = structureIndexDeltaEmpty();
      expect(d1).toBe(d2); // same reference
      expect(d1.isEmpty).toBe(true);
      expect(d1.updates.size).toBe(0);
    });
  });

  // ===========================================================================
  // Duplicate constraint (same CnId)
  // ===========================================================================

  describe('duplicate constraint', () => {
    it('same CnId inserted twice is a no-op on second insertion', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');

      const d1 = stage.step(cset(root));
      expect(d1.isEmpty).toBe(false);

      const d2 = stage.step(cset(root));
      expect(d2.isEmpty).toBe(true);

      expect(stage.current().byId.size).toBe(1);
    });

    it('duplicate within same delta is handled (dedup)', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');

      // zsetFromEntries will merge duplicate keys, so this tests
      // the stage's own dedup rather than the Z-set's
      const delta = stage.step(cset(root));
      expect(delta.isEmpty).toBe(false);

      // Step again with same
      const delta2 = stage.step(cset(root));
      expect(delta2.isEmpty).toBe(true);
    });
  });

  // ===========================================================================
  // Reset
  // ===========================================================================

  describe('reset', () => {
    it('clears all state', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');

      stage.step(csetMany(root, child));
      expect(stage.current().byId.size).toBe(2);

      stage.reset();

      const index = stage.current();
      expect(index.byId.size).toBe(0);
      expect(index.slotGroups.size).toBe(0);
      expect(index.structureToSlot.size).toBe(0);
      expect(index.roots.size).toBe(0);
      expect(index.childrenOf.size).toBe(0);
    });

    it('can be reused after reset', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');

      stage.step(cset(root));
      stage.reset();

      const root2 = makeRoot('bob', 0, 'other');
      const delta = stage.step(cset(root2));

      expect(delta.isEmpty).toBe(false);
      const index = stage.current();
      expect(index.roots.size).toBe(1);
      expect(index.roots.has('other')).toBe(true);
      expect(index.roots.has('doc')).toBe(false);
    });
  });

  // ===========================================================================
  // Differential equivalence: incremental == batch
  // ===========================================================================

  describe('differential equivalence', () => {
    it('single root matches batch', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');

      stage.step(cset(root));

      const incremental = stage.current();
      const batch = buildStructureIndex([root]);

      assertIndexEquals(incremental, batch);
    });

    it('root + map child matches batch', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');

      stage.step(cset(root));
      stage.step(cset(child));

      assertIndexEquals(stage.current(), buildStructureIndex([root, child]));
    });

    it('root + seq children matches batch', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'list', 'seq');
      const e1 = makeSeqChild('alice', 1, root.id);
      const e2 = makeSeqChild('alice', 2, root.id, e1.id, null);
      const e3 = makeSeqChild('alice', 3, root.id, e2.id, null);

      stage.step(cset(root));
      stage.step(cset(e1));
      stage.step(cset(e2));
      stage.step(cset(e3));

      assertIndexEquals(stage.current(), buildStructureIndex([root, e1, e2, e3]));
    });

    it('concurrent map children (multi-structure slot group) matches batch', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const child1 = makeMapChild('alice', 1, root.id, 'name');
      const child2 = makeMapChild('bob', 0, root.id, 'name');

      stage.step(cset(root));
      stage.step(cset(child1));
      stage.step(cset(child2));

      assertIndexEquals(stage.current(), buildStructureIndex([root, child1, child2]));
    });

    it('complex tree matches batch', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const profile = makeMapChild('alice', 1, root.id, 'profile');
      const name = makeMapChild('alice', 2, profile.id, 'name');
      const age = makeMapChild('alice', 3, profile.id, 'age');
      const tags = makeMapChild('alice', 4, root.id, 'tags');

      const all = [root, profile, name, age, tags];

      // Feed one at a time
      for (const c of all) {
        stage.step(cset(c));
      }

      assertIndexEquals(stage.current(), buildStructureIndex(all));
    });

    it('batch feed (all in one delta) matches batch', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const profile = makeMapChild('alice', 1, root.id, 'profile');
      const name = makeMapChild('alice', 2, profile.id, 'name');

      const all = [root, profile, name];
      stage.step(csetMany(...all));

      assertIndexEquals(stage.current(), buildStructureIndex(all));
    });

    it('non-structure constraints in delta do not affect equivalence', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const value = makeValue('alice', 1, root.id, 'hello');
      const child = makeMapChild('alice', 2, root.id, 'name');

      stage.step(csetMany(root, value, child));

      // Batch only sees structure constraints
      assertIndexEquals(stage.current(), buildStructureIndex([root, value, child]));
    });
  });

  // ===========================================================================
  // All-permutation differential tests
  // ===========================================================================

  describe('all-permutation differential', () => {
    it('root + map child: all orderings match batch', () => {
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const all = [root, child];
      const batchResult = buildStructureIndex(all);

      for (const perm of permutations(all)) {
        const stage = createIncrementalStructureIndex();
        for (const c of perm) {
          stage.step(cset(c));
        }
        assertIndexEquals(
          stage.current(),
          batchResult,
          `permutation: ${perm.map((c) => cnIdKey(c.id)).join(', ')}`,
        );
      }
    });

    it('root + two map children: all orderings match batch', () => {
      const root = makeRoot('alice', 0, 'doc');
      const child1 = makeMapChild('alice', 1, root.id, 'name');
      const child2 = makeMapChild('alice', 2, root.id, 'age');
      const all = [root, child1, child2];
      const batchResult = buildStructureIndex(all);

      for (const perm of permutations(all)) {
        const stage = createIncrementalStructureIndex();
        for (const c of perm) {
          stage.step(cset(c));
        }
        assertIndexEquals(
          stage.current(),
          batchResult,
          `permutation: ${perm.map((c) => cnIdKey(c.id)).join(', ')}`,
        );
      }
    });

    it('root + nested children (3 levels): all orderings match batch', () => {
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'profile');
      const grandchild = makeMapChild('alice', 2, child.id, 'name');
      const all = [root, child, grandchild];
      const batchResult = buildStructureIndex(all);

      for (const perm of permutations(all)) {
        const stage = createIncrementalStructureIndex();
        for (const c of perm) {
          stage.step(cset(c));
        }
        assertIndexEquals(
          stage.current(),
          batchResult,
          `permutation: ${perm.map((c) => cnIdKey(c.id)).join(', ')}`,
        );
      }
    });

    it('concurrent map children: all orderings match batch', () => {
      const root = makeRoot('alice', 0, 'doc');
      const child1 = makeMapChild('alice', 1, root.id, 'name');
      const child2 = makeMapChild('bob', 0, root.id, 'name');
      const all = [root, child1, child2];
      const batchResult = buildStructureIndex(all);

      for (const perm of permutations(all)) {
        const stage = createIncrementalStructureIndex();
        for (const c of perm) {
          stage.step(cset(c));
        }
        assertIndexEquals(
          stage.current(),
          batchResult,
          `permutation: ${perm.map((c) => cnIdKey(c.id)).join(', ')}`,
        );
      }
    });

    it('seq elements under seq root: all orderings match batch', () => {
      const root = makeRoot('alice', 0, 'list', 'seq');
      const e1 = makeSeqChild('alice', 1, root.id);
      const e2 = makeSeqChild('alice', 2, root.id, e1.id, null);
      const all = [root, e1, e2];
      const batchResult = buildStructureIndex(all);

      for (const perm of permutations(all)) {
        const stage = createIncrementalStructureIndex();
        for (const c of perm) {
          stage.step(cset(c));
        }
        assertIndexEquals(
          stage.current(),
          batchResult,
          `permutation: ${perm.map((c) => cnIdKey(c.id)).join(', ')}`,
        );
      }
    });

    it('mixed structure types (map + seq) with 4 constraints: all orderings match batch', () => {
      const root = makeRoot('alice', 0, 'doc');
      const seqContainer = makeMapChild('alice', 1, root.id, 'items');
      const elem1 = makeSeqChild('alice', 2, seqContainer.id);
      const elem2 = makeSeqChild('alice', 3, seqContainer.id, elem1.id, null);
      const all = [root, seqContainer, elem1, elem2];
      const batchResult = buildStructureIndex(all);

      for (const perm of permutations(all)) {
        const stage = createIncrementalStructureIndex();
        for (const c of perm) {
          stage.step(cset(c));
        }
        assertIndexEquals(
          stage.current(),
          batchResult,
          `permutation: ${perm.map((c) => cnIdKey(c.id)).join(', ')}`,
        );
      }
    });
  });

  // ===========================================================================
  // Delta correctness
  // ===========================================================================

  describe('delta correctness', () => {
    it('delta only contains newly created or modified groups', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const child1 = makeMapChild('alice', 1, root.id, 'name');
      const child2 = makeMapChild('alice', 2, root.id, 'age');

      stage.step(csetMany(root, child1));

      // Only child2 is new — root and child1 should NOT be in the delta
      const delta = stage.step(cset(child2));
      expect(delta.updates.size).toBe(1);
      expect(delta.updates.has(slotId(child2))).toBe(true);
      expect(delta.updates.has(slotId(root))).toBe(false);
      expect(delta.updates.has(slotId(child1))).toBe(false);
    });

    it('modified group (concurrent map child) appears in delta', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const child1 = makeMapChild('alice', 1, root.id, 'name');

      stage.step(csetMany(root, child1));

      // Second peer creates same slot — group is modified
      const child2 = makeMapChild('bob', 0, root.id, 'name');
      const delta = stage.step(cset(child2));

      expect(delta.updates.size).toBe(1);
      const sid = slotId(child1);
      expect(delta.updates.has(sid)).toBe(true);
      expect(delta.updates.get(sid)!.structures.length).toBe(2);
    });

    it('delta group reflects accumulated state, not just the new addition', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const child1 = makeMapChild('alice', 1, root.id, 'name');
      const child2 = makeMapChild('bob', 0, root.id, 'name');
      const child3 = makeMapChild('charlie', 0, root.id, 'name');

      stage.step(csetMany(root, child1));
      stage.step(cset(child2));
      const delta = stage.step(cset(child3));

      // The group in the delta should have all 3 structures
      const sid = slotId(child1);
      const group = delta.updates.get(sid)!;
      expect(group.structures.length).toBe(3);
      expect(group.structureKeys.size).toBe(3);
    });
  });

  // ===========================================================================
  // current() snapshot correctness
  // ===========================================================================

  describe('current() snapshot', () => {
    it('current() is live — reflects all steps so far', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'name');

      expect(stage.current().byId.size).toBe(0);

      stage.step(cset(root));
      expect(stage.current().byId.size).toBe(1);
      expect(stage.current().roots.size).toBe(1);

      stage.step(cset(child));
      expect(stage.current().byId.size).toBe(2);
      expect(stage.current().slotGroups.size).toBe(2);
    });

    it('current() byId contains all structure constraints', () => {
      const stage = createIncrementalStructureIndex();
      const root = makeRoot('alice', 0, 'doc');
      const child1 = makeMapChild('alice', 1, root.id, 'name');
      const child2 = makeMapChild('bob', 0, root.id, 'name');

      stage.step(csetMany(root, child1, child2));

      const index = stage.current();
      expect(index.byId.size).toBe(3);
      expect(index.byId.has(cnIdKey(root.id))).toBe(true);
      expect(index.byId.has(cnIdKey(child1.id))).toBe(true);
      expect(index.byId.has(cnIdKey(child2.id))).toBe(true);
    });
  });
});