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
// Public API (to be implemented in Phase 2)
// =============================================================================

// export { mount, dispose } from "./mount.js"
// export { bind } from "./binding.js"
// export { Scope } from "./scope.js"

// =============================================================================
// Internal API (called by compiled code)
// =============================================================================

// export { __subscribe, __unsubscribe } from "./subscribe.js"
// export { __listRegion, __conditionalRegion } from "./regions.js"

// =============================================================================
// Placeholder exports
// =============================================================================

export const RUNTIME_VERSION = "0.0.1"

/**
 * Placeholder for mount function.
 * @internal
 */
export function mount(
  _element: () => Node,
  _container: Element,
): { node: Node; dispose: () => void } {
  throw new Error("Runtime not yet implemented. See Phase 2 of the plan.")
}

/**
 * Placeholder for bind function.
 * @internal
 */
export function bind(_ref: unknown): {
  __brand: "kinetic:binding"
  ref: unknown
} {
  throw new Error("Runtime not yet implemented. See Phase 2 of the plan.")
}
