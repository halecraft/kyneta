// === Constraint Store ===
// Implements the constraint store for the kernel layer.
//
// The store is a CnId-keyed set of constraints. It grows monotonically.
// Merge between two stores is set union — commutative, associative, idempotent.
//
// Mutation strategy: the store mutates in place. The `generation` counter
// increments on every mutation, serving as the cache-invalidation signal.
// Callers that cache solved results check the generation, not the store
// reference. This avoids the O(n) clone-per-insert cost of the previous
// immutable-return API.
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
 * The store mutates in place via `insert`, `insertMany`, and `importDelta`.
 * The `generation` counter increments on every mutation, serving as the
 * cache-invalidation signal for downstream consumers (e.g., the solver
 * pipeline can skip re-solving if the generation hasn't changed).
 *
 * External-facing properties are readonly to prevent accidental mutation
 * outside of the store's own functions.
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
 * Mutable constraint store — the actual runtime type behind ConstraintStore.
 *
 * All ConstraintStore instances are MutableConstraintStore at runtime.
 * The readonly interface prevents accidental mutation by downstream code;
 * only this module's functions cast to MutableConstraintStore to mutate.
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
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Cast a ConstraintStore to its mutable internal representation.
 *
 * This is safe because all ConstraintStore instances are created by
 * `createStore()` or `mergeStores()`, both of which produce
 * MutableConstraintStore values.
 */
function asMutable(store: ConstraintStore): MutableConstraintStore {
  return store as MutableConstraintStore;
}

/**
 * Validate a single constraint's structural invariants.
 *
 * Returns null if valid, or an InsertError if invalid.
 */
function validateConstraint(constraint: Constraint): InsertError | null {
  if (!isSafeUint(constraint.id.counter)) {
    return {
      kind: 'outOfRange',
      field: 'id.counter',
      value: constraint.id.counter,
    };
  }

  if (!isSafeUint(constraint.lamport)) {
    return {
      kind: 'outOfRange',
      field: 'lamport',
      value: constraint.lamport,
    };
  }

  // Validate signature (stub: always passes)
  if (!verify(new Uint8Array(0), constraint.sig, new Uint8Array(0))) {
    return {
      kind: 'invalidSignature',
      constraintId: constraint.id,
    };
  }

  return null;
}

/**
 * Apply a single already-validated constraint to a mutable store.
 *
 * Returns true if the constraint was new (store was mutated),
 * false if it was a duplicate (no-op).
 */
function applyConstraint(
  mutable: MutableConstraintStore,
  constraint: Constraint,
): boolean {
  const key = cnIdKey(constraint.id);

  // Deduplication — idempotent
  if (mutable.constraints.has(key)) {
    return false;
  }

  mutable.constraints.set(key, constraint);
  vvExtend(mutable.versionVector, constraint.id.peer, constraint.id.counter);

  if (constraint.lamport > mutable.lamport) {
    mutable.lamport = constraint.lamport;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

/**
 * Insert a constraint into the store (mutates in place).
 *
 * Returns `Result<void, InsertError>`:
 * - On success: the store has been mutated to include the constraint.
 * - On failure: the store is unchanged; an InsertError describes why.
 *
 * Deduplication: if a constraint with the same CnId already exists,
 * the store is unchanged (success, not an error — idempotent).
 *
 * Validation performed:
 * 1. counter must be a safe unsigned integer (0 ≤ x ≤ 2^53 − 1).
 * 2. lamport must be a safe unsigned integer.
 * 3. Signature must verify against id.peer (stub: always true).
 *
 * @param store - The store to mutate.
 * @param constraint - The constraint to insert.
 * @returns Result indicating success or an InsertError.
 */
export function insert(
  store: ConstraintStore,
  constraint: Constraint,
): Result<void, InsertError> {
  const error = validateConstraint(constraint);
  if (error !== null) {
    return err(error);
  }

  const mutable = asMutable(store);
  if (applyConstraint(mutable, constraint)) {
    mutable.generation += 1;
  }

  return ok(undefined);
}

/**
 * Insert multiple constraints at once (mutates in place).
 *
 * Validates all constraints before applying any (fail fast).
 * Returns the first InsertError encountered, or success.
 *
 * @param store - The store to mutate.
 * @param constraints - The constraints to insert.
 * @returns Result indicating success or an InsertError.
 */
export function insertMany(
  store: ConstraintStore,
  constraints: readonly Constraint[],
): Result<void, InsertError> {
  if (constraints.length === 0) {
    return ok(undefined);
  }

  // Validate all constraints first (fail fast — no partial mutation)
  for (const constraint of constraints) {
    const error = validateConstraint(constraint);
    if (error !== null) {
      return err(error);
    }
  }

  // Apply all valid constraints
  const mutable = asMutable(store);
  let anyNew = false;

  for (const constraint of constraints) {
    if (applyConstraint(mutable, constraint)) {
      anyNew = true;
    }
  }

  if (anyNew) {
    mutable.generation += 1;
  }

  return ok(undefined);
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
 * Merge two constraint stores via set union, returning a NEW store.
 *
 * Neither input store is mutated. The result is a fresh store containing
 * all constraints from both inputs.
 *
 * Properties:
 * - Commutative: merge(A, B) contains same constraints as merge(B, A)
 * - Associative: merge(merge(A, B), C) contains same as merge(A, merge(B, C))
 * - Idempotent: merge(A, A) contains same constraints as A
 *
 * @param a - First store (not mutated).
 * @param b - Second store (not mutated).
 * @returns A new merged store containing all constraints from both.
 */
export function mergeStores(
  a: ConstraintStore,
  b: ConstraintStore,
): ConstraintStore {
  // Optimize: copy larger, then add smaller's unique entries
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
    // No new constraints from smaller. Check if VV/lamport differ.
    if (vvEquals(larger.versionVector, smaller.versionVector) &&
        larger.lamport >= smaller.lamport) {
      return larger;
    }
  }

  // Build a new store from larger + smaller's unique entries
  const merged: MutableConstraintStore = {
    constraints: new Map(larger.constraints),
    versionVector: vvClone(larger.versionVector),
    lamport: larger.lamport,
    generation: larger.generation + 1,
  };

  for (const [key, constraint] of smaller.constraints) {
    if (!merged.constraints.has(key)) {
      merged.constraints.set(key, constraint);
    }
  }

  // Merge version vectors
  vvMergeInto(merged.versionVector, smaller.versionVector);

  // Take max Lamport
  if (smaller.lamport > merged.lamport) {
    merged.lamport = smaller.lamport;
  }

  return merged as ConstraintStore;
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
 * Import a delta from another peer (mutates store in place).
 *
 * @param store - Our constraint store (mutated on success).
 * @param delta - The delta to import.
 * @returns Result indicating success or an InsertError.
 */
export function importDelta(
  store: ConstraintStore,
  delta: ConstraintDelta,
): Result<void, InsertError> {
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
 * Check equality of two version vectors (used internally by mergeStores).
 */
function vvEquals(a: VersionVector, b: VersionVector): boolean {
  if (a.size !== b.size) return false;
  for (const [peer, counterA] of a) {
    if (vvGet(b, peer) !== counterA) return false;
  }
  return true;
}