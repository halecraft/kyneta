/**
 * Constraint Inspector Tests
 *
 * Tests for the debug inspector functionality.
 * Focused on behavioral contracts rather than exhaustive field-by-field checks.
 */

import { describe, it, expect } from "vitest";
import {
	createConstraintInspector,
	dumpStore,
	summarizeStore,
	exportStoreJSON,
} from "../../src/introspection/inspector.js";
import {
	createConstraintStore,
	tell,
	tellMany,
} from "../../src/store/constraint-store.js";
import { createConstraint } from "../../src/core/constraint.js";
import { eq, deleted } from "../../src/core/assertions.js";
import type { Path } from "../../src/core/types.js";
import type { ConstraintStore } from "../../src/store/constraint-store.js";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestConstraint(
	peer: string,
	counter: number,
	lamport: number,
	path: Path,
	value: unknown,
) {
	return createConstraint(peer, counter, lamport, path, eq(value));
}

function createTestInspector(store: ConstraintStore) {
	return createConstraintInspector({
		getStore: () => store,
	});
}

function buildMultiPeerStore(): ConstraintStore {
	let store = createConstraintStore();
	const c1 = createTestConstraint("alice", 0, 1, ["key1"], "value1");
	const c2 = createTestConstraint("alice", 1, 2, ["key2"], "value2");
	const c3 = createTestConstraint("bob", 0, 3, ["key1"], "value3");
	const c4 = createConstraint("carol", 0, 4, ["key3"], deleted());
	store = tellMany(store, [c1, c2, c3, c4]).store;
	return store;
}

// ============================================================================
// Tests
// ============================================================================

describe("ConstraintInspector", () => {
	describe("exportSnapshot", () => {
		it("should produce a complete JSON-serializable snapshot", () => {
			const store = buildMultiPeerStore();
			const inspector = createTestInspector(store);
			const snapshot = inspector.exportSnapshot();

			// Top-level metadata
			expect(snapshot.constraintCount).toBe(4);
			expect(snapshot.generation).toBeGreaterThan(0);
			expect(snapshot.lamport).toBe(4);
			expect(snapshot.timestamp).toBeDefined();
			expect(snapshot.versionVector).toEqual({ alice: 2, bob: 1, carol: 1 });

			// Constraints are present with expected shape
			expect(snapshot.constraints).toHaveLength(4);
			expect(snapshot.constraints[0]).toHaveProperty("id");
			expect(snapshot.constraints[0]).toHaveProperty("peer");
			expect(snapshot.constraints[0]).toHaveProperty("assertionType");

			// Grouped by path and peer
			expect(snapshot.byPath['["key1"]']).toHaveLength(2);
			expect(snapshot.byPath['["key2"]']).toHaveLength(1);
			expect(snapshot.byPeer["alice"]).toHaveLength(2);
			expect(snapshot.byPeer["bob"]).toHaveLength(1);
		});

		it("should handle empty store", () => {
			const store = createConstraintStore();
			const inspector = createTestInspector(store);
			const snapshot = inspector.exportSnapshot();

			expect(snapshot.constraintCount).toBe(0);
			expect(snapshot.constraints).toHaveLength(0);
		});
	});

	describe("exportJSON", () => {
		it("should produce valid JSON in both pretty and compact modes", () => {
			const store = buildMultiPeerStore();
			const inspector = createTestInspector(store);

			const pretty = inspector.exportJSON(true);
			const compact = inspector.exportJSON(false);

			expect(() => JSON.parse(pretty)).not.toThrow();
			expect(() => JSON.parse(compact)).not.toThrow();
			expect(compact.length).toBeLessThan(pretty.length);
			expect(compact).not.toContain("\n");

			const parsed = JSON.parse(compact);
			expect(parsed.constraintCount).toBe(4);
		});
	});

	describe("getStatistics", () => {
		it("should compute statistics for a multi-peer store", () => {
			const store = buildMultiPeerStore();
			const inspector = createTestInspector(store);
			const stats = inspector.getStatistics();

			expect(stats.totalConstraints).toBe(4);
			expect(stats.uniquePaths).toBe(3);
			expect(stats.uniquePeers).toBe(3);
			expect(stats.totalOperations).toBe(4);

			// Assertion type breakdown
			expect(stats.byAssertionType["eq"]).toBe(3);
			expect(stats.byAssertionType["deleted"]).toBe(1);

			// Peer breakdown
			expect(stats.byPeer["alice"]).toBe(2);
			expect(stats.byPeer["bob"]).toBe(1);

			// Most constrained path (key1 has 2 constraints)
			expect(stats.maxConstraintsPath?.path).toBe('["key1"]');
			expect(stats.maxConstraintsPath?.count).toBe(2);

			// Average
			expect(stats.avgConstraintsPerPath).toBeCloseTo(4 / 3, 2);
		});

		it("should handle empty store", () => {
			const store = createConstraintStore();
			const inspector = createTestInspector(store);
			const stats = inspector.getStatistics();

			expect(stats.totalConstraints).toBe(0);
			expect(stats.avgConstraintsPerPath).toBe(0);
			expect(stats.maxConstraintsPath).toBeNull();
		});
	});

	describe("listConstraints", () => {
		it("should list and filter constraints", () => {
			const store = buildMultiPeerStore();
			const inspector = createTestInspector(store);

			// All constraints
			const all = inspector.listConstraints();
			expect(all).toHaveLength(4);

			// Filter by path
			const atKey1 = inspector.listConstraintsAt(["key1"]);
			expect(atKey1).toHaveLength(2);
			expect(atKey1.every((c) => c.path === '["key1"]')).toBe(true);

			// Filter by peer
			const fromAlice = inspector.listConstraintsFrom("alice");
			expect(fromAlice).toHaveLength(2);
			expect(fromAlice.every((c) => c.peer === "alice")).toBe(true);

			// Empty results for nonexistent filters
			expect(inspector.listConstraintsAt(["nonexistent"])).toHaveLength(0);
			expect(inspector.listConstraintsFrom("nobody")).toHaveLength(0);
		});
	});

	describe("summarize and dump", () => {
		it("should produce human-readable output containing key facts", () => {
			const store = buildMultiPeerStore();
			const inspector = createTestInspector(store);

			const summary = inspector.summarize();
			expect(summary).toContain("Constraint Store Summary");
			expect(summary).toContain("Total constraints: 4");
			expect(summary).toContain("alice");

			const dump = inspector.dump();
			expect(dump).toContain("Constraint Store Dump");
			expect(dump).toContain('["key1"]');
			expect(dump).toContain("alice@0");
		});
	});
});

describe("Convenience Functions", () => {
	it("should provide quick access to dump, summarize, and JSON export", () => {
		let store = createConstraintStore();
		const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
		store = tell(store, constraint).store;

		expect(dumpStore(store)).toContain("alice@0");
		expect(summarizeStore(store)).toContain("Total constraints: 1");

		const json = exportStoreJSON(store);
		expect(() => JSON.parse(json)).not.toThrow();
		expect(JSON.parse(json).constraintCount).toBe(1);
	});
});
