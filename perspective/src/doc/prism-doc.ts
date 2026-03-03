/**
 * PrismDoc - Top-level Document Coordinator
 *
 * PrismDoc is the unified entry point for working with a Prism document.
 * It owns the single shared constraint store and coordinates all handles,
 * views, subscriptions, and sync operations.
 *
 * Key responsibilities:
 * - Single shared constraint store ownership
 * - Peer ID and clock management
 * - Container creation (getMap, getList, getText)
 * - Automatic wiring: mutations via any handle are visible to all views
 * - Subscription coordination via SubscriptionManager
 * - Introspection via IntrospectionAPI
 * - Sync via delta export/import
 *
 * Design: PrismDoc follows the "imperative shell" pattern. All pure
 * constraint logic lives in the functional core (store, solvers, views).
 * PrismDoc sequences those operations and manages shared mutable state.
 */

import type { Constraint } from "../core/constraint.js";
import { createConstraint } from "../core/constraint.js";
import type { Assertion } from "../core/assertions.js";
import { eq, deleted, seqElement } from "../core/assertions.js";
import type { Path, PeerID, Lamport, OpId } from "../core/types.js";
import { pathChild, opIdToString, pathToString } from "../core/types.js";
import type {
	ConstraintStore,
	ConstraintDelta,
	TellResult,
} from "../store/constraint-store.js";
import {
	createConstraintStore,
	tell,
	tellMany,
	ask,
	askPrefix,
	getVersionVector,
	getLamport,
	getGeneration,
	exportDelta,
	importDelta,
	mergeStores,
} from "../store/constraint-store.js";
import type { VersionVector } from "../core/version-vector.js";
import { solveMapConstraints } from "../solver/map-solver.js";
import { solveListConstraints } from "../solver/list-solver.js";
import type { SolvedValue } from "../solver/solver.js";
import { solvedEmpty } from "../solver/solver.js";
import { computeInsertOrigins, getIdAtIndex } from "../solver/fugue.js";
import { solveList } from "../solver/list-solver.js";

import type { MapView } from "../views/map-view.js";
import { createMapView } from "../views/map-view.js";
import type { ListView } from "../views/list-view.js";
import { createListView } from "../views/list-view.js";
import type { TextView } from "../views/text-view.js";
import { createTextView } from "../views/text-view.js";

import type {
	SubscriptionManager,
	ConstraintCallback,
	StateChangeCallback,
	ConflictCallback,
} from "../events/subscription-manager.js";
import { createSubscriptionManager } from "../events/subscription-manager.js";

import type { IntrospectionAPI } from "../introspection/explain.js";
import { createIntrospectionAPI } from "../introspection/explain.js";

import type { ConstraintInspector } from "../introspection/inspector.js";
import { createConstraintInspector } from "../introspection/inspector.js";

// ============================================================================
// DocHandle Types
// ============================================================================

/**
 * A Map handle bound to a PrismDoc.
 *
 * Unlike standalone MapHandle, mutations here automatically update
 * the shared store and notify all subscribers.
 */
export interface DocMapHandle<V = unknown> {
	readonly path: Path;

	/** Set a key to a value. */
	set(key: string, value: V): Constraint;

	/** Delete a key. */
	delete(key: string): Constraint;

	/** Set multiple key-value pairs. */
	setMany(entries: Record<string, V> | Array<[string, V]>): Constraint[];

	/** Delete multiple keys. */
	deleteMany(keys: string[]): Constraint[];

	/** Get a fresh view of this map's current state. */
	view(): MapView<V>;

	/** Get the current value as a plain object. */
	get(): Record<string, V> | undefined;
}

/**
 * A List handle bound to a PrismDoc.
 */
export interface DocListHandle<V = unknown> {
	readonly path: Path;

	/** Insert a value at index. */
	insert(index: number, value: V): Constraint;

	/** Insert multiple values at index. */
	insertMany(index: number, values: V[]): Constraint[];

	/** Delete element at index. */
	delete(index: number): Constraint | undefined;

	/** Delete a range of elements. */
	deleteRange(index: number, count: number): Constraint[];

	/** Push to end. */
	push(value: V): Constraint;

	/** Push multiple to end. */
	pushMany(values: V[]): Constraint[];

	/** Insert at beginning. */
	unshift(value: V): Constraint;

	/** Get a fresh view of this list's current state. */
	view(): ListView<V>;

	/** Get the current value as an array. */
	get(): V[] | undefined;
}

/**
 * A Text handle bound to a PrismDoc.
 */
export interface DocTextHandle {
	readonly path: Path;

	/** Insert text at position. */
	insert(index: number, text: string): Constraint[];

	/** Delete characters at position. */
	delete(index: number, length: number): Constraint[];

	/** Append text to end. */
	append(text: string): Constraint[];

	/** Replace a range of text. */
	replace(index: number, length: number, text: string): Constraint[];

	/** Get a fresh view of this text's current state. */
	view(): TextView;

	/** Get the current text as a string. */
	get(): string | undefined;

	/** Get the current text, returning empty string instead of undefined. */
	toString(): string;
}

// ============================================================================
// PrismDoc Interface
// ============================================================================

/**
 * A Prism document. Owns a constraint store and coordinates all access.
 */
export interface PrismDoc {
	/** The peer ID of this document. */
	readonly peerId: PeerID;

	// -- Container Access --

	/** Get or create a Map container at a path. */
	getMap<V = unknown>(path: Path | string): DocMapHandle<V>;

	/** Get or create a List container at a path. */
	getList<V = unknown>(path: Path | string): DocListHandle<V>;

	/** Get or create a Text container at a path. */
	getText(path: Path | string): DocTextHandle;

	// -- Store Access --

	/** Get the current constraint store (read-only snapshot). */
	getStore(): ConstraintStore;

	/** Get the current version vector. */
	getVersionVector(): VersionVector;

	/** Get the current Lamport clock. */
	getLamport(): Lamport;

	/** Get the current generation counter. */
	getGeneration(): number;

	// -- Subscriptions --

	/** Subscribe to all constraint additions. */
	onConstraintAdded(callback: ConstraintCallback): () => void;

	/** Subscribe to state changes at a specific path. */
	onStateChanged<T>(
		path: Path,
		callback: StateChangeCallback<T>,
	): () => void;

	/** Subscribe to state changes under a path prefix. */
	onStateChangedPrefix<T>(
		pathPrefix: Path,
		callback: StateChangeCallback<T>,
	): () => void;

	/** Subscribe to conflict events. */
	onConflict(callback: ConflictCallback): () => void;

	// -- Introspection --

	/** Get the introspection API for this document. */
	introspect(): IntrospectionAPI;

	/** Get the constraint inspector for this document. */
	inspector(): ConstraintInspector;

	// -- Sync --

	/** Export a delta for a remote peer based on their version vector. */
	exportDelta(theirVV: VersionVector): ConstraintDelta;

	/** Import a delta from a remote peer. */
	importDelta(delta: ConstraintDelta): void;

	/** Merge with another PrismDoc (bidirectional sync). */
	merge(other: PrismDoc): void;
}

// ============================================================================
// PrismDoc Configuration
// ============================================================================

/**
 * Configuration for creating a PrismDoc.
 */
export interface PrismDocConfig {
	/** Peer ID for this document. */
	peerId: PeerID;

	/** Optional initial store (e.g., from a snapshot). */
	initialStore?: ConstraintStore;

	/** Optional initial counter (for resuming from a previous session). */
	initialCounter?: number;
}

// ============================================================================
// PrismDoc Implementation
// ============================================================================

/**
 * Create a new PrismDoc.
 *
 * @param config Configuration for the document
 * @returns A PrismDoc instance
 */
export function createPrismDoc(config: PrismDocConfig): PrismDoc {
	const { peerId } = config;
	let store = config.initialStore ?? createConstraintStore();
	let counter = config.initialCounter ?? 0;
	let lamport = store.lamport;

	// Subscription manager for centralized event delivery
	const subscriptions = createSubscriptionManager();

	// -- Internal helpers --

	function nextCounter(): number {
		return counter++;
	}

	function nextLamport(): Lamport {
		return ++lamport;
	}

	/**
	 * Apply a single constraint to the store and notify subscribers.
	 */
	function applyConstraint(constraint: Constraint): void {
		const previousStore = store;
		const result = tell(store, constraint);
		if (result.isNew) {
			store = result.store;
			lamport = Math.max(lamport, constraint.metadata.lamport);
			notifySubscribers([constraint], previousStore);
		}
	}

	/**
	 * Apply multiple constraints to the store and notify subscribers.
	 */
	function applyConstraints(constraints: Constraint[]): void {
		if (constraints.length === 0) return;
		const previousStore = store;
		const result = tellMany(store, constraints);
		if (result.isNew) {
			store = result.store;
			for (const c of constraints) {
				lamport = Math.max(lamport, c.metadata.lamport);
			}
			notifySubscribers(constraints, previousStore);
		}
	}

	/**
	 * Notify the subscription manager of new constraints.
	 * Computes previous states for diff detection.
	 */
	function notifySubscribers(
		constraints: readonly Constraint[],
		previousStore: ConstraintStore,
	): void {
		// Compute previous states for affected paths
		const previousStates = new Map<string, SolvedValue<unknown>>();
		for (const constraint of constraints) {
			const pathKey = pathToString(constraint.path);
			if (!previousStates.has(pathKey)) {
				const prevConstraints = ask(previousStore, constraint.path);
				previousStates.set(
					pathKey,
					solveMapConstraints(prevConstraints, constraint.path),
				);
			}
		}

		subscriptions.notifyConstraintsAdded(
			constraints,
			store,
			<T>(path: Path) =>
				solveMapConstraints(ask(store, path), path) as SolvedValue<T>,
			previousStates,
		);
	}

	/**
	 * Normalize a path argument: string → single-segment path.
	 */
	function normalizePath(pathOrString: Path | string): Path {
		if (typeof pathOrString === "string") {
			return [pathOrString];
		}
		return pathOrString;
	}

	/**
	 * Get the Fugue result for a list/text container.
	 */
	function getFugueResult(containerPath: Path) {
		const constraints = askPrefix(store, containerPath);
		return solveList(constraints, containerPath).fugue;
	}

	// -- Doc Handle Factories --

	function createDocMapHandle<V>(path: Path): DocMapHandle<V> {
		return {
			path,

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

			setMany(
				entries: Record<string, V> | Array<[string, V]>,
			): Constraint[] {
				const pairs: Array<[string, V]> = Array.isArray(entries)
					? entries
					: (Object.entries(entries) as Array<[string, V]>);

				const constraints: Constraint[] = [];
				for (const [key, value] of pairs) {
					constraints.push(
						createConstraint(
							peerId,
							nextCounter(),
							nextLamport(),
							pathChild(path, key),
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
					constraints.push(
						createConstraint(
							peerId,
							nextCounter(),
							nextLamport(),
							pathChild(path, key),
							deleted(),
						),
					);
				}
				applyConstraints(constraints);
				return constraints;
			},

			view(): MapView<V> {
				return createMapView<V>({ store, path });
			},

			get(): Record<string, V> | undefined {
				return this.view().get();
			},
		};
	}

	function createDocListHandle<V>(path: Path): DocListHandle<V> {
		return {
			path,

			insert(index: number, value: V): Constraint {
				const fugue = getFugueResult(path);
				const { originLeft, originRight } = computeInsertOrigins(
					fugue,
					index,
				);

				const thisCounter = nextCounter();
				const thisLamport = nextLamport();
				const elemId: OpId = { peer: peerId, counter: thisCounter };
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

				const fugue = getFugueResult(path);
				const { originLeft: initialOriginLeft, originRight } =
					computeInsertOrigins(fugue, index);

				const constraints: Constraint[] = [];
				let prevId: OpId | null = initialOriginLeft;

				for (const value of values) {
					const thisCounter = nextCounter();
					const thisLamport = nextLamport();
					const thisId: OpId = { peer: peerId, counter: thisCounter };
					const elemPath = pathChild(path, opIdToString(thisId));

					constraints.push(
						createConstraint(
							peerId,
							thisCounter,
							thisLamport,
							elemPath,
							seqElement(value, prevId, originRight),
						),
					);
					prevId = thisId;
				}

				applyConstraints(constraints);
				return constraints;
			},

			delete(index: number): Constraint | undefined {
				const fugue = getFugueResult(path);
				const elementId = getIdAtIndex(fugue, index);
				if (!elementId) return undefined;

				const elemPath = pathChild(path, opIdToString(elementId));
				const constraint = createConstraint(
					peerId,
					nextCounter(),
					nextLamport(),
					elemPath,
					deleted(),
				);

				applyConstraint(constraint);
				return constraint;
			},

			deleteRange(index: number, count: number): Constraint[] {
				const fugue = getFugueResult(path);
				const idsToDelete: OpId[] = [];
				for (let i = 0; i < count; i++) {
					const elementId = getIdAtIndex(fugue, index + i);
					if (elementId) idsToDelete.push(elementId);
				}

				const constraints: Constraint[] = [];
				for (const elementId of idsToDelete) {
					constraints.push(
						createConstraint(
							peerId,
							nextCounter(),
							nextLamport(),
							pathChild(path, opIdToString(elementId)),
							deleted(),
						),
					);
				}

				applyConstraints(constraints);
				return constraints;
			},

			push(value: V): Constraint {
				return this.insert(this.view().length(), value);
			},

			pushMany(values: V[]): Constraint[] {
				return this.insertMany(this.view().length(), values);
			},

			unshift(value: V): Constraint {
				return this.insert(0, value);
			},

			view(): ListView<V> {
				return createListView<V>({ store, path });
			},

			get(): V[] | undefined {
				return this.view().get();
			},
		};
	}

	function createDocTextHandle(path: Path): DocTextHandle {
		return {
			path,

			insert(index: number, text: string): Constraint[] {
				if (text.length === 0) return [];

				const fugue = getFugueResult(path);
				const { originLeft: initialOriginLeft, originRight } =
					computeInsertOrigins(fugue, index);

				const constraints: Constraint[] = [];
				let prevId: OpId | null = initialOriginLeft;
				const chars = [...text]; // Unicode-safe iteration

				for (const char of chars) {
					const thisCounter = nextCounter();
					const thisLamport = nextLamport();
					const thisId: OpId = { peer: peerId, counter: thisCounter };
					const elemPath = pathChild(path, opIdToString(thisId));

					constraints.push(
						createConstraint(
							peerId,
							thisCounter,
							thisLamport,
							elemPath,
							seqElement(char, prevId, originRight),
						),
					);
					prevId = thisId;
				}

				applyConstraints(constraints);
				return constraints;
			},

			delete(index: number, length: number): Constraint[] {
				if (length <= 0) return [];

				const fugue = getFugueResult(path);
				const idsToDelete: OpId[] = [];
				for (let i = 0; i < length; i++) {
					const elementId = getIdAtIndex(fugue, index + i);
					if (elementId) idsToDelete.push(elementId);
				}

				const constraints: Constraint[] = [];
				for (const elementId of idsToDelete) {
					constraints.push(
						createConstraint(
							peerId,
							nextCounter(),
							nextLamport(),
							pathChild(path, opIdToString(elementId)),
							deleted(),
						),
					);
				}

				applyConstraints(constraints);
				return constraints;
			},

			append(text: string): Constraint[] {
				return this.insert(this.view().length(), text);
			},

			replace(
				index: number,
				length: number,
				text: string,
			): Constraint[] {
				const deleteConstraints = this.delete(index, length);
				const insertConstraints = this.insert(index, text);
				return [...deleteConstraints, ...insertConstraints];
			},

			view(): TextView {
				return createTextView({ store, path });
			},

			get(): string | undefined {
				return this.view().get();
			},

			toString(): string {
				return this.view().toString();
			},
		};
	}

	// -- PrismDoc implementation --

	const doc: PrismDoc = {
		peerId,

		// Container access
		getMap<V = unknown>(pathOrString: Path | string): DocMapHandle<V> {
			return createDocMapHandle<V>(normalizePath(pathOrString));
		},

		getList<V = unknown>(pathOrString: Path | string): DocListHandle<V> {
			return createDocListHandle<V>(normalizePath(pathOrString));
		},

		getText(pathOrString: Path | string): DocTextHandle {
			return createDocTextHandle(normalizePath(pathOrString));
		},

		// Store access
		getStore(): ConstraintStore {
			return store;
		},

		getVersionVector(): VersionVector {
			return getVersionVector(store);
		},

		getLamport(): Lamport {
			return getLamport(store);
		},

		getGeneration(): number {
			return getGeneration(store);
		},

		// Subscriptions (delegate to SubscriptionManager)
		onConstraintAdded(callback: ConstraintCallback): () => void {
			return subscriptions.onConstraintAdded(callback);
		},

		onStateChanged<T>(
			path: Path,
			callback: StateChangeCallback<T>,
		): () => void {
			return subscriptions.onStateChanged(path, callback);
		},

		onStateChangedPrefix<T>(
			pathPrefix: Path,
			callback: StateChangeCallback<T>,
		): () => void {
			return subscriptions.onStateChangedPrefix(pathPrefix, callback);
		},

		onConflict(callback: ConflictCallback): () => void {
			return subscriptions.onConflict(callback);
		},

		// Introspection
		introspect(): IntrospectionAPI {
			return createIntrospectionAPI({
				getStore: () => store,
				solve: <T>(path: Path) =>
					solveMapConstraints(ask(store, path), path) as SolvedValue<T>,
			});
		},

		inspector(): ConstraintInspector {
			return createConstraintInspector({
				getStore: () => store,
			});
		},

		// Sync
		exportDelta(theirVV: VersionVector): ConstraintDelta {
			return exportDelta(store, theirVV);
		},

		importDelta(delta: ConstraintDelta): void {
			const previousStore = store;
			const result = tellMany(store, delta.constraints);
			if (result.isNew) {
				store = result.store;
				lamport = Math.max(lamport, store.lamport);
				notifySubscribers(delta.constraints, previousStore);
			}
		},

		merge(other: PrismDoc): void {
			const previousStore = store;
			const otherStore = other.getStore();
			const merged = mergeStores(store, otherStore);

			// Only update if something changed
			if (merged.generation !== store.generation) {
				// Collect the new constraints (those in other but not in ours)
				const newConstraints: Constraint[] = [];
				for (const [key, constraint] of otherStore.constraints) {
					if (!previousStore.constraints.has(key)) {
						newConstraints.push(constraint);
					}
				}

				store = merged;
				lamport = Math.max(lamport, merged.lamport);

				if (newConstraints.length > 0) {
					notifySubscribers(newConstraints, previousStore);
				}
			}
		},
	};

	return doc;
}

// ============================================================================
// Convenience: Sync two docs bidirectionally
// ============================================================================

/**
 * Sync two PrismDocs bidirectionally.
 *
 * After sync, both docs will have the same constraint store.
 */
export function syncDocs(a: PrismDoc, b: PrismDoc): void {
	const deltaAtoB = a.exportDelta(b.getVersionVector());
	const deltaBtoA = b.exportDelta(a.getVersionVector());

	b.importDelta(deltaAtoB);
	a.importDelta(deltaBtoA);
}
