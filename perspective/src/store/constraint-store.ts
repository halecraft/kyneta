/**
 * Constraint Store for Prism
 *
 * The ConstraintStore is the central repository for all constraints in a Prism document.
 * It provides:
 * - Storage and indexing of constraints
 * - Query by path (for solving)
 * - Version vector tracking (for sync)
 * - Delta computation (for efficient sync)
 *
 * Following CCS terminology:
 * - tell(): Assert a constraint into the store
 * - ask(): Query constraints for a path
 */

import type { Constraint } from "../core/constraint.js";
import { constraintKey, constraintSameId } from "../core/constraint.js";
import type { Lamport, OpId, Path, PeerID, Counter } from "../core/types.js";
import { pathToString, pathStartsWith } from "../core/types.js";
import type {
	VersionVector,
	MutableVersionVector,
} from "../core/version-vector.js";
import {
	createVersionVector,
	vvClone,
	vvExtend,
	vvGet,
	vvHasSeen,
	vvDiff,
	vvMergeInto,
} from "../core/version-vector.js";

// ============================================================================
// Constraint Store Type
// ============================================================================

/**
 * The ConstraintStore holds all constraints and provides efficient access.
 */
export interface ConstraintStore {
	/** All constraints by their unique key (OpId string) */
	readonly constraints: ReadonlyMap<string, Constraint>;

	/** Index: path key -> set of constraint keys */
	readonly byPath: ReadonlyMap<string, ReadonlySet<string>>;

	/** Version vector tracking what we've seen */
	readonly versionVector: VersionVector;

	/** Current Lamport clock */
	readonly lamport: Lamport;

	/**
	 * Generation counter - monotonically increasing on every mutation.
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
	byPath: Map<string, Set<string>>;
	versionVector: MutableVersionVector;
	lamport: Lamport;
	generation: number;
}

// ============================================================================
// Construction
// ============================================================================

/**
 * Create an empty constraint store.
 */
export function createConstraintStore(): ConstraintStore {
	return {
		constraints: new Map(),
		byPath: new Map(),
		versionVector: createVersionVector(),
		lamport: 0,
		generation: 0,
	};
}

/**
 * Clone a constraint store with an incremented generation.
 *
 * The generation is bumped because cloning is typically done
 * in preparation for mutation (tell, merge).
 */
export function cloneStore(store: ConstraintStore): MutableConstraintStore {
	const constraints = new Map(store.constraints);
	const byPath = new Map<string, Set<string>>();
	for (const [pathKey, constraintKeys] of store.byPath) {
		byPath.set(pathKey, new Set(constraintKeys));
	}
	return {
		constraints,
		byPath,
		versionVector: vvClone(store.versionVector),
		lamport: store.lamport,
		generation: store.generation + 1,
	};
}

// ============================================================================
// Tell (Add Constraint)
// ============================================================================

/**
 * Result of a tell operation.
 */
export interface TellResult {
	/** The updated store */
	store: ConstraintStore;

	/** Whether the constraint was new (not a duplicate) */
	isNew: boolean;

	/** Paths affected by this constraint */
	affectedPaths: Path[];
}

/**
 * Tell: Assert a constraint into the store.
 *
 * This is the fundamental operation for adding constraints.
 * Constraints are deduplicated by their OpId.
 *
 * @param store - The current store
 * @param constraint - The constraint to add
 * @returns Result containing new store and metadata
 */
export function tell(
	store: ConstraintStore,
	constraint: Constraint,
): TellResult {
	const key = constraintKey(constraint);

	// Check for duplicate
	const existing = store.constraints.get(key);
	if (existing !== undefined) {
		// Constraint already exists - check if it's identical
		if (constraintSameId(existing, constraint)) {
			return {
				store,
				isNew: false,
				affectedPaths: [],
			};
		}
	}

	// Create mutable copy
	const mutable = cloneStore(store);

	// Add constraint
	mutable.constraints.set(key, constraint);

	// Update path index
	const pathKey = pathToString(constraint.path);
	let pathSet = mutable.byPath.get(pathKey);
	if (pathSet === undefined) {
		pathSet = new Set();
		mutable.byPath.set(pathKey, pathSet);
	}
	pathSet.add(key);

	// Update version vector
	vvExtend(mutable.versionVector, constraint.id.peer, constraint.id.counter);

	// Update Lamport clock
	mutable.lamport = Math.max(mutable.lamport, constraint.metadata.lamport);

	return {
		store: mutable as ConstraintStore,
		isNew: true,
		affectedPaths: [constraint.path],
	};
}

/**
 * Tell multiple constraints at once.
 *
 * More efficient than calling tell() repeatedly.
 */
export function tellMany(
	store: ConstraintStore,
	constraints: readonly Constraint[],
): TellResult {
	if (constraints.length === 0) {
		return { store, isNew: false, affectedPaths: [] };
	}

	const mutable = cloneStore(store);
	const affectedPaths: Path[] = [];
	let anyNew = false;

	for (const constraint of constraints) {
		const key = constraintKey(constraint);

		// Skip duplicates
		if (mutable.constraints.has(key)) {
			continue;
		}

		anyNew = true;

		// Add constraint
		mutable.constraints.set(key, constraint);

		// Update path index
		const pathKey = pathToString(constraint.path);
		let pathSet = mutable.byPath.get(pathKey);
		if (pathSet === undefined) {
			pathSet = new Set();
			mutable.byPath.set(pathKey, pathSet);
		}
		pathSet.add(key);

		// Track affected paths
		affectedPaths.push(constraint.path);

		// Update version vector
		vvExtend(mutable.versionVector, constraint.id.peer, constraint.id.counter);

		// Update Lamport clock
		mutable.lamport = Math.max(mutable.lamport, constraint.metadata.lamport);
	}

	return {
		store: mutable as ConstraintStore,
		isNew: anyNew,
		affectedPaths,
	};
}

// ============================================================================
// Ask (Query Constraints)
// ============================================================================

/**
 * Ask: Get all constraints for a specific path.
 *
 * This returns constraints that apply exactly to the given path.
 *
 * @param store - The constraint store
 * @param path - The path to query
 * @returns Array of constraints for that path
 */
export function ask(store: ConstraintStore, path: Path): Constraint[] {
	const pathKey = pathToString(path);
	const constraintKeys = store.byPath.get(pathKey);

	if (constraintKeys === undefined || constraintKeys.size === 0) {
		return [];
	}

	const result: Constraint[] = [];
	for (const key of constraintKeys) {
		const constraint = store.constraints.get(key);
		if (constraint !== undefined) {
			result.push(constraint);
		}
	}

	return result;
}

/**
 * Get all constraints for a path and its descendants.
 *
 * Useful for querying all constraints under a container.
 *
 * @param store - The constraint store
 * @param prefix - The path prefix to match
 * @returns Array of constraints with paths starting with prefix
 */
export function askPrefix(store: ConstraintStore, prefix: Path): Constraint[] {
	const result: Constraint[] = [];

	for (const constraint of store.constraints.values()) {
		if (pathStartsWith(constraint.path, prefix)) {
			result.push(constraint);
		}
	}

	return result;
}

/**
 * Alias for ask() - more explicit name for path queries.
 */
export function getConstraintsForPath(
	store: ConstraintStore,
	path: Path,
): Constraint[] {
	return ask(store, path);
}

/**
 * Get all constraints in the store.
 */
export function getAllConstraints(store: ConstraintStore): Constraint[] {
	return Array.from(store.constraints.values());
}

/**
 * Get the total number of constraints.
 */
export function getConstraintCount(store: ConstraintStore): number {
	return store.constraints.size;
}

/**
 * Check if a constraint exists in the store.
 */
export function hasConstraint(store: ConstraintStore, id: OpId): boolean {
	const key = `${id.peer}@${id.counter}`;
	return store.constraints.has(key);
}

/**
 * Get a specific constraint by its OpId.
 */
export function getConstraint(
	store: ConstraintStore,
	id: OpId,
): Constraint | undefined {
	const key = `${id.peer}@${id.counter}`;
	return store.constraints.get(key);
}

// ============================================================================
// Version Vector Access
// ============================================================================

/**
 * Get the current version vector.
 */
export function getVersionVector(store: ConstraintStore): VersionVector {
	return store.versionVector;
}

/**
 * Get the current Lamport clock value.
 */
export function getLamport(store: ConstraintStore): Lamport {
	return store.lamport;
}

/**
 * Get the next Lamport value (for creating new constraints).
 */
export function getNextLamport(store: ConstraintStore): Lamport {
	return store.lamport + 1;
}

/**
 * Get the current generation counter.
 *
 * Used for cache invalidation: compare generations to detect if
 * the store has been mutated since the last cache entry.
 */
export function getGeneration(store: ConstraintStore): number {
	return store.generation;
}

// ============================================================================
// Delta Computation (for Sync)
// ============================================================================

/**
 * A delta contains constraints that one peer has but another doesn't.
 */
export interface ConstraintDelta {
	/** Constraints to send */
	constraints: Constraint[];

	/** Version vector of the sender at time of export */
	fromVV: VersionVector;
}

/**
 * Export constraints that the other peer hasn't seen.
 *
 * Computes which constraints to send based on version vector comparison.
 *
 * @param store - Our constraint store
 * @param theirVV - The other peer's version vector
 * @returns Delta containing constraints they need
 */
export function exportDelta(
	store: ConstraintStore,
	theirVV: VersionVector,
): ConstraintDelta {
	const diff = vvDiff(store.versionVector, theirVV);
	const constraints: Constraint[] = [];

	// For each peer where we have more operations
	for (const [peer, range] of diff) {
		// Find constraints from this peer in the range [start, end)
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
 * @param store - Our constraint store
 * @param delta - The delta to import
 * @returns Result with updated store
 */
export function importDelta(
	store: ConstraintStore,
	delta: ConstraintDelta,
): TellResult {
	return tellMany(store, delta.constraints);
}

// ============================================================================
// Merge Stores
// ============================================================================

/**
 * Merge two constraint stores.
 *
 * This is the CCS merge operation: set union of constraints.
 *
 * @param a - First store
 * @param b - Second store
 * @returns Merged store containing all constraints from both
 */
export function mergeStores(
	a: ConstraintStore,
	b: ConstraintStore,
): ConstraintStore {
	// Start with a copy of a
	const mutable = cloneStore(a);

	// Add all constraints from b
	for (const constraint of b.constraints.values()) {
		const key = constraintKey(constraint);

		// Skip if already present
		if (mutable.constraints.has(key)) {
			continue;
		}

		// Add constraint
		mutable.constraints.set(key, constraint);

		// Update path index
		const pathKey = pathToString(constraint.path);
		let pathSet = mutable.byPath.get(pathKey);
		if (pathSet === undefined) {
			pathSet = new Set();
			mutable.byPath.set(pathKey, pathSet);
		}
		pathSet.add(key);
	}

	// Merge version vectors
	vvMergeInto(mutable.versionVector, b.versionVector);

	// Take max Lamport
	mutable.lamport = Math.max(mutable.lamport, b.lamport);

	return mutable as ConstraintStore;
}

// ============================================================================
// Iteration
// ============================================================================

/**
 * Iterate over all unique paths that have constraints.
 */
export function* iterPaths(store: ConstraintStore): Generator<Path> {
	for (const pathKey of store.byPath.keys()) {
		yield JSON.parse(pathKey) as Path;
	}
}

/**
 * Iterate over all constraints.
 */
export function* iterConstraints(
	store: ConstraintStore,
): Generator<Constraint> {
	yield* store.constraints.values();
}

/**
 * Iterate over constraints grouped by path.
 */
export function* iterByPath(
	store: ConstraintStore,
): Generator<[Path, Constraint[]]> {
	for (const [pathKey, constraintKeys] of store.byPath) {
		const path = JSON.parse(pathKey) as Path;
		const constraints: Constraint[] = [];
		for (const key of constraintKeys) {
			const constraint = store.constraints.get(key);
			if (constraint !== undefined) {
				constraints.push(constraint);
			}
		}
		yield [path, constraints];
	}
}
