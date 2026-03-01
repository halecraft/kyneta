/**
 * Testing utilities for Kinetic.
 *
 * This subpath provides functions for testing Kinetic components:
 * - Reset functions for cleaning up state between tests
 * - Subscription tracking for verifying cleanup
 * - DOM operation counting for performance assertions
 *
 * @example
 * ```typescript
 * import {
 *   resetScopeIdCounter,
 *   resetSubscriptionIdCounter,
 *   activeSubscriptions,
 *   createCountingContainer,
 * } from "@loro-extended/kinetic/testing"
 *
 * beforeEach(() => {
 *   resetScopeIdCounter()
 *   resetSubscriptionIdCounter()
 *   activeSubscriptions.clear()
 * })
 * ```
 *
 * @packageDocumentation
 */

// =============================================================================
// Runtime Testing Utilities
// =============================================================================

export {
  activeSubscriptions,
  getActiveSubscriptionCount,
  resetSubscriptionIdCounter,
} from "../runtime/subscribe.js"

export { resetScopeIdCounter, setRootScope } from "../runtime/scope.js"

// =============================================================================
// Compiler Testing Utilities
// =============================================================================

export { resetProject } from "../compiler/transform.js"

// =============================================================================
// DOM Counting Utilities
// =============================================================================

export {
  assertMaxMutations,
  assertOperationCount,
  type CountingContainerResult,
  createCountingContainer,
  createCounts,
  type DOMOperationCounts,
  getTotalMutations,
} from "./counting-dom.js"
