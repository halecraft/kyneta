/**
 * Text Handle Tests
 *
 * Tests for TextHandle functionality:
 * - Insert operations (insert, append, prepend)
 * - Delete operations
 * - Replace and clear
 * - Multi-peer scenarios
 * - Merge operations
 */

import { describe, it, expect } from "vitest";
import {
	createTextHandle,
	mergeTextHandles,
	type TextHandle,
} from "../../src/handles/text-handle.js";
import { createConstraintStore } from "../../src/store/constraint-store.js";
import type { ConstraintStore } from "../../src/store/constraint-store.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestHandle(peerId: string, store?: ConstraintStore): TextHandle {
	return createTextHandle({
		peerId,
		store: store ?? createConstraintStore(),
		path: ["text"],
	});
}

// ============================================================================
// Tests
// ============================================================================

describe("TextHandle", () => {
	describe("createTextHandle", () => {
		it("should create a handle with empty text", () => {
			const handle = createTestHandle("alice");

			expect(handle.path).toEqual(["text"]);
			expect(handle.get()).toBeUndefined();
			expect(handle.toString()).toBe("");
		});
	});

	describe("insert", () => {
		it("should insert single character", () => {
			const handle = createTestHandle("alice");

			const constraints = handle.insert(0, "A");
			expect(constraints.length).toBe(1);
			expect(handle.toString()).toBe("A");
		});

		it("should insert multiple characters", () => {
			const handle = createTestHandle("alice");

			const constraints = handle.insert(0, "Hello");
			expect(constraints.length).toBe(5);
			expect(handle.toString()).toBe("Hello");
		});

		it("should insert at beginning", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "World");
			handle.insert(0, "Hello ");
			expect(handle.toString()).toBe("Hello World");
		});

		it("should insert at end", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hello");
			handle.insert(5, " World");
			expect(handle.toString()).toBe("Hello World");
		});

		it("should insert in middle", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hllo");
			handle.insert(1, "e");
			expect(handle.toString()).toBe("Hello");
		});

		it("should return empty array for empty string", () => {
			const handle = createTestHandle("alice");

			const constraints = handle.insert(0, "");
			expect(constraints.length).toBe(0);
			expect(handle.toString()).toBe("");
		});

		it("should handle Unicode characters", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "🎉日本語");
			expect(handle.toString()).toBe("🎉日本語");
			expect(handle.view().length()).toBe(4);
		});

		it("should chain origins correctly within insert", () => {
			const handle = createTestHandle("alice");

			const constraints = handle.insert(0, "ABC");

			// First char has originLeft=null
			expect(constraints[0]!.assertion).toMatchObject({
				type: "seq_element",
				value: "A",
				originLeft: null,
			});

			// Second char has originLeft pointing to first
			expect(constraints[1]!.assertion).toMatchObject({
				type: "seq_element",
				value: "B",
				originLeft: { peer: "alice", counter: 0 },
			});

			// Third char has originLeft pointing to second
			expect(constraints[2]!.assertion).toMatchObject({
				type: "seq_element",
				value: "C",
				originLeft: { peer: "alice", counter: 1 },
			});
		});
	});

	describe("delete", () => {
		it("should delete single character", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hello");
			const constraints = handle.delete(0, 1);

			expect(constraints.length).toBe(1);
			expect(handle.toString()).toBe("ello");
		});

		it("should delete multiple characters", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hello");
			handle.delete(1, 3); // Delete "ell"

			expect(handle.toString()).toBe("Ho");
		});

		it("should delete at end", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hello");
			handle.delete(3, 2); // Delete "lo"

			expect(handle.toString()).toBe("Hel");
		});

		it("should handle delete beyond length", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hi");
			const constraints = handle.delete(0, 100);

			expect(constraints.length).toBe(2);
			expect(handle.toString()).toBe("");
		});

		it("should return empty array for zero length", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hello");
			const constraints = handle.delete(0, 0);

			expect(constraints.length).toBe(0);
			expect(handle.toString()).toBe("Hello");
		});

		it("should return empty array for negative length", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hello");
			const constraints = handle.delete(0, -1);

			expect(constraints.length).toBe(0);
			expect(handle.toString()).toBe("Hello");
		});
	});

	describe("append", () => {
		it("should append to empty text", () => {
			const handle = createTestHandle("alice");

			handle.append("Hello");
			expect(handle.toString()).toBe("Hello");
		});

		it("should append to existing text", () => {
			const handle = createTestHandle("alice");

			handle.append("Hello");
			handle.append(" World");
			expect(handle.toString()).toBe("Hello World");
		});
	});

	describe("prepend", () => {
		it("should prepend to empty text", () => {
			const handle = createTestHandle("alice");

			handle.prepend("Hello");
			expect(handle.toString()).toBe("Hello");
		});

		it("should prepend to existing text", () => {
			const handle = createTestHandle("alice");

			handle.prepend("World");
			handle.prepend("Hello ");
			expect(handle.toString()).toBe("Hello World");
		});
	});

	describe("replace", () => {
		it("should replace characters", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hello");
			const constraints = handle.replace(1, 3, "i"); // "Hello" -> "Hio"

			// 3 deletes + 1 insert
			expect(constraints.length).toBe(4);
			expect(handle.toString()).toBe("Hio");
		});

		it("should replace at beginning", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hello");
			handle.replace(0, 2, "J"); // "Hello" -> "Jllo"

			expect(handle.toString()).toBe("Jllo");
		});

		it("should replace at end", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hello");
			handle.replace(3, 2, "p!"); // "Hello" -> "Help!"

			expect(handle.toString()).toBe("Help!");
		});

		it("should replace with longer text", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hi");
			handle.replace(0, 2, "Hello"); // "Hi" -> "Hello"

			expect(handle.toString()).toBe("Hello");
		});

		it("should replace with shorter text", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hello");
			handle.replace(0, 5, "Hi"); // "Hello" -> "Hi"

			expect(handle.toString()).toBe("Hi");
		});

		it("should handle replace with empty string (pure delete)", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hello");
			handle.replace(1, 3, ""); // "Hello" -> "Ho"

			expect(handle.toString()).toBe("Ho");
		});
	});

	describe("clear", () => {
		it("should clear all text", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hello World");
			const constraints = handle.clear();

			expect(constraints.length).toBe(11);
			expect(handle.toString()).toBe("");
		});

		it("should return empty array for already empty text", () => {
			const handle = createTestHandle("alice");

			const constraints = handle.clear();
			expect(constraints.length).toBe(0);
		});
	});

	describe("view", () => {
		it("should provide a view of the text", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hello");

			const view = handle.view();
			expect(view.toString()).toBe("Hello");
			expect(view.length()).toBe(5);
			expect(view.charAt(0)).toBe("H");
		});

		it("should provide fresh view on each call", () => {
			const handle = createTestHandle("alice");

			const view1 = handle.view();
			handle.insert(0, "Hi");
			const view2 = handle.view();

			expect(view1.toString()).toBe(""); // Stale
			expect(view2.toString()).toBe("Hi"); // Fresh
		});
	});

	describe("getStore", () => {
		it("should return the current store", () => {
			const handle = createTestHandle("alice");

			handle.insert(0, "Hi");

			const store = handle.getStore();
			expect(store.constraints.size).toBe(2);
		});
	});
});

describe("Multi-peer scenarios", () => {
	it("should handle concurrent appends", () => {
		const alice = createTestHandle("alice");
		const bob = createTestHandle("bob");

		alice.append("Hello");
		bob.append("World");

		// Merge
		mergeTextHandles(alice, bob);
		mergeTextHandles(bob, alice);

		// Both should converge
		expect(alice.toString()).toBe(bob.toString());
	});

	it("should handle concurrent inserts at same position", () => {
		const alice = createTestHandle("alice");
		const bob = createTestHandle("bob", alice.getStore());

		// Both insert at position 0
		alice.insert(0, "A");
		bob.insert(0, "B");

		// Merge
		mergeTextHandles(alice, bob);

		// Should have consistent order (alice < bob lexicographically, so A first)
		expect(alice.toString()).toBe("AB");
	});

	it("should handle interleaved typing", () => {
		const alice = createTestHandle("alice");
		const bob = createTestHandle("bob");

		// Alice types "ac"
		alice.append("a");
		alice.append("c");

		// Bob types "bd" (after seeing nothing)
		bob.append("b");
		bob.append("d");

		// Merge
		mergeTextHandles(alice, bob);
		mergeTextHandles(bob, alice);

		// Both should converge
		expect(alice.toString()).toBe(bob.toString());
	});

	it("should handle delete and insert at same position", () => {
		// Setup: alice has "Hello"
		const alice = createTestHandle("alice");
		alice.append("Hello");

		// Bob starts with same state
		const bob = createTestHandle("bob", alice.getStore());

		// Alice deletes "ello"
		alice.delete(1, 4);

		// Bob inserts "i" at position 1 (thinking "Hello" is still there)
		bob.insert(1, "i");

		// Merge
		mergeTextHandles(alice, bob);
		mergeTextHandles(bob, alice);

		// Both should converge to "Hi" (insert survives, deleted chars gone)
		expect(alice.toString()).toBe(bob.toString());
		expect(alice.toString()).toBe("Hi");
	});

	it("should handle both peers deleting same character", () => {
		// Setup: shared "ABC"
		const alice = createTestHandle("alice");
		alice.append("ABC");

		const bob = createTestHandle("bob", alice.getStore());

		// Both delete 'B'
		alice.delete(1, 1);
		bob.delete(1, 1);

		// Merge
		mergeTextHandles(alice, bob);
		mergeTextHandles(bob, alice);

		// Should be "AC" (not "A" or "AC" twice deleted)
		expect(alice.toString()).toBe("AC");
		expect(bob.toString()).toBe("AC");
	});
});

describe("mergeTextHandles", () => {
	it("should merge stores", () => {
		const alice = createTestHandle("alice");
		const bob = createTestHandle("bob");

		alice.append("Hello");
		bob.append("World");

		mergeTextHandles(alice, bob);

		// Alice should have both
		expect(alice.view().length()).toBeGreaterThan(5);
	});

	it("should be commutative", () => {
		const alice = createTestHandle("alice");
		const bob = createTestHandle("bob");

		alice.append("A");
		bob.append("B");

		// Create copies for different merge orders
		const alice2 = createTestHandle("alice2", alice.getStore());
		const bob2 = createTestHandle("bob2", bob.getStore());

		mergeTextHandles(alice, bob);
		mergeTextHandles(bob2, alice2);

		// Should produce same result
		expect(alice.toString()).toBe(bob2.toString());
	});
});

describe("Edge Cases", () => {
	it("should handle emoji correctly", () => {
		const handle = createTestHandle("alice");

		handle.append("👋🌍");
		expect(handle.toString()).toBe("👋🌍");
		expect(handle.view().length()).toBe(2);

		handle.delete(0, 1);
		expect(handle.toString()).toBe("🌍");
	});

	it("should handle CJK characters", () => {
		const handle = createTestHandle("alice");

		handle.append("日本語");
		expect(handle.toString()).toBe("日本語");
		expect(handle.view().length()).toBe(3);
	});

	it("should handle mixed scripts", () => {
		const handle = createTestHandle("alice");

		handle.append("Hello世界🌍");
		expect(handle.toString()).toBe("Hello世界🌍");
		expect(handle.view().length()).toBe(8);
	});

	it("should handle newlines and whitespace", () => {
		const handle = createTestHandle("alice");

		handle.append("Hello\nWorld\t!");
		expect(handle.toString()).toBe("Hello\nWorld\t!");
	});

	it("should handle rapid operations", () => {
		const handle = createTestHandle("alice");

		// Rapid typing simulation
		for (const char of "Hello World") {
			handle.append(char);
		}

		expect(handle.toString()).toBe("Hello World");

		// Rapid deletion (backspace simulation)
		for (let i = 0; i < 6; i++) {
			const len = handle.view().length();
			if (len > 0) {
				handle.delete(len - 1, 1);
			}
		}

		expect(handle.toString()).toBe("Hello");
	});

	it("should handle large text", () => {
		const handle = createTestHandle("alice");

		const text = "a".repeat(100);
		handle.append(text);

		expect(handle.view().length()).toBe(100);
		expect(handle.toString()).toBe(text);

		// Delete middle section
		handle.delete(25, 50);
		expect(handle.view().length()).toBe(50);
	});
});
