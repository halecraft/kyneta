/**
 * Text Handle for Prism
 *
 * A TextHandle provides a mutation API for Text containers.
 * Text is implemented as a List of single-character strings,
 * so TextHandle wraps the list operations with a string-oriented API.
 *
 * Each character in an inserted string becomes a separate `seq_element`
 * constraint, with origins chained left-to-right within the insert.
 */

import type { Constraint } from "../core/constraint.js";
import { createConstraint } from "../core/constraint.js";
import { seqElement, deleted } from "../core/assertions.js";
import type { Path, PeerID, Lamport, OpId } from "../core/types.js";
import { opIdToString, pathChild } from "../core/types.js";
import type { ConstraintStore } from "../store/constraint-store.js";
import { tell, tellMany, mergeStores } from "../store/constraint-store.js";
import type { TextView } from "../views/text-view.js";
import { createTextView } from "../views/text-view.js";
import { computeInsertOrigins, getIdAtIndex } from "../solver/fugue.js";
import type { Handle } from "./handle.js";

// ============================================================================
// Text Handle Interface
// ============================================================================

/**
 * A handle for mutating Text containers.
 *
 * Provides string-oriented operations that generate constraints.
 * Read operations delegate to the underlying TextView.
 */
export interface TextHandle extends Handle<string, TextView> {
	/**
	 * Insert text at a specific position.
	 *
	 * Each character becomes a separate `seq_element` constraint,
	 * with origins chained left-to-right.
	 *
	 * @param index The position to insert at (0 = beginning, length = end)
	 * @param text The text to insert
	 * @returns Array of generated constraints (one per character)
	 */
	insert(index: number, text: string): Constraint[];

	/**
	 * Delete characters starting at a specific position.
	 *
	 * @param index The starting position
	 * @param length Number of characters to delete
	 * @returns Array of generated constraints
	 */
	delete(index: number, length: number): Constraint[];

	/**
	 * Append text to the end.
	 *
	 * @param text The text to append
	 * @returns Array of generated constraints
	 */
	append(text: string): Constraint[];

	/**
	 * Prepend text to the beginning.
	 *
	 * @param text The text to prepend
	 * @returns Array of generated constraints
	 */
	prepend(text: string): Constraint[];

	/**
	 * Replace a range of text.
	 *
	 * @param index Starting position
	 * @param length Number of characters to replace
	 * @param text Replacement text
	 * @returns Array of generated constraints (deletes + inserts)
	 */
	replace(index: number, length: number, text: string): Constraint[];

	/**
	 * Clear all text.
	 *
	 * @returns Array of generated delete constraints
	 */
	clear(): Constraint[];

	/**
	 * Get the current text as a string.
	 *
	 * Shorthand for `view().toString()`.
	 */
	toString(): string;

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
// Text Handle Configuration
// ============================================================================

/**
 * Configuration for creating a TextHandle.
 */
export interface TextHandleConfig {
	/** The peer ID for constraint generation */
	peerId: PeerID;

	/** Initial constraint store */
	store: ConstraintStore;

	/** Path to this text container */
	path: Path;

	/** Optional initial counter (defaults to 0) */
	initialCounter?: number;

	/** Optional initial Lamport (defaults to store's lamport) */
	initialLamport?: Lamport;
}

// ============================================================================
// Text Handle Implementation
// ============================================================================

/**
 * Create a TextHandle for a constraint store.
 *
 * @param config Configuration for the handle
 * @returns A TextHandle instance
 */
export function createTextHandle(config: TextHandleConfig): TextHandle {
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

	const handle: TextHandle = {
		path,

		view(): TextView {
			return createTextView({ store, path });
		},

		get(): string | undefined {
			return handle.view().get();
		},

		toString(): string {
			return handle.view().toString();
		},

		insert(index: number, text: string): Constraint[] {
			if (text.length === 0) return [];

			const constraints: Constraint[] = [];
			const fugue = getCurrentFugueResult();

			// Compute initial origins
			const { originLeft: initialOriginLeft, originRight } = computeInsertOrigins(
				fugue,
				index,
			);

			// Chain the constraints: each new character's originLeft is the previous character
			let prevId: OpId | null = initialOriginLeft;

			// Split text into individual characters (handles Unicode correctly)
			const chars = [...text];

			for (const char of chars) {
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
					seqElement(char, prevId, originRight),
				);

				constraints.push(constraint);
				prevId = thisId;
			}

			applyConstraints(constraints);
			return constraints;
		},

		delete(index: number, length: number): Constraint[] {
			if (length <= 0) return [];

			const constraints: Constraint[] = [];
			const fugue = getCurrentFugueResult();

			// Collect all element IDs to delete first (before modifying state)
			const idsToDelete: OpId[] = [];
			for (let i = 0; i < length; i++) {
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

		append(text: string): Constraint[] {
			return handle.insert(handle.view().length(), text);
		},

		prepend(text: string): Constraint[] {
			return handle.insert(0, text);
		},

		replace(index: number, length: number, text: string): Constraint[] {
			const deleteConstraints = handle.delete(index, length);
			const insertConstraints = handle.insert(index, text);
			return [...deleteConstraints, ...insertConstraints];
		},

		clear(): Constraint[] {
			const length = handle.view().length();
			if (length === 0) return [];
			return handle.delete(0, length);
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
// Multi-Peer Text Handle Merge
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
export function mergeTextHandles(
	target: TextHandle,
	source: TextHandle,
): void {
	const merged = mergeStores(target.getStore(), source.getStore());
	target._updateStore(merged);
}
