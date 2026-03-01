/**
 * Map Handle for Prism
 *
 * A MapHandle provides a mutation API for Map containers.
 * It generates constraints for set/delete operations and
 * provides access to a MapView for reading.
 */

import type { Constraint } from "../core/constraint.js";
import { createConstraint } from "../core/constraint.js";
import { eq, deleted } from "../core/assertions.js";
import type { Path, PeerID, Lamport } from "../core/types.js";
import { pathChild } from "../core/types.js";
import type { ConstraintStore } from "../store/constraint-store.js";
import { tell, tellMany, mergeStores } from "../store/constraint-store.js";
import type { MapView } from "../views/map-view.js";
import { createMapView } from "../views/map-view.js";
import type { Handle } from "./handle.js";

// ============================================================================
// Map Handle Interface
// ============================================================================

/**
 * A handle for mutating Map containers.
 *
 * Provides set/delete operations that generate constraints.
 * Read operations delegate to the underlying MapView.
 */
export interface MapHandle<V = unknown>
	extends Handle<Record<string, V>, MapView<V>> {
	/**
	 * Set a key to a value.
	 *
	 * Generates an `eq` constraint for the key.
	 *
	 * @param key The key to set
	 * @param value The value to set
	 * @returns The generated constraint
	 */
	set(key: string, value: V): Constraint;

	/**
	 * Delete a key.
	 *
	 * Generates a `deleted` constraint for the key.
	 *
	 * @param key The key to delete
	 * @returns The generated constraint
	 */
	delete(key: string): Constraint;

	/**
	 * Set multiple key-value pairs at once.
	 *
	 * More efficient than calling set() repeatedly.
	 *
	 * @param entries Object or array of [key, value] pairs
	 * @returns Array of generated constraints
	 */
	setMany(entries: Record<string, V> | Array<[string, V]>): Constraint[];

	/**
	 * Delete multiple keys at once.
	 *
	 * @param keys Keys to delete
	 * @returns Array of generated constraints
	 */
	deleteMany(keys: string[]): Constraint[];

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
// Map Handle Configuration
// ============================================================================

/**
 * Configuration for creating a MapHandle.
 */
export interface MapHandleConfig {
	/** The peer ID for constraint generation */
	peerId: PeerID;

	/** Initial constraint store */
	store: ConstraintStore;

	/** Path to this map container */
	path: Path;

	/** Optional initial counter (defaults to 0) */
	initialCounter?: number;

	/** Optional initial Lamport (defaults to store's lamport) */
	initialLamport?: Lamport;
}

// ============================================================================
// Map Handle Implementation
// ============================================================================

/**
 * Create a MapHandle for a constraint store.
 *
 * @param config Configuration for the handle
 * @returns A MapHandle instance
 */
export function createMapHandle<V = unknown>(
	config: MapHandleConfig,
): MapHandle<V> {
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

	const handle: MapHandle<V> = {
		path,

		view(): MapView<V> {
			return createMapView<V>({ store, path });
		},

		get(): Record<string, V> | undefined {
			return handle.view().get();
		},

		set(key: string, value: V): Constraint {
			const keyPath = pathChild(path, key);
			const constraint = createConstraint(
				peerId,
				nextCounter(),
				nextLamport(),
				keyPath,
				eq(value),
			);
			applyConstraint(constraint);
			return constraint;
		},

		delete(key: string): Constraint {
			const keyPath = pathChild(path, key);
			const constraint = createConstraint(
				peerId,
				nextCounter(),
				nextLamport(),
				keyPath,
				deleted(),
			);
			applyConstraint(constraint);
			return constraint;
		},

		setMany(entries: Record<string, V> | Array<[string, V]>): Constraint[] {
			const pairs: Array<[string, V]> = Array.isArray(entries)
				? entries
				: (Object.entries(entries) as Array<[string, V]>);

			const constraints: Constraint[] = [];
			for (const [key, value] of pairs) {
				const keyPath = pathChild(path, key);
				constraints.push(
					createConstraint(
						peerId,
						nextCounter(),
						nextLamport(),
						keyPath,
						eq(value),
					),
				);
			}

			applyConstraints(constraints);
			return constraints;
		},

		deleteMany(keys: string[]): Constraint[] {
			const constraints: Constraint[] = [];
			for (const key of keys) {
				const keyPath = pathChild(path, key);
				constraints.push(
					createConstraint(
						peerId,
						nextCounter(),
						nextLamport(),
						keyPath,
						deleted(),
					),
				);
			}

			applyConstraints(constraints);
			return constraints;
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
// Multi-Peer Map Handle Merge
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
export function mergeMapHandles<V>(
	target: MapHandle<V>,
	source: MapHandle<V>,
): void {
	const merged = mergeStores(target.getStore(), source.getStore());
	target._updateStore(merged);
}
