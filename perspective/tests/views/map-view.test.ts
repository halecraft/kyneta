/**
 * Map View Tests
 *
 * Tests for MapView functionality:
 * - Reading values from constraints
 * - Conflict detection
 * - Subscription to changes
 */

import { describe, it, expect, vi } from "vitest";
import {
	createMapView,
	createReactiveMapView,
} from "../../src/views/map-view.js";
import {
	createConstraintStore,
	tell,
	tellMany,
} from "../../src/store/constraint-store.js";
import { createConstraint } from "../../src/core/constraint.js";
import { eq, deleted } from "../../src/core/assertions.js";
import type { Path } from "../../src/core/types.js";

describe("MapView", () => {
	const mapPath: Path = ["mymap"];

	describe("createMapView", () => {
		it("should create a view over an empty store", () => {
			const store = createConstraintStore();
			const view = createMapView({ store, path: mapPath });

			expect(view.path).toEqual(mapPath);
			expect(view.get()).toBeUndefined();
			expect(view.size()).toBe(0);
			expect(view.keys()).toEqual([]);
		});

		it("should read values from constraints", () => {
			let store = createConstraintStore();
			store = tell(
				store,
				createConstraint("alice", 0, 1, ["mymap", "name"], eq("Alice")),
			).store;
			store = tell(
				store,
				createConstraint("alice", 1, 2, ["mymap", "age"], eq(30)),
			).store;

			const view = createMapView({ store, path: mapPath });

			expect(view.getKey("name")).toBe("Alice");
			expect(view.getKey("age")).toBe(30);
			expect(view.has("name")).toBe(true);
			expect(view.has("unknown")).toBe(false);
			expect(view.size()).toBe(2);
			expect(view.keys()).toContain("name");
			expect(view.keys()).toContain("age");
		});

		it("should return entries as key-value pairs", () => {
			let store = createConstraintStore();
			store = tellMany(store, [
				createConstraint("alice", 0, 1, ["mymap", "a"], eq(1)),
				createConstraint("alice", 1, 2, ["mymap", "b"], eq(2)),
			]).store;

			const view = createMapView<number>({ store, path: mapPath });
			const entries = view.entries();

			expect(entries).toHaveLength(2);
			expect(entries).toContainEqual(["a", 1]);
			expect(entries).toContainEqual(["b", 2]);
		});

		it("should convert to plain object", () => {
			let store = createConstraintStore();
			store = tellMany(store, [
				createConstraint("alice", 0, 1, ["mymap", "name"], eq("Alice")),
				createConstraint("alice", 1, 2, ["mymap", "age"], eq(30)),
			]).store;

			const view = createMapView({ store, path: mapPath });
			const obj = view.toObject();

			expect(obj).toEqual({ name: "Alice", age: 30 });
		});

		it("should exclude deleted keys", () => {
			let store = createConstraintStore();
			store = tellMany(store, [
				createConstraint("alice", 0, 1, ["mymap", "keep"], eq("value")),
				createConstraint("alice", 1, 2, ["mymap", "remove"], deleted()),
			]).store;

			const view = createMapView({ store, path: mapPath });

			expect(view.has("keep")).toBe(true);
			expect(view.has("remove")).toBe(false);
			expect(view.getKey("remove")).toBeUndefined();
			expect(view.keys()).toContain("keep");
			expect(view.keys()).not.toContain("remove");
		});
	});

	describe("conflict detection", () => {
		it("should detect conflicts between peers", () => {
			let store = createConstraintStore();
			store = tellMany(store, [
				createConstraint("alice", 0, 5, ["mymap", "key"], eq("alice-value")),
				createConstraint("bob", 0, 10, ["mymap", "key"], eq("bob-value")),
			]).store;

			const view = createMapView({ store, path: mapPath });

			expect(view.hasConflicts()).toBe(true);
			expect(view.conflictKeys()).toContain("key");

			// Bob wins (higher lamport)
			expect(view.getKey("key")).toBe("bob-value");
		});

		it("should report no conflicts when none exist", () => {
			let store = createConstraintStore();
			store = tell(
				store,
				createConstraint("alice", 0, 1, ["mymap", "key"], eq("value")),
			).store;

			const view = createMapView({ store, path: mapPath });

			expect(view.hasConflicts()).toBe(false);
			expect(view.conflictKeys()).toHaveLength(0);
		});

		it("should provide solved value with conflict info", () => {
			let store = createConstraintStore();
			store = tellMany(store, [
				createConstraint("alice", 0, 5, ["mymap", "key"], eq("alice")),
				createConstraint("bob", 0, 10, ["mymap", "key"], eq("bob")),
			]).store;

			const view = createMapView({ store, path: mapPath });
			const solved = view.getKeySolved("key");

			expect(solved.value).toBe("bob");
			expect(solved.determinedBy?.id.peer).toBe("bob");
			expect(solved.conflicts).toHaveLength(1);
			expect(solved.conflicts[0]?.id.peer).toBe("alice");
		});
	});

	describe("getSolved", () => {
		it("should return aggregate solved value for entire map", () => {
			let store = createConstraintStore();
			store = tellMany(store, [
				createConstraint("alice", 0, 1, ["mymap", "a"], eq(1)),
				createConstraint("alice", 1, 2, ["mymap", "b"], eq(2)),
			]).store;

			const view = createMapView<number>({ store, path: mapPath });
			const solved = view.getSolved();

			expect(solved.value).toEqual({ a: 1, b: 2 });
			expect(solved.resolution).toContain("2 keys");
		});

		it("should include conflict count in resolution", () => {
			let store = createConstraintStore();
			store = tellMany(store, [
				createConstraint("alice", 0, 5, ["mymap", "key"], eq("alice")),
				createConstraint("bob", 0, 10, ["mymap", "key"], eq("bob")),
			]).store;

			const view = createMapView({ store, path: mapPath });
			const solved = view.getSolved();

			expect(solved.conflicts).toHaveLength(1);
			expect(solved.resolution).toContain("conflict");
		});
	});

	describe("getConstraints", () => {
		it("should return all constraints affecting the map", () => {
			let store = createConstraintStore();
			store = tellMany(store, [
				createConstraint("alice", 0, 1, ["mymap", "a"], eq(1)),
				createConstraint("bob", 0, 2, ["mymap", "b"], eq(2)),
				createConstraint("alice", 1, 3, ["othermap", "c"], eq(3)),
			]).store;

			const view = createMapView({ store, path: mapPath });
			const constraints = view.getConstraints();

			expect(constraints).toHaveLength(2);
		});
	});

	describe("getSolvedMap", () => {
		it("should return the full solved map structure", () => {
			let store = createConstraintStore();
			store = tellMany(store, [
				createConstraint("alice", 0, 1, ["mymap", "name"], eq("Alice")),
				createConstraint("alice", 1, 2, ["mymap", "age"], eq(30)),
			]).store;

			const view = createMapView({ store, path: mapPath });
			const solvedMap = view.getSolvedMap();

			expect(solvedMap.keys).toContain("name");
			expect(solvedMap.keys).toContain("age");
			expect(solvedMap.entries.get("name")?.value).toBe("Alice");
		});
	});
});

describe("ReactiveMapView", () => {
	const mapPath: Path = ["mymap"];

	describe("createReactiveMapView", () => {
		it("should create a reactive view", () => {
			const store = createConstraintStore();
			const view = createReactiveMapView<unknown>({ store, path: mapPath });

			expect(view.path).toEqual(mapPath);
			expect(view.get()).toBeUndefined();
		});

		it("should read initial values", () => {
			let store = createConstraintStore();
			store = tell(
				store,
				createConstraint("alice", 0, 1, ["mymap", "key"], eq("value")),
			).store;

			const view = createReactiveMapView<unknown>({ store, path: mapPath });

			expect(view.getKey("key")).toBe("value");
		});
	});

	describe("updateStore", () => {
		it("should update when store changes", () => {
			let store = createConstraintStore();
			const view = createReactiveMapView<unknown>({ store, path: mapPath });

			expect(view.getKey("key")).toBeUndefined();

			// Update store
			store = tell(
				store,
				createConstraint("alice", 0, 1, ["mymap", "key"], eq("value")),
			).store;
			view.updateStore(store);

			expect(view.getKey("key")).toBe("value");
		});
	});

	describe("subscriptions", () => {
		it("should notify subscribers when constraints change", () => {
			let store = createConstraintStore();
			const view = createReactiveMapView<unknown>({ store, path: mapPath });

			const callback = vi.fn();
			view.subscribe(callback);

			// Add a constraint and notify
			const constraint = createConstraint(
				"alice",
				0,
				1,
				["mymap", "key"],
				eq("value"),
			);
			store = tell(store, constraint).store;
			view.updateStore(store);
			view.notifyConstraintsChanged([constraint]);

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({
					path: mapPath,
					before: undefined,
					after: { key: "value" },
				}),
			);
		});

		it("should not notify if value did not change", () => {
			let store = createConstraintStore();
			store = tell(
				store,
				createConstraint("alice", 0, 1, ["mymap", "key"], eq("value")),
			).store;

			const view = createReactiveMapView<unknown>({ store, path: mapPath });

			const callback = vi.fn();
			view.subscribe(callback);

			// Notify with same constraint (no actual change)
			view.notifyConstraintsChanged([]);

			expect(callback).not.toHaveBeenCalled();
		});

		it("should allow unsubscribing", () => {
			let store = createConstraintStore();
			const view = createReactiveMapView<unknown>({ store, path: mapPath });

			const callback = vi.fn();
			const unsubscribe = view.subscribe(callback);

			// Unsubscribe
			unsubscribe();

			// Add constraint and notify
			const constraint = createConstraint(
				"alice",
				0,
				1,
				["mymap", "key"],
				eq("value"),
			);
			store = tell(store, constraint).store;
			view.updateStore(store);
			view.notifyConstraintsChanged([constraint]);

			expect(callback).not.toHaveBeenCalled();
		});

		it("should include before and after state in events", () => {
			let store = createConstraintStore();
			store = tell(
				store,
				createConstraint("alice", 0, 1, ["mymap", "key"], eq("initial")),
			).store;

			const view = createReactiveMapView<unknown>({ store, path: mapPath });

			const callback = vi.fn();
			view.subscribe(callback);

			// Update the value
			const constraint = createConstraint(
				"alice",
				1,
				2,
				["mymap", "key"],
				eq("updated"),
			);
			store = tell(store, constraint).store;
			view.updateStore(store);
			view.notifyConstraintsChanged([constraint]);

			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({
					before: { key: "initial" },
					after: { key: "updated" },
				}),
			);
		});
	});
});
