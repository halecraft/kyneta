/**
 * Map Solver Tests
 *
 * Tests for the LWW (Last-Writer-Wins) Map solver:
 * - Single constraint resolution
 * - LWW conflict resolution (Lamport comparison)
 * - Peer ID tiebreaking
 * - Deletion handling
 * - Full map solving
 */

import { describe, it, expect } from "vitest";
import {
	createMapSolver,
	solveMapConstraints,
	solveMap,
	solvedMapToObject,
	solvedMapHasConflicts,
	solvedMapConflictKeys,
} from "../../src/solver/map-solver.js";
import { createConstraint } from "../../src/core/constraint.js";
import { eq, deleted, exists } from "../../src/core/assertions.js";
import type { Path } from "../../src/core/types.js";

describe("MapSolver", () => {
	describe("createMapSolver", () => {
		it("should create a solver that resolves constraints", () => {
			const solver = createMapSolver();
			const constraints = [
				createConstraint("alice", 0, 1, ["key"], eq("value")),
			];

			const result = solver.solve(constraints, ["key"]);

			expect(result.value).toBe("value");
		});
	});

	describe("solveMapConstraints", () => {
		describe("single constraint", () => {
			it("should return the value from a single eq constraint", () => {
				const constraints = [
					createConstraint("alice", 0, 1, ["key"], eq("alice-value")),
				];

				const result = solveMapConstraints(constraints, ["key"]);

				expect(result.value).toBe("alice-value");
				expect(result.conflicts).toHaveLength(0);
				expect(result.determinedBy?.id.peer).toBe("alice");
			});

			it("should handle complex values", () => {
				const value = { nested: { array: [1, 2, 3] } };
				const constraints = [
					createConstraint("alice", 0, 1, ["key"], eq(value)),
				];

				const result = solveMapConstraints(constraints, ["key"]);

				expect(result.value).toEqual(value);
			});

			it("should handle null values", () => {
				const constraints = [
					createConstraint("alice", 0, 1, ["key"], eq(null)),
				];

				const result = solveMapConstraints(constraints, ["key"]);

				expect(result.value).toBeNull();
			});
		});

		describe("empty constraints", () => {
			it("should return undefined for no constraints", () => {
				const result = solveMapConstraints([], ["key"]);

				expect(result.value).toBeUndefined();
				expect(result.determinedBy).toBeUndefined();
				expect(result.conflicts).toHaveLength(0);
				expect(result.resolution).toBe("no constraints");
			});

			it("should ignore non-relevant assertion types", () => {
				const constraints = [
					createConstraint("alice", 0, 1, ["key"], exists()),
				];

				const result = solveMapConstraints(constraints, ["key"]);

				expect(result.value).toBeUndefined();
			});
		});

		describe("LWW resolution by Lamport", () => {
			it("should pick higher Lamport timestamp as winner", () => {
				const constraints = [
					createConstraint("alice", 0, 5, ["key"], eq("alice-value")),
					createConstraint("bob", 0, 10, ["key"], eq("bob-value")),
				];

				const result = solveMapConstraints(constraints, ["key"]);

				expect(result.value).toBe("bob-value");
				expect(result.determinedBy?.id.peer).toBe("bob");
				expect(result.conflicts).toHaveLength(1);
				expect(result.conflicts[0]?.id.peer).toBe("alice");
			});

			it("should work regardless of array order", () => {
				const constraints1 = [
					createConstraint("alice", 0, 10, ["key"], eq("alice-value")),
					createConstraint("bob", 0, 5, ["key"], eq("bob-value")),
				];

				const constraints2 = [
					createConstraint("bob", 0, 5, ["key"], eq("bob-value")),
					createConstraint("alice", 0, 10, ["key"], eq("alice-value")),
				];

				const result1 = solveMapConstraints(constraints1, ["key"]);
				const result2 = solveMapConstraints(constraints2, ["key"]);

				expect(result1.value).toBe("alice-value");
				expect(result2.value).toBe("alice-value");
			});

			it("should handle multiple losers", () => {
				const constraints = [
					createConstraint("alice", 0, 5, ["key"], eq("alice")),
					createConstraint("bob", 0, 3, ["key"], eq("bob")),
					createConstraint("carol", 0, 10, ["key"], eq("carol")),
					createConstraint("dave", 0, 7, ["key"], eq("dave")),
				];

				const result = solveMapConstraints(constraints, ["key"]);

				expect(result.value).toBe("carol");
				expect(result.conflicts).toHaveLength(3);
			});
		});

		describe("Peer ID tiebreaking", () => {
			it("should use higher peer ID as tiebreaker when Lamport equal", () => {
				const constraints = [
					createConstraint("alice", 0, 10, ["key"], eq("alice-value")),
					createConstraint("bob", 0, 10, ["key"], eq("bob-value")),
				];

				const result = solveMapConstraints(constraints, ["key"]);

				// "bob" > "alice" lexicographically
				expect(result.value).toBe("bob-value");
				expect(result.determinedBy?.id.peer).toBe("bob");
			});

			it("should be consistent across orderings", () => {
				const constraints1 = [
					createConstraint("zebra", 0, 5, ["key"], eq("zebra")),
					createConstraint("aardvark", 0, 5, ["key"], eq("aardvark")),
				];

				const constraints2 = [
					createConstraint("aardvark", 0, 5, ["key"], eq("aardvark")),
					createConstraint("zebra", 0, 5, ["key"], eq("zebra")),
				];

				const result1 = solveMapConstraints(constraints1, ["key"]);
				const result2 = solveMapConstraints(constraints2, ["key"]);

				// "zebra" > "aardvark"
				expect(result1.value).toBe("zebra");
				expect(result2.value).toBe("zebra");
			});
		});

		describe("deletion handling", () => {
			it("should return undefined for deleted constraint", () => {
				const constraints = [
					createConstraint("alice", 0, 1, ["key"], deleted()),
				];

				const result = solveMapConstraints(constraints, ["key"]);

				expect(result.value).toBeUndefined();
				expect(result.determinedBy).toBeDefined();
				expect(result.resolution).toBe("deleted");
			});

			it("should pick deletion over value if deletion has higher Lamport", () => {
				const constraints = [
					createConstraint("alice", 0, 5, ["key"], eq("value")),
					createConstraint("bob", 0, 10, ["key"], deleted()),
				];

				const result = solveMapConstraints(constraints, ["key"]);

				expect(result.value).toBeUndefined();
				expect(result.determinedBy?.id.peer).toBe("bob");
				expect(result.resolution).toBe("deleted");
			});

			it("should pick value over deletion if value has higher Lamport", () => {
				const constraints = [
					createConstraint("alice", 0, 10, ["key"], eq("value")),
					createConstraint("bob", 0, 5, ["key"], deleted()),
				];

				const result = solveMapConstraints(constraints, ["key"]);

				expect(result.value).toBe("value");
				expect(result.determinedBy?.id.peer).toBe("alice");
			});

			it("should use peer ID tiebreaker for deletion vs value at same Lamport", () => {
				const constraints = [
					createConstraint("alice", 0, 10, ["key"], eq("value")),
					createConstraint("bob", 0, 10, ["key"], deleted()),
				];

				const result = solveMapConstraints(constraints, ["key"]);

				// "bob" > "alice", so deletion wins
				expect(result.value).toBeUndefined();
			});
		});

		describe("resolution explanation", () => {
			it("should explain single constraint", () => {
				const constraints = [
					createConstraint("alice", 0, 1, ["key"], eq("value")),
				];

				const result = solveMapConstraints(constraints, ["key"]);

				expect(result.resolution).toContain("single constraint");
			});

			it("should explain Lamport win", () => {
				const constraints = [
					createConstraint("alice", 0, 5, ["key"], eq("alice")),
					createConstraint("bob", 0, 10, ["key"], eq("bob")),
				];

				const result = solveMapConstraints(constraints, ["key"]);

				expect(result.resolution).toContain("LWW");
				expect(result.resolution).toContain("10");
			});

			it("should explain peer ID tiebreaker", () => {
				const constraints = [
					createConstraint("alice", 0, 10, ["key"], eq("alice")),
					createConstraint("bob", 0, 10, ["key"], eq("bob")),
				];

				const result = solveMapConstraints(constraints, ["key"]);

				expect(result.resolution).toContain("tiebreaker");
			});
		});
	});

	describe("solveMap", () => {
		it("should solve all keys in a map", () => {
			const mapPath: Path = ["users"];
			const constraints = [
				createConstraint("alice", 0, 1, ["users", "name"], eq("Alice")),
				createConstraint("alice", 1, 2, ["users", "age"], eq(30)),
				createConstraint(
					"alice",
					2,
					3,
					["users", "email"],
					eq("alice@example.com"),
				),
			];

			const result = solveMap(constraints, mapPath);

			expect(result.keys).toHaveLength(3);
			expect(result.keys).toContain("name");
			expect(result.keys).toContain("age");
			expect(result.keys).toContain("email");
			expect(result.entries.get("name")?.value).toBe("Alice");
			expect(result.entries.get("age")?.value).toBe(30);
		});

		it("should exclude deleted keys from keys list", () => {
			const mapPath: Path = ["map"];
			const constraints = [
				createConstraint("alice", 0, 1, ["map", "keep"], eq("value")),
				createConstraint("alice", 1, 2, ["map", "remove"], deleted()),
			];

			const result = solveMap(constraints, mapPath);

			expect(result.keys).toContain("keep");
			expect(result.keys).not.toContain("remove");
			expect(result.entries.has("remove")).toBe(true); // Entry exists but is deleted
		});

		it("should track conflicts per key", () => {
			const mapPath: Path = ["map"];
			const constraints = [
				createConstraint("alice", 0, 5, ["map", "conflicted"], eq("alice")),
				createConstraint("bob", 0, 10, ["map", "conflicted"], eq("bob")),
				createConstraint("alice", 1, 1, ["map", "noconflict"], eq("solo")),
			];

			const result = solveMap(constraints, mapPath);

			expect(result.conflicts.has("conflicted")).toBe(true);
			expect(result.conflicts.get("conflicted")).toHaveLength(1);
			expect(result.conflicts.has("noconflict")).toBe(false);
		});

		it("should ignore non-string keys", () => {
			const mapPath: Path = ["map"];
			const constraints = [
				createConstraint("alice", 0, 1, ["map", "stringkey"], eq("value")),
				createConstraint("alice", 1, 2, ["map", 123], eq("numeric")), // Number key
			];

			const result = solveMap(constraints, mapPath);

			expect(result.keys).toContain("stringkey");
			expect(result.keys).toHaveLength(1);
		});

		it("should ignore constraints at wrong depth", () => {
			const mapPath: Path = ["map"];
			const constraints = [
				createConstraint("alice", 0, 1, ["map", "key"], eq("correct")),
				createConstraint("alice", 1, 2, ["map"], eq("parent")),
				createConstraint("alice", 2, 3, ["map", "key", "nested"], eq("child")),
			];

			const result = solveMap(constraints, mapPath);

			expect(result.keys).toHaveLength(1);
			expect(result.keys).toContain("key");
		});

		it("should ignore constraints with different prefix", () => {
			const mapPath: Path = ["mymap"];
			const constraints = [
				createConstraint("alice", 0, 1, ["mymap", "key"], eq("correct")),
				createConstraint("alice", 1, 2, ["othermap", "key"], eq("wrong")),
			];

			const result = solveMap(constraints, mapPath);

			expect(result.keys).toHaveLength(1);
		});
	});

	describe("solvedMapToObject", () => {
		it("should convert to plain object", () => {
			const mapPath: Path = ["map"];
			const constraints = [
				createConstraint("alice", 0, 1, ["map", "name"], eq("Alice")),
				createConstraint("alice", 1, 2, ["map", "age"], eq(30)),
			];

			const solved = solveMap(constraints, mapPath);
			const obj = solvedMapToObject(solved);

			expect(obj).toEqual({
				name: "Alice",
				age: 30,
			});
		});

		it("should exclude deleted keys", () => {
			const mapPath: Path = ["map"];
			const constraints = [
				createConstraint("alice", 0, 1, ["map", "keep"], eq("value")),
				createConstraint("alice", 1, 2, ["map", "gone"], deleted()),
			];

			const solved = solveMap(constraints, mapPath);
			const obj = solvedMapToObject(solved);

			expect(obj).toEqual({ keep: "value" });
			expect("gone" in obj).toBe(false);
		});
	});

	describe("solvedMapHasConflicts / solvedMapConflictKeys", () => {
		it("should detect conflicts", () => {
			const mapPath: Path = ["map"];
			const constraints = [
				createConstraint("alice", 0, 5, ["map", "key"], eq("alice")),
				createConstraint("bob", 0, 10, ["map", "key"], eq("bob")),
			];

			const solved = solveMap(constraints, mapPath);

			expect(solvedMapHasConflicts(solved)).toBe(true);
			expect(solvedMapConflictKeys(solved)).toContain("key");
		});

		it("should report no conflicts when none exist", () => {
			const mapPath: Path = ["map"];
			const constraints = [
				createConstraint("alice", 0, 1, ["map", "key"], eq("value")),
			];

			const solved = solveMap(constraints, mapPath);

			expect(solvedMapHasConflicts(solved)).toBe(false);
			expect(solvedMapConflictKeys(solved)).toHaveLength(0);
		});
	});

	describe("equivalence with Loro MapState", () => {
		/**
		 * These tests verify that Prism's Map solver produces the same
		 * results as Loro's MapState LWW semantics.
		 */

		it("should match Loro LWW: higher lamport wins", () => {
			// Simulating: Alice sets key=1 at lamport 5, Bob sets key=2 at lamport 10
			const constraints = [
				createConstraint("alice", 0, 5, ["key"], eq(1)),
				createConstraint("bob", 0, 10, ["key"], eq(2)),
			];

			const result = solveMapConstraints(constraints, ["key"]);

			// Loro would pick Bob's value (higher lamport)
			expect(result.value).toBe(2);
		});

		it("should match Loro LWW: peer ID tiebreaker", () => {
			// Simulating concurrent writes at same lamport
			// Loro uses peer ID as tiebreaker (higher peer ID wins)
			const constraints = [
				createConstraint("peer_a", 0, 10, ["key"], eq("a")),
				createConstraint("peer_b", 0, 10, ["key"], eq("b")),
			];

			const result = solveMapConstraints(constraints, ["key"]);

			// "peer_b" > "peer_a" lexicographically
			expect(result.value).toBe("b");
		});

		it("should match Loro: delete wins over set at same lamport if peer wins", () => {
			const constraints = [
				createConstraint("alice", 0, 10, ["key"], eq("value")),
				createConstraint("bob", 0, 10, ["key"], deleted()),
			];

			const result = solveMapConstraints(constraints, ["key"]);

			// "bob" > "alice", so delete wins
			expect(result.value).toBeUndefined();
		});

		it("should match Loro: later set resurrects deleted key", () => {
			const constraints = [
				createConstraint("alice", 0, 5, ["key"], eq("first")),
				createConstraint("bob", 0, 10, ["key"], deleted()),
				createConstraint("alice", 1, 15, ["key"], eq("resurrected")),
			];

			const result = solveMapConstraints(constraints, ["key"]);

			// Lamport 15 > 10, so resurrection wins
			expect(result.value).toBe("resurrected");
		});
	});
});
