// === Version Vector ===
// Implements version vector operations for the kernel layer.
//
// A version vector maps each peer to the next expected counter.
// vv[peer] = n means we have seen operations 0..n-1 from that peer.
//
// Ported and adapted from the prototype's core/version-vector.ts
// for the new CnId-based addressing scheme.
//
// See unified-engine.md §1, §4, §7.1.

import type {
  PeerID,
  Counter,
  CnId,
  VersionVector,
  MutableVersionVector,
  Constraint,
} from './types.js';

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create an empty version vector.
 */
export function createVersionVector(): MutableVersionVector {
  return new Map();
}

/**
 * Create a version vector from a plain object.
 *
 * Convenience for tests: `vvFromObject({ alice: 3, bob: 5 })`
 */
export function vvFromObject(
  obj: Record<PeerID, Counter>,
): MutableVersionVector {
  return new Map(Object.entries(obj));
}

/**
 * Clone a version vector (shallow copy).
 */
export function vvClone(vv: VersionVector): MutableVersionVector {
  return new Map(vv);
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

/**
 * Get the next expected counter for a peer (0 if unseen).
 */
export function vvGet(vv: VersionVector, peer: PeerID): Counter {
  return vv.get(peer) ?? 0;
}

/**
 * Check if a version vector has seen a specific constraint.
 *
 * A constraint with (peer, counter) is "seen" if vv[peer] > counter.
 */
export function vvHasSeen(
  vv: VersionVector,
  peer: PeerID,
  counter: Counter,
): boolean {
  return counter < vvGet(vv, peer);
}

/**
 * Check if a version vector has seen a specific CnId.
 */
export function vvHasSeenCnId(vv: VersionVector, id: CnId): boolean {
  return vvHasSeen(vv, id.peer, id.counter);
}

// ---------------------------------------------------------------------------
// Mutation
// ---------------------------------------------------------------------------

/**
 * Extend the version vector to include a constraint.
 *
 * Updates vv[peer] = max(vv[peer], counter + 1).
 */
export function vvExtend(
  vv: MutableVersionVector,
  peer: PeerID,
  counter: Counter,
): void {
  const current = vvGet(vv, peer);
  const next = counter + 1;
  if (next > current) {
    vv.set(peer, next);
  }
}

/**
 * Extend the version vector to include a CnId.
 */
export function vvExtendCnId(vv: MutableVersionVector, id: CnId): void {
  vvExtend(vv, id.peer, id.counter);
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Comparison result between two version vectors.
 */
export type VVCompareResult =
  | 'equal'      // Identical
  | 'less'       // a < b (a is ancestor of b)
  | 'greater'    // a > b (b is ancestor of a)
  | 'concurrent'; // Neither is ancestor of the other

/**
 * Compare two version vectors.
 *
 * Returns:
 * - "equal" if they are identical
 * - "less" if a ≤ b and a ≠ b
 * - "greater" if a ≥ b and a ≠ b
 * - "concurrent" if neither is an ancestor of the other
 */
export function vvCompare(a: VersionVector, b: VersionVector): VVCompareResult {
  let aHasMore = false;
  let bHasMore = false;

  for (const [peer, counterA] of a) {
    const counterB = vvGet(b, peer);
    if (counterA > counterB) aHasMore = true;
    if (counterB > counterA) bHasMore = true;
  }

  // Check peers only in b (not in a)
  for (const [peer] of b) {
    if (!a.has(peer)) {
      bHasMore = true;
    }
  }

  if (!aHasMore && !bHasMore) return 'equal';
  if (aHasMore && !bHasMore) return 'greater';
  if (!aHasMore && bHasMore) return 'less';
  return 'concurrent';
}

/**
 * Check if version vector a includes all operations in b (a ≥ b).
 */
export function vvIncludes(a: VersionVector, b: VersionVector): boolean {
  for (const [peer, counterB] of b) {
    if (vvGet(a, peer) < counterB) return false;
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

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/**
 * Merge two version vectors, taking the max counter for each peer.
 *
 * Returns a new version vector.
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
 */
export function vvMergeInto(a: MutableVersionVector, b: VersionVector): void {
  for (const [peer, counterB] of b) {
    const counterA = vvGet(a, peer);
    if (counterB > counterA) {
      a.set(peer, counterB);
    }
  }
}

// ---------------------------------------------------------------------------
// S_V Filtering (§7.1 — version-parameterized solving)
// ---------------------------------------------------------------------------

/**
 * Filter a set of constraints to only those visible at version V.
 *
 * A constraint c is visible at V iff c.id.counter < V[c.id.peer].
 * This is the S_V operation from §7.1.
 *
 * @param constraints - Iterable of constraints to filter.
 * @param version - The version vector to filter against.
 * @returns Array of constraints visible at version V.
 */
export function filterByVersion<C extends Constraint>(
  constraints: Iterable<C>,
  version: VersionVector,
): C[] {
  const result: C[] = [];
  for (const c of constraints) {
    if (vvHasSeenCnId(version, c.id)) {
      result.push(c);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Delta Computation
// ---------------------------------------------------------------------------

/**
 * Compute the difference between two version vectors.
 *
 * Returns a map of peer → { start, end } ranges, where the range
 * [start, end) represents counters in `current` not in `other`.
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

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

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
 * Human-readable string representation.
 */
export function vvToString(vv: VersionVector): string {
  if (vv.size === 0) return '{}';

  const entries = Array.from(vv.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([peer, counter]) => `${peer}:${counter}`)
    .join(', ');

  return `{${entries}}`;
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

/**
 * Get all peers in a version vector.
 */
export function vvPeers(vv: VersionVector): PeerID[] {
  return Array.from(vv.keys());
}

/**
 * Check if a version vector is empty.
 */
export function vvIsEmpty(vv: VersionVector): boolean {
  return vv.size === 0;
}

/**
 * Get the total number of operations represented by a version vector.
 */
export function vvTotalOps(vv: VersionVector): number {
  let total = 0;
  for (const counter of vv.values()) {
    total += counter;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Component-wise Minimum
// ---------------------------------------------------------------------------

/**
 * Component-wise minimum across all version vectors.
 *
 * For each peer that appears in ALL input VVs, the result contains that peer
 * with the minimum counter across the inputs. If a peer is missing from any
 * VV, it is absent from the result (since vvGet returns 0 for missing peers,
 * and min with 0 = 0, which is equivalent to absent).
 *
 * Empty input returns an empty VV.
 */
export function vvMin(vvs: readonly VersionVector[]): MutableVersionVector {
  if (vvs.length === 0) return createVersionVector();

  const result = createVersionVector();

  // Start with the peers from the first VV
  const first = vvs[0]!;
  for (const [peer, counter] of first) {
    let min = counter;
    let presentInAll = true;
    for (let i = 1; i < vvs.length; i++) {
      const vv = vvs[i]!;
      if (!vv.has(peer)) {
        presentInAll = false;
        break;
      }
      const c = vv.get(peer)!;
      if (c < min) min = c;
    }
    if (presentInAll && min > 0) {
      result.set(peer, min);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Frontier Checking
// ---------------------------------------------------------------------------

/**
 * Check if a constraint's CnId has been seen by the frontier version vector.
 *
 * Semantic wrapper around vvHasSeenCnId for readability in frontier checks.
 * Returns true iff frontier[c.id.peer] > c.id.counter.
 */
export function isConstraintBelowFrontier(
  c: Constraint,
  frontier: VersionVector,
): boolean {
  return vvHasSeenCnId(frontier, c.id);
}