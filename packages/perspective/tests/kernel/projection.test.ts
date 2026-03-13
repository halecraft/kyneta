// === Projection Tests ===
// Tests for converting active constraints into Datalog ground facts
// via the structure index join.

import { describe, it, expect } from 'vitest';
import {
  projectToFacts,
  constraintKeyFromFact,
  ACTIVE_VALUE,
  ACTIVE_STRUCTURE_SEQ,
  CONSTRAINT_PEER,
  type ProjectionResult,
} from '../../src/kernel/projection.js';
import { buildStructureIndex } from '../../src/kernel/structure-index.js';
import { createCnId, cnIdKey } from '../../src/kernel/cnid.js';
import { STUB_SIGNATURE } from '../../src/kernel/signature.js';
import type {
  StructureConstraint,
  ValueConstraint,
  Constraint,
  CnId,
  PeerID,
  Value,
} from '../../src/kernel/types.js';
import type { Fact } from '../../src/datalog/types.js';
import { fact } from '../../src/datalog/types.js';

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
  lamport?: number,
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: lamport ?? counter,
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
  lamport?: number,
): StructureConstraint {
  return {
    id: createCnId(peer, counter),
    lamport: lamport ?? counter,
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
  content: Value,
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

/** Find facts with the given predicate name. */
function factsOf(facts: readonly Fact[], predicate: string): Fact[] {
  return facts.filter((f) => f.predicate === predicate);
}

/** Find the first fact with the given predicate that matches a value at a position. */
function findFact(
  facts: readonly Fact[],
  predicate: string,
  position: number,
  value: unknown,
): Fact | undefined {
  return facts.find(
    (f) => f.predicate === predicate && f.values[position] === value,
  );
}

// ---------------------------------------------------------------------------
// active_value projection
// ---------------------------------------------------------------------------

describe('projectToFacts', () => {
  describe('value projection', () => {
    it('projects a value constraint into an active_value fact', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child = makeStructureMap('alice', 1, root.id, 'title');
      const val = makeValue('alice', 2, child.id, 'Hello', 5);

      const all: Constraint[] = [root, child, val];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const avFacts = factsOf(result.facts, ACTIVE_VALUE.predicate);
      expect(avFacts).toHaveLength(1);

      const f = avFacts[0]!;
      // active_value(CnId, Slot, Content, Lamport, Peer)
      expect(f.values[ACTIVE_VALUE.CNID]).toBe(cnIdKey(val.id));
      expect(f.values[ACTIVE_VALUE.CONTENT]).toBe('Hello');
      expect(f.values[ACTIVE_VALUE.LAMPORT]).toBe(5);
      expect(f.values[ACTIVE_VALUE.PEER]).toBe('alice');
    });

    it('slot for map child is (parent, key), not the target CnId', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child = makeStructureMap('alice', 1, root.id, 'title');
      const val = makeValue('alice', 2, child.id, 'Hello');

      const all: Constraint[] = [root, child, val];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const avFacts = factsOf(result.facts, ACTIVE_VALUE.predicate);
      const slot = avFacts[0]!.values[ACTIVE_VALUE.SLOT] as string;

      // Slot should contain the parent key and key name, not the child CnId
      expect(slot).toContain('map:');
      expect(slot).toContain(':title');
      expect(slot).not.toBe(cnIdKey(child.id));
    });

    it('two values targeting different structures for the same (parent, key) get the same Slot', () => {
      const root = makeStructureRoot('alice', 0, 'profile');

      // Alice and Bob independently create the same map slot
      const aliceChild = makeStructureMap('alice', 1, root.id, 'name');
      const bobChild = makeStructureMap('bob', 1, root.id, 'name');

      // Each writes a value targeting their own structure
      const aliceVal = makeValue('alice', 2, aliceChild.id, 'Alice', 5);
      const bobVal = makeValue('bob', 2, bobChild.id, 'Bob', 7);

      const all: Constraint[] = [root, aliceChild, bobChild, aliceVal, bobVal];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const avFacts = factsOf(result.facts, ACTIVE_VALUE.predicate);
      expect(avFacts).toHaveLength(2);

      // Both should have the same Slot value
      const slots = avFacts.map((f) => f.values[ACTIVE_VALUE.SLOT]);
      expect(slots[0]).toBe(slots[1]);
    });

    it('value targeting a seq structure gets the seq element CnId as Slot', () => {
      const root = makeStructureRoot('alice', 0, 'todos', 'seq');
      const elem = makeStructureSeq('alice', 1, root.id, null, null);
      const val = makeValue('alice', 2, elem.id, 'Buy milk');

      const all: Constraint[] = [root, elem, val];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const avFacts = factsOf(result.facts, ACTIVE_VALUE.predicate);
      expect(avFacts).toHaveLength(1);

      const slot = avFacts[0]!.values[ACTIVE_VALUE.SLOT] as string;
      expect(slot).toContain('seq:');
      expect(slot).toContain(cnIdKey(elem.id));
    });

    it('multiple values for the same slot are all projected', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child = makeStructureMap('alice', 1, root.id, 'title');

      const val1 = makeValue('alice', 2, child.id, 'First', 1);
      const val2 = makeValue('bob', 2, child.id, 'Second', 3);
      const val3 = makeValue('charlie', 2, child.id, 'Third', 2);

      const all: Constraint[] = [root, child, val1, val2, val3];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const avFacts = factsOf(result.facts, ACTIVE_VALUE.predicate);
      expect(avFacts).toHaveLength(3);

      // All have the same slot
      const slots = new Set(avFacts.map((f) => f.values[ACTIVE_VALUE.SLOT]));
      expect(slots.size).toBe(1);
    });

    it('value with null content is projected (map deletion via LWW)', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child = makeStructureMap('alice', 1, root.id, 'title');
      const val = makeValue('alice', 2, child.id, null, 5);

      const all: Constraint[] = [root, child, val];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const avFacts = factsOf(result.facts, ACTIVE_VALUE.predicate);
      expect(avFacts).toHaveLength(1);
      expect(avFacts[0]!.values[ACTIVE_VALUE.CONTENT]).toBeNull();
    });

    it('value with numeric content preserves type', () => {
      const root = makeStructureRoot('alice', 0, 'data');
      const child = makeStructureMap('alice', 1, root.id, 'count');
      const val = makeValue('alice', 2, child.id, 42, 1);

      const all: Constraint[] = [root, child, val];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const avFacts = factsOf(result.facts, ACTIVE_VALUE.predicate);
      expect(avFacts[0]!.values[ACTIVE_VALUE.CONTENT]).toBe(42);
    });

    it('value with bigint content preserves type', () => {
      const root = makeStructureRoot('alice', 0, 'data');
      const child = makeStructureMap('alice', 1, root.id, 'id');
      const val = makeValue('alice', 2, child.id, 99n, 1);

      const all: Constraint[] = [root, child, val];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const avFacts = factsOf(result.facts, ACTIVE_VALUE.predicate);
      expect(avFacts[0]!.values[ACTIVE_VALUE.CONTENT]).toBe(99n);
    });
  });

  describe('orphaned values', () => {
    it('value targeting a nonexistent structure is orphaned', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const unknownTarget = createCnId('nobody', 99);
      const val = makeValue('alice', 1, unknownTarget, 'Hello');

      const all: Constraint[] = [root, val];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const avFacts = factsOf(result.facts, ACTIVE_VALUE.predicate);
      expect(avFacts).toHaveLength(0);
      expect(result.orphanedValues).toHaveLength(1);
      expect(result.orphanedValues[0]).toBe(val);
    });

    it('orphaned values do not affect projected facts', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child = makeStructureMap('alice', 1, root.id, 'title');

      const goodVal = makeValue('alice', 2, child.id, 'Hello');
      const orphanVal = makeValue('bob', 3, createCnId('nobody', 99), 'Ghost');

      const all: Constraint[] = [root, child, goodVal, orphanVal];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const avFacts = factsOf(result.facts, ACTIVE_VALUE.predicate);
      expect(avFacts).toHaveLength(1);
      expect(result.orphanedValues).toHaveLength(1);
    });

    it('no orphaned values when all targets exist', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child = makeStructureMap('alice', 1, root.id, 'title');
      const val = makeValue('alice', 2, child.id, 'Hello');

      const all: Constraint[] = [root, child, val];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      expect(result.orphanedValues).toHaveLength(0);
    });
  });

  describe('seq structure projection', () => {
    it('emits active_structure_seq fact for seq structure constraints', () => {
      const root = makeStructureRoot('alice', 0, 'list', 'seq');
      const elem = makeStructureSeq('alice', 1, root.id, null, null);

      const all: Constraint[] = [root, elem];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const seqFacts = factsOf(result.facts, ACTIVE_STRUCTURE_SEQ.predicate);
      expect(seqFacts).toHaveLength(1);

      const f = seqFacts[0]!;
      expect(f.values[ACTIVE_STRUCTURE_SEQ.CNID]).toBe(cnIdKey(elem.id));
      expect(f.values[ACTIVE_STRUCTURE_SEQ.PARENT]).toBe(cnIdKey(root.id));
      expect(f.values[ACTIVE_STRUCTURE_SEQ.ORIGIN_LEFT]).toBeNull();
      expect(f.values[ACTIVE_STRUCTURE_SEQ.ORIGIN_RIGHT]).toBeNull();
    });

    it('seq structure with non-null origins emits correct references', () => {
      const root = makeStructureRoot('alice', 0, 'list', 'seq');
      const elem1 = makeStructureSeq('alice', 1, root.id, null, null);
      const elem2 = makeStructureSeq('alice', 2, root.id, elem1.id, null);

      const all: Constraint[] = [root, elem1, elem2];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const seqFacts = factsOf(result.facts, ACTIVE_STRUCTURE_SEQ.predicate);
      expect(seqFacts).toHaveLength(2);

      // Find elem2's fact
      const f2 = seqFacts.find(
        (f) => f.values[ACTIVE_STRUCTURE_SEQ.CNID] === cnIdKey(elem2.id),
      )!;
      expect(f2.values[ACTIVE_STRUCTURE_SEQ.ORIGIN_LEFT]).toBe(cnIdKey(elem1.id));
      expect(f2.values[ACTIVE_STRUCTURE_SEQ.ORIGIN_RIGHT]).toBeNull();
    });

    it('does not emit active_structure_seq for map or root structures', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child = makeStructureMap('alice', 1, root.id, 'title');

      const all: Constraint[] = [root, child];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const seqFacts = factsOf(result.facts, ACTIVE_STRUCTURE_SEQ.predicate);
      expect(seqFacts).toHaveLength(0);
    });
  });

  describe('constraint_peer projection', () => {
    it('emits constraint_peer fact for seq structure constraints', () => {
      const root = makeStructureRoot('alice', 0, 'list', 'seq');
      const elem = makeStructureSeq('bob', 1, root.id, null, null);

      const all: Constraint[] = [root, elem];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const peerFacts = factsOf(result.facts, CONSTRAINT_PEER.predicate);
      expect(peerFacts).toHaveLength(1);

      const f = peerFacts[0]!;
      expect(f.values[CONSTRAINT_PEER.CNID]).toBe(cnIdKey(elem.id));
      expect(f.values[CONSTRAINT_PEER.PEER]).toBe('bob');
    });

    it('does not emit constraint_peer for non-seq structures', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child = makeStructureMap('alice', 1, root.id, 'title');

      const all: Constraint[] = [root, child];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const peerFacts = factsOf(result.facts, CONSTRAINT_PEER.predicate);
      expect(peerFacts).toHaveLength(0);
    });

    it('multiple seq elements each emit their own constraint_peer', () => {
      const root = makeStructureRoot('alice', 0, 'list', 'seq');
      const e1 = makeStructureSeq('alice', 1, root.id, null, null);
      const e2 = makeStructureSeq('bob', 1, root.id, e1.id, null);
      const e3 = makeStructureSeq('charlie', 1, root.id, e2.id, null);

      const all: Constraint[] = [root, e1, e2, e3];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const peerFacts = factsOf(result.facts, CONSTRAINT_PEER.predicate);
      expect(peerFacts).toHaveLength(3);

      const peers = peerFacts.map((f) => f.values[CONSTRAINT_PEER.PEER]);
      expect(peers).toContain('alice');
      expect(peers).toContain('bob');
      expect(peers).toContain('charlie');
    });
  });

  describe('non-projected constraint types', () => {
    it('retract constraints are not projected', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const retract: Constraint = {
        id: createCnId('alice', 1),
        lamport: 1,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'retract',
        payload: { target: root.id },
      };

      const all: Constraint[] = [root, retract];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      // Only the root is a structure, no values or seq structures
      expect(result.facts).toHaveLength(0);
    });

    it('rule constraints are not projected into facts', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const ruleConstraint: Constraint = {
        id: createCnId('alice', 1),
        lamport: 1,
        refs: [],
        sig: STUB_SIGNATURE,
        type: 'rule',
        payload: {
          layer: 2,
          head: { predicate: 'test', terms: [] },
          body: [],
        },
      };

      const all: Constraint[] = [root, ruleConstraint];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      expect(result.facts).toHaveLength(0);
    });
  });

  describe('projection roundtrip (test-double shape)', () => {
    it('projected active_value facts match Phase 1 test-double shape', () => {
      // Phase 1 tests use: fact('active_value', ['cn1', 'title', 'Hello', 1, 'alice'])
      // The projection should produce facts in the same 5-column shape:
      // [CnIdKey, SlotId, Content, Lamport, Peer]

      const root = makeStructureRoot('alice', 0, 'profile');
      const child = makeStructureMap('alice', 1, root.id, 'title');
      const val = makeValue('alice', 2, child.id, 'Hello', 10);

      const all: Constraint[] = [root, child, val];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const avFacts = factsOf(result.facts, ACTIVE_VALUE.predicate);
      expect(avFacts).toHaveLength(1);

      const f = avFacts[0]!;
      // Verify 5-column shape
      expect(f.values).toHaveLength(5);

      // Column types match test-double conventions
      expect(typeof f.values[0]).toBe('string'); // CnId key
      expect(typeof f.values[1]).toBe('string'); // Slot identity
      expect(f.values[2]).toBe('Hello');          // Content (any Value)
      expect(typeof f.values[3]).toBe('number'); // Lamport
      expect(typeof f.values[4]).toBe('string'); // Peer
    });

    it('projected active_structure_seq facts have correct 4-column shape', () => {
      const root = makeStructureRoot('alice', 0, 'list', 'seq');
      const elem = makeStructureSeq('alice', 1, root.id, null, null);

      const all: Constraint[] = [root, elem];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const seqFacts = factsOf(result.facts, ACTIVE_STRUCTURE_SEQ.predicate);
      expect(seqFacts).toHaveLength(1);
      expect(seqFacts[0]!.values).toHaveLength(4);
    });

    it('projected constraint_peer facts have correct 2-column shape', () => {
      const root = makeStructureRoot('alice', 0, 'list', 'seq');
      const elem = makeStructureSeq('alice', 1, root.id, null, null);

      const all: Constraint[] = [root, elem];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const peerFacts = factsOf(result.facts, CONSTRAINT_PEER.predicate);
      expect(peerFacts).toHaveLength(1);
      expect(peerFacts[0]!.values).toHaveLength(2);
    });
  });

  describe('empty and edge cases', () => {
    it('no constraints produces empty result', () => {
      const index = buildStructureIndex([]);
      const result = projectToFacts([], index);

      expect(result.facts).toHaveLength(0);
      expect(result.orphanedValues).toHaveLength(0);
    });

    it('only structure constraints (no values) produces only seq facts', () => {
      const root = makeStructureRoot('alice', 0, 'list', 'seq');
      const elem = makeStructureSeq('alice', 1, root.id, null, null);

      const all: Constraint[] = [root, elem];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const avFacts = factsOf(result.facts, ACTIVE_VALUE.predicate);
      expect(avFacts).toHaveLength(0);

      const seqFacts = factsOf(result.facts, ACTIVE_STRUCTURE_SEQ.predicate);
      expect(seqFacts).toHaveLength(1);
    });

    it('only map structure constraints (no values, no seq) produces no facts', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const child = makeStructureMap('alice', 1, root.id, 'title');

      const all: Constraint[] = [root, child];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      expect(result.facts).toHaveLength(0);
    });

    it('value targeting root structure is projected', () => {
      const root = makeStructureRoot('alice', 0, 'profile');
      const val = makeValue('alice', 1, root.id, 'root-value', 5);

      const all: Constraint[] = [root, val];
      const index = buildStructureIndex(all);
      const result = projectToFacts(all, index);

      const avFacts = factsOf(result.facts, ACTIVE_VALUE.predicate);
      expect(avFacts).toHaveLength(1);
      expect(avFacts[0]!.values[ACTIVE_VALUE.SLOT]).toBe('root:profile');
    });
  });
});

// ---------------------------------------------------------------------------
// constraintKeyFromFact
// ---------------------------------------------------------------------------

describe('constraintKeyFromFact', () => {
  it('returns CnIdKey at position 0 for an active_value fact', () => {
    const cnIdKey = 'alice@42';
    const f = fact(ACTIVE_VALUE.predicate, [cnIdKey, 'slot:x', 'hello', 1, 'alice']);
    expect(constraintKeyFromFact(f)).toBe(cnIdKey);
  });

  it('returns CnIdKey at position 0 for an active_structure_seq fact', () => {
    const cnIdKey = 'bob@7';
    const f = fact(ACTIVE_STRUCTURE_SEQ.predicate, [cnIdKey, 'parent@1', null, null]);
    expect(constraintKeyFromFact(f)).toBe(cnIdKey);
  });

  it('returns CnIdKey at position 0 for a constraint_peer fact', () => {
    const cnIdKey = 'carol@99';
    const f = fact(CONSTRAINT_PEER.predicate, [cnIdKey, 'carol']);
    expect(constraintKeyFromFact(f)).toBe(cnIdKey);
  });

  it('returns null for a fact with an unknown predicate', () => {
    const f = fact('some_other_relation', ['value0', 'value1']);
    expect(constraintKeyFromFact(f)).toBeNull();
  });

  it('returns null for a fact with empty values', () => {
    const f = fact('active_value', []);
    expect(constraintKeyFromFact(f)).toBeNull();
  });
});