// === Constraint Store ===
// Implements the constraint store for the kernel layer.
//
// The store is a CnId-keyed set of constraints. It grows monotonically.
// Merge between two stores is set union — commutative, associative, idempotent.
//
// See unified-engine.md §4, §B.2.

import type {
  Constraint,
  CnId,
  InsertError,
  Result,
  VersionVector,
  MutableVersionVector,
  Lamport,
} from './types.js';
import { ok, err, isSafeUint } from './types.js';
import { cnIdKey } from './cnid.js';
import { verify } from './signature.js';
import {
  createVersionVector,
  vvClone,
  vvExtend,
  vvMergeInto,
  vvDiff,
  vvGet,
} from './version-vector.js';

// ---------------------------------------------------------------------------
// Store Type
// ---------------------------------------------------------------------------

/**
 * The ConstraintStore holds all constraints and provides efficient access.
 *
 * Immutable from the outside — all mutation goes through `insert` or
 * `mergeStores`, which return new results / mutate internal state via
 * the mutable handle pattern.
 */
export interface ConstraintStore {
  /** All constraints by their CnId key string. */
  readonly constraints: ReadonlyMap<string, Constraint>;

  /** Version vector tracking what we've seen. */
  readonly versionVector: VersionVector;

  /** Current maximum Lamport value observed. */
  readonly lamport: Lamport;

  /**
   * Generation counter — monotonically increasing on every mutation.
   *
   * Used for cache invalidation: if the generation hasn't changed,
   * cached solved values are still valid.
   */
  readonly generation: number;
}

/**
 * Mutable constraint store for internal use.
 */
interface MutableConstraintStore {
  constraints: Map<string, Constraint>;
  versionVector: MutableVersionVector;
  lamport: Lamport;
  generation: number;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create an empty constraint store.
 */
export function createStore(): ConstraintStore {
  return {
    constraints: new Map(),
    versionVector: createVersionVector(),
    lamport: 0,
    generation: 0,
  };
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

/**
 * Insert a constraint into the store.
 *
 * Returns `Result<ConstraintStore, InsertError>`:
 * - On success: the (possibly updated) store.
 * - On failure: an InsertError describing why the constraint was rejected.
 *
 * Deduplication: if a constraint with the same CnId already exists,
 * the store is returned unchanged (success, not an error — idempotent).
 *
 * Validation performed:
 * 1. counter must be a safe unsigned integer (0 ≤ x ≤ 2^53 − 1).
 * 2. lamport must be a safe unsigned integer.
 * 3. Signature must verify against id.peer (stub: always true).
 *
 * @param store - The current store.
 * @param constraint - The constraint to insert.
 * @returns Result with updated store or InsertError.
 */
export function insert(
  store: ConstraintStore,
  constraint: Constraint,
): Result<ConstraintStore, InsertError> {
  // Validate safe-integer invariants
  if (!isSafeUint(constraint.id.counter)) {
    return err({
      kind: 'outOfRange',
      field: 'id.counter',
      value: constraint.id.counter,
    });
  }

  if (!isSafeUint(constraint.lamport)) {
    return err({
      kind: 'outOfRange',
      field: 'lamport',
      value: constraint.lamport,
    });
  }

  // Validate signature (stub: always passes)
  // In real implementation, we'd serialize (id, lamport, refs, type, payload)
  // and verify against id.peer as public key.
  if (!verify(new Uint8Array(0), constraint.sig, new Uint8Array(0))) {
    return err({
      kind: 'invalidSignature',
      constraintId: constraint.id,
    });
  }

  // Deduplication — if already present, return unchanged (idempotent)
  const key = cnIdKey(constraint.id);
  if (store.constraints.has(key)) {
    return ok(store);
  }

  // Clone and mutate
  const mutable = cloneStore(store);
  mutable.constraints.set(key, constraint);

  // Update version vector
  vvExtend(mutable.versionVector, constraint.id.peer, constraint.id.counter);

  // Update Lamport high-water mark
  if (constraint.lamport > mutable.lamport) {
    mutable.lamport = constraint.lamport;
  }

  return ok(mutable as ConstraintStore);
}

/**
 * Insert multiple constraints at once.
 *
 * More efficient than calling insert() repeatedly — only clones once.
 * Returns the first InsertError encountered, or the updated store.
 *
 * @param store - The current store.
 * @param constraints - The constraints to insert.
 * @returns Result with updated store or InsertError.
 */
export function insertMany(
  store: ConstraintStore,
  constraints: readonly Constraint[],
): Result<ConstraintStore, InsertError> {
  if (constraints.length === 0) {
    return ok(store);
  }

  // Validate all constraints first (fail fast)
  for (const constraint of constraints) {
    if (!isSafeUint(constraint.id.counter)) {
      return err({
        kind: 'outOfRange',
        field: 'id.counter',
        value: constraint.id.counter,
      });
    }
    if (!isSafeUint(constraint.lamport)) {
      return err({
        kind: 'outOfRange',
        field: 'lamport',
        value: constraint.lamport,
      });
    }
    if (!verify(new Uint8Array(0), constraint.sig, new Uint8Array(0))) {
      return err({
        kind: 'invalidSignature',
        constraintId: constraint.id,
      });
    }
  }

  // Check if any are actually new
  const newConstraints: Constraint[] = [];
  for (const constraint of constraints) {
    const key = cnIdKey(constraint.id);
    if (!store.constraints.has(key)) {
      newConstraints.push(constraint);
    }
  }

  if (newConstraints.length === 0) {
    return ok(store);
  }

  // Clone once and apply all
  const mutable = cloneStore(store);

  for (const constraint of newConstraints) {
    const key = cnIdKey(constraint.id);
    mutable.constraints.set(key, constraint);
    vvExtend(mutable.versionVector, constraint.id.peer, constraint.id.counter);
    if (constraint.lamport > mutable.lamport) {
      mutable.lamport = constraint.lamport;
    }
  }

  return ok(mutable as ConstraintStore);
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

/**
 * Get a constraint by its CnId.
 */
export function getConstraint(
  store: ConstraintStore,
  id: CnId,
): Constraint | undefined {
  return store.constraints.get(cnIdKey(id));
}

/**
 * Check if a constraint exists in the store.
 */
export function hasConstraint(store: ConstraintStore, id: CnId): boolean {
  return store.constraints.has(cnIdKey(id));
}

/**
 * Get the total number of constraints in the store.
 */
export function constraintCount(store: ConstraintStore): number {
  return store.constraints.size;
}

/**
 * Iterate over all constraints in the store.
 */
export function allConstraints(store: ConstraintStore): Constraint[] {
  return Array.from(store.constraints.values());
}

/**
 * Filter constraints by type.
 */
export function constraintsByType<T extends Constraint['type']>(
  store: ConstraintStore,
  type: T,
): Extract<Constraint, { type: T }>[] {
  const result: Extract<Constraint, { type: T }>[] = [];
  for (const c of store.constraints.values()) {
    if (c.type === type) {
      result.push(c as Extract<Constraint, { type: T }>);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Merge (§4 — set union)
// ---------------------------------------------------------------------------

/**
 * Merge two constraint stores via set union.
 *
 * Properties:
 * - Commutative: merge(A, B) = merge(B, A)
 * - Associative: merge(merge(A, B), C) = merge(A, merge(B, C))
 * - Idempotent: merge(A, A) = A
 *
 * @param a - First store.
 * @param b - Second store.
 * @returns Merged store containing all constraints from both.
 */
export function mergeStores(
  a: ConstraintStore,
  b: ConstraintStore,
): ConstraintStore {
  // Optimize: merge smaller into larger
  const [larger, smaller] =
    a.constraints.size >= b.constraints.size ? [a, b] : [b, a];

  // Check if smaller has anything new
  let hasNew = false;
  for (const key of smaller.constraints.keys()) {
    if (!larger.constraints.has(key)) {
      hasNew = true;
      break;
    }
  }

  if (!hasNew) {
    // Nothing new — but version vector and lamport might still differ
    // Return the one with the higher generation to preserve cache invalidation
    // semantics. Actually, we need to merge VV and lamport regardless.
    if (vvEquals(larger.versionVector, smaller.versionVector) &&
        larger.lamport >= smaller.lamport) {
      return larger;
    }
  }

  const mutable = cloneStore(larger);

  for (const [key, constraint] of smaller.constraints) {
    if (!mutable.constraints.has(key)) {
      mutable.constraints.set(key, constraint);
    }
  }

  // Merge version vectors
  vvMergeInto(mutable.versionVector, smaller.versionVector);

  // Take max Lamport
  if (smaller.lamport > mutable.lamport) {
    mutable.lamport = smaller.lamport;
  }

  return mutable as ConstraintStore;
}

// ---------------------------------------------------------------------------
// Delta computation (for sync)
// ---------------------------------------------------------------------------

/**
 * A delta contains constraints that one peer has but another doesn't.
 */
export interface ConstraintDelta {
  /** Constraints to send. */
  readonly constraints: readonly Constraint[];

  /** Version vector of the sender at time of export. */
  readonly fromVV: VersionVector;
}

/**
 * Export constraints that the other peer hasn't seen.
 *
 * @param store - Our constraint store.
 * @param theirVV - The other peer's version vector.
 * @returns Delta containing constraints they need.
 */
export function exportDelta(
  store: ConstraintStore,
  theirVV: VersionVector,
): ConstraintDelta {
  const diff = vvDiff(store.versionVector, theirVV);
  const constraints: Constraint[] = [];

  for (const [peer, range] of diff) {
    for (const constraint of store.constraints.values()) {
      if (
        constraint.id.peer === peer &&
        constraint.id.counter >= range.start &&
        constraint.id.counter < range.end
      ) {
        constraints.push(constraint);
      }
    }
  }

  return {
    constraints,
    fromVV: vvClone(store.versionVector),
  };
}

/**
 * Import a delta from another peer.
 *
 * @param store - Our constraint store.
 * @param delta - The delta to import.
 * @returns Result with updated store or InsertError.
 */
export function importDelta(
  store: ConstraintStore,
  delta: ConstraintDelta,
): Result<ConstraintStore, InsertError> {
  return insertMany(store, delta.constraints);
}

// ---------------------------------------------------------------------------
// Version vector access
// ---------------------------------------------------------------------------

/**
 * Get the current version vector.
 */
export function getVersionVector(store: ConstraintStore): VersionVector {
  return store.versionVector;
}

/**
 * Get the current Lamport high-water mark.
 */
export function getLamport(store: ConstraintStore): Lamport {
  return store.lamport;
}

/**
 * Get the generation counter (for cache invalidation).
 */
export function getGeneration(store: ConstraintStore): number {
  return store.generation;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Clone a store with an incremented generation counter.
 */
function cloneStore(store: ConstraintStore): MutableConstraintStore {
  return {
    constraints: new Map(store.constraints),
    versionVector: vvClone(store.versionVector),
    lamport: store.lamport,
    generation: store.generation + 1,
  };
}

/**
 * Check equality of two version vectors (used internally by mergeStores).
 */
function vvEquals(a: VersionVector, b: VersionVector): boolean {
  if (a.size !== b.size) return false;
  for (const [peer, counterA] of a) {
    if (vvGet(b, peer) !== counterA) return false;
  }
  return true;
}