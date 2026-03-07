/**
 * Fugue Tree Builder and Interleaving Algorithm
 *
 * Implements the Fugue sequence CRDT ordering algorithm (Weidner & Kleppmann 2023).
 *
 * Key concepts:
 * - Each list element has an OpId, value, originLeft, and originRight
 * - originLeft determines the tree structure (parent-child relationship)
 * - Sibling ordering uses Fugue's interleaving rules:
 *   1. Same originRight: lower peer ID goes left
 *   2. Different originRight: element whose originRight is further left goes first
 *   3. The "visited set" algorithm handles nested/transitive cases
 *
 * This is a constraint-based implementation where elements are represented as
 * SeqElementAssertion constraints rather than mutable spans.
 *
 * Deletion scheme:
 * - Each element has a unique path: [listPath, "elem", opIdToString(elemId)]
 * - Deletion is tracked by adding a `deleted` constraint at the element's path
 * - Multiple constraints can exist at the same element path (seq_element + deleted)
 * - The Fugue tree builder collects deleted paths and marks elements accordingly
 */

import type { Constraint } from "../core/constraint.js";
import type { OpId } from "../core/types.js";
import { opIdEquals, opIdToString } from "../core/types.js";
import type { SeqElementAssertion } from "../core/assertions.js";
import {
	isSeqElementAssertion,
	isDeletedAssertion,
} from "../core/assertions.js";

// ============================================================================
// Types
// ============================================================================

/**
 * A node in the Fugue tree representing a list element.
 */
export interface FugueNode {
	/** Unique identifier for this element (from constraint ID) */
	readonly id: OpId;

	/** The element value */
	readonly value: unknown;

	/** OpId of the element to the left when this was inserted */
	readonly originLeft: OpId | null;

	/** OpId of the element to the right when this was inserted */
	readonly originRight: OpId | null;

	/** Whether this element is deleted (tombstone) */
	readonly isDeleted: boolean;

	/** The constraint that created this element */
	readonly constraint: Constraint;
}

/**
 * Result of building and solving a Fugue tree.
 */
export interface FugueResult {
	/** Ordered array of nodes (including tombstones) */
	readonly allNodes: readonly FugueNode[];

	/** Ordered array of active (non-deleted) nodes */
	readonly activeNodes: readonly FugueNode[];

	/** Ordered array of values (from active nodes only) */
	readonly values: readonly unknown[];

	/** Map from OpId string to node for quick lookup */
	readonly nodeMap: ReadonlyMap<string, FugueNode>;
}

/**
 * Internal tree node used during construction.
 */
interface TreeNode {
	node: FugueNode;
	children: TreeNode[];
}

// ============================================================================
// Fugue Tree Builder
// ============================================================================

/**
 * Build and solve a Fugue tree from a set of constraints.
 *
 * Element path convention:
 * - Each element has path: [...listPath, opIdToString(elemId)]
 * - The element's OpId is encoded in the last path segment
 * - Delete constraints target the same path as the element
 *
 * @param constraints - All constraints for this list (seq_element and deleted)
 * @returns FugueResult with ordered elements
 */
export function buildFugueTree(
	constraints: readonly Constraint[],
): FugueResult {
	// Step 1: Collect all seq_element constraints and build nodes
	const nodeMap = new Map<string, FugueNode>();

	// Track deleted elements by their path (which encodes the element ID)
	// A path like ["list", "alice@0"] indicates element with ID alice@0
	const deletedPaths = new Set<string>();

	// First pass: collect all deleted element paths
	for (const constraint of constraints) {
		if (isDeletedAssertion(constraint.assertion)) {
			// The element being deleted is identified by the constraint's path
			// The last segment of the path is the element's OpId string
			const pathStr = JSON.stringify(constraint.path);
			deletedPaths.add(pathStr);
		}
	}

	// Second pass: build nodes from seq_element constraints
	for (const constraint of constraints) {
		if (isSeqElementAssertion(constraint.assertion)) {
			const assertion = constraint.assertion as SeqElementAssertion;
			const idStr = opIdToString(constraint.id);

			// Check if this element has been deleted
			// The element's path contains its OpId, and delete constraints target that path
			const pathStr = JSON.stringify(constraint.path);
			const isDeleted = deletedPaths.has(pathStr);

			const node: FugueNode = {
				id: constraint.id,
				value: assertion.value,
				originLeft: assertion.originLeft,
				originRight: assertion.originRight,
				isDeleted,
				constraint,
			};

			nodeMap.set(idStr, node);
		}
	}

	// Step 2: Build the tree structure
	// Elements with originLeft=null are children of the virtual "start" node
	// Other elements are children of their originLeft element
	const rootChildren: TreeNode[] = [];
	const childrenMap = new Map<string, TreeNode[]>();

	for (const node of nodeMap.values()) {
		const treeNode: TreeNode = { node, children: [] };

		if (node.originLeft === null) {
			// Child of virtual start
			rootChildren.push(treeNode);
		} else {
			// Child of originLeft
			const parentIdStr = opIdToString(node.originLeft);
			let siblings = childrenMap.get(parentIdStr);
			if (!siblings) {
				siblings = [];
				childrenMap.set(parentIdStr, siblings);
			}
			siblings.push(treeNode);
		}
	}

	// Step 3: Sort siblings at each level using Fugue interleaving rules
	sortSiblings(rootChildren, nodeMap);

	// Recursively sort all children
	const allTreeNodes: TreeNode[] = [];
	collectAllTreeNodes(rootChildren, childrenMap, nodeMap, allTreeNodes);

	// Step 4: Depth-first traversal to produce total order
	const allNodes: FugueNode[] = [];
	traverseTree(rootChildren, childrenMap, nodeMap, allNodes);

	// Step 5: Filter to active nodes
	const activeNodes = allNodes.filter((n) => !n.isDeleted);
	const values = activeNodes.map((n) => n.value);

	return {
		allNodes,
		activeNodes,
		values,
		nodeMap,
	};
}

/**
 * Collect all tree nodes recursively (for sorting children at each level).
 */
function collectAllTreeNodes(
	nodes: TreeNode[],
	childrenMap: Map<string, TreeNode[]>,
	nodeMap: ReadonlyMap<string, FugueNode>,
	result: TreeNode[],
): void {
	for (const treeNode of nodes) {
		result.push(treeNode);
		const idStr = opIdToString(treeNode.node.id);
		const children = childrenMap.get(idStr);
		if (children && children.length > 0) {
			sortSiblings(children, nodeMap);
			collectAllTreeNodes(children, childrenMap, nodeMap, result);
		}
	}
}

/**
 * Sort siblings using Fugue's interleaving rules.
 *
 * Rules (from the Fugue paper):
 * 1. If two elements have the same originRight, lower peer ID goes left
 * 2. If different originRight, the element whose originRight is further left goes first
 *
 * For single-peer sequential inserts, we use insertion order (counter).
 * This handles the common case of unshift operations correctly.
 */
function sortSiblings(
	siblings: TreeNode[],
	nodeMap: ReadonlyMap<string, FugueNode>,
): void {
	if (siblings.length <= 1) return;

	// Build a position map by first sorting using Fugue rules iteratively
	// This handles the dependency between originRight positions
	const positionMap = buildPositionMap(siblings, nodeMap);

	siblings.sort((a, b) =>
		compareFugueNodes(a.node, b.node, nodeMap, positionMap),
	);
}

/**
 * Build a position map for siblings to resolve originRight comparisons.
 *
 * The key insight is that when comparing originRight positions, we need to
 * know the relative order of elements. For elements with same originLeft,
 * their originRight values reference other elements in the tree.
 *
 * We use a stable sort approach: first establish a preliminary order,
 * then use that to compare originRight positions.
 */
function buildPositionMap(
	siblings: TreeNode[],
	nodeMap: ReadonlyMap<string, FugueNode>,
): Map<string, number> {
	const positionMap = new Map<string, number>();

	// First, assign preliminary positions based on simple heuristics
	// Sort by: 1) whether originRight is null (null = later), 2) originRight's counter, 3) peer ID, 4) counter
	const preliminary = [...siblings].sort((a, b) => {
		const aNode = a.node;
		const bNode = b.node;

		// If same originRight, use peer ID tiebreaker (lower goes first)
		if (opIdNullableEquals(aNode.originRight, bNode.originRight)) {
			if (aNode.id.peer !== bNode.id.peer) {
				return aNode.id.peer < bNode.id.peer ? -1 : 1;
			}
			return aNode.id.counter - bNode.id.counter;
		}

		// null originRight means "insert at end" - goes after non-null
		if (aNode.originRight === null) return 1;
		if (bNode.originRight === null) return -1;

		// Compare originRight counters as proxy for position
		// Lower counter means the originRight was created earlier, so it's further left
		// This works for single-peer and properly ordered multi-peer scenarios
		const aRightNode = nodeMap.get(opIdToString(aNode.originRight));
		const bRightNode = nodeMap.get(opIdToString(bNode.originRight));

		if (aRightNode && bRightNode) {
			// Compare by the originRight's insertion time (counter for same peer)
			if (aRightNode.id.peer === bRightNode.id.peer) {
				// Same peer: lower counter = earlier = further left
				if (aRightNode.id.counter !== bRightNode.id.counter) {
					return aRightNode.id.counter - bRightNode.id.counter;
				}
			} else {
				// Different peers: use peer ID as tiebreaker
				if (aRightNode.id.peer !== bRightNode.id.peer) {
					return aRightNode.id.peer < bRightNode.id.peer ? -1 : 1;
				}
			}
		}

		// Fall back to peer ID comparison
		if (aNode.id.peer !== bNode.id.peer) {
			return aNode.id.peer < bNode.id.peer ? -1 : 1;
		}
		return aNode.id.counter - bNode.id.counter;
	});

	// Assign positions
	for (let i = 0; i < preliminary.length; i++) {
		positionMap.set(opIdToString(preliminary[i]!.node.id), i);
	}

	return positionMap;
}

/**
 * Compare two Fugue nodes for ordering.
 *
 * This implements the Fugue interleaving algorithm.
 * Returns negative if a should come before b, positive if after, 0 if equal.
 */
function compareFugueNodes(
	a: FugueNode,
	b: FugueNode,
	nodeMap: ReadonlyMap<string, FugueNode>,
	positionMap: Map<string, number>,
): number {
	// Same element
	if (opIdEquals(a.id, b.id)) {
		return 0;
	}

	// Check if they have the same originRight
	const sameOriginRight = opIdNullableEquals(a.originRight, b.originRight);

	if (sameOriginRight) {
		// Same originRight: lower peer ID goes left (first)
		// This is the opposite of Map LWW where higher peer ID wins
		if (a.id.peer !== b.id.peer) {
			return a.id.peer < b.id.peer ? -1 : 1;
		}
		// Same peer: lower counter goes first (earlier operation)
		return a.id.counter - b.id.counter;
	}

	// Different originRight: compare their positions
	// The element whose originRight is further left goes first

	// If a's originRight is null (end of list), a goes after b
	if (a.originRight === null) {
		return 1;
	}

	// If b's originRight is null (end of list), b goes after a
	if (b.originRight === null) {
		return -1;
	}

	// Both have non-null originRight - compare their positions using the position map
	const posA = getOriginRightPosition(a.originRight, nodeMap, positionMap);
	const posB = getOriginRightPosition(b.originRight, nodeMap, positionMap);

	if (posA !== posB) {
		// Element whose originRight is further left (smaller position) goes first
		return posA - posB;
	}

	// Same position - fall back to peer ID comparison
	if (a.id.peer !== b.id.peer) {
		return a.id.peer < b.id.peer ? -1 : 1;
	}
	return a.id.counter - b.id.counter;
}

/**
 * Get the position of an originRight element.
 *
 * First checks if it's in the current sibling group (position map),
 * then falls back to tree-based position calculation.
 */
function getOriginRightPosition(
	id: OpId,
	nodeMap: ReadonlyMap<string, FugueNode>,
	positionMap: Map<string, number>,
): number {
	const idStr = opIdToString(id);

	// Check if it's in the position map (a sibling)
	const siblingPos = positionMap.get(idStr);
	if (siblingPos !== undefined) {
		return siblingPos;
	}

	// Not a sibling - calculate position based on tree structure
	const node = nodeMap.get(idStr);
	if (!node) {
		// Element not found - treat as very far right
		return Number.MAX_SAFE_INTEGER;
	}

	// Use depth in the originLeft chain plus counter as position estimate
	// Elements deeper in the tree (more originLeft hops) are further right
	let depth = 0;
	let current: FugueNode | undefined = node;

	while (current && current.originLeft) {
		depth++;
		current = nodeMap.get(opIdToString(current.originLeft));
		if (depth > 10000) break; // Prevent infinite loops
	}

	// Combine depth with counter to get a stable ordering
	// Negative depth to put shallower elements first (further left)
	// Add counter to distinguish elements at same depth
	return -1000000 + depth * 10000 + node.id.counter;
}

/**
 * Traverse the tree in depth-first order to produce the final ordering.
 */
function traverseTree(
	nodes: TreeNode[],
	childrenMap: Map<string, TreeNode[]>,
	nodeMap: ReadonlyMap<string, FugueNode>,
	result: FugueNode[],
): void {
	for (const treeNode of nodes) {
		// Add this node
		result.push(treeNode.node);

		// Recursively add children
		const idStr = opIdToString(treeNode.node.id);
		const children = childrenMap.get(idStr);
		if (children && children.length > 0) {
			sortSiblings(children, nodeMap);
			traverseTree(children, childrenMap, nodeMap, result);
		}
	}
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if two nullable OpIds are equal.
 */
function opIdNullableEquals(a: OpId | null, b: OpId | null): boolean {
	if (a === null && b === null) return true;
	if (a === null || b === null) return false;
	return opIdEquals(a, b);
}

/**
 * Find the node for a given OpId.
 */
export function findNode(result: FugueResult, id: OpId): FugueNode | undefined {
	return result.nodeMap.get(opIdToString(id));
}

/**
 * Get the index of an element in the active list.
 *
 * @returns The index, or -1 if not found or deleted
 */
export function getActiveIndex(result: FugueResult, id: OpId): number {
	const idStr = opIdToString(id);
	return result.activeNodes.findIndex((n) => opIdToString(n.id) === idStr);
}

/**
 * Get the element at a given index in the active list.
 *
 * @returns The node, or undefined if index is out of bounds
 */
export function getNodeAtIndex(
	result: FugueResult,
	index: number,
): FugueNode | undefined {
	if (index < 0 || index >= result.activeNodes.length) {
		return undefined;
	}
	return result.activeNodes[index];
}

/**
 * Compute originLeft and originRight for an insert at a given position.
 *
 * This is used by the ListHandle to generate correct seq_element constraints.
 *
 * @param result - Current Fugue tree state
 * @param index - Position to insert at (0 = beginning, length = end)
 * @returns Object with originLeft and originRight OpIds
 */
export function computeInsertOrigins(
	result: FugueResult,
	index: number,
): { originLeft: OpId | null; originRight: OpId | null } {
	const activeNodes = result.activeNodes;
	const len = activeNodes.length;

	// Clamp index to valid range
	const clampedIndex = Math.max(0, Math.min(index, len));

	// originLeft is the element at index - 1 (or null if inserting at start)
	const originLeft =
		clampedIndex > 0 ? activeNodes[clampedIndex - 1]!.id : null;

	// originRight is the element at index (or null if inserting at end)
	const originRight = clampedIndex < len ? activeNodes[clampedIndex]!.id : null;

	return { originLeft, originRight };
}

/**
 * Get the OpId of the element at a given index.
 *
 * Used for deletion operations.
 *
 * @param result - Current Fugue tree state
 * @param index - Index of the element to get
 * @returns The OpId, or undefined if index is out of bounds
 */
export function getIdAtIndex(
	result: FugueResult,
	index: number,
): OpId | undefined {
	const node = getNodeAtIndex(result, index);
	return node?.id;
}
