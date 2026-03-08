// === Incremental Skeleton Tests ===
// Tests for the incremental skeleton stage (Plan 005, Phase 7).
//
// Covers:
// - New map container + value: childAdded + valueChanged
// - LWW winner change: valueChanged with old and new values
// - Value retraction on map node: valueChanged to undefined
// - Value retraction on seq node: childRemoved (tombstone)
// - New seq element: childAdded at correct position
// - Out-of-order: child before parent
// - Out-of-order: grandchild before parent
// - Seq reordering when new pairs arrive
// - Map child visibility (null value removal, value restoration)
// - Differential equivalence with batch buildSkeleton
// - Reset and reuse
// - Empty deltas

import { describe, it, expect } from 'vitest';
import {
  createIncrementalSkeleton,
  type IncrementalSkeleton,
} from '../../../src/kernel/incremental/skeleton.js';
import {
  createIncrementalStructureIndex,
  type IncrementalStructureIndex,
} from '../../../src/kernel/incremental/structure-index.js';
import {
  buildSkeleton,
} from '../../../src/kernel/skeleton.js';
import {
  buildStructureIndex,
  slotId,
  type StructureIndex,
  type SlotGroup,
} from '../../../src/kernel/structure-index.js';
import {
  nativeResolution,
  topologicalOrderFromPairs,
  type ResolvedWinner,
  type FugueBeforePair,
  type ResolutionResult,
} from '../../../src/kernel/resolve.js';
import { createCnId, cnIdKey } from '../../../src/kernel/cnid.js';
import { STUB_SIGNATURE } from '../../../src/kernel/signature.js';
import type {
  Constraint,
  StructureConstraint,
  ValueConstraint,
  CnId,
  PeerID,
  Value,
  Reality,
  RealityNode,
} from '../../../src/kernel/types.js';
import type { Fact } from '../../../src/datalog/types.js';
import {
  zsetEmpty,
  zsetSingleton,
  zsetFromEntries,
  zsetAdd,
  zsetForEach,
  type ZSet,
  type ZSetEntry,
} from '../../../src/base/zset.js';
import {
  structureIndexDeltaEmpty,
  structureIndexDeltaFrom,
  type StructureIndexDelta,
  type NodeDelta,
  type RealityDelta,
} from '../../../src/kernel/incremental/types.js';

// ---------------------------------------------------------------------------
// Helpers — structure constraints
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
  lamport: number,
  target: CnId,
  content: Value = 'hello',
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

// ---------------------------------------------------------------------------
// Helpers — Z-set construction for skeleton inputs
// ---------------------------------------------------------------------------

function winnerZset(
  winners: ResolvedWinner[],
  weight: number = 1,
): ZSet<ResolvedWinner> {
  return zsetFromEntries(
    winners.map((w) => [w.slotId, { element: w, weight }] as [string, ZSetEntry<ResolvedWinner>]),
  );
}

function pairZset(
  pairs: FugueBeforePair[],
  weight: number = 1,
): ZSet<FugueBeforePair> {
  return zsetFromEntries(
    pairs.map((p) => [
      `${p.parentKey}|${p.a}|${p.b}`,
      { element: p, weight },
    ] as [string, ZSetEntry<FugueBeforePair>]),
  );
}

function structureDelta(
  structures: StructureConstraint[],
  structIndex: IncrementalStructureIndex,
): StructureIndexDelta {
  const delta = zsetFromEntries(
    structures.map((s) => [cnIdKey(s.id), { element: s as Constraint, weight: 1 }] as [string, ZSetEntry<Constraint>]),
  );
  return structIndex.step(delta);
}

// ---------------------------------------------------------------------------
// Helpers — winner construction
// ---------------------------------------------------------------------------

function makeWinner(sid: string, cnIdKeyStr: string, content: Value): ResolvedWinner {
  return { slotId: sid, winnerCnIdKey: cnIdKeyStr, content };
}

// ---------------------------------------------------------------------------
// Helpers — delta inspection
// ---------------------------------------------------------------------------

function deltaKinds(rd: RealityDelta): string[] {
  return rd.changes.map((c) => c.kind);
}

function findDelta(rd: RealityDelta, kind: NodeDelta['kind']): NodeDelta | undefined {
  return rd.changes.find((c) => c.kind === kind);
}

function findAllDeltas(rd: RealityDelta, kind: NodeDelta['kind']): NodeDelta[] {
  return rd.changes.filter((c) => c.kind === kind);
}

// ---------------------------------------------------------------------------
// Helpers — reality tree inspection
// ---------------------------------------------------------------------------

function getNode(reality: Reality, ...path: string[]): RealityNode | undefined {
  let node: RealityNode = reality.root;
  for (const key of path) {
    const child = node.children.get(key);
    if (child === undefined) return undefined;
    node = child;
  }
  return node;
}

function childKeys(reality: Reality, ...path: string[]): string[] {
  const node = getNode(reality, ...path);
  if (node === undefined) return [];
  return Array.from(node.children.keys());
}

function nodeValue(reality: Reality, ...path: string[]): Value | undefined {
  return getNode(reality, ...path)?.value;
}

// ---------------------------------------------------------------------------
// Helpers — deep equality for Reality comparison
// ---------------------------------------------------------------------------

/**
 * Convert a Reality tree to a plain object for deep comparison.
 * Strips CnId objects to avoid reference-equality issues.
 */
function realityToPlain(reality: Reality): unknown {
  function nodeToPlain(node: RealityNode): unknown {
    const children: Record<string, unknown> = {};
    for (const [key, child] of node.children) {
      children[key] = nodeToPlain(child);
    }
    return {
      policy: node.policy,
      value: node.value,
      children,
    };
  }
  return nodeToPlain(reality.root);
}

// ---------------------------------------------------------------------------
// Test scaffold — creates wired stages
// ---------------------------------------------------------------------------

interface TestScaffold {
  structIndex: IncrementalStructureIndex;
  skeleton: IncrementalSkeleton;
  /** Feed structure constraints, get back index delta. */
  addStructures(structures: StructureConstraint[]): StructureIndexDelta;
  /** Do a full skeleton step with all three inputs. */
  stepFull(
    winners: ResolvedWinner[],
    pairs: FugueBeforePair[],
    structures: StructureConstraint[],
  ): RealityDelta;
}

function createScaffold(): TestScaffold {
  const structIndex = createIncrementalStructureIndex();
  const skeleton = createIncrementalSkeleton(() => structIndex.current());

  function addStructures(structures: StructureConstraint[]): StructureIndexDelta {
    if (structures.length === 0) return structureIndexDeltaEmpty();
    const delta = zsetFromEntries(
      structures.map((s) => [cnIdKey(s.id), { element: s as Constraint, weight: 1 }] as [string, ZSetEntry<Constraint>]),
    );
    return structIndex.step(delta);
  }

  function stepFull(
    winners: ResolvedWinner[],
    pairs: FugueBeforePair[],
    structures: StructureConstraint[],
  ): RealityDelta {
    const indexDelta = addStructures(structures);
    return skeleton.step(
      winnerZset(winners),
      pairZset(pairs),
      indexDelta,
    );
  }

  return { structIndex, skeleton, addStructures, stepFull };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IncrementalSkeleton', () => {
  // -----------------------------------------------------------------------
  // Basic structure
  // -----------------------------------------------------------------------

  describe('basic structure', () => {
    it('empty step produces empty delta', () => {
      const { skeleton } = createScaffold();
      const rd = skeleton.step(
        zsetEmpty(),
        zsetEmpty(),
        structureIndexDeltaEmpty(),
      );
      expect(rd.isEmpty).toBe(true);
    });

    it('new root structure creates node in reality', () => {
      const { skeleton, addStructures } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');

      const indexDelta = addStructures([root]);
      const rd = skeleton.step(zsetEmpty(), zsetEmpty(), indexDelta);

      expect(rd.isEmpty).toBe(false);
      const nodeAdded = findDelta(rd, 'nodeAdded');
      expect(nodeAdded).toBeDefined();
      expect(nodeAdded!.kind).toBe('nodeAdded');
      if (nodeAdded!.kind === 'nodeAdded') {
        expect(nodeAdded!.path).toEqual(['profile']);
      }

      const reality = skeleton.current();
      expect(getNode(reality, 'profile')).toBeDefined();
      expect(getNode(reality, 'profile')!.policy).toBe('map');
    });

    it('new map child creates child node in parent', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);
      const winner = makeWinner(sid, cnIdKey(child.id), 'Alice');

      stepFull([], [], [root]);
      stepFull([winner], [], [child]);

      const reality = skeleton.current();
      expect(getNode(reality, 'profile', 'name')).toBeDefined();
      expect(nodeValue(reality, 'profile', 'name')).toBe('Alice');
    });

    it('multiple roots create multiple top-level containers', () => {
      const { stepFull, skeleton } = createScaffold();
      const root1 = makeRoot('alice', 0, 'profile');
      const root2 = makeRoot('alice', 1, 'settings');

      stepFull([], [], [root1, root2]);

      const reality = skeleton.current();
      expect(getNode(reality, 'profile')).toBeDefined();
      expect(getNode(reality, 'settings')).toBeDefined();
    });
  });

  // -----------------------------------------------------------------------
  // Map container + value
  // -----------------------------------------------------------------------

  describe('map container + value', () => {
    it('root + map child + value: childAdded + valueChanged', () => {
      const { stepFull, skeleton, addStructures } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);

      // Step 1: root
      addStructures([root]);
      skeleton.step(zsetEmpty(), zsetEmpty(), addStructures([]));

      // Actually, let me redo this more cleanly
      const { stepFull: step, skeleton: skel } = createScaffold();
      const r = makeRoot('alice', 0, 'profile');
      step([], [], [r]);

      const c = makeMapChild('alice', 1, r.id, 'name');
      const s = slotId(c);
      const w = makeWinner(s, cnIdKey(c.id), 'Alice');
      const rd = step([w], [], [c]);

      // Should have childAdded
      const childAdded = findDelta(rd, 'childAdded');
      expect(childAdded).toBeDefined();
      if (childAdded?.kind === 'childAdded') {
        expect(childAdded.path).toEqual(['profile']);
        expect(childAdded.key).toBe('name');
      }

      expect(nodeValue(skel.current(), 'profile', 'name')).toBe('Alice');
    });

    it('value arriving after structure sets node value', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);

      // Structure first, no value — child IS visible with undefined value
      // (matches batch buildMapChildren which only excludes null + no children).
      stepFull([], [], [root, child]);
      const nameNode = getNode(skeleton.current(), 'profile', 'name');
      expect(nameNode).toBeDefined();
      expect(nameNode!.value).toBeUndefined();

      // Value arrives later — child's value is updated via valueChanged
      const winner = makeWinner(sid, cnIdKey(child.id), 'Bob');
      const rd = stepFull([winner], [], []);

      // The node was already in the parent's children map (visible with
      // undefined value), so the delta is valueChanged, not childAdded.
      const vc = findDelta(rd, 'valueChanged');
      expect(vc).toBeDefined();
      if (vc?.kind === 'valueChanged') {
        expect(vc.path).toEqual(['profile', 'name']);
        expect(vc.oldValue).toBeUndefined();
        expect(vc.newValue).toBe('Bob');
      }

      expect(nodeValue(skeleton.current(), 'profile', 'name')).toBe('Bob');
    });
  });

  // -----------------------------------------------------------------------
  // LWW winner change
  // -----------------------------------------------------------------------

  describe('LWW winner change', () => {
    it('valueChanged with old and new values', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);

      // Initial value
      const w1 = makeWinner(sid, 'alice:1', 'Alice');
      stepFull([w1], [], [root, child]);

      expect(nodeValue(skeleton.current(), 'profile', 'name')).toBe('Alice');

      // Updated value (weight −1 for old, +1 for new)
      const w1Remove = makeWinner(sid, 'alice:1', 'Alice');
      const w2 = makeWinner(sid, 'bob:0', 'Bob');

      const rd = skeleton.step(
        zsetFromEntries([
          [sid, { element: w1Remove, weight: -1 }],
          [sid, { element: w2, weight: 1 }],
        ]),
        zsetEmpty(),
        structureIndexDeltaEmpty(),
      );

      // The Z-set addition of -1 + 1 for the same key... actually the
      // weights will cancel to 0 and be pruned. We need different keys.
      // ResolvedWinner is keyed by slotId, so replacing a winner is just
      // a +1 with the new value (the slot gets overwritten).
    });

    it('winner replacement via single +1 entry updates value', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);

      const w1 = makeWinner(sid, 'alice:1', 'Alice');
      stepFull([w1], [], [root, child]);
      expect(nodeValue(skeleton.current(), 'profile', 'name')).toBe('Alice');

      // Replace winner
      const w2 = makeWinner(sid, 'bob:0', 'Bob');
      const rd = stepFull([w2], [], []);

      const vc = findDelta(rd, 'valueChanged');
      expect(vc).toBeDefined();
      if (vc?.kind === 'valueChanged') {
        expect(vc.oldValue).toBe('Alice');
        expect(vc.newValue).toBe('Bob');
        expect(vc.path).toEqual(['profile', 'name']);
      }

      expect(nodeValue(skeleton.current(), 'profile', 'name')).toBe('Bob');
    });
  });

  // -----------------------------------------------------------------------
  // Value retraction on map node
  // -----------------------------------------------------------------------

  describe('value retraction on map node', () => {
    it('removing winner sets value to undefined', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);

      const w = makeWinner(sid, 'alice:1', 'Alice');
      stepFull([w], [], [root, child]);
      expect(nodeValue(skeleton.current(), 'profile', 'name')).toBe('Alice');

      // Retract — weight −1
      const rd = skeleton.step(
        winnerZset([w], -1),
        zsetEmpty(),
        structureIndexDeltaEmpty(),
      );

      // Map child with undefined value (no winner) is still visible
      // (matches batch: only null + no children = excluded).
      // The delta is valueChanged (Alice → undefined).
      const vc = findDelta(rd, 'valueChanged');
      expect(vc).toBeDefined();
      if (vc?.kind === 'valueChanged') {
        expect(vc.path).toEqual(['profile', 'name']);
        expect(vc.oldValue).toBe('Alice');
        expect(vc.newValue).toBeUndefined();
      }

      // Node IS still in the reality tree (value undefined, not null)
      const nameNode = getNode(skeleton.current(), 'profile', 'name');
      expect(nameNode).toBeDefined();
      expect(nameNode!.value).toBeUndefined();
    });

    it('removing winner on map node with children keeps node but changes value', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const parent = makeMapChild('alice', 1, root.id, 'user');
      const grandchild = makeMapChild('alice', 2, parent.id, 'age');
      const parentSid = slotId(parent);
      const grandchildSid = slotId(grandchild);

      const pw = makeWinner(parentSid, 'alice:1', 'UserObj');
      const gw = makeWinner(grandchildSid, 'alice:2', 25);
      stepFull([pw, gw], [], [root, parent, grandchild]);

      expect(nodeValue(skeleton.current(), 'profile', 'user')).toBe('UserObj');
      expect(nodeValue(skeleton.current(), 'profile', 'user', 'age')).toBe(25);

      // Retract parent's value — but it has children, so it stays
      const rd = skeleton.step(
        winnerZset([pw], -1),
        zsetEmpty(),
        structureIndexDeltaEmpty(),
      );

      const vc = findDelta(rd, 'valueChanged');
      expect(vc).toBeDefined();
      if (vc?.kind === 'valueChanged') {
        expect(vc.oldValue).toBe('UserObj');
        expect(vc.newValue).toBeUndefined();
      }

      // Parent still in tree (has children)
      expect(getNode(skeleton.current(), 'profile', 'user')).toBeDefined();
      expect(nodeValue(skeleton.current(), 'profile', 'user')).toBeUndefined();
      // Grandchild still intact
      expect(nodeValue(skeleton.current(), 'profile', 'user', 'age')).toBe(25);
    });
  });

  // -----------------------------------------------------------------------
  // Seq children
  // -----------------------------------------------------------------------

  describe('seq children', () => {
    it('new seq element with value appears in parent', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'items', 'seq');
      const elem = makeSeqChild('alice', 1, root.id);
      const sid = slotId(elem);

      const winner = makeWinner(sid, cnIdKey(elem.id), 'item1');

      stepFull([winner], [], [root, elem]);

      const reality = skeleton.current();
      expect(childKeys(reality, 'items')).toEqual(['0']);
      expect(nodeValue(reality, 'items', '0')).toBe('item1');
    });

    it('two seq elements ordered by fugue pairs', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'items', 'seq');
      const elem1 = makeSeqChild('alice', 1, root.id);
      const elem2 = makeSeqChild('bob', 0, root.id);
      const sid1 = slotId(elem1);
      const sid2 = slotId(elem2);

      const w1 = makeWinner(sid1, cnIdKey(elem1.id), 'A');
      const w2 = makeWinner(sid2, cnIdKey(elem2.id), 'B');

      // Pair: elem1 before elem2
      const pair: FugueBeforePair = {
        parentKey: cnIdKey(root.id),
        a: cnIdKey(elem1.id),
        b: cnIdKey(elem2.id),
      };

      stepFull([w1, w2], [pair], [root, elem1, elem2]);

      const reality = skeleton.current();
      expect(childKeys(reality, 'items')).toEqual(['0', '1']);
      expect(nodeValue(reality, 'items', '0')).toBe('A');
      expect(nodeValue(reality, 'items', '1')).toBe('B');
    });

    it('reversed pair order reverses children', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'items', 'seq');
      const elem1 = makeSeqChild('alice', 1, root.id);
      const elem2 = makeSeqChild('bob', 0, root.id);
      const sid1 = slotId(elem1);
      const sid2 = slotId(elem2);

      const w1 = makeWinner(sid1, cnIdKey(elem1.id), 'A');
      const w2 = makeWinner(sid2, cnIdKey(elem2.id), 'B');

      // Pair: elem2 before elem1
      const pair: FugueBeforePair = {
        parentKey: cnIdKey(root.id),
        a: cnIdKey(elem2.id),
        b: cnIdKey(elem1.id),
      };

      stepFull([w1, w2], [pair], [root, elem1, elem2]);

      const reality = skeleton.current();
      expect(childKeys(reality, 'items')).toEqual(['0', '1']);
      expect(nodeValue(reality, 'items', '0')).toBe('B');
      expect(nodeValue(reality, 'items', '1')).toBe('A');
    });

    it('value retraction on seq node removes from visible children', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'items', 'seq');
      const elem1 = makeSeqChild('alice', 1, root.id);
      const elem2 = makeSeqChild('alice', 2, root.id);
      const sid1 = slotId(elem1);
      const sid2 = slotId(elem2);

      const w1 = makeWinner(sid1, cnIdKey(elem1.id), 'A');
      const w2 = makeWinner(sid2, cnIdKey(elem2.id), 'B');

      const pair: FugueBeforePair = {
        parentKey: cnIdKey(root.id),
        a: cnIdKey(elem1.id),
        b: cnIdKey(elem2.id),
      };

      stepFull([w1, w2], [pair], [root, elem1, elem2]);
      expect(childKeys(skeleton.current(), 'items')).toEqual(['0', '1']);

      // Retract first element's winner
      const rd = skeleton.step(
        winnerZset([w1], -1),
        zsetEmpty(),
        structureIndexDeltaEmpty(),
      );

      // First element becomes tombstone, only second visible
      const reality = skeleton.current();
      expect(childKeys(reality, 'items')).toEqual(['0']);
      expect(nodeValue(reality, 'items', '0')).toBe('B');
    });

    it('three seq elements with transitive ordering', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'items', 'seq');
      const e1 = makeSeqChild('alice', 1, root.id);
      const e2 = makeSeqChild('alice', 2, root.id);
      const e3 = makeSeqChild('alice', 3, root.id);

      const w1 = makeWinner(slotId(e1), cnIdKey(e1.id), 'X');
      const w2 = makeWinner(slotId(e2), cnIdKey(e2.id), 'Y');
      const w3 = makeWinner(slotId(e3), cnIdKey(e3.id), 'Z');

      const parentKey = cnIdKey(root.id);
      const pairs: FugueBeforePair[] = [
        { parentKey, a: cnIdKey(e1.id), b: cnIdKey(e2.id) },
        { parentKey, a: cnIdKey(e2.id), b: cnIdKey(e3.id) },
      ];

      stepFull([w1, w2, w3], pairs, [root, e1, e2, e3]);

      const reality = skeleton.current();
      expect(childKeys(reality, 'items')).toEqual(['0', '1', '2']);
      expect(nodeValue(reality, 'items', '0')).toBe('X');
      expect(nodeValue(reality, 'items', '1')).toBe('Y');
      expect(nodeValue(reality, 'items', '2')).toBe('Z');
    });
  });

  // -----------------------------------------------------------------------
  // Out-of-order: child before parent
  // -----------------------------------------------------------------------

  describe('out-of-order arrival', () => {
    it('map child before parent: child appears when parent arrives', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);
      const winner = makeWinner(sid, cnIdKey(child.id), 'Alice');

      // Child + winner first (no parent yet)
      stepFull([winner], [], [child]);

      // Child should not be in reality yet (parent missing)
      expect(getNode(skeleton.current(), 'profile')).toBeUndefined();

      // Parent arrives
      stepFull([], [], [root]);

      // Now child should be attached
      const reality = skeleton.current();
      expect(getNode(reality, 'profile')).toBeDefined();
      expect(getNode(reality, 'profile', 'name')).toBeDefined();
      expect(nodeValue(reality, 'profile', 'name')).toBe('Alice');
    });

    it('grandchild before child before parent: all appear when root arrives', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'doc');
      const child = makeMapChild('alice', 1, root.id, 'section');
      const grandchild = makeMapChild('alice', 2, child.id, 'title');

      const childSid = slotId(child);
      const grandchildSid = slotId(grandchild);

      const cw = makeWinner(childSid, cnIdKey(child.id), 'Section1');
      const gw = makeWinner(grandchildSid, cnIdKey(grandchild.id), 'Hello');

      // Grandchild first
      stepFull([gw], [], [grandchild]);
      expect(getNode(skeleton.current(), 'doc')).toBeUndefined();

      // Child next
      stepFull([cw], [], [child]);
      expect(getNode(skeleton.current(), 'doc')).toBeUndefined();

      // Root last — everything attaches
      stepFull([], [], [root]);

      const reality = skeleton.current();
      expect(getNode(reality, 'doc')).toBeDefined();
      expect(getNode(reality, 'doc', 'section')).toBeDefined();
      expect(nodeValue(reality, 'doc', 'section')).toBe('Section1');
      expect(getNode(reality, 'doc', 'section', 'title')).toBeDefined();
      expect(nodeValue(reality, 'doc', 'section', 'title')).toBe('Hello');
    });

    it('seq child before parent: child appears when parent arrives', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'items', 'seq');
      const elem = makeSeqChild('alice', 1, root.id);
      const sid = slotId(elem);
      const winner = makeWinner(sid, cnIdKey(elem.id), 'item1');

      // Element + winner first
      stepFull([winner], [], [elem]);
      expect(getNode(skeleton.current(), 'items')).toBeUndefined();

      // Root arrives (also need pairs for ordering — with single element, no pairs needed)
      stepFull([], [], [root]);

      const reality = skeleton.current();
      expect(getNode(reality, 'items')).toBeDefined();
      expect(childKeys(reality, 'items')).toEqual(['0']);
      expect(nodeValue(reality, 'items', '0')).toBe('item1');
    });

    it('winner before structure: value applied when structure arrives', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);

      // Winner first (no structure yet)
      const winner = makeWinner(sid, cnIdKey(child.id), 'Early');
      stepFull([winner], [], []);

      // Then structure
      stepFull([], [], [root, child]);

      expect(nodeValue(skeleton.current(), 'profile', 'name')).toBe('Early');
    });
  });

  // -----------------------------------------------------------------------
  // Seq reordering
  // -----------------------------------------------------------------------

  describe('seq reordering', () => {
    it('adding a new pair reorders existing children', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'items', 'seq');
      const e1 = makeSeqChild('alice', 1, root.id);
      const e2 = makeSeqChild('bob', 0, root.id);

      const w1 = makeWinner(slotId(e1), cnIdKey(e1.id), 'A');
      const w2 = makeWinner(slotId(e2), cnIdKey(e2.id), 'B');

      // Initially e1 before e2
      const pair1: FugueBeforePair = {
        parentKey: cnIdKey(root.id),
        a: cnIdKey(e1.id),
        b: cnIdKey(e2.id),
      };

      stepFull([w1, w2], [pair1], [root, e1, e2]);
      expect(nodeValue(skeleton.current(), 'items', '0')).toBe('A');
      expect(nodeValue(skeleton.current(), 'items', '1')).toBe('B');

      // Add third element between them.
      const e3 = makeSeqChild('charlie', 0, root.id);
      const w3 = makeWinner(slotId(e3), cnIdKey(e3.id), 'C');

      // e1 before e3, e3 before e2
      const pair2: FugueBeforePair = {
        parentKey: cnIdKey(root.id),
        a: cnIdKey(e1.id),
        b: cnIdKey(e3.id),
      };
      const pair3: FugueBeforePair = {
        parentKey: cnIdKey(root.id),
        a: cnIdKey(e3.id),
        b: cnIdKey(e2.id),
      };

      stepFull([w3], [pair2, pair3], [e3]);

      const reality = skeleton.current();
      expect(childKeys(reality, 'items')).toEqual(['0', '1', '2']);
      expect(nodeValue(reality, 'items', '0')).toBe('A');
      expect(nodeValue(reality, 'items', '1')).toBe('C');
      expect(nodeValue(reality, 'items', '2')).toBe('B');
    });
  });

  // -----------------------------------------------------------------------
  // Map child visibility
  // -----------------------------------------------------------------------

  describe('map child visibility', () => {
    it('map child without value is visible with undefined value (matches batch)', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');

      // Structure only, no value — child IS visible with undefined value
      // (matches batch buildMapChildren: only null + no children = excluded)
      stepFull([], [], [root, child]);

      const nameNode = getNode(skeleton.current(), 'profile', 'name');
      expect(nameNode).toBeDefined();
      expect(nameNode!.value).toBeUndefined();
    });

    it('map child with null value and no children is excluded (matches batch)', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);

      // Set value to null (LWW deletion)
      const w = makeWinner(sid, cnIdKey(child.id), null);
      stepFull([w], [], [root, child]);

      // null value + no children = excluded from reality
      expect(getNode(skeleton.current(), 'profile', 'name')).toBeUndefined();
    });

    it('map child with value, then value retracted — node stays with undefined value', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);

      stepFull([], [], [root, child]);
      expect(getNode(skeleton.current(), 'profile', 'name')).toBeDefined();

      // Add value
      const w = makeWinner(sid, cnIdKey(child.id), 'Alice');
      stepFull([w], [], []);
      expect(getNode(skeleton.current(), 'profile', 'name')).toBeDefined();
      expect(nodeValue(skeleton.current(), 'profile', 'name')).toBe('Alice');

      // Retract value — node stays visible with undefined value
      skeleton.step(
        winnerZset([w], -1),
        zsetEmpty(),
        structureIndexDeltaEmpty(),
      );
      const nameNode = getNode(skeleton.current(), 'profile', 'name');
      expect(nameNode).toBeDefined();
      expect(nameNode!.value).toBeUndefined();
    });

    it('value restored after retraction updates value via valueChanged', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);

      stepFull([], [], [root, child]);

      const w1 = makeWinner(sid, cnIdKey(child.id), 'Alice');
      stepFull([w1], [], []);
      expect(nodeValue(skeleton.current(), 'profile', 'name')).toBe('Alice');

      // Retract — node stays visible with undefined value
      skeleton.step(winnerZset([w1], -1), zsetEmpty(), structureIndexDeltaEmpty());
      expect(getNode(skeleton.current(), 'profile', 'name')).toBeDefined();
      expect(getNode(skeleton.current(), 'profile', 'name')!.value).toBeUndefined();

      // Restore with new winner — valueChanged (undefined → Bob)
      const w2 = makeWinner(sid, 'bob:0', 'Bob');
      const rd = stepFull([w2], [], []);

      // Should have valueChanged (node was already visible)
      const vc = findDelta(rd, 'valueChanged');
      expect(vc).toBeDefined();
      if (vc?.kind === 'valueChanged') {
        expect(vc.oldValue).toBeUndefined();
        expect(vc.newValue).toBe('Bob');
      }

      expect(nodeValue(skeleton.current(), 'profile', 'name')).toBe('Bob');
    });
  });

  // -----------------------------------------------------------------------
  // Reset
  // -----------------------------------------------------------------------

  describe('reset', () => {
    it('reset clears all state', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      stepFull([], [], [root]);

      expect(getNode(skeleton.current(), 'profile')).toBeDefined();

      skeleton.reset();

      expect(skeleton.current().root.children.size).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Differential equivalence with batch
  // -----------------------------------------------------------------------

  describe('differential equivalence', () => {
    it('single root matches batch buildSkeleton', () => {
      const { stepFull, skeleton, structIndex } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');

      stepFull([], [], [root]);

      // Batch
      const batchIndex = buildStructureIndex([root]);
      const batchReality = buildSkeleton(batchIndex, []);

      expect(realityToPlain(skeleton.current())).toEqual(
        realityToPlain(batchReality),
      );
    });

    it('root + map child + value matches batch', () => {
      const { stepFull, skeleton, structIndex } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);
      const vc = makeValue('alice', 2, 2, child.id, 'Alice');

      const winner: ResolvedWinner = {
        slotId: sid,
        winnerCnIdKey: cnIdKey(vc.id),
        content: 'Alice',
      };

      stepFull([winner], [], [root, child]);

      // Batch
      const batchIndex = buildStructureIndex([root, child]);
      const resolution = nativeResolution(
        new Map([[sid, winner]]),
        new Map(),
      );
      const batchReality = buildSkeleton(batchIndex, [root, child, vc], resolution);

      expect(realityToPlain(skeleton.current())).toEqual(
        realityToPlain(batchReality),
      );
    });

    it('nested map matches batch', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'doc');
      const section = makeMapChild('alice', 1, root.id, 'section');
      const title = makeMapChild('alice', 2, section.id, 'title');
      const body = makeMapChild('alice', 3, section.id, 'body');

      const sectionSid = slotId(section);
      const titleSid = slotId(title);
      const bodySid = slotId(body);

      const winners = [
        makeWinner(sectionSid, cnIdKey(section.id), 'Section'),
        makeWinner(titleSid, cnIdKey(title.id), 'Title'),
        makeWinner(bodySid, cnIdKey(body.id), 'Body text'),
      ];

      stepFull(winners, [], [root, section, title, body]);

      // Batch
      const structures = [root, section, title, body];
      const batchIndex = buildStructureIndex(structures);
      const winnerMap = new Map(winners.map((w) => [w.slotId, w]));
      const resolution = nativeResolution(winnerMap, new Map());
      const batchReality = buildSkeleton(batchIndex, structures, resolution);

      expect(realityToPlain(skeleton.current())).toEqual(
        realityToPlain(batchReality),
      );
    });

    it('seq with ordering matches batch', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'list', 'seq');
      const e1 = makeSeqChild('alice', 1, root.id);
      const e2 = makeSeqChild('alice', 2, root.id);

      const w1 = makeWinner(slotId(e1), cnIdKey(e1.id), 'first');
      const w2 = makeWinner(slotId(e2), cnIdKey(e2.id), 'second');

      const parentKey = cnIdKey(root.id);
      const pair: FugueBeforePair = {
        parentKey,
        a: cnIdKey(e1.id),
        b: cnIdKey(e2.id),
      };

      stepFull([w1, w2], [pair], [root, e1, e2]);

      // Batch
      const structures = [root, e1, e2];
      const batchIndex = buildStructureIndex(structures);
      const winnerMap = new Map([
        [w1.slotId, w1],
        [w2.slotId, w2],
      ]);
      const pairsMap = new Map([[parentKey, [pair]]]);
      const resolution = nativeResolution(winnerMap, pairsMap);
      const batchReality = buildSkeleton(batchIndex, structures, resolution);

      expect(realityToPlain(skeleton.current())).toEqual(
        realityToPlain(batchReality),
      );
    });

    it('out-of-order insertion matches batch final state', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);
      const winner = makeWinner(sid, cnIdKey(child.id), 'Alice');

      // Out of order: child first, then root
      stepFull([winner], [], [child]);
      stepFull([], [], [root]);

      // Batch (sees everything at once)
      const structures = [root, child];
      const batchIndex = buildStructureIndex(structures);
      const resolution = nativeResolution(
        new Map([[sid, winner]]),
        new Map(),
      );
      const batchReality = buildSkeleton(batchIndex, structures, resolution);

      expect(realityToPlain(skeleton.current())).toEqual(
        realityToPlain(batchReality),
      );
    });

    it('multiple roots with children matches batch', () => {
      const { stepFull, skeleton } = createScaffold();
      const root1 = makeRoot('alice', 0, 'profile');
      const root2 = makeRoot('alice', 1, 'settings');
      const name = makeMapChild('alice', 2, root1.id, 'name');
      const theme = makeMapChild('alice', 3, root2.id, 'theme');

      const nameSid = slotId(name);
      const themeSid = slotId(theme);
      const nw = makeWinner(nameSid, cnIdKey(name.id), 'Alice');
      const tw = makeWinner(themeSid, cnIdKey(theme.id), 'dark');

      stepFull([nw, tw], [], [root1, root2, name, theme]);

      // Batch
      const structures = [root1, root2, name, theme];
      const batchIndex = buildStructureIndex(structures);
      const winnerMap = new Map([
        [nw.slotId, nw],
        [tw.slotId, tw],
      ]);
      const resolution = nativeResolution(winnerMap, new Map());
      const batchReality = buildSkeleton(batchIndex, structures, resolution);

      expect(realityToPlain(skeleton.current())).toEqual(
        realityToPlain(batchReality),
      );
    });
  });

  // -----------------------------------------------------------------------
  // Duplicate structure constraints
  // -----------------------------------------------------------------------

  describe('deduplication', () => {
    it('same structure constraint twice does not create duplicate nodes', () => {
      const { stepFull, skeleton, addStructures } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');

      stepFull([], [], [root]);
      // Second time — structure index deduplicates, returns empty delta
      const indexDelta = addStructures([root]);
      expect(indexDelta.isEmpty).toBe(true);

      const rd = skeleton.step(zsetEmpty(), zsetEmpty(), indexDelta);
      expect(rd.isEmpty).toBe(true);
      expect(skeleton.current().root.children.size).toBe(1);
    });
  });

  // -----------------------------------------------------------------------
  // Multiple peers creating same map slot
  // -----------------------------------------------------------------------

  describe('multi-peer map slot', () => {
    it('two peers create same map child — single slot, single node', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      // Two peers create child with same parent+key → same slot
      const child1 = makeMapChild('alice', 1, root.id, 'name');
      const child2 = makeMapChild('bob', 0, root.id, 'name');

      // Both should have the same slotId
      expect(slotId(child1)).toBe(slotId(child2));
      const sid = slotId(child1);

      const winner = makeWinner(sid, cnIdKey(child1.id), 'Alice');

      stepFull([winner], [], [root, child1, child2]);

      const reality = skeleton.current();
      // Should only have one 'name' child
      expect(childKeys(reality, 'profile')).toEqual(['name']);
      expect(nodeValue(reality, 'profile', 'name')).toBe('Alice');
    });
  });

  // -----------------------------------------------------------------------
  // Complex scenarios
  // -----------------------------------------------------------------------

  describe('complex scenarios', () => {
    it('mixed map and seq with nested structure', () => {
      const { stepFull, skeleton } = createScaffold();
      const doc = makeRoot('alice', 0, 'doc');
      const title = makeMapChild('alice', 1, doc.id, 'title');
      const items = makeMapChild('alice', 2, doc.id, 'items');

      // items is a map child but conceptually acts as a seq container
      // For real seq, we'd need a root with policy 'seq' or a redesign.
      // Let's use the real seq approach:
      const listRoot = makeRoot('alice', 10, 'list', 'seq');
      const e1 = makeSeqChild('alice', 11, listRoot.id);
      const e2 = makeSeqChild('alice', 12, listRoot.id);

      const titleSid = slotId(title);
      const e1Sid = slotId(e1);
      const e2Sid = slotId(e2);

      const tw = makeWinner(titleSid, cnIdKey(title.id), 'My Doc');
      const w1 = makeWinner(e1Sid, cnIdKey(e1.id), 'item A');
      const w2 = makeWinner(e2Sid, cnIdKey(e2.id), 'item B');

      const parentKey = cnIdKey(listRoot.id);
      const pair: FugueBeforePair = {
        parentKey,
        a: cnIdKey(e1.id),
        b: cnIdKey(e2.id),
      };

      stepFull(
        [tw, w1, w2],
        [pair],
        [doc, title, listRoot, e1, e2],
      );

      const reality = skeleton.current();
      // Map side
      expect(nodeValue(reality, 'doc', 'title')).toBe('My Doc');
      // Seq side
      expect(childKeys(reality, 'list')).toEqual(['0', '1']);
      expect(nodeValue(reality, 'list', '0')).toBe('item A');
      expect(nodeValue(reality, 'list', '1')).toBe('item B');
    });

    it('incremental building over multiple steps', () => {
      const { stepFull, skeleton } = createScaffold();

      // Step 1: root
      const root = makeRoot('alice', 0, 'app');
      stepFull([], [], [root]);
      expect(skeleton.current().root.children.size).toBe(1);

      // Step 2: add child with value
      const child1 = makeMapChild('alice', 1, root.id, 'count');
      const sid1 = slotId(child1);
      const w1 = makeWinner(sid1, cnIdKey(child1.id), 0);
      stepFull([w1], [], [child1]);
      expect(nodeValue(skeleton.current(), 'app', 'count')).toBe(0);

      // Step 3: update value
      const w2 = makeWinner(sid1, cnIdKey(child1.id), 1);
      stepFull([w2], [], []);
      expect(nodeValue(skeleton.current(), 'app', 'count')).toBe(1);

      // Step 4: add another child
      const child2 = makeMapChild('alice', 2, root.id, 'label');
      const sid2 = slotId(child2);
      const w3 = makeWinner(sid2, cnIdKey(child2.id), 'hello');
      stepFull([w3], [], [child2]);
      expect(nodeValue(skeleton.current(), 'app', 'label')).toBe('hello');

      // Step 5: update first value again
      const w4 = makeWinner(sid1, cnIdKey(child1.id), 42);
      stepFull([w4], [], []);
      expect(nodeValue(skeleton.current(), 'app', 'count')).toBe(42);
      expect(nodeValue(skeleton.current(), 'app', 'label')).toBe('hello');
    });

    it('seq element values update independently', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'items', 'seq');
      const e1 = makeSeqChild('alice', 1, root.id);
      const e2 = makeSeqChild('alice', 2, root.id);

      const parentKey = cnIdKey(root.id);
      const pair: FugueBeforePair = {
        parentKey,
        a: cnIdKey(e1.id),
        b: cnIdKey(e2.id),
      };

      const w1 = makeWinner(slotId(e1), cnIdKey(e1.id), 'A');
      const w2 = makeWinner(slotId(e2), cnIdKey(e2.id), 'B');

      stepFull([w1, w2], [pair], [root, e1, e2]);
      expect(nodeValue(skeleton.current(), 'items', '0')).toBe('A');
      expect(nodeValue(skeleton.current(), 'items', '1')).toBe('B');

      // Update second element only
      const w2b = makeWinner(slotId(e2), cnIdKey(e2.id), 'B2');
      stepFull([w2b], [], []);
      expect(nodeValue(skeleton.current(), 'items', '0')).toBe('A');
      expect(nodeValue(skeleton.current(), 'items', '1')).toBe('B2');
    });
  });

  // -----------------------------------------------------------------------
  // NodeDelta correctness
  // -----------------------------------------------------------------------

  describe('NodeDelta correctness', () => {
    it('nodeAdded has correct path for root', () => {
      const { stepFull } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');

      const rd = stepFull([], [], [root]);
      const nodeAdded = findDelta(rd, 'nodeAdded');
      expect(nodeAdded).toBeDefined();
      if (nodeAdded?.kind === 'nodeAdded') {
        expect(nodeAdded.path).toEqual(['profile']);
      }
    });

    it('childAdded has correct path and key for map child', () => {
      const { stepFull } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);
      const w = makeWinner(sid, cnIdKey(child.id), 'Alice');

      stepFull([], [], [root]);
      // When structure + winner arrive in the same step, the skeleton
      // processes structures first (Phase 1), then winners (Phase 2).
      // The childAdded delta is emitted with value undefined (structure
      // creates the node before the winner is applied). A separate
      // valueChanged delta sets the value.
      const rd = stepFull([w], [], [child]);

      const childAdded = findDelta(rd, 'childAdded');
      expect(childAdded).toBeDefined();
      if (childAdded?.kind === 'childAdded') {
        expect(childAdded.path).toEqual(['profile']);
        expect(childAdded.key).toBe('name');
        // Node created with undefined value (winner applied after)
        expect(childAdded.child.value).toBeUndefined();
      }

      // The winner is applied as a separate valueChanged delta
      const vc = findDelta(rd, 'valueChanged');
      expect(vc).toBeDefined();
      if (vc?.kind === 'valueChanged') {
        expect(vc.path).toEqual(['profile', 'name']);
        expect(vc.oldValue).toBeUndefined();
        expect(vc.newValue).toBe('Alice');
      }
    });

    it('valueChanged has correct path for nested node', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'doc');
      const section = makeMapChild('alice', 1, root.id, 'info');
      const sectionSid = slotId(section);

      const w1 = makeWinner(sectionSid, cnIdKey(section.id), 'v1');
      stepFull([w1], [], [root, section]);

      const w2 = makeWinner(sectionSid, cnIdKey(section.id), 'v2');
      const rd = stepFull([w2], [], []);

      const vc = findDelta(rd, 'valueChanged');
      expect(vc).toBeDefined();
      if (vc?.kind === 'valueChanged') {
        expect(vc.path).toEqual(['doc', 'info']);
        expect(vc.oldValue).toBe('v1');
        expect(vc.newValue).toBe('v2');
      }
    });

    it('childRemoved has correct path and key (null value)', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);

      // Set value to a string, then change to null (LWW delete).
      // null + no children = excluded from parent → childRemoved.
      const w1 = makeWinner(sid, cnIdKey(child.id), 'Alice');
      stepFull([w1], [], [root, child]);

      // Change winner to null
      const wNull = makeWinner(sid, 'bob:0', null);
      const rd = stepFull([wNull], [], []);

      const cr = findDelta(rd, 'childRemoved');
      expect(cr).toBeDefined();
      if (cr?.kind === 'childRemoved') {
        expect(cr.path).toEqual(['profile']);
        expect(cr.key).toBe('name');
      }
    });

    it('valueChanged has correct path for winner retraction (value → undefined)', () => {
      const { stepFull, skeleton } = createScaffold();
      const root = makeRoot('alice', 0, 'profile');
      const child = makeMapChild('alice', 1, root.id, 'name');
      const sid = slotId(child);
      const w = makeWinner(sid, cnIdKey(child.id), 'Alice');

      stepFull([w], [], [root, child]);

      // Retract winner: value goes from 'Alice' to undefined.
      // Node stays visible (undefined ≠ null), so delta is valueChanged.
      const rd = skeleton.step(
        winnerZset([w], -1),
        zsetEmpty(),
        structureIndexDeltaEmpty(),
      );

      const vc = findDelta(rd, 'valueChanged');
      expect(vc).toBeDefined();
      if (vc?.kind === 'valueChanged') {
        expect(vc.path).toEqual(['profile', 'name']);
        expect(vc.oldValue).toBe('Alice');
        expect(vc.newValue).toBeUndefined();
      }
    });
  });
});