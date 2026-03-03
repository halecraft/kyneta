/**
 * PrismDoc Integration Tests
 *
 * End-to-end tests for the PrismDoc coordinator:
 * - Multi-container documents
 * - Shared store: mutations via one handle visible through another
 * - Sync between simulated peers (delta and merge)
 * - Full convergence verification
 * - Subscription wiring through PrismDoc
 * - Introspection through PrismDoc
 * - Container isolation (different paths don't interfere)
 */

import { describe, it, expect, vi } from "vitest";
import { createPrismDoc, syncDocs, type PrismDoc } from "../src/doc/prism-doc.js";
import { createVersionVector } from "../src/core/version-vector.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createDoc(peerId: string): PrismDoc {
	return createPrismDoc({ peerId });
}

// ============================================================================
// Tests
// ============================================================================

describe("PrismDoc", () => {
	describe("creation", () => {
		it("should create a document with a peer ID", () => {
			const doc = createDoc("alice");

			expect(doc.peerId).toBe("alice");
			expect(doc.getLamport()).toBe(0);
			expect(doc.getGeneration()).toBe(0);
		});
	});

	describe("Map container", () => {
		it("should set and get values", () => {
			const doc = createDoc("alice");
			const profile = doc.getMap("profile");

			profile.set("name", "Alice");
			profile.set("age", 30);

			expect(profile.get()).toEqual({ name: "Alice", age: 30 });
		});

		it("should delete keys", () => {
			const doc = createDoc("alice");
			const map = doc.getMap("data");

			map.set("a", 1);
			map.set("b", 2);
			map.delete("a");

			expect(map.get()).toEqual({ b: 2 });
		});

		it("should support setMany and deleteMany", () => {
			const doc = createDoc("alice");
			const map = doc.getMap("data");

			map.setMany({ x: 1, y: 2, z: 3 });
			expect(map.get()).toEqual({ x: 1, y: 2, z: 3 });

			map.deleteMany(["x", "z"]);
			expect(map.get()).toEqual({ y: 2 });
		});

		it("should provide fresh views", () => {
			const doc = createDoc("alice");
			const map = doc.getMap("data");

			const view1 = map.view();
			map.set("key", "value");
			const view2 = map.view();

			// view1 was created before the set, view2 after
			expect(view1.get()).toBeUndefined();
			expect(view2.get()).toEqual({ key: "value" });
		});
	});

	describe("List container", () => {
		it("should push and get values", () => {
			const doc = createDoc("alice");
			const list = doc.getList<string>("todos");

			list.push("first");
			list.push("second");
			list.push("third");

			expect(list.get()).toEqual(["first", "second", "third"]);
		});

		it("should insert at index", () => {
			const doc = createDoc("alice");
			const list = doc.getList<string>("items");

			list.push("A");
			list.push("C");
			list.insert(1, "B");

			expect(list.get()).toEqual(["A", "B", "C"]);
		});

		it("should delete elements", () => {
			const doc = createDoc("alice");
			const list = doc.getList<number>("nums");

			list.pushMany([10, 20, 30, 40]);
			list.delete(1); // delete 20

			expect(list.get()).toEqual([10, 30, 40]);
		});

		it("should delete ranges", () => {
			const doc = createDoc("alice");
			const list = doc.getList<number>("nums");

			list.pushMany([1, 2, 3, 4, 5]);
			list.deleteRange(1, 3); // delete 2, 3, 4

			expect(list.get()).toEqual([1, 5]);
		});

		it("should unshift to beginning", () => {
			const doc = createDoc("alice");
			const list = doc.getList<string>("items");

			list.push("B");
			list.unshift("A");

			expect(list.get()).toEqual(["A", "B"]);
		});
	});

	describe("Text container", () => {
		it("should insert and read text", () => {
			const doc = createDoc("alice");
			const text = doc.getText("content");

			text.insert(0, "Hello");
			expect(text.toString()).toBe("Hello");
		});

		it("should append text", () => {
			const doc = createDoc("alice");
			const text = doc.getText("content");

			text.append("Hello");
			text.append(" World");
			expect(text.toString()).toBe("Hello World");
		});

		it("should delete text", () => {
			const doc = createDoc("alice");
			const text = doc.getText("content");

			text.append("Hello World");
			text.delete(5, 6); // delete " World"
			expect(text.toString()).toBe("Hello");
		});

		it("should replace text", () => {
			const doc = createDoc("alice");
			const text = doc.getText("content");

			text.append("Hello");
			text.replace(0, 5, "Hi");
			expect(text.toString()).toBe("Hi");
		});

		it("should handle Unicode", () => {
			const doc = createDoc("alice");
			const text = doc.getText("content");

			text.append("🎉日本語");
			expect(text.toString()).toBe("🎉日本語");
			expect(text.view().length()).toBe(4);
		});
	});

	describe("string path shorthand", () => {
		it("should treat string paths as single-segment arrays", () => {
			const doc = createDoc("alice");

			const map = doc.getMap("profile");
			map.set("name", "Alice");

			// Same path via array
			const map2 = doc.getMap(["profile"]);
			expect(map2.get()).toEqual({ name: "Alice" });
		});

		it("should support array paths for nesting", () => {
			const doc = createDoc("alice");

			const map = doc.getMap(["users", "alice"]);
			map.set("name", "Alice");

			expect(map.get()).toEqual({ name: "Alice" });
		});
	});

	describe("shared store: cross-handle visibility", () => {
		it("mutations through one Map handle should be visible through another at the same path", () => {
			const doc = createDoc("alice");

			const handle1 = doc.getMap("data");
			const handle2 = doc.getMap("data");

			handle1.set("key", "value");

			// handle2 reads from the same shared store
			expect(handle2.get()).toEqual({ key: "value" });
		});

		it("mutations through a List handle should be visible through a fresh view", () => {
			const doc = createDoc("alice");

			const list = doc.getList<string>("items");
			list.push("A");

			// A fresh handle at the same path sees the data
			const list2 = doc.getList<string>("items");
			expect(list2.get()).toEqual(["A"]);
		});

		it("mutations across different container types at different paths should coexist", () => {
			const doc = createDoc("alice");

			const map = doc.getMap("profile");
			const list = doc.getList<string>("todos");
			const text = doc.getText("notes");

			map.set("name", "Alice");
			list.push("Buy milk");
			text.append("Remember to call Bob");

			expect(map.get()).toEqual({ name: "Alice" });
			expect(list.get()).toEqual(["Buy milk"]);
			expect(text.toString()).toBe("Remember to call Bob");
		});
	});

	describe("container isolation", () => {
		it("constraints at different paths should not interfere", () => {
			const doc = createDoc("alice");

			const map1 = doc.getMap("map1");
			const map2 = doc.getMap("map2");

			map1.set("key", "value1");
			map2.set("key", "value2");

			expect(map1.view().getKey("key")).toBe("value1");
			expect(map2.view().getKey("key")).toBe("value2");
		});

		it("list and map at different paths should not interfere", () => {
			const doc = createDoc("alice");

			const map = doc.getMap("data");
			const list = doc.getList<string>("data-list");

			map.set("x", 1);
			list.push("A");

			expect(map.get()).toEqual({ x: 1 });
			expect(list.get()).toEqual(["A"]);
		});
	});
});

describe("Sync", () => {
	describe("merge", () => {
		it("should merge two docs with independent edits", () => {
			const alice = createDoc("alice");
			const bob = createDoc("bob");

			alice.getMap("data").set("from", "alice");
			bob.getMap("data").set("from", "bob");

			alice.merge(bob);

			const map = alice.getMap("data");
			const view = map.view();
			// Both keys should be present
			expect(view.has("from")).toBe(true);
			// LWW determines which "from" value wins (both lamport=1, higher peer wins)
			expect(view.getKey("from")).toBeDefined();
		});

		it("should make both docs converge after bidirectional merge", () => {
			const alice = createDoc("alice");
			const bob = createDoc("bob");

			alice.getMap("profile").set("name", "Alice");
			bob.getMap("profile").set("age", 30);

			// Bidirectional merge
			alice.merge(bob);
			bob.merge(alice);

			expect(alice.getMap("profile").get()).toEqual({ name: "Alice", age: 30 });
			expect(bob.getMap("profile").get()).toEqual({ name: "Alice", age: 30 });
		});

		it("should converge lists after merge", () => {
			const alice = createDoc("alice");
			const bob = createDoc("bob");

			// Both append to their own list
			alice.getList<string>("items").push("A");
			bob.getList<string>("items").push("B");

			// Sync
			alice.merge(bob);
			bob.merge(alice);

			// Both should see the same order
			const aliceItems = alice.getList<string>("items").get();
			const bobItems = bob.getList<string>("items").get();
			expect(aliceItems).toEqual(bobItems);
			expect(aliceItems).toHaveLength(2);
		});

		it("should converge text after merge", () => {
			const alice = createDoc("alice");
			const bob = createDoc("bob");

			alice.getText("doc").append("Hello");
			bob.getText("doc").append("World");

			alice.merge(bob);
			bob.merge(alice);

			expect(alice.getText("doc").toString()).toBe(
				bob.getText("doc").toString(),
			);
		});
	});

	describe("delta sync", () => {
		it("should sync via delta export/import", () => {
			const alice = createDoc("alice");
			const bob = createDoc("bob");

			alice.getMap("data").set("key", "value");

			// Export delta from alice for bob
			const delta = alice.exportDelta(bob.getVersionVector());
			expect(delta.constraints.length).toBeGreaterThan(0);

			// Import into bob
			bob.importDelta(delta);

			expect(bob.getMap("data").get()).toEqual({ key: "value" });
		});

		it("should not send already-seen constraints", () => {
			const alice = createDoc("alice");
			const bob = createDoc("bob");

			alice.getMap("data").set("key", "value");

			// First sync
			const delta1 = alice.exportDelta(bob.getVersionVector());
			bob.importDelta(delta1);

			// Second sync (no new constraints)
			const delta2 = alice.exportDelta(bob.getVersionVector());
			expect(delta2.constraints.length).toBe(0);
		});

		it("should sync bidirectionally via deltas", () => {
			const alice = createDoc("alice");
			const bob = createDoc("bob");

			alice.getMap("data").set("alice-key", "alice-value");
			bob.getMap("data").set("bob-key", "bob-value");

			// Bidirectional delta exchange
			const deltaA = alice.exportDelta(bob.getVersionVector());
			const deltaB = bob.exportDelta(alice.getVersionVector());

			bob.importDelta(deltaA);
			alice.importDelta(deltaB);

			const expected = { "alice-key": "alice-value", "bob-key": "bob-value" };
			expect(alice.getMap("data").get()).toEqual(expected);
			expect(bob.getMap("data").get()).toEqual(expected);
		});
	});

	describe("syncDocs convenience", () => {
		it("should sync two docs bidirectionally", () => {
			const alice = createDoc("alice");
			const bob = createDoc("bob");

			alice.getMap("data").set("a", 1);
			bob.getMap("data").set("b", 2);

			syncDocs(alice, bob);

			expect(alice.getMap("data").get()).toEqual({ a: 1, b: 2 });
			expect(bob.getMap("data").get()).toEqual({ a: 1, b: 2 });
		});
	});

	describe("merge properties", () => {
		it("merge is commutative: A.merge(B) then B.merge(A) converges", () => {
			const a = createDoc("alice");
			const b = createDoc("bob");

			a.getMap("data").set("x", 1);
			b.getMap("data").set("y", 2);

			a.merge(b);
			b.merge(a);

			expect(a.getMap("data").get()).toEqual(b.getMap("data").get());
		});

		it("merge is idempotent: merging same doc twice has no effect", () => {
			const a = createDoc("alice");
			const b = createDoc("bob");

			a.getMap("data").set("x", 1);
			b.getMap("data").set("y", 2);

			a.merge(b);
			const after1 = a.getMap("data").get();
			const gen1 = a.getGeneration();

			a.merge(b); // Same merge again
			const after2 = a.getMap("data").get();

			expect(after1).toEqual(after2);
		});

		it("three-peer convergence", () => {
			const alice = createDoc("alice");
			const bob = createDoc("bob");
			const carol = createDoc("carol");

			alice.getMap("data").set("a", 1);
			bob.getMap("data").set("b", 2);
			carol.getMap("data").set("c", 3);

			// Hub-and-spoke sync through alice
			alice.merge(bob);
			alice.merge(carol);
			bob.merge(alice);
			carol.merge(alice);

			const expected = { a: 1, b: 2, c: 3 };
			expect(alice.getMap("data").get()).toEqual(expected);
			expect(bob.getMap("data").get()).toEqual(expected);
			expect(carol.getMap("data").get()).toEqual(expected);
		});
	});
});

describe("Subscriptions via PrismDoc", () => {
	it("should fire onConstraintAdded for mutations", () => {
		const doc = createDoc("alice");
		const callback = vi.fn();

		doc.onConstraintAdded(callback);
		doc.getMap("data").set("key", "value");

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "constraint_added",
			}),
		);
	});

	it("should fire onStateChanged for specific path", () => {
		const doc = createDoc("alice");
		const callback = vi.fn();

		doc.onStateChanged(["data", "name"], callback);
		doc.getMap("data").set("name", "Alice");

		expect(callback).toHaveBeenCalledTimes(1);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "state_changed",
				path: ["data", "name"],
			}),
		);
	});

	it("should not fire onStateChanged for unrelated path", () => {
		const doc = createDoc("alice");
		const callback = vi.fn();

		doc.onStateChanged(["data", "name"], callback);
		doc.getMap("data").set("age", 30);

		expect(callback).not.toHaveBeenCalled();
	});

	it("should fire onStateChangedPrefix for child paths", () => {
		const doc = createDoc("alice");
		const callback = vi.fn();

		doc.onStateChangedPrefix(["data"], callback);

		doc.getMap("data").set("name", "Alice");
		doc.getMap("data").set("age", 30);

		expect(callback).toHaveBeenCalledTimes(2);
	});

	it("should fire subscription callbacks on import", () => {
		const alice = createDoc("alice");
		const bob = createDoc("bob");

		alice.getMap("data").set("key", "value");

		const callback = vi.fn();
		bob.onConstraintAdded(callback);

		const delta = alice.exportDelta(bob.getVersionVector());
		bob.importDelta(delta);

		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("should fire subscription callbacks on merge", () => {
		const alice = createDoc("alice");
		const bob = createDoc("bob");

		alice.getMap("data").set("key", "value");

		const callback = vi.fn();
		bob.onConstraintAdded(callback);

		bob.merge(alice);

		expect(callback).toHaveBeenCalledTimes(1);
	});

	it("should support unsubscribe", () => {
		const doc = createDoc("alice");
		const callback = vi.fn();

		const unsub = doc.onConstraintAdded(callback);
		doc.getMap("data").set("a", 1);
		expect(callback).toHaveBeenCalledTimes(1);

		unsub();
		doc.getMap("data").set("b", 2);
		expect(callback).toHaveBeenCalledTimes(1); // Not called again
	});
});

describe("Introspection via PrismDoc", () => {
	it("should explain a value", () => {
		const doc = createDoc("alice");
		doc.getMap("data").set("key", "value");

		const api = doc.introspect();
		const explanation = api.explain(["data", "key"]);

		expect(explanation.value).toBe("value");
		expect(explanation.hasValue).toBe(true);
		expect(explanation.determinedBy?.peer).toBe("alice");
	});

	it("should report conflicts", () => {
		const alice = createDoc("alice");
		const bob = createDoc("bob");

		alice.getMap("data").set("key", "alice-value");
		bob.getMap("data").set("key", "bob-value");

		alice.merge(bob);

		const api = alice.introspect();
		const explanation = api.explain(["data", "key"]);

		expect(explanation.hasConflicts).toBe(true);
		expect(explanation.conflicts.length).toBe(1);
	});

	it("should provide inspector", () => {
		const doc = createDoc("alice");
		doc.getMap("data").set("key", "value");

		const inspector = doc.inspector();
		const stats = inspector.getStatistics();

		expect(stats.totalConstraints).toBe(1);
		expect(stats.uniquePeers).toBe(1);
	});
});

describe("Complex scenarios", () => {
	it("collaborative document editing", () => {
		// Alice creates a document structure
		const alice = createDoc("alice");
		alice.getMap("meta").set("title", "Meeting Notes");
		alice.getMap("meta").set("author", "Alice");
		alice.getText("body").append("Welcome to the meeting.");
		alice.getList<string>("attendees").push("Alice");

		// Bob starts from scratch, then syncs
		const bob = createDoc("bob");
		syncDocs(alice, bob);

		// Verify Bob sees everything
		expect(bob.getMap("meta").get()).toEqual({
			title: "Meeting Notes",
			author: "Alice",
		});
		expect(bob.getText("body").toString()).toBe("Welcome to the meeting.");
		expect(bob.getList<string>("attendees").get()).toEqual(["Alice"]);

		// Both edit concurrently
		alice.getText("body").append(" Alice says hi.");
		bob.getText("body").append(" Bob says hello.");
		bob.getList<string>("attendees").push("Bob");

		// Sync again
		syncDocs(alice, bob);

		// Both converge
		expect(alice.getText("body").toString()).toBe(
			bob.getText("body").toString(),
		);
		expect(alice.getList<string>("attendees").get()).toEqual(
			bob.getList<string>("attendees").get(),
		);

		// Attendees list should have both
		const attendees = alice.getList<string>("attendees").get()!;
		expect(attendees).toContain("Alice");
		expect(attendees).toContain("Bob");
	});

	it("offline peer syncs later", () => {
		const alice = createDoc("alice");
		const bob = createDoc("bob");
		const carol = createDoc("carol");

		// Alice and Bob collaborate
		alice.getMap("data").set("shared", "initial");
		syncDocs(alice, bob);

		// Both edit while Carol is offline
		alice.getMap("data").set("alice-edit", true);
		bob.getMap("data").set("bob-edit", true);

		// Carol independently edits
		carol.getMap("data").set("carol-edit", true);

		// Sync alice <-> bob
		syncDocs(alice, bob);

		// Now carol comes online and syncs with alice
		syncDocs(alice, carol);

		// Sync all remaining
		syncDocs(bob, carol);
		syncDocs(alice, bob);

		// All three converge
		const expected = {
			shared: "initial",
			"alice-edit": true,
			"bob-edit": true,
			"carol-edit": true,
		};
		expect(alice.getMap("data").get()).toEqual(expected);
		expect(bob.getMap("data").get()).toEqual(expected);
		expect(carol.getMap("data").get()).toEqual(expected);
	});

	it("concurrent list edits with delete", () => {
		const alice = createDoc("alice");
		alice.getList<string>("items").pushMany(["A", "B", "C", "D", "E"]);

		const bob = createDoc("bob");
		syncDocs(alice, bob);

		// Alice deletes B and D
		alice.getList<string>("items").delete(1); // B
		// After deleting B, D is now at index 2
		alice.getList<string>("items").delete(2); // D

		// Bob inserts X after B (position 2, he still sees B)
		bob.getList<string>("items").insert(2, "X");

		syncDocs(alice, bob);

		// Both converge to the same thing
		const aliceItems = alice.getList<string>("items").get()!;
		const bobItems = bob.getList<string>("items").get()!;
		expect(aliceItems).toEqual(bobItems);

		// A should be present, B and D deleted, X inserted
		expect(aliceItems).toContain("A");
		expect(aliceItems).toContain("X");
		expect(aliceItems).toContain("C");
		expect(aliceItems).toContain("E");
		expect(aliceItems).not.toContain("B");
		expect(aliceItems).not.toContain("D");
	});

	it("version vectors track peer knowledge correctly", () => {
		const alice = createDoc("alice");
		const bob = createDoc("bob");

		alice.getMap("data").set("a", 1);
		alice.getMap("data").set("b", 2);

		// Alice has 2 ops, bob has 0
		expect(alice.getVersionVector().get("alice")).toBe(2);
		expect(bob.getVersionVector().get("alice")).toBeUndefined();

		// After sync, bob knows about alice's ops
		syncDocs(alice, bob);
		expect(bob.getVersionVector().get("alice")).toBe(2);
	});
});
