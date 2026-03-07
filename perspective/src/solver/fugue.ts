// === Native Fugue Solver ===
// Implements the Fugue sequence CRDT ordering algorithm adapted for
// CnId-based structure(seq) constraints.
//
// This is the native (host-language) optimization described in §B.7.
// It MUST produce identical ordering to the Fugue Datalog rules for
// the simplified subset, and handles the full algorithm (recursive
// tree walk, originRight disambiguation) that the simplified Datalog
// rules cannot express.
//
// Key concepts (from Weidner & Kleppmann 2023):
// - Each seq element has a CnId, originLeft, and originRight.
// - originLeft determines the tree structure (parent-child relationship).
// - Sibling ordering uses Fugue's interleaving rules:
//   1. Same originRight: lower peer ID goes left.
//   2. Different originRight: element whose originRight is further left goes first.
// - Depth-first traversal of the tree produces the total order.
//
// Adapted from reference/fugue-v0.ts for CnId-based structure constraints.
//
// See unified-engine.md §8.2, §B.4, §B.7.

import type {
  CnId,
  StructureConstraint,
  PeerID,
} from '../kernel/types.js';
import { cnIdKey, cnIdCompare } from '../kernel/cnid.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A node in the Fugue tree representing a sequence element.
 */
export interface FugueNode {
  /** The structure constraint's CnId (unique element identity). */
  readonly id: CnId;

  /** CnId key string for Map lookups. */
  readonly idKey: string;

  /** CnId of the parent seq container. */
  readonly parent: CnId;

  /** Element to the left at insertion time (null = start of sequence). */
  readonly originLeft: CnId | null;

  /** Element to the right at insertion time (null = end of sequence). */
  readonly originRight: CnId | null;

  /** Peer ID of the asserting agent. */
  readonly peer: PeerID;
}

/**
 * Internal tree node used during construction.
 */
interface TreeNode {
  readonly node: FugueNode;
  readonly children: TreeNode[];
}

/**
 * Result of ordering sequence elements within a single parent container.
 */
export interface FugueOrderResult {
  /** Parent container CnId. */
  readonly parent: CnId;

  /** Ordered array of FugueNodes (total order for the sequence). */
  readonly ordered: readonly FugueNode[];
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

/**
 * Build FugueNodes from active seq structure constraints for a given parent.
 *
 * @param seqConstraints - Seq structure constraints that share the same parent.
 * @returns Array of FugueNodes.
 */
export function buildFugueNodes(
  seqConstraints: Iterable<StructureConstraint>,
): FugueNode[] {
  const nodes: FugueNode[] = [];

  for (const sc of seqConstraints) {
    if (sc.payload.kind !== 'seq') continue;

    nodes.push({
      id: sc.id,
      idKey: cnIdKey(sc.id),
      parent: sc.payload.parent,
      originLeft: sc.payload.originLeft,
      originRight: sc.payload.originRight,
      peer: sc.id.peer,
    });
  }

  return nodes;
}

// ---------------------------------------------------------------------------
// Ordering
// ---------------------------------------------------------------------------

/**
 * Compute the total order of sequence elements using the Fugue algorithm.
 *
 * The algorithm:
 * 1. Build a tree where each element is a child of its originLeft.
 *    Elements with originLeft=null are children of a virtual root.
 * 2. Sort siblings at each level using Fugue interleaving rules.
 * 3. Depth-first traversal produces the total order.
 *
 * @param nodes - FugueNodes to order (all sharing the same parent container).
 * @returns Ordered array of FugueNodes.
 */
export function orderFugueNodes(nodes: readonly FugueNode[]): readonly FugueNode[] {
  if (nodes.length === 0) return [];
  if (nodes.length === 1) return nodes;

  // Build lookup map.
  const nodeMap = new Map<string, FugueNode>();
  for (const n of nodes) {
    nodeMap.set(n.idKey, n);
  }

  // Build tree: group children by originLeft.
  const rootChildren: TreeNode[] = [];
  const childrenMap = new Map<string, TreeNode[]>();

  for (const node of nodes) {
    const treeNode: TreeNode = { node, children: [] };

    if (node.originLeft === null) {
      // Child of virtual root (beginning of sequence).
      rootChildren.push(treeNode);
    } else {
      const parentKey = cnIdKey(node.originLeft);
      let siblings = childrenMap.get(parentKey);
      if (siblings === undefined) {
        siblings = [];
        childrenMap.set(parentKey, siblings);
      }
      siblings.push(treeNode);
    }
  }

  // Sort siblings at each level and traverse.
  sortSiblings(rootChildren, nodeMap);

  const result: FugueNode[] = [];
  traverse(rootChildren, childrenMap, nodeMap, result);

  return result;
}

/**
 * Compute the Fugue ordering for a set of seq structure constraints
 * grouped by parent.
 *
 * @param seqConstraints - Seq structure constraints for a single parent.
 * @param parent - The parent container's CnId.
 * @returns FugueOrderResult with the total order.
 */
export function computeFugueOrder(
  seqConstraints: Iterable<StructureConstraint>,
  parent: CnId,
): FugueOrderResult {
  const nodes = buildFugueNodes(seqConstraints);
  const ordered = orderFugueNodes(nodes);
  return { parent, ordered };
}

// ---------------------------------------------------------------------------
// Fugue Interleaving Sort
// ---------------------------------------------------------------------------

/**
 * Sort sibling tree nodes using Fugue's interleaving rules.
 *
 * Rules:
 * 1. If two elements have the same originRight, lower peer ID goes left.
 * 2. If different originRight, the element whose originRight is further
 *    left (by preliminary position) goes first.
 *
 * We first build a preliminary position map using simple heuristics,
 * then use it for originRight position comparisons.
 */
function sortSiblings(
  siblings: TreeNode[],
  nodeMap: ReadonlyMap<string, FugueNode>,
): void {
  if (siblings.length <= 1) return;

  // Build preliminary position map for originRight comparisons.
  const positionMap = buildPositionMap(siblings, nodeMap);

  siblings.sort((a, b) =>
    compareFugueNodes(a.node, b.node, nodeMap, positionMap),
  );
}

/**
 * Build a preliminary position map for siblings.
 *
 * Establishes a consistent ordering that can be used to compare
 * originRight positions. Elements with the same originRight are
 * ordered by peer (lower first), then by counter.
 */
function buildPositionMap(
  siblings: TreeNode[],
  nodeMap: ReadonlyMap<string, FugueNode>,
): Map<string, number> {
  const posMap = new Map<string, number>();

  // Sort by preliminary rules to assign positions.
  const preliminary = [...siblings].sort((a, b) => {
    const an = a.node;
    const bn = b.node;

    // Same originRight → lower peer goes first.
    if (cnIdNullableEquals(an.originRight, bn.originRight)) {
      if (an.peer !== bn.peer) {
        return an.peer < bn.peer ? -1 : 1;
      }
      return an.id.counter - bn.id.counter;
    }

    // null originRight = end of list → goes after non-null.
    if (an.originRight === null) return 1;
    if (bn.originRight === null) return -1;

    // Compare originRight positions.
    const aRight = nodeMap.get(cnIdKey(an.originRight));
    const bRight = nodeMap.get(cnIdKey(bn.originRight));

    if (aRight !== undefined && bRight !== undefined) {
      // Same peer originRight: lower counter = further left.
      if (aRight.peer === bRight.peer) {
        if (aRight.id.counter !== bRight.id.counter) {
          return aRight.id.counter - bRight.id.counter;
        }
      } else {
        // Different peers: use peer ID as stable tiebreaker.
        return aRight.peer < bRight.peer ? -1 : 1;
      }
    }

    // Fall back to element's own identity.
    if (an.peer !== bn.peer) {
      return an.peer < bn.peer ? -1 : 1;
    }
    return an.id.counter - bn.id.counter;
  });

  for (let i = 0; i < preliminary.length; i++) {
    posMap.set(preliminary[i]!.node.idKey, i);
  }

  return posMap;
}

/**
 * Compare two Fugue nodes for ordering.
 *
 * This implements the Fugue interleaving algorithm:
 * 1. Same originRight → lower peer ID goes first.
 * 2. Different originRight → element whose originRight is further left
 *    (by position map) goes first.
 */
function compareFugueNodes(
  a: FugueNode,
  b: FugueNode,
  nodeMap: ReadonlyMap<string, FugueNode>,
  positionMap: Map<string, number>,
): number {
  // Same element.
  if (a.idKey === b.idKey) return 0;

  // Same originRight → lower peer ID goes left.
  if (cnIdNullableEquals(a.originRight, b.originRight)) {
    if (a.peer !== b.peer) {
      return a.peer < b.peer ? -1 : 1;
    }
    return a.id.counter - b.id.counter;
  }

  // Different originRight → compare their positions.
  if (a.originRight === null) return 1;
  if (b.originRight === null) return -1;

  const posA = getOriginRightPosition(a.originRight, nodeMap, positionMap);
  const posB = getOriginRightPosition(b.originRight, nodeMap, positionMap);

  if (posA !== posB) {
    return posA - posB;
  }

  // Same position — fall back to identity.
  if (a.peer !== b.peer) {
    return a.peer < b.peer ? -1 : 1;
  }
  return a.id.counter - b.id.counter;
}

/**
 * Get the position of an originRight element.
 *
 * Checks the position map first (for siblings), then falls back
 * to a tree-depth heuristic for non-siblings.
 */
function getOriginRightPosition(
  id: CnId,
  nodeMap: ReadonlyMap<string, FugueNode>,
  positionMap: Map<string, number>,
): number {
  const idStr = cnIdKey(id);

  // Check if it's a sibling.
  const siblingPos = positionMap.get(idStr);
  if (siblingPos !== undefined) return siblingPos;

  // Not a sibling — use depth + counter heuristic.
  const node = nodeMap.get(idStr);
  if (node === undefined) return Number.MAX_SAFE_INTEGER;

  let depth = 0;
  let current: FugueNode | undefined = node;
  while (current !== undefined && current.originLeft !== null) {
    depth++;
    current = nodeMap.get(cnIdKey(current.originLeft));
    if (depth > 10000) break; // Safety bound.
  }

  return -1000000 + depth * 10000 + node.id.counter;
}

// ---------------------------------------------------------------------------
// Tree Traversal
// ---------------------------------------------------------------------------

/**
 * Depth-first traversal of the Fugue tree to produce total order.
 */
function traverse(
  nodes: readonly TreeNode[],
  childrenMap: Map<string, TreeNode[]>,
  nodeMap: ReadonlyMap<string, FugueNode>,
  result: FugueNode[],
): void {
  for (const treeNode of nodes) {
    // Add this node.
    result.push(treeNode.node);

    // Recursively process children (elements whose originLeft is this node).
    const children = childrenMap.get(treeNode.node.idKey);
    if (children !== undefined && children.length > 0) {
      sortSiblings(children, nodeMap);
      traverse(children, childrenMap, nodeMap, result);
    }
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Check if two nullable CnIds are equal.
 */
function cnIdNullableEquals(a: CnId | null, b: CnId | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.peer === b.peer && a.counter === b.counter;
}