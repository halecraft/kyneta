/**
 * List Solver for Prism
 *
 * Implements List container solving using the Fugue algorithm for ordering.
 *
 * The List solver:
 * 1. Collects all seq_element and deleted constraints for the list path
 * 2. Uses the Fugue tree builder to compute the correct ordering
 * 3. Returns the ordered array with conflict/tombstone information
 */

import type { Constraint } from "../core/constraint.js";
import type { Path } from "../core/types.js";
import { pathToString, pathStartsWith } from "../core/types.js";
import {
	isSeqElementAssertion,
	isDeletedAssertion,
} from "../core/assertions.js";
import type { Solver, SolvedValue } from "./solver.js";
import { solvedEmpty, solvedFromConstraint } from "./solver.js";
import { buildFugueTree, type FugueResult, type FugueNode } from "./fugue.js";

// ============================================================================
// List Solver
// ============================================================================

/**
 * Solver for List containers using Fugue-style ordering.
 *
 * Handles seq_element assertions for list elements and deleted assertions
 * for tombstones. The Fugue algorithm determines the correct interleaving
 * of concurrent insertions.
 */
export interface ListSolver extends Solver<unknown[]> {
	solve(constraints: readonly Constraint[], path: Path): SolvedValue<unknown[]>;
}

/**
 * Create a List solver with Fugue-based ordering.
 */
export function createListSolver(): ListSolver {
	return {
		solve(
			constraints: readonly Constraint[],
			path: Path,
		): SolvedValue<unknown[]> {
			return solveListConstraints(constraints, path);
		},
	};
}

/**
 * Solve List constraints using Fugue ordering.
 *
 * @param constraints - All constraints for this list (including children)
 * @param path - The path to the list container
 * @returns SolvedValue with the ordered array and conflict information
 */
export function solveListConstraints(
	constraints: readonly Constraint[],
	_path: Path,
): SolvedValue<unknown[]> {
	// Filter to only relevant constraint types (seq_element and deleted)
	const relevant = constraints.filter(
		(c) =>
			isSeqElementAssertion(c.assertion) || isDeletedAssertion(c.assertion),
	);

	if (relevant.length === 0) {
		return solvedEmpty();
	}

	// Build the Fugue tree and get ordered elements
	const fugueResult = buildFugueTree(relevant);

	if (fugueResult.activeNodes.length === 0) {
		// All elements are deleted
		if (fugueResult.allNodes.length > 0) {
			// There were elements, but all deleted
			const lastNode = fugueResult.allNodes[fugueResult.allNodes.length - 1]!;
			return {
				value: [],
				determinedBy: lastNode.constraint,
				conflicts: [],
				resolution: `list with ${fugueResult.allNodes.length} tombstones`,
			};
		}
		return solvedEmpty();
	}

	// Determine the "winning" constraint (most recent by Lamport)
	let determinedBy: Constraint | undefined;
	for (const node of fugueResult.activeNodes) {
		if (
			!determinedBy ||
			node.constraint.metadata.lamport > determinedBy.metadata.lamport
		) {
			determinedBy = node.constraint;
		}
	}

	// Collect concurrent insert conflicts (elements with same originLeft)
	const conflicts = findConcurrentInsertConflicts(fugueResult);

	const resolution = formatResolution(fugueResult, conflicts);

	return solvedFromConstraint(
		fugueResult.values as unknown[],
		determinedBy!,
		conflicts,
		resolution,
	);
}

/**
 * Find concurrent insert conflicts.
 *
 * Two inserts are concurrent if they have the same originLeft (same parent in tree).
 * This indicates they were inserted at the "same position" concurrently.
 */
function findConcurrentInsertConflicts(result: FugueResult): Constraint[] {
	const conflicts: Constraint[] = [];
	const byOriginLeft = new Map<string, FugueNode[]>();

	// Group elements by their originLeft
	for (const node of result.activeNodes) {
		const key = node.originLeft
			? `${node.originLeft.peer}@${node.originLeft.counter}`
			: "null";
		let group = byOriginLeft.get(key);
		if (!group) {
			group = [];
			byOriginLeft.set(key, group);
		}
		group.push(node);
	}

	// Any group with more than one element represents concurrent inserts
	for (const group of byOriginLeft.values()) {
		if (group.length > 1) {
			// All but the first are "losers" (they didn't get their preferred position)
			for (let i = 1; i < group.length; i++) {
				conflicts.push(group[i]!.constraint);
			}
		}
	}

	return conflicts;
}

/**
 * Format a human-readable resolution explanation.
 */
function formatResolution(
	result: FugueResult,
	conflicts: Constraint[],
): string {
	const activeCount = result.activeNodes.length;
	const tombstoneCount = result.allNodes.length - activeCount;

	let msg = `list with ${activeCount} element${activeCount !== 1 ? "s" : ""}`;

	if (tombstoneCount > 0) {
		msg += `, ${tombstoneCount} tombstone${tombstoneCount !== 1 ? "s" : ""}`;
	}

	if (conflicts.length > 0) {
		msg += `, ${conflicts.length} concurrent insert${conflicts.length !== 1 ? "s" : ""}`;
	}

	return msg;
}

// ============================================================================
// List-specific Query Helpers
// ============================================================================

/**
 * Result of solving a complete List.
 */
export interface SolvedList {
	/** Ordered array of values (active elements only) */
	readonly values: readonly unknown[];

	/** The Fugue tree result for detailed access */
	readonly fugue: FugueResult;

	/** Number of active elements */
	readonly length: number;

	/** Number of tombstones (deleted elements) */
	readonly tombstoneCount: number;

	/** Concurrent insert conflicts */
	readonly conflicts: readonly Constraint[];
}

/**
 * Solve all constraints for a List container.
 *
 * @param constraints - All constraints under the List's path
 * @param listPath - The path to the List container
 * @returns SolvedList with full details
 */
export function solveList(
	constraints: readonly Constraint[],
	listPath: Path,
): SolvedList {
	// Filter constraints that belong to this list
	// List element constraints should be direct children of the list path
	const listConstraints = constraints.filter((c) => {
		// Check if this constraint's path starts with the list path
		return pathStartsWith(c.path, listPath);
	});

	// Build the Fugue tree
	const fugue = buildFugueTree(listConstraints);

	// Find conflicts
	const conflicts = findConcurrentInsertConflicts(fugue);

	return {
		values: fugue.values,
		fugue,
		length: fugue.activeNodes.length,
		tombstoneCount: fugue.allNodes.length - fugue.activeNodes.length,
		conflicts,
	};
}

/**
 * Convert a SolvedList to a plain JavaScript array.
 */
export function solvedListToArray(solvedList: SolvedList): unknown[] {
	return [...solvedList.values];
}

/**
 * Check if a SolvedList has any concurrent insert conflicts.
 */
export function solvedListHasConflicts(solvedList: SolvedList): boolean {
	return solvedList.conflicts.length > 0;
}

/**
 * Get the value at a specific index in a SolvedList.
 */
export function solvedListGet(
	solvedList: SolvedList,
	index: number,
): unknown | undefined {
	if (index < 0 || index >= solvedList.length) {
		return undefined;
	}
	return solvedList.values[index];
}
