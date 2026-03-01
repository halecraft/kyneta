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
 * Extends the base View interface with map-specific operations.
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
// Map View Configuration
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

// ============================================================================
// Shared Implementation Core
// ============================================================================

/**
 * Core operations for map views, shared between regular and reactive views.
 * This follows the "extract shared logic" pattern to reduce duplication.
 */
interface MapViewCore<V> {
	getConstraints(): Constraint[];
	computeSolvedMap(): SolvedMap;
	getValue(): Record<string, V> | undefined;
	getKeyConstraints(key: string): Constraint[];
}

/**
 * Create the core operations for a map view.
 */
function createMapViewCore<V>(
	getStore: () => ConstraintStore,
	path: Path,
): MapViewCore<V> {
	function getConstraints(): Constraint[] {
		return askPrefix(getStore(), path);
	}

	function computeSolvedMap(): SolvedMap {
		return solveMap(getConstraints(), path);
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

	function getKeyConstraints(key: string): Constraint[] {
		const keyPath = pathChild(path, key);
		return ask(getStore(), keyPath);
	}

	return {
		getConstraints,
		computeSolvedMap,
		getValue,
		getKeyConstraints,
	};
}

/**
 * Build the map-specific methods that are shared between view types.
 * These methods operate on a core and don't depend on reactivity.
 */
function buildMapMethods<V>(
	core: MapViewCore<V>,
	subscribers: Set<ViewChangeCallback<Record<string, V>>>,
	path: Path,
): MapView<V> {
	const view: MapView<V> = {
		path,

		get(): Record<string, V> | undefined {
			return core.getValue();
		},

		getSolved(): SolvedValue<Record<string, V>> {
			const obj = core.getValue();
			const solved = core.computeSolvedMap();

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
			const solved = core.computeSolvedMap();
			const entry = solved.entries.get(key);
			return entry?.value as V | undefined;
		},

		getKeySolved(key: string): SolvedValue<V> {
			const constraints = core.getKeyConstraints(key);
			if (constraints.length === 0) {
				return solvedEmpty<V>();
			}
			const keyPath = pathChild(path, key);
			return solveMapConstraints(constraints, keyPath) as SolvedValue<V>;
		},

		has(key: string): boolean {
			const solved = core.computeSolvedMap();
			return solved.keys.includes(key);
		},

		keys(): string[] {
			const solved = core.computeSolvedMap();
			return [...solved.keys];
		},

		entries(): Array<[string, V]> {
			const solved = core.computeSolvedMap();
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
			const solved = core.computeSolvedMap();
			return solved.keys.length;
		},

		toObject(): Record<string, V> {
			return view.get() ?? {};
		},

		getSolvedMap(): SolvedMap {
			return core.computeSolvedMap();
		},

		conflictKeys(): string[] {
			const solved = core.computeSolvedMap();
			return Array.from(solved.conflicts.keys());
		},

		hasConflicts(): boolean {
			const solved = core.computeSolvedMap();
			return solved.conflicts.size > 0;
		},

		getConstraints(): readonly Constraint[] {
			return core.getConstraints();
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
// Map View Implementation
// ============================================================================

/**
 * Create a MapView over a constraint store.
 *
 * @param config Configuration including store and path
 * @returns A MapView instance
 */
export function createMapView<V = unknown>(config: MapViewConfig): MapView<V> {
	const { store, path } = config;
	const subscribers = new Set<ViewChangeCallback<Record<string, V>>>();

	// Create core with a fixed store reference
	const core = createMapViewCore<V>(() => store, path);

	return buildMapMethods(core, subscribers, path);
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

	// Create core with a dynamic store reference
	const core = createMapViewCore<V>(() => currentStore, path);

	// Build the base view methods
	const baseView = buildMapMethods(core, subscribers, path);

	// Initialize cached value for change detection
	let cachedValue: Record<string, V> | undefined = core.getValue();

	// Extend with reactive capabilities
	const reactiveView: ReactiveMapView<V> = {
		...baseView,

		notifyConstraintsChanged(addedConstraints: Constraint[]): void {
			const before = cachedValue;
			const after = core.getValue();
			cachedValue = after;

			// Notify subscribers if value changed
			if (JSON.stringify(before) !== JSON.stringify(after)) {
				const event = createViewChangeEvent(
					path,
					before,
					after,
					addedConstraints,
					reactiveView.getSolved(),
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

	return reactiveView;
}
