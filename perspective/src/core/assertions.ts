/**
 * Assertion Types for Prism
 *
 * Assertions are the primitive constraint types that can be expressed
 * in the Convergent Constraint System.
 */

import type { OpId } from "./types.js";
import { opIdEquals, opIdToString } from "./types.js";

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
 * Sequence element assertion - asserts an element in a List or Text.
 *
 * This captures Fugue's semantics where each insert operation records:
 * - The element value
 * - originLeft: The element to the left when this was inserted (null = start of list)
 * - originRight: The element to the right when this was inserted (null = end of list)
 *
 * The solver uses originLeft/originRight to reconstruct the Fugue tree
 * and compute the correct interleaving for concurrent inserts.
 */
export interface SeqElementAssertion {
	readonly type: "seq_element";
	readonly value: unknown;
	readonly originLeft: OpId | null;
	readonly originRight: OpId | null;
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
	| SeqElementAssertion;

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
 * Create a sequence element assertion.
 *
 * This is the primary assertion type for List and Text elements.
 * Each element in a sequence is represented by one seq_element constraint.
 *
 * @param value - The element value (any JSON-compatible value for List, single char for Text)
 * @param originLeft - OpId of the element to the left when inserted, or null for start
 * @param originRight - OpId of the element to the right when inserted, or null for end
 */
export function seqElement(
	value: unknown,
	originLeft: OpId | null,
	originRight: OpId | null,
): SeqElementAssertion {
	return { type: "seq_element", value, originLeft, originRight };
}

// ============================================================================
// Assertion Utilities
// ============================================================================

/**
 * Check if two assertions are equal.
 *
 * For value equality in `eq` and `seq_element` assertions, uses deep equality
 * via JSON serialization. This is simple but sufficient for JSON-compatible values.
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

		case "seq_element": {
			const bSeq = b as SeqElementAssertion;
			// Compare value
			if (JSON.stringify(a.value) !== JSON.stringify(bSeq.value)) {
				return false;
			}
			// Compare originLeft
			if (a.originLeft === null && bSeq.originLeft !== null) return false;
			if (a.originLeft !== null && bSeq.originLeft === null) return false;
			if (
				a.originLeft !== null &&
				bSeq.originLeft !== null &&
				!opIdEquals(a.originLeft, bSeq.originLeft)
			) {
				return false;
			}
			// Compare originRight
			if (a.originRight === null && bSeq.originRight !== null) return false;
			if (a.originRight !== null && bSeq.originRight === null) return false;
			if (
				a.originRight !== null &&
				bSeq.originRight !== null &&
				!opIdEquals(a.originRight, bSeq.originRight)
			) {
				return false;
			}
			return true;
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
		case "seq_element": {
			const left = assertion.originLeft
				? opIdToString(assertion.originLeft)
				: "null";
			const right = assertion.originRight
				? opIdToString(assertion.originRight)
				: "null";
			return `seq_element(${JSON.stringify(assertion.value)}, left=${left}, right=${right})`;
		}
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
 * Type guard for SeqElementAssertion.
 */
export function isSeqElementAssertion(
	assertion: Assertion,
): assertion is SeqElementAssertion {
	return assertion.type === "seq_element";
}
