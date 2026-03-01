/**
 * Text Equivalence Tests
 *
 * Tests that verify Prism Text produces identical results to Loro Text
 * for concurrent editing scenarios. This validates that our constraint-based
 * implementation correctly implements Fugue semantics.
 *
 * Key scenarios tested:
 * - Sequential typing produces same result
 * - Concurrent inserts at same position interleave identically
 * - Delete + concurrent insert interactions
 * - Multi-character insert chaining
 * - Unicode handling
 */

import { describe, it, expect } from "vitest";
import { LoroDoc } from "loro-crdt";
import {
	createTextHandle,
	mergeTextHandles,
	type TextHandle,
} from "../../src/handles/text-handle.js";
import {
	createConstraintStore,
	mergeStores,
} from "../../src/store/constraint-store.js";
import { createTextView } from "../../src/views/text-view.js";
import type { ConstraintStore } from "../../src/store/constraint-store.js";

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Create a Prism TextHandle for testing.
 */
function createPrismHandle(
	peerId: string,
	store?: ConstraintStore,
): TextHandle {
	return createTextHandle({
		peerId,
		store: store ?? createConstraintStore(),
		path: ["text"],
	});
}

/**
 * Create a Loro document with numeric peer ID.
 *
 * We use peerIdToNum to ensure Loro's numeric peer IDs have the same
 * relative ordering as Prism's string peer IDs.
 */
function createLoroDoc(peerId: string): LoroDoc {
	const peerIdNum = peerIdToNum(peerId);
	const doc = new LoroDoc();
	doc.setPeerId(peerIdNum);
	return doc;
}

/**
 * Convert a string peer ID to a numeric peer ID that preserves ordering.
 *
 * Prism uses lexicographic string comparison for peer ID tiebreakers.
 * Loro uses numeric comparison. To ensure equivalence, we encode the
 * first 6 characters of the string as a base-256 number.
 *
 * This means peerIdToNum("alice") < peerIdToNum("bob") holds.
 */
function peerIdToNum(peerId: string): bigint {
	const padded = peerId.padEnd(6, "\0").slice(0, 6);
	let num = 0n;
	for (let i = 0; i < 6; i++) {
		num = num * 256n + BigInt(padded.charCodeAt(i));
	}
	return num;
}

/**
 * Merge multiple Prism stores into one.
 */
function mergePrismStores(stores: ConstraintStore[]): ConstraintStore {
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
 * Create a merged Prism view for comparison.
 */
function createMergedPrismView(stores: ConstraintStore[]): string {
	const merged = mergePrismStores(stores);
	const view = createTextView({
		store: merged,
		path: ["text"],
	});
	return view.toString();
}

/**
 * Merge Loro documents and get the text.
 */
function mergeLoroDocuments(docs: LoroDoc[]): string {
	if (docs.length === 0) return "";

	const merged = new LoroDoc();
	for (const doc of docs) {
		merged.import(doc.export({ mode: "snapshot" }));
	}
	return merged.getText("text").toString();
}

// ============================================================================
// Tests
// ============================================================================

const textPath = ["text"];

describe("Text Equivalence with Loro/Fugue Semantics", () => {
	describe("Basic Sequential Operations", () => {
		it("single writer: append characters", () => {
			const prism = createPrismHandle("alice");
			prism.append("Hello");

			const loro = createLoroDoc("alice");
			const loroText = loro.getText("text");
			loroText.insert(0, "Hello");

			expect(prism.toString()).toBe("Hello");
			expect(loroText.toString()).toBe("Hello");
			expect(prism.toString()).toBe(loroText.toString());
		});

		it("single writer: insert at beginning", () => {
			const prism = createPrismHandle("alice");
			prism.append("World");
			prism.insert(0, "Hello ");

			const loro = createLoroDoc("alice");
			const loroText = loro.getText("text");
			loroText.insert(0, "World");
			loroText.insert(0, "Hello ");

			expect(prism.toString()).toBe(loroText.toString());
		});

		it("single writer: insert in middle", () => {
			const prism = createPrismHandle("alice");
			prism.append("Hllo");
			prism.insert(1, "e");

			const loro = createLoroDoc("alice");
			const loroText = loro.getText("text");
			loroText.insert(0, "Hllo");
			loroText.insert(1, "e");

			expect(prism.toString()).toBe("Hello");
			expect(prism.toString()).toBe(loroText.toString());
		});

		it("single writer: delete characters", () => {
			const prism = createPrismHandle("alice");
			prism.append("Hello World");
			prism.delete(5, 6); // Delete " World"

			const loro = createLoroDoc("alice");
			const loroText = loro.getText("text");
			loroText.insert(0, "Hello World");
			loroText.delete(5, 6);

			expect(prism.toString()).toBe("Hello");
			expect(prism.toString()).toBe(loroText.toString());
		});

		it("single writer: replace characters", () => {
			const prism = createPrismHandle("alice");
			prism.append("Hello");
			prism.replace(0, 5, "Hi");

			const loro = createLoroDoc("alice");
			const loroText = loro.getText("text");
			loroText.insert(0, "Hello");
			loroText.delete(0, 5);
			loroText.insert(0, "Hi");

			expect(prism.toString()).toBe("Hi");
			expect(prism.toString()).toBe(loroText.toString());
		});
	});

	describe("Concurrent Inserts: Fugue Interleaving Rules", () => {
		it("concurrent inserts at same position: deterministic ordering (vs Loro)", () => {
			const alicePrism = createPrismHandle("alice");
			alicePrism.insert(0, "A");

			const bobPrism = createPrismHandle("bob");
			bobPrism.insert(0, "B");

			const mergedPrism = createMergedPrismView([
				alicePrism.getStore(),
				bobPrism.getStore(),
			]);

			// Loro
			const aliceLoro = createLoroDoc("alice");
			aliceLoro.getText("text").insert(0, "A");

			const bobLoro = createLoroDoc("bob");
			bobLoro.getText("text").insert(0, "B");

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro]);

			// Both should produce same order
			expect(mergedPrism).toBe(mergedLoro);
			// alice < bob lexicographically, so A should come first
			expect(mergedPrism).toBe("AB");
		});

		it("three concurrent inserts: consistent ordering (vs Loro)", () => {
			const alicePrism = createPrismHandle("alice");
			alicePrism.insert(0, "A");

			const bobPrism = createPrismHandle("bob");
			bobPrism.insert(0, "B");

			const carolPrism = createPrismHandle("carol");
			carolPrism.insert(0, "C");

			// Loro
			const aliceLoro = createLoroDoc("alice");
			aliceLoro.getText("text").insert(0, "A");

			const bobLoro = createLoroDoc("bob");
			bobLoro.getText("text").insert(0, "B");

			const carolLoro = createLoroDoc("carol");
			carolLoro.getText("text").insert(0, "C");

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro, carolLoro]);

			// Test all permutations produce same result
			const stores = [
				alicePrism.getStore(),
				bobPrism.getStore(),
				carolPrism.getStore(),
			];

			const permutations = [
				[0, 1, 2],
				[0, 2, 1],
				[1, 0, 2],
				[1, 2, 0],
				[2, 0, 1],
				[2, 1, 0],
			];

			for (const perm of permutations) {
				const ordered = perm.map((i) => stores[i]!);
				const result = createMergedPrismView(ordered);
				expect(result).toBe(mergedLoro);
			}

			// alice < bob < carol, so order should be ABC
			expect(mergedLoro).toBe("ABC");
		});

		it("concurrent multi-char inserts at same position (vs Loro)", () => {
			const alicePrism = createPrismHandle("alice");
			alicePrism.insert(0, "AA");

			const bobPrism = createPrismHandle("bob");
			bobPrism.insert(0, "BB");

			const mergedPrism = createMergedPrismView([
				alicePrism.getStore(),
				bobPrism.getStore(),
			]);

			// Loro
			const aliceLoro = createLoroDoc("alice");
			aliceLoro.getText("text").insert(0, "AA");

			const bobLoro = createLoroDoc("bob");
			bobLoro.getText("text").insert(0, "BB");

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro]);

			expect(mergedPrism).toBe(mergedLoro);
		});

		it("sequential then concurrent inserts (vs Loro)", () => {
			// Alice types "Hello"
			const alicePrism = createPrismHandle("alice");
			alicePrism.append("Hello");

			// Bob gets Alice's state, then both type at end
			const bobPrism = createPrismHandle("bob", alicePrism.getStore());

			alicePrism.append("A");
			bobPrism.append("B");

			const mergedPrism = createMergedPrismView([
				alicePrism.getStore(),
				bobPrism.getStore(),
			]);

			// Loro
			const aliceLoro = createLoroDoc("alice");
			aliceLoro.getText("text").insert(0, "Hello");

			const bobLoro = createLoroDoc("bob");
			bobLoro.import(aliceLoro.export({ mode: "snapshot" }));

			aliceLoro.getText("text").insert(5, "A");
			bobLoro.getText("text").insert(5, "B");

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro]);

			expect(mergedPrism).toBe(mergedLoro);
		});
	});

	describe("Delete Interactions", () => {
		it("delete then insert at same position (vs Loro)", () => {
			const prism = createPrismHandle("alice");
			prism.append("Hello");
			prism.delete(1, 3); // "Hello" -> "Ho"
			prism.insert(1, "i"); // "Ho" -> "Hio"

			const loro = createLoroDoc("alice");
			const loroText = loro.getText("text");
			loroText.insert(0, "Hello");
			loroText.delete(1, 3);
			loroText.insert(1, "i");

			expect(prism.toString()).toBe("Hio");
			expect(prism.toString()).toBe(loroText.toString());
		});

		it("concurrent delete and insert (vs Loro)", () => {
			// Setup: shared "Hello"
			const alicePrism = createPrismHandle("alice");
			alicePrism.append("Hello");

			const bobPrism = createPrismHandle("bob", alicePrism.getStore());

			// Alice deletes "ell"
			alicePrism.delete(1, 3);

			// Bob inserts "i" at position 1 (after H)
			bobPrism.insert(1, "i");

			const mergedPrism = createMergedPrismView([
				alicePrism.getStore(),
				bobPrism.getStore(),
			]);

			// Loro
			const aliceLoro = createLoroDoc("alice");
			aliceLoro.getText("text").insert(0, "Hello");

			const bobLoro = createLoroDoc("bob");
			bobLoro.import(aliceLoro.export({ mode: "snapshot" }));

			aliceLoro.getText("text").delete(1, 3);
			bobLoro.getText("text").insert(1, "i");

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro]);

			expect(mergedPrism).toBe(mergedLoro);
			// Insert should survive, deleted chars gone -> "Hi" + "o" = "Hio"
			expect(mergedPrism).toBe("Hio");
		});

		it("both peers delete same character (vs Loro)", () => {
			// Setup: shared "ABC"
			const alicePrism = createPrismHandle("alice");
			alicePrism.append("ABC");

			const bobPrism = createPrismHandle("bob", alicePrism.getStore());

			// Both delete 'B'
			alicePrism.delete(1, 1);
			bobPrism.delete(1, 1);

			const mergedPrism = createMergedPrismView([
				alicePrism.getStore(),
				bobPrism.getStore(),
			]);

			// Loro
			const aliceLoro = createLoroDoc("alice");
			aliceLoro.getText("text").insert(0, "ABC");

			const bobLoro = createLoroDoc("bob");
			bobLoro.import(aliceLoro.export({ mode: "snapshot" }));

			aliceLoro.getText("text").delete(1, 1);
			bobLoro.getText("text").delete(1, 1);

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro]);

			expect(mergedPrism).toBe(mergedLoro);
			expect(mergedPrism).toBe("AC");
		});

		it("delete different characters concurrently (vs Loro)", () => {
			// Setup: shared "ABCD"
			const alicePrism = createPrismHandle("alice");
			alicePrism.append("ABCD");

			const bobPrism = createPrismHandle("bob", alicePrism.getStore());

			// Alice deletes 'B', Bob deletes 'C'
			alicePrism.delete(1, 1);
			bobPrism.delete(2, 1);

			const mergedPrism = createMergedPrismView([
				alicePrism.getStore(),
				bobPrism.getStore(),
			]);

			// Loro
			const aliceLoro = createLoroDoc("alice");
			aliceLoro.getText("text").insert(0, "ABCD");

			const bobLoro = createLoroDoc("bob");
			bobLoro.import(aliceLoro.export({ mode: "snapshot" }));

			aliceLoro.getText("text").delete(1, 1);
			bobLoro.getText("text").delete(2, 1);

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro]);

			expect(mergedPrism).toBe(mergedLoro);
			expect(mergedPrism).toBe("AD");
		});
	});

	describe("Merge Properties (Commutativity, Associativity, Idempotence)", () => {
		it("merge is commutative: A ∪ B = B ∪ A (vs Loro)", () => {
			const alice = createPrismHandle("alice");
			alice.append("Hello");

			const bob = createPrismHandle("bob");
			bob.append("World");

			const ab = createMergedPrismView([alice.getStore(), bob.getStore()]);
			const ba = createMergedPrismView([bob.getStore(), alice.getStore()]);

			expect(ab).toBe(ba);

			// Compare with Loro
			const aliceLoro = createLoroDoc("alice");
			aliceLoro.getText("text").insert(0, "Hello");

			const bobLoro = createLoroDoc("bob");
			bobLoro.getText("text").insert(0, "World");

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro]);
			expect(ab).toBe(mergedLoro);
		});

		it("merge is associative: (A ∪ B) ∪ C = A ∪ (B ∪ C)", () => {
			const a = createPrismHandle("alice");
			a.append("A");

			const b = createPrismHandle("bob");
			b.append("B");

			const c = createPrismHandle("carol");
			c.append("C");

			// (A ∪ B) ∪ C
			const ab = mergePrismStores([a.getStore(), b.getStore()]);
			const abC = createMergedPrismView([ab, c.getStore()]);

			// A ∪ (B ∪ C)
			const bc = mergePrismStores([b.getStore(), c.getStore()]);
			const aBC = createMergedPrismView([a.getStore(), bc]);

			expect(abC).toBe(aBC);
		});

		it("merge is idempotent: A ∪ A = A", () => {
			const a = createPrismHandle("alice");
			a.append("Hello");

			const original = a.toString();
			const merged = createMergedPrismView([a.getStore(), a.getStore()]);

			expect(merged).toBe(original);
		});

		it("merge with concurrent ops is deterministic regardless of order (vs Loro)", () => {
			// Create 5 peers each inserting at position 0
			const peers = ["alice", "bob", "carol", "dave", "eve"];
			const handles = peers.map((p) => {
				const h = createPrismHandle(p);
				h.insert(0, p[0]!.toUpperCase());
				return h;
			});

			const stores = handles.map((h) => h.getStore());

			// Try all orderings (just a sample, not all 120)
			const orderings = [
				[0, 1, 2, 3, 4],
				[4, 3, 2, 1, 0],
				[2, 0, 4, 1, 3],
				[1, 3, 0, 4, 2],
			];

			const results = orderings.map((order) => {
				const ordered = order.map((i) => stores[i]!);
				return createMergedPrismView(ordered);
			});

			// All should be the same
			for (const result of results) {
				expect(result).toBe(results[0]);
			}

			// Compare with Loro
			const loroDocs = peers.map((p) => {
				const doc = createLoroDoc(p);
				doc.getText("text").insert(0, p[0]!.toUpperCase());
				return doc;
			});

			const mergedLoro = mergeLoroDocuments(loroDocs);
			expect(results[0]).toBe(mergedLoro);
		});
	});

	describe("Complex Multi-Peer Scenarios", () => {
		it("interleaved typing simulation (vs Loro)", () => {
			// Alice types "Hello" character by character
			const alicePrism = createPrismHandle("alice");
			for (const char of "Hello") {
				alicePrism.append(char);
			}

			// Bob independently types "World"
			const bobPrism = createPrismHandle("bob");
			for (const char of "World") {
				bobPrism.append(char);
			}

			const mergedPrism = createMergedPrismView([
				alicePrism.getStore(),
				bobPrism.getStore(),
			]);

			// Loro
			const aliceLoro = createLoroDoc("alice");
			const aliceLoroText = aliceLoro.getText("text");
			let alicePos = 0;
			for (const char of "Hello") {
				aliceLoroText.insert(alicePos++, char);
			}

			const bobLoro = createLoroDoc("bob");
			const bobLoroText = bobLoro.getText("text");
			let bobPos = 0;
			for (const char of "World") {
				bobLoroText.insert(bobPos++, char);
			}

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro]);

			expect(mergedPrism).toBe(mergedLoro);
		});

		it("offline peer syncs later (vs Loro)", () => {
			// Alice and Bob collaborate
			const alicePrism = createPrismHandle("alice");
			alicePrism.append("Hello");

			const bobPrism = createPrismHandle("bob", alicePrism.getStore());
			bobPrism.append(" World");

			// Carol was offline, typed independently
			const carolPrism = createPrismHandle("carol");
			carolPrism.append("Hi!");

			// Now Carol syncs
			const mergedPrism = createMergedPrismView([
				alicePrism.getStore(),
				bobPrism.getStore(),
				carolPrism.getStore(),
			]);

			// Loro
			const aliceLoro = createLoroDoc("alice");
			aliceLoro.getText("text").insert(0, "Hello");

			const bobLoro = createLoroDoc("bob");
			bobLoro.import(aliceLoro.export({ mode: "snapshot" }));
			bobLoro.getText("text").insert(5, " World");

			const carolLoro = createLoroDoc("carol");
			carolLoro.getText("text").insert(0, "Hi!");

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro, carolLoro]);

			expect(mergedPrism).toBe(mergedLoro);
		});

		it("collaborative editing with concurrent inserts at different positions (vs Loro)", () => {
			// Setup: shared "Hello World"
			const alicePrism = createPrismHandle("alice");
			alicePrism.append("Hello World");

			const bobPrism = createPrismHandle("bob", alicePrism.getStore());

			// Alice inserts "!" at the end
			alicePrism.insert(11, "!");

			// Bob inserts "Beautiful " before "World" (position 6)
			bobPrism.insert(6, "Beautiful ");

			const mergedPrism = createMergedPrismView([
				alicePrism.getStore(),
				bobPrism.getStore(),
			]);

			// Loro
			const aliceLoro = createLoroDoc("alice");
			aliceLoro.getText("text").insert(0, "Hello World");

			const bobLoro = createLoroDoc("bob");
			bobLoro.import(aliceLoro.export({ mode: "snapshot" }));

			// Alice's insert at end
			aliceLoro.getText("text").insert(11, "!");

			// Bob's insert
			bobLoro.getText("text").insert(6, "Beautiful ");

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro]);

			expect(mergedPrism).toBe(mergedLoro);
			expect(mergedPrism).toBe("Hello Beautiful World!");
		});
	});

	describe("Edge Cases", () => {
		it("empty text", () => {
			const prism = createPrismHandle("alice");
			const loro = createLoroDoc("alice");

			expect(prism.toString()).toBe("");
			expect(loro.getText("text").toString()).toBe("");
		});

		it("single character", () => {
			const prism = createPrismHandle("alice");
			prism.append("X");

			const loro = createLoroDoc("alice");
			loro.getText("text").insert(0, "X");

			expect(prism.toString()).toBe(loro.getText("text").toString());
		});

		it("Unicode: emoji (vs Loro)", () => {
			const prism = createPrismHandle("alice");
			prism.append("🎉🌍🚀");

			const loro = createLoroDoc("alice");
			loro.getText("text").insert(0, "🎉🌍🚀");

			expect(prism.toString()).toBe(loro.getText("text").toString());
			expect(prism.view().length()).toBe(3);
		});

		it("Unicode: CJK characters (vs Loro)", () => {
			const prism = createPrismHandle("alice");
			prism.append("日本語");

			const loro = createLoroDoc("alice");
			loro.getText("text").insert(0, "日本語");

			expect(prism.toString()).toBe(loro.getText("text").toString());
			expect(prism.view().length()).toBe(3);
		});

		it("Unicode: mixed scripts (vs Loro)", () => {
			const prism = createPrismHandle("alice");
			prism.append("Hello世界🌍");

			const loro = createLoroDoc("alice");
			loro.getText("text").insert(0, "Hello世界🌍");

			expect(prism.toString()).toBe(loro.getText("text").toString());
		});

		it("concurrent Unicode inserts (vs Loro)", () => {
			const alicePrism = createPrismHandle("alice");
			alicePrism.insert(0, "🎉");

			const bobPrism = createPrismHandle("bob");
			bobPrism.insert(0, "🌍");

			const mergedPrism = createMergedPrismView([
				alicePrism.getStore(),
				bobPrism.getStore(),
			]);

			const aliceLoro = createLoroDoc("alice");
			aliceLoro.getText("text").insert(0, "🎉");

			const bobLoro = createLoroDoc("bob");
			bobLoro.getText("text").insert(0, "🌍");

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro]);

			expect(mergedPrism).toBe(mergedLoro);
		});

		it("delete all then insert (vs Loro)", () => {
			const prism = createPrismHandle("alice");
			prism.append("Hello");
			prism.clear();
			prism.append("World");

			const loro = createLoroDoc("alice");
			const loroText = loro.getText("text");
			loroText.insert(0, "Hello");
			loroText.delete(0, 5);
			loroText.insert(0, "World");

			expect(prism.toString()).toBe(loroText.toString());
			expect(prism.toString()).toBe("World");
		});

		it("many sequential inserts (vs Loro)", () => {
			const prism = createPrismHandle("alice");
			const loro = createLoroDoc("alice");
			const loroText = loro.getText("text");

			const text = "The quick brown fox jumps over the lazy dog.";
			for (let i = 0; i < text.length; i++) {
				prism.append(text[i]!);
				loroText.insert(i, text[i]!);
			}

			expect(prism.toString()).toBe(loroText.toString());
			expect(prism.toString()).toBe(text);
		});
	});
});
