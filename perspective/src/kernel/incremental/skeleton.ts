// === Incremental Skeleton Stage ===
// Maintains a mutable reality tree and applies deltas from the resolution
// stage and structure index stage. Emits `RealityDelta` describing what
// changed in the tree after each step.
//
// Correctness invariant:
//   current() == buildSkeleton(accumulated index, accumulated active, accumulated resolution)
//
// This mirrors the batch `buildSkeleton()` in `kernel/skeleton.ts` but
// maintains state across calls rather than rebuilding from scratch.
//
// Key design decisions:
// - The skeleton accepts typed deltas (ZSet<ResolvedWinner>,
//   ZSet<FugueBeforePair>, StructureIndexDelta) and never calls native
//   solvers. The pipeline composition root is responsible for producing
//   these deltas (see Plan 005 § Phase 7 Design Note).
// - Mutable tree: nodes are mutable internally, exposed as readonly
//   RealityNode via current(). Mutations are tracked and emitted as
//   NodeDelta entries.
// - Path tracking: each node's path from the synthetic root is maintained
//   so that NodeDelta entries carry correct paths.
// - Out-of-order: child structures that arrive before their parent are
//   deferred. When the parent arrives, deferred children are attached
//   recursively (see Architecture § Out-of-Order Arrival Invariant).
// - Seq ordering: maintained via accumulated fugue_before pairs and
//   topological sort. When pairs change, seq children are reordered.
//
// See .plans/005-incremental-kernel-pipeline.md § Phase 7.
// See theory/incremental.md §5.7.

import type {
  CnId,
  Value,
  Policy,
  RealityNode,
  Reality,
} from '../types.js';
import { cnIdKey, createCnId } from '../cnid.js';
import type { SlotGroup, StructureIndex } from '../structure-index.js';
import { getChildrenOfSlotGroup } from '../structure-index.js';
import type { ResolvedWinner, FugueBeforePair } from '../resolve.js';
import { topologicalOrderFromPairs } from '../resolve.js';
import type { ZSet } from '../../base/zset.js';
import { zsetForEach } from '../../base/zset.js';
import type { StructureIndexDelta } from './types.js';
import type { NodeDelta, RealityDelta } from './types.js';
import { realityDeltaFrom, realityDeltaEmpty } from './types.js';

// ---------------------------------------------------------------------------
// Incremental Skeleton Stage
// ---------------------------------------------------------------------------

/**
 * The incremental skeleton stage.
 *
 * Maintains a mutable reality tree as persistent state. Processes
 * resolution deltas and structure index deltas, emitting RealityDelta
 * describing what changed.
 *
 * Follows the three shared conventions:
 *   1. step(Δ_resolved, Δ_fuguePairs, Δ_index) — process deltas, return RealityDelta
 *   2. current() — return the full materialized Reality
 *   3. reset() — return to empty state
 */
export interface IncrementalSkeleton {
  /**
   * Process deltas from resolution and structure index stages.
   *
   * @param deltaResolved - Z-set delta of resolved winners.
   *   weight +1: new or changed winner for a slot
   *   weight −1: removed winner (retraction)
   * @param deltaFuguePairs - Z-set delta of Fugue ordering pairs.
   *   weight +1: new ordering constraint
   *   weight −1: removed ordering constraint
   * @param deltaIndex - Structure index delta (new/modified slot groups).
   * @returns RealityDelta describing what changed in the tree.
   */
  step(
    deltaResolved: ZSet<ResolvedWinner>,
    deltaFuguePairs: ZSet<FugueBeforePair>,
    deltaIndex: StructureIndexDelta,
  ): RealityDelta;

  /**
   * Return the current accumulated Reality tree.
   */
  current(): Reality;

  /**
   * Reset to empty state.
   */
  reset(): void;
}

// ---------------------------------------------------------------------------
// Mutable Node
// ---------------------------------------------------------------------------

/**
 * Internal mutable representation of a reality node.
 * Exposed as readonly RealityNode via snapshot().
 */
interface MutableNode {
  id: CnId;
  policy: Policy;
  /** For map parents: keyed by childKey. For seq parents: keyed by positional index string. */
  children: Map<string, MutableNode>;
  value: Value | undefined;
  /** The slot identity this node represents. */
  slotId: string;
  /** Path from synthetic root (array of child keys). */
  path: readonly string[];
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Create a new incremental skeleton stage.
 *
 * @param getIndex - Function returning the current accumulated StructureIndex.
 *   Called during step() to look up structural relationships.
 */
export function createIncrementalSkeleton(
  getIndex: () => StructureIndex,
): IncrementalSkeleton {
  // --- Persistent state ---

  // The synthetic root node.
  let syntheticRoot: MutableNode = makeSyntheticRoot();

  // Index: slotId → MutableNode for O(1) lookup.
  let nodeBySlot = new Map<string, MutableNode>();

  // Index: slotId → parent MutableNode for O(1) parent lookup.
  let parentBySlot = new Map<string, MutableNode>();

  // Accumulated winners: slotId → ResolvedWinner.
  let accWinners = new Map<string, ResolvedWinner>();

  // Accumulated fugue pairs: parentKey → FugueBeforePair[].
  let accFuguePairs = new Map<string, FugueBeforePair[]>();

  // Set of parentKeys whose seq ordering needs recomputation.
  // Collected during pair processing, applied after all deltas.
  let seqParentsToReorder = new Set<string>();

  // Track which slots have been added as nodes. This differs from
  // nodeBySlot because a slot's node may not yet exist if its
  // parent hasn't arrived.
  let slotGroupsSeen = new Set<string>();

  // --- Internal helpers ---

  function makeSyntheticRoot(): MutableNode {
    return {
      id: createCnId('__reality__', 0),
      policy: 'map',
      children: new Map(),
      value: undefined,
      slotId: '__root__',
      path: [],
    };
  }

  /**
   * Snapshot a mutable node tree into a readonly RealityNode tree.
   */
  function snapshot(node: MutableNode): RealityNode {
    const children = new Map<string, RealityNode>();
    for (const [key, child] of node.children) {
      children.set(key, snapshot(child));
    }
    return {
      id: node.id,
      policy: node.policy,
      children,
      value: node.value,
    };
  }

  /**
   * Find or create the mutable node for a slot group.
   * Attaches it to its parent if the parent exists.
   * Returns null if the parent doesn't exist yet (deferred).
   */
  function ensureNode(
    group: SlotGroup,
    changes: NodeDelta[],
  ): MutableNode | null {
    // Already exists?
    const existing = nodeBySlot.get(group.slotId);
    if (existing !== undefined) return existing;

    const representative = group.structures[0]!;
    const payload = representative.payload;

    if (payload.kind === 'root') {
      // Root node — parent is the synthetic root.
      const node: MutableNode = {
        id: representative.id,
        policy: group.policy,
        children: new Map(),
        value: undefined,
        slotId: group.slotId,
        path: [payload.containerId],
      };

      nodeBySlot.set(group.slotId, node);
      parentBySlot.set(group.slotId, syntheticRoot);
      syntheticRoot.children.set(payload.containerId, node);

      // Emit nodeAdded for the root container
      changes.push({
        kind: 'nodeAdded',
        path: node.path,
        node: snapshot(node),
      });

      // Check for deferred children
      attachDeferredChildren(node, group, changes);

      return node;
    }

    // Map or seq child — find the parent node.
    const parentKey = cnIdKey(payload.parent);
    const index = getIndex();

    // The parent is a structure CnId. We need to find which slot
    // it belongs to, then find the node for that slot.
    const parentSlotId = index.structureToSlot.get(parentKey);
    if (parentSlotId === undefined) {
      // Parent structure not yet in the index — defer.
      return null;
    }

    const parentNode = nodeBySlot.get(parentSlotId);
    if (parentNode === undefined) {
      // Parent slot is known but its node doesn't exist yet — defer.
      return null;
    }

    // Create the node.
    const childKeyStr = group.childKey;
    const parentPath = parentNode.path;

    let node: MutableNode;

    if (payload.kind === 'map') {
      const nodePath = [...parentPath, childKeyStr];
      node = {
        id: representative.id,
        policy: group.policy,
        children: new Map(),
        value: undefined,
        slotId: group.slotId,
        path: nodePath,
      };

      nodeBySlot.set(group.slotId, node);
      parentBySlot.set(group.slotId, parentNode);

      // Apply winner if one exists for this slot.
      const winner = accWinners.get(group.slotId);
      if (winner !== undefined) {
        node.value = winner.content;
      }

      // For map children: only add to parent if has value or children.
      // null value means "deleted" — exclude from reality.
      if (node.value !== null || node.children.size > 0) {
        if (node.value !== undefined || node.children.size > 0) {
          parentNode.children.set(childKeyStr, node);
          changes.push({
            kind: 'childAdded',
            path: parentPath,
            key: childKeyStr,
            child: snapshot(node),
          });
        }
      }

      // Check for deferred children
      attachDeferredChildren(node, group, changes);

      return node;
    }

    // Seq child — don't add to parent's children map directly here.
    // Seq children are managed by reorderSeqChildren which handles
    // positional indexing and tombstone filtering.
    const seqNodePath = [...parentPath, '__seq_pending__'];
    node = {
      id: representative.id,
      policy: group.policy,
      children: new Map(),
      value: undefined,
      slotId: group.slotId,
      path: seqNodePath,
    };

    nodeBySlot.set(group.slotId, node);
    parentBySlot.set(group.slotId, parentNode);

    // Apply winner if one exists for this slot.
    const winner = accWinners.get(group.slotId);
    if (winner !== undefined) {
      node.value = winner.content;
    }

    // Mark the seq parent for reordering.
    // We need the parent's structure CnId key(s) to look up pairs.
    const parentGroup = index.slotGroups.get(parentSlotId);
    if (parentGroup !== undefined) {
      for (const psc of parentGroup.structures) {
        seqParentsToReorder.add(cnIdKey(psc.id));
      }
    }

    // Check for deferred children of THIS seq element
    attachDeferredChildren(node, group, changes);

    return node;
  }

  /**
   * When a node is created, check the accumulated structure index for
   * children that already exist but couldn't be attached because this
   * parent hadn't arrived yet. Recursively attach them.
   */
  function attachDeferredChildren(
    parentNode: MutableNode,
    parentGroup: SlotGroup,
    changes: NodeDelta[],
  ): void {
    const index = getIndex();
    const childSlotGroups = getChildrenOfSlotGroup(index, parentGroup);

    if (childSlotGroups.size === 0) return;

    // Determine child kind from first child.
    const firstChild = childSlotGroups.values().next().value!;
    const childKind = firstChild.structures[0]!.payload.kind;

    if (childKind === 'seq') {
      // For seq children, collect all and mark for reordering.
      for (const childGroup of childSlotGroups.values()) {
        if (!nodeBySlot.has(childGroup.slotId)) {
          // Create the node (but don't add to parent — reorder handles it).
          const childRep = childGroup.structures[0]!;
          const childNode: MutableNode = {
            id: childRep.id,
            policy: childGroup.policy,
            children: new Map(),
            value: undefined,
            slotId: childGroup.slotId,
            path: [...parentNode.path, '__seq_pending__'],
          };

          nodeBySlot.set(childGroup.slotId, childNode);
          parentBySlot.set(childGroup.slotId, parentNode);

          // Apply winner if exists.
          const winner = accWinners.get(childGroup.slotId);
          if (winner !== undefined) {
            childNode.value = winner.content;
          }

          // Recursively check for deferred children of this child.
          attachDeferredChildren(childNode, childGroup, changes);
        }
      }

      // Mark for reordering.
      for (const psc of parentGroup.structures) {
        seqParentsToReorder.add(cnIdKey(psc.id));
      }
    } else {
      // Map children — create each one.
      for (const childGroup of childSlotGroups.values()) {
        if (!nodeBySlot.has(childGroup.slotId)) {
          ensureNode(childGroup, changes);
        }
      }
    }
  }

  /**
   * Reorder seq children for a given parent structure CnId key.
   * Uses accumulated fugue pairs and topological sort.
   * Emits appropriate deltas (childAdded, childRemoved, childrenReordered).
   */
  function reorderSeqChildren(
    parentStructureKey: string,
    changes: NodeDelta[],
  ): void {
    const index = getIndex();

    // Find the parent slot.
    const parentSlotId = index.structureToSlot.get(parentStructureKey);
    if (parentSlotId === undefined) return;

    const parentNode = nodeBySlot.get(parentSlotId);
    if (parentNode === undefined) return;

    const parentGroup = index.slotGroups.get(parentSlotId);
    if (parentGroup === undefined) return;

    // Collect all seq child slot groups.
    const childSlotGroups = getChildrenOfSlotGroup(index, parentGroup);
    if (childSlotGroups.size === 0) return;

    // Collect all seq element keys and their slot groups.
    const allElementKeys: string[] = [];
    const groupByIdKey = new Map<string, SlotGroup>();

    for (const cg of childSlotGroups.values()) {
      for (const sc of cg.structures) {
        const idKey = cnIdKey(sc.id);
        allElementKeys.push(idKey);
        groupByIdKey.set(idKey, cg);
      }
    }

    if (allElementKeys.length === 0) return;

    // Get accumulated pairs for this parent.
    const pairs = accFuguePairs.get(parentStructureKey) ?? [];

    // Compute ordering via topological sort.
    const orderedKeys = topologicalOrderFromPairs(pairs, allElementKeys);

    // Snapshot old children keys for diff.
    const oldChildKeys = Array.from(parentNode.children.keys());
    const oldChildByKey = new Map(parentNode.children);

    // Build new children map — only include non-tombstone elements.
    const newChildren = new Map<string, MutableNode>();
    let posIndex = 0;

    for (const idKey of orderedKeys) {
      const cg = groupByIdKey.get(idKey);
      if (cg === undefined) continue;

      const childNode = nodeBySlot.get(cg.slotId);
      if (childNode === undefined) continue;

      // Tombstone check: seq elements without a value are excluded.
      const winner = accWinners.get(cg.slotId);
      if (winner === undefined) continue;
      if (childNode.value === undefined) continue;

      const posKey = String(posIndex);
      const newPath = [...parentNode.path, posKey];

      // Update the child's path.
      updatePaths(childNode, newPath);

      newChildren.set(posKey, childNode);
      posIndex++;
    }

    // Compute deltas by comparing old and new.
    const newChildKeys = Array.from(newChildren.keys());

    // Find removed children.
    for (const [oldKey, oldChild] of oldChildByKey) {
      let stillPresent = false;
      for (const [_newKey, newChild] of newChildren) {
        if (newChild.slotId === oldChild.slotId) {
          stillPresent = true;
          break;
        }
      }
      if (!stillPresent) {
        changes.push({
          kind: 'childRemoved',
          path: parentNode.path,
          key: oldKey,
        });
      }
    }

    // Find added children.
    for (const [newKey, newChild] of newChildren) {
      let wasPresent = false;
      for (const [_oldKey, oldChild] of oldChildByKey) {
        if (oldChild.slotId === newChild.slotId) {
          wasPresent = true;
          break;
        }
      }
      if (!wasPresent) {
        changes.push({
          kind: 'childAdded',
          path: parentNode.path,
          key: newKey,
          child: snapshot(newChild),
        });
      }
    }

    // Check for reordering (same set of slots but different positions).
    if (
      oldChildKeys.length === newChildKeys.length &&
      oldChildKeys.length > 0
    ) {
      // Build old slot order and new slot order.
      const oldSlotOrder = oldChildKeys
        .map((k) => oldChildByKey.get(k)?.slotId)
        .filter(Boolean);
      const newSlotOrder = newChildKeys
        .map((k) => newChildren.get(k)?.slotId)
        .filter(Boolean);

      const orderChanged =
        oldSlotOrder.length === newSlotOrder.length &&
        oldSlotOrder.some((s, i) => s !== newSlotOrder[i]);

      if (orderChanged) {
        changes.push({
          kind: 'childrenReordered',
          path: parentNode.path,
          keys: newChildKeys,
        });
      }
    }

    // Replace parent's children.
    parentNode.children = newChildren;
  }

  /**
   * Recursively update paths for a node and all its descendants.
   */
  function updatePaths(node: MutableNode, newPath: readonly string[]): void {
    node.path = newPath;
    for (const [key, child] of node.children) {
      updatePaths(child, [...newPath, key]);
    }
  }

  /**
   * Handle a winner change for a slot.
   */
  function applyWinnerChange(
    slotId: string,
    newWinner: ResolvedWinner | undefined,
    changes: NodeDelta[],
  ): void {
    const node = nodeBySlot.get(slotId);
    if (node === undefined) return;

    const oldValue = node.value;
    const newValue = newWinner !== undefined ? newWinner.content : undefined;

    // No actual change?
    if (oldValue === newValue) return;

    // For seq nodes, tombstone/untombstone is handled by reorderSeqChildren.
    // Just update the value here; the parent reorder will handle visibility.
    const parentNode = parentBySlot.get(slotId);

    // Determine if this is a seq child.
    const index = getIndex();
    const group = index.slotGroups.get(slotId);
    const isSeqChild =
      group !== undefined &&
      group.structures[0]!.payload.kind === 'seq';

    node.value = newValue;

    if (isSeqChild) {
      // Mark the seq parent for reordering (handles visibility).
      if (parentNode !== undefined && group !== undefined) {
        const parentPayload = group.structures[0]!.payload;
        if (parentPayload.kind === 'seq') {
          seqParentsToReorder.add(cnIdKey(parentPayload.parent));
        }
      }
    } else {
      // Map node — emit valueChanged.
      // Also handle map child visibility (null value + no children = removed).
      if (node.path.length > 0) {
        // Check if this is a map child that should be added/removed from parent.
        if (parentNode !== undefined && group !== undefined) {
          const childKeyStr = group.childKey;
          const isInParent = parentNode.children.has(childKeyStr);
          const shouldBeInParent =
            (newValue !== null && newValue !== undefined) ||
            node.children.size > 0;

          if (isInParent && !shouldBeInParent) {
            // Remove from parent.
            parentNode.children.delete(childKeyStr);
            changes.push({
              kind: 'childRemoved',
              path: parentNode.path,
              key: childKeyStr,
            });
            return;
          } else if (!isInParent && shouldBeInParent) {
            // Add to parent.
            parentNode.children.set(childKeyStr, node);
            changes.push({
              kind: 'childAdded',
              path: parentNode.path,
              key: childKeyStr,
              child: snapshot(node),
            });
            return;
          }
        }

        changes.push({
          kind: 'valueChanged',
          path: node.path,
          oldValue,
          newValue,
        });
      } else {
        // Synthetic root or root container — just emit valueChanged.
        changes.push({
          kind: 'valueChanged',
          path: node.path,
          oldValue,
          newValue,
        });
      }
    }
  }

  // --- Public interface ---

  function step(
    deltaResolved: ZSet<ResolvedWinner>,
    deltaFuguePairs: ZSet<FugueBeforePair>,
    deltaIndex: StructureIndexDelta,
  ): RealityDelta {
    const changes: NodeDelta[] = [];

    // Clear reorder set for this step.
    seqParentsToReorder = new Set();

    // --- Phase 1: Process structure index delta ---
    // New/modified slot groups may create new nodes in the tree.

    if (!deltaIndex.isEmpty) {
      for (const group of deltaIndex.updates.values()) {
        slotGroupsSeen.add(group.slotId);
        ensureNode(group, changes);
      }
    }

    // --- Phase 2: Process winner deltas ---
    // Update accumulated winners and apply to existing nodes.

    zsetForEach(deltaResolved, (entry, _key) => {
      const winner = entry.element;
      const weight = entry.weight;

      if (weight > 0) {
        // New or changed winner.
        accWinners.set(winner.slotId, winner);
        applyWinnerChange(winner.slotId, winner, changes);
      } else if (weight < 0) {
        // Removed winner (retraction).
        accWinners.delete(winner.slotId);
        applyWinnerChange(winner.slotId, undefined, changes);
      }
    });

    // --- Phase 3: Process fugue pair deltas ---
    // Update accumulated pairs and mark affected parents for reordering.

    zsetForEach(deltaFuguePairs, (entry, _key) => {
      const pair = entry.element;
      const weight = entry.weight;

      if (weight > 0) {
        // New pair.
        let pairs = accFuguePairs.get(pair.parentKey);
        if (pairs === undefined) {
          pairs = [];
          accFuguePairs.set(pair.parentKey, pairs);
        }
        pairs.push(pair);
        seqParentsToReorder.add(pair.parentKey);
      } else if (weight < 0) {
        // Removed pair.
        const pairs = accFuguePairs.get(pair.parentKey);
        if (pairs !== undefined) {
          const idx = pairs.findIndex(
            (p) => p.a === pair.a && p.b === pair.b && p.parentKey === pair.parentKey,
          );
          if (idx !== -1) {
            pairs.splice(idx, 1);
            if (pairs.length === 0) {
              accFuguePairs.delete(pair.parentKey);
            }
          }
          seqParentsToReorder.add(pair.parentKey);
        }
      }
    });

    // --- Phase 4: Reorder seq children for affected parents ---

    for (const parentKey of seqParentsToReorder) {
      reorderSeqChildren(parentKey, changes);
    }

    if (changes.length === 0) return realityDeltaEmpty();
    return realityDeltaFrom(changes);
  }

  function current(): Reality {
    return { root: snapshot(syntheticRoot) };
  }

  function reset(): void {
    syntheticRoot = makeSyntheticRoot();
    nodeBySlot = new Map();
    parentBySlot = new Map();
    accWinners = new Map();
    accFuguePairs = new Map();
    seqParentsToReorder = new Set();
    slotGroupsSeen = new Set();
  }

  return { step, current, reset };
}