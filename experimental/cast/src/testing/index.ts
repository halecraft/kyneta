/**
 * Testing utilities for Kyneta.
 *
 * This subpath provides functions for testing Kyneta components:
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
 * } from "@kyneta/cast/testing"
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

export { resetScopeIdCounter, setRootScope } from "../runtime/scope.js"
export {
  activeSubscriptions,
  getActiveSubscriptionCount,
  getActiveSubscriptions,
  resetSubscriptionIdCounter,
} from "../runtime/subscribe.js"

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
