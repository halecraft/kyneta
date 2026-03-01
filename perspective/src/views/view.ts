/**
 * View Interface for Prism
 *
 * A View is a typed projection over constraints. It provides:
 * - Computed state from constraints via a solver
 * - Subscriptions for change notifications
 * - Introspection capabilities
 *
 * Views are read-only projections. Mutations go through Handles.
 */

import type { Constraint } from "../core/constraint.js";
import type { Path } from "../core/types.js";
import type { SolvedValue } from "../solver/solver.js";

// ============================================================================
// View Change Events
// ============================================================================

/**
 * Event emitted when a view's state changes.
 */
export interface ViewChangeEvent<T> {
	/** The path this view covers */
	readonly path: Path;

	/** State before the change */
	readonly before: T | undefined;

	/** State after the change */
	readonly after: T | undefined;

	/** Constraints that were added causing this change */
	readonly addedConstraints: readonly Constraint[];

	/** The solved value with conflict information */
	readonly solved: SolvedValue<T>;
}

/**
 * Callback for view change subscriptions.
 */
export type ViewChangeCallback<T> = (event: ViewChangeEvent<T>) => void;

/**
 * Function to unsubscribe from view changes.
 */
export type Unsubscribe = () => void;

// ============================================================================
// View Interface
// ============================================================================

/**
 * A View provides a typed, read-only projection over constraints.
 *
 * @template T The type of value this view produces
 */
export interface View<T> {
	/** The path this view is rooted at */
	readonly path: Path;

	/**
	 * Get the current value.
	 *
	 * This solves constraints and returns the result.
	 * May be cached for efficiency.
	 */
	get(): T | undefined;

	/**
	 * Get the full solved value including conflict information.
	 *
	 * Use this when you need to know about conflicts or
	 * which constraint determined the value.
	 */
	getSolved(): SolvedValue<T>;

	/**
	 * Subscribe to changes in this view.
	 *
	 * The callback is invoked whenever constraints affecting this view change.
	 *
	 * @param callback Function to call on changes
	 * @returns Unsubscribe function
	 */
	subscribe(callback: ViewChangeCallback<T>): Unsubscribe;

	/**
	 * Check if this view has any conflicts.
	 */
	hasConflicts(): boolean;

	/**
	 * Get all constraints affecting this view.
	 */
	getConstraints(): readonly Constraint[];
}

// ============================================================================
// View Utilities
// ============================================================================

/**
 * Create a simple view change event.
 */
export function createViewChangeEvent<T>(
	path: Path,
	before: T | undefined,
	after: T | undefined,
	addedConstraints: readonly Constraint[],
	solved: SolvedValue<T>,
): ViewChangeEvent<T> {
	return {
		path,
		before,
		after,
		addedConstraints,
		solved,
	};
}

/**
 * Check if a view change event represents an actual change.
 *
 * Uses JSON serialization for deep equality (simple but sufficient).
 */
export function isActualChange<T>(event: ViewChangeEvent<T>): boolean {
	return JSON.stringify(event.before) !== JSON.stringify(event.after);
}
