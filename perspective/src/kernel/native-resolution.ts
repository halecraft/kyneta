// === Native Resolution Utilities ===
// Shared functions for building resolution results from native LWW and Fugue
// solvers, and for diffing Fugue pair sets. Extracted from the duplicated
// implementations in `kernel/pipeline.ts` and `kernel/incremental/pipeline.ts`
// (Plan 006, Phase 1).
//
// See unified-engine.md §B.7 (native solver optimization).

import type {
  Constraint,
  StructureConstraint,
  ValueConstraint,
} from './types.js';
import { cnIdKey } from './cnid.js';
import type { StructureIndex } from './structure-index.js';
import {
  nativeResolution,
  allPairsFromOrdered,
  fuguePairKey,
  type ResolvedWinner,
  type FugueBeforePair,
  type ResolutionResult,
} from './resolve.js';
import { resolveLWW } from '../solver/lww.js';
import { buildFugueNodes, orderFugueNodes } from '../solver/fugue.js';
import type { ZSet } from '../base/zset.js';
import {
  zsetEmpty,
  zsetSingleton,
  zsetAdd,
} from '../base/zset.js';

// ---------------------------------------------------------------------------
// Native Resolution
// ---------------------------------------------------------------------------

/**
 * Build a ResolutionResult using native LWW and Fugue solvers.
 *
 * This produces the same data structure as the Datalog path but uses
 * host-language implementations directly. Used by both the batch and
 * incremental pipelines when the native fast path is active.
 *
 * @param activeConstraints - All active constraints (value + structure + others).
 * @param structureIndex - The precomputed structure index for slot lookup.
 * @returns A ResolutionResult marked as from native solvers.
 */
export function buildNativeResolution(
  activeConstraints: readonly Constraint[],
  structureIndex: StructureIndex,
): ResolutionResult {
  // Native LWW: resolve all value constraints.
  const valueConstraints = activeConstraints.filter(
    (c): c is ValueConstraint => c.type === 'value',
  );
  const lwwResult = resolveLWW(valueConstraints, structureIndex);

  const winners = new Map<string, ResolvedWinner>();
  for (const [slotId, winner] of lwwResult.winners) {
    winners.set(slotId, {
      slotId,
      winnerCnIdKey: cnIdKey(winner.winnerId),
      content: winner.content,
    });
  }

  // Native Fugue: compute ordering for all seq parents.
  const fuguePairs = buildNativeFuguePairs(activeConstraints, structureIndex);

  return nativeResolution(winners, fuguePairs);
}

/**
 * Build Fugue ordering pairs from native solver output.
 *
 * For each seq parent, runs the native Fugue solver and converts the
 * total order into (A, B) before-pairs that match the Datalog
 * `fugue_before(Parent, A, B)` relation shape.
 *
 * Uses `allPairsFromOrdered` from `resolve.ts` to generate the pairs,
 * eliminating the previously duplicated nested loop.
 *
 * @param activeConstraints - All active constraints.
 * @param structureIndex - The precomputed structure index (unused currently
 *   but kept for API consistency with `buildNativeResolution`).
 * @returns Map from parent CnId key to array of FugueBeforePair.
 */
export function buildNativeFuguePairs(
  activeConstraints: readonly Constraint[],
  _structureIndex: StructureIndex,
): ReadonlyMap<string, FugueBeforePair[]> {
  const pairs = new Map<string, FugueBeforePair[]>();

  // Group seq constraints by parent.
  const seqByParent = new Map<string, StructureConstraint[]>();
  for (const c of activeConstraints) {
    if (c.type !== 'structure') continue;
    if (c.payload.kind !== 'seq') continue;
    const parentKey = cnIdKey(c.payload.parent);
    let group = seqByParent.get(parentKey);
    if (group === undefined) {
      group = [];
      seqByParent.set(parentKey, group);
    }
    group.push(c);
  }

  // For each parent, compute native Fugue ordering and emit before-pairs.
  for (const [parentKey, constraints] of seqByParent) {
    const nodes = buildFugueNodes(constraints);
    const ordered = orderFugueNodes(nodes);

    const parentPairs = allPairsFromOrdered(parentKey, ordered);
    if (parentPairs.length > 0) {
      pairs.set(parentKey, parentPairs);
    }
  }

  return pairs;
}

// ---------------------------------------------------------------------------
// Fugue Pair Diffing
// ---------------------------------------------------------------------------

/**
 * Flatten a grouped pair map into a flat keyed map for efficient diffing.
 */
function flattenPairs(
  grouped: ReadonlyMap<string, readonly FugueBeforePair[]>,
): Map<string, FugueBeforePair> {
  const flat = new Map<string, FugueBeforePair>();
  for (const pairs of grouped.values()) {
    for (const p of pairs) {
      flat.set(fuguePairKey(p), p);
    }
  }
  return flat;
}

/**
 * Diff two sets of Fugue ordering pairs, producing a Z-set delta.
 *
 * Pairs present in `newPairs` but not `oldPairs` get weight +1.
 * Pairs present in `oldPairs` but not `newPairs` get weight −1.
 * Unchanged pairs produce no delta.
 *
 * Uses `fuguePairKey` from `resolve.ts` as the canonical Z-set key.
 *
 * @param oldPairs - Previous pair set (null treated as empty).
 * @param newPairs - Current pair set.
 * @returns Z-set delta of FugueBeforePair changes.
 */
export function diffFuguePairs(
  oldPairs: ReadonlyMap<string, readonly FugueBeforePair[]> | null,
  newPairs: ReadonlyMap<string, readonly FugueBeforePair[]>,
): ZSet<FugueBeforePair> {
  const oldFlat = oldPairs !== null
    ? flattenPairs(oldPairs)
    : new Map<string, FugueBeforePair>();
  const newFlat = flattenPairs(newPairs);

  let delta = zsetEmpty<FugueBeforePair>();

  // New pairs (in new but not old)
  for (const [key, p] of newFlat) {
    if (!oldFlat.has(key)) {
      delta = zsetAdd(delta, zsetSingleton(key, p, 1));
    }
  }

  // Removed pairs (in old but not new)
  for (const [key, p] of oldFlat) {
    if (!newFlat.has(key)) {
      delta = zsetAdd(delta, zsetSingleton(key, p, -1));
    }
  }

  return delta;
}