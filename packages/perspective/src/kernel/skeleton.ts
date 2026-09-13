// === Skeleton Builder ===
// Builds the reality tree from the StructureIndex, using either
// Datalog-derived resolution results or native solvers for value
// resolution and sequence ordering.
//
// The skeleton is the structural backbone of the reality — a rooted tree
// where each node has an identity (CnId), a policy, children, and a
// resolved value. The skeleton builder:
//
// 1. Creates a synthetic root node whose children are the top-level
//    containers (one per root structure constraint).
// 2. Recursively builds child nodes using the structure index.
// 3. For Map parents, children are grouped by (parent, key) via slot groups.
// 4. For Seq parents, children are ordered by Fugue interleaving.
// 5. Values are resolved by LWW across all active value constraints
//    targeting any structure in a slot group.
//
// Resolution source (Phase 4.5):
// When a ResolutionResult is provided, the skeleton reads pre-resolved
// winners and Fugue ordering from it — the Datalog evaluator (or native
// solvers packaged as a ResolutionResult) has already done the work.
// When no ResolutionResult is provided, the skeleton falls back to
// calling native solvers directly (legacy/test path).
//
// See unified-engine.md §7.2, §7.3, §8.

import { cnIdKey, createCnId } from "./cnid.js"
import type { ResolutionResult } from "./resolve.js"
import { topologicalOrderFromPairs } from "./resolve.js"
import type { SlotGroup, StructureIndex } from "./structure-index.js"
import { getChildrenOfSlotGroup } from "./structure-index.js"
import type {
  Reality,
  RealityNode,
  StructureConstraint,
  Value,
} from "./types.js"

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a Reality tree from the structure index and active constraints.
 *
 * This is the main entry point for skeleton construction. It:
 * 1. Builds a value index (slot → LWWEntry[]) for fast resolution
 *    (used when no ResolutionResult or as fallback).
 * 2. Creates the synthetic root node.
 * 3. Recursively builds each container and its children.
 *
 * @param structureIndex - Precomputed structure index from valid/active constraints.
 * @param resolution - What the store's rules decided: the winner per slot and
 *                     the before-pairs per sequence parent. Required. The
 *                     skeleton attaches these; it does not resolve anything
 *                     itself, and used to accept no resolution and fall back to
 *                     hand-written solvers, which meant it could disagree with
 *                     the rules.
 * @returns The complete Reality tree.
 */
export function buildSkeleton(
  structureIndex: StructureIndex,
  resolution: ResolutionResult,
): Reality {
  const ctx: BuildContext = {
    structureIndex,
    resolution,
  }

  // Step 2: Build child nodes for each root container.
  const rootChildren = new Map<string, RealityNode>()

  for (const [containerId, rootGroup] of structureIndex.roots) {
    const node = buildNodeFromSlotGroup(rootGroup, ctx)
    rootChildren.set(containerId, node)
  }

  // Step 3: Create the synthetic root.
  // The synthetic root has a well-known CnId that no real agent will produce.
  const syntheticRoot: RealityNode = {
    id: createCnId("__reality__", 0),
    policy: "map",
    children: rootChildren,
    value: undefined,
  }

  return { root: syntheticRoot }
}

// ---------------------------------------------------------------------------
// Build Context
// ---------------------------------------------------------------------------

/**
 * Internal context threaded through all build functions.
 * Avoids passing many arguments through every recursive call.
 */
interface BuildContext {
  readonly structureIndex: StructureIndex
  readonly resolution: ResolutionResult
}

// ---------------------------------------------------------------------------
// Value Index
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Value Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the value for a slot, using the ResolutionResult if available,
 * otherwise falling back to native LWW.
 *
 * @returns The resolved value, or undefined if no value exists for the slot.
 */
function resolveSlotValue(
  slotId: string,
  ctx: BuildContext,
): Value | undefined {
  const winner = ctx.resolution.winners.get(slotId)
  if (winner !== undefined) {
    return winner.content
  }

  // No winner for this slot. That is a legitimate answer, not a gap to fill:
  // the slot may hold no active value, or the store's rules may have declined
  // to pick one (a custom rule set is free to leave a slot unresolved).
  //
  // There used to be a fallback here that ran the hand-written LWW solver
  // whenever no `ResolutionResult` was supplied. Nothing in production ever
  // supplied none — `kernel/pipeline.ts` passes one in every branch — so it
  // served only tests, where it quietly meant they were checking the solver
  // rather than the rules. See `.plans/008-retire-the-native-fast-path.md`.
  return undefined
}

/**
 * Check if a slot has any active value entries at all.
 * Used for seq tombstone detection — a seq element without any
 * value entries is a tombstone regardless of resolution strategy.
 */
function slotHasValues(slotId: string, ctx: BuildContext): boolean {
  return ctx.resolution.winners.has(slotId)
}

// ---------------------------------------------------------------------------
// Node Construction
// ---------------------------------------------------------------------------

/**
 * Build a RealityNode from a SlotGroup.
 *
 * Resolves the value and recursively builds children.
 */
function buildNodeFromSlotGroup(
  group: SlotGroup,
  ctx: BuildContext,
): RealityNode {
  // Use the first structure constraint as the representative for identity.
  const representative = group.structures[0]!

  // Resolve value for this slot.
  const resolvedValue = resolveSlotValue(group.slotId, ctx)

  // Build children based on the parent's policy.
  const children = buildChildren(group, ctx)

  return {
    id: representative.id,
    policy: group.policy,
    children,
    value: resolvedValue,
  }
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
  ctx: BuildContext,
): ReadonlyMap<string, RealityNode> {
  // Collect all child slot groups across all structure constraints in
  // the parent slot group. For Map slots where multiple peers independently
  // created the same (parent, key), we merge their children.
  const childSlotGroups = getChildrenOfSlotGroup(
    ctx.structureIndex,
    parentGroup,
  )

  if (childSlotGroups.size === 0) {
    return EMPTY_CHILDREN
  }

  // Determine whether children are map or seq by inspecting one child.
  // All children of a given parent share the same policy kind (map or seq)
  // because they were created under the same container policy.
  const firstChild = childSlotGroups.values().next().value!
  const childKind = firstChild.structures[0]?.payload.kind

  if (childKind === "seq") {
    return buildSeqChildren(childSlotGroups, ctx)
  } else {
    return buildMapChildren(childSlotGroups, ctx)
  }
}

const EMPTY_CHILDREN: ReadonlyMap<string, RealityNode> = new Map()

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
  ctx: BuildContext,
): ReadonlyMap<string, RealityNode> {
  const children = new Map<string, RealityNode>()

  for (const group of childSlotGroups.values()) {
    const node = buildNodeFromSlotGroup(group, ctx)

    // For Map children, null value means "deleted" — exclude from reality.
    if (node.value === null && node.children.size === 0) {
      continue
    }

    children.set(group.childKey, node)
  }

  return children
}

// ---------------------------------------------------------------------------
// Seq Children
// ---------------------------------------------------------------------------

/**
 * Build children for a Seq parent.
 *
 * Collects all seq structure constraints, orders them using either
 * Datalog-derived `fugue_before` pairs or the native Fugue solver,
 * then builds a RealityNode for each. Children are keyed by their
 * positional index ("0", "1", "2", ...).
 *
 * Seq elements whose value has been retracted (no active value constraint)
 * are structurally present (for ordering) but excluded from the visible
 * children — they are tombstones.
 */
function buildSeqChildren(
  childSlotGroups: ReadonlyMap<string, SlotGroup>,
  ctx: BuildContext,
): ReadonlyMap<string, RealityNode> {
  // Collect all seq structure constraints for ordering.
  const seqConstraints: StructureConstraint[] = []
  const groupByIdKey = new Map<string, SlotGroup>()

  for (const group of childSlotGroups.values()) {
    for (const sc of group.structures) {
      seqConstraints.push(sc)
      groupByIdKey.set(cnIdKey(sc.id), group)
    }
  }

  if (seqConstraints.length === 0) {
    return EMPTY_CHILDREN
  }

  // Determine the ordered sequence of element CnId keys.
  const orderedKeys = orderSeqElements(seqConstraints, ctx)

  // Build RealityNodes in order.
  const children = new Map<string, RealityNode>()
  let index = 0

  for (const idKey of orderedKeys) {
    const group = groupByIdKey.get(idKey)
    if (group === undefined) continue

    // Check if this element has an active value.
    if (!slotHasValues(group.slotId, ctx)) {
      // Seq elements without a value are tombstones — exclude from visible children.
      continue
    }

    const resolvedValue = resolveSlotValue(group.slotId, ctx)
    if (resolvedValue === undefined) {
      // No resolved value (tombstone) — exclude.
      continue
    }

    // Find the structure constraint for this element to get the CnId.
    const sc = seqConstraints.find(s => cnIdKey(s.id) === idKey)
    // biome-ignore lint/style/noNonNullAssertion: group always has at least one structure
    const elementId = sc !== undefined ? sc.id : group.structures[0]!.id

    const childNode: RealityNode = {
      id: elementId,
      policy: "seq",
      children: buildChildren(group, ctx),
      value: resolvedValue,
    }

    children.set(String(index), childNode)
    index++
  }

  return children
}

/**
 * Order seq elements using either Datalog-derived fugue_before pairs
 * or the native Fugue solver.
 *
 * @returns Ordered array of CnId key strings.
 */
function orderSeqElements(
  seqConstraints: readonly StructureConstraint[],
  ctx: BuildContext,
): string[] {
  const allElementKeys = seqConstraints.map(sc => cnIdKey(sc.id))

  // All seq constraints in a group share a parent, so the first one names it.
  // biome-ignore lint/style/noNonNullAssertion: seqConstraints is non-empty when called
  const firstPayload = seqConstraints[0]!.payload
  if (firstPayload.kind !== "seq") {
    // Should not happen — we've already filtered to seq.
    return allElementKeys
  }
  const parentKey = cnIdKey(firstPayload.parent)

  const pairs = ctx.resolution.fuguePairs.get(parentKey)
  if (pairs !== undefined && pairs.length > 0) {
    return topologicalOrderFromPairs(pairs, allElementKeys)
  }

  // A single element needs no ordering.
  if (allElementKeys.length <= 1) {
    return allElementKeys
  }

  // More than one element and no derived ordering.
  //
  // This used to fall through to the hand-written Fugue solver, which quietly
  // supplied an order the store's rules had not asked for. Phase 0 of the
  // retirement plan measured that fallback and found it dead — the default
  // Fugue rules derive before-pairs for every parent with more than one
  // element — so reaching here means the active rule set cannot order this
  // sequence. Saying so is more useful than inventing an order, because the
  // alternative is a reality that no peer running the same rules would agree
  // with. See `.plans/008-retire-the-native-fast-path.md`.
  throw new Error(
    `cannot order sequence under parent ${parentKey}: ${allElementKeys.length} elements, but the store's rules derived no ordering for it`,
  )
}
