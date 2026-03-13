/**
 * @kyneta/core
 *
 * A compiled delta-driven UI framework powered by the CHANGEFEED protocol.
 *
 * Kinetic transforms natural TypeScript into code that directly consumes
 * structured deltas for O(k) DOM updates, where k is the number of operations.
 *
 * @example
 * ```ts
 * import { div, h1, p, mount } from "@kyneta/core"
 *
 * // Write natural TypeScript with builder pattern
 * const app = div(() => {
 *   h1("My App")
 *
 *   if (doc.items.length === 0) {
 *     p("No items yet")
 *   }
 *
 *   for (const item of doc.items) {
 *     li(item.text)
 *   }
 * })
 *
 * // Mount to DOM
 * const { dispose } = mount(app, document.getElementById("root"))
 *
 * // Cleanup when done
 * dispose()
 * ```
 */

// =============================================================================
// Error types
// =============================================================================

export {
  BindingError,
  CompilerError,
  HydrationMismatchError,
  InvalidMountTargetError,
  KineticError,
  KineticErrorCode,
  ScopeDisposedError,
  type SourceLocation,
} from "./errors.js"

// =============================================================================
// Runtime
// =============================================================================

export { getRootScope, mount, rootScope } from "./runtime/mount.js"
export { Scope } from "./runtime/scope.js"

// =============================================================================
// Hydration API
// =============================================================================

export {
  adoptNode,
  adoptTextNode,
  type ConditionalHydrationHandler,
  createHydratableMount,
  type HydrateOptions,
  type HydrateResult,
  hydrate,
  hydrateConditionalRegion,
  hydrateListRegion,
  type ListHydrationHandler,
} from "./runtime/hydrate.js"

// =============================================================================
// Runtime API (re-exported from /runtime subpath)
// =============================================================================

// Compiled code imports from @kyneta/core/runtime directly.
// These are re-exported here for convenience.
export {
  conditionalRegion,
  listRegion,
  read,
  subscribe,
  subscribeMultiple,
  subscribeWithValue,
  unsubscribe,
  valueRegion,
  type SubscriptionId,
} from "./runtime/index.js"

// =============================================================================
// Types
// =============================================================================

export type {
  Builder,
  Child,
  ComponentFactory,
  ConditionalRegionHandlers,
  Element,
  ListRegionHandlers,
  MountOptions,
  MountResult,
  Props,
  ScopeInterface,
} from "./types.js"

// =============================================================================
// Reactive Primitives
// =============================================================================

export type { LocalRef } from "./reactive/index.js"
export { state, isLocalRef } from "./reactive/index.js"
