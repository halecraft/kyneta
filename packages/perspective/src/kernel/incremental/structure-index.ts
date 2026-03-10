// === Incremental Structure Index Stage ===
// Maintains the structure index as persistent state and processes
// constraint deltas incrementally. For each new structure constraint,
// computes slot identity and either creates a new SlotGroup or joins
// an existing one (map child with same parent+key from another peer).
//
// Correctness invariant:
//   current() == buildStructureIndex(all structure constraints seen so far)
//
// This mirrors the batch `buildStructureIndex()` in `kernel/structure-index.ts`
// but maintains state across calls rather than rebuilding from scratch.
//
// Key design decisions:
// - Structure constraints are permanent (never retracted). The index
//   only grows — no removal handling is needed.
// - The output is a `StructureIndexDelta`, NOT a `ZSet<SlotGroup>`.
//   SlotGroups have stable identity (slotId) but mutable contents
//   (structures array grows). Z-sets cannot correctly represent this.
//   See Plan 005 § Learnings: Z-Sets Are the Wrong Abstraction for
//   Monotone Stages.
// - Non-structure constraints in the input delta are silently ignored.
//
// See .plans/005-incremental-kernel-pipeline.md § Phase 4.
// See theory/incremental.md §5.3.

import type {
  Constraint,
  StructureConstraint,
  Policy,
} from '../types.js';
import { cnIdKey } from '../cnid.js';
import {
  slotId,
  childKey,
  type SlotGroup,
  type StructureIndex,
} from '../structure-index.js';
import type { ZSet } from '../../base/zset.js';
import { zsetForEach } from '../../base/zset.js';
import type { StructureIndexDelta } from './types.js';
import { structureIndexDeltaEmpty, structureIndexDeltaFrom } from './types.js';

// ---------------------------------------------------------------------------
// Incremental Structure Index Stage
// ---------------------------------------------------------------------------

/**
 * The incremental structure index stage.
 *
 * Maintains the structure index as persistent state. Processes constraint
 * deltas and emits StructureIndexDelta describing which slot groups were
 * created or modified.
 *
 * Follows the three shared conventions:
 *   1. step(Δ_valid) — process input delta, update state, return output delta
 *   2. current() — return full materialized structure index
 *   3. reset() — return to empty state
 */
export interface IncrementalStructureIndex {
  /**
   * Process a delta of valid constraints and return the structure index delta.
   *
   * Filters to structure constraints internally — non-structure constraints
   * in the delta are silently ignored.
   *
   * For each structure constraint with weight +1 (newly valid):
   * - Compute slot identity.
   * - Create or join a SlotGroup.
   * - Update all internal indexes (byId, slotGroups, structureToSlot,
   *   roots, childrenOf).
   * - Include the new/modified SlotGroup in the output delta.
   *
   * Weight −1 entries are ignored — structure constraints are permanent
   * and immune to retraction.
   */
  step(delta: ZSet<Constraint>): StructureIndexDelta;

  /**
   * Return the current accumulated StructureIndex.
   * Equal to buildStructureIndex(all structure constraints seen so far).
   */
  current(): StructureIndex;

  /**
   * Reset to empty state.
   */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Mutable SlotGroup builder
//
// The batch buildStructureIndex creates frozen SlotGroup objects.
// The incremental version needs mutable groups that can grow as new
// structure constraints join them. We maintain mutable builders internally
// and expose them as readonly SlotGroup via the StructureIndex interface.
// ---------------------------------------------------------------------------

interface MutableSlotGroup {
  readonly slotId: string;
  readonly structures: StructureConstraint[];
  readonly structureKeys: Set<string>;
  readonly policy: Policy;
  readonly childKey: string;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create a new incremental structure index stage.
 */
export function createIncrementalStructureIndex(): IncrementalStructureIndex {
  // --- Persistent state ---

  // All structure constraints by CnId key.
  let byId = new Map<string, StructureConstraint>();

  // Mutable slot groups indexed by slot identity string.
  let slotGroups = new Map<string, MutableSlotGroup>();

  // Mapping from structure CnId key → slot identity string.
  let structureToSlot = new Map<string, string>();

  // Root containers indexed by containerId.
  let roots = new Map<string, MutableSlotGroup>();

  // Children of a parent node, indexed by parent CnId key.
  // Each entry maps child slot identity → MutableSlotGroup.
  let childrenOf = new Map<string, Map<string, MutableSlotGroup>>();

  // --- Internal helpers ---

  /**
   * Determine the policy for a structure constraint.
   * Mirrors the batch policyOf() helper.
   */
  function policyOf(sc: StructureConstraint): Policy {
    switch (sc.payload.kind) {
      case 'root':
        return sc.payload.policy;
      case 'map':
        return 'map';
      case 'seq':
        return 'seq';
    }
  }

  /**
   * Process a single structure constraint entering the system.
   * Returns the slotId of the created/modified group, or null if
   * the constraint was a duplicate.
   */
  function addStructure(sc: StructureConstraint): string | null {
    const scKey = cnIdKey(sc.id);

    // Dedup — already indexed
    if (byId.has(scKey)) return null;

    // Index by CnId
    byId.set(scKey, sc);

    // Compute slot identity
    const sid = slotId(sc);
    const ckey = childKey(sc);

    // Map CnId → slot
    structureToSlot.set(scKey, sid);

    // Find or create slot group
    let group = slotGroups.get(sid);
    const isNewGroup = group === undefined;

    if (isNewGroup) {
      group = {
        slotId: sid,
        structures: [],
        structureKeys: new Set(),
        policy: policyOf(sc),
        childKey: ckey,
      };
      slotGroups.set(sid, group);
    }

    // Add structure to group
    group!.structures.push(sc);
    group!.structureKeys.add(scKey);

    // Update root/children indexes (only for new groups — joining an
    // existing group doesn't change the root/children topology)
    if (isNewGroup) {
      const payload = sc.payload;
      if (payload.kind === 'root') {
        roots.set(payload.containerId, group!);
      } else {
        // Map or Seq child — index under parent
        const parentKey = cnIdKey(payload.parent);
        let children = childrenOf.get(parentKey);
        if (children === undefined) {
          children = new Map();
          childrenOf.set(parentKey, children);
        }
        children.set(sid, group!);
      }
    }

    return sid;
  }

  // --- Public interface ---

  function step(delta: ZSet<Constraint>): StructureIndexDelta {
    if (delta.size === 0) return structureIndexDeltaEmpty();

    const updatedSlotIds = new Map<string, SlotGroup>();

    zsetForEach(delta, (entry, _key) => {
      // Only process additions (weight > 0) of structure constraints.
      // Structure is permanent — weight −1 is ignored.
      if (entry.weight <= 0) return;
      if (entry.element.type !== 'structure') return;

      const sc = entry.element as StructureConstraint;
      const sid = addStructure(sc);

      if (sid !== null) {
        // The group was created or modified — include in delta.
        // We cast the mutable group to SlotGroup (readonly interface).
        const group = slotGroups.get(sid)!;
        updatedSlotIds.set(sid, group as SlotGroup);
      }
    });

    if (updatedSlotIds.size === 0) return structureIndexDeltaEmpty();
    return structureIndexDeltaFrom(updatedSlotIds);
  }

  function current(): StructureIndex {
    // Return the accumulated index. The internal mutable types are
    // compatible with the readonly StructureIndex interface.
    return {
      byId: byId as ReadonlyMap<string, StructureConstraint>,
      slotGroups: slotGroups as ReadonlyMap<string, SlotGroup>,
      structureToSlot: structureToSlot as ReadonlyMap<string, string>,
      roots: roots as ReadonlyMap<string, SlotGroup>,
      childrenOf: childrenOf as ReadonlyMap<string, ReadonlyMap<string, SlotGroup>>,
    };
  }

  function reset(): void {
    byId = new Map();
    slotGroups = new Map();
    structureToSlot = new Map();
    roots = new Map();
    childrenOf = new Map();
  }

  return { step, current, reset };
}