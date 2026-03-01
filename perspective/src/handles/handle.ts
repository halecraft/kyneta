/**
 * Handle Interface for Prism
 *
 * A Handle provides a mutation API over constraints. It:
 * - Generates constraints from high-level operations
 * - Manages the local Lamport clock
 * - Provides access to a View for reading
 *
 * Handles are the write counterpart to Views.
 */

import type { Path } from "../core/types.js";

// ============================================================================
// Handle Interface
// ============================================================================

/**
 * A Handle provides mutation operations over constraints.
 *
 * @template T The type of value this handle manages
 * @template V The type of View this handle provides
 */
export interface Handle<T, V> {
	/** The path this handle is rooted at */
	readonly path: Path;

	/** Get a read-only view of this handle's data */
	view(): V;

	/**
	 * Get the current value.
	 *
	 * Shorthand for `view().get()`.
	 */
	get(): T | undefined;
}
