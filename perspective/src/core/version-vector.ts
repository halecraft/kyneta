/**
 * Version Vector for Prism
 *
 * A Version Vector tracks the latest operation counter seen from each peer.
 * Used for:
 * - Determining what constraints a peer has seen
 * - Computing deltas for sync (send constraints they haven't seen)
 * - Detecting concurrent operations
 */

import type { Counter, PeerID } from "./types.js";

// ============================================================================
// Version Vector Type
// ============================================================================

/**
 * Version Vector - maps each peer to the next expected counter.
 *
 * Semantics: vv[peer] = n means we have seen operations 0..n-1 from that peer.
 * This is a "right-open interval" representation.
 */
export type VersionVector = ReadonlyMap<PeerID, Counter>;

/**
 * Mutable version vector for internal use.
 */
export type MutableVersionVector = Map<PeerID, Counter>;

// ============================================================================
// Construction
// ============================================================================

/**
 * Create an empty version vector.
 */
export function createVersionVector(): MutableVersionVector {
	return new Map();
}

/**
 * Create a version vector from an object.
 *
 * @param obj - Object mapping peer IDs to counters
 */
export function vvFromObject(
	obj: Record<PeerID, Counter>,
): MutableVersionVector {
	return new Map(Object.entries(obj));
}

/**
 * Clone a version vector.
 */
export function vvClone(vv: VersionVector): MutableVersionVector {
	return new Map(vv);
}

// ============================================================================
// Access
// ============================================================================

/**
 * Get the counter for a peer (next expected counter).
 *
 * Returns 0 if the peer is not in the version vector.
 */
export function vvGet(vv: VersionVector, peer: PeerID): Counter {
	return vv.get(peer) ?? 0;
}

/**
 * Check if a version vector has seen a specific operation.
 *
 * @param vv - The version vector
 * @param peer - The peer who created the operation
 * @param counter - The counter of the operation
 * @returns true if vv has seen this operation (counter < vv[peer])
 */
export function vvHasSeen(
	vv: VersionVector,
	peer: PeerID,
	counter: Counter,
): boolean {
	const known = vvGet(vv, peer);
	return counter < known;
}

// ============================================================================
// Mutation
// ============================================================================

/**
 * Set the counter for a peer.
 *
 * This is the exclusive end, meaning counter n means we've seen 0..n-1.
 */
export function vvSet(
	vv: MutableVersionVector,
	peer: PeerID,
	counter: Counter,
): void {
	if (counter <= 0) {
		vv.delete(peer);
	} else {
		vv.set(peer, counter);
	}
}

/**
 * Extend the version vector to include an operation.
 *
 * Updates vv[peer] = max(vv[peer], counter + 1)
 *
 * @param vv - The version vector to update
 * @param peer - The peer who created the operation
 * @param counter - The counter of the operation
 */
export function vvExtend(
	vv: MutableVersionVector,
	peer: PeerID,
	counter: Counter,
): void {
	const current = vvGet(vv, peer);
	const newCounter = counter + 1;
	if (newCounter > current) {
		vv.set(peer, newCounter);
	}
}

// ============================================================================
// Comparison
// ============================================================================

/**
 * Comparison result between two version vectors.
 */
export type VVCompareResult =
	| "equal" // Identical
	| "less" // a < b (a is ancestor of b)
	| "greater" // a > b (b is ancestor of a)
	| "concurrent"; // Neither is ancestor of the other

/**
 * Compare two version vectors.
 *
 * Returns:
 * - "equal" if they are identical
 * - "less" if a ≤ b and a ≠ b (a is an ancestor of b)
 * - "greater" if a ≥ b and a ≠ b (b is an ancestor of a)
 * - "concurrent" if neither is an ancestor of the other
 */
export function vvCompare(a: VersionVector, b: VersionVector): VVCompareResult {
	let aHasMore = false;
	let bHasMore = false;

	// Check all peers in a
	for (const [peer, counterA] of a) {
		const counterB = vvGet(b, peer);
		if (counterA > counterB) aHasMore = true;
		if (counterB > counterA) bHasMore = true;
	}

	// Check peers only in b
	for (const [peer, counterB] of b) {
		if (!a.has(peer)) {
			bHasMore = true;
		}
	}

	if (!aHasMore && !bHasMore) return "equal";
	if (aHasMore && !bHasMore) return "greater";
	if (!aHasMore && bHasMore) return "less";
	return "concurrent";
}

/**
 * Check if version vector a includes all operations in b.
 *
 * Returns true if a ≥ b (a has seen everything b has seen).
 */
export function vvIncludes(a: VersionVector, b: VersionVector): boolean {
	for (const [peer, counterB] of b) {
		const counterA = vvGet(a, peer);
		if (counterA < counterB) return false;
	}
	return true;
}

/**
 * Check if two version vectors are equal.
 */
export function vvEquals(a: VersionVector, b: VersionVector): boolean {
	if (a.size !== b.size) return false;
	for (const [peer, counterA] of a) {
		if (vvGet(b, peer) !== counterA) return false;
	}
	return true;
}

// ============================================================================
// Merge Operations
// ============================================================================

/**
 * Merge two version vectors, taking the maximum counter for each peer.
 *
 * Returns a new version vector: result[peer] = max(a[peer], b[peer])
 */
export function vvMerge(
	a: VersionVector,
	b: VersionVector,
): MutableVersionVector {
	const result = vvClone(a);
	for (const [peer, counterB] of b) {
		const counterA = vvGet(result, peer);
		if (counterB > counterA) {
			result.set(peer, counterB);
		}
	}
	return result;
}

/**
 * Merge b into a (mutating a).
 *
 * Updates a[peer] = max(a[peer], b[peer]) for all peers.
 */
export function vvMergeInto(a: MutableVersionVector, b: VersionVector): void {
	for (const [peer, counterB] of b) {
		const counterA = vvGet(a, peer);
		if (counterB > counterA) {
			a.set(peer, counterB);
		}
	}
}

// ============================================================================
// Delta Computation
// ============================================================================

/**
 * Compute the difference between two version vectors.
 *
 * Returns an object describing what operations are in `current` but not in `other`.
 * For each peer, gives the range [other[peer], current[peer]) of operations to send.
 */
export function vvDiff(
	current: VersionVector,
	other: VersionVector,
): Map<PeerID, { start: Counter; end: Counter }> {
	const diff = new Map<PeerID, { start: Counter; end: Counter }>();

	for (const [peer, currentCounter] of current) {
		const otherCounter = vvGet(other, peer);
		if (currentCounter > otherCounter) {
			diff.set(peer, { start: otherCounter, end: currentCounter });
		}
	}

	return diff;
}

// ============================================================================
// Serialization
// ============================================================================

/**
 * Convert a version vector to a plain object.
 */
export function vvToObject(vv: VersionVector): Record<PeerID, Counter> {
	const obj: Record<PeerID, Counter> = {};
	for (const [peer, counter] of vv) {
		obj[peer] = counter;
	}
	return obj;
}

/**
 * Get a human-readable string representation.
 */
export function vvToString(vv: VersionVector): string {
	if (vv.size === 0) return "{}";

	const entries = Array.from(vv.entries())
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([peer, counter]) => `${peer}:${counter}`)
		.join(", ");

	return `{${entries}}`;
}

// ============================================================================
// Utility
// ============================================================================

/**
 * Get the total number of operations represented by a version vector.
 *
 * This is the sum of all counters.
 */
export function vvTotalOps(vv: VersionVector): number {
	let total = 0;
	for (const counter of vv.values()) {
		total += counter;
	}
	return total;
}

/**
 * Get all peers in a version vector.
 */
export function vvPeers(vv: VersionVector): PeerID[] {
	return Array.from(vv.keys());
}

/**
 * Check if a version vector is empty (no operations seen).
 */
export function vvIsEmpty(vv: VersionVector): boolean {
	return vv.size === 0;
}
