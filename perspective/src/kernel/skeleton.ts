// === Skeleton Builder ===
// Builds the reality tree from the StructureIndex, using Fugue ordering
// for sequence children and native LWW for value resolution.
//
// The skeleton is the structural backbone of the reality — a rooted tree
// where each node has an identity (CnId), a policy, children, and a
// resolved value. The skeleton builder:
//
// 1. Creates a synthetic root node whose children are the top-level
//    containers (one per root structure constraint).
// 2. Recursively builds child nodes using the structure index.
// 3. For Map parents, children are grouped by (parent, key) via slot groups.
// 4. For Seq parents, children are ordered by the Fugue algorithm.
// 5. Values are resolved by native LWW across all active value constraints
//    targeting any structure in a slot group.
//
// See unified-engine.md §7.2, §7.3, §8.

import type {
  CnId,
  Constraint,
  ValueConstraint,
  Value,
  Policy,
  RealityNode,
  Reality,
} from './types.js';
import { cnIdKey, createCnId } from './cnid.js';
import type { StructureIndex, SlotGroup } from './structure-index.js';
import { getChildrenOfSlotGroup } from './structure-index.js';
import { orderFugueNodes, buildFugueNodes } from '../solver/fugue.js';
import type { LWWEntry } from '../solver/lww.js';
import { resolveLWWSlot } from '../solver/lww.js';
import type { StructureConstraint } from './types.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a Reality tree from the structure index and active constraints.
 *
 * This is the main entry point for skeleton construction. It:
 * 1. Builds a value index (slot → LWWEntry[]) for fast resolution.
 * 2. Creates the synthetic root node.
 * 3. Recursively builds each container and its children.
 *
 * @param structureIndex - Precomputed structure index from active constraints.
 * @param activeConstraints - All active constraints (we filter to values internally).
 * @returns The complete Reality tree.
 */
export function buildSkeleton(
  structureIndex: StructureIndex,
  activeConstraints: Iterable<Constraint>,
): Reality {
  // Step 1: Build value index — maps slotId → LWWEntry[] for resolution.
  const valueIndex = buildValueIndex(activeConstraints, structureIndex);

  // Step 2: Build child nodes for each root container.
  const rootChildren = new Map<string, RealityNode>();

  for (const [containerId, rootGroup] of structureIndex.roots) {
    const node = buildNodeFromSlotGroup(
      rootGroup,
      structureIndex,
      valueIndex,
    );
    rootChildren.set(containerId, node);
  }

  // Step 3: Create the synthetic root.
  // The synthetic root has a well-known CnId that no real agent will produce.
  const syntheticRoot: RealityNode = {
    id: createCnId('__reality__', 0),
    policy: 'map',
    children: rootChildren,
    value: undefined,
  };

  return { root: syntheticRoot };
}

// ---------------------------------------------------------------------------
// Value Index
// ---------------------------------------------------------------------------

/**
 * Maps slotId → array of LWWEntry for value resolution.
 *
 * Each value constraint is joined with the structure index to determine
 * its slot, then collected into the index.
 */
type ValueIndex = ReadonlyMap<string, LWWEntry[]>;

/**
 * Build the value index from active constraints and the structure index.
 */
function buildValueIndex(
  activeConstraints: Iterable<Constraint>,
  structureIndex: StructureIndex,
): ValueIndex {
  const index = new Map<string, LWWEntry[]>();

  for (const c of activeConstraints) {
    if (c.type !== 'value') continue;

    const vc = c as ValueConstraint;
    const targetKey = cnIdKey(vc.payload.target);
    const slotIdStr = structureIndex.structureToSlot.get(targetKey);

    if (slotIdStr === undefined) {
      // Orphaned value — target structure not found. Skip.
      continue;
    }

    const entry: LWWEntry = {
      id: vc.id,
      slotId: slotIdStr,
      content: vc.payload.content,
      lamport: vc.lamport,
      peer: vc.id.peer,
    };

    let entries = index.get(slotIdStr);
    if (entries === undefined) {
      entries = [];
      index.set(slotIdStr, entries);
    }
    entries.push(entry);
  }

  return index;
}

// ---------------------------------------------------------------------------
// Node Construction
// ---------------------------------------------------------------------------

/**
 * Build a RealityNode from a SlotGroup.
 *
 * Resolves the value via LWW and recursively builds children.
 */
function buildNodeFromSlotGroup(
  group: SlotGroup,
  structureIndex: StructureIndex,
  valueIndex: ValueIndex,
): RealityNode {
  // Use the first structure constraint as the representative for identity.
  const representative = group.structures[0]!;

  // Resolve value via LWW across all value constraints for this slot.
  const valueEntries = valueIndex.get(group.slotId);
  const winner = valueEntries !== undefined ? resolveLWWSlot(valueEntries) : undefined;
  const resolvedValue: Value | undefined = winner !== undefined ? winner.content : undefined;

  // Build children based on the parent's policy.
  const children = buildChildren(group, structureIndex, valueIndex);

  return {
    id: representative.id,
    policy: group.policy,
    children,
    value: resolvedValue,
  };
}

/**
 * Build child nodes for a slot group.
 *
 * For Map parents: children are keyed by the map key string, one per
 * unique (parent, key) slot.
 *
 * For Seq parents: children are ordered by the Fugue algorithm. The
 * child key is the positional index as a string (e.g., "0", "1", "2").
 *
 * For Root nodes: children are built according to the root's declared policy.
 * A root with policy 'map' has map children, a root with policy 'seq' has
 * seq children.
 */
function buildChildren(
  parentGroup: SlotGroup,
  structureIndex: StructureIndex,
  valueIndex: ValueIndex,
): ReadonlyMap<string, RealityNode> {
  // Collect all child slot groups across all structure constraints in
  // the parent slot group. For Map slots where multiple peers independently
  // created the same (parent, key), we merge their children.
  const childSlotGroups = getChildrenOfSlotGroup(structureIndex, parentGroup);

  if (childSlotGroups.size === 0) {
    return EMPTY_CHILDREN;
  }

  // Determine whether children are map or seq by inspecting one child.
  // All children of a given parent share the same policy kind (map or seq)
  // because they were created under the same container policy.
  const firstChild = childSlotGroups.values().next().value!;
  const childKind = firstChild.structures[0]!.payload.kind;

  if (childKind === 'seq') {
    return buildSeqChildren(childSlotGroups, structureIndex, valueIndex);
  } else {
    return buildMapChildren(childSlotGroups, structureIndex, valueIndex);
  }
}

const EMPTY_CHILDREN: ReadonlyMap<string, RealityNode> = new Map();

// ---------------------------------------------------------------------------
// Map Children
// ---------------------------------------------------------------------------

/**
 * Build children for a Map parent.
 *
 * Each child slot group has a childKey (the map key string). We build
 * a RealityNode for each and key it by the map key.
 *
 * Map children with a null-resolved value (LWW winner is null) are
 * excluded from the children map — null means "deleted" for maps.
 */
function buildMapChildren(
  childSlotGroups: ReadonlyMap<string, SlotGroup>,
  structureIndex: StructureIndex,
  valueIndex: ValueIndex,
): ReadonlyMap<string, RealityNode> {
  const children = new Map<string, RealityNode>();

  for (const group of childSlotGroups.values()) {
    const node = buildNodeFromSlotGroup(group, structureIndex, valueIndex);

    // For Map children, null value means "deleted" — exclude from reality.
    if (node.value === null && node.children.size === 0) {
      continue;
    }

    children.set(group.childKey, node);
  }

  return children;
}

// ---------------------------------------------------------------------------
// Seq Children
// ---------------------------------------------------------------------------

/**
 * Build children for a Seq parent.
 *
 * Collects all seq structure constraints, orders them using Fugue,
 * then builds a RealityNode for each. Children are keyed by their
 * positional index ("0", "1", "2", ...).
 *
 * Seq elements whose value has been retracted (no active value constraint)
 * are structurally present (for ordering) but excluded from the visible
 * children — they are tombstones.
 */
function buildSeqChildren(
  childSlotGroups: ReadonlyMap<string, SlotGroup>,
  structureIndex: StructureIndex,
  valueIndex: ValueIndex,
): ReadonlyMap<string, RealityNode> {
  // Collect all seq structure constraints for Fugue ordering.
  const seqConstraints: StructureConstraint[] = [];
  const groupByIdKey = new Map<string, SlotGroup>();

  for (const group of childSlotGroups.values()) {
    for (const sc of group.structures) {
      seqConstraints.push(sc);
      groupByIdKey.set(cnIdKey(sc.id), group);
    }
  }

  // Order using Fugue.
  const fugueNodes = buildFugueNodes(seqConstraints);
  const ordered = orderFugueNodes(fugueNodes);

  // Build RealityNodes in order.
  const children = new Map<string, RealityNode>();
  let index = 0;

  for (const fugueNode of ordered) {
    const group = groupByIdKey.get(fugueNode.idKey);
    if (group === undefined) continue;

    // Check if this element has an active value.
    const valueEntries = valueIndex.get(group.slotId);
    const winner = valueEntries !== undefined ? resolveLWWSlot(valueEntries) : undefined;

    // Seq elements without a value are tombstones — exclude from visible children.
    if (winner === undefined) continue;

    const childNode: RealityNode = {
      id: fugueNode.id,
      policy: 'seq',
      children: buildChildren(group, structureIndex, valueIndex),
      value: winner.content,
    };

    children.set(String(index), childNode);
    index++;
  }

  return children;
}