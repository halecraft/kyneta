// === Incremental Pipeline Types Tests ===
// Tests for NodeDelta, RealityDelta types and constructors.

import { describe, it, expect } from 'vitest';
import type { NodeDelta, NodeDeltaKind, RealityDelta } from '../../../src/kernel/incremental/types.js';
import { realityDeltaEmpty, realityDeltaFrom } from '../../../src/kernel/incremental/types.js';
import type { RealityNode } from '../../../src/kernel/types.js';
import { createCnId } from '../../../src/kernel/cnid.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a minimal RealityNode for testing. */
function testNode(peer: string, counter: number): RealityNode {
  return {
    id: createCnId(peer, counter),
    policy: 'map',
    children: new Map(),
    value: undefined,
  };
}

// ===========================================================================
// RealityDelta construction
// ===========================================================================

describe('RealityDelta', () => {
  describe('realityDeltaEmpty', () => {
    it('creates a delta with isEmpty: true', () => {
      const delta = realityDeltaEmpty();
      expect(delta.isEmpty).toBe(true);
      expect(delta.changes).toEqual([]);
      expect(delta.changes.length).toBe(0);
    });

    it('returns the same instance on repeated calls (shared singleton)', () => {
      const a = realityDeltaEmpty();
      const b = realityDeltaEmpty();
      expect(a).toBe(b);
    });
  });

  describe('realityDeltaFrom', () => {
    it('creates a non-empty delta from changes', () => {
      const node = testNode('alice', 0);
      const changes: NodeDelta[] = [
        { kind: 'nodeAdded', path: ['doc'], node },
      ];
      const delta = realityDeltaFrom(changes);
      expect(delta.isEmpty).toBe(false);
      expect(delta.changes.length).toBe(1);
      expect(delta.changes[0]!.kind).toBe('nodeAdded');
    });

    it('returns empty delta when given empty array', () => {
      const delta = realityDeltaFrom([]);
      expect(delta.isEmpty).toBe(true);
      expect(delta).toBe(realityDeltaEmpty());
    });

    it('preserves multiple changes in order', () => {
      const node = testNode('alice', 1);
      const changes: NodeDelta[] = [
        { kind: 'childAdded', path: ['doc'], key: 'title', child: node },
        { kind: 'valueChanged', path: ['doc', 'title'], oldValue: undefined, newValue: 'hello' },
      ];
      const delta = realityDeltaFrom(changes);
      expect(delta.changes.length).toBe(2);
      expect(delta.changes[0]!.kind).toBe('childAdded');
      expect(delta.changes[1]!.kind).toBe('valueChanged');
    });
  });
});

// ===========================================================================
// NodeDelta discriminated union exhaustiveness
// ===========================================================================

describe('NodeDelta', () => {
  it('covers all six delta kinds', () => {
    // This test verifies that the discriminated union is exhaustive
    // by constructing one of each kind and switching over them.
    const node = testNode('alice', 0);

    const deltas: NodeDelta[] = [
      { kind: 'nodeAdded', path: ['a'], node },
      { kind: 'nodeRemoved', path: ['a'] },
      { kind: 'valueChanged', path: ['a'], oldValue: 'old', newValue: 'new' },
      { kind: 'childAdded', path: ['a'], key: 'b', child: node },
      { kind: 'childRemoved', path: ['a'], key: 'b' },
      { kind: 'childrenReordered', path: ['a'], keys: ['x', 'y', 'z'] },
    ];

    const allKinds: NodeDeltaKind[] = [
      'nodeAdded',
      'nodeRemoved',
      'valueChanged',
      'childAdded',
      'childRemoved',
      'childrenReordered',
    ];

    // Every kind is represented
    const seenKinds = new Set(deltas.map((d) => d.kind));
    for (const kind of allKinds) {
      expect(seenKinds.has(kind)).toBe(true);
    }
    expect(seenKinds.size).toBe(allKinds.length);
  });

  it('exhaustive switch compiles and handles all variants', () => {
    const node = testNode('bob', 5);
    const deltas: NodeDelta[] = [
      { kind: 'nodeAdded', path: ['x'], node },
      { kind: 'nodeRemoved', path: ['x'] },
      { kind: 'valueChanged', path: ['x'], oldValue: undefined, newValue: 42 },
      { kind: 'childAdded', path: ['x'], key: 'c', child: node },
      { kind: 'childRemoved', path: ['x'], key: 'c' },
      { kind: 'childrenReordered', path: ['x'], keys: ['1', '2'] },
    ];

    // Process each delta through an exhaustive switch
    function describeDelta(d: NodeDelta): string {
      switch (d.kind) {
        case 'nodeAdded':
          return `added node at ${d.path.join('/')}`;
        case 'nodeRemoved':
          return `removed node at ${d.path.join('/')}`;
        case 'valueChanged':
          return `value changed at ${d.path.join('/')}: ${d.oldValue} → ${d.newValue}`;
        case 'childAdded':
          return `child '${d.key}' added at ${d.path.join('/')}`;
        case 'childRemoved':
          return `child '${d.key}' removed at ${d.path.join('/')}`;
        case 'childrenReordered':
          return `children reordered at ${d.path.join('/')}: ${d.keys.join(',')}`;
      }
    }

    const descriptions = deltas.map(describeDelta);
    expect(descriptions.length).toBe(6);
    // Each description should be a non-empty string
    for (const desc of descriptions) {
      expect(desc.length).toBeGreaterThan(0);
    }
  });

  describe('nodeAdded', () => {
    it('carries the full RealityNode', () => {
      const node = testNode('alice', 3);
      const delta: NodeDelta = { kind: 'nodeAdded', path: ['doc', 'profile'], node };
      expect(delta.kind).toBe('nodeAdded');
      if (delta.kind === 'nodeAdded') {
        expect(delta.node).toBe(node);
        expect(delta.path).toEqual(['doc', 'profile']);
      }
    });
  });

  describe('nodeRemoved', () => {
    it('has only a path', () => {
      const delta: NodeDelta = { kind: 'nodeRemoved', path: ['doc', 'old'] };
      expect(delta.kind).toBe('nodeRemoved');
      if (delta.kind === 'nodeRemoved') {
        expect(delta.path).toEqual(['doc', 'old']);
      }
    });
  });

  describe('valueChanged', () => {
    it('carries old and new values', () => {
      const delta: NodeDelta = {
        kind: 'valueChanged',
        path: ['doc', 'title'],
        oldValue: 'hello',
        newValue: 'world',
      };
      if (delta.kind === 'valueChanged') {
        expect(delta.oldValue).toBe('hello');
        expect(delta.newValue).toBe('world');
      }
    });

    it('supports undefined values (initial set / deletion)', () => {
      const setDelta: NodeDelta = {
        kind: 'valueChanged',
        path: ['x'],
        oldValue: undefined,
        newValue: 'first',
      };
      if (setDelta.kind === 'valueChanged') {
        expect(setDelta.oldValue).toBeUndefined();
        expect(setDelta.newValue).toBe('first');
      }

      const deleteDelta: NodeDelta = {
        kind: 'valueChanged',
        path: ['x'],
        oldValue: 'last',
        newValue: undefined,
      };
      if (deleteDelta.kind === 'valueChanged') {
        expect(deleteDelta.oldValue).toBe('last');
        expect(deleteDelta.newValue).toBeUndefined();
      }
    });

    it('supports null values (map deletion via LWW)', () => {
      const delta: NodeDelta = {
        kind: 'valueChanged',
        path: ['x'],
        oldValue: 'something',
        newValue: null,
      };
      if (delta.kind === 'valueChanged') {
        expect(delta.newValue).toBeNull();
      }
    });
  });

  describe('childAdded', () => {
    it('carries key and child node', () => {
      const child = testNode('bob', 7);
      const delta: NodeDelta = {
        kind: 'childAdded',
        path: ['doc'],
        key: 'settings',
        child,
      };
      if (delta.kind === 'childAdded') {
        expect(delta.key).toBe('settings');
        expect(delta.child).toBe(child);
      }
    });
  });

  describe('childRemoved', () => {
    it('carries key of removed child', () => {
      const delta: NodeDelta = {
        kind: 'childRemoved',
        path: ['doc'],
        key: 'deprecated',
      };
      if (delta.kind === 'childRemoved') {
        expect(delta.key).toBe('deprecated');
      }
    });
  });

  describe('childrenReordered', () => {
    it('carries the new key order', () => {
      const delta: NodeDelta = {
        kind: 'childrenReordered',
        path: ['list'],
        keys: ['0', '1', '2'],
      };
      if (delta.kind === 'childrenReordered') {
        expect(delta.keys).toEqual(['0', '1', '2']);
      }
    });

    it('supports empty key list (all children removed)', () => {
      const delta: NodeDelta = {
        kind: 'childrenReordered',
        path: ['list'],
        keys: [],
      };
      if (delta.kind === 'childrenReordered') {
        expect(delta.keys).toEqual([]);
      }
    });
  });
});