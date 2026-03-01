/**
 * Text View for Prism
 *
 * A TextView provides a string-oriented projection over Text constraints.
 * Text is implemented as a List of single-character strings, so TextView
 * wraps ListView and joins the characters into a string.
 *
 * This follows the "Text is just a List of characters" design principle,
 * maximizing code reuse and conceptual simplicity.
 */

import type { Constraint } from "../core/constraint.js";
import type { Path } from "../core/types.js";
import type { ConstraintStore } from "../store/constraint-store.js";
import { askPrefix } from "../store/constraint-store.js";
import type { SolvedValue } from "../solver/solver.js";
import { solvedEmpty } from "../solver/solver.js";
import { solveList, type SolvedList } from "../solver/list-solver.js";
import type { FugueNode } from "../solver/fugue.js";
import { getNodeAtIndex } from "../solver/fugue.js";
import type {
	View,
	ViewChangeCallback,
	ViewChangeEvent,
	Unsubscribe,
} from "./view.js";
import { createViewChangeEvent } from "./view.js";

// ============================================================================
// Text View Interface
// ============================================================================

/**
 * A view over a Text container's constraints.
 *
 * Provides string-oriented access to text content. Internally uses the
 * List solver (Fugue) and joins character values into a string.
 */
export interface TextView extends View<string> {
	/**
	 * Get the text as a string.
	 *
	 * @returns The full text content, or undefined if empty
	 */
	get(): string | undefined;

	/**
	 * Get the text as a string, returning empty string instead of undefined.
	 *
	 * @returns The full text content
	 */
	toString(): string;

	/**
	 * Get the length of the text in characters.
	 */
	length(): number;

	/**
	 * Check if the text is empty.
	 */
	isEmpty(): boolean;

	/**
	 * Get a character at a specific index.
	 *
	 * @param index The index to look up
	 * @returns The character, or undefined if index is out of bounds
	 */
	charAt(index: number): string | undefined;

	/**
	 * Get a substring.
	 *
	 * @param start Start index (inclusive)
	 * @param end End index (exclusive), defaults to length
	 * @returns The substring
	 */
	slice(start: number, end?: number): string;

	/**
	 * Get the full solved list with all details.
	 *
	 * Provides access to the underlying Fugue tree for advanced usage.
	 */
	getSolvedList(): SolvedList;

	/**
	 * Get the number of tombstones (deleted characters).
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
// Text View Configuration
// ============================================================================

/**
 * Configuration for creating a TextView.
 */
export interface TextViewConfig {
	/** The constraint store to read from */
	store: ConstraintStore;

	/** The path to this text container */
	path: Path;
}

// ============================================================================
// Shared Implementation Core
// ============================================================================

/**
 * Core operations for text views, shared between regular and reactive views.
 */
interface TextViewCore {
	getConstraints(): Constraint[];
	computeSolvedList(): SolvedList;
	getValue(): string | undefined;
}

/**
 * Create the core operations for a text view.
 */
function createTextViewCore(
	getStore: () => ConstraintStore,
	path: Path,
): TextViewCore {
	function getConstraints(): Constraint[] {
		return askPrefix(getStore(), path);
	}

	function computeSolvedList(): SolvedList {
		return solveList(getConstraints(), path);
	}

	function getValue(): string | undefined {
		const solved = computeSolvedList();
		if (solved.length === 0) {
			return undefined;
		}
		// Join character values into a string
		return (solved.values as string[]).join("");
	}

	return {
		getConstraints,
		computeSolvedList,
		getValue,
	};
}

/**
 * Build the text-specific methods that are shared between view types.
 */
function buildTextMethods(
	core: TextViewCore,
	subscribers: Set<ViewChangeCallback<string>>,
	path: Path,
): TextView {
	const view: TextView = {
		path,

		get(): string | undefined {
			return core.getValue();
		},

		toString(): string {
			return core.getValue() ?? "";
		},

		getSolved(): SolvedValue<string> {
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

			const text = (solved.values as string[]).join("");

			return {
				value: text,
				determinedBy,
				conflicts: [...solved.conflicts],
				resolution:
					solved.conflicts.length > 0
						? `text with ${solved.length} chars, ${solved.conflicts.length} concurrent inserts`
						: `text with ${solved.length} chars`,
			};
		},

		length(): number {
			return core.computeSolvedList().length;
		},

		isEmpty(): boolean {
			return core.computeSolvedList().length === 0;
		},

		charAt(index: number): string | undefined {
			const solved = core.computeSolvedList();
			if (index < 0 || index >= solved.length) {
				return undefined;
			}
			return solved.values[index] as string;
		},

		slice(start: number, end?: number): string {
			const solved = core.computeSolvedList();
			const chars = solved.values as string[];
			return chars.slice(start, end).join("");
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

		subscribe(callback: ViewChangeCallback<string>): Unsubscribe {
			subscribers.add(callback);
			return () => {
				subscribers.delete(callback);
			};
		},
	};

	return view;
}

// ============================================================================
// Text View Implementation
// ============================================================================

/**
 * Create a TextView over a constraint store.
 *
 * @param config Configuration including store and path
 * @returns A TextView instance
 */
export function createTextView(config: TextViewConfig): TextView {
	const { store, path } = config;
	const subscribers = new Set<ViewChangeCallback<string>>();

	// Create core with a fixed store reference
	const core = createTextViewCore(() => store, path);

	return buildTextMethods(core, subscribers, path);
}

// ============================================================================
// Reactive Text View
// ============================================================================

/**
 * A reactive TextView that can be notified of constraint changes.
 */
export interface ReactiveTextView extends TextView {
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
 * Create a reactive TextView that can be notified of changes.
 */
export function createReactiveTextView(
	config: TextViewConfig,
): ReactiveTextView {
	const { path } = config;
	let currentStore = config.store;
	const subscribers = new Set<ViewChangeCallback<string>>();

	// Create core with a dynamic store reference
	const core = createTextViewCore(() => currentStore, path);

	// Build the base view methods
	const baseView = buildTextMethods(core, subscribers, path);

	// Initialize cached value for change detection
	let cachedValue: string | undefined = core.getValue();

	// Extend with reactive capabilities
	const reactiveView: ReactiveTextView = {
		...baseView,

		notifyConstraintsChanged(addedConstraints: Constraint[]): void {
			const before = cachedValue;
			const after = core.getValue();
			cachedValue = after;

			// Notify subscribers if value changed
			if (before !== after) {
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
