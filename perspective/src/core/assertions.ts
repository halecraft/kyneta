/**
 * Assertion Types for Prism
 *
 * Assertions are the primitive constraint types that can be expressed
 * in the Convergent Constraint System.
 */

import type { OpId } from "./types.js";
import { opIdEquals } from "./types.js";

// ============================================================================
// Assertion Types
// ============================================================================

/**
 * Equality assertion - asserts that a path has a specific value.
 *
 * This is the most common assertion type, used for Map values,
 * List elements, and any other value assertions.
 */
export interface EqAssertion {
	readonly type: "eq";
	readonly value: unknown;
}

/**
 * Existence assertion - asserts that a path exists.
 *
 * Used primarily for container existence (e.g., a Map or List exists at a path).
 */
export interface ExistsAssertion {
	readonly type: "exists";
}

/**
 * Deleted assertion - asserts that a path is deleted (tombstone).
 *
 * Used to mark elements or keys as deleted in a way that survives
 * concurrent operations.
 */
export interface DeletedAssertion {
	readonly type: "deleted";
}

/**
 * Before assertion - asserts ordering (this element comes before target).
 *
 * Used for List/Text ordering constraints. The element at this path
 * should be positioned before the element identified by target.
 */
export interface BeforeAssertion {
	readonly type: "before";
	readonly target: OpId;
}

/**
 * After assertion - asserts ordering (this element comes after target).
 *
 * Used for List/Text ordering constraints. The element at this path
 * should be positioned after the element identified by target.
 * This corresponds to the "left origin" in Fugue terminology.
 */
export interface AfterAssertion {
	readonly type: "after";
	readonly target: OpId;
}

/**
 * Union of all assertion types.
 *
 * The assertion type determines how the solver interprets and resolves
 * constraints at a given path.
 */
export type Assertion =
	| EqAssertion
	| ExistsAssertion
	| DeletedAssertion
	| BeforeAssertion
	| AfterAssertion;

// ============================================================================
// Assertion Constructors
// ============================================================================

/**
 * Create an equality assertion.
 *
 * @param value - The value that the path should equal
 */
export function eq(value: unknown): EqAssertion {
	return { type: "eq", value };
}

/**
 * Create an existence assertion.
 */
export function exists(): ExistsAssertion {
	return { type: "exists" };
}

/**
 * Create a deleted assertion.
 */
export function deleted(): DeletedAssertion {
	return { type: "deleted" };
}

/**
 * Create a before assertion.
 *
 * @param target - The OpId of the element this should come before
 */
export function before(target: OpId): BeforeAssertion {
	return { type: "before", target };
}

/**
 * Create an after assertion.
 *
 * @param target - The OpId of the element this should come after (left origin)
 */
export function after(target: OpId): AfterAssertion {
	return { type: "after", target };
}

// ============================================================================
// Assertion Utilities
// ============================================================================

/**
 * Check if two assertions are equal.
 *
 * For value equality in `eq` assertions, uses deep equality via JSON serialization.
 * This is simple but sufficient for JSON-compatible values.
 */
export function assertionEquals(a: Assertion, b: Assertion): boolean {
	if (a.type !== b.type) return false;

	switch (a.type) {
		case "eq": {
			const bEq = b as EqAssertion;
			// Use JSON serialization for deep equality of values
			// This handles primitives, arrays, and plain objects
			return JSON.stringify(a.value) === JSON.stringify(bEq.value);
		}

		case "exists":
		case "deleted":
			// No additional data to compare
			return true;

		case "before": {
			const bBefore = b as BeforeAssertion;
			return opIdEquals(a.target, bBefore.target);
		}

		case "after": {
			const bAfter = b as AfterAssertion;
			return opIdEquals(a.target, bAfter.target);
		}
	}
}

/**
 * Get a human-readable string representation of an assertion.
 */
export function assertionToString(assertion: Assertion): string {
	switch (assertion.type) {
		case "eq":
			return `eq(${JSON.stringify(assertion.value)})`;
		case "exists":
			return "exists()";
		case "deleted":
			return "deleted()";
		case "before":
			return `before(${assertion.target.peer}@${assertion.target.counter})`;
		case "after":
			return `after(${assertion.target.peer}@${assertion.target.counter})`;
	}
}

/**
 * Type guard for EqAssertion.
 */
export function isEqAssertion(assertion: Assertion): assertion is EqAssertion {
	return assertion.type === "eq";
}

/**
 * Type guard for ExistsAssertion.
 */
export function isExistsAssertion(
	assertion: Assertion,
): assertion is ExistsAssertion {
	return assertion.type === "exists";
}

/**
 * Type guard for DeletedAssertion.
 */
export function isDeletedAssertion(
	assertion: Assertion,
): assertion is DeletedAssertion {
	return assertion.type === "deleted";
}

/**
 * Type guard for BeforeAssertion.
 */
export function isBeforeAssertion(
	assertion: Assertion,
): assertion is BeforeAssertion {
	return assertion.type === "before";
}

/**
 * Type guard for AfterAssertion.
 */
export function isAfterAssertion(
	assertion: Assertion,
): assertion is AfterAssertion {
	return assertion.type === "after";
}

/**
 * Check if an assertion is an ordering assertion (before or after).
 */
export function isOrderingAssertion(
	assertion: Assertion,
): assertion is BeforeAssertion | AfterAssertion {
	return assertion.type === "before" || assertion.type === "after";
}
