/**
 * Introspection API for Prism
 *
 * Provides tools for understanding why values are what they are.
 * This wraps the existing SolvedValue machinery with a user-friendly API.
 *
 * Key capabilities:
 * - explain(path): Why does this path have this value?
 * - getConstraintsFor(path): All constraints affecting a path
 * - getConflicts(): All current conflicts across all paths
 */

import type { Constraint } from "../core/constraint.js";
import type { Path, OpId } from "../core/types.js";
import { pathToString, opIdToString } from "../core/types.js";
import type { ConstraintStore } from "../store/constraint-store.js";
import {
	ask,
	askPrefix,
	getAllConstraints,
	iterByPath,
} from "../store/constraint-store.js";
import type { SolvedValue } from "../solver/solver.js";

// ============================================================================
// Explanation Types
// ============================================================================

/**
 * Detailed explanation of why a value is what it is.
 */
export interface Explanation<T = unknown> {
	/** The path being explained */
	readonly path: Path;

	/** The current value at this path */
	readonly value: T | undefined;

	/** Whether there is a value (not deleted, not empty) */
	readonly hasValue: boolean;

	/** The constraint that determined this value */
	readonly determinedBy: ConstraintInfo | undefined;

	/** Constraints that lost in conflict resolution */
	readonly conflicts: readonly ConstraintInfo[];

	/** Whether there are active conflicts */
	readonly hasConflicts: boolean;

	/** Human-readable explanation of how the value was determined */
	readonly resolution: string;

	/** All constraints that affect this path */
	readonly allConstraints: readonly ConstraintInfo[];
}

/**
 * Information about a constraint, formatted for display.
 */
export interface ConstraintInfo {
	/** The constraint's unique identifier */
	readonly id: OpId;

	/** String representation of the ID */
	readonly idString: string;

	/** The peer that created this constraint */
	readonly peer: string;

	/** The Lamport timestamp */
	readonly lamport: number;

	/** The assertion type */
	readonly assertionType: string;

	/** The asserted value (if applicable) */
	readonly value: unknown;

	/** The full path this constraint applies to */
	readonly path: Path;

	/** String representation of the path */
	readonly pathString: string;

	/** The original constraint object */
	readonly constraint: Constraint;
}

/**
 * Summary of a conflict at a path.
 */
export interface ConflictSummary {
	/** The path where the conflict exists */
	readonly path: Path;

	/** String representation of the path */
	readonly pathString: string;

	/** The winning constraint */
	readonly winner: ConstraintInfo | undefined;

	/** The losing constraints */
	readonly losers: readonly ConstraintInfo[];

	/** Number of conflicting constraints */
	readonly conflictCount: number;

	/** How the conflict was resolved */
	readonly resolution: string;
}

/**
 * Store-wide conflict report.
 */
export interface ConflictReport {
	/** All paths with conflicts */
	readonly conflictingPaths: readonly Path[];

	/** Number of paths with conflicts */
	readonly pathCount: number;

	/** Total number of conflicting constraints */
	readonly totalConflicts: number;

	/** Detailed summary for each conflicting path */
	readonly summaries: readonly ConflictSummary[];
}

// ============================================================================
// Introspection API Interface
// ============================================================================

/**
 * Introspection API for examining constraint store state.
 */
export interface IntrospectionAPI {
	/**
	 * Explain why a path has its current value.
	 *
	 * @param path The path to explain
	 * @returns Detailed explanation of the value
	 */
	explain<T>(path: Path): Explanation<T>;

	/**
	 * Get all constraints affecting a specific path.
	 *
	 * @param path The exact path to query
	 * @returns Array of constraint info objects
	 */
	getConstraintsFor(path: Path): readonly ConstraintInfo[];

	/**
	 * Get all constraints affecting a path and its descendants.
	 *
	 * @param pathPrefix The path prefix to query
	 * @returns Array of constraint info objects
	 */
	getConstraintsUnder(pathPrefix: Path): readonly ConstraintInfo[];

	/**
	 * Get all conflicts in the store.
	 *
	 * @returns Conflict report with all conflicting paths
	 */
	getConflicts(): ConflictReport;

	/**
	 * Check if a path has conflicts.
	 *
	 * @param path The path to check
	 * @returns True if there are conflicts at this path
	 */
	hasConflictsAt(path: Path): boolean;

	/**
	 * Get a formatted string representation of an explanation.
	 *
	 * @param explanation The explanation to format
	 * @returns Human-readable string
	 */
	formatExplanation<T>(explanation: Explanation<T>): string;

	/**
	 * Get a formatted string representation of a conflict report.
	 *
	 * @param report The conflict report to format
	 * @returns Human-readable string
	 */
	formatConflictReport(report: ConflictReport): string;
}

// ============================================================================
// Introspection API Implementation
// ============================================================================

/**
 * Configuration for creating an IntrospectionAPI.
 */
export interface IntrospectionConfig {
	/** Function to get the current constraint store */
	getStore: () => ConstraintStore;

	/** Function to solve constraints for a path */
	solve: <T>(path: Path) => SolvedValue<T>;
}

/**
 * Create an IntrospectionAPI for a constraint store.
 *
 * @param config Configuration including store access and solver
 * @returns IntrospectionAPI instance
 */
export function createIntrospectionAPI(
	config: IntrospectionConfig,
): IntrospectionAPI {
	const { getStore, solve } = config;

	/**
	 * Convert a Constraint to ConstraintInfo.
	 */
	function toConstraintInfo(constraint: Constraint): ConstraintInfo {
		return {
			id: constraint.id,
			idString: opIdToString(constraint.id),
			peer: constraint.metadata.peer,
			lamport: constraint.metadata.lamport,
			assertionType: constraint.assertion.type,
			value: "value" in constraint.assertion ? constraint.assertion.value : undefined,
			path: constraint.path,
			pathString: pathToString(constraint.path),
			constraint,
		};
	}

	const api: IntrospectionAPI = {
		explain<T>(path: Path): Explanation<T> {
			const store = getStore();
			const solved = solve<T>(path);
			const constraints = ask(store, path);

			return {
				path,
				value: solved.value,
				hasValue: solved.value !== undefined,
				determinedBy: solved.determinedBy
					? toConstraintInfo(solved.determinedBy)
					: undefined,
				conflicts: solved.conflicts.map(toConstraintInfo),
				hasConflicts: solved.conflicts.length > 0,
				resolution: solved.resolution,
				allConstraints: constraints.map(toConstraintInfo),
			};
		},

		getConstraintsFor(path: Path): readonly ConstraintInfo[] {
			const store = getStore();
			const constraints = ask(store, path);
			return constraints.map(toConstraintInfo);
		},

		getConstraintsUnder(pathPrefix: Path): readonly ConstraintInfo[] {
			const store = getStore();
			const constraints = askPrefix(store, pathPrefix);
			return constraints.map(toConstraintInfo);
		},

		getConflicts(): ConflictReport {
			const store = getStore();
			const summaries: ConflictSummary[] = [];
			const conflictingPaths: Path[] = [];
			let totalConflicts = 0;

			// Iterate through all paths and check for conflicts
			for (const [path, _constraints] of iterByPath(store)) {
				const solved = solve<unknown>(path);

				if (solved.conflicts.length > 0) {
					conflictingPaths.push(path);
					totalConflicts += solved.conflicts.length;

					summaries.push({
						path,
						pathString: pathToString(path),
						winner: solved.determinedBy
							? toConstraintInfo(solved.determinedBy)
							: undefined,
						losers: solved.conflicts.map(toConstraintInfo),
						conflictCount: solved.conflicts.length,
						resolution: solved.resolution,
					});
				}
			}

			return {
				conflictingPaths,
				pathCount: conflictingPaths.length,
				totalConflicts,
				summaries,
			};
		},

		hasConflictsAt(path: Path): boolean {
			const solved = solve<unknown>(path);
			return solved.conflicts.length > 0;
		},

		formatExplanation<T>(explanation: Explanation<T>): string {
			const lines: string[] = [];

			lines.push(`Path: ${pathToString(explanation.path)}`);
			lines.push(`Value: ${JSON.stringify(explanation.value)}`);
			lines.push(`Has Value: ${explanation.hasValue}`);
			lines.push("");

			if (explanation.determinedBy) {
				lines.push("Determined By:");
				lines.push(`  ID: ${explanation.determinedBy.idString}`);
				lines.push(`  Peer: ${explanation.determinedBy.peer}`);
				lines.push(`  Lamport: ${explanation.determinedBy.lamport}`);
				lines.push(`  Type: ${explanation.determinedBy.assertionType}`);
				lines.push("");
			}

			lines.push(`Resolution: ${explanation.resolution}`);
			lines.push("");

			if (explanation.hasConflicts) {
				lines.push(`Conflicts (${explanation.conflicts.length}):`);
				for (const conflict of explanation.conflicts) {
					lines.push(`  - ${conflict.idString} (${conflict.peer}, lamport=${conflict.lamport})`);
				}
				lines.push("");
			}

			lines.push(`All Constraints (${explanation.allConstraints.length}):`);
			for (const constraint of explanation.allConstraints) {
				lines.push(
					`  - ${constraint.idString}: ${constraint.assertionType}(${JSON.stringify(constraint.value)})`,
				);
			}

			return lines.join("\n");
		},

		formatConflictReport(report: ConflictReport): string {
			const lines: string[] = [];

			lines.push(`Conflict Report`);
			lines.push(`===============`);
			lines.push(`Paths with conflicts: ${report.pathCount}`);
			lines.push(`Total conflicting constraints: ${report.totalConflicts}`);
			lines.push("");

			if (report.summaries.length === 0) {
				lines.push("No conflicts found.");
			} else {
				for (const summary of report.summaries) {
					lines.push(`Path: ${summary.pathString}`);
					lines.push(`  Winner: ${summary.winner?.idString ?? "none"}`);
					lines.push(`  Losers: ${summary.losers.map((l) => l.idString).join(", ")}`);
					lines.push(`  Resolution: ${summary.resolution}`);
					lines.push("");
				}
			}

			return lines.join("\n");
		},
	};

	return api;
}

// ============================================================================
// Convenience Functions
// ============================================================================

/**
 * Create a simple explanation from a SolvedValue.
 *
 * This is a convenience function when you already have a SolvedValue
 * and just want to wrap it in an Explanation format.
 */
export function explainSolvedValue<T>(
	path: Path,
	solved: SolvedValue<T>,
	allConstraints: readonly Constraint[],
): Explanation<T> {
	function toConstraintInfo(constraint: Constraint): ConstraintInfo {
		return {
			id: constraint.id,
			idString: opIdToString(constraint.id),
			peer: constraint.metadata.peer,
			lamport: constraint.metadata.lamport,
			assertionType: constraint.assertion.type,
			value: "value" in constraint.assertion ? constraint.assertion.value : undefined,
			path: constraint.path,
			pathString: pathToString(constraint.path),
			constraint,
		};
	}

	return {
		path,
		value: solved.value,
		hasValue: solved.value !== undefined,
		determinedBy: solved.determinedBy
			? toConstraintInfo(solved.determinedBy)
			: undefined,
		conflicts: solved.conflicts.map(toConstraintInfo),
		hasConflicts: solved.conflicts.length > 0,
		resolution: solved.resolution,
		allConstraints: allConstraints.map(toConstraintInfo),
	};
}
