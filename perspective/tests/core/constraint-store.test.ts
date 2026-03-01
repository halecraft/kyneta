/**
 * Constraint Store Tests
 *
 * Tests for the core ConstraintStore functionality:
 * - tell() - adding constraints
 * - ask() - querying constraints
 * - merge - combining stores
 * - delta computation - for sync
 */

import { describe, it, expect } from "vitest";
import {
	createConstraintStore,
	tell,
	tellMany,
	ask,
	askPrefix,
	getConstraintsForPath,
	getAllConstraints,
	getConstraintCount,
	hasConstraint,
	getConstraint,
	getVersionVector,
	getLamport,
	exportDelta,
	importDelta,
	mergeStores,
	iterPaths,
	iterConstraints,
} from "../../src/store/constraint-store.js";
import { createConstraint } from "../../src/core/constraint.js";
import { eq, deleted } from "../../src/core/assertions.js";
import { createOpId } from "../../src/core/types.js";
import { vvGet, vvFromObject } from "../../src/core/version-vector.js";

describe("ConstraintStore", () => {
	describe("createConstraintStore", () => {
		it("should create an empty store", () => {
			const store = createConstraintStore();

			expect(getConstraintCount(store)).toBe(0);
			expect(getLamport(store)).toBe(0);
			expect(getAllConstraints(store)).toEqual([]);
		});
	});

	describe("tell", () => {
		it("should add a constraint to the store", () => {
			const store = createConstraintStore();
			const constraint = createConstraint(
				"alice",
				0,
				1,
				["users", "name"],
				eq("Alice"),
			);

			const result = tell(store, constraint);

			expect(result.isNew).toBe(true);
			expect(getConstraintCount(result.store)).toBe(1);
			expect(result.affectedPaths).toEqual([["users", "name"]]);
		});

		it("should update version vector", () => {
			const store = createConstraintStore();
			const constraint = createConstraint("alice", 5, 10, ["key"], eq("value"));

			const result = tell(store, constraint);
			const vv = getVersionVector(result.store);

			// Version vector should be counter + 1 (exclusive end)
			expect(vvGet(vv, "alice")).toBe(6);
		});

		it("should update Lamport clock", () => {
			const store = createConstraintStore();
			const constraint = createConstraint("alice", 0, 42, ["key"], eq("value"));

			const result = tell(store, constraint);

			expect(getLamport(result.store)).toBe(42);
		});

		it("should deduplicate by OpId", () => {
			const store = createConstraintStore();
			const constraint1 = createConstraint(
				"alice",
				0,
				1,
				["key"],
				eq("value1"),
			);
			const constraint2 = createConstraint(
				"alice",
				0,
				2,
				["key"],
				eq("value2"),
			); // Same OpId!

			const result1 = tell(store, constraint1);
			const result2 = tell(result1.store, constraint2);

			expect(result1.isNew).toBe(true);
			expect(result2.isNew).toBe(false);
			expect(getConstraintCount(result2.store)).toBe(1);
		});

		it("should handle multiple constraints at same path", () => {
			let store = createConstraintStore();

			const c1 = createConstraint("alice", 0, 1, ["key"], eq("alice-value"));
			const c2 = createConstraint("bob", 0, 2, ["key"], eq("bob-value"));

			store = tell(store, c1).store;
			store = tell(store, c2).store;

			expect(getConstraintCount(store)).toBe(2);
			const constraints = ask(store, ["key"]);
			expect(constraints).toHaveLength(2);
		});
	});

	describe("tellMany", () => {
		it("should add multiple constraints efficiently", () => {
			const store = createConstraintStore();
			const constraints = [
				createConstraint("alice", 0, 1, ["a"], eq(1)),
				createConstraint("alice", 1, 2, ["b"], eq(2)),
				createConstraint("alice", 2, 3, ["c"], eq(3)),
			];

			const result = tellMany(store, constraints);

			expect(result.isNew).toBe(true);
			expect(getConstraintCount(result.store)).toBe(3);
			expect(result.affectedPaths).toHaveLength(3);
		});

		it("should skip duplicates", () => {
			const store = createConstraintStore();
			const c1 = createConstraint("alice", 0, 1, ["key"], eq("value"));

			const result1 = tell(store, c1);
			const result2 = tellMany(result1.store, [c1, c1, c1]);

			expect(result2.isNew).toBe(false);
			expect(getConstraintCount(result2.store)).toBe(1);
		});

		it("should handle empty array", () => {
			const store = createConstraintStore();
			const result = tellMany(store, []);

			expect(result.isNew).toBe(false);
			expect(result.store).toBe(store);
		});
	});

	describe("ask", () => {
		it("should return constraints for exact path", () => {
			let store = createConstraintStore();
			const c1 = createConstraint(
				"alice",
				0,
				1,
				["users", "alice"],
				eq("Alice"),
			);
			const c2 = createConstraint("alice", 1, 2, ["users", "bob"], eq("Bob"));

			store = tell(store, c1).store;
			store = tell(store, c2).store;

			const aliceConstraints = ask(store, ["users", "alice"]);
			expect(aliceConstraints).toHaveLength(1);
			expect(aliceConstraints[0]?.assertion).toEqual(eq("Alice"));

			const bobConstraints = ask(store, ["users", "bob"]);
			expect(bobConstraints).toHaveLength(1);
			expect(bobConstraints[0]?.assertion).toEqual(eq("Bob"));
		});

		it("should return empty array for unknown path", () => {
			const store = createConstraintStore();
			const constraints = ask(store, ["unknown", "path"]);

			expect(constraints).toEqual([]);
		});

		it("should not return parent or child path constraints", () => {
			let store = createConstraintStore();
			const parent = createConstraint("alice", 0, 1, ["users"], eq("parent"));
			const exact = createConstraint(
				"alice",
				1,
				2,
				["users", "alice"],
				eq("exact"),
			);
			const child = createConstraint(
				"alice",
				2,
				3,
				["users", "alice", "name"],
				eq("child"),
			);

			store = tellMany(store, [parent, exact, child]).store;

			const result = ask(store, ["users", "alice"]);
			expect(result).toHaveLength(1);
			expect(result[0]?.assertion).toEqual(eq("exact"));
		});
	});

	describe("askPrefix", () => {
		it("should return constraints for path and all descendants", () => {
			let store = createConstraintStore();
			const c1 = createConstraint("alice", 0, 1, ["users"], eq("root"));
			const c2 = createConstraint(
				"alice",
				1,
				2,
				["users", "alice"],
				eq("alice"),
			);
			const c3 = createConstraint(
				"alice",
				2,
				3,
				["users", "alice", "name"],
				eq("name"),
			);
			const c4 = createConstraint("alice", 3, 4, ["other"], eq("other"));

			store = tellMany(store, [c1, c2, c3, c4]).store;

			const result = askPrefix(store, ["users"]);
			expect(result).toHaveLength(3);
		});

		it("should return empty for non-matching prefix", () => {
			let store = createConstraintStore();
			const c1 = createConstraint(
				"alice",
				0,
				1,
				["users", "alice"],
				eq("value"),
			);

			store = tell(store, c1).store;

			const result = askPrefix(store, ["posts"]);
			expect(result).toEqual([]);
		});
	});

	describe("hasConstraint / getConstraint", () => {
		it("should find constraint by OpId", () => {
			let store = createConstraintStore();
			const constraint = createConstraint("alice", 5, 10, ["key"], eq("value"));

			store = tell(store, constraint).store;

			expect(hasConstraint(store, createOpId("alice", 5))).toBe(true);
			expect(hasConstraint(store, createOpId("alice", 6))).toBe(false);
			expect(hasConstraint(store, createOpId("bob", 5))).toBe(false);
		});

		it("should retrieve constraint by OpId", () => {
			let store = createConstraintStore();
			const constraint = createConstraint("alice", 5, 10, ["key"], eq("value"));

			store = tell(store, constraint).store;

			const retrieved = getConstraint(store, createOpId("alice", 5));
			expect(retrieved).toEqual(constraint);

			const missing = getConstraint(store, createOpId("alice", 999));
			expect(missing).toBeUndefined();
		});
	});

	describe("exportDelta / importDelta", () => {
		it("should export constraints not in target version vector", () => {
			let store = createConstraintStore();
			const c1 = createConstraint("alice", 0, 1, ["a"], eq(1));
			const c2 = createConstraint("alice", 1, 2, ["b"], eq(2));
			const c3 = createConstraint("bob", 0, 3, ["c"], eq(3));

			store = tellMany(store, [c1, c2, c3]).store;

			// Target has seen alice:0 but nothing else
			const theirVV = vvFromObject({ alice: 1 });

			const delta = exportDelta(store, theirVV);

			expect(delta.constraints).toHaveLength(2);
			const ids = delta.constraints.map((c) => `${c.id.peer}@${c.id.counter}`);
			expect(ids).toContain("alice@1");
			expect(ids).toContain("bob@0");
			expect(ids).not.toContain("alice@0");
		});

		it("should export all constraints when target is empty", () => {
			let store = createConstraintStore();
			const c1 = createConstraint("alice", 0, 1, ["a"], eq(1));
			const c2 = createConstraint("bob", 0, 2, ["b"], eq(2));

			store = tellMany(store, [c1, c2]).store;

			const delta = exportDelta(store, vvFromObject({}));

			expect(delta.constraints).toHaveLength(2);
		});

		it("should import delta and update store", () => {
			const store1 = createConstraintStore();
			let store2 = createConstraintStore();

			const c1 = createConstraint("alice", 0, 1, ["key"], eq("value"));
			const result1 = tell(store1, c1);

			const delta = exportDelta(result1.store, getVersionVector(store2));
			const result2 = importDelta(store2, delta);

			expect(getConstraintCount(result2.store)).toBe(1);
			expect(ask(result2.store, ["key"])).toHaveLength(1);
		});
	});

	describe("mergeStores", () => {
		it("should combine all constraints from both stores", () => {
			let store1 = createConstraintStore();
			let store2 = createConstraintStore();

			const c1 = createConstraint("alice", 0, 1, ["a"], eq("from-store1"));
			const c2 = createConstraint("bob", 0, 2, ["b"], eq("from-store2"));

			store1 = tell(store1, c1).store;
			store2 = tell(store2, c2).store;

			const merged = mergeStores(store1, store2);

			expect(getConstraintCount(merged)).toBe(2);
			expect(ask(merged, ["a"])).toHaveLength(1);
			expect(ask(merged, ["b"])).toHaveLength(1);
		});

		it("should deduplicate identical constraints", () => {
			let store1 = createConstraintStore();
			let store2 = createConstraintStore();

			const c = createConstraint("alice", 0, 1, ["key"], eq("value"));

			store1 = tell(store1, c).store;
			store2 = tell(store2, c).store;

			const merged = mergeStores(store1, store2);

			expect(getConstraintCount(merged)).toBe(1);
		});

		it("should merge version vectors correctly", () => {
			let store1 = createConstraintStore();
			let store2 = createConstraintStore();

			const c1 = createConstraint("alice", 5, 10, ["a"], eq(1));
			const c2 = createConstraint("bob", 3, 20, ["b"], eq(2));

			store1 = tell(store1, c1).store;
			store2 = tell(store2, c2).store;

			const merged = mergeStores(store1, store2);
			const vv = getVersionVector(merged);

			expect(vvGet(vv, "alice")).toBe(6); // 5 + 1
			expect(vvGet(vv, "bob")).toBe(4); // 3 + 1
		});

		it("should take maximum Lamport clock", () => {
			let store1 = createConstraintStore();
			let store2 = createConstraintStore();

			const c1 = createConstraint("alice", 0, 100, ["a"], eq(1));
			const c2 = createConstraint("bob", 0, 50, ["b"], eq(2));

			store1 = tell(store1, c1).store;
			store2 = tell(store2, c2).store;

			const merged = mergeStores(store1, store2);

			expect(getLamport(merged)).toBe(100);
		});

		it("should be commutative", () => {
			let store1 = createConstraintStore();
			let store2 = createConstraintStore();

			const c1 = createConstraint("alice", 0, 1, ["a"], eq(1));
			const c2 = createConstraint("bob", 0, 2, ["b"], eq(2));

			store1 = tell(store1, c1).store;
			store2 = tell(store2, c2).store;

			const merged1 = mergeStores(store1, store2);
			const merged2 = mergeStores(store2, store1);

			expect(getConstraintCount(merged1)).toBe(getConstraintCount(merged2));
			expect(getLamport(merged1)).toBe(getLamport(merged2));
		});

		it("should be associative", () => {
			let store1 = createConstraintStore();
			let store2 = createConstraintStore();
			let store3 = createConstraintStore();

			store1 = tell(store1, createConstraint("a", 0, 1, ["x"], eq(1))).store;
			store2 = tell(store2, createConstraint("b", 0, 2, ["y"], eq(2))).store;
			store3 = tell(store3, createConstraint("c", 0, 3, ["z"], eq(3))).store;

			const leftFirst = mergeStores(mergeStores(store1, store2), store3);
			const rightFirst = mergeStores(store1, mergeStores(store2, store3));

			expect(getConstraintCount(leftFirst)).toBe(
				getConstraintCount(rightFirst),
			);
		});

		it("should be idempotent", () => {
			let store = createConstraintStore();
			const c = createConstraint("alice", 0, 1, ["key"], eq("value"));

			store = tell(store, c).store;

			const merged = mergeStores(store, store);

			expect(getConstraintCount(merged)).toBe(1);
		});
	});

	describe("iteration", () => {
		it("iterPaths should yield all unique paths", () => {
			let store = createConstraintStore();

			store = tellMany(store, [
				createConstraint("a", 0, 1, ["path1"], eq(1)),
				createConstraint("a", 1, 2, ["path2"], eq(2)),
				createConstraint("b", 0, 3, ["path1"], eq(3)), // Same path, different peer
			]).store;

			const paths = Array.from(iterPaths(store));

			expect(paths).toHaveLength(2);
			expect(paths).toContainEqual(["path1"]);
			expect(paths).toContainEqual(["path2"]);
		});

		it("iterConstraints should yield all constraints", () => {
			let store = createConstraintStore();

			store = tellMany(store, [
				createConstraint("a", 0, 1, ["x"], eq(1)),
				createConstraint("a", 1, 2, ["y"], eq(2)),
			]).store;

			const constraints = Array.from(iterConstraints(store));

			expect(constraints).toHaveLength(2);
		});
	});
});
