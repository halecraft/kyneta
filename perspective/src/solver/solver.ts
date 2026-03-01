/**
 * Solver Interface for Prism
 *
 * The Solver is responsible for deriving state from constraints.
 * In CCS, this is where CRDT semantics live - the solver interprets
 * constraints and computes the resulting value.
 *
 * Different container types have different solvers:
 * - MapSolver: LWW conflict resolution
 * - ListSolver: Fugue-style ordering
 * - TextSolver: Character-level list with string output
 */

import type { Constraint } from "../core/constraint.js";
import type { Path } from "../core/types.js";

// ============================================================================
// Solved Value
// ============================================================================

/**
 * The result of solving constraints for a path.
 *
 * Contains not just the value, but also information about how it was
 * determined - useful for introspection and debugging.
 */
export interface SolvedValue<T = unknown> {
	/** The resolved value (undefined if deleted or no constraints) */
	readonly value: T | undefined;

	/** The constraint that determined this value (winner) */
	readonly determinedBy: Constraint | undefined;

	/** Constraints that lost in conflict resolution */
	readonly conflicts: readonly Constraint[];

	/** Human-readable explanation of how the value was determined */
	readonly resolution: string;
}

/**
 * Create a SolvedValue indicating no value (no constraints or deleted).
 */
export function solvedEmpty<T = unknown>(): SolvedValue<T> {
	return {
		value: undefined,
		determinedBy: undefined,
		conflicts: [],
		resolution: "no constraints",
	};
}

/**
 * Create a SolvedValue from a winning constraint.
 */
export function solvedFromConstraint<T>(
	value: T,
	winner: Constraint,
	losers: readonly Constraint[],
	resolution: string,
): SolvedValue<T> {
	return {
		value,
		determinedBy: winner,
		conflicts: losers,
		resolution,
	};
}

/**
 * Create a SolvedValue for a deleted path.
 */
export function solvedDeleted<T = unknown>(
	winner: Constraint,
	losers: readonly Constraint[],
): SolvedValue<T> {
	return {
		value: undefined,
		determinedBy: winner,
		conflicts: losers,
		resolution: "deleted",
	};
}

// ============================================================================
// Solver Interface
// ============================================================================

/**
 * A Solver computes state from constraints.
 *
 * Each container type (Map, List, Text) has its own solver that understands
 * the semantics of its constraint types.
 */
export interface Solver<T = unknown> {
	/**
	 * Solve constraints to produce a value.
	 *
	 * @param constraints - All constraints relevant to this path
	 * @param path - The path being solved (for context)
	 * @returns The solved value with conflict information
	 */
	solve(constraints: readonly Constraint[], path: Path): SolvedValue<T>;
}

// ============================================================================
// Solver Utilities
// ============================================================================

/**
 * Filter constraints to only those with a specific assertion type.
 */
export function filterByAssertionType<
	A extends Constraint["assertion"]["type"],
>(constraints: readonly Constraint[], type: A): Constraint[] {
	return constraints.filter((c) => c.assertion.type === type);
}

/**
 * Check if a SolvedValue has conflicts.
 */
export function hasConflicts(solved: SolvedValue): boolean {
	return solved.conflicts.length > 0;
}

/**
 * Check if a SolvedValue represents a deleted value.
 */
export function isDeleted(solved: SolvedValue): boolean {
	return solved.value === undefined && solved.determinedBy !== undefined;
}

/**
 * Check if a SolvedValue represents no constraints (empty).
 */
export function isEmpty(solved: SolvedValue): boolean {
	return solved.value === undefined && solved.determinedBy === undefined;
}
