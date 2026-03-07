// === Validity Filter ===
// Implements §5.2–§5.3 of the spec: computing Valid(S) from a constraint set.
//
// A constraint c is valid if:
// 1. c.sig verifies against c.id.peer (cryptographic authenticity)
// 2. c.id.peer held the required capability at c's causal moment (authorization)
//
// Valid(S) = { c ∈ S | valid(c, S) }
//
// Properties:
// - Deterministic: same S → same Valid(S)
// - Invalid constraints remain in the store for auditability
// - Invalid constraints do not participate in solving
//
// See unified-engine.md §5.

import type {
  PeerID,
  Constraint,
  CnId,
  Capability,
  ValidationError,
  VersionVector,
} from './types.js';
import { verify } from './signature.js';
import {
  computeAuthority,
  hasCapability,
  requiredCapability,
  type AuthorityState,
} from './authority.js';

// ---------------------------------------------------------------------------
// Validity Result
// ---------------------------------------------------------------------------

/**
 * The result of computing Valid(S).
 */
export interface ValidityResult {
  /** Constraints that passed both signature and capability checks. */
  readonly valid: readonly Constraint[];

  /** Constraints that failed validation, with reasons. */
  readonly invalid: readonly InvalidConstraint[];

  /** The authority state computed during validation. */
  readonly authorityState: AuthorityState;
}

/**
 * A constraint that failed validation, paired with the reason.
 */
export interface InvalidConstraint {
  readonly constraint: Constraint;
  readonly error: ValidationError;
}

// ---------------------------------------------------------------------------
// Compute Valid(S)
// ---------------------------------------------------------------------------

/**
 * Compute the valid set from a collection of constraints.
 *
 * Performs two checks on each constraint:
 * 1. Signature verification (stub: always passes for now)
 * 2. Capability check: does the asserting peer hold the required
 *    capability at the constraint's causal moment?
 *
 * Authority constraints are always included in the authority chain
 * replay (they define the capabilities), but they themselves must
 * also be validated — an authority constraint from a peer without
 * Authority(C) capability is invalid.
 *
 * Special cases:
 * - The reality creator's constraints always pass capability checks
 *   (creator holds implicit Admin).
 * - Bookmark constraints require no capability.
 *
 * @param constraints - All constraints to validate.
 * @param creator - PeerID of the reality creator.
 * @param version - Optional version vector for historical queries.
 * @returns ValidityResult with valid set, invalid set, and authority state.
 */
export function computeValid(
  constraints: Iterable<Constraint>,
  creator: PeerID,
  version?: VersionVector,
): ValidityResult {
  // Materialize constraints so we can iterate multiple times
  const allConstraints = Array.isArray(constraints)
    ? constraints
    : Array.from(constraints);

  // Step 1: Compute the authority state by replaying authority constraints.
  // This tells us what capabilities each peer holds.
  const authorityState = computeAuthority(allConstraints, creator, version);

  // Step 2: Validate each constraint.
  const valid: Constraint[] = [];
  const invalid: InvalidConstraint[] = [];

  for (const c of allConstraints) {
    const error = validateConstraint(c, authorityState);
    if (error === null) {
      valid.push(c);
    } else {
      invalid.push({ constraint: c, error });
    }
  }

  return { valid, invalid, authorityState };
}

// ---------------------------------------------------------------------------
// Single-constraint validation
// ---------------------------------------------------------------------------

/**
 * Validate a single constraint against the authority state.
 *
 * Returns null if valid, or a ValidationError if invalid.
 */
function validateConstraint(
  c: Constraint,
  authorityState: AuthorityState,
): ValidationError | null {
  // Check 1: Signature verification
  // In the real implementation, we'd serialize the constraint fields
  // and verify the signature against c.id.peer as the public key.
  // Stub: always passes.
  if (!verifySignature(c)) {
    return {
      kind: 'invalidSignature',
      constraintId: c.id,
    };
  }

  // Check 2: Capability check
  const required = requiredCapability(c);

  // Some constraint types require no capability (e.g., bookmarks)
  if (required === null) {
    return null;
  }

  // Check if the asserting peer has the required capability
  if (!hasCapability(authorityState, c.id.peer, required)) {
    return {
      kind: 'missingCapability',
      constraintId: c.id,
      required,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Signature verification (delegates to signature.ts)
// ---------------------------------------------------------------------------

/**
 * Verify the signature of a constraint.
 *
 * In the real implementation, this would:
 * 1. Serialize (id, lamport, refs, type, payload) canonically.
 * 2. Call verify(serialized, c.sig, c.id.peer as publicKey).
 *
 * Stub: always returns true.
 */
function verifySignature(c: Constraint): boolean {
  // The stub signature module always returns true.
  // When real signatures are implemented, this function will
  // perform canonical serialization and delegate to verify().
  return verify(new Uint8Array(0), c.sig, new Uint8Array(0));
}

// ---------------------------------------------------------------------------
// Convenience: filter valid only
// ---------------------------------------------------------------------------

/**
 * Filter a set of constraints to only those that are valid.
 *
 * This is a simpler API when you don't need the invalid set or
 * authority state — just the valid constraints.
 *
 * @param constraints - All constraints.
 * @param creator - PeerID of the reality creator.
 * @param version - Optional version vector for historical queries.
 * @returns Array of valid constraints.
 */
export function filterValid(
  constraints: Iterable<Constraint>,
  creator: PeerID,
  version?: VersionVector,
): Constraint[] {
  return [...computeValid(constraints, creator, version).valid];
}