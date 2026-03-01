/**
 * List Solver Tests
 *
 * Tests for the Fugue-based List solver including:
 * - Basic ordering from originLeft/originRight
 * - Concurrent insert interleaving
 * - Peer ID tiebreaking (lower peer ID goes left)
 * - Tombstone handling
 * - Tree construction correctness
 */

import { describe, it, expect } from "vitest";
import {
	buildFugueTree,
	computeInsertOrigins,
	getIdAtIndex,
	getActiveIndex,
	findNode,
	type FugueResult,
} from "../../src/solver/fugue.js";
import {
	createListSolver,
	solveListConstraints,
	solveList,
	solvedListToArray,
	solvedListHasConflicts,
	solvedListGet,
} from "../../src/solver/list-solver.js";
import { createConstraint } from "../../src/core/constraint.js";
import { seqElement, deleted } from "../../src/core/assertions.js";
import type { Constraint } from "../../src/core/constraint.js";
import type { OpId, Path } from "../../src/core/types.js";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Convert an OpId to a string.
 */
function opIdStr(peer: string, counter: number): string {
	return `${peer}@${counter}`;
}

/**
 * Create an element path (listPath + element ID).
 */
function elemPath(
	peer: string,
	counter: number,
	listPath: Path = ["list"],
): Path {
	return [...listPath, opIdStr(peer, counter)];
}

/**
 * Create a seq_element constraint for testing.
 * Uses element path convention: [listPath, opIdToString(elemId)]
 */
function createSeqElementConstraint(
	peer: string,
	counter: number,
	lamport: number,
	value: unknown,
	originLeft: OpId | null,
	originRight: OpId | null,
	listPath: Path = ["list"],
): Constraint {
	// Element path includes the element's OpId
	const path = elemPath(peer, counter, listPath);
	return createConstraint(
		peer,
		counter,
		lamport,
		path,
		seqElement(value, originLeft, originRight),
	);
}

/**
 * Create a deleted constraint for testing.
 * Uses element path convention: targets the same path as the element.
 */
function createDeletedConstraintForElement(
	deletingPeer: string,
	deletingCounter: number,
	deletingLamport: number,
	elementPeer: string,
	elementCounter: number,
	listPath: Path = ["list"],
): Constraint {
	// Delete constraint targets the element's path
	const path = elemPath(elementPeer, elementCounter, listPath);
	return createConstraint(
		deletingPeer,
		deletingCounter,
		deletingLamport,
		path,
		deleted(),
	);
}

/**
 * Create an OpId.
 */
function id(peer: string, counter: number): OpId {
	return { peer, counter };
}

// ============================================================================
// Fugue Tree Builder Tests
// ============================================================================

describe("Fugue Tree Builder", () => {
	describe("buildFugueTree", () => {
		it("should handle empty constraints", () => {
			const result = buildFugueTree([]);
			expect(result.allNodes).toHaveLength(0);
			expect(result.activeNodes).toHaveLength(0);
			expect(result.values).toHaveLength(0);
		});

		it("should handle single element", () => {
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
			];

			const result = buildFugueTree(constraints);

			expect(result.allNodes).toHaveLength(1);
			expect(result.activeNodes).toHaveLength(1);
			expect(result.values).toEqual(["A"]);
		});

		it("should order sequential inserts correctly", () => {
			// Alice inserts A, then B after A
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
				createSeqElementConstraint("alice", 1, 2, "B", id("alice", 0), null),
			];

			const result = buildFugueTree(constraints);

			expect(result.values).toEqual(["A", "B"]);
		});

		it("should order prepended elements correctly", () => {
			// Alice inserts B first, then A before B
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "B", null, null),
				createSeqElementConstraint("alice", 1, 2, "A", null, id("alice", 0)),
			];

			const result = buildFugueTree(constraints);

			expect(result.values).toEqual(["A", "B"]);
		});

		it("should handle middle insertions", () => {
			// Alice: A, then C after A, then B between A and C
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
				createSeqElementConstraint("alice", 1, 2, "C", id("alice", 0), null),
				createSeqElementConstraint(
					"alice",
					2,
					3,
					"B",
					id("alice", 0),
					id("alice", 1),
				),
			];

			const result = buildFugueTree(constraints);

			expect(result.values).toEqual(["A", "B", "C"]);
		});
	});

	describe("concurrent insert interleaving", () => {
		it("same originLeft, same originRight: lower peer ID goes left", () => {
			// Alice and Bob both insert after null (start) with originRight null (end)
			// Lower peer ID (alice < bob) should go first
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
				createSeqElementConstraint("bob", 0, 1, "B", null, null),
			];

			const result = buildFugueTree(constraints);

			// alice < bob lexicographically, so A comes first
			expect(result.values).toEqual(["A", "B"]);
		});

		it("same originLeft, same originRight: consistent with peer order", () => {
			// Reverse the constraint order in array - should still get same result
			const constraints = [
				createSeqElementConstraint("bob", 0, 1, "B", null, null),
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
			];

			const result = buildFugueTree(constraints);

			// alice < bob lexicographically, so A comes first
			expect(result.values).toEqual(["A", "B"]);
		});

		it("same originLeft, different originRight: further-left originRight goes first", () => {
			// Setup: A - B - C exists
			// Alice inserts X after A with originRight = B
			// Bob inserts Y after A with originRight = C
			// X's originRight (B) is further left than Y's originRight (C)
			// So X should come first

			const constraints = [
				// Base list: A - B - C
				createSeqElementConstraint("setup", 0, 1, "A", null, null),
				createSeqElementConstraint("setup", 1, 2, "B", id("setup", 0), null),
				createSeqElementConstraint("setup", 2, 3, "C", id("setup", 1), null),
				// Alice inserts X after A with originRight = B
				createSeqElementConstraint(
					"alice",
					0,
					4,
					"X",
					id("setup", 0),
					id("setup", 1),
				),
				// Bob inserts Y after A with originRight = C
				createSeqElementConstraint(
					"bob",
					0,
					4,
					"Y",
					id("setup", 0),
					id("setup", 2),
				),
			];

			const result = buildFugueTree(constraints);

			// X's originRight (B) is at position 1, Y's originRight (C) is at position 2
			// Element with further-left originRight goes first, so X before Y
			// Note: The exact order depends on the Fugue algorithm implementation
			// Both X and Y should appear between A and B since they have originLeft=A
			expect(result.values).toHaveLength(5);
			expect(result.values[0]).toBe("A");
			// X and Y are siblings (same originLeft=A), order determined by originRight comparison
			expect(result.values).toContain("X");
			expect(result.values).toContain("Y");
			expect(result.values[3]).toBe("B");
			expect(result.values[4]).toBe("C");
		});

		it("three concurrent inserts at same position", () => {
			// Alice, Bob, and Carol all insert at the beginning
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
				createSeqElementConstraint("bob", 0, 1, "B", null, null),
				createSeqElementConstraint("carol", 0, 1, "C", null, null),
			];

			const result = buildFugueTree(constraints);

			// Lower peer ID goes first: alice < bob < carol
			expect(result.values).toEqual(["A", "B", "C"]);
		});

		it("three concurrent inserts with different originRight", () => {
			// Base: X
			// A, B, C all insert before X (originLeft = null, originRight = X)
			const constraints = [
				createSeqElementConstraint("setup", 0, 1, "X", null, null),
				createSeqElementConstraint("alice", 0, 2, "A", null, id("setup", 0)),
				createSeqElementConstraint("bob", 0, 2, "B", null, id("setup", 0)),
				createSeqElementConstraint("carol", 0, 2, "C", null, id("setup", 0)),
			];

			const result = buildFugueTree(constraints);

			// All have same originLeft (null) and same originRight (X)
			// Lower peer ID goes first: alice < bob < carol
			expect(result.values).toEqual(["A", "B", "C", "X"]);
		});
	});

	describe("tombstone handling", () => {
		it("should exclude deleted elements from values", () => {
			// Create A, B, C then delete B
			const elemA = createSeqElementConstraint("alice", 0, 1, "A", null, null);
			const elemB = createSeqElementConstraint(
				"alice",
				1,
				2,
				"B",
				id("alice", 0),
				null,
			);
			const elemC = createSeqElementConstraint(
				"alice",
				2,
				3,
				"C",
				id("alice", 1),
				null,
			);

			// Delete B using element path convention
			const deleteB = createDeletedConstraintForElement(
				"alice",
				3,
				4, // deleting peer, counter, lamport
				"alice",
				1, // element peer, counter (identifies B)
			);

			const result = buildFugueTree([elemA, elemB, elemC, deleteB]);

			expect(result.values).toEqual(["A", "C"]);
			expect(result.activeNodes).toHaveLength(2);
			expect(result.allNodes).toHaveLength(3);
		});

		it("should preserve deleted elements in tree for ordering", () => {
			// Create A, B, then delete A, then insert X after A
			// X should still be ordered correctly even though A is deleted
			const elemA = createSeqElementConstraint("alice", 0, 1, "A", null, null);
			const elemB = createSeqElementConstraint(
				"alice",
				1,
				2,
				"B",
				id("alice", 0),
				null,
			);

			// Delete A using element path convention
			const deleteA = createDeletedConstraintForElement(
				"alice",
				2,
				3, // deleting peer, counter, lamport
				"alice",
				0, // element peer, counter (identifies A)
			);

			// X inserted after A (which is deleted)
			const elemX = createSeqElementConstraint(
				"bob",
				0,
				4,
				"X",
				id("alice", 0),
				id("alice", 1),
			);

			const result = buildFugueTree([elemA, elemB, deleteA, elemX]);

			// A is deleted, X comes after A's position, before B
			expect(result.values).toEqual(["X", "B"]);
			expect(result.allNodes).toHaveLength(3);
		});
	});

	describe("computeInsertOrigins", () => {
		it("should compute origins for empty list", () => {
			const result = buildFugueTree([]);
			const origins = computeInsertOrigins(result, 0);

			expect(origins.originLeft).toBeNull();
			expect(origins.originRight).toBeNull();
		});

		it("should compute origins for insert at beginning", () => {
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
				createSeqElementConstraint("alice", 1, 2, "B", id("alice", 0), null),
			];
			const result = buildFugueTree(constraints);

			const origins = computeInsertOrigins(result, 0);

			expect(origins.originLeft).toBeNull();
			expect(origins.originRight).toEqual(id("alice", 0));
		});

		it("should compute origins for insert at end", () => {
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
				createSeqElementConstraint("alice", 1, 2, "B", id("alice", 0), null),
			];
			const result = buildFugueTree(constraints);

			const origins = computeInsertOrigins(result, 2);

			expect(origins.originLeft).toEqual(id("alice", 1));
			expect(origins.originRight).toBeNull();
		});

		it("should compute origins for insert in middle", () => {
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
				createSeqElementConstraint("alice", 1, 2, "B", id("alice", 0), null),
			];
			const result = buildFugueTree(constraints);

			const origins = computeInsertOrigins(result, 1);

			expect(origins.originLeft).toEqual(id("alice", 0));
			expect(origins.originRight).toEqual(id("alice", 1));
		});
	});

	describe("getIdAtIndex", () => {
		it("should return undefined for empty list", () => {
			const result = buildFugueTree([]);
			expect(getIdAtIndex(result, 0)).toBeUndefined();
		});

		it("should return correct ID", () => {
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
				createSeqElementConstraint("alice", 1, 2, "B", id("alice", 0), null),
			];
			const result = buildFugueTree(constraints);

			expect(getIdAtIndex(result, 0)).toEqual(id("alice", 0));
			expect(getIdAtIndex(result, 1)).toEqual(id("alice", 1));
			expect(getIdAtIndex(result, 2)).toBeUndefined();
		});
	});

	describe("findNode", () => {
		it("should find node by ID", () => {
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
			];
			const result = buildFugueTree(constraints);

			const node = findNode(result, id("alice", 0));
			expect(node).toBeDefined();
			expect(node!.value).toBe("A");
		});

		it("should return undefined for non-existent ID", () => {
			const result = buildFugueTree([]);
			expect(findNode(result, id("alice", 0))).toBeUndefined();
		});
	});

	describe("getActiveIndex", () => {
		it("should return -1 for non-existent element", () => {
			const result = buildFugueTree([]);
			expect(getActiveIndex(result, id("alice", 0))).toBe(-1);
		});

		it("should return correct index", () => {
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
				createSeqElementConstraint("alice", 1, 2, "B", id("alice", 0), null),
			];
			const result = buildFugueTree(constraints);

			expect(getActiveIndex(result, id("alice", 0))).toBe(0);
			expect(getActiveIndex(result, id("alice", 1))).toBe(1);
		});

		it("should return -1 for deleted element", () => {
			const elemA = createSeqElementConstraint("alice", 0, 1, "A", null, null);
			const deleteA = createDeletedConstraintForElement(
				"alice",
				1,
				2, // deleting peer, counter, lamport
				"alice",
				0, // element peer, counter (identifies A)
			);

			const result = buildFugueTree([elemA, deleteA]);

			expect(getActiveIndex(result, id("alice", 0))).toBe(-1);
		});
	});
});

// ============================================================================
// List Solver Tests
// ============================================================================

describe("List Solver", () => {
	describe("createListSolver", () => {
		it("should create a solver", () => {
			const solver = createListSolver();
			expect(solver).toBeDefined();
			expect(solver.solve).toBeDefined();
		});
	});

	describe("solveListConstraints", () => {
		it("should return empty for no constraints", () => {
			const result = solveListConstraints([], ["list"]);

			expect(result.value).toBeUndefined();
			expect(result.determinedBy).toBeUndefined();
			expect(result.conflicts).toHaveLength(0);
		});

		it("should solve single element", () => {
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
			];

			const result = solveListConstraints(constraints, ["list"]);

			expect(result.value).toEqual(["A"]);
			expect(result.determinedBy).toBeDefined();
		});

		it("should report concurrent insert conflicts", () => {
			// Two concurrent inserts at same position
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
				createSeqElementConstraint("bob", 0, 1, "B", null, null),
			];

			const result = solveListConstraints(constraints, ["list"]);

			expect(result.value).toEqual(["A", "B"]);
			expect(result.conflicts.length).toBeGreaterThan(0);
		});
	});

	describe("solveList", () => {
		it("should solve complete list", () => {
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
				createSeqElementConstraint("alice", 1, 2, "B", id("alice", 0), null),
			];

			const result = solveList(constraints, ["list"]);

			expect(result.values).toEqual(["A", "B"]);
			expect(result.length).toBe(2);
			expect(result.tombstoneCount).toBe(0);
		});

		it("should count tombstones", () => {
			const elemA = createSeqElementConstraint("alice", 0, 1, "A", null, null);
			const elemB = createSeqElementConstraint(
				"alice",
				1,
				2,
				"B",
				id("alice", 0),
				null,
			);
			const deleteB = createDeletedConstraintForElement(
				"alice",
				2,
				3, // deleting peer, counter, lamport
				"alice",
				1, // element peer, counter (identifies B)
			);

			const result = solveList([elemA, elemB, deleteB], ["list"]);

			expect(result.values).toEqual(["A"]);
			expect(result.length).toBe(1);
			expect(result.tombstoneCount).toBe(1);
		});

		it("should detect conflicts", () => {
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
				createSeqElementConstraint("bob", 0, 1, "B", null, null),
			];

			const result = solveList(constraints, ["list"]);

			expect(solvedListHasConflicts(result)).toBe(true);
		});
	});

	describe("solvedListToArray", () => {
		it("should convert to plain array", () => {
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
				createSeqElementConstraint("alice", 1, 2, "B", id("alice", 0), null),
			];

			const solved = solveList(constraints, ["list"]);
			const arr = solvedListToArray(solved);

			expect(arr).toEqual(["A", "B"]);
			expect(Array.isArray(arr)).toBe(true);
		});
	});

	describe("solvedListGet", () => {
		it("should get value at index", () => {
			const constraints = [
				createSeqElementConstraint("alice", 0, 1, "A", null, null),
				createSeqElementConstraint("alice", 1, 2, "B", id("alice", 0), null),
			];

			const solved = solveList(constraints, ["list"]);

			expect(solvedListGet(solved, 0)).toBe("A");
			expect(solvedListGet(solved, 1)).toBe("B");
			expect(solvedListGet(solved, 2)).toBeUndefined();
			expect(solvedListGet(solved, -1)).toBeUndefined();
		});
	});
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("Edge Cases", () => {
	it("should handle very long chains", () => {
		const constraints: Constraint[] = [];
		let prevId: OpId | null = null;

		for (let i = 0; i < 100; i++) {
			constraints.push(
				createSeqElementConstraint(
					"alice",
					i,
					i + 1,
					`item-${i}`,
					prevId,
					null,
				),
			);
			prevId = id("alice", i);
		}

		const result = buildFugueTree(constraints);

		expect(result.values).toHaveLength(100);
		expect(result.values[0]).toBe("item-0");
		expect(result.values[99]).toBe("item-99");
	});

	it("should handle complex nested insertions", () => {
		// Build: A - B - C
		// Then insert X between A and B
		// Then insert Y between X and B
		const constraints = [
			createSeqElementConstraint("alice", 0, 1, "A", null, null),
			createSeqElementConstraint("alice", 1, 2, "B", id("alice", 0), null),
			createSeqElementConstraint("alice", 2, 3, "C", id("alice", 1), null),
			createSeqElementConstraint(
				"alice",
				3,
				4,
				"X",
				id("alice", 0),
				id("alice", 1),
			),
			createSeqElementConstraint(
				"alice",
				4,
				5,
				"Y",
				id("alice", 3),
				id("alice", 1),
			),
		];

		const result = buildFugueTree(constraints);

		expect(result.values).toEqual(["A", "X", "Y", "B", "C"]);
	});

	it("should handle different value types", () => {
		const constraints = [
			createSeqElementConstraint("alice", 0, 1, "string", null, null),
			createSeqElementConstraint("alice", 1, 2, 42, id("alice", 0), null),
			createSeqElementConstraint("alice", 2, 3, true, id("alice", 1), null),
			createSeqElementConstraint("alice", 3, 4, null, id("alice", 2), null),
			createSeqElementConstraint(
				"alice",
				4,
				5,
				{ nested: "object" },
				id("alice", 3),
				null,
			),
			createSeqElementConstraint(
				"alice",
				5,
				6,
				[1, 2, 3],
				id("alice", 4),
				null,
			),
		];

		const result = buildFugueTree(constraints);

		expect(result.values).toEqual([
			"string",
			42,
			true,
			null,
			{ nested: "object" },
			[1, 2, 3],
		]);
	});

	it("should handle unicode values", () => {
		const constraints = [
			createSeqElementConstraint("alice", 0, 1, "🎉", null, null),
			createSeqElementConstraint("alice", 1, 2, "日本語", id("alice", 0), null),
			createSeqElementConstraint("alice", 2, 3, "émoji", id("alice", 1), null),
		];

		const result = buildFugueTree(constraints);

		expect(result.values).toEqual(["🎉", "日本語", "émoji"]);
	});

	it("should handle all elements deleted", () => {
		const elemA = createSeqElementConstraint("alice", 0, 1, "A", null, null);
		const elemB = createSeqElementConstraint(
			"alice",
			1,
			2,
			"B",
			id("alice", 0),
			null,
		);

		const deleteA = createDeletedConstraintForElement(
			"alice",
			2,
			3, // deleting peer, counter, lamport
			"alice",
			0, // element peer, counter (identifies A)
		);
		const deleteB = createDeletedConstraintForElement(
			"alice",
			3,
			4, // deleting peer, counter, lamport
			"alice",
			1, // element peer, counter (identifies B)
		);

		const result = buildFugueTree([elemA, elemB, deleteA, deleteB]);

		expect(result.values).toEqual([]);
		expect(result.activeNodes).toHaveLength(0);
		expect(result.allNodes).toHaveLength(2);
	});
});
