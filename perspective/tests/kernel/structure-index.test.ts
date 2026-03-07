// === Structure Index Tests ===
// Tests for structure index construction, slot identity computation,
// parent→children indexes, and concurrent map structure creation.

import { describe, it, expect } from 'vitest';
import {
  buildStructureIndex,
  slotId,
  childKey,
  getStructure,
  getSlotId,
  getSlotGroup,
  getChildren,
  hasStructure,
  getChildrenOfSlotGroup,
  type StructureIndex,
  type SlotGroup,
} from '../../src/kernel/structure-index.js';
import { createCnId, cnIdKey } from '../../src/kernel/cnid.js';
import { STUB_SIGNATURE } from '../../src/kernel/signature.js';
import type {
  StructureConstraint,
  ValueConstraint,
  Constraint,
  CnId,
  PeerID,
} from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStructureRoot(
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

function makeStructureSeq(
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

function makeValueConstraint(
  peer: PeerID,
  counter: number,
  target: CnId,
  content: unknown,
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

// ---------------------------------------------------------------------------
// slotId() — unit tests for slot identity computation
// ---------------------------------------------------------------------------

describe('slotId', () => {
  it('root slot = "root:<containerId>"', () => {
    const sc = makeStructureRoot('alice', 0, 'profile');
    expect(slotId(sc)).toBe('root:profile');
  });

  it('map child slot = "map:<parentKey>:<key>"', () => {
    const parent = createCnId('alice', 0);
    const sc = makeStructureMap('alice', 1, parent, 'title');
    expect(slotId(sc)).toBe(`map:${cnIdKey(parent)}:title`);
  });

  it('seq child slot = "seq:<ownCnIdKey>"', () => {
    const parent = createCnId('alice', 0);
    const sc = makeStructureSeq('bob', 3, parent, null, null);
    expect(slotId(sc)).toBe(`seq:${cnIdKey(sc.id)}`);
  });

  it('two map children with same (parent, key) have the same slotId', () => {
    const parent = createCnId('alice', 0);
    const sc1 = makeStructureMap('alice', 1, parent, 'title');
    const sc2 = makeStructureMap('bob', 1, parent, 'title');
    expect(slotId(sc1)).toBe(slotId(sc2));
  });

  it('two map children with different keys have different slotIds', () => {
    const parent = createCnId('alice', 0);
    const sc1 = makeStructureMap('alice', 1, parent, 'title');
    const sc2 = makeStructureMap('alice', 2, parent, 'body');
    expect(slotId(sc1)).not.toBe(slotId(sc2));
  });

  it('two map children with same key but different parents have different slotIds', () => {
    const parent1 = createCnId('alice', 0);
    const parent2 = createCnId('bob', 0);
    const sc1 = makeStructureMap('alice', 1, parent1, 'title');
    const sc2 = makeStructureMap('bob', 1, parent2, 'title');
    expect(slotId(sc1)).not.toBe(slotId(sc2));
  });

  it('two seq children always have different slotIds (unique CnIds)', () => {
    const parent = createCnId('alice', 0);
    const sc1 = makeStructureSeq('alice', 1, parent, null, null);
    const sc2 = makeStructureSeq('bob', 1, parent, null, null);
    expect(slotId(sc1)).not.toBe(slotId(sc2));
  });
});

// ---------------------------------------------------------------------------
// childKey() — unit tests for child key extraction
// ---------------------------------------------------------------------------

describe('childKey', () => {
  it('root childKey = containerId', () => {
    const sc = makeStructureRoot('alice', 0, 'profile');
    expect(childKey(sc)).toBe('profile');
  });

  it('map childKey = user-provided key string', () => {
    const parent = createCnId('alice', 0);
    const sc = makeStructureMap('alice', 1, parent, 'title');
    expect(childKey(sc)).toBe('title');
  });

  it('seq childKey = CnId key string', () => {
    const parent = createCnId('alice', 0);
    const sc = makeStructureSeq('bob', 3, parent, null, null);
    expect(childKey(sc)).toBe(cnIdKey(sc.id));
  });
});

// ---------------------------------------------------------------------------
// buildStructureIndex — construction and indexing
// ---------------------------------------------------------------------------

describe('buildStructureIndex', () => {
  describe('basic indexing', () => {
    it('indexes structure constraints by CnId', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const index = buildStructureIndex([root]);

      expect(getStructure(index, root.id)).toBe(root);
      expect(hasStructure(index, root.id)).toBe(true);
    });

    it('ignores non-structure constraints', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const value = makeValueConstraint('alice', 1, root.id, 'hello');
      const index = buildStructureIndex([root, value]);

      expect(index.byId.size).toBe(1);
      expect(hasStructure(index, root.id)).toBe(true);
      expect(hasStructure(index, value.id)).toBe(false);
    });

    it('empty input produces empty index', () => {
      const index = buildStructureIndex([]);

      expect(index.byId.size).toBe(0);
      expect(index.roots.size).toBe(0);
      expect(index.slotGroups.size).toBe(0);
    });
  });

  describe('root containers', () => {
    it('root structures appear in the roots index', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const index = buildStructureIndex([root]);

      expect(index.roots.size).toBe(1);
      expect(index.roots.has('profile')).toBe(true);
    });

    it('multiple root containers are indexed separately', () => {
      const root1 = makeStructureRoot('alice', 0, 'profile');
      const root2 = makeStructureRoot('alice', 1, 'settings');
      const index = buildStructureIndex([root1, root2]);

      expect(index.roots.size).toBe(2);
      expect(index.roots.has('profile')).toBe(true);
      expect(index.roots.has('settings')).toBe(true);
    });

    it('root slot group contains the root structure constraint', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const index = buildStructureIndex([root]);

      const group = index.roots.get('profile');
      expect(group).toBeDefined();
      expect(group!.structures).toHaveLength(1);
      expect(group!.structures[0]).toBe(root);
      expect(group!.slotId).toBe('root:profile');
      expect(group!.childKey).toBe('profile');
      expect(group!.policy).toBe('map');
    });

    it('root with seq policy is indexed correctly', () => {
      const root = makeStructureRoot('alice', 0, 'todos', 'seq');
      const index = buildStructureIndex([root]);

      const group = index.roots.get('todos');
      expect(group!.policy).toBe('seq');
    });
  });

  describe('slot identity for map children', () => {
    it('map children with same (parent, key) grouped into same slot', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child1 = makeStructureMap('alice', 1, root.id, 'title');
      const child2 = makeStructureMap('bob', 1, root.id, 'title');
      const index = buildStructureIndex([root, child1, child2]);

      const slotId1 = getSlotId(index, child1.id);
      const slotId2 = getSlotId(index, child2.id);
      expect(slotId1).toBeDefined();
      expect(slotId1).toBe(slotId2);

      const group = getSlotGroup(index, slotId1!);
      expect(group).toBeDefined();
      expect(group!.structures).toHaveLength(2);
      expect(group!.structureKeys.size).toBe(2);
      expect(group!.structureKeys.has(cnIdKey(child1.id))).toBe(true);
      expect(group!.structureKeys.has(cnIdKey(child2.id))).toBe(true);
    });

    it('map children with different keys are distinct slots', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child1 = makeStructureMap('alice', 1, root.id, 'title');
      const child2 = makeStructureMap('alice', 2, root.id, 'body');
      const index = buildStructureIndex([root, child1, child2]);

      const slotId1 = getSlotId(index, child1.id);
      const slotId2 = getSlotId(index, child2.id);
      expect(slotId1).not.toBe(slotId2);
    });

    it('concurrent map structure creation — two peers independently create same (parent, key)', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      // Alice creates structure(map, parent=root, key="name")
      const aliceChild = makeStructureMap('alice', 1, root.id, 'name');
      // Bob independently creates structure(map, parent=root, key="name")
      const bobChild = makeStructureMap('bob', 1, root.id, 'name');

      const index = buildStructureIndex([root, aliceChild, bobChild]);

      // Both must be in the same slot group
      const slotIdAlice = getSlotId(index, aliceChild.id);
      const slotIdBob = getSlotId(index, bobChild.id);
      expect(slotIdAlice).toBe(slotIdBob);

      const group = getSlotGroup(index, slotIdAlice!);
      expect(group!.structures).toHaveLength(2);
      expect(group!.childKey).toBe('name');
    });
  });

  describe('slot identity for seq children', () => {
    it('each seq child has a unique slot identity', () => {
      const root = makeStructureRoot('alice', 0, 'todos', 'seq');
      const elem1 = makeStructureSeq('alice', 1, root.id, null, null);
      const elem2 = makeStructureSeq('alice', 2, root.id, elem1.id, null);
      const index = buildStructureIndex([root, elem1, elem2]);

      const slotId1 = getSlotId(index, elem1.id);
      const slotId2 = getSlotId(index, elem2.id);
      expect(slotId1).toBeDefined();
      expect(slotId2).toBeDefined();
      expect(slotId1).not.toBe(slotId2);
    });

    it('seq slot group contains exactly one structure constraint', () => {
      const root = makeStructureRoot('alice', 0, 'todos', 'seq');
      const elem = makeStructureSeq('alice', 1, root.id, null, null);
      const index = buildStructureIndex([root, elem]);

      const sid = getSlotId(index, elem.id);
      const group = getSlotGroup(index, sid!);
      expect(group!.structures).toHaveLength(1);
      expect(group!.structures[0]).toBe(elem);
    });
  });

  describe('parent→children index', () => {
    it('root with map children returns children via getChildren', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child1 = makeStructureMap('alice', 1, root.id, 'title');
      const child2 = makeStructureMap('alice', 2, root.id, 'body');
      const index = buildStructureIndex([root, child1, child2]);

      const children = getChildren(index, root.id);
      expect(children.size).toBe(2);
    });

    it('root with seq children returns children via getChildren', () => {
      const root = makeStructureRoot('alice', 0, 'todos', 'seq');
      const elem1 = makeStructureSeq('alice', 1, root.id, null, null);
      const elem2 = makeStructureSeq('alice', 2, root.id, elem1.id, null);
      const index = buildStructureIndex([root, elem1, elem2]);

      const children = getChildren(index, root.id);
      expect(children.size).toBe(2);
    });

    it('getChildren for unknown parent returns empty map', () => {
      const index = buildStructureIndex([]);
      const children = getChildren(index, createCnId('nobody', 99));
      expect(children.size).toBe(0);
    });

    it('leaf node has no children', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child = makeStructureMap('alice', 1, root.id, 'title');
      const index = buildStructureIndex([root, child]);

      const children = getChildren(index, child.id);
      expect(children.size).toBe(0);
    });

    it('nested children: root → map child → map grandchild', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child = makeStructureMap('alice', 1, root.id, 'address');
      const grandchild = makeStructureMap('alice', 2, child.id, 'city');
      const index = buildStructureIndex([root, child, grandchild]);

      const rootChildren = getChildren(index, root.id);
      expect(rootChildren.size).toBe(1);

      const childChildren = getChildren(index, child.id);
      expect(childChildren.size).toBe(1);

      const grandchildChildren = getChildren(index, grandchild.id);
      expect(grandchildChildren.size).toBe(0);
    });
  });

  describe('getChildrenOfSlotGroup', () => {
    it('merges children from multiple structures in a slot group (concurrent map creation)', () => {
      const root = makeStructureRoot('alice', 0, 'profile');

      // Alice and Bob independently create structure for key="name"
      const aliceName = makeStructureMap('alice', 1, root.id, 'name');
      const bobName = makeStructureMap('bob', 1, root.id, 'name');

      // Alice's child has a sub-key
      const aliceFirst = makeStructureMap('alice', 2, aliceName.id, 'first');
      // Bob's child has a sub-key
      const bobLast = makeStructureMap('bob', 2, bobName.id, 'last');

      const index = buildStructureIndex([root, aliceName, bobName, aliceFirst, bobLast]);

      const nameSlotId = getSlotId(index, aliceName.id)!;
      const nameGroup = getSlotGroup(index, nameSlotId)!;

      // getChildrenOfSlotGroup should merge children from both alice's and bob's "name" structures
      const merged = getChildrenOfSlotGroup(index, nameGroup);

      // Should have both "first" and "last" as children
      expect(merged.size).toBe(2);

      const childKeys = new Set<string>();
      for (const group of merged.values()) {
        childKeys.add(group.childKey);
      }
      expect(childKeys.has('first')).toBe(true);
      expect(childKeys.has('last')).toBe(true);
    });

    it('single-structure slot group returns direct children', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child = makeStructureMap('alice', 1, root.id, 'title');
      const index = buildStructureIndex([root, child]);

      const rootGroup = index.roots.get('profile')!;
      const children = getChildrenOfSlotGroup(index, rootGroup);
      expect(children.size).toBe(1);
    });
  });

  describe('structureToSlot mapping', () => {
    it('every structure constraint has a slot mapping', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child1 = makeStructureMap('alice', 1, root.id, 'title');
      const child2 = makeStructureMap('bob', 1, root.id, 'title');
      const seqRoot = makeStructureRoot('alice', 3, 'list', 'seq');
      const elem = makeStructureSeq('alice', 4, seqRoot.id, null, null);

      const index = buildStructureIndex([root, child1, child2, seqRoot, elem]);

      expect(index.structureToSlot.size).toBe(5);
      expect(getSlotId(index, root.id)).toBeDefined();
      expect(getSlotId(index, child1.id)).toBeDefined();
      expect(getSlotId(index, child2.id)).toBeDefined();
      expect(getSlotId(index, seqRoot.id)).toBeDefined();
      expect(getSlotId(index, elem.id)).toBeDefined();
    });

    it('unknown CnId returns undefined', () => {
      const index = buildStructureIndex([]);
      expect(getSlotId(index, createCnId('nobody', 99))).toBeUndefined();
    });
  });

  describe('hasStructure', () => {
    it('returns true for known structure', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const index = buildStructureIndex([root]);
      expect(hasStructure(index, root.id)).toBe(true);
    });

    it('returns false for unknown CnId', () => {
      const index = buildStructureIndex([]);
      expect(hasStructure(index, createCnId('nobody', 99))).toBe(false);
    });

    it('returns false for value constraint CnId', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const val = makeValueConstraint('alice', 1, root.id, 'hi');
      const index = buildStructureIndex([root, val]);
      expect(hasStructure(index, val.id)).toBe(false);
    });
  });

  describe('complex scenarios', () => {
    it('three peers independently create the same map slot', () => {
      const root = makeStructureRoot('alice', 0, 'doc');
      const a = makeStructureMap('alice', 1, root.id, 'title');
      const b = makeStructureMap('bob', 1, root.id, 'title');
      const c = makeStructureMap('charlie', 1, root.id, 'title');

      const index = buildStructureIndex([root, a, b, c]);

      const sid = getSlotId(index, a.id)!;
      expect(getSlotId(index, b.id)).toBe(sid);
      expect(getSlotId(index, c.id)).toBe(sid);

      const group = getSlotGroup(index, sid)!;
      expect(group.structures).toHaveLength(3);
    });

    it('mixed map and seq containers in the same reality', () => {
      const mapRoot = makeStructureRoot('alice', 0, 'profile');
      const seqRoot = makeStructureRoot('alice', 1, 'todos', 'seq');

      const mapChild = makeStructureMap('alice', 2, mapRoot.id, 'name');
      const seqElem1 = makeStructureSeq('alice', 3, seqRoot.id, null, null);
      const seqElem2 = makeStructureSeq('alice', 4, seqRoot.id, seqElem1.id, null);

      const index = buildStructureIndex([mapRoot, seqRoot, mapChild, seqElem1, seqElem2]);

      // Two roots
      expect(index.roots.size).toBe(2);

      // Map root has 1 child
      const mapChildren = getChildren(index, mapRoot.id);
      expect(mapChildren.size).toBe(1);

      // Seq root has 2 children
      const seqChildren = getChildren(index, seqRoot.id);
      expect(seqChildren.size).toBe(2);

      // Slot identities are all distinct across types
      const allSlotIds = new Set(index.structureToSlot.values());
      expect(allSlotIds.size).toBe(5);
    });

    it('deeply nested structure: root → map → map → map', () => {
      const root = makeStructureRoot('alice', 0, 'config');
      const level1 = makeStructureMap('alice', 1, root.id, 'database');
      const level2 = makeStructureMap('alice', 2, level1.id, 'connection');
      const level3 = makeStructureMap('alice', 3, level2.id, 'host');

      const index = buildStructureIndex([root, level1, level2, level3]);

      expect(getChildren(index, root.id).size).toBe(1);
      expect(getChildren(index, level1.id).size).toBe(1);
      expect(getChildren(index, level2.id).size).toBe(1);
      expect(getChildren(index, level3.id).size).toBe(0);
    });
  });
});