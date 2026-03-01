/**
 * Map View for Prism
 *
 * A MapView provides a typed, read-only projection over Map constraints.
 * It uses the MapSolver to compute values and tracks conflicts.
 */

import type { Constraint } from "../core/constraint.js";
import type { Path } from "../core/types.js";
import { pathChild } from "../core/types.js";
import type { ConstraintStore } from "../store/constraint-store.js";
import { ask, askPrefix } from "../store/constraint-store.js";
import type { SolvedValue } from "../solver/solver.js";
import { solvedEmpty } from "../solver/solver.js";
import {
	solveMapConstraints,
	solveMap,
	type SolvedMap,
} from "../solver/map-solver.js";
import type {
	View,
	ViewChangeCallback,
	ViewChangeEvent,
	Unsubscribe,
} from "./view.js";
import { createViewChangeEvent } from "./view.js";

// ============================================================================
// Map View Interface
// ============================================================================

/**
 * A view over a Map container's constraints.
 *
 * Provides typed access to map entries with conflict tracking.
 */
export interface MapView<V = unknown> extends View<Record<string, V>> {
	/**
	 * Get the value for a specific key.
	 *
	 * @param key The key to look up
	 * @returns The value, or undefined if not set or deleted
	 */
	getKey(key: string): V | undefined;

	/**
	 * Get the full solved value for a specific key.
	 *
	 * Includes conflict information.
	 */
	getKeySolved(key: string): SolvedValue<V>;

	/**
	 * Check if a key exists (and is not deleted).
	 */
	has(key: string): boolean;

	/**
	 * Get all keys that have values (not deleted).
	 */
	keys(): string[];

	/**
	 * Get all entries as [key, value] pairs.
	 */
	entries(): Array<[string, V]>;

	/**
	 * Get the number of entries.
	 */
	size(): number;

	/**
	 * Convert to a plain JavaScript object.
	 */
	toObject(): Record<string, V>;

	/**
	 * Get the full solved map with all entries and conflicts.
	 */
	getSolvedMap(): SolvedMap;

	/**
	 * Get all keys that have conflicts.
	 */
	conflictKeys(): string[];
}

// ============================================================================
// Map View Implementation
// ============================================================================

/**
 * Configuration for creating a MapView.
 */
export interface MapViewConfig {
	/** The constraint store to read from */
	store: ConstraintStore;

	/** The path to this map container */
	path: Path;
}

/**
 * Create a MapView over a constraint store.
 *
 * @param config Configuration including store and path
 * @returns A MapView instance
 */
export function createMapView<V = unknown>(config: MapViewConfig): MapView<V> {
	const { store, path } = config;

	// Subscription management
	const subscribers = new Set<ViewChangeCallback<Record<string, V>>>();

	/**
	 * Get constraints for this map (all children of path).
	 */
	function getMapConstraints(): Constraint[] {
		return askPrefix(store, path);
	}

	/**
	 * Compute the solved map (fresh on every call).
	 */
	function computeSolvedMap(): SolvedMap {
		return solveMap(getMapConstraints(), path);
	}

	// Build the view object
	const view: MapView<V> = {
		path,

		get(): Record<string, V> | undefined {
			const solved = computeSolvedMap();
			if (solved.keys.length === 0) {
				return undefined;
			}
			const result: Record<string, V> = {};
			for (const key of solved.keys) {
				const entry = solved.entries.get(key);
				if (entry?.value !== undefined) {
					result[key] = entry.value as V;
				}
			}
			return result;
		},

		getSolved(): SolvedValue<Record<string, V>> {
			const obj = view.get();
			const solved = computeSolvedMap();

			// Aggregate conflicts from all keys
			const allConflicts: Constraint[] = [];
			for (const conflicts of solved.conflicts.values()) {
				allConflicts.push(...conflicts);
			}

			// Find the "winning" constraint (highest lamport across all keys)
			let determinedBy: Constraint | undefined;
			for (const entry of solved.entries.values()) {
				if (entry.determinedBy) {
					if (
						!determinedBy ||
						entry.determinedBy.metadata.lamport > determinedBy.metadata.lamport
					) {
						determinedBy = entry.determinedBy;
					}
				}
			}

			return {
				value: obj,
				determinedBy,
				conflicts: allConflicts,
				resolution:
					allConflicts.length > 0
						? `map with ${solved.keys.length} keys, ${allConflicts.length} conflicts`
						: `map with ${solved.keys.length} keys`,
			};
		},

		getKey(key: string): V | undefined {
			const solved = computeSolvedMap();
			const entry = solved.entries.get(key);
			return entry?.value as V | undefined;
		},

		getKeySolved(key: string): SolvedValue<V> {
			const keyPath = pathChild(path, key);
			const constraints = ask(store, keyPath);
			if (constraints.length === 0) {
				return solvedEmpty<V>();
			}
			return solveMapConstraints(constraints, keyPath) as SolvedValue<V>;
		},

		has(key: string): boolean {
			const solved = computeSolvedMap();
			return solved.keys.includes(key);
		},

		keys(): string[] {
			const solved = computeSolvedMap();
			return [...solved.keys];
		},

		entries(): Array<[string, V]> {
			const solved = computeSolvedMap();
			const result: Array<[string, V]> = [];
			for (const key of solved.keys) {
				const entry = solved.entries.get(key);
				if (entry?.value !== undefined) {
					result.push([key, entry.value as V]);
				}
			}
			return result;
		},

		size(): number {
			const solved = computeSolvedMap();
			return solved.keys.length;
		},

		toObject(): Record<string, V> {
			return view.get() ?? {};
		},

		getSolvedMap(): SolvedMap {
			return computeSolvedMap();
		},

		conflictKeys(): string[] {
			const solved = computeSolvedMap();
			return Array.from(solved.conflicts.keys());
		},

		hasConflicts(): boolean {
			const solved = computeSolvedMap();
			return solved.conflicts.size > 0;
		},

		getConstraints(): readonly Constraint[] {
			return getMapConstraints();
		},

		subscribe(callback: ViewChangeCallback<Record<string, V>>): Unsubscribe {
			subscribers.add(callback);
			return () => {
				subscribers.delete(callback);
			};
		},
	};

	return view;
}

// ============================================================================
// Reactive Map View
// ============================================================================

/**
 * A reactive MapView that automatically updates when the store changes.
 *
 * This is a factory that creates a MapView and provides methods to
 * notify it of constraint changes.
 */
export interface ReactiveMapView<V = unknown> extends MapView<V> {
	/**
	 * Notify the view that constraints have changed.
	 *
	 * This should be called after constraints are added to the store.
	 * It will recompute the state and notify subscribers if changed.
	 */
	notifyConstraintsChanged(addedConstraints: Constraint[]): void;

	/**
	 * Update the store reference.
	 *
	 * Used when the store is replaced (immutable update pattern).
	 */
	updateStore(newStore: ConstraintStore): void;
}

/**
 * Create a reactive MapView that can be notified of changes.
 */
export function createReactiveMapView<V = unknown>(
	config: MapViewConfig,
): ReactiveMapView<V> {
	const { path } = config;
	let currentStore = config.store;
	const subscribers = new Set<ViewChangeCallback<Record<string, V>>>();

	let cachedValue: Record<string, V> | undefined = undefined;

	function getMapConstraints(): Constraint[] {
		return askPrefix(currentStore, path);
	}

	function computeSolvedMap(): SolvedMap {
		return solveMap(getMapConstraints(), path);
	}

	function getValue(): Record<string, V> | undefined {
		const solved = computeSolvedMap();
		if (solved.keys.length === 0) {
			return undefined;
		}
		const result: Record<string, V> = {};
		for (const key of solved.keys) {
			const entry = solved.entries.get(key);
			if (entry?.value !== undefined) {
				result[key] = entry.value as V;
			}
		}
		return result;
	}

	const view: ReactiveMapView<V> = {
		path,

		get(): Record<string, V> | undefined {
			return getValue();
		},

		getSolved(): SolvedValue<Record<string, V>> {
			const solved = computeSolvedMap();
			const obj = getValue();

			const allConflicts: Constraint[] = [];
			for (const conflicts of solved.conflicts.values()) {
				allConflicts.push(...conflicts);
			}

			let determinedBy: Constraint | undefined;
			for (const entry of solved.entries.values()) {
				if (entry.determinedBy) {
					if (
						!determinedBy ||
						entry.determinedBy.metadata.lamport > determinedBy.metadata.lamport
					) {
						determinedBy = entry.determinedBy;
					}
				}
			}

			return {
				value: obj,
				determinedBy,
				conflicts: allConflicts,
				resolution:
					allConflicts.length > 0
						? `map with ${solved.keys.length} keys, ${allConflicts.length} conflicts`
						: `map with ${solved.keys.length} keys`,
			};
		},

		getKey(key: string): V | undefined {
			const solved = computeSolvedMap();
			const entry = solved.entries.get(key);
			return entry?.value as V | undefined;
		},

		getKeySolved(key: string): SolvedValue<V> {
			const keyPath = pathChild(path, key);
			const constraints = ask(currentStore, keyPath);
			if (constraints.length === 0) {
				return solvedEmpty<V>();
			}
			return solveMapConstraints(constraints, keyPath) as SolvedValue<V>;
		},

		has(key: string): boolean {
			const solved = computeSolvedMap();
			return solved.keys.includes(key);
		},

		keys(): string[] {
			const solved = computeSolvedMap();
			return [...solved.keys];
		},

		entries(): Array<[string, V]> {
			const solved = computeSolvedMap();
			const result: Array<[string, V]> = [];
			for (const key of solved.keys) {
				const entry = solved.entries.get(key);
				if (entry?.value !== undefined) {
					result.push([key, entry.value as V]);
				}
			}
			return result;
		},

		size(): number {
			const solved = computeSolvedMap();
			return solved.keys.length;
		},

		toObject(): Record<string, V> {
			return view.get() ?? {};
		},

		getSolvedMap(): SolvedMap {
			return computeSolvedMap();
		},

		conflictKeys(): string[] {
			const solved = computeSolvedMap();
			return Array.from(solved.conflicts.keys());
		},

		hasConflicts(): boolean {
			const solved = computeSolvedMap();
			return solved.conflicts.size > 0;
		},

		getConstraints(): readonly Constraint[] {
			return getMapConstraints();
		},

		subscribe(callback: ViewChangeCallback<Record<string, V>>): Unsubscribe {
			subscribers.add(callback);
			return () => {
				subscribers.delete(callback);
			};
		},

		notifyConstraintsChanged(addedConstraints: Constraint[]): void {
			const before = cachedValue;
			const after = getValue();
			cachedValue = after;

			// Notify subscribers if value changed
			if (JSON.stringify(before) !== JSON.stringify(after)) {
				const event = createViewChangeEvent(
					path,
					before,
					after,
					addedConstraints,
					view.getSolved(),
				);
				for (const callback of subscribers) {
					callback(event);
				}
			}
		},

		updateStore(newStore: ConstraintStore): void {
			currentStore = newStore;
		},
	};

	// Initialize cached value for change detection in reactive view
	cachedValue = getValue();

	return view;
}
