/**
 * Constraint Inspector for Prism
 *
 * Debug utility for visualizing and exporting constraint store state.
 * Provides tools for understanding the constraint system at a low level.
 *
 * Key capabilities:
 * - Export store to JSON for external tooling
 * - Generate human-readable summaries
 * - Analyze constraint distribution and statistics
 */

import type { Constraint } from "../core/constraint.js";
import type { Path, PeerID } from "../core/types.js";
import {
	pathToString,
	opIdToString,
} from "../core/types.js";
import type { ConstraintStore } from "../store/constraint-store.js";
import {
	getAllConstraints,
	getConstraintCount,
	getVersionVector,
	getLamport,
	getGeneration,
	iterByPath,
} from "../store/constraint-store.js";
import { vvToObject, vvTotalOps } from "../core/version-vector.js";
import { assertionToString } from "../core/assertions.js";

// ============================================================================
// Inspector Types
// ============================================================================

/**
 * JSON-serializable representation of a constraint.
 */
export interface ConstraintJSON {
	id: string;
	peer: string;
	counter: number;
	lamport: number;
	path: string;
	pathSegments: (string | number)[];
	assertionType: string;
	assertion: unknown;
	wallTime?: number;
}

/**
 * JSON-serializable snapshot of the entire store.
 */
export interface StoreSnapshot {
	/** Timestamp when snapshot was taken */
	timestamp: string;

	/** Store generation counter */
	generation: number;

	/** Current Lamport clock */
	lamport: number;

	/** Version vector as object */
	versionVector: Record<string, number>;

	/** Total number of constraints */
	constraintCount: number;

	/** All constraints in the store */
	constraints: ConstraintJSON[];

	/** Constraints grouped by path */
	byPath: Record<string, ConstraintJSON[]>;

	/** Constraints grouped by peer */
	byPeer: Record<string, ConstraintJSON[]>;
}

/**
 * Statistics about the constraint store.
 */
export interface StoreStatistics {
	/** Total number of constraints */
	totalConstraints: number;

	/** Number of unique paths */
	uniquePaths: number;

	/** Number of unique peers */
	uniquePeers: number;

	/** Current generation */
	generation: number;

	/** Current Lamport clock */
	lamport: number;

	/** Total operations in version vector */
	totalOperations: number;

	/** Constraints per assertion type */
	byAssertionType: Record<string, number>;

	/** Constraints per peer */
	byPeer: Record<string, number>;

	/** Average constraints per path */
	avgConstraintsPerPath: number;

	/** Path with most constraints */
	maxConstraintsPath: { path: string; count: number } | null;
}

/**
 * Summary line for a constraint (for display).
 */
export interface ConstraintSummaryLine {
	id: string;
	peer: string;
	lamport: number;
	path: string;
	assertion: string;
}

// ============================================================================
// Inspector Interface
// ============================================================================

/**
 * Debug inspector for examining constraint stores.
 */
export interface ConstraintInspector {
	/**
	 * Export the entire store as a JSON-serializable snapshot.
	 */
	exportSnapshot(): StoreSnapshot;

	/**
	 * Export snapshot as a JSON string.
	 *
	 * @param pretty Whether to format with indentation (default: true)
	 */
	exportJSON(pretty?: boolean): string;

	/**
	 * Get statistics about the store.
	 */
	getStatistics(): StoreStatistics;

	/**
	 * Get a list of all constraints as summary lines.
	 */
	listConstraints(): ConstraintSummaryLine[];

	/**
	 * Get constraints for a specific path as summary lines.
	 */
	listConstraintsAt(path: Path): ConstraintSummaryLine[];

	/**
	 * Get constraints from a specific peer as summary lines.
	 */
	listConstraintsFrom(peer: PeerID): ConstraintSummaryLine[];

	/**
	 * Generate a human-readable summary of the store.
	 */
	summarize(): string;

	/**
	 * Generate a detailed dump of all constraints.
	 */
	dump(): string;
}

// ============================================================================
// Inspector Implementation
// ============================================================================

/**
 * Configuration for creating an inspector.
 */
export interface InspectorConfig {
	/** Function to get the current constraint store */
	getStore: () => ConstraintStore;
}

/**
 * Create a ConstraintInspector for a store.
 */
export function createConstraintInspector(
	config: InspectorConfig,
): ConstraintInspector {
	const { getStore } = config;

	/**
	 * Convert a Constraint to JSON-serializable form.
	 */
	function toConstraintJSON(constraint: Constraint): ConstraintJSON {
		const json: ConstraintJSON = {
			id: opIdToString(constraint.id),
			peer: constraint.id.peer,
			counter: constraint.id.counter,
			lamport: constraint.metadata.lamport,
			path: pathToString(constraint.path),
			pathSegments: [...constraint.path],
			assertionType: constraint.assertion.type,
			assertion: constraint.assertion,
		};
		if (constraint.metadata.wallTime !== undefined) {
			json.wallTime = constraint.metadata.wallTime;
		}
		return json;
	}

	/**
	 * Convert a Constraint to a summary line.
	 */
	function toSummaryLine(constraint: Constraint): ConstraintSummaryLine {
		return {
			id: opIdToString(constraint.id),
			peer: constraint.id.peer,
			lamport: constraint.metadata.lamport,
			path: pathToString(constraint.path),
			assertion: assertionToString(constraint.assertion),
		};
	}

	const inspector: ConstraintInspector = {
		exportSnapshot(): StoreSnapshot {
			const store = getStore();
			const constraints = getAllConstraints(store);
			const constraintJSONs = constraints.map(toConstraintJSON);

			// Group by path
			const byPath: Record<string, ConstraintJSON[]> = {};
			for (const c of constraintJSONs) {
				if (!byPath[c.path]) {
					byPath[c.path] = [];
				}
				byPath[c.path]!.push(c);
			}

			// Group by peer
			const byPeer: Record<string, ConstraintJSON[]> = {};
			for (const c of constraintJSONs) {
				if (!byPeer[c.peer]) {
					byPeer[c.peer] = [];
				}
				byPeer[c.peer]!.push(c);
			}

			return {
				timestamp: new Date().toISOString(),
				generation: getGeneration(store),
				lamport: getLamport(store),
				versionVector: vvToObject(getVersionVector(store)),
				constraintCount: constraints.length,
				constraints: constraintJSONs,
				byPath,
				byPeer,
			};
		},

		exportJSON(pretty = true): string {
			const snapshot = inspector.exportSnapshot();
			return pretty
				? JSON.stringify(snapshot, null, 2)
				: JSON.stringify(snapshot);
		},

		getStatistics(): StoreStatistics {
			const store = getStore();
			const constraints = getAllConstraints(store);
			const vv = getVersionVector(store);

			// Count by assertion type
			const byAssertionType: Record<string, number> = {};
			const byPeer: Record<string, number> = {};
			const pathCounts = new Map<string, number>();

			for (const c of constraints) {
				// By assertion type
				const type = c.assertion.type;
				byAssertionType[type] = (byAssertionType[type] ?? 0) + 1;

				// By peer
				const peer = c.id.peer;
				byPeer[peer] = (byPeer[peer] ?? 0) + 1;

				// By path
				const pathKey = pathToString(c.path);
				pathCounts.set(pathKey, (pathCounts.get(pathKey) ?? 0) + 1);
			}

			// Find path with most constraints
			let maxConstraintsPath: { path: string; count: number } | null = null;
			for (const [path, count] of pathCounts) {
				if (!maxConstraintsPath || count > maxConstraintsPath.count) {
					maxConstraintsPath = { path, count };
				}
			}

			const uniquePaths = pathCounts.size;
			const uniquePeers = Object.keys(byPeer).length;

			return {
				totalConstraints: constraints.length,
				uniquePaths,
				uniquePeers,
				generation: getGeneration(store),
				lamport: getLamport(store),
				totalOperations: vvTotalOps(vv),
				byAssertionType,
				byPeer,
				avgConstraintsPerPath:
					uniquePaths > 0 ? constraints.length / uniquePaths : 0,
				maxConstraintsPath,
			};
		},

		listConstraints(): ConstraintSummaryLine[] {
			const store = getStore();
			const constraints = getAllConstraints(store);
			return constraints.map(toSummaryLine);
		},

		listConstraintsAt(path: Path): ConstraintSummaryLine[] {
			const store = getStore();
			const pathKey = pathToString(path);
			const constraints = getAllConstraints(store).filter(
				(c) => pathToString(c.path) === pathKey,
			);
			return constraints.map(toSummaryLine);
		},

		listConstraintsFrom(peer: PeerID): ConstraintSummaryLine[] {
			const store = getStore();
			const constraints = getAllConstraints(store).filter(
				(c) => c.id.peer === peer,
			);
			return constraints.map(toSummaryLine);
		},

		summarize(): string {
			const stats = inspector.getStatistics();
			const lines: string[] = [];

			lines.push("Constraint Store Summary");
			lines.push("========================");
			lines.push(`Total constraints: ${stats.totalConstraints}`);
			lines.push(`Unique paths: ${stats.uniquePaths}`);
			lines.push(`Unique peers: ${stats.uniquePeers}`);
			lines.push(`Generation: ${stats.generation}`);
			lines.push(`Lamport: ${stats.lamport}`);
			lines.push(`Total operations: ${stats.totalOperations}`);
			lines.push("");

			lines.push("By Assertion Type:");
			for (const [type, count] of Object.entries(stats.byAssertionType)) {
				lines.push(`  ${type}: ${count}`);
			}
			lines.push("");

			lines.push("By Peer:");
			for (const [peer, count] of Object.entries(stats.byPeer)) {
				lines.push(`  ${peer}: ${count}`);
			}
			lines.push("");

			if (stats.maxConstraintsPath) {
				lines.push(
					`Most constrained path: ${stats.maxConstraintsPath.path} (${stats.maxConstraintsPath.count} constraints)`,
				);
			}

			lines.push(
				`Average constraints per path: ${stats.avgConstraintsPerPath.toFixed(2)}`,
			);

			return lines.join("\n");
		},

		dump(): string {
			const store = getStore();
			const lines: string[] = [];

			lines.push("Constraint Store Dump");
			lines.push("=====================");
			lines.push(`Generation: ${getGeneration(store)}`);
			lines.push(`Lamport: ${getLamport(store)}`);
			lines.push(
				`Version Vector: ${JSON.stringify(vvToObject(getVersionVector(store)))}`,
			);
			lines.push("");

			lines.push("Constraints by Path:");
			lines.push("--------------------");

			for (const [path, constraints] of iterByPath(store)) {
				lines.push(`\n${pathToString(path)}:`);
				for (const c of constraints) {
					lines.push(
						`  ${opIdToString(c.id)} [lamport=${c.metadata.lamport}]: ${assertionToString(c.assertion)}`,
					);
				}
			}

			return lines.join("\n");
		},
	};

	return inspector;
}

/**
 * Quick dump of a store for debugging.
 *
 * Convenience function that creates a temporary inspector and dumps.
 */
export function dumpStore(store: ConstraintStore): string {
	const inspector = createConstraintInspector({
		getStore: () => store,
	});
	return inspector.dump();
}

/**
 * Quick summary of a store for debugging.
 *
 * Convenience function that creates a temporary inspector and summarizes.
 */
export function summarizeStore(store: ConstraintStore): string {
	const inspector = createConstraintInspector({
		getStore: () => store,
	});
	return inspector.summarize();
}

/**
 * Quick export of a store to JSON for debugging.
 *
 * Convenience function that creates a temporary inspector and exports.
 */
export function exportStoreJSON(store: ConstraintStore, pretty = true): string {
	const inspector = createConstraintInspector({
		getStore: () => store,
	});
	return inspector.exportJSON(pretty);
}
