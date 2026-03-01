/**
 * List Handle for Prism
 *
 * A ListHandle provides a mutation API for List containers.
 * It generates seq_element constraints for insert operations and
 * deleted constraints for deletions, using the Fugue algorithm
 * to compute correct originLeft/originRight values.
 *
 * Element path convention:
 * - Each element has path: [...listPath, opIdToString(elemId)]
 * - This allows delete constraints to target specific elements
 * - Delete constraints have their own unique OpId but same path as the element
 */

import type { Constraint } from "../core/constraint.js";
import { createConstraint } from "../core/constraint.js";
import { seqElement, deleted } from "../core/assertions.js";
import type { Path, PeerID, Lamport, OpId } from "../core/types.js";
import { opIdToString, pathChild } from "../core/types.js";
import type { ConstraintStore } from "../store/constraint-store.js";
import { tell, tellMany, mergeStores } from "../store/constraint-store.js";
import type { ListView } from "../views/list-view.js";
import { createListView } from "../views/list-view.js";
import { computeInsertOrigins, getIdAtIndex } from "../solver/fugue.js";
import type { Handle } from "./handle.js";

// ============================================================================
// List Handle Interface
// ============================================================================

/**
 * A handle for mutating List containers.
 *
 * Provides insert/delete operations that generate constraints with
 * proper Fugue origins for correct interleaving.
 * Read operations delegate to the underlying ListView.
 */
export interface ListHandle<V = unknown> extends Handle<V[], ListView<V>> {
	/**
	 * Insert a value at a specific index.
	 *
	 * Generates a `seq_element` constraint with computed originLeft/originRight.
	 *
	 * @param index The index to insert at (0 = beginning, length = end)
	 * @param value The value to insert
	 * @returns The generated constraint
	 */
	insert(index: number, value: V): Constraint;

	/**
	 * Insert multiple values at a specific index.
	 *
	 * Each value gets its own constraint, with origins chained together.
	 *
	 * @param index The index to start inserting at
	 * @param values The values to insert
	 * @returns Array of generated constraints
	 */
	insertMany(index: number, values: V[]): Constraint[];

	/**
	 * Delete the element at a specific index.
	 *
	 * Generates a `deleted` constraint for the element.
	 *
	 * @param index The index of the element to delete
	 * @returns The generated constraint, or undefined if index is out of bounds
	 */
	delete(index: number): Constraint | undefined;

	/**
	 * Delete multiple elements starting at a specific index.
	 *
	 * @param index The starting index
	 * @param count Number of elements to delete
	 * @returns Array of generated constraints
	 */
	deleteRange(index: number, count: number): Constraint[];

	/**
	 * Push a value to the end of the list.
	 *
	 * @param value The value to push
	 * @returns The generated constraint
	 */
	push(value: V): Constraint;

	/**
	 * Push multiple values to the end of the list.
	 *
	 * @param values The values to push
	 * @returns Array of generated constraints
	 */
	pushMany(values: V[]): Constraint[];

	/**
	 * Insert a value at the beginning of the list.
	 *
	 * @param value The value to insert
	 * @returns The generated constraint
	 */
	unshift(value: V): Constraint;

	/**
	 * Insert multiple values at the beginning of the list.
	 *
	 * @param values The values to insert
	 * @returns Array of generated constraints
	 */
	unshiftMany(values: V[]): Constraint[];

	/**
	 * Remove and return the last element.
	 *
	 * @returns The deleted value and constraint, or undefined if empty
	 */
	pop(): { value: V; constraint: Constraint } | undefined;

	/**
	 * Remove and return the first element.
	 *
	 * @returns The deleted value and constraint, or undefined if empty
	 */
	shift(): { value: V; constraint: Constraint } | undefined;

	/**
	 * Get the current constraint store.
	 */
	getStore(): ConstraintStore;

	/**
	 * Replace the internal store (e.g. after a merge).
	 */
	_updateStore(newStore: ConstraintStore): void;
}

// ============================================================================
// List Handle Configuration
// ============================================================================

/**
 * Configuration for creating a ListHandle.
 */
export interface ListHandleConfig {
	/** The peer ID for constraint generation */
	peerId: PeerID;

	/** Initial constraint store */
	store: ConstraintStore;

	/** Path to this list container */
	path: Path;

	/** Optional initial counter (defaults to 0) */
	initialCounter?: number;

	/** Optional initial Lamport (defaults to store's lamport) */
	initialLamport?: Lamport;
}

// ============================================================================
// List Handle Implementation
// ============================================================================

/**
 * Create a ListHandle for a constraint store.
 *
 * @param config Configuration for the handle
 * @returns A ListHandle instance
 */
export function createListHandle<V = unknown>(
	config: ListHandleConfig,
): ListHandle<V> {
	const { peerId, path } = config;
	let store = config.store;
	let counter = config.initialCounter ?? 0;
	let lamport = config.initialLamport ?? store.lamport;

	function nextCounter(): number {
		return counter++;
	}

	function nextLamport(): Lamport {
		return ++lamport;
	}

	function applyConstraint(constraint: Constraint): void {
		const result = tell(store, constraint);
		store = result.store;
		lamport = Math.max(lamport, constraint.metadata.lamport);
	}

	function applyConstraints(constraints: Constraint[]): void {
		const result = tellMany(store, constraints);
		store = result.store;
		for (const c of constraints) {
			lamport = Math.max(lamport, c.metadata.lamport);
		}
	}

	/**
	 * Get the current solved state for computing origins.
	 */
	function getCurrentFugueResult() {
		const v = handle.view();
		return v.getSolvedList().fugue;
	}

	const handle: ListHandle<V> = {
		path,

		view(): ListView<V> {
			return createListView<V>({ store, path });
		},

		get(): V[] | undefined {
			return handle.view().get();
		},

		insert(index: number, value: V): Constraint {
			const fugue = getCurrentFugueResult();
			const { originLeft, originRight } = computeInsertOrigins(fugue, index);

			const thisCounter = nextCounter();
			const thisLamport = nextLamport();
			const elemId: OpId = { peer: peerId, counter: thisCounter };

			// Element path includes the element's OpId for deletion targeting
			const elemPath = pathChild(path, opIdToString(elemId));

			const constraint = createConstraint(
				peerId,
				thisCounter,
				thisLamport,
				elemPath,
				seqElement(value, originLeft, originRight),
			);

			applyConstraint(constraint);
			return constraint;
		},

		insertMany(index: number, values: V[]): Constraint[] {
			if (values.length === 0) return [];

			const constraints: Constraint[] = [];
			const fugue = getCurrentFugueResult();

			// Compute initial origins
			let { originLeft, originRight } = computeInsertOrigins(fugue, index);

			// Chain the constraints: each new element's originLeft is the previous element
			let prevId: OpId | null = originLeft;

			for (const value of values) {
				const thisCounter = nextCounter();
				const thisLamport = nextLamport();
				const thisId: OpId = { peer: peerId, counter: thisCounter };

				// Element path includes the element's OpId
				const elemPath = pathChild(path, opIdToString(thisId));

				const constraint = createConstraint(
					peerId,
					thisCounter,
					thisLamport,
					elemPath,
					seqElement(value, prevId, originRight),
				);

				constraints.push(constraint);
				prevId = thisId;
			}

			applyConstraints(constraints);
			return constraints;
		},

		delete(index: number): Constraint | undefined {
			const fugue = getCurrentFugueResult();
			const elementId = getIdAtIndex(fugue, index);

			if (!elementId) {
				return undefined;
			}

			// Create a deleted constraint at the element's path
			// The element's path is [listPath, opIdToString(elemId)]
			const elemPath = pathChild(path, opIdToString(elementId));

			const deleteConstraint = createConstraint(
				peerId,
				nextCounter(),
				nextLamport(),
				elemPath,
				deleted(),
			);

			applyConstraint(deleteConstraint);
			return deleteConstraint;
		},

		deleteRange(index: number, count: number): Constraint[] {
			const constraints: Constraint[] = [];
			const fugue = getCurrentFugueResult();

			// Collect all element IDs to delete first (before modifying state)
			const idsToDelete: OpId[] = [];
			for (let i = 0; i < count; i++) {
				const elementId = getIdAtIndex(fugue, index + i);
				if (elementId) {
					idsToDelete.push(elementId);
				}
			}

			// Create delete constraints at each element's path
			for (const elementId of idsToDelete) {
				const elemPath = pathChild(path, opIdToString(elementId));
				const deleteConstraint = createConstraint(
					peerId,
					nextCounter(),
					nextLamport(),
					elemPath,
					deleted(),
				);
				constraints.push(deleteConstraint);
			}

			if (constraints.length > 0) {
				applyConstraints(constraints);
			}

			return constraints;
		},

		push(value: V): Constraint {
			return handle.insert(handle.view().length(), value);
		},

		pushMany(values: V[]): Constraint[] {
			return handle.insertMany(handle.view().length(), values);
		},

		unshift(value: V): Constraint {
			return handle.insert(0, value);
		},

		unshiftMany(values: V[]): Constraint[] {
			return handle.insertMany(0, values);
		},

		pop(): { value: V; constraint: Constraint } | undefined {
			const v = handle.view();
			const len = v.length();
			if (len === 0) return undefined;

			const value = v.getAt(len - 1);
			const constraint = handle.delete(len - 1);

			if (value === undefined || !constraint) {
				return undefined;
			}

			return { value, constraint };
		},

		shift(): { value: V; constraint: Constraint } | undefined {
			const v = handle.view();
			const len = v.length();
			if (len === 0) return undefined;

			const value = v.getAt(0);
			const constraint = handle.delete(0);

			if (value === undefined || !constraint) {
				return undefined;
			}

			return { value, constraint };
		},

		getStore(): ConstraintStore {
			return store;
		},

		_updateStore(newStore: ConstraintStore): void {
			store = newStore;
			lamport = Math.max(lamport, newStore.lamport);
		},
	};

	return handle;
}

// ============================================================================
// Multi-Peer List Handle Merge
// ============================================================================

/**
 * Merge another handle's store into the target handle.
 *
 * This simulates syncing between two peers. The target handle's internal
 * store is updated in place to contain all constraints from both stores.
 *
 * @param target The handle to merge into (mutated)
 * @param source The handle to merge from (not mutated)
 */
export function mergeListHandles<V>(
	target: ListHandle<V>,
	source: ListHandle<V>,
): void {
	const merged = mergeStores(target.getStore(), source.getStore());
	target._updateStore(merged);
}
