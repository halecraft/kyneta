/**
 * Text View Tests
 *
 * Tests for TextView functionality:
 * - Basic text operations (get, toString, length, charAt, slice)
 * - Solved value with conflict tracking
 * - Tombstone tracking
 * - Reactive view with subscriptions
 */

import { describe, it, expect, vi } from "vitest";
import {
	createTextView,
	createReactiveTextView,
} from "../../src/views/text-view.js";
import {
	createConstraintStore,
	tell,
	tellMany,
} from "../../src/store/constraint-store.js";
import { createConstraint } from "../../src/core/constraint.js";
import { seqElement, deleted } from "../../src/core/assertions.js";
import { opIdToString } from "../../src/core/types.js";
import type { ConstraintStore } from "../../src/store/constraint-store.js";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a constraint for a text character.
 */
function createCharConstraint(
	peer: string,
	counter: number,
	lamport: number,
	path: string[],
	char: string,
	originLeft: { peer: string; counter: number } | null,
	originRight: { peer: string; counter: number } | null,
) {
	const elemPath = [...path, opIdToString({ peer, counter })];
	return createConstraint(
		peer,
		counter,
		lamport,
		elemPath,
		seqElement(char, originLeft, originRight),
	);
}

/**
 * Create a delete constraint for a text character.
 */
function createDeleteConstraint(
	peer: string,
	counter: number,
	lamport: number,
	path: string[],
	targetId: { peer: string; counter: number },
) {
	const elemPath = [...path, opIdToString(targetId)];
	return createConstraint(peer, counter, lamport, elemPath, deleted());
}

/**
 * Build a test store with "Hello" at ["text"].
 */
function buildTestStore(): ConstraintStore {
	let store = createConstraintStore();

	// Build "Hello" with proper chaining
	// H: originLeft=null, originRight=null
	const h = createCharConstraint("alice", 0, 1, ["text"], "H", null, null);
	store = tell(store, h).store;

	// e: originLeft=H, originRight=null
	const e = createCharConstraint(
		"alice",
		1,
		2,
		["text"],
		"e",
		{ peer: "alice", counter: 0 },
		null,
	);
	store = tell(store, e).store;

	// l: originLeft=e, originRight=null
	const l1 = createCharConstraint(
		"alice",
		2,
		3,
		["text"],
		"l",
		{ peer: "alice", counter: 1 },
		null,
	);
	store = tell(store, l1).store;

	// l: originLeft=l, originRight=null
	const l2 = createCharConstraint(
		"alice",
		3,
		4,
		["text"],
		"l",
		{ peer: "alice", counter: 2 },
		null,
	);
	store = tell(store, l2).store;

	// o: originLeft=l, originRight=null
	const o = createCharConstraint(
		"alice",
		4,
		5,
		["text"],
		"o",
		{ peer: "alice", counter: 3 },
		null,
	);
	store = tell(store, o).store;

	return store;
}

// ============================================================================
// Tests
// ============================================================================

describe("TextView", () => {
	describe("createTextView", () => {
		it("should create a view with the correct path", () => {
			const store = createConstraintStore();
			const view = createTextView({ store, path: ["text"] });

			expect(view.path).toEqual(["text"]);
		});

		it("should return undefined for empty text", () => {
			const store = createConstraintStore();
			const view = createTextView({ store, path: ["text"] });

			expect(view.get()).toBeUndefined();
			expect(view.toString()).toBe("");
			expect(view.length()).toBe(0);
			expect(view.isEmpty()).toBe(true);
		});
	});

	describe("get and toString", () => {
		it("should return text content", () => {
			const store = buildTestStore();
			const view = createTextView({ store, path: ["text"] });

			expect(view.get()).toBe("Hello");
			expect(view.toString()).toBe("Hello");
		});

		it("should handle single character", () => {
			let store = createConstraintStore();
			const c = createCharConstraint("alice", 0, 1, ["text"], "A", null, null);
			store = tell(store, c).store;

			const view = createTextView({ store, path: ["text"] });
			expect(view.get()).toBe("A");
			expect(view.toString()).toBe("A");
		});
	});

	describe("length and isEmpty", () => {
		it("should return correct length", () => {
			const store = buildTestStore();
			const view = createTextView({ store, path: ["text"] });

			expect(view.length()).toBe(5);
			expect(view.isEmpty()).toBe(false);
		});

		it("should return 0 for empty text", () => {
			const store = createConstraintStore();
			const view = createTextView({ store, path: ["text"] });

			expect(view.length()).toBe(0);
			expect(view.isEmpty()).toBe(true);
		});
	});

	describe("charAt", () => {
		it("should return character at index", () => {
			const store = buildTestStore();
			const view = createTextView({ store, path: ["text"] });

			expect(view.charAt(0)).toBe("H");
			expect(view.charAt(1)).toBe("e");
			expect(view.charAt(2)).toBe("l");
			expect(view.charAt(3)).toBe("l");
			expect(view.charAt(4)).toBe("o");
		});

		it("should return undefined for out of bounds", () => {
			const store = buildTestStore();
			const view = createTextView({ store, path: ["text"] });

			expect(view.charAt(-1)).toBeUndefined();
			expect(view.charAt(5)).toBeUndefined();
			expect(view.charAt(100)).toBeUndefined();
		});
	});

	describe("slice", () => {
		it("should return substring", () => {
			const store = buildTestStore();
			const view = createTextView({ store, path: ["text"] });

			expect(view.slice(0, 2)).toBe("He");
			expect(view.slice(1, 4)).toBe("ell");
			expect(view.slice(2)).toBe("llo");
		});

		it("should handle edge cases", () => {
			const store = buildTestStore();
			const view = createTextView({ store, path: ["text"] });

			expect(view.slice(0)).toBe("Hello");
			expect(view.slice(0, 100)).toBe("Hello");
			expect(view.slice(5)).toBe("");
		});

		it("should return empty string for empty text", () => {
			const store = createConstraintStore();
			const view = createTextView({ store, path: ["text"] });

			expect(view.slice(0, 10)).toBe("");
		});
	});

	describe("getSolved", () => {
		it("should return solved value with metadata", () => {
			const store = buildTestStore();
			const view = createTextView({ store, path: ["text"] });

			const solved = view.getSolved();
			expect(solved.value).toBe("Hello");
			expect(solved.determinedBy).toBeDefined();
			expect(solved.conflicts).toEqual([]);
		});

		it("should return empty for no constraints", () => {
			const store = createConstraintStore();
			const view = createTextView({ store, path: ["text"] });

			const solved = view.getSolved();
			expect(solved.value).toBeUndefined();
			expect(solved.determinedBy).toBeUndefined();
		});
	});

	describe("tombstone tracking", () => {
		it("should track deleted characters", () => {
			let store = buildTestStore();

			// Delete the 'e' (alice@1)
			const del = createDeleteConstraint("alice", 5, 6, ["text"], {
				peer: "alice",
				counter: 1,
			});
			store = tell(store, del).store;

			const view = createTextView({ store, path: ["text"] });
			expect(view.toString()).toBe("Hllo");
			expect(view.length()).toBe(4);
			expect(view.tombstoneCount()).toBe(1);
		});

		it("should handle multiple deletions", () => {
			let store = buildTestStore();

			// Delete 'e' and first 'l'
			const del1 = createDeleteConstraint("alice", 5, 6, ["text"], {
				peer: "alice",
				counter: 1,
			});
			const del2 = createDeleteConstraint("alice", 6, 7, ["text"], {
				peer: "alice",
				counter: 2,
			});
			store = tellMany(store, [del1, del2]).store;

			const view = createTextView({ store, path: ["text"] });
			expect(view.toString()).toBe("Hlo");
			expect(view.length()).toBe(3);
			expect(view.tombstoneCount()).toBe(2);
		});
	});

	describe("conflict detection", () => {
		it("should detect concurrent inserts", () => {
			let store = createConstraintStore();

			// Alice inserts 'A' at start
			const a = createCharConstraint("alice", 0, 1, ["text"], "A", null, null);
			store = tell(store, a).store;

			// Bob concurrently inserts 'B' at start (same originLeft=null, originRight=null)
			const b = createCharConstraint("bob", 0, 1, ["text"], "B", null, null);
			store = tell(store, b).store;

			const view = createTextView({ store, path: ["text"] });
			expect(view.hasConcurrentInserts()).toBe(true);
			expect(view.hasConflicts()).toBe(true);
		});

		it("should not report conflicts for sequential inserts", () => {
			const store = buildTestStore();
			const view = createTextView({ store, path: ["text"] });

			expect(view.hasConcurrentInserts()).toBe(false);
			expect(view.hasConflicts()).toBe(false);
		});
	});

	describe("getNode", () => {
		it("should return FugueNode at index", () => {
			const store = buildTestStore();
			const view = createTextView({ store, path: ["text"] });

			const node = view.getNode(0);
			expect(node).toBeDefined();
			expect(node!.value).toBe("H");
			expect(node!.id).toEqual({ peer: "alice", counter: 0 });
		});

		it("should return undefined for out of bounds", () => {
			const store = buildTestStore();
			const view = createTextView({ store, path: ["text"] });

			expect(view.getNode(-1)).toBeUndefined();
			expect(view.getNode(100)).toBeUndefined();
		});
	});

	describe("getConstraints", () => {
		it("should return all constraints", () => {
			const store = buildTestStore();
			const view = createTextView({ store, path: ["text"] });

			const constraints = view.getConstraints();
			expect(constraints.length).toBe(5); // 5 characters
		});
	});

	describe("subscriptions", () => {
		it("should allow subscribing and unsubscribing", () => {
			const store = createConstraintStore();
			const view = createTextView({ store, path: ["text"] });

			const callback = vi.fn();
			const unsubscribe = view.subscribe(callback);

			expect(typeof unsubscribe).toBe("function");
			unsubscribe();
			// No error thrown
		});
	});
});

describe("ReactiveTextView", () => {
	describe("createReactiveTextView", () => {
		it("should create a reactive view", () => {
			const store = buildTestStore();
			const view = createReactiveTextView({ store, path: ["text"] });

			expect(view.path).toEqual(["text"]);
			expect(view.toString()).toBe("Hello");
		});
	});

	describe("updateStore", () => {
		it("should update to new store", () => {
			let store = createConstraintStore();
			const view = createReactiveTextView({ store, path: ["text"] });

			expect(view.toString()).toBe("");

			// Add a character to a new store
			const c = createCharConstraint("alice", 0, 1, ["text"], "X", null, null);
			store = tell(store, c).store;

			// Update the view's store
			view.updateStore(store);
			expect(view.toString()).toBe("X");
		});
	});

	describe("notifyConstraintsChanged", () => {
		it("should notify subscribers on change", () => {
			let store = createConstraintStore();
			const view = createReactiveTextView({ store, path: ["text"] });

			const callback = vi.fn();
			view.subscribe(callback);

			// Add a character
			const c = createCharConstraint("alice", 0, 1, ["text"], "A", null, null);
			store = tell(store, c).store;
			view.updateStore(store);
			view.notifyConstraintsChanged([c]);

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({
					before: undefined,
					after: "A",
				}),
			);
		});

		it("should not notify if value unchanged", () => {
			const store = buildTestStore();
			const view = createReactiveTextView({ store, path: ["text"] });

			const callback = vi.fn();
			view.subscribe(callback);

			// Notify with no actual change
			view.notifyConstraintsChanged([]);

			expect(callback).not.toHaveBeenCalled();
		});

		it("should track sequential changes", () => {
			let store = createConstraintStore();
			const view = createReactiveTextView({ store, path: ["text"] });

			const callback = vi.fn();
			view.subscribe(callback);

			// Add 'H'
			const h = createCharConstraint("alice", 0, 1, ["text"], "H", null, null);
			store = tell(store, h).store;
			view.updateStore(store);
			view.notifyConstraintsChanged([h]);

			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({
					before: undefined,
					after: "H",
				}),
			);

			// Add 'i'
			const i = createCharConstraint(
				"alice",
				1,
				2,
				["text"],
				"i",
				{ peer: "alice", counter: 0 },
				null,
			);
			store = tell(store, i).store;
			view.updateStore(store);
			view.notifyConstraintsChanged([i]);

			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({
					before: "H",
					after: "Hi",
				}),
			);
		});
	});

	// Note: ReactiveTextView inherits all TextView methods via spread.
	// Those methods are tested in the TextView section above.
});

describe("Edge Cases", () => {
	it("should handle Unicode characters", () => {
		let store = createConstraintStore();

		// Add emoji and CJK characters
		const chars = ["🎉", "日", "本"];
		let prevId: { peer: string; counter: number } | null = null;

		for (let i = 0; i < chars.length; i++) {
			const c = createCharConstraint(
				"alice",
				i,
				i + 1,
				["text"],
				chars[i]!,
				prevId,
				null,
			);
			store = tell(store, c).store;
			prevId = { peer: "alice", counter: i };
		}

		const view = createTextView({ store, path: ["text"] });
		expect(view.toString()).toBe("🎉日本");
		expect(view.length()).toBe(3);
		expect(view.charAt(0)).toBe("🎉");
		expect(view.charAt(1)).toBe("日");
	});

	it("should handle all characters deleted", () => {
		let store = buildTestStore();

		// Delete all characters
		for (let i = 0; i < 5; i++) {
			const del = createDeleteConstraint("alice", 5 + i, 6 + i, ["text"], {
				peer: "alice",
				counter: i,
			});
			store = tell(store, del).store;
		}

		const view = createTextView({ store, path: ["text"] });
		expect(view.toString()).toBe("");
		expect(view.length()).toBe(0);
		expect(view.isEmpty()).toBe(true);
		expect(view.tombstoneCount()).toBe(5);
	});

	it("should handle very long text", () => {
		let store = createConstraintStore();
		const text = "a".repeat(100);
		let prevId: { peer: string; counter: number } | null = null;

		for (let i = 0; i < text.length; i++) {
			const c = createCharConstraint(
				"alice",
				i,
				i + 1,
				["text"],
				text[i]!,
				prevId,
				null,
			);
			store = tell(store, c).store;
			prevId = { peer: "alice", counter: i };
		}

		const view = createTextView({ store, path: ["text"] });
		expect(view.length()).toBe(100);
		expect(view.toString()).toBe(text);
		expect(view.slice(50, 60)).toBe("aaaaaaaaaa");
	});

	it("should handle text at nested path", () => {
		let store = createConstraintStore();

		const c = createCharConstraint(
			"alice",
			0,
			1,
			["doc", "content", "body"],
			"X",
			null,
			null,
		);
		store = tell(store, c).store;

		const view = createTextView({ store, path: ["doc", "content", "body"] });
		expect(view.toString()).toBe("X");
	});
});
