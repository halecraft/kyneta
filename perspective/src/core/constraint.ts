/**
 * Constraint Type for Prism
 *
 * A Constraint is the fundamental unit of truth in Convergent Constraint Systems.
 * Each constraint asserts something about a path in the document.
 */

import type { Assertion } from "./assertions.js";
import { assertionEquals, assertionToString } from "./assertions.js";
import type { Lamport, OpId, Path, PeerID } from "./types.js";
import {
	createOpId,
	opIdEquals,
	opIdToString,
	pathEquals,
	pathToString,
} from "./types.js";

// ============================================================================
// Constraint Metadata
// ============================================================================

/**
 * Metadata attached to each constraint.
 *
 * Contains information about who created the constraint and when,
 * used for conflict resolution and debugging.
 */
export interface ConstraintMetadata {
	/** Peer that created this constraint */
	readonly peer: PeerID;

	/** Lamport timestamp for ordering and conflict resolution */
	readonly lamport: Lamport;

	/** Optional wall clock time (for debugging/display only, not used for ordering) */
	readonly wallTime?: number | undefined;
}

// ============================================================================
// Constraint Type
// ============================================================================

/**
 * A Constraint in the Convergent Constraint System.
 *
 * Constraints are immutable assertions about paths in the document.
 * They are identified by their OpId (peer + counter) and contain:
 * - A path they constrain
 * - An assertion about that path
 * - Metadata for conflict resolution
 */
export interface Constraint {
	/** Unique identifier for this constraint */
	readonly id: OpId;

	/** Path this constraint applies to */
	readonly path: Path;

	/** The assertion being made */
	readonly assertion: Assertion;

	/** Metadata (author, timestamp, etc.) */
	readonly metadata: ConstraintMetadata;
}

// ============================================================================
// Constraint Construction
// ============================================================================

/**
 * Create a new constraint.
 *
 * @param peer - Peer creating the constraint
 * @param counter - Counter for this peer (forms unique ID with peer)
 * @param lamport - Lamport timestamp
 * @param path - Path being constrained
 * @param assertion - The assertion about the path
 * @param wallTime - Optional wall clock time
 */
export function createConstraint(
	peer: PeerID,
	counter: number,
	lamport: Lamport,
	path: Path,
	assertion: Assertion,
	wallTime?: number,
): Constraint {
	return {
		id: createOpId(peer, counter),
		path,
		assertion,
		metadata: {
			peer,
			lamport,
			wallTime,
		},
	};
}

/**
 * Create a constraint with an explicit OpId.
 *
 * Useful when the OpId is already constructed.
 */
export function createConstraintWithId(
	id: OpId,
	lamport: Lamport,
	path: Path,
	assertion: Assertion,
	wallTime?: number,
): Constraint {
	return {
		id,
		path,
		assertion,
		metadata: {
			peer: id.peer,
			lamport,
			wallTime,
		},
	};
}

// ============================================================================
// Constraint Utilities
// ============================================================================

/**
 * Check if two constraints are equal.
 *
 * Two constraints are equal if they have the same ID, path, assertion, and lamport.
 */
export function constraintEquals(a: Constraint, b: Constraint): boolean {
	return (
		opIdEquals(a.id, b.id) &&
		pathEquals(a.path, b.path) &&
		assertionEquals(a.assertion, b.assertion) &&
		a.metadata.lamport === b.metadata.lamport
	);
}

/**
 * Check if two constraints have the same identity (same OpId).
 *
 * This is a weaker check than constraintEquals - it only checks if the
 * constraints represent the same operation, not if they have identical content.
 */
export function constraintSameId(a: Constraint, b: Constraint): boolean {
	return opIdEquals(a.id, b.id);
}

/**
 * Get a unique string key for a constraint (based on its OpId).
 *
 * Useful for storing constraints in Maps/Sets.
 */
export function constraintKey(constraint: Constraint): string {
	return opIdToString(constraint.id);
}

/**
 * Get a human-readable string representation of a constraint.
 */
export function constraintToString(constraint: Constraint): string {
	const id = opIdToString(constraint.id);
	const path = pathToString(constraint.path);
	const assertion = assertionToString(constraint.assertion);
	const lamport = constraint.metadata.lamport;
	return `Constraint(${id}, path=${path}, ${assertion}, lamport=${lamport})`;
}

// ============================================================================
// Constraint Ordering (for conflict resolution)
// ============================================================================

/**
 * Compare two constraints for LWW (Last-Writer-Wins) ordering.
 *
 * Returns:
 * - negative if a loses to b (b wins)
 * - 0 if equal (shouldn't happen with unique IDs)
 * - positive if a wins over b
 *
 * Ordering rules:
 * 1. Higher Lamport timestamp wins
 * 2. If Lamport equal, higher PeerID wins (lexicographic)
 */
export function constraintCompareLWW(a: Constraint, b: Constraint): number {
	// Higher Lamport wins
	if (a.metadata.lamport !== b.metadata.lamport) {
		return a.metadata.lamport - b.metadata.lamport;
	}

	// Tiebreaker: higher PeerID wins (lexicographic)
	if (a.metadata.peer !== b.metadata.peer) {
		return a.metadata.peer > b.metadata.peer ? 1 : -1;
	}

	// Same peer and lamport - compare by counter as final tiebreaker
	return a.id.counter - b.id.counter;
}

/**
 * Find the winning constraint using LWW semantics.
 *
 * @param constraints - Array of constraints to compare
 * @returns The winning constraint, or undefined if array is empty
 */
export function findLWWWinner(
	constraints: readonly Constraint[],
): Constraint | undefined {
	if (constraints.length === 0) return undefined;

	let winner = constraints[0]!;
	for (let i = 1; i < constraints.length; i++) {
		const candidate = constraints[i]!;
		if (constraintCompareLWW(candidate, winner) > 0) {
			winner = candidate;
		}
	}
	return winner;
}

/**
 * Partition constraints into winner and losers using LWW.
 *
 * @param constraints - Array of constraints
 * @returns Object with winner and array of losing constraints
 */
export function partitionByLWW(constraints: readonly Constraint[]): {
	winner: Constraint | undefined;
	losers: Constraint[];
} {
	if (constraints.length === 0) {
		return { winner: undefined, losers: [] };
	}

	const winner = findLWWWinner(constraints)!;
	const losers = constraints.filter((c) => !constraintSameId(c, winner));

	return { winner, losers };
}
