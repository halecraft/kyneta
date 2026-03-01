/**
 * List View for Prism
 *
 * A ListView provides a typed, read-only projection over List constraints.
 * It uses the ListSolver (Fugue-based) to compute the ordered array.
 */

import type { Constraint } from "../core/constraint.js";
import type { Path } from "../core/types.js";
import type { ConstraintStore } from "../store/constraint-store.js";
import { askPrefix } from "../store/constraint-store.js";
import type { SolvedValue } from "../solver/solver.js";
import { solvedEmpty } from "../solver/solver.js";
import { solveList, type SolvedList } from "../solver/list-solver.js";
import { getNodeAtIndex, type FugueNode } from "../solver/fugue.js";
import type {
	View,
	ViewChangeCallback,
	ViewChangeEvent,
	Unsubscribe,
} from "./view.js";
import { createViewChangeEvent } from "./view.js";

// ============================================================================
// List View Interface
// ============================================================================

/**
 * A view over a List container's constraints.
 *
 * Provides typed access to list elements with ordering and conflict tracking.
 * Extends the base View interface with list-specific operations.
 */
export interface ListView<V = unknown> extends View<V[]> {
	/**
	 * Get the value at a specific index.
	 *
	 * @param index The index to look up
	 * @returns The value, or undefined if index is out of bounds
	 */
	getAt(index: number): V | undefined;

	/**
	 * Get the length of the list.
	 */
	length(): number;

	/**
	 * Check if the list is empty.
	 */
	isEmpty(): boolean;

	/**
	 * Get the first element.
	 */
	first(): V | undefined;

	/**
	 * Get the last element.
	 */
	last(): V | undefined;

	/**
	 * Convert to a plain JavaScript array.
	 */
	toArray(): V[];

	/**
	 * Iterate over all values.
	 */
	values(): IterableIterator<V>;

	/**
	 * Iterate over index-value pairs.
	 */
	entries(): IterableIterator<[number, V]>;

	/**
	 * Execute a callback for each element.
	 */
	forEach(callback: (value: V, index: number) => void): void;

	/**
	 * Map over the list.
	 */
	map<U>(callback: (value: V, index: number) => U): U[];

	/**
	 * Filter the list.
	 */
	filter(predicate: (value: V, index: number) => boolean): V[];

	/**
	 * Find an element.
	 */
	find(predicate: (value: V, index: number) => boolean): V | undefined;

	/**
	 * Find the index of an element.
	 */
	findIndex(predicate: (value: V, index: number) => boolean): number;

	/**
	 * Check if some element matches a predicate.
	 */
	some(predicate: (value: V, index: number) => boolean): boolean;

	/**
	 * Check if every element matches a predicate.
	 */
	every(predicate: (value: V, index: number) => boolean): boolean;

	/**
	 * Get the full solved list with all details.
	 */
	getSolvedList(): SolvedList;

	/**
	 * Get the number of tombstones (deleted elements).
	 */
	tombstoneCount(): number;

	/**
	 * Check if there are any concurrent insert conflicts.
	 */
	hasConcurrentInserts(): boolean;

	/**
	 * Get the FugueNode at a specific index (for advanced usage).
	 */
	getNode(index: number): FugueNode | undefined;
}

// ============================================================================
// List View Configuration
// ============================================================================

/**
 * Configuration for creating a ListView.
 */
export interface ListViewConfig {
	/** The constraint store to read from */
	store: ConstraintStore;

	/** The path to this list container */
	path: Path;
}

// ============================================================================
// Shared Implementation Core
// ============================================================================

/**
 * Core operations for list views, shared between regular and reactive views.
 * This follows the "extract shared logic" pattern to reduce duplication.
 */
interface ListViewCore<V> {
	getConstraints(): Constraint[];
	computeSolvedList(): SolvedList;
	getValue(): V[] | undefined;
}

/**
 * Create the core operations for a list view.
 */
function createListViewCore<V>(
	getStore: () => ConstraintStore,
	path: Path,
): ListViewCore<V> {
	function getConstraints(): Constraint[] {
		return askPrefix(getStore(), path);
	}

	function computeSolvedList(): SolvedList {
		return solveList(getConstraints(), path);
	}

	function getValue(): V[] | undefined {
		const solved = computeSolvedList();
		if (solved.length === 0) {
			return undefined;
		}
		return [...solved.values] as V[];
	}

	return {
		getConstraints,
		computeSolvedList,
		getValue,
	};
}

/**
 * Build the list-specific methods that are shared between view types.
 * These methods operate on a core and don't depend on reactivity.
 */
function buildListMethods<V>(
	core: ListViewCore<V>,
	subscribers: Set<ViewChangeCallback<V[]>>,
	path: Path,
): ListView<V> {
	const view: ListView<V> = {
		path,

		get(): V[] | undefined {
			return core.getValue();
		},

		getAt(index: number): V | undefined {
			const solved = core.computeSolvedList();
			if (index < 0 || index >= solved.length) {
				return undefined;
			}
			return solved.values[index] as V;
		},

		getSolved(): SolvedValue<V[]> {
			const solved = core.computeSolvedList();

			if (solved.length === 0 && solved.tombstoneCount === 0) {
				return solvedEmpty();
			}

			// Find the most recent constraint
			let determinedBy: Constraint | undefined;
			for (const node of solved.fugue.activeNodes) {
				if (
					!determinedBy ||
					node.constraint.metadata.lamport > determinedBy.metadata.lamport
				) {
					determinedBy = node.constraint;
				}
			}

			const arr = [...solved.values] as V[];

			return {
				value: arr,
				determinedBy,
				conflicts: [...solved.conflicts],
				resolution:
					solved.conflicts.length > 0
						? `list with ${solved.length} elements, ${solved.conflicts.length} concurrent inserts`
						: `list with ${solved.length} elements`,
			};
		},

		length(): number {
			return core.computeSolvedList().length;
		},

		isEmpty(): boolean {
			return core.computeSolvedList().length === 0;
		},

		first(): V | undefined {
			const solved = core.computeSolvedList();
			if (solved.length === 0) return undefined;
			return solved.values[0] as V;
		},

		last(): V | undefined {
			const solved = core.computeSolvedList();
			if (solved.length === 0) return undefined;
			return solved.values[solved.length - 1] as V;
		},

		toArray(): V[] {
			return [...core.computeSolvedList().values] as V[];
		},

		*values(): IterableIterator<V> {
			for (const value of core.computeSolvedList().values) {
				yield value as V;
			}
		},

		*entries(): IterableIterator<[number, V]> {
			const values = core.computeSolvedList().values;
			for (let i = 0; i < values.length; i++) {
				yield [i, values[i] as V];
			}
		},

		forEach(callback: (value: V, index: number) => void): void {
			const values = core.computeSolvedList().values;
			for (let i = 0; i < values.length; i++) {
				callback(values[i] as V, i);
			}
		},

		map<U>(callback: (value: V, index: number) => U): U[] {
			const values = core.computeSolvedList().values;
			const result: U[] = [];
			for (let i = 0; i < values.length; i++) {
				result.push(callback(values[i] as V, i));
			}
			return result;
		},

		filter(predicate: (value: V, index: number) => boolean): V[] {
			const values = core.computeSolvedList().values;
			const result: V[] = [];
			for (let i = 0; i < values.length; i++) {
				if (predicate(values[i] as V, i)) {
					result.push(values[i] as V);
				}
			}
			return result;
		},

		find(predicate: (value: V, index: number) => boolean): V | undefined {
			const values = core.computeSolvedList().values;
			for (let i = 0; i < values.length; i++) {
				if (predicate(values[i] as V, i)) {
					return values[i] as V;
				}
			}
			return undefined;
		},

		findIndex(predicate: (value: V, index: number) => boolean): number {
			const values = core.computeSolvedList().values;
			for (let i = 0; i < values.length; i++) {
				if (predicate(values[i] as V, i)) {
					return i;
				}
			}
			return -1;
		},

		some(predicate: (value: V, index: number) => boolean): boolean {
			return view.findIndex(predicate) !== -1;
		},

		every(predicate: (value: V, index: number) => boolean): boolean {
			const values = core.computeSolvedList().values;
			for (let i = 0; i < values.length; i++) {
				if (!predicate(values[i] as V, i)) {
					return false;
				}
			}
			return true;
		},

		getSolvedList(): SolvedList {
			return core.computeSolvedList();
		},

		tombstoneCount(): number {
			return core.computeSolvedList().tombstoneCount;
		},

		hasConcurrentInserts(): boolean {
			return core.computeSolvedList().conflicts.length > 0;
		},

		hasConflicts(): boolean {
			return view.hasConcurrentInserts();
		},

		getNode(index: number): FugueNode | undefined {
			const solved = core.computeSolvedList();
			return getNodeAtIndex(solved.fugue, index);
		},

		getConstraints(): readonly Constraint[] {
			return core.getConstraints();
		},

		subscribe(callback: ViewChangeCallback<V[]>): Unsubscribe {
			subscribers.add(callback);
			return () => {
				subscribers.delete(callback);
			};
		},
	};

	return view;
}

// ============================================================================
// List View Implementation
// ============================================================================

/**
 * Create a ListView over a constraint store.
 *
 * @param config Configuration including store and path
 * @returns A ListView instance
 */
export function createListView<V = unknown>(
	config: ListViewConfig,
): ListView<V> {
	const { store, path } = config;
	const subscribers = new Set<ViewChangeCallback<V[]>>();

	// Create core with a fixed store reference
	const core = createListViewCore<V>(() => store, path);

	return buildListMethods(core, subscribers, path);
}

// ============================================================================
// Reactive List View
// ============================================================================

/**
 * A reactive ListView that can be notified of constraint changes.
 */
export interface ReactiveListView<V = unknown> extends ListView<V> {
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
 * Create a reactive ListView that can be notified of changes.
 */
export function createReactiveListView<V = unknown>(
	config: ListViewConfig,
): ReactiveListView<V> {
	const { path } = config;
	let currentStore = config.store;
	const subscribers = new Set<ViewChangeCallback<V[]>>();

	// Create core with a dynamic store reference
	const core = createListViewCore<V>(() => currentStore, path);

	// Build the base view methods
	const baseView = buildListMethods(core, subscribers, path);

	// Initialize cached value for change detection
	let cachedValue: V[] | undefined = core.getValue();

	// Extend with reactive capabilities
	const reactiveView: ReactiveListView<V> = {
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
