/**
 * Subscription Manager for Prism
 *
 * Centralized subscription registry that coordinates event delivery
 * across the constraint system. Handles:
 * - Store-level constraint change events
 * - Path-specific state change events
 * - Conflict events (new conflicts, resolved conflicts)
 *
 * This provides a unified event system that can be wired to individual
 * views or used directly for store-wide observation.
 */

import type { Constraint } from "../core/constraint.js";
import type { Path } from "../core/types.js";
import { pathToString, pathStartsWith } from "../core/types.js";
import type { ConstraintStore } from "../store/constraint-store.js";
import type { SolvedValue } from "../solver/solver.js";

// ============================================================================
// Event Types
// ============================================================================

/**
 * Event emitted when constraints are added to the store.
 */
export interface ConstraintAddedEvent {
	readonly type: "constraint_added";

	/** The constraints that were added */
	readonly constraints: readonly Constraint[];

	/** Paths affected by these constraints */
	readonly affectedPaths: readonly Path[];

	/** The store generation after this change */
	readonly generation: number;
}

/**
 * Event emitted when state at a path changes.
 */
export interface StateChangedEvent<T = unknown> {
	readonly type: "state_changed";

	/** The path that changed */
	readonly path: Path;

	/** State before the change */
	readonly before: T | undefined;

	/** State after the change */
	readonly after: T | undefined;

	/** Constraints that caused this change */
	readonly causingConstraints: readonly Constraint[];

	/** Full solved value with conflict info */
	readonly solved: SolvedValue<T>;
}

/**
 * Event emitted when a conflict is detected or resolved.
 */
export interface ConflictEvent {
	readonly type: "conflict_detected" | "conflict_resolved";

	/** The path where the conflict exists */
	readonly path: Path;

	/** The winning constraint */
	readonly winner: Constraint | undefined;

	/** The losing constraints (conflicts) */
	readonly losers: readonly Constraint[];

	/** How the conflict was resolved */
	readonly resolution: string;
}

/**
 * Union of all event types.
 */
export type SubscriptionEvent =
	| ConstraintAddedEvent
	| StateChangedEvent
	| ConflictEvent;

// ============================================================================
// Callback Types
// ============================================================================

/**
 * Callback for constraint-level events.
 */
export type ConstraintCallback = (event: ConstraintAddedEvent) => void;

/**
 * Callback for state change events.
 */
export type StateChangeCallback<T = unknown> = (
	event: StateChangedEvent<T>,
) => void;

/**
 * Callback for conflict events.
 */
export type ConflictCallback = (event: ConflictEvent) => void;

/**
 * Function to unsubscribe.
 */
export type Unsubscribe = () => void;

// ============================================================================
// Subscription Manager Interface
// ============================================================================

/**
 * Manages subscriptions for constraint and state change events.
 *
 * The SubscriptionManager provides a centralized registry for event
 * subscriptions. It's designed to be used by a coordinator (like PrismDoc)
 * that notifies it when constraints change.
 */
export interface SubscriptionManager {
	/**
	 * Subscribe to all constraint additions.
	 *
	 * Callback fires whenever constraints are added to the store.
	 */
	onConstraintAdded(callback: ConstraintCallback): Unsubscribe;

	/**
	 * Subscribe to state changes at a specific path.
	 *
	 * Callback fires when the solved value at the path changes.
	 *
	 * @param path The path to watch
	 * @param callback Function to call on changes
	 */
	onStateChanged<T>(path: Path, callback: StateChangeCallback<T>): Unsubscribe;

	/**
	 * Subscribe to state changes at a path and all its descendants.
	 *
	 * Callback fires when any path starting with the prefix changes.
	 *
	 * @param pathPrefix The path prefix to watch
	 * @param callback Function to call on changes
	 */
	onStateChangedPrefix<T>(
		pathPrefix: Path,
		callback: StateChangeCallback<T>,
	): Unsubscribe;

	/**
	 * Subscribe to conflict events.
	 *
	 * Callback fires when conflicts are detected or resolved.
	 */
	onConflict(callback: ConflictCallback): Unsubscribe;

	/**
	 * Notify the manager that constraints were added.
	 *
	 * This should be called by the store coordinator after constraints
	 * are added. The manager will compute affected paths and emit events.
	 *
	 * @param constraints The constraints that were added
	 * @param store The current store state
	 * @param computeState Function to compute state for a path
	 * @param previousStates Optional map of previous states for diff computation
	 */
	notifyConstraintsAdded(
		constraints: readonly Constraint[],
		store: ConstraintStore,
		computeState: <T>(path: Path) => SolvedValue<T>,
		previousStates?: ReadonlyMap<string, SolvedValue<unknown>>,
	): void;

	/**
	 * Get the number of active subscriptions.
	 */
	getSubscriptionCount(): {
		constraint: number;
		state: number;
		statePrefix: number;
		conflict: number;
	};

	/**
	 * Remove all subscriptions.
	 */
	clear(): void;
}

// ============================================================================
// Subscription Manager Implementation
// ============================================================================

/**
 * Internal subscription entry for path-specific subscriptions.
 */
interface PathSubscription<T> {
	path: Path;
	pathKey: string;
	callback: StateChangeCallback<T>;
}

/**
 * Internal subscription entry for prefix subscriptions.
 */
interface PrefixSubscription<T> {
	prefix: Path;
	callback: StateChangeCallback<T>;
}

/**
 * Create a new SubscriptionManager.
 */
export function createSubscriptionManager(): SubscriptionManager {
	// Subscription registries
	const constraintCallbacks = new Set<ConstraintCallback>();
	const stateCallbacks = new Map<string, Set<StateChangeCallback<unknown>>>();
	const prefixCallbacks: PrefixSubscription<unknown>[] = [];
	const conflictCallbacks = new Set<ConflictCallback>();

	// Track previous conflict states for detecting resolved conflicts
	const previousConflicts = new Map<string, readonly Constraint[]>();

	const manager: SubscriptionManager = {
		onConstraintAdded(callback: ConstraintCallback): Unsubscribe {
			constraintCallbacks.add(callback);
			return () => {
				constraintCallbacks.delete(callback);
			};
		},

		onStateChanged<T>(
			path: Path,
			callback: StateChangeCallback<T>,
		): Unsubscribe {
			const pathKey = pathToString(path);
			let callbacks = stateCallbacks.get(pathKey);
			if (!callbacks) {
				callbacks = new Set();
				stateCallbacks.set(pathKey, callbacks);
			}
			callbacks.add(callback as StateChangeCallback<unknown>);

			return () => {
				const cbs = stateCallbacks.get(pathKey);
				if (cbs) {
					cbs.delete(callback as StateChangeCallback<unknown>);
					if (cbs.size === 0) {
						stateCallbacks.delete(pathKey);
					}
				}
			};
		},

		onStateChangedPrefix<T>(
			pathPrefix: Path,
			callback: StateChangeCallback<T>,
		): Unsubscribe {
			const subscription: PrefixSubscription<unknown> = {
				prefix: pathPrefix,
				callback: callback as StateChangeCallback<unknown>,
			};
			prefixCallbacks.push(subscription);

			return () => {
				const index = prefixCallbacks.indexOf(subscription);
				if (index !== -1) {
					prefixCallbacks.splice(index, 1);
				}
			};
		},

		onConflict(callback: ConflictCallback): Unsubscribe {
			conflictCallbacks.add(callback);
			return () => {
				conflictCallbacks.delete(callback);
			};
		},

		notifyConstraintsAdded(
			constraints: readonly Constraint[],
			store: ConstraintStore,
			computeState: <T>(path: Path) => SolvedValue<T>,
			previousStates?: ReadonlyMap<string, SolvedValue<unknown>>,
		): void {
			if (constraints.length === 0) return;

			// Collect affected paths
			const affectedPathsSet = new Set<string>();
			const affectedPaths: Path[] = [];

			for (const constraint of constraints) {
				const pathKey = pathToString(constraint.path);
				if (!affectedPathsSet.has(pathKey)) {
					affectedPathsSet.add(pathKey);
					affectedPaths.push(constraint.path);
				}
			}

			// Emit constraint added event
			const constraintEvent: ConstraintAddedEvent = {
				type: "constraint_added",
				constraints,
				affectedPaths,
				generation: store.generation,
			};

			for (const callback of constraintCallbacks) {
				callback(constraintEvent);
			}

			// Emit state change events for affected paths
			for (const path of affectedPaths) {
				const pathKey = pathToString(path);
				const solved = computeState<unknown>(path);

				// Get previous state if available
				const previousSolved = previousStates?.get(pathKey);
				const before = previousSolved?.value;
				const after = solved.value;

				// Only emit if value actually changed
				if (!valuesEqual(before, after)) {
					const stateEvent: StateChangedEvent<unknown> = {
						type: "state_changed",
						path,
						before,
						after,
						causingConstraints: constraints.filter(
							(c) => pathToString(c.path) === pathKey,
						),
						solved,
					};

					// Exact path matches
					const exactCallbacks = stateCallbacks.get(pathKey);
					if (exactCallbacks) {
						for (const callback of exactCallbacks) {
							callback(stateEvent);
						}
					}

					// Prefix matches
					for (const { prefix, callback } of prefixCallbacks) {
						if (pathStartsWith(path, prefix)) {
							callback(stateEvent);
						}
					}
				}

				// Check for conflict changes
				const previousPathConflicts = previousConflicts.get(pathKey) ?? [];
				const currentConflicts = solved.conflicts;

				// Detect new conflicts
				if (
					currentConflicts.length > 0 &&
					previousPathConflicts.length === 0
				) {
					const conflictEvent: ConflictEvent = {
						type: "conflict_detected",
						path,
						winner: solved.determinedBy,
						losers: currentConflicts,
						resolution: solved.resolution,
					};

					for (const callback of conflictCallbacks) {
						callback(conflictEvent);
					}
				}

				// Detect resolved conflicts
				if (
					currentConflicts.length === 0 &&
					previousPathConflicts.length > 0
				) {
					const conflictEvent: ConflictEvent = {
						type: "conflict_resolved",
						path,
						winner: solved.determinedBy,
						losers: [],
						resolution: solved.resolution,
					};

					for (const callback of conflictCallbacks) {
						callback(conflictEvent);
					}
				}

				// Update conflict tracking
				if (currentConflicts.length > 0) {
					previousConflicts.set(pathKey, currentConflicts);
				} else {
					previousConflicts.delete(pathKey);
				}
			}
		},

		getSubscriptionCount(): {
			constraint: number;
			state: number;
			statePrefix: number;
			conflict: number;
		} {
			let stateCount = 0;
			for (const callbacks of stateCallbacks.values()) {
				stateCount += callbacks.size;
			}

			return {
				constraint: constraintCallbacks.size,
				state: stateCount,
				statePrefix: prefixCallbacks.length,
				conflict: conflictCallbacks.size,
			};
		},

		clear(): void {
			constraintCallbacks.clear();
			stateCallbacks.clear();
			prefixCallbacks.length = 0;
			conflictCallbacks.clear();
			previousConflicts.clear();
		},
	};

	return manager;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Compare two values for equality.
 *
 * Uses JSON serialization for deep equality. Simple but sufficient
 * for JSON-compatible values.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === undefined || b === undefined) return false;
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Create a ConstraintAddedEvent.
 */
export function createConstraintAddedEvent(
	constraints: readonly Constraint[],
	affectedPaths: readonly Path[],
	generation: number,
): ConstraintAddedEvent {
	return {
		type: "constraint_added",
		constraints,
		affectedPaths,
		generation,
	};
}

/**
 * Create a StateChangedEvent.
 */
export function createStateChangedEvent<T>(
	path: Path,
	before: T | undefined,
	after: T | undefined,
	causingConstraints: readonly Constraint[],
	solved: SolvedValue<T>,
): StateChangedEvent<T> {
	return {
		type: "state_changed",
		path,
		before,
		after,
		causingConstraints,
		solved,
	};
}

/**
 * Create a ConflictEvent.
 */
export function createConflictEvent(
	type: "conflict_detected" | "conflict_resolved",
	path: Path,
	winner: Constraint | undefined,
	losers: readonly Constraint[],
	resolution: string,
): ConflictEvent {
	return {
		type,
		path,
		winner,
		losers,
		resolution,
	};
}
