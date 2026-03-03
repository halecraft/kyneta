/**
 * Introspection API Tests
 *
 * Tests for the explain and introspection functionality:
 * - explain(): Why does a path have its value?
 * - getConstraintsFor(): All constraints at a path
 * - getConstraintsUnder(): All constraints under a prefix
 * - getConflicts(): All conflicts in the store
 * - Formatting functions
 */

import { describe, it, expect } from "vitest";
import {
	createIntrospectionAPI,
	explainSolvedValue,
	type Explanation,
} from "../../src/introspection/explain.js";
import {
	createConstraintStore,
	tell,
	tellMany,
	ask,
} from "../../src/store/constraint-store.js";
import { createConstraint } from "../../src/core/constraint.js";
import { eq, deleted } from "../../src/core/assertions.js";
import { solveMapConstraints } from "../../src/solver/map-solver.js";
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

function createTestAPI(store: ConstraintStore) {
	return createIntrospectionAPI({
		getStore: () => store,
		solve: (path) => solveMapConstraints(ask(store, path), path),
	});
}

// ============================================================================
// Tests
// ============================================================================

describe("IntrospectionAPI", () => {
	describe("explain", () => {
		it("should explain a simple value", () => {
			let store = createConstraintStore();
			const constraint = createTestConstraint(
				"alice",
				0,
				1,
				["user", "name"],
				"Alice",
			);
			store = tell(store, constraint).store;

			const api = createTestAPI(store);
			const explanation = api.explain<string>(["user", "name"]);

			expect(explanation.value).toBe("Alice");
			expect(explanation.hasValue).toBe(true);
			expect(explanation.determinedBy).toBeDefined();
			expect(explanation.determinedBy?.peer).toBe("alice");
			expect(explanation.determinedBy?.lamport).toBe(1);
			expect(explanation.hasConflicts).toBe(false);
			expect(explanation.conflicts).toHaveLength(0);
		});

		it("should explain an empty path", () => {
			const store = createConstraintStore();
			const api = createTestAPI(store);
			const explanation = api.explain(["nonexistent"]);

			expect(explanation.value).toBeUndefined();
			expect(explanation.hasValue).toBe(false);
			expect(explanation.determinedBy).toBeUndefined();
			expect(explanation.allConstraints).toHaveLength(0);
		});

		it("should explain conflicts", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key"], "alice-value");
			const c2 = createTestConstraint("bob", 0, 1, ["key"], "bob-value");
			store = tellMany(store, [c1, c2]).store;

			const api = createTestAPI(store);
			const explanation = api.explain(["key"]);

			expect(explanation.hasConflicts).toBe(true);
			expect(explanation.conflicts).toHaveLength(1);
			expect(explanation.determinedBy).toBeDefined();
			expect(explanation.allConstraints).toHaveLength(2);
		});

		it("should include resolution explanation", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key"], "value1");
			const c2 = createTestConstraint("alice", 1, 5, ["key"], "value2");
			store = tellMany(store, [c1, c2]).store;

			const api = createTestAPI(store);
			const explanation = api.explain(["key"]);

			expect(explanation.value).toBe("value2");
			expect(explanation.resolution).toContain("LWW");
		});

		it("should include all constraints affecting path", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key"], "value1");
			const c2 = createTestConstraint("alice", 1, 2, ["key"], "value2");
			const c3 = createTestConstraint("bob", 0, 3, ["key"], "value3");
			store = tellMany(store, [c1, c2, c3]).store;

			const api = createTestAPI(store);
			const explanation = api.explain(["key"]);

			expect(explanation.allConstraints).toHaveLength(3);
		});
	});

	// Note: getConstraintsFor and getConstraintsUnder are thin wrappers
	// over ask/askPrefix (tested in constraint-store.test.ts) plus
	// toConstraintInfo formatting. Not worth separate test sections.

	describe("getConflicts", () => {
		it("should return empty report when no conflicts", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key1"], "value1");
			const c2 = createTestConstraint("alice", 1, 2, ["key2"], "value2");
			store = tellMany(store, [c1, c2]).store;

			const api = createTestAPI(store);
			const report = api.getConflicts();

			expect(report.pathCount).toBe(0);
			expect(report.totalConflicts).toBe(0);
			expect(report.summaries).toHaveLength(0);
		});

		it("should report conflicts", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key"], "alice-value");
			const c2 = createTestConstraint("bob", 0, 1, ["key"], "bob-value");
			store = tellMany(store, [c1, c2]).store;

			const api = createTestAPI(store);
			const report = api.getConflicts();

			expect(report.pathCount).toBe(1);
			expect(report.totalConflicts).toBe(1);
			expect(report.summaries).toHaveLength(1);
			expect(report.summaries[0]?.conflictCount).toBe(1);
		});

		it("should report multiple conflicting paths", () => {
			let store = createConstraintStore();
			// Conflict at key1
			const c1 = createTestConstraint("alice", 0, 1, ["key1"], "a1");
			const c2 = createTestConstraint("bob", 0, 1, ["key1"], "b1");
			// Conflict at key2
			const c3 = createTestConstraint("alice", 1, 2, ["key2"], "a2");
			const c4 = createTestConstraint("bob", 1, 2, ["key2"], "b2");
			store = tellMany(store, [c1, c2, c3, c4]).store;

			const api = createTestAPI(store);
			const report = api.getConflicts();

			expect(report.pathCount).toBe(2);
			expect(report.totalConflicts).toBe(2);
		});
	});

	describe("hasConflictsAt", () => {
		it("should return true for path with conflicts", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key"], "value1");
			const c2 = createTestConstraint("bob", 0, 1, ["key"], "value2");
			store = tellMany(store, [c1, c2]).store;

			const api = createTestAPI(store);
			expect(api.hasConflictsAt(["key"])).toBe(true);
		});

		it("should return false for path without conflicts", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key"], "value");
			store = tell(store, c1).store;

			const api = createTestAPI(store);
			expect(api.hasConflictsAt(["key"])).toBe(false);
		});

		it("should return false for empty path", () => {
			const store = createConstraintStore();
			const api = createTestAPI(store);
			expect(api.hasConflictsAt(["nonexistent"])).toBe(false);
		});
	});

	describe("formatExplanation", () => {
		it("should produce readable output", () => {
			let store = createConstraintStore();
			const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
			store = tell(store, constraint).store;

			const api = createTestAPI(store);
			const explanation = api.explain(["key"]);
			const formatted = api.formatExplanation(explanation);

			expect(formatted).toContain("Path:");
			expect(formatted).toContain("Value:");
			expect(formatted).toContain("Determined By:");
			expect(formatted).toContain("alice");
		});

		it("should show conflicts in output", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key"], "value1");
			const c2 = createTestConstraint("bob", 0, 1, ["key"], "value2");
			store = tellMany(store, [c1, c2]).store;

			const api = createTestAPI(store);
			const explanation = api.explain(["key"]);
			const formatted = api.formatExplanation(explanation);

			expect(formatted).toContain("Conflicts");
		});
	});

	describe("formatConflictReport", () => {
		it("should produce readable output", () => {
			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key"], "value1");
			const c2 = createTestConstraint("bob", 0, 1, ["key"], "value2");
			store = tellMany(store, [c1, c2]).store;

			const api = createTestAPI(store);
			const report = api.getConflicts();
			const formatted = api.formatConflictReport(report);

			expect(formatted).toContain("Conflict Report");
			expect(formatted).toContain("Winner:");
			expect(formatted).toContain("Losers:");
		});

		it("should handle empty report", () => {
			const store = createConstraintStore();
			const api = createTestAPI(store);
			const report = api.getConflicts();
			const formatted = api.formatConflictReport(report);

			expect(formatted).toContain("No conflicts found");
		});
	});
});

describe("explainSolvedValue", () => {
	it("should create explanation from solved value", () => {
		let store = createConstraintStore();
		const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
		store = tell(store, constraint).store;

		const constraints = ask(store, ["key"]);
		const solved = solveMapConstraints(constraints, ["key"]);
		const explanation = explainSolvedValue(["key"], solved, constraints);

		expect(explanation.value).toBe("value");
		expect(explanation.hasValue).toBe(true);
		expect(explanation.determinedBy).toBeDefined();
		expect(explanation.allConstraints).toHaveLength(1);
	});

	it("should handle empty constraints", () => {
		const explanation = explainSolvedValue(
			["empty"],
			{
				value: undefined,
				determinedBy: undefined,
				conflicts: [],
				resolution: "no constraints",
			},
			[],
		);

		expect(explanation.value).toBeUndefined();
		expect(explanation.hasValue).toBe(false);
		expect(explanation.determinedBy).toBeUndefined();
		expect(explanation.allConstraints).toHaveLength(0);
	});
});
