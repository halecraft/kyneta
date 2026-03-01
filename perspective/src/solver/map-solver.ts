/**
 * Map Solver for Prism
 *
 * Implements Last-Writer-Wins (LWW) conflict resolution for Map containers.
 *
 * Resolution rules:
 * 1. Higher Lamport timestamp wins
 * 2. If Lamport equal, higher PeerID wins (lexicographic comparison)
 *
 * This matches Loro's MapState semantics exactly.
 */

import type { Constraint } from "../core/constraint.js";
import {
	constraintCompareLWW,
	findLWWWinner,
	partitionByLWW,
} from "../core/constraint.js";
import {
	isEqAssertion,
	isDeletedAssertion,
	type EqAssertion,
} from "../core/assertions.js";
import type { Path } from "../core/types.js";
import type { Solver, SolvedValue } from "./solver.js";
import { solvedEmpty, solvedFromConstraint, solvedDeleted } from "./solver.js";

// ============================================================================
// Map Solver
// ============================================================================

/**
 * Solver for Map containers using Last-Writer-Wins semantics.
 *
 * Handles two assertion types:
 * - `eq`: Sets a value at the path
 * - `deleted`: Marks the path as deleted
 *
 * The constraint with the highest Lamport (or highest PeerID as tiebreaker)
 * determines the final value.
 */
export interface MapSolver extends Solver<unknown> {
	solve(constraints: readonly Constraint[], path: Path): SolvedValue<unknown>;
}

/**
 * Create a Map solver with LWW conflict resolution.
 */
export function createMapSolver(): MapSolver {
	return {
		solve(
			constraints: readonly Constraint[],
			path: Path,
		): SolvedValue<unknown> {
			return solveMapConstraints(constraints, path);
		},
	};
}

/**
 * Solve Map constraints using LWW semantics.
 *
 * @param constraints - All constraints for this path
 * @param path - The path being solved (for context/debugging)
 * @returns SolvedValue with the winning value and conflict information
 */
export function solveMapConstraints(
	constraints: readonly Constraint[],
	_path: Path,
): SolvedValue<unknown> {
	// Filter to only relevant constraint types (eq and deleted)
	const relevant = constraints.filter(
		(c) => isEqAssertion(c.assertion) || isDeletedAssertion(c.assertion),
	);

	if (relevant.length === 0) {
		return solvedEmpty();
	}

	// Find the winner using LWW
	const { winner, losers } = partitionByLWW(relevant);

	if (winner === undefined) {
		return solvedEmpty();
	}

	// Check if winner is a deletion
	if (isDeletedAssertion(winner.assertion)) {
		return solvedDeleted(winner, losers);
	}

	// Winner is an eq assertion - extract the value
	if (isEqAssertion(winner.assertion)) {
		const value = (winner.assertion as EqAssertion).value;
		const resolution = formatResolution(winner, losers);
		return solvedFromConstraint(value, winner, losers, resolution);
	}

	// Should not reach here, but TypeScript needs this
	return solvedEmpty();
}

/**
 * Format a human-readable resolution explanation.
 */
function formatResolution(
	winner: Constraint,
	losers: readonly Constraint[],
): string {
	if (losers.length === 0) {
		return `single constraint from ${winner.metadata.peer}`;
	}

	const winnerLamport = winner.metadata.lamport;
	const maxLoserLamport = Math.max(...losers.map((c) => c.metadata.lamport));

	if (winnerLamport > maxLoserLamport) {
		return `LWW: lamport ${winnerLamport} > ${maxLoserLamport}`;
	}

	// Lamport was equal, peer ID was the tiebreaker
	return `LWW: peer "${winner.metadata.peer}" wins tiebreaker (lamport=${winnerLamport})`;
}

// ============================================================================
// Map-specific Query Helpers
// ============================================================================

/**
 * Result of solving a complete Map (all keys).
 */
export interface SolvedMap {
	/** Map of key to solved value */
	readonly entries: ReadonlyMap<string, SolvedValue<unknown>>;

	/** Keys that have values (not deleted) */
	readonly keys: readonly string[];

	/** All conflicts across all keys */
	readonly conflicts: ReadonlyMap<string, readonly Constraint[]>;
}

/**
 * Solve all constraints for a Map container.
 *
 * Groups constraints by their final path segment (the key) and solves each.
 *
 * @param constraints - All constraints under the Map's path
 * @param mapPath - The path to the Map container
 * @returns SolvedMap with all entries
 */
export function solveMap(
	constraints: readonly Constraint[],
	mapPath: Path,
): SolvedMap {
	// Group constraints by key (last path segment)
	const byKey = new Map<string, Constraint[]>();

	for (const constraint of constraints) {
		// Check if this constraint is directly under the map path
		if (constraint.path.length !== mapPath.length + 1) {
			continue;
		}

		// Verify path prefix matches
		let matches = true;
		for (let i = 0; i < mapPath.length; i++) {
			if (constraint.path[i] !== mapPath[i]) {
				matches = false;
				break;
			}
		}
		if (!matches) continue;

		// Get the key (last segment)
		const key = constraint.path[mapPath.length];
		if (typeof key !== "string") {
			continue; // Map keys must be strings
		}

		let keyConstraints = byKey.get(key);
		if (keyConstraints === undefined) {
			keyConstraints = [];
			byKey.set(key, keyConstraints);
		}
		keyConstraints.push(constraint);
	}

	// Solve each key
	const entries = new Map<string, SolvedValue<unknown>>();
	const keys: string[] = [];
	const conflicts = new Map<string, readonly Constraint[]>();

	for (const [key, keyConstraints] of byKey) {
		const solved = solveMapConstraints(keyConstraints, [...mapPath, key]);
		entries.set(key, solved);

		if (solved.value !== undefined) {
			keys.push(key);
		}

		if (solved.conflicts.length > 0) {
			conflicts.set(key, solved.conflicts);
		}
	}

	return {
		entries,
		keys,
		conflicts,
	};
}

/**
 * Convert a SolvedMap to a plain JavaScript object.
 *
 * Only includes keys that have values (not deleted).
 */
export function solvedMapToObject(
	solvedMap: SolvedMap,
): Record<string, unknown> {
	const result: Record<string, unknown> = {};

	for (const key of solvedMap.keys) {
		const solved = solvedMap.entries.get(key);
		if (solved?.value !== undefined) {
			result[key] = solved.value;
		}
	}

	return result;
}

/**
 * Check if a SolvedMap has any conflicts.
 */
export function solvedMapHasConflicts(solvedMap: SolvedMap): boolean {
	return solvedMap.conflicts.size > 0;
}

/**
 * Get all keys with conflicts in a SolvedMap.
 */
export function solvedMapConflictKeys(solvedMap: SolvedMap): string[] {
	return Array.from(solvedMap.conflicts.keys());
}
