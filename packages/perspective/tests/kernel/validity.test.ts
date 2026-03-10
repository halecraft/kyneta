// === Validity Tests ===
// Tests for Valid(S) computation: signature verification, capability checks,
// creator bypass, and auditability of invalid constraints.

import { describe, it, expect } from 'vitest';
import {
  computeValid,
  filterValid,
} from '../../src/kernel/validity.js';
import type { ValidityResult } from '../../src/kernel/validity.js';
import {
  computeAuthority,
  hasCapability,
} from '../../src/kernel/authority.js';
import { createAgent } from '../../src/kernel/agent.js';
import { createCnId } from '../../src/kernel/cnid.js';
import type {
  Capability,
  Constraint,
  AuthorityConstraint,
  StructureConstraint,
  ValueConstraint,
  RetractConstraint,
  BookmarkConstraint,
  PeerID,
  CnId,
} from '../../src/kernel/types.js';
import { STUB_SIGNATURE } from '../../src/kernel/signature.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAuthorityConstraint(
  peer: PeerID,
  counter: number,
  lamport: number,
  targetPeer: PeerID,
  action: 'grant' | 'revoke',
  capability: Capability,
  refs: CnId[] = [],
): AuthorityConstraint {
  return {
    id: { peer, counter },
    lamport,
    refs,
    sig: STUB_SIGNATURE,
    type: 'authority',
    payload: { targetPeer, action, capability },
  };
}

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

function makeBookmarkConstraint(
  peer: PeerID,
  counter: number,
  lamport: number,
): BookmarkConstraint {
  return {
    id: { peer, counter },
    lamport,
    refs: [],
    sig: STUB_SIGNATURE,
    type: 'bookmark',
    payload: { name: 'snap1', version: new Map() },
  };
}

const WRITE_ANY: Capability = { kind: 'write', pathPattern: ['*'] };
const CREATE_NODE_ANY: Capability = { kind: 'createNode', pathPattern: ['*'] };
const RETRACT_ANY: Capability = { kind: 'retract', scope: { kind: 'any' } };

// ---------------------------------------------------------------------------
// Creator constraints always valid
// ---------------------------------------------------------------------------

describe('computeValid', () => {
  describe('creator constraints', () => {
    it('creator constraints are always valid (implicit Admin)', () => {
      const constraints: Constraint[] = [
        makeStructureConstraint('alice', 0, 1),
        makeValueConstraint('alice', 1, 2, createCnId('alice', 0), 'hello'),
        makeRetractConstraint('alice', 2, 3, createCnId('alice', 1)),
      ];

      const result = computeValid(constraints, 'alice');
      expect(result.valid.length).toBe(3);
      expect(result.invalid.length).toBe(0);
    });

    it('creator can produce authority constraints', () => {
      const constraints: Constraint[] = [
        makeAuthorityConstraint('alice', 0, 1, 'bob', 'grant', WRITE_ANY),
      ];

      const result = computeValid(constraints, 'alice');
      expect(result.valid.length).toBe(1);
      expect(result.invalid.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Non-creator without capabilities
  // ---------------------------------------------------------------------------

  describe('non-creator without capabilities', () => {
    it('non-creator value constraint is invalid without capability', () => {
      const constraints: Constraint[] = [
        makeValueConstraint('bob', 0, 1, createCnId('alice', 0), 'hello'),
      ];

      const result = computeValid(constraints, 'alice');
      expect(result.valid.length).toBe(0);
      expect(result.invalid.length).toBe(1);
      expect(result.invalid[0]!.error.kind).toBe('missingCapability');
    });

    it('non-creator structure constraint is invalid without capability', () => {
      const constraints: Constraint[] = [
        makeStructureConstraint('bob', 0, 1),
      ];

      const result = computeValid(constraints, 'alice');
      expect(result.valid.length).toBe(0);
      expect(result.invalid.length).toBe(1);
      expect(result.invalid[0]!.error.kind).toBe('missingCapability');
    });

    it('non-creator retract constraint is invalid without capability', () => {
      const constraints: Constraint[] = [
        makeRetractConstraint('bob', 0, 1, createCnId('alice', 0)),
      ];

      const result = computeValid(constraints, 'alice');
      expect(result.valid.length).toBe(0);
      expect(result.invalid.length).toBe(1);
      expect(result.invalid[0]!.error.kind).toBe('missingCapability');
    });

    it('non-creator authority constraint is invalid without authority capability', () => {
      // Bob tries to grant carol write access — but bob has no Authority(Write) capability
      const constraints: Constraint[] = [
        makeAuthorityConstraint('bob', 0, 1, 'carol', 'grant', WRITE_ANY),
      ];

      const result = computeValid(constraints, 'alice');
      expect(result.valid.length).toBe(0);
      expect(result.invalid.length).toBe(1);
      expect(result.invalid[0]!.error.kind).toBe('missingCapability');
    });
  });

  // ---------------------------------------------------------------------------
  // Non-creator with capabilities
  // ---------------------------------------------------------------------------

  describe('non-creator with capabilities', () => {
    it('non-creator with granted write capability can produce value constraints', () => {
      const constraints: Constraint[] = [
        // Alice grants bob write
        makeAuthorityConstraint('alice', 0, 1, 'bob', 'grant', WRITE_ANY),
        // Bob produces a value
        makeValueConstraint('bob', 0, 2, createCnId('alice', 0), 'hello'),
      ];

      const result = computeValid(constraints, 'alice');
      expect(result.valid.length).toBe(2);
      expect(result.invalid.length).toBe(0);
    });

    it('non-creator with createNode can produce structure constraints', () => {
      const constraints: Constraint[] = [
        makeAuthorityConstraint('alice', 0, 1, 'bob', 'grant', CREATE_NODE_ANY),
        makeStructureConstraint('bob', 0, 2),
      ];

      const result = computeValid(constraints, 'alice');
      expect(result.valid.length).toBe(2);
      expect(result.invalid.length).toBe(0);
    });

    it('non-creator with retract capability can produce retract constraints', () => {
      const constraints: Constraint[] = [
        makeAuthorityConstraint('alice', 0, 1, 'bob', 'grant', RETRACT_ANY),
        makeRetractConstraint('bob', 0, 2, createCnId('alice', 0)),
      ];

      const result = computeValid(constraints, 'alice');
      expect(result.valid.length).toBe(2);
      expect(result.invalid.length).toBe(0);
    });

    it('revoked capability makes subsequent constraints invalid', () => {
      const constraints: Constraint[] = [
        // Grant then revoke
        makeAuthorityConstraint('alice', 0, 1, 'bob', 'grant', WRITE_ANY),
        makeAuthorityConstraint('alice', 1, 2, 'bob', 'revoke', WRITE_ANY),
        // Bob tries to write after revocation
        makeValueConstraint('bob', 0, 3, createCnId('alice', 0), 'hello'),
      ];

      const result = computeValid(constraints, 'alice');
      // The two authority constraints are valid (from creator)
      // Bob's value constraint is invalid (capability was revoked)
      const validTypes = result.valid.map((c) => c.type);
      expect(validTypes.filter((t) => t === 'authority').length).toBe(2);
      expect(result.invalid.length).toBe(1);
      expect(result.invalid[0]!.constraint.type).toBe('value');
      expect(result.invalid[0]!.error.kind).toBe('missingCapability');
    });
  });

  // ---------------------------------------------------------------------------
  // Bookmark constraints
  // ---------------------------------------------------------------------------

  describe('bookmark constraints', () => {
    it('bookmarks require no capability (any peer can bookmark)', () => {
      const constraints: Constraint[] = [
        makeBookmarkConstraint('bob', 0, 1),
      ];

      const result = computeValid(constraints, 'alice');
      expect(result.valid.length).toBe(1);
      expect(result.invalid.length).toBe(0);
    });

    it('bookmarks from unknown peer are valid', () => {
      const constraints: Constraint[] = [
        makeBookmarkConstraint('unknown_peer', 0, 1),
      ];

      const result = computeValid(constraints, 'alice');
      expect(result.valid.length).toBe(1);
      expect(result.invalid.length).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Auditability
  // ---------------------------------------------------------------------------

  describe('auditability', () => {
    it('invalid constraints include the constraint and error details', () => {
      const bobValue = makeValueConstraint('bob', 0, 1, createCnId('alice', 0), 'sneaky');
      const constraints: Constraint[] = [bobValue];

      const result = computeValid(constraints, 'alice');
      expect(result.invalid.length).toBe(1);

      const entry = result.invalid[0]!;
      expect(entry.constraint).toBe(bobValue);
      expect(entry.error.kind).toBe('missingCapability');
      if (entry.error.kind === 'missingCapability') {
        expect(entry.error.constraintId).toEqual(bobValue.id);
        expect(entry.error.required.kind).toBe('write');
      }
    });

    it('authority state is returned for introspection', () => {
      const constraints: Constraint[] = [
        makeAuthorityConstraint('alice', 0, 1, 'bob', 'grant', WRITE_ANY),
      ];

      const result = computeValid(constraints, 'alice');
      expect(result.authorityState).toBeDefined();
      expect(result.authorityState.creator).toBe('alice');
      expect(hasCapability(result.authorityState, 'bob', WRITE_ANY)).toBe(true);
    });

    it('mix of valid and invalid constraints are correctly separated', () => {
      const constraints: Constraint[] = [
        // Valid: creator structure
        makeStructureConstraint('alice', 0, 1),
        // Valid: creator grants bob write
        makeAuthorityConstraint('alice', 1, 2, 'bob', 'grant', WRITE_ANY),
        // Valid: bob writes (has capability)
        makeValueConstraint('bob', 0, 3, createCnId('alice', 0), 'ok'),
        // Invalid: carol writes (no capability)
        makeValueConstraint('carol', 0, 4, createCnId('alice', 0), 'denied'),
        // Valid: creator bookmark
        makeBookmarkConstraint('alice', 2, 5),
        // Valid: anyone can bookmark
        makeBookmarkConstraint('dave', 0, 6),
      ];

      const result = computeValid(constraints, 'alice');
      expect(result.valid.length).toBe(5);
      expect(result.invalid.length).toBe(1);
      expect(result.invalid[0]!.constraint.id.peer).toBe('carol');
    });
  });

  // ---------------------------------------------------------------------------
  // Determinism
  // ---------------------------------------------------------------------------

  describe('determinism', () => {
    it('same S produces same Valid(S) regardless of order', () => {
      const c1 = makeStructureConstraint('alice', 0, 1);
      const c2 = makeAuthorityConstraint('alice', 1, 2, 'bob', 'grant', WRITE_ANY);
      const c3 = makeValueConstraint('bob', 0, 3, createCnId('alice', 0), 'hello');
      const c4 = makeValueConstraint('carol', 0, 4, createCnId('alice', 0), 'denied');

      const result1 = computeValid([c1, c2, c3, c4], 'alice');
      const result2 = computeValid([c4, c3, c2, c1], 'alice');
      const result3 = computeValid([c3, c1, c4, c2], 'alice');

      // Same number of valid/invalid in all orderings
      expect(result1.valid.length).toBe(result2.valid.length);
      expect(result1.valid.length).toBe(result3.valid.length);
      expect(result1.invalid.length).toBe(result2.invalid.length);
      expect(result1.invalid.length).toBe(result3.invalid.length);

      // Carol's constraint is always invalid
      expect(result1.invalid.every((i) => i.constraint.id.peer === 'carol')).toBe(true);
      expect(result2.invalid.every((i) => i.constraint.id.peer === 'carol')).toBe(true);
      expect(result3.invalid.every((i) => i.constraint.id.peer === 'carol')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Version-parameterized validity
  // ---------------------------------------------------------------------------

  describe('version-parameterized', () => {
    it('validity respects version vector when provided', () => {
      const constraints: Constraint[] = [
        // Alice grants bob write at counter 0
        makeAuthorityConstraint('alice', 0, 1, 'bob', 'grant', WRITE_ANY),
        // Bob writes at counter 0
        makeValueConstraint('bob', 0, 2, createCnId('alice', 0), 'hello'),
      ];

      // Version that only sees alice@0 (the grant) but not bob@0
      const version = new Map<string, number>([['alice', 1]]);

      const result = computeValid(constraints, 'alice', version);
      // Only alice's grant should be in the authority state;
      // bob's constraint should still be checked against the authority state.
      // Since the authority state includes the grant (visible at V),
      // bob's value should pass capability check.
      // (The version filter is applied to authority replay, not to the
      // constraint list itself — the caller is responsible for pre-filtering
      // constraints to those visible at V.)
      expect(result.valid.length).toBe(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('empty constraint set returns empty valid and invalid', () => {
      const result = computeValid([], 'alice');
      expect(result.valid.length).toBe(0);
      expect(result.invalid.length).toBe(0);
      expect(result.authorityState.creator).toBe('alice');
    });

    it('creator with no constraints still has Admin in authority state', () => {
      const result = computeValid([], 'alice');
      expect(hasCapability(result.authorityState, 'alice', { kind: 'admin' })).toBe(true);
    });

    it('admin granted to non-creator gives them full access', () => {
      const constraints: Constraint[] = [
        makeAuthorityConstraint('alice', 0, 1, 'bob', 'grant', { kind: 'admin' }),
        makeStructureConstraint('bob', 0, 2),
        makeValueConstraint('bob', 1, 3, createCnId('bob', 0), 'hello'),
      ];

      const result = computeValid(constraints, 'alice');
      expect(result.valid.length).toBe(3);
      expect(result.invalid.length).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// filterValid convenience function
// ---------------------------------------------------------------------------

describe('filterValid', () => {
  it('returns only valid constraints', () => {
    const constraints: Constraint[] = [
      makeStructureConstraint('alice', 0, 1),
      makeValueConstraint('bob', 0, 2, createCnId('alice', 0), 'denied'),
    ];

    const valid = filterValid(constraints, 'alice');
    expect(valid.length).toBe(1);
    expect(valid[0]!.id.peer).toBe('alice');
  });

  it('returns empty for all-invalid constraints', () => {
    const constraints: Constraint[] = [
      makeValueConstraint('bob', 0, 1, createCnId('alice', 0), 'denied'),
    ];

    const valid = filterValid(constraints, 'alice');
    expect(valid.length).toBe(0);
  });
});