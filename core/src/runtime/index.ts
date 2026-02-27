/**
 * Kinetic Runtime
 *
 * The runtime provides the functions that compiled Kinetic code calls
 * to manage DOM updates, subscriptions, and cleanup.
 *
 * These functions are prefixed with `__` to indicate they are internal
 * and called by compiled code, not user code directly.
 *
 * @packageDocumentation
 */

// =============================================================================
// Public API
// =============================================================================

export { getRootScope, mount, rootScope } from "./mount.js"
export { __resetScopeIdCounter, Scope } from "./scope.js"

// =============================================================================
// Internal API (called by compiled code)
// =============================================================================

export {
  __conditionalRegion,
  __listRegion,
  __staticConditionalRegion,
} from "./regions.js"
export {
  __activeSubscriptions,
  __getActiveSubscriptionCount,
  __resetSubscriptionIdCounter,
  __subscribe,
  __subscribeMultiple,
  __subscribeWithValue,
  __unsubscribe,
  type SubscriptionId,
} from "./subscribe.js"

// =============================================================================
// Runtime version
// =============================================================================

export const RUNTIME_VERSION = "0.0.1"
