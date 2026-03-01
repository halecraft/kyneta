/**
 * Core Types for Prism
 *
 * Fundamental types used throughout the Prism system.
 */

// ============================================================================
// Identity Types
// ============================================================================

/**
 * Peer identifier - human-readable string for debugging clarity.
 *
 * In production, this might be a UUID or similar, but for this experimental
 * implementation we use readable strings like "alice", "bob", "peer-1".
 */
export type PeerID = string;

/**
 * Counter - monotonically increasing per-peer operation counter.
 *
 * Each peer maintains their own counter that increments with each operation.
 * Together with PeerID, forms a unique operation identifier.
 */
export type Counter = number;

/**
 * Lamport timestamp - logical clock for causal ordering.
 *
 * Used for conflict resolution (LWW) and establishing happens-before relationships.
 * Incremented on each local operation and updated to max(local, received) + 1 on receive.
 */
export type Lamport = number;

/**
 * Operation identifier - uniquely identifies a constraint.
 *
 * The combination of peer and counter is globally unique.
 */
export interface OpId {
	readonly peer: PeerID;
	readonly counter: Counter;
}

/**
 * Create an OpId.
 */
export function createOpId(peer: PeerID, counter: Counter): OpId {
	return { peer, counter };
}

/**
 * Check if two OpIds are equal.
 */
export function opIdEquals(a: OpId, b: OpId): boolean {
	return a.peer === b.peer && a.counter === b.counter;
}

/**
 * Convert an OpId to a string representation.
 *
 * Format: "peer@counter" (e.g., "alice@5")
 */
export function opIdToString(id: OpId): string {
	return `${id.peer}@${id.counter}`;
}

/**
 * Parse an OpId from a string representation.
 *
 * @throws Error if the string is not in valid "peer@counter" format
 */
export function opIdFromString(str: string): OpId {
	const atIndex = str.lastIndexOf("@");
	if (atIndex === -1) {
		throw new Error(`Invalid OpId string: ${str}`);
	}
	const peer = str.slice(0, atIndex);
	const counter = parseInt(str.slice(atIndex + 1), 10);
	if (isNaN(counter)) {
		throw new Error(`Invalid OpId counter in: ${str}`);
	}
	return createOpId(peer, counter);
}

/**
 * Compare two OpIds for ordering.
 *
 * Returns:
 * - negative if a < b
 * - 0 if a === b
 * - positive if a > b
 *
 * Ordering is by peer (lexicographic), then by counter.
 */
export function opIdCompare(a: OpId, b: OpId): number {
	if (a.peer !== b.peer) {
		return a.peer < b.peer ? -1 : 1;
	}
	return a.counter - b.counter;
}

// ============================================================================
// Path Types
// ============================================================================

/**
 * Path segment - either a string (map key) or number (list index).
 *
 * Note: For lists, the number represents a logical position, not a physical index.
 * Actual list element identity is tracked via OpId.
 */
export type PathSegment = string | number;

/**
 * Path - array of segments identifying a location in the document.
 *
 * Examples:
 * - ["users", "alice", "name"]     - Map key access
 * - ["todos", 0, "text"]           - List element access
 * - ["document"]                    - Container root
 */
export type Path = readonly PathSegment[];

/**
 * Check if two paths are equal.
 */
export function pathEquals(a: Path, b: Path): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * Convert a path to a string key for use in Maps.
 *
 * Uses JSON serialization for unambiguous representation.
 */
export function pathToString(path: Path): string {
	return JSON.stringify(path);
}

/**
 * Parse a path from its string representation.
 */
export function pathFromString(str: string): Path {
	return JSON.parse(str) as Path;
}

/**
 * Check if a path starts with a prefix.
 *
 * Example: ["a", "b", "c"] starts with ["a", "b"] but not ["a", "c"]
 */
export function pathStartsWith(path: Path, prefix: Path): boolean {
	if (prefix.length > path.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (path[i] !== prefix[i]) return false;
	}
	return true;
}

/**
 * Get the parent path (all segments except the last).
 *
 * Returns empty array for root path.
 */
export function pathParent(path: Path): Path {
	if (path.length === 0) return [];
	return path.slice(0, -1);
}

/**
 * Get the last segment of a path.
 *
 * Returns undefined for empty path.
 */
export function pathLast(path: Path): PathSegment | undefined {
	return path[path.length - 1];
}

/**
 * Create a child path by appending a segment.
 */
export function pathChild(path: Path, segment: PathSegment): Path {
	return [...path, segment];
}

/**
 * Compare two paths for ordering.
 *
 * Lexicographic comparison by segments.
 */
export function pathCompare(a: Path, b: Path): number {
	const minLen = Math.min(a.length, b.length);
	for (let i = 0; i < minLen; i++) {
		const segA = a[i]!;
		const segB = b[i]!;

		// Different types: numbers come before strings
		if (typeof segA !== typeof segB) {
			return typeof segA === "number" ? -1 : 1;
		}

		// Same types: compare directly
		if (segA !== segB) {
			return segA < segB ? -1 : 1;
		}
	}
	// Shorter path comes first
	return a.length - b.length;
}
