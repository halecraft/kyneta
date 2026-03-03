/**
 * Subscription Manager Tests
 *
 * Tests for the centralized subscription registry:
 * - Constraint added events
 * - State change events (exact path and prefix)
 * - Conflict events (detected and resolved)
 * - Subscription management (subscribe, unsubscribe, clear)
 */

import { describe, it, expect, vi } from "vitest";
import {
	createSubscriptionManager,
	type ConstraintAddedEvent,
	type StateChangedEvent,
	type ConflictEvent,
} from "../../src/events/subscription-manager.js";
import {
	createConstraintStore,
	tell,
	tellMany,
} from "../../src/store/constraint-store.js";
import { createConstraint } from "../../src/core/constraint.js";
import { eq, deleted } from "../../src/core/assertions.js";
import { solveMapConstraints } from "../../src/solver/map-solver.js";
import type { SolvedValue } from "../../src/solver/solver.js";
import type { Path } from "../../src/core/types.js";
import { ask } from "../../src/store/constraint-store.js";

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

function createDeleteConstraint(
	peer: string,
	counter: number,
	lamport: number,
	path: Path,
) {
	return createConstraint(peer, counter, lamport, path, deleted());
}

// ============================================================================
// Tests
// ============================================================================

describe("SubscriptionManager", () => {
	describe("createSubscriptionManager", () => {
		it("should create a manager with no subscriptions", () => {
			const manager = createSubscriptionManager();
			const counts = manager.getSubscriptionCount();

			expect(counts.constraint).toBe(0);
			expect(counts.state).toBe(0);
			expect(counts.statePrefix).toBe(0);
			expect(counts.conflict).toBe(0);
		});
	});

	describe("onConstraintAdded", () => {
		it("should fire callback when constraints are added", () => {
			const manager = createSubscriptionManager();
			const callback = vi.fn();

			manager.onConstraintAdded(callback);

			let store = createConstraintStore();
			const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
			store = tell(store, constraint).store;

			manager.notifyConstraintsAdded(
				[constraint],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
			);

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "constraint_added",
					constraints: [constraint],
				}),
			);
		});

		it("should include affected paths in event", () => {
			const manager = createSubscriptionManager();
			const callback = vi.fn();

			manager.onConstraintAdded(callback);

			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key1"], "value1");
			const c2 = createTestConstraint("alice", 1, 2, ["key2"], "value2");
			store = tellMany(store, [c1, c2]).store;

			manager.notifyConstraintsAdded(
				[c1, c2],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
			);

			const event = callback.mock.calls[0][0] as ConstraintAddedEvent;
			expect(event.affectedPaths).toHaveLength(2);
		});

		it("should allow unsubscribing", () => {
			const manager = createSubscriptionManager();
			const callback = vi.fn();

			const unsubscribe = manager.onConstraintAdded(callback);

			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key"], "value1");
			store = tell(store, c1).store;

			manager.notifyConstraintsAdded(
				[c1],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
			);

			expect(callback).toHaveBeenCalledTimes(1);

			// Unsubscribe
			unsubscribe();

			const c2 = createTestConstraint("alice", 1, 2, ["key"], "value2");
			store = tell(store, c2).store;

			manager.notifyConstraintsAdded(
				[c2],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
			);

			// Should not have been called again
			expect(callback).toHaveBeenCalledTimes(1);
		});
	});

	describe("onStateChanged", () => {
		it("should fire callback when state at exact path changes", () => {
			const manager = createSubscriptionManager();
			const callback = vi.fn();

			manager.onStateChanged(["user", "name"], callback);

			let store = createConstraintStore();
			const constraint = createTestConstraint(
				"alice",
				0,
				1,
				["user", "name"],
				"Alice",
			);
			store = tell(store, constraint).store;

			// Create previous states map (empty = no previous state)
			const previousStates = new Map<string, SolvedValue<unknown>>();

			manager.notifyConstraintsAdded(
				[constraint],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
				previousStates,
			);

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "state_changed",
					path: ["user", "name"],
					after: "Alice",
				}),
			);
		});

		it("should not fire for unrelated paths", () => {
			const manager = createSubscriptionManager();
			const callback = vi.fn();

			manager.onStateChanged(["user", "name"], callback);

			let store = createConstraintStore();
			const constraint = createTestConstraint(
				"alice",
				0,
				1,
				["user", "age"],
				30,
			);
			store = tell(store, constraint).store;

			manager.notifyConstraintsAdded(
				[constraint],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
			);

			expect(callback).not.toHaveBeenCalled();
		});

		it("should include before state when provided", () => {
			const manager = createSubscriptionManager();
			const callback = vi.fn();

			manager.onStateChanged(["key"], callback);

			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["key"], "value1");
			store = tell(store, c1).store;

			// First change
			manager.notifyConstraintsAdded(
				[c1],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
				new Map(),
			);

			// Second change with previous state
			const c2 = createTestConstraint("alice", 1, 2, ["key"], "value2");
			const previousStates = new Map<string, SolvedValue<unknown>>();
			previousStates.set(JSON.stringify(["key"]), {
				value: "value1",
				determinedBy: c1,
				conflicts: [],
				resolution: "single constraint",
			});

			store = tell(store, c2).store;

			manager.notifyConstraintsAdded(
				[c2],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
				previousStates,
			);

			const event = callback.mock.calls[1][0] as StateChangedEvent;
			expect(event.before).toBe("value1");
			expect(event.after).toBe("value2");
		});
	});

	describe("onStateChangedPrefix", () => {
		it("should fire for paths matching prefix", () => {
			const manager = createSubscriptionManager();
			const callback = vi.fn();

			manager.onStateChangedPrefix(["user"], callback);

			let store = createConstraintStore();
			const constraint = createTestConstraint(
				"alice",
				0,
				1,
				["user", "name"],
				"Alice",
			);
			store = tell(store, constraint).store;

			manager.notifyConstraintsAdded(
				[constraint],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
			);

			expect(callback).toHaveBeenCalledTimes(1);
		});

		it("should fire for multiple paths under prefix", () => {
			const manager = createSubscriptionManager();
			const callback = vi.fn();

			manager.onStateChangedPrefix(["user"], callback);

			let store = createConstraintStore();
			const c1 = createTestConstraint("alice", 0, 1, ["user", "name"], "Alice");
			const c2 = createTestConstraint("alice", 1, 2, ["user", "age"], 30);
			store = tellMany(store, [c1, c2]).store;

			manager.notifyConstraintsAdded(
				[c1, c2],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
			);

			expect(callback).toHaveBeenCalledTimes(2);
		});

		it("should not fire for paths not matching prefix", () => {
			const manager = createSubscriptionManager();
			const callback = vi.fn();

			manager.onStateChangedPrefix(["user"], callback);

			let store = createConstraintStore();
			const constraint = createTestConstraint("alice", 0, 1, ["profile"], "data");
			store = tell(store, constraint).store;

			manager.notifyConstraintsAdded(
				[constraint],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
			);

			expect(callback).not.toHaveBeenCalled();
		});
	});

	describe("onConflict", () => {
		it("should fire when conflict is detected", () => {
			const manager = createSubscriptionManager();
			const callback = vi.fn();

			manager.onConflict(callback);

			let store = createConstraintStore();

			// First constraint
			const c1 = createTestConstraint("alice", 0, 1, ["key"], "alice-value");
			store = tell(store, c1).store;

			manager.notifyConstraintsAdded(
				[c1],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
			);

			// No conflict yet
			expect(callback).not.toHaveBeenCalled();

			// Second constraint from different peer (creates conflict)
			const c2 = createTestConstraint("bob", 0, 1, ["key"], "bob-value");
			store = tell(store, c2).store;

			manager.notifyConstraintsAdded(
				[c2],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
			);

			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "conflict_detected",
					path: ["key"],
				}),
			);
		});

		it("should track conflict state changes", () => {
			const manager = createSubscriptionManager();
			const callback = vi.fn();

			manager.onConflict(callback);

			let store = createConstraintStore();

			// Create conflict: two constraints at same lamport from different peers
			const c1 = createTestConstraint("alice", 0, 1, ["key"], "alice-value");
			const c2 = createTestConstraint("bob", 0, 1, ["key"], "bob-value");
			store = tellMany(store, [c1, c2]).store;

			manager.notifyConstraintsAdded(
				[c1, c2],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
			);

			// Should detect conflict (two constraints, one wins, one loses)
			expect(callback).toHaveBeenCalledTimes(1);
			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({
					type: "conflict_detected",
					path: ["key"],
				}),
			);

			// Add another constraint - still has conflicts (now 2 losers)
			const c3 = createTestConstraint("carol", 0, 100, ["key"], "final-value");
			store = tell(store, c3).store;

			manager.notifyConstraintsAdded(
				[c3],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
			);

			// Note: In LWW semantics, there are always "losers" (conflicts) when
			// multiple constraints exist at a path. "conflict_resolved" would only
			// fire if we went from having losers to having zero losers, which in
			// the current model would require constraint compaction/removal.
			// Since we don't remove constraints, the conflict persists (2 losers now).
			// The callback should NOT have been called again with "conflict_resolved"
			// because there are still losers.
			expect(callback).toHaveBeenCalledTimes(1);
		});

		describe("multiple subscribers", () => {
			it("should deliver events to all subscribers of the same path", () => {
				const manager = createSubscriptionManager();
				const cb1 = vi.fn();
				const cb2 = vi.fn();

				manager.onStateChanged(["key"], cb1);
				manager.onStateChanged(["key"], cb2);

				let store = createConstraintStore();
				const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
				store = tell(store, constraint).store;

				manager.notifyConstraintsAdded(
					[constraint],
					store,
					(path) => solveMapConstraints(ask(store, path), path),
				);

				expect(cb1).toHaveBeenCalledTimes(1);
				expect(cb2).toHaveBeenCalledTimes(1);
			});
		});

		describe("prefix subscription edge cases", () => {
			it("should fire prefix subscription for exact path match", () => {
				// pathStartsWith(["key"], ["key"]) is true, so a prefix subscription
				// on ["key"] should fire for constraints at ["key"] itself
				const manager = createSubscriptionManager();
				const callback = vi.fn();

				manager.onStateChangedPrefix(["key"], callback);

				let store = createConstraintStore();
				const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
				store = tell(store, constraint).store;

				manager.notifyConstraintsAdded(
					[constraint],
					store,
					(path) => solveMapConstraints(ask(store, path), path),
				);

				expect(callback).toHaveBeenCalledTimes(1);
			});

			it("should fire both exact and prefix subscriptions for same path", () => {
				const manager = createSubscriptionManager();
				const exactCb = vi.fn();
				const prefixCb = vi.fn();

				manager.onStateChanged(["user", "name"], exactCb);
				manager.onStateChangedPrefix(["user"], prefixCb);

				let store = createConstraintStore();
				const constraint = createTestConstraint(
					"alice", 0, 1, ["user", "name"], "Alice",
				);
				store = tell(store, constraint).store;

				manager.notifyConstraintsAdded(
					[constraint],
					store,
					(path) => solveMapConstraints(ask(store, path), path),
				);

				expect(exactCb).toHaveBeenCalledTimes(1);
				expect(prefixCb).toHaveBeenCalledTimes(1);
			});
		});

		describe("callback safety", () => {
			it("should tolerate unsubscribe during iteration", () => {
				const manager = createSubscriptionManager();
				let unsub2: (() => void) | undefined;
				const results: string[] = [];

				// First callback unsubscribes the second
				manager.onConstraintAdded(() => {
					results.push("first");
					unsub2?.();
				});
				unsub2 = manager.onConstraintAdded(() => {
					results.push("second");
				});

				let store = createConstraintStore();
				const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
				store = tell(store, constraint).store;

				// Should not throw even though we modify the set during iteration
				expect(() => {
					manager.notifyConstraintsAdded(
						[constraint],
						store,
						(path) => solveMapConstraints(ask(store, path), path),
					);
				}).not.toThrow();

				// First callback should always run
				expect(results).toContain("first");
			});

			it("should deduplicate affected paths from multiple constraints", () => {
				const manager = createSubscriptionManager();
				const callback = vi.fn();

				manager.onStateChanged(["key"], callback);

				let store = createConstraintStore();
				const c1 = createTestConstraint("alice", 0, 1, ["key"], "value1");
				const c2 = createTestConstraint("bob", 0, 2, ["key"], "value2");
				store = tellMany(store, [c1, c2]).store;

				manager.notifyConstraintsAdded(
					[c1, c2],
					store,
					(path) => solveMapConstraints(ask(store, path), path),
				);

				// Should fire once for the path, not once per constraint
				expect(callback).toHaveBeenCalledTimes(1);
			});
		});
	});

	describe("getSubscriptionCount", () => {
		it("should track subscription counts accurately", () => {
			const manager = createSubscriptionManager();

			const unsub1 = manager.onConstraintAdded(() => {});
			const unsub2 = manager.onConstraintAdded(() => {});

			let counts = manager.getSubscriptionCount();
			expect(counts.constraint).toBe(2);

			manager.onStateChanged(["path1"], () => {});
			manager.onStateChanged(["path2"], () => {});
			manager.onStateChanged(["path1"], () => {}); // Same path, different callback

			counts = manager.getSubscriptionCount();
			expect(counts.state).toBe(3);

			manager.onStateChangedPrefix(["prefix"], () => {});

			counts = manager.getSubscriptionCount();
			expect(counts.statePrefix).toBe(1);

			manager.onConflict(() => {});

			counts = manager.getSubscriptionCount();
			expect(counts.conflict).toBe(1);

			// Unsubscribe one
			unsub1();

			counts = manager.getSubscriptionCount();
			expect(counts.constraint).toBe(1);
		});
	});

	describe("clear", () => {
		it("should remove all subscriptions", () => {
			const manager = createSubscriptionManager();

			manager.onConstraintAdded(() => {});
			manager.onStateChanged(["path"], () => {});
			manager.onStateChangedPrefix(["prefix"], () => {});
			manager.onConflict(() => {});

			manager.clear();

			const counts = manager.getSubscriptionCount();
			expect(counts.constraint).toBe(0);
			expect(counts.state).toBe(0);
			expect(counts.statePrefix).toBe(0);
			expect(counts.conflict).toBe(0);
		});

		it("should prevent callbacks from firing after clear", () => {
			const manager = createSubscriptionManager();
			const callback = vi.fn();

			manager.onConstraintAdded(callback);
			manager.clear();

			let store = createConstraintStore();
			const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
			store = tell(store, constraint).store;

			manager.notifyConstraintsAdded(
				[constraint],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
			);

			expect(callback).not.toHaveBeenCalled();
		});
	});

	describe("notifyConstraintsAdded", () => {
		it("should do nothing for empty constraints array", () => {
			const manager = createSubscriptionManager();
			const callback = vi.fn();

			manager.onConstraintAdded(callback);

			const store = createConstraintStore();

			manager.notifyConstraintsAdded(
				[],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
			);

			expect(callback).not.toHaveBeenCalled();
		});

		it("should include generation in event", () => {
			const manager = createSubscriptionManager();
			const callback = vi.fn();

			manager.onConstraintAdded(callback);

			let store = createConstraintStore();
			const constraint = createTestConstraint("alice", 0, 1, ["key"], "value");
			store = tell(store, constraint).store;

			manager.notifyConstraintsAdded(
				[constraint],
				store,
				(path) => solveMapConstraints(ask(store, path), path),
			);

			const event = callback.mock.calls[0][0] as ConstraintAddedEvent;
			expect(event.generation).toBe(store.generation);
		});
	});
});
