// === Structure Index ===
// Builds indexes over active structure constraints that both projection.ts
// and skeleton.ts consume. This is Layer 0 (kernel) logic — slot identity
// derives from policy semantics (§8) and must not be expressible as a
// retractable rule.
//
// Core responsibilities:
// (a) Map<cnIdKey, StructureConstraint> for O(1) target lookup.
// (b) Slot identity computation:
//     - Map children: group by (parent, key) — independently-created structures
//       for the same map key are the same logical slot (§8.1).
//     - Seq children: slot = the structure's own CnId (unique by definition).
//     - Root: slot = containerId.
// (c) Parent→children indexes for skeleton construction.
//
// See unified-engine.md §7.2, §8.

import type {
  CnId,
  Constraint,
  StructureConstraint,
  StructurePayload,
  Policy,
} from './types.js';
import { cnIdKey } from './cnid.js';

// ---------------------------------------------------------------------------
// Slot Identity
//
// A slot is the logical identity of a position in the reality tree.
// Multiple structure constraints can map to the same slot (for Map policy).
// The slot is represented as a string key for use in Maps and Datalog facts.
// ---------------------------------------------------------------------------

/**
 * Compute the slot identity string for a structure constraint.
 *
 * - Root: `root:<containerId>`
 * - Map child: `map:<parentCnIdKey>:<key>` — this is the crucial case.
 *   Two peers independently creating structure(map, parent=P, key=K) get
 *   different CnIds but the SAME slot. Their value constraints compete
 *   via LWW for the same logical position.
 * - Seq child: `seq:<ownCnIdKey>` — each seq element is unique.
 */
export function slotId(constraint: StructureConstraint): string {
  const p = constraint.payload;
  switch (p.kind) {
    case 'root':
      return `root:${p.containerId}`;
    case 'map':
      return `map:${cnIdKey(p.parent)}:${p.key}`;
    case 'seq':
      return `seq:${cnIdKey(constraint.id)}`;
  }
}

/**
 * Extract a human-readable child key from a structure constraint.
 *
 * - Root: containerId (used as key in the synthetic root's children map).
 * - Map child: the user-provided key string.
 * - Seq child: the CnId key string (position determined by Fugue ordering).
 */
export function childKey(constraint: StructureConstraint): string {
  const p = constraint.payload;
  switch (p.kind) {
    case 'root':
      return p.containerId;
    case 'map':
      return p.key;
    case 'seq':
      return cnIdKey(constraint.id);
  }
}

// ---------------------------------------------------------------------------
// Slot Group
//
// For Map policy, multiple structure constraints can represent the same
// logical slot. A SlotGroup collects all structure CnIds for a given slot
// and tracks the parent and key for that slot.
// ---------------------------------------------------------------------------

/**
 * A group of structure constraints that represent the same logical slot.
 */
export interface SlotGroup {
  /** The slot identity string. */
  readonly slotId: string;

  /** All structure constraints in this slot group. */
  readonly structures: readonly StructureConstraint[];

  /** All CnId keys for structure constraints in this group. */
  readonly structureKeys: ReadonlySet<string>;

  /** The policy of the parent container (or the container's own policy for roots). */
  readonly policy: Policy;

  /** The child key for this slot (containerId, map key, or seq CnId key). */
  readonly childKey: string;
}

// ---------------------------------------------------------------------------
// Structure Index
// ---------------------------------------------------------------------------

/**
 * An index over active structure constraints.
 *
 * Precomputes slot groupings and parent→child relationships so that
 * projection.ts and skeleton.ts don't need to recompute them.
 */
export interface StructureIndex {
  /** O(1) lookup: CnId key → StructureConstraint. */
  readonly byId: ReadonlyMap<string, StructureConstraint>;

  /** Slot groups indexed by slot identity string. */
  readonly slotGroups: ReadonlyMap<string, SlotGroup>;

  /** Mapping from structure CnId key → slot identity string. */
  readonly structureToSlot: ReadonlyMap<string, string>;

  /**
   * Root containers indexed by containerId.
   * Each root defines a top-level container in the reality.
   */
  readonly roots: ReadonlyMap<string, SlotGroup>;

  /**
   * Children of a parent node, indexed by parent CnId key.
   * Each entry maps child slot identity → SlotGroup.
   *
   * For map parents: children grouped by (parent, key).
   * For seq parents: each child is its own slot.
   */
  readonly childrenOf: ReadonlyMap<string, ReadonlyMap<string, SlotGroup>>;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Build a StructureIndex from a set of active constraints.
 *
 * Filters to structure constraints internally — callers can pass
 * the full active constraint set.
 *
 * @param activeConstraints - Constraints that have passed Valid(S) and Active(S).
 * @returns The built StructureIndex.
 */
export function buildStructureIndex(
  activeConstraints: Iterable<Constraint>,
): StructureIndex {
  // Step 1: Collect all structure constraints and index by CnId.
  const byId = new Map<string, StructureConstraint>();

  for (const c of activeConstraints) {
    if (c.type === 'structure') {
      byId.set(cnIdKey(c.id), c);
    }
  }

  // Step 2: Group by slot identity.
  const slotGroupsBuilder = new Map<string, {
    slotId: string;
    structures: StructureConstraint[];
    structureKeys: Set<string>;
    policy: Policy;
    childKey: string;
  }>();

  const structureToSlot = new Map<string, string>();

  for (const sc of byId.values()) {
    const sid = slotId(sc);
    const ckey = childKey(sc);
    const scKey = cnIdKey(sc.id);

    structureToSlot.set(scKey, sid);

    let group = slotGroupsBuilder.get(sid);
    if (group === undefined) {
      group = {
        slotId: sid,
        structures: [],
        structureKeys: new Set(),
        policy: policyOf(sc),
        childKey: ckey,
      };
      slotGroupsBuilder.set(sid, group);
    }
    group.structures.push(sc);
    group.structureKeys.add(scKey);
  }

  // Freeze the groups.
  const slotGroups = new Map<string, SlotGroup>();
  for (const [sid, builder] of slotGroupsBuilder) {
    slotGroups.set(sid, {
      slotId: builder.slotId,
      structures: builder.structures,
      structureKeys: builder.structureKeys,
      policy: builder.policy,
      childKey: builder.childKey,
    });
  }

  // Step 3: Build root and children indexes.
  const roots = new Map<string, SlotGroup>();
  const childrenOf = new Map<string, Map<string, SlotGroup>>();

  for (const group of slotGroups.values()) {
    // Use the first structure constraint to determine the kind.
    // All constraints in a slot group have the same kind (root/map/seq)
    // because the slot identity prefix differs by kind.
    const representative = group.structures[0]!;
    const payload = representative.payload;

    if (payload.kind === 'root') {
      roots.set(payload.containerId, group);
    } else {
      // Map or Seq child — index under parent.
      const parentKey = cnIdKey(payload.parent);
      let children = childrenOf.get(parentKey);
      if (children === undefined) {
        children = new Map();
        childrenOf.set(parentKey, children);
      }
      children.set(group.slotId, group);
    }
  }

  return {
    byId,
    slotGroups,
    structureToSlot,
    roots,
    childrenOf,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/**
 * Look up the structure constraint for a CnId.
 */
export function getStructure(
  index: StructureIndex,
  id: CnId,
): StructureConstraint | undefined {
  return index.byId.get(cnIdKey(id));
}

/**
 * Look up the slot identity for a structure constraint CnId.
 */
export function getSlotId(
  index: StructureIndex,
  structureId: CnId,
): string | undefined {
  return index.structureToSlot.get(cnIdKey(structureId));
}

/**
 * Look up the SlotGroup for a given slot identity string.
 */
export function getSlotGroup(
  index: StructureIndex,
  sid: string,
): SlotGroup | undefined {
  return index.slotGroups.get(sid);
}

/**
 * Get all children slot groups for a given parent structure CnId.
 *
 * Returns an empty map if the parent has no children or doesn't exist.
 * The parent CnId can be any structure constraint in a slot group —
 * we check all structure CnIds within each root/parent group.
 */
export function getChildren(
  index: StructureIndex,
  parentId: CnId,
): ReadonlyMap<string, SlotGroup> {
  const key = cnIdKey(parentId);
  return index.childrenOf.get(key) ?? EMPTY_CHILDREN;
}

const EMPTY_CHILDREN: ReadonlyMap<string, SlotGroup> = new Map();

/**
 * Check whether a given CnId refers to a known structure constraint.
 */
export function hasStructure(index: StructureIndex, id: CnId): boolean {
  return index.byId.has(cnIdKey(id));
}

/**
 * Get all structure constraints that are children of any structure
 * in the given slot group. This is useful when a Map slot has multiple
 * structure constraints (created by different peers) and we need to
 * collect children across all of them.
 */
export function getChildrenOfSlotGroup(
  index: StructureIndex,
  group: SlotGroup,
): ReadonlyMap<string, SlotGroup> {
  // Merge children from all structure CnIds in the group.
  if (group.structures.length === 1) {
    return getChildren(index, group.structures[0]!.id);
  }

  const merged = new Map<string, SlotGroup>();
  for (const sc of group.structures) {
    const children = getChildren(index, sc.id);
    for (const [sid, sg] of children) {
      if (!merged.has(sid)) {
        merged.set(sid, sg);
      }
    }
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Determine the policy for a structure constraint.
 *
 * - Root: the policy declared in the root payload.
 * - Map/Seq: the kind tells us the policy of the child node itself.
 *   A map child IS a map node (it was created with kind='map').
 *   A seq child IS a seq node.
 *
 * Note: This determines the policy of the NODE, not the parent.
 * A map child's own children would be determined by its own structure
 * constraints' kinds.
 */
function policyOf(sc: StructureConstraint): Policy {
  switch (sc.payload.kind) {
    case 'root':
      return sc.payload.policy;
    case 'map':
      // A map child is a node under a map parent.
      // The child itself doesn't have an explicit policy in its payload.
      // Its policy is determined by what kind of children IT has.
      // For slot grouping purposes, we use 'map' as the policy.
      return 'map';
    case 'seq':
      // A seq child is a node under a seq parent.
      return 'seq';
  }
}