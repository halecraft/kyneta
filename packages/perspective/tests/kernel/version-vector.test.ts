// === Version Vector Tests ===
// Tests for version vector operations: extend, merge, compare,
// S_V filtering, and delta computation.

import { describe, it, expect } from 'vitest';
import {
  createVersionVector,
  vvFromObject,
  vvClone,
  vvGet,
  vvHasSeen,
  vvHasSeenCnId,
  vvExtend,
  vvExtendCnId,
  vvCompare,
  vvIncludes,
  vvEquals,
  vvMerge,
  vvMergeInto,
  filterByVersion,
  vvDiff,
  vvToObject,
  vvToString,
  vvPeers,
  vvIsEmpty,
  vvTotalOps,
} from '../../src/kernel/version-vector.js';
import { createCnId } from '../../src/kernel/cnid.js';
import type { Constraint, StructureConstraint } from '../../src/kernel/types.js';
import { STUB_SIGNATURE } from '../../src/kernel/signature.js';

// Helper: create a minimal constraint for filterByVersion tests
function makeConstraint(peer: string, counter: number, lamport: number = 1): Constraint {
  return {
    id: createCnId(peer, counter),
    lamport,
    refs: [],
    sig: STUB_SIGNATURE,
    type: 'structure',
    payload: { kind: 'root', containerId: 'test', policy: 'map' },
  } as StructureConstraint;
}

describe('Version Vector', () => {
  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  describe('createVersionVector', () => {
    it('creates an empty version vector', () => {
      const vv = createVersionVector();
      expect(vv.size).toBe(0);
    });
  });

  describe('vvFromObject', () => {
    it('creates a version vector from a plain object', () => {
      const vv = vvFromObject({ alice: 3, bob: 5 });
      expect(vv.get('alice')).toBe(3);
      expect(vv.get('bob')).toBe(5);
      expect(vv.size).toBe(2);
    });

    it('creates an empty version vector from empty object', () => {
      const vv = vvFromObject({});
      expect(vv.size).toBe(0);
    });
  });

  describe('vvClone', () => {
    it('creates a shallow copy', () => {
      const original = vvFromObject({ alice: 3, bob: 5 });
      const clone = vvClone(original);
      expect(vvEquals(original, clone)).toBe(true);
    });

    it('clone is independent of original', () => {
      const original = vvFromObject({ alice: 3 });
      const clone = vvClone(original);
      clone.set('alice', 10);
      expect(original.get('alice')).toBe(3);
      expect(clone.get('alice')).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // Access
  // -------------------------------------------------------------------------

  describe('vvGet', () => {
    it('returns the counter for a known peer', () => {
      const vv = vvFromObject({ alice: 3 });
      expect(vvGet(vv, 'alice')).toBe(3);
    });

    it('returns 0 for an unknown peer', () => {
      const vv = vvFromObject({ alice: 3 });
      expect(vvGet(vv, 'bob')).toBe(0);
    });

    it('returns 0 for empty version vector', () => {
      const vv = createVersionVector();
      expect(vvGet(vv, 'alice')).toBe(0);
    });
  });

  describe('vvHasSeen', () => {
    it('returns true if counter < vv[peer]', () => {
      const vv = vvFromObject({ alice: 5 });
      expect(vvHasSeen(vv, 'alice', 0)).toBe(true);
      expect(vvHasSeen(vv, 'alice', 4)).toBe(true);
    });

    it('returns false if counter >= vv[peer]', () => {
      const vv = vvFromObject({ alice: 5 });
      expect(vvHasSeen(vv, 'alice', 5)).toBe(false);
      expect(vvHasSeen(vv, 'alice', 6)).toBe(false);
    });

    it('returns false for unknown peer', () => {
      const vv = vvFromObject({ alice: 5 });
      expect(vvHasSeen(vv, 'bob', 0)).toBe(false);
    });
  });

  describe('vvHasSeenCnId', () => {
    it('returns true for a seen CnId', () => {
      const vv = vvFromObject({ alice: 5 });
      expect(vvHasSeenCnId(vv, createCnId('alice', 3))).toBe(true);
    });

    it('returns false for an unseen CnId', () => {
      const vv = vvFromObject({ alice: 5 });
      expect(vvHasSeenCnId(vv, createCnId('alice', 5))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Extend
  // -------------------------------------------------------------------------

  describe('vvExtend', () => {
    it('sets vv[peer] = counter + 1 when extending', () => {
      const vv = createVersionVector();
      vvExtend(vv, 'alice', 0);
      expect(vvGet(vv, 'alice')).toBe(1);
    });

    it('updates to max(current, counter + 1)', () => {
      const vv = vvFromObject({ alice: 3 });
      vvExtend(vv, 'alice', 5);
      expect(vvGet(vv, 'alice')).toBe(6); // max(3, 5+1)
    });

    it('does not decrease the counter', () => {
      const vv = vvFromObject({ alice: 10 });
      vvExtend(vv, 'alice', 2);
      expect(vvGet(vv, 'alice')).toBe(10); // max(10, 2+1) = 10
    });

    it('adds new peers', () => {
      const vv = vvFromObject({ alice: 3 });
      vvExtend(vv, 'bob', 0);
      expect(vvGet(vv, 'bob')).toBe(1);
      expect(vvGet(vv, 'alice')).toBe(3);
    });
  });

  describe('vvExtendCnId', () => {
    it('extends using a CnId', () => {
      const vv = createVersionVector();
      vvExtendCnId(vv, createCnId('alice', 3));
      expect(vvGet(vv, 'alice')).toBe(4); // 3 + 1
    });
  });

  // -------------------------------------------------------------------------
  // Comparison
  // -------------------------------------------------------------------------

  describe('vvCompare', () => {
    it('returns "equal" for identical version vectors', () => {
      const a = vvFromObject({ alice: 3, bob: 5 });
      const b = vvFromObject({ alice: 3, bob: 5 });
      expect(vvCompare(a, b)).toBe('equal');
    });

    it('returns "equal" for two empty version vectors', () => {
      expect(vvCompare(createVersionVector(), createVersionVector())).toBe('equal');
    });

    it('returns "less" when a < b', () => {
      const a = vvFromObject({ alice: 3 });
      const b = vvFromObject({ alice: 5 });
      expect(vvCompare(a, b)).toBe('less');
    });

    it('returns "less" when b has extra peers', () => {
      const a = vvFromObject({ alice: 3 });
      const b = vvFromObject({ alice: 3, bob: 1 });
      expect(vvCompare(a, b)).toBe('less');
    });

    it('returns "greater" when a > b', () => {
      const a = vvFromObject({ alice: 5 });
      const b = vvFromObject({ alice: 3 });
      expect(vvCompare(a, b)).toBe('greater');
    });

    it('returns "greater" when a has extra peers', () => {
      const a = vvFromObject({ alice: 3, bob: 1 });
      const b = vvFromObject({ alice: 3 });
      expect(vvCompare(a, b)).toBe('greater');
    });

    it('returns "concurrent" when neither is ancestor', () => {
      const a = vvFromObject({ alice: 5, bob: 1 });
      const b = vvFromObject({ alice: 1, bob: 5 });
      expect(vvCompare(a, b)).toBe('concurrent');
    });

    it('returns "concurrent" for disjoint peers', () => {
      const a = vvFromObject({ alice: 3 });
      const b = vvFromObject({ bob: 3 });
      expect(vvCompare(a, b)).toBe('concurrent');
    });

    it('empty vs non-empty is "less"', () => {
      const a = createVersionVector();
      const b = vvFromObject({ alice: 1 });
      expect(vvCompare(a, b)).toBe('less');
    });

    it('non-empty vs empty is "greater"', () => {
      const a = vvFromObject({ alice: 1 });
      const b = createVersionVector();
      expect(vvCompare(a, b)).toBe('greater');
    });
  });

  describe('vvIncludes', () => {
    it('returns true when a >= b', () => {
      const a = vvFromObject({ alice: 5, bob: 3 });
      const b = vvFromObject({ alice: 3, bob: 3 });
      expect(vvIncludes(a, b)).toBe(true);
    });

    it('returns true when a === b', () => {
      const a = vvFromObject({ alice: 3, bob: 3 });
      const b = vvFromObject({ alice: 3, bob: 3 });
      expect(vvIncludes(a, b)).toBe(true);
    });

    it('returns false when a < b for any peer', () => {
      const a = vvFromObject({ alice: 3, bob: 1 });
      const b = vvFromObject({ alice: 3, bob: 3 });
      expect(vvIncludes(a, b)).toBe(false);
    });

    it('returns false when b has a peer not in a', () => {
      const a = vvFromObject({ alice: 3 });
      const b = vvFromObject({ alice: 3, bob: 1 });
      expect(vvIncludes(a, b)).toBe(false);
    });

    it('empty includes empty', () => {
      expect(vvIncludes(createVersionVector(), createVersionVector())).toBe(true);
    });

    it('any vv includes empty', () => {
      const a = vvFromObject({ alice: 3 });
      expect(vvIncludes(a, createVersionVector())).toBe(true);
    });
  });

  describe('vvEquals', () => {
    it('returns true for identical version vectors', () => {
      const a = vvFromObject({ alice: 3, bob: 5 });
      const b = vvFromObject({ alice: 3, bob: 5 });
      expect(vvEquals(a, b)).toBe(true);
    });

    it('returns false for different sizes', () => {
      const a = vvFromObject({ alice: 3 });
      const b = vvFromObject({ alice: 3, bob: 5 });
      expect(vvEquals(a, b)).toBe(false);
    });

    it('returns false for different values', () => {
      const a = vvFromObject({ alice: 3 });
      const b = vvFromObject({ alice: 5 });
      expect(vvEquals(a, b)).toBe(false);
    });

    it('returns true for two empty version vectors', () => {
      expect(vvEquals(createVersionVector(), createVersionVector())).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Merge
  // -------------------------------------------------------------------------

  describe('vvMerge', () => {
    it('takes the max counter for each peer', () => {
      const a = vvFromObject({ alice: 3, bob: 5 });
      const b = vvFromObject({ alice: 7, bob: 2 });
      const merged = vvMerge(a, b);
      expect(merged.get('alice')).toBe(7);
      expect(merged.get('bob')).toBe(5);
    });

    it('includes peers from both', () => {
      const a = vvFromObject({ alice: 3 });
      const b = vvFromObject({ bob: 5 });
      const merged = vvMerge(a, b);
      expect(merged.get('alice')).toBe(3);
      expect(merged.get('bob')).toBe(5);
    });

    it('is commutative: merge(a, b) === merge(b, a)', () => {
      const a = vvFromObject({ alice: 3, bob: 5 });
      const b = vvFromObject({ alice: 7, charlie: 2 });
      const ab = vvMerge(a, b);
      const ba = vvMerge(b, a);
      expect(vvEquals(ab, ba)).toBe(true);
    });

    it('is associative: merge(merge(a, b), c) === merge(a, merge(b, c))', () => {
      const a = vvFromObject({ alice: 3 });
      const b = vvFromObject({ bob: 5 });
      const c = vvFromObject({ alice: 7, charlie: 2 });
      const ab_c = vvMerge(vvMerge(a, b), c);
      const a_bc = vvMerge(a, vvMerge(b, c));
      expect(vvEquals(ab_c, a_bc)).toBe(true);
    });

    it('is idempotent: merge(a, a) === a', () => {
      const a = vvFromObject({ alice: 3, bob: 5 });
      const merged = vvMerge(a, a);
      expect(vvEquals(a, merged)).toBe(true);
    });

    it('does not mutate inputs', () => {
      const a = vvFromObject({ alice: 3 });
      const b = vvFromObject({ bob: 5 });
      vvMerge(a, b);
      expect(a.get('alice')).toBe(3);
      expect(a.has('bob')).toBe(false);
      expect(b.get('bob')).toBe(5);
      expect(b.has('alice')).toBe(false);
    });

    it('merge with empty returns a copy', () => {
      const a = vvFromObject({ alice: 3 });
      const merged = vvMerge(a, createVersionVector());
      expect(vvEquals(a, merged)).toBe(true);
    });
  });

  describe('vvMergeInto', () => {
    it('mutates a to include max from b', () => {
      const a = vvFromObject({ alice: 3, bob: 5 });
      const b = vvFromObject({ alice: 7, charlie: 2 });
      vvMergeInto(a, b);
      expect(a.get('alice')).toBe(7);
      expect(a.get('bob')).toBe(5);
      expect(a.get('charlie')).toBe(2);
    });

    it('does not decrease existing counters', () => {
      const a = vvFromObject({ alice: 10 });
      const b = vvFromObject({ alice: 3 });
      vvMergeInto(a, b);
      expect(a.get('alice')).toBe(10);
    });
  });

  // -------------------------------------------------------------------------
  // S_V Filtering (version-parameterized solving)
  // -------------------------------------------------------------------------

  describe('filterByVersion', () => {
    it('returns constraints visible at the given version', () => {
      const constraints = [
        makeConstraint('alice', 0),
        makeConstraint('alice', 1),
        makeConstraint('alice', 2),
        makeConstraint('bob', 0),
        makeConstraint('bob', 1),
      ];

      const version = vvFromObject({ alice: 2, bob: 1 });
      const filtered = filterByVersion(constraints, version);

      expect(filtered).toHaveLength(3);
      expect(filtered[0]!.id.counter).toBe(0); // alice@0
      expect(filtered[1]!.id.counter).toBe(1); // alice@1
      expect(filtered[2]!.id.counter).toBe(0); // bob@0
    });

    it('returns empty for empty version vector', () => {
      const constraints = [
        makeConstraint('alice', 0),
        makeConstraint('bob', 0),
      ];
      const filtered = filterByVersion(constraints, createVersionVector());
      expect(filtered).toHaveLength(0);
    });

    it('returns all constraints when version includes everything', () => {
      const constraints = [
        makeConstraint('alice', 0),
        makeConstraint('alice', 1),
        makeConstraint('bob', 0),
      ];
      const version = vvFromObject({ alice: 10, bob: 10 });
      const filtered = filterByVersion(constraints, version);
      expect(filtered).toHaveLength(3);
    });

    it('handles peers not in version vector', () => {
      const constraints = [
        makeConstraint('alice', 0),
        makeConstraint('bob', 0), // bob not in version
      ];
      const version = vvFromObject({ alice: 1 });
      const filtered = filterByVersion(constraints, version);
      expect(filtered).toHaveLength(1);
      expect(filtered[0]!.id.peer).toBe('alice');
    });

    it('handles empty constraint set', () => {
      const version = vvFromObject({ alice: 5 });
      const filtered = filterByVersion([], version);
      expect(filtered).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Delta computation
  // -------------------------------------------------------------------------

  describe('vvDiff', () => {
    it('returns ranges of operations we have but they do not', () => {
      const current = vvFromObject({ alice: 5, bob: 3 });
      const other = vvFromObject({ alice: 2, bob: 3 });

      const diff = vvDiff(current, other);
      expect(diff.size).toBe(1);
      expect(diff.get('alice')).toEqual({ start: 2, end: 5 });
    });

    it('returns empty when current <= other', () => {
      const current = vvFromObject({ alice: 3 });
      const other = vvFromObject({ alice: 5 });
      const diff = vvDiff(current, other);
      expect(diff.size).toBe(0);
    });

    it('handles peers only in current', () => {
      const current = vvFromObject({ alice: 3, bob: 2 });
      const other = vvFromObject({ alice: 3 });
      const diff = vvDiff(current, other);
      expect(diff.size).toBe(1);
      expect(diff.get('bob')).toEqual({ start: 0, end: 2 });
    });

    it('handles empty other', () => {
      const current = vvFromObject({ alice: 3, bob: 2 });
      const other = createVersionVector();
      const diff = vvDiff(current, other);
      expect(diff.size).toBe(2);
      expect(diff.get('alice')).toEqual({ start: 0, end: 3 });
      expect(diff.get('bob')).toEqual({ start: 0, end: 2 });
    });

    it('handles empty current', () => {
      const current = createVersionVector();
      const other = vvFromObject({ alice: 3 });
      const diff = vvDiff(current, other);
      expect(diff.size).toBe(0);
    });

    it('handles equal version vectors', () => {
      const a = vvFromObject({ alice: 3, bob: 5 });
      const b = vvFromObject({ alice: 3, bob: 5 });
      const diff = vvDiff(a, b);
      expect(diff.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Serialization
  // -------------------------------------------------------------------------

  describe('vvToObject', () => {
    it('converts to plain object', () => {
      const vv = vvFromObject({ alice: 3, bob: 5 });
      const obj = vvToObject(vv);
      expect(obj).toEqual({ alice: 3, bob: 5 });
    });

    it('handles empty version vector', () => {
      const obj = vvToObject(createVersionVector());
      expect(obj).toEqual({});
    });
  });

  describe('vvToString', () => {
    it('formats as sorted {peer:counter, ...}', () => {
      const vv = vvFromObject({ bob: 5, alice: 3 });
      expect(vvToString(vv)).toBe('{alice:3, bob:5}');
    });

    it('handles empty version vector', () => {
      expect(vvToString(createVersionVector())).toBe('{}');
    });

    it('handles single peer', () => {
      const vv = vvFromObject({ alice: 1 });
      expect(vvToString(vv)).toBe('{alice:1}');
    });
  });

  // -------------------------------------------------------------------------
  // Utility
  // -------------------------------------------------------------------------

  describe('vvPeers', () => {
    it('returns all peer IDs', () => {
      const vv = vvFromObject({ alice: 3, bob: 5, charlie: 1 });
      const peers = vvPeers(vv).sort();
      expect(peers).toEqual(['alice', 'bob', 'charlie']);
    });

    it('returns empty array for empty version vector', () => {
      expect(vvPeers(createVersionVector())).toEqual([]);
    });
  });

  describe('vvIsEmpty', () => {
    it('returns true for empty version vector', () => {
      expect(vvIsEmpty(createVersionVector())).toBe(true);
    });

    it('returns false for non-empty version vector', () => {
      expect(vvIsEmpty(vvFromObject({ alice: 1 }))).toBe(false);
    });
  });

  describe('vvTotalOps', () => {
    it('returns sum of all counters', () => {
      const vv = vvFromObject({ alice: 3, bob: 5, charlie: 2 });
      expect(vvTotalOps(vv)).toBe(10);
    });

    it('returns 0 for empty version vector', () => {
      expect(vvTotalOps(createVersionVector())).toBe(0);
    });
  });
});