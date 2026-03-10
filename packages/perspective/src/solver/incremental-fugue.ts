// === Native Incremental Fugue Solver ===
// Per-parent Fugue tree maintenance that receives `active_structure_seq`
// and `constraint_peer` fact deltas and emits `ZSet<FugueBeforePair>`
// deltas. This is the native fast path for Fugue ordering described in
// theory/incremental.md §9.7.
//
// For each parent, maintains a set of FugueNodes and accumulated pairs.
// On insertion of a new seq structure fact:
//   1. Parse the fact into node data.
//   2. Correlate with the corresponding `constraint_peer` fact (may
//      arrive in either order within a single delta).
//   3. Once both facts are available, build the FugueNode, add to the
//      parent's node set, recompute Fugue ordering, and diff pairs.
//
// Structure constraints are immune to retraction, so weight −1 facts
// are not expected and are ignored with a warning.
//
// Delta emission uses `allPairsFromOrdered` and `diffFuguePairs` from
// Phase 1's shared utilities.
//
// See Plan 006, Phase 3.
// See theory/incremental.md §9.7.

import type { Fact } from '../datalog/types.js';
import type { FugueBeforePair } from '../kernel/resolve.js';
import {
  parseSeqStructureFact,
  allPairsFromOrdered,
  fuguePairKey,
  type ParsedSeqStructureFact,
} from '../kernel/resolve.js';
import { cnIdFromString, cnIdKey } from '../kernel/cnid.js';
import { orderFugueNodes, type FugueNode } from './fugue.js';
import { ACTIVE_STRUCTURE_SEQ, CONSTRAINT_PEER } from '../kernel/projection.js';
import type { ZSet } from '../base/zset.js';
import {
  zsetEmpty,
  zsetSingleton,
  zsetAdd,
  zsetForEach,
} from '../base/zset.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-parent state: all nodes and accumulated pairs. */
interface ParentState {
  /** All FugueNodes for this parent, keyed by element cnIdKey. */
  readonly nodes: Map<string, FugueNode>;
  /** Accumulated pairs grouped by parent key (single-entry map for diffing). */
  readonly pairs: Map<string, FugueBeforePair>;
}

/**
 * Incremental Fugue solver.
 *
 * Maintains per-parent Fugue tree state and produces
 * `ZSet<FugueBeforePair>` deltas on each step. Follows the three
 * shared conventions:
 *   1. step(deltaFacts) — process fact delta, return pair delta
 *   2. current() — return full materialized pairs map
 *   3. reset() — return to empty state
 */
export interface IncrementalFugue {
  /**
   * Process structure/peer fact deltas, return ordering pair deltas.
   * Consumes `active_structure_seq` and `constraint_peer` facts.
   * Other predicates are ignored.
   */
  step(deltaFacts: ZSet<Fact>): ZSet<FugueBeforePair>;

  /** Current fugue pairs by parent. */
  current(): ReadonlyMap<string, readonly FugueBeforePair[]>;

  /** Reset to empty state. */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create a new incremental Fugue solver.
 *
 * @returns An IncrementalFugue instance with empty state.
 */
export function createIncrementalFugue(): IncrementalFugue {
  // Per-parent state: parentKey → ParentState
  let parents = new Map<string, ParentState>();

  // Pending structure facts waiting for their peer fact.
  // Keyed by element cnIdKey.
  let pendingStructures = new Map<string, ParsedSeqStructureFact>();

  // Pending peer facts waiting for their structure fact.
  // Keyed by element cnIdKey → peer string.
  let pendingPeers = new Map<string, string>();

  // Track which parents were affected in this step (for batch recomputation).
  let affectedParents: Set<string> | null = null;

  function getOrCreateParent(parentKey: string): ParentState {
    let state = parents.get(parentKey);
    if (state === undefined) {
      state = { nodes: new Map(), pairs: new Map() };
      parents.set(parentKey, state);
    }
    return state;
  }

  /**
   * Try to complete a node from a structure + peer fact pair.
   * If both are available, build the FugueNode and add to the parent.
   */
  function tryCompleteNode(elementKey: string): void {
    const structure = pendingStructures.get(elementKey);
    const peer = pendingPeers.get(elementKey);

    if (structure === undefined || peer === undefined) {
      // Still waiting for the other half.
      return;
    }

    // Both available — build FugueNode
    pendingStructures.delete(elementKey);
    pendingPeers.delete(elementKey);

    const id = cnIdFromString(elementKey);
    const node: FugueNode = {
      id,
      idKey: elementKey,
      parent: cnIdFromString(structure.parentKey),
      originLeft: structure.originLeft !== null
        ? cnIdFromString(structure.originLeft)
        : null,
      originRight: structure.originRight !== null
        ? cnIdFromString(structure.originRight)
        : null,
      peer,
    };

    const parentState = getOrCreateParent(structure.parentKey);

    // Skip duplicates (same element inserted twice)
    if (parentState.nodes.has(elementKey)) return;

    parentState.nodes.set(elementKey, node);

    // Mark this parent as affected for recomputation
    if (affectedParents !== null) {
      affectedParents.add(structure.parentKey);
    }
  }

  /**
   * Recompute ordering and diff pairs for a single parent.
   * Returns the Z-set delta for this parent's pairs.
   */
  function recomputeParent(parentKey: string): ZSet<FugueBeforePair> {
    const state = parents.get(parentKey);
    if (state === undefined) return zsetEmpty();

    // Build ordered nodes using existing Fugue solver
    const nodes = Array.from(state.nodes.values());
    const ordered = orderFugueNodes(nodes);

    // Compute new pairs
    const newPairsList = allPairsFromOrdered(parentKey, ordered);

    // Build new pairs map
    const newPairs = new Map<string, FugueBeforePair>();
    for (const p of newPairsList) {
      newPairs.set(fuguePairKey(p), p);
    }

    // Diff against old pairs
    let delta = zsetEmpty<FugueBeforePair>();

    // New pairs (in new but not old)
    for (const [key, p] of newPairs) {
      if (!state.pairs.has(key)) {
        delta = zsetAdd(delta, zsetSingleton(key, p, 1));
      }
    }

    // Removed pairs (in old but not new)
    for (const [key, p] of state.pairs) {
      if (!newPairs.has(key)) {
        delta = zsetAdd(delta, zsetSingleton(key, p, -1));
      }
    }

    // Update accumulated pairs
    // We need to mutate the state's pairs map — replace it
    state.pairs.clear();
    for (const [key, p] of newPairs) {
      state.pairs.set(key, p);
    }

    return delta;
  }

  function step(deltaFacts: ZSet<Fact>): ZSet<FugueBeforePair> {
    affectedParents = new Set();

    // Phase 1: Process all facts in the delta, collecting pending halves
    zsetForEach(deltaFacts, (entry, _key) => {
      const f = entry.element;
      const weight = entry.weight;

      // Structure constraints are permanent — ignore retractions
      if (weight < 0) return;

      if (f.predicate === ACTIVE_STRUCTURE_SEQ.predicate) {
        const parsed = parseSeqStructureFact(f);
        pendingStructures.set(parsed.cnIdKey, parsed);
        tryCompleteNode(parsed.cnIdKey);
      } else if (f.predicate === CONSTRAINT_PEER.predicate) {
        const elementKey = f.values[CONSTRAINT_PEER.CNID] as string;
        const peer = f.values[CONSTRAINT_PEER.PEER] as string;
        pendingPeers.set(elementKey, peer);
        tryCompleteNode(elementKey);
      }
      // Other predicates are silently ignored
    });

    // Phase 2: Recompute ordering for all affected parents
    let delta = zsetEmpty<FugueBeforePair>();
    for (const parentKey of affectedParents) {
      const parentDelta = recomputeParent(parentKey);
      delta = zsetAdd(delta, parentDelta);
    }

    affectedParents = null;
    return delta;
  }

  function current(): ReadonlyMap<string, readonly FugueBeforePair[]> {
    const result = new Map<string, FugueBeforePair[]>();
    for (const [parentKey, state] of parents) {
      const pairs = Array.from(state.pairs.values());
      if (pairs.length > 0) {
        result.set(parentKey, pairs);
      }
    }
    return result;
  }

  function reset(): void {
    parents = new Map();
    pendingStructures = new Map();
    pendingPeers = new Map();
    affectedParents = null;
  }

  return { step, current, reset };
}