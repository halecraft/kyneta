/**
 * Map Handle Tests
 *
 * Tests for MapHandle functionality:
 * - set/delete operations
 * - constraint generation
 * - view integration
 * - multi-peer scenarios
 */

import { describe, it, expect } from "vitest";
import {
	createMapHandle,
	mergeMapHandles,
} from "../../src/handles/map-handle.js";
import {
	createConstraintStore,
	mergeStores,
} from "../../src/store/constraint-store.js";
import type { Path } from "../../src/core/types.js";

describe("MapHandle", () => {
	const mapPath: Path = ["mymap"];

	describe("createMapHandle", () => {
		it("should create a handle over an empty store", () => {
			const store = createConstraintStore();
			const handle = createMapHandle({
				peerId: "alice",
				store,
				path: mapPath,
			});

			expect(handle.path).toEqual(mapPath);
			expect(handle.get()).toBeUndefined();
			expect(handle.view().keys()).toEqual([]);
		});
	});

	describe("set", () => {
		it("should set a key and return the constraint", () => {
			const store = createConstraintStore();
			const handle = createMapHandle({
				peerId: "alice",
				store,
				path: mapPath,
			});

			const constraint = handle.set("name", "Alice");

			expect(constraint.id.peer).toBe("alice");
			expect(constraint.path).toEqual(["mymap", "name"]);
			expect(constraint.assertion).toEqual({ type: "eq", value: "Alice" });
		});

		it("should make the value readable via getKey", () => {
			const store = createConstraintStore();
			const handle = createMapHandle({
				peerId: "alice",
				store,
				path: mapPath,
			});

			handle.set("name", "Alice");

			expect(handle.view().getKey("name")).toBe("Alice");
			expect(handle.view().has("name")).toBe(true);
		});

		it("should increment counters for each operation", () => {
			const store = createConstraintStore();
			const handle = createMapHandle({
				peerId: "alice",
				store,
				path: mapPath,
			});

			const c1 = handle.set("a", 1);
			const c2 = handle.set("b", 2);
			const c3 = handle.set("c", 3);

			expect(c1.id.counter).toBe(0);
			expect(c2.id.counter).toBe(1);
			expect(c3.id.counter).toBe(2);
		});

		it("should increment Lamport for each operation", () => {
			const store = createConstraintStore();
			const handle = createMapHandle({
				peerId: "alice",
				store,
				path: mapPath,
			});

			const c1 = handle.set("a", 1);
			const c2 = handle.set("b", 2);
			const c3 = handle.set("c", 3);

			expect(c1.metadata.lamport).toBe(1);
			expect(c2.metadata.lamport).toBe(2);
			expect(c3.metadata.lamport).toBe(3);
		});

		it("should overwrite previous value", () => {
			const store = createConstraintStore();
			const handle = createMapHandle({
				peerId: "alice",
				store,
				path: mapPath,
			});

			handle.set("name", "Alice");
			handle.set("name", "Alicia");

			expect(handle.view().getKey("name")).toBe("Alicia");
		});
	});

	describe("delete", () => {
		it("should delete a key", () => {
			const store = createConstraintStore();
			const handle = createMapHandle({
				peerId: "alice",
				store,
				path: mapPath,
			});

			handle.set("name", "Alice");
			expect(handle.view().has("name")).toBe(true);

			handle.delete("name");
			expect(handle.view().has("name")).toBe(false);
			expect(handle.view().getKey("name")).toBeUndefined();
		});

		it("should return a deleted constraint", () => {
			const store = createConstraintStore();
			const handle = createMapHandle({
				peerId: "alice",
				store,
				path: mapPath,
			});

			handle.set("name", "Alice");
			const constraint = handle.delete("name");

			expect(constraint.assertion).toEqual({ type: "deleted" });
		});
	});

	describe("setMany", () => {
		it("should set multiple keys from object", () => {
			const store = createConstraintStore();
			const handle = createMapHandle({
				peerId: "alice",
				store,
				path: mapPath,
			});

			const constraints = handle.setMany({
				name: "Alice",
				age: 30,
				city: "NYC",
			});

			expect(constraints).toHaveLength(3);
			expect(handle.view().getKey("name")).toBe("Alice");
			expect(handle.view().getKey("age")).toBe(30);
			expect(handle.view().getKey("city")).toBe("NYC");
		});

		it("should set multiple keys from array", () => {
			const store = createConstraintStore();
			const handle = createMapHandle({
				peerId: "alice",
				store,
				path: mapPath,
			});

			const constraints = handle.setMany([
				["a", 1],
				["b", 2],
			]);

			expect(constraints).toHaveLength(2);
			expect(handle.view().getKey("a")).toBe(1);
			expect(handle.view().getKey("b")).toBe(2);
		});
	});

	describe("deleteMany", () => {
		it("should delete multiple keys", () => {
			const store = createConstraintStore();
			const handle = createMapHandle({
				peerId: "alice",
				store,
				path: mapPath,
			});

			handle.setMany({ a: 1, b: 2, c: 3 });
			expect(handle.view().keys()).toHaveLength(3);

			const constraints = handle.deleteMany(["a", "c"]);

			expect(constraints).toHaveLength(2);
			expect(handle.view().has("a")).toBe(false);
			expect(handle.view().has("b")).toBe(true);
			expect(handle.view().has("c")).toBe(false);
		});
	});

	describe("view", () => {
		it("should provide a view of the data", () => {
			const store = createConstraintStore();
			const handle = createMapHandle({
				peerId: "alice",
				store,
				path: mapPath,
			});

			handle.set("name", "Alice");

			const view = handle.view();
			expect(view.getKey("name")).toBe("Alice");
			expect(view.path).toEqual(mapPath);
		});

		it("should update view when handle changes", () => {
			const store = createConstraintStore();
			const handle = createMapHandle({
				peerId: "alice",
				store,
				path: mapPath,
			});

			const view = handle.view();
			expect(view.getKey("name")).toBeUndefined();

			handle.set("name", "Alice");

			// Get fresh view (views are recreated on changes)
			const newView = handle.view();
			expect(newView.getKey("name")).toBe("Alice");
		});
	});

	describe("toObject", () => {
		it("should return plain object representation", () => {
			const store = createConstraintStore();
			const handle = createMapHandle({
				peerId: "alice",
				store,
				path: mapPath,
			});

			handle.setMany({ name: "Alice", age: 30 });

			expect(handle.view().toObject()).toEqual({ name: "Alice", age: 30 });
		});
	});

	describe("getStore", () => {
		it("should return the current store", () => {
			const initialStore = createConstraintStore();
			const handle = createMapHandle({
				peerId: "alice",
				store: initialStore,
				path: mapPath,
			});

			handle.set("key", "value");

			const store = handle.getStore();
			expect(store.constraints.size).toBe(1);
		});
	});
});

describe("Multi-peer scenarios", () => {
	const mapPath: Path = ["shared"];

	it("should merge handles from different peers", () => {
		// Alice's handle
		const aliceHandle = createMapHandle({
			peerId: "alice",
			store: createConstraintStore(),
			path: mapPath,
		});
		aliceHandle.set("alice-key", "alice-value");

		// Bob's handle
		const bobHandle = createMapHandle({
			peerId: "bob",
			store: createConstraintStore(),
			path: mapPath,
		});
		bobHandle.set("bob-key", "bob-value");

		// Merge stores
		const merged = mergeStores(aliceHandle.getStore(), bobHandle.getStore());

		// Create a new handle on merged store
		const mergedHandle = createMapHandle({
			peerId: "merged",
			store: merged,
			path: mapPath,
		});

		expect(mergedHandle.view().getKey("alice-key")).toBe("alice-value");
		expect(mergedHandle.view().getKey("bob-key")).toBe("bob-value");
	});

	it("should resolve conflicts using LWW", () => {
		// Alice sets key with lamport 5
		const aliceHandle = createMapHandle({
			peerId: "alice",
			store: createConstraintStore(),
			path: mapPath,
			initialLamport: 4, // Next will be 5
		});
		aliceHandle.set("key", "alice-value");

		// Bob sets same key with lamport 10
		const bobHandle = createMapHandle({
			peerId: "bob",
			store: createConstraintStore(),
			path: mapPath,
			initialLamport: 9, // Next will be 10
		});
		bobHandle.set("key", "bob-value");

		// Merge
		const merged = mergeStores(aliceHandle.getStore(), bobHandle.getStore());
		const mergedHandle = createMapHandle({
			peerId: "merged",
			store: merged,
			path: mapPath,
		});

		// Bob wins (higher lamport)
		expect(mergedHandle.view().getKey("key")).toBe("bob-value");
	});

	it("should use peer ID as tiebreaker", () => {
		// Both peers set at same lamport
		const aliceHandle = createMapHandle({
			peerId: "alice",
			store: createConstraintStore(),
			path: mapPath,
			initialLamport: 9,
		});
		aliceHandle.set("key", "alice-value");

		const bobHandle = createMapHandle({
			peerId: "bob",
			store: createConstraintStore(),
			path: mapPath,
			initialLamport: 9,
		});
		bobHandle.set("key", "bob-value");

		// Merge
		const merged = mergeStores(aliceHandle.getStore(), bobHandle.getStore());
		const mergedHandle = createMapHandle({
			peerId: "merged",
			store: merged,
			path: mapPath,
		});

		// Bob wins ("bob" > "alice" lexicographically)
		expect(mergedHandle.view().getKey("key")).toBe("bob-value");
	});

	it("should handle delete conflicts", () => {
		// Alice sets value at lamport 5
		const aliceHandle = createMapHandle({
			peerId: "alice",
			store: createConstraintStore(),
			path: mapPath,
			initialLamport: 4,
		});
		aliceHandle.set("key", "alice-value");

		// Bob deletes at lamport 10
		const bobHandle = createMapHandle({
			peerId: "bob",
			store: createConstraintStore(),
			path: mapPath,
			initialLamport: 9,
		});
		bobHandle.set("key", "temp"); // Need to have something to delete conceptually
		bobHandle.delete("key");

		// For this test, we need Bob's delete to win
		// Bob's delete is at lamport 11 (after set at 10)
		// Alice's set is at lamport 5

		// Merge
		const merged = mergeStores(aliceHandle.getStore(), bobHandle.getStore());
		const mergedHandle = createMapHandle({
			peerId: "merged",
			store: merged,
			path: mapPath,
		});

		// Bob's delete should win (higher lamport)
		expect(mergedHandle.view().has("key")).toBe(false);
	});

	it("should handle resurrection after delete", () => {
		// Initial delete at lamport 5
		const deleterHandle = createMapHandle({
			peerId: "deleter",
			store: createConstraintStore(),
			path: mapPath,
			initialLamport: 4,
		});
		deleterHandle.delete("key");

		// Resurrection at lamport 10
		const resurrectHandle = createMapHandle({
			peerId: "resurrect",
			store: createConstraintStore(),
			path: mapPath,
			initialLamport: 9,
		});
		resurrectHandle.set("key", "resurrected");

		// Merge
		const merged = mergeStores(
			deleterHandle.getStore(),
			resurrectHandle.getStore(),
		);
		const mergedHandle = createMapHandle({
			peerId: "merged",
			store: merged,
			path: mapPath,
		});

		// Resurrection wins
		expect(mergedHandle.view().getKey("key")).toBe("resurrected");
	});
});

describe("mergeMapHandles", () => {
	const mapPath: Path = ["shared"];

	it("should merge source into target handle", () => {
		const handle1 = createMapHandle({
			peerId: "alice",
			store: createConstraintStore(),
			path: mapPath,
		});
		handle1.set("a", 1);

		const handle2 = createMapHandle({
			peerId: "bob",
			store: createConstraintStore(),
			path: mapPath,
		});
		handle2.set("b", 2);

		mergeMapHandles(handle1, handle2);

		expect(handle1.getStore().constraints.size).toBe(2);
		expect(handle1.view().getKey("a")).toBe(1);
		expect(handle1.view().getKey("b")).toBe(2);
	});
});
