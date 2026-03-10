// === Incremental Projection Stage ===
// Maintains projected Datalog facts as persistent state and processes
// constraint deltas incrementally. This is a two-input operator: it
// joins the active constraint set with the structure index to produce
// ground facts for the Datalog evaluator.
//
// Correctness invariant:
//   current() == projectToFacts(all active constraints, accumulated index).facts
//
// This mirrors the batch `projectToFacts()` in `kernel/projection.ts`
// but maintains state across calls rather than rebuilding from scratch.
//
// Key design decisions:
// - Two-input step: Δ_active (ZSet<Constraint>) and Δ_index (StructureIndexDelta).
//   Both inputs may be non-empty in the same step (e.g., a new structure
//   constraint that is both active and creates a new slot group).
// - Orphaned values: value constraints whose target structure hasn't
//   arrived yet are held in an orphan set. When the structure arrives
//   (via Δ_index), orphans are re-checked and projected.
// - Fact accumulation: the stage maintains the full set of projected
//   facts (for passing to the batch evaluator during Plan 005).
// - Only value and seq-structure constraints produce facts. Other
//   constraint types are silently ignored.
//
// See .plans/005-incremental-kernel-pipeline.md § Phase 5.
// See theory/incremental.md §5.5.

import type {
  Constraint,
  ValueConstraint,
  StructureConstraint,
} from '../types.js';
import { cnIdKey } from '../cnid.js';
import type { Fact } from '../../datalog/types.js';
import { fact, factKey } from '../../datalog/types.js';
import {
  ACTIVE_VALUE,
  ACTIVE_STRUCTURE_SEQ,
  CONSTRAINT_PEER,
} from '../projection.js';
import type { SlotGroup, StructureIndex } from '../structure-index.js';
import type { ZSet } from '../../base/zset.js';
import {
  zsetEmpty,
  zsetSingleton,
  zsetAdd,
  zsetForEach,
} from '../../base/zset.js';
import type { StructureIndexDelta } from './types.js';

// ---------------------------------------------------------------------------
// Incremental Projection Stage
// ---------------------------------------------------------------------------

/**
 * The incremental projection stage.
 *
 * Maintains projected facts and orphaned values as persistent state.
 * Processes active-set deltas and structure index deltas, emitting
 * Z-set deltas of projected facts.
 *
 * Follows the three shared conventions:
 *   1. step(Δ_active, Δ_index) — process input deltas, return output delta
 *   2. current() — return full materialized projected facts
 *   3. reset() — return to empty state
 */
export interface IncrementalProjection {
  /**
   * Process deltas from the retraction stage and structure index stage.
   *
   * @param deltaActive - Z-set delta of active constraints.
   *   weight +1: constraint became active
   *   weight −1: constraint became dominated (retracted)
   * @param deltaIndex - Structure index delta (new/modified slot groups).
   * @returns Z-set delta over projected facts.
   */
  step(
    deltaActive: ZSet<Constraint>,
    deltaIndex: StructureIndexDelta,
  ): ZSet<Fact>;

  /**
   * Return the current accumulated projected facts.
   * Equal to projectToFacts(all active constraints, accumulated index).facts.
   */
  current(): Fact[];

  /**
   * Reset to empty state.
   */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create a new incremental projection stage.
 *
 * The stage needs access to the accumulated structure index for slot
 * lookups. It receives the index getter so it can always query the
 * latest accumulated state (since the structure index is maintained
 * by a separate stage that runs before projection in the DAG).
 *
 * @param getIndex - Function returning the current accumulated StructureIndex.
 */
export function createIncrementalProjection(
  getIndex: () => StructureIndex,
): IncrementalProjection {
  // --- Persistent state ---

  // Accumulated projected facts, keyed by factKey for O(1) dedup/removal.
  let accFacts = new Map<string, Fact>();

  // Orphaned value constraints whose target structure is not yet known.
  // Keyed by the target CnId key string, value is array of value constraints
  // targeting that structure.
  let orphansByTarget = new Map<string, ValueConstraint[]>();

  // Also index orphans by their own CnId key for O(1) removal on retraction.
  let orphansByOwnKey = new Map<string, ValueConstraint>();

  // --- Internal helpers ---

  /**
   * Project a value constraint into an active_value fact.
   * Returns the fact and its key, or null if the target is not in the index.
   */
  function projectValue(
    vc: ValueConstraint,
  ): { fact: Fact; key: string } | null {
    const targetKey = cnIdKey(vc.payload.target);
    const index = getIndex();
    const sid = index.structureToSlot.get(targetKey);

    if (sid === undefined) {
      return null;
    }

    const f = fact(ACTIVE_VALUE.predicate, [
      cnIdKey(vc.id),
      sid,
      vc.payload.content,
      vc.lamport,
      vc.id.peer,
    ]);
    return { fact: f, key: factKey(f) };
  }

  /**
   * Project a seq structure constraint into active_structure_seq
   * and constraint_peer facts.
   * Returns the facts and their keys.
   */
  function projectSeqStructure(
    sc: StructureConstraint,
  ): { facts: Fact[]; keys: string[] } {
    const payload = sc.payload;
    if (payload.kind !== 'seq') return { facts: [], keys: [] };

    const seqFact = fact(ACTIVE_STRUCTURE_SEQ.predicate, [
      cnIdKey(sc.id),
      cnIdKey(payload.parent),
      payload.originLeft !== null ? cnIdKey(payload.originLeft) : null,
      payload.originRight !== null ? cnIdKey(payload.originRight) : null,
    ]);

    const peerFact = fact(CONSTRAINT_PEER.predicate, [
      cnIdKey(sc.id),
      sc.id.peer,
    ]);

    return {
      facts: [seqFact, peerFact],
      keys: [factKey(seqFact), factKey(peerFact)],
    };
  }

  /**
   * Add an orphaned value constraint. Indexed by both target key
   * and own key for efficient lookup in both directions.
   */
  function addOrphan(vc: ValueConstraint): void {
    const targetKey = cnIdKey(vc.payload.target);
    const ownKey = cnIdKey(vc.id);

    let orphans = orphansByTarget.get(targetKey);
    if (orphans === undefined) {
      orphans = [];
      orphansByTarget.set(targetKey, orphans);
    }
    orphans.push(vc);
    orphansByOwnKey.set(ownKey, vc);
  }

  /**
   * Remove an orphaned value constraint by its own CnId key.
   */
  function removeOrphan(vc: ValueConstraint): boolean {
    const ownKey = cnIdKey(vc.id);
    const existing = orphansByOwnKey.get(ownKey);
    if (existing === undefined) return false;

    orphansByOwnKey.delete(ownKey);

    const targetKey = cnIdKey(vc.payload.target);
    const orphans = orphansByTarget.get(targetKey);
    if (orphans !== undefined) {
      const idx = orphans.findIndex((o) => cnIdKey(o.id) === ownKey);
      if (idx !== -1) {
        orphans.splice(idx, 1);
        if (orphans.length === 0) {
          orphansByTarget.delete(targetKey);
        }
      }
    }

    return true;
  }

  /**
   * Try to resolve orphans whose target is now in a slot group.
   * Returns Z-set delta of newly projected facts.
   */
  function resolveOrphansForGroup(
    group: SlotGroup,
  ): ZSet<Fact> {
    let delta = zsetEmpty<Fact>();

    // Check each structure key in the group for orphans targeting it
    for (const structureKey of group.structureKeys) {
      const orphans = orphansByTarget.get(structureKey);
      if (orphans === undefined || orphans.length === 0) continue;

      // Snapshot the orphan list (we'll be modifying it)
      const toResolve = [...orphans];

      for (const vc of toResolve) {
        const result = projectValue(vc);
        if (result !== null) {
          // Orphan resolved — add to accumulated facts and emit +1
          accFacts.set(result.key, result.fact);
          delta = zsetAdd(delta, zsetSingleton(result.key, result.fact, 1));
          removeOrphan(vc);
        }
      }
    }

    return delta;
  }

  // --- Public interface ---

  function step(
    deltaActive: ZSet<Constraint>,
    deltaIndex: StructureIndexDelta,
  ): ZSet<Fact> {
    let delta = zsetEmpty<Fact>();

    // --- Phase 1: Process active constraint delta ---

    zsetForEach(deltaActive, (entry, _key) => {
      const c = entry.element;
      const weight = entry.weight;

      if (weight > 0) {
        // Constraint became active
        if (c.type === 'value') {
          const vc = c as ValueConstraint;
          const result = projectValue(vc);

          if (result !== null) {
            // Target found — emit fact with weight +1
            accFacts.set(result.key, result.fact);
            delta = zsetAdd(delta, zsetSingleton(result.key, result.fact, 1));
          } else {
            // Target not found — orphan
            addOrphan(vc);
          }
        } else if (c.type === 'structure') {
          const sc = c as StructureConstraint;
          const { facts, keys } = projectSeqStructure(sc);

          for (let i = 0; i < facts.length; i++) {
            accFacts.set(keys[i]!, facts[i]!);
            delta = zsetAdd(delta, zsetSingleton(keys[i]!, facts[i]!, 1));
          }
        }
        // Other constraint types (retract, rule, authority, bookmark)
        // are not projected.

      } else if (weight < 0) {
        // Constraint became dominated/retracted
        if (c.type === 'value') {
          const vc = c as ValueConstraint;

          // Try to remove from orphan set first
          if (removeOrphan(vc)) {
            // Was orphaned — no fact was ever emitted, nothing to retract
            return;
          }

          // Was projected — emit anti-fact (weight −1)
          const result = projectValue(vc);
          if (result !== null) {
            accFacts.delete(result.key);
            delta = zsetAdd(delta, zsetSingleton(result.key, result.fact, -1));
          }
        } else if (c.type === 'structure') {
          const sc = c as StructureConstraint;
          const { facts, keys } = projectSeqStructure(sc);

          for (let i = 0; i < facts.length; i++) {
            accFacts.delete(keys[i]!);
            delta = zsetAdd(delta, zsetSingleton(keys[i]!, facts[i]!, -1));
          }
        }
      }
    });

    // --- Phase 2: Process structure index delta ---
    // New/modified slot groups may resolve orphaned values.

    if (!deltaIndex.isEmpty) {
      for (const group of deltaIndex.updates.values()) {
        const orphanDelta = resolveOrphansForGroup(group);
        delta = zsetAdd(delta, orphanDelta);
      }
    }

    return delta;
  }

  function current(): Fact[] {
    return Array.from(accFacts.values());
  }

  function reset(): void {
    accFacts = new Map();
    orphansByTarget = new Map();
    orphansByOwnKey = new Map();
  }

  return { step, current, reset };
}