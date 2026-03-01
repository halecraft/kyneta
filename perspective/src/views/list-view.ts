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
 */
export interface ListView<V = unknown> {
	/** The path this view is rooted at */
	readonly path: Path;

	/**
	 * Get the full solved value including conflict information.
	 */
	getSolved(): SolvedValue<V[]>;

	/**
	 * Subscribe to changes in this view.
	 */
	subscribe(callback: ViewChangeCallback<V[]>): Unsubscribe;

	/**
	 * Check if this view has any conflicts.
	 */
	hasConflicts(): boolean;

	/**
	 * Get all constraints affecting this view.
	 */
	getConstraints(): readonly Constraint[];

	/**
	 * Get the value at a specific index.
	 *
	 * @param index The index to look up
	 * @returns The value, or undefined if index is out of bounds
	 */
	get(index: number): V | undefined;

	/**
	 * Get the full array value.
	 *
	 * @returns The ordered array of values, or undefined if empty
	 */
	getArray(): V[] | undefined;

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
// List View Implementation
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

	// Subscription management
	const subscribers = new Set<ViewChangeCallback<V[]>>();

	/**
	 * Get constraints for this list (all children of path).
	 */
	function getListConstraints(): Constraint[] {
		return askPrefix(store, path);
	}

	/**
	 * Compute the solved list (fresh on every call).
	 */
	function computeSolvedList(): SolvedList {
		return solveList(getListConstraints(), path);
	}

	// Build the view object
	const view: ListView<V> = {
		path,

		get(index: number): V | undefined {
			const solved = computeSolvedList();
			if (index < 0 || index >= solved.length) {
				return undefined;
			}
			return solved.values[index] as V;
		},

		getArray(): V[] | undefined {
			const solved = computeSolvedList();
			if (solved.length === 0) {
				return undefined;
			}
			return [...solved.values] as V[];
		},

		getSolved(): SolvedValue<V[]> {
			const solved = computeSolvedList();

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
			return computeSolvedList().length;
		},

		isEmpty(): boolean {
			return computeSolvedList().length === 0;
		},

		first(): V | undefined {
			const solved = computeSolvedList();
			if (solved.length === 0) return undefined;
			return solved.values[0] as V;
		},

		last(): V | undefined {
			const solved = computeSolvedList();
			if (solved.length === 0) return undefined;
			return solved.values[solved.length - 1] as V;
		},

		toArray(): V[] {
			return [...computeSolvedList().values] as V[];
		},

		*values(): IterableIterator<V> {
			for (const value of computeSolvedList().values) {
				yield value as V;
			}
		},

		*entries(): IterableIterator<[number, V]> {
			const values = computeSolvedList().values;
			for (let i = 0; i < values.length; i++) {
				yield [i, values[i] as V];
			}
		},

		forEach(callback: (value: V, index: number) => void): void {
			const values = computeSolvedList().values;
			for (let i = 0; i < values.length; i++) {
				callback(values[i] as V, i);
			}
		},

		map<U>(callback: (value: V, index: number) => U): U[] {
			const values = computeSolvedList().values;
			const result: U[] = [];
			for (let i = 0; i < values.length; i++) {
				result.push(callback(values[i] as V, i));
			}
			return result;
		},

		filter(predicate: (value: V, index: number) => boolean): V[] {
			const values = computeSolvedList().values;
			const result: V[] = [];
			for (let i = 0; i < values.length; i++) {
				if (predicate(values[i] as V, i)) {
					result.push(values[i] as V);
				}
			}
			return result;
		},

		find(predicate: (value: V, index: number) => boolean): V | undefined {
			const values = computeSolvedList().values;
			for (let i = 0; i < values.length; i++) {
				if (predicate(values[i] as V, i)) {
					return values[i] as V;
				}
			}
			return undefined;
		},

		findIndex(predicate: (value: V, index: number) => boolean): number {
			const values = computeSolvedList().values;
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
			const values = computeSolvedList().values;
			for (let i = 0; i < values.length; i++) {
				if (!predicate(values[i] as V, i)) {
					return false;
				}
			}
			return true;
		},

		getSolvedList(): SolvedList {
			return computeSolvedList();
		},

		tombstoneCount(): number {
			return computeSolvedList().tombstoneCount;
		},

		hasConcurrentInserts(): boolean {
			return computeSolvedList().conflicts.length > 0;
		},

		hasConflicts(): boolean {
			return view.hasConcurrentInserts();
		},

		getNode(index: number): FugueNode | undefined {
			const solved = computeSolvedList();
			return getNodeAtIndex(solved.fugue, index);
		},

		getConstraints(): readonly Constraint[] {
			return getListConstraints();
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

	let cachedValue: V[] | undefined = undefined;

	function getListConstraints(): Constraint[] {
		return askPrefix(currentStore, path);
	}

	function computeSolvedList(): SolvedList {
		return solveList(getListConstraints(), path);
	}

	function getValue(): V[] | undefined {
		const solved = computeSolvedList();
		if (solved.length === 0) {
			return undefined;
		}
		return [...solved.values] as V[];
	}

	const view: ReactiveListView<V> = {
		path,

		get(index: number): V | undefined {
			const solved = computeSolvedList();
			if (index < 0 || index >= solved.length) {
				return undefined;
			}
			return solved.values[index] as V;
		},

		getArray(): V[] | undefined {
			return getValue();
		},

		getSolved(): SolvedValue<V[]> {
			const solved = computeSolvedList();

			if (solved.length === 0 && solved.tombstoneCount === 0) {
				return solvedEmpty();
			}

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
			return computeSolvedList().length;
		},

		isEmpty(): boolean {
			return computeSolvedList().length === 0;
		},

		first(): V | undefined {
			const solved = computeSolvedList();
			if (solved.length === 0) return undefined;
			return solved.values[0] as V;
		},

		last(): V | undefined {
			const solved = computeSolvedList();
			if (solved.length === 0) return undefined;
			return solved.values[solved.length - 1] as V;
		},

		toArray(): V[] {
			return [...computeSolvedList().values] as V[];
		},

		*values(): IterableIterator<V> {
			for (const value of computeSolvedList().values) {
				yield value as V;
			}
		},

		*entries(): IterableIterator<[number, V]> {
			const values = computeSolvedList().values;
			for (let i = 0; i < values.length; i++) {
				yield [i, values[i] as V];
			}
		},

		forEach(callback: (value: V, index: number) => void): void {
			const values = computeSolvedList().values;
			for (let i = 0; i < values.length; i++) {
				callback(values[i] as V, i);
			}
		},

		map<U>(callback: (value: V, index: number) => U): U[] {
			const values = computeSolvedList().values;
			const result: U[] = [];
			for (let i = 0; i < values.length; i++) {
				result.push(callback(values[i] as V, i));
			}
			return result;
		},

		filter(predicate: (value: V, index: number) => boolean): V[] {
			const values = computeSolvedList().values;
			const result: V[] = [];
			for (let i = 0; i < values.length; i++) {
				if (predicate(values[i] as V, i)) {
					result.push(values[i] as V);
				}
			}
			return result;
		},

		find(predicate: (value: V, index: number) => boolean): V | undefined {
			const values = computeSolvedList().values;
			for (let i = 0; i < values.length; i++) {
				if (predicate(values[i] as V, i)) {
					return values[i] as V;
				}
			}
			return undefined;
		},

		findIndex(predicate: (value: V, index: number) => boolean): number {
			const values = computeSolvedList().values;
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
			const values = computeSolvedList().values;
			for (let i = 0; i < values.length; i++) {
				if (!predicate(values[i] as V, i)) {
					return false;
				}
			}
			return true;
		},

		getSolvedList(): SolvedList {
			return computeSolvedList();
		},

		tombstoneCount(): number {
			return computeSolvedList().tombstoneCount;
		},

		hasConcurrentInserts(): boolean {
			return computeSolvedList().conflicts.length > 0;
		},

		hasConflicts(): boolean {
			return view.hasConcurrentInserts();
		},

		getNode(index: number): FugueNode | undefined {
			const solved = computeSolvedList();
			return getNodeAtIndex(solved.fugue, index);
		},

		getConstraints(): readonly Constraint[] {
			return getListConstraints();
		},

		subscribe(callback: ViewChangeCallback<V[]>): Unsubscribe {
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
