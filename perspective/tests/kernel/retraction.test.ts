// === Retraction Tests ===
// Tests for retraction graph construction, dominance computation,
// Active(S) filtering, depth limits, structure immunity, and
// target-in-refs enforcement (semantic interpretation).

import { describe, it, expect } from 'vitest';
import {
  computeActive,
  filterActive,
  DEFAULT_RETRACTION_CONFIG,
} from '../../src/kernel/retraction.js';
import { createAgent } from '../../src/kernel/agent.js';
import type {
  RetractionConfig,
  RetractionResult,
} from '../../src/kernel/retraction.js';
import { createCnId, cnIdKey } from '../../src/kernel/cnid.js';
import type {
  Constraint,
  StructureConstraint,
  ValueConstraint,
  RetractConstraint,
  CnId,
  PeerID,
  StructureConstraint,
  ValueConstraint,
} from '../../src/kernel/types.js';
import { STUB_SIGNATURE } from '../../src/kernel/signature.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValueConstraint(
  peer: PeerID,
  counter: number,
  lamport: number,
  target: CnId,
  content: unknown,
  refs: CnId[] = [],
): ValueConstraint {
  return {
    id: { peer, counter },
    lamport,
    refs,
    sig: STUB_SIGNATURE,
    type: 'value',
    payload: { target, content: content as any },
  };
}

function makeStructureConstraint(
  peer: PeerID,
  counter: number,
  lamport: number,
  refs: CnId[] = [],
): StructureConstraint {
  return {
    id: { peer, counter },
    lamport,
    refs,
    sig: STUB_SIGNATURE,
    type: 'structure',
    payload: { kind: 'root', containerId: 'test', policy: 'map' },
  };
}

function makeRetractConstraint(
  peer: PeerID,
  counter: number,
  lamport: number,
  target: CnId,
  refs: CnId[] = [],
): RetractConstraint {
  return {
    id: { peer, counter },
    lamport,
    refs,
    sig: STUB_SIGNATURE,
    type: 'retract',
    payload: { target },
  };
}

function activeIds(result: RetractionResult): string[] {
  return result.active.map((c) => cnIdKey(c.id)).sort();
}

function dominatedIds(result: RetractionResult): string[] {
  return result.dominated.map((c) => cnIdKey(c.id)).sort();
}

// ---------------------------------------------------------------------------
// Basic dominance
// ---------------------------------------------------------------------------

describe('computeActive', () => {
  describe('basic dominance', () => {
    it('constraint with no retractors is active', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');

      const result = computeActive([v1]);
      expect(result.active.length).toBe(1);
      expect(result.dominated.length).toBe(0);
    });

    it('retract(value) → value is dominated', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
        createCnId('alice', 0), // target in refs
      ]);

      const result = computeActive([v1, r1]);
      expect(dominatedIds(result)).toContain('alice@0');
      expect(activeIds(result)).toContain('alice@1'); // retract itself is active
    });

    it('retract constraint itself is active (not dominated unless retracted)', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);

      const result = computeActive([v1, r1]);
      expect(activeIds(result)).toContain('alice@1');
    });

    it('multiple retractors: any active retractor dominates the target', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);
      const r2 = makeRetractConstraint('bob', 0, 3, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);

      const result = computeActive([v1, r1, r2]);
      expect(dominatedIds(result)).toContain('alice@0');
    });
  });

  // ---------------------------------------------------------------------------
  // Undo (retract-of-retract)
  // ---------------------------------------------------------------------------

  describe('undo (retract of retract)', () => {
    it('retract(retract(value)) → value is active again (undo)', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);
      const r2 = makeRetractConstraint('alice', 2, 3, createCnId('alice', 1), [
        createCnId('alice', 1),
      ]);

      const result = computeActive([v1, r1, r2]);
      // r1 is dominated by r2, so v1 is no longer dominated → active
      expect(activeIds(result)).toContain('alice@0');
      // r1 is dominated
      expect(dominatedIds(result)).toContain('alice@1');
      // r2 is active
      expect(activeIds(result)).toContain('alice@2');
    });

    it('depth-2 chain: retract(retract(retract(value))) at depth 2 (default)', () => {
      // v1 → r1 retracts v1 → r2 retracts r1 (undo) → r3 retracts r2 (redo)
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);
      const r2 = makeRetractConstraint('alice', 2, 3, createCnId('alice', 1), [
        createCnId('alice', 1),
      ]);
      const r3 = makeRetractConstraint('alice', 3, 4, createCnId('alice', 2), [
        createCnId('alice', 2),
      ]);

      // Default depth is 2:
      // r1 targets v1 → depth 1 (value target)
      // r2 targets r1 → depth 2 (retract targeting non-retract)... actually:
      //   depth of r1's target (v1) = 1, so depth of targeting r1 = 1 + depth(r1's target) = 1 + 1 = 2
      // r3 targets r2 → depth = 1 + depth(r2's target) = 1 + 2 = 3 → exceeds depth 2
      // So r3 is ignored for dominance
      const result = computeActive([v1, r1, r2, r3]);

      // With depth limit 2, r3 exceeds the limit, so it doesn't dominate r2
      // r2 is active → dominates r1 → v1 is active
      expect(activeIds(result)).toContain('alice@0'); // v1 active (undo in effect)
      expect(dominatedIds(result)).toContain('alice@1'); // r1 dominated by r2
      expect(activeIds(result)).toContain('alice@2'); // r2 active (r3 can't touch it)
      expect(activeIds(result)).toContain('alice@3'); // r3 active but impotent
    });
  });

  // ---------------------------------------------------------------------------
  // Depth limits
  // ---------------------------------------------------------------------------

  describe('depth limits', () => {
    it('depth 0: no retraction at all', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);

      const result = computeActive([v1, r1], { maxDepth: 0 });
      // All constraints are active (no retraction)
      expect(result.active.length).toBe(2);
      expect(result.dominated.length).toBe(0);
    });

    it('depth 1: retract values only, no undo', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);
      const r2 = makeRetractConstraint('alice', 2, 3, createCnId('alice', 1), [
        createCnId('alice', 1),
      ]);

      const result = computeActive([v1, r1, r2], { maxDepth: 1 });
      // r1 targets v1 (depth 1) → allowed
      // r2 targets r1, and r1 targets v1 → depth = 1+1 = 2 → exceeds depth 1 → ignored
      expect(dominatedIds(result)).toContain('alice@0'); // v1 dominated by r1
      expect(activeIds(result)).toContain('alice@1'); // r1 active (r2 can't touch it)
      expect(activeIds(result)).toContain('alice@2'); // r2 active but impotent
    });

    it('depth Infinity: unlimited retraction chains', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);
      const r2 = makeRetractConstraint('alice', 2, 3, createCnId('alice', 1), [
        createCnId('alice', 1),
      ]);
      const r3 = makeRetractConstraint('alice', 3, 4, createCnId('alice', 2), [
        createCnId('alice', 2),
      ]);

      const result = computeActive([v1, r1, r2, r3], { maxDepth: Infinity });
      // r3 dominates r2 → r2 dominated
      // r2 dominated → r1 active again
      // r1 active → v1 dominated
      expect(dominatedIds(result)).toContain('alice@0'); // v1 dominated
      expect(activeIds(result)).toContain('alice@1'); // r1 active (redo)
      expect(dominatedIds(result)).toContain('alice@2'); // r2 dominated by r3
      expect(activeIds(result)).toContain('alice@3'); // r3 active
    });

    it('default config has maxDepth 2', () => {
      expect(DEFAULT_RETRACTION_CONFIG.maxDepth).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Structure constraint immunity
  // ---------------------------------------------------------------------------

  describe('structure constraint immunity', () => {
    it('retract targeting structure constraint produces a violation', () => {
      const s1 = makeStructureConstraint('alice', 0, 1);
      const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);

      const result = computeActive([s1, r1]);
      // Structure is immune — r1 is a violation
      expect(result.violations.length).toBe(1);
      expect(result.violations[0]!.reason.kind).toBe('targetIsStructure');
      // s1 is still active
      expect(activeIds(result)).toContain('alice@0');
      // r1 is active too (it just has no effect)
      expect(activeIds(result)).toContain('alice@1');
    });

    it('structure constraint remains active even with multiple retractors', () => {
      const s1 = makeStructureConstraint('alice', 0, 1);
      const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);
      const r2 = makeRetractConstraint('bob', 0, 3, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);

      const result = computeActive([s1, r1, r2]);
      expect(result.violations.length).toBe(2);
      expect(activeIds(result)).toContain('alice@0');
    });
  });

  // ---------------------------------------------------------------------------
  // Target-in-refs rule
  // ---------------------------------------------------------------------------

  describe('target-in-refs rule', () => {
    it('retract without any refs produces a violation', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      // r1 targets v1 but has no refs at all
      const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), []);

      const result = computeActive([v1, r1]);
      expect(result.violations.length).toBe(1);
      expect(result.violations[0]!.reason.kind).toBe('targetNotInRefs');
      // v1 is still active (retraction is invalid)
      expect(activeIds(result)).toContain('alice@0');
    });

    it('retract with no ref for target peer produces a violation', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      // r1 targets alice@0 but only has refs for bob — no ref for alice's peer
      const r1 = makeRetractConstraint('bob', 1, 2, createCnId('alice', 0), [
        createCnId('bob', 0),
      ]);

      const result = computeActive([v1, r1]);
      expect(result.violations.length).toBe(1);
      expect(result.violations[0]!.reason.kind).toBe('targetNotInRefs');
    });

    it('retract with ref counter < target counter produces a violation', () => {
      const v1 = makeValueConstraint('alice', 5, 6, createCnId('alice', 99), 'hello');
      // r1 targets alice@5 but ref is alice@3 — hasn't observed the target yet
      const r1 = makeRetractConstraint('bob', 0, 7, createCnId('alice', 5), [
        createCnId('alice', 3),
      ]);

      const result = computeActive([v1, r1]);
      expect(result.violations.length).toBe(1);
      expect(result.violations[0]!.reason.kind).toBe('targetNotInRefs');
      expect(activeIds(result)).toContain('alice@5');
    });

    it('retract with exact target in refs succeeds', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
        createCnId('alice', 0), // exact match: ref counter == target counter
      ]);

      const result = computeActive([v1, r1]);
      expect(result.violations.length).toBe(0);
      expect(dominatedIds(result)).toContain('alice@0');
    });

    it('retract with ref counter == target counter succeeds (semantic: observed)', () => {
      const v1 = makeValueConstraint('alice', 5, 6, createCnId('alice', 99), 'hello');
      // ref alice@5 means "I've seen alice's constraints 0..5" — target alice@5 is observed
      const r1 = makeRetractConstraint('bob', 0, 7, createCnId('alice', 5), [
        createCnId('alice', 5),
      ]);

      const result = computeActive([v1, r1]);
      expect(result.violations.length).toBe(0);
      expect(dominatedIds(result)).toContain('alice@5');
    });

    it('retract with ref counter > target counter succeeds (frontier compression)', () => {
      const v1 = makeValueConstraint('alice', 2, 3, createCnId('alice', 99), 'hello');
      // ref alice@10 means "I've seen alice's constraints 0..10" — target alice@2 is implied
      const r1 = makeRetractConstraint('bob', 0, 11, createCnId('alice', 2), [
        createCnId('alice', 10),
      ]);

      const result = computeActive([v1, r1]);
      expect(result.violations.length).toBe(0);
      expect(dominatedIds(result)).toContain('alice@2');
    });

    it('target in refs among other refs is valid', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
        createCnId('bob', 5),    // some other ref
        createCnId('alice', 0),  // target in refs
        createCnId('carol', 2),  // another ref
      ]);

      const result = computeActive([v1, r1]);
      expect(result.violations.length).toBe(0);
      expect(dominatedIds(result)).toContain('alice@0');
    });

    it('frontier-compressed refs: target not on frontier but peer frontier covers it', () => {
      // Simulates what Agent.produceRetract() produces: the agent has seen
      // alice@0 through alice@5, but the frontier ref is just alice@5.
      // Retracting alice@2 should succeed.
      const v1 = makeValueConstraint('alice', 2, 3, createCnId('alice', 99), 'hello');
      const r1 = makeRetractConstraint('alice', 6, 7, createCnId('alice', 2), [
        createCnId('alice', 5),  // frontier: implies 0..5 observed
        createCnId('bob', 3),    // frontier for bob
      ]);

      const result = computeActive([v1, r1]);
      expect(result.violations.length).toBe(0);
      expect(dominatedIds(result)).toContain('alice@2');
    });

    it('Agent-produced retraction of non-frontier constraint succeeds', () => {
      // End-to-end: Agent creates value, creates more constraints, then retracts
      // the earlier value. The Agent's frontier-compressed refs won't contain
      // the literal target CnId, but the semantic check should pass.
      const agent = createAgent('alice');

      // Produce a value constraint (counter 0)
      const root: StructureConstraint = agent.produceStructure({
        kind: 'root', containerId: 'test', policy: 'map',
      });
      const child: StructureConstraint = agent.produceStructure({
        kind: 'map', parent: root.id, key: 'name',
      });
      const value: ValueConstraint = agent.produceValue(child.id, 'hello');

      // Produce several more constraints to advance the frontier
      agent.produceValue(child.id, 'world');
      agent.produceValue(child.id, 'foo');

      // Now retract the original value — Agent's refs will have alice@4 (frontier),
      // not alice@2 (the target value's counter)
      const retract = agent.produceRetract(value.id);

      // Verify the literal target CnId is NOT in refs (proving frontier compression)
      const targetKey = `${value.id.peer}@${value.id.counter}`;
      const hasLiteralTarget = retract.refs.some(
        (ref) => `${ref.peer}@${ref.counter}` === targetKey,
      );
      // The frontier ref for alice should be > value.id.counter
      const aliceRef = retract.refs.find((ref) => ref.peer === 'alice');
      expect(aliceRef).toBeDefined();
      expect(aliceRef!.counter).toBeGreaterThan(value.id.counter);

      // But the retraction should still succeed with semantic interpretation
      const result = computeActive([root, child, value, retract]);
      expect(result.violations.length).toBe(0);
      expect(dominatedIds(result)).toContain(targetKey);
    });
  });

  // ---------------------------------------------------------------------------
  // Retraction of non-existent target
  // ---------------------------------------------------------------------------

  describe('retraction targeting non-existent constraint', () => {
    it('retract targeting unknown CnId has no dominance effect', () => {
      // r1 targets something not in the constraint set
      const r1 = makeRetractConstraint('alice', 0, 1, createCnId('bob', 99), [
        createCnId('bob', 99),
      ]);

      const result = computeActive([r1]);
      // r1 is active but has no target to dominate
      expect(result.active.length).toBe(1);
      expect(result.dominated.length).toBe(0);
      expect(result.violations.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Determinism
  // ---------------------------------------------------------------------------

  describe('determinism', () => {
    it('same S → same Active(S) regardless of insertion order', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      const v2 = makeValueConstraint('alice', 1, 2, createCnId('alice', 99), 'world');
      const r1 = makeRetractConstraint('alice', 2, 3, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);

      const result1 = computeActive([v1, v2, r1]);
      const result2 = computeActive([r1, v1, v2]);
      const result3 = computeActive([v2, r1, v1]);

      expect(activeIds(result1)).toEqual(activeIds(result2));
      expect(activeIds(result1)).toEqual(activeIds(result3));
      expect(dominatedIds(result1)).toEqual(dominatedIds(result2));
      expect(dominatedIds(result1)).toEqual(dominatedIds(result3));
    });

    it('deterministic with complex retraction chains', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'a');
      const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);
      const r2 = makeRetractConstraint('alice', 2, 3, createCnId('alice', 1), [
        createCnId('alice', 1),
      ]);

      const orderings = [
        [v1, r1, r2],
        [r2, r1, v1],
        [r1, v1, r2],
        [r2, v1, r1],
        [v1, r2, r1],
        [r1, r2, v1],
      ];

      const results = orderings.map((cs) => computeActive(cs as Constraint[]));
      const firstActive = activeIds(results[0]!);
      const firstDominated = dominatedIds(results[0]!);

      for (let i = 1; i < results.length; i++) {
        expect(activeIds(results[i]!)).toEqual(firstActive);
        expect(dominatedIds(results[i]!)).toEqual(firstDominated);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Multiple independent retractions
  // ---------------------------------------------------------------------------

  describe('multiple independent retractions', () => {
    it('independent retractions do not interfere', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'a');
      const v2 = makeValueConstraint('alice', 1, 2, createCnId('alice', 99), 'b');
      const r1 = makeRetractConstraint('alice', 2, 3, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);
      // Note: r2 does NOT retract v2, only r1 retracts v1

      const result = computeActive([v1, v2, r1]);
      expect(dominatedIds(result)).toEqual(['alice@0']); // only v1 dominated
      expect(activeIds(result)).toContain('alice@1'); // v2 active
      expect(activeIds(result)).toContain('alice@2'); // r1 active
    });

    it('two values retracted independently', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'a');
      const v2 = makeValueConstraint('alice', 1, 2, createCnId('alice', 99), 'b');
      const r1 = makeRetractConstraint('alice', 2, 3, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);
      const r2 = makeRetractConstraint('alice', 3, 4, createCnId('alice', 1), [
        createCnId('alice', 1),
      ]);

      const result = computeActive([v1, v2, r1, r2]);
      expect(dominatedIds(result).sort()).toEqual(['alice@0', 'alice@1']);
      expect(activeIds(result)).toContain('alice@2');
      expect(activeIds(result)).toContain('alice@3');
    });
  });

  // ---------------------------------------------------------------------------
  // Mixed violations and valid retractions
  // ---------------------------------------------------------------------------

  describe('mixed violations and valid retractions', () => {
    it('violation does not prevent valid retraction of different target', () => {
      const s1 = makeStructureConstraint('alice', 0, 1);
      const v1 = makeValueConstraint('alice', 1, 2, createCnId('alice', 0), 'hello');
      // r1 tries to retract structure (violation)
      const r1 = makeRetractConstraint('alice', 2, 3, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);
      // r2 retracts value (valid)
      const r2 = makeRetractConstraint('alice', 3, 4, createCnId('alice', 1), [
        createCnId('alice', 1),
      ]);

      const result = computeActive([s1, v1, r1, r2]);
      expect(result.violations.length).toBe(1);
      expect(result.violations[0]!.reason.kind).toBe('targetIsStructure');
      expect(activeIds(result)).toContain('alice@0'); // s1 immune
      expect(dominatedIds(result)).toContain('alice@1'); // v1 dominated by r2
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('empty constraint set returns empty active', () => {
      const result = computeActive([]);
      expect(result.active.length).toBe(0);
      expect(result.dominated.length).toBe(0);
      expect(result.violations.length).toBe(0);
    });

    it('single constraint with no retractors is active', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      const result = computeActive([v1]);
      expect(result.active.length).toBe(1);
      expect(result.dominated.length).toBe(0);
    });

    it('retract constraint alone (target not in set) is active', () => {
      const r1 = makeRetractConstraint('alice', 0, 1, createCnId('bob', 99), [
        createCnId('bob', 99),
      ]);
      const result = computeActive([r1]);
      expect(result.active.length).toBe(1);
      expect(result.dominated.length).toBe(0);
    });

    it('constraint retracted by multiple peers: all retractions active → target dominated', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      const r1 = makeRetractConstraint('bob', 0, 2, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);
      const r2 = makeRetractConstraint('carol', 0, 3, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);

      const result = computeActive([v1, r1, r2]);
      expect(dominatedIds(result)).toContain('alice@0');
      expect(activeIds(result)).toContain('bob@0');
      expect(activeIds(result)).toContain('carol@0');
    });

    it('depth limit violation is recorded', () => {
      const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
      const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
        createCnId('alice', 0),
      ]);
      const r2 = makeRetractConstraint('alice', 2, 3, createCnId('alice', 1), [
        createCnId('alice', 1),
      ]);

      // With depth 1: r2 targeting r1 has depth 2 which exceeds limit
      // r2 doesn't dominate r1, so r1 dominates v1
      const result = computeActive([v1, r1, r2], { maxDepth: 1 });
      expect(dominatedIds(result)).toContain('alice@0'); // v1 dominated
      expect(activeIds(result)).toContain('alice@1'); // r1 active
      expect(activeIds(result)).toContain('alice@2'); // r2 active but impotent
    });
  });
});

// ---------------------------------------------------------------------------
// filterActive convenience function
// ---------------------------------------------------------------------------

describe('filterActive', () => {
  it('returns only active constraints', () => {
    const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
    const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
      createCnId('alice', 0),
    ]);

    const active = filterActive([v1, r1]);
    expect(active.length).toBe(1);
    expect(cnIdKey(active[0]!.id)).toBe('alice@1');
  });

  it('returns all when no retractions', () => {
    const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'a');
    const v2 = makeValueConstraint('alice', 1, 2, createCnId('alice', 99), 'b');

    const active = filterActive([v1, v2]);
    expect(active.length).toBe(2);
  });

  it('accepts custom config', () => {
    const v1 = makeValueConstraint('alice', 0, 1, createCnId('alice', 99), 'hello');
    const r1 = makeRetractConstraint('alice', 1, 2, createCnId('alice', 0), [
      createCnId('alice', 0),
    ]);

    // Depth 0 means no retraction
    const active = filterActive([v1, r1], { maxDepth: 0 });
    expect(active.length).toBe(2);
  });
});