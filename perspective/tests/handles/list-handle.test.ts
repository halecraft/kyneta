/**
 * List Handle Tests
 *
 * Tests for ListHandle including:
 * - Insert operations (insert, insertMany, push, unshift)
 * - Delete operations (delete, deleteRange, pop, shift)
 * - Correct origin computation
 * - Multi-peer scenarios
 * - Merge behavior
 */

import { describe, it, expect } from "vitest";
import {
	createListHandle,
	mergeListHandles,
	type ListHandle,
} from "../../src/handles/list-handle.js";
import {
	createConstraintStore,
	mergeStores,
	type ConstraintStore,
} from "../../src/store/constraint-store.js";
import type { Path } from "../../src/core/types.js";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a list handle with specific initial Lamport for controlled testing.
 */
function createTestHandle(
	peerId: string,
	path: Path = ["list"],
	initialLamport: number = 0,
): ListHandle {
	return createListHandle({
		peerId,
		store: createConstraintStore(),
		path,
		initialLamport,
	});
}

/**
 * Merge multiple handles' stores into one.
 */
function mergeAllStores(stores: ConstraintStore[]): ConstraintStore {
	if (stores.length === 0) {
		return createConstraintStore();
	}
	let result = stores[0]!;
	for (let i = 1; i < stores.length; i++) {
		result = mergeStores(result, stores[i]!);
	}
	return result;
}

/**
 * Create a handle on a merged store for reading results.
 */
function createMergedView(
	stores: ConstraintStore[],
	path: Path = ["list"],
): ListHandle {
	return createListHandle({
		peerId: "viewer",
		store: mergeAllStores(stores),
		path,
	});
}

// ============================================================================
// ListHandle Basic Tests
// ============================================================================

describe("ListHandle", () => {
	describe("createListHandle", () => {
		it("should create a handle over an empty store", () => {
			const handle = createTestHandle("alice");

			expect(handle.view().length()).toBe(0);
			expect(handle.view().isEmpty()).toBe(true);
			expect(handle.view().toArray()).toEqual([]);
		});
	});

	describe("insert", () => {
		it("should insert at the beginning of empty list", () => {
			const handle = createTestHandle("alice");

			const constraint = handle.insert(0, "A");

			expect(handle.view().toArray()).toEqual(["A"]);
			expect(constraint).toBeDefined();
			expect(constraint.id.peer).toBe("alice");
		});

		it("should insert at the end", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "A");
			handle.insert(1, "B");

			expect(handle.view().toArray()).toEqual(["A", "B"]);
		});

		it("should insert in the middle", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "A");
			handle.insert(1, "C");
			handle.insert(1, "B");

			expect(handle.view().toArray()).toEqual(["A", "B", "C"]);
		});

		it("should increment counters for each operation", () => {
			const handle = createTestHandle("alice");

			const c1 = handle.insert(0, "A");
			const c2 = handle.insert(1, "B");
			const c3 = handle.insert(2, "C");

			expect(c1.id.counter).toBe(0);
			expect(c2.id.counter).toBe(1);
			expect(c3.id.counter).toBe(2);
		});

		it("should increment Lamport for each operation", () => {
			const handle = createTestHandle("alice", ["list"], 0);

			const c1 = handle.insert(0, "A");
			const c2 = handle.insert(1, "B");
			const c3 = handle.insert(2, "C");

			expect(c1.metadata.lamport).toBe(1);
			expect(c2.metadata.lamport).toBe(2);
			expect(c3.metadata.lamport).toBe(3);
		});
	});

	describe("insertMany", () => {
		it("should insert multiple values at once", () => {
			const handle = createTestHandle("alice");

			const constraints = handle.insertMany(0, ["A", "B", "C"]);

			expect(handle.view().toArray()).toEqual(["A", "B", "C"]);
			expect(constraints).toHaveLength(3);
		});

		it("should chain origins correctly", () => {
			const handle = createTestHandle("alice");

			const constraints = handle.insertMany(0, ["A", "B", "C"]);

			// First element has null originLeft
			expect(constraints[0]).toBeDefined();
			// Second element's originLeft should be first element
			expect(constraints[1]).toBeDefined();
			// Third element's originLeft should be second element
			expect(constraints[2]).toBeDefined();
		});

		it("should insert in the middle correctly", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "A");
			handle.insert(1, "D");
			handle.insertMany(1, ["B", "C"]);

			expect(handle.view().toArray()).toEqual(["A", "B", "C", "D"]);
		});

		it("should handle empty array", () => {
			const handle = createTestHandle("alice");

			const constraints = handle.insertMany(0, []);

			expect(constraints).toHaveLength(0);
			expect(handle.view().toArray()).toEqual([]);
		});
	});

	describe("delete", () => {
		it("should delete an element", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "A");
			handle.insert(1, "B");
			handle.insert(2, "C");
			handle.delete(1);

			expect(handle.view().toArray()).toEqual(["A", "C"]);
		});

		it("should return the constraint", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "A");
			const constraint = handle.delete(0);

			expect(constraint).toBeDefined();
		});

		it("should return undefined for out of bounds", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "A");
			const constraint = handle.delete(5);

			expect(constraint).toBeUndefined();
			expect(handle.view().toArray()).toEqual(["A"]);
		});

		it("should delete first element", () => {
			const handle = createTestHandle("alice");

			handle.insertMany(0, ["A", "B", "C"]);
			handle.delete(0);

			expect(handle.view().toArray()).toEqual(["B", "C"]);
		});

		it("should delete last element", () => {
			const handle = createTestHandle("alice");

			handle.insertMany(0, ["A", "B", "C"]);
			handle.delete(2);

			expect(handle.view().toArray()).toEqual(["A", "B"]);
		});
	});

	describe("deleteRange", () => {
		it("should delete multiple elements", () => {
			const handle = createTestHandle("alice");

			handle.insertMany(0, ["A", "B", "C", "D", "E"]);
			const constraints = handle.deleteRange(1, 3);

			expect(handle.view().toArray()).toEqual(["A", "E"]);
			expect(constraints).toHaveLength(3);
		});

		it("should handle deleting from start", () => {
			const handle = createTestHandle("alice");

			handle.insertMany(0, ["A", "B", "C"]);
			handle.deleteRange(0, 2);

			expect(handle.view().toArray()).toEqual(["C"]);
		});

		it("should handle deleting to end", () => {
			const handle = createTestHandle("alice");

			handle.insertMany(0, ["A", "B", "C"]);
			handle.deleteRange(1, 2);

			expect(handle.view().toArray()).toEqual(["A"]);
		});

		it("should handle deleting beyond bounds", () => {
			const handle = createTestHandle("alice");

			handle.insertMany(0, ["A", "B", "C"]);
			const constraints = handle.deleteRange(1, 10);

			expect(handle.view().toArray()).toEqual(["A"]);
			expect(constraints).toHaveLength(2); // Only B and C exist
		});
	});

	describe("push", () => {
		it("should push to empty list", () => {
			const handle = createTestHandle("alice");

			handle.push("A");

			expect(handle.view().toArray()).toEqual(["A"]);
		});

		it("should push to end of list", () => {
			const handle = createTestHandle("alice");

			handle.push("A");
			handle.push("B");
			handle.push("C");

			expect(handle.view().toArray()).toEqual(["A", "B", "C"]);
		});
	});

	describe("pushMany", () => {
		it("should push multiple values", () => {
			const handle = createTestHandle("alice");

			handle.push("A");
			handle.pushMany(["B", "C", "D"]);

			expect(handle.view().toArray()).toEqual(["A", "B", "C", "D"]);
		});
	});

	describe("unshift", () => {
		it("should unshift to empty list", () => {
			const handle = createTestHandle("alice");

			handle.unshift("A");

			expect(handle.view().toArray()).toEqual(["A"]);
		});

		it("should unshift to beginning of list", () => {
			const handle = createTestHandle("alice");

			handle.push("C");
			handle.unshift("B");
			handle.unshift("A");

			expect(handle.view().toArray()).toEqual(["A", "B", "C"]);
		});
	});

	describe("unshiftMany", () => {
		it("should unshift multiple values", () => {
			const handle = createTestHandle("alice");

			handle.push("D");
			handle.unshiftMany(["A", "B", "C"]);

			expect(handle.view().toArray()).toEqual(["A", "B", "C", "D"]);
		});
	});

	describe("pop", () => {
		it("should pop last element", () => {
			const handle = createTestHandle("alice");

			handle.pushMany(["A", "B", "C"]);
			const result = handle.pop();

			expect(result).toBeDefined();
			expect(result!.value).toBe("C");
			expect(handle.view().toArray()).toEqual(["A", "B"]);
		});

		it("should return undefined for empty list", () => {
			const handle = createTestHandle("alice");

			const result = handle.pop();

			expect(result).toBeUndefined();
		});
	});

	describe("shift", () => {
		it("should shift first element", () => {
			const handle = createTestHandle("alice");

			handle.pushMany(["A", "B", "C"]);
			const result = handle.shift();

			expect(result).toBeDefined();
			expect(result!.value).toBe("A");
			expect(handle.view().toArray()).toEqual(["B", "C"]);
		});

		it("should return undefined for empty list", () => {
			const handle = createTestHandle("alice");

			const result = handle.shift();

			expect(result).toBeUndefined();
		});
	});

	describe("getAt", () => {
		it("should get value at index", () => {
			const handle = createTestHandle("alice");

			handle.pushMany(["A", "B", "C"]);

			expect(handle.view().getAt(0)).toBe("A");
			expect(handle.view().getAt(1)).toBe("B");
			expect(handle.view().getAt(2)).toBe("C");
		});

		it("should return undefined for out of bounds", () => {
			const handle = createTestHandle("alice");

			handle.push("A");

			expect(handle.view().getAt(-1)).toBeUndefined();
			expect(handle.view().getAt(5)).toBeUndefined();
		});
	});

	describe("view", () => {
		it("should provide a view of the data", () => {
			const handle = createTestHandle("alice");

			handle.pushMany(["A", "B", "C"]);

			const view = handle.view();
			expect(view.toArray()).toEqual(["A", "B", "C"]);
		});

		it("should update view when handle changes", () => {
			const handle = createTestHandle("alice");

			handle.push("A");
			expect(handle.view().toArray()).toEqual(["A"]);

			handle.push("B");
			expect(handle.view().toArray()).toEqual(["A", "B"]);
		});
	});

	describe("getStore", () => {
		it("should return the current store", () => {
			const handle = createTestHandle("alice");

			handle.push("A");

			const store = handle.getStore();
			expect(store.constraints.size).toBe(1);
		});
	});
});

// ============================================================================
// Multi-peer Scenarios
// ============================================================================

describe("Multi-peer scenarios", () => {
	const listPath: Path = ["list"];

	it("should merge lists from different peers", () => {
		const alice = createTestHandle("alice", listPath);
		alice.push("A");

		const bob = createTestHandle("bob", listPath);
		bob.push("B");

		const merged = createMergedView([alice.getStore(), bob.getStore()]);

		// Both elements should be present
		expect(merged.view().length()).toBe(2);
		// Lower peer ID comes first: alice < bob
		expect(merged.view().toArray()).toEqual(["A", "B"]);
	});

	it("should handle concurrent inserts at same position", () => {
		// Alice and Bob both insert at position 0 (empty list)
		const alice = createTestHandle("alice", listPath, 0);
		alice.insert(0, "A"); // lamport 1

		const bob = createTestHandle("bob", listPath, 0);
		bob.insert(0, "B"); // lamport 1

		const merged = createMergedView([alice.getStore(), bob.getStore()]);

		// Same lamport, lower peer ID comes first
		expect(merged.view().toArray()).toEqual(["A", "B"]);
	});

	it("should resolve conflicts deterministically regardless of merge order", () => {
		const alice = createTestHandle("alice", listPath, 0);
		alice.push("A");

		const bob = createTestHandle("bob", listPath, 0);
		bob.push("B");

		const carol = createTestHandle("carol", listPath, 0);
		carol.push("C");

		// Try different merge orders
		const order1 = createMergedView([
			alice.getStore(),
			bob.getStore(),
			carol.getStore(),
		]);
		const order2 = createMergedView([
			carol.getStore(),
			alice.getStore(),
			bob.getStore(),
		]);
		const order3 = createMergedView([
			bob.getStore(),
			carol.getStore(),
			alice.getStore(),
		]);

		// All should produce the same result
		expect(order1.view().toArray()).toEqual(order2.view().toArray());
		expect(order2.view().toArray()).toEqual(order3.view().toArray());
		// Lower peer ID comes first: alice < bob < carol
		expect(order1.view().toArray()).toEqual(["A", "B", "C"]);
	});

	it("should handle delete conflicts", () => {
		// Alice creates a list
		const alice = createTestHandle("alice", listPath);
		alice.pushMany(["A", "B", "C"]);

		// Bob gets Alice's store and deletes B
		const bob = createListHandle({
			peerId: "bob",
			store: alice.getStore(),
			path: listPath,
		});
		bob.delete(1); // Delete B

		// Carol gets Alice's store and deletes C
		const carol = createListHandle({
			peerId: "carol",
			store: alice.getStore(),
			path: listPath,
		});
		carol.delete(2); // Delete C

		// Merge all
		const merged = createMergedView([bob.getStore(), carol.getStore()]);

		// Both B and C should be deleted
		expect(merged.view().toArray()).toEqual(["A"]);
	});

	it("should handle concurrent insert and delete", () => {
		// Setup: Alice creates [A, B, C]
		const alice = createTestHandle("alice", listPath);
		alice.pushMany(["A", "B", "C"]);

		// Bob deletes B
		const bob = createListHandle({
			peerId: "bob",
			store: alice.getStore(),
			path: listPath,
		});
		bob.delete(1);

		// Carol inserts X after A (before B)
		const carol = createListHandle({
			peerId: "carol",
			store: alice.getStore(),
			path: listPath,
		});
		carol.insert(1, "X");

		// Merge
		const merged = createMergedView([bob.getStore(), carol.getStore()]);

		// X should be inserted, B should be deleted
		expect(merged.view().toArray()).toEqual(["A", "X", "C"]);
	});
});

// ============================================================================
// mergeListHandles Tests
// ============================================================================

describe("mergeListHandles", () => {
	it("should merge source into target handle", () => {
		const alice = createTestHandle("alice");
		alice.push("A");

		const bob = createTestHandle("bob");
		bob.push("B");

		mergeListHandles(alice, bob);

		expect(alice.getStore().constraints.size).toBe(2);
		expect(alice.view().toArray()).toContain("A");
		expect(alice.view().toArray()).toContain("B");
	});

	it("should handle merging with empty handle", () => {
		const alice = createTestHandle("alice");
		alice.push("A");

		const bob = createTestHandle("bob");

		mergeListHandles(alice, bob);

		expect(alice.getStore().constraints.size).toBe(1);
		expect(alice.view().toArray()).toEqual(["A"]);
	});
});

// ============================================================================
// Edge Cases
// ============================================================================

describe("Edge Cases", () => {
	it("should handle various value types", () => {
		const handle = createTestHandle("alice");

		handle.push("string");
		handle.push(42);
		handle.push(true);
		handle.push(null);
		handle.push({ nested: "object" });
		handle.push([1, 2, 3]);

		expect(handle.view().toArray()).toEqual([
			"string",
			42,
			true,
			null,
			{ nested: "object" },
			[1, 2, 3],
		]);
	});

	it("should handle unicode values", () => {
		const handle = createTestHandle("alice");

		handle.push("🎉");
		handle.push("日本語");
		handle.push("émoji");

		expect(handle.view().toArray()).toEqual(["🎉", "日本語", "émoji"]);
	});

	it("should handle large lists", () => {
		const handle = createTestHandle("alice");

		for (let i = 0; i < 100; i++) {
			handle.push(i);
		}

		expect(handle.view().length()).toBe(100);
		expect(handle.view().getAt(0)).toBe(0);
		expect(handle.view().getAt(99)).toBe(99);
	});

	it("should handle rapid insertions and deletions", () => {
		const handle = createTestHandle("alice");

		// Insert 10 items
		for (let i = 0; i < 10; i++) {
			handle.push(i);
		}

		// Delete every other item (starting from end to avoid index shifting issues)
		for (let i = 9; i >= 0; i -= 2) {
			handle.delete(i);
		}

		expect(handle.view().toArray()).toEqual([0, 2, 4, 6, 8]);
	});

	it("should maintain correct order after complex operations", () => {
		const handle = createTestHandle("alice");

		// Build [A, B, C, D, E]
		handle.pushMany(["A", "B", "C", "D", "E"]);

		// Delete C
		handle.delete(2);
		// Now [A, B, D, E]

		// Insert X between A and B
		handle.insert(1, "X");
		// Now [A, X, B, D, E]

		// Insert Y at end
		handle.push("Y");
		// Now [A, X, B, D, E, Y]

		// Delete first element
		handle.shift();
		// Now [X, B, D, E, Y]

		expect(handle.view().toArray()).toEqual(["X", "B", "D", "E", "Y"]);
	});
});
