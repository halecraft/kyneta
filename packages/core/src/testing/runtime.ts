/**
 * Testing utilities for Kinetic runtime.
 *
 * These functions are used to reset state between tests and inspect
 * internal subscription tracking. They are exported from the `/testing`
 * subpath to keep them separate from production code.
 *
 * @example
 * ```typescript
 * import {
 *   resetScopeIdCounter,
 *   resetSubscriptionIdCounter,
 *   activeSubscriptions,
 *   getActiveSubscriptionCount,
 * } from "@kyneta/core/testing"
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

// Re-export testing utilities from their source modules
export {
  resetScopeIdCounter,
  setRootScope,
} from "../runtime/scope.js"

export {
  activeSubscriptions,
  getActiveSubscriptionCount,
  getActiveSubscriptions,
  resetSubscriptionIdCounter,
} from "../runtime/subscribe.js"

// Re-export resetProject from compiler (if tests need it)
export { resetProject } from "../compiler/transform.js"
