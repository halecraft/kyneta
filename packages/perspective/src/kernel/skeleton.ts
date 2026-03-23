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

import { buildFugueNodes, orderFugueNodes } from "../solver/fugue.js"
import type { LWWEntry } from "../solver/lww.js"
import { resolveLWWSlot } from "../solver/lww.js"
import { cnIdKey, createCnId } from "./cnid.js"
import type { ResolutionResult } from "./resolve.js"
import { topologicalOrderFromPairs } from "./resolve.js"
import type { SlotGroup, StructureIndex } from "./structure-index.js"
import { getChildrenOfSlotGroup } from "./structure-index.js"
import type {
  Constraint,
  Reality,
  RealityNode,
  StructureConstraint,
  Value,
  ValueConstraint,
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
 * @param activeConstraints - All active constraints (we filter to values internally).
 * @param resolution - Optional pre-computed resolution from Datalog or native solvers.
 *                     When provided, the skeleton reads winners/ordering from it.
 *                     When absent, falls back to native solvers.
 * @returns The complete Reality tree.
 */
export function buildSkeleton(
  structureIndex: StructureIndex,
  activeConstraints: Iterable<Constraint>,
  resolution?: ResolutionResult,
): Reality {
  // Step 1: Build value index — maps slotId → LWWEntry[] for resolution.
  // Always built: used as fallback when resolution doesn't cover a slot,
  // and needed for seq tombstone detection.
  const valueIndex = buildValueIndex(activeConstraints, structureIndex)

  const ctx: BuildContext = {
    structureIndex,
    valueIndex,
    resolution: resolution ?? null,
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
  readonly valueIndex: ValueIndex
  readonly resolution: ResolutionResult | null
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
type ValueIndex = ReadonlyMap<string, LWWEntry[]>

/**
 * Build the value index from active constraints and the structure index.
 */
function buildValueIndex(
  activeConstraints: Iterable<Constraint>,
  structureIndex: StructureIndex,
): ValueIndex {
  const index = new Map<string, LWWEntry[]>()

  for (const c of activeConstraints) {
    if (c.type !== "value") continue

    const vc = c as ValueConstraint
    const targetKey = cnIdKey(vc.payload.target)
    const slotIdStr = structureIndex.structureToSlot.get(targetKey)

    if (slotIdStr === undefined) {
      // Orphaned value — target structure not found. Skip.
      continue
    }

    const entry: LWWEntry = {
      id: vc.id,
      slotId: slotIdStr,
      content: vc.payload.content,
      lamport: vc.lamport,
      peer: vc.id.peer,
    }

    let entries = index.get(slotIdStr)
    if (entries === undefined) {
      entries = []
      index.set(slotIdStr, entries)
    }
    entries.push(entry)
  }

  return index
}

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
  // Try ResolutionResult first.
  if (ctx.resolution !== null) {
    const winner = ctx.resolution.winners.get(slotId)
    if (winner !== undefined) {
      return winner.content
    }
    // No winner in Datalog result for this slot — the slot has no
    // active value (or the rules didn't derive a winner). Return undefined.
    // But we also check the value index to see if there are entries —
    // if there are entries but no Datalog winner, it means the rules
    // decided no one wins (shouldn't happen with standard LWW rules,
    // but could happen with custom rules).
    const entries = ctx.valueIndex.get(slotId)
    if (entries === undefined || entries.length === 0) {
      return undefined
    }
    // Entries exist but no Datalog winner — return undefined.
    // The rules did not derive a winner for this slot.
    return undefined
  }

  // Fallback: native LWW.
  const entries = ctx.valueIndex.get(slotId)
  if (entries === undefined || entries.length === 0) {
    return undefined
  }
  const winner = resolveLWWSlot(entries)
  return winner !== undefined ? winner.content : undefined
}

/**
 * Check if a slot has any active value entries at all.
 * Used for seq tombstone detection — a seq element without any
 * value entries is a tombstone regardless of resolution strategy.
 */
function slotHasValues(slotId: string, ctx: BuildContext): boolean {
  // If we have a resolution result, check if there's a winner.
  if (ctx.resolution !== null) {
    return ctx.resolution.winners.has(slotId)
  }
  // Fallback: check the value index.
  const entries = ctx.valueIndex.get(slotId)
  return entries !== undefined && entries.length > 0
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
  // If we have a resolution result with Fugue pairs, use topological sort.
  if (ctx.resolution !== null) {
    // Collect all element keys.
    const allElementKeys = seqConstraints.map(sc => cnIdKey(sc.id))

    // Find the parent — all seq constraints in this group share the same parent.
    // biome-ignore lint/style/noNonNullAssertion: seqConstraints is non-empty when called
    const firstPayload = seqConstraints[0]!.payload
    if (firstPayload.kind !== "seq") {
      // Should not happen — we've already filtered to seq.
      return allElementKeys
    }
    const parentKey = cnIdKey(firstPayload.parent)

    // Get the before-pairs for this parent.
    const pairs = ctx.resolution.fuguePairs.get(parentKey)

    if (pairs !== undefined && pairs.length > 0) {
      return topologicalOrderFromPairs(pairs, allElementKeys)
    }

    // No pairs for this parent — might be a single element or no
    // Datalog Fugue rules. Fall through to native solver.
    if (allElementKeys.length <= 1) {
      return allElementKeys
    }

    // Fall back to native for this parent (Datalog rules might not
    // have derived ordering for this specific parent).
  }

  // Fallback: native Fugue solver.
  const fugueNodes = buildFugueNodes(seqConstraints)
  const ordered = orderFugueNodes(fugueNodes)
  return ordered.map(n => n.idKey)
}
