/**
 * Constraint Inspector Tests
 *
 * Tests for the debug inspector functionality:
 * - exportSnapshot(): JSON-serializable store snapshot
 * - exportJSON(): String export for external tools
 * - getStatistics(): Store statistics
 * - listConstraints(): List all constraints
 * - summarize(): Human-readable summary
 * - dump(): Detailed dump
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
import { eq, deleted, seqElement } from "../../src/core/assertions.js";
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

// ============================================================================
// Tests
// ============================================================================

describe("ConstraintInspector", () => {
	describe("exportSnapshot", () => {
		it("should export empty store", () => {
			const store = createConstraintStore();
			const inspector = createTestInspector(store);
			const snapshot = inspector.exportSnapshot();

			expect(snapshot.constraintCount).toBe(0);
			expect(snapshot.constraints).toHaveLength(0);
			expect(snapshot.generation).toBe(0);
			expect(snapshot.lamport).toBe(0);
			expect(snapshot.timestamp).toBeDefined();
		});

		it("should export constraints", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key"], "value");
			store = tell(store, c1).store;

			const inspector = createTestInspector(store);
			const snapshot = inspector.exportSnapshot();

			expect(snapshot.constraintCount).toBe(1);
			expect(snapshot.constraints).toHaveLength(1);
			expect(snapshot.constraints[0]?.id).toBe("alice@0");
			expect(snapshot.constraints[0]?.peer).toBe("alice");
			expect(snapshot.constraints[0]?.lamport).toBe(1);
		});

		it("should group by path", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key1"], "value1");
			const c2 = createTestConstraint("alice", 1, 2, ["key2"], "value2");
			const c3 = createTestConstraint("bob", 0, 3, ["key1"], "value3");
			store = tellMany(store, [c1, c2, c3]).store;

			const inspector = createTestInspector(store);
			const snapshot = inspector.exportSnapshot();

			expect(Object.keys(snapshot.byPath)).toHaveLength(2);
			expect(snapshot.byPath['["key1"]']).toHaveLength(2);
			expect(snapshot.byPath['["key2"]']).toHaveLength(1);
		});

		it("should group by peer", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key1"], "value1");
			const c2 = createTestConstraint("alice", 1, 2, ["key2"], "value2");
			const c3 = createTestConstraint("bob", 0, 3, ["key3"], "value3");
			store = tellMany(store, [c1, c2, c3]).store;

			const inspector = createTestInspector(store);
			const snapshot = inspector.exportSnapshot();

			expect(Object.keys(snapshot.byPeer)).toHaveLength(2);
			expect(snapshot.byPeer["alice"]).toHaveLength(2);
			expect(snapshot.byPeer["bob"]).toHaveLength(1);
		});

		it("should include version vector", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key1"], "value1");
			const c2 = createTestConstraint("bob", 0, 2, ["key2"], "value2");
			store = tellMany(store, [c1, c2]).store;

			const inspector = createTestInspector(store);
			const snapshot = inspector.exportSnapshot();

			expect(snapshot.versionVector).toEqual({ alice: 1, bob: 1 });
		});
	});

	describe("exportJSON", () => {
		it("should export as JSON string", () => {
			let store = createConstraintStore();
			const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
			store = tell(store, constraint).store;

			const inspector = createTestInspector(store);
			const json = inspector.exportJSON();

			expect(() => JSON.parse(json)).not.toThrow();

			const parsed = JSON.parse(json);
			expect(parsed.constraintCount).toBe(1);
		});

		it("should support compact output", () => {
			let store = createConstraintStore();
			const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
			store = tell(store, constraint).store;

			const inspector = createTestInspector(store);
			const prettyJson = inspector.exportJSON(true);
			const compactJson = inspector.exportJSON(false);

			expect(compactJson.length).toBeLessThan(prettyJson.length);
			expect(compactJson).not.toContain("\n");
		});
	});

	describe("getStatistics", () => {
		it("should return statistics for empty store", () => {
			const store = createConstraintStore();
			const inspector = createTestInspector(store);
			const stats = inspector.getStatistics();

			expect(stats.totalConstraints).toBe(0);
			expect(stats.uniquePaths).toBe(0);
			expect(stats.uniquePeers).toBe(0);
			expect(stats.avgConstraintsPerPath).toBe(0);
			expect(stats.maxConstraintsPath).toBeNull();
		});

		it("should count constraints correctly", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key1"], "value1");
			const c2 = createTestConstraint("alice", 1, 2, ["key2"], "value2");
			const c3 = createTestConstraint("bob", 0, 3, ["key1"], "value3");
			store = tellMany(store, [c1, c2, c3]).store;

			const inspector = createTestInspector(store);
			const stats = inspector.getStatistics();

			expect(stats.totalConstraints).toBe(3);
			expect(stats.uniquePaths).toBe(2);
			expect(stats.uniquePeers).toBe(2);
		});

		it("should count by assertion type", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key1"], "value1");
			const c2 = createConstraint("alice", 1, 2, ["key2"], deleted());
			store = tellMany(store, [c1, c2]).store;

			const inspector = createTestInspector(store);
			const stats = inspector.getStatistics();

			expect(stats.byAssertionType["eq"]).toBe(1);
			expect(stats.byAssertionType["deleted"]).toBe(1);
		});

		it("should count by peer", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key1"], "value1");
			const c2 = createTestConstraint("alice", 1, 2, ["key2"], "value2");
			const c3 = createTestConstraint("bob", 0, 3, ["key3"], "value3");
			store = tellMany(store, [c1, c2, c3]).store;

			const inspector = createTestInspector(store);
			const stats = inspector.getStatistics();

			expect(stats.byPeer["alice"]).toBe(2);
			expect(stats.byPeer["bob"]).toBe(1);
		});

		it("should find path with most constraints", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["popular"], "v1");
			const c2 = createTestConstraint("bob", 0, 2, ["popular"], "v2");
			const c3 = createTestConstraint("carol", 0, 3, ["popular"], "v3");
			const c4 = createTestConstraint("alice", 1, 4, ["other"], "v4");
			store = tellMany(store, [c1, c2, c3, c4]).store;

			const inspector = createTestInspector(store);
			const stats = inspector.getStatistics();

			expect(stats.maxConstraintsPath?.path).toBe('["popular"]');
			expect(stats.maxConstraintsPath?.count).toBe(3);
		});

		it("should calculate average constraints per path", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key1"], "v1");
			const c2 = createTestConstraint("bob", 0, 2, ["key1"], "v2");
			const c3 = createTestConstraint("alice", 1, 3, ["key2"], "v3");
			const c4 = createTestConstraint("alice", 2, 4, ["key3"], "v4");
			store = tellMany(store, [c1, c2, c3, c4]).store;

			const inspector = createTestInspector(store);
			const stats = inspector.getStatistics();

			// 4 constraints / 3 paths = 1.33...
			expect(stats.avgConstraintsPerPath).toBeCloseTo(4 / 3, 2);
		});
	});

	describe("listConstraints", () => {
		it("should list all constraints", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key1"], "value1");
			const c2 = createTestConstraint("bob", 0, 2, ["key2"], "value2");
			store = tellMany(store, [c1, c2]).store;

			const inspector = createTestInspector(store);
			const list = inspector.listConstraints();

			expect(list).toHaveLength(2);
			expect(list.map((c) => c.id)).toContain("alice@0");
			expect(list.map((c) => c.id)).toContain("bob@0");
		});

		it("should return empty list for empty store", () => {
			const store = createConstraintStore();
			const inspector = createTestInspector(store);
			const list = inspector.listConstraints();

			expect(list).toHaveLength(0);
		});
	});

	describe("listConstraintsAt", () => {
		it("should list constraints at specific path", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["target"], "v1");
			const c2 = createTestConstraint("bob", 0, 2, ["target"], "v2");
			const c3 = createTestConstraint("alice", 1, 3, ["other"], "v3");
			store = tellMany(store, [c1, c2, c3]).store;

			const inspector = createTestInspector(store);
			const list = inspector.listConstraintsAt(["target"]);

			expect(list).toHaveLength(2);
			expect(list.every((c) => c.path === '["target"]')).toBe(true);
		});

		it("should return empty for nonexistent path", () => {
			const store = createConstraintStore();
			const inspector = createTestInspector(store);
			const list = inspector.listConstraintsAt(["nonexistent"]);

			expect(list).toHaveLength(0);
		});
	});

	describe("listConstraintsFrom", () => {
		it("should list constraints from specific peer", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key1"], "v1");
			const c2 = createTestConstraint("alice", 1, 2, ["key2"], "v2");
			const c3 = createTestConstraint("bob", 0, 3, ["key3"], "v3");
			store = tellMany(store, [c1, c2, c3]).store;

			const inspector = createTestInspector(store);
			const list = inspector.listConstraintsFrom("alice");

			expect(list).toHaveLength(2);
			expect(list.every((c) => c.peer === "alice")).toBe(true);
		});

		it("should return empty for nonexistent peer", () => {
			let store = createConstraintStore();
			const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
			store = tell(store, constraint).store;

			const inspector = createTestInspector(store);
			const list = inspector.listConstraintsFrom("nonexistent");

			expect(list).toHaveLength(0);
		});
	});

	describe("summarize", () => {
		it("should produce readable summary", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key"], "value");
			store = tell(store, c1).store;

			const inspector = createTestInspector(store);
			const summary = inspector.summarize();

			expect(summary).toContain("Constraint Store Summary");
			expect(summary).toContain("Total constraints: 1");
			expect(summary).toContain("Unique paths: 1");
			expect(summary).toContain("Unique peers: 1");
			expect(summary).toContain("alice");
		});

		it("should show assertion type breakdown", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key1"], "value");
			const c2 = createConstraint("alice", 1, 2, ["key2"], deleted());
			store = tellMany(store, [c1, c2]).store;

			const inspector = createTestInspector(store);
			const summary = inspector.summarize();

			expect(summary).toContain("By Assertion Type:");
			expect(summary).toContain("eq: 1");
			expect(summary).toContain("deleted: 1");
		});
	});

	describe("dump", () => {
		it("should produce detailed dump", () => {
			let store = createConstraintStore();
			const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
			store = tell(store, constraint).store;

			const inspector = createTestInspector(store);
			const dump = inspector.dump();

			expect(dump).toContain("Constraint Store Dump");
			expect(dump).toContain("Generation:");
			expect(dump).toContain("Lamport:");
			expect(dump).toContain("alice@0");
			expect(dump).toContain('["key"]');
		});

		it("should group constraints by path", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["path1"], "v1");
			const c2 = createTestConstraint("bob", 0, 2, ["path1"], "v2");
			const c3 = createTestConstraint("alice", 1, 3, ["path2"], "v3");
			store = tellMany(store, [c1, c2, c3]).store;

			const inspector = createTestInspector(store);
			const dump = inspector.dump();

			expect(dump).toContain('["path1"]');
			expect(dump).toContain('["path2"]');
		});
	});
});

describe("Convenience Functions", () => {
	describe("dumpStore", () => {
		it("should dump store directly", () => {
			let store = createConstraintStore();
			const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
			store = tell(store, constraint).store;

			const dump = dumpStore(store);

			expect(dump).toContain("Constraint Store Dump");
			expect(dump).toContain("alice@0");
		});
	});

	describe("summarizeStore", () => {
		it("should summarize store directly", () => {
			let store = createConstraintStore();
			const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
			store = tell(store, constraint).store;

			const summary = summarizeStore(store);

			expect(summary).toContain("Constraint Store Summary");
			expect(summary).toContain("Total constraints: 1");
		});
	});

	describe("exportStoreJSON", () => {
		it("should export store as JSON directly", () => {
			let store = createConstraintStore();
			const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
			store = tell(store, constraint).store;

			const json = exportStoreJSON(store);

			expect(() => JSON.parse(json)).not.toThrow();

			const parsed = JSON.parse(json);
			expect(parsed.constraintCount).toBe(1);
		});

		it("should support compact output", () => {
			let store = createConstraintStore();
			const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
			store = tell(store, constraint).store;

			const compact = exportStoreJSON(store, false);

			expect(compact).not.toContain("\n");
		});
	});
});
