/**
 * List View Tests
 *
 * Tests for ListView including:
 * - Basic array operations
 * - Iteration support
 * - Reactive view updates
 * - Subscription callbacks
 */

import { describe, it, expect, vi } from "vitest";
import {
	createListView,
	createReactiveListView,
	type ListView,
	type ReactiveListView,
} from "../../src/views/list-view.js";
import {
	createConstraintStore,
	tell,
	tellMany,
	type ConstraintStore,
} from "../../src/store/constraint-store.js";
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
 * Create a deleted constraint for an element.
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

/**
 * Build a store with some list elements.
 */
function buildTestStore(): ConstraintStore {
	let store = createConstraintStore();

	const constraints = [
		createSeqElementConstraint("alice", 0, 1, "A", null, null),
		createSeqElementConstraint("alice", 1, 2, "B", id("alice", 0), null),
		createSeqElementConstraint("alice", 2, 3, "C", id("alice", 1), null),
	];

	const result = tellMany(store, constraints);
	return result.store;
}

// ============================================================================
// ListView Tests
// ============================================================================

describe("ListView", () => {
	describe("createListView", () => {
		it("should create a view over an empty store", () => {
			const store = createConstraintStore();
			const view = createListView({ store, path: ["list"] });

			expect(view.length()).toBe(0);
			expect(view.isEmpty()).toBe(true);
			expect(view.toArray()).toEqual([]);
		});

		it("should read values from constraints", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			expect(view.length()).toBe(3);
			expect(view.isEmpty()).toBe(false);
			expect(view.toArray()).toEqual(["A", "B", "C"]);
		});
	});

	describe("index access", () => {
		it("should get value at index", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			expect(view.get(0)).toBe("A");
			expect(view.get(1)).toBe("B");
			expect(view.get(2)).toBe("C");
		});

		it("should return undefined for out of bounds", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			expect(view.get(-1)).toBeUndefined();
			expect(view.get(3)).toBeUndefined();
			expect(view.get(100)).toBeUndefined();
		});
	});

	describe("first and last", () => {
		it("should get first element", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			expect(view.first()).toBe("A");
		});

		it("should get last element", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			expect(view.last()).toBe("C");
		});

		it("should return undefined for empty list", () => {
			const store = createConstraintStore();
			const view = createListView({ store, path: ["list"] });

			expect(view.first()).toBeUndefined();
			expect(view.last()).toBeUndefined();
		});
	});

	describe("getArray", () => {
		it("should return array of values", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			expect(view.getArray()).toEqual(["A", "B", "C"]);
		});

		it("should return undefined for empty list", () => {
			const store = createConstraintStore();
			const view = createListView({ store, path: ["list"] });

			expect(view.getArray()).toBeUndefined();
		});
	});

	describe("iteration", () => {
		it("should iterate over values", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			const values: unknown[] = [];
			for (const value of view.values()) {
				values.push(value);
			}

			expect(values).toEqual(["A", "B", "C"]);
		});

		it("should iterate over entries", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			const entries: [number, unknown][] = [];
			for (const entry of view.entries()) {
				entries.push(entry);
			}

			expect(entries).toEqual([
				[0, "A"],
				[1, "B"],
				[2, "C"],
			]);
		});

		it("should support forEach", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			const result: { value: unknown; index: number }[] = [];
			view.forEach((value, index) => {
				result.push({ value, index });
			});

			expect(result).toEqual([
				{ value: "A", index: 0 },
				{ value: "B", index: 1 },
				{ value: "C", index: 2 },
			]);
		});
	});

	describe("functional methods", () => {
		it("should map values", () => {
			const store = buildTestStore();
			const view = createListView<string>({ store, path: ["list"] });

			const result = view.map((v) => v.toLowerCase());

			expect(result).toEqual(["a", "b", "c"]);
		});

		it("should filter values", () => {
			const store = buildTestStore();
			const view = createListView<string>({ store, path: ["list"] });

			const result = view.filter((v) => v !== "B");

			expect(result).toEqual(["A", "C"]);
		});

		it("should find value", () => {
			const store = buildTestStore();
			const view = createListView<string>({ store, path: ["list"] });

			expect(view.find((v) => v === "B")).toBe("B");
			expect(view.find((v) => v === "X")).toBeUndefined();
		});

		it("should find index", () => {
			const store = buildTestStore();
			const view = createListView<string>({ store, path: ["list"] });

			expect(view.findIndex((v) => v === "B")).toBe(1);
			expect(view.findIndex((v) => v === "X")).toBe(-1);
		});

		it("should check some", () => {
			const store = buildTestStore();
			const view = createListView<string>({ store, path: ["list"] });

			expect(view.some((v) => v === "B")).toBe(true);
			expect(view.some((v) => v === "X")).toBe(false);
		});

		it("should check every", () => {
			const store = buildTestStore();
			const view = createListView<string>({ store, path: ["list"] });

			expect(view.every((v) => typeof v === "string")).toBe(true);
			expect(view.every((v) => v === "A")).toBe(false);
		});
	});

	describe("getSolved", () => {
		it("should return solved value with details", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			const solved = view.getSolved();

			expect(solved.value).toEqual(["A", "B", "C"]);
			expect(solved.determinedBy).toBeDefined();
			expect(solved.resolution).toContain("3 elements");
		});

		it("should return empty for empty list", () => {
			const store = createConstraintStore();
			const view = createListView({ store, path: ["list"] });

			const solved = view.getSolved();

			expect(solved.value).toBeUndefined();
			expect(solved.determinedBy).toBeUndefined();
		});
	});

	describe("tombstone tracking", () => {
		it("should count tombstones", () => {
			let store = createConstraintStore();

			const elemA = createSeqElementConstraint("alice", 0, 1, "A", null, null);
			const elemB = createSeqElementConstraint(
				"alice",
				1,
				2,
				"B",
				id("alice", 0),
				null,
			);

			store = tell(store, elemA).store;
			store = tell(store, elemB).store;

			// Delete B using element path convention
			const deleteB = createDeletedConstraintForElement(
				"alice",
				2,
				3, // deleting peer, counter, lamport
				"alice",
				1, // element peer, counter (identifies B)
			);
			store = tell(store, deleteB).store;

			const view = createListView({ store, path: ["list"] });

			expect(view.toArray()).toEqual(["A"]);
			expect(view.tombstoneCount()).toBe(1);
		});
	});

	describe("conflict detection", () => {
		it("should detect concurrent inserts", () => {
			let store = createConstraintStore();

			// Alice and Bob both insert at the beginning
			const elemA = createSeqElementConstraint("alice", 0, 1, "A", null, null);
			const elemB = createSeqElementConstraint("bob", 0, 1, "B", null, null);

			store = tellMany(store, [elemA, elemB]).store;

			const view = createListView({ store, path: ["list"] });

			expect(view.hasConcurrentInserts()).toBe(true);
			expect(view.hasConflicts()).toBe(true);
		});

		it("should report no conflicts for sequential inserts", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			expect(view.hasConcurrentInserts()).toBe(false);
			expect(view.hasConflicts()).toBe(false);
		});
	});

	describe("getNode", () => {
		it("should return FugueNode at index", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			const node = view.getNode(0);

			expect(node).toBeDefined();
			expect(node!.value).toBe("A");
			expect(node!.id).toEqual(id("alice", 0));
		});

		it("should return undefined for invalid index", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			expect(view.getNode(-1)).toBeUndefined();
			expect(view.getNode(100)).toBeUndefined();
		});
	});

	describe("getConstraints", () => {
		it("should return all constraints", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			const constraints = view.getConstraints();

			expect(constraints.length).toBe(3);
		});
	});

	describe("subscriptions", () => {
		it("should allow subscribing", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			const callback = vi.fn();
			const unsubscribe = view.subscribe(callback);

			expect(typeof unsubscribe).toBe("function");
		});

		it("should allow unsubscribing", () => {
			const store = buildTestStore();
			const view = createListView({ store, path: ["list"] });

			const callback = vi.fn();
			const unsubscribe = view.subscribe(callback);
			unsubscribe();

			// No error should occur
			expect(callback).not.toHaveBeenCalled();
		});
	});
});

// ============================================================================
// ReactiveListView Tests
// ============================================================================

describe("ReactiveListView", () => {
	describe("createReactiveListView", () => {
		it("should create a reactive view", () => {
			const store = createConstraintStore();
			const view = createReactiveListView({ store, path: ["list"] });

			expect(view).toBeDefined();
			expect(view.length()).toBe(0);
		});

		it("should read initial values", () => {
			const store = buildTestStore();
			const view = createReactiveListView({ store, path: ["list"] });

			expect(view.toArray()).toEqual(["A", "B", "C"]);
		});
	});

	describe("updateStore", () => {
		it("should update when store changes", () => {
			let store = createConstraintStore();
			const view = createReactiveListView({ store, path: ["list"] });

			expect(view.length()).toBe(0);

			// Add elements to a new store
			const newConstraint = createSeqElementConstraint(
				"alice",
				0,
				1,
				"X",
				null,
				null,
			);
			const newStore = tell(store, newConstraint).store;

			view.updateStore(newStore);

			expect(view.length()).toBe(1);
			expect(view.toArray()).toEqual(["X"]);
		});
	});

	describe("subscriptions", () => {
		it("should notify subscribers when constraints change", () => {
			let store = createConstraintStore();
			const view = createReactiveListView({ store, path: ["list"] });

			const callback = vi.fn();
			view.subscribe(callback);

			// Add a new element
			const newConstraint = createSeqElementConstraint(
				"alice",
				0,
				1,
				"X",
				null,
				null,
			);
			const newStore = tell(store, newConstraint).store;

			view.updateStore(newStore);
			view.notifyConstraintsChanged([newConstraint]);

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({
					before: undefined,
					after: ["X"],
				}),
			);
		});

		it("should not notify if value did not change", () => {
			const store = buildTestStore();
			const view = createReactiveListView({ store, path: ["list"] });

			const callback = vi.fn();
			view.subscribe(callback);

			// Notify without actual change
			view.notifyConstraintsChanged([]);

			expect(callback).not.toHaveBeenCalled();
		});

		it("should allow unsubscribing", () => {
			const store = buildTestStore();
			const view = createReactiveListView({ store, path: ["list"] });

			const callback = vi.fn();
			const unsubscribe = view.subscribe(callback);
			unsubscribe();

			// Add a new element
			const newConstraint = createSeqElementConstraint(
				"bob",
				0,
				4,
				"X",
				id("alice", 2),
				null,
			);
			const newStore = tell(store, newConstraint).store;

			view.updateStore(newStore);
			view.notifyConstraintsChanged([newConstraint]);

			expect(callback).not.toHaveBeenCalled();
		});

		it("should include before and after state in events", () => {
			const store = buildTestStore();
			const view = createReactiveListView({ store, path: ["list"] });

			const callback = vi.fn();
			view.subscribe(callback);

			// Add a new element at the end
			const newConstraint = createSeqElementConstraint(
				"bob",
				0,
				4,
				"D",
				id("alice", 2),
				null,
			);
			const newStore = tell(store, newConstraint).store;

			view.updateStore(newStore);
			view.notifyConstraintsChanged([newConstraint]);

			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({
					before: ["A", "B", "C"],
					after: ["A", "B", "C", "D"],
				}),
			);
		});
	});

	describe("all ListView methods work", () => {
		it("should support get", () => {
			const store = buildTestStore();
			const view = createReactiveListView({ store, path: ["list"] });

			expect(view.get(0)).toBe("A");
			expect(view.get(1)).toBe("B");
			expect(view.get(2)).toBe("C");
		});

		it("should support first and last", () => {
			const store = buildTestStore();
			const view = createReactiveListView({ store, path: ["list"] });

			expect(view.first()).toBe("A");
			expect(view.last()).toBe("C");
		});

		it("should support functional methods", () => {
			const store = buildTestStore();
			const view = createReactiveListView<string>({ store, path: ["list"] });

			expect(view.map((v) => v.toLowerCase())).toEqual(["a", "b", "c"]);
			expect(view.filter((v) => v !== "B")).toEqual(["A", "C"]);
			expect(view.find((v) => v === "B")).toBe("B");
			expect(view.findIndex((v) => v === "C")).toBe(2);
			expect(view.some((v) => v === "A")).toBe(true);
			expect(view.every((v) => typeof v === "string")).toBe(true);
		});

		it("should support iteration", () => {
			const store = buildTestStore();
			const view = createReactiveListView({ store, path: ["list"] });

			const values: unknown[] = [];
			for (const value of view.values()) {
				values.push(value);
			}
			expect(values).toEqual(["A", "B", "C"]);

			const entries: [number, unknown][] = [];
			for (const entry of view.entries()) {
				entries.push(entry);
			}
			expect(entries).toEqual([
				[0, "A"],
				[1, "B"],
				[2, "C"],
			]);
		});

		it("should support forEach", () => {
			const store = buildTestStore();
			const view = createReactiveListView({ store, path: ["list"] });

			const result: unknown[] = [];
			view.forEach((v) => result.push(v));
			expect(result).toEqual(["A", "B", "C"]);
		});

		it("should support tombstone and conflict tracking", () => {
			let store = createConstraintStore();
			const elemA = createSeqElementConstraint("alice", 0, 1, "A", null, null);
			const elemB = createSeqElementConstraint("bob", 0, 1, "B", null, null);
			store = tellMany(store, [elemA, elemB]).store;

			const view = createReactiveListView({ store, path: ["list"] });

			expect(view.hasConcurrentInserts()).toBe(true);
			expect(view.tombstoneCount()).toBe(0);
		});
	});
});
