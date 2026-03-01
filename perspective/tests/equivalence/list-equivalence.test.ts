/**
 * List Equivalence Tests
 *
 * These tests verify that Prism's List implementation produces
 * identical results to Loro's Fugue-based List for the same operations.
 *
 * Uses loro-crdt as the source of truth for expected behavior.
 *
 * Test categories:
 * 1. Basic sequential operations
 * 2. Concurrent inserts with Fugue interleaving
 * 3. Peer ID tiebreaking (lower peer ID goes left)
 * 4. Delete interactions
 * 5. Complex multi-peer scenarios
 * 6. Commutativity and associativity of merge
 */

import { describe, it, expect } from "vitest";
import { LoroDoc, LoroList } from "loro-crdt";
import {
	createListHandle,
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
 * Create a Prism list handle with specific peer ID.
 */
function createPrismHandle(
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
 * Create a Loro document with a specific peer ID.
 *
 * Loro uses numeric (BigInt) peer IDs. Prism uses string peer IDs compared
 * lexicographically. For equivalence, we assign numeric IDs that preserve
 * the lexicographic ordering of the string IDs. This ensures that when Fugue
 * breaks ties by peer ID, both systems agree on the ordering.
 */
function createLoroDoc(peerId: string): LoroDoc {
	const peerIdNum = BigInt(peerIdToNum(peerId));
	const doc = new LoroDoc();
	doc.setPeerId(peerIdNum);
	return doc;
}

/**
 * Convert a string peer ID to a numeric value that preserves lexicographic order.
 *
 * Encodes the string as a base-256 big number so that lexicographic string
 * comparison matches numeric comparison. We pad to 8 chars to avoid length
 * differences affecting the result (shorter strings sort before longer ones
 * in both schemes when padded with zeros).
 */
function peerIdToNum(peer: string): number {
	// Pad to fixed length to ensure consistent ordering
	const padded = peer.padEnd(16, "\0");
	let num = 0;
	// Use first 6 chars to stay within safe integer range
	for (let i = 0; i < 6; i++) {
		num = num * 256 + padded.charCodeAt(i);
	}
	return num || 1; // Avoid 0
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
 * Create a Prism handle on a merged store for reading results.
 */
function createMergedPrismView(
	stores: ConstraintStore[],
	path: Path = ["list"],
): ListHandle {
	return createListHandle({
		peerId: "viewer",
		store: mergePrismStores(stores),
		path,
	});
}

/**
 * Merge Loro documents.
 */
function mergeLoroDocuments(docs: LoroDoc[]): LoroDoc {
	if (docs.length === 0) {
		return new LoroDoc();
	}

	const merged = new LoroDoc();
	for (const doc of docs) {
		merged.import(doc.export({ mode: "snapshot" }));
	}
	return merged;
}

// ============================================================================
// Loro Equivalence Tests
// ============================================================================

describe("List Equivalence with Loro/Fugue Semantics", () => {
	const listPath: Path = ["list"];

	describe("Basic Sequential Operations", () => {
		it("single writer: push values", () => {
			// Prism
			const prism = createPrismHandle("alice", listPath);
			prism.push("A");
			prism.push("B");
			prism.push("C");

			// Loro
			const loro = createLoroDoc("alice");
			const loroList = loro.getList("list");
			loroList.push("A");
			loroList.push("B");
			loroList.push("C");

			expect(prism.view().toArray()).toEqual(loroList.toArray());
			expect(prism.view().toArray()).toEqual(["A", "B", "C"]);
		});

		it("single writer: insert at beginning", () => {
			// Prism
			const prism = createPrismHandle("alice", listPath);
			prism.push("B");
			prism.push("C");
			prism.unshift("A");

			// Loro
			const loro = createLoroDoc("alice");
			const loroList = loro.getList("list");
			loroList.push("B");
			loroList.push("C");
			loroList.insert(0, "A");

			expect(prism.view().toArray()).toEqual(loroList.toArray());
			expect(prism.view().toArray()).toEqual(["A", "B", "C"]);
		});

		it("single writer: insert in middle", () => {
			// Prism
			const prism = createPrismHandle("alice", listPath);
			prism.push("A");
			prism.push("C");
			prism.insert(1, "B");

			// Loro
			const loro = createLoroDoc("alice");
			const loroList = loro.getList("list");
			loroList.push("A");
			loroList.push("C");
			loroList.insert(1, "B");

			expect(prism.view().toArray()).toEqual(loroList.toArray());
			expect(prism.view().toArray()).toEqual(["A", "B", "C"]);
		});

		it("single writer: delete removes value", () => {
			// Prism
			const prism = createPrismHandle("alice", listPath);
			prism.pushMany(["A", "B", "C"]);
			prism.delete(1);

			// Loro
			const loro = createLoroDoc("alice");
			const loroList = loro.getList("list");
			loroList.push("A");
			loroList.push("B");
			loroList.push("C");
			loroList.delete(1, 1);

			expect(prism.view().toArray()).toEqual(loroList.toArray());
			expect(prism.view().toArray()).toEqual(["A", "C"]);
		});

		it("single writer: delete range", () => {
			// Prism
			const prism = createPrismHandle("alice", listPath);
			prism.pushMany(["A", "B", "C", "D", "E"]);
			prism.deleteRange(1, 3);

			// Loro
			const loro = createLoroDoc("alice");
			const loroList = loro.getList("list");
			loroList.push("A");
			loroList.push("B");
			loroList.push("C");
			loroList.push("D");
			loroList.push("E");
			loroList.delete(1, 3);

			expect(prism.view().toArray()).toEqual(loroList.toArray());
			expect(prism.view().toArray()).toEqual(["A", "E"]);
		});
	});

	describe("Concurrent Inserts: Fugue Interleaving Rules", () => {
		it("concurrent inserts at same position: deterministic ordering (vs Loro)", () => {
			// Alice and Bob both insert into empty lists (concurrent)
			const alicePrism = createPrismHandle("alice", listPath);
			alicePrism.insert(0, "A");

			const bobPrism = createPrismHandle("bob", listPath);
			bobPrism.insert(0, "B");

			const mergedPrism = createMergedPrismView([
				alicePrism.getStore(),
				bobPrism.getStore(),
			]);

			// Same scenario in Loro
			const aliceLoro = createLoroDoc("alice");
			const aliceLoroList = aliceLoro.getList("list");
			aliceLoroList.insert(0, "A");

			const bobLoro = createLoroDoc("bob");
			const bobLoroList = bobLoro.getList("list");
			bobLoroList.insert(0, "B");

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro]);
			const loroResult = mergedLoro.getList("list").toArray();

			const prismResult = mergedPrism.view().toArray();

			// Both elements should be present
			expect(prismResult).toHaveLength(2);
			expect(prismResult).toContain("A");
			expect(prismResult).toContain("B");

			// Compare against Loro's merge result
			expect(prismResult).toEqual(loroResult);

			// Verify determinism: merge order shouldn't matter
			const mergedPrism2 = createMergedPrismView([
				bobPrism.getStore(),
				alicePrism.getStore(),
			]);
			expect(mergedPrism2.view().toArray()).toEqual(prismResult);
		});

		it("three concurrent inserts: consistent ordering (vs Loro)", () => {
			const alicePrism = createPrismHandle("alice", listPath);
			alicePrism.insert(0, "A");

			const bobPrism = createPrismHandle("bob", listPath);
			bobPrism.insert(0, "B");

			const carolPrism = createPrismHandle("carol", listPath);
			carolPrism.insert(0, "C");

			// Same scenario in Loro
			const aliceLoro = createLoroDoc("alice");
			aliceLoro.getList("list").insert(0, "A");

			const bobLoro = createLoroDoc("bob");
			bobLoro.getList("list").insert(0, "B");

			const carolLoro = createLoroDoc("carol");
			carolLoro.getList("list").insert(0, "C");

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro, carolLoro]);
			const loroResult = mergedLoro.getList("list").toArray();

			// Try all permutations of Prism merge
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

			const results = permutations.map((perm) => {
				const ordered = perm.map((i) => stores[i]!);
				return createMergedPrismView(ordered).view().toArray();
			});

			// All Prism results should be identical
			for (let i = 1; i < results.length; i++) {
				expect(results[i]).toEqual(results[0]);
			}

			// All elements should be present
			expect(results[0]).toHaveLength(3);
			expect(results[0]).toContain("A");
			expect(results[0]).toContain("B");
			expect(results[0]).toContain("C");

			// Compare against Loro
			expect(results[0]).toEqual(loroResult);
		});

		it("independent insertions don't conflict (vs Loro)", () => {
			// Alice builds [A, B]
			const alicePrism = createPrismHandle("alice", listPath);
			alicePrism.pushMany(["A", "B"]);

			// Bob and Carol fork from Alice's state
			const bobPrism = createListHandle({
				peerId: "bob",
				store: alicePrism.getStore(),
				path: listPath,
			});
			bobPrism.insert(1, "X"); // Insert X after A

			const carolPrism = createListHandle({
				peerId: "carol",
				store: alicePrism.getStore(),
				path: listPath,
			});
			carolPrism.insert(2, "Y"); // Insert Y at end

			const mergedPrism = createMergedPrismView([
				bobPrism.getStore(),
				carolPrism.getStore(),
			]);

			// Same scenario in Loro: Alice creates [A, B], Bob and Carol fork
			const aliceLoro = createLoroDoc("alice");
			const aliceLoroList = aliceLoro.getList("list");
			aliceLoroList.push("A");
			aliceLoroList.push("B");

			const bobLoro = createLoroDoc("bob");
			bobLoro.import(aliceLoro.export({ mode: "snapshot" }));
			bobLoro.getList("list").insert(1, "X");

			const carolLoro = createLoroDoc("carol");
			carolLoro.import(aliceLoro.export({ mode: "snapshot" }));
			carolLoro.getList("list").insert(2, "Y");

			const mergedLoro = mergeLoroDocuments([bobLoro, carolLoro]);
			const loroResult = mergedLoro.getList("list").toArray();

			expect(mergedPrism.view().toArray()).toEqual(loroResult);
			expect(mergedPrism.view().toArray()).toEqual(["A", "X", "B", "Y"]);
		});

		it("concurrent multi-char inserts at same position (vs Loro)", () => {
			// Alice types "Hi" and Bob types "Lo" at position 0 concurrently
			const alicePrism = createPrismHandle("alice", listPath);
			alicePrism.pushMany(["H", "i"]);

			const bobPrism = createPrismHandle("bob", listPath);
			bobPrism.pushMany(["L", "o"]);

			const mergedPrism = createMergedPrismView([
				alicePrism.getStore(),
				bobPrism.getStore(),
			]);

			// Same in Loro
			const aliceLoro = createLoroDoc("alice");
			const aliceLoroList = aliceLoro.getList("list");
			aliceLoroList.push("H");
			aliceLoroList.push("i");

			const bobLoro = createLoroDoc("bob");
			const bobLoroList = bobLoro.getList("list");
			bobLoroList.push("L");
			bobLoroList.push("o");

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro]);
			const loroResult = mergedLoro.getList("list").toArray();

			const prismResult = mergedPrism.view().toArray();

			// All chars present
			expect(prismResult).toHaveLength(4);

			// Each peer's chars in order relative to each other
			const aliceChars = prismResult.filter((c: unknown) =>
				["H", "i"].includes(c as string),
			);
			expect(aliceChars).toEqual(["H", "i"]);

			const bobChars = prismResult.filter((c: unknown) =>
				["L", "o"].includes(c as string),
			);
			expect(bobChars).toEqual(["L", "o"]);

			// Compare against Loro
			expect(prismResult).toEqual(loroResult);
		});
	});

	describe("Delete Interactions", () => {
		it("delete then insert at same position", () => {
			// Prism
			const prism = createPrismHandle("alice", listPath);
			prism.pushMany(["A", "B", "C"]);
			prism.delete(1); // Delete B
			prism.insert(1, "X"); // Insert X where B was

			// Loro
			const loro = createLoroDoc("alice");
			const loroList = loro.getList("list");
			loroList.push("A");
			loroList.push("B");
			loroList.push("C");
			loroList.delete(1, 1);
			loroList.insert(1, "X");

			expect(prism.view().toArray()).toEqual(loroList.toArray());
			expect(prism.view().toArray()).toEqual(["A", "X", "C"]);
		});

		it("concurrent delete and insert (vs Loro)", () => {
			// Setup: Alice creates [A, B, C]
			const alicePrism = createPrismHandle("alice", listPath);
			alicePrism.pushMany(["A", "B", "C"]);

			// Bob deletes B
			const bobPrism = createListHandle({
				peerId: "bob",
				store: alicePrism.getStore(),
				path: listPath,
			});
			bobPrism.delete(1);

			// Carol inserts X after A (before B)
			const carolPrism = createListHandle({
				peerId: "carol",
				store: alicePrism.getStore(),
				path: listPath,
			});
			carolPrism.insert(1, "X");

			const mergedPrism = createMergedPrismView([
				bobPrism.getStore(),
				carolPrism.getStore(),
			]);

			// Same scenario in Loro
			const aliceLoro = createLoroDoc("alice");
			const aliceLoroList = aliceLoro.getList("list");
			aliceLoroList.push("A");
			aliceLoroList.push("B");
			aliceLoroList.push("C");

			const bobLoro = createLoroDoc("bob");
			bobLoro.import(aliceLoro.export({ mode: "snapshot" }));
			bobLoro.getList("list").delete(1, 1);

			const carolLoro = createLoroDoc("carol");
			carolLoro.import(aliceLoro.export({ mode: "snapshot" }));
			carolLoro.getList("list").insert(1, "X");

			const mergedLoro = mergeLoroDocuments([bobLoro, carolLoro]);
			const loroResult = mergedLoro.getList("list").toArray();

			// X should be inserted, B should be deleted
			expect(mergedPrism.view().toArray()).toEqual(loroResult);
			expect(mergedPrism.view().toArray()).toEqual(["A", "X", "C"]);
		});

		it("both peers delete same element (vs Loro)", () => {
			// Setup: [A, B, C]
			const alicePrism = createPrismHandle("alice", listPath);
			alicePrism.pushMany(["A", "B", "C"]);

			// Both Bob and Carol delete B
			const bobPrism = createListHandle({
				peerId: "bob",
				store: alicePrism.getStore(),
				path: listPath,
			});
			bobPrism.delete(1);

			const carolPrism = createListHandle({
				peerId: "carol",
				store: alicePrism.getStore(),
				path: listPath,
			});
			carolPrism.delete(1);

			const mergedPrism = createMergedPrismView([
				bobPrism.getStore(),
				carolPrism.getStore(),
			]);

			// Same scenario in Loro
			const aliceLoro = createLoroDoc("alice");
			const aliceLoroList = aliceLoro.getList("list");
			aliceLoroList.push("A");
			aliceLoroList.push("B");
			aliceLoroList.push("C");

			const bobLoro = createLoroDoc("bob");
			bobLoro.import(aliceLoro.export({ mode: "snapshot" }));
			bobLoro.getList("list").delete(1, 1);

			const carolLoro = createLoroDoc("carol");
			carolLoro.import(aliceLoro.export({ mode: "snapshot" }));
			carolLoro.getList("list").delete(1, 1);

			const mergedLoro = mergeLoroDocuments([bobLoro, carolLoro]);
			const loroResult = mergedLoro.getList("list").toArray();

			// B should be deleted (idempotent)
			expect(mergedPrism.view().toArray()).toEqual(loroResult);
			expect(mergedPrism.view().toArray()).toEqual(["A", "C"]);
		});

		it("delete different elements concurrently (vs Loro)", () => {
			// Setup: [A, B, C]
			const alicePrism = createPrismHandle("alice", listPath);
			alicePrism.pushMany(["A", "B", "C"]);

			// Bob deletes A
			const bobPrism = createListHandle({
				peerId: "bob",
				store: alicePrism.getStore(),
				path: listPath,
			});
			bobPrism.delete(0);

			// Carol deletes C
			const carolPrism = createListHandle({
				peerId: "carol",
				store: alicePrism.getStore(),
				path: listPath,
			});
			carolPrism.delete(2);

			const mergedPrism = createMergedPrismView([
				bobPrism.getStore(),
				carolPrism.getStore(),
			]);

			// Same scenario in Loro
			const aliceLoro = createLoroDoc("alice");
			const aliceLoroList = aliceLoro.getList("list");
			aliceLoroList.push("A");
			aliceLoroList.push("B");
			aliceLoroList.push("C");

			const bobLoro = createLoroDoc("bob");
			bobLoro.import(aliceLoro.export({ mode: "snapshot" }));
			bobLoro.getList("list").delete(0, 1);

			const carolLoro = createLoroDoc("carol");
			carolLoro.import(aliceLoro.export({ mode: "snapshot" }));
			carolLoro.getList("list").delete(2, 1);

			const mergedLoro = mergeLoroDocuments([bobLoro, carolLoro]);
			const loroResult = mergedLoro.getList("list").toArray();

			expect(mergedPrism.view().toArray()).toEqual(loroResult);
			expect(mergedPrism.view().toArray()).toEqual(["B"]);
		});
	});

	describe("Merge Properties (Commutativity, Associativity, Idempotence)", () => {
		it("merge is commutative: A ∪ B = B ∪ A (vs Loro)", () => {
			const alice = createPrismHandle("alice", listPath);
			alice.push("A");

			const bob = createPrismHandle("bob", listPath);
			bob.push("B");

			const ab = createMergedPrismView([alice.getStore(), bob.getStore()]);
			const ba = createMergedPrismView([bob.getStore(), alice.getStore()]);

			expect(ab.view().toArray()).toEqual(ba.view().toArray());

			// Also verify against Loro
			const aliceLoro = createLoroDoc("alice");
			aliceLoro.getList("list").push("A");
			const bobLoro = createLoroDoc("bob");
			bobLoro.getList("list").push("B");
			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro]);
			expect(ab.view().toArray()).toEqual(mergedLoro.getList("list").toArray());
		});

		it("merge is associative: (A ∪ B) ∪ C = A ∪ (B ∪ C)", () => {
			const a = createPrismHandle("a", listPath);
			a.push("A");

			const b = createPrismHandle("b", listPath);
			b.push("B");

			const c = createPrismHandle("c", listPath);
			c.push("C");

			// (A ∪ B) ∪ C
			const ab = mergePrismStores([a.getStore(), b.getStore()]);
			const abC = createMergedPrismView([ab, c.getStore()]);

			// A ∪ (B ∪ C)
			const bc = mergePrismStores([b.getStore(), c.getStore()]);
			const aBC = createMergedPrismView([a.getStore(), bc]);

			expect(abC.view().toArray()).toEqual(aBC.view().toArray());
		});

		it("merge is idempotent: A ∪ A = A", () => {
			const a = createPrismHandle("a", listPath);
			a.pushMany(["A", "B", "C"]);

			const original = a.view().toArray();
			const merged = createMergedPrismView([a.getStore(), a.getStore()]);

			expect(merged.view().toArray()).toEqual(original);
		});

		it("merge with concurrent ops is deterministic regardless of order (vs Loro)", () => {
			const peers = ["alice", "bob", "carol", "dave", "eve"];
			const handles = peers.map((peer) => {
				const h = createPrismHandle(peer, listPath);
				h.push(`${peer}-value`);
				return h;
			});

			const stores = handles.map((h) => h.getStore());

			// Shuffle and merge multiple times
			const shuffles = [
				[0, 1, 2, 3, 4],
				[4, 3, 2, 1, 0],
				[2, 4, 0, 3, 1],
				[1, 3, 0, 4, 2],
			];

			const results = shuffles.map((order) => {
				const ordered = order.map((i) => stores[i]!);
				return createMergedPrismView(ordered).view().toArray();
			});

			// All Prism results should be identical
			for (let i = 1; i < results.length; i++) {
				expect(results[i]).toEqual(results[0]);
			}

			// All values should be present
			expect(results[0]).toHaveLength(5);
			for (const peer of peers) {
				expect(results[0]).toContain(`${peer}-value`);
			}

			// Compare against Loro
			const loroDocs = peers.map((peer) => {
				const doc = createLoroDoc(peer);
				doc.getList("list").push(`${peer}-value`);
				return doc;
			});
			const mergedLoro = mergeLoroDocuments(loroDocs);
			const loroResult = mergedLoro.getList("list").toArray();
			expect(results[0]).toEqual(loroResult);
		});
	});

	describe("Complex Multi-Peer Scenarios", () => {
		it("sequential operations from multiple peers", () => {
			const alice = createPrismHandle("alice", listPath);
			alice.pushMany(["A", "B", "C"]);

			// Bob gets Alice's state and continues
			const bob = createListHandle({
				peerId: "bob",
				store: alice.getStore(),
				path: listPath,
			});
			bob.push("D");

			// Carol gets Bob's state (which includes Alice's) and continues
			const carol = createListHandle({
				peerId: "carol",
				store: bob.getStore(),
				path: listPath,
			});
			carol.insert(1, "X");

			expect(carol.view().toArray()).toEqual(["A", "X", "B", "C", "D"]);
		});

		it("offline peer syncs later (vs Loro)", () => {
			// Alice and Bob work concurrently
			const alicePrism = createPrismHandle("alice", listPath);
			alicePrism.push("A");

			const bobPrism = createPrismHandle("bob", listPath);
			bobPrism.push("B");

			// Carol was offline, made changes
			const carolPrism = createPrismHandle("carol", listPath);
			carolPrism.push("C");

			// All sync
			const mergedPrism = createMergedPrismView([
				alicePrism.getStore(),
				bobPrism.getStore(),
				carolPrism.getStore(),
			]);

			// Same in Loro
			const aliceLoro = createLoroDoc("alice");
			aliceLoro.getList("list").push("A");

			const bobLoro = createLoroDoc("bob");
			bobLoro.getList("list").push("B");

			const carolLoro = createLoroDoc("carol");
			carolLoro.getList("list").push("C");

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro, carolLoro]);
			const loroResult = mergedLoro.getList("list").toArray();

			const prismResult = mergedPrism.view().toArray();

			// All elements should be present
			expect(prismResult).toHaveLength(3);
			expect(prismResult).toContain("A");
			expect(prismResult).toContain("B");
			expect(prismResult).toContain("C");

			// Compare against Loro
			expect(prismResult).toEqual(loroResult);
		});

		it("interleaved typing simulation (vs Loro)", () => {
			// Simulate two users typing at the same position
			const alicePrism = createPrismHandle("alice", listPath);
			alicePrism.push("A");
			alicePrism.push("l");
			alicePrism.push("i");

			const bobPrism = createPrismHandle("bob", listPath);
			bobPrism.push("B");
			bobPrism.push("o");
			bobPrism.push("b");

			const mergedPrism = createMergedPrismView([
				alicePrism.getStore(),
				bobPrism.getStore(),
			]);

			// Same in Loro
			const aliceLoro = createLoroDoc("alice");
			const aliceLoroList = aliceLoro.getList("list");
			aliceLoroList.push("A");
			aliceLoroList.push("l");
			aliceLoroList.push("i");

			const bobLoro = createLoroDoc("bob");
			const bobLoroList = bobLoro.getList("list");
			bobLoroList.push("B");
			bobLoroList.push("o");
			bobLoroList.push("b");

			const mergedLoro = mergeLoroDocuments([aliceLoro, bobLoro]);
			const loroResult = mergedLoro.getList("list").toArray();

			// Both sequences should be present, interleaving determined by Fugue rules
			const prismResult = mergedPrism.view().toArray();
			expect(prismResult).toHaveLength(6);

			// Alice's characters should be in order relative to each other
			const aliceChars = prismResult.filter((c: unknown) =>
				["A", "l", "i"].includes(c as string),
			);
			expect(aliceChars).toEqual(["A", "l", "i"]);

			// Bob's characters should be in order relative to each other
			const bobChars = prismResult.filter((c: unknown) =>
				["B", "o", "b"].includes(c as string),
			);
			expect(bobChars).toEqual(["B", "o", "b"]);

			// Compare against Loro
			expect(prismResult).toEqual(loroResult);
		});
	});

	describe("Edge Cases", () => {
		it("empty list", () => {
			const handle = createPrismHandle("alice", listPath);

			expect(handle.view().toArray()).toEqual([]);
			expect(handle.view().length()).toBe(0);
			expect(handle.view().isEmpty()).toBe(true);
		});

		it("single element", () => {
			const handle = createPrismHandle("alice", listPath);
			handle.push("A");

			expect(handle.view().toArray()).toEqual(["A"]);
			expect(handle.view().length()).toBe(1);
		});

		it("null values", () => {
			const prism = createPrismHandle("alice", listPath);
			prism.push(null);
			prism.push("B");
			prism.push(null);

			const loro = createLoroDoc("alice");
			const loroList = loro.getList("list");
			loroList.push(null);
			loroList.push("B");
			loroList.push(null);

			expect(prism.view().toArray()).toEqual(loroList.toArray());
			expect(prism.view().toArray()).toEqual([null, "B", null]);
		});

		it("various value types", () => {
			const prism = createPrismHandle("alice", listPath);
			prism.push("string");
			prism.push(42);
			prism.push(true);
			prism.push(null);

			const loro = createLoroDoc("alice");
			const loroList = loro.getList("list");
			loroList.push("string");
			loroList.push(42);
			loroList.push(true);
			loroList.push(null);

			expect(prism.view().toArray()).toEqual(loroList.toArray());
		});

		it("unicode values", () => {
			const prism = createPrismHandle("alice", listPath);
			prism.push("🎉");
			prism.push("日本語");
			prism.push("émoji");

			const loro = createLoroDoc("alice");
			const loroList = loro.getList("list");
			loroList.push("🎉");
			loroList.push("日本語");
			loroList.push("émoji");

			expect(prism.view().toArray()).toEqual(loroList.toArray());
		});

		it("delete all elements", () => {
			const handle = createPrismHandle("alice", listPath);
			handle.pushMany(["A", "B", "C"]);
			handle.deleteRange(0, 3);

			expect(handle.view().toArray()).toEqual([]);
			expect(handle.view().isEmpty()).toBe(true);
		});

		it("many sequential inserts", () => {
			const prism = createPrismHandle("alice", listPath);
			const loro = createLoroDoc("alice");
			const loroList = loro.getList("list");

			for (let i = 0; i < 50; i++) {
				prism.push(i);
				loroList.push(i);
			}

			expect(prism.view().toArray()).toEqual(loroList.toArray());
			expect(prism.view().length()).toBe(50);
		});
	});
});
